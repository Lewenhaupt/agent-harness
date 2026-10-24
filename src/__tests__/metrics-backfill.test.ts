import { describe, expect, it } from "vitest";

import {
  buildBackfillEvents,
  parseBackfillSessionName,
  type SessionEntry,
  summarizeSession,
} from "../metrics-backfill.js";

describe("parseBackfillSessionName", () => {
  it("parses a phase session", () => {
    expect(parseBackfillSessionName("belayd-bd-42-sub-review-mv1abc")).toEqual({
      kind: "phase",
      task: "bd-42",
      phase: "review",
      runId: "mv1abc",
    });
  });

  it("keeps the epoch suffix, because it is a distinct run", () => {
    expect(parseBackfillSessionName("belayd-bd-42-sub-implement-mv1abc-retry-3")).toHaveProperty(
      "epoch",
      "retry-3",
    );
    expect(parseBackfillSessionName("belayd-bd-42-sub-implement-mv1abc-run-5")).toHaveProperty(
      "epoch",
      "run-5",
    );
  });

  it("recognizes planning sub-agents", () => {
    expect(parseBackfillSessionName("belayd-planning-sub-research-mv1abc")).toEqual({
      kind: "planning",
      sub: "research",
    });
  });

  it("ignores orchestrator and interactive sessions", () => {
    expect(parseBackfillSessionName("belayd-bd-42")).toEqual({ kind: "other" });
    expect(parseBackfillSessionName("01a16a16-8f6f-7155")).toEqual({ kind: "other" });
  });
});

const entries: SessionEntry[] = [
  { type: "session", timestamp: "2026-05-02T10:00:00.000Z" },
  {
    type: "message",
    message: {
      role: "assistant",
      model: "deepseek-v4.1-flash",
      timestamp: "2026-05-02T10:01:00.000Z",
      usage: { input: 1000, output: 200, cacheRead: 5000, cost: { total: 0.25 } },
      content: [
        { type: "toolCall", name: "read" },
        { type: "toolCall", name: "bash" },
      ],
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      model: "deepseek-v4.1-flash",
      timestamp: "2026-05-02T10:11:00.000Z",
      usage: { input: 500, output: 100, cacheRead: 1000, cost: 0.05 },
      content: [{ type: "toolCall", name: "edit" }],
    },
  },
];

describe("summarizeSession", () => {
  it("accumulates usage and tool calls across the session", () => {
    const summary = summarizeSession(entries);

    expect(summary).toHaveProperty("toolCalls", 3);
    expect(summary).toHaveProperty("input", 1500);
    expect(summary).toHaveProperty("output", 300);
    expect(summary).toHaveProperty("cacheRead", 6000);
    expect(summary).toHaveProperty("cost", 0.3);
    expect(summary).toHaveProperty("model", "deepseek-v4.1-flash");
    expect(summary).toHaveProperty("status", "completed");
    expect(summary.startedAt).toBe(Date.parse("2026-05-02T10:00:00.000Z"));
    expect(summary.endedAt).toBe(Date.parse("2026-05-02T10:11:00.000Z"));
  });

  it("marks a session whose final message errored as failed", () => {
    const summary = summarizeSession([
      ...entries,
      { type: "message", message: { role: "assistant", stopReason: "error", timestamp: 11 } },
    ]);

    expect(summary).toHaveProperty("status", "failed");
  });

  it("tolerates entries without usage or timestamps", () => {
    const summary = summarizeSession([{ type: "message", message: { role: "user" } }]);

    expect(summary).toHaveProperty("cost", 0);
    expect(summary.startedAt).toBeUndefined();
  });
});

describe("buildBackfillEvents", () => {
  it("produces a run_start / run_end pair marked as backfill", () => {
    const events = buildBackfillEvents({
      sessionName: "belayd-bd-42-sub-review-mv1abc",
      entries,
      host: "h",
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toHaveProperty("event", "run_start");
    expect(events[0]).toHaveProperty("source", "backfill");
    expect(events[0]).toHaveProperty("phase", "review");
    expect(events[0]).toHaveProperty("workflowType", "unknown");
    expect(events[1]).toHaveProperty("event", "run_end");
    expect(events[1]).toHaveProperty("toolCalls", 3);
  });

  it("counts an epoch session as its own run", () => {
    const events = buildBackfillEvents({
      sessionName: "belayd-bd-42-sub-implement-mv1abc-retry-3",
      entries,
      host: "h",
    });

    expect(events[0]).toHaveProperty("runId", "mv1abc-retry-3");
  });

  it("emits nothing for sessions with no phase", () => {
    for (const sessionName of [
      "belayd-bd-42",
      "belayd-planning-sub-research-mv1abc",
      "01a16a16-8f6f-7155",
    ]) {
      expect(buildBackfillEvents({ sessionName, entries, host: "h" })).toEqual([]);
    }
  });

  it("emits nothing when the session has no timestamps at all", () => {
    expect(
      buildBackfillEvents({
        sessionName: "belayd-bd-42-sub-test-mv1abc",
        entries: [{ type: "message", message: { role: "assistant" } }],
        host: "h",
      }),
    ).toEqual([]);
  });
});
