import { describe, expect, it } from "vitest";
import {
  getPhasesForType,
  isValidWorkflowType,
  resolveQualityGate,
  resolveWorkflowType,
  WORKFLOW_REGISTRY,
  WORKFLOW_SUB_TYPES,
} from "../workflow-registry.js";

describe("WORKFLOW_REGISTRY", () => {
  it("has all 7 workflow types", () => {
    expect(Object.keys(WORKFLOW_REGISTRY)).toHaveLength(7);
  });

  it("contains all expected types", () => {
    const types = ["feature", "bugfix", "research", "chore", "documentation", "refactor", "hotfix"];
    for (const type of types) {
      expect(WORKFLOW_REGISTRY).toHaveProperty(type);
    }
  });

  it("each type has name, phases, proofRequired", () => {
    for (const config of Object.values(WORKFLOW_REGISTRY)) {
      expect(config).toHaveProperty("name");
      expect(config).toHaveProperty("phases");
      expect(config).toHaveProperty("proofRequired");
    }
  });

  it.each(Object.keys(WORKFLOW_REGISTRY))("type '%s' has non-empty phases", (type) => {
    const config = WORKFLOW_REGISTRY[type as keyof typeof WORKFLOW_REGISTRY];
    expect(config.phases.length).toBeGreaterThan(0);
  });

  it("no duplicate phase names per type", () => {
    for (const config of Object.values(WORKFLOW_REGISTRY)) {
      const seen = new Set<string>();
      for (const phase of config.phases) {
        expect(seen.has(phase)).toBe(false);
        seen.add(phase);
      }
    }
  });

  it("feature has all 8 phases", () => {
    expect(WORKFLOW_REGISTRY.feature.phases).toEqual([
      "scout",
      "plan",
      "implement",
      "review",
      "test",
      "userguide",
      "proof",
      "commit",
    ]);
  });

  it("chore has 4 phases with no proof", () => {
    expect(WORKFLOW_REGISTRY.chore.phases).toEqual(["plan", "implement", "test", "commit"]);
    expect(WORKFLOW_REGISTRY.chore.proofRequired).toBe(false);
  });

  it("hotfix skips scout and plan", () => {
    expect(WORKFLOW_REGISTRY.hotfix.phases).toEqual([
      "implement",
      "review",
      "test",
      "proof",
      "commit",
    ]);
    expect(WORKFLOW_REGISTRY.hotfix.proofRequired).toBe(true);
  });

  it("bugfix has optionalPhases including scout", () => {
    expect(WORKFLOW_REGISTRY.bugfix.optionalPhases).toContain("scout");
  });
});

describe("WORKFLOW_SUB_TYPES", () => {
  it("has 7 entries", () => {
    expect(WORKFLOW_SUB_TYPES).toHaveLength(7);
  });

  it("matches registry keys", () => {
    const keys = Object.keys(WORKFLOW_REGISTRY);
    expect(WORKFLOW_SUB_TYPES.sort()).toEqual(keys.sort());
  });
});

