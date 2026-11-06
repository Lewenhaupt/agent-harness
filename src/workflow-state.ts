/**
 * Belayd workflow state persistence (bd-281: in the shared repository store).
 *
 * The orchestrator keeps its gate state, completed phases, phase-session ledger
 * and review bookkeeping in the per-repository SQLite store
 * (`src/repo-state-store.ts`, `<git-common-dir>/belayd/state.sqlite`), keyed by
 * **task id**.
 *
 * This used to be `.belayd/workflow.json` inside the worktree, which is the
 * failure bd-165 recorded: a handoff or a resumed session carried a copy of the
 * file, so a new session read a dead workflow and claimed its dead orchestrator
 * lease. A row keyed by task id cannot be copied — two worktrees driving the same
 * task resolve the same row, and a stale record is visible from `updated_at` and
 * the row generation instead of being inferred from a file.
 *
 * The worktree path is still recorded (and a worktree -> task binding lets a
 * cwd-only caller find its row), but it is a *locator*, never identity.
 *
 * Kept as files, on purpose:
 *
 * - `.belayd/artifacts/` — phase deliverables injected into prompts (`src/artifacts.ts`).
 * - `.belayd/proof-dir` — the marker pi-web-plugins reads through the browser file
 *   API (see the SYNC WARNING in `src/proof-dir.ts`).
 *
 * The proof receipt is no longer one of them: bd-281 moved it into the same store,
 * which knowingly breaks the plugin's `.belayd/proof-receipt.json` reader until
 * bd-303 mirrors the row (see the SYNC WARNING in `src/proof-receipt.ts`).
 *
 * `atomicWriteJson`/`WorkflowFs` stay exported because unrelated runtime files
 * (`.belayd/handoff.json`, fleet notes as still staged) still use the atomic
 * write helper; nothing in this module touches the filesystem any more.
 */

import { join } from "node:path";
import { migrateAndGuardLegacyState } from "./repo-state-import.js";
import {
  type RepoStateStore,
  type RepoWorkflowState,
  sharedRepoStateStore,
} from "./repo-state-store.js";
import type { ReviewedUntrackedEntry } from "./review-context.js";
import type { PhaseSessionRecord } from "./session-naming.js";
import {
  type HandedOffMarker,
  parseHandedOffMarker,
  parseReviewScope,
  parseWorkflowState,
  type ReviewScope,
  WORKFLOW_STATE_SCHEMA_VERSION,
  type WorkflowState,
} from "./workflow-state-record.js";

// The crash-safe JSON write and its fs seam stay available from here: unrelated
// runtime files (handoff packets, telemetry) still use them, and moving the
// import path would be a wider change than this bead. They are state-free.
export { atomicWriteJson, type WorkflowFs } from "./atomic-json-file.js";

// The record shapes, parsers and the claimability decision are re-exported so
// this module keeps its public surface while the importer can validate a legacy
// file without importing the store wiring.
export {
  classifyWorkflowClaimability,
  type HandedOffMarker,
  parseHandedOffMarker,
  parseReviewScope,
  parseWorkflowState,
  type ReviewScope,
  WORKFLOW_STATE_SCHEMA_VERSION,
  type WorkflowClaimability,
  type WorkflowState,
} from "./workflow-state-record.js";

/**
 * Test seam shared by every workflow helper: pass an opened store instead of the
 * module's shared one. Production callers omit it.
 */
export interface WorkflowStoreSeam {
  store?: RepoStateStore;
  /**
   * Identity of the workflow row. Identity is the *task*, never the worktree
   * path: pass this when the caller knows the task (a resumed session in another
   * worktree) so it resolves the same row instead of a copy. Omitted, the row is
   * located through the worktree -> task binding, falling back to the worktree
   * the record was started in.
   */
  taskId?: string;
}

export interface ReadWorkflowStateOptions extends WorkflowStoreSeam {
  cwd: string;
  /** Epoch-ms clock (test seam). Defaults to Date.now. */
  now?: () => number;
}

export interface WriteWorkflowStateOptions extends WorkflowStoreSeam {
  cwd: string;
  state: WorkflowState;
}

