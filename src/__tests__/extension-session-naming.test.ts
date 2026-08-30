/**
 * Tests for session naming in the Belayd extension (bd-10).
 *
 * Covers:
 * - Phase tool session naming via computeSubagentSessionName + generateShortRunId wiring
 * - compactTaskSessions prefix matching logic (triggered via agent_end)
 * - runQualityGate multi-retry naming (via phase with quality gate)
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  messages: Array<{ customType: string; content: string; display: boolean }>;
  activeTools: string[];
} {
  const tools = new Map<
    string,
    { name: string; execute: (...args: unknown[]) => Promise<unknown> }
  >();
  const commands = new Map<string, unknown>();
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  const messages: Array<{ customType: string; content: string; display: boolean }> = [];
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
      msg: { customType: string; content: string; display: boolean },
      _opts?: { triggerTurn?: boolean },
    ) => {
      messages.push(msg);
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

// Helper to simulate a tool_call event and mark a phase completed
function simulatePhaseToolCall(
  eventHandlers: Map<string, (...args: unknown[]) => void>,
  toolName: string,
): void {
  const toolCallHandler = eventHandlers.get("tool_call");
  if (!toolCallHandler) return;
  toolCallHandler(
    {
      toolName,
      abort: vi.fn(),
    },
    createMockCtx(),
  );
}

async function loadExtension() {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("extension session naming (bd-10)", () => {
  afterEach(() => {
    mockSpawnAgentProcess.mockClear();
    mockHttpRequest.mockClear();
    mockExec.mockClear();
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

      // Verify spawnAgentProcess was called with a sessionName matching the pattern
      expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
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

      // Should have two spawn calls
      expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(2);

      const scoutOptions = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
      const planOptions = mockSpawnAgentProcess.mock.calls[1]?.[0] as Record<string, unknown>;

      expect(scoutOptions.sessionName).toMatch(/^belayd-bd-99-sub-scout-/);
      expect(planOptions.sessionName).toMatch(/^belayd-bd-99-sub-plan-/);
      expect(scoutOptions.sessionName).not.toBe(planOptions.sessionName);
    });
  });

  describe("compactTaskSessions", () => {
    it("compacts matching sessions on agent_end when workflow complete", async () => {
      const { api, tools, eventHandlers } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Set up mock responses for the daemon:
      // GET /sessions → returns a list with matching and non-matching sessions
      // (the mock reuses this for every phase's GET /sessions call)
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

      // Activate the gate with bd-42 (feature workflow: 8 phases)
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-42" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Mark ALL phases as completed via tool_call events
      const phaseOrder = [
        "scout",
        "plan",
        "implement",
        "review",
        "test",
        "userguide",
        "proof",
        "commit",
      ];
      for (const phase of phaseOrder) {
        simulatePhaseToolCall(eventHandlers, `belayd_${phase}`);
      }

      // Trigger agent_end
      const agentEndHandler = eventHandlers.get("agent_end");
      expect(agentEndHandler).toBeDefined();
      await agentEndHandler?.({}, createMockCtx());

      // Verify: GET /sessions was called
      const getCall = mockHttpRequest.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>).method === "GET",
      );
      expect(getCall).toBeDefined();

      // Verify: POST /sessions/sess-1/compact and /sessions/sess-2/compact were called
      // (sess-1 and sess-2 start with belayd-bd-42-scout, sess-3 starts with plan)
      const compactCalls = mockHttpRequest.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).method === "POST" &&
          (call[0] as Record<string, unknown>).path?.toString().includes("/compact"),
      );
      // Only scout sessions (sess-1, sess-2) should be compacted, not plan (sess-3)
      // because compactTaskSessions only compacts completed phases, and scout is
      // the only phase that used the session daemon (the others didn't create sessions).
      // Actually, compactTaskSessions iterates over completedPhases and compacts all
      // sessions matching the prefix for each phase. Since all 8 phases are completed,
      // it will try to compact scout sessions (sess-1, sess-2), plan sessions (sess-3),
      // and the other 4 phases (no matching sessions).
      // So we expect at least 3 compact calls (scout: 2, plan: 1).
      expect(compactCalls.length).toBeGreaterThanOrEqual(3);
    });

    it("handles empty sessions list gracefully", async () => {
      const { api, tools, eventHandlers } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Mock response: empty sessions list
      mockRequestResponses.addResponse(200, JSON.stringify({ sessions: [] }));

      // Activate gate and complete all phases
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute("call-1", { taskId: "bd-1" }, undefined, undefined, createMockCtx());

      const phaseOrder = [
        "scout",
        "plan",
        "implement",
        "review",
        "test",
        "proof",
        "userguide",
        "commit",
      ];
      for (const phase of phaseOrder) {
        simulatePhaseToolCall(eventHandlers, `belayd_${phase}`);
      }

      const agentEndHandler = eventHandlers.get("agent_end");
      await agentEndHandler?.({}, createMockCtx());

      // Should not throw even with empty sessions
      expect(true).toBe(true);
    });

    it("handles missing sessions field gracefully", async () => {
      const { api, tools, eventHandlers } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Mock response: no sessions field
      mockRequestResponses.addResponse(200, JSON.stringify({}));

      // Activate gate and complete all phases
      const startTask = tools.get("belayd_start_task");
      await startTask?.execute("call-1", { taskId: "bd-1" }, undefined, undefined, createMockCtx());

      const phaseOrder = [
        "scout",
        "plan",
        "implement",
        "review",
        "test",
        "userguide",
        "proof",
        "commit",
      ];
      for (const phase of phaseOrder) {
        simulatePhaseToolCall(eventHandlers, `belayd_${phase}`);
      }

      const agentEndHandler = eventHandlers.get("agent_end");
      await agentEndHandler?.({}, createMockCtx());

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
      const { api, tools, eventHandlers } = createMockPi();
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

      // Mark plan as completed (required before implement)
      simulatePhaseToolCall(eventHandlers, "belayd_plan");

      // Execute implement tool
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
      const retryCalls = mockSpawnAgentProcess.mock.calls.filter((call: unknown[]) => {
        const opts = call[0] as Record<string, unknown>;
        return typeof opts.sessionName === "string" && opts.sessionName.includes("-retry-");
      });
      expect(retryCalls).toHaveLength(9);

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

      const { api, tools, eventHandlers } = createMockPi();
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

      // Complete prior phases via tool_call events
      for (const phase of ["scout", "plan", "implement", "review", "test"]) {
        simulatePhaseToolCall(eventHandlers, `belayd_${phase}`);
      }

      // Execute the userguide tool
      const userguide = tools.get("belayd_userguide");
      expect(userguide).toBeDefined();

      await userguide?.execute(
        "call-userguide",
        { task: "Write user guide" },
        undefined,
        undefined,
        createMockCtx(),
      );

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

      const { api, tools, eventHandlers } = createMockPi();
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

      // Complete prior phases and execute userguide
      for (const phase of ["scout", "plan", "implement", "review", "test"]) {
        simulatePhaseToolCall(eventHandlers, `belayd_${phase}`);
      }

      const userguide = tools.get("belayd_userguide");
      await userguide?.execute(
        "call-ug",
        { task: "Write guide" },
        undefined,
        undefined,
        createMockCtx(),
      );

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

      const { api, tools, eventHandlers } = createMockPi();
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

      // Complete prior phases and execute userguide
      for (const phase of ["scout", "plan", "implement", "review", "test"]) {
        simulatePhaseToolCall(eventHandlers, `belayd_${phase}`);
      }

      const userguide = tools.get("belayd_userguide");
      await userguide?.execute(
        "call-ug",
        { task: "Write guide" },
        undefined,
        undefined,
        createMockCtx(),
      );

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

      const { api, tools, eventHandlers } = createMockPi();
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

      // Complete prior phases
      for (const phase of ["scout", "plan", "implement", "review", "test"]) {
        simulatePhaseToolCall(eventHandlers, `belayd_${phase}`);
      }

      // Execute userguide first time
      const userguide = tools.get("belayd_userguide");
      await userguide?.execute(
        "call-ug-1",
        { task: "First guide" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Execute userguide second time — tool_call marks it, then runs again
      // We need to re-simulate the tool_call after the first run completed it
      // Actually, markPhaseCompleted skips duplicates, but the tool executes anyway
      await userguide?.execute(
        "call-ug-2",
        { task: "Second guide (should overwrite)" },
        undefined,
        undefined,
        createMockCtx(),
      );

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

      const { api, tools, eventHandlers } = createMockPi();
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

      for (const phase of ["scout", "plan", "implement", "review", "test"]) {
        simulatePhaseToolCall(eventHandlers, `belayd_${phase}`);
      }

      const userguide = tools.get("belayd_userguide");
      await userguide?.execute(
        "call-ug",
        { task: "Write guide" },
        undefined,
        undefined,
        createMockCtx(),
      );

      // Stop without committing
      const stopTask = tools.get("belayd_stop_task");
      await stopTask?.execute("call-stop", {}, undefined, undefined, createMockCtx());

      // No execute should fail, no crash should occur
      expect(true).toBe(true);
    });
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
