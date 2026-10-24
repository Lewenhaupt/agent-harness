/**
 * Tool-surface auditing for the harness.
 *
 * Every harness session declares a tool set to the model, and every agent
 * definition carries an allowlist. The two drift silently: pi does not reject an
 * unknown `--tools` name, so an allowlist entry for a tool the loaded extension
 * set never registered is dropped without a word. That is how `ast_grep` ended
 * up in AGENTS.md, in eight agent allowlists, and in no orchestrator session.
 *
 * These functions are pure so the audit can be tested without a live session;
 * `belayd_doctor` adapts pi's `getAllTools()` output into them.
 */

import { ALL_PHASE_TOOLS } from "./process-gate.js";

/** The part of an agent definition the audit needs. */
export interface AgentToolSpec {
  name: string;
  tools: readonly string[];
}

/** An agent whose allowlist names tools the session cannot declare. */
export interface ToolAuditRow {
  agent: string;
  missing: string[];
}

/**
 * Tools the harness expects to come from outside its own registration calls.
 *
 * Kept here (not inferred) so the audit can distinguish "this extension set is
 * missing `ast_grep`" from "the harness never registers this name on purpose".
 * Names absent from both this list and the declared set are reported as
 * missing — that is the signal worth acting on.
 */
export const EXTERNAL_TOOL_NAMES: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "ast_grep",
  "agent_browser",
  "agent_browser_code",
  "agent_browser_tools",
  "web_search_exa",
  "web_fetch_exa",
  "deep_search_exa",
  "web_search_advanced_exa",
  "describe_image",
  "ask_user",
  "spawn_session",
  "spawn_subsession",
  "list_subsessions",
  "check_subsession",
  "read_subsession",
  "yield_to_subsessions",
];

/**
 * Compare each agent's allowlist against the tools the session actually
 * declares. Agents with no gap are omitted, so an empty result means the
 * surface is coherent.
 */
export function auditAgentTools(
  agents: readonly AgentToolSpec[],
  declared: Iterable<string>,
): ToolAuditRow[] {
  const available = new Set(declared);
  const rows: ToolAuditRow[] = [];
  for (const agent of agents) {
    const missing = agent.tools.filter((tool) => !available.has(tool));
    if (missing.length > 0) rows.push({ agent: agent.name, missing });
  }
  return rows;
}

/**
 * Every tool name the harness itself registers, independent of what a given
 * session actually loaded.
 *
 * The distinction matters for the audit: a session can legitimately declare
 * fewer tools (a workflow gate, a planning gate, or an explicit `--tools`
 * list), but an allowlist entry naming a tool that exists in *no* harness build
 * is a typo. Comparing against the live catalog alone cannot tell those apart —
 * the first doctor run reported `belayd_outline` as a typo because the smoke
 * session had been started with `--tools read,belayd_doctor`.
 *
 * Phase tool names come from `ALL_PHASE_TOOLS` so the two cannot drift.
 */
export const HARNESS_TOOL_NAMES: readonly string[] = [
  ...ALL_PHASE_TOOLS,
  "bd",
  "belayd_archify",
  "belayd_commit",
  "belayd_doctor",
  "belayd_documenter",
  "belayd_fleet_advance",
  "belayd_fleet_inbox",
  "belayd_fleet_launch",
  "belayd_fleet_merge",
  "belayd_fleet_note",
  "belayd_fleet_pause",
  "belayd_fleet_reconcile",
  "belayd_fleet_resume",
  "belayd_fleet_status",
  "belayd_outline",
  "belayd_plan_research",
  "belayd_plan_scout",
  "belayd_proof_verifier",
  "belayd_stack_rebase",
  "belayd_start_followup",
  "belayd_start_task",
  "belayd_status",
  "belayd_stop_planning",
  "belayd_stop_task",
];

/**
 * Allowlist entries that exist in no harness build and are not external tools —
 * usually a typo or a removed tool in an agent definition.
 */
