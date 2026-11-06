/**
 * Shared fleet state — the cross-tree substrate of the fleet supervisor
 * (bd-126, milestones P1–P4 of docs/fleet-orchestrator.md).
 *
 * Nothing cross-worktree lives in a file any more. Every fact this module owns —
 * the operator intent and run record, the merge queue, the single-flight lock, the
 * supervisor beat, the launch markers, the audit trail and the note mailboxes — is
 * a row in the shared repository store at `<git-common-dir>/belayd/state.sqlite`
 * (bd-281). Identity is the repository, the fleet id and (for notes) the row seq,
 * so two sessions in different worktrees read the same rows instead of inheriting
 * copies, and a stale lease is observable from its `expires_at` rather than
 * inferred from a file's age.
 *
 * This module is storage plus pure parsing: nothing here schedules, spawns,
 * merges, stashes, or mutates a bead. Every write is the caller's explicit
 * call — nothing in this module happens implicitly.
 *
 * Split, mirroring `fleet-status.ts`: the note contract, audit formatting, and the
 * parsers are pure (tests pass values, no mocks); each reader/writer takes an
 * injected {@link FleetStateFs} seam, whose `store` carries the opened repository
 * store in tests.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { FleetPublish } from "./fleet-publish.js";
import { defaultFleetPublish } from "./fleet-publish.js";
import type { FleetRun } from "./fleet-run.js";
import type { FleetIntent } from "./fleet-status.js";
import {
  FLEET_INTENT_ORDERING_GATES_MAX,
  FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS,
  FLEET_LAUNCH_MARKER_SCHEMA_VERSION,
  FLEET_SCHEMA_VERSION,
  type FleetLaunchMarker,
  fleetIntentFromStoreRow,
  fleetIntentWriteRefusal,
  fleetLaunchMarkerTaskIdRefusal,
  fleetStateDir,
  parseFleetIntent,
  parseFleetLaunchMarker,
  readFleetLaunchMarker,
  sanitizeFleetId,
} from "./fleet-status.js";
import {
  REPO_STATE_AUDIT_TAIL_ROWS,
  type RepoFleetLock,
  type RepoFleetNote,
  type RepoStateStore,
  repoStatePathForCommonDir,
  sharedRepoStateStore,
} from "./repo-state-store.js";
import { DEFAULT_BASE_BRANCH } from "./stack-rebase.js";
import type { WorkflowFs } from "./workflow-state.js";

// ── Paths ─────────────────────────────────────────────────────────────

/** `<git-common-dir>/belayd/fleet` — the only cross-worktree root. */
export function fleetRoot(gitCommonDir: string): string {
  return join(gitCommonDir, "belayd", "fleet");
}

/**
 * One fleet's legacy directory.
 *
 * A documented survivor of the file era: no state is written there any more, but
 * two readers still need the path to *look* — `listFleetIds` (a fleet id is still
 * discovered from a directory left by a pre-store session) and the one-shot
 * importer that moves those files into rows. Delegates to `fleetStateDir` so the
 * id-scoped shape and its sanitizer have one implementation.
 */
export function fleetDir(gitCommonDir: string, fleetId: string): string {
  return fleetStateDir(gitCommonDir, fleetId);
}

// ── Filesystem seam ───────────────────────────────────────────────────

/**
 * Fs surface the fleet state layer needs: the workflow-state seam (shared with the
 * remaining runtime JSON files) plus a directory listing for the legacy fleet-id
 * scan, and the opened store every row write goes through.
 */
export interface FleetStateFs extends WorkflowFs {
  /** Legacy fleet-id discovery and the importer only; no note path is read. */
  readdirSync(path: string): string[];
  /**
   * The repository store the fleet rows live in (bd-281).
   *
   * Production leaves it undefined and every call resolves the shared store at
   * `<git-common-dir>/belayd/state.sqlite`; unit tests pass their own opened store
   * here so a fake fs needs no real repository.
   */
  store?: RepoStateStore;
}

/** Truncate to at most `limit` characters, marking that it was cut. */
function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/** Result of any fleet-state write. */
export type FleetStateWriteResult = { ok: true } | { ok: false; error: string };

// ── fleet intent + run record (shared store row) ──────────────────────

/**
 * The stored fleet id must always match the row that holds the record; otherwise
 * two fleet ids could claim one intent. Sanitizing here is idempotent for the id
 * the path helpers already derived.
 */
function withDirectoryFleetId(intent: FleetIntent, fleetId: string): FleetIntent {
  return { ...intent, fleetId: sanitizeFleetId(fleetId) };
}

/**
 * Absorb a legacy v1 record handed to a writer.
 *
 * {@link fleetIntentWriteRefusal} validates the current (v2) schema only — a
 * writer can only mint a current record — so a v1 record an older caller or a
 * fixture still hands us is upgraded here exactly as `parseFleetIntent` does on
 * read. Anything that is not a v1 record is returned unchanged, so a v2 record's
 * forward-compat fields survive a replace.
 */
function migrateLegacyIntentForWrite(intent: FleetIntent): FleetIntent {
  if (typeof intent !== "object" || intent === null) return intent;
  if ((intent as { schemaVersion?: unknown }).schemaVersion !== 1) return intent;
  return parseFleetIntent(intent) ?? intent;
}

/** The record every write path lands: current schema, id bound to the row key. */
function intentForWrite(intent: FleetIntent, fleetId: string): FleetIntent {
  return withDirectoryFleetId(migrateLegacyIntentForWrite(intent), fleetId);
}

/**
 * Split the record into the two stored columns.
 *
 * The run is a column of its own so a caller can bump either half without writing
 * a stale copy of the other, and the intent column never carries a second copy of
 * the run. Both land in one transaction; see {@link writeFleetRun}.
 *
 * Exported because the one-shot file import (bd-281) must land a legacy
 * `fleet.json` into exactly the two columns a live write uses.
 */
export function splitFleetIntent(intent: FleetIntent): {
  document: FleetIntent;
  run: FleetIntent["run"];
} {
  const { run, ...document } = intent;
  return { document, run };
}

export interface FleetIntentOptions {
  gitCommonDir: string;
  fleetId: string;
  fs?: FleetStateFs;
  /**
   * Test seam: an already-opened repository store. Production omits it and the
   * shared store at `<git-common-dir>/belayd/state.sqlite` is used.
   */
  store?: RepoStateStore;
  /** Epoch-ms clock for the write this call makes. Defaults to `Date.now`. */
  now?: number;
}

/**
 * The store a fleet intent call reads and writes.
 *
 * Resolved from the git common dir the caller already holds (never a worktree
 * path): every worktree of one repository therefore resolves the same row, which
 * is what makes a copied record impossible.
 */
/**
 * The repository store these fleet facts live in.
 *
 * Fleet identity is the git common dir the caller already holds (never a worktree
 * path), so every worktree resolves the same rows. Exported because the merge
 * queue, audit, markers and heartbeat all write through it.
 */
export function fleetStoreFor(options: {
  gitCommonDir: string;
  fs?: FleetStateFs;
  store?: RepoStateStore;
}): RepoStateStore | null {
  if (options.store !== undefined) return options.store;
  if (options.fs?.store !== undefined) return options.fs.store;
  return sharedRepoStateStore({ path: repoStatePathForCommonDir(options.gitCommonDir) }).store;
}

/** A failed intent write, with the reason the caller's next step depends on. */
type FleetIntentUpdateFailureReason =
  | "corrupt-intent"
  | "read-failed"
  | "write-failed"
  | "conflict"
  | "refused";

interface FleetIntentUpdateFailure {
  reason: FleetIntentUpdateFailureReason;
  error: string;
}

/**
 * Multi-outcome on purpose: `corrupt-intent` is distinguishable from absence
 * because a writer must not silently replace a record it failed to understand.
 */
