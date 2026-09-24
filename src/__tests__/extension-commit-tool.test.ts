/**
 * Tests for the `belayd_commit` path (bd-70).
 *
 * Regression coverage for shell injection: the commit path used to build
 * command strings through `exec` (shell=true), so backticks and `$()` in a
 * commit body were executed. It now spawns git/bd via `execFile` with an
 * explicit argv array, and the message reaches git through a `-F` temp file.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

// The phase-run machinery spawns sub-agents; the userguide-note test only needs
// a deterministic result so `appendTaskNotes` has content to append.
const mockSpawnAgentProcess = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    content: [{ type: "text" as const, text: "## How to Verify\n1. Run tests\n" }],
    details: {
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      exitCode: 0,
    },
    sessionName: "mocked",
  }),
);

vi.mock("../spawn.js", () => ({
  spawnAgentProcess: mockSpawnAgentProcess,
}));

// Any quality gate that shells out must not run real pnpm in the test env.
const mockExec = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(new Error("pnpm not found in test environment"), "", "Command failed");
    },
  ),
);

interface ExecFileRecord {
  file: string;
  args: readonly string[];
  stdin: string;
  cwd: string | undefined;
}

interface ExecFileResponse {
  stdout: string;
  stderr: string;
  error?: Error;
}

const mockExecFile = vi.hoisted(() => {
  const calls: ExecFileRecord[] = [];
  let responder = (record: ExecFileRecord): ExecFileResponse => {
    if (record.file === "git" && record.args[0] === "rev-parse") {
      return { stdout: "abc1234\n", stderr: "" };
    }
    return { stdout: "[feat/x abc1234] commit done", stderr: "" };
  };

  const fn = vi.fn(
    (
      file: string,
      args: readonly string[],
      options: { cwd?: string },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const record: ExecFileRecord = { file, args, stdin: "", cwd: options?.cwd };
      calls.push(record);
      const childStdin = {
        on: () => {},
        end: (chunk?: string) => {
          record.stdin = chunk ?? "";
          const response = responder(record);
          if (response.error) {
            callback(response.error, response.stdout, response.stderr);
            return;
          }
          callback(null, response.stdout, response.stderr);
        },
      };
      return { stdin: childStdin };
    },
  );

  return {
    fn,
    calls,
    clear: () => {
      calls.length = 0;
    },
    setResponder: (next: (record: ExecFileRecord) => ExecFileResponse) => {
      responder = next;
    },
    reset: () => {
      calls.length = 0;
      responder = (record) => {
        if (record.file === "git" && record.args[0] === "rev-parse") {
          return { stdout: "abc1234\n", stderr: "" };
        }
        return { stdout: "[feat/x abc1234] commit done", stderr: "" };
      };
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: mockExec, execFile: mockExecFile.fn };
});

interface CommitResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number; stderr?: string };
}

interface ToolLike {
  name: string;
  execute: (...args: unknown[]) => Promise<CommitResult>;
}

interface MockMessage {
  customType: string;
  content: string;
}

function createMockPi(): {
  api: ExtensionAPI;
  tools: Map<string, ToolLike>;
  messages: MockMessage[];
} {
  const tools = new Map<string, ToolLike>();
  const messages: MockMessage[] = [];
  const api = {
    registerTool: (def: ToolLike) => {
      tools.set(def.name, def);
    },
    registerCommand: () => {},
    on: () => {},
    sendMessage: (msg: MockMessage) => {
      messages.push(msg);
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, tools, messages };
}

function createMockCtx(cwd: string): {
  sessionManager: { getSessionId: () => string };
  cwd: string;
} {
  return { sessionManager: { getSessionId: () => "commit-test-session" }, cwd };
}

async function loadTools(): Promise<{
  tools: Map<string, ToolLike>;
  messages: MockMessage[];
}> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const { api, tools, messages } = createMockPi();
  register(api);
  return { tools, messages };
}

function argAt(args: readonly string[], index: number): string {
  return args[index] ?? "";
}

/** All recorded calls to a given executable. */
function callsFor(file: string): ExecFileRecord[] {
  return mockExecFile.calls.filter((call) => call.file === file);
}

