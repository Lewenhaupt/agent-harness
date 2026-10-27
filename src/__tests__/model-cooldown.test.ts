import { describe, expect, it } from "vitest";

import {
  type CooldownFs,
  createModelCooldownStore,
  MAX_ESCALATED_COOLDOWN_SECONDS,
  type ModelCooldownStoreOptions,
} from "../model-cooldown.js";

describe("model cooldown store", () => {
  it("marks a model endpoint as cooling down for the requested duration", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");

    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash", 1_299_999)).toBe(true);
    // At/after the boundary it is no longer cooling down.
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash", 1_300_000)).toBe(false);
  });

  it("does not affect other models", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");
    expect(store.isCoolingDown("deepseek-v4.1-flash")).toBe(false);
  });

  it("cools every model on a provider but not the same model on another provider", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markProviderCooldown("opencode-go", 300, "quota");

    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(store.isCoolingDown("opencode-go/deepseek-v4.1-flash")).toBe(true);
    // The same bare model id on another provider has its own quota bucket.
    expect(store.isCoolingDown("llmgateway/mimo-v2.6-flash")).toBe(false);
  });

  it("reports which scope is blocking a model", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markProviderCooldown("opencode-go", 300, "quota");
    store.markCooldown("llmgateway/mimo-v2.6-flash", 300, "transient");

    expect(store.cooldownScope("opencode-go/mimo-v2.6-flash")).toBe("provider");
    expect(store.cooldownScope("llmgateway/mimo-v2.6-flash")).toBe("model");
    expect(store.cooldownScope("llmgateway/other")).toBe(undefined);
  });

  it("prunes expired entries", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");
    store.markProviderCooldown("opencode-go", 300, "quota");

    store.prune(2_000_000);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(false);
    expect(store.entries().size).toBe(0);
    expect(store.providerEntries().size).toBe(0);
  });

  it("keeps non-expired entries on prune", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");

    store.prune(1_100_000);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(store.entries().size).toBe(1);
  });

  it("exposes entry snapshots for both scopes", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("opencode-go/mimo-v2.6-flash", 300, "transient");
    store.markProviderCooldown("opencode-go", 300, "quota");

    expect(store.entries().get("opencode-go/mimo-v2.6-flash")).toHaveProperty("until", 1_300_000);
    expect(store.entries().get("opencode-go/mimo-v2.6-flash")).toHaveProperty(
      "reason",
      "transient",
    );
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
          "opencode-go/mimo-v2.6-flash": { until: 1_300_000, reason: "transient" },
          "expired-model": { until: 500_000, reason: "transient" },
        },
      }),
    });
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });

    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(store.isCoolingDown("expired-provider/mimo-v2.6-flash")).toBe(false);
    expect(store.isCoolingDown("expired-model")).toBe(false);
    expect(store.entries().size).toBe(1);
    expect(store.providerEntries().size).toBe(1);
  });

  it("persists both scopes atomically and leaves no temp or lock files", () => {
    const fs = createFakeFs();
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    store.markProviderCooldown("opencode-go", 300, "quota");
    store.markCooldown("llmgateway/mimo-v2.6-flash", 300, "transient");

    const state = readState(fs, filePath);
    expect(state.providers).toHaveProperty("opencode-go.until", 1_300_000);
    expect(state.providers).toHaveProperty("opencode-go.reason", "quota");
    expect(state.models["llmgateway/mimo-v2.6-flash"]).toHaveProperty("until", 1_300_000);
    expect(state.models["llmgateway/mimo-v2.6-flash"]).toHaveProperty("reason", "transient");
    expect([...fs.files.keys()]).toEqual([filePath]);
  });

  it("isCoolingDown reads persisted state from a previous store instance", () => {
    const fs = createFakeFs();
    const first = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    first.markProviderCooldown("opencode-go", 300, "quota");

    // Simulates an orchestrator restart: a fresh store over the same file.
    const restarted = createModelCooldownStore({ now: () => 1_100_000, filePath, fs });
    expect(restarted.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
    expect(restarted.cooldownScope("opencode-go/mimo-v2.6-flash")).toBe("provider");
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
    store.markCooldown("llmgateway/mimo-v2.6-flash", 300, "transient");

    const state = readState(fs, filePath);
    expect(state.providers).toHaveProperty("other-provider.until", 2_000_000);
    expect(state.models["other-provider/x"]).toHaveProperty("until", 2_000_000);
    expect(state.models["llmgateway/mimo-v2.6-flash"]).toHaveProperty("until", 1_300_000);
  });

  it("carries unknown file fields through a read-modify-write", () => {
    // A newer (or older) version may write fields this one does not know. They
    // must survive a rewrite instead of being silently stripped at the boundary.
    const fs = createFakeFs({
      [filePath]: JSON.stringify({
        version: 1,
        futureTopLevel: { enabled: true },
        providers: {
          "opencode-go": { until: 1_300_000, reason: "quota", futureField: "kept" },
        },
        models: {},
      }),
    });
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    store.markCooldown("llmgateway/glm-5.3", 300, "transient");

    const raw = JSON.parse(fs.files.get(filePath) ?? "{}") as Record<string, unknown>;
    expect(raw).toHaveProperty("futureTopLevel", { enabled: true });
    const providers = raw.providers as Record<string, Record<string, unknown>>;
    expect(providers["opencode-go"]).toHaveProperty("futureField", "kept");
    expect(providers["opencode-go"]).toHaveProperty("until", 1_300_000);
    const models = raw.models as Record<string, Record<string, unknown>>;
    expect(models["llmgateway/glm-5.3"]).toHaveProperty("until", 1_300_000);
  });

  it("accepts an options object with explicit now and fs seams", () => {
    const options: ModelCooldownStoreOptions = {
      now: () => 1_000_000,
      filePath,
      fs: createFakeFs(),
    };
    const store = createModelCooldownStore(options);
    store.markProviderCooldown("opencode-go", 300, "quota");
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
  });
});

