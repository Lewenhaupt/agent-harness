/**
 * Per-(phase, model) execution telemetry.
 *
 * bd-116 observed that ~32% of sessions were `-fallback-N` retries after a
 * provider limit and that 46 zero-tool-call runs consumed budget while
 * producing nothing. This module aggregates attempts, fallbacks, quota (429)
 * failures, no-ops, and cost per (phase, model) so routing is decided from
 * data and a workflow's spend is inspectable after the fact.
 *
 * The store is an in-memory closure (no module-global state), matching the
 * cooldown store. `appendModelTelemetry` merges the current rows into the
 * persisted `.belayd/telemetry.json` snapshot (so an orchestrator restart does
 * not clobber prior history); each run manifest instead carries the totals of
 * its own private per-run store, so attribution stays exact when runs overlap.
 *
 * `cost` is assumed to be USD: pi's usage events report gateway dollar costs,
 * not millicents. Verifying that against a live gateway is out of scope, so the
 * assumption is stated here rather than encoded.
 */

import * as nodeFs from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { FailureKind } from "./quota-failure.js";
import { atomicWriteJson, type WorkflowFs } from "./workflow-state.js";

const ModelPhaseStatsSchema = z.object({
  phase: z.string(),
  model: z.string(),
  attempts: z.number().int().nonnegative(),
  fallbacks: z.number().int().nonnegative(),
  quotaFailures: z.number().int().nonnegative(),
  noOps: z.number().int().nonnegative(),
  cost: z.number().finite(),
});

/** Derived from the persisted schema so the write and read shapes cannot diverge. */
export type ModelPhaseStats = z.infer<typeof ModelPhaseStatsSchema>;

export interface ModelTelemetryTotals {
  attempts: number;
  fallbacks: number;
  quotaFailures: number;
  noOps: number;
  cost: number;
}

export interface ModelPhaseEvent {
  phase: string;
  model: string;
  /** True when this attempt ran at fallback index > 0. */
  fallback: boolean;
  classification: FailureKind;
  cost: number;
  toolCalls: number;
}

export interface ModelTelemetryStore {
  record(event: ModelPhaseEvent): void;
  /** Drop every row (called at workflow start so telemetry is per-workflow). */
  reset(): void;
  /** Per-(phase, model) rows, sorted by phase then model. */
  stats(): readonly ModelPhaseStats[];
  /** Rolled-up counts across every phase and model. */
  totals(): ModelTelemetryTotals;
}

function keyOf(phase: string, model: string): string {
  // NUL can never appear in a phase or model id, so the composite key is collision-free.
  return `${phase}\u0000${model}`;
}

/** Roll up per-(phase, model) rows into process totals. Pure. */
export function sumModelTelemetryStats(stats: readonly ModelPhaseStats[]): ModelTelemetryTotals {
  const totals: ModelTelemetryTotals = {
    attempts: 0,
    fallbacks: 0,
    quotaFailures: 0,
    noOps: 0,
    cost: 0,
  };
  for (const row of stats) {
    totals.attempts += row.attempts;
    totals.fallbacks += row.fallbacks;
    totals.quotaFailures += row.quotaFailures;
    totals.noOps += row.noOps;
    totals.cost += row.cost;
  }
  return totals;
}

/**
 * Per-(phase, model) difference `current - alreadyFlushed`, dropping keys absent
 * from `current` and rows whose counts net to zero. Pure.
 *
 * The persisted file is append-merged, so a caller that flushes on every settle
 * must pass only the rows added since its last flush; otherwise earlier rows are
 * re-appended and counts grow quadratically across a workflow.
 */
