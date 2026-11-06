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
import { isAbsolute, join, resolve } from "node:path";
import {
  buildFleetNote,
  FLEET_NOTE_BROADCAST,
  resolveFleetNoteRecipients,
} from "./fleet-mailbox.js";
import {
  classifyGeneratedPath,
  classifyRebaseFailure,
  type FleetRebaseClass,
  formatRebasePathList,
  parseConflictedPaths,
  type RebaseCommitFact,
  type RebaseConflictedPath,
  rebaseConflictText,
} from "./fleet-rebase-recovery.js";
import type { FleetMemberClaim } from "./fleet-run.js";
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
import type { ProofArtifactPolicy } from "./proof-policy.js";
import { DEFAULT_PROOF_ARTIFACT_POLICY, readRepoProofPolicy } from "./proof-policy.js";
import { evaluatePublishGate, isProofArtifactPathInDiff } from "./publish-gate.js";
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

  // `delegatedAt` is deliberately not carried over: enqueueing again is the
  // retry that a delegation was waiting for, so its no-new-information marker
  // must not survive it (bd-280).
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

/**
 * How long a delegated rebase may go unanswered before the member is stopped.
 *
 * A delegation deliberately records no stop, so nothing else bounds the wait: a
 * live member that never rebases would leave the run landing forever. After this
 * grace the person is the only one left who can decide, which is exactly the case
 * a `land-failed` stop (and its bd-279 escalation gate) exists for.
 */
export const FLEET_REBASE_DELEGATION_GRACE_MS = 30 * 60 * 1000;

/** Facts the regeneration step needs; the seam receives them instead of reading. */
export interface FleetMergeRegenerateOptions {
  /** The member worktree the rebase is stopped in: regeneration runs there. */
  cwd: string;
  /** Generated paths that were conflicted and are now taken from the base side. */
  paths: readonly string[];
  /** Package manager the merge target declares (S1); never assumed to be pnpm. */
  runner: FleetGateRunnerName;
  /** Any conflicted path is a lockfile, so dependencies must be reinstalled. */
  installRequired: boolean;
  /** Any conflicted path is a build/derived tree, so the project must be rebuilt. */
  buildRequired: boolean;
  /** Whether the merge target declares the `build` script a rebuild needs. */
  hasBuildScript: boolean;
}

/**
 * Regeneration seam for a rebase whose only conflicts were generated paths
 * (bd-280). Injected so unit tests never run a package manager.
 */
export type FleetMergeRegenerateRunner = (
  options: FleetMergeRegenerateOptions,
) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * Default regeneration: reinstall the lockfile and/or rebuild the derived tree.
 *
 * The base side of a generated path is the truth (it was produced by a landed
 * member or by the base itself), so the artifact is recreated from the base's
 * manifest rather than merged. Snapshots alone need no command: their base side
 * is taken and the project's own gates decide whether it is still correct.
 */
export const defaultFleetMergeRegenerateRunner: FleetMergeRegenerateRunner = async (options) => {
  if (options.installRequired) {
    const installed = await runFileCommand(options.runner, ["install"], {
      cwd: options.cwd,
      env: gitContextFreeEnv(),
    });
    if (!installed.ok) {
      return {
        ok: false,
        error: `\`${options.runner} install\` failed: ${commandError(installed)}`,
      };
    }
  }
  if (!options.buildRequired) return { ok: true };
  if (!options.hasBuildScript) {
    return {
      ok: false,
      error: "the merge target declares no `build` script to regenerate the derived tree",
    };
  }
  const built = await runFileCommand(options.runner, ["run", "build"], {
    cwd: options.cwd,
    env: gitContextFreeEnv(),
  });
  return built.ok
    ? { ok: true }
    : { ok: false, error: `\`${options.runner} run build\` failed: ${commandError(built)}` };
};

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
  /**
   * Regenerate derived content for a rebase that only conflicts on it (bd-280).
   * Defaults to {@link defaultFleetMergeRegenerateRunner}.
   */
  regenerate?: FleetMergeRegenerateRunner;
  /**
   * The member's orchestrator lease as the *tick* observed it (bd-280).
   *
   * Only classification reads it, and only to decide whether a resolvable
   * conflict can be delegated to the member instead of stopping the fleet. Caveat:
   * it is a snapshot from before the drain, and a drain can outlast it — a lease
   * that dies mid-drain still gets the note, which a dead member's next
   * orchestrator will read.
   */
  memberLease?: FleetMemberClaim;
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
  // bd-181: the publish payload is refused rather than carried (proof must be
  // uploaded, never published as files).
  | "proof-artifacts-in-diff"
  | "paths-outside-scope"
  | "publish-payload-unreadable"
  | "stash-failed"
  | "rebase-failed"
  // bd-280: the rebase conflict is resolvable by the member's own orchestrator,
  // so the drain asked it to rebase instead of stopping it for a human.
  | "rebase-delegated"
  // A merge-step seam threw instead of returning a value. Defined so a throwing
  // seam cannot turn into an unhandled rejection that leaks the merge lock.
  | "step-failed"
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
      /**
       * Complete offending path list, sorted. `text` is bounded to one readable
       * line; callers that render a report must use this field to show every path.
       * Carried by a publish refusal *and* by a rebase conflict (bd-280).
       */
      paths?: readonly string[];
      /**
       * Set when a rebase conflict was delegated to the member's own orchestrator
       * (bd-280). It carries the complete conflicted path list so the caller can
       * report and record it even though `text` is bounded. The member is not
       * stopped, so the caller must not record one.
       */
      delegated?: { taskId: string; paths: readonly string[] };
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
  /**
   * Whether the lock was already released, so the release is idempotent.
   *
   * The drain's `finally` releases it as a belt for a throwing seam; without this
   * the finishers' own release would then run twice.
   */
  lockReleased: boolean;
  stashRef?: string;
  mergeCommit?: string;
  gateNames?: readonly string[];
  broadcast: FleetMergeBroadcast;
  /**
   * Whether `merge-completed` has been written for this drain attempt (bd-280).
   *
   * A per-attempt marker, deliberately not derived from the queue entry: the queue
   * writes are best-effort (each failure is a warning), so an entry still reading
   * `rebasing` says nothing about whether the landed audit was written — keying the
   * audit on it both duplicated the entry (the `merged` transition failed, then a
   * later step threw) and lost it (the audit append failed, the entry was `merged`
   * and the landed arm skipped). This flag records what this attempt actually did;
   * it is set only when the append succeeded, so a failed append can be retried by
   * the landed arm. See {@link auditMergeCompletedOnce}.
   */
  mergeCompletionAudited: boolean;
}

interface MergeCheckFailure {
  reason: FleetMergeFailureReason;
  text: string;
  /** Offending paths when the refusal is path-shaped (publish or rebase gate). */
  paths?: readonly string[];
  /** Set when a rebase conflict was handed to the member instead of stopping it. */
  delegated?: { taskId: string; paths: readonly string[] };
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

/** One line from a thrown (rather than returned) seam failure. */
function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
): boolean {
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
  if (warning === undefined) return true;
  context.warnings.push(warning);
  return false;
}

