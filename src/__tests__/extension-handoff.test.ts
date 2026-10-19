/**
 * Handoff disarm tests (bd-120).
 *
 * `belayd_start_followup` and `/belayd` create a second orchestrator session
 * for a new worktree. The caller must stop driving the workflow: no gate, no
 * phase-run bookkeeping, a persisted handoff marker, and a status that says so
 * instead of reporting a live workflow. Without this, two orchestrators drive
 * the same bead and produce duplicate phase runs and apparent reverts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callerHandoffFilePath,
  computeOrchestratorSessionName,
  readCallerHandoff,
  readWorkflowState,
  workflowStateFilePath,
  writeCallerHandoff,
} from "../index.js";
import { RunStatus, readRunManifest, writeRunManifest } from "../run-manifest.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

// ── Mocks ──────────────────────────────────────────────────────────────

const FULL_TOOLS = ["read", "write", "edit", "bash"];

const gitState = vi.hoisted(() => ({
  worktreeDir: "",
  worktreeCreated: false,
  head: "feat/bd-100" as string | undefined,
  /** When set, `git worktree list` reports this cwd as a linked worktree. */
  insideCwd: undefined as string | undefined,
  insideBranch: "feat/bd-101",
  stack: {
    bases: {} as Record<string, string>,
    forkPoints: {} as Record<string, string>,
    branches: {} as Record<string, string>,
    mergeBases: {} as Record<string, string>,
  },
}));

const execFileSyncCalls = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);

function configKeyOwner(key: string): string {
  return key.slice("branch.".length, key.lastIndexOf("."));
}

function respondConfig(args: readonly string[]): string {
  const key = args[2] ?? "";
  if (args[1] === "--get") {
    const owner = configKeyOwner(key);
    const value = key.endsWith(".belaydForkPoint")
      ? gitState.stack.forkPoints[owner]
      : gitState.stack.bases[owner];
    if (value === undefined) throw new Error(`no such key: ${key}`);
    return `${value}\n`;
  }
  const owner = configKeyOwner(args[1] ?? "");
  const value = args[2] ?? "";
  if ((args[1] ?? "").endsWith(".belaydForkPoint")) {
    gitState.stack.forkPoints[owner] = value;
  } else if ((args[1] ?? "").endsWith(".belaydBase")) {
    gitState.stack.bases[owner] = value;
  }
  return "";
}

function respondGit(args: readonly string[]): string {
  switch (args[0]) {
    case "rev-parse": {
      if (args[1] === "--abbrev-ref") return `${gitState.head ?? "HEAD"}\n`;
      if (args[1] === "--verify") {
        const name = (args[3] ?? "").replace("refs/heads/", "");
        const sha = gitState.stack.branches[name];
        if (sha === undefined) throw new Error(`unknown branch: ${name}`);
        return `${sha}\n`;
      }
      return "sha-base\n";
    }
    case "config":
      return respondConfig(args);
    case "merge-base": {
      const sha = gitState.stack.mergeBases[`${args[2] ?? ""} ${args[3] ?? ""}`];
      if (sha === undefined) throw new Error("no merge base");
      return `${sha}\n`;
    }
    default:
      // `git branch --list` for an unknown branch reports nothing.
      return "";
  }
}

const mockExecFileSync = vi.hoisted(() =>
  vi.fn((file: string, args: readonly string[]) => {
    execFileSyncCalls.push({ file, args: [...args] });
    if (file === "wt") {
      gitState.worktreeCreated = true;
      return "";
    }
    if (file === "git") return respondGit(args);
    return "";
  }),
);

const mockExecSync = vi.hoisted(() =>
  vi.fn((cmd: string) => {
    if (cmd.startsWith("git rev-parse --abbrev-ref HEAD")) return `${gitState.head}\n`;
    if (cmd === "git worktree list --porcelain") {
      if (gitState.insideCwd !== undefined) {
        return [
          `worktree ${gitState.insideCwd}`,
          `branch refs/heads/${gitState.insideBranch}`,
          "",
        ].join("\n");
      }
      const lines = ["worktree /repo/main", "branch refs/heads/main", ""];
      if (gitState.worktreeCreated && gitState.worktreeDir !== "") {
        lines.push(`worktree ${gitState.worktreeDir}`, "branch refs/heads/feat/bd-101", "");
      }
      return lines.join("\n");
    }
    throw new Error(`mock execSync: ${cmd}`);
  }),
);

