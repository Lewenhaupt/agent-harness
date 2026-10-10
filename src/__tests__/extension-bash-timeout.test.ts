/**
 * Tests for the bash-timeout `tool_call` handler registered by
 * extensions/index.ts.
 *
 * The handler only mutates `event.input` in place and returns `{}`; it never
 * blocks. Handlers are captured directly (no pi internals mocked) so the test
 * exercises the same pure event→result path the extension registers.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

type CapturedHandler = (event: object, ctx: unknown) => unknown;

const handlers = new Map<string, CapturedHandler[]>();

interface ToolCallEventLike {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

function createMockEventBus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    on: (event: string, handler: (data: unknown) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    emit: (event: string, data: unknown) => {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

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
    events: createMockEventBus(),
  } as unknown as ExtensionAPI;
  return api;
}

function getToolCallHandlers(): CapturedHandler[] {
  const list = handlers.get("tool_call");
  if (list === undefined || list.length === 0) {
    throw new Error("no tool_call handler registered");
  }
  return list;
}

async function registerHarness(): Promise<void> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  register(createMockPi());
}

const ctx = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "bash-timeout-session" },
};

/** Run every registered tool_call handler and collect their results. */
function runToolCallHandlers(event: ToolCallEventLike): Array<{ block?: boolean }> {
  return getToolCallHandlers().map((handler) => handler(event, ctx) as { block?: boolean });
}

let toolCallId = 0;

function bashEvent(input: Record<string, unknown>): ToolCallEventLike {
  toolCallId += 1;
  return { type: "tool_call", toolCallId: `bash-${toolCallId}`, toolName: "bash", input };
}

beforeEach(async () => {
  await registerHarness();
});

describe("bash timeout tool_call handler", () => {
  it("patches a missing timeout to the default", () => {
    const event = bashEvent({ command: "sleep 1" });
    runToolCallHandlers(event);
    expect(event.input).toHaveProperty("timeout", 600);
  });

  it("clamps a timeout above the cap", () => {
    const event = bashEvent({ command: "sleep 1", timeout: 3600 });
    runToolCallHandlers(event);
    expect(event.input).toHaveProperty("timeout", 1800);
  });

  it("preserves an in-range timeout", () => {
    const event = bashEvent({ command: "sleep 1", timeout: 60 });
    runToolCallHandlers(event);
    expect(event.input).toHaveProperty("timeout", 60);
  });

  it("accepts the legacy Bash casing", () => {
    toolCallId += 1;
    const event: ToolCallEventLike = {
      type: "tool_call",
      toolCallId: `bash-upper-${toolCallId}`,
      toolName: "Bash",
      input: { command: "sleep 1", timeout: 9999 },
    };
    runToolCallHandlers(event);
    expect(event.input).toHaveProperty("timeout", 1800);
  });

  it("leaves a non-bash tool input untouched", () => {
    toolCallId += 1;
    const event: ToolCallEventLike = {
      type: "tool_call",
      toolCallId: `read-${toolCallId}`,
      toolName: "read",
      input: { path: "/tmp/file.txt" },
    };
    runToolCallHandlers(event);
    expect(event.input).toEqual({ path: "/tmp/file.txt" });
    expect(event.input).not.toHaveProperty("timeout");
  });

  it("never blocks a call", () => {
    for (const result of runToolCallHandlers(bashEvent({ command: "ls" }))) {
      expect(result).not.toHaveProperty("block");
    }
    for (const result of runToolCallHandlers(bashEvent({ command: "ls", timeout: 9999 }))) {
      expect(result).not.toHaveProperty("block");
    }
  });
});
