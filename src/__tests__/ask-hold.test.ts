import { describe, expect, it } from "vitest";
import {
  ASK_USER_ANSWERS_CUSTOM_TYPE,
  ASK_USER_TOOL_NAME,
  askTail,
  shouldHoldFollowUp,
} from "../ask-hold.js";

/** A successful `ask_user` tool result, as PI WEB persists it. */
function askResult(askId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "message",
    id: `result-${askId}`,
    message: {
      role: "toolResult",
      toolName: ASK_USER_TOOL_NAME,
      isError: false,
      details: { ask: { askId, askedAt: "2026-10-30T07:58:06.943Z", questions: [] } },
      ...extra,
    },
  };
}

function answersEntry(askId: string, reason: "submitted" | "cancelled" = "submitted"): unknown {
  return {
    type: "custom_message",
    id: `answers-${askId}`,
    customType: ASK_USER_ANSWERS_CUSTOM_TYPE,
    content: "The user submitted answers to your questions.",
    display: true,
    details: { askId, reason },
  };
}

function userMessage(text: string): unknown {
  return {
    type: "message",
    id: `user-${text}`,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantMessage(text: string): unknown {
  return {
    type: "message",
    id: `assistant-${text}`,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function toolResult(toolName: string): unknown {
  return {
    type: "message",
    id: `tool-${toolName}`,
    message: { role: "toolResult", toolName, isError: false, content: [] },
  };
}

describe("askTail", () => {
  it("reports no question set for an empty or question-free session", () => {
    expect(askTail([])).toEqual({ kind: "none" });
    expect(askTail([userMessage("hi"), assistantMessage("hello"), toolResult("bash")])).toEqual({
      kind: "none",
    });
  });

  it("reports the newest question set as open while nothing follows it", () => {
    expect(askTail([userMessage("go"), askResult("ask-1")])).toEqual({
      kind: "open",
      askId: "ask-1",
    });
  });

  it("keeps the set open when only unrelated entries follow it", () => {
    const tail = [
      askResult("ask-1"),
      assistantMessage("thinking about the answers"),
      toolResult("bd"),
      assistantMessage(""),
    ];
    expect(shouldHoldFollowUp(tail)).toBe(true);
  });

  it.each([
    ["a submitted answer", answersEntry("ask-1", "submitted")],
    ["a skipped answer", answersEntry("ask-1", "cancelled")],
  ])("closes the set on %s", (_label, closer) => {
    expect(askTail([askResult("ask-1"), closer])).toEqual({ kind: "closed" });
    expect(shouldHoldFollowUp([askResult("ask-1"), closer])).toBe(false);
  });

  it("closes the set when the human moved on with their own message", () => {
    expect(askTail([askResult("ask-1"), userMessage("never mind, do this instead")])).toEqual({
      kind: "closed",
    });
  });

  it("reports the newer of two question sets", () => {
    expect(askTail([askResult("ask-1"), askResult("ask-2")])).toEqual({
      kind: "open",
      askId: "ask-2",
    });
    expect(askTail([askResult("ask-1"), answersEntry("ask-1"), askResult("ask-2")])).toEqual({
      kind: "open",
      askId: "ask-2",
    });
  });

  it("does not resurrect an older set once the newer one is answered", () => {
    expect(
      askTail([
        askResult("ask-1"),
        answersEntry("ask-1"),
        askResult("ask-2"),
        answersEntry("ask-2"),
      ]),
    ).toEqual({ kind: "closed" });
  });

  it("ignores a failed ask_user result, which posts no form", () => {
    const failed = {
      type: "message",
      id: "failed",
      message: {
        role: "toolResult",
        toolName: ASK_USER_TOOL_NAME,
        isError: true,
        details: {},
        content: [],
      },
    };
    expect(askTail([failed])).toEqual({ kind: "none" });
  });

  it("ignores an ask_user result without a durable question payload", () => {
    const legacy = {
      type: "message",
      id: "legacy",
      message: {
        role: "toolResult",
        toolName: ASK_USER_TOOL_NAME,
        isError: false,
        details: { superseded: {} },
        content: [],
      },
    };
    expect(askTail([legacy])).toEqual({ kind: "none" });
    expect(askTail([askResult(""), userMessage("x")])).toEqual({ kind: "none" });
  });

  it("ignores malformed entries instead of throwing", () => {
    expect(
      askTail([
        null,
        7,
        "text",
        {},
        { type: "message" },
        { type: "message", message: 4 },
        askResult("ask-9"),
      ]),
    ).toEqual({
      kind: "open",
      askId: "ask-9",
    });
  });
});
