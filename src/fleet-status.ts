/**
 * Fleet status — read-only aggregation for the multi-bead supervisor (bd-126).
 *
 * P0 of docs/fleet-orchestrator.md is pure observation: the supervisor is a
 * scheduler, never a phase worker, so this module reads every worktree's
 * `.belayd/workflow.json` plus its run manifests and derives one view. It
 * writes nothing, spawns nothing, merges nothing, and arms no gate.
 *
 * The view is *derived*: no fleet status file exists. Shared fleet state lives
 * under `<git-common-dir>/belayd/fleet/<fleetId>/` (intent, mailbox, merge
 * queue, audit log); P0 only reads the optional `fleet.json` intent.
 */

import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { excerptComment } from "./bead-comments.js";
import type { FleetCapacityArithmetic, FleetCapacitySupervisor } from "./fleet-capacity.js";
import { describeFleetCapacity, FLEET_MAX_CONCURRENT_ORCHESTRATORS } from "./fleet-capacity.js";
import type { FleetSupervisorLiveness } from "./fleet-mode.js";
import { classifyFleetSupervisor, isProcessAlive, readProcessStartTime } from "./fleet-mode.js";
import {
  FLEET_MEMBER_RELEASE_REASONS,
  FLEET_RUN_STALE_TICK_INTERVALS,
  FLEET_RUN_STALE_TICK_MS,
  FLEET_RUN_TICK_INTERVAL_MS,
  FleetRunSchema,
  formatFleetRunLine,
  formatFleetRunStops,
  isFleetRunActive,
  memberEvidenceCutoff,
  memberRanEvidence,
  runsBelongingToMember,
  worktreeCreatedAtFromStat,
} from "./fleet-run.js";
import { FLEET_SCHEDULE_DEFERRAL_REASONS } from "./fleet-schedule.js";
import type {
  FleetMemberLeaseProbe,
  FleetMemberLiveness,
  FleetProcessScan,
} from "./fleet-sessions.js";
import {
  classifyMemberLease,
  classifyMemberLivenessInWorktree,
  scanProcesses,
} from "./fleet-sessions.js";
import { taskIdFromBranch } from "./handoff.js";
import type { OrchestratorClaim } from "./orchestrator-claim.js";
import {
  orchestratorClaimPath,
  parseOrchestratorClaim,
  readOrchestratorClaim,
} from "./orchestrator-claim.js";
import type { RunManifest, RunManifestFs } from "./run-manifest.js";
import { listRuns, RunStatus, runManifestFs } from "./run-manifest.js";
import { isValidTaskId } from "./session-naming.js";
import type { WorkflowState } from "./workflow-state.js";
import { parseWorkflowState, workflowStateFilePath } from "./workflow-state.js";
import type { GitCommonDirResult, WorktreeListEntry } from "./worktree.js";
import { listWorktrees as defaultListWorktrees, resolveGitCommonDir } from "./worktree.js";

/**
 * `schemaVersion` of the `fleet.json` intent record. The merge queue and the
 * mailbox notes keep their own versions (`fleet-state.ts`) so bumping the
 * intent schema cannot invalidate every note already in a mailbox.
 */
export const FLEET_SCHEMA_VERSION = 1;

/** Fleet id used when the caller does not name one. */
export const DEFAULT_FLEET_ID = "default";

/**
 * Upper bound on the intent's `taskIds` list.
 *
 * The intent is untrusted input to the P0 reader, so its lists are bounded like
 * every other trust-boundary list. The bound is deliberately far above any real
 * fleet (the concurrency ceiling is 3; three leaves of planning headroom is
 * already extreme) and `belayd_fleet_launch` refuses a launch whose membership
 * would exceed it, so a launch can never write a record its own reader rejects.
 */
export const FLEET_INTENT_MEMBERS_MAX = 256;

/**
 * Upper bound on the intent's `deferred` list.
 *
 * Larger than the membership cap because a relaunch may restate part of the plan
 * while preserving entries it did not schedule (they are unioned, not replaced).
 * The launch refuses a request whose waiting members would exceed it, so the
 * bound is a guard against hostile/hand-edited records, not a practical limit.
 */
export const FLEET_INTENT_DEFERRED_MAX = 1000;

/**
 * Upper bound on the intent's recorded fleet-ordering gates (bd-158).
 *
 * One gate per dependency edge *between two members*, so the membership cap
 * bounds those edges far below any real fleet's needs: this is a trust-boundary
 * guard (the intent is untrusted input to the reader), not a practical limit. A
 * launch whose merged record set would exceed it is refused (`fleet-launch.ts`
 * `orderingGateBudgetRefusal`) rather than truncated, because a cut record is an
 * open gate nothing can resolve any more.
 */
export const FLEET_INTENT_ORDERING_GATES_MAX = 256;

/** Members rendered in the one-line intent summary before it is elided. */
export const FLEET_INTENT_SUMMARY_MAX = 8;

// ── Fleet intent (fleet.json) ─────────────────────────────────────────

/**
 * Operator intent for one fleet. Absent in P0 unless a human writes it: no P0
 * code path creates or updates this file. Later milestones (P1 launch, P3
 * ordering, P4 pause) read/write the same record, which is why the schema is
 * declared here now.
 */
const FleetIntentSchema = z.object({
  schemaVersion: z.literal(FLEET_SCHEMA_VERSION),
  fleetId: z.string(),
  /**
   * Members this fleet owns: launched and running, plus any the run stopped.
   *
   * A stopped member deliberately stays here. Its stop record (`run.stopped`)
   * says why it needs a human; its worktree, branch, and bead are still live, so
   * dropping it would erase the fleet's only handle on that work (and make a
   * sibling's blocker look like a bead outside the fleet). Only a land or an
   * explicit operator removal takes an id out.
   */
  taskIds: z.array(z.string()).max(FLEET_INTENT_MEMBERS_MAX),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  /** Requested concurrency ceiling (P3); absent means "use the default". */
  maxConcurrent: z.number().int().positive().optional(),
  /**
   * Members P3 deferred to a later launch (P3 ordering/capacity).
   *
   * A deferred member is **not** launched, so it is deliberately absent from
   * `taskIds` until it starts: each entry says why it waits. A launch that adds
   * members unions its new plan with the entries it did not schedule, and a
   * supervisor re-arm leaves the whole list untouched. P4's explicit advance step
   * (`belayd_fleet_advance`) uses this list as its worklist. A member the run
   * stopped is retired from it, so an advance cannot relaunch it.
   */
  deferred: z
    .array(
      z.object({
        taskId: z.string(),
        reason: z.enum(FLEET_SCHEDULE_DEFERRAL_REASONS),
        detail: z.string(),
      }),
    )
    .max(FLEET_INTENT_DEFERRED_MAX)
    .optional(),
  /** Set while the operator has paused the fleet (P4). */
  paused: z.boolean().optional(),
  /**
   * Members whose capacity slot has been given back without removing them
   * (bd-166).
   *
   * A release is not a prune: the bead, worktree, transcript, and mailbox stay, and
   * the id stays in `taskIds` so status, mail, and a later landing still see it. It
   * only stops the member consuming one of the repository's concurrent-orchestrator
   * slots. A terminal run writes one per member that did not land; the operator can
   * write one with `belayd_fleet_release`. Cleared when the member lands or is
   * launched again.
   */
  released: z
    .array(
      z.object({
        taskId: z.string().min(1).max(128),
        // One source of truth with `FLEET_MEMBER_RELEASE_REASONS`: a hand-edited or
        // future-writer label must be rejected by the reader, not printed as if it
        // were a reason the code knows (the deferred `reason` enum works the same).
        reason: z.enum(FLEET_MEMBER_RELEASE_REASONS),
        at: z.number().finite(),
      }),
    )
    .max(FLEET_INTENT_MEMBERS_MAX)
    .optional(),
  /**
   * Why the fleet is paused, when a repair path wrote a reason (P2/P4).
   *
   * `stashRef` is what makes unparking mechanical instead of archaeological: the
   * merge parked the fleet because the recorded root stash could not be restored,
   * and reconcile needs the exact sha to retry. `note` keeps the human wording (and
   * older records carry only that), so P0 renders both.
   */
  park: z
    .object({
      reason: z.string(),
      stashRef: z.string().optional(),
      recordedAt: z.number().finite(),
    })
    .optional(),
  note: z.string().optional(),
  /**
   * bd gates that order this fleet's members (bd-158).
   *
   * Ordering lives here, not in `bd dep list`: each entry says which member blocks
   * which, and under which gate bead, so a landing can resolve exactly the gates
   * its merge satisfied and the reaper can find orphans after a supervisor
   * restart. It belongs to the *intent* rather than to the `run` record because
   * gates outlive a run: a re-arm, a wave advance, or a second run over the same
   * fleet must still find (and finish resolving) them.
   */
  orderingGates: z
    .array(
      z.object({
        blocker: z.string().min(1).max(128),
        blocked: z.string().min(1).max(128),
        gateId: z.string().min(1).max(128),
      }),
    )
    .max(FLEET_INTENT_ORDERING_GATES_MAX)
    .optional(),
  /**
   * P5 autonomous-run record.
   *
   * Absent for an explicit, operator-driven fleet; present once a launch asked to
   * run until every member is landed. It lives in the intent so a supervisor
   * restart resumes the loop instead of re-landing members it already landed.
   */
  run: FleetRunSchema.optional(),
  /** Branch merges land on (P2). Absent means the repository's default branch. */
  baseBranch: z.string().optional(),
  /**
   * The supervisor session that owns this fleet (P4 crash reconcile): a later
   * session needs to tell "my fleet" from one abandoned by a dead process.
   *
   * `pidStartTime` (`/proc/<pid>/stat` field 22) and `armToken` are the two
   * anti-impersonation anchors: the pid alone is reusable by an unrelated live
   * process, and a session id is public. Both are optional so a hand-written
   * intent still parses; a record missing them simply never matches a live
   * session (see `matchesFleetSupervisor`).
   */
  supervisor: z
    .object({
      sessionId: z.string(),
      pid: z.number().int().positive(),
      pidStartTime: z.string().optional(),
      armToken: z.string().optional(),
    })
    .optional(),
});

export type FleetIntent = z.infer<typeof FleetIntentSchema>;
export type FleetSupervisor = NonNullable<FleetIntent["supervisor"]>;

