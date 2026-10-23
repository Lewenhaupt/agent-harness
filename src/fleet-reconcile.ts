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
 *    stash ref in `fleet.json`. Reconcile retries that restore from the recorded
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
import type { FleetMergeGitRunner } from "./fleet-merge.js";
import {
  acquireFleetMerge,
  FLEET_MERGE_ORPHAN_LOCK_GRACE_MS,
  releaseFleetMerge,
  restoreRecordedStash,
} from "./fleet-merge.js";
import type { FleetSupervisorState } from "./fleet-mode.js";
import { classifyFleetSupervisor } from "./fleet-mode.js";
import type { FleetMemberLiveness, FleetProcessScan } from "./fleet-sessions.js";
import { classifyMemberLivenessFromScan } from "./fleet-sessions.js";
import type { FleetMergeQueue, FleetMergeQueueEntry, FleetStateFs } from "./fleet-state.js";
import {
  appendFleetAuditEntry,
  createFleetMergeQueue,
  FLEET_MERGE_LEASE_MS,
  fleetMergeLockDir,
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
  statSync: (path) => {
    const { size, mtimeMs } = nodeFs.statSync(path);
    return { size, mtimeMs };
  },
  writeFileSync: (path, data, options) => nodeFs.writeFileSync(path, data, options),
  appendFileSync: (path, data) => nodeFs.appendFileSync(path, data),
  renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
  mkdirSync: (path, options) => {
    nodeFs.mkdirSync(path, options);
  },
  unlinkSync: (path) => nodeFs.unlinkSync(path),
  readdirSync: (path) => nodeFs.readdirSync(path),
  rmdirSync: (path) => nodeFs.rmdirSync(path),
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
export type FleetQueueAnomaly =
  | "expired-lease"
  | "record-without-lock"
  | "orphan-lock-dir"
  | "entry-stuck"
  | "entry-merged-unrecorded";

/** What reconcile does about it. `leave-alone` is a decision, not an omission. */
export type FleetQueueRepairAction =
  | "take-over-lock"
  | "clear-lock-record"
  | "remove-lock-dir"
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
  /** Whether `<fleetDir>/merge.lock.d` exists (the acquisition authority). */
  lockDirPresent: boolean;
  /** Age of the lock directory when it exists and its mtime is readable. */
  lockDirAgeInMs: number | undefined;
  /** Entries whose branch git proved is already an ancestor of the base. */
  mergedIntoBase: readonly string[];
  now: number;
  orphanGraceInMs?: number;
}

/** Whether a held lock is still inside its lease and backed by its primitive. */
function lockIsLive(options: {
  queue: FleetMergeQueue | undefined;
  lockDirPresent: boolean;
  now: number;
}): boolean {
  const lock = options.queue?.lock ?? null;
  if (lock === null) return false;
  return options.now < lock.leaseExpiresAt && options.lockDirPresent;
}

