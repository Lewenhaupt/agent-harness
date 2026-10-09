import { describe, expect, it } from "vitest";
import type { GitExec, StackNode } from "../stack-rebase.js";
import {
  AUTO_REBASE_CONFIG_KEY,
  AUTO_REBASE_ENV_KEY,
  branchExists,
  currentBranch,
  DEFAULT_BASE_BRANCH,
  planStackRebase,
  readStackNode,
  resolveAutoRebaseEnabled,
  resolveStackChain,
  runStackRebase,
  writeStackBase,
} from "../stack-rebase.js";

interface FakeGitInit {
  config?: Record<string, string>;
  refs?: Record<string, string>;
  worktrees?: Array<[string, string]>;
  mergeBase?: Record<string, string>;
  dirty?: string[];
  failures?: Record<string, Error>;
}

function handleFakeConfig(rest: string[], config: Record<string, string>): string {
  if (rest[0] !== "--get") {
    config[rest[0] ?? ""] = rest[1] ?? "";
    return "";
  }
  const value = config[rest[1] ?? ""];
  if (value === undefined) throw new Error(`no such key: ${rest[1]}`);
  return `${value}\n`;
}

function handleFakeRevParse(
  rest: string[],
  config: Record<string, string>,
  refs: Record<string, string>,
): string {
  if (rest[0] === "--abbrev-ref") {
    const value = config.__head;
    if (value === undefined) throw new Error("detached");
    return `${value}\n`;
  }
  if (rest[0] === "--verify") {
    const name = (rest[2] ?? "").replace("refs/heads/", "");
    const sha = refs[name];
    if (sha === undefined) throw new Error(`unknown ref ${name}`);
    return `${sha}\n`;
  }
  const name = (rest[0] ?? "").replace(/\^\{commit\}$/, "");
  const sha = refs[name];
  if (sha === undefined) throw new Error(`unknown ref ${name}`);
  return `${sha}\n`;
}

function handleFakeWorktree(worktrees: Map<string, string>): string {
  const lines: string[] = [];
  for (const [branch, path] of worktrees) {
    lines.push(`worktree ${path}`, "HEAD 0", `branch refs/heads/${branch}`, "");
  }
  return lines.join("\n");
}

function fakeGit(init: FakeGitInit = {}) {
  const config: Record<string, string> = { ...init.config };
  const refs: Record<string, string> = { ...init.refs };
  const worktrees = new Map<string, string>(init.worktrees ?? []);
  const mergeBase: Record<string, string> = { ...init.mergeBase };
  const dirty = new Set<string>(init.dirty ?? []);
  const failures = new Map<string, Error>(Object.entries(init.failures ?? {}));
  const calls: Array<{ args: string[]; cwd: string }> = [];

  const git: GitExec = (args, cwd) => {
    const a = [...args];
    calls.push({ args: a, cwd });
    const key = a.join(" ");
    const failure = failures.get(key);
    if (failure) throw failure;

    const [cmd, ...rest] = a;
    switch (cmd) {
      case "config":
        return handleFakeConfig(rest, config);
      case "rev-parse":
        return handleFakeRevParse(rest, config, refs);
      case "merge-base":
        return `${mergeBase[`${rest[1] ?? ""} ${rest[2] ?? ""}`] ?? ""}`;
      case "worktree":
        return handleFakeWorktree(worktrees);
      case "status":
        return dirty.has(cwd) ? " M changed.ts\n" : "";
      case "stash":
        if (rest[0] === "push") dirty.delete(cwd);
        return "";
      case "rebase": {
        const branch = rest[3] ?? "";
        refs[branch] = `rebased-${branch}`;
        return "";
      }
      case "branch":
        return "";
      default:
        throw new Error(`unexpected git: ${key}`);
    }
  };

  return { git, calls, config, refs, dirty };
}

describe("readStackNode", () => {
  it("reads base and fork point from branch config", () => {
    const { git } = fakeGit({
      config: {
        "branch.feat/b.belaydBase": "feat/a",
        "branch.feat/b.belaydForkPoint": "sha-fork",
      },
    });

    expect(readStackNode("/repo", "feat/b", git)).toEqual({
      branch: "feat/b",
      base: "feat/a",
      forkPoint: "sha-fork",
    });
  });

  it("defaults base to main when only a fork point is recorded", () => {
    const { git } = fakeGit({ config: { "branch.feat/b.belaydForkPoint": "sha-fork" } });

    expect(readStackNode("/repo", "feat/b", git)).toEqual({
      branch: "feat/b",
      base: DEFAULT_BASE_BRANCH,
      forkPoint: "sha-fork",
    });
  });

  it("returns undefined when no stack metadata exists", () => {
    const { git } = fakeGit();

    expect(readStackNode("/repo", "feat/b", git)).toBeUndefined();
  });
});

