import { describe, expect, it } from "vitest";

import {
  CONSULT_TOOLS,
  MEMBER_FLEET_TOOLS,
  PLANNING_TOOL_SET,
  SUPERVISOR_FLEET_TOOLS,
  toolSetSize,
  WORKFLOW_CONTROL_TOOLS,
  workflowGateToolSet,
} from "../role-tools.js";
import { WORKFLOW_REGISTRY } from "../workflow-registry.js";

const setFor = (type: keyof typeof WORKFLOW_REGISTRY): string[] => {
  const config = WORKFLOW_REGISTRY[type];
  return workflowGateToolSet({ phases: config.phases, consultPhases: config.consultPhases });
};

describe("workflowGateToolSet", () => {
  it("offers a feature workflow exactly its own phase and consult tools", () => {
    const tools = setFor("feature");

    for (const phase of ["implement", "review", "test", "userguide", "proof", "commit"]) {
      expect(tools).toContain(`belayd_${phase}`);
    }
    // consultPhases stay callable but do not gate progress
    expect(tools).toContain("belayd_scout");
    expect(tools).toContain("belayd_plan");
  });

  it("omits phases the workflow type never runs", () => {
    expect(setFor("bugfix")).not.toContain("belayd_userguide");
    expect(setFor("documentation")).not.toContain("belayd_review");
    expect(setFor("research")).not.toContain("belayd_implement");
    expect(setFor("chore")).not.toContain("belayd_proof");
  });

  it("never declares supervisor-only fleet tools", () => {
    for (const type of Object.keys(WORKFLOW_REGISTRY) as Array<keyof typeof WORKFLOW_REGISTRY>) {
      const tools = setFor(type);
      for (const fleetTool of SUPERVISOR_FLEET_TOOLS) {
        expect(tools, `${type} declares ${fleetTool}`).not.toContain(fleetTool);
      }
    }
  });

  it("keeps the member-facing fleet tools so a paused member can see why", () => {
    for (const fleetTool of MEMBER_FLEET_TOOLS) {
      expect(setFor("feature"), `feature is missing ${fleetTool}`).toContain(fleetTool);
    }
  });

  it("never declares a tool that can edit files during a gated workflow", () => {
    for (const type of Object.keys(WORKFLOW_REGISTRY) as Array<keyof typeof WORKFLOW_REGISTRY>) {
      const tools = setFor(type);
      for (const writeTool of ["edit", "write", "bash"]) {
        expect(tools, `${type} declares ${writeTool}`).not.toContain(writeTool);
      }
    }
  });

  it("does not declare belayd_documenter, which no phase order contains", () => {
    for (const type of Object.keys(WORKFLOW_REGISTRY) as Array<keyof typeof WORKFLOW_REGISTRY>) {
      expect(setFor(type)).not.toContain("belayd_documenter");
    }
  });

  it("stays inside the declared-tool budget for every workflow type", () => {
    for (const type of Object.keys(WORKFLOW_REGISTRY) as Array<keyof typeof WORKFLOW_REGISTRY>) {
      // The pre-bd-133 surface was 35 tools (10 phase + 15 control/fleet/consult
      // + 5 browse + 5 assorted). Anything above this bound means a family
      // crept back into the gated set.
      expect(toolSetSize(setFor(type)), `${type} declares too many tools`).toBeLessThanOrEqual(24);
    }
  });

  it("keeps every control and consult tool in every workflow", () => {
    for (const type of Object.keys(WORKFLOW_REGISTRY) as Array<keyof typeof WORKFLOW_REGISTRY>) {
      const tools = setFor(type);
      for (const tool of [...WORKFLOW_CONTROL_TOOLS, ...CONSULT_TOOLS]) {
        expect(tools, `${type} is missing ${tool}`).toContain(tool);
      }
    }
  });

  it("dedupes a phase that is both required and consultable", () => {
    const tools = workflowGateToolSet({ phases: ["implement"], consultPhases: ["implement"] });

    expect(tools.filter((tool) => tool === "belayd_implement")).toHaveLength(1);
  });
});

describe("PLANNING_TOOL_SET", () => {
  it("can investigate and write beads but cannot touch the repository", () => {
    expect(PLANNING_TOOL_SET).toContain("bd");
    expect(PLANNING_TOOL_SET).toContain("belayd_plan_scout");
    expect(PLANNING_TOOL_SET).toContain("belayd_plan_research");
    for (const writeTool of ["edit", "write", "bash", "agent_browser"]) {
      expect(PLANNING_TOOL_SET).not.toContain(writeTool);
    }
  });

  it("does not carry workflow phase tools", () => {
    for (const tool of PLANNING_TOOL_SET) {
      expect(tool.startsWith("belayd_fleet_") || tool === "belayd_implement").toBe(false);
    }
  });
});
