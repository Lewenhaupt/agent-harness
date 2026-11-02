/**
 * Read-only `git worktree list` probe and its porcelain parsers (bd-126).
 *
 * This is a leaf module (only `node:` imports) on purpose: the AWS credential
 * broker runs its entry points straight from TypeScript under Node 24's native
 * type stripping (see `src/aws-broker/main.ts`), which resolves literal
 * specifiers only — importing `src/worktree.ts` from there would drag in
 * `.js`-specifier project modules that exist only after `tsc`. `src/worktree.ts`
 * re-exports everything here, so its importers keep one entry point.
 *
 * The AWS broker uses the main-worktree fact to derive a repository's identity:
 * every linked worktree of one repo reports the same main worktree, which is
 * what lets one allowlist scope cover all of them (bd-220).
 */

import { execFileSync } from "node:child_process";

/** One entry of `git worktree list --porcelain` (bd-126 fleet status). */
export interface WorktreeListEntry {
  path: string;
  /** Branch checked out here; undefined on detached HEAD. */
  branch: string | undefined;
  /**
   * git lists the main worktree first. Only the main worktree can check out the
   * base branch (`main`), which is why fleet merges happen in the operator's
   * own checkout (docs/fleet-orchestrator.md).
   */
  isMainWorktree: boolean;
}

/** Parsed worktree list plus the records the parser had to skip. */
export interface ParsedWorktreeList {
  entries: WorktreeListEntry[];
  /** Human-readable warnings for records that could not be represented. */
  warnings: string[];
}

/** Discriminated result of enumerating registered worktrees. */
export type WorktreeListResult =
  | { ok: true; entries: WorktreeListEntry[]; warnings: string[] }
  | { ok: false; error: string };

/**
 * Parse `git worktree list --porcelain -z` (NUL-separated, git >= 2.36).
 *
 * This is the primary form because a worktree path may contain a newline (legal
 * on Linux): with NUL separators the newline is just a byte inside the
 * `worktree` value, whereas the line-oriented form splits the record and
 * silently truncates the path. git does not C-quote these values, so there is
 * nothing to unquote here.
 */
export function parseWorktreeListPorcelainZ(output: string): ParsedWorktreeList {
  const entries: WorktreeListEntry[] = [];
  let recordIndex = 0;
  let path: string | undefined;
  let branch: string | undefined;

  const flush = (): void => {
    if (path === undefined) return;
    entries.push({ path, branch, isMainWorktree: recordIndex === 0 });
    recordIndex += 1;
    path = undefined;
    branch = undefined;
  };

  // `-z` NUL-terminates every field and closes a record with an empty field.
  for (const field of output.split("\0")) {
    if (field === "") {
      flush();
      continue;
    }
    if (field.startsWith("worktree ")) {
      path = field.slice("worktree ".length);
      continue;
    }
    if (field.startsWith("branch refs/heads/")) {
      branch = field.slice("branch refs/heads/".length);
    }
    // HEAD/detached/bare/locked/prunable carry no path information.
  }
  flush();

  return { entries, warnings: [] };
}

/** Recognized non-path keys in the line-oriented porcelain form. */
function isPorcelainKeyLine(line: string): boolean {
  return (
    line === "bare" ||
    line === "detached" ||
    line.startsWith("HEAD ") ||
    line.startsWith("branch ") ||
    line.startsWith("locked") ||
    line.startsWith("prunable")
  );
}

/**
 * Parse line-oriented `git worktree list --porcelain` (fallback for git < 2.36).
 *
 * A path containing a newline spans two lines here and cannot be recovered. Such
 * a record is skipped with a warning rather than accepted truncated: a truncated
 * path would read as `missing-workflow-state` for a worktree that exists, which
 * is worse than an explicit warning. Prefer {@link parseWorktreeListPorcelainZ}.
 */
