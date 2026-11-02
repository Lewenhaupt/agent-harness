import { describe, expect, it } from "vitest";
import {
  DURABLE_COMMAND_KINDS,
  MAX_DURABLE_COMMAND_TEXT_BYTES,
  validateDurableCommand,
} from "../durable-member/commands.js";
import { makeCommand, TEST_MEMBER_ID } from "./durable-fixtures.js";

const baseEnvelope = {
  requestId: "req-1",
  memberId: TEST_MEMBER_ID,
  authority: "panel-human" as const,
  issuedAt: 1_000,
};

describe("validateDurableCommand", () => {
  it("accepts every command kind the control plane carries", () => {
    for (const kind of DURABLE_COMMAND_KINDS) {
      const validated = validateDurableCommand(makeCommand(kind));
      expect(validated.ok, kind).toBe(true);
    }
  });

  it("keeps the envelope and the kind-specific payload on the value", () => {
    const validated = validateDurableCommand({
      kind: "steer",
      ...baseEnvelope,
      text: "  look at the gate first  ",
    });

    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value).toMatchObject({
      kind: "steer",
      requestId: "req-1",
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      issuedAt: 1_000,
      // Text is preserved verbatim: leading whitespace can be meaningful in a
      // prompt fragment, so the validator bounds it rather than trimming it.
      text: "  look at the gate first  ",
    });
  });

  it("rejects an unknown kind", () => {
    const validated = validateDurableCommand({ kind: "steer-somewhere", ...baseEnvelope });
    expect(validated).toMatchObject({ ok: false, code: "unknown-kind" });
  });

  it("rejects a non-object payload", () => {
    expect(validateDurableCommand("steer")).toMatchObject({ ok: false, code: "invalid-shape" });
    expect(validateDurableCommand([baseEnvelope])).toMatchObject({
      ok: false,
      code: "invalid-shape",
    });
  });

  it("rejects a missing, blank or path-like requestId", () => {
    expect(
      validateDurableCommand({ kind: "steer", ...baseEnvelope, requestId: "", text: "x" }),
    ).toMatchObject({ ok: false, code: "missing-request-id" });
    expect(
      validateDurableCommand({ kind: "steer", ...baseEnvelope, requestId: "../escape", text: "x" }),
    ).toMatchObject({ ok: false, code: "missing-request-id" });
    expect(
      validateDurableCommand({ kind: "steer", ...baseEnvelope, requestId: "a/b", text: "x" }),
    ).toMatchObject({ ok: false, code: "missing-request-id" });
  });

  it("rejects a memberId outside the owning member when scoped", () => {
    const validated = validateDurableCommand(
      { kind: "steer", ...baseEnvelope, memberId: "member-b", text: "x" },
      { memberId: TEST_MEMBER_ID },
    );
    expect(validated).toMatchObject({ ok: false, code: "member-mismatch" });
  });

  it("rejects an unknown authority and a non-epoch issuedAt", () => {
    expect(
      validateDurableCommand({ kind: "steer", ...baseEnvelope, authority: "root", text: "x" }),
    ).toMatchObject({ ok: false, code: "unknown-authority" });
    expect(
      validateDurableCommand({ kind: "steer", ...baseEnvelope, issuedAt: -1, text: "x" }),
    ).toMatchObject({ ok: false, code: "invalid-issued-at" });
  });

  it("distinguishes missing text from oversized text", () => {
    expect(validateDurableCommand({ kind: "steer", ...baseEnvelope, text: "   " })).toMatchObject({
      ok: false,
      code: "missing-text",
    });
    expect(
      validateDurableCommand({
        kind: "steer",
        ...baseEnvelope,
        text: "a".repeat(MAX_DURABLE_COMMAND_TEXT_BYTES + 1),
      }),
    ).toMatchObject({ ok: false, code: "text-too-large" });
    expect(
      validateDurableCommand({
        kind: "steer",
        ...baseEnvelope,
        text: "a".repeat(MAX_DURABLE_COMMAND_TEXT_BYTES),
      }).ok,
    ).toBe(true);
  });

  it("bounds write entries, abort-submission ids and configure payloads", () => {
    expect(
      validateDurableCommand({
        kind: "write",
        ...baseEnvelope,
        entry: { role: "root", text: "x" },
      }),
    ).toMatchObject({ ok: false, code: "invalid-entry" });
    expect(validateDurableCommand({ kind: "abort-submission", ...baseEnvelope })).toMatchObject({
      ok: false,
      code: "invalid-submission-id",
    });
    expect(
      validateDurableCommand({ kind: "configure", ...baseEnvelope, config: { model: "" } }),
    ).toMatchObject({ ok: false, code: "invalid-config" });
    expect(
      validateDurableCommand({ kind: "configure", ...baseEnvelope, config: { unknown: "field" } }),
    ).toMatchObject({ ok: false, code: "invalid-config" });
  });

  it("rejects a non-string confirmation but leaves the gate to authority.ts", () => {
    expect(
      validateDurableCommand({ kind: "reset", ...baseEnvelope, confirmation: 42 }),
    ).toMatchObject({ ok: false, code: "invalid-confirmation" });
    // Validation does not enforce the gate: a reset without confirmation is a
    // well-formed command that the owner refuses for a different reason.
    expect(validateDurableCommand({ kind: "reset", ...baseEnvelope }).ok).toBe(true);
  });
});
