import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../agent-registry.js";
import {
  bareModelId,
  candidatesForModel,
  MODEL_CLASS_SPECS,
  MODEL_TO_CLASS,
  modelClassOf,
  PROVIDER_PREFERENCE,
  primaryModelOf,
  providerOf,
  resolveModelCandidates,
  resolveModelSpec,
} from "../model-classes.js";
import { WORKFLOW_REGISTRY } from "../workflow-registry.js";

describe("bareModelId", () => {
  it("strips the provider prefix", () => {
    expect(bareModelId("opencode-go/mimo-v2.5")).toBe("mimo-v2.5");
    expect(bareModelId("llmgateway/deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash");
  });

  it("leaves provider-less ids untouched", () => {
    expect(bareModelId("mimo-v2.5")).toBe("mimo-v2.5");
  });
});

describe("providerOf", () => {
  it("returns the provider prefix", () => {
    expect(providerOf("opencode-go/mimo-v2.5")).toBe("opencode-go");
    expect(providerOf("llmgateway/deepseek-v4.1-flash")).toBe("llmgateway");
  });

  it("returns an empty string for provider-less ids", () => {
    expect(providerOf("mimo-v2.5")).toBe("");
  });
});

describe("modelClassOf", () => {
  it("resolves a class from a provider-qualified model", () => {
    expect(modelClassOf("opencode-go/mimo-v2.5")).toBe("fast");
    expect(modelClassOf("llmgateway/deepseek-v4.1-flash")).toBe("frontier");
    expect(modelClassOf("opencode-go/glm-5.2")).toBe("standard");
  });

  it("resolves a class from a bare id", () => {
    expect(modelClassOf("mimo-v2.5")).toBe("fast");
    expect(modelClassOf("glm-5.3")).toBe("frontier");
  });

  it("returns undefined for unknown models", () => {
    expect(modelClassOf("unknown/x")).toBeUndefined();
  });
});

describe("resolveModelCandidates", () => {
  it("expands each bare id across the provider preference order", () => {
    expect(resolveModelCandidates("fast")).toEqual([
      "opencode-go/mimo-v2.5",
      "llmgateway/mimo-v2.5",
      "opencode-go/deepseek-v4-flash",
      "llmgateway/deepseek-v4-flash",
      "opencode-go/glm-5.2",
      "llmgateway/glm-5.2",
    ]);
  });

  it("keeps the same model id adjacent across providers", () => {
    const candidates = resolveModelCandidates("frontier");
    expect(candidates[0]).toBe("opencode-go/deepseek-v4.1-flash");
    expect(candidates[1]).toBe("llmgateway/deepseek-v4.1-flash");
  });
});

describe("candidatesForModel", () => {
  it("puts the requested model first, then class alternates", () => {
    const candidates = candidatesForModel("opencode-go/deepseek-v4.1-flash");
    expect(candidates[0]).toBe("opencode-go/deepseek-v4.1-flash");
    expect(candidates[1]).toBe("llmgateway/deepseek-v4.1-flash");
  });

  it("tries the same model on an alternate provider before other models on the same provider", () => {
    // glm-5.3 is the 2nd frontier model; without the re-partition its first
    // fallback would be opencode-go/deepseek-v4.1-flash (same provider, wrong
    // quota bucket).
    const candidates = candidatesForModel("opencode-go/glm-5.3");
    expect(candidates[0]).toBe("opencode-go/glm-5.3");
    expect(candidates[1]).toBe("llmgateway/glm-5.3");
  });

  it("does not duplicate the requested model", () => {
    const candidates = candidatesForModel("opencode-go/mimo-v2.5");
    expect(candidates.filter((c) => c === "opencode-go/mimo-v2.5")).toHaveLength(1);
  });

  it("yields a single candidate for unknown models", () => {
    expect(candidatesForModel("unknown/x")).toEqual(["unknown/x"]);
  });

  it("uses an explicit class to expand candidates even when the model is known", () => {
    const candidates = candidatesForModel("opencode-go/deepseek-v4.1-flash", "fast");
    expect(candidates[0]).toBe("opencode-go/deepseek-v4.1-flash");
    expect(candidates[1]).toBe("opencode-go/mimo-v2.5");
    expect(candidates).toHaveLength(1 + resolveModelCandidates("fast").length);
  });

  it("expands an unknown model when an explicit class is provided", () => {
    const candidates = candidatesForModel("unknown/x", "fast");
    expect(candidates[0]).toBe("unknown/x");
    expect(candidates[1]).toBe("opencode-go/mimo-v2.5");
  });

  it("treats an omitted class identically to an explicit undefined", () => {
    expect(candidatesForModel("opencode-go/glm-5.3")).toEqual(
      candidatesForModel("opencode-go/glm-5.3", undefined),
    );
  });

  it("does not duplicate the requested model when it belongs to the explicit class", () => {
    const candidates = candidatesForModel("opencode-go/mimo-v2.5", "fast");
    expect(candidates.filter((c) => c === "opencode-go/mimo-v2.5")).toHaveLength(1);
  });

  it("resolves a bare known id through its class (class-of-one entry first)", () => {
    // The empty sameModelAlternateProvider partition for bare ids: the bare
    // id leads, then every provider-qualified same-id candidate, then the rest.
    expect(candidatesForModel("glm-5.3")).toEqual([
      "glm-5.3",
      "opencode-go/glm-5.3",
      "llmgateway/glm-5.3",
      "opencode-go/deepseek-v4.1-flash",
      "llmgateway/deepseek-v4.1-flash",
      "opencode-go/gpt-5.6-luna",
      "llmgateway/gpt-5.6-luna",
    ]);
  });

  it("returns a bare unknown id as a single candidate", () => {
    expect(candidatesForModel("mystery-model")).toEqual(["mystery-model"]);
  });

  it("expands a bare id when an explicit class is provided", () => {
    expect(candidatesForModel("glm-5.2", "fast")).toEqual([
      "glm-5.2",
      "opencode-go/glm-5.2",
      "llmgateway/glm-5.2",
      "opencode-go/mimo-v2.5",
      "llmgateway/mimo-v2.5",
      "opencode-go/deepseek-v4-flash",
      "llmgateway/deepseek-v4-flash",
    ]);
  });
});

describe("model class coverage", () => {
  it("every DEFAULT_AGENTS entry is modelClass-only and resolves to its class primary", () => {
    for (const agent of DEFAULT_AGENTS) {
      expect("model" in agent, agent.name).toBe(false);
      const modelClass = agent.modelClass;
      if (modelClass === undefined) continue;
      expect(resolveModelSpec(agent)).toEqual({ model: primaryModelOf(modelClass), modelClass });
    }
  });

  it("every workflow override model maps to a known class", () => {
    for (const config of Object.values(WORKFLOW_REGISTRY)) {
      for (const override of Object.values(config.agentOverrides ?? {})) {
        if (override.model) {
          expect(modelClassOf(override.model), override.model).toBeDefined();
        }
      }
    }
  });

  it("every class spec references known models", () => {
    for (const spec of Object.values(MODEL_CLASS_SPECS)) {
      for (const id of spec.models) {
        expect(MODEL_TO_CLASS[id], id).toBeDefined();
      }
    }
    expect(PROVIDER_PREFERENCE).toContain("opencode-go");
    expect(PROVIDER_PREFERENCE).toContain("llmgateway");
  });
});

describe("primaryModelOf", () => {
  it("resolves each class to its first-preference-provider primary", () => {
    expect(primaryModelOf("frontier")).toBe("opencode-go/deepseek-v4.1-flash");
    expect(primaryModelOf("standard")).toBe("opencode-go/glm-5.2");
    expect(primaryModelOf("fast")).toBe("opencode-go/mimo-v2.5");
  });
});

describe("resolveModelSpec", () => {
  it("resolves a modelClass-only spec to the class primary", () => {
    expect(resolveModelSpec({ modelClass: "standard" })).toEqual({
      model: "opencode-go/glm-5.2",
      modelClass: "standard",
    });
  });

  it("derives the class for a known explicit model", () => {
    expect(resolveModelSpec({ model: "opencode-go/mimo-v2.5" })).toEqual({
      model: "opencode-go/mimo-v2.5",
      modelClass: "fast",
    });
  });

  it("yields no class for an unknown explicit model", () => {
    expect(resolveModelSpec({ model: "vendor/x" })).toEqual({
      model: "vendor/x",
      modelClass: undefined,
    });
  });
});
