/**
 * Append-only metrics event log (bd-140, phase 1).
 *
 * The harness can price a phase but cannot say whether it *worked*: gate
 * outcomes live in a run manifest that is a resume mechanism (one file survives),
 * session transcripts grow to hundreds of megabytes, and `.belayd/` is
 * per-worktree. This module is the durable record behind questions like "does
 * `userguide` earn its keep" — one JSON object per line, host-level, append-only.
 *
 * Shape decisions:
 * - **JSONL, not a database.** Fleet members run concurrently under one uid and
 *   DuckDB is a single-writer engine; a native duckdb client would also move the
 *   flake's pnpm hash. Appending one line is permission-free and crash-safe, and
 *   DuckDB reads the files directly (`read_json_auto`).
 * - **Host-level, not per-worktree.** Worktrees are merged and deleted, so a
 *   record kept inside one is lost with it.
 * - **Best effort.** A metrics failure must never fail a phase; writers return a
 *   result instead of throwing.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";

/** Override the metrics directory (tests, alternate reporting). */
export const METRICS_DIR_ENV = "BELAYD_METRICS_DIR";

/** `BELAYD_METRICS=0` disables the log without touching the filesystem. */
export const METRICS_ENABLED_ENV = "BELAYD_METRICS";

/** Fields every event carries. */
export interface MetricsEventBase {
  /** Epoch milliseconds. */
  ts: number;
  /** Hostname, so several machines can share one report without ambiguity. */
  host: string;
  /**
   * Where the event came from. Absent means live; `backfill` marks history
   * reconstructed from recorded sessions (bd-140 phase 3), which has no gate
   * verdicts and an unknown workflow type.
   */
  source?: "live" | "backfill";
}

/** A phase run started (one spawn, before any gate attempt). */
export interface RunStartEvent extends MetricsEventBase {
  event: "run_start";
  task: string;
  phase: string;
  runId: string;
  workflowType: string;
  model: string;
  session?: string;
}

/** One gate evaluation, including retries. */
export interface GateResultEvent extends MetricsEventBase {
  event: "gate_result";
  task: string;
  phase: string;
  /** Ties a verdict to the spawn that produced the output being judged. */
  runId: string;
  /** 1-based gate attempt; attempt 1 is the first-pass signal. */
  attempt: number;
  passed: boolean;
  durationMs: number;
  /** Short failure classification, when the gate reported one. */
  failureKind?: string;
}

/** A phase run settled (success or failure), with its cost. */
export interface RunEndEvent extends MetricsEventBase {
  event: "run_end";
  task: string;
  phase: string;
  runId: string;
  status: string;
  exitCode: number;
  toolCalls: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  wallMs: number;
  model?: string;
}

/** A completed phase advanced the workflow. */
export interface PhaseAdvanceEvent extends MetricsEventBase {
  event: "phase_advance";
  task: string;
  phase: string;
  nextPhase: string;
}

/** A review delivery, counted by severity — the "are reviews finding anything" signal. */
export interface ReviewFindingsEvent extends MetricsEventBase {
  event: "review_findings";
  task: string;
  critical: number;
  warnings: number;
  suggestions: number;
}

/** Any event in the log. */
export type MetricsEvent =
  | RunStartEvent
  | GateResultEvent
  | RunEndEvent
  | PhaseAdvanceEvent
  | ReviewFindingsEvent;

/** Environment lookup, injected so the resolution stays pure. */
export interface MetricsEnv {
  env: Record<string, string | undefined>;
  /** Injectable so tests do not depend on the hostname. */
  hostname?: () => string;
}

/**
 * Resolve the metrics directory, or undefined when the log is disabled.
 *
 * Default `${XDG_STATE_HOME:-~/.local/state}/belayd/metrics` — the same XDG state
 * root the proof artifacts use, so a host has one state tree to back up or
 * delete.
 */
export function resolveMetricsDir(options: MetricsEnv): string | undefined {
  const { env } = options;
  if (isDisabled(env[METRICS_ENABLED_ENV])) return undefined;
  const override = nonEmpty(env[METRICS_DIR_ENV]);
  if (override !== undefined) return override;
  const xdgStateHome = nonEmpty(env.XDG_STATE_HOME);
  const stateHome = xdgStateHome ?? join(homedir(), ".local", "state");
  return join(stateHome, "belayd", "metrics");
}