export function unknownAllowlistTools(
  agents: readonly AgentToolSpec[],
  known: Iterable<string> = [...HARNESS_TOOL_NAMES, ...EXTERNAL_TOOL_NAMES],
): ToolAuditRow[] {
  const knownNames = new Set(known);
  const rows: ToolAuditRow[] = [];
  for (const agent of agents) {
    const unknown = agent.tools.filter((tool) => !knownNames.has(tool));
    if (unknown.length > 0) rows.push({ agent: agent.name, missing: unknown });
  }
  return rows;
}

/** The subset of pi's `ToolInfo` the estimate needs. */
export interface ToolSchemaLike {
  name: string;
  description?: string;
  parameters?: unknown;
  source?: string;
}

/** Estimated cost of one declared tool definition. */
export interface ToolTokenEstimate {
  name: string;
  source: string;
  tokens: number;
}

/** Declared-tool cost, per tool and rolled up per source. */
export interface ToolTokenReport {
  rows: ToolTokenEstimate[];
  total: number;
  bySource: Array<{ source: string; count: number; tokens: number }>;
}

/**
 * Estimate the prompt cost of declared tool definitions.
 *
 * pi sends each tool's name, description, and parameter schema on every
 * request, so the catalog is a per-turn cost, not a one-off. `chars / 4` is the
 * same rough ratio used for the prompt sections; it is deliberately labelled an
 * estimate — the provider's tokenizer is the only authority.
 */
export function estimateToolTokens(tools: readonly ToolSchemaLike[]): ToolTokenReport {
  const rows: ToolTokenEstimate[] = tools.map((tool) => ({
    name: tool.name,
    source: tool.source ?? "unknown",
    tokens: estimateSchemaTokens(tool),
  }));
  const perSource = new Map<string, { count: number; tokens: number }>();
  for (const row of rows) {
    const entry = perSource.get(row.source) ?? { count: 0, tokens: 0 };
    entry.count += 1;
    entry.tokens += row.tokens;
    perSource.set(row.source, entry);
  }
  return {
    rows: rows.sort((left, right) => right.tokens - left.tokens),
    total: rows.reduce((sum, row) => sum + row.tokens, 0),
    bySource: [...perSource.entries()]
      .map(([source, entry]) => ({ source, count: entry.count, tokens: entry.tokens }))
      .sort((left, right) => right.tokens - left.tokens),
  };
}

/** Estimate one tool definition's tokens from its serialized schema. */
export function estimateSchemaTokens(tool: ToolSchemaLike): number {
  const payload = JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
  });
  return Math.ceil(payload.length / 4);
}

/** One declared tool plus where it came from, as the doctor reports it. */
export interface DoctorTool extends ToolSchemaLike {
  sourcePath?: string;
  scope?: string;
}

/** Everything `belayd_doctor` needs, gathered by the extension. */
export interface DoctorInput {
  /** Which harness role this session is running as. */
  role: string;
  /** Where the running pi install lives (`PI_PACKAGE_DIR`), when it reports one. */
  runningInstall: string | undefined;
  /** Agent directory (`PI_CODING_AGENT_DIR`). */
  agentDir: string | undefined;
  /** True when the session is hosted by pi-web's bundled SDK. */
  piWebSession: boolean;
  env: {
    belaydPiBinary: string | undefined;
    piBinaryPath: string | undefined;
  };
  /** Binary resolution for *spawned* agents. */
  spawnedBinary: {
    binary: string | undefined;
    source: string;
    fellBack: boolean;
    candidates: readonly string[];
  };
  /** Every tool registered in this session. */
  tools: readonly DoctorTool[];
  /** Tools actually declared to the model right now. */
  activeTools: readonly string[];
  /** Agent definitions whose allowlists are audited. */
  agents: readonly AgentToolSpec[];
}

