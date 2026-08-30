/**
 * Worktree file guard — pi project-level extension.
 *
 * Auto-discovered by pi from `.pi/extensions/` or `pi.extensions` in package.json.
 *
 * Detects when running inside a git linked worktree (where `.git` is a file,
 * not a directory) and blocks `edit`/`write` operations that target paths
 * outside the worktree root. This prevents subagents from accidentally
 * writing files to the main repository.
 *
 * The guard activates in ALL sessions (orchestrator and subagent). It has
 * zero runtime cost in the main repository — detection is a single stat call
 * at load time, and if we're not in a worktree, no event handlers are registered.
 */

import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

// ── Static detection at load time ─────────────────────────────────────
const cwd = process.cwd();
const isLinkedWorktree = detectLinkedWorktree(cwd);

/**
 * Check whether the given directory is a git linked worktree.
 *
 * In a normal git repository, `.git` is a directory.
 * In a linked worktree (created by `git worktree add` or `wt switch`),
 * `.git` is a regular file containing `gitdir: /path/to/main/.git/worktrees/<name>`.
 */
function detectLinkedWorktree(dir: string): boolean {
  try {
    const gitPath = resolve(dir, ".git");
    return existsSync(gitPath) && lstatSync(gitPath).isFile();
  } catch {
    return false;
  }
}

/** Resolve a tool-provided path to an absolute path relative to the worktree root. */
function resolveFilePath(rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
}

/** Check whether a resolved absolute path is within the worktree root. */
function isWithinWorktree(filePath: string): boolean {
  return filePath.startsWith(`${cwd}/`) || filePath === cwd;
}

// ── Extension factory ──────────────────────────────────────────────────

// The same guard ships globally (~/.pi/agent/extensions/belayd-worktree-guard.ts)
// and project-locally (.pi/settings.json). When both load in one process the
// event handler would be registered twice. The process-wide marker dedupes:
// the first copy wins, the second returns before registering handlers. It is
// only set once the worktree check passes so a non-worktree load never marks
// the guard as active.
const WORKTREE_GUARD_LOAD_MARKER = "__belayd_worktree_guard_loaded__";

function worktreeGuardAlreadyLoaded(): boolean {
  return (globalThis as Record<string, unknown>)[WORKTREE_GUARD_LOAD_MARKER] === true;
}

function markWorktreeGuardLoaded(): void {
  (globalThis as Record<string, unknown>)[WORKTREE_GUARD_LOAD_MARKER] = true;
}

export default function worktreeGuardExtension(pi: ExtensionAPI): void {
  if (!isLinkedWorktree) return;
  if (worktreeGuardAlreadyLoaded()) return;
  markWorktreeGuardLoaded();

  pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult => {
    const toolName = event.toolName;
    if (
      toolName !== "edit" &&
      toolName !== "write" &&
      toolName !== "Edit" &&
      toolName !== "Write"
    ) {
      return {};
    }

    // Support both `path` and `filePath` parameter naming (pi uses `path`,
    // but some tool schemas expose `filePath`)
    const input = event.input as { path?: string; filePath?: string } | undefined;
    const rawPath = input?.path ?? input?.filePath;
    if (!rawPath) return {};

    const resolved = resolveFilePath(rawPath);
    if (!isWithinWorktree(resolved)) {
      return {
        block: true,
        reason: `Cannot write outside the worktree. "${rawPath}" resolves to "${resolved}" which is outside "${cwd}".`,
      };
    }

    return {};
  });
}
