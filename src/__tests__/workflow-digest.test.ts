/**
 * Tier-2 workflow digest (bd-189): deterministic, model-free, transcript-free.
 *
 * The three seeded stuck shapes are the acceptance cases — a member waiting on a
 * 3h-old human gate, a member whose lease expired, and a member that has made no
 * progress for 22m — plus the ranking that must not let a clock-based cause
 * outrank a failed phase, and the two liveness cases that used to be wrong: a
 * live heartbeat treated as silence (C1) and a lease heartbeat the digest cannot
 * read at all (W2).
 *
 * The runtime proof that a digest makes no model request and reads no transcript
 * lives in `extension-supervision-tools.test.ts`, where the spies sit on the
 * modules the capability actually imports. A spy here could never fire: this
 * file only calls `buildWorkflowDigest`, which imports neither seam. Do not add
 * one back.
 */

import { describe, expect, it } from "vitest";
import { formatModelTelemetrySummary } from "../model-telemetry.js";
import { classifyOrchestratorClaim, ORCHESTRATOR_CLAIM_STALE_MS } from "../orchestrator-claim.js";
import {
  buildWorkflowDigest,
  computeStuckVerdict,
  formatDurationInMs,
  leaseLiveness,
  NO_PROGRESS_STUCK_MS,
  type SupervisionMemberFacts,
  type SupervisionRunFacts,
  WORKFLOW_DIGEST_MAX_BYTES,
  type WorkflowDigestInput,
} from "../workflow-digest.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function run(overrides: Partial<SupervisionRunFacts> = {}): SupervisionRunFacts {
  return {
    phase: "implement",
    status: "completed",
    startedAt: NOW - 40 * MINUTE,
    completedAt: NOW - 30 * MINUTE,
    ...overrides,
  };
}

/** A healthy, progressing feature member; every test deforms one field. */
function member(overrides: Partial<SupervisionMemberFacts> = {}): SupervisionMemberFacts {
  return {
    taskId: "bd-189",
    worktreePath: "/repo.feat-bd-189",
    branch: "feat/bd-189",
    memberState: "active",
    phaseOrder: ["scout", "plan", "implement", "review", "test", "proof", "commit"],
    completedPhases: ["scout", "plan"],
    pendingPhases: ["implement", "review", "test", "proof", "commit"],
    awaitingReviewResponse: false,
    updatedAt: NOW - 6 * MINUTE,
    lease: {
      state: "held",
      taskId: "bd-189",
      sessionId: "session-1",
      heartbeatAt: NOW - MINUTE,
    },
    gates: {},
    runs: [
      run({ phase: "plan" }),
      run({
        phase: "implement",
        startedAt: NOW - 6 * MINUTE,
        completedAt: undefined,
        status: "running",
      }),
    ],
    ...overrides,
  };
}

function digestText(overrides: Partial<SupervisionMemberFacts> = {}): string {
  return buildWorkflowDigest({ member: member(overrides), now: NOW });
}

/** The verdict line as the supervisor reads it. */
function verdictOf(overrides: Partial<SupervisionMemberFacts> = {}): string {
  return computeStuckVerdict({ member: member(overrides), now: NOW }).line;
}

