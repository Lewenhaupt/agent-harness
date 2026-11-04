import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  completeRunByUser,
  isSafeRunId,
  listPendingUserCompletions,
  listRuns,
  markRunDelivered,
  parseRunManifest,
  pruneForeignRunManifests,
  type RunManifest,
  type RunManifestFs,
  RunStatus,
  readRunManifest,
  runBelongsToTask,
  runManifestPath,
  runsDir,
  scanForInterruptedRuns,
  setRunModelSelection,
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

  it("scanForInterruptedRuns leaves another task's running manifest alone (bd-242)", () => {
    const fs = createFakeFs({
      [runManifestPath(cwd, "own")]: JSON.stringify(
        sampleManifest({ runId: "own", status: RunStatus.Running }),
      ),
      [runManifestPath(cwd, "foreign")]: JSON.stringify(
        sampleManifest({ runId: "foreign", taskId: "bd-37", status: RunStatus.Running }),
      ),
    });

    const interrupted = scanForInterruptedRuns({ cwd, fs, taskId: "bd-42", now: () => 9_000 });

    expect(interrupted.map((run) => run.runId)).toEqual(["own"]);
    // Flipping it would attribute bd-37's crashed run to bd-42 when the gate arms.
    expect(readRunManifest({ cwd, runId: "foreign", fs })).toHaveProperty("status", "running");
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
    const fs = createFakeFs({
      [runManifestPath(cwd, "own")]: JSON.stringify(
        sampleManifest({ runId: "own", startedAt: 1_000 }),
      ),
      [runManifestPath(cwd, "child")]: JSON.stringify(
        sampleManifest({ runId: "child", taskId: "bd-42.1", startedAt: 2_000 }),
      ),
      [runManifestPath(cwd, "foreign")]: JSON.stringify(
        sampleManifest({ runId: "foreign", taskId: "bd-37", startedAt: 3_000 }),
      ),
    });

    expect(listRuns({ cwd, fs }).map((run) => run.runId)).toEqual(["own", "child", "foreign"]);
    expect(listRuns({ cwd, fs, taskId: "bd-42" }).map((run) => run.runId)).toEqual([
      "own",
      "child",
    ]);
  });

  it("pruneForeignRunManifests deletes only another task's manifests (bd-242)", () => {
    const fs = createFakeFs({
      [runManifestPath(cwd, "own")]: JSON.stringify(sampleManifest({ runId: "own" })),
      [runManifestPath(cwd, "child")]: JSON.stringify(
        sampleManifest({ runId: "child", taskId: "bd-42.1" }),
      ),
      [runManifestPath(cwd, "deepChild")]: JSON.stringify(
        sampleManifest({ runId: "deepChild", taskId: "bd-42.1.2" }),
      ),
      [runManifestPath(cwd, "foreign")]: JSON.stringify(
        sampleManifest({ runId: "foreign", taskId: "bd-37", status: RunStatus.Failed }),
      ),
      [runManifestPath(cwd, "corrupt")]: "{not json",
      [join(runsDir(cwd), "notes.md")]: "ignored",
    });

    expect(pruneForeignRunManifests({ cwd, fs, taskId: "bd-42" })).toEqual({
      removed: ["foreign"],
      failed: [],
      // The corrupt file is invisible and undeletable, so the caller can warn.
      unattributable: ["corrupt"],
    });
    expect(fs.files.has(runManifestPath(cwd, "own"))).toBe(true);
    expect(fs.files.has(runManifestPath(cwd, "child"))).toBe(true);
    expect(fs.files.has(runManifestPath(cwd, "deepChild"))).toBe(true);
    expect(fs.files.has(runManifestPath(cwd, "foreign"))).toBe(false);
    // A file with no attributable task id stays for `listRuns` to skip.
    expect(fs.files.has(runManifestPath(cwd, "corrupt"))).toBe(true);
    // Non-`.json` entries are not run manifests at all, so they are not reported.
    expect(fs.files.has(join(runsDir(cwd), "notes.md"))).toBe(true);
  });

  it("pruneForeignRunManifests names a file called .json instead of an empty id (bd-242 review)", () => {
    const emptyIdPath = join(runsDir(cwd), ".json");
    const fs = createFakeFs({
      [runManifestPath(cwd, "own")]: JSON.stringify(sampleManifest({ runId: "own" })),
      [runManifestPath(cwd, "foreign")]: JSON.stringify(
        sampleManifest({ runId: "foreign", taskId: "bd-37" }),
      ),
      // Strips to an empty run id, which would join the warning list as a blank token.
      [emptyIdPath]: JSON.stringify(sampleManifest({ runId: "hidden", taskId: "bd-37" })),
      [runManifestPath(cwd, "corrupt")]: "{not json",
    });

    const result = pruneForeignRunManifests({ cwd, fs, taskId: "bd-42" });

    expect(result.removed).toEqual(["foreign"]);
    // Real ids are still listed alongside the literal filename.
    expect(result.unattributable).toEqual(["<unnamed>.json", "corrupt"]);
    expect(result.unattributable).not.toContain("");
    expect(fs.files.has(emptyIdPath)).toBe(true);
    expect(listRuns({ cwd, fs }).map((run) => run.runId)).toEqual(["own"]);
  });

  it("pruneForeignRunManifests is a no-op without a runs directory", () => {
    expect(pruneForeignRunManifests({ cwd, fs: createFakeFs(), taskId: "bd-42" })).toEqual({
      removed: [],
      failed: [],
      unattributable: [],
    });
  });

  it("a manifest whose body runId escapes the runs dir deletes nothing (bd-242 review)", () => {
    const outsidePath = join(cwd, "keep.json");
    const fs = createFakeFs({
      [runManifestPath(cwd, "evil")]: JSON.stringify(
        sampleManifest({ runId: "../../keep", taskId: "bd-37" }),
      ),
      [outsidePath]: "not a run manifest",
    });

    expect(pruneForeignRunManifests({ cwd, fs, taskId: "bd-42" })).toEqual({
      removed: [],
      failed: [],
      unattributable: ["evil"],
    });
    // The traversal target survives, and so does the file it came from: a body
    // the schema rejects carries no task id to attribute.
    expect(fs.files.has(outsidePath)).toBe(true);
    expect(fs.files.has(runManifestPath(cwd, "evil"))).toBe(true);
  });

  it("pruneForeignRunManifests deletes the entry it read, not the body's runId", () => {
    const fs = createFakeFs({
      // A mismatched body naming another entry's id must not redirect the unlink
      // to that entry.
      [runManifestPath(cwd, "aaa")]: JSON.stringify(
        sampleManifest({ runId: "bbb", taskId: "bd-37" }),
      ),
      [runManifestPath(cwd, "bbb")]: JSON.stringify(
        sampleManifest({ runId: "bbb", taskId: "bd-42" }),
      ),
    });

    expect(pruneForeignRunManifests({ cwd, fs, taskId: "bd-42" })).toEqual({
      removed: [],
      failed: [],
      unattributable: ["aaa"],
    });
    // The mismatch is skipped like a corrupt file, so bd-42's own run survives.
    expect(fs.files.has(runManifestPath(cwd, "bbb"))).toBe(true);
    expect(fs.files.has(runManifestPath(cwd, "aaa"))).toBe(true);
    expect(listRuns({ cwd, fs }).map((run) => run.runId)).toEqual(["bbb"]);
  });

  it("pruneForeignRunManifests keeps going after a failed unlink and reports it", () => {
    const base = createFakeFs({
      [runManifestPath(cwd, "foreignA")]: JSON.stringify(
        sampleManifest({ runId: "foreignA", taskId: "bd-37" }),
      ),
      [runManifestPath(cwd, "stuck")]: JSON.stringify(
        sampleManifest({ runId: "stuck", taskId: "bd-38" }),
      ),
      [runManifestPath(cwd, "own")]: JSON.stringify(sampleManifest({ runId: "own" })),
    });
    const fs: RunManifestFs = {
      ...base,
      unlinkSync(path) {
        if (path.endsWith("/stuck.json")) throw new Error("EBUSY: resource busy");
        base.unlinkSync(path);
      },
    };

    const result = pruneForeignRunManifests({ cwd, fs, taskId: "bd-42" });

    expect(result.removed).toEqual(["foreignA"]);
    expect(result.failed).toEqual([{ runId: "stuck", error: "EBUSY: resource busy" }]);
    expect(result.unattributable).toEqual([]);
    expect(base.files.has(runManifestPath(cwd, "stuck"))).toBe(true);
    expect(base.files.has(runManifestPath(cwd, "own"))).toBe(true);
  });

  it("a mismatched body is invisible to readRunManifest and no RMW rewrites another file", () => {
    // The craft: aaa.json claims bbb's id *and* bd-42's task, so a body-trusting
    // read-modify-write would write bbb.json for a request against aaa.
    const mismatched = JSON.stringify(sampleManifest({ runId: "bbb", taskId: "bd-42" }));
    const fs = createFakeFs({ [runManifestPath(cwd, "aaa")]: mismatched });

    expect(readRunManifest({ cwd, runId: "aaa", fs })).toBe(undefined);

    const noRun = { ok: false, error: "No run manifest found for aaa" };
    expect(setRunStatus({ cwd, runId: "aaa", status: RunStatus.Interrupted, fs })).toEqual(noRun);
    expect(completeRunByUser({ cwd, runId: "aaa", report: "done", fs })).toEqual(noRun);
    expect(markRunDelivered({ cwd, runId: "aaa", fs })).toEqual(noRun);
    const telemetry = { attempts: 1, fallbacks: 0, quotaFailures: 0, noOps: 0, cost: 0 };
    expect(setRunTelemetry({ cwd, runId: "aaa", telemetry, fs })).toEqual(noRun);
    expect(setRunModelSelection({ cwd, runId: "aaa", requestedModel: "x/y", fs })).toEqual(noRun);

    // Nothing was created or rewritten under the body's id.
    expect(fs.files.has(runManifestPath(cwd, "bbb"))).toBe(false);
    expect(fs.files.get(runManifestPath(cwd, "aaa"))).toBe(mismatched);
  });

  it("scanForInterruptedRuns never rewrites a file its body runId does not own (bd-242 review)", () => {
    const fs = createFakeFs({
      // `aaa.json` claims `bbb`'s id: following it would flip bbb.json, which is
      // not the file that was read.
      [runManifestPath(cwd, "aaa")]: JSON.stringify(
        sampleManifest({ runId: "bbb", status: RunStatus.Running }),
      ),
      [runManifestPath(cwd, "bbb")]: JSON.stringify(
        sampleManifest({ runId: "bbb", status: RunStatus.Completed, completedAt: 2_000 }),
      ),
    });

    expect(scanForInterruptedRuns({ cwd, fs, now: () => 9_000 })).toEqual([]);
    expect(readRunManifest({ cwd, runId: "bbb", fs })).toHaveProperty("status", "completed");
  });

  it("rejects and refuses to write an unsafe run id", () => {
    expect(isSafeRunId("abc123")).toBe(true);
    expect(isSafeRunId("pending-run")).toBe(true);
    expect(isSafeRunId("../../EVIL")).toBe(false);
    expect(isSafeRunId("..")).toBe(false);
    expect(isSafeRunId("a/b")).toBe(false);
    expect(parseRunManifest(sampleManifest({ runId: "../../EVIL" }))).toBe(undefined);

    const fs = createFakeFs();
    expect(writeRunManifest({ cwd, fs, manifest: sampleManifest({ runId: "../escape" }) })).toEqual(
      { ok: false, error: 'unsafe run id "../escape"' },
    );
    expect(fs.files.size).toBe(0);
    expect(readRunManifest({ cwd, fs, runId: "../escape" })).toBe(undefined);
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

  it("setRunModelSelection records the served model, the request and the skips", () => {
    const fs = createFakeFs();
    // The running manifest names the pre-dispatch pick only: it must never claim
    // a model served the run before anything was spawned.
    writeRunManifest({
      cwd,
      manifest: {
        ...sampleManifest(),
        model: undefined,
        requestedModel: "llmgateway/mimo-v2.6-flash",
      },
      fs,
    });
    setRunTelemetry({
      cwd,
      runId: "abc123",
      telemetry: { attempts: 2, fallbacks: 1, quotaFailures: 1, noOps: 0, cost: 0.5 },
      fs,
    });

    const result = setRunModelSelection({
      cwd,
      runId: "abc123",
      model: "commandcode/xiaomi/mimo-v2.6-flash",
      requestedModel: "llmgateway/mimo-v2.6-flash",
      skippedModels: [
        { model: "llmgateway/mimo-v2.6-flash", reason: "Provider llmgateway is cooling down" },
      ],
      fs,
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
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
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: sampleManifest(), fs });

    setRunModelSelection({
      cwd,
      runId: "abc123",
      model: "commandcode/z-ai/glm-5.3-flash",
      requestedModel: "commandcode/z-ai/glm-5.3-flash",
      fs,
    });

    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    expect(reloaded).toHaveProperty("model", "commandcode/z-ai/glm-5.3-flash");
    expect(reloaded).not.toHaveProperty("skippedModels");
  });

  it("setRunModelSelection leaves `model` absent when nothing was dispatched", () => {
    const fs = createFakeFs();
    writeRunManifest({ cwd, manifest: { ...sampleManifest(), model: undefined }, fs });

    setRunModelSelection({
      cwd,
      runId: "abc123",
      requestedModel: "commandcode/z-ai/glm-5.3-flash",
      skippedModels: [{ model: "llmgateway/mimo-v2.6-flash", reason: "cooling down" }],
      fs,
    });

    const reloaded = readRunManifest({ cwd, runId: "abc123", fs });
    // No spawn means no serving model: the pre-dispatch pick stays in
    // `requestedModel` and the skips explain why nothing ran.
    expect(reloaded).not.toHaveProperty("model");
    expect(reloaded).toHaveProperty("requestedModel", "commandcode/z-ai/glm-5.3-flash");
    expect(reloaded?.skippedModels).toEqual([
      { model: "llmgateway/mimo-v2.6-flash", reason: "cooling down" },
    ]);
  });

  it("setRunModelSelection returns an error for an unknown run id", () => {
    const fs = createFakeFs();
    const result = setRunModelSelection({
      cwd,
      runId: "missing",
      model: "commandcode/z-ai/glm-5.3-flash",
      requestedModel: "llmgateway/mimo-v2.6-flash",
      fs,
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
    const fs = createFakeFs();
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
      fs,
    });

    const runs = listRuns({ cwd, fs });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveProperty("requestedModel", "llmgateway/mimo-v2.6-flash");
    expect(runs[0]).not.toHaveProperty("model");
    expect(runs[0]?.skippedModels).toHaveLength(1);
  });
});
