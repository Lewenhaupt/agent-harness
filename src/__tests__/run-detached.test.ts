/**
 * Tests for detached background run orchestration (bd-41).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../agent-registry.js";
import {
  RunStatus,
  spawnDetachedRun,
  type WatchRunDeps,
  watchRunCompletion,
} from "../run-detached.js";

function result(exitCode: number, text = "output"): SpawnResult {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      exitCode,
    },
  };
}

interface Deps {
  calls: string[];
  deps: WatchRunDeps;
}

function makeDeps(overrides: Partial<WatchRunDeps> = {}): Deps {
  const calls: string[] = [];
  const delivered = new Set<string>();
  const deps: WatchRunDeps = {
    onSettled: (info) => {
      calls.push(`settled:${info.success}`);
    },
    persistStatus: (info) => {
      calls.push(`persist:${info.success}`);
    },
    onPhaseComplete: (info) => {
      calls.push(`complete:${info.phaseName}`);
    },
    deliver: (delivery) => {
      calls.push(`deliver:${delivery.success}`);
    },
    isDelivered: (runId) => delivered.has(runId),
    markDelivered: (runId) => {
      delivered.add(runId);
      calls.push("mark");
    },
    ...overrides,
  };
  return { calls, deps };
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
    // Success semantics are exitCode-driven by design.
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

describe("watchRunCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("success verdict is exitCode-driven: a failure-sounding text with exitCode 1 is not a phase completion", async () => {
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

  it("marks a gate-failed-text result with exitCode 0 as success (exitCode drives the verdict)", async () => {
    // withGateResult preserves details, so a gate that only annotates content
    // cannot flip success. Only exitCode decides phase completion.
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
