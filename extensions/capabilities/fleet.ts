/**
 * Fleet capability: the supervisor state slice, the read-only fleet tools, and
 * the run loop behind the `FLEET_IMPORT_ALLOWLIST` (bd-179).
 *
 * This is the only capability module permitted to import `src/fleet-*.ts` /
 * `src/fleet-state.ts`; the process gate stays forbidden here like everywhere
 * else. The supervisor mutates the shared session state, so the composer passes
 * the core accessors in explicitly (`FleetDeps`) instead of this module reaching
 * for extension globals.
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { COMMENT_EXCERPT_MAX_CHARS, excerptComment } from "../../src/bead-comments.js";
import { lookupOpenHumanGate } from "../../src/bead-gates.js";
import { withActorArgv } from "../../src/beads-actor.js";
import { acceptLandedMember } from "../../src/fleet-accept.js";
import { lookupFleetBeadEngagement } from "../../src/fleet-bead-engagement.js";
import { lookupFleetBeads, lookupFleetDependencies } from "../../src/fleet-beads.js";
import {
  FLEET_SUPERVISOR_HEARTBEAT_STALE_MS,
  isFleetLoopProvablyDead,
  planSupervisorReadoption,
  readSupervisorHeartbeat,
  type SupervisorHeartbeat,
  type SupervisorReadoptionReason,
  type SupervisorReadoptionRefusal,
  writeSupervisorHeartbeat,
} from "../../src/fleet-heartbeat.js";
import {
  type FleetMemberLaunchOutcome,
  parseFleetCommandArgs,
  parseFleetTaskIds,
  planFleetAdvance,
  runFleetLaunch,
  runFleetLaunch as runFleetLaunchEngine,
} from "../../src/fleet-launch.js";
import {
  buildFleetNote,
  FLEET_NOTE_BROADCAST,
  FLEET_NOTE_SUPERVISOR,
  type FleetEventBatch,
  formatFleetInbox,
  resolveFleetNoteRecipients,
  selectFleetEvents,
} from "../../src/fleet-mailbox.js";
import {
  defaultFleetMergeGitRunner,
  drainFleetMerge,
  enqueueFleetMerge,
  formatDrainResultText,
  formatFleetMergeQueue,
} from "../../src/fleet-merge.js";
import {
  createFleetSupervisorRecord,
  type FleetMode,
  type FleetSupervisorLiveness,
  fleetModeForId,
  formatFleetRefusal,
  isFleetRefusedTool,
  isProcessAlive,
  listFleetIds,
  readProcessStartTime,
  resolveFleetMode,
  resolveMemberFleet,
  sessionSupervisesFleetRecord,
} from "../../src/fleet-mode.js";
import {
  createFleetOrderingGates,
  type FleetOrderingGate,
  listFleetOrderingGatesForBead,
  reapFleetOrderingGatesByPrefix,
  resolveFleetOrderingGates,
  resolveFleetOrderingGatesForBead,
} from "../../src/fleet-ordering-gates.js";
import { pauseFleet, resumeFleet } from "../../src/fleet-pause.js";
import type {
  FleetPublish,
  FleetPublishMode,
  FleetPublishRequest,
  FleetPublishStackComposition,
} from "../../src/fleet-publish.js";
import { readFleetPublishConfig, resolveFleetPublish } from "../../src/fleet-publish.js";
import { reconcileAuthority, runFleetReconcile } from "../../src/fleet-reconcile.js";
import {
  deriveFleetMemberProgress,
  emptyAdvanceAction,
  FLEET_RUN_ACTION_TICK_INTERVAL_MS,
  FLEET_RUN_DETAIL_MAX_LENGTH,
  FLEET_RUN_TICK_INTERVAL_MS,
  type FleetGateNotice,
  type FleetGateNoticePlan,
  type FleetMemberClaim,
  type FleetMemberObservation,
  type FleetMemberReleaseReason,
  type FleetRun,
  type FleetTickAction,
  type FleetWorkflowProgressSnapshot,
  finishFleetRun,
  fleetTickProgress,
  isFleetRunActive,
  memberEvidenceCutoff,
  memberRanEvidence,
  planFleetTick,
  planGateNotices,
  planOutsideFleetLandings,
  recordFleetGateNotices,
  recordFleetTickProgress,
  recordRunMemberLanded,
  recordRunMemberLaunched,
  recordRunMemberStopped,
  releaseRunMembers,
  startFleetRun,
  worktreeCreatedAtFromStat,
} from "../../src/fleet-run.js";
import type { FleetPidProbe, FleetProcessScan } from "../../src/fleet-sessions.js";
import {
  classifyMemberLease,
  classifyMemberLivenessInWorktree,
  type FleetMemberLeaseProbe,
  type FleetMemberLiveness,
  type MemberPidOutcome,
  memberSessionToken,
  stopMemberSession,
} from "../../src/fleet-sessions.js";
import type { AckNotesResult, FleetNoteDelivery } from "../../src/fleet-state.js";
import {
  ackNotes,
  addFleetOrderingGates,
  appendFleetAuditEntry,
  drainNotes,
  dropFleetOrderingGates,
  enqueueNoteFanout,
  FLEET_NOTE_KINDS,
  type FleetMergeQueueEntry,
  type FleetNoteKind,
  fleetMemberTaskIds,
  isFleetNoteKind,
  pruneLandedFleetMember,
  readFleetIntent,
  readFleetMergeQueue,
  readRecentFleetAuditEntries,
  retireFleetDeferral,
} from "../../src/fleet-state.js";
import {
  applyFleetBeadEngagement,
  applyFleetBeadLookup,
  DEFAULT_FLEET_ID,
  type FleetBead,
  type FleetBeadLookup,
  type FleetEngagementLookup,
  type FleetIntent,
  type FleetMemberView,
  type FleetStatus,
  fleetBeadTaskIds,
  formatBeadOwnership,
  formatFleetStatus,
  sanitizeFleetId,
} from "../../src/fleet-status.js";
import {
  computeFleetSupervisorName,
  supervisorRunStatus,
} from "../../src/fleet-supervisor-name.js";
import { readModelTelemetry } from "../../src/model-telemetry.js";
import {
  adoptOrchestratorClaim,
  heartbeatOrchestratorClaim,
  ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS,
  readOrchestratorClaim,
  releaseOrchestratorClaim,
} from "../../src/orchestrator-claim.js";
import { matchOwnedWorktree } from "../../src/owned-worktree.js";
import {
  matchProjectId,
  matchWorkspaceId,
  mutateSessionPins,
  PI_WEB_PROJECTS_PATH,
  projectWorkspacesPath,
  withoutSessionPin,
  withSessionPin,
} from "../../src/pi-web-navigation.js";
import { listRuns } from "../../src/run-manifest.js";
import { isValidTaskId } from "../../src/session-naming.js";
import { currentBranch, DEFAULT_BASE_BRANCH } from "../../src/stack-rebase.js";
import type {
  SupervisionGateFacts,
  SupervisionInputResult,
  SupervisionMemberFacts,
  SupervisionRunFacts,
} from "../../src/workflow-digest.js";
import type { WorkflowResolutionSource, WorkflowSubType } from "../../src/workflow-registry.js";
import { resolveWorkflowSelection } from "../../src/workflow-registry.js";
import { readWorkflowState, workflowStateFilePath } from "../../src/workflow-state.js";
import type { CoreSessionState } from "./context.js";
import { errorText, runBdCommand, runGitCommand, textToolResult } from "./context.js";
import { piWebEndpoint, piWebRequest } from "./daemon.js";
import { clearHumanAnswerWait, isSubAgentSession } from "./human-gate.js";

/**
 * Stop a session's orchestrator-lease heartbeat.
 *
 * Exported (and shared with the fleet instance's `stopOrchestratorLeaseTimer`) so
 * there is exactly one clearing implementation: the session-state store's dispose
 * hook runs before any fleet instance exists, and a dropped state must not keep
 * renewing a worktree lease into the next session id.
 */
export function stopOrchestratorLeaseHeartbeat(state: {
  orchestratorLeaseTimer?: ReturnType<typeof setInterval>;
}): void {
  if (state.orchestratorLeaseTimer === undefined) return;
  clearInterval(state.orchestratorLeaseTimer);
  state.orchestratorLeaseTimer = undefined;
}

/**
 * Release every session-scoped timer of a state the store is dropping (bd-173).
 *
 * Covers both timers the fleet slice drives: the run-loop tick (`fleetRunTimer`)
 * and the orchestrator-lease heartbeat (`orchestratorLeaseTimer`). Both close over
 * the state object, so clearing them is the only way a dropped state stops acting
 * — otherwise a leaked loop keeps ticking and heartbeating on a reused session id.
 */
export function disposeFleetSessionState(state: {
  fleetRunTimer?: ReturnType<typeof setInterval>;
  orchestratorLeaseTimer?: ReturnType<typeof setInterval>;
}): void {
  if (state.fleetRunTimer !== undefined) clearTimeout(state.fleetRunTimer);
  stopOrchestratorLeaseHeartbeat(state);
}

/** The slice of the harness session state the fleet supervisor owns. */
export interface FleetSessionState {
  fleetArm?: { fleetId: string; token: string };
  pendingFleetEventAcks?: {
    fleetId: string;
    gitCommonDir: string;
    dir: string;
    deliveries: FleetNoteDelivery[];
  };
  fleetRunTimer?: ReturnType<typeof setInterval>;
  fleetTickInFlight?: boolean;
  supervisorName?: string;
  supervisorPin?: { projectId: string; workspaceId: string; sessionId: string };
}

/** Full state type the supervisor reads and writes (core + fleet fields). */
export type FleetState = CoreSessionState & FleetSessionState;
export type FleetResumeOutcome =
  | { resumed: true; fleetId: string }
  | { resumed: false; reason: "no-fleet-mode" | "no-active-run" };

/** Injected force-stop seams (process table, identity probe, signal delivery). */
export interface FleetForceStopSeams {
  /** Process-table snapshot; defaults to this host's `/proc` scan. */
  scan?: () => FleetProcessScan;
  /** Identity probes used to re-verify a matched pid; defaults to `/proc`. */
  probe?: FleetPidProbe;
  /** Start-time capture at match time; defaults to the probe's own reader. */
  startTime?: (pid: number) => string | undefined;
  /** Signal delivery; defaults to `process.kill`. */
  signal?: (pid: number, signalName: NodeJS.Signals) => void;
}

/** Composer-supplied seams: the state accessors and the workflow side of a launch. */
export interface FleetDeps {
  pi: ExtensionAPI;
  seams: Required<Pick<FleetForceStopSeams, "scan" | "signal">> &
    Omit<FleetForceStopSeams, "scan" | "signal">;
  getSessionState: (ctx: { sessionManager: { getSessionId: () => string } }) => FleetState;
  resolveSessionBdActor: (ctx: unknown) => string | undefined;
  applyToolGate: (state: FleetState) => void;
  /**
   * Injected because the extension tests swap these through the composer's
   * `src/index.js` barrel import; a direct import here would bypass the mock.
   */
  scanProcesses: typeof import("../../src/fleet-sessions.js").scanProcesses;
  resolveGitCommonDir: typeof import("../../src/worktree.js").resolveGitCommonDir;
  resolveWorktreePath: typeof import("../../src/worktree.js").resolveWorktreePath;
  readWorktreeBranch: typeof import("../../src/owned-worktree.js").readWorktreeBranch;
  updateFleetIntent: typeof import("../../src/fleet-state.js").updateFleetIntent;
  readFleetStatus: typeof import("../../src/fleet-status.js").readFleetStatus;
  readTaskMetadata: (taskId: string, cwd: string) => Promise<{ labels?: string[] } | undefined>;
  launchWorktreeWorkflow: (options: {
    ctx: ExtensionContext;
    taskId: string;
    workflowType: WorkflowSubType;
    branch: string;
    base?: string;
    handoff?: string;
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
    force?: boolean;
    role?: "handoff" | "fleet-member";
  }) => Promise<
    { ok: false; error: string } | { ok: true; handoff: { sessionId: string }; branch?: string }
  >;
}

/**
 * How many member beads a full reconcile sweep asks bd about at once (bd-158).
 *
 * A reconcile pass sweeps every member — unlike the tick's one-bead rotation — so
 * the reads are bounded to a small concurrency instead of either a serial crawl or
 * a burst of processes against the same database.
 */
const ORDERING_SWEEP_CONCURRENCY = 3;

/**
 * How many member `bd gate list` reads one tick runs at once (bd-219 review).
 *
 * Same reasoning as `ENGAGEMENT_CONCURRENCY`: every read is one bd subprocess, so
 * a wide burst starves the database the tick is describing, while a serial crawl
 * makes one slow bd stretch a tick by members × the 15 s read timeout — delaying
 * the very stall/halt decisions the tick exists to make.
 */
const MEMBER_GATE_READ_CONCURRENCY = 4;

/**
 * Map with a small fixed concurrency, preserving input order in the result.
 *
 * Module-level because both the ordering sweep and the per-member observation fan-out
 * need it; `Promise.all` over a whole list would fork every bd read at once.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One observation per task id, in `taskIds` order, with bounded concurrency.
 *
 * Exported so the ordering/count contract the tick relies on is directly
 * testable: `fleetMemberSignatures` and the stall accounting both assume exactly
 * one entry per member, in the caller's order, and a fan-out that dropped or
 * reordered a member would make a healthy run look stalled.
 */
export async function readMemberObservationsBounded(options: {
  taskIds: readonly string[];
  observe: (taskId: string) => Promise<FleetMemberObservation>;
}): Promise<FleetMemberObservation[]> {
  return mapBounded(options.taskIds, MEMBER_GATE_READ_CONCURRENCY, options.observe);
}

/** The one turn-start message the fleet note drain produces. */
export interface FleetDrainMessage {
  message: { customType: string; content: string; display: boolean };
}

/** The supervisor API the composer wires into its hooks and commands. */
export interface FleetApi {
  adoptFleetSupervisorIdentity(options: {
    ctx: ExtensionContext;
    state: FleetState;
    pin: boolean;
  }): void;
  /** Drain this member's pending notes into one turn-start message. */
  drainFleetEventsMessage(ctx: ExtensionContext): FleetDrainMessage | undefined;
  startFleetRunLoop(options: { ctx: ExtensionContext; state: FleetState; mode: FleetMode }): void;
  stopFleetRunTimer(state: FleetState): void;
  runFleetLaunch(options: {
    ctx: ExtensionContext;
    taskIds: readonly string[];
    fleetId: string;
    requestedConcurrency?: number;
    origin?: "advance" | "launch";
    runMode?: { accept: boolean };
  }): Promise<{ ok: boolean; text: string }>;
  /** Strict same-process resume of a supervised fleet run loop (bd-169). */
  resumeFleetRunLoop(ctx: ExtensionContext, state: FleetState): FleetResumeOutcome;
  /** Repair a supervised run whose process died (bd-169). */
  readoptFleetRuns(options: {
    ctx: ExtensionContext;
    state: FleetState;
    resumed: FleetResumeOutcome;
  }): void;
  readBeadOwnership(taskId: string, cwd: string): Promise<string | undefined>;
  /**
   * The single tier-2 supervision seam (bd-189): one member's deterministic
   * facts, gathered through the fleet read path the supervisor already trusts.
   *
   * Read-only: one fleet status read, one read-only bd `show`, one read-only
   * `bd gate list`,
   * one read-only `git log -1` for the branch head, plus plain fs reads of that
   * worktree's `.belayd/` records. It never spawns, writes, or touches another
   * worktree's files.
   */
  readSupervisionInput(request: { taskId?: string; cwd: string }): Promise<SupervisionInputResult>;
  stopOrchestratorLeaseTimer(state: CoreSessionState): void;
  releaseSessionOrchestratorLease(state: CoreSessionState, sessionId: string, cwd: string): void;
  /** Fleet-mode refusal for one tool call, or undefined when the call is fine. */
  fleetRefusalFor(options: {
    ctx: ExtensionContext;
    state: CoreSessionState;
    toolName: string;
  }): string | undefined;
  claimWorktreeOrchestrator: (options: {
    ctx: ExtensionContext;
    state: FleetState;
    worktreePath: string;
    taskId: string;
    branch: string;
  }) => { ok: true } | { ok: false; error: string };
}

/**
 * Assemble a partial publish request from the launch tool/flag params, or
 * undefined when none were given so the resolver can use the repo config.
 */
function fleetPublishRequest(input: {
  mode?: FleetPublishMode;
  remote?: string;
  base?: string;
  ready?: boolean;
  stacks?: FleetPublishStackComposition;
}): FleetPublishRequest | undefined {
  const request: FleetPublishRequest = {
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.remote === undefined ? {} : { remote: input.remote }),
    ...(input.base === undefined ? {} : { base: input.base }),
    ...(input.ready === undefined ? {} : { ready: input.ready }),
    ...(input.stacks === undefined ? {} : { stacks: input.stacks }),
  };
  return Object.keys(request).length === 0 ? undefined : request;
}

/**
 * One bead record by id, case-insensitively (bd ids are compared the same way
 * everywhere else in the fleet view).
 */
function findBeadById(beads: readonly FleetBead[], taskId: string): FleetBead | undefined {
  const lowered = taskId.toLowerCase();
  return beads.find((candidate) => candidate.id.toLowerCase() === lowered);
}

