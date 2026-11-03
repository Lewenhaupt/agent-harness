import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SpawnResult, SpawnUsage } from "../agent-registry.js";
import { DEFAULT_AGENTS } from "../agent-registry.js";
import { createCapacityCache, probeFromCooldownStore } from "../capacity-cache.js";
import { type ModelClass, primaryModelOf, providerOf, resolveModelSpec } from "../model-classes.js";
import { type CooldownFs, createModelCooldownStore } from "../model-cooldown.js";
import { createModelTelemetryStore } from "../model-telemetry.js";
import { withFallbackNote } from "../quality-gate-run.js";
import {
  type classifySpawnFailure,
  DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS,
  DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
  type FailureClassification,
} from "../quota-failure.js";
import {
  deriveRunModelSelection,
  mergeRunModelSelections,
  type SpawnAttempt,
  spawnAgentWithFallback,
} from "../spawn-with-fallback.js";

const mockSpawnAgentProcess = vi.hoisted(() => vi.fn());

vi.mock("../spawn.js", () => ({
  spawnAgentProcess: mockSpawnAgentProcess,
}));

beforeEach(() => {
  mockSpawnAgentProcess.mockReset();
});

interface FakeCooldownFs extends CooldownFs {
  files: Map<string, string>;
}

/**
 * A node-style fs error. `NodeJS.ErrnoException` already carries the optional
 * `code`, so the fake needs no cast to behave like the real seam.
 */
