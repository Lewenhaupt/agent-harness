/**
 * Belayd agent harness — pi project-level extension.
 *
 * Auto-discovered by pi from `.pi/extensions/belayd-harness/index.ts`.
 *
 * This file is the composer: it owns the pi API, the per-session state store,
 * the process-core seams the capability modules cannot import (the process
 * gate, the fleet supervisor, the barrel symbols the tests mock) and the
 * registration order. Every tool, command and hook body lives in
 * `extensions/capabilities/`, one module per capability, wired here in the
 * original pi order:
 *
 * - `/plan` + the planning tools        — `capabilities/planning.ts`
 * - `/belayd`, `/belayd-complete`, the daemon sentinel and the session hooks
 *                                       — `capabilities/workflow-commands.ts`
 * - per-turn gate/planning context      — `capabilities/workflow-context.ts`
 * - phase tools + `belayd_status`       — `capabilities/phase-tools.ts`
 * - proof verifier, ask-human, metrics, doctor, bd, archify, outline
 * - fleet supervisor tools/hooks/`/fleet` — `capabilities/fleet.ts`
 * - start/followup/stop/commit/stack     — `capabilities/task-control.ts`,
 *                                          `capabilities/commit.ts`
 * - the four harness hooks               — `capabilities/hooks.ts`
 *
 * The gate lifecycle, phase ledger and recovery paths live in
 * `capabilities/workflow-core.ts`; the background phase spawn lives in
 * `capabilities/phase-run.ts`; the child-orchestrator launch lives in
 * `capabilities/launch.ts`. Those three are the process core: callable without
 * extension globals, which is what the durable-member runtime needs.
 */

import type {
  BashToolCallEvent,
  ExtensionAPI,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { claimRegistrationOnce } from "../src/claim-registry.js";
import {
  ALL_PHASE_NAMES,
  awaitWorktreeReady,
  checkToolAllowed,
  collectHandoffDefault,
  extractOutlineSymbols,
  formatProcessState,
  markPhaseCompleted,
  type Phase,
  readFleetStatus,
  readStackNode,
  readWorktreeBranch,
  resolveBashTimeout,
  resolveGitCommonDir,
  resolveOutlineTargets,
  resolveWorktreePath,
  scanProcesses,
  setupWorktree,
  spawnAgentWithFallback,
  stripBdShowComments,
  updateFleetIntent,
  WORKFLOW_REGISTRY,
} from "../src/index.js";
import { createQualityGateRunner } from "../src/quality-gate-run.js";
import { registerArchify } from "./capabilities/archify.js";
import { registerBdTool } from "./capabilities/bd.js";
import { registerCommitTool, registerStackRebaseTool } from "./capabilities/commit.js";
import type { CoreSessionState } from "./capabilities/context.js";
import { recordGateAttemptMetric } from "./capabilities/context.js";
import { registerDoctor } from "./capabilities/doctor.js";
import type { FleetSessionState } from "./capabilities/fleet.js";
import { createFleet, type FleetApi, type FleetForceStopSeams } from "./capabilities/fleet.js";
import { registerHooks } from "./capabilities/hooks.js";
import {
  type HumanGateDeps,
  openReviewHumanGate,
  registerHumanGate,
} from "./capabilities/human-gate.js";
import { createLaunch } from "./capabilities/launch.js";
import { registerMetrics } from "./capabilities/metrics.js";
import { modelCooldown, modelFallbackEnabled, modelState } from "./capabilities/model.js";
import { registerOutline } from "./capabilities/outline.js";
import { createPhaseRunner } from "./capabilities/phase-run.js";
import { registerAgentPhaseTools, registerStatusTool } from "./capabilities/phase-tools.js";
import { registerPlanningCommand, registerPlanningTools } from "./capabilities/planning.js";
import { registerProof } from "./capabilities/proof.js";
import {
  attributedBdArgv,
  createInitialSessionState,
  createSessionStateStore,
  resolveSessionBdActor,
} from "./capabilities/session-state.js";
import { registerTaskStartTools, registerTaskStopTools } from "./capabilities/task-control.js";
import { registerWorkflowCommands } from "./capabilities/workflow-commands.js";
import { registerWorkflowContext } from "./capabilities/workflow-context.js";
import { createWorkflowCore } from "./capabilities/workflow-core.js";

/**
 * The harness session state, composed from the two halves that own its fields:
 * the fleet-free core (`capabilities/context.ts`) and the fleet supervisor slice
 * (`capabilities/fleet.ts`, the only fleet-allowlisted capability module).
 *
 * One intersection, one object identity: the store below still creates and
 * returns a single `SessionState` per pi session.
 */
type SessionState = CoreSessionState & FleetSessionState;

const getSessionState = createSessionStateStore<SessionState>(createInitialSessionState);

// ── Extension factory ──────────────────────────────────────────────────

// This extension ships in two places that can load in the same process:
// globally at ~/.pi/agent/extensions/belayd-harness.ts (Nix-installed) and
// project-locally via .pi/settings.json → extensions/index.ts. When pi runs
// inside this repo or one of its worktrees, both load, and pi's post-load
// conflict detection reports every duplicate belayd_* tool as
// "Tool X conflicts with ...".
//
// Dedup keys on the extension load batch's shared event bus (via `pi.events`).
// Every extension in one `loadExtensions` call shares one bus; separate
// batches — the pi-web provider-bootstrap pass and each session — get their
// own. A claim on the bus therefore scopes to "this session":
// - CLI: only one copy loads anyway (bin/pi and the Nix pi both use -ne).
// - pi-web: the global and project copies in one session share a bus, so the
//   first copy wins and the second is a no-op; a later session has a fresh bus
//   and registers again.
//
// A process-wide boolean was tried and broke pi-web: the provider-bootstrap
// pass set it once, then every real session saw the stale flag and registered
// nothing. `pi.getAllTools()` / `pi.getCommands()` can't be used here either —
// they are "action methods" that throw "Extension runtime not initialized"
// until Runner.bindCore() runs after all extensions finish loading.
const CLAIM_CHANNEL = "__belayd_harness_claim__";

/**
 * True when another harness copy in this load batch already claimed
 * registration. The probe listener is left in place for the first copy so
 * later copies in the same batch count it and yield; the shared bus is
 * discarded with its session, so nothing leaks across sessions.
 */
function harnessAlreadyLoaded(pi: ExtensionAPI): boolean {
  return !claimRegistrationOnce(pi, CLAIM_CHANNEL);
}

// Build identity for the stale-build guard. In the Nix-installed copy this is
// file:///nix/store/<hash>-belayd-harness/extensions/index.ts, so the load log
// below reveals exactly which build registered the tools — the trap hit when
// pi-web kept a pre-fallback extension in memory after a rebuild.
const HARNESS_MODULE_PATH: string = import.meta.url;

/**
 * Narrow a `tool_call` event to pi's built-in bash input.
 *
 * Pi's `ToolCallEvent` union does not discriminate on `toolName` because
 * `CustomToolCallEvent.toolName` is `string` and therefore overlaps every
 * literal, so a direct `event.toolName === "bash"` check does not narrow. The
 * predicate accepts pi's canonical "bash" plus the legacy "Bash" casing used
 * by the other guards in this extension, and narrows `input` to
 * `BashToolInput` so the in-place timeout patch typechecks without widening it
 * to `unknown`.
 */
function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
  return event.toolName === "bash" || event.toolName === "Bash";
}

