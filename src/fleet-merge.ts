/**
 * Fleet merge queue — P2 of the fleet supervisor (bd-126).
 *
 * The supervisor is still a scheduler: it runs no phase and owns no worktree.
 * What P2 adds is the one cross-tree authority the design reserves for the
 * fleet family — merging a member's finished branch into the operator's base
 * branch, one member at a time.
 *
 * Two hard properties this module exists to deliver:
 *
 * 1. **Single-flight is a filesystem fact, not a JSON convention.** The lock
 *    record in `merge-queue.json` is only a lease; acquisition is gated on
 *    `mkdir <fleetDir>/merge.lock.d`, which fails atomically when another
 *    supervisor holds it. Expiry of the lease — never the recorded pid — is the
 *    sole takeover authority, so a crashed holder is recoverable within one
 *    lease without letting a live one be displaced by pid guessing.
 * 2. **Merge in the operator's root checkout, restore the root immediately.**
 *    Only the root can hold the base branch. A dirty root is auto-stashed, the
 *    merge work runs, and the stash is restored before the lock is released. If
 *    the restore conflicts the fleet is parked with the stash ref in its `note`
 *    instead of discarding (or silently stranding) the operator's work.
 *
 * **Merging is not closing.** This module never invokes `bd`; a merged bead is
 * left `in_progress` + `human` for the human to accept. It has no bd seam at
 * all, so the property holds by construction.
 *
 * Split, mirroring the other fleet modules: paths, gate derivation, queue
 * rendering, and the decision helpers are pure; lock/queue/git/gate effects live
 * in functions that take injected seams (`FleetStateFs`, git runner, gate
 * runner), so tests can drive the real `mkdir` primitive and real git in
 * throwaway fixture repositories.
 */

import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { join, resolve } from "node:path";
import {
  buildFleetNote,
  FLEET_NOTE_BROADCAST,
  resolveFleetNoteRecipients,
} from "./fleet-mailbox.js";
import type {
  FleetMergeEntryState,
  FleetMergeLock,
  FleetMergeQueue,
  FleetMergeQueueEntry,
  FleetNoteKind,
  FleetStateFs,
} from "./fleet-state.js";
import {
  appendFleetAuditEntry,
  createFleetMergeLock,
  createFleetMergeQueue,
  enqueueNoteFanout,
  FLEET_MERGE_LEASE_MS,
  fleetEventsDir,
  fleetMergeLockDir,
  readFleetIntent,
  readFleetMergeQueue,
  updateFleetIntent,
  updateFleetMergeQueue,
} from "./fleet-state.js";
import type { FleetIntent } from "./fleet-status.js";
import type { WorktreeListEntry } from "./worktree.js";
import { gitContextFreeEnv, parseWorktreeListPorcelainZ } from "./worktree.js";

// ── Locks ─────────────────────────────────────────────────────────────

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Grace period for a `merge.lock.d` directory with no lock record.
 *
 * The winner creates the directory and then writes the record, so a record-less
 * directory is either that in-flight window or a crash between the two. Refusing
 * briefly keeps a loser from stealing a winner's primitive; taking over after
 * the grace keeps a crash from wedging the queue forever.
 */
export const FLEET_MERGE_ORPHAN_LOCK_GRACE_MS = 30 * 1000;

export interface FleetMergeLockOptions {
  gitCommonDir: string;
  fleetId: string;
  fs?: FleetStateFs;
}

function lockFs(options: FleetMergeLockOptions): FleetStateFs {
  return options.fs ?? nodeFsSeam;
}

type MkdirOutcome = { kind: "created" } | { kind: "exists" } | { kind: "error"; error: string };

/** Create the lock directory non-recursively: `EEXIST` means someone else holds it. */
function createLockDir(lockDir: string, fs: FleetStateFs): MkdirOutcome {
  try {
    fs.mkdirSync(lockDir);
    return { kind: "created" };
  } catch (error) {
    if (errorCode(error) === "EEXIST") return { kind: "exists" };
    return { kind: "error", error: errorMessage(error) };
  }
}

/** Remove an empty lock directory; absence counts as removed (idempotent). */
function removeLockDir(
  lockDir: string,
  fs: FleetStateFs,
): { ok: true } | { ok: false; error: string } {
  try {
    fs.rmdirSync(lockDir);
    return { ok: true };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true };
    return { ok: false, error: errorMessage(error) };
  }
}

/** Age of the orphaned primitive, for the grace check. */
function lockDirAgeMs(lockDir: string, now: number, fs: FleetStateFs): number | undefined {
  try {
    const stat = fs.statSync(lockDir);
    if (stat.mtimeMs === undefined) return undefined;
    return Math.max(0, now - stat.mtimeMs);
  } catch {
    return undefined;
  }
}

export interface AcquireFleetMergeOptions extends FleetMergeLockOptions {
  /** Session id of the acquiring supervisor. */
  holder: string;
  taskId: string;
  pid: number;
  /** Epoch-ms clock supplied by the caller (no ambient clock in this layer). */
  now: number;
  leaseInMs?: number;
}

export type AcquireFleetMergeResult =
  | {
      ok: true;
      lock: FleetMergeLock;
      queue: FleetMergeQueue;
      /** Why the lease was free: `no-queue`, `lock-free`, or `lease-expired`. */
      reason: "no-queue" | "lock-free" | "lease-expired";
    }
  | {
      ok: false;
      reason:
        | "lock-held"
        | "orphan-lock-dir"
        | "record-without-lock"
        | "queue-unreadable"
        | "write-failed"
        | "lost-race";
      error: string;
      holder?: string;
      leaseExpiresAt?: number;
    };

/** Audit one cross-tree action; a failure is returned so the caller can report it. */
export function appendFleetMergeAudit(
  options: FleetMergeLockOptions & {
    actor: string;
    now: number;
    action: string;
    taskIds: readonly string[];
    detail: string;
  },
): string | undefined {
  const appended = appendFleetAuditEntry({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    entry: {
      timestamp: options.now,
      fleetId: options.fleetId,
      actor: options.actor,
      action: options.action,
      taskIds: [...options.taskIds],
      detail: options.detail,
    },
  });
  if (appended.ok) return undefined;
  return `fleet ${options.fleetId}: could not append to audit.log (${appended.error})`;
}

/**
 * Atomically acquire the single-flight merge lock.
 *
 * Order matters in both directions:
 *
 * 1. Read the queue first, so an unexpired lease is refused without touching the
 *    primitive (a live holder keeps its directory untouched).
 * 2. Try `mkdir` — the atomic half. Only the process that creates the directory
 *    may write the lock record.
 * 3. On an expired lease, remove the stale primitive and retry `mkdir`; the
 *    retry can still lose to a concurrent acquirer, which is reported
 *    (`lost-race`), never assumed away.
 * 4. Write the lease record, then prove the primitive is still ours. A record
 *    without the directory is withdrawn, so a stolen primitive cannot leave two
 *    recorded holders.
 *
 * A record without the directory is *diagnosable*, not a wedge: it is reported
 * with its recovery time and becomes acquirable when that lease expires (the
 * lease remains the only takeover authority). A directory without a record is
 * the in-flight/crash case described by
 * {@link FLEET_MERGE_ORPHAN_LOCK_GRACE_MS}.
 *
 * Residual race, stated not hidden: two acquirers that both observe the same
 * expired lease can interleave remove/`mkdir`, and the loser can remove the
 * winner's fresh directory before the winner writes its record. The post-write
 * primitive check detects that and withdraws the record, and the next drain
 * retries; the merge itself only starts after a verified acquire, so no repo
 * mutation happens under an unverified lock.
 */
/** Why a lock cannot be acquired; the reason is what the operator acts on. */
type LockUnavailable = {
  ok: false;
  reason:
    | "lock-held"
    | "orphan-lock-dir"
    | "record-without-lock"
    | "queue-unreadable"
    | "write-failed"
    | "lost-race";
  error: string;
  holder?: string;
  leaseExpiresAt?: number;
};

/**
 * Lease half of acquisition: is anyone plausibly merging right now?
 *
 * A live lease is only believable while its primitive exists — this module's
 * holder never removes the directory mid-hold, so a missing one means the lease
 * is already broken. Report that explicitly (with the recovery time) instead of a
 * misleading "held by" message; the lease deadline still remains the sole
 * takeover authority.
 */
function preflightLock(options: {
  queue: FleetMergeQueue | undefined;
  fs: FleetStateFs;
  lockDir: string;
  now: number;
}):
  | { ok: true; lock: FleetMergeLock | null; reason: "no-queue" | "lock-free" | "lease-expired" }
  | LockUnavailable {
  const lock = options.queue?.lock ?? null;
  if (lock === null) {
    return {
      ok: true,
      lock: null,
      reason: options.queue === undefined ? "no-queue" : "lock-free",
    };
  }
  if (options.now >= lock.leaseExpiresAt) {
    return { ok: true, lock, reason: "lease-expired" };
  }
  if (!options.fs.existsSync(options.lockDir)) {
    return {
      ok: false,
      reason: "record-without-lock",
      error:
        `merge-queue.json records a lock for ${lock.holder} but ${options.lockDir} does not ` +
        `exist; it becomes acquirable at ${new Date(lock.leaseExpiresAt).toISOString()}`,
      holder: lock.holder,
      leaseExpiresAt: lock.leaseExpiresAt,
    };
  }
  return {
    ok: false,
    reason: "lock-held",
    error:
      `merge lock is held by ${lock.holder} for ${lock.taskId} until ` +
      `${new Date(lock.leaseExpiresAt).toISOString()}`,
    holder: lock.holder,
    leaseExpiresAt: lock.leaseExpiresAt,
  };
}

/** Remove a stale or orphaned primitive so `mkdir` can be retried. */
function reclaimLockDir(options: {
  fs: FleetStateFs;
  lockDir: string;
  lock: FleetMergeLock | null;
  now: number;
}): { ok: true } | LockUnavailable {
  if (options.lock === null) {
    // No record: either the winner is inside the create-then-write window, or it
    // crashed between the two. Refuse briefly, take over after the grace.
    const ageInMs = lockDirAgeMs(options.lockDir, options.now, options.fs);
    if (ageInMs === undefined || ageInMs < FLEET_MERGE_ORPHAN_LOCK_GRACE_MS) {
      return {
        ok: false,
        reason: "orphan-lock-dir",
        error:
          `${options.lockDir} exists without a lock record (acquisition in progress, or a holder ` +
          `crashed before writing its lease); retry after ` +
          `${Math.round(FLEET_MERGE_ORPHAN_LOCK_GRACE_MS / 1000)}s or remove the directory by hand`,
      };
    }
  }
  const removed = removeLockDir(options.lockDir, options.fs);
  if (removed.ok) return { ok: true };
  return {
    ok: false,
    reason: "write-failed",
    error: `could not reclaim expired merge lock at ${options.lockDir}: ${removed.error}`,
  };
}

