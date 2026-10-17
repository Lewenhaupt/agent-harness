/**
 * Extension-level wiring for bd-116 model telemetry.
 *
 * Asserts that a phase run merges its rows into the persisted
 * `.belayd/telemetry.json` (rather than overwriting a prior workflow's rows)
 * and that the run manifest carries a per-run telemetry delta.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the extension's persistent cooldown store from the real user file.
process.env.BELAYD_MODEL_COOLDOWN_FILE = join(
  tmpdir(),
  "belayd-test-model-telemetry-cooldowns.json",
);

const mockSpawnAgentProcess = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    content: [{ type: "text" as const, text: "done" }],
    details: {
      messages: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.02,
        turns: 1,
        toolCalls: 1,
      },
      exitCode: 0,
      model: "opencode-go/mimo-v2.5",
    },
    sessionName: "mocked",
  }),
);

vi.mock("../spawn.js", () => ({
  spawnAgentProcess: mockSpawnAgentProcess,
}));

// `bd show` and git go through execFile; fail them so workflow resolution is
// offline and deterministic.
const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => ({
      stdin: {
        on: () => {},
        end: () => callback(new Error("execFile not available in test"), "", ""),
      },
    }),
  ),
);

const mockExec = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => callback(new Error("exec not available in test"), { stdout: "", stderr: "" }),
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: mockExec, execFile: mockExecFile };
});

const mockHttpRequest = vi.hoisted(() =>
  vi.fn((_opts: unknown, callback: (response: unknown) => void) => {
    callback({
      statusCode: 200,
      on: (event: string, handler: (chunk: string) => void) => {
        if (event === "data") handler(JSON.stringify({ sessions: [] }));
        if (event === "end") handler("");
      },
    });
    return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  }),
);

vi.mock("node:http", () => ({ request: mockHttpRequest }));

import { readModelTelemetry, writeModelTelemetry } from "../model-telemetry.js";
import { listRuns } from "../run-manifest.js";

/** Minimal synchronous event bus mirroring pi's per-load-batch bus. */
function createMockEventBus(): {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
} {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set<(data: unknown) => void>();
      set.add(handler);
      listeners.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
  };
}

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  messages: Array<{ customType: string }>;
  eventHandlers: Map<string, (...args: unknown[]) => void>;
}

function createMockPi(): MockPi {
  const tools = new Map<
    string,
    { name: string; execute: (...args: unknown[]) => Promise<unknown> }
  >();
  const messages: Array<{ customType: string }> = [];
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  let activeTools: string[] = [];
  const eventBus = createMockEventBus();

  const api: ExtensionAPI = {
    registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(def.name, def);
    },
    registerCommand: () => {},
    on: (event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers.set(event, handler);
    },
    sendMessage: (msg: { customType: string }) => {
      messages.push(msg);
    },
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => {
      activeTools = next;
    },
    events: eventBus,
  } as unknown as ExtensionAPI;

  return { api, tools, messages, eventHandlers };
}

async function loadExtension() {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

interface MockCtx {
  sessionManager: {
    getSessionId: () => string;
    getSessionName: () => string;
    getSessionFile: () => string | undefined;
  };
  cwd: string;
}

function createCtx(cwd: string): MockCtx {
  return {
    sessionManager: {
      getSessionId: () => "test-session-id",
      getSessionName: () => "belayd-orchestrator",
      getSessionFile: () => undefined,
    },
    cwd,
  };
}

/**
 * Load the extension, fire session_start to flush+reset the module-level
 * telemetry store, then delete the flushed file so the test starts clean.
 */
async function bootClean(cwd: string): Promise<MockPi & { ctx: MockCtx }> {
  const pi = createMockPi();
  const factory = await loadExtension();
  factory(pi.api);
  const ctx = createCtx(cwd);
  pi.eventHandlers.get("session_start")?.({}, ctx);
  rmSync(join(cwd, ".belayd"), { recursive: true, force: true });
  return { ...pi, ctx };
}

function runCompletionCount(messages: Array<{ customType: string }>): number {
  return messages.filter((m) => m.customType === "belayd-run-complete").length;
}

describe("extension model telemetry (bd-116)", () => {
  let cwd = "";

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-telemetry-ext-"));
    mockSpawnAgentProcess.mockClear();
  });

  afterEach(() => {
    if (cwd !== "") {
      rmSync(cwd, { recursive: true, force: true });
      cwd = "";
    }
  });

  it("merges a phase run's rows into an existing telemetry file and records a per-run delta", async () => {
    const { tools, messages, ctx } = await bootClean(cwd);

    // A prior workflow's row already on disk (as after an orchestrator restart).
    writeModelTelemetry({
      cwd,
      stats: [
        {
          phase: "plan",
          model: "prior/workflow-model",
          attempts: 1,
          fallbacks: 0,
          quotaFailures: 0,
          noOps: 0,
          cost: 0.01,
        },
      ],
      totals: { attempts: 1, fallbacks: 0, quotaFailures: 0, noOps: 0, cost: 0.01 },
    });

    const startTask = tools.get("belayd_start_task");
    await startTask?.execute(
      "call-1",
      { taskId: "bd-116", workflowType: "chore" },
      undefined,
      undefined,
      ctx,
    );

    const before = runCompletionCount(messages);
    await tools.get("belayd_plan")?.execute("call-2", { task: "plan" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });

    const snapshot = readModelTelemetry({ cwd });
    expect(snapshot).toBeDefined();
    // The prior workflow's row survives the append (C1).
    expect(snapshot?.stats.some((row) => row.model === "prior/workflow-model")).toBe(true);
    // This run's own row is present.
    expect(snapshot?.stats.some((row) => row.phase === "plan")).toBe(true);

    // The manifest records the run's delta, not the process-cumulative total.
    const planRun = listRuns({ cwd }).find((run) => run.phase === "plan");
    expect(planRun?.telemetry).toBeDefined();
    expect(planRun?.telemetry?.attempts).toBeGreaterThanOrEqual(1);
  });

  it("settles twice in one workflow without duplicating earlier telemetry rows", async () => {
    const { tools, messages, ctx } = await bootClean(cwd);

    const startTask = tools.get("belayd_start_task");
    await startTask?.execute(
      "call-1",
      { taskId: "bd-116", workflowType: "chore" },
      undefined,
      undefined,
      ctx,
    );

    const plan = tools.get("belayd_plan");
    for (let index = 0; index < 2; index += 1) {
      const before = runCompletionCount(messages);
      await plan?.execute(`call-plan-${index}`, { task: "plan" }, undefined, undefined, ctx);
      await vi.waitFor(() => {
        expect(runCompletionCount(messages)).toBe(before + 1);
      });
    }

    // Two settles of one attempt each must persist as 2, not 1 + 2 = 3.
    const snapshot = readModelTelemetry({ cwd });
    expect(snapshot?.totals.attempts).toBe(2);
    const planRows = snapshot?.stats.filter((row) => row.phase === "plan") ?? [];
    expect(planRows).toHaveLength(1);
    expect(planRows[0]?.attempts).toBe(2);
  });
});