// `bd show` (and every other argv call) fails: these tests do not need bead
// metadata, and the launch path must tolerate a missing CLI.
const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const stdin = { on: () => {}, end: () => cb(new Error("execFile unavailable"), "", "") };
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

const httpCalls = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string }> = [];
  return {
    calls,
    /** Force the next prompt POST to fail like a daemon 5xx. */
    failPrompt: false,
    clear: () => {
      calls.length = 0;
      httpCalls.failPrompt = false;
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
      httpCalls.calls.push({ method: opts.method ?? "", path: opts.path ?? "" });
      const promptFailed = httpCalls.failPrompt && (opts.path ?? "").endsWith("/prompt");
      const data = promptFailed
        ? JSON.stringify({ error: "prompt delivery failed" })
        : opts.method === "POST" && opts.path === "/sessions"
          ? JSON.stringify({ id: "sess-child" })
          : "{}";
      callback({
        statusCode: promptFailed ? 500 : 200,
        on: vi.fn((event: string, handler: (chunk: string) => void) => {
          if (event === "data") handler(data);
          if (event === "end") handler("");
        }),
      });
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    },
  ),
);

vi.mock("node:http", () => ({ request: mockHttpRequest }));

const mockSpawnAgentProcess = vi.hoisted(() => vi.fn());

vi.mock("../spawn.js", () => ({ spawnAgentProcess: mockSpawnAgentProcess }));

// ── Mock pi ────────────────────────────────────────────────────────────

interface ToolLike {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

interface MockMessage {
  customType: string;
  content: string;
}

function createMockPi(): {
  api: ExtensionAPI;
  tools: Map<string, ToolLike>;
  commands: Map<string, { handler: (...args: unknown[]) => Promise<void> }>;
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  messages: MockMessage[];
  activeTools: string[];
} {
  const tools = new Map<string, ToolLike>();
  const commands = new Map<string, { handler: (...args: unknown[]) => Promise<void> }>();
  // pi runs every `before_agent_start` handler and collects their messages; the
  // harness registers the gate and the instruction-group gate separately, so a
  // single last-writer-wins slot would hide the gate message.
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const messages: MockMessage[] = [];
  let activeTools: string[] = [...FULL_TOOLS];

  const api = {
    registerTool: (def: ToolLike) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, cmd: { handler: (...args: unknown[]) => Promise<void> }) => {
      commands.set(name, cmd);
    },
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    sendMessage: (msg: MockMessage) => {
      messages.push({ customType: msg.customType, content: msg.content });
    },
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => {
      activeTools = next;
    },
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;

  return {
    api,
    tools,
    commands,
    handlers,
    messages,
    get activeTools() {
      return activeTools;
    },
  };
}

async function loadPi() {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const harness = createMockPi();
  register(harness.api);
  return harness;
}

let nextSessionId = 0;

function createCtx(cwd: string, options: { sessionId?: string; sessionFile?: string } = {}) {
  const sessionId = options.sessionId ?? `handoff-session-${nextSessionId++}`;
  return {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "orchestrator-session",
      getSessionFile: () => options.sessionFile ?? `${cwd}/session.jsonl`,
    },
  };
}

function deferredSpawn(): { resolve: () => void } {
  let resolve: () => void = () => {};
  mockSpawnAgentProcess.mockReturnValueOnce(
    new Promise((done) => {
      resolve = () => {
        done({
          content: [{ type: "text" as const, text: "scout done" }],
          details: {
            messages: [],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0,
              toolCalls: 1,
            },
            exitCode: 0,
          },
          sessionName: "mocked-scout",
        });
      };
    }),
  );
  return { resolve };
}

function statusText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content;
  return content?.[0]?.text ?? "";
}

function toolExitCode(result: unknown): number {
  return (result as { details?: { exitCode?: number } } | undefined)?.details?.exitCode ?? -1;
}

