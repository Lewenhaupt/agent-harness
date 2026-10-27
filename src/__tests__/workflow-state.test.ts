import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  archiveWorkflowState,
  callerHandoffFilePath,
  classifyWorkflowClaimability,
  clearCallerHandoff,
  clearHandedOffMarker,
  clearWorkflowState,
  parseHandedOffMarker,
  parseWorkflowState,
  readCallerHandoff,
  readWorkflowState,
  saveCompletedPhases,
  saveHandedOffMarker,
  savePhaseSession,
  saveReviewedSha,
  type WorkflowFs,
  type WorkflowState,
  workflowStateDir,
  workflowStateFilePath,
  writeCallerHandoff,
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

  it("saveCompletedPhases persists the awaiting-review flag", () => {
    const fs = createFakeFs();
    writeWorkflowState({ cwd, state: sampleState(), fs });

    saveCompletedPhases({
      cwd,
      fs,
      completedPhaseNames: ["implement", "review"],
      awaitingReviewResponse: true,
    });
    expect(readWorkflowState({ cwd, fs })?.awaitingReviewResponse).toBe(true);

    saveCompletedPhases({
      cwd,
      fs,
      completedPhaseNames: ["implement", "review", "test"],
      awaitingReviewResponse: false,
    });
    expect(readWorkflowState({ cwd, fs })?.awaitingReviewResponse).toBe(false);
  });

  it("parses state with and without the awaiting-review flag", () => {
    expect(parseWorkflowState(sampleState())?.awaitingReviewResponse).toBe(undefined);
    expect(
      parseWorkflowState({ ...sampleState(), awaitingReviewResponse: true })
        ?.awaitingReviewResponse,
    ).toBe(true);
    expect(parseWorkflowState({ ...sampleState(), awaitingReviewResponse: "yes" })).toBe(undefined);
  });

  it("saveReviewedSha round-trips the sha and preserves every other field", () => {
    const fs = createFakeFs();
    writeWorkflowState({
      cwd,
      state: sampleState({
        startedAt: 5_000,
        updatedAt: 5_000,
        completedPhaseNames: ["implement"],
        awaitingReviewResponse: true,
        phaseSessions: { review: { base: "rev", invocations: 2 } },
      }),
      fs,
    });

    const result = saveReviewedSha({ cwd, fs, now: () => 9_000, sha: "abc1234" });

    expect(result).toEqual({ ok: true });
    const reloaded = readWorkflowState({ cwd, fs });
    expect(reloaded).toHaveProperty("reviewedSha", "abc1234");
    expect(reloaded).toHaveProperty("taskId", "bd-42");
    expect(reloaded).toHaveProperty("startedAt", 5_000);
    expect(reloaded).toHaveProperty("updatedAt", 9_000);
    expect(reloaded).toHaveProperty("completedPhaseNames", ["implement"]);
    expect(reloaded).toHaveProperty("awaitingReviewResponse", true);
    expect(reloaded?.phaseSessions).toEqual({ review: { base: "rev", invocations: 2 } });
  });

  it("saveReviewedSha returns an error when no state exists", () => {
    const fs = createFakeFs();
    const result = saveReviewedSha({ cwd, fs, sha: "abc1234" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-state");
      expect(result.error).toContain("No Belayd workflow state");
    }
  });

  it("saveReviewedSha skips a mismatched expected task id without writing", () => {
    const fs = createFakeFs();
    writeWorkflowState({
      cwd,
      state: sampleState({ taskId: "bd-99", completedPhaseNames: ["implement"] }),
      fs,
    });
    const before = fs.files.get(workflowStateFilePath(cwd));

    const result = saveReviewedSha({
      cwd,
      fs,
      now: () => 9_000,
      sha: "abc1234",
      expectedTaskId: "bd-42",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("task-mismatch");
      if (result.reason === "task-mismatch") expect(result.actualTaskId).toBe("bd-99");
    }
    // The foreign state file must be byte-for-byte unchanged.
    expect(fs.files.get(workflowStateFilePath(cwd))).toBe(before);
    expect(readWorkflowState({ cwd, fs })?.reviewedSha).toBe(undefined);
  });

  it("saveReviewedSha persists when the expected task id matches", () => {
    const fs = createFakeFs();
    writeWorkflowState({ cwd, state: sampleState({ taskId: "bd-42" }), fs });

    const result = saveReviewedSha({
      cwd,
      fs,
      now: () => 9_000,
      sha: "abc1234",
      expectedTaskId: "bd-42",
    });

    expect(result).toEqual({ ok: true });
    expect(readWorkflowState({ cwd, fs })?.reviewedSha).toBe("abc1234");
  });

  it("parses a pre-bd-113 workflow.json without a reviewed sha", () => {
    const raw = { ...sampleState(), completedPhaseNames: ["implement", "review"] };
    expect(parseWorkflowState(raw)?.reviewedSha).toBe(undefined);
    expect(parseWorkflowState({ ...raw, reviewedSha: "abc1234" })?.reviewedSha).toBe("abc1234");
    expect(parseWorkflowState({ ...raw, reviewedSha: 42 })).toBe(undefined);
  });

  it("savePhaseSession upserts one entry and preserves identity fields", () => {
    const fs = createFakeFs();
    writeWorkflowState({
      cwd,
      state: sampleState({ startedAt: 5_000, updatedAt: 5_000 }),
      fs,
    });

    const result = savePhaseSession({
      cwd,
      fs,
      now: () => 9_000,
      phaseName: "implement",
      record: { base: "belayd-bd-42-sub-implement-a", invocations: 1 },
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readWorkflowState({ cwd, fs });
    expect(reloaded).toHaveProperty("taskId", "bd-42");
    expect(reloaded).toHaveProperty("startedAt", 5_000);
    expect(reloaded).toHaveProperty("updatedAt", 9_000);
    expect(reloaded?.phaseSessions).toEqual({
      implement: { base: "belayd-bd-42-sub-implement-a", invocations: 1 },
    });
  });

  it("savePhaseSession keeps other phases' entries independent", () => {
    const fs = createFakeFs();
    writeWorkflowState({ cwd, state: sampleState(), fs });

    savePhaseSession({
      cwd,
      fs,
      phaseName: "implement",
      record: { base: "impl", invocations: 1 },
    });
    savePhaseSession({ cwd, fs, phaseName: "review", record: { base: "rev", invocations: 2 } });
    savePhaseSession({
      cwd,
      fs,
      phaseName: "implement",
      record: { base: "impl", invocations: 2 },
    });

    expect(readWorkflowState({ cwd, fs })?.phaseSessions).toEqual({
      implement: { base: "impl", invocations: 2 },
      review: { base: "rev", invocations: 2 },
    });
  });

  it("treats a pre-bd-81 workflow.json (no phaseSessions) as an empty ledger", () => {
    const fs = createFakeFs();
    // writeWorkflowState omits phaseSessions because sampleState never sets it.
    writeWorkflowState({ cwd, state: sampleState(), fs });
    expect(readWorkflowState({ cwd, fs })?.phaseSessions).toBe(undefined);

    const result = savePhaseSession({
      cwd,
      fs,
      phaseName: "review",
      record: { base: "rev", invocations: 1 },
    });
    expect(result).toEqual({ ok: true });
    expect(readWorkflowState({ cwd, fs })?.phaseSessions).toEqual({
      review: { base: "rev", invocations: 1 },
    });
  });

  it("savePhaseSession returns an error when no state exists", () => {
    const fs = createFakeFs();
    const result = savePhaseSession({
      cwd,
      fs,
      phaseName: "review",
      record: { base: "rev", invocations: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No Belayd workflow state");
  });

  it("savePhaseSession accepts a pre-read state without touching disk again", () => {
    const fs = createFakeFs();
    writeWorkflowState({ cwd, state: sampleState(), fs });
    const existing = readWorkflowState({ cwd, fs });
    expect(existing).toBeDefined();
    if (existing === undefined) return;

    // A failing read would prove the existingState was ignored; replacing the
    // reader is not possible through the seam, so assert the write landed.
    const result = savePhaseSession({
      cwd,
      fs,
      existingState: existing,
      phaseName: "implement",
      record: { base: "impl", invocations: 2 },
    });
    expect(result).toEqual({ ok: true });
    expect(readWorkflowState({ cwd, fs })?.phaseSessions?.implement).toEqual({
      base: "impl",
      invocations: 2,
    });
  });

  it("savePhaseSession returns an error for a corrupt state file", () => {
    const fs = createFakeFs({ [workflowStateFilePath(cwd)]: "not json" });
    const result = savePhaseSession({
      cwd,
      fs,
      phaseName: "review",
      record: { base: "rev", invocations: 1 },
    });
    expect(result.ok).toBe(false);
  });

  it("savePhaseSession returns an error value (no throw) when the write fails", () => {
    const fs = createFakeFs();
    writeWorkflowState({ cwd, state: sampleState(), fs });
    fs.renameSync = () => {
      throw new Error("disk full");
    };

    const result = savePhaseSession({
      cwd,
      fs,
      phaseName: "review",
      record: { base: "rev", invocations: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("disk full");
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
    expect(
      parseWorkflowState({
        ...sampleState(),
        phaseSessions: { implement: { base: "impl", invocations: 0 } },
      }),
    ).toBe(undefined);
  });
});

describe("classifyWorkflowClaimability (bd-165)", () => {
  const marker = { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" };

  it("is claimable for a genuine in-progress workflow", () => {
    const state = sampleState({ completedPhaseNames: ["scout"] });
    expect(classifyWorkflowClaimability(state)).toEqual({ kind: "claimable" });
  });

  it("is inert when every phase in its own order is complete", () => {
    const state = sampleState({
      completedPhaseNames: ["scout", "plan", "implement", "commit"],
    });
    expect(classifyWorkflowClaimability(state)).toEqual({ kind: "inert", reason: "complete" });
  });

  it("is inert for a handed-off workflow", () => {
    const state = sampleState({ completedPhaseNames: ["scout"], handedOffTo: marker });
    expect(classifyWorkflowClaimability(state)).toEqual({ kind: "inert", reason: "handed-off" });
  });

  it("reports handed-off ahead of complete so the marker still reaches settlement", () => {
    const state = sampleState({
      completedPhaseNames: ["scout", "plan", "implement", "commit"],
      handedOffTo: marker,
    });
    expect(classifyWorkflowClaimability(state)).toEqual({ kind: "inert", reason: "handed-off" });
  });

  it("is inert for a task id that cannot name a bead", () => {
    const state = sampleState({ taskId: "bd-42;rm -rf /" });
    expect(classifyWorkflowClaimability(state)).toEqual({
      kind: "inert",
      reason: "invalid-task-id",
    });
  });

  it("reports handed-off ahead of an invalid task id so the marker still reaches settlement", () => {
    const state = sampleState({ taskId: "bd-42;rm -rf /", handedOffTo: marker });
    expect(classifyWorkflowClaimability(state)).toEqual({ kind: "inert", reason: "handed-off" });
  });

  it("reports complete ahead of an invalid task id", () => {
    // Ordering, not preference: a finished workflow is inert whichever check
    // fires first, and both reasons skip the claim and archive the file.
    const state = sampleState({
      taskId: "bd-42;rm -rf /",
      completedPhaseNames: ["scout", "plan", "implement", "commit"],
    });
    expect(classifyWorkflowClaimability(state)).toEqual({ kind: "inert", reason: "complete" });
  });

  it("treats an empty phase order as complete because isWorkflowComplete is vacuous", () => {
    // Deliberate consequence of reusing `isWorkflowComplete`: no phases to
    // finish means nothing left to drive, so the state must not claim a lease
    // even though it still has a valid task id.
    const state = sampleState({ completedPhaseNames: [], phaseOrder: [] });
    expect(classifyWorkflowClaimability(state)).toEqual({ kind: "inert", reason: "complete" });
  });

  it("does not mutate the state it classifies", () => {
    const state = sampleState({ completedPhaseNames: ["scout"] });
    const snapshot = structuredClone(state);
    classifyWorkflowClaimability(state);
    expect(state).toEqual(snapshot);
  });
});

describe("archiveWorkflowState (bd-165)", () => {
  it("renames the state to a timestamped archive instead of deleting it", () => {
    const original = { ...sampleState(), completedPhaseNames: ["scout", "plan"] };
    const fs = createFakeFs({ [workflowStateFilePath(cwd)]: JSON.stringify(original) });

    const result = archiveWorkflowState({ cwd, fs, now: () => 7_654 });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.archived) throw new Error("expected an archived result");
    expect(result.archivedPath).toMatch(/workflow\.stale-7654-[0-9a-f]{8}\.json$/);
    expect(result.archivedPath.startsWith(workflowStateDir(cwd))).toBe(true);
    expect(fs.files.has(workflowStateFilePath(cwd))).toBe(false);
    expect(fs.files.get(result.archivedPath)).toBe(JSON.stringify(original));
  });

  it("keeps both records when two archives land in the same millisecond", () => {
    const fs = createFakeFs();
    const first = { ...sampleState(), completedPhaseNames: ["scout"] };
    const second = { ...sampleState(), completedPhaseNames: ["scout", "plan"] };

    writeWorkflowState({ cwd, state: first, fs });
    const firstResult = archiveWorkflowState({ cwd, fs, now: () => 7_654 });
    writeWorkflowState({ cwd, state: second, fs });
    const secondResult = archiveWorkflowState({ cwd, fs, now: () => 7_654 });

    if (!firstResult.ok || !firstResult.archived) throw new Error("first archive failed");
    if (!secondResult.ok || !secondResult.archived) throw new Error("second archive failed");
    expect(firstResult.archivedPath).not.toBe(secondResult.archivedPath);
    expect(JSON.parse(fs.files.get(firstResult.archivedPath) ?? "")).toHaveProperty(
      "completedPhaseNames",
      ["scout"],
    );
    expect(JSON.parse(fs.files.get(secondResult.archivedPath) ?? "")).toHaveProperty(
      "completedPhaseNames",
      ["scout", "plan"],
    );
  });

  it("reports the missing-file no-op explicitly", () => {
    const fs = createFakeFs();
    expect(archiveWorkflowState({ cwd, fs, now: () => 7_654 })).toEqual({
      ok: true,
      archived: false,
    });
    expect(fs.files.size).toBe(0);
  });

  it("returns a rename failure as a value and leaves the state in place", () => {
    const fs = createFakeFs({ [workflowStateFilePath(cwd)]: JSON.stringify(sampleState()) });
    fs.renameSync = () => {
      throw new Error("disk full");
    };

    const result = archiveWorkflowState({ cwd, fs });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("disk full");
    expect(fs.files.has(workflowStateFilePath(cwd))).toBe(true);
  });
});

describe("handoff marker", () => {
  const marker = { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" };

  it("parses state without a marker (backwards compatible)", () => {
    const parsed = parseWorkflowState(sampleState());
    expect(parsed?.handedOffTo).toBe(undefined);
  });

  it("records the marker while preserving the workflow identity", () => {
    const fs = createFakeFs();
    writeWorkflowState({ cwd, state: sampleState({ completedPhaseNames: ["implement"] }), fs });

    const saved = saveHandedOffMarker({ cwd, marker, fs });

    expect(saved.ok).toBe(true);
    const persisted = readWorkflowState({ cwd, fs });
    expect(persisted).toHaveProperty("taskId", "bd-42");
    expect(persisted).toHaveProperty("completedPhaseNames", ["implement"]);
    expect(persisted).toHaveProperty("handedOffTo", marker);
  });

  it("saveHandedOffMarker reports a missing state instead of creating one", () => {
    const fs = createFakeFs();

    const saved = saveHandedOffMarker({ cwd, marker, fs });

    expect(saved.ok).toBe(false);
    expect(fs.files.size).toBe(0);
  });

  it("clears only the marker and keeps the workflow state", () => {
    const fs = createFakeFs();
    writeWorkflowState({ cwd, state: sampleState({ completedPhaseNames: ["implement"] }), fs });
    saveHandedOffMarker({ cwd, marker, fs });

    const cleared = clearHandedOffMarker({ cwd, fs });

    expect(cleared.ok).toBe(true);
    const persisted = readWorkflowState({ cwd, fs });
    expect(persisted).toHaveProperty("taskId", "bd-42");
    expect(persisted).toHaveProperty("completedPhaseNames", ["implement"]);
    expect(persisted?.handedOffTo).toBe(undefined);
  });

  it("clearing a missing state is a no-op success", () => {
    const fs = createFakeFs();

    expect(clearHandedOffMarker({ cwd, fs }).ok).toBe(true);
    expect(fs.files.size).toBe(0);
  });

  it("rejects a partially malformed marker", () => {
    expect(parseWorkflowState({ ...sampleState(), handedOffTo: { taskId: "bd-101" } })).toBe(
      undefined,
    );
  });
});

describe("caller-scoped handoff marker", () => {
  const marker = { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" };
  const sessionKey = "caller-session-1";

  it("uses a sanitized, caller-keyed path", () => {
    expect(callerHandoffFilePath(cwd, "a/b:c d")).toBe(
      join(cwd, ".belayd", "handoff-a_b_c_d.json"),
    );
    expect(callerHandoffFilePath(cwd, sessionKey)).toBe(
      join(cwd, ".belayd", `handoff-${sessionKey}.json`),
    );
  });

  it("round-trips a marker and survives unrelated workflow.json rewrites", () => {
    const fs = createFakeFs();
    const written = writeCallerHandoff({ cwd, sessionKey, marker, fs });
    // A same-directory child writes its own workflow.json over the caller's.
    writeWorkflowState({ cwd, state: sampleState({ taskId: "bd-101" }), fs });

    expect(written.ok).toBe(true);
    expect(readCallerHandoff({ cwd, sessionKey, fs })).toEqual(marker);
    expect(readWorkflowState({ cwd, fs })?.handedOffTo).toBe(undefined);
  });

  it("returns undefined for another session or a corrupt file", () => {
    const fs = createFakeFs();
    writeCallerHandoff({ cwd, sessionKey, marker, fs });

    expect(readCallerHandoff({ cwd, sessionKey: "other-session", fs })).toBe(undefined);

    const corruptFs = createFakeFs({
      [callerHandoffFilePath(cwd, sessionKey)]: JSON.stringify({ taskId: "bd-101" }),
    });
    expect(readCallerHandoff({ cwd, sessionKey, fs: corruptFs })).toBe(undefined);
  });

  it("clears only the caller's marker", () => {
    const fs = createFakeFs();
    writeCallerHandoff({ cwd, sessionKey, marker, fs });
    writeCallerHandoff({ cwd, sessionKey: "other-session", marker, fs });

    expect(clearCallerHandoff({ cwd, sessionKey, fs }).ok).toBe(true);
    expect(readCallerHandoff({ cwd, sessionKey, fs })).toBe(undefined);
    expect(readCallerHandoff({ cwd, sessionKey: "other-session", fs })).toEqual(marker);
  });

  it("clearing a missing marker is a no-op success and reports a real unlink failure", () => {
    const fs = createFakeFs();
    expect(clearCallerHandoff({ cwd, sessionKey, fs }).ok).toBe(true);

    writeCallerHandoff({ cwd, sessionKey, marker, fs });
    fs.unlinkSync = () => {
      throw new Error("EACCES");
    };
    const failed = clearCallerHandoff({ cwd, sessionKey, fs });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toBe("EACCES");
  });

  it("writeCallerHandoff reports a write failure instead of throwing", () => {
    const fs = createFakeFs();
    fs.renameSync = () => {
      throw new Error("disk full");
    };

    const written = writeCallerHandoff({ cwd, sessionKey, marker, fs });
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.error).toBe("disk full");
  });

  it("parses a marker only when every field is present", () => {
    expect(parseHandedOffMarker(marker)).toEqual(marker);
    expect(parseHandedOffMarker({ taskId: marker.taskId })).toBe(undefined);
    expect(parseHandedOffMarker(null)).toBe(undefined);
  });
});
