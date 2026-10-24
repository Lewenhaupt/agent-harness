/**
 * Backfill the metrics log from recorded pi sessions (bd-140, phase 3).
 *
 * The live log starts empty on the day it ships. The session corpus already holds
 * what `run_start`/`run_end` need — model, usage, wall time, tool calls — so the
 * reports can open with ~950 sessions of history instead of one row.
 *
 * What cannot be recovered: gate verdicts. A transcript records the agent's work,
 * never the deterministic gate that judged it, so `first_pass_by_phase` only
 * accumulates from live events. `rework_by_phase` covers the same question for
 * history: it counts runs per (task, phase), which is >1 exactly when a phase was
 * retried or re-run.
 */

import type { MetricsEvent, RunEndEvent, RunStartEvent } from "./metrics.js";

/** One parsed pi session entry (only the fields the backfill reads). */
export interface SessionEntry {
  type?: string;
  timestamp?: string;
  /** Present on `message` entries. */
  message?: {
    role?: string;
    model?: string;
    timestamp?: string | number;
    stopReason?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cost?: number | { total?: number };
    };
    content?: Array<{ type?: string; name?: string }>;
  };
}

/** A session name the backfill understands. */
export type BackfillSessionRef =
  | { kind: "phase"; task: string; phase: string; runId: string; epoch?: string }
  | { kind: "planning"; sub: string }
  | { kind: "other" };

const PHASE_SESSION =
  /^belayd-(bd-[\d.]+)-sub-([a-z]+)-([a-z0-9]+)(?:-(retry|run|fallback)-(\d+))?$/;
const PLANNING_SESSION = /^belayd-planning-sub-([a-z]+)-/;

/**
 * Classify a session name.
 *
 * `-retry-N` and `-run-N` are distinct spawns of the same phase, so they count as
 * separate runs. `-fallback-N` is NOT: it is the same run retried on another
 * provider after a quota/rate-limit failure, so counting it as a run inflated
 * `runs_per_task` (implement read 6.1 instead of 1.8) until this was fixed.
 */
export function parseBackfillSessionName(name: string): BackfillSessionRef {
  const phase = PHASE_SESSION.exec(name);
  if (phase !== null) {
    const [, task, phaseName, runId, epochKind, epochNumber] = phase;
    if (task === undefined || phaseName === undefined || runId === undefined) {
      return { kind: "other" };
    }
    return {
      kind: "phase",
      task,
      phase: phaseName,
      runId,
      ...(epochKind === undefined || epochNumber === undefined || epochKind === "fallback"
        ? {}
        : { epoch: `${epochKind}-${epochNumber}` }),
    };
  }
  const planning = PLANNING_SESSION.exec(name);
  if (planning !== null) {
    const sub = planning[1];
    if (sub !== undefined) return { kind: "planning", sub };
  }
  return { kind: "other" };
}

/** Everything the backfill needs from one session file. */
export interface SessionSummary {
  startedAt?: number;
  endedAt?: number;
  model?: string;
  toolCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
  /** `failed` when the final assistant message ended in an error. */
  status: "completed" | "failed";
}

function costOf(usage: NonNullable<NonNullable<SessionEntry["message"]>["usage"]>): number {
  if (typeof usage.cost === "number") return usage.cost;
  if (typeof usage.cost === "object" && usage.cost !== null) return usage.cost.total ?? 0;
  return 0;
}

function timestampOf(entry: SessionEntry): number | undefined {
  const raw = entry.message?.timestamp ?? entry.timestamp;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Fold a session's entries into one summary.
 *
 * Usage accumulates across every assistant message, mirroring how the live log
 * attributes a run: a resumed session's several attempts are one run's cost.
 */
export function summarizeSession(entries: readonly SessionEntry[]): SessionSummary {
  let summary: SessionSummary = {
    toolCalls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cost: 0,
    status: "completed",
  };
  for (const entry of entries) {
    summary = applyTimestamp(summary, timestampOf(entry));
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    summary = accumulateAssistant(summary, message);
  }
  return summary;
}

/** Widen the session window to include `ts`. */
function applyTimestamp(summary: SessionSummary, ts: number | undefined): SessionSummary {
  if (ts === undefined) return summary;
  return { ...summary, startedAt: summary.startedAt ?? ts, endedAt: ts };
}

/** Fold one assistant message's usage, tool calls and outcome into the summary. */
function accumulateAssistant(
  summary: SessionSummary,
  message: NonNullable<SessionEntry["message"]>,
): SessionSummary {
  const usage = message.usage;
  const toolCalls = (message.content ?? []).filter((block) => block.type === "toolCall").length;
  return {
    ...summary,
    ...(message.model === undefined ? {} : { model: message.model }),
    input: summary.input + (usage?.input ?? 0),
    output: summary.output + (usage?.output ?? 0),
    cacheRead: summary.cacheRead + (usage?.cacheRead ?? 0),
    cost: summary.cost + (usage === undefined ? 0 : costOf(usage)),
    toolCalls: summary.toolCalls + toolCalls,
    status: message.stopReason === "error" ? "failed" : summary.status,
  };
}

/** Input for {@link buildBackfillEvents}. */
export interface BackfillInput {
  sessionName: string;
  entries: readonly SessionEntry[];
  host: string;
}

/**
 * Build the events one recorded session contributes.
 *
 * Returns an empty list for sessions the log does not model (orchestrators,
 * interactive sessions): a `run_start` without a phase would only add noise to
 * every per-phase query.
 */
export function buildBackfillEvents(input: BackfillInput): MetricsEvent[] {
  const ref = parseBackfillSessionName(input.sessionName);
  if (ref.kind !== "phase") return [];
  const summary = summarizeSession(input.entries);
  if (summary.startedAt === undefined) return [];
  const endedAt = summary.endedAt ?? summary.startedAt;

  const start: RunStartEvent = {
    event: "run_start",
    ts: summary.startedAt,
    host: input.host,
    task: ref.task,
    phase: ref.phase,
    runId: ref.epoch === undefined ? ref.runId : `${ref.runId}-${ref.epoch}`,
    workflowType: "unknown",
    // Unknown for a session recorded before model tracking was uniform.
    model: summary.model ?? "unknown",
    session: input.sessionName,
    source: "backfill",
  };
  const end: RunEndEvent = {
    event: "run_end",
    ts: endedAt,
    host: input.host,
    task: ref.task,
    phase: ref.phase,
    runId: start.runId,
    status: summary.status,
    exitCode: summary.status === "completed" ? 0 : 1,
    toolCalls: summary.toolCalls,
    cost: summary.cost,
    tokensIn: summary.input,
    tokensOut: summary.output,
    tokensCacheRead: summary.cacheRead,
    wallMs: Math.max(0, endedAt - summary.startedAt),
    ...(summary.model === undefined ? {} : { model: summary.model }),
    source: "backfill",
  };
  return [start, end];
}