/**
 * Pure next state of a queue entry.
 *
 * A rebasing transition counts a new attempt; a rebasing/merged transition also
 * clears a stale failure message so a recovered entry does not keep reporting
 * the previous attempt's error. A rebasing transition drops `delegatedAt` too:
 * rebasing again means the delegation that parked the previous attempt was
 * answered, so its no-new-information window must not survive it.
 */
function nextEntryState(options: {
  entry: FleetMergeQueueEntry;
  state: FleetMergeEntryState;
  lastError: string | undefined;
  now: number;
  delegatedAt?: number;
}): FleetMergeQueueEntry {
  const entry = options.entry;
  const clearsError = options.state === "rebasing" || options.state === "merged";
  const error = clearsError ? undefined : options.lastError;
  const delegatedAt =
    options.state === "rebasing" ? undefined : (options.delegatedAt ?? entry.delegatedAt);
  // Rebuilt field by field: a spread of `entry` would keep a `delegatedAt` the
  // rebasing transition is supposed to drop.
  return {
    taskId: entry.taskId,
    branch: entry.branch,
    requestedAt: entry.requestedAt,
    state: options.state,
    attempts: options.state === "rebasing" ? entry.attempts + 1 : entry.attempts,
    updatedAt: options.now,
    ...(error === undefined ? {} : { lastError: error }),
    ...(delegatedAt === undefined ? {} : { delegatedAt }),
  };
}

/**
 * Update one queue entry's state.
 *
 * A CAS conflict is retried once against the newer queue: the transition is
 * small and idempotent, and losing a state update silently would make the
 * operator's view of the merge wrong while the repository already moved.
 */
function transitionEntry(options: {
  context: MergeAttemptContext;
  state: FleetMergeEntryState;
  lastError: string | undefined;
  delegatedAt?: number;
}): { ok: true } | { ok: false; error: string } {
  const context = options.context;
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
              ? nextEntryState({
                  entry,
                  state: options.state,
                  lastError: options.lastError,
                  now,
                  ...(options.delegatedAt === undefined
                    ? {}
                    : { delegatedAt: options.delegatedAt }),
                })
              : entry,
          ),
        };
      },
    });

  let written = update();
  if (!written.ok && written.reason === "conflict") written = update();
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}

export type MemberBranchBaseVerdict = { ok: true; based: boolean } | { ok: false; error: string };

/**
 * Whether a member branch already contains the base branch (bd-280).
 *
 * Compared by shas — `merge-base <base> <branch>` against the base's own commit —
 * rather than `merge-base --is-ancestor`'s exit code, because this module's git
 * seams return failures as values: an exit code that means "not an ancestor" is
 * indistinguishable from a real git failure, and the caller would then retry a
 * merge against a base the member still has not caught up with.
 *
 * The two `rev-parse --verify` probes are what make "unknown" expressible: a
 * missing branch or base must not look like "not based", because the caller's
 * guard only holds back a *proven* stale branch.
 */
export async function checkMemberBranchContainsBase(options: {
  cwd: string;
  baseBranch: string;
  branch: string;
  git: FleetMergeGitRunner;
}): Promise<MemberBranchBaseVerdict> {
  const base = await options.git(
    ["rev-parse", "--verify", "--quiet", `${options.baseBranch}^{commit}`],
    { cwd: options.cwd },
  );
  if (!base.ok) return { ok: false, error: commandError(base) };
  const baseSha = base.stdout.trim();
  if (baseSha === "") {
    return { ok: false, error: `could not resolve ${options.baseBranch} in ${options.cwd}` };
  }

  const branch = await options.git(
    ["rev-parse", "--verify", "--quiet", `${options.branch}^{commit}`],
    { cwd: options.cwd },
  );
  if (!branch.ok) return { ok: false, error: commandError(branch) };
  if (branch.stdout.trim() === "") {
    return { ok: false, error: `could not resolve ${options.branch} in ${options.cwd}` };
  }

  const mergeBase = await options.git(["merge-base", options.baseBranch, options.branch], {
    cwd: options.cwd,
  });
  if (!mergeBase.ok) return { ok: false, error: commandError(mergeBase) };
  return { ok: true, based: mergeBase.stdout.trim() === baseSha };
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

/**
 * Refuse a branch whose payload carries proof (bd-181).
 *
 * Proof artifacts are uploaded, never committed, so a diff that adds or
 * modifies them is exactly what the publish transition must not carry. Deleting
 * proof artifacts is *allowed* and is the documented migration path: upload the
 * proof, keep the receipt at `.belayd/proof-receipt.json`, remove the in-tree
 * files. The diff is therefore read with `--diff-filter=ACMRT`, which excludes
 * deletions and leaves added/copied/modified/renamed/type-changed entries — a
 * rename is classified by its destination path, so moving proof content out of
 * a proof directory into a source path is still refused.
 *
 * The check runs after the preconditions and before the lock, the root stash and
 * the rebase: a refusal must not mutate anything.
 *
 * The diff is branch-scoped (`<base>...<branch>`), so proof directories that
 * already landed in history are untouched and are deliberately *not* migrated:
 * this only stops proof from being carried in, never its removal.
 *
 * No `intendedPaths` is passed because the drain has no declared payload — the
 * publish executor (bd-174.3) will pass its own set to `evaluatePublishGate`.
 */
async function checkPublishPayload(
  context: MergeAttemptContext,
): Promise<MergeCheckFailure | undefined> {
  // `-z` + `core.quotePath=false` are both required: git C-quotes non-ASCII and
  // space-containing paths in its default `--name-only` output, and a quoted
  // literal (`"docs/proof/x/caf\303\251.png"`) matches neither a proof-directory
  // prefix nor a proof extension, so proof would merge through the gate.
  //
  // `--diff-filter=ACMRT` drops deletions from the payload: proof that is
  // *added or modified* is refused, while *deleting* proof artifacts is the
  // documented migration path (upload it, keep the receipt, remove the files)
  // and must merge. A rename out of a proof directory still counts — it is
  // reported as `R` and `--name-only` emits the destination path, which is
  // what the gate classifies; the source path no longer exists in the result.
  // `--name-status` is deliberately avoided: its `-z` output interleaves a
  // status letter with each path and would break the plain NUL-split below.
  const diff = await gitWithError(
    context,
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=ACMRT",
      `${context.baseBranch}...${context.entry.branch}`,
    ],
    context.options.rootCwd,
  );
  if (!diff.ok) {
    // Fail closed: an unreadable payload cannot be proven proof-free.
    return {
      reason: "publish-payload-unreadable",
      text: `could not read the publish payload of ${context.entry.branch}: ${diff.error}`,
    };
  }

  const changedPaths = diff.stdout.split("\0").filter((path) => path !== "");
  const gate = evaluatePublishGate({
    changedPaths,
    proofPolicy: resolveProofPolicy(context, changedPaths),
  });
  if (!gate.ok) return { reason: gate.reason, text: gate.text, paths: gate.paths };
  if (gate.proofArtifacts !== undefined) {
    // Carrying proof past the gate is a repo policy decision, so it is reported on
    // every landing it affects instead of happening silently (bd-276).
    context.warnings.push(
      `carried ${gate.proofArtifacts.length} proof artifact path(s) under the repo ` +
        `policy proof.artifacts=in-tree: ${gate.proofArtifacts.join(", ")}`,
    );
  }
  return undefined;
}

