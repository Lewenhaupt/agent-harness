/**
 * Tests for session naming in the Belayd extension (bd-10).
 *
 * Covers:
 * - Phase tool session naming via computeSubagentSessionName + generateShortRunId wiring
 * - compactTaskSessions prefix matching logic (triggered via agent_end)
 * - runQualityGate multi-retry naming (via phase with quality gate)
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listRuns,
  RunStatus,
  readRunManifest,
  scanForInterruptedRuns,
  writeRunManifest,
} from "../run-manifest.js";
import {
  readWorkflowState as readWorkflowStateFromDisk,
  type WorkflowState,
  workflowStateFilePath,
  writeWorkflowState,
} from "../workflow-state.js";

const FEATURE_PHASES = [
  "scout",
  "plan",
  "implement",
  "review",
  "test",
  "userguide",
  "proof",
  "commit",
] as const;

// Isolate the extension's persistent cooldown store from the real user file. A
// live pi-web quota cooldown in ~/.pi/agent/model-cooldowns.json would leak
// into these tests and reorder the fallback loop's candidates.
process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock spawnAgentProcess so phase tools return deterministically without spawning
const mockSpawnAgentProcess = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    content: [{ type: "text" as const, text: "done" }],
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

// Mock node:child_process exec so quality gates fail deterministically
// (gateFullValidation shells out to pnpm typecheck/lint/test)
const mockExec = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(new Error("pnpm not found in test environment"), { stdout: "", stderr: "Command failed" });
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: mockExec,
  };
});

// Mock node:http for daemonRequest
// Provides a controlled response queue so each test can set expected data
const mockRequestResponses = vi.hoisted(() => {
  const responses: Array<{
    statusCode: number;
    data: string;
  }> = [];
  return {
    responses,
    addResponse: (statusCode: number, data: string) => {
      responses.push({ statusCode, data });
    },
    clear: () => {
      responses.length = 0;
    },
  };
});

const mockHttpRequest = vi.hoisted(() => {
  // Default response for GET /sessions — reused for each phase
  let defaultSessionsResponse = JSON.stringify({ sessions: [] });
  const mock = vi
    .fn()
    .mockImplementation(
      (
        opts: Record<string, unknown>,
        callback: (res: {
          statusCode: number;
          on: (event: string, handler: (chunk: string) => void) => void;
        }) => void,
      ) => {
        // Use queued response if available, otherwise use default
        let response = mockRequestResponses.responses.shift();
        if (!response) {
          // For GET /sessions, use the default sessions list
          // For other requests, return empty JSON
          response = {
            statusCode: 200,
            data: opts.method === "GET" ? defaultSessionsResponse : "{}",
          };
        }
        callback({
          statusCode: response.statusCode,
          on: vi.fn((event: string, handler: (chunk: string) => void) => {
            if (event === "data") {
              handler(response.data);
            }
            if (event === "end") {
              handler("");
            }
          }),
        });
        const req = {
          on: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
        };
        return req;
      },
    );
  // Allow tests to set the default sessions response
  (mock as unknown as { _setDefaultSessions: (data: string) => void })._setDefaultSessions = (
    data: string,
  ) => {
    defaultSessionsResponse = data;
  };
  return mock;
});

vi.mock("node:http", () => ({
  request: mockHttpRequest,
}));

// ── Mock pi API ───────────────────────────────────────────────────────

/** Minimal synchronous event bus mirroring pi's per-load-batch EventEmitter bus. */
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

function createMockPi(sharedBus?: ReturnType<typeof createMockEventBus>): {
  api: ExtensionAPI;
  tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  commands: Map<string, unknown>;
  eventHandlers: Map<string, (...args: unknown[]) => void>;
  messages: Array<{
    customType: string;
    content: string;
    display: boolean;
    details?: Record<string, unknown>;
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }>;
  activeTools: string[];
} {
  const tools = new Map<
    string,
    { name: string; execute: (...args: unknown[]) => Promise<unknown> }
  >();
  const commands = new Map<string, unknown>();
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  const messages: Array<{
    customType: string;
    content: string;
    display: boolean;
    details?: Record<string, unknown>;
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }> = [];
  let activeTools: string[] = [];
  const eventBus = sharedBus ?? createMockEventBus();

  const api: ExtensionAPI = {
    registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(def.name, def);
    },
    registerCommand: (
      name: string,
      cmd: { description: string; handler: (...args: unknown[]) => void },
    ) => {
      commands.set(name, cmd);
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers.set(event, handler);
    },
    sendMessage: (
      msg: {
        customType: string;
        content: string;
        display: boolean;
        details?: Record<string, unknown>;
      },
      opts?: { triggerTurn?: boolean; deliverAs?: string },
    ) => {
      messages.push({ ...msg, options: opts });
    },
    getActiveTools: () => activeTools,
    setActiveTools: (toolsList: string[]) => {
      activeTools = toolsList;
    },
    events: eventBus,
  } as unknown as ExtensionAPI;

  return { api, tools, commands, eventHandlers, messages, activeTools };
}

function createMockCtx(overrides?: Partial<{ sessionId: string; cwd: string }>): {
  sessionManager: { getSessionId: () => string };
  cwd: string;
} {
  return {
    sessionManager: {
      getSessionId: () => overrides?.sessionId ?? "test-session-id",
    },
    cwd: overrides?.cwd ?? "/tmp/test",
  };
}

