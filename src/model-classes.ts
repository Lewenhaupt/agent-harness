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

/**
 * An agent's model declaration: EITHER an explicit model OR a capability
 * class — never both. The model arm still derives a class via MODEL_TO_CLASS
 * so quota fallback works for explicitly-pinned models.
 */
export type AgentModelSpec =
  | { model: string; modelClass?: never }
  | { model?: never; modelClass: ModelClass };

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
export function candidatesForModel(model: string, modelClass?: ModelClass): string[] {
  const resolvedClass = modelClass ?? modelClassOf(model);
  if (!resolvedClass) return [model];

  const primaryBareId = bareModelId(model);
  const expanded = resolveModelCandidates(resolvedClass);

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