/** Win the atomic primitive: `mkdir` first, reclaim-and-retry when it exists. */
function winLockPrimitive(options: {
  fs: FleetStateFs;
  lockDir: string;
  lock: FleetMergeLock | null;
  now: number;
}): { ok: true } | LockUnavailable {
  const firstAttempt = createLockDir(options.lockDir, options.fs);
  if (firstAttempt.kind === "error") {
    return { ok: false, reason: "write-failed", error: firstAttempt.error };
  }
  if (firstAttempt.kind === "created") return { ok: true };

  const reclaimed = reclaimLockDir(options);
  if (!reclaimed.ok) return reclaimed;

  const retry = createLockDir(options.lockDir, options.fs);
  if (retry.kind === "error") {
    return { ok: false, reason: "write-failed", error: retry.error };
  }
  if (retry.kind === "exists") {
    return {
      ok: false,
      reason: "lost-race",
      error: `another supervisor acquired ${options.lockDir} while this one was reclaiming it`,
    };
  }
  return { ok: true };
}

/** Write the lease record and prove this process still holds the primitive. */
function writeAcquireRecord(
  options: AcquireFleetMergeOptions,
  fs: FleetStateFs,
  lockDir: string,
): AcquireFleetMergeResult {
  const record = createFleetMergeLock({
    holder: options.holder,
    taskId: options.taskId,
    pid: options.pid,
    now: options.now,
    ...(options.leaseInMs === undefined ? {} : { leaseInMs: options.leaseInMs }),
  });
  const written = updateFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
    update: (current) => ({
      ...(current ?? createFleetMergeQueue(options.now)),
      updatedAt: options.now,
      lock: record,
    }),
  });
  if (!written.ok) {
    removeLockDir(lockDir, fs);
    return { ok: false, reason: "write-failed", error: written.error };
  }

  if (!fs.existsSync(lockDir)) {
    // The record was written but the primitive is gone: another acquirer won the
    // reclaim race. Withdraw our record instead of believing we hold the lock.
    updateFleetMergeQueue({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
      fs,
      update: (current) =>
        current === undefined || current.lock?.holder !== options.holder
          ? (current ?? createFleetMergeQueue(options.now))
          : { ...current, updatedAt: options.now, lock: null },
    });
    return {
      ok: false,
      reason: "lost-race",
      error: `lost the merge lock at ${lockDir} to a concurrent acquirer`,
    };
  }
  return { ok: true, lock: record, queue: written.queue, reason: "lock-free" };
}

export function acquireFleetMerge(options: AcquireFleetMergeOptions): AcquireFleetMergeResult {
  const fs = lockFs(options);
  const lockDir = fleetMergeLockDir(options.gitCommonDir, options.fleetId);
  const loaded = readFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!loaded.ok) return { ok: false, reason: "queue-unreadable", error: loaded.error };

  const preflight = preflightLock({ queue: loaded.queue, fs, lockDir, now: options.now });
  if (!preflight.ok) return preflight;

  const won = winLockPrimitive({ fs, lockDir, lock: preflight.lock, now: options.now });
  if (!won.ok) return won;

  const acquired = writeAcquireRecord(options, fs, lockDir);
  // The preflight reason is the honest one ("lease-expired"), not the generic
  // default the record writer uses.
  return acquired.ok ? { ...acquired, reason: preflight.reason } : acquired;
}
export interface RenewFleetMergeLeaseOptions extends FleetMergeLockOptions {
  holder: string;
  taskId: string;
  now: number;
  leaseInMs?: number;
}

export type RenewFleetMergeLeaseResult =
  | { ok: true; lock: FleetMergeLock }
  | {
      ok: false;
      reason: "not-holder" | "queue-unreadable" | "lock-dir-missing" | "write-failed";
      error: string;
    };

/**
 * Renew the lease while a merge is in progress (the heartbeat).
 *
 * Renewal requires the primitive to still exist: a lease extended for a holder
 * whose lock directory is gone would recreate the record-without-lock state the
 * design calls out as broken. A foreign lease is refused, never extended.
 */
export function renewFleetMergeLease(
  options: RenewFleetMergeLeaseOptions,
): RenewFleetMergeLeaseResult {
  const fs = lockFs(options);
  const lockDir = fleetMergeLockDir(options.gitCommonDir, options.fleetId);
  const loaded = readFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!loaded.ok) return { ok: false, reason: "queue-unreadable", error: loaded.error };

  const current = loaded.queue?.lock ?? null;
  if (current === null) {
    return { ok: false, reason: "not-holder", error: "no merge lock is held" };
  }
  if (current.holder !== options.holder || current.taskId !== options.taskId) {
    return {
      ok: false,
      reason: "not-holder",
      error: `merge lock is held by ${current.holder} for ${current.taskId}, not by this session`,
    };
  }
  if (!fs.existsSync(lockDir)) {
    return {
      ok: false,
      reason: "lock-dir-missing",
      error: `merge lock record exists but ${lockDir} does not; not extending a broken lease`,
    };
  }

  const renewed: FleetMergeLock = {
    ...current,
    leaseExpiresAt: options.now + (options.leaseInMs ?? FLEET_MERGE_LEASE_MS),
  };
  const written = updateFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
    update: (queue) =>
      queue === undefined
        ? createFleetMergeQueue(options.now)
        : {
            ...queue,
            updatedAt: options.now,
            lock:
              queue.lock?.holder === options.holder && queue.lock.taskId === options.taskId
                ? renewed
                : queue.lock,
          },
  });
  if (!written.ok) return { ok: false, reason: "write-failed", error: written.error };
  return { ok: true, lock: renewed };
}

export interface ReleaseFleetMergeOptions extends FleetMergeLockOptions {
  holder: string;
  now: number;
}

export type ReleaseFleetMergeResult =
  | { ok: true; released: boolean; warnings: readonly string[] }
  | {
      ok: false;
      reason: "not-holder" | "queue-unreadable" | "write-failed";
      error: string;
    };

/**
 * Release a held merge lock: clear the record, then remove the primitive.
 *
 * Releasing a lock this session does not hold is refused and mutates nothing —
 * release must never become a general-purpose "unlock whatever is there". The
 * record is cleared before the directory so a concurrent acquirer can never
 * write a fresh record that this release then erases; the cost is that a loser
 * may briefly see a record-less directory (bounded by
 * {@link FLEET_MERGE_ORPHAN_LOCK_GRACE_MS}).
 */
export function releaseFleetMerge(options: ReleaseFleetMergeOptions): ReleaseFleetMergeResult {
  const fs = lockFs(options);
  const lockDir = fleetMergeLockDir(options.gitCommonDir, options.fleetId);
  const loaded = readFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!loaded.ok) return { ok: false, reason: "queue-unreadable", error: loaded.error };

  const current = loaded.queue?.lock ?? null;
  if (current === null) {
    return { ok: true, released: false, warnings: [] };
  }
  if (current.holder !== options.holder) {
    return {
      ok: false,
      reason: "not-holder",
      error: `refusing to release the merge lock held by ${current.holder} for ${current.taskId}`,
    };
  }

  const written = updateFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
    update: (queue) =>
      queue === undefined
        ? createFleetMergeQueue(options.now)
        : {
            ...queue,
            updatedAt: options.now,
            lock: queue.lock?.holder === options.holder ? null : queue.lock,
          },
  });
  if (!written.ok) return { ok: false, reason: "write-failed", error: written.error };

  const removed = removeLockDir(lockDir, fs);
  const warnings = removed.ok
    ? []
    : [
        `fleet ${options.fleetId}: released the lock record but could not remove ${lockDir} ` +
          `(${removed.error}); acquisition will recover it after the orphan grace period`,
      ];
  return { ok: true, released: true, warnings };
}

// ── Merge queue: enqueue and rendering ────────────────────────────────

/** Scripts a merge gate runs, in the order the project's gates are expected. */
export const FLEET_MERGE_GATE_SCRIPTS = [
  "test",
  "test:integration",
  "typecheck",
  "lint",
  "build",
] as const;

export interface FleetGateCommand {
  name: string;
  /** Script body from `package.json`, recorded for the report/audit. */
  script: string;
}

/** Package managers a gate can run through; the repository's own is preferred. */
export type FleetGateRunnerName = "pnpm" | "yarn" | "npm";

/** Lockfiles that identify a package manager when `packageManager` is absent. */
const FLEET_GATE_LOCKFILES: readonly { file: string; runner: FleetGateRunnerName }[] = [
  { file: "pnpm-lock.yaml", runner: "pnpm" },
  { file: "yarn.lock", runner: "yarn" },
  { file: "package-lock.json", runner: "npm" },
  { file: "npm-shrinkwrap.json", runner: "npm" },
];

/**
 * Which package manager runs the gates (S1).
 *
 * `package.json#packageManager` is the declared answer; a lockfile is the
 * observed one; npm is the fallback because it ships with Node. The point is
 * that a repository which is not pnpm must not have its gates reported as
 * failures because `pnpm` was hardcoded and is not installed.
 */
export function resolveFleetGateRunner(options: {
  packageManager: string | undefined;
  /** Basenames of lockfiles that exist in the merge target. */
  lockfiles: readonly string[];
}): FleetGateRunnerName {
  const declared = options.packageManager?.split("@")[0]?.trim();
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  const match = FLEET_GATE_LOCKFILES.find((candidate) =>
    options.lockfiles.includes(candidate.file),
  );
  return match?.runner ?? "npm";
}

/**
 * Gate commands derived from the repository's own `package.json` scripts.
 *
 * The list is an *order*, not a hardcoded requirement: a repo that has no
 * `test:integration` script simply runs the gates it does have. Inventing a
 * command the project does not define would make the merge gate a different
 * check than the one the project enforces.
 */
