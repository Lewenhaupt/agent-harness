import { describe, expect, it } from "vitest";
import {
  annotateLiveGeneration,
  controlAvailability,
  DEFAULT_LIVE_STALE_AFTER_MS,
  DEFAULT_VIEW_WINDOW,
  formatTaskLine,
  mergeEarlierTranscriptPage,
  reduceConversationFrames,
  reduceLiveLiveness,
  validateCommand,
} from "./contract.js";

/**
 * Plain-JS contract tests for the plugin mirror.
 *
 * Cross-implementation parity against the TypeScript side lives in
 * `src/__tests__/durable-member-contract-parity.test.ts` (shared fixtures). This
 * file pins the plugin-only UX surface bits the parity test does not model:
 * which controls the panel offers and how a task line reads.
 */

const envelope = {
  requestId: "req-1",
  memberId: "member-a",
  authority: "panel-human",
  issuedAt: 1000,
};

function entry(id, timestamp, text, cursor) {
  return {
    id,
    conversationId: "member-a:main",
    cursor: cursor ?? String(timestamp),
    role: "assistant",
    kind: "message",
    timestamp,
    text,
  };
}

describe("validateCommand (plugin mirror)", () => {
  it("accepts a steer and preserves its text", () => {
    const validated = validateCommand({ kind: "steer", ...envelope, text: "look first" });
    expect(validated.ok).toBe(true);
    expect(validated.value).toMatchObject({ kind: "steer", text: "look first" });
  });

  it("refuses a requestId that could escape the commands directory", () => {
    expect(validateCommand({ kind: "steer", ...envelope, requestId: "../../x", text: "x" })).toMatchObject(
      { ok: false, code: "missing-request-id" },
    );
  });

  it("refuses oversized text", () => {
    expect(
      validateCommand({ kind: "steer", ...envelope, text: "a".repeat(64 * 1024 + 1) }),
    ).toMatchObject({ ok: false, code: "text-too-large" });
  });
});

describe("controlAvailability", () => {
  it("offers the free controls without confirmation", () => {
    for (const kind of ["steer", "followup", "write", "abort", "abort-submission", "compact"]) {
      expect(controlAvailability({ kind, memberId: "member-a" }).available, kind).toBe(true);
    }
  });

  it("gates configure and reset behind the member-id confirmation", () => {
    expect(controlAvailability({ kind: "reset", memberId: "member-a" })).toEqual({
      available: false,
      requiresConfirmation: "missing",
    });
    expect(
      controlAvailability({ kind: "configure", memberId: "member-a", confirmation: "member-b" }),
    ).toEqual({ available: false, requiresConfirmation: "mismatch" });
    expect(
      controlAvailability({ kind: "configure", memberId: "member-a", confirmation: "member-a" }),
    ).toEqual({ available: true, requiresConfirmation: false });
  });

  it("does not offer an unknown control", () => {
    expect(controlAvailability({ kind: "terminate", memberId: "member-a" }).available).toBe(false);
  });
});

describe("reduceConversationFrames", () => {
  it("dedupes by id, orders by timestamp and caps the window", () => {
    const first = reduceConversationFrames(undefined, {
      conversationId: "member-a:main",
      entriesWindow: [entry("e2", 20, "two"), entry("e1", 10, "one")],
      cursor: "10",
      hasEarlier: true,
      live: null,
      emittedAt: 1,
    });
    expect(first.entries.map((row) => row.id)).toEqual(["e1", "e2"]);
    expect(first.cursor).toBe("10");
    expect(first.hasEarlier).toBe(true);

    const second = reduceConversationFrames(
      first,
      {
        conversationId: "member-a:main",
        entriesWindow: [entry("e2", 20, "two final"), entry("e3", 30, "three")],
        cursor: "20",
        hasEarlier: false,
        live: null,
        emittedAt: 2,
      },
      { maxEntries: 2 },
    );
    expect(second.entries.map((row) => row.id)).toEqual(["e2", "e3"]);
    expect(second.entries[0].text).toBe("two final");
    expect(second.hasEarlier).toBe(true);

    expect(DEFAULT_VIEW_WINDOW).toBeGreaterThan(2);
  });

  it("restarts the view when the frame belongs to another conversation", () => {
    const state = reduceConversationFrames(undefined, {
      conversationId: "member-a:main",
      entriesWindow: [entry("e1", 10, "one")],
      cursor: "10",
      hasEarlier: false,
      live: null,
      emittedAt: 1,
    });
    const other = reduceConversationFrames(state, {
      conversationId: "member-b:child",
      entriesWindow: [{ ...entry("e9", 5, "other"), conversationId: "member-b:child", cursor: "1" }],
      cursor: "1",
      hasEarlier: false,
      live: null,
      emittedAt: 2,
    });
    expect(other.conversationId).toBe("member-b:child");
    expect(other.entries.map((row) => row.id)).toEqual(["e9"]);
  });
});

