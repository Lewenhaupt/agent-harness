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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const FEATURE_PHASES = ["implement", "review", "test", "userguide", "proof", "commit"] as const;

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

// The spawn layer is mocked above, so the real on-disk session existence check
// never runs. Control it directly: resume tests opt in with mockReturnValue(true),
// while the resume-fallback test leaves it false to exercise W3.
const mockResolveProjectSessionExists = vi.hoisted(() =>
  vi.fn((_sessionId: string): boolean => false),
);

vi.mock("../session-naming.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-naming.js")>();
  return {
    ...actual,
    resolveProjectSessionExists: mockResolveProjectSessionExists,
  };
});

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

// The commit path runs git/bd via execFile (no shell). Recording argv lets the
// staging and note tests assert exact arguments, and reading the `-F` temp file
// inside the mock proves the message reaches disk verbatim.
interface ExecFileRecord {
  file: string;
  args: readonly string[];
  stdin: string;
  cwd: string | undefined;
}

const mockExecFile = vi.hoisted(() => {
  const calls: ExecFileRecord[] = [];
  let mode: "fail" | "succeed" = "fail";
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
          if (mode === "fail") {
            callback(new Error("execFile not found in test environment"), "", "Command failed");
            return;
          }
          if (file === "git" && args[0] === "rev-parse") {
            callback(null, "abc1234\n", "");
            return;
          }
          callback(null, "[feat/x abc1234] commit done", "");
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
    setMode: (next: "fail" | "succeed") => {
      mode = next;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: mockExec,
    execFile: mockExecFile.fn,
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

/**
 * Per-test cwd for describes that do not need their own isolation. A fresh
 * temp dir per test keeps a workflow.json (and its bd-81 phase-session ledger)
 * written by one test from leaking into a later same-taskId test.
 */
let defaultMockCwd = "";

/** Build a mock ctx. bd-10 binds a per-test temp dir through its own local
 * wrapper instead of a mutable global. */
function createMockCtxWithCwd(overrides?: Partial<{ sessionId: string; cwd: string }>): {
  sessionManager: { getSessionId: () => string };
  cwd: string;
} {
  return {
    sessionManager: {
      getSessionId: () => overrides?.sessionId ?? "test-session-id",
    },
    cwd: overrides?.cwd ?? defaultMockCwd,
  };
}

/** Default ctx for describes that need no special setup; cwd is isolated per test. */
function createMockCtx(
  overrides?: Partial<{ sessionId: string; cwd: string }>,
): ReturnType<typeof createMockCtxWithCwd> {
  return createMockCtxWithCwd(overrides);
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

/** Make node:child_process succeed so the commit tool can finish. */
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
  mockExecFile.setMode("succeed");
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
  mockExecFile.setMode("fail");
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

beforeEach(() => {
  defaultMockCwd = mkdtempSync(join(tmpdir(), "belayd-extension-default-"));
});

// Default every test to "no session on disk" so resume-fallback (W3) stays
// exercised unless a test explicitly opts into resume.
afterEach(() => {
  mockResolveProjectSessionExists.mockReset();
  mockResolveProjectSessionExists.mockReturnValue(false);
  if (defaultMockCwd !== "") {
    rmSync(defaultMockCwd, { recursive: true, force: true });
    defaultMockCwd = "";
  }
});

describe("extension session naming (bd-10)", () => {
  // Each test gets its own workflow-state directory so the bd-81 phase-session
  // ledger (and completed phases) cannot leak between tests that reuse the
  // same default task ID. A local wrapper binds the ctx to it, so no
  // module-level mutable default is needed.
  let mockCwd = "";

  const bd10Ctx = (
    overrides?: Partial<{ sessionId: string; cwd: string }>,
  ): ReturnType<typeof createMockCtxWithCwd> =>
    createMockCtxWithCwd({ ...overrides, cwd: overrides?.cwd ?? mockCwd });

  beforeEach(() => {
    mockCwd = mkdtempSync(join(tmpdir(), "belayd-mock-cwd-"));
  });

  afterEach(() => {
    mockSpawnAgentProcess.mockClear();
    mockHttpRequest.mockClear();
    mockExec.mockClear();
    mockExecFile.clear();
    setExecToFail();
    mockRequestResponses.clear();
    // Reset default sessions response to empty
    (
      mockHttpRequest as unknown as {
        _setDefaultSessions: (data: string) => void;
      }
    )._setDefaultSessions(JSON.stringify({ sessions: [] }));
    if (mockCwd !== "") {
      rmSync(mockCwd, { recursive: true, force: true });
      mockCwd = "";
    }
  });

  describe("phase tool session naming", () => {
    it("passes sessionName matching belayd-bd-42-scout-<runId> to spawnAgentProcess", async () => {
      const { api, tools } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      // Activate the gate with bd-42
      const startTask = tools.get("belayd_start_task");
      expect(startTask).toBeDefined();

      await startTask?.execute("call-1", { taskId: "bd-42" }, undefined, undefined, bd10Ctx());

      // Execute the scout tool
      const scout = tools.get("belayd_scout");
      expect(scout).toBeDefined();
      await scout?.execute("call-2", { task: "investigate" }, undefined, undefined, bd10Ctx());

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
        bd10Ctx(),
      );

      // Execute scout
      const scout = tools.get("belayd_scout");
      await scout?.execute("call-2", { task: "scout" }, undefined, undefined, bd10Ctx());

      // Execute plan
      const plan = tools.get("belayd_plan");
      await plan?.execute("call-3", { task: "plan" }, undefined, undefined, bd10Ctx());

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
        bd10Ctx(),
      );

      const ctx = bd10Ctx();
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
        bd10Ctx(),
      );

      const ctx = bd10Ctx();
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
        bd10Ctx(),
      );

      const ctx = bd10Ctx();
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
      await agentEndHandler?.({}, bd10Ctx());

      // No HTTP requests to daemon should have been made
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });
  });

  describe("runQualityGate retry naming", () => {
    it("resumes the original session then alternates fresh/resumed epochs", async () => {
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
        bd10Ctx(),
      );

      // Execute implement tool — its gate retries now run in the background.
      const implement = tools.get("belayd_implement");
      await implement?.execute("call-2", { task: "implement" }, undefined, undefined, bd10Ctx());

      // The quality gate (gateFullValidation) shells out to pnpm via exec.
      // Since we mocked exec to fail, the gate keeps failing, so the harness
      // retries until MAX_GATE_ATTEMPTS (10) passes: 1 initial + 9 retries.
      await vi.waitFor(() => {
        expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(10);
      });

      const optionsFor = (index: number): Record<string, unknown> =>
        mockSpawnAgentProcess.mock.calls[index]?.[0] as Record<string, unknown>;
      const baseName = optionsFor(0).sessionName as string;
      expect(baseName).toMatch(/^belayd-bd-50-sub-implement-/);

      const expected = [
        { sessionName: baseName, resumeSession: true },
        { sessionName: baseName, resumeSession: true },
        { sessionName: `${baseName}-retry-3`, resumeSession: false },
        { sessionName: `${baseName}-retry-3`, resumeSession: true },
        { sessionName: `${baseName}-retry-5`, resumeSession: false },
        { sessionName: `${baseName}-retry-5`, resumeSession: true },
        { sessionName: `${baseName}-retry-7`, resumeSession: false },
        { sessionName: `${baseName}-retry-7`, resumeSession: true },
        { sessionName: `${baseName}-retry-9`, resumeSession: false },
      ];
      expected.forEach((want, offset) => {
        const opts = optionsFor(offset + 1);
        expect(opts.sessionName).toBe(want.sessionName);
        expect(opts.resumeSession).toBe(want.resumeSession);
      });

      // Resumed retries still deliver the gate feedback as the task text.
      expect(optionsFor(1).task).toContain("Previous attempt failed quality gate");
      expect(optionsFor(2).task).toContain("Previous attempt failed quality gate");
      // A fresh epoch starts without the transcript, so it also gets the
      // original task plus every accumulated gate verdict.
      expect(optionsFor(3).task).toContain("## Original task");
      expect(optionsFor(3).task).toContain("## Previous quality-gate failures");
      expect(optionsFor(3).task).toContain("implement");
      expect(optionsFor(2).task).not.toContain("## Original task");
    });

    it("passes the built (bead plan) task to a fresh-epoch retry", async () => {
      // Succeeding `bd show` makes buildTask prepend the bead plan, so a
      // fresh-epoch retry must carry it rather than the raw params.task.
      mockExecFile.setMode("succeed");
      const { api, tools } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      const startTask = tools.get("belayd_start_task");
      await startTask?.execute(
        "call-1",
        { taskId: "bd-50", workflowType: "chore" },
        undefined,
        undefined,
        bd10Ctx(),
      );

      const implement = tools.get("belayd_implement");
      await implement?.execute("call-2", { task: "implement" }, undefined, undefined, bd10Ctx());

      await vi.waitFor(() => {
        expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(10);
      });

      const freshEpoch = mockSpawnAgentProcess.mock.calls[3]?.[0] as Record<string, unknown>;
      expect(freshEpoch.task).toContain("## Bead plan (bd-50)");
      expect(freshEpoch.task).toContain("## Original task");
      // The resumed opening retries must not see the built task (transcript
      // already has it); they get only the retry note.
      const resumed = mockSpawnAgentProcess.mock.calls[1]?.[0] as Record<string, unknown>;
      expect(resumed.task).not.toContain("## Bead plan");
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
      await startTask?.execute("call-1", { taskId: "bd-77" }, undefined, undefined, bd10Ctx());

      // Execute the userguide tool and wait for its background run to finish.
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, bd10Ctx());

      // Now call commit with the taskId — if userGuideContent is set,
      // commit appends the note. execFile is mocked to fail, so we only
      // check that the calls were attempted.
      const commit = tools.get("belayd_commit");
      expect(commit).toBeDefined();

      mockExecFile.clear();
      await commit?.execute(
        "call-commit",
        {
          message: "feat: add feature (bd-77)",
          taskId: "bd-77",
        },
        undefined,
        undefined,
        bd10Ctx(),
      );

      // Verify that the human-review flag and the note append were attempted.
      const updateCalls = mockExecFile.calls.filter(
        (call) =>
          call.file === "bd" &&
          call.args[0] === "update" &&
          call.args.includes("bd-77") &&
          call.args.includes("human"),
      );
      const noteCalls = mockExecFile.calls.filter(
        (call) => call.file === "bd" && call.args[0] === "note" && call.args.includes("bd-77"),
      );

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
      await startTask?.execute("call-1", { taskId: "bd-77" }, undefined, undefined, bd10Ctx());

      // Complete userguide in the background before starting the next task.
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, bd10Ctx());

      // Start a new task — this should clear userGuideContent
      mockExecFile.clear();
      await startTask?.execute("call-2", { taskId: "bd-88" }, undefined, undefined, bd10Ctx());

      // Now call commit with the second taskId
      const commit = tools.get("belayd_commit");
      mockExecFile.clear();
      await commit?.execute(
        "call-commit",
        {
          message: "feat: other (bd-88)",
          taskId: "bd-88",
        },
        undefined,
        undefined,
        bd10Ctx(),
      );

      // Since userGuideContent was cleared, no bd note call should happen
      const noteCalls = mockExecFile.calls.filter(
        (call) => call.file === "bd" && call.args[0] === "note",
      );

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
      await startTask?.execute("call-1", { taskId: "bd-77" }, undefined, undefined, bd10Ctx());

      // Complete userguide in the background before stopping the task.
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, bd10Ctx());

      // Stop the task — this should clear userGuideContent
      const stopTask = tools.get("belayd_stop_task");
      expect(stopTask).toBeDefined();

      await stopTask?.execute("call-stop", {}, undefined, undefined, bd10Ctx());

      // Start a new task and commit — no append-notes should happen
      await startTask?.execute("call-2", { taskId: "bd-88" }, undefined, undefined, bd10Ctx());

      const commit = tools.get("belayd_commit");
      mockExecFile.clear();
      await commit?.execute(
        "call-commit",
        {
          message: "feat: other (bd-88)",
          taskId: "bd-88",
        },
        undefined,
        undefined,
        bd10Ctx(),
      );

      const noteCalls = mockExecFile.calls.filter(
        (call) => call.file === "bd" && call.args[0] === "note",
      );

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
      await startTask?.execute("call-1", { taskId: "bd-77" }, undefined, undefined, bd10Ctx());

      // Execute userguide twice; the second background run overwrites the first.
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, bd10Ctx());
      await runPhaseToolAndWait(tools, "belayd_userguide", messages, bd10Ctx());

      // Now call commit with taskId — should use the second (overwritten) content
      const commit = tools.get("belayd_commit");
      mockExecFile.clear();
      await commit?.execute(
        "call-commit",
        {
          message: "feat: add feature (bd-77)",
          taskId: "bd-77",
        },
        undefined,
        undefined,
        bd10Ctx(),
      );

      // The commit appends the user guide content via bd note.
      const noteCalls = mockExecFile.calls.filter(
        (call) => call.file === "bd" && call.args[0] === "note" && call.args.includes("bd-77"),
      );

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
      await startTask?.execute("call-1", { taskId: "bd-99" }, undefined, undefined, bd10Ctx());

      await runPhaseToolAndWait(tools, "belayd_userguide", messages, bd10Ctx());

      // Stop without committing
      const stopTask = tools.get("belayd_stop_task");
      await stopTask?.execute("call-stop", {}, undefined, undefined, bd10Ctx());

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
  function stagedGitAddArgv(): string[][] {
    return mockExecFile.calls
      .filter((call) => call.file === "git" && call.args[0] === "add")
      .map((call) => [...call.args]);
  }

  it("stages only the provided files", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const commit = tools.get("belayd_commit");
    expect(commit).toBeDefined();

    mockExecFile.clear();
    await commit?.execute(
      "call-commit",
      { message: "feat: add files", files: ["src/a.ts", "docs/b.md"] },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(stagedGitAddArgv()).toEqual([["add", "--", "src/a.ts", "docs/b.md"]]);
  });

  it("stages everything when files is omitted", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const commit = tools.get("belayd_commit");
    expect(commit).toBeDefined();

    mockExecFile.clear();
    await commit?.execute(
      "call-commit",
      { message: "feat: add all" },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(stagedGitAddArgv()).toEqual([["add", "-A"]]);
  });

  it("stages everything when files is an empty array", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const commit = tools.get("belayd_commit");
    expect(commit).toBeDefined();

    mockExecFile.clear();
    await commit?.execute(
      "call-commit",
      { message: "feat: add all", files: [] },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(stagedGitAddArgv()).toEqual([["add", "-A"]]);
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
    const { api, tools, eventHandlers, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);
    return { cwd, api, tools, eventHandlers, messages };
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
    // Stale-worktree guidance is unconditional: every gate turn must warn that
    // an apparently-missing task may simply be unrebased.
    expect(message).toContain("**Stale worktree?**");
    expect(message).toContain("git rebase main");
    expect(message).not.toContain("call `belayd_scout`");
  });

  it("emits the stale-worktree guidance for a non-feature workflow type (bugfix)", async () => {
    // The guidance helper is unconditional; a non-feature workflow type must
    // not silently drop it. Bugfix shares the gate path but has a different
    // phase order, so this also guards that the phase-order switch does not
    // bypass worktreeSyncGuidanceLines().
    const cwd = freshWorktree();
    const bugfixPhases = ["implement", "review", "test", "proof", "commit"] as const;
    writeWorkflowState({
      cwd,
      state: featureState({
        workflowType: "bugfix",
        phaseOrder: [...bugfixPhases],
        completedPhaseNames: ["implement"],
      }),
    });

    const { eventHandlers } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    await fireSessionStart(eventHandlers, ctx);
    const message = await gateContextMessage(eventHandlers, ctx);

    expect(message).toBeTruthy();
    expect(message).toContain("bugfix");
    // Next unfinished phase after implement is review.
    expect(message).toContain("Next required step: call `belayd_review`");
    // Guidance is present regardless of workflow type.
    expect(message).toContain("**Stale worktree?**");
    expect(message).toContain("git rebase main");
    expect(message).toContain("not be in this branch yet");
    expect(message).toContain("Mid-rebase conflicts are expected");
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
    // implement was running when the previous process died; nothing completed.
    writeWorkflowState({
      cwd,
      state: featureState({ completedPhaseNames: [] }),
    });
    writeRunManifest({
      cwd,
      manifest: {
        schemaVersion: 1,
        runId: "implement-run",
        taskId: "bd-42",
        phase: "implement",
        sessionName: "belayd-bd-42-sub-implement-implement-run",
        status: RunStatus.Running,
        startedAt: 5_000,
      },
    });

    const { eventHandlers } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    await fireSessionStart(eventHandlers, ctx);

    const reloaded = readRunManifest({ cwd, runId: "implement-run" });
    expect(reloaded).toHaveProperty("status", "interrupted");
    expect(reloaded).toHaveProperty("completedAt");
    expect(typeof reloaded?.completedAt).toBe("number");

    // And the gate still resumes at implement (the phase that died), not skipped.
    const message = await gateContextMessage(eventHandlers, ctx);
    expect(message).toContain("Next required step: call `belayd_implement`");
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
      content: [{ type: "text" as const, text: "implement done" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: "mocked-implement",
    });

    // The phase tool now returns immediately; its completion watcher persists
    // the completed phase in the background.
    await tools
      .get("belayd_implement")
      ?.execute("implement", { task: "implement" }, undefined, undefined, ctx);

    await vi.waitFor(() => {
      const persisted = readWorkflowStateFromDisk({ cwd });
      expect(persisted).toHaveProperty("completedPhaseNames", ["implement"]);
    });

    const runs = listRuns({ cwd });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveProperty("phase", "implement");
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

    // Always fail so both the initial implement run AND its quality-gate
    // retries settle with exitCode 1; the gate then records a failed run.
    mockSpawnAgentProcess.mockResolvedValue({
      content: [{ type: "text" as const, text: "implement crashed" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 1,
      },
      sessionName: "mocked-implement",
    });

    await tools
      .get("belayd_implement")
      ?.execute("implement", { task: "implement" }, undefined, undefined, ctx);

    // The failed run's watcher must NOT persist implement to disk.
    await vi.waitFor(() => {
      const runs = listRuns({ cwd });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toHaveProperty("status", "failed");
    });

    const persisted = readWorkflowStateFromDisk({ cwd });
    expect(persisted).toHaveProperty("completedPhaseNames", []);

    const runs = listRuns({ cwd });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveProperty("phase", "implement");
    expect(runs[0]).toHaveProperty("exitCode", 1);
  });

  // ── Review↔fix resume (bd-81) ──────────────────────────────────────

  it("resumes the implement session on later invocations and bounds epochs", async () => {
    setExecToSucceed();
    // The spawn layer is mocked, so track which sessions the mock has "created"
    // on disk. A would-be fresh `-run-N` epoch must read as absent until it is
    // spawned, which also lets the W6 collision-advance loop terminate.
    const existingSessions = new Set<string>();
    mockResolveProjectSessionExists.mockImplementation((sessionId: string) =>
      existingSessions.has(sessionId),
    );
    const cwd = freshWorktree();
    const { tools, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    const runPhase = async (phaseName: string, task: string): Promise<void> => {
      const before = runCompletionCount(messages);
      await tools
        .get(`belayd_${phaseName}`)
        ?.execute(`call-${phaseName}`, { task }, undefined, undefined, ctx);
      await vi.waitFor(() => {
        expect(runCompletionCount(messages)).toBe(before + 1);
      });
      // Model the spawned session now existing on disk: the W6 pre-check must
      // see a fresh epoch as absent before its spawn but present on the next
      // (resume) invocation.
      const spawned = mockSpawnAgentProcess.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      if (typeof spawned.sessionName === "string") existingSessions.add(spawned.sessionName);
    };

    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);

    await runPhase("implement", "first pass");
    const first = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(first.resumeSession).toBe(false);
    const base = first.sessionName as string;

    await runPhase("implement", "fix the findings");
    const second = mockSpawnAgentProcess.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(second.sessionName).toBe(base);
    expect(second.resumeSession).toBe(true);
    // A cross-run resume must not re-prepend the bead plan; the orchestrator
    // supplies the review findings in the task instead.
    expect(second.task).toBe("fix the findings");

    await runPhase("implement", "third pass");
    const third = mockSpawnAgentProcess.mock.calls[2]?.[0] as Record<string, unknown>;
    expect(third.sessionName).toBe(base);
    expect(third.resumeSession).toBe(true);

    await runPhase("implement", "fourth pass");
    const fourth = mockSpawnAgentProcess.mock.calls[3]?.[0] as Record<string, unknown>;
    expect(fourth.sessionName).toBe(`${base}-run-3`);
    expect(fourth.resumeSession).toBe(false);

    await runPhase("implement", "fifth pass");
    const fifth = mockSpawnAgentProcess.mock.calls[4]?.[0] as Record<string, unknown>;
    expect(fifth.sessionName).toBe(`${base}-run-3`);
    expect(fifth.resumeSession).toBe(true);

    // The ledger is per-(task, phase) and persisted for the next orchestrator.
    expect(readWorkflowStateFromDisk({ cwd })?.phaseSessions?.implement).toEqual({
      base,
      invocations: 5,
    });
  });

  it("mints a distinct -run-3 cross-run epoch despite a gate-retry -retry-3", async () => {
    setExecToSucceed();
    // The would-be fresh epoch is absent on disk; only a stale gate-retry
    // `-retry-3` exists, which the `-run-3` namespace must not reuse.
    mockResolveProjectSessionExists.mockReturnValue(false);
    const cwd = freshWorktree();
    const base = "belayd-bd-42-sub-implement-collision";
    // The ledger is already at attempt 3, so the next invocation is the first
    // fresh cross-run epoch. An earlier implement run's gate retries would have
    // left `base-retry-3` on disk; the cross-run epoch must not reuse that name.
    writeWorkflowState({
      cwd,
      state: featureState({
        completedPhaseNames: ["implement", "review"],
        phaseSessions: { implement: { base, invocations: 3 } },
      }),
    });

    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });
    await fireSessionStart(eventHandlers, ctx);

    const before = runCompletionCount(messages);
    await tools
      .get("belayd_implement")
      ?.execute("call-implement", { task: "fix" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });

    const opts = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.sessionName).toBe(`${base}-run-3`);
    expect(opts.sessionName).not.toBe(`${base}-retry-3`);
    expect(opts.resumeSession).toBe(false);
  });

  it("advances past a stale fresh-epoch name left by a failed ledger write (W6)", async () => {
    setExecToSucceed();
    const cwd = freshWorktree();
    const base = "belayd-bd-42-sub-implement-stale";
    // The ledger says attempt 3, but an earlier invocation already created
    // `base-run-3` on disk and then failed to persist the advance. The next
    // invocation resolves the same fresh epoch; spawning it as fresh would let
    // pi's create-or-resume silently replay the stale transcript.
    writeWorkflowState({
      cwd,
      state: featureState({
        completedPhaseNames: ["implement", "review"],
        phaseSessions: { implement: { base, invocations: 3 } },
      }),
    });
    mockResolveProjectSessionExists.mockImplementation(
      (sessionId: string) => sessionId === `${base}-run-3`,
    );

    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });
    await fireSessionStart(eventHandlers, ctx);

    const before = runCompletionCount(messages);
    await tools
      .get("belayd_implement")
      ?.execute("call-implement", { task: "fix" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });

    const opts = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
    // Advanced to the next odd epoch instead of clobbering/resuming `-run-3`.
    expect(opts.sessionName).toBe(`${base}-run-5`);
    expect(opts.resumeSession).toBe(false);
    // The ledger advanced past the skipped epoch, so the next invocation
    // resumes the epoch actually spawned.
    expect(readWorkflowStateFromDisk({ cwd })?.phaseSessions?.implement).toEqual({
      base,
      invocations: 6,
    });
  });

  it("bounds the collision-advance loop when the exists probe never clears (W6)", async () => {
    setExecToSucceed();
    const cwd = freshWorktree();
    const base = "belayd-bd-42-sub-implement-stuck";
    // The ledger is at attempt 3 and every probe reports the name as present,
    // so the W6 advance loop would never find an absent epoch. The defensive
    // cap must terminate with a fresh name outside the `-run-<n>` namespace.
    writeWorkflowState({
      cwd,
      state: featureState({
        completedPhaseNames: ["implement", "review"],
        phaseSessions: { implement: { base, invocations: 3 } },
      }),
    });
    mockResolveProjectSessionExists.mockReturnValue(true);

    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });
    await fireSessionStart(eventHandlers, ctx);

    const before = runCompletionCount(messages);
    await tools
      .get("belayd_implement")
      ?.execute("call-implement", { task: "fix" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });

    const opts = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof opts.sessionName).toBe("string");
    expect(opts.sessionName as string).toMatch(new RegExp(`^${base}-run-x-`));
    expect(opts.resumeSession).toBe(false);
    // The ledger advanced past the exhausted namespace rather than stalling.
    const persisted = readWorkflowStateFromDisk({ cwd })?.phaseSessions?.implement;
    expect(persisted?.base).toBe(base);
    expect(persisted?.invocations).toBeGreaterThan(3);
  });

  it("ignores a foreign workflow.json (taskId mismatch) and writes no ledger entry (W1)", async () => {
    setExecToSucceed();
    mockResolveProjectSessionExists.mockReturnValue(true);
    const cwd = freshWorktree();
    const { tools, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    // Start bd-42 so the gate is active and currentTaskId is set, then swap the
    // workflow.json for another task's state. A phase tool must treat the
    // foreign ledger as absent: fresh session, and no write into it.
    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);
    writeWorkflowState({
      cwd,
      state: featureState({
        taskId: "bd-99",
        completedPhaseNames: [],
        phaseSessions: {
          implement: { base: "belayd-bd-99-sub-implement-foreign", invocations: 2 },
        },
      }),
    });

    const before = runCompletionCount(messages);
    await tools
      .get("belayd_implement")
      ?.execute("call-implement", { task: "implement" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });

    const opts = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.sessionName).toMatch(/^belayd-bd-42-sub-implement-/);
    expect(opts.resumeSession).toBe(false);

    // The foreign task's ledger entry is untouched and no bd-42 entry was added.
    const persisted = readWorkflowStateFromDisk({ cwd });
    expect(persisted).toHaveProperty("taskId", "bd-99");
    expect(persisted?.phaseSessions).toEqual({
      implement: { base: "belayd-bd-99-sub-implement-foreign", invocations: 2 },
    });
  });

  it("resumes the review session across re-reviews", async () => {
    setExecToSucceed();
    mockResolveProjectSessionExists.mockReturnValue(true);
    const cwd = freshWorktree();
    const { tools, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    const runPhase = async (phaseName: string, task: string): Promise<void> => {
      const before = runCompletionCount(messages);
      await tools
        .get(`belayd_${phaseName}`)
        ?.execute(`call-${phaseName}`, { task }, undefined, undefined, ctx);
      await vi.waitFor(() => {
        expect(runCompletionCount(messages)).toBe(before + 1);
      });
    };

    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);
    await runPhase("implement", "implement");

    await runPhase("review", "first review");
    const firstReview = mockSpawnAgentProcess.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find(
        (opts) => typeof opts.sessionName === "string" && opts.sessionName.includes("-review-"),
      );
    expect(firstReview).toBeDefined();
    const base = firstReview?.sessionName as string;
    expect(firstReview?.resumeSession).toBe(false);

    await runPhase("review", "re-review after fixes");
    const secondReview = mockSpawnAgentProcess.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter(
        (opts) => typeof opts.sessionName === "string" && opts.sessionName.includes("-review-"),
      )
      .at(-1);
    expect(secondReview?.sessionName).toBe(base);
    expect(secondReview?.resumeSession).toBe(true);
  });

  it("points the gate context at the resumable fix loop after review", async () => {
    setExecToSucceed();
    const cwd = freshWorktree();
    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    const runPhase = async (phaseName: string, task: string): Promise<void> => {
      const before = runCompletionCount(messages);
      await tools
        .get(`belayd_${phaseName}`)
        ?.execute(`call-${phaseName}`, { task }, undefined, undefined, ctx);
      await vi.waitFor(() => {
        expect(runCompletionCount(messages)).toBe(before + 1);
      });
    };

    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);
    await runPhase("implement", "implement");
    await runPhase("review", "review");

    const message = await gateContextMessage(eventHandlers, ctx);
    expect(message).toContain("If any Critical/Warnings remain, call `belayd_implement`");
    expect(message).toContain("resumes the review session");
    expect(message).not.toContain("Next required step: call `belayd_test`");

    // The loop directive is also attached to the review completion follow-up.
    const reviewDelivery = messages.find(
      (m) =>
        m.customType === "belayd-run-complete" && m.content.includes("call `belayd_review` again"),
    );
    expect(reviewDelivery?.content).toContain("call `belayd_review` again");
  });

  it("keeps the plain next-step directive when review never ran", async () => {
    setExecToSucceed();
    const cwd = freshWorktree();
    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);

    const before = runCompletionCount(messages);
    await tools
      .get("belayd_implement")
      ?.execute("call-implement", { task: "implement" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });

    const message = await gateContextMessage(eventHandlers, ctx);
    expect(message).toContain("Next required step: call `belayd_review`");
    expect(message).not.toContain("Review findings need addressing");
  });

  it("prepends the bead plan when a resume target is missing on disk", async () => {
    setExecToSucceed();
    // Existence check defaults to false: the ledger says resume, but the session
    // file is gone, so the invocation must behave as fresh and carry the plan.
    const cwd = freshWorktree();
    const { tools, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    const runPhase = async (phaseName: string, task: string): Promise<void> => {
      const before = runCompletionCount(messages);
      await tools
        .get(`belayd_${phaseName}`)
        ?.execute(`call-${phaseName}`, { task }, undefined, undefined, ctx);
      await vi.waitFor(() => {
        expect(runCompletionCount(messages)).toBe(before + 1);
      });
    };

    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);

    await runPhase("implement", "first pass");
    const first = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
    const base = first.sessionName as string;

    await runPhase("implement", "second pass");
    const second = mockSpawnAgentProcess.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(second.sessionName).toBe(base);
    expect(second.resumeSession).toBe(false);
    // A missing resume target means a fresh session, so the plan is needed.
    expect(second.task).toContain("## Bead plan (bd-42)");
  });

  it("re-arms the resumable-fix directive after a later review (W4)", async () => {
    setExecToSucceed();
    const cwd = freshWorktree();
    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    const runPhase = async (phaseName: string, task: string): Promise<void> => {
      const before = runCompletionCount(messages);
      await tools
        .get(`belayd_${phaseName}`)
        ?.execute(`call-${phaseName}`, { task }, undefined, undefined, ctx);
      await vi.waitFor(() => {
        expect(runCompletionCount(messages)).toBe(before + 1);
      });
    };

    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);
    await runPhase("implement", "implement");
    await runPhase("review", "review");
    expect(await gateContextMessage(eventHandlers, ctx)).toContain(
      "Review findings need addressing",
    );

    // A phase after review clears the flag and restores the plain directive.
    await runPhase("test", "test");
    const afterTest = await gateContextMessage(eventHandlers, ctx);
    expect(afterTest).toContain("Next required step: call `belayd_userguide`");
    expect(afterTest).not.toContain("Review findings need addressing");

    // A late implement re-run is the fix half of the loop, so it re-arms the
    // directive and points back at review instead of userguide.
    await runPhase("implement", "late fix");
    expect(await gateContextMessage(eventHandlers, ctx)).toContain(
      "Review findings need addressing",
    );

    // A late re-review after test keeps it armed.
    await runPhase("review", "late re-review");
    expect(await gateContextMessage(eventHandlers, ctx)).toContain(
      "Review findings need addressing",
    );
  });

  it("resumes the persisted ledger and awaiting flag in a new session", async () => {
    setExecToSucceed();
    mockResolveProjectSessionExists.mockReturnValue(true);
    const cwd = freshWorktree();
    const base = "belayd-bd-42-sub-implement-persisted";
    writeWorkflowState({
      cwd,
      state: featureState({
        completedPhaseNames: ["implement", "review"],
        phaseSessions: { implement: { base, invocations: 1 } },
        awaitingReviewResponse: true,
      }),
    });

    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });
    await fireSessionStart(eventHandlers, ctx);

    // The persisted flag survives the restart and drives the loop directive.
    expect(await gateContextMessage(eventHandlers, ctx)).toContain(
      "Review findings need addressing",
    );

    const before = runCompletionCount(messages);
    await tools
      .get("belayd_implement")
      ?.execute("call-implement", { task: "fix findings" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });

    const opts = mockSpawnAgentProcess.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.sessionName).toBe(base);
    expect(opts.resumeSession).toBe(true);
    // Resumed runs must not re-prepend the plan (it is already in the transcript).
    expect(opts.task).toBe("fix findings");
  });

  it("derives the armed loop from disk when the persisted flag is absent (pre-bd-81 state)", async () => {
    setExecToSucceed();
    const cwd = freshWorktree();
    // A pre-bd-81 workflow.json records review as completed but predates the
    // awaitingReviewResponse field, so resume must derive the flag from the
    // completed phase list instead of reading it.
    writeWorkflowState({
      cwd,
      state: featureState({ completedPhaseNames: ["implement", "review"] }),
    });
    expect(readWorkflowStateFromDisk({ cwd })?.awaitingReviewResponse).toBe(undefined);

    const { eventHandlers } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });
    await fireSessionStart(eventHandlers, ctx);

    const message = await gateContextMessage(eventHandlers, ctx);
    expect(message).toContain("Review findings need addressing");
    expect(message).toContain("If any Critical/Warnings remain, call `belayd_implement`");
    expect(message).not.toContain("Next required step: call `belayd_test`");
  });

  it("keeps a fresh session and writes no ledger entry for a non-resumable phase", async () => {
    setExecToSucceed();
    mockResolveProjectSessionExists.mockReturnValue(true);
    const cwd = freshWorktree();
    const { tools, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    const runPhase = async (phaseName: string, task: string): Promise<void> => {
      const before = runCompletionCount(messages);
      await tools
        .get(`belayd_${phaseName}`)
        ?.execute(`call-${phaseName}`, { task }, undefined, undefined, ctx);
      await vi.waitFor(() => {
        expect(runCompletionCount(messages)).toBe(before + 1);
      });
    };

    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);
    await runPhase("implement", "implement");
    await runPhase("review", "review");
    await runPhase("test", "test");
    await runPhase("test", "test again");

    const testSpawns = mockSpawnAgentProcess.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter(
        (opts) => typeof opts.sessionName === "string" && opts.sessionName.includes("-test-"),
      );
    expect(testSpawns).toHaveLength(2);
    for (const spawn of testSpawns) {
      expect(spawn.resumeSession).toBe(false);
      expect(spawn.sessionName).toMatch(/^belayd-bd-42-sub-test-/);
      expect(spawn.sessionName).not.toMatch(/-run-\d+$/);
    }

    // Only implement/review participate, so `test` must not appear in the ledger.
    const persisted = readWorkflowStateFromDisk({ cwd });
    expect(persisted?.phaseSessions?.test).toBeUndefined();
    expect(persisted?.phaseSessions?.implement).toBeDefined();
    expect(persisted?.phaseSessions?.review).toBeDefined();
  });

  it("keeps the plain next-step directive for a workflow with no review phase", async () => {
    setExecToSucceed();
    const cwd = freshWorktree();
    // research has no review phase, so the resumable-fix loop must never arm.
    writeWorkflowState({
      cwd,
      state: featureState({
        workflowType: "research",
        phaseOrder: ["scout", "plan", "commit"],
        completedPhaseNames: ["scout"],
      }),
    });

    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });
    await fireSessionStart(eventHandlers, ctx);

    const resumed = await gateContextMessage(eventHandlers, ctx);
    expect(resumed).toContain("Next required step: call `belayd_plan`");
    expect(resumed).not.toContain("Review findings need addressing");

    const before = runCompletionCount(messages);
    await tools
      .get("belayd_plan")
      ?.execute("call-plan", { task: "plan" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });

    // Completing a phase in a review-less order leaves the flag false on disk.
    expect(readWorkflowStateFromDisk({ cwd })?.awaitingReviewResponse).toBe(false);
    expect(await gateContextMessage(eventHandlers, ctx)).toContain(
      "Next required step: call `belayd_commit`",
    );
  });

  it("prioritises the wait directive over the armed fix loop while a run is active", async () => {
    setExecToSucceed();
    const cwd = freshWorktree();
    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });

    const runPhase = async (phaseName: string, task: string): Promise<void> => {
      const before = runCompletionCount(messages);
      await tools
        .get(`belayd_${phaseName}`)
        ?.execute(`call-${phaseName}`, { task }, undefined, undefined, ctx);
      await vi.waitFor(() => {
        expect(runCompletionCount(messages)).toBe(before + 1);
      });
    };

    await tools
      .get("belayd_start_task")
      ?.execute("start", { taskId: "bd-42" }, undefined, undefined, ctx);
    await runPhase("implement", "implement");
    await runPhase("review", "review");
    // The directive is armed after review.
    expect(await gateContextMessage(eventHandlers, ctx)).toContain(
      "Review findings need addressing",
    );

    // Hold the next run open so activeRuns stays non-empty while armed: the
    // wait branch must win over the resumable-fix directive.
    let releaseTest: (value: unknown) => void = () => {};
    mockSpawnAgentProcess.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseTest = resolve;
      }),
    );
    await tools
      .get("belayd_test")
      ?.execute("call-test", { task: "test" }, undefined, undefined, ctx);

    const armedWithActiveRun = await gateContextMessage(eventHandlers, ctx);
    expect(armedWithActiveRun).toContain("Waiting for active runs to complete");
    expect(armedWithActiveRun).not.toContain("Review findings need addressing");

    const before = runCompletionCount(messages);
    releaseTest({
      content: [{ type: "text" as const, text: "test done" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: "mocked-test",
    });
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });
  });

  it("leaves the armed fix loop unchanged across a pre-review phase re-run", async () => {
    setExecToSucceed();
    const cwd = freshWorktree();
    writeWorkflowState({
      cwd,
      state: featureState({
        completedPhaseNames: ["implement", "review"],
        awaitingReviewResponse: true,
      }),
    });

    const { tools, eventHandlers, messages } = await bootWithCwd(cwd);
    const ctx = createResumeCtx({ cwd });
    await fireSessionStart(eventHandlers, ctx);
    expect(await gateContextMessage(eventHandlers, ctx)).toContain(
      "Review findings need addressing",
    );

    // scout precedes review in the order, so its completion must not disarm
    // the directive (it is a consult phase, not part of the fix loop).
    const before = runCompletionCount(messages);
    await tools
      .get("belayd_scout")
      ?.execute("call-scout", { task: "scout" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(runCompletionCount(messages)).toBe(before + 1);
    });

    const afterScout = await gateContextMessage(eventHandlers, ctx);
    expect(afterScout).toContain("Review findings need addressing");
    expect(afterScout).not.toContain("Next required step: call `belayd_test`");
  });
});
