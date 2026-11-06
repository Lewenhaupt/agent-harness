/**
 * Task-control capability (bd-179): starting, following up and stopping a
 * workflow from the orchestrator session.
 *
 * The stop path is the teardown contract: clear the bead's assignment and human
 * gate, abort live runs, restore the caller's directory, drop the persisted
 * state and handoff packet, then restore the full tool set. The follow-up path
 * stacks on the current branch and hands off, so its guards run before any bead
 * label is written.
 */
import { existsSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { orchestratorActor } from "../../src/beads-actor.js";
import { clearAssignee, mirrorAssignee } from "../../src/beads-assignee.js";
import { isSafeChdirTarget } from "../../src/chdir-guard.js";
import { clearHandoff } from "../../src/handoff.js";
import { isValidTaskId } from "../../src/session-naming.js";
import { currentBranch, DEFAULT_BASE_BRANCH, resolveStackChain } from "../../src/stack-rebase.js";
import { resolveWorkflowSelection, type WorkflowResolution } from "../../src/workflow-registry.js";
import {
  clearCallerHandoff,
  clearWorkflowState,
  readWorkflowState,
} from "../../src/workflow-state.js";
import type { CoreSessionState } from "./context.js";
import { reportAssigneeResult, runBdForAssignee, textToolResult } from "./context.js";
import { clearHumanAnswerWait, type HumanGateDeps, reapHumanGateForTask } from "./human-gate.js";
import type { LaunchApi } from "./launch.js";
import { resetModelTelemetry } from "./model.js";
import { abortAndResetRunTracking, type SessionStateStore } from "./session-state.js";
import type { WorkflowCoreApi } from "./workflow-core.js";

/** Everything the start tools need from their host. */
export interface TaskStartDeps {
  pi: ExtensionAPI;
  getSessionState: SessionStateStore<CoreSessionState>;
  core: Pick<
    WorkflowCoreApi,
    | "activateGate"
    | "formatProcessState"
    | "resolveToolWorkflowResolution"
    | "writeWorkflowTypeLabel"
  >;
  launch: Pick<LaunchApi, "launchBlocker" | "launchWorktreeWorkflow" | "readTaskMetadata">;
}

/** Everything the stop tools need from their host. */
export interface TaskStopDeps {
  pi: ExtensionAPI;
  getSessionState: SessionStateStore<CoreSessionState>;
  core: Pick<WorkflowCoreApi, "applyToolGate" | "applyWorkflowConfig" | "reportHandoffProblem">;
  humanGateDeps: HumanGateDeps;
}

export function registerTaskStartTools(deps: TaskStartDeps): void {
  const { pi, getSessionState, core, launch } = deps;

  // ── Register start-task tool ────────────────────────────────────────
  pi.registerTool({
    name: "belayd_start_task",
    label: "Start Belayd Task",
    description:
      "Activate enforced Belayd process. Accepts optional workflow type (feature, bugfix, research, chore, documentation, refactor, hotfix).",
    parameters: Type.Object({
      taskId: Type.String({ description: "Beads issue ID, e.g. bd-42" }),
      workflowType: Type.Optional(
        Type.String({
          description:
            "Workflow sub-type: feature (default), bugfix, research, chore, documentation, refactor, hotfix",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isValidTaskId(params.taskId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid task id: ${params.taskId}. Expected a beads id like "bd-42" or "bd-42.1" (letters/digits after "bd-", dot-separated segments).`,
            },
          ],
          details: {
            messages: [],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0,
              toolCalls: 0,
            },
            exitCode: 1,
          },
        };
      }

      const cwd = ctx.cwd ?? process.cwd();
      const metadata = await launch.readTaskMetadata(params.taskId, cwd);
      const toolResolution = await core.resolveToolWorkflowResolution({
        ctx,
        taskId: params.taskId,
        resolution: resolveWorkflowSelection(params.workflowType, metadata?.labels),
        existingLabels: metadata?.labels,
      });
      if (toolResolution.kind === "denied") return textToolResult(toolResolution.text, 1);

      const resolution = toolResolution.resolution;
      const workflowType = resolution.type;
      // A choose-another-type confirmation already persisted the label; only an
      // explicit arg needs the write-back here.
      if (resolution.source === "arg" && !toolResolution.persisted) {
        await core.writeWorkflowTypeLabel({
          taskId: params.taskId,
          type: workflowType,
          cwd,
          existingLabels: metadata?.labels,
        });
      }

      const mirrored = await mirrorAssignee({
        taskId: params.taskId,
        actor: orchestratorActor(params.taskId),
        cwd,
        runBd: runBdForAssignee,
      });
      reportAssigneeResult(mirrored);

      const state = core.activateGate({
        ctx,
        taskId: params.taskId,
        workflowType,
        cwd,
        resolutionSource: resolution.source,
        matchedLabel: resolution.matchedLabel,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `${workflowType} process started for ${params.taskId}.\n\n${core.formatProcessState([], params.taskId, state.phaseOrder)}`,
          },
        ],
        details: {
          messages: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
            toolCalls: 0,
          },
          exitCode: 0,
        },
      };
    },
  });

  // ── Register start-followup tool ────────────────────────────────────
  //
  // A follow-up workflow is cut from the orchestrator's *current* branch
  // instead of `main`, so the new task builds on the parent's unmerged work.
  // The worktree create path records `branch.<b>.belaydBase` +
  // `.belaydForkPoint` so the stack can later be replayed onto `main` with
  // `git rebase --onto`, even after the parent branch is deleted.
  /** Short human summary of the resolved stack the follow-up branch joins. */
  function describeFollowupStack(cwd: string, leaf: string, base: string): string {
    const resolved = resolveStackChain(cwd, leaf);
    if (resolved.ok && resolved.chain.length > 0) {
      return `Stack: ${resolved.chain.map((node) => node.branch).join(" → ")} → ${DEFAULT_BASE_BRANCH}`;
    }
    return `Stacked on ${base}.`;
  }

  /**
   * Resolve the branch a follow-up is stacked on, rejecting the detached-HEAD
   * and self-stacking cases. Extracted so the tool handler stays under the
   * complexity budget.
   */
  function resolveFollowupBase(options: {
    branch: string;
    requested?: string;
    cwd: string;
  }): { ok: true; base: string } | { ok: false; error: string } {
    const base = options.requested ?? currentBranch(options.cwd);
    if (base === undefined) {
      return {
        ok: false,
        error:
          "Cannot determine the base branch: the repository is in a detached HEAD state. Pass `base` explicitly.",
      };
    }
    if (base === options.branch) {
      return {
        ok: false,
        error: `The follow-up branch ${options.branch} cannot be stacked on itself.`,
      };
    }
    return { ok: true, base };
  }

  /**
   * Write back an explicit `workflowType` as a `wf:<type>` label. Called only
   * after the launch guards pass, so a refused launch never mutates the bead.
   */
  async function persistExplicitWorkflowLabel(options: {
    taskId: string;
    cwd: string;
    resolution: WorkflowResolution;
    /** True when a confirmation flow already wrote the label. */
    alreadyPersisted: boolean;
    existingLabels?: string[];
  }): Promise<void> {
    if (options.resolution.source !== "arg" || options.alreadyPersisted) return;
    await core.writeWorkflowTypeLabel({
      taskId: options.taskId,
      type: options.resolution.type,
      cwd: options.cwd,
      existingLabels: options.existingLabels,
    });
  }

  pi.registerTool({
    name: "belayd_start_followup",
    label: "Start stacked follow-up workflow",
    description:
      "Start a new Belayd workflow for a follow-up bead, stacked on the current branch " +
      "instead of main. Records the base branch and fork point so it can later be rebased " +
      "onto main with belayd_stack_rebase. Hands the workflow off to a new orchestrator " +
      "session and disarms this one. Set force: true to hand off even while this session " +
      "has phase runs in flight (they are abandoned).",
    parameters: Type.Object({
      taskId: Type.String({ description: "Beads issue ID for the follow-up, e.g. bd-43" }),
      workflowType: Type.Optional(
        Type.String({
          description:
            "Workflow sub-type: feature (default), bugfix, research, chore, documentation, refactor, hotfix",
        }),
      ),
      base: Type.Optional(
        Type.String({
          description: "Base branch to stack on (defaults to the current branch)",
        }),
      ),
      handoff: Type.Optional(
        Type.String({
          description:
            "Free-text context for the spawned orchestrator. Overrides only the parent-summary line; task ids, branch/base/fork point and the completed phase list are always collected from the parent session.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Hand off even while this session has phase runs in flight; the live runs are abandoned.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isValidTaskId(params.taskId)) {
        return textToolResult(
          `Invalid task id: ${params.taskId}. Expected a beads id like "bd-42" or "bd-42.1".`,
          1,
        );
      }

      const cwd = ctx.cwd ?? process.cwd();
      const branch = `feat/${params.taskId}`;
      const baseResult = resolveFollowupBase({ branch, requested: params.base, cwd });
      if (!baseResult.ok) return textToolResult(baseResult.error, 1);
      const base = baseResult.base;

      const metadata = await launch.readTaskMetadata(params.taskId, cwd);
      const toolResolution = await core.resolveToolWorkflowResolution({
        ctx,
        taskId: params.taskId,
        resolution: resolveWorkflowSelection(params.workflowType, metadata?.labels),
        existingLabels: metadata?.labels,
      });
      if (toolResolution.kind === "denied") return textToolResult(toolResolution.text, 1);

      const resolution = toolResolution.resolution;
      const workflowType = resolution.type;

      // Refuse a launch that would duplicate this session's own work *before*
      // writing the wf:<type> label, so a refused launch leaves the bead
      // untouched (bd-120). The same guards run again inside
      // launchWorktreeWorkflow for callers that do not pre-check.
      const blocker = launch.launchBlocker({
        state: getSessionState(ctx),
        cwd,
        branch,
        force: params.force === true,
      });
      if (blocker !== undefined) return textToolResult(blocker, 1);

      await persistExplicitWorkflowLabel({
        taskId: params.taskId,
        cwd,
        resolution,
        alreadyPersisted: toolResolution.persisted,
        existingLabels: metadata?.labels,
      });

      const outcome = await launch.launchWorktreeWorkflow({
        ctx,
        taskId: params.taskId,
        workflowType,
        branch,
        base,
        handoff: params.handoff,
        resolutionSource: resolution.source,
        matchedLabel: resolution.matchedLabel,
        force: params.force === true,
      });
      if (!outcome.ok) return textToolResult(outcome.error, 1);

      const chainText = describeFollowupStack(cwd, branch, base);
      return textToolResult(
        `Follow-up ${workflowType} workflow started for ${params.taskId} on ${branch}, stacked on ${base}.\n\n${chainText}`,
        0,
      );
    },
  });
}

/** Register the stop tools at their original composer position. */
export function registerTaskStopTools(deps: TaskStopDeps): void {
  const { pi, getSessionState, core, humanGateDeps } = deps;

  // ── Register stop-task tool ─────────────────────────────────────────
  pi.registerTool({
    name: "belayd_stop_task",
    label: "Stop Belayd Task",
    description: "Deactivate the enforced Belayd process for the current task.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const telemetryCwd = ctx.cwd;

      // Release the bead's assignee before teardown (bd-150). Gated on
      // `gateActive`: losing the orchestrator lease disarms the gate but leaves
      // `currentTaskId` naming the workflow this session was driving, and the
      // actor string is per task id — so a stale session clearing on the id
      // alone would CAS-clear the assignment the *new* driver now holds. Only a
      // harness actor is cleared: a human's own assignment survives a stop. A
      // refusal warns and teardown continues — ownership reporting never blocks
      // a stop.
      if (state.gateActive === true && state.currentTaskId !== "") {
        const cleared = await clearAssignee({
          taskId: state.currentTaskId,
          holder: orchestratorActor(state.currentTaskId),
          cwd: ctx.cwd,
          runBd: runBdForAssignee,
        });
        reportAssigneeResult(cleared);
        // A stopped workflow must not leave a human gate blocking its bead in
        // bd/Scotty (bd-152). Bounded and best-effort, like the assignee clear
        // above; it also stops the answer poll, which only exists for the wait.
        await reapHumanGateForTask({
          ctx,
          state,
          beadId: state.currentTaskId,
          deps: humanGateDeps,
        });
      } else {
        clearHumanAnswerWait(state);
      }

      // In-flight background runs must not survive task teardown.
      abortAndResetRunTracking(state);

      // Restore original cwd if we're in a worktree. The recorded path comes
      // from another process (and older workflows recorded `/`), so it is
      // validated before chdir instead of trusted blindly.
      let chdirNote = "";
      const persisted = readWorkflowState({ cwd: ctx.cwd });
      if (persisted) {
        const target = isSafeChdirTarget({
          path: persisted.originalCwd,
          existsSync: (path) => existsSync(path),
          // statSync can race a concurrent delete; a probe failure means "not a
          // directory" and must not throw out of the tool handler.
          isDirectory: (path) => {
            try {
              return statSync(path).isDirectory();
            } catch {
              return false;
            }
          },
        });
        if (target.allowed) {
          process.chdir(target.path);
        } else {
          chdirNote = `\nWorking directory unchanged: ${target.reason}.`;
        }
        clearWorkflowState({ cwd: ctx.cwd });
      }

      // Teardown always drops the packet, even when the workflow row is missing: a
      // stale handoff must never be re-injected by the next workflow that runs
      // in this worktree.
      clearHandoff({ cwd: ctx.cwd });

      state.gateActive = false;
      state.completedPhaseNames = [];
      // A stopped session no longer hands anything off; leaving the marker in
      // memory would keep `belayd_status` reporting "Handed off" until restart.
      state.handedOffTo = undefined;
      state.handoffPendingNotice = undefined;
      const clearedCallerMarker = clearCallerHandoff({
        cwd: ctx.cwd,
        sessionKey: ctx.sessionManager.getSessionId(),
      });
      if (!clearedCallerMarker.ok) {
        core.reportHandoffProblem(
          `Belayd could not clear this session's handoff marker (${clearedCallerMarker.error}); ` +
            "a restart may still report a handoff that was stopped here.",
        );
      }
      state.workflowType = "feature";
      core.applyWorkflowConfig(state);
      state.userGuideContent = undefined;
      state.proofOutput = undefined;
      state.proofVerifierVerdict = undefined;
      state.awaitingReviewResponse = false;
      core.applyToolGate(state);
      // Flush and log the stopped workflow's telemetry once, then reset.
      resetModelTelemetry(telemetryCwd, { log: true });
      return {
        content: [
          {
            type: "text" as const,
            text: `Belayd process deactivated.${chdirNote}`,
          },
        ],
        details: {
          messages: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
            toolCalls: 0,
          },
          exitCode: 0,
        },
      };
    },
  });

  // ── Register stop-planning tool ──────────────────────────────────────
  pi.registerTool({
    name: "belayd_stop_planning",
    label: "Stop planning mode",
    description: "Exit planning mode, abort any planning sub-agent runs, and restore full tools.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      abortAndResetRunTracking(state);
      state.planningActive = false;
      state.planningTarget = undefined;
      core.applyToolGate(state);
      return {
        content: [
          {
            type: "text" as const,
            text: "Planning mode deactivated.",
          },
        ],
        details: {
          messages: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
            toolCalls: 0,
          },
          exitCode: 0,
        },
      };
    },
  });
}
