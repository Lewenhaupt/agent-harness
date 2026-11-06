/**
 * Fleet-level crash reconcile and pause repair (bd-126 P4).
 *
 * A fleet supervisor is an ordinary pi session: it can be killed, its host can
 * reboot, and its members keep running. Nothing in this repository watches for
 * that — the fleet family has no daemon and no background poller by design — so
 * recovery is an **explicit, audited step** the operator (or a fresh supervisor)
 * asks for: `belayd_fleet_reconcile`.
 *
 * Three independent areas, each with its own honest limit:
 *
 * 1. **Merge queue.** The queue is written by several steps (acquire, renew,
 *    entry transitions, release), so a crash can leave a record whose primitive is
 *    gone, a primitive whose record never landed, an expired lease, or an entry
 *    frozen in an in-flight state. Each anomaly has one defined repair, and the
 *    repair reuses the existing `mkdir`-based single-flight primitive rather than
 *    inventing a second lock: reconcile *acquires* the merge lock, repairs what it
 *    found, and releases it. When a live holder exists, reconcile repairs nothing
 *    and says so.
 * 2. **Parked fleet.** A conflicting root restore parks the fleet with the applied
 *    stash ref in the fleet intent. Reconcile retries that restore from the recorded
 *    sha (never a position), or reports exactly what blocks it. The work is never
 *    discarded: a failed retry leaves the stash untouched and the fleet parked.
 * 3. **Supervision.** Member liveness is established from the process table
 *    (`src/fleet-sessions.ts`), never from intent: a dead supervisor's detached
 *    members keep running, and a member whose orchestrator is provably gone still
 *    holds a slot in the conservative capacity count. Reconcile reports both, and
 *    can prune provably-dead members (opt-in, audited) so the count narrows through
 *    a real observation instead of a guess.
 *
 * **Idempotence is a requirement, not a nicety:** a second run after a successful
 * repair must find nothing to do — no second stash apply, no double prune, no
 * re-takeover of a lock it already released. Every repair here rewrites state to a
 * value the diagnosis no longer flags (see the table in docs/fleet-reconcile.md).
 */

import * as nodeFs from "node:fs";
import type { SupervisorHeartbeat } from "./fleet-heartbeat.js";
import { isFleetLoopProvablyDead } from "./fleet-heartbeat.js";
import type { FleetMergeGitRunner } from "./fleet-merge.js";
import { acquireFleetMerge, releaseFleetMerge, restoreRecordedStash } from "./fleet-merge.js";
import type { FleetSupervisorLiveness, FleetSupervisorState } from "./fleet-mode.js";
import { classifyFleetSupervisor } from "./fleet-mode.js";
import type {
  FleetOrderingGate,
  FleetOrderingGateReapScope,
  ReapFleetOrderingGatesResult,
  ResolveFleetOrderingGatesResult,
} from "./fleet-ordering-gates.js";
import { isFleetRunActive, retryRunMembers } from "./fleet-run.js";
import type {
  FleetMemberLeaseProbe,
  FleetMemberLiveness,
  FleetProcessScan,
} from "./fleet-sessions.js";
import { classifyMemberLivenessInWorktree } from "./fleet-sessions.js";
import type { FleetMergeQueue, FleetMergeQueueEntry, FleetStateFs } from "./fleet-state.js";
import {
  appendFleetAuditEntry,
  createFleetMergeQueue,
  dropFleetOrderingGates,
  FLEET_MERGE_LEASE_MS,
  readFleetIntent,
  readFleetMergeQueue,
  updateFleetIntent,
  updateFleetMergeQueue,
  withoutPauseFields,
} from "./fleet-state.js";
import type { FleetIntent } from "./fleet-status.js";

const nodeFsSeam: FleetStateFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
  writeFileSync: (path, data, options) => nodeFs.writeFileSync(path, data, options),
  renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
  mkdirSync: (path, options) => {
    nodeFs.mkdirSync(path, options);
  },
  unlinkSync: (path) => nodeFs.unlinkSync(path),
  readdirSync: (path) => nodeFs.readdirSync(path),
};

// ── Merge-queue diagnosis (pure) ──────────────────────────────────────

/**
 * Entry states that mean "a merge step was running when the process stopped".
 *
 * `queued`, `merged`, `failed`, and `parked` are resting states: none of them
 * implies an in-flight operation, so none is an anomaly.
 */
export const FLEET_RECONCILE_ACTIVE_ENTRY_STATES = ["rebasing", "gating", "merging"] as const;

/** What the queue looked like when it was inspected. */
export type FleetQueueAnomaly = "expired-lease" | "entry-stuck" | "entry-merged-unrecorded";

/** What reconcile does about it. `leave-alone` is a decision, not an omission. */
export type FleetQueueRepairAction =
  | "take-over-lock"
  | "reset-queued"
  | "mark-merged"
  | "leave-alone";

export interface FleetQueueRepair {
  anomaly: FleetQueueAnomaly;
  action: FleetQueueRepairAction;
  /** Why this action, in operator terms. */
  reason: string;
  taskId?: string;
}

export interface DiagnoseMergeQueueInput {
  queue: FleetMergeQueue | undefined;
  /** Entries whose branch git proved is already an ancestor of the base. */
  mergedIntoBase: readonly string[];
  now: number;
}

/** Whether a held lock is still inside its lease. */
function lockIsLive(options: { queue: FleetMergeQueue | undefined; now: number }): boolean {
  const lock = options.queue?.lock ?? null;
  if (lock === null) return false;
  return options.now < lock.leaseExpiresAt;
}

/**
 * Repairs for the lock row.
 *
 * The retired protocol also had to diagnose two states that cannot exist in a row:
 * a lease record without its `merge.lock.d` primitive, and a primitive without a
 * record. Both existed because acquisition was two writes; the row's lease is the
 * acquisition, and its deadline is the only takeover authority. An expired lease is
 * therefore the single case left, and taking it over is the same rule
 * `acquireFleetMerge` applies.
 */
function diagnoseLockState(input: DiagnoseMergeQueueInput): FleetQueueRepair[] {
  const lock = input.queue?.lock ?? null;
  if (lock === null || input.now < lock.leaseExpiresAt) return [];
  return [
    {
      anomaly: "expired-lease",
      action: "take-over-lock",
      reason:
        `the lease held by ${lock.holder} for ${lock.taskId} expired at ` +
        `${new Date(lock.leaseExpiresAt).toISOString()} and was not renewed`,
    },
  ];
}

/** Repairs for entries frozen in an in-flight state with no live lock. */
function diagnoseStuckEntries(input: DiagnoseMergeQueueInput): FleetQueueRepair[] {
  const repairs: FleetQueueRepair[] = [];
  for (const entry of input.queue?.entries ?? []) {
    if (!FLEET_RECONCILE_ACTIVE_ENTRY_STATES.some((state) => state === entry.state)) continue;
    if (input.mergedIntoBase.includes(entry.taskId)) {
      repairs.push({
        anomaly: "entry-merged-unrecorded",
        action: "mark-merged",
        taskId: entry.taskId,
        reason:
          `git reports ${entry.branch} is already an ancestor of the base branch, so the merge ` +
          "landed and only its state update was lost",
      });
      continue;
    }
    repairs.push({
      anomaly: "entry-stuck",
      action: "reset-queued",
      taskId: entry.taskId,
      reason:
        `the entry is ${entry.state} but no live lock exists, so no merge is in flight; it is ` +
        "re-queued with its attempt count so a later drain can retry it",
    });
  }
  return repairs;
}

/**
 * Every anomaly plus the repair for it, in a fixed order.
 *
 * The rules are deliberately small enough to state as a table
 * (docs/fleet-reconcile.md):
 *
 * - an expired lease → take the lock over (the lease is the only takeover
 *   authority, so this is the same rule `acquireFleetMerge` applies);
 * - an entry frozen in an in-flight state while no lock is live → `mark-merged`
 *   when git proves the branch already landed, otherwise `reset-queued` with the
 *   attempt count preserved (a retry is a new attempt, not a new entry).
 */
