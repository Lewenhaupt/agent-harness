import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Create the mock spawn function before the vi.mock hoisting.
// Stores handler arrays so tests can simulate process events (a real
// EventEmitter supports multiple listeners per event).
const mockSpawn = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const mock = vi.fn().mockReturnValue({
    stdout: {
      on: vi.fn((_event: string, handler: (...args: unknown[]) => void) => {
        const list = handlers.get("stdout:data") ?? [];
        list.push(handler);
        handlers.set("stdout:data", list);
      }),
    },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    kill: vi.fn(),
  });
  // Expose handlers for test access
  (
    mock as unknown as {
      _handlers: Map<string, Array<(...args: unknown[]) => void>>;
    }
  )._handlers = handlers;
  return mock;
});

// Mock child_process at module level (hoisted by vitest)
vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

// Partially mock node:fs so the buildSpawnArgs throw-path test can make
// writeFileSync fail while every other fs call stays real. The hoisted holder
// keeps the mock stateless-by-default for the rest of the file.
const mockFsOverrides = vi.hoisted(() => ({
  writeShouldThrow: false,
  createdTempDirs: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: ((prefix: string) => {
      const dir = actual.mkdtempSync(prefix);
      mockFsOverrides.createdTempDirs.push(dir);
      return dir;
    }) as typeof actual.mkdtempSync,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (mockFsOverrides.writeShouldThrow) {
        throw new Error("disk full");
      }
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
  };
});

// Helper to access the handlers map stored on the mock
function getHandlers(): Map<string, Array<(...args: unknown[]) => void>> {
  return (
    mockSpawn as unknown as {
      _handlers: Map<string, Array<(...args: unknown[]) => void>>;
    }
  )._handlers;
}

/** Fire every registered handler for an event (EventEmitter semantics). */
function fireEvent(event: string, ...args: unknown[]): void {
  for (const handler of getHandlers().get(event) ?? []) {
    handler(...args);
  }
}

/** Simulate process completion by firing the "close" event. */
function simulateProcessComplete(exitCode = 0): void {
  fireEvent("close", exitCode);
}

