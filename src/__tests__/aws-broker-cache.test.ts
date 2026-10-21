import { describe, expect, it, vi } from "vitest";
import type { AwsCredentials, AwsResult } from "../aws-broker/aws-cli.js";
import { createCredentialCache, DEFAULT_REFRESH_SKEW_MS } from "../aws-broker/cache.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function credentials(expiresInMs: number, accessKeyId = "AKIA"): AwsCredentials {
  return {
    Version: 1,
    AccessKeyId: accessKeyId,
    SecretAccessKey: "secret",
    SessionToken: "token",
    Expiration: new Date(NOW + expiresInMs).toISOString(),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolveFn = resolvePromise;
  });
  return { promise, resolve: resolveFn };
}

describe("aws-broker cache", () => {
  it("serves a fresh entry without re-resolving", async () => {
    const resolve = vi.fn(async () => ({ ok: true, value: credentials(60 * 60 * 1000) }) as const);
    const cache = createCredentialCache({ resolve, now: () => NOW });
    const first = await cache.get("agent-readonly");
    const second = await cache.get("agent-readonly");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1);
  });

  it("single-flights concurrent requests into one resolve call", async () => {
    const gate = deferred<AwsResult<AwsCredentials>>();
    const resolve = vi.fn(() => gate.promise);
    const cache = createCredentialCache({ resolve, now: () => NOW });
    const requests = [
      cache.get("agent-readonly"),
      cache.get("agent-readonly"),
      cache.get("agent-readonly"),
    ];
    gate.resolve({ ok: true, value: credentials(60 * 60 * 1000) });
    const results = await Promise.all(requests);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("refreshes within the 5-minute skew before Expiration", async () => {
    const resolve = vi
      .fn<(profile: string) => Promise<AwsResult<AwsCredentials>>>()
      .mockResolvedValueOnce({ ok: true, value: credentials(4 * 60 * 1000, "OLD") })
      .mockResolvedValueOnce({ ok: true, value: credentials(60 * 60 * 1000, "NEW") });
    const cache = createCredentialCache({ resolve, now: () => NOW });
    const first = await cache.get("agent-readonly");
    const second = await cache.get("agent-readonly");
    expect(first.ok && first.value.AccessKeyId).toBe("OLD");
    expect(second.ok && second.value.AccessKeyId).toBe("NEW");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(DEFAULT_REFRESH_SKEW_MS).toBe(5 * 60 * 1000);
  });

  it("keeps a credential that is exactly at the skew boundary cached", async () => {
    const resolve = vi.fn(
      async () =>
        ({
          ok: true,
          value: credentials(DEFAULT_REFRESH_SKEW_MS + 1),
        }) as const,
    );
    const cache = createCredentialCache({ resolve, now: () => NOW });
    await cache.get("agent-readonly");
    await cache.get("agent-readonly");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("bounds the cache with an LRU eviction", async () => {
    const resolve = vi.fn(
      async (profile: string) =>
        ({
          ok: true,
          value: credentials(60 * 60 * 1000, profile),
        }) as const,
    );
    const cache = createCredentialCache({ resolve, now: () => NOW, maxEntries: 2 });
    await cache.get("a");
    await cache.get("b");
    await cache.get("a"); // refresh LRU position of "a"
    await cache.get("c");
    expect(cache.size()).toBe(2);
    await cache.get("b"); // evicted: must re-resolve
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  it("propagates a resolution failure and never caches it", async () => {
    const resolve = vi
      .fn<(profile: string) => Promise<AwsResult<AwsCredentials>>>()
      .mockResolvedValueOnce({ ok: false, error: "Token has expired and refresh failed" })
      .mockResolvedValueOnce({ ok: true, value: credentials(60 * 60 * 1000) });
    const cache = createCredentialCache({ resolve, now: () => NOW });
    const failed = await cache.get("agent-readonly");
    expect(failed).toHaveProperty("ok", false);
    if (failed.ok) return;
    expect(failed.error).toContain("Token has expired");
    expect(cache.size()).toBe(0);
    const retried = await cache.get("agent-readonly");
    expect(retried.ok).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not cache an already-expired document", async () => {
    const resolve = vi.fn(async () => ({ ok: true, value: credentials(-1000) }) as const);
    const cache = createCredentialCache({ resolve, now: () => NOW });
    const first = await cache.get("agent-readonly");
    expect(first.ok).toBe(true);
    expect(cache.size()).toBe(0);
    await cache.get("agent-readonly");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("clears every entry", async () => {
    const resolve = vi.fn(async () => ({ ok: true, value: credentials(60 * 60 * 1000) }) as const);
    const cache = createCredentialCache({ resolve, now: () => NOW });
    await cache.get("agent-readonly");
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
