/**
 * Shared provider wrapper (bd-187).
 *
 * The API key is globally shared, so cooldown/capacity/spend must be enforced at
 * the one place every runtime dispatches through. This wrapper is that place: it
 * spreads the real provider and overrides only `stream`/`streamSimple`, so every
 * other member (catalog, auth, deferred calls, images, classifiers) is forwarded
 * untouched and provisioned by the provider factory.
 *
 * Types are local and structural on purpose. `@earendil-works/pi-ai` is only a
 * transitive dependency of the `pi-coding-agent` peer, and adding it to
 * `package.json` would move `fetchPnpmDeps`'s hash in `flake.nix` (see
 * docs/packaging.md). The two installers cast at the boundary and document it.
 *
 * The id is NEVER changed. pi `model_change` conversation entries and pi-durable
 * `pi.agent` documents store provider ids, so a renamed wrapper orphans stored
 * conversations.
 *
 * Retry budget: a quota-class failure gets NO wrapper retry — the wrapper
 * classifies it, records the cooldown and surfaces it. Only a transient
 * synchronous dispatch throw may spend {@link TRANSIENT_RETRY_BUDGET} extra
 * attempt(s), so one caller attempt costs at most `MAX_ATTEMPTS_PER_DISPATCH`
 * real calls. pi's own `retry.maxRetries` (default 3) is a second, unenforced
 * multiplier outside this repo; it must be {@link RECOMMENDED_RETRY_MAX_RETRIES}
 * or total upstream calls multiply beyond the wrapper's control.
 *
 * Wrapping is idempotent: the guard checks the INPUT object, so a wrapper whose
 * marker was lost to a spread is still recognised when it comes back through a
 * registry, and a wrapper is never wrapped twice (which would attach two
 * terminal observers and double every spend/cooldown write).
 */

import type {
  CapacityLease,
  DispatchDecisionDenied,
  ProviderPolicy,
  ProviderUsageLike,
} from "./provider-policy.js";
import {
  MAX_ATTEMPTS_PER_DISPATCH,
  RECOMMENDED_RETRY_MAX_RETRIES,
  TRANSIENT_RETRY_BUDGET,
} from "./provider-policy.js";
import type { FailureClassification } from "./quota-failure.js";
import { CAPACITY_REFUSAL_MARKER, classifyAssistantMessage } from "./quota-failure.js";

export { MAX_ATTEMPTS_PER_DISPATCH, RECOMMENDED_RETRY_MAX_RETRIES, TRANSIENT_RETRY_BUDGET };

/** The one member of a returned stream the wrapper observes. */
export interface ProviderStreamLike {
  result(): Promise<unknown>;
}

/**
 * Mutable, per-dispatch telemetry attribution (bd-187 review W3). The wrapper
 * snapshots it once per dispatch invocation rather than reading it at terminal
 * time, so a stream that settles after the next run boundary cannot label the
 * previous run's spend with the new phase/task.
 */
export interface DispatchAttribution {
  phase?: string;
  taskId?: string;
}

/** Update a shared attribution holder in place (the wrapper keeps the reference). */
export function setDispatchAttribution(
  holder: DispatchAttribution,
  attribution: DispatchAttribution,
): void {
  holder.phase = attribution.phase;
  holder.taskId = attribution.taskId;
}

type IntervalHandle = ReturnType<typeof setInterval>;

/**
 * Non-enumerable marker set on a wrapper. `wrapProvider` checks it on the INPUT
 * provider: the registry/model collection stores the wrapper object itself, so
 * every later install sees the marked object even though `{ ...real }` would
 * drop a non-enumerable property. That is what makes re-wrapping unreachable.
 */
const PROVIDER_POLICY_WRAPPED = Symbol.for("belayd.providerPolicyWrapper");

/** True when this object is already a policy wrapper. */
export function isPolicyWrapped(provider: unknown): boolean {
  return (
    typeof provider === "object" &&
    provider !== null &&
    (provider as Record<symbol, unknown>)[PROVIDER_POLICY_WRAPPED] === true
  );
}

