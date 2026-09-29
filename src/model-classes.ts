/**
 * Model classes — named capability tiers for Belayd sub-agents.
 *
 * A "class" groups models of comparable capability and cost. When a model hits
 * a quota/credit/rate limit, the harness fails over to the next candidate in
 * the same class (same model on an alternate provider first, then a different
 * model), preserving the capability level the agent role requires.
 *
 * Providers are expanded from a preference order: `opencode-go` is the primary
 * (cheap, fast) provider and `llmgateway` mirrors every opencode-go model id,
 * so the first failover hop is the SAME model id on the alternate provider —
 * identical behavior, different credential/quota bucket. `openrouter` carries
 * the same models as a last-resort quota bucket, but under vendor-qualified
 * ids (e.g. `z-ai/glm-5.2`), mapped in `PROVIDER_MODEL_IDS`.
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

/** Providers tried for each model id, in preference order. */
export const PROVIDER_PREFERENCE: readonly string[] = ["opencode-go", "llmgateway", "openrouter"];

/**
 * Provider-specific model ids. Most providers accept the canonical bare id,
 * but OpenRouter only serves vendor-qualified ids, so its entries map a
 * canonical id to the id pi must send (`provider/<suffix>`).
 */
const PROVIDER_MODEL_IDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  openrouter: {
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
    "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
    "gpt-5.6-luna": "openai/gpt-5.6-luna",
    "glm-5.2": "z-ai/glm-5.2",
    "glm-5.3": "z-ai/glm-5.3",
    "mimo-v2.5": "xiaomi/mimo-v2.5",
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

export const MODEL_CLASS_SPECS: Record<ModelClass, ModelClassSpec> = {
  frontier: {
    name: "frontier",
    rationale:
      "Ordered by capability then cost: deepseek-v4.1-flash, glm-5.3, gpt-5.6-luna. The first entry is the class primary (frontier's default first choice).",
    models: ["deepseek-v4.1-flash", "glm-5.3", "gpt-5.6-luna"],
  },
  standard: {
    name: "standard",
    rationale:
      "glm-5.2 is the class primary; gpt-5.6-luna for doc-quality output; deepseek-v4.1-flash as the capability ceiling.",
    models: ["glm-5.2", "gpt-5.6-luna", "deepseek-v4.1-flash"],
  },
  fast: {
    name: "fast",
    rationale:
      "mimo-v2.5 is the class primary; deepseek-v4-flash; glm-5.2 as the capability ceiling.",
    models: ["mimo-v2.5", "deepseek-v4-flash", "glm-5.2"],
  },
};

/** Primary class for each bare model id used by DEFAULT_AGENTS and workflow overrides. */
export const MODEL_TO_CLASS: Record<string, ModelClass> = {
  "mimo-v2.5": "fast",
  "deepseek-v4-flash": "fast",
  "glm-5.2": "standard",
  "glm-5.3": "frontier",
  "deepseek-v4.1-flash": "frontier",
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

/** Ordered candidates for a class: each bare id expanded across providers. */
export function resolveModelCandidates(modelClass: ModelClass): string[] {
  const { models } = MODEL_CLASS_SPECS[modelClass];
  const candidates: string[] = [];
  for (const id of models) {
    for (const provider of PROVIDER_PREFERENCE) {
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

/** The class primary: first models entry on the first-preference provider. */
export function primaryModelOf(modelClass: ModelClass): string {
  const provider = PROVIDER_PREFERENCE[0];
  const primaryId = MODEL_CLASS_SPECS[modelClass].models[0];
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
