/**
 * Tests for extensions/honcho-memory.ts.
 *
 * Uses a mock ExtensionAPI plus a stubbed global `fetch`. HOME is isolated so
 * the auth.json fallback path never reads the real user's ~/.pi.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HONCHO_MEMORY_LOAD_MARKER = "__belayd_honcho_memory_loaded__";

// ── Mocks ──────────────────────────────────────────────────────────────

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

// ── Helpers ────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function createMockPi(): {
  api: ExtensionAPI;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  const api: ExtensionAPI = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: {
      emit: () => {},
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;

  return { api, handlers };
}

function createCtx(
  sessionName: string,
  agentId = "belayd-implementer",
): {
  sessionManager: { getSessionId: () => string; getSessionName: () => string };
  model: { id: string };
} {
  return {
    sessionManager: {
      getSessionId: () => `session-for-${sessionName}`,
      getSessionName: () => sessionName,
    },
    model: { id: agentId },
  };
}

async function loadExtension() {
  const mod = await import("../../extensions/honcho-memory.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

function assistantEvent(text: string): {
  messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
} {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  };
}

function okJsonResponse(payload: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  } as Response;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("honcho-memory extension", () => {
  let tmpHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "honcho-memory-ext-"));
    saved = {
      HOME: process.env.HOME,
      HONCHO_API_KEY: process.env.HONCHO_API_KEY,
      HONCHO_ENABLED: process.env.HONCHO_ENABLED,
      HONCHO_WORKSPACE_ID: process.env.HONCHO_WORKSPACE_ID,
      HONCHO_PEER_ID: process.env.HONCHO_PEER_ID,
      HONCHO_BASE_URL: process.env.HONCHO_BASE_URL,
    };
    process.env.HOME = tmpHome;
    delete process.env.HONCHO_API_KEY;
    delete process.env.HONCHO_ENABLED;
    delete process.env.HONCHO_WORKSPACE_ID;
    delete process.env.HONCHO_PEER_ID;
    delete process.env.HONCHO_BASE_URL;
    delete (globalThis as Record<string, unknown>)[HONCHO_MEMORY_LOAD_MARKER];
    mockFetch.mockReset();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("is a no-op when no API key is present", async () => {
    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    expect(handlers.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("loads the key from auth.json when env is unset", async () => {
    mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".pi", "agent", "auth.json"),
      JSON.stringify({ honcho: { type: "api_key", key: "sk-file" } }),
    );
    mockFetch.mockResolvedValue(okJsonResponse({ summary: "memory" }));

    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const beforeHandler = handlers.get("before_agent_start");
    expect(beforeHandler).toBeDefined();
    const event = { prompt: "do work", systemPrompt: "SYSTEM" };
    const result = (await beforeHandler?.(event, createCtx("belayd-bd-42-sub-implement-abc"))) as {
      systemPrompt?: string;
    };
    expect(result.systemPrompt).toContain("SYSTEM");
    expect(result.systemPrompt).toContain("memory");
  });

  it("appends memory to systemPrompt when context is present", async () => {
    process.env.HONCHO_API_KEY = "sk-env";
    mockFetch.mockResolvedValue(okJsonResponse({ summary: "prior plan details" }));

    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const beforeHandler = handlers.get("before_agent_start");
    expect(beforeHandler).toBeDefined();
    const result = (await beforeHandler?.(
      { prompt: "do", systemPrompt: "BASE" },
      createCtx("belayd-bd-42-sub-implement-abc"),
    )) as { systemPrompt?: string };

    expect(result).toHaveProperty("systemPrompt");
    expect(result.systemPrompt).toContain("BASE");
    expect(result.systemPrompt).toContain("## Project memory (Honcho)");
    expect(result.systemPrompt).toContain("prior plan details");
  });

  it("returns {} when context is empty", async () => {
    process.env.HONCHO_API_KEY = "sk-env";
    mockFetch.mockResolvedValue(okJsonResponse({}));

    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const beforeHandler = handlers.get("before_agent_start");
    const result = (await beforeHandler?.(
      { prompt: "do", systemPrompt: "BASE" },
      createCtx("belayd-bd-42-sub-implement-abc"),
    )) as { systemPrompt?: string };

    expect(result.systemPrompt).toBeUndefined();
  });

  it("returns {} when retrieval fails", async () => {
    process.env.HONCHO_API_KEY = "sk-env";
    mockFetch.mockRejectedValue(new Error("network down"));

    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const beforeHandler = handlers.get("before_agent_start");
    const result = (await beforeHandler?.(
      { prompt: "do", systemPrompt: "BASE" },
      createCtx("belayd-bd-42-sub-implement-abc"),
    )) as { systemPrompt?: string };

    expect(result.systemPrompt).toBeUndefined();
  });

  it("does not write for non-belayd sessions", async () => {
    process.env.HONCHO_API_KEY = "sk-env";
    mockFetch.mockResolvedValue(okJsonResponse({}));

    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const agentEnd = handlers.get("agent_end");
    await agentEnd?.(assistantEvent("x".repeat(200)), createCtx("some-other-session"));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not write tiny sub-agent output", async () => {
    process.env.HONCHO_API_KEY = "sk-env";
    mockFetch.mockResolvedValue(okJsonResponse({}));

    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const agentEnd = handlers.get("agent_end");
    await agentEnd?.(assistantEvent("short"), createCtx("belayd-bd-42-sub-implement-abc"));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("writes final assistant text once with metadata for a valid sub-agent run", async () => {
    process.env.HONCHO_API_KEY = "sk-env";
    mockFetch.mockResolvedValue(okJsonResponse({}));

    const { api, handlers } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const agentEnd = handlers.get("agent_end");
    expect(agentEnd).toBeDefined();
    await agentEnd?.(
      assistantEvent("x".repeat(200)),
      createCtx("belayd-bd-42-sub-implement-abc", "belayd-implementer"),
    );

    // The before_agent_start hook is not invoked in this test, so the only
    // fetch is the write.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toContain("/messages");
    const init = call?.[1] as { method?: string; body?: string } | undefined;
    expect(init?.method).toBe("POST");

    const body = JSON.parse(init?.body ?? "{}") as {
      messages: Array<{ content: string; peer_id: string; metadata?: Record<string, string> }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toHaveProperty("metadata.source", "belayd");
    expect(body.messages[0]).toHaveProperty("metadata.phase", "implement");
    expect(body.messages[0]).toHaveProperty("metadata.taskId", "bd-42");
    expect(body.messages[0]).toHaveProperty(
      "metadata.sessionName",
      "belayd-bd-42-sub-implement-abc",
    );
    expect(body.messages[0]).toHaveProperty("metadata.agent", "belayd-implementer");
  });
});
