import { describe, expect, it } from "vitest";

import type { SpawnDetails, SpawnUsage } from "../agent-registry.js";
import {
  classifySpawnFailure,
  DEFAULT_ENTITLEMENT_COOLDOWN_SECONDS,
  DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS,
  DEFAULT_QUOTA_COOLDOWN_SECONDS,
  DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
  isFallbackWorthy,
  parseQuotaResetSeconds,
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
