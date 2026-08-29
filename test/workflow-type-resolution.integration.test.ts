import { describe, expect, it } from "vitest";
import {
  getPhasesForType,
  isValidWorkflowType,
  resolveWorkflowType,
  WORKFLOW_REGISTRY,
} from "../src/workflow-registry.js";

describe("workflow type resolution (integration)", () => {
  describe("resolveWorkflowType", () => {
    it("explicit arg resolves to bugfix with correct phases", () => {
      const type = resolveWorkflowType("bugfix");
      expect(type).toBe("bugfix");
      const phases = getPhasesForType(type);
      expect(phases).toEqual(WORKFLOW_REGISTRY.bugfix.phases);
    });

    it("label match resolves to chore", () => {
      const type = resolveWorkflowType(undefined, ["chore"]);
      expect(type).toBe("chore");
      const phases = getPhasesForType(type);
      expect(phases).toEqual(WORKFLOW_REGISTRY.chore.phases);
    });

    it("multiple labels picks the first match", () => {
      const type = resolveWorkflowType(undefined, ["bugfix", "chore", "hotfix"]);
      expect(type).toBe("bugfix");
    });

    it("no labels or arg resolves to feature with all 8 phases", () => {
      const type = resolveWorkflowType();
      expect(type).toBe("feature");
      const phases = getPhasesForType(type);
      expect(phases).toHaveLength(8);
      expect(phases).toEqual([
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

    it("unknown type falls back to feature", () => {
      const type = resolveWorkflowType("invalid");
      expect(type).toBe("feature");
    });

    it("case-sensitive type falls back to feature", () => {
      const type = resolveWorkflowType("Bugfix");
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
