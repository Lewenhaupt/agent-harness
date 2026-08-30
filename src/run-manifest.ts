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
import { z } from "zod";

import { atomicWriteJson, type WorkflowFs } from "./workflow-state.js";

export enum RunStatus {
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Interrupted = "interrupted",
}

const SCHEMA_VERSION = 1;

const RunManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string(),
  taskId: z.string(),
  phase: z.string(),
  sessionName: z.string(),
  status: z.nativeEnum(RunStatus),
  startedAt: z.number().finite(),
  completedAt: z.number().finite().optional(),
  exitCode: z.number().finite().optional(),
  model: z.string().optional(),
});

export type RunManifest = z.infer<typeof RunManifestSchema>;

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

const nodeFsSeam: RunManifestFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
  writeFileSync: (path, data, options) => nodeFs.writeFileSync(path, data, options),
  renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path, options),
  unlinkSync: (path) => nodeFs.unlinkSync(path),
  readdirSync: (path) => nodeFs.readdirSync(path),
};

export function runsDir(cwd: string): string {
  return join(cwd, ".belayd", "runs");
}

export function runManifestPath(cwd: string, runId: string): string {
  return join(runsDir(cwd), `${runId}.json`);
}

/** Parse and strictly narrow a run manifest; corrupt/wrong version → undefined. */
export function parseRunManifest(raw: unknown): RunManifest | undefined {
  const result = RunManifestSchema.safeParse(raw);
  return result.success ? result.data : undefined;
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
  return (
    status === RunStatus.Completed ||
    status === RunStatus.Failed ||
    status === RunStatus.Interrupted
  );
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
    if (run.status !== RunStatus.Running) continue;
    const completedAt = now();
    const result = setRunStatus({
      cwd: options.cwd,
      runId: run.runId,
      status: RunStatus.Interrupted,
      fs,
      now,
    });
    if (result.ok) {
      interrupted.push({ ...run, status: RunStatus.Interrupted, completedAt });
    }
  }
  return interrupted;
}
