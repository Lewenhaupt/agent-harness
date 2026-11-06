/**
 * One-orchestrator-per-worktree lease.
 *
 * A worktree may host at most one orchestrator session. That is the invariant
 * every phase tool already assumes (one process gate = one bead = one worktree),
 * and breaking it is not theoretical: two orchestrators on one branch share
 * the worktree's workflow row and run rows, so each one overwrites the other's
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
 * The lease is a row in the per-repository execution store (bd-281), keyed by
 * **task id** and unique per worktree. Acquisition is one conditional
 * `BEGIN IMMEDIATE` upsert, so two racing sessions cannot both win even in the same
 * millisecond — that SQL is what replaced the `wx` exclusive-create trick *and* the
 * "re-read immediately before archiving" dance the file version needed. A stale
 * lease is cold on its own `expires_at`, so takeover is one conditional update and
 * never an archive-and-replace of a file another session might be renewing.
 *
 * Split like the rest of the family: parsing and classification are pure; the four
 * side effects (acquire, renew, release, adopt) take an injected store seam so tests
 * never need a real worktree or a real repository.
 */

import { join } from "node:path";
import { z } from "zod";
import {
  type RepoLeaseAcquire,
  type RepoStateStore,
  sharedRepoStateStore,
} from "./repo-state-store.js";

/**
 * Retired lease file name (bd-281).
 *
 * Kept because the migration refusal, the import and diagnostics name it; nothing
 * reads or writes it any more.
 */
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

/**
 * The store the lease reads and writes.
 *
 * Injected by tests; in production it is the shared per-repository store, which
 * every worktree of the repository resolves to the same file.
 */
export interface OrchestratorClaimStoreSeam {
  store?: RepoStateStore;
}

/** Retired lease path for a worktree directory (naming only). */
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
  | { kind: "corrupt"; error: string };

/** The store for this call: the injected one, else the shared repository store. */
function storeFor(
  options: OrchestratorClaimStoreSeam & { worktreePath: string },
): RepoStateStore | null {
  if (options.store !== undefined) return options.store;
  return sharedRepoStateStore({ cwd: options.worktreePath }).store;
}

/** Map a stored lease row to the persisted record shape, then validate it. */
function claimFromRow(lease: {
  taskId: string;
  branch: string;
  sessionId: string;
  pid: number;
  claimedAt: number;
  heartbeatAt: number;
}): OrchestratorClaim | undefined {
  return parseOrchestratorClaim({
    schemaVersion: ORCHESTRATOR_CLAIM_SCHEMA_VERSION,
    taskId: lease.taskId,
    branch: lease.branch,
    sessionId: lease.sessionId,
    pid: lease.pid,
    claimedAt: lease.claimedAt,
    heartbeatAt: lease.heartbeatAt,
  });
}

/**
 * Read the lease for a worktree. Absence is normal; a row that does not parse is
 * reported instead of being silently treated as free.
 *
 * The lookup is by worktree path as a *locator*: the lease's identity is the task
 * it names, but "who drives this directory" is the question a session asks.
 */
export function readOrchestratorClaim(
  options: OrchestratorClaimStoreSeam & { worktreePath: string },
): OrchestratorClaimRead {
  const store = storeFor(options);
  if (store === null) return { kind: "absent" };
  const row = store.readLease({ worktreePath: options.worktreePath });
  if (!row.ok) return { kind: "corrupt", error: row.error };
  if (row.value === null) return { kind: "absent" };
  const claim = claimFromRow(row.value);
  return claim === undefined
    ? { kind: "corrupt", error: `the lease for ${row.value.taskId} does not parse` }
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
  | { kind: "corrupt"; error: string };

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
      return `unreadable orchestrator lease (${verdict.error})`;
    case "held": {
      const state = verdict.state === "live" ? "live" : "stale";
      return `${state} orchestrator lease for ${verdict.claim.taskId} (session ${verdict.claim.sessionId})`;
    }
  }
}

export interface AcquireOrchestratorClaimOptions extends OrchestratorClaimStoreSeam {
  worktreePath: string;
  taskId: string;
  branch: string;
  sessionId: string;
  pid: number;
  now: number;
  /**
   * Take over a cold lease instead of refusing.
   *
   * A cold lease is not proof the worktree is unused — it is evidence its owner
   * stopped renewing — so takeover is a decision the caller must make explicitly
   * and report instead of a default.
   */
  takeOverStale?: boolean;
  staleAfterInMs?: number;
}

