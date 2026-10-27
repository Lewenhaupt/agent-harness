/**
 * Per-role tool surfaces.
 *
 * Every tool a session declares is sent to the model on every request, and a
 * larger catalog measurably hurts tool choice: DeepSeek's own scaffold
 * benchmark on identical weights scores a 12-tool minimal scaffold above a
 * full-featured one, and Anthropic's tool-search guidance puts the deferred-
 * loading threshold at ~10 tools / ~10k tokens of definitions. This module
 * computes the smallest surface each role actually needs, so the process gate
 * does not hand a feature workflow the fleet supervisor's mailbox tools.
 *
 * The sets are pure data plus one builder per role, so a test can assert their
 * exact contents instead of trusting a list that drifts in `extensions/index.ts`.
 */

/** Tools a workflow orchestrator always keeps, independent of workflow type.
 *
 * `belayd_start_task` and `belayd_stop_planning` are deliberately absent: a gated
 * session is already inside a task, and planning mode is a separate mode. Starting
 * another task mid-workflow would need a stop first, so declaring the tool only
 * invites a mode switch the gate would then have to refuse.
 *
 * `belayd_ask_human` is here (bd-152) because the control set is the documented
 * reason a gated session sees a tool at all: the one moment the orchestrator is
 * blocked on a human decision is exactly the moment it needs this tool, and a
 * workflow-gated surface would otherwise deny it.
 */
export const WORKFLOW_CONTROL_TOOLS: readonly string[] = [
  "belayd_start_followup",
  "belayd_stack_rebase",
  "belayd_stop_task",
  "belayd_status",
  "belayd_ask_human",
  "belayd_doctor",
  "belayd_proof_verifier",
  "bd",
  "read",
  "grep",
  "find",
  "ls",
];

/**
 * Read-only consult tools that stay callable during a workflow but are never a
 * required step. Kept out of the phase list on purpose: they do not gate
 * progress and do not advance completion.
 */
export const CONSULT_TOOLS: readonly string[] = ["belayd_outline", "belayd_archify"];

/**
 * Fleet tools a *member* orchestrator may need while its own process gate is
 * active: read the fleet state, read its mailbox, and send a note back. These
 * stay in the gated surface because a member that cannot see fleet state cannot
 * react to a pause or a merge-queue change.
 */
export const MEMBER_FLEET_TOOLS: readonly string[] = [
  "belayd_fleet_status",
  "belayd_fleet_inbox",
  "belayd_fleet_note",
];

/**
 * Supervisor-only fleet tools: launch, merge queue, pause/resume/advance, and
 * crash reconcile. The supervisor session arms no process gate, so a gated
 * member declaring these only pays for nine schemas it must never call — they
 * were in every gated session before this split.
 */
export const SUPERVISOR_FLEET_TOOLS: readonly string[] = [
  "belayd_fleet_launch",
  "belayd_fleet_merge",
  "belayd_fleet_pause",
  "belayd_fleet_resume",
  "belayd_fleet_advance",
  "belayd_fleet_reconcile",
  "belayd_fleet_release",
];

/** Every fleet tool, for the contract audit. */
export const FLEET_TOOLS: readonly string[] = [...MEMBER_FLEET_TOOLS, ...SUPERVISOR_FLEET_TOOLS];

/** Planning mode: investigation plus plan writing, no repository writes. */
export const PLANNING_TOOL_SET: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "ast_grep",
  "bd",
  "ask_user",
  "web_search_exa",
  "web_fetch_exa",
  "deep_search_exa",
  "web_search_advanced_exa",
  "describe_image",
  "belayd_plan_scout",
  "belayd_plan_research",
  "belayd_status",
  "belayd_doctor",
  "belayd_stop_planning",
];

/** Input for {@link workflowGateToolSet}. */
export interface WorkflowToolSetInput {
  /** Required phase names for the workflow (e.g. `["implement", "review", ...]`). */
  phases: readonly string[];
  /** Phases whose tools stay callable without gating progress. */
  consultPhases?: readonly string[];
}

/**
 * The gated surface for one workflow: its own phase tools (required and
 * consult), the control tools, the read-only consult tools, and nothing else.
 *
 * A phase tool the workflow never runs is omitted, so a bugfix session is not
 * offered `belayd_userguide`, and no session is offered `belayd_documenter`
 * (registered by the agent loop but absent from every phase order).
 */
export function workflowGateToolSet(input: WorkflowToolSetInput): string[] {
  const phaseTools = [...input.phases, ...(input.consultPhases ?? [])].map(
    (phase) => `belayd_${phase}`,
  );
  return dedupe([
    ...phaseTools,
    ...WORKFLOW_CONTROL_TOOLS,
    ...MEMBER_FLEET_TOOLS,
    ...CONSULT_TOOLS,
  ]);
}

/** Number of declared tools, the value the budget claim is stated against. */
export function toolSetSize(tools: readonly string[]): number {
  return dedupe(tools).length;
}

function dedupe(tools: readonly string[]): string[] {
  return [...new Set(tools)];
}
