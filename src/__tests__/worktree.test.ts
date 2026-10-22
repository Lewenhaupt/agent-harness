import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitWorktreeReady,
  gitContextFreeEnv,
  isInsideWorktreeForBranch,
  listWorktrees,
  parseWorktreeListPorcelain,
  parseWorktreeListPorcelainZ,
  resolveWorktreePath,
  setupWorktree,
} from "../worktree.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn(() => Promise.resolve()),
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
  // Stacking defaults to the caller's current branch. Inject a "main" current
  // branch so the non-stacked tests keep their exact `--base main` argv and do
  // not consume an extra execFileSync call for `rev-parse`.
  let deps: {
    currentBranch: () => string | undefined;
    captureStack: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    deps = { currentBranch: () => "main", captureStack: vi.fn() };
  });

  it("returns the worktree path immediately when already registered in git", () => {
    // The initial resolveWorktreePath check finds the worktree — no wt call needed.
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // resolveWorktreePath → found

    const result = setupWorktree("/repo", { branch: "feat/bd-42" }, deps);

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

    const result = setupWorktree("/repo", { branch: "feat/bd-42" }, deps);

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

    const result = setupWorktree("/repo", { branch: "feat/bd-42" }, deps);

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

    const result = setupWorktree("/repo", { branch: "feat/bd-42" }, deps);

    expect(result).toBe("/repo/feat");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "wt",
      ["switch", "feat/bd-42", "-y"],
      expect.objectContaining({ timeout: 30_000, stdio: "pipe" }),
    );
    // An existing branch already carries whatever stack metadata it had.
    expect(deps.captureStack).not.toHaveBeenCalled();
  });

  it("throws when the wt command fails", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync.mockReturnValueOnce(""); // git branch --list
    mockedExistsSync.mockReturnValueOnce(false); // directory does not exist
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error("wt not found");
    }); // wt switch fails

    expect(() => setupWorktree("/repo", { branch: "feat/bd-42" }, deps)).toThrow(
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

    expect(() => setupWorktree("/repo", { branch: "feat/bd-42" }, deps)).toThrow(
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

    const result = setupWorktree("/repo", { branch: "feat/bd-42", base: "develop" }, deps);

    expect(result).toBe("/repo/feat");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "wt",
      ["switch", "--create", "feat/bd-42", "--base", "develop", "-y"],
      expect.objectContaining({ timeout: 30_000, stdio: "pipe" }),
    );
  });

  it("defaults the base to the caller's current branch and captures stack metadata", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync
      .mockReturnValueOnce("") // git branch --list → empty
      .mockReturnValueOnce(""); // wt switch --create → success
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // final resolveWorktreePath → found
    mockedExistsSync.mockReturnValueOnce(false); // directory does not exist

    const result = setupWorktree(
      "/repo",
      { branch: "feat/bd-42" },
      {
        currentBranch: () => "feat/bd-41",
        captureStack: deps.captureStack,
      },
    );

    expect(result).toBe("/repo/feat");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "wt",
      ["switch", "--create", "feat/bd-42", "--base", "feat/bd-41", "-y"],
      expect.objectContaining({ timeout: 30_000, stdio: "pipe" }),
    );
    expect(deps.captureStack).toHaveBeenCalledWith({
      cwd: "/repo",
      branch: "feat/bd-42",
      base: "feat/bd-41",
    });
  });

  it("records stack metadata for a main-based branch too (bd-121)", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync.mockReturnValueOnce("").mockReturnValueOnce(""); // branch --list, wt switch
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // final resolveWorktreePath → found
    mockedExistsSync.mockReturnValueOnce(false); // directory does not exist

    setupWorktree("/repo", { branch: "feat/bd-42", base: "main" }, deps);

    // `/belayd` passes no explicit base, so the branch must carry
    // belaydBase=main + a fork point; otherwise resolveStackChain cannot tell
    // a genuinely main-based branch from a metadata-less stacked one.
    expect(deps.captureStack).toHaveBeenCalledWith({
      cwd: "/repo",
      branch: "feat/bd-42",
      base: "main",
    });
  });

  it("records belaydBase + fork point for a base-less branch with the real capture helper", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync.mockImplementation((file: string, args?: readonly string[]) => {
      if (file !== "git") return "";
      if (args?.[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args?.[0] === "rev-parse") return "fork-sha\n";
      return "";
    });
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // final resolveWorktreePath → found
    mockedExistsSync.mockReturnValueOnce(false); // directory does not exist

    // No explicit base and no deps: the default capture path resolves the
    // caller's branch (main) and records it, so resolveStackChain can report a
    // real chain instead of stopping at a metadata-less ancestor.
    setupWorktree("/repo", { branch: "feat/bd-42" });

    const gitCalls: string[][] = [];
    for (const [file, args] of mockedExecFileSync.mock.calls) {
      if (file === "git" && args !== undefined) gitCalls.push([...args]);
    }
    expect(gitCalls).toContainEqual(["config", "branch.feat/bd-42.belaydBase", "main"]);
    expect(gitCalls).toContainEqual(["config", "branch.feat/bd-42.belaydForkPoint", "fork-sha"]);
    expect(gitCalls).toContainEqual(["branch", "--set-upstream-to=main", "feat/bd-42"]);
  });

  it("does not fail when stack capture fails", () => {
    mockedExecSync.mockReturnValueOnce(PORCELAIN_WITHOUT_FEAT); // resolveWorktreePath → undefined
    mockedExecFileSync.mockReturnValueOnce("").mockReturnValueOnce(""); // branch --list, wt switch
    mockedExecSync.mockReturnValueOnce(PORCELAIN_SINGLE); // final resolveWorktreePath → found
    mockedExistsSync.mockReturnValueOnce(false); // directory does not exist
    const captureStack = vi.fn(() => {
      throw new Error("config failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = setupWorktree(
      "/repo",
      { branch: "feat/bd-42" },
      {
        currentBranch: () => "feat/bd-41",
        captureStack,
      },
    );

    expect(result).toBe("/repo/feat");
    expect(captureStack).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("awaitWorktreeReady", () => {
  it("resolves ok once .modules.yaml exists", async () => {
    mockedExistsSync.mockReturnValue(true);

    const result = await awaitWorktreeReady("/repo/feat", { timeoutInMs: 1000 });

    expect(result).toEqual({ ok: true });
    expect(mockedExistsSync).toHaveBeenCalledWith("/repo/feat/node_modules/.modules.yaml");
  });

  it("polls until .modules.yaml appears in a pnpm project", async () => {
    mockedExistsSync
      .mockReturnValueOnce(true) // pnpm-lock.yaml
      .mockReturnValueOnce(false) // .modules.yaml
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const result = await awaitWorktreeReady("/repo/feat", {
      timeoutInMs: 1000,
      pollIntervalInMs: 10,
    });

    expect(result).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails after the timeout elapses in a pnpm project", async () => {
    mockedExistsSync.mockReturnValueOnce(true); // pnpm-lock.yaml
    mockedExistsSync.mockReturnValue(false); // .modules.yaml never appears

    const result = await awaitWorktreeReady("/repo/feat", {
      timeoutInMs: 0,
      pollIntervalInMs: 10,
    });

    expect(result).toEqual({
      ok: false,
      error: "Worktree dependencies not ready within 0ms: /repo/feat",
    });
  });

  it("resolves immediately for a non-pnpm project without polling", async () => {
    mockedExistsSync.mockReturnValue(false);

    const result = await awaitWorktreeReady("/repo/feat", {
      timeoutInMs: 1000,
      pollIntervalInMs: 10,
    });

    expect(result).toEqual({ ok: true });
    expect(sleep).not.toHaveBeenCalled();
  });
});

/** Build `-z` output: NUL-terminated fields, empty field between records. */
function porcelainZ(records: Array<{ path: string; branch?: string }>): string {
  return records
    .map((record) => {
      const fields = [`worktree ${record.path}`, "HEAD 1111111"];
      if (record.branch !== undefined) fields.push(`branch refs/heads/${record.branch}`);
      return `${fields.join("\0")}\0\0`;
    })
    .join("");
}

describe("parseWorktreeListPorcelainZ", () => {
  it("parses NUL-separated records and marks the first as main", () => {
    const parsed = parseWorktreeListPorcelainZ(
      porcelainZ([
        { path: "/repo", branch: "main" },
        { path: "/repo.feat-bd-42", branch: "feat/bd-42" },
      ]),
    );

    expect(parsed.warnings).toEqual([]);
    expect(parsed.entries).toEqual([
      { path: "/repo", branch: "main", isMainWorktree: true },
      { path: "/repo.feat-bd-42", branch: "feat/bd-42", isMainWorktree: false },
    ]);
  });

  it("keeps a path containing a newline intact", () => {
    // git does not C-quote porcelain values, so only -z can carry this path.
    const parsed = parseWorktreeListPorcelainZ(
      porcelainZ([{ path: "/tmp/repo.feat-bd-42\nline2", branch: "feat/bd-42" }]),
    );

    expect(parsed.entries[0]).toHaveProperty("path", "/tmp/repo.feat-bd-42\nline2");
    expect(parsed.warnings).toEqual([]);
  });

  it("keeps a path containing a space, a quote, and a non-ASCII character", () => {
    const parsed = parseWorktreeListPorcelainZ(
      porcelainZ([{ path: '/tmp/repo.feat-bd-42"aä b', branch: "feat/bd-42" }]),
    );

    expect(parsed.entries[0]).toHaveProperty("path", '/tmp/repo.feat-bd-42"aä b');
  });

  it("keeps a detached record with no branch", () => {
    const parsed = parseWorktreeListPorcelainZ(porcelainZ([{ path: "/tmp/det" }]));

    expect(parsed.entries).toEqual([{ path: "/tmp/det", branch: undefined, isMainWorktree: true }]);
  });

  it("returns no entries for empty output", () => {
    expect(parseWorktreeListPorcelainZ("")).toEqual({ entries: [], warnings: [] });
  });

  it("stays total for adversarial streams and never truncates a path", () => {
    const cases: Array<{ name: string; output: string; expectedPaths: string[] }> = [
      {
        // git always NUL-terminates, so a missing terminator means the caller
        // captured a partial stream; the last record must still parse whole.
        name: "no trailing NUL",
        output: "worktree /repo\u0000HEAD 1111111\u0000branch refs/heads/main",
        expectedPaths: ["/repo"],
      },
      {
        name: "tripled NUL between records",
        output: "worktree /repo\u0000\u0000\u0000worktree /repo.feat\u0000\u0000",
        expectedPaths: ["/repo", "/repo.feat"],
      },
      {
        name: "bare repository record",
        output: "worktree /srv/repo.git\u0000bare\u0000\u0000",
        expectedPaths: ["/srv/repo.git"],
      },
      {
        name: "spaces inside the path are preserved verbatim",
        output: "worktree /repo.feat bd-42 \u0000HEAD 1111111\u0000\u0000",
        expectedPaths: ["/repo.feat bd-42 "],
      },
      { name: "only newlines", output: "\n\n", expectedPaths: [] },
      { name: "truncated key with no value", output: "worktree", expectedPaths: [] },
    ];

    for (const testCase of cases) {
      const parsed = parseWorktreeListPorcelainZ(testCase.output);
      expect(parsed.warnings, testCase.name).toEqual([]);
      expect(
        parsed.entries.map((entry) => entry.path),
        testCase.name,
      ).toEqual(testCase.expectedPaths);
    }
  });

  it("keeps an empty worktree value from swallowing the following record", () => {
    // git never emits an empty worktree value, but a malformed stream must not
    // merge it into the next path or drop the record that follows.
    const parsed = parseWorktreeListPorcelainZ(
      "worktree \u0000\u0000worktree /repo.feat\u0000branch refs/heads/feat/bd-42\u0000\u0000",
    );

    expect(parsed.entries.map((entry) => entry.path)).toEqual(["", "/repo.feat"]);
    expect(parsed.entries[1]).toHaveProperty("branch", "feat/bd-42");
  });
});

describe("parseWorktreeListPorcelain (line-oriented fallback)", () => {
  it("parses normal output with no warnings", () => {
    const parsed = parseWorktreeListPorcelain(PORCELAIN_MULTI);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.entries.map((entry) => entry.path)).toEqual([
      "/repo/main",
      "/repo/feat",
      "/repo/fix",
    ]);
  });

  it("skips a record whose path contains a newline instead of truncating it", () => {
    const porcelain = [
      "worktree /tmp/repo.feat-bd-42",
      "HEAD 1111111",
      "branch refs/heads/feat/bd-42",
      "",
      "worktree /tmp/repo.feat-bd-19",
      "line2",
      "HEAD 2222222",
      "branch refs/heads/feat/bd-19",
      "",
    ].join("\n");

    const parsed = parseWorktreeListPorcelain(porcelain);

    expect(parsed.entries.map((entry) => entry.path)).toEqual(["/tmp/repo.feat-bd-42"]);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("/tmp/repo.feat-bd-19");
    expect(parsed.warnings[0]).toContain("line2");
    expect(parsed.warnings[0]).toContain("-z");
  });

  it("accepts locked/prunable records without inventing a warning", () => {
    const porcelain = [
      "worktree /repo/main",
      "HEAD 1111111",
      "branch refs/heads/main",
      "locked reason with spaces",
      "",
      "worktree /repo/feat",
      "HEAD 2222222",
      "branch refs/heads/feat/bd-42",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const parsed = parseWorktreeListPorcelain(porcelain);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.entries.map((entry) => entry.path)).toEqual(["/repo/main", "/repo/feat"]);
  });

  it("stays total for an empty or newline-only stream", () => {
    expect(parseWorktreeListPorcelain("")).toEqual({ entries: [], warnings: [] });
    expect(parseWorktreeListPorcelain("\n\n\n")).toEqual({ entries: [], warnings: [] });
  });
});

describe("listWorktrees", () => {
  it("pins the -z argv, timeout, and git-context-free env", () => {
    mockedExecFileSync.mockReturnValueOnce(
      porcelainZ([
        { path: "/repo", branch: "main" },
        { path: "/repo/feat", branch: "feat/bd-42" },
        { path: "/repo/fix", branch: "fix/bd-18" },
      ]),
    );

    const result = listWorktrees("/repo");

    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("warnings", []);
    const call = mockedExecFileSync.mock.calls[0];
    expect(call?.[0]).toBe("git");
    expect(call?.[1]).toEqual(["worktree", "list", "--porcelain", "-z"]);
    const options = call?.[2] as
      | {
          cwd?: string;
          env?: NodeJS.ProcessEnv;
          timeout?: number;
          encoding?: string;
          stdio?: string;
        }
      | undefined;
    expect(options?.cwd).toBe("/repo");
    expect(options?.timeout).toBe(10_000);
    expect(options?.encoding).toBe("utf8");
    expect(options?.stdio).toBe("pipe");
    expect(options?.env).toEqual(gitContextFreeEnv());
    expect(options?.env).not.toHaveProperty("GIT_DIR");
    expect(options?.env).not.toHaveProperty("GIT_WORK_TREE");
  });

  it("strips an inherited GIT_DIR from the probe environment", () => {
    const originalGitDir = process.env.GIT_DIR;
    const originalWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = "/poison/.git";
    process.env.GIT_WORK_TREE = "/poison";
    mockedExecFileSync.mockReturnValueOnce(porcelainZ([{ path: "/repo/main", branch: "main" }]));

    try {
      listWorktrees("/repo");
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;
      if (originalWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = originalWorkTree;
    }

    const call = mockedExecFileSync.mock.calls[0];
    const options = call?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(options?.env).not.toHaveProperty("GIT_DIR");
    expect(options?.env).not.toHaveProperty("GIT_WORK_TREE");
  });

  it("falls back to line-oriented porcelain when -z is unsupported", () => {
    mockedExecFileSync
      .mockImplementationOnce(() => {
        throw new Error("error: unknown switch 'z'");
      })
      .mockReturnValueOnce(PORCELAIN_SINGLE);

    const result = listWorktrees("/repo");

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    expect(mockedExecFileSync.mock.calls[1]?.[1]).toEqual(["worktree", "list", "--porcelain"]);
  });

  it("surfaces a fallback truncation warning through the seam", () => {
    const result = listWorktrees("/repo", {
      execNul: () => {
        throw new Error("error: unknown switch 'z'");
      },
      execLines: () => "worktree /tmp/repo.feat-bd-19\nline2\nbranch refs/heads/feat/bd-19\n",
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.entries).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("line2");
  });

  it("converts a thrown git failure into an error value", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("Command failed: git worktree list");
    });

    const result = listWorktrees("/repo");

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("git worktree list failed in /repo");
    expect(result.error).toContain("Command failed");
  });
});
