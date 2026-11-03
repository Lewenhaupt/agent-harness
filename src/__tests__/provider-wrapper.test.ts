import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelStateStore } from "../model-state-store.js";
import { openModelStateStore } from "../model-state-store.js";
import type { ProviderPolicy } from "../provider-policy.js";
import {
  createProviderPolicy,
  MAX_ATTEMPTS_PER_DISPATCH,
  TRANSIENT_RETRY_BUDGET,
} from "../provider-policy.js";
import type { DispatchAttribution, ProviderLike, ProviderStreamLike } from "../provider-wrapper.js";
import {
  installProviderPolicy,
  ProviderPolicyRefusalError,
  setDispatchAttribution,
  wrapProvider,
  wrapProviderCollection,
} from "../provider-wrapper.js";
import {
  CAPACITY_REFUSAL_MARKER,
  classifyAssistantMessage,
  isFallbackWorthy,
} from "../quota-failure.js";

const sqliteProbe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
});
const describeSqlite = sqliteProbe.status === 0 ? describe : describe.skip;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-provider-wrapper-"));
  tempDirs.push(dir);
  return dir;
}

function openStore(options: { daemonPid?: number; host?: string } = {}): ModelStateStore {
  const dir = tempDir();
  const opened = openModelStateStore({
    path: join(dir, "model-state.sqlite"),
    now: () => 0,
    ...options,
  });
  if (!opened.ok) throw new Error(opened.error);
  return opened.store;
}

function streamOf(message: unknown): ProviderStreamLike {
  return { result: async () => message };
}

function assistantError(errorMessage: string): Record<string, unknown> {
  return { role: "assistant", stopReason: "error", model: "m", errorMessage };
}

function assistantSuccess(usage: Record<string, unknown>): Record<string, unknown> {
  return { role: "assistant", stopReason: "end", model: "m", usage };
}

function callStream(provider: ProviderLike, model: string): ProviderStreamLike {
  const stream = provider.stream as unknown as (
    model: unknown,
    context: unknown,
    options?: unknown,
  ) => ProviderStreamLike;
  return stream({ id: model }, {});
}

interface TestProvider extends ProviderLike {
  baseUrl: string;
  getModels: () => readonly string[];
}

function testProvider(overrides: Partial<TestProvider> = {}): TestProvider {
  return {
    id: "llmgateway",
    baseUrl: "https://llmgateway.example",
    getModels: () => ["m"],
    stream: () => streamOf(assistantSuccess({ input: 0, output: 0 })),
    streamSimple: () => streamOf(assistantSuccess({ input: 0, output: 0 })),
    ...overrides,
  };
}

interface RawDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

function readSpendRows(path: string): { phase: string; taskId: string; input: number }[] {
  const require = createRequire(import.meta.url);
  const sqlite = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => RawDatabase;
  };
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT phase, task_id, input FROM spend ORDER BY ts, rowid")
      .all()
      .map((row) => {
        const record =
          typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
        return {
          phase: String(record.phase),
          taskId: String(record.task_id),
          input: Number(record.input),
        };
      });
  } finally {
    database.close();
  }
}

