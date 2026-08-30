/**
 * Quota-aware spawn loop.
 *
 * Tries an ordered list of candidate models for a single sub-agent task. On a
 * quota/credit/rate-limit (or transient) failure it cools the model down and
 * moves to the next candidate; on auth/config/startup failures it stops
 * immediately — switching models won't fix those and would hide a real
 * misconfiguration.
 *
 * Each attempt gets a fresh session id (a "-fallback-N" suffix) so pi never
 * resumes a half-failed session, and usage/cost is aggregated across attempts.
 *
 * The "retry ONLY on quota" rule keeps deterministic quality-gate failures
 * untouched: those are evaluated by the caller against the returned result,
 * never by this loop.
 */

import type { SpawnDetails, SpawnOptions, SpawnResult, SpawnUsage } from "./agent-registry.js";
import { candidatesForModel } from "./model-classes.js";
import { createModelCooldownStore, type ModelCooldownStore } from "./model-cooldown.js";
import type { FailureClassification } from "./quota-failure.js";
import { classifySpawnFailure } from "./quota-failure.js";
import { spawnAgentProcess } from "./spawn.js";

export interface SpawnAttempt {
  model: string;
  classification: FailureClassification;
  /** True when the candidate was skipped because it is cooling down. */
  skippedCooldown?: boolean;
}

export interface SpawnWithFallbackResult {
  result: SpawnResult;
  attempts: SpawnAttempt[];
}

export interface SpawnWithFallbackOptions extends SpawnOptions {
  /** Ordered candidates to try. Defaults to the class of `model`. */
  candidates?: string[];
  /** Shared cooldown store; create one per orchestrator and pass it across spawns. */
  cooldownStore?: ModelCooldownStore;
  /** Classifier override (test seam). */
  classify?: (details: SpawnDetails) => FailureClassification;
  /** Set false to disable fallback (kill switch). Defaults to true. */
  enabled?: boolean;
  /** Cap on the number of candidates to attempt (default: all candidates). */
  maxAttempts?: number;
}

function zeroUsage(): SpawnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function sumUsage(total: SpawnUsage, next: SpawnUsage): SpawnUsage {
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    cost: total.cost + next.cost,
    turns: total.turns + next.turns,
  };
}

function withUsage(result: SpawnResult, usage: SpawnUsage): SpawnResult {
  return { ...result, details: { ...result.details, usage } };
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

function skippedClassification(model: string): FailureClassification {
  return { kind: "other", reason: `Model ${model} is cooling down after a quota failure.` };
}

/** A fresh session id per attempt so pi never resumes a half-failed session. */
function sessionNameFor(base: string | undefined, index: number): string | undefined {
  if (index === 0 || base === undefined) return base;
  return `${base}-fallback-${index}`;
}

type CandidateOutcome =
  | { stop: true; result: SpawnResult; classification: FailureClassification }
  | { stop: false; result: SpawnResult; classification: FailureClassification };

/** Spawn one candidate and decide whether the loop should stop or retry. */
async function runCandidate(
  candidate: string,
  index: number,
  spawnOptions: SpawnOptions,
  classifyFn: (details: SpawnDetails) => FailureClassification,
): Promise<CandidateOutcome> {
  const sessionName = sessionNameFor(spawnOptions.sessionName, index);
  const result = await spawnAgentProcess({ ...spawnOptions, model: candidate, sessionName });
  const classification = classifyFn(result.details);
  const stop = classification.kind !== "quota" && classification.kind !== "transient";
  return { stop, result, classification };
}

interface LoopDeps {
  candidates: string[];
  spawnOptions: SpawnOptions;
  classifyFn: (details: SpawnDetails) => FailureClassification;
  store: ModelCooldownStore;
  signal?: AbortSignal;
}

/** Try candidates in order, cooling down quota/transient failures as it goes. */
async function runCandidateLoop(deps: LoopDeps): Promise<SpawnWithFallbackResult> {
  const attempts: SpawnAttempt[] = [];
  let lastResult: SpawnResult | undefined;
  let totalUsage: SpawnUsage = zeroUsage();

  for (const [index, candidate] of deps.candidates.entries()) {
    if (deps.signal?.aborted) break;

    deps.store.prune();
    if (deps.store.isCoolingDown(candidate)) {
      attempts.push({
        model: candidate,
        classification: skippedClassification(candidate),
        skippedCooldown: true,
      });
      continue;
    }

    const outcome = await runCandidate(candidate, index, deps.spawnOptions, deps.classifyFn);
    attempts.push({ model: candidate, classification: outcome.classification });
    lastResult = outcome.result;
    totalUsage = sumUsage(totalUsage, outcome.result.details.usage);

    if (outcome.stop) return { result: withUsage(outcome.result, totalUsage), attempts };

    if (outcome.classification.cooldownSeconds !== undefined) {
      deps.store.markCooldown(
        candidate,
        outcome.classification.cooldownSeconds,
        outcome.classification.reason ?? outcome.classification.kind,
      );
    }
  }

  return {
    result: withUsage(lastResult ?? exhaustedResult(deps.candidates), totalUsage),
    attempts,
  };
}

export async function spawnAgentWithFallback(
  options: SpawnWithFallbackOptions,
): Promise<SpawnWithFallbackResult> {
  const { candidates, cooldownStore, classify, enabled, maxAttempts, ...spawnOptions } = options;
  const classifyFn = classify ?? classifySpawnFailure;
  const store = cooldownStore ?? createModelCooldownStore();
  const resolved = candidates ?? candidatesForModel(options.model);
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

  return runCandidateLoop({
    candidates: modelCandidates,
    spawnOptions,
    classifyFn,
    store,
    signal: options.signal,
  });
}