export interface SaveCompletedPhasesOptions extends WorkflowStoreSeam {
  cwd: string;
  completedPhaseNames: string[];
  /**
   * When provided, persisted alongside the phase list. When omitted, the value
   * already stored is preserved (see the `?? existing.awaitingReviewResponse`
   * fallback in saveCompletedPhases), so a caller that only updates the phase
   * list never clears the flag.
   */
  awaitingReviewResponse?: boolean;
  now?: () => number;
}

export interface SavePhaseSessionOptions extends WorkflowStoreSeam {
  cwd: string;
  phaseName: string;
  record: PhaseSessionRecord;
  now?: () => number;
  /**
   * Pre-read workflow state. The caller already read it to validate the task
   * id, so passing it here avoids a second store read.
   */
  existingState?: WorkflowState;
}

export interface ClearWorkflowStateOptions extends WorkflowStoreSeam {
  cwd: string;
}

export interface SaveHandedOffMarkerOptions extends WorkflowStoreSeam {
  cwd: string;
  marker: HandedOffMarker;
  now?: () => number;
}

export interface ClearHandedOffMarkerOptions extends WorkflowStoreSeam {
  cwd: string;
  now?: () => number;
}

export interface CallerHandoffOptions extends WorkflowStoreSeam {
  cwd: string;
  /** The caller's own pi session id (the owner of the marker row). */
  sessionKey: string;
  now?: () => number;
}

export interface WriteCallerHandoffOptions extends CallerHandoffOptions {
  marker: HandedOffMarker;
}

export interface SaveReviewedShaOptions extends WorkflowStoreSeam {
  cwd: string;
  sha: string;
  /**
   * Untracked paths the review covered, hashed at review time. Written in the
   * same read-modify-write as `sha` so the pair can never disagree; omitted or
   * empty clears the manifest, so a caller that records a sha alone never
   * leaves a stale manifest behind to narrow a review (bd-228).
   */
  untracked?: readonly ReviewedUntrackedEntry[];
  /**
   * Task id the caller expects the stored workflow to belong to. The check runs
   * inside the same transaction as the write, so a state swap during an earlier
   * await cannot redirect this task's sha into another task's record.
   * Omit to skip the identity check.
   */
  expectedTaskId?: string;
  now?: () => number;
}

/**
 * Distinct failure reasons so callers can keep the benign missing-state case
 * silent while surfacing a cross-task write as an observable incident.
 */
export type SaveReviewedShaResult =
  | { ok: true }
  | { ok: false; reason: "missing-state"; error: string }
  | { ok: false; reason: "task-mismatch"; actualTaskId: string; error: string }
  | { ok: false; reason: "write-failed"; error: string };

export interface SaveReviewScopeOptions extends WorkflowStoreSeam {
  cwd: string;
  taskId: string;
  sha: string;
  untracked: readonly ReviewedUntrackedEntry[];
  now?: () => number;
}

export interface ReadReviewScopeOptions extends WorkflowStoreSeam {
  cwd: string;
  taskId: string;
}

export interface ClearReviewScopeOptions extends WorkflowStoreSeam {
  cwd: string;
  taskId: string;
}

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

/**
 * The directory the harness reserves for its own files. Still meaningful: it
 * holds artifacts, the proof-dir marker, the proof receipt and the rendered
 * review findings, and it is what the git ignore and the publish gate match on.
 */
export function workflowStateDir(cwd: string): string {
  return join(cwd, ".belayd");
}

/**
 * The retired workflow state file path.
 *
 * Kept because the migration refusal, the publish gate and diagnostics name it;
 * nothing reads or writes it any more (bd-281).
 */
export function workflowStateFilePath(cwd: string): string {
  return join(cwd, ".belayd", "workflow.json");
}

/**
 * Retired caller-scoped handoff marker path.
 *
 * The marker now lives in the `workflow_handoff` table keyed by (worktree,
 * session key). Kept for the same reasons as {@link workflowStateFilePath}.
 */
export function callerHandoffFilePath(cwd: string, sessionKey: string): string {
  const safeKey = sessionKey.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(cwd, ".belayd", `handoff-${safeKey}.json`);
}

/** Retired pending review scope path (bd-228); the scope is a store row now. */
export function reviewScopeFilePath(cwd: string): string {
  return join(cwd, ".belayd", "review-scope.json");
}

