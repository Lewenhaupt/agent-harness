/**
 * Planning capability (bd-179): the `/plan` command and its two investigation
 * tools.
 *
 * Planning mode is the one mode that is *not* task-gated: it disables the same
 * editing tools the gate does, but every phase is optional and nothing is
 * persisted as a workflow. It therefore takes the gate's tool-set switch and the
 * planning-run launcher from its host instead of owning gate state.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getAgentByShortName,
  RESEARCHER_SYSTEM_PROMPT,
  RESEARCHER_TOOLS,
} from "../../src/agent-registry.js";
import { clearHandoff } from "../../src/handoff.js";
import { generateShortRunId, isValidTaskId } from "../../src/session-naming.js";
import { clearWorkflowState } from "../../src/workflow-state.js";
import type { CoreSessionState, PlanningTarget } from "./context.js";
import { emptyUsage, missingWorkingDirectoryError, textToolResult } from "./context.js";
import { type HumanGateDeps, reapHumanGateForTask } from "./human-gate.js";
import type { PhaseRunnerApi } from "./phase-run.js";
import { abortAndResetRunTracking, type SessionContext } from "./session-state.js";
import type { WorkflowCoreApi } from "./workflow-core.js";

/** Everything the planning capability needs from its host. */
export interface PlanningDeps {
  pi: ExtensionAPI;
  getSessionState: (ctx: SessionContext) => CoreSessionState;
  core: Pick<WorkflowCoreApi, "applyToolGate">;
  runner: Pick<PhaseRunnerApi, "startPlanningRun">;
  humanGateDeps: HumanGateDeps;
}

export function registerPlanningCommand(deps: PlanningDeps): void {
  const { pi, getSessionState, core, humanGateDeps } = deps;

  // ── Slash command: /plan <description> | /plan bd-x ───────────────
  pi.registerCommand("plan", {
    description:
      "Enter planning mode: investigate and write an implementation-ready plan into beads. " +
      'Usage: /plan "description" or /plan bd-x [focus]',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "") {
        ctx.ui.notify(
          'Usage: /plan "description of the work to plan" or /plan bd-x [focus]',
          "error",
        );
        return;
      }

      const state = getSessionState(ctx);
      if (state.gateActive) {
        ctx.ui.notify(
          "A /belayd workflow is active for " +
            state.currentTaskId +
            ". Stop it first (belayd_stop_task) before entering planning mode.",
          "error",
        );
        return;
      }

      const parts = trimmed.split(/\s+/);
      const first = parts[0] ?? "";
      let planningTarget: PlanningTarget;
      if (isValidTaskId(first)) {
        const focus = parts.slice(1).join(" ");
        planningTarget =
          focus !== ""
            ? { kind: "existing", taskId: first, focus }
            : { kind: "existing", taskId: first };
      } else {
        planningTarget = { kind: "new", description: trimmed };
      }

      // Reset any prior implementation gate before entering planning mode.
      abortAndResetRunTracking(state);
      const droppedTaskId = state.currentTaskId;
      state.gateActive = false;
      // A prior human wait belongs to the workflow being dropped. Resolve its
      // gate the same way stop/completion do (bd-152): the `clearWorkflowState`
      // below deletes the only rediscovery path, so clearing the in-memory wait
      // alone would leave the bead gate-blocked in bd/Scotty with no answer
      // channel.
      await reapHumanGateForTask({ ctx, state, beadId: droppedTaskId, deps: humanGateDeps });
      clearWorkflowState({ cwd: ctx.cwd });
      clearHandoff({ cwd: ctx.cwd });

      state.planningActive = true;
      state.planningTarget = planningTarget;
      core.applyToolGate(state);

      const targetLabel =
        planningTarget.kind === "new"
          ? `New plan: ${planningTarget.description}`
          : `Existing bead ${planningTarget.taskId}`;
      const focusSuffix =
        planningTarget.kind === "existing" && planningTarget.focus !== undefined
          ? ` Focus: ${planningTarget.focus}.`
          : "";
      const kickoff =
        planningTarget.kind === "existing"
          ? `Planning for bead \`${planningTarget.taskId}\`. Start by running \`bd show ${planningTarget.taskId}\` to read the current content.${focusSuffix} Clarify any ambiguity with the user first, then write the refined plan back with \`bd update ${planningTarget.taskId} --description=... --design=... --notes=...\`.`
          : `Planning a new bead: ${planningTarget.description}. Investigate the codebase with \`belayd_plan_scout\`/\`belayd_plan_research\`, clarify any ambiguity with the user first, then write the finalized plan into a new bead with \`bd create ...\`.`;
      ctx.ui.notify(targetLabel, "info");
      pi.sendMessage(
        {
          customType: "belayd-plan",
          content: kickoff,
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });
}

/** Register the two planning investigation tools at their original composer position. */
export function registerPlanningTools(deps: PlanningDeps): void {
  const { pi, getSessionState, runner } = deps;

  // ── Planning sub-agent tools ─────────────────────────────────────────
  pi.registerTool({
    name: "belayd_plan_scout",
    label: "Planning scout",
    description: "Fast codebase recon for planning mode. Returns structured findings.",
    parameters: Type.Object({
      task: Type.String({ description: "What to investigate" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const scout = getAgentByShortName("scout");
      if (!scout) {
        return {
          content: [{ type: "text" as const, text: "Scout agent not found." }],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }
      const cwd = ctx.cwd;
      if (cwd === undefined || cwd === "") {
        return textToolResult(missingWorkingDirectoryError("belayd_plan_scout"), 1);
      }
      const runId = generateShortRunId();
      const { sessionName } = runner.startPlanningRun(
        {
          name: scout.name,
          modelClass: scout.modelClass ?? "fast",
          tools: scout.tools.filter((t) => t !== "bash"),
          systemPrompt: scout.systemPrompt,
        },
        "scout",
        params,
        state,
        cwd,
        runId,
        ctx,
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              `belayd_plan_scout run started in the background.\n\n` +
              `Run ID: ${runId}\nSession: ${sessionName}\n` +
              `Wait for the follow-up message before synthesizing.`,
          },
        ],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });

  pi.registerTool({
    name: "belayd_plan_research",
    label: "Planning research",
    description: "Deeper investigation for planning mode. Returns evidence-based findings.",
    parameters: Type.Object({
      task: Type.String({ description: "The research question" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const cwd = ctx.cwd;
      if (cwd === undefined || cwd === "") {
        return textToolResult(missingWorkingDirectoryError("belayd_plan_research"), 1);
      }
      const runId = generateShortRunId();
      const { sessionName } = runner.startPlanningRun(
        {
          name: "belayd-plan-research",
          modelClass: "frontier",
          // Keep bash (research must be able to run CLI tools); strip only bd so
          // planning sub-agents never create or mutate beads. Scout still drops
          // bash to stay strictly read-only.
          tools: RESEARCHER_TOOLS.filter((t) => t !== "bd"),
          systemPrompt: RESEARCHER_SYSTEM_PROMPT,
        },
        "research",
        params,
        state,
        cwd,
        runId,
        ctx,
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              `belayd_plan_research run started in the background.\n\n` +
              `Run ID: ${runId}\nSession: ${sessionName}\n` +
              `Wait for the follow-up message before synthesizing.`,
          },
        ],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });
}
