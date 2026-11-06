/**
 * Crash-safe JSON file write (bd-281 extraction).
 *
 * A temp file in the target directory, then a rename over the target: a reader
 * either sees the old file or the new one, never a half-written one.
 *
 * This lives in its own leaf module because unrelated runtime *files* still use
 * it — `.belayd/handoff.json`, `.belayd/telemetry.json`, run manifests and (while
 * the fleet migration is staged) the fleet records — and those modules must not
 * import `src/workflow-state.ts`, which now owns the shared repository store and
 * would be a circular import. Nothing about workflow *state* is written here any
 * more: state is a row in `<git-common-dir>/belayd/state.sqlite`.
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname } from "node:path";

/** Subset of node:fs sync operations the atomic write needs, injected by tests. */
export interface WorkflowFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string, options?: { flag?: string }): void;
  renameSync(oldPath: string, newPath: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
}

/** Production fs seam. */
export const atomicJsonFs: WorkflowFs = {
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

/** Atomically write any JSON value; returns an error value instead of throwing. */
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