/**
 * The store for one worktree, or null when it cannot be opened.
 *
 * A store failure is not a workflow failure: every caller keeps working and
 * reports "no state", exactly as the file version did for a missing file.
 *
 * The first access in a worktree also runs the one-shot legacy import (bd-281).
 * Doing it here rather than in an operator command is what makes a live worktree
 * keep its workflow across the upgrade, and it is what makes a legacy file that
 * appears *afterwards* a loud refusal instead of silently authoritative state.
 * The once-per-worktree guard lives in the migration module, next to the fleet
 * half's guard, so there is one set rather than one per caller.
 */
function storeFor(options: WorkflowStoreSeam & { cwd: string }): RepoStateStore | null {
  if (options.store !== undefined) return options.store;
  const store = sharedRepoStateStore({ cwd: options.cwd }).store;
  if (store === null) return null;
  migrateAndGuardLegacyState({
    cwd: options.cwd,
    store,
    onImported: (summary) => {
      console.warn(
        `belayd: bd-281 imported ${summary.imported} legacy workflow state file(s) from ${options.cwd} into the shared repository store`,
      );
    },
    onRefusal: (message) => console.warn(message),
  });
  return store;
}

/** The row locator: the task id when the caller knows it, else the worktree. */
function locatorFor(options: WorkflowStoreSeam & { cwd: string }): {
  taskId?: string;
  worktreePath?: string;
} {
  return options.taskId === undefined ? { worktreePath: options.cwd } : { taskId: options.taskId };
}

/** Map the store's typed row back to the persisted workflow record shape. */
function toWorkflowState(state: RepoWorkflowState): WorkflowState | undefined {
  return parseWorkflowState({ schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION, ...state });
}

/** Map a validated workflow record to the store's column view. */
function toRepoWorkflowState(state: WorkflowState): RepoWorkflowState {
  const { schemaVersion: _schemaVersion, ...rest } = state;
  return rest;
}

function missingStateError(cwd: string): string {
  return `No Belayd workflow state found in ${cwd}`;
}

/**
 * Read the current workflow state. Returns undefined when no state exists, the
 * store is unavailable, or the row does not parse.
 */
export function readWorkflowState(options: ReadWorkflowStateOptions): WorkflowState | undefined {
  const snapshot = readWorkflowStateSnapshot(options);
  return snapshot.kind === "ok" ? snapshot.state : undefined;
}

/** A workflow read that keeps "there is no record" apart from "the record is unreadable". */
export type WorkflowStateSnapshot =
  | { kind: "missing" }
  | { kind: "ok"; state: WorkflowState }
  | { kind: "unreadable"; error: string };

/**
 * Tri-state read for consumers that surface corruption (fleet status warns on a
 * member whose record does not parse) instead of folding it into "no state".
 */
export function readWorkflowStateSnapshot(
  options: ReadWorkflowStateOptions,
): WorkflowStateSnapshot {
  const store = storeFor(options);
  if (store === null) return { kind: "missing" };
  const row = store.readWorkflow(locatorFor(options));
  if (!row.ok) return { kind: "unreadable", error: row.error };
  if (row.value === null) return { kind: "missing" };
  const state = toWorkflowState(row.value.state);
  return state === undefined
    ? { kind: "unreadable", error: `workflow row for ${row.value.taskId} does not parse` }
    : { kind: "ok", state };
}

/** Persist the workflow record (upsert by task id); returns an error value instead of throwing. */
export function writeWorkflowState(
  options: WriteWorkflowStateOptions,
): { ok: true } | { ok: false; error: string } {
  const store = storeFor(options);
  if (store === null) {
    return { ok: false, error: `repo state store unavailable for ${options.cwd}` };
  }
  // The schema stays the validation boundary on the way in: an invalid record
  // must never become a row.
  const parsed = parseWorkflowState(options.state);
  if (parsed === undefined) {
    return { ok: false, error: `refusing to persist an invalid workflow state for ${options.cwd}` };
  }
  const written = store.writeWorkflow({
    state: toRepoWorkflowState(parsed),
    worktreePath: options.cwd,
    nowMs: parsed.updatedAt,
  });
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}

/**
 * Read-modify-write in one store transaction: `update` sees the row read inside
 * the same transaction, so two sessions cannot interleave a read and a write
 * (the file version had no compare-and-set at all).
 */
