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

const SCHEMA_VERSION = 1;

const WorkflowStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  taskId: z.string(),
  workflowType: z.string(),
  branch: z.string(),
  originalCwd: z.string(),
  phaseOrder: z.array(z.string()),
  completedPhaseNames: z.array(z.string()),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

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
  fs?: WorkflowFs;
  now?: () => number;
}

export interface ClearWorkflowStateOptions {
  cwd: string;
  fs?: WorkflowFs;
}

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
 * Read-modify-write: replace only the completed phase list and `updatedAt`,
 * preserving identity fields (task, type, branch, cwd, startedAt).
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
    updatedAt: nowMs(options.now),
  };
  return writeWorkflowState({ cwd: options.cwd, state: updated, fs });
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
