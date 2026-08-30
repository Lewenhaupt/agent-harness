import { describe, expect, it } from "vitest";

import {
  type CooldownFs,
  createModelCooldownStore,
  type ModelCooldownStoreOptions,
} from "../model-cooldown.js";

describe("model cooldown store", () => {
  it("marks a model endpoint as cooling down for the requested duration", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.5", 300, "transient");

    expect(store.isCoolingDown("opencode-go/mimo-v2.5")).toBe(true);
    expect(store.isCoolingDown("opencode-go/mimo-v2.5", 1_299_999)).toBe(true);
    // At/after the boundary it is no longer cooling down.
    expect(store.isCoolingDown("opencode-go/mimo-v2.5", 1_300_000)).toBe(false);
  });

  it("does not affect other models", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.5", 300, "transient");
    expect(store.isCoolingDown("deepseek-v4-pro")).toBe(false);
  });

  it("cools every model on a provider but not the same model on another provider", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markProviderCooldown("opencode-go", 300, "quota");

    expect(store.isCoolingDown("opencode-go/mimo-v2.5")).toBe(true);
    expect(store.isCoolingDown("opencode-go/deepseek-v4-pro")).toBe(true);
    // The same bare model id on another provider has its own quota bucket.
    expect(store.isCoolingDown("llmgateway/mimo-v2.5")).toBe(false);
  });

  it("reports which scope is blocking a model", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markProviderCooldown("opencode-go", 300, "quota");
    store.markCooldown("llmgateway/mimo-v2.5", 300, "transient");

    expect(store.cooldownScope("opencode-go/mimo-v2.5")).toBe("provider");
    expect(store.cooldownScope("llmgateway/mimo-v2.5")).toBe("model");
    expect(store.cooldownScope("llmgateway/other")).toBe(undefined);
  });

  it("prunes expired entries", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.5", 300, "transient");
    store.markProviderCooldown("opencode-go", 300, "quota");

    store.prune(2_000_000);
    expect(store.isCoolingDown("opencode-go/mimo-v2.5")).toBe(false);
    expect(store.entries().size).toBe(0);
    expect(store.providerEntries().size).toBe(0);
  });

  it("keeps non-expired entries on prune", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.5", 300, "transient");

    store.prune(1_100_000);
    expect(store.isCoolingDown("opencode-go/mimo-v2.5")).toBe(true);
    expect(store.entries().size).toBe(1);
  });

  it("exposes entry snapshots for both scopes", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.5", 300, "transient");
    store.markProviderCooldown("opencode-go", 300, "quota");

    expect(store.entries().get("opencode-go/mimo-v2.5")).toHaveProperty("until", 1_300_000);
    expect(store.entries().get("opencode-go/mimo-v2.5")).toHaveProperty("reason", "transient");
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("until", 1_300_000);
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("reason", "quota");
  });
});

interface FakeFs extends CooldownFs {
  files: Map<string, string>;
}

