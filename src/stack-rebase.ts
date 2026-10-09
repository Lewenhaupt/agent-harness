/**
 * Stacked-branch domain logic: recording which branch a follow-up worktree was
 * cut from, walking that chain, and replaying each level onto its (possibly
 * landed) base with `git rebase --onto`.
 *
 * This module deliberately does NOT import from `worktree.ts`. `worktree.ts`
 * imports the capture helpers here, so the reverse import would form a cycle.
 * The small porcelain parser in {@link parseWorktreeList} is therefore
 * duplicated from `resolveWorktreePath` rather than shared.
 */

import { execFileSync } from "node:child_process";

/** Branch every stack ultimately roots at. */
export const DEFAULT_BASE_BRANCH = "main";

/** Git config key that opts a repository out of automatic pre-commit rebases. */
export const AUTO_REBASE_CONFIG_KEY = "belayd.stack.autoRebase";

/** Env var that overrides {@link AUTO_REBASE_CONFIG_KEY} at process scope. */
export const AUTO_REBASE_ENV_KEY = "BELAYD_STACK_AUTO_REBASE";

/** One level of a stack, resolved from git branch config plus live git state. */
export interface StackNode {
  /** The stacked branch. */
  branch: string;
  /** Effective base after landed-parent resolution: a live branch or `main`. */
  base: string;
  /** Fork point recorded or resolved for this branch, when known. */
  forkPoint?: string;
  /** Declared parent that no longer exists locally (it landed and was removed). */
  landedParent?: string;
}

/**
 * Exec seam for the stack helpers. Production routes to {@link defaultGitExec};
 * tests inject a function that records argv arrays and returns canned stdout.
 */
export type GitExec = (args: readonly string[], cwd: string) => string;

