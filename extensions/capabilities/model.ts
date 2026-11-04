/**
 * Model capability: the model-routing state (bd-116) and its telemetry sink
 * (bd-179).
 *
 * One object owns the pre-dispatch capacity cache and the per-workflow telemetry
 * store; this module is the documented module-level mutable-state exception for
 * model routing (see AGENTS.md) and owns every reset/flush rule. Consumers
 * import it rather than threading it through dependency objects.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  CAPACITY_PROBE_URL_ENV,
  createCapacityCache,
  createEndpointCapacityProbe,
  createFallbackCapacityProbe,
  probeFromCooldownStore,
} from "../../src/capacity-cache.js";
import { createModelCooldownStore, defaultModelCooldownPath } from "../../src/model-cooldown.js";
import {
  createModelSessionState,
  flushAndResetModelTelemetry,
  flushModelTelemetry,
  shouldWarnFlushFailure,
} from "../../src/model-session-state.js";
import type { ModelStateStore } from "../../src/model-state-store.js";
import { sharedModelStateStore } from "../../src/model-state-store.js";
import { formatModelTelemetrySummary } from "../../src/model-telemetry.js";
import type { ProviderPolicy } from "../../src/provider-policy.js";
import {
  createLeaseTtlResolver,
  createProviderPolicy,
  resolveCapacityLimit,
} from "../../src/provider-policy.js";
import type {
  DispatchAttribution,
  ProviderLike,
  WrapProviderCollectionResult,
} from "../../src/provider-wrapper.js";
import { setDispatchAttribution, wrapProviderCollection } from "../../src/provider-wrapper.js";

// limit, subsequent spawns in this session skip it until the cooldown lapses.
// One truth (bd-256): the cooldowns live in the shared model-state store, the
// same one the provider wrapper writes, so a verdict from either path steers the
// other. The retired JSON file is imported once on first use; it is never
// written again. Kill switch: BELAYD_MODEL_FALLBACK=0 disables candidate fallback
// entirely.
export const modelCooldown = createModelCooldownStore({
  store: () => sharedModelStateStoreInstance(),
  // Lazy so the retired path is read when the import first runs, not at module
  // load: tests (and a restarted session) may set the env var later.
  filePath: () => defaultModelCooldownPath(),
});
// Pre-dispatch capacity signal. When a usage/reset endpoint is configured it
// is probed directly; otherwise the shared store's provider windows stand in.
// Results are cached (TTL) so a multi-phase workflow re-probes at most once per
// TTL, and mid-workflow 429s are recorded back into the cache.
const capacityProbeUrl = process.env[CAPACITY_PROBE_URL_ENV];
// Session-scoped model-routing state (bd-116): the pre-dispatch capacity
// cache, the per-workflow telemetry store, and the per-destination telemetry
// flush cursors. This one object is the documented module-level mutable-state
// exception for model routing; the module owns its reset semantics.
export const modelState = createModelSessionState({
  capacity:
    capacityProbeUrl !== undefined && capacityProbeUrl !== ""
      ? createCapacityCache({
          // A configured-but-unreachable endpoint must not silently disable the
          // capacity signal: fall back to the shared cooldown windows and warn
          // (throttled inside the probe) that the endpoint is not delivering.
          probe: createFallbackCapacityProbe(
            createEndpointCapacityProbe({
              url: capacityProbeUrl,
              onFailure: (reason) => {
                console.warn(
                  `[belayd-harness] ${CAPACITY_PROBE_URL_ENV} produced no capacity signal (${reason}); falling back to the cooldown store.`,
                );
              },
            }),
            probeFromCooldownStore(modelCooldown),
          ),
        })
      : createCapacityCache({ probe: probeFromCooldownStore(modelCooldown) }),
});
export const modelFallbackEnabled = process.env.BELAYD_MODEL_FALLBACK !== "0";

/**
 * The model-routing bundle one extension load hands to every routing consumer:
 * cooldown store, capacity cache, telemetry sink and kill switch. Built here so
 * the bunch cannot drift from the state it reads. Provider wrapping (bd-187) is
 * installed separately on `session_start`, where the registry is available.
 */
