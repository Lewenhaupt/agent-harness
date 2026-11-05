/**
 * Harness hooks: bash timeout, the process gate's tool_call refusal, the
 * uncommitted-files notice and workflow completion teardown (bd-179).
 *
 * Registration order is load-bearing: the bash timeout hook is registered first
 * so a blocked tool call cannot skip the timeout patch. The composer supplies
 * the state reader, the fleet refusal and the gate primitives.
 */
import type {
  BashToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { orchestratorActor } from "../../src/beads-actor.js";
import { clearAssignee } from "../../src/beads-assignee.js";
import { clearHandoff } from "../../src/handoff.js";
import { countUncommittedFiles } from "../../src/session-conditions.js";
import { isWorkflowComplete } from "../../src/workflow-phases.js";
import { getPhasesForType, WORKFLOW_REGISTRY } from "../../src/workflow-registry.js";
import { clearWorkflowState } from "../../src/workflow-state.js";
import type { CoreSessionState } from "./context.js";
import { abortToolCall, reportAssigneeResult, runBdForAssignee } from "./context.js";
import { compactTaskSessions } from "./daemon.js";
import type { HumanGateDeps } from "./human-gate.js";
import { reapHumanGateForTask } from "./human-gate.js";
import { resetModelTelemetry } from "./model.js";

/** The `tool_call` event subset the fleet refusal reads. */
interface ToolCallEventLike {
  toolName: string;
}

/** Composer-supplied seams: state reader, gate primitives and teardown hooks. */
export interface HookDeps {
  pi: ExtensionAPI;
  getSessionState: (ctx: { sessionManager: { getSessionId: () => string } }) => CoreSessionState;
  evaluateToolCallGate: (
    event: ToolCallEventLike,
    state: CoreSessionState,
  ) => { block?: boolean; reason?: string };
  formatProcessState: (
    completed: string[],
    taskId: string,
    phaseOrder?: readonly string[],
  ) => string;
  applyToolGate: (state: CoreSessionState) => void;
  fleetRefusalFor: (options: {
    ctx: ExtensionContext;
    state: CoreSessionState;
    toolName: string;
  }) => string | undefined;
  isBashToolCallEvent: (event: ToolCallEvent) => event is BashToolCallEvent;
  resolveBashTimeout: (input: BashToolCallEvent["input"]) => number;
  humanGateDeps: HumanGateDeps;
}

/** Register the four harness hooks at their original composer positions. */
export function registerHooks(deps: HookDeps): void {
  const {
    pi,
    getSessionState,
    evaluateToolCallGate,
    formatProcessState,
    applyToolGate,
    fleetRefusalFor,
    isBashToolCallEvent,
    resolveBashTimeout,
    humanGateDeps,
  } = deps;

  // ── Bash timeout enforcement ───────────────────────────────────────
  // Separate from the process-gate `tool_call` handler below so the gate's
  // early returns cannot skip it. Mutates `event.input` in place (pi applies
  // the patch before execution and does not re-validate) instead of blocking,
  // guaranteeing every bash call — orchestrator or sub-agent — is bounded.
  // Registered first, do not reorder: pi's emitToolCall short-circuits once a
  // handler returns `block: true`, so moving this below the process gate would
  // let a rejected call skip the timeout patch.
  pi.on("tool_call", (event) => {
    if (!isBashToolCallEvent(event)) return {};
    event.input.timeout = resolveBashTimeout(event.input);
    return {};
  });

  // ── Process gate: block out-of-sequence tool calls ──────────────────
  pi.on("tool_call", (event, ctx) => {
    const state = getSessionState(ctx);
    // Fleet mode is an additional, earlier refusal with its own wording: a fleet
    // supervisor owns no worktree, so a phase tool is wrong here for a different
    // reason than bd-119.
    const fleetReason = fleetRefusalFor({ ctx, state, toolName: event.toolName });
    if (fleetReason !== undefined) {
      abortToolCall(event, "fleet-supervisor", fleetReason);
      return { block: true, reason: fleetReason };
    }
    if (state.planningActive) {
      const toolName = event.toolName;
      const isPlanningSubagent =
        toolName === "belayd_plan_scout" || toolName === "belayd_plan_research";
      const isBlockedDuringRun =
        (isPlanningSubagent || toolName === "bd") && state.activeRuns.size > 0;
      if (isBlockedDuringRun) {
        const activeRunIds = [...state.activeRuns.keys()].join(", ");
        const reason =
          `A planning run is already in progress (run ${activeRunIds}). ` +
          `Wait for its follow-up result before launching another sub-agent or writing beads.`;
        abortToolCall(event, "planning-run-in-flight", reason);
        return { block: true, reason };
      }
      return {};
    }
    if (!state.gateActive) return {};
    return evaluateToolCallGate(event, state);
  });

  // ── Uncommitted-files notification ────────────────────────────────
  pi.on("agent_end", async (_event, ctx) => {
    const count = await countUncommittedFiles(ctx.cwd);
    if (count !== null && count > 0) {
      const label = count === 1 ? "file" : "files";
      ctx.ui.notify(`${count} uncommitted ${label}`, "warning");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getSessionState(ctx);
    if (!state.gateActive) return;
    if (isWorkflowComplete(state.completedPhaseNames, state.phaseOrder)) {
      const currentPhaseOrder = [...state.phaseOrder];
      const currentTaskId = state.currentTaskId;
      const currentCompleted = [...state.completedPhaseNames];

      // Release the bead's assignee at completion (bd-150): the workflow is over
      // and ownership is stale. Cleared while the gate is still armed so the same
      // ownership rule as stop applies (only an actor we hold), and awaited so a
      // bd refusal degrades to a warning without blocking completion.
      if (currentTaskId !== "") {
        const cleared = await clearAssignee({
          taskId: currentTaskId,
          holder: orchestratorActor(currentTaskId),
          cwd: ctx.cwd,
          runBd: runBdForAssignee,
        });
        reportAssigneeResult(cleared);
      }

      // Compact completed phase sessions before resetting state
      await compactTaskSessions(currentTaskId, currentCompleted);

      // A completed workflow must not leave a human gate blocking its bead:
      // comments carry answers, but close/merge is still the acceptance signal
      // (bd-152), so the gate is resolved here rather than kept open.
      await reapHumanGateForTask({ ctx, state, beadId: currentTaskId, deps: humanGateDeps });

      // Workflow complete: the persisted state file is no longer needed.
      clearWorkflowState({ cwd: ctx.cwd });
      clearHandoff({ cwd: ctx.cwd });
      // Log the workflow's telemetry summary exactly once here, then start a
      // fresh store so a later phase-run settle cannot re-log it.
      resetModelTelemetry(ctx.cwd, { log: true });

      state.gateActive = false;
      // Any watcher still pending across completion is now stale.
      state.runEpoch += 1;
      state.completedPhaseNames = [];
      state.workflowType = "feature";
      state.phaseOrder = getPhasesForType("feature");
      state.optionalPhases = WORKFLOW_REGISTRY.feature.optionalPhases ?? [];
      state.consultPhases = WORKFLOW_REGISTRY.feature.consultPhases ?? [];
      state.userGuideContent = undefined;
      state.proofOutput = undefined;
      state.proofVerifierVerdict = undefined;
      applyToolGate(state);
      pi.sendMessage(
        {
          customType: "process-complete",
          content: formatProcessState(currentCompleted, currentTaskId, currentPhaseOrder),
          display: true,
        },
        { triggerTurn: false },
      );
    }
  });
}
