import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Options for creating an isolated git worktree for agent processes. */
export interface WorktreeOptions {
  /** Branch name for the worktree, e.g. "feat/bd-42". */
  branch: string;
  /** Base branch to create from (defaults to "main"). Only used when creating a new worktree. */
  base?: string;
}

/**
 * Resolve the worktree path for a given branch using `git worktree list`.
 * Returns the path if found, otherwise undefined.
 */
export function resolveWorktreePath(projectRoot: string, branch: string): string | undefined {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: projectRoot,
      timeout: 10_000,
      encoding: "utf8",
    });

    const lines = output.split("\n");
    let currentPath: string | undefined;

    for (const line of lines) {
      if (line === "") {
        currentPath = undefined;
        continue;
      }
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        const lineBranch = line.slice("branch refs/heads/".length);
        if (lineBranch === branch && currentPath) {
          return currentPath;
        }
      }
    }
  } catch {
    // git worktree list failed
  }
  return undefined;
}

/**
 * Resolve the default worktree directory path for a branch without consulting
 * git. `wt` and `git worktree` use the convention `<repo-root>.<branch>` with
 * "/" replaced by "-" in the branch name.
 */
function defaultWorktreeDir(projectRoot: string, branch: string): string {
  const sanitized = branch.replace(/\//g, "-");
  return `${projectRoot}.${sanitized}`;
}

/**
 * Set up the worktree for a workflow run.
 *
 * Strategy (in order):
 * 1. If the worktree is already registered in git, return its path immediately.
 * 2. If the branch exists but no worktree is registered, use `wt switch`.
 * 3. If the branch doesn't exist and the default directory is absent, use
 *    `wt switch --create`.
 * 4. If the branch doesn't exist but the default directory already exists
 *    (orphaned from a prior failed attempt), use `wt switch --create --clobber`
 *    to overwrite it with a backup.
 *
 * Returns the absolute path to the worktree.
 *
 * Throws if the worktree cannot be set up or the path cannot be resolved.
 */
export function setupWorktree(projectRoot: string, options: WorktreeOptions): string {
  const base = options.base ?? "main";

  // Step 1: Check if the worktree is already registered in git
  const existingPath = resolveWorktreePath(projectRoot, options.branch);
  if (existingPath !== undefined) {
    return existingPath;
  }

  // Step 2: Check if the branch already exists
  let branchExists = false;
  try {
    const branches = execFileSync("git", ["branch", "--list", options.branch], {
      cwd: projectRoot,
      timeout: 10_000,
      encoding: "utf8",
    }).trim();
    branchExists = branches.length > 0;
  } catch {
    // If git fails, assume branch doesn't exist
  }

  // Step 3: Determine the right wt arguments
  let wtArgs: string[];
  if (branchExists) {
    // Branch exists but worktree not registered — just switch to it.
    // wt will create the directory and register the worktree.
    wtArgs = ["switch", options.branch, "-y"];
  } else {
    // Branch doesn't exist — need --create.
    const dirPath = defaultWorktreeDir(projectRoot, options.branch);
    const dirExists = existsSync(dirPath);
    if (dirExists) {
      // Orphaned directory from a prior failed attempt — clobber it.
      wtArgs = ["switch", "--create", options.branch, "--base", base, "--clobber", "-y"];
    } else {
      wtArgs = ["switch", "--create", options.branch, "--base", base, "-y"];
    }
  }

  // Step 4: Create or switch to the worktree
  try {
    execFileSync("wt", wtArgs, {
      cwd: projectRoot,
      timeout: 30_000,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    throw new Error(
      `Failed to set up worktree: ${
        error instanceof Error ? error.message : String(error)
      }. Make sure \`wt\` (Worktrunk) is installed.`,
    );
  }

  // Step 5: Resolve the worktree path
  const worktreePath = resolveWorktreePath(projectRoot, options.branch);
  if (!worktreePath) {
    throw new Error("Could not resolve worktree path after creation. Check `git worktree list`.");
  }

  return worktreePath;
}

/**
 * Check if we're already running inside a worktree for the target branch.
 * If so, we can skip the `wt switch --create` call.
 */
export function isInsideWorktreeForBranch(cwd: string, branch: string): boolean {
  try {
    // Check if the current directory IS the worktree for the target branch
    const output = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      timeout: 5_000,
      encoding: "utf8",
    }).trim();

    if (output !== branch) {
      return false;
    }

    // Also verify this is a linked worktree (not main)
    const worktreeOutput = execSync("git worktree list --porcelain", {
      cwd,
      timeout: 5_000,
      encoding: "utf8",
    }).trim();

    // Parse the entry for our current worktree
    const lines = worktreeOutput.split("\n");
    let currentPath: string | undefined;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
        // If this is the first entry (main worktree), check it
        // If we're in a linked worktree, the path will match cwd
        if (currentPath === cwd) {
          return true;
        }
      }
    }
  } catch {
    // Fall through to false
  }
  return false;
}

