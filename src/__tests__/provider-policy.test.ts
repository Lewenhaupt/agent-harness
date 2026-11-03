import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelStateStore } from "../model-state-store.js";
import { DEFAULT_CAPACITY_LEASE_TTL_MS, openModelStateStore } from "../model-state-store.js";
import {
  CAPACITY_LIMIT_ENV,
  createLeaseTtlResolver,
  createProviderPolicy,
  DEFAULT_CAPACITY_LIMIT,
  decideDispatch,
  LEASE_RENEWAL_INTERVAL_FLOOR_MS,
  LEASE_TTL_ENV,
  LEASE_TTL_FLOOR_MS,
  MAX_ATTEMPTS_PER_DISPATCH,
  RECOMMENDED_RETRY_MAX_RETRIES,
  recordFailure,
  resolveCapacityLimit,
  resolveLeaseTtlMs,
  TRANSIENT_RETRY_BUDGET,
} from "../provider-policy.js";
import type { FailureClassification } from "../quota-failure.js";
import { classifyAssistantMessage } from "../quota-failure.js";

const sqliteProbe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
});
const describeSqlite = sqliteProbe.status === 0 ? describe : describe.skip;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openStore(): { store: ModelStateStore; fakeNow: { value: number } } {
  const dir = mkdtempSync(join(tmpdir(), "belayd-provider-policy-"));
  tempDirs.push(dir);
  const fakeNow = { value: 0 };
  const opened = openModelStateStore({
    path: join(dir, "model-state.sqlite"),
    now: () => fakeNow.value,
  });
  if (!opened.ok) throw new Error(opened.error);
  return { store: opened.store, fakeNow };
}

function classificationOf(message: Record<string, unknown>): FailureClassification {
  const classification = classifyAssistantMessage(message);
  if (classification === undefined) throw new Error("expected an assistant error classification");
  return classification;
}

describe("retry budget", () => {
  it("recommends pi-durable retry.maxRetries = 1 so attempts do not multiply", () => {
    expect(RECOMMENDED_RETRY_MAX_RETRIES).toBe(1);
    expect(TRANSIENT_RETRY_BUDGET).toBe(1);
    expect(MAX_ATTEMPTS_PER_DISPATCH).toBe(1 + TRANSIENT_RETRY_BUDGET);
  });

  it("parses the capacity limit from the environment", () => {
    expect(resolveCapacityLimit({})).toBe(DEFAULT_CAPACITY_LIMIT);
    expect(resolveCapacityLimit({ [CAPACITY_LIMIT_ENV]: "3" })).toBe(3);
    expect(resolveCapacityLimit({ [CAPACITY_LIMIT_ENV]: "0" })).toBe(0);
    expect(resolveCapacityLimit({ [CAPACITY_LIMIT_ENV]: "nonsense" })).toBe(DEFAULT_CAPACITY_LIMIT);
    expect(resolveCapacityLimit({ [CAPACITY_LIMIT_ENV]: "-2" })).toBe(DEFAULT_CAPACITY_LIMIT);
  });
});

