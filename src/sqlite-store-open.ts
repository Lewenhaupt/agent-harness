/**
 * Shared `node:sqlite` store hardening (bd-187 extracted, bd-281 reuses it).
 *
 * Two stores in this repo persist daemon-shared state in SQLite: the host-global
 * model-state store (`src/model-state-store.ts`) and the per-repository execution
 * store (`src/repo-state-store.ts`). Both need the same non-obvious set of
 * guarantees, and getting one of them subtly different is how a state store
 * becomes a source of corruption instead of truth. This module owns that set:
 *
 * - **Lazy engine load.** `node:sqlite` is required through
 *   `createRequire(import.meta.url)` so a runtime without the engine yields an
 *   error *value* rather than crashing module load. The whole harness must keep
 *   working without a state store.
 * - **One open path.** Directory `0700`, file and WAL sidecars `0600`, WAL
 *   journal, `synchronous=NORMAL`, `busy_timeout` so a reader racing a writer's
 *   checkpoint waits instead of failing.
 * - **Failure classification.** `transient` (lock contention, momentary IO) is
 *   worth retrying; `permanent` (no engine, bad path, corruption) never fixes
 *   itself and must stop retrying so a broken install cannot warn forever.
 * - **Bounded schema retry.** Two processes opening the same old file race the
 *   migration; the loser retries only when the failure is transient.
 *
 * Nothing here knows about any particular schema: callers pass the `applySchema`
 * callback that creates their tables inside one `BEGIN IMMEDIATE`.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/** A value SQLite can bind as an anonymous parameter. */
export type SqlValue = string | number | bigint | null;

/** The subset of `node:sqlite`'s `StatementSync` these stores use. */
export interface SqliteStatementLike {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

/**
 * The subset of `node:sqlite`'s `DatabaseSync` these stores use. Declared
 * structurally so unit tests can inject a fake and so a missing `node:sqlite`
 * build is a value, not a module-load crash.
 */
export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

/** Errors as values, per the repo convention. */
export type SqliteStoreResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The SQLite database object the engine constructor returns. */
export interface SqliteEngine {
  DatabaseSync: new (path: string, options?: unknown) => SqliteDatabaseLike;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a store failure can clear on its own.
 *
 * A transient failure (another process holds the write lock, a migration is in
 * flight, a momentary IO hiccup) is worth retrying; a permanent one (no
 * `node:sqlite`, a bad path or permission, a non-sqlite file, corruption) never
 * fixes itself and must stop retrying so a broken install cannot produce an
 * endless warning loop.
 */
export type StoreFailureClass = "transient" | "permanent";

/**
 * Errors that can clear without operator action: SQLite lock contention,
 * momentary IO and transient storage pressure. Checked after the permanent
 * patterns, so a message carrying both (a corrupt file reported while busy)
 * still fails fast.
 *
 * Both spellings the runtime can emit are covered: the errno form (`EIO`,
 * `EAGAIN`, `EBUSY`, ...) and the SQLite-class form (`SQLITE_IOERR: disk I/O
 * error`, `SQLITE_FULL: database or disk is full`, `SQLITE_BUSY_SNAPSHOT`, ...).
 * `node:sqlite` often reports only the bare errstr (`disk I/O error`) with
 * `code: "ERR_SQLITE_ERROR"`, so the message text has to carry the diagnosis.
 * Missing a transient here is expensive: the default is permanent, which turns
 * state tracking off for the rest of the process.
 */
const TRANSIENT_STORE_ERROR_PATTERN =
  /SQLITE_BUSY|SQLITE_LOCKED|SQLITE_PROTOCOL|SQLITE_IOERR|SQLITE_FULL|SQLITE_NOMEM|SQLITE_INTERRUPT|database (?:table )?is locked|database is busy|disk I\/O error|database or disk is full|out of memory|interrupted|EIO\b|EINTR\b|EAGAIN|EBUSY|ENOMEM\b|ETXTBSY|temporar/i;

/**
 * SQLite primary result codes that can clear on retry, masked out of node:sqlite's
 * extended `errcode`: BUSY(5), LOCKED(6), NOMEM(7), INTERRUPT(9), IOERR(10),
 * FULL(13) and PROTOCOL(15). CANTOPEN(14) stays permanent: its message is
 * "unable to open database file", i.e. a path/permission fault.
 */
const TRANSIENT_SQLITE_PRIMARY_CODES: ReadonlySet<number> = new Set([5, 6, 7, 9, 10, 13, 15]);

/**
 * SQLite primary codes that never fix themselves: READONLY(8), CORRUPT(11),
 * CANTOPEN(14), SCHEMA(17) and NOTADB(26).
 */
const PERMANENT_SQLITE_PRIMARY_CODES: ReadonlySet<number> = new Set([8, 11, 14, 17, 26]);

/**
 * Errors that will not clear on retry: the engine is missing, the path or its
 * parent cannot be used, the file is not a sqlite database, or the schema is
 * corrupt/unexpected. `unable to open database file` is what SQLite reports for
 * ENOTDIR/EISDIR/ENOENT parents, and `file is not a database` for SQLITE_NOTADB.
 */
const PERMANENT_STORE_ERROR_PATTERN =
  /SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_READONLY|disk image is malformed|ENOTDIR|EACCES|EPERM|EROFS|ENOSPC|EISDIR|ENOENT|file is not a database|unable to open database file|node:sqlite (?:unavailable|does not expose)|does not exist/i;

/** node:sqlite's numeric `errcode`, reduced to its primary (non-extended) code. */
function sqlitePrimaryCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode !== "number" || !Number.isInteger(errcode)) return undefined;
  return errcode & 0xff;
}

