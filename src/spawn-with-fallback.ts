/**
 * Quota-aware spawn loop.
 *
 * Tries an ordered list of candidate models for a single sub-agent task. On a
 * quota/credit/rate-limit, transient, model-unavailable, or provider-without-key
 * failure (`isFallbackWorthy`) it cools the target down and moves to the next
 * candidate; on auth/config/startup failures it stops immediately — switching
 * models won't fix those and would hide a real misconfiguration.
 *
 * Each attempt normally gets a fresh session id (a "-fallback-N" suffix) so
 * pi never resumes a half-failed session. In resume mode (`resumeSession`)
 * every candidate instead shares the base session name and the spawn layer's
 * create-or-resume `--session-id` reuses the existing transcript, with usage/
 * cost still aggregated across attempts.
 *
 * The "retry ONLY on quota" rule keeps deterministic quality-gate failures
 * untouched: those are evaluated by the caller against the returned result,
 * never by this loop.
 */

import type { SpawnDetails, SpawnOptions, SpawnResult, SpawnUsage } from "./agent-registry.js";
import type { CapacityCache, CapacityWindow } from "./capacity-cache.js";
import { orderCandidatesByCapacity } from "./capacity-cache.js";
import type { ModelClass } from "./model-classes.js";
import { candidatesForModel, providerOf } from "./model-classes.js";
import {
  COOLDOWN_REFRESH_MAX_AGE_MS,
  createModelCooldownStore,
  type ModelCooldownStore,
  type ProviderCooldownCause,
} from "./model-cooldown.js";
import type { ModelTelemetryStore } from "./model-telemetry.js";
import type { FailureClassification, FailureKind } from "./quota-failure.js";
import { classifySpawnFailure, isFallbackWorthy } from "./quota-failure.js";
import { spawnAgentProcess } from "./spawn.js";

export interface SpawnAttempt {
  model: string;
  classification: FailureClassification;
  /** True when the candidate was skipped because it is cooling down. */
  skippedCooldown?: boolean;
  /** Provider skipped because an earlier candidate on it hit a quota failure. */
  skippedProvider?: string;
  /** Provider skipped because the pre-dispatch capacity signal marks it exhausted. */
  skippedCapacity?: string;
  /** True when the attempt ran at fallback index > 0. */
  fallback?: boolean;
  /** Tool calls this attempt executed (0 marks a no-op candidate). */
  toolCalls?: number;
  /** Cost in USD attributed to this attempt. */
  cost?: number;
}

/** One candidate skipped before it was spawned, with the reason recorded for it. */
export interface SkippedModel {
  model: string;
  reason: string;
}

/**
 * How the run's model was actually selected: the model that served it (absent
 * when nothing was dispatched), the pre-dispatch pick, and every candidate
 * skipped before dispatch.
 */
export interface RunModelSelection {
  servedModel?: string;
  requestedModel: string;
  skipped: SkippedModel[];
}

export interface SpawnWithFallbackResult {
  result: SpawnResult;
  attempts: SpawnAttempt[];
  /** Derived selection; callers persist it instead of re-deriving from `attempts`. */
  selection: RunModelSelection;
}

export interface SpawnWithFallbackOptions extends SpawnOptions {
  /** Ordered candidates to try. Defaults to the class of `model`. */
  candidates?: string[];
  /** Explicit capability tier for fallback expansion; defaults to the class of `model`. */
  modelClass?: ModelClass;
  /** Shared cooldown store; create one per orchestrator and pass it across spawns. */
  cooldownStore?: ModelCooldownStore;
  /** Classifier override (test seam). */
  classify?: (details: SpawnDetails) => FailureClassification;
  /** Set false to disable fallback (kill switch). Defaults to true. */
  enabled?: boolean;
  /**
   * Cap on the number of SPAWNED attempts (default: all candidates). A
   * candidate skipped for cooldown/capacity never consumes the cap: it was never
   * tried, and counting it would fail the run while a healthy candidate waits
   * further down the preference list.
   */
  maxAttempts?: number;
  /** Phase name for telemetry grouping (e.g. "plan", "implement"). */
  phase?: string;
  /** Shared telemetry store; records attempt/fallback/429/no-op counts as it runs. */
  telemetry?: ModelTelemetryStore;
  /**
   * Pre-dispatch capacity cache. When provided, candidates whose provider is
   * known-exhausted are moved behind the healthy ones before the first attempt.
   */
  capacity?: CapacityCache;
}