describe("provider wrapper identity", () => {
  it("keeps the wrapped provider id and forwards non-stream members by reference", () => {
    const real = testProvider();
    const wrapped = wrapProvider(real, createProviderPolicy({ store: () => null }));

    expect(wrapped.id).toBe(real.id);
    expect(wrapped.id).toBe("llmgateway");

    const view = wrapped as unknown as TestProvider;
    expect(view.baseUrl).toBe(real.baseUrl);
    expect(view.getModels).toBe(real.getModels);
    expect(wrapped.stream).not.toBe(real.stream);
    expect(wrapped.streamSimple).not.toBe(real.streamSimple);
  });

  it("wraps every provider except the direct fallback", () => {
    const installed: ProviderLike[] = [];
    const result = wrapProviderCollection({
      providers: [testProvider({ id: "llmgateway" }), testProvider({ id: "openrouter" })],
      policyFor: () => createProviderPolicy({ store: () => null }),
      install: (provider) => installed.push(provider),
      directProviderId: "llmgateway",
    });

    expect(result).toEqual({ wrapped: ["openrouter"], direct: ["llmgateway"], failed: [] });
    expect(installed.map((provider) => provider.id)).toEqual(["openrouter"]);
  });

  it("keeps the first provider direct when the preferred id is absent", () => {
    const installed: ProviderLike[] = [];
    const result = wrapProviderCollection({
      providers: [testProvider({ id: "openrouter" })],
      policyFor: () => createProviderPolicy({ store: () => null }),
      install: (provider) => installed.push(provider),
      directProviderId: "llmgateway",
    });
    expect(result).toEqual({ wrapped: [], direct: ["openrouter"], failed: [] });
    expect(installed).toEqual([]);
  });

  it("is a no-op when disabled", () => {
    const installed: ProviderLike[] = [];
    const result = wrapProviderCollection({
      providers: [testProvider()],
      policyFor: () => createProviderPolicy({ store: () => null }),
      install: (provider) => installed.push(provider),
      enabled: false,
    });
    expect(result).toEqual({ wrapped: [], direct: ["llmgateway"], failed: [] });
    expect(installed).toEqual([]);
  });

  it("installs over a pi-durable Models-shaped collection", () => {
    const installed: ProviderLike[] = [];
    const result = installProviderPolicy(
      {
        getProviders: () => [
          testProvider({ id: "llmgateway" }),
          testProvider({ id: "openrouter" }),
        ],
        setProvider: (provider) => installed.push(provider),
      },
      {
        policyFor: () => createProviderPolicy({ store: () => null }),
        directProviderId: "llmgateway",
      },
    );

    expect(result).toEqual({ wrapped: ["openrouter"], direct: ["llmgateway"], failed: [] });
    expect(installed.map((provider) => provider.id)).toEqual(["openrouter"]);
  });
});

