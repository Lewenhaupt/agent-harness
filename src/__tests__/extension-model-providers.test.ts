import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ModelRegistryLike } from "../../extensions/capabilities/model.js";
import {
  beginProviderRegistrationSession,
  DIRECT_PROVIDER_FALLBACK_ID,
  reconcileDeferredProviders,
  registerModelProviderWrappers,
  warnProviderRegistrationFailure,
} from "../../extensions/capabilities/model.js";
import { createProviderPolicy } from "../provider-policy.js";
import type { ProviderLike, ProviderStreamLike } from "../provider-wrapper.js";
import { isPolicyWrapped } from "../provider-wrapper.js";

function fakeProvider(id: string): ProviderLike {
  const streamLike: ProviderStreamLike = {
    result: async () => ({ role: "assistant", stopReason: "end", model: id }),
  };
  return {
    id,
    stream: () => streamLike,
    streamSimple: () => streamLike,
  };
}

interface FakePiOptions {
  missing?: readonly string[];
  failRegister?: readonly string[];
  registeredOnly?: readonly string[];
  emptyIdFor?: readonly string[];
  getAllThrows?: boolean;
}

function fakePi(
  providerIds: readonly string[],
  options: FakePiOptions = {},
): {
  pi: ExtensionAPI;
  registry: ModelRegistryLike;
  registered: ProviderLike[];
  /** Make a previously missing provider object appear (mid-session materialise). */
  materialise: (id: string) => void;
} {
  const missing = new Set(options.missing ?? []);
  const failRegister = new Set(options.failRegister ?? []);
  const emptyIdFor = new Set(options.emptyIdFor ?? []);
  const providers = new Map<string, ProviderLike>(
    providerIds.map((id) => [
      id,
      emptyIdFor.has(id) ? { ...fakeProvider(id), id: "" } : fakeProvider(id),
    ]),
  );
  for (const id of options.registeredOnly ?? []) {
    if (!providers.has(id)) providers.set(id, fakeProvider(id));
  }
  const registered: ProviderLike[] = [];
  const registry: ModelRegistryLike = {
    getAll: () => {
      if (options.getAllThrows === true) throw new Error("registry iteration failed");
      return providerIds.map((provider) => ({ provider }));
    },
    getProvider: (id: string) => (missing.has(id) ? undefined : providers.get(id)),
    getRegisteredProviderIds: () => options.registeredOnly ?? [],
  };
  // `registerProvider` updates the fake registry the way pi applies a native
  // provider registration, so a second session_start sees the wrapper.
  const pi = {
    registerProvider: (provider: ProviderLike) => {
      if (failRegister.has(provider.id)) throw new Error("registry busy");
      registered.push(provider);
      providers.set(provider.id, provider);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    registry,
    registered,
    materialise: (id: string) => {
      missing.delete(id);
      if (!providers.has(id)) providers.set(id, fakeProvider(id));
    },
  };
}

function policyFactory() {
  return () => createProviderPolicy({ store: () => null });
}

describe("extension provider registration (bd-187)", () => {
  it("wraps every provider except the direct fallback", () => {
    const { pi, registry, registered } = fakePi(["openrouter", "llmgateway"]);
    const result = registerModelProviderWrappers(pi, registry, {
      enabled: true,
      policyFor: policyFactory(),
    });

    expect(result).toEqual({
      wrapped: ["openrouter"],
      direct: [DIRECT_PROVIDER_FALLBACK_ID],
      bypassed: [],
      deferred: [],
    });
    expect(registered.map((provider) => provider.id)).toEqual(["openrouter"]);
  });

  it("keeps one provider direct when the preferred fallback is not registered", () => {
    const { pi, registry, registered } = fakePi(["openrouter", "commandcode"]);
    const result = registerModelProviderWrappers(pi, registry, {
      enabled: true,
      policyFor: policyFactory(),
    });

    expect(result).toEqual({
      wrapped: ["openrouter"],
      direct: ["commandcode"],
      bypassed: [],
      deferred: [],
    });
    expect(registered.map((provider) => provider.id)).toEqual(["openrouter"]);
  });

  it("wraps a registered-only provider that has no catalog models yet", () => {
    const { pi, registry, registered } = fakePi(["llmgateway", "openrouter"], {
      registeredOnly: ["lazy-provider"],
    });
    const result = registerModelProviderWrappers(pi, registry, {
      enabled: true,
      policyFor: policyFactory(),
    });

    expect(result.wrapped).toEqual(["lazy-provider", "openrouter"]);
    expect(registered.map((provider) => provider.id)).toEqual(["lazy-provider", "openrouter"]);
  });

  it("does not wrap the wrapper again on a later session_start", () => {
    const { pi, registry, registered } = fakePi(["llmgateway", "openrouter"]);
    const options = { enabled: true, policyFor: policyFactory() };

    registerModelProviderWrappers(pi, registry, options);
    const second = registerModelProviderWrappers(pi, registry, options);

    expect(second).toEqual({
      wrapped: ["openrouter"],
      direct: ["llmgateway"],
      bypassed: [],
      deferred: [],
    });
    expect(registered).toHaveLength(1);
    const wrapped = registered[0];
    expect(wrapped).toBeDefined();
    if (wrapped !== undefined) expect(isPolicyWrapped(wrapped)).toBe(true);
  });

  it("registers nothing when disabled", () => {
    const { pi, registry, registered } = fakePi(["llmgateway", "openrouter"]);
    const result = registerModelProviderWrappers(pi, registry, { enabled: false });
    expect(result).toEqual({ wrapped: [], direct: [], bypassed: [], deferred: [] });
    expect(registered).toEqual([]);
  });

  it("skips partial test mocks without a registry or registerProvider", () => {
    const pi = {} as unknown as ExtensionAPI;
    expect(registerModelProviderWrappers(pi, undefined, { enabled: true })).toEqual({
      wrapped: [],
      direct: [],
      bypassed: [],
      deferred: [],
    });
    expect(
      registerModelProviderWrappers(
        pi,
        { getAll: () => [], getProvider: () => undefined },
        { enabled: true },
      ),
    ).toEqual({ wrapped: [], direct: [], bypassed: [], deferred: [] });
  });

  it("does not open the shared store while registering", () => {
    // The store is resolved lazily per dispatch. Registration only builds
    // wrappers, so no state file exists before the first turn.
    const policyFor = vi.fn(() => createProviderPolicy({ store: () => null }));
    const { pi, registry } = fakePi(["openrouter", "llmgateway"]);
    registerModelProviderWrappers(pi, registry, { enabled: true, policyFor });
    expect(policyFor).toHaveBeenCalledTimes(1);
  });

  it("warns once naming every bypassed provider and reason, excluding the direct provider", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pi, registry } = fakePi(["llmgateway", "openrouter", "broken"], {
      missing: ["broken"],
      failRegister: ["openrouter"],
    });

    const result = registerModelProviderWrappers(pi, registry, {
      enabled: true,
      policyFor: policyFactory(),
    });

    expect(result.bypassed).toEqual([
      { id: "broken", reason: "provider object unavailable" },
      { id: "openrouter", reason: "registration failed: registry busy" },
    ]);
    const bypassLines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("model-state policy bypassed for:"));
    expect(bypassLines).toHaveLength(1);
    expect(bypassLines[0]).toContain("broken (provider object unavailable)");
    expect(bypassLines[0]).toContain("openrouter (registration failed: registry busy)");
    expect(bypassLines[0]).not.toContain("llmgateway");
    warn.mockRestore();
  });

  it("names a provider whose object has no id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pi, registry } = fakePi(["llmgateway", "anon"], {
      emptyIdFor: ["anon"],
    });
    const result = registerModelProviderWrappers(pi, registry, {
      enabled: true,
      policyFor: policyFactory(),
    });

    expect(result.bypassed).toEqual([{ id: "anon", reason: "missing provider id" }]);
    warn.mockRestore();
  });

  it("propagates a registry enumeration failure so the session_start handler can report it", () => {
    const { pi, registry } = fakePi(["llmgateway"], { getAllThrows: true });
    expect(() =>
      registerModelProviderWrappers(pi, registry, { enabled: true, policyFor: policyFactory() }),
    ).toThrow("registry iteration failed");
  });

  it("throttles one warning per session with a count and re-warns next session", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    beginProviderRegistrationSession();
    warnProviderRegistrationFailure(new Error("first failure"));
    warnProviderRegistrationFailure(new Error("second failure"));

    expect(warn).toHaveBeenCalledTimes(1);
    const firstWarning = String(warn.mock.calls[0]?.[0]);
    expect(firstWarning).toContain("first failure");
    expect(firstWarning).toContain("failure(s) this session");
    expect(firstWarning).toContain("providers stay direct");

    // A later session_start opens a new window: a different failure is visible.
    beginProviderRegistrationSession();
    warnProviderRegistrationFailure(new Error("later session failure"));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain("later session failure");
    warn.mockRestore();
  });

  it("defers a lazy provider with no object until a later session", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pi, registry } = fakePi(["llmgateway"], {
      registeredOnly: ["lazy-provider"],
      missing: ["lazy-provider"],
    });

    const first = registerModelProviderWrappers(pi, registry, {
      enabled: true,
      policyFor: policyFactory(),
    });
    expect(first.deferred).toEqual(["lazy-provider"]);
    expect(first.bypassed).toEqual([]);
    const firstBypassWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes("model-state policy bypassed for:"),
    );
    expect(firstBypassWarnings).toHaveLength(0);

    const second = registerModelProviderWrappers(pi, registry, {
      enabled: true,
      policyFor: policyFactory(),
    });
    expect(second.deferred).toEqual([]);
    expect(second.bypassed).toEqual([
      { id: "lazy-provider", reason: "provider still unavailable (lazy catalog)" },
    ]);
    const secondBypassWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes("model-state policy bypassed for:"),
    );
    expect(secondBypassWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it("warns once, not every second session, while a lazy provider stays missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pi, registry } = fakePi(["llmgateway"], {
      registeredOnly: ["warn-forever"],
      missing: ["warn-forever"],
    });
    const options = { enabled: true, policyFor: policyFactory() };

    const first = registerModelProviderWrappers(pi, registry, options);
    expect(first.deferred).toEqual(["warn-forever"]);

    // The second sighting is reported, the third is already known (S4).
    const second = registerModelProviderWrappers(pi, registry, options);
    const third = registerModelProviderWrappers(pi, registry, options);
    const stillMissing = {
      id: "warn-forever",
      reason: "provider still unavailable (lazy catalog)",
    };
    expect(second.bypassed).toEqual([stillMissing]);
    expect(third.bypassed).toEqual([stillMissing]);

    const bypassWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes("model-state policy bypassed for:"),
    );
    expect(bypassWarnings).toHaveLength(1);
    expect(String(bypassWarnings[0]?.[0])).toContain("warn-forever");
    warn.mockRestore();
  });

  it("wraps a deferred provider mid-session as soon as its object materialises (W2)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = fakePi(["llmgateway"], {
      registeredOnly: ["late-provider"],
      missing: ["late-provider"],
    });
    const options = { enabled: true, policyFor: policyFactory() };

    expect(registerModelProviderWrappers(fake.pi, fake.registry, options).deferred).toEqual([
      "late-provider",
    ]);
    // Still missing: the per-turn reconcile reads nothing and does nothing.
    expect(reconcileDeferredProviders(fake.pi, fake.registry, options)).toBeNull();

    fake.materialise("late-provider");
    const reconciled = reconcileDeferredProviders(fake.pi, fake.registry, options);
    expect(reconciled).toMatchObject({ wrapped: ["late-provider"], bypassed: [], deferred: [] });
    expect(fake.registered.map((provider) => provider.id)).toContain("late-provider");

    // Materialised: it is no longer remembered as missing, so later turns are
    // cheap no-ops and it is never reported again.
    expect(reconcileDeferredProviders(fake.pi, fake.registry, options)).toBeNull();
    expect(registerModelProviderWrappers(fake.pi, fake.registry, options).bypassed).toEqual([]);
    warn.mockRestore();
  });
});
