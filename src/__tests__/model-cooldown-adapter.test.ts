/**
 * One cooldown truth, both directions (bd-256).
 *
 * bd-187 added the SQLite `ModelStateStore` for the provider wrapper while the
 * routing layer kept the JSON store, so a 402 the wrapper classified never
 * steered a spawn and a cooldown the routing path recorded never blocked a
 * wrapped dispatch. These tests pin the two directions against the same store:
 *
 * - wrapper -> routing: a classified quota failure recorded at the terminal
 *   observation is refused by the routing readers, `planModelRoute` and
 *   `spawnAgentWithFallback`, and nothing is written to the retired JSON file.
 * - routing -> wrapper: a cooldown marked through `ModelCooldownStore` makes
 *   `decideDispatch` deny and a wrapped dispatch throw before touching the
 *   provider.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sharedModelStateStoreInstance } from "../../extensions/capabilities/model.js";
import type { SpawnResult, SpawnUsage } from "../agent-registry.js";
import { createModelCooldownStore } from "../model-cooldown.js";
import type { ModelStateStore } from "../model-state-store.js";
import {
  openModelStateStore,
  resetSharedModelStateStore,
  SHARED_MODEL_STATE_RETRY_MS,
  sharedModelStateStore,
} from "../model-state-store.js";
import { planModelRoute } from "../orchestrator-model.js";
import { createProviderPolicy } from "../provider-policy.js";
import type { ProviderLike, ProviderStreamLike } from "../provider-wrapper.js";
import { ProviderPolicyRefusalError, wrapProvider } from "../provider-wrapper.js";
import { spawnAgentWithFallback } from "../spawn-with-fallback.js";

const mockSpawnAgentProcess = vi.hoisted(() => vi.fn());

vi.mock("../spawn.js", () => ({
  spawnAgentProcess: mockSpawnAgentProcess,
}));

const sqliteProbe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
});
const describeSqlite = sqliteProbe.status === 0 ? describe : describe.skip;

const tempDirs: string[] = [];
const openedStores: ModelStateStore[] = [];

afterEach(() => {
  for (const store of openedStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-cooldown-adapter-"));
  tempDirs.push(dir);
  return dir;
}

function openStore(now: () => number): ModelStateStore {
  const opened = openModelStateStore({ path: join(tempDir(), "model-state.sqlite"), now });
  if (!opened.ok) throw new Error(opened.error);
  openedStores.push(opened.store);
  return opened.store;
}

/** The live 402 body that motivated bd-229: a provider-wide quota failure. */
const BILLING_ERROR =
  '402: {"message":"Dev Plan credit limit reached. Upgrade your plan or wait for renewal",' +
  '"type":"invalid_request_error","param":null,"code":"billing_error"}';

const HINTED_WEEKLY =
  '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 1hr."}';

function assistantError(errorMessage: string, model = "mimo-v2.6-flash"): Record<string, unknown> {
  return { role: "assistant", stopReason: "error", model, errorMessage };
}

function streamOf(message: unknown): ProviderStreamLike {
  return { result: async () => message };
}

interface TestProvider extends ProviderLike {
  baseUrl: string;
}

function testProvider(overrides: Partial<TestProvider> = {}): TestProvider {
  return {
    id: "llmgateway",
    baseUrl: "https://llmgateway.example",
    stream: () => streamOf(assistantError(BILLING_ERROR)),
    streamSimple: () => streamOf(assistantError(BILLING_ERROR)),
    ...overrides,
  };
}

function callStream(provider: ProviderLike, model: string): ProviderStreamLike {
  const stream = provider.stream as unknown as (
    model: unknown,
    context: unknown,
  ) => ProviderStreamLike;
  return stream({ id: model }, {});
}

function zeroUsage(): SpawnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 };
}

function makeResult(model: string): SpawnResult {
  return {
    content: [{ type: "text", text: `result-from-${model}` }],
    details: { messages: [], usage: zeroUsage(), exitCode: 0, model },
  };
}