export function parseWorktreeListPorcelain(porcelain: string): ParsedWorktreeList {
  const entries: WorktreeListEntry[] = [];
  const warnings: string[] = [];
  let recordIndex = 0;

  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line !== "");
    if (lines.length === 0) continue;
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (pathLine === undefined) continue;

    const path = pathLine.slice("worktree ".length);
    const isFirstRecord = recordIndex === 0;
    recordIndex += 1;

    const unexpected = lines.filter((line) => line !== pathLine && !isPorcelainKeyLine(line));
    if (unexpected.length > 0) {
      warnings.push(
        `git worktree list entry ${JSON.stringify(path)} was skipped: non-key line(s) ` +
          `${JSON.stringify(unexpected.join("; "))} mean the path does not round-trip ` +
          "through line-oriented porcelain (likely a newline in the path; git >= 2.36 `-z` " +
          "is required)",
      );
      continue;
    }

    const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
    entries.push({
      path,
      branch: branchLine === undefined ? undefined : branchLine.slice("branch refs/heads/".length),
      isMainWorktree: isFirstRecord,
    });
  }

  return { entries, warnings };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * against them keeps the read-only git probes pinned to the passed `cwd`.
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

/** A read-only git probe bound to a directory: returns raw stdout. */
export type GitProbeExec = (cwd: string) => string;

function runGitWorktreeList(gitBinary: string, cwd: string, args: readonly string[]): string {
  return execFileSync(gitBinary, ["worktree", "list", ...args], {
    cwd,
    env: gitContextFreeEnv(),
    timeout: 10_000,
    encoding: "utf8",
    stdio: "pipe",
  });
}

/** NUL-separated probe (git >= 2.36): the primary, newline-safe form. */
function execGitWorktreeListZ(cwd: string): string {
  return runGitWorktreeList("git", cwd, ["--porcelain", "-z"]);
}

/** Line-oriented fallback for hosts whose git predates `-z` (2.36). */
function execGitWorktreeListLines(cwd: string): string {
  return runGitWorktreeList("git", cwd, ["--porcelain"]);
}

/** Injectable git probes for {@link listWorktrees} (tests avoid shelling out). */
export interface ListWorktreesDeps {
  /** NUL-separated probe seam (git >= 2.36). */
  execNul?: GitProbeExec;
  /** Line-oriented fallback seam for older git. */
  execLines?: GitProbeExec;
}

/**
 * Bind both `git worktree list` probes to one explicit git binary.
 *
 * Callers that already take a `gitBinary` override (`belayd-aws plan` and its
 * tests) pass the same one here, so a single stub executable serves every git
 * probe of a plan instead of only `rev-parse --show-toplevel`.
 */
export function worktreeListDepsFor(gitBinary: string): ListWorktreesDeps {
  return {
    execNul: (cwd) => runGitWorktreeList(gitBinary, cwd, ["--porcelain", "-z"]),
    execLines: (cwd) => runGitWorktreeList(gitBinary, cwd, ["--porcelain"]),
  };
}

/**
 * Enumerate every worktree registered for `projectRoot`'s repository.
 *
 * Read-only: one `git worktree list --porcelain -z` probe, falling back to the
 * line-oriented form only when `-z` is unavailable (git < 2.36). No mutation.
 * Returns an error value (not a throw) so callers can surface a refusal.
 */
export function listWorktrees(
  projectRoot: string,
  deps: ListWorktreesDeps = {},
): WorktreeListResult {
  const execNul = deps.execNul ?? execGitWorktreeListZ;
  const execLines = deps.execLines ?? execGitWorktreeListLines;

  try {
    const parsed = parseWorktreeListPorcelainZ(execNul(projectRoot));
    return { ok: true, entries: parsed.entries, warnings: parsed.warnings };
  } catch {
    // `-z` does not exist before git 2.36. Only the fallback's failure is
    // reported: the -z error is usually just "unknown switch `z'" and would
    // mask the real reason the repository could not be listed.
    try {
      const parsed = parseWorktreeListPorcelain(execLines(projectRoot));
      return { ok: true, entries: parsed.entries, warnings: parsed.warnings };
    } catch (error) {
      return {
        ok: false,
        error: `git worktree list failed in ${projectRoot}: ${errorMessage(error)}`,
      };
    }
  }
}