export function diffModelTelemetryStats(
  current: readonly ModelPhaseStats[],
  alreadyFlushed: readonly ModelPhaseStats[],
): ModelPhaseStats[] {
  const flushedByKey = new Map<string, ModelPhaseStats>();
  for (const row of alreadyFlushed) flushedByKey.set(keyOf(row.phase, row.model), row);

  const delta: ModelPhaseStats[] = [];
  for (const row of current) {
    const before = flushedByKey.get(keyOf(row.phase, row.model));
    // Clamp every field: a caller that resets the store without the cursor, or
    // a hand-edited file the cursor never reconciled with, would otherwise
    // produce negative rows. The schema rejects a negative row, which makes
    // `readModelTelemetry` return undefined and the next append overwrite all
    // history. Clamping keeps a stale cursor from nuking the file.
    const next: ModelPhaseStats = {
      phase: row.phase,
      model: row.model,
      attempts: Math.max(0, row.attempts - (before?.attempts ?? 0)),
      fallbacks: Math.max(0, row.fallbacks - (before?.fallbacks ?? 0)),
      quotaFailures: Math.max(0, row.quotaFailures - (before?.quotaFailures ?? 0)),
      noOps: Math.max(0, row.noOps - (before?.noOps ?? 0)),
      cost: Math.max(0, row.cost - (before?.cost ?? 0)),
    };
    const unchanged =
      next.attempts <= 0 &&
      next.fallbacks <= 0 &&
      next.quotaFailures <= 0 &&
      next.noOps <= 0 &&
      next.cost <= 0;
    if (!unchanged) delta.push(next);
  }

  return delta.sort((a, b) => a.phase.localeCompare(b.phase) || a.model.localeCompare(b.model));
}

/**
 * Fan-out store: records into every store and reads from the first. Lets a
 * phase run keep its own store for an exact per-run manifest delta while still
 * feeding the shared workflow store that owns persistence and logging.
 */
export function combineModelTelemetryStores(
  primary: ModelTelemetryStore,
  ...others: readonly ModelTelemetryStore[]
): ModelTelemetryStore {
  const stores = [primary, ...others];
  return {
    record(event) {
      for (const store of stores) store.record(event);
    },
    reset() {
      // Never reset the primary: it owns the shared workflow ledger, so a
      // per-run sink reset must not wipe rows that other runs still depend on.
      for (const store of others) store.reset();
    },
    stats() {
      return primary.stats();
    },
    totals() {
      return primary.totals();
    },
  };
}

function isNoOp(event: ModelPhaseEvent): boolean {
  return event.classification === "success" && event.toolCalls === 0;
}

export function createModelTelemetryStore(): ModelTelemetryStore {
  const rows = new Map<string, ModelPhaseStats>();

  return {
    record(event) {
      const key = keyOf(event.phase, event.model);
      const row = rows.get(key) ?? {
        phase: event.phase,
        model: event.model,
        attempts: 0,
        fallbacks: 0,
        quotaFailures: 0,
        noOps: 0,
        cost: 0,
      };
      row.attempts += 1;
      row.fallbacks += event.fallback ? 1 : 0;
      row.quotaFailures += event.classification === "quota" ? 1 : 0;
      row.noOps += isNoOp(event) ? 1 : 0;
      row.cost += event.cost;
      rows.set(key, row);
    },
    reset() {
      rows.clear();
    },
    stats() {
      return [...rows.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => a.phase.localeCompare(b.phase) || a.model.localeCompare(b.model));
    },
    totals() {
      return sumModelTelemetryStats([...rows.values()]);
    },
  };
}

/** One human-readable log line plus a per-(phase, model) breakdown. */
export function formatModelTelemetrySummary(
  stats: readonly ModelPhaseStats[],
  totals: ModelTelemetryTotals,
): string {
  const header =
    `[belayd model telemetry] attempts=${totals.attempts} fallbacks=${totals.fallbacks} ` +
    `quotaFailures=${totals.quotaFailures} noOps=${totals.noOps} cost=$${totals.cost.toFixed(4)}`;
  const lines = stats.map(
    (row) =>
      `  ${row.phase} ${row.model}: attempts=${row.attempts} fallbacks=${row.fallbacks} ` +
      `quota=${row.quotaFailures} noops=${row.noOps} cost=$${row.cost.toFixed(4)}`,
  );
  return [header, ...lines].join("\n");
}

export const ModelTelemetryTotalsSchema = z.object({
  attempts: z.number().int().nonnegative(),
  fallbacks: z.number().int().nonnegative(),
  quotaFailures: z.number().int().nonnegative(),
  noOps: z.number().int().nonnegative(),
  cost: z.number().finite(),
});

const TELEMETRY_SCHEMA_VERSION = 1;

