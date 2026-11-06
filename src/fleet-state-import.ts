/**
 * One-shot import of the retired *fleet* state files into the shared store
 * (bd-281).
 *
 * Fleet execution state used to live in `<git-common-dir>/belayd/fleet/<fleetId>/`:
 * the intent and its run record, the merge queue and its single-flight lock, the
 * audit log, the launch markers, the supervisor beat and the note mailboxes. Those
 * files were shared by every worktree, so a copy could not be told from the
 * original — the intent row is now keyed by fleet id in the repository store.
 *
 * The migration is:
 *
 * 1. **At most once per repository.** The marker row `bd-281-legacy-fleet-state:
 *    <git-common-dir>` is the durable one-shot; a second run reports
 *    `alreadyImported` and reads nothing. The per-process guard is the shared
 *    `claimMigrationTarget` slot in the worktree half's module.
 * 2. **Absent-first.** Every insert is a plan whose existence check and write share
 *    one `BEGIN IMMEDIATE` (the audit tail and the notes through
 *    `RepoStateStore.importAudit` / `importNote`, the intent and queue through
 *    their `mutate` plans), so two worktrees running this import before either
 *    records its marker still produce one row per fact — and a row a live fleet
 *    wrote after the legacy file was read is never overwritten by the copy.
 * 3. **A stale lock is not resurrected.** A lock row needs the directory, a
 *    parseable holder record and a lease that has not already expired.
 * 4. **Validation with the readers' schemas.** A file that does not parse is
 *    reported per file and skipped; a `*.json.corrupt` file is evidence, so it is
 *    reported and left in place.
 *
 * Deliberately split from `src/repo-state-import.ts` (the worktree half): that
 * module is loaded by every workflow caller, and importing the fleet modules there
 * would drag the fleet supervisor graph into every capability (and into the
 * `fleet-status`/`fleet-run` schema cycle).
 */

import { join } from "node:path";
import { parseSupervisorHeartbeat } from "./fleet-heartbeat.js";
import {
  type FleetMergeLock,
  fleetDir,
  fleetRoot,
  isLockExpired,
  parseFleetAuditEntry,
  parseFleetMergeQueue,
  parseFleetNote,
  splitFleetIntent,
} from "./fleet-state.js";
import { parseFleetIntent, parseFleetLaunchMarker, sanitizeFleetId } from "./fleet-status.js";
import {
  claimMigrationTarget,
  type LegacyStateFs,
  nodeFsSeam,
  parseJson,
  safeRead,
} from "./repo-state-import.js";
import {
  REPO_STATE_AUDIT_TAIL_ROWS,
  type RepoStateResult,
  type RepoStateStore,
} from "./repo-state-store.js";

// ── The fleet half: `<git-common-dir>/belayd/fleet/<fleetId>/` ──────────

/** Migration marker name for the fleet half; the row that makes it one-shot. */
export const REPO_STATE_LEGACY_FLEET_MIGRATION = "bd-281-legacy-fleet-state";

/** What a legacy fleet file turned out to be. */
export type LegacyFleetKind =
  | "fleet-intent"
  | "fleet-queue"
  | "fleet-lock"
  | "fleet-audit"
  | "fleet-launch-marker"
  | "fleet-supervisor"
  | "fleet-note";

/** One legacy fleet file's fate. */
export interface LegacyFleetImportEntry {
  path: string;
  fleetId: string;
  kind: LegacyFleetKind;
  /** Whether this file added at least one row. */
  imported: boolean;
  /** Rows the file became (0 when skipped). */
  rows: number;
  /** Why nothing was imported, when nothing was. */
  skipped?: string;
}

export interface LegacyFleetImportSummary {
  /** True when the marker was already set: nothing was read and nothing written. */
  alreadyImported: boolean;
  /** Fleet ids this run visited, in code-unit order. */
  fleets: readonly string[];
  entries: readonly LegacyFleetImportEntry[];
  /** Total rows written. */
  rows: number;
  /**
   * Quarantined `*.json.corrupt` files, left exactly where they were.
   *
   * A quarantined file is *evidence* of a record the old reader could not parse,
   * not state: importing it would guess at a damaged record and deleting it would
   * destroy the only trace that it existed. So it is reported and otherwise
   * untouched — no row, no rename, no unlink.
   */
  quarantined: readonly string[];
}

