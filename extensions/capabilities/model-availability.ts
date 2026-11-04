/**
 * The one answer to "can this provider serve a turn right now?" (bd-229, bd-257).
 *
 * Three call sites ask it, and until bd-257 each kept its own copy of the
 * predicate, the window merge and the switch loop:
 *
 * - the launch pre-flight, before a child session is created
 *   (`extensions/capabilities/launch.ts`),
 * - the in-session recovery boundary, after a turn already failed
 *   (`extensions/capabilities/model-recovery.ts`), and
 * - the session pre-flight, before a plain pi-web session's first turn
 *   (`extensions/capabilities/session-model-routing.ts`).
 *
 * A copy that drifts is a routing decision made against a different store than
 * the spawn loop uses, which is exactly the class of bug bd-229 and bd-234
 * fixed. So the predicate, the reset-window merge, the store refresh and the
 * `pi.setModel` loop live here once.
 *
 * Signal freshness (bd-237/bd-256): routing reads the shared `ModelStateStore`
 * (SQLite, one cooldown truth) plus the capacity cache. The retired JSON file is
 * only a one-time import source for that store. Reads are live — `cooldownScope`
 * and `entries` query `listCooldowns` on every call — so freshness here is about
 * the capacity signal and about dropping the store's cached dispatch view, not
 * about making another process's cooldown visible.
 *
 * No side effects at import, no module-level state: the store and the cache are
 * supplied by the caller.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapacityCache } from "../../src/capacity-cache.js";
import type { ModelCooldownStore } from "../../src/model-cooldown.js";
import { type ProviderWindow, splitModelRoute } from "../../src/orchestrator-model.js";

/** The routing state every availability decision reads. */
export interface ModelAvailabilityRouting {
  cooldownStore: ModelCooldownStore;
  /** Optional: the in-session path may run beside a store without a capacity probe. */
  capacity?: CapacityCache;
}

/**
 * True when a candidate's provider (or its exact endpoint) is known to be unable
 * to serve a turn: a reactive cooldown mark from an earlier failure, or a
 * pre-dispatch capacity window.
 *
 * Cooldown first: a provider-scoped cooldown is the cheaper and more certain
 * answer, and the capacity cache may lag behind it by its TTL.
 */
export function candidateBlocked(routing: ModelAvailabilityRouting, candidate: string): boolean {
  if (routing.cooldownStore.cooldownScope(candidate) !== undefined) return true;
  return routing.capacity?.isModelExhausted(candidate) ?? false;
}

/**
 * Reset windows from both sources, so a refusal can name when a provider is
 * back. The cooldown store is the reactive record; the capacity cache adds a
 * configured usage endpoint's view of the same provider.
 */
export function exhaustionWindows(routing: ModelAvailabilityRouting): ProviderWindow[] {
  const windows: ProviderWindow[] = [];
  for (const [provider, entry] of routing.cooldownStore.providerEntries()) {
    windows.push({ provider, resetAt: entry.until });
  }
  windows.push(...(routing.capacity?.windows() ?? []));
  return windows;
}

/**
 * How much of the availability signal a caller is willing to pay for.
 */
export interface RefreshModelAvailabilityOptions {
  /**
   * Permit the usage endpoint probe when the cache is stale.
   *
   * `refreshIfStale` is TTL-gated, so this permits a probe rather than forcing
   * one. Opt-in because the probe is bounded by
   * `DEFAULT_CAPACITY_PROBE_TIMEOUT_MS` (two seconds when a probe URL is
   * configured) and the in-session recovery path may not add that latency to a
   * run that can only continue once.
   */
  probeCapacity?: boolean;
}

/**
 * Bring the shared signals up to date before a routing decision.
 *
 * What this actually does since bd-256, so no caller is tempted to read a
 * causality into it that the store no longer has:
 *
 * - `refresh()` clears the store's per-key `cooldownFor` read cache — the view
 *   the bd-187 wrapper's dispatch pre-check uses. Routing itself never touches
 *   that cache: `cooldownScope`/`entries`/`providerEntries` are uncached
 *   `listCooldowns` queries, so a cooldown another fleet member persisted is
 *   already visible here.
 * - `prune()` is garbage collection of expired rows; expired rows are invisible
 *   to every reader either way.
 * - the capacity probe is opt-in (see below) and is the one part that can change
 *   a decision on its own.
 *
 * The capacity probe is opt-in because the two kinds of caller have different
 * budgets. `refreshIfStale` is TTL-gated (five minutes by default), so opting in
 * permits a probe when the cache is stale rather than forcing one. Pre-flights
 * (launch, session start) run once per session, so they may take a stale-cache
 * probe before committing to a model. In-session recovery is a one-shot
 * continuation after a failed turn: there it must not add probe latency, and it
 * judges candidates against the cache it already has.
 */
export async function refreshModelAvailability(
  routing: ModelAvailabilityRouting,
  options?: RefreshModelAvailabilityOptions,
): Promise<void> {
  routing.cooldownStore.refresh();
  routing.cooldownStore.prune();
  if (options?.probeCapacity === true) await routing.capacity?.refreshIfStale();
}

/** The session's current model as `provider/modelId`, or undefined when it has none. */
export function currentModelId(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  return model === undefined ? undefined : `${model.provider}/${model.id}`;
}

/**
 * Set the first candidate the session can actually run, and return its id.
 *
 * `pi.setModel` answers false when the provider has no credential, and the
 * session may be scoped to a subset of models, so the first available candidate
 * is not always settable — each rejection falls through to the next instead of
 * failing the whole routing decision.
 *
 * The accepted model is recorded by pi in the session transcript
 * (`appendModelChange`), so it survives a restart without rewriting the
 * operator's global default.
 */
export async function switchToFirstUsableModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const route = splitModelRoute(candidate);
    if (route === undefined) continue;
    const model = ctx.modelRegistry.find(route.provider, route.modelId);
    if (model === undefined) continue;
    if (await pi.setModel(model)) return candidate;
  }
  return undefined;
}