/**
 * The proof policy this payload is judged by (bd-276).
 *
 * Only read when the payload actually carries a proof path: a repo with no proof
 * in flight never pays a config read, and an existing test's fs seam never has to
 * answer for a file the contract did not ask about. When it is read, the repo's
 * live declaration is the truth (not a value frozen into the intent at launch), so
 * a repo that declares the policy mid-run unblocks the work already in flight.
 */
function resolveProofPolicy(
  context: MergeAttemptContext,
  changedPaths: readonly string[],
): ProofArtifactPolicy {
  if (!changedPaths.some(isProofArtifactPathInDiff)) return DEFAULT_PROOF_ARTIFACT_POLICY;
  const read = readRepoProofPolicy({ repoRoot: context.options.rootCwd, fs: context.fs });
  context.warnings.push(...read.warnings);
  return read.policy;
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

/**
 * Send one supervisor → member note kind through the existing fan-out.
 *
 * `auditNote` is appended to the audit detail so a decision that was not a plain
 * per-branch probe (an unreadable base commit hinting everyone, bd-280 S8) is
 * visible in `audit.log`, not only in the note bodies.
 */
function sendMergeNote(
  context: MergeAttemptContext,
  taskIds: readonly string[],
  kind: FleetNoteKind,
  body: string,
  auditNote?: string,
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
    auditAttempt(
      context,
      kind,
      enqueued.writtenRecipients,
      withAuditNote(`partial fan-out: ${enqueued.error}`, auditNote),
    );
    return enqueued.writtenRecipients;
  }
  auditAttempt(
    context,
    kind,
    enqueued.recipients,
    withAuditNote(`sent to ${enqueued.recipients.length} member(s)`, auditNote),
  );
  return enqueued.recipients;
}

/** `detail` plus an optional reason, so a plain send keeps its exact old wording. */
function withAuditNote(detail: string, note: string | undefined): string {
  return note === undefined ? detail : `${detail}; ${note}`;
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
 *
 * Recipients are recorded in `context.broadcast` as soon as their note file is
 * written, and every send is narrowed to the recipients **not** recorded yet, so a
 * fan-out that threw or stopped on one member's unwritable directory (the
 * landed-but-threw arm retries it, bd-280 S5) resumes with exactly the missing
 * members: nobody is sent a second file, and nobody is skipped because a sibling
 * got theirs (bd-280 S7).
 */
async function broadcastBaseMoved(context: MergeAttemptContext): Promise<void> {
  const mergeCommit = context.mergeCommit;
  if (mergeCommit === undefined) return;
  const remaining = context.intent.taskIds.filter((taskId) => taskId !== context.entry.taskId);
  if (remaining.length === 0) return;

  const base = context.baseBranch;
  const merged = context.entry.taskId;
  // A note names the commit the members should contain, so an unreadable HEAD (a seam
  // threw between the merge and the `rev-parse`) must still read as a move, not as an
  // empty sha.
  const sha = mergeCommit === "" ? "a new commit" : mergeCommit.slice(0, 12);
  const baseMovedDue = notYetSent(context, "baseMoved", remaining);
  if (baseMovedDue.length > 0) {
    const written = sendMergeNote(
      context,
      baseMovedDue,
      "base-moved",
      `${base} moved to ${sha} after ${merged} merged. Rebase your branch ` +
        `onto ${base} before continuing.`,
    );
    context.broadcast = {
      ...context.broadcast,
      baseMoved: [...context.broadcast.baseMoved, ...written],
    };
  }

  const siblingLandedDue = notYetSent(context, "siblingLanded", remaining);
  if (siblingLandedDue.length > 0) {
    const written = sendMergeNote(
      context,
      siblingLandedDue,
      "sibling-landed",
      `${merged} landed on ${base} (${sha}). Your branch is unchanged; ` +
        "this is a premise update, not an instruction to merge.",
    );
    context.broadcast = {
      ...context.broadcast,
      siblingLanded: [...context.broadcast.siblingLanded, ...written],
    };
  }

  const hintDue = notYetSent(context, "rebaseHint", remaining);
  if (hintDue.length === 0) return;
  const probe = await membersBehindBase({ context, taskIds: hintDue, mergeCommit });
  if (probe.basis !== undefined) context.warnings.push(probe.basis);
  if (probe.behind.length === 0) return;
  const written = sendMergeNote(
    context,
    probe.behind,
    "rebase-hint",
    `${base} moved to ${sha} and your branch does not contain it yet. ` +
      "Rebase onto the new base before your next phase.",
    probe.unreadableBaseCommit
      ? "the merge commit was unreadable, so every remaining member was hinted"
      : undefined,
  );
  context.broadcast = {
    ...context.broadcast,
    rebaseHint: [...context.broadcast.rebaseHint, ...written],
  };
}

/** `taskIds` minus the ones whose note file for `kind` is already recorded. */
function notYetSent(
  context: MergeAttemptContext,
  kind: "baseMoved" | "siblingLanded" | "rebaseHint",
  taskIds: readonly string[],
): readonly string[] {
  const sent = context.broadcast[kind];
  return taskIds.filter((taskId) => !sent.includes(taskId));
}

/**
 * Which of `taskIds` do not contain `mergeCommit` yet (bd-280).
 *
 * An unreadable merge commit is named rather than probed: `merge-base --is-ancestor
 * "" <branch>` fails for every member, so the per-member probe would turn a git
 * error into "everyone gets a rebase-hint" by accident (bd-280 S8). The explicit
 * branch hints the whole set, skips the probe (and the worktree listing it needs),
 * and returns the sentence that becomes both a warning on the result and the audit
 * detail's note, so the reason is visible to the operator and to a log reader.
 */
async function membersBehindBase(options: {
  context: MergeAttemptContext;
  taskIds: readonly string[];
  mergeCommit: string;
}): Promise<{
  behind: readonly string[];
  unreadableBaseCommit: boolean;
  /** Why the whole set was hinted; a warning on the drain result. */
  basis?: string;
}> {
  const context = options.context;
  if (options.mergeCommit === "") {
    return {
      behind: options.taskIds,
      unreadableBaseCommit: true,
      basis:
        `fleet ${context.options.fleetId}: the merge commit could not be read, so every ` +
        `remaining member was sent a rebase-hint instead of probing its branch`,
    };
  }
  const worktrees = (await listWorktreesForBroadcast(context)) ?? [];
  const behind: string[] = [];
  for (const taskId of options.taskIds) {
    const branch = resolveMemberBranch({ context, taskId, worktrees });
    if (branch === undefined) continue;
    const contained = await context.git(
      ["merge-base", "--is-ancestor", options.mergeCommit, branch],
      { cwd: context.options.rootCwd },
    );
    if (!contained.ok) behind.push(taskId);
  }
  return { behind, unreadableBaseCommit: false };
}

