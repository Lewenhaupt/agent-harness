#!/usr/bin/env node
/**
 * Per-turn prompt-cache report from recorded pi sessions.
 *
 * The metrics log records one `run_end` per spawned session, so its
 * `cache_hit_pct` is a session-level average. A long session's steady-state
 * hit rate hides mid-session misses, which are the events that matter when
 * tuning context management. Session transcripts carry a usage object on every
 * assistant message, so this script reconstructs the per-turn view without
 * changing the metrics event schema.
 *
 * A "miss" is a turn after the first whose `cacheRead` is zero: the provider
 * served none of the prompt from its cache. A session with no cache hits at all
 * is reported separately (short or uncached sessions are not called misses).
 * A "shrink" is a large drop in `cacheRead` between turns, which usually means
 * the context was compacted rather than the cache missing.
 *
 * Usage:
 *   node scripts/belayd-cache-bust-report.ts [--top N] [--json]
 *   node scripts/belayd-cache-bust-report.ts --agent-dir /path/to/.pi/agent
 *
 * `PI_CODING_AGENT_DIR` overrides the agent directory, matching the backfill.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type BackfillSessionRef, parseBackfillSessionName } from "../src/metrics-backfill.ts";

/** A `cacheRead` drop this large is treated as a context shrink, not a hit-rate wobble. */
const SHRINK_THRESHOLD_TOKENS = 5_000;
/** Gaps shorter than this cannot be cache TTL expiry on common providers. */
const SHORT_GAP_SECONDS = 60;
/** A turn this much smaller than the previous one looks like compaction. */
const COMPACTION_RATIO = 0.7;

interface UsageRecord {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number | { total?: number };
}

interface SessionRecord {
  timestamp?: string | number;
  message?: {
    role?: string;
    timestamp?: string | number;
    provider?: string;
    model?: string;
    usage?: UsageRecord;
  };
}

interface AssistantTurn {
  ts?: number;
  provider?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  totalTokens: number;
}

interface BustEvent {
  session: string;
  task: string;
  phase: string;
  turn: number;
  gapSeconds?: number;
  uncachedTokens: number;
  cost: number;
  sameProvider: boolean;
  sameModel: boolean;
  compacted: boolean;
}

interface SessionReport {
  session: string;
  task: string;
  phase: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  hitPct: number;
  hasCacheHit: boolean;
  busts: readonly BustEvent[];
  shrinkCount: number;
  shrinkTokens: number;
  models: readonly string[];
}

interface OverallSummary {
  sessions: number;
  sessionsWithBust: number;
  uncachedSessions: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  busts: number;
  bustTokens: number;
  bustCost: number;
  shrinks: number;
  hitPct: number;
}

interface PhaseSummary extends OverallSummary {
  phase: string;
}

interface ContinuitySummary {
  busts: number;
  sameProviderAndModel: number;
  sameModel: number;
  shortGap: number;
  compacted: number;
}

interface Report {
  overall: OverallSummary;
  gapBands: Record<string, number>;
  medianBustGapSeconds?: number;
  continuity: ContinuitySummary;
  phases: readonly PhaseSummary[];
  topBusts: readonly BustEvent[];
  topSessions: readonly SessionReport[];
}

interface Options {
  top: number;
  json: boolean;
  agentDir?: string;
}

type PhaseRef = Extract<BackfillSessionRef, { kind: "phase" }>;

function parseArgs(argv: readonly string[]): Options | { error: string } {
  const topIndex = argv.indexOf("--top");
  const topText = topIndex === -1 ? undefined : argv[topIndex + 1];
  const top = topText === undefined ? 20 : Number.parseInt(topText, 10);
  if (!Number.isFinite(top) || top <= 0) {
    return { error: `invalid --top ${topText ?? ""}` };
  }

  const dirIndex = argv.indexOf("--agent-dir");
  const agentDir = dirIndex === -1 ? undefined : argv[dirIndex + 1];
  if (dirIndex !== -1 && agentDir === undefined) {
    return { error: "--agent-dir requires a path" };
  }

  return {
    top,
    json: argv.includes("--json"),
    ...(agentDir === undefined ? {} : { agentDir }),
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every `sessions/<project>/*.jsonl` path under the agent dir. */
function collectSessionFiles(sessionsRoot: string): string[] {
  const files: string[] = [];
  for (const project of safeReaddir(sessionsRoot)) {
    const projectDir = join(sessionsRoot, project);
    if (!isDirectory(projectDir)) continue;
    for (const file of safeReaddir(projectDir)) {
      if (file.endsWith(".jsonl")) files.push(join(projectDir, file));
    }
  }
  return files;
}

/** `<timestamp>_<sessionName>.jsonl` -> the session name. */
function sessionNameFromFile(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.jsonl$/, "").replace(/^\d{4}-\d\d-\d\dT[\d-]+Z_/, "");
}

function readRecords(file: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch {
      // A truncated trailing line is normal for a crashed session; skip it.
    }
  }
  return records;
}

