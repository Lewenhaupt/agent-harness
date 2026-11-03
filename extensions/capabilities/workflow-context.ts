/**
 * Workflow context capability (bd-179): the per-turn prompt injection for the
 * gate and for planning mode, plus the three `before_agent_start` hooks that
 * deliver fleet notes, human answers and managed instruction groups.
 *
 * The gate text is rebuilt every turn on purpose: the orchestrator's next action
 * changes as the ledger advances, and a stale one-line directive is what makes a
 * model re-run a phase. The fleet note drain and the human-answer delivery stay
 * in their own handlers so an early return in the gate handler cannot skip them.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLANNING_MODE_SYSTEM_PROMPT } from "../../src/agent-registry.js";
import { formatHandoffBlock } from "../../src/handoff.js";
import {
  createInstructionGroupCollector,
  INSTRUCTION_GROUPS_CHANNEL,
  manageInstructionGroups,
  manageInstructionGroupsWarning,
  NO_GROUP_REGISTERED_WARNING,
} from "../../src/instruction-groups.js";
import { parseSubagentSessionName } from "../../src/session-naming.js";
import { getNextPhase } from "../../src/workflow-phases.js";
import type { CoreSessionState } from "./context.js";
import { errorText, REVIEW_PHASE } from "./context.js";
import {
  type HumanGateDeps,
  humanAnswerGuidanceLines,
  humanAnswerMessage,
  nextStepBlockLines,
} from "./human-gate.js";
import {
  reconcileDeferredProviders,
  setModelStateAttribution,
  warnProviderRegistrationFailure,
} from "./model.js";
import { nextPhaseToolAfter, reviewFindingsGuidanceLines } from "./review.js";
import { releaseHeldFollowUps, type SessionContext } from "./session-state.js";
import type { WorkflowCoreApi } from "./workflow-core.js";

/** A turn-start message envelope (pi's `sendMessage` shape). */
export interface TurnMessage {
  message: { customType: string; content: string; display: boolean };
}

/** Everything the context capability needs from its host. */
export interface WorkflowContextDeps {
  pi: ExtensionAPI;
  getSessionState: (ctx: SessionContext) => CoreSessionState;
  core: Pick<
    WorkflowCoreApi,
    "describePhase" | "formatProcessState" | "gateNextStepLine" | "reconcileUserCompletions"
  >;
  humanGateDeps: HumanGateDeps;
  /**
   * Fleet member notes, drained at turn start. Injected because the fleet
   * supervisor is the one capability this module may not import.
   */
  fleetEventsMessage: (ctx: ExtensionContext) => TurnMessage | undefined;
}

