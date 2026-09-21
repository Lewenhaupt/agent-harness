import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS,
  getAgent,
  getAgentByShortName,
  getPhaseToolName,
  PLANNING_MODE_SYSTEM_PROMPT,
  PLANNING_MODE_TOOLS,
  PROOF_VERIFIER_AGENT,
  PROOF_VERIFIER_SYSTEM_PROMPT,
  PROOF_VERIFIER_TOOLS,
  RESEARCHER_SYSTEM_PROMPT,
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

describe("PROOF_VERIFIER_AGENT", () => {
  it("is not registered in DEFAULT_AGENTS (no auto phase tool)", () => {
    expect(DEFAULT_AGENTS.some((a) => a.name === "belayd-proof-verifier")).toBe(false);
  });

  it("declares the standard class and read-only tools", () => {
    expect(PROOF_VERIFIER_AGENT.modelClass).toBe("standard");
    expect(PROOF_VERIFIER_AGENT.tools).toContain("read");
    expect(PROOF_VERIFIER_AGENT.tools).toContain("describe_image");
    expect(PROOF_VERIFIER_AGENT.tools).not.toContain("edit");
    expect(PROOF_VERIFIER_AGENT.tools).not.toContain("write");
    expect(PROOF_VERIFIER_AGENT.tools).not.toContain("bash");
  });

  it("has an advisory, non-blocking prompt with the verdict shape", () => {
    expect(PROOF_VERIFIER_SYSTEM_PROMPT).toContain("reasonable");
    expect(PROOF_VERIFIER_SYSTEM_PROMPT).toContain("non-blocking");
    expect(PROOF_VERIFIER_SYSTEM_PROMPT).toContain("## Verdict");
  });

  it("lists the expected tool names", () => {
    expect(PROOF_VERIFIER_TOOLS).toEqual(["read", "describe_image"]);
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

describe("PLANNING_MODE_SYSTEM_PROMPT", () => {
  it("contains the plan section shape and bd linking guidance", () => {
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("## Overview");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("## Steps");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("## Test Strategy");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("## Risks");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("bd dep");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("parent");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("open");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("backlog");
  });

  it("forbids edit/write/bash", () => {
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("edit");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("write");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("bash");
  });

  it("requires clarifying questions before planning and forbids a trailing menu", () => {
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("clarifying questions");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("ambigu");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("settle decisions");
  });

  it("requires the target bead to be written before planning ends", () => {
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("complete only when the target bead");
    expect(PLANNING_MODE_SYSTEM_PROMPT).toContain("bd update");
  });
});

describe("PLANNING_MODE_TOOLS", () => {
  it("contains bd, describe_image, and web tools", () => {
    expect(PLANNING_MODE_TOOLS).toContain("bd");
    expect(PLANNING_MODE_TOOLS).toContain("describe_image");
    expect(PLANNING_MODE_TOOLS).toContain("web_search_exa");
    expect(PLANNING_MODE_TOOLS).toContain("web_fetch_exa");
    expect(PLANNING_MODE_TOOLS).toContain("deep_search_exa");
    expect(PLANNING_MODE_TOOLS).toContain("web_search_advanced_exa");
  });

  it("contains no edit/write/bash", () => {
    expect(PLANNING_MODE_TOOLS).not.toContain("edit");
    expect(PLANNING_MODE_TOOLS).not.toContain("write");
    expect(PLANNING_MODE_TOOLS).not.toContain("bash");
  });

  it("allows ask_user for structured clarifying questions", () => {
    expect(PLANNING_MODE_TOOLS).toContain("ask_user");
  });
});

describe("RESEARCHER_SYSTEM_PROMPT", () => {
  it("contains the no-task-bead branch", () => {
    expect(RESEARCHER_SYSTEM_PROMPT).toContain("return your findings");
    expect(RESEARCHER_SYSTEM_PROMPT).toContain("planning mode");
  });
});
