/**
 * The shared git common-dir probe (bd-281 extraction).
 *
 * Every linked worktree of one repository reports the same `--git-common-dir`, so
 * this is the one path every worktree agrees on. The per-repository execution
 * state store lives there (`<git-common-dir>/belayd/state.sqlite`), which is what
 * makes "one database, shared by every worktree, never inside a worktree and never
 * tracked" true by construction.
 *
 * Extracted from `src/worktree.ts` so the store can resolve it without importing
 * that module's worktree/handoff graph (which imports the store back).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gitContextFreeEnv } from "./worktree-list.js";

/** Discriminated result of resolving a project namespace key. */
export type RepoKeyResult = { ok: true; key: string } | { ok: false; error: string };

/**
 * Exec seam for the read-only git probes here (`rev-parse`). Production runs git;
 * tests inject fixed stdout/throwers.
 */
export type RepoKeyExec = (cwd: string) => string;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why a probe found no common dir.
 *
 * `not-a-repository` is an observed absence: git ran, exited non-zero and the
 * directory tree carries no repository marker. `indeterminate` covers every
 * outcome the probe could not observe — a spawn failure, a timeout/signal, an
 * empty result, or repository metadata that exists but is broken. Callers that
 * distinguish absence from failure (the proof gate) must fail closed on this
 * reason rather than read "I could not ask git" as "there is no repository".
 */
export type GitCommonDirFailureReason = "not-a-repository" | "indeterminate";

/** Discriminated result of resolving the shared git common dir. */
export type GitCommonDirResult =
  | { ok: true; commonDir: string }
  | { ok: false; error: string; reason?: GitCommonDirFailureReason };

/**
 * Resolve the absolute shared git common dir for `cwd`.
 *
 * Every linked worktree of one repository reports the same directory, so
 * `<git-common-dir>/belayd/...` is the one place cross-worktree fleet state can
 * live (docs/fleet-orchestrator.md). `resolveRepoKey` is derived from this same
 * probe so there is exactly one git-common-dir resolver.
 *
 * Side effect: shells out to git with a 10s timeout.
 */
export function resolveGitCommonDir(
  cwd: string,
  exec: RepoKeyExec = execGitCommonDir,
): GitCommonDirResult {
  let commonDirRaw: string;
  try {
    commonDirRaw = exec(cwd).trim();
  } catch (error) {
    return {
      ok: false,
      reason: classifyProbeFailure(cwd, error),
      error: `git rev-parse --git-common-dir failed in ${cwd}: ${errorMessage(error)}`,
    };
  }

  if (commonDirRaw === "") {
    return {
      ok: false,
      reason: "indeterminate",
      error: `git rev-parse returned an empty common dir for ${cwd}`,
    };
  }

  return { ok: true, commonDir: resolve(cwd, commonDirRaw) };
}

/**
 * Resolve the shared git common dir for `cwd` and derive a stable project key.
 *
 * Uses `--path-format=absolute` so linked worktrees all report the main
 * repository's git dir and therefore map to the same project key.
 *
 * Known limitation: bare repositories are out of scope. For a bare repo,
 * `git rev-parse --git-common-dir` returns the bare repo directory itself,
 * so `dirname` yields its parent and two bare repos under the same parent
 * would resolve to the same key. This harness operates on normal worktrees.
 *
 * Side effect: shells out to git with a 10s timeout.
 */
export function resolveRepoKey(cwd: string, exec: RepoKeyExec = execGitCommonDir): RepoKeyResult {
  const commonDirResult = resolveGitCommonDir(cwd, exec);
  if (!commonDirResult.ok) {
    return { ok: false, error: commonDirResult.error };
  }

  // For non-bare repos, git-common-dir is the `.git` directory itself and its
  // parent is the repo root (bare repos resolve to their parent; see above).
  const repoRoot = dirname(commonDirResult.commonDir);
  try {
    return { ok: true, key: projectKeyFromRepoRoot(repoRoot) };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to derive project key from ${repoRoot}: ${errorMessage(error)}`,
    };
  }
}

/**
 * Classify a failed probe from its process outcome, never from git's message.
 *
 * A successfully spawned git that exits non-zero is the shape `rev-parse` has
 * outside a work tree, so that is the candidate for absence. It is only
 * *absence* when no repository marker exists anywhere above `cwd`: git exits 128
 * both for "not a repository" and for a `.git` file that points at a missing
 * common dir, so a broken repository must stay `indeterminate` and fail closed.
 * The marker check is a filesystem fact, not a reading of stderr.
 *
 * Residual: a corrupt repository whose marker was removed is indistinguishable
 * from a plain directory by the probe. It resolves as absence, which is recorded
 * in `docs/proof-verifier.md` rather than papered over.
 */
function classifyProbeFailure(cwd: string, error: unknown): GitCommonDirFailureReason {
  if (spawnExitStatus(error) === undefined) return "indeterminate";
  return hasRepositoryMarker(cwd) ? "indeterminate" : "not-a-repository";
}

/**
 * The exit status of a child that spawned and exited, or undefined when the
 * child never ran (ENOENT) or was killed by a timeout signal.
 */
function spawnExitStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("status" in error)) return undefined;
  const status = error.status;
  if (typeof status !== "number" || status === 0) return undefined;
  return status;
}

/** Whether `cwd` or an ancestor carries a repository marker (`.git` file or dir). */
function hasRepositoryMarker(cwd: string): boolean {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function execGitCommonDir(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    env: gitContextFreeEnv(),
    timeout: 10_000,
    encoding: "utf8",
    stdio: "pipe",
  });
}

/**
 * Derive a filesystem-safe project key from a repository root path.
 *
 * Format: `<sanitized-basename>-<first 8 hex chars of sha256(realpath)>`.
 * The hash keeps same-named repositories in different locations distinct,
 * while the readable basename keeps directories recognizable.
 *
 * The 32-bit suffix makes collisions unlikely: two roots collide only when
 * their basenames match AND their 32-bit hashes match. A collision merely
 * merges two ephemeral proof directories — it is not data corruption.
 *
 * Deterministic for a given root; side effect: realpathSync reads the fs.
 * Throws when `repoRoot` does not exist; {@link resolveRepoKey} catches this
 * and returns an error result.
 */
export function projectKeyFromRepoRoot(repoRoot: string): string {
  const sanitized = basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, "-");
  // `.` and `..` survive sanitization and would create hidden/traversal-like
  // key names, so they fall back to the literal "repo" like an empty basename.
  const name = sanitized === "" || sanitized === "." || sanitized === ".." ? "repo" : sanitized;
  const digest = createHash("sha256").update(realpathSync(repoRoot)).digest("hex");
  return `${name}-${digest.slice(0, 8)}`;
}
