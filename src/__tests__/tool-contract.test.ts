import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_AGENTS, PROOF_VERIFIER_AGENT } from "../agent-registry.js";
import { ALL_PHASE_TOOLS } from "../process-gate.js";
import {
  CONSULT_TOOLS,
  FLEET_TOOLS,
  PLANNING_TOOL_SET,
  WORKFLOW_CONTROL_TOOLS,
} from "../role-tools.js";
import { EXTERNAL_TOOL_NAMES, HARNESS_TOOL_NAMES } from "../tool-audit.js";

// Resolve the repo root from this test file's location (src/__tests__ -> repo root)
// so the guard is invariant to the Vitest working directory.
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const extensionSource = readFileSync(join(repoRoot, "extensions/index.ts"), "utf8");

/** Tool names registered literally in the extension (`name: "belayd_x"`). */
const literalRegistrations = new Set(
  [...extensionSource.matchAll(/name: "([a-z][a-z0-9_]*)"/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  ),
);

const knownToolNames = new Set([...HARNESS_TOOL_NAMES, ...EXTERNAL_TOOL_NAMES]);

describe("agent tool contract (bd-133)", () => {
  it("every agent allowlist entry is a harness tool or a declared external tool", () => {
    for (const agent of [...DEFAULT_AGENTS, PROOF_VERIFIER_AGENT]) {
      for (const tool of agent.tools) {
        expect(knownToolNames.has(tool), `${agent.name} names unknown tool ${tool}`).toBe(true);
      }
    }
  });

  it("every role tool set entry is a known tool", () => {
    for (const set of [WORKFLOW_CONTROL_TOOLS, CONSULT_TOOLS, FLEET_TOOLS, PLANNING_TOOL_SET]) {
      for (const tool of set) {
        expect(knownToolNames.has(tool), `role set names unknown tool ${tool}`).toBe(true);
      }
    }
  });

  it("every statically listed harness tool is registered by the extension", () => {
    // Phase tools AND the documenter tool are registered by the agent loop (the
    // documenter has no entry in PHASE_ORDER but gets its own tool name).
    const phaseTools = new Set([...ALL_PHASE_TOOLS, "belayd_documenter"]);
    for (const tool of HARNESS_TOOL_NAMES) {
      if (phaseTools.has(tool)) continue; // registered by the per-agent registration loop
      expect(literalRegistrations.has(tool), `${tool} is listed but never registered`).toBe(true);
    }
  });

  it("does not register a tool that the static harness list omits", () => {
    // The doctor's audit compares allowlists against HARNESS_TOOL_NAMES, so a
    // tool that is registered but unlisted would be reported as missing forever.
    for (const tool of literalRegistrations) {
      if (!tool.startsWith("belayd_") && tool !== "bd") continue;
      expect(
        HARNESS_TOOL_NAMES.includes(tool),
        `${tool} is registered but not in HARNESS_TOOL_NAMES`,
      ).toBe(true);
    }
  });
});