/**
 * Best-effort base-move fan-out for a drain that threw after the merge (bd-280 S5).
 *
 * The merge already moved the base, so every remaining member is now planning on a
 * stale one: leaving the notices unsent costs each of them the premise update their
 * next phase needs, and the refusal text can only tell the operator to do it by
 * hand. It is best-effort on purpose — the throw that got us here may come from the
 * very seams this fan-out uses, so a failure becomes a warning on the landed result
 * rather than a second failure or a rejected promise. Nothing here can move the
 * entry off `merged` or re-run a merge: it reads git and writes notes only, and
 * {@link broadcastBaseMoved} records each recipient it has written, so a fan-out
 * that already ran (a throw *after* the broadcast) is not repeated and a partial one
 * resumes with the members it missed.
 */
async function broadcastAfterThrow(context: MergeAttemptContext): Promise<void> {
  try {
    await broadcastBaseMoved(context);
  } catch (error) {
    context.warnings.push(
      `fleet ${context.options.fleetId}: could not send the base-moved notices for ` +
        `${context.entry.taskId} after a step threw (${describeThrown(error)}); the remaining ` +
        "members may not know the base moved — check events/ and resend by hand",
    );
  }
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

/** `--format` for commit facts: sha plus committer seconds, one per line. */
const REBASE_COMMIT_FORMAT = "%H %ct";

/** How many commits per side are read for attribution. */
const REBASE_COMMIT_READ_LIMIT = "20";

/** Parse `git log --format=%H %ct` output into commit facts. */
function parseCommitFacts(stdout: string): readonly RebaseCommitFact[] {
  const facts: RebaseCommitFact[] = [];
  for (const line of stdout.split("\n")) {
    const [sha, seconds] = line.trim().split(" ");
    if (sha === undefined || sha === "" || seconds === undefined) continue;
    const committedAtInSeconds = Number(seconds);
    if (!Number.isFinite(committedAtInSeconds)) continue;
    facts.push({ sha, committedAt: committedAtInSeconds * 1000 });
  }
  return facts;
}

/** One revision's commits that touched one path; unreadable commits become a warning. */
async function readPathCommits(
  context: MergeAttemptContext,
  cwd: string,
  revisionRange: string,
  path: string,
): Promise<readonly RebaseCommitFact[]> {
  const logged = await gitWithError(
    context,
    [
      "-c",
      "core.quotePath=false",
      "log",
      revisionRange,
      `--format=${REBASE_COMMIT_FORMAT}`,
      "-n",
      REBASE_COMMIT_READ_LIMIT,
      "--",
      path,
    ],
    cwd,
  );
  if (logged.ok) return parseCommitFacts(logged.stdout);
  // Attribution is the only thing lost here, and it must not abort the drain: an
  // unreadable `log` degrades the class (never claims a contradiction it cannot
  // name) and says so, rather than guessing a sibling's work.
  context.warnings.push(
    `fleet ${context.options.fleetId}: could not read the commits of ${path} in ${cwd} ` +
      `(${logged.error}); the rebase conflict is classified without them`,
  );
  return [];
}

/**
 * The conflicts of a stopped rebase, with each side's commits.
 *
 * Must be called while the rebase is stopped: once it is aborted or continued the
 * unmerged index is gone, and with it every fact the classification is built on.
 */
async function readRebaseConflicts(
  context: MergeAttemptContext,
  memberWorktree: string,
): Promise<
  { ok: true; conflicts: readonly RebaseConflictedPath[] } | { ok: false; error: string }
> {
  const status = await gitWithError(
    context,
    ["-c", "core.quotePath=false", "status", "--porcelain", "-z"],
    memberWorktree,
  );
  if (!status.ok) return { ok: false, error: status.error };

  const conflicts: RebaseConflictedPath[] = [];
  for (const path of parseConflictedPaths(status.stdout)) {
    conflicts.push({
      path,
      // The member's own commits are read from the *branch*, not from `HEAD`: a
      // stopped rebase has HEAD detached at the base, so `base..HEAD` is empty
      // exactly while the conflict exists. The branch ref still points at the
      // member's tip until the rebase finishes.
      memberCommits: await readPathCommits(
        context,
        context.options.rootCwd,
        `${context.baseBranch}..${context.entry.branch}`,
        path,
      ),
      baseCommits: await readPathCommits(
        context,
        context.options.rootCwd,
        context.baseBranch,
        path,
      ),
    });
  }
  return { ok: true, conflicts };
}

/** Whether the member worktree actually has a rebase in progress, and where. */
async function rebaseInProgress(
  context: MergeAttemptContext,
  memberWorktree: string,
): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const gitPath = await gitOk(context, ["rev-parse", "--git-path", name], memberWorktree);
    if (gitPath === undefined || gitPath.trim() === "") continue;
    const raw = gitPath.trim();
    // `--git-path` is absolute inside a linked worktree and relative to the
    // worktree in a plain one, so both forms have to resolve before the existence
    // check can answer for the worktree we mean.
    const resolved = isAbsolute(raw) ? raw : resolve(memberWorktree, raw);
    if (context.fs.existsSync(resolved)) return true;
  }
  return false;
}

/** Abort the stopped rebase, warning (W6) when git refuses. */
async function abortRebase(context: MergeAttemptContext, memberWorktree: string): Promise<void> {
  const aborted = await gitWithError(context, ["rebase", "--abort"], memberWorktree);
  if (aborted.ok) return;
  // A failed abort leaves the member mid-rebase; the next action would hit an
  // unexplained "rebase in progress" (W6), so say it here.
  context.warnings.push(
    `fleet ${context.options.fleetId}: could not abort the rebase in ${memberWorktree} ` +
      `(${aborted.error}); that worktree is probably still mid-rebase`,
  );
}

/** Stop a classified rebase with the failure the caller records. */
function rebaseClassFailure(
  context: MergeAttemptContext,
  rebaseClass: FleetRebaseClass,
  reason: string,
): MergeCheckFailure {
  const text = rebaseConflictText({
    rebaseClass,
    branch: context.entry.branch,
    baseBranch: context.baseBranch,
    reason,
  });
  const paths = "paths" in rebaseClass ? rebaseClass.paths : [];
  auditAttempt(context, "merge-rebase-failed", [context.entry.taskId], text);
  return {
    reason: "rebase-failed",
    text,
    ...(paths.length === 0 ? {} : { paths }),
  };
}