export function diagnoseMergeQueue(input: DiagnoseMergeQueueInput): readonly FleetQueueRepair[] {
  const repairs = diagnoseLockState(input);
  // An in-flight entry is only an anomaly when no lock is live: while a holder is
  // inside its lease, an in-flight state is exactly what is expected.
  if (lockIsLive({ queue: input.queue, now: input.now })) return repairs;
  return [...repairs, ...diagnoseStuckEntries(input)];
}

// ── Effects ───────────────────────────────────────────────────────────

/** Everything one reconcile pass accumulates for its report. */
interface ReconcileRun {
  repairs: string[];
  warnings: string[];
  lines: string[];
}

function auditReconcile(options: {
  gitCommonDir: string;
  fleetId: string;
  sessionId: string;
  now: number;
  action: string;
  taskIds: readonly string[];
  detail: string;
  fs: FleetStateFs;
}): string | undefined {
  const appended = appendFleetAuditEntry({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs: options.fs,
    entry: {
      timestamp: options.now,
      fleetId: options.fleetId,
      actor: options.sessionId,
      action: options.action,
      taskIds: [...options.taskIds],
      detail: options.detail,
    },
  });
  return appended.ok
    ? undefined
    : `fleet ${options.fleetId}: could not append the audit entry (${appended.error})`;
}

/** git-prove which queued branches already landed on the base. */
async function mergedIntoBase(options: {
  git: FleetMergeGitRunner;
  rootCwd: string;
  baseBranch: string;
  entries: readonly FleetMergeQueueEntry[];
}): Promise<readonly string[]> {
  const merged: string[] = [];
  for (const entry of options.entries) {
    const probe = await options.git(
      ["merge-base", "--is-ancestor", entry.branch, options.baseBranch],
      { cwd: options.rootCwd },
    );
    // A failed probe is "not proven merged", never "merged": resetting to queued is
    // always safe, claiming a merge that did not land is not.
    if (probe.ok) merged.push(entry.taskId);
  }
  return merged;
}

/** Read the intent for the reconcile pass, or an error value. */
type IntentLoad = { ok: true; intent: FleetIntent } | { ok: false; error: string };

