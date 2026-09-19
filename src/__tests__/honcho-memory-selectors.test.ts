/**
 * Tests for src/honcho-memory/selectors.ts.
 *
 * Pure module — no mocks; data passed as arguments.
 */

import { describe, expect, it } from "vitest";
import {
  buildMemoryQuery,
  derivePhaseName,
  deriveSessionId,
  formatMemoryContext,
  isBelaydSubAgentSession,
} from "../honcho-memory/selectors.js";

describe("deriveSessionId", () => {
  it("maps belayd-<taskId>-sub-<phase>-<runId> to the task id", () => {
    expect(deriveSessionId("belayd-bd-42-sub-implement-abc123")).toBe("bd-42");
  });

  it("maps planning sessions to 'planning'", () => {
    expect(deriveSessionId("belayd-planning-sub-scout-abc123")).toBe("planning");
  });

  it("returns the raw session name for non-belayd names", () => {
    expect(deriveSessionId("some-other-session")).toBe("some-other-session");
  });
});

describe("derivePhaseName", () => {
  it("extracts the -sub- phase segment", () => {
    expect(derivePhaseName("belayd-bd-42-sub-implement-abc123")).toBe("implement");
  });

  it("extracts planning phases", () => {
    expect(derivePhaseName("belayd-planning-sub-scout-abc123")).toBe("scout");
  });

  it("returns undefined for non-belayd names", () => {
    expect(derivePhaseName("belayd-bd-42")).toBeUndefined();
    expect(derivePhaseName("other")).toBeUndefined();
  });
});

describe("isBelaydSubAgentSession", () => {
  it("detects sub-agent and planning sessions", () => {
    expect(isBelaydSubAgentSession("belayd-bd-42-sub-implement-abc")).toBe(true);
    expect(isBelaydSubAgentSession("belayd-planning-sub-scout-abc")).toBe(true);
  });

  it("rejects orchestrator and arbitrary names", () => {
    expect(isBelaydSubAgentSession("belayd-bd-42")).toBe(false);
    expect(isBelaydSubAgentSession("other-session")).toBe(false);
  });
});

describe("buildMemoryQuery", () => {
  it("truncates long prompts to ~500 chars", () => {
    const prompt = "x".repeat(2000);
    const query = buildMemoryQuery(prompt, "", "belayd-bd-42");
    expect(query.length).toBeLessThanOrEqual(520);
    expect(query).toContain("…");
  });

  it("appends agent and phase hints", () => {
    const query = buildMemoryQuery(
      "fix the bug",
      "belayd-implementer",
      "belayd-bd-42-sub-implement-abc",
    );
    expect(query).toContain("agent:belayd-implementer");
    expect(query).toContain("phase:implement");
  });

  it("omits hints when agent and phase are unavailable", () => {
    const query = buildMemoryQuery("fix the bug", "", "belayd-bd-42");
    expect(query).toBe("fix the bug");
  });
});

describe("formatMemoryContext", () => {
  it("returns undefined for empty/absent payloads", () => {
    expect(formatMemoryContext(undefined)).toBeUndefined();
    expect(formatMemoryContext(null)).toBeUndefined();
    expect(formatMemoryContext({})).toBeUndefined();
    expect(formatMemoryContext({ summary: "" })).toBeUndefined();
  });

  it("returns undefined for malformed (non-object) payloads", () => {
    expect(formatMemoryContext("text")).toBeUndefined();
    expect(formatMemoryContext(42)).toBeUndefined();
  });

  it("formats a summary-only payload into a markdown block", () => {
    const formatted = formatMemoryContext({ summary: "remember this" });
    expect(formatted).toContain("```honcho-memory");
    expect(formatted).toContain("remember this");
  });

  it("formats sessions/context/representations with labels", () => {
    const formatted = formatMemoryContext({
      sessions: [
        { phase: "implement", content: "did the work" },
        { role: "assistant", text: "second block" },
        { representation: "bare representation" },
      ],
    });
    expect(formatted).toContain("phase: implement");
    expect(formatted).toContain("did the work");
    expect(formatted).toContain("second block");
    expect(formatted).toContain("bare representation");
  });

  it("skips empty string leaves", () => {
    expect(formatMemoryContext({ sessions: [{ content: "" }] })).toBeUndefined();
  });
});
