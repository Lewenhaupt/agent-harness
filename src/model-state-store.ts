/**
 * Shared model-state store (bd-187) — cooldown, capacity/lease and spend in one
 * SQLite file, so every process on the host agrees on one budget.
 *
 * The API key is globally shared, but before this store each process kept its
 * own opinion of cooldown, capacity and spend. Two repo daemons therefore each
 * believed they owned the remaining budget and burned into the same 429. This
 * is the shared truth they read and write instead.
 *
 * Storage is `node:sqlite` (`DatabaseSync`) in WAL mode at
 * `$XDG_STATE_HOME/belayd/model-state.sqlite` (override
 * `BELAYD_MODEL_STATE_FILE`). Leases expire by wall clock, never by pid
 * liveness: a SIGKILLed daemon (the bd-166/bd-167 failure shape) cannot release
 * anything, so a time-based expiry is the only release path that survives it.
 *
 * Deliberate non-feature: there is **no cross-process in-flight coalescing**.
 * Two processes can both see free capacity and both dispatch; the store bounds
 * concurrency and records the aftermath, it does not deduplicate live requests.
 * Coalescing identical in-flight requests is a proxy feature and was explicitly
 * rejected with the gateway design (bd-188).
 *
 * Writes are short `BEGIN IMMEDIATE` transactions; reserve/release recomputes
 * `in_use` from the lease table inside the transaction, so the counter cannot
 * drift from the leases. Every lease carries its owner (`host`, `daemon_pid`) so
 * only the process that reserved a slot can free it. Reads are cached for
 * {@link MODEL_STATE_READ_CACHE_MAX_AGE_MS} because one dispatch reads twice
 * (cooldown then capacity) and re-reading SQLite synchronously per read is
 * waste; writes invalidate the cache, and a failed read is never cached.
 *
 * The wrapper reserves a lease for the duration of a stream and releases it when
 * that stream settles, so `in_use` is the live cross-process concurrency, not a
 * stale counter.
 *
 * Errors are values: a store that cannot be opened returns `{ ok: false }`, and
 * a failed state read must never fail a spawn or a turn. `readOnly` opens the
 * file without write access, which is an acceptance criterion: the wrapper must
 * keep serving with a read-only state store.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  addColumnIfMissing,
  asRow,
  classifyStoreFailure,
  errorMessage,
  inImmediateTransaction,
  openSqliteFile,
  readNumber,
  readOptionalNumber,
  readString,
  type SqliteDatabaseLike,
  type StoreFailureClass,
  tightenStoreFileModes,
} from "./sqlite-store-open.js";

// Re-exported so the hardening has exactly one implementation while the model
// store's public surface (and its tests) keep importing it from here.
export {
  classifyStoreFailure,
  type SqliteDatabaseLike,
  type SqliteStatementLike,
  type SqlValue,
  type StoreFailureClass,
} from "./sqlite-store-open.js";

/** Override for the store path, matching the `BELAYD_MODEL_COOLDOWN_FILE` precedent. */
export const MODEL_STATE_FILE_ENV = "BELAYD_MODEL_STATE_FILE";

/**
 * Retired JSON cooldown file (bd-38/bd-116). Still honoured as a location: when
 * it is set and no state path is, the state store lives beside it, so an
 * operator who configured it keeps one store rather than silently moving.
 */
export const LEGACY_COOLDOWN_FILE_ENV = "BELAYD_MODEL_COOLDOWN_FILE";

/**
 * Schema marker written to `PRAGMA user_version`, so a future migration is possible.
 *
 * v2 added the cooldown diagnostics columns (`cause`, `escalations`,
 * `last_mark_ms`) that the routing adapter needs; v1 databases are migrated in
 * place by {@link migrateCooldownSchema}.
 */
export const MODEL_STATE_SCHEMA_VERSION = 2;

/**
 * Bounded retries for the schema/migration step. A concurrent fleet member
 * opening the same v1 file holds the write lock; the loser waits inside the
 * store's busy timeout and retries rather than reporting an unopenable store.
 */
const SCHEMA_MIGRATION_ATTEMPTS = 3;

/**
 * Each repeated unhinted cooldown doubles the window: a guess that already
 * proved too short must not be reused verbatim.
 */
export const COOLDOWN_ESCALATION_FACTOR = 2;
/**
 * Ceiling on an escalated window (24 h). A single day bounds the damage of a
 * wrong guess: the provider is re-probed at least daily even if escalation ran
 * long.
 */
export const MAX_ESCALATED_COOLDOWN_SECONDS = 24 * 60 * 60;
/**
 * How long the escalation ladder is remembered after the last mark (7 days). A
 * weekly bucket that resets and re-exhausts inside a week is the same limit
 * escalating, not a fresh one.
 */
export const COOLDOWN_ESCALATION_MEMORY_MS = 7 * 86_400_000;

/**
 * Read-cache window, mirroring `COOLDOWN_REFRESH_MAX_AGE_MS`: one dispatch reads
 * cooldown and capacity, and the second read should not hit SQLite again. Far
 * below every cooldown window, so another process's cooldown is still observed
 * "immediately" from the operator's point of view.
 */
export const MODEL_STATE_READ_CACHE_MAX_AGE_MS = 1_000;

/**
 * How long a capacity lease lives without a renewal.
 *
 * A live stream renews at roughly a third of this (see
 * `leaseRenewalIntervalInMs` in `provider-policy.ts`), so the TTL only has to
 * cover the gap between renewals and the worst-case scheduler hiccup — not the
 * whole stream. Ten minutes bounds how long a SIGKILLed daemon's slot stays
 * held while leaving generous headroom for a stalled renewal tick.
 */
export const DEFAULT_CAPACITY_LEASE_TTL_MS = 10 * 60_000;

/**
 * Sentinel `model` value for a provider-wide cooldown row. The bead's schema has
 * no scope column and no NULLable key, so "the whole provider" is a reserved
 * model name rather than a second table.
 */
export const PROVIDER_SCOPE_MODEL = "*";

/**
 * Normalize a provider key: an absent or empty provider means "any provider",
 * i.e. the window belongs to a bare model id and is stored provider-agnostically
 * (`*`).
 */
export function cooldownProviderKey(provider: string | undefined): string {
  return provider === undefined || provider === "" ? PROVIDER_SCOPE_MODEL : provider;
}

/**
 * The state file that backs a legacy cooldown path: `model-cooldowns.json` ->
 * `model-cooldowns.sqlite`. One rule, used by {@link resolveModelStatePath} and
 * by the routing adapter's legacy import, so the two cannot disagree about
 * where the single truth lives.
 */
export function modelStatePathForCooldownFile(filePath: string): string {
  return `${filePath.replace(/\.json$/i, "")}.sqlite`;
}

/** Errors as values, per the repo convention. */
export type ModelStateResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** One cooldown row, as read back. */
export interface CooldownRecord {
  provider: string;
  /** {@link PROVIDER_SCOPE_MODEL} for a provider-wide window. */
  model: string;
  untilMs: number;
  reason: string;
  /**
   * The window this mark used: the provider-supplied hint when hinted, else the
   * harness guess. An unhinted repeat doubles the stored value, so this is also
   * where the escalation ladder lives (the bead's schema has no count column).
   */
  retryAfterMs: number;
  /** Stable cause tag, set on provider-wide windows only. */
  cause?: CooldownCause;
  /** The escalation rung this window used; absent on hinted and model windows. */
  escalations?: number;
  /** Epoch ms of the mark that produced this window. */
  lastMarkedAt?: number;
}

/** Which cooldown scope is blocking a dispatch, when one is. */
export type CooldownScope = "provider" | "model";

/**
 * Stable cause tag for a provider-wide cooldown.
 *
 * `reason` is display text and must never be branched on, so consumers that need
 * to know *why* a provider is cooling read this instead: the capacity probe must
 * not treat a missing credential as spent capacity, and the fallback loop's skip
 * rows report which of the two causes skipped the provider.
 */