/**
 * Classify one store failure from its message/code.
 *
 * Permanent wins over transient so a corrupt or inaccessible store fails fast;
 * an unrecognised error is treated as permanent because the cost of being wrong
 * is a warning storm that never recovers — the single warning therefore names
 * the error, so the diagnosis is actionable.
 */
export function classifyStoreFailure(error: unknown): StoreFailureClass {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const text = `${typeof code === "string" ? code : ""} ${errorMessage(error)}`;
  if (PERMANENT_STORE_ERROR_PATTERN.test(text)) return "permanent";
  const primary = sqlitePrimaryCode(error);
  if (primary !== undefined) {
    if (TRANSIENT_SQLITE_PRIMARY_CODES.has(primary)) return "transient";
    if (PERMANENT_SQLITE_PRIMARY_CODES.has(primary)) return "permanent";
  }
  if (TRANSIENT_STORE_ERROR_PATTERN.test(text)) return "transient";
  return "permanent";
}

/** One row as a string-keyed record, or undefined for a non-object result. */
export function asRow(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

export function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

/** A nullable INTEGER column, as a number or "not set". */
export function readOptionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

/** A nullable TEXT column, as a string or "not set". */
export function readOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

/** Locate `node:sqlite` lazily: an unavailable engine is a value, not a crash. */
export function loadSqlite(): SqliteStoreResult<SqliteEngine> {
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

/**
 * Tighten the database file and its WAL sidecars to 0600.
 *
 * WAL mode creates `-wal`/`-shm` next to the database on first write (and
 * recreates them as connections cycle); they carry the same shared state, so
 * leaving them at the umask default would make it world-readable on a multi-user
 * host. Best effort: a missing sidecar or a mode we cannot change must never
 * fail a dispatch.
 */
export function tightenStoreFileModes(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(candidate, 0o600);
    } catch {
      /* absent (no sidecar yet) or not ours to chmod */
    }
  }
}

/** Column names of one table, read from the live schema. */
export function columnNames(database: SqliteDatabaseLike, table: string): Set<string> {
  const names = new Set<string>();
  for (const raw of database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()) {
    const name = readString(asRow(raw) ?? {}, "name");
    if (name !== "") names.add(name);
  }
  return names;
}

/**
 * Add a column to an existing table, tolerating a concurrent writer that added it
 * between our `pragma_table_info` read and this `ALTER`.
 */
