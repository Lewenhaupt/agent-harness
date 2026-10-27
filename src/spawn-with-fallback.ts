/**
 * Quota-aware spawn loop.
 *
 * Tries an ordered list of candidate models for a single sub-agent task. On a
 * quota/credit/rate-limit, transient, or model-unavailable failure (`isFallbackWorthy`)
 * it cools the target down and moves to the next candidate; on
 * auth/config/startup failures it stops immediately — switching models won't fix
 * those and would hide a real misconfiguration.
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
import { createModelCooldownStore, type ModelCooldownStore } from "./model-cooldown.js";
import type { ModelTelemetryStore } from "./model-telemetry.js";
import type { FailureClassification } from "./quota-failure.js";
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

export interface SpawnWithFallbackResult {
  result: SpawnResult;
  attempts: SpawnAttempt[];
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
  /** Cap on the number of candidates to attempt (default: all candidates). */
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
  return {
    content: [
      {
        type: "text" as const,
        text: `All candidate models are in cooldown (${models.join(", ")}); retry later.`,
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

function skippedClassification(model: string): FailureClassification {
  return { kind: "other", reason: `Model ${model} is cooling down after a quota failure.` };
}

function skippedProviderClassification(provider: string): FailureClassification {
  return {
    kind: "other",
    reason: `Provider ${provider} is exhausted after a quota failure; skipping remaining models on it.`,
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
  spawnOptions: SpawnOptions;
  classifyFn: (details: SpawnDetails) => FailureClassification;
  store: ModelCooldownStore;
  signal?: AbortSignal;
  phase: string;
  telemetry?: ModelTelemetryStore;
  capacity?: CapacityCache;
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
      classification: skippedProviderClassification(provider),
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

/** Record a cooldown: provider-scoped for quota, endpoint-scoped otherwise. */
function recordCooldown(
  store: ModelCooldownStore,
  candidate: string,
  provider: string,
  classification: FailureClassification,
): void {
  if (classification.cooldownSeconds === undefined) return;
  const seconds = classification.cooldownSeconds;
  const reason = classification.reason ?? classification.kind;
  // Only a quota failure exhausts a whole credential bucket. A transient fault or
  // a retired model id is endpoint-specific: the same bare id is usually still
  // served by another provider, so cooling the provider instead would discard
  // healthy candidates.
  if (classification.kind === "quota" && provider !== "") {
    // A parsed reset hint is authoritative; an unhinted quota window is a guess,
    // so the store escalates it when this provider was already cooling instead
    // of re-guessing the same span (bd-38: a weekly limit re-probed every
    // 15 minutes, each probe burning a real fallback session).
    store.markProviderCooldown(provider, seconds, reason, {
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
      };
    }

    recordCooldown(deps.store, candidate, provider, outcome.classification);
    recordCapacityFromFailure(deps.capacity, provider, outcome.classification);
  }

  return {
    result: withAggregatedUsage(
      lastResult ?? exhaustedResult(deps.candidates),
      totalUsage,
      lastResult?.details.usage.toolCalls ?? 0,
    ),
    attempts,
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
  const modelCandidates = resolved.slice(0, maxAttempts);

  const firstModel = modelCandidates[0];
  if (firstModel === undefined) {
    return { result: exhaustedResult([]), attempts: [] };
  }

  // Kill switch: try the single configured model and surface its result as-is.
  if (!(enabled ?? true)) {
    const result = await spawnAgentProcess({ ...spawnOptions, model: firstModel });
    return {
      result,
      attempts: [{ model: firstModel, classification: classifyFn(result.details) }],
    };
  }

  // Pre-flight capacity check: refresh the cached signal once per TTL, then
  // move candidates on known-exhausted providers behind the healthy ones.
  if (capacity !== undefined) await capacity.refreshIfStale();
  const orderedCandidates = orderCandidatesByCapacity(modelCandidates, (candidate) =>
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
    return {
      result: capacityExhaustedResult(orderedCandidates, relevantWindows),
      attempts: orderedCandidates.map(capacitySkipAttempt),
    };
  }

  return runCandidateLoop({
    candidates: orderedCandidates,
    spawnOptions,
    classifyFn,
    store,
    signal: options.signal,
    phase: phase ?? "unknown",
    telemetry,
    capacity,
  });
}
