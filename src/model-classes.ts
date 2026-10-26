/**
 * Model classes — named capability tiers for Belayd sub-agents.
 *
 * A "class" groups models of comparable capability and cost. When a model hits
 * a quota/credit/rate limit, the harness fails over to the next candidate in
 * the same class (same model on an alternate provider first, then a different
 * model), preserving the capability level the agent role requires.
 *
 * Providers are expanded from a per-model preference order. `llmgateway` is the
 * default primary (per-token billing) and mirrors every model id on the other
 * providers, so the first failover hop is the SAME model id on the alternate
 * provider — identical behavior, different credential/quota bucket.
 * `opencode-go` is the exception preferred provider for `deepseek-v4.1-flash`,
 * whose subscription bucket is far cheaper than per-token for that one model.
 * `openrouter` carries the same models as a last-resort quota bucket, but under
 * vendor-qualified ids (e.g. `z-ai/glm-5.2`), mapped in `PROVIDER_MODEL_IDS`.
 */

export type ModelClass = "frontier" | "standard" | "fast";

/**
 * An agent's model declaration: EITHER an explicit model OR a capability
 * class — never both. The model arm still derives a class via MODEL_TO_CLASS
 * so quota fallback works for explicitly-pinned models.
 */
export type AgentModelSpec =
  | { model: string; modelClass?: never }
  | { model?: never; modelClass: ModelClass };

/**
 * Providers tried for a model id, in preference order, unless the model has an
 * entry in `MODEL_PROVIDER_PREFERENCE`. Kept exported for callers that only
 * need the default order.
 */
export const DEFAULT_PROVIDER_PREFERENCE: readonly string[] = [
  "llmgateway",
  "opencode-go",
  "openrouter",
];

/**
 * @deprecated Use `DEFAULT_PROVIDER_PREFERENCE` or, for a specific model,
 * `providerPreferenceFor(modelId)`. Retained as a re-export of the default so
 * the global order keeps a single source of truth.
 */
export const PROVIDER_PREFERENCE: readonly string[] = DEFAULT_PROVIDER_PREFERENCE;

/**
 * The one model whose opencode-go subscription bucket is far cheaper than
 * per-token billing. Named once and reused by the class spec, the class lookup
 * and the provider override below, so the exemption cannot drift away from the
 * model it exempts.
 */
const SUBSCRIPTION_PREFERRED_MODEL = "deepseek-v4.1-flash";

/**
 * Per-model provider overrides. opencode-go's plan gives that subscription-
 * preferred model generous headroom, so the subscription bucket is reserved for
 * it; every other model bills per-token and stays on llmgateway. Values must
 * stay a permutation of `DEFAULT_PROVIDER_PREFERENCE` (asserted in the tests):
 * the same provider set, only reordered, so no model loses a failover bucket.
 * Exported so the tests can assert over the override keys themselves and catch
 * an override for a model that is not in a class spec.
 */
export const MODEL_PROVIDER_PREFERENCE: Readonly<Record<string, readonly string[]>> = {
  [SUBSCRIPTION_PREFERRED_MODEL]: ["opencode-go", "llmgateway", "openrouter"],
};

/**
 * Provider-specific model ids. Most providers accept the canonical bare id,
 * but OpenRouter only serves vendor-qualified ids, so its entries map a
 * canonical id to the id pi must send (`provider/<suffix>`).
 */
const PROVIDER_MODEL_IDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  openrouter: {
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
    [SUBSCRIPTION_PREFERRED_MODEL]: `deepseek/${SUBSCRIPTION_PREFERRED_MODEL}`,
    "gpt-5.6-luna": "openai/gpt-5.6-luna",
    "glm-5.2": "z-ai/glm-5.2",
    "glm-5.3": "z-ai/glm-5.3",
    "glm-5.3-flash": "z-ai/glm-5.3-flash",
    "mimo-v2.6-flash": "xiaomi/mimo-v2.6-flash",
  },
};

/** The model-id suffix pi expects for `canonicalId` on `provider`. */
function providerModelId(provider: string, canonicalId: string): string {
  return PROVIDER_MODEL_IDS[provider]?.[canonicalId] ?? canonicalId;
}

interface ModelClassSpec {
  name: ModelClass;
  /** Why the grouping exists and how candidates are ordered. */
  rationale: string;
  /** Bare model ids (no provider prefix), ordered by preference within the class. */
  models: string[];
}

/**
 * Model ids below are GATEWAY ids, not official API ids. `deepseek-v4.1-flash`
 * is a provider slug (the official DeepSeek id is `deepseek-flash`), and
 * `deepseek-v4-flash` is retired upstream but still legacy-routed, so it keeps
 * working through the gateways listed in its provider preference order. Both
 * facts, plus the reasoning_content round-trip invariant that bites any adapter
 * talking to api.deepseek.com directly, are recorded in
 * docs/deepseek-provider-notes.md.
 */
export const MODEL_CLASS_SPECS: Record<ModelClass, ModelClassSpec> = {
  frontier: {
    name: "frontier",
    rationale:
      "Ordered by capability then cost: deepseek-v4.1-flash, glm-5.3, gpt-5.6-luna. The first entry is the class primary (frontier's default first choice).",
    models: [SUBSCRIPTION_PREFERRED_MODEL, "glm-5.3", "gpt-5.6-luna"],
  },
  standard: {
    name: "standard",
    rationale:
      "glm-5.3-flash is the class primary (higher capability and far cheaper than the deprecated glm-5.2); gpt-5.6-luna for doc-quality output; deepseek-v4.1-flash as the capability ceiling.",
    models: ["glm-5.3-flash", "gpt-5.6-luna", SUBSCRIPTION_PREFERRED_MODEL],
  },
  fast: {
    name: "fast",
    rationale:
      "mimo-v2.6-flash is the class primary (the direct successor of the deactivated mimo-v2.5, same price and lineage); deepseek-v4-flash; glm-5.3-flash as the capability ceiling.",
    models: ["mimo-v2.6-flash", "deepseek-v4-flash", "glm-5.3-flash"],
  },
};