/** Parse a fleet intent file; absent/corrupt/wrong-version all yield undefined. */
export function parseFleetIntent(raw: unknown): FleetIntent | undefined {
  const result = FleetIntentSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Why a value cannot be stored as `fleet.json`, or undefined when it can.
 *
 * The reader refuses a record it cannot parse, so an unvalidated write is
 * unrecoverable: one over-long or over-bound field makes the fleet intent
 * permanently unreadable for status, launch, tick, and reconcile, with no
 * self-repair (`writeFleetIntent` refuses to replace a corrupt file). The write
 * path therefore validates before the bytes land, and this is the schema check it
 * shares with the reader — one schema, so a writer can never mint a record its own
 * reader rejects.
 */
export function fleetIntentWriteRefusal(raw: unknown): string | undefined {
  const result = FleetIntentSchema.safeParse(raw);
  if (result.success) return undefined;
  const issues = result.error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
  return `invalid fleet intent (${issues.join("; ")})`;
}

// ── Shared fleet state paths ──────────────────────────────────────────

/**
 * Sanitize an operator-supplied fleet id before it becomes a path segment.
 * An empty or dot-only id would collapse or escape the fleet root, so it falls
 * back to {@link DEFAULT_FLEET_ID}.
 */
export function sanitizeFleetId(fleetId: string): string {
  const sanitized = fleetId.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized === "" || sanitized === "." || sanitized === ".." ? DEFAULT_FLEET_ID : sanitized;
}

/** `<git-common-dir>/belayd/fleet/<fleetId>/` — shared by every worktree. */
export function fleetStateDir(gitCommonDir: string, fleetId: string): string {
  return join(gitCommonDir, "belayd", "fleet", sanitizeFleetId(fleetId));
}

export function fleetIntentFilePath(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "fleet.json");
}

/** Member → supervisor note drop, drained at turn start (P1). Unused in P0. */
export function fleetInboxDir(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "inbox");
}

/** Supervisor → member notification drop, drained at turn start (P1). Unused in P0. */
export function fleetEventsDir(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "events");
}

/** Single-flight merge queue (P2). Unused in P0. */
export function fleetMergeQueueFilePath(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "merge-queue.json");
}

/** Append-only cross-tree authority audit log (P2+). Unused in P0. */
export function fleetAuditLogPath(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "audit.log");
}

// ── Derived member state ──────────────────────────────────────────────

/** What the worktree's `.belayd/workflow.json` turned out to be. */
export type FleetWorkflowFile = "ok" | "missing" | "corrupt";

/** Already-read workflow state for one worktree; never read inside the pure layer. */
export type FleetWorkflowSnapshot =
  | { kind: "ok"; state: WorkflowState }
  | { kind: "missing" }
  | { kind: "corrupt" };

/** Everything the pure view builder needs about one worktree. */
export interface FleetMemberSnapshot {
  worktreePath: string;
  /**
   * True for the repository's own checkout. It only joins a fleet when it
   * holds workflow state (an in-place workflow); otherwise it is the
   * supervisor's merge target, not a member.
   */
  isMainWorktree: boolean;
  /** Branch checked out here; undefined on detached HEAD or unreadable git. */
  branch: string | undefined;
  workflow: FleetWorkflowSnapshot;
  /** Run manifests from `listRuns` at that worktree. */
  runs: readonly RunManifest[];
  /**
   * The worktree directory's creation instant, when the seam can `stat` it (bd-166).
   *
   * The launch-evidence cutoff: an inherited run manifest predates the tree that
   * holds it, so this keeps "this member ran" from meaning "this task ran once".
   */
  createdAt?: number;
  /** Orchestrator lease as read; no clock is applied here (freshness is the tools' job). */
  lease: FleetLeaseSnapshot;
}

/**
 * The worktree's orchestrator lease as the observer saw it.
 *
 * Deliberately clock-free: a read-only view must stay byte-stable, so this says
 * *what the file says* and leaves "live vs stale" to the tools that act on it.
 */
export type FleetLeaseSnapshot =
  | { state: "absent" }
  | { state: "held"; claim: OrchestratorClaim }
  | { state: "corrupt"; error: string };

/** Lease fields the view exposes; a `claim` is the raw record when it parsed. */
export interface FleetLeaseView {
  state: "absent" | "held" | "corrupt";
  taskId?: string;
  sessionId?: string;
  heartbeatAt?: number;
  error?: string;
}

/** Reduce a lease snapshot to the fields the text view prints. */
export function fleetLeaseView(snapshot: FleetLeaseSnapshot): FleetLeaseView {
  switch (snapshot.state) {
    case "absent":
      return { state: "absent" };
    case "corrupt":
      return { state: "corrupt", error: snapshot.error };
    case "held":
      return {
        state: "held",
        taskId: snapshot.claim.taskId,
        sessionId: snapshot.claim.sessionId,
        heartbeatAt: snapshot.claim.heartbeatAt,
      };
  }
}

/**
 * Coarse derived member state. Ordered by precedence in
 * {@link deriveFleetMemberState}: a crash outranks a pending human review, a
 * failed run outranks normal progress.
 */
export const FLEET_MEMBER_STATES = [
  "active",
  "blocked",
  "awaiting-human",
  "interrupted",
  "idle",
  "missing-state",
] as const;

export type FleetMemberState = (typeof FLEET_MEMBER_STATES)[number];

export type FleetStateCounts = Record<FleetMemberState, number>;

/** Most recent run recorded for one phase. */
export interface FleetPhaseRunView {
  phase: string;
  runId: string;
  status: RunStatus;
  startedAt: number;
  completedAt: number | undefined;
}

export interface FleetMemberView {
  /** Task id recorded in workflow.json; undefined without readable state. */
  taskId: string | undefined;
  /**
   * Task id implied by the checked-out branch (or the worktree directory name
   * when the branch is unavailable). Used to flag a stale `workflow.json`.
   */
  expectedTaskId: string | undefined;
  worktreePath: string;
  branch: string | undefined;
  workflowFile: FleetWorkflowFile;
  workflowType: string | undefined;
  phaseOrder: readonly string[];
  completedPhases: readonly string[];
  pendingPhases: readonly string[];
  awaitingReviewResponse: boolean;
  latestRuns: readonly FleetPhaseRunView[];
  interruptedRunCount: number;
  /** workflow.json `updatedAt`, raised to the newest run timestamp when that is later. */
  updatedAt: number | undefined;
  /** Orchestrator lease: the only honest evidence of a live member orchestrator. */
  lease: FleetLeaseView;
  /** Read-only `bd show` metadata, when a lookup succeeded for this task id. */
  bead?: FleetBead;
  /** Ownership/human columns read on top of the bead record; absent when unread. */
  engagement?: FleetBeadEngagement;
  state: FleetMemberState;
}

export const FLEET_WARNING_KINDS = [
  "missing-workflow-state",
  "corrupt-workflow-state",
  "unparsed-worktree-path",
  "duplicate-task-id",
  "task-id-mismatch",
  "bead-metadata-unavailable",
  "bead-metadata-missing",
  "bead-engagement-unavailable",
  "stale-member",
  "capacity-held",
  "run-not-ticking",
] as const;

export type FleetWarningKind = (typeof FLEET_WARNING_KINDS)[number];

export interface FleetWarning {
  kind: FleetWarningKind;
  taskId?: string;
  worktreePath?: string;
  message: string;
}

export interface FleetStatus {
  schemaVersion: number;
  /** Sanitized id whose directory actually located the fleet files. */
  fleetId: string;
  /** Raw operator input, set only when sanitizing changed it. */
  requestedFleetId?: string;
  intent: FleetIntent | undefined;
  members: FleetMemberView[];
  counts: FleetStateCounts;
  /**
   * The repository-wide capacity arithmetic (bd-166), when the caller supplied the
   * per-fleet liveness observation. Absent for a pure build that has no such data,
   * in which case the view renders exactly what it rendered before.
   */
  capacity?: FleetCapacityArithmetic;
  warnings: FleetWarning[];
}

/** One recorded member as the capacity arithmetic sees it (bd-166). */
export interface FleetCapacityMemberInput {
  taskId: string;
  liveness: FleetMemberLiveness;
  stopped?: boolean;
  released?: boolean;
  /** Whether any worktree in this repository holds the member's branch. */
  worktreePresent?: boolean;
}

/** One fleet's recorded membership, as read for the capacity view. */
export interface FleetCapacityFleetInput {
  fleetId: string;
  members: readonly FleetCapacityMemberInput[];
  supervisor: FleetCapacitySupervisor;
  /** The fleet's run record, for `run-not-ticking`. */
  run?: { ticks: number; updatedAt: number; active: boolean };
}

export interface FleetCapacityInput {
  ceiling: number;
  fleets: readonly FleetCapacityFleetInput[];
}

export interface BuildFleetStatusOptions {
  fleetId: string;
  /** Raw caller input when it differs from `fleetId`; reported, never used for paths. */
  requestedFleetId?: string;
  intent: FleetIntent | undefined;
  members: readonly FleetMemberSnapshot[];
  /** Worktree-enumeration warnings (e.g. an unrepresentable porcelain path). */
  worktreeWarnings?: readonly FleetWarning[];
  /** Every fleet's membership + liveness, for the capacity block and its warnings. */
  capacity?: FleetCapacityInput;
  /** Clock for `run-not-ticking`; absent means "do not judge run freshness". */
  now?: number;
}

/**
 * Task id carried by a worktree directory name such as `<repo>.feat-bd-42`.
 *
 * Deliberately the same shape as `taskIdFromBranch` (`bd-<digits>` plus at most
 * one sub-bead segment): a multi-dot id is not a task id there either, and two
 * different patterns would silently skip the mismatch check for one source.
 * The only difference is the separator before `bd-`: a directory name joins the
 * branch with `.` or `-`, not `/`.
 */
const TASK_ID_SUFFIX = /(?:^|[^A-Za-z0-9])(bd-\d+(?:\.\d+)?)$/;

function expectedTaskIdFor(snapshot: FleetMemberSnapshot): string | undefined {
  if (snapshot.branch !== undefined) {
    const fromBranch = taskIdFromBranch(snapshot.branch);
    if (fromBranch !== undefined) return fromBranch;
  }
  return TASK_ID_SUFFIX.exec(basename(snapshot.worktreePath))?.[1];
}

/**
 * Task id the run loop keys this worktree by.
 *
 * The loop finds a member by the task id its intent launched and the branch the
 * worktree checks out. When the branch names a fleet member, that id — not a
 * possibly stale `workflow.json` task id — decides which manifests are its
 * evidence, so both readers look at the same runs (bd-161).
 */