function zeroUsage(): SpawnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 };
}

function sumUsage(total: SpawnUsage, next: SpawnUsage): SpawnUsage {
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    cost: total.cost + next.cost,
    turns: total.turns + next.turns,
    toolCalls: total.toolCalls + next.toolCalls,
  };
}

function withAggregatedUsage(
  result: SpawnResult,
  usage: SpawnUsage,
  finalAttemptToolCalls: number,
): SpawnResult {
  return {
    ...result,
    details: { ...result.details, usage, finalAttemptToolCalls },
  };
}

function exhaustedResult(models: string[]): SpawnResult {
  // No candidates at all is a configuration outcome, not a cooldown: printing
  // an empty parenthesis list reads like a formatting bug to an operator.
  const named = models.length > 0 ? ` (${models.join(", ")})` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `All candidate models are in cooldown${named}; retry later.`,
      },
    ],
    details: { messages: [], usage: zeroUsage(), exitCode: 1 },
  };
}

/**
 * Refusal result for a kill-switch candidate skipped before dispatch.
 *
 * The skip row records the real cause, so the copy reuses it instead of
 * labelling every refusal a cooldown: a provider with no API key is an operator
 * fix, not a spent quota to wait out. The all-cooling wording is kept for a
 * genuine cooldown (a quota-spent provider, an untagged legacy entry, or a
 * model-scoped endpoint window).
 */
function refusalResult(
  attempt: SpawnAttempt,
  cause: ProviderCooldownCause | undefined,
): SpawnResult {
  const cooldownScoped =
    attempt.skippedCapacity === undefined &&
    (attempt.skippedCooldown === true || cause === undefined || cause === "quota");
  if (cooldownScoped) return exhaustedResult([attempt.model]);
  const reason = attempt.classification.reason ?? attempt.classification.kind;
  return {
    content: [{ type: "text" as const, text: `Refusing to dispatch ${attempt.model}: ${reason}` }],
    details: { messages: [], usage: zeroUsage(), exitCode: 1 },
  };
}

/** Result for a run cancelled before any candidate was dispatched. */
function abortedResult(): SpawnResult {
  return {
    content: [
      {
        type: "text" as const,
        text: "Run aborted before any candidate could be dispatched.",
      },
    ],
    details: { messages: [], usage: zeroUsage(), exitCode: 1 },
  };
}

/** Per-candidate skip row for a provider the pre-dispatch capacity signal blocks. */
function capacitySkipAttempt(candidate: string): SpawnAttempt {
  const provider = providerOf(candidate);
  return {
    model: candidate,
    classification: skippedCapacityClassification(provider),
    skippedCapacity: provider,
  };
}

/** Fast-fail result for the all-providers-exhausted capacity case. */
function capacityExhaustedResult(
  models: string[],
  windows: readonly CapacityWindow[],
): SpawnResult {
  const providers = [...new Set(windows.map((window) => window.provider))];
  const providerText = providers.length > 0 ? ` (${providers.join(", ")})` : "";
  return {
    content: [
      {
        type: "text" as const,
        text:
          `All candidate models are on capacity-exhausted providers${providerText}; ` +
          `retry after reset. Candidates: ${models.join(", ")}.`,
      },
    ],
    details: { messages: [], usage: zeroUsage(), exitCode: 1 },
  };
}

/** True when the attempt row records a candidate that was never spawned. */
function isSkippedAttempt(attempt: SpawnAttempt): boolean {
  return (
    attempt.skippedCooldown === true ||
    attempt.skippedProvider !== undefined ||
    attempt.skippedCapacity !== undefined
  );
}

/**
 * Derive a run's model selection from the fallback outcome.
 *
 * `servedModel` prefers the spawn layer's own `details.model` (what pi actually
 * ran), then the last spawned attempt. It stays ABSENT when nothing spawned —
 * an all-skipped, capacity-exhausted, or aborted run must not be reported as
 * having run on the requested model, or the manifest would name a model that
 * executed nothing.
 */