/**
 * The stale-state class: clear what a crashed attempt left, then retry once.
 *
 * Clearing is the new information the "never retry an unchanged base" rule needs:
 * with no conflicted paths the first attempt failed before it produced a conflict
 * (an index lock, a leftover `.git/rebase-merge`), so the same command against the
 * same base is a different situation afterwards. It is deliberately bounded — one
 * recovery, one retry per drain — and a retry that fails is classified like any
 * other failure, never retried a second time.
 *
 * `.git/index.lock` is never deleted: a live member process can hold it, and
 * removing a live lock is how concurrent writers corrupt an index.
 */
async function recoverStaleRebase(
  context: MergeAttemptContext,
  memberWorktree: string,
  reason: string,
): Promise<MergeCheckFailure | undefined> {
  const renewed = await renewBeforeMutation(context);
  // The stopped rebase is cleared *before* a lost lock is returned: the drain's
  // invariant is that every exit either clears the stopped rebase or parks the
  // entry with its paths recorded, and a lost lock is still an exit (bd-280 C1).
  // The other classes abort first for the same reason.
  if (await rebaseInProgress(context, memberWorktree)) {
    await abortRebase(context, memberWorktree);
  }
  if (renewed !== undefined) return renewed;

  const retried = await gitWithError(context, ["rebase", context.baseBranch], memberWorktree);
  if (retried.ok) {
    auditAttempt(
      context,
      "merge-rebase-recovered",
      [context.entry.taskId],
      `cleared the stale rebase state and retried once: ${reason}`,
    );
    return undefined;
  }

  // The retry produced a new failure, not a second chance: classify it and
  // dispatch through the same class→action mapping, with the retry bound spent.
  return handleRebaseFailure(context, memberWorktree, {
    reason: `first attempt: ${reason}; retry: ${retried.error}`,
    allowRecovery: false,
  });
}

/**
 * The generated class: take the base side of derived paths, regenerate, continue.
 *
 * `checkout --ours` during a rebase is the *base* side (HEAD is the upstream being
 * rebased onto), which is why this is not an auto-resolution of anyone's source: a
 * lockfile, a build tree, or a snapshot is an artifact of a command, and the base's
 * artifact is recreated from the base's manifest. Every failure aborts the rebase
 * and stops with the step that failed named.
 */
async function regenerateRebaseConflict(
  context: MergeAttemptContext,
  memberWorktree: string,
  rebaseClass: Extract<FleetRebaseClass, { kind: "generated" }>,
): Promise<MergeCheckFailure | undefined> {
  const renewed = await renewBeforeMutation(context);
  if (renewed !== undefined) {
    await abortRebase(context, memberWorktree);
    return renewed;
  }

  const checkedOut = await gitWithError(
    context,
    ["checkout", "--ours", "--", ...rebaseClass.paths],
    memberWorktree,
  );
  if (!checkedOut.ok) {
    await abortRebase(context, memberWorktree);
    return rebaseClassFailure(
      context,
      rebaseClass,
      `could not take the base side of the generated paths: ${checkedOut.error}`,
    );
  }

  const kinds = rebaseClass.paths.map((path) => classifyGeneratedPath(path));
  const gates = readFleetGateCommands({ rootCwd: context.options.rootCwd, fs: context.fs });
  const regenerate = context.options.regenerate ?? defaultFleetMergeRegenerateRunner;
  const regenerated = await regenerate({
    cwd: memberWorktree,
    paths: rebaseClass.paths,
    runner: gates.ok ? gates.runner : "npm",
    installRequired: kinds.includes("lockfile"),
    buildRequired: kinds.includes("derived"),
    hasBuildScript: gates.ok && gates.commands.some((gate) => gate.name === "build"),
  });
  if (!regenerated.ok) {
    await abortRebase(context, memberWorktree);
    return rebaseClassFailure(context, rebaseClass, `regeneration failed: ${regenerated.error}`);
  }

  const added = await gitWithError(context, ["add", "--", ...rebaseClass.paths], memberWorktree);
  if (!added.ok) {
    await abortRebase(context, memberWorktree);
    return rebaseClassFailure(
      context,
      rebaseClass,
      `could not stage the regenerated paths: ${added.error}`,
    );
  }

  // `core.editor=true` keeps the continue fully non-interactive: a rebase that
  // opens an editor under the supervisor would hang until the command timeout.
  const continued = await gitWithError(
    context,
    ["-c", "core.editor=true", "rebase", "--continue"],
    memberWorktree,
  );
  if (continued.ok) {
    auditAttempt(
      context,
      "merge-rebase-recovered",
      [context.entry.taskId],
      `regenerated ${formatRebasePathList(rebaseClass.paths)} from the base side`,
    );
    return undefined;
  }
  await abortRebase(context, memberWorktree);
  return rebaseClassFailure(context, rebaseClass, `rebase --continue failed: ${continued.error}`);
}

/**
 * The delegation class: ask the member to resolve it, and do not stop the fleet.
 *
 * The drain already broadcasts a `rebase-hint` on every success, so self-rebase is
 * the designed first line; this is the same request for the fallback that failed.
 * The entry is left `failed` with `delegatedAt` so a later tick can tell "still
 * waiting for the member" from "try again": that marker is what keeps a re-drain
 * from retrying against a base the member has not caught up with.
 */
async function delegateRebase(
  context: MergeAttemptContext,
  memberWorktree: string,
  rebaseClass: Extract<FleetRebaseClass, { kind: "delegable" }>,
): Promise<MergeCheckFailure> {
  const renewed = await renewBeforeMutation(context);
  // The abort happens even when the lease was lost: leaving the member mid-rebase
  // would hand the next attempt an unexplained "rebase in progress" (W6). The lost
  // lease then wins as the reason, because nothing further may be attempted.
  await abortRebase(context, memberWorktree);
  if (renewed !== undefined) return renewed;
  const sent = sendMergeNote(
    context,
    [context.entry.taskId],
    "rebase-hint",
    `${context.baseBranch} and your branch conflict in ${formatRebasePathList(rebaseClass.paths)}. ` +
      `Resolve the conflict against ${context.baseBranch}, re-run your own gates, and tell the ` +
      "supervisor to land again; this is your rebase to resolve, not the operator's.",
  );
  if (!sent.includes(context.entry.taskId)) {
    // A delegation is a request, and a member that was never asked cannot be
    // expected to act: delegating without a note would park the landing for the
    // whole grace window and then stop it anyway. Stop now instead, with the note
    // failure as the reason (bd-280 W4) — the alternative is a tick that claims a
    // member was asked when nothing reached it.
    return rebaseClassFailure(
      context,
      rebaseClass,
      "the rebase-hint could not be written to the member, so nobody was asked to resolve " +
        "this conflict",
    );
  }
  const text = rebaseConflictText({
    rebaseClass,
    branch: context.entry.branch,
    baseBranch: context.baseBranch,
  });
  return {
    reason: "rebase-delegated",
    text,
    paths: rebaseClass.paths,
    // The complete list travels with the delegation: the bounded `text` loses it
    // past five paths, and the tick must still be able to report and record it.
    delegated: { taskId: context.entry.taskId, paths: rebaseClass.paths },
  };
}