export function createModelRouting(): {
  cooldownStore: typeof modelCooldown;
  capacity: typeof modelState.capacity;
  enabled: boolean;
  telemetry: typeof modelState.telemetry;
} {
  return {
    cooldownStore: modelCooldown,
    capacity: modelState.capacity,
    enabled: modelFallbackEnabled,
    telemetry: modelState.telemetry,
  };
}

// ── Shared model-state store (bd-187) ─────────────────────────────────
// Cooldown, capacity and spend live in one SQLite file so every repo daemon on
// the host sees the same budget. The store is opened lazily on first use (a
// routing read or a dispatch decision), never at import time: extension tests
// load this module and must not create the operator's state file. The accessor
// lives in the library so the routing adapter's default store and the wrapper's
// policy resolve the same instance; it retries a transient open failure with a
// bounded backoff, because since bd-256 this store is the only cooldown truth
// and memoizing one failure as `null` would switch off both paths for a session.
export const MODEL_STATE_WRAPPER_ENV = "BELAYD_MODEL_STATE_WRAPPER";
export const modelStateWrapperEnabled = process.env[MODEL_STATE_WRAPPER_ENV] !== "0";

/** The process-wide store, or null when it cannot be opened (yet). */
export function sharedModelStateStoreInstance(): ModelStateStore | null {
  return sharedModelStateStore();
}

/** One-time warned TTL resolver: one policy is built per wrapped provider. */
const resolveModelLeaseTtlMs = createLeaseTtlResolver();

/** One policy for every wrapped provider; the store is resolved per decision. */
export function modelStatePolicy(): ProviderPolicy {
  return createProviderPolicy({
    store: sharedModelStateStoreInstance,
    // Capacity is wired here, on the production path: every wrapped dispatch
    // reserves a lease for its stream, so `in_use` is live cross-process
    // concurrency. `BELAYD_MODEL_CAPACITY_LIMIT=0` disables it, and
    // `BELAYD_MODEL_LEASE_TTL_MS` tunes the renewal TTL (a sub-floor value is
    // clamped to `LEASE_TTL_FLOOR_MS` and warned about once).
    capacity: {
      limit: resolveCapacityLimit(process.env),
      leaseTtlMs: resolveModelLeaseTtlMs(process.env),
    },
  });
}

/**
 * Per-dispatch spend attribution (W3). One shared holder, read by every wrapped
 * provider at terminal time; the extension repoints it per turn so an idempotent
 * re-install can never resurrect a stale phase/task label.
 */
export const modelStateAttribution: DispatchAttribution = {};

/** Repoint spend attribution from the current phase/task context. */
export function setModelStateAttribution(attribution: DispatchAttribution): void {
  setDispatchAttribution(modelStateAttribution, attribution);
}

/**
 * Flush the finished workflow's telemetry, then start a fresh per-workflow
 * store. The store and every destination cursor are dropped only after the
 * flush succeeds: a failed final write must not discard rows that never
 * reached disk, and the cursor stays so the next flush retries them.
 */
export function resetModelTelemetry(cwd: string, options?: { log?: boolean }): void {
  const shouldLog = options?.log === true;
  const result = flushAndResetModelTelemetry({
    state: modelState,
    cwd,
    beforeReset: () => {
      if (shouldLog) logModelTelemetrySummary();
    },
  });
  if (!result.ok) {
    warnModelTelemetryFlushFailure(result.error);
  }
}

/**
 * Warn about a failed telemetry flush at most once per throttle window, so a
 * full disk does not spam the log on every settle, stop, and shutdown.
 */
function warnModelTelemetryFlushFailure(error: string): void {
  if (!shouldWarnFlushFailure(modelState)) return;
  console.warn(`[belayd-harness] failed to persist model telemetry: ${error}`);
}

function logModelTelemetrySummary(): void {
  const stats = modelState.telemetry.stats();
  if (stats.length === 0) return;
  console.log(formatModelTelemetrySummary(stats, modelState.telemetry.totals()));
}