describe("wrapping is idempotent (bd-187 review)", () => {
  it("wrapProvider returns an already-wrapped provider unchanged", () => {
    const real = testProvider();
    const policy = createProviderPolicy({ store: () => null });
    const once = wrapProvider(real, policy);
    const twice = wrapProvider(once, policy);
    expect(twice).toBe(once);
  });

  it("wrapping twice yields one provider call, one spend row and one cooldown mark", async () => {
    const store = openStore();
    const policy = createProviderPolicy({ store: () => store, now: () => 0 });

    const successStream = vi.fn(() =>
      streamOf(assistantSuccess({ input: 5, output: 2, cost: { total: 0.1 } })),
    );
    const wrappedSuccess = wrapProvider(
      wrapProvider(testProvider({ stream: successStream }), policy),
      policy,
    );
    await callStream(wrappedSuccess, "m").result();
    expect(successStream).toHaveBeenCalledTimes(1);
    expect(store.spendTotals()).toMatchObject({ ok: true, value: { rows: 1, input: 5 } });

    const errorStream = vi.fn(() => streamOf(assistantError("429: too many requests")));
    const wrappedError = wrapProvider(
      wrapProvider(testProvider({ stream: errorStream }), policy),
      policy,
    );
    await callStream(wrappedError, "m").result();
    expect(errorStream).toHaveBeenCalledTimes(1);
    // One unhinted provider mark is 15m; a second (double-wrapped) observer would
    // have escalated the ladder to 30m.
    expect(store.cooldownFor({ provider: "llmgateway", model: "m", nowMs: 1 })).toMatchObject({
      ok: true,
      value: { scope: "provider", retryAfterMs: 900_000 },
    });
    store.close();
  });

  it("wrapProviderCollection is a no-op over an already-wrapped collection", async () => {
    const store = openStore();
    const realStream = vi.fn(() =>
      streamOf(assistantSuccess({ input: 1, output: 1, cost: { total: 0.1 } })),
    );
    const current = new Map<string, ProviderLike>([
      ["llmgateway", testProvider({ stream: realStream })],
      ["openrouter", testProvider({ id: "openrouter" })],
    ]);
    const installs: string[] = [];
    const input = {
      providers: [...current.values()],
      policyFor: () => createProviderPolicy({ store: () => store }),
      install: (provider: ProviderLike) => {
        installs.push(provider.id);
        current.set(provider.id, provider);
      },
      directProviderId: "openrouter",
    };

    expect(wrapProviderCollection(input)).toMatchObject({
      wrapped: ["llmgateway"],
      direct: ["openrouter"],
      failed: [],
    });
    input.providers = [...current.values()];
    expect(wrapProviderCollection(input)).toMatchObject({
      wrapped: ["llmgateway"],
      direct: ["openrouter"],
      failed: [],
    });

    expect(installs).toEqual(["llmgateway"]);
    const wrapped = current.get("llmgateway");
    expect(wrapped).toBeDefined();
    if (wrapped === undefined) return;
    await callStream(wrapped, "m").result();
    expect(realStream).toHaveBeenCalledTimes(1);
    expect(store.spendTotals()).toMatchObject({ ok: true, value: { rows: 1 } });
    store.close();
  });

  it("installProviderPolicy is a no-op over one Models collection", async () => {
    const store = openStore();
    const realStream = vi.fn(() =>
      streamOf(assistantSuccess({ input: 1, output: 1, cost: { total: 0.1 } })),
    );
    const current = new Map<string, ProviderLike>([
      ["llmgateway", testProvider({ stream: realStream })],
      ["openrouter", testProvider({ id: "openrouter" })],
    ]);
    const setCalls: string[] = [];
    const models = {
      getProviders: () => [...current.values()],
      setProvider: (provider: ProviderLike) => {
        setCalls.push(provider.id);
        current.set(provider.id, provider);
      },
    };
    const options = {
      policyFor: () => createProviderPolicy({ store: () => store }),
      directProviderId: "openrouter",
    };

    installProviderPolicy(models, options);
    installProviderPolicy(models, options);

    expect(setCalls).toEqual(["llmgateway"]);
    const wrapped = current.get("llmgateway");
    expect(wrapped).toBeDefined();
    if (wrapped === undefined) return;
    await callStream(wrapped, "m").result();
    expect(realStream).toHaveBeenCalledTimes(1);
    expect(store.spendTotals()).toMatchObject({ ok: true, value: { rows: 1 } });
    store.close();
  });

  it("collects install failures instead of aborting the remaining providers", () => {
    const installed: string[] = [];
    const result = wrapProviderCollection({
      providers: [testProvider({ id: "openrouter" }), testProvider({ id: "commandcode" })],
      policyFor: () => createProviderPolicy({ store: () => null }),
      install: (provider) => {
        if (provider.id === "openrouter") throw new Error("registry busy");
        installed.push(provider.id);
      },
      directProviderId: "commandcode",
    });

    expect(result).toEqual({
      wrapped: [],
      direct: ["commandcode"],
      failed: [{ id: "openrouter", error: "registry busy" }],
    });
    expect(installed).toEqual([]);
  });
});

