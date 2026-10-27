/**
 * Fleet run loop — P5 of the fleet supervisor (bd-126).
 *
 * P1–P4 schedule, land, and repair only when the operator asks. This module adds
 * the one thing that makes `/fleet bd-12 bd-15 bd-19` finish on its own: a
 * deterministic decision per tick, over already-read state, that says what the
 * supervisor should do next — land a finished member, give up on one that needs a
 * human, start the next wave, or stop because the run is over.
 *
 * Two properties this module exists to deliver:
 *
 * 1. **A tick is a pure function.** No git, no bd, no fs, no clock: the caller
 *    observes each member (workflow state, run manifests, orchestrator lease) and
 *    this module only decides. That is what makes "runs to completion" testable
 *    without a repository, and what keeps the loop auditable — every action the
 *    ticker takes is one `FleetTickAction` with a reason.
 * 2. **It cannot spin or invent progress.** One action per tick, the same input
 *    always yields the same action, and a member whose orchestrator is provably
 *    gone is *stopped for a human* rather than relaunched. A member that vanished
 *    is exactly the case that used to start a second orchestrator on one
 *    worktree (see `src/orchestrator-claim.ts`).
 *
 * What a tick deliberately does not do: run a phase, guess a status from a
 * missing file, or close/open anything. Landing and accepting are the caller's
 * effects; this module only names the next one.
 */

import { z } from "zod";
import type { FleetIntent } from "./fleet-status.js";
import { isWorkflowComplete } from "./process-gate.js";
import type { RunManifest } from "./run-manifest.js";
import { RunStatus } from "./run-manifest.js";

export const FLEET_RUN_SCHEMA_VERSION = 1;

/** Run modes. Only one exists today; the field is versioned so it can grow. */
export const FLEET_RUN_MODES = ["until-complete"] as const;

export type FleetRunMode = (typeof FLEET_RUN_MODES)[number];

/**
 * Why a member stopped making progress under the loop.
 *
 * Every entry is a case where a human decision is needed; none of them are
 * retried automatically, because retrying a failed gate or a conflicting rebase
 * with no new information just burns the same minutes again.
 */
export const FLEET_RUN_STOP_REASONS = [
  "awaiting-human",
  "phase-failed",
  "phase-interrupted",
  "orchestrator-missing",
  "state-corrupt",
  "land-failed",
  "accept-failed",
] as const;

export type FleetRunStopReason = (typeof FLEET_RUN_STOP_REASONS)[number];

/** How a run ended. `partial` means every surviving member is listed in `stopped`. */
export const FLEET_RUN_OUTCOMES = ["complete", "partial"] as const;

export type FleetRunOutcome = (typeof FLEET_RUN_OUTCOMES)[number];

/** Bound on the per-member records a run keeps (same ceiling as the intent). */
export const FLEET_RUN_MEMBERS_MAX = 256;

/**
 * How long a just-launched member may show no state and no runs before the loop
 * calls it missing.
 *
 * A pi-web session starts its first turn in seconds; this window absorbs a busy
 * daemon and a queue of prompts without ever letting a member that never started
 * hold a slot forever.
 */
export const FLEET_RUN_START_GRACE_MS = 120_000;

/** Consecutive no-progress ticks before the loop stops with `stalled`. */
export const FLEET_RUN_MAX_IDLE_TICKS = 240;

/**
 * Delay between loop ticks while members are working.
 *
 * File reads plus one git worktree probe per member; 15s keeps the view fresh
 * without touching the disk in a tight loop. A tick that acted (landing, stopping,
 * advancing) schedules the next one sooner — see the extension's ticker.
 */
export const FLEET_RUN_TICK_INTERVAL_MS = 15_000;

/** Delay after an acting tick, so a landing wave does not wait a full interval. */
export const FLEET_RUN_ACTION_TICK_INTERVAL_MS = 2_000;

const FleetRunMemberSchema = z.object({
  taskId: z.string().min(1).max(128),
  /** When the fleet launched this member; the start-grace window is measured from here. */
  launchedAt: z.number().finite(),
  /** Orchestrator session the launch created, when the launch reported one. */
  sessionId: z.string().max(256).optional(),
  /** Set once this run merged the member into the base branch. */
  landedAt: z.number().finite().optional(),
});

const FleetRunStopSchema = z.object({
  taskId: z.string().min(1).max(128),
  reason: z.enum(FLEET_RUN_STOP_REASONS),
  detail: z.string().max(400),
  at: z.number().finite(),
});