/** Run pi's `before_agent_start` fan-out and return the first gate message. */
async function runBeforeAgentStart(
  harness: { handlers: Map<string, Array<(...args: unknown[]) => unknown>> },
  ctx: ReturnType<typeof createCtx>,
): Promise<string | undefined> {
  const registered = harness.handlers.get("before_agent_start") ?? [];
  expect(registered.length).toBeGreaterThan(0);
  for (const handler of registered) {
    try {
      const result = (await handler({}, ctx)) as { message?: { content?: string } } | undefined;
      const content = result?.message?.content;
      if (content !== undefined) return content;
    } catch {
      // pi isolates each handler; a throw here is not the gate's answer.
    }
  }
  return undefined;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("workflow handoff disarms the caller (bd-120)", () => {
  let cwd: string;
  let surfacedWorktree: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-handoff-"));
    surfacedWorktree = `${cwd}.feat-bd-101`;
    gitState.worktreeDir = surfacedWorktree;
    gitState.worktreeCreated = false;
    gitState.head = "feat/bd-100";
    gitState.insideCwd = undefined;
    gitState.stack = { bases: {}, forkPoints: {}, branches: {}, mergeBases: {} };
    execFileSyncCalls.length = 0;
    httpCalls.clear();
    mockExecFile.mockClear();
    mockExecSync.mockClear();
    mockExecFileSync.mockClear();
    mockSpawnAgentProcess.mockReset();
    mockSpawnAgentProcess.mockResolvedValue({
      content: [{ type: "text" as const, text: "done" }],
      details: {
        messages: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
          toolCalls: 1,
        },
        exitCode: 0,
      },
      sessionName: "mocked",
    });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(surfacedWorktree, { recursive: true, force: true });
  });

  /** Arm the caller's gate so the disarm has something to clear. */
  async function startCallerWorkflow(
    tools: Map<string, ToolLike>,
    ctx: ReturnType<typeof createCtx>,
  ) {
    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-100", workflowType: "research" }, undefined, undefined, ctx);
  }

  it("disarms the caller and records the handoff after a follow-up launch", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    await startCallerWorkflow(harness.tools, ctx);

    const outcome = await harness.tools
      .get("belayd_start_followup")
      ?.execute("followup", { taskId: "bd-101", base: "main" }, undefined, undefined, ctx);

    expect(toolExitCode(outcome)).toBe(0);

    // Gate off: the caller's original tool set is restored.
    expect(harness.activeTools).toEqual(FULL_TOOLS);

    const handoff = harness.messages.find((m) => m.customType === "belayd-handoff");
    expect(handoff).toBeDefined();
    expect(handoff?.content).toContain("bd-101");
    expect(handoff?.content).toContain(computeOrchestratorSessionName("bd-101"));
    expect(handoff?.content).toContain("feat/bd-101");
    expect(handoff?.content).toContain("you no longer drive a workflow");

    // The caller's own state file records who owns the bead now.
    expect(readWorkflowState({ cwd })).toHaveProperty("handedOffTo", {
      taskId: "bd-101",
      branch: "feat/bd-101",
      sessionId: "sess-child",
    });
    // The caller-scoped marker is the authoritative restart guard.
    expect(readCallerHandoff({ cwd, sessionKey: ctx.sessionManager.getSessionId() })).toEqual({
      taskId: "bd-101",
      branch: "feat/bd-101",
      sessionId: "sess-child",
    });

    const status = await harness.tools
      .get("belayd_status")
      ?.execute("status", {}, undefined, undefined, ctx);
    const text = statusText(status);
    expect(text).toContain("Handed off");
    expect(text).toContain("bd-101");
    expect(text).toContain("sess-child");
    expect(text).toContain("no longer drives a workflow");
    // The caller must not present itself as a live workflow.
    expect(text).not.toContain("Next required step");
  });

  it("does not re-arm a handed-off workflow when the caller restarts", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    await startCallerWorkflow(harness.tools, ctx);
    await harness.tools
      .get("belayd_start_followup")
      ?.execute("followup", { taskId: "bd-101", base: "main" }, undefined, undefined, ctx);

    // A restart resumes the same pi session id, so the caller-scoped marker
    // and the workflow.json marker both point at the same handoff.
    const restarted = createCtx(cwd, { sessionId });
    const sessionStart = harness.handlers.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();
    await sessionStart?.({}, restarted);

    expect(await runBeforeAgentStart(harness, restarted)).toBeUndefined();
    expect(harness.activeTools).toEqual(FULL_TOOLS);

    // The markers survive so status can still explain the handoff.
    expect(workflowStateFilePath(cwd)).toContain(".belayd/workflow.json");
    expect(readWorkflowState({ cwd })).toHaveProperty("handedOffTo");
    expect(readCallerHandoff({ cwd, sessionKey: sessionId })).toBeDefined();

    const status = await harness.tools
      .get("belayd_status")
      ?.execute("status", {}, undefined, undefined, restarted);
    expect(statusText(status)).toContain("Handed off");
  });

  it("refuses to hand off while a phase run is in flight and names the run", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    await startCallerWorkflow(harness.tools, ctx);
    const pending = deferredSpawn();
    await harness.tools
      .get("belayd_scout")
      ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

    const outcome = await harness.tools
      .get("belayd_start_followup")
      ?.execute("followup", { taskId: "bd-101", base: "main" }, undefined, undefined, ctx);

    const text = statusText(outcome);
    expect(toolExitCode(outcome)).toBe(1);
    expect(text).toContain("in flight");
    expect(text).toContain("scout");
    expect(text).toContain("bd-100");
    expect(text).toContain("force");
    // Nothing was created: no worktree switch, no child session.
    expect(execFileSyncCalls.some((call) => call.file === "wt")).toBe(false);
    expect(httpCalls.calls.some((call) => call.path === "/sessions")).toBe(false);
    // The caller still owns its workflow.
    expect(readWorkflowState({ cwd })?.handedOffTo).toBeUndefined();
    expect(harness.activeTools).not.toEqual(FULL_TOOLS);

    pending.resolve();
  });

  it("force hands off despite in-flight runs and disarms them", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    await startCallerWorkflow(harness.tools, ctx);
    const pending = deferredSpawn();
    await harness.tools
      .get("belayd_scout")
      ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

    const outcome = await harness.tools
      .get("belayd_start_followup")
      ?.execute(
        "followup",
        { taskId: "bd-101", base: "main", force: true },
        undefined,
        undefined,
        ctx,
      );

    expect(toolExitCode(outcome)).toBe(0);
    expect(harness.activeTools).toEqual(FULL_TOOLS);
    expect(readWorkflowState({ cwd })).toHaveProperty("handedOffTo.taskId", "bd-101");

    const status = await harness.tools
      .get("belayd_status")
      ?.execute("status", {}, undefined, undefined, ctx);
    const text = statusText(status);
    expect(text).toContain("Handed off");
    expect(text).toContain("(none)");

    pending.resolve();
    // The forced handoff bumped the run epoch: the aborted run's late settle
    // must not deliver a follow-up into a session that no longer owns it.
    await new Promise((done) => setTimeout(done, 30));
    expect(harness.messages.some((m) => m.customType === "belayd-run-complete")).toBe(false);
  });

  it("/belayd --force shares the same handoff path", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    await startCallerWorkflow(harness.tools, ctx);
    const pending = deferredSpawn();
    await harness.tools
      .get("belayd_scout")
      ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

    const command = harness.commands.get("belayd");
    expect(command).toBeDefined();
    await command?.handler("bd-101 --force", ctx);

    expect(harness.messages.some((m) => m.customType === "belayd-handoff")).toBe(true);
    expect(readWorkflowState({ cwd })).toHaveProperty("handedOffTo", {
      taskId: "bd-101",
      branch: "feat/bd-101",
      sessionId: "sess-child",
    });
    expect(harness.activeTools).toEqual(FULL_TOOLS);

    pending.resolve();
  });

  it("clears the handoff marker when the caller starts a new task", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    await startCallerWorkflow(harness.tools, ctx);
    await harness.tools
      .get("belayd_start_followup")
      ?.execute("followup", { taskId: "bd-101", base: "main" }, undefined, undefined, ctx);
    expect(readWorkflowState({ cwd })?.handedOffTo).toBeDefined();

    await harness.tools
      .get("belayd_start_task")
      ?.execute(
        "restart",
        { taskId: "bd-100", workflowType: "research" },
        undefined,
        undefined,
        ctx,
      );

    // A new task supersedes the handoff: the marker must not survive, or a
    // later restart would refuse to resume the workflow the caller is driving.
    expect(readWorkflowState({ cwd })?.handedOffTo).toBeUndefined();
    expect(readCallerHandoff({ cwd, sessionKey: ctx.sessionManager.getSessionId() })).toBe(
      undefined,
    );

    expect(await runBeforeAgentStart(harness, ctx)).toContain("BELAYD WORKFLOW ACTIVE");
  });

  it("/belayd refuses a same-worktree launch without force", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    await startCallerWorkflow(harness.tools, ctx);

    // The caller now sits inside the target worktree (a realistic retry after
    // the child died). Its workflow.json is the file the child would own.
    gitState.head = "feat/bd-101";
    gitState.insideCwd = cwd;

    const command = harness.commands.get("belayd");
    await command?.handler("bd-101", ctx);

    const error = ctx.ui.notify.mock.calls.at(-1)?.[0] ?? "";
    expect(String(error)).toContain("already inside that worktree");
    expect(String(error)).toContain("One session per worktree");
    expect(String(error)).toContain("force");
    // Nothing was created and the caller still drives its own workflow.
    expect(execFileSyncCalls.some((call) => call.file === "wt")).toBe(false);
    expect(httpCalls.calls.some((call) => call.path === "/sessions")).toBe(false);
    expect(harness.messages.some((m) => m.customType === "belayd-handoff")).toBe(false);
    expect(await runBeforeAgentStart(harness, ctx)).toContain("BELAYD WORKFLOW ACTIVE");
  });

  it("forced same-worktree handoff stays disarmed across a restart", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    await startCallerWorkflow(harness.tools, ctx);

    gitState.head = "feat/bd-101";
    gitState.insideCwd = cwd;

    const command = harness.commands.get("belayd");
    await command?.handler("bd-101 --force", ctx);

    expect(harness.messages.some((m) => m.customType === "belayd-handoff")).toBe(true);
    expect(harness.activeTools).toEqual(FULL_TOOLS);

    // The child overwrote the shared workflow.json with its own fresh workflow;
    // the caller-scoped marker is the only surviving handoff record.
    expect(readWorkflowState({ cwd })).toHaveProperty("taskId", "bd-101");
    expect(readWorkflowState({ cwd })?.handedOffTo).toBeUndefined();
    expect(readCallerHandoff({ cwd, sessionKey: sessionId })).toEqual({
      taskId: "bd-101",
      branch: "feat/bd-101",
      sessionId: "sess-child",
    });

    // The same session resumed must not re-arm the workflow it handed off.
    const restarted = createCtx(cwd, { sessionId });
    await harness.handlers.get("session_start")?.[0]?.({}, restarted);
    expect(await runBeforeAgentStart(harness, restarted)).toBeUndefined();
    const status = await harness.tools
      .get("belayd_status")
      ?.execute("status", {}, undefined, undefined, restarted);
    expect(statusText(status)).toContain("Handed off");

    // A different (child) session in the same worktree still arms the child's
    // workflow — the marker is scoped to the caller, not the directory.
    const childSession = createCtx(cwd);
    await harness.handlers.get("session_start")?.[0]?.({}, childSession);
    expect(await runBeforeAgentStart(harness, childSession)).toContain("bd-101");
  });

  it("aborts the handoff when the caller-scoped marker cannot be written", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    await startCallerWorkflow(harness.tools, ctx);

    // Make `.belayd` a regular file so the marker write cannot create its dir.
    const belaydPath = join(cwd, ".belayd");
    rmSync(belaydPath, { recursive: true, force: true });
    writeFileSync(belaydPath, "not a directory");

    const outcome = await harness.tools
      .get("belayd_start_followup")
      ?.execute("followup", { taskId: "bd-101", base: "main" }, undefined, undefined, ctx);

    const text = statusText(outcome);
    expect(toolExitCode(outcome)).toBe(1);
    // The error names the live child so the operator can clean it up.
    expect(text).toContain("sess-child");
    expect(text).toContain("stays armed");
    expect(harness.messages.some((m) => m.customType === "belayd-handoff")).toBe(false);
    // The caller still drives (and can still see) its workflow.
    expect(harness.activeTools).not.toEqual(FULL_TOOLS);
    expect(await runBeforeAgentStart(harness, ctx)).toContain("BELAYD WORKFLOW ACTIVE");
  });

  it("surfaces a failure to clear a stale handoff marker on a new task", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    await startCallerWorkflow(harness.tools, ctx);
    await harness.tools
      .get("belayd_start_followup")
      ?.execute("followup", { taskId: "bd-101", base: "main" }, undefined, undefined, ctx);

    // Replace the marker file with a non-empty directory: unlink cannot remove
    // it, so clearing (and therefore resuming the new task) would silently fail.
    const markerPath = callerHandoffFilePath(cwd, sessionId);
    rmSync(markerPath, { force: true });
    mkdirSync(markerPath);
    writeFileSync(join(markerPath, "keep"), "x");

    await harness.tools
      .get("belayd_start_task")
      ?.execute(
        "new-task",
        { taskId: "bd-102", workflowType: "research" },
        undefined,
        undefined,
        ctx,
      );

    const problem = harness.messages.find((m) => m.customType === "belayd-error");
    expect(problem?.content).toContain("could not clear this session's handoff marker");
    // The new task still arms in this process.
    expect(await runBeforeAgentStart(harness, ctx)).toContain("BELAYD WORKFLOW ACTIVE");
  });

  it("returns ok:false with the child session id when the prompt POST fails", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    await startCallerWorkflow(harness.tools, ctx);
    httpCalls.failPrompt = true;

    const outcome = await harness.tools
      .get("belayd_start_followup")
      ?.execute("followup", { taskId: "bd-101", base: "main" }, undefined, undefined, ctx);

    const text = statusText(outcome);
    expect(toolExitCode(outcome)).toBe(1);
    expect(text).toContain("sess-child");
    expect(text).toContain("workflow prompt");
    expect(text).toContain("prompt delivery failed");
    // No marker, no disarm: the caller retries from a clean state.
    expect(harness.messages.some((m) => m.customType === "belayd-handoff")).toBe(false);
    expect(readCallerHandoff({ cwd, sessionKey: ctx.sessionManager.getSessionId() })).toBe(
      undefined,
    );
    expect(harness.activeTools).not.toEqual(FULL_TOOLS);
  });

  it("reports pending caller work after a handed-off restart instead of dropping it", async () => {
    const harness = await loadPi();
    const sessionId = `pending-session-${nextSessionId++}`;
    writeCallerHandoff({
      cwd,
      sessionKey: sessionId,
      marker: { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" },
    });
    writeRunManifest({
      cwd,
      manifest: {
        schemaVersion: 1,
        runId: "implement-run",
        taskId: "bd-100",
        phase: "implement",
        sessionName: "belayd-bd-100-sub-implement-implement-run",
        status: RunStatus.Running,
        startedAt: 1_000,
      },
    });
    writeRunManifest({
      cwd,
      manifest: {
        schemaVersion: 1,
        runId: "review-run",
        taskId: "bd-100",
        phase: "review",
        sessionName: "belayd-bd-100-sub-review-review-run",
        status: RunStatus.Completed,
        completedBy: "user",
        completionReport: "review done",
        startedAt: 2_000,
      },
    });

    const ctx = createCtx(cwd, { sessionId });
    await harness.handlers.get("session_start")?.[0]?.({}, ctx);

    // The caller no longer drives anything, but its leftovers are settled and
    // reported rather than silently lost.
    expect(await runBeforeAgentStart(harness, ctx)).toBeUndefined();
    expect(readRunManifest({ cwd, runId: "implement-run" })).toHaveProperty(
      "status",
      RunStatus.Interrupted,
    );
    expect(readRunManifest({ cwd, runId: "review-run" })?.deliveredAt).toBeDefined();

    const status = await harness.tools
      .get("belayd_status")
      ?.execute("status", {}, undefined, undefined, ctx);
    const text = statusText(status);
    expect(text).toContain("Handed off");
    expect(text).toContain("Pending items from the handoff");
    expect(text).toContain("interrupted phase run");
    expect(text).toContain("marked delivered without applying them");
  });

  it("records the handoff for a caller with no workflow.json", async () => {
    const harness = await loadPi();
    const ctx = createCtx(cwd);
    const sessionId = ctx.sessionManager.getSessionId();

    // A session that never activated a gate has no workflow.json to mark, so
    // the caller-scoped file is the only destination record.
    const command = harness.commands.get("belayd");
    await command?.handler("bd-101", ctx);

    expect(harness.messages.some((m) => m.customType === "belayd-handoff")).toBe(true);
    expect(readWorkflowState({ cwd })).toBe(undefined);
    expect(readCallerHandoff({ cwd, sessionKey: sessionId })).toHaveProperty("taskId", "bd-101");

    const restarted = createCtx(cwd, { sessionId });
    await harness.handlers.get("session_start")?.[0]?.({}, restarted);
    expect(await runBeforeAgentStart(harness, restarted)).toBeUndefined();

    const status = await harness.tools
      .get("belayd_status")
      ?.execute("status", {}, undefined, undefined, restarted);
    expect(statusText(status)).toContain("Handed off");
  });
});
