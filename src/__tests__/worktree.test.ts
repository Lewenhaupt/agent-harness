import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isInsideWorktreeForBranch, resolveWorktreePath, setupWorktree } from "../worktree.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExistsSync = vi.mocked(existsSync);

const PORCELAIN_SINGLE = [
  "worktree /repo/main",
  "branch refs/heads/main",
  "",
  "worktree /repo/feat",
  "branch refs/heads/feat/bd-42",
  "",
].join("\n");

const PORCELAIN_MULTI = [
  "worktree /repo/main",
  "branch refs/heads/main",
  "",
  "worktree /repo/feat",
  "branch refs/heads/feat/bd-42",
  "",
  "worktree /repo/fix",
  "branch refs/heads/fix/bd-18",
  "",
].join("\n");

/** Porcelain output that does NOT contain feat/bd-42 (used when the worktree hasn't been created yet). */
const PORCELAIN_WITHOUT_FEAT = ["worktree /repo/main", "branch refs/heads/main", ""].join("\n");

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveWorktreePath", () => {
  it("returns the worktree path when the branch is found", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE);

    const result = resolveWorktreePath("/repo", "feat/bd-42");

    expect(result).toBe("/repo/feat");
    expect(mockedExecSync).toHaveBeenCalledWith("git worktree list --porcelain", {
      cwd: "/repo",
      timeout: 10_000,
      encoding: "utf8",
    });
  });

  it("returns undefined when the branch is not found", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE);

    const result = resolveWorktreePath("/repo", "feat/NOPE");

    expect(result).toBeUndefined();
  });

  it("returns undefined when git fails", () => {
    mockedExecSync.mockImplementationOnce(() => {
      throw new Error("git failed");
    });

    const result = resolveWorktreePath("/repo", "feat/bd-42");

    expect(result).toBeUndefined();
  });

  it("handles multiple worktrees and resolves each branch", () => {
    mockedExecSync.mockReturnValue(PORCELAIN_MULTI);

    expect(resolveWorktreePath("/repo", "feat/bd-42")).toBe("/repo/feat");
    expect(resolveWorktreePath("/repo", "fix/bd-18")).toBe("/repo/fix");
  });
});

describe("isInsideWorktreeForBranch", () => {
  it("returns true when cwd is a linked worktree for the branch", () => {
    mockedExecSync.mockReturnValueOnce("feat/bd-42\n").mockReturnValueOnce(PORCELAIN_SINGLE);

    const result = isInsideWorktreeForBranch("/repo/feat", "feat/bd-42");

    expect(result).toBe(true);
  });

  it("returns false when the current branch differs", () => {
    mockedExecSync.mockReturnValueOnce("main\n");

    const result = isInsideWorktreeForBranch("/repo/feat", "feat/bd-42");

    expect(result).toBe(false);
  });

  it("returns false when commands fail", () => {
    mockedExecSync.mockImplementationOnce(() => {
      throw new Error("not a git repo");
    });

    const result = isInsideWorktreeForBranch("/repo", "feat/bd-42");

    expect(result).toBe(false);
  });

  it("returns false when cwd is not listed as a worktree", () => {
    mockedExecSync.mockReturnValueOnce("feat/bd-42\n").mockReturnValueOnce(PORCELAIN_SINGLE);

    const result = isInsideWorktreeForBranch("/elsewhere", "feat/bd-42");

    expect(result).toBe(false);
  });
});

describe("setupWorktree", () => {
  it("returns the worktree path immediately when already registered in git", () => {
    // The initial resolveWorktreePath check finds the worktree — no wt call needed.
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // resolveWorktreePath → found

    const result = setupWorktree("/repo", { branch: "feat/bd-42" });

    expect(result).toBe("/repo/feat");
    // wt must NOT be called — the worktree is already set up.
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("creates a new worktree with --create --base main -y when branch and directory don't exist", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync
      .mockReturnValueOnce("") // git branch --list → empty
      .mockReturnValueOnce(""); // wt switch --create → success
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // final resolveWorktreePath → found
    mockedExistsSync.mockReturnValueOnce(false); // directory does not exist

    const result = setupWorktree("/repo", { branch: "feat/bd-42" });

    expect(result).toBe("/repo/feat");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "wt",
      ["switch", "--create", "feat/bd-42", "--base", "main", "-y"],
      expect.objectContaining({ timeout: 30_000, stdio: "pipe" }),
    );
  });

  it("uses --clobber when the directory exists but the worktree is not registered", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync
      .mockReturnValueOnce("") // git branch --list → empty
      .mockReturnValueOnce(""); // wt switch --create --clobber → success
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // final resolveWorktreePath → found
    mockedExistsSync.mockReturnValueOnce(true); // directory exists (orphaned)

    const result = setupWorktree("/repo", { branch: "feat/bd-42" });

    expect(result).toBe("/repo/feat");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "wt",
      ["switch", "--create", "feat/bd-42", "--base", "main", "--clobber", "-y"],
      expect.objectContaining({ timeout: 30_000, stdio: "pipe" }),
    );
  });

  it("reuses the existing branch with wt switch when branch exists but worktree not registered", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync
      .mockReturnValueOnce("feat/bd-42\n") // git branch --list → exists
      .mockReturnValueOnce(""); // wt switch → success
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // final resolveWorktreePath → found

    const result = setupWorktree("/repo", { branch: "feat/bd-42" });

    expect(result).toBe("/repo/feat");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "wt",
      ["switch", "feat/bd-42", "-y"],
      expect.objectContaining({ timeout: 30_000, stdio: "pipe" }),
    );
  });

  it("throws when the wt command fails", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync.mockReturnValueOnce(""); // git branch --list
    mockedExistsSync.mockReturnValueOnce(false); // directory does not exist
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error("wt not found");
    }); // wt switch fails

    expect(() => setupWorktree("/repo", { branch: "feat/bd-42" })).toThrow(
      "Failed to set up worktree: wt not found. Make sure `wt` (Worktrunk) is installed.",
    );
  });

  it("throws when the worktree path cannot be resolved after creation", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync
      .mockReturnValueOnce("") // git branch --list
      .mockReturnValueOnce(""); // wt switch → success
    mockedExecSync.mockReturnValueOnce(""); // final resolveWorktreePath → no match
    mockedExistsSync.mockReturnValueOnce(false); // directory does not exist

    expect(() => setupWorktree("/repo", { branch: "feat/bd-42" })).toThrow(
      "Could not resolve worktree path after creation. Check `git worktree list`.",
    );
  });

  it("uses the custom base when provided", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync
      .mockReturnValueOnce("") // git branch --list
      .mockReturnValueOnce(""); // wt switch --create → success
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // final resolveWorktreePath → found
    mockedExistsSync.mockReturnValueOnce(false); // directory does not exist

    const result = setupWorktree("/repo", { branch: "feat/bd-42", base: "develop" });

    expect(result).toBe("/repo/feat");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "wt",
      ["switch", "--create", "feat/bd-42", "--base", "develop", "-y"],
      expect.objectContaining({ timeout: 30_000, stdio: "pipe" }),
    );
  });
});
