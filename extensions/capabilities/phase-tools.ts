/**
 * Phase tools capability (bd-179): the per-agent phase tools and `belayd_status`.
 *
 * One tool per default agent (minus the committer, whose tool is registered by
 * the commit capability), each of which starts a background phase run and returns
 * its handle. The ownership preflight runs first: a session that does not own the
 * worktree must not spawn a phase run into it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_AGENTS, getPhaseToolName } from "../../src/agent-registry.js";
import { listRuns, type RunManifest, runBelongsToTask } from "../../src/run-manifest.js";
import { generateShortRunId } from "../../src/session-naming.js";
import type { CoreSessionState } from "./context.js";
import { emptyUsage, missingWorkingDirectoryError, textToolResult } from "./context.js";
import type { PhaseRunnerApi } from "./phase-run.js";
import { formatActiveRunsSection, type SessionStateStore } from "./session-state.js";
import type { WorkflowCoreApi } from "./workflow-core.js";

/** Agent short name → phase name. */
const AGENT_TO_PHASE: Record<string, string> = {
  "belayd-planner": "plan",
  "belayd-implementer": "implement",
  "belayd-reviewer": "review",
  "belayd-tester": "test",
  "belayd-userguide": "userguide",
  "belayd-proof-generator": "proof",
  "belayd-committer": "commit",
};

/** Everything the agent phase tools need from their host. */
export interface AgentPhaseToolsDeps {
  pi: ExtensionAPI;
  getSessionState: SessionStateStore<CoreSessionState>;
  core: Pick<
    WorkflowCoreApi,
    "activeWorkflowOwnership" | "adoptWorktreeTaskId" | "missingTaskIdError"
  >;
  runner: Pick<PhaseRunnerApi, "startPhaseRun">;
}

/** Everything `belayd_status` needs from its host. */
export interface StatusToolDeps {
  pi: ExtensionAPI;
  getSessionState: SessionStateStore<CoreSessionState>;
  core: Pick<WorkflowCoreApi, "formatWorkflowStatusSection">;
  /** Bead ownership/human columns; injected from the fleet capability. */
  readBeadOwnership: (taskId: string, cwd: string) => Promise<string | undefined>;
}