/**
 * pnpm writes `.modules.yaml` last when a worktree install completes, so it is
 * a reliable completion marker for dependency setup.
 */
function dependenciesReady(worktreePath: string): boolean {
  return existsSync(join(worktreePath, "node_modules", ".modules.yaml"));
}

/**
 * Wait for a worktree's dependencies to be installed.
 *
 * `wt switch` returns once the worktree is registered, but until this was
 * migrated to `pre-start` hooks its post-start hooks installed deps in the
 * background. A session booting before that finishes hits e.g.
 * "Cannot find module 'zod'" when loading the harness extension, so we poll
 * for install completion before delegating the orchestrator session.
 *
 * @returns `{ ok: true }` once deps are ready, or `{ ok: false; error }` after
 * `timeoutInMs` elapses.
 */
export async function awaitWorktreeReady(
  worktreePath: string,
  options: { timeoutInMs?: number; pollIntervalInMs?: number } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const timeoutInMs = options.timeoutInMs ?? 60_000;
  const pollIntervalInMs = options.pollIntervalInMs ?? 200;
  const deadline = Date.now() + timeoutInMs;

  while (Date.now() < deadline) {
    if (dependenciesReady(worktreePath)) {
      return { ok: true };
    }
    await sleep(pollIntervalInMs);
  }

  return {
    ok: false,
    error: `Worktree dependencies not ready within ${timeoutInMs}ms: ${worktreePath}`,
  };
}

/** Discriminated result of resolving a project namespace key. */
export type RepoKeyResult = { ok: true; key: string } | { ok: false; error: string };

/**
 * Exec seam for {@link resolveRepoKey}. Production runs `git rev-parse`;
 * tests inject a function returning a fixed common-dir or throwing.
 */
export type RepoKeyExec = (cwd: string) => string;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  let commonDirRaw: string;
  try {
    commonDirRaw = exec(cwd).trim();
  } catch (error) {
    return {
      ok: false,
      error: `git rev-parse --git-common-dir failed in ${cwd}: ${errorMessage(error)}`,
    };
  }

  if (commonDirRaw === "") {
    return { ok: false, error: `git rev-parse returned an empty common dir for ${cwd}` };
  }

  // For non-bare repos, git-common-dir is the `.git` directory itself and its
  // parent is the repo root (bare repos resolve to their parent; see above).
  const commonDir = resolve(cwd, commonDirRaw);
  const repoRoot = dirname(commonDir);
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
 * Git variables that let an inherited environment override the process `cwd`.
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` make `rev-parse` report the git
 * context of the caller (e.g. a git hook) rather than `cwd`, which would
 * resolve another repository's project key and break the per-project
 * namespace guarantee.
 *
 * Exported so test helpers that create temporary repositories strip the same
 * variables: an inherited `GIT_DIR` makes `git init` ignore its target and
 * reinitialize the caller's repository, rewriting `core.bare` to true (bd-58).
 */
export const GIT_CONTEXT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
];

/**
 * Copy `process.env` with inherited git-context variables removed. Fortifying
 * against them keeps {@link execGitCommonDir} pinned to the passed `cwd`.
 *
 * The keys are deleted from the copy instead of being set to `undefined`
 * because Node's child_process skips `undefined` env values inconsistently
 * across versions. `process.env` itself is never mutated.
 */
export function gitContextFreeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_CONTEXT_ENV_KEYS) {
    delete env[key];
  }
  return env;
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
