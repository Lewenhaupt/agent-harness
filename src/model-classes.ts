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
 * identical behavior, different credential/quota bucket.
 */

export type ModelClass = "frontier" | "standard" | "fast";

/** Providers tried for each model id, in preference order. */
export const PROVIDER_PREFERENCE: readonly string[] = ["opencode-go", "llmgateway"];

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
      "Highest-reasoning roles (planner, implementer, doc authoring). Ordered by capability then cost: deepseek-v4-pro (implementer), glm-5.3 (planner), gpt-5.6-luna (doc quality).",
    models: ["deepseek-v4-pro", "glm-5.3", "gpt-5.6-luna"],
  },
  standard: {
    name: "standard",
    rationale:
      "Mid-tier detail work (review, test). glm-5.2 primary; gpt-5.6-luna for doc-quality output; deepseek-v4-pro as the capability ceiling.",
    models: ["glm-5.2", "gpt-5.6-luna", "deepseek-v4-pro"],
  },
  fast: {
    name: "fast",
    rationale:
      "Low-latency/cost recon and proof capture. mimo-v2.5 primary; deepseek-v4-flash; glm-5.2 as the capability ceiling.",
    models: ["mimo-v2.5", "deepseek-v4-flash", "glm-5.2"],
  },
};

/** Primary class for each bare model id used by DEFAULT_AGENTS and workflow overrides. */
export const MODEL_TO_CLASS: Record<string, ModelClass> = {
  "mimo-v2.5": "fast",
  "deepseek-v4-flash": "fast",
  "glm-5.2": "standard",
  "glm-5.3": "frontier",
  "deepseek-v4-pro": "frontier",
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

/** The class a model belongs to, or undefined if unknown. */
export function modelClassOf(model: string): ModelClass | undefined {
  return MODEL_TO_CLASS[bareModelId(model)];
}

/** Ordered candidates for a class: each bare id expanded across providers. */
export function resolveModelCandidates(modelClass: ModelClass): string[] {
  const { models } = MODEL_CLASS_SPECS[modelClass];
  const candidates: string[] = [];
  for (const id of models) {
    for (const provider of PROVIDER_PREFERENCE) {
      candidates.push(`${provider}/${id}`);
    }
  }
  return candidates;
}

/**
 * Candidates for a specific model: the model itself first, then its class's
 * remaining candidates. Unknown models yield a single-candidate list so an
 * unknown model is attempted as-is rather than silently swapped.
 */
export function candidatesForModel(model: string): string[] {
  const modelClass = modelClassOf(model);
  if (!modelClass) return [model];

  const primaryBareId = bareModelId(model);
  const expanded = resolveModelCandidates(modelClass);

  // The class contract: the first failover hop is the SAME model id on the
  // alternate provider (identical behavior, different quota bucket), not a
  // different model on the same provider. `resolveModelCandidates` is
  // model-major, so for a model that is not first in its class the same id can
  // land after a same-provider model. Re-partition so same-id-alternate-provider
  // candidates come first, then the remaining class candidates.
  const sameModelAlternateProvider = expanded.filter(
    (candidate) => candidate !== model && bareModelId(candidate) === primaryBareId,
  );
  const otherModels = expanded.filter(
    (candidate) => candidate !== model && bareModelId(candidate) !== primaryBareId,
  );

  return [model, ...sameModelAlternateProvider, ...otherModels];
}
