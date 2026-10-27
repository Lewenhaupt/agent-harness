/**
 * Quota/credit/rate-limit failure classification.
 *
 * The harness spawns pi as a subprocess and historically watched exit code +
 * stderr. Empirically (bd-16 prototype) a quota/credit failure does NOT
 * surface that way: pi exits 0, stderr is empty, and the failure is only in
 * the structured `message_end` event (role=assistant, stopReason="error",
 * errorMessage="429: {...}"). This classifier reads `SpawnDetails` and returns
 * a discriminated union; the fallback loop asks `isFallbackWorthy` which kinds
 * justify trying the next candidate.
 *
 * The `unavailable` kind exists because a deactivated/unknown model id is a
 * *fourth* failure mode that neither quota nor transient covers, and it used to
 * be the most expensive one: llmgateway answered `410: ... has been deactivated
 * and is no longer available` for `mimo-v2.5`, the classifier fell through to
 * "other", and the fallback loop stopped — failing a whole phase even though
 * the next candidate was healthy. Provider catalogs go stale (pi keeps serving
 * a retired id from its cached model list), so this must be detected from the
 * response, not from the catalog.
 *
 * Status codes and network-error signatures harvested from
 * @pedro_klein/pi-gateway's detect.ts.
 *
 * A quota failure's suggested cooldown is resolved by `resolveQuotaCooldown`: a
 * provider reset hint ("Resets in 7hr 57min") wins, provider subscription
 * usage-limit wording without a hint gets the long
 * `DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS` window, and everything else
 * falls back to `DEFAULT_QUOTA_COOLDOWN_SECONDS`. The resolver also reports
 * whether a hint produced the value, which is what tells the cooldown store's
 * mark path apart from its escalate path.
 */

import type { SpawnDetails } from "./agent-registry.js";

export type FailureKind =
  | "success"
  | "quota"
  | "transient"
  /** The model id is retired/unknown/not servable at this endpoint. */
  | "unavailable"
  | "auth"
  | "other";

export interface FailureClassification {
  kind: FailureKind;
  /** Model id reported by the failing event, if any. */
  model?: string;
  /** Human-readable reason for the classification. */
  reason?: string;
  /** Suggested cooldown, when the kind is retryable elsewhere (quota/transient/unavailable). */
  cooldownSeconds?: number;
  /**
   * True when `cooldownSeconds` is an authoritative provider-supplied window
   * (parsed from a "Resets in ..." hint) rather than a harness guess.
   *
   * The cooldown store uses this to decide between *replacing* a window and
   * *escalating* one: only a guess is repeat-escalated, because re-guessing the
   * same span against a provider that is still exhausted is exactly the
   * wasted-spawn loop this distinction exists to stop.
   */
  cooldownHinted?: boolean;
}

/** Default cooldown when a quota failure has no parseable reset hint. */
export const DEFAULT_QUOTA_COOLDOWN_SECONDS = 15 * 60;
/**
 * Cooldown for an unhinted *provider* usage-limit failure (e.g. opencode-go's
 * `GoUsageLimitError`).
 *
 * These are weekly/monthly subscription buckets, not per-minute rate limits: a
 * body that says "Go usage limit exceeded" with no reset hint cannot plausibly
 * clear in the 15-minute default. Fifteen minutes was actively harmful — the
 * provider was re-probed every quarter hour, and each premature probe spawned a
 * real `-fallback-N` session that burned budget rediscovering the same
 * exhaustion (bd-38 fleet evidence: three members, three wasted sessions).
 *
 * Six hours is deliberately conservative: long enough to stop the re-probe
 * churn within a workflow, short enough that a limit which does reset earlier is
 * picked up the same working day. Renewed unhinted failures escalate from here,
 * and any parsed reset hint always wins over this value.
 */
export const DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS = 6 * 60 * 60;
/** Cooldown for transient network/service failures. */
export const DEFAULT_TRANSIENT_COOLDOWN_SECONDS = 5 * 60;
/**
 * Cooldown for a provider entitlement failure (a 403 carrying subscription
 * wording). Shorter than the quota default so a newly purchased subscription
 * is picked up quickly, while still long enough to stop re-hitting a provider
 * that cannot serve the caller at all.
 */
