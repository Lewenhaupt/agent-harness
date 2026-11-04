/**
 * bd-187: a broken registry must not abort the extension's `session_start`
 * handler. Telemetry flush, session-state reset and run tracking still have to
 * run; providers stay direct and the failure is warned once per session.
 *
 * The env isolation is restored explicitly (W4): ~30 other test files read these
 * variables, and an un-restored value leaks into the rest of the vitest worker.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "BELAYD_MODEL_COOLDOWN_FILE",
  "BELAYD_MODEL_STATE_FILE",
  "BELAYD_MODEL_STATE_DIRECT_PROVIDER",
  "BELAYD_MODEL_STATE_WRAPPER",
  "BELAYD_MODEL_CAPACITY_LIMIT",
  "BELAYD_MODEL_LEASE_TTL_MS",
] as const;

const previousEnv = new Map<string, string | undefined>();
const tempDirs: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-provider-registration-"));
  tempDirs.push(dir);
  return dir;
}

interface MockPi {
  api: ExtensionAPI;
  eventHandlers: Map<string, (...args: unknown[]) => void>;
}

function createMockPi(): MockPi {
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  // pi runs every `session_start` handler in registration order; keep the full
  // list so a handler registered after the workflow commands (the bd-257 session
  // model pre-flight) still runs in this mock.
  const sessionStartHandlers: Array<(...args: unknown[]) => void> = [];
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let activeTools: string[] = [];
  const api = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event !== "session_start") {
        eventHandlers.set(event, handler);
        return;
      }
      sessionStartHandlers.push(handler);
      eventHandlers.set(event, (...args: unknown[]) => {
        for (const registered of sessionStartHandlers) registered(...args);
      });
    },
    sendMessage: () => {},
    sendUserMessage: () => {},
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => {
      activeTools = next;
    },
    registerProvider: () => {},
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        const set = listeners.get(channel) ?? new Set<(data: unknown) => void>();
        set.add(handler);
        listeners.set(channel, set);
        return () => {
          set.delete(handler);
        };
      },
    },
  } as unknown as ExtensionAPI;
  return { api, eventHandlers };
}

function contextWithRegistryFailure(
  cwd: string,
  message: string,
  sessionId: string,
): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "belayd-orchestrator",
      getSessionFile: () => undefined,
    },
    modelRegistry: {
      getAll: () => {
        throw new Error(message);
      },
      getProvider: () => undefined,
    },
  } as unknown as ExtensionContext;
}

describe("extension provider registration failure (bd-187 review)", () => {
  it("keeps the rest of session_start running and warns exactly once", async () => {
    // Set the isolated cooldown path before the extension module is loaded.
    process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tempDir(), "model-cooldowns.json");
    const cwd = tempDir();
    const mod = await import("../../extensions/index.js");
    const factory = mod.default;
    const { getSessionState } = mod;

    const pi = createMockPi();
    factory(pi.api);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = contextWithRegistryFailure(cwd, "registry iteration failed", "test-session-id");

    const state = getSessionState(ctx);
    state.gateActive = true;

    const handler = pi.eventHandlers.get("session_start");
    expect(handler).toBeDefined();
    handler?.({}, ctx);

    // The handler survived the throwing registry and completed its reset work.
    expect(getSessionState(ctx).gateActive).toBe(false);
    const registrationWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes("model-state provider registration failed"),
    );
    expect(registrationWarnings).toHaveLength(1);
    expect(String(registrationWarnings[0]?.[0])).toContain("providers stay direct");
    warn.mockRestore();
  });

  it("warns again on a later session_start with a different failure", async () => {
    process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tempDir(), "model-cooldowns.json");
    const cwd = tempDir();
    const mod = await import("../../extensions/index.js");
    const pi = createMockPi();
    mod.default(pi.api);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = pi.eventHandlers.get("session_start");
    expect(handler).toBeDefined();

    handler?.({}, contextWithRegistryFailure(cwd, "first registry failure", "session-one"));
    handler?.({}, contextWithRegistryFailure(cwd, "second registry failure", "session-two"));

    const registrationWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("model-state provider registration failed"));
    expect(registrationWarnings).toHaveLength(2);
    expect(registrationWarnings[0]).toContain("first registry failure");
    expect(registrationWarnings[1]).toContain("second registry failure");
    warn.mockRestore();
  });
});
