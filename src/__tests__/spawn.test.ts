import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Mock child_process at module level (hoisted by vitest). `execFileSync` is
// kept real because the AWS sandbox plan (src/aws-broker/plan.ts) resolves the
// git toplevel with it; only `spawn` is faked.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

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

/**
 * Apply env overrides on `process.env` and return a restore callback so tests
 * can guarantee cleanup in a `finally` block.
 */
function applyProcessEnv(entries: Record<string, string>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
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

describe("launchAgentProcess env (W5)", () => {
  afterEach(() => {
    mockSpawn.mockClear();
  });

  it("strips BELAYD_SHELL_ACTIVE but preserves HOME and PATH", async () => {
    const original = process.env.BELAYD_SHELL_ACTIVE;
    process.env.BELAYD_SHELL_ACTIVE = "1";
    try {
      const mod = await import("../spawn.js");
      const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
      const built = mod.buildSpawnArgs(options);
      const handle = mod.launchAgentProcess(options, built);

      const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
      const spawnOptions = callArgs[2] as { env: NodeJS.ProcessEnv };
      expect(spawnOptions.env).not.toHaveProperty("BELAYD_SHELL_ACTIVE");
      expect(spawnOptions.env.HOME).toBe(process.env.HOME);
      expect(spawnOptions.env.PATH).toBe(process.env.PATH);

      handle.cleanup();
    } finally {
      if (original === undefined) {
        delete process.env.BELAYD_SHELL_ACTIVE;
      } else {
        process.env.BELAYD_SHELL_ACTIVE = original;
      }
    }
  });

  it("strips direnv per-directory state from process.env and options.env, preserving user config and unrelated vars", async () => {
    // Only the per-directory STATE keys are stripped. USER-CONFIG keys and
    // unknown DIRENV_* vars must survive, proving this is an explicit list and
    // not a prefix sweep.
    const stateKeys = [
      "DIRENV_DIR",
      "DIRENV_FILE",
      "DIRENV_DIFF",
      "DIRENV_WATCHES",
      "DIRENV_LAYOUT_DIR",
    ] as const;
    const userConfigKeys = [
      "DIRENV_CONFIG",
      "DIRENV_WARN_TIMEOUT",
      "DIRENV_LOG_FORMAT",
      "DIRENV_MAX_DEPTH",
    ] as const;
    const restoreEnv = applyProcessEnv({
      ...Object.fromEntries(stateKeys.map((key) => [key, `/stale/parent/${key}`])),
      ...Object.fromEntries(userConfigKeys.map((key) => [key, `parent-${key}`])),
    });
    try {
      // Non-vacuous guard: every state key must actually be present in the
      // input, otherwise the strip assertions below would be hollow. options.env
      // overrides these values, so a surviving options.env key would still show.
      for (const key of stateKeys) expect(process.env[key]).toBeDefined();

      const mod = await import("../spawn.js");
      const options = {
        model: "m",
        tools: ["read"],
        systemPrompt: "s",
        task: "t",
        env: {
          DIRENV_DIFF: "corrupt",
          DIRENV_WATCHES: "stale",
          DIRENV_UNKNOWN_KEY: "kept",
          BELAYD_EXTRA: "x",
        },
      };
      const built = mod.buildSpawnArgs(options);
      const handle = mod.launchAgentProcess(options, built);

      expect(mockSpawn).toHaveBeenCalled();
      const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
      const spawnOptions = callArgs[2] as { env: NodeJS.ProcessEnv };

      for (const key of stateKeys) expect(spawnOptions.env).not.toHaveProperty(key);
      expect(spawnOptions.env.HOME).toBe(process.env.HOME);
      expect(spawnOptions.env.PATH).toBe(process.env.PATH);
      for (const key of userConfigKeys) expect(spawnOptions.env[key]).toBe(process.env[key]);
      expect(spawnOptions.env.DIRENV_UNKNOWN_KEY).toBe("kept");
      expect(spawnOptions.env.BELAYD_EXTRA).toBe("x");

      handle.cleanup();
    } finally {
      restoreEnv();
    }
  });

  it("does not leak the marker from options.env either", async () => {
    const mod = await import("../spawn.js");
    const options = {
      model: "m",
      tools: ["read"],
      systemPrompt: "s",
      task: "t",
      env: { BELAYD_SHELL_ACTIVE: "1", BELAYD_EXTRA: "x" },
    };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
    const spawnOptions = callArgs[2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env).not.toHaveProperty("BELAYD_SHELL_ACTIVE");
    expect(spawnOptions.env.BELAYD_EXTRA).toBe("x");

    handle.cleanup();
  });
});

describe("launchAgentProcess BEADS_ACTOR (bd-150)", () => {
  /** env handed to the most recent spawn, i.e. the child's effective env. */
  function lastSpawnEnv(): NodeJS.ProcessEnv {
    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
    return (callArgs[2] as { env: NodeJS.ProcessEnv }).env;
  }

  /** Run one launch with the inherited BEADS_ACTOR removed, restoring it after. */
  async function withInheritedActorAbsent(run: () => Promise<void>): Promise<void> {
    const inherited = process.env.BEADS_ACTOR;
    delete process.env.BEADS_ACTOR;
    try {
      await run();
    } finally {
      if (inherited !== undefined) process.env.BEADS_ACTOR = inherited;
    }
  }

  it("derives the actor from a phase session name so raw bash bd calls are attributed", async () => {
    await withInheritedActorAbsent(async () => {
      const mod = await import("../spawn.js");
      const options = {
        model: "m",
        tools: ["read"],
        systemPrompt: "s",
        task: "t",
        sessionName: "belayd-bd-42-sub-implement-run1",
      };
      const handle = mod.launchAgentProcess(options, mod.buildSpawnArgs(options));
      expect(lastSpawnEnv().BEADS_ACTOR).toBe("belayd:bd-42:implement");
      handle.cleanup();
    });
  });

  it("leaves the inherited value alone when the session name resolves to no actor", async () => {
    await withInheritedActorAbsent(async () => {
      const mod = await import("../spawn.js");
      const options = {
        model: "m",
        tools: ["read"],
        systemPrompt: "s",
        task: "t",
        sessionName: "belayd-planning-sub-scout-abc123",
      };
      const handle = mod.launchAgentProcess(options, mod.buildSpawnArgs(options));
      expect(lastSpawnEnv()).not.toHaveProperty("BEADS_ACTOR");
      handle.cleanup();
    });
  });

  it("lets an explicit options.env.BEADS_ACTOR win", async () => {
    await withInheritedActorAbsent(async () => {
      const mod = await import("../spawn.js");
      const options = {
        model: "m",
        tools: ["read"],
        systemPrompt: "s",
        task: "t",
        sessionName: "belayd-bd-42-sub-implement-run1",
        env: { BEADS_ACTOR: "custom:actor" },
      };
      const handle = mod.launchAgentProcess(options, mod.buildSpawnArgs(options));
      expect(lastSpawnEnv().BEADS_ACTOR).toBe("custom:actor");
      handle.cleanup();
    });
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

  it("counts executed tool calls from tool_execution_end events (pi 1.0.2)", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const promise = mod.collectSpawnResult(handle);
    simulateStdoutData(
      `${JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "read" })}\n`,
    );
    simulateStdoutData(
      `${JSON.stringify({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash" })}\n`,
    );
    simulateProcessComplete(0);

    const result = await promise;
    expect(result.details.usage).toHaveProperty("toolCalls", 2);
  });

  it("does not double count an assistant toolCall block and its execution event", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const promise = mod.collectSpawnResult(handle);
    simulateStdoutData(
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read" }],
          usage: { input: 1, output: 1 },
        },
      })}\n`,
    );
    simulateStdoutData(
      `${JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "read" })}\n`,
    );
    simulateProcessComplete(0);

    const result = await promise;
    expect(result.details.usage).toHaveProperty("toolCalls", 1);
    expect(result.details.usage).toHaveProperty("turns", 1);
  });

  it("counts an assistant toolCall that never produced an execution event", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const promise = mod.collectSpawnResult(handle);
    simulateStdoutData(
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c9", name: "bash" }],
          usage: { input: 1, output: 1 },
        },
      })}\n`,
    );
    simulateProcessComplete(0);

    const result = await promise;
    expect(result.details.usage).toHaveProperty("toolCalls", 1);
  });

  it("counts a legacy tool_result_end event", async () => {
    const mod = await import("../spawn.js");
    const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
    const built = mod.buildSpawnArgs(options);
    const handle = mod.launchAgentProcess(options, built);

    const promise = mod.collectSpawnResult(handle);
    simulateStdoutData(
      `${JSON.stringify({
        type: "tool_result_end",
        message: { role: "toolResult", toolCallId: "legacy-1" },
      })}\n`,
    );
    simulateProcessComplete(0);

    const result = await promise;
    expect(result.details.usage).toHaveProperty("toolCalls", 1);
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

describe("buildSpawnArgs resumeSession (bd-74)", () => {
  let sessionDir = "";
  const originalEnv = { ...process.env };

  afterEach(() => {
    if (sessionDir !== "") rmSync(sessionDir, { recursive: true, force: true });
    const prior = originalEnv.PI_CODING_AGENT_SESSION_DIR;
    if (prior === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prior;
  });

  it("omits --append-system-prompt but keeps --session-id and the task when resuming", async () => {
    sessionDir = mkdtempSync(join(tmpdir(), "belayd-spawn-resume-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    writeFileSync(
      join(sessionDir, "2024-01-15T10-00-00-000Z_belayd-resume-me.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "belayd-resume-me" })}\n`,
    );

    const mod = await import("../spawn.js");
    const built = mod.buildSpawnArgs({
      model: "test-model",
      tools: ["read"],
      systemPrompt: "system prompt",
      task: "retry task text",
      sessionName: "belayd-resume-me",
      resumeSession: true,
    });

    const sessionIdIdx = built.args.indexOf("--session-id");
    expect(sessionIdIdx).toBeGreaterThan(-1);
    expect(built.args[sessionIdIdx + 1]).toBe("belayd-resume-me");
    expect(built.args).not.toContain("--append-system-prompt");
    expect(built.args.at(-1)).toBe("retry task text");
    expect(built.tempDir).toBeUndefined();
    expect(built.tempFile).toBeUndefined();
  });

  it("falls back to fresh with the system prompt when the session is missing", async () => {
    sessionDir = mkdtempSync(join(tmpdir(), "belayd-spawn-resume-missing-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = await import("../spawn.js");
      const built = mod.buildSpawnArgs({
        model: "test-model",
        tools: ["read"],
        systemPrompt: "system prompt",
        task: "retry task text",
        sessionName: "belayd-not-there",
        resumeSession: true,
      });
      try {
        expect(built.args).toContain("--append-system-prompt");
        expect(built.args.at(-1)).toBe("retry task text");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("resume requested"));
      } finally {
        if (built.tempDir !== undefined) rmSync(built.tempDir, { recursive: true, force: true });
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("suppresses the resume-unavailable warning when spawn-loop-only flag is set", async () => {
    sessionDir = mkdtempSync(join(tmpdir(), "belayd-spawn-resume-quiet-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = await import("../spawn.js");
      const built = mod.buildSpawnArgs({
        model: "test-model",
        tools: ["read"],
        systemPrompt: "system prompt",
        task: "retry task text",
        sessionName: "belayd-not-there",
        resumeSession: true,
        suppressResumeWarning: true,
      });
      try {
        expect(built.args).toContain("--append-system-prompt");
        expect(warn).not.toHaveBeenCalled();
      } finally {
        if (built.tempDir !== undefined) rmSync(built.tempDir, { recursive: true, force: true });
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("launchAgentProcess AWS sandbox (bd-125)", () => {
  let sandboxRoot: string;

  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "belayd-spawn-aws-"));
  });

  afterEach(() => {
    mockSpawn.mockClear();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  /**
   * Hermetic AWS fixture: a fake `git` that reports the worktree root, a fake
   * `bwrap` so the plan resolves, an operator allowlist under XDG_CONFIG_HOME,
   * and the repo's own `.belayd/aws.yaml`.
   */
  function writeAwsFixture(): { repo: string; home: string; env: Record<string, string> } {
    const repo = join(sandboxRoot, "repo");
    const bin = join(sandboxRoot, "bin");
    const configHome = join(sandboxRoot, "config");
    const runtimeDir = join(sandboxRoot, "runtime");
    const home = join(sandboxRoot, "home");
    mkdirSync(join(repo, ".belayd"), { recursive: true });
    mkdirSync(join(configHome, "belayd"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(repo, ".belayd", "aws.yaml"), "profile: agent-readonly\n");
    writeFileSync(
      join(configHome, "belayd", "aws.yaml"),
      `region: eu-north-1\nscopes:\n  - worktree: ${repo}\n    profiles: [agent-readonly]\n`,
    );
    writeFileSync(join(bin, "bwrap"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' '${repo}'\n`, { mode: 0o755 });
    // The broker CLI the plan resolver calls to start the scope socket; a
    // fixed path keeps the spawn tests independent of a live daemon.
    const brokerCli = join(bin, "belayd-aws");
    writeFileSync(brokerCli, `#!/bin/sh\nprintf '%s\\n' '${runtimeDir}/scope.sock'\n`, {
      mode: 0o755,
    });
    return {
      repo,
      home,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_RUNTIME_DIR: runtimeDir,
        BELAYD_AWS_BIN: brokerCli,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    };
  }

  it("scrubs every AWS credential key from the child environment", async () => {
    const restore = applyProcessEnv({
      XDG_CONFIG_HOME: join(sandboxRoot, "empty-config"),
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_SECURITY_TOKEN: "token",
      AWS_PROFILE: "operator",
      AWS_DEFAULT_PROFILE: "operator",
      AWS_CONFIG_FILE: "/home/hugo/.aws/config",
      AWS_SHARED_CREDENTIALS_FILE: "/home/hugo/.aws/credentials",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials",
    });
    try {
      const mod = await import("../spawn.js");
      const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
      const built = mod.buildSpawnArgs(options);
      const handle = mod.launchAgentProcess(options, built);

      const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
      const spawnOptions = callArgs[2] as { env: NodeJS.ProcessEnv };
      for (const key of [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SECURITY_TOKEN",
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      ]) {
        expect(spawnOptions.env).not.toHaveProperty(key);
      }
      expect(spawnOptions.env).not.toHaveProperty("BELAYD_SANDBOX_ACTIVE");
      handle.cleanup();
    } finally {
      restore();
    }
  });

  it("spawns the raw binary when the worktree has no AWS plan", async () => {
    const restore = applyProcessEnv({ XDG_CONFIG_HOME: join(sandboxRoot, "empty-config") });
    try {
      const mod = await import("../spawn.js");
      const options = { model: "m", tools: ["read"], systemPrompt: "s", task: "t" };
      const built = mod.buildSpawnArgs(options);
      const handle = mod.launchAgentProcess(options, built);

      const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
      expect(callArgs[0]).toBe(built.piBinary);
      const spawnOptions = callArgs[2] as { env: NodeJS.ProcessEnv };
      expect(spawnOptions.env).not.toHaveProperty("BELAYD_SANDBOX_ACTIVE");
      handle.cleanup();
    } finally {
      restore();
    }
  });

  it("spawns through bwrap with the plan argv and marks the child as sandboxed", async () => {
    const fixture = writeAwsFixture();
    const restore = applyProcessEnv(fixture.env);
    try {
      const mod = await import("../spawn.js");
      const options = {
        model: "m",
        tools: ["read"],
        systemPrompt: "s",
        task: "t",
        cwd: fixture.repo,
      };
      const built = mod.buildSpawnArgs(options);
      const handle = mod.launchAgentProcess(options, built);

      const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
      expect(String(callArgs[0])).toBe(join(sandboxRoot, "bin", "bwrap"));
      const argv = callArgs[1] as string[];
      expect(argv).toContain("--unshare-user");
      expect(argv).toContain("--tmpfs");
      expect(argv).toContain(join(fixture.home, ".aws"));
      expect(argv).toContain("AWS_PROFILE");
      expect(argv).toContain("AWS_REGION");
      expect(argv).toContain("eu-north-1");
      // The pi binary and its args follow the sandbox separator.
      const separator = argv.indexOf("--");
      expect(separator).toBeGreaterThan(0);
      expect(argv.slice(separator + 1)).toEqual([built.piBinary, ...built.args]);

      const spawnOptions = callArgs[2] as { env: NodeJS.ProcessEnv; cwd: string };
      expect(spawnOptions.env.BELAYD_SANDBOX_ACTIVE).toBe("1");
      expect(spawnOptions.cwd).toBe(fixture.repo);
      handle.cleanup();
    } finally {
      restore();
    }
  });

  it("runs unwrapped when a plan is refused (fail closed, never a default profile)", async () => {
    const fixture = writeAwsFixture();
    writeFileSync(join(fixture.repo, ".belayd", "aws.yaml"), "profile: agent-deploy\n");
    const restore = applyProcessEnv(fixture.env);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = await import("../spawn.js");
      const options = {
        model: "m",
        tools: ["read"],
        systemPrompt: "s",
        task: "t",
        cwd: fixture.repo,
      };
      const built = mod.buildSpawnArgs(options);
      const handle = mod.launchAgentProcess(options, built);

      const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
      expect(callArgs[0]).toBe(built.piBinary);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("AWS sandbox refused"));
      const spawnOptions = callArgs[2] as { env: NodeJS.ProcessEnv };
      expect(spawnOptions.env).not.toHaveProperty("BELAYD_SANDBOX_ACTIVE");
      handle.cleanup();
    } finally {
      warn.mockRestore();
      restore();
    }
  });

  it("still sandboxes (and warns) when the broker CLI is unavailable", async () => {
    const fixture = writeAwsFixture();
    const restore = applyProcessEnv({ ...fixture.env, BELAYD_AWS_BIN: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = await import("../spawn.js");
      const options = {
        model: "m",
        tools: ["read"],
        systemPrompt: "s",
        task: "t",
        cwd: fixture.repo,
      };
      const built = mod.buildSpawnArgs(options);
      const handle = mod.launchAgentProcess(options, built);

      const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1] as unknown[];
      // The mask is the security property: a down broker must never un-sandbox.
      expect(String(callArgs[0])).toBe(join(sandboxRoot, "bin", "bwrap"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("AWS broker unavailable"));
      handle.cleanup();
    } finally {
      warn.mockRestore();
      restore();
    }
  });
});
