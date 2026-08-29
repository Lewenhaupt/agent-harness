/**
 * Process gate — enforces mandatory phase order for Belayd tasks.
 *
 * The gate is dormant by default (`active = false`). Only activates when
 * `belayd_start_task` is called. Once active, agents must complete phases
 * in strict order: scout → plan → implement → review → test → userguide → proof → commit.
 *
 * All functions accept an optional `phaseOrder` parameter to support
 * workflow sub-types with custom phase sequences.
 */

/** The canonical phase order (all 8 phases). */
export const PHASE_ORDER = [
  "scout",
  "plan",
  "implement",
  "review",
  "test",
  "userguide",
  "proof",
  "commit",
] as const;

/** Valid phase names. */
export type Phase = (typeof PHASE_ORDER)[number];

/** All phase names as a const array. */
export const ALL_PHASE_NAMES: readonly string[] = [
  "scout",
  "plan",
  "implement",
  "review",
  "test",
  "userguide",
  "proof",
  "commit",
] as const;

/** All phase tool names, e.g. "belayd_scout". */
export const ALL_PHASE_TOOLS: readonly string[] = ALL_PHASE_NAMES.map((p) => `belayd_${p}`);

/** The pi tool names for each phase, e.g. "belayd_scout". */
export const PHASE_TOOLS: string[] = PHASE_ORDER.map((p) => `belayd_${p}`);

/** Reverse lookup: tool name → zero-based index in PHASE_ORDER. */
export const PHASE_INDEX: Record<string, number> = {};
PHASE_ORDER.forEach((phase, index) => {
  PHASE_INDEX[`belayd_${phase}`] = index;
});

/**
 * Check whether a tool call is allowed at this point in the process.
 *
 * @param toolName - The pi tool name (e.g. "belayd_review")
 * @param completed - Phases already completed
 * @param active - Whether the gate is active
 * @param phaseOrder - Optional phase order (defaults to PHASE_ORDER)
 * @param workflowType - Optional workflow type name for error messages
 * @param optionalPhases - Optional list of phases that can be skipped
 * @returns `{ allowed: true, reason: undefined }` if allowed,
 *          `{ allowed: false, reason: string }` if blocked
 */
export function checkToolAllowed(
  toolName: string,
  completed: string[],
  active: boolean,
  phaseOrder?: readonly string[],
  workflowType?: string,
  optionalPhases?: readonly string[],
): { allowed: boolean; reason?: string } {
  if (!active) return { allowed: true };

  const order = phaseOrder ?? PHASE_ORDER;
  const optional = optionalPhases ?? [];

  // Extract phase name from tool name (e.g., "belayd_scout" → "scout")
  const toolBase = toolName.startsWith("belayd_") ? toolName.slice(7) : "";
  const idx = order.indexOf(toolBase);

  if (idx === -1) {
    // If it's a known phase tool excluded from this workflow, block it explicitly
    if (ALL_PHASE_NAMES.includes(toolBase)) {
      return {
        allowed: false,
        reason: `${toolName} is not part of the ${workflowType ?? "current"} workflow.`,
      };
    }
    return { allowed: true }; // genuinely not a phase tool (e.g., read, grep)
  }

  const previousPhases = order.slice(0, idx);
  for (const p of previousPhases) {
    // Optional phases don't block subsequent phases
    if (optional.includes(p)) continue;
    if (!completed.includes(p)) {
      return {
        allowed: false,
        reason: `Cannot run ${toolName} yet. "${p}" must complete first.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Mark a phase as completed. Only call this AFTER checkToolAllowed returned true.
 *
 * @param toolName - The pi tool name (e.g. "belayd_scout")
 * @param completed - Phases already completed
 * @param phaseOrder - Optional phase order (defaults to PHASE_ORDER)
 * @returns Updated completed array with the new phase appended
 */
export function markPhaseCompleted(
  toolName: string,
  completed: string[],
  phaseOrder?: readonly string[],
): string[] {
  const order = phaseOrder ?? PHASE_ORDER;
  const phase = toolName.startsWith("belayd_") ? toolName.slice(7) : toolName;
  const idx = order.indexOf(phase);
  if (idx === -1) return completed;
  if (completed.includes(phase)) return completed;
  return [...completed, phase];
}

/**
 * Check if the workflow has completed all phases.
 *
 * @param completed - Phases already completed
 * @param phaseOrder - Optional phase order (defaults to PHASE_ORDER)
 */
export function isWorkflowComplete(completed: string[], phaseOrder?: readonly string[]): boolean {
  const order = phaseOrder ?? PHASE_ORDER;
  for (const phase of order) {
    if (!completed.includes(phase)) return false;
  }
  return true;
}

/**
 * Get the next incomplete phase.
 *
 * @param completed - Phases already completed
 * @param phaseOrder - Optional phase order (defaults to PHASE_ORDER)
 */
export function getNextPhase(
  completed: string[],
  phaseOrder?: readonly string[],
): Phase | undefined {
  const order = phaseOrder ?? PHASE_ORDER;
  for (const phase of order) {
    if (!completed.includes(phase)) return phase as Phase;
  }
  return undefined;
}

/**
 * Get a human-readable summary of the process state.
 *
 * @param completed - Phases already completed
 * @param taskId - Task ID for display
 * @param phaseOrder - Optional phase order (defaults to PHASE_ORDER)
 */
export function formatProcessState(
  completed: string[],
  taskId: string,
  phaseOrder?: readonly string[],
): string {
  const order = phaseOrder ?? PHASE_ORDER;
  const lines: string[] = [];
  lines.push(`**Process state for ${taskId}**`);
  lines.push("");
  for (const phase of order) {
    const done = completed.includes(phase);
    lines.push(`- ${done ? "✅" : "⬜"} \`belayd_${phase}\` — ${phase}`);
  }
  return lines.join("\n");
}
