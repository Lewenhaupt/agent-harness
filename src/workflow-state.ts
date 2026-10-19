/**
 * Belayd workflow state persistence.
 *
 * The orchestrator keeps its gate state in a `.belayd/workflow.json` state
 * file that is updated after every completed phase. On session start the
 * orchestrator reads it back and resumes from the persisted phase list.
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { PhaseSessionRecord } from "./session-naming.js";

const SCHEMA_VERSION = 1;

const PhaseSessionRecordSchema = z.object({
  base: z.string(),
  invocations: z.number().int().positive(),
});

/**
 * Marker written into the *caller's* workflow state when it hands a workflow
 * off to an orchestrator session in another worktree. Its presence means the
 * caller no longer drives a workflow, so a restart must not re-arm its gate.
 */
const HandedOffMarkerSchema = z.object({
  taskId: z.string(),
  branch: z.string(),
  sessionId: z.string(),
});

const WorkflowStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  taskId: z.string(),
  workflowType: z.string(),
  // Provenance for the resolved type (bd-106). Optional so a workflow.json
  // written before this change still parses.
  resolutionSource: z.enum(["arg", "label", "default"]).optional(),
  matchedLabel: z.string().optional(),
  branch: z.string(),
  originalCwd: z.string(),
  phaseOrder: z.array(z.string()),
  completedPhaseNames: z.array(z.string()),
  // Optional so a workflow.json written before bd-81 still parses (undefined
  // ledger means every phase starts fresh on first invocation).
  phaseSessions: z.record(z.string(), PhaseSessionRecordSchema).optional(),
  // Optional so pre-bd-81 state parses; absent means the flag is derived from
  // the completed phase list on resume. Persisted so a late re-review after a
  // later phase completed still re-arms the resumable-fix directive.
  awaitingReviewResponse: z.boolean().optional(),
  // HEAD sha covered by the most recent completed review (bd-113). A re-review
  // diffs from here, so it sees only the fix round. Optional so a workflow.json
  // written before bd-113 still parses.
  reviewedSha: z.string().optional(),
  // Set when this session handed its workflow off to a child orchestrator
  // (see launchWorktreeWorkflow). Optional so every workflow.json written
  // before bd-120 still parses.
  handedOffTo: HandedOffMarkerSchema.optional(),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export type HandedOffMarker = z.infer<typeof HandedOffMarkerSchema>;

/**
 * Subset of node:fs sync operations workflow state persistence needs. Tests
 * inject an in-memory implementation; production uses the node:fs wrappers.
 */
export interface WorkflowFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string, options?: { flag?: string }): void;
  renameSync(oldPath: string, newPath: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
}

export interface ReadWorkflowStateOptions {
  cwd: string;
  fs?: WorkflowFs;
  /** Epoch-ms clock (test seam). Defaults to Date.now. */
  now?: () => number;
}

export interface WriteWorkflowStateOptions {
  cwd: string;
  state: WorkflowState;
  fs?: WorkflowFs;
}

export interface SaveCompletedPhasesOptions {
  cwd: string;
  completedPhaseNames: string[];
  /**
   * When provided, persisted alongside the phase list. When omitted, the value
   * already on disk is preserved (see the `?? existing.awaitingReviewResponse`
   * fallback in saveCompletedPhases), so a caller that only updates the phase
   * list never clears the flag.
   */
  awaitingReviewResponse?: boolean;
  fs?: WorkflowFs;
  now?: () => number;
}

export interface SavePhaseSessionOptions {
  cwd: string;
  phaseName: string;
  record: PhaseSessionRecord;
  fs?: WorkflowFs;
  now?: () => number;
  /**
   * Pre-read workflow state. The caller already read it to validate the task
   * id, so passing it here avoids a second synchronous disk read.
   */
  existingState?: WorkflowState;
}

export interface ClearWorkflowStateOptions {
  cwd: string;
  fs?: WorkflowFs;
}

export interface SaveHandedOffMarkerOptions {
  cwd: string;
  marker: HandedOffMarker;
  fs?: WorkflowFs;
  now?: () => number;
}

export interface ClearHandedOffMarkerOptions {
  cwd: string;
  fs?: WorkflowFs;
  now?: () => number;
}

export interface CallerHandoffOptions {
  cwd: string;
  /** The caller's own pi session id (the owner of the marker file). */
  sessionKey: string;
  fs?: WorkflowFs;
  now?: () => number;
}

export interface WriteCallerHandoffOptions extends CallerHandoffOptions {
  marker: HandedOffMarker;
}

