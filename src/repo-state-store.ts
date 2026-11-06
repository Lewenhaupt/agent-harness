/**
 * Per-repository execution state store (bd-281).
 *
 * Workflow and fleet execution state used to live in JSON files: `.belayd/*.json`
 * inside a worktree and `<git-common-dir>/belayd/fleet/<id>/*` beside it. The
 * files, not their schema, were the problem:
 *
 * - **Copied state.** A handoff or a resumed session carries a copy, so the new
 *   session claims a lease it does not own (bd-165: a stale handed-off
 *   `workflow.json` made every new session in the worktree claim a dead lease).
 * - **Left stale.** A phase file is a copy that goes stale and can be inherited;
 *   liveness had to be re-derived from a *lease* file, a second source of truth
 *   existing only to compensate for the first.
 * - **In git in unwanted ways.** State under a worktree depends on ignore rules
 *   holding in every worktree, and a file written outside `.belayd/` is ordinary
 *   tracked content.
 *
 * This module is the one owner of that state. There is exactly one database per
 * repository, in the shared git common dir (`<git-common-dir>/belayd/state.sqlite`,
 * override `BELAYD_REPO_STATE_FILE`), so every worktree and every session of the
 * repository resolves the same row. **Identity is the task id, never the worktree
 * path**: a worktree path is recorded for diagnosis and to locate a workflow, but
 * two worktrees driving the same task resolve the same `workflow_state` row, and
 * a stale lease is observable from `expires_at`/`heartbeat_at` without consulting
 * any file.
 *
 * Storage is `node:sqlite` (`DatabaseSync`) in WAL mode. The open/pragma/mode
 * hardening and the failure classification are shared with the bd-187 model-state
 * store (`src/sqlite-store-open.ts`) rather than copy-pasted; `node:sqlite` ships
 * with the runtime, so this adds no dependency.
 *
 * Coordination that the file layout hand-rolled is now transactional:
 * lease acquisition is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, the merge
 * single-flight lock is a conditional `UPDATE` instead of `mkdir` EEXIST, fleet
 * intent/queue compare-and-replace is CAS by a `revision` integer instead of a
 * raw-text compare, note delivery is at-least-once with an idempotent ack, and
 * landing a member is one `BEGIN IMMEDIATE` (see {@link RepoStateStore.landFleetMember}).
 *
 * Deliberate non-features:
 *
 * - **No file fallback and no dual write.** A file fallback preserves exactly the
 *   bug being removed, so there is none. {@link importLegacyState} (see
 *   `src/repo-state-import.ts`) reads the legacy files once, records a migration
 *   marker, and from then on a legacy state file is *refused* with an error naming
 *   the migration.
 * - **No second authority next to bd.** bd keeps owning issues and gates; this
 *   owns workflow and fleet *execution* state only.
 * - **The proof receipt is a row too (v5).** `.belayd/proof-receipt.json` was a
 *   file because pi-web-plugins read it through the browser file API; bd-281 moved
 *   it here anyway and accepted that the out-of-repo reader breaks until
 *   `pi-web-plugins/proof-of-work/discovery.js` reads the `proof_receipt` row
 *   (follow-up bd-303). The SYNC WARNING in `src/proof-receipt.ts` records the
 *   break; there is no dual write, because a mirrored file is the copy this bead
 *   removes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GitCommonDirFailureReason } from "./git-common-dir.js";
import {
  addColumnIfMissing,
  asRow,
  classifyStoreFailure,
  errorMessage,
  inImmediateTransaction,
  openSqliteFile,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString,
  type SqliteDatabaseLike,
  type StoreFailureClass,
  sleepSync,
  tightenStoreFileModes,
} from "./sqlite-store-open.js";
import { resolveGitCommonDir } from "./worktree.js";

// Re-exported so callers that diagnose store health keep one classification
// implementation (the model store exposes the same pair from its own module).
export { classifyStoreFailure, type StoreFailureClass } from "./sqlite-store-open.js";

/** Override for the store path (tests, or an operator relocating state). */
export const REPO_STATE_FILE_ENV = "BELAYD_REPO_STATE_FILE";

/** Store file name inside `<git-common-dir>/belayd/`. */
export const REPO_STATE_FILE_NAME = "state.sqlite";

/**
 * Schema marker written to `PRAGMA user_version`.
 *
 * v1 is the initial bd-281 schema: workflow, lease, run, review, fleet intent/run/
 * queue/lock/notes/audit/launch and the migration marker, all created in one
 * `BEGIN IMMEDIATE` transaction.
 *
 * v2 re-keys the handoff marker and the review scope by **task id** instead of by
 * worktree path: path-keyed rows are what make a copied record possible (bd-165),
 * so the two tables that were still path-keyed are migrated in place.
 *
 * v3 adds the fleet supervisor heartbeat row and the lock's task/pid diagnostics.
 * It is the migration that replaces the per-fleet supervisor beat file and the
 * merge-lock directory record with rows.
 *
 * v4 re-keys the fleet notes: a row now carries both ends of its address
 * (`author` -> `target`), because the note file held `from` and the mailbox
 * renderer reads it, and it loses `delivered_at`, because a drain must not mark
 * anything (at-least-once means the pending set only changes on an ack). The same
 * version audits every note inside the insert's transaction, so a queued note is
 * never unwitnessed.
 *
 * v5 adds the proof receipt (`proof_receipt`, keyed by task id). It is purely
 * additive — a new table, no column rewrite — so `SCHEMA`'s `CREATE TABLE IF
 * NOT EXISTS` performs it inside the same `BEGIN IMMEDIATE` as the version bump.
 * The receipt was the last worktree state file pi-web read, and moving it is the
 * one knowingly outward-breaking step of this bead (bd-303).
 */
export const REPO_STATE_SCHEMA_VERSION = 5;

/** Bounded retries for the schema/migration step (a concurrent opener holds the lock). */
const SCHEMA_MIGRATION_ATTEMPTS = 3;

/**
 * Bounded retry for a transient failure on an already-open store.
 *
 * `busy_timeout` absorbs a lock held for a moment, but a WAL checkpoint, another
 * process's schema step, or a momentary IO error can still surface as
 * `SQLITE_BUSY`/`SQLITE_IOERR` on a live store, and one such failure used to fail a
 * whole drain or tick. Two retries with a short escalating sleep absorb exactly that
 * window, and the total wait stays far below any caller's tolerance, so a store
 * that is genuinely busy still reports a failure instead of stalling the tick.
 * Only the transient class is retried: a permanent failure (corruption,
 * permissions, a closed store) never fixes itself, so retrying it would turn a
 * diagnosis into a delay.
 */
const STORE_WRITE_ATTEMPTS = 3;
const STORE_WRITE_BACKOFF_MS = 40;

/**
 * Retry window after a transient shared open failure, mirroring
 * `SHARED_MODEL_STATE_RETRY_MS`: a transient failure (busy WAL writer, migration in
 * flight, momentary IO) is retried no more often than this; a permanent one stops
 * retrying entirely so a broken install cannot warn forever.
 */
export const SHARED_REPO_STATE_RETRY_MS = 30_000;

/**
 * Audit read bound, in rows.
 *
 * The file store bounded `audit.log` reads by bytes (64 KiB); a row store bounds
 * by rows instead, which is what the caller actually wants ("the last N entries")
 * and does not change with the length of a message.
 */
export const REPO_STATE_AUDIT_TAIL_ROWS = 200;

/** Note body cap, matching the file store's truncation repair. */
export const REPO_STATE_NOTE_BODY_MAX = 2_000;

/** Bound on cached worktree -> store-path resolutions (see {@link resolveRepoStatePath}). */
const MAX_CACHED_STATE_PATHS = 32;

/** Errors as values, per the repo convention. */
export type RepoStateResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type RepoStateOpen = { ok: true; store: RepoStateStore } | { ok: false; error: string };

/** The persisted workflow record, one row per task. */
export interface RepoWorkflowState {
  taskId: string;
  workflowType: string;
  resolutionSource?: "arg" | "label" | "default";
  matchedLabel?: string;
  branch: string;
  originalCwd: string;
  phaseOrder: string[];
  completedPhaseNames: string[];
  phaseSessions?: Record<string, { base: string; invocations: number }>;
  awaitingReviewResponse?: boolean;
  reviewedSha?: string;
  reviewedUntracked?: { path: string; blob: string }[];
  handedOffTo?: { taskId: string; branch: string; sessionId: string };
  /**
   * Awaiting-human / gate state. Stored as-is: bd owns the gates, so the harness
   * records which gate it opened, never the gate's authority.
   */
  awaitingHuman?: unknown;
  startedAt: number;
  updatedAt: number;
}

/** A workflow row as read back. */
export interface RepoWorkflowRow {
  taskId: string;
  /** Epoch ms of the last write. */
  updatedAt: number;
  /** Monotonic per-row generation, so a reader can spot a concurrent write. */
  generation: number;
  state: RepoWorkflowState;
}

/** What a workflow read-modify-write decided to do. */
export type RepoWorkflowPlan =
  | { kind: "write"; state: RepoWorkflowState }
  | { kind: "skip" }
  | { kind: "delete" }
  | { kind: "conflict"; error: string };

/** Outcome of one transactional workflow mutation. */
export type RepoWorkflowMutation =
  | { kind: "written"; taskId: string; generation: number; state: RepoWorkflowState }
  | { kind: "deleted"; taskId: string }
  | { kind: "unchanged"; taskId: string }
  | { kind: "missing" }
  | { kind: "conflict"; error: string }
  | { kind: "task-mismatch"; actualTaskId: string };

/** Locator for a workflow row: by identity, or by the worktree that drives it. */
export interface RepoWorkflowLocator {
  taskId?: string;
  worktreePath?: string;
}

/** A caller-scoped handoff marker row. Identity is (task, session key). */
export interface RepoHandoffRow {
  handoffKey: string;
  /** The worktree that last wrote it, for diagnosis only. */
  worktreePath: string;
  taskId: string;
  marker: unknown;
  updatedAt: number;
}

/** One orchestrator lease row. */
export interface RepoLeaseRow {
  taskId: string;
  sessionId: string;
  branch: string;
  worktreePath: string;
  pid: number;
  claimedAt: number;
  heartbeatAt: number;
  expiresAt: number;
  generation: number;
}

export type RepoLeaseAcquire =
  | { ok: true; lease: RepoLeaseRow; tookOverFrom?: { taskId: string; sessionId: string } }
  | { ok: false; reason: "held" | "write-failed"; holder: RepoLeaseRow | null; error: string };

export type RepoLeaseOutcome =
  | { ok: true; lease: RepoLeaseRow }
  | { ok: false; reason: "not-owner" | "expired" | "missing" | "write-failed"; error: string };

export interface RepoLeaseAcquireInput {
  taskId: string;
  sessionId: string;
  branch: string;
  worktreePath: string;
  pid: number;
  nowMs: number;
  /** Lease lifetime; defaults to the store's configured stale window. */
  ttlMs?: number;
  /** Take over a cold lease instead of refusing (a decision, never a default). */
  takeOverStale?: boolean;
}

/** A run manifest row. */
export interface RepoRunRow {
  runId: string;
  payload: unknown;
  updatedAt: number;
}

/** What a run-manifest read-modify-write decided to do. */
export type RepoRunPlan =
  | { kind: "write"; payload: unknown }
  | { kind: "skip" }
  | { kind: "conflict"; error: string };

/** Plan for one absent-first write; the store inserts only when the plan writes. */
export type RepoImportPlan = { kind: "write" } | { kind: "skip" };

/**
 * Outcome of an absent-first write (the bd-281 import).
 *
 * `skipped` means the row the transaction read made the plan a no-op, so an
 * importer can report what beat it without a second, racy read.
 */
export type RepoImportMutation = { kind: "written" } | { kind: "skipped" };

/** One fleet row (intent document + its run record). */
export interface RepoFleetRow {
  fleetId: string;
  revision: number;
  intent: unknown;
  run: unknown;
  updatedAt: number;
}

/**
 * Plan for one atomic fleet mutation.
 *
 * The revision is bumped by the store, and only when the plan changes the row: a
 * plan whose document the row already holds is a replay and writes nothing.
 */
export type RepoFleetPlan =
  | { kind: "write"; intent?: unknown; run?: unknown }
  | { kind: "skip" }
  | { kind: "conflict"; error: string };

export type RepoFleetMutation =
  | { kind: "written"; revision: number; intent: unknown; run: unknown }
  | { kind: "missing" }
  | { kind: "conflict"; error: string }
  | { kind: "unchanged" };

export interface RepoFleetLock {
  fleetId: string;
  holder: string;
  /** The queue entry the holder is merging (diagnostic, and the old record's shape). */
  taskId: string;
  /** Host pid of the holder (diagnostic only; a daemon pid in pi-web). */
  pid: number;
  acquiredAt: number;
  expiresAt: number;
}

/** One fleet supervisor heartbeat row. */
export interface RepoSupervisorRow {
  fleetId: string;
  sessionId: string;
  pid: number;
  heartbeatAt: number;
  updatedAt: number;
}

export type RepoFleetLockAcquire =
  | { ok: true; lock: RepoFleetLock }
  | { ok: false; reason: "held"; holder: string; expiresAt: number };

/** One fleet note. Delivery is at-least-once: drain never deletes, ack is idempotent. */
export interface RepoFleetNote {
  /** Row identity; the ack handle (a file path used to be). */
  seq: number;
  fleetId: string;
  channel: "event" | "inbox";
  /** Address the note was written to (`fleet_note.target`). */
  target: string;
  /** Who wrote it (`fleet_note.author`); the supervisor or a member task id. */
  from: string;
  kind: string;
  body: string;
  createdAt: number;
  ackedAt?: number;
}

/**
 * Why a note was not stored.
 *
 * Two reasons, because they are two different diagnoses: `invalid-note` is the
 * caller's input (a bad address, kind or body) and must not be retried, while
 * `write-failed` is the store (a busy or broken database) and must not be reported
 * as if the caller wrote a malformed note.
 */
export type RepoNoteWriteFailureReason = "invalid-note" | "write-failed";

export type RepoNoteWrite =
  | { ok: true; note: RepoFleetNote }
  | { ok: false; reason: RepoNoteWriteFailureReason; error: string };

/** One audit row. */
export interface RepoAuditRow {
  seq: number;
  fleetId: string;
  at: number;
  payload: unknown;
}

/**
 * Per-member landing request. The store owns the transaction; the caller owns the
 * merge and the bd gate calls, which cannot join a SQLite transaction.
 */
