/**
 * One-orchestrator-per-worktree lease.
 *
 * A worktree may host at most one orchestrator session. That is the invariant
 * every phase tool already assumes (one process gate = one bead = one worktree),
 * and breaking it is not theoretical: two orchestrators on one branch share
 * `.belayd/workflow.json` and `.belayd/runs/`, so each one overwrites the other's
 * phase ledger and both spawn phase sub-agents on the same files.
 *
 * The record used to be the workflow state file, which cannot tell "a live
 * orchestrator drives this tree" from "an orchestrator died here": a completed
 * workflow deletes the state file, a failed launch leaves one behind, and the
 * fleet's own repair paths move it. The lease is a separate fact with a
 * different lifetime — it is created when an orchestrator session starts and
 * renewed by that session's own process until it shuts down, so "held and
 * recently renewed" means a live orchestrator and "held and cold" means one that
 * is gone.
 *
 * Why a heartbeat instead of a pid or an argv token:
 *
 * - Orchestrators launched by Belayd are pi-web sessions *inside* the session
 *   daemon. There is no per-orchestrator process and no `belayd-<taskId>` token
 *   in any argv, so a process-table scan reports every live member as dead (that
 *   is exactly how bd-37 got a second orchestrator).
 * - The lease is renewed from the session's own extension timer, so it stops
 *   when the session (or the daemon holding it) stops. A pid, by contrast, is
 *   shared by every session in the daemon and proves nothing.
 *
 * Split like the rest of the fleet family: parsing and classification are pure,
 * and the four side effects (create, renew, release, archive) take an injected
 * fs seam so tests never touch a real worktree.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Lease file name, inside the worktree's `.belayd/` directory. */
export const ORCHESTRATOR_CLAIM_FILE_NAME = "orchestrator.json";

/** Prefix of an archived (dead) lease, kept beside the live one for diagnosis. */
export const ORCHESTRATOR_CLAIM_ARCHIVE_PREFIX = "orchestrator.stale-";

export const ORCHESTRATOR_CLAIM_SCHEMA_VERSION = 1;

/**
 * How often a live orchestrator renews its lease.
 *
 * The extension timer that renews it runs in the session's own process, so a
 * stalled model turn or a long phase does not stop renewal — only a dead session
 * or a dead daemon does.
 */
export const ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Age at which a lease is treated as abandoned: nine missed renewals.
 *
 * Deliberately generous. The cost of a false "stale" is taking over a worktree a
 * live orchestrator is still using (the chaos this module exists to prevent), so
 * the window absorbs scheduler pauses, suspended machines, and a slow tick.
 */
export const ORCHESTRATOR_CLAIM_STALE_MS = 9 * ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS;

/**
 * Session-id prefix a spawner uses while it is creating the orchestrator session.
 *
 * The lease must exist *before* the session so two concurrent spawns cannot both
 * create one; the child's real id only exists after the session daemon returns it.
 * A pending lease is therefore adoptable by the first session that starts in that
 * worktree, and unadoptable by anyone else once an id is written.
 */
export const ORCHESTRATOR_CLAIM_PENDING_PREFIX = "pending:";

/** Whether a lease is a spawner placeholder waiting for its session id. */
export function isPendingOrchestratorClaim(claim: OrchestratorClaim): boolean {
  return claim.sessionId.startsWith(ORCHESTRATOR_CLAIM_PENDING_PREFIX);
}

const OrchestratorClaimSchema = z.object({
  schemaVersion: z.literal(ORCHESTRATOR_CLAIM_SCHEMA_VERSION),
  /** Bead the orchestrator drives. */
  taskId: z.string().min(1).max(128),
  /** Branch checked out in the worktree (diagnostic, never used for identity). */
  branch: z.string().max(512),
  /** pi session id of the orchestrator that holds the lease. */
  sessionId: z.string().min(1).max(256),
  /** Host pid of the process that owns the session (diagnostic only). */
  pid: z.number().int().nonnegative(),
  claimedAt: z.number().finite(),
  heartbeatAt: z.number().finite(),
});