/** Abort the stopped rebase, then report the class as the failure it is. */
async function stopRebase(
  context: MergeAttemptContext,
  memberWorktree: string,
  rebaseClass: FleetRebaseClass,
  reason: string,
): Promise<MergeCheckFailure> {
  // bd-279 opens the escalation gate from the resulting `land-failed` stop on the
  // next tick; there is deliberately no gate code here.
  await abortRebase(context, memberWorktree);
  return rebaseClassFailure(context, rebaseClass, reason);
}

/**
 * The members this run already landed, which is the only proof of a sibling's work.
 *
 * `landedAt` is written when the drain merged the member, so a member named here
 * put commits on the base through this fleet. Base commits without such a member
 * are still inside the fleet window (a person can commit too) but nothing proves
 * who wrote them, so the stop text must not claim a sibling (bd-280 W2).
 */
function landedSiblingTaskIds(context: MergeAttemptContext): readonly string[] {
  const members = context.intent.run?.members ?? [];
  return members
    .filter((member) => member.landedAt !== undefined && member.taskId !== context.entry.taskId)
    .map((member) => member.taskId);
}

/**
 * The one decision point for a failed rebase: read it, classify it, act on the class.
 *
 * Shared by the first attempt and by a failed recovery retry (bd-280 W1): a retry
 * that conflicts again is a new failure to classify, so a generated conflict is
 * regenerated and a delegable one delegated rather than being binned as `unknown`.
 * `allowRecovery` is the only difference between them — the one-retry bound is per
 * drain, so a retry's failure never retries again.
 */
async function handleRebaseFailure(
  context: MergeAttemptContext,
  memberWorktree: string,
  options: { reason: string; allowRecovery: boolean },
): Promise<MergeCheckFailure | undefined> {
  const read = await readRebaseConflicts(context, memberWorktree);
  if (!read.ok) {
    await abortRebase(context, memberWorktree);
    const text =
      `rebase of ${context.entry.branch} onto ${context.baseBranch} failed and its conflicted ` +
      `paths could not be read: ${read.error}`;
    auditAttempt(context, "merge-rebase-failed", [context.entry.taskId], text);
    return { reason: "rebase-failed", text };
  }

  const rebaseClass = classifyRebaseFailure({
    conflicts: read.conflicts,
    fleetStartedAt: context.intent.createdAt,
    memberLive: context.options.memberLease === "live",
    landedSiblings: landedSiblingTaskIds(context),
  });
  // Emitted for every failure — the first attempt, a recovery retry's, and the
  // `unknown` fall-through — so the audit says what the drain decided even when
  // the decision was to stop.
  auditAttempt(
    context,
    "merge-rebase-classified",
    [context.entry.taskId],
    `${rebaseClass.kind}: ${formatRebasePathList(read.conflicts.map((conflict) => conflict.path))}`,
  );

  switch (rebaseClass.kind) {
    case "not-a-conflict":
      return options.allowRecovery
        ? recoverStaleRebase(context, memberWorktree, options.reason)
        : stopRebase(context, memberWorktree, rebaseClass, options.reason);
    case "generated":
      return regenerateRebaseConflict(context, memberWorktree, rebaseClass);
    case "delegable":
      return delegateRebase(context, memberWorktree, rebaseClass);
    case "contradiction":
    case "unknown":
      return stopRebase(context, memberWorktree, rebaseClass, options.reason);
  }
}

/**
 * Rebase the member branch onto the base, classifying a failure before acting.
 *
 * Before bd-280 every non-zero exit aborted and stopped the member. The class is
 * read from the stopped rebase (the only moment the conflicted index exists) and
 * decides: clear-and-retry a stale state, regenerate derived paths, delegate to a
 * live member, or stop with the facts. Only the last two can leave the entry
 * failed; only `contradiction`/`unknown` stop the fleet.
 */
async function rebaseMember(
  context: MergeAttemptContext,
  memberWorktree: string,
): Promise<MergeCheckFailure | undefined> {
  const transitioned = transitionEntry({
    context,
    state: "rebasing",
    lastError: undefined,
  });
  if (!transitioned.ok) {
    return { reason: "queue-write-failed", text: transitioned.error };
  }
  const renewed = await renewBeforeMutation(context);
  if (renewed !== undefined) return renewed;

  const rebased = await gitWithError(context, ["rebase", context.baseBranch], memberWorktree);
  if (rebased.ok) return undefined;

  return handleRebaseFailure(context, memberWorktree, {
    reason: rebased.error,
    allowRecovery: true,
  });
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
  const transitioned = transitionEntry({ context, state: "gating", lastError: undefined });
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
  const transitioned = transitionEntry({ context, state: "merging", lastError: undefined });
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
  // The fast-forward is the point of no return, so the marker is set before HEAD is
  // read: a seam that throws in between must never be reported as a merge that did
  // not happen (bd-280 WF).
  context.mergeCommit = "";
  const head = await gitOk(context, ["rev-parse", "HEAD"], context.options.rootCwd);
  context.mergeCommit = head?.trim() ?? "";
  return undefined;
}

/** Release the lock and collect any warning; never throws. */
function releaseForDrain(context: MergeAttemptContext): void {
  // Idempotent so the drain's `finally` can hold the belt-and-braces release
  // without double-releasing (and without a second warning) after a finisher.
  if (context.lockReleased) return;
  context.lockReleased = true;
  let released: ReleaseFleetMergeResult;
  try {
    released = releaseFleetMerge({
      gitCommonDir: context.options.gitCommonDir,
      fleetId: context.options.fleetId,
      fs: context.fs,
      holder: context.options.sessionId,
      now: context.clock(),
    });
  } catch (error) {
    // A hostile fs seam must not reject the drain from its own cleanup: the lease
    // expires on its own, which is the documented fallback (bd-280 WF).
    context.warnings.push(
      `fleet ${context.options.fleetId}: releasing the merge lock threw ` +
        `(${describeThrown(error)}); it becomes acquirable when its lease expires`,
    );
    return;
  }
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
  paths?: readonly string[];
  delegated?: { taskId: string; paths: readonly string[] };
  parked?: boolean;
  warnings: readonly string[];
}): DrainFleetMergeResult {
  return {
    ok: false,
    reason: options.reason,
    text: options.text,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
    ...(options.delegated === undefined ? {} : { delegated: options.delegated }),
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
      baseBranch: intent.baseBranch,
      entry,
      clock,
      warnings: [],
      lockReleased: false,
      broadcast: { baseMoved: [], siblingLanded: [], rebaseHint: [] },
      mergeCompletionAudited: false,
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
    ...(failure.paths === undefined ? {} : { paths: failure.paths }),
    ...(failure.delegated === undefined ? {} : { delegated: failure.delegated }),
    warnings: context.warnings,
  });
}

