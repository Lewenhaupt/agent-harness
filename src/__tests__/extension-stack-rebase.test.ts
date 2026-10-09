/**
 * Tool-level tests for `belayd_stack_rebase`: it resolves the recorded stack
 * chain and replays each level with `git rebase --onto`, covering the no-stack,
 * landed-parent, multi-level, conflict/stash, and detached-HEAD paths.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

// ── Mutable git fixture ────────────────────────────────────────────────
//
// The tool shells out through `defaultGitExec` (execFileSync), so tests drive a
// small in-memory git: recorded config, branch refs, worktree list, and an
// injectable rebase/stash-pop failure. Refs are intentionally simple strings.
const gitState = vi.hoisted(() => ({
  head: "feat/child" as string | undefined,
  bases: {} as Record<string, string>,
  forkPoints: {} as Record<string, string>,
  branches: {} as Record<string, string>,
  mergeBases: {} as Record<string, string>,
  tips: {} as Record<string, string>,
  worktrees: [] as Array<{ branch: string; path: string }>,
  dirty: new Set<string>(),
  rebaseError: undefined as Error | undefined,
  stashPopError: undefined as Error | undefined,
}));

/** Extract the branch name from a `branch.<name>.belayd*` config key. */
function stackBranchFromKey(key: string): string {
  return key.slice("branch.".length, key.lastIndexOf("."));
}

function respondConfig(args: readonly string[]): string {
  const isGet = args[1] === "--get";
  const key = isGet ? (args[2] ?? "") : (args[1] ?? "");
  if (isGet) {
    const store = key.endsWith(".belaydForkPoint") ? gitState.forkPoints : gitState.bases;
    const value = store[stackBranchFromKey(key)];
    if (value === undefined) throw new Error(`no such key: ${key}`);
    return `${value}\n`;
  }
  if (key.endsWith(".belaydForkPoint")) {
    gitState.forkPoints[stackBranchFromKey(key)] = args[2] ?? "";
  }
  return "";
}

function respondRevParse(args: readonly string[]): string {
  if (args[1] === "--abbrev-ref") {
    if (gitState.head === undefined) throw new Error("detached HEAD");
    return `${gitState.head}\n`;
  }
  if (args[1] === "--verify") {
    const name = (args[3] ?? "").replace("refs/heads/", "");
    const sha = gitState.branches[name];
    if (sha === undefined) throw new Error(`unknown branch: ${name}`);
    return `${sha}\n`;
  }
  const name = (args[1] ?? "").replace(/\^\{commit\}$/, "");
  const sha = gitState.tips[name];
  if (sha === undefined) throw new Error(`unknown ref: ${name}`);
  return `${sha}\n`;
}

function respondMergeBase(args: readonly string[]): string {
  const sha = gitState.mergeBases[`${args[2] ?? ""} ${args[3] ?? ""}`];
  if (sha === undefined) throw new Error("no merge base");
  return `${sha}\n`;
}

function respondWorktree(): string {
  const lines: string[] = [];
  for (const entry of gitState.worktrees) {
    lines.push(`worktree ${entry.path}`, "HEAD 0", `branch refs/heads/${entry.branch}`, "");
  }
  return lines.join("\n");
}

function respondStash(args: readonly string[], cwd: string | undefined): string {
  if (args[1] === "push") {
    if (cwd !== undefined) gitState.dirty.delete(cwd);
    return "";
  }
  if (args[1] === "pop" && gitState.stashPopError !== undefined) throw gitState.stashPopError;
  return "";
}

function respondGit(file: string, args: readonly string[], cwd: string | undefined): string {
  if (file !== "git") return "";
  switch (args[0]) {
    case "rev-parse":
      return respondRevParse(args);
    case "config":
      return respondConfig(args);
    case "merge-base":
      return respondMergeBase(args);
    case "worktree":
      return respondWorktree();
    case "status":
      return cwd !== undefined && gitState.dirty.has(cwd) ? " M changed.ts\n" : "";
    case "rebase":
      if (gitState.rebaseError !== undefined) throw gitState.rebaseError;
      return "";
    case "stash":
      return respondStash(args, cwd);
    default:
      throw new Error(`unexpected git call: ${args.join(" ")}`);
  }
}

type Responder = (file: string, args: readonly string[], cwd: string | undefined) => string;