describe("belayd_commit shell safety (bd-70)", () => {
  let cwd: string;
  let tools: Map<string, ToolLike>;
  let messages: MockMessage[];

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-commit-tool-"));
    mockExecFile.reset();
    mockExec.mockClear();
    mockSpawnAgentProcess.mockClear();
    const loaded = await loadTools();
    tools = loaded.tools;
    messages = loaded.messages;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  async function commit(params: Record<string, unknown>): Promise<CommitResult> {
    const tool = tools.get("belayd_commit");
    if (tool === undefined) throw new Error("belayd_commit was not registered");
    return tool.execute("call-commit", params, undefined, undefined, createMockCtx(cwd));
  }

  it("writes a hostile body verbatim to the -F temp file", async () => {
    const message = "feat: add feature";
    const body = [
      'Body with `playwright-cli` and $(id) and "double quotes"',
      "# a line starting with a hash must survive",
    ].join("\n");

    let messageFileContent = "";
    mockExecFile.setResponder((record) => {
      if (record.file === "git" && record.args[0] === "commit") {
        messageFileContent = readFileSync(argAt(record.args, 2), "utf8");
      }
      if (record.file === "git" && record.args[0] === "rev-parse") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      return { stdout: "[feat/x abc1234] done", stderr: "" };
    });

    await commit({ message, body });

    const commitCall = callsFor("git").find((call) => call.args[0] === "commit");
    expect(commitCall).toBeDefined();
    expect(argAt(commitCall?.args ?? [], 1)).toBe("-F");
    expect(commitCall?.args).not.toContain("-m");
    expect(messageFileContent).toBe(`${message}\n\n${body}`);
  });

  it("removes the temp message file once the commit completes", async () => {
    await commit({ message: "feat: cleanup", body: "body" });

    const commitCall = callsFor("git").find((call) => call.args[0] === "commit");
    expect(commitCall).toBeDefined();
    const messageFile = argAt(commitCall?.args ?? [], 2);
    expect(messageFile).not.toBe("");
    expect(existsSync(messageFile)).toBe(false);
  });

  it("stages hostile paths as literal argv with no quoting", async () => {
    const files = ["src/a b.ts", "rm -rf /", "$(id)", "-dash.ts"];
    await commit({ message: "feat: stage", files });

    const addCall = callsFor("git").find((call) => call.args[0] === "add");
    expect(addCall?.args).toEqual(["add", "--", ...files]);
  });

  it("reports the hash from rev-parse --short HEAD", async () => {
    const result = await commit({ message: "feat: hash" });
    expect(result.content[0]?.text).toBe("Committed as abc1234");
  });

  it("falls back to parsing the commit output when rev-parse fails", async () => {
    mockExecFile.setResponder((record) => {
      if (record.file === "git" && record.args[0] === "rev-parse") {
        return { stdout: "", stderr: "", error: new Error("rev-parse failed") };
      }
      return { stdout: "[feat/x abc1234] committed", stderr: "" };
    });

    const result = await commit({ message: "feat: fallback" });
    expect(result.content[0]?.text).toBe("Committed as abc1234");
  });

  it("reports unknown when neither hash source yields one", async () => {
    mockExecFile.setResponder((record) => {
      if (record.file === "git" && record.args[0] === "rev-parse") {
        return { stdout: "", stderr: "", error: new Error("rev-parse failed") };
      }
      return { stdout: "no hash here", stderr: "" };
    });

    const result = await commit({ message: "feat: unknown" });
    expect(result.content[0]?.text).toBe("Committed as unknown");
  });

  it("flags the bead for human review with exact argv", async () => {
    await commit({ message: "feat: review", taskId: "bd-42" });

    const updateCall = callsFor("bd").find((call) => call.args[0] === "update");
    // Flags precede `--` so the taskId is a literal positional.
    expect(updateCall?.args).toEqual([
      "update",
      "--status",
      "in_progress",
      "--add-label",
      "human",
      "--",
      "bd-42",
    ]);
  });

  it("rejects a taskId beginning with '-' before reaching bd", async () => {
    const result = await commit({ message: "feat: guard", taskId: "--status=closed" });

    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toContain("Invalid task id: --status=closed");
    expect(callsFor("bd")).toEqual([]);
  });

  it("appends the userguide via bd note --stdin", async () => {
    // Must satisfy the userguide quality gate, otherwise the gate appends
    // failure text and the ledger content no longer matches the spawn result.
    const userGuide = [
      "## How to Verify",
      "1. Run tests",
      "",
      "## How to Use",
      "Call the function",
      "x".repeat(200),
    ].join("\n");
    mockSpawnAgentProcess.mockResolvedValue({
      content: [{ type: "text" as const, text: userGuide }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: "mocked-userguide",
    });

    const startTask = tools.get("belayd_start_task");
    expect(startTask).toBeDefined();
    await startTask?.execute(
      "start",
      { taskId: "bd-42", workflowType: "feature" },
      undefined,
      undefined,
      createMockCtx(cwd),
    );

    const userguide = tools.get("belayd_userguide");
    expect(userguide).toBeDefined();
    await userguide?.execute(
      "userguide",
      { task: "write the guide" },
      undefined,
      undefined,
      createMockCtx(cwd),
    );
    await vi.waitFor(() => {
      expect(messages.some((msg) => msg.customType === "belayd-run-complete")).toBe(true);
    });

    mockExecFile.clear();
    await commit({ message: "feat: note", taskId: "bd-42" });

    const noteCall = callsFor("bd").find((call) => call.args[0] === "note");
    expect(noteCall?.args).toEqual(["note", "--stdin", "--", "bd-42"]);
    // The quality gate may append a summary; the body must still travel on stdin.
    expect(noteCall?.stdin).toContain(userGuide);
  });

  it("preserves CRLF line endings verbatim on bd note --stdin", async () => {
    const userGuideWithCrlf = [
      "## How to Verify",
      "1. Run tests",
      "",
      "## How to Use",
      "Call the function",
      "x".repeat(200),
    ].join("\r\n");
    mockSpawnAgentProcess.mockResolvedValue({
      content: [{ type: "text" as const, text: userGuideWithCrlf }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: "mocked-userguide-crlf",
    });

    const startTask = tools.get("belayd_start_task");
    expect(startTask).toBeDefined();
    await startTask?.execute(
      "start",
      { taskId: "bd-42", workflowType: "feature" },
      undefined,
      undefined,
      createMockCtx(cwd),
    );

    const userguide = tools.get("belayd_userguide");
    expect(userguide).toBeDefined();
    await userguide?.execute(
      "userguide",
      { task: "write the guide" },
      undefined,
      undefined,
      createMockCtx(cwd),
    );
    await vi.waitFor(() => {
      expect(messages.some((msg) => msg.customType === "belayd-run-complete")).toBe(true);
    });

    mockExecFile.clear();
    await commit({ message: "feat: crlf", taskId: "bd-42" });

    const noteCall = callsFor("bd").find((call) => call.args[0] === "note");
    expect(noteCall).toBeDefined();
    expect(noteCall?.stdin).toContain("## How to Verify\r\n1. Run tests");
  });

  it("removes the temp message file even when git commit throws", async () => {
    let commitMessageFile = "";
    mockExecFile.setResponder((record) => {
      if (record.file === "git" && record.args[0] === "commit") {
        commitMessageFile = argAt(record.args, 2);
        return {
          stdout: "",
          stderr: "lefthook failed",
          error: new Error("commit failed: hook rejection"),
        };
      }
      if (record.file === "git" && record.args[0] === "rev-parse") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await commit({ message: "feat: throws", body: "body" });

    // The throw path must still surface a failure result (not crash).
    expect(result.details.exitCode).toBe(1);
    // The finally block must clean up the temp file on the failure path too —
    // a reintroduced leak (e.g. early return without finally) would leave it.
    expect(commitMessageFile).not.toBe("");
    expect(existsSync(commitMessageFile)).toBe(false);
  });

  it("reports unknown when rev-parse fails and commit output has no-space hash", async () => {
    // The regex fallback anchors on a space inside `[... <hash>]`; a hash
    // with no surrounding space must not match, yielding "unknown".
    mockExecFile.setResponder((record) => {
      if (record.file === "git" && record.args[0] === "rev-parse") {
        return { stdout: "", stderr: "", error: new Error("rev-parse failed") };
      }
      return { stdout: "[abc1234]", stderr: "" };
    });

    const result = await commit({ message: "feat: malformed" });
    expect(result.content[0]?.text).toBe("Committed as unknown");
  });

  it("falls back to `add -A` when files is omitted or empty", async () => {
    // No `files` key at all → stage everything. A regression that built
    // `git add -- ` with no paths would silently commit nothing.
    await commit({ message: "feat: no files" });
    const addCall = callsFor("git").find((call) => call.args[0] === "add");
    expect(addCall?.args).toEqual(["add", "-A"]);
  });

  it("falls back to `add -A` when files is an empty array", async () => {
    await commit({ message: "feat: empty files", files: [] });
    const addCall = callsFor("git").find((call) => call.args[0] === "add");
    expect(addCall?.args).toEqual(["add", "-A"]);
  });

  it("uses exactly [commit, -F, <path>] with no -m or editor flags", async () => {
    // Locking the argv shape: a regression that added `-m` alongside `-F`
    // (or an editor flag) would re-open shell-interpolation surface.
    await commit({ message: "feat: argv", body: "body" });
    const commitCall = callsFor("git").find((call) => call.args[0] === "commit");
    expect(commitCall).toBeDefined();
    const args = commitCall?.args ?? [];
    expect(args).toHaveLength(3);
    expect(args[0]).toBe("commit");
    expect(args[1]).toBe("-F");
    expect(args[2]).toMatch(/belayd-commit-msg-/);
    expect(args).not.toContain("-m");
    expect(args).not.toContain("-e");
  });

  it("never invokes exec during a commit", async () => {
    mockExec.mockClear();
    await commit({ message: "feat: no exec", taskId: "bd-42" });
    expect(mockExec).not.toHaveBeenCalled();
  });
});