describe("retry amplification is bounded (bd-187 review)", () => {
  function permissivePolicy(failures: string[]): ProviderPolicy {
    return {
      decideDispatch: () => ({ allowed: true }),
      recordFailure: (input) => {
        failures.push(input.classification.kind);
      },
      recordSpend: () => undefined,
      acquireLease: () => ({ allowed: true, lease: null }),
      releaseLease: () => undefined,
      renewLease: () => ({ ok: true, value: { leaseId: "fake", expiresMs: 0 } }),
      leaseRenewalIntervalInMs: () => 0,
    };
  }

  it("adds no retry for a quota failure: calls equal caller attempts", async () => {
    const stream = vi.fn(() => streamOf(assistantError("429: too many requests")));
    const failures: string[] = [];
    const wrapped = wrapProvider(testProvider({ stream }), permissivePolicy(failures));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await callStream(wrapped, "m").result();
    }

    expect(stream).toHaveBeenCalledTimes(3);
    expect(failures).toEqual(["quota", "quota", "quota"]);
  });

  it("spends at most 1 + transient budget per caller attempt on a transient throw", () => {
    const stream = vi.fn(() => {
      throw new Error("ECONNRESET network down");
    });
    const failures: string[] = [];
    const wrapped = wrapProvider(testProvider({ stream }), permissivePolicy(failures));

    expect(() => callStream(wrapped, "m")).toThrow("ECONNRESET network down");
    expect(() => callStream(wrapped, "m")).toThrow("ECONNRESET network down");

    expect(stream).toHaveBeenCalledTimes(2 * (1 + TRANSIENT_RETRY_BUDGET));
    expect(stream.mock.calls.length).toBeLessThanOrEqual(2 * MAX_ATTEMPTS_PER_DISPATCH);
    expect(failures).toEqual(["transient", "transient", "transient", "transient"]);
  });

  it("does not retry an unclassifiable synchronous throw", () => {
    const stream = vi.fn(() => {
      throw new Error("boom");
    });
    const wrapped = wrapProvider(testProvider({ stream }), permissivePolicy([]));
    expect(() => callStream(wrapped, "m")).toThrow("boom");
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

describeSqlite("provider wrapper policy enforcement (bd-187)", () => {
  it("never calls the real provider when dispatch is denied", () => {
    const store = openStore();
    store.markCooldown({
      provider: "llmgateway",
      durationMs: 60_000,
      reason: "429 quota",
      nowMs: 0,
    });
    const stream = vi.fn(() => streamOf(assistantSuccess({ input: 1, output: 1 })));
    const wrapped = wrapProvider(
      testProvider({ stream }),
      createProviderPolicy({ store: () => store, now: () => 1_000 }),
    );

    expect(() => callStream(wrapped, "m")).toThrow(ProviderPolicyRefusalError);
    expect(stream).not.toHaveBeenCalled();
    store.close();
  });

  it("records a spend row from provider-reported usage on success", async () => {
    const store = openStore();
    const wrapped = wrapProvider(
      testProvider({
        stream: () =>
          streamOf(
            assistantSuccess({
              input: 10,
              output: 5,
              cacheRead: 3,
              cacheWrite: 2,
              cost: { total: 0.25 },
            }),
          ),
      }),
      createProviderPolicy({ store: () => store }),
      { phase: "scout", taskId: "bd-187" },
    );

    const stream = callStream(wrapped, "m");
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "end" });

    expect(store.spendTotals()).toMatchObject({
      ok: true,
      value: { rows: 1, input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.25 },
    });
    store.close();
  });

  it("records a cooldown on an assistant error instead of spend", async () => {
    const store = openStore();
    const wrapped = wrapProvider(
      testProvider({
        stream: () => streamOf(assistantError("429: too many requests")),
      }),
      createProviderPolicy({ store: () => store, now: () => 0 }),
    );

    const stream = callStream(wrapped, "m");
    await stream.result();

    expect(store.cooldownFor({ provider: "llmgateway", model: "m", nowMs: 1_000 })).toMatchObject({
      ok: true,
      value: { scope: "provider" },
    });
    expect(store.spendTotals()).toMatchObject({ ok: true, value: { rows: 0 } });
    store.close();
  });

  it("does not amplify an always-429 provider", async () => {
    const store = openStore();
    const stream = vi.fn(() => streamOf(assistantError("429: too many requests")));
    const wrapped = wrapProvider(
      testProvider({ stream }),
      createProviderPolicy({ store: () => store, now: () => 0 }),
    );

    await callStream(wrapped, "m").result();

    // A stream failure is terminal: the cooldown and the fallback decision are
    // the wrapper's response, retrying the same model is not.
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls.length).toBeLessThanOrEqual(MAX_ATTEMPTS_PER_DISPATCH);
    store.close();
  });

  it("bounds retries of a transiently throwing provider at MAX_ATTEMPTS_PER_DISPATCH", () => {
    const stream = vi.fn(() => {
      throw new Error("ECONNRESET network down");
    });
    const wrapped = wrapProvider(
      testProvider({ stream }),
      // No store: nothing records the failure, so the attempt cap is the only
      // thing bounding the loop.
      createProviderPolicy({ store: () => null }),
    );

    expect(() => callStream(wrapped, "m")).toThrow("ECONNRESET network down");
    expect(stream).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_DISPATCH);
  });

  it("stops a retrying provider at one call when the cooldown is recorded", () => {
    const store = openStore();
    const stream = vi.fn(() => {
      throw new Error("ECONNRESET network down");
    });
    const wrapped = wrapProvider(
      testProvider({ stream }),
      createProviderPolicy({ store: () => store, now: () => 0 }),
    );

    // The first throw writes a transient cooldown; the retry is then denied and
    // the provider's original error is surfaced instead of a refusal.
    expect(() => callStream(wrapped, "m")).toThrow("ECONNRESET network down");
    expect(stream).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("still serves with a read-only store", async () => {
    const writer = openStore();
    const path = writer.path;
    writer.close();

    const opened = openModelStateStore({ path, readOnly: true, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const readOnlyStore = opened.store;

    const stream = vi.fn(() =>
      streamOf(assistantSuccess({ input: 4, output: 2, cost: { total: 0.1 } })),
    );
    const wrapped = wrapProvider(
      testProvider({ stream }),
      createProviderPolicy({ store: () => readOnlyStore, now: () => 0 }),
    );

    const result = await callStream(wrapped, "m").result();
    expect(result).toMatchObject({ stopReason: "end" });
    expect(stream).toHaveBeenCalledTimes(1);
    // The spend write failed as a value; the model response was unaffected.
    expect(readOnlyStore.spendTotals()).toMatchObject({ ok: true, value: { rows: 0 } });
    readOnlyStore.close();
  });

  it("still serves when the store cannot be opened", async () => {
    const stream = vi.fn(() => streamOf(assistantSuccess({ input: 1, output: 1 })));
    const wrapped = wrapProvider(
      testProvider({ stream }),
      // No store at all: the policy factory returns null, the shape the extension
      // gets when the state file cannot be opened.
      createProviderPolicy({ store: () => null }),
    );

    await expect(callStream(wrapped, "m").result()).resolves.toMatchObject({
      stopReason: "end",
    });
    // A broken store must never deny the dispatch: the real provider still ran.
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a stream rejection", async () => {
    const wrapped = wrapProvider(
      testProvider({
        stream: () => ({
          result: async () => {
            throw new Error("stream aborted");
          },
        }),
      }),
      createProviderPolicy({ store: () => null }),
    );

    await expect(callStream(wrapped, "m").result()).rejects.toThrow("stream aborted");
  });
});

describeSqlite("provider wrapper capacity leases (bd-187 review)", () => {
  interface PendingStream {
    stream: ProviderStreamLike;
    resolve(value: unknown): void;
  }

  function pendingStream(): PendingStream {
    let settle: ((value: unknown) => void) | undefined;
    const result = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    return {
      stream: { result: () => result },
      resolve: (value: unknown) => {
        settle?.(value);
      },
    };
  }

  function capacityPolicy(store: ModelStateStore, leaseId: string): ProviderPolicy {
    return createProviderPolicy({
      store: () => store,
      now: () => 0,
      capacity: { limit: 1, classOf: () => "standard", leaseId: () => leaseId },
    });
  }

  it("holds a lease while the stream is pending and releases it on success", async () => {
    const store = openStore();
    const pending = pendingStream();
    const wrapped = wrapProvider(
      testProvider({ stream: () => pending.stream }),
      capacityPolicy(store, "lease-success"),
    );

    const stream = callStream(wrapped, "m");
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 1, limit: 1 } });

    pending.resolve(assistantSuccess({ input: 1, output: 1 }));
    await stream.result();
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 0 } });
    store.close();
  });

  it("releases the lease on a terminal error", async () => {
    const store = openStore();
    const wrapped = wrapProvider(
      testProvider({ stream: () => streamOf(assistantError("429: too many requests")) }),
      capacityPolicy(store, "lease-error"),
    );

    await callStream(wrapped, "m").result();
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 0 } });
    store.close();
  });

  it("releases the lease on a rejected stream", async () => {
    const store = openStore();
    const wrapped = wrapProvider(
      testProvider({
        stream: () => ({
          result: async () => {
            throw new Error("stream aborted");
          },
        }),
      }),
      capacityPolicy(store, "lease-reject"),
    );

    await expect(callStream(wrapped, "m").result()).rejects.toThrow("stream aborted");
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 0 } });
    store.close();
  });

  it("releases exactly once, with no double release", async () => {
    const store = openStore();
    const releases: string[] = [];
    const realPolicy = capacityPolicy(store, "lease-once");
    const policy: ProviderPolicy = {
      ...realPolicy,
      releaseLease: (input) => {
        if (input.lease !== null) releases.push(input.lease.leaseId);
        realPolicy.releaseLease(input);
      },
    };
    const wrapped = wrapProvider(
      testProvider({ stream: () => streamOf(assistantSuccess({})) }),
      policy,
    );

    await callStream(wrapped, "m").result();
    expect(releases).toEqual(["lease-once"]);
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 0 } });
    store.close();
  });

  it("refuses at the capacity limit without calling the provider or disturbing the holder", () => {
    const store = openStore();
    store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "held",
      nowMs: 0,
    });
    const stream = vi.fn(() => streamOf(assistantSuccess({})));
    const wrapped = wrapProvider(testProvider({ stream }), capacityPolicy(store, "lease-next"));

    let refusal: unknown;
    try {
      callStream(wrapped, "m");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ProviderPolicyRefusalError);
    if (!(refusal instanceof ProviderPolicyRefusalError)) return;
    expect(refusal.scope).toBe("capacity");
    expect(refusal.capacity).toMatchObject({
      provider: "llmgateway",
      class: "standard",
      inUse: 1,
      limit: 1,
    });
    expect(stream).not.toHaveBeenCalled();
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 1, limit: 1 } });
    store.close();
  });

  it("dispatches without a lease when the store is read-only", async () => {
    const writer = openStore();
    const path = writer.path;
    writer.close();
    const opened = openModelStateStore({ path, readOnly: true, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    const stream = vi.fn(() => streamOf(assistantSuccess({ input: 1, output: 1 })));
    const wrapped = wrapProvider(testProvider({ stream }), capacityPolicy(store, "lease-ro"));

    await expect(callStream(wrapped, "m").result()).resolves.toMatchObject({ stopReason: "end" });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 0 } });
    store.close();
  });
});