async function loadExtension() {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

// ── Non-blocking run helpers (bd-41) ───────────────────────────────────

/** Count delivered run-completion follow-ups in the mock pi message log. */
function runCompletionCount(messages: Array<{ customType: string }>): number {
  return messages.filter((m) => m.customType === "belayd-run-complete").length;
}

/** Run one phase tool and wait until its background run has delivered. */
async function runPhaseToolAndWait(
  tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>,
  toolName: string,
  messages: Array<{ customType: string }>,
  ctx: { sessionManager: { getSessionId: () => string }; cwd: string },
): Promise<void> {
  const before = runCompletionCount(messages);
  const tool = tools.get(toolName);
  expect(tool).toBeDefined();
  await tool?.execute(`call-${toolName}`, { task: `do ${toolName}` }, undefined, undefined, ctx);
  await vi.waitFor(() => {
    expect(runCompletionCount(messages)).toBe(before + 1);
  });
}

/** Make node:child_process.exec succeed so the commit tool can finish. */
function setExecToSucceed(): void {
  mockExec.mockImplementation(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: "[abc1234] commit done", stderr: "" });
    },
  );
}

/** Restore the default failing exec used by most tests. */
function setExecToFail(): void {
  mockExec.mockImplementation(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(new Error("pnpm not found in test environment"), {
        stdout: "",
        stderr: "Command failed",
      });
    },
  );
}