/**
 * Every legacy fleet file this migration is responsible for and that is present.
 *
 * The list is closed on purpose, and it is the *refusal* list: each name here is a
 * file the store replaced, so a present one is either pre-migration state to
 * import or a record to refuse. `*.json.corrupt` is deliberately absent — it is
 * evidence, never state.
 */
export const LEGACY_FLEET_FILE_NAMES = [
  "fleet.json",
  "merge-queue.json",
  "merge.lock.d",
  "audit.log",
  "launch",
  "supervisor.json",
  "inbox",
  "events",
] as const;

/** Fleet ids a legacy fleet root still names, in code-unit order. */
export function legacyFleetIds(
  gitCommonDir: string,
  fs: LegacyStateFs = nodeFsSeam,
): readonly string[] {
  const root = fleetRoot(gitCommonDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort();
}

/** The present legacy files of every fleet in one repository. */
export function legacyFleetStateFiles(
  gitCommonDir: string,
  fs: LegacyStateFs = nodeFsSeam,
): string[] {
  const present: string[] = [];
  for (const fleetId of legacyFleetIds(gitCommonDir, fs)) {
    const dir = fleetDir(gitCommonDir, fleetId);
    for (const name of LEGACY_FLEET_FILE_NAMES) {
      const path = join(dir, name);
      if (fs.existsSync(path)) present.push(path);
    }
  }
  return present;
}

/**
 * The refusal for a legacy fleet file that exists *after* the fleet migration.
 *
 * Same reasoning as {@link legacyStateRefusal}: reading it would import a copy of
 * state the shared store already owns, and ignoring it silently would leave a file
 * that looks authoritative to an operator and to every later session.
 */
export function legacyFleetStateRefusal(paths: readonly string[]): string {
  return (
    `belayd: refusing legacy fleet execution state at ${paths.join(", ")}. ` +
    `bd-281 moved fleet intent, the merge queue and its lock, the audit log, spawn markers, ` +
    `the supervisor beat and the note mailboxes into one shared SQLite store ` +
    `(<git-common-dir>/belayd/state.sqlite): fleet.json, merge-queue.json, merge.lock.d, ` +
    `audit.log, launch/, supervisor.json, inbox/ and events/ under ` +
    `<git-common-dir>/belayd/fleet/<fleetId>/ are retired. These were imported once by ` +
    `"${REPO_STATE_LEGACY_FLEET_MIGRATION}". Delete them: a copy of state is exactly what ` +
    `the migration removed, so it is not read and not re-imported.`
  );
}

/** Marker key: the fleet files were shared by every worktree, so the repository is the identity. */
function fleetMigrationKey(gitCommonDir: string): string {
  return `${REPO_STATE_LEGACY_FLEET_MIGRATION}:${gitCommonDir}`;
}

export interface ImportLegacyFleetStateOptions {
  gitCommonDir: string;
  store: RepoStateStore;
  nowMs?: number;
  fs?: LegacyStateFs;
  /** Fleet ids to visit; defaults to the directories present under the fleet root. */
  fleetIds?: readonly string[];
}

/** One fleet directory's outcomes. */
interface FleetDirImport {
  steps: FleetImportStep[];
  quarantined: string[];
}

/** One fleet file's outcome, or the store error that stops the migration. */
type FleetImportStep = LegacyFleetImportEntry | { kind: "failed"; path: string; error: string };

function fleetFailed(path: string, error: string): FleetImportStep {
  return { kind: "failed", path, error };
}

function fleetSkipped(
  path: string,
  fleetId: string,
  kind: LegacyFleetKind,
  reason: string,
): FleetImportStep {
  return { path, fleetId, kind, imported: false, rows: 0, skipped: reason };
}

function fleetImported(
  path: string,
  fleetId: string,
  kind: LegacyFleetKind,
  rows: number,
  skipped?: string,
): FleetImportStep {
  return {
    path,
    fleetId,
    kind,
    imported: rows > 0,
    rows,
    ...(skipped === undefined ? {} : { skipped }),
  };
}

function isFleetFailure(
  step: FleetImportStep,
): step is { kind: "failed"; path: string; error: string } {
  return step.kind === "failed";
}

function isFleetEntry(step: FleetImportStep): step is LegacyFleetImportEntry {
  return step.kind !== "failed";
}

/**
 * Import one repository's legacy fleet files, at most once per git common dir.
 *
 * One marker for the whole common dir, because the files were already shared by
 * every worktree: unlike `.belayd/`, there is no second copy to import, and a
 * per-worktree marker would let a second worktree import the same directory again.
 * Every insert is still absent-first (see each importer), so even a re-run that
 * ignored the marker could not overwrite what the first wrote.
 */
export function importLegacyFleetState(
  options: ImportLegacyFleetStateOptions,
): RepoStateResult<LegacyFleetImportSummary> {
  const fs = options.fs ?? nodeFsSeam;
  const atMs = options.nowMs ?? Date.now();
  const marker = fleetMigrationKey(options.gitCommonDir);

  const already = options.store.hasMigration(marker);
  if (!already.ok) return { ok: false, error: already.error };
  if (already.value) {
    return {
      ok: true,
      value: { alreadyImported: true, fleets: [], entries: [], rows: 0, quarantined: [] },
    };
  }

  const fleetIds = (options.fleetIds ?? legacyFleetIds(options.gitCommonDir, fs)).map(
    sanitizeFleetId,
  );
  const entries: LegacyFleetImportEntry[] = [];
  const quarantined: string[] = [];
  for (const fleetId of fleetIds) {
    const imported = importLegacyFleetDir({
      store: options.store,
      gitCommonDir: options.gitCommonDir,
      fleetId,
      atMs,
      fs,
    });
    const failure = imported.steps.find(isFleetFailure);
    if (failure !== undefined) return { ok: false, error: failure.error };
    entries.push(...imported.steps.filter(isFleetEntry));
    quarantined.push(...imported.quarantined);
  }
  const rows = entries.reduce((total, entry) => total + entry.rows, 0);

  const recorded = options.store.recordMigration({
    name: marker,
    summary: `${fleetIds.length} fleet(s), ${rows} row(s) imported, ${entries.length} file(s) visited`,
    nowMs: atMs,
  });
  if (!recorded.ok) return { ok: false, error: recorded.error };

  return {
    ok: true,
    value: { alreadyImported: false, fleets: fleetIds, entries, rows, quarantined },
  };
}

/** Import every legacy file of one fleet directory. */
function importLegacyFleetDir(input: {
  store: RepoStateStore;
  gitCommonDir: string;
  fleetId: string;
  atMs: number;
  fs: LegacyStateFs;
}): FleetDirImport {
  const dir = fleetDir(input.gitCommonDir, input.fleetId);
  const common = {
    store: input.store,
    fleetId: input.fleetId,
    dir,
    atMs: input.atMs,
    fs: input.fs,
  };
  return {
    steps: [
      ...importFleetIntentFile(common),
      ...importFleetQueueFile(common),
      ...importFleetAuditFile(common),
      ...importFleetSupervisorFile(common),
      ...importFleetLaunchMarkers(common),
      ...importFleetNotes({ ...common, channel: "inbox" }),
      ...importFleetNotes({ ...common, channel: "event" }),
    ],
    quarantined: [
      ...quarantinedNoteFiles(join(dir, "inbox"), input.fs),
      ...quarantinedNoteFiles(join(dir, "events"), input.fs),
    ],
  };
}

interface FleetFileImportInput {
  store: RepoStateStore;
  fleetId: string;
  dir: string;
  atMs: number;
  fs: LegacyStateFs;
}

/** `fleet.json` → the intent column plus the run column, in one mutation. */
function importFleetIntentFile(input: FleetFileImportInput): FleetImportStep[] {
  const path = join(input.dir, "fleet.json");
  if (!input.fs.existsSync(path)) return [];
  const text = safeRead(input.fs, path);
  const intent = text === undefined ? undefined : parseFleetIntent(parseJson(text));
  if (intent === undefined) {
    return [fleetSkipped(path, input.fleetId, "fleet-intent", "not a valid fleet intent")];
  }
  const { document, run } = splitFleetIntent(intent);
  const written = input.store.mutateFleet({
    fleetId: input.fleetId,
    // Absent-first inside the transaction: a row another session already owns is
    // never replaced by a legal record the migration happened to read.
    update: (current) =>
      current === null ? { kind: "write", intent: document, run } : { kind: "skip" },
    nowMs: intent.updatedAt,
  });
  if (!written.ok) return [fleetFailed(path, written.error)];
  return written.value.kind === "written"
    ? [fleetImported(path, input.fleetId, "fleet-intent", 1)]
    : [fleetSkipped(path, input.fleetId, "fleet-intent", "a fleet intent row already exists")];
}

/**
 * `merge-queue.json` → `fleet_queue`, and the holder record it carried → `fleet_lock`.
 *
 * **A stale directory must not resurrect a lock.** The old protocol's primitive was
 * `mkdir merge.lock.d`; the holder record lived in the queue file. So a lock row is
 * created only when the directory exists, a parseable record exists, its lease has
 * not already expired at import time, and the store has no lock row — otherwise the
 * answer is no row at all, never a lock a live fleet would respect.
 */
function importFleetQueueFile(input: FleetFileImportInput): FleetImportStep[] {
  const path = join(input.dir, "merge-queue.json");
  const lockDir = join(input.dir, "merge.lock.d");
  const lockDirPresent = input.fs.existsSync(lockDir);
  if (!input.fs.existsSync(path)) {
    return lockDirPresent
      ? [
          fleetSkipped(
            lockDir,
            input.fleetId,
            "fleet-lock",
            "the lock directory holds no holder record, so no lock row was created",
          ),
        ]
      : [];
  }
  const text = safeRead(input.fs, path);
  const queue = text === undefined ? undefined : parseFleetMergeQueue(parseJson(text));
  if (queue === undefined) {
    return [fleetSkipped(path, input.fleetId, "fleet-queue", "not a valid merge queue")];
  }
  const steps: FleetImportStep[] = [];
  const written = input.store.mutateFleetQueue({
    fleetId: input.fleetId,
    queue: { ...queue, lock: null },
    // The absence check runs inside the write's transaction: a drain's newer queue
    // that appeared after this file was read must not be replaced by the legacy
    // copy, which is the check-then-write window the file importer used to have.
    update: (current) => (current === null ? { kind: "write" } : { kind: "skip" }),
    nowMs: queue.updatedAt,
  });
  if (!written.ok) return [fleetFailed(path, written.error)];
  steps.push(
    written.value.kind === "written"
      ? fleetImported(path, input.fleetId, "fleet-queue", 1)
      : fleetSkipped(path, input.fleetId, "fleet-queue", "a merge queue row already exists"),
  );
  const lock = importFleetLock({ input, lockDir, lockDirPresent, lock: queue.lock });
  return lock === undefined ? steps : [...steps, lock];
}

/**
 * The holder record of a legacy lock directory, imported only while it is live.
 *
 * The directory alone is not evidence of a holder: the record lived in the queue
 * file, and a directory without one was the interrupted-acquire window the old
 * protocol documented. Neither is an expired record evidence of a live merge, so
 * both cases create no row.
 */
function importFleetLock(options: {
  input: FleetFileImportInput;
  lockDir: string;
  lockDirPresent: boolean;
  lock: FleetMergeLock | null;
}): FleetImportStep | undefined {
  const { input, lockDir, lock } = options;
  if (!options.lockDirPresent) return undefined;
  if (lock === null) {
    return fleetSkipped(
      lockDir,
      input.fleetId,
      "fleet-lock",
      "the lock directory holds no holder record, so no lock row was created",
    );
  }
  if (isLockExpired(lock, input.atMs)) {
    return fleetSkipped(
      lockDir,
      input.fleetId,
      "fleet-lock",
      "the recorded lock lease expired, so no lock row was created",
    );
  }
  const leaseMs = lock.leaseExpiresAt - lock.acquiredAt;
  if (leaseMs <= 0) {
    return fleetSkipped(
      lockDir,
      input.fleetId,
      "fleet-lock",
      "the recorded lock lease is not a positive window, so no lock row was created",
    );
  }
  const acquired = input.store.acquireFleetLock({
    fleetId: input.fleetId,
    holder: lock.holder,
    taskId: lock.taskId,
    pid: lock.pid,
    // The record's own instants, so the row keeps the expiry the file recorded.
    nowMs: lock.acquiredAt,
    leaseMs,
    takeOverExpired: true,
  });
  if (!acquired.ok) {
    return fleetSkipped(
      lockDir,
      input.fleetId,
      "fleet-lock",
      `a lock row already exists (held by ${acquired.holder})`,
    );
  }
  return fleetImported(lockDir, input.fleetId, "fleet-lock", 1);
}

/**
 * `audit.log` JSONL tail → `fleet_audit` rows.
 *
 * Only the trailing {@link REPO_STATE_AUDIT_TAIL_ROWS} lines: that is the window
 * every reader asks for, and importing an unbounded file into an append-only table
 * would grow it past what the store's own tail bound can render. A line that is not
 * an audit entry is left in the file and reported, not guessed at. Each insert goes
 * through {@link RepoStateStore.importAudit}, which checks and inserts inside one
 * transaction, so two worktrees racing this import before either records its marker
 * still produce exactly one row per legacy line.
 */
function importFleetAuditFile(input: FleetFileImportInput): FleetImportStep[] {
  const path = join(input.dir, "audit.log");
  if (!input.fs.existsSync(path)) return [];
  const text = safeRead(input.fs, path);
  if (text === undefined) {
    return [fleetSkipped(path, input.fleetId, "fleet-audit", "unreadable audit log")];
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-REPO_STATE_AUDIT_TAIL_ROWS);
  let rows = 0;
  let invalid = 0;
  for (const line of lines) {
    const entry = parseFleetAuditEntry(parseJson(line));
    if (entry === undefined) {
      invalid += 1;
      continue;
    }
    const written = input.store.importAudit({
      fleetId: input.fleetId,
      entry,
      nowMs: entry.timestamp,
    });
    if (!written.ok) return [fleetFailed(path, written.error)];
    if (written.value.imported) rows += 1;
  }
  const skipped =
    invalid === 0 ? undefined : `${invalid} line(s) are not audit entries and were left alone`;
  if (rows === 0) {
    return [
      fleetSkipped(
        path,
        input.fleetId,
        "fleet-audit",
        skipped ?? "every line is already an audit row",
      ),
    ];
  }
  return [fleetImported(path, input.fleetId, "fleet-audit", rows, skipped)];
}

/** `supervisor.json` → `fleet_supervisor`; an existing beat is never replaced. */
function importFleetSupervisorFile(input: FleetFileImportInput): FleetImportStep[] {
  const path = join(input.dir, "supervisor.json");
  if (!input.fs.existsSync(path)) return [];
  const text = safeRead(input.fs, path);
  const beat = text === undefined ? undefined : parseSupervisorHeartbeat(parseJson(text));
  if (beat === undefined) {
    return [fleetSkipped(path, input.fleetId, "fleet-supervisor", "not a valid supervisor beat")];
  }
  const written = input.store.mutateSupervisor({
    fleetId: input.fleetId,
    sessionId: beat.sessionId,
    pid: beat.pid,
    heartbeatAt: beat.heartbeatAt,
    // Absent-first inside the transaction: a beat a live supervisor wrote after this
    // file was read is the newer one and keeps the row.
    update: (current) => (current === null ? { kind: "write" } : { kind: "skip" }),
    nowMs: beat.heartbeatAt,
  });
  if (!written.ok) return [fleetFailed(path, written.error)];
  return written.value.kind === "written"
    ? [fleetImported(path, input.fleetId, "fleet-supervisor", 1)]
    : [fleetSkipped(path, input.fleetId, "fleet-supervisor", "a supervisor row already exists")];
}

/** `launch/<taskId>` → `fleet_launch_marker`, one row per task id. */
function importFleetLaunchMarkers(input: FleetFileImportInput): FleetImportStep[] {
  const launchDir = join(input.dir, "launch");
  if (!input.fs.existsSync(launchDir)) return [];
  const steps: FleetImportStep[] = [];
  for (const name of input.fs.readdirSync(launchDir)) {
    const path = join(launchDir, name);
    const text = safeRead(input.fs, path);
    const marker = text === undefined ? undefined : parseFleetLaunchMarker(parseJson(text));
    if (marker === undefined) {
      steps.push(
        fleetSkipped(path, input.fleetId, "fleet-launch-marker", "not a valid launch marker"),
      );
      continue;
    }
    // The body must name the id the filename named, or the row key would disagree
    // with its payload (the same rule the run-manifest import applies, bd-242).
    if (marker.taskId !== name) {
      steps.push(
        fleetSkipped(
          path,
          input.fleetId,
          "fleet-launch-marker",
          "the marker body names another task id",
        ),
      );
      continue;
    }
    const written = input.store.mutateLaunchMarker({
      taskId: marker.taskId,
      fleetId: input.fleetId,
      marker,
      // Absent-first inside the transaction: a marker the scheduler wrote after this
      // file was read owns the row.
      update: (current) => (current === null ? { kind: "write" } : { kind: "skip" }),
      nowMs: marker.startedAt,
    });
    if (!written.ok) {
      steps.push(fleetFailed(path, written.error));
      continue;
    }
    steps.push(
      written.value.kind === "written"
        ? fleetImported(path, input.fleetId, "fleet-launch-marker", 1)
        : fleetSkipped(path, input.fleetId, "fleet-launch-marker", "a marker row already exists"),
    );
  }
  return steps;
}

/** Quarantined mail files under one mailbox directory: reported, never imported or deleted. */
function quarantinedNoteFiles(dir: string, fs: LegacyStateFs): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".corrupt"))
    .map((name) => join(dir, name));
}