/** Primary class for each bare model id used by DEFAULT_AGENTS and workflow overrides. */
export const MODEL_TO_CLASS: Record<string, ModelClass> = {
  "mimo-v2.6-flash": "fast",
  "deepseek-v4-flash": "fast",
  "glm-5.3-flash": "standard",
  "glm-5.3": "frontier",
  [SUBSCRIPTION_PREFERRED_MODEL]: "frontier",
  "gpt-5.6-luna": "frontier",
};

/** Strip the provider prefix: "provider/model" → "model", "model" → "model". */
export function bareModelId(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

/** Provider prefix: "provider/model" → "provider", "model" → "". */
export function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? "" : model.slice(0, slash);
}

/**
 * Canonical bare id for any provider-qualified model. Unlike `bareModelId`,
 * this also maps OpenRouter's vendor-qualified ids (`z-ai/glm-5.2`) back to
 * their canonical id (`glm-5.2`) so class lookup and same-model fallback
 * partitioning keep working across every provider.
 */
export function canonicalModelId(model: string): string {
  const provider = providerOf(model);
  const suffix = bareModelId(model);
  const aliases = PROVIDER_MODEL_IDS[provider];
  if (aliases === undefined) return suffix;
  for (const [canonical, qualified] of Object.entries(aliases)) {
    if (qualified === suffix) return canonical;
  }
  return suffix;
}

/** The class a model belongs to, or undefined if unknown. */
export function modelClassOf(model: string): ModelClass | undefined {
  return MODEL_TO_CLASS[canonicalModelId(model)];
}

/**
 * Providers tried for `modelId`, in preference order. Resolved through the
 * canonical id so an OpenRouter vendor-qualified spelling (`deepseek/…`) picks
 * up the same override as the bare id.
 */
export function providerPreferenceFor(modelId: string): readonly string[] {
  return MODEL_PROVIDER_PREFERENCE[canonicalModelId(modelId)] ?? DEFAULT_PROVIDER_PREFERENCE;
}

/**
 * Ordered candidates for a class: each bare id expanded across its own provider
 * preference order, so the model-major / same-id-adjacent invariant holds even
 * when one model in the class prefers a different provider.
 */
export function resolveModelCandidates(modelClass: ModelClass): string[] {
  const { models } = MODEL_CLASS_SPECS[modelClass];
  const candidates: string[] = [];
  for (const id of models) {
    for (const provider of providerPreferenceFor(id)) {
      candidates.push(`${provider}/${providerModelId(provider, id)}`);
    }
  }
  return candidates;
}

/**
 * Candidates for a specific model: the model itself first, then its class's
 * remaining candidates. Unknown models yield a single-candidate list so an
 * unknown model is attempted as-is rather than silently swapped.
 */
export function candidatesForModel(model: string, modelClass?: ModelClass): string[] {
  const resolvedClass = modelClass ?? modelClassOf(model);
  if (!resolvedClass) return [model];

  const primaryCanonicalId = canonicalModelId(model);
  const expanded = resolveModelCandidates(resolvedClass);

  // The class contract: the first failover hop is the SAME model id on the
  // alternate provider (identical behavior, different quota bucket), not a
  // different model on the same provider. `resolveModelCandidates` is
  // model-major, so for a model that is not first in its class the same id can
  // land after a same-provider model. Re-partition so same-id-alternate-provider
  // candidates come first, then the remaining class candidates. Canonicalizing
  // each candidate keeps OpenRouter's vendor-qualified ids grouped with their
  // canonical siblings.
  const sameModelAlternateProvider = expanded.filter(
    (candidate) => candidate !== model && canonicalModelId(candidate) === primaryCanonicalId,
  );
  const otherModels = expanded.filter(
    (candidate) => candidate !== model && canonicalModelId(candidate) !== primaryCanonicalId,
  );

  return [model, ...sameModelAlternateProvider, ...otherModels];
}

/** The class primary: first models entry on that model's first-preference provider. */
export function primaryModelOf(modelClass: ModelClass): string {
  const primaryId = MODEL_CLASS_SPECS[modelClass].models[0];
  const provider = primaryId === undefined ? undefined : providerPreferenceFor(primaryId)[0];
  if (provider === undefined || primaryId === undefined) {
    throw new Error(`model class ${modelClass} has no primary model`);
  }
  return `${provider}/${primaryId}`;
}

/** Resolve a spec into the concrete spawn pair (model + optional class). */
export function resolveModelSpec(spec: AgentModelSpec): {
  model: string;
  modelClass: ModelClass | undefined;
} {
  // The discriminated union's `never` arm guarantees that when this branch
  // runs, `spec` carries no `model` at runtime, so the typeof check falls
  // through to the modelClass arm below.
  if (typeof spec.model === "string") {
    return { model: spec.model, modelClass: modelClassOf(spec.model) };
  }
  return { model: primaryModelOf(spec.modelClass), modelClass: spec.modelClass };
}
