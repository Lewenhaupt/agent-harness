import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnResult, SpawnUsage } from "../agent-registry.js";
import { createCapacityCache } from "../capacity-cache.js";
import { createModelCooldownStore } from "../model-cooldown.js";
import { createModelTelemetryStore } from "../model-telemetry.js";
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
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 };
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
    if (kind === "quota") return { kind, cooldownSeconds: 900 };
    if (kind === "transient") return { kind, cooldownSeconds: 300 };
    return { kind };
  };
}

describe("spawnAgentWithFallback", () => {
  it("falls back to the next candidate on a quota failure and cools the failed provider", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.6-flash"))
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));

    const store = createModelCooldownStore(() => 0);
    const { result, attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      classify: seqClassifier("quota", "success"),
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/mimo-v2.6-flash");
    expect(attempts.map((a) => a.model)).toEqual([
      "opencode-go/mimo-v2.6-flash",
      "llmgateway/mimo-v2.6-flash",
    ]);
    // Quota is provider-scoped: the whole provider cools, not just the model.
    expect(store.cooldownScope("opencode-go/mimo-v2.6-flash")).toBe("provider");
    expect(store.isCoolingDown("opencode-go/deepseek-v4.1-flash")).toBe(true);
    expect(store.isCoolingDown("llmgateway/mimo-v2.6-flash")).toBe(false);
  });

  it("falls back on a deactivated model (410) and cools only that endpoint", async () => {
    // bd-142: the exact failure that stopped a scout phase used to classify as
    // "other" and abort the loop, so the next candidate was never tried.
    const deactivatedDetails = {
      messages: [
        {
          role: "assistant",
          content: [],
          model: "llmgateway/mimo-v2.5",
          stopReason: "error",
          errorMessage:
            '410: {"message":"Model mimo-v2.5 has been deactivated and is no longer available","type":"invalid_request_error","param":null,"code":null}',
        },
      ],
      usage: zeroUsage(),
      exitCode: 0,
    };
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        ...makeResult("llmgateway/mimo-v2.5"),
        details: deactivatedDetails,
      })
      .mockResolvedValueOnce(makeResult("openrouter/xiaomi/mimo-v2.6-flash"));

    const store = createModelCooldownStore(() => 0);
    const { result, attempts } = await spawnAgentWithFallback({
      model: "llmgateway/mimo-v2.5",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      candidates: ["llmgateway/mimo-v2.5", "openrouter/xiaomi/mimo-v2.6-flash"],
    });

    expect(result.content[0]).toHaveProperty(
      "text",
      "result-from-openrouter/xiaomi/mimo-v2.6-flash",
    );
    expect(attempts.map((a) => a.classification.kind)).toEqual(["unavailable", "success"]);
    // Endpoint-scoped: the gateway still serves its other models.
    expect(store.cooldownScope("llmgateway/mimo-v2.5")).toBe("model");
    expect(store.isCoolingDown("llmgateway/glm-5.3")).toBe(false);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(false);
  });

  it("cools only the endpoint on a transient failure, leaving the provider usable", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.6-flash"))
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));

    const store = createModelCooldownStore(() => 0);
    const { result } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      classify: seqClassifier("transient", "success"),
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/mimo-v2.6-flash");
    expect(store.cooldownScope("opencode-go/mimo-v2.6-flash")).toBe("model");
    expect(store.isCoolingDown("opencode-go/deepseek-v4.1-flash")).toBe(false);
  });

  it("stops immediately on an auth/other failure without trying more candidates", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.6-flash"));

    const { attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
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

  it("skips remaining candidates on a provider after a quota failure", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("opencode-go/a"))
      .mockResolvedValueOnce(makeResult("llmgateway/c"));

    const { result, attempts } = await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["opencode-go/a", "opencode-go/b", "llmgateway/c"],
      classify: seqClassifier("quota", "success"),
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/c");
    expect(attempts.map((a) => a.model)).toEqual([
      "opencode-go/a",
      "opencode-go/b",
      "llmgateway/c",
    ]);
    expect(attempts[1]).toHaveProperty("skippedProvider", "opencode-go");
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(2);
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
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.6-flash"));

    const { attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
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
          model: "opencode-go/mimo-v2.6-flash",
          stopReason: "error",
          errorMessage: '429: {"message":"Weekly usage limit reached. Resets in 11hr 6min."}',
        },
      ],
      usage: zeroUsage(),
      exitCode: 0,
    };
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        ...makeResult("opencode-go/mimo-v2.6-flash"),
        details: quotaDetails,
      })
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));

    const { result, attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/mimo-v2.6-flash");
    expect(attempts.map((a) => a.classification.kind)).toEqual(["quota", "success"]);
  });

  it("end-to-end: a real 400 invalid_value details object triggers a fallback", async () => {
    const rejectionDetails = {
      messages: [
        {
          role: "assistant",
          content: [],
          model: "llmgateway/deepseek-v4.1-flash",
          stopReason: "error",
          errorMessage:
            '400: {"error":{"message":"The request was rejected","type":"invalid_request_error","param":null,"code":"invalid_value"}}',
        },
      ],
      usage: zeroUsage(),
      exitCode: 0,
    };
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        ...makeResult("llmgateway/deepseek-v4.1-flash"),
        details: rejectionDetails,
      })
      .mockResolvedValueOnce(makeResult("llmgateway/glm-5.3"));

    const { result, attempts } = await spawnAgentWithFallback({
      model: "llmgateway/deepseek-v4.1-flash",
      modelClass: "frontier",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["llmgateway/deepseek-v4.1-flash", "llmgateway/glm-5.3"],
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/glm-5.3");
    expect(attempts.map((a) => a.classification.kind)).toEqual(["transient", "success"]);
  });

  it("end-to-end: a real 403 entitlement error falls back to the next provider", async () => {
    const entitlementDetails = {
      messages: [
        {
          role: "assistant",
          content: [],
          model: "opencode-go/deepseek-v4.1-flash",
          stopReason: "error",
          errorMessage:
            '403: {"type":"server_error","message":"Upstream request failed: An active OpenCode Go subscription is required to use Go models."}',
        },
      ],
      usage: zeroUsage(),
      exitCode: 0,
    };
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        ...makeResult("opencode-go/deepseek-v4.1-flash"),
        details: entitlementDetails,
      })
      .mockResolvedValueOnce(makeResult("llmgateway/deepseek-v4.1-flash"));

    const store = createModelCooldownStore(() => 0);
    const { result, attempts } = await spawnAgentWithFallback({
      model: "opencode-go/deepseek-v4.1-flash",
      modelClass: "frontier",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/deepseek-v4.1-flash");
    expect(attempts.map((a) => a.classification.kind)).toEqual(["quota", "success"]);
    // Entitlement failures are provider-scoped: the whole provider cools, not
    // just the failing model, so no other opencode-go candidate is attempted.
    expect(store.cooldownScope("opencode-go/deepseek-v4.1-flash")).toBe("provider");
    expect(store.isCoolingDown("opencode-go/glm-5.3")).toBe(true);
    expect(store.isCoolingDown("llmgateway/deepseek-v4.1-flash")).toBe(false);
  });

  it("uses modelClass to drive fallback for a known model", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("opencode-go/glm-5.3"))
      .mockResolvedValueOnce(makeResult("llmgateway/glm-5.3"));

    const { result, attempts } = await spawnAgentWithFallback({
      model: "opencode-go/glm-5.3",
      modelClass: "frontier",
      tools: [],
      systemPrompt: "t",
      task: "t",
      classify: seqClassifier("quota", "success"),
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/glm-5.3");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.model)).toEqual(["opencode-go/glm-5.3", "llmgateway/glm-5.3"]);
  });

  it("expands an unknown model using the explicit class", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("unknown/x"))
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));

    const { result, attempts } = await spawnAgentWithFallback({
      model: "unknown/x",
      modelClass: "fast",
      tools: [],
      systemPrompt: "t",
      task: "t",
      classify: seqClassifier("quota", "success"),
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/mimo-v2.6-flash");
    expect(attempts.map((a) => a.model)).toEqual(["unknown/x", "llmgateway/mimo-v2.6-flash"]);
    expect(attempts.map((a) => a.model)).not.toContain("llmgateway/unknown");
  });

  it("does not forward modelClass to spawnAgentProcess", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.6-flash"));

    await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      modelClass: "fast",
      tools: [],
      systemPrompt: "t",
      task: "t",
      classify: seqClassifier("success"),
    });

    // Exact-shape assertion: enumerate every key the spawner receives so a
    // stray modelClass key (even modelClass: undefined) fails the test.
    // toEqual alone cannot catch this — it treats undefined keys as absent.
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    const call = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toBeDefined();
    expect(Object.keys(call ?? {}).sort()).toEqual([
      "model",
      "sessionName",
      "suppressResumeWarning",
      "systemPrompt",
      "task",
      "tools",
    ]);
    expect(call).toEqual({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      sessionName: undefined,
      suppressResumeWarning: false,
    });
  });

  it("prefers explicit candidates over modelClass", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("custom/candidate"));

    const { attempts } = await spawnAgentWithFallback({
      model: "opencode-go/glm-5.3",
      modelClass: "fast",
      candidates: ["custom/candidate"],
      tools: [],
      systemPrompt: "t",
      task: "t",
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({ model: "custom/candidate" }),
    );
    expect(attempts.map((a) => a.model)).toEqual(["custom/candidate"]);
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

  it("does not burn a -fallback-N session for a skipped candidate", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("b", 0, { toolCalls: 2 }));
    const store = createModelCooldownStore(() => 0);
    store.markCooldown("a", 900, "quota");

    await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["a", "b"],
      sessionName: "belayd-x",
      cooldownStore: store,
      classify: seqClassifier("success"),
    });

    // The only spawn is the first *spawned* attempt, so it keeps the base name.
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({ model: "b", sessionName: "belayd-x" }),
    );
  });

  it("shares the base session id across candidates in resume mode", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("a"))
      .mockResolvedValueOnce(makeResult("b"));

    await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["a", "b"],
      sessionName: "belayd-x-retry-3",
      resumeSession: true,
      classify: seqClassifier("quota", "success"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: "a", sessionName: "belayd-x-retry-3", resumeSession: true }),
    );
    expect(mockSpawnAgentProcess).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: "b", sessionName: "belayd-x-retry-3", resumeSession: true }),
    );
    // The resume-unavailable warning is a per-spawn concern: only the first
    // candidate may warn, so later candidates suppress it.
    expect(mockSpawnAgentProcess).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ suppressResumeWarning: false }),
    );
    expect(mockSpawnAgentProcess).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ suppressResumeWarning: true }),
    );
  });

  it("aggregates usage across attempts", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("a", 0, { turns: 1, input: 5, cost: 0.1, toolCalls: 4 }))
      .mockResolvedValueOnce(makeResult("b", 0, { turns: 1, input: 10, cost: 0.2, toolCalls: 2 }));

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
    expect(result.details.usage).toHaveProperty("toolCalls", 6);
    expect(result.details.usage.cost).toBeCloseTo(0.3);
    // The classifier's view is the final attempt's own count, not the sum.
    expect(result.details.finalAttemptToolCalls).toBe(2);
  });

  it("exposes the final attempt's own tool-call count separately from the sum", async () => {
    // Attempt 1 does real work then quota-fails; attempt 2 silently exits 0 with
    // no tool calls. The aggregate is > 0, but the final attempt is a no-op.
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("a", 0, { toolCalls: 3 }))
      .mockResolvedValueOnce(makeResult("b", 0, { toolCalls: 0 }));

    const { result } = await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["a", "b"],
      classify: seqClassifier("quota", "success"),
    });

    expect(result.details.usage).toHaveProperty("toolCalls", 3);
    expect(result.details.finalAttemptToolCalls).toBe(0);
  });

  it("honors maxAttempts by stopping after the configured depth", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("a"));

    const { attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      maxAttempts: 1,
      classify: seqClassifier("quota"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
  });

  it("orders candidates away from a capacity-exhausted provider before the first attempt", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));

    const capacity = createCapacityCache({ now: () => 0 });
    capacity.record({ provider: "opencode-go", resetAt: 9_999_999, reason: "weekly limit" });

    const { attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: createModelCooldownStore(() => 0),
      capacity,
      classify: seqClassifier("success"),
    });

    // The first (and only) spawn must leave the known-exhausted provider alone.
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgentProcess.mock.calls[0]?.[0]).toHaveProperty(
      "model",
      "llmgateway/mimo-v2.6-flash",
    );
    expect(attempts[0]).toHaveProperty("model", "llmgateway/mimo-v2.6-flash");
  });

  it("records per-(phase, model) telemetry including zero-tool-call no-ops", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("a", 0, { toolCalls: 0, cost: 0.01 }))
      .mockResolvedValueOnce(makeResult("b", 0, { toolCalls: 0, cost: 0.02 }));

    const telemetry = createModelTelemetryStore();
    await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["a", "b"],
      phase: "implement",
      telemetry,
      classify: seqClassifier("quota", "success"),
    });

    expect(telemetry.stats()).toEqual([
      {
        phase: "implement",
        model: "a",
        attempts: 1,
        fallbacks: 0,
        quotaFailures: 1,
        noOps: 0,
        cost: 0.01,
      },
      {
        phase: "implement",
        model: "b",
        attempts: 1,
        fallbacks: 1,
        quotaFailures: 0,
        noOps: 1,
        cost: 0.02,
      },
    ]);
  });

  it("fast-fails without spawning when every candidate's provider is capacity-exhausted", async () => {
    const capacity = createCapacityCache({ now: () => 0 });
    capacity.record({ provider: "opencode-go", resetAt: 9_999_999, reason: "weekly limit" });

    const { result, attempts } = await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["opencode-go/a", "opencode-go/b"],
      capacity,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).not.toHaveBeenCalled();
    // Skip rows mirror the all-cooldown path, one per blocked candidate.
    expect(attempts.map((a) => a.model)).toEqual(["opencode-go/a", "opencode-go/b"]);
    expect(attempts.every((a) => a.skippedCapacity === "opencode-go")).toBe(true);
    expect(result.content[0]?.text).toContain("capacity-exhausted");
  });

  it("keys the telemetry fallback flag off the spawned-attempt ordinal, not the candidate index", async () => {
    // The first candidate is skipped (cooling), so the first actual spawn is at
    // index 1. It must still be attempt 1 with zero fallbacks.
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("b", 0, { toolCalls: 2 }));

    const store = createModelCooldownStore(() => 0);
    store.markCooldown("a", 900, "quota");
    const telemetry = createModelTelemetryStore();

    await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["a", "b"],
      cooldownStore: store,
      telemetry,
      phase: "plan",
      classify: seqClassifier("success"),
    });

    expect(telemetry.stats()).toEqual([
      {
        phase: "plan",
        model: "b",
        attempts: 1,
        fallbacks: 0,
        quotaFailures: 0,
        noOps: 0,
        cost: 0,
      },
    ]);
  });

  it("still spawns when the pre-dispatch capacity probe rejects", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(
      makeResult("opencode-go/mimo-v2.6-flash", 0, { toolCalls: 1 }),
    );
    const capacity = createCapacityCache({
      probe: () => {
        throw new Error("capacity endpoint down");
      },
    });

    const { result } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      capacity,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toHaveProperty("text", "result-from-opencode-go/mimo-v2.6-flash");
  });

  it("re-probes the capacity signal once the TTL expires between spawns", async () => {
    let nowMs = 0;
    const probe = vi.fn(() => ({ windows: [] }));
    const capacity = createCapacityCache({ probe, now: () => nowMs, ttlInMs: 1_000 });
    mockSpawnAgentProcess.mockResolvedValue(
      makeResult("opencode-go/mimo-v2.6-flash", 0, { toolCalls: 1 }),
    );

    const options = {
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      capacity,
      classify: seqClassifier("success"),
    };
    await spawnAgentWithFallback(options);
    expect(probe).toHaveBeenCalledTimes(1);

    nowMs = 1_000;
    await spawnAgentWithFallback(options);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("records an observed quota failure back into the capacity cache", async () => {
    const capacity = createCapacityCache({ now: () => 0 });
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("opencode-go/a", 0, { toolCalls: 0 }))
      .mockResolvedValueOnce(makeResult("llmgateway/a", 0, { toolCalls: 1 }));

    await spawnAgentWithFallback({
      model: "unknown/x",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["opencode-go/a", "llmgateway/a"],
      cooldownStore: createModelCooldownStore(() => 0),
      capacity,
      classify: seqClassifier("quota", "success"),
    });

    expect(capacity.isModelExhausted("opencode-go/anything")).toBe(true);
    expect(capacity.isModelExhausted("llmgateway/anything")).toBe(false);
    // Stamped with the cache's own clock (now: 0), not Date.now().
    expect(capacity.windows(0)).toEqual([
      { provider: "opencode-go", resetAt: 900_000, reason: "quota" },
    ]);
  });

  it("returns an empty exhausted result for maxAttempts: 0 without spawning", async () => {
    const { result, attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      maxAttempts: 0,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);
    expect(result.details.exitCode).toBe(1);
  });
});