/** Repairs for the lock record / lock directory pair. */
function diagnoseLockState(input: DiagnoseMergeQueueInput): FleetQueueRepair[] {
  const grace = input.orphanGraceInMs ?? FLEET_MERGE_ORPHAN_LOCK_GRACE_MS;
  const lock = input.queue?.lock ?? null;

  if (lock === null) {
    if (!input.lockDirPresent) return [];
    const stale = input.lockDirAgeInMs !== undefined && input.lockDirAgeInMs >= grace;
    return [
      {
        anomaly: "orphan-lock-dir",
        action: stale ? "remove-lock-dir" : "leave-alone",
        reason: stale
          ? `the lock directory is ${Math.round((input.lockDirAgeInMs ?? 0) / 1000)}s old and no ` +
            "lock record names a holder; it is a crashed acquisition and is reclaimed"
          : `the lock directory is inside the ${Math.round(grace / 1000)}s grace window: an ` +
            "acquirer may still be between creating the directory and writing its lease",
      },
    ];
  }
  if (input.now >= lock.leaseExpiresAt) {
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
  if (!input.lockDirPresent) {
    return [
      {
        anomaly: "record-without-lock",
        action: "clear-lock-record",
        reason:
          "the lock record is not backed by merge.lock.d, and the directory is the acquisition " +
          "authority: no merge can be in flight under this protocol",
      },
    ];
  }
  return [];
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
 * - a record without its primitive → clear the record: `mkdir` is the acquisition
 *   authority, so without the directory no merge can be in flight;
 * - a primitive without a record → leave it inside the grace window (a winner may
 *   still be between `mkdir` and writing its lease) and remove it after;
 * - an entry frozen in an in-flight state while no lock is live → `mark-merged`
 *   when git proves the branch already landed, otherwise `reset-queued` with the
 *   attempt count preserved (a retry is a new attempt, not a new entry).
 */
export function diagnoseMergeQueue(input: DiagnoseMergeQueueInput): readonly FleetQueueRepair[] {
  const repairs = diagnoseLockState(input);
  // An in-flight entry is only an anomaly when no lock is live: while a holder is
  // inside its lease, an in-flight state is exactly what is expected.
  if (lockIsLive({ queue: input.queue, lockDirPresent: input.lockDirPresent, now: input.now })) {
    return repairs;
  }
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
    : `fleet ${options.fleetId}: could not append to audit.log (${appended.error})`;
}

/** Age of the lock directory, or undefined when it does not exist / has no mtime. */
function lockDirAgeInMs(options: {
  fs: FleetStateFs;
  lockDir: string;
  now: number;
}): number | undefined {
  if (!options.fs.existsSync(options.lockDir)) return undefined;
  try {
    const { mtimeMs } = options.fs.statSync(options.lockDir);
    return mtimeMs === undefined ? undefined : Math.max(0, options.now - mtimeMs);
  } catch {
    return undefined;
  }
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
  leaseInMs?: number;
  orphanGraceInMs?: number;
  /**
   * Remove members whose orchestrator session is provably gone (positive `absent`
   * evidence; `unknown` liveness never qualifies, and the supervisor's own
   * liveness is not a precondition). Opt-in: a prune changes what the capacity
   * count sees, so it is never implicit.
   */
  pruneDeadMembers?: boolean;
  fs?: FleetStateFs;
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

/**
 * Clear a lock record whose `merge.lock.d` primitive is gone.
 *
 * This repair runs **without** holding the lock, and says why: the anomaly is the
 * absence of the primitive, so there is nothing to race with. The CAS update only
 * clears the exact record that was diagnosed (same holder/task/acquiredAt), so a
 * concurrent acquirer's fresh record is never dropped.
 */
function clearLockRecordWithoutPrimitive(options: {
  gitCommonDir: string;
  fleetId: string;
  fs: FleetStateFs;
  expected: NonNullable<FleetMergeQueue["lock"]>;
  now: number;
}): { ok: true } | { ok: false; error: string } {
  let cleared = false;
  const written = updateFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs: options.fs,
    update: (current) => {
      const lock = current?.lock ?? null;
      if (
        current === undefined ||
        lock === null ||
        lock.holder !== options.expected.holder ||
        lock.taskId !== options.expected.taskId ||
        lock.acquiredAt !== options.expected.acquiredAt
      ) {
        return current ?? createFleetMergeQueue(options.now);
      }
      cleared = true;
      return { ...current, lock: null, updatedAt: options.now };
    },
  });
  if (!written.ok) return { ok: false, error: written.error };
  return cleared ? { ok: true } : { ok: false, error: "the lock record changed while reconciling" };
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
      "- park: the fleet is paused but no stash ref is recorded in fleet.json `park` " +
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
    baseBranch: intent.baseBranch ?? "main",
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
 * consistent (two members cannot see two different process tables).
 */
export function reportMemberLiveness(options: {
  members: readonly string[];
  scan: FleetProcessScan;
  selfPid?: number;
}): readonly MemberLivenessReport[] {
  return options.members.map((taskId) => ({
    taskId,
    liveness: classifyMemberLivenessFromScan({
      taskId,
      scan: options.scan,
      ...(options.selfPid === undefined ? {} : { selfPid: options.selfPid }),
    }),
  }));
}

function formatLiveness(liveness: FleetMemberLiveness): string {
  switch (liveness.kind) {
    case "live":
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
        `was reused); re-arm with \`/fleet <ids> --fleet ${fleetId}\``
      );
    case "none":
      return "- supervisor: none recorded";
  }
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
 */
function pruneDeadMembers(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  fs: FleetStateFs;
  deadMembers: readonly string[];
}): void {
  const dead = new Set(options.deadMembers);
  let pruned: readonly string[] = [];
  const written = updateFleetIntent({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    fs: options.fs,
    update: (current) => {
      if (current === undefined) {
        return { refuse: `no fleet intent for \`${options.reconcile.fleetId}\` to prune` };
      }
      const removed = current.taskIds.filter((taskId) => dead.has(taskId));
      if (removed.length === 0) return current;
      pruned = removed;
      return {
        ...current,
        taskIds: current.taskIds.filter((taskId) => !dead.has(taskId)),
        updatedAt: options.reconcile.now,
      };
    },
  });
  if (!written.ok) {
    options.run.warnings.push(
      `could not prune dead members from the fleet intent (${written.error})`,
    );
    return;
  }
  if (pruned.length === 0) return;
  options.run.repairs.push(...pruned.map((taskId) => `member-pruned:${taskId}`));
  options.run.lines.push(
    `- members: pruned ${pruned.join(", ")} (no orchestrator process carries the member session ` +
      "token); worktrees, transcripts, and beads are untouched",
  );
  const auditWarning = auditReconcile({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    sessionId: options.reconcile.sessionId,
    now: options.reconcile.now,
    action: "member-pruned-dead",
    taskIds: pruned,
    detail:
      "no orchestrator process carries the member session token; removed from the intent so the " +
      "capacity count is not held by dead sessions",
    fs: options.fs,
  });
  if (auditWarning !== undefined) options.run.warnings.push(auditWarning);
}

/** Supervisor + member liveness: the read-only half of reconcile. */
function reconcileSupervision(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  intent: FleetIntent;
  fs: FleetStateFs;
}): void {
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
        `- members: ${deadMembers.join(", ")} have no orchestrator process; ` +
          "re-run with prune-dead-members to remove them from the intent (worktrees stay)",
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
  pruneDeadMembers({ run, reconcile, fs: options.fs, deadMembers });
}

