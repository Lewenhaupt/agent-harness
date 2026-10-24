import { describe, expect, it } from "vitest";

import {
  auditAgentTools,
  type DoctorInput,
  EXTERNAL_TOOL_NAMES,
  estimateSchemaTokens,
  estimateToolTokens,
  formatDoctorReport,
  HARNESS_TOOL_NAMES,
  unknownAllowlistTools,
} from "../tool-audit.js";

const agents = [
  { name: "belayd-reviewer", tools: ["read", "grep", "ast_grep"] },
  { name: "belayd-tester", tools: ["read", "edit"] },
];

describe("auditAgentTools", () => {
  it("reports only agents with a gap", () => {
    const rows = auditAgentTools(agents, ["read", "edit", "grep"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("agent", "belayd-reviewer");
    expect(rows[0]?.missing).toEqual(["ast_grep"]);
  });

  it("returns nothing when every allowlist entry is declared", () => {
    expect(auditAgentTools(agents, ["read", "edit", "grep", "ast_grep"])).toEqual([]);
  });
});

describe("unknownAllowlistTools", () => {
  it("separates external tools from typo'd names", () => {
    const rows = unknownAllowlistTools([
      { name: "typo", tools: ["ast_grep", "ast-grepp"] },
      { name: "external-only", tools: ["web_search_exa"] },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("agent", "typo");
    expect(rows[0]?.missing).toEqual(["ast-grepp"]);
  });

  it("treats every declared external tool as known", () => {
    expect(unknownAllowlistTools([{ name: "a", tools: [...EXTERNAL_TOOL_NAMES] }])).toEqual([]);
  });

  it("does not mistake a harness tool this session omits for a typo", () => {
    expect(unknownAllowlistTools([{ name: "a", tools: ["belayd_outline"] }])).toEqual([]);
  });
});

describe("estimateToolTokens", () => {
  it("rolls tokens up per source and sorts heaviest first", () => {
    const report = estimateToolTokens([
      { name: "small", description: "x", parameters: {}, source: "harness" },
      {
        name: "large",
        description: "y".repeat(400),
        parameters: { type: "object" },
        source: "harness",
      },
      { name: "other", description: "z", parameters: {}, source: "builtin" },
    ]);

    expect(report.rows[0]).toHaveProperty("name", "large");
    expect(report.bySource[0]).toHaveProperty("source", "harness");
    expect(report.bySource[0]).toHaveProperty("count", 2);
    expect(report.total).toBeGreaterThan(100);
  });

  it("estimates from the serialized schema, not the description alone", () => {
    const withoutParams = estimateSchemaTokens({ name: "a", description: "b" });
    const withParams = estimateSchemaTokens({
      name: "a",
      description: "b",
      parameters: { type: "object", properties: { payload: { type: "string" } } },
    });

    expect(withParams).toBeGreaterThan(withoutParams);
    expect(withoutParams).toBeGreaterThan(0);
  });
});

describe("formatDoctorReport", () => {
  const base: DoctorInput = {
    role: "workflow orchestrator (bd-1)",
    runningInstall: "/nix/store/pi-web-sdk",
    agentDir: "/home/u/.pi/agent",
    piWebSession: true,
    env: { belaydPiBinary: undefined, piBinaryPath: "/repo/bin/pi" },
    spawnedBinary: {
      binary: "/run/current-system/sw/bin/pi",
      source: "system",
      fellBack: true,
      candidates: ["/run/current-system/sw/bin/pi"],
    },
    tools: [
      { name: "read", description: "read", parameters: {}, source: "builtin" },
      { name: "belayd_status", description: "status", parameters: {}, source: "harness" },
    ],
    activeTools: ["read"],
    agents,
  };

  const fullSurface = [...HARNESS_TOOL_NAMES, ...EXTERNAL_TOOL_NAMES].map((name) => ({
    name,
    description: name,
    parameters: {},
    source: "harness",
  }));

  it("names the fallback and the env var that pins it", () => {
    const text = formatDoctorReport(base);

    expect(text).toContain("resolved: `/run/current-system/sw/bin/pi` (source: system, fallback)");
    expect(text).toContain("BELAYD_PI_BINARY");
  });

  it("lists the per-agent gaps when the surface is complete", () => {
    const text = formatDoctorReport({
      ...base,
      tools: fullSurface.filter((tool) => tool.name !== "ast_grep"),
    });

    expect(text).toContain("belayd-reviewer: missing ast_grep");
    expect(text).not.toContain("this session declares");
  });

  it("explains a restricted surface instead of blaming every agent", () => {
    const text = formatDoctorReport(base);

    expect(text).toContain("harness tools");
    expect(text).toContain("not the runtime a spawned agent gets");
    expect(text).not.toMatch(/belayd-reviewer: missing/);
  });

  it("says so when every allowlist resolves", () => {
    const text = formatDoctorReport({ ...base, tools: fullSurface });

    expect(text).toContain("every agent allowlist resolves");
  });

  it("still reports typos on a restricted surface", () => {
    const text = formatDoctorReport({
      ...base,
      agents: [{ name: "belayd-scout", tools: ["ast_grepp"] }],
    });

    expect(text).toContain("unknown names (typo?) ast_grepp");
  });
});
