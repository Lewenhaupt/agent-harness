import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnResult, SpawnUsage } from "../agent-registry.js";
import { createModelCooldownStore } from "../model-cooldown.js";
import type { classifySpawnFailure, FailureClassification } from "../quota-failure.js";
import { spawnAgentWithFallback } from "../spawn-with-fallback.js";

const mockSpawnAgentProcess = vi.hoisted(() => vi.fn());

vi.mock("../spawn.js", () => ({
  spawnAgentProcess: mockSpawnAgentProcess,
}));

beforeEach(() => {
  mockSpawnAgentProcess.mockReset();
});

function zeroUsage(): SpawnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function makeResult(model: string, exitCode = 0, usage?: Partial<SpawnUsage>): SpawnResult {
  return {
    content: [{ type: "text", text: `result-from-${model}` }],
    details: {
      messages: [],
      usage: { ...zeroUsage(), ...usage },
      exitCode,
      model,
    },
  };
}

/** A classifier that returns the given classifications in order. */
function seqClassifier(...kinds: FailureClassification["kind"][]): typeof classifySpawnFailure {
  const queue = [...kinds];
  return () => {
    const kind = queue.shift() ?? "success";
    return kind === "success"
      ? { kind }
      : kind === "quota"
        ? { kind, cooldownSeconds: 900 }
        : { kind };
  };
}

describe("spawnAgentWithFallback", () => {
  it("falls back to the next candidate on a quota failure and cools the failed model", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.5"))
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.5"));

    const store = createModelCooldownStore(() => 0);
    const { result, attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.5",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      classify: seqClassifier("quota", "success"),
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/mimo-v2.5");
    expect(attempts.map((a) => a.model)).toEqual(["opencode-go/mimo-v2.5", "llmgateway/mimo-v2.5"]);
    expect(store.isCoolingDown("opencode-go/mimo-v2.5")).toBe(true);
    expect(store.isCoolingDown("llmgateway/mimo-v2.5")).toBe(false);
  });

  it("stops immediately on an auth/other failure without trying more candidates", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.5"));

    const { attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.5",
      tools: [],
      systemPrompt: "t",
      task: "t",
      classify: seqClassifier("auth"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toHaveProperty("classification.kind", "auth");
  });

  it("returns the last result when all candidates fail on quota", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("a"))
      .mockResolvedValueOnce(makeResult("b"));

    const { result, attempts } = await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["a", "b"],
      classify: seqClassifier("quota", "quota"),
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-b");
    expect(attempts.map((a) => a.model)).toEqual(["a", "b"]);
    expect(attempts.every((a) => a.classification.kind === "quota")).toBe(true);
  });

  it("skips a cooled-down candidate", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("b"));

    const store = createModelCooldownStore(() => 0);
    store.markCooldown("a", 900, "quota");

    const { result, attempts } = await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["a", "b"],
      cooldownStore: store,
      classify: seqClassifier("success"),
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-b");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toHaveProperty("skippedCooldown", true);
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
  });

  it("tries a single candidate for an unknown model", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("unknown/x"));

    const { attempts } = await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      classify: seqClassifier("success"),
    });

    expect(attempts).toHaveLength(1);
    expect(mockSpawnAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({ model: "unknown/x" }),
    );
  });

  it("honors the kill switch by trying only the configured model", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.5"));

    const { attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.5",
      tools: [],
      systemPrompt: "t",
      task: "t",
      enabled: false,
      classify: seqClassifier("quota"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
  });

  it("end-to-end: a real 429 details object triggers a fallback", async () => {
    const quotaDetails = {
      messages: [
        {
          role: "assistant",
          content: [],
          model: "opencode-go/mimo-v2.5",
          stopReason: "error",
          errorMessage: '429: {"message":"Weekly usage limit reached. Resets in 11hr 6min."}',
        },
      ],
      usage: zeroUsage(),
      exitCode: 0,
    };
    mockSpawnAgentProcess
      .mockResolvedValueOnce({ ...makeResult("opencode-go/mimo-v2.5"), details: quotaDetails })
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.5"));

    const { result, attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.5",
      tools: [],
      systemPrompt: "t",
      task: "t",
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/mimo-v2.5");
    expect(attempts.map((a) => a.classification.kind)).toEqual(["quota", "success"]);
  });

  it("uses a fresh session id per attempt", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("a"))
      .mockResolvedValueOnce(makeResult("b"));

    await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["a", "b"],
      sessionName: "belayd-x",
      classify: seqClassifier("quota", "success"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: "a", sessionName: "belayd-x" }),
    );
    expect(mockSpawnAgentProcess).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: "b", sessionName: "belayd-x-fallback-1" }),
    );
  });

  it("aggregates usage across attempts", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("a", 0, { turns: 1, input: 5, cost: 0.1 }))
      .mockResolvedValueOnce(makeResult("b", 0, { turns: 1, input: 10, cost: 0.2 }));

    const { result } = await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["a", "b"],
      classify: seqClassifier("quota", "success"),
    });

    expect(result.details.usage).toHaveProperty("turns", 2);
    expect(result.details.usage).toHaveProperty("input", 15);
    expect(result.details.usage.cost).toBeCloseTo(0.3);
  });

  it("honors maxAttempts by stopping after the configured depth", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("a"));

    const { attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.5",
      tools: [],
      systemPrompt: "t",
      task: "t",
      maxAttempts: 1,
      classify: seqClassifier("quota"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
  });
});
