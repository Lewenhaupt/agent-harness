// SYNC WARNING: this is the plain-JS mirror of the reference durable store's
// read half in `src/durable-member/standalone-store.ts`. The pi-web server
// module runs inside the session daemon and cannot import TypeScript, but it
// must still render a crashed member's last committed state, so it reads the
// same SQLite tables directly. Both sides must agree on:
//
//   - table names `entries`, `live_generations`, `task_nodes`;
//   - `entries` columns (seq, id, conversation_id, role, kind, timestamp, text,
//     payload) and the `payload` JSON fields (toolCall, toolOutput, retry,
//     compaction, failure);
//   - the cursor format (decimal `seq`, ordered with transcript pages);
//   - the payload shapes for the live generation and task nodes.
//
// The parity test `src/__tests__/durable-member-contract-parity.test.ts` reads
// one fixture database through both implementations and fails on disagreement.
//
// This reader has **no write path at all**: the connection is opened with
// `{ readOnly: true }` and the returned handle exposes reads only. The plugin
// server module asserts `store.readOnly === true` before using it (bd-186: "the
// panel never opens the storage writable").

import { DatabaseSync } from "node:sqlite";

/** Default store filename inside a member state dir. */
export const DURABLE_STORE_FILE = "store.sqlite";

export const DURABLE_ENTRIES_TABLE = "entries";
export const DURABLE_LIVE_TABLE = "live_generations";
export const DURABLE_TASKS_TABLE = "task_nodes";

/** Default transcript page size (mirrors `DEFAULT_TRANSCRIPT_PAGE`). */
export const DEFAULT_TRANSCRIPT_PAGE = 100;