export function deriveRunModelSelection(
  requestedModel: string,
  attempts: readonly SpawnAttempt[],
  servedModel?: string,
): RunModelSelection {
  const spawned = attempts.filter((attempt) => !isSkippedAttempt(attempt));
  const served =
    servedModel !== undefined && servedModel !== "" ? servedModel : spawned.at(-1)?.model;
  return {
    ...(served !== undefined ? { servedModel: served } : {}),
    requestedModel,
    skipped: attempts.filter(isSkippedAttempt).map((attempt) => ({
      model: attempt.model,
      reason: attempt.classification.reason ?? attempt.classification.kind,
    })),
  };
}

/**
 * Fold a later dispatch's selection into the run's recorded one.
 *
 * A quality-gate retry can run on a different candidate than the phase's own
 * spawn, and the manifest must describe the attempt that actually served the
 * run: the LAST spawned model wins (a later spawn with nothing dispatched keeps
 * the earlier served model). Skipped rows accumulate, de-duplicated, because
 * each dispatch re-skips the same cooling providers and the trail should not
 * repeat them.
 */
export function mergeRunModelSelections(
  current: RunModelSelection,
  next: RunModelSelection,
): RunModelSelection {
  const seen = new Set(current.skipped.map((row) => `${row.model}\u0000${row.reason}`));
  const added = next.skipped.filter((row) => !seen.has(`${row.model}\u0000${row.reason}`));
  const served = next.servedModel ?? current.servedModel;
  return {
    ...(served !== undefined ? { servedModel: served } : {}),
    requestedModel: next.requestedModel,
    skipped: [...current.skipped, ...added],
  };
}

function skippedClassification(model: string): FailureClassification {
  return { kind: "other", reason: `Model ${model} is cooling down after a quota failure.` };
}

/**
 * Human phrase for a provider-wide skip cause. Exhaustive over
 * `ProviderCooldownCause`, so adding a cause forces a phrase instead of silently
 * collapsing into a generic sentence; absent means an entry without a tag
 * (legacy file or another caller), which keeps the historical wording.
 */
const SKIPPED_PROVIDER_CAUSE: Readonly<Record<ProviderCooldownCause, string>> = {
  quota: "is cooling down after a quota failure",
  unconfigured: "has no API key configured",
};

function skippedProviderClassification(
  provider: string,
  cause: ProviderCooldownCause | undefined,
): FailureClassification {
  const phrase =
    cause === undefined
      ? "is cooling down after a provider-scoped failure"
      : SKIPPED_PROVIDER_CAUSE[cause];
  return {
    kind: "other",
    reason: `Provider ${provider} ${phrase}; skipping remaining models on it.`,
  };
}

function skippedCapacityClassification(provider: string): FailureClassification {
  return {
    kind: "other",
    reason: `Provider ${provider} is inside its capacity reset window; skipping remaining models on it.`,
  };
}

/**
 * A fresh session id per *spawned* attempt, unless resume mode shares the base
 * session. `attemptOrdinal` is the spawned-attempt count, not the candidate
 * loop index: a skipped (cooling) candidate must not burn a `-fallback-N`
 * ordinal, or the headline fallback metric counts phantom sessions.
 */
function sessionNameFor(
  base: string | undefined,
  attemptOrdinal: number,
  resumeSession: boolean,
): string | undefined {
  if (resumeSession) return base;
  if (attemptOrdinal === 0 || base === undefined) return base;
  return `${base}-fallback-${attemptOrdinal}`;
}

type CandidateOutcome =
  | { stop: true; result: SpawnResult; classification: FailureClassification }
  | { stop: false; result: SpawnResult; classification: FailureClassification };

/** Spawn one candidate and decide whether the loop should stop or retry. */
async function runCandidate(
  candidate: string,
  attemptOrdinal: number,
  spawnOptions: SpawnOptions,
  classifyFn: (details: SpawnDetails) => FailureClassification,
  suppressResumeWarning: boolean,
): Promise<CandidateOutcome> {
  const sessionName = sessionNameFor(
    spawnOptions.sessionName,
    attemptOrdinal,
    spawnOptions.resumeSession === true,
  );
  const result = await spawnAgentProcess({
    ...spawnOptions,
    model: candidate,
    sessionName,
    suppressResumeWarning,
  });
  const classification = classifyFn(result.details);
  const stop = !isFallbackWorthy(classification.kind);
  return { stop, result, classification };
}

