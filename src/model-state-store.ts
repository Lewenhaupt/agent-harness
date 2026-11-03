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

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  COOLDOWN_ESCALATION_FACTOR,
  COOLDOWN_ESCALATION_MEMORY_MS,
  MAX_ESCALATED_COOLDOWN_SECONDS,
} from "./model-cooldown.js";

/** Override for the store path, matching the `BELAYD_MODEL_COOLDOWN_FILE` precedent. */
export const MODEL_STATE_FILE_ENV = "BELAYD_MODEL_STATE_FILE";

/** Schema marker written to `PRAGMA user_version`, so a future migration is possible. */
export const MODEL_STATE_SCHEMA_VERSION = 1;

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

/** A value SQLite can bind as an anonymous parameter. */
export type SqlValue = string | number | bigint | null;

/** The subset of `node:sqlite`'s `StatementSync` this store uses. */
export interface SqliteStatementLike {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

/**
 * The subset of `node:sqlite`'s `DatabaseSync` this store uses. Declared
 * structurally so unit tests can inject a fake and so a missing `node:sqlite`
 * build is a value, not a module-load crash.
 */
export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
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
}

/** Which cooldown scope is blocking a dispatch, when one is. */
export type CooldownScope = "provider" | "model";

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
  provider: string;
  /** `undefined` marks the whole provider; a model id marks one endpoint. */
  model?: string;
  durationMs: number;
  reason: string;
  /** True when `durationMs` came from a provider reset hint (authoritative). */
  hinted?: boolean;
  nowMs?: number;
}