export type FleetIntentLoadResult =
  | { ok: true; intent: FleetIntent | undefined }
  | { ok: false; reason: "corrupt-intent" | "read-failed"; error: string };

/**
 * Read the fleet's row. Absent means "no intent"; a row this version cannot parse
 * is reported rather than treated as absence.
 *
 * The run record shares the row and is recombined into the intent here, so every
 * existing reader keeps seeing the record the file used to hold (bd-281).
 */
export function readFleetIntent(options: FleetIntentOptions): FleetIntentLoadResult {
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return {
      ok: false,
      reason: "read-failed",
      error: `fleet ${fleetId}: the repository state store is unavailable`,
    };
  }
  const row = store.readFleet(fleetId);
  if (!row.ok) return { ok: false, reason: "read-failed", error: row.error };
  if (row.value === null) return { ok: true, intent: undefined };
  const intent = fleetIntentFromStoreRow(row.value);
  return intent === undefined
    ? {
        ok: false,
        reason: "corrupt-intent",
        error: `fleet ${fleetId} row is not a fleet intent`,
      }
    : { ok: true, intent };
}

export interface WriteFleetIntentOptions extends FleetIntentOptions {
  intent: FleetIntent;
}

/**
 * Replace the stored intent, refusing a row this version cannot read.
 *
 * Absence is writable; a **present but unparsable** row is refused. The
 * single-schema guarantee only holds if every writer refuses what it cannot read:
 * replacing an unreadable record would erase operator intent (possibly written by
 * a newer schema) that this version simply does not understand. Mutations should
 * go through {@link updateFleetIntent}; this function is the wholesale-replace
 * form of the same rule.
 *
 * A record that carries a run is written through the same transactional plan as
 * {@link updateFleetIntent}, so its run column cannot be bumped separately. A
 * record without one leaves any stored run untouched: an intent replace must not
 * silently forget the loop record.
 */
export function writeFleetIntent(options: WriteFleetIntentOptions): FleetStateWriteResult {
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return { ok: false, error: `fleet ${fleetId}: the repository state store is unavailable` };
  }
  const current = store.readFleet(fleetId);
  if (!current.ok) {
    return {
      ok: false,
      error: `refusing to replace unreadable fleet intent for ${fleetId}: ${current.error}`,
    };
  }
  if (current.value !== null && fleetIntentFromStoreRow(current.value) === undefined) {
    return {
      ok: false,
      error: `refusing to replace unreadable fleet intent for ${fleetId}: its row is not a fleet intent`,
    };
  }
  const intent = intentForWrite(options.intent, fleetId);
  const refusal = fleetIntentWriteRefusal(intent);
  if (refusal !== undefined) {
    return { ok: false, error: `refusing to write fleet intent for ${fleetId}: ${refusal}` };
  }
  const { document, run } = splitFleetIntent(intent);
  const nowMs = options.now ?? Date.now();
  if (run === undefined) {
    const written = store.writeFleetIntent({ fleetId, intent: document, nowMs });
    return written.ok ? { ok: true } : { ok: false, error: written.error };
  }
  const written = store.mutateFleet({
    fleetId,
    update: () => ({ kind: "write", intent: document, run }),
    nowMs,
  });
  return written.ok && written.value.kind === "written"
    ? { ok: true }
    : {
        ok: false,
        error: written.ok
          ? `fleet ${fleetId} could not be written (${written.value.kind})`
          : written.error,
      };
}

/**
 * An updater that must not write after all: the record read inside the update is
 * missing or in a state the caller refuses to change.
 *
 * This exists so a mutation whose precondition is only decidable from the *fresh*
 * record (park, unpause, prune) decides it against the row read inside the same
 * transaction: a blind write after a separate read loses any update that landed in
 * between.
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
      reason: FleetIntentUpdateFailureReason;
      error: string;
    };

/**
 * Read-modify-write the fleet's row in one `BEGIN IMMEDIATE`.
 *
 * **Concurrency (W6, resolved by bd-281):** the updater runs inside the store's
 * write transaction and the plan is committed with a revision bump, so a
 * concurrent writer is serialised by SQLite instead of losing an update to a
 * check-then-write window. This is *not* a race any more: the previous file path
 * compared raw text and documented a residual window that needed an `O_EXCL`
 * primitive; the store's transaction is that primitive.
 *
 * A corrupt row is refused rather than overwritten: replacing it would erase
 * operator intent the supervisor could not read.
 */
export function updateFleetIntent(options: UpdateFleetIntentOptions): UpdateFleetIntentResult {
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return {
      ok: false,
      reason: "read-failed",
      error: `fleet ${fleetId}: the repository state store is unavailable`,
    };
  }

  let failure: FleetIntentUpdateFailure | undefined;
  // Classify the failure before opening a write transaction: an unreadable or
  // unparsable row is “read-failed”/“corrupt-intent”, and reporting it as a write
  // failure would send the operator to the wrong remedy. The transaction below
  // re-reads the row, so this is diagnosis, never the value the write is based on.
  const before = store.readFleet(fleetId);
  if (!before.ok) return { ok: false, reason: "read-failed", error: before.error };
  if (before.value !== null && fleetIntentFromStoreRow(before.value) === undefined) {
    return {
      ok: false,
      reason: "corrupt-intent",
      error: `fleet ${fleetId} row is not a fleet intent`,
    };
  }
  const result = store.mutateFleet({
    fleetId,
    update: (current) => {
      const intent = current === null ? undefined : fleetIntentFromStoreRow(current);
      if (current !== null && intent === undefined) {
        failure = {
          reason: "corrupt-intent",
          error: `fleet ${fleetId} row is not a fleet intent`,
        };
        return { kind: "conflict", error: failure.error };
      }
      const outcome = options.update(intent);
      if (isUpdateRefusal(outcome)) {
        failure = { reason: "refused", error: outcome.refuse };
        return { kind: "conflict", error: outcome.refuse };
      }
      const next = intentForWrite(outcome, fleetId);
      const refusal = fleetIntentWriteRefusal(next);
      if (refusal !== undefined) {
        failure = {
          reason: "write-failed",
          error: `refusing to write fleet intent for ${fleetId}: ${refusal}`,
        };
        return { kind: "conflict", error: failure.error };
      }
      const { document, run } = splitFleetIntent(next);
      return { kind: "write", intent: document, ...(run === undefined ? {} : { run }) };
    },
    nowMs: options.now ?? Date.now(),
  });

  if (!result.ok) return { ok: false, reason: "write-failed", error: result.error };
  switch (result.value.kind) {
    case "written": {
      const intent = fleetIntentFromStoreRow({
        intent: result.value.intent,
        run: result.value.run,
      });
      return intent === undefined
        ? {
            ok: false,
            reason: "corrupt-intent",
            error: `fleet ${fleetId} row did not read back as a fleet intent`,
          }
        : { ok: true, intent };
    }
    case "conflict":
      return failure === undefined
        ? { ok: false, reason: "conflict", error: result.value.error }
        : { ok: false, ...failure };
    case "missing":
      return failure === undefined
        ? { ok: false, reason: "refused", error: `no fleet intent for \`${fleetId}\`` }
        : { ok: false, ...failure };
    case "unchanged":
      return failure === undefined
        ? { ok: false, reason: "conflict", error: `fleet ${fleetId} was not changed` }
        : { ok: false, ...failure };
  }
}

export interface WriteFleetRunOptions extends FleetIntentOptions {
  run: FleetRun;
  now: number;
}

/** Write the run record, or say why the row refused it. */
export type WriteFleetRunResult = { ok: true; intent: FleetIntent } | { ok: false; error: string };

