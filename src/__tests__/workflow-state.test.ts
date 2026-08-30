import { describe, expect, it } from "vitest";

import {
  clearWorkflowState,
  parseWorkflowState,
  readWorkflowState,
  saveCompletedPhases,
  type WorkflowFs,
  type WorkflowState,
  workflowStateFilePath,
  writeWorkflowState,
} from "../workflow-state.js";

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

const cwd = "/tmp/worktree";

function sampleState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: 1,
    taskId: "bd-42",
    workflowType: "feature",
    branch: "feat/bd-42",
    originalCwd: "/home/user/repo",
    phaseOrder: ["scout", "plan", "implement", "commit"],
    completedPhaseNames: [],
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("workflow state", () => {
  it("round-trips a workflow state through write and read", () => {
    const fs = createFakeFs();
    const state = sampleState({ completedPhaseNames: ["scout", "plan"] });

    const written = writeWorkflowState({ cwd, state, fs });
    expect(written).toEqual({ ok: true });
    expect(readWorkflowState({ cwd, fs })).toEqual(state);
  });

  it("writes atomically and leaves no temp files behind", () => {
    const fs = createFakeFs();
    const state = sampleState();

    writeWorkflowState({ cwd, state, fs });

    const keys = [...fs.files.keys()];
    expect(keys).toEqual([workflowStateFilePath(cwd)]);
    expect(keys.some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("returns undefined for corrupt JSON", () => {
    const fs = createFakeFs({ [workflowStateFilePath(cwd)]: "not json" });
    expect(readWorkflowState({ cwd, fs })).toBe(undefined);
  });

  it("returns undefined for a wrong schema version", () => {
    const fs = createFakeFs({
      [workflowStateFilePath(cwd)]: JSON.stringify({ ...sampleState(), schemaVersion: 2 }),
    });
    expect(readWorkflowState({ cwd, fs })).toBe(undefined);
  });

  it("saveCompletedPhases preserves identity fields and updates the timestamp", () => {
    const fs = createFakeFs();
    const state = sampleState({
      completedPhaseNames: ["scout"],
      startedAt: 5_000,
      updatedAt: 5_000,
    });
    writeWorkflowState({ cwd, state, fs });

    const result = saveCompletedPhases({
      cwd,
      fs,
      now: () => 9_000,
      completedPhaseNames: ["scout", "plan"],
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readWorkflowState({ cwd, fs });
    expect(reloaded).toHaveProperty("taskId", "bd-42");
    expect(reloaded).toHaveProperty("startedAt", 5_000);
    expect(reloaded).toHaveProperty("completedPhaseNames", ["scout", "plan"]);
    expect(reloaded).toHaveProperty("updatedAt", 9_000);
  });

  it("saveCompletedPhases returns an error when no state exists", () => {
    const fs = createFakeFs();
    const result = saveCompletedPhases({ cwd, fs, completedPhaseNames: ["scout"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No Belayd workflow state");
  });

  it("returns an error value (no throw) when the write fails", () => {
    const fs = createFakeFs();
    const state = sampleState();

    fs.renameSync = () => {
      throw new Error("disk full");
    };

    const result = writeWorkflowState({ cwd, state, fs });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("disk full");
    expect([...fs.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("clearWorkflowState removes only workflow.json and tolerates missing files", () => {
    const fs = createFakeFs({
      [workflowStateFilePath(cwd)]: JSON.stringify(sampleState()),
      [`${cwd}/.belayd-task.json`]: JSON.stringify({ taskId: "bd-1" }),
    });

    clearWorkflowState({ cwd, fs });
    expect(fs.files.has(workflowStateFilePath(cwd))).toBe(false);
    // The legacy file is no longer managed; only workflow.json is removed.
    expect(fs.files.has(`${cwd}/.belayd-task.json`)).toBe(true);

    // No files present: must not throw.
    expect(() => clearWorkflowState({ cwd, fs })).not.toThrow();
  });

  it("parseWorkflowState rejects malformed fields", () => {
    expect(parseWorkflowState(null)).toBe(undefined);
    expect(parseWorkflowState({ ...sampleState(), taskId: 42 })).toBe(undefined);
    expect(parseWorkflowState({ ...sampleState(), phaseOrder: ["scout", 1] })).toBe(undefined);
    expect(parseWorkflowState({ ...sampleState(), startedAt: "yesterday" })).toBe(undefined);
  });
});