/**
 * Reconcile a failure with the `failed` transition it needed (bd-280 W3/S3).
 *
 * A delegation is only self-limiting once the queue carries `delegatedAt`, which is
 * exactly what the tick's hold keys on. If that write failed, reporting a delegation
 * would re-run the whole rebase and send a fresh hint every couple of seconds, so the
 * result is downgraded to the stop the conflict would have been had nobody been able
 * to decide: the rebase is already aborted and the paths are recorded. The single
 * `merge-rebase-failed` entry is written here, after the text is final, so it cannot
 * read as two events for one failure.
 */
function recordedFailedState(
  context: MergeAttemptContext,
  rawFailure: MergeCheckFailure,
  transition: { ok: true } | { ok: false; error: string },
): MergeCheckFailure {
  if (transition.ok) return rawFailure;
  context.warnings.push(transition.error);
  if (rawFailure.delegated === undefined) return rawFailure;
  const failure: MergeCheckFailure = {
    reason: "rebase-failed",
    text:
      `rebase of ${context.entry.branch} onto ${context.baseBranch} conflicted and the ` +
      `delegation could not be recorded in the merge queue (${transition.error}); ` +
      "stopping for a human instead of re-asking the member on every tick",
    ...(rawFailure.paths === undefined ? {} : { paths: rawFailure.paths }),
  };
  auditAttempt(context, "merge-rebase-failed", [context.entry.taskId], failure.text);
  return failure;
}

/**
 * Failure finish: mark the entry failed, restore the stashed root (parking the
 * fleet if the restore conflicts), release the lock, and report honestly. Shared
 * by the stash-step failure and the sequence failure so both leave the same
 * invariants behind.
 */