/**
 * Commit the run record and its intent revision bump in ONE transaction (bd-281).
 *
 * The run has never been independent state: it is the loop's view of the intent
 * it is driving, so a caller must not be able to store one without the other. The
 * plan carries both columns inside `mutateFleet`'s `BEGIN IMMEDIATE`, which is the
 * whole point of the store — the file path wrote the intent, and with it the whole
 * run, in one blind replace with no CAS at all.
 */
export function writeFleetRun(options: WriteFleetRunOptions): WriteFleetRunResult {
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return { ok: false, error: `fleet ${fleetId}: the repository state store is unavailable` };
  }
  let failure: string | undefined;
  const result = store.mutateFleet({
    fleetId,
    update: (current) => {
      const intent = current === null ? undefined : fleetIntentFromStoreRow(current);
      if (intent === undefined || current === null) {
        failure =
          current === null
            ? `no fleet intent for \`${fleetId}\``
            : `fleet ${fleetId} row is not a fleet intent`;
        return { kind: "conflict", error: failure };
      }
      const next = intentForWrite({ ...intent, run: options.run, updatedAt: options.now }, fleetId);
      const refusal = fleetIntentWriteRefusal(next);
      if (refusal !== undefined) {
        failure = `refusing to write fleet intent for ${fleetId}: ${refusal}`;
        return { kind: "conflict", error: failure };
      }
      const { document, run } = splitFleetIntent(next);
      return { kind: "write", intent: document, run };
    },
    nowMs: options.now,
  });
  if (!result.ok) return { ok: false, error: result.error };
  if (result.value.kind !== "written") {
    return { ok: false, error: failure ?? `fleet ${fleetId} was not written` };
  }
  const intent = fleetIntentFromStoreRow({
    intent: result.value.intent,
    run: result.value.run,
  });
  return intent === undefined
    ? { ok: false, error: `fleet ${fleetId} row did not read back as a fleet intent` }
    : { ok: true, intent };
}

/**
 * What one landing plans to commit.
 *
 * A refusal is the caller's own decision (a record the landing cannot safely
 * replace); the store rolls the whole plan back either way, so a refusal leaves no
 * half-landed member, no revision bump and no audit row.
 */
export type FleetLandingPlan =
  | { kind: "write"; intent: FleetIntent; run: FleetRun }
  | { kind: "conflict"; error: string };

export interface LandFleetMemberOptions extends FleetIntentOptions {
  /**
   * Pure fold from the record read **inside** the transaction to the landed record.
   *
   * Everything a landing implies belongs here: the member pruned from the intent, the
   * ordering-gate records it resolved, and the run's `landedAt`. The fold sees the
   * row the transaction just read, so it never builds on a snapshot another session
   * has already replaced.
   */
  plan: (current: { intent: FleetIntent; run: FleetRun | undefined }) => FleetLandingPlan;
  /**
   * Audit entry appended in the same commit.
   *
   * Mandatory: a landing is the one cross-tree fact a human audits, and an
   * enqueue-then-audit pair is exactly the crash window this transaction removes.
   */
  audit: FleetAuditEntry;
}

export type LandFleetMemberResult =
  | { ok: true; intent: FleetIntent; revision: number }
  | { ok: false; reason: FleetIntentUpdateFailureReason; error: string };

/**
 * Record a landing: member, run record, ordering-gate records and audit in ONE
 * transaction (bd-281).
 *
 * The store owns the transaction (`landFleetMember` → `BEGIN IMMEDIATE`) and bumps
 * the revision exactly once, however many members and gate records the plan folds:
 * there is no per-item write to bump separately. A replayed call — the store's
 * transient retry after a commit that threw — recomputes the document the row
 * already holds and is therefore a no-op that bumps nothing and audits nothing,
 * while still reporting the landing. Two things deliberately stay outside, because
 * neither can join a SQLite transaction:
 *
 * - The **git merge** runs before this call; a landing is only recorded once the
 *   merge has actually happened.
 * - The **bd gate resolve** runs after the commit. See the ordering note on the
 *   caller in `extensions/capabilities/fleet.ts`.
 */
export function landFleetMember(options: LandFleetMemberOptions): LandFleetMemberResult {
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return {
      ok: false,
      reason: "read-failed",
      error: `fleet ${fleetId}: the repository state store is unavailable`,
    };
  }
  const nowMs = options.now ?? Date.now();
  let failure: FleetIntentUpdateFailure | undefined;
  const result = store.landFleetMember({
    fleetId,
    plan: (current) => {
      const intent = fleetIntentFromStoreRow({ intent: current.intent, run: current.run });
      if (intent === undefined) {
        failure = {
          reason: "corrupt-intent",
          error: `fleet ${fleetId} row is not a fleet intent`,
        };
        return { kind: "conflict", error: failure.error };
      }
      const planned = options.plan({ intent, run: intent.run });
      if (planned.kind === "conflict") {
        failure = { reason: "conflict", error: planned.error };
        return planned;
      }
      const next = intentForWrite(
        { ...planned.intent, run: planned.run, updatedAt: nowMs },
        fleetId,
      );
      const refusal = fleetIntentWriteRefusal(next);
      if (refusal !== undefined) {
        failure = {
          reason: "write-failed",
          error: `refusing to write fleet intent for ${fleetId}: ${refusal}`,
        };
        return { kind: "conflict", error: failure.error };
      }
      const { document, run } = splitFleetIntent(next);
      return { kind: "write", intent: document, run };
    },
    // The row's own clock, so the audit entry cannot claim an instant the landing
    // did not commit at.
    audit: boundAuditEntry({ ...options.audit, fleetId, timestamp: nowMs }),
    nowMs,
  });

  if (!result.ok) return { ok: false, reason: "write-failed", error: result.error };
  switch (result.value.kind) {
    case "written": {
      const intent = fleetIntentFromStoreRow({
        intent: result.value.intent,
        run: result.value.run,
      });
      return intent === undefined
        ? {
            ok: false,
            reason: "corrupt-intent",
            error: `fleet ${fleetId} row did not read back as a fleet intent`,
          }
        : { ok: true, intent, revision: result.value.revision };
    }
    case "conflict":
      return {
        ok: false,
        ...(failure ?? { reason: "conflict" as const, error: result.value.error }),
      };
    case "missing":
      return {
        ok: false,
        ...(failure ?? {
          reason: "refused" as const,
          error: `no fleet intent for \`${fleetId}\``,
        }),
      };
    case "unchanged":
      return {
        ok: false,
        ...(failure ?? {
          reason: "conflict" as const,
          error: `fleet ${fleetId} was not changed`,
        }),
      };
  }
}