function timestampOf(raw: string | number | undefined): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function costOf(usage: UsageRecord): number {
  if (typeof usage.cost === "number") return usage.cost;
  if (usage.cost === undefined) return 0;
  return usage.cost.total ?? 0;
}

/** One scorable assistant turn, or undefined when the record has no usable usage. */
function turnFromRecord(record: SessionRecord): AssistantTurn | undefined {
  const message = record.message;
  const usage = message?.usage;
  if (message?.role !== "assistant" || usage === undefined) return undefined;
  if ((usage.totalTokens ?? 0) <= 0) return undefined;

  const ts = timestampOf(message.timestamp ?? record.timestamp);
  return {
    ...(ts === undefined ? {} : { ts }),
    ...(message.provider === undefined ? {} : { provider: message.provider }),
    ...(message.model === undefined ? {} : { model: message.model }),
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: costOf(usage),
    totalTokens: usage.totalTokens ?? 0,
  };
}

/** Assistant turns that carry usage; a usage-less turn cannot be scored. */
function assistantTurns(records: readonly SessionRecord[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  for (const record of records) {
    const turn = turnFromRecord(record);
    if (turn !== undefined) turns.push(turn);
  }
  return turns;
}

function gapSecondsBetween(previous: AssistantTurn, next: AssistantTurn): number | undefined {
  if (previous.ts === undefined || next.ts === undefined) return undefined;
  return Math.max(0, (next.ts - previous.ts) / 1000);
}

function sameDefined<T>(left: T | undefined, right: T | undefined): boolean {
  return left !== undefined && left === right;
}

function bustFor(
  ref: PhaseRef,
  session: string,
  previous: AssistantTurn,
  turn: AssistantTurn,
  index: number,
): BustEvent {
  const gapSeconds = gapSecondsBetween(previous, turn);
  return {
    session,
    task: ref.task,
    phase: ref.phase,
    turn: index + 1,
    ...(gapSeconds === undefined ? {} : { gapSeconds }),
    uncachedTokens: turn.input,
    cost: turn.cost,
    sameProvider: sameDefined(previous.provider, turn.provider),
    sameModel: sameDefined(previous.model, turn.model),
    compacted: turn.totalTokens < previous.totalTokens * COMPACTION_RATIO,
  };
}

function analyzeSession(
  ref: PhaseRef,
  session: string,
  turns: readonly AssistantTurn[],
): SessionReport {
  const hasCacheHit = turns.some((turn) => turn.cacheRead > 0);
  const busts: BustEvent[] = [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let shrinkCount = 0;
  let shrinkTokens = 0;
  let previous: AssistantTurn | undefined;

  for (const [index, turn] of turns.entries()) {
    input += turn.input;
    output += turn.output;
    cacheRead += turn.cacheRead;
    cacheWrite += turn.cacheWrite;
    cost += turn.cost;

    if (previous !== undefined) {
      if (hasCacheHit && turn.cacheRead === 0 && turn.input > 0) {
        busts.push(bustFor(ref, session, previous, turn, index));
      }
      if (turn.cacheRead < previous.cacheRead - SHRINK_THRESHOLD_TOKENS) {
        shrinkCount += 1;
        shrinkTokens += previous.cacheRead - turn.cacheRead;
      }
    }
    previous = turn;
  }

  const denominator = input + cacheRead;
  const models = [...new Set(turns.flatMap((turn) => (turn.model ? [turn.model] : [])))];
  return {
    session,
    task: ref.task,
    phase: ref.phase,
    turns: turns.length,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    hitPct: denominator === 0 ? 0 : (100 * cacheRead) / denominator,
    hasCacheHit,
    busts,
    shrinkCount,
    shrinkTokens,
    models,
  };
}

function summarizeReports(reports: readonly SessionReport[]): OverallSummary {
  let sessions = 0;
  let sessionsWithBust = 0;
  let uncachedSessions = 0;
  let turns = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let busts = 0;
  let bustTokens = 0;
  let bustCost = 0;
  let shrinks = 0;

  for (const report of reports) {
    sessions += 1;
    turns += report.turns;
    input += report.input;
    output += report.output;
    cacheRead += report.cacheRead;
    cacheWrite += report.cacheWrite;
    cost += report.cost;
    shrinks += report.shrinkCount;
    if (!report.hasCacheHit) uncachedSessions += 1;
    if (report.busts.length > 0) sessionsWithBust += 1;
    busts += report.busts.length;
    for (const bust of report.busts) {
      bustTokens += bust.uncachedTokens;
      bustCost += bust.cost;
    }
  }

  const denominator = input + cacheRead;
  return {
    sessions,
    sessionsWithBust,
    uncachedSessions,
    turns,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    busts,
    bustTokens,
    bustCost,
    shrinks,
    hitPct: denominator === 0 ? 0 : (100 * cacheRead) / denominator,
  };
}

function byPhase(reports: readonly SessionReport[]): PhaseSummary[] {
  const groups = new Map<string, SessionReport[]>();
  for (const report of reports) {
    const group = groups.get(report.phase) ?? [];
    group.push(report);
    groups.set(report.phase, group);
  }
  return [...groups.entries()]
    .map(([phase, rows]) => ({ phase, ...summarizeReports(rows) }))
    .sort((left, right) => right.bustTokens - left.bustTokens);
}

function gapBand(seconds: number): string {
  if (seconds < 60) return "<60s";
  if (seconds < 180) return "60-180s";
  if (seconds < 300) return "180-300s";
  if (seconds < 600) return "300-600s";
  if (seconds < 1800) return "600-1800s";
  return ">=1800s";
}

function countGapBands(busts: readonly BustEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bust of busts) {
    if (bust.gapSeconds === undefined) continue;
    const band = gapBand(bust.gapSeconds);
    counts[band] = (counts[band] ?? 0) + 1;
  }
  return counts;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarizeContinuity(busts: readonly BustEvent[]): ContinuitySummary {
  let sameProviderAndModel = 0;
  let sameModel = 0;
  let shortGap = 0;
  let compacted = 0;
  for (const bust of busts) {
    if (bust.sameProvider && bust.sameModel) sameProviderAndModel += 1;
    if (bust.sameModel) sameModel += 1;
    if (bust.gapSeconds !== undefined && bust.gapSeconds < SHORT_GAP_SECONDS) shortGap += 1;
    if (bust.compacted) compacted += 1;
  }
  return { busts: busts.length, sameProviderAndModel, sameModel, shortGap, compacted };
}

function allBusts(reports: readonly SessionReport[]): BustEvent[] {
  return reports.flatMap((report) => report.busts);
}

function buildReport(reports: readonly SessionReport[], top: number): Report {
  const overall = summarizeReports(reports);
  const busts = allBusts(reports);
  const withGap = busts.filter(
    (bust): bust is BustEvent & { gapSeconds: number } => bust.gapSeconds !== undefined,
  );
  const medianBustGapSeconds = median(withGap.map((bust) => bust.gapSeconds));
  return {
    overall,
    gapBands: countGapBands(busts),
    ...(medianBustGapSeconds === undefined ? {} : { medianBustGapSeconds }),
    continuity: summarizeContinuity(busts),
    phases: byPhase(reports),
    topBusts: [...busts]
      .sort((left, right) => right.uncachedTokens - left.uncachedTokens)
      .slice(0, top),
    topSessions: [...reports]
      .filter((report) => report.busts.length > 0)
      .sort((left, right) => right.busts.length - left.busts.length)
      .slice(0, top),
  };
}

function formatPct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : ((100 * part) / whole).toFixed(1);
}

function formatGap(seconds: number | undefined): string {
  return seconds === undefined ? "n/a" : `${seconds.toFixed(0)}s`;
}

function renderReport(report: Report, sessionsRoot: string, skippedSessions: number): string {
  const { overall, continuity } = report;
  const lines: string[] = [
    "Belayd per-turn prompt-cache report",
    `sessions: ${sessionsRoot}`,
    "",
    `sessions=${overall.sessions} turns=${overall.turns} hit=${overall.hitPct.toFixed(1)}% ` +
      `cacheRead=${overall.cacheRead} cacheWrite=${overall.cacheWrite} cost=$${overall.cost.toFixed(2)}`,
    `mid-session misses=${overall.busts} tokens=${overall.bustTokens} ` +
      `(${formatPct(overall.bustTokens, overall.input)}% of uncached input) ` +
      `cost=$${overall.bustCost.toFixed(2)}`,
    `sessions with >=1 miss=${overall.sessionsWithBust} (${formatPct(overall.sessionsWithBust, overall.sessions)}%) ` +
      `uncached-sessions=${overall.uncachedSessions} skipped-sessions=${skippedSessions}`,
    `miss gaps: ${Object.entries(report.gapBands)
      .map(([band, count]) => `${band}=${count}`)
      .join(" ")} median=${formatGap(report.medianBustGapSeconds)}`,
    `miss continuity: same provider+model=${continuity.sameProviderAndModel}/${continuity.busts} ` +
      `same model=${continuity.sameModel} compacted=${continuity.compacted} ` +
      `short-gap(<${SHORT_GAP_SECONDS}s)=${continuity.shortGap}`,
    "",
    "by phase (sorted by missed cache-read tokens):",
    "phase\tsessions\twithMiss\tturns\thit%\tmisses\tmissedTokens\tmissedCost\tcost",
  ];

  for (const phase of report.phases) {
    lines.push(
      [
        phase.phase,
        phase.sessions,
        phase.sessionsWithBust,
        phase.turns,
        phase.hitPct.toFixed(1),
        phase.busts,
        phase.bustTokens,
        `$${phase.bustCost.toFixed(2)}`,
        `$${phase.cost.toFixed(2)}`,
      ].join("\t"),
    );
  }

  lines.push("", "largest mid-session misses:", "task\tphase\tturn\tgap\tuncached\tcost");
  for (const bust of report.topBusts) {
    lines.push(
      [
        bust.task,
        bust.phase,
        bust.turn,
        formatGap(bust.gapSeconds),
        bust.uncachedTokens,
        `$${bust.cost.toFixed(3)}`,
      ].join("\t"),
    );
  }

  lines.push(
    "",
    "sessions with the most misses:",
    "task\tphase\tturns\thit%\tmisses\tmissedTokens\tcost",
  );
  for (const session of report.topSessions) {
    const missedTokens = session.busts.reduce((total, bust) => total + bust.uncachedTokens, 0);
    const missedCost = session.busts.reduce((total, bust) => total + bust.cost, 0);
    lines.push(
      [
        session.task,
        session.phase,
        session.turns,
        session.hitPct.toFixed(1),
        session.busts.length,
        missedTokens,
        `$${missedCost.toFixed(2)}`,
      ].join("\t"),
    );
  }

  return `${lines.join("\n")}\n`;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }

  const agentDir =
    parsed.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const sessionsRoot = join(agentDir, "sessions");
  const reports: SessionReport[] = [];
  let skippedSessions = 0;

  for (const file of collectSessionFiles(sessionsRoot)) {
    const session = sessionNameFromFile(file);
    const ref = parseBackfillSessionName(session);
    if (ref.kind !== "phase") {
      skippedSessions += 1;
      continue;
    }
    const turns = assistantTurns(readRecords(file));
    if (turns.length === 0) {
      skippedSessions += 1;
      continue;
    }
    reports.push(analyzeSession(ref, session, turns));
  }

  if (reports.length === 0) {
    process.stdout.write(`no phase sessions found under ${sessionsRoot}\n`);
    return;
  }

  const report = buildReport(reports, parsed.top);
  process.stdout.write(
    parsed.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderReport(report, sessionsRoot, skippedSessions),
  );
}

main();