/** `inbox/*.json` / `events/*.json` → `fleet_note` rows, one per note. */
function importFleetNotes(
  input: FleetFileImportInput & { channel: "event" | "inbox" },
): FleetImportStep[] {
  const dir = join(input.dir, input.channel === "inbox" ? "inbox" : "events");
  if (!input.fs.existsSync(dir)) return [];
  const steps: FleetImportStep[] = [];
  for (const name of input.fs.readdirSync(dir)) {
    // A quarantined file is evidence, not mail: reported by `quarantinedNoteFiles`.
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const text = safeRead(input.fs, path);
    const note = text === undefined ? undefined : parseFleetNote(parseJson(text));
    if (note === undefined) {
      steps.push(fleetSkipped(path, input.fleetId, "fleet-note", "not a valid fleet note"));
      continue;
    }
    const written = input.store.importNote({
      fleetId: input.fleetId,
      channel: input.channel,
      target: note.to,
      from: note.from,
      kind: note.kind,
      body: note.body,
      createdAt: note.createdAt,
    });
    if (!written.ok) {
      steps.push(fleetFailed(path, written.error));
      continue;
    }
    steps.push(
      written.value.imported
        ? fleetImported(path, input.fleetId, "fleet-note", 1)
        : fleetSkipped(path, input.fleetId, "fleet-note", "an identical note row already exists"),
    );
  }
  return steps;
}