export interface ModelStateStore {
  readonly path: string;
  readonly readOnly: boolean;
  /** The active provider- or model-scoped cooldown, or null when none is active. */
  cooldownFor(input: {
    provider: string;
    model: string;
    nowMs?: number;
  }): ModelStateResult<ActiveCooldown | null>;
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
   * Drop cooldowns past the escalation memory, their ladders, and expired
   * leases.
   */
  prune(nowMs?: number): ModelStateResult<{ cooldowns: number; leases: number }>;
  close(): void;
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
 * `BELAYD_MODEL_STATE_FILE` wins; otherwise
 * `${XDG_STATE_HOME:-~/.local/state}/belayd/model-state.sqlite`, the same state
 * root as proof, metrics and the AWS audit log.
 */
export function resolveModelStatePath(options: ModelStateEnv): string {
  const override = nonEmpty(options.env[MODEL_STATE_FILE_ENV]);
  if (override !== undefined) return override;
  const stateHome =
    nonEmpty(options.env.XDG_STATE_HOME) ??
    join(options.homeDir ?? options.env.HOME ?? homedir(), ".local", "state");
  return join(stateHome, "belayd", "model-state.sqlite");
}

/** Production path, resolved from the process environment. */
export function defaultModelStatePath(): string {
  return resolveModelStatePath({ env: process.env });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cooldown (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  retry_after_ms INTEGER NOT NULL,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tighten the database file and its WAL sidecars to 0600.
 *
 * WAL mode creates `-wal`/`-shm` next to the database on first write (and
 * recreates them as connections cycle); they carry the same shared budget data,
 * so leaving them at the umask default would make the state world-readable on a
 * multi-user host. Best effort: a missing sidecar or a mode we cannot change
 * must never fail a dispatch.
 */
function tightenStoreFileModes(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(candidate, 0o600);
    } catch {
      /* absent (no sidecar yet) or not ours to chmod */
    }
  }
}

function asRow(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

/** Locate `node:sqlite` lazily: an unavailable engine is a value, not a crash. */
function loadSqlite(): ModelStateResult<{
  DatabaseSync: new (path: string, options?: unknown) => SqliteDatabaseLike;
}> {
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as {
      DatabaseSync?: new (path: string, options?: unknown) => SqliteDatabaseLike;
    };
    if (typeof sqlite.DatabaseSync !== "function") {
      return { ok: false, error: "node:sqlite does not expose DatabaseSync" };
    }
    return { ok: true, value: { DatabaseSync: sqlite.DatabaseSync } };
  } catch (error) {
    return { ok: false, error: `node:sqlite unavailable: ${errorMessage(error)}` };
  }
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
}

function openDatabase(options: {
  path: string;
  readOnly: boolean;
  database?: SqliteDatabaseLike;
}): ModelStateResult<SqliteDatabaseLike> {
  if (options.database !== undefined) return { ok: true, value: options.database };
  try {
    if (!options.readOnly) {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    } else if (!existsSync(options.path)) {
      // A read-only open of a missing file is useless; report it as unopenable
      // instead of letting SQLite create an empty database behind the owner.
      return { ok: false, error: `model state store ${options.path} does not exist` };
    }
    const sqlite = loadSqlite();
    if (!sqlite.ok) return sqlite;
    const database = new sqlite.value.DatabaseSync(options.path, {
      readOnly: options.readOnly,
      // A reader may race a writer's checkpoint; wait instead of failing.
      timeout: 5_000,
    });
    if (options.readOnly) return { ok: true, value: database };
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(SCHEMA);
    database.exec(`PRAGMA user_version = ${MODEL_STATE_SCHEMA_VERSION}`);
    // WAL sidecars appear with the first WAL write, not necessarily with the
    // journal_mode switch, so the modes are also tightened after each commit.
    tightenStoreFileModes(options.path);
    return { ok: true, value: database };
  } catch (error) {
    return { ok: false, error: `could not open ${options.path}: ${errorMessage(error)}` };
  }
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
  const opened = openDatabase({ path, readOnly, database: options.database });
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
    const row = asRow(
      database
        .prepare(
          `SELECT provider, model, until_ms, reason, retry_after_ms
             FROM cooldown
            WHERE until_ms > ?
              AND provider = ?
              AND (model = ? OR model = ?)
            ORDER BY (model = ?) DESC, until_ms DESC
            LIMIT 1`,
        )
        .get(input.atMs, input.provider, input.model, PROVIDER_SCOPE_MODEL, PROVIDER_SCOPE_MODEL),
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

  const store: ModelStateStore = {
    path,
    readOnly,

    cooldownFor(input) {
      const atMs = input.nowMs ?? now();
      const key = `${input.provider}\u0000${input.model}`;
      const cached = cooldownCache.get(key);
      if (cached !== undefined && atMs - cached.atMs <= cacheMaxAgeMs) return cached.value;
      const result = read("cooldownFor", () =>
        activeCooldown({ provider: input.provider, model: input.model, atMs }),
      );
      // Never cache a failed read: a transient SQLite error must not become a
      // one-second window in which the model looks healthy.
      if (result.ok) cooldownCache.set(key, { atMs, value: result });
      return result;
    },

    markCooldown(input) {
      const atMs = input.nowMs ?? now();
      const hinted = input.hinted === true;
      const providerScoped = input.model === undefined;
      const model = input.model ?? PROVIDER_SCOPE_MODEL;
      const requestedMs = Math.max(0, Math.round(input.durationMs));
      return write("markCooldown", () => {
        // Only a provider-wide, unhinted guess escalates. A hint is authoritative
        // and clears the ladder; a model-scoped window is endpoint-specific and
        // never escalates.
        const escalations = providerScoped
          ? applyEscalation({ database, provider: input.provider, atMs, hinted })
          : 1;
        const ceilingMs = MAX_ESCALATED_COOLDOWN_SECONDS * 1_000;
        const windowMs =
          providerScoped && !hinted
            ? Math.min(requestedMs * COOLDOWN_ESCALATION_FACTOR ** (escalations - 1), ceilingMs)
            : requestedMs;
        const record: CooldownRecord = {
          provider: input.provider,
          model,
          untilMs: atMs + windowMs,
          reason: input.reason,
          retryAfterMs: windowMs,
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
        const cooldowns = database
          .prepare("DELETE FROM cooldown WHERE until_ms + ? <= ?")
          .run(COOLDOWN_ESCALATION_MEMORY_MS, atMs);
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

  return { ok: true, store };
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
      `INSERT INTO cooldown (provider, model, until_ms, reason, retry_after_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider, model) DO UPDATE SET
         until_ms = excluded.until_ms,
         reason = excluded.reason,
         retry_after_ms = excluded.retry_after_ms`,
    )
    .run(record.provider, record.model, record.untilMs, record.reason, record.retryAfterMs);
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