/** Simulate stdout data arriving from the child. */
function simulateStdoutData(chunk: Buffer | string): void {
  fireEvent("stdout:data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

/** Simulate a spawn failure by firing the "error" event. */
function simulateSpawnError(message: string): void {
  fireEvent("error", new Error(message));
}

/** Drop all registered handlers between tests. */
function clearHandlers(): void {
  getHandlers().clear();
}

afterEach(() => {
  mockSpawn.mockClear();
  clearHandlers();
  vi.useRealTimers();
  mockFsOverrides.writeShouldThrow = false;
  mockFsOverrides.createdTempDirs.length = 0;
});

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

describe("buildSpawnArgs (bd-41)", () => {
  it("builds argv with session id, name, model, tools, prompt file, and task", async () => {
    const mod = await import("../spawn.js");
    const built = mod.buildSpawnArgs({
      model: "test-model",
      tools: ["read", "grep"],
      systemPrompt: "system prompt",
      task: "do the thing",
      sessionName: "belayd-bd-42-scout-r1",
    });
    try {
      expect(built).toHaveProperty("sessionId", "belayd-bd-42-scout-r1");
      expect(built).toHaveProperty("piBinary");

      const args = built.args;
      const sessionIdIdx = args.indexOf("--session-id");
      const nameIdx = args.indexOf("--name");
      const modelIdx = args.indexOf("--model");
      expect(sessionIdIdx).toBeGreaterThan(-1);
      expect(nameIdx).toBeGreaterThan(-1);
      expect(modelIdx).toBeGreaterThan(-1);
      expect(sessionIdIdx).toBeLessThan(modelIdx);
      expect(nameIdx).toBeLessThan(modelIdx);

      expect(args).toContain("--mode");
      expect(args).toContain("json");
      expect(args).toContain("--tools");
      expect(args[args.indexOf("--tools") + 1]).toBe("read,grep");

      const promptIdx = args.indexOf("--append-system-prompt");
      expect(promptIdx).toBeGreaterThan(-1);
      expect(args.at(-1)).toBe("do the thing");
    } finally {
      if (built.tempDir !== undefined) rmSync(built.tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to belayd-unknown-* session id when no sessionName is given", async () => {
    const mod = await import("../spawn.js");
    const built = mod.buildSpawnArgs({
      model: "test-model",
      tools: ["read"],
      systemPrompt: "test",
      task: "test",
    });
    try {
      expect(built.sessionId).toMatch(/^belayd-unknown-/);
      const nameIdx = built.args.indexOf("--name");
      expect(built.args[nameIdx + 1]).toBe(built.sessionId);
    } finally {
      if (built.tempDir !== undefined) rmSync(built.tempDir, { recursive: true, force: true });
    }
  });

  it("writes the system prompt into the temp file referenced by argv", async () => {
    const mod = await import("../spawn.js");
    const built = mod.buildSpawnArgs({
      model: "test-model",
      tools: ["read"],
      systemPrompt: "unique prompt payload",
      task: "test",
    });
    try {
      const promptIdx = built.args.indexOf("--append-system-prompt");
      const tempFile = built.args[promptIdx + 1];
      expect(tempFile).toBeTruthy();
      if (typeof tempFile === "string") {
        expect(existsSync(tempFile)).toBe(true);
        expect(readFileSync(tempFile, "utf-8")).toBe("unique prompt payload");
      }
    } finally {
      if (built.tempDir !== undefined) rmSync(built.tempDir, { recursive: true, force: true });
    }
  });

  it("removes the temp dir when the prompt write fails (no leak on the throw path)", async () => {
    // buildSpawnArgs must not leak a partially-created temp dir when
    // writeFileSync throws: it unlinks the file (ENOENT is swallowed) and
    // rmdir's the empty directory before rethrowing.
    mockFsOverrides.writeShouldThrow = true;
    try {
      const mod = await import("../spawn.js");
      expect(() =>
        mod.buildSpawnArgs({
          model: "test-model",
          tools: ["read"],
          systemPrompt: "prompt",
          task: "test",
          sessionName: "leak-check",
        }),
      ).toThrow("disk full");

      expect(mockFsOverrides.createdTempDirs).toHaveLength(1);
      const leakedDir = mockFsOverrides.createdTempDirs[0];
      if (leakedDir !== undefined) {
        expect(existsSync(leakedDir)).toBe(false);
      }
    } finally {
      mockFsOverrides.writeShouldThrow = false;
      mockFsOverrides.createdTempDirs.length = 0;
    }
  });
});

describe("launchAgentProcess (bd-41)", () => {
  it("returns a handle synchronously before the process closes", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    expect(handle).not.toBeInstanceOf(Promise);
    expect(handle).toHaveProperty("proc");
    expect(handle).toHaveProperty("stream");
    expect(handle).toHaveProperty("built");
    expect(handle).toHaveProperty("cleanup");

    handle.cleanup();
  });

  it("passes detached:true through to spawn when requested", async () => {
    const mod = await import("../spawn.js");
    const options = {
      model: "m",
      tools: ["read"],
      systemPrompt: "s",
      task: "t",
      detached: true,
    };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
    const spawnOptions = callArgs[2] as Record<string, unknown>;
    expect(spawnOptions.detached).toBe(true);

    handle.cleanup();
  });

  it("defaults detached to false", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
    const spawnOptions = callArgs[2] as Record<string, unknown>;
    expect(spawnOptions.detached).toBe(false);

    handle.cleanup();
  });

  it("kills the child immediately when the abort signal is already aborted at launch", async () => {
    vi.useFakeTimers();
    const mod = await import("../spawn.js");
    const controller = new AbortController();
    controller.abort();
    const options = {
      model: "m",
      tools: ["read"],
      systemPrompt: "s",
      task: "t",
      signal: controller.signal,
    };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);
    const proc = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value as {
      kill: ReturnType<typeof vi.fn>;
    };

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    // The already-aborted path must not arm the 5s SIGKILL backup timer.
    vi.advanceTimersByTime(10_000);
    expect(proc.kill).toHaveBeenCalledTimes(1);

    handle.cleanup();
  });
});

describe("collectSpawnResult (bd-41)", () => {
  it("flushes a trailing partial stdout line on close", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const promise = mod.collectSpawnResult(handle);
    const event = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "partial output" }] },
    });
    simulateStdoutData(event);
    simulateProcessComplete(0);

    const result = await promise;
    expect(result.content[0]).toHaveProperty("text", "partial output");
  });

  it("cleans up temp artifacts exactly once after resolving", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const promise = mod.collectSpawnResult(handle);
    simulateProcessComplete(0);
    await promise;

    if (built.tempFile !== undefined) expect(existsSync(built.tempFile)).toBe(false);
    if (built.tempDir !== undefined) expect(existsSync(built.tempDir)).toBe(false);

    // A second cleanup call is a no-op and must not throw.
    expect(() => handle.cleanup()).not.toThrow();
  });

  it("rejects when the child fails to spawn", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const promise = mod.collectSpawnResult(handle);
    simulateSpawnError("spawn failed");
    await expect(promise).rejects.toThrow("Failed to spawn pi: spawn failed");
  });

  it("still cleans up temp artifacts when the spawn error path rejects", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const promise = mod.collectSpawnResult(handle);
    simulateSpawnError("spawn failed");
    await expect(promise).rejects.toThrow("Failed to spawn pi");

    // The rejection path must run the same cleanup as the success path.
    if (built.tempFile !== undefined) expect(existsSync(built.tempFile)).toBe(false);
    if (built.tempDir !== undefined) expect(existsSync(built.tempDir)).toBe(false);
  });

  it("reads a signal-killed child as a non-success failure (exitCode 128)", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const promise = mod.collectSpawnResult(handle);
    fireEvent("close", null, "SIGTERM");

    const result = await promise;
    expect(result.details).toHaveProperty("exitCode", 128);
  });
});

describe("spawn abort handling (bd-41)", () => {
  it("sends SIGTERM then SIGKILL after the 5s grace period", async () => {
    vi.useFakeTimers();
    const mod = await import("../spawn.js");
    const controller = new AbortController();
    const options = {
      model: "m",
      tools: ["read"],
      systemPrompt: "s",
      task: "t",
      signal: controller.signal,
    };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);
    const proc = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value as {
      kill: ReturnType<typeof vi.fn>;
    };

    controller.abort();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    vi.advanceTimersByTime(5_000);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

    handle.cleanup();
  });
});
