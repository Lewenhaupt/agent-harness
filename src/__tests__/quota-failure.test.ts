import { describe, expect, it } from "vitest";

import type { SpawnDetails, SpawnUsage } from "../agent-registry.js";
import {
  classifySpawnFailure,
  DEFAULT_QUOTA_COOLDOWN_SECONDS,
  DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
  parseQuotaResetSeconds,
} from "../quota-failure.js";

function zeroUsage(): SpawnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function assistantError(errorMessage: string, model = "opencode-go/mimo-v2.5"): unknown {
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
    expect(result).toHaveProperty("model", "opencode-go/mimo-v2.5");
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
