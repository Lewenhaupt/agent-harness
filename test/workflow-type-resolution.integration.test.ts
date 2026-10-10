import { describe, expect, it } from "vitest";
import {
  getPhasesForType,
  isValidWorkflowType,
  resolveWorkflowSelection,
  WORKFLOW_REGISTRY,
} from "../src/workflow-registry.js";

describe("workflow type resolution (integration)", () => {
  describe("resolveWorkflowSelection", () => {
    it("explicit arg resolves to bugfix with correct phases", () => {
      const resolution = resolveWorkflowSelection("bugfix");
      expect(resolution.type).toBe("bugfix");
      expect(resolution.source).toBe("arg");
      expect(resolution.requiresConfirmation).toBe(false);
      const phases = getPhasesForType(resolution.type);
      expect(phases).toEqual(WORKFLOW_REGISTRY.bugfix.phases);
    });

    it("a wf: label resolves to chore and requires confirmation", () => {
      const resolution = resolveWorkflowSelection(undefined, ["wf:chore"]);
      expect(resolution.type).toBe("chore");
      expect(resolution.source).toBe("label");
      expect(resolution.matchedLabel).toBe("wf:chore");
      expect(resolution.requiresConfirmation).toBe(true);
      const phases = getPhasesForType(resolution.type);
      expect(phases).toEqual(WORKFLOW_REGISTRY.chore.phases);
    });

    it("a bd-17-style title with no labels resolves to feature", () => {
      // Regression: the word "CI" used to demote this to chore.
      const resolution = resolveWorkflowSelection(undefined, []);
      expect(resolution.type).toBe("feature");
      expect(resolution.source).toBe("default");
    });

    it("plain labels no longer drive resolution", () => {
      for (const label of ["chore", "bug", "investigation"]) {
        expect(resolveWorkflowSelection(undefined, [label]).type).toBe("feature");
      }
    });

    it("arg beats a wf: label", () => {
      const resolution = resolveWorkflowSelection("hotfix", ["wf:chore"]);
      expect(resolution.type).toBe("hotfix");
      expect(resolution.source).toBe("arg");
      expect(resolution.requiresConfirmation).toBe(false);
    });

    it("no labels or arg resolves to feature with implement-first phases", () => {
      const resolution = resolveWorkflowSelection();
      expect(resolution.type).toBe("feature");
      const phases = getPhasesForType(resolution.type);
      expect(phases).toHaveLength(6);
      expect(phases).toEqual(["implement", "review", "test", "userguide", "proof", "commit"]);
    });

    it("unknown type falls back to feature", () => {
      const type = resolveWorkflowSelection("invalid").type;
      expect(type).toBe("feature");
    });

    it("case-sensitive type falls back to feature", () => {
      const type = resolveWorkflowSelection("Bugfix").type;
      expect(type).toBe("feature");
      const phases = getPhasesForType(type);
      expect(phases).toEqual(WORKFLOW_REGISTRY.feature.phases);
    });
  });

  describe("isValidWorkflowType", () => {
    it("validates all 7 types", () => {
      for (const type of [
        "feature",
        "bugfix",
        "research",
        "chore",
        "documentation",
        "refactor",
        "hotfix",
      ]) {
        expect(isValidWorkflowType(type)).toBe(true);
      }
    });

    it("rejects unknown types", () => {
      expect(isValidWorkflowType("nonexistent")).toBe(false);
      expect(isValidWorkflowType("")).toBe(false);
      expect(isValidWorkflowType("Feature")).toBe(false);
    });
  });

  describe("cross-type phase consistency", () => {
    it("all types use valid phase names from the canonical PHASE_ORDER", () => {
      // Canonical phases from the existing system
      const canonicalPhases = [
        "scout",
        "plan",
        "implement",
        "review",
        "test",
        "userguide",
        "proof",
        "commit",
      ];

      for (const config of Object.values(WORKFLOW_REGISTRY)) {
        for (const phase of config.phases) {
          expect(canonicalPhases).toContain(phase);
        }
      }
    });
  });
});
