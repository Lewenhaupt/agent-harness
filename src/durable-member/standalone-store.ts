/**
 * Reference durable store (bd-186).
 *
 * pi-durable is not installed and is not vendored, so the read/write contract
 * needs an executable stand-in: this is a **reference durable store**, not
 * pi-durable. It implements the same single-writer shape over `node:sqlite`
 * (`DatabaseSync`, WAL) so that
 *
 * - the typed contract can be tested without pi-durable,
 * - the two-process WAL probe has a real storage to prove,
 * - the pi-web panel has a fixture that renders like a live member.
 *
 * One process owns the storage read-write; viewers open it with
 * `readOnly: true`. Writes and `resume()` on a read-only handle throw
 * {@link ReadOnlySessionError}, which is the runtime half of the invariant the
 * `DurableReader` type enforces statically.
 *
 * Nothing outside this file and its tests may import `node:sqlite`: the storage
 * engine stays behind this seam so replacing it with pi-durable is a module
 * swap, not a rewrite.
 *
 * // SYNC WARNING: the schema below is mirrored in plain JS at
 * // `pi-web-plugins/durable-member/store-reader.js`, which the pi-web server
 * // module uses to read a member's committed state (the daemon cannot import
 * // TypeScript). Both sides must agree on the table and column names, the
 * // `payload` JSON fields and the cursor format (decimal `seq`). The parity test
 * // `src/__tests__/durable-member-contract-parity.test.ts` reads one fixture
 * // database through both implementations and fails on disagreement.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  DurableEntry,
  DurableEntryDetails,
  DurableEntryKind,
  DurableEntryRole,
  DurableLiveGeneration,
  DurableLiveToolCall,
  DurableTaskNode,
  DurableTranscriptWindow,
} from "./contract.js";
import { ReadOnlySessionError } from "./contract.js";

/** Default store filename inside a member state dir. */
export const DURABLE_STORE_FILE = "store.sqlite";

/** Table holding committed transcript entries. */
export const DURABLE_ENTRIES_TABLE = "entries";

/** Table holding the live generation scratch row. */
export const DURABLE_LIVE_TABLE = "live_generations";

/** Table holding the durable task graph. */
export const DURABLE_TASKS_TABLE = "task_nodes";

/** Default transcript page size. */
export const DEFAULT_TRANSCRIPT_PAGE = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${DURABLE_ENTRIES_TABLE} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS entries_conversation_seq
  ON ${DURABLE_ENTRIES_TABLE} (conversation_id, seq);