export function registerAgentPhaseTools(deps: AgentPhaseToolsDeps): void {
  const { pi, getSessionState, core, runner } = deps;

  // ── Register agent tools ────────────────────────────────────────────
  for (const agent of DEFAULT_AGENTS) {
    if (agent.name === "belayd-committer") continue;
    const phaseName = AGENT_TO_PHASE[agent.name] ?? agent.name.replace("belayd-", "");
    const toolName = getPhaseToolName(phaseName);
    pi.registerTool({
      name: toolName,
      label: agent.description,
      description: agent.description,
      parameters: Type.Object({
        task: Type.String({ description: "Task to delegate to this agent" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = getSessionState(ctx);
        const cwd = ctx.cwd;
        if (cwd === undefined || cwd === "") {
          return textToolResult(missingWorkingDirectoryError("Belayd phase run"), 1);
        }
        core.adoptWorktreeTaskId(state, cwd);
        const ownership = core.activeWorkflowOwnership(state, cwd);
        if (!ownership.ok) return textToolResult(ownership.error, 1);
        if (state.currentTaskId === "") {
          return textToolResult(core.missingTaskIdError(toolName, cwd), 1);
        }
        const runId = generateShortRunId();
        const { sessionName, ledgerWarning } = runner.startPhaseRun({
          agent,
          phaseName,
          params,
          state,
          cwd,
          worktreeBranch: ownership.branch,
          runId,
          ctx,
        });
        const ledgerNotice = ledgerWarning === undefined ? "" : `\n\n⚠️ ${ledgerWarning}`;
        return {
          content: [
            {
              type: "text" as const,
              text:
                `belayd ${phaseName} run started in the background.\n\n` +
                `Run ID: ${runId}\nSession: ${sessionName}\n` +
                `The result will be delivered as a follow-up message when the run (and its quality gate) completes.\n` +
                `Wait for the follow-up — do NOT call belayd_status on your own initiative.` +
                ` Only call belayd_status if the user explicitly asks you to.` +
                `\nDo not re-call this phase tool — the run is already in progress.` +
                ledgerNotice,
            },
          ],
          details: { messages: [], usage: emptyUsage(), exitCode: 0 },
        };
      },
    });
  }
}

/**
 * One line naming the manifests another bead wrote into the shared run rows
 * (bd-242).
 *
 * They are reported rather than silently dropped: an operator looking at run
 * history should see why a run they remember is not there, and see that the row
 * belongs to another bead.
 */
function formatForeignRunsNotice(foreign: readonly RunManifest[]): string {
  const taskIds = [...new Set(foreign.map((run) => run.taskId))].sort();
  return (
    `**Foreign runs ignored** — ${foreign.length} manifest(s) in the repository's run rows ` +
    `belong to another task (${taskIds.join(", ")}); another bead's state, not this session's history.`
  );
}

/**
 * The run-history sections for this session's bead, plus the notices for the
 * manifests it cannot claim.
 *
 * The run rows are shared by every worktree of the repository, so the table must
 * be this bead's runs only (bd-242). With no task id nothing can be attributed —
 * and the pre-start window is exactly where another bead's rows would otherwise be
 * presented as this session's history — so the manifests are named as
 * unattributable instead of listed.
 */
function formatRunHistorySections(taskId: string, runs: readonly RunManifest[]): string[] {
  if (taskId === "") return runs.length === 0 ? [] : [formatUnattributedRunsNotice(runs)];
  const ownRuns = runs.filter((run) => runBelongsToTask(run, taskId));
  const foreignRuns = runs.filter((run) => !runBelongsToTask(run, taskId));
  const sections: string[] = [];
  if (ownRuns.length > 0) {
    const lines = ["**Run history**", ""];
    lines.push("| runId | phase | status | startedAt | exitCode | model |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const run of ownRuns) {
      lines.push(
        `| \`${run.runId}\` | ${run.phase} | ${run.status} | ${new Date(run.startedAt).toISOString()} | ${run.exitCode ?? ""} | ${run.model ?? ""} |`,
      );
    }
    sections.push(lines.join("\n"));
  }
  if (foreignRuns.length > 0) sections.push(formatForeignRunsNotice(foreignRuns));
  return sections;
}

/**
 * Notice for a runs directory with no bead to attribute it to (bd-242).
 *
 * They are not dropped silently: the count tells an operator the directory holds
 * manifests, and the reason says why none of them is shown as history.
 */
function formatUnattributedRunsNotice(runs: readonly RunManifest[]): string {
  return (
    `**Run history not shown** — no task id is recorded, so the ${runs.length} manifest(s) in ` +
    "the repository's run rows cannot be attributed to this session."
  );
}

/** Register `belayd_status` at its original composer position. */
export function registerStatusTool(deps: StatusToolDeps): void {
  const { pi, getSessionState, core, readBeadOwnership } = deps;

  // ── Register status tool ─────────────────────────────────────────────
  pi.registerTool({
    name: "belayd_status",
    label: "Belayd Status",
    description:
      "Show Belayd process state, active background runs, run history, and — when a task id " +
      "is recorded — that bead's owner, assignee, human flag, update time, comment " +
      "count, human-gate wait and newest comment. Reads only: no writes, no phase runs.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const sections: string[] = [core.formatWorkflowStatusSection(state)];

      // Ownership/human columns for the bead this session drives (bd-153).
      // Read-only and best-effort: bd may be absent, and a gated session must
      // still be able to ask "what am I blocked on", so a failure renders one
      // bounded line instead of failing the tool.
      const ownership = await readBeadOwnership(state.currentTaskId, cwd);
      if (ownership !== undefined) sections.push(ownership);

      // Leftovers from the caller's own directory are reported instead of lost
      // when a handed-off session resumes (bd-120).
      if (state.handoffPendingNotice !== undefined) {
        sections.push(`**Pending items from the handoff** — ${state.handoffPendingNotice}`);
      }

      sections.push(formatActiveRunsSection(state.activeRuns));
      sections.push(...formatRunHistorySections(state.currentTaskId, listRuns({ cwd })));

      return {
        content: [{ type: "text" as const, text: sections.join("\n\n") }],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });
}
