/**
 * Session-scoped mutable model-routing state (bd-116).
 *
 * AGENTS.md confines module-level mutable state to a documented allowlist
 * (`stale-file-guard.ts`, `spawn.ts`, and now `model-session-state.ts`). Model
 * routing needs three related pieces of long-lived state — the pre-dispatch
 * capacity cache, the per-workflow telemetry store, and the per-destination
 * telemetry flush cursors — so they live behind this one factory instead of as
 * three loose globals. Grouping them states the exception in a single place and
 * lets the caller reset every cursor alongside the store.
 */

import { resolve } from "node:path";

import type { CapacityCache } from "./capacity-cache.js";
import {
  appendModelTelemetry,
  createModelTelemetryStore,
  diffModelTelemetryStats,
  type ModelPhaseStats,
  type ModelTelemetryStore,
} from "./model-telemetry.js";

/** Five minutes: matches the capacity probe, so a persistently failing disk warns once per workflow. */
export const DEFAULT_FLUSH_FAILURE_WARN_INTERVAL_MS = 5 * 60 * 1000;

export interface ModelSessionState {
  /** Pre-dispatch provider capacity signal. */
  readonly capacity: CapacityCache;
  /** Per-workflow (phase, model) counters, flushed to `.belayd/telemetry.json`. */
  readonly telemetry: ModelTelemetryStore;
  /**
   * Cumulative rows already written, keyed by normalized destination cwd.
   * Keying per destination means a flush to one cwd advances only that cwd's
   * cursor; a later flush elsewhere still receives the rows that destination
   * lacks. Keys are normalized so one logical directory has exactly one entry.
   */
  readonly flushedByCwd: Map<string, readonly ModelPhaseStats[]>;
  /** Minimum gap between flush-failure warnings; bounds warn spam. */
  readonly flushFailureWarnIntervalMs: number;
  /** Epoch ms of the last flush-failure warning; undefined until one fires. */
  lastFlushFailureWarnAtMs: number | undefined;
  /** Epoch-ms clock (test seam). */
  readonly now: () => number;
}

export interface CreateModelSessionStateOptions {
  capacity: CapacityCache;
  telemetry?: ModelTelemetryStore;
  /** Minimum gap between flush-failure warnings. Defaults to {@link DEFAULT_FLUSH_FAILURE_WARN_INTERVAL_MS}. */
  flushFailureWarnIntervalMs?: number;
  /** Epoch-ms clock (test seam). Defaults to Date.now. */
  now?: () => number;
}

export function createModelSessionState(
  options: CreateModelSessionStateOptions,
): ModelSessionState {
  return {
    capacity: options.capacity,
    telemetry: options.telemetry ?? createModelTelemetryStore(),
    flushedByCwd: new Map(),
    flushFailureWarnIntervalMs:
      options.flushFailureWarnIntervalMs ?? DEFAULT_FLUSH_FAILURE_WARN_INTERVAL_MS,
    lastFlushFailureWarnAtMs: undefined,
    now: options.now ?? Date.now,
  };
}

/**
 * Canonicalize a destination so `/repo`, `/repo/`, and (relative to the process
 * cwd) `repo` all map to one cursor. Without this the second spelling recomputes
 * the full store as "pending" and appends duplicate rows to the same file.
 */
function cwdKey(cwd: string): string {
  return resolve(cwd);
}

/** True when a flush failure should be reported now; advances the throttle window. */
export function shouldWarnFlushFailure(state: ModelSessionState, nowMs?: number): boolean {
  const at = nowMs ?? state.now();
  if (
    state.lastFlushFailureWarnAtMs !== undefined &&
    at - state.lastFlushFailureWarnAtMs < state.flushFailureWarnIntervalMs
  ) {
    return false;
  }
  state.lastFlushFailureWarnAtMs = at;
  return true;
}

export type ModelTelemetryAppendFn = (options: {
  cwd: string;
  stats: readonly ModelPhaseStats[];
}) => { ok: true } | { ok: false; error: string };

export interface FlushModelTelemetryOptions {
  state: ModelSessionState;
  cwd: string;
  /** Writer seam. Defaults to {@link appendModelTelemetry}. */
  append?: ModelTelemetryAppendFn;
}

export type FlushModelTelemetryResult = { ok: true } | { ok: false; error: string };

/**
 * Append the rows recorded since this destination's last flush. On success the
 * destination's cursor advances; on failure the cursor is left untouched so the
 * rows stay pending and the next flush retries them rather than dropping them.
 */
export function flushModelTelemetry(
  options: FlushModelTelemetryOptions,
): FlushModelTelemetryResult {
  const current = options.state.telemetry.stats();
  if (current.length === 0) return { ok: true };
  const key = cwdKey(options.cwd);
  const alreadyFlushed = options.state.flushedByCwd.get(key) ?? [];
  const pending = diffModelTelemetryStats(current, alreadyFlushed);
  if (pending.length === 0) return { ok: true };
  const append = options.append ?? appendModelTelemetry;
  const result = append({ cwd: options.cwd, stats: pending });
  if (!result.ok) return { ok: false, error: result.error };
  options.state.flushedByCwd.set(key, current);
  return { ok: true };
}

/**
 * Drop the telemetry store and every destination cursor. Only call this after a
 * successful flush, otherwise the dropped rows are never written.
 */
export function resetModelSessionState(state: ModelSessionState): void {
  state.telemetry.reset();
  state.flushedByCwd.clear();
}

export interface FlushAndResetModelTelemetryOptions extends FlushModelTelemetryOptions {
  /** Called with the just-flushed store before the store and cursors are dropped. */
  beforeReset?: () => void;
}

/**
 * Flush, then reset only on success. On a failed flush the store and cursors are
 * left intact so the rows stay pending for the next flush; `beforeReset` is not
 * called, so its caller never reports a summary for rows that did not land.
 */
export function flushAndResetModelTelemetry(
  options: FlushAndResetModelTelemetryOptions,
): FlushModelTelemetryResult {
  const result = flushModelTelemetry(options);
  if (!result.ok) return result;
  options.beforeReset?.();
  resetModelSessionState(options.state);
  return { ok: true };
}