/**
 * Merge only the rows added since this destination's last flush into
 * `.belayd/telemetry.json`. `appendModelTelemetry` read-merge-writes, so an
 * overwrite of the full store would re-append every earlier row on each
 * settle and grow counts quadratically. The per-cwd flush cursor tracks what
 * is already on disk for that destination; a failed write leaves the cursor
 * unchanged so the rows are retried. Logs the summary only when `log` is set,
 * so the 6+ phase settles do not each emit the full cumulative breakdown;
 * workflow completion and session shutdown request the log once.
 */
export function persistModelTelemetry(cwd: string, options?: { log?: boolean }): void {
  const flushed = flushModelTelemetry({ state: modelState, cwd });
  if (!flushed.ok) {
    warnModelTelemetryFlushFailure(flushed.error);
    return;
  }
  if (options?.log === true) logModelTelemetrySummary();
}

// ── Provider wrapper registration (bd-187) ────────────────────────────
// Cooldown/capacity/spend must be read by whichever runtime dispatches, so the
// extension wraps the registered providers through the same code path pi-durable
// uses (`installProviderPolicy`). Exactly one provider stays DIRECT: a broken
// wrapper or an unopenable/read-only store must never be the only path to a
// model.
/**
 * Default provider kept unwrapped. `llmgateway` is the harness's per-token
 * primary (see `src/model-classes.ts`), so the common path has no wrapper
 * between the session and the credential.
 */
export const DIRECT_PROVIDER_FALLBACK_ID = "llmgateway";

/** Env override for the direct provider; the primary is the safe default. */
export const DIRECT_PROVIDER_ENV = "BELAYD_MODEL_STATE_DIRECT_PROVIDER";

/** The registry surface this module needs, declared structurally for test mocks. */
export interface ModelRegistryLike {
  getAll(): readonly { provider: string }[];
  getProvider(provider: string): unknown;
  /** Optional: newer registries can list providers that have no models yet. */
  getRegisteredProviderIds?(): readonly string[];
}

/** Cast boundary: the wrapper is structurally a provider; pi-ai is transitive. */
type RegisteredProvider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;

export interface RegisterProviderWrappersOptions {
  enabled?: boolean;
  directProviderId?: string;
  policyFor?: (provider: ProviderLike) => ProviderPolicy;
  /** Override the shared attribution holder (tests, alternate runtimes). */
  attribution?: DispatchAttribution;
}

export interface ProviderRegistrationReport {
  wrapped: string[];
  direct: string[];
  /** Registered providers left outside the policy, with the reason why. */
  bypassed: { id: string; reason: string }[];
  /** Lazy providers seen without an object for the first time (no warning yet). */
  deferred: string[];
}

/**
 * Registration-failure warning window (W5): reset per `session_start`, warn once
 * per session with the running failure count, so a second distinct failure in a
 * later session is still visible while one session cannot spam the log.
 */
let providerRegistrationFailureWindow: { count: number; warned: boolean } | undefined;

/** Start a new `session_start` warning window. */
export function beginProviderRegistrationSession(): void {
  providerRegistrationFailureWindow = { count: 0, warned: false };
}