function loadIntent(options: {
  gitCommonDir: string;
  fleetId: string;
  fs: FleetStateFs;
}): IntentLoad {
  const loaded = readFleetIntent({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs: options.fs,
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.intent === undefined) {
    return { ok: false, error: `no fleet intent for \`${options.fleetId}\`` };
  }
  return { ok: true, intent: loaded.intent };
}

export interface RunFleetReconcileOptions {
  gitCommonDir: string;
  fleetId: string;
  /** Session performing the repair (audit actor, also the merge-lock holder). */
  sessionId: string;
  pid: number;
  /** The operator's root checkout: the only place the base branch can be held. */
  rootCwd: string;
  now: number;
  /** Process-table snapshot taken by the caller; failures are `unknown`, not `absent`. */
  scan: FleetProcessScan;
  git: FleetMergeGitRunner;
  /** Supervisor liveness probes (injected so tests need no real pids). */
  isPidAlive: (pid: number) => boolean;
  pidStartTime?: (pid: number) => string | undefined;
  /** This process, excluded from member matching. */
  selfPid?: number;
  /**
   * Worktree lease per member.
   *
   * Injected because the lease lives in the member worktree; without it a
   * pi-web-hosted member (no argv token) always looks absent and gets pruned while
   * it is running — the bd-37 double-orchestrator failure.
   */
  leaseFor?: (taskId: string) => FleetMemberLeaseProbe | undefined;
  /** The member's worktree, when one still resolves (same probe as status/launch). */
  memberWorktreeFor?: (taskId: string) => string | undefined;
  /** Whether anything in the worktree proves the member's session existed. */
  memberRanFor?: (taskId: string) => boolean;
  /** Whether the member's worktree provably existed (bd-233: deleted tree). */
  memberWorktreeExistedFor?: (taskId: string) => boolean;
  leaseInMs?: number;
  /**
   * Remove members whose orchestrator session is provably gone (positive `absent`
   * evidence; `unknown` liveness never qualifies, and the supervisor's own
   * liveness is not a precondition). Opt-in: a prune changes what the capacity
   * count sees, so it is never implicit.
   */
  pruneDeadMembers?: boolean;
  /**
   * Members whose recorded stop a human asked to clear (bd-233).
   *
   * The documented way back from "stopped for a human": the run's next tick plans
   * the member again instead of treating it as finished. Unknown ids are reported as
   * warnings, never silently ignored.
   */
  retryMembers?: readonly string[];
  /**
   * The recovery evidence that licensed this pass (bd-233).
   *
   * Present only when a non-supervisor is repairing a fleet whose supervisor is
   * provably dead. The fingerprint guards the prune's compare-and-replace: if a
   * re-arm landed between the verdict and the write, nothing is pruned (W5).
   */
  recovery?: SupervisorRecovery;
  /**
   * bd ordering-gate lifecycle (bd-158), injected so this module stays bd-free.
   *
   * A prune removes members, and a removed member's open ordering gates are
   * orphans: nothing else in the fleet can ever resolve them, so the prune path
   * itself must. Kept optional because direct callers that never touch gates (the
   * pure unit tests) should not have to stub bd.
   */
  orderingGates?: FleetOrderingGateSeam;
  fs?: FleetStateFs;
}

/** The two bd operations a prune needs, as injected seams. */
export interface FleetOrderingGateSeam {
  resolve: (gates: readonly FleetOrderingGate[]) => Promise<ResolveFleetOrderingGatesResult>;
  reapByPrefix: (
    input: { fleetId: string; beadIds: readonly string[] } & FleetOrderingGateReapScope,
  ) => Promise<ReapFleetOrderingGatesResult>;
}

export interface RunFleetReconcileResult {
  ok: boolean;
  text: string;
  warnings: readonly string[];
  /** Repairs actually applied, in order (`queue:<action>`, `park:<action>`, …). */
  repairs: readonly string[];
}

/** Acquire the merge lock, or explain why the queue cannot be repaired now. */
function acquireForReconcile(options: RunFleetReconcileOptions):
  | {
      ok: true;
      /** Release the lock, returning any warning the caller must surface. */
      release: () => readonly string[];
    }
  | { ok: false; text: string } {
  const acquired = acquireFleetMerge({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    holder: options.sessionId,
    // Not a member: reconcile is a fleet-level operation, and the queue records
    // the task id only for operator messages.
    taskId: "reconcile",
    pid: options.pid,
    now: options.now,
    ...(options.leaseInMs === undefined ? {} : { leaseInMs: options.leaseInMs }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  if (!acquired.ok) return { ok: false, text: acquired.error };
  return {
    ok: true,
    release: () => {
      const released = releaseFleetMerge({
        gitCommonDir: options.gitCommonDir,
        fleetId: options.fleetId,
        holder: options.sessionId,
        now: options.now,
        ...(options.fs === undefined ? {} : { fs: options.fs }),
      });
      if (released.ok) return released.warnings;
      // A failed release is surfaced, never swallowed: the reconcile's own lease
      // stays recorded for its full TTL, and every later drain/advance/reconcile
      // would report "lock held until …" without naming who holds it or why.
      return [
        `fleet ${options.fleetId}: reconcile could not release its own merge lock ` +
          `(${released.error}); the lease stays recorded until ` +
          `${new Date(options.now + (options.leaseInMs ?? FLEET_MERGE_LEASE_MS)).toISOString()} ` +
          "and later merges will report it as held — re-run reconcile after the TTL",
      ];
    },
  };
}

/** Apply the entry-state repairs the diagnosis asked for, under the held lock. */
function applyEntryRepairs(options: {
  run: ReconcileRun;
  gitCommonDir: string;
  fleetId: string;
  sessionId: string;
  fs: FleetStateFs;
  now: number;
  repairs: readonly FleetQueueRepair[];
}): void {
  const actionable = options.repairs.filter(
    (repair) => repair.action === "reset-queued" || repair.action === "mark-merged",
  );
  if (actionable.length === 0) return;

  const byTask = new Map(actionable.map((repair) => [repair.taskId ?? "", repair]));
  const written = updateFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs: options.fs,
    update: (current) => {
      const base = current ?? createFleetMergeQueue(options.now);
      return {
        ...base,
        updatedAt: options.now,
        entries: base.entries.map((entry) => {
          const repair = byTask.get(entry.taskId);
          if (repair === undefined) return entry;
          if (repair.action === "mark-merged") {
            return { ...entry, state: "merged" as const, updatedAt: options.now };
          }
          return {
            ...entry,
            state: "queued" as const,
            updatedAt: options.now,
            lastError: "reconcile: reset from a stuck in-flight state",
          };
        }),
      };
    },
  });
  if (!written.ok) {
    options.run.warnings.push(`could not rewrite the merge queue entries (${written.error})`);
    return;
  }
  for (const repair of actionable) {
    const taskId = repair.taskId ?? "";
    options.run.repairs.push(`queue:${repair.action}:${taskId}`);
    options.run.lines.push(
      `- queue: ${taskId} → ${repair.action === "mark-merged" ? "merged" : "queued"} ` +
        `(${repair.anomaly}: ${repair.reason})`,
    );
    const auditWarning = auditReconcile({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
      sessionId: options.sessionId,
      now: options.now,
      action: repair.action === "mark-merged" ? "queue-mark-merged" : "queue-reset-queued",
      taskIds: [taskId],
      detail: repair.reason,
      fs: options.fs,
    });
    if (auditWarning !== undefined) options.run.warnings.push(auditWarning);
  }
}

// ── Parked-fleet repair ───────────────────────────────────────────────

export type ParkRepairResult =
  | { kind: "not-parked"; text: string }
  | { kind: "unparked"; text: string }
  | { kind: "blocked"; text: string };

/** Intent without the pause/park fields, keeping every other fact. */
function withoutPark(intent: FleetIntent, now: number): FleetIntent {
  return withoutPauseFields(intent, now);
}

/** Report-only result for a pause with nothing to restore. */
function handWrittenPause(): ParkRepairResult {
  return {
    kind: "blocked",
    text:
      "- park: the fleet is paused but no stash ref is recorded in the intent's `park` " +
      "(a hand-written pause), so there is no restore to retry; `belayd_fleet_resume` clears " +
      "the pause (use force if the stash is already back)",
  };
}

/** Outcome of clearing the park record from the intent. */
type ParkClearOutcome = { ok: true; unparked: boolean } | { ok: false; error: string };

/**
 * Clear `paused`/`park` through the intent CAS, audited, and record the repair.
 *
 * Shared by the two ways a park ends: a verified restore, and a recorded sha that
 * is already gone from `git stash list` (nothing left to apply). Auditing and the
 * `park:unparked:<sha>` repair name live here so both paths leave identical
 * state — the second reconcile run then finds nothing to do either way.
 */
function clearParkRecord(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  fs: FleetStateFs;
  stashRef: string;
  detail: string;
}): ParkClearOutcome {
  const { reconcile } = options;
  let unparked = false;
  const cleared = updateFleetIntent({
    gitCommonDir: reconcile.gitCommonDir,
    fleetId: reconcile.fleetId,
    fs: options.fs,
    update: (current) => {
      if (current === undefined) {
        return { refuse: `no fleet intent for \`${reconcile.fleetId}\` to unpark` };
      }
      if (current.park === undefined && current.paused !== true) return current;
      unparked = true;
      return withoutPark(current, reconcile.now);
    },
  });
  if (!cleared.ok) return { ok: false, error: cleared.error };
  if (!unparked) return { ok: true, unparked: false };

  options.run.repairs.push(`park:unparked:${options.stashRef}`);
  const auditWarning = auditReconcile({
    gitCommonDir: reconcile.gitCommonDir,
    fleetId: reconcile.fleetId,
    sessionId: reconcile.sessionId,
    now: reconcile.now,
    action: "fleet-unparked",
    taskIds: [],
    detail: options.detail,
    fs: options.fs,
  });
  if (auditWarning !== undefined) options.run.warnings.push(auditWarning);
  return { ok: true, unparked: true };
}

/**
 * Retry a parked root restore from the recorded sha, or report the blocker.
 *
 * Runs while the merge lock is held: the root checkout is shared with a merging
 * supervisor, and applying a stash into a checkout another process is moving would
 * be exactly the kind of cross-tree surprise this family exists to avoid.
 *
 * **Idempotent even when the first run's intent write lost (W3).** A recorded sha
 * that is no longer in `git stash list` is never applied again: the sha still
 * resolves as a dangling commit, and re-applying it (or failing to, and resetting
 * the checkout) would undo the work the first run restored. That case clears the
 * park so the fleet is not wedged by a pointer to work that is already back.
 */
async function repairPark(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  intent: FleetIntent;
  fs: FleetStateFs;
}): Promise<ParkRepairResult> {
  const { reconcile, intent } = options;
  const park = intent.park;
  if (intent.paused !== true && park === undefined) {
    return { kind: "not-parked", text: "- park: the fleet is not paused or parked" };
  }
  if (park?.stashRef === undefined) return handWrittenPause();

  const restored = await restoreRecordedStash({
    rootCwd: reconcile.rootCwd,
    baseBranch: intent.baseBranch,
    fleetId: reconcile.fleetId,
    gitCommonDir: reconcile.gitCommonDir,
    stashRef: park.stashRef,
    git: reconcile.git,
    requireListed: true,
  });
  for (const warning of restored.warnings) options.run.warnings.push(warning);
  if (!restored.ok) {
    if (restored.reason !== "already-restored") {
      return { kind: "blocked", text: `- park: still blocked — ${restored.text}` };
    }
    const settled = clearParkRecord({
      run: options.run,
      reconcile,
      fs: options.fs,
      stashRef: park.stashRef,
      detail:
        `reconcile found ${park.stashRef} already restored or dropped and cleared the park ` +
        "without touching the root",
    });
    if (!settled.ok) {
      return {
        kind: "blocked",
        text:
          `- park: ${restored.text}; the fleet intent could not be unparked (${settled.error}); ` +
          "run belayd_fleet_resume to clear the pause",
      };
    }
    return {
      kind: "unparked",
      text:
        `- park: ${restored.text}. The park record is cleared` +
        (settled.unparked ? " (the fleet is unparked)" : " (the fleet was already unparked)") +
        `; ${reconcile.rootCwd} was not modified by this run`,
    };
  }

  const cleared = clearParkRecord({
    run: options.run,
    reconcile,
    fs: options.fs,
    stashRef: park.stashRef,
    detail: `reconcile restored the root work from ${park.stashRef} and cleared the park`,
  });
  if (!cleared.ok) {
    return {
      kind: "blocked",
      text:
        `- park: the root work was restored from ${park.stashRef}, but the fleet intent could not ` +
        `be unparked (${cleared.error}); run belayd_fleet_resume to clear the pause`,
    };
  }
  if (!cleared.unparked) {
    return {
      kind: "unparked",
      text: `- park: restored ${park.stashRef}; the fleet was already unparked`,
    };
  }
  return {
    kind: "unparked",
    text: `- park: restored the root work from ${park.stashRef} and unparked the fleet`,
  };
}

// ── Supervision ───────────────────────────────────────────────────────

export interface MemberLivenessReport {
  taskId: string;
  liveness: FleetMemberLiveness;
}

/**
 * Classify every member's orchestrator session from one process snapshot.
 *
 * Pure: the snapshot is taken once by the caller, so the report is internally
 * consistent (two members cannot see two different process tables). The worktree
 * evidence is injected for the same reason the status view injects it — reconcile
 * must reach the same verdict as status, especially for a member whose worktree was
 * deleted (bd-233): a surviving branch proves the tree existed, so no lease and no
 * process is `absent` (prunable) instead of `unknown` (counted forever).
 */
