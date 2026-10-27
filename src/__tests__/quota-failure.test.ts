import { describe, expect, it } from "vitest";

import type { SpawnDetails, SpawnUsage } from "../agent-registry.js";
import {
  classifySpawnFailure,
  DEFAULT_ENTITLEMENT_COOLDOWN_SECONDS,
  DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS,
  DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS,
  DEFAULT_QUOTA_COOLDOWN_SECONDS,
  DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
  isFallbackWorthy,
  parseQuotaResetSeconds,
  resolveQuotaCooldown,
} from "../quota-failure.js";

function zeroUsage(): SpawnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 };
}

function assistantError(errorMessage: string, model = "opencode-go/mimo-v2.6-flash"): unknown {
  return {
    role: "assistant",
    content: [],
    provider: "opencode-go",
    model,
    usage: zeroUsage(),
    stopReason: "error",
    errorMessage,
  };
}

function details(messages: unknown[], exitCode = 0, model?: string): SpawnDetails {
  return { messages, usage: zeroUsage(), exitCode, model };
}

/** The exact `errorMessage` pi recorded for `llmgateway/mimo-v2.5` (live, bd-142). */
const DEACTIVATED_MODEL_MESSAGE =
  '410: {"message":"Model mimo-v2.5 has been deactivated and is no longer available","type":"invalid_request_error","param":null,"code":null}';

describe("classifySpawnFailure", () => {
  it("classifies a clean assistant turn as success", () => {
    const result = classifySpawnFailure(
      details([{ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" }]),
    );
    expect(result).toEqual({ kind: "success" });
  });

  it("classifies non-zero exit without an error event as other", () => {
    const result = classifySpawnFailure(details([], 1));
    expect(result).toHaveProperty("kind", "other");
  });

  it("classifies a 429 error as quota and parses the reset hint", () => {
    const result = classifySpawnFailure(
      details([
        assistantError('429: {"message":"Weekly usage limit reached. Resets in 11hr 6min."}'),
      ]),
    );
    expect(result).toHaveProperty("kind", "quota");
    expect(result).toHaveProperty("model", "opencode-go/mimo-v2.6-flash");
    expect(result).toHaveProperty("cooldownSeconds", 11 * 3600 + 6 * 60);
  });

  it("classifies a 402 error as quota with the default cooldown", () => {
    const result = classifySpawnFailure(details([assistantError("402: insufficient_quota")]));
    expect(result).toHaveProperty("kind", "quota");
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_QUOTA_COOLDOWN_SECONDS);
  });

  it("classifies 401 and 403 as auth", () => {
    expect(classifySpawnFailure(details([assistantError("401: unauthorized")]))).toHaveProperty(
      "kind",
      "auth",
    );
    expect(classifySpawnFailure(details([assistantError("403: forbidden")]))).toHaveProperty(
      "kind",
      "auth",
    );
  });

  it("classifies a 403 provider-entitlement error as provider-scoped quota", () => {
    const result = classifySpawnFailure(
      details([
        assistantError(
          '403: {"type":"server_error","message":"Upstream request failed: An active OpenCode Go subscription is required to use Go models."}',
        ),
      ]),
    );
    expect(result).toHaveProperty("kind", "quota");
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_ENTITLEMENT_COOLDOWN_SECONDS);
  });

  it("keeps a 403 without entitlement wording classified as auth", () => {
    expect(
      classifySpawnFailure(details([assistantError('403: {"message":"invalid api key"}')])),
    ).toHaveProperty("kind", "auth");
    expect(
      classifySpawnFailure(
        details([
          assistantError('403: {"type":"server_error","message":"upstream gateway error"}'),
        ]),
      ),
    ).toHaveProperty("kind", "auth");
  });

  it("does not read entitlement wording on a non-403 status", () => {
    expect(
      classifySpawnFailure(details([assistantError("401: subscription required")])),
    ).toHaveProperty("kind", "auth");
  });

  it("classifies 5xx/408 as transient with the transient cooldown", () => {
    for (const status of ["500", "502", "503", "504", "408"]) {
      const result = classifySpawnFailure(details([assistantError(`${status}: boom`)]));
      expect(result).toHaveProperty("kind", "transient");
      expect(result).toHaveProperty("cooldownSeconds", DEFAULT_TRANSIENT_COOLDOWN_SECONDS);
    }
  });

  it("classifies statusless network errors as transient", () => {
    const result = classifySpawnFailure(details([assistantError("fetch failed")]));
    expect(result).toHaveProperty("kind", "transient");
  });

  it("classifies a 400 gateway model-routing rejection as transient", () => {
    const result = classifySpawnFailure(
      details([
        assistantError(
          '400: {"error":{"message":"The request was rejected","type":"invalid_request_error","param":null,"code":"invalid_value"}}',
        ),
      ]),
    );
    expect(result).toHaveProperty("kind", "transient");
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_TRANSIENT_COOLDOWN_SECONDS);
  });

  it("classifies a generic 400 without rejection wording as other", () => {
    expect(classifySpawnFailure(details([assistantError("400: bad request")]))).toHaveProperty(
      "kind",
      "other",
    );
  });

  it("classifies an unrecognized error as other", () => {
    const result = classifySpawnFailure(details([assistantError("something went sideways")]));
    expect(result).toHaveProperty("kind", "other");
  });

  it("falls back to details.model when the error message lacks a model", () => {
    const msg = { ...(assistantError("429: nope") as Record<string, unknown>), model: undefined };
    const result = classifySpawnFailure(details([msg], 0, "opencode-go/glm-5.2"));
    expect(result).toHaveProperty("model", "opencode-go/glm-5.2");
  });
});

