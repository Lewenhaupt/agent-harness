/**
 * Workflow commands capability (bd-179): `/belayd`, `/belayd-complete`, the
 * daemon wake sentinel and the session lifecycle hooks.
 *
 * A restart is the interesting path here: `session_start` re-settles or re-arms
 * the gate from disk, re-discovers an open human wait, and hands the fleet run
 * loop back to the supervisor. The fleet calls arrive as injected seams so this
 * module stays outside the fleet graph; the composer owns their typed wiring.
 */
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { orchestratorActor } from "../../src/beads-actor.js";
import { mirrorAssignee } from "../../src/beads-assignee.js";
import { type BelaydCommandArgs, parseBelaydCommandArgs } from "../../src/belayd-command-args.js";
import { readHandoffFileArg } from "../../src/handoff.js";
import { completeRunByUser, listRuns, type RunManifest } from "../../src/run-manifest.js";
import {
  computeOrchestratorSessionName,
  isValidTaskId,
  parseSubagentSessionName,
  type SubagentSessionRef,
} from "../../src/session-naming.js";
import { lastAssistantText } from "../../src/session-transcript.js";
import { currentBranch } from "../../src/stack-rebase.js";
import {
  isValidWorkflowType,
  resolveWorkflowSelection,
  type WorkflowResolution,
} from "../../src/workflow-registry.js";
import {
  classifyWorkflowClaimability,
  readCallerHandoff,
  readWorkflowState,
} from "../../src/workflow-state.js";
import type { CoreSessionState } from "./context.js";
import { reportAssigneeResult, runBdForAssignee } from "./context.js";
import { daemonRequest } from "./daemon.js";
import {
  clearHumanAnswerWait,
  discoverHumanAnswerWait,
  type HumanGateDeps,
  isSubAgentSession,
} from "./human-gate.js";
import type { LaunchApi } from "./launch.js";
import { resetModelTelemetry } from "./model.js";
import {
  abortActiveRuns,
  releaseHeldFollowUps,
  resetRunTracking,
  type SessionStateStore,
} from "./session-state.js";
import type { WorkflowCoreApi } from "./workflow-core.js";

/**
 * The fleet supervisor calls the session lifecycle makes.
 *
 * `recoverFleetRuns` collapses `resumeFleetRunLoop` + `readoptFleetRuns`: the
 * two must stay separate *inside* the supervisor (a strict same-process resume
 * versus a loud repair), but this module only needs "the loop is back".
 */
export interface SessionFleetSeams {
  claimWorktreeOrchestrator: (options: {
    ctx: ExtensionContext;
    worktreePath: string;
    taskId: string;
    branch: string;
  }) => { ok: true } | { ok: false; error: string };
  recoverFleetRuns: (ctx: ExtensionContext) => void;
  stopFleetRunTimer: (ctx: ExtensionContext) => void;
  releaseSessionOrchestratorLease: (
    state: CoreSessionState,
    sessionId: string,
    cwd: string,
  ) => void;
}

/** Everything the workflow commands need from their host. */
export interface WorkflowCommandsDeps {
  pi: ExtensionAPI;
  getSessionState: SessionStateStore<CoreSessionState>;
  core: Pick<
    WorkflowCoreApi,
    | "activateGate"
    | "applyToolGate"
    | "confirmAndPersistResolution"
    | "describeResolutionSource"
    | "reconcileUserCompletions"
    | "resumeWorkflowFromDisk"
    | "sendWorkflowMessage"
  >;
  launch: Pick<LaunchApi, "launchWorktreeWorkflow" | "readTaskMetadata">;
  humanGateDeps: HumanGateDeps;
  fleet: SessionFleetSeams;
}

/**
 * Resolve a `--handoff` value into text. `@path` reads the file relative to the
 * calling session's cwd — pi-web processes run with cwd `/`, so resolving
 * against `process.cwd()` would silently miss the file. The read itself is
 * bounded and regular-file-only (see `readHandoffFileArg`).
 */
function resolveHandoffArg(
  handoff: string | undefined,
  cwd: string,
): { ok: true; text: string | undefined } | { ok: false; error: string } {
  if (handoff === undefined || !handoff.startsWith("@")) {
    return { ok: true, text: handoff };
  }
  const handoffPath = handoff.slice(1);
  const resolvedPath = isAbsolute(handoffPath) ? handoffPath : join(cwd, handoffPath);
  const read = readHandoffFileArg({ path: resolvedPath });
  return read.ok ? { ok: true, text: read.text } : read;
}