describe("model cooldown store (unhinted escalation)", () => {
  const SIX_HOURS = 6 * 60 * 60;

  it("doubles an unhinted provider window that is still cooling", () => {
    const store = createModelCooldownStore(() => 1_000_000);
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

  it("escalates even after the previous window expired inside the memory horizon", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    // The window expired 1 hour ago, so the provider is no longer cooling but the
    // ladder is still remembered.
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota", {
      nowMs: 1_000_000 + (SIX_HOURS + 3_600) * 1000,
    });

    expect(store.providerEntries().get("opencode-go")).toHaveProperty("escalations", 2);
  });

  it("clamps the escalated window at the hard ceiling", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    for (let i = 0; i < 6; i += 1) {
      store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    }

    const entry = store.providerEntries().get("opencode-go");
    expect(entry).toHaveProperty("until", 1_000_000 + MAX_ESCALATED_COOLDOWN_SECONDS * 1000);
    expect(entry).toHaveProperty("escalations", 6);
  });

  it("treats a hinted reset as authoritative and clears the ladder", () => {
    const store = createModelCooldownStore(() => 1_000_000);
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

  it("leaves model-scoped marks un-escalated", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("llmgateway/mimo-v2.6-flash", 300, "transient");
    store.markCooldown("llmgateway/mimo-v2.6-flash", 300, "transient");

    expect(store.entries().get("llmgateway/mimo-v2.6-flash")).toHaveProperty("until", 1_300_000);
    expect(store.entries().get("llmgateway/mimo-v2.6-flash")).not.toHaveProperty("escalations");
  });

  it("persists a hinted reset that is shorter than the escalated window", () => {
    const fs = createFakeFs();
    const filePath = "/tmp/model-cooldowns.json";
    let now = 1_000_000;
    const store = createModelCooldownStore({ now: () => now, filePath, fs });
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    now += 1_000;
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota"); // escalated to 12 h
    now += 1_000;
    store.markProviderCooldown("opencode-go", 3_600, "Resets in 1hr", { hinted: true });

    // The hint is authoritative even though it is shorter than the guess.
    const state = readState(fs, filePath);
    expect(state.providers["opencode-go"]).toHaveProperty("until", 1_002_000 + 3_600_000);
    expect(state.providers["opencode-go"]).not.toHaveProperty("escalations");

    // A restart must not resurrect the escalated window or its ladder.
    now += 1_000;
    const restarted = createModelCooldownStore({ now: () => now, filePath, fs });
    expect(restarted.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_002_000 + 3_600_000,
    );
    restarted.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    expect(restarted.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_003_000 + SIX_HOURS * 1000,
    );
  });

  it("round-trips the escalation count through the file", () => {
    const fs = createFakeFs();
    const filePath = "/tmp/model-cooldowns.json";
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");

    const state = readState(fs, filePath);
    expect(state.providers["opencode-go"]).toHaveProperty("escalations", 2);

    // A restart resumes the ladder instead of resetting it.
    const restarted = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    restarted.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    expect(restarted.providerEntries().get("opencode-go")).toHaveProperty("escalations", 3);
  });

  it("does not let a stale shorter file window shorten a live longer one", () => {
    // The regression the shared ordering rule exists for: a file holding a short
    // window (written by another process before this one marked) must never
    // overwrite a longer window this process just produced.
    const fs = createFakeFs();
    const filePath = "/tmp/model-cooldowns.json";
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    store.markProviderCooldown("opencode-go", 12 * 3_600, "GoUsageLimitError");

    // The file entry has no lastMarkedAt while this process's does, so
    // `preferEntry`'s branch 2 applies: the stamps are incomparable and the tie
    // ordering decides, where the longer `until` (12 h) beats the file's 400 s.
    fs.files.set(
      filePath,
      JSON.stringify({
        version: 1,
        providers: { "opencode-go": { until: 1_400_000, reason: "hinted" } },
        models: {},
      }),
    );

    // Any unrelated mark triggers persist().
    store.markCooldown("llmgateway/glm-5.3", 300, "transient");

    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + 12 * 3_600 * 1000,
    );
    const state = readState(fs, filePath);
    expect(state.providers["opencode-go"]).toHaveProperty("until", 1_000_000 + 12 * 3_600 * 1000);
  });

  it("lets a fresh shorter hint in the file win over an older longer window", () => {
    // The other direction: ordering by until would keep this process's older 12 h
    // guess forever, because the authoritative 1 h hint is shorter.
    const fs = createFakeFs();
    const filePath = "/tmp/model-cooldowns.json";
    let now = 1_000_000;
    const store = createModelCooldownStore({ now: () => now, filePath, fs });
    store.markProviderCooldown("opencode-go", 12 * 3_600, "quota");

    now = 1_500_000;
    const otherMember = createModelCooldownStore({ now: () => now, filePath, fs });
    otherMember.markProviderCooldown("opencode-go", 3_600, "Resets in 1hr", { hinted: true });

    store.refresh();
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_500_000 + 3_600_000,
    );
    expect(store.providerEntries().get("opencode-go")).not.toHaveProperty("escalations");
  });

  it("keeps the higher ladder count on a mark-time tie in both directions", () => {
    const fs = createFakeFs();
    const filePath = "/tmp/model-cooldowns.json";
    // One fixed instant for every mark: neither member can prove event order, so
    // the merge must prefer the longer ladder rather than the later writer.
    const clock = () => 1_000_000;

    const staleMember = createModelCooldownStore({ now: clock, filePath, fs });
    const writer = createModelCooldownStore({ now: clock, filePath, fs });
    writer.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    writer.markProviderCooldown("opencode-go", SIX_HOURS, "quota"); // ladder 2 on disk

    // The stale member only knows rung 1, yet its persist must not downgrade the
    // ladder: its next mark therefore escalates to rung 3 (24 h).
    staleMember.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    staleMember.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    expect(staleMember.providerEntries().get("opencode-go")).toHaveProperty("escalations", 3);
    expect(staleMember.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + SIX_HOURS * 4 * 1000,
    );

    // Reverse direction: the writer refreshes and adopts the higher ladder.
    writer.refresh();
    writer.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    expect(writer.providerEntries().get("opencode-go")).toHaveProperty("escalations", 4);
  });
  it("skips only the malformed entries of a hand-edited file", () => {
    const fs = createFakeFs({
      "/tmp/model-cooldowns.json": JSON.stringify({
        version: 1,
        providers: {
          "opencode-go": { until: 1_300_000, reason: "quota" },
          "broken-provider": { until: "soon", reason: "quota" },
        },
        models: {
          "llmgateway/glm-5.3": { until: 1_300_000, reason: "transient" },
          "broken-model": { reason: "missing until" },
        },
        escalations: {
          // A stored ladder rung: the next unhinted mark resumes it.
          "opencode-go": { count: 1, lastMarkedAt: 1_000_000 },
          "broken-ladder": { count: "two", lastMarkedAt: 1_000_000 },
          "unstamped-ladder": { count: 3 },
        },
      }),
    });
    const store = createModelCooldownStore({
      now: () => 1_000_000,
      filePath: "/tmp/model-cooldowns.json",
      fs,
    });

    // One malformed sibling must not discard the healthy entry next to it.
    expect([...store.providerEntries().keys()]).toEqual(["opencode-go"]);
    expect([...store.entries().keys()]).toEqual(["llmgateway/glm-5.3"]);
    expect(store.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);

    // The valid rung is honoured; the malformed ones contribute nothing, and a
    // rewrite drops them instead of resurrecting them.
    store.markProviderCooldown("opencode-go", SIX_HOURS, "quota");
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("escalations", 2);
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + 2 * SIX_HOURS * 1000,
    );
    const state = readState(fs, "/tmp/model-cooldowns.json");
    expect([...Object.keys(state.providers)]).toEqual(["opencode-go"]);
  });

  it("loads a version-1 file written before escalation existed", () => {
    const fs = createFakeFs({
      "/tmp/model-cooldowns.json": JSON.stringify({
        version: 1,
        providers: { "opencode-go": { until: 1_300_000, reason: "quota" } },
        models: { "opencode-go/x": { until: 1_300_000, reason: "transient" } },
      }),
    });
    const store = createModelCooldownStore({
      now: () => 1_000_000,
      filePath: "/tmp/model-cooldowns.json",
      fs,
    });

    expect(store.providerEntries().get("opencode-go")).toHaveProperty("until", 1_300_000);
    expect(store.providerEntries().get("opencode-go")).not.toHaveProperty("escalations");
    expect(store.isCoolingDown("opencode-go/x")).toBe(true);
  });
});

