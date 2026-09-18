/**
 * Tests for the /llmgateway-refresh extension command.
 *
 * Covers the fetch → map → write pipeline: HTTP errors must not write,
 * min-models/dry-run/print/require-key behavior, and env-vs-auth.json key
 * resolution. HOME is isolated to a temp dir so the default out path and
 * auth.json path land there instead of the real user's ~/.pi.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

// ── Helpers ────────────────────────────────────────────────────────────

function createMockPi(): {
  api: ExtensionAPI;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  sent: Array<{ customType?: string; content?: string; display?: boolean }>;
} {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: Array<{ customType?: string; content?: string; display?: boolean }> = [];

  const api: ExtensionAPI = {
    registerTool: () => {},
    registerCommand: (
      name: string,
      cmd: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, cmd);
    },
    on: () => {},
    sendMessage: (message: unknown) => {
      sent.push(message as { customType?: string; content?: string; display?: boolean });
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: {
      emit: () => {},
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;

  return { api, commands, sent };
}

async function loadExtension() {
  const mod = await import("../../extensions/llmgateway-refresh.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

function oneModel(): Record<string, unknown> {
  return {
    id: "m1",
    name: "M1",
    family: "openai",
    context_length: 128000,
    pricing: {
      prompt: "0.15e-6",
      completion: "0.6e-6",
      input_cache_read: "0.075e-6",
      input_cache_write: 0,
    },
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: [],
    providers: [],
  };
}

function okPayload(models: unknown[]): Record<string, unknown> {
  return { data: models };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("/llmgateway-refresh", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalKey: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "llmgw-refresh-"));
    originalHome = process.env.HOME;
    originalKey = process.env.LLMGATEWAY_API_KEY;
    process.env.HOME = tmpDir;
    delete process.env.LLMGATEWAY_API_KEY;
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalKey === undefined) delete process.env.LLMGATEWAY_API_KEY;
    else process.env.LLMGATEWAY_API_KEY = originalKey;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function invoke(args: string): Promise<{
    notify: ReturnType<typeof vi.fn>;
    sent: Array<{ customType?: string; content?: string; display?: boolean }>;
  }> {
    const { api, commands, sent } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const command = commands.get("llmgateway-refresh");
    expect(command).toBeDefined();

    const notify = vi.fn();
    const ctx = {
      cwd: tmpDir,
      ui: { notify },
      modelRegistry: { refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }) },
    };

    await command?.handler(args, ctx);
    return { notify, sent };
  }

  it("non-2xx response surfaces HTTP status and does not write models.json", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"unauthorized"}',
    });

    const { notify } = await invoke("");

    expect(notify).toHaveBeenCalled();
    const messages = notify.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("HTTP 401"))).toBe(true);
    expect(existsSync(join(tmpDir, ".pi", "agent", "models.json"))).toBe(false);
  });

  it("empty payload with default min-models refuses to write", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(okPayload([])),
    });

    const { notify } = await invoke("");

    expect(notify).toHaveBeenCalled();
    const messages = notify.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("refusing to write"))).toBe(true);
  });

  it("--dry-run reports the diff and writes nothing", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(okPayload([oneModel()])),
    });

    const { notify } = await invoke("--dry-run --min-models 1");

    expect(notify).toHaveBeenCalled();
    const messages = notify.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("would be written"))).toBe(true);
    expect(existsSync(join(tmpDir, ".pi", "agent", "models.json"))).toBe(false);
  });

  it("--print sends serialized JSON via sendMessage", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(okPayload([oneModel()])),
    });

    const { sent } = await invoke("--print --min-models 1");

    expect(sent).toHaveLength(1);
    const message = sent[0];
    if (message === undefined) throw new Error("expected a sent message");
    expect(message).toHaveProperty("display", true);
    expect(message.content).toContain('"providers"');
    expect(existsSync(join(tmpDir, ".pi", "agent", "models.json"))).toBe(false);
  });

  it("network failure surfaces the fetch error", async () => {
    mockFetch.mockRejectedValue(new Error("boom"));

    const { notify } = await invoke("");

    expect(notify).toHaveBeenCalled();
    const messages = notify.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("failed to fetch"))).toBe(true);
  });

  it("--require-key with no key fails without fetching", async () => {
    const { notify } = await invoke("--require-key --min-models 1");

    expect(notify).toHaveBeenCalled();
    const messages = notify.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("no API key found"))).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("prefers the LLMGATEWAY_API_KEY env var over auth.json", async () => {
    process.env.LLMGATEWAY_API_KEY = "sk-env";
    mkdirSync(join(tmpDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "agent", "auth.json"),
      JSON.stringify({ llmgateway: { type: "api_key", key: "sk-file" } }),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(okPayload([oneModel()])),
    });

    await invoke("--dry-run --min-models 1");

    const call = mockFetch.mock.calls[0];
    const headers = (call?.[1] as { headers?: Record<string, string> } | undefined)?.headers;
    expect(headers).toHaveProperty("Authorization", "Bearer sk-env");
  });

  it("falls back to auth.json when the env var is unset", async () => {
    mkdirSync(join(tmpDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "agent", "auth.json"),
      JSON.stringify({ llmgateway: { type: "api_key", key: "sk-file" } }),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(okPayload([oneModel()])),
    });

    await invoke("--dry-run --min-models 1");

    const call = mockFetch.mock.calls[0];
    const headers = (call?.[1] as { headers?: Record<string, string> } | undefined)?.headers;
    expect(headers).toHaveProperty("Authorization", "Bearer sk-file");
  });
});