function runLoopTaskId(input: {
  expectedTaskId: string | undefined;
  workflowTaskId: string | undefined;
  intent: FleetIntent | undefined;
}): string | undefined {
  const fleetTaskIds = input.intent?.taskIds ?? [];
  if (input.expectedTaskId !== undefined && fleetTaskIds.includes(input.expectedTaskId)) {
    return input.expectedTaskId;
  }
  return input.workflowTaskId ?? input.expectedTaskId;
}

/** When the run record launched this member; absent for a member it did not launch. */
function launchedAtFor(
  intent: FleetIntent | undefined,
  taskId: string | undefined,
): number | undefined {
  if (taskId === undefined) return undefined;
  return (intent?.run?.members ?? []).find((member) => member.taskId === taskId)?.launchedAt;
}

/**
 * Run manifests this worktree's member owns, filtered exactly like the run loop.
 *
 * `.belayd/` is copied into a new worktree, so an unfiltered list reports an
 * inherited failure as this member's (bd-161) and `belayd_fleet_status` would
 * contradict the loop's own `starting`/`missing` verdict for the same worktree.
 *
 * The same filter is what keeps `latest runs` and the interrupted count honest
 * when a consumer repository commits `.belayd/runs` (bd-146): a fresh worktree
 * would otherwise check out another bead's phase runs and report them as its own.
 */
function memberRuns(
  snapshot: FleetMemberSnapshot,
  taskId: string | undefined,
  intent: FleetIntent | undefined,
): readonly RunManifest[] {
  // With no member id there is nothing to attribute runs to, so the view reports
  // them as read rather than hiding every manifest behind a missing key.
  if (taskId === undefined) return snapshot.runs;
  const launchedAt = launchedAtFor(intent, taskId);
  return runsBelongingToMember({
    runs: snapshot.runs,
    taskId,
    ...(launchedAt === undefined ? {} : { launchedAt }),
    // With a run record the loop is deciding this worktree, and it refuses a
    // failure it cannot attribute to the launch; without one this view only
    // reports the files it read, so a failure stays visible.
    failuresRequireLaunch: intent?.run !== undefined,
  });
}

function countInterrupted(runs: readonly RunManifest[]): number {
  return runs.filter((run) => run.status === RunStatus.Interrupted).length;
}

function lastRunTimestamp(runs: readonly RunManifest[]): number | undefined {
  let latest: number | undefined;
  for (const run of runs) {
    const stamp = run.completedAt ?? run.startedAt;
    if (latest === undefined || stamp > latest) latest = stamp;
  }
  return latest;
}

/**
 * Locale-independent string order. `localeCompare` changes with the host ICU
 * locale, which would make the "deterministic" view locale-dependent.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Total order on run manifests for one phase: newer start wins, then the run id
 * by code unit. `listRuns` orders equal timestamps by `readdirSync`, so without
 * the secondary key the derived state could flip between invocations.
 */
function isLaterRun(candidate: RunManifest, existing: RunManifest): boolean {
  if (candidate.startedAt !== existing.startedAt) {
    return candidate.startedAt > existing.startedAt;
  }
  return compareCodeUnits(candidate.runId, existing.runId) > 0;
}

/** The single "latest manifest per phase" rule shared by view and state derivation. */
function latestManifestPerPhase(runs: readonly RunManifest[]): Map<string, RunManifest> {
  const latest = new Map<string, RunManifest>();
  for (const run of runs) {
    const existing = latest.get(run.phase);
    if (existing === undefined || isLaterRun(run, existing)) {
      latest.set(run.phase, run);
    }
  }
  return latest;
}

/** Latest manifest per phase, ordered by the workflow's phase order. */
function latestRunPerPhase(
  runs: readonly RunManifest[],
  phaseOrder: readonly string[],
): FleetPhaseRunView[] {
  const rank = (phase: string): number => {
    const index = phaseOrder.indexOf(phase);
    return index === -1 ? phaseOrder.length : index;
  };

  return [...latestManifestPerPhase(runs).values()]
    .sort((a, b) => rank(a.phase) - rank(b.phase) || compareCodeUnits(a.phase, b.phase))
    .map((run) => ({
      phase: run.phase,
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    }));
}

/** A `completedBy: "user"` run whose report was never delivered is awaiting an operator. */
function hasUndeliveredUserCompletion(runs: readonly RunManifest[]): boolean {
  return runs.some(
    (run) =>
      run.completedBy === "user" &&
      run.deliveredAt === undefined &&
      run.completionReport !== undefined,
  );
}

/** Whether the newest run for a not-yet-completed phase failed. */
function hasFailedPendingPhase(input: {
  runs: readonly RunManifest[];
  completedPhases: readonly string[];
}): boolean {
  const completed = new Set(input.completedPhases);
  return [...latestManifestPerPhase(input.runs).values()].some(
    (run) => !completed.has(run.phase) && run.status === RunStatus.Failed,
  );
}

export interface DeriveFleetMemberStateInput {
  workflow: FleetWorkflowSnapshot;
  runs: readonly RunManifest[];
  completedPhases: readonly string[];
  pendingPhases: readonly string[];
  awaitingReviewResponse: boolean;
}

/**
 * Pure state derivation. Precedence: no state → interrupted → awaiting human →
 * blocked (newest run of a pending phase failed) → idle (every phase done) →
 * active (workflow in progress, whether or not a run is in flight).
 */
export function deriveFleetMemberState(input: DeriveFleetMemberStateInput): FleetMemberState {
  if (input.workflow.kind !== "ok") return "missing-state";
  if (countInterrupted(input.runs) > 0) return "interrupted";
  if (input.awaitingReviewResponse || hasUndeliveredUserCompletion(input.runs)) {
    return "awaiting-human";
  }
  if (hasFailedPendingPhase(input)) return "blocked";
  if (input.pendingPhases.length === 0) return "idle";
  return "active";
}

function memberView(
  snapshot: FleetMemberSnapshot,
  intent: FleetIntent | undefined,
): FleetMemberView {
  const expectedTaskId = expectedTaskIdFor(snapshot);
  const taskId = runLoopTaskId({
    expectedTaskId,
    workflowTaskId: snapshot.workflow.kind === "ok" ? snapshot.workflow.state.taskId : undefined,
    intent,
  });
  const runs = memberRuns(snapshot, taskId, intent);
  const interruptedRunCount = countInterrupted(runs);
  const runTimestamp = lastRunTimestamp(runs);

  if (snapshot.workflow.kind !== "ok") {
    return {
      taskId: undefined,
      expectedTaskId,
      worktreePath: snapshot.worktreePath,
      branch: snapshot.branch,
      workflowFile: snapshot.workflow.kind,
      workflowType: undefined,
      phaseOrder: [],
      completedPhases: [],
      pendingPhases: [],
      awaitingReviewResponse: false,
      latestRuns: latestRunPerPhase(runs, []),
      interruptedRunCount,
      updatedAt: runTimestamp,
      lease: fleetLeaseView(snapshot.lease),
      state: "missing-state",
    };
  }

  const state = snapshot.workflow.state;
  const completedPhases = [...state.completedPhaseNames];
  const completed = new Set(completedPhases);
  const pendingPhases = state.phaseOrder.filter((phase) => !completed.has(phase));
  // Absent flag means "not awaiting" (pre-bd-81 state files predate the field).
  const awaitingReviewResponse = state.awaitingReviewResponse === true;

  return {
    taskId: state.taskId,
    expectedTaskId,
    worktreePath: snapshot.worktreePath,
    branch: snapshot.branch,
    workflowFile: "ok",
    workflowType: state.workflowType,
    phaseOrder: [...state.phaseOrder],
    completedPhases,
    pendingPhases,
    awaitingReviewResponse,
    latestRuns: latestRunPerPhase(runs, state.phaseOrder),
    interruptedRunCount,
    updatedAt:
      runTimestamp === undefined ? state.updatedAt : Math.max(state.updatedAt, runTimestamp),
    lease: fleetLeaseView(snapshot.lease),
    state: deriveFleetMemberState({
      workflow: snapshot.workflow,
      runs,
      completedPhases,
      pendingPhases,
      awaitingReviewResponse,
    }),
  };
}

/** Members sort by task id (state-less members last), then by path. */
function compareMembers(a: FleetMemberView, b: FleetMemberView): number {
  const aKey = a.taskId ?? "";
  const bKey = b.taskId ?? "";
  if (aKey !== bKey) {
    if (aKey === "") return 1;
    if (bKey === "") return -1;
    return compareCodeUnits(aKey, bKey);
  }
  return compareCodeUnits(a.worktreePath, b.worktreePath);
}

function countMemberStates(members: readonly FleetMemberView[]): FleetStateCounts {
  const counts: FleetStateCounts = {
    active: 0,
    blocked: 0,
    "awaiting-human": 0,
    interrupted: 0,
    idle: 0,
    "missing-state": 0,
  };
  for (const member of members) counts[member.state] += 1;
  return counts;
}

function collectWarnings(members: readonly FleetMemberView[]): FleetWarning[] {
  const warnings: FleetWarning[] = [];

  for (const member of members) {
    switch (member.workflowFile) {
      case "missing":
        warnings.push({
          kind: "missing-workflow-state",
          worktreePath: member.worktreePath,
          message: `no .belayd/workflow.json in ${member.worktreePath}; that worktree drives no workflow`,
        });
        break;
      case "corrupt":
        warnings.push({
          kind: "corrupt-workflow-state",
          worktreePath: member.worktreePath,
          message: `unreadable .belayd/workflow.json in ${member.worktreePath}`,
        });
        break;
      case "ok":
        if (
          member.taskId !== undefined &&
          member.expectedTaskId !== undefined &&
          member.taskId !== member.expectedTaskId
        ) {
          warnings.push({
            kind: "task-id-mismatch",
            taskId: member.taskId,
            worktreePath: member.worktreePath,
            message:
              `${member.worktreePath} records ${member.taskId}, but its branch or directory ` +
              `names ${member.expectedTaskId}`,
          });
        }
        break;
    }
  }

  const byTaskId = new Map<string, string[]>();
  for (const member of members) {
    if (member.taskId === undefined) continue;
    const paths = byTaskId.get(member.taskId) ?? [];
    paths.push(member.worktreePath);
    byTaskId.set(member.taskId, paths);
  }
  for (const taskId of [...byTaskId.keys()].sort(compareCodeUnits)) {
    const paths = byTaskId.get(taskId);
    if (paths === undefined || paths.length < 2) continue;
    warnings.push({
      kind: "duplicate-task-id",
      taskId,
      message: `${taskId} is claimed by ${paths.length} worktrees: ${[...paths].sort(compareCodeUnits).join(", ")}`,
    });
  }

  return warnings;
}

