/**
 * Session condition checks for proactive notifications.
 *
 * Pure functions for detecting conditions like uncommitted files, conflicts,
 * etc. that the harness notifies the user about via ctx.ui.notify().
 */

import { exec } from "node:child_process";

/**
 * Check whether there are uncommitted changes in the given directory.
 *
 * Uses `git status --porcelain` to count tracked changes (modified, added,
 * deleted, renamed, copied) and untracked files.  Ignored files and clean
 * repos both return 0.
 *
 * @param cwd - Working directory to check (should be a git repo).
 * @returns Number of uncommitted paths, or `null` if cwd is not a git repo.
 */
export async function countUncommittedFiles(cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    exec("git status --porcelain", { cwd, timeout: 15_000, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const trimmed = stdout.trim();
      if (trimmed === "") {
        resolve(0);
        return;
      }
      resolve(trimmed.split("\n").length);
    });
  });
}