describe("mergeEarlierTranscriptPage", () => {
  it("prepends older entries and takes the page's paging state", () => {
    const state = {
      conversationId: "member-a:main",
      entries: [entry("e2", 20, "two")],
      cursor: "20",
      hasEarlier: true,
      live: null,
    };
    const merged = mergeEarlierTranscriptPage(state, {
      entries: [entry("e1", 10, "one")],
      cursor: "10",
      hasEarlier: false,
    });
    expect(merged.entries.map((row) => row.id)).toEqual(["e1", "e2"]);
    expect(merged.cursor).toBe("10");
    expect(merged.hasEarlier).toBe(false);
  });
});

describe("reduceLiveLiveness (plugin mirror)", () => {
  const generation = {
    conversationId: "member-a:main",
    generationId: "gen-1",
    status: "streaming",
    partialText: "working",
    startedAt: 1_000,
    updatedAt: 2_000,
    attempt: 1,
    toolCalls: [],
  };

  it("keeps a fresh generation live", () => {
    expect(reduceLiveLiveness({ live: generation, now: 2_001 })).toEqual({
      kind: "live",
      live: generation,
    });
  });

  it("stales a generation the owner stopped heartbeating", () => {
    // The panel path has no process probe, so the heartbeat bound is what turns
    // a crashed owner's leftover `streaming` row into a stale one.
    expect(
      reduceLiveLiveness({ live: generation, now: 2_000 + DEFAULT_LIVE_STALE_AFTER_MS }),
    ).toMatchObject({ kind: "stale", reason: "no-heartbeat" });
  });

  it("stales a fresh generation when the caller knows the owner is gone", () => {
    expect(reduceLiveLiveness({ live: generation, now: 2_001, ownerAlive: false })).toMatchObject({
      kind: "stale",
      reason: "owner-gone",
    });
  });

  it("reports a stale generation instead of dropping it, flagged not streaming", () => {
    const annotated = annotateLiveGeneration(
      reduceLiveLiveness({ live: generation, now: 2_001, ownerAlive: false }),
    );
    expect(annotated).toMatchObject({
      generationId: "gen-1",
      stale: true,
      staleReason: "owner-gone",
    });
    expect(annotateLiveGeneration({ kind: "none" })).toBeNull();
  });
});

describe("formatTaskLine", () => {
  it("renders owner edge, waiting-on and the background flag", () => {
    expect(
      formatTaskLine({
        id: "task-2",
        title: "implement",
        status: "blocked",
        owner: { memberId: "member-a", edge: "child" },
        waitingOn: ["task-1"],
        background: true,
      }),
    ).toBe("task-2 [blocked] child:member-a · waiting on task-1 · background — implement");
  });

  it("renders an unowned, unblocked task", () => {
    expect(
      formatTaskLine({
        id: "task-1",
        title: "scout",
        status: "done",
        waitingOn: [],
        background: false,
      }),
    ).toBe("task-1 [done] unowned · not waiting · foreground — scout");
  });
});