describe("isValidWorkflowType", () => {
  it("returns true for valid types", () => {
    const validTypes = [
      "feature",
      "bugfix",
      "research",
      "chore",
      "documentation",
      "refactor",
      "hotfix",
    ];
    for (const type of validTypes) {
      expect(isValidWorkflowType(type)).toBe(true);
    }
  });

  it("returns false for empty string", () => {
    expect(isValidWorkflowType("")).toBe(false);
  });

  it("returns false for an invalid type", () => {
    expect(isValidWorkflowType("invalid")).toBe(false);
    expect(isValidWorkflowType("unknown")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(isValidWorkflowType("Feature")).toBe(false);
    expect(isValidWorkflowType("BUGFIX")).toBe(false);
  });
});

describe("resolveWorkflowType", () => {
  it("returns the typeArg when valid", () => {
    expect(resolveWorkflowType("bugfix")).toBe("bugfix");
    expect(resolveWorkflowType("chore")).toBe("chore");
  });

  it("falls back to labels when typeArg is undefined", () => {
    expect(resolveWorkflowType(undefined, ["chore"])).toBe("chore");
  });

  it("picks the first matching label", () => {
    expect(resolveWorkflowType(undefined, ["bugfix", "chore"])).toBe("bugfix");
  });

  it("returns feature when typeArg is invalid and no labels match", () => {
    expect(resolveWorkflowType("invalid", ["unknown"])).toBe("feature");
  });

  it("returns feature when no typeArg and no labels", () => {
    expect(resolveWorkflowType()).toBe("feature");
    expect(resolveWorkflowType(undefined)).toBe("feature");
    expect(resolveWorkflowType(undefined, [])).toBe("feature");
  });

  it("ignores empty string typeArg", () => {
    expect(resolveWorkflowType("")).toBe("feature");
  });

  it("typeArg takes priority over labels", () => {
    expect(resolveWorkflowType("hotfix", ["feature"])).toBe("hotfix");
  });

  it("maps label 'bug' to bugfix", () => {
    expect(resolveWorkflowType(undefined, ["bug"])).toBe("bugfix");
  });

  it("maps label 'investigation' to research", () => {
    expect(resolveWorkflowType(undefined, ["investigation"])).toBe("research");
  });

  it("exact workflow type label still works", () => {
    expect(resolveWorkflowType(undefined, ["chore", "bug"])).toBe("chore");
  });

  it("resolves from title keywords", () => {
    expect(resolveWorkflowType(undefined, undefined, "Fix login bug")).toBe("bugfix");
    expect(resolveWorkflowType(undefined, undefined, "Refactor auth module")).toBe("refactor");
    expect(resolveWorkflowType(undefined, undefined, "Research new DB options")).toBe("research");
    expect(resolveWorkflowType(undefined, undefined, "Investigate performance issue")).toBe(
      "research",
    );
    expect(resolveWorkflowType(undefined, undefined, "Setup CI pipeline")).toBe("chore");
    expect(resolveWorkflowType(undefined, undefined, "Update README")).toBe("documentation");
    expect(resolveWorkflowType(undefined, undefined, "URGENT: fix production bug")).toBe("hotfix");
  });

  it("label mapping beats title keywords", () => {
    // Label "bug" maps to bugfix — checked before title keywords
    expect(resolveWorkflowType(undefined, ["bug"], "Refactor auth module")).toBe("bugfix");
  });

  it("falls back to feature for unrecognized title", () => {
    expect(resolveWorkflowType(undefined, undefined, "Add user authentication")).toBe("feature");
  });

  it("typeArg takes priority over title", () => {
    expect(resolveWorkflowType("hotfix", undefined, "Implement new feature")).toBe("hotfix");
  });
});

describe("getPhasesForType", () => {
  it("returns feature phases for undefined type", () => {
    expect(getPhasesForType()).toEqual(WORKFLOW_REGISTRY.feature.phases);
  });

  it("returns correct phases for feature", () => {
    expect(getPhasesForType("feature")).toEqual([
      "scout",
      "plan",
      "implement",
      "review",
      "test",
      "userguide",
      "proof",
      "commit",
    ]);
  });

  it("returns correct phases for chore", () => {
    expect(getPhasesForType("chore")).toEqual(["plan", "implement", "test", "commit"]);
  });

  it("returns correct phases for hotfix", () => {
    expect(getPhasesForType("hotfix")).toEqual(["implement", "review", "test", "proof", "commit"]);
  });

  it("returns correct phases for documentation", () => {
    expect(getPhasesForType("documentation")).toEqual([
      "scout",
      "plan",
      "implement",
      "proof",
      "commit",
    ]);
  });

  it("returns feature phases for unknown type", () => {
    // This doesn't compile with a string param, but the function should handle it
    // We test via as any since it's a runtime concern
    const result = getPhasesForType("invalid" as never);
    expect(result).toEqual(WORKFLOW_REGISTRY.feature.phases);
  });

  it("returns a copy, not the original array", () => {
    const phasesForBugfix = getPhasesForType("bugfix");
    const phasesForFeature = getPhasesForType("feature");
    // Mutating bugfix should not affect feature
    const origLength = phasesForBugfix.length;
    phasesForBugfix.length = 0;
    const afterMutation = getPhasesForType("bugfix");
    expect(afterMutation).toHaveLength(origLength);
    expect(phasesForFeature).toHaveLength(WORKFLOW_REGISTRY.feature.phases.length);
  });
});

describe("resolveQualityGate", () => {
  it("returns the agent gate as default when no overrides exist", () => {
    const mockGate = async () => ({ passed: true });
    const result = resolveQualityGate("plan", "feature", mockGate);
    expect(result).toBe(mockGate);
  });

  it("returns undefined when no gate and no overrides", () => {
    const result = resolveQualityGate("plan", "feature");
    expect(result).toBeUndefined();
  });

  it("resolves agentOverrides qualityGate from chore implement", () => {
    const result = resolveQualityGate("implement", "chore");
    expect(result).toBeDefined();
    // Chore implement agentOverrides defines a qualityGate (gateFullValidation)
    // We can't import it directly, but we can check it's defined
  });

  it("gives gateOverrides priority over agentOverrides", () => {
    const gateOverride = async () => ({ passed: false, feedback: "gate override" });
    const agentGate = async () => ({ passed: true });

    // No workflow type ships gateOverrides in the registry, so inject one
    // temporarily (and restore it) to verify the priority ordering holds.
    const previous = WORKFLOW_REGISTRY.hotfix.gateOverrides;
    WORKFLOW_REGISTRY.hotfix.gateOverrides = { implement: gateOverride };
    try {
      const result = resolveQualityGate("implement", "hotfix", agentGate);
      expect(result).toBe(gateOverride);
    } finally {
      WORKFLOW_REGISTRY.hotfix.gateOverrides = previous;
    }
  });

  it("returns undefined for a phase with no gate anywhere", () => {
    // scout in feature has no overrides and no agent gate
    const result = resolveQualityGate("scout", "feature");
    expect(result).toBeUndefined();
  });

  it("resolves gate for a phase with gateOverrides", () => {
    // Use hotfix which has agentOverrides for implement but not gateOverrides
    // hotfix implement has model override but no qualityGate in agentOverrides
    // result should be undefined since there's no gate
    const result = resolveQualityGate("implement", "hotfix");
    expect(result).toBeUndefined();
  });
});