/**
 * Render the doctor report.
 *
 * The report exists to answer one question in one place: *which tool surface
 * did this session actually get, and does it match the agent contract?* Every
 * section is therefore evidence (paths, counts, names), never advice. The
 * sections are separate pure helpers so each stays inside the complexity budget
 * and can be asserted independently.
 */
export function formatDoctorReport(input: DoctorInput): string {
  return [
    formatRuntimeSection(input),
    formatSpawnedBinarySection(input.spawnedBinary),
    formatToolCatalogSection(input),
    formatAllowlistSection(input),
  ].join("\n");
}

function formatRuntimeSection(input: DoctorInput): string {
  return [
    "**Runtime**",
    `- role: ${input.role}`,
    `- running pi install: ${input.runningInstall ?? "(none reported — pi-web bundled SDK)"}`,
    `- pi-web session: ${input.piWebSession ? "yes" : "no"}`,
    `- agent dir: ${input.agentDir ?? "(unset)"}`,
  ].join("\n");
}

function formatSpawnedBinarySection(spawned: DoctorInput["spawnedBinary"]): string {
  const lines = ["**Spawned-agent binary**"];
  lines.push(
    spawned.binary === undefined
      ? "- resolved: **(none found)** — spawned agents cannot start"
      : `- resolved: \`${spawned.binary}\` (source: ${spawned.source}${spawned.fellBack ? ", fallback" : ""})`,
  );
  if (spawned.fellBack) {
    lines.push(
      "- ⚠️ not pinned: set `BELAYD_PI_BINARY` or `PI_BINARY_PATH` to fix the extension set spawned agents get",
    );
  }
  if (spawned.candidates.length > 0) {
    lines.push(`- candidates: ${spawned.candidates.map((c) => `\`${c}\``).join(" → ")}`);
  }
  return lines.join("\n");
}

function formatToolCatalogSection(input: DoctorInput): string {
  const report = estimateToolTokens(input.tools);
  const lines = [
    "**Tool catalog**",
    `- declared: ${input.tools.length} tools (~${report.total} tokens per request), active: ${input.activeTools.length}`,
  ];
  for (const row of report.bySource.slice(0, 8)) {
    lines.push(`  - ${row.source}: ${row.count} tools (~${row.tokens} tokens)`);
  }
  const heaviest = report.rows.slice(0, 6);
  if (heaviest.length > 0) {
    lines.push(`- heaviest: ${heaviest.map((row) => `${row.name} ~${row.tokens}`).join(", ")}`);
  }
  return lines.join("\n");
}

function formatAllowlistSection(input: DoctorInput): string {
  const declaredNames = input.tools.map((tool) => tool.name);
  const harnessDeclared = declaredNames.filter((name) => HARNESS_TOOL_NAMES.includes(name)).length;
  const restricted = harnessDeclared < HARNESS_TOOL_NAMES.length;
  const missing = auditAgentTools(input.agents, declaredNames);
  const unknown = unknownAllowlistTools(input.agents, declaredNames);
  const lines = ["**Agent allowlist audit**"];

  if (restricted) {
    lines.push(
      `- ⚠️ this session declares ${harnessDeclared}/${HARNESS_TOOL_NAMES.length} harness tools — an allowlist gap below may be this session's surface (gate or \`--tools\`), not the runtime a spawned agent gets`,
    );
    if (missing.length > 0) {
      const names = missing.map((row) => row.agent.replace("belayd-", "")).join(", ");
      lines.push(
        `- ${missing.length} agent(s) reference tools this session does not declare: ${names}`,
      );
    }
  } else {
    for (const row of missing) lines.push(`- ⚠️ ${row.agent}: missing ${row.missing.join(", ")}`);
  }

  for (const row of unknown) {
    lines.push(`- ⚠️ ${row.agent}: unknown names (typo?) ${row.missing.join(", ")}`);
  }
  if (missing.length === 0 && unknown.length === 0) {
    lines.push("- ✅ every agent allowlist resolves to a declared or external tool");
  }
  return lines.join("\n");
}
