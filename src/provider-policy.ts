/**
 * Provider policy (bd-187): the decision layer between the pi-ai provider
 * wrapper and the shared {@link ModelStateStore}.
 *
 * Classification is NOT re-implemented here: `quota-failure.ts` owns the
 * status/wording rules and `resolveQuotaCooldown` owns the hint resolution, and
 * the routing half of that module stays where it is until the follow-up
 * deletion bead lands. This module only turns a `FailureClassification` into a
 * store write and answers "may this provider/model dispatch now?".
 *
 * Capacity: a dispatch takes a lease for the duration of its stream and releases
 * it on settle (success, terminal error, or thrown stream). A live stream renews
 * the lease on a heartbeat at a third of its TTL, so a turn longer than the TTL
 * keeps its slot while a SIGKILLed daemon still frees its slot by expiry. The
 * lease is the cross-process concurrency control; a refusal is a typed denial,
 * while a bookkeeping failure (read-only or unopenable store) degrades to
 * dispatching without a lease.
 *
 * Retry: the wrapper itself adds NO retry for a quota-class failure — it
 * classifies, records the cooldown and surfaces the failure — and at most
 * {@link TRANSIENT_RETRY_BUDGET} extra attempt for a transient synchronous
 * dispatch throw. pi's own retry layer (`settings.retry.maxRetries`, default 3)
 * is a second, unenforced multiplier outside this repo; it must be set to
 * {@link RECOMMENDED_RETRY_MAX_RETRIES} while the wrapper is installed, or total
 * upstream calls multiply beyond this module's control. This repo does not write
 * `~/.pi/agent/settings.json` — nothing here owns that file.
 */

import { randomUUID } from "node:crypto";

import { modelClassOf } from "./model-classes.js";
import type {
  CooldownRecord,
  LeaseRenewal,
  ModelStateResult,
  ModelStateStore,
} from "./model-state-store.js";
import { DEFAULT_CAPACITY_LEASE_TTL_MS } from "./model-state-store.js";
import type { FailureClassification, FailureKind } from "./quota-failure.js";

/**
 * pi-durable must set `settings.retry.maxRetries` to this while the wrapper is
 * active. pi's retry layer is a second, unenforced multiplier: this repo can
 * document the setting but does not own the file that holds it.
 */
export const RECOMMENDED_RETRY_MAX_RETRIES = 1;

/**
 * Extra attempts the wrapper may spend on a transient synchronous dispatch
 * throw. A quota-class failure gets none: retrying an exhausted bucket is the
 * 429 storm this exists to stop.
 */
export const TRANSIENT_RETRY_BUDGET = 1;

/**
 * Hard ceiling on real provider calls for ONE caller attempt: the first try plus
 * the transient budget. The wrapper never exceeds it, whatever the caller does;
 * total calls are the caller's attempt count times this ceiling at most.
 */
export const MAX_ATTEMPTS_PER_DISPATCH = 1 + TRANSIENT_RETRY_BUDGET;

/**
 * Default concurrent leases per provider+class when the extension wires capacity.
 * Generous enough for a normal phase fan-out; a fleet that needs more sets
 * {@link CAPACITY_LIMIT_ENV}.
 */
export const DEFAULT_CAPACITY_LIMIT = 8;

/** Env override for {@link DEFAULT_CAPACITY_LIMIT}; `0` disables capacity. */
export const CAPACITY_LIMIT_ENV = "BELAYD_MODEL_CAPACITY_LIMIT";

/**
 * Env override for the lease TTL. The default (10 minutes) is a *renewal* TTL,
 * not a stream limit: a live stream renews every TTL/3, so this only bounds how
 * long a killed daemon's slot stays held.
 */
export const LEASE_TTL_ENV = "BELAYD_MODEL_LEASE_TTL_MS";

/**
 * Floor for a lease TTL, in ms. The heartbeat cadence is derived from the TTL, so
 * a tiny configured TTL turns every live stream into a `BEGIN IMMEDIATE`
 * renewal storm that contends with cooldown/spend writers across every wrapped
 * runtime under the store's 5 s busy timeout — a misconfiguration that can wedge
 * dispatch. A sub-floor value is refused (reported once) instead of accepted.
 */
export const LEASE_TTL_FLOOR_MS = 10_000;

/**
 * Floor for the derived heartbeat interval, in ms. It is applied independently of
 * {@link LEASE_TTL_FLOOR_MS} so the two values can never combine into a poll
 * storm even if the TTL is lowered elsewhere.
 */
