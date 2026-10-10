/**
 * Tests for `/belayd-complete` (bd-107): recovering a dead/interrupted
 * sub-agent's last response and feeding it back to the orchestrator.
 *
 * Covers:
 * - command registration and happy path (last assistant text)
 * - explicit report argument override
 * - non-sub-agent no-op
 * - missing manifest error
 * - daemon wake failure still persists the completion
 * - reconcile/input-sentinel: marks the phase complete, delivers once
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-complete-test-cooldowns.json");

// ── Mocks ──────────────────────────────────────────────────────────────

const mockExec = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(new Error("pnpm not available in test environment"), "", "");
    },
  ),
);

// `bd` is unavailable: workflow resolution falls back to defaults, which is
// all these tests need.
const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const stdin = {
        on: () => {},
        end: () => cb(new Error("bd not available"), "", ""),
      };
      return { stdin };
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: mockExec,
    execFile: mockExecFile,
    execSync: () => {
      throw new Error("no execSync in test");
    },
    execFileSync: () => "",
  };
});

const httpCalls = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string }> = [];
  const state = { fail: false, body: "" };
  return {
    calls,
    state,
    clear: () => {
      calls.length = 0;
      state.fail = false;
      state.body = "";
    },
  };
});

// A controllable sub-agent spawn: tests that never start a phase run are
// unaffected, while the late-settle test defers the promise to control the
// ordering between `/belayd-complete` recovery and the child's settle.
const mockSpawnAgentProcess = vi.hoisted(() => vi.fn());
vi.mock("../spawn.js", () => ({ spawnAgentProcess: mockSpawnAgentProcess }));

vi.mock("node:http", () => ({
  request: (
    opts: { method?: string; path?: string },
    callback: (res: {
      statusCode: number;
      on: (event: string, handler: (chunk: string) => void) => void;
    }) => void,
  ) => {
    httpCalls.calls.push({ method: opts.method ?? "", path: opts.path ?? "" });
    if (httpCalls.state.fail) {
      return {
        on: (event: string, handler: (err: Error) => void) => {
          if (event === "error") handler(new Error("daemon unavailable"));
        },
        write: () => {},
        end: () => {},
      };
    }
    const body =
      httpCalls.state.body !== ""
        ? httpCalls.state.body
        : JSON.stringify({ sessions: [{ id: "sess1", name: "belayd-bd-42" }] });
    callback({
      statusCode: 200,
      on: (event: string, handler: (chunk: string) => void) => {
        if (event === "data") handler(body);
        if (event === "end") handler("");
      },
    });
    return { on: () => {}, write: () => {}, end: () => {} };
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => unknown;

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  messages: Array<{ customType: string; content: string; options?: Record<string, unknown> }>;
  entries: Array<{ customType: string; data?: unknown }>;
  handlers: Map<string, Handler[]>;
}

function createMockPi(): MockPi {
  const tools = new Map<
    string,
    { name: string; execute: (...args: unknown[]) => Promise<unknown> }
  >();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const messages: Array<{
    customType: string;
    content: string;
    options?: Record<string, unknown>;
  }> = [];
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const handlers = new Map<string, Handler[]>();
  const activeToolsBox: { list: string[] } = { list: [] };

  const api = {
    registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(def.name, def);
    },
    registerCommand: (
      name: string,
      cmd: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, cmd);
    },
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (msg: { customType: string; content: string }, opts?: Record<string, unknown>) => {
      messages.push({ customType: msg.customType, content: msg.content, options: opts });
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
    getActiveTools: () => activeToolsBox.list,
    setActiveTools: (list: string[]) => {
      activeToolsBox.list = list;
    },
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;

  return { api, tools, commands, messages, entries, handlers };
}

async function loadExtension(): Promise<(pi: ExtensionAPI) => void> {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

let sessionIdCounter = 0;

function makeSubagentCtx(cwd: string, sessionName: string, branch: unknown[]) {
  sessionIdCounter += 1;
  return {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => `complete-test-sub-${sessionIdCounter}`,
      getSessionName: () => sessionName,
      getBranch: () => branch,
      getSessionFile: () => "/tmp/session.jsonl",
    },
  };
}

function makeOrchestratorCtx(cwd: string) {
  sessionIdCounter += 1;
  return {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => `complete-test-orch-${sessionIdCounter}`,
      getSessionName: () => "belayd-bd-42",
      getBranch: () => [],
      getSessionFile: () => "/tmp/orchestrator.jsonl",
    },
  };
}

const assistantEntry = (text: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

async function seedRunningManifest(cwd: string, options: { runId: string; sessionName: string }) {
  const { writeRunManifest, RunStatus } = await import("../run-manifest.js");
  writeRunManifest({
    cwd,
    manifest: {
      schemaVersion: 1,
      runId: options.runId,
      taskId: "bd-42",
      phase: "implement",
      sessionName: options.sessionName,
      status: RunStatus.Running,
      startedAt: 1_000,
    },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("/belayd-complete command (bd-107)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-complete-test-"));
    httpCalls.clear();
    mockExecFile.mockClear();
    mockSpawnAgentProcess.mockReset();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("registers the command", async () => {
    const { api, commands } = createMockPi();
    const factory = await loadExtension();
    factory(api);
    expect(commands.get("belayd-complete")).toBeDefined();
  });

  it("feeds the last assistant message back and persists the completion", async () => {
    const { api, commands, entries } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const sessionName = "belayd-bd-42-sub-implement-run7";
    await seedRunningManifest(cwd, { runId: "run7", sessionName });
    const ctx = makeSubagentCtx(cwd, sessionName, [assistantEntry("recovered answer")]);

    await commands.get("belayd-complete")?.handler("", ctx);

    const { readRunManifest } = await import("../run-manifest.js");
    const manifest = readRunManifest({ cwd, runId: "run7" });
    expect(manifest).toHaveProperty("completionReport", "recovered answer");
    expect(manifest).toHaveProperty("completedBy", "user");
    expect(manifest).toHaveProperty("status", "completed");
    expect(manifest).not.toHaveProperty("deliveredAt");
    expect(entries.map((e) => e.customType)).toContain("belayd-complete");
    expect(httpCalls.calls.some((c) => c.method === "GET" && c.path === "/sessions")).toBe(true);
    // The daemon wake only counts if it actually prompts the orchestrator.
    expect(
      httpCalls.calls.some((c) => c.method === "POST" && c.path === "/sessions/sess1/prompt"),
    ).toBe(true);
  });

  it("uses an explicit report argument over the transcript", async () => {
    const { api, commands } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const sessionName = "belayd-bd-42-sub-implement-run8";
    await seedRunningManifest(cwd, { runId: "run8", sessionName });
    const ctx = makeSubagentCtx(cwd, sessionName, [assistantEntry("transcript text")]);

    await commands.get("belayd-complete")?.handler("explicit report", ctx);

    const { readRunManifest } = await import("../run-manifest.js");
    expect(readRunManifest({ cwd, runId: "run8" })).toHaveProperty(
      "completionReport",
      "explicit report",
    );
  });

  it("no-ops with an error outside a phase sub-agent session", async () => {
    const { api, commands, entries } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeSubagentCtx(cwd, "belayd-bd-42", [assistantEntry("x")]);
    await commands.get("belayd-complete")?.handler("report", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("only available inside a phase sub-agent session"),
      "error",
    );
    expect(entries).toHaveLength(0);
  });

  it("no-ops for a planning sub-agent session name", async () => {
    const { api, commands, entries } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    // Planning runs have no task id, no run manifest, and no recovery path.
    const ctx = makeSubagentCtx(cwd, "belayd-planning-sub-scout-abc123", [
      assistantEntry("plan text"),
    ]);
    await commands.get("belayd-complete")?.handler("report", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("only available inside a phase sub-agent session"),
      "error",
    );
    expect(entries).toHaveLength(0);
  });

  it("matches a run manifest by base session components when the live name carries a retry suffix", async () => {
    const { api, commands } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    // The manifest records the base name minted when the run started, but the
    // live sub-agent session was renamed to `-retry-3` by a gate retry. The
    // exact-name lookup must miss and the parsed-component fallback must hit.
    const baseName = "belayd-bd-42-sub-implement-abc123";
    await seedRunningManifest(cwd, { runId: "base1", sessionName: baseName });
    const ctx = makeSubagentCtx(cwd, `${baseName}-retry-3`, [assistantEntry("retry recovered")]);

    await commands.get("belayd-complete")?.handler("", ctx);

    const { readRunManifest } = await import("../run-manifest.js");
    expect(readRunManifest({ cwd, runId: "base1" })).toHaveProperty(
      "completionReport",
      "retry recovered",
    );
  });

  it("errors when no run manifest matches the session", async () => {
    const { api, commands } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeSubagentCtx(cwd, "belayd-bd-42-sub-implement-missing", [
      assistantEntry("answer"),
    ]);
    await commands.get("belayd-complete")?.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No run manifest"), "error");
  });

  it("errors when there is no report text at all", async () => {
    const { api, commands } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeSubagentCtx(cwd, "belayd-bd-42-sub-implement-noreport", []);
    await commands.get("belayd-complete")?.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No report text found"),
      "error",
    );
  });

  it("still persists the completion when the daemon wake fails", async () => {
    const { api, commands } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    httpCalls.state.fail = true;
    const sessionName = "belayd-bd-42-sub-implement-run9";
    await seedRunningManifest(cwd, { runId: "run9", sessionName });
    const ctx = makeSubagentCtx(cwd, sessionName, [assistantEntry("survives daemon failure")]);

    await commands.get("belayd-complete")?.handler("", ctx);

    const { readRunManifest } = await import("../run-manifest.js");
    expect(readRunManifest({ cwd, runId: "run9" })).toHaveProperty("completedBy", "user");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("marked complete"), "info");
  });

  it("ignores malformed daemon session entries when waking the orchestrator", async () => {
    const { api, commands } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    // The daemon's session list is untrusted: ids that are not non-empty
    // strings must not become a `/sessions/<id>/prompt` path segment.
    httpCalls.state.body = JSON.stringify({
      sessions: [
        { id: {}, name: "belayd-bd-42" },
        { id: 7, name: "belayd-bd-42" },
      ],
    });
    const sessionName = "belayd-bd-42-sub-implement-run10";
    await seedRunningManifest(cwd, { runId: "run10", sessionName });
    const ctx = makeSubagentCtx(cwd, sessionName, [assistantEntry("malformed daemon")]);

    await commands.get("belayd-complete")?.handler("", ctx);

    expect(httpCalls.calls.some((call) => call.path.includes("/prompt"))).toBe(false);
    const { readRunManifest } = await import("../run-manifest.js");
    expect(readRunManifest({ cwd, runId: "run10" })).toHaveProperty("completedBy", "user");
  });
});

describe("orchestrator reconcile / input sentinel (bd-107)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-complete-reconcile-"));
    httpCalls.clear();
    mockExecFile.mockClear();
    mockSpawnAgentProcess.mockReset();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("delivers a user completion exactly once and marks the phase complete", async () => {
    const { api, tools, messages, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeOrchestratorCtx(cwd);
    const start = tools.get("belayd_start_task");
    await start?.execute("call-start", { taskId: "bd-42" }, undefined, undefined, ctx);

    const { completeRunByUser, readRunManifest, writeRunManifest, RunStatus } = await import(
      "../run-manifest.js"
    );
    writeRunManifest({
      cwd,
      manifest: {
        schemaVersion: 1,
        runId: "run9",
        taskId: "bd-42",
        phase: "implement",
        sessionName: "belayd-bd-42-sub-implement-run9",
        status: RunStatus.Running,
        startedAt: 1_000,
      },
    });
    completeRunByUser({ cwd, runId: "run9", report: "user recovered report" });

    const inputHandler = handlers.get("input")?.[0];
    expect(inputHandler).toBeDefined();
    const event = { type: "input", text: "[belayd-complete:run9]", source: "extension" };

    const first = inputHandler?.(event, ctx);
    expect(first).toEqual({ action: "handled" });
    expect(messages.filter((m) => m.customType === "belayd-run-complete")).toHaveLength(1);
    expect(messages.find((m) => m.customType === "belayd-run-complete")?.content).toContain(
      "user recovered report",
    );
    expect(readRunManifest({ cwd, runId: "run9" })).toHaveProperty("deliveredAt");

    // "Marks the phase complete" is part of this test's contract: the gate
    // state must record implement so the workflow can advance. Assert it on
    // disk, not just that a follow-up message was sent.
    const { readWorkflowState } = await import("../workflow-state.js");
    expect(readWorkflowState({ cwd })?.completedPhaseNames).toContain("implement");

    // A repeated sentinel is a no-op: deliveredAt is the persistent marker.
    const second = inputHandler?.(event, ctx);
    expect(second).toEqual({ action: "handled" });
    expect(messages.filter((m) => m.customType === "belayd-run-complete")).toHaveLength(1);
  });

  it("recovers a persisted user completion on orchestrator restart (file-only path)", async () => {
    const { api, handlers, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    // A fresh process: no in-memory state survives, only .belayd/workflow.json
    // and the run manifest. This is the reconcile path the daemon sentinel
    // cannot cover (the wake was lost while the orchestrator was down).
    const { writeWorkflowState } = await import("../workflow-state.js");
    writeWorkflowState({
      cwd,
      state: {
        schemaVersion: 1,
        taskId: "bd-42",
        workflowType: "feature",
        branch: "feat/bd-42",
        originalCwd: cwd,
        phaseOrder: ["implement", "review", "test", "userguide", "proof", "commit"],
        completedPhaseNames: [],
        startedAt: 1_000,
        updatedAt: 1_000,
      },
    });

    const { completeRunByUser, readRunManifest, writeRunManifest, RunStatus } = await import(
      "../run-manifest.js"
    );
    writeRunManifest({
      cwd,
      manifest: {
        schemaVersion: 1,
        runId: "restart1",
        taskId: "bd-42",
        phase: "implement",
        sessionName: "belayd-bd-42-sub-implement-restart1",
        status: RunStatus.Running,
        startedAt: 1_000,
      },
    });
    completeRunByUser({ cwd, runId: "restart1", report: "restart recovered report" });

    const ctx = makeOrchestratorCtx(cwd);
    const sessionStart = handlers.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();
    await sessionStart?.({}, ctx);

    const delivered = messages.filter((m) => m.customType === "belayd-run-complete");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.content).toContain("restart recovered report");
    expect(readRunManifest({ cwd, runId: "restart1" })).toHaveProperty("deliveredAt");
  });

  it("marks an already-completed phase delivered without re-delivering its report", async () => {
    const { api, handlers, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    // The phase already completed normally, then a late user completion for
    // the same phase arrives. It must be marked delivered (so it is never
    // replayed) without emitting a second follow-up.
    const { writeWorkflowState } = await import("../workflow-state.js");
    writeWorkflowState({
      cwd,
      state: {
        schemaVersion: 1,
        taskId: "bd-42",
        workflowType: "feature",
        branch: "feat/bd-42",
        originalCwd: cwd,
        phaseOrder: ["implement", "review", "test", "userguide", "proof", "commit"],
        completedPhaseNames: ["implement"],
        startedAt: 1_000,
        updatedAt: 1_000,
      },
    });

    const { completeRunByUser, readRunManifest, writeRunManifest, RunStatus } = await import(
      "../run-manifest.js"
    );
    writeRunManifest({
      cwd,
      manifest: {
        schemaVersion: 1,
        runId: "late1",
        taskId: "bd-42",
        phase: "implement",
        sessionName: "belayd-bd-42-sub-implement-late1",
        status: RunStatus.Running,
        startedAt: 1_000,
      },
    });
    completeRunByUser({ cwd, runId: "late1", report: "late duplicate" });

    const ctx = makeOrchestratorCtx(cwd);
    const sessionStart = handlers.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();
    await sessionStart?.({}, ctx);

    expect(messages.filter((m) => m.customType === "belayd-run-complete")).toHaveLength(0);
    expect(readRunManifest({ cwd, runId: "late1" })).toHaveProperty("deliveredAt");
  });

  it("ignores non-sentinel input", async () => {
    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeOrchestratorCtx(cwd);
    const inputHandler = handlers.get("input")?.[0];
    expect(inputHandler?.({ type: "input", text: "hello", source: "interactive" }, ctx)).toEqual({
      action: "continue",
    });
  });

  it("does not swallow a sentinel-shaped input with trailing text", async () => {
    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeOrchestratorCtx(cwd);
    const inputHandler = handlers.get("input")?.[0];
    expect(
      inputHandler?.(
        { type: "input", text: "[belayd-complete:run9] please review", source: "interactive" },
        ctx,
      ),
    ).toEqual({ action: "continue" });
  });

  it("handles a well-formed sentinel even when the gate is inactive", async () => {
    const { api, handlers, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    // No `belayd_start_task`: the control token must still be swallowed so it
    // never reaches the model.
    const ctx = makeOrchestratorCtx(cwd);
    const inputHandler = handlers.get("input")?.[0];
    expect(
      inputHandler?.({ type: "input", text: "[belayd-complete:run9]", source: "extension" }, ctx),
    ).toEqual({ action: "handled" });
    expect(messages).toHaveLength(0);
  });

  it("does not deliver a user completion with no report", async () => {
    const { api, tools, messages, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeOrchestratorCtx(cwd);
    const start = tools.get("belayd_start_task");
    await start?.execute("call-start", { taskId: "bd-42" }, undefined, undefined, ctx);

    const { writeRunManifest, RunStatus } = await import("../run-manifest.js");
    writeRunManifest({
      cwd,
      manifest: {
        schemaVersion: 1,
        runId: "noreport",
        taskId: "bd-42",
        phase: "implement",
        sessionName: "belayd-bd-42-sub-implement-noreport",
        status: RunStatus.Completed,
        startedAt: 1_000,
        completedBy: "user",
      },
    });

    const inputHandler = handlers.get("input")?.[0];
    expect(
      inputHandler?.(
        { type: "input", text: "[belayd-complete:noreport]", source: "extension" },
        ctx,
      ),
    ).toEqual({ action: "handled" });
    expect(messages.filter((m) => m.customType === "belayd-run-complete")).toHaveLength(0);
  });

  it("keeps the in-memory delivered marker when the disk write fails", async () => {
    const { api, tools, messages, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeOrchestratorCtx(cwd);
    const start = tools.get("belayd_start_task");
    await start?.execute("call-start", { taskId: "bd-42" }, undefined, undefined, ctx);

    const { completeRunByUser, readRunManifest, writeRunManifest, RunStatus } = await import(
      "../run-manifest.js"
    );
    writeRunManifest({
      cwd,
      manifest: {
        schemaVersion: 1,
        runId: "runFail",
        taskId: "bd-42",
        phase: "implement",
        sessionName: "belayd-bd-42-sub-implement-runFail",
        status: RunStatus.Running,
        startedAt: 1_000,
      },
    });
    completeRunByUser({ cwd, runId: "runFail", report: "still delivered" });

    const { chmodSync } = await import("node:fs");
    const runsDirPath = join(cwd, ".belayd", "runs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    chmodSync(runsDirPath, 0o500);
    try {
      const inputHandler = handlers.get("input")?.[0];
      const event = { type: "input", text: "[belayd-complete:runFail]", source: "extension" };

      expect(inputHandler?.(event, ctx)).toEqual({ action: "handled" });
      expect(messages.filter((m) => m.customType === "belayd-run-complete")).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to mark run"));

      // The persisted marker did not land, but the in-memory set suppresses a replay.
      expect(readRunManifest({ cwd, runId: "runFail" })).not.toHaveProperty("deliveredAt");
      expect(inputHandler?.(event, ctx)).toEqual({ action: "handled" });
      expect(messages.filter((m) => m.customType === "belayd-run-complete")).toHaveLength(1);
    } finally {
      chmodSync(runsDirPath, 0o700);
      warn.mockRestore();
    }
  });

  it("does not overwrite a user-recovered report when the child settles later", async () => {
    const { api, tools, messages, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeOrchestratorCtx(cwd);
    const start = tools.get("belayd_start_task");
    await start?.execute("call-start", { taskId: "bd-42" }, undefined, undefined, ctx);

    // Hold the child open so the run can be recovered before it settles.
    let resolveSpawn: (value: unknown) => void = () => {};
    mockSpawnAgentProcess.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const proof = tools.get("belayd_proof");
    await proof?.execute("call-proof", { task: "do proof" }, undefined, undefined, ctx);

    const { completeRunByUser, listRuns } = await import("../run-manifest.js");
    const run = listRuns({ cwd }).find((candidate) => candidate.phase === "proof");
    expect(run).toBeDefined();
    if (run === undefined) return;

    completeRunByUser({
      cwd,
      runId: run.runId,
      report: "USER_REPORT proof-of-work/bd-42/evidence.png",
    });
    const inputHandler = handlers.get("input")?.[0];
    expect(
      inputHandler?.(
        { type: "input", text: `[belayd-complete:${run.runId}]`, source: "extension" },
        ctx,
      ),
    ).toEqual({ action: "handled" });
    expect(messages.filter((m) => m.customType === "belayd-run-complete")).toHaveLength(1);

    // The still-running child now settles successfully with different output.
    resolveSpawn({
      content: [{ type: "text", text: "**Proof skipped:** config-only\nCHILD_OUTPUT" }],
      details: {
        messages: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
          toolCalls: 1,
        },
        exitCode: 0,
      },
    });

    // Poll until the watcher has released the active run. The watcher's
    // onPhaseComplete/persistStatus/deliver block is synchronous after
    // onSettled, so an empty active-runs list proves the settle was processed.
    await vi.waitFor(
      async () => {
        const status = await tools
          .get("belayd_status")
          ?.execute("call-status", {}, undefined, undefined, ctx);
        const text = (status as { content: Array<{ text: string }> }).content[0]?.text ?? "";
        expect(text).toContain("(none)");
      },
      { timeout: 5_000 },
    );

    // The proof verifier consumes state.proofOutput: it must see the recovered
    // report, not the late child output.
    mockSpawnAgentProcess.mockResolvedValueOnce({
      content: [{ type: "text", text: "verdict" }],
      details: {
        messages: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
          toolCalls: 1,
        },
        exitCode: 0,
      },
    });
    await tools
      .get("belayd_proof_verifier")
      ?.execute("call-verifier", {}, undefined, undefined, ctx);
    const callCount = mockSpawnAgentProcess.mock.calls.length;
    const verifierCall = mockSpawnAgentProcess.mock.calls[callCount - 1]?.[0] as
      | { task?: string }
      | undefined;
    expect(verifierCall?.task).toContain("USER_REPORT");
    expect(verifierCall?.task).not.toContain("CHILD_OUTPUT");
  });

  it("delivers the user report when the child settles before the sentinel", async () => {
    const { api, tools, messages, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeOrchestratorCtx(cwd);
    const start = tools.get("belayd_start_task");
    await start?.execute("call-start", { taskId: "bd-42" }, undefined, undefined, ctx);

    let resolveSpawn: (value: unknown) => void = () => {};
    mockSpawnAgentProcess.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const proof = tools.get("belayd_proof");
    await proof?.execute("call-proof", { task: "do proof" }, undefined, undefined, ctx);

    const { completeRunByUser, listRuns } = await import("../run-manifest.js");
    const run = listRuns({ cwd }).find((candidate) => candidate.phase === "proof");
    expect(run).toBeDefined();
    if (run === undefined) return;

    // The user recovers the still-running run, but the daemon sentinel has not
    // arrived yet — the reverse of the late-settle order.
    completeRunByUser({ cwd, runId: run.runId, report: "USER_REPORT recovered answer" });

    // The child settles first, with output that would pass the proof gate and
    // therefore reach `deliver` if the guards were missing.
    resolveSpawn({
      content: [{ type: "text", text: "**Proof skipped:** config-only\nCHILD_OUTPUT" }],
      details: {
        messages: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
          toolCalls: 1,
        },
        exitCode: 0,
      },
    });

    // Wait until the watcher has processed the settle (active runs released).
    await vi.waitFor(
      async () => {
        const status = await tools
          .get("belayd_status")
          ?.execute("call-status", {}, undefined, undefined, ctx);
        const text = (status as { content: Array<{ text: string }> }).content[0]?.text ?? "";
        expect(text).toContain("(none)");
      },
      { timeout: 5_000 },
    );

    // (a) The watcher must not deliver the child's raw output.
    expect(messages.filter((m) => m.customType === "belayd-run-complete")).toHaveLength(0);

    // The sentinel reconcile then owns delivery.
    const inputHandler = handlers.get("input")?.[0];
    expect(
      inputHandler?.(
        { type: "input", text: `[belayd-complete:${run.runId}]`, source: "extension" },
        ctx,
      ),
    ).toEqual({ action: "handled" });

    // (b) Exactly one follow-up, carrying the user's recovered report.
    const delivered = messages.filter((m) => m.customType === "belayd-run-complete");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.content).toContain("USER_REPORT");
    expect(delivered[0]?.content).not.toContain("CHILD_OUTPUT");

    // (c) The phase is marked complete so the gate can advance.
    const finalStatus = await tools
      .get("belayd_status")
      ?.execute("call-status", {}, undefined, undefined, ctx);
    const finalText = (finalStatus as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(finalText).toContain("✅ `belayd_proof` — proof");
  });
});
