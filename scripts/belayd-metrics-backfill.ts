#!/usr/bin/env node
/**
 * Backfill the metrics log from recorded pi sessions (bd-140, phase 3).
 *
 * Writes ONE file, `events-backfill.jsonl`, and rewrites it wholesale on every
 * run: re-running is idempotent and a partially-read corpus can never leave
 * duplicate history. Live events keep their own monthly files, so the glob the
 * queries use (`events-*.jsonl`) picks up both without a join.
 *
 * Usage:
 *   node scripts/belayd-metrics-backfill.ts [--dry-run] [--limit N]
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { metricsHostname, resolveMetricsDir } from "../src/metrics.ts";
import {
  buildBackfillEvents,
  parseBackfillSessionName,
  type SessionEntry,
} from "../src/metrics-backfill.ts";

const BACKFILL_FILE = "events-backfill.jsonl";

interface Options {
  dryRun: boolean;
  limit: number;
}

function parseArgs(argv: readonly string[]): Options | { error: string } {
  const limitIndex = argv.indexOf("--limit");
  const limitText = limitIndex === -1 ? undefined : (argv[limitIndex + 1] ?? "");
  if (limitText === undefined) return { dryRun: argv.includes("--dry-run"), limit: Infinity };
  const limit = Number.parseInt(limitText, 10);
  if (Number.isNaN(limit) || limit <= 0) return { error: `invalid --limit ${limitText}` };
  return { dryRun: argv.includes("--dry-run"), limit };
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

async function readEntries(file: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // A truncated trailing line is normal for a crashed session; skip it.
    }
  }
  return entries;
}

/** One event's identity, for de-duplicating several provider-fallback sessions. */
function eventKey(event: ReturnType<typeof buildBackfillEvents>[number]): string {
  const task = "task" in event ? event.task : "";
  const phase = "phase" in event ? event.phase : "";
  const runId = "runId" in event ? event.runId : "";
  return `${event.event}:${task}:${phase}:${runId}`;
}

interface CollectResult {
  lines: string[];
  sessions: number;
  skipped: number;
}

async function collectEvents(options: {
  files: readonly string[];
  limit: number;
  host: string;
}): Promise<CollectResult> {
  const lines: string[] = [];
  const seen = new Set<string>();
  const result: CollectResult = { lines, sessions: 0, skipped: 0 };
  for (const file of options.files.slice(
    0,
    options.limit === Infinity ? undefined : options.limit,
  )) {
    const sessionName = sessionNameFromFile(file);
    if (parseBackfillSessionName(sessionName).kind !== "phase") {
      result.skipped += 1;
      continue;
    }
    const events = buildBackfillEvents({
      sessionName,
      entries: await readEntries(file),
      host: options.host,
    });
    const fresh = events.filter((event) => !seen.has(eventKey(event)));
    if (fresh.length === 0) continue;
    for (const event of fresh) {
      seen.add(eventKey(event));
      lines.push(JSON.stringify(event));
    }
    result.sessions += 1;
  }
  return result;
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

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  const dir = resolveMetricsDir({ env: process.env });
  if (dir === undefined) {
    process.stderr.write("metrics disabled (BELAYD_METRICS=0)\n");
    process.exit(1);
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const sessionsRoot = join(agentDir, "sessions");
  const collected = await collectEvents({
    files: collectSessionFiles(sessionsRoot),
    limit: parsed.limit,
    host: metricsHostname(),
  });
  const target = join(dir, BACKFILL_FILE);
  const summary = `${collected.lines.length} events from ${collected.sessions} sessions (${collected.skipped} skipped)`;
  if (parsed.dryRun) {
    process.stdout.write(`[dry-run] ${summary} -> ${target}\n`);
    return;
  }
  if (collected.lines.length === 0) {
    process.stdout.write(`no phase sessions found under ${sessionsRoot}\n`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, `${collected.lines.join("\n")}\n`, "utf8");
  process.stdout.write(`${summary} -> ${target}\n`);
}

await main();
