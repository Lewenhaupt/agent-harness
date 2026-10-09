/**
 * Tests for detached background run orchestration (bd-41).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../agent-registry.js";
import {
  classifyRunOutcome,
  type RunDelivery,
  RunStatus,
  spawnDetachedRun,
  type WatchRunDeps,
  watchRunCompletion,
} from "../run-detached.js";

function result(
  exitCode: number,
  text = "output",
  toolCalls = 1,
  finalAttemptToolCalls?: number,
): SpawnResult {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls },
      exitCode,
      ...(finalAttemptToolCalls !== undefined ? { finalAttemptToolCalls } : {}),
    },
  };
}

interface Deps {
  calls: string[];
  reasons: Array<string | undefined>;
  deliveries: RunDelivery[];
  deps: WatchRunDeps;
}

function makeDeps(overrides: Partial<WatchRunDeps> = {}): Deps {
  const calls: string[] = [];
  const reasons: Array<string | undefined> = [];
  const deliveries: RunDelivery[] = [];
  const delivered = new Set<string>();
  const deps: WatchRunDeps = {
    onSettled: (info) => {
      calls.push(`settled:${info.success}`);
    },
    persistStatus: (info) => {
      calls.push(`persist:${info.success}`);
      reasons.push(info.failureReason);
    },
    onPhaseComplete: (info) => {
      calls.push(`complete:${info.phaseName}`);
    },
    deliver: (delivery) => {
      calls.push(`deliver:${delivery.success}`);
      deliveries.push(delivery);
    },
    isDelivered: (runId) => delivered.has(runId),
    markDelivered: (runId) => {
      delivered.add(runId);
      calls.push("mark");
    },
    ...overrides,
  };
  return { calls, reasons, deliveries, deps };
}

describe("spawnDetachedRun", () => {
  it("returns a running handle with a promise that resolves the gated result", async () => {
    const handle = spawnDetachedRun({
      runId: "r1",
      phaseName: "scout",
      startedAtInMs: 1_000,
      spawnAgent: async () => result(0, "spawned"),
      runGate: async (r) => result(0, `${r.content[0]?.text ?? ""} gated`),
    });

    expect(handle.status).toBe(RunStatus.Running);
    expect(handle).toHaveProperty("runId", "r1");
    expect(handle).toHaveProperty("phaseName", "scout");

    const settled = await handle.promise;
    expect(settled.content[0]).toHaveProperty("text", "spawned gated");
    expect(settled.details).toHaveProperty("exitCode", 0);
  });

  it("resolves to a failure result when spawnAgent throws (never rejects)", async () => {
    const handle = spawnDetachedRun({
      runId: "r2",
      phaseName: "plan",
      startedAtInMs: 2_000,
      spawnAgent: async () => {
        throw new Error("boom");
      },
      runGate: async (r) => r,
    });

    const settled = await handle.promise;
    expect(settled.details).toHaveProperty("exitCode", 1);
    expect(settled.content[0]).toHaveProperty("text", "Agent process failed: boom");
  });

  it("resolves to a failure result when runGate throws", async () => {
    const handle = spawnDetachedRun({
      runId: "r3",
      phaseName: "implement",
      startedAtInMs: 3_000,
      spawnAgent: async () => result(0),
      runGate: async () => {
        throw new Error("gate exploded");
      },
    });

    const settled = await handle.promise;
    expect(settled.details).toHaveProperty("exitCode", 1);
    expect(settled.content[0]).toHaveProperty("text", "Agent process failed: gate exploded");
  });

  it("treats a gate-wrapped result as success when exitCode is 0, even if the gate text says failing", async () => {
    // withGateResult (extensions/index.ts) appends a gate header to the content
    // but preserves details — so a gate note alone must never flip the verdict.
    // Success semantics are the outcome classifier's, by design.
    const handle = spawnDetachedRun({
      runId: "r3b",
      phaseName: "implement",
      startedAtInMs: 3_500,
      spawnAgent: async () => result(0, "agent output"),
      runGate: async (r) =>
        result(
          r.details.exitCode,
          `${r.content[0]?.text ?? ""}\n\n❌ **Quality Gates still failing**`,
        ),
    });

    const settled = await handle.promise;
    expect(settled.details).toHaveProperty("exitCode", 0);
    expect(settled.content[0]).toHaveProperty(
      "text",
      expect.stringContaining("Quality Gates still failing"),
    );
  });
});

describe("classifyRunOutcome", () => {
  it("fails a non-zero exit code and includes the code", () => {
    const outcome = classifyRunOutcome(result(7));
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.reason).toContain("code 7");
  });

  it("appends a truncated stderr tail to the non-zero exit reason", () => {
    const base = result(1);
    const longStderr = "x".repeat(1000);
    const outcome = classifyRunOutcome({
      ...base,
      details: { ...base.details, stderr: longStderr },
    });
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.reason).toContain("code 1");
    expect(outcome.reason.length).toBeLessThan(longStderr.length);
  });

  it("fails an exit-0 run with zero tool calls and no output", () => {
    const outcome = classifyRunOutcome(result(0, "", 0));
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.reason).toContain("no tool calls");
    expect(outcome.reason).toContain("turns=0");
    expect(outcome.reason).toContain("output=0 chars");
  });

  it("fails an exit-0 run with zero tool calls even when assistant text exists", () => {
    const outcome = classifyRunOutcome(result(0, "I did the thing", 0));
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.reason).toContain("output=15 chars");
  });

  it("succeeds an exit-0 run with at least one tool call", () => {
    expect(classifyRunOutcome(result(0, "done", 1))).toEqual({ success: true });
  });

  it("fails when the final fallback attempt made no tool calls even if earlier attempts did", () => {
    // usage.toolCalls aggregates every attempt (here > 0); the final attempt was
    // a silent no-op, so the classifier must fail on the final count.
    const outcome = classifyRunOutcome(result(0, "", 3, 0));
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.reason).toContain("no tool calls");
  });

  it("succeeds when the final fallback attempt itself made tool calls", () => {
    expect(classifyRunOutcome(result(0, "done", 5, 2))).toEqual({ success: true });
  });

  it("falls back to usage.toolCalls when finalAttemptToolCalls is absent (single attempt)", () => {
    expect(classifyRunOutcome(result(0, "done", 1))).toEqual({ success: true });
    expect(classifyRunOutcome(result(0, "", 0))).toHaveProperty("success", false);
  });
});

describe("watchRunCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails a zero-tool-call exit-0 run, persists the reason, and never completes the phase", async () => {
    const { calls, reasons, deliveries, deps } = makeDeps();
    const handle = spawnDetachedRun({
      runId: "r-zero",
      phaseName: "implement",
      startedAtInMs: 3_950,
      spawnAgent: async () => result(0, "", 0),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(handle.status).toBe(RunStatus.Failed);
      expect(calls).toEqual(["settled:false", "persist:false", "deliver:false", "mark"]);
    });
    expect(reasons[0]).toContain("no tool calls");
    expect(deliveries[0]?.failureReason).toContain("no tool calls");
    expect(calls.some((c) => c.startsWith("complete:"))).toBe(false);
  });

  it("fails a fallback run whose final attempt was a zero-tool-call no-op", async () => {
    // Summed usage is > 0 from an earlier attempt, but the final attempt made
    // no tool calls; this is exactly the masked no-op bd-60 must catch.
    const { calls, reasons, deliveries, deps } = makeDeps();
    const handle = spawnDetachedRun({
      runId: "r-fallback-noop",
      phaseName: "implement",
      startedAtInMs: 3_955,
      spawnAgent: async () => result(0, "", 3, 0),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(handle.status).toBe(RunStatus.Failed);
      expect(calls).toEqual(["settled:false", "persist:false", "deliver:false", "mark"]);
    });
    expect(reasons[0]).toContain("no tool calls");
    expect(deliveries[0]?.failureReason).toContain("no tool calls");
    expect(calls.some((c) => c.startsWith("complete:"))).toBe(false);
  });

  it("keeps the exit-0 tool-call run as a completion", async () => {
    const { calls, deps } = makeDeps();
    const handle = spawnDetachedRun({
      runId: "r-tools",
      phaseName: "implement",
      startedAtInMs: 3_960,
      spawnAgent: async () => result(0, "did work", 3),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(handle.status).toBe(RunStatus.Completed);
      expect(calls).toEqual([
        "settled:true",
        "complete:implement",
        "persist:true",
        "deliver:true",
        "mark",
      ]);
    });
  });

  it("keeps status Running while the promise is pending, then transitions to Completed", async () => {
    const { calls, deps } = makeDeps();
    let releaseSpawn: (value: SpawnResult) => void = () => {};
    const handle = spawnDetachedRun({
      runId: "r3c",
      phaseName: "scout",
      startedAtInMs: 3_600,
      spawnAgent: () =>
        new Promise<SpawnResult>((resolve) => {
          releaseSpawn = resolve;
        }),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    expect(handle.status).toBe(RunStatus.Running);
    expect(calls).toHaveLength(0);

    releaseSpawn(result(0));
    await vi.waitFor(() => {
      expect(handle.status).toBe(RunStatus.Completed);
    });
  });

  it("keeps status Running while the promise is pending, then transitions to Failed", async () => {
    const { deps } = makeDeps();
    let releaseSpawn: (value: SpawnResult) => void = () => {};
    const handle = spawnDetachedRun({
      runId: "r3d",
      phaseName: "plan",
      startedAtInMs: 3_700,
      spawnAgent: () =>
        new Promise<SpawnResult>((resolve) => {
          releaseSpawn = resolve;
        }),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    expect(handle.status).toBe(RunStatus.Running);

    releaseSpawn(result(1));
    await vi.waitFor(() => {
      expect(handle.status).toBe(RunStatus.Failed);
    });
  });

  it("a failure-sounding text with exitCode 1 is not a phase completion", async () => {
    const { calls, deps } = makeDeps();
    const handle = spawnDetachedRun({
      runId: "r3e",
      phaseName: "review",
      startedAtInMs: 3_800,
      spawnAgent: async () => result(1, "✅ phase completed successfully"),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(handle.status).toBe(RunStatus.Failed);
      expect(calls).toEqual(["settled:false", "persist:false", "deliver:false", "mark"]);
    });
  });

  it("marks a gate-failed-text result with exitCode 0 and a tool call as success", async () => {
    // withGateResult preserves details, so a gate that only annotates content
    // cannot flip success. Only the outcome classifier decides completion.
    const { calls, deps } = makeDeps();
    const handle = spawnDetachedRun({
      runId: "r3f",
      phaseName: "implement",
      startedAtInMs: 3_900,
      spawnAgent: async () => result(0, "agent output"),
      runGate: async (r) =>
        result(
          r.details.exitCode,
          `${r.content[0]?.text ?? ""}\n\n❌ **Quality Gates still failing**`,
        ),
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(handle.status).toBe(RunStatus.Completed);
      expect(calls).toEqual([
        "settled:true",
        "complete:implement",
        "persist:true",
        "deliver:true",
        "mark",
      ]);
    });
  });

  it("happy path: onSettled → onPhaseComplete → persistStatus → deliver → markDelivered", async () => {
    const { calls, deps } = makeDeps();
    const handle = spawnDetachedRun({
      runId: "r4",
      phaseName: "scout",
      startedAtInMs: 4_000,
      spawnAgent: async () => result(0, "done"),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(handle.status).toBe(RunStatus.Completed);
      expect(calls).toEqual([
        "settled:true",
        "complete:scout",
        "persist:true",
        "deliver:true",
        "mark",
      ]);
    });
  });

  it("failure path: exitCode 1 → onSettled but no onPhaseComplete", async () => {
    const { calls, deps } = makeDeps();
    const handle = spawnDetachedRun({
      runId: "r5",
      phaseName: "test",
      startedAtInMs: 5_000,
      spawnAgent: async () => result(1, "crashed"),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(handle.status).toBe(RunStatus.Failed);
      expect(calls).toEqual(["settled:false", "persist:false", "deliver:false", "mark"]);
    });
  });

  it("failure path calls onSettled but not onPhaseComplete", async () => {
    const { calls, deps } = makeDeps();
    const handle = spawnDetachedRun({
      runId: "r5b",
      phaseName: "implement",
      startedAtInMs: 5_500,
      spawnAgent: async () => result(1, "crashed"),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(calls).toContain("settled:false");
      expect(calls.some((c) => c.startsWith("complete:"))).toBe(false);
    });
  });

  it("does not deliver again when the run is already marked delivered", async () => {
    const { calls, deps } = makeDeps({ isDelivered: () => true });
    const handle = spawnDetachedRun({
      runId: "r6",
      phaseName: "review",
      startedAtInMs: 6_000,
      spawnAgent: async () => result(0),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(calls).toEqual(["settled:true", "complete:review", "persist:true"]);
    });
  });

  it("delivers once even when watched twice", async () => {
    const { calls, deps } = makeDeps();
    const handle = spawnDetachedRun({
      runId: "r7",
      phaseName: "proof",
      startedAtInMs: 7_000,
      spawnAgent: async () => result(0),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(calls.filter((c) => c === "deliver:true")).toHaveLength(1);
      expect(handle.status).toBe(RunStatus.Completed);
    });
  });

  it("never throws when a delivery side effect throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeDeps({
      deliver: () => {
        throw new Error("delivery exploded");
      },
    });
    const handle = spawnDetachedRun({
      runId: "r8",
      phaseName: "userguide",
      startedAtInMs: 8_000,
      spawnAgent: async () => result(0),
      runGate: async (r) => r,
    });

    watchRunCompletion(handle, deps);
    await handle.promise;
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