interface LoopDeps {
  candidates: string[];
  requestedModel: string;
  spawnOptions: SpawnOptions;
  classifyFn: (details: SpawnDetails) => FailureClassification;
  store: ModelCooldownStore;
  signal?: AbortSignal;
  phase: string;
  telemetry?: ModelTelemetryStore;
  capacity?: CapacityCache;
  /** Cap on SPAWNED attempts; skipped candidates never consume it. */
  maxSpawnedAttempts?: number;
}

/** Record one spawned attempt's outcome in the telemetry store. */
function recordAttemptTelemetry(
  deps: LoopDeps,
  candidate: string,
  fallback: boolean,
  outcome: CandidateOutcome,
): void {
  if (deps.telemetry === undefined) return;
  deps.telemetry.record({
    phase: deps.phase,
    model: candidate,
    fallback,
    classification: outcome.classification.kind,
    cost: outcome.result.details.usage.cost,
    toolCalls: outcome.result.details.usage.toolCalls,
  });
}

/**
 * True when a candidate's provider is known-exhausted from the cached capacity
 * signal. The cooldown store is deliberately not consulted here: its reactive
 * skips keep their original slot in `attempts` (skippedCooldown/skippedProvider),
 * while the capacity cache is what pre-empts the *first* attempt.
 */
function isCapacityExhausted(candidate: string, capacity: CapacityCache | undefined): boolean {
  return capacity?.isModelExhausted(candidate) ?? false;
}

/** A candidate to record in `attempts` without spawning, or undefined to spawn it. */
function skipCandidate(candidate: string, store: ModelCooldownStore): SpawnAttempt | undefined {
  const scope = store.cooldownScope(candidate);
  if (scope === "provider") {
    const provider = providerOf(candidate);
    return {
      model: candidate,
      // The skip row carries the cause the cooldown entry recorded, so an
      // operator can tell "bucket spent" from "no key configured" without
      // cross-referencing ~/.pi/agent/model-cooldowns.json.
      classification: skippedProviderClassification(
        provider,
        store.providerEntries().get(provider)?.cause,
      ),
      skippedProvider: provider,
    };
  }
  if (scope === "model") {
    return {
      model: candidate,
      classification: skippedClassification(candidate),
      skippedCooldown: true,
    };
  }
  return undefined;
}

/**
 * True when a failure disables the whole provider rather than one endpoint.
 *
 * `quota` spends the credential's bucket, so every model on it is dead until
 * reset. `unconfigured` means the credential itself is absent, so the same is
 * true for a different reason — but it is kept out of `quota` so telemetry and
 * the capacity cache never record a spent bucket for it (nothing was measured).
 */
function isProviderScopedFailure(kind: FailureKind): boolean {
  return kind === "quota" || kind === "unconfigured";
}

/**
 * Stable cooldown cause for a provider-wide failure, or undefined for kinds that
 * are endpoint-scoped. Kept next to `isProviderScopedFailure` so the two cannot
 * disagree: the capacity probe and the attempt trail both depend on `quota` and
 * `unconfigured` being distinguishable.
 */
function providerCooldownCause(kind: FailureKind): ProviderCooldownCause | undefined {
  switch (kind) {
    case "quota":
      return "quota";
    case "unconfigured":
      return "unconfigured";
    default:
      return undefined;
  }
}

/**
 * Record a cooldown: provider-scoped for quota/unconfigured, endpoint-scoped otherwise.
 *
 * Exported because the *in-session* recovery path (bd-229: an orchestrator turn
 * that failed on its own model) must persist the same verdict as a failed
 * spawn, so one dead provider is learned once instead of once per path.
 */
export function recordFailureCooldown(
  store: ModelCooldownStore,
  candidate: string,
  provider: string,
  classification: FailureClassification,
): void {
  if (classification.cooldownSeconds === undefined) return;
  const seconds = classification.cooldownSeconds;
  const reason = classification.reason ?? classification.kind;
  // Only a provider-wide failure exhausts a whole credential. A transient fault
  // or a retired model id is endpoint-specific: the same bare id is usually still
  // served by another provider, so cooling the provider instead would discard
  // healthy candidates.
  if (isProviderScopedFailure(classification.kind) && provider !== "") {
    // A parsed reset hint is authoritative; an unhinted quota window is a guess,
    // so the store escalates it when this provider was already cooling instead
    // of re-guessing the same span (bd-38: a weekly limit re-probed every
    // 15 minutes, each probe burning a real fallback session). The `cause` tag
    // persists why: the capacity probe excludes `unconfigured`, and the skip row
    // reports it.
    store.markProviderCooldown(provider, seconds, reason, {
      cause: providerCooldownCause(classification.kind),
      hinted: classification.cooldownHinted === true,
    });
  } else {
    store.markCooldown(candidate, seconds, reason);
  }
}

