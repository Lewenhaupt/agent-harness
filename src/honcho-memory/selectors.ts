/**
 * Honcho memory selectors — pure derivation from session names/prompts.
 *
 * The harness names sub-agent sessions `belayd-<taskId>-sub-<phase>-<runId>`
 * and planning sessions `belayd-planning-sub-<phase>-<runId>`. These helpers
 * map those names into Honcho session ids, phase hints, and search queries
 * without any I/O so they stay trivially testable.
 */

const SESSION_ID_SUB_PATTERN = /^belayd-(.+?)-sub-(.+)$/;
const SESSION_ID_PLANNING_PATTERN = /^belayd-planning-sub-(.+)$/;
const SUB_PHASE_PATTERN = /-sub-([a-z0-9-]+)-/;
const PLANNING_PHASE_PATTERN = /^belayd-planning-sub-([a-z0-9-]+)-/;

/** Truncate `prompt` to `maxChars` (default 500) without splitting words mid-air. */
function truncatePrompt(prompt: string, maxChars: number): string {
  if (prompt.length <= maxChars) return prompt;
  const head = prompt.slice(0, maxChars);
  const lastSpace = head.lastIndexOf(" ");
  return `${lastSpace > 0 ? head.slice(0, lastSpace) : head}…`;
}

/**
 * Map a session name to a Honcho session id.
 *
 * - `belayd-<taskId>-sub-<phase>-<runId>` → `<taskId>` (memory is shared across
 *   all sub-agents working the same task).
 * - `belayd-planning-sub-<phase>-<runId>` → `planning`.
 * - anything else → the raw session name.
 */
export function deriveSessionId(sessionName: string): string {
  const planning = SESSION_ID_PLANNING_PATTERN.exec(sessionName);
  if (planning !== null) return "planning";

  const sub = SESSION_ID_SUB_PATTERN.exec(sessionName);
  const subTaskId = sub?.[1];
  if (subTaskId !== undefined) return subTaskId;

  return sessionName;
}

/**
 * Extract the phase name from a session name.
 *
 * `belayd-<taskId>-sub-<phase>-<runId>` → `<phase>`;
 * `belayd-planning-sub-<phase>-<runId>` → `<phase>`; otherwise undefined.
 */
export function derivePhaseName(sessionName: string): string | undefined {
  const sub = SUB_PHASE_PATTERN.exec(sessionName);
  const subPhase = sub?.[1];
  if (subPhase !== undefined) return subPhase;

  const planning = PLANNING_PHASE_PATTERN.exec(sessionName);
  const planningPhase = planning?.[1];
  if (planningPhase !== undefined) return planningPhase;

  return undefined;
}

/**
 * True when the session name is a Belayd sub-agent session (implementation or
 * planning). This guards the write path so only sub-agent output is recorded.
 */
export function isBelaydSubAgentSession(sessionName: string): boolean {
  return sessionName.includes("-sub-");
}

/**
 * Build a Honcho memory search query from the prompt, agent, and session.
 * The prompt is truncated (Honcho search works best on short queries) and
 * augmented with phase/agent hints so retrieval skews toward the current
 * work rather than stale cross-task context.
 */
export function buildMemoryQuery(prompt: string, agentName: string, sessionName: string): string {
  const truncated = truncatePrompt(prompt, 500);
  const phase = derivePhaseName(sessionName);
  const hints = [
    agentName !== "" ? `agent:${agentName}` : "",
    phase !== undefined ? `phase:${phase}` : "",
  ].filter((hint) => hint !== "");

  if (hints.length === 0) return truncated;
  return `${truncated}\n${hints.join(" ")}`;
}

/** Pull the flat list of value containers out of a Honcho payload. */
function collectContainers(root: Record<string, unknown>): unknown[] {
  const containers: unknown[] = [];
  for (const key of ["sessions", "context", "representations", "messages"]) {
    const value = root[key];
    if (Array.isArray(value)) {
      containers.push(...value);
    } else if (value !== undefined && value !== null) {
      containers.push(value);
    }
  }
  return containers;
}

/** Extract a content string from one container record, if present. */
function contentOf(record: Record<string, unknown>): string | undefined {
  for (const key of ["content", "text", "representation"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** Convert one collected container into a content line, if it has content. */
function lineOfContainer(container: unknown): string | undefined {
  if (typeof container === "string") {
    const trimmed = container.trim();
    return trimmed !== "" ? trimmed : undefined;
  }
  if (typeof container !== "object" || container === null) return undefined;

  const record = container as Record<string, unknown>;
  const labels = labelsOf(record);
  const content = contentOf(record);
  if (content === undefined) return undefined;
  return labels !== "" ? `[${labels}] ${content}` : content;
}

/** Extract label fields from one container record. */
function labelsOf(record: Record<string, unknown>): string {
  const labels: string[] = [];
  for (const key of ["phase", "agent", "peer_id", "peerId", "role"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      labels.push(`${key}: ${value}`);
    }
  }
  return labels.join(", ");
}

/**
 * Narrow a raw Honcho context/representation payload into a markdown block.
 * Returns undefined for empty, absent, or unrecognized shapes — never throws.
 */
export function formatMemoryContext(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;

  const root = raw as Record<string, unknown>;
  const lines: string[] = [];

  // Honcho's /context endpoint returns { summary?: string, sessions?: [...],
  // context?: [...], representations?: [...] } in different v3 shapes.
  const summary = root.summary;
  if (typeof summary === "string" && summary.trim() !== "") {
    lines.push(summary.trim());
  }

  for (const container of collectContainers(root)) {
    const line = lineOfContainer(container);
    if (line !== undefined) lines.push(line);
  }

  if (lines.length === 0) return undefined;
  return `\`\`\`honcho-memory\n${lines.join("\n\n")}\n\`\`\``;
}
