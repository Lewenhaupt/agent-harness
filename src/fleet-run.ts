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
  workflow: FleetWorkflowProgressSnapshot;
  runs: readonly RunManifest[];
  /** Phase order from the workflow state; used only for the completion fallback. */
  phaseOrder?: readonly string[];
  now: number;
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
  const active = progressFromActiveRuns(options.runs);
  if (active !== undefined) return active;
  switch (options.workflow.kind) {
    case "corrupt":
      return { kind: "state-corrupt", detail: "unreadable .belayd/workflow.json" };
    case "ok":
      return progressFromWorkflow(options.workflow, options.runs);
    case "missing":
      return progressFromMissingState(options);
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

  // Land first: a finished member frees a slot and unblocks its dependents.
  const finished = members.find((taskId) => byTask.get(taskId)?.progress.kind === "complete");
  if (finished !== undefined) return { kind: "land", taskId: finished };

  const stop = firstStop(options, members, byTask);
  if (stop !== undefined) return stop;

  if (members.length > 0) return idleOrWait(options, members);
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
  return { kind: "wait", detail: `${members.length} member(s) in flight` };
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
      return inGrace ? undefined : stopAction(observation, "orchestrator-missing", progress.detail);
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
