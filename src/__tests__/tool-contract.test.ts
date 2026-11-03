import { describe, expect, it } from "vitest";

import { DEFAULT_AGENTS, PROOF_VERIFIER_AGENT, UNSLOP_AGENT } from "../agent-registry.js";
import { ALL_PHASE_TOOLS } from "../process-gate.js";
import {
  CONSULT_TOOLS,
  FLEET_TOOLS,
  PLANNING_TOOL_SET,
  WORKFLOW_CONTROL_TOOLS,
  workflowGateToolSet,
} from "../role-tools.js";
import { EXTERNAL_TOOL_NAMES, HARNESS_TOOL_NAMES } from "../tool-audit.js";
import { WORKFLOW_REGISTRY } from "../workflow-registry.js";
import { readExtensionSource } from "./extension-source.js";

// The whole extension source (composer + capability modules), so a tool
// registered from a capability module is still seen by this guard.
const extensionSource = readExtensionSource();

/** Tool names registered literally in the extension (`name: "belayd_x"`). */
const literalRegistrations = new Set(
  [...extensionSource.matchAll(/name: "([a-z][a-z0-9_]*)"/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  ),
);

const knownToolNames = new Set([...HARNESS_TOOL_NAMES, ...EXTERNAL_TOOL_NAMES]);

/**
 * Every tool name any workflow's gate can leave active.
 *
 * The gate is the only surface that can deny an already-registered tool: when a
 * workflow is active `pi.setActiveTools(workflowGateToolSet(...))` replaces the
 * whole session surface, so a tool outside every one of these sets is
 * unreachable for the entire workflow even though it is registered.
 */
const gateSurface = new Set(
  Object.values(WORKFLOW_REGISTRY).flatMap((config) =>
    workflowGateToolSet({ phases: config.phases, consultPhases: config.consultPhases }),
  ),
);

describe("agent tool contract (bd-133)", () => {
  it("every agent allowlist entry is a harness tool or a declared external tool", () => {
    for (const agent of [...DEFAULT_AGENTS, PROOF_VERIFIER_AGENT, UNSLOP_AGENT]) {
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

describe("workflow gate surface (bd-253)", () => {
  it("keeps every belayd tool an agent is allowlisted to call reachable under the gate", () => {
    // A registered tool that the gate drops is indistinguishable from a missing
    // tool at call time, and the call is refused. bd-253 shipped exactly that:
    // `belayd_unslop` was registered and allowlisted for the implementer, but no
    // workflow's gate surface contained it.
    for (const agent of [...DEFAULT_AGENTS, PROOF_VERIFIER_AGENT, UNSLOP_AGENT]) {
      for (const tool of agent.tools) {
        if (!tool.startsWith("belayd_")) continue;
        expect(
          gateSurface.has(tool),
          `${agent.name} may call ${tool}, but every gated workflow refuses it: add it to CONSULT_TOOLS if it belongs mid-workflow`,
        ).toBe(true);
      }
    }
  });

  it("pins the registered belayd tools that stay outside the gate on purpose", () => {
    // Each family below is deliberate, so adding a tool to this list has to be a
    // decision rather than an accident:
    // - planning mode registers its own surface (`PLANNING_TOOL_SET`) and arms no
    //   workflow gate; `belayd_start_task` would require a stop first.
    // - the supervisor fleet tier arms no gate, and `belayd_transcript` must never
    //   reach a phase surface (ownership/leakage rules); `belayd_fleet_inbox`,
    //   `belayd_fleet_note` and `belayd_fleet_status` are member-facing and stay
    //   in the gate via `MEMBER_FLEET_TOOLS`.
    // - `belayd_metrics` is an operator query, not a mid-workflow step.
    // `belayd_documenter` cannot appear here: the agent loop registers it from a
    // computed name, so the literal scan below never sees it.
    const outside = [...literalRegistrations]
      .filter((tool) => tool.startsWith("belayd_") && !gateSurface.has(tool))
      .sort();
    expect(outside).toEqual([
      "belayd_fleet_advance",
      "belayd_fleet_launch",
      "belayd_fleet_merge",
      "belayd_fleet_pause",
      "belayd_fleet_reconcile",
      "belayd_fleet_release",
      "belayd_fleet_resume",
      "belayd_metrics",
      "belayd_plan_research",
      "belayd_plan_scout",
      "belayd_start_task",
      "belayd_stop_planning",
      "belayd_transcript",
      "belayd_transcript_digest",
      "belayd_workflow_digest",
    ]);
  });
});