export interface CreateFleetIntentInput {
  fleetId: string;
  taskIds: readonly string[];
  /** Epoch-ms clock value supplied by the caller (no ambient `Date.now` here). */
  now: number;
  maxConcurrent?: number;
  baseBranch?: string;
  /** Publish contract frozen at launch (bd-174.1). Defaults to local. */
  publish?: FleetPublish;
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
    baseBranch: input.baseBranch ?? DEFAULT_BASE_BRANCH,
    publish: input.publish ?? defaultFleetPublish(),
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

/**
 * Drop a **landed** member: out of the member list and out of the deferred plan.
 *
 * Only landing (or an explicit operator removal) may take a member out of
 * `taskIds`: a member that stopped but did not land still has a worktree, a
 * branch, and a bead, and dropping its id is what made a sibling's blocker read as
 * a bead outside the fleet.
 */
export function pruneLandedFleetMember(
  intent: FleetIntent,
  taskId: string,
  now: number,
): FleetIntent {
  // The ordering-gate records are deliberately left alone here: resolving a gate
  // needs bd, so the caller resolves first and forgets second (or the run's tick
  // reaper notices the gate's member is gone). Dropping the record here would
  // orphan an open gate that nothing could resolve any more (bd-158).
  return {
    ...intent,
    taskIds: intent.taskIds.filter((candidate) => candidate !== taskId),
    deferred: (intent.deferred ?? []).filter((entry) => entry.taskId !== taskId),
    // The member no longer exists, so a release that skipped its capacity slot has
    // nothing left to describe; keeping it would leave a dangling entry no landing
    // could ever clear.
    ...(intent.released === undefined
      ? {}
      : { released: intent.released.filter((entry) => entry.taskId !== taskId) }),
    updatedAt: now,
  };
}

/** One gate the intent refused to record, with the reason a human can act on. */
export interface RefusedFleetOrderingGate {
  gate: { blocker: string; blocked: string; gateId: string };
  error: string;
}

/**
 * Outcome of recording adopted gates: the record to write, plus anything refused.
 *
 * A refusal is a refusal of *that gate*, never a truncation of the set: the gates
 * that fit are recorded, and every gate left out is reported with its own reason so
 * the caller can leave it open in bd and name it for a human. Silently cutting the
 * array (or writing it over-bound) would either orphan an open gate or brick the
 * whole intent.
 */
export type AddFleetOrderingGatesResult =
  | { ok: true; intent: FleetIntent }
  | { ok: false; intent: FleetIntent; refused: readonly RefusedFleetOrderingGate[] };

/**
 * Record ordering gates the fleet found in bd but had no record of (bd-158).
 *
 * Adoption exists for the crash window between `bd gate create` and the intent
 * write: the gate is live and correctly blocks its dependent, so the fleet's job is
 * to remember it (the blocker's landing then resolves it), never to resolve it early
 * by hand. The unit is again the gate id — an edge already recorded is kept as-is,
 * because two records for one edge would make the resolver resolve one and forget
 * the other.
 *
 * The record bound is enforced **here**, not only at launch: bd's gate count is
 * bounded by nothing this process controls (a crashed launch can leave arbitrarily
 * many), so one sweep over a damaged fleet could otherwise append past
 * {@link FLEET_INTENT_ORDERING_GATES_MAX} and write a record every reader refuses —
 * the permanent `corrupt-intent` that takes status, launch, tick, and reconcile down
 * at once. Gates that do not fit are refused individually and stay open in bd; the
 * caller must report them rather than resolve them (resolving would release a
 * dependent before its blocker landed).
 */
export function addFleetOrderingGates(
  intent: FleetIntent,
  gates: readonly { blocker: string; blocked: string; gateId: string }[],
  now: number,
): AddFleetOrderingGatesResult {
  if (gates.length === 0) return { ok: true, intent };
  const kept = intent.orderingGates ?? [];
  const edges = new Set(kept.map((gate) => `${gate.blocker}\u0000${gate.blocked}`));
  const gateIds = new Set(kept.map((gate) => gate.gateId));
  const candidates = gates.filter((gate) => {
    const edge = `${gate.blocker}\u0000${gate.blocked}`;
    if (edges.has(edge) || gateIds.has(gate.gateId)) return false;
    edges.add(edge);
    gateIds.add(gate.gateId);
    return true;
  });
  if (candidates.length === 0) return { ok: true, intent };

  const accepted: RefusedFleetOrderingGate["gate"][] = [];
  const refused: RefusedFleetOrderingGate[] = [];
  for (const gate of candidates) {
    if (kept.length + accepted.length >= FLEET_INTENT_ORDERING_GATES_MAX) {
      refused.push({
        gate,
        error:
          `the fleet intent already records ${FLEET_INTENT_ORDERING_GATES_MAX} ordering gates ` +
          "(its bound); this gate stays open in bd and is not recorded, so a human must " +
          "resolve it or prune the fleet",
      });
      continue;
    }
    accepted.push(gate);
  }
  const next: FleetIntent =
    accepted.length === 0
      ? intent
      : { ...intent, orderingGates: [...kept, ...accepted], updatedAt: now };
  return refused.length === 0 ? { ok: true, intent: next } : { ok: false, intent: next, refused };
}

/**
 * Drop the recorded ordering gates with these **gate ids** (bd-158).
 *
 * Pure, so it only forgets: the caller resolves the gate in bd first, because an
 * open gate with no record is an orphan nobody can find again.
 *
 * The unit is the gate id, never the member id. A member can be the blocker of
 * several gates (dependents B and C), and resolving one of them says nothing about
 * the other: dropping records by member would forget a still-open gate that no
 * later landing or reap could ever resolve, leaving that dependent blocked in bd
 * forever.
 */
export function dropFleetOrderingGates(
  intent: FleetIntent,
  gateIds: readonly string[],
  now: number,
): FleetIntent {
  const gates = intent.orderingGates;
  if (gates === undefined || gates.length === 0 || gateIds.length === 0) return intent;
  const dropped = new Set(gateIds);
  const kept = gates.filter((gate) => !dropped.has(gate.gateId));
  if (kept.length === gates.length) return intent;
  const next: FleetIntent = { ...intent, updatedAt: now };
  if (kept.length === 0) delete next.orderingGates;
  else next.orderingGates = kept;
  return next;
}

/**
 * Retire a stopped member's deferral entry while keeping its membership.
 *
 * A stop is not a landing, so the member stays in `taskIds` with its stop record
 * on the run (status, reconcile, and a later land all read it there). The plan
 * entry goes so a later advance cannot relaunch a member the run gave up on.
 */
export function retireFleetDeferral(intent: FleetIntent, taskId: string, now: number): FleetIntent {
  return {
    ...intent,
    deferred: (intent.deferred ?? []).filter((entry) => entry.taskId !== taskId),
    updatedAt: now,
  };
}

// ── audit (store rows, bounded tail) ──────────────────────────────────

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
  return JSON.stringify(boundAuditEntry(entry));
}

/**
 * The record as stored: every free-text field bounded.
 *
 * One implementation for the JSONL formatter and the row writer, so the bound is
 * enforced on the bytes/row whichever path an entry takes and a caller cannot store
 * an unbounded payload the reader would then have to defend against.
 */
function boundAuditEntry(entry: FleetAuditEntry): FleetAuditEntry {
  const taskIds = entry.taskIds
    .slice(0, FLEET_AUDIT_TASK_IDS_MAX)
    .map((taskId) => boundText(taskId, FLEET_AUDIT_TASK_ID_MAX_LENGTH));
  return {
    timestamp: entry.timestamp,
    fleetId: entry.fleetId,
    actor: boundText(entry.actor, FLEET_AUDIT_ACTOR_MAX_LENGTH),
    action: boundText(entry.action, FLEET_AUDIT_ACTION_MAX_LENGTH),
    taskIds,
    detail: boundText(entry.detail, FLEET_AUDIT_DETAIL_MAX_LENGTH),
  };
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
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return { ok: false, error: `fleet ${fleetId}: the repository state store is unavailable` };
  }
  const entry: FleetAuditEntry = boundAuditEntry({
    ...options.entry,
    fleetId,
  });
  // The row's `at` is the entry's own timestamp, so a reader sees the same instant
  // the writer recorded and the audit never drifts from its actor's clock.
  const written = store.appendAudit({ fleetId, entry, nowMs: entry.timestamp });
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}

/** Wrap the not-quite-a-record check without a bare cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * One stored audit payload, or undefined when it is not an entry.
 *
 * Exported because the one-shot file import (bd-281) must validate a legacy
 * `audit.log` line with exactly the check this reader applies to a row, so an
 * imported entry cannot be one the reader later rejects.
 */
