import { describe, expect, it } from "vitest";

import {
  appendModelTelemetry,
  combineModelTelemetryStores,
  createModelTelemetryStore,
  diffModelTelemetryStats,
  formatModelTelemetrySummary,
  mergeModelTelemetry,
  modelTelemetryPath,
  readModelTelemetry,
  sumModelTelemetryStats,
  writeModelTelemetry,
} from "../model-telemetry.js";
import type { WorkflowFs } from "../workflow-state.js";

describe("model telemetry store", () => {
  it("aggregates attempts, fallbacks, quota failures, no-ops, and cost per (phase, model)", () => {
    const store = createModelTelemetryStore();
    store.record({
      phase: "implement",
      model: "opencode-go/deepseek-v4.1-flash",
      fallback: false,
      classification: "quota",
      cost: 0.01,
      toolCalls: 0,
    });
    store.record({
      phase: "implement",
      model: "llmgateway/deepseek-v4.1-flash",
      fallback: true,
      classification: "success",
      cost: 0.2,
      toolCalls: 7,
    });

    expect(store.stats()).toEqual([
      {
        phase: "implement",
        model: "llmgateway/deepseek-v4.1-flash",
        attempts: 1,
        fallbacks: 1,
        quotaFailures: 0,
        noOps: 0,
        cost: 0.2,
      },
      {
        phase: "implement",
        model: "opencode-go/deepseek-v4.1-flash",
        attempts: 1,
        fallbacks: 0,
        quotaFailures: 1,
        noOps: 0,
        cost: 0.01,
      },
    ]);
    const totals = store.totals();
    expect(totals).toHaveProperty("attempts", 2);
    expect(totals).toHaveProperty("fallbacks", 1);
    expect(totals).toHaveProperty("quotaFailures", 1);
    expect(totals).toHaveProperty("noOps", 0);
    expect(totals.cost).toBeCloseTo(0.21);
  });

  it("counts a zero-tool-call success as a no-op but not a zero-tool-call failure", () => {
    const store = createModelTelemetryStore();
    store.record({
      phase: "research",
      model: "m",
      fallback: false,
      classification: "success",
      cost: 0.02,
      toolCalls: 0,
    });
    store.record({
      phase: "research",
      model: "m",
      fallback: false,
      classification: "quota",
      cost: 0,
      toolCalls: 0,
    });
    store.record({
      phase: "research",
      model: "m",
      fallback: false,
      classification: "success",
      cost: 0.03,
      toolCalls: 3,
    });

    const [row] = store.stats();
    expect(row).toHaveProperty("attempts", 3);
    expect(row).toHaveProperty("noOps", 1);
    expect(row).toHaveProperty("quotaFailures", 1);
  });

  it("sorts stats by phase then model and rolls up totals", () => {
    const store = createModelTelemetryStore();
    store.record({
      phase: "test",
      model: "b",
      fallback: false,
      classification: "success",
      cost: 0.1,
      toolCalls: 1,
    });
    store.record({
      phase: "plan",
      model: "z",
      fallback: false,
      classification: "success",
      cost: 0.2,
      toolCalls: 1,
    });

    expect(store.stats().map((s) => `${s.phase}/${s.model}`)).toEqual(["plan/z", "test/b"]);
    expect(store.totals()).toHaveProperty("attempts", 2);
  });
});

describe("formatModelTelemetrySummary", () => {
  it("renders a header plus a per-(phase, model) breakdown", () => {
    const store = createModelTelemetryStore();
    store.record({
      phase: "review",
      model: "opencode-go/glm-5.3-flash",
      fallback: true,
      classification: "success",
      cost: 0.1234,
      toolCalls: 2,
    });

    const text = formatModelTelemetrySummary(store.stats(), store.totals());

    expect(text).toContain("[belayd model telemetry] attempts=1 fallbacks=1");
    expect(text).toContain("quotaFailures=0 noOps=0 cost=$0.1234");
    expect(text).toContain("review opencode-go/glm-5.3-flash: attempts=1 fallbacks=1");
  });
});

