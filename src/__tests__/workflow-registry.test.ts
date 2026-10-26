import { describe, expect, it } from "vitest";
import { providerOf, providerPreferenceFor } from "../model-classes.js";
import { gateStaticValidation } from "../quality-gates.js";
import {
  getPhasesForType,
  isValidWorkflowType,
  parseWorkflowLabel,
  resolveQualityGate,
  resolveWorkflowSelection,
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

  it("consult phases are not in phases", () => {
    for (const config of Object.values(WORKFLOW_REGISTRY)) {
      for (const consult of config.consultPhases ?? []) {
        expect(config.phases).not.toContain(consult);
      }
    }
  });

  it("no duplicate phase names per type (including consult phases)", () => {
    for (const config of Object.values(WORKFLOW_REGISTRY)) {
      const seen = new Set<string>();
      for (const phase of [...config.phases, ...(config.consultPhases ?? [])]) {
        expect(seen.has(phase)).toBe(false);
        seen.add(phase);
      }
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

  it("feature has 6 phases", () => {
    expect(WORKFLOW_REGISTRY.feature.phases).toEqual([
      "implement",
      "review",
      "test",
      "userguide",
      "proof",
      "commit",
    ]);
    expect(WORKFLOW_REGISTRY.feature.consultPhases).toEqual(["scout", "plan"]);
  });

  it("chore is implement/test/commit with planning consultable (bd-139)", () => {
    expect(WORKFLOW_REGISTRY.chore.phases).toEqual(["implement", "test", "commit"]);
    expect(WORKFLOW_REGISTRY.chore.consultPhases).toEqual(["scout", "plan"]);
    expect(WORKFLOW_REGISTRY.chore.proofRequired).toBe(false);
  });

  it("refactor no longer writes a user guide (bd-139)", () => {
    expect(WORKFLOW_REGISTRY.refactor.phases).toEqual([
      "implement",
      "review",
      "test",
      "proof",
      "commit",
    ]);
    expect(WORKFLOW_REGISTRY.refactor.phases).not.toContain("userguide");
  });

  it("documentation is implement/commit with no proof phase (bd-139)", () => {
    expect(WORKFLOW_REGISTRY.documentation.phases).toEqual(["implement", "commit"]);
    expect(WORKFLOW_REGISTRY.documentation.proofRequired).toBe(false);
  });

  it("runs the test suite once: a test phase means the implement gate is static", () => {
    // bd-139: the suite used to run in the implement gate AND again in the test
    // gate. Every workflow with a test phase must delegate the run to it; a
    // workflow without one keeps the full validation on implement.
    for (const type of Object.keys(WORKFLOW_REGISTRY) as Array<keyof typeof WORKFLOW_REGISTRY>) {
      const config = WORKFLOW_REGISTRY[type];
      if (!config.phases.includes("test")) continue;
      expect(resolveQualityGate("implement", type), `${type} still runs tests twice`).toBe(
        gateStaticValidation,
      );
    }
    expect(resolveQualityGate("implement", "documentation")).toBeUndefined();
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

  it("bugfix phases omit scout/plan and consult them instead", () => {
    expect(WORKFLOW_REGISTRY.bugfix.phases).toEqual([
      "implement",
      "review",
      "test",
      "proof",
      "commit",
    ]);
    expect(WORKFLOW_REGISTRY.bugfix.optionalPhases).toBeUndefined();
    expect(WORKFLOW_REGISTRY.bugfix.consultPhases).toEqual(["scout", "plan"]);
  });

  it("research skips proof and overrides the plan agent to record a bead", () => {
    expect(WORKFLOW_REGISTRY.research.phases).toEqual(["scout", "plan", "commit"]);
    expect(WORKFLOW_REGISTRY.research.proofRequired).toBe(false);
    expect(WORKFLOW_REGISTRY.research.agentOverrides?.plan?.systemPrompt).toBeDefined();
    expect(WORKFLOW_REGISTRY.research.agentOverrides?.plan?.tools).toContain("bd");
    // Research often needs to run and inspect CLI tools, so the research
    // workflow's plan phase keeps bash (unlike planning mode's scout).
    expect(WORKFLOW_REGISTRY.research.agentOverrides?.plan?.tools).toContain("bash");
  });

  it("pins the override models to their preferred provider", () => {
    // bd-147: only deepseek-v4.1-flash prefers opencode-go; every other model
    // bills per-token on llmgateway. A registry pin that keeps the old
    // opencode-go prefix would silently spawn on the subscription bucket for a
    // model that does not belong there, so assert the exact pins AND that each
    // pin agrees with the model's own preference order.
    expect(WORKFLOW_REGISTRY.research.agentOverrides?.plan?.model).toBe("llmgateway/glm-5.3");
    expect(WORKFLOW_REGISTRY.documentation.agentOverrides?.implement?.model).toBe(
      "llmgateway/deepseek-v4-flash",
    );
    expect(WORKFLOW_REGISTRY.hotfix.agentOverrides?.implement?.model).toBe(
      "llmgateway/deepseek-v4-flash",
    );
    for (const config of Object.values(WORKFLOW_REGISTRY)) {
      for (const [phase, override] of Object.entries(config.agentOverrides ?? {})) {
        if (override.model === undefined) continue;
        expect(providerOf(override.model), `${config.name}/${phase}`).toBe(
          providerPreferenceFor(override.model)[0],
        );
      }
    }
  });

  it("every agentOverride systemPrompt still carries the stale-worktree rebase guidance", () => {
    // Regression guard: an override swaps the whole prompt, so a future
    // override that forgets SHARED_AGENT_GUIDANCE would silently drop the
    // rebase instructions. Assert the three acceptance-criteria substrings
    // on every override that sets a systemPrompt.
    for (const config of Object.values(WORKFLOW_REGISTRY)) {
      const overrides = config.agentOverrides;
      if (!overrides) continue;
      for (const [phase, override] of Object.entries(overrides)) {
        if (!override.systemPrompt) continue;
        // Criterion 1: rebase onto the base branch rather than re-implementing.
        expect(override.systemPrompt, `${config.name}/${phase}`).toContain("git rebase main");
        // Criterion 2: a closed/finished bead may just be absent; check the base.
        expect(override.systemPrompt, `${config.name}/${phase}`).toContain(
          "not be present in this branch yet",
        );
        expect(override.systemPrompt, `${config.name}/${phase}`).toContain(
          "check `main` before duplicating work",
        );
        // Criterion 3: resolve mid-rebase conflicts toward the landed base work.
        expect(override.systemPrompt, `${config.name}/${phase}`).toContain(
          "Mid-rebase conflicts are expected",
        );
        expect(override.systemPrompt, `${config.name}/${phase}`).toContain(
          "already-landed `main` implementation",
        );
        // Stacked follow-ups replay with --onto, never a plain parent rebase.
        expect(override.systemPrompt, `${config.name}/${phase}`).toContain(
          "Stacked follow-up worktree",
        );
        expect(override.systemPrompt, `${config.name}/${phase}`).toContain("belayd_stack_rebase");
      }
    }
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

describe("parseWorkflowLabel", () => {
  it("parses the first valid wf: label", () => {
    expect(parseWorkflowLabel(["implementation", "wf:chore"])).toEqual({
      type: "chore",
      label: "wf:chore",
    });
  });

  it("ignores an invalid wf: suffix and keeps scanning", () => {
    expect(parseWorkflowLabel(["wf:nope", "wf:bugfix"])).toEqual({
      type: "bugfix",
      label: "wf:bugfix",
    });
  });

  it("returns undefined when no valid wf: label exists", () => {
    expect(parseWorkflowLabel(["chore", "wf:Nope", "WF:chore"])).toBeUndefined();
    expect(parseWorkflowLabel([])).toBeUndefined();
    expect(parseWorkflowLabel()).toBeUndefined();
  });
});

describe("resolveWorkflowSelection", () => {
  it("uses a valid arg with no confirmation", () => {
    expect(resolveWorkflowSelection("bugfix")).toEqual({
      type: "bugfix",
      source: "arg",
      requiresConfirmation: false,
    });
  });

  it("uses a wf: label and requires confirmation", () => {
    expect(resolveWorkflowSelection(undefined, ["wf:chore"])).toEqual({
      type: "chore",
      source: "label",
      matchedLabel: "wf:chore",
      requiresConfirmation: true,
    });
  });

  it("arg beats a wf: label and skips confirmation", () => {
    const resolution = resolveWorkflowSelection("hotfix", ["wf:chore"]);
    expect(resolution).toEqual({ type: "hotfix", source: "arg", requiresConfirmation: false });
  });

  it("ignores an invalid wf: label", () => {
    expect(resolveWorkflowSelection(undefined, ["wf:nope"])).toEqual({
      type: "feature",
      source: "default",
      requiresConfirmation: false,
    });
  });

  it("ignores plain workflow-name and legacy labels", () => {
    for (const label of ["chore", "bug", "investigation", "bugfix", "feature"]) {
      expect(resolveWorkflowSelection(undefined, [label]).type).toBe("feature");
    }
  });

  it("does not infer a type from a bd-17-style title", () => {
    // Title is deliberately not an input anymore: this string previously
    // matched the chore pattern on the word "CI".
    expect(resolveWorkflowSelection(undefined, []).type).toBe("feature");
  });

  it("returns feature by default", () => {
    expect(resolveWorkflowSelection()).toEqual({
      type: "feature",
      source: "default",
      requiresConfirmation: false,
    });
    expect(resolveWorkflowSelection("invalid", ["unknown"]).type).toBe("feature");
    expect(resolveWorkflowSelection("").type).toBe("feature");
  });
});

describe("resolveWorkflowType", () => {
  it("is a thin wrapper returning the resolved type", () => {
    expect(resolveWorkflowType("bugfix")).toBe("bugfix");
    expect(resolveWorkflowType(undefined, ["wf:chore"])).toBe("chore");
    expect(resolveWorkflowType(undefined, ["chore"])).toBe("feature");
    expect(resolveWorkflowType()).toBe("feature");
  });
});

describe("getPhasesForType", () => {
  it("returns feature phases for undefined type", () => {
    expect(getPhasesForType()).toEqual(WORKFLOW_REGISTRY.feature.phases);
  });

  it("returns correct phases for feature", () => {
    expect(getPhasesForType("feature")).toEqual([
      "implement",
      "review",
      "test",
      "userguide",
      "proof",
      "commit",
    ]);
  });

  it("returns correct phases for chore", () => {
    expect(getPhasesForType("chore")).toEqual(["implement", "test", "commit"]);
  });

  it("returns correct phases for hotfix", () => {
    expect(getPhasesForType("hotfix")).toEqual(["implement", "review", "test", "proof", "commit"]);
  });

  it("returns correct phases for documentation", () => {
    expect(getPhasesForType("documentation")).toEqual(["implement", "commit"]);
  });

  it("returns correct phases for bugfix", () => {
    expect(getPhasesForType("bugfix")).toEqual(["implement", "review", "test", "proof", "commit"]);
  });

  it("returns correct phases for refactor", () => {
    expect(getPhasesForType("refactor")).toEqual([
      "implement",
      "review",
      "test",
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
    // hotfix overrides the implement gate (bd-139) and still carries a model
    // override, so the gate must come from gateOverrides, not the agent default.
    expect(resolveQualityGate("implement", "hotfix")).toBe(gateStaticValidation);
  });
});