export function parseFleetAuditEntry(parsed: unknown): FleetAuditEntry | undefined {
  if (!isRecord(parsed)) return undefined;
  const { timestamp, fleetId: entryFleetId, actor, action, taskIds, detail } = parsed;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  if (typeof action !== "string" || typeof detail !== "string") return undefined;
  return {
    timestamp,
    fleetId: typeof entryFleetId === "string" ? entryFleetId : "",
    actor: typeof actor === "string" ? actor : "",
    action,
    taskIds: Array.isArray(taskIds)
      ? taskIds.filter((taskId): taskId is string => typeof taskId === "string")
      : [],
    detail,
  };
}

export interface RecentFleetAuditOptions extends FleetIntentOptions {
  /** Only entries with `timestamp >= since` are returned. */
  since: number;
  /** Restrict to one action; absent means any action. */
  action?: string;
}

/**
 * Recent audit entries, read from a bounded tail of rows.
 *
 * **Semantic change from the file store (bd-281).** `audit.log` was bounded by
 * bytes (64 KiB) because a file has no rows; the
 * store bounds by {@link REPO_STATE_AUDIT_TAIL_ROWS}, which is what the caller
 * actually asks ("the last N entries") and does not shrink as messages get
 * shorter. Rows are returned oldest-first within that window, matching the file
 * reader's order.
 *
 * Exists so a caller can ask "was this already reported recently?" (the leaderless
 * wedge alarm, bd-169). A malformed payload is skipped and an unreadable store is
 * **no entries**: this is a dedup signal, never authority, and it must not be able
 * to break a session start.
 */
export function readRecentFleetAuditEntries(
  options: RecentFleetAuditOptions,
): readonly FleetAuditEntry[] {
  const store = fleetStoreFor(options);
  if (store === null) return [];
  const read = store.readAudit({
    fleetId: sanitizeFleetId(options.fleetId),
    limit: REPO_STATE_AUDIT_TAIL_ROWS,
  });
  if (!read.ok) return [];
  const entries: FleetAuditEntry[] = [];
  for (const row of read.value) {
    const entry = parseFleetAuditEntry(row.payload);
    if (entry === undefined) continue;
    if (entry.timestamp < options.since) continue;
    if (options.action !== undefined && entry.action !== options.action) continue;
    entries.push(entry);
  }
  return entries;
}

// ── Spawn markers (store rows) ─────────────────────────────────────────

/**
 * Record that a member's spawn is in flight (bd-233).
 *
 * Written immediately before the spawner creates the worktree and re-stamped while the
 * spawn lives by {@link withFleetLaunchMarker}. Only removal — that helper's `finally`
 * — or a full grace with no refresh ends the window, so nothing else that ticks can
 * keep it alive.
 *
 * `owner` is the spawn token {@link withFleetLaunchMarker} mints for this spawn: every
 * write and refresh carries it, and a clear only deletes a marker whose owner matches,
 * so a slow spawner cannot erase a newer spawn's window for the same member (bd-233
 * round 4).
 */
export function writeFleetLaunchMarker(options: {
  gitCommonDir: string;
  fleetId: string;
  taskId: string;
  now: number;
  owner: string;
  fs?: FleetStateFs;
}): { ok: true; marker: FleetLaunchMarker } | { ok: false; error: string } {
  const refusal = fleetLaunchMarkerTaskIdRefusal(options.taskId);
  if (refusal !== undefined) return { ok: false, error: refusal };
  const store = fleetStoreFor(options);
  if (store === null) {
    return { ok: false, error: "the repository state store is unavailable" };
  }
  const marker: FleetLaunchMarker = {
    schemaVersion: FLEET_LAUNCH_MARKER_SCHEMA_VERSION,
    taskId: options.taskId,
    startedAt: options.now,
    owner: options.owner,
  };
  const written = store.writeLaunchMarker({
    taskId: options.taskId,
    fleetId: sanitizeFleetId(options.fleetId),
    marker,
    nowMs: options.now,
  });
  return written.ok ? { ok: true, marker } : { ok: false, error: written.error };
}

/**
 * Clear a member's spawn marker; an absent marker is success (idempotent).
 *
 * Owner-scoped (bd-233 round 4): the row is deleted only when its owner matches the
 * caller's spawn token. A relaunch overwrites the marker with its own token, so the
 * older spawn's `finally` must leave that newer window alone — it reports the
 * refusal (best effort, never throws, never deletes a foreign marker). An unreadable
 * or ownerless marker is treated the same way: not provably ours.
 *
 * The owner check and the delete are two statements, so a relaunch landing between
 * them can still lose its window; that is the documented residual race of the
 * original file path too (see `withFleetLaunchMarker`), and closing it needs a
 * conditional DELETE the store does not expose yet.
 */
export function clearFleetLaunchMarker(options: {
  gitCommonDir: string;
  fleetId: string;
  taskId: string;
  owner: string;
  fs?: FleetStateFs;
}): { ok: true } | { ok: false; error: string } {
  const refusal = fleetLaunchMarkerTaskIdRefusal(options.taskId);
  if (refusal !== undefined) return { ok: false, error: refusal };
  const store = fleetStoreFor(options);
  if (store === null) {
    return { ok: false, error: "the repository state store is unavailable" };
  }
  const stored = store.readLaunchMarker(options.taskId);
  if (!stored.ok) return { ok: false, error: stored.error };
  if (stored.value === null) return { ok: true };
  const onDisk = parseFleetLaunchMarker(stored.value);
  if (onDisk?.owner !== options.owner) {
    return {
      ok: false,
      error:
        `the marker on disk belongs to another spawn (owner ${onDisk?.owner ?? "absent"}), ` +
        "so this spawn's clear left it in place",
    };
  }
  const cleared = store.clearLaunchMarker(options.taskId);
  return cleared.ok ? { ok: true } : { ok: false, error: cleared.error };
}

/**
 * The interval handle the configured timer returns (`number` under a DOM lib,
 * `Timeout` under Node), so the seam needs no cast either way.
 */
type FleetTimerHandle = ReturnType<typeof setInterval>;

/**
 * Clear one interval handle.
 *
 * The project's lib set types the handle as `number | Timeout`, and whichever
 * implementation produced it, `clearInterval` accepts it: no per-shape branch is
 * needed.
 */
function clearTimerHandle(handle: FleetTimerHandle): void {
  clearInterval(handle);
}

/**
 * Run one member spawn inside a launch marker (bd-233).
 *
 * The one helper every member-spawn path goes through, so none of them can forget
 * the window: `belayd_fleet_launch`, `belayd_fleet_advance`, and any run-loop
 * relaunch all reach `launchWorktreeWorkflow` through this wrapper. The marker is
 * removed in a `finally`, so a thrown launch can neither leak it nor keep a dead
 * member's slot held; it also covers the failure path, where the member is pruned
 * from the intent by the engine and nothing should look "in flight" any more.
 *
 * The marker is refreshed for as long as the spawn lives, so the grace measures "no
 * refresh for a full grace", not "the spawn began more than a grace ago": a cold
 * `wt switch`/install or a slow daemon RPC legitimately outlives the declared waits,
 * and its member must stay counted (never `absent`, so never pruned) meanwhile. The
 * timer is unref'd and local to this call, and cleared in the `finally`.
 *
 * Every spawn mints its own `owner` token. It is written into every refresh and is
 * required by the clear, so a slow spawner whose marker was overwritten by a relaunch
 * cannot delete the newer spawn's window (bd-233 round 4).
 *
 * Residual race, documented not hidden (the `updateFleetIntent` W6 precedent): the
 * refresh's owner check is check-then-write, not atomic. A refresh can read `owner: A`,
 * then B's initial write lands, then A's refresh rewrites A's token over B's fresh
 * marker; B then refuses its own clear and stops refreshing, so B's window reverts to a
 * fixed grace while B still runs. Closing the gap needs an atomic primitive (an
 * `O_EXCL` sidecar), not another check here, and it is reachable only in an
 * already-degraded double-spawn.
 *
 * A marker that cannot be written refuses the spawn: without it a concurrent
 * recount could classify the member `absent` while its worktree is being created,
 * so the safe direction is to start nothing.
 */
