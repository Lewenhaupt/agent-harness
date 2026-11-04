/**
 * The routing cooldown adapter (bd-256).
 *
 * `ModelCooldownStore` used to be a JSON store of its own; it is now a typed view
 * over the shared `ModelStateStore`, so routing and the provider wrapper read and
 * write one truth. These tests pin the adapter's own semantics (scopes, entry
 * shape, escalation parity, degradation), the process-wide path resolution the
 * default store uses, and the one-time legacy import (windows *and* ladder).
 *
 * The JSON store's merge/lock/preferred-window rules are gone with the file:
 * cross-process ordering is now the SQLite store's job and is covered by
 * `model-state-store.test.ts` and `provider-policy.test.ts`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModelCooldownStore,
  defaultModelCooldownPath,
  MAX_ESCALATED_COOLDOWN_SECONDS,
} from "../model-cooldown.js";
import type { ModelStateStore } from "../model-state-store.js";
import {
  defaultModelStatePath,
  modelStatePathForCooldownFile,
  openModelStateStore,
  resetSharedModelStateStore,
  resolveModelStatePath,
  SHARED_MODEL_STATE_RETRY_MS,
  sharedModelStateStore,
} from "../model-state-store.js";

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

/** A retired cooldown path; only ever used as the legacy import source. */
function tempCooldownFile(): string {
  return join(tempDir(), "model-cooldowns.json");
}

/** A private store the test owns; every adapter over it shares one truth. */
function openTempStore(now: () => number, dir = tempDir()): ModelStateStore {
  const opened = openModelStateStore({ path: join(dir, "model-state.sqlite"), now });
  if (!opened.ok) throw new Error(opened.error);
  openedStores.push(opened.store);
  return opened.store;
}

/** Adapter over a private in-memory store: explicit test isolation. */
function memoryStore(now: () => number = () => 1_000_000) {
  return createModelCooldownStore({ now, store: "memory" });
}

describe("model cooldown paths", () => {
  it("keeps the retired file as a source path, overridable by env", () => {
    const previous = process.env.BELAYD_MODEL_COOLDOWN_FILE;
    process.env.BELAYD_MODEL_COOLDOWN_FILE = "/tmp/belayd-cooldowns.json";
    try {
      expect(defaultModelCooldownPath()).toBe("/tmp/belayd-cooldowns.json");
    } finally {
      if (previous === undefined) delete process.env.BELAYD_MODEL_COOLDOWN_FILE;
      else process.env.BELAYD_MODEL_COOLDOWN_FILE = previous;
    }
  });

  it("derives a state store path from a retired cooldown path", () => {
    expect(modelStatePathForCooldownFile("/state/model-cooldowns.json")).toBe(
      "/state/model-cooldowns.sqlite",
    );
    expect(modelStatePathForCooldownFile("/state/no-extension")).toBe("/state/no-extension.sqlite");
  });
});