export interface LandFleetMemberInput {
  fleetId: string;
  /**
   * Pure fold from (intent, run) to the landed record; returns a plan.
   *
   * Pure in the strong sense: the fold is a function of the row it is given, at the
   * caller's fixed clock. A replay of a landing that already committed therefore
   * reproduces the stored document, which is how the store tells a replay (skip) from
   * a later landing of another member (bump and audit).
   */
  plan: (current: { intent: unknown; run: unknown; revision: number }) => RepoFleetPlan;
  /** Audit entry appended in the same transaction as the landing. */
  audit?: unknown;
  nowMs?: number;
}

export interface RepoStateStore {
  readonly path: string;
  readonly readOnly: boolean;

  // ---- workflow record (identity: task id) -------------------------------
  readWorkflow(locator: RepoWorkflowLocator): RepoStateResult<RepoWorkflowRow | null>;
  /**
   * Overwrite a workflow row (upsert by task id), binding the worktree to the task
   * so a cwd-only caller resolves the same row.
   */
  writeWorkflow(input: {
    state: RepoWorkflowState;
    worktreePath: string;
    nowMs?: number;
  }): RepoStateResult<RepoWorkflowRow>;
  /**
   * Read-modify-write in one `BEGIN IMMEDIATE`. The plan is computed from the row
   * read inside the same transaction, so two sessions can no longer interleave a
   * read and a write (the file store had no CAS at all).
   */
  mutateWorkflow(input: {
    locator: RepoWorkflowLocator;
    update: (current: RepoWorkflowRow | null) => RepoWorkflowPlan;
    /** Reject the write when the row belongs to another task (bd-228 guard). */
    expectedTaskId?: string;
    worktreePath?: string;
    nowMs?: number;
  }): RepoStateResult<RepoWorkflowMutation>;
  clearWorkflow(locator: RepoWorkflowLocator): RepoStateResult<{ cleared: boolean }>;

  // ---- caller handoff markers (identity: task + session) -----------------
  /**
   * Read one caller marker. `taskId` is the identity; omitting it looks the row up
   * by its session component alone, which a resuming session is the only one to
   * know. Neither form consults a worktree path.
   */
  readHandoff(input: { taskId?: string; handoffKey: string }): RepoStateResult<unknown>;
  writeHandoff(input: {
    taskId: string;
    handoffKey: string;
    /** Recorded for diagnosis (which worktree asked); never identity. */
    worktreePath?: string;
    marker: unknown;
    nowMs?: number;
  }): RepoStateResult<RepoHandoffRow>;
  /**
   * Insert a handoff marker absent-first (bd-281 import).
   *
   * Identity is the handoff key alone, and the absence check runs inside the write's
   * transaction: a marker a live session wrote between the legacy file read and this
   * call is never overwritten by the retired copy.
   */
  mutateHandoff(input: {
    taskId: string;
    handoffKey: string;
    worktreePath?: string;
    marker: unknown;
    update: (current: unknown | null) => RepoImportPlan;
    nowMs?: number;
  }): RepoStateResult<RepoImportMutation>;
  clearHandoff(input: {
    taskId?: string;
    handoffKey: string;
  }): RepoStateResult<{ cleared: boolean }>;
  /** How many marker rows exist for a key; the identity test asserts this is 1. */
  countHandoffs(input: { handoffKey: string }): RepoStateResult<number>;

  // ---- pending review scope (identity: task) ----------------------------
  readReviewScope(taskId: string): RepoStateResult<unknown>;
  writeReviewScope(input: {
    taskId: string;
    /** Recorded for diagnosis (which worktree captured it); never identity. */
    worktreePath?: string;
    scope: unknown;
    nowMs?: number;
  }): RepoStateResult<null>;
  /** Insert a pending review scope absent-first (bd-281 import); see {@link RepoImportPlan}. */
  mutateReviewScope(input: {
    taskId: string;
    worktreePath?: string;
    scope: unknown;
    update: (current: unknown | null) => RepoImportPlan;
    nowMs?: number;
  }): RepoStateResult<RepoImportMutation>;
  clearReviewScope(taskId: string): RepoStateResult<{ cleared: boolean }>;

  // ---- orchestrator lease (identity: task id) ---------------------------
  readLease(locator: {
    taskId?: string;
    worktreePath?: string;
  }): RepoStateResult<RepoLeaseRow | null>;
  acquireLease(input: RepoLeaseAcquireInput): RepoLeaseAcquire;
  heartbeatLease(input: {
    taskId: string;
    sessionId: string;
    nowMs: number;
    ttlMs?: number;
  }): RepoLeaseOutcome;
  /** Release by task id, or by the worktree whose lease a session knows it holds. */
  releaseLease(input: {
    taskId?: string;
    worktreePath?: string;
    sessionId: string;
    nowMs?: number;
  }): RepoStateResult<{ released: boolean; lease: RepoLeaseRow | null }>;
  /** Record the real session id on a `pending:` lease created by a spawner. */
  assignLeaseSession(input: {
    taskId?: string;
    worktreePath?: string;
    pendingSessionId: string;
    sessionId: string;
    branch?: string;
    worktreePathValue?: string;
    pid?: number;
    nowMs: number;
    ttlMs?: number;
  }): RepoLeaseOutcome;
  /**
   * Replace a lease this session already holds with another session's claim
   * (a same-directory handoff).
   *
   * Ownership is part of the write: the conditional `UPDATE ... WHERE session_id`
   * refuses a lease another session has taken over, so there is no
   * read-then-overwrite window.
   */
  replaceLease(input: {
    taskId: string;
    expectSessionId: string;
    sessionId: string;
    branch: string;
    worktreePath: string;
    pid: number;
    nowMs: number;
    ttlMs?: number;
  }): RepoLeaseOutcome;

  // ---- run manifests -----------------------------------------------------
  readRun(runId: string): RepoStateResult<RepoRunRow | null>;
  writeRun(input: { runId: string; payload: unknown; nowMs?: number }): RepoStateResult<RepoRunRow>;
  mutateRun(input: {
    runId: string;
    update: (current: RepoRunRow | null) => RepoRunPlan;
    nowMs?: number;
  }): RepoStateResult<RepoRunRow | null>;
  listRuns(): RepoStateResult<RepoRunRow[]>;

  // ---- review findings ---------------------------------------------------
  readReviewFindings(taskId: string): RepoStateResult<unknown>;
  writeReviewFindings(input: {
    taskId: string;
    record: unknown;
    nowMs?: number;
  }): RepoStateResult<null>;
  /** Insert a review record absent-first (bd-281 import); see {@link RepoImportPlan}. */
  mutateReviewFindings(input: {
    taskId: string;
    record: unknown;
    update: (current: unknown | null) => RepoImportPlan;
    nowMs?: number;
  }): RepoStateResult<RepoImportMutation>;

  // ---- proof receipt (identity: task id) -------------------------------
  /**
   * Read a task's proof receipt document, or `undefined` when it has none.
   *
   * A missing receipt is an absence, not an error (most beads have no upload
   * platform). Stored text that is not JSON is an error: a corrupt row must not
   * read as "no receipt" and then let an agent-authored reference decide the gate.
   * Contract validation stays in `src/proof-receipt.ts`, whose zod schema is the
   * boundary in both directions.
   */
  readProofReceipt(input: { taskId: string }): RepoStateResult<unknown>;
  writeProofReceipt(input: {
    taskId: string;
    receipt: unknown;
    nowMs?: number;
  }): RepoStateResult<null>;
  /** Insert a receipt absent-first (bd-281 import); see {@link RepoImportPlan}. */
  mutateProofReceipt(input: {
    taskId: string;
    receipt: unknown;
    update: (current: unknown | null) => RepoImportPlan;
    nowMs?: number;
  }): RepoStateResult<RepoImportMutation>;

  // ---- fleet intent + run record (revision CAS) -------------------------
  readFleet(fleetId: string): RepoStateResult<RepoFleetRow | null>;
  /**
   * Fleet ids that have an intent row, code-unit sorted.
   *
   * The status view and the launch-capacity scan used to enumerate
   * `<git-common-dir>/belayd/fleet/*` directories, which stopped being the fleet
   * set the moment the intent moved into this store: a fleet with no notes, audit
   * or launch marker has no directory at all.
   */
  listFleets(): RepoStateResult<string[]>;
  /** Replace the intent document; bumps the revision. */
  writeFleetIntent(input: {
    fleetId: string;
    intent: unknown;
    nowMs?: number;
  }): RepoStateResult<RepoFleetRow>;
  /** CAS by revision: a stale revision is a typed conflict, never a silent overwrite. */
  updateFleetIntent(input: {
    fleetId: string;
    expectedRevision: number;
    intent: unknown;
    nowMs?: number;
  }): RepoStateResult<RepoFleetRow>;
  /**
   * One read-modify-write of the intent and run columns.
   *
   * A plan that writes the document the row already holds reports `written` with the
   * unchanged revision instead of bumping: the revision is a change counter, and a
   * replay of an applied write changed nothing.
   */
  mutateFleet(input: {
    fleetId: string;
    update: (current: RepoFleetRow | null) => RepoFleetPlan;
    nowMs?: number;
  }): RepoStateResult<RepoFleetMutation>;
  /**
   * Landing a member: mark it landed, bump the intent revision, record the run and
   * append the audit row in ONE `BEGIN IMMEDIATE`.
   *
   * The git merge happens before this call and the bd gate calls after it; neither
   * can join a SQLite transaction (see the ordering note in
   * `extensions/capabilities/fleet.ts`).
   *
   * A landing is recorded once per member however many times the call is replayed:
   * the plan folds from the row this transaction read, so a replay of a committed
   * land writes the document the row already holds, and the store skips the bump and
   * the audit row while still reporting the landed record. A later landing of another
   * member changes the document and therefore bumps normally.
   */
  landFleetMember(input: LandFleetMemberInput): RepoStateResult<RepoFleetMutation>;

  // ---- fleet merge queue + single-flight lock ---------------------------
  readFleetQueue(fleetId: string): RepoStateResult<{ revision: number; queue: unknown } | null>;
  writeFleetQueue(input: {
    fleetId: string;
    queue: unknown;
    nowMs?: number;
  }): RepoStateResult<{ revision: number; queue: unknown }>;
  /** Insert a merge queue absent-first (bd-281 import); see {@link RepoImportPlan}. */
  mutateFleetQueue(input: {
    fleetId: string;
    queue: unknown;
    update: (current: { revision: number; queue: unknown } | null) => RepoImportPlan;
    nowMs?: number;
  }): RepoStateResult<RepoImportMutation>;
  updateFleetQueue(input: {
    fleetId: string;
    expectedRevision: number;
    queue: unknown;
    nowMs?: number;
  }): RepoStateResult<{ revision: number; queue: unknown }>;
  acquireFleetLock(input: {
    fleetId: string;
    holder: string;
    taskId: string;
    pid: number;
    nowMs: number;
    leaseMs: number;
    /** Take over an expired lock (the caller's orphan decision). */
    takeOverExpired?: boolean;
  }): RepoFleetLockAcquire;
  renewFleetLock(input: {
    fleetId: string;
    holder: string;
    nowMs: number;
    leaseMs: number;
  }): RepoFleetLockAcquire;
  releaseFleetLock(input: {
    fleetId: string;
    holder: string;
  }): RepoStateResult<{ released: boolean }>;
  readFleetLock(fleetId: string): RepoStateResult<RepoFleetLock | null>;

  // ---- fleet supervisor heartbeat (identity: fleet id) -------------------
  readSupervisor(fleetId: string): RepoStateResult<RepoSupervisorRow | null>;
  writeSupervisor(input: {
    fleetId: string;
    sessionId: string;
    pid: number;
    heartbeatAt: number;
    nowMs?: number;
  }): RepoStateResult<RepoSupervisorRow>;
  /** Insert a supervisor beat absent-first (bd-281 import); see {@link RepoImportPlan}. */
  mutateSupervisor(input: {
    fleetId: string;
    sessionId: string;
    pid: number;
    heartbeatAt: number;
    update: (current: RepoSupervisorRow | null) => RepoImportPlan;
    nowMs?: number;
  }): RepoStateResult<RepoImportMutation>;

  // ---- fleet notes (at-least-once) --------------------------------------
  enqueueNote(input: {
    fleetId: string;
    channel: "event" | "inbox";
    target: string;
    from: string;
    kind: string;
    body: string;
    /**
     * Audit payload stored in the same transaction as the row.
     *
     * Required, not optional: a note nobody can trace is what the old
     * enqueue-then-audit pair produced when the process died between them.
     */
    audit: unknown;
    nowMs?: number;
  }): RepoNoteWrite;
  /**
   * Insert a legacy note row only when an identical row is absent (bd-281 import).
   *
   * The file store identified a note by its content-addressed filename, so a
   * re-run could not duplicate one. A row has no filename, so identity is the
   * fields that filename encoded (channel, target, author, kind, created_at) and
   * the absence check and the insert share one transaction.
   */
  importNote(input: {
    fleetId: string;
    channel: "event" | "inbox";
    target: string;
    from: string;
    kind: string;
    body: string;
    createdAt: number;
  }): RepoStateResult<{ seq: number; imported: boolean }>;
  /** Read the pending notes. Deletes nothing and marks nothing. */
  drainNotes(input: {
    fleetId: string;
    channel: "event" | "inbox";
    target?: string;
  }): RepoStateResult<RepoFleetNote[]>;
  ackNotes(input: { fleetId: string; seqs: readonly number[]; nowMs?: number }): RepoStateResult<{
    acked: number;
    /** The seqs this call actually transitioned; an already-acked one is not here. */
    seqs: readonly number[];
  }>;

  // ---- fleet audit (append-only, bounded tail) --------------------------
  appendAudit(input: {
    fleetId: string;
    entry: unknown;
    nowMs?: number;
  }): RepoStateResult<RepoAuditRow>;
  /**
   * Insert a legacy audit entry only when an identical row is absent (bd-281 import).
   *
   * A per-call tail read is not enough on its own: two worktrees can run the
   * one-shot import before either records its marker, and both would read the same
   * tail. The absence check and the insert share one `BEGIN IMMEDIATE`, so the
   * second writer sees the first's row and inserts nothing. Identity is
   * `(fleet_id, at, payload)` — the whole entry — which is exactly what the JSONL
   * line encoded.
   */
  importAudit(input: {
    fleetId: string;
    entry: unknown;
    nowMs?: number;
  }): RepoStateResult<{ seq: number; imported: boolean }>;
  readAudit(input: { fleetId: string; limit?: number }): RepoStateResult<RepoAuditRow[]>;