/**
 * The persisted record of one "run until complete" loop.
 *
 * It lives inside `fleet.json` (`run`) because the loop must survive a supervisor
 * restart: after a re-arm, the new supervisor resumes from this record instead of
 * re-landing members it already landed or re-adopting ones it already gave up on.
 */
export const FleetRunSchema = z.object({
  schemaVersion: z.literal(FLEET_RUN_SCHEMA_VERSION),
  mode: z.enum(FLEET_RUN_MODES),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
  /** Ticks executed so far (diagnostic; also the loop's liveness stamp). */
  ticks: z.number().int().nonnegative(),
  /**
   * Whether a landed member is accepted (bead closed, worktree removed).
   *
   * Absent means the launch did not ask for acceptance, which is the conservative
   * default: an agent-run fleet never closes a bead unless the operator opted in.
   */
  accept: z.boolean().optional(),
  members: z.array(FleetRunMemberSchema).max(FLEET_RUN_MEMBERS_MAX).optional(),
  stopped: z.array(FleetRunStopSchema).max(FLEET_RUN_MEMBERS_MAX).optional(),
  /** Consecutive ticks in which no member progressed. */
  idleTicks: z.number().int().nonnegative().optional(),
  finishedAt: z.number().finite().optional(),
  outcome: z.enum(FLEET_RUN_OUTCOMES).optional(),
  /** Why a run stopped without finishing (paused, stalled, authority lost). */
  haltedReason: z.string().max(400).optional(),
});

export type FleetRun = z.infer<typeof FleetRunSchema>;

export type FleetRunMember = z.infer<typeof FleetRunMemberSchema>;
export type FleetRunStop = z.infer<typeof FleetRunStopSchema>;

// ── Observation → progress (pure) ─────────────────────────────────────

/** What one worktree's persisted workflow files say about a member. */
export type FleetWorkflowProgressSnapshot =
  | {
      kind: "ok";
      completedPhaseNames: readonly string[];
      phaseOrder: readonly string[];
      awaitingReviewResponse: boolean;
    }
  | { kind: "missing" }
  | { kind: "corrupt" };

/**
 * Coarse progress of one member. Deliberately about *workflow* progress, not
 * liveness: liveness is the orchestrator lease, and the two are combined by
 * {@link planFleetTick} so neither can stand in for the other.
 */
export type FleetMemberProgress =
  | { kind: "running"; detail: string }
  | { kind: "complete" }
  | { kind: "awaiting-human"; detail: string }
  | { kind: "phase-failed"; detail: string }
  | { kind: "phase-interrupted"; detail: string }
  | { kind: "state-corrupt"; detail: string }
  | { kind: "starting"; detail: string }
  | { kind: "missing"; detail: string };

export interface DeriveFleetMemberProgressOptions {
  /** The member these runs must belong to; another task's manifests are not its evidence. */
  taskId: string;
  workflow: FleetWorkflowProgressSnapshot;
  runs: readonly RunManifest[];
  /** Phase order from the workflow state; used only for the completion fallback. */
  phaseOrder?: readonly string[];
  now: number;
  /**
   * When the fleet launched this member.
   *
   * Also the only proof that a failed run belongs to this execution: re-launching
   * the same task inherits the previous run's manifest, so without a launch time a
   * terminal failure is not trusted (see {@link runsBelongingToMember}).
   */
  launchedAt?: number;
  startGraceInMs?: number;
}

/** Newest run by `startedAt`, then run id (a total order, so ticks are stable). */
function newestRun(runs: readonly RunManifest[]): RunManifest | undefined {
  return [...runs].sort((left, right) => {
    if (left.startedAt !== right.startedAt) return right.startedAt - left.startedAt;
    return left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0;
  })[0];
}

/** Latest run per phase, used to decide whether a pending phase already failed. */
function latestPerPhase(runs: readonly RunManifest[]): RunManifest[] {
  const byPhase = new Map<string, RunManifest>();
  for (const run of runs) {
    const current = byPhase.get(run.phase);
    if (current === undefined || run.startedAt >= current.startedAt) byPhase.set(run.phase, run);
  }
  return [...byPhase.values()];
}