describe("writeStackBase", () => {
  it("writes both config keys and sets the upstream", () => {
    const { git, calls, config } = fakeGit();

    const result = writeStackBase(git, {
      cwd: "/repo",
      branch: "feat/b",
      base: "feat/a",
      forkPoint: "sha-fork",
    });

    expect(result).toEqual({ ok: true });
    expect(config["branch.feat/b.belaydBase"]).toBe("feat/a");
    expect(config["branch.feat/b.belaydForkPoint"]).toBe("sha-fork");
    expect(calls.map((call) => call.args)).toContainEqual([
      "branch",
      "--set-upstream-to=feat/a",
      "feat/b",
    ]);
  });

  it("returns an error value when a git command fails", () => {
    const { git } = fakeGit({
      failures: { "branch --set-upstream-to=feat/a feat/b": new Error("boom") },
    });

    expect(
      writeStackBase(git, { cwd: "/repo", branch: "feat/b", base: "feat/a", forkPoint: "sha" }),
    ).toEqual({ ok: false, error: "boom" });
  });
});

describe("currentBranch / branchExists", () => {
  it("returns the checked-out branch", () => {
    const { git } = fakeGit({ config: { __head: "feat/b" } });
    expect(currentBranch("/repo", git)).toBe("feat/b");
  });

  it("returns undefined for a detached HEAD", () => {
    const { git } = fakeGit({ config: { __head: "HEAD" } });
    expect(currentBranch("/repo", git)).toBeUndefined();
  });

  it("detects an existing local branch", () => {
    const { git } = fakeGit({ refs: { "feat/a": "sha-a" } });
    expect(branchExists("/repo", "feat/a", git)).toBe(true);
    expect(branchExists("/repo", "feat/missing", git)).toBe(false);
  });
});

describe("resolveStackChain", () => {
  it("returns an empty chain for a branch with no stack config", () => {
    const { git } = fakeGit({ refs: { [DEFAULT_BASE_BRANCH]: "sha-main" } });

    expect(resolveStackChain("/repo", "feat/b", git)).toEqual({ ok: true, chain: [] });
  });

  it("walks a two-level stack root-first and resolves fork points", () => {
    const { git } = fakeGit({
      config: {
        "branch.feat/a.belaydBase": DEFAULT_BASE_BRANCH,
        "branch.feat/b.belaydBase": "feat/a",
      },
      refs: { [DEFAULT_BASE_BRANCH]: "sha-main", "feat/a": "sha-a", "feat/b": "sha-b" },
      mergeBase: { "main feat/a": "fork-a", "feat/a feat/b": "fork-b" },
    });

    const result = resolveStackChain("/repo", "feat/b", git);

    expect(result).toEqual({
      ok: true,
      chain: [
        { branch: "feat/a", base: DEFAULT_BASE_BRANCH, forkPoint: "fork-a" },
        { branch: "feat/b", base: "feat/a", forkPoint: "fork-b" },
      ],
    });
  });

  it("treats a deleted parent as landed and rebases onto main", () => {
    const { git } = fakeGit({
      config: {
        "branch.feat/c.belaydBase": "feat/b",
        "branch.feat/c.belaydForkPoint": "fork-c",
      },
      refs: { [DEFAULT_BASE_BRANCH]: "sha-main", "feat/c": "sha-c" },
    });

    const result = resolveStackChain("/repo", "feat/c", git);

    expect(result).toEqual({
      ok: true,
      chain: [
        {
          branch: "feat/c",
          base: DEFAULT_BASE_BRANCH,
          forkPoint: "fork-c",
          landedParent: "feat/b",
        },
      ],
    });
  });

  it("detects a config cycle", () => {
    const { git } = fakeGit({
      config: {
        "branch.feat/a.belaydBase": "feat/b",
        "branch.feat/b.belaydBase": "feat/a",
      },
      refs: { [DEFAULT_BASE_BRANCH]: "sha-main", "feat/a": "sha-a", "feat/b": "sha-b" },
    });

    const result = resolveStackChain("/repo", "feat/a", git);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cycle");
  });
});

describe("planStackRebase", () => {
  const node = (overrides: Partial<StackNode>): StackNode => ({
    branch: "feat/a",
    base: DEFAULT_BASE_BRANCH,
    forkPoint: "fork-a",
    ...overrides,
  });

  it("skips a level already based on its base tip", () => {
    const plan = planStackRebase([node({ forkPoint: "same" })], { main: "same" });

    expect(plan.steps).toEqual([]);
    expect(plan.skipped).toEqual([{ branch: "feat/a", reason: "already-based" }]);
  });

  it("skips a level without a fork point", () => {
    const plan = planStackRebase([node({ forkPoint: undefined })], { main: "tip" });

    expect(plan.steps).toEqual([]);
    expect(plan.skipped).toEqual([{ branch: "feat/a", reason: "missing-fork-point" }]);
  });

  it("emits a step onto the base tip", () => {
    const plan = planStackRebase([node({})], { main: "tip" });

    expect(plan.steps).toEqual([{ branch: "feat/a", onto: "tip", forkPoint: "fork-a" }]);
    expect(plan.skipped).toEqual([]);
  });
});