export function reportMemberLiveness(options: {
  members: readonly string[];
  scan: FleetProcessScan;
  selfPid?: number;
  /** The member's worktree, when one still resolves. */
  worktreeFor?: (taskId: string) => string | undefined;
  /** Worktree lease per member, when the caller can read one. */
  leaseFor?: (taskId: string) => FleetMemberLeaseProbe | undefined;
  /** Whether anything in the worktree proves the member's session existed. */
  memberRanFor?: (taskId: string) => boolean;
  /** Whether the member's worktree provably existed (deleted tree, surviving branch). */
  worktreeExistedFor?: (taskId: string) => boolean;
}): readonly MemberLivenessReport[] {
  return options.members.map((taskId) => ({
    taskId,
    liveness: classifyMemberLivenessInWorktree({
      taskId,
      worktreePath: options.worktreeFor?.(taskId),
      memberRanEvidence: options.memberRanFor?.(taskId) === true,
      worktreeExisted: options.worktreeExistedFor?.(taskId) === true,
      scan: options.scan,
      ...(options.selfPid === undefined ? {} : { selfPid: options.selfPid }),
      ...(options.leaseFor === undefined ? {} : { lease: options.leaseFor(taskId) }),
    }),
  }));
}

function formatLiveness(liveness: FleetMemberLiveness): string {
  switch (liveness.kind) {
    case "live":
      if (liveness.leaseHeartbeatAt !== undefined) {
        return `orchestrator live (worktree lease renewed ${new Date(
          liveness.leaseHeartbeatAt,
        ).toISOString()})`;
      }
      return `orchestrator live (pid ${liveness.pids.join(", ")})`;
    case "absent":
      return "orchestrator not running";
    case "unknown":
      return `liveness unknown (${liveness.reason})`;
  }
}

function describeSupervisor(supervisor: FleetSupervisorState, fleetId: string): string {
  switch (supervisor.kind) {
    case "live":
      return `- supervisor: live (session ${supervisor.sessionId})`;
    case "dead":
      return (
        `- supervisor: not running (recorded session ${supervisor.sessionId}: its pid is gone or ` +
        `was reused); repair it with \`belayd_fleet_reconcile {"fleetId":"${fleetId}"}\` (a ` +
        `provably dead supervisor needs no re-arm), then re-arm with \`/fleet <ids> --fleet ${fleetId}\``
      );
    case "none":
      return "- supervisor: none recorded";
  }
}

/** Why a fleet's recorded supervisor is provably gone. */
export type SupervisorDeadReason = "pid-dead" | "cold-beat" | "missing-beat" | "other-session";

/** Why a fleet's supervisor is *not* provably gone. Closed union, never free text. */
export type SupervisorAliveReason = "fresh-beat" | "no-record" | "no-beat-signal";

/** The recovery verdict for one fleet: provably dead, or not provable. */
export type SupervisorDeadVerdict =
  | { dead: true; reason: SupervisorDeadReason; sessionId?: string }
  | { dead: false; reason: SupervisorAliveReason };

/**
 * The supervisor record plus intent revision a recovery verdict was based on (W5).
 *
 * A prune is a cross-tree write that can land after a re-arm rewrote the record, so
 * the decision that licensed it must be checkable against the record the prune's
 * compare-and-replace actually sees.
 */
export interface SupervisorRecordFingerprint {
  sessionId: string;
  pid: number;
  pidStartTime?: string;
  armToken?: string;
  /** `intent.updatedAt`: any writer that re-arms or edits the fleet moves this. */
  updatedAt: number;
}

/** The evidence that licensed a recovery repair, carried into the pass (bd-233). */
export interface SupervisorRecovery {
  fingerprint: SupervisorRecordFingerprint;
  reason: SupervisorDeadReason;
  lastBeatAt?: number;
}

/** The fingerprint of a fleet's supervisor record, or undefined when it has none. */
export function supervisorRecordFingerprint(
  intent: FleetIntent,
): SupervisorRecordFingerprint | undefined {
  const supervisor = intent.supervisor;
  if (supervisor === undefined) return undefined;
  return {
    sessionId: supervisor.sessionId,
    pid: supervisor.pid,
    ...(supervisor.pidStartTime === undefined ? {} : { pidStartTime: supervisor.pidStartTime }),
    ...(supervisor.armToken === undefined ? {} : { armToken: supervisor.armToken }),
    updatedAt: intent.updatedAt,
  };
}

/**
 * Whether a fresh intent still carries the exact supervisor record the verdict saw.
 *
 * The supervisor anchors are compared in full (session, pid, start time, arm token):
 * any re-arm mints a new token and usually a new session/pid, so a record that was
 * re-armed reads as changed. `updatedAt` is compared too, because it moves on *any*
 * write, but the recovery pass itself writes the intent (an unpark) — so the caller
 * can pass its own clock as `alsoAllowUpdatedAt` and a revision it just stamped
 * still counts as unchanged.
 */
export function supervisorRecordMatches(
  intent: FleetIntent,
  expected: SupervisorRecordFingerprint,
  options: { alsoAllowUpdatedAt?: number } = {},
): boolean {
  const supervisor = intent.supervisor;
  if (supervisor === undefined) return false;
  if (
    supervisor.sessionId !== expected.sessionId ||
    supervisor.pid !== expected.pid ||
    supervisor.pidStartTime !== expected.pidStartTime ||
    supervisor.armToken !== expected.armToken
  ) {
    return false;
  }
  return intent.updatedAt === expected.updatedAt || intent.updatedAt === options.alsoAllowUpdatedAt;
}

/**
 * Whether a fleet's supervisor is **provably** gone, so a non-supervisor may repair
 * it (bd-233).
 *
 * This is the escape hatch the incident lacked: every repair tool was supervisor-only
 * and liveness came from a 10-minute beat window, so a cancelled supervisor wedged
 * the fleet for ten minutes with no operator action available. The order is
 * strongest-evidence-first:
 *
 * 1. a **fresh beat refutes death**, whichever session it names: some loop is ticking
 *    this run right now, so a recorded pid that looks gone (or was reused) must not
 *    license a repair against a live run (W6);
 * 2. the recorded pid is dead (or was reused: `classifyFleetSupervisor`) — the
 *    fast path, and the only path for an explicit fleet whose pid is the supervisor
 *    process itself;
 * 3. for a run-mode fleet, the beat is missing, cold, or belongs to a session the
 *    record no longer names — the same rule launch applies when it decides whether a
 *    re-arm is safe. A run-mode record's pid is the shared pi-web daemon, so this
 *    beat path is what actually retires a dead run-mode supervisor.
 *
 * A fleet with no record is **not** dead (there is nothing to recover: no supervisor,
 * no capacity decision to undo), and neither is an explicit fleet with a live pid
 * (beats never apply there, so nothing proves death). Reconcile never takes the
 * supervisor role — this only grants repair authority.
 */
export function supervisorProvablyDead(options: {
  intent: FleetIntent;
  beat: SupervisorHeartbeat | undefined;
  now: number;
  liveness: FleetSupervisorLiveness;
  staleAfterInMs?: number;
}): SupervisorDeadVerdict {
  const supervisor = options.intent.supervisor;
  if (supervisor === undefined) return { dead: false, reason: "no-record" };
  const sessionId = supervisor.sessionId;
  const beat = options.beat;
  if (options.intent.run !== undefined && beat !== undefined) {
    const cold = isFleetLoopProvablyDead({
      beat,
      now: options.now,
      ...(options.staleAfterInMs === undefined ? {} : { staleAfterInMs: options.staleAfterInMs }),
    });
    if (!cold) return { dead: false, reason: "fresh-beat" };
  }
  if (classifyFleetSupervisor({ supervisor, liveness: options.liveness }).kind === "dead") {
    return { dead: true, reason: "pid-dead", sessionId };
  }
  // Only a run-mode fleet beats; an explicit fleet's live pid is the whole record, so
  // there is no second signal that could prove it gone.
  if (options.intent.run === undefined) return { dead: false, reason: "no-beat-signal" };
  if (beat === undefined) return { dead: true, reason: "missing-beat", sessionId };
  if (beat.sessionId !== sessionId) return { dead: true, reason: "other-session", sessionId };
  return { dead: true, reason: "cold-beat", sessionId };
}