/** Usage text for `/belayd`; shared by every rejection path. */
function belaydUsageText(): string {
  return [
    "Usage: /belayd bd-42 [type] [--no-worktree] [--handoff <text|@path>] [--force]",
    "  taskId: beads issue or subtask ID (e.g. bd-42, bd-42.1)",
    "  type: optional; omit to use the bead's wf:<type> label. Valid: feature (default), bugfix, research, chore, documentation, refactor, hotfix",
    "  --no-worktree: activate gate in the current directory, no worktree or daemon",
    "  --handoff <text|@path>: context for the spawned orchestrator. Everything after the flag is its value (quote multi-word text); `@path` reads a file relative to the current directory",
    "  --force: hand off even while this session has phase runs in flight or is already inside the target worktree (the live runs are abandoned)",
  ].join("\n");
}

/**
 * Whether the parsed arguments can start a workflow. A bare `--handoff` is a
 * usage error rather than "no handoff": silently dropping it would launch a
 * child with no context while looking successful.
 */
function isUsableBelaydInvocation(args: BelaydCommandArgs): boolean {
  return (
    args.taskId !== "" &&
    isValidTaskId(args.taskId) &&
    (!args.handoffFlagPresent || args.handoff !== undefined)
  );
}

export function registerWorkflowCommands(deps: WorkflowCommandsDeps): void {
  const { pi, getSessionState, core, launch, humanGateDeps, fleet } = deps;

  /**
   * `/belayd --no-worktree`: activate the gate in this session. Extracted from
   * the command handler so the handler stays a readable sequence of guards.
   */
  async function startInSessionWorkflow(options: {
    ctx: ExtensionContext;
    taskId: string;
    workflowType: CoreSessionState["workflowType"];
    resolution: WorkflowResolution;
  }): Promise<void> {
    const { ctx, taskId } = options;
    // Claim the bead for the workflow's actor before the gate goes live, so the
    // assignment exists for the whole run (bd-150).
    const mirrored = await mirrorAssignee({
      taskId,
      actor: orchestratorActor(taskId),
      cwd: ctx.cwd,
      runBd: runBdForAssignee,
    });
    reportAssigneeResult(mirrored);
    core.activateGate({
      ctx,
      taskId,
      workflowType: options.workflowType,
      cwd: ctx.cwd,
      originalCwd: ctx.cwd,
      resolutionSource: options.resolution.source,
      matchedLabel: options.resolution.matchedLabel,
    });
    ctx.ui.notify(
      `Belayd ${options.workflowType} workflow started for ${taskId} (no worktree). ${core.describeResolutionSource(
        options.resolution,
      )}.`,
      "info",
    );
    core.sendWorkflowMessage({
      taskId,
      branch: null,
      workflowType: options.workflowType,
      resolution: options.resolution,
    });
  }

  /**
   * Resolve `--handoff` for a `/belayd` launch. In `--no-worktree` mode there is
   * no child to hand off to, so the flag is reported as ignored (and the file
   * is not read) rather than accepted and silently discarded.
   */
  function resolveBelaydHandoff(options: {
    ctx: ExtensionContext;
    args: BelaydCommandArgs;
  }): { ok: true; text: string | undefined } | { ok: false; error: string } {
    if (!options.args.noWorktree) {
      return resolveHandoffArg(options.args.handoff, options.ctx.cwd);
    }
    if (options.args.handoffFlagPresent) {
      options.ctx.ui.notify(
        "`--handoff` is ignored with `--no-worktree`: the gate runs in this session, so no child orchestrator is spawned.",
        "warning",
      );
    }
    return { ok: true, text: undefined };
  }

  /**
   * Resolve the workflow type (including the wf: label confirmation) and start
   * the workflow — in-session for `--no-worktree`, otherwise in a delegated
   * worktree session. Split out of the command handler so the handler stays a
   * short sequence of guards.
   */
  async function runBelaydLaunch(options: {
    ctx: ExtensionContext;
    args: BelaydCommandArgs;
  }): Promise<void> {
    const { ctx, args } = options;

    // Resolve the explicit handoff before any side effect, so an unreadable
    // file aborts the command untouched rather than half-launching a child.
    const handoffArg = resolveBelaydHandoff({ ctx, args });
    if (!handoffArg.ok) {
      ctx.ui.notify(handoffArg.error, "error");
      return;
    }

    // Explicit signals only: a CLI arg or a namespaced wf:<type> label. Title
    // keywords and plain labels never drive the choice (bd-106).
    const metadata = await launch.readTaskMetadata(args.taskId, ctx.cwd);
    let resolution = resolveWorkflowSelection(args.typeArg, metadata?.labels);

    if (args.typeArg !== undefined && !isValidWorkflowType(args.typeArg)) {
      ctx.ui.notify(
        `Unknown workflow type: "${args.typeArg}".\nValid types: feature, bugfix, research, chore, documentation, refactor, hotfix\nFalling back to "${resolution.type}".`,
        "warning",
      );
    }

    // A wf: label drives the type -> confirm before any side effects. A
    // cancelled (or unavailable) dialog aborts the run untouched.
    const confirmed = await core.confirmAndPersistResolution({
      ctx,
      taskId: args.taskId,
      resolution,
      existingLabels: metadata?.labels,
    });
    if (confirmed.kind === "cancelled") {
      ctx.ui.notify("Belayd workflow cancelled — no changes made.", "info");
      return;
    }
    resolution = confirmed.resolution;

    if (args.noWorktree) {
      await startInSessionWorkflow({
        ctx,
        taskId: args.taskId,
        workflowType: resolution.type,
        resolution,
      });
      return;
    }

    const outcome = await launch.launchWorktreeWorkflow({
      ctx,
      taskId: args.taskId,
      workflowType: resolution.type,
      branch: `feat/${args.taskId}`,
      handoff: handoffArg.text,
      resolutionSource: resolution.source,
      matchedLabel: resolution.matchedLabel,
      force: args.force,
    });
    if (!outcome.ok) ctx.ui.notify(outcome.error, "error");
  }

  // ── Slash command: /belayd bd-42 [type] ────────────────────────────
  pi.registerCommand("belayd", {
    description:
      "Start enforced Belayd workflow. Usage: /belayd bd-42 [type] [--no-worktree] [--handoff <text|@path>] [--force]. " +
      "Omit type to use the bead's wf:<type> label (confirmed before launch).",
    handler: async (args, ctx) => {
      const parsedArgs = parseBelaydCommandArgs(args);
      if (!parsedArgs.ok) {
        ctx.ui.notify(parsedArgs.error, "error");
        return;
      }
      const parsed = parsedArgs.args;
      if (!isUsableBelaydInvocation(parsed)) {
        ctx.ui.notify(belaydUsageText(), "error");
        return;
      }
      await runBelaydLaunch({ ctx, args: parsed });
    },
  });

  // ── Slash command: /belayd-complete [report] ───────────────────────
  //
  // Manual, out-of-band recovery for a phase sub-agent whose result was lost:
  // the child died/stalled, or the orchestrator restarted and its in-process
  // watcher vanished. Runs inside the sub-agent session, persists the report
  // into the run manifest, and wakes the orchestrator (or lets its
  // session_start / before_agent_start reconcile pick it up from disk).
  pi.registerCommand("belayd-complete", {
    description:
      "Mark this phase sub-agent run complete and feed its last assistant response back to the " +
      "orchestrator. Usage: /belayd-complete [report text]",
    handler: async (args, ctx) => {
      const sessionName = ctx.sessionManager.getSessionName();
      const parsed = sessionName === undefined ? undefined : parseSubagentSessionName(sessionName);
      if (sessionName === undefined || parsed === undefined) {
        ctx.ui.notify(
          "/belayd-complete is only available inside a phase sub-agent session " +
            "(belayd-<taskId>-sub-<phase>-<runId>).",
          "error",
        );
        return;
      }

      const provided = args.trim();
      const report =
        provided !== "" ? provided : (lastAssistantText(ctx.sessionManager.getBranch()) ?? "");
      if (report === "") {
        ctx.ui.notify(
          "No report text found. Pass the report explicitly: /belayd-complete <report text>",
          "error",
        );
        return;
      }

      const manifest = findRunForSession({ cwd: ctx.cwd, sessionName, parsed });
      if (manifest === undefined) {
        ctx.ui.notify(
          `No run manifest in ${ctx.cwd}/.belayd/runs matches session ${sessionName}.`,
          "error",
        );
        return;
      }

      const completed = completeRunByUser({ cwd: ctx.cwd, runId: manifest.runId, report });
      if (!completed.ok) {
        ctx.ui.notify(`Failed to mark run ${manifest.runId} complete: ${completed.error}`, "error");
        return;
      }

      // Best-effort: the manifest record plus the orchestrator's reconcile
      // scans still recover the result if the daemon is unavailable.
      await wakeOrchestrator({ taskId: parsed.taskId, runId: manifest.runId, cwd: ctx.cwd });

      pi.appendEntry("belayd-complete", {
        runId: manifest.runId,
        taskId: parsed.taskId,
        phase: parsed.phase,
      });
      ctx.ui.notify(
        `Run ${manifest.runId} (${parsed.phase}) marked complete; the orchestrator will resume it.`,
        "info",
      );
    },
  });

  /** Find the run manifest for a sub-agent session, by exact name or parsed components. */
  function findRunForSession(options: {
    cwd: string;
    sessionName: string;
    parsed: SubagentSessionRef;
  }): RunManifest | undefined {
    const runs = listRuns({ cwd: options.cwd });
    const exact = runs.find((run) => run.sessionName === options.sessionName);
    if (exact !== undefined) return exact;
    return runs.find((run) => {
      const named = parseSubagentSessionName(run.sessionName);
      if (named !== undefined) {
        return (
          named.taskId === options.parsed.taskId &&
          named.phase === options.parsed.phase &&
          named.shortRunId === options.parsed.shortRunId
        );
      }
      return (
        run.runId === options.parsed.shortRunId &&
        run.taskId === options.parsed.taskId &&
        run.phase === options.parsed.phase
      );
    });
  }

  /**
   * Narrow an untrusted daemon response's session list. `daemonRequest` returns
   * `Record<string, unknown>`, so a malformed entry must not reach a URL path
   * (`/sessions/<id>/prompt`) as `[object Object]`.
   */
  function parseDaemonSessions(
    response: Record<string, unknown>,
  ): Array<{ id: string; name?: string }> {
    const raw = response.sessions;
    if (!Array.isArray(raw)) return [];
    const sessions: Array<{ id: string; name?: string }> = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || record.id === "") continue;
      sessions.push({
        id: record.id,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
      });
    }
    return sessions;
  }

  /**
   * Ask the pi-web session daemon to prompt the orchestrator with the recovery
   * sentinel. Failures are swallowed: the persisted manifest and the
   * orchestrator-side reconcile are the authoritative recovery path.
   */
  async function wakeOrchestrator(options: {
    taskId: string;
    runId: string;
    cwd: string;
  }): Promise<void> {
    try {
      const response = await daemonRequest("GET", "/sessions");
      const targetName = computeOrchestratorSessionName(options.taskId);
      const session = parseDaemonSessions(response).find(
        (candidate) => candidate.name === targetName,
      );
      if (session === undefined) return;
      await daemonRequest("POST", `/sessions/${session.id}/prompt`, {
        cwd: options.cwd,
        text: `[belayd-complete:${options.runId}]`,
      });
    } catch (err) {
      console.warn(`[belayd-harness] failed to wake orchestrator for ${options.taskId}`, err);
    }
  }

  // ── Input sentinel: daemon-injected /belayd-complete wake ───────────
  //
  // The orchestrator is woken with `[belayd-complete:<runId>]`; reconcile it
  // and swallow the raw prompt so it never reaches the LLM as user input. The
  // match is end-anchored so a sentinel-looking prefix with trailing user text
  // is treated as ordinary input, not silently dropped. A well-formed sentinel
  // is always handled (even with no active gate) so the control token can
  // never leak to the model.
  pi.on("input", (event, ctx) => {
    const match = /^\[belayd-complete:([^\]]+)\]$/.exec(event.text.trim());
    if (match === null || match[1] === undefined) {
      // Ordinary user input closes any PI WEB question set that was open, so a
      // completion held behind it can go out now (bd-177). The daemon sentinel
      // below is swallowed and appends nothing, so it must NOT release: the
      // question form would still be open and the delivery would kill it.
      releaseHeldFollowUps(getSessionState(ctx));
      return { action: "continue" };
    }
    const runId = match[1];
    const state = getSessionState(ctx);
    if (state.gateActive && state.currentTaskId !== "") {
      core.reconcileUserCompletions({ state, ctx, cwd: ctx.cwd, runId });
    }
    return { action: "handled" };
  });

  pi.on("session_start", (_event, ctx) => {
    // A session can restart mid-workflow (compaction/resume). Flush pending
    // rows before dropping the store, otherwise telemetry recorded since the
    // last settle is lost. Per-run stores keep an open run's own delta exact.
    resetModelTelemetry(ctx.cwd);
    const state = getSessionState(ctx);
    state.gateActive = false;
    state.planningActive = false;
    state.planningTarget = undefined;
    state.consultPhases = [];
    state.completedPhaseNames = [];
    state.currentTaskId = "";
    state.proofBase = undefined;
    state.userGuideContent = undefined;
    state.proofOutput = undefined;
    state.proofVerifierVerdict = undefined;
    state.handoff = undefined;
    state.awaitingReviewResponse = false;
    state.handedOffTo = undefined;
    state.handoffPendingNotice = undefined;
    state.runEpoch = 0;
    resetRunTracking(state);
    clearHumanAnswerWait(state);
    core.applyToolGate(state);

    // Sub-agents have "-sub-" in their session name (set by computeSubagentSessionName).
    // Only the orchestrator session should activate the gate; sub-agents get their
    // tool restrictions from their agent definition's tools allowlist, not the gate.
    const sessionName = ctx.sessionManager.getSessionName();
    if (!ctx.sessionManager.getSessionFile() || isSubAgentSession(sessionName)) return;

    // P5: settle worktree ownership *before* the gate can arm. Two sessions in one
    // worktree share `.belayd/workflow.json` and `.belayd/runs/`, so the session
    // that loses this race must not look like an orchestrator at all.
    //
    // A session that handed this worktree off is *not* its orchestrator: it settles
    // the handoff marker instead (a same-directory handoff leaves the child's
    // workflow state in this directory, which would otherwise look claimable).
    const handedOffHere = readCallerHandoff({
      cwd: ctx.cwd,
      sessionKey: ctx.sessionManager.getSessionId(),
    });
    const persistedForClaim =
      handedOffHere === undefined ? readWorkflowState({ cwd: ctx.cwd }) : undefined;
    // bd-165: only a workflow this session can still drive may produce a lease.
    // A completed or handed-off state names a dead task, and a lease claimed
    // from it is renewed for the whole life of this session, locking every
    // later session out of the worktree. `resumeWorkflowFromDisk` archives it
    // instead.
    if (
      persistedForClaim !== undefined &&
      classifyWorkflowClaimability(persistedForClaim).kind === "claimable"
    ) {
      const branch =
        persistedForClaim.branch === "" ? (currentBranch(ctx.cwd) ?? "") : persistedForClaim.branch;
      const owned = fleet.claimWorktreeOrchestrator({
        ctx,
        worktreePath: ctx.cwd,
        taskId: persistedForClaim.taskId,
        branch,
      });
      if (!owned.ok) {
        state.orchestratorLeaseRefusal = owned.error;
        ctx.ui.notify(owned.error, "error");
        console.warn(`[belayd-harness] ${owned.error}`);
        return;
      }
    }

    core.resumeWorkflowFromDisk(state, ctx.cwd, ctx.sessionManager.getSessionId());
    // A user completion persisted before an orchestrator restart is recovered
    // from disk; the in-memory delivery marker was lost with the process.
    core.reconcileUserCompletions({ state, ctx, cwd: ctx.cwd });
    // The open human gate (bd-152) is the durable "waiting on a human" state: a
    // restart mid-wait re-discovers it here and re-arms the poll.
    discoverHumanAnswerWait({ ctx, state, deps: humanGateDeps });
    // Two ways a restarted session re-establishes its run loop, and they must stay
    // separate: `resumeFleetRunLoop` is the strict same-process case (the arm token
    // is still in memory), `readoptFleetRuns` repairs a loop whose process died and
    // is loud either way (bd-169). The seam preserves that order internally.
    fleet.recoverFleetRuns(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Flush telemetry recorded after the last run settle (e.g. the proof
    // verifier) and log the workflow summary once before the store is dropped.
    resetModelTelemetry(ctx.cwd, { log: true });
    const id = ctx.sessionManager.getSessionId();
    const state = getSessionState.peek(id);
    if (state) {
      // In-flight background runs must not outlive their session.
      abortActiveRuns(state);
      // Neither may the fleet loop or the worktree lease: the whole point of the
      // lease is that it stops being renewed exactly when this session stops.
      fleet.stopFleetRunTimer(ctx);
      // The answer poll's timer holds this state in its closure and would keep
      // spawning bd reads — and could `sendUserMessage` into a dead session — so
      // shutdown drops the wait without delivering anything.
      clearHumanAnswerWait(state);
      // A held follow-up belongs to this session only; its timer must not keep
      // the process alive or fire into a dead transcript (bd-177).
      releaseHeldFollowUps(state, "the session shut down");
      fleet.releaseSessionOrchestratorLease(state, id, ctx.cwd);
    }
    getSessionState.delete(id);
  });
}
