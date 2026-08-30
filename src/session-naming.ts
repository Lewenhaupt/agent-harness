/**
 * Session naming utilities for subagent session management.
 *
 * Deterministically computes session names for orchestrator and subagent
 * sessions, enabling users to list, inspect, and resume sessions via `pi --resume`.
 */

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
