/**
 * Orchestrator model routing (bd-229).
 *
 * The launch path and the in-session recovery path both ask the same two
 * questions: which candidate can serve a turn now, and how do we name the
 * providers that cannot. These cover the pure answers so both paths are tested
 * without a daemon, a cooldown file or a wall clock.
 */

import { describe, expect, it } from "vitest";
import {
  describeBlockedProviders,
  planModelRoute,
  splitModelRoute,
} from "../orchestrator-model.js";

const PREFIXED = "llmgateway/deepseek-v4.1-flash-1017";

describe("splitModelRoute", () => {
  it("splits provider from the wire id pi-web expects", () => {
    expect(splitModelRoute(PREFIXED)).toEqual({
      provider: "llmgateway",
      modelId: "deepseek-v4.1-flash-1017",
    });
  });

  it("keeps a vendor-qualified wire id intact", () => {
    // Command Code serves its own vendor prefix; only the first slash separates.
    expect(splitModelRoute("commandcode/z-ai/glm-5.3-flash")).toEqual({
      provider: "commandcode",
      modelId: "z-ai/glm-5.3-flash",
    });
  });

  it("rejects an unqualified id instead of guessing a provider", () => {
    expect(splitModelRoute("deepseek-v4.1-flash")).toBeUndefined();
    expect(splitModelRoute("/deepseek-v4.1-flash")).toBeUndefined();
    expect(splitModelRoute("llmgateway/")).toBeUndefined();
  });
});

describe("planModelRoute", () => {
  it("keeps the session's own model when its provider is healthy", () => {
    const plan = planModelRoute({ current: PREFIXED, isBlocked: () => false });
    expect(plan.currentUsable).toBe(true);
    expect(plan.available[0]).toBe(PREFIXED);
    expect(plan.blocked).toEqual([]);
  });

  it("promotes the same model on another provider first when its provider is spent", () => {
    // llmgateway is out of credit; deepseek-v4.1-flash prefers opencode-go next.
    const plan = planModelRoute({
      current: PREFIXED,
      isBlocked: (candidate) => candidate.startsWith("llmgateway/"),
    });
    expect(plan.currentUsable).toBe(false);
    expect(plan.blocked).toContain(PREFIXED);
    expect(plan.available[0]).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("skips a candidate by endpoint and still reports it as blocked", () => {
    const plan = planModelRoute({
      current: PREFIXED,
      isBlocked: (candidate) => candidate === PREFIXED,
    });
    expect(plan.blocked).toContain(PREFIXED);
    expect(plan.available).not.toContain(PREFIXED);
  });

  it("reports no usable candidate when every provider is blocked", () => {
    const plan = planModelRoute({ current: PREFIXED, isBlocked: () => true });
    expect(plan.available).toEqual([]);
    expect(plan.currentUsable).toBe(false);
    expect(plan.blocked.length).toBeGreaterThan(1);
  });

  it("keeps an unclassified model as a single candidate rather than swapping it", () => {
    const plan = planModelRoute({ current: "llmgateway/gpt-4o-mini", isBlocked: () => true });
    expect(plan.blocked).toEqual(["llmgateway/gpt-4o-mini"]);
    expect(plan.available).toEqual([]);
  });

  it("honors an explicit candidate list, current first", () => {
    const plan = planModelRoute({
      current: "p/b",
      candidates: ["p/a", "p/b", "p/c"],
      isBlocked: () => false,
    });
    expect(plan.available).toEqual(["p/b", "p/a", "p/c"]);
  });
});

describe("describeBlockedProviders", () => {
  const now = Date.parse("2026-11-02T20:00:00.000Z");

  it("names each provider once, in candidate order, with its reset time", () => {
    const text = describeBlockedProviders({
      candidates: [
        "llmgateway/deepseek-v4.1-flash-1017",
        "llmgateway/gpt-5.6-luna",
        "opencode-go/deepseek-v4.1-flash",
      ],
      windows: [
        { provider: "llmgateway", resetAt: Date.parse("2026-11-03T03:15:00.000Z") },
        { provider: "opencode-go", resetAt: Date.parse("2026-11-02T21:04:19.000Z") },
      ],
      nowMs: now,
    });
    expect(text).toBe(
      "llmgateway (resets 2026-11-03T03:15:00.000Z), opencode-go (resets 2026-11-02T21:04:19.000Z)",
    );
  });

  it("keeps the later window when two sources describe one provider", () => {
    const text = describeBlockedProviders({
      candidates: ["llmgateway/x"],
      windows: [
        { provider: "llmgateway", resetAt: Date.parse("2026-11-02T22:00:00.000Z") },
        { provider: "llmgateway", resetAt: Date.parse("2026-11-03T04:15:00.000Z") },
      ],
      nowMs: now,
    });
    expect(text).toBe("llmgateway (resets 2026-11-03T04:15:00.000Z)");
  });

  it("says so when a provider has no known reset", () => {
    const text = describeBlockedProviders({
      candidates: ["opencode-go/deepseek-v4.1-flash"],
      windows: [],
      nowMs: now,
    });
    expect(text).toBe("opencode-go (no reset time)");
  });

  it("ignores a window that has already lapsed", () => {
    const text = describeBlockedProviders({
      candidates: ["opencode-go/x"],
      windows: [{ provider: "opencode-go", resetAt: now - 60_000 }],
      nowMs: now,
    });
    expect(text).toBe("opencode-go (no reset time)");
  });

  it("never names a provider that has no blocked candidate", () => {
    const text = describeBlockedProviders({
      candidates: ["llmgateway/x"],
      windows: [
        { provider: "llmgateway", resetAt: now + 60_000 },
        { provider: "openrouter", resetAt: now + 60_000 },
      ],
      nowMs: now,
    });
    expect(text).toBe("llmgateway (resets 2026-11-02T20:01:00.000Z)");
  });
});
