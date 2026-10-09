/**
 * Tests for the `belayd_start_followup` tool: it cuts a follow-up worktree from
 * the orchestrator's current branch, records the stack metadata, and tells the
 * delegated session what it is stacked on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

// ── Mocks ──────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  worktreeDir: "",
  worktreeCreated: false,
  head: "feat/bd-102" as string | undefined,
  // Recorded stack metadata the tool reads back through `git config`.
  stack: {
    bases: {} as Record<string, string>,
    forkPoints: {} as Record<string, string>,
    branches: {} as Record<string, string>,
    mergeBases: {} as Record<string, string>,
  },
}));

const execFileSyncCalls = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);

/** Extract the branch name from a `branch.<name>.belayd*` config key. */
function followupStackOwner(key: string): string {
  return key.slice("branch.".length, key.lastIndexOf("."));
}

function respondFollowupConfigGet(key: string): string {
  const owner = followupStackOwner(key);
  const value = key.endsWith(".belaydForkPoint")
    ? state.stack.forkPoints[owner]
    : state.stack.bases[owner];
  if (value === undefined) throw new Error(`no such key: ${key}`);
  return `${value}\n`;
}

function respondFollowupConfigSet(key: string, value: string): void {
  const owner = followupStackOwner(key);
  if (key.endsWith(".belaydForkPoint")) {
    state.stack.forkPoints[owner] = value;
  } else if (key.endsWith(".belaydBase")) {
    state.stack.bases[owner] = value;
  }
}

function respondFollowupConfig(args: readonly string[]): string {
  if (args[1] === "--get") return respondFollowupConfigGet(args[2] ?? "");
  respondFollowupConfigSet(args[1] ?? "", args[2] ?? "");
  return "";
}

function respondFollowupRevParse(args: readonly string[]): string {
  if (args[1] === "--abbrev-ref") return `${state.head ?? "HEAD"}\n`;
  if (args[1] === "--verify") {
    const name = (args[3] ?? "").replace("refs/heads/", "");
    const sha = state.stack.branches[name];
    if (sha === undefined) throw new Error(`unknown branch: ${name}`);
    return `${sha}\n`;
  }
  return "sha-base\n";
}

function respondFollowupGit(args: readonly string[]): string {
  switch (args[0]) {
    case "rev-parse":
      return respondFollowupRevParse(args);
    case "config":
      return respondFollowupConfig(args);
    case "merge-base": {
      const sha = state.stack.mergeBases[`${args[2] ?? ""} ${args[3] ?? ""}`];
      if (sha === undefined) throw new Error("no merge base");
      return `${sha}\n`;
    }
    default:
      return "";
  }
}

const mockExecFileSync = vi.hoisted(() =>
  vi.fn((file: string, args: readonly string[]) => {
    execFileSyncCalls.push({ file, args: [...args] });
    if (file === "wt") {
      state.worktreeCreated = true;
      return "";
    }
    if (file === "git") return respondFollowupGit(args);
    return "";
  }),
);

const mockExecSync = vi.hoisted(() =>
  vi.fn((cmd: string) => {
    if (cmd.startsWith("git rev-parse --abbrev-ref HEAD")) return `${state.head}\n`;
    if (cmd === "git worktree list --porcelain") {
      const lines = ["worktree /repo/main", "branch refs/heads/main", ""];
      if (state.worktreeCreated && state.worktreeDir !== "") {
        lines.push(`worktree ${state.worktreeDir}`, "branch refs/heads/feat/bd-103", "");
      }
      return lines.join("\n");
    }
    throw new Error(`mock execSync: ${cmd}`);
  }),
);

// `bd show` lookups fail (no bd CLI in tests) → workflow falls back to "feature".
const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const stdin = { on: () => {}, end: () => cb(new Error("bd not available"), "", "") };
      return { stdin };
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: vi.fn(),
    execFile: mockExecFile,
    execSync: mockExecSync,
    execFileSync: mockExecFileSync,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

const httpCalls = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  return {
    calls,
    clear: () => {
      calls.length = 0;
    },
  };
});

const mockHttpRequest = vi.hoisted(() =>
  vi.fn(
    (
      opts: { method?: string; path?: string },
      callback: (res: {
        statusCode: number;
        on: (event: string, handler: (chunk: string) => void) => void;
      }) => void,
    ) => {
      let data = "{}";
      if (opts.method === "POST" && opts.path === "/sessions") {
        data = JSON.stringify({ id: "sess-999" });
      }
      callback({
        statusCode: 200,
        on: vi.fn((event: string, handler: (chunk: string) => void) => {
          if (event === "data") handler(data);
          if (event === "end") handler("");
        }),
      });
      return {
        on: vi.fn(),
        write: vi.fn((body: string) => {
          httpCalls.calls.push({ method: opts.method ?? "", path: opts.path ?? "", body });
        }),
        end: vi.fn(),
      };
    },
  ),
);