const mockSync = vi.hoisted(() => {
  const calls: Array<{ file: string; args: string[]; cwd: string | undefined }> = [];
  const defaultResponder: Responder = (file, args) => {
    if (file === "git" && args[0] === "rev-parse") return "sha\n";
    return "";
  };
  let responder: Responder = defaultResponder;
  const fn = vi.fn((file: string, args: readonly string[], options?: { cwd?: string }) => {
    calls.push({ file, args: [...args], cwd: options?.cwd });
    return responder(file, args, options?.cwd);
  });
  return {
    fn,
    calls,
    setResponder: (next: Responder) => {
      responder = next;
    },
    reset: () => {
      calls.length = 0;
      responder = defaultResponder;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: vi.fn(),
    execFile: vi.fn(),
    execSync: vi.fn(() => ""),
    execFileSync: mockSync.fn,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

// ── Helpers ────────────────────────────────────────────────────────────

interface ToolResult {
  content: Array<{ text: string }>;
  details: { exitCode: number };
}

interface ToolLike {
  name: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

function createMockPi(): { api: ExtensionAPI; tools: Map<string, ToolLike> } {
  const tools = new Map<string, ToolLike>();
  const api = {
    registerTool: (def: ToolLike) => {
      tools.set(def.name, def);
    },
    registerCommand: () => {},
    on: () => {},
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, tools };
}

async function loadTools(): Promise<Map<string, ToolLike>> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const { api, tools } = createMockPi();
  register(api);
  return tools;
}

function createMockCtx(cwd: string) {
  return { cwd, ui: { notify: vi.fn() } };
}

function resetGitState(): void {
  gitState.head = "feat/child";
  gitState.bases = {};
  gitState.forkPoints = {};
  gitState.branches = { main: "sha-main" };
  gitState.mergeBases = {};
  gitState.tips = { main: "sha-main" };
  gitState.worktrees = [];
  gitState.dirty = new Set();
  gitState.rebaseError = undefined;
  gitState.stashPopError = undefined;
}

async function runStackRebaseTool(cwd: string): Promise<ToolResult | undefined> {
  const tools = await loadTools();
  const tool = tools.get("belayd_stack_rebase");
  expect(tool).toBeDefined();
  return tool?.execute("call-stack-rebase", {}, undefined, undefined, createMockCtx(cwd));
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("belayd_stack_rebase", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-stack-rebase-"));
    resetGitState();
    mockSync.reset();
    mockSync.setResponder(respondGit);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reports already based on main when the branch carries no stack metadata", async () => {
    const result = await runStackRebaseTool(cwd);

    expect(result?.details.exitCode).toBe(0);
    expect(result?.content[0]?.text).toContain("already based on main");
    expect(mockSync.calls.some((call) => call.args[0] === "rebase")).toBe(false);
  });

  it("replays a branch whose landed parent was deleted onto main with --onto", async () => {
    gitState.bases = { "feat/child": "feat/parent" };
    gitState.forkPoints = { "feat/child": "fork-child" };
    // feat/parent is absent from `branches`, simulating wt merge deleting it.
    gitState.branches = { main: "sha-main", "feat/child": "sha-child" };
    gitState.worktrees = [{ branch: "feat/child", path: "/wt/child" }];

    const result = await runStackRebaseTool(cwd);

    expect(result?.details.exitCode).toBe(0);
    expect(result?.content[0]?.text).toContain("Rebased 1 branch(es)");
    expect(result?.content[0]?.text).toContain("feat/child");
    const rebaseCall = mockSync.calls.find((call) => call.args[0] === "rebase");
    expect(rebaseCall?.args).toEqual(["rebase", "--onto", "sha-main", "fork-child", "feat/child"]);
  });

  it("rebases a multi-level stack stepwise from root to leaf", async () => {
    gitState.head = "feat/b";
    gitState.bases = { "feat/b": "feat/a", "feat/a": "main" };
    gitState.forkPoints = { "feat/b": "fork-b", "feat/a": "fork-a" };
    gitState.branches = { main: "sha-main", "feat/a": "sha-a", "feat/b": "sha-b" };
    gitState.mergeBases = { "feat/a feat/b": "fork-b", "main feat/a": "fork-a" };
    gitState.tips = { main: "sha-main", "feat/a": "sha-a" };
    gitState.worktrees = [
      { branch: "feat/a", path: "/wt/a" },
      { branch: "feat/b", path: "/wt/b" },
    ];

    const result = await runStackRebaseTool(cwd);

    expect(result?.details.exitCode).toBe(0);
    expect(result?.content[0]?.text).toContain("Rebased 2 branch(es)");
    const rebases = mockSync.calls
      .filter((call) => call.args[0] === "rebase")
      .map((call) => call.args);
    expect(rebases).toEqual([
      ["rebase", "--onto", "sha-main", "fork-a", "feat/a"],
      ["rebase", "--onto", "sha-a", "fork-b", "feat/b"],
    ]);

    // The success summary lists the stack root-first, not in rebase-call order
    // by accident.
    const text = result?.content[0]?.text ?? "";
    expect(text.indexOf("feat/a")).toBeLessThan(text.indexOf("feat/b"));
  });

  it("reports the branch, worktree, rebase steps, and stash recovery on conflict", async () => {
    gitState.bases = { "feat/child": "feat/parent" };
    gitState.forkPoints = { "feat/child": "fork-child" };
    gitState.branches = { main: "sha-main", "feat/child": "sha-child" };
    gitState.worktrees = [{ branch: "feat/child", path: "/wt/child" }];
    gitState.dirty.add("/wt/child");
    gitState.rebaseError = new Error("CONFLICT");

    const result = await runStackRebaseTool(cwd);

    expect(result?.details.exitCode).toBe(1);
    const text = result?.content[0]?.text ?? "";
    expect(text).toContain("feat/child");
    expect(text).toContain("/wt/child");
    expect(text).toContain("git rebase --continue");
    expect(text).toContain("belayd_stack_rebase");
    // The dirty tree was stashed before rebasing, so recovery must mention it.
    expect(text).toContain("git stash pop");
  });

  it("errors clearly on detached HEAD and runs no rebase", async () => {
    gitState.head = undefined;

    const result = await runStackRebaseTool(cwd);

    expect(result?.details.exitCode).toBe(1);
    expect(result?.content[0]?.text).toContain("detached HEAD");
    expect(mockSync.calls.some((call) => call.args[0] === "rebase")).toBe(false);
  });
});
