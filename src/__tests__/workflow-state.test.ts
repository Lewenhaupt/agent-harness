import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openRepoStateStore, type RepoStateStore } from "../repo-state-store.js";
import {
  archiveWorkflowState,
  callerHandoffFilePath,
  classifyWorkflowClaimability,
  clearCallerHandoff,
  clearHandedOffMarker,
  clearReviewScope,
  clearWorkflowState,
  parseHandedOffMarker,
  parseReviewScope,
  parseWorkflowState,
  readCallerHandoff,
  readReviewScope,
  readWorkflowState,
  reviewScopeFilePath,
  saveCompletedPhases,
  saveHandedOffMarker,
  savePhaseSession,
  saveReviewedSha,
  saveReviewScope,
  type WorkflowState,
  workflowStateDir,
  workflowStateFilePath,
  writeCallerHandoff,
  writeWorkflowState,
} from "../workflow-state.js";

const cwd = "/tmp/worktree";

let dir: string;
let storePath: string;
let store: RepoStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "belayd-workflow-state-"));
  storePath = join(dir, "state.sqlite");
  const opened = openRepoStateStore({ path: storePath });
  if (!opened.ok) throw new Error(opened.error);
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

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

/** Corrupt one stored column, the way a torn/legacy write would. */
function corruptWorkflowColumn(taskId: string, column: string, value: string): void {
  const database = new DatabaseSync(storePath);
  database.prepare(`UPDATE workflow_state SET ${column} = ? WHERE task_id = ?`).run(value, taskId);
  database.close();
}