/** Everything needed to tell a member's own run manifests from inherited ones. */
export interface MemberRunsOptions {
  taskId: string;
  runs: readonly RunManifest[];
  /** When the fleet launched this member; absent for a member it did not launch. */
  launchedAt?: number;
  /**
   * Whether a terminal failure needs a known launch time to count as evidence.
   *
   * The stop decision must not attribute a failure to this execution without
   * proof, and a manifest carries no execution identity — so only a launch time
   * the run cannot predate proves it (bd-161: a copied same-task manifest). The
   * read-only view keeps such a failure visible while the fleet has no run
   * record, because then no loop is deciding this worktree and `blocked` is just
   * what the files say.
   */
  failuresRequireLaunch?: boolean;
}

/**
 * Runs that are evidence about *this* member.
 *
 * `.belayd/` is gitignored and `.config/wt.toml` copies ignored files into a new
 * worktree, so a fresh member inherits the primary checkout's `.belayd/runs` —
 * including a failed run of another task (bd-161: an old bd-37 manifest made
 * bd-150/151/152/153 look `phase implement failed` while they were still
 * scouting). Three rules close that:
 *
 * - The task id, because another task's manifest is never about this member.
 * - The launch time, because re-launching the *same* task into a fresh worktree
 *   also inherits its own earlier manifests, and a manifest is written when its
 *   phase starts, so every run the member created itself starts after the launch.
 * - Never the launch time for a run still in flight: a live same-task run proves
 *   an execution is happening now, while the launch cutoff only drops manifests
 *   of *previous* executions. Dropping it would fall through to `missing` and
 *   stop a healthy member as `orchestrator-missing` (the supervisor and the
 *   member can disagree by more than the launch instant).
 *
 * Exported so the read-only fleet view filters identically instead of keeping a
 * second copy that can drift from the stop decision.
 */
export function runsBelongingToMember(options: MemberRunsOptions): readonly RunManifest[] {
  return options.runs.filter((run) => runBelongsToMember(run, options));
}

function runBelongsToMember(run: RunManifest, options: MemberRunsOptions): boolean {
  if (run.taskId !== options.taskId) return false;
  if (run.status === RunStatus.Running) return true;
  if (options.launchedAt === undefined) {
    // No launch time: the task id is the only evidence of ownership. A failure
    // beyond that would let the previous execution in the primary checkout stop
    // this one, so it only counts as evidence when the caller asked for that.
    const terminalFailure = run.status === RunStatus.Failed || run.status === RunStatus.Interrupted;
    return !(options.failuresRequireLaunch === true && terminalFailure);
  }
  return run.startedAt >= options.launchedAt;
}

/**
 * Derive a member's workflow progress from files that already exist.
 *
 * The "complete" rule has two shapes because a finished workflow deletes
 * `.belayd/workflow.json` (completion clears it) while the run manifests stay: a
 * missing state file plus a completed final-phase run is finished work, not a
 * missing member.
 */
export function deriveFleetMemberProgress(
  options: DeriveFleetMemberProgressOptions,
): FleetMemberProgress {
  const runs = runsBelongingToMember({
    runs: options.runs,
    taskId: options.taskId,
    ...(options.launchedAt === undefined ? {} : { launchedAt: options.launchedAt }),
    // This derivation feeds the stop decision, so a failure no launch can be
    // credited with must not become a `phase-failed` stop (bd-161).
    failuresRequireLaunch: true,
  });
  const active = progressFromActiveRuns(runs);
  if (active !== undefined) return active;
  switch (options.workflow.kind) {
    case "corrupt":
      return { kind: "state-corrupt", detail: "unreadable .belayd/workflow.json" };
    case "ok":
      return progressFromWorkflow(options.workflow, runs);
    case "missing":
      return progressFromMissingState({ ...options, runs });
  }
}

/** A phase run in flight or a crashed one outranks anything the state file says. */
function progressFromActiveRuns(runs: readonly RunManifest[]): FleetMemberProgress | undefined {
  const running = runs.filter((run) => run.status === RunStatus.Running);
  if (running.length > 0) {
    const phases = [...new Set(running.map((run) => run.phase))].join(", ");
    return { kind: "running", detail: `phase run in flight: ${phases}` };
  }
  const interrupted = runs.filter((run) => run.status === RunStatus.Interrupted);
  if (interrupted.length > 0) {
    const phases = [...new Set(interrupted.map((run) => run.phase))].join(", ");
    return { kind: "phase-interrupted", detail: `interrupted phase run: ${phases}` };
  }
  return undefined;
}

