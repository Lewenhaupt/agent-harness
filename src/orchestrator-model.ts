/**
 * Orchestrator session model routing (bd-229).
 *
 * The fallback loop in `spawn-with-fallback.ts` wraps *spawned pi subprocesses*:
 * the harness picks the candidate, passes `--model`, and re-spawns on a quota
 * failure. An orchestrator session is not a subprocess — pi-web's session daemon
 * starts it from the operator's global default (`defaultProvider` /
 * `defaultModel` in `~/.pi/agent/settings.json`) and the harness never chose that
 * model. Live consequence: every `/belayd` child started on `llmgateway` and its
 * first turn died with `402 … "code":"billing_error"` while the cooldown store
 * already knew llmgateway was spent.
 *
 * This module owns the two pure decisions that close that gap, so both the launch
 * path (before a session is prompted) and the in-session recovery path (after a
 * turn failed) answer them the same way:
 *
 * - which of a model's candidates can actually serve a turn right now
 *   ({@link planModelRoute}), and
 * - how to name the providers that cannot, including their reset windows, in a
 *   refusal a human can act on ({@link describeBlockedProviders}).
 *
 * Everything here is pure: the availability predicate and the windows are passed
 * in, so the routing rules are testable without a cooldown file, a daemon or a
 * clock.
 */

import { candidatesForModel, providerOf } from "./model-classes.js";

/** A spawnable candidate split into the pair pi-web's model route expects. */
export interface ModelRoute {
  provider: string;
  /** Wire id as the provider serves it (may itself contain slashes). */
  modelId: string;
}

/** A provider's known reset window, in epoch ms. */
export interface ProviderWindow {
  provider: string;
  resetAt: number;
}

/**
 * Split a spawnable `provider/modelId` candidate into the pair
 * `POST /sessions/:id/model` takes.
 *
 * Undefined for an unqualified id: the daemon route needs a provider, and
 * guessing one would set the session to a model the operator never chose. Only
 * the FIRST slash separates provider from wire id, because providers serve
 * vendor-qualified ids (`commandcode` serves `z-ai/glm-5.3-flash`).
 */
export function splitModelRoute(model: string): ModelRoute | undefined {
  const provider = providerOf(model);
  if (provider === "") return undefined;
  const modelId = model.slice(provider.length + 1);
  if (modelId === "") return undefined;
  return { provider, modelId };
}

/** The routing answer for one session's model. */
export interface ModelRoutePlan {
  /** The model the session is on now, provider-qualified. */
  current: string;
  /** Candidates that are not blocked, in preference order (empty when none can run). */
  available: string[];
  /** Candidates the availability predicate excluded, in preference order. */
  blocked: string[];
  /** True when `current` is itself available, so no switch is needed. */
  currentUsable: boolean;
}

/**
 * Order a session's candidates and split them by current availability.
 *
 * `current` always comes first: the operator's model stays in use while it is
 * healthy, and a switch only happens when its provider (or its exact endpoint)
 * is known to be unable to serve a turn. `candidates` defaults to the class of
 * `current` via `candidatesForModel`, which also keeps an unclassified model as
 * a single-candidate list — an unknown model is attempted as-is rather than
 * silently swapped for something the operator never picked.
 */
export function planModelRoute(input: {
  current: string;
  candidates?: readonly string[];
  isBlocked: (candidate: string) => boolean;
}): ModelRoutePlan {
  const declared = input.candidates ?? candidatesForModel(input.current);
  // `current` may arrive in a spelling the class list does not use (a pinned
  // wire id), so it is prepended explicitly instead of assumed present.
  const ordered = [input.current, ...declared.filter((candidate) => candidate !== input.current)];

  const available: string[] = [];
  const blocked: string[] = [];
  for (const candidate of ordered) {
    if (input.isBlocked(candidate)) blocked.push(candidate);
    else available.push(candidate);
  }

  return {
    current: input.current,
    available,
    blocked,
    currentUsable: available[0] === input.current,
  };
}

/**
 * Human-readable half of a refusal: every provider behind a blocked candidate,
 * once, with the reset window when one is known.
 *
 * Only providers of *blocked* candidates are named: a provider that merely has
 * no candidate in this model's class is not the reason the launch failed, and
 * listing it would send an operator to the wrong dashboard.
 */
export function describeBlockedProviders(input: {
  candidates: readonly string[];
  windows: readonly ProviderWindow[];
  nowMs: number;
}): string {
  const resetAt = new Map<string, number>();
  for (const window of input.windows) {
    const known = resetAt.get(window.provider);
    // Two sources (cooldown store, capacity probe) can describe one provider;
    // the later reset is the one that actually blocks, so it wins.
    if (known === undefined || window.resetAt > known) resetAt.set(window.provider, window.resetAt);
  }

  const named: string[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    const provider = providerOf(candidate);
    if (provider === "" || seen.has(provider)) continue;
    seen.add(provider);
    const until = resetAt.get(provider);
    const suffix =
      until !== undefined && until > input.nowMs
        ? `resets ${new Date(until).toISOString()}`
        : "no reset time";
    named.push(`${provider} (${suffix})`);
  }

  return named.length === 0 ? "no candidate provider is known to be available" : named.join(", ");
}