export async function withFleetLaunchMarker<T>(options: {
  gitCommonDir: string;
  fleetId: string;
  taskId: string;
  now: number;
  /** Clock for the refreshes; the cadence is the module constant. */
  clock?: () => number;
  /** Timer seam so a test can drive the cadence without a real wait. */
  setIntervalFn?: (callback: () => void, intervalInMs: number) => FleetTimerHandle;
  clearIntervalFn?: (handle: FleetTimerHandle) => void;
  fs?: FleetStateFs;
  spawn: () => Promise<T>;
}): Promise<{ ok: true; value: T; warning?: string } | { ok: false; error: string }> {
  // Per-spawn, not per-member: a relaunch must be a different owner so the old
  // spawn's clear cannot erase the new window.
  const owner = randomUUID();
  const writeMarker = (now: number) =>
    writeFleetLaunchMarker({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
      taskId: options.taskId,
      now,
      owner,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
  const written = writeMarker(options.now);
  if (!written.ok) {
    return {
      ok: false,
      error:
        `could not record the spawn window for ${options.taskId} (${written.error}), so it was ` +
        "not spawned: an unrecorded spawn could be counted as absent mid-flight",
    };
  }
  const clock = options.clock ?? Date.now;
  const setIntervalFn =
    options.setIntervalFn ??
    ((callback: () => void, intervalInMs: number): FleetTimerHandle =>
      setInterval(callback, intervalInMs));
  const clearIntervalFn = options.clearIntervalFn ?? clearTimerHandle;
  let refreshFailures = 0;
  let lastRefreshFailure: { at: number; error: string } | undefined;
  // Set once the marker is no longer ours: rewriting it would steal a newer spawn's
  // window, and this spawn's later clear would then delete that window.
  let markerNotOurs = false;
  const refresh = setIntervalFn(() => {
    if (markerNotOurs) return;
    const onDisk = readFleetLaunchMarker({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
      taskId: options.taskId,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
    if (onDisk?.owner !== owner) {
      markerNotOurs = true;
      refreshFailures += 1;
      lastRefreshFailure = {
        at: clock(),
        error: `the marker belongs to ${onDisk?.owner === undefined ? "nobody (absent or unreadable)" : `another spawn (owner ${onDisk.owner})`}, so this spawn stopped refreshing it`,
      };
      console.warn(`[belayd-harness] ${lastRefreshFailure.error}`);
      return;
    }
    const rewritten = writeMarker(clock());
    if (!rewritten.ok) {
      // A failing refresh degrades the sliding window to a fixed one: the member is
      // protected only until a grace after the last successful stamp, even though the
      // spawn is still live. That is reported on the spawn outcome below (not only
      // here), so the launch report can warn instead of the protection silently
      // weakening (bd-233 round 4 W1).
      refreshFailures += 1;
      lastRefreshFailure = { at: clock(), error: rewritten.error };
      console.warn(
        `[belayd-harness] could not refresh the spawn marker for ${options.taskId}: ` +
          `${rewritten.error}; its slot frees one grace after the last successful write`,
      );
    }
  }, FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS);
  // `number` handles only exist under a DOM lib; Node's own handle is unref'd so a
  // spawn in flight never keeps the process alive by itself.
  if (typeof refresh !== "number") refresh.unref();
  const warnings: string[] = [];
  let value: T;
  try {
    value = await options.spawn();
  } finally {
    clearIntervalFn(refresh);
    const cleared = clearFleetLaunchMarker({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
      taskId: options.taskId,
      owner,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
    if (!cleared.ok) {
      // Best effort: a leaked marker expires with the grace window, so the slot is
      // delayed at worst, never held forever. A refusal is the two-spawner case: the
      // newer spawn owns the marker now, and this clear must not delete it.
      const clearWarning =
        `the spawn marker for ${options.taskId} could not be cleared (${cleared.error}); the ` +
        "member keeps its slot until the grace expires, then its own git evidence decides";
      warnings.push(clearWarning);
      console.warn(`[belayd-harness] ${clearWarning}`);
    }
  }
  if (lastRefreshFailure !== undefined) {
    warnings.unshift(
      `spawn window protection degraded for ${options.taskId}: ${refreshFailures} marker ` +
        `refresh attempt(s) failed, last at ${new Date(lastRefreshFailure.at).toISOString()} ` +
        `(${lastRefreshFailure.error}); the member holds its slot only until one grace after ` +
        "the last successful stamp",
    );
  }
  return warnings.length === 0
    ? { ok: true, value }
    : { ok: true, value, warning: warnings.join("; ") };
}

// ── Mailbox (store notes) ─────────────────────────────────────────────

/**
 * Which mailbox a note belongs to.
 *
 * `event` is supervisor → member (drained at the member's turn start), `inbox` is
 * member → supervisor. The names match `fleet_note.channel`; the tool's `channel`
 * parameter still spells the first one `events`, because that is the word the
 * operator-facing documentation and the old directory used.
 */
export type FleetNoteChannel = "event" | "inbox";

export const FLEET_NOTE_KINDS = [
  "note",
  "rebase-hint",
  "base-moved",
  "sibling-landed",
  "pause",
  "resume",
  // bd-277: the supervisor's ask to repair a refused landing, delivered to a member
  // whose orchestrator is still live (a relaunch of its worktree would be refused by
  // the one-orchestrator-per-worktree lease).
  "land-repair",
] as const;

export type FleetNoteKind = (typeof FLEET_NOTE_KINDS)[number];

/**
 * Real type guard for a note kind, so callers never narrow with a cast.
 *
 * The project bans `as` narrowing; a tool parameter arrives as `string`, so the
 * only honest way to reach {@link FleetNoteKind} is to check membership. This is
 * also the read-side guard: a row whose kind this version does not know is reported
 * and left queued rather than rendered as something it is not.
 */
export function isFleetNoteKind(value: unknown): value is FleetNoteKind {
  return typeof value === "string" && FLEET_NOTE_KINDS.some((kind) => kind === value);
}

/** Characters of a note body kept; truncation is the only repair a write makes. */
export const FLEET_NOTE_BODY_MAX_LENGTH = 2_000;

/**
 * Characters kept in a note's `to`/`from` address.
 *
 * Real addresses are task ids (`bd-12`, `supervisor`), so 128 characters is ~10x
 * any legitimate value. The bound exists because the address is now a row value an
 * arbitrary number of readers render, not a path component: an unbounded address
 * would let one note bloat every drain of its mailbox, which is why it is refused at
 * insert instead of repaired.
 */
export const FLEET_NOTE_ADDRESS_MAX_LENGTH = 128;

/**
 * Note records version independently of the intent: bumping the intent schema must
 * not make every queued note unreadable.
 *
 * The in-memory `FleetNote` keeps the field so the pure mailbox layer (and its
 * tests) stay one shape; a stored row no longer carries a per-note version, because
 * the store's own `PRAGMA user_version` is the schema that applies to every row.
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

/** Parse a note record; anything not matching the contract yields undefined. */
export function parseFleetNote(raw: unknown): FleetNote | undefined {
  const result = FleetNoteSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** First few schema issues, for an error a caller can actually act on. */
function summarizeIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
  return issues.join("; ");
}

/**
 * Validate the note that will be stored, repairing only the body.
 *
 * `createdAt` and both addresses are validated, never coerced or trusted: they are
 * row values every later drain reads back and renders, so a runtime non-number or an
 * over-long address would be stored garbage. Truncation is the one documented
 * repair, because a long report is still useful mail.
 *
 * **A malformed note is rejected here, at insert.** The file store inspected each
 * note file at drain time and quarantined an unparseable one by renaming it to
 * `<name>.corrupt`; the row store has no `.corrupt` analogue, and silently dropping a
 * row is not an acceptable replacement — so the refusal happens before the row
 * exists and there is nothing left to quarantine on the read side.
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

export interface EnqueueNoteOptions extends FleetIntentOptions {
  channel: FleetNoteChannel;
  /** The note as the caller built it: `to` is the stored target, `from` the author. */
  note: FleetNote;
}

export type EnqueueNoteResult =
  | { ok: true; seq: number }
  | {
      ok: false;
      error: string;
      /**
       * `invalid-note` is the caller's input; `write-failed` is the store (which
       * includes "store unavailable"). Kept so a caller can tell a rejected note
       * from a database it should retry or report.
       */
      reason: "invalid-note" | "write-failed";
    };

/**
 * Store one note and its audit line in the same transaction.
 *
 * Identity is the row (`fleet_id`, `channel`, `target`, autoincrement `seq`), never
 * a directory: a handoff or a resumed session in another worktree resolves the same
 * rows instead of carrying a copy of somebody else's mail.
 *
 * A repeated enqueue is a second delivery, not a no-op. The old file store
 * deduplicated identical content through its content-addressed filename; with rows
 * the at-least-once contract already requires a consumer to treat a repeat as the
 * same event, so nothing depends on that dedup.
 */
export function enqueueNote(options: EnqueueNoteOptions): EnqueueNoteResult {
  const normalized = normalizeNoteForWrite(options.note);
  if (!normalized.ok) return { ok: false, error: normalized.error, reason: "invalid-note" };
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return {
      ok: false,
      error: `fleet ${fleetId}: the repository state store is unavailable`,
      reason: "write-failed",
    };
  }
  const note = normalized.note;
  // The note's own instant is the row's `created_at`: one timestamp, so a drained
  // note is the note that was written rather than a copy stamped at insert time.
  const atMs = note.createdAt;
  const written = store.enqueueNote({
    fleetId,
    channel: options.channel,
    target: note.to,
    from: note.from,
    kind: note.kind,
    body: note.body,
    // The audit entry travels with the insert, so the two commit together: a queued
    // note always has its witness, and a rolled-back insert leaves no audit claim.
    audit: boundAuditEntry({
      timestamp: atMs,
      fleetId,
      actor: note.from,
      action: "note",
      taskIds: [note.to],
      detail: `${options.channel} ${note.kind}`,
    }),
    nowMs: atMs,
  });
  return written.ok
    ? { ok: true, seq: written.note.seq }
    : { ok: false, error: written.error, reason: written.reason };
}

export interface EnqueueNoteFanoutOptions extends FleetIntentOptions {
  channel: FleetNoteChannel;
  /** Note template; `to` is replaced per recipient. */
  note: FleetNote;
  /** One row per recipient, in the order given. */
  recipients: readonly string[];
}

export type EnqueueNoteFanoutResult =
  | { ok: true; seqs: readonly number[]; recipients: readonly string[] }
  | {
      ok: false;
      error: string;
      /** Seqs stored before the failure. */
      written: readonly number[];
      /**
       * Recipients whose note row was actually written, in write order.
       *
       * This is what the audit records: a partial fan-out that logged the
       * request instead would claim mail landed with members it never reached.
       */
      writtenRecipients: readonly string[];
    };

/**
 * Write one note **per recipient** (fan-out).
 *
 * A single `to: "all"` row cannot represent a broadcast honestly: every member would
 * match it, the first drainer would ack it, and the siblings would never see it.
 * Per-recipient rows are what the drain/ack protocol can actually deliver — each
 * member selects and acks only its own row.
 *
 * A partial fan-out is reported as a failure that names what was written, so the
 * caller can audit exactly which members were reached rather than claiming the
 * whole broadcast landed.
 */
export function enqueueNoteFanout(options: EnqueueNoteFanoutOptions): EnqueueNoteFanoutResult {
  const written: number[] = [];
  const writtenRecipients: string[] = [];
  for (const recipient of options.recipients) {
    const enqueued = enqueueNote({ ...options, note: { ...options.note, to: recipient } });
    if (!enqueued.ok) {
      return {
        ok: false,
        error: `${enqueued.error} (fan-out stopped at ${recipient})`,
        written,
        writtenRecipients,
      };
    }
    written.push(enqueued.seq);
    writtenRecipients.push(recipient);
  }
  return { ok: true, seqs: written, recipients: writtenRecipients };
}

/** A drained note plus its row seq; the seq is the ack handle. */
export interface FleetNoteDelivery {
  note: FleetNote;
  seq: number;
}

export interface DrainNotesOptions extends FleetIntentOptions {
  channel: FleetNoteChannel;
  /** Only notes addressed to this target. Omit to read the whole mailbox. */
  target?: string;
}

export type DrainNotesResult =
  | { ok: true; deliveries: readonly FleetNoteDelivery[]; warnings: readonly string[] }
  | { ok: false; error: string };

/** Rebuild the in-memory note from its row; undefined when the kind is unknown. */
function deliveryFromRow(row: RepoFleetNote): FleetNoteDelivery | undefined {
  // A kind this version does not know cannot be rendered as a known notification.
  // It stays queued (drain never deletes) and is reported, so a future reader or the
  // operator can still act on it.
  if (!isFleetNoteKind(row.kind)) return undefined;
  return {
    seq: row.seq,
    note: {
      schemaVersion: FLEET_NOTE_SCHEMA_VERSION,
      kind: row.kind,
      from: row.from,
      to: row.target,
      body: row.body,
      createdAt: row.createdAt,
    },
  };
}

/**
 * Read the pending notes of one mailbox (rows in `seq` order, i.e. enqueue order).
 *
 * **Drain marks delivery and deletes nothing.** A note leaves the pending set only
 * through {@link ackNotes}, after the caller has consumed it. Deleting inside drain
 * would lose a note whose consumer died before using it; the price of never losing a
 * note is at-least-once delivery, so a caller must treat a repeated note as the same
 * event, never as a new one.
 *
 * `warnings` is retained (and is normally empty) because the renderer is shared with
 * the pure mailbox layer that can still have something to report. A row store cannot
 * quarantine: a malformed note is refused at insert, so a drain has no corrupt row to
 * find.
 */
export function drainNotes(options: DrainNotesOptions): DrainNotesResult {
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return { ok: false, error: `fleet ${fleetId}: the repository state store is unavailable` };
  }
  const read = store.drainNotes({
    fleetId,
    channel: options.channel,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.now === undefined ? {} : { nowMs: options.now }),
  });
  if (!read.ok) return { ok: false, error: read.error };

  const deliveries: FleetNoteDelivery[] = [];
  const warnings: string[] = [];
  for (const row of read.value) {
    const delivery = deliveryFromRow(row);
    if (delivery === undefined) {
      warnings.push(`note ${row.seq} has an unknown kind (${row.kind}); left queued`);
      continue;
    }
    deliveries.push(delivery);
  }
  return { ok: true, deliveries, warnings };
}

export interface AckNotesOptions extends FleetIntentOptions {
  deliveries: readonly FleetNoteDelivery[];
}

export type AckNotesResult =
  | { ok: true; acked: readonly number[] }
  | {
      ok: false;
      error: string;
      /** Seqs this call already acknowledged (none: a failed ack rolls back). */
      acked: readonly number[];
      /** Deliveries still queued: they will be delivered again. */
      remaining: readonly FleetNoteDelivery[];
    };

/**
 * Acknowledge consumed notes by row seq.
 *
 * Idempotent and tolerant: an already-acked seq changes nothing and is not an error,
 * so a crash between drain and ack replays the note on the next turn instead of
 * losing it. Every seq lands in one transaction, and the UPDATE is scoped by the
 * fleet id, so a seq belonging to another fleet is never acknowledged (that is the
 * old path-containment check, expressed as the row key it now is).
 *
 * A refused ack reports every delivery as still queued: nothing was committed, and
 * the caller renders what it consumed either way.
 */
export function ackNotes(options: AckNotesOptions): AckNotesResult {
  if (options.deliveries.length === 0) return { ok: true, acked: [] };
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return {
      ok: false,
      error: `fleet ${fleetId}: the repository state store is unavailable`,
      acked: [],
      remaining: options.deliveries,
    };
  }
  const acked = store.ackNotes({
    fleetId,
    seqs: options.deliveries.map((delivery) => delivery.seq),
    ...(options.now === undefined ? {} : { nowMs: options.now }),
  });
  if (!acked.ok) {
    return { ok: false, error: acked.error, acked: [], remaining: options.deliveries };
  }
  return { ok: true, acked: acked.value.seqs };
}

// ── merge queue + single-flight lock (store rows) ─────────────────────

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
  /**
   * When the drain handed this entry's rebase conflict to the member itself
   * (bd-280), in epoch ms.
   *
   * It is what stops a re-drain with no new information: while the member's branch
   * does not yet contain the base, a land attempt is a hold, not a retry against an
   * unchanged base. Cleared by the next `rebasing` transition.
   */
  delegatedAt: z.number().finite().optional(),
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

/**
 * The lock view of a queue record, reconstructed from the `fleet_lock` row.
 *
 * A queue record no longer stores the lock: single-flight is that row, and a copy
 * inside the queue document would be a second authority a release could miss.
 * Readers still receive the composed record because every consumer (and the pure
 * `canAcquireFleetMerge` predicate) speaks the one shape.
 */
function queueWithLock(
  queue: FleetMergeQueue | undefined,
  lock: RepoFleetLock | null,
): FleetMergeQueue | undefined {
  const lockView: FleetMergeLock | null =
    lock === null
      ? null
      : {
          holder: lock.holder,
          taskId: lock.taskId,
          pid: lock.pid,
          acquiredAt: lock.acquiredAt,
          leaseExpiresAt: lock.expiresAt,
        };
  // A lock row without a queue row is a real state (a drain claims the lock before
  // any entry exists, and releasing the last entry can empty the queue). The lock is
  // the fact that matters, so the view materializes an empty queue around it instead
  // of reporting "no queue" and hiding a merge in flight.
  if (queue === undefined) {
    if (lockView === null) return undefined;
    return { ...createFleetMergeQueue(lockView.acquiredAt), lock: lockView };
  }
  return { ...queue, lock: lockView };
}

/** One stored queue row plus the lock row that shares its fleet id. */
type FleetMergeQueueRowLoad =
  | {
      ok: true;
      revision: number | null;
      queue: FleetMergeQueue | undefined;
      lock: RepoFleetLock | null;
    }
  | { ok: false; reason: "corrupt-merge-queue" | "read-failed"; error: string };

function readFleetMergeQueueRow(options: FleetIntentOptions): FleetMergeQueueRowLoad {
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return {
      ok: false,
      reason: "read-failed",
      error: `fleet ${fleetId}: the repository state store is unavailable`,
    };
  }
  const row = store.readFleetQueue(fleetId);
  if (!row.ok) return { ok: false, reason: "read-failed", error: row.error };
  // The lock row is read even when the queue row is absent: a drain claims the lock
  // before any entry exists, and that state must still be visible.
  const lock = store.readFleetLock(fleetId);
  if (!lock.ok) return { ok: false, reason: "read-failed", error: lock.error };
  if (row.value === null) {
    return { ok: true, revision: null, queue: undefined, lock: lock.value };
  }
  const queue = parseFleetMergeQueue(row.value.queue);
  if (queue === undefined) {
    return {
      ok: false,
      reason: "corrupt-merge-queue",
      error: `fleet ${fleetId} queue row is not a merge queue`,
    };
  }
  return { ok: true, revision: row.value.revision, queue, lock: lock.value };
}

