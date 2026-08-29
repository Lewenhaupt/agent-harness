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
  if (!/^bd-[a-z0-9]+$/i.test(taskId)) {
    throw new Error("taskId must follow the beads ID pattern (e.g. bd-42)");
  }
  return `belayd-${taskId}-sub-${phaseName}-${shortRunId}`;
}

/** Compute the orchestrator session name: belayd-{taskId}. */
export function computeOrchestratorSessionName(taskId: string): string {
  if (!taskId || typeof taskId !== "string") {
    throw new Error("taskId must be a non-empty string");
  }
  if (!/^bd-[a-z0-9]+$/i.test(taskId)) {
    throw new Error("taskId must follow the beads ID pattern (e.g. bd-42)");
  }
  return `belayd-${taskId}`;
}
