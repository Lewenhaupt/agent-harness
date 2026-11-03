/**
 * In-session model recovery (bd-229).
 *
 * `spawn-with-fallback` re-spawns a *subprocess* on another provider when its
 * model fails. A session the harness did not spawn has no such wrapper: the
 * orchestrator (and the human session that launched it) runs on whatever model
 * pi chose, so a `402 … "code":"billing_error"` on its own turn simply ended the
 * turn — with the workflow gate armed and no phase ever started.
 *
 * This capability closes that hole inside the session itself:
 *
 * - `message_end` classifies the assistant error with the shared
 *   `classifyAssistantMessage` rules, so a failure the spawn path treats as
 *   fallback-worthy is recognized here instead of being a dead end. The verdict
 *   is also persisted as a cooldown (provider-scoped for quota), which is what
 *   makes a later phase spawn skip the dead provider.
 * - `agent_before_settle` is the actionable boundary after an errored run
 *   (docs/extensions.md: a boundary handler may "ensure one next provider
 *   request"), so that is where the model is switched and `continue: true`
 *   re-drives the same run on the new provider.
 *
 * Phase sub-agents are deliberately excluded: their model choice and their
 * fallback accounting belong to `spawn-with-fallback`, and a silent in-session
 * switch would make the attempt record and the telemetry name a model that the
 * session did not actually finish on.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapacityCache } from "../../src/capacity-cache.js";
import { providerOf } from "../../src/model-classes.js";
import type { ModelCooldownStore } from "../../src/model-cooldown.js";
import { planModelRoute, splitModelRoute } from "../../src/orchestrator-model.js";
import type { FailureClassification } from "../../src/quota-failure.js";
import { classifyAssistantMessage, isFallbackWorthy } from "../../src/quota-failure.js";
import { recordFailureCooldown } from "../../src/spawn-with-fallback.js";

/**
 * How many model switches one session may make.
 *
 * A quota failure is not always the same provider twice: a workflow can outlive
 * one bucket and then find the next one spent too. The cap exists only so a
 * provider that answers `402` for every model cannot keep one session retrying
 * forever — each switch burns a real failed request.
 */
const MAX_SWITCHES_PER_SESSION = 3;

/** Model-routing seams the composer owns (bd-116 session state). */
export interface ModelRecoveryRouting {
  cooldownStore: ModelCooldownStore;
  capacity?: CapacityCache;
  /** `BELAYD_MODEL_FALLBACK=0` opts out of every routing decision, including this one. */
  enabled: boolean;
}

/** Everything the recovery capability needs from its host. */
export interface ModelRecoveryDeps {
  pi: ExtensionAPI;
  routing: ModelRecoveryRouting;
  /** True for a phase sub-agent session, whose fallback loop lives in the spawner. */
  isSubAgent: (ctx: ExtensionContext) => boolean;
  /** Reports the switch to the operator; defaults to the harness log sink. */
  notify?: (text: string, level: "info" | "warning") => void;
}

/** Per-registration (per-session) recovery state; never module-level. */
interface RecoveryState {
  /** The classified failure awaiting the settle boundary, if any. */
  pending?: FailureClassification;
  /** Models this session has already run on, so a switch never revisits one. */
  tried: Set<string>;
  switches: number;
}

export function registerModelRecovery(deps: ModelRecoveryDeps): void {
  const { pi, routing } = deps;
  const state: RecoveryState = { tried: new Set(), switches: 0 };

  pi.on("message_end", (event, ctx) => {
    if (!routing.enabled) return;
    const classification = classifyAssistantMessage(event.message);
    if (classification === undefined || !isFallbackWorthy(classification.kind)) {
      // A successful turn (or an unfixable failure: auth, bad request) clears the
      // pending verdict so a later settle cannot act on a stale one.
      state.pending = undefined;
      return;
    }
    state.pending = classification;

    // Persist the verdict now, not at the boundary: a provider that just answered
    // `402` must be skipped by the next phase spawn even if this session cannot
    // switch (no candidate left, no credential for the alternative).
    const model = currentModelId(ctx);
    if (model === undefined) return;
    state.tried.add(model);
    recordFailureCooldown(routing.cooldownStore, model, providerOf(model), classification);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const classification = state.pending;
    state.pending = undefined;
    if (classification === undefined || !routing.enabled) return;
    if (deps.isSubAgent(ctx)) return;
    if (event.continue || !event.context.canContinue) return;
    if (state.switches >= MAX_SWITCHES_PER_SESSION) return;

    const current = currentModelId(ctx);
    if (current === undefined) return;
    state.tried.add(current);

    // A provider another fleet member cooled after this store was created must
    // be blocked before the switch target is chosen: the capacity TTL can hide
    // it, and switching onto it spends the one continuation on a dead provider
    // (bd-234). Unbounded refresh: this decision has one shot per turn.
    routing.cooldownStore.refresh();
    routing.cooldownStore.prune();

    // Candidates the session already ran on are blocked too: the cooldown store
    // may not know them yet when the failure was endpoint-scoped, and retrying
    // the model that just failed would spend a request to relearn the same thing.
    const plan = planModelRoute({
      current,
      isBlocked: (candidate) => state.tried.has(candidate) || isBlocked(deps, candidate),
    });

    const switched = await switchToFirstUsable(deps, ctx, plan.available);
    if (switched === undefined) return;

    state.switches += 1;
    state.tried.add(switched);
    const note =
      `Model ${current} could not serve this turn (${classification.kind}); ` +
      `continuing on ${switched}.`;
    (deps.notify ?? logNotice)(note, "warning");
    // One continuation: pi makes exactly one more provider request on the new
    // model. `switched` is recorded above, so a repeated failure takes the next
    // candidate rather than looping on this one. The custom message is how the
    // model learns why the run is continuing on a different provider; it is a
    // boundary draft rather than `pi.sendMessage` so it lands in the same
    // continuation instead of queuing an extra turn.
    return {
      entries: [
        {
          type: "custom_message",
          customType: "belayd-model-recovery",
          content: note,
          display: true,
        },
      ],
      continue: true,
    };
  });
}

/** Default notice sink: the harness log, so the switch is visible without a UI. */
function logNotice(text: string, level: "info" | "warning"): void {
  const line = `[belayd-harness] ${text}`;
  if (level === "warning") console.warn(line);
  else console.log(line);
}

/** True when the candidate's provider or endpoint is known to be unable to serve. */
function isBlocked(deps: ModelRecoveryDeps, candidate: string): boolean {
  if (deps.routing.cooldownStore.cooldownScope(candidate) !== undefined) return true;
  return deps.routing.capacity?.isModelExhausted(candidate) ?? false;
}

/**
 * Set the first candidate the session can actually run, and return its id.
 *
 * `pi.setModel` answers false when the provider has no credential, and the
 * session may be scoped to a subset of models, so the first available candidate
 * is not always settable — each rejection falls through to the next instead of
 * failing the whole recovery.
 */
async function switchToFirstUsable(
  deps: ModelRecoveryDeps,
  ctx: ExtensionContext,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const route = splitModelRoute(candidate);
    if (route === undefined) continue;
    const model = ctx.modelRegistry.find(route.provider, route.modelId);
    if (model === undefined) continue;
    if (await deps.pi.setModel(model)) return candidate;
  }
  return undefined;
}

/** The session's current model as `provider/modelId`, or undefined when it has none. */
function currentModelId(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  return model === undefined ? undefined : `${model.provider}/${model.id}`;
}
