/**
 * requestId idempotency owned by the member writer (bd-186).
 *
 * A retrying panel, a supervisor resume, or a mailbox drain after a crash all
 * deliver the same `requestId` again. The owner is the only component that can
 * dedupe, because it is the only writer: one in-memory map for the live process
 * plus an append-only JSONL ledger in the member state dir, replayed on start so
 * a restart cannot double-steer either.
 *
 * `dispatch.ts` records a requestId **after** the apply succeeded, so a failed
 * apply is retryable instead of being remembered as done.
 *
 * Pruning is deterministic: insertion order, oldest dropped first, and the
 * ledger is rewritten atomically from the retained set. Evicted ids move into a
 * bounded **tombstone** window (persisted in `dedupe.tombstones.jsonl`), so a
 * late retry of a recently applied id still reports `duplicate: true` instead of
 * re-applying after the cap rolled over.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DurableCommandKind } from "./commands.js";
import { DURABLE_COMMAND_KINDS } from "./commands.js";

/** Ledger filename inside the member state dir. */
export const DEDUPE_LEDGER_FILE = "dedupe.jsonl";

/** Tombstone filename inside the member state dir. */
export const DEDUPE_TOMBSTONE_FILE = "dedupe.tombstones.jsonl";

/** How many applied request ids are remembered (live map and replay). */
export const DEFAULT_DEDUPE_MAX_ENTRIES = 5000;

/** How many pruned request ids stay deduplicated as tombstones. */
export const DEFAULT_DEDUPE_TOMBSTONE_ENTRIES = 1000;

/** One applied command, as the ledger keeps it. */
export interface DedupeRecord {
  readonly requestId: string;
  readonly kind: DurableCommandKind;
  readonly appliedAt: number;
}

export type DedupeRecordResult =
  | { readonly ok: true; readonly pruned: number }
  | { readonly ok: false; readonly error: string };

/**
 * Writer-owned dedupe seam. `has` is what makes a repeat a no-op; `record`
 * persists an already-applied id so the next process agrees.
 */
export interface DedupeLedger {
  has(requestId: string): boolean;
  record(record: DedupeRecord): DedupeRecordResult;
  size(): number;
  entries(): readonly DedupeRecord[];
  tombstones(): readonly DedupeRecord[];
}

export interface DedupeLedgerOptions {
  readonly stateDir: string;
  readonly maxEntries?: number;
  /** Pruned-but-recent ids kept deduplicated; defaults to 1000. */
  readonly tombstoneEntries?: number;
  readonly ledgerFile?: string;
  readonly tombstoneFile?: string;
}

export type DedupeLedgerOpen =
  | { readonly ok: true; readonly ledger: DedupeLedger; readonly path: string }
  | { readonly ok: false; readonly error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isCommandKind(value: unknown): value is DurableCommandKind {
  return DURABLE_COMMAND_KINDS.some((kind) => kind === value);
}

/** Parse one ledger line; malformed history is skipped, not trusted. */
function parseRecordLine(line: string): DedupeRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const { requestId, kind, appliedAt } = raw;
  if (typeof requestId !== "string" || requestId === "") return undefined;
  if (!isCommandKind(kind)) return undefined;
  if (typeof appliedAt !== "number" || !Number.isFinite(appliedAt)) return undefined;
  return { requestId, kind, appliedAt };
}

function serializeRecord(record: DedupeRecord): string {
  return `${JSON.stringify({
    requestId: record.requestId,
    kind: record.kind,
    appliedAt: record.appliedAt,
  })}\n`;
}

/** Rewrite one ledger file from the retained records; tmp + rename is atomic. */
function rewriteFile(path: string, records: readonly DedupeRecord[]): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, records.map(serializeRecord).join(""), { mode: 0o600 });
  renameSync(temporary, path);
}

function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

/** Re-inserting keeps insertion order equal to the file's order. */
function insertRecord(map: Map<string, DedupeRecord>, record: DedupeRecord): void {
  map.delete(record.requestId);
  map.set(record.requestId, record);
}

/** Parse one JSONL history file into an insertion-ordered map. */
function readRecords(
  path: string,
):
  | { readonly ok: true; readonly records: Map<string, DedupeRecord> }
  | { readonly ok: false; readonly error: string } {
  let content: string | undefined;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { ok: true, records: new Map() };
    return { ok: false, error: `could not read ${path}: ${errorMessage(error)}` };
  }
  const records = new Map<string, DedupeRecord>();
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecordLine(line);
    if (record === undefined) continue;
    insertRecord(records, record);
  }
  return { ok: true, records };
}

/** Drop the oldest records over the cap; returns the evicted records. */
function pruneApplied(applied: Map<string, DedupeRecord>, maxEntries: number): DedupeRecord[] {
  const evicted: DedupeRecord[] = [];
  while (applied.size > maxEntries) {
    const oldest = applied.keys().next();
    if (oldest.done === true) break;
    const record = applied.get(oldest.value);
    applied.delete(oldest.value);
    if (record !== undefined) evicted.push(record);
  }
  return evicted;
}