describe("workflow digest stuck verdict (bd-189)", () => {
  it("names a 3h-old open human gate", () => {
    const verdict = computeStuckVerdict({
      member: member({
        memberState: "awaiting-human",
        gates: { humanGateId: "gate-1", humanGateCreatedAtMs: NOW - 3 * HOUR },
      }),
      now: NOW,
    });

    expect(verdict.stuck).toBe(true);
    expect(verdict.line).toBe("gate open 3h (gate-1)");
  });

  it("names an expired orchestrator lease", () => {
    const verdict = computeStuckVerdict({
      member: member({
        lease: {
          state: "held",
          taskId: "bd-189",
          sessionId: "session-1",
          heartbeatAt: NOW - (ORCHESTRATOR_CLAIM_STALE_MS + 4 * MINUTE),
        },
      }),
      now: NOW,
    });

    expect(verdict.stuck).toBe(true);
    expect(verdict.line).toBe("lease expired 4m ago");
  });

  it("names 22m without progress when no liveness signal is newer", () => {
    const verdict = computeStuckVerdict({
      // No lease: the clock inputs are the only evidence, and all of it is old.
      member: member({
        updatedAt: NOW - 22 * MINUTE,
        runs: [],
        lease: { state: "absent" },
      }),
      now: NOW,
    });

    expect(verdict.stuck).toBe(true);
    expect(verdict.line).toBe("no progress 22m");
  });

  it("does not call a long phase silent while its orchestrator heartbeat is live (C1)", () => {
    // The shape the review caught: 25 minutes into one phase, no new run or
    // workflow write, heartbeat renewed 20s ago. `stuck: no progress` here was a
    // false positive — the same digest printed `lease: live`.
    const verdict = computeStuckVerdict({
      member: member({
        updatedAt: NOW - 40 * MINUTE,
        runs: [
          run({
            phase: "implement",
            status: "running",
            startedAt: NOW - 25 * MINUTE,
            completedAt: undefined,
          }),
        ],
        lease: {
          state: "held",
          taskId: "bd-189",
          sessionId: "session-1",
          heartbeatAt: NOW - 20_000,
        },
      }),
      now: NOW,
    });

    expect(verdict.stuck).toBe(false);
    expect(verdict.line).toBe("not stuck: phase implement running 25m");
  });

  it("counts a new branch commit as progress when nothing else is recent", () => {
    const verdict = computeStuckVerdict({
      member: member({
        updatedAt: NOW - 30 * MINUTE,
        runs: [],
        lease: { state: "absent" },
        branchHeadCommitAt: NOW - 2 * MINUTE,
      }),
      now: NOW,
    });

    expect(verdict.stuck).toBe(false);
  });

  it("reports unknown, not 'running', when the lease heartbeat is unreadable (W2)", () => {
    const verdict = computeStuckVerdict({
      member: member({
        lease: { state: "held", taskId: "bd-189", sessionId: "session-1" },
        updatedAt: NOW - 6 * MINUTE,
      }),
      now: NOW,
    });

    expect(verdict.stuck).toBe("unknown");
    expect(verdict.line).toBe("unknown: lease heartbeat missing, so liveness cannot be judged");
    expect(verdict.line).not.toContain("not stuck");
  });

  it("reports unknown for a corrupt lease record", () => {
    const verdict = computeStuckVerdict({
      member: member({ lease: { state: "corrupt", error: "bad json" } }),
      now: NOW,
    });

    expect(verdict.stuck).toBe("unknown");
    expect(verdict.line).toContain("lease unreadable (bad json)");
  });

  it("expires exactly at the takeover threshold, matching classifyOrchestratorClaim (W1)", () => {
    // The takeover authority calls `age === staleAfter` stale; the digest must
    // agree at that exact instant, or a view and a takeover disagree about it.
    const heartbeatAt = NOW - ORCHESTRATOR_CLAIM_STALE_MS;
    const claimVerdict = classifyOrchestratorClaim({
      read: {
        kind: "ok",
        claim: {
          schemaVersion: 1,
          taskId: "bd-189",
          branch: "feat/bd-189",
          sessionId: "session-1",
          pid: 1,
          claimedAt: heartbeatAt - MINUTE,
          heartbeatAt,
        },
      },
      now: NOW,
    });
    const lease = leaseLiveness({ state: "held", sessionId: "session-1", heartbeatAt }, NOW);

    expect(claimVerdict.kind === "held" && claimVerdict.state).toBe("stale");
    expect(lease.kind).toBe("expired");
    expect(verdictOf({ lease: { state: "held", heartbeatAt } })).toBe("lease expired 0s ago");
  });

  it("ranks a failed phase above an open gate and the lease clock", () => {
    const verdict = computeStuckVerdict({
      member: member({
        memberState: "blocked",
        gates: { humanGateId: "gate-1", humanGateCreatedAtMs: NOW - 3 * HOUR },
        updatedAt: NOW - 12 * MINUTE,
        runs: [
          run({
            phase: "implement",
            status: "failed",
            startedAt: NOW - 20 * MINUTE,
            completedAt: NOW - 12 * MINUTE,
            failureReason: "quality gate failed: pnpm test",
          }),
        ],
      }),
      now: NOW,
    });

    expect(verdict.stuck).toBe(true);
    expect(verdict.line).toBe("phase implement failed 12m ago");
  });

  it("does not call a member stuck while a phase is running", () => {
    expect(verdictOf()).toBe("not stuck: phase implement running 6m");
  });

  it("treats a fleet ordering gate as waiting, not stuck", () => {
    expect(verdictOf({ gates: { orderingBlocker: "bd-179" } })).toBe(
      "not stuck: waiting on bd-179 (fleet ordering gate)",
    );
  });

  it("reports a live lease as live, not expired", () => {
    const text = digestText();
    expect(text).toContain(
      "- lease: held by session session-1 for bd-189 — live, heartbeat 1m ago",
    );
  });

  it("applies the no-progress threshold only when nothing signals progress", () => {
    expect(NO_PROGRESS_STUCK_MS).toBeGreaterThan(0);
    expect(verdictOf({ updatedAt: NOW - 9 * MINUTE, runs: [], lease: { state: "absent" } })).toBe(
      "not stuck: phase implement running 9m",
    );
    expect(verdictOf({ updatedAt: NOW - 40 * MINUTE, runs: [], lease: { state: "absent" } })).toBe(
      "no progress 40m",
    );
  });
});

