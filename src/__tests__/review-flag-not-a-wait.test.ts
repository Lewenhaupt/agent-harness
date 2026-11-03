/**
 * bd-219: `awaitingReviewResponse` is a phase fact, never a wait predicate.
 *
 * The flag is persisted on *every* review completion because a review needs a
 * fix-loop follow-up, and treating it as a wait made every post-review member
 * look stopped: the fleet reported `awaiting-human`, the 12 h human cap applied,
 * the digest printed a wait line that contradicted its own `- state: active`, and
 * the run-complete delivery withheld the very directive the turn needed.
 *
 * Each surface also has a test beside its own module; this file is the one place
 * that sets the flag and proves the four surfaces do not move because of it, so
 * reintroducing it in any of them trips a test that names the contract.
 */

import { describe, expect, it } from "vitest";

import { humanAnswerGuidanceLines } from "../../extensions/capabilities/human-gate.js";
import { runCompleteLoopHint } from "../../extensions/capabilities/phase-run.js";
import { createInitialSessionState } from "../../extensions/capabilities/session-state.js";
import { deriveFleetMemberProgress } from "../fleet-run.js";
import { deriveFleetMemberState } from "../fleet-status.js";
import type { RunDelivery } from "../run-detached.js";
import { buildWorkflowDigest, type SupervisionMemberFacts } from "../workflow-digest.js";
import type { WorkflowState } from "../workflow-state.js";

const MEMBER = "bd-12";
const PHASES = ["plan", "implement", "review", "test", "commit"];

/** A post-review workflow: the state every member is in when the flag is set. */
function postReviewWorkflow(): WorkflowState {
  return {
    schemaVersion: 1,
    taskId: MEMBER,
    workflowType: "feature",
    branch: `feat/${MEMBER}`,
    originalCwd: "/repo",
    phaseOrder: [...PHASES],
    completedPhaseNames: ["plan", "implement", "review"],
    awaitingReviewResponse: true,
    startedAt: 1_000,
    updatedAt: 2_000,
  };
}

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

/** The digest facts a healthy post-review member produces. */
function digestMember(awaitingReviewResponse: boolean): SupervisionMemberFacts {
  return {
    taskId: MEMBER,
    worktreePath: `/repo.feat-${MEMBER}`,
    branch: `feat/${MEMBER}`,
    // What the status builder reports once only an open gate (not the flag) can
    // make a person-wait; the flag itself must not change this either.
    memberState: "active",
    phaseOrder: [...PHASES],
    completedPhases: ["plan", "implement", "review"],
    pendingPhases: ["test", "commit"],
    awaitingReviewResponse,
    updatedAt: NOW - 60_000,
    lease: {
      state: "held",
      taskId: MEMBER,
      sessionId: "session-1",
      heartbeatAt: NOW - 60_000,
    },
    gates: {},
    runs: [],
  };
}

/** A review delivery whose result would have gated before bd-219. */
const REVIEW_DELIVERY: RunDelivery = {
  runId: "run-1",
  phaseName: "review",
  success: true,
  result: {
    content: [
      {
        type: "text",
        text: "## Critical (must fix)\n- `src/a.ts:12` — off-by-one in the loop bound",
      },
    ],
    details: {
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 1 },
      exitCode: 0,
    },
    sessionName: `belayd-${MEMBER}-sub-review-run-1`,
  },
};

describe("the review phase flag is not a wait (bd-219)", () => {
  it("leaves fleet progress running, and the digest without a wait line", () => {
    // The progress snapshot carries no flag at all any more, so the assertion is
    // the outcome: a post-review member with no gate is running, not waiting.
    const progress = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: {
        kind: "ok",
        completedPhaseNames: ["plan", "implement", "review"],
        phaseOrder: PHASES,
      },
      runs: [],
      now: 5_000,
    });
    expect(progress.kind).toBe("running");

    // The digest facts *do* carry the flag (a reader should see what the file
    // says), and the rendered text must be identical either way.
    const withFlag = buildWorkflowDigest({ member: digestMember(true), now: NOW });
    const withoutFlag = buildWorkflowDigest({ member: digestMember(false), now: NOW });
    expect(withFlag).toBe(withoutFlag);
    expect(withFlag).toContain("- state: active");
    expect(withFlag).toContain("- waiting on: nothing (no open gate)");
  });

  it("leaves a post-review member active, not awaiting-human", () => {
    const base = {
      workflow: { kind: "ok" as const, state: postReviewWorkflow() },
      runs: [],
      completedPhases: ["plan", "implement", "review"],
      pendingPhases: ["test", "commit"],
    };
    expect(deriveFleetMemberState({ ...base, humanGateOpen: false })).toBe("active");
    // Only a gate read moves it; the flag in the same workflow state does not.
    expect(deriveFleetMemberState({ ...base, humanGateOpen: true })).toBe("awaiting-human");
  });

  it("leaves the run-complete directive and the human-wait guidance untouched", () => {
    const flagged = createInitialSessionState();
    flagged.gateActive = true;
    flagged.currentTaskId = MEMBER;
    flagged.completedPhaseNames = ["plan", "implement", "review"];
    flagged.awaitingReviewResponse = true;

    const unflagged = { ...flagged, awaitingReviewResponse: false };

    // The set flag must not suppress the fix-loop directive: that was the bd-175
    // bug this bead removed.
    const flaggedHint = runCompleteLoopHint({ delivered: REVIEW_DELIVERY, state: flagged });
    expect(flaggedHint).toBe(runCompleteLoopHint({ delivered: REVIEW_DELIVERY, state: unflagged }));
    expect(flaggedHint).toContain("**When review findings remain:**");
    expect(flaggedHint).toContain("belayd_test");

    // Neither state has a live wait, so neither guidance block shows the ⏸ wait
    // and neither promises to refuse phase tools.
    const flaggedLines = humanAnswerGuidanceLines(flagged).join("\n");
    expect(flaggedLines).toBe(humanAnswerGuidanceLines(unflagged).join("\n"));
    expect(flaggedLines).not.toContain("Waiting for a human answer");
    expect(flaggedLines).not.toContain("refused until the answer arrives");
  });
});
