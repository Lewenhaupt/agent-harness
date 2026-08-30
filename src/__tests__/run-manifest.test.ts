import { describe, expect, it } from "vitest";

import {
  listRuns,
  parseRunManifest,
  type RunManifest,
  type RunManifestFs,
  RunStatus,
  readRunManifest,
  runManifestPath,
  scanForInterruptedRuns,
  setRunStatus,
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
});
