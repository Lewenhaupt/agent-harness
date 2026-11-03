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
 * A plan-gated 403 is the fifth mode: Command Code's subscription plans gate
 * individual model ids, so a 403 body carries `MODEL_NOT_IN_PLAN` /
 * `upgrade_required` / "not included in your plan" wording while the provider
 * still serves everything else the caller's plan covers. It is classified as
 * `unavailable` rather than `quota` on purpose: `spawn-with-fallback` cools a
 * whole provider only for `quota`/`unconfigured`, and one gated id must not
 * disable the entire Command Code bucket. See docs/commandcode-provider.md.
 *
 * A provider with no credential at all is the sixth mode: the pinned Command
 * Code extension emits a statusless `message_end` error ("No Command Code API
 * key. …") when nothing resolves to a key. Classifying that as `other` used to
 * stop the fallback loop and fail the whole phase, even though the standard
 * class primary lives on that provider and the key is deliberately per-host.
 * It is `unconfigured`, a provider-scoped kind that is fallback-worthy and
 * never counts as quota (no bucket was spent, no capacity window observed).
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
  /**
   * The provider has no credential configured at all, so none of its models can
   * run. Provider-scoped (like `quota`) but deliberately not `quota`: no bucket
   * was spent and no capacity window was observed.
   */
  | "unconfigured"
  /**
   * The local shared capacity limit refused the dispatch before any request was
   * sent (bd-187). Fallback-worthy: a different candidate has its own bucket.
   * Never `quota`: nothing upstream was spent, so no cooldown or capacity window
   * may be recorded for it.
   */
  | "capacity"
  | "auth"
  | "other";

/**
 * Stable marker embedded in the provider wrapper's capacity-refusal message.
 * Exported so the refusal text and the classification rule cannot drift: pi
 * converts a synchronous stream throw into an assistant error message, and this
 * marker is the only part of the typed refusal that survives that conversion.
 */
export const CAPACITY_REFUSAL_MARKER = "belayd-capacity-refused";

export interface FailureClassification {
  kind: FailureKind;
  /** Model id reported by the failing event, if any. */
  model?: string;
  /** Human-readable reason for the classification. */
  reason?: string;
  /**
   * Suggested cooldown, when the kind is retryable elsewhere (quota/transient/
   * unavailable/unconfigured). Never set for `capacity` or `auth`: nothing
   * upstream was spent, so there is no window to cool.
   */
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
/**
 * Cooldown for a provider that has no credential configured.
 *
 * Provider-scoped because a missing key is a property of the provider, not of
 * the model: no model on it can run, so cooling only the candidate would burn a
 * spawn per sibling id in the same class. Short (the entitlement window's
 * span) because the fix is an operator action — a key added to the service env
 * or via `/login` must be picked up during the same working day, not after the
 * six-hour model-unavailable window.
 */
export const DEFAULT_UNCONFIGURED_PROVIDER_COOLDOWN_SECONDS = 10 * 60;

/** Status codes indicating a capacity/quota/credit/rate limit. */
const QUOTA_STATUS_CODES = new Set([402, 429]);
/** Status codes indicating a transient service failure. */
const TRANSIENT_STATUS_CODES = new Set([408, 425, 500, 502, 503, 504]);
/**
 * Status codes indicating an auth problem — not solved by switching models.
 * A 403 whose body carries provider-entitlement or plan-gating wording is
 * handled before this branch runs (as a provider-scoped quota failure and a
 * model-scoped unavailable failure respectively).
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
 * Plan-gating wording carried in 403 bodies: the caller's subscription does not
 * include *this model*, while the rest of the provider's catalog is fine.
 * Observed bodies from Command Code's Provider API (bd-178):
 *
 * - `403: {"error":{"code":"MODEL_NOT_IN_PLAN","message":"… is not included in your plan"}}`
 * - `403: {"code":"upgrade_required","message":"Upgrade your plan"}`
 *
 * Must be checked BEFORE `PROVIDER_ENTITLEMENT_PATTERN`, which also matches
 * "upgrade"/"subscription": a plan gate is model-scoped, so cooling the whole
 * provider would throw away the ids the plan does serve.
 */
const MODEL_NOT_IN_PLAN_PATTERN =
  /MODEL_NOT_IN_PLAN|upgrade_required|not included in (?:your|the) plan|plan (?:does not|doesn't) include/i;

/**
 * Statusless "no credential configured" wording. Two observed sources (bd-178):
 *
 * - The pinned Command Code extension, whose stream emits an assistant error
 *   with no status code when nothing resolves to a key:
 *   `No Command Code API key. Run /login and select Command Code, set
 *   COMMAND_CODE_API_KEY (or legacy COMMANDCODE_API_KEY), or configure
 *   ~/.commandcode/auth.json, ~/.pi/agent/auth.json or ~/.omp/agent/auth.json`
 * - pi itself (1.0.2), which refuses to start before any stream exists when the
 *   selected provider has no resolvable key: `No API key found for commandcode.`
 *   on stderr, exit 1. That shape reaches `classifyProcessFailure`, so the
 *   pattern is consulted on both the assistant error body and process stderr.
 *
 * The generic arms also cover a provider that reports the same condition under
 * its own env var ("no API key found (set LLMGATEWAY_API_KEY …)"). They are
 * matched only when the text carries NO status code, so a 401 "invalid api key"
 * (a credentials problem that switching models cannot fix) stays `auth`. The
 * `required` branch is deliberately broad — any statusless text that says an API
 * key is required is treated as a provider with no key configured, because
 * fallback is the safe response either way and no other kind covers it.
 */
const UNCONFIGURED_PROVIDER_PATTERN =
  /(?:no|missing)\s+command\s*code\s+api\s*key|\bno api key (?:found|configured|set|available)\b|\bapi key (?:is )?(?:not set|not configured|missing|required)\b/i;

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

  return classifyAssistantRecord(assistant, details.model);
}

/**
 * Classify the error carried by one assistant message, or undefined when the
 * message is not an assistant error.
 *
 * The subprocess path reads the failure out of `SpawnDetails.messages`; the
 * in-session path (bd-229: the orchestrator's own turn) sees the same message
 * shape through pi's `message_end` event and must not re-derive the rules. Both
 * go through `classifyAssistantRecord`, so a new failure mode cannot be
 * recognized in one path and missed in the other.
 */
export function classifyAssistantMessage(message: unknown): FailureClassification | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant" || record.stopReason !== "error") return undefined;
  return classifyAssistantRecord(record);
}

/** Shared tail of both entry points: status + wording rules for one error record. */
function classifyAssistantRecord(
  assistant: Record<string, unknown>,
  fallbackModel?: string,
): FailureClassification {
  const status = extractStatus(assistant);
  const model = typeof assistant.model === "string" ? assistant.model : fallbackModel;
  const errorMessage =
    typeof assistant.errorMessage === "string" ? assistant.errorMessage : undefined;

  return classifyAssistantError(status, model, errorMessage);
}

/**
 * Classify a non-zero exit that produced no assistant error event, using the
 * stderr the child wrote. Signature-first: an exit code alone says nothing about
 * whether another candidate could succeed.
 *
 * pi refuses to start at all when the selected provider resolves to no key
 * (`No API key found for <provider>.`, live on pi 1.0.2), and that refusal never
 * reaches a model turn, so the assistant path's rules can only fire here. The
 * no-key rule is therefore mirrored on the statusless stderr text; a
 * status-coded line keeps a status classification instead.
 *
 * The wrapper's capacity marker is checked first, with the same precedence the
 * assistant path gives it: a child refused for local capacity writes the marker
 * to stderr, and calling that `other` would hard-fail the phase instead of
 * falling back to the next candidate.
 */
function classifyProcessFailure(details: SpawnDetails): FailureClassification {
  const stderr = details.stderr ?? "";
  const model = details.model;

  if (stderr.includes(CAPACITY_REFUSAL_MARKER)) {
    return {
      kind: "capacity",
      model,
      reason: "Local provider capacity limit refused the dispatch.",
    };
  }
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

  const status = extractStatusFromText(stderr);
  // Same statusless-only discipline as `unconfiguredProviderRule`: a line that
  // carries a code is an upstream rejection the status rules own, never a
  // provider with no credential.
  if (status === undefined && UNCONFIGURED_PROVIDER_PATTERN.test(stderr)) {
    return {
      kind: "unconfigured",
      model,
      reason: "Provider has no API key configured.",
      cooldownSeconds: DEFAULT_UNCONFIGURED_PROVIDER_COOLDOWN_SECONDS,
    };
  }
  // A status-coded startup refusal (401/403 in stderr) is a credential problem,
  // not an unexplained failure: same stop verdict, accurate diagnosis.
  if (status !== undefined && AUTH_STATUS_CODES.has(status)) {
    return {
      kind: "auth",
      model,
      reason: `Authentication/authorization failure (HTTP ${status}).`,
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

/** A 403 saying this model is outside the caller's plan: endpoint-scoped skip. */
const modelNotInPlanRule: ClassificationRule = (status, errorMessage) => {
  if (status !== 403 || errorMessage === undefined) return undefined;
  if (!MODEL_NOT_IN_PLAN_PATTERN.test(errorMessage)) return undefined;
  // `unavailable`, not `quota`: spawn-with-fallback only cools the whole
  // provider for `quota`, and one gated id must not disable the bucket.
  return {
    kind: "unavailable",
    reason: "Model gated by the provider plan (HTTP 403).",
    cooldownSeconds: DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS,
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
 * A statusless "no API key configured" body: the provider cannot run any model,
 * but a different provider can, so this must fall back instead of stopping.
 */
const unconfiguredProviderRule: ClassificationRule = (status, errorMessage) => {
  if (status !== undefined || errorMessage === undefined) return undefined;
  if (!UNCONFIGURED_PROVIDER_PATTERN.test(errorMessage)) return undefined;
  return {
    kind: "unconfigured",
    reason: "Provider has no API key configured.",
    cooldownSeconds: DEFAULT_UNCONFIGURED_PROVIDER_COOLDOWN_SECONDS,
  };
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
 * The provider wrapper's own capacity refusal, after pi converted the thrown
 * refusal into an assistant error message. First rule: the marker is ours and is
 * authoritative whatever status pi attaches to the wrapper text.
 */
const capacityRefusalRule: ClassificationRule = (_status, errorMessage) => {
  if (errorMessage === undefined) return undefined;
  if (!errorMessage.includes(CAPACITY_REFUSAL_MARKER)) return undefined;
  // No cooldownSeconds on purpose: nothing upstream was spent, so this must not
  // cool the provider or record a capacity window.
  return {
    kind: "capacity",
    reason: "Local provider capacity limit refused the dispatch.",
  };
};

/**
 * Ordered rules; the first match wins. Order matters: the wrapper's capacity
 * marker must beat every upstream wording rule, a quota status must beat model
 * wording (a 429 body can mention the model), a plan-gating 403 must beat the
 * broader entitlement wording, and auth must beat unavailable (a 403 body can
 * mention a model name without it being retired). The unconfigured rule is
 * statusless-only, so it can never preempt a status-coded classification.
 */
const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  capacityRefusalRule,
  quotaStatusRule,
  modelNotInPlanRule,
  providerEntitlementRule,
  authRule,
  unconfiguredProviderRule,
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
    case "unconfigured":
    // A local capacity refusal says "not this provider right now"; a different
    // candidate has its own (provider, class) bucket, so fall back to it.
    case "capacity":
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
 * then the free-form `errorMessage` text (see {@link extractStatusFromText}).
 * The generic last resort there matters because providers disagree about where
 * the code lives, and a missed code means the fallback loop cannot classify the
 * failure at all.
 */
function extractStatus(msg: Record<string, unknown>): number | undefined {
  const errorStatus = msg.errorStatus;
  if (typeof errorStatus === "number" && Number.isInteger(errorStatus)) return errorStatus;
  if (typeof errorStatus === "string") {
    const parsed = Number.parseInt(errorStatus, 10);
    if (Number.isInteger(parsed)) return parsed;
  }

  const errorMessage = msg.errorMessage;
  return typeof errorMessage === "string" ? extractStatusFromText(errorMessage) : undefined;
}

/**
 * Extract an HTTP status from free-form error/stderr text: an "NNN:" prefix
 * ("429: {...}"), a code inside a short human preamble ("Model response
 * failed: 410: {...}"), a JSON `code`/`status` field, or any standalone
 * `4xx`/`5xx` token. Shared by the assistant and process paths so a code pi
 * writes to stderr is read the same way an error body's is.
 */
function extractStatusFromText(text: string): number | undefined {
  const prefix = /^\s*(\d{3})\b/.exec(text);
  if (prefix?.[1] !== undefined) return Number(prefix[1]);

  const preamble = /^[^"{}]{0,48}?\b(\d{3})\s*:/.exec(text);
  if (preamble?.[1] !== undefined) return Number(preamble[1]);

  const jsonField = /"(?:code|status)"\s*:\s*"?(\d{3})"?/.exec(text);
  if (jsonField?.[1] !== undefined) return Number(jsonField[1]);

  const anywhere = /\b([45]\d{2})\b/.exec(text);
  if (anywhere?.[1] !== undefined) return Number(anywhere[1]);

  return undefined;
}
