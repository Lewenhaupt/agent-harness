import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildLlmGatewayModelsDoc,
  diffModelsDoc,
  type GatewayModelEntry,
  isLlmGatewayApiResponse,
  type LlmGatewayModel,
  type ModelsJsonDoc,
  mapLlmGatewayModels,
  parseLlmGatewayApiKeyFromAuthJson,
  serializeModelsJsonDoc,
} from "../llmgateway-models.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function apiModel(overrides: Partial<LlmGatewayModel> = {}): LlmGatewayModel {
  return {
    id: "test-model",
    name: "Test Model",
    family: "openai",
    context_length: 128000,
    pricing: {
      prompt: "0.15e-6",
      completion: "0.6e-6",
      input_cache_read: "0.075e-6",
      input_cache_write: 0,
    },
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
    supported_parameters: [],
    providers: [],
    ...overrides,
  };
}

describe("mapLlmGatewayModels", () => {
  it("maps a text-only chat model", () => {
    const models = mapLlmGatewayModels({ data: [apiModel()] });
    expect(models).toHaveLength(1);
    const model = models[0];
    expect(model).toHaveProperty("id", "test-model");
    expect(model).toHaveProperty("name", "Test Model");
    expect(model).toHaveProperty("reasoning", false);
    expect(model).toHaveProperty("input", ["text"]);
    expect(model).toHaveProperty("contextWindow", 128000);
    expect(model).toHaveProperty("maxTokens", 16384);
    expect(model).toHaveProperty("cost");
    expect(model).not.toHaveProperty("thinkingLevelMap");
  });

  it("adds image to input when architecture.input_modalities includes image", () => {
    const models = mapLlmGatewayModels({
      data: [
        apiModel({
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        }),
      ],
    });
    expect(models[0]).toHaveProperty("input", ["text", "image"]);
  });

  it("marks reasoning via supported_parameters containing reasoning", () => {
    const models = mapLlmGatewayModels({
      data: [apiModel({ supported_parameters: ["temperature", "reasoning"] })],
    });
    expect(models[0]).toHaveProperty("reasoning", true);
    expect(models[0]).toHaveProperty("thinkingLevelMap", {
      minimal: null,
      low: null,
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
  });

  it("marks reasoning via supported_parameters containing reasoning_effort", () => {
    const models = mapLlmGatewayModels({
      data: [apiModel({ supported_parameters: ["reasoning_effort"] })],
    });
    expect(models[0]).toHaveProperty("reasoning", true);
    expect(models[0]).toHaveProperty("thinkingLevelMap");
  });

  it("marks reasoning via providers[].reasoning === true", () => {
    const models = mapLlmGatewayModels({
      data: [apiModel({ providers: [{ reasoning: true }, { reasoning: false }] })],
    });
    expect(models[0]).toHaveProperty("reasoning", true);
    expect(models[0]).toHaveProperty("thinkingLevelMap");
  });

  it("does not mark reasoning when only providers[].reasoning is false", () => {
    const models = mapLlmGatewayModels({
      data: [apiModel({ providers: [{ reasoning: false }] })],
    });
    expect(models[0]).toHaveProperty("reasoning", false);
    expect(models[0]).not.toHaveProperty("thinkingLevelMap");
  });

  it("does not include thinkingLevelMap on non-reasoning models", () => {
    const models = mapLlmGatewayModels({ data: [apiModel()] });
    expect(models[0]).not.toHaveProperty("thinkingLevelMap");
  });

  it("drops models with id custom", () => {
    const models = mapLlmGatewayModels({ data: [apiModel({ id: "custom" })] });
    expect(models).toHaveLength(0);
  });

  it("drops deactivated models", () => {
    const models = mapLlmGatewayModels({ data: [apiModel({ deactivated_at: "2024-01-01" })] });
    expect(models).toHaveLength(0);
  });

  it("drops models whose output_modalities lacks text", () => {
    const models = mapLlmGatewayModels({
      data: [
        apiModel({
          architecture: { input_modalities: ["text"], output_modalities: ["audio"] },
        }),
      ],
    });
    expect(models).toHaveLength(0);
  });

  it("drops models with missing/null output_modalities", () => {
    const models = mapLlmGatewayModels({
      data: [
        apiModel({ architecture: { input_modalities: ["text"], output_modalities: null } }),
        apiModel({ architecture: { input_modalities: ["text"], output_modalities: undefined } }),
      ],
    });
    expect(models).toHaveLength(0);
  });

  it("maps per-million costs from pricing", () => {
    const models = mapLlmGatewayModels({
      data: [
        apiModel({
          pricing: {
            prompt: "0.15e-6",
            completion: "0.6e-6",
            input_cache_read: "0.075e-6",
            input_cache_write: "1e-6",
          },
        }),
      ],
    });
    expect(models[0]).toHaveProperty("cost", {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.075,
      cacheWrite: 1,
    });
  });

  it("maps numeric pricing values directly", () => {
    const models = mapLlmGatewayModels({
      data: [apiModel({ pricing: { prompt: 0.25, completion: 1.25 } })],
    });
    expect(models[0]).toHaveProperty("cost.input", 250000);
    expect(models[0]).toHaveProperty("cost.output", 1250000);
  });

  it("maps null/missing/zero/non-numeric pricing to 0", () => {
    const models = mapLlmGatewayModels({
      data: [
        apiModel({ pricing: { prompt: null, completion: 0, input_cache_read: "nope" } }),
        apiModel({ pricing: null }),
        apiModel({ pricing: {} }),
      ],
    });
    for (const model of models) {
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("uses context_length when present", () => {
    const models = mapLlmGatewayModels({ data: [apiModel({ context_length: 64000 })] });
    expect(models[0]).toHaveProperty("contextWindow", 64000);
  });

  it("defaults contextWindow to 131072 when missing or zero", () => {
    const models = mapLlmGatewayModels({
      data: [apiModel({ context_length: undefined }), apiModel({ context_length: 0 })],
    });
    expect(models[0]).toHaveProperty("contextWindow", 131072);
    expect(models[1]).toHaveProperty("contextWindow", 131072);
  });

  it("maps maxTokens from the family map", () => {
    const cases = [
      ["openai", 16384],
      ["anthropic", 32000],
      ["google", 32768],
      ["xai", 32768],
      ["deepseek", 32768],
      ["meta", 8192],
      ["minimax", 40960],
      ["unknown-family", 16384],
    ] as const;
    for (const [family, expected] of cases) {
      const models = mapLlmGatewayModels({ data: [apiModel({ family })] });
      expect(models[0]).toHaveProperty("maxTokens", expected);
    }
  });

  it("defaults maxTokens to 16384 when family is missing", () => {
    const models = mapLlmGatewayModels({ data: [apiModel({ family: undefined })] });
    expect(models[0]).toHaveProperty("maxTokens", 16384);
  });

  it("falls back to id when name is missing or empty", () => {
    const models = mapLlmGatewayModels({
      data: [apiModel({ name: undefined }), apiModel({ name: "" })],
    });
    expect(models[0]).toHaveProperty("name", "test-model");
    expect(models[1]).toHaveProperty("name", "test-model");
  });
});

describe("isLlmGatewayApiResponse", () => {
  it("accepts a payload with a data array", () => {
    expect(isLlmGatewayApiResponse({ data: [] })).toBe(true);
  });

  it("accepts a payload with a missing data key", () => {
    expect(isLlmGatewayApiResponse({})).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isLlmGatewayApiResponse(null)).toBe(false);
    expect(isLlmGatewayApiResponse("x")).toBe(false);
    expect(isLlmGatewayApiResponse(42)).toBe(false);
  });

  it("rejects arrays", () => {
    expect(isLlmGatewayApiResponse([])).toBe(false);
  });

  it("rejects a non-array data value", () => {
    expect(isLlmGatewayApiResponse({ data: "not-an-array" })).toBe(false);
  });
});

describe("buildLlmGatewayModelsDoc", () => {
  it("builds the llmgateway envelope", () => {
    const entry: GatewayModelEntry = {
      id: "m1",
      name: "M1",
      reasoning: false,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      contextWindow: 128000,
      maxTokens: 16384,
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    };
    const doc = buildLlmGatewayModelsDoc([entry]);
    expect(doc).toHaveProperty("providers.llmgateway.baseUrl", "https://api.llmgateway.io/v1");
    expect(doc).toHaveProperty("providers.llmgateway.api", "openai-completions");
    expect(doc).toHaveProperty("providers.llmgateway.models");
    expect(doc.providers.llmgateway.models).toHaveLength(1);
  });
});

describe("serializeModelsJsonDoc", () => {
  it("produces 2-space-indented JSON with a trailing newline", () => {
    const doc = buildLlmGatewayModelsDoc([
      {
        id: "m1",
        name: "M1",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        contextWindow: 128000,
        maxTokens: 16384,
        compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      },
    ]);
    const serialized = serializeModelsJsonDoc(doc);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).toContain('\n  "providers"');
    expect(JSON.parse(serialized)).toEqual(doc);
  });
});

describe("diffModelsDoc", () => {
  function docWithIds(ids: string[]): ModelsJsonDoc {
    return buildLlmGatewayModelsDoc(
      ids.map(
        (id): GatewayModelEntry => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 16384,
          compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
        }),
      ),
    );
  }

  it("reports added-only changes", () => {
    expect(diffModelsDoc(docWithIds(["a"]), docWithIds(["a", "b"]))).toBe("added 1, removed 0");
  });

  it("reports removed-only changes", () => {
    expect(diffModelsDoc(docWithIds(["a", "b"]), docWithIds(["a"]))).toBe("added 0, removed 1");
  });

  it("reports both additions and removals", () => {
    expect(diffModelsDoc(docWithIds(["a", "b"]), docWithIds(["b", "c"]))).toBe(
      "added 1, removed 1",
    );
  });

  it("reports no change", () => {
    expect(diffModelsDoc(docWithIds(["a", "b"]), docWithIds(["a", "b"]))).toBe("no change");
  });

  it("handles undefined before", () => {
    expect(diffModelsDoc(undefined, docWithIds(["a", "b"]))).toBe("added 2, removed 0");
  });
});

describe("parseLlmGatewayApiKeyFromAuthJson", () => {
  it("returns the key for a valid api_key entry", () => {
    expect(
      parseLlmGatewayApiKeyFromAuthJson(
        JSON.stringify({ llmgateway: { type: "api_key", key: "sk-abc" } }),
      ),
    ).toBe("sk-abc");
  });

  it("returns undefined for non-api_key types", () => {
    expect(
      parseLlmGatewayApiKeyFromAuthJson(
        JSON.stringify({ llmgateway: { type: "oauth", key: "sk-abc" } }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when llmgateway is missing", () => {
    expect(parseLlmGatewayApiKeyFromAuthJson(JSON.stringify({ other: {} }))).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseLlmGatewayApiKeyFromAuthJson("{not json")).toBeUndefined();
  });

  it("returns undefined for a missing key field", () => {
    expect(
      parseLlmGatewayApiKeyFromAuthJson(JSON.stringify({ llmgateway: { type: "api_key" } })),
    ).toBeUndefined();
  });
});

describe("golden sanity against repo models.json", () => {
  it("re-serializes the committed models.json losslessly", () => {
    const path = resolve(TEST_DIR, "..", "..", "models.json");
    const original = JSON.parse(readFileSync(path, "utf8")) as ModelsJsonDoc;
    const serialized = serializeModelsJsonDoc(original);
    expect(JSON.parse(serialized)).toEqual(original);
  });
});