/**
 * Refuse every retry of an inactive run, naming the real next step (bd-233 W3).
 */
function warnInactiveRunRetries(options: {
  run: ReconcileRun;
  fleetId: string;
  requested: readonly string[];
}): void {
  for (const taskId of options.requested) {
    options.run.warnings.push(
      `${taskId} was not retried: fleet \`${options.fleetId}\`'s run is finished or halted, so ` +
        "no tick will plan it again. Re-arm the fleet (/fleet <ids> --fleet " +
        `${options.fleetId}) and run the reconcile again, or prune the member and launch it ` +
        "fresh.",
    );
  }
}

/** Report a retry refused because a re-arm rewrote the record (bd-233 review round 2). */
function warnRetryRecordChanged(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  fs: FleetStateFs;
  requested: readonly string[];
}): void {
  const warning =
    `fleet \`${options.reconcile.fleetId}\` changed while reconciling (a new supervisor may ` +
    "have re-armed it); no recorded stop was cleared — re-run the reconcile";
  options.run.warnings.push(warning);
  const auditWarning = auditReconcile({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    sessionId: options.reconcile.sessionId,
    now: options.reconcile.now,
    action: "member-retry-refused",
    taskIds: [...options.requested],
    detail: warning,
    fs: options.fs,
  });
  if (auditWarning !== undefined) options.run.warnings.push(auditWarning);
}

/**
 * Clear the recorded stops of the members a reconcile call asked to retry (bd-233).
 *
 * Validation is loud on purpose: an id that is not a member, a member that was not
 * stopped, a fleet with no run record, and a **finished or halted run** are all
 * reported rather than answered with a silent no-op. The inactive-run case keeps the
 * stop intact: clearing it would promise a tick that will never come, so the warning
 * names the real next step instead and the next tick cannot surprise the operator.
 *
 * When the run is active the durable line states what the loop will actually do — the
 * next tick only *reconsiders* the member; a member whose worktree is gone is stopped
 * again, so that case needs a prune plus a fresh launch.
 */
async function retryStoppedMembers(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  fs: FleetStateFs;
  retryMembers: readonly string[];
}): Promise<void> {
  const loaded = loadIntent({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    fs: options.fs,
  });
  if (!loaded.ok) {
    options.run.warnings.push(`could not read the fleet intent to retry members (${loaded.error})`);
    return;
  }
  const members = new Set(loaded.intent.taskIds);
  const unknown = options.retryMembers.filter((taskId) => !members.has(taskId));
  if (unknown.length > 0) {
    options.run.warnings.push(
      `not a member of fleet \`${options.reconcile.fleetId}\`, so not retried: ${unknown.join(", ")}`,
    );
  }
  const requested = options.retryMembers.filter((taskId) => members.has(taskId));
  if (requested.length === 0) return;
  const run = loaded.intent.run;
  if (run === undefined) {
    options.run.lines.push(
      `- members: cannot retry ${requested.join(", ")} — fleet \`${options.reconcile.fleetId}\` ` +
        "has no run record, so a stop was never recorded. Launch the member again " +
        "(belayd_fleet_launch) or run the fleet with a run.",
    );
    return;
  }
  if (!isFleetRunActive(run)) {
    warnInactiveRunRetries({ run: options.run, fleetId: options.reconcile.fleetId, requested });
    return;
  }
  const stopped = new Set((run.stopped ?? []).map((entry) => entry.taskId));
  const notStopped = requested.filter((taskId) => !stopped.has(taskId));
  if (notStopped.length > 0) {
    options.run.lines.push(
      `- members: ${notStopped.join(", ")} had no recorded stop; nothing to retry for them`,
    );
  }
  let retried: readonly string[] = [];
  let runEndedWhileRetrying = false;
  // Set inside the CAS updater when a re-arm rewrote the supervisor record since the
  // recovery verdict: the new supervisor's freshly recorded stops must survive
  // (bd-233 review round 2, same guard as the prune).
  let recordChanged = false;
  const written = updateFleetIntent({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    fs: options.fs,
    update: (current) => {
      if (current === undefined || current.run === undefined) {
        return { refuse: `no run record for \`${options.reconcile.fleetId}\` to retry` };
      }
      const recovery = options.reconcile.recovery;
      if (
        recovery !== undefined &&
        !supervisorRecordMatches(current, recovery.fingerprint, {
          alsoAllowUpdatedAt: options.reconcile.now,
        })
      ) {
        recordChanged = true;
        return {
          refuse:
            `fleet \`${options.reconcile.fleetId}\` changed while reconciling (its supervisor ` +
            "record was rewritten); no stop was cleared",
        };
      }
      // The run may have finished between the read above and this write; only an
      // active run has a next tick to promise.
      if (!isFleetRunActive(current.run)) {
        runEndedWhileRetrying = true;
        return { refuse: `fleet \`${options.reconcile.fleetId}\`'s run ended while retrying` };
      }
      const cleared = retryRunMembers({
        run: current.run,
        taskIds: requested,
        now: options.reconcile.now,
      });
      retried = cleared.retried;
      return cleared.retried.length === 0 ? current : { ...current, run: cleared.run };
    },
  });
  if (!written.ok) {
    if (recordChanged) {
      warnRetryRecordChanged({
        run: options.run,
        reconcile: options.reconcile,
        fs: options.fs,
        requested,
      });
      return;
    }
    options.run.warnings.push(
      runEndedWhileRetrying
        ? `${options.reconcile.fleetId}'s run ended while retrying; no stop was cleared. Re-arm ` +
            "the fleet and retry from the live run"
        : `could not clear the recorded stop(s) (${written.error})`,
    );
    return;
  }
  if (retried.length === 0) return;
  options.run.repairs.push(...retried.map((taskId) => `member-retry:${taskId}`));
  options.run.lines.push(
    `- members: retrying ${retried.join(", ")} (cleared the recorded stop); the run's next tick ` +
      "reconsiders them and lands any work that finished, and stops them again if their " +
      "orchestrator is still gone. A member whose worktree is gone needs " +
      "prune-dead-members plus a fresh launch (belayd_fleet_launch).",
  );
  const auditWarning = auditReconcile({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    sessionId: options.reconcile.sessionId,
    now: options.reconcile.now,
    action: "member-retry",
    taskIds: retried,
    detail:
      "operator retry: the recorded stop was cleared so the run's next tick plans the " +
      "member again",
    fs: options.fs,
  });
  if (auditWarning !== undefined) options.run.warnings.push(auditWarning);
}

/**
 * Prune members whose orchestrator is provably gone.
 *
 * Deliberately narrow: pruning needs positive `absent` evidence (the scan worked
 * and nothing carries `belayd-<taskId>`), `unknown` liveness is never pruned, and
 * only the exact ids observed absent in the fresh intent are removed (CAS), so a
 * member that was launched in the meantime survives. The supervisor's own
 * liveness is deliberately not a precondition: a live supervisor is exactly the
 * caller that must drop phantom members so the conservative capacity count stops
 * being held by sessions that provably do not exist. The worktree, session
 * transcript, and bead are untouched — pruning changes which sessions the fleet
 * *counts*, not what exists on disk.
 *
 * The member's bd ordering gates are resolved **after** the intent CAS succeeds, for
 * the members actually removed: a pruned member can never land, so its open gates
 * would be orphans nothing else could resolve (bd-158), but a refused prune must leave
 * bd untouched (bd-233 review round 2). The module stays bd-free by taking the
 * resolver as an injected seam, and an absent seam keeps the records (a caller that
 * does not own gates must not be told they were resolved).
 */