function describeFailure(run: RunManifest): string {
  return `phase ${run.phase} failed${run.failureReason === undefined ? "" : `: ${run.failureReason}`}`;
}

/** Progress for a readable workflow state: awaiting human, complete, failed, working. */
function progressFromWorkflow(
  workflow: Extract<FleetWorkflowProgressSnapshot, { kind: "ok" }>,
  runs: readonly RunManifest[],
): FleetMemberProgress {
  if (workflow.awaitingReviewResponse) {
    return { kind: "awaiting-human", detail: "workflow is waiting for a review response" };
  }
  const completed = new Set(workflow.completedPhaseNames);
  if (isWorkflowComplete([...workflow.completedPhaseNames], workflow.phaseOrder)) {
    return { kind: "complete" };
  }
  const failed = latestPerPhase(runs).find(
    (run) => run.status === RunStatus.Failed && !completed.has(run.phase),
  );
  if (failed !== undefined) return { kind: "phase-failed", detail: describeFailure(failed) };
  return {
    kind: "running",
    detail: `${workflow.completedPhaseNames.length}/${workflow.phaseOrder.length} phases complete`,
  };
}

/**
 * Progress with no state file.
 *
 * Completion clears `.belayd/workflow.json`, so a missing file plus a completed
 * final-phase run is finished work; no runs at all is a member that never started.
 */
function progressFromMissingState(options: DeriveFleetMemberProgressOptions): FleetMemberProgress {
  const order = options.phaseOrder ?? [];
  const finalPhase = order.length > 0 ? order[order.length - 1] : "commit";
  const newest = newestRun(options.runs);
  if (newest === undefined) {
    const grace = options.startGraceInMs ?? FLEET_RUN_START_GRACE_MS;
    const withinGrace =
      options.launchedAt !== undefined && options.now - options.launchedAt < grace;
    return withinGrace
      ? { kind: "starting", detail: "launched, no phase has started yet" }
      : { kind: "missing", detail: "no workflow state and no phase runs" };
  }
  if (newest.phase === finalPhase && newest.status === RunStatus.Completed) {
    return { kind: "complete" };
  }
  if (newest.status === RunStatus.Failed) {
    return { kind: "phase-failed", detail: describeFailure(newest) };
  }
  return {
    kind: "running",
    detail: `no workflow state; newest run is ${newest.phase} (${newest.status})`,
  };
}

// ── Orchestrator liveness as the loop sees it ─────────────────────────

/**
 * Liveness of a member's orchestrator, reduced to what a tick may act on.
 *
 * `corrupt` is kept distinct from `absent`: an unreadable lease is unknown, and
 * unknown must never be treated as "gone" when the action would be irreversible.
 */
export type FleetMemberClaim = "live" | "stale" | "absent" | "corrupt";

export interface FleetMemberObservation {
  taskId: string;
  progress: FleetMemberProgress;
  claim: FleetMemberClaim;
  /** Set when this run launched the member; absent for members the run did not launch. */
  launchedAt?: number;
}

export type FleetTickAction =
  | { kind: "land"; taskId: string }
  | { kind: "stop"; taskId: string; reason: FleetRunStopReason; detail: string }
  | { kind: "advance" }
  | { kind: "wait"; detail: string }
  | { kind: "complete"; outcome: FleetRunOutcome; detail: string }
  | { kind: "halt"; reason: "paused" | "parked" | "stalled"; detail: string };

export interface PlanFleetTickOptions {
  intent: FleetIntent;
  observations: readonly FleetMemberObservation[];
  now: number;
  /** Consecutive ticks without progress (from the run record). */
  idleTicks?: number;
  maxIdleTicks?: number;
  startGraceInMs?: number;
}

function isStopped(run: FleetRun | undefined, taskId: string): boolean {
  return (run?.stopped ?? []).some((entry) => entry.taskId === taskId);
}

/**
 * Stop reasons this loop recorded *because* it tried to land the member.
 *
 * Every other reason (a failed phase, a missing orchestrator) is a report about
 * the member's session, not about its work: the branch may still finish on a
 * retry, and the run must land that. A member stopped by a land attempt must not
 * be retried, because the next attempt would burn the same gates on the same
 * conflict.
 *
 * `accept-failed` is defense for legacy records only: the current flow records it
 * *after* pruning the landed member, so a scannable member never carries it.
 */
const LAND_ATTEMPT_STOP_REASONS: readonly FleetRunStopReason[] = ["land-failed", "accept-failed"];

