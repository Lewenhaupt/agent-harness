/**
 * Tests for src/honcho-memory/client.ts.
 *
 * Pure request builders asserted directly; the executor uses an injected
 * `fetch` seam (vi.fn()) so network failures are values, not throws.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildCreateMessagesRequest,
  buildGetContextRequest,
  createHonchoClient,
  type HonchoMessage,
} from "../honcho-memory/client.js";
import type { HonchoConfig } from "../honcho-memory/config.js";

function testConfig(overrides: Partial<HonchoConfig> = {}): HonchoConfig {
  return {
    apiKey: "sk-test",
    workspaceId: "ws-1",
    baseUrl: "https://api.honcho.dev",
    peerId: "project:repo",
    enabled: true,
    requestTimeoutMs: 3000,
    contextTokens: 2000,
    ...overrides,
  };
}

describe("buildCreateMessagesRequest", () => {
  it("builds the exact URL, headers, and body", () => {
    const messages: HonchoMessage[] = [
      { content: "hello", peerId: "peer-1", metadata: { phase: "implement" } },
    ];
    const request = buildCreateMessagesRequest(testConfig(), "bd-42", messages);

    expect(request).toHaveProperty(
      "url",
      "https://api.honcho.dev/v3/workspaces/ws-1/sessions/bd-42/messages",
    );
    expect(request.init).toHaveProperty("method", "POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers).toHaveProperty("Authorization", "Bearer sk-test");
    expect(headers).toHaveProperty("Content-Type", "application/json");

    const body = JSON.parse(request.init.body as string) as {
      messages: Array<{ content: string; peer_id: string; metadata?: Record<string, string> }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toHaveProperty("content", "hello");
    expect(body.messages[0]).toHaveProperty("peer_id", "peer-1");
    expect(body.messages[0]).toHaveProperty("metadata.phase", "implement");
  });
});

describe("buildGetContextRequest", () => {
  it("URL-encodes query params and sends the expected headers", () => {
    const request = buildGetContextRequest(testConfig(), "bd-42", "project:repo", "fix the & bug");

    expect(request.url).toContain("/v3/workspaces/ws-1/sessions/bd-42/context");
    expect(request.url).toContain("peer_target=project%3Arepo");
    expect(request.url).toContain("search_query=fix%20the%20%26%20bug");
    expect(request.url).toContain("tokens=2000");
    expect(request.url).toContain("summary=true");

    expect(request.init).toHaveProperty("method", "GET");
    const headers = request.init.headers as Record<string, string>;
    expect(headers).toHaveProperty("Authorization", "Bearer sk-test");
  });
});

describe("createHonchoClient", () => {
  it("writeMessages returns ok on a 2xx JSON response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    } as Response);
    const client = createHonchoClient(testConfig(), { fetch: fetchMock });

    const result = await client.writeMessages("bd-42", [{ content: "hello", peerId: "peer-1" }]);
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("writeMessages returns an error on non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    } as Response);
    const client = createHonchoClient(testConfig(), { fetch: fetchMock });

    const result = await client.writeMessages("bd-42", [{ content: "hello", peerId: "peer-1" }]);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.error).toContain("HTTP 401");
    }
  });

  it("writeMessages returns an error on non-JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "not json",
    } as Response);
    const client = createHonchoClient(testConfig(), { fetch: fetchMock });

    const result = await client.writeMessages("bd-42", [{ content: "hello", peerId: "peer-1" }]);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.error).toContain("non-JSON");
    }
  });

  it("returns an error (not a throw) when fetch rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const client = createHonchoClient(testConfig(), { fetch: fetchMock });

    const write = await client.writeMessages("bd-42", [{ content: "hello", peerId: "peer-1" }]);
    expect(write).toHaveProperty("ok", false);

    const read = await client.readContext("bd-42", "peer-1", "query");
    expect(read).toHaveProperty("ok", false);
  });

  it("readContext returns the parsed JSON value on 2xx", async () => {
    const payload = { summary: "hi" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    } as Response);
    const client = createHonchoClient(testConfig(), { fetch: fetchMock });

    const result = await client.readContext("bd-42", "peer-1", "query");
    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.value).toEqual(payload);
    }
  });

  it("passes AbortSignal.timeout to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    } as Response);
    const client = createHonchoClient(testConfig({ requestTimeoutMs: 1500 }), {
      fetch: fetchMock,
    });

    await client.readContext("bd-42", "peer-1", "query");
    const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(init?.signal).toBeDefined();
    // AbortSignal.timeout produces a signal whose abort happens after 1500ms;
    // assert the timeout was applied by checking the signal exists (the
    // exact internal timeout is not observable without waiting).
  });
});