export type OrchestratorClaim = z.infer<typeof OrchestratorClaimSchema>;

/** The fs surface the lease needs; injected so tests never write a real `.belayd/`. */
export interface OrchestratorClaimFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  /** Called with `flag: "wx"` for the atomic create; the option is part of the seam. */
  writeFileSync(path: string, data: string, options?: { flag?: string }): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

/** Read-only subset, so a pure reader (fleet status) can share the workflow fs seam. */
export type OrchestratorClaimReadFs = Pick<OrchestratorClaimFs, "existsSync" | "readFileSync">;

export const orchestratorClaimFs: OrchestratorClaimFs = {
  existsSync: (path) => existsSync(path),
  readFileSync: (path) => readFileSync(path, "utf8"),
  writeFileSync: (path, data, options) =>
    options === undefined ? writeFileSync(path, data) : writeFileSync(path, data, options),
  renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
  unlinkSync: (path) => unlinkSync(path),
  mkdirSync: (path, options) => mkdirSync(path, options),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Lease path for a worktree directory. */
export function orchestratorClaimPath(worktreePath: string): string {
  return join(worktreePath, ".belayd", ORCHESTRATOR_CLAIM_FILE_NAME);
}

/** Parse a lease record; undefined means "not a lease" (corrupt or wrong version). */
export function parseOrchestratorClaim(raw: unknown): OrchestratorClaim | undefined {
  const parsed = OrchestratorClaimSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export type OrchestratorClaimRead =
  | { kind: "absent" }
  | { kind: "ok"; claim: OrchestratorClaim }
  | { kind: "corrupt"; path: string; error: string };

/** Read the lease at a worktree. Absence is normal; anything unreadable is reported. */
export function readOrchestratorClaim(options: {
  worktreePath: string;
  fs?: OrchestratorClaimReadFs;
}): OrchestratorClaimRead {
  const fs = options.fs ?? orchestratorClaimFs;
  const path = orchestratorClaimPath(options.worktreePath);
  let raw: string;
  try {
    if (!fs.existsSync(path)) return { kind: "absent" };
    raw = fs.readFileSync(path);
  } catch (error) {
    return { kind: "corrupt", path, error: errorMessage(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", path, error: `${path} is not valid JSON` };
  }
  const claim = parseOrchestratorClaim(parsed);
  return claim === undefined
    ? { kind: "corrupt", path, error: `${path} is not an orchestrator lease` }
    : { kind: "ok", claim };
}

/**
 * What a lease means to a caller deciding whether it may drive this worktree.
 *
 * `held.state` is `live` while the lease is fresh and `stale` once it is cold.
 * `sameSession` says the lease is *this* session's own, which is the difference
 * between "renew it" and "someone else drives here".
 */
export type OrchestratorClaimVerdict =
  | { kind: "free" }
  | { kind: "held"; claim: OrchestratorClaim; state: "live" | "stale"; sameSession: boolean }
  | { kind: "corrupt"; path: string; error: string };

export function classifyOrchestratorClaim(options: {
  read: OrchestratorClaimRead;
  now: number;
  /** Session asking; absent means "nobody in particular" (a fleet launch). */
  sessionId?: string;
  staleAfterInMs?: number;
}): OrchestratorClaimVerdict {
  if (options.read.kind === "absent") return { kind: "free" };
  if (options.read.kind === "corrupt") return options.read;
  const staleAfter = options.staleAfterInMs ?? ORCHESTRATOR_CLAIM_STALE_MS;
  const age = options.now - options.read.claim.heartbeatAt;
  return {
    kind: "held",
    claim: options.read.claim,
    state: age < staleAfter ? "live" : "stale",
    sameSession:
      options.sessionId !== undefined && options.read.claim.sessionId === options.sessionId,
  };
}

/** Human-readable one-liner for a verdict, used in refusals and status lines. */
export function describeOrchestratorClaim(verdict: OrchestratorClaimVerdict): string {
  switch (verdict.kind) {
    case "free":
      return "no orchestrator lease";
    case "corrupt":
      return `unreadable orchestrator lease at ${verdict.path} (${verdict.error})`;
    case "held": {
      const state = verdict.state === "live" ? "live" : "stale";
      return `${state} orchestrator lease for ${verdict.claim.taskId} (session ${verdict.claim.sessionId})`;
    }
  }
}

export interface AcquireOrchestratorClaimOptions {
  worktreePath: string;
  taskId: string;
  branch: string;
  sessionId: string;
  pid: number;
  now: number;
  /**
   * Take over a cold lease (or a corrupt one) instead of refusing.
   *
   * A cold lease is not proof the worktree is unused — it is evidence its owner
   * stopped renewing — so takeover is a decision the caller must make explicitly
   * and report. The old record is archived beside the live lease, never deleted.
   */
  takeOverStale?: boolean;
  staleAfterInMs?: number;
  fs?: OrchestratorClaimFs;
}

export type AcquireOrchestratorClaimResult =
  | {
      ok: true;
      claim: OrchestratorClaim;
      /** Set when a cold/corrupt lease was archived to make room. */
      tookOverFrom?: { taskId: string; sessionId: string };
      /** Where the displaced record was archived (present whenever `tookOverFrom` is). */
      archivedPath?: string;
    }
  | {
      ok: false;
      reason: "held" | "corrupt" | "write-failed";
      verdict: OrchestratorClaimVerdict;
      error: string;
    };

export interface AcquireOrchestratorClaimOptions {
  worktreePath: string;
  taskId: string;
  branch: string;
  sessionId: string;
  pid: number;
  now: number;
  /**
   * Take over a cold lease (or a corrupt one) instead of refusing.
   *
   * A cold lease is not proof the worktree is unused — it is evidence its owner
   * stopped renewing — so takeover is a decision the caller must make explicitly
   * and report. The old record is archived beside the live lease, never deleted.
   */
  takeOverStale?: boolean;
  staleAfterInMs?: number;
  fs?: OrchestratorClaimFs;
}

/** Directory a displaced lease is archived into (beside the live record). */
function claimArchiveDir(worktreePath: string): string {
  return join(worktreePath, ".belayd");
}

/** Archive a lease that is being displaced; the record is kept, never deleted. */
function archiveClaimFile(options: {
  fromPath: string;
  worktreePath: string;
  now: number;
  suffix: string;
  fs: OrchestratorClaimFs;
}): string {
  const archivedPath = join(
    claimArchiveDir(options.worktreePath),
    `${ORCHESTRATOR_CLAIM_ARCHIVE_PREFIX}${options.now}${options.suffix}.json`,
  );
  options.fs.renameSync(options.fromPath, archivedPath);
  return archivedPath;
}

type ClaimCreateOutcome =
  | { ok: true }
  | { ok: false; reason: "exists" | "write-failed"; error?: string };

/**
 * Create the lease file only if it does not exist.
 *
 * `wx` is the whole mutual-exclusion mechanism: two sessions racing to claim one
 * worktree have exactly one winner, even in the same millisecond, and the loser
 * can then read the winner's record and name the session it must not fight.
 */
function createClaimExclusive(options: {
  worktreePath: string;
  claim: OrchestratorClaim;
  fs: OrchestratorClaimFs;
}): ClaimCreateOutcome {
  const path = orchestratorClaimPath(options.worktreePath);
  try {
    options.fs.writeFileSync(path, `${JSON.stringify(options.claim, null, 2)}\n`, { flag: "wx" });
    return { ok: true };
  } catch (error) {
    if (errorCode(error) === "EEXIST") return { ok: false, reason: "exists" };
    return {
      ok: false,
      reason: "write-failed",
      error: `could not create ${path}: ${errorMessage(error)}`,
    };
  }
}

/** Atomically replace the lease file (temp + rename). */
function writeClaimAtomically(options: {
  worktreePath: string;
  claim: OrchestratorClaim;
  now: number;
  fs: OrchestratorClaimFs;
}): void {
  const path = orchestratorClaimPath(options.worktreePath);
  const temp = `${path}.${options.now}.tmp`;
  options.fs.writeFileSync(temp, `${JSON.stringify(options.claim, null, 2)}\n`);
  options.fs.renameSync(temp, path);
}

function refuseClaim(
  reason: "held" | "corrupt" | "write-failed",
  verdict: OrchestratorClaimVerdict,
  error: string,
): AcquireOrchestratorClaimResult {
  return { ok: false, reason, verdict, error };
}

function buildClaim(options: {
  taskId: string;
  branch: string;
  sessionId: string;
  pid: number;
  now: number;
}): OrchestratorClaim {
  return {
    schemaVersion: ORCHESTRATOR_CLAIM_SCHEMA_VERSION,
    taskId: options.taskId,
    branch: options.branch,
    sessionId: options.sessionId,
    pid: options.pid,
    claimedAt: options.now,
    heartbeatAt: options.now,
  };
}

/**
 * Displace a cold or unreadable lease and take the worktree.
 *
 * Re-reads immediately before displacing: a holder that renewed between the
 * classification and this call is alive, and archiving it would hand its worktree
 * to a second orchestrator — the failure this module exists to prevent.
 */
function takeOverDisplacedClaim(options: {
  acquire: AcquireOrchestratorClaimOptions;
  claim: OrchestratorClaim;
  verdict: OrchestratorClaimVerdict;
  fs: OrchestratorClaimFs;
}): AcquireOrchestratorClaimResult {
  const { acquire, verdict, fs } = options;
  const path = orchestratorClaimPath(acquire.worktreePath);
  const corrupt = verdict.kind === "corrupt";
  if (verdict.kind === "held") {
    const recheck = recheckStaleLease({ acquire, claim: verdict.claim, fs, path });
    if (recheck !== undefined) return recheck;
  }

  const fromPath = verdict.kind === "corrupt" ? verdict.path : path;
  try {
    const archivedPath = archiveClaimFile({
      fromPath,
      worktreePath: acquire.worktreePath,
      now: acquire.now,
      suffix: corrupt ? ".corrupt" : ".stale",
      fs,
    });
    const created = createClaimExclusive({
      worktreePath: acquire.worktreePath,
      claim: options.claim,
      fs,
    });
    if (!created.ok) {
      return refuseClaim(
        "held",
        verdict,
        created.error ?? `${path} was re-created while it was being taken over`,
      );
    }
    return {
      ok: true,
      claim: options.claim,
      ...(verdict.kind === "held"
        ? { tookOverFrom: { taskId: verdict.claim.taskId, sessionId: verdict.claim.sessionId } }
        : {}),
      archivedPath,
    };
  } catch (error) {
    return refuseClaim("write-failed", verdict, archiveFailureText(path, error));
  }
}

/**
 * Re-verify a cold lease immediately before displacing it.
 *
 * A holder that renewed between the classification and the takeover is alive, and
 * archiving it would hand its worktree to a second orchestrator. `undefined` means
 * "still stale, go ahead"; a refusal means the caller must not take over.
 */
function recheckStaleLease(options: {
  acquire: AcquireOrchestratorClaimOptions;
  claim: OrchestratorClaim;
  fs: OrchestratorClaimFs;
  path: string;
}): AcquireOrchestratorClaimResult | undefined {
  const fresh = readOrchestratorClaim({
    worktreePath: options.acquire.worktreePath,
    fs: options.fs,
  });
  const unchanged =
    fresh.kind === "ok" &&
    fresh.claim.sessionId === options.claim.sessionId &&
    fresh.claim.heartbeatAt === options.claim.heartbeatAt;
  if (!unchanged) {
    return refuseClaim(
      "held",
      { kind: "held", claim: options.claim, state: "stale", sameSession: false },
      `the lease at ${options.path} changed while it was being taken over`,
    );
  }
  const stillStale = classifyOrchestratorClaim({
    read: fresh,
    now: options.acquire.now,
    ...(options.acquire.staleAfterInMs === undefined
      ? {}
      : { staleAfterInMs: options.acquire.staleAfterInMs }),
  });
  if (stillStale.kind !== "held" || stillStale.state !== "stale") {
    return refuseClaim("held", stillStale, `the lease at ${options.path} is no longer stale`);
  }
  return undefined;
}

function archiveFailureText(path: string, error: unknown): string {
  return `could not archive the displaced lease at ${path}: ${errorMessage(error)}`;
}

/**
 * Create the lease for a worktree, atomically.
 *
 * Held leases are resolved by {@link takeOverDisplacedClaim}, which owns the
 * archive-and-replace decision so `adoptOrchestratorClaim` can share it.
 */
export function acquireOrchestratorClaim(
  options: AcquireOrchestratorClaimOptions,
): AcquireOrchestratorClaimResult {
  const fs = options.fs ?? orchestratorClaimFs;
  const claim = buildClaim(options);

  try {
    fs.mkdirSync(claimArchiveDir(options.worktreePath), { recursive: true });
  } catch (error) {
    return refuseClaim(
      "write-failed",
      { kind: "free" },
      `could not prepare .belayd/: ${errorMessage(error)}`,
    );
  }

  const created = createClaimExclusive({ worktreePath: options.worktreePath, claim, fs });
  if (created.ok) return { ok: true, claim };
  if (created.reason === "write-failed") {
    return refuseClaim(
      "write-failed",
      { kind: "free" },
      created.error ?? "could not create the lease",
    );
  }

  const verdict = classifyOrchestratorClaim({
    read: readOrchestratorClaim({ worktreePath: options.worktreePath, fs }),
    now: options.now,
    sessionId: options.sessionId,
    ...(options.staleAfterInMs === undefined ? {} : { staleAfterInMs: options.staleAfterInMs }),
  });

  if (verdict.kind === "free") {
    const retried = createClaimExclusive({ worktreePath: options.worktreePath, claim, fs });
    return retried.ok
      ? { ok: true, claim }
      : refuseClaim(
          "held",
          verdict,
          retried.error ??
            `${orchestratorClaimPath(options.worktreePath)} was re-created while claiming it`,
        );
  }
  const takeoverAllowed = options.takeOverStale === true;
  if (verdict.kind === "corrupt") {
    return takeoverAllowed
      ? takeOverDisplacedClaim({ acquire: options, claim, verdict, fs })
      : refuseClaim("corrupt", verdict, describeOrchestratorClaim(verdict));
  }
  if (verdict.state === "live" || !takeoverAllowed) {
    return refuseClaim("held", verdict, describeOrchestratorClaim(verdict));
  }
  return takeOverDisplacedClaim({ acquire: options, claim, verdict, fs });
}

/**
 * Renew a lease this session owns.
 *
 * A renewal from a session that does not hold the lease is refused, never
 * allowed to "refresh" someone else's record: the freshness of a lease is the
 * only evidence that its owner is still alive.
 */
export function heartbeatOrchestratorClaim(options: {
  worktreePath: string;
  sessionId: string;
  now: number;
  fs?: OrchestratorClaimFs;
}): { ok: true; claim: OrchestratorClaim } | { ok: false; reason: string; error: string } {
  const fs = options.fs ?? orchestratorClaimFs;
  const read = readOrchestratorClaim({ worktreePath: options.worktreePath, fs });
  if (read.kind === "absent") {
    return { ok: false, reason: "missing", error: "no orchestrator lease to renew" };
  }
  if (read.kind === "corrupt") {
    return { ok: false, reason: "corrupt", error: read.error };
  }
  if (read.claim.sessionId !== options.sessionId) {
    return {
      ok: false,
      reason: "not-owner",
      error: `the lease names session ${read.claim.sessionId}, not ${options.sessionId}`,
    };
  }
  const next: OrchestratorClaim = {
    ...read.claim,
    heartbeatAt: Math.max(read.claim.heartbeatAt, options.now),
  };
  try {
    writeClaimAtomically({ worktreePath: options.worktreePath, claim: next, now: options.now, fs });
    return { ok: true, claim: next };
  } catch (error) {
    return {
      ok: false,
      reason: "write-failed",
      error: `could not renew ${orchestratorClaimPath(options.worktreePath)}: ${errorMessage(error)}`,
    };
  }
}

/**
 * Replace a lease this session already holds.
 *
 * Used by a same-directory handoff: the caller is the worktree's orchestrator, so
 * the spawner must be able to turn the caller's lease into the child's `pending`
 * one. Refuses unless the record still names `expectSessionId`, so a lease that
 * another session took over is never silently stolen back.
 */
export function replaceOrchestratorClaim(options: {
  worktreePath: string;
  expectSessionId: string;
  taskId: string;
  branch: string;
  sessionId: string;
  pid: number;
  now: number;
  fs?: OrchestratorClaimFs;
}):
  | { ok: true; claim: OrchestratorClaim }
  | { ok: false; reason: "not-owner" | "write-failed"; error: string } {
  const fs = options.fs ?? orchestratorClaimFs;
  const read = readOrchestratorClaim({ worktreePath: options.worktreePath, fs });
  if (read.kind !== "ok") {
    return { ok: false, reason: "not-owner", error: "no orchestrator lease to replace" };
  }
  if (read.claim.sessionId !== options.expectSessionId) {
    return {
      ok: false,
      reason: "not-owner",
      error: `the lease names session ${read.claim.sessionId}, not ${options.expectSessionId}`,
    };
  }
  const claim = buildClaim(options);
  try {
    writeClaimAtomically({ worktreePath: options.worktreePath, claim, now: options.now, fs });
    return { ok: true, claim };
  } catch (error) {
    return { ok: false, reason: "write-failed", error: errorMessage(error) };
  }
}

/** Remove a lease this session owns (best effort; a stale record is recoverable). */
export function releaseOrchestratorClaim(options: {
  worktreePath: string;
  sessionId: string;
  fs?: OrchestratorClaimFs;
}): { ok: true; released: boolean } | { ok: false; error: string } {
  const fs = options.fs ?? orchestratorClaimFs;
  const read = readOrchestratorClaim({ worktreePath: options.worktreePath, fs });
  if (read.kind !== "ok") return { ok: true, released: false };
  if (read.claim.sessionId !== options.sessionId) return { ok: true, released: false };
  try {
    fs.unlinkSync(orchestratorClaimPath(options.worktreePath));
    return { ok: true, released: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export type AdoptOrchestratorClaimResult =
  | {
      ok: true;
      claim: OrchestratorClaim;
      /** How this session came to hold the lease. */
      adopted: "fresh" | "own" | "pending" | "stale" | "corrupt";
      /** Where a displaced record was archived (`stale`/`corrupt` only). */
      archivedPath?: string;
    }
  | { ok: false; reason: "held"; verdict: OrchestratorClaimVerdict; error: string };

/**
 * Become the worktree's orchestrator, or refuse because another live session is.
 *
 * Called from a session's own `session_start`, which is where the worktree's
 * ownership actually has to be settled: the spawner can create a lease but cannot
 * know the session id, and a session that is *not* the spawner's (a human opening
 * the worktree, or a second launch) must be refused rather than allowed to drive a
 * workflow that another session owns.
 *
 * Adoption order is what makes a concurrent double launch safe: the pending lease
 * belongs to whichever session arrives first, and the second one finds a live lease
 * for a different session and backs off.
 */
export function adoptOrchestratorClaim(options: {
  worktreePath: string;
  taskId: string;
  branch: string;
  sessionId: string;
  pid: number;
  now: number;
  staleAfterInMs?: number;
  fs?: OrchestratorClaimFs;
}): AdoptOrchestratorClaimResult {
  const fs = options.fs ?? orchestratorClaimFs;
  const verdict = classifyOrchestratorClaim({
    read: readOrchestratorClaim({ worktreePath: options.worktreePath, fs }),
    now: options.now,
    sessionId: options.sessionId,
    ...(options.staleAfterInMs === undefined ? {} : { staleAfterInMs: options.staleAfterInMs }),
  });

  switch (verdict.kind) {
    case "free":
    case "corrupt":
      return adoptByAcquire(options, verdict.kind === "corrupt" ? "corrupt" : "fresh", fs);
    case "held":
      if (verdict.sameSession) return renewAdoptedClaim(options, verdict, fs);
      if (isPendingOrchestratorClaim(verdict.claim)) return adoptPendingClaim(options, verdict, fs);
      if (verdict.state === "live") {
        return { ok: false, reason: "held", verdict, error: describeOrchestratorClaim(verdict) };
      }
      return adoptByAcquire(options, "stale", fs);
  }
}

function adoptByAcquire(
  options: Parameters<typeof adoptOrchestratorClaim>[0],
  adopted: "fresh" | "stale" | "corrupt",
  fs: OrchestratorClaimFs,
): AdoptOrchestratorClaimResult {
  const acquired = acquireOrchestratorClaim({
    worktreePath: options.worktreePath,
    taskId: options.taskId,
    branch: options.branch,
    sessionId: options.sessionId,
    pid: options.pid,
    now: options.now,
    takeOverStale: true,
    ...(options.staleAfterInMs === undefined ? {} : { staleAfterInMs: options.staleAfterInMs }),
    fs,
  });
  if (!acquired.ok) {
    return { ok: false, reason: "held", verdict: acquired.verdict, error: acquired.error };
  }
  return {
    ok: true,
    claim: acquired.claim,
    adopted,
    ...(acquired.archivedPath === undefined ? {} : { archivedPath: acquired.archivedPath }),
  };
}

function renewAdoptedClaim(
  options: Parameters<typeof adoptOrchestratorClaim>[0],
  verdict: OrchestratorClaimVerdict,
  fs: OrchestratorClaimFs,
): AdoptOrchestratorClaimResult {
  const renewed = heartbeatOrchestratorClaim({
    worktreePath: options.worktreePath,
    sessionId: options.sessionId,
    now: options.now,
    fs,
  });
  if (!renewed.ok) return { ok: false, reason: "held", verdict, error: renewed.error };
  return { ok: true, claim: renewed.claim, adopted: "own" };
}

/** Take over the spawner's placeholder lease (the first session to start wins). */
function adoptPendingClaim(
  options: Parameters<typeof adoptOrchestratorClaim>[0],
  verdict: Extract<OrchestratorClaimVerdict, { kind: "held" }>,
  fs: OrchestratorClaimFs,
): AdoptOrchestratorClaimResult {
  const adopted: OrchestratorClaim = {
    ...verdict.claim,
    sessionId: options.sessionId,
    pid: options.pid,
    claimedAt: options.now,
    heartbeatAt: options.now,
  };
  try {
    writeClaimAtomically({
      worktreePath: options.worktreePath,
      claim: adopted,
      now: options.now,
      fs,
    });
    return { ok: true, claim: adopted, adopted: "pending" };
  } catch (error) {
    return { ok: false, reason: "held", verdict, error: errorMessage(error) };
  }
}

/**
 * Point a spawner's pending lease at the session id the daemon just returned.
 *
 * Idempotent: the child may have adopted the lease first (same id), and a lease
 * already naming a different session is left alone — that session owns it now.
 */
export function assignOrchestratorClaimSession(options: {
  worktreePath: string;
  fromSessionId: string;
  toSessionId: string;
  now: number;
  fs?: OrchestratorClaimFs;
}): { ok: true; assigned: boolean } | { ok: false; error: string } {
  const fs = options.fs ?? orchestratorClaimFs;
  const read = readOrchestratorClaim({ worktreePath: options.worktreePath, fs });
  if (read.kind !== "ok") return { ok: true, assigned: false };
  if (read.claim.sessionId === options.toSessionId) return { ok: true, assigned: false };
  if (read.claim.sessionId !== options.fromSessionId) return { ok: true, assigned: false };
  try {
    writeClaimAtomically({
      worktreePath: options.worktreePath,
      claim: { ...read.claim, sessionId: options.toSessionId },
      now: options.now,
      fs,
    });
    return { ok: true, assigned: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