export const DEFAULT_ENTITLEMENT_COOLDOWN_SECONDS = 10 * 60;
/**
 * Cooldown for a model the endpoint refuses as retired/unknown. Long on
 * purpose: a deactivated id does not come back, so the point is to stop
 * re-trying it on every spawn instead of re-discovering the 410. Endpoint-
 * scoped (never provider-scoped) because the same bare id is usually still
 * served by another gateway.
 *
 * Not permanent: an operator who re-pins the id after a provider rollback, or a
 * provider that undeactivates it, must recover without editing a state file, so
 * the entry expires and the model is probed again.
 */
export const DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS = 6 * 60 * 60;

/** Status codes indicating a capacity/quota/credit/rate limit. */
const QUOTA_STATUS_CODES = new Set([402, 429]);
/** Status codes indicating a transient service failure. */
const TRANSIENT_STATUS_CODES = new Set([408, 425, 500, 502, 503, 504]);
/**
 * Status codes indicating an auth problem — not solved by switching models.
 * A 403 whose body carries provider-entitlement wording is handled as a
 * provider-scoped quota failure before this branch runs.
 */
const AUTH_STATUS_CODES = new Set([401, 403]);

/**
 * Status codes meaning "this model id is not servable at this endpoint": 404
 * (unknown model) and 410 (retired/deactivated). Both are endpoint-scoped and
 * permanent for that id, so switching candidate is the only fix.
 */
const MODEL_UNAVAILABLE_STATUS_CODES = new Set([404, 410]);

/** Statusless network-error signatures (matches pi-gateway detect.ts). */
const NETWORK_ERROR_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|connection reset|service unavailable/i;

/**
 * Wording that identifies a retired/unknown/not-servable model id, whatever
 * status code carries it. Observed live:
 *
 * - `410: ... Model mimo-v2.5 has been deactivated and is no longer available`
 *   (llmgateway, retired id)
 * - `400: ... Requested model no-such-model-xyz not supported` (llmgateway)
 * - `400: ... no-such-model-xyz is not a valid model ID` (openrouter)
 *
 * Both 400 bodies must not be mistaken for a generic bad request: the request
 * shape was fine, the model id is what the endpoint rejects.
 */
const MODEL_UNAVAILABLE_PATTERN =
  /deactivated|no longer available|not a valid model|invalid model|model not found|model_not_found|unknown model|unsupported model|model\b[^\n]{0,80}?not (?:supported|found|available|valid)|does not exist|has been retired|retired model|model is not available/i;

/**
 * Quota/credit wording used when a body carries no status code at all (a
 * gateway that reports the limit inside a 200-shaped error, or pi surfacing the
 * upstream message without the status prefix).
 */
const QUOTA_WORDING_PATTERN =
  /usage limit|quota|insufficient (?:credit|credits|funds|balance|quota)|credit balance|rate limit|too many requests|billing/i;

/**
 * Wording that identifies a *provider subscription* usage limit rather than a
 * short-lived rate limit. Observed live from opencode-go:
 *
 * - `429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 7hr 57min. ..."}`
 * - `429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}`
 *
 * The second body carries no reset hint, which is why the class needs its own
 * (long) fallback instead of the generic 15-minute default.
 */
const PROVIDER_USAGE_LIMIT_PATTERN =
  /gousagelimiterror|usage limit (?:exceeded|reached|hit)|"?(?:weekly|monthly|daily) (?:usage )?limit\b/i;

/**
 * Gateway-side rejection wording in 400 bodies that is scoped to one model's
 * routing/availability rather than to the caller's request shape. A generic 400
 * is treated as a config error (unfixable by switching models), but these
 * signatures mean "this model is not servable right now" — the next candidate
 * on another provider/model can succeed, so the fallback loop should retry.
 */
const GATEWAY_REJECTION_PATTERN = /invalid_value|invalid_request_error|request was rejected/i;