// ── The reconcile engine ──────────────────────────────────────────────

/** What the queue looked like, plus the repairs it calls for. */
interface QueueInspection {
  queue: FleetMergeQueue | undefined;
  lock: FleetMergeQueue["lock"];
  dirPresent: boolean;
  repairs: readonly FleetQueueRepair[];
  /** Orphaned directory inside its grace window: a decision to leave it alone. */
  heldOrphan?: FleetQueueRepair;
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

  const lockDir = fleetMergeLockDir(options.reconcile.gitCommonDir, options.reconcile.fleetId);
  const dirPresent = options.fs.existsSync(lockDir);
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
    lockDirPresent: dirPresent,
    lockDirAgeInMs: lockDirAgeInMs({ fs: options.fs, lockDir, now: options.reconcile.now }),
    mergedIntoBase: merged,
    now: options.reconcile.now,
    ...(options.reconcile.orphanGraceInMs === undefined
      ? {}
      : { orphanGraceInMs: options.reconcile.orphanGraceInMs }),
  });
  const heldOrphan = repairs.find(
    (repair) => repair.anomaly === "orphan-lock-dir" && repair.action === "leave-alone",
  );
  return {
    ok: true,
    inspection: {
      queue: queue.queue,
      lock: queue.queue?.lock ?? null,
      dirPresent,
      repairs,
      ...(heldOrphan === undefined ? {} : { heldOrphan }),
    },
  };
}

