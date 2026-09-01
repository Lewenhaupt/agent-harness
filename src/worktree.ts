import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

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