export type AcquireOrchestratorClaimResult =
  | {
      ok: true;
      claim: OrchestratorClaim;
      /** Set when a cold lease was displaced to make room. */
      tookOverFrom?: { taskId: string; sessionId: string };
    }
  | {
      ok: false;
      reason: "held" | "corrupt" | "write-failed";
      verdict: OrchestratorClaimVerdict;
      error: string;
    };

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

/** The lease window: the caller's stale threshold, else the harness's 9 x 20 s. */
function leaseTtlInMs(acquire: { staleAfterInMs?: number }): number {
  return acquire.staleAfterInMs ?? ORCHESTRATOR_CLAIM_STALE_MS;
}

/**
 * Claim the worktree's lease.
 *
 * Mutual exclusion is the store's single conditional upsert: the row is read and
 * written inside one `BEGIN IMMEDIATE`, so two sessions racing for one worktree
 * still produce exactly one winner, and the loser is handed the winner's identity
 * rather than a copy that it might later "refresh". A cold lease is taken over
 * only when the caller says so — cold is evidence of stopped renewal, not proof of
 * death — and the takeover is one conditional write, which is why this module no
 * longer re-reads the record before displacing it.
 */
export function acquireOrchestratorClaim(
  options: AcquireOrchestratorClaimOptions,
): AcquireOrchestratorClaimResult {
  const store = storeFor(options);
  const claim = buildClaim(options);
  if (store === null) {
    return refuseClaim(
      "write-failed",
      { kind: "free" },
      `repo state store unavailable for ${options.worktreePath}`,
    );
  }

  const acquired = store.acquireLease({
    taskId: options.taskId,
    sessionId: options.sessionId,
    branch: options.branch,
    worktreePath: options.worktreePath,
    pid: options.pid,
    nowMs: options.now,
    ttlMs: leaseTtlInMs(options),
    ...(options.takeOverStale === true ? { takeOverStale: true } : {}),
  });

  if (acquired.ok) {
    return {
      ok: true,
      claim,
      ...(acquired.tookOverFrom === undefined ? {} : { tookOverFrom: acquired.tookOverFrom }),
    };
  }
  return refusalFor(options, store, claim, acquired);
}

/**
 * The refusal for a store rejection, including the corrupt-row takeover.
 *
 * Split out of {@link acquireOrchestratorClaim} because the decision has three
 * outcomes (free, held, unreadable holder) and each names a different remedy.
 */
function refusalFor(
  options: AcquireOrchestratorClaimOptions,
  store: RepoStateStore,
  claim: OrchestratorClaim,
  acquired: Extract<RepoLeaseAcquire, { ok: false }>,
): AcquireOrchestratorClaimResult {
  const holder = acquired.holder;
  if (holder === null) {
    return refuseClaim(
      acquired.reason === "held" ? "held" : "write-failed",
      { kind: "free" },
      acquired.error,
    );
  }
  const parsed = claimFromRow(holder);
  if (parsed !== undefined) {
    return refuseClaim(
      acquired.reason === "held" ? "held" : "write-failed",
      {
        kind: "held",
        claim: parsed,
        state: holder.expiresAt > options.now ? "live" : "stale",
        sameSession: holder.sessionId === options.sessionId,
      },
      acquired.error,
    );
  }
  // A row that no longer matches the record schema is reported as corrupt, not as a
  // live holder. A caller that explicitly takes over stale records may replace it,
  // and the replacement is a compare-and-swap on the exact session id it just saw,
  // so it cannot clobber a record another session rewrote in between.
  if (options.takeOverStale !== true) {
    return refuseClaim("corrupt", { kind: "corrupt", error: acquired.error }, acquired.error);
  }
  const replaced = store.replaceLease({
    taskId: holder.taskId === "" ? options.taskId : holder.taskId,
    expectSessionId: holder.sessionId,
    sessionId: options.sessionId,
    branch: options.branch,
    worktreePath: options.worktreePath,
    pid: options.pid,
    nowMs: options.now,
    ttlMs: leaseTtlInMs(options),
  });
  return replaced.ok
    ? { ok: true, claim }
    : refuseClaim("corrupt", { kind: "corrupt", error: replaced.error }, replaced.error);
}