/**
 * The force-stop seams live with the fleet capability that consumes them (the
 * composer only normalizes the defaults); re-exported here because tests import
 * the type from the extension entry point.
 */
export type { FleetForceStopSeams } from "./capabilities/fleet.js";

export default function belaydAgentHarness(
  pi: ExtensionAPI,
  seamOverrides: FleetForceStopSeams = {},
): void {
  if (harnessAlreadyLoaded(pi)) return;

  const seams: Required<Pick<FleetForceStopSeams, "scan" | "signal">> &
    Omit<FleetForceStopSeams, "scan" | "signal"> = {
    ...seamOverrides,
    scan: seamOverrides.scan ?? (() => scanProcesses()),
    signal:
      seamOverrides.signal ??
      ((pid, signalName) => {
        process.kill(pid, signalName);
      }),
  };

  console.warn(`[belayd-harness] registering tools/commands from ${HARNESS_MODULE_PATH}`);

  // Assigned at its original registration position; the arrows below close over
  // this binding and are only called after every extension has loaded.
  let fleet: FleetApi;

  const humanGateDeps: HumanGateDeps = {
    getSessionState,
    resolveSessionBdActor: (ctx) => resolveSessionBdActor(ctx, getSessionState),
    sendUserMessage: (text: string) => {
      pi.sendUserMessage(text);
    },
  };

  // The quality-gate runner is the process core the durable-member runtime needs
  // outside an extension: everything it closed over is passed in explicitly.
  const runQualityGate = createQualityGateRunner({
    spawnAgentWithFallback,
    routing: {
      cooldownStore: modelCooldown,
      enabled: modelFallbackEnabled,
      telemetry: modelState.telemetry,
      capacity: modelState.capacity,
    },
    recordAttempt: recordGateAttemptMetric,
    isKnownPhase: (phaseName: string): phaseName is Phase => ALL_PHASE_NAMES.includes(phaseName),
  });

  // The gate primitives stay in `src/process-gate.ts`, which no capability
  // module may import; the core receives them as seams instead.
  const core = createWorkflowCore({
    pi,
    getSessionState,
    gate: { checkToolAllowed, markPhaseCompleted, formatProcessState },
    readWorktreeBranch,
  });

  // `fleet` is assigned below at its original registration position. These
  // arrows read it at call time — every hook/handler runs after all extensions
  // finish loading — which keeps the capability modules fleet-free without
  // reordering the fleet block.
  const stopOrchestratorLeaseTimer = (state: CoreSessionState): void =>
    fleet.stopOrchestratorLeaseTimer(state);

  const launch = createLaunch({
    pi,
    getSessionState,
    core,
    stopOrchestratorLeaseTimer,
    seams: {
      setupWorktree,
      awaitWorktreeReady,
      readStackNode,
      collectHandoffDefault,
      stripBdShowComments,
    },
  });

  const runner = createPhaseRunner({
    pi,
    getSessionState,
    core,
    readTaskPlan: launch.readTaskPlan,
    spawnAgentWithFallback,
    runQualityGate,
    workflowRegistry: WORKFLOW_REGISTRY,
    reviewGate: (options) => openReviewHumanGate({ ...options, deps: humanGateDeps }),
  });

  // ── Registration order is load-bearing; do not reorder these calls ──
  registerPlanningCommand({ pi, getSessionState, core, runner, humanGateDeps });

  registerWorkflowCommands({
    pi,
    getSessionState,
    core,
    launch,
    humanGateDeps,
    fleet: {
      claimWorktreeOrchestrator: (options) =>
        fleet.claimWorktreeOrchestrator({ ...options, state: getSessionState(options.ctx) }),
      // The two supervisor resume paths stay distinct inside the fleet
      // capability (strict same-process resume, then a loud repair).
      recoverFleetRuns: (ctx) => {
        const state = getSessionState(ctx);
        const resumed = fleet.resumeFleetRunLoop(ctx, state);
        fleet.readoptFleetRuns({ ctx, state, resumed });
      },
      stopFleetRunTimer: (ctx) => fleet.stopFleetRunTimer(getSessionState(ctx)),
      releaseSessionOrchestratorLease: (state, sessionId, cwd) =>
        fleet.releaseSessionOrchestratorLease(state, sessionId, cwd),
    },
  });

  registerWorkflowContext({
    pi,
    getSessionState,
    core,
    humanGateDeps,
    fleetEventsMessage: (ctx) => fleet.drainFleetEventsMessage(ctx),
  });

  registerAgentPhaseTools({ pi, getSessionState, core, runner });

  registerPlanningTools({ pi, getSessionState, core, runner, humanGateDeps });

  registerProof(pi, {
    getSessionState,
    activeWorkflowOwnership: core.activeWorkflowOwnership,
    spawnAgentWithFallback,
    modelRouting: {
      cooldownStore: modelCooldown,
      enabled: modelFallbackEnabled,
      telemetry: modelState.telemetry,
      capacity: modelState.capacity,
    },
  });

  registerStatusTool({
    pi,
    getSessionState,
    core,
    readBeadOwnership: (taskId, cwd) => fleet.readBeadOwnership(taskId, cwd),
  });

  registerHumanGate(pi, humanGateDeps);

  registerMetrics(pi);

  registerDoctor(pi, { getSessionState });

  registerBdTool(pi, {
    attributeBdArgv: (argv, ctx) => attributedBdArgv(argv, ctx, getSessionState),
  });

  registerArchify(pi);

  registerOutline(pi, { resolveOutlineTargets, extractOutlineSymbols });

  // ── Fleet supervisor: tools, hooks and the /fleet command ───────────
  // Created here so its registrations land at this exact position; the hooks
  // above only reach it at run time, after every extension has loaded.
  fleet = createFleet({
    pi,
    seams,
    getSessionState,
    resolveSessionBdActor: (ctx) => resolveSessionBdActor(ctx, getSessionState),
    applyToolGate: core.applyToolGate,
    readTaskMetadata: launch.readTaskMetadata,
    launchWorktreeWorkflow: launch.launchWorktreeWorkflow,
    scanProcesses,
    resolveGitCommonDir,
    resolveWorktreePath,
    readWorktreeBranch,
    updateFleetIntent,
    readFleetStatus,
  });

  registerTaskStartTools({ pi, getSessionState, core, launch });

  registerStackRebaseTool(pi);

  registerTaskStopTools({ pi, getSessionState, core, humanGateDeps });

  registerCommitTool(pi, {
    getSessionState,
    markPhaseCompleted,
    persistCompletedPhases: core.persistCompletedPhases,
    sendMessage: pi.sendMessage,
  });

  // Bash timeout, the gate's tool_call refusal, the uncommitted notice and the
  // workflow-completion teardown, in their original registration order.
  registerHooks({
    pi,
    getSessionState,
    evaluateToolCallGate: core.evaluateToolCallGate,
    formatProcessState: core.formatProcessState,
    applyToolGate: core.applyToolGate,
    fleetRefusalFor: fleet.fleetRefusalFor,
    isBashToolCallEvent,
    resolveBashTimeout,
    humanGateDeps,
  });
}