function fsError(code: "ENOENT" | "EEXIST", path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: ${path}`);
  error.code = code;
  return error;
}

/** In-memory `CooldownFs` seam, so no cooldown test touches the real disk. */
function createFakeCooldownFs(initial: Record<string, string> = {}): FakeCooldownFs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync(path) {
      return files.has(path);
    },
    readFileSync(path) {
      const content = files.get(path);
      if (content === undefined) throw fsError("ENOENT", path);
      return content;
    },
    writeFileSync(path, data, options) {
      if (options?.flag === "wx" && files.has(path)) throw fsError("EEXIST", path);
      files.set(path, data);
    },
    renameSync(oldPath, newPath) {
      const content = files.get(oldPath);
      if (content === undefined) throw fsError("ENOENT", oldPath);
      files.delete(oldPath);
      files.set(newPath, content);
    },
    mkdirSync() {
      // In-memory fs has no directory hierarchy to create.
    },
    unlinkSync(path) {
      files.delete(path);
    },
  };
}

/** The persisted file's shape, validated at the boundary instead of cast. */
const PersistedCooldownStateSchema = z.object({
  providers: z.record(z.string(), z.object({ until: z.number(), reason: z.string() })),
  models: z.record(z.string(), z.object({ until: z.number(), reason: z.string() })),
});

function readPersistedCooldowns(
  fs: FakeCooldownFs,
  path: string,
): z.infer<typeof PersistedCooldownStateSchema> {
  const raw = fs.files.get(path);
  if (raw === undefined) throw new Error(`missing persisted cooldown file ${path}`);
  return PersistedCooldownStateSchema.parse(JSON.parse(raw));
}

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
    // The skip row names the cause, so the log answers "why skipped?" without a
    // trip to ~/.pi/agent/model-cooldowns.json.
    expect(attempts[1]).toHaveProperty(
      "classification.reason",
      expect.stringContaining("after a quota failure"),
    );
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(2);
  });

  it("reports a missing key as the skip cause, not a quota failure (bd-178)", async () => {
    // Warning 2: generalizing the phrase must not collapse "bucket spent" and
    // "no key configured" into one opaque sentence.
    const noKeyDetails = {
      messages: [
        {
          role: "assistant",
          content: [],
          model: "commandcode/z-ai/glm-5.3-flash",
          stopReason: "error",
          errorMessage:
            "No Command Code API key. Run /login and select Command Code, set COMMAND_CODE_API_KEY (or legacy COMMANDCODE_API_KEY), or configure ~/.commandcode/auth.json, ~/.pi/agent/auth.json or ~/.omp/agent/auth.json",
        },
      ],
      usage: zeroUsage(),
      exitCode: 0,
    };
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        ...makeResult("commandcode/z-ai/glm-5.3-flash"),
        details: noKeyDetails,
      })
      .mockResolvedValueOnce(makeResult("llmgateway/glm-5.3-flash"));

    const store = createModelCooldownStore(() => 0);
    const first = await spawnAgentWithFallback({
      model: "commandcode/z-ai/glm-5.3-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      candidates: [
        "commandcode/z-ai/glm-5.3-flash",
        "commandcode/zai-org/GLM-5.3",
        "llmgateway/glm-5.3-flash",
      ],
    });

    // Same-provider sibling is skipped inside the same run, with the key cause.
    expect(first.attempts.map((a) => a.model)).toEqual([
      "commandcode/z-ai/glm-5.3-flash",
      "commandcode/zai-org/GLM-5.3",
      "llmgateway/glm-5.3-flash",
    ]);
    expect(first.attempts[1]).toHaveProperty("skippedProvider", "commandcode");
    expect(first.attempts[1]).toHaveProperty(
      "classification.reason",
      expect.stringContaining("has no API key configured"),
    );

    mockSpawnAgentProcess.mockReset();
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("llmgateway/glm-5.3-flash"));
    const second = await spawnAgentWithFallback({
      model: "commandcode/z-ai/glm-5.3-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      candidates: ["commandcode/z-ai/glm-5.3-flash", "llmgateway/glm-5.3-flash"],
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(second.attempts[0]).toHaveProperty("skippedProvider", "commandcode");
    expect(second.attempts[0]).toHaveProperty(
      "classification.reason",
      expect.stringContaining("has no API key configured"),
    );
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

  it("refuses the kill-switch model when it is cooling down", async () => {
    // `enabled: false` means "no fallback", not "ignore a spent provider":
    // spawning here would burn a request against a provider already known dead.
    const store = createModelCooldownStore(() => 0);
    store.markProviderCooldown("opencode-go", 900, "quota", { cause: "quota" });

    const { result, attempts, selection } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      enabled: false,
      cooldownStore: store,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toHaveProperty("skippedProvider", "opencode-go");
    expect(result.content[0]).toHaveProperty(
      "text",
      expect.stringContaining("opencode-go/mimo-v2.6-flash"),
    );
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("cooldown"));
    // Nothing ran, so no model is reported as having served the run.
    expect(selection).not.toHaveProperty("servedModel");
  });

  it("refuses the kill-switch model when it has no API key configured", async () => {
    // A missing credential is an operator fix, not a spent quota: the refusal
    // must name the real cause instead of reusing the cooldown sentence.
    const store = createModelCooldownStore(() => 0);
    store.markProviderCooldown("commandcode", 3600, "no key", { cause: "unconfigured" });

    const { result, attempts } = await spawnAgentWithFallback({
      model: "commandcode/z-ai/glm-5.3-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      enabled: false,
      cooldownStore: store,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).not.toHaveBeenCalled();
    expect(attempts[0]).toHaveProperty("skippedProvider", "commandcode");
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("no API key"));
    expect(result.content[0]).toHaveProperty(
      "text",
      expect.stringContaining("Refusing to dispatch"),
    );
    expect(result.content[0]).not.toHaveProperty("text", expect.stringContaining("in cooldown"));
  });

  it("reports an aborted run distinctly from an all-cooling one", async () => {
    const controller = new AbortController();
    controller.abort();

    const { result, attempts } = await spawnAgentWithFallback({
      model: "unknown/x",
      candidates: ["a", "b"],
      tools: [],
      systemPrompt: "t",
      task: "t",
      signal: controller.signal,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);
    expect(result.content[0]).toHaveProperty(
      "text",
      "Run aborted before any candidate could be dispatched.",
    );
  });

  it("never replaces a spawned attempt's result with the abort wording", async () => {
    // A cancellation that lands DURING the spawn must not mask the attempt that
    // really ran: the caller has to see the provider's result (and its exit
    // code), not "aborted before dispatch".
    const controller = new AbortController();
    mockSpawnAgentProcess.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(makeResult("opencode-go/a", 1));
    });

    const { result, attempts, selection } = await spawnAgentWithFallback({
      model: "opencode-go/a",
      candidates: ["opencode-go/a", "commandcode/b"],
      tools: [],
      systemPrompt: "t",
      task: "t",
      signal: controller.signal,
      classify: seqClassifier("quota"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    expect(result.content[0]).toHaveProperty("text", "result-from-opencode-go/a");
    expect(result.content[0]).not.toHaveProperty("text", expect.stringContaining("aborted"));
    expect(result.details).toHaveProperty("exitCode", 1);
    expect(selection).toHaveProperty("servedModel", "opencode-go/a");
  });

  it("keeps the cooldown wording when every candidate is cooling and nothing spawned", async () => {
    const store = createModelCooldownStore(() => 0);
    store.markProviderCooldown("opencode-go", 900, "quota");
    store.markProviderCooldown("llmgateway", 900, "quota");

    const { result, attempts } = await spawnAgentWithFallback({
      model: "unknown/x",
      candidates: ["opencode-go/a", "llmgateway/b"],
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).not.toHaveBeenCalled();
    expect(attempts.every((attempt) => attempt.skippedProvider !== undefined)).toBe(true);
    expect(result.content[0]).toHaveProperty(
      "text",
      expect.stringContaining("All candidate models are in cooldown"),
    );
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

  it("end-to-end: a model-not-in-plan 403 cools only that endpoint and keeps the provider", async () => {
    // bd-178: Command Code gates models by plan. `unavailable` is
    // model-scoped, so the retry lands on a different provider for the SAME
    // model id and the Command Code bucket stays usable for its other ids.
    const gatedDetails = {
      messages: [
        {
          role: "assistant",
          content: [],
          model: "commandcode/zai-org/GLM-5.3",
          stopReason: "error",
          errorMessage:
            '403: {"error":{"code":"MODEL_NOT_IN_PLAN","message":"zai-org/GLM-5.3 is not included in your plan"}}',
        },
      ],
      usage: zeroUsage(),
      exitCode: 0,
    };
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        ...makeResult("commandcode/zai-org/GLM-5.3"),
        details: gatedDetails,
      })
      .mockResolvedValueOnce(makeResult("llmgateway/glm-5.3"));

    const store = createModelCooldownStore(() => 0);
    const { result, attempts } = await spawnAgentWithFallback({
      model: "commandcode/zai-org/GLM-5.3",
      modelClass: "frontier",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      candidates: ["commandcode/zai-org/GLM-5.3", "llmgateway/glm-5.3"],
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/glm-5.3");
    expect(attempts.map((a) => a.classification.kind)).toEqual(["unavailable", "success"]);
    // Model-scoped: only the gated endpoint cools, never the provider bucket.
    expect(store.cooldownScope("commandcode/zai-org/GLM-5.3")).toBe("model");
    expect(store.providerEntries().size).toBe(0);
    expect(store.isCoolingDown("commandcode/z-ai/glm-5.3-flash")).toBe(false);
    expect(store.isCoolingDown("llmgateway/glm-5.3")).toBe(false);
  });

  it("end-to-end: an unkeyed Command Code provider degrades to llmgateway", async () => {
    // bd-178: the standard primary lives on commandcode and the key is per-host,
    // so an unconfigured provider must fall through, not fail the phase. The
    // extension emits a statusless error, which used to classify as `other`
    // (isFallbackWorthy false) and stop the loop — contrast the auth/other test
    // above, which still stops.
    const noKeyDetails = {
      messages: [
        {
          role: "assistant",
          content: [],
          model: "commandcode/z-ai/glm-5.3-flash",
          stopReason: "error",
          errorMessage:
            "No Command Code API key. Run /login and select Command Code, set COMMAND_CODE_API_KEY (or legacy COMMANDCODE_API_KEY), or configure ~/.commandcode/auth.json, ~/.pi/agent/auth.json or ~/.omp/agent/auth.json",
        },
      ],
      usage: zeroUsage(),
      exitCode: 0,
    };
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        ...makeResult("commandcode/z-ai/glm-5.3-flash"),
        details: noKeyDetails,
      })
      .mockResolvedValueOnce(makeResult("llmgateway/glm-5.3-flash"));

    const store = createModelCooldownStore(() => 0);
    const { result, attempts } = await spawnAgentWithFallback({
      model: "commandcode/z-ai/glm-5.3-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      candidates: ["commandcode/z-ai/glm-5.3-flash", "llmgateway/glm-5.3-flash"],
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/glm-5.3-flash");
    expect(attempts.map((a) => a.classification.kind)).toEqual(["unconfigured", "success"]);
    // Provider-scoped: the missing key disables every Command Code model, so
    // siblings are skipped too — while llmgateway stays available.
    expect(store.cooldownScope("commandcode/z-ai/glm-5.3-flash")).toBe("provider");
    expect(store.isCoolingDown("commandcode/zai-org/GLM-5.3")).toBe(true);
    expect(store.isCoolingDown("llmgateway/glm-5.3-flash")).toBe(false);
    expect(store.entries().size).toBe(0);
  });

  it("end-to-end: pi's process-path no-key refusal degrades to llmgateway (bd-178)", async () => {
    // The production shape: pi exits 1 with `No API key found for commandcode.`
    // on stderr and never emits an assistant turn, so only the process path can
    // classify it. That path used to return `other`, which stopped the loop.
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "(no output)" }],
        details: {
          messages: [],
          usage: zeroUsage(),
          exitCode: 1,
          model: "commandcode/z-ai/glm-5.3-flash",
          stderr: "No API key found for commandcode.",
        },
      })
      .mockResolvedValueOnce(makeResult("llmgateway/glm-5.3-flash"));

    const store = createModelCooldownStore(() => 0);
    const { result, attempts } = await spawnAgentWithFallback({
      model: "commandcode/z-ai/glm-5.3-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      candidates: ["commandcode/z-ai/glm-5.3-flash", "llmgateway/glm-5.3-flash"],
    });

    expect(attempts.map((a) => a.classification.kind)).toEqual(["unconfigured", "success"]);
    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/glm-5.3-flash");
    // Same provider-scoped, tagged cooldown the assistant path writes — the
    // process path is a different classifier, not a different cooldown rule —
    // and the tag keeps it out of the capacity signal.
    expect(store.cooldownScope("commandcode/z-ai/glm-5.3-flash")).toBe("provider");
    expect(store.providerEntries().get("commandcode")).toHaveProperty("cause", "unconfigured");
    expect(store.providerEntries().get("commandcode")).toHaveProperty(
      "reason",
      "Provider has no API key configured.",
    );
    expect((await probeFromCooldownStore(store)()).windows).toEqual([]);
    expect(withFallbackNote(result, attempts).content[0]).toHaveProperty(
      "text",
      "result-from-llmgateway/glm-5.3-flash\n\n[belayd model fallback] commandcode/z-ai/glm-5.3-flash (unconfigured) → llmgateway/glm-5.3-flash (success)",
    );
  });

  it("terminates and surfaces the trail when every hop has no key (bd-178)", async () => {
    // A keyless host must not loop or report success: each fallback-worthy
    // unconfigured attempt consumes its own candidate, then the loop returns the
    // last real failure (exit 1) with the whole trail as the note.
    const noKey = (model: string, provider: string) => ({
      // `spawnAgentProcess` reports an empty run as "(no output)", which is what
      // the caller sees after the loop gives up.
      content: [{ type: "text", text: "(no output)" }],
      details: {
        messages: [],
        usage: zeroUsage(),
        exitCode: 1,
        model,
        stderr: `No API key found for ${provider}.`,
      },
    });
    mockSpawnAgentProcess
      .mockResolvedValueOnce(noKey("commandcode/z-ai/glm-5.3-flash", "commandcode"))
      .mockResolvedValueOnce(noKey("llmgateway/glm-5.3-flash", "llmgateway"));

    const store = createModelCooldownStore(() => 0);
    const { result, attempts } = await spawnAgentWithFallback({
      model: "commandcode/z-ai/glm-5.3-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      candidates: ["commandcode/z-ai/glm-5.3-flash", "llmgateway/glm-5.3-flash"],
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(2);
    expect(attempts.map((a) => a.classification.kind)).toEqual(["unconfigured", "unconfigured"]);
    expect(result.details.exitCode).toBe(1);
    expect(withFallbackNote(result, attempts).content[0]).toHaveProperty(
      "text",
      "(no output)\n\n[belayd model fallback] commandcode/z-ai/glm-5.3-flash (unconfigured) → llmgateway/glm-5.3-flash (unconfigured)",
    );
    // A missing key disables each bucket, and none of it is capacity.
    expect(store.cooldownScope("commandcode/anything")).toBe("provider");
    expect(store.cooldownScope("llmgateway/anything")).toBe("provider");
    expect((await probeFromCooldownStore(store)()).windows).toEqual([]);
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

  it("does not fast-fail on a provider that is only unconfigured (bd-178)", async () => {
    // Warning 1: the cooldown store is the production capacity probe. An
    // unconfigured provider must be skipped reactively (with its cause), never
    // reported as capacity-exhausted and never fast-failed.
    const store = createModelCooldownStore(() => 0);
    store.markProviderCooldown("commandcode", 600, "Provider has no API key configured.", {
      cause: "unconfigured",
    });
    const capacity = createCapacityCache({
      probe: probeFromCooldownStore(store),
      now: () => 0,
    });
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("llmgateway/glm-5.3-flash"));

    const { result, attempts } = await spawnAgentWithFallback({
      model: "commandcode/z-ai/glm-5.3-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates: ["commandcode/z-ai/glm-5.3-flash", "llmgateway/glm-5.3-flash"],
      capacity,
      cooldownStore: store,
      classify: seqClassifier("success"),
    });

    expect(result.content[0]).toHaveProperty("text", "result-from-llmgateway/glm-5.3-flash");
    expect(attempts.map((a) => a.skippedCapacity)).toEqual([undefined, undefined]);
    expect(attempts[0]).toHaveProperty("skippedProvider", "commandcode");
    expect(attempts[0]).toHaveProperty(
      "classification.reason",
      expect.stringContaining("has no API key configured"),
    );
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
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
    // No candidates is a configuration outcome, not a cooldown: the copy must
    // not print an empty parenthesis list.
    expect(result.content[0]).toHaveProperty(
      "text",
      "All candidate models are in cooldown; retry later.",
    );
  });

  it("reports an abort when maxAttempts: 0 wins the early exit during cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const { result, attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      maxAttempts: 0,
      signal: controller.signal,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);
    // Same wording as the in-loop abort, so a cancelled run never reads as an
    // all-cooling run.
    expect(result.content[0]).toHaveProperty(
      "text",
      "Run aborted before any candidate could be dispatched.",
    );
  });
});

describe("spawnAgentWithFallback provider usage limits (bd-38)", () => {
  /** The live opencode-go exhaustion body: no reset hint, weekly bucket. */
  const GO_USAGE_LIMIT_DETAILS = {
    messages: [
      {
        role: "assistant",
        content: [],
        model: "opencode-go/mimo-v2.6-flash",
        stopReason: "error",
        errorMessage: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}',
      },
    ],
    usage: zeroUsage(),
    exitCode: 0,
  };

  function goLimitResult(): SpawnResult {
    return {
      ...makeResult("opencode-go/mimo-v2.6-flash"),
      details: { ...GO_USAGE_LIMIT_DETAILS, usage: zeroUsage() },
    };
  }

  const candidates = ["opencode-go/mimo-v2.6-flash", "llmgateway/mimo-v2.6-flash"];

  it("cools the provider for hours, so 15 minutes later it is still skipped", async () => {
    mockSpawnAgentProcess
      .mockResolvedValueOnce(goLimitResult())
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));

    const store = createModelCooldownStore(() => 0);
    const first = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates,
      cooldownStore: store,
    });

    expect(first.attempts.map((a) => a.classification.kind)).toEqual(["quota", "success"]);
    // The old 15-minute default expired long before the real weekly reset and
    // re-probed the exhausted provider; the provider window does not.
    expect(store.cooldownScope("opencode-go/mimo-v2.6-flash", 15 * 60 * 1000 + 1)).toBe("provider");
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS * 1000,
    );

    mockSpawnAgentProcess.mockReset();
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));
    const second = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates,
      cooldownStore: store,
    });

    // No spawn on the exhausted provider: the first candidate is a skip row.
    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgentProcess.mock.calls[0]?.[0]).toHaveProperty(
      "model",
      "llmgateway/mimo-v2.6-flash",
    );
    expect(second.attempts[0]).toHaveProperty("skippedProvider", "opencode-go");
  });

  it("does not apply the long provider window on a model-scoped failure", async () => {
    // A 5xx that happens to mention the usage limit is still endpoint health, not
    // an exhausted subscription bucket: cooling the whole provider for hours
    // would hide its healthy sibling models from the very next spawn.
    const transientDetails = {
      messages: [
        {
          role: "assistant",
          content: [],
          model: "opencode-go/mimo-v2.6-flash",
          stopReason: "error",
          errorMessage: '503: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}',
        },
      ],
      usage: zeroUsage(),
      exitCode: 0,
    };
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        ...makeResult("opencode-go/mimo-v2.6-flash"),
        details: transientDetails,
      })
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));

    const store = createModelCooldownStore(() => 0);
    const { attempts } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates,
      cooldownStore: store,
    });

    expect(attempts.map((a) => a.classification.kind)).toEqual(["transient", "success"]);
    expect(store.cooldownScope("opencode-go/mimo-v2.6-flash")).toBe("model");
    expect(store.entries().get("opencode-go/mimo-v2.6-flash")).toHaveProperty(
      "until",
      DEFAULT_TRANSIENT_COOLDOWN_SECONDS * 1000,
    );
    expect(store.providerEntries().size).toBe(0);
    // The provider's other models stay usable, and 5xx noise never escalates.
    expect(store.isCoolingDown("opencode-go/deepseek-v4.1-flash")).toBe(false);
    expect(store.entries().get("opencode-go/mimo-v2.6-flash")).not.toHaveProperty("escalations");
  });

  it("escalates the provider window on a repeated unhinted 429", async () => {
    let now = 0;
    const store = createModelCooldownStore(() => now);
    mockSpawnAgentProcess
      .mockResolvedValueOnce(goLimitResult())
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));

    await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates,
      cooldownStore: store,
    });
    const firstUntil = store.providerEntries().get("opencode-go")?.until ?? 0;
    expect(firstUntil).toBe(DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS * 1000);

    // The window expired and the provider is still exhausted: the next unhinted
    // 429 must cost double instead of re-guessing the same span.
    now = firstUntil + 60_000;
    mockSpawnAgentProcess.mockReset();
    mockSpawnAgentProcess
      .mockResolvedValueOnce(goLimitResult())
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));
    await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates,
      cooldownStore: store,
    });
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      now + 2 * DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS * 1000,
    );

    // A body that states its reset is authoritative: exact window, ladder reset.
    now = (store.providerEntries().get("opencode-go")?.until ?? 0) + 60_000;
    mockSpawnAgentProcess.mockReset();
    mockSpawnAgentProcess
      .mockResolvedValueOnce({
        ...makeResult("opencode-go/mimo-v2.6-flash"),
        details: {
          messages: [
            {
              role: "assistant",
              content: [],
              model: "opencode-go/mimo-v2.6-flash",
              stopReason: "error",
              errorMessage:
                '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 7hr 57min."}',
            },
          ],
          usage: zeroUsage(),
          exitCode: 0,
        },
      })
      .mockResolvedValueOnce(makeResult("llmgateway/mimo-v2.6-flash"));
    await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      candidates,
      cooldownStore: store,
    });
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      now + (7 * 3600 + 57 * 60) * 1000,
    );
    expect(store.providerEntries().get("opencode-go")).not.toHaveProperty("escalations");
  });
});

describe("spawnAgentWithFallback cooldown freshness (bd-234)", () => {
  const cooldownFilePath = "/tmp/model-cooldowns.json";
  const nowMs = 1_000_000;
  const now = (): number => nowMs;

  it("consults the persisted cooldown file at selection time, not the process snapshot", async () => {
    const fs = createFakeCooldownFs();
    // Created BEFORE any cooldown exists on disk: its in-memory maps are the
    // stale snapshot the picker used to trust for a whole process lifetime.
    const store = createModelCooldownStore({ now, filePath: cooldownFilePath, fs });
    // Another fleet member spends opencode-go and llmgateway afterwards.
    const otherMember = createModelCooldownStore({ now, filePath: cooldownFilePath, fs });
    otherMember.markProviderCooldown("opencode-go", 24 * 3600, "quota");
    otherMember.markProviderCooldown("llmgateway", 5.6 * 3600, "quota");

    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("commandcode/xiaomi/mimo-v2.6-flash"));

    const { attempts, selection } = await spawnAgentWithFallback({
      model: "llmgateway/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    const spawned = mockSpawnAgentProcess.mock.calls[0]?.[0] as { model: string } | undefined;
    expect(providerOf(spawned?.model ?? "")).toBe("commandcode");
    // The skip rows keep their preference order ahead of the spawn.
    expect(attempts.map((a) => a.skippedProvider ?? "spawned")).toEqual([
      "llmgateway",
      "opencode-go",
      "spawned",
    ]);
    expect(selection).toHaveProperty("servedModel", "commandcode/xiaomi/mimo-v2.6-flash");
    expect(selection).toHaveProperty("requestedModel", "llmgateway/mimo-v2.6-flash");
    expect(selection.skipped.map((row) => row.model)).toEqual([
      "llmgateway/mimo-v2.6-flash",
      "opencode-go/mimo-v2.6-flash",
    ]);
    expect(selection.skipped[0]?.reason).toContain("cooling down");
    // The run's own selection-time refresh is what taught this store: after the
    // spawn it must know the cooldown it was blind to at construction. This is
    // the assertion that fails on the pre-fix picker (bd-234 review W5).
    expect(store.cooldownScope("llmgateway/anything")).toBe("provider");
  });

  it("picks the one available provider for every phase agent and class primary", async () => {
    // Seeded through the SHARED FILE after the picker's store was created, so
    // only a selection-time refresh can explain the commandcode pick: a
    // creation-time snapshot still sees three healthy providers. (Re-anchored by
    // the bd-234 review: this test previously marked the shared store in memory
    // and therefore passed on the pre-fix picker as a store-layer guard.)
    const fs = createFakeCooldownFs();
    const store = createModelCooldownStore({ now, filePath: cooldownFilePath, fs });
    const otherMember = createModelCooldownStore({ now, filePath: cooldownFilePath, fs });
    otherMember.markProviderCooldown("opencode-go", 24 * 3600, "quota");
    otherMember.markProviderCooldown("llmgateway", 5.6 * 3600, "quota");

    const classPrimaries: { model: string; modelClass: ModelClass }[] = (
      ["frontier", "standard", "fast"] as const
    ).map((modelClass) => ({ model: primaryModelOf(modelClass), modelClass }));
    const specs = [...DEFAULT_AGENTS.map((agent) => resolveModelSpec(agent)), ...classPrimaries];

    for (const spec of specs) {
      mockSpawnAgentProcess.mockReset();
      mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("commandcode/served"));

      const { attempts } = await spawnAgentWithFallback({
        model: spec.model,
        modelClass: spec.modelClass,
        tools: [],
        systemPrompt: "t",
        task: "t",
        cooldownStore: store,
        classify: seqClassifier("success"),
      });

      expect(mockSpawnAgentProcess, spec.model).toHaveBeenCalledTimes(1);
      const spawned = mockSpawnAgentProcess.mock.calls[0]?.[0] as { model: string } | undefined;
      expect(providerOf(spawned?.model ?? ""), spec.model).toBe("commandcode");
      // Exactly one attempt spawned, and it is the commandcode one: the cooled
      // candidates may be reported but never tried.
      const spawnedAttempts = attempts.filter(
        (attempt) => attempt.skippedProvider === undefined && attempt.skippedCooldown !== true,
      );
      expect(
        spawnedAttempts.map((attempt) => providerOf(attempt.model)),
        spec.model,
      ).toEqual(["commandcode"]);
    }
  });

  it("persists a quota cooldown before the next candidate is chosen", async () => {
    const fs = createFakeCooldownFs();
    const store = createModelCooldownStore({ now, filePath: cooldownFilePath, fs });
    // Another process's store, created BEFORE the first run learns anything:
    // only its selection-time refresh can make it skip llmgateway. (Re-anchored
    // by the bd-234 review: created after the write, this passed pre-fix as a
    // store-layer guard because construction already loaded the entry.)
    const blindStore = createModelCooldownStore({ now, filePath: cooldownFilePath, fs });
    mockSpawnAgentProcess
      .mockResolvedValueOnce(makeResult("llmgateway/a"))
      .mockImplementationOnce(() => {
        // The failed provider must already be on disk when the retry candidate
        // is picked, not just in this process's memory.
        expect(
          readPersistedCooldowns(fs, cooldownFilePath).providers,
          "llmgateway cooldown persisted before the retry",
        ).toHaveProperty("llmgateway.until", nowMs + 900 * 1000);
        return Promise.resolve(makeResult("commandcode/b"));
      });

    const first = await spawnAgentWithFallback({
      model: "llmgateway/a",
      candidates: ["llmgateway/a", "commandcode/b"],
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      classify: seqClassifier("quota", "success"),
    });
    expect(first.selection).toHaveProperty("servedModel", "commandcode/b");

    // A second run in a fresh process (store from before the write, same file)
    // must not pay the failed attempt again.
    mockSpawnAgentProcess.mockReset();
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("commandcode/b"));
    const second = await spawnAgentWithFallback({
      model: "llmgateway/a",
      candidates: ["llmgateway/a", "commandcode/b"],
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: blindStore,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    const spawned = mockSpawnAgentProcess.mock.calls[0]?.[0] as { model: string } | undefined;
    expect(spawned?.model).toBe("commandcode/b");
    expect(second.attempts[0]).toHaveProperty("skippedProvider", "llmgateway");
  });

  it("does not spend the maxAttempts cap on a cooldown skip", async () => {
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("commandcode/b"));
    const store = createModelCooldownStore(() => 0);
    store.markProviderCooldown("opencode-go", 900, "quota");

    const { result, attempts } = await spawnAgentWithFallback({
      model: "unknown/x",
      candidates: ["opencode-go/a", "commandcode/b", "commandcode/c"],
      tools: [],
      systemPrompt: "t",
      task: "t",
      maxAttempts: 1,
      cooldownStore: store,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    expect(attempts[0]).toHaveProperty("skippedProvider", "opencode-go");
    expect(attempts[1]).toHaveProperty("model", "commandcode/b");
    // The cap still stops the loop after one spawn: the third candidate is not
    // reached, skip row or not.
    expect(attempts).toHaveLength(2);
    expect(result.content[0]).toHaveProperty("text", "result-from-commandcode/b");
  });

  it("refuses a cooling kill-switch model discovered on the shared file", async () => {
    // The kill-switch branch sits AFTER the selection-time refresh on purpose:
    // "no fallback" must not mean "spawn on a provider another fleet member
    // already spent". Seeding the shared file (not the handed-in store) is what
    // makes the refresh, rather than construction, the reason it is seen.
    const fs = createFakeCooldownFs();
    const store = createModelCooldownStore({ now, filePath: cooldownFilePath, fs });
    const otherMember = createModelCooldownStore({ now, filePath: cooldownFilePath, fs });
    otherMember.markProviderCooldown("opencode-go", 24 * 3600, "quota", { cause: "quota" });

    const { result, attempts, selection } = await spawnAgentWithFallback({
      model: "opencode-go/mimo-v2.6-flash",
      tools: [],
      systemPrompt: "t",
      task: "t",
      enabled: false,
      cooldownStore: store,
      classify: seqClassifier("success"),
    });

    expect(mockSpawnAgentProcess).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toHaveProperty("skippedProvider", "opencode-go");
    expect(result.details).toHaveProperty("exitCode", 1);
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("cooldown"));
    expect(selection).not.toHaveProperty("servedModel");
  });

  it("spawns nothing and does not spin when every candidate is cooling and no cap is set", async () => {
    const store = createModelCooldownStore(() => 0);
    const candidates = ["a", "b", "c", "d", "e"];
    for (const model of candidates) store.markCooldown(model, 900, "quota");
    const telemetry = createModelTelemetryStore();

    const { result, attempts, selection } = await spawnAgentWithFallback({
      model: "unknown/x",
      candidates,
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: store,
      telemetry,
      phase: "plan",
      classify: seqClassifier("success"),
    });

    // One pass over the candidates, no dispatch, and no telemetry row for a
    // candidate that was never tried (so no fallback was counted either).
    expect(mockSpawnAgentProcess).not.toHaveBeenCalled();
    expect(attempts.map((attempt) => attempt.model)).toEqual(candidates);
    expect(attempts.every((attempt) => attempt.skippedCooldown === true)).toBe(true);
    expect(telemetry.stats()).toEqual([]);
    expect(result.details).toHaveProperty("exitCode", 1);
    expect(selection).not.toHaveProperty("servedModel");
    expect(selection.skipped).toHaveLength(candidates.length);
  });
});

describe("withFallbackNote copy (bd-234)", () => {
  it("keeps the existing trail wording for every skip cause", () => {
    const attempts: SpawnAttempt[] = [
      {
        model: "llmgateway/a",
        classification: { kind: "other", reason: "Provider llmgateway is cooling down." },
        skippedProvider: "llmgateway",
      },
      {
        model: "opencode-go/a",
        classification: { kind: "other", reason: "Model opencode-go/a is cooling down." },
        skippedCooldown: true,
      },
      {
        model: "commandcode/a",
        classification: { kind: "other", reason: "weekly limit" },
        skippedCapacity: "commandcode",
      },
      { model: "openrouter/a", classification: { kind: "quota" } },
    ];

    const noted = withFallbackNote(makeResult("openrouter/a"), attempts);

    // Adding the skip row must not rewrite the trail an operator already reads.
    expect(noted.content[0]).toHaveProperty(
      "text",
      "result-from-openrouter/a\n\n[belayd model fallback] llmgateway/a (provider llmgateway exhausted) → opencode-go/a (cooldown) → commandcode/a (provider commandcode capacity-exhausted) → openrouter/a (quota)",
    );
  });

  it("leaves a single-attempt result untouched", () => {
    // A run whose first candidate served it has no trail to trail.
    const result = makeResult("commandcode/a");

    expect(
      withFallbackNote(result, [{ model: "commandcode/a", classification: { kind: "success" } }]),
    ).toBe(result);
  });
});

describe("deriveRunModelSelection", () => {
  const skippedRow = (model: string, reason: string): SpawnAttempt => ({
    model,
    classification: { kind: "other", reason },
    skippedProvider: providerOf(model),
  });
  const spawnedRow = (model: string): SpawnAttempt => ({
    model,
    classification: { kind: "success" },
  });

  it("prefers the model the spawn layer reported as served", () => {
    const attempts = [skippedRow("llmgateway/a", "cooling down"), spawnedRow("commandcode/b")];
    const selection = deriveRunModelSelection("llmgateway/a", attempts, "commandcode/served");

    expect(selection).toHaveProperty("servedModel", "commandcode/served");
    expect(selection).toHaveProperty("requestedModel", "llmgateway/a");
  });

  it("falls back to the last spawned attempt when no served model is reported", () => {
    const attempts = [skippedRow("llmgateway/a", "cooling down"), spawnedRow("commandcode/b")];
    const selection = deriveRunModelSelection("llmgateway/a", attempts);

    // The first attempt row is the skip row, so the served model cannot be
    // read off `attempts[0]`.
    expect(selection).toHaveProperty("servedModel", "commandcode/b");
  });

  it("maps every skip row to its recorded reason and leaves spawned rows out", () => {
    const attempts: SpawnAttempt[] = [
      {
        model: "llmgateway/a",
        classification: { kind: "other", reason: "r1" },
        skippedProvider: "llmgateway",
      },
      {
        model: "opencode-go/a",
        classification: { kind: "other", reason: "r2" },
        skippedCooldown: true,
      },
      {
        model: "commandcode/a",
        classification: { kind: "other", reason: "r3" },
        skippedCapacity: "commandcode",
      },
      spawnedRow("commandcode/b"),
    ];
    const selection = deriveRunModelSelection("llmgateway/a", attempts);

    expect(selection.skipped).toEqual([
      { model: "llmgateway/a", reason: "r1" },
      { model: "opencode-go/a", reason: "r2" },
      { model: "commandcode/a", reason: "r3" },
    ]);
  });

  it("reports no served model when nothing was spawned", () => {
    const selection = deriveRunModelSelection("llmgateway/a", [
      skippedRow("llmgateway/a", "cooling down"),
    ]);

    // A skip-only run must not claim the requested model executed anything.
    expect(selection).not.toHaveProperty("servedModel");
    expect(selection).toHaveProperty("requestedModel", "llmgateway/a");
    expect(selection.skipped).toHaveLength(1);
  });

  it("reports no skips and no served model for an empty attempt trail", () => {
    expect(deriveRunModelSelection("commandcode/b", [])).toEqual({
      requestedModel: "commandcode/b",
      skipped: [],
    });
  });
});

describe("mergeRunModelSelections", () => {
  const selection = (
    servedModel: string | undefined,
    skipped: { model: string; reason: string }[],
  ) => ({
    ...(servedModel === undefined ? {} : { servedModel }),
    requestedModel: "llmgateway/a",
    skipped,
  });

  it("lets the last spawned model win and accumulates skipped rows", () => {
    const merged = mergeRunModelSelections(
      selection("opencode-go/b", [{ model: "llmgateway/a", reason: "cooling down" }]),
      selection("commandcode/c", [{ model: "opencode-go/b", reason: "cooling down" }]),
    );

    expect(merged).toHaveProperty("servedModel", "commandcode/c");
    expect(merged.skipped).toEqual([
      { model: "llmgateway/a", reason: "cooling down" },
      { model: "opencode-go/b", reason: "cooling down" },
    ]);
  });

  it("keeps the earlier served model when the later dispatch spawned nothing", () => {
    const merged = mergeRunModelSelections(
      selection("opencode-go/b", []),
      selection(undefined, [{ model: "commandcode/c", reason: "cooling down" }]),
    );

    expect(merged).toHaveProperty("servedModel", "opencode-go/b");
    expect(merged.skipped).toHaveLength(1);
  });

  it("does not repeat an identical skip row across dispatches", () => {
    const skipped = [{ model: "llmgateway/a", reason: "cooling down" }];
    const merged = mergeRunModelSelections(
      selection("opencode-go/b", skipped),
      selection("opencode-go/b", skipped),
    );

    expect(merged.skipped).toEqual(skipped);
  });

  it("stays bounded across ten gate retries that skip the same provider", () => {
    // Every gate retry re-skips the same cooling providers, and the phase run
    // folds each retry into the manifest: without de-duplication a ten-retry run
    // would persist ten identical rows.
    const skipped = [{ model: "llmgateway/a", reason: "cooling down" }];
    let merged = selection("opencode-go/b", skipped);
    for (let retry = 0; retry < 10; retry += 1) {
      merged = mergeRunModelSelections(merged, selection("opencode-go/b", skipped));
    }

    expect(merged.skipped).toEqual(skipped);
    expect(merged).toHaveProperty("servedModel", "opencode-go/b");
  });
});
