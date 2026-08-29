import { afterEach, describe, expect, it, vi } from "vitest";

// Create the mock spawn function before the vi.mock hoisting.
// Stores handlers so tests can simulate process completion.
const mockSpawn = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const mock = vi.fn().mockReturnValue({
    stdout: {
      on: vi.fn((_event: string, handler: (...args: unknown[]) => void) => {
        handlers.set("stdout:data", handler);
      }),
    },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    kill: vi.fn(),
  });
  // Expose handlers for test access
  (mock as unknown as { _handlers: Map<string, (...args: unknown[]) => void> })._handlers =
    handlers;
  return mock;
});

// Mock child_process at module level (hoisted by vitest)
vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

// Helper to access the handlers map stored on the mock
function getHandlers(): Map<string, (...args: unknown[]) => void> {
  return (mockSpawn as unknown as { _handlers: Map<string, (...args: unknown[]) => void> })
    ._handlers;
}

/** Simulate process completion by firing the "close" event. */
function simulateProcessComplete(exitCode = 0): void {
  const handlers = getHandlers();
  const closeHandler = handlers.get("close");
  if (closeHandler) closeHandler(exitCode);
}

describe("spawnAgentProcess module", () => {
  afterEach(() => {
    mockSpawn.mockClear();
  });

  it("exports spawnAgentProcess as a function", async () => {
    const mod = await import("../spawn.js");
    expect(mod).toHaveProperty("spawnAgentProcess");
    expect(typeof mod.spawnAgentProcess).toBe("function");
  });

  it("spawnAgentProcess returns a Promise", async () => {
    const mod = await import("../spawn.js");
    const promise = mod.spawnAgentProcess({
      model: "test-model",
      tools: ["read"],
      systemPrompt: "test",
      task: "test",
    });
    expect(promise).toBeInstanceOf(Promise);
  });
});

describe("spawnAgentProcess CLI args (bd-10)", () => {
  afterEach(() => {
    mockSpawn.mockClear();
  });

  it("does NOT include --no-session in args", async () => {
    const mod = await import("../spawn.js");
    mod
      .spawnAgentProcess({
        model: "test-model",
        tools: ["read"],
        systemPrompt: "test",
        task: "test",
      })
      .catch(() => {});

    expect(mockSpawn).toHaveBeenCalled();
    const callArgs = mockSpawn.mock.calls[0] as unknown[];
    const args = callArgs[1] as string[];
    expect(args).not.toContain("--no-session");
  });

  it("includes --session-id and --name before --model", async () => {
    const mod = await import("../spawn.js");
    mod
      .spawnAgentProcess({
        model: "test-model",
        tools: ["read"],
        systemPrompt: "test",
        task: "test",
        sessionName: "belayd-bd-42-scout-run1",
      })
      .catch(() => {});

    expect(mockSpawn).toHaveBeenCalled();
    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
    const args = callArgs[1] as string[];

    const sessionIdIdx = args.indexOf("--session-id");
    const modelIdx = args.indexOf("--model");
    const nameIdx = args.indexOf("--name");

    expect(sessionIdIdx).not.toBe(-1);
    expect(nameIdx).not.toBe(-1);
    expect(modelIdx).not.toBe(-1);

    // --session-id and --name must appear before --model
    expect(sessionIdIdx).toBeLessThan(modelIdx);
    expect(nameIdx).toBeLessThan(modelIdx);
  });

  it("includes --session-id and --name in args when sessionName provided", async () => {
    const mod = await import("../spawn.js");
    mod
      .spawnAgentProcess({
        model: "test-model",
        tools: ["read"],
        systemPrompt: "test",
        task: "test",
        sessionName: "belayd-bd-42-scout-run1",
      })
      .catch(() => {});

    expect(mockSpawn).toHaveBeenCalled();
    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
    const args = callArgs[1] as string[];

    const sessionIdIdx = args.indexOf("--session-id");
    expect(sessionIdIdx).not.toBe(-1);
    expect(args[sessionIdIdx + 1]).toBe("belayd-bd-42-scout-run1");

    const nameIdx = args.indexOf("--name");
    expect(nameIdx).not.toBe(-1);
    expect(args[nameIdx + 1]).toBe("belayd-bd-42-scout-run1");
  });

  it("uses generated fallback when sessionName not provided", async () => {
    const mod = await import("../spawn.js");
    mod
      .spawnAgentProcess({
        model: "test-model",
        tools: ["read"],
        systemPrompt: "test",
        task: "test",
      })
      .catch(() => {});

    expect(mockSpawn).toHaveBeenCalled();
    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
    const args = callArgs[1] as string[];

    const sessionIdIdx = args.indexOf("--session-id");
    expect(sessionIdIdx).not.toBe(-1);
    const sessionId = args[sessionIdIdx + 1] as string;
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^belayd-unknown-/);

    const nameIdx = args.indexOf("--name");
    expect(nameIdx).not.toBe(-1);
    expect(args[nameIdx + 1]).toBe(sessionId);
  });

  it("fallback sessionId format is belayd-unknown-{base36}-{base36random}", async () => {
    const mod = await import("../spawn.js");
    mod
      .spawnAgentProcess({
        model: "test-model",
        tools: ["read"],
        systemPrompt: "test",
        task: "test",
      })
      .catch(() => {});

    expect(mockSpawn).toHaveBeenCalled();
    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
    const args = callArgs[1] as string[];

    const sessionIdIdx = args.indexOf("--session-id");
    const sessionId = args[sessionIdIdx + 1] as string;
    // Format: belayd-unknown-{base36timestamp}-{4charBase36random}
    expect(sessionId).toMatch(/^belayd-unknown-[0-9a-z]+-[0-9a-z]{4}$/);
  });
});

describe("spawnAgentProcess result (bd-10)", () => {
  afterEach(() => {
    mockSpawn.mockClear();
  });

  it("returns sessionName in result when sessionName provided", async () => {
    const mod = await import("../spawn.js");
    const promise = mod.spawnAgentProcess({
      model: "test-model",
      tools: ["read"],
      systemPrompt: "test",
      task: "test",
      sessionName: "belayd-bd-42-scout-run1",
    });

    // Simulate process completion (no stdout data, empty buffer)
    simulateProcessComplete(0);

    const result = await promise;
    expect(result).toHaveProperty("sessionName");
    expect(result.sessionName).toBe("belayd-bd-42-scout-run1");
  });

  it("returns sessionName in result when using fallback", async () => {
    const mod = await import("../spawn.js");
    const promise = mod.spawnAgentProcess({
      model: "test-model",
      tools: ["read"],
      systemPrompt: "test",
      task: "test",
    });

    // Simulate process completion
    simulateProcessComplete(0);

    const result = await promise;
    expect(result).toHaveProperty("sessionName");
    expect(result.sessionName).toBeTruthy();
    expect(result.sessionName).toMatch(/^belayd-unknown-/);
  });

  it("sessionName in result matches the --session-id arg", async () => {
    const mod = await import("../spawn.js");
    const promise = mod.spawnAgentProcess({
      model: "test-model",
      tools: ["read"],
      systemPrompt: "test",
      task: "test",
      sessionName: "belayd-bd-99-plan-x1y2",
    });

    // Capture the spawn call before resolving
    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
    const args = callArgs[1] as string[];
    const sessionIdIdx = args.indexOf("--session-id");
    const sentSessionId = args[sessionIdIdx + 1] as string;

    simulateProcessComplete(0);
    const result = await promise;

    expect(result.sessionName).toBe(sentSessionId);
    expect(result.sessionName).toBe("belayd-bd-99-plan-x1y2");
  });
});
