/**
 * Isolated repository state store for one test file (bd-281).
 *
 * The store lives in a repository's git common dir and refuses every other
 * location on purpose: a store inside a worktree is forbidden, and a fallback
 * would re-create the copied-state bug the store exists to remove. Extension
 * tests drive real code in a temp directory that is not a repository, so they
 * point `BELAYD_REPO_STATE_FILE` at a fresh file instead — the documented seam,
 * the same one an operator uses to relocate the store.
 *
 * One file per test keeps tests independent: workflow rows are keyed by task id
 * and most fixtures reuse the same ids, so sharing one file would leak state
 * between tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { REPO_STATE_FILE_ENV, resetSharedRepoStateStore } from "../../repo-state-store.js";

const tempDirs: string[] = [];

/** Point the shared store at a fresh temp file and drop every cached handle. */
export function useTempRepoState(): void {
  const dir = mkdtempSync(join(tmpdir(), "belayd-repo-state-test-"));
  tempDirs.push(dir);
  process.env[REPO_STATE_FILE_ENV] = join(dir, "state.sqlite");
  resetSharedRepoStateStore();
}

/** Forget the override and remove the temp stores of the finished test. */
export function clearTempRepoState(): void {
  delete process.env[REPO_STATE_FILE_ENV];
  resetSharedRepoStateStore();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Register the per-test hooks.
 *
 * Called at module scope by a test file, so the override is in place before that
 * file's own setup (which may seed workflow state) runs.
 */
export function installTempRepoState(): void {
  beforeEach(() => {
    useTempRepoState();
  });
  afterEach(() => {
    clearTempRepoState();
  });
}