function mutateWorkflow(
  options: WorkflowStoreSeam & { cwd: string; now?: () => number },
  update: (
    current: WorkflowState | null,
  ) => { kind: "write"; state: WorkflowState } | { kind: "delete" },
):
  | { ok: true; value: WorkflowState | null }
  | { ok: false; reason: "missing-state" | "failed"; error: string } {
  const store = storeFor(options);
  if (store === null) {
    return {
      ok: false,
      reason: "failed",
      error: `repo state store unavailable for ${options.cwd}`,
    };
  }
  const atMs = nowMs(options.now);
  const result = store.mutateWorkflow({
    locator: locatorFor(options),
    worktreePath: options.cwd,
    nowMs: atMs,
    update: (current) => {
      const parsed = current === null ? null : (toWorkflowState(current.state) ?? null);
      if (current !== null && parsed === null) {
        return { kind: "conflict", error: `stored workflow for ${current.taskId} does not parse` };
      }
      const plan = update(parsed);
      if (plan.kind === "delete") return { kind: "delete" };
      const next = parseWorkflowState(plan.state);
      if (next === undefined) {
        return { kind: "conflict", error: `refusing to persist an invalid workflow state` };
      }
      return { kind: "write", state: toRepoWorkflowState({ ...next, updatedAt: atMs }) };
    },
  });
  if (!result.ok) return { ok: false, reason: "failed", error: result.error };
  switch (result.value.kind) {
    case "missing":
      return { ok: false, reason: "missing-state", error: missingStateError(options.cwd) };
    case "conflict":
      return { ok: false, reason: "failed", error: result.value.error };
    case "deleted":
      return { ok: true, value: null };
    case "unchanged": {
      const read = store.readWorkflow({ taskId: result.value.taskId });
      return {
        ok: true,
        value: read.ok && read.value !== null ? (toWorkflowState(read.value.state) ?? null) : null,
      };
    }
    case "written":
      return { ok: true, value: toWorkflowState(result.value.state) ?? null };
    case "task-mismatch":
      return {
        ok: false,
        reason: "failed",
        error: `workflow state belongs to task ${result.value.actualTaskId}`,
      };
  }
}

/**
 * Read-modify-write: replace only the completed phase list, the optional
 * awaiting-review flag, and `updatedAt`, preserving identity fields (task,
 * type, branch, cwd, startedAt) and the phase-session ledger.
 */