/**
 * Structural stand-in for pi-ai's `Provider`. `never[]` parameters make a real
 * provider assignable without importing pi-ai; callers cast at the boundary.
 */
export type ProviderStreamFunction = (...args: never[]) => ProviderStreamLike;

export interface ProviderLike {
  readonly id: string;
  stream: ProviderStreamFunction;
  streamSimple: ProviderStreamFunction;
}

/** What pi-durable's `Models` exposes that this module needs. */
export interface ModelsLike {
  getProviders(): readonly ProviderLike[];
  setProvider(provider: ProviderLike): void;
}

export interface ProviderWrapperOptions {
  /** Initial telemetry grouping label when no attribution holder is passed. */
  phase?: string;
  /** Initial task id when no attribution holder is passed. */
  taskId?: string;
  /**
   * Shared mutable attribution. When passed, the wrapper reads it at every
   * dispatch/terminal event and never mutates it; a later install must reuse the
   * same holder so re-wrapping cannot resurrect stale labels.
   */
  attribution?: DispatchAttribution;
  /** Lease heartbeat seam (tests use fake timers). Defaults to `setInterval`. */
  setIntervalFn?: (handler: () => void, intervalInMs: number) => IntervalHandle;
  /** Lease heartbeat cleanup seam. Defaults to `clearInterval`. */
  clearIntervalFn?: (handle: IntervalHandle) => void;
  /** Override the policy's TTL/3 heartbeat (tests, or a different cadence). */
  renewalIntervalInMs?: number;
  /**
   * Attempt cap clamped to `[1, MAX_ATTEMPTS_PER_DISPATCH]`. It can only lower
   * the transient budget, never raise it past the amplification guard.
   */
  maxAttempts?: number;
}

/**
 * A typed refusal for a denied dispatch. Thrown instead of calling the real
 * provider, so a cooled-down or capacity-exhausted provider cannot serve a
 * request and the caller can fall back or report loudly.
 */
export class ProviderPolicyRefusalError extends Error {
  readonly reason: string;
  readonly scope: DispatchDecisionDenied["scope"];
  readonly untilMs: number | undefined;
  readonly capacity: DispatchDecisionDenied["capacity"];

  constructor(decision: DispatchDecisionDenied) {
    // Only a capacity refusal carries the stable marker: pi converts the thrown
    // refusal into an assistant error, and the classifier must see that this was
    // a local capacity decision (fallback-worthy, no cooldown) rather than an
    // unclassified failure. A cooldown refusal is already represented by its row.
    const marker = decision.scope === "capacity" ? `${CAPACITY_REFUSAL_MARKER}: ` : "";
    super(`${marker}model dispatch refused (${decision.scope}): ${decision.reason}`);
    this.name = "ProviderPolicyRefusalError";
    this.reason = decision.reason;
    this.scope = decision.scope;
    this.untilMs = decision.untilMs;
    this.capacity = decision.capacity;
  }
}

