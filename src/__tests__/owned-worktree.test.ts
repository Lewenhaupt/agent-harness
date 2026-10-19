/**
 * Tests for the bead ↔ branch ↔ worktree preflight (bd-119).
 *
 * The matchers are pure: every case is driven by explicit values, so the unit
 * tests need no mocks. Only the git-backed branch reader is side-effecting and
 * gets a mocked `node:child_process`.
 */

import { describe, expect, it, vi } from "vitest";
import type { WorktreeBranch } from "../owned-worktree.js";
import {
  assertOwnedWorktree,
  formatWorktreePreamble,
  isSameOrDescendantTask,
  matchOwnedWorktree,
  matchSessionOwnedWorktree,
  readWorktreeBranch,
} from "../owned-worktree.js";
import type { WorkflowState } from "../workflow-state.js";

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: mockExecFileSync };
});

function workflowState(taskId: string, branch: string): WorkflowState {
  return {
    schemaVersion: 1,
    taskId,
    workflowType: "feature",
    branch,
    originalCwd: "/repo",
    phaseOrder: ["plan", "implement", "review", "test", "commit"],
    completedPhaseNames: [],
    startedAt: 0,
    updatedAt: 0,
  };
}

function onBranch(branch: string): WorktreeBranch {
  return { ok: true, branch };
}

const detached: WorktreeBranch = { ok: false, reason: "detached" };