export function createFleet(deps: FleetDeps): FleetApi {
  const {
    pi,
    seams,
    getSessionState,
    resolveSessionBdActor,
    applyToolGate,
    readTaskMetadata,
    launchWorktreeWorkflow,
    scanProcesses,
    resolveGitCommonDir,
    resolveWorktreePath,
    readWorktreeBranch,
    updateFleetIntent,
    readFleetStatus,
  } = deps;

  // ── Register fleet status (read-only fleet aggregation) tool ─────────
  // Milestone P0 of the multi-bead fleet supervisor (docs/fleet-orchestrator.md):
  // a scheduler's observation view, never a phase worker. It reads every
  // worktree's `.belayd/workflow.json` + run manifests plus the optional fleet
  // intent file, writes nothing, spawns nothing, merges nothing, and arms no
  // gate. Listed in GATED_TOOLS only to survive the process gate — never a
  // required workflow step, and never in PLANNING_GATED_TOOLS.
  //
  // Bead metadata comes from one batched read-only `bd show <ids> --json`.
  // bd is an optional, frequently-absent dependency (no beads database, version
  // drift, slow server) and the workflow view is derived from workflow state,
  // so every failure degrades to "no bead metadata" plus exactly one
  // fleet-level warning instead of failing the call.
  async function readFleetBeads(status: FleetStatus, cwd: string): Promise<FleetBeadLookup> {
    return lookupFleetBeads({
      taskIds: fleetBeadTaskIds(status),
      cwd,
      runBd: (argv, options) => runBdCommand(argv, options),
    });
  }

  // Ownership/human columns (bd-153). Same task ids as the bead read, but two
  // extra best-effort read-only `bd` calls per bead (`comments --json`,
  // `gate list --json`). read-only: no bd write is issued on this path. A
  // per-bead failure degrades only that bead's columns to `unknown`; only when
  // every bead fails both reads is there one fleet-level warning.
  async function readFleetEngagement(
    status: FleetStatus,
    cwd: string,
  ): Promise<FleetEngagementLookup> {
    return lookupFleetBeadEngagement({
      taskIds: fleetBeadTaskIds(status),
      cwd,
      runBd: (argv, options) => runBdCommand(argv, options),
    });
  }

  /**
   * One bead's ownership/human section for `belayd_status` (bd-153).
   *
   * Undefined when the session records no task id, so a session without a
   * workflow prints exactly what it printed before. A bd that is absent or
   * failing renders one bounded `bead detail unavailable (bd read failed)` line
   * rather than throwing: `belayd_status` is the status surface a gated session
   * still has, so a read failure never fails the tool. When only the engagement
   * read failed, the title/status/owner columns already read from `bd show` are
   * still printed, so a partial read is not thrown away.
   */
  async function readBeadOwnership(taskId: string, cwd: string): Promise<string | undefined> {
    // Same shape guard as `fleetBeadTaskIds`: a recorded value starting with `-`
    // would reach bd argv as a flag, so it never reaches bd at all.
    if (taskId === "" || !isValidTaskId(taskId)) return undefined;
    // `show` and the comments/gate pair are independent, so they run together:
    // a hung bd costs one timeout instead of three sequential ones, and the
    // engagement reader already bounds its own pair.
    const [beadLookup, engagementLookup] = await Promise.all([
      findBead(taskId, cwd),
      lookupFleetBeadEngagement({
        taskIds: [taskId],
        cwd,
        runBd: (argv, options) => runBdCommand(argv, options),
      }),
    ]);
    if (!beadLookup.ok) {
      return formatBeadOwnership({ cwdTaskId: taskId, error: beadLookup.error });
    }
    const lowered = taskId.toLowerCase();
    const bead = beadLookup.beads.find((candidate) => candidate.id.toLowerCase() === lowered);
    if (!engagementLookup.ok) {
      return formatBeadOwnership({
        cwdTaskId: taskId,
        ...(bead === undefined ? {} : { bead }),
        error: engagementLookup.error,
      });
    }
    const engagement = engagementLookup.entries.find(
      (entry) => entry.taskId.toLowerCase() === lowered,
    )?.engagement;
    return formatBeadOwnership({
      cwdTaskId: taskId,
      ...(bead === undefined ? {} : { bead }),
      ...(engagement === undefined ? {} : { engagement }),
    });
  }

  function findBead(taskId: string, cwd: string): Promise<FleetBeadLookup> {
    return lookupFleetBeads({
      taskIds: [taskId],
      cwd,
      runBd: (argv, options) => runBdCommand(argv, options),
    });
  }

  // ── Tier-2 supervision seam (bd-189) ─────────────────────────────────
  //
  // The digest capability may not import any `src/fleet-*.ts` module, so the
  // fleet facts it needs are gathered here and handed over as plain data. It is
  // read-only by construction: one fleet status read, one `bd show`, one
  // `bd gate list`, and plain fs reads of that worktree's own `.belayd/`.

  /** The member the caller means: by task id, else by the worktree it is in. */
  function selectSupervisionMember(
    members: readonly FleetMemberView[],
    request: { taskId?: string; cwd: string },
  ): FleetMemberView | undefined {
    const requested = request.taskId?.trim() ?? "";
    if (requested !== "") return members.find((member) => member.taskId === requested);
    // A session inside a member worktree answers about its own member.
    const cwd = resolve(request.cwd);
    return members.find((member) => resolve(member.worktreePath) === cwd);
  }

  /**
   * The bd waits blocking one member.
   *
   * `createdAt` is what makes the gate age computable, which is why this is a
   * direct gate read instead of the engagement view (that one reports the wait
   * but not its age). A failed read is reported, never rendered as "no gate".
   */
  async function readSupervisionGates(taskId: string, cwd: string): Promise<SupervisionGateFacts> {
    const lookup = await lookupOpenHumanGate({
      beadId: taskId,
      cwd,
      runBd: (argv, options) => runBdCommand(argv, options),
    });
    if (!lookup.ok) return { readError: lookup.error };
    if (lookup.status === "open") {
      const createdAt = lookup.gate.createdAt;
      const createdAtMs = createdAt === undefined ? undefined : Date.parse(createdAt);
      return {
        humanGateId: lookup.gate.gateId,
        ...(createdAtMs === undefined || Number.isNaN(createdAtMs)
          ? {}
          : { humanGateCreatedAtMs: createdAtMs }),
      };
    }
    if (lookup.status === "unrecognized") {
      return { readError: "bd returned gate records that did not parse" };
    }
    return lookup.orderingBlocker === undefined ? {} : { orderingBlocker: lookup.orderingBlocker };
  }

  async function readSupervisionInput(request: {
    taskId?: string;
    cwd: string;
  }): Promise<SupervisionInputResult> {
    const status = readFleetStatus({ cwd: request.cwd, fleetId: DEFAULT_FLEET_ID });
    if (!status.ok) return { ok: false, error: `fleet read failed: ${status.error}` };
    const member = selectSupervisionMember(status.value.members, request);
    if (member === undefined) {
      return { ok: false, error: unknownSupervisionMemberError(status.value.members, request) };
    }
    const taskId = member.taskId;
    if (taskId === undefined) {
      return {
        ok: false,
        error: `${member.worktreePath} holds no readable workflow state, so it has no task id to digest`,
      };
    }

    return {
      ok: true,
      member: await collectSupervisionFacts(member, taskId, request.cwd),
    };
  }

  /** All the per-member reads one digest needs, in one parallel batch. */
  async function collectSupervisionFacts(
    member: FleetMemberView,
    taskId: string,
    cwd: string,
  ): Promise<SupervisionMemberFacts> {
    const [gates, beadLookup, branchHeadCommitAt] = await Promise.all([
      readSupervisionGates(taskId, cwd),
      findBead(taskId, cwd),
      readBranchHeadCommitAt(member.worktreePath),
    ]);
    return supervisionMemberFacts({
      member,
      taskId,
      gates,
      runs: supervisionRuns(member.worktreePath, taskId),
      telemetry: readModelTelemetry({ cwd: member.worktreePath }),
      bead: beadLookup.ok ? findBeadById(beadLookup.beads, taskId) : undefined,
      beadError: beadLookup.ok ? undefined : beadLookup.error,
      branchHeadCommitAt,
    });
  }
  /** Bounded "which member did you mean" refusal, naming what the fleet does hold. */
  function unknownSupervisionMemberError(
    members: readonly FleetMemberView[],
    request: { taskId?: string; cwd: string },
  ): string {
    const known = members
      .flatMap((candidate) => (candidate.taskId === undefined ? [] : [candidate.taskId]))
      .slice(0, 12);
    const wanted = request.taskId?.trim() ?? "";
    const head =
      wanted === ""
        ? "this directory is not a fleet member worktree"
        : `no fleet member records task id ${wanted}`;
    const tail =
      known.length === 0 ? "the fleet has no members" : `known members: ${known.join(", ")}`;
    return `${head}; ${tail}`;
  }

  /**
   * The newest commit instant on the member's branch, from one read-only call.
   *
   * `git log -1` never writes, and this is the digest's "no commits" evidence:
   * a phase that has been running for an hour without a commit looks identical
   * to a hung one in every `.belayd/` file. An unreadable branch (detached HEAD
   * with no commits, a deleted worktree) simply drops this input.
   */
  async function readBranchHeadCommitAt(worktreePath: string): Promise<number | undefined> {
    try {
      const { stdout } = await runGitCommand(["log", "-1", "--format=%ct", "HEAD"], {
        cwd: worktreePath,
        timeoutInMs: 15_000,
        maxBufferInBytes: 64 * 1024,
      });
      const seconds = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(seconds) ? seconds * 1000 : undefined;
    } catch {
      // No branch, no commits, or no git: the digest loses one progress input.
      return undefined;
    }
  }

  /** The bead columns, or the reason they are unknown. */
  function beadFactsOf(input: {
    bead: FleetBead | undefined;
    beadError: string | undefined;
  }): Pick<SupervisionMemberFacts, "bead" | "beadError"> {
    if (input.bead === undefined) {
      return input.beadError === undefined ? {} : { beadError: input.beadError };
    }
    return {
      bead: {
        ...(input.bead.title === undefined ? {} : { title: input.bead.title }),
        ...(input.bead.status === undefined ? {} : { status: input.bead.status }),
      },
    };
  }

  /** The spend section, absent when the worktree has no telemetry file. */
  function telemetryFactsOf(
    telemetry: ReturnType<typeof readModelTelemetry>,
  ): Pick<SupervisionMemberFacts, "telemetry"> {
    return telemetry === undefined
      ? {}
      : { telemetry: { stats: telemetry.stats, totals: telemetry.totals } };
  }

  /**
   * Assemble the digest's plain-data view of one member.
   */
  function supervisionMemberFacts(input: {
    member: FleetMemberView;
    taskId: string;
    gates: SupervisionGateFacts;
    runs: SupervisionRunFacts[];
    telemetry: ReturnType<typeof readModelTelemetry>;
    bead: FleetBead | undefined;
    beadError: string | undefined;
    branchHeadCommitAt: number | undefined;
  }): SupervisionMemberFacts {
    const { member, taskId, gates, runs, telemetry, bead, beadError, branchHeadCommitAt } = input;
    return {
      taskId,
      worktreePath: member.worktreePath,
      ...(member.branch === undefined ? {} : { branch: member.branch }),
      memberState: member.state,
      phaseOrder: member.phaseOrder,
      completedPhases: member.completedPhases,
      pendingPhases: member.pendingPhases,
      awaitingReviewResponse: member.awaitingReviewResponse,
      ...(member.updatedAt === undefined ? {} : { updatedAt: member.updatedAt }),
      lease: member.lease,
      gates,
      runs,
      ...beadFactsOf({ bead, beadError }),
      ...(branchHeadCommitAt === undefined ? {} : { branchHeadCommitAt }),
      ...telemetryFactsOf(telemetry),
    };
  }

  /**
   * This member's own run manifests, reduced to what the digest renders.
   */
  function supervisionRuns(worktreePath: string, taskId: string): SupervisionRunFacts[] {
    return listRuns({ cwd: worktreePath })
      .filter((run) => run.taskId === taskId)
      .map((run) => ({
        phase: run.phase,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
        ...(run.failureReason === undefined ? {} : { failureReason: run.failureReason }),
      }));
  }

  // ── Fleet supervisor (bd-126 P1–P4): launch, mailbox, merge, pause, reconcile ──
  //
  // The supervisor is a scheduler: it arms no gate, runs no phase, and owns no
  // worktree. Its only authority is the fleet family below, and every action it
  // takes across worktrees is appended to `<fleet>/audit.log`. Nothing here merges,
  // advances a wave, pauses, or mutates a bead on its own: each of those is an
  // explicit, audited call.

  /** `<git-common-dir>` for a session's directory, or an error value. */
  function gitCommonDirFor(
    cwd: string,
  ): { ok: true; gitCommonDir: string } | { ok: false; error: string } {
    const resolved = resolveGitCommonDir(cwd);
    return resolved.ok ? { ok: true, gitCommonDir: resolved.commonDir } : resolved;
  }

  /**
   * The fleet this session supervises, or undefined.
   *
   * Derived from `fleet.json` on every call (session id + live, unchanged
   * supervisor process + the arm token this session minted), so no in-memory flag
   * can survive a lifecycle reset and a record left or planted by another writer
   * cannot put this session into fleet mode. The token is the only piece that is
   * not on disk: a corrupt or malicious `fleet.json` cannot guess it.
   */
  function fleetModeFor(ctx: ExtensionContext): FleetMode | undefined {
    const common = gitCommonDirFor(ctx.cwd);
    if (!common.ok) return undefined;
    const state = getSessionState(ctx);
    return resolveFleetMode({
      gitCommonDir: common.gitCommonDir,
      sessionId: ctx.sessionManager.getSessionId(),
      isPidAlive: isProcessAlive,
      pidStartTime: readProcessStartTime,
      ...(state.fleetArm === undefined ? {} : { armToken: state.fleetArm }),
    });
  }

  /** The fleet a member task belongs to (member → fleet lookup by task id). */
  function memberFleetFor(ctx: ExtensionContext, taskId: string): FleetMode | undefined {
    const common = gitCommonDirFor(ctx.cwd);
    if (!common.ok) return undefined;
    return resolveMemberFleet({ gitCommonDir: common.gitCommonDir, taskId });
  }

  /** Append one cross-tree audit entry; a failure is reported, never swallowed. */
  function auditFleetAction(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    fleetId: string;
    action: string;
    taskIds: readonly string[];
    detail: string;
  }): void {
    const appended = appendFleetAuditEntry({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
      entry: {
        timestamp: Date.now(),
        fleetId: options.fleetId,
        actor: options.ctx.sessionManager.getSessionId(),
        action: options.action,
        taskIds: [...options.taskIds],
        detail: options.detail,
      },
    });
    if (appended.ok) return;
    // Cross-tree authority must be auditable; an unlogged action is a bug the
    // operator has to see, not a detail.
    options.ctx.ui.notify(
      `Fleet ${options.fleetId}: could not append to audit.log (${appended.error}).`,
      "warning",
    );
    console.warn(`[belayd-harness] failed to append fleet audit entry: ${appended.error}`);
  }

  // ── P5: one orchestrator per worktree ─────────────────────────────
  //
  // A worktree lease is the only liveness signal that survives the pi-web session
  // model: orchestrators are sessions inside the daemon, so they have no per-process
  // argv token, and a completed workflow deletes the state file the older guards
  // used. The lease is created by the spawner, adopted by the session on start, and
  // renewed by this session's own timer until it shuts down.

  /** Renew this session's worktree lease. */
  function renewSessionOrchestratorLease(options: {
    state: FleetState;
    sessionId: string;
    worktreePath: string;
  }): void {
    const renewed = heartbeatOrchestratorClaim({
      worktreePath: options.worktreePath,
      sessionId: options.sessionId,
      now: Date.now(),
    });
    if (!renewed.ok) {
      // The lease is the authority to drive this worktree. Once it is gone (taken
      // over, deleted, or unwritable) this session must stop being an orchestrator:
      // the gate is disarmed, so phase tools refuse instead of racing the session
      // that now holds the lease. Losing the lease is a human-visible event, not a
      // log line.
      stopOrchestratorLeaseTimer(options.state);
      options.state.heldLeaseSessionId = undefined;
      options.state.orchestratorLeaseRefusal =
        `This session lost the orchestrator lease for ${options.worktreePath} (${renewed.error}); ` +
        "phase tools are disabled here so two sessions cannot drive one worktree.";
      options.state.gateActive = false;
      // Losing the lease means this session is no longer the orchestrator; the
      // new driver re-discovers the human gate from bd (bd-152).
      clearHumanAnswerWait(options.state);
      applyToolGate(options.state);
      console.warn(`[belayd-harness] ${options.state.orchestratorLeaseRefusal}`);
    }
  }

  function stopOrchestratorLeaseTimer(state: CoreSessionState): void {
    stopOrchestratorLeaseHeartbeat(state);
  }

  function startOrchestratorLeaseHeartbeat(options: {
    state: FleetState;
    sessionId: string;
    worktreePath: string;
  }): void {
    stopOrchestratorLeaseTimer(options.state);
    const timer = setInterval(
      () =>
        renewSessionOrchestratorLease({
          state: options.state,
          sessionId: options.sessionId,
          worktreePath: options.worktreePath,
        }),
      ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS,
    );
    // Never keep a pi process alive just to renew a lease.
    timer.unref();
    options.state.orchestratorLeaseTimer = timer;
  }

  /**
   * Become this worktree's orchestrator, or explain who already is.
   *
   * Runs before the process gate can arm: a session that loses this race must not
   * look like an orchestrator at all, or two sessions drive one `.belayd/` ledger.
   */
  function claimWorktreeOrchestrator(options: {
    ctx: ExtensionContext;
    state: FleetState;
    worktreePath: string;
    taskId: string;
    branch: string;
  }): { ok: true } | { ok: false; error: string } {
    const sessionId = options.ctx.sessionManager.getSessionId();
    const adopted = adoptOrchestratorClaim({
      worktreePath: options.worktreePath,
      taskId: options.taskId,
      branch: options.branch,
      sessionId,
      pid: process.pid,
      now: Date.now(),
    });
    if (!adopted.ok) {
      return {
        ok: false,
        error:
          `Refusing to drive ${options.taskId} in ${options.worktreePath}: ${adopted.error}. ` +
          "One orchestrator per worktree: finish or stop that session, or remove its " +
          "`.belayd/orchestrator.json` once it is gone.",
      };
    }
    if (adopted.adopted === "stale" || adopted.adopted === "corrupt") {
      options.ctx.ui.notify(
        `Took over an abandoned orchestrator lease for ${options.taskId} in ${options.worktreePath}` +
          (adopted.archivedPath === undefined
            ? "."
            : ` (previous record archived at ${adopted.archivedPath}).`),
        "warning",
      );
    }
    options.state.heldLeaseSessionId = sessionId;
    startOrchestratorLeaseHeartbeat({
      state: options.state,
      sessionId,
      worktreePath: options.worktreePath,
    });
    return { ok: true };
  }

  /** Remove this session's lease on shutdown (best effort, never throws). */
  function releaseSessionOrchestratorLease(
    state: CoreSessionState,
    sessionId: string,
    cwd: string,
  ): void {
    stopOrchestratorLeaseTimer(state);
    state.heldLeaseSessionId = undefined;
    const released = releaseOrchestratorClaim({ worktreePath: cwd, sessionId });
    if (!released.ok) {
      console.warn(
        `[belayd-harness] could not release the orchestrator lease in ${cwd}: ${released.error}`,
      );
    }
  }

  // ── P5: run-until-complete loop ───────────────────────────────────

  /** Whether a lease verdict is fresh; used by reconcile and the tick. */
  function leaseProbeFor(
    worktreePath: string,
    now: number,
    sessionId?: string,
  ): FleetMemberLeaseProbe {
    // One rule with the status view: a fresh `pending:` spawn claim is live, a
    // stale one is unclassifiable (never absent), and the rest follows the lease
    // verdict (bd-166).
    return classifyMemberLease({
      read: readOrchestratorClaim({ worktreePath }),
      now,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  /**
   * `taskId → launchedAt` from one fleet's run record.
   *
   * An unreadable or absent fleet simply records no launch: the worktree creation
   * instant is still a cutoff, and no cutoff keeps the member counted (bd-166).
   */
  function recordedLaunches(options: {
    gitCommonDir: string | undefined;
    fleetId: string;
  }): ReadonlyMap<string, number> {
    const launches = new Map<string, number>();
    if (options.gitCommonDir === undefined) return launches;
    const loaded = readFleetIntent({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
    });
    if (!loaded.ok || loaded.intent === undefined) return launches;
    for (const member of loaded.intent.run?.members ?? []) {
      launches.set(member.taskId, member.launchedAt);
    }
    return launches;
  }

  /**
   * Per-member orchestrator liveness for the capacity count (bd-166).
   *
   * One process snapshot per launch — so two members cannot see two different
   * process tables — plus each member's own worktree lease, because a pi-web
   * orchestrator is a session inside the daemon and never appears in argv. The
   * classification is the reconcile path's, reused rather than re-derived, so the
   * capacity count and a repair read the same evidence. They deliberately differ on
   * one verdict: a member with no worktree is `unknown` (counted) here, because a
   * launch may be creating it, while reconcile needs positive `absent` evidence
   * before it prunes (it reads such a member as absent, which is its documented
   * escape hatch). Capacity errs to counted; pruning errs to keeping the record.
   */
  function memberLivenessProbe(
    ctx: ExtensionContext,
    /** `<git-common-dir>` for the launch cutoff's intent reads; both callers have it. */
    gitCommonDir: string | undefined,
  ): (fleetId: string, taskId: string) => FleetMemberLiveness {
    const scan = scanProcesses();
    const launchedAtFor = memberLaunchReader(gitCommonDir);
    return (fleetId: string, taskId: string): FleetMemberLiveness => {
      // The worktree is keyed by the task id; the fleet id keys the recorded launch
      // that bounds the evidence cutoff.
      const worktreePath = resolveWorktreePath(ctx.cwd, `feat/${taskId}`);
      // A worktree with no evidence its session existed is a launch mid-spawn (the
      // state is persisted after the worktree is ready), so absence only means gone
      // once the member has something proving it was real (bd-166). Completion
      // deletes the state file, so the evidence is that file *or* a run manifest this
      // execution wrote — never an inherited same-task manifest, hence the cutoff.
      const since = memberSince({
        worktreePath,
        launchedAt: launchedAtFor(fleetId, taskId),
      });
      const memberRan =
        worktreePath !== undefined &&
        memberRanEvidence({
          taskId,
          workflowStatePresent: existsSync(workflowStateFilePath(worktreePath)),
          runs: listRuns({ cwd: worktreePath }),
          ...(since === undefined ? {} : { since }),
        });
      return classifyMemberLivenessInWorktree({
        taskId,
        worktreePath,
        memberRanEvidence: memberRan,
        scan,
        selfPid: process.pid,
        ...(worktreePath === undefined ? {} : { lease: leaseProbeFor(worktreePath, Date.now()) }),
      });
    };
  }

  /**
   * `launchedAt` per recorded member, read once per fleet for the evidence cutoff.
   *
   * The plan read and the in-write recount both ask about the same members, so each
   * fleet's `fleet.json` is read once per probe rather than once per member. A fleet
   * that cannot be read simply has no recorded launch: the worktree's creation
   * instant is still a cutoff, and no cutoff at all keeps the member counted.
   */
  function memberLaunchReader(
    gitCommonDir: string | undefined,
  ): (fleetId: string, taskId: string) => number | undefined {
    const byFleet = new Map<string, ReadonlyMap<string, number>>();
    return (fleetId: string, taskId: string): number | undefined => {
      const cached = byFleet.get(fleetId);
      const launches = cached ?? recordedLaunches({ gitCommonDir, fleetId });
      if (cached === undefined) byFleet.set(fleetId, launches);
      return launches.get(taskId);
    };
  }

  /**
   * The launch-evidence cutoff for one member (bd-166).
   *
   * The newer of the worktree's creation instant and the run's recorded launch, or
   * undefined when neither is known (which makes a same-task manifest non-evidence).
   */
  function memberSince(options: {
    worktreePath: string | undefined;
    launchedAt: number | undefined;
  }): number | undefined {
    const created =
      options.worktreePath === undefined ? undefined : worktreeCreatedAt(options.worktreePath);
    return memberEvidenceCutoff({
      ...(created === undefined ? {} : { worktreeCreatedAt: created }),
      ...(options.launchedAt === undefined ? {} : { launchedAt: options.launchedAt }),
    });
  }

  /**
   * The worktree directory's creation instant, or undefined when it cannot be read.
   *
   * A failed stat means "no cutoff", which makes a same-task manifest non-evidence
   * rather than freeing the slot of a spawn in flight (bd-166).
   */
  function worktreeCreatedAt(worktreePath: string): number | undefined {
    try {
      return worktreeCreatedAtFromStat(statSync(worktreePath));
    } catch {
      return undefined;
    }
  }

  /**
   * One compare-and-replace intent update, with a single retry on a lost race.
   *
   * Returns the record that was written, so a caller whose audit entry describes the
   * result (the readoption sweep, bd-169) reports the post-CAS values rather than the
   * snapshot it decided from.
   */
  function mutateFleetIntent(options: {
    gitCommonDir: string;
    fleetId: string;
    mutate: (intent: FleetIntent) => FleetIntent | { refuse: string };
  }): { ok: true; intent: FleetIntent } | { ok: false; error: string } {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = updateFleetIntent({
        gitCommonDir: options.gitCommonDir,
        fleetId: options.fleetId,
        update: (current) =>
          current === undefined
            ? { refuse: `no fleet intent for \`${options.fleetId}\`` }
            : options.mutate(current),
      });
      if (result.ok) return { ok: true, intent: result.intent };
      if (result.reason !== "conflict") return { ok: false, error: result.error };
    }
    return { ok: false, error: "the fleet intent changed twice while updating it" };
  }

  /** Read every member's workflow progress plus its orchestrator lease. */
  async function readFleetMemberObservations(options: {
    cwd: string;
    intent: FleetIntent;
    run: FleetRun;
    now: number;
  }): Promise<FleetMemberObservation[]> {
    // Bounded fan-out: each member may cost one bd gate read, and one hung read
    // must not serialise the rest of the tick (bd-219 review).
    return readMemberObservationsBounded({
      taskIds: options.intent.taskIds,
      observe: (taskId) =>
        observeFleetMember({ cwd: options.cwd, taskId, run: options.run, now: options.now }),
    });
  }

  /** Read one member's workflow progress and orchestrator lease from its worktree. */
  async function observeFleetMember(options: {
    cwd: string;
    taskId: string;
    run: FleetRun;
    now: number;
  }): Promise<FleetMemberObservation> {
    const launchedAt = options.run.members?.find(
      (member) => member.taskId === options.taskId,
    )?.launchedAt;
    const launched = launchedAt === undefined ? {} : { launchedAt };
    const worktreePath = resolveWorktreePath(options.cwd, `feat/${options.taskId}`);
    if (worktreePath === undefined) {
      return {
        taskId: options.taskId,
        progress: { kind: "missing", detail: `no worktree holds feat/${options.taskId}` },
        claim: "absent",
        humanGateOpen: false,
        ...launched,
      };
    }
    const state = readWorkflowState({ cwd: worktreePath });
    const runs = listRuns({ cwd: worktreePath });
    // Skip the bd spawn when the workflow state is unreadable: progress from a
    // missing state can never be `awaiting-human`, so the read would have no
    // consumer (bd-219 review). A worktree-less member already returned above.
    const humanGateOpen =
      state === undefined
        ? false
        : await readMemberHumanGate({ taskId: options.taskId, worktreePath });
    const workflow: FleetWorkflowProgressSnapshot =
      state === undefined
        ? { kind: "missing" }
        : {
            kind: "ok",
            completedPhaseNames: state.completedPhaseNames,
            phaseOrder: state.phaseOrder,
          };
    const progress = deriveFleetMemberProgress({
      taskId: options.taskId,
      workflow,
      runs,
      now: options.now,
      ...(state === undefined ? {} : { phaseOrder: state.phaseOrder }),
      ...launched,
      humanGateOpen,
    });
    const probe = leaseProbeFor(worktreePath, options.now);
    const claim: FleetMemberClaim =
      probe.state === "live" ? "live" : probe.state === "corrupt" ? "corrupt" : probe.state;
    return { taskId: options.taskId, progress, claim, humanGateOpen, ...launched };
  }

  /**
   * Whether the member's bead has an open bd `human` gate (bd-219).
   *
   * Best-effort and silent on failure: one tick's bd read failing must not become
   * a warning every 15 s, and an unread gate is "unknown", never a wait (a member
   * wrongly read as waiting would hold the run under the 12 h human cap instead of
   * the 1 h stall cap). An ordering gate is not this member's own wait either, so
   * `lookupOpenHumanGate` reports it separately and it stays `false` here.
   */
  async function readMemberHumanGate(options: {
    taskId: string;
    worktreePath: string;
  }): Promise<boolean> {
    const lookup = await lookupOpenHumanGate({
      beadId: options.taskId,
      cwd: options.worktreePath,
      runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
    });
    return lookup.ok && lookup.status === "open";
  }

  /** Add freshly launched members to the run record (pure; the tick persists it). */
  function extendRunWithLaunches(options: {
    run: FleetRun;
    outcomes: readonly FleetMemberLaunchOutcome[];
    now: number;
  }): FleetRun {
    return options.outcomes
      .filter((outcome) => outcome.ok)
      .reduce(
        (run, outcome) =>
          recordRunMemberLaunched({
            run,
            taskId: outcome.taskId,
            launchedAt: options.now,
            ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
          }),
        options.run,
      );
  }

  /** Persist the run record after a tick. */
  function persistFleetRun(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    run: FleetRun;
    now: number;
  }): void {
    const written = mutateFleetIntent({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      mutate: (intent) => ({ ...intent, run: options.run, updatedAt: options.now }),
    });
    if (!written.ok) {
      options.ctx.ui.notify(`Fleet ${options.mode.fleetId}: ${written.error}`, "warning");
    }
  }

  /**
   * Drop a landed member from the fleet's member list and its deferred plan.
   *
   * Landing is the one automatic path allowed to forget a member: its branch is on
   * the base branch, so nothing is left to observe or land. A stop keeps the member
   * (see {@link retireDeferredMember}): its worktree and bead are still live.
   */
  function pruneLandedMember(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    now: number;
  }): { ok: true } | { ok: false; error: string } {
    return mutateFleetIntent({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      mutate: (intent) => pruneLandedFleetMember(intent, options.taskId, options.now),
    });
  }

  /**
   * Retire a stopped member's deferral entry, keeping it a fleet member.
   *
   * The member must stay in `taskIds`: its worktree, branch, and bead still exist,
   * `run.stopped` explains why it needs a human, and the loop still lands it if its
   * own retry finished the work. Only the plan entry goes, so an advance cannot
   * relaunch a member the run gave up on.
   */
  function retireDeferredMember(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    now: number;
  }): { ok: true } | { ok: false; error: string } {
    return mutateFleetIntent({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      mutate: (intent) => retireFleetDeferral(intent, options.taskId, options.now),
    });
  }

  /**
   * The beads bd reports `closed`/`done` (the wait is moot), from a bead read that
   * has already been proven complete (see `reapClosedBeadGates`).
   */
  function closedBeadsOf(beads: readonly { id: string; status?: string }[]): ReadonlySet<string> {
    return new Set(
      beads
        .filter((bead) => bead.status === "closed" || bead.status === "done")
        .map((bead) => bead.id),
    );
  }

  /**
   * Resolve the bd ordering gates that touch `taskId`, then forget them (bd-158).
   *
   * Called on a landing (the merge satisfied every dependent's wait) and wherever
   * the fleet learns that a bead or member is gone. A gate is only meaningful
   * while both its beads are live members, and an open gate with no member is the
   * one orphan this design must never leave behind: nothing would ever resolve it.
   *
   * `beadId` matches either side, because both directions end the gate's purpose:
   * the blocker landing releases the dependent, and the dependent closing makes the
   * wait moot.
   */
  async function releaseOrderingGatesForBead(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    now: number;
  }): Promise<{ ok: true; resolved: number } | { ok: false; error: string }> {
    const loaded = readFleetIntent({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
    });
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const recorded = loaded.intent?.orderingGates ?? [];
    const touching = recorded.filter(
      (gate) => gate.blocker === options.taskId || gate.blocked === options.taskId,
    );
    if (touching.length === 0) return { ok: true, resolved: 0 };

    const resolved = await resolveFleetOrderingGatesForBead({
      gates: touching,
      beadId: options.taskId,
      cwd: options.ctx.cwd,
      runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
    });
    // Drop only the records bd confirmed, and by *gate id*: another gate of this
    // same member may still be open (a shared blocker with two dependents), and
    // forgetting it would leave it open with nothing able to resolve it. A failed
    // bookkeeping write is self-healing: the record survives, and the next reap
    // sees bd report the gate as gone (`gate not found`) and drops it then.
    const gateIds = resolved.resolved.map((gate) => gate.gateId);
    if (gateIds.length > 0) {
      mutateFleetIntent({
        gitCommonDir: options.mode.gitCommonDir,
        fleetId: options.mode.fleetId,
        mutate: (intent) => dropFleetOrderingGates(intent, gateIds, options.now),
      });
      auditFleetAction({
        ctx: options.ctx,
        gitCommonDir: options.mode.gitCommonDir,
        fleetId: options.mode.fleetId,
        action: "ordering-gates-resolved",
        taskIds: [options.taskId],
        detail: `${gateIds.length} gate(s): ${resolved.resolved
          .map((gate) => `${gate.blocker}->${gate.blocked} (${gate.gateId})`)
          .join(", ")}`,
      });
    }
    return resolved.ok
      ? { ok: true, resolved: resolved.resolved.length }
      : {
          ok: false,
          error:
            `could not resolve the ordering gate(s) for ${options.taskId}: ${resolved.error}` +
            ` (${resolved.remaining.length} still recorded)`,
        };
  }

  /** Land one finished member: merge, accept, and drop it from the member list. */
  async function landFleetMember(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    intent: FleetIntent;
    run: FleetRun;
    taskId: string;
    now: number;
  }): Promise<
    { ok: true; run: FleetRun; lines: readonly string[] } | { ok: false; error: string }
  > {
    const { ctx, mode, taskId, now } = options;
    const merged = await mergeLandedMember({ ctx, mode, taskId, now });
    if (!merged.ok) return merged;

    // The landing is recorded before anything else can fail, because it is the one
    // fact bd cannot express and the scheduler's `fleetLandedTaskIds` rule needs
    // (bd-158). A merge that succeeded must never look unlanded: that would hold
    // the member's capacity slot and stall its dependents on an event that already
    // happened.
    const pruned = pruneLandedMember({ ctx, mode, taskId, now });
    if (!pruned.ok) return { ok: false, error: pruned.error };
    const landed = recordRunMemberLanded({ run: options.run, taskId, now });
    auditFleetAction({
      ctx,
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      action: "fleet-landed",
      taskIds: [taskId],
      detail: `merged ${taskId} into ${mode.intent.baseBranch}`,
    });

    const accepted = await acceptLandedMemberOnDisk({
      ctx,
      mode,
      taskId,
      accept: options.run.accept === true,
      now,
    });
    // bd-158: the landing, not a close, is what releases a dependent's ordering
    // gate — so it is resolved after the land is recorded, and a failure is a
    // *retryable* warning rather than a stop: the merge cannot be undone, the
    // dependent is already released on the fleet side, and the tick reaper
    // retries the resolve from the still-recorded gate (the landed member is no
    // longer a member, which is exactly the orphan case it reaps). Stopping here
    // would end the run `partial` on a transient bd failure and wedge a merged
    // member forever.
    const gateLines = await resolveLandedOrderingGates({ ctx, mode, taskId, now });

    if (!accepted.ok) {
      // The work landed, so the member is out of the member list; only the bead
      // (or the worktree) still needs a human, which is what the stop records.
      return {
        ok: true,
        run: recordRunMemberStopped({
          run: landed,
          taskId,
          reason: "accept-failed",
          detail: accepted.text,
          now,
        }),
        lines: [`Fleet ${mode.fleetId}: ${accepted.text}`, ...gateLines],
      };
    }
    return {
      ok: true,
      run: landed,
      lines: [`Fleet ${mode.fleetId}: ${accepted.text}`, ...gateLines],
    };
  }

  /**
   * Resolve the ordering gates a just-landed member released, reporting failures.
   *
   * Deliberately not fatal: the reaper owns the retry. The queue entry for this
   * member is already `merged`, so a later land attempt for the same member returns
   * immediately in `mergeLandedMember` and only this resolve runs again — a second
   * merge of the same member is impossible by construction, not by hope.
   */
  async function resolveLandedOrderingGates(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    now: number;
  }): Promise<readonly string[]> {
    const released = await releaseOrderingGatesForBead(options);
    if (released.ok) return [];
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      action: "ordering-gate-unresolved",
      taskIds: [options.taskId],
      detail: released.error,
    });
    return [
      `Fleet ${options.mode.fleetId}: landed ${options.taskId} but could not resolve its ordering ` +
        `gate(s): ${released.error} — the tick reaper retries; \`bd gate list\` shows them`,
    ];
  }

  /** Queue and drain one member's merge; a failure here is a `land-failed` stop. */
  async function mergeLandedMember(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    now: number;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = memberQueueEntry(options.mode, options.taskId);
    // A member whose queue entry already says `merged` landed on an earlier tick
    // (or before a supervisor restart); re-merging it would re-run the gates.
    if (entry?.state === "merged") return { ok: true };
    if (entry === undefined) {
      const queued = enqueueMemberMerge(options);
      if (!queued.ok) return queued;
    }
    return drainMemberMerge(options);
  }

  function memberQueueEntry(mode: FleetMode, taskId: string): FleetMergeQueueEntry | undefined {
    const queue = readFleetMergeQueue({ gitCommonDir: mode.gitCommonDir, fleetId: mode.fleetId });
    return queue.ok
      ? (queue.queue?.entries ?? []).find((candidate) => candidate.taskId === taskId)
      : undefined;
  }

  function enqueueMemberMerge(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    now: number;
  }): { ok: true } | { ok: false; error: string } {
    const branch = memberMergeBranch(options.ctx.cwd, options.taskId);
    if (!branch.ok) return { ok: false, error: branch.error };
    const queued = enqueueFleetMerge({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      sessionId: options.ctx.sessionManager.getSessionId(),
      taskId: options.taskId,
      branch: branch.branch,
      now: options.now,
    });
    return queued.ok
      ? { ok: true }
      : { ok: false, error: `merge enqueue refused: ${queued.error}` };
  }

  async function drainMemberMerge(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    now: number;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const drained = await drainFleetMerge({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      sessionId: options.ctx.sessionManager.getSessionId(),
      pid: process.pid,
      rootCwd: options.ctx.cwd,
      taskId: options.taskId,
      now: options.now,
    });
    for (const warning of drained.warnings) {
      options.ctx.ui.notify(warning, "warning");
      console.warn(`[belayd-harness] ${warning}`);
    }
    return drained.ok ? { ok: true } : { ok: false, error: formatDrainResultText(drained) };
  }

  /** Accept a landed member: close its bead (when enabled) and remove its worktree. */
  async function acceptLandedMemberOnDisk(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    accept: boolean;
    now: number;
  }): Promise<{ ok: boolean; text: string }> {
    const { ctx, mode, taskId } = options;
    const worktreePath = resolveWorktreePath(ctx.cwd, `feat/${taskId}`);
    const branch = readWorktreeBranch(worktreePath ?? ctx.cwd);
    const accepted = await acceptLandedMember({
      rootCwd: ctx.cwd,
      taskId,
      branch: branch.ok ? branch.branch : `feat/${taskId}`,
      worktreePath: worktreePath ?? "",
      baseBranch: mode.intent.baseBranch,
      closeBead: options.accept,
      removeWorktree: worktreePath !== undefined,
      now: options.now,
      git: (argv, runnerOptions) => runGitCommand(argv, runnerOptions),
      runBd: (argv, runnerOptions) => runBdCommand(argv, { ...runnerOptions, stdin: undefined }),
    });
    for (const warning of accepted.warnings) {
      ctx.ui.notify(warning, "warning");
      console.warn(`[belayd-harness] ${warning}`);
    }
    // bd-158: an accepted (closed) bead ends every ordering gate that touched it.
    // The landing already released them; this covers a record written before the
    // gate was resolved (and is idempotent when there is nothing left).
    if (options.accept && accepted.ok) {
      await releaseGatesAfterMerge({ ctx, mode, taskId, now: options.now });
    }
    return { ok: accepted.ok, text: accepted.text };
  }

  /** Why a tick ended the run loop, so the caller can tell terminal from lost. */
  type FleetTickStopReason = "terminal" | "authority-lost" | "intent-lost";

  /** What one executed action produced, plus whether the loop must stop. */
  interface FleetTickOutcome {
    run: FleetRun;
    lines: readonly string[];
    stop: boolean;
    acted: boolean;
    /** Set when this action stopped the loop for a non-terminal reason (bd-169). */
    stopReason?: FleetTickStopReason;
  }

  interface FleetTickContext {
    ctx: ExtensionContext;
    mode: FleetMode;
    intent: FleetIntent;
    run: FleetRun;
    now: number;
    /** What this tick observed, for the terminal release sweep (bd-166). */
    observations: readonly FleetMemberObservation[];
    /**
     * The idle counter the plan decided on (bd-172): 0 when a member's progress
     * signature moved. Every idempotence guard on this path must read the same value,
     * or the capacity wait would halt on a counter the plan just reset.
     */
    idleTicks: number;
    /** The cap that counter is measured against, from the same `FleetTickProgress`. */
    maxIdleTicks: number;
  }

  /**
   * Give back the slots of members a terminal run can no longer land (bd-166).
   *
   * A finished or halted run is the end of the line: no tick will land its members
   * any more, so leaving them in the capacity count leaked the repository's 3
   * slots forever. This releases what provably holds nothing (see
   * `releaseRunMembers`) and is deliberately **not** a prune: the bead, worktree,
   * transcript, and mailbox stay, and the id stays in `taskIds`, so status, mail,
   * and a later landing still see it. A member whose work is complete stays
   * landable; a paused run is resumable and is never swept.
   *
   * The decision is re-made inside the compare-and-replace, because the release is
   * a cross-tree write and a concurrent writer may have landed or pruned a member
   * since this tick read the intent. The observations are still the ones this tick
   * took, so a member the tick never observed (just added by that concurrent
   * writer) is *not* released: `releaseRunMembers` requires evidence for every id
   * it frees (bd-166 review).
   */
  function releaseTerminalMembers(options: {
    context: FleetTickContext;
    reason: FleetMemberReleaseReason;
  }): readonly string[] {
    const released: string[] = [];
    const written = mutateFleetIntent({
      gitCommonDir: options.context.mode.gitCommonDir,
      fleetId: options.context.mode.fleetId,
      mutate: (current) => {
        const run = current.run ?? options.context.run;
        const plan = releaseRunMembers({
          intent: current,
          run,
          observations: options.context.observations,
          reason: options.reason,
          now: options.context.now,
        });
        released.length = 0;
        released.push(...plan.released);
        return plan.released.length === 0 ? current : plan.intent;
      },
    });
    const { ctx, mode } = options.context;
    if (!written.ok) {
      ctx.ui.notify(
        `Fleet ${mode.fleetId}: could not release the capacity slot(s) of the terminal members: ${written.error}`,
        "warning",
      );
      return [];
    }
    if (released.length === 0) return [];
    auditFleetAction({
      ctx,
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      action: "members-released",
      taskIds: released,
      detail:
        `${options.reason}: members that did not land no longer hold a capacity slot; ` +
        "beads, worktrees, and transcripts stay",
    });
    return [
      `Fleet ${mode.fleetId}: released the capacity slot(s) of ${released.join(", ")} ` +
        `(${options.reason}); the members stay for status and a later landing`,
    ];
  }

  async function executeFleetTickAction(
    options: FleetTickContext & { action: FleetTickAction },
  ): Promise<FleetTickOutcome> {
    switch (options.action.kind) {
      case "land":
        return landTickAction(options, options.action);
      case "stop":
        return stopTickAction(options, options.action);
      case "advance":
        return advanceTickAction(options);
      case "wait":
        return { run: options.run, lines: [], stop: false, acted: false };
      case "complete":
        return completeTickAction(options, options.action);
      case "halt":
        return haltTickAction(options, options.action);
    }
  }

  async function landTickAction(
    options: FleetTickContext,
    action: Extract<FleetTickAction, { kind: "land" }>,
  ): Promise<FleetTickOutcome> {
    const landed = await landFleetMember({
      ctx: options.ctx,
      mode: options.mode,
      intent: options.intent,
      run: options.run,
      taskId: action.taskId,
      now: options.now,
    });
    if (landed.ok) {
      return { run: landed.run, lines: landed.lines, stop: false, acted: true };
    }
    // A merge or gate refusal is not retried: the next tick would re-run the same
    // minutes of gating against the same failure. The member is stopped for a human
    // but stays a member — its worktree, branch, and bead are all still there, and
    // dropping it is what made a sibling's blocker look like an outsider.
    const retired = retireDeferredMember({
      ctx: options.ctx,
      mode: options.mode,
      taskId: action.taskId,
      now: options.now,
    });
    const fleetId = options.mode.fleetId;
    return {
      run: recordRunMemberStopped({
        run: options.run,
        taskId: action.taskId,
        reason: "land-failed",
        detail: landed.error,
        now: options.now,
      }),
      lines: [
        `Fleet ${fleetId}: could not land ${action.taskId}: ${landed.error}`,
        ...(retired.ok ? [] : [`Fleet ${fleetId}: ${retired.error}`]),
      ],
      stop: false,
      acted: true,
    };
  }

  function stopTickAction(
    options: FleetTickContext,
    action: Extract<FleetTickAction, { kind: "stop" }>,
  ): FleetTickOutcome {
    const { ctx, mode, now } = options;
    // A stop never prunes: the member keeps its worktree, branch, and bead, so the
    // registry must keep it for status, reconcile, and a later land. Only the plan
    // entry is retired, so an advance cannot relaunch it.
    const retired = retireDeferredMember({ ctx, mode, taskId: action.taskId, now });
    auditFleetAction({
      ctx,
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      action: "fleet-run-stopped",
      taskIds: [action.taskId],
      detail: `${action.reason}: ${action.detail}`,
    });
    return {
      run: recordRunMemberStopped({
        run: options.run,
        taskId: action.taskId,
        reason: action.reason,
        detail: action.detail,
        now,
      }),
      lines: [
        `Fleet ${mode.fleetId}: stopped ${action.taskId} (${action.reason}): ${action.detail}`,
        ...(retired.ok ? [] : [`Fleet ${mode.fleetId}: ${retired.error}`]),
      ],
      stop: false,
      acted: true,
    };
  }

  async function advanceTickAction(options: FleetTickContext): Promise<FleetTickOutcome> {
    const { ctx, mode, run, now } = options;
    const planned = planFleetAdvance({ fleetId: mode.fleetId, intent: options.intent });
    if (!planned.ok) {
      // `planFleetTick` halts a paused fleet before it can reach advance, so this is
      // unreachable today; completing instead of retrying keeps a refusal from
      // becoming the same per-tick churn if that invariant ever changes.
      return emptyAdvanceOutcome({ context: options, reason: planned.text, refused: true });
    }
    const advanced = await runFleetLaunch({
      ctx,
      taskIds: planned.worklist,
      fleetId: mode.fleetId,
      origin: "advance",
    });
    const outcomes = advanced.outcomes ?? [];
    // `outcomes.length` is not progress: an advance that only re-deferred the same
    // members produces outcomes too, and retrying that every tick re-plans the same
    // wave until the idle cap stalls the run an hour later. A real launch is what
    // resets idleTicks and schedules the next tick at the action interval.
    // A capacity-blocked advance reports `ok: true` with no outcomes (a plan that
    // was to wait is a success, W6), so `refused` only catches a genuine engine
    // refusal — which re-asking every tick would never fix either.
    if (!outcomes.some((outcome) => outcome.ok)) {
      return emptyAdvanceOutcome({
        context: options,
        text: advanced.text,
        refused: advanced.ok === false,
        // A hard refusal is the advance's own failure: it belongs in the durable line,
        // not only in the tick notification. A capacity-blocked advance is `ok: true`.
        ...(advanced.ok ? {} : { reason: advanced.text }),
      });
    }
    return {
      run: extendRunWithLaunches({ run, outcomes, now }),
      lines: outcomes.length === 0 ? [] : [`Fleet ${mode.fleetId}: ${advanced.text}`],
      stop: false,
      acted: true,
    };
  }

  /**
   * The advance's stop when the record it must re-read is gone or unreadable.
   *
   * A lost record, not a halt: it gets the tick's own loud treatment (bd-169) — audit
   * + console + a recovery command — and a `stopReason` so the caller reports it as a
   * warning instead of an info line. Extracted so `emptyAdvanceOutcome` stays a plan
   * mapper rather than a second stop reporter.
   */
  function emptyAdvanceLostRecordOutcome(options: {
    context: FleetTickContext;
    lines: readonly string[];
    lost: { kind: "gone" } | { kind: "unreadable"; error: string };
  }): FleetTickOutcome {
    const { mode } = options.context;
    const recovery = `\`/fleet ${mode.intent.taskIds.join(" ")} --fleet ${mode.fleetId}\``;
    const line = reportIntentLost({
      ctx: options.context.ctx,
      mode,
      fleetId: mode.fleetId,
      detail:
        options.lost.kind === "gone"
          ? "fleet.json vanished while the advance re-planned it"
          : `fleet.json could not be read: ${options.lost.error}`,
      line:
        options.lost.kind === "gone"
          ? `Fleet ${mode.fleetId}: run loop stopped — the fleet intent for \`${mode.fleetId}\` is ` +
            `gone, so nothing can advance this run. Re-arm with ${recovery}.`
          : `Fleet ${mode.fleetId}: run loop stopped — could not re-read the fleet intent ` +
            `(${options.lost.error}), so nothing is ticking this run. Recover the record, then ` +
            `re-arm with ${recovery}.`,
    });
    return {
      run: options.context.run,
      lines: [...options.lines, line],
      stop: true,
      acted: false,
      stopReason: "intent-lost",
    };
  }

  /**
   * Map an advance that launched nothing onto the action the plan would have reached.
   *
   * The deferrals are re-read because `runFleetLaunch` has already written the new
   * plan by the time it returns; the old intent would describe the wave before it
   * was re-planned. Capacity is not terminal (another fleet's slot frees itself),
   * so it waits, bounded by the same idle cap; every other reason ends the run as
   * `partial`.
   */
  function emptyAdvanceOutcome(options: {
    context: FleetTickContext;
    /** What the advance re-planned, kept as a leading line when non-empty. */
    text?: string;
    /** The advance's own failure text, when it refused to run at all. */
    reason?: string;
    /** The plan refused to advance, so capacity cannot free the wave either. */
    refused?: boolean;
  }): FleetTickOutcome {
    const { context } = options;
    const { mode } = context;
    const text = options.text ?? "";
    const lines = text.length > 0 ? [`Fleet ${mode.fleetId}: ${text}`] : [];
    const refreshed = readFleetIntent({
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
    });
    if (!refreshed.ok || refreshed.intent === undefined) {
      // Classifying from the pre-launch deferrals would read stale reasons (a
      // dependency that just became capacity, or the reverse), so the loop stops
      // instead of guessing — the same call `fleetTick` makes on an unreadable
      // intent. A read that succeeds with no record is that same hazard: the
      // launch engine has just written `fleet.json`, so an absent one was removed
      // mid-tick (reconcile, manual cleanup) and the pre-launch deferrals are the
      // plan the advance just replaced.
      return emptyAdvanceLostRecordOutcome({
        context,
        lines,
        lost: refreshed.ok ? { kind: "gone" } : { kind: "unreadable", error: refreshed.error },
      });
    }
    const action = emptyAdvanceAction({
      intent: context.intent,
      // The fresh record is authoritative: an absent `deferred` means nothing is
      // deferred, not "fall back to the plan the advance just replaced".
      deferred: refreshed.intent.deferred ?? [],
      reason: options.reason,
      refused: options.refused,
      // The tick's own counter, already reset when an observation moved this tick
      // (bd-172): the run record is the only durable one, and re-reading it here
      // would hash a decision the plan just made against stale evidence. The cap is
      // the same one the plan used, so no two guards can diverge.
      idleTicks: context.idleTicks,
      maxIdleTicks: context.maxIdleTicks,
    });
    switch (action.kind) {
      case "wait":
        // Capacity frees itself, so the run stays alive and keeps counting idle
        // ticks. `emptyAdvanceAction` turns that wait into `halt`/`stalled` at the
        // cap, because `planFleetTick` never reaches `idleOrWait` on this path.
        return {
          run: context.run,
          lines: [...lines, `Fleet ${mode.fleetId}: ${action.detail}`],
          stop: false,
          acted: false,
        };
      case "complete": {
        const completed = completeTickAction(context, action);
        return { ...completed, lines: [...lines, ...completed.lines] };
      }
      case "halt": {
        const halted = haltTickAction(context, action);
        // `acted: false` keeps the tick that gives up from resetting the idle count
        // that justified it; `fleetTick` then records `progressed: false` and stops.
        return { ...halted, lines: [...lines, ...halted.lines], acted: false };
      }
      default:
        return unreachableEmptyAdvance(action);
    }
  }

  /**
   * Compile-time guard for the kinds `emptyAdvanceAction` can return.
   *
   * It is typed against the full plan union, so a new action kind must be handled
   * here or fail this build; falling through silently would recreate the per-tick
   * loop this degrade exists to remove.
   */
  function unreachableEmptyAdvance(
    action: Exclude<FleetTickAction, { kind: "wait" | "complete" | "halt" }>,
  ): never {
    throw new Error(`unexpected action for an advance that launched nothing: ${action.kind}`);
  }

  function completeTickAction(
    options: FleetTickContext,
    action: Extract<FleetTickAction, { kind: "complete" }>,
  ): FleetTickOutcome {
    const { ctx, mode, run, now } = options;
    auditFleetAction({
      ctx,
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      action: "fleet-run-complete",
      taskIds: (run.members ?? []).map((member) => member.taskId),
      detail: `${action.outcome}: ${action.detail}`,
    });
    const released = releaseTerminalMembers({ context: options, reason: "run-complete" });
    return {
      run: finishFleetRun({ run, now, outcome: action.outcome }),
      lines: [`Fleet ${mode.fleetId}: run ${action.outcome}. ${action.detail}`, ...released],
      stop: true,
      acted: true,
    };
  }

  function haltTickAction(
    options: FleetTickContext,
    action: Extract<FleetTickAction, { kind: "halt" }>,
  ): FleetTickOutcome {
    const { ctx, mode, now } = options;
    // A cooperative pause stops the timer but does NOT close the run: `resume`
    // restarts the same run, and a pause that permanently finished it would make
    // "pause, step away, resume" a lie. Every other halt (parked, stalled) needs a
    // human and is recorded on the run.
    const resumable = action.reason === "paused";
    const haltedReason = resumable
      ? undefined
      : `${action.reason}: ${action.detail}`.slice(0, FLEET_RUN_DETAIL_MAX_LENGTH);
    auditFleetAction({
      ctx,
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      action: "fleet-run-halted",
      taskIds: options.intent.taskIds,
      detail: haltedReason ?? `paused: ${action.detail}`,
    });
    // Only a terminal halt releases: a pause keeps the run resumable, and its
    // in-flight members are exactly the ones a resume continues (`haltedReason` is
    // what distinguishes the two).
    const released =
      haltedReason === undefined
        ? []
        : releaseTerminalMembers({ context: options, reason: "run-halted" });
    return {
      run:
        haltedReason === undefined
          ? { ...options.run, updatedAt: now }
          : { ...options.run, updatedAt: now, haltedReason },
      lines: [
        `Fleet ${mode.fleetId}: run ${resumable ? "paused" : "halted"} (${action.reason}): ${action.detail}`,
        ...released,
      ],
      stop: true,
      acted: true,
    };
  }

  /**
   * Reap ordering gates whose reason to exist is gone, and adopt the ones bd knows.
   *
   * Three kinds:
   *
   * - **orphans** — a recorded gate naming a bead that is no longer a member
   *   (removed, pruned, or a failed launch): nothing in the fleet can ever resolve
   *   it, and it would block that bead in bd forever.
   * - **closed beads** — a gate where either bead is `closed`/`done` (a human ran
   *   `bd close`, or `--accept` did): the wait is satisfied or moot either way, and
   *   bd would otherwise leave an open gate blocking nothing.
   * - **unrecorded gates** — bd has a fleet-ordering gate that `fleet.json` does not
   *   name (a crash between `bd gate create` and the intent write). One member bead
   *   per tick is asked directly, rotating through the fleet, so the sweep is
   *   bounded to a single extra read per tick and still reaches every member. A
   *   reconcile pass asks every member instead (`sweep: "all"`), because it is an
   *   explicit repair and the operator expects the whole fleet swept.
   *
   * Records are dropped by **gate id**, never by member id: resolving one gate of a
   * member with two dependents says nothing about the other, and forgetting the
   * other would leave it open with nothing able to resolve it.
   *
   * A resolve failure keeps the record (so the next tick retries) and is reported
   * rather than swallowed.
   *
   * Warnings about one *gate* (drifted reason, unrecordable adoption) are keyed by
   * gate id and shown once per run: the sweep rediscovers them on every rotation, and
   * the tick loop notifies every line it gets back. The caller persists the returned
   * `gateNoticeIds` on the run record so a restart does not re-warn either.
   */
  async function reapOrderingGates(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    intent: FleetIntent;
    now: number;
    /** Monotonic run tick, used to rotate the unrecorded-gate sweep. */
    tick: number;
    /** `all` sweeps every member (reconcile); `tick` rotates one bead per tick. */
    sweep?: "tick" | "all";
    /**
     * Beads to sweep although they are not members any more (members a repair just
     * pruned). They are deliberately *not* added to the member set: a pruned bead
     * must count as released so its gates are resolved, not adopted.
     */
    extraBeads?: readonly string[];
  }): Promise<{ warnings: readonly string[]; gateNoticeIds: readonly string[] }> {
    const gates = options.intent.orderingGates ?? [];
    const members = new Set(fleetMemberTaskIds(options.intent));
    const landed = new Set(
      (options.intent.run?.members ?? [])
        .filter((member) => member.landedAt !== undefined)
        .map((member) => member.taskId),
    );
    // A gate has served its purpose once either bead stops being a member or the
    // blocker lands: the merge happened, or nothing in the fleet can wait on that
    // edge any more. This is the same predicate the recorded-gate orphan path uses,
    // applied to bd's own answer for the unrecorded sweep.
    const gateReleased = (gate: { blocker: string; blocked: string }): boolean =>
      !members.has(gate.blocker) || !members.has(gate.blocked) || landed.has(gate.blocker);

    const orphans = gates.filter(
      (gate) => !members.has(gate.blocker) || !members.has(gate.blocked),
    );
    const orphaned =
      orphans.length === 0
        ? {
            remaining: gates,
            resolvedGateIds: [],
            adopted: [],
            warnings: [],
            notices: [],
          }
        : await reapGateSubset(orphans, { ...options, label: "orphan" });
    // Only a gate whose beads are still members is left to the bead-status read:
    // the rest is already resolved above.
    const live = orphaned.remaining.filter(
      (gate) => members.has(gate.blocker) && members.has(gate.blocked),
    );
    const stale = await reapClosedBeadGates(live, options);
    const unrecorded = await reapUnrecordedGates({
      ...options,
      members,
      gateReleased,
      recorded: gates,
    });
    const resolvedGateIds = [
      ...orphaned.resolvedGateIds,
      ...stale.resolvedGateIds,
      ...unrecorded.resolvedGateIds,
    ];
    const adopted = [...orphaned.adopted, ...stale.adopted, ...unrecorded.adopted];
    const warnings = [...orphaned.warnings, ...stale.warnings, ...unrecorded.warnings];
    const notices: FleetGateNotice[] = [
      ...orphaned.notices,
      ...stale.notices,
      ...unrecorded.notices,
    ];
    const persisted = persistGateReap({
      mode: options.mode,
      now: options.now,
      resolvedGateIds,
      adopted,
      notices,
    });
    warnings.push(...persisted.warnings);
    if (persisted.accepted.length > 0) {
      auditFleetAction({
        ctx: options.ctx,
        gitCommonDir: options.mode.gitCommonDir,
        fleetId: options.mode.fleetId,
        action: "ordering-gates-adopted",
        taskIds: persisted.accepted.map((gate) => gate.blocked),
        detail: persisted.accepted
          .map((gate) => `${gate.blocker}->${gate.blocked} (${gate.gateId})`)
          .join(", "),
      });
    }
    const planned = reportGateNotices(options, notices, resolvedGateIds);
    return {
      warnings: [...warnings, ...planned.fresh.map((notice) => notice.message)],
      gateNoticeIds: planned.noticeIds,
    };
  }

  /**
   * Write the reaper's decisions: drop what bd resolved, record what it adopted.
   *
   * A refused adoption (one that would pass the intent's gate bound) becomes a
   * notice instead of a record: the gate must stay open in bd — resolving it would
   * release a dependent before its blocker landed — so naming it for a human is the
   * only correct move. Its error is returned rather than thrown so the rest of the
   * reap still writes.
   */
  function persistGateReap(options: {
    mode: FleetMode;
    now: number;
    resolvedGateIds: readonly string[];
    adopted: readonly FleetOrderingGate[];
    notices: FleetGateNotice[];
  }): { warnings: readonly string[]; accepted: readonly FleetOrderingGate[] } {
    if (options.resolvedGateIds.length === 0 && options.adopted.length === 0) {
      return { warnings: [], accepted: [] };
    }
    // Filled inside the compare-and-replace, because only the record actually
    // written says which adoptions survived the bound (and a CAS retry re-decides).
    const accepted: FleetOrderingGate[] = [];
    const written = mutateFleetIntent({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      mutate: (intent) => {
        const dropped = dropFleetOrderingGates(intent, options.resolvedGateIds, options.now);
        const added = addFleetOrderingGates(dropped, options.adopted, options.now);
        const refusedIds = new Set(
          (added.ok ? [] : added.refused).map((entry) => entry.gate.gateId),
        );
        accepted.length = 0;
        accepted.push(...options.adopted.filter((gate) => !refusedIds.has(gate.gateId)));
        if (!added.ok) options.notices.push(...refusalNotices(options.mode.fleetId, added.refused));
        return added.intent;
      },
    });
    // A lost CAS race leaves the adopted gates open in bd with no record here, so
    // name them for a human: `bd gate list` would otherwise be the only way to find
    // the ids that must be resolved by hand.
    const unrecorded =
      options.adopted.length === 0
        ? ""
        : ` (unrecorded ordering gates: ${options.adopted
            .map((gate) => `${gate.blocker}->${gate.blocked} (${gate.gateId})`)
            .join(", ")})`;
    const warnings = written.ok
      ? []
      : [`Fleet ${options.mode.fleetId}: ${written.error}${unrecorded}`];
    return { warnings, accepted };
  }

  /** Refused adoptions, worded so a human knows which dependent stays bd-blocked. */
  function refusalNotices(
    fleetId: string,
    refused: readonly { gate: FleetOrderingGate; error: string }[],
  ): readonly FleetGateNotice[] {
    return refused.map((refusal) => ({
      gateId: refusal.gate.gateId,
      message:
        `Fleet ${fleetId}: ordering gate ${refusal.gate.gateId} ` +
        `(${refusal.gate.blocker} -> ${refusal.gate.blocked}) is open in bd but ` +
        `could not be recorded: ${refusal.error}`,
    }));
  }

  /**
   * Which gate findings to show now, and the ledger the caller must persist.
   *
   * A drift or an adoption refusal is rediscovered on every rotation of the sweep,
   * and the tick loop notifies every line it gets back: report each gate once per
   * run instead of once per pass. A reconcile pass is an explicit repair by a
   * human, so it shows every finding it made instead of the once-per-run subset.
   */
  function reportGateNotices(
    options: { sweep?: "tick" | "all"; intent: FleetIntent },
    notices: readonly FleetGateNotice[],
    releasedGateIds: readonly string[],
  ): FleetGateNoticePlan {
    if (options.sweep === "all") {
      return { fresh: notices, noticeIds: options.intent.run?.gateNoticeIds ?? [] };
    }
    return planGateNotices({
      ...(options.intent.run?.gateNoticeIds === undefined
        ? {}
        : { existing: options.intent.run.gateNoticeIds }),
      notices,
      releasedGateIds,
    });
  }

  /** What one reap step resolved, what is still recorded, and what to report. */
  interface ReapOutcome {
    remaining: readonly FleetOrderingGate[];
    /** Gate ids bd confirmed resolved; the only thing the records may drop. */
    resolvedGateIds: readonly string[];
    /** Unrecorded gates adopted into `fleet.json` so a landing can resolve them. */
    adopted: readonly FleetOrderingGate[];
    /** Plain warnings: read failures and the like, reported every pass. */
    warnings: readonly string[];
    /** Per-gate findings, reported once per gate per run (`planGateNotices`). */
    notices: readonly FleetGateNotice[];
  }

  /** Resolve a chosen set of gates, keeping every record bd did not confirm. */
  async function reapGateSubset(
    gates: readonly FleetOrderingGate[],
    options: { ctx: ExtensionContext; mode: FleetMode; label: string },
  ): Promise<ReapOutcome> {
    // An empty selection resolves nothing and keeps nothing back: the caller's
    // other gates are not this step's business.
    if (gates.length === 0) {
      return { remaining: gates, resolvedGateIds: [], adopted: [], warnings: [], notices: [] };
    }
    const result = await resolveFleetOrderingGates({
      gates,
      cwd: options.ctx.cwd,
      runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
    });
    if (!result.ok) {
      return {
        remaining: result.remaining,
        resolvedGateIds: result.resolved.map((gate) => gate.gateId),
        adopted: [],
        notices: [],
        warnings: [
          `Fleet ${options.mode.fleetId}: could not resolve ${options.label} ordering ` +
            `gate(s): ${result.error}`,
        ],
      };
    }
    return {
      remaining: result.remaining,
      resolvedGateIds: result.resolved.map((gate) => gate.gateId),
      warnings: [],
      adopted: [],
      notices: [],
    };
  }

  /**
   * Resolve the gates whose beads bd reports closed/done or missing altogether.
   *
   * One batched read-only `bd show` per tick covers every gated bead, and a read
   * failure degrades to a warning: the tick can retry it, and an unreadable bd
   * must not stop the fleet from making progress on the rest.
   */
  async function reapClosedBeadGates(
    live: readonly FleetOrderingGate[],
    options: { ctx: ExtensionContext; mode: FleetMode },
  ): Promise<ReapOutcome> {
    if (live.length === 0)
      return { remaining: live, resolvedGateIds: [], adopted: [], warnings: [], notices: [] };
    const beadIds = [...new Set(live.flatMap((gate) => [gate.blocker, gate.blocked]))].sort();
    const lookup = await lookupFleetBeads({
      taskIds: beadIds,
      cwd: options.ctx.cwd,
      runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
    });
    if (!lookup.ok) {
      return {
        remaining: live,
        resolvedGateIds: [],
        adopted: [],
        notices: [],
        warnings: [
          `Fleet ${options.mode.fleetId}: could not read the beads behind its ordering ` +
            `gates: ${lookup.error}`,
        ],
      };
    }
    // An answer that does not name every requested bead is ambiguous: bd changed
    // its payload shape, the read hit a different database, or ids were silently
    // dropped. Treating a missing record as "that bead is gone" would mass-resolve
    // gates whose blockers have not landed, so only a *complete* answer can decide
    // which beads are absent — and an absent record is not evidence of death when
    // bd normally fails the whole read for an unknown id.
    const returned = new Set(lookup.beads.map((bead) => bead.id));
    const missing = beadIds.filter((beadId) => !returned.has(beadId));
    if (missing.length > 0) {
      return {
        remaining: live,
        resolvedGateIds: [],
        adopted: [],
        notices: [],
        warnings: [
          `Fleet ${options.mode.fleetId}: bd returned no record for ${missing.length} of ` +
            `${beadIds.length} bead(s) behind its ordering gates (${missing.join(", ")}); ` +
            "not reaping on an ambiguous answer",
        ],
      };
    }
    const closed = closedBeadsOf(lookup.beads);
    const stale = live.filter((gate) => closed.has(gate.blocker) || closed.has(gate.blocked));
    const reaped = await reapGateSubset(stale, { ...options, label: "closed-bead" });
    // The gates that are not stale stay recorded and untouched.
    const untouched = live.filter((gate) => !stale.includes(gate));
    return { ...reaped, remaining: [...reaped.remaining, ...untouched] };
  }

  /**
   * Sweep bd for ordering gates `fleet.json` does not name, and adopt them.
   *
   * The record list cannot name a gate the fleet never wrote down, so asking bd
   * directly is the only way to close the crash window between `bd gate create` and
   * the intent write. Two outcomes per gate:
   *
   * - **released** (a bead left the fleet, or the blocker landed) → resolve: nothing
   *   is left to wait for.
   * - **still live** (both ends are members and the blocker has not landed) → adopt:
   *   write the record so the blocker's landing resolves it like any other gate.
   *   Resolving it instead would release a dependent before its blocker landed —
   *   ordering correctness beats tidiness.
   *
   * A tick asks one member bead (rotating by `run.ticks`), which keeps a 15-second
   * loop cheap while covering every member within a few minutes. A reconcile pass
   * asks every member, bounded by a small concurrency, because it is an explicit
   * repair rather than a heartbeat.
   */
  async function reapUnrecordedGates(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    tick: number;
    sweep?: "tick" | "all";
    members: ReadonlySet<string>;
    extraBeads?: readonly string[];
    gateReleased: (gate: { blocker: string; blocked: string }) => boolean;
    /** Records the intent already holds, so an adoption never duplicates an edge. */
    recorded: readonly FleetOrderingGate[];
  }): Promise<ReapOutcome> {
    const beads = sweepBeads(options);
    if (beads.length === 0)
      return { remaining: [], resolvedGateIds: [], adopted: [], warnings: [], notices: [] };
    const lookups = await mapBounded(beads, ORDERING_SWEEP_CONCURRENCY, (beadId) =>
      listFleetOrderingGatesForBead({
        beadId,
        cwd: options.ctx.cwd,
        runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
      }).then((lookup) => ({ beadId, lookup })),
    );

    const recordedByEdge = new Map(options.recorded.map((gate) => [edgeKeyOf(gate), gate.gateId]));
    const resolvedGateIds: string[] = [];
    const adopted: FleetOrderingGate[] = [];
    const warnings: string[] = [];
    const notices: FleetGateNotice[] = [];
    for (const { beadId, lookup } of lookups) {
      if (!lookup.ok) {
        warnings.push(
          `Fleet ${options.mode.fleetId}: could not read the ordering gates of ${beadId}: ` +
            lookup.error,
        );
        continue;
      }
      // Drift is per gate and rediscovered on every rotation, so it travels as a
      // keyed notice instead of a plain warning the tick would repeat forever.
      notices.push(...lookup.drifts);
      for (const gate of lookup.gates) {
        const swept = await sweepOneGate(gate, options, recordedByEdge);
        resolvedGateIds.push(...swept.resolvedGateIds);
        warnings.push(...swept.warnings);
        if (swept.adopt !== undefined) {
          adopted.push(swept.adopt);
          // A second gate for the same edge in this same answer is a duplicate: the
          // record just adopted keeps the ordering, so this one is resolved below.
          recordedByEdge.set(edgeKeyOf(swept.adopt), swept.adopt.gateId);
        }
      }
    }
    return { remaining: [], resolvedGateIds, adopted, warnings, notices };
  }

  /** What one discovered gate needs: a resolve, an adoption, or nothing. */
  interface SweptGate {
    resolvedGateIds: readonly string[];
    adopt?: FleetOrderingGate;
    warnings: readonly string[];
  }

  /**
   * Decide one discovered gate: duplicate, released, or adopt.
   *
   * Split out of the sweep because the three cases are the whole point of the pass
   * and each has its own failure mode; sharing this with the tick keeps a 15-second
   * loop and an explicit repair behaving identically.
   */
  async function sweepOneGate(
    gate: { fleetId: string; blocker: string; blocked: string; gateId: string },
    options: {
      ctx: ExtensionContext;
      mode: FleetMode;
      gateReleased: (gate: { blocker: string; blocked: string }) => boolean;
    },
    recordedByEdge: ReadonlyMap<string, string>,
  ): Promise<SweptGate> {
    if (gate.fleetId !== options.mode.fleetId) return { resolvedGateIds: [], warnings: [] };
    const record = { blocker: gate.blocker, blocked: gate.blocked, gateId: gate.gateId };
    const recordedGateId = recordedByEdge.get(edgeKeyOf(record));
    // Already recorded with this very id: nothing to do.
    if (recordedGateId === gate.gateId) return { resolvedGateIds: [], warnings: [] };
    // A second gate for a recorded edge is a duplicate the record does not need; the
    // recorded twin keeps the ordering intact. A released gate has nothing left to
    // wait for. Both are resolved; everything else is adopted.
    if (recordedGateId !== undefined || options.gateReleased(gate)) {
      const resolved = await resolveFleetOrderingGates({
        gates: [record],
        cwd: options.ctx.cwd,
        runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
      });
      return resolved.ok
        ? { resolvedGateIds: resolved.resolved.map((entry) => entry.gateId), warnings: [] }
        : {
            resolvedGateIds: [],
            warnings: [`Fleet ${options.mode.fleetId}: ${resolved.error}`],
          };
    }
    return { resolvedGateIds: [], adopt: record, warnings: [] };
  }

  /** The beads a sweep asks bd about: one rotating (per tick) or all (per repair). */
  function sweepBeads(options: {
    tick: number;
    sweep?: "tick" | "all";
    members: ReadonlySet<string>;
    extraBeads?: readonly string[];
  }): readonly string[] {
    const beads = [...new Set([...options.members, ...(options.extraBeads ?? [])])].sort();
    if (options.sweep === "all") return beads;
    const index = Math.abs(Math.trunc(options.tick)) % Math.max(1, beads.length);
    const bead = beads[index];
    return bead === undefined ? [] : [bead];
  }

  function edgeKeyOf(edge: { blocker: string; blocked: string }): string {
    return `${edge.blocker}\u0000${edge.blocked}`;
  }

  /**
   * Whether git proves the member's branch is already on the base branch.
   *
   * `merge-base --is-ancestor` exits non-zero for "not an ancestor", and a missing
   * branch or a failed git call throws; every one of those is "not proven landed",
   * never "landed", because pruning on a probe that did not answer is exactly how a
   * live member would disappear from the fleet.
   */
  async function branchIsOnBase(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
  }): Promise<boolean> {
    const branch = memberMergeBranch(options.ctx.cwd, options.taskId);
    if (!branch.ok) return false;
    try {
      await runGitCommand(
        ["merge-base", "--is-ancestor", branch.branch, options.mode.intent.baseBranch],
        { cwd: options.ctx.cwd, timeoutInMs: 15_000, maxBufferInBytes: 1024 * 1024 },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Land a member whose work reached the base branch outside the fleet (bd-166).
   *
   * No merge happens: git already proved the branch is on the base. The landing is
   * recorded, the member pruned, and its ordering gates resolved exactly like the
   * loop's own landing, so a later tick does not see a phantom member. Acceptance is
   * deliberately not re-run — the human who closed the bead already decided what to
   * do with the bead and worktree.
   */
  async function landAlreadyMergedMember(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    intent: FleetIntent;
    run: FleetRun;
    taskId: string;
    now: number;
  }): Promise<
    | { ok: true; intent: FleetIntent; run: FleetRun; lines: readonly string[] }
    | { ok: false; error: string }
  > {
    const pruned = pruneLandedMember({
      ctx: options.ctx,
      mode: options.mode,
      taskId: options.taskId,
      now: options.now,
    });
    if (!pruned.ok) return { ok: false, error: pruned.error };
    const run = recordRunMemberLanded({
      run: options.run,
      taskId: options.taskId,
      now: options.now,
    });
    const base = options.mode.intent.baseBranch;
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      action: "fleet-landed",
      taskIds: [options.taskId],
      detail: `${options.taskId} was already on ${base} (bead closed outside the fleet); pruned and gates resolved`,
    });
    const gateLines = await resolveLandedOrderingGates({
      ctx: options.ctx,
      mode: options.mode,
      taskId: options.taskId,
      now: options.now,
    });
    return {
      ok: true,
      intent: pruneLandedFleetMember(options.intent, options.taskId, options.now),
      run,
      lines: [
        `Fleet ${options.mode.fleetId}: landed ${options.taskId} — its bead is closed and its branch is already on ${base}`,
        ...gateLines,
      ],
    };
  }

  /**
   * Detect members the fleet never landed but whose work is on the base branch.
   *
   * `docs/fleet.md` tells humans to accept with `wt merge` / `bd close`, a path that
   * never touches `fleet.json` — that is bd-37, and the member kept its slot forever
   * with nothing left to observe. A bead bd reports `closed`/`done` is a candidate,
   * and only a git ancestor proof makes it a landing. Bead status alone is not proof
   * of merging.
   *
   * The bead evidence uses the tick's existing budget: one member bead, rotating by
   * `run.ticks` (`sweepBeads`, the same rotation the gate sweep uses), so a large
   * fleet does not become a full-fleet `bd show` every 15 s. Each closed candidate
   * costs exactly one `git merge-base --is-ancestor` probe, and a bd read failure
   * just skips the sweep for this tick.
   */
  async function landMembersMergedOutsideFleet(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    intent: FleetIntent;
    run: FleetRun;
    now: number;
  }): Promise<{ intent: FleetIntent; run: FleetRun; lines: readonly string[] }> {
    const landedIds = new Set(
      (options.run.members ?? [])
        .filter((member) => member.landedAt !== undefined)
        .map((member) => member.taskId),
    );
    const candidates = options.intent.taskIds.filter((taskId) => !landedIds.has(taskId));
    // One bead per tick, rotating with the run's tick counter: a hand merge becomes
    // visible within a fleet-sized cycle rather than on one 15 s tick, and the tick
    // keeps the read budget it already had (bd-166 review).
    const rotating = sweepBeads({ tick: options.run.ticks, members: new Set(candidates) });
    if (rotating.length === 0) {
      return { intent: options.intent, run: options.run, lines: [] };
    }
    const lookup = await lookupFleetBeads({
      taskIds: rotating,
      cwd: options.ctx.cwd,
      runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
    });
    // A failed read skips the sweep, silently: this pass is opportunistic (the gate
    // reaper already reports an unreadable bd), and a per-tick warning about it
    // would drown the run's own lines.
    if (!lookup.ok) return { intent: options.intent, run: options.run, lines: [] };
    const proven = await planOutsideFleetLandings({
      intent: options.intent,
      run: options.run,
      closedBeadIds: closedBeadsOf(lookup.beads),
      branchOnBase: (taskId) => branchIsOnBase({ ctx: options.ctx, mode: options.mode, taskId }),
    });
    let intent = options.intent;
    let run = options.run;
    const lines: string[] = [];
    for (const taskId of proven) {
      const landed = await landAlreadyMergedMember({
        ctx: options.ctx,
        mode: options.mode,
        intent,
        run,
        taskId,
        now: options.now,
      });
      if (!landed.ok) {
        lines.push(
          `Fleet ${options.mode.fleetId}: could not record the landing of ${taskId}: ${landed.error}`,
        );
        continue;
      }
      intent = landed.intent;
      run = landed.run;
      lines.push(...landed.lines);
    }
    return { intent, run, lines };
  }

  /** What one tick did, and why it stopped the loop when it did. */
  interface FleetTickLoopOutcome {
    lines: readonly string[];
    stop: boolean;
    acted: boolean;
    stopReason?: FleetTickStopReason;
  }

  /**
   * Report a stop caused by a fleet record the loop can no longer read (bd-169).
   *
   * Shared by every branch that stops because the record is gone or unreadable — the
   * tick's own re-read and the advance's mid-flight re-read — so the operator gets the
   * same warning, console line, and `supervisor-intent-lost` audit entry whichever one
   * fired. Returns the line to notify.
   */
  function reportIntentLost(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    fleetId: string;
    detail: string;
    line: string;
  }): string {
    console.warn(`[belayd-harness] ${options.line}`);
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.fleetId,
      action: "supervisor-intent-lost",
      taskIds: options.mode.intent.taskIds,
      detail: options.detail,
    });
    return options.line;
  }

  /**
   * Stop the loop because this session no longer owns the fleet (bd-169).
   *
   * Deliberately NOT recorded as `haltedReason` on the run: another session may have
   * re-armed and its loop now owns that record, so marking the run halted here would
   * kill work that is actually being driven. The loss is reported instead (audit +
   * notify + console), which is what status and the operator can see without racing
   * the new supervisor.
   */
  function stopTickForLostAuthority(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    current: FleetMode | undefined;
  }): FleetTickLoopOutcome {
    const cause =
      options.current === undefined
        ? "no fleet record grants this session supervisor authority"
        : `the session now resolves to fleet \`${options.current.fleetId}\``;
    const line =
      `Fleet ${options.mode.fleetId}: run loop stopped — this session is no longer the live ` +
      `supervisor (${cause}). Nothing lands or advances until a session ticks it: re-arm ` +
      `with \`/fleet ${options.mode.intent.taskIds.join(" ")} --fleet ${options.mode.fleetId}\` ` +
      "or call `belayd_fleet_advance` from the supervisor session.";
    console.warn(`[belayd-harness] ${line}`);
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      action: "supervisor-lost",
      taskIds: options.mode.intent.taskIds,
      detail: cause,
    });
    return { lines: [line], stop: true, acted: false, stopReason: "authority-lost" };
  }

  /**
   * Stop the loop because the fleet record is gone (bd-169).
   *
   * Not a terminal run: something outside the fleet removed or emptied the record,
   * so the loop must say so instead of dying quietly.
   */
  function stopTickForMissingIntent(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    fleetId: string;
  }): FleetTickLoopOutcome {
    const line = reportIntentLost({
      ctx: options.ctx,
      mode: options.mode,
      fleetId: options.fleetId,
      detail: "fleet.json is gone; the run loop stopped",
      line:
        `Fleet ${options.fleetId}: run loop stopped — the fleet record is gone, so nothing ` +
        "is ticking this run. Recover it from a session that can read the repository's " +
        `fleet directory, or re-arm with \`/fleet ${options.mode.intent.taskIds.join(" ")} ` +
        `--fleet ${options.fleetId}\`.`,
    });
    return { lines: [line], stop: true, acted: false, stopReason: "intent-lost" };
  }

  /**
   * Stop the loop because the fleet record cannot be read (bd-169).
   *
   * The sibling of {@link stopTickForMissingIntent}: a corrupt or unreadable
   * `fleet.json` is the same lost loop, so it gets the same audit and recovery line.
   */
  function stopTickForUnreadableIntent(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    fleetId: string;
    error: string;
  }): FleetTickLoopOutcome {
    const line = reportIntentLost({
      ctx: options.ctx,
      mode: options.mode,
      fleetId: options.fleetId,
      detail: `fleet.json could not be read: ${options.error}`,
      line:
        `Fleet ${options.fleetId}: run loop stopped — the fleet record could not be read ` +
        `(${options.error}), so nothing is ticking this run. Recover the record, then ` +
        `re-arm with \`/fleet ${options.mode.intent.taskIds.join(" ")} --fleet ` +
        `${options.fleetId}\`.`,
    });
    return { lines: [line], stop: true, acted: false, stopReason: "intent-lost" };
  }

  /** What a tick needs before it can act: live authority, the record, an active run. */
  type FleetTickPreflight =
    | { kind: "stop"; outcome: FleetTickLoopOutcome }
    | { kind: "go"; current: FleetMode; intent: FleetIntent; run: FleetRun };

  /**
   * Re-derive authority, beat the heartbeat, and read the record this tick acts on.
   *
   * Every refusal returns a loud stop (bd-169), so the tick body itself only runs when
   * the loop genuinely still owns an active run. A finished or halted run is the one
   * quiet stop: the tick that produced it already recorded and announced it.
   */
  function fleetTickPreflight(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    now: number;
  }): FleetTickPreflight {
    const { ctx, mode, now } = options;
    // Authority is re-derived every tick: a re-arm by another session must stop
    // this loop instead of letting two supervisors act on one fleet.
    const current = fleetModeFor(ctx);
    if (current === undefined || current.fleetId !== mode.fleetId) {
      return { kind: "stop", outcome: stopTickForLostAuthority({ ctx, mode, current }) };
    }
    const beat = writeSupervisorHeartbeat({
      gitCommonDir: current.gitCommonDir,
      fleetId: current.fleetId,
      sessionId: ctx.sessionManager.getSessionId(),
      pid: process.pid,
      now,
    });
    if (!beat.ok) {
      // A missing beat makes the fleet look abandoned to a later session; report
      // it and keep ticking, because the run itself can still make progress.
      ctx.ui.notify(
        `Fleet ${current.fleetId}: could not write the supervisor heartbeat: ${beat.error}`,
        "warning",
      );
    }
    const loaded = readFleetIntent({
      gitCommonDir: current.gitCommonDir,
      fleetId: current.fleetId,
    });
    if (!loaded.ok) {
      return {
        kind: "stop",
        outcome: stopTickForUnreadableIntent({
          ctx,
          mode,
          fleetId: current.fleetId,
          error: loaded.error,
        }),
      };
    }
    // A missing record is not a terminal run: the loop was stopped by something
    // outside the fleet (a cleanup, a hand edit), so say so instead of dying quietly.
    const intent = loaded.intent;
    if (intent === undefined) {
      return {
        kind: "stop",
        outcome: stopTickForMissingIntent({ ctx, mode, fleetId: current.fleetId }),
      };
    }
    const run = intent.run;
    if (run === undefined || !isFleetRunActive(run)) {
      return {
        kind: "stop",
        outcome: { lines: [], stop: true, acted: false, stopReason: "terminal" },
      };
    }
    return { kind: "go", current, intent, run };
  }

  /**
   * One deterministic tick: observe, decide, act, persist.
   *
   * Every `stop` says *why* (`stopReason`) and a non-terminal stop is loud: bd-169
   * was a loop that died without a trace, and `belayd_fleet_status` kept calling the
   * run active because nothing recorded that the ticker was gone.
   */
  async function fleetTick(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
  }): Promise<FleetTickLoopOutcome> {
    const { ctx } = options;
    const now = Date.now();
    const preflight = fleetTickPreflight({ ctx, mode: options.mode, now });
    if (preflight.kind === "stop") return preflight.outcome;
    const { current, intent, run } = preflight;

    // A member whose bead was closed and whose work is already on the base branch has
    // landed outside the fleet; landing it first keeps the observations and the plan
    // from treating a merged member as still in flight (bd-166).
    const swept = await landMembersMergedOutsideFleet({
      ctx,
      mode: current,
      intent,
      run,
      now,
    });
    const tickIntent = swept.intent;
    const tickRun = swept.run;
    const observations = await readFleetMemberObservations({
      cwd: ctx.cwd,
      intent: tickIntent,
      run: tickRun,
      now,
    });
    // Progress is observed, not merely acted on (bd-172): a tick whose members moved
    // through their phases is progress even though the action it takes is a wait, and
    // the plan below must see the reset counter so it cannot declare a healthy member
    // stalled on the tick it advanced.
    const progress = fleetTickProgress({ run: tickRun, observations });
    // Reap before planning: a gate whose member is gone must not outlive the tick
    // that could have noticed, and a closed blocker bead means its dependent is no
    // longer waiting on the fleet.
    const reaped = await reapOrderingGates({
      ctx,
      mode: current,
      intent: tickIntent,
      now,
      tick: tickRun.ticks,
    });
    const action = planFleetTick({
      intent: tickIntent,
      observations,
      now,
      idleTicks: progress.idleTicks,
      maxIdleTicks: progress.maxIdleTicks,
    });
    const result = await executeFleetTickAction({
      ctx,
      mode: current,
      intent: tickIntent,
      run: tickRun,
      action,
      now,
      observations,
      idleTicks: progress.idleTicks,
      maxIdleTicks: progress.maxIdleTicks,
    });
    const ticked = recordFleetTickProgress({
      run: result.run,
      now,
      acted: result.acted,
      // The loop's own stop is the fact that matters: a pause/halt must not count as
      // progress or keep its baseline, a completion must (bd-172 review).
      stopped: result.stop,
      progress,
    });
    // The gate-notice ledger rides on the run this tick persists, so the next
    // rotation does not re-notify the same drifted or unrecordable gate.
    persistFleetRun({
      ctx,
      mode: current,
      run: recordFleetGateNotices(ticked, reaped.gateNoticeIds),
      now,
    });
    return {
      lines: [...swept.lines, ...reaped.warnings, ...result.lines],
      stop: result.stop,
      acted: result.acted,
      ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
    };
  }

  /** Stop the loop's timer (the durable run record is what survives). */
  function stopFleetRunTimer(state: FleetState): void {
    if (state.fleetRunTimer === undefined) return;
    clearTimeout(state.fleetRunTimer);
    state.fleetRunTimer = undefined;
  }

  /** Schedule the next tick; an acting tick comes back sooner than an idle one. */
  function scheduleFleetTick(options: {
    ctx: ExtensionContext;
    state: FleetState;
    mode: FleetMode;
    delayInMs: number;
  }): void {
    stopFleetRunTimer(options.state);
    const timer = setTimeout(() => {
      void runFleetTickSafely(options);
    }, options.delayInMs);
    timer.unref();
    options.state.fleetRunTimer = timer;
  }

  /** A lost loop is a warning, not an info line: nothing lands until someone acts. */
  function fleetTickNotifyLevel(stopReason: FleetTickStopReason | undefined): "info" | "warning" {
    return stopReason === "authority-lost" || stopReason === "intent-lost" ? "warning" : "info";
  }

  /** Keep a reason on record for every stop that was not a terminal run (bd-169). */
  function warnNonTerminalLoopStop(
    fleetId: string,
    stopReason: FleetTickStopReason | undefined,
  ): void {
    if (stopReason === undefined || stopReason === "terminal") return;
    console.warn(`[belayd-harness] fleet ${fleetId}: run loop stopped (${stopReason})`);
  }

  /** Run one tick without ever letting it kill the loop. */
  async function runFleetTickSafely(options: {
    ctx: ExtensionContext;
    state: FleetState;
    mode: FleetMode;
  }): Promise<void> {
    if (options.state.fleetTickInFlight === true) {
      scheduleFleetTick({ ...options, delayInMs: FLEET_RUN_TICK_INTERVAL_MS });
      return;
    }
    options.state.fleetTickInFlight = true;
    try {
      const outcome = await fleetTick({ ctx: options.ctx, mode: options.mode });
      const level = fleetTickNotifyLevel(outcome.stopReason);
      for (const line of outcome.lines) options.ctx.ui.notify(line, level);
      if (outcome.stop) {
        // Nothing may end the timer without a trace (bd-169): the tick notified its
        // own line for a lost authority or a missing record, and the console keeps
        // the reason even if the UI is closed.
        warnNonTerminalLoopStop(options.mode.fleetId, outcome.stopReason);
        stopFleetRunTimer(options.state);
        // The run is over: the name keeps the members and gains the run status, so
        // the session still says what it supervised afterwards.
        finishFleetSupervisorIdentity({ ctx: options.ctx, state: options.state });
        return;
      }
      scheduleFleetTick({
        ...options,
        delayInMs: outcome.acted ? FLEET_RUN_ACTION_TICK_INTERVAL_MS : FLEET_RUN_TICK_INTERVAL_MS,
      });
    } catch (error) {
      // A background loop must survive one bad tick: bd, git, and the gates are
      // external processes, and a transient failure is not a reason to stop
      // supervising the fleet. The next tick re-reads everything from disk.
      console.warn(`[belayd-harness] fleet tick failed: ${errorText(error)}`);
      scheduleFleetTick({ ...options, delayInMs: FLEET_RUN_TICK_INTERVAL_MS });
    } finally {
      options.state.fleetTickInFlight = false;
    }
  }

  /** Start (or restart) the loop for a fleet this session supervises. */
  function startFleetRunLoop(options: {
    ctx: ExtensionContext;
    state: FleetState;
    mode: FleetMode;
  }): void {
    stopFleetRunTimer(options.state);
    scheduleFleetTick({ ...options, delayInMs: 0 });
  }

  /**
   * Make sure this session's active run actually has a timer (bd-169).
   *
   * `belayd_fleet_advance` and `belayd_fleet_resume` are the natural "the loop looks
   * dead" surfaces, and the advance used to succeed without reviving anything. An
   * already-scheduled loop is left alone: restarting it would reset its cadence and
   * chain a second timer onto the same run.
   */
  function ensureFleetRunTimer(options: { ctx: ExtensionContext; state: FleetState }): void {
    const mode = fleetModeFor(options.ctx);
    if (mode === undefined) return;
    const run = mode.intent.run;
    if (run === undefined || !isFleetRunActive(run)) return;
    if (options.state.fleetRunTimer !== undefined) return;
    startFleetRunLoop({ ctx: options.ctx, state: options.state, mode });
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      action: "fleet-run-restarted",
      taskIds: mode.intent.taskIds,
      detail: `no timer was scheduled for the active run (tick ${run.ticks})`,
    });
    options.ctx.ui.notify(
      `Fleet ${mode.fleetId}: run loop restarted — this session is ticking the active run again.`,
      "info",
    );
  }

  // ── Supervisor identity: session name + sidebar pin ────────────────
  //
  // A supervisor is a plain chat session whose work happens in a background timer,
  // so nothing in the UI marks it. Two cheap signals fix that: the session name
  // says which beads it supervises, and a pin keeps it visible in the workspace's
  // session list while members are being launched, landed and stopped.

  /** The name this fleet's supervisor session should carry right now. */
  function supervisorNameFor(mode: FleetMode): string {
    const status = supervisorRunStatus(mode.intent.run);
    return computeFleetSupervisorName({
      fleetId: mode.fleetId,
      taskIds: mode.intent.taskIds,
      memberTaskIds: (mode.intent.run?.members ?? []).map((member) => member.taskId),
      deferredTaskIds: (mode.intent.deferred ?? []).map((entry) => entry.taskId),
      ...(status === undefined ? {} : { status }),
    });
  }

  /**
   * Rename this session to the supervisor name, if it is not already that name.
   *
   * The in-extension API is used deliberately: the name is persisted in the session
   * file (latest `session_info` entry), which is what pi-web and `pi --resume` read,
   * so no second code path can disagree about who supervises what.
   */
  function applySupervisorSessionName(
    ctx: ExtensionContext,
    state: FleetState,
    name: string,
  ): void {
    if (state.supervisorName === name) return;
    if (ctx.sessionManager.getSessionName() === name) {
      state.supervisorName = name;
      return;
    }
    try {
      pi.setSessionName(name);
    } catch (error) {
      // A rename is cosmetic: never let it break supervision.
      console.warn(`[belayd-harness] could not rename the supervisor session: ${errorText(error)}`);
      return;
    }
    state.supervisorName = name;
    ctx.ui.notify(`This session supervises a fleet — renamed to "${name}".`, "info");
  }

  /** Project + workspace the current session is listed under in pi-web. */
  async function supervisorPinTarget(
    ctx: ExtensionContext,
  ): Promise<{ projectId: string; workspaceId: string } | undefined> {
    const endpoint = piWebEndpoint();
    if (endpoint === undefined) return undefined;
    const projects = await piWebRequest(endpoint, { method: "GET", path: PI_WEB_PROJECTS_PATH });
    if (projects.status < 200 || projects.status > 299) return undefined;
    const projectId = matchProjectId(projects.body, ctx.cwd);
    if (projectId === undefined) return undefined;
    const workspaces = await piWebRequest(endpoint, {
      method: "GET",
      path: projectWorkspacesPath(projectId),
    });
    if (workspaces.status < 200 || workspaces.status > 299) return undefined;
    const workspaceId = matchWorkspaceId(workspaces.body, ctx.cwd);
    return workspaceId === undefined ? undefined : { projectId, workspaceId };
  }

  /**
   * Pin this session in its workspace's session list, once per supervised run.
   *
   * Best-effort by design: a pi-web that is unreachable, older than the navigation
   * API, or does not list this cwd costs a log line, never the run.
   */
  async function pinSupervisorSession(ctx: ExtensionContext, state: FleetState): Promise<void> {
    if (state.supervisorPin !== undefined) return;
    const endpoint = piWebEndpoint();
    if (endpoint === undefined) return;
    const target = await supervisorPinTarget(ctx);
    if (target === undefined) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const pinned = await mutateSessionPins({
      request: (request) => piWebRequest(endpoint, request),
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      update: (ids) => withSessionPin(ids, sessionId),
    });
    if (!pinned.ok) {
      console.warn(`[belayd-harness] could not pin the fleet supervisor session: ${pinned.error}`);
      return;
    }
    // Only a pin this session created is recorded, so completion removes exactly
    // what the harness added. A session the operator already pinned stays theirs:
    // `changed: false` means the entry was there before this run started.
    if (!pinned.changed) return;
    state.supervisorPin = { ...target, sessionId };
    ctx.ui.notify("Pinned this session in the sidebar for the fleet run.", "info");
  }

  /** Remove the pin this session added, leaving every other pin untouched. */
  async function releaseSupervisorPin(state: FleetState): Promise<void> {
    const pin = state.supervisorPin;
    if (pin === undefined) return;
    state.supervisorPin = undefined;
    const endpoint = piWebEndpoint();
    if (endpoint === undefined) return;
    const removed = await mutateSessionPins({
      request: (request) => piWebRequest(endpoint, request),
      projectId: pin.projectId,
      workspaceId: pin.workspaceId,
      update: (ids) => withoutSessionPin(ids, pin.sessionId),
    });
    if (!removed.ok) {
      console.warn(
        `[belayd-harness] could not unpin the fleet supervisor session: ${removed.error}`,
      );
    }
  }

  /**
   * Become the fleet's supervisor in the UI: name always, pin when a run starts.
   *
   * `pin` is false for an advance/resume. A pin the operator removed by hand stays
   * removed for the rest of that run instead of being re-added on every tick.
   */
  function adoptFleetSupervisorIdentity(options: {
    ctx: ExtensionContext;
    state: FleetState;
    pin: boolean;
  }): void {
    const mode = fleetModeFor(options.ctx);
    if (mode === undefined) return;
    applySupervisorSessionName(options.ctx, options.state, supervisorNameFor(mode));
    if (!options.pin || options.state.supervisorPin !== undefined) return;
    void pinSupervisorSession(options.ctx, options.state).catch((error: unknown) => {
      console.warn(`[belayd-harness] fleet supervisor pin failed: ${errorText(error)}`);
    });
  }

  /**
   * Mark supervision as over: the name keeps the members plus the run status, and
   * the pin is released (unless the run is only paused, which resumes the same run).
   */
  function finishFleetSupervisorIdentity(options: {
    ctx: ExtensionContext;
    state: FleetState;
  }): void {
    const mode = fleetModeFor(options.ctx);
    if (mode !== undefined) {
      applySupervisorSessionName(options.ctx, options.state, supervisorNameFor(mode));
      const run = mode.intent.run;
      if (run !== undefined && isFleetRunActive(run)) return;
    }
    void releaseSupervisorPin(options.state).catch((error: unknown) => {
      console.warn(`[belayd-harness] fleet supervisor unpin failed: ${errorText(error)}`);
    });
  }

  /**
   * bd-119 conflict check for a member whose worktree already exists.
   *
   * Reuses `matchOwnedWorktree` instead of re-deriving bead ↔ branch ↔ worktree
   * identity, so the fleet cannot disagree with the phase/commit/proof preflight
   * about who owns a tree. A worktree with no workflow state belongs to nobody
   * yet and is reusable; anything else is refused with the bd-119 wording.
   */
  function fleetMemberOwnershipError(root: string, taskId: string): string | undefined {
    const worktreePath = resolveWorktreePath(root, `feat/${taskId}`);
    if (worktreePath === undefined) return undefined;
    const persisted = readWorkflowState({ cwd: worktreePath });
    if (persisted === undefined) return undefined;

    // bd-119 only answers "does another bead own this tree": a worktree whose
    // state is for *this* bead resolves `ok`, yet a standalone `/belayd`
    // orchestrator is already driving it. A fleet launch there would spawn a
    // second detached orchestrator on one bead — the exact invariant bd-119
    // exists to protect — so the fleet adds the missing precondition. Any
    // recorded workflow state for the task means the tree is already driven; a
    // dead orchestrator is recovered by re-arming the fleet (a re-arm preserves
    // members instead of relaunching), or by using that session.
    if (persisted.taskId === taskId) {
      return (
        `${taskId} is already driven by a standalone orchestrator in ${worktreePath} ` +
        `(workflow state for ${taskId} on branch ` +
        `${persisted.branch === "" ? "an unpinned branch" : persisted.branch}). Use that ` +
        "orchestrator's session, or re-arm the fleet (`/fleet <id> --fleet <fleetId>`) instead of " +
        "launching a second orchestrator on the same worktree."
      );
    }

    const owned = matchOwnedWorktree({
      cwd: worktreePath,
      taskId,
      branch: readWorktreeBranch(worktreePath),
      persisted,
    });
    return owned.ok ? undefined : owned.error;
  }

  /**
   * Launch one member through the existing single-bead path.
   *
   * There is deliberately no second spawner: `launchWorktreeWorkflow` owns the
   * worktree, handoff packet, workflow state, and daemon session. The fleet only
   * decides *which* members to launch and records the outcome.
   */
  async function launchFleetMember(options: {
    ctx: ExtensionContext;
    taskId: string;
    base?: string;
  }): Promise<FleetMemberLaunchOutcome> {
    const { ctx, taskId } = options;
    try {
      // Explicit signals only for the workflow type: `/fleet` has no type
      // argument, so a namespaced wf:<type> label decides and anything else is
      // `feature`. No interactive confirmation here: a fleet launch cannot
      // prompt once per member, and the operator's id list is the authority.
      const metadata = await readTaskMetadata(taskId, ctx.cwd);
      const resolution = resolveWorkflowSelection(undefined, metadata?.labels);
      const launched = await launchWorktreeWorkflow({
        ctx,
        taskId,
        workflowType: resolution.type,
        branch: `feat/${taskId}`,
        ...(options.base === undefined ? {} : { base: options.base }),
        resolutionSource: resolution.source,
        ...(resolution.matchedLabel === undefined ? {} : { matchedLabel: resolution.matchedLabel }),
        role: "fleet-member",
      });
      if (!launched.ok) return { taskId, ok: false, detail: launched.error };
      return {
        taskId,
        ok: true,
        detail: `worktree \`feat/${taskId}\`, orchestrator session ${launched.handoff.sessionId}`,
        workflowType: resolution.type,
        sessionId: launched.handoff.sessionId,
      };
    } catch (error) {
      return { taskId, ok: false, detail: errorText(error) };
    }
  }

  interface FleetLaunchResult {
    ok: boolean;
    text: string;
    /** Per-member outcomes, so a run loop can record the sessions it started. */
    outcomes?: readonly FleetMemberLaunchOutcome[];
  }

  /**
   * `/fleet` and `belayd_fleet_launch` share this wrapper: the launch engine
   * itself is `runFleetLaunch` in src/fleet-launch.ts (validation, intent write,
   * per-member launch, prune), with the two side-effecting halves injected — the
   * bd-119 ownership probe and the existing single-bead launch path.
   *
   * Order is validate -> schedule -> write intent -> launch -> prune: the intent
   * must exist before a member starts (a member finds its mailbox by task id), a
   * member that fails is removed from the intent afterwards so the failure is
   * visible, audited, and retryable, and the P3 schedule decides which members
   * start now (waves + capacity) before anything is written.
   */
  /** Refuse a launch from a session that is already driving a workflow or plan. */
  function fleetLaunchBlockedText(state: FleetState): string | undefined {
    if (!state.gateActive && !state.planningActive) return undefined;
    return (
      "A fleet supervisor arms no process gate, so this session cannot launch a fleet while it " +
      "is driving a workflow or a planning session. Finish or stop that work first, then launch " +
      "the fleet from a session with no gate (normally the repository root)."
    );
  }

  /**
   * Apply a launch result to the session: surface warnings, then arm only when
   * the launch wrote and verified its supervisor record.
   *
   * `armed` is separate from `ok` on purpose: a failed member launch still
   * rewrote the record with this call's token, so clearing the arm would leave a
   * fleet whose record names this session while the session refuses its own
   * inbox. A refused or unread-back launch armed nothing and must not clear an
   * existing arm.
   */
  function applyFleetLaunchResult(options: {
    ctx: ExtensionContext;
    state: FleetState;
    /** False for an advance: its run is already pinned and named. */
    pinSupervisor: boolean;
    result: {
      ok: boolean;
      text: string;
      warnings: readonly string[];
      armed: boolean;
      fleetId: string;
      outcomes?: readonly FleetMemberLaunchOutcome[];
    };
    armToken: string;
  }): FleetLaunchResult {
    for (const warning of options.result.warnings) {
      options.ctx.ui.notify(warning, "warning");
      console.warn(`[belayd-harness] ${warning}`);
    }
    if (options.result.armed) {
      options.state.fleetArm = { fleetId: options.result.fleetId, token: options.armToken };
      if (options.result.ok) {
        adoptFleetSupervisorIdentity({
          ctx: options.ctx,
          state: options.state,
          pin: options.pinSupervisor,
        });
      }
    }
    return {
      ok: options.result.ok,
      text: options.result.text,
      ...(options.result.outcomes === undefined ? {} : { outcomes: options.result.outcomes }),
    };
  }

  /**
   * Resolve the publish contract for one launch call, surfacing config warnings.
   *
   * This is the only read of the flag/repo/git config sources in the launch path:
   * the resolved value is frozen into the intent and never re-read mid-run.
   */
  /** The base branch a launch freezes: the current branch or the repo default. */
  function currentBaseBranch(cwd: string): string {
    return currentBranch(cwd) ?? DEFAULT_BASE_BRANCH;
  }

  /** Post-launch side effects that depend on the run mode and the call origin. */
  function recordLaunchFollowUp(options: {
    ctx: ExtensionContext;
    state: FleetState;
    fleetId: string;
    ok: boolean;
    outcomes: readonly FleetMemberLaunchOutcome[];
    runMode: { accept: boolean } | undefined;
    origin: "launch" | "advance" | undefined;
  }): void {
    if (options.runMode !== undefined && options.origin !== "advance" && options.ok) {
      startFleetRunAfterLaunch({
        ctx: options.ctx,
        state: options.state,
        fleetId: options.fleetId,
        accept: options.runMode.accept,
        outcomes: options.outcomes,
      });
    }
    // An advance is a step of the live run, so it must record the members it
    // launched there and beat the supervisor heartbeat: without this they sat in
    // `taskIds` while `run.members` stayed stale, invisible to idle/stall
    // accounting and to status (bd-166, the wave2 record).
    if (options.origin === "advance" && options.ok) {
      recordAdvanceRunMembers({
        ctx: options.ctx,
        fleetId: options.fleetId,
        outcomes: options.outcomes,
      });
    }
  }

  function resolveLaunchPublish(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    baseBranch: string;
    flag: FleetPublishRequest | undefined;
  }): { ok: true; publish: FleetPublish } | { ok: false; text: string } {
    // `.belayd/config.json` is repo-scoped: `gitCommonDir` is shared by every
    // worktree, so its parent is the main checkout and the config is read from
    // there even when the launch runs in a linked worktree. That is intended.
    const config = readFleetPublishConfig({ repoRoot: dirname(options.gitCommonDir) });
    for (const warning of config.warnings) options.ctx.ui.notify(warning, "warning");
    const resolved = resolveFleetPublish({
      ...(options.flag === undefined ? {} : { flag: options.flag }),
      ...(config.configFile === undefined ? {} : { configFile: config.configFile }),
      ...(config.gitConfig === undefined ? {} : { gitConfig: config.gitConfig }),
      baseBranch: options.baseBranch,
    });
    return resolved.ok
      ? { ok: true, publish: resolved.publish }
      : { ok: false, text: resolved.error };
  }

  async function runFleetLaunch(options: {
    ctx: ExtensionContext;
    taskIds: readonly string[];
    fleetId: string;
    requestedConcurrency?: number;
    /** `advance` when the worklist came from the persisted deferred plan (P4). */
    origin?: "launch" | "advance";
    /** Partial publish contract from the flag surface; completed at resolve time. */
    publish?: FleetPublishRequest;
    /**
     * Start (or resume) the run-to-completion loop after this launch.
     *
     * Absent means "explicit mode": the fleet launches, lands, and advances only
     * when the operator calls a tool. An advance never seeds a run — it is the
     * loop's own step.
     */
    runMode?: { accept: boolean };
  }): Promise<FleetLaunchResult> {
    const { ctx } = options;
    const state = getSessionState(ctx);
    const blocked = fleetLaunchBlockedText(state);
    if (blocked !== undefined) return { ok: false, text: blocked };

    const common = gitCommonDirFor(ctx.cwd);
    if (!common.ok) {
      return { ok: false, text: `Fleet launch needs a git repository: ${common.error}` };
    }
    const resolvedBaseBranch = currentBaseBranch(ctx.cwd);
    // The publish mode is resolved EXACTLY ONCE per launch call (flag → repo
    // config → git config → local) and frozen into the intent. A re-arm or an
    // advance reads the recorded contract instead: `mergeFleetIntent` keeps the
    // current intent's `publish`/`baseBranch`, so a mid-run config edit cannot
    // change where the fleet lands. An invalid contract is refused here, before
    // any worktree, intent write, or arm.
    const resolvedPublish = resolveLaunchPublish({
      ctx,
      gitCommonDir: common.gitCommonDir,
      baseBranch: resolvedBaseBranch,
      flag: options.publish,
    });
    if (!resolvedPublish.ok) return { ok: false, text: resolvedPublish.text };

    // Minted per arming and kept only in this session's memory: the intent carries
    // it, so the on-disk record alone is not enough to become the supervisor.
    const armToken = randomUUID();
    const pidStartTime = readProcessStartTime(process.pid);
    // A session supervises one fleet. Pass the fleet it actually holds (derived
    // from its arm token, not from a record alone) so validation can refuse a
    // second fleet before any write.
    const supervised = fleetModeFor(ctx);

    const result = await runFleetLaunchEngine(
      fleetLaunchEngineOptions({
        ctx,
        options,
        gitCommonDir: common.gitCommonDir,
        armToken,
        supervisedFleetId: supervised?.fleetId,
        baseBranch: resolvedBaseBranch,
        publish: resolvedPublish.publish,
        ...(pidStartTime === undefined ? {} : { pidStartTime }),
      }),
    );

    const applied = applyFleetLaunchResult({
      ctx,
      state,
      result,
      armToken,
      pinSupervisor: options.origin !== "advance",
    });
    recordLaunchFollowUp({
      ctx,
      state,
      fleetId: result.fleetId,
      ok: applied.ok,
      outcomes: applied.outcomes ?? [],
      runMode: options.runMode,
      origin: options.origin,
    });
    return applied;
  }

  /**
   * Record an advance's launches in the live run, then beat the heartbeat (bd-166).
   *
   * The ticker path already extends the run it holds in memory; the tool path is a
   * fresh call that never saw the run, and an advance that launched nothing still
   * needs the beat so a later session can tell a busy supervisor from a dead one.
   * Both are idempotent: re-recording a member replaces its launch entry.
   */
  function recordAdvanceRunMembers(options: {
    ctx: ExtensionContext;
    fleetId: string;
    outcomes: readonly FleetMemberLaunchOutcome[];
  }): void {
    const mode = fleetModeFor(options.ctx);
    if (mode === undefined || mode.fleetId !== options.fleetId) return;
    const now = Date.now();
    if (options.outcomes.length > 0) {
      const written = mutateFleetIntent({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        mutate: (intent) => {
          const run = intent.run;
          if (run === undefined || !isFleetRunActive(run)) return intent;
          return {
            ...intent,
            run: extendRunWithLaunches({ run, outcomes: options.outcomes, now }),
            updatedAt: now,
          };
        },
      });
      if (!written.ok) {
        options.ctx.ui.notify(
          `Fleet ${mode.fleetId}: could not record the advanced member(s) in the run: ${written.error}`,
          "warning",
        );
      }
    }
    const beat = writeSupervisorHeartbeat({
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      sessionId: options.ctx.sessionManager.getSessionId(),
      pid: process.pid,
      now,
    });
    if (!beat.ok) {
      options.ctx.ui.notify(
        `Fleet ${mode.fleetId}: could not write the supervisor heartbeat: ${beat.error}`,
        "warning",
      );
    }
  }

  /**
   * The engine's inputs, built once.
   *
   * Extracted so `runFleetLaunch` stays a readable sequence (guard, build, call,
   * record) and the seams the engine receives are in one place.
   */
  function fleetLaunchEngineOptions(input: {
    ctx: ExtensionContext;
    options: {
      taskIds: readonly string[];
      fleetId: string;
      requestedConcurrency?: number;
      origin?: "launch" | "advance";
    };
    gitCommonDir: string;
    armToken: string;
    supervisedFleetId: string | undefined;
    baseBranch: string;
    publish: FleetPublish;
    pidStartTime?: string;
  }): Parameters<typeof runFleetLaunchEngine>[0] {
    const { ctx, options } = input;
    return {
      gitCommonDir: input.gitCommonDir,
      fleetId: options.fleetId,
      taskIds: options.taskIds,
      sessionId: ctx.sessionManager.getSessionId(),
      ...(input.supervisedFleetId === undefined ? {} : { sessionFleetId: input.supervisedFleetId }),
      pid: process.pid,
      ...(input.pidStartTime === undefined ? {} : { pidStartTime: input.pidStartTime }),
      armToken: input.armToken,
      liveness: { isPidAlive: isProcessAlive, pidStartTime: readProcessStartTime },
      // bd-166: the ceiling counts orchestrators that are actually running, so the
      // engine needs per-member liveness. One snapshot per launch call, shared by
      // both capacity reads (plan and the in-write recount).
      memberLivenessFor: memberLivenessProbe(ctx, input.gitCommonDir),
      // Supervisor liveness for a run-mode fleet: its recorded pid is the shared
      // pi-web daemon and stays alive after the session dies, so the beat is the
      // only signal that says whether re-arming is safe.
      supervisorBeat: (fleetId) =>
        readSupervisorHeartbeat({ gitCommonDir: input.gitCommonDir, fleetId }),
      now: Date.now(),
      baseBranch: input.baseBranch,
      publish: input.publish,
      ...(options.requestedConcurrency === undefined
        ? {}
        : { requestedConcurrency: options.requestedConcurrency }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      probeOwnership: (taskId) => fleetMemberOwnershipError(ctx.cwd, taskId),
      launchMember: (taskId) => launchFleetMember({ ctx, taskId, base: input.baseBranch }),
      // P3 ordering: one batched, read-only `bd show --brief-deps`. Any failure
      // degrades to "no known edges" inside the seam, never to a crashed launch.
      lookupDependencies: async (taskIds) => {
        const graph = await lookupFleetDependencies({
          taskIds,
          cwd: ctx.cwd,
          runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
        });
        // A member this fleet has already merged satisfies its dependents' edges:
        // the premise bd's edge encodes ("that work is on the base branch") is true
        // even before someone closes the bead. This is the fleet-side half of
        // bd-158: bd's own blocked-ness is released by the ordering gate that
        // `landFleetMember` resolves on landing, and this rule releases the
        // scheduler at the same instant without touching the bead. Without it a run
        // would stall on its own landed work, since landing never closes a bead.
        const landed = fleetLandedTaskIds({
          gitCommonDir: input.gitCommonDir,
          fleetId: options.fleetId,
        });
        return {
          edges: graph.edges.filter((edge) => !landed.has(edge.blocker)),
          warnings: graph.warnings,
        };
      },
      // bd-158: the fleet owns its wave ordering through bd gates, so a landing
      // releases a dependent in bd without closing the blocker's bead. Created
      // before the intent write and resolved on landing / when a member or bead
      // goes away.
      orderingGates: {
        create: (gateInput) =>
          createFleetOrderingGates({
            fleetId: gateInput.fleetId,
            taskIds: gateInput.taskIds,
            edges: gateInput.edges,
            existing: gateInput.existing,
            cwd: ctx.cwd,
            runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
          }),
        resolve: (gateInput) =>
          resolveFleetOrderingGates({
            gates: gateInput.gates,
            cwd: ctx.cwd,
            runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
            ...(gateInput.beadId === undefined ? {} : { beadId: gateInput.beadId }),
            ...(gateInput.blocker === undefined ? {} : { blocker: gateInput.blocker }),
          }),
        reapByPrefix: (gateInput) =>
          reapFleetOrderingGatesByPrefix({
            ...gateInput,
            cwd: ctx.cwd,
            runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
          }),
      },
    };
  }

  /** Members this fleet has landed (merged into the base branch) but not yet pruned. */
  function fleetLandedTaskIds(options: {
    gitCommonDir: string;
    fleetId: string;
  }): ReadonlySet<string> {
    const loaded = readFleetIntent(options);
    const members = loaded.ok ? (loaded.intent?.run?.members ?? []) : [];
    return new Set(
      members.filter((member) => member.landedAt !== undefined).map((member) => member.taskId),
    );
  }

  /**
   * Seed (or extend) the run record after a launch and start the loop.
   *
   * A launch on a fleet that is already running adds members to the live run
   * instead of starting a new one: two run records would each think they own the
   * member list, and the older one would re-plan work the newer one landed.
   */
  function startFleetRunAfterLaunch(options: {
    ctx: ExtensionContext;
    state: FleetState;
    fleetId: string;
    accept: boolean;
    outcomes: readonly FleetMemberLaunchOutcome[];
  }): void {
    const mode = fleetModeFor(options.ctx);
    if (mode === undefined || mode.fleetId !== options.fleetId) return;
    const now = Date.now();
    const existing = mode.intent.run;
    const launched = options.outcomes.filter((outcome) => outcome.ok);
    const run =
      existing !== undefined && isFleetRunActive(existing)
        ? launched.reduce(
            (current, outcome) =>
              recordRunMemberLaunched({
                run: current,
                taskId: outcome.taskId,
                launchedAt: now,
                ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
              }),
            existing,
          )
        : startFleetRun({
            now,
            accept: options.accept,
            members: launched.map((outcome) => ({
              taskId: outcome.taskId,
              ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
            })),
            ...(existing === undefined ? {} : { previous: existing }),
          });
    const written = mutateFleetIntent({
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      mutate: (intent) => ({ ...intent, run, updatedAt: now }),
    });
    if (!written.ok) {
      options.ctx.ui.notify(
        `Fleet ${mode.fleetId}: could not record the run: ${written.error}`,
        "warning",
      );
      return;
    }
    writeSupervisorHeartbeat({
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      sessionId: options.ctx.sessionManager.getSessionId(),
      pid: process.pid,
      now,
    });
    startFleetRunLoop({ ctx: options.ctx, state: options.state, mode });
    options.ctx.ui.notify(
      `Fleet ${mode.fleetId}: running until every member is landed` +
        `${options.accept ? " and accepted" : ""}.` +
        " Observe with belayd_fleet_status; pause with belayd_fleet_pause.",
      "info",
    );
  }

  /** Normalize the optional fleet-id tool parameter. */
  function fleetIdParam(raw: string | undefined): string {
    return raw === undefined || raw.trim() === "" ? DEFAULT_FLEET_ID : raw.trim();
  }

  /**
   * Validate the address, fan the note out, mirror it to bd, and audit the
   * outcome.
   *
   * Split out of the tool handler so the handler stays a short orchestration of
   * "narrow the parameter → resolve the mailbox → write → report".
   *
   * A supervisor → member note is ALSO written as one bd comment per recipient
   * on the recipient's bead (bd-152). The file mailbox stays the delivery/ack
   * protocol — the comment is the human-visible mirror, so fleet traffic shows up
   * in bd/Scotty instead of only in `events/` files. The author is always a
   * `belayd:` actor, which is what keeps the mirror from ever being mistaken for
   * a human answer by the answer poll.
   */
  async function writeFleetNote(options: {
    ctx: ExtensionContext;
    resolved: FleetNoteTarget;
    kind: FleetNoteKind;
    to: string;
    body: string;
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const { ctx, resolved, kind } = options;
    const recipients = resolveFleetNoteRecipients({
      direction: resolved.channel === "events" ? "supervisor-to-member" : "member-to-supervisor",
      to: options.to,
      members: resolved.members,
    });
    if (!recipients.ok) return { ok: false, error: `Fleet note refused: ${recipients.error}` };

    const enqueued = enqueueNoteFanout({
      dir: resolved.dir,
      note: buildFleetNote({
        kind,
        from: resolved.from,
        // Replaced per recipient by the fan-out; kept as the caller asked so a
        // single-recipient note is byte-identical to the old behaviour.
        to: options.to,
        body: options.body,
        now: Date.now(),
      }),
      recipients: recipients.recipients,
    });
    if (!enqueued.ok) {
      // A partial fan-out means some members already have the note. The audit
      // records exactly the recipients whose file was written — not the request
      // — so a broadcast that reached two of three members never claims three.
      auditFleetAction({
        ctx,
        gitCommonDir: resolved.gitCommonDir,
        fleetId: resolved.fleetId,
        action: "note-partial",
        taskIds: enqueued.writtenRecipients,
        detail: `${resolved.channel} ${kind}: ${enqueued.error}`,
      });
      return { ok: false, error: `Fleet note refused: ${enqueued.error}` };
    }

    auditFleetAction({
      ctx,
      gitCommonDir: resolved.gitCommonDir,
      fleetId: resolved.fleetId,
      action: "note",
      taskIds: recipients.recipients,
      detail: `${resolved.channel} ${kind} to ${recipients.recipients.length} recipient(s)`,
    });
    const mirrored = await mirrorFleetNoteComments({
      ctx,
      resolved,
      recipients: recipients.recipients,
      body: options.body,
    });
    const audience =
      recipients.recipients.length === 1
        ? `to ${recipients.recipients[0] ?? ""}`
        : `to ${recipients.recipients.length} members (${recipients.recipients.join(", ")})`;
    return {
      ok: true,
      text:
        `Fleet \`${resolved.fleetId}\`: ${kind} from ${resolved.from} ${audience} queued in ` +
        `${resolved.channel} (${enqueued.paths.length} file(s)).` +
        (mirrored === 0 ? "" : ` Mirrored to ${mirrored} bd comment(s).`),
    };
  }

  /**
   * Mirror a supervisor → member note onto each recipient's bead (bd-152).
   *
   * Best-effort by design: the note is already in the mailbox, which is the
   * delivery protocol, so a bd refusal must never fail it. Failures are logged
   * and audited as one warning entry, and the count of written comments is
   * returned so the tool text can state what actually happened.
   */
  async function mirrorFleetNoteComments(options: {
    ctx: ExtensionContext;
    resolved: FleetNoteTarget;
    recipients: readonly string[];
    body: string;
  }): Promise<number> {
    if (options.resolved.channel !== "events") return 0;
    // An explicit actor that always starts with `belayd:` — a mirror must never
    // look like a human answer even in a session whose actor does not resolve.
    const actor = resolveSessionBdActor(options.ctx) ?? "belayd:supervisor";
    const capped = excerptComment(options.body, COMMENT_EXCERPT_MAX_CHARS);
    const settled = await Promise.allSettled(
      options.recipients.map((recipient) =>
        runBdCommand(withActorArgv(["comment", "--stdin", "--", recipient], actor), {
          cwd: options.ctx.cwd,
          stdin: `[belayd:supervisor->${recipient}] ${capped}`,
          timeoutInMs: 15_000,
          maxBufferInBytes: 1024 * 1024,
        }),
      ),
    );
    const failures = settled.filter((result) => result.status === "rejected");
    if (failures.length === 0) return settled.length;
    const reasons = failures
      .map((result) => (result.status === "rejected" ? errorText(result.reason) : ""))
      .join("; ");
    console.warn(`[belayd-harness] fleet note mirror failed: ${reasons}`);
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.resolved.gitCommonDir,
      fleetId: options.resolved.fleetId,
      action: "note-mirror-failed",
      taskIds: options.recipients,
      detail: `${failures.length} of ${settled.length} bd comment(s) not written: ${reasons}`,
    });
    return settled.length - failures.length;
  }

  /** Audit detail for an inbox drain; a partial ack is stated, never hidden. */
  function inboxDrainDetail(drainedCount: number, acked: AckNotesResult): string {
    if (acked.ok) return `${drainedCount} note(s) drained and acknowledged`;
    return (
      `${drainedCount} note(s) drained; ${acked.removed.length} acknowledged, ` +
      `${acked.remaining.length} still queued (${acked.error})`
    );
  }

  /** Render a drain plus its ack outcome, with the ack failure as an explicit field. */
  function formatFleetInboxResult(options: {
    mode: FleetMode;
    drained: { deliveries: readonly FleetNoteDelivery[]; warnings: readonly string[] };
    acked: AckNotesResult;
  }): string {
    const ackFailure = options.acked.ok
      ? {}
      : {
          ackFailure: {
            error: options.acked.error,
            removedCount: options.acked.removed.length,
            remaining: options.acked.remaining,
          },
        };
    return formatFleetInbox({
      fleetId: options.mode.fleetId,
      deliveries: options.drained.deliveries,
      warnings: options.drained.warnings,
      ...ackFailure,
    });
  }

  /**
   * The branch a member worktree currently has checked out, or an error value.
   *
   * The queue stores the branch it will merge, so it must be the branch the
   * worktree actually holds — a queue entry is not the place to guess
   * `feat/<id>` when the operator renamed the branch.
   */
  function memberMergeBranch(
    rootCwd: string,
    taskId: string,
  ): { ok: true; branch: string; worktreePath: string } | { ok: false; error: string } {
    const worktreePath = resolveWorktreePath(rootCwd, `feat/${taskId}`);
    if (worktreePath === undefined) {
      return {
        ok: false,
        error:
          `no worktree is checked out for feat/${taskId}; launch the member first ` +
          `(belayd_fleet_launch) or name the branch it actually has`,
      };
    }
    const branch = readWorktreeBranch(worktreePath);
    if (!branch.ok) {
      return { ok: false, error: `could not read the branch in ${worktreePath}` };
    }
    return { ok: true, branch: branch.branch, worktreePath };
  }

  /** `action: list` — render the queue without touching it. */
  function fleetMergeListAction(mode: FleetMode, now: number) {
    const loaded = readFleetMergeQueue({
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
    });
    if (!loaded.ok) return textToolResult(`Merge queue unavailable: ${loaded.error}`, 1);
    return textToolResult(
      formatFleetMergeQueue({ fleetId: mode.fleetId, queue: loaded.queue, now }),
      0,
    );
  }

  /** `action: enqueue` — queue exactly one member branch. */
  function fleetMergeEnqueueAction(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    task: string | undefined;
    now: number;
  }) {
    const parsed = options.task === undefined ? undefined : parseFleetTaskIds(options.task);
    if (parsed === undefined || !parsed.ok) {
      return textToolResult("belayd_fleet_merge enqueue needs a member task id (`task`).", 1);
    }
    if (parsed.taskIds.length !== 1) {
      return textToolResult(
        "belayd_fleet_merge enqueue takes exactly one task id; one merge at a time.",
        1,
      );
    }
    const taskId = parsed.taskIds[0] ?? "";
    const branch = memberMergeBranch(options.ctx.cwd, taskId);
    if (!branch.ok) return textToolResult(branch.error, 1);
    const queued = enqueueFleetMerge({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      sessionId: options.ctx.sessionManager.getSessionId(),
      taskId,
      branch: branch.branch,
      now: options.now,
    });
    if (!queued.ok) {
      return textToolResult(`Merge enqueue refused: ${queued.error}`, 1);
    }
    // An unlogged cross-tree write is a bug the operator has to see.
    for (const warning of queued.warnings) {
      options.ctx.ui.notify(warning, "warning");
      console.warn(`[belayd-harness] ${warning}`);
    }
    return textToolResult(queued.text, 0);
  }

  /** `action: drain` — one explicit merge attempt, with every warning surfaced. */
  async function fleetMergeDrainAction(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    task: string | undefined;
    now: number;
  }) {
    const parsed = options.task === undefined ? undefined : parseFleetTaskIds(options.task);
    const taskId =
      parsed === undefined || !parsed.ok || parsed.taskIds.length === 0
        ? undefined
        : parsed.taskIds[0];
    const drained = await drainFleetMerge({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      sessionId: options.ctx.sessionManager.getSessionId(),
      pid: process.pid,
      rootCwd: options.ctx.cwd,
      now: options.now,
      ...(taskId === undefined ? {} : { taskId }),
    });
    for (const warning of drained.warnings) {
      options.ctx.ui.notify(warning, "warning");
      console.warn(`[belayd-harness] ${warning}`);
    }
    if (drained.ok) {
      await releaseGatesAfterMerge({ ...options, taskId: drained.taskId });
    }
    // An empty queue is not a failure: the operator asked for the next merge and
    // there is none, which exits 0 with an explanatory result.
    const exitCode = drained.ok || drained.reason === "no-queued-entry" ? 0 : 1;
    return textToolResult(formatDrainResultText(drained), exitCode);
  }

  /**
   * Release a merged member's ordering gates outside the run's own landing step.
   *
   * Both callers have already merged: a manual `belayd_fleet_merge` drain, and the
   * opt-in acceptance after a landing (where the records are normally already gone
   * — this only catches a `fleet.json` written before the resolve). A failure is a
   * warning, not a failed merge: the work is on the base branch, and the gate stays
   * recorded for the next tick or reconcile.
   */
  async function releaseGatesAfterMerge(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    now: number;
  }): Promise<void> {
    const released = await releaseOrderingGatesForBead(options);
    if (released.ok) return;
    options.ctx.ui.notify(
      `Fleet ${options.mode.fleetId}: ${released.error}; resolve it with \`bd gate resolve\``,
      "warning",
    );
  }

  /**
   * The uniform refusal for fleet tools that need live supervision authority.
   *
   * A stale record from a dead process does not count: `fleetModeFor` re-derives
   * mode from the record, the process identity, and this session's arm token on
   * every call, so these tools can never be driven by a planted `fleet.json`.
   */
  function fleetSupervisorOnly(toolName: string): string {
    return (
      `${toolName} is supervisor-only: this session is not the live supervisor of a fleet ` +
      "(a stale supervisor record from a dead process does not count). Start one with /fleet or " +
      "belayd_fleet_launch."
    );
  }

  /**
   * Send one supervisor → member note through the validated fan-out, auditing it.
   *
   * Best effort on purpose: a pause that failed to *queue* its advisory note still
   * wrote the intent flag, which is the enforceable half, so the report says which
   * members were reached instead of failing the pause.
   */
  function announceToMembers(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    kind: FleetNoteKind;
    body: string;
  }): readonly string[] {
    const recipients = resolveFleetNoteRecipients({
      direction: "supervisor-to-member",
      to: FLEET_NOTE_BROADCAST,
      members: fleetMemberTaskIds(options.mode.intent),
    });
    if (!recipients.ok) return [];
    const enqueued = enqueueNoteFanout({
      dir: options.mode.eventsDir,
      note: buildFleetNote({
        kind: options.kind,
        from: FLEET_NOTE_SUPERVISOR,
        to: FLEET_NOTE_BROADCAST,
        body: options.body,
        now: Date.now(),
      }),
      recipients: recipients.recipients,
    });
    if (!enqueued.ok) {
      auditFleetAction({
        ctx: options.ctx,
        gitCommonDir: options.mode.gitCommonDir,
        fleetId: options.mode.fleetId,
        action: "note-partial",
        taskIds: enqueued.writtenRecipients,
        detail: `${options.kind}: ${enqueued.error}`,
      });
      return enqueued.writtenRecipients;
    }
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      action: "note",
      taskIds: enqueued.recipients,
      detail: `events ${options.kind} to ${enqueued.recipients.length} recipient(s)`,
    });
    return enqueued.recipients;
  }

  /**
   * Forceful pause: SIGTERM every member orchestrator we can positively identify.
   *
   * One process-table snapshot for all members, so two members cannot be matched
   * against two different tables. Everything that could not be proven is reported
   * as such — this path exists to stop a member that will not cooperate, not to
   * pretend a kill succeeded.
   */
  function forceStopMembers(options: { ctx: ExtensionContext; mode: FleetMode }): string[] {
    const { ctx, mode } = options;
    const scan = seams.scan();
    if (!scan.ok) {
      const warning =
        `forceful pause could not identify member sessions (${scan.reason}); nothing was ` +
        "signalled. The fleet is still paused (cooperative), so no new work starts.";
      auditFleetAction({
        ctx,
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        action: "member-stop-unavailable",
        taskIds: [...mode.intent.taskIds],
        detail: scan.reason,
      });
      return [`- forceful pause: ${warning}`];
    }

    return mode.intent.taskIds.flatMap((taskId) => stopOneMember({ ctx, mode, scan, taskId }));
  }

  /**
   * Stop one member and report every matched pid separately.
   *
   * One process-table snapshot is shared by all members (two members must not be
   * matched against two different tables), but each pid is re-verified and
   * signalled on its own: a pid that was recycled is skipped while its sibling is
   * still signalled, and one failing kill does not abort the rest.
   */
  function stopOneMember(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    scan: ReturnType<typeof scanProcesses>;
    taskId: string;
  }): string[] {
    const { ctx, mode, scan, taskId } = options;
    const token = memberSessionToken(taskId);
    let outcome: ReturnType<typeof stopMemberSession>;
    try {
      outcome = stopMemberSession({
        taskId,
        scan,
        selfPid: process.pid,
        signal: seams.signal,
        ...(seams.probe === undefined ? {} : { probe: seams.probe }),
        ...(seams.startTime === undefined ? {} : { startTime: seams.startTime }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      auditFleetAction({
        ctx,
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        action: "member-stop-failed",
        taskIds: [taskId],
        detail: `${detail} (session token ${token})`,
      });
      return [`- forceful pause: ${taskId} could not be signalled (${detail})`];
    }
    if (!outcome.ok) {
      auditFleetAction({
        ctx,
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        action: "member-stop-skipped",
        taskIds: [taskId],
        detail: `${outcome.reason}: ${outcome.error}`,
      });
      return [`- forceful pause: ${taskId} not signalled — ${outcome.error}`];
    }

    const lines = outcome.outcomes.flatMap((pidOutcome) =>
      reportMemberPidOutcome({ ctx, mode, taskId, token, pidOutcome }),
    );
    if (outcome.pids.length === 0 && outcome.outcomes.length > 0) {
      lines.push(
        `- forceful pause: ${taskId} had matched orchestrator pids but none was signalled; ` +
          "the cooperative pause is the only stop that applied",
      );
    }
    return lines;
  }

  /**
   * Report and audit one matched pid's outcome.
   *
   * Every line and audit detail names the matched `belayd-<taskId>` token, so the
   * pid can be tied back to the identity it was signalled as after the process is
   * gone.
   */
  function reportMemberPidOutcome(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    token: string;
    pidOutcome: MemberPidOutcome;
  }): string[] {
    const { ctx, mode, taskId, token, pidOutcome } = options;
    const audit = (action: string, detail: string): void => {
      auditFleetAction({
        ctx,
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        action,
        taskIds: [taskId],
        detail,
      });
    };
    switch (pidOutcome.kind) {
      case "signalled":
        audit("member-stopped", `SIGTERM sent to pid ${pidOutcome.pid} (session token ${token})`);
        return [
          `- forceful pause: SIGTERM sent to ${taskId}'s orchestrator pid ${pidOutcome.pid} ` +
            "(delivery only: verify the session stopped and the worktree is clean before relaunching)",
        ];
      case "skipped":
        audit(
          "member-stop-skipped",
          `pid ${pidOutcome.pid} (session token ${token}): ${pidOutcome.reason}: ${pidOutcome.detail}`,
        );
        return [
          `- forceful pause: ${taskId} pid ${pidOutcome.pid} was NOT signalled — ` +
            `${pidOutcome.reason}: ${pidOutcome.detail}`,
        ];
      case "failed":
        audit(
          "member-stop-failed",
          `pid ${pidOutcome.pid} (session token ${token}): ${pidOutcome.error}`,
        );
        return [
          `- forceful pause: ${taskId} pid ${pidOutcome.pid} could not be signalled ` +
            `(${pidOutcome.error}); the other matched pids were signalled`,
        ];
    }
  }

  /**
   * Fleets whose intent records this session as supervisor (bd-166).
   *
   * The authority rule for a cross-fleet repair: naming another fleet must not by
   * itself make the caller its supervisor, but a session that supervises *some*
   * fleet in this repository is the operator's agent for the rest of it too. Read
   * from the records, so a leaderless fleet is reachable without a hand edit.
   */
  function sessionSupervisedFleetIds(ctx: ExtensionContext, gitCommonDir: string): string[] {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getSessionState(ctx);
    const pidStartTime = readProcessStartTime(process.pid);
    const supervised: string[] = [];
    for (const directoryId of listFleetIds({ gitCommonDir })) {
      const loaded = readFleetIntent({ gitCommonDir, fleetId: directoryId });
      if (!loaded.ok || loaded.intent === undefined) continue;
      const fleetId = sanitizeFleetId(directoryId);
      // Same anchors as own-fleet mode, minus the requirement to hold the fleet:
      // a resumed session keeps its id but not the recorded process/token, so it
      // must not inherit cross-fleet repair authority from a stale record.
      const matches = sessionSupervisesFleetRecord({
        supervisor: loaded.intent.supervisor,
        sessionId,
        ...(state.fleetArm === undefined ? {} : { armToken: state.fleetArm }),
        liveness: {
          isPidAlive: isProcessAlive,
          ...(pidStartTime === undefined ? {} : { pidStartTime: readProcessStartTime }),
        },
        fleetId,
      });
      if (matches) supervised.push(fleetId);
    }
    return supervised;
  }

  /**
   * Refuse a cross-fleet repair unless this session supervises some fleet (bd-166),
   * and audit the named target when it may proceed.
   */
  function reconcileAuthorityRefusal(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    own: FleetMode | undefined;
    targetFleetId: string;
    pruneDeadMembers: boolean;
  }): string | undefined {
    const supervised = sessionSupervisedFleetIds(options.ctx, options.gitCommonDir);
    const authority = reconcileAuthority({
      targetFleetId: options.targetFleetId,
      ...(options.pruneDeadMembers === true ? { pruneDeadMembers: true } : {}),
      ...(options.own === undefined ? {} : { ownFleetId: options.own.fleetId }),
      supervisedFleetIds: supervised,
      repoFleetIds: listFleetIds({ gitCommonDir: options.gitCommonDir }),
      sessionId: options.ctx.sessionManager.getSessionId(),
    });
    if (!authority.ok) return authority.error;
    if (!authority.crossFleet) return undefined;
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.gitCommonDir,
      fleetId: options.targetFleetId,
      action: "reconcile-cross-fleet",
      taskIds: [],
      detail: `target \`${options.targetFleetId}\`; session supervises ${supervised.join(", ")}`,
    });
    return undefined;
  }

  /** Which fleet this reconcile call may repair, or the refusal text. */
  function resolveReconcileTarget(options: {
    ctx: ExtensionContext;
    requested: string | undefined;
    pruneDeadMembers: boolean;
  }): { ok: true; mode: FleetMode } | { ok: false; text: string } {
    const own = fleetModeFor(options.ctx);
    const requestedFleetId =
      options.requested === undefined || options.requested.trim() === ""
        ? undefined
        : options.requested.trim();
    if (own === undefined && requestedFleetId === undefined) {
      return { ok: false, text: fleetSupervisorOnly("belayd_fleet_reconcile") };
    }
    const common = gitCommonDirFor(options.ctx.cwd);
    if (!common.ok) {
      return { ok: false, text: `Fleet reconcile needs a git repository: ${common.error}` };
    }
    const targetFleetId = sanitizeFleetId(requestedFleetId ?? own?.fleetId ?? DEFAULT_FLEET_ID);
    const mode = fleetModeForId({ gitCommonDir: common.gitCommonDir, fleetId: targetFleetId });
    if (mode === undefined) {
      return {
        ok: false,
        text:
          `No fleet intent for \`${targetFleetId}\` under ${common.gitCommonDir}; nothing to ` +
          "reconcile.",
      };
    }
    const refusal = reconcileAuthorityRefusal({
      ctx: options.ctx,
      gitCommonDir: common.gitCommonDir,
      own,
      targetFleetId,
      pruneDeadMembers: options.pruneDeadMembers,
    });
    return refusal === undefined ? { ok: true, mode } : { ok: false, text: refusal };
  }

  /** A release request's decision, or the refusal text (bd-166). */
  function planFleetRelease(options: { ctx: ExtensionContext; taskId: string }):
    | {
        ok: true;
        mode: FleetMode;
        taskId: string;
        already: boolean;
        liveness: FleetMemberLiveness;
      }
    | { ok: false; text: string } {
    const mode = fleetModeFor(options.ctx);
    if (mode === undefined) {
      return { ok: false, text: fleetSupervisorOnly("belayd_fleet_release") };
    }
    const taskId = options.taskId.trim();
    const loaded = readFleetIntent({
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
    });
    if (!loaded.ok) {
      return { ok: false, text: `Could not read the fleet intent: ${loaded.error}` };
    }
    if (loaded.intent === undefined) {
      return { ok: false, text: `No fleet intent for \`${mode.fleetId}\`; nothing to release.` };
    }
    if (!loaded.intent.taskIds.includes(taskId)) {
      return {
        ok: false,
        text:
          `${taskId} is not a member of fleet \`${mode.fleetId}\`; its members are ` +
          `${loaded.intent.taskIds.join(", ") || "(none)"}`,
      };
    }
    if ((loaded.intent.released ?? []).some((entry) => entry.taskId === taskId)) {
      return {
        ok: true,
        mode,
        taskId,
        already: true,
        liveness: { kind: "unknown", reason: "already released" },
      };
    }
    const liveness = memberLivenessProbe(options.ctx, mode.gitCommonDir)(mode.fleetId, taskId);
    // The same evidence reconcile trusts: a live lease (or a member argv token)
    // means something is really running, and releasing it out from under itself
    // would let the next fleet start a fourth orchestrator.
    if (liveness.kind === "live") {
      return {
        ok: false,
        text:
          `Fleet release refused: ${taskId}'s orchestrator is live, so it still holds a real ` +
          "slot. Stop it (belayd_fleet_pause) or let it land; a running member is never " +
          "released out from under itself.",
      };
    }
    return { ok: true, mode, taskId, already: false, liveness };
  }

  /**
   * Write the release entry, re-deciding inside the compare-and-replace (bd-166).
   *
   * `released: false` means every call is idempotent: a second release finds the
   * entry and reports that, instead of appending a duplicate.
   */
  function applyFleetRelease(options: {
    mode: FleetMode;
    taskId: string;
    now: number;
  }): { ok: true; released: boolean } | { ok: false; error: string } {
    let released = false;
    const written = mutateFleetIntent({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      mutate: (intent) => {
        if (!intent.taskIds.includes(options.taskId)) {
          return { refuse: `${options.taskId} is no longer a member` };
        }
        const existing = intent.released ?? [];
        if (existing.some((entry) => entry.taskId === options.taskId)) {
          released = false;
          return intent;
        }
        released = true;
        return {
          ...intent,
          released: [
            ...existing,
            { taskId: options.taskId, reason: "operator-release", at: options.now },
          ],
          updatedAt: options.now,
        };
      },
    });
    return written.ok ? { ok: true, released } : { ok: false, error: written.error };
  }

  /** Narrow a note kind parameter; undefined means "not a known kind". */
  function normalizeFleetNoteKind(raw: string | undefined): FleetNoteKind | undefined {
    if (raw === undefined || raw.trim() === "") return "note";
    const candidate = raw.trim();
    return isFleetNoteKind(candidate) ? candidate : undefined;
  }

  interface FleetNoteTarget {
    ok: true;
    gitCommonDir: string;
    fleetId: string;
    dir: string;
    channel: "inbox" | "events";
    from: string;
    /** Fleet members from the intent: the audience a note's `to` is checked against. */
    members: readonly string[];
  }

  /**
   * Resolve where a note goes, who it is from, and which mailbox it lands in.
   *
   * Defaults follow the direction of travel: a supervisor writes to `events/`
   * (its messages are for members), a member writes to `inbox/` (its messages
   * are for the supervisor). The channel can be overridden explicitly, but the
   * fleet itself cannot: a session may only write into a fleet it supervises or
   * is a member of.
   */
  function resolveFleetNoteTarget(options: {
    ctx: ExtensionContext;
    fleetId: string | undefined;
    channel: string | undefined;
  }): FleetNoteTarget | { ok: false; error: string } {
    const { ctx } = options;
    const common = gitCommonDirFor(ctx.cwd);
    if (!common.ok)
      return { ok: false, error: `Fleet mail needs a git repository: ${common.error}` };

    const requestedFleetId =
      options.fleetId === undefined || options.fleetId.trim() === ""
        ? undefined
        : sanitizeFleetId(options.fleetId.trim());
    const channel = normalizeFleetChannel(options.channel);
    if (!channel.ok) return channel;

    // A supervisor's own fleet wins; otherwise the session writes as a member.
    const supervised = fleetModeFor(ctx);
    if (supervised !== undefined) {
      if (requestedFleetId !== undefined && requestedFleetId !== supervised.fleetId) {
        return {
          ok: false,
          error: `This session supervises fleet \`${supervised.fleetId}\`, not \`${requestedFleetId}\`.`,
        };
      }
      return supervisorNoteTarget(supervised, channel.channel);
    }
    return memberNoteTarget({
      ctx,
      gitCommonDir: common.gitCommonDir,
      requestedFleetId,
      channel: channel.channel,
    });
  }

  /** Narrow the optional `channel` parameter to the two mailboxes. */
  function normalizeFleetChannel(
    raw: string | undefined,
  ): { ok: true; channel: "inbox" | "events" | undefined } | { ok: false; error: string } {
    if (raw === undefined) return { ok: true, channel: undefined };
    if (raw === "inbox" || raw === "events") return { ok: true, channel: raw };
    return { ok: false, error: "channel must be `inbox` or `events`" };
  }

  /** A supervisor addresses members: default mailbox `events/`. */
  function supervisorNoteTarget(
    mode: FleetMode,
    channel: "inbox" | "events" | undefined,
  ): FleetNoteTarget {
    const resolved = channel ?? "events";
    return {
      ok: true,
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      dir: resolved === "inbox" ? mode.inboxDir : mode.eventsDir,
      channel: resolved,
      from: FLEET_NOTE_SUPERVISOR,
      // Deferred members are addressable too: mail queued for a member that has not
      // started yet is delivered at that session's first turn, and the P0 member
      // *count* stays `taskIds`-only (a deferred member has no worktree to observe).
      members: fleetMemberTaskIds(mode.intent),
    };
  }

  /** A member addresses the supervisor: default mailbox `inbox/`. */
  function memberNoteTarget(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    requestedFleetId: string | undefined;
    channel: "inbox" | "events" | undefined;
  }): FleetNoteTarget | { ok: false; error: string } {
    const { ctx } = options;
    const state = getSessionState(ctx);
    const memberTaskId =
      state.currentTaskId !== ""
        ? state.currentTaskId
        : (readWorkflowState({ cwd: ctx.cwd })?.taskId ?? "");
    const member = memberTaskId === "" ? undefined : memberFleetFor(ctx, memberTaskId);
    if (member === undefined) {
      return {
        ok: false,
        error:
          "This session is neither a fleet supervisor nor a member of a fleet, so it has no mailbox. " +
          "Start one with /fleet or belayd_fleet_launch.",
      };
    }
    if (options.requestedFleetId !== undefined && options.requestedFleetId !== member.fleetId) {
      return {
        ok: false,
        error: `This session is a member of fleet \`${member.fleetId}\`, not \`${options.requestedFleetId}\`.`,
      };
    }
    // events/ is supervisor → member only. Letting a member write it would be
    // cross-worktree prompt injection: it could hand a sibling a fake `pause`,
    // `base-moved`, or `rebase-hint` that the sibling renders as supervisor
    // instructions. The member's own surface is inbox/ → supervisor.
    if (options.channel === "events") {
      return {
        ok: false,
        error:
          "events/ is supervisor-only: a fleet member writes to the supervisor via inbox/, so it " +
          "cannot inject a turn-start event into a sibling's session. Use channel inbox (the " +
          "default) and address `supervisor`.",
      };
    }
    return {
      ok: true,
      gitCommonDir: member.gitCommonDir,
      fleetId: member.fleetId,
      dir: member.inboxDir,
      channel: "inbox",
      from: memberTaskId,
      members: [...member.intent.taskIds],
    };
  }

  /**
   * Member-side delivery: drain this member's `events/` at turn start.
   *
   * Files-first by design (members are detached sessions, so there is no
   * in-memory channel). Bounded by note count and character budget, silent when
   * nothing is addressed to this member.
   *
   * **The ack is deferred (W4).** Selection only records the deliveries on the
   * session state; `ackFleetEventsAfterTurn` removes them in `agent_end`, after
   * the model has actually read the injected message. Acking here — before the
   * message reaches the model — would be at-most-once: a crash between ack and
   * read would lose the note silently while the docstring promised replay.
   */
  function drainFleetEventsMessage(
    ctx: ExtensionContext,
  ): { message: { customType: string; content: string; display: boolean } } | undefined {
    // A phase sub-agent shares its orchestrator's worktree and workflow state, so
    // draining here would consume the orchestrator's events in a session the
    // supervisor never addressed (and that cannot act on them).
    if (isSubAgentSession(ctx.sessionManager.getSessionName())) return undefined;
    // Delivery keys on the worktree's task id, so the fleet assumes one member
    // orchestrator per worktree (docs/fleet-launch.md "One session per
    // worktree"). A second session opened in the same worktree would drain and
    // ack that member's mail alongside its owner; bd-119 keeps a worktree pinned
    // to one bead, and the fleet launch refuses a worktree already driven, but
    // this handler deliberately does not try to tell two same-cwd sessions apart
    // (pi exposes no ownership relation between them).
    const taskId = inferredTaskId(ctx);
    if (taskId === "") return undefined;
    const fleet = memberFleetFor(ctx, taskId);
    if (fleet === undefined) return undefined;

    const batch = selectMemberEvents(fleet, taskId);
    if (batch === undefined) return undefined;

    queueFleetEventAcks(getSessionState(ctx), fleet, batch.delivered);
    return {
      message: { customType: "belayd-fleet-events", content: batch.content, display: true },
    };
  }

  /** Drain and select this member's events; undefined when nothing is addressed. */
  function selectMemberEvents(member: FleetMode, taskId: string): FleetEventBatch | undefined {
    const drained = drainNotes({ dir: member.eventsDir });
    if (!drained.ok) {
      console.warn(`[belayd-harness] fleet events drain failed: ${drained.error}`);
      return undefined;
    }
    return selectFleetEvents({
      fleetId: member.fleetId,
      taskId,
      deliveries: drained.deliveries,
    });
  }

  /**
   * Remember the events this turn injected, for the `agent_end` ack.
   *
   * Accumulates, never overwrites: a turn that drains twice before `agent_end`
   * must ack the union, not just the last batch.
   */
  function queueFleetEventAcks(
    state: FleetState,
    member: FleetMode,
    deliveries: readonly FleetNoteDelivery[],
  ): void {
    const pending = state.pendingFleetEventAcks ?? {
      fleetId: member.fleetId,
      gitCommonDir: member.gitCommonDir,
      dir: member.eventsDir,
      deliveries: [],
    };
    for (const delivery of deliveries) {
      if (!pending.deliveries.some((existing) => existing.path === delivery.path)) {
        pending.deliveries.push(delivery);
      }
    }
    state.pendingFleetEventAcks = pending;
  }

  /**
   * Ack the events injected into the turn that just ended (W4).
   *
   * Runs in `agent_end`, i.e. after the model has read the message. A crash before
   * this point leaves the files on disk and the next turn replays them: the
   * delivery guarantee for events is at-least-once, and repeats must be treated
   * as the same event. The delete is a cross-tree mutation, so it is audited.
   */
  function ackFleetEventsAfterTurn(ctx: ExtensionContext): void {
    const state = getSessionState(ctx);
    const pending = state.pendingFleetEventAcks;
    if (pending === undefined) return;
    // Clear first: a throwing ack must not make the next turn re-ack the set.
    state.pendingFleetEventAcks = undefined;
    if (pending.deliveries.length === 0) return;

    const acked = ackNotes({ dir: pending.dir, deliveries: pending.deliveries });
    const taskId = inferredTaskId(ctx);
    if (acked.ok) {
      auditFleetAction({
        ctx,
        gitCommonDir: pending.gitCommonDir,
        fleetId: pending.fleetId,
        action: "events-acked",
        taskIds: [taskId],
        detail: `${acked.removed.length} event(s) acknowledged after the turn that read them`,
      });
      return;
    }
    console.warn(`[belayd-harness] fleet events could not be acknowledged: ${acked.error}`);
    auditFleetAction({
      ctx,
      gitCommonDir: pending.gitCommonDir,
      fleetId: pending.fleetId,
      action: "events-ack-failed",
      taskIds: [taskId],
      detail: `${acked.error}; ${acked.remaining.length} event(s) remain and will be re-delivered`,
    });
  }

  /** Task id this session is working on, from memory or the worktree state. */
  function inferredTaskId(ctx: ExtensionContext): string {
    const state = getSessionState(ctx);
    return state.currentTaskId !== ""
      ? state.currentTaskId
      : (readWorkflowState({ cwd: ctx.cwd })?.taskId ?? "");
  }

  // ── Slash command: /fleet bd-12 bd-15 ──────────────────────────────
  //
  // The operator-facing entry point. It launches the members and records this
  // session as the fleet supervisor; it arms no gate, and afterwards every
  // phase/proof/commit tool is refused with the fleet message (see the
  // tool_call handler).

  /**
   * Restart the run loop if this session still holds the fleet it supervises.
   *
   * Authority is the in-memory arm token, so this only succeeds for a session that
   * reloaded in the same process. After a restart the operator re-arms with
   * `/fleet <ids> --fleet <id>`, which starts the loop again from the persisted run
   * record; a session whose *own* record still names it is repaired automatically by
   * {@link readoptFleetRuns}, which must be loud where this function can only
   * decline (bd-169).
   */
  function resumeFleetRunLoop(ctx: ExtensionContext, state: FleetState): FleetResumeOutcome {
    const mode = fleetModeFor(ctx);
    if (mode === undefined) return { resumed: false, reason: "no-fleet-mode" };
    const run = mode.intent.run;
    if (run === undefined || !isFleetRunActive(run)) {
      return { resumed: false, reason: "no-active-run" };
    }
    startFleetRunLoop({ ctx, state, mode });
    // A restarted supervisor must look like one again; `pin: false` keeps a pin the
    // operator removed from coming back after a daemon restart.
    adoptFleetSupervisorIdentity({ ctx, state, pin: false });
    ctx.ui.notify(`Fleet ${mode.fleetId}: resumed the run loop for the active run.`, "info");
    return { resumed: true, fleetId: mode.fleetId };
  }

  /** One fleet this starting session may re-adopt. */
  interface FleetReadoptionCandidate {
    mode: FleetMode;
    /** What proved the old loop is gone (`cold-beat` / `missing-beat` / `pid-dead`). */
    reason: SupervisorReadoptionReason;
    /** The supervisor record the plan decided on, for the compare-and-swap. */
    supervisor: NonNullable<FleetIntent["supervisor"]>;
    beat: SupervisorHeartbeat | undefined;
    now: number;
  }

  /** A candidate fleet plus the id it lives under (named once, not three times). */
  interface FleetReadoptionEntry {
    fleetId: string;
    candidate: FleetReadoptionCandidate;
  }

  /** What the per-fleet scan decided for one fleet id. */
  type FleetReadoptionScan =
    | { kind: "candidate"; entry: FleetReadoptionEntry }
    | { kind: "skip" }
    | {
        kind: "refused";
        fleetId: string;
        intent: FleetIntent;
        reason: SupervisorReadoptionRefusal;
        beat: SupervisorHeartbeat | undefined;
      };

  /**
   * Re-adopt the active run of a fleet whose supervisor session restarted (bd-169).
   *
   * The wave2 failure: the run loop's authority is an in-memory arm token plus the
   * arming process's identity, so a session/daemon restart ended the loop
   * permanently and silently — nothing landed, nothing warned, and
   * `belayd_fleet_status` still called the run active. This sweep applies the
   * documented re-arm rule ("the heartbeat, not the recorded pid, decides")
   * automatically, once per starting session:
   *
   * - per fleet **id** (never via `resolveFleetMode`, whose multi-fleet scan could
   *   pick the stale sibling), read the intent and the beat and ask
   *   {@link planSupervisorReadoption};
   * - a fleet the strict same-process resume already restarted is left alone;
   * - a session supervises **one** fleet, so at most one candidate is adopted (the
   *   newest run) and every other one is reported with its own recovery command;
   * - any decision that concerns this session is said out loud: silence is what made
   *   the original bug cost nine hours.
   */
  function readoptFleetRuns(options: {
    ctx: ExtensionContext;
    state: FleetState;
    /** What the strict same-process resume already handled. */
    resumed: FleetResumeOutcome;
  }): void {
    const common = gitCommonDirFor(options.ctx.cwd);
    if (!common.ok) return;
    const gitCommonDir = common.gitCommonDir;
    const sessionId = options.ctx.sessionManager.getSessionId();
    const now = Date.now();
    const pidStartTime = readProcessStartTime(process.pid);
    const candidates = collectReadoptionCandidates({
      ctx: options.ctx,
      gitCommonDir,
      sessionId,
      now,
      resumedFleetId: options.resumed.resumed ? options.resumed.fleetId : undefined,
      liveness: {
        isPidAlive: isProcessAlive,
        ...(pidStartTime === undefined ? {} : { pidStartTime: readProcessStartTime }),
      },
    });
    const newest = pickNewestReadoption(candidates);
    if (newest === undefined) return;
    const adopted = adoptFleetRun({
      ctx: options.ctx,
      state: options.state,
      gitCommonDir,
      sessionId,
      pidStartTime,
      adoption: newest,
    });
    // Only report the other candidates once the write landed: a failed adoption
    // (another session re-armed, the run finished, the CAS lost) has already been
    // reported loudly, and a skip notice claiming "this session re-adopted `<id>`"
    // would then be false (bd-169 review W3).
    if (!adopted.adopted) return;
    reportUnadoptedReadoptions({ ctx: options.ctx, gitCommonDir, chosen: newest, candidates });
  }

  /**
   * Sweep every fleet id once, reporting each refusal this session cares about.
   *
   * Explicitly per fleet id: `resolveFleetMode` answers "which fleet is mine", which
   * is the wrong question for a sweep that must look at all of them (bd-169).
   */
  function collectReadoptionCandidates(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    sessionId: string;
    now: number;
    resumedFleetId: string | undefined;
    liveness: FleetSupervisorLiveness;
  }): FleetReadoptionEntry[] {
    const candidates: FleetReadoptionEntry[] = [];
    for (const directoryId of listFleetIds({ gitCommonDir: options.gitCommonDir })) {
      const fleetId = sanitizeFleetId(directoryId);
      const scan = scanFleetReadoption({
        gitCommonDir: options.gitCommonDir,
        fleetId,
        resumedFleetId: options.resumedFleetId,
        sessionId: options.sessionId,
        now: options.now,
        liveness: options.liveness,
      });
      if (scan.kind === "candidate") {
        candidates.push(scan.entry);
        continue;
      }
      if (scan.kind === "refused") {
        warnSkippedReadoption({
          ctx: options.ctx,
          gitCommonDir: options.gitCommonDir,
          fleetId: scan.fleetId,
          intent: scan.intent,
          reason: scan.reason,
          beat: scan.beat,
          now: options.now,
        });
      }
    }
    return candidates;
  }

  /** One fleet's readoption decision, without any side effect. */
  function scanFleetReadoption(options: {
    gitCommonDir: string;
    fleetId: string;
    /** Fleet the strict same-process resume already restarted; undefined when none. */
    resumedFleetId: string | undefined;
    sessionId: string;
    now: number;
    liveness: FleetSupervisorLiveness;
  }): FleetReadoptionScan {
    // The strict path already owns this fleet: rewriting its record would invalidate
    // the live loop's own anchors. A fleet whose timer is gone is a different case
    // and is evaluated below, so a stale arm token cannot hide a dead loop.
    if (options.resumedFleetId === options.fleetId) return { kind: "skip" };
    const loaded = readFleetIntent({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
    });
    if (!loaded.ok || loaded.intent === undefined) return { kind: "skip" };
    const beat = readSupervisorHeartbeat({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
    });
    const plan = planSupervisorReadoption({
      intent: loaded.intent,
      sessionId: options.sessionId,
      beat,
      now: options.now,
      liveness: options.liveness,
    });
    if (!plan.adopt) {
      return {
        kind: "refused",
        fleetId: options.fleetId,
        intent: loaded.intent,
        reason: plan.reason,
        beat,
      };
    }
    const mode = fleetModeForId({ gitCommonDir: options.gitCommonDir, fleetId: options.fleetId });
    if (mode === undefined) return { kind: "skip" };
    return {
      kind: "candidate",
      entry: {
        fleetId: options.fleetId,
        candidate: {
          mode,
          reason: plan.reason,
          supervisor: plan.supervisor,
          beat,
          now: options.now,
        },
      },
    };
  }

  /** The candidate to adopt when several fleets name this session: newest run wins. */
  function pickNewestReadoption(
    candidates: readonly FleetReadoptionEntry[],
  ): FleetReadoptionEntry | undefined {
    return [...candidates].sort((left, right) => {
      const leftAt = left.candidate.mode.intent.run?.updatedAt ?? 0;
      const rightAt = right.candidate.mode.intent.run?.updatedAt ?? 0;
      if (rightAt !== leftAt) return rightAt - leftAt;
      return left.fleetId < right.fleetId ? -1 : left.fleetId > right.fleetId ? 1 : 0;
    })[0];
  }

  /** Name every fleet this session could have adopted but did not (bd-169). */
  function reportUnadoptedReadoptions(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    chosen: FleetReadoptionEntry;
    candidates: readonly FleetReadoptionEntry[];
  }): void {
    for (const other of options.candidates) {
      if (other.fleetId === options.chosen.fleetId) continue;
      const line =
        `Fleet ${other.fleetId}: not re-adopted — this session supervises one fleet, and ` +
        `\`${options.chosen.fleetId}\` holds the newer active run. If its run should continue, ` +
        `re-arm it from another session with \`/fleet ` +
        `${other.candidate.mode.intent.taskIds.join(" ")} --fleet ${other.fleetId}\`.`;
      options.ctx.ui.notify(line, "warning");
      console.warn(`[belayd-harness] ${line}`);
      auditFleetAction({
        ctx: options.ctx,
        gitCommonDir: options.gitCommonDir,
        fleetId: other.fleetId,
        action: "supervisor-readopt-skipped",
        taskIds: other.candidate.mode.intent.taskIds,
        detail: `this session re-adopted \`${options.chosen.fleetId}\` instead (one fleet per session)`,
      });
    }
  }

  /**
   * Report an active run that **no session can be expected to pick up** (bd-169).
   *
   * Only a leaderless record qualifies (no supervisor, or an empty session id): a
   * record that names a real session is either that session's own — where a dead loop
   * is *adopted*, not refused, so a refusal means a live beat — or another session's
   * business. Reporting either as "nothing is ticking it" would be false.
   */
  function warnSkippedReadoption(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    fleetId: string;
    intent: FleetIntent;
    reason: SupervisorReadoptionRefusal;
    beat: SupervisorHeartbeat | undefined;
    now: number;
  }): void {
    // A finished or halted run is a terminal state the tick already announced and
    // recorded (`fleet-run-complete` / `fleet-run-halted`); re-warning on every
    // session start would be noise, not information. An explicit `--manual` fleet has
    // no run record at all, so it stays legitimately leaderless and quiet.
    if (options.reason === "no-active-run") return;
    const recordedSessionId = options.intent.supervisor?.sessionId ?? "";
    if (recordedSessionId !== "") return;
    // Recency is the only signal a leaderless record has: a fresh beat proves some
    // session *is* ticking the run, the record just does not say which. Reporting that
    // as dead would call a healthy fleet unticked (bd-169 W1); status is the surface.
    if (!isFleetLoopProvablyDead({ beat: options.beat, now: options.now })) return;
    // A wedge alarm, not a per-start pulse (bd-169 W2): every session start would
    // otherwise re-notify and re-audit for as long as the record stays leaderless. The
    // fleet's own append-only audit log is the durable dedup store — no new file, no
    // global state — and the window is the beat-stale constant because that is how
    // long a "dead loop" verdict is allowed to stay true. The status warning (bd-166)
    // still covers the silent case, so a suppressed repeat hides nothing.
    if (leaderlessReportedRecently(options)) return;
    const beatAge =
      options.beat === undefined
        ? "no heartbeat"
        : `beat ${options.now - options.beat.heartbeatAt} ms old`;
    // The refusal alone does not say what the record looks like: a missing record and a
    // record whose session id is empty both refuse as "leaderless", but only the first
    // can be repaired by writing a supervisor. Carry that distinction into the audit so
    // a reader can tell them apart.
    const recordState =
      options.intent.supervisor === undefined
        ? "no supervisor record"
        : "supervisor record carries an empty session id";
    const line =
      `Fleet ${options.fleetId}: the active run has no usable supervisor record ` +
      `(${options.reason}; ${beatAge}), so nothing is ticking it. Recover with ` +
      `\`/fleet ${options.intent.taskIds.join(" ")} --fleet ${options.fleetId}\`.`;
    options.ctx.ui.notify(line, "warning");
    console.warn(`[belayd-harness] ${line}`);
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
      action: "supervisor-readopt-refused",
      taskIds: options.intent.taskIds,
      detail: `${options.reason}; ${beatAge}; ${recordState}`,
    });
  }

  /** Whether this fleet already had a leaderless report inside the cooldown window. */
  function leaderlessReportedRecently(options: {
    gitCommonDir: string;
    fleetId: string;
    now: number;
  }): boolean {
    return (
      readRecentFleetAuditEntries({
        gitCommonDir: options.gitCommonDir,
        fleetId: options.fleetId,
        since: options.now - FLEET_SUPERVISOR_HEARTBEAT_STALE_MS,
        action: "supervisor-readopt-refused",
      }).length > 0
    );
  }

  /**
   * The anchors that authorised the adoption, re-checked under the compare-and-swap.
   *
   * The sweep decided from a snapshot; between that read and this write an operator
   * may have re-armed the fleet from another session — a legitimate
   * `/fleet <ids> --fleet <id>`. Overwriting that fresh record with a token minted
   * here would leave a live supervisor whose next tick dies with "no longer the live
   * supervisor", so the run must still be active, the record must still name this
   * session, and the supervisor identity the scan saw must be unchanged.
   *
   * `expected` is required because only the plan's adopt arm (which carries the record
   * it decided on) reaches here: the type states that invariant instead of a runtime
   * branch that could mask a future caller's mistake.
   */
  function readoptionWriteRefusal(options: {
    intent: FleetIntent;
    expected: NonNullable<FleetIntent["supervisor"]>;
    sessionId: string;
  }): string | undefined {
    if (!isFleetRunActive(options.intent.run)) {
      return `the run of \`${options.intent.fleetId}\` is no longer active`;
    }
    const current = options.intent.supervisor;
    if (current === undefined || current.sessionId !== options.sessionId) {
      return (
        "another session re-armed the fleet (the supervisor record now names " +
        `\`${current?.sessionId ?? "nobody"}\`)`
      );
    }
    return readoptionIdentityDrift({ expected: options.expected, current });
  }

  /**
   * Which supervisor identity field changed between the sweep's read and the write.
   *
   * Every comparison is exact, including a field absent on both sides: an arming
   * writes `pidStartTime` and `armToken` when it has them, so a record that *gains*
   * one has been re-armed even though the field the scan saw was `undefined`. Skipping
   * the check for an absent expected value would let exactly that re-arm through.
   */
  function readoptionIdentityDrift(options: {
    expected: NonNullable<FleetIntent["supervisor"]>;
    current: NonNullable<FleetIntent["supervisor"]>;
  }): string | undefined {
    if (options.current.pid !== options.expected.pid) {
      return `the recorded supervisor pid changed (${options.expected.pid} -> ${options.current.pid})`;
    }
    if (options.current.pidStartTime !== options.expected.pidStartTime) {
      return "the recorded supervisor process start time changed";
    }
    if (options.current.armToken !== options.expected.armToken) {
      return "the recorded arm token changed (another arming wrote this fleet)";
    }
    return undefined;
  }

  /** Outcome of an adoption attempt: skips are only reported when this succeeded. */
  type FleetReadoptionResult = { adopted: true; intent: FleetIntent } | { adopted: false };

  /**
   * Take over one fleet's active run: rewrite the supervisor record with a fresh arm
   * token, then start the loop (bd-169).
   *
   * The token is minted here and kept in memory only (W6): persisting it would let a
   * planted record impersonate a supervisor. The re-check inside the mutation makes
   * the write refuse a run that finished — or a fleet another session re-armed —
   * between the sweep's read and this update, and a refusal is reported with the
   * recovery command rather than returning quietly (review W2/W3).
   */
  function adoptFleetRun(options: {
    ctx: ExtensionContext;
    state: FleetState;
    gitCommonDir: string;
    sessionId: string;
    pidStartTime: string | undefined;
    adoption: FleetReadoptionEntry;
  }): FleetReadoptionResult {
    const { ctx, state, adoption } = options;
    const fleetId = adoption.fleetId;
    const armToken = randomUUID();
    const written = mutateFleetIntent({
      gitCommonDir: options.gitCommonDir,
      fleetId,
      mutate: (intent) => {
        const refusal = readoptionWriteRefusal({
          intent,
          expected: adoption.candidate.supervisor,
          sessionId: options.sessionId,
        });
        if (refusal !== undefined) return { refuse: refusal };
        return {
          ...intent,
          supervisor: createFleetSupervisorRecord({
            sessionId: options.sessionId,
            pid: process.pid,
            ...(options.pidStartTime === undefined ? {} : { pidStartTime: options.pidStartTime }),
            armToken,
          }),
          updatedAt: adoption.candidate.now,
        };
      },
    });
    if (!written.ok) {
      warnReadoptionFailed({
        ctx,
        gitCommonDir: options.gitCommonDir,
        entry: adoption,
        error: written.error,
      });
      return { adopted: false };
    }
    state.fleetArm = { fleetId, token: armToken };
    const beat = writeSupervisorHeartbeat({
      gitCommonDir: options.gitCommonDir,
      fleetId,
      sessionId: options.sessionId,
      pid: process.pid,
      now: adoption.candidate.now,
    });
    if (!beat.ok) {
      ctx.ui.notify(
        `Fleet ${fleetId}: could not write the supervisor heartbeat: ${beat.error}`,
        "warning",
      );
    }
    startFleetRunLoop({ ctx, state, mode: adoption.candidate.mode });
    adoptFleetSupervisorIdentity({ ctx, state, pin: false });
    // The audit describes the record that was actually written, not the scan
    // snapshot: a CAS retry can move the tick count (review S1).
    const adoptedIntent = written.intent;
    const previousBeat =
      adoption.candidate.beat === undefined
        ? "no previous heartbeat"
        : `previous heartbeat ${adoption.candidate.now - adoption.candidate.beat.heartbeatAt} ms old`;
    auditFleetAction({
      ctx,
      gitCommonDir: options.gitCommonDir,
      fleetId,
      action: "supervisor-readopted",
      taskIds: adoptedIntent.taskIds,
      detail:
        `${adoption.candidate.reason}; ${previousBeat}; ` +
        `run at tick ${adoptedIntent.run?.ticks ?? 0}`,
    });
    ctx.ui.notify(
      `Fleet ${fleetId}: re-adopted the active run after a restart (${adoption.candidate.reason}); ` +
        "the loop is ticking again.",
      "info",
    );
    return { adopted: true, intent: adoptedIntent };
  }

  /** Say that an adoption write was refused and the run is still unticked (bd-169). */
  function warnReadoptionFailed(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    entry: FleetReadoptionEntry;
    error: string;
  }): void {
    const taskIds = options.entry.candidate.mode.intent.taskIds;
    const line =
      `Fleet ${options.entry.fleetId}: could not re-adopt the active run ` +
      `(${options.error}), so nothing is ticking it. Recover with \`/fleet ` +
      `${taskIds.join(" ")} --fleet ${options.entry.fleetId}\`.`;
    options.ctx.ui.notify(line, "warning");
    console.warn(`[belayd-harness] ${line}`);
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.gitCommonDir,
      fleetId: options.entry.fleetId,
      action: "supervisor-readopt-failed",
      taskIds,
      detail: options.error,
    });
  }

  /**
   * Fleet-mode refusal for one tool call, or undefined when the call is fine.
   *
   * A gated or planning session is never a supervisor (fleet mode arms no gate),
   * so this can never pre-empt the process gate or the bd-119 ownership preflight
   * with a fleet message — a member keeps its own refusal.
   */
  function fleetRefusalFor(options: {
    ctx: ExtensionContext;
    state: FleetState;
    toolName: string;
  }): string | undefined {
    if (options.state.gateActive || options.state.planningActive) return undefined;
    if (!isFleetRefusedTool(options.toolName)) return undefined;
    const mode = fleetModeFor(options.ctx);
    if (mode === undefined) return undefined;
    return formatFleetRefusal({ toolName: options.toolName, fleetId: mode.fleetId });
  }

  pi.registerTool({
    name: "belayd_fleet_status",
    label: "Belayd fleet status",
    description:
      "Read-only fleet status: aggregates every git worktree's Belayd workflow into one " +
      "view (task id, bead title/status, owner, assignee, human flag, bead update time, " +
      "comment count, human-gate wait, newest comment, branch, workflow type, " +
      "completed/pending phases, " +
      "latest run per phase with its status, interrupted-run count, last update, derived " +
      "state) and warns about duplicate task ids, workflow task ids that disagree with the " +
      "branch or directory, and worktrees without workflow state. Beads that need a person " +
      '(the `human` label or an open human gate) are named together in a "Needs you" block. ' +
      "Reads only: no writes, no merges, no spawns, no phase runs. Bead metadata is one " +
      "best-effort `bd show --json` read plus `bd comments --json` and `bd gate list --json` " +
      "per member, all read-only and best-effort (bounded concurrency); without bd the view " +
      "still renders. fleetId selects " +
      `<git-common-dir>/belayd/fleet/<fleetId>/fleet.json (default: ${DEFAULT_FLEET_ID}); ` +
      "P0 never creates that file.",
    parameters: Type.Object({
      fleetId: Type.Optional(
        Type.String({
          description: `Fleet intent directory name under <git-common-dir>/belayd/fleet/ (default: ${DEFAULT_FLEET_ID})`,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const requested = params.fleetId;
      const fleetId =
        requested === undefined || requested.trim() === "" ? DEFAULT_FLEET_ID : requested.trim();
      const result = readFleetStatus({ cwd, fleetId });
      if (!result.ok) return textToolResult(result.error, 1);
      const lookup = await readFleetBeads(result.value, cwd);
      const engagement = await readFleetEngagement(result.value, cwd);
      const enriched = applyFleetBeadEngagement(
        applyFleetBeadLookup(result.value, lookup),
        engagement,
      );
      return textToolResult(formatFleetStatus(enriched), 0);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_launch",
    label: "Belayd fleet launch",
    description:
      "Launch several beads as concurrent Belayd workflows, each in its own worktree and detached " +
      "orchestrator session, and record them in the fleet intent " +
      "(<git-common-dir>/belayd/fleet/<fleetId>/fleet.json). Validates every task id first: an " +
      "invalid, duplicated, already-member, or worktree-conflicting id refuses the whole launch " +
      "with no side effects, and a worktree with a live orchestrator lease is refused (one " +
      "orchestrator per worktree). Orders members by bd's blocking dependencies (blocked-by " +
      "edges; a dependency cycle refuses the launch and names the cycle) and launches only the " +
      "free capacity: at most 3 orchestrators in flight, counting the ones already running. " +
      "Every dependency edge between two members gets its own bd ordering gate, so a dependent " +
      "unblocks when its blocker LANDS, not when its bead is closed. " +
      "Members beyond that, or in a later wave, are deferred — reported per member and recorded " +
      "in fleet.json — never silently dropped. By default (untilComplete) this session then runs " +
      "the fleet TO COMPLETION: it lands each finished member, releases the ordering gates its " +
      "landing satisfied, and starts the next wave as dependencies clear, until every member is " +
      "landed. Landing never closes a bead: each one is left in_progress + human for you to " +
      "accept, unless accept=true (then the bead is closed and the worktree removed). " +
      "untilComplete=false keeps the explicit surface " +
      "(belayd_fleet_merge / belayd_fleet_advance on call). The launch freezes a publish " +
      "contract into fleet.json (default local: merged work stays local, no remote and no " +
      "network); the resolved value is never re-read mid-run. This session becomes the fleet " +
      "supervisor: it runs no phases and owns no worktree — observe with belayd_fleet_status, " +
      "message members with belayd_fleet_note, read reports with belayd_fleet_inbox, pause with " +
      "belayd_fleet_pause, repair crashes with belayd_fleet_reconcile.",
    parameters: Type.Object({
      tasks: Type.Union([
        Type.String({ description: "One task id or a whitespace/comma separated list" }),
        Type.Array(Type.String(), { description: 'Task ids, e.g. ["bd-12", "bd-15"]' }),
      ]),
      fleetId: Type.Optional(
        Type.String({
          description: `Fleet directory name under <git-common-dir>/belayd/fleet/ (default: ${DEFAULT_FLEET_ID})`,
        }),
      ),
      concurrency: Type.Optional(
        Type.Number({ description: "Concurrent orchestrators (capped at 3)" }),
      ),
      untilComplete: Type.Optional(
        Type.Boolean({
          description:
            "Run until every member is landed (default true). false keeps the explicit, " +
            "tool-driven surface: nothing is merged or advanced unless you call a tool",
        }),
      ),
      accept: Type.Optional(
        Type.Boolean({
          description:
            "Also close each landed bead (default false). The merged worktree is removed on " +
            "landing either way; without this flag every landed bead is left in_progress + " +
            "human, and the human accepts with `wt merge` / `bd close`; dependents still " +
            "advance because the fleet resolves its bd ordering gates on landing",
        }),
      ),
      publish: Type.Optional(
        Type.Union([Type.Literal("local"), Type.Literal("pr"), Type.Literal("push")], {
          description:
            "Publish mode (default local: merged work stays local, no remote and no network). " +
            "The resolved contract is frozen into fleet.json at launch and never re-read",
        }),
      ),
      publishRemote: Type.Optional(
        Type.String({ description: "Remote for pr/push publishes (default origin)" }),
      ),
      publishBase: Type.Optional(
        Type.String({
          description:
            "Base branch a pr publish targets (default: the repository's current branch)",
        }),
      ),
      publishReady: Type.Optional(
        Type.Boolean({ description: "Open the PR ready for review (default: draft)" }),
      ),
      publishStacks: Type.Optional(
        Type.Literal("per-chain", { description: "Stack composition (only per-chain)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const parsed = parseFleetTaskIds(params.tasks);
      if (!parsed.ok) return textToolResult(`belayd_fleet_launch: ${parsed.error}.`, 1);
      const publish = fleetPublishRequest({
        mode: params.publish,
        remote: params.publishRemote,
        base: params.publishBase,
        ready: params.publishReady,
        stacks: params.publishStacks,
      });
      const result = await runFleetLaunch({
        ctx: extensionCtx,
        taskIds: parsed.taskIds,
        fleetId: fleetIdParam(params.fleetId),
        ...(params.concurrency === undefined ? {} : { requestedConcurrency: params.concurrency }),
        ...(publish === undefined ? {} : { publish }),
        ...(params.untilComplete === false ? {} : { runMode: { accept: params.accept === true } }),
      });
      return textToolResult(result.text, result.ok ? 0 : 1);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_note",
    label: "Belayd fleet note",
    description:
      "Write fleet mailbox notes. The supervisor writes into events/ for one member or `all` " +
      "(a broadcast is materialized as one file per member, so every member receives its own " +
      "copy); a member writes into inbox/ and may only address `supervisor`. The target is " +
      "validated against live fleet membership, so a typo is refused instead of becoming mail " +
      "nobody ever reads. Kinds: note, rebase-hint, base-moved, sibling-landed, pause, resume. " +
      "Delivery is files-first: a member sees queued events at the start of its next turn; the " +
      "supervisor reads inbox/ with belayd_fleet_inbox. Body is bounded and every note is " +
      "audited in audit.log.",
    parameters: Type.Object({
      to: Type.String({
        description: "Target task id, `supervisor` (inbox only), or `all` (every member)",
      }),
      body: Type.String({ description: "Note body (truncated to 2000 characters)" }),
      kind: Type.Optional(
        Type.String({ description: `One of: ${FLEET_NOTE_KINDS.join(", ")} (default: note)` }),
      ),
      channel: Type.Optional(
        Type.String({
          description: "inbox (member → supervisor) or events (supervisor → member)",
        }),
      ),
      fleetId: Type.Optional(
        Type.String({ description: "Fleet id (default: this session's fleet)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const kind = normalizeFleetNoteKind(params.kind);
      if (kind === undefined) {
        return textToolResult(
          `Unknown note kind \`${params.kind ?? ""}\`. Valid kinds: ${FLEET_NOTE_KINDS.join(", ")}.`,
          1,
        );
      }
      const resolved = resolveFleetNoteTarget({
        ctx: extensionCtx,
        fleetId: params.fleetId,
        channel: params.channel,
      });
      if (!resolved.ok) return textToolResult(resolved.error, 1);

      const written = await writeFleetNote({
        ctx: extensionCtx,
        resolved,
        kind,
        to: params.to,
        body: params.body,
      });
      return written.ok ? textToolResult(written.text, 0) : textToolResult(written.error, 1);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_inbox",
    label: "Belayd fleet inbox",
    description:
      "Drain the fleet supervisor's inbox/ (member → supervisor notes), acknowledge each note, and " +
      "return them. At-least-once: a note is removed only after this call consumed it. Supervisor " +
      "sessions only — events/ is delivered to members automatically at turn start.",
    parameters: Type.Object({
      fleetId: Type.Optional(
        Type.String({ description: `Fleet id (default: ${DEFAULT_FLEET_ID})` }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) {
        return textToolResult(
          "belayd_fleet_inbox is supervisor-only: this session is not the live supervisor of a " +
            "fleet (a stale supervisor record from a dead process does not count). Start one with " +
            "/fleet or belayd_fleet_launch.",
          1,
        );
      }
      const requested = params.fleetId;
      if (requested !== undefined && requested.trim() !== "" && requested.trim() !== mode.fleetId) {
        return textToolResult(
          `This session supervises fleet \`${mode.fleetId}\`, not \`${requested.trim()}\`.`,
          1,
        );
      }

      const drained = drainNotes({ dir: mode.inboxDir });
      if (!drained.ok) return textToolResult(`Fleet inbox unavailable: ${drained.error}`, 1);

      // Render first, ack second. If an unlink fails, the note bodies this call
      // consumed are already in the result, and the rendered text states exactly
      // what remains queued — nothing vanishes off the record.
      const acked = ackNotes({ dir: mode.inboxDir, deliveries: drained.deliveries });

      if (drained.deliveries.length > 0) {
        auditFleetAction({
          ctx: extensionCtx,
          gitCommonDir: mode.gitCommonDir,
          fleetId: mode.fleetId,
          action: "inbox-drain",
          taskIds: drained.deliveries.map((delivery) => delivery.note.from),
          detail: inboxDrainDetail(drained.deliveries.length, acked),
        });
      }

      return textToolResult(formatFleetInboxResult({ mode, drained, acked }), acked.ok ? 0 : 1);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_merge",
    label: "Belayd fleet merge",
    description:
      "Explicit single-flight merge queue for a fleet supervisor. action=enqueue queues one " +
      "member's branch; action=drain merges one queued member into the fleet base branch in the " +
      "operator's root checkout (rebase → project gates → fast-forward merge → base-moved " +
      "notifications), and action=list renders the queue. A dirty root is auto-stashed and " +
      "restored; a conflicting restore parks the fleet with the stash ref in fleet.json (repair " +
      "with belayd_fleet_reconcile, then belayd_fleet_resume). " +
      "Merging is not closing: the bead stays in_progress + human. Supervisor sessions only.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("enqueue"), Type.Literal("drain"), Type.Literal("list")], {
        description: "enqueue one member, drain one queued member, or list the queue",
      }),
      task: Type.Optional(
        Type.String({
          description:
            "Member task id. Required for enqueue; optional for drain (default: the oldest queued entry)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) {
        return textToolResult(
          "belayd_fleet_merge is supervisor-only: this session is not the live supervisor of a " +
            "fleet (a stale supervisor record from a dead process does not count). Start one with " +
            "/fleet or belayd_fleet_launch.",
          1,
        );
      }
      const now = Date.now();
      switch (params.action) {
        case "list":
          return fleetMergeListAction(mode, now);
        case "enqueue":
          return fleetMergeEnqueueAction({
            ctx: extensionCtx,
            mode,
            task: params.task,
            now,
          });
        case "drain":
          return fleetMergeDrainAction({ ctx: extensionCtx, mode, task: params.task, now });
      }
    },
  });

  pi.registerTool({
    name: "belayd_fleet_pause",
    label: "Belayd fleet pause",
    description:
      "Pause a fleet so it starts no new work: the intent's `paused` flag is written through the " +
      "compare-and-replace path and audited (fleet-paused), launches refuse and merges refuse " +
      "until belayd_fleet_resume. Every member also gets a `pause` note in events/ (delivered at " +
      "its next turn start). This is cooperative: a running phase is NOT interrupted and a member " +
      "that ignores the note keeps working. force=true additionally sends SIGTERM to each " +
      "member's orchestrator process, identified only by the exact `belayd-<taskId>` session " +
      "token in its argv and re-verified (argv token + process start time) immediately before " +
      "each signal, so a recycled pid is skipped and audited instead of signalled (audited per " +
      "pid); it does not guarantee the process exited, does not " +
      "stop that member's phase sub-agents, and refuses outright when the process table cannot be " +
      "read or a member's process cannot be identified. Supervisor sessions only.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Operator-visible pause reason" })),
      force: Type.Optional(
        Type.Boolean({ description: "Also signal each member orchestrator (SIGTERM)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) return textToolResult(fleetSupervisorOnly("belayd_fleet_pause"), 1);

      const paused = pauseFleet({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        sessionId: extensionCtx.sessionManager.getSessionId(),
        now: Date.now(),
        ...(params.reason === undefined ? {} : { reason: params.reason }),
      });
      for (const warning of paused.warnings) {
        extensionCtx.ui.notify(warning, "warning");
        console.warn(`[belayd-harness] ${warning}`);
      }
      if (!paused.ok) return textToolResult(`Fleet pause refused: ${paused.error}`, 1);

      const notified = announceToMembers({
        ctx: extensionCtx,
        mode,
        kind: "pause",
        body:
          `Fleet \`${mode.fleetId}\` is paused` +
          (params.reason === undefined ? "" : `: ${params.reason}`) +
          ". Start no new phase; finish or park your current work and wait for a `resume` event.",
      });

      const lines = [paused.text];
      lines.push(
        notified.length === 0
          ? "- pause note: no member to notify (no members recorded)"
          : `- pause note queued for ${notified.join(", ")} (delivered at their next turn start)`,
      );
      if (params.force === true) {
        lines.push(...forceStopMembers({ ctx: extensionCtx, mode }));
      }
      return textToolResult(lines.join("\n"), 0);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_resume",
    label: "Belayd fleet resume",
    description:
      "Resume a paused or parked fleet: clears the intent's `paused` flag, the park record and its " +
      "note through the compare-and-replace path, audited (fleet-resumed, fleet-unparked). A park " +
      "that records a stash ref is refused unless force=true: run belayd_fleet_reconcile first so " +
      "the operator's stashed root work is restored (reconcile verifies the root is this " +
      "repository's own checkout on the base branch, applies the recorded sha, and unparks); " +
      "force clears the pause and leaves the stash untouched, naming the ref. Resuming a fleet " +
      "that is already running is a successful no-op. Members get a `resume` note in events/. " +
      "Supervisor sessions only.",
    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({
          description: "Clear a park whose stash was not verified as restored (the stash is kept)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) return textToolResult(fleetSupervisorOnly("belayd_fleet_resume"), 1);

      const resumed = resumeFleet({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        sessionId: extensionCtx.sessionManager.getSessionId(),
        now: Date.now(),
        ...(params.force === true ? { force: true } : {}),
      });
      for (const warning of resumed.warnings) {
        extensionCtx.ui.notify(warning, "warning");
        console.warn(`[belayd-harness] ${warning}`);
      }
      if (!resumed.ok) return textToolResult(`Fleet resume refused: ${resumed.error}`, 1);
      // An already-running fleet is a no-op: no member is told a pause ended that
      // never started, and nothing is fanned out.
      if (resumed.alreadyResumed) return textToolResult(resumed.text, 0);

      // A paused run stopped its timer without finishing the run; resuming is what
      // starts it ticking again. `ensureFleetRunTimer` covers the case where the
      // strict resume path declines (no arm token) but the run is still active.
      resumeFleetRunLoop(extensionCtx, getSessionState(extensionCtx));
      ensureFleetRunTimer({ ctx: extensionCtx, state: getSessionState(extensionCtx) });

      const notified = announceToMembers({
        ctx: extensionCtx,
        mode,
        kind: "resume",
        body:
          `Fleet \`${mode.fleetId}\` resumed. You may start new work again; re-read ` +
          "belayd_fleet_status before assuming a sibling's premises still hold.",
      });
      const lines = [resumed.text];
      if (notified.length > 0) {
        lines.push(`- resume note queued for ${notified.join(", ")}`);
      }
      return textToolResult(lines.join("\n"), 0);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_advance",
    label: "Belayd fleet advance",
    description:
      "Explicitly advance the fleet's next wave. The worklist is the intent's persisted `deferred` " +
      "list (members a previous launch could not start); the ordinary launch engine re-reads bd's " +
      "blocking edges, refuses a cycle, re-applies the ceiling of 3 orchestrators and launches only " +
      "what fits, recording the rest as deferred again. Every decision is audited (`advance`, " +
      "`schedule-planned`, per-member deferrals). A run started by /fleet advances itself on " +
      "each tick; this tool is the explicit step for a --manual fleet, and is safe to call while a " +
      "run is active. A dependency wave advances once bd stops reporting the blocking edge — a " +
      "member the fleet already landed satisfies its dependents even before the bead is closed. " +
      "Refused while the fleet is paused. Supervisor sessions only.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) return textToolResult(fleetSupervisorOnly("belayd_fleet_advance"), 1);

      const loaded = readFleetIntent({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
      });
      if (!loaded.ok) {
        return textToolResult(`Could not read the fleet intent: ${loaded.error}`, 1);
      }
      const planned = planFleetAdvance({ fleetId: mode.fleetId, intent: loaded.intent });
      if (!planned.ok) return textToolResult(planned.text, 1);

      const result = await runFleetLaunch({
        ctx: extensionCtx,
        taskIds: planned.worklist,
        fleetId: mode.fleetId,
        origin: "advance",
      });
      // An advance used to record nothing but its launches: a session whose loop had
      // died could "advance" a run forever without anything ticking it (bd-169).
      ensureFleetRunTimer({ ctx: extensionCtx, state: getSessionState(extensionCtx) });
      const header =
        `Advancing fleet \`${mode.fleetId}\`: ${planned.worklist.length} deferred member(s) ` +
        `(${planned.worklist.join(", ")}) re-scheduled; ${planned.members.length} already ` +
        "launched.";
      return textToolResult(`${header}\n${result.text}`, result.ok ? 0 : 1);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_reconcile",
    label: "Belayd fleet reconcile",
    description:
      "Repair a fleet after a crash, audited and idempotent. Merge queue: takes over an expired " +
      "lease, clears a lock record whose merge.lock.d is gone, reclaims an orphaned lock " +
      "directory past its grace window, and re-queues (or marks merged when git proves it landed) " +
      "an entry frozen mid-flight — all under the existing single-flight merge lock, so it never " +
      "interleaves with a merge. Parked fleet: restores the recorded stash ref when the root is " +
      "this repository's own checkout on the base branch and unparks, or reports exactly what " +
      "blocks it (the stash is never discarded); a recorded sha that is no longer in `git stash " +
      "list` is reported as already restored or dropped and never applied again. Supervision: " +
      "reports the supervisor's liveness and each member's orchestrator liveness from the " +
      "worktree lease (a member session renews `.belayd/orchestrator.json`; the process table " +
      "cannot see a pi-web session) plus the process table for CLI-spawned runs; " +
      "prune-dead-members=true removes members whose orchestrator is provably gone (no live " +
      "lease AND no matching process — `unknown` is never pruned, and a live supervisor may " +
      "prune); worktrees, transcripts, and beads stay. A second run finds nothing to do. " +
      "Targets this session's own fleet by default; fleetId names another fleet in this " +
      "repository, which is accepted only when this session supervises some fleet there " +
      "(audited), so a fleet whose supervisor died can be repaired without editing " +
      "fleet.json. A cross-fleet call repairs the queue and park; pruneDeadMembers is " +
      "refused unless the named fleet is this session's own (re-arm that fleet and run " +
      "reconcile from its own session). Supervisor sessions only; acts in this " +
      "session's root checkout.",
    parameters: Type.Object({
      pruneDeadMembers: Type.Optional(
        Type.Boolean({
          description:
            "Remove members whose orchestrator process is provably gone (a completed scan found " +
            "no `belayd-<taskId>` process); unknown liveness is never pruned and worktrees stay",
        }),
      ),
      fleetId: Type.Optional(
        Type.String({
          description:
            "Fleet to repair, when it is not this session's own (a fleet whose supervisor died). " +
            "Accepted only when this session supervises some fleet in this repository",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const target = resolveReconcileTarget({
        ctx: extensionCtx,
        requested: params.fleetId,
        pruneDeadMembers: params.pruneDeadMembers === true,
      });
      if (!target.ok) return textToolResult(target.text, 1);
      const mode = target.mode;

      const result = await runFleetReconcile({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        sessionId: extensionCtx.sessionManager.getSessionId(),
        pid: process.pid,
        rootCwd: extensionCtx.cwd,
        now: Date.now(),
        scan: scanProcesses(),
        git: defaultFleetMergeGitRunner,
        isPidAlive: isProcessAlive,
        pidStartTime: readProcessStartTime,
        selfPid: process.pid,
        // The worktree lease is the only liveness evidence a pi-web-hosted
        // orchestrator produces; without it every live member looks absent and
        // gets pruned, which is what started a second bd-37 orchestrator.
        leaseFor: (taskId) => {
          const worktreePath = resolveWorktreePath(extensionCtx.cwd, `feat/${taskId}`);
          return worktreePath === undefined ? undefined : leaseProbeFor(worktreePath, Date.now());
        },
        ...(params.pruneDeadMembers === true ? { pruneDeadMembers: true } : {}),
        // bd-158: a prune removes members, so their ordering gates must be
        // resolved by the same repair — otherwise only a later tick could.
        orderingGates: {
          resolve: (gates) =>
            resolveFleetOrderingGates({
              gates,
              cwd: extensionCtx.cwd,
              runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
            }),
          reapByPrefix: (gateInput) =>
            reapFleetOrderingGatesByPrefix({
              ...gateInput,
              cwd: extensionCtx.cwd,
              runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
            }),
        },
      });
      for (const warning of result.warnings) {
        extensionCtx.ui.notify(warning, "warning");
        console.warn(`[belayd-harness] ${warning}`);
      }
      // A prune removes a member, which orphans its bd ordering gates (bd-158):
      // reap them here so a repair leaves no open gate behind. Re-read the intent,
      // because the reconcile may have just pruned a member.
      const reconciled = readFleetIntent({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
      });
      const pruned = result.repairs
        .filter((repair) => repair.startsWith("member-pruned:"))
        .map((repair) => repair.slice("member-pruned:".length))
        .filter((taskId) => taskId !== "");
      // A repair is not a tick: sweep every member *and* the members it just pruned
      // (a pruned bead is no longer a member, so only a full pass still asks bd
      // about the gates that block it). One rotating bead would leave the rest of
      // the fleet unswept while the output claimed otherwise.
      const reaped =
        reconciled.ok && reconciled.intent !== undefined
          ? await reapOrderingGates({
              ctx: extensionCtx,
              mode,
              intent: reconciled.intent,
              now: Date.now(),
              tick: 0,
              sweep: "all",
              extraBeads: pruned,
            })
          : { warnings: [], gateNoticeIds: [] };
      for (const warning of reaped.warnings) extensionCtx.ui.notify(warning, "warning");
      return textToolResult(result.text, result.ok ? 0 : 1);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_release",
    label: "Belayd fleet release",
    description:
      "Give one member's capacity slot back without losing the member (bd-166). The id stays " +
      "in the fleet intent (status, mail, and a later landing still see it) and its bead, " +
      "worktree, transcript, and mailbox are untouched; only the repository-wide " +
      "orchestrator ceiling stops counting it, so the next fleet can launch. Records " +
      "released[] on the intent (reason operator-release) and audits member-released. " +
      "Refused while the member's orchestrator is live (stop or land it instead), and " +
      "refused for an id that is not a member of this fleet. Unknown liveness may be " +
      "released, because that is exactly the operator saying the work is not running. " +
      "Idempotent. Supervisor sessions only.",
    parameters: Type.Object({
      taskId: Type.String({
        description: "Fleet member whose slot to give back (e.g. bd-37)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const plan = planFleetRelease({ ctx: extensionCtx, taskId: params.taskId });
      if (!plan.ok) return textToolResult(plan.text, 1);
      const { mode, taskId } = plan;
      if (plan.already) {
        return textToolResult(
          `Fleet \`${mode.fleetId}\`: ${taskId}'s capacity slot is already released; ` +
            "the bead, worktree, and transcript are unchanged.",
          0,
        );
      }
      const written = applyFleetRelease({ mode, taskId, now: Date.now() });
      if (!written.ok) return textToolResult(`Fleet release refused: ${written.error}`, 1);
      if (written.released) {
        auditFleetAction({
          ctx: extensionCtx,
          gitCommonDir: mode.gitCommonDir,
          fleetId: mode.fleetId,
          action: "member-released",
          taskIds: [taskId],
          detail:
            "operator-release: the capacity slot is free; the bead, worktree, and transcript stay",
        });
      }
      return textToolResult(
        `Fleet \`${mode.fleetId}\`: released ${taskId}'s capacity slot ` +
          `(liveness: ${plan.liveness.kind}). The member, its bead, worktree, and transcript are ` +
          "unchanged; it can still be landed, and the slot is free for the next fleet.",
        0,
      );
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      ackFleetEventsAfterTurn(ctx);
    } catch (error) {
      console.warn(`[belayd-harness] fleet events ack failed: ${errorText(error)}`);
    }
  });

  pi.registerCommand("fleet", {
    description:
      "Start a fleet supervisor session for several beads, each as its own worktree workflow, and " +
      "run it to completion: members are ordered by bd dependencies (a bd gate per edge, resolved " +
      "when the blocker lands), only the free capacity starts " +
      "now (max 3 orchestrators), and the supervisor then lands each finished member, " +
      "releases the gates the landing satisfied and starts the next wave until every member is " +
      "landed. Landing never closes a bead: they stay in_progress + human for you to accept. " +
      "`--manual` keeps the explicit surface; `--accept` also closes each landed bead. " +
      "`--publish <local|pr|push>` freezes the publish contract into fleet.json (default local: " +
      "no remote and no network); `--publish-remote`, `--publish-base`, `--publish-ready` and " +
      "`--publish-stacks` complete a pr/push contract. " +
      "Usage: /fleet bd-12 bd-15 [--fleet <id>] [--concurrency <n>] [--manual] [--accept] " +
      "[--publish <local|pr|push>].",
    handler: async (args, ctx) => {
      const parsed = parseFleetCommandArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      const result = await runFleetLaunch({
        ctx,
        taskIds: parsed.args.taskIds,
        fleetId: fleetIdParam(parsed.args.fleetId),
        ...(parsed.args.concurrency === undefined
          ? {}
          : { requestedConcurrency: parsed.args.concurrency }),
        ...(parsed.args.publish === undefined ? {} : { publish: parsed.args.publish }),
        // `/fleet` runs to completion unless `--manual` asked for the explicit
        // surface; acceptance is opt-in (bd-158), so a bare `/fleet` lands members
        // and leaves every bead for the human. Ordering no longer needs a close:
        // the fleet's bd ordering gates are resolved on landing.
        ...(parsed.args.untilComplete === false
          ? {}
          : { runMode: { accept: parsed.args.accept === true } }),
      });
      ctx.ui.notify(result.text, result.ok ? "info" : "error");
    },
  });

  return {
    adoptFleetSupervisorIdentity,
    drainFleetEventsMessage,
    startFleetRunLoop,
    stopFleetRunTimer,
    runFleetLaunch,
    readBeadOwnership,
    readSupervisionInput,
    resumeFleetRunLoop,
    readoptFleetRuns,
    stopOrchestratorLeaseTimer,
    releaseSessionOrchestratorLease,
    fleetRefusalFor,
    claimWorktreeOrchestrator,
  };
}