/** Model id the policy can key on, or null when the model is unresolvable. */
function modelIdOf(model: unknown): string | null {
  if (typeof model !== "object" || model === null) return null;
  const id = (model as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Freeze the shared holder's labels for one dispatch. A late settle must keep
 * the phase/task the dispatch started with, so the holder is read once here
 * rather than at terminal time.
 */
function attributionSnapshot(holder: DispatchAttribution): Required<DispatchAttribution> {
  return { phase: holder.phase ?? "unknown", taskId: holder.taskId ?? "" };
}

function usageOf(message: unknown): ProviderUsageLike | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  return usage as ProviderUsageLike;
}

/**
 * Classify a synchronous dispatch throw with the same rules as a stream error.
 * A throw with no recognizable signature is `other`: it is recorded but never
 * retried, because retrying an unclassifiable failure is an unbounded guess.
 */
function classifyDispatchThrow(error: unknown): FailureClassification {
  const classified = classifyAssistantMessage({
    role: "assistant",
    stopReason: "error",
    errorMessage: messageOf(error),
  });
  if (classified !== undefined) return classified;
  return { kind: "other", reason: `provider dispatch threw: ${messageOf(error)}` };
}

/** Timing seams for the lease heartbeat, so no timer can leak in tests. */
interface LeaseTiming {
  intervalMs: number;
  setIntervalFn: (handler: () => void, intervalInMs: number) => IntervalHandle;
  clearIntervalFn: (handle: IntervalHandle) => void;
}

interface LeaseGuard {
  release(): void;
}

/**
 * A release closure so a lease is freed exactly once on every settle path, plus
 * a renewal heartbeat for as long as the stream is live. Stopping the heartbeat
 * is part of release: a settled stream must leave no timer behind.
 */
function leaseHandle(
  policy: ProviderPolicy,
  lease: CapacityLease | null,
  timing: LeaseTiming,
): LeaseGuard {
  let released = false;
  let timer: IntervalHandle | undefined;
  if (lease !== null && timing.intervalMs > 0) {
    timer = timing.setIntervalFn(() => {
      // A renewal that fails (expired/not owned) is a value, not an error: the
      // heartbeat simply keeps reporting it until the stream settles.
      policy.renewLease({ lease });
    }, timing.intervalMs);
    // Never keep the process alive just to renew a lease.
    timer.unref?.();
  }
  return {
    release() {
      if (released) return;
      released = true;
      if (timer !== undefined) timing.clearIntervalFn(timer);
      if (lease !== null) policy.releaseLease({ lease });
    },
  };
}

type DispatchStart =
  | { ok: true; lease: LeaseGuard }
  | { ok: false; decision: DispatchDecisionDenied };

/** Cooldown decision then capacity lease, in that order. */
function beginDispatch(
  policy: ProviderPolicy,
  provider: string,
  model: string,
  timing: LeaseTiming,
): DispatchStart {
  const decision = policy.decideDispatch({ provider, model });
  if (!decision.allowed) return { ok: false, decision };
  const acquired = policy.acquireLease({ provider, model });
  if (!acquired.allowed) return { ok: false, decision: acquired };
  return { ok: true, lease: leaseHandle(policy, acquired.lease, timing) };
}

/** Record a synchronous dispatch throw against the resolved model id. */
function recordDispatchThrow(
  policy: ProviderPolicy,
  provider: string,
  model: string,
  error: unknown,
): FailureClassification {
  const classification = classifyDispatchThrow(error);
  policy.recordFailure({ provider, model, classification });
  return classification;
}

/**
 * Wrap one provider. The returned object keeps `real.id` and forwards every
 * non-stream member by reference. An already-wrapped provider is returned
 * unchanged, so both the direct path and the installers are idempotent.
 */
export function wrapProvider(
  real: ProviderLike,
  policy: ProviderPolicy,
  options: ProviderWrapperOptions = {},
): ProviderLike {
  if (isPolicyWrapped(real)) return real;

  const maxAttempts = Math.max(
    1,
    Math.min(options.maxAttempts ?? MAX_ATTEMPTS_PER_DISPATCH, MAX_ATTEMPTS_PER_DISPATCH),
  );
  // Shared mutable attribution: the initial options only seed a holder created
  // here. A caller-supplied holder is authoritative and never overwritten by a
  // later install, which is what keeps re-wrapping from resurrecting stale
  // phase/task labels.
  const attribution: DispatchAttribution = options.attribution ?? {
    phase: options.phase,
    taskId: options.taskId,
  };
  const leaseTiming: LeaseTiming = {
    intervalMs: options.renewalIntervalInMs ?? policy.leaseRenewalIntervalInMs(),
    setIntervalFn: options.setIntervalFn ?? setInterval,
    clearIntervalFn: options.clearIntervalFn ?? clearInterval,
  };
  // One throttled warning per wrapped provider: an unresolvable model id is a
  // caller bug, not a reason to deny or to poison a shared policy key.
  let warnedUnknownModel = false;

  const warnUnknownModel = (): void => {
    if (warnedUnknownModel) return;
    warnedUnknownModel = true;
    console.warn(
      `[belayd-harness] provider ${real.id} dispatched a model without an id; skipping cooldown/spend writes for it.`,
    );
  };

  const observeTerminal = (
    model: string | null,
    message: unknown,
    dispatchAttribution: Required<DispatchAttribution>,
  ): void => {
    if (model === null) {
      warnUnknownModel();
      return;
    }
    const classification = classifyAssistantMessage(message);
    if (classification !== undefined) {
      policy.recordFailure({ provider: real.id, model, classification });
      return;
    }
    const usage = usageOf(message);
    if (usage !== undefined) {
      policy.recordSpend({
        provider: real.id,
        model,
        phase: dispatchAttribution.phase,
        taskId: dispatchAttribution.taskId,
        usage,
      });
    }
  };

  const observeStream = (
    stream: ProviderStreamLike,
    model: string | null,
    lease: { release(): void },
    dispatchAttribution: Required<DispatchAttribution>,
  ): ProviderStreamLike => {
    let result: Promise<unknown>;
    try {
      result = stream.result();
    } catch {
      // The stream cannot be observed; free the slot rather than leaking it
      // until expiry, and let the caller see the provider's own behavior.
      lease.release();
      return stream;
    }
    // Attached before the caller awaits, so state writes and the release happen
    // before the caller's continuation. The rejection arm still releases and
    // returns undefined: the caller keeps the original rejection.
    result.then(
      (message) => {
        // Free the capacity slot before any bookkeeping write; a state write must
        // never be able to keep the slot held until expiry.
        lease.release();
        observeTerminal(model, message, dispatchAttribution);
      },
      () => {
        lease.release();
      },
    );
    return stream;
  };

  type AttemptOutcome =
    | { kind: "stream"; stream: ProviderStreamLike }
    | { kind: "refusal"; decision: DispatchDecisionDenied }
    | { kind: "retry"; error: unknown }
    | { kind: "failure"; error: unknown };

  const attempt = (input: {
    call: (model: unknown, context: unknown, streamOptions?: unknown) => ProviderStreamLike;
    model: unknown;
    context: unknown;
    streamOptions?: unknown;
    modelId: string | null;
    policyModel: string;
    dispatchAttribution: Required<DispatchAttribution>;
  }): AttemptOutcome => {
    // An unresolvable model id cannot be keyed in the policy. Dispatch
    // permissively rather than inventing an "unknown" bucket: a bucket the real
    // model never clears would keep it healthy on the next dispatch (and could
    // hold cooldown/capacity against it).
    const started =
      input.modelId === null
        ? { ok: true as const, lease: leaseHandle(policy, null, leaseTiming) }
        : beginDispatch(policy, real.id, input.policyModel, leaseTiming);
    if (!started.ok) return { kind: "refusal", decision: started.decision };
    try {
      const stream = input.call.call(real, input.model, input.context, input.streamOptions);
      return {
        kind: "stream",
        stream: observeStream(stream, input.modelId, started.lease, input.dispatchAttribution),
      };
    } catch (error) {
      started.lease.release();
      if (input.modelId === null) {
        warnUnknownModel();
        return { kind: "failure", error };
      }
      const classification = recordDispatchThrow(policy, real.id, input.modelId, error);
      // A quota failure is never retried; only a transient transport throw may
      // spend the remaining budget, and never past the cap.
      return classification.kind === "transient"
        ? { kind: "retry", error }
        : { kind: "failure", error };
    }
  };

  const runAttempts = (input: {
    call: (model: unknown, context: unknown, streamOptions?: unknown) => ProviderStreamLike;
    model: unknown;
    context: unknown;
    streamOptions?: unknown;
  }): ProviderStreamLike => {
    const modelId = modelIdOf(input.model);
    const policyModel = modelId ?? "";
    // One snapshot per dispatch invocation: a late settle racing the next run
    // boundary must still record this run's phase/task, and the holder stays the
    // way future dispatches are repointed.
    const dispatchAttribution = attributionSnapshot(attribution);
    let lastError: unknown;
    for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex += 1) {
      const outcome = attempt({
        call: input.call,
        model: input.model,
        context: input.context,
        streamOptions: input.streamOptions,
        modelId,
        policyModel,
        dispatchAttribution,
      });
      if (outcome.kind === "stream") return outcome.stream;
      if (outcome.kind === "refusal") {
        // A retry denied by the cooldown written from the previous attempt must
        // not mask the provider's original failure.
        throw lastError ?? new ProviderPolicyRefusalError(outcome.decision);
      }
      lastError = outcome.error;
      if (outcome.kind === "failure") throw outcome.error;
    }
    throw lastError ?? new Error(`provider ${real.id} yielded no stream`);
  };

  const invoke = (select: ProviderStreamFunction) => {
    const call = select as (
      model: unknown,
      context: unknown,
      streamOptions?: unknown,
    ) => ProviderStreamLike;
    return (model: unknown, context: unknown, streamOptions?: unknown): ProviderStreamLike =>
      runAttempts({ call, model, context, streamOptions });
  };

  const wrapped: ProviderLike = {
    ...real,
    stream: invoke(real.stream),
    streamSimple: invoke(real.streamSimple),
  };
  Object.defineProperty(wrapped, PROVIDER_POLICY_WRAPPED, { value: true });
  return wrapped;
}

