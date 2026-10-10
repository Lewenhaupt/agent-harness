import { describe, expect, it } from "vitest";

import { lastAssistantText } from "../session-transcript.js";

function assistantMessage(content: unknown): { type: string; message: unknown } {
  return { type: "message", message: { role: "assistant", content } };
}

describe("lastAssistantText", () => {
  it("returns the text of the last assistant message", () => {
    const branch = [
      { type: "message", message: { role: "user", content: "hello" } },
      assistantMessage([{ type: "text", text: "the answer" }]),
    ];
    expect(lastAssistantText(branch)).toBe("the answer");
  });

  it("skips thinking and toolCall blocks and keeps only text", () => {
    const branch = [
      assistantMessage([
        { type: "thinking", thinking: "internal reasoning" },
        { type: "text", text: "visible answer" },
        { type: "toolCall", toolName: "read", args: {} },
      ]),
    ];
    expect(lastAssistantText(branch)).toBe("visible answer");
  });

  it("concatenates multiple text blocks", () => {
    const branch = [
      assistantMessage([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ];
    expect(lastAssistantText(branch)).toBe("first\nsecond");
  });

  it("accepts a plain string content", () => {
    expect(lastAssistantText([assistantMessage("plain text")])).toBe("plain text");
  });

  it("returns only the last assistant message when several exist", () => {
    const branch = [
      assistantMessage([{ type: "text", text: "older" }]),
      { type: "message", message: { role: "user", content: "follow-up" } },
      assistantMessage([{ type: "text", text: "newer" }]),
    ];
    expect(lastAssistantText(branch)).toBe("newer");
  });

  it("returns undefined when no assistant message exists", () => {
    const branch = [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "tool", content: "result" } },
    ];
    expect(lastAssistantText(branch)).toBe(undefined);
  });

  it("returns undefined for an assistant message with no text blocks", () => {
    const branch = [
      assistantMessage([{ type: "thinking", thinking: "only thoughts" }]),
      assistantMessage([{ type: "toolCall", toolName: "read", args: {} }]),
    ];
    expect(lastAssistantText(branch)).toBe(undefined);
  });

  it("ignores non-message entries and malformed entries", () => {
    const branch = [
      { type: "custom", customType: "x", data: {} },
      { type: "message" },
      { type: "message", message: null },
      assistantMessage([{ type: "text", text: "recovered" }]),
      { type: "usage" },
    ];
    expect(lastAssistantText(branch)).toBe("recovered");
  });

  it("returns undefined for an empty branch", () => {
    expect(lastAssistantText([])).toBe(undefined);
  });

  it("returns the empty string for a text block whose text is empty", () => {
    // Pins the current behavior: an explicit empty text block is distinct from
    // "no assistant message". Callers treat "" as "no report" and error out.
    expect(lastAssistantText([assistantMessage([{ type: "text", text: "" }])])).toBe("");
  });

  it("returns undefined for an empty content array", () => {
    expect(lastAssistantText([assistantMessage([])])).toBe(undefined);
  });

  it("returns undefined when content is neither a string nor an array", () => {
    expect(lastAssistantText([assistantMessage({ type: "text", text: "nested" })])).toBe(undefined);
  });

  it("ignores text blocks whose text is not a string", () => {
    expect(lastAssistantText([assistantMessage([{ type: "text", text: 42 }])])).toBe(undefined);
  });

  it("does not fall back to an earlier assistant when the last carries no text", () => {
    // The recovery target is the *last* assistant turn; a textless final turn
    // (e.g. a toolCall-only message) must not silently surface a stale answer.
    const branch = [
      assistantMessage([{ type: "text", text: "earlier answer" }]),
      assistantMessage([{ type: "thinking", thinking: "still working" }]),
    ];
    expect(lastAssistantText(branch)).toBe(undefined);
  });
});