export type CooldownCause = "quota" | "unconfigured";

/**
 * One stored cooldown row. `listCooldowns` returns only rows that are still
 * active at the caller's clock; the retired/expired ones are not interesting and
 * `prune` deletes them.
 */
export interface CooldownRow {
  provider: string;
  /** {@link PROVIDER_SCOPE_MODEL} for a provider-wide or provider-agnostic row. */
  model: string;
  untilMs: number;
  reason: string;
  retryAfterMs: number;
  cause?: CooldownCause;
  escalations?: number;
  lastMarkedAt: number;
}

/** The active cooldown affecting one provider/model pair. */
export interface ActiveCooldown {
  scope: CooldownScope;
  untilMs: number;
  reason: string;
  retryAfterMs: number;
}

/** A capacity row as read back. `configured: false` means no limit was ever set. */
export interface CapacitySnapshot {
  provider: string;
  class: string;
  limit: number;
  inUse: number;
}

export interface ReserveCapacityInput {
  provider: string;
  class: string;
  limit: number;
  leaseId: string;
  /** Lease lifetime; defaults to {@link DEFAULT_CAPACITY_LEASE_TTL_MS}. */
  ttlMs?: number;
  /** Epoch-ms clock override (test seam). */
  nowMs?: number;
}

export interface ReleaseCapacityInput {
  provider: string;
  class: string;
  leaseId: string;
  /** Owner identity; defaults to this store's own host/pid (test seam). */
  host?: string;
  daemonPid?: number;
  nowMs?: number;
}

export interface RenewLeaseInput {
  leaseId: string;
  provider: string;
  class: string;
  /** New lifetime from `nowMs`; defaults to the store's configured TTL. */
  ttlMs?: number;
  /** Owner identity; defaults to this store's own host/pid (test seam). */
  host?: string;
  daemonPid?: number;
  nowMs?: number;
}

/**
 * Renewal outcome. An already-expired lease is never resurrectable: its slot may
 * already belong to another process, so the caller must stop treating it as
 * held rather than silently extending a dead reservation.
 */
export type LeaseRenewal =
  | { ok: true; value: { leaseId: string; expiresMs: number } }
  | {
      ok: false;
      reason: "lease-not-owned" | "lease-expired" | "store-error";
      error: string;
    };

/**
 * Release outcome is a union so an ownership mismatch is visible instead of
 * silently corrupting another process's `in_use`.
 */
export type CapacityRelease =
  | { ok: true; value: { released: boolean; inUse: number } }
  | { ok: false; reason: "lease-not-owned" | "store-error"; error: string };

/** Reserve outcome is a decision, not an error: full capacity is not exceptional. */
export type CapacityReservation =
  | {
      granted: true;
      leaseId: string;
      provider: string;
      class: string;
      inUse: number;
      limit: number;
      expiresMs: number;
    }
  | {
      granted: false;
      reason: "capacity-exhausted";
      provider: string;
      class: string;
      inUse: number;
      limit: number;
    };