const ModelTelemetryFileSchema = z.object({
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  stats: z.array(ModelPhaseStatsSchema),
  totals: ModelTelemetryTotalsSchema,
  updatedAt: z.number().finite(),
});

export interface ModelTelemetrySnapshot {
  stats: ModelPhaseStats[];
  totals: ModelTelemetryTotals;
  updatedAt: number;
}

export function modelTelemetryPath(cwd: string): string {
  return join(cwd, ".belayd", "telemetry.json");
}

const nodeFsSeam: WorkflowFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
  writeFileSync: (path, data, options) => nodeFs.writeFileSync(path, data, options),
  renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path, options),
  unlinkSync: (path) => nodeFs.unlinkSync(path),
};

export interface WriteModelTelemetryOptions {
  cwd: string;
  stats: readonly ModelPhaseStats[];
  totals: ModelTelemetryTotals;
  fs?: WorkflowFs;
  now?: () => number;
}

export function writeModelTelemetry(
  options: WriteModelTelemetryOptions,
): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  const snapshot = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    stats: options.stats,
    totals: options.totals,
    updatedAt: (options.now ?? Date.now)(),
  };
  return atomicWriteJson(modelTelemetryPath(options.cwd), snapshot, fs);
}

export interface AppendModelTelemetryOptions {
  cwd: string;
  stats: readonly ModelPhaseStats[];
  fs?: WorkflowFs;
  now?: () => number;
}

export type AppendModelTelemetryResult =
  | { ok: true; snapshot: ModelTelemetrySnapshot }
  | { ok: false; error: string };

/**
 * Merge new rows into the persisted snapshot and write the union back. This is
 * the restart-safe write path: a fresh in-process store (empty after a restart)
 * must never overwrite the previous workflow's persisted history.
 *
 * Concurrency: this is a read-modify-write with no cross-process lock, and one
 * orchestrator per repo (cwd) is the supported scenario. Two concurrent
 * orchestrators writing the same cwd can interleave and lose rows (last writer
 * wins); coordinating them is out of scope.
 */
export function appendModelTelemetry(
  options: AppendModelTelemetryOptions,
): AppendModelTelemetryResult {
  const fs = options.fs ?? nodeFsSeam;
  const existing = readModelTelemetry({ cwd: options.cwd, fs });
  const merged =
    existing === undefined
      ? [...options.stats]
      : mergeModelTelemetry(existing.stats, options.stats);
  const totals = sumModelTelemetryStats(merged);
  const at = (options.now ?? Date.now)();
  const write = writeModelTelemetry({ cwd: options.cwd, stats: merged, totals, fs, now: () => at });
  if (!write.ok) return { ok: false, error: write.error };
  return { ok: true, snapshot: { stats: merged, totals, updatedAt: at } };
}

export interface ReadModelTelemetryOptions {
  cwd: string;
  fs?: WorkflowFs;
}

/** Read the persisted telemetry snapshot; a missing/corrupt file yields undefined. */
export function readModelTelemetry(
  options: ReadModelTelemetryOptions,
): ModelTelemetrySnapshot | undefined {
  const fs = options.fs ?? nodeFsSeam;
  const path = modelTelemetryPath(options.cwd);
  if (!fs.existsSync(path)) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(path);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = ModelTelemetryFileSchema.safeParse(parsed);
  if (!result.success) return undefined;
  return {
    stats: result.data.stats,
    totals: result.data.totals,
    updatedAt: result.data.updatedAt,
  };
}

/** Add two per-(phase, model) snapshots, summing matching rows. */
export function mergeModelTelemetry(
  a: readonly ModelPhaseStats[],
  b: readonly ModelPhaseStats[],
): ModelPhaseStats[] {
  const merged = new Map<string, ModelPhaseStats>();
  for (const row of [...a, ...b]) {
    const key = keyOf(row.phase, row.model);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...row });
      continue;
    }
    existing.attempts += row.attempts;
    existing.fallbacks += row.fallbacks;
    existing.quotaFailures += row.quotaFailures;
    existing.noOps += row.noOps;
    existing.cost += row.cost;
  }
  return [...merged.values()].sort(
    (x, y) => x.phase.localeCompare(y.phase) || x.model.localeCompare(y.model),
  );
}