/** Run the commit tool to completion with exec succeeding. */
async function runCommitTool(
  tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>,
  ctx: { sessionManager: { getSessionId: () => string }; cwd: string },
): Promise<void> {
  const commit = tools.get("belayd_commit");
  expect(commit).toBeDefined();
  setExecToSucceed();
  try {
    await commit?.execute("call-commit", { message: "feat: done" }, undefined, undefined, ctx);
  } finally {
    setExecToFail();
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("extension session naming (bd-10)", () => {
  afterEach(() => {
    mockSpawnAgentProcess.mockClear();
    mockHttpRequest.mockClear();
    mockExec.mockClear();
    setExecToFail();
    mockRequestResponses.clear();
    // Reset default sessions response to empty
    (
      mockHttpRequest as unknown as {
        _setDefaultSessions: (data: string) => void;
      }
    )._setDefaultSessions(JSON.stringify({ sessions: [] }));
  });

  describe("phase tool session naming", () => {
    it("passes sessionName matching belayd-bd-42-scout-<runId> to spawnAgentProcess", async () => {
      const { api, tools } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Activate the gate with bd-42
      const startTask = tools.get("belayd_start_task");
      expect(startTask).toBeDefined();

      await startTask?.execute(
        "call-1",
        { taskId: "bd-42" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Execute the scout tool
      const scout = tools.get("belayd_scout");
      expect(scout).toBeDefined();
      await scout?.execute(
        "call-2",
        { task: "investigate" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // The spawn now happens in the background (non-blocking run).
      await vi.waitFor(() => {
        expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
      });
      const options = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(options.sessionName).toBeTruthy();
      expect(options.sessionName).toMatch(/^belayd-bd-42-sub-scout-/);
    });

    it("passes different sessionNames for different phases", async () => {
      const { api, tools } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Activate gate with research workflow (fewer phases)
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-99", workflowType: "research" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Execute scout
      const scout = tools.get("belayd_scout");
      await scout?.execute("call-2", { task: "scout" }, undefined, undefined, createMockCtx());

      // Execute plan
      const plan = tools.get("belayd_plan");
      await plan?.execute("call-3", { task: "plan" }, undefined, undefined, createMockCtx());

      // Both spawns run in the background once their phase tools return.
      await vi.waitFor(() => {
        expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(2);
      });

      const scoutOptions = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
      const planOptions = mockSpawnAgentProcess.mock.calls[1]?.[0] as Record<string, unknown>;

      expect(scoutOptions.sessionName).toMatch(/^belayd-bd-99-sub-scout-/);
      expect(planOptions.sessionName).toMatch(/^belayd-bd-99-sub-plan-/);
      expect(scoutOptions.sessionName).not.toBe(planOptions.sessionName);
    });
  });

  describe("compactTaskSessions", () => {
    it("compacts matching sessions on agent_end when workflow complete", async () => {
      const { api, tools, eventHandlers, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Set up mock responses for the daemon:
      // GET /sessions → returns a list with matching and non-matching sessions
      (
        mockHttpRequest as unknown as {
          _setDefaultSessions: (data: string) => void;
        }
      )._setDefaultSessions(
        JSON.stringify({
          sessions: [
            { id: "sess-1", name: "belayd-bd-42-sub-scout-a1b2" },
            { id: "sess-2", name: "belayd-bd-42-sub-scout-x9y8" },
            { id: "sess-3", name: "belayd-bd-42-sub-plan-z3z4" },
            { id: "sess-4", name: "other-session" },
            { id: "sess-5", name: undefined },
            { id: "sess-6" },
          ],
        }),
      );

      // Activate a short research workflow (scout → plan → commit) so phases
      // complete via real background runs instead of tool_call marks.
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-42", workflowType: "research" },
        undefined,
        undefined,
        createMockCtx(),
      );

      const ctx = createMockCtx();
      await runPhaseToolAndWait(tools, "belayd_scout", messages, ctx);
      await runPhaseToolAndWait(tools, "belayd_plan", messages, ctx);
      await runCommitTool(tools, ctx);

      // Trigger agent_end
      const agentEndHandler = eventHandlers.get("agent_end");
      expect(agentEndHandler).toBeDefined();
      await agentEndHandler?.({}, ctx);

      // Verify: GET /sessions was called
      const getCall = mockHttpRequest.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).method === "GET",
      );
      expect(getCall).toBeDefined();

      // Verify: POST /sessions/sess-1/compact and /sessions/sess-2/compact were called.
      const compactCalls = mockHttpRequest.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).method === "POST" &&
          (call[0] as Record<string, unknown>).path?.toString().includes("/compact"),
      );
      // scout matches sess-1 + sess-2, plan matches sess-3, commit matches none.
      expect(compactCalls.length).toBeGreaterThanOrEqual(3);
    });

    it("handles empty sessions list gracefully", async () => {
      const { api, tools, eventHandlers, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Mock response: empty sessions list
      mockRequestResponses.addResponse(200, JSON.stringify({ sessions: [] }));

      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-1", workflowType: "research" },
        undefined,
        undefined,
        createMockCtx(),
      );

      const ctx = createMockCtx();
      await runPhaseToolAndWait(tools, "belayd_scout", messages, ctx);
      await runPhaseToolAndWait(tools, "belayd_plan", messages, ctx);
      await runCommitTool(tools, ctx);

      const agentEndHandler = eventHandlers.get("agent_end");
      await agentEndHandler?.({}, ctx);

      // Should not throw even with empty sessions
      expect(true).toBe(true);
    });

    it("handles missing sessions field gracefully", async () => {
      const { api, tools, eventHandlers, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Mock response: no sessions field
      mockRequestResponses.addResponse(200, JSON.stringify({}));

      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-1", workflowType: "research" },
        undefined,
        undefined,
        createMockCtx(),
      );

      const ctx = createMockCtx();
      await runPhaseToolAndWait(tools, "belayd_scout", messages, ctx);
      await runPhaseToolAndWait(tools, "belayd_plan", messages, ctx);
      await runCommitTool(tools, ctx);

      const agentEndHandler = eventHandlers.get("agent_end");
      await agentEndHandler?.({}, ctx);

      // Should not throw even without sessions field
      expect(true).toBe(true);
    });

    it("does not call compactTaskSessions when gate is not active", async () => {
      const { api, eventHandlers } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Trigger agent_end without activating the gate
      const agentEndHandler = eventHandlers.get("agent_end");
      await agentEndHandler?.({}, createMockCtx());

      // No HTTP requests to daemon should have been made
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });

  describe("runQualityGate retry naming", () => {
    it("retries multiple times with unique -retry-N suffixes when the gate keeps failing", async () => {
      const { api, tools } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Activate gate with chore workflow
      // chore workflow: [plan, implement, test, commit]
      // implement has agentOverrides.implement.qualityGate = gateFullValidation
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-50", workflowType: "chore" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Execute implement tool — its gate retries now run in the background.
      const implement = tools.get("belayd_implement");
      await implement?.execute(
        "call-2",
        { task: "implement" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // The quality gate (gateFullValidation) shells out to pnpm via exec.
      // Since we mocked exec to fail, the gate keeps failing, so the harness
      // retries until MAX_GATE_ATTEMPTS (10) passes: 1 initial + 9 retries.
      await vi.waitFor(() => {
        const retryCalls = mockSpawnAgentProcess.mock.calls.filter((call: unknown[]) => {
          const opts = call[0] as Record<string, unknown>;
          return typeof opts.sessionName === "string" && opts.sessionName.includes("-retry-");
        });
        expect(retryCalls).toHaveLength(9);
      });

      const retryCalls = mockSpawnAgentProcess.mock.calls.filter((call: unknown[]) => {
        const opts = call[0] as Record<string, unknown>;
        return typeof opts.sessionName === "string" && opts.sessionName.includes("-retry-");
      });
      const names = retryCalls.map(
        (call: unknown[]) => (call[0] as Record<string, unknown>).sessionName as string,
      );
      expect(new Set(names).size).toBe(9);
      expect(names[0]).toMatch(/^belayd-bd-50-sub-implement-.+-retry-1$/);
      expect(names[8]).toMatch(/^belayd-bd-50-sub-implement-.+-retry-9$/);
    });
  });

  describe("userGuideContent lifecycle", () => {
    afterEach(() => {
      mockSpawnAgentProcess.mockReset();
      // Restore default mock behavior for other tests
      mockSpawnAgentProcess.mockResolvedValue({
        content: [{ type: "text" as const, text: "done" }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 0,
        },
        sessionName: "mocked",
      });
    });

    it("captures userGuideContent when userguide phase executes and gate passes", async () => {
      // Mock spawnAgentProcess to return content that passes gateUserGuide
      const validUserGuide = [
        "## How to Verify",
        "1. Run `pnpm test`",
        "2. Check the output",
        "",
        "## How to Use",
        "```typescript",
        'import { foo } from "./bar";',
        "foo();",
        "```",
        "x".repeat(200),
      ].join("\n");

      mockSpawnAgentProcess.mockResolvedValue({
        content: [{ type: "text" as const, text: validUserGuide }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 0,
        },
        sessionName: "mocked-userguide",
      });

      const { api, tools, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Activate gate with feature workflow
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-77" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Execute the userguide tool and wait for its background run to finish.
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, createMockCtx());

      // Now call commit with the taskId — if userGuideContent is set,
      // commit will try to write a notes file and call bd note.
      // Since exec is mocked to fail, we check that something attempted exec.
      const commit = tools.get("belayd_commit");
      expect(commit).toBeDefined();

      mockExec.mockClear();
      await commit?.execute(
        "call-commit",
        {
          message: "feat: add feature (bd-77)",
          taskId: "bd-77",
        },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Verify that exec attempted the human-review flag and the note append.
      const updateCalls = mockExec.mock.calls.filter((call: unknown[]) => {
        const cmd = call[0] as string;
        return cmd === "bd update bd-77 --status in_progress --add-label human";
      });
      const noteCalls = mockExec.mock.calls.filter((call: unknown[]) => {
        const cmd = call[0] as string;
        return cmd.startsWith("bd note bd-77 --file ");
      });

      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
      expect(noteCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("clears userGuideContent on gate activation (belayd_start_task)", async () => {
      const validUserGuide = [
        "## How to Verify",
        "1. Run tests",
        "",
        "## How to Use",
        "Call the function",
        "x".repeat(200),
      ].join("\n");

      mockSpawnAgentProcess.mockResolvedValue({
        content: [{ type: "text" as const, text: validUserGuide }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 0,
        },
        sessionName: "mocked-userguide",
      });

      const { api, tools, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Start first task
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-77" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Complete userguide in the background before starting the next task.
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, createMockCtx());

      // Start a new task — this should clear userGuideContent
      mockExec.mockClear();
      await startTask?.execute(
        "call-2",
        { taskId: "bd-88" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Now call commit with the second taskId
      const commit = tools.get("belayd_commit");
      mockExec.mockClear();
      await commit?.execute(
        "call-commit",
        {
          message: "feat: other (bd-88)",
          taskId: "bd-88",
        },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Since userGuideContent was cleared, no bd note call should happen
      const noteCalls = mockExec.mock.calls.filter((call: unknown[]) => {
        const cmd = call[0] as string;
        return cmd.startsWith("bd note ");
      });

      expect(noteCalls).toHaveLength(0);
    });

    it("clears userGuideContent on belayd_stop_task", async () => {
      const validUserGuide = [
        "## How to Verify",
        "1. Run tests",
        "",
        "## How to Use",
        "Call the function",
        "x".repeat(200),
      ].join("\n");

      mockSpawnAgentProcess.mockResolvedValue({
        content: [{ type: "text" as const, text: validUserGuide }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 0,
        },
        sessionName: "mocked-userguide",
      });

      const { api, tools, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Start task
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-77" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Complete userguide in the background before stopping the task.
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, createMockCtx());

      // Stop the task — this should clear userGuideContent
      const stopTask = tools.get("belayd_stop_task");
      expect(stopTask).toBeDefined();

      await stopTask?.execute("call-stop", {}, undefined, undefined, createMockCtx());

      // Start a new task and commit — no append-notes should happen
      await startTask?.execute(
        "call-2",
        { taskId: "bd-88" },
        undefined,
        undefined,
        createMockCtx(),
      );

      const commit = tools.get("belayd_commit");
      mockExec.mockClear();
      await commit?.execute(
        "call-commit",
        {
          message: "feat: other (bd-88)",
          taskId: "bd-88",
        },
        undefined,
        undefined,
        createMockCtx(),
      );

      const noteCalls = mockExec.mock.calls.filter((call: unknown[]) => {
        const cmd = call[0] as string;
        return cmd.startsWith("bd note ");
      });

      expect(noteCalls).toHaveLength(0);
    });

    it("overwrites userGuideContent when userguide phase runs twice", async () => {
      const firstGuide = [
        "## How to Verify",
        "Version 1",
        "",
        "## How to Use",
        "Old API",
        "x".repeat(200),
      ].join("\n");

      const secondGuide = [
        "## How to Verify",
        "Version 2",
        "",
        "## How to Use",
        "New API",
        "x".repeat(200),
      ].join("\n");

      // First call returns firstGuide, second call returns secondGuide
      mockSpawnAgentProcess
        .mockResolvedValueOnce({
          content: [{ type: "text" as const, text: firstGuide }],
          details: {
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            exitCode: 0,
          },
          sessionName: "mocked-ug-1",
        })
        .mockResolvedValueOnce({
          content: [{ type: "text" as const, text: secondGuide }],
          details: {
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            exitCode: 0,
          },
          sessionName: "mocked-ug-2",
        });

      const { api, tools, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Start task
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-77" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Execute userguide twice; the second background run overwrites the first.
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, createMockCtx());
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, createMockCtx());

      // Now call commit with taskId — should use the second (overwritten) content
      const commit = tools.get("belayd_commit");
      mockExec.mockClear();
      await commit?.execute(
        "call-commit",
        {
          message: "feat: add feature (bd-77)",
          taskId: "bd-77",
        },
        undefined,
        undefined,
        createMockCtx(),
      );

      // The commit appends the user guide content via bd note.
      const noteCalls = mockExec.mock.calls.filter((call: unknown[]) => {
        const cmd = call[0] as string;
        return cmd.startsWith("bd note bd-77 --file ");
      });

      expect(noteCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("handles userguide-only session with no commit gracefully", async () => {
      const validUserGuide = [
        "## How to Verify",
        "1. Check it",
        "",
        "## How to Use",
        "Just do it",
        "x".repeat(200),
      ].join("\n");

      mockSpawnAgentProcess.mockResolvedValue({
        content: [{ type: "text" as const, text: validUserGuide }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 0,
        },
        sessionName: "mocked-userguide",
      });

      const { api, tools, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Start task and complete up to userguide, then stop (no commit)
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-99" },
        undefined,
        undefined,
        createMockCtx(),
      );

      await runPhaseToolAndWait(tools, "belayd_userguide", messages, createMockCtx());

      // Stop without committing
      const stopTask = tools.get("belayd_stop_task");
      await stopTask?.execute("call-stop", {}, undefined, undefined, createMockCtx());

      // No execute should fail, no crash should occur
      expect(true).toBe(true);
    });
  });
});

describe("non-blocking phase runs (bd-41)", () => {
  afterEach(() => {
    mockSpawnAgentProcess.mockReset();
    mockSpawnAgentProcess.mockResolvedValue({
      content: [{ type: "text" as const, text: "done" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: "mocked",
    });
    setExecToFail();
  });

  it("phase tool returns immediately and delivers a follow-up with run details", async () => {
    const { api, tools, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    await tools
      .get("belayd_start_task")
      ?.execute(
        "start",
        { taskId: "bd-42", workflowType: "research" },
        undefined,
        undefined,
        createMockCtx(),
      );

    const result = (await tools
      .get("belayd_scout")
      ?.execute("scout", { task: "investigate" }, undefined, undefined, createMockCtx())) as {
      content: Array<{ type: string; text: string }>;
      details: { exitCode: number };
    };

    // Non-blocking: the tool resolves with a "started" message, not the spawn result.
    expect(result.details.exitCode).toBe(0);
    expect(result.content[0]?.text).toContain("run started in the background");
    expect(result.content[0]?.text).toContain("Run ID:");
    expect(result.content[0]?.text).toContain("belayd_status");

    await vi.waitFor(() => {
      const completion = messages.find((m) => m.customType === "belayd-run-complete");
      expect(completion).toBeDefined();
    });

    const completion = messages.find((m) => m.customType === "belayd-run-complete");
    expect(completion).toHaveProperty("options.deliverAs", "followUp");
    expect(completion).toHaveProperty("options.triggerTurn", true);
    expect(completion).toHaveProperty("details.runId");
    expect(completion).toHaveProperty("details.phaseName", "scout");
    expect(completion).toHaveProperty("details.taskId", "bd-42");
    expect(completion).toHaveProperty("details.exitCode", 0);
  });

  it("blocks a second phase tool while a run is in flight, then allows it after the run settles", async () => {
    const { api, tools, eventHandlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    await tools
      .get("belayd_start_task")
      ?.execute(
        "start",
        { taskId: "bd-42", workflowType: "research" },
        undefined,
        undefined,
        createMockCtx(),
      );

    // Hold the scout run open so it stays in state.activeRuns.
    let resolveScout: (value: unknown) => void = () => {};
    mockSpawnAgentProcess.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveScout = resolve;
      }),
    );

    await tools
      .get("belayd_scout")
      ?.execute("scout", { task: "investigate" }, undefined, undefined, createMockCtx());

    const handler = eventHandlers.get("tool_call");
    expect(handler).toBeDefined();

    const abortInFlight = vi.fn();
    const block = handler?.(
      { toolName: "belayd_plan", abort: abortInFlight },
      createMockCtx(),
    ) as unknown as {
      block?: boolean;
      reason?: string;
    };

    expect(block).toHaveProperty("block", true);
    expect(block.reason).toContain("belayd_status");
    expect(abortInFlight).toHaveBeenCalledWith(
      "phase-run-in-flight",
      expect.stringContaining("belayd_status"),
    );

    // Let the held run finish; its watcher releases activeRuns and marks scout
    // completed, so the next phase tool must now be allowed.
    resolveScout({
      content: [{ type: "text" as const, text: "scout done" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: "mocked-scout",
    });
    await vi.waitFor(() => {
      const abortAfterSettle = vi.fn();
      const next = handler?.(
        { toolName: "belayd_plan", abort: abortAfterSettle },
        createMockCtx(),
      ) as unknown as { block?: boolean; reason?: string };
      expect(next).not.toHaveProperty("block");
      expect(abortAfterSettle).not.toHaveBeenCalled();
    });
  });

  it("a failed phase run lets the next phase proceed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "belayd-failrun-"));
    try {
      const { api, tools, eventHandlers } = createMockPi();
      const factory = await loadExtension();
      factory(api);
      const ctx = createMockCtx({ sessionId: `failrun-${Date.now()}`, cwd });

      await tools
        .get("belayd_start_task")
        ?.execute(
          "start",
          { taskId: "bd-42", workflowType: "research" },
          undefined,
          undefined,
          ctx,
        );

      mockSpawnAgentProcess.mockResolvedValueOnce({
        content: [{ type: "text" as const, text: "scout crashed" }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 1,
        },
        sessionName: "mocked-scout",
      });

      await tools
        .get("belayd_scout")
        ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

      await vi.waitFor(() => {
        const runs = listRuns({ cwd });
        expect(runs).toHaveLength(1);
        expect(runs[0]).toHaveProperty("status", "failed");
      });

      const abort = vi.fn();
      const handler = eventHandlers.get("tool_call");
      expect(handler).toBeDefined();
      const result = handler?.({ toolName: "belayd_plan", abort }, ctx) as unknown as {
        block?: boolean;
        reason?: string;
      };

      // The deadlock is gone: even though scout failed, the in-flight gate must
      // not block a later phase tool with phase-run-in-flight.
      expect(abort).not.toHaveBeenCalledWith("phase-run-in-flight", expect.anything());
      expect(result.reason ?? "").not.toContain("in progress");

      // A failed run must not persist its phase as completed.
      const persisted = readWorkflowStateFromDisk({ cwd });
      expect(persisted?.completedPhaseNames ?? []).not.toContain("scout");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("starting a new task aborts an in-flight run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "belayd-abort-"));
    try {
      const { api, tools } = createMockPi();
      const factory = await loadExtension();
      factory(api);
      const ctx = createMockCtx({ sessionId: `abort-${Date.now()}`, cwd });

      await tools
        .get("belayd_start_task")
        ?.execute(
          "start",
          { taskId: "bd-42", workflowType: "research" },
          undefined,
          undefined,
          ctx,
        );

      let releaseRun: (value: unknown) => void = () => {};
      mockSpawnAgentProcess.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseRun = resolve;
        }),
      );

      await tools
        .get("belayd_scout")
        ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

      await vi.waitFor(() => {
        expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
      });
      const options = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
      const capturedSignal = options.signal as AbortSignal | undefined;

      await tools
        .get("belayd_start_task")
        ?.execute(
          "start",
          { taskId: "bd-88", workflowType: "research" },
          undefined,
          undefined,
          ctx,
        );

      expect(capturedSignal?.aborted).toBe(true);

      // Release the held run so no dangling promise leaks out of the test.
      releaseRun({
        content: [{ type: "text" as const, text: "scout done" }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 0,
        },
        sessionName: "mocked-scout",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("bd/read are allowed while a run is in flight", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "belayd-gated-"));
    try {
      const { api, tools, eventHandlers } = createMockPi();
      const factory = await loadExtension();
      factory(api);
      const ctx = createMockCtx({ sessionId: `gated-${Date.now()}`, cwd });

      await tools
        .get("belayd_start_task")
        ?.execute(
          "start",
          { taskId: "bd-42", workflowType: "research" },
          undefined,
          undefined,
          ctx,
        );

      let releaseRun: (value: unknown) => void = () => {};
      mockSpawnAgentProcess.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseRun = resolve;
        }),
      );

      await tools
        .get("belayd_scout")
        ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

      const handler = eventHandlers.get("tool_call");
      expect(handler).toBeDefined();

      for (const toolName of ["bd", "read"]) {
        const abort = vi.fn();
        const result = handler?.({ toolName, abort }, ctx) as unknown as {
          block?: boolean;
          reason?: string;
        };
        expect(result).not.toHaveProperty("block");
        expect(abort).not.toHaveBeenCalled();
      }

      releaseRun({
        content: [{ type: "text" as const, text: "scout done" }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 0,
        },
        sessionName: "mocked-scout",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("belayd_status reports active runs and manifest history", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    await tools
      .get("belayd_start_task")
      ?.execute(
        "start",
        { taskId: "bd-42", workflowType: "research" },
        undefined,
        undefined,
        createMockCtx(),
      );

    // Hold scout open so it shows up in the active-runs section.
    let resolveScout: (value: unknown) => void = () => {};
    mockSpawnAgentProcess.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveScout = resolve;
      }),
    );
    await tools
      .get("belayd_scout")
      ?.execute("scout", { task: "investigate" }, undefined, undefined, createMockCtx());

    const status = (await tools
      .get("belayd_status")
      ?.execute("status", {}, undefined, undefined, createMockCtx())) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = status.content[0]?.text ?? "";
    expect(text).toContain("Active runs");
    expect(text).toContain("scout");

    resolveScout({
      content: [{ type: "text" as const, text: "scout done" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: "mocked-scout",
    });
    await vi.waitFor(() => {
      expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    });
  });

  it("belayd_status reports persisted run history after a run settles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "belayd-status-history-"));
    try {
      const { api, tools, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);
      const ctx = createMockCtx({ sessionId: `status-history-${Date.now()}`, cwd });

      await tools
        .get("belayd_start_task")
        ?.execute(
          "start",
          { taskId: "bd-42", workflowType: "research" },
          undefined,
          undefined,
          ctx,
        );

      await runPhaseToolAndWait(tools, "belayd_scout", messages, ctx);

      const completion = messages.find((m) => m.customType === "belayd-run-complete");
      expect(completion).toBeDefined();
      const runId = (completion?.details as { runId?: string } | undefined)?.runId;
      expect(runId).toBeTruthy();

      const status = (await tools
        .get("belayd_status")
        ?.execute("status", {}, undefined, undefined, ctx)) as {
        content: Array<{ type: string; text: string }>;
      };
      const text = status.content[0]?.text ?? "";

      // No run is in flight anymore: the active list must be empty.
      expect(text).toContain("Active runs");
      expect(text).toContain("(none)");

      // The settled run is listed in the manifest-backed history table.
      expect(text).toContain("Run history");
      expect(text).toContain("scout");
      expect(text).toContain("completed");
      if (runId !== undefined) {
        expect(text).toContain(runId);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a signal-killed run (exitCode 128) is failed, not phase-completed, and delivered exactly once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "belayd-signalkill-"));
    try {
      const { api, tools, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);
      const ctx = createMockCtx({ sessionId: `signalkill-${Date.now()}`, cwd });

      await tools
        .get("belayd_start_task")
        ?.execute(
          "start",
          { taskId: "bd-42", workflowType: "research" },
          undefined,
          undefined,
          ctx,
        );

      // collectSpawnResult maps a signal-killed child to exitCode 128; the
      // mocked spawn replays that settled result.
      mockSpawnAgentProcess.mockResolvedValueOnce({
        content: [{ type: "text" as const, text: "killed by signal" }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 128,
        },
        sessionName: "mocked-scout",
      });

      await tools
        .get("belayd_scout")
        ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

      await vi.waitFor(() => {
        const runs = listRuns({ cwd });
        expect(runs).toHaveLength(1);
        expect(runs[0]).toHaveProperty("status", "failed");
        expect(runs[0]).toHaveProperty("exitCode", 128);
      });

      // Exactly one failure follow-up is delivered for the runId, and no more
      // arrive after the watcher has fully settled.
      await vi.waitFor(() => {
        expect(runCompletionCount(messages)).toBe(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runCompletionCount(messages)).toBe(1);

      const completion = messages.find((m) => m.customType === "belayd-run-complete");
      expect(completion?.content).toContain("failed");
      expect(completion?.content).toContain("❌");
      expect(completion).toHaveProperty("details.exitCode", 128);

      // A signal-killed run must never mark its phase completed.
      const persisted = readWorkflowStateFromDisk({ cwd });
      expect(persisted?.completedPhaseNames ?? []).not.toContain("scout");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("an aborted in-flight run (task switch) neither delivers nor marks its phase complete", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "belayd-abort-nodeliver-"));
    try {
      const { api, tools, messages } = createMockPi();
      const factory = await loadExtension();
      factory(api);
      const ctx = createMockCtx({ sessionId: `abort-nodeliver-${Date.now()}`, cwd });

      await tools
        .get("belayd_start_task")
        ?.execute(
          "start",
          { taskId: "bd-42", workflowType: "research" },
          undefined,
          undefined,
          ctx,
        );

      let releaseScout: (value: unknown) => void = () => {};
      mockSpawnAgentProcess.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseScout = resolve;
        }),
      );
      await tools
        .get("belayd_scout")
        ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

      await vi.waitFor(() => {
        expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
      });

      // Starting a new task aborts and clears the in-flight run.
      await tools
        .get("belayd_start_task")
        ?.execute(
          "start-2",
          { taskId: "bd-88", workflowType: "research" },
          undefined,
          undefined,
          ctx,
        );

      // Release with a signal-killed shape: abort → SIGTERM → exitCode 128.
      releaseScout({
        content: [{ type: "text" as const, text: "aborted" }],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 128,
        },
        sessionName: "mocked-scout",
      });

      // The manifest stays "running": persistStatus was skipped because the
      // task switched, so the abandoned run is never recorded as completed.
      await vi.waitFor(() => {
        const runs = listRuns({ cwd });
        expect(runs).toHaveLength(1);
        expect(runs[0]).toHaveProperty("status", "running");
      });

      // bd-40 semantics: the next session start flips the stale "running"
      // manifest to "interrupted".
      const interrupted = scanForInterruptedRuns({ cwd });
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toHaveProperty("status", "interrupted");

      // Must NOT deliver a follow-up for the abandoned task.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runCompletionCount(messages)).toBe(0);

      // And scout must not leak into the new task's completed phase list.
      const persisted = readWorkflowStateFromDisk({ cwd });
      expect(persisted).toHaveProperty("taskId", "bd-88");
      expect(persisted?.completedPhaseNames ?? []).not.toContain("scout");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("belayd_commit file staging", () => {
  function stagedGitAddCommands(): string[] {
    return mockExec.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .filter((cmd) => cmd.startsWith("git add"));
  }

  it("stages only the provided files", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const commit = tools.get("belayd_commit");
    expect(commit).toBeDefined();

    mockExec.mockClear();
    await commit?.execute(
      "call-commit",
      { message: "feat: add files", files: ["src/a.ts", "docs/b.md"] },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(stagedGitAddCommands()).toEqual(['git add -- "src/a.ts" "docs/b.md"']);
  });

  it("stages everything when files is omitted", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const commit = tools.get("belayd_commit");
    expect(commit).toBeDefined();

    mockExec.mockClear();
    await commit?.execute(
      "call-commit",
      { message: "feat: add all" },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(stagedGitAddCommands()).toEqual(["git add -A"]);
  });

  it("stages everything when files is an empty array", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const commit = tools.get("belayd_commit");
    expect(commit).toBeDefined();

    mockExec.mockClear();
    await commit?.execute(
      "call-commit",
      { message: "feat: add all", files: [] },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(stagedGitAddCommands()).toEqual(["git add -A"]);
  });
});

describe("extension load dedup", () => {
  it("skips registration when another copy already loaded in the same batch", async () => {
    const factory = await loadExtension();

    // Global and project copies in one session share the load batch's bus.
    const sharedBus = createMockEventBus();
    const globalCopy = createMockPi(sharedBus);
    factory(globalCopy.api);
    expect(globalCopy.tools.get("belayd_scout")).toBeDefined();

    // The project copy must be a no-op: pi reports duplicate tool
    // registrations as a fatal conflict.
    const projectCopy = createMockPi(sharedBus);
    factory(projectCopy.api);
    expect(projectCopy.tools.size).toBe(0);
  });

  it("registers again in a fresh batch (a new pi-web session)", async () => {
    const factory = await loadExtension();

    const sessionOne = createMockPi();
    factory(sessionOne.api);
    expect(sessionOne.tools.get("belayd_scout")).toBeDefined();

    // A separate session has its own batch bus, so it must register its tools
    // rather than inheriting a stale process-wide flag.
    const sessionTwo = createMockPi();
    factory(sessionTwo.api);
    expect(sessionTwo.tools.get("belayd_scout")).toBeDefined();
  });
});

// ── Crash-resume semantics (bd-40) ─────────────────────────────────────
//
// The session_start handler restores a crashed orchestrator from .belayd/
// workflow.json via resumeWorkflowFromDisk. A completed phase is only
// persisted to workflow.json after its phase run actually succeeds
// (persistRunStatus), so a mid-phase crash re-runs the interrupted phase.
// Any manifest still marked "running" is flipped to "interrupted" on the
// next session_start so the orchestrator can surface dead runs.

describe("session_start resume from disk (bd-40)", () => {
  const surface = new Set<string>();
  let nextSessionId = 0;

  afterEach(() => {
    for (const dir of surface) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
    surface.clear();
    mockSpawnAgentProcess.mockClear();
    mockExec.mockClear();
    // Restore the default success spawn result other describe blocks expect.
    mockSpawnAgentProcess.mockResolvedValue({
      content: [{ type: "text" as const, text: "done" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: "mocked",
    });
  });

  function freshWorktree(): string {
    const dir = mkdtempSync(join(tmpdir(), "belayd-resume-"));
    surface.add(dir);
    return dir;
  }

  function featureState(overrides: Partial<WorkflowState> = {}): WorkflowState {
    return {
      schemaVersion: 1,
      taskId: "bd-42",
      workflowType: "feature",
      branch: "feat/bd-42",
      originalCwd: "/home/user/repo",
      phaseOrder: [...FEATURE_PHASES],
      completedPhaseNames: [],
      startedAt: 1_000,
      updatedAt: 1_000,
      ...overrides,
    };
  }

  /**
   * Build an orchestrator-shaped ctx for session_start: a real session file
   * (truthy) and a non-sub-agent session name so resumeWorkflowFromDisk runs.
   * Each call uses a unique sessionId so the module-level sessionStates map
   * never aliases state across tests.
   */
  function createResumeCtx(opts: { cwd: string; sessionName?: string; sessionFile?: string }): {
    sessionManager: {
      getSessionId: () => string;
      getSessionName: () => string | undefined;
      getSessionFile: () => string | undefined;
    };
    cwd: string;
  } {
    const sessionId = `resume-session-${nextSessionId++}`;
    return {
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionName: () => opts.sessionName ?? "orchestrator-session",
        getSessionFile: () => opts.sessionFile ?? `${opts.cwd}/session.jsonl`,
      },
      cwd: opts.cwd,
    };
  }

  async function bootWithCwd(cwd: string) {
    const { api, tools, eventHandlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);
    return { cwd, api, tools, eventHandlers };
  }

  async function fireSessionStart(
    eventHandlers: Map<string, (...args: unknown[]) => void>,
    ctx: { sessionManager: unknown; cwd: string },
  ): Promise<void> {
    const handler = eventHandlers.get("session_start");
    expect(handler).toBeDefined();
    await handler?.({}, ctx);
  }

  async function gateContextMessage(
    eventHandlers: Map<string, (...args: unknown[]) => void>,
    ctx: { sessionManager: unknown; cwd: string },
  ): Promise<string | undefined> {
    const handler = eventHandlers.get("before_agent_start");
    expect(handler).toBeDefined();
    // before_agent_start is async and returns { message: { content } } when the
    // gate is active, or undefined when it is not; the loose mock types it as
    // void so cast through unknown to read the shape we care about.
    const result = (await handler?.({}, ctx)) as unknown as
      | { message?: { content?: string } }
      | undefined;
    return result?.message?.content;
  }

  it("restores completedPhaseNames from disk and resumes at the next unfinished phase", async () => {
    const cwd = freshWorktree();
    writeWorkflowState({
      cwd,
      state: featureState({ completedPhaseNames: ["scout", "plan"] }),
    });

    const { eventHandlers } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    await fireSessionStart(eventHandlers, ctx);
    const message = await gateContextMessage(eventHandlers, ctx);

    // The gate is active again and the next required step jumps straight to
    // the first unfinished phase — scout and plan must NOT be re-requested.
    expect(message).toBeTruthy();
    expect(message).toContain("BELAYD WORKFLOW ACTIVE");
    expect(message).toContain("bd-42");
    expect(message).toContain("Next required step: call `belayd_implement`");
    expect(message).not.toContain("call `belayd_scout`");
  });

  it("clears a fully-complete workflow and leaves the gate inactive", async () => {
    const cwd = freshWorktree();
    writeWorkflowState({
      cwd,
      state: featureState({ completedPhaseNames: [...FEATURE_PHASES] }),
    });
    expect(existsSync(workflowStateFilePath(cwd))).toBe(true);

    const { eventHandlers } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    await fireSessionStart(eventHandlers, ctx);

    // A finished workflow must not resurrect the gate; the stale state file
    // is removed so a later start_task writes fresh.
    expect(existsSync(workflowStateFilePath(cwd))).toBe(false);
    const message = await gateContextMessage(eventHandlers, ctx);
    expect(message).toBeUndefined();
  });

  it("flips a still-running manifest to interrupted during resume", async () => {
    const cwd = freshWorktree();
    // scout already done, plan was running when the previous process died.
    writeWorkflowState({
      cwd,
      state: featureState({ completedPhaseNames: ["scout"] }),
    });
    writeRunManifest({
      cwd,
      manifest: {
        schemaVersion: 1,
        runId: "plan-run",
        taskId: "bd-42",
        phase: "plan",
        sessionName: "belayd-bd-42-sub-plan-plan-run",
        status: RunStatus.Running,
        startedAt: 5_000,
      },
    });

    const { eventHandlers } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    await fireSessionStart(eventHandlers, ctx);

    const reloaded = readRunManifest({ cwd, runId: "plan-run" });
    expect(reloaded).toHaveProperty("status", "interrupted");
    expect(reloaded).toHaveProperty("completedAt");
    expect(typeof reloaded?.completedAt).toBe("number");

    // And the gate still resumes at plan (the phase that died), not skipped.
    const message = await gateContextMessage(eventHandlers, ctx);
    expect(message).toContain("Next required step: call `belayd_plan`");
  });

  it("ignores sub-agent sessions and leaves disk state untouched", async () => {
    const cwd = freshWorktree();
    writeWorkflowState({
      cwd,
      state: featureState({ completedPhaseNames: ["scout", "plan"] }),
    });

    const { eventHandlers } = await bootWithCwd(cwd);
    // Session name contains "-sub-" so this is a spawned phase agent, not the
    // orchestrator; resumeWorkflowFromDisk must be skipped entirely.
    const ctx = createResumeCtx({ cwd, sessionName: "belayd-bd-42-sub-plan-abc123" });

    await fireSessionStart(eventHandlers, ctx);
    const message = await gateContextMessage(eventHandlers, ctx);

    expect(message).toBeUndefined();
    // State file is untouched (not migrated/cleared) because resume was skipped.
    expect(existsSync(workflowStateFilePath(cwd))).toBe(true);
    expect(readWorkflowStateFromDisk({ cwd })).toHaveProperty("taskId", "bd-42");
  });

  it("does nothing when no workflow or legacy state exists (fresh worktree)", async () => {
    const cwd = freshWorktree();

    const { eventHandlers } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    await fireSessionStart(eventHandlers, ctx);
    const message = await gateContextMessage(eventHandlers, ctx);
    expect(message).toBeUndefined();
    expect(existsSync(workflowStateFilePath(cwd))).toBe(false);
  });

  it("persists a completed phase to workflow.json only after its run succeeds (success path)", async () => {
    const cwd = freshWorktree();
    const { tools } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    // Fresh start_task writes an empty completed-phase state to disk.
    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);

    mockSpawnAgentProcess.mockResolvedValueOnce({
      content: [{ type: "text" as const, text: "scout done" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: "mocked-scout",
    });

    // The phase tool now returns immediately; its completion watcher persists
    // the completed phase in the background.
    await tools
      .get("belayd_scout")
      ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

    await vi.waitFor(() => {
      const persisted = readWorkflowStateFromDisk({ cwd });
      expect(persisted).toHaveProperty("completedPhaseNames", ["scout"]);
    });

    const runs = listRuns({ cwd });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveProperty("phase", "scout");
    expect(runs[0]).toHaveProperty("status", "completed");
    expect(runs[0]).toHaveProperty("exitCode", 0);
  });

  it("does NOT persist a failed phase to workflow.json (failure path)", async () => {
    const cwd = freshWorktree();
    const { tools } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);

    mockSpawnAgentProcess.mockResolvedValueOnce({
      content: [{ type: "text" as const, text: "scout crashed" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 1,
      },
      sessionName: "mocked-scout",
    });

    await tools
      .get("belayd_scout")
      ?.execute("scout", { task: "investigate" }, undefined, undefined, ctx);

    // The failed run's watcher must NOT persist scout to disk.
    await vi.waitFor(() => {
      const runs = listRuns({ cwd });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toHaveProperty("status", "failed");
    });

    const persisted = readWorkflowStateFromDisk({ cwd });
    expect(persisted).toHaveProperty("completedPhaseNames", []);

    const runs = listRuns({ cwd });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveProperty("phase", "scout");
    expect(runs[0]).toHaveProperty("exitCode", 1);
  });
});
