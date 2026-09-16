import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS,
  getAgent,
  getAgentByShortName,
  getPhaseToolName,
} from "../agent-registry.js";
import { MODEL_CLASS_SPECS } from "../model-classes.js";

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
      expect(agent).toHaveProperty("modelClass");
      expect(agent).toHaveProperty("tools");
      expect(agent).toHaveProperty("systemPrompt");

      // Name should start with belayd-
      expect(agent.name).toMatch(/^belayd-/);

      // Model class should be set
      expect(agent.modelClass).toBeTruthy();

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

  it("planner declares the frontier class", () => {
    const planner = DEFAULT_AGENTS.find((a) => a.name === "belayd-planner");
    expect(planner).toBeDefined();
    expect(planner?.modelClass).toBe("frontier");
  });

  it("reviewer declares the standard class", () => {
    const reviewer = DEFAULT_AGENTS.find((a) => a.name === "belayd-reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.modelClass).toBe("standard");
  });

  it("scout and committer declare the fast class", () => {
    const scout = DEFAULT_AGENTS.find((a) => a.name === "belayd-scout");
    const committer = DEFAULT_AGENTS.find((a) => a.name === "belayd-committer");
    expect(scout?.modelClass).toBe("fast");
    expect(committer?.modelClass).toBe("fast");
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

  it("all agents declare a valid modelClass", () => {
    // Derived from MODEL_CLASS_SPECS so a new class cannot silently make this
    // list stale; the union-vs-spec drift check lives in model-classes.test.ts.
    const validClasses = Object.keys(MODEL_CLASS_SPECS);
    for (const agent of DEFAULT_AGENTS) {
      expect(agent.modelClass, agent.name).toBeDefined();
      expect(validClasses, agent.name).toContain(agent.modelClass);
    }
  });

  it("spot checks modelClass assignments", () => {
    expect(DEFAULT_AGENTS.find((a) => a.name === "belayd-scout")?.modelClass).toBe("fast");
    expect(DEFAULT_AGENTS.find((a) => a.name === "belayd-planner")?.modelClass).toBe("frontier");
    expect(DEFAULT_AGENTS.find((a) => a.name === "belayd-reviewer")?.modelClass).toBe("standard");
  });

  it("every agent is modelClass-only (no explicit model)", () => {
    for (const agent of DEFAULT_AGENTS) {
      expect("model" in agent, agent.name).toBe(false);
    }
  });

  it("proof-generator has the functional-proof tool allowlist", () => {
    const proofGen = DEFAULT_AGENTS.find((a) => a.name === "belayd-proof-generator");
    expect(proofGen).toBeDefined();
    expect(proofGen?.tools).toEqual(["read", "bash", "ls", "find", "ast_grep"]);
  });

  it("proof-generator prompt presents proof tools as bash commands, not standalone tools", () => {
    const proofGen = DEFAULT_AGENTS.find((a) => a.name === "belayd-proof-generator");
    expect(proofGen).toBeDefined();
    const prompt = proofGen?.systemPrompt ?? "";
    expect(prompt).toContain("asciinema");
    expect(prompt).toContain("playwright-cli");
    expect(prompt).toContain("SHELL COMMANDS");
    expect(prompt).not.toMatch(/^\s*-\s*`(asciinema|playwright-cli|playwright|screenshot)`\s*—/m);
  });

  it("proof-generator prompt documents skip marker and trace.zip guidance", () => {
    const proofGen = DEFAULT_AGENTS.find((a) => a.name === "belayd-proof-generator");
    expect(proofGen).toBeDefined();
    const prompt = proofGen?.systemPrompt ?? "";
    expect(prompt).toContain("Proof skipped");
    expect(prompt).toContain("trace.zip");
    expect(prompt).toContain("BELAYD_PROOF=1");
  });

  it("proof-generator description and prompt name the rejected test runners", () => {
    const proofGen = DEFAULT_AGENTS.find((a) => a.name === "belayd-proof-generator");
    expect(proofGen).toBeDefined();
    const description = proofGen?.description ?? "";
    const prompt = proofGen?.systemPrompt ?? "";
    expect(description).not.toContain("video recordings");
    expect(description).toContain("browser traces");
    expect(prompt).toContain("vitest");
    expect(prompt).toContain("jest");
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
