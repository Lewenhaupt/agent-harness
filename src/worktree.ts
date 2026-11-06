import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_BASE_BRANCH,
  defaultGitExec,
  currentBranch as readCurrentBranch,
  writeStackBase,
} from "./stack-rebase.js";

/** Options for creating an isolated git worktree for agent processes. */
export interface WorktreeOptions {
  /** Branch name for the worktree, e.g. "feat/bd-42". */
  branch: string;
  /**
   * Base branch to create from. Defaults to the base branch the caller is
   * currently on, so a follow-up workflow stacks on the orchestrator's branch;
   * falls back to "main". Only used when creating a new worktree.
   */
  base?: string;
}

/**
 * Injectable seams for {@link setupWorktree}. Production uses the real git
 * helpers; tests replace them to avoid shelling out and to assert that stack
 * metadata is captured (or deliberately not captured) on the create path.
 */
export interface WorktreeDeps {
  /** Resolve the caller's current branch (stacking default). */
  currentBranch?: (cwd: string) => string | undefined;
  /** Record base + fork point for a newly created stacked branch. */
  captureStack?: (input: { cwd: string; branch: string; base: string }) => void;
  /** Worktrunk project identifier used to pin the worktree layout. */
  wtProjectIdentifier?: (cwd: string) => string | undefined;
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
 * Worktrunk path template pinned on every harness `wt` invocation.
 *
 * Worktrunk's own default is already this sibling layout, but `worktree-path`
 * is read from user config, so an ambient override (typically the bare-repo
 * pattern `{{ repo_path }}/../{{ branch | sanitize }}`) silently drops the repo
 * prefix and puts every checkout's same-named branch in one shared directory —
 * `feat/bd-42` of two repositories then fight over `<parent>/feat-bd-42`. The
 * harness owns bead ↔ branch ↔ worktree identity (and derives task ids from the
 * directory name), so it states the naming contract instead of inheriting it.
 */
export const WORKTREE_PATH_TEMPLATE = "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}";

/** Escape a value for a TOML basic string; worktrunk identifiers are paths or `<host>/<owner>/<repo>`. */
function tomlBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Project identifier carried by `wt config show --format json`, if present. */
function projectIdentifierFromConfigShow(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const identifier = asRecord(asRecord(parsed)?.project)?.identifier;
  return typeof identifier === "string" && identifier !== "" ? identifier : undefined;
}

/**
 * Read worktrunk's project identifier for `cwd` — `<host>/<owner>/<repo>` from
 * the primary remote, or the canonical repo path when there is no remote.
 *
 * A user config `[projects."<identifier>"]` entry is merged after the global
 * keys, so a project-scoped `worktree-path` outranks a global `--config-set`.
 * Pinning the layout therefore has to override the same key, which needs the
 * identifier. Best-effort: a `wt` too old for JSON output (or any failure)
 * leaves only the global pin, which still beats a top-level override.
 */
function readWtProjectIdentifier(cwd: string): string | undefined {
  try {
    return projectIdentifierFromConfigShow(
      execFileSync("wt", ["config", "show", "--format", "json"], {
        cwd,
        timeout: 10_000,
        encoding: "utf8",
        stdio: "pipe",
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * Resolve the default worktree directory path for a branch without consulting
 * git. It mirrors {@link WORKTREE_PATH_TEMPLATE} for a main checkout: the
 * sibling of the repo root named `<repo-root>.<branch>`, with "/" replaced by
 * "-" (what worktrunk's `sanitize` does to a branch name).
 */
function defaultWorktreeDir(projectRoot: string, branch: string): string {
  const sanitized = branch.replace(/\//g, "-");
  return `${projectRoot}.${sanitized}`;
}

/** Capture base + fork point for a freshly created stacked branch. */
function captureStackBase(input: { cwd: string; branch: string; base: string }): void {
  // At capture time the branch was just cut from `base`, so `rev-parse` is exact
  // and cheap. Runtime resolution deliberately prefers `merge-base --fork-point`
  // (which survives a rewritten base tip) with this recorded value as fallback,
  // so do not "fix" this to merge-base after the fact.
  const forkPoint = defaultGitExec(["rev-parse", `${input.base}^{commit}`], input.cwd).trim();
  const result = writeStackBase(defaultGitExec, {
    cwd: input.cwd,
    branch: input.branch,
    base: input.base,
    forkPoint,
  });
  if (!result.ok) throw new Error(result.error);
}

/** Whether `branch` already exists as a local branch (git failure = assume not). */
function branchAlreadyExists(projectRoot: string, branch: string): boolean {
  try {
    return (
      execFileSync("git", ["branch", "--list", branch], {
        cwd: projectRoot,
        timeout: 10_000,
        encoding: "utf8",
      }).trim().length > 0
    );
  } catch {
    return false;
  }
}

/** Build the `wt switch` argv for switching to or creating the worktree. */
function planWtArgs(options: {
  projectRoot: string;
  branch: string;
  base: string;
  branchExists: boolean;
  projectIdentifier: string | undefined;
}): string[] {
  const { projectRoot, branch, base, branchExists, projectIdentifier } = options;
  const layout = `worktree-path="${WORKTREE_PATH_TEMPLATE}"`;
  // Global options, so they precede the subcommand. The global key covers a
  // top-level override; the project-scoped key is what beats a
  // `[projects."<id>"]` entry, which worktrunk merges last.
  const layoutArgs = ["--config-set", layout];
  const projectLayoutArgs =
    projectIdentifier === undefined
      ? []
      : ["--config-set", `projects."${tomlBasicString(projectIdentifier)}".${layout}`];
  const pinnedArgs = [...layoutArgs, ...projectLayoutArgs];

  if (branchExists) return [...pinnedArgs, "switch", branch, "-y"];
  // An orphaned directory from a prior failed attempt is clobbered so the
  // retry does not fail on the leftover path; a fresh path needs no clobber.
  const clobber = existsSync(defaultWorktreeDir(projectRoot, branch)) ? ["--clobber"] : [];
  return [...pinnedArgs, "switch", "--create", branch, "--base", base, ...clobber, "-y"];
}

/**
 * Record stack metadata for a branch this call created, best-effort. Reusing an
 * existing branch must not overwrite the config it already carries.
 *
 * A `main`-based branch is recorded too (bd-121): `/belayd` passes no explicit
 * base, so its branch is cut from whatever the caller is on. Without the
 * recorded base `resolveStackChain` stops at the first metadata-less ancestor
 * and reports the branch as rooted at `main` even when it sits on an unmerged
 * parent. A single-level `main` record stays a no-op for `belayd_stack_rebase`
 * (see `isStackAlreadyOnMain`).
 */
function captureStackForNewBranch(
  options: { cwd: string; branch: string; base: string; branchExists: boolean },
  captureStack: (input: { cwd: string; branch: string; base: string }) => void,
): void {
  if (options.branchExists) return;
  try {
    captureStack({ cwd: options.cwd, branch: options.branch, base: options.base });
  } catch (error) {
    console.warn(
      `[belayd-harness] failed to capture stack base for ${options.branch}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
 * Steps 2–4 pin the layout (`WORKTREE_PATH_TEMPLATE`), so `wt` places the
 * worktree at `<repo>.<branch>` even when the operator's worktrunk config says
 * otherwise. A worktree that is already registered (step 1) is returned as-is,
 * wherever it lives.
 *
 * Returns the absolute path to the worktree.
 *
 * Throws if the worktree cannot be set up or the path cannot be resolved.
 */
export function setupWorktree(
  projectRoot: string,
  options: WorktreeOptions,
  deps: WorktreeDeps = {},
): string {
  const resolveCurrentBranch = deps.currentBranch ?? readCurrentBranch;
  const captureStack = deps.captureStack ?? captureStackBase;
  const base = options.base ?? resolveCurrentBranch(projectRoot) ?? DEFAULT_BASE_BRANCH;

  // Step 1: Check if the worktree is already registered in git
  const existingPath = resolveWorktreePath(projectRoot, options.branch);
  if (existingPath !== undefined) {
    return existingPath;
  }

  // Step 2: Check if the branch already exists, then pick the switch arguments.
  const branchExists = branchAlreadyExists(projectRoot, options.branch);
  const readProjectIdentifier = deps.wtProjectIdentifier ?? readWtProjectIdentifier;
  const wtArgs = planWtArgs({
    projectRoot,
    branch: options.branch,
    base,
    branchExists,
    projectIdentifier: readProjectIdentifier(projectRoot),
  });

  // Step 3: Create or switch to the worktree
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

  // Step 4: Resolve the worktree path
  const worktreePath = resolveWorktreePath(projectRoot, options.branch);
  if (!worktreePath) {
    throw new Error("Could not resolve worktree path after creation. Check `git worktree list`.");
  }

  // Best-effort: a missing config degrades stacked rebases to a warning, never
  // a failed worktree setup.
  captureStackForNewBranch(
    { cwd: projectRoot, branch: options.branch, base, branchExists },
    captureStack,
  );

  // No inherited run manifests to drop: bd-281 moved them into the shared store,
  // so a new worktree's `.belayd/` copy cannot carry another bead's runs.
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
 * Whether this worktree's dependency setup is expected to produce the pnpm
 * completion marker (`node_modules/.modules.yaml`).
 *
 * The marker is pnpm-specific. Repositories that are not pnpm projects (for
 * example a Neovim/Nix config with no `package.json` at all) never produce it,
 * so polling for it would stall `/belayd` for the full timeout even though the
 * worktree is already usable. Pnpm lock/workspace files are the signal that
 * `wt`'s pre-start install hook (or a manual `pnpm install`) is relevant.
 */
function expectsPnpmDependencies(worktreePath: string): boolean {
  return (
    existsSync(join(worktreePath, "pnpm-lock.yaml")) ||
    existsSync(join(worktreePath, "pnpm-workspace.yaml"))
  );
}

/**
 * Default bound on {@link awaitWorktreeReady}.
 *
 * Exported so the fleet spawn grace is derived from the wait it actually allows,
 * instead of restating the number (bd-233 W1).
 */
export const WORKTREE_READY_TIMEOUT_MS = 60_000;

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
  const timeoutInMs = options.timeoutInMs ?? WORKTREE_READY_TIMEOUT_MS;
  const pollIntervalInMs = options.pollIntervalInMs ?? 200;

  // Non-pnpm projects have no dependency install to wait for; treating them as
  // "not ready" until the pnpm marker appears would block every `/belayd` run
  // in such a repo (e.g. a Nix/Neovim config) for the whole timeout.
  if (!expectsPnpmDependencies(worktreePath)) {
    return { ok: true };
  }

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

// The shared git-common-dir probe lives in a leaf module so the repository state
// store (bd-281) can resolve it without importing this module's worktree/handoff
// graph, which would be a cycle.
export {
  type GitCommonDirResult,
  projectKeyFromRepoRoot,
  type RepoKeyExec,
  type RepoKeyResult,
  resolveGitCommonDir,
  resolveRepoKey,
} from "./git-common-dir.js";

// The worktree-list probe, its porcelain parsers and the git-context-free env
// live in a leaf module so the AWS credential broker (which Node runs straight
// from TypeScript) can share them; re-exported here so every existing
// `worktree.js` importer keeps one entry point.
export {
  GIT_CONTEXT_ENV_KEYS,
  gitContextFreeEnv,
  type ListWorktreesDeps,
  listWorktrees,
  type ParsedWorktreeList,
  parseWorktreeListPorcelain,
  parseWorktreeListPorcelainZ,
  type WorktreeListEntry,
  type WorktreeListResult,
  worktreeListDepsFor,
} from "./worktree-list.js";