export function resolveFleetGateCommands(
  scripts: Record<string, string> | undefined,
): readonly FleetGateCommand[] {
  if (scripts === undefined) return [];
  return FLEET_MERGE_GATE_SCRIPTS.flatMap((name) => {
    const script = scripts[name];
    return typeof script === "string" ? [{ name, script }] : [];
  });
}

export type FleetGateCommandsResult =
  | {
      ok: true;
      commands: readonly FleetGateCommand[];
      /** Package manager the gates must be run through (S1). */
      runner: FleetGateRunnerName;
    }
  | {
      ok: false;
      reason: "package-json-missing" | "package-json-unreadable" | "no-gates";
      error: string;
    };

/**
 * Read the root checkout's `package.json` and derive its gate commands.
 *
 * The root checkout is the merge target, so its scripts are the gates the
 * merged result has to satisfy — reading them there (not from the member
 * worktree, whose branch may have changed them) is what makes the check the
 * project's gate rather than a claim about it.
 */
export function readFleetGateCommands(options: {
  rootCwd: string;
  fs?: FleetStateFs;
}): FleetGateCommandsResult {
  const fs = options.fs ?? nodeFsSeam;
  const path = join(options.rootCwd, "package.json");
  if (!fs.existsSync(path)) {
    return {
      ok: false,
      reason: "package-json-missing",
      error: `no package.json in the merge target ${options.rootCwd}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path));
  } catch (error) {
    return {
      ok: false,
      reason: "package-json-unreadable",
      error: `could not read ${path}: ${errorMessage(error)}`,
    };
  }
  const scripts =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { scripts?: unknown }).scripts === "object" &&
    (parsed as { scripts?: unknown }).scripts !== null
      ? (parsed as { scripts: Record<string, unknown> }).scripts
      : undefined;
  const stringScripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts ?? {})) {
    if (typeof value === "string") stringScripts[name] = value;
  }
  const commands = resolveFleetGateCommands(stringScripts);
  if (commands.length === 0) {
    return {
      ok: false,
      reason: "no-gates",
      error: `no merge gate script (${FLEET_MERGE_GATE_SCRIPTS.join(", ")}) in ${path}`,
    };
  }
  const packageManager =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { packageManager?: unknown }).packageManager === "string"
      ? (parsed as { packageManager: string }).packageManager
      : undefined;
  const lockfiles = FLEET_GATE_LOCKFILES.map((candidate) => candidate.file).filter((file) =>
    fs.existsSync(join(options.rootCwd, file)),
  );
  return {
    ok: true,
    commands,
    runner: resolveFleetGateRunner({ packageManager, lockfiles }),
  };
}

export interface EnqueueFleetMergeOptions extends FleetMergeLockOptions {
  sessionId: string;
  taskId: string;
  /** Branch the member worktree has checked out (`feat/<taskId>` by convention). */
  branch: string;
  now: number;
}

export type EnqueueFleetMergeResult =
  | {
      ok: true;
      entry: FleetMergeQueueEntry;
      queue: FleetMergeQueue;
      text: string;
      /** Non-fatal problems the caller must surface (e.g. audit append failure). */
      warnings: readonly string[];
    }
  | {
      ok: false;
      reason:
        | "not-member"
        | "already-merged"
        | "intent-unreadable"
        | "queue-unreadable"
        | "write-failed";
      error: string;
    };

/** Active entry states: re-enqueueing one of these is idempotent, not a retry. */
const ACTIVE_MERGE_STATES: readonly FleetMergeEntryState[] = [
  "queued",
  "rebasing",
  "gating",
  "merging",
];

/**
 * Enqueue one member's branch for an explicit merge.
 *
 * Membership is checked against the intent so the queue cannot be used to merge
 * a branch the fleet does not own. Re-enqueueing an active entry is idempotent;
 * a `merged` entry is refused (a second merge would be a no-op at best), while a
 * `failed`/`parked` entry becomes `queued` again — a retry is a new attempt of
 * the same entry, not a second entry.
 */
export function enqueueFleetMerge(options: EnqueueFleetMergeOptions): EnqueueFleetMergeResult {
  const fs = lockFs(options);
  const intentLoaded = readFleetIntent({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!intentLoaded.ok) {
    return { ok: false, reason: "intent-unreadable", error: intentLoaded.error };
  }
  const intent = intentLoaded.intent;
  if (intent === undefined) {
    return { ok: false, reason: "intent-unreadable", error: "no fleet intent on disk" };
  }
  if (!intent.taskIds.includes(options.taskId)) {
    const known = intent.taskIds.length === 0 ? "(none)" : intent.taskIds.join(", ");
    return {
      ok: false,
      reason: "not-member",
      error: `\`${options.taskId}\` is not a member of fleet \`${options.fleetId}\`; members: ${known}`,
    };
  }

  const loaded = readFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!loaded.ok) return { ok: false, reason: "queue-unreadable", error: loaded.error };

  const existing = loaded.queue?.entries.find((entry) => entry.taskId === options.taskId);
  if (existing !== undefined && existing.state === "merged") {
    return {
      ok: false,
      reason: "already-merged",
      error: `\`${options.taskId}\` was already merged (${existing.branch})`,
    };
  }
  if (existing !== undefined && ACTIVE_MERGE_STATES.includes(existing.state)) {
    return {
      ok: true,
      entry: existing,
      queue: loaded.queue ?? createFleetMergeQueue(options.now),
      text: `\`${options.taskId}\` is already queued for merge (state ${existing.state}).`,
      warnings: [],
    };
  }

  const entry: FleetMergeQueueEntry = {
    taskId: options.taskId,
    branch: options.branch,
    requestedAt: existing?.requestedAt ?? options.now,
    state: "queued",
    attempts: existing?.attempts ?? 0,
    updatedAt: options.now,
  };
  const written = updateFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
    update: (current) => {
      const base = current ?? createFleetMergeQueue(options.now);
      const others = base.entries.filter((candidate) => candidate.taskId !== options.taskId);
      return { ...base, updatedAt: options.now, entries: [...others, entry] };
    },
  });
  if (!written.ok) return { ok: false, reason: "write-failed", error: written.error };

  const auditWarning = appendFleetMergeAudit({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
    actor: options.sessionId,
    now: options.now,
    action: "merge-enqueued",
    taskIds: [options.taskId],
    detail: `branch ${options.branch} queued for merge into the fleet base`,
  });
  return {
    ok: true,
    entry,
    queue: written.queue,
    text:
      `Fleet \`${options.fleetId}\`: \`${options.taskId}\` (${options.branch}) queued for merge. ` +
      "Run the merge explicitly with action drain; P3 orders launches, not merges.",
    warnings: auditWarning === undefined ? [] : [auditWarning],
  };
}

/** Render the merge queue for the operator. */
export function formatFleetMergeQueue(options: {
  fleetId: string;
  queue: FleetMergeQueue | undefined;
  now: number;
}): string {
  const queue = options.queue;
  if (queue === undefined || queue.entries.length === 0) {
    return `Fleet \`${options.fleetId}\` merge queue: empty.`;
  }
  const lock = queue.lock;
  const lockLine =
    lock === null
      ? "No merge in flight."
      : `Lock: ${lock.holder} for ${lock.taskId} until ${new Date(lock.leaseExpiresAt).toISOString()}` +
        (lock.leaseExpiresAt <= options.now ? " (expired; acquirable)." : ".");
  const entries = [...queue.entries]
    .sort((left, right) => (left.taskId === right.taskId ? 0 : left.taskId < right.taskId ? -1 : 1))
    .map((entry) => {
      const error = entry.lastError === undefined ? "" : ` — ${entry.lastError}`;
      return `- ${entry.taskId} (${entry.branch}): ${entry.state}, attempts ${entry.attempts}${error}`;
    });
  return [`Fleet \`${options.fleetId}\` merge queue:`, lockLine, ...entries].join("\n");
}

// ── Git and gate seams ────────────────────────────────────────────────

export type FleetMergeCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string; stdout: string; stderr: string };

export type FleetMergeGitRunner = (
  argv: readonly string[],
  options: { cwd: string },
) => Promise<FleetMergeCommandResult>;

export interface FleetMergeGateRunOptions {
  name: string;
  script: string;
  cwd: string;
  /** Package manager the merge target declares (S1); never assumed to be pnpm. */
  runner: FleetGateRunnerName;
}

export type FleetMergeGateRunner = (
  options: FleetMergeGateRunOptions,
) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * Per-command timeout, deliberately below {@link FLEET_MERGE_LEASE_MS} (30 min).
 *
 * The lease is renewed between gates (W2), so the only way a live holder can be
 * deposed mid-work is a *single* command outliving its lease. Capping a command
 * below the lease (with margin to renew afterwards) makes that arithmetically
 * impossible instead of merely unlikely.
 */
const FLEET_MERGE_COMMAND_TIMEOUT_MS = 25 * 60 * 1000;

const FLEET_MERGE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

type RunFileCommandOptions = {
  cwd: string;
  /** Sanitized child environment; git commands must never inherit `GIT_DIR` (W4). */
  env: NodeJS.ProcessEnv;
};