describe("model cooldown store (refresh)", () => {
  const filePath = "/tmp/model-cooldowns.json";

  it("sees a cooldown another store wrote to the same file", () => {
    const fs = createFakeFs();
    const fleetMember = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    const other = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });

    // `other` is a second process that loaded the file before the escalation.
    fleetMember.markProviderCooldown("opencode-go", 3_600, "quota");
    fleetMember.markProviderCooldown("opencode-go", 3_600, "quota");

    other.refresh();
    expect(other.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + 7_200_000,
    );
    expect(other.providerEntries().get("opencode-go")).toHaveProperty("escalations", 2);
    expect(other.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
  });

  it("keeps one complete mark per key, preferring the longer window on a tie", () => {
    const fs = createFakeFs();
    const first = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    const second = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });

    first.markProviderCooldown("opencode-go", 3_600, "quota");
    first.markProviderCooldown("opencode-go", 3_600, "quota");
    // Both stores mark at the same instant, so neither mark is newer; the
    // longer window wins and it keeps its own reason and ladder count, rather
    // than pairing one mark's window with the other's diagnostics.
    second.markProviderCooldown("opencode-go", 10_000, "provider entitlement");
    second.markProviderCooldown("llmgateway", 600, "quota");

    first.refresh();
    const entry = first.providerEntries().get("opencode-go");
    expect(entry).toHaveProperty("until", 1_000_000 + 10_000_000);
    expect(entry).toHaveProperty("reason", "provider entitlement");
    expect(entry).toHaveProperty("escalations", 1);
    expect(first.providerEntries().get("llmgateway")).toHaveProperty("until", 1_600_000);
  });

  it("does not shorten an in-memory entry that is further out than the file", () => {
    const fs = createFakeFs();
    const keeper = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    keeper.markProviderCooldown("opencode-go", 10_000, "quota");

    const reader = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    // A later writer replaces the file with a *shorter* window.
    fs.files.set(
      filePath,
      JSON.stringify({
        version: 1,
        providers: { "opencode-go": { until: 1_300_000, reason: "quota" } },
        models: {},
      }),
    );
    // The reader already holds the longer in-memory entry from creation.
    expect(reader.providerEntries().get("opencode-go")).toHaveProperty("until", 11_000_000);

    reader.refresh();
    expect(reader.providerEntries().get("opencode-go")).toHaveProperty("until", 11_000_000);
  });

  it("prunes expired entries it reads back", () => {
    const fs = createFakeFs({
      [filePath]: JSON.stringify({
        version: 1,
        providers: { "gone-provider": { until: 500_000, reason: "quota" } },
        models: {},
      }),
    });
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    fs.files.set(
      filePath,
      JSON.stringify({
        version: 1,
        providers: { "gone-provider": { until: 500_000, reason: "quota" } },
        models: {},
      }),
    );

    store.refresh();
    expect(store.providerEntries().size).toBe(0);
  });

  it("adopts a longer unstamped window written by an older-build member", () => {
    // Mixed-version fleet: a member still running the previous build writes
    // fresh entries with no lastMarkedAt. Stamp absence is not evidence of age,
    // so its newer, longer window must still be adopted.
    const fs = createFakeFs();
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    store.markProviderCooldown("opencode-go", 3_600, "quota");

    fs.files.set(
      filePath,
      JSON.stringify({
        version: 1,
        providers: {
          "opencode-go": { until: 1_000_000 + 6 * 3_600 * 1000, reason: "GoUsageLimitError" },
        },
        models: {},
      }),
    );

    store.refresh();
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + 6 * 3_600 * 1000,
    );
  });

  it("never clobbers an older-build member's longer unstamped window", () => {
    const fs = createFakeFs();
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    store.markProviderCooldown("opencode-go", 3_600, "quota");

    fs.files.set(
      filePath,
      JSON.stringify({
        version: 1,
        providers: {
          "opencode-go": { until: 1_000_000 + 6 * 3_600 * 1000, reason: "GoUsageLimitError" },
        },
        models: {},
      }),
    );

    // persist() reloads the file, so this unrelated mark must keep the longer
    // unstamped window instead of writing this process's shorter one back.
    store.markCooldown("llmgateway/glm-5.3", 300, "transient");

    const expected = 1_000_000 + 6 * 3_600 * 1000;
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("until", expected);
    const state = readState(fs, filePath);
    expect(state.providers["opencode-go"]).toHaveProperty("until", expected);
  });

  it("keeps a live longer window over a stale unstamped one", () => {
    // The converse: an unstamped *stale* window must still lose to the live
    // longer window this process holds.
    const fs = createFakeFs();
    const store = createModelCooldownStore({ now: () => 1_000_000, filePath, fs });
    store.markProviderCooldown("opencode-go", 12 * 3_600, "quota");

    fs.files.set(
      filePath,
      JSON.stringify({
        version: 1,
        providers: { "opencode-go": { until: 1_400_000, reason: "hinted" } },
        models: {},
      }),
    );

    store.refresh();
    expect(store.providerEntries().get("opencode-go")).toHaveProperty(
      "until",
      1_000_000 + 12 * 3_600 * 1000,
    );
  });

  it("never throws on a missing, corrupt, or unreadable file", () => {
    const missing = createFakeFs();
    const missingStore = createModelCooldownStore({ now: () => 1_000_000, filePath, fs: missing });
    expect(() => missingStore.refresh()).not.toThrow();
    expect(missingStore.providerEntries().size).toBe(0);

    const corrupt = createFakeFs({ [filePath]: "not valid json" });
    const corruptStore = createModelCooldownStore({ now: () => 1_000_000, filePath, fs: corrupt });
    corruptStore.markProviderCooldown("opencode-go", 300, "quota");
    corrupt.files.set(filePath, "{ broken");
    expect(() => corruptStore.refresh()).not.toThrow();

    const unreadable = createFakeFs({ [filePath]: JSON.stringify({ version: 1 }) });
    const unreadableStore = createModelCooldownStore({
      now: () => 1_000_000,
      filePath,
      fs: {
        ...unreadable,
        readFileSync() {
          throw new Error("EACCES");
        },
      },
    });
    expect(() => unreadableStore.refresh()).not.toThrow();
  });

  it("is a no-op for an in-memory store", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markProviderCooldown("opencode-go", 300, "quota");

    expect(() => store.refresh()).not.toThrow();
    expect(store.providerEntries().get("opencode-go")).toHaveProperty("until", 1_300_000);
  });
});