describeSqlite("provider policy (bd-187)", () => {
  it("allows dispatch when nothing is cooling down", () => {
    const { store } = openStore();
    expect(
      decideDispatch({
        store,
        provider: "llmgateway",
        model: "mimo-v2.6-flash",
        nowMs: 0,
      }),
    ).toEqual({ allowed: true });
    store.close();
  });

  it("denies every model on a provider-wide quota cooldown", () => {
    const { store } = openStore();
    const quota = classificationOf({
      role: "assistant",
      stopReason: "error",
      errorStatus: 429,
      errorMessage: "429: Weekly usage limit reached. Resets in 7hr 57min.",
    });
    expect(quota).toMatchObject({ kind: "quota", cooldownHinted: true });

    const marked = recordFailure({
      store,
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      classification: quota,
      nowMs: 0,
    });
    expect(marked).toMatchObject({ ok: true, value: { retryAfterMs: 28_620_000 } });

    const sameModel = decideDispatch({
      store,
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      nowMs: 1_000,
    });
    expect(sameModel).toMatchObject({
      allowed: false,
      scope: "provider",
      untilMs: 28_620_000,
    });

    const siblingModel = decideDispatch({
      store,
      provider: "llmgateway",
      model: "deepseek-v4.1-flash",
      nowMs: 1_000,
    });
    expect(siblingModel).toMatchObject({ allowed: false, scope: "provider" });

    const otherProvider = decideDispatch({
      store,
      provider: "openrouter",
      model: "mimo-v2.6-flash",
      nowMs: 1_000,
    });
    expect(otherProvider).toEqual({ allowed: true });

    store.close();
  });

  it("denies only the cooled endpoint on a model-scoped failure", () => {
    const { store } = openStore();
    const transient = classificationOf({
      role: "assistant",
      stopReason: "error",
      errorStatus: 503,
      errorMessage: "503: service unavailable",
    });
    expect(transient).toMatchObject({ kind: "transient" });

    recordFailure({
      store,
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      classification: transient,
      nowMs: 0,
    });

    expect(
      decideDispatch({
        store,
        provider: "llmgateway",
        model: "mimo-v2.6-flash",
        nowMs: 1_000,
      }),
    ).toMatchObject({ allowed: false, scope: "model", untilMs: 300_000 });
    expect(
      decideDispatch({
        store,
        provider: "llmgateway",
        model: "deepseek-v4.1-flash",
        nowMs: 1_000,
      }),
    ).toEqual({ allowed: true });

    store.close();
  });

  it("writes retry_after_ms from a hinted reset", () => {
    const { store } = openStore();
    const hinted = classificationOf({
      role: "assistant",
      stopReason: "error",
      errorStatus: 429,
      errorMessage: "429: Weekly usage limit reached. Resets in 7hr 57min.",
    });
    recordFailure({
      store,
      provider: "opencode-go",
      model: "mimo-v2.6-flash",
      classification: hinted,
      nowMs: 0,
    });

    const read = store.cooldownFor({ provider: "opencode-go", model: "anything", nowMs: 1_000 });
    expect(read).toMatchObject({
      ok: true,
      value: { scope: "provider", retryAfterMs: 28_620_000, untilMs: 28_620_000 },
    });
    store.close();
  });

  it("doubles an unhinted provider window and caps it at 24h", () => {
    const { store } = openStore();
    const unhinted = classificationOf({
      role: "assistant",
      stopReason: "error",
      errorStatus: 429,
      errorMessage: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}',
    });
    expect(unhinted).toMatchObject({ kind: "quota", cooldownHinted: false });

    const windows: (number | undefined)[] = [];
    for (const nowMs of [0, 1, 2, 3]) {
      const marked = recordFailure({
        store,
        provider: "opencode-go",
        model: "mimo-v2.6-flash",
        classification: unhinted,
        nowMs,
      });
      windows.push(marked.ok ? marked.value?.retryAfterMs : undefined);
    }

    const sixHours = 6 * 60 * 60 * 1_000;
    expect(windows).toEqual([sixHours, sixHours * 2, sixHours * 4, sixHours * 4]);

    store.close();
  });

  it("resets the ladder when a hinted reset arrives", () => {
    const { store } = openStore();
    const unhinted = classificationOf({
      role: "assistant",
      stopReason: "error",
      errorStatus: 429,
      errorMessage: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}',
    });
    const hinted = classificationOf({
      role: "assistant",
      stopReason: "error",
      errorStatus: 429,
      errorMessage: "429: Weekly usage limit reached. Resets in 7hr 57min.",
    });

    const first = recordFailure({
      store,
      provider: "opencode-go",
      model: "m",
      classification: unhinted,
      nowMs: 0,
    });
    expect(first).toMatchObject({ ok: true, value: { retryAfterMs: 21_600_000 } });

    recordFailure({
      store,
      provider: "opencode-go",
      model: "m",
      classification: hinted,
      nowMs: 1,
    });

    // The hint is authoritative and clears the ladder: the next guess starts
    // from its own base window rather than doubling the hint.
    const afterHint = recordFailure({
      store,
      provider: "opencode-go",
      model: "m",
      classification: unhinted,
      nowMs: 2,
    });
    expect(afterHint).toMatchObject({ ok: true, value: { retryAfterMs: 21_600_000 } });

    store.close();
  });

  it("ignores non-retryable classifications", () => {
    const { store } = openStore();
    const auth = classificationOf({
      role: "assistant",
      stopReason: "error",
      errorStatus: 401,
      errorMessage: "401: invalid api key",
    });
    const marked = recordFailure({
      store,
      provider: "llmgateway",
      model: "m",
      classification: auth,
      nowMs: 0,
    });
    expect(marked).toEqual({ ok: true, value: null });
    expect(store.cooldownFor({ provider: "llmgateway", model: "m", nowMs: 1 })).toEqual({
      ok: true,
      value: null,
    });
    store.close();
  });

  it("degrades to permissive when the store is unavailable", () => {
    const policy = createProviderPolicy({ store: () => null });
    expect(policy.decideDispatch({ provider: "p", model: "m", nowMs: 0 })).toEqual({
      allowed: true,
      degraded: true,
    });
  });
});