/** In-memory fs seam: a Map of path → content, with "wx" + rename + unlink semantics. */
function createFakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync(path) {
      return files.has(path);
    },
    readFileSync(path) {
      const content = files.get(path);
      if (content === undefined) {
        const error = new Error(`ENOENT: ${path}`) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
    writeFileSync(path, data, options) {
      if (options?.flag === "wx" && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`) as Error & { code: string };
        error.code = "EEXIST";
        throw error;
      }
      files.set(path, data);
    },
    renameSync(oldPath, newPath) {
      const content = files.get(oldPath);
      if (content === undefined) {
        const error = new Error(`ENOENT: ${oldPath}`) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      files.delete(oldPath);
      files.set(newPath, content);
    },
    mkdirSync() {
      // In-memory fs has no directory hierarchy to create.
    },
    unlinkSync(path) {
      files.delete(path);
    },
  };
}

interface PersistedShape {
  providers: Record<string, { until: number; reason: string }>;
  models: Record<string, { until: number; reason: string }>;
}

function readState(fs: FakeFs, path: string): PersistedShape {
  const raw = fs.files.get(path);
  if (raw === undefined) throw new Error(`missing persisted file ${path}`);
  return JSON.parse(raw) as PersistedShape;
}

describe("model cooldown store (file persistence)", () => {
  const filePath = "/tmp/model-cooldowns.json";

  it("loads persisted provider + model entries and prunes expired ones on creation", () => {
    const fs = createFakeFs({
      [filePath]: JSON.stringify({
        version: 1,
        providers: {
          "opencode-go": { until: 1_300_000, reason: "quota" },
          "expired-provider": { until: 500_000, reason: "quota" },
        },
        models: {
          "opencode-go/mimo-v2.5": { until: 1_300_000, reason: "transient" },
          "expired-model": { until: 500_000, reason: "transient" },
        },
      }),
    });
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });

    expect(store.isCoolingDown("opencode-go/mimo-v2.5")).toBe(true);
    expect(store.isCoolingDown("expired-provider/mimo-v2.5")).toBe(false);
    expect(store.isCoolingDown("expired-model")).toBe(false);
    expect(store.entries().size).toBe(1);
    expect(store.providerEntries().size).toBe(1);
  });

  it("persists both scopes atomically and leaves no temp or lock files", () => {
    const fs = createFakeFs();
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    store.markProviderCooldown("opencode-go", 300, "quota");
    store.markCooldown("llmgateway/mimo-v2.5", 300, "transient");

    const state = readState(fs, filePath);
    expect(state.providers).toHaveProperty("opencode-go.until", 1_300_000);
    expect(state.providers).toHaveProperty("opencode-go.reason", "quota");
    expect(state.models["llmgateway/mimo-v2.5"]).toHaveProperty("until", 1_300_000);
    expect(state.models["llmgateway/mimo-v2.5"]).toHaveProperty("reason", "transient");
    expect([...fs.files.keys()]).toEqual([filePath]);
  });

  it("isCoolingDown reads persisted state from a previous store instance", () => {
    const fs = createFakeFs();
    const first = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    first.markProviderCooldown("opencode-go", 300, "quota");

    // Simulates an orchestrator restart: a fresh store over the same file.
    const restarted = createModelCooldownStore({ now: () => 1_100_000, filePath, fs });
    expect(restarted.isCoolingDown("opencode-go/mimo-v2.5")).toBe(true);
    expect(restarted.cooldownScope("opencode-go/mimo-v2.5")).toBe("provider");
  });

  it("treats a corrupt persisted file as empty without throwing", () => {
    const fs = createFakeFs({ [filePath]: "not valid json" });
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    expect(store.entries().size).toBe(0);
    expect(store.providerEntries().size).toBe(0);
  });

  it("preserves on-disk entries from other writers when persisting", () => {
    const fs = createFakeFs({
      [filePath]: JSON.stringify({
        version: 1,
        providers: { "other-provider": { until: 2_000_000, reason: "quota" } },
        models: { "other-provider/x": { until: 2_000_000, reason: "transient" } },
      }),
    });
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    store.markCooldown("llmgateway/mimo-v2.5", 300, "transient");

    const state = readState(fs, filePath);
    expect(state.providers).toHaveProperty("other-provider.until", 2_000_000);
    expect(state.models["other-provider/x"]).toHaveProperty("until", 2_000_000);
    expect(state.models["llmgateway/mimo-v2.5"]).toHaveProperty("until", 1_300_000);
  });

  it("accepts an options object with explicit now and fs seams", () => {
    const options: ModelCooldownStoreOptions = {
      now: () => 1_000_000,
      filePath,
      fs: createFakeFs(),
    };
    const store = createModelCooldownStore(options);
    store.markProviderCooldown("opencode-go", 300, "quota");
    expect(store.isCoolingDown("opencode-go/mimo-v2.5")).toBe(true);
  });
});