export interface SpendRow {
  ts: number;
  provider: string;
  model: string;
  phase: string;
  taskId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SpendTotals {
  rows: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface MarkCooldownInput {
  /** Omitted or empty marks a bare model id, provider-agnostically. */
  provider?: string;
  /** `undefined` marks the whole provider; a model id marks one endpoint. */
  model?: string;
  durationMs: number;
  reason: string;
  /** True when `durationMs` came from a provider reset hint (authoritative). */
  hinted?: boolean;
  /** Stable cause tag, stored on provider-wide windows only. */
  cause?: CooldownCause;
  nowMs?: number;
}

/**
 * One window replayed from the retired JSON store (bd-256).
 *
 * Unlike {@link MarkCooldownInput}, this carries an absolute `untilMs` and the
 * escalation rung the legacy record already used: migration must reproduce the
 * window the previous build observed, not re-derive it from a duration (which
 * would reset an escalated weekly bucket to rung 1).
 */
export interface SeedCooldownInput {
  provider: string;
  /** `undefined` seeds a provider-wide row; a model id seeds one endpoint. */
  model?: string;
  /** Absolute epoch-ms window end from the legacy record. */
  untilMs: number;
  reason: string;
  cause?: CooldownCause;
  /**
   * Ladder rung the legacy row carried. Present on an unhinted provider window,
   * absent on a hinted window (whose ladder was cleared) and on model windows.
   */
  escalations?: number;
  /** Epoch ms of the legacy mark; defaults to now for pre-timestamp files. */
  lastMarkedAt?: number;
  nowMs?: number;
}

/** One escalation ladder rung replayed from the retired JSON store. */
export interface SeedCooldownLadderInput {
  provider: string;
  /** Zero is meaningful: the legacy file records a hinted reset as count 0. */
  escalations: number;
  lastMarkedAt: number;
  nowMs?: number;
}

export interface ModelStateStore {
  readonly path: string;
  readonly readOnly: boolean;
  /**
   * The active cooldown for one provider/model pair, or null when none is
   * active. Matches an exact endpoint row, a provider-wide row, and a
   * provider-agnostic (bare model) row, in that precedence order.
   */
  cooldownFor(input: {
    provider: string;
    model: string;
    nowMs?: number;
  }): ModelStateResult<ActiveCooldown | null>;
  /** Every cooldown row still active at `nowMs`, for the routing adapter. */
  listCooldowns(input?: { nowMs?: number }): ModelStateResult<CooldownRow[]>;
  /**
   * Drop the cooldown read cache, so the next read observes another process's
   * write. Used by the routing adapter's unbounded `refresh()`.
   */
  invalidateCooldownCache(): void;
  /**
   * Upsert a cooldown window. An unhinted provider-wide mark doubles the
   * previous guess (capped at {@link MAX_ESCALATED_COOLDOWN_SECONDS}); a hinted
   * mark replaces it exactly and resets the ladder.
   */
  markCooldown(input: MarkCooldownInput): ModelStateResult<CooldownRecord>;
  readCapacity(input: {
    provider: string;
    class: string;
    nowMs?: number;
  }): ModelStateResult<CapacitySnapshot>;
  reserveCapacity(input: ReserveCapacityInput): ModelStateResult<CapacityReservation>;
  /**
   * Release a lease. Ownership is enforced: a lease reserved by another
   * `host`/`daemon_pid` is refused as a value rather than silently freed. A
   * missing row (already released, or expired) is an idempotent no-op.
   */
  releaseCapacity(input: ReleaseCapacityInput): CapacityRelease;
  /**
   * Extend a live lease. Ownership-checked like release; an expired or gone
   * lease returns `{ ok: false, reason: "lease-expired" }`.
   */
  renewLease(input: RenewLeaseInput): LeaseRenewal;
  recordSpend(row: SpendRow): ModelStateResult<null>;
  spendTotals(): ModelStateResult<SpendTotals>;
  /**
   * Drop expired cooldowns, ladders past their escalation memory, and expired
   * leases. Expired rows are already invisible to every reader; this is the
   * garbage collection the fallback loop calls before selecting a candidate.
   */
  prune(nowMs?: number): ModelStateResult<{ cooldowns: number; leases: number }>;
  close(): void;
  /**
   * True only on the facade returned while the shared store is transiently
   * unavailable. Callers must not memoize such a store: the next access has to
   * pick up the real one (and its pending-mark flush).
   */
  readonly pendingFlush?: boolean;
}

/**
 * Migration-only write capability: replay absolute windows and ladder rungs from
 * the retired JSON store.
 *
 * Deliberately **not** a member of {@link ModelStateStore}. Seeding an absolute
 * window or resetting the ladder is a one-time migration concern, so ordinary
 * store consumers must not be able to reach it through `openModelStateStore()`'
 * result; the legacy importer obtains it from {@link modelStateSeederFor}.
 */
export interface ModelStateSeeder {
  /**
   * Replay one window. Longer window wins: an existing active row that ends
   * later is kept (returns `written: false`), so a migration can never shorten a
   * window another process already recorded. The unhinted ladder is replayed
   * separately by {@link ModelStateSeeder.seedCooldownLadder}, so this never
   * escalates or clears it.
   */
  seedCooldown(input: SeedCooldownInput): ModelStateResult<{ written: boolean }>;
  /**
   * Replay one escalation rung. Later mark wins (a hinted reset recorded as
   * count 0 replaces an older rung); a rung older than
   * {@link COOLDOWN_ESCALATION_MEMORY_MS} is dropped. Never touches a window.
   */
  seedCooldownLadder(input: SeedCooldownLadderInput): ModelStateResult<{ written: boolean }>;
}

/**
 * The migration capability for one store, or null when the store cannot provide
 * it (a read-only/unavailable facade). Held in a WeakMap so it is not enumerable
 * on the public store object and dies with it.
 */
const seederByStore = new WeakMap<ModelStateStore, ModelStateSeeder>();

/** Obtain the legacy-migration capability for a store. Migration code only. */
export function modelStateSeederFor(store: ModelStateStore): ModelStateSeeder | null {
  return seederByStore.get(store) ?? null;
}

export type ModelStateOpen = { ok: true; store: ModelStateStore } | { ok: false; error: string };

export interface ModelStateEnv {
  env: Record<string, string | undefined>;
  homeDir?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Resolve the store path from an injected environment.
 *
 * `BELAYD_MODEL_STATE_FILE` wins; otherwise the retired
 * `BELAYD_MODEL_COOLDOWN_FILE` decides (its `.json` sibling becomes the one
 * state file, so a configured location keeps working); otherwise
 * `${XDG_STATE_HOME:-~/.local/state}/belayd/model-state.sqlite`, the same state
 * root as proof, metrics and the AWS audit log.
 */
export function resolveModelStatePath(options: ModelStateEnv): string {
  const override = nonEmpty(options.env[MODEL_STATE_FILE_ENV]);
  if (override !== undefined) return override;
  const legacy = nonEmpty(options.env[LEGACY_COOLDOWN_FILE_ENV]);
  if (legacy !== undefined) return modelStatePathForCooldownFile(legacy);
  const stateHome =
    nonEmpty(options.env.XDG_STATE_HOME) ??
    join(options.homeDir ?? options.env.HOME ?? homedir(), ".local", "state");
  return join(stateHome, "belayd", "model-state.sqlite");
}

/** Production path, resolved from the process environment. */
export function defaultModelStatePath(): string {
  return resolveModelStatePath({ env: process.env });
}

/**
 * Retry window after a transient shared open failure.
 *
 * bd-256 made this store the *only* cooldown truth, so a transient first-open
 * failure (a busy WAL writer, a migration in flight, a momentary IO error) must
 * not be memoized as "no store for this session". A transient failure is retried
 * no more often than this window; a permanent one stops retrying entirely.
 */
export const SHARED_MODEL_STATE_RETRY_MS = 30_000;

/** Cap on cooldown marks captured while the shared store is unavailable. */
export const MAX_PENDING_COOLDOWN_MARKS = 32;

/**
 * How long an *elapsed* captured mark may still be replayed after the store
 * comes back.
 *
 * This is not the replay bound: a mark whose window is still live is replayed
 * however long the outage lasted (a hinted 20-minute reset or a laddered weekly
 * bucket must not be dropped because the store was down for 11 minutes). The
 * bound only decides the fate of marks that were already expired when the open
 * succeeded. Memory is bounded by {@link MAX_PENDING_COOLDOWN_MARKS}.
 */
export const MAX_PENDING_COOLDOWN_AGE_MS = 10 * 60_000;

interface PendingCooldownMark {
  /** The original mark, with its effective clock frozen at queue time. */
  input: MarkCooldownInput;
  queuedAtMs: number;
}

/** The absolute window end a queued mark implies, from its frozen clock. */
function pendingUntilMs(mark: PendingCooldownMark): number {
  const markedAt = mark.input.nowMs ?? mark.queuedAtMs;
  return markedAt + Math.max(0, Math.round(mark.input.durationMs));
}

/** The store row a queued mark will write, as a comparable key. */
function pendingRowKey(mark: PendingCooldownMark): string {
  const provider = cooldownProviderKey(mark.input.provider);
  return `${provider}\u0000${mark.input.model ?? PROVIDER_SCOPE_MODEL}`;
}

/** undefined = never attempted; null would be nonsense here since failure is flagged separately. */
let sharedModelState: ModelStateStore | undefined;
let sharedOpenFailedAt: number | undefined;
/** Set once a failure is classified permanent: no further open attempts. */
let sharedPermanentlyUnavailable = false;
/** The failure class already warned about, so one outage logs once. */
let sharedWarnedClass: StoreFailureClass | undefined;
let pendingCooldownMarks: PendingCooldownMark[] = [];

/**
 * The store facade returned while the shared store is transiently unavailable.
 *
 * Reads stay permissive (nothing cooling) because persistence is gone for the
 * moment; capacity/lease/spend bookkeeping is refused (`readOnly` is true, and
 * every capacity method returns a store error), which the provider policy
 * already degrades to "dispatch without a lease". Only cooldown marks are
 * captured: a 402/429 observed during the outage is queued and replayed into the
 * real store by the next successful open, so the first real cooldown is never
 * lost.
 */
function pendingCooldownStore(path: string, now: () => number): ModelStateStore {
  const unavailable = (operation: string): ModelStateResult<never> => ({
    ok: false,
    error: `model state store is unavailable (${operation})`,
  });
  const unavailableLease = (
    operation: string,
  ): { ok: false; reason: "store-error"; error: string } => ({
    ok: false,
    reason: "store-error",
    error: `model state store is unavailable (${operation})`,
  });
  return {
    path,
    readOnly: true,
    pendingFlush: true,
    // Reads fail as values so the wrapper reports the decision as degraded
    // rather than believing an empty store; routing treats both as permissive.
    cooldownFor: () => unavailable("cooldownFor"),
    listCooldowns: () => unavailable("listCooldowns"),
    invalidateCooldownCache: () => undefined,
    markCooldown: (input) => ({ ok: true, value: enqueuePendingCooldown(input, now()) }),
    readCapacity: () => unavailable("readCapacity"),
    reserveCapacity: () => unavailable("reserveCapacity"),
    releaseCapacity: () => unavailableLease("releaseCapacity"),
    renewLease: () => unavailableLease("renewLease"),
    recordSpend: () => unavailable("recordSpend"),
    spendTotals: () => unavailable("spendTotals"),
    prune: () => unavailable("prune"),
    close: () => undefined,
  };
}

/**
 * Capture one mark for the next successful open.
 *
 * The effective clock is frozen into the queued input so replay reproduces the
 * window the failure actually implied, not a window starting at recovery time.
 * The queue is capped at {@link MAX_PENDING_COOLDOWN_MARKS}: one mark per store
 * row and a broken store hammered by a fallback loop would otherwise grow
 * without bound.
 */
function enqueuePendingCooldown(input: MarkCooldownInput, atMs: number): CooldownRecord {
  const markedAt = input.nowMs ?? atMs;
  const durationMs = Math.max(0, Math.round(input.durationMs));
  pendingCooldownMarks.push({ input: { ...input, nowMs: markedAt }, queuedAtMs: atMs });
  if (pendingCooldownMarks.length > MAX_PENDING_COOLDOWN_MARKS) {
    pendingCooldownMarks.splice(pendingEvictionIndex(atMs), 1);
  }
  return {
    provider: cooldownProviderKey(input.provider),
    model: input.model ?? PROVIDER_SCOPE_MODEL,
    untilMs: markedAt + durationMs,
    reason: input.reason,
    retryAfterMs: durationMs,
    lastMarkedAt: markedAt,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
}

/**
 * Which pending mark to drop when the cap is reached.
 *
 * Plain FIFO drops the oldest mark, which under a hammering fallback loop can be
 * the provider the fleet is actively failing on. Eviction order: a mark whose
 * window already elapsed (it cannot steer anything), then a duplicate of a row
 * queued with a longer window (the longer window is the truth), and only then
 * the oldest mark.
 */
function pendingEvictionIndex(atMs: number): number {
  const marks = pendingCooldownMarks;
  const stale = marks.findIndex((mark) => pendingUntilMs(mark) <= atMs);
  if (stale !== -1) return stale;
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    if (mark === undefined) continue;
    const untilMs = pendingUntilMs(mark);
    const key = pendingRowKey(mark);
    const superseded = marks.some((other, otherIndex) => {
      if (otherIndex === index || pendingRowKey(other) !== key) return false;
      const otherUntilMs = pendingUntilMs(other);
      return otherUntilMs > untilMs || (otherUntilMs === untilMs && otherIndex > index);
    });
    if (superseded) return index;
  }
  return 0;
}

/**
 * Whether a captured mark is still worth replaying.
 *
 * A mark whose window is still live is replayed no matter how long the outage
 * lasted: dropping it re-probes a provider the wrapper already spent (the bd-38
 * churn). The queue-age bound only decides the fate of marks that were already
 * expired when the store came back.
 */
function shouldReplayPendingCooldown(mark: PendingCooldownMark, atMs: number): boolean {
  if (pendingUntilMs(mark) > atMs) return true;
  return atMs - mark.queuedAtMs <= MAX_PENDING_COOLDOWN_AGE_MS;
}

/**
 * Replay captured marks into the store, before the store serves any read.
 *
 * A mark the store refuses (read-only) is dropped: re-queueing it would keep an
 * unbounded memory of marks a read-only file can never accept.
 */
function flushPendingCooldowns(store: ModelStateStore, atMs: number): void {
  const queued = pendingCooldownMarks;
  pendingCooldownMarks = [];
  for (const mark of queued) {
    if (!shouldReplayPendingCooldown(mark, atMs)) continue;
    store.markCooldown(mark.input);
  }
}

/** One warning per distinct failure class per process; a retry cycle never repeats it. */
function warnSharedStoreFailure(failureClass: StoreFailureClass, error: string): void {
  if (sharedWarnedClass === failureClass) return;
  sharedWarnedClass = failureClass;
  if (failureClass === "permanent") {
    // A permanent failure is the one case an operator has to act on, so the
    // single warning has to name the error and say what is switched off.
    console.warn(
      `[belayd-harness] shared model state store unavailable (${error}); ` +
        "not retrying: cooldown tracking is off for this process until restart " +
        "(reads stay permissive, so a spent provider can be retried).",
    );
    return;
  }
  const retrySeconds = Math.round(SHARED_MODEL_STATE_RETRY_MS / 1_000);
  console.warn(
    `[belayd-harness] shared model state store unavailable (${error}); ` +
      `cooldown marks are queued and retried every ${retrySeconds}s.`,
  );
}

/**
 * Test seam for the shared open.
 *
 * Production passes nothing. The failure classification, the retry window and
 * the pending-mark flush are otherwise only reachable by inducing real SQLite
 * lock contention, so tests drive the open result directly.
 */
export interface SharedStoreOpenSeam {
  open?: (path: string) => ModelStateOpen;
}

/**
 * The process-wide shared store, opened lazily on first use.
 *
 * This is the module-level mutable state AGENTS.md exempts for this file: one
 * instance per process keeps the routing adapter and the provider policy on one
 * connection and one cache, which is what "one cooldown truth" means in-process.
 * The path comes from {@link resolveModelStatePath}, so `BELAYD_MODEL_STATE_FILE`
 * (then the retired cooldown path, then XDG) decides it once for every consumer.
 *
 * Failure handling:
 * - **transient** (lock/busy/migration/IO): warn once, return a facade that
 *   queues cooldown marks, and retry after {@link SHARED_MODEL_STATE_RETRY_MS};
 *   the first successful open flushes the queue before serving reads.
 * - **permanent** (no engine, bad path/permission, non-sqlite file, corruption):
 *   warn once, stop retrying, return `null` (permissive).
 */
export function sharedModelStateStore(
  now: () => number = Date.now,
  seam?: SharedStoreOpenSeam,
): ModelStateStore | null {
  if (sharedModelState !== undefined) return sharedModelState;
  if (sharedPermanentlyUnavailable) return null;
  const atMs = now();
  const path = defaultModelStatePath();
  if (
    sharedOpenFailedAt !== undefined &&
    sharedOpenFailedAt <= atMs &&
    atMs - sharedOpenFailedAt < SHARED_MODEL_STATE_RETRY_MS
  ) {
    // Still inside the retry window: keep capturing marks instead of dropping
    // them for the rest of the outage.
    return pendingCooldownStore(path, now);
  }
  const opened = seam?.open === undefined ? openModelStateStore({ path }) : seam.open(path);
  if (!opened.ok) {
    const failureClass = classifyStoreFailure(opened.error);
    sharedOpenFailedAt = atMs;
    sharedPermanentlyUnavailable = failureClass === "permanent";
    warnSharedStoreFailure(failureClass, opened.error);
    return failureClass === "transient" ? pendingCooldownStore(path, now) : null;
  }
  sharedModelState = opened.store;
  sharedOpenFailedAt = undefined;
  sharedPermanentlyUnavailable = false;
  sharedWarnedClass = undefined;
  // Before any read is served: replay what the outage captured.
  flushPendingCooldowns(opened.store, atMs);
  return sharedModelState;
}

/**
 * Drop the process-wide store and anything captured for it.
 *
 * Tests use this to exercise the failure/retry path and to re-point
 * `BELAYD_MODEL_STATE_FILE`; production opens the store once per process.
 */
export function resetSharedModelStateStore(): void {
  const store = sharedModelState;
  sharedModelState = undefined;
  sharedOpenFailedAt = undefined;
  sharedPermanentlyUnavailable = false;
  sharedWarnedClass = undefined;
  pendingCooldownMarks = [];
  if (store === undefined) return;
  try {
    store.close();
  } catch {
    /* closing a handle we no longer use must not throw at reset */
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cooldown (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  retry_after_ms INTEGER NOT NULL,
  cause TEXT,
  escalations INTEGER,
  last_mark_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, model)
);
CREATE INDEX IF NOT EXISTS cooldown_until ON cooldown (until_ms);
CREATE TABLE IF NOT EXISTS cooldown_ladder (
  provider TEXT PRIMARY KEY,
  escalations INTEGER NOT NULL,
  last_mark_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS capacity (
  provider TEXT NOT NULL,
  class TEXT NOT NULL,
  "limit" INTEGER NOT NULL,
  in_use INTEGER NOT NULL,
  PRIMARY KEY (provider, class)
);
CREATE TABLE IF NOT EXISTS lease (
  lease_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  class TEXT NOT NULL,
  daemon_pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lease_scope ON lease (provider, class);
CREATE INDEX IF NOT EXISTS lease_expires ON lease (expires_ms);
CREATE TABLE IF NOT EXISTS spend (
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  phase TEXT NOT NULL,
  task_id TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_ts ON spend (ts);
`;

/**
 * Columns added to `cooldown` by schema v2, with the DDL needed to add each on
 * an existing v1 database.
 *
 * The adapter reads all three: `cause` keeps "why is this provider cooling" out
 * of the display `reason`; `escalations` mirrors the reconciliation ladder on the
 * window itself; `last_mark_ms` orders windows by when they were observed.
 */
const COOLDOWN_V2_COLUMNS: readonly (readonly [string, string])[] = [
  ["cause", "TEXT"],
  ["escalations", "INTEGER"],
  ["last_mark_ms", "INTEGER NOT NULL DEFAULT 0"],
];

/**
 * Create the schema and add the v2 cooldown columns to a database created by
 * v1, all inside one `BEGIN IMMEDIATE` transaction.
 *
 * Two fleet members can open the same v1 file at the same time. Bare autocommit
 * `ALTER TABLE` statements let both pass the `pragma_table_info` check and then
 * race the same ALTER, and the loser's open fails — which, now that the JSON
 * fallback store is gone, would remove the single cooldown truth for that
 * session. The write transaction serialises the whole migration; the column
 * re-read plus the duplicate-column tolerance keeps a partially migrated file
 * (or a migration from a process that committed between our read and our ALTER)
 * a success rather than a failure.
 */
function applySchemaOnce(database: SqliteDatabaseLike): void {
  inImmediateTransaction(database, () => {
    database.exec(SCHEMA);
    for (const [column, ddl] of COOLDOWN_V2_COLUMNS) {
      addColumnIfMissing(database, "cooldown", column, ddl);
    }
    database.exec(`PRAGMA user_version = ${MODEL_STATE_SCHEMA_VERSION}`);
  });
}

export interface ModelStateStoreOptions extends Partial<ModelStateEnv> {
  /** Defaults to {@link resolveModelStatePath} for the injected env. */
  path?: string;
  /** Open without write access: reads work, every write is `{ ok: false }`. */
  readOnly?: boolean;
  /** Epoch-ms clock seam. Defaults to `Date.now`. */
  now?: () => number;
  /** Host recorded on each lease; identifies which machine holds a slot. */
  host?: string;
  /** Daemon pid recorded on each lease (diagnostics only, never liveness). */
  daemonPid?: number;
  leaseTtlMs?: number;
  readCacheMaxAgeMs?: number;
  /** Inject a database (unit-test seam); when omitted the real file is opened. */
  database?: SqliteDatabaseLike;
  /**
   * Called once per schema attempt. Test seam for the retry policy: production
   * callers have no reason to observe the migration loop.
   */
  onSchemaAttempt?: (attempt: number) => void;
}

function openDatabase(options: {
  path: string;
  readOnly: boolean;
  database?: SqliteDatabaseLike;
  onSchemaAttempt?: (attempt: number) => void;
}): ModelStateResult<SqliteDatabaseLike> {
  return openSqliteFile({
    path: options.path,
    readOnly: options.readOnly,
    label: "model state store",
    schemaAttempts: SCHEMA_MIGRATION_ATTEMPTS,
    applySchema: applySchemaOnce,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.onSchemaAttempt === undefined ? {} : { onSchemaAttempt: options.onSchemaAttempt }),
  });
}

/**
 * Open the shared model-state store.
 *
 * A write open creates the directory 0700, the file 0600, enables WAL and
 * creates the schema. A read-only open never migrates or writes.
 */
export function openModelStateStore(options: ModelStateStoreOptions = {}): ModelStateOpen {
  const path =
    options.path ??
    resolveModelStatePath({ env: options.env ?? process.env, homeDir: options.homeDir });
  const readOnly = options.readOnly === true;
  const opened = openDatabase({
    path,
    readOnly,
    database: options.database,
    onSchemaAttempt: options.onSchemaAttempt,
  });
  if (!opened.ok) return { ok: false, error: opened.error };
  const database = opened.value;
  const now = options.now ?? Date.now;
  const host = options.host ?? "localhost";
  const daemonPid = options.daemonPid ?? process.pid;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_CAPACITY_LEASE_TTL_MS;
  const cacheMaxAgeMs = options.readCacheMaxAgeMs ?? MODEL_STATE_READ_CACHE_MAX_AGE_MS;
  const ownsFile = !readOnly && options.database === undefined;

  if (ownsFile) tightenStoreFileModes(path);

  let closed = false;
  const cooldownCache = new Map<
    string,
    { atMs: number; value: ModelStateResult<ActiveCooldown | null> }
  >();
  const invalidateCache = (): void => cooldownCache.clear();

  const failOnClosed = <T>(operation: string): ModelStateResult<T> | undefined =>
    closed ? { ok: false, error: `model state store is closed (${operation})` } : undefined;
  const failReadOnly = <T>(operation: string): ModelStateResult<T> | undefined =>
    readOnly ? { ok: false, error: `model state store is read-only (${operation})` } : undefined;

  const read = <T>(operation: string, body: () => T): ModelStateResult<T> => {
    const closedResult = failOnClosed<T>(operation);
    if (closedResult !== undefined) return closedResult;
    try {
      return { ok: true, value: body() };
    } catch (error) {
      return { ok: false, error: `${operation} failed: ${errorMessage(error)}` };
    }
  };

  /**
   * One `BEGIN IMMEDIATE` transaction. The decision returned by `body` is
   * committed only when it is `{ ok: true }`; a refusal or error rolls back, so
   * a recomputed `in_use` can never be committed without its lease.
   */
  const write = <T>(operation: string, body: () => ModelStateResult<T>): ModelStateResult<T> => {
    const closedResult = failOnClosed<T>(operation);
    if (closedResult !== undefined) return closedResult;
    const readOnlyResult = failReadOnly<T>(operation);
    if (readOnlyResult !== undefined) return readOnlyResult;
    try {
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      return { ok: false, error: `${operation} failed: ${errorMessage(error)}` };
    }
    try {
      const result = body();
      if (!result.ok) {
        database.exec("ROLLBACK");
        return result;
      }
      database.exec("COMMIT");
      invalidateCache();
      if (ownsFile) tightenStoreFileModes(path);
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        /* the transaction is already gone; the original error is what matters */
      }
      return { ok: false, error: `${operation} failed: ${errorMessage(error)}` };
    }
  };

  const deleteExpiredLeases = (atMs: number): number => {
    const result = database.prepare("DELETE FROM lease WHERE expires_ms <= ?").run(atMs);
    return Number(result.changes);
  };

  const countLeases = (provider: string, modelClass: string): number => {
    const row = asRow(
      database
        .prepare("SELECT COUNT(*) AS count FROM lease WHERE provider = ? AND class = ?")
        .get(provider, modelClass),
    );
    return row === undefined ? 0 : readNumber(row, "count");
  };

  const activeCooldown = (input: {
    provider: string;
    model: string;
    atMs: number;
  }): ActiveCooldown | null => {
    // Three row shapes can block one endpoint: the exact (provider, model),
    // the whole provider (provider, `*`), and a bare model id cooled
    // provider-agnostically (`*`, model). A provider-wide window outranks the
    // endpoint one: a spent credential blocks every model on it, so it is the
    // stronger (and the more useful) diagnosis.
    const row = asRow(
      database
        .prepare(
          `SELECT provider, model, until_ms, reason, retry_after_ms
             FROM cooldown
            WHERE until_ms > ?
              AND (
                (provider = ? AND (model = ? OR model = ?))
                OR (provider = ? AND model = ?)
              )
            ORDER BY CASE
                       WHEN provider = ? AND model = ? THEN 0
                       WHEN provider = ? AND model = ? THEN 1
                       ELSE 2
                     END,
                     until_ms DESC
            LIMIT 1`,
        )
        .get(
          input.atMs,
          input.provider,
          input.model,
          PROVIDER_SCOPE_MODEL,
          PROVIDER_SCOPE_MODEL,
          input.model,
          input.provider,
          PROVIDER_SCOPE_MODEL,
          input.provider,
          input.model,
        ),
    );
    if (row === undefined) return null;
    const scope: CooldownScope =
      readString(row, "model") === PROVIDER_SCOPE_MODEL ? "provider" : "model";
    return {
      scope,
      untilMs: readNumber(row, "until_ms"),
      reason: readString(row, "reason"),
      retryAfterMs: readNumber(row, "retry_after_ms"),
    };
  };

  const seeder: ModelStateSeeder = {
    seedCooldown(input) {
      const atMs = input.nowMs ?? now();
      const provider = cooldownProviderKey(input.provider);
      const providerScoped = input.model === undefined && provider !== PROVIDER_SCOPE_MODEL;
      const model = input.model ?? PROVIDER_SCOPE_MODEL;
      return write<{ written: boolean }>("seedCooldown", () => ({
        ok: true,
        value: {
          written: seedCooldownRow(database, {
            provider,
            model,
            providerScoped,
            atMs,
            untilMs: input.untilMs,
            reason: input.reason,
            lastMarkedAt: input.lastMarkedAt,
            cause: input.cause,
            escalations: input.escalations,
          }),
        },
      }));
    },

    seedCooldownLadder(input) {
      const atMs = input.nowMs ?? now();
      const provider = cooldownProviderKey(input.provider);
      return write<{ written: boolean }>("seedCooldownLadder", () => {
        // A rung older than the ladder memory is what the old store pruned: a
        // weekly bucket that reset more than a week ago is a fresh limit.
        if (atMs - input.lastMarkedAt > COOLDOWN_ESCALATION_MEMORY_MS) {
          return { ok: true, value: { written: false } };
        }
        const existing = asRow(
          database
            .prepare("SELECT escalations, last_mark_ms FROM cooldown_ladder WHERE provider = ?")
            .get(provider),
        );
        if (existing !== undefined) {
          const currentMark = readNumber(existing, "last_mark_ms");
          const currentCount = readNumber(existing, "escalations");
          // Later mark wins (a count-0 reset replaces an older rung); an equal
          // mark keeps the higher count, so neither side can downgrade the other.
          const keepsCurrent =
            currentMark > input.lastMarkedAt ||
            (currentMark === input.lastMarkedAt && currentCount >= input.escalations);
          if (keepsCurrent) return { ok: true, value: { written: false } };
        }
        database
          .prepare(
            `INSERT INTO cooldown_ladder (provider, escalations, last_mark_ms)
             VALUES (?, ?, ?)
             ON CONFLICT(provider) DO UPDATE SET
               escalations = excluded.escalations,
               last_mark_ms = excluded.last_mark_ms`,
          )
          .run(provider, Math.max(0, Math.round(input.escalations)), input.lastMarkedAt);
        return { ok: true, value: { written: true } };
      });
    },
  };

  const store: ModelStateStore = {
    path,
    readOnly,

    cooldownFor(input) {
      const atMs = input.nowMs ?? now();
      const provider = cooldownProviderKey(input.provider);
      const key = `${provider}\u0000${input.model}`;
      const cached = cooldownCache.get(key);
      if (cached !== undefined && atMs - cached.atMs <= cacheMaxAgeMs) return cached.value;
      const result = read("cooldownFor", () =>
        activeCooldown({ provider, model: input.model, atMs }),
      );
      // Never cache a failed read: a transient SQLite error must not become a
      // one-second window in which the model looks healthy.
      if (result.ok) cooldownCache.set(key, { atMs, value: result });
      return result;
    },

    listCooldowns(input) {
      const atMs = input?.nowMs ?? now();
      return read("listCooldowns", () =>
        database
          .prepare(
            `SELECT provider, model, until_ms, reason, retry_after_ms, cause, escalations, last_mark_ms
               FROM cooldown
              WHERE until_ms > ?
              ORDER BY provider, model`,
          )
          .all(atMs)
          .flatMap((raw) => {
            const row = cooldownRowOf(raw);
            return row === undefined ? [] : [row];
          }),
      );
    },

    invalidateCooldownCache() {
      invalidateCache();
    },

    markCooldown(input) {
      const atMs = input.nowMs ?? now();
      const hinted = input.hinted === true;
      const provider = cooldownProviderKey(input.provider);
      // Only a marker with a provider *and* no model is provider-wide. A bare
      // model id (absent provider) is endpoint-specific and must not feed the
      // provider's escalation ladder.
      const providerScoped = input.model === undefined && provider !== PROVIDER_SCOPE_MODEL;
      const model = input.model ?? PROVIDER_SCOPE_MODEL;
      const requestedMs = Math.max(0, Math.round(input.durationMs));
      return write("markCooldown", () => {
        // Only a provider-wide, unhinted guess escalates. A hint is authoritative
        // and clears the ladder; a model-scoped window is endpoint-specific and
        // never escalates.
        const rung = providerScoped
          ? applyEscalation({ database, provider, atMs, hinted })
          : undefined;
        const ceilingMs = MAX_ESCALATED_COOLDOWN_SECONDS * 1_000;
        const windowMs =
          providerScoped && !hinted && rung !== undefined
            ? Math.min(requestedMs * COOLDOWN_ESCALATION_FACTOR ** (rung - 1), ceilingMs)
            : requestedMs;
        const record: CooldownRecord = {
          provider,
          model,
          untilMs: atMs + windowMs,
          reason: input.reason,
          retryAfterMs: windowMs,
          lastMarkedAt: atMs,
          ...(providerScoped && input.cause !== undefined ? { cause: input.cause } : {}),
          ...(providerScoped && !hinted && rung !== undefined ? { escalations: rung } : {}),
        };
        upsertCooldown(database, record);
        return { ok: true, value: record };
      });
    },

    readCapacity(input) {
      const atMs = input.nowMs ?? now();
      return read("readCapacity", () => {
        const snapshot = readCapacityRow(database, input.provider, input.class, atMs);
        return snapshot;
      });
    },

    reserveCapacity(input) {
      const atMs = input.nowMs ?? now();
      const ttlMs = input.ttlMs ?? leaseTtlMs;
      return write<CapacityReservation>("reserveCapacity", () => {
        deleteExpiredLeases(atMs);
        const limit = Math.max(0, Math.round(input.limit));
        database
          .prepare(
            `INSERT INTO capacity (provider, class, "limit", in_use) VALUES (?, ?, ?, 0)
             ON CONFLICT(provider, class) DO UPDATE SET "limit" = excluded."limit"`,
          )
          .run(input.provider, input.class, limit);
        const inUse = countLeases(input.provider, input.class);
        database
          .prepare("UPDATE capacity SET in_use = ? WHERE provider = ? AND class = ?")
          .run(inUse, input.provider, input.class);
        if (inUse >= limit) {
          const refusal: CapacityReservation = {
            granted: false,
            reason: "capacity-exhausted",
            provider: input.provider,
            class: input.class,
            inUse,
            limit,
          };
          return { ok: true, value: refusal };
        }
        const expiresMs = atMs + ttlMs;
        database
          .prepare(
            `INSERT INTO lease (lease_id, provider, class, daemon_pid, host, expires_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(input.leaseId, input.provider, input.class, daemonPid, host, expiresMs);
        const nextInUse = inUse + 1;
        database
          .prepare("UPDATE capacity SET in_use = ? WHERE provider = ? AND class = ?")
          .run(nextInUse, input.provider, input.class);
        const reservation: CapacityReservation = {
          granted: true,
          leaseId: input.leaseId,
          provider: input.provider,
          class: input.class,
          inUse: nextInUse,
          limit,
          expiresMs,
        };
        return { ok: true, value: reservation };
      });
    },

    releaseCapacity(input) {
      const closedResult = failOnClosed<{ released: boolean; inUse: number }>("releaseCapacity");
      if (closedResult !== undefined) {
        return {
          ok: false,
          reason: "store-error",
          error: closedResult.ok ? "store closed" : closedResult.error,
        };
      }
      const readOnlyResult = failReadOnly<{ released: boolean; inUse: number }>("releaseCapacity");
      if (readOnlyResult !== undefined) {
        return {
          ok: false,
          reason: "store-error",
          error: readOnlyResult.ok ? "store is read-only" : readOnlyResult.error,
        };
      }
      return performLeaseRelease({
        database,
        provider: input.provider,
        class: input.class,
        leaseId: input.leaseId,
        ownerHost: input.host ?? host,
        ownerPid: input.daemonPid ?? daemonPid,
        atMs: input.nowMs ?? now(),
        onCommit: () => {
          invalidateCache();
          if (ownsFile) tightenStoreFileModes(path);
        },
      });
    },

    renewLease(input) {
      const closedResult = failOnClosed<{ leaseId: string; expiresMs: number }>("renewLease");
      if (closedResult !== undefined) {
        return {
          ok: false,
          reason: "store-error",
          error: closedResult.ok ? "store closed" : closedResult.error,
        };
      }
      const readOnlyResult = failReadOnly<{ leaseId: string; expiresMs: number }>("renewLease");
      if (readOnlyResult !== undefined) {
        return {
          ok: false,
          reason: "store-error",
          error: readOnlyResult.ok ? "store is read-only" : readOnlyResult.error,
        };
      }
      return performLeaseRenewal({
        database,
        provider: input.provider,
        class: input.class,
        leaseId: input.leaseId,
        ownerHost: input.host ?? host,
        ownerPid: input.daemonPid ?? daemonPid,
        ttlMs: Math.max(1, Math.round(input.ttlMs ?? leaseTtlMs)),
        atMs: input.nowMs ?? now(),
        // A renewal commit is a write like any other: the read cache must not
        // serve pre-renewal state and the WAL file modes must stay tightened.
        onCommit: () => {
          invalidateCache();
          if (ownsFile) tightenStoreFileModes(path);
        },
      });
    },

    recordSpend(row) {
      return write("recordSpend", () => {
        database
          .prepare(
            `INSERT INTO spend
               (ts, provider, model, phase, task_id, input, output, cache_read, cache_write, cost)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            Math.round(row.ts),
            row.provider,
            row.model,
            row.phase,
            row.taskId,
            Math.round(row.input),
            Math.round(row.output),
            Math.round(row.cacheRead),
            Math.round(row.cacheWrite),
            row.cost,
          );
        return { ok: true, value: null };
      });
    },

    spendTotals() {
      return read("spendTotals", () => {
        const row = asRow(
          database
            .prepare(
              `SELECT COUNT(*) AS rows,
                      SUM(input) AS input,
                      SUM(output) AS output,
                      SUM(cache_read) AS cache_read,
                      SUM(cache_write) AS cache_write,
                      SUM(cost) AS cost
                 FROM spend`,
            )
            .get(),
        );
        if (row === undefined) {
          return { rows: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        }
        return {
          rows: readNumber(row, "rows"),
          input: readNumber(row, "input"),
          output: readNumber(row, "output"),
          cacheRead: readNumber(row, "cache_read"),
          cacheWrite: readNumber(row, "cache_write"),
          cost: readNumber(row, "cost"),
        };
      });
    },

    prune(nowMs) {
      const atMs = nowMs ?? now();
      return write("prune", () => {
        // An expired window is invisible to every reader (`until_ms > now`), so
        // retaining it for diagnostics would only grow the table between
        // prunes. The ladder outlives its window by the escalation memory, which
        // is what keeps a weekly limit from being re-probed on every reset.
        const cooldowns = database.prepare("DELETE FROM cooldown WHERE until_ms <= ?").run(atMs);
        database
          .prepare("DELETE FROM cooldown_ladder WHERE last_mark_ms + ? <= ?")
          .run(COOLDOWN_ESCALATION_MEMORY_MS, atMs);
        const leases = deleteExpiredLeases(atMs);
        return {
          ok: true,
          value: { cooldowns: Number(cooldowns.changes), leases },
        };
      });
    },

    close() {
      if (closed) return;
      closed = true;
      cooldownCache.clear();
      try {
        database.close();
      } catch {
        /* closing a handle we no longer use must not throw at shutdown */
      }
    },
  };

  seederByStore.set(store, seeder);

  return { ok: true, store };
}

/**
 * Write one replayed window, honouring the two migration rules: an expired row is
 * not created, and an existing row that ends later is kept, so a migration can
 * never shorten a live window.
 */
function seedCooldownRow(
  database: SqliteDatabaseLike,
  input: {
    provider: string;
    model: string;
    providerScoped: boolean;
    atMs: number;
    untilMs: number;
    reason: string;
    lastMarkedAt: number | undefined;
    cause: CooldownCause | undefined;
    escalations: number | undefined;
  },
): boolean {
  if (input.untilMs <= input.atMs) return false;
  const existing = asRow(
    database
      .prepare("SELECT until_ms FROM cooldown WHERE provider = ? AND model = ?")
      .get(input.provider, input.model),
  );
  if (existing !== undefined && readNumber(existing, "until_ms") >= input.untilMs) return false;
  const ceilingMs = input.atMs + MAX_ESCALATED_COOLDOWN_SECONDS * 1_000;
  // An escalated (unhinted) window keeps the 24 h ceiling; a hinted or
  // model-scoped window is authoritative and is replayed exactly.
  const untilMs =
    input.providerScoped && input.escalations !== undefined
      ? Math.min(input.untilMs, ceilingMs)
      : input.untilMs;
  upsertCooldown(database, {
    provider: input.provider,
    model: input.model,
    untilMs,
    reason: input.reason,
    retryAfterMs: untilMs - input.atMs,
    lastMarkedAt: input.lastMarkedAt ?? input.atMs,
    ...(input.providerScoped && input.cause !== undefined ? { cause: input.cause } : {}),
    ...(input.providerScoped && input.escalations !== undefined
      ? { escalations: input.escalations }
      : {}),
  });
  return true;
}

/** One cooldown row from a database row, or undefined when it is unreadable. */
function cooldownRowOf(raw: unknown): CooldownRow | undefined {
  const row = asRow(raw);
  if (row === undefined) return undefined;
  const cause = readString(row, "cause");
  const escalations = readOptionalNumber(row, "escalations");
  return {
    provider: readString(row, "provider"),
    model: readString(row, "model"),
    untilMs: readNumber(row, "until_ms"),
    reason: readString(row, "reason"),
    retryAfterMs: readNumber(row, "retry_after_ms"),
    lastMarkedAt: readNumber(row, "last_mark_ms"),
    ...(cause === "quota" || cause === "unconfigured" ? { cause } : {}),
    ...(escalations === undefined ? {} : { escalations }),
  };
}

function readCapacityRow(
  database: SqliteDatabaseLike,
  provider: string,
  modelClass: string,
  atMs: number,
): CapacitySnapshot {
  const row = asRow(
    database
      .prepare('SELECT "limit", in_use FROM capacity WHERE provider = ? AND class = ?')
      .get(provider, modelClass),
  );
  if (row === undefined) return { provider, class: modelClass, limit: 0, inUse: 0 };
  return {
    provider,
    class: modelClass,
    limit: readNumber(row, "limit"),
    // Recompute from leases so a reader never trusts a stale counter; an
    // expired lease is free capacity even if its daemon is still alive.
    inUse: countLeasesFor(database, provider, modelClass, atMs),
  };
}

function countLeasesFor(
  database: SqliteDatabaseLike,
  provider: string,
  modelClass: string,
  atMs: number,
): number {
  const row = asRow(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM lease WHERE provider = ? AND class = ? AND expires_ms > ?",
      )
      .get(provider, modelClass, atMs),
  );
  return row === undefined ? 0 : readNumber(row, "count");
}

/**
 * Advance (or clear) the unhinted escalation ladder for one provider and return
 * the rung this mark uses. Lives outside the store closure so the mark method
 * stays readable and inside the complexity budget.
 *
 * A hint is authoritative: it deletes the ladder. An unhinted repeat doubles the
 * base window per rung, bounded by `MAX_ESCALATED_COOLDOWN_SECONDS`; a rung older
 * than `COOLDOWN_ESCALATION_MEMORY_MS` starts over.
 */
function applyEscalation(input: {
  database: SqliteDatabaseLike;
  provider: string;
  atMs: number;
  hinted: boolean;
}): number {
  if (input.hinted) {
    input.database.prepare("DELETE FROM cooldown_ladder WHERE provider = ?").run(input.provider);
    return 1;
  }
  const previous = asRow(
    input.database
      .prepare("SELECT escalations, last_mark_ms FROM cooldown_ladder WHERE provider = ?")
      .get(input.provider),
  );
  const previousCount = previous === undefined ? 0 : readNumber(previous, "escalations");
  const previousMarkedAt = previous === undefined ? 0 : readNumber(previous, "last_mark_ms");
  const withinMemory = input.atMs - previousMarkedAt <= COOLDOWN_ESCALATION_MEMORY_MS;
  const escalations = withinMemory ? previousCount + 1 : 1;
  input.database
    .prepare(
      `INSERT INTO cooldown_ladder (provider, escalations, last_mark_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         escalations = excluded.escalations,
         last_mark_ms = excluded.last_mark_ms`,
    )
    .run(input.provider, escalations, input.atMs);
  return escalations;
}

function upsertCooldown(database: SqliteDatabaseLike, record: CooldownRecord): void {
  database
    .prepare(
      `INSERT INTO cooldown (provider, model, until_ms, reason, retry_after_ms, cause, escalations, last_mark_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model) DO UPDATE SET
         until_ms = excluded.until_ms,
         reason = excluded.reason,
         retry_after_ms = excluded.retry_after_ms,
         cause = excluded.cause,
         escalations = excluded.escalations,
         last_mark_ms = excluded.last_mark_ms`,
    )
    .run(
      record.provider,
      record.model,
      record.untilMs,
      record.reason,
      record.retryAfterMs,
      record.cause ?? null,
      record.escalations ?? null,
      record.lastMarkedAt ?? 0,
    );
}

function deleteLease(
  database: SqliteDatabaseLike,
  input: {
    provider: string;
    class: string;
    leaseId: string;
    host: string;
    daemonPid: number;
  },
): void {
  database
    .prepare(
      `DELETE FROM lease
        WHERE lease_id = ? AND provider = ? AND class = ? AND host = ? AND daemon_pid = ?`,
    )
    .run(input.leaseId, input.provider, input.class, input.host, input.daemonPid);
}

function setCapacityInUse(
  database: SqliteDatabaseLike,
  provider: string,
  modelClass: string,
  inUse: number,
): void {
  database
    .prepare(
      `INSERT INTO capacity (provider, class, "limit", in_use) VALUES (?, ?, 0, ?)
       ON CONFLICT(provider, class) DO UPDATE SET in_use = excluded.in_use`,
    )
    .run(provider, modelClass, inUse);
}

/**
 * One ownership-checked release transaction. Kept outside the store closure so
 * the store method stays inside the complexity budget; `onCommit` lets the
 * caller invalidate its read cache and re-tighten WAL file modes.
 */
function performLeaseRelease(input: {
  database: SqliteDatabaseLike;
  provider: string;
  class: string;
  leaseId: string;
  ownerHost: string;
  ownerPid: number;
  atMs: number;
  onCommit: () => void;
}): CapacityRelease {
  const database = input.database;
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    return { ok: false, reason: "store-error", error: errorMessage(error) };
  }
  try {
    database.prepare("DELETE FROM lease WHERE expires_ms <= ?").run(input.atMs);
    const owner = readLeaseRow(database, input.provider, input.class, input.leaseId);
    if (owner === null) {
      // Already released or expired: idempotent, never a second decrement.
      database.exec("COMMIT");
      input.onCommit();
      return {
        ok: true,
        value: {
          released: false,
          inUse: countLeaseRows(database, input.provider, input.class),
        },
      };
    }
    if (owner.host !== input.ownerHost || owner.daemonPid !== input.ownerPid) {
      database.exec("ROLLBACK");
      return {
        ok: false,
        reason: "lease-not-owned",
        error: `lease ${input.leaseId} is owned by another daemon`,
      };
    }
    deleteLease(database, {
      provider: input.provider,
      class: input.class,
      leaseId: input.leaseId,
      host: input.ownerHost,
      daemonPid: input.ownerPid,
    });
    const inUse = countLeaseRows(database, input.provider, input.class);
    setCapacityInUse(database, input.provider, input.class, inUse);
    database.exec("COMMIT");
    input.onCommit();
    return { ok: true, value: { released: true, inUse } };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* the transaction is already gone; the original error is what matters */
    }
    return { ok: false, reason: "store-error", error: errorMessage(error) };
  }
}

/** Lease count for one bucket, after expired rows have been pruned. */
function countLeaseRows(
  database: SqliteDatabaseLike,
  provider: string,
  modelClass: string,
): number {
  const row = asRow(
    database
      .prepare("SELECT COUNT(*) AS count FROM lease WHERE provider = ? AND class = ?")
      .get(provider, modelClass),
  );
  return row === undefined ? 0 : readNumber(row, "count");
}

/** Owner plus expiry of a lease row, or null when the row is gone. */
function readLeaseRow(
  database: SqliteDatabaseLike,
  provider: string,
  modelClass: string,
  leaseId: string,
): { host: string; daemonPid: number; expiresMs: number } | null {
  const row = asRow(
    database
      .prepare(
        "SELECT host, daemon_pid, expires_ms FROM lease WHERE lease_id = ? AND provider = ? AND class = ?",
      )
      .get(leaseId, provider, modelClass),
  );
  if (row === undefined) return null;
  return {
    host: readString(row, "host"),
    daemonPid: readNumber(row, "daemon_pid"),
    expiresMs: readNumber(row, "expires_ms"),
  };
}

/**
 * One ownership-checked renewal transaction. An expired or missing row is never
 * resurrected: another process may already hold the freed slot, so extending it
 * would re-open exactly the over-subscription the lease exists to prevent.
 * `onCommit` runs after a successful commit (same cache/mode duties as release).
 */
function performLeaseRenewal(input: {
  database: SqliteDatabaseLike;
  provider: string;
  class: string;
  leaseId: string;
  ownerHost: string;
  ownerPid: number;
  ttlMs: number;
  atMs: number;
  onCommit: () => void;
}): LeaseRenewal {
  const database = input.database;
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    return { ok: false, reason: "store-error", error: errorMessage(error) };
  }
  try {
    const lease = readLeaseRow(database, input.provider, input.class, input.leaseId);
    if (lease === null || lease.expiresMs <= input.atMs) {
      database.exec("ROLLBACK");
      return {
        ok: false,
        reason: "lease-expired",
        error: `lease ${input.leaseId} has expired and cannot be renewed`,
      };
    }
    if (lease.host !== input.ownerHost || lease.daemonPid !== input.ownerPid) {
      database.exec("ROLLBACK");
      return {
        ok: false,
        reason: "lease-not-owned",
        error: `lease ${input.leaseId} is owned by another daemon`,
      };
    }
    const expiresMs = input.atMs + input.ttlMs;
    database
      .prepare(
        `UPDATE lease SET expires_ms = ?
          WHERE lease_id = ? AND provider = ? AND class = ? AND host = ? AND daemon_pid = ?`,
      )
      .run(expiresMs, input.leaseId, input.provider, input.class, input.ownerHost, input.ownerPid);
    database.exec("COMMIT");
    input.onCommit();
    return { ok: true, value: { leaseId: input.leaseId, expiresMs } };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* the transaction is already gone; the original error is what matters */
    }
    return { ok: false, reason: "store-error", error: errorMessage(error) };
  }
}