export function saveCompletedPhases(
  options: SaveCompletedPhasesOptions,
): { ok: true } | { ok: false; error: string } {
  const result = mutateWorkflow(options, (current) => {
    if (current === null) return { kind: "delete" };
    return {
      kind: "write",
      state: {
        ...current,
        completedPhaseNames: [...options.completedPhaseNames],
        awaitingReviewResponse: options.awaitingReviewResponse ?? current.awaitingReviewResponse,
      },
    };
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Read-modify-write: upsert one phase's session ledger entry and `updatedAt`,
 * preserving every identity field and the other phases' entries. Mirrors
 * saveCompletedPhases so the persisted handle survives orchestrator restarts.
 */
export function savePhaseSession(
  options: SavePhaseSessionOptions,
): { ok: true } | { ok: false; error: string } {
  const result = mutateWorkflow(options, (current) => {
    // The caller may have read the state before an await; its own snapshot wins
    // only when the store has no row, which is the "first invocation" case.
    const base = current ?? options.existingState;
    if (base === null || base === undefined) return { kind: "delete" };
    return {
      kind: "write",
      state: {
        ...base,
        phaseSessions: {
          ...(base.phaseSessions ?? {}),
          [options.phaseName]: {
            base: options.record.base,
            invocations: options.record.invocations,
          },
        },
      },
    };
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Read-modify-write: record the revision the latest review covered, the
 * untracked manifest that belongs to it, and `updatedAt`, preserving every
 * identity field, the phase ledger, and the awaiting-review flag. Mirrors
 * savePhaseSession so a re-review can still be scoped to the fix diff after an
 * orchestrator restart.
 */
export function saveReviewedSha(options: SaveReviewedShaOptions): SaveReviewedShaResult {
  const store = storeFor(options);
  if (store === null) {
    return {
      ok: false,
      reason: "write-failed",
      error: `repo state store unavailable for ${options.cwd}`,
    };
  }
  const atMs = nowMs(options.now);
  const result = store.mutateWorkflow({
    locator: locatorFor(options),
    worktreePath: options.cwd,
    nowMs: atMs,
    ...(options.expectedTaskId === undefined ? {} : { expectedTaskId: options.expectedTaskId }),
    update: (current) => {
      if (current === null) return { kind: "skip" };
      const existing = toWorkflowState(current.state);
      if (existing === undefined) {
        return {
          kind: "conflict",
          error: `stored workflow for ${current.taskId} does not parse`,
        };
      }
      const updated: WorkflowState = {
        ...existing,
        reviewedSha: options.sha,
        updatedAt: atMs,
      };
      // Delete rather than write `[]`: an absent manifest is the documented
      // "nothing was filtered" state, and an empty array would be a second shape
      // for the same thing.
      if (options.untracked !== undefined && options.untracked.length > 0) {
        updated.reviewedUntracked = options.untracked.map((entry) => ({
          path: entry.path,
          blob: entry.blob,
        }));
      } else {
        delete updated.reviewedUntracked;
      }
      return { kind: "write", state: updated };
    },
  });
  if (!result.ok) {
    return { ok: false, reason: "write-failed", error: result.error };
  }
  if (result.value.kind === "missing") {
    return { ok: false, reason: "missing-state", error: missingStateError(options.cwd) };
  }
  if (result.value.kind === "conflict") {
    return { ok: false, reason: "write-failed", error: result.value.error };
  }
  if (result.value.kind === "task-mismatch") {
    return {
      ok: false,
      reason: "task-mismatch",
      actualTaskId: result.value.actualTaskId,
      error: `Workflow state belongs to task ${result.value.actualTaskId}, not ${options.expectedTaskId}`,
    };
  }
  return { ok: true };
}

/**
 * Read-modify-write: record the handoff marker on the caller's own state,
 * preserving its identity fields and phase ledger. A missing state row is an
 * error: the caller was not driving a workflow, so there is nothing to mark and
 * the caller can rely on `clearWorkflowState` semantics instead.
 */
export function saveHandedOffMarker(
  options: SaveHandedOffMarkerOptions,
): { ok: true } | { ok: false; error: string } {
  const result = mutateWorkflow(options, (current) => {
    if (current === null) return { kind: "delete" };
    return { kind: "write", state: { ...current, handedOffTo: { ...options.marker } } };
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Read-modify-write: drop the handoff marker, keeping the workflow identity so a
 * session that starts a new task over the same state is not blocked by a stale
 * marker. A missing row is a no-op success.
 */
export function clearHandedOffMarker(
  options: ClearHandedOffMarkerOptions,
): { ok: true } | { ok: false; error: string } {
  const result = mutateWorkflow(options, (current) => {
    if (current === null) return { kind: "delete" };
    const next = { ...current };
    delete next.handedOffTo;
    return { kind: "write", state: next };
  });
  // A missing row is the documented no-op success: there is no marker to clear.
  if (!result.ok && result.reason === "missing-state") return { ok: true };
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Read the caller-scoped marker. Returns undefined when this session never
 * handed anything off (or the row does not parse).
 */
export function readCallerHandoff(options: CallerHandoffOptions): HandedOffMarker | undefined {
  const store = storeFor(options);
  if (store === null) return undefined;
  // The session key is what a restarting caller knows; the row's identity is
  // (task, session), never the worktree path.
  const row = store.readHandoff({ handoffKey: options.sessionKey });
  if (!row.ok) return undefined;
  return parseHandedOffMarker(row.value);
}

/**
 * Persist the handoff marker for one caller session. This is the authoritative
 * record when the child shares the caller's directory; callers must treat a
 * failure as a precondition failure and stay armed (a missing marker resurrects
 * the workflow on the next restart).
 */
export function writeCallerHandoff(
  options: WriteCallerHandoffOptions,
): { ok: true } | { ok: false; error: string } {
  const store = storeFor(options);
  if (store === null) {
    return { ok: false, error: `repo state store unavailable for ${options.cwd}` };
  }
  const written = store.writeHandoff({
    taskId: options.marker.taskId,
    handoffKey: options.sessionKey,
    worktreePath: options.cwd,
    marker: { ...options.marker },
    nowMs: nowMs(options.now),
  });
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}

/** Remove this caller's marker; a missing row is the expected success case. */
export function clearCallerHandoff(
  options: CallerHandoffOptions,
): { ok: true } | { ok: false; error: string } {
  const store = storeFor(options);
  if (store === null) {
    return { ok: false, error: `repo state store unavailable for ${options.cwd}` };
  }
  const cleared = store.clearHandoff({
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    handoffKey: options.sessionKey,
  });
  return cleared.ok ? { ok: true } : { ok: false, error: cleared.error };
}

/**
 * Read the pending review scope for one task. Returns undefined when nothing was
 * captured (or the record does not parse).
 *
 * The scope belongs to the task, not to the directory it was captured in: a review
 * resumed in another worktree promotes the same record instead of a copy (bd-281).
 */
export function readReviewScope(options: ReadReviewScopeOptions): ReviewScope | undefined {
  const store = storeFor(options);
  if (store === null) return undefined;
  const row = store.readReviewScope(options.taskId);
  if (!row.ok) return undefined;
  return parseReviewScope(row.value);
}

/**
 * Overwrite the pending review scope. Every review build writes this so only the
 * newest build's record can ever be promoted; a stale record from an earlier
 * failed review is replaced, not reused.
 */
export function saveReviewScope(
  options: SaveReviewScopeOptions,
): { ok: true } | { ok: false; error: string } {
  const store = storeFor(options);
  if (store === null) {
    return { ok: false, error: `repo state store unavailable for ${options.cwd}` };
  }
  const scope = {
    taskId: options.taskId,
    sha: options.sha,
    untracked: options.untracked.map((entry) => ({ path: entry.path, blob: entry.blob })),
    capturedAt: nowMs(options.now),
  };
  const written = store.writeReviewScope({
    taskId: options.taskId,
    worktreePath: options.cwd,
    scope,
    nowMs: scope.capturedAt,
  });
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}

/** Consume the pending review scope: a missing row is the expected success case. */
export function clearReviewScope(
  options: ClearReviewScopeOptions,
): { ok: true } | { ok: false; error: string } {
  const store = storeFor(options);
  if (store === null) return { ok: true };
  const cleared = store.clearReviewScope(options.taskId);
  return cleared.ok ? { ok: true } : { ok: false, error: cleared.error };
}

/** Remove the current workflow row, tolerating a missing row. */
export function clearWorkflowState(options: ClearWorkflowStateOptions): void {
  const store = storeFor(options);
  if (store === null) return;
  store.clearWorkflow({ worktreePath: options.cwd });
}

/**
 * Prefix of the retired archived (inert) workflow state file. Kept for the
 * migration refusal and for operator diagnostics of an old worktree.
 */
export const WORKFLOW_STATE_ARCHIVE_PREFIX = "workflow.stale-";

export interface ArchiveWorkflowStateOptions extends WorkflowStoreSeam {
  cwd: string;
  now?: () => number;
}

export type ArchiveWorkflowStateResult =
  | { ok: true; archived: boolean }
  | { ok: false; error: string };

/**
 * Discard an inert workflow record (bd-165).
 *
 * The file version renamed the record to `.belayd/workflow.stale-<ts>.json` to
 * keep it diagnosable. A copy of executable state is exactly the bug this change
 * removes, so the record is deleted instead: nothing reads it, and the shared
 * store keeps the row's own history (`updated_at`, generation, the archived
 * audit rows a fleet appends). There is no archive path to report — that field is
 * gone rather than returning a sentinel — so callers name the task instead.
 *
 * A missing row is a reported no-op (`archived: false`).
 */
export function archiveWorkflowState(
  options: ArchiveWorkflowStateOptions,
): ArchiveWorkflowStateResult {
  const store = storeFor(options);
  if (store === null) {
    return { ok: false, error: `repo state store unavailable for ${options.cwd}` };
  }
  const cleared = store.clearWorkflow({ worktreePath: options.cwd });
  if (!cleared.ok) return { ok: false, error: cleared.error };
  return { ok: true, archived: cleared.value.cleared };
}