CREATE TABLE IF NOT EXISTS ${DURABLE_LIVE_TABLE} (
  conversation_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${DURABLE_TASKS_TABLE} (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
`;

/** An entry as a writer supplies it; `cursor` is assigned by the store. */
export type DurableEntryInput = Omit<DurableEntry, "cursor">;

/** The reference store, opened either read-write (owner) or read-only (viewer). */
export interface DurableStore {
  readonly readOnly: boolean;
  readonly path: string;
  /** Owner-only: append or update one committed entry. */
  appendEntry(entry: DurableEntryInput): void;
  /** Owner-only: publish the live generation, or clear it with `null`. */
  setLiveGeneration(conversationId: string, generation: DurableLiveGeneration | null): void;
  /** Owner-only: upsert one task-graph node. */
  upsertTask(node: DurableTaskNode): void;
  /** Owner-only: pi-durable's resume; a read-only handle refuses it. */
  resume(conversationId: string): void;
  readEntryWindow(
    conversationId: string,
    options?: { readonly before?: string | null; readonly limit?: number },
  ): DurableTranscriptWindow;
  readLiveGeneration(conversationId: string): DurableLiveGeneration | null;
  readTaskGraph(): readonly DurableTaskNode[];
  readEntryDetails(entryId: string): DurableEntryDetails | null;
  close(): void;
}

export type DurableStoreOpen =
  | { readonly ok: true; readonly store: DurableStore }
  | { readonly ok: false; readonly error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENTRY_ROLES = ["user", "assistant", "tool", "system"] as const;
const ENTRY_KINDS = [
  "message",
  "tool-call",
  "tool-output",
  "retry",
  "compaction",
  "failure",
] as const;

function readText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function readInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Tool invocation payload inside an entry. */
const toolCallSchema = z.object({
  name: z.string(),
  input: z.unknown(),
});

const toolOutputSchema = z.object({
  name: z.string(),
  output: z.string(),
  callId: z.string().optional(),
  details: z.unknown().optional(),
});

const retrySchema = z.object({
  attempt: z.number(),
  maxAttempts: z.number().optional(),
  reason: z.string().optional(),
});

const compactionSchema = z
  .object({
    summaryId: z.string().optional(),
    tokensBefore: z.number().optional(),
    tokensAfter: z.number().optional(),
  })
  .refine(
    (marker) =>
      marker.summaryId !== undefined ||
      marker.tokensBefore !== undefined ||
      marker.tokensAfter !== undefined,
  );

const failureSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

const liveToolCallSchema = z.object({
  callId: z.string().catch(""),
  name: z.string().catch(""),
  input: z.unknown(),
  status: z.enum(["running", "done", "failed"]).catch("running"),
  output: z.string().optional().catch(undefined),
  details: z.unknown().optional(),
});

/** Unknown entries are dropped, matching the plain-JS reader. */
const toolCallsSchema = z
  .array(z.unknown())
  .catch([])
  .transform((rows): DurableLiveToolCall[] =>
    rows.flatMap((row) => {
      const parsed = liveToolCallSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }),
  );

/** Entry payload: every marker is optional and malformed markers are dropped. */
const entryPayloadSchema = z.object({
  toolCall: toolCallSchema.optional().catch(undefined),
  toolOutput: toolOutputSchema.optional().catch(undefined),
  retry: retrySchema.optional().catch(undefined),
  compaction: compactionSchema.optional().catch(undefined),
  failure: failureSchema.optional().catch(undefined),
});

/** Live generation payload; identity is required, everything else is tolerant. */
const liveGenerationSchema = z.object({
  conversationId: z.string(),
  generationId: z.string(),
  status: z
    .enum(["streaming", "tool-call", "retrying", "compacting", "idle", "failed"])
    .catch("streaming"),
  partialText: z.string().catch(""),
  startedAt: z.number().catch(0),
  updatedAt: z.number().catch(0),
  attempt: z.number().catch(0),
  toolCalls: toolCallsSchema,
  retry: retrySchema.optional().catch(undefined),
  compaction: compactionSchema.optional().catch(undefined),
  runFailure: failureSchema.optional().catch(undefined),
});

/** Task-graph payload; mirrors the plain-JS reader's tolerant defaults. */
const taskNodeSchema = z.object({
  id: z.string().catch(""),
  title: z.string().catch(""),
  status: z.enum(["pending", "running", "blocked", "done", "failed"]).catch("pending"),
  owner: z
    .object({ memberId: z.string(), edge: z.enum(["parent", "child", "peer"]) })
    .optional()
    .catch(undefined),
  waitingOn: z
    .array(z.unknown())
    .catch([])
    .transform((rows) => rows.filter((value): value is string => typeof value === "string")),
  background: z.boolean().catch(false),
});

function readRole(value: string): DurableEntryRole {
  const parsed = z.enum(ENTRY_ROLES).safeParse(value);
  if (!parsed.success) throw new Error(`durable entry has unknown role: ${value}`);
  return parsed.data;
}

function readKind(value: string): DurableEntryKind {
  const parsed = z.enum(ENTRY_KINDS).safeParse(value);
  if (!parsed.success) throw new Error(`durable entry has unknown kind: ${value}`);
  return parsed.data;
}

/** Row -> contract entry. Invalid rows are corruption, reported not coerced. */
function rowToEntry(row: Record<string, unknown>): DurableEntry {
  const parsed = entryPayloadSchema.safeParse(parseJson(readText(row, "payload")));
  const payload = parsed.success ? parsed.data : {};
  const toolCall = payload.toolCall;
  const toolOutput = payload.toolOutput;
  const retry = payload.retry;
  const compaction = payload.compaction;
  const failure = payload.failure;
  return {
    id: readText(row, "id"),
    conversationId: readText(row, "conversation_id"),
    cursor: String(readInteger(row, "seq")),
    role: readRole(readText(row, "role")),
    kind: readKind(readText(row, "kind")),
    timestamp: readInteger(row, "timestamp"),
    text: readText(row, "text"),
    ...(toolCall === undefined ? {} : { toolCall }),
    ...(toolOutput === undefined ? {} : { toolOutput }),
    ...(retry === undefined ? {} : { retry }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function rowToLiveGeneration(payload: string): DurableLiveGeneration {
  const parsed = liveGenerationSchema.safeParse(parseJson(payload));
  if (!parsed.success) {
    throw new Error("live generation row does not match the durable contract");
  }
  return parsed.data;
}

function rowToTask(payload: string): DurableTaskNode {
  const parsed = taskNodeSchema.safeParse(parseJson(payload));
  if (!parsed.success) throw new Error("task node row does not match the durable contract");
  return parsed.data;
}

function serializePayload(entry: DurableEntryInput): string {
  return JSON.stringify({
    ...(entry.toolCall === undefined ? {} : { toolCall: entry.toolCall }),
    ...(entry.toolOutput === undefined ? {} : { toolOutput: entry.toolOutput }),
    ...(entry.retry === undefined ? {} : { retry: entry.retry }),
    ...(entry.compaction === undefined ? {} : { compaction: entry.compaction }),
    ...(entry.failure === undefined ? {} : { failure: entry.failure }),
  });
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TRANSCRIPT_PAGE;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_TRANSCRIPT_PAGE;
  return Math.min(limit, 1000);
}

/** Parse a transcript cursor (a decimal `seq`) or throw. */
function parseCursor(cursor: string): number {
  if (!/^[0-9]+$/.test(cursor)) throw new Error(`invalid transcript cursor: ${cursor}`);
  return Number(cursor);
}

type DatabaseOpen =
  | { readonly ok: true; readonly database: DatabaseSync }
  | { readonly ok: false; readonly error: string };

/**
 * Open the SQLite file.
 *
 * A write open creates the directory, switches the file to WAL and creates the
 * schema; a read-only open touches nothing, so a viewer cannot migrate,
 * checkpoint or create tables behind the owner's back.
 */
function openDatabase(path: string, readOnly: boolean): DatabaseOpen {
  try {
    if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(path, {
      readOnly,
      // A viewer may race the owner's checkpoint; wait instead of failing.
      timeout: 5000,
    });
    if (readOnly) return { ok: true, database };
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(SCHEMA);
    return { ok: true, database };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Open the reference store.
 *
 * Read-write opens a WAL database (`journal_mode=WAL`) and creates the schema;
 * read-only opens the same file with `{ readOnly: true }` and never touches the
 * schema, so a viewer cannot migrate, write or checkpoint.
 */
export function openDurableStore(options: {
  readonly path: string;
  readonly readOnly?: boolean;
}): DurableStoreOpen {
  const readOnly = options.readOnly === true;
  const opened = openDatabase(options.path, readOnly);
  if (!opened.ok) {
    return { ok: false, error: `could not open ${options.path}: ${opened.error}` };
  }
  const database = opened.database;

  let closed = false;
  const assertWritable = (operation: string): void => {
    if (readOnly) throw new ReadOnlySessionError(operation);
  };
  const assertOpen = (): void => {
    if (closed) throw new Error(`durable store ${options.path} is closed`);
  };

  const store: DurableStore = {
    readOnly,
    path: options.path,
    appendEntry(entry) {
      assertWritable("appendEntry");
      assertOpen();
      database
        .prepare(
          `INSERT INTO ${DURABLE_ENTRIES_TABLE}
             (id, conversation_id, role, kind, timestamp, text, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             role = excluded.role,
             kind = excluded.kind,
             timestamp = excluded.timestamp,
             text = excluded.text,
             payload = excluded.payload`,
        )
        .run(
          entry.id,
          entry.conversationId,
          entry.role,
          entry.kind,
          entry.timestamp,
          entry.text,
          serializePayload(entry),
        );
    },
    setLiveGeneration(conversationId, generation) {
      assertWritable("setLiveGeneration");
      assertOpen();
      if (generation === null) {
        database
          .prepare(`DELETE FROM ${DURABLE_LIVE_TABLE} WHERE conversation_id = ?`)
          .run(conversationId);
        return;
      }
      database
        .prepare(
          `INSERT INTO ${DURABLE_LIVE_TABLE} (conversation_id, payload) VALUES (?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET payload = excluded.payload`,
        )
        .run(conversationId, JSON.stringify(generation));
    },
    upsertTask(node) {
      assertWritable("upsertTask");
      assertOpen();
      database
        .prepare(
          `INSERT INTO ${DURABLE_TASKS_TABLE} (id, payload) VALUES (?, ?)
           ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
        )
        .run(node.id, JSON.stringify(node));
    },
    resume(conversationId) {
      assertWritable("resume");
      assertOpen();
      const present = database
        .prepare(
          `SELECT 1 AS present FROM ${DURABLE_ENTRIES_TABLE} WHERE conversation_id = ? LIMIT 1`,
        )
        .get(conversationId);
      if (present === undefined) {
        throw new Error(`no durable conversation ${conversationId} to resume`);
      }
    },
    readEntryWindow(conversationId, options) {
      assertOpen();
      const limit = normalizeLimit(options?.limit);
      const before = options?.before;
      const beforeSeq = before === undefined || before === null ? null : parseCursor(before);
      const rows =
        beforeSeq === null
          ? database
              .prepare(
                `SELECT seq, id, conversation_id, role, kind, timestamp, text, payload
                 FROM ${DURABLE_ENTRIES_TABLE}
                 WHERE conversation_id = ?
                 ORDER BY seq DESC LIMIT ?`,
              )
              .all(conversationId, limit)
          : database
              .prepare(
                `SELECT seq, id, conversation_id, role, kind, timestamp, text, payload
                 FROM ${DURABLE_ENTRIES_TABLE}
                 WHERE conversation_id = ? AND seq < ?
                 ORDER BY seq DESC LIMIT ?`,
              )
              .all(conversationId, beforeSeq, limit);

      const entries = rows.map(rowToEntry).reverse();
      const oldest = entries[0];
      const cursor = oldest === undefined ? null : oldest.cursor;
      const hasEarlier =
        cursor === null
          ? false
          : database
              .prepare(
                `SELECT 1 AS present FROM ${DURABLE_ENTRIES_TABLE}
                 WHERE conversation_id = ? AND seq < ? LIMIT 1`,
              )
              .get(conversationId, Number(cursor)) !== undefined;
      return { entries, cursor, hasEarlier };
    },
    readLiveGeneration(conversationId) {
      assertOpen();
      const row = database
        .prepare(`SELECT payload FROM ${DURABLE_LIVE_TABLE} WHERE conversation_id = ?`)
        .get(conversationId);
      if (row === undefined) return null;
      return rowToLiveGeneration(readText(row, "payload"));
    },
    readTaskGraph() {
      assertOpen();
      const rows = database.prepare(`SELECT payload FROM ${DURABLE_TASKS_TABLE} ORDER BY id`).all();
      return rows.map((row) => rowToTask(readText(row, "payload")));
    },
    readEntryDetails(entryId) {
      assertOpen();
      const row = database
        .prepare(
          `SELECT seq, id, conversation_id, role, kind, timestamp, text, payload
           FROM ${DURABLE_ENTRIES_TABLE} WHERE id = ?`,
        )
        .get(entryId);
      if (row === undefined) return null;
      const entry = rowToEntry(row);
      const parsed = parseJson(readText(row, "payload"));
      const source = isRecord(parsed) ? parsed : {};
      const payload = entryPayloadSchema.safeParse(source);
      const markers = payload.success ? payload.data : {};
      return {
        entryId: entry.id,
        entry,
        ...(markers.toolCall === undefined ? {} : { toolCall: markers.toolCall }),
        ...(markers.toolOutput === undefined ? {} : { toolOutput: markers.toolOutput }),
        raw: source,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };

  return { ok: true, store };
}