describe("workflow digest sections (bd-189)", () => {
  it("renders identity, phases, waits, last error, lease, spend and verdict", () => {
    const stats = [
      {
        phase: "implement",
        model: "deepseek/deepseek-v4.1-flash",
        attempts: 2,
        fallbacks: 1,
        quotaFailures: 0,
        noOps: 0,
        cost: 0.25,
      },
    ];
    const text = digestText({
      memberState: "blocked",
      gates: { humanGateId: "gate-1", humanGateCreatedAtMs: NOW - 3 * HOUR },
      runs: [
        run({
          phase: "implement",
          status: "failed",
          completedAt: NOW - 12 * MINUTE,
          failureReason: "quality gate failed: pnpm test",
        }),
      ],
      telemetry: {
        stats,
        totals: { attempts: 2, fallbacks: 1, quotaFailures: 0, noOps: 0, cost: 0.25 },
      },
    });

    expect(text).toContain("**Workflow digest — bd-189**");
    expect(text).toContain("- worktree: /repo.feat-bd-189 (branch feat/bd-189)");
    expect(text).toContain("- state: blocked");
    expect(text).toContain("- phases: 2/7 complete");
    expect(text).toContain("- completed: scout, plan");
    expect(text).toContain("- pending: implement, review, test, proof, commit");
    expect(text).toContain("- latest runs: implement=failed");
    expect(text).toContain("- waiting on: gate-1 (human gate, open 3h)");
    expect(text).toContain("- last error: phase implement failed: quality gate failed: pnpm test");
    expect(text).toContain("- interrupted runs: 0");
    expect(text).toContain("- **stuck verdict:** phase implement failed 12m ago");
    // Spend reuses the existing telemetry formatter rather than a second one.
    expect(text).toContain("- spend:");
    expect(
      formatModelTelemetrySummary(stats, {
        attempts: 2,
        fallbacks: 1,
        quotaFailures: 0,
        noOps: 0,
        cost: 0.25,
      }),
    ).toContain("cost=$0.2500");
    expect(text).toContain("cost=$0.2500");
    expect(text.split("\n").some((line) => line.startsWith("- state:"))).toBe(true);
  });

  it("says the gate read failed instead of inventing 'no gate'", () => {
    const text = digestText({ gates: { readError: "bd gate list timed out" } });
    expect(text).toContain("- waiting on: unknown (gate read failed: bd gate list timed out)");
  });

  it("says the bead read failed instead of dropping the column (S3)", () => {
    const text = digestText({ beadError: "bd show timed out after 10000ms" });
    expect(text).toContain("- bead: unknown (bd read failed: bd show timed out after 10000ms)");
    // A bead record still wins over a stale error from an earlier read.
    expect(digestText({ bead: { title: "Tiered read", status: "open" } })).toContain(
      "- bead: Tiered read (open)",
    );
  });

  it("stays inside its byte budget and marks the truncation", () => {
    const manyPhases = Array.from({ length: 400 }, (_value, index) => `phase-${index.toString()}`);
    const text = digestText({
      phaseOrder: manyPhases,
      completedPhases: manyPhases.slice(0, 380),
      pendingPhases: manyPhases.slice(380),
      runs: manyPhases.map((phase) =>
        run({ phase, status: "completed", startedAt: NOW - 60 * MINUTE }),
      ),
    });

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(WORKFLOW_DIGEST_MAX_BYTES);
    expect(text).toContain("… truncated");
  });

  it("formats durations in the units an operator reads", () => {
    expect(formatDurationInMs(45_000)).toBe("45s");
    expect(formatDurationInMs(22 * MINUTE)).toBe("22m");
    expect(formatDurationInMs(3 * HOUR)).toBe("3h");
    expect(formatDurationInMs(50 * HOUR)).toBe("2d");
  });
});

describe("workflow digest has no model seam (bd-189)", () => {
  it("cannot carry a spawn or transcript seam at the type level", () => {
    // Structural guarantee only; the runtime proof is the spawn/transcript spies
    // in `extension-supervision-tools.test.ts`, which sit on the modules the
    // capability imports. `buildWorkflowDigest` imports neither, so a spy here
    // could never fire — see the file docblock.
    type ForbiddenKeys = Extract<
      keyof WorkflowDigestInput | keyof SupervisionMemberFacts,
      "spawn" | "spawnAgentWithFallback" | "model" | "readTranscript" | "transcript"
    >;
    const noSpawnSeam: [ForbiddenKeys] extends [never] ? true : false = true;
    expect(noSpawnSeam).toBe(true);
  });

  it("renders a digest from facts alone, with no session directory or worktree", () => {
    // Every stuck shape renders from the input struct; nothing is read off disk.
    const shapes: Array<Partial<SupervisionMemberFacts>> = [
      { gates: { humanGateId: "gate-1", humanGateCreatedAtMs: NOW - 3 * HOUR } },
      { lease: { state: "held", heartbeatAt: NOW - (ORCHESTRATOR_CLAIM_STALE_MS + 4 * MINUTE) } },
      { updatedAt: NOW - 22 * MINUTE, runs: [], lease: { state: "absent" } },
    ];
    for (const shape of shapes) {
      expect(buildWorkflowDigest({ member: member(shape), now: NOW })).toContain("stuck verdict:");
    }
  });
});
