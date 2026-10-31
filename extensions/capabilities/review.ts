/**
 * Review capability: review scoping, the bounded review delivery, and the
 * review↔fix loop guidance (bd-179).
 *
 * The review-task builder is part of the process core the durable-member
 * runtime needs without extension globals, so it lives here with only `src/`
 * imports and the shared phase-name constants.
 */
import { getPhaseToolName } from "../../src/agent-registry.js";
import {
  boundReviewOutput,
  collectReviewDiff,
  formatReviewTask,
} from "../../src/review-context.js";
import type { RunDelivery } from "../../src/run-detached.js";
import { readWorkflowState } from "../../src/workflow-state.js";
import { COMMIT_PHASE, IMPLEMENT_PHASE, REVIEW_PHASE } from "./context.js";

/**
 * Shared fix-loop wording. The gate context, the workflow-start message, and
 * the run-completion follow-up all instruct the orchestrator the same way; one
 * helper keeps them from drifting.
 */
export const REVIEW_LOOP_FIX_STEP =
  "call `belayd_implement` with those findings (it resumes the implementation session, so it sees its earlier work), then call `belayd_review` again (it resumes the review session) to verify";

/**
 * The resumable-fix directive: address findings before advancing. `nextPhaseTool`
 * is the tool that follows review in this workflow's phase order, so the
 * "advance only when clean" clause stays correct for any phaseOrder.
 */
export function reviewLoopDirective(nextPhaseTool: string): string {
  return `If any Critical/Warnings remain, ${REVIEW_LOOP_FIX_STEP}. Only once no Critical/Warnings remain, call \`${nextPhaseTool}\`.`;
}

/**
 * Apply the review output contract to a delivery (bd-113). Only a successful
 * review is bounded: a failed run's text is error output and must survive
 * intact for the orchestrator to act on.
 */
export function boundReviewDelivery(delivery: RunDelivery): RunDelivery {
  if (!delivery.success || delivery.phaseName !== REVIEW_PHASE) return delivery;
  const [first, ...rest] = delivery.result.content;
  if (first === undefined) return delivery;
  return {
    ...delivery,
    result: {
      ...delivery.result,
      content: [{ ...first, text: boundReviewOutput(first.text).text }, ...rest],
    },
  };
}

/**
 * Build the review phase prompt with the change set inlined (bd-113).
 *
 * A first review sees the whole change; a re-review sees only the fix diff
 * since the sha the previous review recorded. When nothing can be collected
 * the task discloses the gap instead of silently sending a bare task. Any git
 * failure falls back to a disclosed scope rather than failing the phase.
 */
export async function buildReviewTask(options: {
  taskId: string;
  paramsTask: string;
  cwd: string;
}): Promise<string> {
  const persisted = readWorkflowState({ cwd: options.cwd });
  // Only this task's recorded sha may scope the review; a stale workflow.json
  // from another task must not narrow (or widen) this task's diff.
  const reviewedSha =
    persisted !== undefined && persisted.taskId === options.taskId
      ? persisted.reviewedSha
      : undefined;
  if (reviewedSha === undefined || reviewedSha === "") {
    const firstReview = await collectReviewDiff({ cwd: options.cwd });
    if (!firstReview.ok) {
      return formatReviewTask({
        paramsTask: options.paramsTask,
        diffUnavailable: firstReview.error,
      });
    }
    return formatReviewTask({ paramsTask: options.paramsTask, diff: firstReview.value });
  }
  const rereview = await collectReviewDiff({ cwd: options.cwd, reviewedSha });
  if (rereview.ok) {
    return formatReviewTask({
      paramsTask: options.paramsTask,
      diff: rereview.value,
      priorFindings: options.paramsTask,
    });
  }
  // The whole-change-set diff is only needed for this fallback, so it is
  // collected lazily: paying for it on every re-review would re-introduce the
  // cost bd-113 removes.
  const firstReview = await collectReviewDiff({ cwd: options.cwd });
  if (!firstReview.ok) {
    return formatReviewTask({
      paramsTask: options.paramsTask,
      // Both scopes failed: disclose both reasons so the reviewer can pick up
      // the change set itself.
      diffUnavailable: `fix-only diff failed (${rereview.error}); whole-change-set diff failed (${firstReview.error})`,
      priorFindings: options.paramsTask,
    });
  }
  // The fix-only diff could not be computed (commonly: the recorded sha was
  // removed by a rebase). Fall back to the whole change set and say so, so the
  // reviewer knows the scope is wider than the fix round.
  const fallbackNote =
    `> Note: the fix-only diff since the previously reviewed revision could not be computed ` +
    `(${rereview.error}). This review covers the whole change set instead.`;
  return `${fallbackNote}\n\n${formatReviewTask({
    paramsTask: options.paramsTask,
    diff: firstReview.value,
    priorFindings: options.paramsTask,
  })}`;
}