/**
 * Renew a lease this session owns.
 *
 * A renewal from a session that does not hold the lease is refused, never allowed
 * to "refresh" someone else's record: the freshness of a lease is the only evidence
 * that its owner is still alive.
 */
export function heartbeatOrchestratorClaim(
  options: OrchestratorClaimStoreSeam & {
    worktreePath: string;
    sessionId: string;
    now: number;
    staleAfterInMs?: number;
  },
): { ok: true; claim: OrchestratorClaim } | { ok: false; reason: string; error: string } {
  const store = storeFor(options);
  if (store === null) {
    return { ok: false, reason: "write-failed", error: "repo state store unavailable" };
  }
  const current = store.readLease({ worktreePath: options.worktreePath });
  if (!current.ok) return { ok: false, reason: "corrupt", error: current.error };
  if (current.value === null) {
    return { ok: false, reason: "missing", error: "no orchestrator lease to renew" };
  }
  const renewed = store.heartbeatLease({
    taskId: current.value.taskId,
    sessionId: options.sessionId,
    nowMs: options.now,
    ttlMs: leaseTtlInMs(options),
  });
  if (!renewed.ok) return { ok: false, reason: renewed.reason, error: renewed.error };
  const claim = claimFromRow(renewed.lease);
  return claim === undefined
    ? { ok: false, reason: "corrupt", error: "the renewed lease does not parse" }
    : { ok: true, claim };
}

/**
 * Replace a lease this session already holds.
 *
 * Used by a same-directory handoff: the caller is the worktree's orchestrator, so
 * the spawner turns the caller's lease into the child's `pending` one. Ownership is
 * part of the write (`WHERE session_id = ?`), so a lease another session has taken
 * over is never silently stolen back.
 */
export function replaceOrchestratorClaim(
  options: OrchestratorClaimStoreSeam & {
    worktreePath: string;
    expectSessionId: string;
    taskId: string;
    branch: string;
    sessionId: string;
    pid: number;
    now: number;
    staleAfterInMs?: number;
  },
):
  | { ok: true; claim: OrchestratorClaim }
  | { ok: false; reason: "not-owner" | "write-failed"; error: string } {
  const store = storeFor(options);
  if (store === null)
    return { ok: false, reason: "write-failed", error: "repo state store unavailable" };
  const replaced = store.replaceLease({
    taskId: options.taskId,
    expectSessionId: options.expectSessionId,
    sessionId: options.sessionId,
    branch: options.branch,
    worktreePath: options.worktreePath,
    pid: options.pid,
    nowMs: options.now,
    ttlMs: leaseTtlInMs(options),
  });
  if (!replaced.ok) {
    return {
      ok: false,
      reason: replaced.reason === "not-owner" ? "not-owner" : "write-failed",
      error: replaced.error,
    };
  }
  const claim = claimFromRow(replaced.lease);
  if (claim === undefined) {
    return { ok: false, reason: "write-failed", error: "the replaced lease does not parse" };
  }
  return { ok: true, claim };
}

/** Remove a lease this session owns (best effort; a stale record is recoverable). */
export function releaseOrchestratorClaim(
  options: OrchestratorClaimStoreSeam & {
    worktreePath: string;
    sessionId: string;
  },
): { ok: true; released: boolean } | { ok: false; error: string } {
  const store = storeFor(options);
  if (store === null) return { ok: true, released: false };
  const released = store.releaseLease({
    worktreePath: options.worktreePath,
    sessionId: options.sessionId,
  });
  return released.ok
    ? { ok: true, released: released.value.released }
    : { ok: false, error: released.error };
}

