/**
 * LLM Gateway models.json mapping — pure functions.
 *
 * Port of `scripts/refresh-llmgateway-models.sh`'s Python mapping block
 * (lines ~96-168). The field mapping mirrors the pi-llmgateway extension's
 * own logic: per-million-token costs from `pricing.prompt`/`completion`/
 * `input_cache_read`/`input_cache_write`, context from `context_length`,
 * maxTokens from family defaults, `compat` everywhere, and a
 * `thinkingLevelMap` on reasoning models.
 *
 * All functions here are pure (no network, no filesystem, no global state).
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface LlmGatewayPricing {
  prompt?: number | string | null;
  completion?: number | string | null;
  input_cache_read?: number | string | null;
  input_cache_write?: number | string | null;
}

export interface LlmGatewayModel {
  id: string;
  name?: string | null;
  family?: string | null;
  context_length?: number | null;
  pricing?: LlmGatewayPricing | null;
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  } | null;
  supported_parameters?: string[] | null;
  providers?: Array<{ reasoning?: boolean | null } | null> | null;
  deactivated_at?: string | null;
}

export interface LlmGatewayApiResponse {
  data?: LlmGatewayModel[] | null;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCompat {
  supportsDeveloperRole: false;
  maxTokensField: "max_tokens";
}

export interface ThinkingLevelMap {
  minimal: null;
  low: null;
  medium: string;
  high: string;
  xhigh: string;
}

export interface GatewayModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  compat: ModelCompat;
  thinkingLevelMap?: ThinkingLevelMap;
}

export interface ModelsJsonDoc {
  providers: {
    llmgateway: {
      baseUrl: "https://api.llmgateway.io/v1";
      api: "openai-completions";
      models: GatewayModelEntry[];
    };
  };
}

// ── Constants (mirror the script's Python dicts) ──────────────────────

const FAMILY_MAX_TOKENS: Readonly<Record<string, number>> = {
  openai: 16384,
  anthropic: 32000,
  google: 32768,
  xai: 32768,
  deepseek: 32768,
  moonshot: 32768,
  alibaba: 16384,
  minimax: 40960,
  glm: 32768,
  meta: 8192,
  mistral: 32768,
  nvidia: 32768,
  bytedance: 32768,
  perplexity: 32768,
  xiaomi: 32768,
  llmgateway: 32768,
};
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_CONTEXT_WINDOW = 131072;

// ── Mapping helpers ───────────────────────────────────────────────────

/**
 * Convert an API price (a per-token string like "0.15e-6") to a
 * per-million-token cost. Non-numeric / missing / zero values map to 0.
 */
function perMillion(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (Number.isNaN(n) || n === 0) return 0;
  return n * 1_000_000;
}

/** Drop the `custom` placeholder, deactivated models, and non-text outputs. */
function isChatModel(model: LlmGatewayModel): boolean {
  if (model.id === "custom") return false;
  const outputs = model.architecture?.output_modalities ?? [];
  if (!outputs.includes("text")) return false;
  if (model.deactivated_at) return false;
  return true;
}

function reasoningSupported(model: LlmGatewayModel): boolean {
  const params = model.supported_parameters ?? [];
  if (params.includes("reasoning") || params.includes("reasoning_effort")) return true;
  return (model.providers ?? []).some((provider) => provider?.reasoning === true);
}

function deriveInput(model: LlmGatewayModel): Array<"text" | "image"> {
  const modalities = model.architecture?.input_modalities ?? [];
  const input: Array<"text" | "image"> = ["text"];
  if (modalities.includes("image")) input.push("image");
  return input;
}

function maxTokensForFamily(family: string | null | undefined): number {
  if (family === null || family === undefined) return DEFAULT_MAX_TOKENS;
  return FAMILY_MAX_TOKENS[family] ?? DEFAULT_MAX_TOKENS;
}

// ── Public API ────────────────────────────────────────────────────────

export function isLlmGatewayApiResponse(value: unknown): value is LlmGatewayApiResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!("data" in record)) return true;
  const data = record.data;
  return data === null || data === undefined || Array.isArray(data);
}

export function mapLlmGatewayModels(apiPayload: LlmGatewayApiResponse): GatewayModelEntry[] {
  const apiModels = apiPayload.data ?? [];
  const models: GatewayModelEntry[] = [];

  for (const model of apiModels) {
    if (!isChatModel(model)) continue;

    const pricing = model.pricing ?? {};
    const reasoning = reasoningSupported(model);
    const entry: GatewayModelEntry = {
      id: model.id,
      name: model.name || model.id,
      reasoning,
      input: deriveInput(model),
      cost: {
        input: perMillion(pricing.prompt),
        output: perMillion(pricing.completion),
        cacheRead: perMillion(pricing.input_cache_read),
        cacheWrite: perMillion(pricing.input_cache_write),
      },
      contextWindow: model.context_length || DEFAULT_CONTEXT_WINDOW,
      maxTokens: maxTokensForFamily(model.family),
      compat: {
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
      },
    };
    if (reasoning) {
      entry.thinkingLevelMap = {
        minimal: null,
        low: null,
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
      };
    }
    models.push(entry);
  }

  return models;
}

export function buildLlmGatewayModelsDoc(models: readonly GatewayModelEntry[]): ModelsJsonDoc {
  return {
    providers: {
      llmgateway: {
        baseUrl: "https://api.llmgateway.io/v1",
        api: "openai-completions",
        models: [...models],
      },
    },
  };
}

export function serializeModelsJsonDoc(doc: ModelsJsonDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Summarize id-level additions/removals between two model docs. */
export function diffModelsDoc(before: ModelsJsonDoc | undefined, after: ModelsJsonDoc): string {
  const beforeModels = before?.providers.llmgateway.models ?? [];
  const afterModels = after.providers.llmgateway.models;
  const beforeIds = new Set(beforeModels.map((model) => model.id));
  const afterIds = new Set(afterModels.map((model) => model.id));
  const added = afterModels.filter((model) => !beforeIds.has(model.id)).length;
  const removed = beforeModels.filter((model) => !afterIds.has(model.id)).length;
  if (added === 0 && removed === 0) return "no change";
  return `added ${added}, removed ${removed}`;
}

/**
 * Extract the llmgateway api_key from auth.json text. Only the
 * `{ type: "api_key", key }` shape is honored; every parse/shape error
 * yields undefined (auth.json is optional and user-edited).
 */
export function parseLlmGatewayApiKeyFromAuthJson(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const gateway = (parsed as Record<string, unknown>).llmgateway;
    if (typeof gateway !== "object" || gateway === null) return undefined;
    const entry = gateway as Record<string, unknown>;
    if (entry.type !== "api_key") return undefined;
    const key = entry.key;
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}
