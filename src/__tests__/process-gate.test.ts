import { describe, expect, it } from "vitest";
import {
  checkToolAllowed,
  formatProcessState,
  getNextPhase,
  isWorkflowComplete,
  markPhaseCompleted,
  PHASE_INDEX,
  PHASE_ORDER,
  PHASE_TOOLS,
} from "../process-gate.js";

describe("PHASE_ORDER", () => {
  it("has the correct 8 phases in order", () => {
    expect(PHASE_ORDER).toEqual([
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
});

describe("PHASE_TOOLS", () => {
  it("maps phases to tool names", () => {
    expect(PHASE_TOOLS).toEqual([
      "belayd_scout",
      "belayd_plan",
      "belayd_implement",
      "belayd_review",
      "belayd_test",
      "belayd_userguide",
      "belayd_proof",
      "belayd_commit",
    ]);
  });
});

describe("PHASE_INDEX", () => {
  it("maps each tool name to its zero-based index", () => {
    expect(PHASE_INDEX).toHaveProperty("belayd_scout", 0);
    expect(PHASE_INDEX).toHaveProperty("belayd_plan", 1);
    expect(PHASE_INDEX).toHaveProperty("belayd_implement", 2);
    expect(PHASE_INDEX).toHaveProperty("belayd_review", 3);
    expect(PHASE_INDEX).toHaveProperty("belayd_test", 4);
    expect(PHASE_INDEX).toHaveProperty("belayd_userguide", 5);
    expect(PHASE_INDEX).toHaveProperty("belayd_proof", 6);
    expect(PHASE_INDEX).toHaveProperty("belayd_commit", 7);
  });

  it("has exactly 8 entries", () => {
    expect(Object.keys(PHASE_INDEX)).toHaveLength(8);
  });
});

describe("checkToolAllowed", () => {
  const completed: string[] = [];

  it("allows all tools when gate is inactive", () => {
    for (const tool of PHASE_TOOLS) {
      const result = checkToolAllowed(tool, completed, false);
      expect(result.allowed).toBe(true);
    }
  });

  it("allows non-phase tools when gate is active", () => {
    const result = checkToolAllowed("read", completed, true);
    expect(result.allowed).toBe(true);
  });

  it("blocks belayd_plan when scout is not completed", () => {
    const result = checkToolAllowed("belayd_plan", [], true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("scout");
  });

  it("blocks belayd_commit when no phases are completed", () => {
    const result = checkToolAllowed("belayd_commit", [], true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("scout");
  });

  it("allows scout as the first step", () => {
    const result = checkToolAllowed("belayd_scout", [], true);
    expect(result.allowed).toBe(true);
  });

  it("allows plan after scout is completed", () => {
    const result = checkToolAllowed("belayd_plan", ["scout"], true);
    expect(result.allowed).toBe(true);
  });

  it("blocks implement before plan is completed", () => {
    const result = checkToolAllowed("belayd_implement", ["scout"], true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("plan");
  });

  it("allows implement after scout + plan are completed", () => {
    const result = checkToolAllowed("belayd_implement", ["scout", "plan"], true);
    expect(result.allowed).toBe(true);
  });

  it("blocks a phase when an earlier phase is missing in the middle", () => {
    // Completed: scout, implement (but plan is missing)
    const result = checkToolAllowed("belayd_review", ["scout", "implement"], true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("plan");
  });

  it("allows full chain in order", () => {
    const phases = ["scout", "plan", "implement", "review", "test", "userguide", "proof"];
    const result = checkToolAllowed("belayd_commit", phases, true);
    expect(result.allowed).toBe(true);
  });

  it("blocks empty tool name gracefully", () => {
    const result = checkToolAllowed("", [], true);
    expect(result.allowed).toBe(true); // Not a phase tool
  });
});

describe("checkToolAllowed with custom 4-phase order", () => {
  const customOrder = ["plan", "implement", "test", "commit"] as const;

  it("allows the first phase", () => {
    const result = checkToolAllowed("belayd_plan", [], true, customOrder);
    expect(result.allowed).toBe(true);
  });

  it("blocks out-of-order phase", () => {
    const result = checkToolAllowed("belayd_implement", [], true, customOrder);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("plan");
  });

  it("blocks phases not included in custom order", () => {
    const result = checkToolAllowed("belayd_scout", [], true, customOrder);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of");
  });

  it("allows commit after all prior phases complete", () => {
    const result = checkToolAllowed(
      "belayd_commit",
      ["plan", "implement", "test"],
      true,
      customOrder,
    );
    expect(result.allowed).toBe(true);
  });

  it("is insensitive to gate inactive", () => {
    const result = checkToolAllowed("belayd_scout", [], false, customOrder);
    expect(result.allowed).toBe(true);
  });
});

describe("checkToolAllowed with optionalPhases", () => {
  const customOrder = ["scout", "plan", "implement", "commit"] as const;
  const optional = ["scout"];

  it("allows plan when scout is optional and not completed", () => {
    const result = checkToolAllowed("belayd_plan", [], true, customOrder, "bugfix", optional);
    expect(result.allowed).toBe(true);
  });

  it("still requires non-optional phases to complete", () => {
    const result = checkToolAllowed(
      "belayd_implement",
      ["scout"],
      true,
      customOrder,
      "bugfix",
      optional,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("plan");
  });

  it("allows full chain when optional phase is skipped", () => {
    const result = checkToolAllowed(
      "belayd_commit",
      ["plan", "implement"],
      true,
      customOrder,
      "bugfix",
      optional,
    );
    expect(result.allowed).toBe(true);
  });
});

describe("markPhaseCompleted", () => {
  it("adds a new phase to completed list", () => {
    const result = markPhaseCompleted("belayd_scout", []);
    expect(result).toEqual(["scout"]);
  });

  it("does not duplicate phases", () => {
    const result = markPhaseCompleted("belayd_scout", ["scout"]);
    expect(result).toEqual(["scout"]);
  });

  it("returns the same array for non-phase tools", () => {
    const result = markPhaseCompleted("read", ["scout"]);
    expect(result).toEqual(["scout"]);
  });

  it("builds up in order for sequential calls", () => {
    let completed: string[] = [];
    for (const tool of PHASE_TOOLS) {
      completed = markPhaseCompleted(tool, completed);
    }
    expect(completed).toEqual([...PHASE_ORDER]);
  });
});

describe("markPhaseCompleted with custom order", () => {
  const customOrder = ["plan", "implement", "test", "commit"] as const;

  it("appends the phase in order", () => {
    const result = markPhaseCompleted("belayd_plan", [], customOrder);
    expect(result).toEqual(["plan"]);
  });

  it("builds up sequential calls", () => {
    let completed: string[] = [];
    for (const phase of customOrder) {
      completed = markPhaseCompleted(`belayd_${phase}`, completed, customOrder);
    }
    expect(completed).toEqual([...customOrder]);
  });

  it("ignores phases not in custom order", () => {
    const result = markPhaseCompleted("belayd_scout", ["plan"], customOrder);
    expect(result).toEqual(["plan"]);
  });
});

describe("isWorkflowComplete", () => {
  it("returns false when no phases are completed", () => {
    expect(isWorkflowComplete([])).toBe(false);
  });

  it("returns false when only some phases are completed", () => {
    expect(isWorkflowComplete(["scout", "plan"])).toBe(false);
  });

  it("returns true when all 8 phases are completed", () => {
    expect(isWorkflowComplete([...PHASE_ORDER])).toBe(true);
  });

  it("returns false when phases are completed but out of order", () => {
    expect(isWorkflowComplete(["commit", "scout", "plan"])).toBe(false);
  });
});

describe("isWorkflowComplete with custom order", () => {
  const customOrder = ["plan", "implement", "test", "commit"] as const;

  it("returns false when nothing completed", () => {
    expect(isWorkflowComplete([], customOrder)).toBe(false);
  });

  it("returns true when all phases completed", () => {
    expect(isWorkflowComplete(["plan", "implement", "test", "commit"], customOrder)).toBe(true);
  });

  it("returns false when only some phases completed", () => {
    expect(isWorkflowComplete(["plan", "implement"], customOrder)).toBe(false);
  });

  it("returns false with default order when custom order completed", () => {
    // The default order is longer, so completing custom order shouldn't complete default
    expect(isWorkflowComplete(["plan", "implement", "test", "commit"])).toBe(false);
  });
});

describe("getNextPhase", () => {
  it("returns scout when nothing is completed", () => {
    expect(getNextPhase([])).toBe("scout");
  });

  it("returns plan when scout is completed", () => {
    expect(getNextPhase(["scout"])).toBe("plan");
  });

  it("returns undefined when all phases are completed", () => {
    expect(getNextPhase([...PHASE_ORDER])).toBeUndefined();
  });
});

describe("getNextPhase with custom order", () => {
  const customOrder = ["plan", "implement", "test", "commit"] as const;

  it("returns plan when nothing completed", () => {
    expect(getNextPhase([], customOrder)).toBe("plan");
  });

  it("returns implement after plan", () => {
    expect(getNextPhase(["plan"], customOrder)).toBe("implement");
  });

  it("returns undefined when all done", () => {
    expect(getNextPhase(["plan", "implement", "test", "commit"], customOrder)).toBeUndefined();
  });

  it("returns commit after plan, implement, test", () => {
    expect(getNextPhase(["plan", "implement", "test"], customOrder)).toBe("commit");
  });
});

describe("formatProcessState", () => {
  it("renders a human-readable summary", () => {
    const output = formatProcessState(["scout", "plan"], "bd-42");
    expect(output).toContain("bd-42");
    expect(output).toContain("✅");
    expect(output).toContain("⬜");
    expect(output).toContain("belayd_scout");
    expect(output).toContain("belayd_commit");
  });

  it("handles empty completed list", () => {
    const output = formatProcessState([], "bd-42");
    expect(output).toContain("bd-42");
    expect(output).not.toContain("✅");
  });
});

describe("formatProcessState with custom order", () => {
  const customOrder = ["plan", "implement", "test", "commit"] as const;

  it("renders custom phases in correct order", () => {
    const output = formatProcessState(["plan"], "bd-84", customOrder);
    expect(output).toContain("belayd_plan");
    expect(output).toContain("belayd_implement");
    expect(output).toContain("belayd_test");
    expect(output).toContain("belayd_commit");
    expect(output).toContain("✅");
    expect(output).not.toContain("belayd_scout");
  });

  it("marks completed phases with checkmark", () => {
    const output = formatProcessState(["plan", "implement"], "bd-84", customOrder);
    expect(output).toContain("✅");
    expect(output).toContain("⬜");
  });
});

describe("checkToolAllowed with custom phaseOrder (research)", () => {
  const researchOrder = ["scout", "plan", "proof", "commit"] as const;

  it("allows scout as first step in research", () => {
    const result = checkToolAllowed("belayd_scout", [], true, researchOrder);
    expect(result.allowed).toBe(true);
  });

  it("allows plan after scout in research", () => {
    const result = checkToolAllowed("belayd_plan", ["scout"], true, researchOrder);
    expect(result.allowed).toBe(true);
  });

  it("blocks implement in research (not in phase order)", () => {
    const result = checkToolAllowed("belayd_implement", [], true, researchOrder);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("allows proof after scout+plan in research", () => {
    const result = checkToolAllowed("belayd_proof", ["scout", "plan"], true, researchOrder);
    expect(result.allowed).toBe(true);
  });

  it("blocks proof before plan in research", () => {
    const result = checkToolAllowed("belayd_proof", ["scout"], true, researchOrder);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("plan");
  });
});

describe("checkToolAllowed with custom phaseOrder (hotfix)", () => {
  const hotfixOrder = ["implement", "review", "test", "proof", "commit"] as const;

  it("allows implement as first step in hotfix", () => {
    const result = checkToolAllowed("belayd_implement", [], true, hotfixOrder);
    expect(result.allowed).toBe(true);
  });

  it("blocks scout in hotfix (not in phase order)", () => {
    const result = checkToolAllowed("belayd_scout", [], true, hotfixOrder);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("blocks plan in hotfix (not in phase order)", () => {
    const result = checkToolAllowed("belayd_plan", [], true, hotfixOrder);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("blocks userguide in hotfix (not in phase order)", () => {
    const result = checkToolAllowed("belayd_userguide", [], true, hotfixOrder);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("allows review after implement in hotfix", () => {
    const result = checkToolAllowed("belayd_review", ["implement"], true, hotfixOrder);
    expect(result.allowed).toBe(true);
  });

  it("blocks review before implement in hotfix", () => {
    const result = checkToolAllowed("belayd_review", [], true, hotfixOrder);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("implement");
  });

  it("allows commit after all hotfix phases", () => {
    const result = checkToolAllowed(
      "belayd_commit",
      ["implement", "review", "test", "proof"],
      true,
      hotfixOrder,
    );
    expect(result.allowed).toBe(true);
  });
});

describe("checkToolAllowed with optionalPhases (bugfix scout skip)", () => {
  const bugfixOrder = ["scout", "plan", "implement", "review", "test", "proof", "commit"] as const;
  const optionalPhases = ["scout"];

  it("allows plan without scout when scout is optional", () => {
    const result = checkToolAllowed("belayd_plan", [], true, bugfixOrder, "bugfix", optionalPhases);
    expect(result.allowed).toBe(true);
  });

  it("blocks implement before plan even when scout is optional and skipped", () => {
    const result = checkToolAllowed(
      "belayd_implement",
      [],
      true,
      bugfixOrder,
      "bugfix",
      optionalPhases,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("plan");
  });

  it("allows implement after plan with scout optional and completed", () => {
    const result = checkToolAllowed(
      "belayd_implement",
      ["plan"],
      true,
      bugfixOrder,
      "bugfix",
      optionalPhases,
    );
    expect(result.allowed).toBe(true);
  });

  it("allows scout even when optional", () => {
    const result = checkToolAllowed(
      "belayd_scout",
      [],
      true,
      bugfixOrder,
      "bugfix",
      optionalPhases,
    );
    expect(result.allowed).toBe(true);
  });

  it("allows plan after scout when scout was completed", () => {
    const result = checkToolAllowed(
      "belayd_plan",
      ["scout"],
      true,
      bugfixOrder,
      "bugfix",
      optionalPhases,
    );
    expect(result.allowed).toBe(true);
  });

  it("non-optional phases still block properly", () => {
    const result = checkToolAllowed(
      "belayd_proof",
      ["scout", "plan", "implement", "review"],
      true,
      bugfixOrder,
      "bugfix",
      optionalPhases,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("test");
  });

  it("blocks userguide in bugfix (not in phase order)", () => {
    const result = checkToolAllowed(
      "belayd_userguide",
      [],
      true,
      bugfixOrder,
      "bugfix",
      optionalPhases,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });
});

describe("checkToolAllowed for belayd_userguide in all workflow types", () => {
  it("allows belayd_userguide in feature workflow after all prior phases", () => {
    const result = checkToolAllowed(
      "belayd_userguide",
      ["scout", "plan", "implement", "review", "test"],
      true,
      undefined,
      "feature",
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks belayd_userguide before test completes in feature", () => {
    const result = checkToolAllowed(
      "belayd_userguide",
      ["scout", "plan", "implement", "review"],
      true,
      undefined,
      "feature",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("test");
  });

  it("blocks belayd_userguide before plan and implement in feature", () => {
    const result = checkToolAllowed("belayd_userguide", ["scout"], true, undefined, "feature");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("plan");
  });

  it("blocks belayd_userguide in bugfix workflow (not in bugfix phase order)", () => {
    const bugfixOrder = [
      "scout",
      "plan",
      "implement",
      "review",
      "test",
      "proof",
      "commit",
    ] as const;
    const result = checkToolAllowed("belayd_userguide", [], true, bugfixOrder, "bugfix");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("blocks belayd_userguide in research workflow", () => {
    const researchOrder = ["scout", "plan", "proof", "commit"] as const;
    const result = checkToolAllowed("belayd_userguide", [], true, researchOrder, "research");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("blocks belayd_userguide in chore workflow", () => {
    const choreOrder = ["plan", "implement", "test", "commit"] as const;
    const result = checkToolAllowed("belayd_userguide", [], true, choreOrder, "chore");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("blocks belayd_userguide in documentation workflow", () => {
    const docOrder = ["scout", "plan", "implement", "proof", "commit"] as const;
    const result = checkToolAllowed("belayd_userguide", [], true, docOrder, "documentation");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("blocks belayd_userguide in refactor workflow", () => {
    const refactorOrder = [
      "scout",
      "plan",
      "implement",
      "review",
      "test",
      "proof",
      "commit",
    ] as const;
    const result = checkToolAllowed("belayd_userguide", [], true, refactorOrder, "refactor");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("blocks belayd_userguide in hotfix workflow", () => {
    const hotfixOrder = ["implement", "review", "test", "proof", "commit"] as const;
    const result = checkToolAllowed("belayd_userguide", [], true, hotfixOrder, "hotfix");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("allows belayd_userguide when gate is inactive regardless of workflow", () => {
    const hotfixOrder = ["implement", "review", "test", "proof", "commit"] as const;
    const result = checkToolAllowed("belayd_userguide", [], false, hotfixOrder, "hotfix");
    expect(result.allowed).toBe(true);
  });
});

describe("Phase ordering: userguide after test but before proof", () => {
  it("blocks belayd_proof when userguide is not completed", () => {
    const result = checkToolAllowed(
      "belayd_proof",
      ["scout", "plan", "implement", "review", "test"],
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("userguide");
  });

  it("allows belayd_proof after userguide is completed", () => {
    const result = checkToolAllowed(
      "belayd_proof",
      ["scout", "plan", "implement", "review", "test", "userguide"],
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks belayd_commit when userguide is not completed", () => {
    const result = checkToolAllowed(
      "belayd_commit",
      ["scout", "plan", "implement", "review", "test"],
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("userguide");
  });

  it("blocks belayd_userguide when test is not completed", () => {
    const result = checkToolAllowed(
      "belayd_userguide",
      ["scout", "plan", "implement", "review"],
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("test");
  });

  it("blocks belayd_userguide when an earlier phase (implement) is missing", () => {
    const result = checkToolAllowed("belayd_userguide", ["scout", "plan", "review"], true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("implement");
  });

  it("allows userguide after all required prior phases are completed", () => {
    const result = checkToolAllowed(
      "belayd_userguide",
      ["scout", "plan", "implement", "review", "test"],
      true,
    );
    expect(result.allowed).toBe(true);
  });
});

describe("isWorkflowComplete with 8-phase feature workflow", () => {
  it("returns false with 7 phases missing userguide", () => {
    const result = isWorkflowComplete([
      "scout",
      "plan",
      "implement",
      "review",
      "test",
      "proof",
      "commit",
    ]);
    expect(result).toBe(false);
  });

  it("returns false with 7 phases missing proof", () => {
    const result = isWorkflowComplete([
      "scout",
      "plan",
      "implement",
      "review",
      "test",
      "userguide",
      "commit",
    ]);
    expect(result).toBe(false);
  });

  it("returns true only when all 8 phases including userguide are present", () => {
    const result = isWorkflowComplete([
      "scout",
      "plan",
      "implement",
      "review",
      "test",
      "userguide",
      "proof",
      "commit",
    ]);
    expect(result).toBe(true);
  });

  it("returns true regardless of completion order (set membership check)", () => {
    const result = isWorkflowComplete([
      "commit",
      "proof",
      "userguide",
      "test",
      "review",
      "implement",
      "plan",
      "scout",
    ]);
    expect(result).toBe(true);
  });
});

describe("checkToolAllowed with non-phase tools and excluded workflows", () => {
  it("allows read,grep,find,ls regardless of workflow", () => {
    const hotfixOrder = ["implement", "review", "test", "proof", "commit"] as const;
    for (const tool of ["read", "grep", "find", "ls"]) {
      const result = checkToolAllowed(tool, [], true, hotfixOrder, "hotfix");
      expect(result.allowed).toBe(true);
    }
  });

  it("allows bash regardless of workflow", () => {
    const result = checkToolAllowed("bash", [], true, ["implement", "commit"], "hotfix");
    expect(result.allowed).toBe(true);
  });

  it("blocks scout phase tool in hotfix workflow", () => {
    const hotfixOrder = ["implement", "review", "test", "proof", "commit"] as const;
    const result = checkToolAllowed("belayd_scout", [], true, hotfixOrder, "hotfix");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not part of the");
  });

  it("allows plannotator tool in hotfix workflow (no longer a phase tool)", () => {
    const hotfixOrder = ["implement", "review", "test", "proof", "commit"] as const;
    const result = checkToolAllowed("belayd_plannotator", [], true, hotfixOrder, "hotfix");
    expect(result.allowed).toBe(true);
  });
});

describe("markPhaseCompleted with custom phaseOrder", () => {
  const hotfixOrder = ["implement", "review", "test", "proof", "commit"] as const;

  it("marks implement as completed in hotfix order", () => {
    const result = markPhaseCompleted("belayd_implement", [], hotfixOrder);
    expect(result).toEqual(["implement"]);
  });

  it("ignores scout (not in hotfix order)", () => {
    const result = markPhaseCompleted("belayd_scout", [], hotfixOrder);
    expect(result).toEqual([]);
  });

  it("builds hotfix phases in order", () => {
    const hotfixTools = [
      "belayd_implement",
      "belayd_review",
      "belayd_test",
      "belayd_proof",
      "belayd_commit",
    ];
    let completed: string[] = [];
    for (const tool of hotfixTools) {
      completed = markPhaseCompleted(tool, completed, hotfixOrder);
    }
    expect(completed).toEqual([...hotfixOrder]);
  });
});

describe("isWorkflowComplete with custom phaseOrder", () => {
  const researchOrder = ["scout", "plan", "proof", "commit"] as const;

  it("returns false when not all research phases done", () => {
    expect(isWorkflowComplete(["scout", "plan"], researchOrder)).toBe(false);
  });

  it("returns true when all research phases done", () => {
    expect(isWorkflowComplete(["scout", "plan", "proof", "commit"], researchOrder)).toBe(true);
  });

  it("returns true for standard 7 phases which contain all research phases", () => {
    expect(
      isWorkflowComplete(
        ["scout", "plan", "implement", "review", "test", "proof", "commit"],
        researchOrder,
      ),
    ).toBe(true);
  });
});

describe("getNextPhase with custom phaseOrder", () => {
  const hotfixOrder = ["implement", "review", "test", "proof", "commit"] as const;

  it("returns implement as first hotfix phase", () => {
    expect(getNextPhase([], hotfixOrder)).toBe("implement");
  });

  it("returns review after implement in hotfix", () => {
    expect(getNextPhase(["implement"], hotfixOrder)).toBe("review");
  });

  it("returns undefined when all hotfix phases done", () => {
    expect(
      getNextPhase(["implement", "review", "test", "proof", "commit"], hotfixOrder),
    ).toBeUndefined();
  });
});