/**
 * Provider-entitlement wording carried in 403 bodies, e.g. "An active OpenCode
 * Go subscription is required to use Go models." Such a 403 is scoped to one
 * provider rather than to the caller's credentials, so the fallback loop must
 * cool that provider down and continue instead of stopping.
 */
const PROVIDER_ENTITLEMENT_PATTERN =
  /subscription|not subscribed|entitlement|required to use|upgrade/i;

/**
 * Classify a spawn result into one of the failure kinds.
 *
 * Pure — reads only the passed-in details and returns a value.
 */
export function classifySpawnFailure(details: SpawnDetails): FailureClassification {
  const assistant = lastAssistantMessage(details.messages);

  // No assistant error event: either clean success, or a failure that never
  // reached a model turn (startup/config error, provider refusing the request
  // before the stream). An exit-0 run with no assistant turn is NOT handled
  // here: `classifyRunOutcome` owns the "did this run do phase work" verdict,
  // and treating it as a retryable failure here would re-spawn candidates on
  // every empty synthetic result.
  if (!assistant || assistant.stopReason !== "error") {
    if (details.exitCode !== 0) {
      return classifyProcessFailure(details);
    }
    return { kind: "success" };
  }

  const status = extractStatus(assistant);
  const model = typeof assistant.model === "string" ? assistant.model : details.model;
  const errorMessage =
    typeof assistant.errorMessage === "string" ? assistant.errorMessage : undefined;

  return classifyAssistantError(status, model, errorMessage);
}

/**
 * Classify a non-zero exit that produced no assistant error event, using the
 * stderr the child wrote. Signature-first: an exit code alone says nothing about
 * whether another candidate could succeed.
 */
function classifyProcessFailure(details: SpawnDetails): FailureClassification {
  const stderr = details.stderr ?? "";
  const model = details.model;

  if (NETWORK_ERROR_PATTERN.test(stderr)) {
    return {
      kind: "transient",
      model,
      reason: "Process exited non-zero after a network error.",
      cooldownSeconds: DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
    };
  }
  if (MODEL_UNAVAILABLE_PATTERN.test(stderr)) {
    return {
      kind: "unavailable",
      model,
      reason: "Process exited non-zero on a retired/unknown model id.",
      cooldownSeconds: DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS,
    };
  }
  if (QUOTA_WORDING_PATTERN.test(stderr)) {
    return {
      kind: "quota",
      model,
      reason: "Process exited non-zero on a quota/rate-limit message.",
      ...resolveQuotaCooldown(stderr),
    };
  }

  return {
    kind: "other",
    reason: "Process exited non-zero without an assistant error event (startup or config failure).",
  };
}

/**
 * A classification without the `model` field, which the caller fills in once.
 * Rules stay single-purpose so none of them grows past the complexity budget.
 */
type ClassificationRule = (
  status: number | undefined,
  errorMessage: string | undefined,
) => Omit<FailureClassification, "model"> | undefined;

/** 402/429: the credential's quota bucket is spent. */
const quotaStatusRule: ClassificationRule = (status, errorMessage) => {
  if (status === undefined || !QUOTA_STATUS_CODES.has(status)) return undefined;
  return {
    kind: "quota",
    reason: `Quota/credit/rate limit (HTTP ${status}).`,
    ...resolveQuotaCooldown(errorMessage),
  };
};

/** A 403 carrying subscription wording: the provider, not the credentials, is the problem. */
const providerEntitlementRule: ClassificationRule = (status, errorMessage) => {
  if (status !== 403 || errorMessage === undefined) return undefined;
  if (!PROVIDER_ENTITLEMENT_PATTERN.test(errorMessage)) return undefined;
  return {
    kind: "quota",
    reason: `Provider entitlement failure (HTTP ${status}).`,
    cooldownSeconds: DEFAULT_ENTITLEMENT_COOLDOWN_SECONDS,
  };
};

/** A bare 401/403: switching models would only hide a credentials problem. */
const authRule: ClassificationRule = (status) => {
  if (status === undefined || !AUTH_STATUS_CODES.has(status)) return undefined;
  return { kind: "auth", reason: `Authentication/authorization failure (HTTP ${status}).` };
};