describe("classifySpawnFailure model unavailability (bd-142)", () => {
  it("classifies the live 410 deactivated-model error as unavailable", () => {
    const result = classifySpawnFailure(
      details([assistantError(DEACTIVATED_MODEL_MESSAGE, "llmgateway/mimo-v2.5")]),
    );
    expect(result).toHaveProperty("kind", "unavailable");
    expect(result).toHaveProperty("model", "llmgateway/mimo-v2.5");
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS);
  });

  it("classifies 404 as unavailable", () => {
    expect(
      classifySpawnFailure(details([assistantError('404: {"message":"Not Found"}')])),
    ).toHaveProperty("kind", "unavailable");
  });

  it("classifies a 400 rejection of the model id as unavailable, not transient", () => {
    // Both bodies were observed live against real gateways.
    expect(
      classifySpawnFailure(
        details([
          assistantError(
            '400: {"message":"Requested model no-such-model-xyz not supported","type":"invalid_request_error"}',
          ),
        ]),
      ),
    ).toHaveProperty("kind", "unavailable");
    expect(
      classifySpawnFailure(
        details([
          assistantError('400: {"message":"no-such-model-xyz is not a valid model ID","code":400}'),
        ]),
      ),
    ).toHaveProperty("kind", "unavailable");
  });

  it("classifies retired-model wording without a status code as unavailable", () => {
    expect(
      classifySpawnFailure(details([assistantError("Model glm-9 was deactivated upstream")])),
    ).toHaveProperty("kind", "unavailable");
  });

  it("still classifies a 403 auth failure as auth, not unavailable", () => {
    expect(
      classifySpawnFailure(details([assistantError('403: {"message":"invalid api key"}')])),
    ).toHaveProperty("kind", "auth");
  });

  it("reads a status from a prefixed message, a JSON code field, and a string errorStatus", () => {
    expect(
      classifySpawnFailure(details([assistantError(DEACTIVATED_MODEL_MESSAGE)])),
    ).toHaveProperty("kind", "unavailable");
    expect(
      classifySpawnFailure(
        details([
          assistantError('Model response failed: 429: {"message":"Weekly usage limit reached"}'),
        ]),
      ),
    ).toHaveProperty("kind", "quota");
    expect(
      classifySpawnFailure(
        details([
          { ...(assistantError('{"message":"nope","code":410}') as Record<string, unknown>) },
        ]),
      ),
    ).toHaveProperty("kind", "unavailable");
    expect(
      classifySpawnFailure(
        details([
          {
            ...(assistantError('{"message":"nope"}') as Record<string, unknown>),
            errorStatus: "402",
          },
        ]),
      ),
    ).toHaveProperty("kind", "quota");
  });

  it("classifies quota wording without a status code as quota", () => {
    const result = classifySpawnFailure(
      details([assistantError("Go usage limit exceeded. Resets in 2hr 15min.")]),
    );
    expect(result).toHaveProperty("kind", "quota");
    expect(result).toHaveProperty("cooldownSeconds", 2 * 3600 + 15 * 60);
  });
});