/**
 * Review-findings guidance shared by the workflow-start and gate-context
 * messages. The reviewer emits Critical/Warnings/Suggestions; the orchestrator
 * must treat all three as input and disclose anything it declines.
 */
export function reviewFindingsGuidanceLines(nextPhaseTool: string): string[] {
  return [
    "",
    "**Review findings** (after `belayd_review`):",
    "- Consider EVERY finding: Critical (must fix), Warnings (should fix), and Suggestions (consider).",
    "- Address all Critical and Warnings findings — you may NOT dismiss them.",
    `- Re-run the fix loop yourself: ${REVIEW_LOOP_FIX_STEP}.`,
    `- Repeat until no Critical/Warnings remain, then call \`${nextPhaseTool}\`. You may decline only Suggestions, and only with a reason.`,
    "- In the task's Final Summary, list every finding you chose not to address, each with a one-line reason.",
  ];
}

/**
 * Derive the tool for the phase that follows `phaseName` (defaulting to commit
 * at the end of the order), so loop messages never hard-code a phase name.
 */
export function nextPhaseToolAfter(phaseName: string, phaseOrder: readonly string[]): string {
  const index = phaseOrder.indexOf(phaseName);
  if (index === -1) return getPhaseToolName(COMMIT_PHASE);
  return getPhaseToolName(phaseOrder[index + 1] ?? COMMIT_PHASE);
}

/**
 * True when review is completed and no later phase has run since — i.e. review
 * produced findings the orchestrator has not yet answered. Serves as the
 * disk-resume fallback; in-session updates use `nextAwaitingReviewResponse`
 * because `completedPhaseNames` never records a repeat of an already-completed
 * phase.
 */
export function isAwaitingReviewResponse(
  completedPhaseNames: readonly string[],
  phaseOrder: readonly string[],
): boolean {
  const reviewIndex = phaseOrder.indexOf(REVIEW_PHASE);
  if (reviewIndex === -1 || !completedPhaseNames.includes(REVIEW_PHASE)) return false;
  return !completedPhaseNames.some((name) => phaseOrder.indexOf(name) > reviewIndex);
}

/**
 * Advance the resumable-fix flag for one completed phase. Review arms it; a
 * phase after review (test/userguide/proof/commit) disarms it; earlier phases
 * (scout, plan) leave it unchanged. An implement re-run re-arms it once review
 * has run, because implement is the fix half of the loop — a late fix loop
 * after test/userguide must still point back at review, not the next phase.
 * Pure set membership on `completedPhaseNames` cannot express this.
 */
export function nextAwaitingReviewResponse(options: {
  awaiting: boolean;
  completedPhaseName: string;
  phaseOrder: readonly string[];
  reviewCompleted: boolean;
}): boolean {
  const reviewIndex = options.phaseOrder.indexOf(REVIEW_PHASE);
  if (reviewIndex === -1) return false;
  if (options.completedPhaseName === REVIEW_PHASE) return true;
  if (options.phaseOrder.indexOf(options.completedPhaseName) > reviewIndex) return false;
  if (options.completedPhaseName === IMPLEMENT_PHASE && options.reviewCompleted) return true;
  return options.awaiting;
}
