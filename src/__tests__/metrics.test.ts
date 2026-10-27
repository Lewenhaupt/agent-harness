import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendMetricsEvent,
  buildGateResultEvent,
  buildPhaseAdvanceEvent,
  buildReviewFindingsEvent,
  buildRunEndEvent,
  buildRunStartEvent,
  METRICS_DIR_ENV,
  METRICS_ENABLED_ENV,
  metricsFilePath,
  metricsHostname,
  resolveMetricsDir,
} from "../metrics.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-metrics-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveMetricsDir", () => {
  it("defaults to the XDG state root", () => {
    expect(resolveMetricsDir({ env: { XDG_STATE_HOME: "/state" } })).toBe(
      join("/state", "belayd", "metrics"),
    );
  });

  it("prefers an explicit override", () => {
    expect(
      resolveMetricsDir({ env: { [METRICS_DIR_ENV]: "/custom", XDG_STATE_HOME: "/state" } }),
    ).toBe("/custom");
  });

  it("treats a blank override as unset", () => {
    expect(resolveMetricsDir({ env: { [METRICS_DIR_ENV]: "  ", XDG_STATE_HOME: "/state" } })).toBe(
      join("/state", "belayd", "metrics"),
    );
  });

  it.each(["0", "false", "off", "OFF"])("disables on %s", (value) => {
    expect(
      resolveMetricsDir({ env: { [METRICS_ENABLED_ENV]: value, XDG_STATE_HOME: "/state" } }),
    ).toBe(undefined);
  });

  it("stays enabled for any other value", () => {
    expect(resolveMetricsDir({ env: { [METRICS_ENABLED_ENV]: "1", XDG_STATE_HOME: "/s" } })).toBe(
      join("/s", "belayd", "metrics"),
    );
  });
});

describe("metricsFilePath", () => {
  it("rotates monthly in UTC", () => {
    // 2026-01-01T00:30Z is still January everywhere that matters here.
    expect(metricsFilePath({ dir: "/m", now: Date.UTC(2026, 0, 1, 0, 30) })).toBe(
      join("/m", "events-2026-01.jsonl"),
    );
    expect(metricsFilePath({ dir: "/m", now: Date.UTC(2026, 11, 31, 23, 0) })).toBe(
      join("/m", "events-2026-12.jsonl"),
    );
  });
});

