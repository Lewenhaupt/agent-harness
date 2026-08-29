import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS,
  getAgent,
  getAgentByShortName,
  getPhaseToolName,
} from "../agent-registry.js";

describe("DEFAULT_AGENTS", () => {
  it("defines all 9 agents", () => {
    const names = DEFAULT_AGENTS.map((a) => a.name);
    expect(names).toEqual([
      "belayd-scout",
      "belayd-planner",
      "belayd-implementer",
      "belayd-reviewer",
      "belayd-tester",
      "belayd-userguide",
      "belayd-proof-generator",
      "belayd-documenter",
      "belayd-committer",
    ]);
  });

  it("each agent has the required properties", () => {
    for (const agent of DEFAULT_AGENTS) {
      expect(agent).toHaveProperty("name");
      expect(agent).toHaveProperty("description");
      expect(agent).toHaveProperty("model");
      expect(agent).toHaveProperty("tools");
      expect(agent).toHaveProperty("systemPrompt");

      // Name should start with belayd-
      expect(agent.name).toMatch(/^belayd-/);

      // Model should be set
      expect(agent.model).toBeTruthy();

      // Tools should be a non-empty array
      expect(agent.tools.length).toBeGreaterThan(0);

      // System prompt should be meaningful
      expect(agent.systemPrompt.length).toBeGreaterThan(50);
    }
  });

  it("scout has read-only tools (no edit/write)", () => {
    const scout = DEFAULT_AGENTS.find((a) => a.name === "belayd-scout");
    expect(scout).toBeDefined();
    expect(scout?.tools).toContain("read");
    expect(scout?.tools).toContain("grep");
    expect(scout?.tools).toContain("bash");
    expect(scout?.tools).not.toContain("edit");
    expect(scout?.tools).not.toContain("write");
  });

  it("planner uses a top-tier model", () => {
    const planner = DEFAULT_AGENTS.find((a) => a.name === "belayd-planner");
    expect(planner).toBeDefined();
    expect(planner?.model).toBe("opencode-go/glm-5.3");
  });

  it("reviewer uses glm-5.2", () => {
    const reviewer = DEFAULT_AGENTS.find((a) => a.name === "belayd-reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.model).toBe("opencode-go/glm-5.2");
  });

  it("scout and committer use the cheapest model", () => {
    const scout = DEFAULT_AGENTS.find((a) => a.name === "belayd-scout");
    const committer = DEFAULT_AGENTS.find((a) => a.name === "belayd-committer");
    expect(scout?.model).toBe("opencode-go/mimo-v2.5");
    expect(committer?.model).toBe("opencode-go/mimo-v2.5");
  });

  it("implementer has write tools", () => {
    const impl = DEFAULT_AGENTS.find((a) => a.name === "belayd-implementer");
    expect(impl).toBeDefined();
    expect(impl?.tools).toContain("edit");
    expect(impl?.tools).toContain("write");
    expect(impl?.tools).toContain("bash");
  });

  it("committer has bash, ls, find, and ast_grep", () => {
    const committer = DEFAULT_AGENTS.find((a) => a.name === "belayd-committer");
    expect(committer).toBeDefined();
    expect(committer?.tools).toEqual(["bash", "ls", "find", "ast_grep"]);
  });

  it("userguide has read-only tools (no edit/write) and a quality gate", () => {
    const userguide = DEFAULT_AGENTS.find((a) => a.name === "belayd-userguide");
    expect(userguide).toBeDefined();
    expect(userguide?.tools).toContain("read");
    expect(userguide?.tools).toContain("grep");
    expect(userguide?.tools).toContain("bash");
    expect(userguide?.tools).not.toContain("edit");
    expect(userguide?.tools).not.toContain("write");
    expect(userguide?.qualityGate).toBeDefined();
  });

  it("implementer, tester, userguide, and proof-generator have quality gates wired", () => {
    const impl = DEFAULT_AGENTS.find((a) => a.name === "belayd-implementer");
    expect(impl?.qualityGate).toBeDefined();

    const tester = DEFAULT_AGENTS.find((a) => a.name === "belayd-tester");
    expect(tester?.qualityGate).toBeDefined();

    const userguide = DEFAULT_AGENTS.find((a) => a.name === "belayd-userguide");
    expect(userguide?.qualityGate).toBeDefined();

    const proofGen = DEFAULT_AGENTS.find((a) => a.name === "belayd-proof-generator");
    expect(proofGen?.qualityGate).toBeDefined();
  });
});

describe("getAgent", () => {
  it("returns the agent by full name", () => {
    const agent = getAgent("belayd-scout");
    expect(agent).toBeDefined();
    expect(agent?.name).toBe("belayd-scout");
  });

  it("returns undefined for unknown agents", () => {
    expect(getAgent("belayd-nonexistent")).toBeUndefined();
  });
});

describe("getAgentByShortName", () => {
  it("returns the agent by short name", () => {
    const agent = getAgentByShortName("scout");
    expect(agent).toBeDefined();
    expect(agent?.name).toBe("belayd-scout");
  });

  it("returns undefined for unknown short names", () => {
    expect(getAgentByShortName("nonexistent")).toBeUndefined();
  });
});

describe("getPhaseToolName", () => {
  it("returns the tool name for a phase", () => {
    expect(getPhaseToolName("scout")).toBe("belayd_scout");
    expect(getPhaseToolName("commit")).toBe("belayd_commit");
  });
});