function runFileCommand(
  file: string,
  argv: readonly string[],
  options: RunFileCommandOptions,
): Promise<FleetMergeCommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      file,
      [...argv],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: FLEET_MERGE_COMMAND_TIMEOUT_MS,
        maxBuffer: FLEET_MERGE_MAX_BUFFER_BYTES,
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (error) {
          resolveResult({
            ok: false,
            error: errorMessage(error),
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
          return;
        }
        resolveResult({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/**
 * Default git runner: argv only, no shell, explicit cwd (never `process.cwd()`)
 * and a context-free environment.
 *
 * `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` inherited from the session would
 * silently redirect the *mutating* root commands (`stash`, `reset --hard`,
 * `merge`) at another repository (W4).
 */
export const defaultFleetMergeGitRunner: FleetMergeGitRunner = (argv, options) =>
  runFileCommand("git", argv, { cwd: options.cwd, env: gitContextFreeEnv() });

/**
 * Default gate runner: the repository's own script through the package manager
 * its `package.json` declares (or the lockfile it ships), never a hardcoded pnpm.
 */
export const defaultFleetMergeGateRunner: FleetMergeGateRunner = (options) =>
  runFileCommand(options.runner, ["run", options.name], {
    cwd: options.cwd,
    env: gitContextFreeEnv(),
  }).then((result) =>
    result.ok
      ? { ok: true as const }
      : { ok: false as const, error: result.error || result.stderr.trim() },
  );

// ── Drain: the documented merge sequence ──────────────────────────────

export interface DrainFleetMergeOptions extends FleetMergeLockOptions {
  sessionId: string;
  /** Supervisor pid recorded in the lease (diagnostic only, never takeover). */
  pid: number;
  /** Operator root checkout; must be the checkout that owns the base branch. */
  rootCwd: string;
  /** Drain one task id; undefined drains the oldest queued entry. */
  taskId?: string;
  /** Epoch-ms clock supplied by the caller (the timestamp of this call). */
  now: number;
  /**
   * Live clock, read per step (W1).
   *
   * `now` is one snapshot taken before the drain; a drain runs for minutes, so
   * reusing it would stamp every lease renewal and audit entry with the start
   * time — a renewal after 25 min of gating would leave ~5 min of headroom while
   * claiming 30. Defaults to `Date.now` because this is the effectful layer;
   * tests inject a deterministic clock.
   */
  clock?: () => number;
  leaseInMs?: number;
  git?: FleetMergeGitRunner;
  runGate?: FleetMergeGateRunner;
}

export interface FleetMergeBroadcast {
  baseMoved: readonly string[];
  siblingLanded: readonly string[];
  rebaseHint: readonly string[];
}

export type FleetMergeFailureReason =
  | "fleet-paused"
  | "queue-unreadable"
  | "no-queued-entry"
  | "intent-unreadable"
  | "lock-unavailable"
  | "root-not-own-checkout"
  | "root-not-on-base"
  | "member-worktree-missing"
  | "member-worktree-dirty"
  | "member-branch-mismatch"
  | "member-branch-missing"
  | "gate-commands-missing"
  | "stash-failed"
  | "rebase-failed"
  | "gate-failed"
  | "merge-failed"
  | "restore-conflict"
  | "entry-not-queued"
  | "queue-write-failed"
  | "intent-write-failed";

export type DrainFleetMergeResult =
  | {
      ok: true;
      taskId: string;
      text: string;
      mergeCommit: string;
      stashRef?: string;
      broadcast: FleetMergeBroadcast;
      warnings: readonly string[];
    }
  | {
      ok: false;
      reason: FleetMergeFailureReason;
      text: string;
      taskId?: string;
      /** Set when the root was stashed; always reported, never hidden. */
      stashRef?: string;
      parked: boolean;
      warnings: readonly string[];
    };

interface MergeAttemptContext {
  options: DrainFleetMergeOptions;
  fs: FleetStateFs;
  git: FleetMergeGitRunner;
  intent: FleetIntent;
  baseBranch: string;
  entry: FleetMergeQueueEntry;
  /** Live clock: every timestamp in a drain comes from here (W1). */
  clock: () => number;
  warnings: string[];
  stashRef?: string;
  mergeCommit?: string;
  gateNames?: readonly string[];
  broadcast: FleetMergeBroadcast;
}

interface MergeCheckFailure {
  reason: FleetMergeFailureReason;
  text: string;
}

/** Run one git command; undefined means it failed (stdout is the error text). */
async function gitOk(
  context: MergeAttemptContext,
  argv: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  const result = await context.git(argv, { cwd });
  return result.ok ? result.stdout : undefined;
}

/** First line of a git failure, for an honest one-line reason. */
function commandError(result: FleetMergeCommandResult): string {
  if (result.ok) return "";
  const stderr = result.stderr.trim().split("\n")[0];
  return stderr === undefined || stderr === "" ? result.error : stderr;
}

async function gitWithError(
  context: MergeAttemptContext,
  argv: readonly string[],
  cwd: string,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const result = await context.git(argv, { cwd });
  return result.ok
    ? { ok: true, stdout: result.stdout }
    : { ok: false, error: commandError(result) };
}

/** Append to `audit.log`, collecting the warning instead of throwing. */
function auditAttempt(
  context: MergeAttemptContext,
  action: string,
  taskIds: readonly string[],
  detail: string,
): void {
  const warning = appendFleetMergeAudit({
    gitCommonDir: context.options.gitCommonDir,
    fleetId: context.options.fleetId,
    fs: context.fs,
    actor: context.options.sessionId,
    now: context.clock(),
    action,
    taskIds,
    detail,
  });
  if (warning !== undefined) context.warnings.push(warning);
}

/**
 * Pure next state of a queue entry.
 *
 * A rebasing transition counts a new attempt; a rebasing/merged transition also
 * clears a stale failure message so a recovered entry does not keep reporting
 * the previous attempt's error.
 */
function nextEntryState(options: {
  entry: FleetMergeQueueEntry;
  state: FleetMergeEntryState;
  lastError: string | undefined;
  now: number;
}): FleetMergeQueueEntry {
  const clearsError = options.state === "rebasing" || options.state === "merged";
  const error = clearsError ? undefined : options.lastError;
  return {
    ...options.entry,
    state: options.state,
    attempts: options.state === "rebasing" ? options.entry.attempts + 1 : options.entry.attempts,
    updatedAt: options.now,
    ...(error === undefined ? {} : { lastError: error }),
  };
}

/**
 * Update one queue entry's state.
 *
 * A CAS conflict is retried once against the newer queue: the transition is
 * small and idempotent, and losing a state update silently would make the
 * operator's view of the merge wrong while the repository already moved.
 */
function transitionEntry(
  context: MergeAttemptContext,
  state: FleetMergeEntryState,
  lastError: string | undefined,
): { ok: true } | { ok: false; error: string } {
  const update = () =>
    updateFleetMergeQueue({
      gitCommonDir: context.options.gitCommonDir,
      fleetId: context.options.fleetId,
      fs: context.fs,
      update: (queue) => {
        const now = context.clock();
        const base = queue ?? createFleetMergeQueue(now);
        return {
          ...base,
          updatedAt: now,
          entries: base.entries.map((entry) =>
            entry.taskId === context.entry.taskId
              ? nextEntryState({ entry, state, lastError, now })
              : entry,
          ),
        };
      },
    });

  let written = update();
  if (!written.ok && written.reason === "conflict") written = update();
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}

/** Resolve the worktree path checked out on `branch`, from git's own listing. */
async function resolveBranchWorktree(
  context: MergeAttemptContext,
  branch: string,
): Promise<string | undefined> {
  const listed = await gitWithError(
    context,
    ["worktree", "list", "--porcelain", "-z"],
    context.options.rootCwd,
  );
  if (!listed.ok) return undefined;
  const parsed = parseWorktreeListPorcelainZ(listed.stdout);
  const match = parsed.entries.find((entry) => entry.branch === branch);
  return match?.path;
}

/**
 * Verify the root checkout is still on the base branch.
 *
 * The root is the operator's own checkout, so it can move at any time — between
 * the preconditions, the stash, a long gate run, and the fast-forward. Re-checked
 * immediately before every mutation that assumes it (CR-1): `git merge --ff-only`
 * fast-forwards *whatever* HEAD holds, so a stale check would move a branch that
 * is not the base.
 */
async function verifyRootOnBase(
  context: MergeAttemptContext,
): Promise<MergeCheckFailure | undefined> {
  const rootCwd = context.options.rootCwd;
  const head = await gitOk(context, ["rev-parse", "--abbrev-ref", "HEAD"], rootCwd);
  if (head === undefined || head.trim() !== context.baseBranch) {
    return {
      reason: "root-not-on-base",
      text:
        `the merge target ${rootCwd} is on ${head?.trim() ?? "an unknown branch"}, not ` +
        `${context.baseBranch}; check out the base branch in the root before merging`,
    };
  }
  return undefined;
}

/**
 * Verify a checkout is this repository's own root checkout, on the base branch.
 *
 * Shared by the merge drain's preconditions and by the recorded-stash restore
 * (the drain's and reconcile's park repair), because both mutate the operator's
 * root: a linked worktree can legally hold the base branch while the root has
 * moved away, and restoring the parked work into that worktree would leave the
 * root holding neither the work nor the pointer to it.
 */
export type RootCheckoutVerdict =
  | { ok: true }
  | { ok: false; reason: "root-not-own-checkout" | "root-not-on-base"; text: string };

export async function checkRootCheckout(options: {
  rootCwd: string;
  baseBranch: string;
  gitCommonDir: string;
  git: FleetMergeGitRunner;
}): Promise<RootCheckoutVerdict> {
  const run = async (argv: readonly string[]): Promise<string | undefined> => {
    const result = await options.git(argv, { cwd: options.rootCwd });
    return result.ok ? result.stdout : undefined;
  };
  const rootCwd = options.rootCwd;
  const gitDir = await run(["rev-parse", "--absolute-git-dir"]);
  const commonDir = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (gitDir === undefined || commonDir === undefined) {
    return {
      ok: false,
      reason: "root-not-own-checkout",
      text: `could not resolve the git directory of ${rootCwd}`,
    };
  }
  if (resolve(gitDir.trim()) !== resolve(commonDir.trim())) {
    return {
      ok: false,
      reason: "root-not-own-checkout",
      text:
        `${rootCwd} is a linked worktree, not the repository's own checkout; only the root ` +
        "checkout can hold the base branch, so run this from the main repository root",
    };
  }
  if (resolve(commonDir.trim()) !== resolve(options.gitCommonDir)) {
    return {
      ok: false,
      reason: "root-not-own-checkout",
      text:
        `${rootCwd} belongs to ${commonDir.trim()}, not to the fleet's repository ` +
        `(${options.gitCommonDir})`,
    };
  }
  const head = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head === undefined || head.trim() !== options.baseBranch) {
    return {
      ok: false,
      reason: "root-not-on-base",
      text:
        `the merge target ${rootCwd} is on ${head?.trim() ?? "an unknown branch"}, not ` +
        `${options.baseBranch}; check out the base branch in the root before merging`,
    };
  }
  return { ok: true };
}

/**
 * Preconditions, all checked before any repository mutation.
 *
 * The root must be this repository's own checkout (a linked worktree cannot hold
 * the base branch), it must be on the base branch, the member worktree must be
 * on the entry's branch and clean. Any failure is refused before the root is
 * stashed, the member rebased, or the lock taken for real work.
 */
async function checkMergePreconditions(
  context: MergeAttemptContext,
): Promise<MergeCheckFailure | { memberWorktree: string }> {
  const rootCwd = context.options.rootCwd;
  const root = await checkRootCheckout({
    rootCwd,
    baseBranch: context.baseBranch,
    gitCommonDir: context.options.gitCommonDir,
    git: context.git,
  });
  if (!root.ok) return { reason: root.reason, text: root.text };

  const memberWorktree = await resolveBranchWorktree(context, context.entry.branch);
  if (memberWorktree === undefined) {
    return {
      reason: "member-worktree-missing",
      text: `no worktree has ${context.entry.branch} checked out; cannot merge it`,
    };
  }
  const memberHead = await gitOk(context, ["rev-parse", "--abbrev-ref", "HEAD"], memberWorktree);
  if (memberHead === undefined || memberHead.trim() !== context.entry.branch) {
    return {
      reason: "member-branch-mismatch",
      text:
        `${memberWorktree} is on ${memberHead?.trim() ?? "an unknown branch"}, not ` +
        `${context.entry.branch}; refusing to merge a different checkout`,
    };
  }
  const status = await gitOk(context, ["status", "--porcelain"], memberWorktree);
  if (status === undefined) {
    return {
      reason: "member-worktree-dirty",
      text: `could not read the working tree status of ${memberWorktree}`,
    };
  }
  if (status.trim() !== "") {
    return {
      reason: "member-worktree-dirty",
      text:
        `${memberWorktree} has uncommitted changes; commit or discard them before merging ` +
        `${context.entry.taskId}`,
    };
  }
  const branchPresent = await gitOk(
    context,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${context.entry.branch}`],
    rootCwd,
  );
  if (branchPresent === undefined) {
    return {
      reason: "member-branch-missing",
      text: `branch ${context.entry.branch} does not exist in the repository`,
    };
  }

  return { memberWorktree };
}

/** Stash a dirty root, recording the ref so it can be reported and restored. */
async function stashRootIfDirty(
  context: MergeAttemptContext,
): Promise<MergeCheckFailure | undefined> {
  const rootCwd = context.options.rootCwd;
  const status = await gitOk(context, ["status", "--porcelain"], rootCwd);
  if (status === undefined) {
    return { reason: "stash-failed", text: `could not read the working tree status of ${rootCwd}` };
  }
  if (status.trim() === "") return undefined;

  // A branch switch after the preconditions would stash a *different* branch and
  // let the later fast-forward move it; assume the root moves (CR-1).
  const onBase = await verifyRootOnBase(context);
  if (onBase !== undefined) return onBase;

  const message = `belayd fleet ${context.options.fleetId} merge ${context.entry.taskId}`;
  const stashed = await gitWithError(
    context,
    ["stash", "push", "--include-untracked", "-m", message],
    rootCwd,
  );
  if (!stashed.ok) {
    return {
      reason: "stash-failed",
      text: `could not stash the dirty merge target ${rootCwd}: ${stashed.error}`,
    };
  }
  const ref = await gitOk(context, ["rev-parse", "--verify", "--quiet", "refs/stash"], rootCwd);
  if (ref === undefined || ref.trim() === "") {
    // A fallback literal would be presented later as a verified ref (S3): fail
    // the stash step and tell the operator where the work actually is.
    return {
      reason: "stash-failed",
      text:
        `the root ${rootCwd} was stashed but its ref could not be verified; the work is in ` +
        "`git stash list` — inspect and restore it by hand before merging again",
    };
  }
  context.stashRef = ref.trim();
  auditAttempt(
    context,
    "merge-stash",
    [context.entry.taskId],
    `root stashed at ${context.stashRef}`,
  );
  return undefined;
}

/** What restoring a stashed root did; a conflict parks the fleet. */
interface RestoreOutcome {
  conflict: boolean;
  text?: string;
}

/**
 * Git seam for the recorded-stash restore, shared by the merge drain and
 * `belayd_fleet_reconcile`.
 *
 * The restore is a repository mutation with an exact, verified contract (apply the
 * *recorded* sha, never a position), so it lives in one place rather than being
 * re-implemented by the repair path.
 */
export interface RecordedStashRestore {
  rootCwd: string;
  baseBranch: string;
  fleetId: string;
  /** `<git-common-dir>`: the root must belong to *this* repository. */
  gitCommonDir: string;
  stashRef: string;
  git: FleetMergeGitRunner;
  /**
   * Refuse to apply a recorded sha that is no longer in `git stash list`.
   *
   * Reconcile sets this: a sha that was already restored and dropped still
   * resolves (`rev-parse` finds the dangling commit), so re-applying it would
   * double-apply the work — and a failed apply would then `reset --hard` over the
   * changes the first run already restored. The drain leaves it off: its ref was
   * created moments earlier by the same operation.
   */
  requireListed?: boolean;
}

export type RestoreRecordedStashResult =
  | {
      ok: true;
      warnings: readonly string[];
      /** Set when the applied entry was restored but a different stash was dropped. */
      dropMismatch?: string;
    }
  | {
      ok: false;
      reason:
        | "unresolvable"
        | "already-restored"
        | "root-not-own-checkout"
        | "root-not-on-base"
        | "conflict";
      text: string;
      warnings: readonly string[];
    };

/** Run one git command for a restore; undefined means it failed. */
async function restoreGitOk(
  options: RecordedStashRestore,
  argv: readonly string[],
): Promise<string | undefined> {
  const result = await options.git(argv, { cwd: options.rootCwd });
  return result.ok ? result.stdout : undefined;
}

/** Run one git command for a restore, keeping the first stderr line on failure. */
async function restoreGitWithError(
  options: RecordedStashRestore,
  argv: readonly string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const result = await options.git(argv, { cwd: options.rootCwd });
  return result.ok
    ? { ok: true, stdout: result.stdout }
    : { ok: false, error: commandError(result) };
}

/**
 * The commit a `git stash drop` reported dropping.
 *
 * git prints `Dropped refs/stash@{0} (<sha>)`. The sha is what makes the drop
 * verifiable: the index it names is only a position, and a position can be
 * re-pointed by another writer between the verify and the drop.
 */
export function parseDroppedStashSha(stdout: string): string | undefined {
  const match = /\(([0-9a-f]{40}|[0-9a-f]{64})\)/u.exec(stdout);
  return match?.[1];
}

/**
 * Drop the exact stash entry that was applied, resolving its current position.
 *
 * `git stash drop` only accepts a stash *reference*, not a raw commit, so the
 * recorded sha has to be looked up in the reflog first. The position is verified
 * again immediately before the drop: another writer could have shifted the list
 * between listing and dropping, and dropping the wrong entry would destroy work.
 *
 * **The drop is then cross-checked (W4).** Verify-then-drop is two operations, so
 * an interloper `stash push` between them still shifts the index and the drop
 * silently removes the wrong (older) entry — the positional warning would never
 * fire. The drop's own output names the commit it dropped, and a re-list proves
 * whether the recorded sha survived, so a mismatch is reported and audited
 * instead of being mistaken for success.
 */
async function dropRecordedStash(
  options: RecordedStashRestore,
  warnings: string[],
): Promise<{ mismatch?: string }> {
  const stashRef = options.stashRef;
  const fleet = options.fleetId;
  const listed = await restoreGitOk(options, ["stash", "list", "--format=%H"]);
  if (listed === undefined) {
    warnings.push(
      `fleet ${fleet}: applied ${stashRef} but could not list the stash to drop it; the applied ` +
        "entry is still in `git stash list`",
    );
    return {};
  }
  const hashes = listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const index = hashes.indexOf(stashRef);
  // Already gone (dropped by the operator mid-drain): nothing was restored from
  // it, but the apply above used the recorded sha, so there is nothing to drop.
  if (index === -1) return {};

  const position = `stash@{${index}}`;
  const resolved = await restoreGitOk(options, ["rev-parse", "--verify", "--quiet", position]);
  if (resolved === undefined || resolved.trim() !== stashRef) {
    warnings.push(
      `fleet ${fleet}: ${stashRef} was applied but is no longer at ${position}; not dropping a ` +
        "stash entry that is not the one restored",
    );
    return {};
  }
  const dropped = await restoreGitWithError(options, ["stash", "drop", position]);
  if (!dropped.ok) {
    warnings.push(
      `fleet ${fleet}: restored ${stashRef} but could not drop it (${dropped.error}); remove it ` +
        "by hand",
    );
    return {};
  }

  const reported = parseDroppedStashSha(dropped.stdout);
  const remaining = await restoreGitOk(options, ["stash", "list", "--format=%H"]);
  const stillListed =
    remaining === undefined
      ? undefined
      : remaining
          .split("\n")
          .map((line) => line.trim())
          .includes(stashRef);
  const droppedOther = reported !== undefined && reported !== stashRef;
  if (!droppedOther && stillListed !== true) return {};

  const text =
    `fleet ${fleet}: ${stashRef} was restored but the drop removed a different stash entry ` +
    `(${reported === undefined ? "git reported no sha" : reported})` +
    (stillListed === true ? `, which is still in \`git stash list\`` : "") +
    `; the operator's work was applied, so inspect \`git stash list\` in ${options.rootCwd} ` +
    "before dropping anything else";
  warnings.push(text);
  return { mismatch: text };
}

/**
 * Restore the stashed root immediately after the merge work.
 *
 * Applies the **recorded** stash sha, never `stash@{0}`: a stash the operator
 * pushed during a minutes-long gate run sits at position 0, so a positional pop
 * would restore (and then drop) their new work while stranding the real stash,
 * and the report would claim a ref that was never restored (CR-2). A recorded
 * stash that no longer resolves is a failure, not a pop.
 *
 * A conflicting apply cannot be left as conflict markers in the operator's
 * checkout, and it must not discard their work either: the partial application is
 * reset (git keeps the stash when an apply fails), so the caller can park the
 * fleet with the exact ref it has to restore.
 */
export async function restoreRecordedStash(
  options: RecordedStashRestore,
): Promise<RestoreRecordedStashResult> {
  const { stashRef, rootCwd, fleetId } = options;
  const warnings: string[] = [];

  // The checkout is verified before anything is touched: the recorded work must
  // land in *this* repository's root, on the branch it was stashed from.
  const root = await checkRootCheckout({
    rootCwd,
    baseBranch: options.baseBranch,
    gitCommonDir: options.gitCommonDir,
    git: options.git,
  });
  if (!root.ok && root.reason === "root-not-own-checkout") {
    return {
      ok: false,
      reason: "root-not-own-checkout",
      text:
        `${root.text}. The stashed root work is still at ${stashRef}; run the restore from the ` +
        `repository root (\`git stash apply ${stashRef}\`), or belayd_fleet_reconcile from there`,
      warnings,
    };
  }

  const resolved = await restoreGitOk(options, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${stashRef}^{commit}`,
  ]);
  if (resolved === undefined || resolved.trim() === "") {
    return {
      ok: false,
      reason: "unresolvable",
      text:
        `the recorded root stash ${stashRef} no longer resolves, so the operator's work was not ` +
        `restored; inspect \`git stash list\` in ${rootCwd} before continuing`,
      warnings,
    };
  }

  if (!root.ok) {
    return {
      ok: false,
      reason: "root-not-on-base",
      text:
        `${root.text}. The stashed root work is still at ${stashRef}; check out ` +
        `${options.baseBranch} and restore it by hand (\`git stash apply ${stashRef}\`)`,
      warnings,
    };
  }

  if (options.requireListed === true) {
    const listed = await restoreGitOk(options, ["stash", "list", "--format=%H"]);
    if (listed === undefined) {
      return {
        ok: false,
        reason: "unresolvable",
        text:
          `could not list \`git stash list\` in ${rootCwd}, so the recorded stash ${stashRef} ` +
          "cannot be proven still pending; it was not applied — inspect the root by hand",
        warnings,
      };
    }
    const listedShas = listed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (!listedShas.includes(stashRef)) {
      return {
        ok: false,
        reason: "already-restored",
        text:
          `${stashRef} is not in \`git stash list\` in ${rootCwd}: it was already restored or ` +
          "dropped, so it is not applied again — inspect the root for the work before continuing",
        warnings,
      };
    }
  }

  const applied = await restoreGitWithError(options, ["stash", "apply", stashRef]);
  if (applied.ok) {
    const drop = await dropRecordedStash(options, warnings);
    return {
      ok: true,
      warnings,
      ...(drop.mismatch === undefined ? {} : { dropMismatch: drop.mismatch }),
    };
  }

  // The apply failed (conflict). Keep the operator's work in the stash and return
  // the checkout to a clean, inspectable state.
  const reset = await restoreGitWithError(options, ["reset", "--hard", "HEAD"]);
  if (!reset.ok) {
    warnings.push(
      `fleet ${fleetId}: could not reset ${rootCwd} after the failed restore (${reset.error}); ` +
        "the checkout may contain conflict markers",
    );
  }
  return {
    ok: false,
    reason: "conflict",
    text:
      `could not restore the stashed root work from ${stashRef}: ${applied.error}. The work is ` +
      `still in the stash (${stashRef}); the fleet is parked until it is restored ` +
      `(\`git stash apply ${stashRef}\` in ${rootCwd}, or belayd_fleet_reconcile, then ` +
      "belayd_fleet_resume to unpark)",
    warnings,
  };
}

/**
 * Restore the stashed root as part of a drain, auditing the outcome.
 *
 * Thin adapter over {@link restoreRecordedStash}: the merge adds its own audit
 * entries and warning stream, while the git sequence (and the drop cross-check)
 * stays in the one shared implementation.
 */
async function restoreRootStash(context: MergeAttemptContext): Promise<RestoreOutcome> {
  const stashRef = context.stashRef;
  if (stashRef === undefined) return { conflict: false };

  const restored = await restoreRecordedStash({
    rootCwd: context.options.rootCwd,
    baseBranch: context.baseBranch,
    fleetId: context.options.fleetId,
    gitCommonDir: context.options.gitCommonDir,
    stashRef,
    git: context.git,
  });
  for (const warning of restored.warnings) context.warnings.push(warning);

  if (restored.ok) {
    if (restored.dropMismatch !== undefined) {
      auditAttempt(
        context,
        "merge-stash-drop-mismatch",
        [context.entry.taskId],
        restored.dropMismatch,
      );
    }
    auditAttempt(
      context,
      "merge-restore",
      [context.entry.taskId],
      `root restored from ${stashRef}`,
    );
    return { conflict: false };
  }
  auditAttempt(context, "merge-restore-conflict", [context.entry.taskId], restored.text);
  return { conflict: true, text: restored.text };
}

/**
 * Park the fleet in `fleet.json` (`paused` + the reason + the recorded stash).
 *
 * The mutation goes through the compare-and-replace path with the record read
 * *inside* the update (W5): this used to read then blind-write, so an operator
 * note or a prune that landed in between was silently lost. A record that is gone
 * is refused rather than recreated — the in-memory member list this drain holds may
 * be stale, and rewriting it would resurrect pruned members.
 *
 * `park.stashRef` is what makes recovery mechanical: reconcile retries the restore
 * from that exact sha, and `belayd_fleet_resume` clears the park once the work is
 * back in the checkout.
 */
function parkFleet(
  context: MergeAttemptContext,
  reason: string,
): { ok: true } | { ok: false; error: string } {
  const now = context.clock();
  const written = updateFleetIntent({
    gitCommonDir: context.options.gitCommonDir,
    fleetId: context.options.fleetId,
    fs: context.fs,
    update: (current) => {
      if (current === undefined) {
        return {
          refuse:
            `refusing to park fleet \`${context.options.fleetId}\`: its fleet.json is missing, ` +
            "so the in-memory member list may be stale; recreate/re-arm the fleet and park it " +
            "by hand",
        };
      }
      const note =
        current.note === undefined || current.note === "" ? reason : `${current.note} | ${reason}`;
      return {
        ...current,
        paused: true,
        note,
        park: {
          reason,
          ...(context.stashRef === undefined ? {} : { stashRef: context.stashRef }),
          recordedAt: now,
        },
        updatedAt: now,
      };
    },
  });
  if (!written.ok) return { ok: false, error: written.error };
  auditAttempt(context, "fleet-parked", [], reason);
  return { ok: true };
}

/** Send one supervisor → member note kind through the existing fan-out. */
function sendMergeNote(
  context: MergeAttemptContext,
  taskIds: readonly string[],
  kind: FleetNoteKind,
  body: string,
): readonly string[] {
  if (taskIds.length === 0) return [];
  const recipients = resolveFleetNoteRecipients({
    direction: "supervisor-to-member",
    to: FLEET_NOTE_BROADCAST,
    members: taskIds,
  });
  if (!recipients.ok) {
    context.warnings.push(
      `fleet ${context.options.fleetId}: ${kind} not sent: ${recipients.error}`,
    );
    return [];
  }
  const enqueued = enqueueNoteFanout({
    dir: fleetEventsDir(context.options.gitCommonDir, context.options.fleetId),
    note: buildFleetNote({
      kind,
      from: "supervisor",
      to: FLEET_NOTE_BROADCAST,
      body,
      now: context.clock(),
    }),
    recipients: recipients.recipients,
    fs: context.fs,
  });
  if (!enqueued.ok) {
    context.warnings.push(
      `fleet ${context.options.fleetId}: ${kind} partially sent to ` +
        `${enqueued.writtenRecipients.join(", ") || "nobody"} (${enqueued.error})`,
    );
    auditAttempt(context, kind, enqueued.writtenRecipients, `partial fan-out: ${enqueued.error}`);
    return enqueued.writtenRecipients;
  }
  auditAttempt(
    context,
    kind,
    enqueued.recipients,
    `sent to ${enqueued.recipients.length} member(s)`,
  );
  return enqueued.recipients;
}

/**
 * Resolve the branch a remaining member actually has checked out (W3).
 *
 * `feat/<taskId>` is only a convention: a member on another branch would get a
 * `rebase-hint` on every drain because the convention branch does not exist. The
 * worktree's own `.belayd/workflow.json` names its task id, so the branch is
 * looked up from git's worktree list instead of assumed. A member with no
 * resolvable branch is skipped — a hint about a branch that does not exist is
 * worse than none.
 */
function resolveMemberBranch(options: {
  context: MergeAttemptContext;
  taskId: string;
  worktrees: readonly WorktreeListEntry[];
}): string | undefined {
  const conventional = options.worktrees.find(
    (worktree) => worktree.branch === `feat/${options.taskId}`,
  );
  if (conventional !== undefined) return conventional.branch;

  const byState = options.worktrees.find(
    (worktree) => readWorktreeTaskId(options.context, worktree.path) === options.taskId,
  );
  return byState?.branch;
}

/** Task id recorded in a worktree's `.belayd/workflow.json`, or undefined. */
function readWorktreeTaskId(
  context: MergeAttemptContext,
  worktreePath: string,
): string | undefined {
  const statePath = join(worktreePath, ".belayd", "workflow.json");
  if (!context.fs.existsSync(statePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(context.fs.readFileSync(statePath));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const taskId = (parsed as { taskId?: unknown }).taskId;
    return typeof taskId === "string" && taskId !== "" ? taskId : undefined;
  } catch {
    return undefined;
  }
}

/** git's worktree list, or undefined (reported as a warning) when unreadable. */
async function listWorktreesForBroadcast(
  context: MergeAttemptContext,
): Promise<readonly WorktreeListEntry[] | undefined> {
  const listed = await gitWithError(
    context,
    ["worktree", "list", "--porcelain", "-z"],
    context.options.rootCwd,
  );
  if (!listed.ok) {
    context.warnings.push(
      `fleet ${context.options.fleetId}: could not list worktrees to resolve member branches ` +
        `(${listed.error}); rebase-hints were skipped`, // no branch to name honestly
    );
    return undefined;
  }
  return parseWorktreeListPorcelainZ(listed.stdout).entries;
}

/**
 * Base-moved propagation after a successful merge.
 *
 * Uses the existing per-recipient fan-out and the one addressing resolver, so
 * there is no second addressing path: every remaining member gets one
 * `base-moved` and one `sibling-landed`, and members whose branch does not yet
 * contain the new base commit also get a `rebase-hint`.
 */
async function broadcastBaseMoved(context: MergeAttemptContext): Promise<void> {
  const mergeCommit = context.mergeCommit;
  if (mergeCommit === undefined) return;
  const remaining = context.intent.taskIds.filter((taskId) => taskId !== context.entry.taskId);
  if (remaining.length === 0) return;

  const base = context.baseBranch;
  const merged = context.entry.taskId;
  const baseMoved = sendMergeNote(
    context,
    remaining,
    "base-moved",
    `${base} moved to ${mergeCommit.slice(0, 12)} after ${merged} merged. Rebase your branch ` +
      `onto ${base} before continuing.`,
  );
  const siblingLanded = sendMergeNote(
    context,
    remaining,
    "sibling-landed",
    `${merged} landed on ${base} (${mergeCommit.slice(0, 12)}). Your branch is unchanged; ` +
      "this is a premise update, not an instruction to merge.",
  );

  const worktrees = (await listWorktreesForBroadcast(context)) ?? [];
  const notBased: string[] = [];
  for (const taskId of remaining) {
    const branch = resolveMemberBranch({ context, taskId, worktrees });
    if (branch === undefined) continue;
    const contained = await context.git(["merge-base", "--is-ancestor", mergeCommit, branch], {
      cwd: context.options.rootCwd,
    });
    if (!contained.ok) notBased.push(taskId);
  }
  const rebaseHint = sendMergeNote(
    context,
    notBased,
    "rebase-hint",
    `${base} moved to ${mergeCommit.slice(0, 12)} and your branch does not contain it yet. ` +
      "Rebase onto the new base before your next phase.",
  );
  context.broadcast = { baseMoved, siblingLanded, rebaseHint };
}

/**
 * Re-check the selected entry after winning the lock.
 *
 * Two drains can select the same queued entry before either holds the lock; the
 * loser must not rebase/merge an entry the winner already completed. Only a
 * still-`queued` entry proceeds.
 */
function verifyEntryStillQueued(context: MergeAttemptContext): MergeCheckFailure | undefined {
  const loaded = readFleetMergeQueue({
    gitCommonDir: context.options.gitCommonDir,
    fleetId: context.options.fleetId,
    fs: context.fs,
  });
  if (!loaded.ok) return { reason: "queue-unreadable", text: loaded.error };
  const current = loaded.queue?.entries.find((entry) => entry.taskId === context.entry.taskId);
  if (current !== undefined && current.state === "queued") return undefined;
  return {
    reason: "entry-not-queued",
    text:
      `\`${context.entry.taskId}\` is no longer queued ` +
      `(state ${current?.state ?? "missing"}); another drain handled it`,
  };
}

/** Acquire the lock, or return the refusal text. */
function acquireForDrain(
  context: MergeAttemptContext,
): { ok: true } | { ok: false; failure: MergeCheckFailure } {
  const acquired = acquireFleetMerge({
    gitCommonDir: context.options.gitCommonDir,
    fleetId: context.options.fleetId,
    fs: context.fs,
    holder: context.options.sessionId,
    taskId: context.entry.taskId,
    pid: context.options.pid,
    now: context.clock(),
    ...(context.options.leaseInMs === undefined ? {} : { leaseInMs: context.options.leaseInMs }),
  });
  if (!acquired.ok) {
    return {
      ok: false,
      failure: {
        reason: "lock-unavailable",
        text: `could not acquire the single-flight merge lock: ${acquired.error}`,
      },
    };
  }
  auditAttempt(
    context,
    "merge-acquired",
    [context.entry.taskId],
    `lock acquired (${acquired.reason}); lease until ` +
      new Date(acquired.lock.leaseExpiresAt).toISOString(),
  );
  return { ok: true };
}

/** Renew the lease before a mutation; a lost lock aborts the merge. */
async function renewBeforeMutation(
  context: MergeAttemptContext,
): Promise<MergeCheckFailure | undefined> {
  const renewed = renewFleetMergeLease({
    gitCommonDir: context.options.gitCommonDir,
    fleetId: context.options.fleetId,
    fs: context.fs,
    holder: context.options.sessionId,
    taskId: context.entry.taskId,
    now: context.clock(),
    ...(context.options.leaseInMs === undefined ? {} : { leaseInMs: context.options.leaseInMs }),
  });
  if (!renewed.ok) {
    return {
      reason: "lock-unavailable",
      text: `lost the merge lock before a merge step (${renewed.error}); nothing further was run`,
    };
  }
  return undefined;
}

/** Rebase the member branch onto the base; refusals are returned, never thrown. */
async function rebaseMember(
  context: MergeAttemptContext,
  memberWorktree: string,
): Promise<MergeCheckFailure | undefined> {
  const transitioned = transitionEntry(context, "rebasing", undefined);
  if (!transitioned.ok) {
    return { reason: "queue-write-failed", text: transitioned.error };
  }
  const renewed = await renewBeforeMutation(context);
  if (renewed !== undefined) return renewed;

  const rebased = await gitWithError(context, ["rebase", context.baseBranch], memberWorktree);
  if (rebased.ok) return undefined;

  const aborted = await gitWithError(context, ["rebase", "--abort"], memberWorktree);
  if (!aborted.ok) {
    // A failed abort leaves the member mid-rebase; the next action would hit an
    // unexplained "rebase in progress" (W6), so say it here.
    context.warnings.push(
      `fleet ${context.options.fleetId}: could not abort the rebase in ${memberWorktree} ` +
        `(${aborted.error}); that worktree is probably still mid-rebase`,
    );
  }
  const text = `rebase of ${context.entry.branch} onto ${context.baseBranch} failed: ${rebased.error}`;
  auditAttempt(context, "merge-rebase-failed", [context.entry.taskId], text);
  return { reason: "rebase-failed", text };
}

/** Run the project's gates against the rebased member worktree. */
async function runMergeGates(
  context: MergeAttemptContext,
  memberWorktree: string,
): Promise<MergeCheckFailure | undefined> {
  const gates = readFleetGateCommands({ rootCwd: context.options.rootCwd, fs: context.fs });
  if (!gates.ok) {
    const text = `merge gates unavailable: ${gates.error}`;
    auditAttempt(context, "merge-gate-failed", [context.entry.taskId], text);
    return { reason: "gate-commands-missing", text };
  }
  const transitioned = transitionEntry(context, "gating", undefined);
  if (!transitioned.ok) {
    return { reason: "queue-write-failed", text: transitioned.error };
  }
  const renewed = await renewBeforeMutation(context);
  if (renewed !== undefined) return renewed;

  const gateRunner = context.options.runGate ?? defaultFleetMergeGateRunner;
  for (const gate of gates.commands) {
    // Renew between gates (W2): a full suite can outlast one lease, and a live
    // holder taken over mid-gates interleaves its stash/restore with this one.
    const renewed = await renewBeforeMutation(context);
    if (renewed !== undefined) return renewed;
    const result = await gateRunner({
      name: gate.name,
      script: gate.script,
      cwd: memberWorktree,
      runner: gates.runner,
    });
    if (!result.ok) {
      const text = `gate \`${gates.runner} run ${gate.name}\` failed on the rebased result: ${result.error}`;
      auditAttempt(context, "merge-gate-failed", [context.entry.taskId], text);
      return { reason: "gate-failed", text };
    }
  }
  context.gateNames = gates.commands.map((gate) => gate.name);
  return undefined;
}

/** Fast-forward the root checkout to the rebased member branch. */
async function mergeMember(context: MergeAttemptContext): Promise<MergeCheckFailure | undefined> {
  const transitioned = transitionEntry(context, "merging", undefined);
  if (!transitioned.ok) {
    return { reason: "queue-write-failed", text: transitioned.error };
  }
  const renewed = await renewBeforeMutation(context);
  if (renewed !== undefined) return renewed;

  // CR-1: `merge --ff-only` fast-forwards whatever HEAD is checked out, and the
  // root may have been switched during the gates. Re-verify immediately before.
  const onBase = await verifyRootOnBase(context);
  if (onBase !== undefined) return onBase;

  const merged = await gitWithError(
    context,
    ["merge", "--ff-only", context.entry.branch],
    context.options.rootCwd,
  );
  if (!merged.ok) {
    const text = `merge of ${context.entry.branch} into ${context.baseBranch} failed: ${merged.error}`;
    auditAttempt(context, "merge-failed", [context.entry.taskId], text);
    return { reason: "merge-failed", text };
  }
  const head = await gitOk(context, ["rev-parse", "HEAD"], context.options.rootCwd);
  context.mergeCommit = head?.trim() ?? "";
  return undefined;
}

/** Release the lock and collect any warning; never throws. */
function releaseForDrain(context: MergeAttemptContext): void {
  const released = releaseFleetMerge({
    gitCommonDir: context.options.gitCommonDir,
    fleetId: context.options.fleetId,
    fs: context.fs,
    holder: context.options.sessionId,
    now: context.clock(),
  });
  if (!released.ok) {
    context.warnings.push(
      `fleet ${context.options.fleetId}: could not release the merge lock (${released.error}); ` +
        "it becomes acquirable when its lease expires",
    );
    return;
  }
  if (!released.released) return;
  for (const warning of released.warnings) context.warnings.push(warning);
  auditAttempt(
    context,
    "merge-released",
    [context.entry.taskId],
    "lock released after the merge attempt",
  );
}

export interface RenderFleetMergeDrainOptions {
  fleetId: string;
  taskId: string;
  branch: string;
  baseBranch: string;
  mergeCommit: string;
  gateNames: readonly string[];
  stashRef?: string;
  broadcast: FleetMergeBroadcast;
}

/** Render a successful drain. Merging is stated as not closing the bead. */
export function formatFleetMergeDrainReport(options: RenderFleetMergeDrainOptions): string {
  const lines = [
    `Fleet \`${options.fleetId}\`: merged ${options.taskId} (${options.branch}) into ` +
      `${options.baseBranch} at ${options.mergeCommit.slice(0, 12)}.`,
  ];
  if (options.gateNames.length > 0) {
    lines.push(`- gates passed on the rebased result: ${options.gateNames.join(", ")}`);
  }
  if (options.stashRef !== undefined) {
    lines.push(`- root work was stashed and restored (${options.stashRef})`);
  }
  const notified = [
    options.broadcast.baseMoved.length > 0
      ? `base-moved → ${options.broadcast.baseMoved.join(", ")}`
      : undefined,
    options.broadcast.siblingLanded.length > 0
      ? `sibling-landed → ${options.broadcast.siblingLanded.join(", ")}`
      : undefined,
    options.broadcast.rebaseHint.length > 0
      ? `rebase-hint → ${options.broadcast.rebaseHint.join(", ")}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  if (notified.length > 0) lines.push(`- notified members: ${notified.join("; ")}`);
  lines.push(
    `${options.taskId} stays in_progress + human: merging is not closing. Accept it with ` +
      "`wt merge` / bd when you are ready.",
  );
  return lines.join("\n");
}

/** Build the selectable queue entry (explicit id, else the oldest queued). */
function selectQueuedEntry(
  queue: FleetMergeQueue,
  taskId: string | undefined,
): FleetMergeQueueEntry | undefined {
  const queued = queue.entries.filter((entry) => entry.state === "queued");
  if (taskId !== undefined) return queued.find((entry) => entry.taskId === taskId);
  return [...queued].sort((left, right) => {
    if (left.requestedAt !== right.requestedAt) return left.requestedAt - right.requestedAt;
    return left.taskId < right.taskId ? -1 : 1;
  })[0];
}

/** Everything the side effects need, or an early refusal result. */
type PreparedDrain =
  | { ok: true; context: MergeAttemptContext }
  | { ok: false; result: DrainFleetMergeResult };

function drainFailure(options: {
  reason: FleetMergeFailureReason;
  text: string;
  taskId?: string;
  parked?: boolean;
  warnings: readonly string[];
}): DrainFleetMergeResult {
  return {
    ok: false,
    reason: options.reason,
    text: options.text,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    parked: options.parked ?? false,
    warnings: options.warnings,
  };
}

/**
 * Read intent + queue and select the entry to drain. No mutation happens here:
 * a paused fleet, an unreadable record, or an empty queue is returned before a
 * lock is even considered.
 */
function prepareDrainContext(
  options: DrainFleetMergeOptions,
  fs: FleetStateFs,
  git: FleetMergeGitRunner,
  clock: () => number,
): PreparedDrain {
  const intentLoaded = readFleetIntent({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!intentLoaded.ok) {
    return {
      ok: false,
      result: drainFailure({
        reason: "intent-unreadable",
        text: `could not read the fleet intent: ${intentLoaded.error}`,
        warnings: [],
      }),
    };
  }
  const intent = intentLoaded.intent;
  if (intent === undefined) {
    return {
      ok: false,
      result: drainFailure({
        reason: "intent-unreadable",
        text: `no fleet intent for \`${options.fleetId}\`; run /fleet first`,
        warnings: [],
      }),
    };
  }
  if (intent.paused === true) {
    return {
      ok: false,
      result: drainFailure({
        reason: "fleet-paused",
        text:
          `fleet \`${options.fleetId}\` is paused` +
          (intent.note === undefined ? "" : ` (${intent.note})`) +
          "; resume it before merging",
        parked: true,
        warnings: [],
      }),
    };
  }

  const queueLoaded = readFleetMergeQueue({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!queueLoaded.ok) {
    return {
      ok: false,
      result: drainFailure({
        reason: "queue-unreadable",
        text: `could not read the merge queue: ${queueLoaded.error}`,
        warnings: [],
      }),
    };
  }
  const queue = queueLoaded.queue;
  const entry = queue === undefined ? undefined : selectQueuedEntry(queue, options.taskId);
  if (entry === undefined) {
    return {
      ok: false,
      result: drainFailure({
        reason: "no-queued-entry",
        text:
          options.taskId === undefined
            ? "nothing is queued for merge"
            : `\`${options.taskId}\` is not queued for merge (queue it with action enqueue first)`,
        warnings: [],
      }),
    };
  }

  return {
    ok: true,
    context: {
      options,
      fs,
      git,
      intent,
      baseBranch: intent.baseBranch ?? "main",
      entry,
      clock,
      warnings: [],
      broadcast: { baseMoved: [], siblingLanded: [], rebaseHint: [] },
    },
  };
}

/** Refuse after the entry was selected but before any repository mutation. */
function drainRefusal(
  context: MergeAttemptContext,
  failure: MergeCheckFailure,
): DrainFleetMergeResult {
  return drainFailure({
    reason: failure.reason,
    text: failure.text,
    taskId: context.entry.taskId,
    warnings: context.warnings,
  });
}

/**
 * Failure finish: mark the entry failed, restore the stashed root (parking the
 * fleet if the restore conflicts), release the lock, and report honestly. Shared
 * by the stash-step failure and the sequence failure so both leave the same
 * invariants behind.
 */
async function finishFailedDrain(
  context: MergeAttemptContext,
  failure: MergeCheckFailure,
): Promise<DrainFleetMergeResult> {
  const transitioned = transitionEntry(context, "failed", failure.text);
  if (!transitioned.ok) context.warnings.push(transitioned.error);

  const restore = await restoreRootStash(context);
  let parked = false;
  // The primary refusal stays the reason: it is the cause the operator acts on,
  // and a restore conflict is reported in the text plus `parked` (CR-1's refusal
  // must stay distinguishable from a hostile root restore).
  const reason = failure.reason;
  let text = failure.text;
  if (restore.conflict) {
    const parkedResult = parkFleet(context, restore.text ?? "root restore conflicted");
    parked = parkedResult.ok;
    text = `${failure.text}\n${restore.text ?? ""}`;
    if (!parkedResult.ok) context.warnings.push(parkedResult.error);
  }
  releaseForDrain(context);
  return {
    ok: false,
    reason,
    text,
    taskId: context.entry.taskId,
    ...(context.stashRef === undefined ? {} : { stashRef: context.stashRef }),
    parked,
    warnings: context.warnings,
  };
}

/**
 * Success finish: `merged` state, `merge-completed` audit, root restore (parking
 * on conflict), base-moved broadcast, lock release. The report always states
 * that merging is not closing.
 */
async function finishSuccessfulDrain(context: MergeAttemptContext): Promise<DrainFleetMergeResult> {
  const entry = context.entry;
  const mergeCommit = context.mergeCommit ?? "";
  const mergedTransition = transitionEntry(context, "merged", undefined);
  if (!mergedTransition.ok) context.warnings.push(mergedTransition.error);
  auditAttempt(
    context,
    "merge-completed",
    [entry.taskId],
    `merged ${entry.branch} into ${context.baseBranch} at ${mergeCommit}`,
  );

  const restore = await restoreRootStash(context);
  let parked = false;
  if (restore.conflict) {
    const parkedResult = parkFleet(context, restore.text ?? "root restore conflicted");
    parked = parkedResult.ok;
    if (!parkedResult.ok) context.warnings.push(parkedResult.error);
  }
  await broadcastBaseMoved(context);
  releaseForDrain(context);

  if (restore.conflict) {
    return {
      ok: false,
      reason: "restore-conflict",
      text:
        `merged ${entry.taskId} into ${context.baseBranch} at ${mergeCommit.slice(0, 12)}, but ` +
        `${restore.text ?? "restoring the root work conflicted"}`,
      taskId: entry.taskId,
      ...(context.stashRef === undefined ? {} : { stashRef: context.stashRef }),
      parked,
      warnings: context.warnings,
    };
  }

  const gateCommands = readFleetGateCommands({ rootCwd: context.options.rootCwd, fs: context.fs });
  const gateNames =
    context.gateNames ?? (gateCommands.ok ? gateCommands.commands.map((gate) => gate.name) : []);
  return {
    ok: true,
    taskId: entry.taskId,
    text: formatFleetMergeDrainReport({
      fleetId: context.options.fleetId,
      taskId: entry.taskId,
      branch: entry.branch,
      baseBranch: context.baseBranch,
      mergeCommit,
      gateNames,
      ...(context.stashRef === undefined ? {} : { stashRef: context.stashRef }),
      broadcast: context.broadcast,
    }),
    mergeCommit,
    ...(context.stashRef === undefined ? {} : { stashRef: context.stashRef }),
    broadcast: context.broadcast,
    warnings: context.warnings,
  };
}

/**
 * Drain one merge: acquire, precondition, rebase -> gates -> merge -> broadcast,
 * restore the root, release.
 *
 * The failure paths are the contract: a failed attempt leaves the root on the
 * base branch with no silently discarded stash, releases the lock, leaves the
 * member worktree's commits intact (a failed rebase is aborted; a gate failure
 * leaves the rebased branch unmerged rather than half-merged), and returns a
 * reason. The only repo mutation that can outlive a failure is the member's
 * rebase onto the base, which is content-preserving and reported.
 */
export async function drainFleetMerge(
  options: DrainFleetMergeOptions,
): Promise<DrainFleetMergeResult> {
  const fs = options.fs ?? nodeFsSeam;
  const git = options.git ?? defaultFleetMergeGitRunner;
  // W1: one `now` snapshot for a drain that runs for minutes would stamp every
  // renewal and audit entry with the start time. The live clock is the default
  // here because this function is the effectful layer; tests inject a fake.
  const clock = options.clock ?? Date.now;

  const prepared = prepareDrainContext(options, fs, git, clock);
  if (!prepared.ok) return prepared.result;
  const context = prepared.context;

  const preconditions = await checkMergePreconditions(context);
  if ("reason" in preconditions) return drainRefusal(context, preconditions);

  const acquired = acquireForDrain(context);
  if (!acquired.ok) return drainRefusal(context, acquired.failure);

  const stillQueued = verifyEntryStillQueued(context);
  if (stillQueued !== undefined) {
    releaseForDrain(context);
    return drainRefusal(context, stillQueued);
  }

  const stashed = await stashRootIfDirty(context);
  if (stashed !== undefined) return finishFailedDrain(context, stashed);

  const failed = await attemptMergeSequence(context, preconditions.memberWorktree);
  if (failed !== undefined) return finishFailedDrain(context, failed);

  return finishSuccessfulDrain(context);
}

/** Steps after the lock is held; the first failure wins. */
async function attemptMergeSequence(
  context: MergeAttemptContext,
  memberWorktree: string,
): Promise<MergeCheckFailure | undefined> {
  const rebased = await rebaseMember(context, memberWorktree);
  if (rebased !== undefined) return rebased;
  const gated = await runMergeGates(context, memberWorktree);
  if (gated !== undefined) return gated;
  return mergeMember(context);
}
