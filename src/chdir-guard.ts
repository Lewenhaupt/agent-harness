/**
 * Guard for restoring a session's working directory.
 *
 * `belayd_stop_task` chdirs back to the directory recorded when the workflow
 * started. That record is only as trustworthy as its writer: pi-web session
 * processes start with cwd `/`, so older workflows persisted `"/"` and the
 * stop path chdir'd into the filesystem root (or, worse, into a directory that
 * no longer exists). The check is pure so it can be unit-tested without
 * touching the real process cwd.
 */

import { isAbsolute, resolve } from "node:path";

export interface ChdirTargetInput {
  /** The recorded working directory. */
  path: string;
  /** Existence probe (node:fs.existsSync in production). */
  existsSync: (path: string) => boolean;
  /**
   * Directory probe (node:fs.statSync(...).isDirectory() in production).
   * Existence alone is not enough: if the recorded path was replaced by a
   * regular file, `process.chdir` throws `ENOTDIR` out of the tool handler.
   */
  isDirectory: (path: string) => boolean;
  /** Filesystem root to reject; defaults to "/". */
  rootPath?: string;
}

export type ChdirTargetResult =
  | { allowed: true; path: string }
  | { allowed: false; reason: string };

/**
 * Decide whether `path` is a usable working directory.
 *
 * Relative paths are rejected rather than resolved against the current cwd:
 * the recorded value comes from another process, so its relative form has no
 * meaningful anchor here.
 */
export function isSafeChdirTarget(input: ChdirTargetInput): ChdirTargetResult {
  const raw = input.path.trim();
  if (raw === "") return { allowed: false, reason: "the recorded directory is empty" };
  if (!isAbsolute(raw)) {
    return { allowed: false, reason: `"${raw}" is not an absolute path` };
  }
  const target = resolve(raw);
  const root = resolve(input.rootPath ?? "/");
  if (target === root) {
    return { allowed: false, reason: `${target} is the filesystem root` };
  }
  if (!input.existsSync(target)) {
    return { allowed: false, reason: `${target} does not exist` };
  }
  if (!input.isDirectory(target)) {
    return { allowed: false, reason: `${target} is not a directory` };
  }
  return { allowed: true, path: target };
}