/** Monthly file name, so a year of events never becomes one unbounded file. */
export function metricsFilePath(options: { dir: string; now: number }): string {
  const date = new Date(options.now);
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(options.dir, `events-${month}.jsonl`);
}

/** Result of an append attempt. */
export type MetricsAppendResult =
  | { ok: true; path: string }
  | { ok: false; error: string; disabled?: boolean };

/**
 * Append one event as a JSON line.
 *
 * Returns a result instead of throwing: the caller sits inside a phase
 * lifecycle, where a metrics write must never be able to fail the run.
 */
export function appendMetricsEvent(
  options: MetricsEnv & { event: MetricsEvent; now?: number },
): MetricsAppendResult {
  const dir = resolveMetricsDir(options);
  if (dir === undefined) return { ok: false, error: "metrics disabled", disabled: true };
  const path = metricsFilePath({ dir, now: options.now ?? options.event.ts });
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(options.event)}\n`, "utf8");
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Hostname stamp; never throws, because the caller is mid-phase. */
export function metricsHostname(options?: { hostname?: () => string }): string {
  const lookup = options?.hostname ?? osHostname;
  try {
    return lookup() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Input for {@link buildRunStartEvent}. */
export interface RunStartInput {
  now: number;
  host: string;
  task: string;
  phase: string;
  runId: string;
  workflowType: string;
  model: string;
  session?: string;
}

/** A spawn began. */
export function buildRunStartEvent(input: RunStartInput): RunStartEvent {
  return {
    event: "run_start",
    ts: input.now,
    host: input.host,
    task: input.task,
    phase: input.phase,
    runId: input.runId,
    workflowType: input.workflowType,
    model: input.model,
    ...(input.session === undefined ? {} : { session: input.session }),
  };
}

/** Input for {@link buildGateResultEvent}. */
export interface GateResultInput {
  now: number;
  host: string;
  task: string;
  phase: string;
  runId: string;
  attempt: number;
  passed: boolean;
  durationMs: number;
  failureKind?: string;
}

/** One gate verdict. */
export function buildGateResultEvent(input: GateResultInput): GateResultEvent {
  return {
    event: "gate_result",
    ts: input.now,
    host: input.host,
    task: input.task,
    phase: input.phase,
    runId: input.runId,
    attempt: input.attempt,
    passed: input.passed,
    durationMs: input.durationMs,
    ...(input.failureKind === undefined ? {} : { failureKind: input.failureKind }),
  };
}

/** Input for {@link buildRunEndEvent}. */
export interface RunEndInput {
  now: number;
  host: string;
  task: string;
  phase: string;
  runId: string;
  status: string;
  exitCode: number;
  toolCalls: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  wallMs: number;
  model?: string;
}

/** A run settled with its cost. */
export function buildRunEndEvent(input: RunEndInput): RunEndEvent {
  return {
    event: "run_end",
    ts: input.now,
    host: input.host,
    task: input.task,
    phase: input.phase,
    runId: input.runId,
    status: input.status,
    exitCode: input.exitCode,
    toolCalls: input.toolCalls,
    cost: input.cost,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    tokensCacheRead: input.tokensCacheRead,
    wallMs: input.wallMs,
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

/** Input for {@link buildPhaseAdvanceEvent}. */
export interface PhaseAdvanceInput {
  now: number;
  host: string;
  task: string;
  phase: string;
  nextPhase: string;
}

/** A completed phase advanced the workflow. */
export function buildPhaseAdvanceEvent(input: PhaseAdvanceInput): PhaseAdvanceEvent {
  return {
    event: "phase_advance",
    ts: input.now,
    host: input.host,
    task: input.task,
    phase: input.phase,
    nextPhase: input.nextPhase,
  };
}

/** Input for {@link buildReviewFindingsEvent}. */
export interface ReviewFindingsInput {
  now: number;
  host: string;
  task: string;
  critical: number;
  warnings: number;
  suggestions: number;
}

/** Severity counts from one review delivery. */
export function buildReviewFindingsEvent(input: ReviewFindingsInput): ReviewFindingsEvent {
  return {
    event: "review_findings",
    ts: input.now,
    host: input.host,
    task: input.task,
    critical: input.critical,
    warnings: input.warnings,
    suggestions: input.suggestions,
  };
}

function isDisabled(value: string | undefined): boolean {
  const normalized = nonEmpty(value)?.toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
