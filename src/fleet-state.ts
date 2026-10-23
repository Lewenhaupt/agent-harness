/**
 * Shared fleet state — the cross-tree substrate of the fleet supervisor
 * (bd-126, milestones P1–P4 of docs/fleet-orchestrator.md).
 *
 * Everything cross-worktree lives under `<git-common-dir>/belayd/fleet/<fleetId>/`:
 *
 *   fleet.json        operator intent (one record, one schema)
 *   inbox/            member → supervisor notes, drained at turn start
 *   events/           supervisor → member notifications, drained at turn start
 *   merge-queue.json  single-flight merge queue (P2)
 *   audit.log         append-only audit of cross-tree authority
 *
 * This module is storage plus pure parsing: nothing here schedules, spawns,
 * merges, stashes, or mutates a bead. Every write is the caller's explicit
 * call — nothing in this module happens implicitly.
 *
 * Split, mirroring `fleet-status.ts`: the path helpers, note naming, audit
 * formatting, and the parsers are pure (tests pass values, no mocks); each
 * reader/writer takes an injected {@link FleetStateFs} seam.
 */

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { FleetIntent } from "./fleet-status.js";
import {
  FLEET_SCHEMA_VERSION,
  fleetAuditLogPath,
  fleetEventsDir,
  fleetInboxDir,
  fleetIntentFilePath,
  fleetMergeQueueFilePath,
  fleetStateDir,
  parseFleetIntent,
  sanitizeFleetId,
} from "./fleet-status.js";
import type { WorkflowFs } from "./workflow-state.js";
import { atomicWriteJson } from "./workflow-state.js";

// Re-exported so a P1+ consumer imports the whole layout from one module. They
// stay declared in `fleet-status.ts` because the sanitizer and the directory
// shape must have exactly one implementation.
export {
  fleetAuditLogPath,
  fleetEventsDir,
  fleetInboxDir,
  fleetIntentFilePath,
  fleetMergeQueueFilePath,
};

// ── Paths ─────────────────────────────────────────────────────────────

/** `<git-common-dir>/belayd/fleet` — the only cross-worktree root. */
export function fleetRoot(gitCommonDir: string): string {
  return join(gitCommonDir, "belayd", "fleet");
}

/**
 * One fleet's state directory. Delegates to `fleetStateDir` so the id-scoped
 * layout and its sanitizer have exactly one implementation (the P0 reader's).
 */
export function fleetDir(gitCommonDir: string, fleetId: string): string {
  return fleetStateDir(gitCommonDir, fleetId);
}

/**
 * Out-of-band single-flight primitive for the merge lock: `<fleetDir>/merge.lock.d`.
 *
 * `mkdir` is atomic on POSIX — it either creates the directory or fails with
 * `EEXIST` — which is what makes exactly one concurrent supervisor the winner.
 * The JSON lock record in `merge-queue.json` cannot do that on its own: two
 * readers can both see "lock free". The directory therefore holds nothing (the
 * record lives in the queue), so a residual directory is unambiguously an
 * orphaned primitive rather than data.
 */
export function fleetMergeLockDir(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "merge.lock.d");
}

// ── Filesystem seam ───────────────────────────────────────────────────

/**
 * Fs surface the fleet state layer needs: the workflow-state read/write seam
 * (so `atomicWriteJson` can be reused unchanged) plus the append and
 * directory-listing operations the audit log and mailbox need.
 */
export interface FleetStateFs extends WorkflowFs {
  appendFileSync(path: string, data: string): void;
  readdirSync(path: string): string[];
  /**
   * Metadata only: the drain bounds its read before touching file content, and
   * the merge-lock recovery ages an orphaned lock directory by its mtime.
   * `mtimeMs` is optional so an fs seam without timestamps still works.
   */
  statSync(path: string): { size: number; mtimeMs?: number };
  /** Remove an empty directory: the merge lock's `mkdir` primitive, released. */
  rmdirSync(path: string): void;
}

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

/**
 * Locale-independent string order, matching the fleet status view. Ordering by
 * `localeCompare` would let the host ICU locale reorder mailbox drains and
 * audit-adjacent output.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Truncate to at most `limit` characters, marking that it was cut. */
function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/** Result of any fleet-state write. */
export type FleetStateWriteResult = { ok: true } | { ok: false; error: string };

// ── fleet.json intent ─────────────────────────────────────────────────

/**
 * The stored fleet id must always match the directory that holds the record;
 * otherwise two fleet ids could claim one intent. Sanitizing here is idempotent
 * for the id the path helpers already derived.
 */
function withDirectoryFleetId(intent: FleetIntent, fleetId: string): FleetIntent {
  return { ...intent, fleetId: sanitizeFleetId(fleetId) };
}

export interface FleetIntentOptions {
  gitCommonDir: string;
  fleetId: string;
  fs?: FleetStateFs;
}

/**
 * Multi-outcome on purpose: `corrupt-intent` is distinguishable from absence
 * because a writer must not silently replace a record it failed to understand.
 */
export type FleetIntentLoadResult =
  | { ok: true; intent: FleetIntent | undefined }
  | { ok: false; reason: "corrupt-intent" | "read-failed"; error: string };

/**
 * Raw load of `fleet.json`: the parsed record plus the exact text it came from.
 *
 * The raw text is what makes compare-and-replace possible: an updater can only
 * prove it based its change on the bytes still on disk if it kept them.
 */
type FleetIntentRawLoad =
  | { ok: true; raw: string | undefined; intent: FleetIntent | undefined }
  | { ok: false; reason: "corrupt-intent" | "read-failed"; error: string };