describe("classifySpawnFailure without an assistant error event", () => {
  it("classifies a non-zero exit after a network error as transient", () => {
    const result = classifySpawnFailure({
      ...details([], 1, "llmgateway/glm-5.3"),
      stderr: "Error: fetch failed\n    at node:internal/deps/undici",
    });
    expect(result).toHaveProperty("kind", "transient");
  });

  it("classifies a non-zero exit on an unknown model as unavailable", () => {
    const result = classifySpawnFailure({
      ...details([], 1, "llmgateway/glm-9"),
      stderr: 'Error: model "glm-9" not found for provider llmgateway',
    });
    expect(result).toHaveProperty("kind", "unavailable");
  });

  it("classifies a non-zero exit on quota wording as quota", () => {
    const result = classifySpawnFailure({
      ...details([], 1),
      stderr: "error: rate limit reached for this account",
    });
    expect(result).toHaveProperty("kind", "quota");
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_QUOTA_COOLDOWN_SECONDS);
  });

  it("keeps an unexplained non-zero exit as other", () => {
    expect(classifySpawnFailure({ ...details([], 1), stderr: "bad flag" })).toHaveProperty(
      "kind",
      "other",
    );
  });
});

describe("isFallbackWorthy", () => {
  it("retries quota, transient, and unavailable failures only", () => {
    expect(isFallbackWorthy("quota")).toBe(true);
    expect(isFallbackWorthy("transient")).toBe(true);
    expect(isFallbackWorthy("unavailable")).toBe(true);
    expect(isFallbackWorthy("auth")).toBe(false);
    expect(isFallbackWorthy("other")).toBe(false);
    expect(isFallbackWorthy("success")).toBe(false);
  });
});

/** The exact 429 body opencode-go returned when the Go bucket was spent (bd-38). */
const OPENCODE_GO_HINTED_MESSAGE =
  '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 7hr 57min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_01KNYGJSTTZYM98CXTX9KRB5M2/go"}';

/** The same error without any reset hint (the live fleet case that burned sessions). */
const OPENCODE_GO_UNHINTED_MESSAGE =
  '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}';

describe("classifySpawnFailure provider usage limits (bd-38)", () => {
  it("parses the reset hint out of the live GoUsageLimitError body", () => {
    const result = classifySpawnFailure(details([assistantError(OPENCODE_GO_HINTED_MESSAGE)]));
    expect(result).toHaveProperty("kind", "quota");
    expect(result).toHaveProperty("cooldownSeconds", 7 * 3600 + 57 * 60);
    expect(result).toHaveProperty("cooldownHinted", true);
  });

  it("uses the long provider window for an unhinted GoUsageLimitError body", () => {
    const result = classifySpawnFailure(details([assistantError(OPENCODE_GO_UNHINTED_MESSAGE)]));
    expect(result).toHaveProperty("kind", "quota");
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS);
    expect(result).toHaveProperty("cooldownHinted", false);
  });

  it("uses the long provider window for statusless provider usage-limit wording", () => {
    for (const message of [
      "Go usage limit exceeded",
      '{"type":"GoUsageLimitError","message":"Go usage limit exceeded"}',
      "Weekly usage limit reached",
      "Monthly usage limit hit for this workspace",
    ]) {
      const result = classifySpawnFailure(details([assistantError(message)]));
      expect(result).toHaveProperty("kind", "quota");
      expect(result).toHaveProperty(
        "cooldownSeconds",
        DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS,
      );
      expect(result).toHaveProperty("cooldownHinted", false);
    }
  });

  it("uses the long provider window on a 402 carrying usage-limit wording", () => {
    const result = classifySpawnFailure(
      details([assistantError('402: {"message":"Go usage limit exceeded"}')]),
    );
    expect(result).toHaveProperty("kind", "quota");
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS);
  });

  it("lets a parsed hint win over the long provider window", () => {
    const result = classifySpawnFailure(
      details([
        assistantError(
          '429: {"type":"GoUsageLimitError","message":"Go usage limit reached. Resets in 20min"}',
        ),
      ]),
    );
    expect(result).toHaveProperty("cooldownSeconds", 20 * 60);
    expect(result).toHaveProperty("cooldownHinted", true);
  });

  it("uses the long provider window for an unhinted usage-limit stderr exit", () => {
    const result = classifySpawnFailure({
      ...details([], 1),
      stderr: "error: Go usage limit exceeded for workspace wrk_01KNY",
    });
    expect(result).toHaveProperty("kind", "quota");
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS);
  });

  it("keeps a generic unhinted quota body on the short default", () => {
    const result = classifySpawnFailure(details([assistantError("402: insufficient_quota")]));
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_QUOTA_COOLDOWN_SECONDS);
    expect(result).toHaveProperty("cooldownHinted", false);
  });

  it("leaves transient and unavailable cooldowns untouched", () => {
    expect(
      classifySpawnFailure(details([assistantError("503: usage limit service unavailable")])),
    ).toHaveProperty("kind", "transient");
    expect(classifySpawnFailure(details([assistantError("503: boom")]))).toHaveProperty(
      "cooldownSeconds",
      DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
    );
    expect(classifySpawnFailure(details([assistantError("410: model retired")]))).toHaveProperty(
      "cooldownSeconds",
      DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS,
    );
    expect(
      classifySpawnFailure(details([assistantError('403: {"message":"invalid api key"}')])),
    ).not.toHaveProperty("cooldownSeconds");
  });
});