export function addColumnIfMissing(
  database: SqliteDatabaseLike,
  table: string,
  column: string,
  ddl: string,
): void {
  if (columnNames(database, table).has(column)) return;
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch (error) {
    if (!columnNames(database, table).has(column)) throw error;
  }
}

/**
 * Block for at most `milliseconds`.
 *
 * `node:sqlite` is synchronous, so a write path has no asynchronous seam to await
 * a backoff on. `Atomics.wait` on a private buffer is the smallest blocking sleep
 * available without a dependency or a spin loop (Node permits it on the main
 * thread).
 *
 * It runs on the extension thread, so the block is visible to everything else that
 * thread does. The bound is per write: 40 + 80 = 120 ms across the three attempts,
 * and two failing writes in one tick stack to 240 ms. That is tolerable for the
 * handful of state writes a tick makes, and it is why a hot path must not issue
 * repeated writes against a busy store without accounting for the stall it may
 * silently add.
 */
export function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Run `body` inside one `BEGIN IMMEDIATE`, rolling back on any throw. */
export function inImmediateTransaction<T>(database: SqliteDatabaseLike, body: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = body();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* the transaction is already gone; the original error is what matters */
    }
    throw error;
  }
}

/**
 * Bounded retry for a schema step: only a retryable lock/busy failure is
 * retried (a concurrent migration or a busy WAL writer); corruption, permission
 * errors and malformed schema fail on the first attempt so the permanent-store
 * path can stop retrying instead of delaying the diagnosis.
 */
export function applySchemaWithRetry(
  database: SqliteDatabaseLike,
  applySchema: (database: SqliteDatabaseLike) => void,
  attempts: number,
  onAttempt?: (attempt: number) => void,
): void {
  for (let attempt = 1; ; attempt += 1) {
    onAttempt?.(attempt);
    try {
      applySchema(database);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      if (classifyStoreFailure(error) !== "transient") throw error;
    }
  }
}

export interface OpenSqliteFileOptions {
  path: string;
  readOnly: boolean;
  /** Engine + schema seam for unit tests; when set the real file is not opened. */
  database?: SqliteDatabaseLike;
  applySchema: (database: SqliteDatabaseLike) => void;
  /** Bounded retries for the schema step (see {@link applySchemaWithRetry}). */
  schemaAttempts: number;
  onSchemaAttempt?: (attempt: number) => void;
  /** Prefix used in error values, e.g. `"repo state store"`. */
  label: string;
}

/**
 * Open (or accept an injected) SQLite database with the shared hardening.
 *
 * A write open creates the directory `0700`, enables WAL and runs the schema; a
 * read-only open touches nothing, so a viewer cannot migrate, checkpoint or
 * create tables behind the owner's back. A read-only open of a missing file is
 * reported as unopenable instead of letting SQLite create an empty database.
 */
export function openSqliteFile(
  options: OpenSqliteFileOptions,
): SqliteStoreResult<SqliteDatabaseLike> {
  if (options.database !== undefined) {
    // An injected database still runs the schema step, so the migration and its
    // retry policy are exercised against the fake rather than bypassed.
    try {
      applySchemaWithRetry(
        options.database,
        options.applySchema,
        options.schemaAttempts,
        options.onSchemaAttempt,
      );
      return { ok: true, value: options.database };
    } catch (error) {
      return { ok: false, error: `could not open ${options.path}: ${errorMessage(error)}` };
    }
  }
  try {
    if (!options.readOnly) {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    } else if (!existsSync(options.path)) {
      return { ok: false, error: `${options.label} ${options.path} does not exist` };
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
    applySchemaWithRetry(
      database,
      options.applySchema,
      options.schemaAttempts,
      options.onSchemaAttempt,
    );
    // WAL sidecars appear with the first WAL write, not necessarily with the
    // journal_mode switch, so the modes are also tightened after each commit.
    tightenStoreFileModes(options.path);
    return { ok: true, value: database };
  } catch (error) {
    return { ok: false, error: `could not open ${options.path}: ${errorMessage(error)}` };
  }
}