describe("workflow state (bd-281: shared store row, keyed by task)", () => {
  it("round-trips a workflow state through write and read", () => {
    const state = sampleState({ completedPhaseNames: ["scout", "plan"] });

    const written = writeWorkflowState({ cwd, state, store });
    expect(written).toEqual({ ok: true });
    expect(readWorkflowState({ cwd, store })).toEqual(state);
  });

  it("writes no workflow file under the worktree", () => {
    writeWorkflowState({ cwd, state: sampleState(), store });

    // The file is the bug being removed (bd-165): state is a row now, so nothing
    // in the worktree can be copied, committed or inherited.
    expect(workflowStateFilePath(cwd)).toBe(join(cwd, ".belayd", "workflow.json"));
    expect(readWorkflowState({ cwd, store })).toHaveProperty("taskId", "bd-42");
  });

  it("resolves the same row from another worktree when the task is known", () => {
    writeWorkflowState({ cwd, state: sampleState({ completedPhaseNames: ["scout"] }), store });

    // A resumed session in a second worktree names the task, not the path.
    const resumed = readWorkflowState({ cwd: "/tmp/other-worktree", taskId: "bd-42", store });
    expect(resumed).toHaveProperty("completedPhaseNames", ["scout"]);

    // A worktree-only lookup in the second worktree has no binding yet.
    expect(readWorkflowState({ cwd: "/tmp/other-worktree", store })).toBe(undefined);

    // Once that session writes (by task id), it binds its own worktree to the
    // same row instead of creating a copy.
    saveCompletedPhases({
      cwd: "/tmp/other-worktree",
      taskId: "bd-42",
      store,
      completedPhaseNames: ["scout", "plan"],
    });
    expect(readWorkflowState({ cwd: "/tmp/other-worktree", store })).toHaveProperty(
      "completedPhaseNames",
      ["scout", "plan"],
    );
    expect(readWorkflowState({ cwd, store })).toHaveProperty("completedPhaseNames", [
      "scout",
      "plan",
    ]);
  });

  it("bumps the row generation on every write", () => {
    writeWorkflowState({ cwd, state: sampleState(), store });
    writeWorkflowState({ cwd, state: sampleState({ completedPhaseNames: ["scout"] }), store });

    const row = store.readWorkflow({ taskId: "bd-42" });
    expect(row.ok).toBe(true);
    if (!row.ok || row.value === null) return;
    expect(row.value.generation).toBe(2);
  });

  it("returns undefined for a row that does not parse", () => {
    writeWorkflowState({ cwd, state: sampleState(), store });
    corruptWorkflowColumn("bd-42", "phase_order", "not json");

    expect(readWorkflowState({ cwd, store })).toBe(undefined);
  });

  it("returns undefined for a wrong schema version", () => {
    expect(parseWorkflowState({ ...sampleState(), schemaVersion: 2 })).toBe(undefined);
    expect(parseWorkflowState(null)).toBe(undefined);
  });

  it("degrades to undefined when the store is unavailable", () => {
    store.close();
    expect(readWorkflowState({ cwd, store })).toBe(undefined);
  });

  it("saveCompletedPhases preserves identity fields and updates the timestamp", () => {
    writeWorkflowState({
      cwd,
      state: sampleState({ completedPhaseNames: ["scout"], startedAt: 5_000, updatedAt: 5_000 }),
      store,
    });

    const result = saveCompletedPhases({
      cwd,
      store,
      now: () => 9_000,
      completedPhaseNames: ["scout", "plan"],
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readWorkflowState({ cwd, store });
    expect(reloaded).toHaveProperty("taskId", "bd-42");
    expect(reloaded).toHaveProperty("startedAt", 5_000);
    expect(reloaded).toHaveProperty("completedPhaseNames", ["scout", "plan"]);
    expect(reloaded).toHaveProperty("updatedAt", 9_000);
  });

  it("saveCompletedPhases returns an error when no state exists", () => {
    const result = saveCompletedPhases({ cwd, store, completedPhaseNames: ["scout"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No Belayd workflow state");
  });

  it("saveCompletedPhases persists the awaiting-review flag", () => {
    writeWorkflowState({ cwd, state: sampleState(), store });

    saveCompletedPhases({
      cwd,
      store,
      completedPhaseNames: ["implement", "review"],
      awaitingReviewResponse: true,
    });
    expect(readWorkflowState({ cwd, store })?.awaitingReviewResponse).toBe(true);

    saveCompletedPhases({
      cwd,
      store,
      completedPhaseNames: ["implement", "review", "test"],
      awaitingReviewResponse: false,
    });
    expect(readWorkflowState({ cwd, store })?.awaitingReviewResponse).toBe(false);
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
    writeWorkflowState({
      cwd,
      state: sampleState({
        startedAt: 5_000,
        updatedAt: 5_000,
        completedPhaseNames: ["implement"],
        awaitingReviewResponse: true,
        phaseSessions: { review: { base: "rev", invocations: 2 } },
      }),
      store,
    });

    const result = saveReviewedSha({ cwd, store, now: () => 9_000, sha: "abc1234" });

    expect(result).toEqual({ ok: true });
    const reloaded = readWorkflowState({ cwd, store });
    expect(reloaded).toHaveProperty("reviewedSha", "abc1234");
    expect(reloaded).toHaveProperty("taskId", "bd-42");
    expect(reloaded).toHaveProperty("startedAt", 5_000);
    expect(reloaded).toHaveProperty("updatedAt", 9_000);
    expect(reloaded).toHaveProperty("completedPhaseNames", ["implement"]);
    expect(reloaded).toHaveProperty("awaitingReviewResponse", true);
    expect(reloaded?.phaseSessions).toEqual({ review: { base: "rev", invocations: 2 } });
  });

  it("saveReviewedSha returns an error when no state exists", () => {
    const result = saveReviewedSha({ cwd, store, sha: "abc1234" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-state");
      expect(result.error).toContain("No Belayd workflow state");
    }
  });

  it("saveReviewedSha skips a mismatched expected task id without writing", () => {
    writeWorkflowState({
      cwd,
      state: sampleState({ taskId: "bd-99", completedPhaseNames: ["implement"] }),
      store,
    });

    const result = saveReviewedSha({
      cwd,
      store,
      now: () => 9_000,
      sha: "abc1234",
      expectedTaskId: "bd-42",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("task-mismatch");
      if (result.reason === "task-mismatch") expect(result.actualTaskId).toBe("bd-99");
    }
    // The foreign row must be unchanged: sha, timestamp and bundled manifest.
    expect(readWorkflowState({ cwd, store })?.reviewedSha).toBe(undefined);
    expect(readWorkflowState({ cwd, store })?.updatedAt).toBe(1_000);
  });

  it("saveReviewedSha persists when the expected task id matches", () => {
    writeWorkflowState({ cwd, state: sampleState({ taskId: "bd-42" }), store });

    const result = saveReviewedSha({
      cwd,
      store,
      now: () => 9_000,
      sha: "abc1234",
      expectedTaskId: "bd-42",
    });

    expect(result).toEqual({ ok: true });
    expect(readWorkflowState({ cwd, store })?.reviewedSha).toBe("abc1234");
  });

  it("parses a pre-bd-113 workflow without a reviewed sha", () => {
    const raw = { ...sampleState(), completedPhaseNames: ["implement", "review"] };
    expect(parseWorkflowState(raw)?.reviewedSha).toBe(undefined);
    expect(parseWorkflowState({ ...raw, reviewedSha: "abc1234" })?.reviewedSha).toBe("abc1234");
    expect(parseWorkflowState({ ...raw, reviewedSha: 42 })).toBe(undefined);
  });

  it("records the reviewed sha and its untracked manifest in one write (bd-228)", () => {
    writeWorkflowState({
      cwd,
      state: sampleState({ startedAt: 5_000, updatedAt: 5_000 }),
      store,
    });

    const result = saveReviewedSha({
      cwd,
      store,
      now: () => 9_000,
      sha: "stash1234",
      untracked: [
        { path: "src/new.ts", blob: "blob1111" },
        { path: "src/other.ts", blob: "blob2222" },
      ],
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readWorkflowState({ cwd, store });
    expect(reloaded).toHaveProperty("reviewedSha", "stash1234");
    expect(reloaded).toHaveProperty("reviewedUntracked", [
      { path: "src/new.ts", blob: "blob1111" },
      { path: "src/other.ts", blob: "blob2222" },
    ]);
    expect(reloaded).toHaveProperty("updatedAt", 9_000);
  });

  it("clears the reviewed untracked manifest when it is omitted or empty (bd-228)", () => {
    writeWorkflowState({
      cwd,
      state: sampleState({
        completedPhaseNames: ["implement"],
        reviewedSha: "old1234",
        reviewedUntracked: [{ path: "src/old.ts", blob: "blob0000" }],
      }),
      store,
    });

    expect(saveReviewedSha({ cwd, store, sha: "abc1234" })).toEqual({ ok: true });
    const omitted = readWorkflowState({ cwd, store });
    // A stale manifest paired with a new sha could silently drop a file from
    // scope, so recording a sha alone must clear it.
    expect(omitted).toHaveProperty("reviewedSha", "abc1234");
    expect(omitted?.reviewedUntracked).toBe(undefined);

    expect(
      saveReviewedSha({
        cwd,
        store,
        sha: "abc1234",
        untracked: [{ path: "src/a.ts", blob: "b1" }],
      }),
    ).toEqual({ ok: true });
    expect(saveReviewedSha({ cwd, store, sha: "abc1234", untracked: [] })).toEqual({ ok: true });
    expect(readWorkflowState({ cwd, store })?.reviewedUntracked).toBe(undefined);
  });

  it("writes neither the sha nor the manifest on a task-id mismatch (bd-228)", () => {
    writeWorkflowState({
      cwd,
      state: sampleState({
        taskId: "bd-99",
        reviewedSha: "deadbee",
        reviewedUntracked: [{ path: "src/foreign.ts", blob: "blobffff" }],
      }),
      store,
    });

    const result = saveReviewedSha({
      cwd,
      store,
      sha: "abc1234",
      untracked: [{ path: "src/new.ts", blob: "blob1111" }],
      expectedTaskId: "bd-42",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("task-mismatch");
    expect(readWorkflowState({ cwd, store })).toHaveProperty("reviewedSha", "deadbee");
    expect(readWorkflowState({ cwd, store })).toHaveProperty("reviewedUntracked", [
      { path: "src/foreign.ts", blob: "blobffff" },
    ]);
  });

  it("parses a pre-bd-228 workflow without a reviewed untracked manifest", () => {
    const raw = { ...sampleState(), reviewedSha: "abc1234" };
    expect(parseWorkflowState(raw)?.reviewedUntracked).toBe(undefined);
    const withManifest = {
      ...raw,
      reviewedUntracked: [{ path: "src/new.ts", blob: "blob1111" }],
    };
    expect(parseWorkflowState(withManifest)?.reviewedUntracked).toEqual([
      { path: "src/new.ts", blob: "blob1111" },
    ]);
    expect(parseWorkflowState({ ...raw, reviewedUntracked: [{ path: 42 }] })).toBe(undefined);
  });

  it("round-trips a pending review scope (bd-228)", () => {
    const result = saveReviewScope({
      cwd,
      store,
      now: () => 9_000,
      taskId: "bd-42",
      sha: "decaf00",
      untracked: [{ path: "src/new.ts", blob: "blob1111" }],
    });

    expect(result).toEqual({ ok: true });
    expect(readReviewScope({ cwd, store, taskId: "bd-42" })).toEqual({
      taskId: "bd-42",
      sha: "decaf00",
      untracked: [{ path: "src/new.ts", blob: "blob1111" }],
      capturedAt: 9_000,
    });
  });

  it("replaces the previous review scope so only the newest build can promote it", () => {
    saveReviewScope({
      cwd,
      store,
      taskId: "bd-42",
      sha: "old1234",
      untracked: [{ path: "src/old.ts", blob: "blob0000" }],
    });

    const result = saveReviewScope({ cwd, store, taskId: "bd-42", sha: "new1234", untracked: [] });

    expect(result).toEqual({ ok: true });
    expect(readReviewScope({ cwd, store, taskId: "bd-42" })).toHaveProperty("sha", "new1234");
    expect(readReviewScope({ cwd, store, taskId: "bd-42" })).toHaveProperty("untracked", []);
    // The retired file path never appears.
    expect(reviewScopeFilePath(cwd)).toBe(join(cwd, ".belayd", "review-scope.json"));
  });

  it("treats a missing, corrupt or invalid review scope as no scope", () => {
    expect(readReviewScope({ cwd, store, taskId: "bd-42" })).toBe(undefined);

    saveReviewScope({ cwd, store, taskId: "bd-42", sha: "abc1234", untracked: [] });
    const database = new DatabaseSync(storePath);
    database
      .prepare("UPDATE review_scope SET payload = 'not json' WHERE worktree_path = ?")
      .run(cwd);
    database
      .prepare("UPDATE review_scope SET payload = ? WHERE worktree_path = ?")
      .run(JSON.stringify({ taskId: "bd-42", sha: 42 }), cwd);
    database.close();
    expect(readReviewScope({ cwd, store, taskId: "bd-42" })).toBe(undefined);

    expect(parseReviewScope({ taskId: "bd-42", sha: "abc1234", untracked: [] })).toBe(undefined);
  });

  it("reports a review-scope write failure as a value", () => {
    store.close();
    const result = saveReviewScope({ cwd, store, taskId: "bd-42", sha: "abc1234", untracked: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("closed");
  });

  it("clears the pending review scope and tolerates a missing row", () => {
    saveReviewScope({ cwd, store, taskId: "bd-42", sha: "abc1234", untracked: [] });

    expect(clearReviewScope({ cwd, store, taskId: "bd-42" })).toEqual({ ok: true });
    expect(readReviewScope({ cwd, store, taskId: "bd-42" })).toBe(undefined);
    // Consuming an absent scope is the expected success case.
    expect(clearReviewScope({ cwd, store, taskId: "bd-42" })).toEqual({ ok: true });
  });

  it("savePhaseSession upserts one entry and preserves identity fields", () => {
    writeWorkflowState({
      cwd,
      state: sampleState({ startedAt: 5_000, updatedAt: 5_000 }),
      store,
    });

    const result = savePhaseSession({
      cwd,
      store,
      now: () => 9_000,
      phaseName: "implement",
      record: { base: "belayd-bd-42-sub-implement-a", invocations: 1 },
    });

    expect(result).toEqual({ ok: true });
    const reloaded = readWorkflowState({ cwd, store });
    expect(reloaded).toHaveProperty("taskId", "bd-42");
    expect(reloaded).toHaveProperty("startedAt", 5_000);
    expect(reloaded).toHaveProperty("updatedAt", 9_000);
    expect(reloaded?.phaseSessions).toEqual({
      implement: { base: "belayd-bd-42-sub-implement-a", invocations: 1 },
    });
  });

  it("savePhaseSession keeps other phases' entries independent", () => {
    writeWorkflowState({ cwd, state: sampleState(), store });

    savePhaseSession({
      cwd,
      store,
      phaseName: "implement",
      record: { base: "impl", invocations: 1 },
    });
    savePhaseSession({ cwd, store, phaseName: "review", record: { base: "rev", invocations: 2 } });
    savePhaseSession({
      cwd,
      store,
      phaseName: "implement",
      record: { base: "impl", invocations: 2 },
    });

    expect(readWorkflowState({ cwd, store })?.phaseSessions).toEqual({
      implement: { base: "impl", invocations: 2 },
      review: { base: "rev", invocations: 2 },
    });
  });

  it("treats a pre-bd-81 workflow (no phaseSessions) as an empty ledger", () => {
    // writeWorkflowState omits phaseSessions because sampleState never sets it.
    writeWorkflowState({ cwd, state: sampleState(), store });
    expect(readWorkflowState({ cwd, store })?.phaseSessions).toBe(undefined);

    const result = savePhaseSession({
      cwd,
      store,
      phaseName: "review",
      record: { base: "rev", invocations: 1 },
    });
    expect(result).toEqual({ ok: true });
    expect(readWorkflowState({ cwd, store })?.phaseSessions).toEqual({
      review: { base: "rev", invocations: 1 },
    });
  });

  it("savePhaseSession returns an error when no state exists", () => {
    const result = savePhaseSession({
      cwd,
      store,
      phaseName: "review",
      record: { base: "rev", invocations: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No Belayd workflow state");
  });

  it("savePhaseSession accepts a pre-read state", () => {
    writeWorkflowState({ cwd, state: sampleState(), store });
    const existing = readWorkflowState({ cwd, store });
    expect(existing).toBeDefined();
    if (existing === undefined) return;

    const result = savePhaseSession({
      cwd,
      store,
      existingState: existing,
      phaseName: "implement",
      record: { base: "impl", invocations: 2 },
    });
    expect(result).toEqual({ ok: true });
    expect(readWorkflowState({ cwd, store })?.phaseSessions?.implement).toEqual({
      base: "impl",
      invocations: 2,
    });
  });

  it("savePhaseSession refuses to write over a row it cannot read", () => {
    writeWorkflowState({ cwd, state: sampleState(), store });
    corruptWorkflowColumn("bd-42", "completed_phase_names", "not json");

    const result = savePhaseSession({
      cwd,
      store,
      phaseName: "review",
      record: { base: "rev", invocations: 1 },
    });
    expect(result.ok).toBe(false);
  });

  it("returns an error value (no throw) when the store is closed", () => {
    store.close();
    expect(writeWorkflowState({ cwd, state: sampleState(), store })).toHaveProperty("ok", false);
    expect(
      savePhaseSession({
        cwd,
        store,
        phaseName: "review",
        record: { base: "rev", invocations: 1 },
      }),
    ).toHaveProperty("ok", false);
  });

  it("refuses to persist a workflow that does not match the schema", () => {
    const invalid = { ...sampleState(), phaseOrder: ["scout", 1] };
    const result = writeWorkflowState({
      cwd,
      // The schema is the validation boundary on the way into the store.
      state: invalid as unknown as WorkflowState,
      store,
    });
    expect(result.ok).toBe(false);
    expect(readWorkflowState({ cwd, store })).toBe(undefined);
  });

  it("clearWorkflowState removes only the workflow row", () => {
    writeWorkflowState({ cwd, state: sampleState(), store });
    saveReviewScope({ cwd, store, taskId: "bd-42", sha: "abc1234", untracked: [] });

    clearWorkflowState({ cwd, store });
    expect(readWorkflowState({ cwd, store })).toBe(undefined);
    // Unrelated state is untouched.
    expect(readReviewScope({ cwd, store, taskId: "bd-42" })).toHaveProperty("sha", "abc1234");

    // No row present: must not throw.
    expect(() => clearWorkflowState({ cwd, store })).not.toThrow();
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
    // fires first, and both reasons skip the claim.
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

describe("archiveWorkflowState (bd-165, bd-281)", () => {
  it("discards the inert record instead of keeping a copy of executable state", () => {
    writeWorkflowState({
      cwd,
      state: sampleState({ completedPhaseNames: ["scout", "plan"] }),
      store,
    });

    const result = archiveWorkflowState({ cwd, store, now: () => 7_654 });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.archived) throw new Error("expected an archived result");
    // A stale *copy* of state is the bug this change removes, so the record is
    // deleted and the return type has no archive path to mislead a caller.
    expect(readWorkflowState({ cwd, store })).toBe(undefined);
    expect(workflowStateDir(cwd)).toBe(join(cwd, ".belayd"));
  });

  it("reports the missing-row no-op explicitly", () => {
    expect(archiveWorkflowState({ cwd, store, now: () => 7_654 })).toEqual({
      ok: true,
      archived: false,
    });
  });

  it("reports an unavailable store as a value", () => {
    store.close();
    const result = archiveWorkflowState({ cwd, store });
    expect(result.ok).toBe(false);
  });
});

describe("handoff marker", () => {
  const marker = { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" };

  it("parses state without a marker (backwards compatible)", () => {
    const parsed = parseWorkflowState(sampleState());
    expect(parsed?.handedOffTo).toBe(undefined);
  });

  it("records the marker while preserving the workflow identity", () => {
    writeWorkflowState({ cwd, state: sampleState({ completedPhaseNames: ["implement"] }), store });

    const saved = saveHandedOffMarker({ cwd, store, marker });

    expect(saved.ok).toBe(true);
    const persisted = readWorkflowState({ cwd, store });
    expect(persisted).toHaveProperty("taskId", "bd-42");
    expect(persisted).toHaveProperty("completedPhaseNames", ["implement"]);
    expect(persisted).toHaveProperty("handedOffTo", marker);
  });

  it("saveHandedOffMarker reports a missing state instead of creating one", () => {
    const saved = saveHandedOffMarker({ cwd, store, marker });

    expect(saved.ok).toBe(false);
    expect(readWorkflowState({ cwd, store })).toBe(undefined);
  });

  it("clears only the marker and keeps the workflow state", () => {
    writeWorkflowState({ cwd, state: sampleState({ completedPhaseNames: ["implement"] }), store });
    saveHandedOffMarker({ cwd, store, marker });

    const cleared = clearHandedOffMarker({ cwd, store });

    expect(cleared.ok).toBe(true);
    const persisted = readWorkflowState({ cwd, store });
    expect(persisted).toHaveProperty("taskId", "bd-42");
    expect(persisted).toHaveProperty("completedPhaseNames", ["implement"]);
    expect(persisted?.handedOffTo).toBe(undefined);
  });

  it("clearing a missing state is a no-op success", () => {
    expect(clearHandedOffMarker({ cwd, store }).ok).toBe(true);
    expect(readWorkflowState({ cwd, store })).toBe(undefined);
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

  it("keeps the retired path helper (naming the file the migration refuses)", () => {
    expect(callerHandoffFilePath(cwd, "a/b:c d")).toBe(
      join(cwd, ".belayd", "handoff-a_b_c_d.json"),
    );
    expect(callerHandoffFilePath(cwd, sessionKey)).toBe(
      join(cwd, ".belayd", `handoff-${sessionKey}.json`),
    );
  });

  it("round-trips a marker and survives unrelated workflow rewrites", () => {
    const written = writeCallerHandoff({ cwd, store, sessionKey, marker });
    // A same-directory child writes its own workflow over the caller's.
    writeWorkflowState({ cwd, state: sampleState({ taskId: "bd-101" }), store });

    expect(written.ok).toBe(true);
    expect(readCallerHandoff({ cwd, store, sessionKey })).toEqual(marker);
    expect(readWorkflowState({ cwd, store })?.handedOffTo).toBe(undefined);
  });

  it("returns undefined for another session or an unreadable row", () => {
    writeCallerHandoff({ cwd, store, sessionKey, marker });

    expect(readCallerHandoff({ cwd, store, sessionKey: "other-session" })).toBe(undefined);

    const database = new DatabaseSync(storePath);
    database
      .prepare(
        "UPDATE workflow_handoff SET payload = ? WHERE worktree_path = ? AND handoff_key = ?",
      )
      .run(JSON.stringify({ taskId: "bd-101" }), cwd, sessionKey);
    database.close();
    expect(readCallerHandoff({ cwd, store, sessionKey })).toBe(undefined);
  });

  it("clears only the caller's marker", () => {
    writeCallerHandoff({ cwd, store, sessionKey, marker });
    writeCallerHandoff({ cwd, store, sessionKey: "other-session", marker });

    expect(clearCallerHandoff({ cwd, store, sessionKey }).ok).toBe(true);
    expect(readCallerHandoff({ cwd, store, sessionKey })).toBe(undefined);
    expect(readCallerHandoff({ cwd, store, sessionKey: "other-session" })).toEqual(marker);
  });

  it("clearing a missing marker is a no-op success", () => {
    expect(clearCallerHandoff({ cwd, store, sessionKey }).ok).toBe(true);
  });

  it("writeCallerHandoff reports an unavailable store instead of throwing", () => {
    store.close();
    const written = writeCallerHandoff({ cwd, store, sessionKey, marker });
    expect(written.ok).toBe(false);
  });

  it("parses a marker only when every field is present", () => {
    expect(parseHandedOffMarker(marker)).toEqual(marker);
    expect(parseHandedOffMarker({ taskId: marker.taskId })).toBe(undefined);
    expect(parseHandedOffMarker(null)).toBe(undefined);
  });
});
