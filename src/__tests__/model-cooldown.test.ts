import { describe, expect, it } from "vitest";

import { createModelCooldownStore } from "../model-cooldown.js";

describe("model cooldown store", () => {
  it("marks a model as cooling down for the requested duration", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("mimo-v2.5", 300, "quota");

    expect(store.isCoolingDown("mimo-v2.5")).toBe(true);
    expect(store.isCoolingDown("mimo-v2.5", 1_299_999)).toBe(true);
    // At/after the boundary it is no longer cooling down.
    expect(store.isCoolingDown("mimo-v2.5", 1_300_000)).toBe(false);
  });

  it("does not affect other models", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("mimo-v2.5", 300, "quota");
    expect(store.isCoolingDown("deepseek-v4-pro")).toBe(false);
  });

  it("prunes expired entries", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("mimo-v2.5", 300, "quota");

    store.prune(2_000_000);
    expect(store.isCoolingDown("mimo-v2.5")).toBe(false);
    expect(store.entries().size).toBe(0);
  });

  it("keeps non-expired entries on prune", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("mimo-v2.5", 300, "quota");

    store.prune(1_100_000);
    expect(store.isCoolingDown("mimo-v2.5")).toBe(true);
    expect(store.entries().size).toBe(1);
  });

  it("exposes an entries snapshot", () => {
    const store = createModelCooldownStore(() => 1_000_000);
    store.markCooldown("mimo-v2.5", 300, "quota");
    expect(store.entries().get("mimo-v2.5")).toHaveProperty("until", 1_300_000);
    expect(store.entries().get("mimo-v2.5")).toHaveProperty("reason", "quota");
  });
});