/** Clear the stale lock record, returning whether the queue is repairable at all. */
function clearStaleLockRecord(options: {
  run: ReconcileRun;
  reconcile: RunFleetReconcileOptions;
  inspection: QueueInspection;
  fs: FleetStateFs;
}): boolean {
  const repair = options.inspection.repairs.find(
    (candidate) => candidate.action === "clear-lock-record",
  );
  const lock = options.inspection.lock;
  if (repair === undefined || lock === null) return true;

  const cleared = clearLockRecordWithoutPrimitive({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    fs: options.fs,
    expected: lock,
    now: options.reconcile.now,
  });
  if (!cleared.ok) {
    options.run.lines.push(`- queue: could not clear the stale lock record (${cleared.error})`);
    options.run.warnings.push(cleared.error);
    return false;
  }
  options.run.repairs.push("queue:clear-lock-record");
  options.run.lines.push(`- queue: cleared the lock record (${repair.reason})`);
  const auditWarning = auditReconcile({
    gitCommonDir: options.reconcile.gitCommonDir,
    fleetId: options.reconcile.fleetId,
    sessionId: options.reconcile.sessionId,
    now: options.reconcile.now,
    action: "queue-clear-lock-record",
    taskIds: [],
    detail: repair.reason,
    fs: options.fs,
  });
  if (auditWarning !== undefined) options.run.warnings.push(auditWarning);
  return true;
}

/** Whether anything in the inspection actually needs the merge lock held. */
function needsMergeLock(
  inspection: QueueInspection,
  parked: boolean,
  repairable: boolean,
): boolean {
  if (!repairable) return false;
  if (parked) return true;
  return inspection.repairs.some(
    (repair) =>
      repair.action === "take-over-lock" ||
      repair.action === "remove-lock-dir" ||
      repair.action === "reset-queued" ||
      repair.action === "mark-merged",
  );
}

/** Report a repair pass that deliberately did nothing. */
function reportNoRepair(options: {
  run: ReconcileRun;
  inspection: QueueInspection;
  parked: boolean;
  repairable: boolean;
  now: number;
}): void {
  const { run, inspection } = options;
  if (!options.repairable) {
    run.lines.push(
      "- queue: not repaired — the stale lock record could not be cleared (see warnings)",
    );
  } else if (
    inspection.lock !== null &&
    lockIsLive({ queue: inspection.queue, lockDirPresent: inspection.dirPresent, now: options.now })
  ) {
    const lock = inspection.lock;
    run.lines.push(
      `- queue: lock held by ${lock.holder} for ${lock.taskId} until ` +
        `${new Date(lock.leaseExpiresAt).toISOString()}; left alone`,
    );
  } else if (inspection.heldOrphan !== undefined) {
    run.lines.push(`- queue: left alone — ${inspection.heldOrphan.reason}`);
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
  if (inspection.repairs.some((repair) => repair.action === "remove-lock-dir")) {
    run.repairs.push("queue:remove-lock-dir");
    run.lines.push("- queue: reclaimed an orphaned lock directory while acquiring");
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
    baseBranch: intent.baseBranch ?? "main",
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

  const repairable = clearStaleLockRecord({ run, reconcile, inspection, fs });
  if (!needsMergeLock(inspection, parked, repairable)) {
    reportNoRepair({ run, inspection, parked, repairable, now: reconcile.now });
    return;
  }

  const acquired = acquireForReconcile(reconcile);
  if (!acquired.ok) {
    const held = inspection.heldOrphan;
    run.lines.push(
      `- queue: not repaired — ${acquired.text}` +
        (held === undefined ? "" : ` (${held.anomaly}: ${held.reason})`),
    );
    if (held !== undefined) run.warnings.push(held.reason);
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

  await reconcileQueueAndPark({ run, reconcile: options, intent: loaded.intent, fs });
  reconcileSupervision({ run, reconcile: options, intent: loaded.intent, fs });

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
