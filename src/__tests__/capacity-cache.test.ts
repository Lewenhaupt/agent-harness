import { describe, expect, it, vi } from "vitest";

import type { CapacityProbeResult } from "../capacity-cache.js";
import {
  createCapacityCache,
  createEndpointCapacityProbe,
  createFallbackCapacityProbe,
  DEFAULT_CAPACITY_TTL_MS,
  MAX_CAPACITY_WINDOWS,
  orderCandidatesByCapacity,
  parseCapacityWindows,
  probeFromCooldownStore,
} from "../capacity-cache.js";
import { type CooldownFs, createModelCooldownStore } from "../model-cooldown.js";

/** Minimal in-memory fs seam so two stores can share one "file" without disk I/O. */
function createFakeFs(initial: Record<string, string> = {}): CooldownFs & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  const enoent = (path: string): Error => {
    const error = new Error(`ENOENT: ${path}`) as Error & { code: string };
    error.code = "ENOENT";
    return error;
  };
  return {
    files,
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw enoent(path);
      return content;
    },
    writeFileSync: (path, data, options) => {
      if (options?.flag === "wx" && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`) as Error & { code: string };
        error.code = "EEXIST";
        throw error;
      }
      files.set(path, data);
    },
    renameSync: (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content === undefined) throw enoent(oldPath);
      files.delete(oldPath);
      files.set(newPath, content);
    },
    mkdirSync: () => {
      // No directory hierarchy in the in-memory seam.
    },
    unlinkSync: (path) => {
      files.delete(path);
    },
  };
}

describe("orderCandidatesByCapacity", () => {
  it("moves exhausted candidates behind healthy ones, preserving order", () => {
    const exhausted = new Set(["opencode-go/a", "openrouter/c"]);
    const ordered = orderCandidatesByCapacity(
      ["opencode-go/a", "llmgateway/a", "openrouter/c", "llmgateway/b"],
      (candidate) => exhausted.has(candidate),
    );

    expect(ordered).toEqual(["llmgateway/a", "llmgateway/b", "opencode-go/a", "openrouter/c"]);
  });

  it("keeps the original order when nothing is exhausted", () => {
    const candidates = ["a", "b", "c"];
    expect(orderCandidatesByCapacity(candidates, () => false)).toEqual(candidates);
  });

  it("keeps exhausted candidates in the list as a last resort", () => {
    // When every candidate is exhausted the list is unchanged; the caller can
    // still retry them rather than dropping the workload entirely.
    expect(orderCandidatesByCapacity(["a", "b"], () => true)).toEqual(["a", "b"]);
  });

  it("groups every model on an exhausted provider behind healthy candidates", () => {
    const cache = createCapacityCache({ now: () => 0 });
    // Exhaustion is provider-scoped: one recorded window blocks every model id
    // on that provider, not just the one that observed the 429.
    cache.record({ provider: "opencode-go", resetAt: 1_000, reason: "weekly limit" });

    const ordered = orderCandidatesByCapacity(
      ["opencode-go/a", "llmgateway/a", "opencode-go/b", "llmgateway/b"],
      (candidate) => cache.isModelExhausted(candidate),
    );

    expect(ordered).toEqual(["llmgateway/a", "llmgateway/b", "opencode-go/a", "opencode-go/b"]);
    // A bare model id has no provider scope, so capacity never blocks it.
    expect(
      orderCandidatesByCapacity(["a"], (candidate) => cache.isModelExhausted(candidate)),
    ).toEqual(["a"]);
  });
});

describe("createCapacityCache", () => {
  it("reports a recorded provider as exhausted until its reset time", () => {
    const cache = createCapacityCache({ now: () => 1_000 });
    cache.record({ provider: "opencode-go", resetAt: 2_000, reason: "weekly limit" });

    expect(cache.isExhausted("opencode-go")).toBe(true);
    expect(cache.isExhausted("opencode-go", 1_999)).toBe(true);
    expect(cache.isExhausted("opencode-go", 2_000)).toBe(false);
    expect(cache.isExhausted("llmgateway")).toBe(false);
    expect(cache.isModelExhausted("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(cache.isModelExhausted("llmgateway/mimo-v2.6-flash")).toBe(false);
  });

  it("does not treat a provider-less model id as exhausted", () => {
    const cache = createCapacityCache();
    cache.record({ provider: "opencode-go", resetAt: 9_999, reason: "quota" });
    expect(cache.isExhausted("")).toBe(false);
  });

  it("excludes expired windows from the snapshot", () => {
    const cache = createCapacityCache({ now: () => 1_000 });
    cache.record({ provider: "opencode-go", resetAt: 2_000, reason: "a" });
    cache.record({ provider: "llmgateway", resetAt: 500, reason: "b" });

    expect(cache.windows()).toEqual([{ provider: "opencode-go", resetAt: 2_000, reason: "a" }]);
  });

  it("probes once within the TTL and again after it", async () => {
    let nowMs = 0;
    const probe = vi.fn(() => ({
      windows: [{ provider: "opencode-go", resetAt: 10_000, reason: "quota" }],
    }));
    const cache = createCapacityCache({ probe, now: () => nowMs });

    await cache.refreshIfStale();
    expect(probe).toHaveBeenCalledTimes(1);

    nowMs = DEFAULT_CAPACITY_TTL_MS - 1;
    await cache.refreshIfStale();
    expect(probe).toHaveBeenCalledTimes(1);

    nowMs = DEFAULT_CAPACITY_TTL_MS;
    await cache.refreshIfStale();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("is a no-op without a probe", async () => {
    const cache = createCapacityCache();
    await expect(cache.refreshIfStale()).resolves.toBeUndefined();
    expect(cache.windows()).toEqual([]);
  });
});

describe("probeFromCooldownStore", () => {
  it("maps persisted provider cooldowns to capacity windows", async () => {
    const store = createModelCooldownStore(() => 1_000);
    store.markProviderCooldown("opencode-go", 3_600, "quota");

    const result = await probeFromCooldownStore(store)();

    expect(result.windows).toEqual([
      { provider: "opencode-go", resetAt: 1_000 + 3_600_000, reason: "quota" },
    ]);
  });

  it("sees a cooldown written by another store instance sharing the same file", async () => {
    // Fleet members each own a store and load the shared file once at creation,
    // so a cooldown written by a member after this one was created is invisible
    // without a re-read. That is the cross-process freshness case bd-38 fixes:
    // three members each re-probed the same exhausted provider.
    const fs = createFakeFs();
    const filePath = "/tmp/model-cooldowns.json";
    const thisProcess = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    const otherMember = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });

    expect((await probeFromCooldownStore(thisProcess)()).windows).toEqual([]);

    otherMember.markProviderCooldown("opencode-go", 6 * 60 * 60, "GoUsageLimitError");

    expect((await probeFromCooldownStore(thisProcess)()).windows).toEqual([
      {
        provider: "opencode-go",
        resetAt: 1_000_000 + 6 * 60 * 60 * 1000,
        reason: "GoUsageLimitError",
      },
    ]);
  });

  it("never throws and yields no windows for a missing or corrupt file", async () => {
    // The probe runs on every pre-dispatch refresh, so a hand-edited or
    // half-written file must degrade to capacity ignorance, never fail a spawn.
    const filePath = "/tmp/model-cooldowns.json";
    const missing = createModelCooldownStore({
      now: () => 1_000_000,
      filePath,
      fs: createFakeFs(),
    });
    await expect(Promise.resolve(probeFromCooldownStore(missing)())).resolves.toEqual({
      windows: [],
    });

    const corrupt = createModelCooldownStore({
      now: () => 1_000_000,
      filePath,
      fs: createFakeFs({ [filePath]: "{ broken" }),
    });
    await expect(Promise.resolve(probeFromCooldownStore(corrupt)())).resolves.toEqual({
      windows: [],
    });
  });

  it("keeps the longest window when both stores marked the same provider", async () => {
    const fs = createFakeFs();
    const filePath = "/tmp/model-cooldowns.json";
    const first = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    const second = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });

    first.markProviderCooldown("opencode-go", 60, "quota");
    second.markProviderCooldown("opencode-go", 7_200, "weekly limit");

    const windows = (await probeFromCooldownStore(first)()).windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]).toHaveProperty("resetAt", 1_000_000 + 7_200_000);
    expect(windows[0]).toHaveProperty("reason", "weekly limit");
  });
});

describe("parseCapacityWindows", () => {
  it("parses a direct windows list", () => {
    expect(
      parseCapacityWindows(
        {
          windows: [
            { provider: "opencode-go", resetAt: 5_000, reason: "weekly" },
            { provider: "other" },
          ],
        },
        1_000,
      ),
    ).toEqual([{ provider: "opencode-go", resetAt: 5_000, reason: "weekly" }]);
  });

  it("parses a nested provider map with relative windows", () => {
    expect(
      parseCapacityWindows(
        { providers: { "opencode-go": { resetsInSeconds: 3_600, reason: "limit" } } },
        1_000,
      ),
    ).toEqual([{ provider: "opencode-go", resetAt: 1_000 + 3_600_000, reason: "limit" }]);
  });

  it("parses a top-level provider map and a reset-hint string", () => {
    expect(
      parseCapacityWindows(
        { "opencode-go": { message: "Weekly usage limit reached. Resets in 7hr 57min." } },
        0,
      ),
    ).toEqual([
      {
        provider: "opencode-go",
        resetAt: 7 * 3_600_000 + 57 * 60_000,
        reason: "endpoint capacity",
      },
    ]);
  });

  it("ignores unrecognized shapes and entries", () => {
    expect(parseCapacityWindows(null, 0)).toEqual([]);
    expect(parseCapacityWindows("nope", 0)).toEqual([]);
    expect(parseCapacityWindows({ providers: { a: "nope" } }, 0)).toEqual([]);
    expect(parseCapacityWindows({ windows: [{ reason: "no provider" }] }, 0)).toEqual([]);
  });

  it("caps the number of accepted windows", () => {
    const entries = Array.from({ length: MAX_CAPACITY_WINDOWS + 10 }, (_, index) => ({
      provider: `p${index}`,
      resetAt: 5_000,
    }));
    expect(parseCapacityWindows({ windows: entries }, 0)).toHaveLength(MAX_CAPACITY_WINDOWS);
  });
});

function textResponse(
  text: string,
  init?: { ok?: boolean; status?: number; contentLength?: string; noBody?: boolean },
): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? (init?.ok === false ? 500 : 200),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" ? (init?.contentLength ?? null) : null,
    },
    body:
      init?.noBody === true
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          }),
    text: async () => text,
  } as unknown as Response;
}

describe("createEndpointCapacityProbe", () => {
  it("parses provider windows from a 200 response", async () => {
    const fetchFn = vi.fn(async () =>
      textResponse(JSON.stringify({ providers: { "opencode-go": { resetsInSeconds: 60 } } })),
    );
    const probe = createEndpointCapacityProbe({
      url: "https://capacity.test/usage",
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1_000,
    });

    await expect(probe()).resolves.toEqual({
      windows: [{ provider: "opencode-go", resetAt: 61_000, reason: "endpoint capacity" }],
    });
    // The request carries an abort signal so a timeout cancels the connection.
    expect(fetchFn).toHaveBeenCalledWith(
      "https://capacity.test/usage",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns no windows on a non-200 response", async () => {
    const probe = createEndpointCapacityProbe({
      url: "https://capacity.test/usage",
      fetchFn: (async () => textResponse("{}", { ok: false })) as unknown as typeof fetch,
    });
    await expect(probe()).resolves.toEqual({ windows: [] });
  });

  it("returns no windows on malformed JSON", async () => {
    const probe = createEndpointCapacityProbe({
      url: "https://capacity.test/usage",
      fetchFn: (async () => textResponse("not json")) as unknown as typeof fetch,
    });
    await expect(probe()).resolves.toEqual({ windows: [] });
  });

  it("returns no windows when the request times out", async () => {
    const probe = createEndpointCapacityProbe({
      url: "https://capacity.test/usage",
      timeoutMs: 5,
      fetchFn: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    });
    await expect(probe()).resolves.toEqual({ windows: [] });
  });

  it("returns no windows when the body exceeds the byte cap", async () => {
    const body = JSON.stringify({ providers: { "opencode-go": { resetsInSeconds: 60 } } });
    const probe = createEndpointCapacityProbe({
      url: "https://capacity.test/usage",
      maxBodyBytes: 5,
      fetchFn: (async () => textResponse(body)) as unknown as typeof fetch,
    });
    await expect(probe()).resolves.toEqual({ windows: [] });
  });

  it("rejects an over-long content-length before reading the body", async () => {
    const probe = createEndpointCapacityProbe({
      url: "https://capacity.test/usage",
      maxBodyBytes: 5,
      fetchFn: (async () =>
        textResponse("{}", { contentLength: "1000000" })) as unknown as typeof fetch,
    });
    await expect(probe()).resolves.toEqual({ windows: [] });
  });

  it("returns no windows when the response has no readable body stream", async () => {
    const body = JSON.stringify({ providers: { "opencode-go": { resetsInSeconds: 60 } } });
    const probe = createEndpointCapacityProbe({
      url: "https://capacity.test/usage",
      fetchFn: (async () => textResponse(body, { noBody: true })) as unknown as typeof fetch,
    });
    await expect(probe()).resolves.toEqual({ windows: [] });
  });

  it("throttles onFailure so a broken endpoint cannot warn per spawn", async () => {
    let nowMs = 0;
    const onFailure = vi.fn();
    const probe = createEndpointCapacityProbe({
      url: "https://capacity.test/usage",
      fetchFn: (async () => textResponse("nope")) as unknown as typeof fetch,
      now: () => nowMs,
      failureWarnIntervalMs: 1_000,
      onFailure,
    });

    await probe();
    await probe();
    expect(onFailure).toHaveBeenCalledTimes(1);

    nowMs = 1_000;
    await probe();
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith("malformed JSON body");
  });
});

describe("createFallbackCapacityProbe", () => {
  it("falls back to the next probe when the first yields no windows", async () => {
    const probe = createFallbackCapacityProbe(
      () => ({ windows: [] }),
      () => ({ windows: [{ provider: "opencode-go", resetAt: 5, reason: "cooldown" }] }),
    );
    await expect(probe()).resolves.toEqual({
      windows: [{ provider: "opencode-go", resetAt: 5, reason: "cooldown" }],
    });
  });

  it("skips a rejecting probe and tries the next", async () => {
    const probe = createFallbackCapacityProbe(
      () => {
        throw new Error("endpoint down");
      },
      () => ({ windows: [{ provider: "llmgateway", resetAt: 5, reason: "cooldown" }] }),
    );
    await expect(probe()).resolves.toEqual({
      windows: [{ provider: "llmgateway", resetAt: 5, reason: "cooldown" }],
    });
  });

  it("returns empty when every probe is empty", async () => {
    await expect(createFallbackCapacityProbe(() => ({ windows: [] }))()).resolves.toEqual({
      windows: [],
    });
  });
});

describe("capacity cache probe resilience", () => {
  it("swallows a rejecting probe and re-probes on the next call", async () => {
    let calls = 0;
    const probe = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("probe exploded"));
      return { windows: [{ provider: "opencode-go", resetAt: 9_999, reason: "limit" }] };
    });
    const cache = createCapacityCache({ probe, now: () => 0 });

    await expect(cache.refreshIfStale()).resolves.toBeUndefined();
    expect(cache.isExhausted("opencode-go")).toBe(false);

    // A failed probe must not suppress the next attempt for the full TTL.
    await cache.refreshIfStale();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(cache.isExhausted("opencode-go")).toBe(true);
  });

  it("does not hang when a probe never resolves", async () => {
    const cache = createCapacityCache({
      probe: () => new Promise<{ windows: [] }>(() => {}),
      probeTimeoutMs: 5,
      now: () => 0,
    });
    await expect(cache.refreshIfStale()).resolves.toBeUndefined();
    expect(cache.isExhausted("opencode-go")).toBe(false);
  });

  it("re-probes after a probe times out instead of suppressing it for the TTL", async () => {
    let calls = 0;
    const probe = vi.fn((): Promise<CapacityProbeResult> | CapacityProbeResult => {
      calls += 1;
      if (calls === 1) return new Promise<CapacityProbeResult>(() => {});
      return { windows: [{ provider: "opencode-go", resetAt: 9_999, reason: "limit" }] };
    });
    const cache = createCapacityCache({ probe, probeTimeoutMs: 5, now: () => 0 });

    await expect(cache.refreshIfStale()).resolves.toBeUndefined();
    expect(cache.isExhausted("opencode-go")).toBe(false);

    // A timeout must roll back the freshness stamp like a rejection does, so
    // the next spawn re-probes rather than waiting out the whole TTL.
    await cache.refreshIfStale();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(cache.isExhausted("opencode-go")).toBe(true);
  });

  it("exposes its clock so callers can stamp windows with the same timeline", () => {
    const cache = createCapacityCache({ now: () => 12_345 });
    expect(cache.nowMs()).toBe(12_345);
  });
});