function readFleetIntentRaw(options: FleetIntentOptions): FleetIntentRawLoad {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = fleetIntentFilePath(options.gitCommonDir, options.fleetId);

  let raw: string;
  try {
    if (!fs.existsSync(filePath)) return { ok: true, raw: undefined, intent: undefined };
    raw = fs.readFileSync(filePath);
  } catch (error) {
    return { ok: false, reason: "read-failed", error: errorMessage(error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt-intent", error: `${filePath} is not valid JSON` };
  }

  const intent = parseFleetIntent(parsed);
  if (intent === undefined) {
    return { ok: false, reason: "corrupt-intent", error: `${filePath} is not a fleet intent` };
  }
  return { ok: true, raw, intent };
}

/** Read `fleet.json`. Absent means "no intent"; a corrupt file is reported. */
export function readFleetIntent(options: FleetIntentOptions): FleetIntentLoadResult {
  const loaded = readFleetIntentRaw(options);
  return loaded.ok ? { ok: true, intent: loaded.intent } : loaded;
}

export interface WriteFleetIntentOptions extends FleetIntentOptions {
  intent: FleetIntent;
}

/**
 * Replace `fleet.json` atomically (temp file + rename).
 *
 * Absence is writable; a **present but unparsable** record is refused. The
 * single-schema guarantee only holds if every writer refuses what it cannot
 * read: replacing an unreadable file would erase operator intent (possibly
 * written by a newer schema) that this version simply does not understand.
 * Mutations should go through {@link updateFleetIntent}; this function is the
 * wholesale-replace form of the same rule.
 */
export function writeFleetIntent(options: WriteFleetIntentOptions): FleetStateWriteResult {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = fleetIntentFilePath(options.gitCommonDir, options.fleetId);
  const current = readFleetIntentRaw({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!current.ok) {
    return {
      ok: false,
      error: `refusing to replace unreadable fleet intent at ${filePath}: ${current.error}`,
    };
  }
  return writeFleetIntentUnchecked({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    intent: options.intent,
    fs,
  });
}

/**
 * Module-private write with no read-first check, for callers that already
 * decided the replace is safe (the compare-and-replace path below, which just
 * compared the on-disk bytes). Never export this: it is the hole
 * {@link writeFleetIntent} exists to close.
 */
function writeFleetIntentUnchecked(options: WriteFleetIntentOptions): FleetStateWriteResult {
  const fs = options.fs ?? nodeFsSeam;
  return atomicWriteJson(
    fleetIntentFilePath(options.gitCommonDir, options.fleetId),
    withDirectoryFleetId(options.intent, options.fleetId),
    fs,
  );
}

/**
 * An updater that must not write after all: the record read inside the update is
 * missing or in a state the caller refuses to change.
 *
 * This exists so a mutation whose precondition is only decidable from the *fresh*
 * record (park, unpause, prune) can stay on the compare-and-replace path instead of
 * reading first and then writing blind: a blind write after a separate read loses
 * any update that landed in between.
 */
export interface FleetIntentUpdateRefusal {
  refuse: string;
}

/** What an updater may return: a replacement record, or a refusal with a reason. */
export type FleetIntentUpdateOutcome = FleetIntent | FleetIntentUpdateRefusal;

function isUpdateRefusal(value: FleetIntentUpdateOutcome): value is FleetIntentUpdateRefusal {
  return typeof value === "object" && value !== null && "refuse" in value;
}

export interface UpdateFleetIntentOptions extends FleetIntentOptions {
  /** Pure updater: receives the current record (undefined when absent). */
  update: (current: FleetIntent | undefined) => FleetIntentUpdateOutcome;
}

export type UpdateFleetIntentResult =
  | { ok: true; intent: FleetIntent }
  | {
      ok: false;
      reason: "corrupt-intent" | "read-failed" | "write-failed" | "conflict" | "refused";
      error: string;
    };

/**
 * Read-modify-write `fleet.json` with compare-and-replace.
 *
 * A corrupt record is refused rather than overwritten: replacing it would erase
 * operator intent the supervisor could not read.
 *
 * **Concurrency (W6):** the update only writes when the on-disk text still
 * equals the text it read, so two interleaved writers cannot silently drop one
 * update — the loser sees `conflict` and retries against the newer record.
 * Residual race, documented not hidden: this is check-then-write, not an atomic
 * CAS. Two writers can both compare successfully and then both write, and the
 * second rename wins. Closing that window needs a filesystem primitive
 * (`O_EXCL` sidecar, the same one W5's merge lock requires), which P2 must
 * supply before members — rather than only the supervisor — mutate intent.
 */
export function updateFleetIntent(options: UpdateFleetIntentOptions): UpdateFleetIntentResult {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = fleetIntentFilePath(options.gitCommonDir, options.fleetId);
  const before = readFleetIntentRaw({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!before.ok) return before;

  const outcome = options.update(before.intent);
  if (isUpdateRefusal(outcome)) {
    return { ok: false, reason: "refused", error: outcome.refuse };
  }
  const next = withDirectoryFleetId(outcome, options.fleetId);

  const current = readFleetIntentRaw({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!current.ok) return current;
  if (current.raw !== before.raw) {
    return {
      ok: false,
      reason: "conflict",
      error: `${filePath} changed while updating; re-read and retry`,
    };
  }

  const written = writeFleetIntentUnchecked({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    intent: next,
    fs,
  });
  return written.ok
    ? { ok: true, intent: next }
    : { ok: false, reason: "write-failed", error: written.error };
}

export interface CreateFleetIntentInput {
  fleetId: string;
  taskIds: readonly string[];
  /** Epoch-ms clock value supplied by the caller (no ambient `Date.now` here). */
  now: number;
  maxConcurrent?: number;
  baseBranch?: string;
  supervisor?: FleetIntent["supervisor"];
  note?: string;
  /** Members P3 could not launch yet, with the reason each waits. */
  deferred?: FleetIntent["deferred"];
  /** Why the fleet is paused, when a repair path wrote a reason (P2/P4). */
  park?: FleetIntent["park"];
}

/**
 * The intent without the pause-related fields (`paused`, `park`, `note`), keeping
 * every other fact.
 *
 * Pause, resume, and reconcile's park repair all need exactly this projection, so
 * it has one implementation: a field added to the intent later is carried over by
 * `...intent` instead of being silently dropped by a hand-maintained field list.
 */
export function withoutPauseFields(intent: FleetIntent, now: number): FleetIntent {
  const next: FleetIntent = { ...intent, taskIds: [...intent.taskIds], updatedAt: now };
  for (const field of ["paused", "park", "note"] as const) delete next[field];
  return next;
}

/** Build the record P1 launch writes; ids keep the caller's order for stability. */
export function createFleetIntent(input: CreateFleetIntentInput): FleetIntent {
  return {
    schemaVersion: FLEET_SCHEMA_VERSION,
    fleetId: sanitizeFleetId(input.fleetId),
    taskIds: [...input.taskIds],
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
    ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
    ...(input.supervisor === undefined ? {} : { supervisor: input.supervisor }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.deferred === undefined ? {} : { deferred: input.deferred }),
    ...(input.park === undefined ? {} : { park: input.park }),
  };
}

/**
 * Every member the fleet knows about: launched members first, then the ones a
 * launch deferred, in intent order.
 *
 * A deferred member has no running session but is still an addressee: mail queued
 * for it before its wave launches is delivered at that session's first turn. The
 * P0 member *count* deliberately stays `taskIds`-only (a deferred member has no
 * worktree to observe), so this helper is for addressing, not for status.
 */
export function fleetMemberTaskIds(intent: FleetIntent): readonly string[] {
  const deferred = (intent.deferred ?? []).map((entry) => entry.taskId);
  return [...intent.taskIds, ...deferred.filter((taskId) => !intent.taskIds.includes(taskId))];
}

// ── audit.log ─────────────────────────────────────────────────────────

/** Characters of `detail` kept in one audit line. */
export const FLEET_AUDIT_DETAIL_MAX_LENGTH = 400;

/** Characters of `actor` kept. Real actors are session ids (tens of characters). */
export const FLEET_AUDIT_ACTOR_MAX_LENGTH = 120;

/** Characters of `action` kept. Actions are short verbs (`dispatch`, `merge`). */
export const FLEET_AUDIT_ACTION_MAX_LENGTH = 80;

/** Task ids kept per entry. A fleet merge names its members, not the whole repo. */
export const FLEET_AUDIT_TASK_IDS_MAX = 64;

/** Characters per task id kept. */
export const FLEET_AUDIT_TASK_ID_MAX_LENGTH = 64;

export interface FleetAuditEntry {
  /** Epoch-ms, supplied by the caller so the formatter stays pure. */
  timestamp: number;
  /** Sanitized fleet id the entry belongs to. */
  fleetId: string;
  /** Supervisor session id that exercised the authority. */
  actor: string;
  /** Short verb, e.g. `dispatch`, `note`, `merge`. */
  action: string;
  taskIds: readonly string[];
  detail: string;
}

/**
 * One JSONL audit line, keys in a fixed order.
 *
 * Every free-text field is bounded, not just `detail`: `actor`, `action`, and
 * the id list are equally caller-supplied, so one runaway string or a 10k-id
 * array could otherwise bloat a single line past any useful size. `JSON`
 * escaping means a detail containing newlines cannot split one entry across
 * two lines — an irrecoverable corruption in an append-only file.
 */
export function formatAuditEntry(entry: FleetAuditEntry): string {
  const taskIds = entry.taskIds
    .slice(0, FLEET_AUDIT_TASK_IDS_MAX)
    .map((taskId) => boundText(taskId, FLEET_AUDIT_TASK_ID_MAX_LENGTH));
  return JSON.stringify({
    timestamp: entry.timestamp,
    fleetId: entry.fleetId,
    actor: boundText(entry.actor, FLEET_AUDIT_ACTOR_MAX_LENGTH),
    action: boundText(entry.action, FLEET_AUDIT_ACTION_MAX_LENGTH),
    taskIds,
    detail: boundText(entry.detail, FLEET_AUDIT_DETAIL_MAX_LENGTH),
  });
}

export interface AppendFleetAuditEntryOptions extends FleetIntentOptions {
  entry: FleetAuditEntry;
}

/**
 * Append one audit line.
 *
 * Append-only means append: this opens with "a", and this module deliberately
 * exposes no truncate, rewrite, or rotate operation — history is the point of
 * an audit log, so there is nothing that could erase it.
 */
export function appendFleetAuditEntry(
  options: AppendFleetAuditEntryOptions,
): FleetStateWriteResult {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = fleetAuditLogPath(options.gitCommonDir, options.fleetId);
  const line = formatAuditEntry({
    ...options.entry,
    fleetId: sanitizeFleetId(options.fleetId),
  });
  try {
    fs.mkdirSync(dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// ── Mailbox (inbox/ and events/) ──────────────────────────────────────

export const FLEET_NOTE_KINDS = [
  "note",
  "rebase-hint",
  "base-moved",
  "sibling-landed",
  "pause",
  "resume",
] as const;

export type FleetNoteKind = (typeof FLEET_NOTE_KINDS)[number];

/**
 * Real type guard for a note kind, so callers never narrow with a cast.
 *
 * The project bans `as` narrowing; a tool parameter arrives as `string`, so the
 * only honest way to reach {@link FleetNoteKind} is to check membership.
 */
export function isFleetNoteKind(value: unknown): value is FleetNoteKind {
  return typeof value === "string" && FLEET_NOTE_KINDS.some((kind) => kind === value);
}

/** Characters of note body kept on disk. */
export const FLEET_NOTE_BODY_MAX_LENGTH = 2000;

/**
 * Characters kept in a note's `to`/`from` address.
 *
 * The bound exists so a *schema-legal* note can never exceed
 * {@link FLEET_NOTE_FILE_MAX_BYTES}: an unbounded address would make the drain
 * quarantine a legal note as oversize, and a long `to` would push the filename
 * component toward `ENAMETOOLONG`. Arithmetic for the worst case — every
 * character JSON-escaped as `\uXXXX` (6 bytes):
 *
 *   body     2000 chars x 6 = 12000 bytes
 *   to/from   128 chars x 6 =   768 bytes each
 *   envelope                ~   100 bytes
 *   ------------------------------------
 *   worst case              ~13636 bytes (~13.3 KiB)
 *
 * which is under 1/4 of the 64 KiB cap. Real addresses are task ids (`bd-12`,
 * `supervisor`), so 128 characters is ~10x any legitimate value.
 */
export const FLEET_NOTE_ADDRESS_MAX_LENGTH = 128;

/**
 * Note files version independently of `fleet.json`: bumping the intent schema
 * must not make every existing note unreadable (and therefore quarantined).
 */
export const FLEET_NOTE_SCHEMA_VERSION = 1;

const FleetNoteSchema = z.object({
  schemaVersion: z.literal(FLEET_NOTE_SCHEMA_VERSION),
  kind: z.enum(FLEET_NOTE_KINDS),
  /** Task id (or `supervisor`) the note is addressed to. */
  to: z.string().min(1).max(FLEET_NOTE_ADDRESS_MAX_LENGTH),
  /** Task id (or `supervisor`) that wrote the note. */
  from: z.string().min(1).max(FLEET_NOTE_ADDRESS_MAX_LENGTH),
  body: z.string().max(FLEET_NOTE_BODY_MAX_LENGTH),
  createdAt: z.number().finite(),
});

export type FleetNote = z.infer<typeof FleetNoteSchema>;

/** Parse a note file; anything not matching the contract yields undefined. */
export function parseFleetNote(raw: unknown): FleetNote | undefined {
  const result = FleetNoteSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** Content identity of a note, hashed into its filename. */
function noteFingerprint(note: FleetNote): string {
  const fields = [note.schemaVersion, note.kind, note.from, note.to, note.body, note.createdAt];
  return JSON.stringify(fields);
}

/**
 * Deterministic, collision-free note filename:
 * `<to>-<kind>-<createdAt>-<content hash>.json`.
 *
 * `to` and `kind` are sanitized by the fleet-id sanitizer (the single
 * sanitizer, never a second one), so a task id such as `../../etc` or one
 * containing NUL stays inside the mailbox directory. Sanitizing can make two
 * raw ids equal, so the content hash carries the raw components: distinct
 * notes never share a name, while re-enqueueing identical content is a no-op
 * instead of a duplicate.
 */
export function fleetNoteFileName(note: FleetNote): string {
  const digest = createHash("sha256").update(noteFingerprint(note)).digest("hex").slice(0, 12);
  const to = sanitizeFleetId(note.to);
  const kind = sanitizeFleetId(note.kind);
  return `${to}-${kind}-${createdAtSegment(note.createdAt)}-${digest}.json`;
}

/**
 * Filename segment for `createdAt`.
 *
 * Self-defending on purpose: `fleetNoteFileName` is exported, so a future
 * caller that skips {@link enqueueNote} would otherwise interpolate an
 * unvalidated value (`"../.."`, `NaN`, a non-number via a cast) straight into a
 * path component and escape the mailbox. Anything that is not a finite number
 * becomes an inert literal instead — such a note cannot round-trip through the
 * schema anyway, so the drain quarantines it, but it must stay *inside* the
 * mailbox directory while it does.
 */
function createdAtSegment(createdAt: number): string {
  return typeof createdAt === "number" && Number.isFinite(createdAt)
    ? String(createdAt)
    : "invalid";
}

export interface EnqueueNoteOptions {
  /** Mailbox directory: `inbox/` (member → supervisor) or `events/` (supervisor → member). */
  dir: string;
  note: FleetNote;
  fs?: FleetStateFs;
}

export type EnqueueNoteResult = { ok: true; path: string } | { ok: false; error: string };

/** First few schema issues, for an error a caller can actually act on. */
function summarizeIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
  return issues.join("; ");
}

/**
 * Materialize the note that will be written.
 *
 * `createdAt` is validated, never coerced or trusted: it is interpolated into
 * the filename, so a runtime non-number (`"../.."` from a cast, a P1 writer
 * building a note from external JSON) would inject `/` and `..` into the name
 * and `join(dir, ...)` would escape the mailbox. The body is the only field the
 * writer repairs (truncation is the documented contract); everything else is
 * refused rather than silently rewritten into something the caller did not ask
 * for, and a note that fails this check would otherwise be quarantined by every
 * later drain.
 */
function normalizeNoteForWrite(
  note: FleetNote,
): { ok: true; note: FleetNote } | { ok: false; error: string } {
  const candidate = { ...note, schemaVersion: FLEET_NOTE_SCHEMA_VERSION };
  const valid = FleetNoteSchema.safeParse(candidate);
  if (valid.success) return { ok: true, note: valid.data };

  if (typeof candidate.body !== "string") {
    return { ok: false, error: `invalid fleet note (${summarizeIssues(valid.error)})` };
  }

  const truncated = FleetNoteSchema.safeParse({
    ...candidate,
    body: boundText(candidate.body, FLEET_NOTE_BODY_MAX_LENGTH),
  });
  if (truncated.success) return { ok: true, note: truncated.data };
  return { ok: false, error: `invalid fleet note (${summarizeIssues(truncated.error)})` };
}

/**
 * Write one note atomically (temp + rename through `atomicWriteJson`). An
 * over-long body is truncated to {@link FLEET_NOTE_BODY_MAX_LENGTH} *before*
 * naming, so the stored note always satisfies its own schema.
 */
export function enqueueNote(options: EnqueueNoteOptions): EnqueueNoteResult {
  const fs = options.fs ?? nodeFsSeam;
  const normalized = normalizeNoteForWrite(options.note);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const note = normalized.note;
  const path = join(options.dir, fleetNoteFileName(note));
  const written = atomicWriteJson(path, note, fs);
  return written.ok ? { ok: true, path } : { ok: false, error: written.error };
}

export interface EnqueueNoteFanoutOptions {
  /** Mailbox directory: `inbox/` (member → supervisor) or `events/` (supervisor → member). */
  dir: string;
  /** Note template; `to` is replaced per recipient. */
  note: FleetNote;
  /** One note file per recipient, in the order given. */
  recipients: readonly string[];
  fs?: FleetStateFs;
}

export type EnqueueNoteFanoutResult =
  | { ok: true; paths: readonly string[]; recipients: readonly string[] }
  | {
      ok: false;
      error: string;
      /** Note files written before the failure. */
      written: readonly string[];
      /**
       * Recipients whose note file was actually written, in write order.
       *
       * This is what the audit records: a partial fan-out that logged the
       * request instead would claim mail landed with members it never reached.
       */
      writtenRecipients: readonly string[];
    };

/**
 * Write one note file **per recipient** (fan-out).
 *
 * A single `to: "all"` file cannot represent broadcast honestly: every member
 * matches it, the first drainer acks (deletes) it, and the siblings never see
 * it. Per-recipient files are what the drain/ack protocol can actually deliver —
 * each member selects and acks only its own copy. The filename already carries
 * `to` plus a content hash, so the copies are distinct files with identical
 * bodies.
 *
 * A partial fan-out is reported as a failure that names what was written, so the
 * caller can audit exactly which members were reached rather than claiming the
 * whole broadcast landed.
 */
export function enqueueNoteFanout(options: EnqueueNoteFanoutOptions): EnqueueNoteFanoutResult {
  const written: string[] = [];
  const writtenRecipients: string[] = [];
  for (const recipient of options.recipients) {
    const enqueued = enqueueNote({
      dir: options.dir,
      note: { ...options.note, to: recipient },
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
    if (!enqueued.ok) {
      return {
        ok: false,
        error: `${enqueued.error} (fan-out stopped at ${recipient})`,
        written,
        writtenRecipients,
      };
    }
    written.push(enqueued.path);
    writtenRecipients.push(recipient);
  }
  return { ok: true, paths: written, recipients: writtenRecipients };
}

/** A drained note plus the file holding it; the path is the ack handle. */
export interface FleetNoteDelivery {
  note: FleetNote;
  path: string;
}

/**
 * Largest note file the drain will read.
 *
 * A legal note body is at most {@link FLEET_NOTE_BODY_MAX_LENGTH} characters and
 * a legal address at most {@link FLEET_NOTE_ADDRESS_MAX_LENGTH}. Even if every
 * character is JSON-escaped as `\uXXXX` (6 bytes), a legal note is ~13.3 KiB
 * (see the address constant for the arithmetic), so 64 KiB is ~4.7x the
 * worst-case legal note: comfortably above anything a writer produces, and a
 * hard bound on the per-turn read.
 */
export const FLEET_NOTE_FILE_MAX_BYTES = 64 * 1024;

export interface DrainNotesOptions {
  dir: string;
  fs?: FleetStateFs;
}

export type DrainNotesResult =
  | { ok: true; deliveries: readonly FleetNoteDelivery[]; warnings: readonly string[] }
  | { ok: false; reason: "unreadable-mailbox" | "quarantine-failed"; error: string };

/** Wrap the not-quite-a-record check without a bare cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a note-shaped record was written by a *different* note schema.
 *
 * Version drift is not corruption: when the schema bumps, an old reader that
 * renamed every newer note to `.corrupt` would destroy live mail. Such a note is
 * left in place and reported once per drain; only a record with no usable
 * version identity is garbage worth quarantining.
 */
function isForeignNoteVersion(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  const version = parsed.schemaVersion;
  return typeof version === "number" && version !== FLEET_NOTE_SCHEMA_VERSION;
}

/**
 * Preserve an unreadable note under a name the drain ignores, returning the
 * warning either way. Quarantine is a rename, never a delete: the content stays
 * inspectable, and it stops re-warning on every later drain (a warning storm).
 *
 * A failed rename is escalated, not downgraded to a warning: the offending note
 * stays in the mailbox, so every later drain re-inspects it and re-reports it —
 * exactly the storm quarantine exists to prevent. The drain therefore refuses
 * to claim success and names the file the operator has to move by hand.
 */
function quarantineNote(
  fs: FleetStateFs,
  path: string,
  label: string,
): { ok: true; warning: string } | { ok: false; error: string } {
  const quarantinePath = `${path}.corrupt`;
  try {
    fs.renameSync(path, quarantinePath);
    return { ok: true, warning: `${label} ${path} moved to ${quarantinePath}` };
  } catch (error) {
    return {
      ok: false,
      error:
        `${label} ${path} could not be quarantined (${errorMessage(error)}); ` +
        "it stays in the mailbox and would be reported on every drain — move or remove it by hand",
    };
  }
}

/** What inspecting one mailbox file produced. */
type MailboxFileOutcome =
  | { kind: "delivery"; delivery: FleetNoteDelivery }
  | { kind: "warning"; warning: string }
  | { kind: "quarantine-failed"; error: string }
  | { kind: "foreign-version" };

/** Quarantine a file and map the outcome onto the inspection result. */
function quarantineOutcome(fs: FleetStateFs, path: string, label: string): MailboxFileOutcome {
  const quarantined = quarantineNote(fs, path, label);
  if (!quarantined.ok) return { kind: "quarantine-failed", error: quarantined.error };
  return { kind: "warning", warning: quarantined.warning };
}

/**
 * Inspect one candidate note file and decide its fate.
 *
 * Kept out of the drain loop so each reason has one place: an oversize file is
 * quarantined from its size alone (never read), unreadable files are reported
 * and left alone (we cannot prove they are garbage), and a foreign schema
 * version is reported without being touched.
 */
function inspectNoteFile(fs: FleetStateFs, dir: string, name: string): MailboxFileOutcome {
  const path = join(dir, name);

  let size: number;
  try {
    size = fs.statSync(path).size;
  } catch (error) {
    return {
      kind: "warning",
      warning: `note ${path} could not be inspected: ${errorMessage(error)}`,
    };
  }
  if (size > FLEET_NOTE_FILE_MAX_BYTES) {
    return quarantineOutcome(fs, path, `oversize note (${size} bytes)`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path);
  } catch (error) {
    return { kind: "warning", warning: `note ${path} could not be read: ${errorMessage(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return quarantineOutcome(fs, path, "corrupt note");
  }

  const note = parseFleetNote(parsed);
  if (note !== undefined) return { kind: "delivery", delivery: { note, path } };
  if (isForeignNoteVersion(parsed)) return { kind: "foreign-version" };
  return quarantineOutcome(fs, path, "corrupt note");
}

/**
 * Read every pending note in one mailbox directory (code-unit sorted, so the
 * drain order is deterministic).
 *
 * **Bounded read.** The drain runs every turn, so it stats each file first and
 * quarantines anything above {@link FLEET_NOTE_FILE_MAX_BYTES} without reading
 * or parsing it: a member session dropping a multi-GB file into `inbox/` must
 * cost a `stat`, not the supervisor's memory.
 *
 * **Drain marks nothing and deletes nothing.** A delivery is removed only by
 * {@link ackNotes}, after the caller has consumed it. Deleting inside drain
 * would lose a note whose consumer died between the unlink and using it; the
 * price of never losing a note is at-least-once delivery, so a caller must
 * treat a repeated note as the same event, never as a new one.
 *
 * A corrupt (or oversize) note file is quarantined by renaming it to
 * `<name>.corrupt`; a file present under a different note schema version is
 * left in place and reported once per drain.
 *
 * **Quarantine failure fails the drain.** If a corrupt/oversize note cannot be
 * renamed away it stays in the mailbox and would be re-inspected on every later
 * drain, so the result is `reason: "quarantine-failed"` rather than a success
 * carrying a repeating warning. Nothing is lost: the file is still on disk and
 * the error names it.
 */
export function drainNotes(options: DrainNotesOptions): DrainNotesResult {
  const fs = options.fs ?? nodeFsSeam;

  let names: string[];
  try {
    if (!fs.existsSync(options.dir)) return { ok: true, deliveries: [], warnings: [] };
    names = fs.readdirSync(options.dir);
  } catch (error) {
    return { ok: false, reason: "unreadable-mailbox", error: errorMessage(error) };
  }

  const deliveries: FleetNoteDelivery[] = [];
  const warnings: string[] = [];
  const quarantineFailures: string[] = [];
  let foreignVersionCount = 0;

  for (const name of [...names].sort(compareCodeUnits)) {
    if (!name.endsWith(".json")) continue;

    const outcome = inspectNoteFile(fs, options.dir, name);
    switch (outcome.kind) {
      case "delivery":
        deliveries.push(outcome.delivery);
        break;
      case "warning":
        warnings.push(outcome.warning);
        break;
      case "quarantine-failed":
        quarantineFailures.push(outcome.error);
        break;
      case "foreign-version":
        foreignVersionCount += 1;
        break;
    }
  }

  if (quarantineFailures.length > 0) {
    return { ok: false, reason: "quarantine-failed", error: quarantineFailures.join("; ") };
  }

  if (foreignVersionCount > 0) {
    warnings.push(
      `${foreignVersionCount} note(s) in ${options.dir} use a different note schema version; left in place`,
    );
  }

  return { ok: true, deliveries, warnings };
}

export interface AckNotesOptions {
  /** Mailbox directory the deliveries came from; ack only touches its children. */
  dir: string;
  deliveries: readonly FleetNoteDelivery[];
  fs?: FleetStateFs;
}

export type AckNotesResult =
  | { ok: true; removed: readonly string[] }
  | {
      ok: false;
      error: string;
      /** Paths that were removed before/despite the failure. */
      removed: readonly string[];
      /** Deliveries still on disk: they will be delivered again. */
      remaining: readonly FleetNoteDelivery[];
    };

/**
 * Remove acknowledged notes after the caller consumed them.
 *
 * Idempotent: an already-removed path is success, so a crash between drain and
 * ack replays the note on the next turn instead of losing it. Paths outside
 * `dir` are refused — ack must never become a general-purpose unlink.
 *
 * **Partial failure is reported, never collapsed.** The loop keeps going after
 * an unlink failure and returns what it removed plus exactly which deliveries
 * remain, because the caller has already rendered those notes into its result:
 * returning a bare error would make consumed notes vanish from the record while
 * the caller cannot tell which ones are still queued.
 */
export function ackNotes(options: AckNotesOptions): AckNotesResult {
  const fs = options.fs ?? nodeFsSeam;
  const removed: string[] = [];
  const remaining: FleetNoteDelivery[] = [];
  const errors: string[] = [];

  for (const delivery of options.deliveries) {
    if (dirname(delivery.path) !== options.dir) {
      remaining.push(delivery);
      errors.push(`refusing to acknowledge ${delivery.path}: not in ${options.dir}`);
      continue;
    }
    if (!fs.existsSync(delivery.path)) continue;
    try {
      fs.unlinkSync(delivery.path);
      removed.push(delivery.path);
    } catch (error) {
      remaining.push(delivery);
      errors.push(`${delivery.path}: ${errorMessage(error)}`);
    }
  }

  if (errors.length > 0) return { ok: false, error: errors.join("; "), removed, remaining };
  return { ok: true, removed };
}

// ── merge-queue.json (schema only in this increment) ──────────────────

export const FLEET_MERGE_QUEUE_SCHEMA_VERSION = 1;

/** Lifecycle of one queued merge. P2 owns the transitions. */
export const FLEET_MERGE_ENTRY_STATES = [
  "queued",
  "rebasing",
  "gating",
  "merging",
  "merged",
  "failed",
  "parked",
] as const;

export type FleetMergeEntryState = (typeof FLEET_MERGE_ENTRY_STATES)[number];

const FleetMergeEntrySchema = z.object({
  taskId: z.string().min(1),
  branch: z.string().min(1),
  requestedAt: z.number().finite(),
  state: z.enum(FLEET_MERGE_ENTRY_STATES),
  /** Merge attempts so far; a retry is a new attempt, not a new entry. */
  attempts: z.number().int().nonnegative(),
  updatedAt: z.number().finite().optional(),
  lastError: z.string().optional(),
});

export type FleetMergeQueueEntry = z.infer<typeof FleetMergeEntrySchema>;

/**
 * Lease length for the single-flight merge lock.
 *
 * A live holder rebases, runs the full quality gates, and merges under one
 * lease, so the lease must outlast the slowest legitimate step; a crashed
 * holder must not block the fleet longer than needed. 30 minutes is above the
 * longest gate run we have measured and short enough that a dead supervisor is
 * recoverable within one operator attention span.
 */
export const FLEET_MERGE_LEASE_MS = 30 * 60 * 1000;

/**
 * Single-flight lock: `null` means no merge is in flight. Exactly one holder is
 * representable, which is what makes the queue single-flight by construction.
 *
 * **P2 handoff (W5):** a JSON record alone cannot deliver single-flight — two
 * supervisors can both read "lock free" and both acquire. Acquiring must be
 * gated by an out-of-band primitive only one writer can win: `mkdir
 * <fleetDir>/merge.lock.d` (atomic, fails with EEXIST) or an `O_EXCL` sidecar.
 * This record is what the winner writes *afterwards*, and it already carries
 * everything acquisition recovery needs: `pid` names the holder process and
 * `leaseExpiresAt` is the deadline after which a crashed holder's lock is stale
 * (see {@link isLockExpired} and {@link canAcquireFleetMerge}).
 */
const FleetMergeLockSchema = z.object({
  /** Session id of the acquiring supervisor. */
  holder: z.string().min(1),
  taskId: z.string().min(1),
  /** os pid of the holder, for dead-holder diagnostics and recovery. */
  pid: z.number().int().positive(),
  acquiredAt: z.number().finite(),
  /** Absolute epoch-ms deadline; a live holder extends it (heartbeat). */
  leaseExpiresAt: z.number().finite(),
});

export type FleetMergeLock = z.infer<typeof FleetMergeLockSchema>;

/**
 * Build the record a holder stores after winning the out-of-band acquire. The
 * lease is stamped here so a crash leaves a bounded wait instead of a permanent
 * lock; P2 renews by rewriting `leaseExpiresAt` while it holds.
 */
export function createFleetMergeLock(input: {
  holder: string;
  taskId: string;
  pid: number;
  /** Epoch-ms clock supplied by the caller (no ambient clock in this module). */
  now: number;
  leaseInMs?: number;
}): FleetMergeLock {
  const leaseInMs = input.leaseInMs ?? FLEET_MERGE_LEASE_MS;
  return {
    holder: input.holder,
    taskId: input.taskId,
    pid: input.pid,
    acquiredAt: input.now,
    leaseExpiresAt: input.now + leaseInMs,
  };
}

/**
 * Whether a held lock may be taken over. Total over `null`: no holder means
 * nothing to wait for.
 *
 * The deadline is inclusive — `leaseExpiresAt` is the first instant the lease
 * can no longer be relied on, so `now === leaseExpiresAt` counts as expired.
 */
export function isLockExpired(lock: FleetMergeLock | null, now: number): boolean {
  if (lock === null) return true;
  return now >= lock.leaseExpiresAt;
}

const FleetMergeQueueSchema = z.object({
  schemaVersion: z.literal(FLEET_MERGE_QUEUE_SCHEMA_VERSION),
  updatedAt: z.number().finite(),
  lock: FleetMergeLockSchema.nullable(),
  entries: z.array(FleetMergeEntrySchema),
});

export type FleetMergeQueue = z.infer<typeof FleetMergeQueueSchema>;

export function parseFleetMergeQueue(raw: unknown): FleetMergeQueue | undefined {
  const result = FleetMergeQueueSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** Empty queue: nothing queued, lock free. */
export function createFleetMergeQueue(now: number): FleetMergeQueue {
  return {
    schemaVersion: FLEET_MERGE_QUEUE_SCHEMA_VERSION,
    updatedAt: now,
    lock: null,
    entries: [],
  };
}

/** Why acquisition is or is not possible; the reason is what P2 logs. */
export type FleetMergeAcquireDecision =
  | { allowed: true; reason: "no-queue" | "lock-free" | "lease-expired" }
  | {
      allowed: false;
      reason: "lock-held";
      holder: string;
      taskId: string;
      leaseExpiresAt: number;
    };

/**
 * Pure decision half of single-flight: may a supervisor propose itself as the
 * next merge holder at `now`?
 *
 * This answers only "is anyone plausibly merging right now" — P2 still owes the
 * atomic acquire primitive (see the lock schema). The lease branch is what
 * makes a dead holder recoverable: an expired lease is acquirable, so a crashed
 * supervisor cannot wedge the queue forever.
 */
export function canAcquireFleetMerge(
  queue: FleetMergeQueue | undefined,
  now: number,
): FleetMergeAcquireDecision {
  if (queue === undefined) return { allowed: true, reason: "no-queue" };
  const lock = queue.lock;
  if (lock === null) return { allowed: true, reason: "lock-free" };
  if (isLockExpired(lock, now)) return { allowed: true, reason: "lease-expired" };
  return {
    allowed: false,
    reason: "lock-held",
    holder: lock.holder,
    taskId: lock.taskId,
    leaseExpiresAt: lock.leaseExpiresAt,
  };
}

export type FleetMergeQueueLoadResult =
  | { ok: true; queue: FleetMergeQueue | undefined }
  | { ok: false; reason: "corrupt-merge-queue" | "read-failed"; error: string };

export interface WriteFleetMergeQueueOptions extends FleetIntentOptions {
  queue: FleetMergeQueue;
}

/** Raw read of `merge-queue.json`: the parsed record plus the text it came from. */
type FleetMergeQueueRawLoad =
  | { ok: true; raw: string | undefined; queue: FleetMergeQueue | undefined }
  | { ok: false; reason: "corrupt-merge-queue" | "read-failed"; error: string };

function readFleetMergeQueueRaw(options: FleetIntentOptions): FleetMergeQueueRawLoad {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = fleetMergeQueueFilePath(options.gitCommonDir, options.fleetId);

  let raw: string;
  try {
    if (!fs.existsSync(filePath)) return { ok: true, raw: undefined, queue: undefined };
    raw = fs.readFileSync(filePath);
  } catch (error) {
    return { ok: false, reason: "read-failed", error: errorMessage(error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: "corrupt-merge-queue",
      error: `${filePath} is not valid JSON`,
    };
  }

  const queue = parseFleetMergeQueue(parsed);
  if (queue === undefined) {
    return { ok: false, reason: "corrupt-merge-queue", error: `${filePath} is not a merge queue` };
  }
  return { ok: true, raw, queue };
}

/** Read `merge-queue.json`; absent means "no queue yet". */
export function readFleetMergeQueue(options: FleetIntentOptions): FleetMergeQueueLoadResult {
  const loaded = readFleetMergeQueueRaw(options);
  return loaded.ok ? { ok: true, queue: loaded.queue } : loaded;
}

/**
 * Replace `merge-queue.json` atomically, refusing a record it cannot read.
 *
 * Absence is writable; a present but unparsable queue is refused for the same
 * reason `fleet.json` is: replacing it would erase a newer schema's record.
 * Mutations should go through {@link updateFleetMergeQueue}.
 */
export function writeFleetMergeQueue(options: WriteFleetMergeQueueOptions): FleetStateWriteResult {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = fleetMergeQueueFilePath(options.gitCommonDir, options.fleetId);
  const current = readFleetMergeQueueRaw({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!current.ok) {
    return {
      ok: false,
      error: `refusing to replace unreadable merge queue at ${filePath}: ${current.error}`,
    };
  }
  return writeFleetMergeQueueUnchecked({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    queue: options.queue,
    fs,
  });
}

/**
 * Module-private blind replace, for callers that already compared the on-disk
 * bytes ({@link updateFleetMergeQueue}). Never export this: it is the hole the
 * compare-and-replace path closes.
 */
function writeFleetMergeQueueUnchecked(
  options: WriteFleetMergeQueueOptions,
): FleetStateWriteResult {
  const fs = options.fs ?? nodeFsSeam;
  return atomicWriteJson(
    fleetMergeQueueFilePath(options.gitCommonDir, options.fleetId),
    options.queue,
    fs,
  );
}

export interface UpdateFleetMergeQueueOptions extends FleetIntentOptions {
  /** Pure updater: receives the current queue (undefined when absent). */
  update: (current: FleetMergeQueue | undefined) => FleetMergeQueue;
}

export type UpdateFleetMergeQueueResult =
  | { ok: true; queue: FleetMergeQueue }
  | {
      ok: false;
      reason: "corrupt-merge-queue" | "read-failed" | "write-failed" | "conflict";
      error: string;
    };

/**
 * Read-modify-write `merge-queue.json` with compare-and-replace.
 *
 * The queue has three independent writers (enqueue, lease renewal, entry state
 * transition), so a blind wholesale replace drops an update whenever two of
 * them interleave: the last rename wins and the loser never learns it lost. The
 * compare against the raw bytes the update was based on turns that silent loss
 * into `reason: "conflict"`, which the caller retries against the newer queue.
 *
 * **Residual race, documented not hidden:** this is check-then-write, not an
 * atomic CAS — two writers can both compare successfully and then both rename,
 * and the second wins. Closing that window needs the same `O_EXCL`/`mkdir`
 * primitive the merge lock itself requires (see the lock schema), which P2 must
 * supply before more than one process writes this file.
 */
export function updateFleetMergeQueue(
  options: UpdateFleetMergeQueueOptions,
): UpdateFleetMergeQueueResult {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = fleetMergeQueueFilePath(options.gitCommonDir, options.fleetId);
  const before = readFleetMergeQueueRaw({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!before.ok) return before;

  const next = options.update(before.queue);

  const current = readFleetMergeQueueRaw({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    fs,
  });
  if (!current.ok) return current;
  if (current.raw !== before.raw) {
    return {
      ok: false,
      reason: "conflict",
      error: `${filePath} changed while updating; re-read and retry`,
    };
  }

  const written = writeFleetMergeQueueUnchecked({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    queue: next,
    fs,
  });
  return written.ok
    ? { ok: true, queue: next }
    : { ok: false, reason: "write-failed", error: written.error };
}
