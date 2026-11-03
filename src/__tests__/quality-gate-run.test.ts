/**
 * Quality-gate retry model accounting (bd-234).
 *
 * A gate fix-up is a full spawn: it goes through `spawnAgentWithFallback`, so it
 * can skip a cooling provider and land on another one. That decision used to be
 * invisible — the retry's selection was dropped and no fallback trail reached the
 * delivery. These tests pin the retry path: the spawn skips the cooling
 * provider, the delivered text says so, and the caller receives the selection so
 * the run manifest can describe the attempt that actually served the run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition, QualityGate, SpawnResult, SpawnUsage } from "../agent-registry.js";
import { createCapacityCache } from "../capacity-cache.js";
import { createModelCooldownStore } from "../model-cooldown.js";
import { createModelTelemetryStore } from "../model-telemetry.js";
import { createQualityGateRunner } from "../quality-gate-run.js";
import {
  mergeRunModelSelections,
  type RunModelSelection,
  spawnAgentWithFallback,
} from "../spawn-with-fallback.js";
import type { Phase } from "../workflow-phases.js";

const mockSpawnAgentProcess = vi.hoisted(() => vi.fn());

vi.mock("../spawn.js", () => ({
  spawnAgentProcess: mockSpawnAgentProcess,
}));

function zeroUsage(): SpawnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 };
}

function makeResult(model: string): SpawnResult {
  return {
    content: [{ type: "text", text: `result-from-${model}` }],
    details: { messages: [], usage: zeroUsage(), exitCode: 0, model },
  };
}

/** An agent whose gate fails exactly once, so the runner takes the retry path. */
function agentWithFailingOnceGate(): { agent: AgentDefinition; gateCalls: () => number } {
  let calls = 0;
  const gate: QualityGate = async () => {
    calls += 1;
    return calls === 1
      ? { passed: false, feedback: "### tests\none failure" }
      : { passed: true, feedback: "All quality gates passed." };
  };
  return {
    agent: {
      name: "belayd-implementer",
      description: "test agent",
      modelClass: "fast",
      tools: [],
      systemPrompt: "",
      qualityGate: gate,
    },
    gateCalls: () => calls,
  };
}

describe("quality-gate retry model selection", () => {
  // Spawn calls are asserted per test, so nothing may leak between them.
  beforeEach(() => {
    mockSpawnAgentProcess.mockReset();
  });

  it("skips a cooling provider on the retry and reports the fallback trail", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.6-flash"));
    const { agent, gateCalls } = agentWithFailingOnceGate();
    // The retry's requested model sits on a provider with an active cooldown.
    const store = createModelCooldownStore(() => 0);
    store.markProviderCooldown("llmgateway", 3600, "quota", { cause: "quota" });
    const onSelection = vi.fn();
    const recordAttempt = vi.fn();

    const runGate = createQualityGateRunner({
      spawnAgentWithFallback,
      routing: {
        cooldownStore: store,
        enabled: true,
        telemetry: createModelTelemetryStore(),
        // Isolate the cooldown signal: the capacity cache reports nothing.
        capacity: createCapacityCache({ probe: () => ({ windows: [] }) }),
      },
      recordAttempt,
      isKnownPhase: (phaseName): phaseName is Phase => phaseName === "review",
    });

    const result = await runGate({
      agent,
      result: makeResult("llmgateway/mimo-v2.6-flash"),
      task: "fix the failure",
      workflowType: "bugfix",
      phaseName: "review",
      runId: "run1",
      onSelection,
    });

    // The retry spawned once, on the available provider rather than the cooled one.
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    const spawned = mockSpawnAgentProcess.mock.calls[0]?.[0] as { model: string } | undefined;
    expect(spawned?.model).toBe("opencode-go/mimo-v2.6-flash");
    expect(gateCalls()).toBe(2);

    // The delivery names the skip, so the operator sees why the retry moved.
    expect(result?.content[0]?.text).toContain("[belayd model fallback]");
    expect(result?.content[0]?.text).toContain("llmgateway/mimo-v2.6-flash (provider llmgateway");

    // The caller receives the retry's selection for the run manifest.
    expect(onSelection).toHaveBeenCalledTimes(1);
    const selection = onSelection.mock.calls[0]?.[0] as RunModelSelection | undefined;
    expect(selection).toHaveProperty("servedModel", "opencode-go/mimo-v2.6-flash");
    expect(selection).toHaveProperty("requestedModel", "llmgateway/mimo-v2.6-flash");
    expect(selection?.skipped[0]).toHaveProperty("model", "llmgateway/mimo-v2.6-flash");
    expect(recordAttempt).toHaveBeenCalledTimes(2);
  });

  it("keeps the folded selection bounded across ten gate retries", async () => {
    // The runner retries up to MAX_GATE_ATTEMPTS (10). Every retry re-skips the
    // same cooling provider, so the caller must fold them without growing the
    // manifest's skip list — and the last spawned model must still win.
    mockSpawnAgentProcess.mockResolvedValue(makeResult("opencode-go/mimo-v2.6-flash"));
    let gateCalls = 0;
    const gate: QualityGate = async () => {
      gateCalls += 1;
      return { passed: false, feedback: "### tests\nstill failing" };
    };
    const agent: AgentDefinition = {
      name: "belayd-implementer",
      description: "test agent",
      modelClass: "fast",
      tools: [],
      systemPrompt: "",
      qualityGate: gate,
    };
    const store = createModelCooldownStore(() => 0);
    store.markProviderCooldown("llmgateway", 3600, "quota", { cause: "quota" });
    const selections: RunModelSelection[] = [];

    const runGate = createQualityGateRunner({
      spawnAgentWithFallback,
      routing: {
        cooldownStore: store,
        enabled: true,
        telemetry: createModelTelemetryStore(),
        capacity: createCapacityCache({ probe: () => ({ windows: [] }) }),
      },
      recordAttempt: vi.fn(),
      isKnownPhase: (phaseName): phaseName is Phase => phaseName === "review",
    });

    const result = await runGate({
      agent,
      result: makeResult("llmgateway/mimo-v2.6-flash"),
      task: "fix the failure",
      workflowType: "bugfix",
      phaseName: "review",
      runId: "run1",
      onSelection: (selection) => selections.push(selection),
    });

    // Nine retries (attempts 2..10), each served by the available provider.
    expect(gateCalls).toBe(10);
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(9);
    expect(selections).toHaveLength(9);
    expect(selections.every((selection) => selection.skipped.length === 1)).toBe(true);
    const [first, ...rest] = selections;
    if (first === undefined) throw new Error("expected at least one gate-retry selection");
    const merged = rest.reduce(mergeRunModelSelections, first);
    expect(merged.skipped).toHaveLength(1);
    expect(merged).toHaveProperty("servedModel", "opencode-go/mimo-v2.6-flash");
    expect(merged).toHaveProperty("requestedModel", "llmgateway/mimo-v2.6-flash");
    expect(result?.content[0]?.text).toContain("still failing after 9 retries");
  });
});