/**
 * Run the fleet migration once per repository and report anything refused.
 *
 * Wiring point for `extensions/capabilities/fleet.ts`: the fleet common dir is
 * resolved once per fleet operation there, so the first resolution imports a live
 * fleet's files without an operator step, and a file that appears afterwards is
 * refused loudly instead of being read. A repository with no fleet root costs one
 * `existsSync`. The once-per-target guard is the shared `migratedTargets` set, so
 * this half and the worktree half cannot disagree about what was prepared. It is
 * deliberately not wired in `src/fleet-state.ts`: the parsers this module must
 * reuse live in modules that module already imports.
 */
export function migrateAndGuardLegacyFleetState(deps: {
  gitCommonDir: string;
  store: RepoStateStore;
  onRefusal: (message: string) => void;
  onImported: (summary: LegacyFleetImportSummary) => void;
  fs?: LegacyStateFs;
}): void {
  if (claimMigrationTarget(deps.store, `fleet:${deps.gitCommonDir}`)) return;
  const fs = deps.fs ?? nodeFsSeam;
  if (!fs.existsSync(fleetRoot(deps.gitCommonDir))) return;
  const summary = importLegacyFleetState({
    gitCommonDir: deps.gitCommonDir,
    store: deps.store,
    fs,
  });
  if (!summary.ok) {
    deps.onRefusal(`belayd: bd-281 fleet state import failed: ${summary.error}`);
    return;
  }
  if (!summary.value.alreadyImported && summary.value.rows > 0) deps.onImported(summary.value);
  if (summary.value.quarantined.length > 0) {
    deps.onRefusal(
      `belayd: left ${summary.value.quarantined.length} quarantined fleet file(s) in place ` +
        `(${summary.value.quarantined.join(", ")}): a quarantined file is evidence of a record ` +
        "the old reader could not parse, not state, so it was neither imported nor deleted",
    );
  }
  const present = legacyFleetStateFiles(deps.gitCommonDir, fs);
  if (present.length > 0) deps.onRefusal(legacyFleetStateRefusal(present));
}
