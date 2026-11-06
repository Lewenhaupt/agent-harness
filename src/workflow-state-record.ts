/**
 * The persisted workflow record: shapes, parsers and the claimability decision
 * (bd-281 extraction).
 *
 * These are the *record* facts — what a workflow state, a handoff marker and a
 * pending review scope contain, and whether a persisted workflow may claim a
 * worktree. They live apart from `src/workflow-state.ts` (which owns the store
 * wiring) so the one-shot importer can validate legacy files without importing
 * the module that imports it.
 *
 * The zod schemas stay the validation boundary in both directions: a legacy file
 * is parsed with exactly the schema the store's rows are parsed with, so the
 * migration cannot accept a shape the runtime would reject.
 */

import { z } from "zod";
import type { ReviewedUntrackedEntry } from "./review-context.js";
import type { PhaseSessionRecord } from "./session-naming.js";
import { isValidTaskId } from "./session-naming.js";
import { isWorkflowComplete } from "./workflow-phases.js";

/** Discriminator of the persisted record; a version bump is a migration, not a guess. */
export const WORKFLOW_STATE_SCHEMA_VERSION = 1;

const PhaseSessionRecordSchema = z.object({
  base: z.string(),
  invocations: z.number().int().positive(),
});

// Typed against the review-context entry so the persisted manifest can never
// drift from the shape the re-review filter reads (bd-228).
const ReviewedUntrackedEntrySchema: z.ZodType<ReviewedUntrackedEntry> = z.object({
  path: z.string(),
  blob: z.string(),
});

/**
 * Marker written into the *caller's* workflow state when it hands a workflow
 * off to an orchestrator session in another worktree. Its presence means the
 * caller no longer drives a workflow, so a restart must not re-arm its gate.
 */
const HandedOffMarkerSchema = z.object({
  taskId: z.string(),
  branch: z.string(),
  sessionId: z.string(),
});

const WorkflowStateSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_STATE_SCHEMA_VERSION),
  taskId: z.string(),
  workflowType: z.string(),
  // Provenance for the resolved type (bd-106). Optional so a workflow row
  // written before this change still parses.
  resolutionSource: z.enum(["arg", "label", "default"]).optional(),
  matchedLabel: z.string().optional(),
  branch: z.string(),
  originalCwd: z.string(),
  phaseOrder: z.array(z.string()),
  completedPhaseNames: z.array(z.string()),
  // Optional so a workflow row written before bd-81 still parses (undefined
  // ledger means every phase starts fresh on first invocation).
  phaseSessions: z.record(z.string(), PhaseSessionRecordSchema).optional(),
  // Optional so pre-bd-81 state parses; absent means the flag is derived from
  // the completed phase list on resume. Persisted so a late re-review after a
  // later phase completed still re-arms the resumable-fix directive.
  awaitingReviewResponse: z.boolean().optional(),
  // Revision covered by the most recent completed review (bd-113). A re-review
  // diffs from here, so it sees only the fix round. Optional so a workflow
  // written before bd-113 still parses.
  reviewedSha: z.string().optional(),
  // Untracked paths that review covered, with the blob hash at that moment
  // (bd-228). Recorded in the same write as `reviewedSha`; used only to drop an
  // already-reviewed new file from the next re-review.
  reviewedUntracked: z.array(ReviewedUntrackedEntrySchema).optional(),
  // Set when this session handed its workflow off to a child orchestrator
  // (see launchWorktreeWorkflow). Optional so every workflow written before
  // bd-120 still parses.
  handedOffTo: HandedOffMarkerSchema.optional(),
  /**
   * Awaiting-human / gate state. bd keeps owning gates; the harness records which
   * gate it opened so "Needs you" can read the same fact.
   */
  awaitingHuman: z.unknown().optional(),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

/**
 * The working-tree state a review task was built from (bd-228). Captured
 * before the review reads the diff and consumed when that same review
 * succeeds, so "what the reviewer saw" is what the next re-review diffs from.
 */
const ReviewScopeSchema = z.object({
  taskId: z.string(),
  sha: z.string(),
  untracked: z.array(ReviewedUntrackedEntrySchema),
  capturedAt: z.number().finite(),
});

export type ReviewScope = z.infer<typeof ReviewScopeSchema>;

export type HandedOffMarker = z.infer<typeof HandedOffMarkerSchema>;

/** The persisted phase-session ledger entry, re-exported for callers. */
export type PersistedPhaseSessionRecord = PhaseSessionRecord;

/**
 * Parse and strictly narrow a workflow record. An unknown shape, a wrong schema
 * version and an unreadable record all yield undefined — callers treat that as
 * "no state".
 */
export function parseWorkflowState(raw: unknown): WorkflowState | undefined {
  const result = WorkflowStateSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** Parse a caller-scoped handoff marker record. */
export function parseHandedOffMarker(raw: unknown): HandedOffMarker | undefined {
  const result = HandedOffMarkerSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Parse and strictly narrow a review-scope record. An invalid shape yields
 * undefined — callers treat that as "no scope", which degrades the next review
 * to a whole-change-set first review.
 */
export function parseReviewScope(raw: unknown): ReviewScope | undefined {
  const result = ReviewScopeSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Whether a persisted workflow may produce a worktree-lease claim (bd-165).
 *
 * A completed or handed-off workflow is a record of a workflow that is over.
 * Claiming the one-orchestrator-per-worktree lease from it names the dead task
 * and then holds the lease for the life of the new session, so every later
 * session in that worktree is refused.
 *
 * Pure: no I/O, so the session-start ordering decision is unit-testable without a
 * worktree.
 */
export type WorkflowClaimability =
  | { kind: "claimable" }
  | { kind: "inert"; reason: "handed-off" | "complete" | "invalid-task-id" };

export function classifyWorkflowClaimability(state: WorkflowState): WorkflowClaimability {
  // The handoff marker wins over the phase ledger: a terminal handed-off state
  // still has to reach settleHandoffPendingItems, so it is reported as handed
  // off even when every phase is complete.
  if (state.handedOffTo !== undefined) return { kind: "inert", reason: "handed-off" };
  if (isWorkflowComplete(state.completedPhaseNames, state.phaseOrder)) {
    return { kind: "inert", reason: "complete" };
  }
  // A crafted/corrupt task id must never reach the `bd show ${taskId}` sink or
  // a lease naming it.
  if (!isValidTaskId(state.taskId)) return { kind: "inert", reason: "invalid-task-id" };
  return { kind: "claimable" };
}