  // ---- fleet launch markers ---------------------------------------------
  readLaunchMarker(taskId: string): RepoStateResult<unknown>;
  writeLaunchMarker(input: {
    taskId: string;
    fleetId: string;
    marker: unknown;
    nowMs?: number;
  }): RepoStateResult<null>;
  /** Insert a launch marker absent-first (bd-281 import); see {@link RepoImportPlan}. */
  mutateLaunchMarker(input: {
    taskId: string;
    fleetId: string;
    marker: unknown;
    update: (current: unknown | null) => RepoImportPlan;
    nowMs?: number;
  }): RepoStateResult<RepoImportMutation>;
  clearLaunchMarker(taskId: string): RepoStateResult<{ cleared: boolean }>;

  // ---- migration markers ------------------------------------------------
  hasMigration(name: string): RepoStateResult<boolean>;
  recordMigration(input: {
    name: string;
    summary: string;
    nowMs?: number;
  }): RepoStateResult<{ recorded: boolean }>;

  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS migration (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS workflow_state (
  task_id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL DEFAULT '',
  resolution_source TEXT,
  matched_label TEXT,
  branch TEXT NOT NULL DEFAULT '',
  original_cwd TEXT NOT NULL DEFAULT '',
  phase_order TEXT NOT NULL DEFAULT '[]',
  completed_phase_names TEXT NOT NULL DEFAULT '[]',
  phase_sessions TEXT,
  awaiting_review_response INTEGER,
  reviewed_sha TEXT,
  reviewed_untracked TEXT,
  handed_off_to TEXT,
  awaiting_human TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS workflow_state_updated ON workflow_state (updated_at);
CREATE TABLE IF NOT EXISTS workflow_binding (
  worktree_path TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_binding_task ON workflow_binding (task_id);
CREATE TABLE IF NOT EXISTS workflow_handoff (
  task_id TEXT NOT NULL DEFAULT '',
  handoff_key TEXT NOT NULL,
  worktree_path TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, handoff_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_handoff_key ON workflow_handoff (handoff_key);
CREATE TABLE IF NOT EXISTS review_scope (
  task_id TEXT PRIMARY KEY,
  worktree_path TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestrator_lease (
  task_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  worktree_path TEXT NOT NULL,
  pid INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS orchestrator_lease_worktree ON orchestrator_lease (worktree_path);
CREATE INDEX IF NOT EXISTS orchestrator_lease_expiry ON orchestrator_lease (expires_at);
CREATE TABLE IF NOT EXISTS run_manifest (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_manifest_task ON run_manifest (task_id);
CREATE TABLE IF NOT EXISTS review_findings (
  task_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proof_receipt (
  task_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_intent (
  fleet_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  intent TEXT NOT NULL,
  run TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_queue (
  fleet_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  queue TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_lock (
  fleet_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  pid INTEGER NOT NULL DEFAULT 0,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_supervisor (
  fleet_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  pid INTEGER NOT NULL DEFAULT 0,
  heartbeat_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_note (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  fleet_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS fleet_note_drain ON fleet_note (fleet_id, channel, seq);
CREATE TABLE IF NOT EXISTS fleet_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  fleet_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_audit_fleet_seq ON fleet_audit (fleet_id, seq);
CREATE TABLE IF NOT EXISTS fleet_launch_marker (
  task_id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Create the schema inside one `BEGIN IMMEDIATE`.
 *
 * Two sessions of one repository can open the store at the same time; bare
 * autocommit `CREATE TABLE` statements would race, and the loser's open would
 * fail. The write transaction serialises the whole migration, and every statement
 * is `IF NOT EXISTS` so a partially created schema is a success rather than a
 * failure.
 */
function applySchemaOnce(database: SqliteDatabaseLike): void {
  inImmediateTransaction(database, () => {
    // Migration runs before the schema statement: the v1 tables are still in
    // place, and the schema's `IF NOT EXISTS` forms then create only what the
    // migrated file still lacks.
    const version = schemaVersionOf(database);
    if (version === 1) migrateV1ToV2(database);
    // A fresh file (version 0) gets the current shape from SCHEMA below; only an
    // existing older file still has columns to add.
    if (version !== 0 && version <= 2) migrateV2ToV3(database);
    if (version !== 0 && version <= 3) migrateV3ToV4(database);
    // v4 -> v5 is the additive `proof_receipt` table; SCHEMA's `IF NOT EXISTS`
    // form creates it in this transaction, so there is no column to rewrite.
    database.exec(SCHEMA);
    database.exec(`PRAGMA user_version = ${REPO_STATE_SCHEMA_VERSION}`);
  });
}

/** Column names of one table's primary key, in key order. */
function primaryKeyColumns(database: SqliteDatabaseLike, table: string): string[] {
  const rows = database.prepare(`SELECT name, pk FROM pragma_table_info('${table}')`).all();
  return rows
    .map((raw) => asRow(raw) ?? {})
    .filter((row) => readNumber(row, "pk") > 0)
    .sort((left, right) => readNumber(left, "pk") - readNumber(right, "pk"))
    .map((row) => readString(row, "name"));
}

function schemaVersionOf(database: SqliteDatabaseLike): number {
  const row = asRow(database.prepare("PRAGMA user_version").get());
  return row === undefined ? 0 : readNumber(row, "user_version");
}

/**
 * Re-key the two path-keyed tables of v1 onto task id.
 *
 * v1 shipped only inside the bd-281 branch, so the rows to carry over are a
 * handoff marker and a transient review scope. They are copied before the old
 * tables are dropped, inside the same transaction as the rest of the schema, so a
 * crash leaves the file at v1 rather than half-migrated.
 */
function migrateV1ToV2(database: SqliteDatabaseLike): void {
  // Both versions carry a `worktree_path` column; the primary key is what moved, so
  // the source layout is read from pragma_table_info's `pk` ordinal instead of from
  // the column names.
  if (primaryKeyColumns(database, "workflow_handoff").join(",") !== "task_id,handoff_key") {
    database.exec(`CREATE TABLE workflow_handoff_v2 (
      task_id TEXT NOT NULL DEFAULT '',
      handoff_key TEXT NOT NULL,
      worktree_path TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, handoff_key)
    )`);
    database.exec(`INSERT OR REPLACE INTO workflow_handoff_v2
      (task_id, handoff_key, worktree_path, payload, updated_at)
      SELECT task_id, handoff_key, worktree_path, payload, updated_at FROM workflow_handoff`);
    database.exec("DROP TABLE workflow_handoff");
    database.exec("ALTER TABLE workflow_handoff_v2 RENAME TO workflow_handoff");
  }
  if (primaryKeyColumns(database, "review_scope").join(",") !== "task_id") {
    database.exec(`CREATE TABLE review_scope_v2 (
      task_id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      captured_at INTEGER NOT NULL
    )`);
    database.exec(`INSERT OR REPLACE INTO review_scope_v2
      (task_id, worktree_path, payload, captured_at)
      SELECT task_id, worktree_path, payload, captured_at FROM review_scope`);
    database.exec("DROP TABLE review_scope");
    database.exec("ALTER TABLE review_scope_v2 RENAME TO review_scope");
  }
}

/**
 * v2 -> v3: the merge lock gains the task/pid the retired directory record carried,
 * and the fleet supervisor heartbeat becomes a row.
 *
 * Both are additive, so an existing v2 file keeps every queue row and lock holder;
 * only the diagnostics the old record held are filled with their neutral values
 * until the next claim writes them.
 */
function migrateV2ToV3(database: SqliteDatabaseLike): void {
  // A hand-built/partial legacy file may not carry the fleet tables at all; SCHEMA
  // creates them (in the v3 shape) right after this migration, so adding a column to
  // a table that is not there would fail the whole open for no reason.
  const fleetLock = asRow(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fleet_lock'")
      .get(),
  );
  if (fleetLock === undefined) return;
  addColumnIfMissing(database, "fleet_lock", "task_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(database, "fleet_lock", "pid", "INTEGER NOT NULL DEFAULT 0");
}

/** Column names of one table, in declaration order; empty when it does not exist. */
function columnNames(database: SqliteDatabaseLike, table: string): string[] {
  return database
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((raw) => readString(asRow(raw) ?? {}, "name"));
}

/**
 * v3 -> v4: the note row gains its author and loses `delivered_at`.
 *
 * The table is rebuilt so a queued note keeps its `seq` (the ack handle). Notes
 * written before this version have no author to invent: they keep an empty one,
 * which the reader reports as an unaddressable note instead of pretending it knows
 * who wrote it.
 */
function migrateV3ToV4(database: SqliteDatabaseLike): void {
  // A hand-built/partial legacy file may not carry the fleet tables; SCHEMA
  // creates them (in the current shape) right after this migration.
  const columns = columnNames(database, "fleet_note");
  if (columns.length === 0) return;
  if (columns.includes("author") && !columns.includes("delivered_at")) return;
  const author = columns.includes("author") ? "author" : "''";
  const ackedAt = columns.includes("acked_at") ? "acked_at" : "NULL";
  database.exec(`CREATE TABLE fleet_note_v4 (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    fleet_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    acked_at INTEGER
  )`);
  // Explicit seq values keep the ack handles stable and set the new sequence.
  database.exec(`INSERT INTO fleet_note_v4
    (seq, fleet_id, channel, target, author, kind, body, created_at, acked_at)
    SELECT seq, fleet_id, channel, target, ${author}, kind, body, created_at, ${ackedAt}
      FROM fleet_note`);
  database.exec("DROP TABLE fleet_note");
  database.exec("ALTER TABLE fleet_note_v4 RENAME TO fleet_note");
}

/** Last good worktree -> store path resolutions, so repeated reads skip git. */
const resolvedStatePaths = new Map<string, string>();

/** Test seam for the git probe, so path resolution does not shell out in unit tests. */
export type RepoStatePathResolver = (
  cwd: string,
) =>
  | { ok: true; commonDir: string }
  | { ok: false; error: string; reason?: GitCommonDirFailureReason };

/**
 * Path resolution result. The failure keeps a classification so a caller that
 * distinguishes "not a repository" from "repository in a bad state" does not
 * have to re-read the error text.
 */
export type RepoStatePathResult =
  | { ok: true; value: string }
  | { ok: false; error: string; reason: GitCommonDirFailureReason };

/**
 * Resolve `<git-common-dir>/belayd/state.sqlite` for a worktree.
 *
 * `BELAYD_REPO_STATE_FILE` wins outright (tests and a relocated store). Otherwise
 * the shared git common dir decides, which is the *only* directory every linked
 * worktree of the repository agrees on — the database is therefore never inside a
 * worktree and never tracked by git.
 *
 * **An unresolvable common dir is an error, never a local fallback.** A
 * worktree-local store would put a SQLite file inside a worktree (forbidden) and
 * would re-create the copied-state bug this bead removes, so a directory that is
 * not a repository gets "no store" and the caller degrades to "no state". The
 * error carries a `reason` so a caller that distinguishes an observed absence
 * from an indeterminate probe does not re-read the message text. Tests and
 * relocations use the `BELAYD_REPO_STATE_FILE` seam instead.
 *
 * The successful resolution is cached per worktree so a hot path (one read per
 * phase transition) does not shell out to git every time; the cache is bounded and
 * cleared by {@link resetRepoStatePaths}.
 */
export function resolveRepoStatePath(options: {
  cwd: string;
  env?: Record<string, string | undefined>;
  resolveCommonDir?: RepoStatePathResolver;
}): RepoStatePathResult {
  const env = options.env ?? process.env;
  const override = env[REPO_STATE_FILE_ENV];
  if (override !== undefined && override !== "") return { ok: true, value: override };

  const cached = resolvedStatePaths.get(options.cwd);
  if (cached !== undefined) return { ok: true, value: cached };

  const resolve = options.resolveCommonDir ?? ((cwd: string) => resolveGitCommonDir(cwd));
  const commonDir = resolve(options.cwd);
  if (!commonDir.ok) {
    return {
      ok: false,
      reason: commonDir.reason ?? "indeterminate",
      error:
        `repo state store needs a git common dir for ${options.cwd}: ${commonDir.error}. ` +
        `Workflow and fleet state live in <git-common-dir>/belayd/state.sqlite, never ` +
        `inside a worktree; set ${REPO_STATE_FILE_ENV} to relocate it.`,
    };
  }
  const path = join(commonDir.commonDir, "belayd", REPO_STATE_FILE_NAME);
  resolvedStatePaths.set(options.cwd, path);
  if (resolvedStatePaths.size > MAX_CACHED_STATE_PATHS) {
    const oldest = resolvedStatePaths.keys().next();
    if (!oldest.done) resolvedStatePaths.delete(oldest.value);
  }
  return { ok: true, value: path };
}

/** Drop the cached resolutions. Tests and a repository relocation use this. */
export function resetRepoStatePaths(): void {
  resolvedStatePaths.clear();
}

/**
 * The store path for a git common dir that is already resolved.
 *
 * Fleet state always knows its `<git-common-dir>` (every fleet path is derived
 * from it), so it has no worktree to probe and must not shell out to git on every
 * intent read. {@link REPO_STATE_FILE_ENV} still wins, so a test or an operator
 * relocating the store keeps one override.
 */
export function repoStatePathForCommonDir(
  gitCommonDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[REPO_STATE_FILE_ENV];
  if (override !== undefined && override !== "") return override;
  return join(gitCommonDir, "belayd", REPO_STATE_FILE_NAME);
}

export interface RepoStateStoreOptions {
  /** Worktree whose git common dir locates the store. Ignored when `path` is set. */
  cwd?: string;
  /** Explicit store path (tests). */
  path?: string;
  env?: Record<string, string | undefined>;
  /** Open without write access: reads work, every write is `{ ok: false }`. */
  readOnly?: boolean;
  /** Epoch-ms clock seam. Defaults to `Date.now`. */
  now?: () => number;
  /** Default lease lifetime when a call does not pass one. */
  leaseTtlMs?: number;
  /** Inject a database (unit-test seam); when omitted the real file is opened. */
  database?: SqliteDatabaseLike;
  /** Called once per schema attempt (test seam for the retry policy). */
  onSchemaAttempt?: (attempt: number) => void;
  /** Git probe seam for path resolution. */
  resolveCommonDir?: RepoStatePathResolver;
}

/** The orchestrator lease window the harness has always used (20 s x 9). */
export const REPO_LEASE_STALE_MS = 180_000;

function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function readJson(row: Record<string, unknown>, key: string): unknown {
  const text = readOptionalString(row, key);
  return text === undefined ? undefined : jsonParse(text);
}

/**
 * A JSON array column, or null when the stored text is not a JSON array.
 *
 * Strict on purpose: a corrupt ledger must not silently read as an empty one, or
 * the next write would persist the loss (the row's identity would survive while
 * its completed phases vanished). Null makes the whole row unreadable instead.
 */
function readJsonArrayStrict(row: Record<string, unknown>, key: string): unknown[] | null {
  const text = readOptionalString(row, key);
  if (text === undefined) return [];
  const value = jsonParse(text);
  return Array.isArray(value) ? value : null;
}

function readOptionalBoolean(row: Record<string, unknown>, key: string): boolean | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return undefined;
}

function leaseFromRow(row: Record<string, unknown>): RepoLeaseRow {
  return {
    taskId: readString(row, "task_id"),
    sessionId: readString(row, "session_id"),
    branch: readString(row, "branch"),
    worktreePath: readString(row, "worktree_path"),
    pid: readNumber(row, "pid"),
    claimedAt: readNumber(row, "claimed_at"),
    heartbeatAt: readNumber(row, "heartbeat_at"),
    expiresAt: readNumber(row, "expires_at"),
    generation: readNumber(row, "generation"),
  };
}

function noteFromRow(row: Record<string, unknown>): RepoFleetNote {
  const ackedAt = readOptionalNumber(row, "acked_at");
  return {
    seq: readNumber(row, "seq"),
    fleetId: readString(row, "fleet_id"),
    channel: readString(row, "channel") === "inbox" ? "inbox" : "event",
    target: readString(row, "target"),
    from: readString(row, "author"),
    kind: readString(row, "kind"),
    body: readString(row, "body"),
    createdAt: readNumber(row, "created_at"),
    ...(ackedAt === undefined ? {} : { ackedAt }),
  };
}

function auditFromRow(row: Record<string, unknown>): RepoAuditRow {
  return {
    seq: readNumber(row, "seq"),
    fleetId: readString(row, "fleet_id"),
    at: readNumber(row, "at"),
    payload: readJson(row, "payload"),
  };
}

function lockFromRow(row: Record<string, unknown>): RepoFleetLock {
  return {
    fleetId: readString(row, "fleet_id"),
    holder: readString(row, "holder"),
    taskId: readString(row, "task_id"),
    pid: readNumber(row, "pid"),
    acquiredAt: readNumber(row, "acquired_at"),
    expiresAt: readNumber(row, "expires_at"),
  };
}

function supervisorFromRow(row: Record<string, unknown>): RepoSupervisorRow {
  return {
    fleetId: readString(row, "fleet_id"),
    sessionId: readString(row, "session_id"),
    pid: readNumber(row, "pid"),
    heartbeatAt: readNumber(row, "heartbeat_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

/** Build the stored workflow record from a row, or undefined when unreadable. */
function workflowFromRow(row: Record<string, unknown>): RepoWorkflowRow | undefined {
  const taskId = readString(row, "task_id");
  if (taskId === "") return undefined;
  const resolutionSource = readOptionalString(row, "resolution_source");
  const phaseSessions = readJson(row, "phase_sessions");
  const reviewedUntracked = readJson(row, "reviewed_untracked");
  const handedOffTo = readJson(row, "handed_off_to");
  const phaseOrder = readJsonArrayStrict(row, "phase_order");
  const completedPhaseNames = readJsonArrayStrict(row, "completed_phase_names");
  if (phaseOrder === null || completedPhaseNames === null) return undefined;
  const state: RepoWorkflowState = {
    taskId,
    workflowType: readString(row, "workflow_type"),
    branch: readString(row, "branch"),
    originalCwd: readString(row, "original_cwd"),
    phaseOrder: phaseOrder.filter((entry): entry is string => typeof entry === "string"),
    completedPhaseNames: completedPhaseNames.filter(
      (entry): entry is string => typeof entry === "string",
    ),
    startedAt: readNumber(row, "started_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
  if (
    resolutionSource === "arg" ||
    resolutionSource === "label" ||
    resolutionSource === "default"
  ) {
    state.resolutionSource = resolutionSource;
  }
  const matchedLabel = readOptionalString(row, "matched_label");
  if (matchedLabel !== undefined) state.matchedLabel = matchedLabel;
  if (phaseSessions !== undefined && typeof phaseSessions === "object" && phaseSessions !== null) {
    state.phaseSessions = phaseSessions as Record<string, { base: string; invocations: number }>;
  }
  const awaitingReviewResponse = readOptionalBoolean(row, "awaiting_review_response");
  if (awaitingReviewResponse !== undefined) state.awaitingReviewResponse = awaitingReviewResponse;
  const reviewedSha = readOptionalString(row, "reviewed_sha");
  if (reviewedSha !== undefined) state.reviewedSha = reviewedSha;
  if (Array.isArray(reviewedUntracked)) {
    state.reviewedUntracked = reviewedUntracked as { path: string; blob: string }[];
  }
  if (handedOffTo !== undefined && typeof handedOffTo === "object" && handedOffTo !== null) {
    state.handedOffTo = handedOffTo as { taskId: string; branch: string; sessionId: string };
  }
  const awaitingHuman = readJson(row, "awaiting_human");
  if (awaitingHuman !== undefined) state.awaitingHuman = awaitingHuman;
  return {
    taskId,
    updatedAt: readNumber(row, "updated_at"),
    generation: readNumber(row, "generation"),
    state,
  };
}

/**
 * SQLite returns a value that an explicit `undefined` binding cannot express;
 * a nullable column needs `null`.
 */
function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function optionalJson(value: unknown): string | null {
  return value === undefined ? null : jsonText(value);
}

/**
 * Open the per-repository execution state store.
 *
 * A write open creates `<git-common-dir>/belayd/` 0700, the file 0600, enables WAL
 * and creates the schema; a read-only open never migrates or writes.
 */
export function openRepoStateStore(options: RepoStateStoreOptions = {}): RepoStateOpen {
  let path = options.path;
  if (path === undefined) {
    if (options.cwd === undefined) {
      return {
        ok: false,
        error: `repo state store needs a cwd or an explicit path`,
      };
    }
    const resolved = resolveRepoStatePath({
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.resolveCommonDir === undefined
        ? {}
        : { resolveCommonDir: options.resolveCommonDir }),
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    path = resolved.value;
  }
  const storePath = path;
  const readOnly = options.readOnly === true;
  const opened = openSqliteFile({
    path: storePath,
    readOnly,
    label: "repo state store",
    schemaAttempts: SCHEMA_MIGRATION_ATTEMPTS,
    applySchema: applySchemaOnce,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.onSchemaAttempt === undefined ? {} : { onSchemaAttempt: options.onSchemaAttempt }),
  });
  if (!opened.ok) return { ok: false, error: opened.error };
  const database = opened.value;
  const now = options.now ?? Date.now;
  const defaultLeaseTtlMs = options.leaseTtlMs ?? REPO_LEASE_STALE_MS;
  const ownsFile = !readOnly && options.database === undefined;

  let closed = false;
  const failOnClosed = <T>(operation: string): RepoStateResult<T> | undefined =>
    closed ? { ok: false, error: `repo state store is closed (${operation})` } : undefined;
  const failReadOnly = <T>(operation: string): RepoStateResult<T> | undefined =>
    readOnly ? { ok: false, error: `repo state store is read-only (${operation})` } : undefined;

  const read = <T>(operation: string, body: () => T): RepoStateResult<T> => {
    const closedResult = failOnClosed<T>(operation);
    if (closedResult !== undefined) return closedResult;
    try {
      return { ok: true, value: body() };
    } catch (error) {
      return { ok: false, error: `${operation} failed: ${errorMessage(error)}` };
    }
  };

  /**
   * One `BEGIN IMMEDIATE` transaction, with a bounded transient retry.
   *
   * The body returns a decision; a `{ ok: false }` decision or a throw rolls back,
   * so a mutation can never half-commit. The retry policy is
   * {@link withTransientRetry}'s: only a thrown, transient store failure is
   * retried, never the caller's own `{ ok: false }` refusal.
   */
  const write = <T>(operation: string, body: () => RepoStateResult<T>): RepoStateResult<T> => {
    const closedResult = failOnClosed<T>(operation);
    if (closedResult !== undefined) return closedResult;
    const readOnlyResult = failReadOnly<T>(operation);
    if (readOnlyResult !== undefined) return readOnlyResult;
    try {
      return withTransientRetry(operation, () =>
        inImmediateTransaction(database, () => {
          const result = body();
          if (!result.ok) {
            // Force the rollback by throwing a marker the wrapper turns back into
            // the caller's own error value (errors as values at the seam).
            throw new RollbackSignal(result);
          }
          return result;
        }),
      );
    } finally {
      if (ownsFile) tightenStoreFileModes(storePath);
    }
  };

  /**
   * The import write's one decision point.
   *
   * The plan is called with the row the enclosing transaction read, so `skip` means
   * a live row was there when the insert would have run — never a stale answer from
   * a read that happened before the transaction.
   */
  const importSkip = (plan: RepoImportPlan): { ok: true; value: RepoImportMutation } | undefined =>
    plan.kind === "skip" ? { ok: true, value: { kind: "skipped" } } : undefined;

  const bindWorktree = (worktreePath: string, taskId: string, atMs: number): void => {
    if (worktreePath === "") return;
    database
      .prepare(
        `INSERT INTO workflow_binding (worktree_path, task_id, bound_at)
         VALUES (?, ?, ?)
         ON CONFLICT(worktree_path) DO UPDATE SET task_id = excluded.task_id,
                                                  bound_at = excluded.bound_at`,
      )
      .run(worktreePath, taskId, atMs);
  };

  const workflowRowByTask = (taskId: string): Record<string, unknown> | undefined => {
    const row = asRow(
      database.prepare("SELECT * FROM workflow_state WHERE task_id = ?").get(taskId),
    );
    return row;
  };

  const workflowRowByWorktree = (worktreePath: string): Record<string, unknown> | undefined => {
    // The binding is a locator, not identity: a resumed session in another
    // worktree writes its own binding to the same task row.
    const bound = asRow(
      database
        .prepare("SELECT task_id FROM workflow_binding WHERE worktree_path = ?")
        .get(worktreePath),
    );
    if (bound !== undefined) {
      const taskId = readString(bound, "task_id");
      const byBinding = workflowRowByTask(taskId);
      if (byBinding !== undefined) return byBinding;
    }
    // Fall back to the worktree the record itself was started in, so a fresh
    // session in the same directory still resolves its own workflow.
    return asRow(
      database
        .prepare(
          "SELECT * FROM workflow_state WHERE original_cwd = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(worktreePath),
    );
  };

  const locateWorkflow = (locator: RepoWorkflowLocator): Record<string, unknown> | undefined => {
    if (locator.taskId !== undefined) return workflowRowByTask(locator.taskId);
    if (locator.worktreePath !== undefined) return workflowRowByWorktree(locator.worktreePath);
    return undefined;
  };

  const writeWorkflowRow = (
    state: RepoWorkflowState,
    worktreePath: string,
    atMs: number,
  ): RepoWorkflowRow => {
    database
      .prepare(
        `INSERT INTO workflow_state (
           task_id, workflow_type, resolution_source, matched_label, branch, original_cwd,
           phase_order, completed_phase_names, phase_sessions, awaiting_review_response,
           reviewed_sha, reviewed_untracked, handed_off_to, awaiting_human, started_at,
           updated_at, generation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(task_id) DO UPDATE SET
           workflow_type = excluded.workflow_type,
           resolution_source = excluded.resolution_source,
           matched_label = excluded.matched_label,
           branch = excluded.branch,
           original_cwd = excluded.original_cwd,
           phase_order = excluded.phase_order,
           completed_phase_names = excluded.completed_phase_names,
           phase_sessions = excluded.phase_sessions,
           awaiting_review_response = excluded.awaiting_review_response,
           reviewed_sha = excluded.reviewed_sha,
           reviewed_untracked = excluded.reviewed_untracked,
           handed_off_to = excluded.handed_off_to,
           awaiting_human = excluded.awaiting_human,
           started_at = excluded.started_at,
           updated_at = excluded.updated_at,
           generation = workflow_state.generation + 1`,
      )
      .run(
        state.taskId,
        state.workflowType,
        nullable(state.resolutionSource),
        nullable(state.matchedLabel),
        state.branch,
        state.originalCwd,
        jsonText(state.phaseOrder),
        jsonText(state.completedPhaseNames),
        optionalJson(state.phaseSessions),
        state.awaitingReviewResponse === undefined ? null : state.awaitingReviewResponse ? 1 : 0,
        nullable(state.reviewedSha),
        optionalJson(state.reviewedUntracked),
        optionalJson(state.handedOffTo),
        optionalJson(state.awaitingHuman),
        Math.round(state.startedAt),
        Math.round(atMs),
      );
    bindWorktree(worktreePath === "" ? state.originalCwd : worktreePath, state.taskId, atMs);
    const written = workflowRowByTask(state.taskId);
    const parsed = written === undefined ? undefined : workflowFromRow(written);
    if (parsed === undefined)
      throw new Error(`workflow row for ${state.taskId} did not round-trip`);
    return parsed;
  };

  const requireRunId = (runId: string): void => {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(runId)) {
      throw new Error(`unsafe run id "${runId}"`);
    }
  };

  /** bd-242: the row key is the authority, so a payload naming another id is unusable. */
  const assertRunIdAgrees = (runId: string, payload: unknown): void => {
    if (typeof payload !== "object" || payload === null) {
      throw new Error(`run ${runId} payload is not an object`);
    }
    const bodyId = (payload as { runId?: unknown }).runId;
    if (typeof bodyId === "string" && bodyId !== runId) {
      throw new Error(`run ${runId} payload names ${bodyId}; the row key is the authority`);
    }
  };

  /** Upsert one manifest row; the row key is the authority (bd-242). */
  const writeRunRow = (runId: string, payload: unknown, atMs: number): RepoRunRow => {
    requireRunId(runId);
    assertRunIdAgrees(runId, payload);
    const taskId = (payload as { taskId?: unknown }).taskId;
    const status = (payload as { status?: unknown }).status;
    database
      .prepare(
        `INSERT INTO run_manifest (run_id, task_id, status, payload, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           task_id = excluded.task_id,
           status = excluded.status,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      )
      .run(
        runId,
        typeof taskId === "string" ? taskId : "",
        typeof status === "string" ? status : "",
        jsonText(payload),
        atMs,
      );
    const written = asRow(
      database.prepare("SELECT * FROM run_manifest WHERE run_id = ?").get(runId),
    );
    if (written === undefined) throw new Error(`run ${runId} did not round-trip`);
    return runFromRow(written);
  };

  const runFromRow = (row: Record<string, unknown>): RepoRunRow => ({
    runId: readString(row, "run_id"),
    payload: readJson(row, "payload"),
    updatedAt: readNumber(row, "updated_at"),
  });

  const fleetFromRow = (row: Record<string, unknown>): RepoFleetRow => ({
    fleetId: readString(row, "fleet_id"),
    revision: readNumber(row, "revision"),
    intent: readJson(row, "intent"),
    run: readJson(row, "run"),
    updatedAt: readNumber(row, "updated_at"),
  });

  const appendAuditRow = (fleetId: string, entry: unknown, atMs: number): RepoAuditRow => {
    const written = database
      .prepare("INSERT INTO fleet_audit (fleet_id, at, payload) VALUES (?, ?, ?)")
      .run(fleetId, Math.round(atMs), jsonText(entry));
    return {
      seq: Number(written.lastInsertRowid),
      fleetId,
      at: Math.round(atMs),
      payload: entry,
    };
  };

  /**
   * Append a plan's audit row unless an identical one is already there.
   *
   * Identity is the whole entry — `(fleet_id, at, payload)`, where the payload
   * carries the action and its timestamp — the same key
   * {@link RepoStateStore.importAudit} uses. So a replayed landing cannot double its
   * audit line even when the plan it replays still has something to change.
   * `appendAudit` stays append-only: two deliberate entries with the same text are
   * still two rows.
   */
  const appendAuditRowOnce = (fleetId: string, entry: unknown, atMs: number): void => {
    const at = Math.round(atMs);
    const payload = jsonText(entry);
    const existing = asRow(
      database
        .prepare(
          `SELECT seq FROM fleet_audit
            WHERE fleet_id = ? AND at = ? AND payload = ?
            LIMIT 1`,
        )
        .get(fleetId, at, payload),
    );
    if (existing !== undefined) return;
    database
      .prepare("INSERT INTO fleet_audit (fleet_id, at, payload) VALUES (?, ?, ?)")
      .run(fleetId, at, payload);
  };

  /** Delete a workflow row and its worktree binding. */
  const deleteWorkflowRow = (taskId: string): void => {
    database.prepare("DELETE FROM workflow_state WHERE task_id = ?").run(taskId);
    database.prepare("UPDATE workflow_binding SET task_id = '' WHERE task_id = ?").run(taskId);
  };

  /** Apply one workflow plan inside the caller's transaction. */
  const applyWorkflowPlan = (input: {
    locator: RepoWorkflowLocator;
    update: (current: RepoWorkflowRow | null) => RepoWorkflowPlan;
    expectedTaskId?: string;
    worktreePath?: string;
    atMs: number;
  }): RepoStateResult<RepoWorkflowMutation> => {
    const row = locateWorkflow(input.locator);
    const current = row === undefined ? null : (workflowFromRow(row) ?? null);
    if (
      input.expectedTaskId !== undefined &&
      current !== null &&
      current.taskId !== input.expectedTaskId
    ) {
      return { ok: true, value: { kind: "task-mismatch", actualTaskId: current.taskId } };
    }
    const plan = input.update(current);
    switch (plan.kind) {
      case "skip":
        return {
          ok: true,
          value:
            current === null ? { kind: "missing" } : { kind: "unchanged", taskId: current.taskId },
        };
      case "conflict":
        return { ok: true, value: { kind: "conflict", error: plan.error } };
      case "delete":
        if (current === null) return { ok: true, value: { kind: "missing" } };
        deleteWorkflowRow(current.taskId);
        return { ok: true, value: { kind: "deleted", taskId: current.taskId } };
      case "write": {
        const written = writeWorkflowRow(
          { ...plan.state, updatedAt: input.atMs },
          input.worktreePath ?? plan.state.originalCwd,
          input.atMs,
        );
        return {
          ok: true,
          value: {
            kind: "written",
            taskId: written.taskId,
            generation: written.generation,
            state: written.state,
          },
        };
      }
    }
  };

  /**
   * The one marker row for a locator.
   *
   * A task-qualified locator is the identity; a session-only locator (what a
   * resuming caller knows) resolves the single row for that session, because a
   * session hands a workflow off at most once.
   */
  const handoffRowFor = (
    db: SqliteDatabaseLike,
    input: { taskId?: string; handoffKey: string },
  ): unknown => {
    if (input.taskId !== undefined) {
      return db
        .prepare("SELECT * FROM workflow_handoff WHERE task_id = ? AND handoff_key = ?")
        .get(input.taskId, input.handoffKey);
    }
    return db.prepare("SELECT * FROM workflow_handoff WHERE handoff_key = ?").get(input.handoffKey);
  };

  /** The live-or-cold lease that would conflict with an acquisition. */
  const leaseConflict = (input: { taskId: string; worktreePath: string }): RepoLeaseRow | null => {
    // Both locators matter: the lease is one-per-worktree, but identity is the
    // task, so a resumed session in another worktree must find the same row.
    const row = asRow(
      database
        .prepare(
          `SELECT * FROM orchestrator_lease
            WHERE task_id = ? OR worktree_path = ?
            ORDER BY heartbeat_at DESC LIMIT 1`,
        )
        .get(input.taskId, input.worktreePath),
    );
    return row === undefined ? null : leaseFromRow(row);
  };

  /** One conditional upsert: two racing sessions cannot both win. */
  const writeLeaseRow = (input: RepoLeaseAcquireInput, ttlMs: number): void => {
    database
      .prepare(
        `INSERT INTO orchestrator_lease (
           task_id, session_id, branch, worktree_path, pid, claimed_at, heartbeat_at,
           expires_at, generation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(task_id) DO UPDATE SET
           session_id = excluded.session_id,
           branch = excluded.branch,
           worktree_path = excluded.worktree_path,
           pid = excluded.pid,
           claimed_at = excluded.claimed_at,
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at,
           generation = orchestrator_lease.generation + 1`,
      )
      .run(
        input.taskId,
        input.sessionId,
        input.branch,
        input.worktreePath,
        input.pid,
        Math.round(input.nowMs),
        Math.round(input.nowMs),
        Math.round(input.nowMs + ttlMs),
      );
    // A different task's dead lease on this worktree is displaced by the win.
    database
      .prepare("DELETE FROM orchestrator_lease WHERE worktree_path = ? AND task_id <> ?")
      .run(input.worktreePath, input.taskId);
  };

  const leaseById = (taskId: string): RepoLeaseRow | null => {
    const row = asRow(
      database.prepare("SELECT * FROM orchestrator_lease WHERE task_id = ?").get(taskId),
    );
    return row === undefined ? null : leaseFromRow(row);
  };

  /** The one lease a locator names: by task id, else by the worktree it holds. */
  const leaseRowFor = (locator: {
    taskId?: string;
    worktreePath?: string;
  }): Record<string, unknown> | undefined => {
    if (locator.taskId !== undefined) {
      return asRow(
        database.prepare("SELECT * FROM orchestrator_lease WHERE task_id = ?").get(locator.taskId),
      );
    }
    if (locator.worktreePath === undefined) return undefined;
    return asRow(
      database
        .prepare(
          `SELECT * FROM orchestrator_lease WHERE worktree_path = ?
            ORDER BY heartbeat_at DESC LIMIT 1`,
        )
        .get(locator.worktreePath),
    );
  };

  /** The refusal a caller gets when someone else holds a live (or cold) lease. */
  const heldLease = (holder: RepoLeaseRow, live: boolean) => ({
    ok: false as const,
    reason: "held" as const,
    holder,
    error: `${holder.taskId} holds a ${live ? "live" : "stale"} orchestrator lease in ${holder.worktreePath} (session ${holder.sessionId})`,
  });

  /**
   * A fleet plan that writes nothing, as the caller-visible outcome.
   *
   * `undefined` means "the plan writes", which is the only case that needs a row.
   */
  const fleetPlanTerminal = (
    plan: RepoFleetPlan,
    current: RepoFleetRow | null,
  ): RepoFleetMutation | undefined => {
    if (plan.kind === "conflict") return { kind: "conflict", error: plan.error };
    if (plan.kind === "skip") return current === null ? { kind: "missing" } : { kind: "unchanged" };
    // Without an intent document there is no row to attach a run record to.
    return current === null && plan.intent === undefined ? { kind: "missing" } : undefined;
  };

  /**
   * Apply one fleet plan inside the caller's transaction, optionally appending an
   * audit row in the same commit.
   *
   * Shared by `mutateFleet` and `landFleetMember`: landing is the same write with a
   * mandatory audit row, and a second implementation would be a way for the member
   * state and its audit trail to diverge.
   *
   * A plan that would write the row it read is a replay of a write that already
   * committed (the transient retry's ambiguous-commit case), so it bumps no revision
   * and appends no audit row; a genuine second landing folds at a later clock and
   * changes at least `updatedAt`, which is why the two are distinguishable by content
   * rather than by a separate generation counter.
   */
  const applyFleetPlan = (input: {
    fleetId: string;
    plan: RepoFleetPlan;
    current: RepoFleetRow | null;
    audit?: unknown;
    atMs: number;
  }): RepoStateResult<RepoFleetMutation> => {
    const terminal = fleetPlanTerminal(input.plan, input.current);
    if (terminal !== undefined || input.plan.kind !== "write") {
      return { ok: true, value: terminal ?? { kind: "missing" } };
    }
    // The columns this write would leave behind, computed the way the upsert below
    // binds them, so the replay test compares the row as it would be stored.
    const intentText = input.plan.intent === undefined ? "null" : jsonText(input.plan.intent);
    const runText = input.plan.run === undefined ? "{}" : jsonText(input.plan.run);
    // A replayed plan recomputes the identical document from the row the transaction
    // just read, so equality with that row is a replay and never a second landing: a
    // genuine later landing folds at a later clock and therefore changes at least
    // `updatedAt`/`landedAt`. The replay writes nothing, bumps nothing and audits
    // nothing, but still reports the landed row — the merge happened, and reporting
    // "unchanged" would make a caller treat a landed member as unlanded.
    //
    // This is a text comparison, and it depends on key insertion order: both sides
    // are `JSON.parse`d from the same stored text and re-serialised, and today's folds
    // only spread the parsed document and restamp fields in place, so the order is
    // stable. A future fold that builds a fresh object with a different key order would
    // compare as "different" and bump a second time; the ambiguous-commit replay test
    // ("replays an ambiguous commit as one revision bump and one landing audit row") is
    // what would fail.
    if (
      input.current !== null &&
      intentText === jsonText(input.current.intent) &&
      runText === jsonText(input.current.run)
    ) {
      const replay = input.current;
      return {
        ok: true,
        value: {
          kind: "written",
          revision: replay.revision,
          intent: replay.intent,
          run: replay.run,
        },
      };
    }
    database
      .prepare(
        `INSERT INTO fleet_intent (fleet_id, revision, intent, run, updated_at)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(fleet_id) DO UPDATE SET
           intent = COALESCE(excluded.intent, fleet_intent.intent),
           run = COALESCE(excluded.run, fleet_intent.run),
           revision = fleet_intent.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .run(input.fleetId, intentText, runText, input.atMs);
    if (input.audit !== undefined) appendAuditRowOnce(input.fleetId, input.audit, input.atMs);
    const written = asRow(
      database.prepare("SELECT * FROM fleet_intent WHERE fleet_id = ?").get(input.fleetId),
    );
    if (written === undefined) throw new Error(`fleet ${input.fleetId} did not round-trip`);
    const fleet = fleetFromRow(written);
    return {
      ok: true,
      value: { kind: "written", revision: fleet.revision, intent: fleet.intent, run: fleet.run },
    };
  };

  const fleetById = (fleetId: string): RepoFleetRow | null => {
    const row = asRow(
      database.prepare("SELECT * FROM fleet_intent WHERE fleet_id = ?").get(fleetId),
    );
    return row === undefined ? null : fleetFromRow(row);
  };

  const store: RepoStateStore = {
    path: storePath,
    readOnly,

    readWorkflow(locator) {
      const outcome = read("readWorkflow", () => {
        const row = locateWorkflow(locator);
        return row === undefined ? null : (workflowFromRow(row) ?? null);
      });
      return outcome;
    },

    writeWorkflow(input) {
      const atMs = input.nowMs ?? now();
      return write("writeWorkflow", () => {
        const written = writeWorkflowRow(input.state, input.worktreePath, atMs);
        return { ok: true, value: written };
      });
    },

    mutateWorkflow(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoWorkflowMutation>("mutateWorkflow", () =>
        applyWorkflowPlan({
          locator: input.locator,
          update: input.update,
          ...(input.expectedTaskId === undefined ? {} : { expectedTaskId: input.expectedTaskId }),
          ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
          atMs,
        }),
      );
    },

    clearWorkflow(locator) {
      return write<{ cleared: boolean }>("clearWorkflow", () => {
        const row = locateWorkflow(locator);
        if (row === undefined) return { ok: true, value: { cleared: false } };
        const taskId = readString(row, "task_id");
        database.prepare("DELETE FROM workflow_state WHERE task_id = ?").run(taskId);
        database.prepare("DELETE FROM workflow_binding WHERE task_id = ?").run(taskId);
        return { ok: true, value: { cleared: true } };
      });
    },

    readHandoff(input) {
      return read("readHandoff", () => {
        const row = asRow(handoffRowFor(database, input));
        return row === undefined ? null : readJson(row, "payload");
      });
    },

    writeHandoff(input) {
      const atMs = input.nowMs ?? now();
      return write("writeHandoff", () => {
        // Keyed by (task, session): two worktrees handing the same task off to the
        // same child session update ONE row, so no copy can inherit the marker.
        database
          .prepare(
            `INSERT INTO workflow_handoff (task_id, handoff_key, worktree_path, payload, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(task_id, handoff_key) DO UPDATE SET
               worktree_path = excluded.worktree_path,
               payload = excluded.payload,
               updated_at = excluded.updated_at`,
          )
          .run(
            input.taskId,
            input.handoffKey,
            input.worktreePath ?? "",
            jsonText(input.marker),
            atMs,
          );
        const row = asRow(
          database
            .prepare("SELECT * FROM workflow_handoff WHERE task_id = ? AND handoff_key = ?")
            .get(input.taskId, input.handoffKey),
        );
        if (row === undefined) throw new Error(`handoff ${input.handoffKey} did not round-trip`);
        return {
          ok: true,
          value: {
            handoffKey: readString(row, "handoff_key"),
            worktreePath: readString(row, "worktree_path"),
            taskId: readString(row, "task_id"),
            marker: readJson(row, "payload"),
            updatedAt: readNumber(row, "updated_at"),
          } satisfies RepoHandoffRow,
        };
      });
    },

    mutateHandoff(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoImportMutation>("mutateHandoff", () => {
        // The key alone: a resuming session knows it, and a key already held by
        // another task is taken, so writing it would violate the index instead of
        // reporting a skip.
        const row = asRow(
          database
            .prepare("SELECT * FROM workflow_handoff WHERE handoff_key = ? LIMIT 1")
            .get(input.handoffKey),
        );
        const current = row === undefined ? null : readJson(row, "payload");
        const skipped = importSkip(input.update(current));
        if (skipped !== undefined) return skipped;
        database
          .prepare(
            `INSERT INTO workflow_handoff (task_id, handoff_key, worktree_path, payload, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            input.taskId,
            input.handoffKey,
            input.worktreePath ?? "",
            jsonText(input.marker),
            atMs,
          );
        return { ok: true, value: { kind: "written" } };
      });
    },

    clearHandoff(input) {
      return write("clearHandoff", () => {
        const row = asRow(handoffRowFor(database, input));
        if (row === undefined) return { ok: true, value: { cleared: false } };
        const result = database
          .prepare("DELETE FROM workflow_handoff WHERE task_id = ? AND handoff_key = ?")
          .run(readString(row, "task_id"), readString(row, "handoff_key"));
        return { ok: true, value: { cleared: Number(result.changes) > 0 } };
      });
    },

    countHandoffs(input) {
      return read("countHandoffs", () => {
        const row = asRow(
          database
            .prepare("SELECT COUNT(*) AS count FROM workflow_handoff WHERE handoff_key = ?")
            .get(input.handoffKey),
        );
        return row === undefined ? 0 : readNumber(row, "count");
      });
    },

    readReviewScope(taskId) {
      return read("readReviewScope", () => {
        const row = asRow(
          database.prepare("SELECT payload FROM review_scope WHERE task_id = ?").get(taskId),
        );
        return row === undefined ? undefined : readJson(row, "payload");
      });
    },

    writeReviewScope(input) {
      const atMs = input.nowMs ?? now();
      return write("writeReviewScope", () => {
        database
          .prepare(
            `INSERT INTO review_scope (task_id, worktree_path, payload, captured_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET
               worktree_path = excluded.worktree_path,
               payload = excluded.payload,
               captured_at = excluded.captured_at`,
          )
          .run(input.taskId, input.worktreePath ?? "", jsonText(input.scope), atMs);
        return { ok: true, value: null };
      });
    },

    mutateReviewScope(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoImportMutation>("mutateReviewScope", () => {
        const row = asRow(
          database.prepare("SELECT payload FROM review_scope WHERE task_id = ?").get(input.taskId),
        );
        const current = row === undefined ? null : readJson(row, "payload");
        const skipped = importSkip(input.update(current));
        if (skipped !== undefined) return skipped;
        database
          .prepare(
            `INSERT INTO review_scope (task_id, worktree_path, payload, captured_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.taskId, input.worktreePath ?? "", jsonText(input.scope), atMs);
        return { ok: true, value: { kind: "written" } };
      });
    },

    clearReviewScope(taskId) {
      return write<{ cleared: boolean }>("clearReviewScope", () => {
        const result = database.prepare("DELETE FROM review_scope WHERE task_id = ?").run(taskId);
        return { ok: true, value: { cleared: Number(result.changes) > 0 } };
      });
    },

    readLease(locator) {
      return read("readLease", () => {
        const row =
          locator.taskId !== undefined
            ? asRow(
                database
                  .prepare("SELECT * FROM orchestrator_lease WHERE task_id = ?")
                  .get(locator.taskId),
              )
            : locator.worktreePath === undefined
              ? undefined
              : asRow(
                  database
                    .prepare(
                      `SELECT * FROM orchestrator_lease WHERE worktree_path = ?
                        ORDER BY heartbeat_at DESC LIMIT 1`,
                    )
                    .get(locator.worktreePath),
                );
        return row === undefined ? null : leaseFromRow(row);
      });
    },

    acquireLease(input) {
      const ttlMs = input.ttlMs ?? defaultLeaseTtlMs;
      const outcome = write<RepoLeaseAcquire>("acquireLease", () => {
        const holder = leaseConflict(input);
        const sameSession = holder !== null && holder.sessionId === input.sessionId;
        const live = holder !== null && holder.expiresAt > input.nowMs;
        // A live lease is never taken over implicitly, and a cold one only when the
        // caller says so: cold is evidence the owner stopped renewing, not proof
        // that it is gone, and taking over a live orchestrator is the exact chaos
        // this lease exists to prevent.
        if (holder !== null && !sameSession && (live || input.takeOverStale !== true)) {
          return { ok: true, value: heldLease(holder, live) };
        }
        writeLeaseRow(input, ttlMs);
        const written = leaseById(input.taskId);
        if (written === null) {
          return {
            ok: true,
            value: {
              ok: false,
              reason: "write-failed",
              holder,
              error: `could not read back the lease for ${input.taskId}`,
            },
          };
        }
        return {
          ok: true,
          value: {
            ok: true,
            lease: written,
            // Any displaced holder is reported, whether it was the same task's cold
            // lease or another task's dead one: the caller logs what it took over.
            ...(holder === null || holder.sessionId === input.sessionId
              ? {}
              : { tookOverFrom: { taskId: holder.taskId, sessionId: holder.sessionId } }),
          },
        };
      });
      if (!outcome.ok)
        return { ok: false, reason: "write-failed", holder: null, error: outcome.error };
      return outcome.value;
    },

    heartbeatLease(input) {
      const ttlMs = input.ttlMs ?? defaultLeaseTtlMs;
      const outcome = write<RepoLeaseOutcome>("heartbeatLease", () => {
        const row = asRow(
          database.prepare("SELECT * FROM orchestrator_lease WHERE task_id = ?").get(input.taskId),
        );
        if (row === undefined) {
          return { ok: true, value: { ok: false, reason: "missing", error: "no lease to renew" } };
        }
        const lease = leaseFromRow(row);
        if (lease.sessionId !== input.sessionId) {
          return {
            ok: true,
            value: {
              ok: false,
              reason: "not-owner",
              error: `lease for ${input.taskId} belongs to session ${lease.sessionId}`,
            },
          };
        }
        if (lease.expiresAt <= input.nowMs) {
          return {
            ok: true,
            value: {
              ok: false,
              reason: "expired",
              error: `lease for ${input.taskId} expired at ${lease.expiresAt}`,
            },
          };
        }
        database
          .prepare(
            `UPDATE orchestrator_lease
                SET heartbeat_at = ?, expires_at = ?, generation = generation + 1
              WHERE task_id = ?`,
          )
          .run(Math.round(input.nowMs), Math.round(input.nowMs + ttlMs), input.taskId);
        const renewed = asRow(
          database.prepare("SELECT * FROM orchestrator_lease WHERE task_id = ?").get(input.taskId),
        );
        if (renewed === undefined) {
          return {
            ok: true,
            value: { ok: false, reason: "missing", error: "lease vanished while renewing" },
          };
        }
        return { ok: true, value: { ok: true, lease: leaseFromRow(renewed) } };
      });
      if (!outcome.ok) {
        return { ok: false, reason: "write-failed", error: outcome.error };
      }
      return outcome.value;
    },

    releaseLease(input) {
      return write<{ released: boolean; lease: RepoLeaseRow | null }>("releaseLease", () => {
        const row = leaseRowFor(input);
        if (row === undefined) return { ok: true, value: { released: false, lease: null } };
        const lease = leaseFromRow(row);
        if (lease.sessionId !== input.sessionId)
          return { ok: true, value: { released: false, lease } };
        database.prepare("DELETE FROM orchestrator_lease WHERE task_id = ?").run(lease.taskId);
        return { ok: true, value: { released: true, lease } };
      });
    },

    assignLeaseSession(input) {
      const outcome = write<RepoLeaseOutcome>("assignLeaseSession", () => {
        const row = leaseRowFor(input);
        if (row === undefined) {
          return { ok: true, value: { ok: false, reason: "missing", error: "no pending lease" } };
        }
        const lease = leaseFromRow(row);
        if (lease.sessionId !== input.pendingSessionId) {
          return {
            ok: true,
            value: {
              ok: false,
              reason: "not-owner",
              error: `lease for ${lease.taskId} is ${lease.sessionId}, not ${input.pendingSessionId}`,
            },
          };
        }
        // Adopting a placeholder also re-targets it at this worktree and task: the
        // session that adopted it is the one that now drives there.
        database
          .prepare(
            `UPDATE orchestrator_lease
                SET session_id = ?, branch = COALESCE(?, branch), pid = COALESCE(?, pid),
                    worktree_path = COALESCE(?, worktree_path),
                    heartbeat_at = ?, expires_at = ?, generation = generation + 1
              WHERE task_id = ?`,
          )
          .run(
            input.sessionId,
            input.branch ?? null,
            input.pid ?? null,
            input.worktreePathValue ?? null,
            Math.round(input.nowMs),
            Math.round(input.nowMs + (input.ttlMs ?? defaultLeaseTtlMs)),
            lease.taskId,
          );
        const updated = leaseById(lease.taskId);
        if (updated === null) {
          return {
            ok: true,
            value: { ok: false, reason: "missing", error: "lease vanished while adopting" },
          };
        }
        return { ok: true, value: { ok: true, lease: updated } };
      });
      if (!outcome.ok) return { ok: false, reason: "write-failed", error: outcome.error };
      return outcome.value;
    },

    replaceLease(input) {
      const ttlMs = input.ttlMs ?? defaultLeaseTtlMs;
      const outcome = write<RepoLeaseOutcome>("replaceLease", () => {
        const changed = database
          .prepare(
            `UPDATE orchestrator_lease
                SET session_id = ?, branch = ?, worktree_path = ?, pid = ?,
                    claimed_at = ?, heartbeat_at = ?, expires_at = ?,
                    generation = generation + 1
              WHERE task_id = ? AND session_id = ?`,
          )
          .run(
            input.sessionId,
            input.branch,
            input.worktreePath,
            input.pid,
            Math.round(input.nowMs),
            Math.round(input.nowMs),
            Math.round(input.nowMs + ttlMs),
            input.taskId,
            input.expectSessionId,
          );
        if (Number(changed.changes) === 0) {
          const holder = leaseById(input.taskId);
          return {
            ok: true,
            value: {
              ok: false,
              reason: "not-owner",
              error:
                holder === null
                  ? `no lease for ${input.taskId} to replace`
                  : `the lease names session ${holder.sessionId}, not ${input.expectSessionId}`,
            },
          };
        }
        const lease = leaseById(input.taskId);
        if (lease === null) {
          return {
            ok: true,
            value: { ok: false, reason: "missing", error: "lease vanished while replacing" },
          };
        }
        return { ok: true, value: { ok: true, lease } };
      });
      if (!outcome.ok) return { ok: false, reason: "write-failed", error: outcome.error };
      return outcome.value;
    },

    readRun(runId) {
      return read("readRun", () => {
        const row = asRow(
          database.prepare("SELECT * FROM run_manifest WHERE run_id = ?").get(runId),
        );
        if (row === undefined) return null;
        const parsed = runFromRow(row);
        // Filename-is-authority (bd-242): the row key is the id, so a payload that
        // names another id is as unusable as a corrupt body.
        const bodyId = (parsed.payload as { runId?: unknown } | null)?.runId;
        if (typeof bodyId === "string" && bodyId !== runId) return null;
        return parsed;
      });
    },

    writeRun(input) {
      const atMs = input.nowMs ?? now();
      return write("writeRun", () => ({
        ok: true,
        value: writeRunRow(input.runId, input.payload, atMs),
      }));
    },

    mutateRun(input) {
      const atMs = input.nowMs ?? now();
      const outcome = write<RepoRunRow | null>("mutateRun", () => {
        const row = asRow(
          database.prepare("SELECT * FROM run_manifest WHERE run_id = ?").get(input.runId),
        );
        const current = row === undefined ? null : runFromRow(row);
        const plan = input.update(current);
        if (plan.kind === "conflict") {
          return { ok: false, error: plan.error };
        }
        if (plan.kind === "skip") return { ok: true, value: current };
        return { ok: true, value: writeRunRow(input.runId, plan.payload, atMs) };
      });
      return outcome;
    },

    listRuns() {
      return read("listRuns", () =>
        database
          .prepare("SELECT * FROM run_manifest ORDER BY updated_at ASC")
          .all()
          .map((raw) => runFromRow(asRow(raw) ?? {})),
      );
    },

    readReviewFindings(taskId) {
      return read("readReviewFindings", () => {
        const row = asRow(
          database.prepare("SELECT payload FROM review_findings WHERE task_id = ?").get(taskId),
        );
        return row === undefined ? undefined : readJson(row, "payload");
      });
    },

    writeReviewFindings(input) {
      const atMs = input.nowMs ?? now();
      return write("writeReviewFindings", () => {
        database
          .prepare(
            `INSERT INTO review_findings (task_id, payload, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET
               payload = excluded.payload,
               updated_at = excluded.updated_at`,
          )
          .run(input.taskId, jsonText(input.record), atMs);
        return { ok: true, value: null };
      });
    },

    mutateReviewFindings(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoImportMutation>("mutateReviewFindings", () => {
        const row = asRow(
          database
            .prepare("SELECT payload FROM review_findings WHERE task_id = ?")
            .get(input.taskId),
        );
        const current = row === undefined ? null : readJson(row, "payload");
        const skipped = importSkip(input.update(current));
        if (skipped !== undefined) return skipped;
        database
          .prepare(`INSERT INTO review_findings (task_id, payload, updated_at) VALUES (?, ?, ?)`)
          .run(input.taskId, jsonText(input.record), atMs);
        return { ok: true, value: { kind: "written" } };
      });
    },

    readProofReceipt(input) {
      return read("readProofReceipt", () => {
        const row = asRow(
          database.prepare("SELECT payload FROM proof_receipt WHERE task_id = ?").get(input.taskId),
        );
        if (row === undefined) return undefined;
        const parsed = jsonParse(readString(row, "payload"));
        // `null` parses to null, so undefined specifically means unparseable text.
        if (parsed === undefined) {
          throw new Error(`proof receipt for ${input.taskId} is not valid JSON`);
        }
        return parsed;
      });
    },

    writeProofReceipt(input) {
      const atMs = input.nowMs ?? now();
      return write("writeProofReceipt", () => {
        database
          .prepare(
            `INSERT INTO proof_receipt (task_id, payload, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET
               payload = excluded.payload,
               updated_at = excluded.updated_at`,
          )
          .run(input.taskId, jsonText(input.receipt), atMs);
        return { ok: true, value: null };
      });
    },

    mutateProofReceipt(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoImportMutation>("mutateProofReceipt", () => {
        const row = asRow(
          database.prepare("SELECT payload FROM proof_receipt WHERE task_id = ?").get(input.taskId),
        );
        // Presence, not the payload, is what the plan decides on: an unparseable
        // live row is still a row, so it is reported as present (the sentinel) and
        // the import never replaces it with the legacy copy.
        const current =
          row === undefined ? null : (jsonParse(readString(row, "payload")) ?? { present: true });
        const skipped = importSkip(input.update(current));
        if (skipped !== undefined) return skipped;
        database
          .prepare(`INSERT INTO proof_receipt (task_id, payload, updated_at) VALUES (?, ?, ?)`)
          .run(input.taskId, jsonText(input.receipt), atMs);
        return { ok: true, value: { kind: "written" } };
      });
    },

    readFleet(fleetId) {
      return read("readFleet", () => {
        const row = asRow(
          database.prepare("SELECT * FROM fleet_intent WHERE fleet_id = ?").get(fleetId),
        );
        return row === undefined ? null : fleetFromRow(row);
      });
    },

    listFleets() {
      return read("listFleets", () =>
        database
          .prepare("SELECT fleet_id FROM fleet_intent ORDER BY fleet_id ASC")
          .all()
          .map((raw) => readString(asRow(raw) ?? {}, "fleet_id"))
          .filter((fleetId) => fleetId !== ""),
      );
    },

    writeFleetIntent(input) {
      const atMs = input.nowMs ?? now();
      return write("writeFleetIntent", () => {
        database
          .prepare(
            `INSERT INTO fleet_intent (fleet_id, revision, intent, run, updated_at)
             VALUES (?, 1, ?, '{}', ?)
             ON CONFLICT(fleet_id) DO UPDATE SET
               intent = excluded.intent,
               revision = fleet_intent.revision + 1,
               updated_at = excluded.updated_at`,
          )
          .run(input.fleetId, jsonText(input.intent), atMs);
        const row = asRow(
          database.prepare("SELECT * FROM fleet_intent WHERE fleet_id = ?").get(input.fleetId),
        );
        if (row === undefined) throw new Error(`fleet ${input.fleetId} did not round-trip`);
        return { ok: true, value: fleetFromRow(row) };
      });
    },

    updateFleetIntent(input) {
      const atMs = input.nowMs ?? now();
      return write("updateFleetIntent", () => {
        // CAS by revision: the WHERE clause is the compare, so a stale writer can
        // never overwrite a newer document (the old raw-text compare had a
        // documented check-then-write window).
        const result = database
          .prepare(
            `UPDATE fleet_intent
                SET intent = ?, revision = revision + 1, updated_at = ?
              WHERE fleet_id = ? AND revision = ?`,
          )
          .run(jsonText(input.intent), atMs, input.fleetId, input.expectedRevision);
        if (Number(result.changes) === 0) {
          const row = asRow(
            database
              .prepare("SELECT revision FROM fleet_intent WHERE fleet_id = ?")
              .get(input.fleetId),
          );
          return {
            ok: false,
            error:
              row === undefined
                ? `fleet ${input.fleetId} does not exist`
                : `fleet ${input.fleetId} revision conflict (expected ${input.expectedRevision}, found ${readNumber(row, "revision")})`,
          };
        }
        const row = asRow(
          database.prepare("SELECT * FROM fleet_intent WHERE fleet_id = ?").get(input.fleetId),
        );
        if (row === undefined) throw new Error(`fleet ${input.fleetId} did not round-trip`);
        return { ok: true, value: fleetFromRow(row) };
      });
    },

    mutateFleet(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoFleetMutation>("mutateFleet", () => {
        const current = fleetById(input.fleetId);
        return applyFleetPlan({
          fleetId: input.fleetId,
          plan: input.update(current),
          current,
          atMs,
        });
      });
    },

    landFleetMember(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoFleetMutation>("landFleetMember", () => {
        const current = fleetById(input.fleetId);
        const plan = input.plan({
          intent: current?.intent,
          run: current?.run,
          revision: current?.revision ?? 0,
        });
        return applyFleetPlan({
          fleetId: input.fleetId,
          plan,
          current,
          atMs,
          ...(input.audit === undefined ? {} : { audit: input.audit }),
        });
      });
    },

    readFleetQueue(fleetId) {
      return read("readFleetQueue", () => {
        const row = asRow(
          database.prepare("SELECT * FROM fleet_queue WHERE fleet_id = ?").get(fleetId),
        );
        if (row === undefined) return null;
        return { revision: readNumber(row, "revision"), queue: readJson(row, "queue") };
      });
    },

    writeFleetQueue(input) {
      const atMs = input.nowMs ?? now();
      return write("writeFleetQueue", () => {
        database
          .prepare(
            `INSERT INTO fleet_queue (fleet_id, revision, queue, updated_at)
             VALUES (?, 1, ?, ?)
             ON CONFLICT(fleet_id) DO UPDATE SET
               queue = excluded.queue,
               revision = fleet_queue.revision + 1,
               updated_at = excluded.updated_at`,
          )
          .run(input.fleetId, jsonText(input.queue), atMs);
        const row = asRow(
          database.prepare("SELECT * FROM fleet_queue WHERE fleet_id = ?").get(input.fleetId),
        );
        if (row === undefined) throw new Error(`fleet queue ${input.fleetId} did not round-trip`);
        return {
          ok: true,
          value: { revision: readNumber(row, "revision"), queue: readJson(row, "queue") },
        };
      });
    },

    mutateFleetQueue(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoImportMutation>("mutateFleetQueue", () => {
        const row = asRow(
          database.prepare("SELECT * FROM fleet_queue WHERE fleet_id = ?").get(input.fleetId),
        );
        const current =
          row === undefined
            ? null
            : { revision: readNumber(row, "revision"), queue: readJson(row, "queue") };
        const skipped = importSkip(input.update(current));
        if (skipped !== undefined) return skipped;
        database
          .prepare(
            `INSERT INTO fleet_queue (fleet_id, revision, queue, updated_at)
             VALUES (?, 1, ?, ?)`,
          )
          .run(input.fleetId, jsonText(input.queue), atMs);
        return { ok: true, value: { kind: "written" } };
      });
    },

    updateFleetQueue(input) {
      const atMs = input.nowMs ?? now();
      return write("updateFleetQueue", () => {
        const result = database
          .prepare(
            `UPDATE fleet_queue SET queue = ?, revision = revision + 1, updated_at = ?
              WHERE fleet_id = ? AND revision = ?`,
          )
          .run(jsonText(input.queue), atMs, input.fleetId, input.expectedRevision);
        if (Number(result.changes) === 0) {
          const row = asRow(
            database
              .prepare("SELECT revision FROM fleet_queue WHERE fleet_id = ?")
              .get(input.fleetId),
          );
          return {
            ok: false,
            error:
              row === undefined
                ? `fleet queue ${input.fleetId} does not exist`
                : `fleet queue ${input.fleetId} revision conflict (expected ${input.expectedRevision}, found ${readNumber(row, "revision")})`,
          };
        }
        const row = asRow(
          database.prepare("SELECT * FROM fleet_queue WHERE fleet_id = ?").get(input.fleetId),
        );
        if (row === undefined) throw new Error(`fleet queue ${input.fleetId} did not round-trip`);
        return {
          ok: true,
          value: { revision: readNumber(row, "revision"), queue: readJson(row, "queue") },
        };
      });
    },

    acquireFleetLock(input) {
      const outcome = write<RepoFleetLockAcquire>("acquireFleetLock", () => {
        const row = asRow(
          database.prepare("SELECT * FROM fleet_lock WHERE fleet_id = ?").get(input.fleetId),
        );
        if (row !== undefined) {
          const existing = lockFromRow(row);
          const heldBySelf = existing.holder === input.holder;
          const expired = existing.expiresAt <= input.nowMs;
          if (!heldBySelf && !(expired && input.takeOverExpired !== false)) {
            return {
              ok: true,
              value: {
                ok: false,
                reason: "held",
                holder: existing.holder,
                expiresAt: existing.expiresAt,
              },
            };
          }
        }
        // Single-flight is the `WHERE` clause, not a directory that has to be
        // created and removed: the claim and its record are one atomic statement.
        database
          .prepare(
            `INSERT INTO fleet_lock (fleet_id, holder, task_id, pid, acquired_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(fleet_id) DO UPDATE SET
               holder = excluded.holder,
               task_id = excluded.task_id,
               pid = excluded.pid,
               acquired_at = excluded.acquired_at,
               expires_at = excluded.expires_at
             WHERE fleet_lock.expires_at <= ?
                OR fleet_lock.holder = excluded.holder`,
          )
          .run(
            input.fleetId,
            input.holder,
            input.taskId,
            Math.round(input.pid),
            Math.round(input.nowMs),
            Math.round(input.nowMs + input.leaseMs),
            Math.round(input.nowMs),
          );
        const written = asRow(
          database.prepare("SELECT * FROM fleet_lock WHERE fleet_id = ?").get(input.fleetId),
        );
        if (written === undefined) {
          return {
            ok: true,
            value: { ok: false, reason: "held", holder: "", expiresAt: 0 },
          };
        }
        const lock = lockFromRow(written);
        if (lock.holder !== input.holder) {
          return {
            ok: true,
            value: {
              ok: false,
              reason: "held",
              holder: lock.holder,
              expiresAt: lock.expiresAt,
            },
          };
        }
        return { ok: true, value: { ok: true, lock } };
      });
      if (!outcome.ok) {
        return { ok: false, reason: "held", holder: "", expiresAt: 0 };
      }
      return outcome.value;
    },

    renewFleetLock(input) {
      const outcome = write<RepoFleetLockAcquire>("renewFleetLock", () => {
        const result = database
          .prepare(
            `UPDATE fleet_lock SET expires_at = ?
              WHERE fleet_id = ? AND holder = ? AND expires_at > ?`,
          )
          .run(
            Math.round(input.nowMs + input.leaseMs),
            input.fleetId,
            input.holder,
            Math.round(input.nowMs),
          );
        const row = asRow(
          database.prepare("SELECT * FROM fleet_lock WHERE fleet_id = ?").get(input.fleetId),
        );
        if (row === undefined) {
          return {
            ok: true,
            value: { ok: false, reason: "held", holder: "", expiresAt: 0 },
          };
        }
        const lock = lockFromRow(row);
        if (Number(result.changes) === 0 || lock.holder !== input.holder) {
          return {
            ok: true,
            value: {
              ok: false,
              reason: "held",
              holder: lock.holder,
              expiresAt: lock.expiresAt,
            },
          };
        }
        return { ok: true, value: { ok: true, lock } };
      });
      if (!outcome.ok) return { ok: false, reason: "held", holder: "", expiresAt: 0 };
      return outcome.value;
    },

    releaseFleetLock(input) {
      return write("releaseFleetLock", () => {
        const result = database
          .prepare("DELETE FROM fleet_lock WHERE fleet_id = ? AND holder = ?")
          .run(input.fleetId, input.holder);
        return { ok: true, value: { released: Number(result.changes) > 0 } };
      });
    },

    readFleetLock(fleetId) {
      return read("readFleetLock", () => {
        const row = asRow(
          database.prepare("SELECT * FROM fleet_lock WHERE fleet_id = ?").get(fleetId),
        );
        return row === undefined ? null : lockFromRow(row);
      });
    },

    readSupervisor(fleetId) {
      return read("readSupervisor", () => {
        const row = asRow(
          database.prepare("SELECT * FROM fleet_supervisor WHERE fleet_id = ?").get(fleetId),
        );
        return row === undefined ? null : supervisorFromRow(row);
      });
    },

    writeSupervisor(input) {
      const atMs = input.nowMs ?? now();
      return write("writeSupervisor", () => {
        database
          .prepare(
            `INSERT INTO fleet_supervisor (fleet_id, session_id, pid, heartbeat_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(fleet_id) DO UPDATE SET
               session_id = excluded.session_id,
               pid = excluded.pid,
               heartbeat_at = excluded.heartbeat_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            input.fleetId,
            input.sessionId,
            Math.round(input.pid),
            Math.round(input.heartbeatAt),
            Math.round(atMs),
          );
        const row = asRow(
          database.prepare("SELECT * FROM fleet_supervisor WHERE fleet_id = ?").get(input.fleetId),
        );
        if (row === undefined)
          throw new Error(`fleet supervisor ${input.fleetId} did not round-trip`);
        return { ok: true, value: supervisorFromRow(row) };
      });
    },

    mutateSupervisor(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoImportMutation>("mutateSupervisor", () => {
        const row = asRow(
          database.prepare("SELECT * FROM fleet_supervisor WHERE fleet_id = ?").get(input.fleetId),
        );
        const current = row === undefined ? null : supervisorFromRow(row);
        const skipped = importSkip(input.update(current));
        if (skipped !== undefined) return skipped;
        database
          .prepare(
            `INSERT INTO fleet_supervisor (fleet_id, session_id, pid, heartbeat_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            input.fleetId,
            input.sessionId,
            Math.round(input.pid),
            Math.round(input.heartbeatAt),
            Math.round(atMs),
          );
        return { ok: true, value: { kind: "written" } };
      });
    },

    enqueueNote(input) {
      if (this.readOnly || closed) {
        return { ok: false, reason: "write-failed", error: "repo state store is not writable" };
      }
      // A malformed note is rejected at insert. The file store quarantined a
      // `.corrupt` note it could not parse; a row store has no such analogue and
      // silently dropping one is not an option, so bad input never becomes a row:
      // there is no quarantined row to inspect later.
      if (input.kind.trim() === "") {
        return { ok: false, reason: "invalid-note", error: "a fleet note needs a kind" };
      }
      if (input.target === "" || input.from === "") {
        return {
          ok: false,
          reason: "invalid-note",
          error: "a fleet note needs an address and an author",
        };
      }
      const body = input.body.slice(0, REPO_STATE_NOTE_BODY_MAX);
      const atMs = Math.round(input.nowMs ?? now());
      const outcome = write<RepoFleetNote>("enqueueNote", () => {
        const written = database
          .prepare(
            `INSERT INTO fleet_note (fleet_id, channel, target, author, kind, body, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(input.fleetId, input.channel, input.target, input.from, input.kind, body, atMs);
        // Same transaction as the insert: a note is either a row nobody can trace
        // or a row with its audit line, never the first on its own.
        appendAuditRow(input.fleetId, input.audit, atMs);
        return {
          ok: true,
          value: {
            seq: Number(written.lastInsertRowid),
            fleetId: input.fleetId,
            channel: input.channel,
            target: input.target,
            from: input.from,
            kind: input.kind,
            body,
            createdAt: atMs,
          } satisfies RepoFleetNote,
        };
      });
      if (!outcome.ok) {
        // Validation happens above, so anything that fails here is the store, not
        // the note: keep the two diagnoses apart for every caller.
        return { ok: false, reason: "write-failed", error: outcome.error };
      }
      return { ok: true, note: outcome.value };
    },

    importNote(input) {
      const createdAt = Math.round(input.createdAt);
      return write<{ seq: number; imported: boolean }>("importNote", () => {
        const existing = asRow(
          database
            .prepare(
              `SELECT seq FROM fleet_note
                WHERE fleet_id = ? AND channel = ? AND target = ? AND author = ?
                  AND kind = ? AND created_at = ?
                LIMIT 1`,
            )
            .get(input.fleetId, input.channel, input.target, input.from, input.kind, createdAt),
        );
        if (existing !== undefined) {
          return { ok: true, value: { seq: readNumber(existing, "seq"), imported: false } };
        }
        const written = database
          .prepare(
            `INSERT INTO fleet_note (fleet_id, channel, target, author, kind, body, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.fleetId,
            input.channel,
            input.target,
            input.from,
            input.kind,
            input.body.slice(0, REPO_STATE_NOTE_BODY_MAX),
            createdAt,
          );
        return { ok: true, value: { seq: Number(written.lastInsertRowid), imported: true } };
      });
    },

    drainNotes(input) {
      // At-least-once: the drain is a read. It deletes nothing and marks nothing, so
      // a consumer that dies before acking re-reads the same rows next time; only
      // `ackNotes` takes a row out of the pending set.
      return read<RepoFleetNote[]>("drainNotes", () => {
        const rows =
          input.target === undefined
            ? database
                .prepare(
                  `SELECT * FROM fleet_note
                    WHERE fleet_id = ? AND channel = ? AND acked_at IS NULL
                    ORDER BY seq ASC`,
                )
                .all(input.fleetId, input.channel)
            : database
                .prepare(
                  `SELECT * FROM fleet_note
                    WHERE fleet_id = ? AND channel = ? AND target = ? AND acked_at IS NULL
                    ORDER BY seq ASC`,
                )
                .all(input.fleetId, input.channel, input.target);
        return rows.map((raw) => noteFromRow(asRow(raw) ?? {}));
      });
    },

    ackNotes(input) {
      const atMs = Math.round(input.nowMs ?? now());
      return write("ackNotes", () => {
        const mark = database.prepare(
          "UPDATE fleet_note SET acked_at = ? WHERE seq = ? AND fleet_id = ? AND acked_at IS NULL",
        );
        // The fleet id is part of the WHERE, so a seq belonging to another fleet is
        // not acknowledged: the row identity is (fleet, seq), exactly as the drain
        // scopes it. An already-acked seq changes nothing and is not an error,
        // which is what makes a replayed ack idempotent.
        const seqs: number[] = [];
        for (const seq of input.seqs) {
          if (Number(mark.run(atMs, seq, input.fleetId).changes) > 0) seqs.push(seq);
        }
        return { ok: true, value: { acked: seqs.length, seqs } };
      });
    },

    appendAudit(input) {
      const atMs = input.nowMs ?? now();
      return write("appendAudit", () => ({
        ok: true,
        value: appendAuditRow(input.fleetId, input.entry, atMs),
      }));
    },

    importAudit(input) {
      const atMs = Math.round(input.nowMs ?? now());
      const payload = jsonText(input.entry);
      return write<{ seq: number; imported: boolean }>("importAudit", () => {
        // Bounded by the fleet id (there is an index on it), and this runs only from
        // the one-shot import, so the scan cost is not on any hot path.
        const existing = asRow(
          database
            .prepare(
              `SELECT seq FROM fleet_audit
                WHERE fleet_id = ? AND at = ? AND payload = ?
                LIMIT 1`,
            )
            .get(input.fleetId, atMs, payload),
        );
        if (existing !== undefined) {
          return { ok: true, value: { seq: readNumber(existing, "seq"), imported: false } };
        }
        const written = database
          .prepare("INSERT INTO fleet_audit (fleet_id, at, payload) VALUES (?, ?, ?)")
          .run(input.fleetId, atMs, payload);
        return { ok: true, value: { seq: Number(written.lastInsertRowid), imported: true } };
      });
    },

    readAudit(input) {
      const limit = Math.max(1, Math.min(input.limit ?? REPO_STATE_AUDIT_TAIL_ROWS, 1_000));
      return read("readAudit", () =>
        database
          .prepare("SELECT * FROM fleet_audit WHERE fleet_id = ? ORDER BY seq DESC LIMIT ?")
          .all(input.fleetId, limit)
          .map((raw) => auditFromRow(asRow(raw) ?? {}))
          .reverse(),
      );
    },

    readLaunchMarker(taskId) {
      return read("readLaunchMarker", () => {
        const row = asRow(
          database.prepare("SELECT payload FROM fleet_launch_marker WHERE task_id = ?").get(taskId),
        );
        return row === undefined ? null : readJson(row, "payload");
      });
    },

    writeLaunchMarker(input) {
      const atMs = input.nowMs ?? now();
      return write("writeLaunchMarker", () => {
        database
          .prepare(
            `INSERT INTO fleet_launch_marker (task_id, fleet_id, payload, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET
               fleet_id = excluded.fleet_id,
               payload = excluded.payload,
               updated_at = excluded.updated_at`,
          )
          .run(input.taskId, input.fleetId, jsonText(input.marker), atMs);
        return { ok: true, value: null };
      });
    },

    mutateLaunchMarker(input) {
      const atMs = input.nowMs ?? now();
      return write<RepoImportMutation>("mutateLaunchMarker", () => {
        const row = asRow(
          database
            .prepare("SELECT payload FROM fleet_launch_marker WHERE task_id = ?")
            .get(input.taskId),
        );
        const current = row === undefined ? null : readJson(row, "payload");
        const skipped = importSkip(input.update(current));
        if (skipped !== undefined) return skipped;
        database
          .prepare(
            `INSERT INTO fleet_launch_marker (task_id, fleet_id, payload, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.taskId, input.fleetId, jsonText(input.marker), atMs);
        return { ok: true, value: { kind: "written" } };
      });
    },

    clearLaunchMarker(taskId) {
      return write("clearLaunchMarker", () => {
        const result = database
          .prepare("DELETE FROM fleet_launch_marker WHERE task_id = ?")
          .run(taskId);
        return { ok: true, value: { cleared: Number(result.changes) > 0 } };
      });
    },

    hasMigration(name) {
      return read("hasMigration", () => {
        const row = asRow(database.prepare("SELECT name FROM migration WHERE name = ?").get(name));
        return row !== undefined;
      });
    },

    recordMigration(input) {
      const atMs = input.nowMs ?? now();
      return write("recordMigration", () => {
        const result = database
          .prepare(
            `INSERT INTO migration (name, applied_at, summary) VALUES (?, ?, ?)
             ON CONFLICT(name) DO NOTHING`,
          )
          .run(input.name, Math.round(atMs), input.summary);
        return { ok: true, value: { recorded: Number(result.changes) > 0 } };
      });
    },

    close() {
      if (closed) return;
      closed = true;
      if (ownsFile) {
        try {
          database.close();
        } catch {
          /* a failed close must not fail the caller's shutdown path */
        }
      }
    },
  };

  return { ok: true, store };
}

/**
 * Internal rollback signal, so a `write` body can return the caller's own
 * `{ ok: false }` value while still forcing the SQLite transaction to roll back.
 */
class RollbackSignal extends Error {
  readonly result: RepoStateResult<unknown>;

  constructor(result: RepoStateResult<unknown>) {
    super("rollback");
    this.name = "RollbackSignal";
    this.result = result;
  }
}

interface SharedFailure {
  atMs: number;
  failureClass: StoreFailureClass;
  warned: boolean;
}

/**
 * Run one write attempt chain with the bounded transient retry.
 *
 * A `RollbackSignal` is the body's own refusal (a typed `{ ok: false }` decision)
 * and is returned untouched — retrying it would repeat a caller error. Anything
 * else is a store-level throw: retried only while it classifies as transient and
 * only for {@link STORE_WRITE_ATTEMPTS} attempts, so a store that is genuinely
 * busy still reports a failure instead of stalling the caller's tick.
 *
 * The retry replays the whole transaction, which is safe because the body re-reads
 * its rows inside it: a replay recomputes the same plan against the committed state.
 * A fleet plan that would rewrite the row it just read is skipped rather than
 * re-applied (`applyFleetPlan`), so a landing replayed after an ambiguous commit
 * bumps no revision and appends no second audit row; upserts and revision CAS cover
 * the rest. The one residual is a throw *after* a successful commit (an IO error on
 * the commit itself), where a replay can deliver a second note — the delivery
 * contract already allows that, and the alternative is losing the write.
 */
function withTransientRetry<T>(
  operation: string,
  attempt: () => RepoStateResult<T>,
): RepoStateResult<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return attempt();
    } catch (error) {
      if (error instanceof RollbackSignal) return error.result as RepoStateResult<T>;
      const retryable = classifyStoreFailure(error) === "transient" && tries < STORE_WRITE_ATTEMPTS;
      if (!retryable) return { ok: false, error: `${operation} failed: ${errorMessage(error)}` };
      sleepSync(STORE_WRITE_BACKOFF_MS * tries);
    }
  }
}

/** Open stores by resolved path: one handle per repository per process. */
const sharedStores = new Map<string, RepoStateStore>();
/** Transient/permanent failure bookkeeping, mirroring the model-state store. */
const sharedFailures = new Map<string, SharedFailure>();

/**
 * Whether a previous failure forbids another open attempt right now.
 *
 * A permanent failure never retries; a transient one waits out
 * {@link SHARED_REPO_STATE_RETRY_MS}, so a broken install cannot warn (or shell out
 * to git) on every phase transition.
 */
function failureGate(key: string, nowMs: number): SharedRepoStateOpen | undefined {
  const failure = sharedFailures.get(key);
  if (failure === undefined) return undefined;
  if (failure.failureClass === "permanent") return { store: null, failureClass: "permanent" };
  if (nowMs - failure.atMs < SHARED_REPO_STATE_RETRY_MS) {
    return { store: null, failureClass: "transient" };
  }
  return undefined;
}

/** Record an open failure, warning once per outage. */
function recordOpenFailure(
  key: string,
  path: string,
  error: string,
  nowMs: number,
): SharedRepoStateOpen {
  const failureClass = classifyStoreFailure(error);
  const previous = sharedFailures.get(key);
  sharedFailures.set(key, { atMs: nowMs, failureClass, warned: true });
  if (previous === undefined || previous.warned === false) {
    console.warn(
      `belayd: repo state store ${path} unavailable (${failureClass}): ${error}. ` +
        (failureClass === "permanent"
          ? "Workflow and fleet state reads will report no state for this session."
          : `Retrying at most every ${SHARED_REPO_STATE_RETRY_MS / 1000}s.`),
    );
  }
  return { store: null, error, failureClass };
}

export interface SharedRepoStateOpen {
  store: RepoStateStore | null;
  error?: string;
  failureClass?: StoreFailureClass;
}

/**
 * The store path a shared open should use: an explicit path, or the worktree's
 * resolved git common dir. Split from the open so the branching lives in one
 * small function instead of the open's retry bookkeeping.
 */
function resolveSharedStorePath(options: {
  cwd?: string;
  path?: string;
  env?: Record<string, string | undefined>;
  resolveCommonDir?: RepoStatePathResolver;
}): RepoStateResult<string> {
  if (options.path !== undefined) return { ok: true, value: options.path };
  if (options.cwd === undefined) {
    return { ok: false, error: "shared repo state store needs a cwd or a path" };
  }
  return resolveRepoStatePath({
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.resolveCommonDir === undefined
      ? {}
      : { resolveCommonDir: options.resolveCommonDir }),
  });
}

/**
 * The shared store for one path, opened at most once per process.
 *
 * A worktree caller passes `cwd` (the store path is resolved from its git common
 * dir); fleet state already holds the git common dir and passes `path`.
 *
 * A transient first-open failure (a busy WAL writer, a migration in flight) is
 * retried no more often than {@link SHARED_REPO_STATE_RETRY_MS}; a permanent one
 * stops retrying and is reported once, because a broken install must not warn on
 * every phase transition. Both cases are reported as data: callers keep a
 * file-free degraded path (usually "no state") rather than crashing a turn.
 */
export function sharedRepoStateStore(options: {
  /** Worktree whose git common dir locates the store. Required unless `path` is set. */
  cwd?: string;
  /** Already-resolved store path (fleet state knows its git common dir). */
  path?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  resolveCommonDir?: RepoStatePathResolver;
  database?: SqliteDatabaseLike;
  /**
   * Skip the failure gate for one open attempt. Consulted by the gate only and
   * never forwarded to {@link openRepoStateStore}: a caller that is already
   * retrying a transient failure itself must not pass a clock, or the store it
   * opens would stamp every later defaulted write with that caller's epoch.
   */
  bypassFailureGate?: boolean;
}): SharedRepoStateOpen {
  const nowMs = (options.now ?? Date.now)();
  const resolved = resolveSharedStorePath(options);
  const key = resolved.ok ? resolved.value : `unresolved:${options.path ?? options.cwd ?? ""}`;
  const existing = sharedStores.get(key);
  if (existing !== undefined) return { store: existing };

  const blocked = options.bypassFailureGate === true ? undefined : failureGate(key, nowMs);
  if (blocked !== undefined) return blocked;

  if (!resolved.ok) {
    sharedFailures.set(key, { atMs: nowMs, failureClass: "permanent", warned: true });
    return { store: null, error: resolved.error, failureClass: "permanent" };
  }

  const opened = openRepoStateStore({
    path: resolved.value,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!opened.ok) return recordOpenFailure(key, resolved.value, opened.error, nowMs);
  sharedStores.set(key, opened.store);
  sharedFailures.delete(key);
  return { store: opened.store };
}

/** Close and forget every shared store. Tests and process shutdown use this. */
export function resetSharedRepoStateStore(): void {
  for (const store of sharedStores.values()) store.close();
  sharedStores.clear();
  sharedFailures.clear();
  resetRepoStatePaths();
}

/** Close one shared store (a test that simulates a daemon restart). */
export function closeSharedRepoStateStore(path: string): void {
  const store = sharedStores.get(path);
  if (store === undefined) return;
  store.close();
  sharedStores.delete(path);
  sharedFailures.delete(path);
}

/** Whether the store file exists at `path` (used by the migration refusal check). */
export function repoStateStoreExists(path: string): boolean {
  return existsSync(path);
}

/** @internal exposed for tests that need a rollback without a real failure. */
export const __testing = { RollbackSignal };