export interface SaveReviewedShaOptions {
  cwd: string;
  sha: string;
  /**
   * Task id the caller expects the on-disk workflow.json to belong to. The
   * check runs against the read immediately preceding the write, so a state
   * swap during an earlier await cannot redirect this task's sha into another
   * task's state. Omit to skip the identity check.
   */
  expectedTaskId?: string;
  fs?: WorkflowFs;
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

const nodeFsSeam: WorkflowFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
  writeFileSync: (path, data, options) => nodeFs.writeFileSync(path, data, options),
  renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path, options),
  unlinkSync: (path) => nodeFs.unlinkSync(path),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

export function workflowStateDir(cwd: string): string {
  return join(cwd, ".belayd");
}

export function workflowStateFilePath(cwd: string): string {
  return join(cwd, ".belayd", "workflow.json");
}

/**
 * Caller-scoped handoff marker path.
 *
 * `.belayd/workflow.json` cannot carry the marker when the child orchestrator
 * runs in the caller's own directory: the child writes that file for its own
 * workflow and would clobber the marker. A file keyed by the *caller's* session
 * id is not owned by the child, so a resumed caller still learns that it no
 * longer drives a workflow (bd-120). The id is sanitized because external
 * session ids are not guaranteed to be filesystem-safe.
 */
export function callerHandoffFilePath(cwd: string, sessionKey: string): string {
  const safeKey = sessionKey.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(cwd, ".belayd", `handoff-${safeKey}.json`);
}

/**
 * Parse and strictly narrow a workflow state file. Corrupt JSON and a wrong
 * schema version both yield undefined — callers treat that as "no state".
 */
export function parseWorkflowState(raw: unknown): WorkflowState | undefined {
  const result = WorkflowStateSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

function readWorkflowStateFile(fs: WorkflowFs, cwd: string): WorkflowState | undefined {
  const filePath = workflowStateFilePath(cwd);
  if (!fs.existsSync(filePath)) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
  try {
    return parseWorkflowState(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Read the current workflow state. Returns undefined when no state exists or
 * when it is unreadable.
 */
export function readWorkflowState(options: ReadWorkflowStateOptions): WorkflowState | undefined {
  const fs = options.fs ?? nodeFsSeam;
  return readWorkflowStateFile(fs, options.cwd);
}

/**
 * Atomically write any JSON value: temp file in the target directory, then
 * rename over the target. Shared by workflow state and run manifests so both
 * get identical crash-safety semantics.
 */
export function atomicWriteJson(
  path: string,
  data: unknown,
  fs: WorkflowFs,
): { ok: true } | { ok: false; error: string } {
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, path);
    return { ok: true };
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Temp cleanup is best-effort; the original error is what matters.
    }
    return { ok: false, error: errorMessage(error) };
  }
}

/** Persist workflow state atomically; returns an error value instead of throwing. */
export function writeWorkflowState(
  options: WriteWorkflowStateOptions,
): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  return atomicWriteJson(workflowStateFilePath(options.cwd), options.state, fs);
}

/**
 * Read-modify-write: replace only the completed phase list, the optional
 * awaiting-review flag, and `updatedAt`, preserving identity fields (task,
 * type, branch, cwd, startedAt) and the phase-session ledger.
 */
export function saveCompletedPhases(
  options: SaveCompletedPhasesOptions,
): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  const existing = readWorkflowState({ cwd: options.cwd, fs, now: options.now });
  if (existing === undefined) {
    return { ok: false, error: `No Belayd workflow state found in ${options.cwd}` };
  }
  const updated: WorkflowState = {
    ...existing,
    completedPhaseNames: [...options.completedPhaseNames],
    awaitingReviewResponse: options.awaitingReviewResponse ?? existing.awaitingReviewResponse,
    updatedAt: nowMs(options.now),
  };
  return writeWorkflowState({ cwd: options.cwd, state: updated, fs });
}

/**
 * Read-modify-write: upsert one phase's session ledger entry and `updatedAt`,
 * preserving every identity field and the other phases' entries. Mirrors
 * saveCompletedPhases so the persisted handle survives orchestrator restarts.
 */
export function savePhaseSession(
  options: SavePhaseSessionOptions,
): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  const existing =
    options.existingState ?? readWorkflowState({ cwd: options.cwd, fs, now: options.now });
  if (existing === undefined) {
    return { ok: false, error: `No Belayd workflow state found in ${options.cwd}` };
  }
  const updated: WorkflowState = {
    ...existing,
    phaseSessions: {
      ...(existing.phaseSessions ?? {}),
      [options.phaseName]: {
        base: options.record.base,
        invocations: options.record.invocations,
      },
    },
    updatedAt: nowMs(options.now),
  };
  return writeWorkflowState({ cwd: options.cwd, state: updated, fs });
}

