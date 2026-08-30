import { describe, expect, it } from "vitest";

import {
  clearWorkflowState,
  legacyTaskFilePath,
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

  it("migrates the legacy task file into workflow.json and deletes it", () => {
    const fs = createFakeFs({
      [legacyTaskFilePath(cwd)]: JSON.stringify({
        taskId: "bd-7",
        branch: "feat/bd-7",
        originalCwd: "/home/user/repo",
        workflowType: "bugfix",
      }),
    });

    const state = readWorkflowState({ cwd, fs, now: () => 42_000 });

    expect(state).toHaveProperty("taskId", "bd-7");
    expect(state).toHaveProperty("branch", "feat/bd-7");
    expect(state).toHaveProperty("originalCwd", "/home/user/repo");
    expect(state).toHaveProperty("workflowType", "bugfix");
    expect(state).toHaveProperty("completedPhaseNames", []);
    expect(state).toHaveProperty("startedAt", 42_000);
    expect(fs.files.has(workflowStateFilePath(cwd))).toBe(true);
    expect(fs.files.has(legacyTaskFilePath(cwd))).toBe(false);
  });

  it("falls back to feature phases when the legacy workflow type is invalid", () => {
    const fs = createFakeFs({
      [legacyTaskFilePath(cwd)]: JSON.stringify({
        taskId: "bd-8",
        branch: "feat/bd-8",
        originalCwd: "/home/user/repo",
        workflowType: "nonsense",
      }),
    });

    const state = readWorkflowState({ cwd, fs });

    expect(state).toHaveProperty("workflowType", "feature");
    expect(state?.phaseOrder).toEqual([
      "scout",
      "plan",
      "implement",
      "review",
      "test",
      "userguide",
      "proof",
      "commit",
    ]);
  });

  it("migrates one-shot: a later read without the legacy file returns nothing", () => {
    const fs = createFakeFs({
      [legacyTaskFilePath(cwd)]: JSON.stringify({
        taskId: "bd-9",
        branch: "feat/bd-9",
        originalCwd: "/home/user/repo",
      }),
    });

    expect(readWorkflowState({ cwd, fs })).not.toBe(undefined);
    expect(fs.files.has(legacyTaskFilePath(cwd))).toBe(false);

    // Simulate the new file disappearing; migration must not run again.
    fs.files.delete(workflowStateFilePath(cwd));
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

  it("returns undefined for a corrupt legacy task file without throwing", () => {
    const fs = createFakeFs({ [legacyTaskFilePath(cwd)]: "not json" });
    expect(readWorkflowState({ cwd, fs })).toBe(undefined);
  });

  it("clearWorkflowState removes both files and tolerates missing files", () => {
    const fs = createFakeFs({
      [workflowStateFilePath(cwd)]: JSON.stringify(sampleState()),
      [legacyTaskFilePath(cwd)]: JSON.stringify({ taskId: "bd-1" }),
    });

    clearWorkflowState({ cwd, fs });
    expect(fs.files.has(workflowStateFilePath(cwd))).toBe(false);
    expect(fs.files.has(legacyTaskFilePath(cwd))).toBe(false);

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
