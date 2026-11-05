/**
 * Stale-file guard pi extension — standalone entry point for bundling.
 *
 * Auto-discovered by pi from `.pi/extensions/`.
 *
 * Tracks which files have been read (by content hash) and blocks edit/write
 * operations when the file has changed since the last read.
 *
 * This is a re-export of the extension currently at
 * .pi/extensions/stale-file-guard.ts in the monorepo, adapted to import
 * from the local src/ instead of a monorepo-relative path.
 */

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";

import { checkEdit, clearHashes, recordRead } from "../src/stale-file-guard.js";

// The same guard ships globally (~/.pi/agent/extensions/belayd-stale-file-guard.ts)
// and project-locally (.pi/settings.json). When both load in one process the
// event handlers would be registered twice. The process-wide marker dedupes:
// the first copy wins, the second returns before registering handlers.
//
// Load order makes an out-of-date global copy worse than a duplicate: a copy
// that still reads only `input.filePath` is a silent no-op, and because it
// usually loads first it permanently disables the fixed local copy for the
// process. Any change to the guard's input contract therefore requires
// redeploying the global copy in lockstep — otherwise the fix has no effect on
// machines still running the older one.
const STALE_GUARD_LOAD_MARKER = "__belayd_stale_file_guard_loaded__";

function staleGuardAlreadyLoaded(): boolean {
  return (globalThis as Record<string, unknown>)[STALE_GUARD_LOAD_MARKER] === true;
}

function markStaleGuardLoaded(): void {
  (globalThis as Record<string, unknown>)[STALE_GUARD_LOAD_MARKER] = true;
}

/**
 * Extracts the edit target path from a pi tool_call input.
 *
 * pi-coding-agent 1.0.x `EditToolInput` is `{ path, edits: [{ oldText, newText }] }`;
 * the pre-1.0 `{ filePath, oldText }` shape no longer exists, so reading only
 * `filePath` silently turned the stale-edit guard into a no-op. `filePath` is
 * still accepted because other tool schemas (and older pi versions) expose it,
 * matching `extensions/worktree-guard.ts`.
 *
 * Exported so the extraction is unit-testable without driving a handler.
 */
export function extractEditPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const candidate = input as { path?: unknown; filePath?: unknown };
  const path = typeof candidate.path === "string" ? candidate.path : candidate.filePath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

export default function staleFileGuardExtension(pi: ExtensionAPI): void {
  if (staleGuardAlreadyLoaded()) return;
  markStaleGuardLoaded();

  // Intercept tool_result events to record reads
  pi.on("tool_result", (event: ToolResultEvent) => {
    if (event.toolName === "read" || event.toolName === "Read") {
      const input = event.input as { path?: unknown } | undefined;
      const path = typeof input?.path === "string" ? input.path : undefined;

      if (path) {
        const content = event.content
          .filter((item): item is { type: "text"; text: string } => item.type === "text")
          .map((item) => item.text)
          .join("");

        if (content) {
          recordRead(path, content);
        }
      }
    }

    return {};
  });

  // Intercept tool_call events to block stale edits
  pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult => {
    if (event.toolName === "edit" || event.toolName === "Edit") {
      const filePath = extractEditPath(event.input);

      if (filePath) {
        const result = checkEdit(filePath);
        if (!result.allowed) {
          return { block: true, reason: result.reason ?? "File has changed since read" };
        }
      }
    }

    return {};
  });

  // Intercept tool_call events to block git --no-verify
  pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult => {
    if (event.toolName === "bash" || event.toolName === "Bash") {
      const command = ((event.input as { command?: string })?.command ?? "").trim();

      if (command.includes("git") && command.includes("--no-verify")) {
        return {
          block: true,
          reason:
            "git --no-verify is not allowed. Pre-commit hooks (lefthook) must run on every commit.",
        };
      }
    }

    return {};
  });

  // Intercept bash execution to clear all tracked hashes (conservative invalidation)
  pi.on("user_bash", (_event: UserBashEvent): void => {
    clearHashes();
  });
}