describe("appendMetricsEvent", () => {
  it("appends one JSON line per event", () => {
    const dir = tempDir();
    const event = buildGateResultEvent({
      now: Date.UTC(2026, 4, 2),
      host: "h",
      task: "bd-1",
      phase: "implement",
      runId: "r1",
      attempt: 1,
      passed: false,
      durationMs: 1200,
    });

    const first = appendMetricsEvent({ env: { [METRICS_DIR_ENV]: dir }, event });
    const second = appendMetricsEvent({
      env: { [METRICS_DIR_ENV]: dir },
      event: { ...event, attempt: 2, passed: true },
    });

    expect(first).toHaveProperty("ok", true);
    expect(second).toHaveProperty("ok", true);
    const lines = readFileSync(join(dir, "events-2026-05.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toHaveProperty("attempt", 1);
    expect(JSON.parse(lines[1] ?? "{}")).toHaveProperty("passed", true);
  });

  it("reports a disabled log without touching the filesystem", () => {
    const dir = tempDir();
    const result = appendMetricsEvent({
      env: { [METRICS_DIR_ENV]: dir, [METRICS_ENABLED_ENV]: "0" },
      event: buildPhaseAdvanceEvent({
        now: Date.now(),
        host: "h",
        task: "bd-1",
        phase: "implement",
        nextPhase: "review",
      }),
    });

    expect(result).toHaveProperty("ok", false);
    expect(result).toHaveProperty("disabled", true);
  });

  it("returns an error result instead of throwing when the directory is unusable", () => {
    const parent = tempDir();
    const blockingFile = join(parent, "blocker");
    writeFileSync(blockingFile, "not a directory", "utf8");

    const result = appendMetricsEvent({
      // The directory path resolves *through* a regular file, so mkdir fails.
      env: { [METRICS_DIR_ENV]: join(blockingFile, "metrics") },
      event: buildPhaseAdvanceEvent({
        now: Date.now(),
        host: "h",
        task: "bd-1",
        phase: "implement",
        nextPhase: "review",
      }),
    });

    expect(result).toHaveProperty("ok", false);
    expect(result).not.toHaveProperty("disabled");
  });
});

describe("event builders", () => {
  it("carries the fields the queries need", () => {
    const now = Date.UTC(2026, 4, 2, 10, 0);
    const start = buildRunStartEvent({
      now,
      host: "h",
      task: "bd-1",
      phase: "review",
      runId: "r1",
      workflowType: "feature",
      model: "deepseek-v4.1-flash",
    });
    expect(start).toHaveProperty("event", "run_start");
    expect(start).toHaveProperty("task", "bd-1");
    expect(start).toHaveProperty("workflowType", "feature");

    const end = buildRunEndEvent({
      now,
      host: "h",
      task: "bd-1",
      phase: "review",
      runId: "r1",
      status: "passed",
      exitCode: 0,
      toolCalls: 42,
      cost: 0.19,
      tokensIn: 1000,
      tokensOut: 200,
      tokensCacheRead: 50_000,
      wallMs: 600_000,
    });
    expect(end).toHaveProperty("event", "run_end");
    expect(end).toHaveProperty("toolCalls", 42);
    expect(end).not.toHaveProperty("model");
  });

  it("omits optional fields instead of emitting undefined", () => {
    const gate = buildGateResultEvent({
      now: 1,
      host: "h",
      task: "t",
      phase: "test",
      runId: "r1",
      attempt: 1,
      passed: true,
      durationMs: 5,
    });
    expect(gate).not.toHaveProperty("failureKind");
    expect(JSON.stringify(gate)).not.toContain("undefined");
  });

  it("matches the bead-140 event schema for every event kind", () => {
    const now = Date.UTC(2026, 4, 2, 10, 0);
    const base = { now, host: "h", task: "bd-1" };

    const start = buildRunStartEvent({
      ...base,
      phase: "implement",
      runId: "r1",
      workflowType: "feature",
      model: "m",
      session: "s",
    });
    expect(Object.keys(start).sort()).toEqual(
      ["event", "host", "model", "phase", "runId", "session", "task", "ts", "workflowType"].sort(),
    );

    const gate = buildGateResultEvent({
      ...base,
      phase: "implement",
      runId: "r1",
      attempt: 1,
      passed: true,
      durationMs: 10,
      failureKind: "test",
    });
    expect(Object.keys(gate).sort()).toEqual(
      [
        "attempt",
        "durationMs",
        "event",
        "failureKind",
        "host",
        "passed",
        "phase",
        "runId",
        "task",
        "ts",
      ].sort(),
    );

    const end = buildRunEndEvent({
      ...base,
      phase: "implement",
      runId: "r1",
      status: "completed",
      exitCode: 0,
      toolCalls: 1,
      cost: 0.01,
      tokensIn: 1,
      tokensOut: 2,
      tokensCacheRead: 3,
      wallMs: 4,
    });
    // The bead writes tokens{in,out,cacheRead}; the flat keys are the same
    // three numbers without a nested object DuckDB would have to unnest.
    expect(end).toHaveProperty("tokensIn", 1);
    expect(end).toHaveProperty("tokensOut", 2);
    expect(end).toHaveProperty("tokensCacheRead", 3);
    expect(end).toHaveProperty("exitCode");
    expect(end).toHaveProperty("cost");
    expect(end).toHaveProperty("wallMs");

    const advance = buildPhaseAdvanceEvent({ ...base, phase: "implement", nextPhase: "review" });
    expect(advance).toHaveProperty("nextPhase", "review");

    const review = buildReviewFindingsEvent({
      ...base,
      critical: 1,
      warnings: 2,
      suggestions: 3,
    });
    expect(Object.keys(review).sort()).toEqual(
      ["critical", "event", "host", "suggestions", "task", "ts", "warnings"].sort(),
    );
  });
});

describe("metricsHostname", () => {
  it("falls back to unknown when the lookup throws", () => {
    expect(
      metricsHostname({
        hostname: () => {
          throw new Error("boom");
        },
      }),
    ).toBe("unknown");
  });

  it("uses the injected lookup", () => {
    expect(metricsHostname({ hostname: () => "host-1" })).toBe("host-1");
  });
});