/** Read the queue; absent means "no queue yet". The lock comes from its own row. */
export function readFleetMergeQueue(options: FleetIntentOptions): FleetMergeQueueLoadResult {
  const loaded = readFleetMergeQueueRow(options);
  return loaded.ok ? { ok: true, queue: queueWithLock(loaded.queue, loaded.lock) } : loaded;
}

/**
 * Replace the stored queue, refusing a row it cannot read.
 *
 * Absence is writable; a present but unparsable row is refused for the same reason
 * the intent row is: replacing it would erase a newer schema's record. Mutations
 * should go through {@link updateFleetMergeQueue}. The lock column is always
 * written as null because the lock lives in its own row.
 */
export function writeFleetMergeQueue(options: WriteFleetMergeQueueOptions): FleetStateWriteResult {
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return { ok: false, error: `fleet ${fleetId}: the repository state store is unavailable` };
  }
  const current = readFleetMergeQueueRow(options);
  if (!current.ok) {
    return { ok: false, error: `refusing to replace unreadable merge queue: ${current.error}` };
  }
  const parsed = parseFleetMergeQueue(options.queue);
  if (parsed === undefined) return { ok: false, error: "refusing to write an invalid merge queue" };
  const written = store.writeFleetQueue({
    fleetId,
    queue: { ...parsed, lock: null },
    nowMs: options.now ?? Date.now(),
  });
  return written.ok ? { ok: true } : { ok: false, error: written.error };
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
 * Read-modify-write the queue with the store's revision compare.
 *
 * The queue has three independent writers (enqueue, lease renewal, entry state
 * transition), so a blind replace drops an update whenever two interleave. The
 * `WHERE revision = ?` in `updateFleetQueue` is the compare: a stale writer
 * commits nothing and sees a typed failure instead of silently losing the update.
 * This is **not** the file path's check-then-write race: the compare and the write
 * are one statement, so the previous "residual race" note (and the caller's retry
 * around it) is gone by construction.
 *
 * A missing row is the first write (revision 1); it is created rather than refused
 * because enqueue/lease are legitimately the first writers of a fresh fleet.
 */