/** Keep the newest tombstones, dropping the oldest over the cap. */
function pruneTombstones(map: Map<string, DedupeRecord>, maxEntries: number): number {
  let pruned = 0;
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
    pruned += 1;
  }
  return pruned;
}

function addTombstones(
  map: Map<string, DedupeRecord>,
  records: readonly DedupeRecord[],
  maxEntries: number,
): number {
  for (const record of records) insertRecord(map, record);
  return pruneTombstones(map, maxEntries);
}

/**
 * Open (and replay) the ledger for one member.
 *
 * A missing ledger is an empty one: the first command ever sent must not need a
 * migration. An unreadable ledger is an error, because dedupe that silently
 * starts from empty would double-apply the next retry.
 */
export function createDedupeLedger(options: DedupeLedgerOptions): DedupeLedgerOpen {
  const maxEntries = options.maxEntries ?? DEFAULT_DEDUPE_MAX_ENTRIES;
  const tombstoneEntries = options.tombstoneEntries ?? DEFAULT_DEDUPE_TOMBSTONE_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    return { ok: false, error: "maxEntries must be a positive integer" };
  }
  if (!Number.isInteger(tombstoneEntries) || tombstoneEntries < 0) {
    return { ok: false, error: "tombstoneEntries must be a non-negative integer" };
  }

  const path = join(options.stateDir, options.ledgerFile ?? DEDUPE_LEDGER_FILE);
  const tombstonePath = join(options.stateDir, options.tombstoneFile ?? DEDUPE_TOMBSTONE_FILE);

  const loaded = readRecords(path);
  if (!loaded.ok) return loaded;
  const tombstoned = readRecords(tombstonePath);
  if (!tombstoned.ok) return tombstoned;

  const applied = loaded.records;
  const tombstones = tombstoned.records;
  const evictedOnStart = pruneApplied(applied, maxEntries);
  const droppedTombstones = addTombstones(tombstones, evictedOnStart, tombstoneEntries);

  // A ledger from an older cap keeps its newest entries, matching live pruning.
  try {
    ensureStateDir(options.stateDir);
    if (evictedOnStart.length > 0) rewriteFile(path, [...applied.values()]);
    if (evictedOnStart.length > 0 || droppedTombstones > 0) {
      rewriteFile(tombstonePath, [...tombstones.values()]);
    }
  } catch (error) {
    return { ok: false, error: `could not rewrite ${path}: ${errorMessage(error)}` };
  }

  const ledger: DedupeLedger = {
    has(requestId) {
      return applied.has(requestId) || tombstones.has(requestId);
    },
    record(entry) {
      return recordEntry({
        applied,
        tombstones,
        maxEntries,
        tombstoneEntries,
        stateDir: options.stateDir,
        path,
        tombstonePath,
        entry,
      });
    },
    size() {
      return applied.size;
    },
    entries() {
      return [...applied.values()];
    },
    tombstones() {
      return [...tombstones.values()];
    },
  };

  return { ok: true, ledger, path };
}

interface RecordEntryOptions {
  readonly applied: Map<string, DedupeRecord>;
  readonly tombstones: Map<string, DedupeRecord>;
  readonly maxEntries: number;
  readonly tombstoneEntries: number;
  readonly stateDir: string;
  readonly path: string;
  readonly tombstonePath: string;
  readonly entry: DedupeRecord;
}

/**
 * Append one successfully applied request id.
 *
 * A repeat (live or tombstoned) is idempotent and appends nothing. The eviction
 * window is persisted with the ledger so a restart agrees with the live process.
 */
function recordEntry(options: RecordEntryOptions): DedupeRecordResult {
  if (
    options.applied.has(options.entry.requestId) ||
    options.tombstones.has(options.entry.requestId)
  ) {
    return { ok: true, pruned: 0 };
  }
  options.applied.set(options.entry.requestId, options.entry);
  try {
    ensureStateDir(options.stateDir);
    appendFileSync(options.path, serializeRecord(options.entry), { mode: 0o600 });
  } catch (error) {
    options.applied.delete(options.entry.requestId);
    return { ok: false, error: `could not append to ${options.path}: ${errorMessage(error)}` };
  }

  const evicted = pruneApplied(options.applied, options.maxEntries);
  const droppedTombstones = addTombstones(options.tombstones, evicted, options.tombstoneEntries);
  if (evicted.length === 0 && droppedTombstones === 0) {
    return { ok: true, pruned: 0 };
  }

  try {
    if (evicted.length > 0) rewriteFile(options.path, [...options.applied.values()]);
    rewriteFile(options.tombstonePath, [...options.tombstones.values()]);
    return { ok: true, pruned: evicted.length };
  } catch (error) {
    // The in-memory cap already moved the ids; report the file failure so the
    // dispatcher can mark the applied command as unrecorded.
    return { ok: false, error: `could not rewrite ${options.path}: ${errorMessage(error)}` };
  }
}
