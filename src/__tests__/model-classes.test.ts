import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../agent-registry.js";
import {
  bareModelId,
  candidatesForModel,
  MODEL_CLASS_SPECS,
  MODEL_TO_CLASS,
  modelClassOf,
  PROVIDER_PREFERENCE,
  resolveModelCandidates,
} from "../model-classes.js";
import { WORKFLOW_REGISTRY } from "../workflow-registry.js";

describe("bareModelId", () => {
  it("strips the provider prefix", () => {
    expect(bareModelId("opencode-go/mimo-v2.5")).toBe("mimo-v2.5");
    expect(bareModelId("llmgateway/deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });

  it("leaves provider-less ids untouched", () => {
    expect(bareModelId("mimo-v2.5")).toBe("mimo-v2.5");
  });
});

describe("modelClassOf", () => {
  it("resolves a class from a provider-qualified model", () => {
    expect(modelClassOf("opencode-go/mimo-v2.5")).toBe("fast");
    expect(modelClassOf("llmgateway/deepseek-v4-pro")).toBe("frontier");
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
    expect(candidates[0]).toBe("opencode-go/deepseek-v4-pro");
    expect(candidates[1]).toBe("llmgateway/deepseek-v4-pro");
  });
});

describe("candidatesForModel", () => {
  it("puts the requested model first, then class alternates", () => {
    const candidates = candidatesForModel("opencode-go/deepseek-v4-pro");
    expect(candidates[0]).toBe("opencode-go/deepseek-v4-pro");
    expect(candidates[1]).toBe("llmgateway/deepseek-v4-pro");
  });

  it("does not duplicate the requested model", () => {
    const candidates = candidatesForModel("opencode-go/mimo-v2.5");
    expect(candidates.filter((c) => c === "opencode-go/mimo-v2.5")).toHaveLength(1);
  });

  it("yields a single candidate for unknown models", () => {
    expect(candidatesForModel("unknown/x")).toEqual(["unknown/x"]);
  });
});

describe("model class coverage", () => {
  it("every DEFAULT_AGENTS model maps to a known class", () => {
    for (const agent of DEFAULT_AGENTS) {
      expect(modelClassOf(agent.model), agent.model).toBeDefined();
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