interface FakeFs extends WorkflowFs {
  files: Map<string, string>;
}

function createFakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync(path) {
      return files.has(path);
    },
    readFileSync(path) {
      const content = files.get(path);
      if (content === undefined) {
        const error = new Error(`ENOENT: ${path}`) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
    writeFileSync(path, data) {
      files.set(path, data);
    },
    renameSync(oldPath, newPath) {
      const content = files.get(oldPath);
      if (content === undefined) {
        const error = new Error(`ENOENT: ${oldPath}`) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      files.delete(oldPath);
      files.set(newPath, content);
    },
    mkdirSync() {
      // In-memory fs has no directory hierarchy to create.
    },
    unlinkSync(path) {
      files.delete(path);
    },
  };
}

describe("model telemetry persistence", () => {
  const cwd = "/tmp/worktree";

  it("round-trips a snapshot through disk", () => {
    const fs = createFakeFs();
    const store = createModelTelemetryStore();
    store.record({
      phase: "implement",
      model: "a",
      fallback: false,
      classification: "success",
      cost: 0.5,
      toolCalls: 1,
    });

    const write = writeModelTelemetry({
      cwd,
      stats: store.stats(),
      totals: store.totals(),
      fs,
      now: () => 42,
    });
    expect(write).toEqual({ ok: true });

    const read = readModelTelemetry({ cwd, fs });
    expect(read).toHaveProperty("updatedAt", 42);
    expect(read?.totals).toHaveProperty("attempts", 1);
    expect(read?.stats[0]).toHaveProperty("phase", "implement");
    expect(fs.files.has(modelTelemetryPath(cwd))).toBe(true);
  });

  it("returns undefined for a missing or corrupt file", () => {
    expect(readModelTelemetry({ cwd, fs: createFakeFs() })).toBeUndefined();
    const corrupt = createFakeFs({ [modelTelemetryPath(cwd)]: "not json" });
    expect(readModelTelemetry({ cwd, fs: corrupt })).toBeUndefined();
  });
});

describe("mergeModelTelemetry", () => {
  it("sums matching rows and keeps distinct ones", () => {
    const merged = mergeModelTelemetry(
      [
        {
          phase: "plan",
          model: "a",
          attempts: 1,
          fallbacks: 0,
          quotaFailures: 1,
          noOps: 0,
          cost: 0.1,
        },
      ],
      [
        {
          phase: "plan",
          model: "a",
          attempts: 2,
          fallbacks: 1,
          quotaFailures: 0,
          noOps: 1,
          cost: 0.2,
        },
        {
          phase: "test",
          model: "b",
          attempts: 1,
          fallbacks: 0,
          quotaFailures: 0,
          noOps: 0,
          cost: 0.3,
        },
      ],
    );

    expect(merged.map((row) => `${row.phase}/${row.model}`)).toEqual(["plan/a", "test/b"]);
    const [plan] = merged;
    expect(plan).toHaveProperty("attempts", 3);
    expect(plan).toHaveProperty("fallbacks", 1);
    expect(plan).toHaveProperty("quotaFailures", 1);
    expect(plan).toHaveProperty("noOps", 1);
    expect(plan?.cost).toBeCloseTo(0.3);
  });

  it("sums duplicate keys within one side", () => {
    const merged = mergeModelTelemetry(
      [sampleRow({ attempts: 1 }), sampleRow({ attempts: 2 })],
      [],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toHaveProperty("attempts", 3);
  });
});

const sampleRow = (
  overrides: Partial<{
    phase: string;
    model: string;
    attempts: number;
    fallbacks: number;
    quotaFailures: number;
    noOps: number;
    cost: number;
  }> = {},
) => ({
  phase: "plan",
  model: "a",
  attempts: 1,
  fallbacks: 0,
  quotaFailures: 0,
  noOps: 0,
  cost: 0.1,
  ...overrides,
});

describe("model telemetry helpers", () => {
  it("sums rows into totals", () => {
    const totals = sumModelTelemetryStats([
      sampleRow({ attempts: 2, fallbacks: 1, quotaFailures: 1, cost: 0.3 }),
      sampleRow({ model: "b", attempts: 1, noOps: 1, cost: 0.2 }),
    ]);
    expect(totals).toHaveProperty("attempts", 3);
    expect(totals).toHaveProperty("fallbacks", 1);
    expect(totals).toHaveProperty("quotaFailures", 1);
    expect(totals).toHaveProperty("noOps", 1);
    expect(totals.cost).toBeCloseTo(0.5);
  });

  it("sums an empty list to zero totals", () => {
    expect(sumModelTelemetryStats([])).toEqual({
      attempts: 0,
      fallbacks: 0,
      quotaFailures: 0,
      noOps: 0,
      cost: 0,
    });
  });

  it("reset clears the in-memory rows", () => {
    const store = createModelTelemetryStore();
    store.record({
      phase: "plan",
      model: "a",
      fallback: false,
      classification: "quota",
      cost: 0.1,
      toolCalls: 0,
    });
    expect(store.stats()).toHaveLength(1);
    store.reset();
    expect(store.stats()).toEqual([]);
    expect(store.totals()).toEqual({
      attempts: 0,
      fallbacks: 0,
      quotaFailures: 0,
      noOps: 0,
      cost: 0,
    });
  });

  it("diffModelTelemetryStats returns only the rows added since the flush", () => {
    const flushed = [sampleRow({ model: "a", attempts: 1, cost: 0.1 })];
    const current = [
      sampleRow({ model: "a", attempts: 2, fallbacks: 1, cost: 0.2 }),
      sampleRow({ model: "b", attempts: 3, quotaFailures: 1, noOps: 1, cost: 0.3 }),
    ];

    const diff = diffModelTelemetryStats(current, flushed);

    expect(diff.map((row) => row.model)).toEqual(["a", "b"]);
    const [a, b] = diff;
    expect(a).toHaveProperty("attempts", 1);
    expect(a).toHaveProperty("fallbacks", 1);
    expect(a?.cost).toBeCloseTo(0.1);
    expect(b).toHaveProperty("attempts", 3);
    expect(b).toHaveProperty("quotaFailures", 1);
  });

  it("diffModelTelemetryStats is empty when nothing changed", () => {
    const same = [sampleRow()];
    expect(diffModelTelemetryStats(same, same)).toEqual([]);
    expect(diffModelTelemetryStats(same, [])).toHaveLength(1);
  });

  it("diffModelTelemetryStats clamps decreasing counts to zero instead of going negative", () => {
    const flushed = [sampleRow({ model: "a", attempts: 5, fallbacks: 2, cost: 1 })];
    const current = [sampleRow({ model: "a", attempts: 1, fallbacks: 0, cost: 0.5 })];
    // A negative row would be rejected by the schema, making the next append
    // treat the file as absent and overwrite all history.
    expect(diffModelTelemetryStats(current, flushed)).toEqual([]);
  });

  it("diffModelTelemetryStats keeps a row whose non-decreasing fields grew", () => {
    const flushed = [sampleRow({ model: "a", attempts: 5, cost: 0.1 })];
    const current = [sampleRow({ model: "a", attempts: 1, cost: 0.4 })];
    const diff = diffModelTelemetryStats(current, flushed);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toHaveProperty("attempts", 0);
    expect(diff[0]?.cost).toBeCloseTo(0.3);
  });

  it("combineModelTelemetryStores fans out records and never resets the primary", () => {
    const primary = createModelTelemetryStore();
    const secondary = createModelTelemetryStore();
    const combined = combineModelTelemetryStores(primary, secondary);

    combined.record({
      phase: "plan",
      model: "a",
      fallback: false,
      classification: "quota",
      cost: 0.1,
      toolCalls: 0,
    });

    expect(primary.totals().attempts).toBe(1);
    expect(secondary.totals().attempts).toBe(1);
    expect(combined.totals().attempts).toBe(1);

    combined.reset();
    // The primary owns the shared workflow ledger; a per-run sink reset must
    // not wipe the rows other runs still depend on.
    expect(primary.totals().attempts).toBe(1);
    expect(secondary.totals().attempts).toBe(0);
  });
});

describe("appendModelTelemetry", () => {
  const cwd = "/tmp/worktree";

  it("preserves the first workflow's rows when a fresh store appends later", () => {
    const fs = createFakeFs();

    const first = appendModelTelemetry({
      cwd,
      stats: [sampleRow({ model: "workflow-one" })],
      fs,
      now: () => 10,
    });
    expect(first.ok).toBe(true);

    // A fresh process store (empty) appends the second workflow's rows.
    const second = appendModelTelemetry({
      cwd,
      stats: [sampleRow({ model: "workflow-two" })],
      fs,
      now: () => 20,
    });
    expect(second.ok).toBe(true);

    const snapshot = readModelTelemetry({ cwd, fs });
    expect(snapshot?.stats.map((row) => row.model)).toEqual(["workflow-one", "workflow-two"]);
    expect(snapshot?.totals.attempts).toBe(2);
    expect(snapshot).toHaveProperty("updatedAt", 20);
  });

  it("replaces a corrupt existing file with the new rows instead of failing", () => {
    const fs = createFakeFs({ [modelTelemetryPath(cwd)]: "{ not valid json" });

    const result = appendModelTelemetry({
      cwd,
      stats: [sampleRow({ model: "fresh" })],
      fs,
      now: () => 5,
    });

    expect(result).toEqual({ ok: true, snapshot: expect.objectContaining({ updatedAt: 5 }) });
    const snapshot = readModelTelemetry({ cwd, fs });
    expect(snapshot?.stats.map((row) => row.model)).toEqual(["fresh"]);
    expect(snapshot?.totals.attempts).toBe(1);
  });

  it("returns an error and leaves prior history intact when the write fails", () => {
    const fs = createFakeFs();
    const first = appendModelTelemetry({
      cwd,
      stats: [sampleRow({ model: "first" })],
      fs,
      now: () => 1,
    });
    expect(first.ok).toBe(true);

    const failing: WorkflowFs = {
      ...fs,
      writeFileSync: () => {
        throw new Error("disk full");
      },
    };
    const result = appendModelTelemetry({
      cwd,
      stats: [sampleRow({ model: "second" })],
      fs: failing,
      now: () => 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("disk full");
    // The read-modify-write must not have truncated the existing snapshot: the
    // failure happens before the rename, so the original file is untouched.
    const snapshot = readModelTelemetry({ cwd, fs });
    expect(snapshot?.stats.map((row) => row.model)).toEqual(["first"]);
  });
});

describe("readModelTelemetry validation", () => {
  const cwd = "/tmp/worktree";

  it("returns undefined for schema-valid JSON of the wrong shape", () => {
    const wrongShape = createFakeFs({
      [modelTelemetryPath(cwd)]: JSON.stringify({
        schemaVersion: 1,
        stats: [{ phase: 1, model: true }],
        totals: { attempts: 1 },
        updatedAt: "yesterday",
      }),
    });
    expect(readModelTelemetry({ cwd, fs: wrongShape })).toBeUndefined();
  });

  it("returns undefined for a valid-shape file with a bad totals row", () => {
    const badTotals = createFakeFs({
      [modelTelemetryPath(cwd)]: JSON.stringify({
        schemaVersion: 1,
        stats: [],
        totals: { attempts: -1, fallbacks: 0, quotaFailures: 0, noOps: 0, cost: 0 },
        updatedAt: 1,
      }),
    });
    expect(readModelTelemetry({ cwd, fs: badTotals })).toBeUndefined();
  });
});