/**
 * Read-modify-write: record the revision the latest review covered and
 * `updatedAt`, preserving every identity field, the phase ledger, and the
 * awaiting-review flag. Mirrors savePhaseSession so a re-review can still be
 * scoped to the fix diff after an orchestrator restart.
 */
export function saveReviewedSha(options: SaveReviewedShaOptions): SaveReviewedShaResult {
  const fs = options.fs ?? nodeFsSeam;
  const existing = readWorkflowState({ cwd: options.cwd, fs, now: options.now });
  if (existing === undefined) {
    return {
      ok: false,
      reason: "missing-state",
      error: `No Belayd workflow state found in ${options.cwd}`,
    };
  }
  if (options.expectedTaskId !== undefined && existing.taskId !== options.expectedTaskId) {
    return {
      ok: false,
      reason: "task-mismatch",
      actualTaskId: existing.taskId,
      error: `Workflow state belongs to task ${existing.taskId}, not ${options.expectedTaskId}`,
    };
  }
  const updated: WorkflowState = {
    ...existing,
    reviewedSha: options.sha,
    updatedAt: nowMs(options.now),
  };
  const writeResult = writeWorkflowState({ cwd: options.cwd, state: updated, fs });
  if (!writeResult.ok) {
    return { ok: false, reason: "write-failed", error: writeResult.error };
  }
  return { ok: true };
}

/**
 * Read-modify-write: record the handoff marker on the caller's own state,
 * preserving its identity fields and phase ledger. A missing state file is an
 * error: the caller was not driving a workflow, so there is nothing to mark
 * and the caller can rely on `clearWorkflowState` semantics instead.
 */
export function saveHandedOffMarker(
  options: SaveHandedOffMarkerOptions,
): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  const existing = readWorkflowState({ cwd: options.cwd, fs, now: options.now });
  if (existing === undefined) {
    return { ok: false, error: `No Belayd workflow state found in ${options.cwd}` };
  }
  const updated: WorkflowState = {
    ...existing,
    handedOffTo: { ...options.marker },
    updatedAt: nowMs(options.now),
  };
  return writeWorkflowState({ cwd: options.cwd, state: updated, fs });
}

/**
 * Read-modify-write: drop the handoff marker, keeping the workflow identity so
 * a session that starts a new task over the same state is not blocked by a
 * stale marker. A missing state file is a no-op success.
 */
export function clearHandedOffMarker(
  options: ClearHandedOffMarkerOptions,
): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  const existing = readWorkflowState({ cwd: options.cwd, fs, now: options.now });
  if (existing === undefined) return { ok: true };
  const updated: WorkflowState = { ...existing, updatedAt: nowMs(options.now) };
  delete updated.handedOffTo;
  return writeWorkflowState({ cwd: options.cwd, state: updated, fs });
}

/** Parse a caller-scoped handoff marker file's contents. */
export function parseHandedOffMarker(raw: unknown): HandedOffMarker | undefined {
  const result = HandedOffMarkerSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

function readCallerHandoffFile(
  fs: WorkflowFs,
  cwd: string,
  sessionKey: string,
): HandedOffMarker | undefined {
  const filePath = callerHandoffFilePath(cwd, sessionKey);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return parseHandedOffMarker(JSON.parse(fs.readFileSync(filePath)));
  } catch {
    return undefined;
  }
}

/**
 * Read the caller-scoped marker. Returns undefined when this session never
 * handed anything off (or the file is unreadable/corrupt).
 */
export function readCallerHandoff(options: CallerHandoffOptions): HandedOffMarker | undefined {
  const fs = options.fs ?? nodeFsSeam;
  return readCallerHandoffFile(fs, options.cwd, options.sessionKey);
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
  const fs = options.fs ?? nodeFsSeam;
  return atomicWriteJson(
    callerHandoffFilePath(options.cwd, options.sessionKey),
    { ...options.marker },
    fs,
  );
}

/** Remove this caller's marker, tolerating a missing file; reports real errors. */
export function clearCallerHandoff(
  options: CallerHandoffOptions,
): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = callerHandoffFilePath(options.cwd, options.sessionKey);
  try {
    fs.unlinkSync(filePath);
    return { ok: true };
  } catch (error) {
    // A missing marker is the expected success case; only surface real errors.
    if (!fs.existsSync(filePath)) return { ok: true };
    return { ok: false, error: errorMessage(error) };
  }
}

/** Remove the current workflow state file, tolerating a missing file. */
export function clearWorkflowState(options: ClearWorkflowStateOptions): void {
  const fs = options.fs ?? nodeFsSeam;
  try {
    fs.unlinkSync(workflowStateFilePath(options.cwd));
  } catch {
    // Missing files are the expected success case.
  }
}
