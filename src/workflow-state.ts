/**
 * Belayd workflow state persistence.
 *
 * The orchestrator previously kept its gate state in a `.belayd-task.json`
 * file written once at workflow start. That file only recorded task identity,
 * so a crash lost which phases had already completed — the orchestrator would
 * restart the whole workflow from the first phase.
 *
 * This module replaces it with a `.belayd/workflow.json` state file that is
 * updated after every completed phase. On session start the orchestrator reads
 * it back and resumes from the persisted phase list.
 *
 * The legacy `.belayd-task.json` file is migrated one-shot at read time: the
 * first read converts it to the new shape, writes the new file atomically, and
 * deletes the legacy file so the migration never runs twice.
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";

import {
  getPhasesForType,
  isValidWorkflowType,
  type WorkflowSubType,
} from "./workflow-registry.js";

export interface WorkflowState {
  schemaVersion: 1;
  taskId: string;
  workflowType: string;
  branch: string;
  originalCwd: string;
  phaseOrder: string[];
  completedPhaseNames: string[];
  /** Epoch ms when the workflow was first started. */
  startedAt: number;
  /** Epoch ms of the last state write. */
  updatedAt: number;
}

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

const SCHEMA_VERSION = 1;

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

export function legacyTaskFilePath(cwd: string): string {
  return join(cwd, ".belayd-task.json");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parse and strictly narrow a workflow state file. Corrupt JSON and a wrong
 * schema version both yield undefined — callers treat that as "no state".
 */
export function parseWorkflowState(raw: unknown): WorkflowState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (typeof record.taskId !== "string") return undefined;
  if (typeof record.workflowType !== "string") return undefined;
  if (typeof record.branch !== "string") return undefined;
  if (typeof record.originalCwd !== "string") return undefined;
  if (!isStringArray(record.phaseOrder)) return undefined;
  if (!isStringArray(record.completedPhaseNames)) return undefined;
  if (!isFiniteNumber(record.startedAt)) return undefined;
  if (!isFiniteNumber(record.updatedAt)) return undefined;
  return {
    schemaVersion: 1,
    taskId: record.taskId,
    workflowType: record.workflowType,
    branch: record.branch,
    originalCwd: record.originalCwd,
    phaseOrder: record.phaseOrder,
    completedPhaseNames: record.completedPhaseNames,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  };
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

interface LegacyTaskFile {
  taskId: string;
  branch: string;
  originalCwd: string;
  workflowType?: string;
}

function parseLegacyTaskFile(raw: unknown): LegacyTaskFile | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.taskId !== "string") return undefined;
  if (typeof record.branch !== "string") return undefined;
  if (typeof record.originalCwd !== "string") return undefined;
  if (record.workflowType !== undefined && typeof record.workflowType !== "string")
    return undefined;
  return {
    taskId: record.taskId,
    branch: record.branch,
    originalCwd: record.originalCwd,
    workflowType: record.workflowType,
  };
}

/**
 * One-shot legacy migration: `.belayd-task.json` → `.belayd/workflow.json`.
 * The legacy file only carried identity, so the migrated state starts with no
 * completed phases. The legacy file is deleted after a successful write so a
 * later read never re-migrates.
 */
function migrateLegacyTaskFile(
  fs: WorkflowFs,
  cwd: string,
  now?: () => number,
): WorkflowState | undefined {
  const legacyPath = legacyTaskFilePath(cwd);
  if (!fs.existsSync(legacyPath)) return undefined;
  let legacy: LegacyTaskFile | undefined;
  try {
    legacy = parseLegacyTaskFile(JSON.parse(fs.readFileSync(legacyPath)));
  } catch {
    return undefined;
  }
  if (legacy === undefined) return undefined;

  const legacyType = legacy.workflowType ?? "";
  const workflowType: WorkflowSubType = isValidWorkflowType(legacyType) ? legacyType : "feature";
  const startedAt = nowMs(now);
  const state: WorkflowState = {
    schemaVersion: 1,
    taskId: legacy.taskId,
    workflowType,
    branch: legacy.branch,
    originalCwd: legacy.originalCwd,
    phaseOrder: getPhasesForType(workflowType),
    completedPhaseNames: [],
    startedAt,
    updatedAt: startedAt,
  };
  const result = writeWorkflowState({ cwd, state, fs });
  if (!result.ok) return undefined;
  try {
    fs.unlinkSync(legacyPath);
  } catch {
    // Best-effort: a stale legacy file is harmless because workflow.json wins.
  }
  return state;
}

/**
 * Read the current workflow state, migrating the legacy task file on first
 * use. Returns undefined when no state exists or when it is unreadable.
 */
export function readWorkflowState(options: ReadWorkflowStateOptions): WorkflowState | undefined {
  const fs = options.fs ?? nodeFsSeam;
  const existing = readWorkflowStateFile(fs, options.cwd);
  if (existing !== undefined) return existing;
  return migrateLegacyTaskFile(fs, options.cwd, options.now);
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

/** Remove both the current state file and any stale legacy task file. */
export function clearWorkflowState(options: ClearWorkflowStateOptions): void {
  const fs = options.fs ?? nodeFsSeam;
  for (const path of [workflowStateFilePath(options.cwd), legacyTaskFilePath(options.cwd)]) {
    try {
      fs.unlinkSync(path);
    } catch {
      // Missing files are the expected success case.
    }
  }
}
