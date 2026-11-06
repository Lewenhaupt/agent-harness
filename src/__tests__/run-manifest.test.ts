import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openRepoStateStore, type RepoStateStore } from "../repo-state-store.js";
import {
  completeRunByUser,
  isSafeRunId,
  listPendingUserCompletions,
  listRuns,
  markRunDelivered,
  parseRunManifest,
  type RunManifest,
  RunStatus,
  readRunManifest,
  runBelongsToTask,
  scanForInterruptedRuns,
  setRunModelSelection,
  setRunStatus,
  setRunTelemetry,
  writeRunManifest,
} from "../run-manifest.js";

let dir: string;
let storePath: string;
let store: RepoStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "belayd-run-manifest-"));
  storePath = join(dir, "state.sqlite");
  const opened = openRepoStateStore({ path: storePath });
  if (!opened.ok) throw new Error(opened.error);
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Seed run rows the way the old fixture maps did.
 *
 * A body that does not parse becomes a row whose payload the record schema
 * rejects, which is the store analogue of an unparseable manifest file: invisible
 * to every reader, never rewritten.
 */
function seedRuns(entries: Record<string, string>): void {
  const database = new DatabaseSync(storePath);
  const insert = database.prepare(
    "INSERT OR REPLACE INTO run_manifest (run_id, task_id, status, payload, updated_at) VALUES (?, '', '', ?, ?)",
  );
  for (const [key, body] of Object.entries(entries)) {
    // Keys are run ids; a key that names a non-run file (`notes.md`) is ignored, the
    // way the runs directory ignored non-`.json` entries.
    if (key.includes("/") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) continue;
    insert.run(key, body, Date.now());
  }
  database.close();
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
    seedRuns({});
    const manifest = sampleManifest();

    expect(writeRunManifest({ cwd, manifest, store })).toEqual({ ok: true });
    expect(readRunManifest({ cwd, runId: manifest.runId, store })).toEqual(manifest);
  });

  it("setRunStatus transitions to completed and records completedAt", () => {
    seedRuns({});
    const manifest = sampleManifest();
    writeRunManifest({ cwd, manifest, store });

    const result = setRunStatus({
      cwd,
      runId: manifest.runId,
      status: RunStatus.Completed,
      exitCode: 0,
      store,
      now: () => 5_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: manifest.runId, store });
    expect(reloaded).toHaveProperty("status", "completed");
    expect(reloaded).toHaveProperty("completedAt", 5_000);
    expect(reloaded).toHaveProperty("exitCode", 0);
  });

  it("setRunStatus leaves completedAt unset for a running status", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: sampleManifest(), store });

    setRunStatus({ cwd, runId: "abc123", status: RunStatus.Running, store, now: () => 5_000 });

    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    expect(reloaded).toHaveProperty("status", "running");
    expect(reloaded).not.toHaveProperty("completedAt");
  });

  it("setRunStatus preserves all core fields across a running→completed transition", () => {
    seedRuns({});
    const manifest = sampleManifest({
      runId: "run-42",
      taskId: "bd-99",
      phase: "implement",
      sessionName: "belayd-bd-99-sub-implement-run-42",
      startedAt: 11_111,
      model: "gpt-5-mini",
    });
    writeRunManifest({ cwd, manifest, store });

    const result = setRunStatus({
      cwd,
      runId: manifest.runId,
      status: RunStatus.Completed,
      exitCode: 0,
      store,
      now: () => 12_345,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: manifest.runId, store });
    expect(reloaded).toHaveProperty("runId", "run-42");
    expect(reloaded).toHaveProperty("taskId", "bd-99");
    expect(reloaded).toHaveProperty("phase", "implement");
    expect(reloaded).toHaveProperty("sessionName", "belayd-bd-99-sub-implement-run-42");
    expect(reloaded).toHaveProperty("startedAt", 11_111);
    expect(reloaded).toHaveProperty("model", "gpt-5-mini");
  });

  it("setRunStatus records a failureReason and it round-trips through read", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: sampleManifest(), store });

    const result = setRunStatus({
      cwd,
      runId: "abc123",
      status: RunStatus.Failed,
      exitCode: 0,
      failureReason: "Sub-agent completed with exit code 0 but made no tool calls",
      store,
      now: () => 5_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
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
    seedRuns({});
    writeRunManifest({
      cwd,
      manifest: sampleManifest({
        status: RunStatus.Failed,
        failureReason: "stale reason from a prior attempt",
      }),
      store,
    });

    const result = setRunStatus({
      cwd,
      runId: "abc123",
      status: RunStatus.Completed,
      exitCode: 0,
      store,
      now: () => 6_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    expect(reloaded).toHaveProperty("status", "completed");
    expect(reloaded).not.toHaveProperty("failureReason");
  });

  it("setRunStatus keeps failureReason absent when Failed is written without one", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: sampleManifest(), store });

    setRunStatus({ cwd, runId: "abc123", status: RunStatus.Failed, store, now: () => 7_000 });

    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    expect(reloaded).toHaveProperty("status", "failed");
    expect(reloaded).not.toHaveProperty("failureReason");
  });

  it("setRunStatus drops a stale completedAt when status returns to running", () => {
    seedRuns({});
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ status: RunStatus.Completed, completedAt: 9_000 }),
      store,
    });

    const result = setRunStatus({
      cwd,
      runId: "abc123",
      status: RunStatus.Running,
      store,
      now: () => 10_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    expect(reloaded).toHaveProperty("status", "running");
    expect(reloaded).not.toHaveProperty("completedAt");
  });

  it("setRunStatus returns an error for an unknown run id", () => {
    seedRuns({});
    const result = setRunStatus({ cwd, runId: "missing", status: RunStatus.Failed, store });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No run manifest");
  });

  it("listRuns sorts by startedAt and skips malformed and non-json entries", () => {
    seedRuns({
      later: JSON.stringify(sampleManifest({ runId: "later", startedAt: 3_000 })),
      earlier: JSON.stringify(sampleManifest({ runId: "earlier", startedAt: 1_000 })),
      broken: "not json",
      "note.txt": "ignored",
    });

    const runs = listRuns({ cwd, store });
    expect(runs.map((run) => run.runId)).toEqual(["earlier", "later"]);
  });

  it("listRuns returns an empty list when the runs directory is missing", () => {
    seedRuns({});
    expect(listRuns({ cwd, store })).toEqual([]);
  });

  it("scanForInterruptedRuns only flips running manifests", () => {
    seedRuns({
      running1: JSON.stringify(sampleManifest({ runId: "running1", status: RunStatus.Running })),
      done: JSON.stringify(
        sampleManifest({ runId: "done", status: RunStatus.Completed, completedAt: 2_000 }),
      ),
      running2: JSON.stringify(sampleManifest({ runId: "running2", status: RunStatus.Running })),
    });

    const interrupted = scanForInterruptedRuns({ cwd, store, now: () => 9_000 });

    expect(interrupted.map((run) => run.runId).sort()).toEqual(["running1", "running2"]);
    expect(readRunManifest({ cwd, runId: "running1", store })).toHaveProperty(
      "status",
      "interrupted",
    );
    expect(readRunManifest({ cwd, runId: "running2", store })).toHaveProperty("completedAt", 9_000);
    expect(readRunManifest({ cwd, runId: "done", store })).toHaveProperty("status", "completed");
  });

  it("scanForInterruptedRuns leaves another task's running manifest alone (bd-242)", () => {
    seedRuns({
      own: JSON.stringify(sampleManifest({ runId: "own", status: RunStatus.Running })),
      foreign: JSON.stringify(
        sampleManifest({ runId: "foreign", taskId: "bd-37", status: RunStatus.Running }),
      ),
    });

    const interrupted = scanForInterruptedRuns({ cwd, store, taskId: "bd-42", now: () => 9_000 });

    expect(interrupted.map((run) => run.runId)).toEqual(["own"]);
    // Flipping it would attribute bd-37's crashed run to bd-42 when the gate arms.
    expect(readRunManifest({ cwd, runId: "foreign", store })).toHaveProperty("status", "running");
  });

  it("runBelongsToTask keeps a sub-bead's manifest and rejects a foreign one", () => {
    expect(runBelongsToTask(sampleManifest(), "bd-42")).toBe(true);
    expect(runBelongsToTask(sampleManifest({ taskId: "bd-42.1" }), "bd-42")).toBe(true);
    expect(runBelongsToTask(sampleManifest({ taskId: "bd-37" }), "bd-42")).toBe(false);
    // An id that only shares a prefix is another bead, not a descendant.
    expect(runBelongsToTask(sampleManifest({ taskId: "bd-42x" }), "bd-42")).toBe(false);
    expect(runBelongsToTask(sampleManifest({ taskId: "bd-43" }), "bd-42")).toBe(false);
  });

  it("listRuns filters by task id when the caller names its bead", () => {
    seedRuns({
      own: JSON.stringify(sampleManifest({ runId: "own", startedAt: 1_000 })),
      child: JSON.stringify(
        sampleManifest({ runId: "child", taskId: "bd-42.1", startedAt: 2_000 }),
      ),
      foreign: JSON.stringify(
        sampleManifest({ runId: "foreign", taskId: "bd-37", startedAt: 3_000 }),
      ),
    });

    expect(listRuns({ cwd, store }).map((run) => run.runId)).toEqual(["own", "child", "foreign"]);
    expect(listRuns({ cwd, store, taskId: "bd-42" }).map((run) => run.runId)).toEqual([
      "own",
      "child",
    ]);
  });

  it("a mismatched body is invisible to readRunManifest and no RMW rewrites another row", () => {
    // The craft: row `aaa` claims `bbb`'s id *and* bd-42's task, so a body-trusting
    // read-modify-write would write bbb's row for a request against aaa.
    const mismatched = JSON.stringify(sampleManifest({ runId: "bbb", taskId: "bd-42" }));
    seedRuns({ aaa: mismatched });

    expect(readRunManifest({ cwd, runId: "aaa", store })).toBe(undefined);

    const noRun = { ok: false, error: "No run manifest found for aaa" };
    expect(setRunStatus({ cwd, runId: "aaa", status: RunStatus.Interrupted, store })).toEqual(
      noRun,
    );
    expect(completeRunByUser({ cwd, runId: "aaa", report: "done", store })).toEqual(noRun);
    expect(markRunDelivered({ cwd, runId: "aaa", store })).toEqual(noRun);
    const telemetry = { attempts: 1, fallbacks: 0, quotaFailures: 0, noOps: 0, cost: 0 };
    expect(setRunTelemetry({ cwd, runId: "aaa", telemetry, store })).toEqual(noRun);
    expect(setRunModelSelection({ cwd, runId: "aaa", requestedModel: "x/y", store })).toEqual(
      noRun,
    );

    // Nothing was created or rewritten under the body's id: the row key is the
    // authority (bd-242), and the mismatched row is left exactly as it was.
    expect(readRunManifest({ cwd, runId: "bbb", store })).toBe(undefined);
    expect(readRunManifest({ cwd, runId: "aaa", store })).toBe(undefined);
  });

  it("scanForInterruptedRuns never rewrites a row its body runId does not own (bd-242 review)", () => {
    seedRuns({
      // Row `aaa` claims `bbb`'s id: following it would flip bbb's run, which is
      // not the row that was read.
      aaa: JSON.stringify(sampleManifest({ runId: "bbb", status: RunStatus.Running })),
      bbb: JSON.stringify(
        sampleManifest({ runId: "bbb", status: RunStatus.Completed, completedAt: 2_000 }),
      ),
    });

    expect(scanForInterruptedRuns({ cwd, store, now: () => 9_000 })).toEqual([]);
    expect(readRunManifest({ cwd, runId: "bbb", store })).toHaveProperty("status", "completed");
  });

  it("rejects and refuses to write an unsafe run id", () => {
    expect(isSafeRunId("abc123")).toBe(true);
    expect(isSafeRunId("pending-run")).toBe(true);
    expect(isSafeRunId("../../EVIL")).toBe(false);
    expect(isSafeRunId("..")).toBe(false);
    expect(isSafeRunId("a/b")).toBe(false);
    expect(parseRunManifest(sampleManifest({ runId: "../../EVIL" }))).toBe(undefined);

    expect(
      writeRunManifest({ cwd, store, manifest: sampleManifest({ runId: "../escape" }) }),
    ).toEqual({ ok: false, error: 'unsafe run id "../escape"' });
    expect(listRuns({ cwd, store })).toEqual([]);
    expect(readRunManifest({ cwd, store, runId: "../escape" })).toBe(undefined);
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
    seedRuns({});
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ status: RunStatus.Failed, failureReason: "stale failure" }),
      store,
    });

    const result = completeRunByUser({
      cwd,
      runId: "abc123",
      report: "recovered final answer",
      store,
      now: () => 8_000,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    expect(reloaded).toHaveProperty("status", "completed");
    expect(reloaded).toHaveProperty("completedAt", 8_000);
    expect(reloaded).toHaveProperty("completionReport", "recovered final answer");
    expect(reloaded).toHaveProperty("completedBy", "user");
    expect(reloaded).not.toHaveProperty("failureReason");
    expect(reloaded).not.toHaveProperty("deliveredAt");
  });

  it("completeRunByUser returns an error for an unknown run id", () => {
    seedRuns({});
    const result = completeRunByUser({ cwd, runId: "missing", report: "x", store });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No run manifest");
  });

  it("markRunDelivered stamps deliveredAt and preserves completion fields", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: sampleManifest(), store });
    completeRunByUser({ cwd, runId: "abc123", report: "answer", store, now: () => 1_000 });

    const result = markRunDelivered({ cwd, runId: "abc123", store, now: () => 9_000 });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    expect(reloaded).toHaveProperty("deliveredAt", 9_000);
    expect(reloaded).toHaveProperty("completionReport", "answer");
    expect(reloaded).toHaveProperty("completedBy", "user");
  });

  it("listPendingUserCompletions returns only undelivered user completions", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: sampleManifest({ runId: "pending" }), store });
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ runId: "delivered" }),
      store,
    });
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ runId: "watcher", status: RunStatus.Completed }),
      store,
    });
    completeRunByUser({ cwd, runId: "pending", report: "p", store });
    completeRunByUser({ cwd, runId: "delivered", report: "d", store });
    markRunDelivered({ cwd, runId: "delivered", store });

    const pending = listPendingUserCompletions({ cwd, store });

    expect(pending.map((run) => run.runId)).toEqual(["pending"]);
  });

  it("listPendingUserCompletions is empty when there are no user completions", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: sampleManifest(), store });
    expect(listPendingUserCompletions({ cwd, store })).toEqual([]);
  });

  it("listPendingUserCompletions excludes a user completion with no report", () => {
    seedRuns({});
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ runId: "noreport", completedBy: "user" }),
      store,
    });

    expect(listPendingUserCompletions({ cwd, store })).toEqual([]);
  });

  it("listPendingUserCompletions excludes a user completion with an empty report string", () => {
    seedRuns({});
    writeRunManifest({
      cwd,
      manifest: sampleManifest({ runId: "emptyreport", completedBy: "user", completionReport: "" }),
      store,
    });

    expect(listPendingUserCompletions({ cwd, store })).toEqual([]);
  });

  it("markRunDelivered returns an error for an unknown run id", () => {
    seedRuns({});
    const result = markRunDelivered({ cwd, runId: "missing", store });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No run manifest");
  });

  it("completeRunByUser leaves an existing deliveredAt intact so a re-completion cannot re-deliver", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: sampleManifest(), store });
    completeRunByUser({ cwd, runId: "abc123", report: "first", store, now: () => 1_000 });
    markRunDelivered({ cwd, runId: "abc123", store, now: () => 2_000 });

    completeRunByUser({ cwd, runId: "abc123", report: "second", store, now: () => 3_000 });

    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    expect(reloaded).toHaveProperty("deliveredAt", 2_000);
    expect(reloaded).toHaveProperty("completionReport", "second");
    expect(listPendingUserCompletions({ cwd, store })).toEqual([]);
  });

  it("setRunTelemetry attaches totals and preserves the rest of the manifest", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: sampleManifest(), store });

    const result = setRunTelemetry({
      cwd,
      runId: "abc123",
      telemetry: { attempts: 3, fallbacks: 1, quotaFailures: 1, noOps: 1, cost: 0.42 },
      store,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    expect(reloaded).toHaveProperty("telemetry.attempts", 3);
    expect(reloaded).toHaveProperty("telemetry.fallbacks", 1);
    expect(reloaded).toHaveProperty("telemetry.quotaFailures", 1);
    expect(reloaded).toHaveProperty("telemetry.noOps", 1);
    expect(reloaded).toHaveProperty("telemetry.cost", 0.42);
    expect(reloaded).toHaveProperty("phase", "plan");
  });

  it("setRunTelemetry returns an error for an unknown run id", () => {
    seedRuns({});
    const result = setRunTelemetry({
      cwd,
      runId: "missing",
      telemetry: { attempts: 0, fallbacks: 0, quotaFailures: 0, noOps: 0, cost: 0 },
      store,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No run manifest");
  });

  it("setRunModelSelection records the served model, the request and the skips", () => {
    seedRuns({});
    // The running manifest names the pre-dispatch pick only: it must never claim
    // a model served the run before anything was spawned.
    writeRunManifest({
      cwd,
      manifest: {
        ...sampleManifest(),
        model: undefined,
        requestedModel: "llmgateway/mimo-v2.6-flash",
      },
      store,
    });
    setRunTelemetry({
      cwd,
      runId: "abc123",
      telemetry: { attempts: 2, fallbacks: 1, quotaFailures: 1, noOps: 0, cost: 0.5 },
      store,
    });

    const result = setRunModelSelection({
      cwd,
      runId: "abc123",
      model: "commandcode/xiaomi/mimo-v2.6-flash",
      requestedModel: "llmgateway/mimo-v2.6-flash",
      skippedModels: [
        { model: "llmgateway/mimo-v2.6-flash", reason: "Provider llmgateway is cooling down" },
      ],
      store,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    // `model` is the one that actually served the run; the pre-dispatch pick is
    // preserved separately so the fallback stays visible.
    expect(reloaded).toHaveProperty("model", "commandcode/xiaomi/mimo-v2.6-flash");
    expect(reloaded).toHaveProperty("requestedModel", "llmgateway/mimo-v2.6-flash");
    expect(reloaded?.skippedModels).toEqual([
      { model: "llmgateway/mimo-v2.6-flash", reason: "Provider llmgateway is cooling down" },
    ]);
    // Read-modify-write: nothing else moves.
    expect(reloaded).toHaveProperty("status", RunStatus.Running);
    expect(reloaded).toHaveProperty("startedAt", 1_000);
    expect(reloaded).toHaveProperty("phase", "plan");
    expect(reloaded).toHaveProperty("telemetry.attempts", 2);
  });

  it("setRunModelSelection omits an empty skippedModels list", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: sampleManifest(), store });

    setRunModelSelection({
      cwd,
      runId: "abc123",
      model: "commandcode/z-ai/glm-5.3-flash",
      requestedModel: "commandcode/z-ai/glm-5.3-flash",
      store,
    });

    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    expect(reloaded).toHaveProperty("model", "commandcode/z-ai/glm-5.3-flash");
    expect(reloaded).not.toHaveProperty("skippedModels");
  });

  it("setRunModelSelection leaves `model` absent when nothing was dispatched", () => {
    seedRuns({});
    writeRunManifest({ cwd, manifest: { ...sampleManifest(), model: undefined }, store });

    setRunModelSelection({
      cwd,
      runId: "abc123",
      requestedModel: "commandcode/z-ai/glm-5.3-flash",
      skippedModels: [{ model: "llmgateway/mimo-v2.6-flash", reason: "cooling down" }],
      store,
    });

    const reloaded = readRunManifest({ cwd, runId: "abc123", store });
    // No spawn means no serving model: the pre-dispatch pick stays in
    // `requestedModel` and the skips explain why nothing ran.
    expect(reloaded).not.toHaveProperty("model");
    expect(reloaded).toHaveProperty("requestedModel", "commandcode/z-ai/glm-5.3-flash");
    expect(reloaded?.skippedModels).toEqual([
      { model: "llmgateway/mimo-v2.6-flash", reason: "cooling down" },
    ]);
  });

  it("setRunModelSelection returns an error for an unknown run id", () => {
    seedRuns({});
    const result = setRunModelSelection({
      cwd,
      runId: "missing",
      model: "commandcode/z-ai/glm-5.3-flash",
      requestedModel: "llmgateway/mimo-v2.6-flash",
      store,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No run manifest");
  });

  it("parses a manifest written before the model-selection fields existed", () => {
    const legacy = {
      schemaVersion: 1,
      runId: "legacy",
      taskId: "bd-42",
      phase: "implement",
      sessionName: "belayd-bd-42-sub-implement-legacy",
      status: "completed",
      startedAt: 1_000,
      model: "opencode-go/deepseek-v4-flash",
    };

    expect(parseRunManifest(legacy)).toEqual(legacy);
  });

  it("lists a run that records only the pre-dispatch pick", () => {
    // A run cancelled or all-skipped before dispatch has `requestedModel` and
    // `skippedModels` but no `model`: the reader and `listRuns` must surface it
    // without inventing a serving model.
    seedRuns({});
    writeRunManifest({
      cwd,
      manifest: {
        ...sampleManifest(),
        runId: "pending-run",
        model: undefined,
        requestedModel: "llmgateway/mimo-v2.6-flash",
        skippedModels: [
          { model: "llmgateway/mimo-v2.6-flash", reason: "Provider llmgateway is cooling down." },
        ],
      },
      store,
    });

    const runs = listRuns({ cwd, store });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveProperty("requestedModel", "llmgateway/mimo-v2.6-flash");
    expect(runs[0]).not.toHaveProperty("model");
    expect(runs[0]?.skippedModels).toHaveLength(1);
  });
});