describe("provider usage-limit wording boundaries (bd-38)", () => {
  it("keeps usage-limit wording on a transient status on the transient window", () => {
    // The long provider window is a guess about a *subscription bucket*. A 5xx
    // that merely mentions the limit is still an endpoint-health failure, and
    // the other models on the provider are unaffected.
    for (const message of [
      '503: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}',
      "500: weekly usage limit check failed",
      "fetch failed: Go usage limit exceeded",
    ]) {
      const result = classifySpawnFailure(details([assistantError(message)]));
      expect(result).toHaveProperty("kind", "transient");
      expect(result).toHaveProperty("cooldownSeconds", DEFAULT_TRANSIENT_COOLDOWN_SECONDS);
      // No hint was applied, so the long production half must stay absent.
      expect(result).not.toHaveProperty("cooldownHinted");
    }
  });

  it("keeps usage-limit wording on a retired-model body unavailable", () => {
    const withStatus = classifySpawnFailure(
      details([
        assistantError(
          '410: {"type":"GoUsageLimitError","message":"Model mimo-v2.5 has been deactivated. Go usage limit exceeded"}',
        ),
      ]),
    );
    expect(withStatus).toHaveProperty("kind", "unavailable");
    expect(withStatus).toHaveProperty(
      "cooldownSeconds",
      DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS,
    );
    expect(withStatus).not.toHaveProperty("cooldownHinted");

    // Statusless: the model wording is checked before quota wording.
    const statusless = classifySpawnFailure(
      details([
        assistantError("Go usage limit exceeded; no-such-model-xyz is not a valid model ID"),
      ]),
    );
    expect(statusless).toHaveProperty("kind", "unavailable");
    expect(statusless).toHaveProperty(
      "cooldownSeconds",
      DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS,
    );
  });

  it("keeps a bare 401/403 with usage-limit wording on auth", () => {
    for (const status of [401, 403]) {
      const result = classifySpawnFailure(
        details([
          assistantError(
            `${status}: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}`,
          ),
        ]),
      );
      expect(result).toHaveProperty("kind", "auth");
      expect(result).not.toHaveProperty("cooldownSeconds");
      expect(isFallbackWorthy(result.kind)).toBe(false);
    }
  });

  it("does not make an unrelated 400 that mentions usage limit retryable", () => {
    // "usage limit" alone is not evidence of a provider bucket: a generic bad
    // request must stay non-retryable, or the loop burns candidates hiding a
    // request-shape bug.
    const result = classifySpawnFailure(
      details([assistantError('400: {"message":"usage limit reached for this account"}')]),
    );
    expect(result).toHaveProperty("kind", "other");
    expect(result).not.toHaveProperty("cooldownSeconds");
    expect(isFallbackWorthy(result.kind)).toBe(false);
  });

  it("classifies a 400 gateway rejection mentioning usage limit as transient, not quota", () => {
    const result = classifySpawnFailure(
      details([
        assistantError(
          '400: {"error":{"message":"The request was rejected: usage limit","type":"invalid_request_error","code":"invalid_value"}}',
        ),
      ]),
    );
    expect(result).toHaveProperty("kind", "transient");
    expect(result).toHaveProperty("cooldownSeconds", DEFAULT_TRANSIENT_COOLDOWN_SECONDS);
    expect(result).not.toHaveProperty("cooldownHinted");
  });
});