async function pruneDeadMembers(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  fs: FleetStateFs;
  deadMembers: readonly string[];
}): Promise<void> {
  const dead = new Set(options.deadMembers);
  let pruned: readonly string[] = [];
  // Set inside the CAS updater when the supervisor record changed since the verdict
  // that licensed this recovery prune (W5).
  let recordChanged = false;
  const written = updateFleetIntent({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    fs: options.fs,
    update: (current) => {
      if (current === undefined) {
        return { refuse: `no fleet intent for \`${options.reconcile.fleetId}\` to prune` };
      }
      // The recovery verdict was read before this pass started. A re-arm that landed
      // in between rewrote the supervisor record and preserved its members; pruning
      // them here would erase the record a live supervisor just wrote (W5).
      const recovery = options.reconcile.recovery;
      if (
        recovery !== undefined &&
        !supervisorRecordMatches(current, recovery.fingerprint, {
          // This same pass may have just unparked the fleet, which stamps its clock.
          alsoAllowUpdatedAt: options.reconcile.now,
        })
      ) {
        recordChanged = true;
        return {
          refuse:
            `fleet \`${options.reconcile.fleetId}\` changed while reconciling (its supervisor ` +
            "record was rewritten); nothing was pruned",
        };
      }
      const removed = current.taskIds.filter((taskId) => dead.has(taskId));
      if (removed.length === 0) return current;
      pruned = removed;
      // A pruned member cannot need a human any more: leaving its stop behind makes
      // the run keep reporting "needs a human" for a member the fleet just removed
      // (bd-233).
      const clearedRun =
        current.run === undefined
          ? undefined
          : retryRunMembers({
              run: current.run,
              taskIds: removed,
              now: options.reconcile.now,
            }).run;
      return {
        ...current,
        taskIds: current.taskIds.filter((taskId) => !dead.has(taskId)),
        ...(current.released === undefined
          ? {}
          : { released: current.released.filter((entry) => !dead.has(entry.taskId)) }),
        ...(clearedRun === undefined ? {} : { run: clearedRun }),
        updatedAt: options.reconcile.now,
      };
    },
  });
  if (!written.ok) {
    if (recordChanged) {
      const warning =
        `fleet \`${options.reconcile.fleetId}\` changed while reconciling (a new supervisor may ` +
        "have re-armed it); nothing was pruned — re-run the reconcile";
      options.run.warnings.push(warning);
      const auditWarning = auditReconcile({
        gitCommonDir: options.reconcile.gitCommonDir,
        fleetId: options.reconcile.fleetId,
        sessionId: options.reconcile.sessionId,
        now: options.reconcile.now,
        action: "member-prune-refused",
        taskIds: [...options.deadMembers],
        detail: warning,
        fs: options.fs,
      });
      if (auditWarning !== undefined) options.run.warnings.push(auditWarning);
      return;
    }
    options.run.warnings.push(
      `could not prune dead members from the fleet intent (${written.error})`,
    );
    return;
  }
  if (pruned.length === 0) return;
  // bd is mutated only now, against members that are actually gone (bd-158, W4).
  // The gate records are dropped by a second CAS write; if it fails, the member stays
  // pruned and the record stays for the tick's retry, exactly as before.
  const resolvedGateIds = await resolveGatesOfPrunedMembers({ ...options }, new Set(pruned));
  if (resolvedGateIds.length > 0) {
    dropGatesOfPrunedMembers({
      run: options.run,
      reconcile: options.reconcile,
      fs: options.fs,
      pruned,
      gateIds: resolvedGateIds,
    });
  }
  options.run.repairs.push(...pruned.map((taskId) => `member-pruned:${taskId}`));
  options.run.lines.push(
    `- members: pruned ${pruned.join(", ")} (no lease, no orchestrator process, and a worktree ` +
      "that provably existed is gone); any recorded stop of theirs was cleared too, and the " +
      "worktrees, transcripts, and beads are untouched",
  );
  const auditWarning = auditReconcile({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    sessionId: options.reconcile.sessionId,
    now: options.reconcile.now,
    action: "member-pruned-dead",
    taskIds: pruned,
    detail:
      "no lease, no orchestrator process, and no worktree although one provably existed; " +
      "removed from the intent so the capacity count is not held by dead sessions",
    fs: options.fs,
  });
  if (auditWarning !== undefined) options.run.warnings.push(auditWarning);
}

/**
 * Drop the ordering-gate records of the members a prune just removed (bd-233 W2).
 *
 * A second CAS write after the prune committed, so it carries the same
 * supervisor-record guard as the prune itself: a re-arm that landed during the bd
 * round-trips must keep its gate records, and the warning says the tick's reaper or a
 * later reconcile will resolve them. A refused drop never un-prunes the members.
 */
function dropGatesOfPrunedMembers(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  fs: FleetStateFs;
  pruned: readonly string[];
  gateIds: readonly string[];
}): void {
  // Set inside the CAS updater when a re-arm rewrote the record during the bd
  // round-trips that resolved these gates (W2).
  let recordChanged = false;
  const dropped = updateFleetIntent({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    fs: options.fs,
    update: (current) => {
      if (current === undefined) {
        return { refuse: `no fleet intent for \`${options.reconcile.fleetId}\` to drop gates` };
      }
      const recovery = options.reconcile.recovery;
      if (
        recovery !== undefined &&
        !supervisorRecordMatches(current, recovery.fingerprint, {
          // This same pass may have just stamped the prune's clock.
          alsoAllowUpdatedAt: options.reconcile.now,
        })
      ) {
        recordChanged = true;
        return {
          refuse:
            `fleet \`${options.reconcile.fleetId}\` changed while reconciling (its supervisor ` +
            "record was rewritten); kept the ordering-gate record(s)",
        };
      }
      return dropFleetOrderingGates(current, options.gateIds, options.reconcile.now);
    },
  });
  if (dropped.ok) return;
  options.run.warnings.push(
    recordChanged
      ? `pruned ${options.pruned.join(", ")} but fleet \`${options.reconcile.fleetId}\` changed ` +
          "while reconciling (a new supervisor may have re-armed it); kept their " +
          "ordering-gate record(s) — the next tick or reconcile resolves them"
      : `pruned ${options.pruned.join(", ")} but could not drop their ordering-gate ` +
          `record(s) (${dropped.error}); the next tick or reconcile retries`,
  );
}

/**
 * Resolve the ordering gates of the members about to be pruned, and return the
 * gate ids whose records may go (bd-158).
 *
 * Two passes, because a record can be missing: the recorded gates touching a dead
 * member, and a by-prefix sweep of its bead in bd (a crash between create and the
 * intent write leaves a gate no record names). Failures are warnings and keep the
 * records: this module must not claim a gate was resolved when bd disagreed.
 */
async function resolveGatesOfPrunedMembers(
  options: { run: ReconcileRun; reconcile: RunFleetReconcileOptions; fs: FleetStateFs },
  dead: ReadonlySet<string>,
): Promise<readonly string[]> {
  const seam = options.reconcile.orderingGates;
  const deadIds = [...dead];
  if (seam === undefined || deadIds.length === 0) return [];
  const loaded = loadIntent({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    fs: options.fs,
  });
  const recorded = loaded.ok ? (loaded.intent.orderingGates ?? []) : [];
  const touching = recorded.filter((gate) => dead.has(gate.blocker) || dead.has(gate.blocked));
  const resolved: string[] = [];
  if (touching.length > 0) {
    const result = await seam.resolve(touching);
    resolved.push(...result.resolved.map((gate) => gate.gateId));
    if (!result.ok) {
      options.run.warnings.push(
        `could not resolve the ordering gate(s) of the pruned member(s) (${result.error}); ` +
          "the unresolved records are kept and the next tick or reconcile retries",
      );
    }
  }
  const prefix = await seam.reapByPrefix({
    fleetId: options.reconcile.fleetId,
    beadIds: deadIds,
    scope: "whole-bead",
  });
  resolved.push(...prefix.resolved.map((gate) => gate.gateId));
  if (!prefix.ok) {
    options.run.warnings.push(
      `could not reap every ordering gate of the pruned member(s) (${prefix.error}); ` +
        "any unresolved records are kept and the next tick or reconcile retries",
    );
  }
  return resolved;
}