describeSqlite("provider wrapper lease renewal (bd-187 W1)", () => {
  interface TimerHarness {
    handlers: Array<{ handle: ReturnType<typeof setInterval>; interval: number; fire(): void }>;
    cleared: ReturnType<typeof setInterval>[];
    setIntervalFn: (handler: () => void, intervalInMs: number) => ReturnType<typeof setInterval>;
    clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;
  }

  function timerHarness(): TimerHarness {
    const handlers: TimerHarness["handlers"] = [];
    const cleared: ReturnType<typeof setInterval>[] = [];
    return {
      handlers,
      cleared,
      setIntervalFn: (handler, interval) => {
        const handle = { id: handlers.length + 1 } as unknown as ReturnType<typeof setInterval>;
        handlers.push({ handle, interval, fire: handler });
        return handle;
      },
      clearIntervalFn: (handle) => {
        cleared.push(handle);
      },
    };
  }

  it("renews past the original TTL so the slot stays held, then frees it on settle", async () => {
    // Same-connection renewal mechanics only. The cross-connection/WAL property
    // the heartbeat exists for is proven with real processes in
    // `test/model-state-cross-process.integration.test.ts`; this test does not
    // stand in for it.
    const dir = tempDir();
    const path = join(dir, "model-state.sqlite");
    let fakeNow = 0;
    const opened = openModelStateStore({ path, now: () => fakeNow });
    if (!opened.ok) throw new Error(opened.error);
    const store = opened.store;
    const timers = timerHarness();
    let settle: ((value: unknown) => void) | undefined;
    const result = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const wrapped = wrapProvider(
      testProvider({ stream: () => ({ result: () => result }) }),
      createProviderPolicy({
        store: () => store,
        now: () => fakeNow,
        capacity: {
          limit: 1,
          classOf: () => "standard",
          leaseId: () => "lease-live",
          leaseTtlMs: 30_000,
        },
      }),
      { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn },
    );

    const stream = callStream(wrapped, "m");
    expect(timers.handlers).toHaveLength(1);
    expect(timers.handlers[0]?.interval).toBe(10_000);
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: fakeNow }),
    ).toMatchObject({ ok: true, value: { inUse: 1 } });

    // Renew at 20_000 (expiry would have been 30_000), then check at 35_000: the
    // slot is still held because the heartbeat extended it to 50_000.
    fakeNow = 20_000;
    timers.handlers[0]?.fire();
    fakeNow = 35_000;
    expect(
      store.reserveCapacity({
        provider: "llmgateway",
        class: "standard",
        limit: 1,
        leaseId: "rival",
        nowMs: fakeNow,
      }),
    ).toMatchObject({ ok: true, value: { granted: false, reason: "capacity-exhausted" } });

    settle?.(assistantSuccess({ input: 1 }));
    await stream.result();
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: fakeNow }),
    ).toMatchObject({ ok: true, value: { inUse: 0 } });
    expect(timers.cleared).toEqual(timers.handlers.map((entry) => entry.handle));

    expect(
      store.reserveCapacity({
        provider: "llmgateway",
        class: "standard",
        limit: 1,
        leaseId: "rival",
        nowMs: fakeNow,
      }),
    ).toMatchObject({ ok: true, value: { granted: true, inUse: 1 } });

    store.close();
  });

  it("clears the heartbeat on a rejected stream and on a synchronous throw", async () => {
    const store = openStore();
    const timers = timerHarness();
    const policy = createProviderPolicy({
      store: () => store,
      now: () => 0,
      capacity: { limit: 1, classOf: () => "standard", leaseId: () => "lease-x" },
    });

    const rejected = wrapProvider(
      testProvider({
        stream: () => ({
          result: async () => {
            throw new Error("stream aborted");
          },
        }),
      }),
      policy,
      { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn },
    );
    await expect(callStream(rejected, "m").result()).rejects.toThrow("stream aborted");
    expect(timers.handlers).toHaveLength(1);
    expect(timers.cleared).toEqual([timers.handlers[0]?.handle]);

    const secondTimers = timerHarness();
    const throwingStore = openStore();
    const throwing = wrapProvider(
      testProvider({
        stream: () => {
          throw new Error("ECONNRESET network down");
        },
      }),
      createProviderPolicy({
        store: () => throwingStore,
        now: () => 0,
        capacity: { limit: 1, classOf: () => "standard", leaseId: () => "lease-y" },
      }),
      {
        setIntervalFn: secondTimers.setIntervalFn,
        clearIntervalFn: secondTimers.clearIntervalFn,
      },
    );
    expect(() => callStream(throwing, "m")).toThrow("ECONNRESET network down");
    expect(secondTimers.handlers).toHaveLength(1);
    expect(secondTimers.cleared).toEqual([secondTimers.handlers[0]?.handle]);
    throwingStore.close();
    store.close();
  });

  it("classifies a capacity refusal and records no cooldown", () => {
    const store = openStore();
    store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "held",
      nowMs: 0,
    });
    const wrapped = wrapProvider(
      testProvider({ stream: () => streamOf(assistantSuccess({ input: 1 })) }),
      createProviderPolicy({
        store: () => store,
        now: () => 0,
        capacity: { limit: 1, classOf: () => "standard" },
      }),
    );

    let refusal: unknown;
    try {
      callStream(wrapped, "m");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ProviderPolicyRefusalError);
    if (!(refusal instanceof ProviderPolicyRefusalError)) return;
    expect(refusal.message).toContain(CAPACITY_REFUSAL_MARKER);
    const classification = classifyAssistantMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: refusal.message,
    });
    expect(classification?.kind).toBe("capacity");
    expect(isFallbackWorthy("capacity")).toBe(true);

    // Nothing upstream was spent: no cooldown row, no spend row.
    expect(store.cooldownFor({ provider: "llmgateway", model: "m", nowMs: 1 })).toMatchObject({
      ok: true,
      value: null,
    });
    expect(store.spendTotals()).toMatchObject({ ok: true, value: { rows: 0 } });
    store.close();
  });
});

