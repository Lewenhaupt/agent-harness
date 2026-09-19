/**
 * Tests for src/honcho-memory/controller.ts.
 *
 * The controller takes a client seam; here it is a vi.fn() so cache hits,
 * reset, and error propagation are all observable without any network.
 */

import { describe, expect, it, vi } from "vitest";
import type { HonchoConfig } from "../honcho-memory/config.js";
import { createHonchoMemoryController } from "../honcho-memory/controller.js";

function testConfig(): HonchoConfig {
  return {
    apiKey: "sk-test",
    workspaceId: "ws-1",
    baseUrl: "https://api.honcho.dev",
    peerId: "project:repo",
    enabled: true,
    requestTimeoutMs: 3000,
    contextTokens: 2000,
  };
}

describe("createHonchoMemoryController", () => {
  it("retrieves and formats context once per session id", async () => {
    const readContext = vi.fn().mockResolvedValue({ ok: true, value: { summary: "memory" } });
    const controller = createHonchoMemoryController(testConfig(), {
      readContext,
      writeMessages: vi.fn(),
    });

    const first = await controller.retrieve("bd-42", "peer-1", "query");
    const second = await controller.retrieve("bd-42", "peer-1", "query");

    expect(first).toContain("memory");
    expect(second).toBe(first);
    expect(readContext).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and caches the miss on read failure", async () => {
    const readContext = vi.fn().mockResolvedValue({ ok: false, error: "down" });
    const controller = createHonchoMemoryController(testConfig(), {
      readContext,
      writeMessages: vi.fn(),
    });

    const first = await controller.retrieve("bd-42", "peer-1", "query");
    const second = await controller.retrieve("bd-42", "peer-1", "query");

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(readContext).toHaveBeenCalledTimes(1);
  });

  it("reset clears the cache so the next retrieve refetches", async () => {
    const readContext = vi.fn().mockResolvedValue({ ok: true, value: { summary: "memory" } });
    const controller = createHonchoMemoryController(testConfig(), {
      readContext,
      writeMessages: vi.fn(),
    });

    await controller.retrieve("bd-42", "peer-1", "query");
    controller.reset();
    await controller.retrieve("bd-42", "peer-1", "query");

    expect(readContext).toHaveBeenCalledTimes(2);
  });

  it("record passes through the write result without touching the cache", async () => {
    const writeMessages = vi.fn().mockResolvedValue({ ok: false, error: "write failed" });
    const controller = createHonchoMemoryController(testConfig(), {
      readContext: vi.fn(),
      writeMessages,
    });

    const result = await controller.record("bd-42", [{ content: "x", peerId: "peer-1" }]);
    expect(result).toHaveProperty("ok", false);
    expect(writeMessages).toHaveBeenCalledTimes(1);
  });

  it("record propagates ok write results", async () => {
    const writeMessages = vi.fn().mockResolvedValue({ ok: true });
    const controller = createHonchoMemoryController(testConfig(), {
      readContext: vi.fn(),
      writeMessages,
    });

    const result = await controller.record("bd-42", [{ content: "x", peerId: "peer-1" }]);
    expect(result).toEqual({ ok: true });
  });
});