vi.mock("node:http", () => ({ request: mockHttpRequest }));

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
  return {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => "followup-session" },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("belayd_start_followup", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-followup-"));
    state.worktreeDir = `${cwd}.feat-bd-103`;
    state.worktreeCreated = false;
    state.head = "feat/bd-102";
    state.stack = { bases: {}, forkPoints: {}, branches: {}, mergeBases: {} };
    execFileSyncCalls.length = 0;
    httpCalls.clear();
    mockExecFile.mockClear();
    mockExecSync.mockClear();
    mockExecFileSync.mockClear();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(state.worktreeDir, { recursive: true, force: true });
  });

  it("stacks the new worktree on the current branch and records the base", async () => {
    const tools = await loadTools();
    const tool = tools.get("belayd_start_followup");
    expect(tool).toBeDefined();

    const result = await tool?.execute(
      "call-followup",
      { taskId: "bd-103" },
      undefined,
      undefined,
      createMockCtx(cwd),
    );

    expect(result?.details.exitCode).toBe(0);
    expect(result?.content[0]?.text).toContain("stacked on feat/bd-102");

    const wtCall = execFileSyncCalls.find((call) => call.file === "wt");
    expect(wtCall?.args).toEqual([
      "switch",
      "--create",
      "feat/bd-103",
      "--base",
      "feat/bd-102",
      "-y",
    ]);

    // Stack metadata is written to the new branch's config.
    const configCalls = execFileSyncCalls.filter(
      (call) => call.file === "git" && call.args[0] === "config",
    );
    expect(configCalls.map((call) => call.args)).toContainEqual([
      "config",
      "branch.feat/bd-103.belaydBase",
      "feat/bd-102",
    ]);
    expect(configCalls.map((call) => call.args)).toContainEqual([
      "config",
      "branch.feat/bd-103.belaydForkPoint",
      "sha-base",
    ]);
    const upstreamCall = execFileSyncCalls.find(
      (call) =>
        call.file === "git" &&
        call.args[0] === "branch" &&
        call.args[1]?.startsWith("--set-upstream-to"),
    );
    expect(upstreamCall?.args).toEqual(["branch", "--set-upstream-to=feat/bd-102", "feat/bd-103"]);
  });

  it("tells the delegated session that the workflow is stacked", async () => {
    const tools = await loadTools();
    const tool = tools.get("belayd_start_followup");

    await tool?.execute(
      "call-followup",
      { taskId: "bd-103" },
      undefined,
      undefined,
      createMockCtx(cwd),
    );

    const promptCall = httpCalls.calls.find((call) => call.path === "/sessions/sess-999/prompt");
    expect(promptCall).toBeDefined();
    const body = JSON.parse(promptCall?.body ?? "{}") as { cwd?: string; text?: string };
    expect(body.cwd).toBe(state.worktreeDir);
    expect(body.text).toContain("Stacked on `feat/bd-102`");
  });

  it("rejects an invalid task id before touching git", async () => {
    const tools = await loadTools();
    const tool = tools.get("belayd_start_followup");

    const result = await tool?.execute(
      "call-followup",
      { taskId: "--status=closed" },
      undefined,
      undefined,
      createMockCtx(cwd),
    );

    expect(result?.details.exitCode).toBe(1);
    expect(result?.content[0]?.text).toContain("Invalid task id");
    expect(execFileSyncCalls).toEqual([]);
  });

  it("renders the full resolved stack in the follow-up summary", async () => {
    // A pre-existing parent branch (feat/bd-102) so the new branch forms a
    // two-level stack: feat/bd-102 → feat/bd-103 → main.
    state.stack = {
      bases: { "feat/bd-102": "main" },
      forkPoints: { "feat/bd-102": "fork-102" },
      branches: { main: "sha-main", "feat/bd-102": "sha-102" },
      mergeBases: { "main feat/bd-102": "fork-102" },
    };

    const tools = await loadTools();
    const tool = tools.get("belayd_start_followup");
    const result = await tool?.execute(
      "call-followup",
      { taskId: "bd-103" },
      undefined,
      undefined,
      createMockCtx(cwd),
    );

    expect(result?.details.exitCode).toBe(0);
    expect(result?.content[0]?.text).toContain("Stack: feat/bd-102 → feat/bd-103 → main");
  });

  it("errors on a detached HEAD without creating a worktree or session", async () => {
    state.head = undefined;

    const tools = await loadTools();
    const tool = tools.get("belayd_start_followup");
    const result = await tool?.execute(
      "call-followup",
      { taskId: "bd-103" },
      undefined,
      undefined,
      createMockCtx(cwd),
    );

    expect(result?.details.exitCode).toBe(1);
    expect(result?.content[0]?.text).toContain("detached HEAD");
    expect(execFileSyncCalls.some((call) => call.file === "wt")).toBe(false);
    expect(httpCalls.calls.some((call) => call.path === "/sessions")).toBe(false);
  });
});