export interface WrapProviderCollectionResult {
  wrapped: string[];
  direct: string[];
  /** Providers whose `install` threw; reported, never silently dropped. */
  failed: { id: string; error: string }[];
}

/**
 * Install the wrapper over a provider collection: wrap every provider except one
 * direct provider, which stays registered unwrapped so a broken wrapper (or an
 * unreadable state store) is never a single point of failure.
 *
 * Idempotent: an already-wrapped provider is counted as wrapped and not
 * re-installed. An install failure is returned in `failed` instead of aborting
 * the remaining providers.
 *
 * `providers[0]` is the documented direct fallback when the preferred id is not
 * present. With `enabled: false` every provider stays direct (kill switch).
 */
export function wrapProviderCollection(input: {
  providers: readonly ProviderLike[];
  policyFor: (provider: ProviderLike) => ProviderPolicy;
  install: (provider: ProviderLike) => void;
  directProviderId?: string;
  enabled?: boolean;
  wrapperOptions?: ProviderWrapperOptions;
}): WrapProviderCollectionResult {
  if (input.enabled === false || input.providers.length === 0) {
    return { wrapped: [], direct: input.providers.map((provider) => provider.id), failed: [] };
  }
  const directIds = new Set<string>();
  const prefersDirect =
    input.directProviderId !== undefined &&
    input.providers.some((provider) => provider.id === input.directProviderId);
  const fallback = input.providers[0];
  if (prefersDirect && input.directProviderId !== undefined) {
    directIds.add(input.directProviderId);
  } else if (fallback !== undefined) {
    directIds.add(fallback.id);
  }

  const wrapped: string[] = [];
  const direct: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const provider of input.providers) {
    if (directIds.has(provider.id)) {
      direct.push(provider.id);
      continue;
    }
    if (isPolicyWrapped(provider)) {
      wrapped.push(provider.id);
      continue;
    }
    try {
      input.install(wrapProvider(provider, input.policyFor(provider), input.wrapperOptions));
      wrapped.push(provider.id);
    } catch (error) {
      failed.push({ id: provider.id, error: messageOf(error) });
    }
  }
  return { wrapped, direct, failed };
}

/**
 * Runtime-agnostic installer for pi-durable, which is not installed or vendored
 * here: it hands in a `Models`-shaped object (`getProviders`/`setProvider`) and
 * gets the same wrapping path the pi extension uses. Re-running it over the same
 * collection is a no-op (see `wrapProviderCollection`).
 */
export function installProviderPolicy(
  models: ModelsLike,
  options: ProviderWrapperOptions & {
    policyFor: (provider: ProviderLike) => ProviderPolicy;
    directProviderId?: string;
    enabled?: boolean;
  },
): WrapProviderCollectionResult {
  const { policyFor, directProviderId, enabled, ...wrapperOptions } = options;
  return wrapProviderCollection({
    providers: models.getProviders(),
    policyFor,
    install: (provider) => models.setProvider(provider),
    directProviderId,
    enabled,
    wrapperOptions,
  });
}