export const LEASE_RENEWAL_INTERVAL_FLOOR_MS = 1_000;

/** Parse the capacity limit from an injected environment (pure). */
export function resolveCapacityLimit(env: Record<string, string | undefined>): number {
  const raw = env[CAPACITY_LIMIT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CAPACITY_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CAPACITY_LIMIT;
  return parsed;
}

/**
 * Parse the lease TTL from an injected environment (pure).
 *
 * A zero/negative/unparseable value falls back to the default (it would make
 * every lease instantly expired); a positive value below
 * {@link LEASE_TTL_FLOOR_MS} is clamped to the floor and reported through
 * `onClamped`, so the caller can warn once instead of silently accepting a
 * poll-storm setting.
 */
export function resolveLeaseTtlMs(
  env: Record<string, string | undefined>,
  options: { onClamped?: (input: { configuredMs: number; floorMs: number }) => void } = {},
): number {
  const raw = env[LEASE_TTL_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CAPACITY_LEASE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  // A zero/negative TTL would make every lease instantly expired.
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CAPACITY_LEASE_TTL_MS;
  if (parsed < LEASE_TTL_FLOOR_MS) {
    options.onClamped?.({ configuredMs: parsed, floorMs: LEASE_TTL_FLOOR_MS });
    return LEASE_TTL_FLOOR_MS;
  }
  return parsed;
}

/**
 * A TTL resolver that clamps a sub-floor value AND reports it exactly once.
 *
 * The production path builds one policy per wrapped provider, so a per-policy
 * warning would be noise; the clamp must still never be silent, because the
 * operator needs to know which setting was ignored.
 */
export function createLeaseTtlResolver(
  warn: (message: string) => void = (message) => console.warn(message),
): (env: Record<string, string | undefined>) => number {
  let warned = false;
  return (env) =>
    resolveLeaseTtlMs(env, {
      onClamped: ({ configuredMs, floorMs }) => {
        if (warned) return;
        warned = true;
        warn(
          `[belayd-harness] ${LEASE_TTL_ENV}=${configuredMs}ms is below the ${floorMs}ms floor; using ${floorMs}ms so the lease heartbeat cannot become a renewal storm.`,
        );
      },
    });
}

/** Resolve a store lazily so building a policy does not open a file. */
export type ModelStateStoreProvider = () => ModelStateStore | null;

export interface DispatchDecisionAllowed {
  allowed: true;
  /** True when the store could not be read, so the decision was permissive. */
  degraded?: boolean;
}

export interface DispatchDecisionDenied {
  allowed: false;
  reason: string;
  scope: "provider" | "model" | "capacity";
  /** Present for cooldown denials. */
  untilMs?: number;
  /** Present for capacity denials. */
  capacity?: CapacityDenialDetails;
}

export type DispatchDecision = DispatchDecisionAllowed | DispatchDecisionDenied;

/** Capacity bucket used for one dispatch, named on a capacity denial. */
export interface CapacityDenialDetails {
  provider: string;
  class: string;
  inUse: number;
  limit: number;
  /** How long until the oldest lease can expire and free a slot. */
  waitHintMs: number;
}

/** A lease held for the lifetime of one dispatch. */
export interface CapacityLease {
  leaseId: string;
  provider: string;
  class: string;
}

/** Capacity acquisition: allowed with or without a lease, or a typed denial. */
export type CapacityAcquisition =
  | { allowed: true; lease: CapacityLease | null }
  | DispatchDecisionDenied;

/** Capacity wiring for a policy; `limit <= 0` disables it. */
export interface CapacityConfig {
  limit: number;
  /** Model class (capacity bucket) for a model id. */
  classOf?: (model: string) => string;
  /** Lease lifetime; the store default applies when omitted. */
  leaseTtlMs?: number;
  /** Lease-id seam (tests); defaults to a random UUID. */
  leaseId?: () => string;
}

/** Normalized provider-reported usage; `cost` accepts a number or `{ total }`. */
export interface ProviderUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number | { total?: number };
}

export interface ProviderPolicy {
  decideDispatch(input: { provider: string; model: string; nowMs?: number }): DispatchDecision;
  recordFailure(input: {
    provider: string;
    model: string;
    classification: FailureClassification;
    nowMs?: number;
  }): void;
  recordSpend(input: {
    provider: string;
    model: string;
    phase: string;
    taskId: string;
    usage: ProviderUsageLike;
    nowMs?: number;
  }): void;
  /** Reserve a capacity slot for one dispatch (no-op when capacity is off). */
  acquireLease(input: { provider: string; model: string; nowMs?: number }): CapacityAcquisition;
  /** Release a lease exactly once; `null` is a no-op. */
  releaseLease(input: { lease: CapacityLease | null; nowMs?: number }): void;
  /** Extend a live lease; an expired lease is reported, never resurrected. */
  renewLease(input: { lease: CapacityLease | null; nowMs?: number }): LeaseRenewal;
  /** Heartbeat interval for a live lease (0 when capacity is disabled). */
  leaseRenewalIntervalInMs(): number;
}

/**
 * Provider-wide failures exhaust a whole credential; everything else is
 * endpoint-specific. The spawn loop holds the same rule privately
 * (`isProviderScopedFailure`) and must not be rewired by this bead, so the two
 * stay in sync by rule rather than by import until the follow-up deletion.
 */
function isProviderScopedFailure(kind: FailureKind): boolean {
  return kind === "quota" || kind === "unconfigured";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function costOrZero(cost: ProviderUsageLike["cost"]): number {
  if (typeof cost === "number") return numberOrZero(cost);
  if (typeof cost === "object" && cost !== null) return numberOrZero(cost.total);
  return 0;
}

/**
 * Consult the cooldown for one dispatch.
 *
 * Capacity is deliberately NOT read here: `acquireLease` performs the
 * authoritative `BEGIN IMMEDIATE` check, and a pre-read could only race it and
 * flip a real refusal into a permissive dispatch. A store read failure degrades
 * to `allowed` on purpose: the state store must never be able to turn into a
 * provider error (the read-only acceptance case).
 */
export function decideDispatch(options: {
  store: ModelStateStore | null;
  provider: string;
  model: string;
  nowMs: number;
}): DispatchDecision {
  const store = options.store;
  if (store === null) return { allowed: true, degraded: true };

  const cooldown = store.cooldownFor({
    provider: options.provider,
    model: options.model,
    nowMs: options.nowMs,
  });
  if (!cooldown.ok) return { allowed: true, degraded: true };
  if (cooldown.value !== null) {
    return {
      allowed: false,
      scope: cooldown.value.scope,
      reason: cooldown.value.reason,
      untilMs: cooldown.value.untilMs,
    };
  }

  return { allowed: true };
}

/**
 * Write the cooldown row a classification deserves, or nothing when the kind is
 * not retryable elsewhere (`auth`, `other`, `success`).
 *
 * Provider-scoped marks carry the provider; model-scoped marks carry the
 * endpoint. The store's mark path owns the unhinted escalation ladder, so the
 * bd-38 repeat-doubling survives the move off the JSON file.
 */
export function recordFailure(options: {
  store: ModelStateStore | null;
  provider: string;
  model: string;
  classification: FailureClassification;
  nowMs: number;
}): ModelStateResult<CooldownRecord | null> {
  const store = options.store;
  if (store === null) return { ok: true, value: null };
  const { classification } = options;
  // A local capacity refusal spent nothing upstream; writing a cooldown would
  // punish a provider that never received the request.
  if (classification.kind === "capacity") return { ok: true, value: null };
  if (classification.cooldownSeconds === undefined) return { ok: true, value: null };

  const providerScoped = isProviderScopedFailure(classification.kind) && options.provider !== "";
  const durationMs = Math.round(classification.cooldownSeconds * 1_000);
  const reason = classification.reason ?? classification.kind;
  return store.markCooldown({
    provider: options.provider,
    model: providerScoped ? undefined : options.model,
    durationMs,
    reason,
    hinted: classification.cooldownHinted === true,
    nowMs: options.nowMs,
  });
}

/** One `spend` row from provider-reported usage. */
export function recordSpend(options: {
  store: ModelStateStore | null;
  provider: string;
  model: string;
  phase: string;
  taskId: string;
  usage: ProviderUsageLike;
  nowMs: number;
}): ModelStateResult<null> {
  const store = options.store;
  if (store === null) return { ok: true, value: null };
  return store.recordSpend({
    ts: options.nowMs,
    provider: options.provider,
    model: options.model,
    phase: options.phase,
    taskId: options.taskId,
    input: numberOrZero(options.usage.input),
    output: numberOrZero(options.usage.output),
    cacheRead: numberOrZero(options.usage.cacheRead),
    cacheWrite: numberOrZero(options.usage.cacheWrite),
    cost: costOrZero(options.usage.cost),
  });
}

/**
 * Wrap the free functions with one lazily resolved store, so a wrapper can be
 * built during extension load without touching the filesystem. The store opens
 * on the first dispatch decision, never at import time.
 */
export function createProviderPolicy(options: {
  store: ModelStateStoreProvider;
  capacity?: CapacityConfig;
  now?: () => number;
}): ProviderPolicy {
  const now = options.now ?? Date.now;
  const capacity = options.capacity;
  const classOf = capacity?.classOf ?? ((model: string) => modelClassOf(model) ?? "unknown");
  const nextLeaseId = capacity?.leaseId ?? (() => randomUUID());
  // Programmatic TTLs are clamped too: the heartbeat cadence is derived from the
  // TTL, so a sub-floor value would still produce a renewal storm.
  const leaseTtlMs = Math.max(
    LEASE_TTL_FLOOR_MS,
    Math.round(capacity?.leaseTtlMs ?? DEFAULT_CAPACITY_LEASE_TTL_MS),
  );
  const capacityEnabled = capacity !== undefined && capacity.limit > 0;
  return {
    decideDispatch(input) {
      return decideDispatch({
        store: options.store(),
        provider: input.provider,
        model: input.model,
        nowMs: input.nowMs ?? now(),
      });
    },
    recordFailure(input) {
      recordFailure({
        store: options.store(),
        provider: input.provider,
        model: input.model,
        classification: input.classification,
        nowMs: input.nowMs ?? now(),
      });
    },
    recordSpend(input) {
      recordSpend({
        store: options.store(),
        provider: input.provider,
        model: input.model,
        phase: input.phase,
        taskId: input.taskId,
        usage: input.usage,
        nowMs: input.nowMs ?? now(),
      });
    },
    acquireLease(input) {
      const store = options.store();
      if (
        capacity === undefined ||
        capacity.limit <= 0 ||
        store === null ||
        // A read-only store cannot hold a lease; refusing to dispatch because we
        // could not write bookkeeping would break the read-only acceptance case.
        store.readOnly
      ) {
        return { allowed: true, lease: null };
      }
      const modelClass = classOf(input.model);
      const atMs = input.nowMs ?? now();
      const reserved = store.reserveCapacity({
        provider: input.provider,
        class: modelClass,
        limit: capacity.limit,
        leaseId: nextLeaseId(),
        ttlMs: leaseTtlMs,
        nowMs: atMs,
      });
      // A failed reservation is bookkeeping, not a dispatch decision.
      if (!reserved.ok) return { allowed: true, lease: null };
      if (!reserved.value.granted) {
        return {
          allowed: false,
          scope: "capacity",
          reason: `capacity in use (${reserved.value.inUse}/${reserved.value.limit}) on ${input.provider}/${modelClass}`,
          capacity: {
            provider: input.provider,
            class: modelClass,
            inUse: reserved.value.inUse,
            limit: reserved.value.limit,
            waitHintMs: leaseTtlMs,
          },
        };
      }
      return {
        allowed: true,
        lease: {
          leaseId: reserved.value.leaseId,
          provider: input.provider,
          class: modelClass,
        },
      };
    },
    releaseLease(input) {
      if (input.lease === null) return;
      const store = options.store();
      if (store === null) return;
      // Outcome is deliberately ignored: releasing is cleanup, and an ownership
      // mismatch or read-only failure must not surface as a provider error.
      store.releaseCapacity({
        provider: input.lease.provider,
        class: input.lease.class,
        leaseId: input.lease.leaseId,
        nowMs: input.nowMs ?? now(),
      });
    },
    renewLease(input) {
      if (input.lease === null) {
        return { ok: false, reason: "lease-expired", error: "no lease to renew" };
      }
      const store = options.store();
      if (store === null) {
        return { ok: false, reason: "store-error", error: "model state store unavailable" };
      }
      return store.renewLease({
        leaseId: input.lease.leaseId,
        provider: input.lease.provider,
        class: input.lease.class,
        ttlMs: leaseTtlMs,
        nowMs: input.nowMs ?? now(),
      });
    },
    leaseRenewalIntervalInMs() {
      // Renew well inside the TTL so one late tick cannot let the slot expire,
      // but never faster than the independent interval floor.
      return capacityEnabled
        ? Math.max(LEASE_RENEWAL_INTERVAL_FLOOR_MS, Math.floor(leaseTtlMs / 3))
        : 0;
    },
  };
}