export function warnProviderRegistrationFailure(error: unknown): void {
  const window = providerRegistrationFailureWindow ?? { count: 0, warned: false };
  providerRegistrationFailureWindow = window;
  window.count += 1;
  if (window.warned) return;
  window.warned = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[belayd-harness] model-state provider registration failed (${message}); ${window.count} failure(s) this session, providers stay direct; further failures are suppressed until the next session_start.`,
  );
}

/**
 * Lazy provider ids seen without an object. An id must be seen missing twice
 * (or come from a catalog that *does* have models but no object) before it is
 * reported, so a dynamic catalog registered before pi has materialised its
 * provider does not warn on the very first `session_start`.
 */
const lazyProviderIdsAwaitingObject = new Set<string>();

/**
 * Lazy ids already surfaced in a bypass warning. Kept until the provider
 * materialises: a provider that stays missing would otherwise alternate
 * deferred → bypassed → deferred and re-warn on every second session forever.
 */
const warnedLazyProviderIds = new Set<string>();

/** What a registered id with no provider object means for this pass. */
type LazyProviderState = "catalog-missing-object" | "deferred" | "reported" | "already-reported";

/**
 * Why a provider id has no object. A provider already in the catalog (`getAll`)
 * with no object is realised-with-no-object and is reported immediately; a
 * registered id with no object is deferred on first sighting, reported once
 * after that, and silent once the warning has been emitted (S4).
 */
function lazyProviderState(id: string, catalogIds: ReadonlySet<string>): LazyProviderState {
  if (catalogIds.has(id)) return "catalog-missing-object";
  if (warnedLazyProviderIds.has(id)) return "already-reported";
  if (lazyProviderIdsAwaitingObject.has(id)) return "reported";
  return "deferred";
}

/**
 * Wrap every provider in `registry` except the direct fallback.
 *
 * Registration happens on `session_start` because only `ExtensionContext`
 * exposes `modelRegistry`; `ExtensionAPI` can register a provider but not list
 * one. Providers whose object is missing, whose id is empty, or whose install
 * throws are returned in `bypassed` and named in ONE warning, so "which
 * providers are outside the policy" is answerable from the session log. The
 * intentionally-direct provider is excluded from that warning.
 */
export function registerModelProviderWrappers(
  pi: ExtensionAPI,
  registry: unknown,
  options: RegisterProviderWrappersOptions = {},
): ProviderRegistrationReport {
  const enabled = options.enabled ?? modelStateWrapperEnabled;
  if (!enabled) return { wrapped: [], direct: [], bypassed: [], deferred: [] };

  const candidate = registry as Partial<ModelRegistryLike> | undefined;
  if (
    candidate === undefined ||
    typeof candidate.getAll !== "function" ||
    typeof candidate.getProvider !== "function" ||
    typeof pi.registerProvider !== "function"
  ) {
    return { wrapped: [], direct: [], bypassed: [], deferred: [] };
  }
  const modelRegistry: ModelRegistryLike = {
    getAll: () => candidate.getAll?.() ?? [],
    getProvider: (provider) => candidate.getProvider?.(provider),
  };
  const collected = collectPolicyProviders(modelRegistry, candidate);

  const directProviderId =
    options.directProviderId ?? process.env[DIRECT_PROVIDER_ENV] ?? DIRECT_PROVIDER_FALLBACK_ID;
  const result = wrapProviderCollection({
    providers: collected.providers,
    policyFor: options.policyFor ?? modelStatePolicy,
    install: (provider) => {
      // Single boundary cast; see the module header of `provider-wrapper.ts`.
      pi.registerProvider(provider as unknown as RegisteredProvider);
    },
    directProviderId,
    enabled,
    wrapperOptions: { attribution: options.attribution ?? modelStateAttribution },
  });

  return {
    wrapped: result.wrapped,
    direct: result.direct,
    bypassed: reportBypassedProviders(collected.bypassed, result, collected.silentLazyIds),
    deferred: collected.deferred,
  };
}

/**
 * Enumerate the providers that can be wrapped.
 *
 * `getAll()` only lists providers that already have models; a registered id can
 * have its provider object materialise later. The registered-id list is a
 * belt-and-braces source. Anything that cannot be wrapped is returned with the
 * reason instead of disappearing; a lazy provider registered before it has an
 * object is deferred on first sighting and reported once after that, never
 * warned twice for the same missing object (S4).
 */
function collectPolicyProviders(
  modelRegistry: ModelRegistryLike,
  candidate: Partial<ModelRegistryLike>,
): {
  providers: ProviderLike[];
  bypassed: { id: string; reason: string }[];
  deferred: string[];
  /** Lazy bypass entries already warned about in an earlier pass. */
  silentLazyIds: string[];
} {
  const catalogIds = new Set(modelRegistry.getAll().map((model) => model.provider));
  const providerIds = new Set(catalogIds);
  const registeredIds = candidate.getRegisteredProviderIds;
  if (typeof registeredIds === "function") {
    for (const id of registeredIds.call(candidate)) providerIds.add(id);
  }
  const providers: ProviderLike[] = [];
  const bypassed: { id: string; reason: string }[] = [];
  const deferred: string[] = [];
  const silentLazyIds: string[] = [];
  for (const id of [...providerIds].sort()) {
    const real = modelRegistry.getProvider(id);
    if (real === undefined || real === null) {
      switch (lazyProviderState(id, catalogIds)) {
        case "catalog-missing-object":
          bypassed.push({ id, reason: "provider object unavailable" });
          break;
        case "deferred":
          lazyProviderIdsAwaitingObject.add(id);
          deferred.push(id);
          break;
        case "reported":
          warnedLazyProviderIds.add(id);
          bypassed.push({ id, reason: "provider still unavailable (lazy catalog)" });
          break;
        case "already-reported":
          bypassed.push({ id, reason: "provider still unavailable (lazy catalog)" });
          silentLazyIds.push(id);
          break;
      }
      continue;
    }
    // Materialised: it is wrapped below, so stop remembering it (W2/S4).
    lazyProviderIdsAwaitingObject.delete(id);
    warnedLazyProviderIds.delete(id);
    const declaredId = (real as { id?: unknown }).id;
    if (typeof declaredId !== "string" || declaredId === "") {
      bypassed.push({ id, reason: "missing provider id" });
      continue;
    }
    if (declaredId !== id) {
      bypassed.push({ id, reason: `provider id mismatch (${declaredId})` });
      continue;
    }
    // ProviderLike only names `id`/`stream`/`streamSimple`; the real object also
    // carries the catalog/auth members the wrapper forwards untouched.
    providers.push(real as ProviderLike);
  }
  return { providers, bypassed, deferred, silentLazyIds };
}

/**
 * Merge pre-install skips with install failures, drop the intentionally-direct
 * provider, and emit ONE warning naming everything left outside the policy.
 * `silentLazyIds` are still reported in `bypassed` but no longer re-warned: the
 * same missing object must not produce a warning every second session.
 */
function reportBypassedProviders(
  beforeInstall: readonly { id: string; reason: string }[],
  result: WrapProviderCollectionResult,
  silentLazyIds: readonly string[],
): { id: string; reason: string }[] {
  const directIds = new Set(result.direct);
  const bypassed = [
    ...beforeInstall,
    ...result.failed.map((failure) => ({
      id: failure.id,
      reason: `registration failed: ${failure.error}`,
    })),
  ].filter((entry) => !directIds.has(entry.id));
  const silent = new Set(silentLazyIds);
  const toWarn = bypassed.filter((entry) => !silent.has(entry.id));
  if (toWarn.length > 0) {
    console.warn(
      `[belayd-harness] model-state policy bypassed for: ${toWarn
        .map((entry) => `${entry.id} (${entry.reason})`)
        .join(", ")}`,
    );
  }
  return bypassed;
}

/**
 * `session_start` entry point: a broken registry or a rejected registration must
 * never abort the handler that flushes telemetry and resets session/run state.
 * Providers stay direct and the failure is warned once.
 */
export function registerModelProviderWrappersSafely(pi: ExtensionAPI, registry: unknown): void {
  try {
    registerModelProviderWrappers(pi, registry);
  } catch (error) {
    warnProviderRegistrationFailure(error);
  }
}

/**
 * Wrap a deferred provider as soon as it materialises (W2 review).
 *
 * `session_start` is the only registry snapshot pi offers, but a dynamic catalog
 * can materialise a provider mid-session (e.g. a catalog recompose). The
 * per-turn hook calls this, so a provider that appears between two
 * `session_start`s is wrapped at its next observation instead of staying direct
 * for the whole session.
 *
 * Returns null (and reads no registry) unless an id that was previously
 * deferred now has an object, so a session with no lazy providers pays one set
 * emptiness check per turn. Known limit: a provider that materialises after
 * that observation stays direct until the next one — pi emits no notification
 * for a provider object appearing.
 */
export function reconcileDeferredProviders(
  pi: ExtensionAPI,
  registry: unknown,
  options: RegisterProviderWrappersOptions = {},
): ProviderRegistrationReport | null {
  if (lazyProviderIdsAwaitingObject.size === 0) return null;
  const candidate = registry as Partial<ModelRegistryLike> | undefined;
  if (candidate === undefined || typeof candidate.getProvider !== "function") return null;
  const materialised = [...lazyProviderIdsAwaitingObject].some((id) => {
    const real = candidate.getProvider?.(id);
    return real !== undefined && real !== null;
  });
  if (!materialised) return null;
  return registerModelProviderWrappers(pi, registry, options);
}