const ENTRY_ROLES = ["user", "assistant", "tool", "system"];
const ENTRY_KINDS = ["message", "tool-call", "tool-output", "retry", "compaction", "failure"];
const TASK_STATUSES = ["pending", "running", "blocked", "done", "failed"];
const TASK_EDGES = ["parent", "child", "peer"];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(row, key) {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function readInteger(row, key) {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function optionalString(source, key) {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(source, key) {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalRecord(source, key) {
  const value = source[key];
  return isRecord(value) ? value : undefined;
}

function readToolCall(source) {
  const call = optionalRecord(source, "toolCall");
  if (call === undefined) return undefined;
  const name = optionalString(call, "name");
  if (name === undefined) return undefined;
  return { name, input: call.input };
}

function readToolOutput(source) {
  const output = optionalRecord(source, "toolOutput");
  if (output === undefined) return undefined;
  const name = optionalString(output, "name");
  const text = optionalString(output, "output");
  if (name === undefined || text === undefined) return undefined;
  const callId = optionalString(output, "callId");
  const result = { name, output: text };
  if (callId !== undefined) result.callId = callId;
  if (output.details !== undefined) result.details = output.details;
  return result;
}

function readRetry(source) {
  const retry = optionalRecord(source, "retry");
  if (retry === undefined) return undefined;
  const attempt = optionalNumber(retry, "attempt");
  if (attempt === undefined) return undefined;
  const result = { attempt };
  const maxAttempts = optionalNumber(retry, "maxAttempts");
  const reason = optionalString(retry, "reason");
  if (maxAttempts !== undefined) result.maxAttempts = maxAttempts;
  if (reason !== undefined) result.reason = reason;
  return result;
}

function readCompaction(source) {
  const compaction = optionalRecord(source, "compaction");
  if (compaction === undefined) return undefined;
  const summaryId = optionalString(compaction, "summaryId");
  const tokensBefore = optionalNumber(compaction, "tokensBefore");
  const tokensAfter = optionalNumber(compaction, "tokensAfter");
  if (summaryId === undefined && tokensBefore === undefined && tokensAfter === undefined) {
    return undefined;
  }
  const result = {};
  if (summaryId !== undefined) result.summaryId = summaryId;
  if (tokensBefore !== undefined) result.tokensBefore = tokensBefore;
  if (tokensAfter !== undefined) result.tokensAfter = tokensAfter;
  return result;
}

function readFailure(source, key = "failure") {
  const failure = optionalRecord(source, key);
  if (failure === undefined) return undefined;
  const message = optionalString(failure, "message");
  if (message === undefined) return undefined;
  const code = optionalString(failure, "code");
  return code === undefined ? { message } : { message, code };
}

function rowToEntry(row) {
  const payload = parseJson(readText(row, "payload"));
  const source = isRecord(payload) ? payload : {};
  const entry = {
    id: readText(row, "id"),
    conversationId: readText(row, "conversation_id"),
    cursor: String(readInteger(row, "seq")),
    role: readText(row, "role"),
    kind: readText(row, "kind"),
    timestamp: readInteger(row, "timestamp"),
    text: readText(row, "text"),
  };
  if (!ENTRY_ROLES.includes(entry.role)) {
    throw new Error(`durable entry has unknown role: ${entry.role}`);
  }
  if (!ENTRY_KINDS.includes(entry.kind)) {
    throw new Error(`durable entry has unknown kind: ${entry.kind}`);
  }
  const toolCall = readToolCall(source);
  const toolOutput = readToolOutput(source);
  const retry = readRetry(source);
  const compaction = readCompaction(source);
  const failure = readFailure(source);
  if (toolCall !== undefined) entry.toolCall = toolCall;
  if (toolOutput !== undefined) entry.toolOutput = toolOutput;
  if (retry !== undefined) entry.retry = retry;
  if (compaction !== undefined) entry.compaction = compaction;
  if (failure !== undefined) entry.failure = failure;
  return entry;
}

function rowToLiveGeneration(payload) {
  const raw = parseJson(payload);
  if (!isRecord(raw)) throw new Error("live generation row is not an object");
  const conversationId = optionalString(raw, "conversationId");
  const generationId = optionalString(raw, "generationId");
  if (conversationId === undefined || generationId === undefined) {
    throw new Error("live generation row is missing its identity");
  }
  const status = optionalString(raw, "status") ?? "streaming";
  const attempts = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
  const toolCalls = attempts.filter(isRecord).map((call) => {
    const callId = optionalString(call, "callId") ?? "";
    const name = optionalString(call, "name") ?? "";
    const callStatus = optionalString(call, "status");
    const normalized =
      callStatus === "done" || callStatus === "failed" || callStatus === "running"
        ? callStatus
        : "running";
    const result = { callId, name, input: call.input, status: normalized };
    if (typeof call.output === "string") result.output = call.output;
    if (call.details !== undefined) result.details = call.details;
    return result;
  });
  const generation = {
    conversationId,
    generationId,
    status:
      status === "streaming" ||
      status === "tool-call" ||
      status === "retrying" ||
      status === "compacting" ||
      status === "idle" ||
      status === "failed"
        ? status
        : "streaming",
    partialText: optionalString(raw, "partialText") ?? "",
    startedAt: optionalNumber(raw, "startedAt") ?? 0,
    updatedAt: optionalNumber(raw, "updatedAt") ?? 0,
    attempt: optionalNumber(raw, "attempt") ?? 0,
    toolCalls,
  };
  const retry = readRetry(raw);
  const compaction = readCompaction(raw);
  const runFailure = readFailure(raw, "runFailure");
  if (retry !== undefined) generation.retry = retry;
  if (compaction !== undefined) generation.compaction = compaction;
  if (runFailure !== undefined) generation.runFailure = runFailure;
  return generation;
}

function rowToTask(payload) {
  const raw = parseJson(payload);
  if (!isRecord(raw)) throw new Error("task node row is not an object");
  const statusValue = optionalString(raw, "status") ?? "pending";
  const waitingOn = Array.isArray(raw.waitingOn)
    ? raw.waitingOn.filter((value) => typeof value === "string")
    : [];
  const ownerRecord = optionalRecord(raw, "owner");
  const ownerMemberId = ownerRecord === undefined ? undefined : optionalString(ownerRecord, "memberId");
  const ownerEdgeValue = ownerRecord === undefined ? undefined : optionalString(ownerRecord, "edge");
  const edge =
    ownerEdgeValue === undefined ? undefined : TASK_EDGES.find((value) => value === ownerEdgeValue);
  const node = {
    id: optionalString(raw, "id") ?? "",
    title: optionalString(raw, "title") ?? "",
    status: TASK_STATUSES.find((value) => value === statusValue) ?? "pending",
    waitingOn,
    background: raw.background === true,
  };
  if (ownerMemberId !== undefined && edge !== undefined) {
    node.owner = { memberId: ownerMemberId, edge };
  }
  return node;
}

function normalizeLimit(limit) {
  if (limit === undefined) return DEFAULT_TRANSCRIPT_PAGE;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_TRANSCRIPT_PAGE;
  return Math.min(limit, 1000);
}

function parseCursor(cursor) {
  if (!/^[0-9]+$/.test(cursor)) throw new Error(`invalid transcript cursor: ${cursor}`);
  return Number(cursor);
}

/**
 * Open a member's store read-only.
 *
 * @param {{ path: string }} options
 * @returns {{ ok: true, store: object } | { ok: false, error: string }}
 */
export function openDurableStoreReader(options) {
  let database;
  try {
    database = new DatabaseSync(options.path, { readOnly: true, timeout: 5000 });
  } catch (error) {
    return { ok: false, error: `could not open ${options.path}: ${errorMessage(error)}` };
  }

  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error(`durable store ${options.path} is closed`);
  };

  const store = {
    readOnly: true,
    path: options.path,
    readEntryWindow(conversationId, windowOptions) {
      assertOpen();
      const limit = normalizeLimit(windowOptions?.limit);
      const before = windowOptions?.before;
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
      const cursor = entries.length === 0 ? null : entries[0].cursor;
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
      return database
        .prepare(`SELECT payload FROM ${DURABLE_TASKS_TABLE} ORDER BY id`)
        .all()
        .map((row) => rowToTask(readText(row, "payload")));
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
      const toolCall = readToolCall(source);
      const toolOutput = readToolOutput(source);
      const details = { entryId: entry.id, entry, raw: source };
      if (toolCall !== undefined) details.toolCall = toolCall;
      if (toolOutput !== undefined) details.toolOutput = toolOutput;
      return details;
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };

  return { ok: true, store };
}
