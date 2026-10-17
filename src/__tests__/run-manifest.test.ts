import { describe, expect, it } from "vitest";

import {
  completeRunByUser,
  listPendingUserCompletions,
  listRuns,
  markRunDelivered,
  parseRunManifest,
  type RunManifest,
  type RunManifestFs,
  RunStatus,
  readRunManifest,
  runManifestPath,
  scanForInterruptedRuns,
  setRunStatus,
  setRunTelemetry,
  writeRunManifest,
} from "../run-manifest.js";

interface FakeFs extends RunManifestFs {
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
    readdirSync(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names: string[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest === "" || rest.includes("/")) continue;
        names.push(rest);
      }
      return names;
    },
  };
}

const cwd = "/tmp/worktree";

function sampleManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    runId: "abc123",
    taskId: "bd-42",
    phase: "plan",
    sessionName: "belayd-bd-42-sub-plan-abc123",
    status: RunStatus.Running,
    startedAt: 1_000,
    model: "opencode-go/deepseek-v4-flash",
    ...overrides,
  };
}

describe("run manifest", () => {
  it("round-trips a run manifest through write and read", () => {
    const fs = createFakeFs();
    const manifest = sampleManifest();

    expect(writeRunManifest({ cwd, manifest, fs })).toEqual({ ok: true });
    expect(readRunManifest({ cwd, runId: manifest.runId, fs })).toEqual(manifest);
  });

  it("setRunStatus transitions to completed and records completedAt", () => {
    const fs = createFakeFs();
    const manifest = sampleManifest();
    writeRunManifest({ cwd, manifest, fs });

    const result = setRunStatus({
      cwd,
      runId: manifest.runId,
      status: RunStatus.Completed,
      exitCode: 0,
      fs,
      now: () => 5_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: manifest.runId, fs });
    expect(reloaded).toHaveProperty("status", "completed");
    expect(reloaded).toHaveProperty("completedAt", 5_000);
    expect(reloaded).toHaveProperty("exitCode", 0);
  });

  it("setRunStatus leaves completedAt unset for a running status", () => {
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: sampleManifest(), fs });

    setRunStatus({ cwd, runId: "abc123", status: RunStatus.Running, fs, now: () => 5_000 });

    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("status", "running");
    expect(reloaded).not.toHaveProperty("completedAt");
  });

  it("setRunStatus preserves all core fields across a running→completed transition", () => {
    const fs = createFakeFs();
    const manifest = sampleManifest({
      runId: "run-42",
      taskId: "bd-99",
      phase: "implement",
      sessionName: "belayd-bd-99-sub-implement-run-42",
      startedAt: 11_111,
      model: "gpt-5-mini",
    });
    writeRunManifest({ cwd, manifest, fs });

    const result = setRunStatus({
      cwd,
      runId: manifest.runId,
      status: RunStatus.Completed,
      exitCode: 0,
      fs,
      now: () => 12_345,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: manifest.runId, fs });
    expect(reloaded).toHaveProperty("runId", "run-42");
    expect(reloaded).toHaveProperty("taskId", "bd-99");
    expect(reloaded).toHaveProperty("phase", "implement");
    expect(reloaded).toHaveProperty("sessionName", "belayd-bd-99-sub-implement-run-42");
    expect(reloaded).toHaveProperty("startedAt", 11_111);
    expect(reloaded).toHaveProperty("model", "gpt-5-mini");
  });

  it("setRunStatus records a failureReason and it round-trips through read", () => {
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: sampleManifest(), fs });

    const result = setRunStatus({
      cwd,
      runId: "abc123",
      status: RunStatus.Failed,
      exitCode: 0,
      failureReason: "Sub-agent completed with exit code 0 but made no tool calls",
      fs,
      now: () => 5_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("status", "failed");
    expect(reloaded).toHaveProperty("exitCode", 0);
    expect(reloaded).toHaveProperty(
      "failureReason",
      "Sub-agent completed with exit code 0 but made no tool calls",
    );
  });

  it("parses a legacy manifest without failureReason", () => {
    const legacy = sampleManifest();
    expect(legacy).not.toHaveProperty("failureReason");
    const parsed = parseRunManifest(legacy);
    expect(parsed).toHaveProperty("runId", "abc123");
    expect(parsed).not.toHaveProperty("failureReason");
  });

  it("setRunStatus clears a stale failureReason on a Completed transition", () => {
    const fs = createFakeFs();
    writeRunManifest({
      cwd,
      manifest: sampleManifest({
        status: RunStatus.Failed,
        failureReason: "stale reason from a prior attempt",
      }),
      fs,
    });

    const result = setRunStatus({
      cwd,
      runId: "abc123",
      status: RunStatus.Completed,
      exitCode: 0,
      fs,
      now: () => 6_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("status", "completed");
    expect(reloaded).not.toHaveProperty("failureReason");
  });

  it("setRunStatus keeps failureReason absent when Failed is written without one", () => {
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: sampleManifest(), fs });

    setRunStatus({ cwd, runId: "abc123", status: RunStatus.Failed, fs, now: () => 7_000 });

    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("status", "failed");
    expect(reloaded).not.toHaveProperty("failureReason");
  });

  it("setRunStatus drops a stale completedAt when status returns to running", () => {
    const fs = createFakeFs();
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ status: RunStatus.Completed, completedAt: 9_000 }),
      fs,
    });

    const result = setRunStatus({
      cwd,
      runId: "abc123",
      status: RunStatus.Running,
      fs,
      now: () => 10_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("status", "running");
    expect(reloaded).not.toHaveProperty("completedAt");
  });

  it("setRunStatus returns an error for an unknown run id", () => {
    const fs = createFakeFs();
    const result = setRunStatus({ cwd, runId: "missing", status: RunStatus.Failed, fs });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No run manifest");
  });

  it("listRuns sorts by startedAt and skips malformed and non-json entries", () => {
    const fs = createFakeFs({
      [runManifestPath(cwd, "later")]: JSON.stringify(
        sampleManifest({ runId: "later", startedAt: 3_000 }),
      ),
      [runManifestPath(cwd, "earlier")]: JSON.stringify(
        sampleManifest({ runId: "earlier", startedAt: 1_000 }),
      ),
      [runManifestPath(cwd, "broken")]: "not json",
      [runManifestPath(cwd, "note").replace(".json", ".txt")]: "ignored",
    });

    const runs = listRuns({ cwd, fs });
    expect(runs.map((run) => run.runId)).toEqual(["earlier", "later"]);
  });

  it("listRuns returns an empty list when the runs directory is missing", () => {
    const fs = createFakeFs();
    expect(listRuns({ cwd, fs })).toEqual([]);
  });

  it("scanForInterruptedRuns only flips running manifests", () => {
    const fs = createFakeFs({
      [runManifestPath(cwd, "running1")]: JSON.stringify(
        sampleManifest({ runId: "running1", status: RunStatus.Running }),
      ),
      [runManifestPath(cwd, "done")]: JSON.stringify(
        sampleManifest({ runId: "done", status: RunStatus.Completed, completedAt: 2_000 }),
      ),
      [runManifestPath(cwd, "running2")]: JSON.stringify(
        sampleManifest({ runId: "running2", status: RunStatus.Running }),
      ),
    });

    const interrupted = scanForInterruptedRuns({ cwd, fs, now: () => 9_000 });

    expect(interrupted.map((run) => run.runId).sort()).toEqual(["running1", "running2"]);
    expect(readRunManifest({ cwd, runId: "running1", fs })).toHaveProperty("status", "interrupted");
    expect(readRunManifest({ cwd, runId: "running2", fs })).toHaveProperty("completedAt", 9_000);
    expect(readRunManifest({ cwd, runId: "done", fs })).toHaveProperty("status", "completed");
  });

  it("parseRunManifest rejects malformed fields and wrong versions", () => {
    expect(parseRunManifest(null)).toBe(undefined);
    expect(parseRunManifest({ ...sampleManifest(), schemaVersion: 2 })).toBe(undefined);
    expect(parseRunManifest({ ...sampleManifest(), status: "paused" })).toBe(undefined);
    expect(parseRunManifest({ ...sampleManifest(), startedAt: "now" })).toBe(undefined);
  });

  it("parses a legacy manifest without the user-completion fields", () => {
    const parsed = parseRunManifest(sampleManifest());
    expect(parsed).toHaveProperty("runId", "abc123");
    expect(parsed).not.toHaveProperty("completionReport");
    expect(parsed).not.toHaveProperty("completedBy");
    expect(parsed).not.toHaveProperty("deliveredAt");
  });

  it("completeRunByUser records the report, clears failureReason, and round-trips", () => {
    const fs = createFakeFs();
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ status: RunStatus.Failed, failureReason: "stale failure" }),
      fs,
    });

    const result = completeRunByUser({
      cwd,
      runId: "abc123",
      report: "recovered final answer",
      fs,
      now: () => 8_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("status", "completed");
    expect(reloaded).toHaveProperty("completedAt", 8_000);
    expect(reloaded).toHaveProperty("completionReport", "recovered final answer");
    expect(reloaded).toHaveProperty("completedBy", "user");
    expect(reloaded).not.toHaveProperty("failureReason");
    expect(reloaded).not.toHaveProperty("deliveredAt");
  });

  it("completeRunByUser returns an error for an unknown run id", () => {
    const fs = createFakeFs();
    const result = completeRunByUser({ cwd, runId: "missing", report: "x", fs });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No run manifest");
  });

  it("markRunDelivered stamps deliveredAt and preserves completion fields", () => {
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: sampleManifest(), fs });
    completeRunByUser({ cwd, runId: "abc123", report: "answer", fs, now: () => 1_000 });

    const result = markRunDelivered({ cwd, runId: "abc123", fs, now: () => 9_000 });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("deliveredAt", 9_000);
    expect(reloaded).toHaveProperty("completionReport", "answer");
    expect(reloaded).toHaveProperty("completedBy", "user");
  });

  it("listPendingUserCompletions returns only undelivered user completions", () => {
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: sampleManifest({ runId: "pending" }), fs });
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ runId: "delivered" }),
      fs,
    });
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ runId: "watcher", status: RunStatus.Completed }),
      fs,
    });
    completeRunByUser({ cwd, runId: "pending", report: "p", fs });
    completeRunByUser({ cwd, runId: "delivered", report: "d", fs });
    markRunDelivered({ cwd, runId: "delivered", fs });

    const pending = listPendingUserCompletions({ cwd, fs });

    expect(pending.map((run) => run.runId)).toEqual(["pending"]);
  });

  it("listPendingUserCompletions is empty when there are no user completions", () => {
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: sampleManifest(), fs });
    expect(listPendingUserCompletions({ cwd, fs })).toEqual([]);
  });

  it("listPendingUserCompletions excludes a user completion with no report", () => {
    const fs = createFakeFs();
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ runId: "noreport", completedBy: "user" }),
      fs,
    });

    expect(listPendingUserCompletions({ cwd, fs })).toEqual([]);
  });

  it("listPendingUserCompletions excludes a user completion with an empty report string", () => {
    const fs = createFakeFs();
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ runId: "emptyreport", completedBy: "user", completionReport: "" }),
      fs,
    });

    expect(listPendingUserCompletions({ cwd, fs })).toEqual([]);
  });

  it("markRunDelivered returns an error for an unknown run id", () => {
    const fs = createFakeFs();
    const result = markRunDelivered({ cwd, runId: "missing", fs });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No run manifest");
  });

  it("completeRunByUser leaves an existing deliveredAt intact so a re-completion cannot re-deliver", () => {
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: sampleManifest(), fs });
    completeRunByUser({ cwd, runId: "abc123", report: "first", fs, now: () => 1_000 });
    markRunDelivered({ cwd, runId: "abc123", fs, now: () => 2_000 });

    completeRunByUser({ cwd, runId: "abc123", report: "second", fs, now: () => 3_000 });

    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("deliveredAt", 2_000);
    expect(reloaded).toHaveProperty("completionReport", "second");
    expect(listPendingUserCompletions({ cwd, fs })).toEqual([]);
  });

  it("setRunTelemetry attaches totals and preserves the rest of the manifest", () => {
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: sampleManifest(), fs });

    const result = setRunTelemetry({
      cwd,
      runId: "abc123",
      telemetry: { attempts: 3, fallbacks: 1, quotaFailures: 1, noOps: 1, cost: 0.42 },
      fs,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("telemetry.attempts", 3);
    expect(reloaded).toHaveProperty("telemetry.fallbacks", 1);
    expect(reloaded).toHaveProperty("telemetry.quotaFailures", 1);
    expect(reloaded).toHaveProperty("telemetry.noOps", 1);
    expect(reloaded).toHaveProperty("telemetry.cost", 0.42);
    expect(reloaded).toHaveProperty("phase", "plan");
  });

  it("setRunTelemetry returns an error for an unknown run id", () => {
    const fs = createFakeFs();
    const result = setRunTelemetry({
      cwd,
      runId: "missing",
      telemetry: { attempts: 0, fallbacks: 0, quotaFailures: 0, noOps: 0, cost: 0 },
      fs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No run manifest");
  });
});