export function registerWorkflowContext(deps: WorkflowContextDeps): void {
  const { pi, getSessionState, core, humanGateDeps, fleetEventsMessage } = deps;

  /** Build the planning-mode context message, or undefined when inactive. */
  function planningContextMessage(state: CoreSessionState): TurnMessage | undefined {
    if (!state.planningActive) return undefined;
    const target = state.planningTarget;
    const targetLine =
      target?.kind === "existing"
        ? `Refine existing bead \`${target.taskId}\`${target.focus !== undefined ? ` (focus: ${target.focus})` : ""}. Start with \`bd show ${target.taskId}\`, then write the refined plan back with \`bd update\`.`
        : target?.kind === "new"
          ? `Plan new work: ${target.description}`
          : "Plan new work.";

    const activeRunLines: string[] = [];
    if (state.activeRuns.size > 0) {
      activeRunLines.push("", "⏳ **Planning runs in progress — WAIT, do not act:**");
      for (const [runId, { handle }] of state.activeRuns) {
        activeRunLines.push(`- \`${handle.phaseName}\` (run \`${runId}\`) — ${handle.status}`);
      }
      activeRunLines.push(
        "",
        "Do NOT launch another planning sub-agent. The result will arrive as a follow-up message.",
      );
    }

    return {
      message: {
        customType: "belayd-planning-context",
        content: [
          "[BELAYD PLANNING MODE ACTIVE]",
          PLANNING_MODE_SYSTEM_PROMPT,
          "",
          `Target: ${targetLine}`,
          ...activeRunLines,
        ].join("\n"),
        display: false,
      },
    };
  }

  /**
   * Proof modality requirements, returned only for proof workflows.
   *
   * The orchestrator writes the `belayd_proof` task prompt, so the requirement
   * must be restated every turn: UI changes need BOTH a Playwright trace and
   * playwright-cli screenshots, and a missing test-runner browser is a
   * workaround problem, never a reason to skip visual proof.
   */
  function proofModalityGuidanceLines(phaseOrder: readonly string[]): string[] {
    if (!phaseOrder.includes("proof")) return [];
    return [
      "",
      "**Proof modality** (before calling `belayd_proof`):",
      "- UI change → the `belayd_proof` task MUST require BOTH a Playwright trace (E2E spec) and playwright-cli screenshots of the changed pages.",
      "- Tell the proof agent to explore the built UI in a browser (playwright-cli open → click through → screenshot), not just run the E2E spec.",
      "- A missing/incompatible Playwright browser is NOT a skip reason, and `playwright install` is forbidden on this host (CDN binaries need FHS libs that NixOS lacks): require the project devShell env (`direnv exec <repo> <cmd>` / `nix develop -c <cmd>`) or a Nix browser tree whose revision matches, then produce the artifact.",
      "- Browser-proof trouble is absent from the proof agent's `**Proof skipped:**` reason list — reject a UI proof that skips visuals for that reason.",
    ];
  }

  /** Proof-verifier guidance lines, returned only for proof workflows. */
  function proofVerifierGuidanceLines(phaseOrder: readonly string[]): string[] {
    if (!phaseOrder.includes("proof")) return [];
    return [
      "",
      "**Proof verifier** (after `belayd_proof`):",
      "- Call `belayd_proof_verifier` when proof relevance or quality is uncertain.",
      "- It is ADVISORY and non-blocking: a `reasonable: false` verdict is worth investigating, but never blocks the commit phase.",
      "- Record the verdict in the task's Final Summary; the commit phase also records it as a `[belayd:proof-verifier]` bead comment.",
    ];
  }

  /**
   * Stale-worktree guidance, restated every turn for every workflow type.
   *
   * The orchestrator farms work out to sub-agents whose branches may sit behind
   * the base branch; without a per-turn reminder an already-merged task looks
   * "missing" and gets re-implemented, so this is unconditional rather than
   * tied to a phase.
   */
  function worktreeSyncGuidanceLines(): string[] {
    return [
      "",
      "**Stale worktree?**",
      "- The worktree branch may be behind the base branch (`main`); a task closed elsewhere may simply not be in this branch yet — check `main` before duplicating work.",
      "- If the work already landed on `main`, rebase with `git rebase main` instead of re-implementing apparently-missing work.",
      "- Mid-rebase conflicts are expected: when the branch re-implements merged work, prefer the already-landed `main` implementation over the duplicate.",
      "",
      "**Stacked follow-up worktree?**",
      "- A branch created with `belayd_start_followup` records its base in `branch.<name>.belaydBase` and fork point in `branch.<name>.belaydForkPoint`.",
      "- When the recorded base lands, replay only this branch with `belayd_stack_rebase` (or `git rebase --onto main <belaydForkPoint> <branch>`), never a plain `git rebase <parent>` — the parent's commits are already in `main`.",
    ];
  }

  /** Build the implementation-gate context message, or undefined when inactive. */
  function gateContextMessage(state: CoreSessionState): TurnMessage | undefined {
    if (!state.gateActive) return undefined;

    const remaining = getNextPhase(state.completedPhaseNames, state.phaseOrder) ?? "commit";
    const phaseOrder = state.phaseOrder;
    const workflowType = state.workflowType;

    const phaseLines = phaseOrder.map(
      (p) => `- \`belayd_${p}\` — ${core.describePhase(p, workflowType)}`,
    );

    // Research workflows record findings as a bead comment — there is no research
    // .md file to write and no committed-file deliverable. State this every
    // turn, not just at workflow start, because the orchestrator otherwise
    // re-delegates `belayd_plan` to force a research .md file that the
    // researcher contract explicitly forbids.
    const researchGuidance =
      workflowType === "research"
        ? [
            "",
            "RESEARCH workflow: the `plan` phase is the research agent. Its deliverable is a bead comment tagged `[belayd:research]` (via `bd comment <id> --stdin`) — NOT a committed file or research .md document. Do not re-delegate to write a research file.",
          ]
        : [];

    // The reviewer's output has three severity sections. The orchestrator must
    // treat all of them as input — not just "Critical" — and disclose anything
    // it declines so the human reviewer sees what was consciously skipped. The
    // "then call X" phase is review's successor, not the next incomplete phase:
    // before review runs, the latter would name review itself.
    const reviewFindingsGuidance = phaseOrder.includes(REVIEW_PHASE)
      ? reviewFindingsGuidanceLines(nextPhaseToolAfter(REVIEW_PHASE, phaseOrder))
      : [];

    // When phase runs are active, tell the orchestrator to wait instead of
    // repeating "call belayd_X" — the phase is already running, and the
    // gate will block any re-call, creating a contradictory loop.
    const activeRunLines: string[] = [];
    if (state.activeRuns.size > 0) {
      activeRunLines.push("", "⏳ **Phase runs in progress — WAIT, do not act:**");
      for (const [runId, { handle }] of state.activeRuns) {
        activeRunLines.push(`- \`${handle.phaseName}\` (run \`${runId}\`) — ${handle.status}`);
      }
      activeRunLines.push(
        "",
        "Do NOT call any phase tools. Do NOT call belayd_status on your own initiative.",
        "The result will arrive as a follow-up message when each run completes.",
        "If the user explicitly asks you to check progress, you may call belayd_status.",
      );
    }

    // Build the next-step line: "wait" when runs are active; after review the
    // gate used to say "call belayd_test" even though the findings were still
    // unaddressed. Point the orchestrator back at the resumable fix loop until
    // no Critical/Warnings remain.
    const nextStepLine = core.gateNextStepLine({
      activeRunCount: state.activeRuns.size,
      awaitingReviewResponse: state.awaitingReviewResponse,
      remainingPhase: remaining,
    });

    // The handoff section is additive: an absent packet (older workflow, or a
    // launch that never had a parent session) leaves the gate text unchanged.
    const handoffLines = state.handoff !== undefined ? ["", formatHandoffBlock(state.handoff)] : [];

    return {
      message: {
        customType: "belayd-gate-context",
        content: [
          "[BELAYD WORKFLOW ACTIVE]",
          `Task: ${state.currentTaskId} (${workflowType})`,
          `Progress: ${core.formatProcessState(state.completedPhaseNames, state.currentTaskId, phaseOrder)}`,
          "",
          `Phases: ${phaseOrder.join(" → ")}`,
          "",
          "Editing and writing tools are DISABLED. You MUST delegate ALL code changes to the phase tools:",
          ...phaseLines,
          ...researchGuidance,
          ...reviewFindingsGuidance,
          ...proofVerifierGuidanceLines(phaseOrder),
          ...proofModalityGuidanceLines(phaseOrder),
          ...worktreeSyncGuidanceLines(),
          ...handoffLines,
          ...activeRunLines,
          ...humanAnswerGuidanceLines(state),
          "",
          "Task tracking: the `bd` tool is available for beads commands (create, update, label, note, show, search, list, ready, etc.).",
          ...nextStepBlockLines(state, nextStepLine),
        ].join("\n"),
        display: false,
      },
    };
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    const state = getSessionState(ctx);
    // bd-187 W3: repoint spend attribution from this turn's context. The wrapper
    // snapshots the shared holder at the start of each dispatch, so this is per
    // turn, not a value baked in when providers were wrapped. A phase sub-agent
    // session wears its task+phase in its name, which is the only place the
    // child process still sees them; a planning/orchestrator session uses the
    // gate state.
    const subagent = parseSubagentSessionName(ctx.sessionManager.getSessionName?.() ?? "");
    setModelStateAttribution({
      phase: subagent?.phase ?? (state.planningActive ? "plan" : "orchestrator"),
      taskId: subagent?.taskId ?? state.currentTaskId,
    });
    // bd-187 W2: a dynamic catalog can materialise a deferred provider between
    // two session starts; this turn boundary is the observation point that wraps
    // it. A no-op unless a previously deferred id now has an object.
    try {
      reconcileDeferredProviders(pi, ctx.modelRegistry);
    } catch (error) {
      warnProviderRegistrationFailure(error);
    }
    // File-only fallback: if the daemon wake path never fired (e.g. restart),
    // a pending user completion is still recovered on the next turn.
    if (state.gateActive) core.reconcileUserCompletions({ state, ctx, cwd: ctx.cwd });
    return planningContextMessage(state) ?? gateContextMessage(state);
  });

  // Fleet member delivery. Separate handler for the same reason as the
  // instruction-group handler below: the gate handler's early returns must not
  // be able to skip it. A supervisor → member note is a file in `events/`, so it
  // is drained here, at the start of the turn, bounded, acked once, and silent
  // when nothing is addressed to this member.
  //
  // Human answers ride along (bd-152): when the self-poll timer cannot wake the
  // session (no daemon route), the next turn still injects the answer. Both
  // paths funnel through `claimHumanAnswer`, which clears the wait before it
  // delivers, so the answer is never injected twice.
  pi.on("before_agent_start", async (_event, ctx) => {
    // Any turn start means something was appended after a question set, so a
    // completion held for it is released here (bd-177): an answer, a skip, and
    // the human's own message all wake the session this way.
    releaseHeldFollowUps(getSessionState(ctx));
    try {
      const fleetMessage = fleetEventsMessage(ctx);
      if (fleetMessage !== undefined) return fleetMessage;
    } catch (error) {
      console.warn(`[belayd-harness] fleet events delivery failed: ${errorText(error)}`);
    }
    try {
      return await humanAnswerMessage(ctx, humanGateDeps);
    } catch (error) {
      console.warn(`[belayd-harness] human answer delivery failed: ${errorText(error)}`);
      return undefined;
    }
  });

  // Managed instruction groups. Agent extensions (e.g. pi-agent-browser) ship
  // a large prompt section and register an eager fallback that writes it every
  // turn regardless of whether their tools are callable. Nothing in pi 1.0.2
  // emits `pi:instruction-groups`, so the harness emits it itself and owns the
  // gate. A dedicated handler (separate from the process-gate handler above)
  // keeps the gate's early returns from skipping it. The body lives in
  // `src/instruction-groups.ts` so the wiring is unit-testable without pi.
  const instructionCollector = createInstructionGroupCollector();
  // A pi with no instruction-group extension at all legitimately leaves the
  // collector empty forever, so the same "no group registered" line would
  // repeat every turn. Warn once per session; every other message can signal a
  // state change and keeps logging every turn.
  let noGroupWarningEmitted = false;
  const warnInstructionGroups = (message: string): void => {
    if (message === NO_GROUP_REGISTERED_WARNING) {
      if (noGroupWarningEmitted) return;
      noGroupWarningEmitted = true;
    }
    console.warn(`[belayd-harness] ${message}`);
  };
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const result = manageInstructionGroups({
        collector: instructionCollector,
        emitInstructionGroups: (collector) => pi.events.emit(INSTRUCTION_GROUPS_CHANNEL, collector),
        systemPromptOptions: event.systemPromptOptions,
        ctx,
        warn: warnInstructionGroups,
      });
      const warning = manageInstructionGroupsWarning(result);
      if (warning !== undefined) console.warn(`[belayd-harness] ${warning}`);
    } catch (error) {
      console.warn(`[belayd-harness] instruction-group prompt gate failed: ${String(error)}`);
    }
  });
}