/**
 * Warnings only the capacity arithmetic can see (bd-166).
 *
 * Three shapes, all of them invisible before: a recorded member whose work is gone
 * (`stale-member`), a fleet holding slots with nobody watching it
 * (`capacity-held`), and an active run whose ticker stopped (`run-not-ticking`).
 */
function sortedCapacityFleets(capacity: FleetCapacityInput): FleetCapacityFleetInput[] {
  return [...capacity.fleets].sort((left, right) => compareCodeUnits(left.fleetId, right.fleetId));
}

/** Recorded members whose worktree is gone and which nobody released (bd-166). */
function staleMemberWarnings(fleets: readonly FleetCapacityFleetInput[]): FleetWarning[] {
  const warnings: FleetWarning[] = [];
  for (const fleet of fleets) {
    for (const member of fleet.members) {
      if (member.released === true || member.worktreePresent !== false) continue;
      warnings.push({
        kind: "stale-member",
        taskId: member.taskId,
        message:
          `fleet ${fleet.fleetId} still records ${member.taskId}, but no worktree holds ` +
          `feat/${member.taskId}; release it with belayd_fleet_release ${member.taskId} ` +
          "(or reconcile --prune-dead-members) if its work is gone",
      });
    }
  }
  return warnings;
}

/** Fleets that still hold slots while no live supervisor watches them (bd-166). */
function capacityHeldWarnings(options: {
  fleets: readonly FleetCapacityFleetInput[];
  arithmetic: FleetCapacityArithmetic;
  ceiling: number;
}): FleetWarning[] {
  const contributors = new Map(
    options.arithmetic.contributors.map((contributor) => [contributor.fleetId, contributor]),
  );
  const warnings: FleetWarning[] = [];
  for (const fleet of options.fleets) {
    const contributor = contributors.get(fleet.fleetId);
    if (contributor === undefined || contributor.counted === 0) continue;
    if (fleet.supervisor === "live") continue;
    warnings.push({
      kind: "capacity-held",
      message:
        `fleet ${fleet.fleetId} counts ${contributor.counted} member(s) against the ceiling of ` +
        `${options.ceiling} but has no live supervisor ` +
        `(recorded supervisor: ${fleet.supervisor}); re-arm it or release the members`,
    });
  }
  return warnings;
}

/** Active runs whose ticker has been silent past the derived bound (bd-166). */
function runNotTickingWarnings(
  fleets: readonly FleetCapacityFleetInput[],
  now: number,
): FleetWarning[] {
  const warnings: FleetWarning[] = [];
  for (const fleet of fleets) {
    const run = fleet.run;
    if (run === undefined || !run.active) continue;
    const age = now - run.updatedAt;
    if (age <= FLEET_RUN_STALE_TICK_MS) continue;
    warnings.push({
      kind: "run-not-ticking",
      message:
        `fleet ${fleet.fleetId} has an active run whose last tick was at ` +
        `${new Date(run.updatedAt).toISOString()} (${run.ticks} tick(s), ` +
        `${Math.floor(age / FLEET_RUN_TICK_INTERVAL_MS)} tick interval(s) ago, bound ` +
        `${FLEET_RUN_STALE_TICK_INTERVALS}); nothing will land or advance until a session ` +
        "resumes the loop (re-arm the fleet) or an operator releases/lands the members",
    });
  }
  return warnings;
}

function collectCapacityWarnings(options: {
  capacity: FleetCapacityInput;
  arithmetic: FleetCapacityArithmetic;
  now: number | undefined;
}): FleetWarning[] {
  const fleets = sortedCapacityFleets(options.capacity);
  return [
    ...staleMemberWarnings(fleets),
    ...capacityHeldWarnings({
      fleets,
      arithmetic: options.arithmetic,
      ceiling: options.capacity.ceiling,
    }),
    ...(options.now === undefined ? [] : runNotTickingWarnings(fleets, options.now)),
  ];
}

/**
 * Pure rollup: no fs, no git. Every input is already-read data, so tests need
 * no mocks and the same snapshot always yields the same view.
 */
export function buildFleetStatus(options: BuildFleetStatusOptions): FleetStatus {
  const members: FleetMemberView[] = [];
  for (const snapshot of options.members) {
    // The main checkout is the supervisor's merge target, not a fleet member,
    // unless an in-place workflow gave it workflow state.
    if (snapshot.isMainWorktree && snapshot.workflow.kind === "missing") continue;
    members.push(memberView(snapshot, options.intent));
  }
  members.sort(compareMembers);

  const capacity = capacityArithmeticOf(options.capacity);
  return {
    schemaVersion: FLEET_SCHEMA_VERSION,
    fleetId: options.fleetId,
    requestedFleetId:
      options.requestedFleetId === undefined || options.requestedFleetId === options.fleetId
        ? undefined
        : options.requestedFleetId,
    intent: options.intent,
    members,
    counts: countMemberStates(members),
    ...(capacity === undefined ? {} : { capacity }),
    warnings: [
      ...(options.worktreeWarnings ?? []),
      ...collectWarnings(members),
      ...(options.capacity === undefined || capacity === undefined
        ? []
        : collectCapacityWarnings({
            capacity: options.capacity,
            arithmetic: capacity,
            now: options.now,
          })),
    ],
  };
}

/** Project the reader's per-member observation onto the shared arithmetic. */
function capacityArithmeticOf(
  input: FleetCapacityInput | undefined,
): FleetCapacityArithmetic | undefined {
  if (input === undefined) return undefined;
  return describeFleetCapacity({
    ceiling: input.ceiling,
    fleets: [...input.fleets]
      .sort((left, right) => compareCodeUnits(left.fleetId, right.fleetId))
      .map((fleet) => ({
        fleetId: fleet.fleetId,
        supervisor: fleet.supervisor,
        members: fleet.members.map((member) => ({
          taskId: member.taskId,
          liveness: member.liveness,
          ...(member.stopped === true ? { stopped: true } : {}),
          ...(member.released === true ? { released: true } : {}),
        })),
      })),
  });
}

// ── Bead metadata (read-only bd enrichment) ─────────────────────────

/** Narrowed bead metadata; every field except `id` may be absent in bd's output. */
export interface FleetBead {
  id: string;
  title: string | undefined;
  status: string | undefined;
  priority: number | undefined;
  labels: readonly string[];
  /** bd's assignee (`belayd:<task>:<phase>` or a person); absent when unassigned. */
  assignee?: string;
  /** bd's owner (`owner` in `bd show --json`); absent on older records. */
  owner?: string;
  /** Size of the comment thread, when bd reports it. */
  commentCount?: number;
  /** bd's last-update timestamp, as printed (ISO string). */
  updatedAt?: string;
}

/** Newest comment on a bead: display only, one capped line. */
export interface FleetBeadComment {
  author: string;
  text: string;
  createdAt: string;
}

/**
 * Comment column: read or unknown.
 *
 * An absent `newestComment` used to mean both "empty thread" and "the read
 * failed", so a bd outage rendered `(none)` — a false claim. Only a successful
 * read (`state: "read"`) may say `(none)`; every other case is `(unknown)`.
 */
export type FleetBeadCommentRead =
  | { state: "read"; newest?: FleetBeadComment }
  | { state: "unknown" };

/**
 * What a bead is waiting on, as far as a read-only view can tell.
 *
 * `awaitingHuman` is deliberately tri-state. bd-152 replaced the old
 * `.belayd/human-question.json` marker with a `human` bd gate, and a gate record
 * that does not parse (renamed `status`/`await_type`, malformed JSON, a failed
 * read) must never render as "not waiting": undefined means unknown.
 */
export interface FleetBeadEngagement {
  comments: FleetBeadCommentRead;
  /** open = a human gate blocks it; none = resolved; undefined = unknown (read failed/malformed). */
  awaitingHuman?: boolean;
  /**
   * The fleet member this bead is ordered behind (bd-158 ordering gate).
   *
   * Absent means no readable ordering gate. It is deliberately *not* folded into
   * `awaitingHuman`: an ordering gate waits on another member's landing, so the
   * view says `waiting on: bd-12` and never puts the member in "Needs you".
   */
  orderingBlocker?: string;
}

/**
 * One bead record as `bd show --json` prints it.
 *
 * Unknown keys are stripped and each optional field `.catch`es to `undefined`
 * instead of failing the record: bd renames and re-types fields between minor
 * versions, and losing a title must never cost the whole fleet its bead view.
 */
const BeadRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  priority: z.number().finite().optional().catch(undefined),
  labels: z.array(z.string()).optional().catch(undefined),
  assignee: z.string().optional().catch(undefined),
  owner: z.string().optional().catch(undefined),
  comment_count: z.number().int().nonnegative().optional().catch(undefined),
  updated_at: z.string().optional().catch(undefined),
});

/** Parse one bead record; anything without a usable `id` yields undefined. */
export function parseBeadView(raw: unknown): FleetBead | undefined {
  const result = BeadRecordSchema.safeParse(raw);
  if (!result.success) return undefined;
  return {
    id: result.data.id,
    title: result.data.title,
    status: result.data.status,
    priority: result.data.priority,
    labels: result.data.labels ?? [],
    assignee: result.data.assignee,
    owner: result.data.owner,
    commentCount: result.data.comment_count,
    updatedAt: result.data.updated_at,
  };
}

/**
 * Parse a batched `bd show <ids> --json` payload. bd answers with an array for
 * a found set (and tolerates unknown ids inside that set), so a single record
 * is accepted too; an error object carries no `id` and therefore yields no
 * beads rather than an exception.
 */
export function parseBeadViews(raw: unknown): FleetBead[] {
  const parsed = parseBeadViewPayload(raw);
  return parsed.ok ? [...parsed.beads] : [];
}

/**
 * A bd bead payload, or bd answering in a shape this version cannot read.
 *
 * The distinction matters because "no beads" and "unreadable beads" are opposite
 * conclusions: a caller that reaps state on "these beads are gone" must never act
 * on a payload it does not understand. An empty array is a recognized answer; any
 * object without a bead list is not.
 */
export type BeadViewPayload =
  | { ok: true; beads: readonly FleetBead[] }
  | { ok: false; reason: "unrecognized-payload" };