describeSqlite("spend attribution is per dispatch (bd-187 W3)", () => {
  it("reads the shared holder at terminal time and a re-install cannot resurrect stale labels", async () => {
    const store = openStore();
    const holder: DispatchAttribution = { phase: "scout", taskId: "bd-1" };
    const policy = createProviderPolicy({ store: () => store });
    const provider = testProvider({
      stream: () => streamOf(assistantSuccess({ input: 1, output: 1 })),
    });
    const wrapped = wrapProvider(provider, policy, { attribution: holder });

    await callStream(wrapped, "m").result();
    const reinstalled = wrapProvider(wrapped, policy, { phase: "stale", taskId: "stale" });
    expect(reinstalled).toBe(wrapped);
    setDispatchAttribution(holder, { phase: "implement", taskId: "bd-2" });
    await callStream(reinstalled, "m").result();

    expect(readSpendRows(store.path)).toEqual([
      { phase: "scout", taskId: "bd-1", input: 1 },
      { phase: "implement", taskId: "bd-2", input: 1 },
    ]);
    store.close();
  });

  it("snapshots attribution per dispatch so a late settle cannot be relabelled", async () => {
    const store = openStore();
    const holder: DispatchAttribution = { phase: "scout", taskId: "bd-1" };
    const policy = createProviderPolicy({ store: () => store });
    let settle: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const wrapped = wrapProvider(
      testProvider({ stream: () => ({ result: () => pending }) }),
      policy,
      { attribution: holder },
    );

    const first = callStream(wrapped, "m");
    // The next run boundary repoints the holder before the first stream settles.
    setDispatchAttribution(holder, { phase: "implement", taskId: "bd-2" });
    settle?.(assistantSuccess({ input: 1, output: 1 }));
    await first.result();

    // The row records the dispatch's own attribution, not the repointed holder.
    expect(readSpendRows(store.path)).toEqual([{ phase: "scout", taskId: "bd-1", input: 1 }]);

    // The holder still governs FUTURE dispatches.
    await callStream(wrapped, "m").result();
    expect(readSpendRows(store.path)).toEqual([
      { phase: "scout", taskId: "bd-1", input: 1 },
      { phase: "implement", taskId: "bd-2", input: 1 },
    ]);
    store.close();
  });

  it("installProviderPolicy shares the caller's attribution holder", async () => {
    const store = openStore();
    const holder: DispatchAttribution = { phase: "one", taskId: "t-1" };
    const current = new Map<string, ProviderLike>([
      [
        "llmgateway",
        testProvider({ stream: () => streamOf(assistantSuccess({ input: 2, output: 1 })) }),
      ],
      ["openrouter", testProvider({ id: "openrouter" })],
    ]);
    installProviderPolicy(
      {
        getProviders: () => [...current.values()],
        setProvider: (provider) => current.set(provider.id, provider),
      },
      {
        policyFor: () => createProviderPolicy({ store: () => store }),
        directProviderId: "openrouter",
        attribution: holder,
      },
    );
    const wrapped = current.get("llmgateway");
    expect(wrapped).toBeDefined();
    if (wrapped === undefined) return;

    await callStream(wrapped, "m").result();
    setDispatchAttribution(holder, { phase: "two", taskId: "t-2" });
    await callStream(wrapped, "m").result();

    expect(readSpendRows(store.path)).toEqual([
      { phase: "one", taskId: "t-1", input: 2 },
      { phase: "two", taskId: "t-2", input: 2 },
    ]);
    store.close();
  });
});

