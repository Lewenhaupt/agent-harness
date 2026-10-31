/**
 * Workflow phases — canonical order, phase tool names, and the pure phase-list
 * helpers.
 *
 * Split out of `process-gate.ts` (bd-179) so modules that only need phase names
 * or `isWorkflowComplete` never import the gate itself. Capability modules are
 * forbidden from reaching `src/process-gate.ts`; the tool audit, the persisted
 * workflow state and fleet mode only ever needed this half, and the gate
 * re-exports it so its public surface is unchanged.
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
 * An open human question (bd-152).
 *
 * `beadId` is the work bead a `human` bd gate blocks and `askedAt` is when the
 * harness asked, in epoch ms. The state itself lives in the bd gate; this is the
 * in-memory mirror the gate needs to refuse phase tools.
 */
export interface AwaitingHuman {
  beadId: string;
  askedAt: number;
}