describe("quota reset-hint precedence (bd-38)", () => {
  it("lets a hint longer than the long provider default win on a 429", () => {
    const result = classifySpawnFailure(
      details([
        assistantError(
          '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded. Resets in 1d 2hr"}',
        ),
      ]),
    );
    expect(result).toHaveProperty("kind", "quota");
    // 26 h, i.e. beyond the 6 h unhinted guess.
    expect(result).toHaveProperty("cooldownSeconds", 86_400 + 2 * 3_600);
    expect(result).toHaveProperty("cooldownHinted", true);
  });

  it("behaves the same on a 402 path as on a 429 for longer and shorter hints", () => {
    const longer = classifySpawnFailure(
      details([
        assistantError(
          '402: {"type":"GoUsageLimitError","message":"Go usage limit exceeded. Resets in 13hr 30min"}',
        ),
      ]),
    );
    expect(longer).toHaveProperty("kind", "quota");
    expect(longer).toHaveProperty("cooldownSeconds", 13 * 3_600 + 30 * 60);
    expect(longer).toHaveProperty("cooldownHinted", true);

    const shorter = classifySpawnFailure(
      details([assistantError('402: {"message":"insufficient_quota. Resets in 5min"}')]),
    );
    expect(shorter).toHaveProperty("kind", "quota");
    expect(shorter).toHaveProperty("cooldownSeconds", 5 * 60);
    expect(shorter).toHaveProperty("cooldownHinted", true);
  });
});

describe("resolveQuotaCooldown", () => {
  it("prefers a parseable reset hint and reports it as authoritative", () => {
    expect(resolveQuotaCooldown("Weekly usage limit reached. Resets in 7hr 57min.")).toEqual({
      cooldownSeconds: 7 * 3600 + 57 * 60,
      cooldownHinted: true,
    });
  });

  it("returns the long provider window for unhinted provider usage-limit wording", () => {
    const body = '{"type":"GoUsageLimitError","message":"Go usage limit exceeded"}';
    expect(resolveQuotaCooldown(body)).toEqual({
      cooldownSeconds: DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS,
      cooldownHinted: false,
    });
  });

  it("falls back to the generic default without a hint or provider wording", () => {
    const fallback = {
      cooldownSeconds: DEFAULT_QUOTA_COOLDOWN_SECONDS,
      cooldownHinted: false,
    };
    expect(resolveQuotaCooldown("429: too many requests")).toEqual(fallback);
    expect(resolveQuotaCooldown(undefined)).toEqual(fallback);
  });

  it("does not read the long window out of a body with no quota wording at all", () => {
    const fallback = {
      cooldownSeconds: DEFAULT_QUOTA_COOLDOWN_SECONDS,
      cooldownHinted: false,
    };
    expect(resolveQuotaCooldown("400: bad request")).toEqual(fallback);
    expect(resolveQuotaCooldown("")).toEqual(fallback);
  });

  it("lets a reset hint win even when the body carries no quota wording", () => {
    expect(resolveQuotaCooldown("Resets in 30min")).toEqual({
      cooldownSeconds: 30 * 60,
      cooldownHinted: true,
    });
  });
});

describe("parseQuotaResetSeconds", () => {
  it("parses hr/min", () => {
    expect(parseQuotaResetSeconds("Resets in 11hr 6min.")).toBe(11 * 3600 + 6 * 60);
  });

  it("parses days/hours/minutes", () => {
    expect(parseQuotaResetSeconds("Resets in 2d 3h 45m")).toBe(2 * 86_400 + 3 * 3600 + 45 * 60);
  });

  it("parses minutes only", () => {
    expect(parseQuotaResetSeconds("Resets in 45min")).toBe(45 * 60);
  });

  it("returns undefined when no hint is present", () => {
    expect(parseQuotaResetSeconds("Weekly limit reached")).toBeUndefined();
    expect(parseQuotaResetSeconds(undefined)).toBeUndefined();
  });
});
