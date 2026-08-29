import { execFileSync, execSync } from "node:child_process";

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
 * Set up the worktree for a workflow run.
 *
 * Uses `wt switch` which is idempotent: if the branch + worktree already exist,
 * it switches to the existing one.
 *
 * If the branch doesn't exist yet, uses `wt switch --create` to create it.
 *
 * Returns the absolute path to the worktree.
 *
 * Throws if the worktree cannot be set up or the path cannot be resolved.
 */
export function setupWorktree(projectRoot: string, options: WorktreeOptions): string {
  const base = options.base ?? "main";

  // Step 1: Check if the branch already exists
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

  // Step 2: Create or switch to the worktree
  const wtArgs = branchExists
    ? ["switch", options.branch, "-y"]
    : ["switch", "--create", options.branch, "--base", base, "-y"];

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

  // Step 3: Resolve the worktree path
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