async function finishFailedDrain(
  context: MergeAttemptContext,
  rawFailure: MergeCheckFailure,
): Promise<DrainFleetMergeResult> {
  // A failure reported after the fast-forward moved the base is not a failed merge:
  // this is the same rule a throwing finisher follows, reached through the sequence
  // (a step between the merge and the finishers threw). Keeping the entry `merged`
  // is what stops a landed member from looking unmerged to every later tick.
  if (context.mergeCommit !== undefined) {
    auditMergeCompletedOnce(context);
    return mergedAfterThrowResult(context, rawFailure.text);
  }
  const failure = recordedFailedState(
    context,
    rawFailure,
    transitionEntry({
      context,
      state: "failed",
      lastError: rawFailure.text,
      // A delegated failure records the marker here so the queue itself says "the
      // member owes this rebase", not just the run's stop list (which has no entry
      // for it: the member is deliberately not stopped).
      ...(rawFailure.delegated === undefined ? {} : { delegatedAt: context.clock() }),
    }),
  );

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
    ...(failure.paths === undefined ? {} : { paths: failure.paths }),
    ...(failure.delegated === undefined ? {} : { delegated: failure.delegated }),
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
  const mergedTransition = transitionEntry({
    context,
    state: "merged",
    lastError: undefined,
  });
  if (!mergedTransition.ok) context.warnings.push(mergedTransition.error);
  // The audit lives in one helper so the landed arms cannot add a second entry for a
  // merge this attempt already recorded (bd-280 S6).
  auditMergeCompletedOnce(context);

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
 * Report text for a drain result: the one-line refusal plus the complete path
 * list when the refusal is path-shaped.
 *
 * `DrainFleetMergeResult.text` is bounded to one readable line, so the result
 * carries the full sorted `paths` separately. A caller that renders a report
 * must surface them, or the operator cannot see everything it has to delete.
 */
export function formatDrainResultText(result: DrainFleetMergeResult): string {
  if (result.ok) return result.text;
  const paths = result.paths;
  if (paths === undefined || paths.length === 0) return result.text;
  const lines = paths.map((path) => `- ${path}`);
  return [result.text, "", `Refused paths (${paths.length}):`, ...lines].join("\n");
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

  const payload = await checkPublishPayload(context);
  if (payload !== undefined) return drainRefusal(context, payload);

  const acquired = acquireForDrain(context);
  if (!acquired.ok) return drainRefusal(context, acquired.failure);

  const stillQueued = verifyEntryStillQueued(context);
  if (stillQueued !== undefined) {
    releaseForDrain(context);
    return drainRefusal(context, stillQueued);
  }

  try {
    const stashed = await stashRootIfDirty(context);
    if (stashed !== undefined) return await finishGuarded(context, stashed);

    let failed: MergeCheckFailure | undefined;
    try {
      failed = await attemptMergeSequence(context, preconditions.memberWorktree);
    } catch (error) {
      // The seams are supposed to return failures as values, and every one of them
      // does; this is the belt for the one that does not. Without it a throw escapes
      // with the merge lock held and the member possibly mid-rebase, and the caller
      // gets a rejected promise instead of a result (bd-280 W6).
      failed = await thrownStepFailure(context, preconditions.memberWorktree, error);
    }
    return await finishGuarded(context, failed);
  } finally {
    // The finishers release the lock on every defined path; this holds the same
    // invariant when a finisher's own seam throws, so a rejected promise can never
    // leave the fleet single-flight forever (bd-280 W6).
    releaseForDrain(context);
  }
}

/**
 * Run the finisher for this attempt, converting a seam throw into a result
 * (bd-280 WF).
 *
 * The finishers call the same fs/git seams as the sequence, and `drainFleetMerge`
 * promises a result, never a rejected promise. `undefined` means the sequence
 * landed the member; anything else is the refusal it stopped for.
 */
async function finishGuarded(
  context: MergeAttemptContext,
  failure: MergeCheckFailure | undefined,
): Promise<DrainFleetMergeResult> {
  try {
    return failure === undefined
      ? await finishSuccessfulDrain(context)
      : await finishFailedDrain(context, failure);
  } catch (error) {
    return finisherThrownResult(context, failure, error);
  }
}

/**
 * Report a finisher that threw instead of returning a result (bd-280 WF).
 *
 * Two facts survive any such throw: `context.mergeCommit` is set by the
 * fast-forward itself, so its presence means the base branch really advanced; and
 * a drain that was already refusing keeps that refusal as its reason, because a
 * cleanup failure must not mask what the operator has to fix.
 */
async function finisherThrownResult(
  context: MergeAttemptContext,
  primary: MergeCheckFailure | undefined,
  error: unknown,
): Promise<DrainFleetMergeResult> {
  const detail = describeThrown(error);
  const entry = context.entry;
  const landed = context.mergeCommit !== undefined;
  // A landed merge's completion audit goes first: the throw came after the base
  // branch advanced, so replaying `audit.log` in order shows the merge before the
  // step that failed on it (bd-280 S6).
  if (landed) auditMergeCompletedOnce(context);
  auditAttempt(context, "merge-step-threw", [entry.taskId], detail);

  if (landed) return mergedAfterThrowResult(context, detail);

  // Nothing reached the base branch. A delegation the record write dropped is not a
  // delegation any more (bd-280 W3), so it becomes the stop it would have been; every
  // other refusal keeps its reason and gains only the cleanup note.
  if (primary?.delegated !== undefined) {
    const text =
      `rebase of ${entry.branch} onto ${context.baseBranch} conflicted and the delegation ` +
      `could not be recorded (${detail}); stopping for a human instead of re-asking the ` +
      "member on every tick";
    reassertFailedEntry(context, text);
    return drainFailure({
      reason: "rebase-failed",
      text,
      taskId: entry.taskId,
      ...(primary.paths === undefined ? {} : { paths: primary.paths }),
      ...(context.stashRef === undefined ? {} : { stashRef: context.stashRef }),
      warnings: context.warnings,
    });
  }
  const primaryText =
    primary?.text ?? `finishing the merge attempt for ${entry.branch} threw before reporting`;
  reassertFailedEntry(context, primaryText);
  return drainFailure({
    reason: primary?.reason ?? "step-failed",
    text:
      `${primaryText}\nfinishing this drain also threw (${detail}); the merge lock was released, ` +
      "but the queue record or the root restore may be incomplete — inspect them before retrying",
    taskId: entry.taskId,
    ...(primary?.paths === undefined ? {} : { paths: primary.paths }),
    ...(context.stashRef === undefined ? {} : { stashRef: context.stashRef }),
    warnings: context.warnings,
  });
}

/**
 * Report a failure that happened *after* the fast-forward moved the base branch.
 *
 * `context.mergeCommit` is set by the merge itself, so its presence means the
 * member's work is on the base: the entry is re-asserted as `merged` (idempotently,
 * so a throw inside the transition cannot leave it unfinished) and never downgraded
 * to `failed`, and the text says the merge happened. The caller has already audited
 * the throw as `merge-step-threw`.
 *
 * The base-move fan-out is then attempted best-effort: a throw after the merge is
 * exactly when the remaining members would otherwise never learn that the base
 * moved (bd-280 S5).
 */
async function mergedAfterThrowResult(
  context: MergeAttemptContext,
  detail: string,
): Promise<DrainFleetMergeResult> {
  const entry = context.entry;
  reassertMergedEntry(context);
  await broadcastAfterThrow(context);
  context.warnings.push(
    `fleet ${context.options.fleetId}: a step after merging ${entry.taskId} failed (${detail}); ` +
      "the merge is landed and is not retried",
  );
  const mergeCommit = context.mergeCommit ?? "";
  const sha = mergeCommit === "" ? "an unreadable sha" : mergeCommit.slice(0, 12);
  return drainFailure({
    reason: "step-failed",
    text:
      `merged ${entry.taskId} into ${context.baseBranch} at ${sha}, but ${detail}; ` +
      "the merge landed and is not retried — the remaining members were told about the new " +
      "base best-effort, so finish any other pending cleanup (the root restore) by hand",
    taskId: entry.taskId,
    ...(context.stashRef === undefined ? {} : { stashRef: context.stashRef }),
    warnings: context.warnings,
  });
}

/** The `merge-completed` detail: what landed, where, and at which commit. */
function mergeCompletedDetail(context: MergeAttemptContext): string {
  const mergeCommit = context.mergeCommit ?? "";
  const sha = mergeCommit === "" ? "an unreadable sha" : mergeCommit;
  return `merged ${context.entry.branch} into ${context.baseBranch} at ${sha}`;
}

/**
 * The `merge-completed` audit for a landed merge, written at most once per drain
 * attempt (bd-280 S6).
 *
 * The marker is {@link MergeAttemptContext.mergeCompletionAudited}, never the queue
 * entry: the entry's writes are best-effort, so it is either missing (`rebasing`
 * after a failed `merged` transition) or present (`merged`, while the audit append
 * that follows it failed) in exactly the cases where the audit must still be honest.
 * The flag is set only when the append returned success, so the landed arm retries a
 * failed append once — a landed merge must not lose the one entry an operator greps
 * for — and every landed arm (the success finisher, the landed throw, the failure
 * finisher) consults the same flag, so a merge can never be audited twice.
 */
function auditMergeCompletedOnce(context: MergeAttemptContext): void {
  if (context.mergeCompletionAudited) return;
  const written = auditAttempt(
    context,
    "merge-completed",
    [context.entry.taskId],
    mergeCompletedDetail(context),
  );
  if (written) context.mergeCompletionAudited = true;
}

/** Re-assert `merged` for an entry whose merge already reached the base branch. */
function reassertMergedEntry(context: MergeAttemptContext): void {
  try {
    const recorded = transitionEntry({ context, state: "merged", lastError: undefined });
    if (!recorded.ok) context.warnings.push(recorded.error);
  } catch (error) {
    context.warnings.push(
      `fleet ${context.options.fleetId}: could not re-record ${context.entry.taskId} as merged ` +
        `after a finisher threw (${describeThrown(error)}); the base branch advanced, so treat ` +
        "the merge as landed",
    );
  }
}

/** Best-effort `failed` state for a drain that could not finish its own report. */
function reassertFailedEntry(context: MergeAttemptContext, text: string): void {
  try {
    const recorded = transitionEntry({ context, state: "failed", lastError: text });
    if (!recorded.ok) context.warnings.push(recorded.error);
  } catch (error) {
    context.warnings.push(
      `fleet ${context.options.fleetId}: could not record ${context.entry.taskId} as failed ` +
        `(${describeThrown(error)}); the queue entry may still read as in flight`,
    );
  }
}

/**
 * Turn a thrown merge-step seam into the failure the drain records (bd-280 W6).
 *
 * The rebase is the step that mutates the member worktree, so a throw is followed
 * by a best-effort abort: the "no worktree left mid-rebase" invariant every
 * classified path keeps applies here too. Both calls are guarded because the seam
 * that threw may be the very one they would use.
 */
async function thrownStepFailure(
  context: MergeAttemptContext,
  memberWorktree: string,
  error: unknown,
): Promise<MergeCheckFailure> {
  const detail = error instanceof Error ? error.message : String(error);
  context.warnings.push(
    `fleet ${context.options.fleetId}: a merge step for ${context.entry.taskId} threw (${detail}); ` +
      "releasing the merge lock and clearing any stopped rebase",
  );
  auditAttempt(context, "merge-step-threw", [context.entry.taskId], detail);
  try {
    if (await rebaseInProgress(context, memberWorktree)) {
      await abortRebase(context, memberWorktree);
    }
  } catch (nested) {
    const nestedDetail = nested instanceof Error ? nested.message : String(nested);
    context.warnings.push(
      `fleet ${context.options.fleetId}: could not clear the rebase in ${memberWorktree} after ` +
        `that throw (${nestedDetail}); it may still be mid-rebase, so the next attempt needs ` +
        "`git rebase --abort` there",
    );
  }
  return {
    reason: "step-failed",
    text: `a merge step for ${context.entry.branch} threw: ${detail}`,
  };
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