describeSqlite("one cooldown truth: wrapper -> routing (bd-256)", () => {
  it("makes a wrapper-recorded quota failure skip the next spawn and the launch plan", async () => {
    let nowMs = 1_000_000;
    const now = (): number => nowMs;
    const store = openStore(now);
    const policy = createProviderPolicy({ store: () => store, now });
    const cooldown = createModelCooldownStore({ now, store });
    // The retired file is never written again: nothing must appear here.
    const legacyPath = join(tempDir(), "model-cooldowns.json");

    // The wrapper classifies the terminal message and records the failure; no
    // routing code is involved in the write.
    const wrapped = wrapProvider(testProvider(), policy);
    await callStream(wrapped, "mimo-v2.6-flash").result();

    // Routing sees the same verdict immediately.
    expect(cooldown.isCoolingDown("llmgateway/mimo-v2.6-flash")).toBe(true);
    expect(cooldown.cooldownScope("llmgateway/mimo-v2.6-flash")).toBe("provider");
    expect(cooldown.providerEntries().get("llmgateway")).toHaveProperty("cause", "quota");

    const plan = planModelRoute({
      current: "llmgateway/mimo-v2.6-flash",
      isBlocked: (candidate) => cooldown.cooldownScope(candidate) !== undefined,
    });
    expect(plan.currentUsable).toBe(false);
    expect(plan.blocked).toContain("llmgateway/mimo-v2.6-flash");
    expect(plan.available.every((candidate) => !candidate.startsWith("llmgateway/"))).toBe(true);

    // The fallback loop skips the wrapper-spent provider and serves the run
    // from another one.
    nowMs = 1_000_000;
    mockSpawnAgentProcess.mockReset();
    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.6-flash"));
    const { attempts, selection } = await spawnAgentWithFallback({
      model: "llmgateway/mimo-v2.6-flash",
      candidates: ["llmgateway/mimo-v2.6-flash", "opencode-go/mimo-v2.6-flash"],
      tools: [],
      systemPrompt: "t",
      task: "t",
      cooldownStore: cooldown,
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    const spawned = mockSpawnAgentProcess.mock.calls[0]?.[0] as { model?: string } | undefined;
    expect(spawned?.model).toBe("opencode-go/mimo-v2.6-flash");
    expect(attempts[0]).toHaveProperty("skippedProvider", "llmgateway");
    expect(selection).toHaveProperty("servedModel", "opencode-go/mimo-v2.6-flash");

    // No JSON write anywhere in that path.
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("escalates a repeated wrapper failure and clears it on a hinted reset", async () => {
    let nowMs = 1_000_000;
    const now = (): number => nowMs;
    const store = openStore(now);
    const policy = createProviderPolicy({ store: () => store, now });
    const cooldown = createModelCooldownStore({ now, store });

    // An unhinted 402 guesses the generic 15-minute window.
    await callStream(wrapProvider(testProvider(), policy), "mimo-v2.6-flash").result();
    expect(cooldown.providerEntries().get("llmgateway")).toHaveProperty(
      "until",
      nowMs + 15 * 60 * 1000,
    );

    // The window lapses and the provider is probed again; the second guess
    // doubles, because re-guessing the same span is what re-probed forever.
    nowMs += 16 * 60 * 1000;
    await callStream(wrapProvider(testProvider(), policy), "mimo-v2.6-flash").result();
    expect(cooldown.providerEntries().get("llmgateway")).toHaveProperty(
      "until",
      nowMs + 30 * 60 * 1000,
    );
    expect(cooldown.providerEntries().get("llmgateway")).toHaveProperty("escalations", 2);

    // A provider-supplied reset window is authoritative and clears the ladder.
    nowMs += 31 * 60 * 1000;
    const hinted = testProvider({ stream: () => streamOf(assistantError(HINTED_WEEKLY)) });
    await callStream(wrapProvider(hinted, policy), "mimo-v2.6-flash").result();
    expect(cooldown.providerEntries().get("llmgateway")).toHaveProperty(
      "until",
      nowMs + 60 * 60 * 1000,
    );
    expect(cooldown.providerEntries().get("llmgateway")).not.toHaveProperty("escalations");
  });
});

describeSqlite("one cooldown truth: routing -> wrapper (bd-256)", () => {
  it("refuses a wrapped dispatch on a provider the routing path cooled", () => {
    const now = (): number => 1_000_000;
    const store = openStore(now);
    const cooldown = createModelCooldownStore({ now, store });
    const policy = createProviderPolicy({ store: () => store, now });

    cooldown.markProviderCooldown("llmgateway", 3_600, "quota", { cause: "quota" });

    expect(
      policy.decideDispatch({ provider: "llmgateway", model: "mimo-v2.6-flash" }),
    ).toMatchObject({ allowed: false, scope: "provider" });

    const stream = vi.fn(() => streamOf(assistantError(BILLING_ERROR)));
    const wrapped = wrapProvider(testProvider({ stream }), policy);
    expect(() => callStream(wrapped, "mimo-v2.6-flash")).toThrow(ProviderPolicyRefusalError);
    expect(stream).not.toHaveBeenCalled();
  });

  it("keeps a model-scoped routing cooldown to its own endpoint", () => {
    const now = (): number => 1_000_000;
    const store = openStore(now);
    const cooldown = createModelCooldownStore({ now, store });
    const policy = createProviderPolicy({ store: () => store, now });

    cooldown.markCooldown("opencode-go/mimo-v2.6-flash", 600, "transient");

    expect(
      policy.decideDispatch({ provider: "opencode-go", model: "mimo-v2.6-flash" }),
    ).toMatchObject({ allowed: false, scope: "model" });
    // The same provider's other endpoints are untouched.
    expect(policy.decideDispatch({ provider: "opencode-go", model: "glm-5.3" })).toEqual({
      allowed: true,
    });
    // And so is the cooled model id on a different provider.
    expect(policy.decideDispatch({ provider: "llmgateway", model: "mimo-v2.6-flash" })).toEqual({
      allowed: true,
    });
  });
});

describeSqlite("the default cooldown store is not isolated (bd-256 review)", () => {
  const ENV_KEYS = [
    "BELAYD_MODEL_STATE_FILE",
    "BELAYD_MODEL_COOLDOWN_FILE",
    "XDG_STATE_HOME",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    mockSpawnAgentProcess.mockReset();
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    // Every default construction must resolve this process-wide path; isolating
    // it keeps the test off the operator's real store.
    process.env.XDG_STATE_HOME = join(tempDir(), "xdg");
    process.env.BELAYD_MODEL_STATE_FILE = join(tempDir(), "state.sqlite");
    delete process.env.BELAYD_MODEL_COOLDOWN_FILE;
    resetSharedModelStateStore();
  });

  afterEach(() => {
    resetSharedModelStateStore();
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  it("sees a wrapper-recorded cooldown when spawnAgentWithFallback omits cooldownStore", async () => {
    const policy = createProviderPolicy({ store: () => sharedModelStateStore() });
    await callStream(wrapProvider(testProvider(), policy), "mimo-v2.6-flash").result();

    // The default adapter is the shared truth, not a private copy.
    const defaultCooldown = createModelCooldownStore();
    expect(defaultCooldown.providerEntries().get("llmgateway")).toHaveProperty("cause", "quota");

    mockSpawnAgentProcess.mockResolvedValueOnce(makeResult("opencode-go/mimo-v2.6-flash"));
    const { attempts, selection } = await spawnAgentWithFallback({
      model: "llmgateway/mimo-v2.6-flash",
      candidates: ["llmgateway/mimo-v2.6-flash", "opencode-go/mimo-v2.6-flash"],
      tools: [],
      systemPrompt: "t",
      task: "t",
      // Deliberately no cooldownStore: the default must not fabricate amnesia.
    });

    expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
    const spawned = mockSpawnAgentProcess.mock.calls[0]?.[0] as { model?: string } | undefined;
    expect(spawned?.model).toBe("opencode-go/mimo-v2.6-flash");
    expect(attempts[0]).toHaveProperty("skippedProvider", "llmgateway");
    expect(selection).toHaveProperty("servedModel", "opencode-go/mimo-v2.6-flash");
  });

  it("refuses a wrapped dispatch on a cooldown the default adapter recorded", () => {
    // The routing side (no explicit store) writes; the wrapper's policy reads.
    const cooldown = createModelCooldownStore();
    cooldown.markProviderCooldown("llmgateway", 3_600, "quota", { cause: "quota" });

    const policy = createProviderPolicy({ store: () => sharedModelStateStore() });
    const stream = vi.fn(() => streamOf(assistantError(BILLING_ERROR)));
    const wrapped = wrapProvider(testProvider({ stream }), policy);

    expect(() => callStream(wrapped, "mimo-v2.6-flash")).toThrow(ProviderPolicyRefusalError);
    expect(stream).not.toHaveBeenCalled();
  });

  it("recovers a transient open failure and both paths agree", async () => {
    // A busy store is the transient class: the accessor must warn once, queue
    // marks, and pick the store up after the retry window.
    const recoveredPath = join(tempDir(), "recovered.sqlite");
    process.env.BELAYD_MODEL_STATE_FILE = recoveredPath;
    resetSharedModelStateStore();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const failedAt = Date.now();
      const facade = sharedModelStateStore(() => Date.now(), {
        open: () => ({ ok: false, error: "SQLITE_BUSY: database is locked" }),
      });
      expect(facade?.pendingFlush).toBe(true);

      // While the store is unavailable the wrapper's failure is captured, and
      // the adapter still sees the facade (never memoized as the truth).
      const policy = createProviderPolicy({ store: () => sharedModelStateStore() });
      await callStream(wrapProvider(testProvider(), policy), "mimo-v2.6-flash").result();

      // The lock clears; the next access after the backoff opens and flushes.
      vi.setSystemTime(failedAt + SHARED_MODEL_STATE_RETRY_MS + 1);
      const opened = openModelStateStore({ path: recoveredPath, now: () => Date.now() });
      if (!opened.ok) throw new Error(opened.error);
      openedStores.push(opened.store);
      const recovered = sharedModelStateStore(() => Date.now(), {
        open: () => ({ ok: true, store: opened.store }),
      });
      expect(recovered).toBe(opened.store);

      expect(createModelCooldownStore().providerEntries().get("llmgateway")).toHaveProperty(
        "cause",
        "quota",
      );
      // The queued wrapper failure now blocks the next wrapped dispatch.
      expect(() => callStream(wrapProvider(testProvider(), policy), "mimo-v2.6-flash")).toThrow(
        ProviderPolicyRefusalError,
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("recovers the extension-shaped adapter when it was built during the outage", async () => {
    const dir = tempDir();
    const legacyPath = join(dir, "model-cooldowns.json");
    process.env.BELAYD_MODEL_STATE_FILE = join(dir, "state.sqlite");
    resetSharedModelStateStore();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      expect(
        sharedModelStateStore(() => Date.now(), {
          open: () => ({ ok: false, error: "SQLITE_BUSY: database is locked" }),
        })?.pendingFlush,
      ).toBe(true);

      // Exactly how the extension builds its adapter: a provider thunk over the
      // shared accessor, constructed while the store is unavailable. Memoizing
      // the facade here is what reintroduced two truths for the rest of a
      // session, with no legacy JSON to fall back on.
      const cooldown = createModelCooldownStore({
        store: () => sharedModelStateStoreInstance(),
        filePath: () => legacyPath,
      });
      const policy = createProviderPolicy({ store: sharedModelStateStoreInstance });

      // The wrapper classifies the 402 into the facade while persistence is gone.
      await callStream(wrapProvider(testProvider(), policy), "mimo-v2.6-flash").result();
      expect(cooldown.providerEntries().size).toBe(0);

      // The lock clears; no reconstruction, no restart.
      vi.setSystemTime(t0 + SHARED_MODEL_STATE_RETRY_MS + 1);

      // wrapper -> routing: the queued failure is the row the adapter reads, so
      // both the launch plan and the fallback loop refuse the spent provider.
      expect(cooldown.providerEntries().get("llmgateway")).toHaveProperty("cause", "quota");
      expect(
        policy.decideDispatch({ provider: "llmgateway", model: "mimo-v2.6-flash" }),
      ).toMatchObject({ allowed: false, scope: "provider" });
      const plan = planModelRoute({
        current: "llmgateway/mimo-v2.6-flash",
        isBlocked: (candidate) => cooldown.cooldownScope(candidate) !== undefined,
      });
      expect(plan.currentUsable).toBe(false);
      expect(plan.blocked).toContain("llmgateway/mimo-v2.6-flash");

      // routing -> wrapper: a cooldown the adapter records refuses the next
      // wrapped dispatch, still through the same (never cached) facade.
      cooldown.markProviderCooldown("opencode-go", 600, "quota", { cause: "quota" });
      expect(
        policy.decideDispatch({ provider: "opencode-go", model: "mimo-v2.6-flash" }),
      ).toMatchObject({ allowed: false, scope: "provider" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});