describeSqlite("provider policy capacity (bd-187 review)", () => {
  function capacityPolicy(store: ModelStateStore, limit = 1) {
    return createProviderPolicy({
      store: () => store,
      now: () => 0,
      capacity: { limit, classOf: () => "standard", leaseId: () => "policy-lease" },
    });
  }

  it("reserves, renews and releases capacity through the policy", () => {
    const { store } = openStore();
    const policy = capacityPolicy(store);

    const acquired = policy.acquireLease({ provider: "llmgateway", model: "mimo-v2.6-flash" });
    expect(acquired).toMatchObject({
      allowed: true,
      lease: { leaseId: "policy-lease", provider: "llmgateway", class: "standard" },
    });
    if (!acquired.allowed || acquired.lease === null) return;
    expect(policy.renewLease({ lease: acquired.lease, nowMs: 1_000 })).toMatchObject({
      ok: true,
      value: { leaseId: "policy-lease", expiresMs: 601_000 },
    });
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 1, limit: 1 } });

    policy.releaseLease({ lease: acquired.lease });
    expect(
      store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 0, limit: 1 } });

    store.close();
  });

  it("uses TTL/3 as the renewal cadence and disables it without capacity", () => {
    const { store } = openStore();
    const withCapacity = createProviderPolicy({
      store: () => store,
      capacity: { limit: 1, leaseTtlMs: 30_000, leaseId: () => "lease" },
    });
    expect(withCapacity.leaseRenewalIntervalInMs()).toBe(10_000);

    const withoutCapacity = createProviderPolicy({ store: () => store });
    expect(withoutCapacity.leaseRenewalIntervalInMs()).toBe(0);
    store.close();
  });

  it("floors the renewal interval independently of the TTL", () => {
    const { store } = openStore();
    // A programmatic sub-floor TTL is clamped too, so the heartbeat cannot
    // become a `BEGIN IMMEDIATE` storm (W1 review).
    const policy = createProviderPolicy({
      store: () => store,
      capacity: { limit: 1, leaseTtlMs: 1_000, leaseId: () => "lease" },
    });
    expect(policy.leaseRenewalIntervalInMs()).toBe(
      Math.max(LEASE_RENEWAL_INTERVAL_FLOOR_MS, Math.floor(LEASE_TTL_FLOOR_MS / 3)),
    );
    expect(policy.leaseRenewalIntervalInMs()).toBeGreaterThanOrEqual(
      LEASE_RENEWAL_INTERVAL_FLOOR_MS,
    );

    // `limit: 0` still disables the heartbeat/capacity path entirely.
    const disabled = createProviderPolicy({
      store: () => store,
      capacity: { limit: 0, leaseTtlMs: 30_000, leaseId: () => "lease" },
    });
    expect(disabled.leaseRenewalIntervalInMs()).toBe(0);
    store.close();
  });

  it("parses the lease TTL from the environment", () => {
    expect(resolveLeaseTtlMs({})).toBe(DEFAULT_CAPACITY_LEASE_TTL_MS);
    expect(resolveLeaseTtlMs({ [LEASE_TTL_ENV]: "45000" })).toBe(45_000);
    expect(resolveLeaseTtlMs({ [LEASE_TTL_ENV]: "0" })).toBe(DEFAULT_CAPACITY_LEASE_TTL_MS);
    expect(resolveLeaseTtlMs({ [LEASE_TTL_ENV]: "nonsense" })).toBe(DEFAULT_CAPACITY_LEASE_TTL_MS);
    // A positive sub-floor value is clamped, never accepted.
    expect(resolveLeaseTtlMs({ [LEASE_TTL_ENV]: "1000" })).toBe(LEASE_TTL_FLOOR_MS);
  });

  it("warns once about a sub-floor lease TTL, naming the env var and the floor", () => {
    const warnings: string[] = [];
    const resolve = createLeaseTtlResolver((message) => warnings.push(message));

    expect(resolve({ [LEASE_TTL_ENV]: "1000" })).toBe(LEASE_TTL_FLOOR_MS);
    // A second policy build for the same misconfiguration stays silent: the
    // clamp is reported, not repeated per wrapped provider.
    expect(resolve({ [LEASE_TTL_ENV]: "1000" })).toBe(LEASE_TTL_FLOOR_MS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(LEASE_TTL_ENV);
    expect(warnings[0]).toContain(`${LEASE_TTL_FLOOR_MS}ms`);

    // A normal value is unchanged and never warns.
    const another = createLeaseTtlResolver((message) => warnings.push(message));
    expect(another({ [LEASE_TTL_ENV]: "120000" })).toBe(120_000);
    expect(warnings).toHaveLength(1);
  });

  it("returns a typed capacity denial carrying provider, class and wait hint", () => {
    const { store } = openStore();
    store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "held",
      nowMs: 0,
    });
    const policy = capacityPolicy(store);

    const denied = policy.acquireLease({ provider: "llmgateway", model: "mimo-v2.6-flash" });
    expect(denied).toMatchObject({
      allowed: false,
      scope: "capacity",
      capacity: {
        provider: "llmgateway",
        class: "standard",
        inUse: 1,
        limit: 1,
        waitHintMs: 600_000,
      },
    });
    store.close();
  });

  it("degrades to no lease when the store is read-only", () => {
    const { store, fakeNow } = openStore();
    const path = store.path;
    store.close();
    fakeNow.value = 0;
    const opened = openModelStateStore({ path, readOnly: true, now: () => fakeNow.value });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const readOnly = opened.store;

    const policy = capacityPolicy(readOnly);
    expect(policy.acquireLease({ provider: "llmgateway", model: "mimo-v2.6-flash" })).toEqual({
      allowed: true,
      lease: null,
    });
    readOnly.close();
  });

  it("does not consult capacity in decideDispatch (the reservation is authoritative)", () => {
    const { store } = openStore();
    store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "held",
      nowMs: 0,
    });

    // W2/S2: the pre-read was removed, so a full bucket is refused by
    // acquireLease, not by the cooldown decision.
    expect(
      decideDispatch({
        store,
        provider: "llmgateway",
        model: "mimo-v2.6-flash",
        nowMs: 0,
      }),
    ).toEqual({ allowed: true });
    expect(
      capacityPolicy(store).acquireLease({ provider: "llmgateway", model: "mimo-v2.6-flash" }),
    ).toMatchObject({
      allowed: false,
      scope: "capacity",
      capacity: { provider: "llmgateway", class: "standard", inUse: 1, limit: 1 },
    });
    store.close();
  });
});