/** Whether this run may still land the member (not already landed, no failed land attempt). */
function canLandMember(run: FleetRun | undefined, taskId: string): boolean {
  const member = (run?.members ?? []).find((entry) => entry.taskId === taskId);
  if (member?.landedAt !== undefined) return false;
  const stop = (run?.stopped ?? []).find((entry) => entry.taskId === taskId);
  return stop === undefined || !LAND_ATTEMPT_STOP_REASONS.includes(stop.reason);
}

/**
 * Stopped members whose own retry is observably alive.
 *
 * The run stays open for them because landing is only possible while the run is
 * live: a finished run cannot be resumed, and a stopped member cannot be launched
 * again through the fleet. The evidence is the orchestrator lease, not the phase
 * files: a stale `running` snapshot whose lease is gone would otherwise keep the
 * run — and the cross-fleet capacity slots it holds — open forever.
 */
function stoppedMembersRetrying(
  intent: FleetIntent,
  byTask: ReadonlyMap<string, FleetMemberObservation>,
): readonly string[] {
  return (intent.run?.stopped ?? [])
    .map((entry) => entry.taskId)
    .filter(
      (taskId) =>
        intent.taskIds.includes(taskId) &&
        canLandMember(intent.run, taskId) &&
        retryIsAlive(byTask.get(taskId)),
    );
}

/** Whether a stopped member's observation proves its retry is still working. */
function retryIsAlive(observation: FleetMemberObservation | undefined): boolean {
  if (observation === undefined) return false;
  switch (observation.progress.kind) {
    case "starting":
      // The start grace already bounds this: it only holds just after a launch.
      return true;
    case "running":
      // Without a live lease nothing is running the work, only writing files about it.
      return observation.claim === "live";
    default:
      return false;
  }
}

/**
 * Decide the single next action of a run.
 *
 * Order is the whole contract: **land** a finished member first (it frees a slot
 * and unblocks its dependents), then **stop** members that need a human, then
 * **advance** the next wave, then wait. One action per call keeps every tick
 * idempotent and its audit line unambiguous.
 */
export function planFleetTick(options: PlanFleetTickOptions): FleetTickAction {
  const halted = fleetHaltAction(options.intent);
  if (halted !== undefined) return halted;

  const byTask = new Map(options.observations.map((entry) => [entry.taskId, entry]));
  const members = options.intent.taskIds.filter((taskId) => !isStopped(options.intent.run, taskId));

  // Land first: a finished member frees a slot and unblocks its dependents. A
  // member the run *stopped* is still landable — a stop reports its session, and
  // its orchestrator can finish on a retry — which is why this scans every member
  // instead of only the ones still running.
  const finished = options.intent.taskIds.find(
    (taskId) =>
      canLandMember(options.intent.run, taskId) && byTask.get(taskId)?.progress.kind === "complete",
  );
  if (finished !== undefined) return { kind: "land", taskId: finished };

  const stop = firstStop(options, members, byTask);
  if (stop !== undefined) return stop;

  if (members.length > 0) return idleOrWait(options, members);

  // Nothing healthy is left, but a stopped member's retry may still deliver work
  // the run is the only thing that can land. Waiting is bounded twice: by the
  // lease evidence above and by the idle cap in `idleOrWait`.
  const retrying = stoppedMembersRetrying(options.intent, byTask);
  if (retrying.length > 0) return idleOrWait(options, retrying);
  return completionAction(options.intent);
}

/** A paused or parked fleet starts nothing; the loop halts and waits for a human. */
function fleetHaltAction(intent: FleetIntent): FleetTickAction | undefined {
  if (intent.paused === true) {
    return { kind: "halt", reason: "paused", detail: intent.note ?? "the fleet is paused" };
  }
  if (intent.park !== undefined) {
    return {
      kind: "halt",
      reason: "parked",
      detail: `the root checkout is parked (${intent.park.reason}); reconcile, then resume`,
    };
  }
  return undefined;
}

function firstStop(
  options: PlanFleetTickOptions,
  members: readonly string[],
  byTask: ReadonlyMap<string, FleetMemberObservation>,
): FleetTickAction | undefined {
  for (const taskId of members) {
    const observation = byTask.get(taskId);
    if (observation === undefined) continue;
    const stop = stopDecision({ observation, ...options });
    if (stop !== undefined) return stop;
  }
  return undefined;
}

