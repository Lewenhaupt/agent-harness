/**
 * Session naming utilities for subagent session management.
 *
 * Deterministically computes session names for orchestrator and subagent
 * sessions, enabling users to list, inspect, and resume sessions via `pi --resume`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Generate a short unique run identifier (derived from timestamp). */
export function generateShortRunId(): string {
  return Date.now().toString(36);
}

/**
 * Beads issue IDs look like `bd-42`; subtasks use dotted notation
 * (`bd-42.1`, `bd-42.1.2`). Dots are the only extension beyond the base
 * `bd-N` shape.
 */
const TASK_ID_PATTERN = /^bd-[a-z0-9]+(?:\.[a-z0-9]+)*$/i;

/**
 * True when `taskId` matches the beads issue/subtask ID pattern.
 * Accepts `bd-42` and `bd-42.1` (subtasks).
 */
export function isValidTaskId(taskId: string): boolean {
  return typeof taskId === "string" && TASK_ID_PATTERN.test(taskId);
}

/** Compute a subagent session name: belayd-{taskId}-{phase}-{shortRunId}. */
export function computeSubagentSessionName(
  taskId: string,
  phaseName: string,
  shortRunId: string,
): string {
  if (!taskId || typeof taskId !== "string") {
    throw new Error("taskId must be a non-empty string");
  }
  if (!phaseName || typeof phaseName !== "string") {
    throw new Error("phaseName must be a non-empty string");
  }
  if (!shortRunId || typeof shortRunId !== "string") {
    throw new Error("shortRunId must be a non-empty string");
  }
  if (!isValidTaskId(taskId)) {
    throw new Error("taskId must follow the beads ID pattern (e.g. bd-42, bd-42.1)");
  }
  return `belayd-${taskId}-sub-${phaseName}-${shortRunId}`;
}

/** Compute the orchestrator session name: belayd-{taskId}. */
export function computeOrchestratorSessionName(taskId: string): string {
  if (!taskId || typeof taskId !== "string") {
    throw new Error("taskId must be a non-empty string");
  }
  if (!isValidTaskId(taskId)) {
    throw new Error("taskId must follow the beads ID pattern (e.g. bd-42, bd-42.1)");
  }
  return `belayd-${taskId}`;
}

/**
 * Compute a planning sub-agent session name:
 * belayd-planning-sub-{phaseName}-{shortRunId}.
 *
 * Planning runs are not tied to a task ID (planning happens before a bead
 * exists), so unlike computeSubagentSessionName there is no taskId segment
 * or task-id validation.
 */
export function computePlanningSubagentSessionName(phaseName: string, shortRunId: string): string {
  if (!phaseName || typeof phaseName !== "string") {
    throw new Error("phaseName must be a non-empty string");
  }
  if (!shortRunId || typeof shortRunId !== "string") {
    throw new Error("shortRunId must be a non-empty string");
  }
  return `belayd-planning-sub-${phaseName}-${shortRunId}`;
}

/**
 * Number of consecutive quality-gate retries that resume the same pi session.
 *
 * Resuming replays the prior transcript, so retries are grouped into
 * two-attempt epochs: the opening segment (attempts 1..LIMIT) resumes the
 * original session from the initial spawn, then every later epoch mints a
 * fresh `-retry-<n>` session on its first attempt and resumes it on its second.
 * The fresh epoch bounds transcript growth while still letting the agent see
 * what it already tried.
 */
export const IN_SESSION_RETRY_LIMIT = 2;

/**
 * Resolve the session name and resume flag for a quality-gate retry attempt.
 *
 * Attempts 1..IN_SESSION_RETRY_LIMIT resume `base` (the initial spawn's
 * session, which already exists). Attempt 3 starts a fresh epoch at
 * `base-retry-3`; attempt 4 resumes it; attempt 5 starts `base-retry-5`; and so
 * on with two-attempt epochs. Resuming relies on pi's create-or-resume
 * `--session-id` behaviour; the spawn layer falls back to a fresh session when
 * the target does not exist.
 */