describeSqlite("model cooldown adapter (bd-256)", () => {
  it("marks a model endpoint as cooling down for the requested duration", () => {
    const store = memoryStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");

    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash", 1_299_999)).toBe(true);
    // At/after the boundary it is no longer cooling down.
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash", 1_300_000)).toBe(false);
  });

  it("does not affect other models", () => {
    const store = memoryStore();
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");
    expect(store.isCoolingDown("deepseek-v4.1-flash")).toBe(false);
  });

  it("cools every model on a provider but not the same model on another provider", () => {
    const store = memoryStore();
    store.markProviderCooldown("opencode-go", 300, "quota");

    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(store.isCoolingDown("opencode-go/deepseek-v4.1-flash")).toBe(true);
    // The same bare model id on another provider has its own quota bucket.
    expect(store.isCoolingDown("llmgateway/mimo-v2.6-flash")).toBe(false);
  });

  it("cools a bare model id across providers", () => {
    // A provider-less mark is provider-agnostic: it is the only window the
    // caller could mean, and the fallback loop may retry the id elsewhere.
    const store = memoryStore();
    store.markCooldown("mimo-v2.6-flash", 300, "transient");

    expect(store.isCoolingDown("mimo-v2.6-flash")).toBe(true);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(store.isCoolingDown("llmgateway/mimo-v2.6-flash")).toBe(true);
    expect(store.cooldownScope("opencode-go/mimo-v2.6-flash")).toBe("model");
  });

  it("reports which scope is blocking a model, provider-wide outranking the endpoint", () => {
    const store = memoryStore();
    store.markProviderCooldown("opencode-go", 300, "quota");
    store.markCooldown("llmgateway/mimo-v2.6-flash", 300, "transient");

    expect(store.cooldownScope("opencode-go/mimo-v2.6-flash")).toBe("provider");
    expect(store.cooldownScope("llmgateway/mimo-v2.6-flash")).toBe("model");
    expect(store.cooldownScope("llmgateway/other")).toBe(undefined);

    // A provider-wide window plus an endpoint window on the same provider: the
    // credential is the stronger truth, so the provider scope wins (unchanged
    // from the retired JSON store, which checked the provider map first).
    store.markCooldown("opencode-go/mimo-v2.6-flash", 60, "transient", { nowMs: 1_000_000 });
    expect(store.cooldownScope("opencode-go/mimo-v2.6-flash")).toBe("provider");
  });

  it("prunes expired entries", () => {
    const store = memoryStore();
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");
    store.markProviderCooldown("opencode-go", 300, "quota");

    store.prune(2_000_000);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(false);
    expect(store.entries().size).toBe(0);
    expect(store.providerEntries().size).toBe(0);
  });

  it("keeps non-expired entries on prune", () => {
    const store = memoryStore();
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");

    store.prune(1_100_000);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(store.entries().size).toBe(1);
  });

  it("exposes entry snapshots for both scopes", () => {
    const store = memoryStore();
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");
    store.markProviderCooldown("opencode-go", 300, "quota", { cause: "quota" });

    expect(store.entries().get("opencode-go/mimo-v2.6-flash")).toHaveProperty("until", 1_300_000);
    expect(store.entries().get("opencode-go/mimo-v2.6-flash")).toHaveProperty(
      "reason",
      "transient",
    );
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("until", 1_300_000);
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("reason", "quota");
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("cause", "quota");
  });

  it("lets an injected store be null, degrading to nothing cooling", () => {
    // The read-only/unopenable case: never throw, never block a spawn.
    const store = createModelCooldownStore({ store: null });
    store.markProviderCooldown("opencode-go", 300, "quota");
    store.markCooldown("llmgateway/mimo-v2.6-flash", 300, "transient");

    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(false);
    expect(store.cooldownScope("opencode-go/mimo-v2.6-flash")).toBe(undefined);
    expect(store.entries().size).toBe(0);
    expect(store.providerEntries().size).toBe(0);
    expect(() => store.refresh()).not.toThrow();
    expect(() => store.refreshIfStale(1_000)).not.toThrow();
    expect(() => store.prune()).not.toThrow();
  });

  it("lets an injected store provider be resolved lazily", () => {
    const opened = openModelStateStore({ path: join(tempDir(), "state.sqlite"), now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    openedStores.push(opened.store);

    let calls = 0;
    const store = createModelCooldownStore({
      now: () => 0,
      store: () => {
        calls += 1;
        return opened.store;
      },
    });
    expect(calls).toBe(0);

    store.markProviderCooldown("opencode-go", 60, "quota");
    expect(calls).toBe(1);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
  });
});

describeSqlite("model cooldown default store is the shared truth (bd-256 review)", () => {
  const ENV_KEYS = [
    "BELAYD_MODEL_STATE_FILE",
    "BELAYD_MODEL_COOLDOWN_FILE",
    "XDG_STATE_HOME",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    resetSharedModelStateStore();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    resetSharedModelStateStore();
  });

  // One row per env combination: the explicit state file, the retired cooldown
  // path, or XDG must decide the path — and the adapter must agree with it.
  const matrix = [
    { stateFile: true, legacyFile: true },
    { stateFile: true, legacyFile: false },
    { stateFile: false, legacyFile: true },
    { stateFile: false, legacyFile: false },
  ] as const;

  it.each(matrix)(
    "adapter and resolveModelStatePath agree (stateFile=$stateFile, legacyFile=$legacyFile)",
    ({ stateFile, legacyFile }) => {
      const dir = tempDir();
      const statePath = join(dir, "explicit-state.sqlite");
      const legacyPath = join(dir, "model-cooldowns.json");
      process.env.XDG_STATE_HOME = join(dir, "xdg");
      if (stateFile) process.env.BELAYD_MODEL_STATE_FILE = statePath;
      else delete process.env.BELAYD_MODEL_STATE_FILE;
      if (legacyFile) process.env.BELAYD_MODEL_COOLDOWN_FILE = legacyPath;
      else delete process.env.BELAYD_MODEL_COOLDOWN_FILE;

      const expected = resolveModelStatePath({ env: process.env });
      // The default construction opens no file until it is used, then resolves
      // the one path the whole process agrees on.
      const adapter = createModelCooldownStore();
      adapter.markProviderCooldown("opencode-go", 600, "quota");

      const shared = sharedModelStateStore();
      expect(shared).not.toBeNull();
      expect(shared?.path).toBe(expected);
      expect(adapter.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
      expect(
        shared?.cooldownFor({ provider: "opencode-go", model: "mimo-v2.6-flash" }),
      ).toMatchObject({ ok: true, value: { scope: "provider" } });
    },
  );

  it("uses exactly the same path as defaultModelStatePath()", () => {
    const dir = tempDir();
    process.env.XDG_STATE_HOME = join(dir, "xdg");
    delete process.env.BELAYD_MODEL_STATE_FILE;
    delete process.env.BELAYD_MODEL_COOLDOWN_FILE;

    createModelCooldownStore().markProviderCooldown("opencode-go", 60, "quota");
    expect(sharedModelStateStore()?.path).toBe(defaultModelStatePath());
  });

  it("sees another adapter's mark over the shared store without a refresh", () => {
    process.env.BELAYD_MODEL_STATE_FILE = join(tempDir(), "shared.sqlite");
    delete process.env.BELAYD_MODEL_COOLDOWN_FILE;

    const reader = createModelCooldownStore();
    const writer = createModelCooldownStore();

    expect(reader.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(false);
    writer.markProviderCooldown("opencode-go", 3_600, "quota", { cause: "quota" });

    expect(reader.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(reader.cooldownScope("opencode-go/other")).toBe("provider");
    expect(reader.providerEntries().get("opencode-go")).toHaveProperty("cause", "quota");
  });

  it("refresh is unbounded and never throws, even without a store", () => {
    process.env.BELAYD_MODEL_STATE_FILE = join(tempDir(), "refresh.sqlite");
    const store = createModelCooldownStore();
    expect(() => store.refresh()).not.toThrow();
    expect(() => store.refreshIfStale()).not.toThrow();
    expect(() => store.refreshIfStale(1_000, 999_999)).not.toThrow();

    const permissive = createModelCooldownStore({ store: null });
    expect(() => permissive.refresh()).not.toThrow();
  });
});

describeSqlite("model cooldown adapter clock (bd-256 review)", () => {
  it("marks with the adapter clock, not the store's", () => {
    const adapterClock = 1_000_000;
    const storeClock = 9_000_000;
    const opened = openModelStateStore({
      path: join(tempDir(), "state.sqlite"),
      now: () => storeClock,
    });
    if (!opened.ok) throw new Error(opened.error);
    openedStores.push(opened.store);
    const adapter = createModelCooldownStore({ now: () => adapterClock, store: opened.store });

    adapter.markProviderCooldown("opencode-go", 300, "quota");
    adapter.markCooldown("llmgateway/mimo-v2.6-flash", 60, "transient");

    // The absolute window comes from the adapter clock (1_000_000), not the
    // store's 9_000_000: the deterministic overload must actually be usable.
    expect(adapter.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      adapterClock + 300_000,
    );
    expect(adapter.entries().get("llmgateway/mimo-v2.6-flash")).toHaveProperty(
      "until",
      adapterClock + 60_000,
    );
    expect(adapter.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(adapter.isCoolingDown("opencode-go/mimo-v2.6-flash", adapterClock + 300_000)).toBe(
      false,
    );
  });
});

describeSqlite("model cooldown facade via a store provider (bd-256 review round 3)", () => {
  const nowMs = 1_000_000;
  const ENV_KEYS = [
    "BELAYD_MODEL_STATE_FILE",
    "BELAYD_MODEL_COOLDOWN_FILE",
    "XDG_STATE_HOME",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
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

  it("never caches a facade a store provider returned, and migrates only after recovery", () => {
    const legacyPath = tempCooldownFile();
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        providers: { commandcode: { until: nowMs + 3_600_000, reason: "quota" } },
      }),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = nowMs;
      vi.setSystemTime(t0);
      // The shared accessor is inside a transient outage, exactly the state the
      // extension's `store: () => sharedModelStateStoreInstance()` reaches.
      expect(
        sharedModelStateStore(() => Date.now(), {
          open: () => ({ ok: false, error: "SQLITE_BUSY: database is locked" }),
        })?.pendingFlush,
      ).toBe(true);

      let calls = 0;
      const cooldown = createModelCooldownStore({
        now: () => Date.now(),
        store: () => {
          calls += 1;
          return sharedModelStateStore(() => Date.now());
        },
        filePath: legacyPath,
      });

      // Call 1 hands back the facade: the mark is queued, but nothing is cached
      // and the legacy import is not latched against an unusable store.
      cooldown.markProviderCooldown("llmgateway", 600, "quota", { cause: "quota" });
      expect(calls).toBe(1);
      expect(cooldown.providerEntries().size).toBe(0);
      expect(existsSync(`${legacyPath}.imported`)).toBe(false);

      // Every later read consults the provider again: a memoized facade would
      // have stopped asking here and reported "nothing cooling" for the session.
      const beforeRead = calls;
      expect(cooldown.isCoolingDown("llmgateway/mimo-v2.6-flash")).toBe(false);
      expect(calls).toBe(beforeRead + 1);

      // Recovery: past the retry window the accessor opens the real store, which
      // flushes the queue before serving the read that runs the import.
      vi.setSystemTime(t0 + SHARED_MODEL_STATE_RETRY_MS + 1);
      expect(cooldown.isCoolingDown("commandcode/glm-5.3")).toBe(true);
      expect(existsSync(`${legacyPath}.imported`)).toBe(true);
      expect(calls).toBe(beforeRead + 2);

      // Both the queued mark and the migrated legacy window are in the one truth
      // this adapter now reads.
      expect([...cooldown.providerEntries().keys()].sort()).toEqual(["commandcode", "llmgateway"]);
      expect(cooldown.providerEntries().get("llmgateway")).toHaveProperty("cause", "quota");
      expect(
        sharedModelStateStore()?.cooldownFor({ provider: "commandcode", model: "glm-5.3" }),
      ).toMatchObject({ ok: true, value: { scope: "provider" } });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

describeSqlite("model cooldown adapter escalation parity (bd-256)", () => {
  const SIX_HOURS = 6 * 60 * 60;

  it("doubles an unhinted provider window that is still cooling", () => {
    const store = memoryStore();
    store.markProviderCooldown("opencode-go", SIX_HOURS, "GoUsageLimitError");

    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + SIX_HOURS * 1000,
    );
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("escalations", 1);

    // A second unhinted 429 on the same provider must cost more than the first:
    // re-guessing the same window is what re-probed a weekly limit forever.
    store.markProviderCooldown("opencode-go", SIX_HOURS, "GoUsageLimitError", { nowMs: 2_000_000 });
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      2_000_000 + 2 * SIX_HOURS * 1000,
    );
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("escalations", 2);
  });

  it("clamps the escalated window at the hard ceiling", () => {
    const store = memoryStore();
    for (let i = 0; i < 6; i += 1) {
      store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    }

    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + MAX_ESCALATED_COOLDOWN_SECONDS * 1000,
    );
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("escalations", 6);
  });

  it("treats a hinted reset as authoritative and clears the ladder", () => {
    const store = memoryStore();
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("escalations", 2);

    store.markProviderCooldown("opencode-go", 3_600, "Weekly usage limit reached. Resets in 1hr", {
      hinted: true,
    });
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + 3_600_000,
    );
    expect(store.providerEntries().get("opencode-go")).not.toHaveProperty("escalations");

    // The next unhinted mark restarts the ladder at the first rung.
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("escalations", 1);
  });

  it("leaves model-scoped marks un-escalated and out of the provider ladder", () => {
    const store = memoryStore();
    store.markCooldown("llmgateway/mimo-v2.6-flash", 300, "transient");
    store.markCooldown("llmgateway/mimo-v2.6-flash", 300, "transient");
    store.markCooldown("mimo-v2.6-flash", 300, "transient");

    expect(store.entries().get("llmgateway/mimo-v2.6-flash")).toHaveProperty("until", 1_300_000);
    expect(store.entries().get("llmgateway/mimo-v2.6-flash")).not.toHaveProperty("escalations");
    expect(store.entries().get("mimo-v2.6-flash")).not.toHaveProperty("escalations");

    // A provider mark afterwards is the first rung: the model marks above did
    // not advance the provider's ladder.
    store.markProviderCooldown("llmgateway", SIX_HOURS, "quota");
    expect(store.providerEntries().get("llmgateway")).toHaveProperty("escalations", 1);
  });
});

describeSqlite("model cooldown adapter legacy import (bd-256)", () => {
  const nowMs = 1_000_000;
  const now = (): number => nowMs;

  function seedLegacy(filePath: string, state: unknown): string {
    const text = JSON.stringify(state);
    writeFileSync(filePath, text);
    return text;
  }

  it("imports still-active windows once and leaves the user's file untouched", () => {
    const filePath = tempCooldownFile();
    const original = seedLegacy(filePath, {
      version: 1,
      providers: {
        "opencode-go": { until: 1_300_000, reason: "quota", cause: "quota" },
        commandcode: { until: 500_000, reason: "expired" },
      },
      models: { "llmgateway/glm-5.3": { until: 1_200_000, reason: "transient" } },
    });

    const store = createModelCooldownStore({ now, store: openTempStore(now), filePath });

    // The active provider window blocks every model on it; the expired one does
    // not, and the model window blocks only its endpoint.
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("cause", "quota");
    expect(store.isCoolingDown("commandcode/glm-5.3-flash")).toBe(false);
    expect(store.isCoolingDown("llmgateway/glm-5.3")).toBe(true);
    expect(store.isCoolingDown("llmgateway/other")).toBe(false);

    // The source is a source: it is never rewritten or deleted.
    expect(readFileSync(filePath, "utf8")).toBe(original);
    expect(existsSync(`${filePath}.imported`)).toBe(true);
  });

  it("does not import again on a later open, even if the legacy file changed", () => {
    const filePath = tempCooldownFile();
    seedLegacy(filePath, {
      version: 1,
      providers: { "opencode-go": { until: 1_300_000, reason: "quota" } },
    });
    // One store, two adapters: the marker is per file, as it is across processes.
    const shared = openTempStore(now);

    const first = createModelCooldownStore({ now, store: shared, filePath });
    expect(first.providerEntries().get("opencode-go")).toHaveProperty("until", 1_300_000);

    // A peer still on the previous build appends a window after the migration.
    // The import is one-shot, so it is not replayed into the shared store.
    seedLegacy(filePath, {
      version: 1,
      providers: {
        "opencode-go": { until: 1_300_000, reason: "quota" },
        llmgateway: { until: 1_900_000, reason: "quota" },
      },
    });

    const second = createModelCooldownStore({ now, store: shared, filePath });
    expect([...second.providerEntries().keys()]).toEqual(["opencode-go"]);
  });

  it("keeps the longer window already in the store on conflict", () => {
    const dir = tempDir();
    const filePath = join(dir, "model-cooldowns.json");
    const shared = openTempStore(now, dir);
    shared.markCooldown({
      provider: "opencode-go",
      durationMs: 3_600_000,
      reason: "live",
      nowMs,
    });

    seedLegacy(filePath, {
      version: 1,
      providers: { "opencode-go": { until: 1_100_000, reason: "stale legacy" } },
    });

    const store = createModelCooldownStore({ now, store: shared, filePath });
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + 3_600_000,
    );
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("reason", "live");
  });

  it("replays an escalated legacy ladder so the next unhinted mark continues it", () => {
    const filePath = tempCooldownFile();
    seedLegacy(filePath, {
      version: 1,
      providers: { "opencode-go": { until: nowMs + 3_600_000, reason: "quota" } },
      escalations: { "opencode-go": { count: 3, lastMarkedAt: nowMs - 2 * 86_400_000 } },
    });

    const store = createModelCooldownStore({ now, store: openTempStore(now), filePath });
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("until", nowMs + 3_600_000);

    // The migration must not drop the bucket back to rung 1: the next guess is
    // rung 4, i.e. 900 s doubled three times.
    store.markProviderCooldown("opencode-go", 900, "quota");
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      nowMs + 900 * 2 ** 3 * 1000,
    );
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("escalations", 4);
  });

  it("ignores a legacy ladder older than the escalation memory", () => {
    const filePath = tempCooldownFile();
    seedLegacy(filePath, {
      version: 1,
      providers: { "opencode-go": { until: nowMs + 3_600_000, reason: "quota" } },
      escalations: { "opencode-go": { count: 3, lastMarkedAt: nowMs - 8 * 86_400_000 } },
    });

    const store = createModelCooldownStore({ now, store: openTempStore(now), filePath });
    store.markProviderCooldown("opencode-go", 900, "quota");

    // A weekly bucket that reset more than a week ago is a fresh limit.
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("until", nowMs + 900 * 1000);
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("escalations", 1);
  });

  it("lets a longer legacy window replace a shorter escalated window without clearing its rung", () => {
    const filePath = tempCooldownFile();
    const shared = openTempStore(now);
    const before = createModelCooldownStore({ now, store: shared });
    before.markProviderCooldown("opencode-go", 60, "quota");
    before.markProviderCooldown("opencode-go", 60, "quota");
    expect(before.providerEntries().get("opencode-go")).toHaveProperty("escalations", 2);

    seedLegacy(filePath, {
      version: 1,
      providers: {
        "opencode-go": { until: nowMs + 3_600_000, reason: "weekly limit" },
      },
      escalations: { "opencode-go": { count: 2, lastMarkedAt: nowMs } },
    });

    const migrated = createModelCooldownStore({ now, store: shared, filePath });
    expect(migrated.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      nowMs + 3_600_000,
    );
    migrated.markProviderCooldown("opencode-go", 60, "quota");
    expect(migrated.providerEntries().get("opencode-go")).toHaveProperty("escalations", 3);
  });

  it("replays a hinted legacy reset so the ladder restarts at rung 1", () => {
    const filePath = tempCooldownFile();
    const shared = openTempStore(now);
    const before = createModelCooldownStore({ now, store: shared });
    before.markProviderCooldown("opencode-go", 60, "quota");
    before.markProviderCooldown("opencode-go", 60, "quota");
    expect(before.providerEntries().get("opencode-go")).toHaveProperty("escalations", 2);

    // The old store recorded a hinted reset as a later count-0 ladder event.
    seedLegacy(filePath, {
      version: 1,
      providers: { "opencode-go": { until: nowMs + 1_200_000, reason: "Resets in 20min" } },
      escalations: { "opencode-go": { count: 0, lastMarkedAt: nowMs + 1_000 } },
    });

    const migrated = createModelCooldownStore({ now, store: shared, filePath });
    expect(migrated.providerEntries().get("opencode-go")).not.toHaveProperty("escalations");
    migrated.markProviderCooldown("opencode-go", 900, "quota");
    expect(migrated.providerEntries().get("opencode-go")).toHaveProperty("escalations", 1);
    expect(migrated.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      nowMs + 900 * 1000,
    );
  });

  it("skips malformed legacy entries instead of discarding the file", () => {
    const filePath = tempCooldownFile();
    seedLegacy(filePath, {
      version: 1,
      providers: {
        "opencode-go": { until: 1_300_000, reason: "quota" },
        "broken-provider": { until: "soon", reason: "quota" },
      },
      models: { "broken-model": { reason: "missing until" } },
      escalations: { "broken-ladder": { count: "two", lastMarkedAt: 1_000_000 } },
    });

    const store = createModelCooldownStore({ now, store: openTempStore(now), filePath });
    expect([...store.providerEntries().keys()]).toEqual(["opencode-go"]);
    expect(store.entries().size).toBe(0);
  });

  it("marks the migration done even when the file yields no active windows", () => {
    const filePath = tempCooldownFile();
    seedLegacy(filePath, {
      version: 1,
      providers: { "opencode-go": { until: 500_000, reason: "expired" } },
    });

    const store = createModelCooldownStore({ now, store: openTempStore(now), filePath });
    expect(store.providerEntries().size).toBe(0);
    // A corrupt/expired file must not be re-parsed on every open.
    expect(existsSync(`${filePath}.imported`)).toBe(true);
  });

  it("leaves the migration pending when there is no legacy file yet", () => {
    const filePath = tempCooldownFile();
    const store = createModelCooldownStore({ now, store: openTempStore(now), filePath });
    expect(store.providerEntries().size).toBe(0);
    expect(existsSync(`${filePath}.imported`)).toBe(false);
  });

  it("treats a corrupt legacy file as empty and records the migration", () => {
    const filePath = tempCooldownFile();
    writeFileSync(filePath, "{ broken");

    const store = createModelCooldownStore({ now, store: openTempStore(now), filePath });
    expect(store.providerEntries().size).toBe(0);
    expect(existsSync(`${filePath}.imported`)).toBe(true);
  });

  it("resolves a thunk filePath on first use, not at construction (review)", () => {
    const dir = tempDir();
    const firstPath = join(dir, "first.json");
    const secondPath = join(dir, "second.json");
    seedLegacy(secondPath, {
      version: 1,
      providers: { "opencode-go": { until: nowMs + 60_000, reason: "quota" } },
    });
    const previous = process.env.BELAYD_MODEL_COOLDOWN_FILE;
    process.env.BELAYD_MODEL_COOLDOWN_FILE = firstPath;
    try {
      const store = createModelCooldownStore({
        now,
        store: openTempStore(now),
        // The extension's shape: resolve the env-derived path lazily.
        filePath: () => defaultModelCooldownPath(),
      });
      // The environment changes after construction but before the first use.
      process.env.BELAYD_MODEL_COOLDOWN_FILE = secondPath;

      expect(store.providerEntries().get("opencode-go")).toHaveProperty("until", nowMs + 60_000);
      expect(existsSync(`${secondPath}.imported`)).toBe(true);
      expect(existsSync(`${firstPath}.imported`)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BELAYD_MODEL_COOLDOWN_FILE;
      else process.env.BELAYD_MODEL_COOLDOWN_FILE = previous;
    }
  });

  it("writes the marker beside a nested legacy file", () => {
    const filePath = join(tempDir(), "nested", "agent", "model-cooldowns.json");
    mkdirSync(dirname(filePath), { recursive: true });
    seedLegacy(filePath, { version: 1, providers: {} });
    const store = createModelCooldownStore({ now, store: openTempStore(now), filePath });
    expect(store.providerEntries().size).toBe(0);
    expect(existsSync(`${filePath}.imported`)).toBe(true);
  });
});
