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
  /**
   * Set only when this wait is the review gate of a record whose findings are
   * security-class (bd-183), and only for that record's round.
   *
   * why: an answer releases publication, so the recording must be bound to the
   * question that was asked. The record file lives in a shared worktree and
   * exists for every review, so "a sensitive record exists" is not a
   * discriminator — an unrelated `belayd_ask_human` reply in the same worktree
   * would release withheld findings (bd-183 review, Critical). Every other wait
   * (ask tool, restart discovery) leaves this unset, which keeps the fail-closed
   * behaviour: no marker means no recording and the record stays withheld.
   */
  reviewFindings?: { round: number };
  /**
   * Set when the wait asks only whether a review finding may be published
   * (bd-252).
   *
   * why: the publication answer decides what may appear in a PR body, and
   * withholding is already the default, so the answer cannot change whether
   * phase work is safe. Refusing every phase tool until it arrives stalled the
   * whole fix loop on findings that were not secret (bd-233). This marker scopes
   * the wait to the publish step; every other wait keeps refusing phase tools.
   *
   * Deliberately separate from `reviewFindings`: that field is the recording key
   * for a publication answer (bd-183) and must stay unset on restart discovery.
   */
  publicationOnly?: true;
}