/**
 * A model id this endpoint will not serve: 404/410, or wording that says so at
 * any status (a 400 "not supported" body is about the model, not the request).
 */
const modelUnavailableRule: ClassificationRule = (status, errorMessage) => {
  const statusSaysUnavailable = status !== undefined && MODEL_UNAVAILABLE_STATUS_CODES.has(status);
  const wordingSaysUnavailable =
    errorMessage !== undefined && MODEL_UNAVAILABLE_PATTERN.test(errorMessage);
  if (!statusSaysUnavailable && !wordingSaysUnavailable) return undefined;
  return {
    kind: "unavailable",
    reason: `Model not servable at this endpoint${status !== undefined ? ` (HTTP ${status})` : ""}.`,
    cooldownSeconds: DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS,
  };
};

/** 408/425/5xx: the endpoint is briefly unhealthy. */
const transientStatusRule: ClassificationRule = (status) => {
  if (status === undefined || !TRANSIENT_STATUS_CODES.has(status)) return undefined;
  return {
    kind: "transient",
    reason: `Transient service failure (HTTP ${status}).`,
    cooldownSeconds: DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
  };
};

/** Statusless network signature. */
const networkErrorRule: ClassificationRule = (status, errorMessage) => {
  if (status !== undefined || errorMessage === undefined) return undefined;
  if (!NETWORK_ERROR_PATTERN.test(errorMessage)) return undefined;
  return {
    kind: "transient",
    reason: "Network error.",
    cooldownSeconds: DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
  };
};

/** Quota/credit wording in a body that carries no status code. */
const quotaWordingRule: ClassificationRule = (status, errorMessage) => {
  if (status !== undefined || errorMessage === undefined) return undefined;
  if (!QUOTA_WORDING_PATTERN.test(errorMessage)) return undefined;
  return {
    kind: "quota",
    reason: "Quota/credit/rate limit reported without a status code.",
    ...resolveQuotaCooldown(errorMessage),
  };
};

/** A 400 the gateway scoped to its own routing rather than to the request shape. */
const gatewayRejectionRule: ClassificationRule = (status, errorMessage) => {
  if (status !== 400 || errorMessage === undefined) return undefined;
  if (!GATEWAY_REJECTION_PATTERN.test(errorMessage)) return undefined;
  return {
    kind: "transient",
    reason: "Gateway model-routing rejection (HTTP 400).",
    cooldownSeconds: DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
  };
};

/**
 * Ordered rules; the first match wins. Order matters: a quota status must beat
 * model wording (a 429 body can mention the model), and auth must beat
 * unavailable (a 403 body can mention a model name without it being retired).
 */
const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  quotaStatusRule,
  providerEntitlementRule,
  authRule,
  modelUnavailableRule,
  transientStatusRule,
  networkErrorRule,
  quotaWordingRule,
  gatewayRejectionRule,
];

/** Classify an assistant `message_end` error by its HTTP status / network signature. */
function classifyAssistantError(
  status: number | undefined,
  model: string | undefined,
  errorMessage: string | undefined,
): FailureClassification {
  for (const rule of CLASSIFICATION_RULES) {
    const matched = rule(status, errorMessage);
    if (matched !== undefined) return { ...matched, model };
  }

  return {
    kind: "other",
    model,
    reason: `Unrecognized failure (stopReason=error${status !== undefined ? `, HTTP ${status}` : ""}).`,
  };
}

/**
 * True when trying the next candidate is the right response to this kind.
 *
 * One exhaustive switch instead of a predicate composed of negative checks:
 * adding a `FailureKind` arm makes TypeScript flag every place that must decide,
 * which is exactly the bug that made a 410 stop the fallback loop.
 */
export function isFallbackWorthy(kind: FailureKind): boolean {
  switch (kind) {
    case "quota":
    case "transient":
    case "unavailable":
      return true;
    case "success":
    case "auth":
    case "other":
      return false;
  }
}

