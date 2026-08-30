/**
 * Run manifests for individual phase-agent executions.
 *
 * Each phase-tool execution records a manifest in `.belayd/runs/<runId>.json`
 * so a crash mid-run can be detected on the next session start: any manifest
 * still marked "running" is flipped to "interrupted" and surfaced to the
 * orchestrator instead of silently disappearing.
 */

import * as nodeFs from "node:fs";
import { join } from "node:path";

import { atomicWriteJson, type WorkflowFs } from "./workflow-state.js";

export type RunStatus = "running" | "completed" | "failed" | "interrupted";

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  phase: string;
  sessionName: string;
  status: RunStatus;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  model?: string;
}

/** Workflow fs seam plus the directory listing that run manifests need. */
export interface RunManifestFs extends WorkflowFs {
  readdirSync(path: string): string[];
}

export interface WriteRunManifestOptions {
  cwd: string;
  manifest: RunManifest;
  fs?: RunManifestFs;
}

export interface ReadRunManifestOptions {
  cwd: string;
  runId: string;
  fs?: RunManifestFs;
}

export interface SetRunStatusOptions {
  cwd: string;
  runId: string;
  status: RunStatus;
  exitCode?: number;
  fs?: RunManifestFs;
  now?: () => number;
}

export interface ListRunsOptions {
  cwd: string;
  fs?: RunManifestFs;
}

export interface ScanForInterruptedRunsOptions {
  cwd: string;
  fs?: RunManifestFs;
  now?: () => number;
}

const SCHEMA_VERSION = 1;
const RUN_STATUSES: readonly RunStatus[] = ["running", "completed", "failed", "interrupted"];

const nodeFsSeam: RunManifestFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
  writeFileSync: (path, data, options) => nodeFs.writeFileSync(path, data, options),
  renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path, options),
  unlinkSync: (path) => nodeFs.unlinkSync(path),
  readdirSync: (path) => nodeFs.readdirSync(path),
};

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function runsDir(cwd: string): string {
  return join(cwd, ".belayd", "runs");
}

export function runManifestPath(cwd: string, runId: string): string {
  return join(runsDir(cwd), `${runId}.json`);
}

interface RunManifestCore {
  runId: string;
  taskId: string;
  phase: string;
  sessionName: string;
  status: RunStatus;
  startedAt: number;
}

/** Narrow the fields every run manifest requires; wrong type → undefined. */
function parseRunManifestCore(record: Record<string, unknown>): RunManifestCore | undefined {
  if (typeof record.runId !== "string") return undefined;
  if (typeof record.taskId !== "string") return undefined;
  if (typeof record.phase !== "string") return undefined;
  if (typeof record.sessionName !== "string") return undefined;
  if (!isRunStatus(record.status)) return undefined;
  if (!isFiniteNumber(record.startedAt)) return undefined;
  return {
    runId: record.runId,
    taskId: record.taskId,
    phase: record.phase,
    sessionName: record.sessionName,
    status: record.status,
    startedAt: record.startedAt,
  };
}

/** Narrow a run manifest's optional fields, returning undefined on wrong types. */
function parseOptionalFields(record: Record<string, unknown>):
  | {
      completedAt?: number;
      exitCode?: number;
      model?: string;
    }
  | undefined {
  if (record.completedAt !== undefined && !isFiniteNumber(record.completedAt)) return undefined;
  if (record.exitCode !== undefined && !isFiniteNumber(record.exitCode)) return undefined;
  if (record.model !== undefined && typeof record.model !== "string") return undefined;
  return {
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
  };
}

/** Parse and strictly narrow a run manifest; corrupt/wrong version → undefined. */
export function parseRunManifest(raw: unknown): RunManifest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== SCHEMA_VERSION) return undefined;
  const core = parseRunManifestCore(record);
  if (core === undefined) return undefined;
  const optional = parseOptionalFields(record);
  if (optional === undefined) return undefined;
  return { schemaVersion: 1, ...core, ...optional };
}

export function writeRunManifest(
  options: WriteRunManifestOptions,
): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  return atomicWriteJson(
    runManifestPath(options.cwd, options.manifest.runId),
    options.manifest,
    fs,
  );
}

export function readRunManifest(options: ReadRunManifestOptions): RunManifest | undefined {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = runManifestPath(options.cwd, options.runId);
  if (!fs.existsSync(filePath)) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
  try {
    return parseRunManifest(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function terminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/**
 * Read-modify-write a run's status. Terminal statuses record `completedAt`;
 * an unknown run id is an error value, not a throw.
 */
export function setRunStatus(
  options: SetRunStatusOptions,
): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  const existing = readRunManifest({ cwd: options.cwd, runId: options.runId, fs });
  if (existing === undefined) {
    return { ok: false, error: `No run manifest found for ${options.runId}` };
  }
  const updated: RunManifest = {
    ...existing,
    status: options.status,
    // Terminal statuses record completedAt; non-terminal transitions must drop
    // any stale completedAt (JSON.stringify omits undefined) so a "running"
    // manifest never carries a past completion timestamp.
    completedAt: terminalStatus(options.status) ? (options.now ?? Date.now)() : undefined,
    ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
  };
  return writeRunManifest({ cwd: options.cwd, manifest: updated, fs });
}

/** List persisted runs sorted by start time; malformed files and non-.json entries are skipped. */
export function listRuns(options: ListRunsOptions): RunManifest[] {
  const fs = options.fs ?? nodeFsSeam;
  const dir = runsDir(options.cwd);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // missing runs dir is the initial (empty) state
  }
  const runs: RunManifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const runId = entry.slice(0, -".json".length);
    const manifest = readRunManifest({ cwd: options.cwd, runId, fs });
    if (manifest !== undefined) runs.push(manifest);
  }
  runs.sort((a, b) => a.startedAt - b.startedAt);
  return runs;
}

/**
 * Flip any manifest still marked "running" to "interrupted" and return the
 * interrupted set. Called on session start to surface runs that died with the
 * previous orchestrator process.
 */
export function scanForInterruptedRuns(options: ScanForInterruptedRunsOptions): RunManifest[] {
  const fs = options.fs ?? nodeFsSeam;
  const now = options.now ?? Date.now;
  const interrupted: RunManifest[] = [];
  for (const run of listRuns({ cwd: options.cwd, fs })) {
    if (run.status !== "running") continue;
    const completedAt = now();
    const result = setRunStatus({
      cwd: options.cwd,
      runId: run.runId,
      status: "interrupted",
      fs,
      now,
    });
    if (result.ok) {
      interrupted.push({ ...run, status: "interrupted", completedAt });
    }
  }
  return interrupted;
}
