/**
 * Bead ↔ branch ↔ worktree identity preflight.
 *
 * `belayd_start_task`, worktree creation, and the phase tools all read/write
 * the same `.belayd/workflow.json` contract. A phase run pointed at another
 * task's worktree used to be accepted silently: its sub-agents were then jailed
 * in the wrong tree by the worktree guard, and agents worked around the guard
 * instead of failing. These helpers refuse that mismatch before any run starts.
 */

import { execFileSync } from "node:child_process";
import { isValidTaskId } from "./session-naming.js";
import type { WorkflowState } from "./workflow-state.js";
import { readWorkflowState } from "./workflow-state.js";

/** Result of probing the branch checked out at a directory. */
export type WorktreeBranch =
  | { ok: true; branch: string }
  | { ok: false; reason: "detached" }
  | { ok: false; reason: "unavailable"; error: string };

/** Read the persisted workflow state for a directory. */
export type ReadWorkflowStateAtCwd = (cwd: string) => WorkflowState | undefined;

/** `undefined` means the branch could not be determined (git unavailable). */
export type OwnedWorktreeResult =
  | { ok: true; branch: string | undefined }
  | { ok: false; error: string };

/**
 * True when `suppliedTaskId` is the session task or a beads sub-bead of it.
 *
 * Both sides must be valid ids, so `bd-42x` / `bd-42.` never match `bd-42`.
 * A parent supplied from a sub-bead session is not a descendant and is
 * rejected, which keeps the ordering one-way.
 */
export function isSameOrDescendantTask(suppliedTaskId: string, sessionTaskId: string): boolean {
  if (suppliedTaskId === sessionTaskId) return true;
  if (!isValidTaskId(suppliedTaskId) || !isValidTaskId(sessionTaskId)) return false;
  return suppliedTaskId.startsWith(`${sessionTaskId}.`);
}

export interface MatchOwnedWorktreeOptions {
  cwd: string;
  taskId: string;
  /** Branch probe for `cwd`; distinguishes detached HEAD from git failure. */
  branch: WorktreeBranch;
  /** Persisted `.belayd/workflow.json`, or undefined when there is none. */
  persisted: WorkflowState | undefined;
}

export interface SessionOwnedWorktreeOptions {
  cwd: string;
  currentTaskId: string;
  gateActive: boolean;
  branch: WorktreeBranch;
  persisted: WorkflowState | undefined;
}

export interface AssertOwnedWorktreeOptions {
  cwd: string;
  taskId: string;
  branch: WorktreeBranch;
  /** Test seam for the workflow-state read. */
  readState?: ReadWorkflowStateAtCwd;
}

function persistedBranchLabel(branch: string): string {
  return branch === "" ? "detached HEAD" : branch;
}

function preambleBranchLabel(branch: WorktreeBranch): string | undefined {
  if (branch.ok) return branch.branch;
  return branch.reason === "detached" ? "detached HEAD" : undefined;
}

function foreignOwnerError(cwd: string, persisted: WorkflowState): string {
  return (
    `${persisted.taskId} owns ${cwd} (branch ${persistedBranchLabel(persisted.branch)}) — ` +
    `start ${persisted.taskId} or run this phase from your own worktree.`
  );
}

/**
 * Pure identity matcher: the persisted workflow must belong to `taskId` and,
 * when the workflow recorded a branch, `cwd` must be on that branch.
 *
 * An empty persisted branch is a legacy/unpinned state (written before branch
 * tracking or by an in-place workflow started outside git); task identity still
 * has to match, but there is no branch to compare against.
 */
export function matchOwnedWorktree(options: MatchOwnedWorktreeOptions): OwnedWorktreeResult {
  const { cwd, taskId, branch, persisted } = options;

  if (persisted === undefined) {
    return {
      ok: false,
      error:
        `No Belayd workflow state in ${cwd}; cannot run ${taskId} here — ` +
        `use the orchestrator that owns that worktree.`,
    };
  }

  if (persisted.taskId !== taskId) {
    return {
      ok: false,
      error:
        `${persisted.taskId} lives in ${cwd} (branch ${persistedBranchLabel(persisted.branch)}); ` +
        `this session is for ${taskId} — use the orchestrator that owns ${taskId}'s worktree.`,
    };
  }

  if (persisted.branch === "") {
    return { ok: true, branch: preambleBranchLabel(branch) };
  }

  if (!branch.ok && branch.reason === "detached") {
    return {
      ok: false,
      error:
        `${persisted.taskId} lives in ${cwd} (branch ${persisted.branch}); ` +
        `this session is in detached HEAD — check out ${persisted.branch} in ${cwd}.`,
    };
  }

  if (!branch.ok) {
    return {
      ok: false,
      error:
        `${persisted.taskId} lives in ${cwd} (branch ${persisted.branch}); ` +
        `could not read the branch here (${branch.error}) — ` +
        `run from a checkout of ${persisted.branch}.`,
    };
  }

  if (branch.branch !== persisted.branch) {
    return {
      ok: false,
      error:
        `${persisted.taskId} lives in ${cwd} (branch ${persisted.branch}); ` +
        `this session is in ${cwd} (branch ${branch.branch}) — ` +
        `use the orchestrator that owns that worktree.`,
    };
  }

  return { ok: true, branch: branch.branch };
}

/**
 * Session-aware matcher. A post-completion rework call (gate off, no workflow
 * state) is allowed, but any workflow state in `cwd` still pins that tree to
 * its owner even when this session has no active task.
 */
export function matchSessionOwnedWorktree(
  options: SessionOwnedWorktreeOptions,
): OwnedWorktreeResult {
  const { cwd, currentTaskId, gateActive, branch, persisted } = options;

  if (currentTaskId === "") {
    if (persisted === undefined) {
      return { ok: true, branch: preambleBranchLabel(branch) };
    }
    return { ok: false, error: foreignOwnerError(cwd, persisted) };
  }

  if (!gateActive && persisted === undefined) {
    return { ok: true, branch: preambleBranchLabel(branch) };
  }

  return matchOwnedWorktree({ cwd, taskId: currentTaskId, branch, persisted });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the checked-out branch with `git branch --show-current`.
 *
 * Side effect: one synchronous git child process. An empty result is a
 * detached HEAD, while a git failure (no repository, missing binary) is
 * reported separately so callers can give the right recovery instructions.
 */
export function readWorktreeBranch(cwd: string): WorktreeBranch {
  try {
    const output = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      timeout: 10_000,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    return output === "" ? { ok: false, reason: "detached" } : { ok: true, branch: output };
  } catch (error) {
    return { ok: false, reason: "unavailable", error: errorMessage(error) };
  }
}

/** Assert that `cwd` is the worktree that owns `taskId` and `branch`. */
export function assertOwnedWorktree(options: AssertOwnedWorktreeOptions): OwnedWorktreeResult {
  const readState: ReadWorkflowStateAtCwd =
    options.readState ?? ((cwd) => readWorkflowState({ cwd }));
  return matchOwnedWorktree({
    cwd: options.cwd,
    taskId: options.taskId,
    branch: options.branch,
    persisted: readState(options.cwd),
  });
}

/** One-line preamble pinned into every spawned phase prompt. */
export function formatWorktreePreamble(options: {
  cwd: string;
  branch: string | undefined;
}): string {
  const branchClause =
    options.branch === undefined ? "" : ` on ${persistedBranchLabel(options.branch)}`;
  return (
    `Your worktree is ${options.cwd}${branchClause}; ` +
    `writing elsewhere is a bug, not a workaround.`
  );
}