describe("runStackRebase", () => {
  const twoLevel = () =>
    fakeGit({
      config: {
        "branch.feat/a.belaydBase": DEFAULT_BASE_BRANCH,
        "branch.feat/b.belaydBase": "feat/a",
      },
      refs: { [DEFAULT_BASE_BRANCH]: "sha-main", "feat/a": "sha-a", "feat/b": "sha-b" },
      worktrees: [
        ["feat/a", "/wt/a"],
        ["feat/b", "/wt/b"],
      ],
      mergeBase: { "main feat/a": "fork-a", "feat/a feat/b": "fork-b" },
    });

  it("rebases each level stepwise and refreshes the fork point", () => {
    const { git, calls } = twoLevel();

    const result = runStackRebase(git, { cwd: "/repo", leaf: "feat/b" });

    expect(result).toEqual({ ok: true, rebased: ["feat/a", "feat/b"], skipped: [] });
    const rebases = calls.filter((call) => call.args[0] === "rebase");
    expect(rebases.map((call) => call.args)).toEqual([
      ["rebase", "--onto", "sha-main", "fork-a", "feat/a"],
      ["rebase", "--onto", "rebased-feat/a", "fork-b", "feat/b"],
    ]);
    // Each level's fork point is refreshed to its base tip after rebasing.
    const configWrites = calls.filter(
      (call) => call.args[0] === "config" && call.args[1]?.endsWith("belaydForkPoint"),
    );
    expect(configWrites.map((call) => call.args[2])).toEqual(["sha-main", "rebased-feat/a"]);
  });

  it("rebases a three-deep chain stepwise", () => {
    const { git, calls } = fakeGit({
      config: {
        "branch.feat/a.belaydBase": DEFAULT_BASE_BRANCH,
        "branch.feat/b.belaydBase": "feat/a",
        "branch.feat/c.belaydBase": "feat/b",
      },
      refs: {
        [DEFAULT_BASE_BRANCH]: "sha-main",
        "feat/a": "sha-a",
        "feat/b": "sha-b",
        "feat/c": "sha-c",
      },
      worktrees: [
        ["feat/a", "/wt/a"],
        ["feat/b", "/wt/b"],
        ["feat/c", "/wt/c"],
      ],
      mergeBase: {
        "main feat/a": "fork-a",
        "feat/a feat/b": "fork-b",
        "feat/b feat/c": "fork-c",
      },
    });

    const result = runStackRebase(git, { cwd: "/repo", leaf: "feat/c" });

    expect(result).toEqual({ ok: true, rebased: ["feat/a", "feat/b", "feat/c"], skipped: [] });
    const rebases = calls.filter((call) => call.args[0] === "rebase").map((call) => call.args);
    expect(rebases).toEqual([
      ["rebase", "--onto", "sha-main", "fork-a", "feat/a"],
      ["rebase", "--onto", "rebased-feat/a", "fork-b", "feat/b"],
      ["rebase", "--onto", "rebased-feat/b", "fork-c", "feat/c"],
    ]);
  });

  it("returns a conflicts error without touching later levels", () => {
    const { git } = fakeGit({
      config: {
        "branch.feat/a.belaydBase": DEFAULT_BASE_BRANCH,
        "branch.feat/b.belaydBase": "feat/a",
      },
      refs: { [DEFAULT_BASE_BRANCH]: "sha-main", "feat/a": "sha-a", "feat/b": "sha-b" },
      worktrees: [
        ["feat/a", "/wt/a"],
        ["feat/b", "/wt/b"],
      ],
      mergeBase: { "main feat/a": "fork-a", "feat/a feat/b": "fork-b" },
      failures: { "rebase --onto sha-main fork-a feat/a": new Error("conflict") },
    });

    const result = runStackRebase(git, { cwd: "/repo", leaf: "feat/b" });

    expect(result).toMatchObject({
      ok: false,
      branch: "feat/a",
      worktree: "/wt/a",
      conflicts: true,
    });
  });

  it("marks the pre-rebase stash as recoverable when a dirty rebase conflicts", () => {
    const { git } = fakeGit({
      config: {
        "branch.feat/a.belaydBase": DEFAULT_BASE_BRANCH,
      },
      refs: { [DEFAULT_BASE_BRANCH]: "sha-main", "feat/a": "sha-a" },
      worktrees: [["feat/a", "/wt/a"]],
      mergeBase: { "main feat/a": "fork-a" },
      dirty: ["/wt/a"],
      failures: { "rebase --onto sha-main fork-a feat/a": new Error("conflict") },
    });

    const result = runStackRebase(git, { cwd: "/repo", leaf: "feat/a", stash: true });

    expect(result).toMatchObject({
      ok: false,
      conflicts: true,
      stashed: true,
    });
    expect(result).not.toHaveProperty("stashPopConflicted");
  });

  it("flags a stash-pop conflict distinctly from an interrupted rebase", () => {
    const { git } = fakeGit({
      config: { "branch.feat/a.belaydBase": DEFAULT_BASE_BRANCH },
      refs: { [DEFAULT_BASE_BRANCH]: "sha-main", "feat/a": "sha-a" },
      worktrees: [["feat/a", "/wt/a"]],
      mergeBase: { "main feat/a": "fork-a" },
      dirty: ["/wt/a"],
      failures: { "stash pop": new Error("pop conflict") },
    });

    const result = runStackRebase(git, { cwd: "/repo", leaf: "feat/a", stash: true });

    expect(result).toMatchObject({
      ok: false,
      conflicts: true,
      stashed: true,
      stashPopConflicted: true,
    });
  });

  it("stashes and restores dirty worktrees around the rebase", () => {
    const { git, calls } = fakeGit({
      config: { "branch.feat/a.belaydBase": DEFAULT_BASE_BRANCH },
      refs: { [DEFAULT_BASE_BRANCH]: "sha-main", "feat/a": "sha-a" },
      worktrees: [["feat/a", "/wt/a"]],
      mergeBase: { "main feat/a": "fork-a" },
      dirty: ["/wt/a"],
    });

    runStackRebase(git, { cwd: "/repo", leaf: "feat/a", stash: true });

    const stashCalls = calls.filter((call) => call.args[0] === "stash").map((call) => call.args[1]);
    expect(stashCalls).toEqual(["push", "pop"]);
    const rebaseIndex = calls.findIndex((call) => call.args[0] === "rebase");
    const pushIndex = calls.findIndex(
      (call) => call.args[0] === "stash" && call.args[1] === "push",
    );
    const popIndex = calls.findIndex((call) => call.args[0] === "stash" && call.args[1] === "pop");
    expect(pushIndex).toBeLessThan(rebaseIndex);
    expect(popIndex).toBeGreaterThan(rebaseIndex);
  });

  it("forces the leaf onto main when the parent still exists but landed", () => {
    const { git, calls } = fakeGit({
      config: {
        "branch.feat/a.belaydBase": DEFAULT_BASE_BRANCH,
        "branch.feat/b.belaydBase": "feat/a",
        "branch.feat/b.belaydForkPoint": "fork-b",
      },
      refs: { [DEFAULT_BASE_BRANCH]: "sha-main", "feat/a": "sha-a", "feat/b": "sha-b" },
      worktrees: [
        ["feat/a", "/wt/a"],
        ["feat/b", "/wt/b"],
      ],
      mergeBase: { "main feat/a": "fork-a", "feat/a feat/b": "fork-b-merge" },
    });

    const result = runStackRebase(git, { cwd: "/repo", leaf: "feat/b", forceLanded: true });

    expect(result.ok).toBe(true);
    const rebases = calls.filter((call) => call.args[0] === "rebase");
    // The leaf is replayed onto main; the healthy parent level is a no-op.
    expect(rebases.some((call) => call.args.includes("feat/b"))).toBe(true);
    const leafRebase = rebases.find((call) => call.args[4] === "feat/b");
    expect(leafRebase?.args[2]).toBe("sha-main");
  });
});

describe("resolveAutoRebaseEnabled", () => {
  it("defaults to enabled", () => {
    const { git } = fakeGit();
    expect(resolveAutoRebaseEnabled("/repo", git, {})).toBe(true);
  });

  it("disables via env values", () => {
    const { git } = fakeGit();
    for (const value of ["0", "false", "no"]) {
      expect(resolveAutoRebaseEnabled("/repo", git, { [AUTO_REBASE_ENV_KEY]: value })).toBe(false);
    }
  });

  it("disables via git config values", () => {
    for (const value of ["false", "0", "no", "off"]) {
      const { git } = fakeGit({ config: { [AUTO_REBASE_CONFIG_KEY]: value } });
      expect(resolveAutoRebaseEnabled("/repo", git, {})).toBe(false);
    }
  });

  it("lets the env opt-in override a disabled config", () => {
    const { git } = fakeGit({ config: { [AUTO_REBASE_CONFIG_KEY]: "false" } });
    expect(resolveAutoRebaseEnabled("/repo", git, { [AUTO_REBASE_ENV_KEY]: "1" })).toBe(true);
  });
});