describe("matchOwnedWorktree", () => {
  it("matches when the task and branch both belong to the worktree", () => {
    const result = matchOwnedWorktree({
      cwd: "/repo/feat-bd-42",
      taskId: "bd-42",
      branch: onBranch("feat/bd-42"),
      persisted: workflowState("bd-42", "feat/bd-42"),
    });

    expect(result).toEqual({ ok: true, branch: "feat/bd-42" });
  });

  it("rejects a phase for another task and names both sides", () => {
    const result = matchOwnedWorktree({
      cwd: "/repo/feat-bd-87",
      taskId: "bd-80",
      branch: onBranch("feat/bd-87"),
      persisted: workflowState("bd-87", "feat/bd-87"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("bd-87 lives in /repo/feat-bd-87");
      expect(result.error).toContain("feat/bd-87");
      expect(result.error).toContain("this session is for bd-80");
      expect(result.error).toContain("owns bd-80's worktree");
    }
  });

  it("rejects a different branch checked out in the owning worktree", () => {
    const result = matchOwnedWorktree({
      cwd: "/repo/feat-bd-42",
      taskId: "bd-42",
      branch: onBranch("feat/bd-80"),
      persisted: workflowState("bd-42", "feat/bd-42"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("bd-42 lives in /repo/feat-bd-42");
      expect(result.error).toContain("branch feat/bd-42");
      expect(result.error).toContain("branch feat/bd-80");
    }
  });

  it("rejects a cwd with no workflow state", () => {
    const result = matchOwnedWorktree({
      cwd: "/repo/feat-bd-42",
      taskId: "bd-42",
      branch: onBranch("feat/bd-42"),
      persisted: undefined,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No Belayd workflow state in /repo/feat-bd-42");
      expect(result.error).toContain("bd-42");
      expect(result.error).toContain("owns that worktree");
    }
  });

  it("rejects detached HEAD when the workflow recorded a branch", () => {
    const result = matchOwnedWorktree({
      cwd: "/repo/feat-bd-42",
      taskId: "bd-42",
      branch: detached,
      persisted: workflowState("bd-42", "feat/bd-42"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("detached HEAD");
      expect(result.error).toContain("check out feat/bd-42");
    }
  });

  it("reports an unreadable repository separately from detached HEAD", () => {
    const result = matchOwnedWorktree({
      cwd: "/repo/not-a-repo",
      taskId: "bd-42",
      branch: { ok: false, reason: "unavailable", error: "not a git repository" },
      persisted: workflowState("bd-42", "feat/bd-42"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("could not read the branch");
      expect(result.error).toContain("not a git repository");
      expect(result.error).not.toContain("detached HEAD");
    }
  });

  it("accepts a legacy workflow with no recorded branch after the task matches", () => {
    const result = matchOwnedWorktree({
      cwd: "/repo",
      taskId: "bd-42",
      branch: detached,
      persisted: workflowState("bd-42", ""),
    });

    expect(result).toEqual({ ok: true, branch: "detached HEAD" });
  });
});

describe("isSameOrDescendantTask", () => {
  it("accepts the same task", () => {
    expect(isSameOrDescendantTask("bd-42", "bd-42")).toBe(true);
  });

  it("accepts sub-bead descendants", () => {
    expect(isSameOrDescendantTask("bd-42.1", "bd-42")).toBe(true);
    expect(isSameOrDescendantTask("bd-42.1.2", "bd-42")).toBe(true);
  });

  it("rejects a different bead", () => {
    expect(isSameOrDescendantTask("bd-99", "bd-42")).toBe(false);
  });

  it("rejects a parent supplied from a sub-bead session", () => {
    expect(isSameOrDescendantTask("bd-42", "bd-42.1")).toBe(false);
  });

  it("rejects prefix lookalikes and malformed ids", () => {
    expect(isSameOrDescendantTask("bd-42x", "bd-42")).toBe(false);
    expect(isSameOrDescendantTask("bd-42.", "bd-42")).toBe(false);
    expect(isSameOrDescendantTask("bd-4", "bd-42")).toBe(false);
  });
});

describe("matchSessionOwnedWorktree", () => {
  it("allows a post-completion rework when the gate is off and cwd has no workflow state", () => {
    const result = matchSessionOwnedWorktree({
      cwd: "/repo/feat-bd-42",
      currentTaskId: "bd-42",
      gateActive: false,
      branch: onBranch("feat/bd-42"),
      persisted: undefined,
    });

    expect(result).toEqual({ ok: true, branch: "feat/bd-42" });
  });

  it("refuses a gate-off session when cwd holds a foreign workflow state", () => {
    const result = matchSessionOwnedWorktree({
      cwd: "/repo/feat-bd-99",
      currentTaskId: "bd-42",
      gateActive: false,
      branch: onBranch("feat/bd-99"),
      persisted: workflowState("bd-99", "feat/bd-99"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("bd-99 lives in /repo/feat-bd-99");
      expect(result.error).toContain("this session is for bd-42");
    }
  });

  it("refuses a session with no active task inside another task's live worktree", () => {
    const result = matchSessionOwnedWorktree({
      cwd: "/repo/feat-bd-99",
      currentTaskId: "",
      gateActive: false,
      branch: onBranch("feat/bd-99"),
      persisted: workflowState("bd-99", "feat/bd-99"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("bd-99 owns /repo/feat-bd-99");
      expect(result.error).toContain("branch feat/bd-99");
      expect(result.error).toContain("start bd-99");
      expect(result.error).toContain("your own worktree");
    }
  });

  it("allows a session with no active task when cwd has no workflow state", () => {
    const result = matchSessionOwnedWorktree({
      cwd: "/repo/plain",
      currentTaskId: "",
      gateActive: false,
      branch: onBranch("main"),
      persisted: undefined,
    });

    expect(result).toEqual({ ok: true, branch: "main" });
  });

  it("leaves the branch unknown when git is unavailable", () => {
    const result = matchSessionOwnedWorktree({
      cwd: "/repo/plain",
      currentTaskId: "",
      gateActive: false,
      branch: { ok: false, reason: "unavailable", error: "git missing" },
      persisted: undefined,
    });

    expect(result).toEqual({ ok: true, branch: undefined });
    if (result.ok) {
      expect(formatWorktreePreamble({ cwd: "/repo/plain", branch: result.branch })).not.toContain(
        "detached HEAD",
      );
    }
  });
});

describe("assertOwnedWorktree", () => {
  it("reads workflow state and matches through the injected reader", () => {
    const result = assertOwnedWorktree({
      cwd: "/repo/feat-bd-42",
      taskId: "bd-42",
      branch: onBranch("feat/bd-42"),
      readState: () => workflowState("bd-42", "feat/bd-42"),
    });

    expect(result).toEqual({ ok: true, branch: "feat/bd-42" });
  });
});

describe("readWorktreeBranch", () => {
  it("returns the checked-out branch from git branch --show-current", () => {
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue("feat/bd-42\n");

    expect(readWorktreeBranch("/repo/feat-bd-42")).toEqual({
      ok: true,
      branch: "feat/bd-42",
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["branch", "--show-current"],
      expect.objectContaining({ cwd: "/repo/feat-bd-42" }),
    );
  });

  it("reports detached HEAD distinctly", () => {
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue("\n");

    expect(readWorktreeBranch("/repo/feat-bd-42")).toEqual({
      ok: false,
      reason: "detached",
    });
  });

  it("reports git failure separately from detached HEAD", () => {
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not a git repository");
    });

    expect(readWorktreeBranch("/repo/not-a-repo")).toEqual({
      ok: false,
      reason: "unavailable",
      error: "not a git repository",
    });
  });
});

describe("formatWorktreePreamble", () => {
  it("names the worktree path and branch", () => {
    expect(formatWorktreePreamble({ cwd: "/repo/feat-bd-42", branch: "feat/bd-42" })).toBe(
      "Your worktree is /repo/feat-bd-42 on feat/bd-42; writing elsewhere is a bug, not a workaround.",
    );
  });

  it("keeps the detached HEAD label when git reports detached HEAD", () => {
    expect(formatWorktreePreamble({ cwd: "/repo/feat-bd-42", branch: "detached HEAD" })).toBe(
      "Your worktree is /repo/feat-bd-42 on detached HEAD; writing elsewhere is a bug, not a workaround.",
    );
  });

  it("omits the branch clause when the branch is unknown", () => {
    expect(formatWorktreePreamble({ cwd: "/repo/feat-bd-42", branch: undefined })).toBe(
      "Your worktree is /repo/feat-bd-42; writing elsewhere is a bug, not a workaround.",
    );
  });
});