/**
 * Feed an observed quota window back into the pre-dispatch capacity cache so a
 * mid-workflow 429 is reflected immediately instead of waiting out the TTL.
 * Provider-scoped only: a transient failure is endpoint-specific and must not
 * reorder the provider's other models.
 */
function recordCapacityFromFailure(
  capacity: CapacityCache | undefined,
  provider: string,
  classification: FailureClassification,
): void {
  if (capacity === undefined) return;
  if (classification.kind !== "quota" || provider === "") return;
  const seconds = classification.cooldownSeconds;
  if (seconds === undefined) return;
  // Use the cache's own clock so a test/alternate clock stays consistent with
  // the windows the cache reads back.
  capacity.record({
    provider,
    resetAt: capacity.nowMs() + seconds * 1000,
    reason: classification.reason ?? classification.kind,
  });
}

/** Try candidates in order, cooling down quota/transient failures as it goes. */
async function runCandidateLoop(deps: LoopDeps): Promise<SpawnWithFallbackResult> {
  const attempts: SpawnAttempt[] = [];
  let lastResult: SpawnResult | undefined;
  let totalUsage: SpawnUsage = zeroUsage();
  // The resume-unavailable warning is per-spawn, not per-candidate: a missing
  // base session would otherwise warn once for every fallback candidate. Only
  // the first candidate that actually spawns emits it.
  //
  // `spawnedAttempts` (not the candidate index) also defines the telemetry
  // `fallback` flag and the `-fallback-N` session ordinal: a skipped/cooling
  // candidate consumes an index but never spawns, so index > 0 would report a
  // 100% fallback rate with zero fallbacks and mint a phantom session.
  let spawnedAttempts = 0;

  for (const candidate of deps.candidates) {
    if (deps.signal?.aborted) break;
    // The cap bounds spawns, not candidates: a skipped candidate was never
    // tried, so `maxAttempts: 1` must still reach the first healthy candidate
    // rather than fast-failing on a skip row alone.
    if (deps.maxSpawnedAttempts !== undefined && spawnedAttempts >= deps.maxSpawnedAttempts) break;

    deps.store.prune();
    const skip = skipCandidate(candidate, deps.store);
    if (skip) {
      attempts.push(skip);
      continue;
    }

    const provider = providerOf(candidate);
    const fallback = spawnedAttempts > 0;
    const outcome = await runCandidate(
      candidate,
      spawnedAttempts,
      deps.spawnOptions,
      deps.classifyFn,
      fallback,
    );
    spawnedAttempts += 1;
    attempts.push({
      model: candidate,
      classification: outcome.classification,
      fallback,
      toolCalls: outcome.result.details.usage.toolCalls,
      cost: outcome.result.details.usage.cost,
    });
    recordAttemptTelemetry(deps, candidate, fallback, outcome);
    lastResult = outcome.result;
    totalUsage = sumUsage(totalUsage, outcome.result.details.usage);

    if (outcome.stop) {
      // The classifier reads `finalAttemptToolCalls`, so record the stopping
      // attempt's own count rather than the summed reporting total.
      return {
        result: withAggregatedUsage(
          outcome.result,
          totalUsage,
          outcome.result.details.usage.toolCalls,
        ),
        attempts,
        selection: deriveRunModelSelection(
          deps.requestedModel,
          attempts,
          outcome.result.details.model,
        ),
      };
    }

    recordFailureCooldown(deps.store, candidate, provider, outcome.classification);
    recordCapacityFromFailure(deps.capacity, provider, outcome.classification);
  }

  const endedByAbort = (deps.signal?.aborted ?? false) && lastResult === undefined;
  return {
    result: withAggregatedUsage(
      // A cancelled run must not claim every candidate was cooling down: the
      // wording reaches the operator through the manifest and the delivery.
      lastResult ?? (endedByAbort ? abortedResult() : exhaustedResult(deps.candidates)),
      totalUsage,
      lastResult?.details.usage.toolCalls ?? 0,
    ),
    attempts,
    selection: deriveRunModelSelection(deps.requestedModel, attempts, lastResult?.details.model),
  };
}

