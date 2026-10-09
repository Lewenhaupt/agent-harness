/**
 * End-to-end stack rebase against real git repositories.
 *
 * Reproduces the squash-merge landing failure mode: the parent branch is
 * deleted after landing, so `git merge-base --fork-point` can no longer find
 * its ref and only the recorded `belaydForkPoint` config survives. The child
 * must be replayed with `git rebase --onto main <fork-point> child`, dropping
 * the parent's commits.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultGitExec,
  readStackNode,
  resolveStackChain,
  runStackRebase,
  writeStackBase,
} from "../src/stack-rebase.js";
import { gitContextFreeEnv } from "../src/worktree.js";

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    env: gitContextFreeEnv(),
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(["add", "."], cwd);
  git(["commit", "-qm", message], cwd);
}

function subjects(cwd: string, rev: string): string[] {
  return git(["log", "--format=%s", rev], cwd)
    .split("\n")
    .filter((line) => line !== "");
}

describe("stack rebase (integration)", () => {
  let repo: string;
  let childWorktree: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "belayd-stack-"));
    childWorktree = mkdtempSync(join(tmpdir(), "belayd-stack-child-"));

    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "test@example.com"], repo);
    git(["config", "user.name", "Test"], repo);

    commit(repo, "base.txt", "base\n", "main-base");

    git(["checkout", "-qb", "feat/parent"], repo);
    commit(repo, "parent.txt", "parent\n", "parent-change");

    git(["checkout", "-qb", "feat/child"], repo);
    commit(repo, "child.txt", "child\n", "child-change");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(childWorktree, { recursive: true, force: true });
  });

  it("records the base and fork point in git config and sets the upstream", () => {
    const forkPoint = git(["rev-parse", "feat/parent"], repo);

    const result = writeStackBase(defaultGitExec, {
      cwd: repo,
      branch: "feat/child",
      base: "feat/parent",
      forkPoint,
    });

    expect(result).toEqual({ ok: true });
    expect(git(["config", "--get", "branch.feat/child.belaydBase"], repo)).toBe("feat/parent");
    expect(git(["config", "--get", "branch.feat/child.belaydForkPoint"], repo)).toBe(forkPoint);
    expect(git(["rev-parse", "--abbrev-ref", "feat/child@{upstream}"], repo)).toBe("feat/parent");
  });

  it("replays only the child commit onto the landed main tip after the parent is deleted", () => {
    const forkPoint = git(["rev-parse", "feat/parent"], repo);
    writeStackBase(defaultGitExec, {
      cwd: repo,
      branch: "feat/child",
      base: "feat/parent",
      forkPoint,
    });

    // Simulate a squash-style landing: main advances with a different commit
    // that represents the parent's work, then the parent branch is deleted so
    // no ref can prove the fork point any more.
    git(["checkout", "-q", "main"], repo);
    commit(repo, "parent-landed.txt", "parent (landed)\n", "parent-change (squashed)");
    const landedMainTip = git(["rev-parse", "main"], repo);
    git(["branch", "-D", "feat/parent"], repo);

    // Detect the deleted parent before rebasing.
    const resolved = resolveStackChain(repo, "feat/child");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.chain).toEqual([
        {
          branch: "feat/child",
          base: "main",
          forkPoint,
          landedParent: "feat/parent",
        },
      ]);
    }

    // The child must be checked out in its own worktree for the stepwise rebase.
    git(["worktree", "add", "-q", childWorktree, "feat/child"], repo);

    const result = runStackRebase(defaultGitExec, { cwd: repo, leaf: "feat/child" });

    expect(result).toEqual({ ok: true, rebased: ["feat/child"], skipped: [] });
    // The child's own commit is replayed, the original parent commit is not.
    const log = subjects(repo, "feat/child");
    expect(log).toEqual(["child-change", "parent-change (squashed)", "main-base"]);
    expect(log).not.toContain("parent-change");
    // The new main tip is the parent's base, and the fork point was refreshed.
    expect(git(["rev-parse", "feat/child~1"], repo)).toBe(landedMainTip);
    expect(git(["config", "--get", "branch.feat/child.belaydForkPoint"], repo)).toBe(landedMainTip);
    expect(readStackNode(repo, "feat/child")?.forkPoint).toBe(landedMainTip);
  });
});