export function updateFleetMergeQueue(
  options: UpdateFleetMergeQueueOptions,
): UpdateFleetMergeQueueResult {
  const fleetId = sanitizeFleetId(options.fleetId);
  const store = fleetStoreFor(options);
  if (store === null) {
    return {
      ok: false,
      reason: "read-failed",
      error: `fleet ${fleetId}: the repository state store is unavailable`,
    };
  }
  const before = readFleetMergeQueueRow(options);
  if (!before.ok) return before;

  const next = options.update(queueWithLock(before.queue, before.lock));
  const parsed = parseFleetMergeQueue(next);
  if (parsed === undefined) {
    return { ok: false, reason: "write-failed", error: "refusing to write an invalid merge queue" };
  }
  const nowMs = options.now ?? Date.now();
  if (before.revision === null) {
    const created = store.writeFleetQueue({ fleetId, queue: { ...parsed, lock: null }, nowMs });
    return created.ok
      ? { ok: true, queue: queueWithLock(parsed, before.lock) ?? parsed }
      : { ok: false, reason: "write-failed", error: created.error };
  }
  const written = store.updateFleetQueue({
    fleetId,
    expectedRevision: before.revision,
    queue: { ...parsed, lock: null },
    nowMs,
  });
  if (!written.ok) {
    return {
      ok: false,
      // The store compares the revision inside the UPDATE, so a row that still
      // exists is a concurrent write, not a broken store.
      reason: written.error.includes("revision conflict") ? "conflict" : "write-failed",
      error: written.error,
    };
  }
  return { ok: true, queue: queueWithLock(parsed, before.lock) ?? parsed };
}