export type AdoptOrchestratorClaimResult =
  | {
      ok: true;
      claim: OrchestratorClaim;
      /** How this session came to hold the lease. */
      adopted: "fresh" | "own" | "pending" | "stale" | "corrupt";
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
 * for a different session and backs off. Every step is one store transaction, so
 * the order needs no re-read to stay correct.
 */
export function adoptOrchestratorClaim(
  options: OrchestratorClaimStoreSeam & {
    worktreePath: string;
    taskId: string;
    branch: string;
    sessionId: string;
    pid: number;
    now: number;
    staleAfterInMs?: number;
  },
): AdoptOrchestratorClaimResult {
  const verdict = classifyOrchestratorClaim({
    read: readOrchestratorClaim(options),
    now: options.now,
    sessionId: options.sessionId,
    ...(options.staleAfterInMs === undefined ? {} : { staleAfterInMs: options.staleAfterInMs }),
  });

  switch (verdict.kind) {
    case "free":
    case "corrupt":
      return adoptByAcquire(options, verdict.kind === "corrupt" ? "corrupt" : "fresh");
    case "held":
      if (verdict.sameSession) return renewAdoptedClaim(options, verdict);
      if (isPendingOrchestratorClaim(verdict.claim)) return adoptPendingClaim(options, verdict);
      if (verdict.state === "live") {
        return { ok: false, reason: "held", verdict, error: describeOrchestratorClaim(verdict) };
      }
      return adoptByAcquire(options, "stale");
  }
}

function adoptByAcquire(
  options: Omit<AcquireOrchestratorClaimOptions, "takeOverStale">,
  adopted: "fresh" | "stale" | "corrupt",
): AdoptOrchestratorClaimResult {
  const acquired = acquireOrchestratorClaim({ ...options, takeOverStale: true });
  if (!acquired.ok) {
    return { ok: false, reason: "held", verdict: acquired.verdict, error: acquired.error };
  }
  return { ok: true, claim: acquired.claim, adopted };
}

function renewAdoptedClaim(
  options: Omit<AcquireOrchestratorClaimOptions, "takeOverStale">,
  verdict: Extract<OrchestratorClaimVerdict, { kind: "held" }>,
): AdoptOrchestratorClaimResult {
  const renewed = heartbeatOrchestratorClaim({
    worktreePath: options.worktreePath,
    sessionId: options.sessionId,
    now: options.now,
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.staleAfterInMs === undefined ? {} : { staleAfterInMs: options.staleAfterInMs }),
  });
  if (!renewed.ok) return { ok: false, reason: "held", verdict, error: renewed.error };
  return { ok: true, claim: renewed.claim, adopted: "own" };
}

/** Take over the spawner's placeholder lease (the first session to start wins). */
function adoptPendingClaim(
  options: Omit<AcquireOrchestratorClaimOptions, "takeOverStale">,
  verdict: Extract<OrchestratorClaimVerdict, { kind: "held" }>,
): AdoptOrchestratorClaimResult {
  const store = storeFor(options);
  if (store === null) {
    return { ok: false, reason: "held", verdict, error: "repo state store unavailable" };
  }
  const adopted = store.assignLeaseSession({
    taskId: options.taskId,
    worktreePath: options.worktreePath,
    pendingSessionId: verdict.claim.sessionId,
    sessionId: options.sessionId,
    branch: options.branch,
    worktreePathValue: options.worktreePath,
    pid: options.pid,
    nowMs: options.now,
    ttlMs: leaseTtlInMs(options),
  });
  if (!adopted.ok) return { ok: false, reason: "held", verdict, error: adopted.error };
  const claim = claimFromRow(adopted.lease);
  if (claim === undefined) {
    return { ok: false, reason: "held", verdict, error: "the adopted lease does not parse" };
  }
  return { ok: true, claim, adopted: "pending" };
}

/**
 * Point a spawner's pending lease at the session id the daemon just returned.
 *
 * Idempotent: the child may have adopted the lease first (same id), and a lease
 * already naming a different session is left alone — that session owns it now.
 */
export function assignOrchestratorClaimSession(
  options: OrchestratorClaimStoreSeam & {
    worktreePath: string;
    fromSessionId: string;
    toSessionId: string;
    now: number;
  },
): { ok: true; assigned: boolean } | { ok: false; error: string } {
  const store = storeFor(options);
  if (store === null) return { ok: true, assigned: false };
  const current = store.readLease({ worktreePath: options.worktreePath });
  if (!current.ok) return { ok: false, error: current.error };
  if (current.value === null) return { ok: true, assigned: false };
  if (current.value.sessionId === options.toSessionId) return { ok: true, assigned: false };
  if (current.value.sessionId !== options.fromSessionId) return { ok: true, assigned: false };
  const assigned = store.assignLeaseSession({
    taskId: current.value.taskId,
    pendingSessionId: options.fromSessionId,
    sessionId: options.toSessionId,
    nowMs: options.now,
  });
  if (!assigned.ok) return { ok: false, error: assigned.error };
  return { ok: true, assigned: true };
}