/** Run git synchronously and return stdout. */
export function defaultGitExec(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    timeout: 30_000,
    encoding: "utf8",
    stdio: "pipe",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitConfigGet(cwd: string, key: string, exec: GitExec): string | undefined {
  try {
    const value = exec(["config", "--get", key], cwd).trim();
    return value === "" ? undefined : value;
  } catch {
    // Missing key (exit 1) is the normal "no stack metadata" case.
    return undefined;
  }
}

/**
 * Read the recorded stack metadata for `branch`, or undefined when the branch
 * carries none. The fork point alone is enough to identify a stacked branch;
 * `base` then defaults to `main`.
 */
export function readStackNode(
  cwd: string,
  branch: string,
  exec: GitExec = defaultGitExec,
): StackNode | undefined {
  const base = gitConfigGet(cwd, `branch.${branch}.belaydBase`, exec);
  const forkPoint = gitConfigGet(cwd, `branch.${branch}.belaydForkPoint`, exec);
  if (base === undefined && forkPoint === undefined) return undefined;
  return {
    branch,
    base: base ?? DEFAULT_BASE_BRANCH,
    ...(forkPoint !== undefined ? { forkPoint } : {}),
  };
}

/**
 * Record a branch's base and fork point and point its upstream at the base.
 *
 * The upstream link is what gives lazygit's merge-base coloring; the config
 * keys are the durable fallback once the reflog or the base ref is gone.
 */
export function writeStackBase(
  git: GitExec,
  input: { cwd: string; branch: string; base: string; forkPoint: string },
): { ok: true } | { ok: false; error: string } {
  try {
    git(["config", `branch.${input.branch}.belaydBase`, input.base], input.cwd);
    git(["config", `branch.${input.branch}.belaydForkPoint`, input.forkPoint], input.cwd);
    git(["branch", `--set-upstream-to=${input.base}`, input.branch], input.cwd);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Current branch name, or undefined for a detached HEAD or a git failure. */
export function currentBranch(cwd: string, exec: GitExec = defaultGitExec): string | undefined {
  try {
    const branch = exec(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
    if (branch === "" || branch === "HEAD") return undefined;
    return branch;
  } catch {
    return undefined;
  }
}

/** Whether a local branch ref exists. */
export function branchExists(cwd: string, branch: string, exec: GitExec = defaultGitExec): boolean {
  try {
    return exec(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd).trim() !== "";
  } catch {
    return false;
  }
}

/**
 * `git merge-base --fork-point` is the primary fork-point source: it consults
 * the base's reflog, so it survives a rewritten base tip. It returns nothing
 * when the reflog is gone, in which case the caller falls back to recorded
 * config.
 */
function mergeBaseForkPoint(
  cwd: string,
  parent: string,
  branch: string,
  exec: GitExec,
): string | undefined {
  try {
    const forkPoint = exec(["merge-base", "--fork-point", parent, branch], cwd).trim();
    return forkPoint === "" ? undefined : forkPoint;
  } catch {
    return undefined;
  }
}

/**
 * Walk `branch.<b>.belaydBase` from `leaf` up to `main`, returning the stack
 * root-first.
 *
 * When a declared parent no longer exists locally (its worktree merged and the
 * branch was deleted) the parent is recorded as `landedParent` and the level's
 * effective base becomes `main` — the branch that emitted it has landed and the
 * child must replay onto `main` without its commits. Traversal stops there
 * because everything below a landed parent is already in `main`.
 */
export function resolveStackChain(
  cwd: string,
  leaf: string,
  exec: GitExec = defaultGitExec,
): { ok: true; chain: StackNode[] } | { ok: false; error: string } {
  const chain: StackNode[] = [];
  const seen = new Set<string>();
  let branch = leaf;

  while (branch !== DEFAULT_BASE_BRANCH) {
    if (seen.has(branch)) {
      return { ok: false, error: `Stack cycle detected at ${branch} (already visited).` };
    }
    seen.add(branch);

    const node = readStackNode(cwd, branch, exec);
    // A branch with no recorded base is a normal main-based branch, not a stack.
    if (node === undefined) break;

    const declaredBase = node.base;
    const parentExists = branchExists(cwd, declaredBase, exec);
    const forkPoint = parentExists
      ? (mergeBaseForkPoint(cwd, declaredBase, branch, exec) ?? node.forkPoint)
      : node.forkPoint;

    if (parentExists) {
      chain.unshift({ ...node, forkPoint });
      branch = declaredBase;
      continue;
    }

    // Parent is gone: it landed and was deleted, so replay onto main directly.
    chain.unshift({ ...node, base: DEFAULT_BASE_BRANCH, forkPoint, landedParent: declaredBase });
    break;
  }

  return { ok: true, chain };
}

/** One `git rebase --onto` step. */
export interface StackRebaseStep {
  branch: string;
  onto: string;
  forkPoint: string;
}

/** A level that needs no rebase, with the reason. */
export interface StackRebaseSkip {
  branch: string;
  reason: string;
}

/**
 * Pure planner over a resolved chain and a map of branch tip SHAs. Skip levels
 * with no fork point or those already based on their base's current tip so a
 * no-op rebase is never attempted.
 */
export function planStackRebase(
  chain: readonly StackNode[],
  tips: Record<string, string>,
): { steps: StackRebaseStep[]; skipped: StackRebaseSkip[] } {
  const steps: StackRebaseStep[] = [];
  const skipped: StackRebaseSkip[] = [];

  for (const node of chain) {
    if (node.forkPoint === undefined) {
      skipped.push({ branch: node.branch, reason: "missing-fork-point" });
      continue;
    }
    const tip = tips[node.base];
    if (tip === undefined) {
      skipped.push({ branch: node.branch, reason: "missing-base-tip" });
      continue;
    }
    if (node.forkPoint === tip) {
      skipped.push({ branch: node.branch, reason: "already-based" });
      continue;
    }
    steps.push({ branch: node.branch, onto: tip, forkPoint: node.forkPoint });
  }

  return { steps, skipped };
}

/** Parse `git worktree list --porcelain` into branch → worktree path. */
function parseWorktreeList(porcelain: string): Map<string, string> {
  const map = new Map<string, string>();
  let currentPath: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line === "") {
      currentPath = undefined;
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/") && currentPath !== undefined) {
      map.set(line.slice("branch refs/heads/".length), currentPath);
    }
  }
  return map;
}

/** Whether the worktree has staged, unstaged, or untracked changes. */
function isWorktreeDirty(git: GitExec, worktreePath: string): boolean {
  try {
    return git(["status", "--porcelain"], worktreePath).trim() !== "";
  } catch {
    // If status cannot be read, leave the tree alone rather than risk stashing.
    return false;
  }
}

type NodeRebaseOutcome =
  | { ok: true; rebased: boolean; skipped: StackRebaseSkip[] }
  | {
      ok: false;
      error: string;
      branch: string;
      worktree: string;
      conflicts?: boolean;
      /** A pre-rebase stash entry still exists and needs `git stash` recovery. */
      stashed?: boolean;
      /** The rebase succeeded but `git stash pop` conflicted (changes applied). */
      stashPopConflicted?: boolean;
    };

/**
 * Rebase one chain level inside its own worktree. Extracted from
 * {@link runStackRebase} so the loop stays flat and the stash/conflict handling
 * lives in one place.
 */
function rebaseStackNode(
  git: GitExec,
  options: { cwd: string; node: StackNode; worktreePath: string; stash: boolean },
): NodeRebaseOutcome {
  const { node, worktreePath } = options;

  let baseTip: string;
  try {
    baseTip = git(["rev-parse", `${node.base}^{commit}`], worktreePath).trim();
  } catch (error) {
    return {
      ok: false,
      error: `Failed to resolve ${node.base} tip: ${errorMessage(error)}`,
      branch: node.branch,
      worktree: worktreePath,
    };
  }

  // Plan one level at a time so each level sees its parent's updated tip.
  const plan = planStackRebase([node], { [node.base]: baseTip });
  const step = plan.steps[0];
  if (step === undefined) return { ok: true, rebased: false, skipped: plan.skipped };

  const stashed = options.stash && isWorktreeDirty(git, worktreePath);
  if (stashed) {
    try {
      git(
        ["stash", "push", "--include-untracked", "-m", `belayd-stack-rebase ${node.branch}`],
        worktreePath,
      );
    } catch (error) {
      return {
        ok: false,
        error: `Failed to stash changes in ${worktreePath}: ${errorMessage(error)}`,
        branch: node.branch,
        worktree: worktreePath,
      };
    }
  }

  try {
    git(["rebase", "--onto", baseTip, step.forkPoint, node.branch], worktreePath);
  } catch (error) {
    // Leave any stash in place: the worktree is mid-rebase and popping onto a
    // conflicted tree would lose or duplicate work.
    return {
      ok: false,
      error: `git rebase --onto failed for ${node.branch}: ${errorMessage(error)}`,
      branch: node.branch,
      worktree: worktreePath,
      conflicts: true,
      stashed,
    };
  }

  if (stashed) {
    try {
      git(["stash", "pop"], worktreePath);
    } catch (error) {
      return {
        ok: false,
        error: `Rebase succeeded but restoring stashed changes failed for ${node.branch}: ${errorMessage(error)}`,
        branch: node.branch,
        worktree: worktreePath,
        conflicts: true,
        stashed: true,
        stashPopConflicted: true,
      };
    }
  }

  // The parent tip is the new fork point; refreshing it keeps the next
  // `belayd_stack_rebase` a no-op instead of replaying the same commits.
  try {
    git(["config", `branch.${node.branch}.belaydForkPoint`, baseTip], options.cwd);
  } catch {
    // Best-effort; a stale fork point only causes a redundant (idempotent) replay.
  }
  return { ok: true, rebased: true, skipped: [] };
}

/** Outcome of a stack rebase, with errors as values. */
export type StackRebaseResult =
  | { ok: true; rebased: string[]; skipped: StackRebaseSkip[] }
  | {
      ok: false;
      error: string;
      branch?: string;
      worktree?: string;
      conflicts?: boolean;
      /** A pre-rebase stash entry still exists and needs `git stash` recovery. */
      stashed?: boolean;
      /** The rebase succeeded but `git stash pop` conflicted (changes applied). */
      stashPopConflicted?: boolean;
    };

/**
 * Replay a stack leaf (and its parents) onto their current bases, deepest
 * first. Each branch is rebased inside its own worktree so a multi-worktree
 * stack never fights over the checked-out branch.
 *
 * `forceLanded` is the explicit "my parent landed" signal: it overrides the
 * leaf's base to `main` even when the parent ref still exists (the squash-merge
 * case, where ancestry cannot prove the merge happened). Only the leaf is
 * rewritten; intermediate parents keep their own recorded bases and are still
 * replayed in order, so a 3-deep stack lands stepwise rather than all at once.
 */
export function runStackRebase(
  git: GitExec,
  options: { cwd: string; leaf: string; stash?: boolean; forceLanded?: boolean },
): StackRebaseResult {
  const resolved = resolveStackChain(options.cwd, options.leaf, git);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  let chain = resolved.chain;
  if (chain.length === 0) return { ok: true, rebased: [], skipped: [] };

  if (options.forceLanded === true) {
    const last = chain[chain.length - 1];
    if (last !== undefined && last.landedParent === undefined) {
      chain = [
        ...chain.slice(0, -1),
        { ...last, base: DEFAULT_BASE_BRANCH, landedParent: last.base },
      ];
    }
  }

  let worktrees: Map<string, string>;
  try {
    worktrees = parseWorktreeList(git(["worktree", "list", "--porcelain"], options.cwd));
  } catch (error) {
    return { ok: false, error: `Failed to list worktrees: ${errorMessage(error)}` };
  }

  const rebased: string[] = [];
  const skipped: StackRebaseSkip[] = [];

  for (const node of chain) {
    const worktreePath = worktrees.get(node.branch);
    if (worktreePath === undefined) {
      skipped.push({ branch: node.branch, reason: "no-worktree" });
      continue;
    }

    const outcome = rebaseStackNode(git, {
      cwd: options.cwd,
      node,
      worktreePath,
      stash: options.stash === true,
    });
    if (!outcome.ok) return outcome;
    if (outcome.rebased) rebased.push(node.branch);
    skipped.push(...outcome.skipped);
  }

  return { ok: true, rebased, skipped };
}

function isFalsyEnvValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}

function isFalsyConfigValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off"
  );
}

/**
 * Whether the automatic pre-commit stack rebase is enabled. The env var wins
 * over git config so a single session can opt out without editing the repo;
 * default is enabled.
 */
export function resolveAutoRebaseEnabled(
  cwd: string,
  exec: GitExec = defaultGitExec,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const envValue = env[AUTO_REBASE_ENV_KEY];
  if (envValue !== undefined) return !isFalsyEnvValue(envValue);

  const configured = gitConfigGet(cwd, AUTO_REBASE_CONFIG_KEY, exec);
  if (configured !== undefined) return !isFalsyConfigValue(configured);

  return true;
}