/**
 * The cooldown a quota failure deserves, plus whether a provider reset hint
 * produced it — the store needs the second half to decide mark-vs-escalate.
 */
export interface QuotaCooldown {
  cooldownSeconds: number;
  cooldownHinted: boolean;
}

/**
 * The single place that decides a quota failure's cooldown: a parsed provider
 * reset hint wins, an unhinted provider usage-limit body gets the long provider
 * window, everything else falls back to the generic default. Pure, so the
 * three-way rule (and the hinted flag every caller needs) is testable alone.
 *
 * Resolved once per classification: the reset-hint regex runs here and nowhere
 * else, so the three quota paths (status, wording, stderr) cannot drift apart.
 */
export function resolveQuotaCooldown(errorMessage?: string): QuotaCooldown {
  const hinted = parseQuotaResetSeconds(errorMessage);
  if (hinted !== undefined) return { cooldownSeconds: hinted, cooldownHinted: true };
  if (errorMessage !== undefined && PROVIDER_USAGE_LIMIT_PATTERN.test(errorMessage)) {
    return {
      cooldownSeconds: DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS,
      cooldownHinted: false,
    };
  }
  return { cooldownSeconds: DEFAULT_QUOTA_COOLDOWN_SECONDS, cooldownHinted: false };
}

/** Parse "Resets in 2d 3h 45m"-style hints into total seconds, if present. */
export function parseQuotaResetSeconds(errorMessage?: string): number | undefined {
  if (!errorMessage) return undefined;
  const match =
    /resets in\s+(?:(\d+)\s*(?:d|day|days))?\s*(?:(\d+)\s*(?:hr|h|hour|hours))?\s*(?:(\d+)\s*(?:min|m|minute|minutes))?/i.exec(
      errorMessage,
    );
  if (!match) return undefined;

  const days = match[1] ? Number(match[1]) : 0;
  const hours = match[2] ? Number(match[2]) : 0;
  const minutes = match[3] ? Number(match[3]) : 0;
  if (days === 0 && hours === 0 && minutes === 0) return undefined;

  return days * 86_400 + hours * 3_600 + minutes * 60;
}

/** The most recent assistant message, or undefined if none. */
function lastAssistantMessage(messages: unknown[]): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as Record<string, unknown> | null;
    if (msg && msg.role === "assistant") return msg;
  }
  return undefined;
}

/**
 * Extract an HTTP status from a message.
 *
 * Tried in order: a structured `errorStatus` field (number or numeric string),
 * an "NNN:" prefix on `errorMessage` ("429: {...}"), a status inside a short
 * human preamble ("Model response failed: 410: {...}"), a JSON `code`/`status`
 * field in the body, and finally any HTTP-ish code in the body. The generic last
 * resort matters because providers disagree about where the code lives, and a
 * missed code means the fallback loop cannot classify the failure at all.
 */
function extractStatus(msg: Record<string, unknown>): number | undefined {
  const errorStatus = msg.errorStatus;
  if (typeof errorStatus === "number" && Number.isInteger(errorStatus)) return errorStatus;
  if (typeof errorStatus === "string") {
    const parsed = Number.parseInt(errorStatus, 10);
    if (Number.isInteger(parsed)) return parsed;
  }

  const errorMessage = msg.errorMessage;
  if (typeof errorMessage !== "string") return undefined;

  const prefix = /^\s*(\d{3})\b/.exec(errorMessage);
  if (prefix?.[1] !== undefined) return Number(prefix[1]);

  const preamble = /^[^"{}]{0,48}?\b(\d{3})\s*:/.exec(errorMessage);
  if (preamble?.[1] !== undefined) return Number(preamble[1]);

  const jsonField = /"(?:code|status)"\s*:\s*"?(\d{3})"?/.exec(errorMessage);
  if (jsonField?.[1] !== undefined) return Number(jsonField[1]);

  const anywhere = /\b([45]\d{2})\b/.exec(errorMessage);
  if (anywhere?.[1] !== undefined) return Number(anywhere[1]);

  return undefined;
}
