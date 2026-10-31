/**
 * Doctor capability: the `belayd_doctor` packaging/visibility tool (bd-179).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DEFAULT_AGENTS, PROOF_VERIFIER_AGENT } from "../../src/agent-registry.js";
import { resolvePiBinaryResolution } from "../../src/spawn.js";
import { formatDoctorReport } from "../../src/tool-audit.js";
import { emptyUsage } from "./context.js";

/** Session reader the composer supplies (the state lives in the composer). */
export interface DoctorDeps {
  getSessionState: (ctx: { sessionManager: { getSessionId: () => string } }) => {
    gateActive: boolean;
    planningActive: boolean;
    currentTaskId: string;
  };
}

/**
 * Register `belayd_doctor`; the composer supplies the pi API and session reader.
 *
 * Packaging visibility: three consumers load this harness (pi-web's bundled SDK
 * in-process, a spawned `pi` process, and the repo dev wrapper) and each gets a
 * different extension set. The doctor prints the surface this session actually
 * has plus the binary spawned agents would use, so "the tool is missing" and
 * "the agent was told to use a tool this build lacks" stop being invisible.
 * Read-only and always callable.
 */
export function registerDoctor(pi: ExtensionAPI, deps: DoctorDeps): void {
  pi.registerTool({
    name: "belayd_doctor",
    label: "Belayd Doctor",
    description:
      "Report the effective pi binary for spawned agents, this session's declared tool catalog " +
      "(with an estimated per-request token cost and source extension), and any agent allowlist " +
      "entries that no declared or external tool satisfies. Read-only.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = deps.getSessionState(ctx);
      const resolution = resolvePiBinaryResolution();
      const role = state.gateActive
        ? `workflow orchestrator (${state.currentTaskId})`
        : state.planningActive
          ? "planning orchestrator"
          : "interactive";
      const agents = [...DEFAULT_AGENTS, PROOF_VERIFIER_AGENT].map((agent) => ({
        name: agent.name,
        tools: agent.tools,
      }));
      const text = formatDoctorReport({
        role,
        runningInstall: process.env.PI_PACKAGE_DIR,
        agentDir: process.env.PI_CODING_AGENT_DIR,
        piWebSession: process.env.PI_WEB_SESSION === "1",
        env: {
          belaydPiBinary: process.env.BELAYD_PI_BINARY,
          piBinaryPath: process.env.PI_BINARY_PATH,
        },
        spawnedBinary: {
          binary: resolution.binary,
          source: resolution.source,
          fellBack: resolution.fellBack,
          candidates: resolution.candidates.map((candidate) => candidate.binary),
        },
        tools: pi.getAllTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          source: tool.sourceInfo.source,
          sourcePath: tool.sourceInfo.path,
          scope: tool.sourceInfo.scope,
        })),
        activeTools: pi.getActiveTools(),
        agents,
      });
      return {
        content: [{ type: "text" as const, text }],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });
}
