/**
 * Tests for the managed instruction-group warning dedupe in extensions/index.ts.
 *
 * The collector can legitimately stay empty forever in a pi with no
 * instruction-group extension at all, so `NO_GROUP_REGISTERED_WARNING` is
 * logged at most once per session. Other gate warnings signal a state change
 * and must keep logging every turn. Handlers are captured directly (no pi
 * internals mocked) so the test exercises the same closure the extension
 * registers.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_GROUP_REGISTERED_WARNING } from "../../src/instruction-groups.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

type CapturedHandler = (event: object, ctx: unknown) => unknown;

const handlers = new Map<string, CapturedHandler[]>();

function createMockPi(): ExtensionAPI {
  handlers.clear();
  const api = {
    on: (event: string, handler: CapturedHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    getCommands: () => [],
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return api;
}

async function registerHarness(): Promise<void> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  register(createMockPi());
}

const ctx = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "instruction-groups-session" },
};

function beforeAgentStartEvent(selectedTools: string[]): object {
  return {
    type: "before_agent_start",
    systemPromptOptions: { sections: {}, selectedTools },
  };
}

/** Run every registered before_agent_start handler like pi does. */
async function runBeforeAgentStart(selectedTools: string[]): Promise<void> {
  for (const handler of handlers.get("before_agent_start") ?? []) {
    await handler(beforeAgentStartEvent(selectedTools), ctx);
  }
}

/** console.warn lines emitted for the instruction-group gate. */
function gateWarnings(warnSpy: { mock: { calls: unknown[][] } }): string[] {
  return warnSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("instruction-group"));
}

beforeEach(async () => {
  await registerHarness();
});

describe("instruction-group warning dedupe", () => {
  it("warns once per session when no group ever registers", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runBeforeAgentStart(["bash"]);
      await runBeforeAgentStart(["bash"]);

      const lines = gateWarnings(warnSpy).filter((line) =>
        line.includes(NO_GROUP_REGISTERED_WARNING),
      );
      expect(lines).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps logging non-dedupe gate warnings every turn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // An empty allowlist skips the gate with a different reason every turn.
      await runBeforeAgentStart([]);
      await runBeforeAgentStart([]);

      const lines = gateWarnings(warnSpy).filter((line) =>
        line.includes("instruction-group gate skipped: no-selected-tools"),
      );
      expect(lines).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * An independent mock pi that captures handlers in its own map. Registering two
 * of these shares no state, which is how a module-scope dedupe flag (the
 * `claim-registry.ts` leak bug class) would be observed as a single warning.
 */
function createIndependentPi(): { api: ExtensionAPI; handlers: Map<string, CapturedHandler[]> } {
  const captured = new Map<string, CapturedHandler[]>();
  const api = {
    on: (event: string, handler: CapturedHandler) => {
      const list = captured.get(event) ?? [];
      list.push(handler);
      captured.set(event, list);
      return () => {};
    },
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    getCommands: () => [],
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, handlers: captured };
}

async function runAllHandlers(handlers: CapturedHandler[], event: object): Promise<void> {
  for (const handler of handlers) {
    await handler(event, ctx);
  }
}

describe("instruction-group warning dedupe scoping", () => {
  it("keeps the no-group dedupe flag per extension instance, not at module scope", async () => {
    const mod = await import("../../extensions/index.js");
    const register = mod.default as (pi: ExtensionAPI) => void;

    const first = createIndependentPi();
    const second = createIndependentPi();
    register(first.api);
    register(second.api);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const instance of [first, second]) {
        const handlers = instance.handlers.get("before_agent_start") ?? [];
        await runAllHandlers(handlers, beforeAgentStartEvent(["bash"]));
        await runAllHandlers(handlers, beforeAgentStartEvent(["bash"]));
      }

      const lines = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes(NO_GROUP_REGISTERED_WARNING));
      // Two instances -> two warnings; a module-level flag would yield one.
      expect(lines).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