export function gateRetrySession(
  base: string,
  attempt: number,
): { sessionName: string; resumeSession: boolean } {
  if (!base || typeof base !== "string") {
    throw new Error("base must be a non-empty string");
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }
  if (attempt <= IN_SESSION_RETRY_LIMIT) {
    return { sessionName: base, resumeSession: true };
  }
  // Epoch length is 2: the first attempt mints a fresh session, the second
  // resumes it. Both share the first attempt's `-retry-<odd>` name.
  if (attempt % 2 === 1) {
    return { sessionName: `${base}-retry-${attempt}`, resumeSession: false };
  }
  return { sessionName: `${base}-retry-${attempt - 1}`, resumeSession: true };
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(dir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  return dir;
}

/**
 * Encode a working directory the way pi does for project session folders:
 * `--<path>--`, with the leading separator and every `/`, `\`, and `:` replaced
 * by `-`. Mirrors getDefaultSessionDirPath in pi's session-manager.
 */
function projectSessionSlug(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Read `sessionDir` from `<agentDir>/settings.json` when present.
 *
 * Total: any missing file, unreadable file, malformed JSON, or non-string
 * value yields undefined so the caller falls back to the default location.
 */
function readSettingsSessionDir(agentDir: string): string | undefined {
  try {
    const raw = readFileSync(join(agentDir, "settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = (parsed as { sessionDir?: unknown }).sessionDir;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when `dir` holds a pi session file whose header id matches `sessionId`.
 *
 * pi resolves `--session-id` by the exact `id` in a session file's first line
 * (the header), not by filename. Matching the header avoids false positives
 * from suffix collisions when an id contains `_`. Files whose header cannot be
 * parsed or lacks a string id never match.
 */
function sessionFileExists(dir: string, sessionId: string): boolean {
  if (!existsSync(dir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((name) => {
    if (!name.endsWith(".jsonl")) return false;
    try {
      const firstLine = readFileSync(join(dir, name), "utf-8").split("\n", 1)[0] ?? "";
      const header = JSON.parse(firstLine) as unknown;
      if (typeof header !== "object" || header === null) return false;
      return (header as { id?: unknown }).id === sessionId;
    } catch {
      return false;
    }
  });
}

/**
 * Resolve whether a project session with `sessionId` already exists on disk.
 *
 * pi stores sessions as `~/.pi/agent/sessions/<project-slug>/<ts>_<id>.jsonl`.
 * Resolution mirrors pi, in priority order:
 *   1. `PI_CODING_AGENT_SESSION_DIR` (non-empty) — files live directly there.
 *   2. `sessionDir` in `<agentDir>/settings.json` when it is a string.
 *   3. `<agentDir>/sessions/<project-slug>/`, where `agentDir` is
 *      `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`.
 * Returns false when the directory or session cannot be read — the caller then
 * falls back to a fresh session.
 *
 * Note: pi derives these env-var names from `piConfig.name`. The harness
 * assumes the default `pi` app name (this repo does not set `piConfig.name`),
 * so `PI_CODING_AGENT_*` are the correct overrides; a renamed app would use a
 * different prefix.
 */
export function resolveProjectSessionExists(
  sessionId: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): boolean {
  if (!sessionId || typeof sessionId !== "string") return false;
  const env = opts?.env ?? process.env;
  const sessionDirOverride = env.PI_CODING_AGENT_SESSION_DIR;
  if (sessionDirOverride !== undefined && sessionDirOverride !== "") {
    return sessionFileExists(expandHome(sessionDirOverride), sessionId);
  }
  const agentDirOverride = env.PI_CODING_AGENT_DIR;
  const agentDir =
    agentDirOverride !== undefined && agentDirOverride !== ""
      ? expandHome(agentDirOverride)
      : join(homedir(), ".pi", "agent");

  const settingsSessionDir = readSettingsSessionDir(agentDir);
  if (settingsSessionDir !== undefined && settingsSessionDir !== "") {
    return sessionFileExists(expandHome(settingsSessionDir), sessionId);
  }

  return sessionFileExists(
    join(agentDir, "sessions", projectSessionSlug(opts?.cwd ?? process.cwd())),
    sessionId,
  );
}