/** Nothing to land and nothing to stop: advance the next wave, or give up on a stall. */
function completionAction(intent: FleetIntent): FleetTickAction {
  if ((intent.deferred ?? []).length > 0) return { kind: "advance" };
  const stopped = intent.run?.stopped ?? [];
  return {
    kind: "complete",
    outcome: stopped.length > 0 ? "partial" : "complete",
    detail:
      stopped.length > 0
        ? `${stopped.length} member(s) need a human: ${stopped.map((entry) => entry.taskId).join(", ")}`
        : "every member landed",
  };
}

/** Members still working: wait, unless the run has made no progress for too long. */
function idleOrWait(options: PlanFleetTickOptions, members: readonly string[]): FleetTickAction {
  const maxIdle = options.maxIdleTicks ?? FLEET_RUN_MAX_IDLE_TICKS;
  if ((options.idleTicks ?? 0) >= maxIdle) {
    return {
      kind: "halt",
      reason: "stalled",
      detail: `no member progressed for ${maxIdle} ticks; ${members.join(", ")} still in flight`,
    };
  }
  return { kind: "wait", detail: `${members.length} member(s) in flight: ${members.join(", ")}` };
}

/**
 * Whether one member must stop, or `undefined` while it is legitimately working.
 *
 * The start grace applies only to members *this run* launched: a member inherited
 * from an older launch has no `launchedAt`, and its lease is the only liveness
 * evidence this version can honestly read.
 */
function stopAction(
  observation: FleetMemberObservation,
  reason: FleetRunStopReason,
  detail: string,
): Extract<FleetTickAction, { kind: "stop" }> {
  return { kind: "stop", taskId: observation.taskId, reason, detail };
}

function stopDecision(options: {
  observation: FleetMemberObservation;
  now: number;
  startGraceInMs?: number;
}): Extract<FleetTickAction, { kind: "stop" }> | undefined {
  const { observation } = options;
  const grace = options.startGraceInMs ?? FLEET_RUN_START_GRACE_MS;
  const inGrace =
    observation.launchedAt !== undefined && options.now - observation.launchedAt < grace;
  const progress = observation.progress;

  switch (progress.kind) {
    case "complete":
    case "starting":
      return undefined;
    case "awaiting-human":
    case "phase-failed":
    case "phase-interrupted":
    case "state-corrupt":
      return stopAction(observation, progress.kind, progress.detail);
    case "running":
      return runningMemberStop(observation, progress.detail, inGrace);
    case "missing":
      // Phase files are copies that can be stale or inherited; a live lease is the
      // one thing that proves an execution still owns this worktree, so a member
      // that lost its state file must not be stopped while something holds it.
      return inGrace || observation.claim === "live"
        ? undefined
        : stopAction(observation, "orchestrator-missing", progress.detail);
  }
}

/**
 * A member whose phases remain but whose orchestrator is gone.
 *
 * Only a member *this run* launched may be declared missing on lease evidence:
 * a member inherited from an older launch has no `launchedAt`, and its lease is
 * the one thing this version can honestly read about it.
 */
function runningMemberStop(
  observation: FleetMemberObservation,
  detail: string,
  inGrace: boolean,
): Extract<FleetTickAction, { kind: "stop" }> | undefined {
  if (inGrace || observation.launchedAt === undefined || observation.claim === "live") {
    return undefined;
  }
  return stopAction(
    observation,
    "orchestrator-missing",
    `${detail}, but no live orchestrator lease holds the worktree`,
  );
}

// ── Run record updates (pure) ─────────────────────────────────────────

/** Start (or restart) a run for a launch that asked to run until complete. */
export function startFleetRun(options: {
  now: number;
  accept: boolean;
  members: readonly { taskId: string; sessionId?: string }[];
  previous?: FleetRun;
}): FleetRun {
  const alreadyLanded = new Map(
    (options.previous?.members ?? []).map((member) => [member.taskId, member]),
  );
  const members = options.members.map((member) => {
    const prior = alreadyLanded.get(member.taskId);
    return {
      taskId: member.taskId,
      launchedAt: options.now,
      ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }),
      ...(prior?.landedAt === undefined ? {} : { landedAt: prior.landedAt }),
    };
  });
  return {
    schemaVersion: FLEET_RUN_SCHEMA_VERSION,
    mode: "until-complete",
    startedAt: options.now,
    updatedAt: options.now,
    ticks: 0,
    idleTicks: 0,
    accept: options.accept,
    members,
  };
}