describeSqlite("provider wrapper unresolvable model ids (bd-187 review)", () => {
  it("skips cooldown/spend writes, warns once, and still dispatches", async () => {
    const store = openStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const messages: unknown[] = [
      assistantError("429: too many requests"),
      assistantSuccess({ input: 9, output: 4, cost: { total: 1 } }),
    ];
    const calls = vi.fn();
    const stream = (() => {
      calls();
      const message = messages.shift();
      return streamOf(message);
    }) as unknown as ProviderLike["stream"];
    const wrapped = wrapProvider(
      { id: "llmgateway", stream, streamSimple: stream },
      createProviderPolicy({ store: () => store, now: () => 0 }),
    );
    const streamFn = wrapped.stream as unknown as (
      model: unknown,
      context: unknown,
    ) => ProviderStreamLike;

    await streamFn({}, {}).result();
    await streamFn({}, {}).result();

    expect(calls).toHaveBeenCalledTimes(2);
    expect(store.cooldownFor({ provider: "llmgateway", model: "", nowMs: 1 })).toMatchObject({
      ok: true,
      value: null,
    });
    expect(store.spendTotals()).toMatchObject({ ok: true, value: { rows: 0 } });
    const unknownModelWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes("without an id"),
    );
    expect(unknownModelWarnings).toHaveLength(1);
    warn.mockRestore();
    store.close();
  });
});