export async function spawnAgentWithFallback(
  options: SpawnWithFallbackOptions,
): Promise<SpawnWithFallbackResult> {
  const {
    candidates,
    modelClass,
    cooldownStore,
    classify,
    enabled,
    maxAttempts,
    phase,
    telemetry,
    capacity,
    ...spawnOptions
  } = options;
  const classifyFn = classify ?? classifySpawnFailure;
  const store = cooldownStore ?? createModelCooldownStore();
  const resolved = candidates ?? candidatesForModel(options.model, modelClass);

  const firstModel = resolved[0];
  if (firstModel === undefined || maxAttempts === 0) {
    // A cancelled run must not be reported as "everything is cooling down", and
    // that is true for the zero-cap/empty-candidate path too: the caller sees
    // the same wording as the in-loop abort.
    return {
      result: options.signal?.aborted === true ? abortedResult() : exhaustedResult([]),
      attempts: [],
      selection: deriveRunModelSelection(options.model, []),
    };
  }

  // Candidate selection must see the PERSISTED cooldown store, not the snapshot
  // this process loaded at import time: a provider spent by another fleet member
  // (or by an earlier lifecycle) is otherwise discovered reactively, after
  // paying a failed spawn in the fallback loop. This runs before the kill-switch
  // branch too — no fallback does not mean "ignore a known-dead provider".
  // Deliberately TTL-independent: the capacity probe caches for 5 minutes and
  // skips the store refresh entirely when an endpoint probe answers. The bounded
  // window keeps the capacity probe from re-reading the same file in one spawn.
  store.refreshIfStale(COOLDOWN_REFRESH_MAX_AGE_MS);
  store.prune();

  // Kill switch: try the single configured model and surface its result as-is.
  // One model only — a skip is refused rather than fallen back from, because
  // spawning against a provider known to be spent would burn a request, a
  // `-fallback-N`-less session, and the leaseless run that follows it.
  if (!(enabled ?? true)) {
    const skip = skipCandidate(firstModel, store);
    if (skip !== undefined) {
      const attempts: SpawnAttempt[] = [skip];
      return {
        result: refusalResult(skip, store.providerEntries().get(providerOf(firstModel))?.cause),
        attempts,
        selection: deriveRunModelSelection(options.model, attempts),
      };
    }
    const result = await spawnAgentProcess({ ...spawnOptions, model: firstModel });
    const attempts: SpawnAttempt[] = [
      { model: firstModel, classification: classifyFn(result.details) },
    ];
    return {
      result,
      attempts,
      selection: deriveRunModelSelection(options.model, attempts, result.details.model),
    };
  }

  // Pre-flight capacity check: refresh the cached signal once per TTL, then
  // move candidates on known-exhausted providers behind the healthy ones.
  if (capacity !== undefined) await capacity.refreshIfStale();
  const orderedCandidates = orderCandidatesByCapacity(resolved, (candidate) =>
    isCapacityExhausted(candidate, capacity),
  );

  // All-exhausted fast-fail, mirroring the reactive cooldown path: spawning
  // against a provider known to be inside its reset window only burns an
  // attempt and a `-fallback-N` session, violating the bd-116 acceptance rule.
  if (
    capacity !== undefined &&
    orderedCandidates.length > 0 &&
    orderedCandidates.every((candidate) => isCapacityExhausted(candidate, capacity))
  ) {
    // List only the candidates' own providers, not every cached window.
    const candidateProviders = new Set(orderedCandidates.map(providerOf));
    const relevantWindows = capacity
      .windows()
      .filter((window) => candidateProviders.has(window.provider));
    const attempts = orderedCandidates.map(capacitySkipAttempt);
    return {
      result: capacityExhaustedResult(orderedCandidates, relevantWindows),
      attempts,
      selection: deriveRunModelSelection(options.model, attempts),
    };
  }

  return runCandidateLoop({
    candidates: orderedCandidates,
    requestedModel: options.model,
    maxSpawnedAttempts: maxAttempts,
    spawnOptions,
    classifyFn,
    store,
    signal: options.signal,
    phase: phase ?? "unknown",
    telemetry,
    capacity,
  });
}