/** Record a member launch in the run (a wave advance adds members mid-run). */
export function recordRunMemberLaunched(options: {
  run: FleetRun;
  taskId: string;
  launchedAt: number;
  sessionId?: string;
}): FleetRun {
  const members = options.run.members ?? [];
  const rest = members.filter((member) => member.taskId !== options.taskId);
  return {
    ...options.run,
    updatedAt: options.launchedAt,
    members: [
      ...rest,
      {
        taskId: options.taskId,
        launchedAt: options.launchedAt,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      },
    ],
    stopped: (options.run.stopped ?? []).filter((entry) => entry.taskId !== options.taskId),
  };
}

/** Record that a member landed (merged) so a later tick never merges it again. */
export function recordRunMemberLanded(options: {
  run: FleetRun;
  taskId: string;
  now: number;
}): FleetRun {
  const members = options.run.members ?? [];
  const existing = members.find((member) => member.taskId === options.taskId);
  const next: FleetRunMember =
    existing === undefined
      ? { taskId: options.taskId, launchedAt: options.now, landedAt: options.now }
      : { ...existing, landedAt: options.now };
  return {
    ...options.run,
    updatedAt: options.now,
    members: [...members.filter((member) => member.taskId !== options.taskId), next],
    // A member that landed no longer needs a human, so a stop it carried while its
    // retry finished must not survive into the run's outcome.
    stopped: (options.run.stopped ?? []).filter((entry) => entry.taskId !== options.taskId),
  };
}

/** Record a stopped member; the loop never plans it again until a new run starts. */
export function recordRunMemberStopped(options: {
  run: FleetRun;
  taskId: string;
  reason: FleetRunStopReason;
  detail: string;
  now: number;
}): FleetRun {
  const rest = (options.run.stopped ?? []).filter((entry) => entry.taskId !== options.taskId);
  return {
    ...options.run,
    updatedAt: options.now,
    stopped: [
      ...rest,
      {
        taskId: options.taskId,
        reason: options.reason,
        detail: options.detail.slice(0, 400),
        at: options.now,
      },
    ],
  };
}

/** Advance the tick counter and the idle counter (progress resets the latter). */
export function recordRunTick(options: {
  run: FleetRun;
  now: number;
  progressed: boolean;
}): FleetRun {
  return {
    ...options.run,
    updatedAt: options.now,
    ticks: options.run.ticks + 1,
    idleTicks: options.progressed ? 0 : (options.run.idleTicks ?? 0) + 1,
  };
}

/** Close a run so no later tick resumes it. */
export function finishFleetRun(options: {
  run: FleetRun;
  now: number;
  outcome: FleetRunOutcome;
}): FleetRun {
  return {
    ...options.run,
    updatedAt: options.now,
    finishedAt: options.now,
    outcome: options.outcome,
  };
}

/** Whether a run is still live (not finished, not halted). */
export function isFleetRunActive(run: FleetRun | undefined): boolean {
  if (run === undefined) return false;
  return run.finishedAt === undefined && run.haltedReason === undefined;
}

// ── Rendering ─────────────────────────────────────────────────────────

function isoTime(value: number): string {
  return new Date(value).toISOString();
}

/**
 * One status line for a run, or undefined when the fleet has no run record.
 *
 * Deliberately free of relative ages: `belayd_fleet_status` is byte-stable across
 * two reads of unchanged files, and "3s ago" would break that. Freshness is
 * judged by the tools that act on it, not by the observer.
 */
export function formatFleetRunLine(run: FleetRun | undefined): string | undefined {
  if (run === undefined) return undefined;
  if (run.finishedAt !== undefined) {
    return (
      `run: ${run.mode} — ${run.outcome ?? "complete"} at ${isoTime(run.finishedAt)} ` +
      `(${run.ticks} tick(s))`
    );
  }
  if (run.haltedReason !== undefined) {
    return `run: ${run.mode} — halted: ${run.haltedReason}`;
  }
  return `run: ${run.mode} — ${run.ticks} tick(s), last tick ${isoTime(run.updatedAt)}`;
}

/** Detail lines for the members a run stopped, one per member. */
export function formatFleetRunStops(run: FleetRun | undefined): readonly string[] {
  if (run === undefined) return [];
  return (run.stopped ?? []).map(
    (entry) => `stopped ${entry.taskId} (${entry.reason}): ${entry.detail}`,
  );
}