/** Supervisor + member liveness: the read-only half of reconcile. */
async function reconcileSupervision(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  intent: FleetIntent;
  fs: FleetStateFs;
}): Promise<void> {
  const { reconcile, intent, run } = options;
  const supervisor = classifyFleetSupervisor({
    supervisor: intent.supervisor,
    liveness: {
      isPidAlive: reconcile.isPidAlive,
      ...(reconcile.pidStartTime === undefined ? {} : { pidStartTime: reconcile.pidStartTime }),
    },
  });
  run.lines.push(describeSupervisor(supervisor, reconcile.fleetId));

  const liveness = reportMemberLiveness({
    members: intent.taskIds,
    scan: reconcile.scan,
    ...(reconcile.selfPid === undefined ? {} : { selfPid: reconcile.selfPid }),
    ...(reconcile.memberWorktreeFor === undefined
      ? {}
      : { worktreeFor: reconcile.memberWorktreeFor }),
    ...(reconcile.leaseFor === undefined ? {} : { leaseFor: reconcile.leaseFor }),
    ...(reconcile.memberRanFor === undefined ? {} : { memberRanFor: reconcile.memberRanFor }),
    ...(reconcile.memberWorktreeExistedFor === undefined
      ? {}
      : { worktreeExistedFor: reconcile.memberWorktreeExistedFor }),
  });
  run.lines.push(
    ...(liveness.length === 0
      ? ["- members: none recorded"]
      : liveness.map((member) => `- member ${member.taskId}: ${formatLiveness(member.liveness)}`)),
  );
  if (!reconcile.scan.ok) {
    run.warnings.push(
      `member liveness is unknown (${reconcile.scan.reason}); no member was pruned and the ` +
        "capacity count still includes every member of every fleet",
    );
  }

  const deadMembers = liveness
    .filter((member) => member.liveness.kind === "absent")
    .map((member) => member.taskId);
  // Only positive `absent` evidence licenses a prune. `unknown` (read error,
  // unreadable table, truncated scan) is never treated as gone, so an unusable
  // scan prunes nothing and says so instead of suggesting the flag.
  if (!reconcile.scan.ok) {
    run.lines.push(
      "- members: nothing pruned — liveness is unknown, and only positive `absent` evidence " +
        "removes a member (the capacity count stays conservative)",
    );
    return;
  }
  if (reconcile.pruneDeadMembers !== true) {
    if (deadMembers.length > 0) {
      run.lines.push(
        `- members: ${deadMembers.join(", ")} have no orchestrator lease or process and no ` +
          "worktree that still exists; re-run with prune-dead-members to remove them from the " +
          "intent (worktrees stay)",
      );
    }
    return;
  }
  if (deadMembers.length === 0) {
    if (liveness.length > 0) {
      run.lines.push(
        "- members: nothing to prune (no recorded member has positive absent evidence)",
      );
    }
    return;
  }
  // A live supervisor may prune: dropping phantom members is how the capacity
  // count stops being held by sessions that provably do not exist.
  await pruneDeadMembers({ run, reconcile, fs: options.fs, deadMembers });
}
// ── The reconcile engine ──────────────────────────────────────────────

/** What the queue looked like, plus the repairs it calls for. */
interface QueueInspection {
  queue: FleetMergeQueue | undefined;
  lock: FleetMergeQueue["lock"];
  repairs: readonly FleetQueueRepair[];
}

type QueueInspectionResult =
  | { ok: true; inspection: QueueInspection }
  | { ok: false; error: string };

/**
 * Read the queue, git-prove landed entries, and diagnose.
 *
 * An unreadable queue is a value, not a throw: reconcile must still report the
 * supervision half, so a corrupt queue degrades one section instead of failing the
 * whole repair pass.
 */
async function inspectQueue(options: {
  reconcile: RunFleetReconcileOptions;
  fs: FleetStateFs;
  baseBranch: string;
}): Promise<QueueInspectionResult> {
  const queue = readFleetMergeQueue({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    fs: options.fs,
  });
  if (!queue.ok) return { ok: false, error: queue.error };

  const activeEntries = (queue.queue?.entries ?? []).filter((entry) =>
    FLEET_RECONCILE_ACTIVE_ENTRY_STATES.some((state) => state === entry.state),
  );
  const merged = await mergedIntoBase({
    git: options.reconcile.git,
    rootCwd: options.reconcile.rootCwd,
    baseBranch: options.baseBranch,
    entries: activeEntries,
  });
  const repairs = diagnoseMergeQueue({
    queue: queue.queue,
    mergedIntoBase: merged,
    now: options.reconcile.now,
  });
  return {
    ok: true,
    inspection: {
      queue: queue.queue,
      lock: queue.queue?.lock ?? null,
      repairs,
    },
  };
}

/** Whether anything in the inspection actually needs the merge lock held. */
function needsMergeLock(inspection: QueueInspection, parked: boolean): boolean {
  if (parked) return true;
  return inspection.repairs.some(
    (repair) =>
      repair.action === "take-over-lock" ||
      repair.action === "reset-queued" ||
      repair.action === "mark-merged",
  );
}

/** Report a repair pass that deliberately did nothing. */
function reportNoRepair(options: {
  run: ReconcileRun;
  inspection: QueueInspection;
  parked: boolean;
  now: number;
}): void {
  const { run, inspection } = options;
  if (inspection.lock !== null && lockIsLive({ queue: inspection.queue, now: options.now })) {
    const lock = inspection.lock;
    run.lines.push(
      `- queue: lock held by ${lock.holder} for ${lock.taskId} until ` +
        `${new Date(lock.leaseExpiresAt).toISOString()}; left alone`,
    );
  } else {
    run.lines.push("- queue: consistent (no lock, no in-flight entries)");
  }
  if (options.parked) {
    run.lines.push(
      "- park: not repaired — the queue is untouched in this pass; re-run reconcile once the " +
        "queue is free",
    );
  }
}

/** The repair pass while the merge lock is held. */
async function repairUnderLock(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  intent: FleetIntent;
  inspection: QueueInspection;
  fs: FleetStateFs;
}): Promise<void> {
  const { run, reconcile, inspection, fs } = options;
  const expired = inspection.repairs.find((repair) => repair.action === "take-over-lock");
  if (expired !== undefined) {
    run.repairs.push("queue:take-over-lock");
    run.lines.push(`- queue: took over the lock (${expired.reason})`);
    const auditWarning = auditReconcile({
      gitCommonDir: reconcile.gitCommonDir,
      fleetId: reconcile.fleetId,
      sessionId: reconcile.sessionId,
      now: reconcile.now,
      action: "queue-take-over-lock",
      taskIds: [],
      detail: expired.reason,
      fs,
    });
    if (auditWarning !== undefined) run.warnings.push(auditWarning);
  }
  applyEntryRepairs({
    run,
    gitCommonDir: reconcile.gitCommonDir,
    fleetId: reconcile.fleetId,
    sessionId: reconcile.sessionId,
    fs,
    now: reconcile.now,
    repairs: inspection.repairs,
  });
  // The park is repaired while the lock is still held: the root checkout is shared.
  run.lines.push((await repairPark({ run, reconcile, intent: options.intent, fs })).text);
}

