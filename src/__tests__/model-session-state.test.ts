import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCapacityCache } from "../capacity-cache.js";
import {
  createModelSessionState,
  flushAndResetModelTelemetry,
  flushModelTelemetry,
  type ModelSessionState,
  type ModelTelemetryAppendFn,
  shouldWarnFlushFailure,
} from "../model-session-state.js";
import type { ModelPhaseStats } from "../model-telemetry.js";

interface RecordedAppend {
  cwd: string;
  stats: readonly ModelPhaseStats[];
}

function createState(): ModelSessionState {
  return createModelSessionState({ capacity: createCapacityCache() });
}

function seedAttempt(state: ModelSessionState, phase = "plan", model = "a"): void {
  state.telemetry.record({
    phase,
    model,
    fallback: false,
    classification: "success",
    cost: 0.1,
    toolCalls: 1,
  });
}

function recordingAppend(recorded: RecordedAppend[]): ModelTelemetryAppendFn {
  return (options) => {
    recorded.push({ cwd: options.cwd, stats: options.stats });
    return { ok: true };
  };
}

describe("flushModelTelemetry", () => {
  it("keeps an independent flush cursor per destination cwd", () => {
    const state = createState();
    seedAttempt(state);
    const recorded: RecordedAppend[] = [];
    const append = recordingAppend(recorded);

    flushModelTelemetry({ state, cwd: "/worktree", append });
    // A flush elsewhere must still receive the rows the first destination
    // already has; a single shared cursor would compute pending = 0 here.
    flushModelTelemetry({ state, cwd: "/repo", append });
    // A repeat flush of an unchanged destination is a no-op.
    flushModelTelemetry({ state, cwd: "/worktree", append });

    expect(recorded.map((entry) => entry.cwd)).toEqual(["/worktree", "/repo"]);
    expect(recorded[0]?.stats[0]).toHaveProperty("attempts", 1);
    expect(recorded[1]?.stats[0]).toHaveProperty("attempts", 1);
  });

  it("appends only the delta since the same destination's last flush", () => {
    const state = createState();
    seedAttempt(state);
    const recorded: RecordedAppend[] = [];
    const append = recordingAppend(recorded);

    flushModelTelemetry({ state, cwd: "/repo", append });
    seedAttempt(state);
    flushModelTelemetry({ state, cwd: "/repo", append });

    expect(recorded[0]?.stats[0]).toHaveProperty("attempts", 1);
    // The second append carries only the newly recorded attempt, not both.
    expect(recorded[1]?.stats[0]).toHaveProperty("attempts", 1);
  });

  it("does not call the writer for an empty store", () => {
    const state = createState();
    const append = vi.fn(() => ({ ok: true as const }));

    expect(flushModelTelemetry({ state, cwd: "/repo", append })).toEqual({ ok: true });
    expect(append).not.toHaveBeenCalled();
  });

  it("propagates an append failure without advancing the cursor so rows retry", () => {
    const state = createState();
    seedAttempt(state);
    const failing: ModelTelemetryAppendFn = () => ({ ok: false, error: "disk full" });

    const result = flushModelTelemetry({ state, cwd: "/repo", append: failing });

    expect(result).toEqual({ ok: false, error: "disk full" });
    expect(state.flushedByCwd.has(resolve("/repo"))).toBe(false);

    const recorded: RecordedAppend[] = [];
    flushModelTelemetry({ state, cwd: "/repo", append: recordingAppend(recorded) });
    expect(recorded[0]?.stats[0]).toHaveProperty("attempts", 1);
  });

  it("normalizes cwd spellings so one directory has a single cursor", () => {
    const state = createState();
    seedAttempt(state);
    const recorded: RecordedAppend[] = [];
    const append = recordingAppend(recorded);

    flushModelTelemetry({ state, cwd: "/repo", append });
    // The trailing-slash spelling is the same directory: no duplicate append.
    flushModelTelemetry({ state, cwd: "/repo/", append });
    expect(recorded).toHaveLength(1);
    expect(state.flushedByCwd.size).toBe(1);

    // A relative spelling resolves against the process cwd, so it shares that
    // directory's cursor instead of becoming a second entry.
    flushModelTelemetry({ state, cwd: process.cwd(), append });
    flushModelTelemetry({ state, cwd: ".", append });
    expect(recorded).toHaveLength(2);
    expect(state.flushedByCwd.size).toBe(2);
    expect(state.flushedByCwd.has(resolve(process.cwd()))).toBe(true);
  });
});

describe("shouldWarnFlushFailure", () => {
  it("throttles repeated warnings and re-enables after the interval", () => {
    let nowMs = 0;
    const state = createModelSessionState({
      capacity: createCapacityCache(),
      flushFailureWarnIntervalMs: 1_000,
      now: () => nowMs,
    });

    expect(shouldWarnFlushFailure(state)).toBe(true);
    expect(shouldWarnFlushFailure(state)).toBe(false);
    nowMs = 999;
    expect(shouldWarnFlushFailure(state)).toBe(false);
    nowMs = 1_000;
    expect(shouldWarnFlushFailure(state)).toBe(true);
  });
});

describe("flushAndResetModelTelemetry", () => {
  it("does not drop the store or cursor when the flush fails", () => {
    const state = createState();
    seedAttempt(state);
    const beforeReset = vi.fn();
    const failing: ModelTelemetryAppendFn = () => ({ ok: false, error: "disk full" });

    const result = flushAndResetModelTelemetry({
      state,
      cwd: "/repo",
      append: failing,
      beforeReset,
    });

    expect(result).toEqual({ ok: false, error: "disk full" });
    expect(beforeReset).not.toHaveBeenCalled();
    // The rows and cursor survive, so the next flush retries instead of losing.
    expect(state.telemetry.totals().attempts).toBe(1);
    expect(state.flushedByCwd.has("/repo")).toBe(false);

    const recorded: RecordedAppend[] = [];
    const retry = flushModelTelemetry({ state, cwd: "/repo", append: recordingAppend(recorded) });
    expect(retry).toEqual({ ok: true });
    expect(recorded[0]?.stats[0]).toHaveProperty("attempts", 1);
  });

  it("resets the store and every cursor only after a successful flush", () => {
    const state = createState();
    seedAttempt(state, "plan", "a");
    seedAttempt(state, "test", "b");
    const recorded: RecordedAppend[] = [];
    flushModelTelemetry({ state, cwd: "/worktree", append: recordingAppend(recorded) });

    const beforeReset = vi.fn();
    const result = flushAndResetModelTelemetry({
      state,
      cwd: "/repo",
      append: recordingAppend(recorded),
      beforeReset,
    });

    expect(result).toEqual({ ok: true });
    expect(beforeReset).toHaveBeenCalledTimes(1);
    expect(state.telemetry.totals().attempts).toBe(0);
    expect(state.flushedByCwd.size).toBe(0);
  });

  it("still runs beforeReset and clears cursors when the store is empty", () => {
    const state = createState();
    // A store reset without its cursors leaves a cursor behind with no rows.
    state.flushedByCwd.set(resolve("/worktree"), []);
    const append = vi.fn(() => ({ ok: true as const }));
    const beforeReset = vi.fn();

    const result = flushAndResetModelTelemetry({
      state,
      cwd: "/repo",
      append,
      beforeReset,
    });

    expect(result).toEqual({ ok: true });
    expect(append).not.toHaveBeenCalled();
    expect(beforeReset).toHaveBeenCalledTimes(1);
    expect(state.telemetry.totals().attempts).toBe(0);
    expect(state.flushedByCwd.size).toBe(0);
  });
});