/** Keys bd has used (or is documented to use) for a wrapped bead list. */
const BEAD_LIST_KEYS = ["beads", "issues"] as const;

/**
 * Parse a bd bead payload, tolerating the documented envelope shapes and
 * reporting anything else as unrecognized.
 *
 * `{issues: [...]}` is the wrapper bd was expected to grow, so it is read rather
 * than rejected: flattening it to "no beads" is the silent failure that made the
 * fleet report every member's bead as missing.
 */
export function parseBeadViewPayload(raw: unknown): BeadViewPayload {
  if (Array.isArray(raw)) return { ok: true, beads: beadsFromRecords(raw) };
  const record = asRecord(raw);
  if (record === undefined) return { ok: false, reason: "unrecognized-payload" };
  for (const key of BEAD_LIST_KEYS) {
    const nested = record[key];
    if (Array.isArray(nested)) return { ok: true, beads: beadsFromRecords(nested) };
  }
  const bead = parseBeadView(record);
  if (bead !== undefined) return { ok: true, beads: [bead] };
  return { ok: false, reason: "unrecognized-payload" };
}

function beadsFromRecords(records: readonly unknown[]): readonly FleetBead[] {
  const beads: FleetBead[] = [];
  for (const record of records) {
    const bead = parseBeadView(record);
    if (bead !== undefined) beads.push(bead);
  }
  return beads;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return isRecord(raw) ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Task ids worth one batched bead lookup: readable state only, syntactically
 * valid ids (so no recorded value can be read as a `bd` flag), de-duplicated
 * and code-unit sorted so the argv — and therefore the audit trail — is
 * deterministic. Empty means "do not invoke bd at all".
 */
export function fleetBeadTaskIds(status: FleetStatus): string[] {
  const ids = new Set<string>();
  for (const member of status.members) {
    const taskId = member.taskId;
    if (taskId !== undefined && isValidTaskId(taskId)) ids.add(taskId);
  }
  // Recorded members with no worktree are asked about too: a bead merged by hand
  // leaves exactly that shape, and `stale-member` needs bd's status to say so.
  for (const taskId of status.intent?.taskIds ?? []) {
    if (isValidTaskId(taskId)) ids.add(taskId);
  }
  return [...ids].sort(compareCodeUnits);
}

/** Outcome of the batched bead read, as handed back to the pure layer. */
export type FleetBeadLookup =
  | { ok: true; beads: readonly FleetBead[] }
  | { ok: false; error: string };

/** Bound on the bd failure text kept in one warning (bd prints long hints). */
const BEAD_LOOKUP_ERROR_MAX_LENGTH = 300;

function boundLookupError(error: string): string {
  const singleLine = error.replace(/\s+/g, " ").trim();
  if (singleLine.length <= BEAD_LOOKUP_ERROR_MAX_LENGTH) return singleLine;
  return `${singleLine.slice(0, BEAD_LOOKUP_ERROR_MAX_LENGTH - 1)}…`;
}

/** Cap on the newest-comment excerpt in a status line; this is a view, not a thread. */
export const NEEDS_YOU_EXCERPT_MAX_CHARS = 120;

/** Human-relevant members listed in the "Needs you" block before it is elided. */
export const NEEDS_YOU_LIST_MAX = 10;

/** Missing ids named in one warning before the count alone carries the rest. */
const BEAD_MISSING_IDS_MAX = 5;

/**
 * Attach bead metadata to the derived view.
 *
 * Best-effort by design: `bd` may be absent, slow, or pointed at no database,
 * and none of that may break observation of the workflows. A failed lookup
 * leaves every member without `bead` and records exactly **one** fleet-level
 * warning — a missing bd is one fleet-wide fact, not one fact per member, so
 * this can never become a warning storm.
 *
 * A *successful* lookup that answers none of the expected ids is the other
 * silent failure: bd changing its payload shape (e.g. wrapping records in
 * `{issues: [...]}`, which `parseBeadViews` flattens to `[]`) would otherwise
 * drop every bead line with no diagnostic at all. That case emits one bounded
 * warning naming the missing count and at most {@link BEAD_MISSING_IDS_MAX} ids.
 */
export function applyFleetBeadLookup(status: FleetStatus, lookup: FleetBeadLookup): FleetStatus {
  if (!lookup.ok) {
    return {
      ...status,
      warnings: [
        ...status.warnings,
        {
          kind: "bead-metadata-unavailable",
          message: `bead metadata unavailable (bd read failed): ${boundLookupError(lookup.error)}`,
        },
      ],
    };
  }

  const byId = new Map<string, FleetBead>();
  for (const bead of lookup.beads) byId.set(bead.id.toLowerCase(), bead);

  const expected = fleetBeadTaskIds(status);
  const missing = expected.filter((taskId) => !byId.has(taskId.toLowerCase()));
  const warnings = [...status.warnings];
  warnings.push(...collectStaleBeadWarnings(status, lookup.beads));
  if (missing.length > 0) {
    const shown = missing.slice(0, BEAD_MISSING_IDS_MAX);
    const remainder = missing.length - shown.length;
    const suffix = remainder > 0 ? `, +${remainder} more` : "";
    warnings.push({
      kind: "bead-metadata-missing",
      message: boundLookupError(
        `bd returned no record for ${missing.length} of ${expected.length} fleet task id(s): ${shown.join(", ")}${suffix}`,
      ),
    });
  }

  return {
    ...status,
    members: status.members.map((member) => {
      if (member.taskId === undefined) return member;
      const bead = byId.get(member.taskId.toLowerCase());
      return bead === undefined ? member : { ...member, bead };
    }),
    warnings,
  };
}

/** Bead statuses that prove the fleet's work is over, whatever fleet.json says. */
const CLOSED_BEAD_STATUSES: readonly string[] = ["closed", "done"];

/**
 * Recorded members bd reports closed/done while they are not released (bd-166).
 *
 * This is the bd-37 shape: the work landed and the bead was closed by hand
 * (`wt merge` / `bd close`), so no fleet path ever saw the landing and the member
 * kept holding a capacity slot. Status alone is not proof of merging — that is what
 * the tick's ancestor check is for — but it is exactly the evidence that the member
 * needs a human decision, and the worktree-gone case has its own check at build
 * time, so a task id already named by one of those is not repeated here.
 */
function collectStaleBeadWarnings(
  status: FleetStatus,
  beads: readonly FleetBead[],
): FleetWarning[] {
  const recorded = new Set(status.intent?.taskIds ?? []);
  const released = new Set((status.intent?.released ?? []).map((entry) => entry.taskId));
  const already = new Set(
    status.warnings
      .filter((warning) => warning.kind === "stale-member" && warning.taskId !== undefined)
      .map((warning) => warning.taskId),
  );
  const warnings: FleetWarning[] = [];
  for (const bead of [...beads].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    if (!recorded.has(bead.id) || released.has(bead.id) || already.has(bead.id)) continue;
    const beadStatus = bead.status;
    if (beadStatus === undefined || !CLOSED_BEAD_STATUSES.includes(beadStatus)) continue;
    warnings.push({
      kind: "stale-member",
      taskId: bead.id,
      message:
        `fleet ${status.fleetId} still records ${bead.id}, but bd reports it ${beadStatus}; ` +
        `the work is over — release it with belayd_fleet_release ${bead.id}, or land it if ` +
        "its branch is on the base branch",
    });
  }
  return warnings;
}

/**
 * Engagement as handed back to the pure layer, keyed by task id.
 *
 * Mirrors {@link FleetBeadLookup}: `ok: false` is one fleet-wide fact that
 * degrades every member's ownership columns at once, never a warning per member.
 */
export type FleetEngagementLookup =
  | { ok: true; entries: readonly { taskId: string; engagement: FleetBeadEngagement }[] }
  | { ok: false; error: string };

/** Whether a bead carries the `human` label (the bd-side "needs a person" marker). */
export function beadNeedsHuman(bead: FleetBead | undefined): boolean {
  return bead?.labels.includes("human") === true;
}

/**
 * Attach ownership/human engagement to the derived view.
 *
 * Same contract as {@link applyFleetBeadLookup}: a failed read leaves every
 * member with no `engagement` and records exactly **one** warning. A missing
 * entry for one member is "unknown", not a failure of the fleet-wide read, so
 * it stays silent — a member may legitimately have no bead record to read.
 */
export function applyFleetBeadEngagement(
  status: FleetStatus,
  lookup: FleetEngagementLookup,
): FleetStatus {
  if (!lookup.ok) {
    return {
      ...status,
      warnings: [
        ...status.warnings,
        {
          kind: "bead-engagement-unavailable",
          message: `bead engagement unavailable (bd read failed): ${boundLookupError(lookup.error)}`,
        },
      ],
    };
  }

  const byTaskId = new Map<string, FleetBeadEngagement>();
  for (const entry of lookup.entries) {
    byTaskId.set(entry.taskId.toLowerCase(), entry.engagement);
  }

  return {
    ...status,
    members: status.members.map((member) => {
      if (member.taskId === undefined) return member;
      const engagement = byTaskId.get(member.taskId.toLowerCase());
      return engagement === undefined ? member : { ...member, engagement };
    }),
  };
}

// ── Plain-text formatter ──────────────────────────────────────────────

function formatIntent(intent: FleetIntent | undefined): string {
  if (intent === undefined) return "none recorded";
  const tasks = intent.taskIds.length === 0 ? "no task ids" : intent.taskIds.join(", ");
  const concurrency =
    intent.maxConcurrent === undefined ? "" : `, max ${intent.maxConcurrent} concurrent`;
  const paused = intent.paused === true ? ", paused" : "";
  return `${tasks}${concurrency}${paused}`;
}

/**
 * Persisted deferrals, one bounded line: what is waiting and why.
 *
 * The intent is the only read-only observation surface a supervisor has for a
 * member that never started, so "deferred and forgotten" must be visible here
 * rather than only in `audit.log`.
 */
function formatDeferred(deferred: NonNullable<FleetIntent["deferred"]>): string | undefined {
  if (deferred.length === 0) return undefined;
  const shown = deferred
    .slice(0, FLEET_INTENT_SUMMARY_MAX)
    .map((entry) => `${entry.taskId} (${entry.reason})`);
  const hidden = deferred.length - shown.length;
  const suffix = hidden > 0 ? `, ...and ${hidden} more` : "";
  return `deferred: ${shown.join(", ")}${suffix}`;
}

/** Rest of the ordering gates beyond the summary, so a wedge is never hidden. */
const ORDERING_GATES_LINE_MAX = 8;

/**
 * Recorded ordering gates, one bounded line.
 *
 * A record exists only while bd still has the gate open (a resolve drops it), so
 * this is exactly the list of dependents bd is still blocking on the fleet's
 * behalf. A landing that merged but could not resolve its gate leaves its record
 * here on purpose: without this line the only way to see that wedge would be to
 * read `bd gate list` or the docs.
 */
function formatOrderingGates(intent: FleetIntent | undefined): string | undefined {
  const gates = intent?.orderingGates ?? [];
  if (gates.length === 0) return undefined;
  const shown = gates
    .slice(0, ORDERING_GATES_LINE_MAX)
    .map((gate) => `${gate.blocker} -> ${gate.blocked} (gate ${gate.gateId})`);
  const hidden = gates.length - shown.length;
  const suffix = hidden > 0 ? `, ...and ${hidden} more` : "";
  return `ordering gates open: ${shown.join(", ")}${suffix} — resolved when the blocker lands`;
}

/** The park reason for a paused fleet, or undefined when it is not parked. */
function formatPark(intent: FleetIntent): string | undefined {
  if (intent.park === undefined) return undefined;
  const stash = intent.park.stashRef === undefined ? "" : ` (stash ${intent.park.stashRef})`;
  return `parked: ${intent.park.reason}${stash} — belayd_fleet_reconcile then belayd_fleet_resume`;
}

function formatCounts(counts: FleetStateCounts): string {
  return FLEET_MEMBER_STATES.map((state) => `${state}=${counts[state]}`).join(" ");
}

/**
 * Released members, one bounded line: a slot given back without losing the member.
 *
 * Without this line a released member looks identical to a live one in the intent,
 * which is exactly the confusion the release mechanism exists to remove.
 */
function formatReleased(released: NonNullable<FleetIntent["released"]>): string | undefined {
  if (released.length === 0) return undefined;
  // Defensive even though the schema types the label: a caller can hand-build an
  // intent object, and the view must not print a reason the code cannot interpret.
  const known = new Set<string>(FLEET_MEMBER_RELEASE_REASONS);
  const shown = released
    .slice(0, FLEET_INTENT_SUMMARY_MAX)
    .map((entry) => `${entry.taskId} (${known.has(entry.reason) ? entry.reason : "unrecognized"})`);
  const hidden = released.length - shown.length;
  const suffix = hidden > 0 ? `, ...and ${hidden} more` : "";
  return `released: ${shown.join(", ")}${suffix} — slot given back, member kept`;
}

/**
 * The repository-wide capacity arithmetic: the ceiling, what is free, and who
 * holds what (bd-166).
 *
 * Fleets with no recorded members are left out: they contribute nothing, and a
 * line per empty fleet directory would bury the ones that matter.
 */
function formatCapacity(capacity: FleetCapacityArithmetic | undefined): readonly string[] {
  if (capacity === undefined) return [];
  const lines = [
    `  capacity: ceiling ${capacity.ceiling}, ${capacity.free} free, ${capacity.counted} counted`,
  ];
  for (const contributor of capacity.contributors) {
    if (contributor.members === 0) continue;
    lines.push(
      `    ${contributor.fleetId}: ${contributor.members} member(s), ` +
        `${contributor.counted} counted (${contributor.live} live, ${contributor.unknown} unknown, ` +
        `${contributor.absent} absent), ${contributor.stopped} stopped, ` +
        `${contributor.released} released; supervisor ${contributor.supervisor}`,
    );
  }
  return lines;
}

function formatFleetId(status: FleetStatus): string {
  if (status.requestedFleetId === undefined) return status.fleetId;
  return `${status.fleetId} (requested "${status.requestedFleetId}")`;
}

function formatBeadLine(bead: FleetBead): string {
  const title = bead.title === undefined ? "(no title)" : bead.title;
  const status = bead.status === undefined ? "status unknown" : bead.status;
  return `  bead: ${title} (${status})`;
}

/** Owner text: absent means bd did not report one, which is not "nobody". */
function ownerText(bead: FleetBead): string {
  return bead.owner ?? "(unknown)";
}

/**
 * Assignee text: absent in bd means genuinely unassigned, so it says so.
 *
 * A failed read cannot reach this helper (the member keeps no `bead` then), so
 * `(unassigned)` never disguises bd being unavailable.
 */
function assigneeText(bead: FleetBead): string {
  return bead.assignee ?? "(unassigned)";
}

/** Tri-state human wait: an unread or unrecognized gate is `unknown`, never `no`. */
function awaitingHumanText(engagement: FleetBeadEngagement): string {
  switch (engagement.awaitingHuman) {
    case true:
      return "yes";
    case false:
      return "no";
    case undefined:
      return "unknown";
  }
}

function commentAuthorText(author: string): string {
  return author === "" ? "(unattributed)" : author;
}

/**
 * `author createdAt: "excerpt"`, one capped line; the whole thread is never printed.
 *
 * `(none)` is reachable only from a successful read, so a failed `bd comments`
 * read can never look like an empty thread.
 */
function newestCommentText(engagement: FleetBeadEngagement): string {
  if (engagement.comments.state === "unknown") return "(unknown)";
  const comment = engagement.comments.newest;
  if (comment === undefined) return "(none)";
  const excerpt = excerptComment(comment.text, NEEDS_YOU_EXCERPT_MAX_CHARS);
  return `${commentAuthorText(comment.author)} ${comment.createdAt}: "${excerpt}"`;
}

/**
 * Ownership columns shared by the fleet member block and `belayd_status`.
 *
 * `bead updated` and `comment count` render only when bd reported them: an
 * older bd that omits the field must not print a fabricated timestamp or a fake
 * zero count.
 */
function beadDetailLines(bead: FleetBead, prefix: string): string[] {
  const lines = [
    `${prefix}owner: ${ownerText(bead)}`,
    `${prefix}assignee: ${assigneeText(bead)}`,
    `${prefix}human: ${beadNeedsHuman(bead) ? "yes" : "no"}`,
  ];
  if (bead.updatedAt !== undefined) lines.push(`${prefix}bead updated: ${bead.updatedAt}`);
  if (bead.commentCount !== undefined) lines.push(`${prefix}comment count: ${bead.commentCount}`);
  return lines;
}

/** The ownership lines that follow a member's `bead:` line. */
function formatOwnershipLines(member: FleetMemberView): string[] {
  const lines: string[] = [];
  if (member.bead !== undefined) lines.push(...beadDetailLines(member.bead, "  "));
  // No engagement read (no bd, or the batched read failed) adds no lines at all:
  // the regression contract is that a view without engagement data is unchanged.
  if (member.engagement !== undefined) {
    lines.push(`  awaiting human: ${awaitingHumanText(member.engagement)}`);
    if (member.engagement.orderingBlocker !== undefined) {
      lines.push(`  waiting on: ${member.engagement.orderingBlocker} (fleet ordering gate)`);
    }
    lines.push(`  newest comment: ${newestCommentText(member.engagement)}`);
  }
  return lines;
}

/**
 * "Needs you": every bead that a human has to look at, named in one place.
 *
 * A supervisor's whole value here is aggregation: "bd-19 and bd-22 are both
 * waiting on you" is actionable, one member block at a time is not. Undefined
 * when nothing needs a human, so the fleet view omits the block entirely.
 */
export function formatNeedsYou(status: FleetStatus): string | undefined {
  const needy: Array<{ taskId: string; member: FleetMemberView }> = [];
  for (const member of status.members) {
    const taskId = member.taskId;
    if (taskId === undefined) continue;
    if (!beadNeedsHuman(member.bead) && member.engagement?.awaitingHuman !== true) continue;
    needy.push({ taskId, member });
  }
  if (needy.length === 0) return undefined;

  const shown = needy.slice(0, NEEDS_YOU_LIST_MAX);
  const hidden = needy.length - shown.length;
  const lines = [`Needs you (${needy.length}): ${shown.map((entry) => entry.taskId).join(", ")}`];
  for (const entry of shown) lines.push(formatNeedsYouEntry(entry));
  if (hidden > 0) lines.push(`  …and ${hidden} more`);
  return lines.join("\n");
}

function formatNeedsYouEntry(entry: { taskId: string; member: FleetMemberView }): string {
  const { member } = entry;
  // A member can be here on the gate alone when its bead record failed to read;
  // that is "unknown", not the fact "unassigned".
  const assignee =
    member.bead === undefined ? "(unknown)" : (member.bead.assignee ?? "(unassigned)");
  const parts = [`assignee ${assignee}`];
  if (member.engagement?.awaitingHuman === true) parts.push("awaiting human");
  return `  - ${entry.taskId} (${parts.join(", ")}) — ${needsYouCommentText(member.engagement)}`;
}

function needsYouCommentText(engagement: FleetBeadEngagement | undefined): string {
  if (engagement === undefined || engagement.comments.state === "unknown") {
    return "(comments unknown)";
  }
  if (engagement.comments.newest === undefined) return "(no comments yet)";
  return newestCommentText(engagement);
}

/** Input to {@link formatBeadOwnership}; every field is already-read data. */
export interface BeadOwnershipInput {
  /** Task id the session's workflow records; empty means "no bead to show". */
  cwdTaskId: string;
  bead?: FleetBead;
  engagement?: FleetBeadEngagement;
  /** Bounded read failure, rendered instead of the ownership columns. */
  error?: string;
}

/**
 * Ownership/human section for `belayd_status` (one bead, markdown).
 *
 * Undefined when there is nothing to say — no task id, or no bead/engagement was
 * read — so a session whose bd is absent prints no new section rather than a
 * block of "unknown" lines. A read failure is the one case that prints, because
 * silence there would look like "not waiting on a human". When only the
 * engagement read failed, the already-read bead columns are kept and the error
 * is appended, so a partial read is not thrown away.
 */
export function formatBeadOwnership(input: BeadOwnershipInput): string | undefined {
  if (input.cwdTaskId === "") return undefined;
  const hasData = input.bead !== undefined || input.engagement !== undefined;
  if (!hasData) {
    return input.error === undefined
      ? undefined
      : `bead detail unavailable (bd read failed): ${boundLookupError(input.error)}`;
  }

  const lines = [`**Bead ${input.cwdTaskId}**`];
  if (input.bead !== undefined) {
    lines.push(`- title: ${input.bead.title ?? "(no title)"}`);
    lines.push(`- status: ${input.bead.status ?? "status unknown"}`);
    lines.push(...beadDetailLines(input.bead, "- "));
  }
  if (input.engagement !== undefined) {
    lines.push(`- awaiting human: ${awaitingHumanText(input.engagement)}`);
    if (input.engagement.orderingBlocker !== undefined) {
      lines.push(`- waiting on: ${input.engagement.orderingBlocker} (fleet ordering gate)`);
    }
    lines.push(`- newest comment: ${newestCommentText(input.engagement)}`);
  }
  if (input.error !== undefined) {
    lines.push(`bead engagement unavailable (bd read failed): ${boundLookupError(input.error)}`);
  }
  if (beadNeedsHuman(input.bead) || input.engagement?.awaitingHuman === true) {
    lines.push(`**Needs you** — ${input.cwdTaskId} is waiting on a human.`);
  }
  return lines.join("\n");
}

/**
 * The orchestrator lease line.
 *
 * It prints the record, not a verdict: a read-only view cannot say "live" without
 * reading a clock, and the tools that act on liveness classify it themselves.
 */
function formatLeaseLine(lease: FleetLeaseView): string {
  switch (lease.state) {
    case "absent":
      return "  orchestrator lease: none";
    case "corrupt":
      return `  orchestrator lease: unreadable (${lease.error ?? "unknown error"})`;
    case "held": {
      const renewed =
        lease.heartbeatAt === undefined ? "unknown" : new Date(lease.heartbeatAt).toISOString();
      return (
        `  orchestrator lease: session ${lease.sessionId ?? "unknown"} for ` +
        `${lease.taskId ?? "unknown"}, renewed ${renewed}`
      );
    }
  }
}

function formatMember(member: FleetMemberView): string[] {
  const branch = member.branch === undefined ? "detached HEAD" : member.branch;
  const lines = [
    `Member ${member.taskId ?? "(no task id)"} — ${member.state}`,
    `  worktree: ${member.worktreePath} (branch ${branch})`,
  ];

  if (member.bead !== undefined) lines.push(formatBeadLine(member.bead));
  lines.push(...formatOwnershipLines(member));

  if (member.workflowFile === "ok") {
    const completedInOrder = member.phaseOrder.filter((phase) =>
      member.completedPhases.includes(phase),
    ).length;
    lines.push(
      `  workflow: ${member.workflowType ?? "unknown"} ${completedInOrder}/${member.phaseOrder.length} phases complete`,
    );
    lines.push(
      `  pending: ${member.pendingPhases.length === 0 ? "none" : member.pendingPhases.join(", ")}`,
    );
    lines.push(`  awaiting review response: ${member.awaitingReviewResponse ? "yes" : "no"}`);
  } else {
    lines.push(`  workflow: ${member.workflowFile}`);
  }

  lines.push(`  interrupted runs: ${member.interruptedRunCount}`);
  lines.push(formatLeaseLine(member.lease));
  lines.push(
    `  last updated: ${member.updatedAt === undefined ? "unknown" : new Date(member.updatedAt).toISOString()}`,
  );
  lines.push(
    `  latest runs: ${
      member.latestRuns.length === 0
        ? "none"
        : member.latestRuns.map((run) => `${run.phase}=${run.status}`).join(", ")
    }`,
  );
  return lines;
}

/**
 * Deterministic plain text (no ANSI) for a pi tool result. Members are already
 * sorted by task id; warnings keep that order with duplicate-task warnings last.
 */
/** The header block: intent facts, then membership counts and capacity. */
function formatFleetHeader(status: FleetStatus): string[] {
  const intentFacts = [
    status.intent === undefined ? undefined : formatDeferred(status.intent.deferred ?? []),
    status.intent === undefined ? undefined : formatReleased(status.intent.released ?? []),
    status.intent === undefined ? undefined : formatPark(status.intent),
    formatFleetRunLine(status.intent?.run),
    formatOrderingGates(status.intent),
  ].filter((line): line is string => line !== undefined);
  return [
    // Name only the id that actually located the files; a sanitized id keeps
    // traversal input from printing as if it were a real directory.
    `Fleet ${formatFleetId(status)}`,
    `  intent: ${formatIntent(status.intent)}`,
    ...intentFacts.map((line) => `  ${line}`),
    ...formatFleetRunStops(status.intent?.run).map((line) => `  ${line}`),
    `  members: ${status.members.length}`,
    `  states: ${formatCounts(status.counts)}`,
    ...formatCapacity(status.capacity),
  ];
}

export function formatFleetStatus(status: FleetStatus): string {
  const lines = formatFleetHeader(status);

  // After the header lines so "who is waiting on me" is the first thing read,
  // and before the member blocks so it is never buried in a long fleet.
  const needsYou = formatNeedsYou(status);
  if (needsYou !== undefined) {
    lines.push("");
    lines.push(needsYou);
  }

  if (status.members.length === 0) {
    lines.push("");
    lines.push("No fleet members: no worktree holds Belayd workflow state.");
  }

  for (const member of status.members) {
    lines.push("");
    lines.push(...formatMember(member));
  }

  if (status.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${status.warnings.length}):`);
    for (const warning of status.warnings) lines.push(`  - ${warning.message}`);
  }

  return lines.join("\n");
}

// ── Reader (the only fs/git access in this module) ────────────────────

/** Fs seam for the reader; compatible with the workflow-state and run-manifest seams. */
export interface FleetStatusFs extends RunManifestFs {
  /**
   * Worktree `stat`, for the launch-evidence cutoff (bd-166).
   *
   * Optional so read-only seams can omit it: without it a same-task run manifest
   * names the task but cannot be attributed to this execution, which the capacity
   * rule resolves by counting the member (`memberRanEvidence`).
   */
  statSync?(path: string): { birthtimeMs?: number; mtimeMs?: number };
}

/** The reader's default seam: the shared manifests' fs plus the capacity cutoff's stat. */
const fleetStatusFs: FleetStatusFs = {
  ...runManifestFs,
  statSync: (path) => statSync(path),
};

export interface ReadFleetStatusOptions {
  cwd: string;
  fleetId: string;
  fs?: FleetStatusFs;
  /** Test seam for the git-common-dir probe. */
  resolveCommonDir?: (cwd: string) => GitCommonDirResult;
  /** Test seam for worktree enumeration. */
  listWorktrees?: (cwd: string) => ReturnType<typeof defaultListWorktrees>;
  /**
   * Process-table snapshot for the capacity count (bd-166).
   *
   * Injected so a status read in a test never depends on the host's processes;
   * the default is the real scan the reconcile and launch paths use.
   */
  scanProcesses?: () => FleetProcessScan;
  /**
   * Worktree lease per member, the only evidence a pi-web orchestrator produces.
   *
   * Absent means "classify the worktree's own lease"; `undefined` from the probe
   * means "no evidence", which the classifier treats as `unknown` (counted).
   */
  memberLeaseFor?: (
    taskId: string,
    worktreePath: string | undefined,
  ) => FleetMemberLeaseProbe | undefined;
  /** Supervisor liveness probes, for `capacity-held`; injected in tests. */
  supervisorLiveness?: FleetSupervisorLiveness;
  /** Clock for lease freshness, the capacity view, and `run-not-ticking`. */
  now?: number;
}

export type ReadFleetStatusResult = { ok: true; value: FleetStatus } | { ok: false; error: string };

function readFleetIntentFile(
  fs: FleetStatusFs,
  gitCommonDir: string,
  fleetId: string,
): FleetIntent | undefined {
  const filePath = fleetIntentFilePath(gitCommonDir, fleetId);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return parseFleetIntent(JSON.parse(fs.readFileSync(filePath)));
  } catch {
    // A corrupt intent file is treated as absent: P0 only reports intent, and
    // blocking the whole fleet view on it would hide every member.
    return undefined;
  }
}

function readMemberSnapshot(fs: FleetStatusFs, entry: WorktreeListEntry): FleetMemberSnapshot {
  const workflowPath = workflowStateFilePath(entry.path);
  let workflow: FleetWorkflowSnapshot;

  if (!fs.existsSync(workflowPath)) {
    workflow = { kind: "missing" };
  } else {
    try {
      const parsed = parseWorkflowState(JSON.parse(fs.readFileSync(workflowPath)));
      workflow = parsed === undefined ? { kind: "corrupt" } : { kind: "ok", state: parsed };
    } catch {
      workflow = { kind: "corrupt" };
    }
  }

  const createdAt = worktreeCreatedAt(fs, entry.path);
  return {
    worktreePath: entry.path,
    isMainWorktree: entry.isMainWorktree,
    branch: entry.branch,
    workflow,
    runs: listRuns({ cwd: entry.path, fs }),
    ...(createdAt === undefined ? {} : { createdAt }),
    lease: readLeaseSnapshot(fs, entry.path),
  };
}

/**
 * The worktree's creation instant, or undefined when the seam cannot `stat` it.
 *
 * A failed stat means "no cutoff", never "created now": the evidence rule answers
 * that by counting the member, which is the safe direction (bd-166).
 */
function worktreeCreatedAt(fs: FleetStatusFs, worktreePath: string): number | undefined {
  if (fs.statSync === undefined) return undefined;
  try {
    return worktreeCreatedAtFromStat(fs.statSync(worktreePath));
  } catch {
    return undefined;
  }
}

/** Read the worktree's orchestrator lease without applying a clock. */
function readLeaseSnapshot(fs: FleetStatusFs, worktreePath: string): FleetLeaseSnapshot {
  const path = orchestratorClaimPath(worktreePath);
  if (!fs.existsSync(path)) return { state: "absent" };
  try {
    const parsed = parseOrchestratorClaim(JSON.parse(fs.readFileSync(path)));
    return parsed === undefined
      ? { state: "corrupt", error: `${path} is not an orchestrator lease` }
      : { state: "held", claim: parsed };
  } catch (error) {
    return {
      state: "corrupt",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Map every fleet member to a worktree path, from the one worktree enumeration.
 *
 * The branch is the identity (a worktree's directory name is a convention); an
 * unrecognizable branch simply leaves that member without a path, which the
 * capacity view reports as `worktreePresent: false`.
 */
/** One member worktree as the capacity arithmetic needs it. */
interface FleetWorktreeEvidence {
  path: string;
  /** Whether `.belayd/workflow.json` exists, readable or corrupt. */
  workflowStatePresent: boolean;
  /** Run manifests read from the worktree; attributed per task id below. */
  runs: readonly RunManifest[];
  /** The worktree directory's creation instant, when the seam could `stat` it. */
  createdAt?: number;
}

function worktreeEvidenceByTaskId(
  entries: readonly WorktreeListEntry[],
  snapshots: readonly FleetMemberSnapshot[],
): Map<string, FleetWorktreeEvidence> {
  const worktrees = new Map<string, FleetWorktreeEvidence>();
  for (const [index, entry] of entries.entries()) {
    const branch = entry.branch;
    if (branch === undefined) continue;
    const snapshot = snapshots[index];
    // `snapshots` is the same enumeration in the same order. Corrupt state still
    // proves the worktree is not a bare mid-spawn tree, and a cleared state (a
    // finished workflow) leaves the run manifests behind — the evidence rule reads
    // both, with the worktree's own creation instant as the cutoff bd-166 needs.
    const workflowStatePresent = snapshot?.workflow.kind !== "missing";
    const runs = snapshot?.runs ?? [];
    const createdAt = snapshot?.createdAt;
    // The fleet names a member's branch `feat/<taskId>`, so that suffix is the
    // authority here. `taskIdFromBranch` is the stricter parser (numeric ids only)
    // and is kept as a second key for branches that carry the id another way.
    const candidates = [
      branch.startsWith("feat/") ? branch.slice("feat/".length) : undefined,
      taskIdFromBranch(branch),
    ];
    for (const taskId of candidates) {
      if (taskId === undefined || taskId === "" || worktrees.has(taskId)) continue;
      worktrees.set(taskId, {
        path: entry.path,
        workflowStatePresent,
        runs,
        ...(createdAt === undefined ? {} : { createdAt }),
      });
    }
  }
  return worktrees;
}

/**
 * Whether this member's worktree proves its own execution ran.
 *
 * The cutoff is the newer of the worktree's creation instant and the fleet run's
 * recorded `launchedAt` (`memberEvidenceCutoff`), so an inherited same-task manifest
 * copied into a fresh worktree never counts as this member's evidence. No cutoff
 * means no manifest evidence, which keeps the member counted.
 */
function memberRanInWorktree(options: {
  intent: FleetIntent;
  taskId: string;
  worktree: FleetWorktreeEvidence | undefined;
}): boolean {
  const worktree = options.worktree;
  if (worktree === undefined) return false;
  const launchedAt = launchedAtFor(options.intent, options.taskId);
  const since = memberEvidenceCutoff({
    ...(worktree.createdAt === undefined ? {} : { worktreeCreatedAt: worktree.createdAt }),
    ...(launchedAt === undefined ? {} : { launchedAt }),
  });
  return memberRanEvidence({
    taskId: options.taskId,
    workflowStatePresent: worktree.workflowStatePresent,
    runs: worktree.runs,
    ...(since === undefined ? {} : { since }),
  });
}

/**
 * The default lease probe: the same classifier the launch and reconcile probe use,
 * so status and the ceiling arithmetic cannot disagree about a lease (bd-166).
 */
function leaseProbeOf(worktreePath: string | undefined, now: number): FleetMemberLeaseProbe {
  if (worktreePath === undefined) return { state: "absent" };
  return classifyMemberLease({ read: readOrchestratorClaim({ worktreePath }), now });
}

/**
 * Fleet directory names under `<git-common-dir>/belayd/fleet`, code-unit sorted.
 *
 * A local listing, not `fleet-mode.listFleetIds`: that seam speaks the write-side
 * `FleetStateFs`, and widening this reader's read-only fs just to enumerate a
 * directory would drag the state writer's surface into the status path.
 */
function fleetDirectoryIds(fs: FleetStatusFs, gitCommonDir: string): readonly string[] {
  const root = join(gitCommonDir, "belayd", "fleet");
  try {
    if (!fs.existsSync(root)) return [];
    return [...fs.readdirSync(root)].sort(compareCodeUnits);
  } catch {
    // An unreadable fleet root means "no fleet" for this reader: the status view
    // must never throw, and the single-fleet view below still reports its intent.
    return [];
  }
}

/**
 * Every fleet's membership + liveness, for the capacity block (bd-166).
 *
 * One intent read per fleet directory plus one process snapshot for the whole view,
 * and the member's own worktree lease per member: the same evidence reconcile
 * trusts, so status and repair cannot disagree about what is running.
 */
function readFleetCapacity(options: {
  fs: FleetStatusFs;
  gitCommonDir: string;
  targetFleetId: string;
  targetIntent: FleetIntent | undefined;
  worktrees: ReadonlyMap<string, FleetWorktreeEvidence>;
  scan: FleetProcessScan;
  now: number;
  leaseFor: (taskId: string, worktreePath: string | undefined) => FleetMemberLeaseProbe | undefined;
  supervisorLiveness: FleetSupervisorLiveness;
}): FleetCapacityInput {
  const fleets: FleetCapacityFleetInput[] = [];
  let sawTarget = false;
  for (const directoryId of fleetDirectoryIds(options.fs, options.gitCommonDir)) {
    const fleetId = sanitizeFleetId(directoryId);
    const intent =
      fleetId === options.targetFleetId
        ? options.targetIntent
        : readFleetIntentFile(options.fs, options.gitCommonDir, fleetId);
    if (fleetId === options.targetFleetId) sawTarget = true;
    if (intent === undefined) continue;
    fleets.push(
      capacityFleetInput({
        fleetId,
        intent,
        worktrees: options.worktrees,
        scan: options.scan,
        leaseFor: options.leaseFor,
        supervisorLiveness: options.supervisorLiveness,
      }),
    );
  }
  // The root listing can be unreadable (or absent in an in-memory fs) while the
  // requested intent itself read fine; the arithmetic must still describe the
  // fleet the operator asked about.
  if (!sawTarget && options.targetIntent !== undefined) {
    fleets.push(
      capacityFleetInput({
        fleetId: options.targetFleetId,
        intent: options.targetIntent,
        worktrees: options.worktrees,
        scan: options.scan,
        leaseFor: options.leaseFor,
        supervisorLiveness: options.supervisorLiveness,
      }),
    );
  }
  return { ceiling: FLEET_MAX_CONCURRENT_ORCHESTRATORS, fleets };
}

/** One fleet's recorded membership, classified for the capacity arithmetic. */
function capacityFleetInput(options: {
  fleetId: string;
  intent: FleetIntent;
  worktrees: ReadonlyMap<string, FleetWorktreeEvidence>;
  scan: FleetProcessScan;
  leaseFor: (taskId: string, worktreePath: string | undefined) => FleetMemberLeaseProbe | undefined;
  supervisorLiveness: FleetSupervisorLiveness;
}): FleetCapacityFleetInput {
  const released = new Set((options.intent.released ?? []).map((entry) => entry.taskId));
  const stopped = new Set((options.intent.run?.stopped ?? []).map((entry) => entry.taskId));
  const members = options.intent.taskIds.map((taskId): FleetCapacityMemberInput => {
    const worktree = options.worktrees.get(taskId);
    const lease = options.leaseFor(taskId, worktree?.path);
    return {
      taskId,
      // Same rule as the launch probe: no worktree, or a worktree with no lease and
      // no evidence this member's own execution ran, is a spawn in flight — unknown
      // and counted, never absent (bd-166).
      liveness: classifyMemberLivenessInWorktree({
        taskId,
        worktreePath: worktree?.path,
        memberRanEvidence: memberRanInWorktree({ intent: options.intent, taskId, worktree }),
        scan: options.scan,
        ...(lease === undefined ? {} : { lease }),
      }),
      ...(released.has(taskId) ? { released: true } : {}),
      ...(stopped.has(taskId) ? { stopped: true } : {}),
      worktreePresent: worktree !== undefined,
    };
  });
  const supervisor = classifyFleetSupervisor({
    supervisor: options.intent.supervisor,
    liveness: options.supervisorLiveness,
  });
  return {
    fleetId: options.fleetId,
    members,
    supervisor: supervisor.kind,
    ...(options.intent.run === undefined
      ? {}
      : {
          run: {
            ticks: options.intent.run.ticks,
            updatedAt: options.intent.run.updatedAt,
            active: isFleetRunActive(options.intent.run),
          },
        }),
  };
}

/**
 * Read + derive the fleet view. Two read-only git probes (`rev-parse
 * --git-common-dir`, `worktree list --porcelain`) plus fs reads and one
 * process-table snapshot; no git mutation, no writes, no spawns.
 */
export function readFleetStatus(options: ReadFleetStatusOptions): ReadFleetStatusResult {
  const fs = options.fs ?? fleetStatusFs;
  const resolveCommonDir = options.resolveCommonDir ?? resolveGitCommonDir;
  const listWorktrees = options.listWorktrees ?? defaultListWorktrees;
  const scan = options.scanProcesses ?? scanProcesses;
  const now = options.now ?? Date.now();

  // One id: the sanitized value both locates the files and names the fleet in
  // the view, so the header can never point at a different directory.
  const requestedFleetId = options.fleetId;
  const fleetId = sanitizeFleetId(requestedFleetId);

  const commonDirResult = resolveCommonDir(options.cwd);
  if (!commonDirResult.ok) return { ok: false, error: commonDirResult.error };

  const worktreeResult = listWorktrees(options.cwd);
  if (!worktreeResult.ok) return { ok: false, error: worktreeResult.error };

  const intent = readFleetIntentFile(fs, commonDirResult.commonDir, fleetId);
  const members = worktreeResult.entries.map((entry) => readMemberSnapshot(fs, entry));
  const worktreeWarnings: FleetWarning[] = worktreeResult.warnings.map((message) => ({
    kind: "unparsed-worktree-path",
    message,
  }));
  const leaseFor =
    options.memberLeaseFor ??
    ((_taskId: string, worktreePath: string | undefined) => leaseProbeOf(worktreePath, now));

  return {
    ok: true,
    value: buildFleetStatus({
      fleetId,
      requestedFleetId,
      intent,
      members,
      worktreeWarnings,
      capacity: readFleetCapacity({
        fs,
        gitCommonDir: commonDirResult.commonDir,
        targetFleetId: fleetId,
        targetIntent: intent,
        worktrees: worktreeEvidenceByTaskId(worktreeResult.entries, members),
        scan: scan(),
        now,
        leaseFor,
        supervisorLiveness: options.supervisorLiveness ?? {
          isPidAlive: isProcessAlive,
          pidStartTime: readProcessStartTime,
        },
      }),
      now,
    }),
  };
}