/** The merge-queue + park pass. */
async function reconcileQueueAndPark(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  intent: FleetIntent;
  fs: FleetStateFs;
}): Promise<void> {
  const { run, reconcile, intent, fs } = options;
  const parked = intent.paused === true || intent.park !== undefined;

  const inspected = await inspectQueue({
    reconcile,
    fs,
    baseBranch: intent.baseBranch,
  });
  if (!inspected.ok) {
    run.lines.push(`- queue: unreadable (${inspected.error}); left untouched`);
    run.warnings.push(`the merge queue could not be read: ${inspected.error}`);
    if (parked) {
      run.lines.push(
        "- park: not repaired — the root checkout cannot be touched without the merge lock, and " +
          "the lock record itself lives in that unreadable queue",
      );
    }
    return;
  }
  const inspection = inspected.inspection;

  if (!needsMergeLock(inspection, parked)) {
    reportNoRepair({ run, inspection, parked, now: reconcile.now });
    return;
  }

  const acquired = acquireForReconcile(reconcile);
  if (!acquired.ok) {
    run.lines.push(`- queue: not repaired — ${acquired.text}`);
    if (parked) {
      run.lines.push("- park: not repaired — the root checkout is shared with the held merge lock");
    }
    return;
  }
  try {
    await repairUnderLock({ run, reconcile, intent, inspection, fs });
  } finally {
    run.warnings.push(...acquired.release());
  }
}

/** The fleet a cross-fleet repair names, and the session asking for it. */
export interface ReconcileAuthorityOptions {
  /** Fleet the call targets (its own, or one named explicitly). */
  targetFleetId: string;
  /** The fleet this session actually supervises, when it holds fleet mode. */
  ownFleetId?: string;
  /** Fleet ids whose intent records this session as supervisor. */
  supervisedFleetIds: readonly string[];
  /** Every fleet directory found in this repository, for the refusal message. */
  repoFleetIds: readonly string[];
  sessionId: string;
  /** The call asks to remove members (`pruneDeadMembers: true`). */
  pruneDeadMembers?: boolean;
  /**
   * The target fleet's supervisor is provably dead (bd-233). Only a `dead: true`
   * verdict grants the recovery arm; anything else keeps the ordinary rules.
   */
  supervisorDead?: SupervisorDeadVerdict;
}

export type ReconcileAuthority =
  | {
      ok: true;
      crossFleet: boolean;
      /** True when the authority came from a provably dead supervisor (bd-233). */
      recovery: boolean;
    }
  | { ok: false; error: string };

/**
 * Who may reconcile which fleet (bd-166, bd-233).
 *
 * A supervisor may always repair its own fleet. Repairing a *named* fleet — the
 * leaderless one whose stale slots nobody could clear without a hand edit — is
 * allowed when this session supervises some fleet in the same repository: same
 * authority rule as launch, where a session that owns a fleet is the operator's
 * agent for the rest of that repo. Naming a fleet never grants authority by
 * itself, and the caller audits the cross-fleet target.
 *
 * **Recovery (bd-233).** A fleet whose supervisor is provably dead (dead pid, cold
 * or missing beat) may be reconciled by session id alone, because otherwise the only
 * repair tool for a dead supervisor was itself supervisor-only and the fleet was
 * wedged until the beat window expired. In that arm a prune is allowed: the
 * cross-fleet prune refusal exists to protect another *live* supervisor's capacity
 * decisions, and here no live supervisor exists to decide. This grants repair
 * authority only — reconcile never writes the supervisor record, so it cannot take
 * the fleet over.
 */
export function reconcileAuthority(options: ReconcileAuthorityOptions): ReconcileAuthority {
  if (options.ownFleetId !== undefined && options.ownFleetId === options.targetFleetId) {
    return { ok: true, crossFleet: false, recovery: false };
  }
  if (options.supervisorDead?.dead === true) {
    return { ok: true, crossFleet: true, recovery: true };
  }
  // Cross-fleet authority covers repair (queue, park, liveness report), never
  // destructive removal: a prune erases another fleet's members from the capacity
  // arithmetic, and only that fleet's own supervisor (or the explicit per-member
  // `belayd_fleet_release`) should decide that. Queue/park repair is still the
  // leaderless-fleet escape hatch this feature exists for; a provably dead
  // supervisor is handled by the recovery arm above.
  if (options.pruneDeadMembers === true) {
    return {
      ok: false,
      error:
        `Fleet reconcile refused: pruneDeadMembers is only allowed on this session's own ` +
        `fleet, or on a fleet whose supervisor is provably dead. \`${options.targetFleetId}\` ` +
        `is owned by its own supervisor: re-arm it (/fleet <ids> --fleet ` +
        `${options.targetFleetId}) and run the reconcile (or belayd_fleet_release) from that ` +
        "session. Cross-fleet reconcile still repairs the queue and park without pruning.",
    };
  }
  if (options.supervisedFleetIds.length > 0) {
    return { ok: true, crossFleet: true, recovery: false };
  }
  const known = options.repoFleetIds.length === 0 ? "none" : options.repoFleetIds.join(", ");
  return {
    ok: false,
    error:
      `Fleet reconcile refused: this session (${options.sessionId}) supervises no fleet in this ` +
      `repository, so it cannot repair \`${options.targetFleetId}\`. Fleets found here: ${known}. ` +
      "Launch or re-arm a fleet from this session first (/fleet <ids> --fleet <fleetId>), then " +
      "reconcile the named fleet. If that fleet's supervisor is provably dead, name the fleet " +
      `explicitly (belayd_fleet_reconcile {"fleetId":"${options.targetFleetId}"}): a provably ` +
      "dead supervisor does not need to be re-armed to be repaired.",
  };
}

/**
 * Reconcile one fleet: queue, park, supervision. Safe to run repeatedly.
 *
 * The merge queue repair holds the existing single-flight lock (the same
 * `merge.lock.d` primitive a drain uses), so a reconcile can never interleave with
 * a merge or a second reconcile. The one repair that runs without it is the
 * record-without-primitive case, whose anomaly *is* the missing primitive.
 */
export async function runFleetReconcile(
  options: RunFleetReconcileOptions,
): Promise<RunFleetReconcileResult> {
  const fs = options.fs ?? nodeFsSeam;
  const run: ReconcileRun = { repairs: [], warnings: [], lines: [] };

  const loaded = loadIntent({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!loaded.ok) {
    return {
      ok: false,
      text: `Fleet \`${options.fleetId}\` reconcile failed: ${loaded.error}`,
      warnings: [],
      repairs: [],
    };
  }

  // Recovery authority was licensed by a verdict read before this call. If the
  // supervisor record changed since then (a second session re-armed the fleet), no
  // write of this pass — queue, park, retry, prune — may be applied to the record the
  // new supervisor just wrote (bd-233 review round 2). The per-write CAS guards below
  // stay as the second line for a re-arm that lands mid-pass.
  const recovery = options.recovery;
  if (recovery !== undefined && !supervisorRecordMatches(loaded.intent, recovery.fingerprint)) {
    const warning =
      `fleet \`${options.fleetId}\` changed since the recovery verdict (a new supervisor may ` +
      "have re-armed it); nothing was repaired — re-run the reconcile";
    const auditWarning = auditReconcile({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
      sessionId: options.sessionId,
      now: options.now,
      action: "reconcile-refused",
      taskIds: [],
      detail: warning,
      fs,
    });
    return {
      ok: false,
      text: warning,
      warnings: auditWarning === undefined ? [warning] : [warning, auditWarning],
      repairs: [],
    };
  }

  await reconcileQueueAndPark({ run, reconcile: options, intent: loaded.intent, fs });
  await reconcileSupervision({ run, reconcile: options, intent: loaded.intent, fs });
  if (options.retryMembers !== undefined && options.retryMembers.length > 0) {
    // After the prune: a member pruned in this pass is no longer a member, and the
    // retry pass must report that instead of clearing a stop nothing will plan.
    await retryStoppedMembers({ run, reconcile: options, fs, retryMembers: options.retryMembers });
  }

  const repaired = run.repairs.length;
  const lines = [
    `Fleet \`${options.fleetId}\` reconcile: ${
      repaired === 0 ? "nothing to repair" : `${repaired} repair(s) applied`
    }.`,
    ...run.lines,
  ];
  if (run.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${run.warnings.length}):`);
    for (const warning of run.warnings) lines.push(`  - ${warning}`);
  }
  return {
    ok: true,
    text: lines.join("\n"),
    warnings: run.warnings,
    repairs: run.repairs,
  };
}
