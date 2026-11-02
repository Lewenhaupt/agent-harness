import { describe, expect, expectTypeOf, it } from "vitest";
import {
  authorizeDurableCommand,
  bindOwnerAuthority,
  type VerifiedAuthority,
  verifyAuthorityClaim,
} from "../durable-member/authority.js";
import {
  DURABLE_AUTHORITIES,
  DURABLE_COMMAND_KINDS,
  type DurableAuthority,
  type DurableCommand,
  type DurableCommandKind,
} from "../durable-member/commands.js";
import { makeCommand, TEST_MEMBER_ID } from "./durable-fixtures.js";

/** Expected allow/refuse matrix, written out per role so a silent edit fails. */
const MATRIX: Record<DurableAuthority, Record<DurableCommandKind, boolean>> = {
  "panel-human": {
    steer: true,
    followup: true,
    write: true,
    "abort-submission": true,
    abort: true,
    configure: true,
    compact: true,
    reset: true,
  },
  "fleet-supervisor": {
    steer: false,
    followup: false,
    write: false,
    "abort-submission": true,
    abort: true,
    configure: false,
    compact: false,
    reset: false,
  },
  "phase-subagent": {
    steer: false,
    followup: false,
    write: false,
    "abort-submission": false,
    abort: false,
    configure: false,
    compact: false,
    reset: false,
  },
};

function contextFor(authority: DurableAuthority) {
  return { memberId: TEST_MEMBER_ID, authority: bindOwnerAuthority(authority) };
}

describe("authorizeDurableCommand matrix", () => {
  for (const authority of DURABLE_AUTHORITIES) {
    for (const kind of DURABLE_COMMAND_KINDS) {
      const expected = MATRIX[authority][kind];
      it(`${authority} ${expected ? "may" : "may not"} send ${kind}`, () => {
        const command = makeCommand(kind, { authority });
        const result = authorizeDurableCommand(command, contextFor(authority));
        expect(result.ok).toBe(expected);
        if (!result.ok) {
          expect(result.reason).toBe("role-not-permitted");
          expect(result.error).toContain(authority);
          expect(result.error).toContain(kind);
        }
      });
    }
  }

  it("refuses a command addressed to another member", () => {
    const command = makeCommand("steer", { memberId: "member-b" });
    const result = authorizeDurableCommand(command, contextFor("panel-human"));
    expect(result).toMatchObject({ ok: false, reason: "member-mismatch" });
  });
});

describe("authorizeDurableCommand confirmation gate", () => {
  it("refuses configure/reset without a confirmation and names the required token", () => {
    for (const kind of ["configure", "reset"] as const) {
      const command = makeCommand(kind, { confirmation: undefined });
      const result = authorizeDurableCommand(command, contextFor("panel-human"));
      expect(result).toMatchObject({
        ok: false,
        reason: "confirmation-required",
        requiredConfirmation: TEST_MEMBER_ID,
      });
      if (!result.ok) expect(result.error).toContain(TEST_MEMBER_ID);
    }
  });

  it("refuses a confirmation that does not equal the member id", () => {
    for (const kind of ["configure", "reset"] as const) {
      const command = makeCommand(kind, { confirmation: "member-b" });
      const result = authorizeDurableCommand(command, contextFor("panel-human"));
      expect(result).toMatchObject({
        ok: false,
        reason: "confirmation-mismatch",
        requiredConfirmation: TEST_MEMBER_ID,
      });
    }
  });

  it("allows the gated kinds once the member id is confirmed", () => {
    for (const kind of ["configure", "reset"] as const) {
      expect(authorizeDurableCommand(makeCommand(kind), contextFor("panel-human"))).toMatchObject({
        ok: true,
      });
    }
  });

  it("ignores a stray confirmation on a kind that is not gated", () => {
    const command = makeCommand("steer", { confirmation: "nonsense" });
    expect(authorizeDurableCommand(command, contextFor("panel-human"))).toMatchObject({ ok: true });
  });

  it("does not let a supervisor reach a gated kind with a matching confirmation", () => {
    const command = makeCommand("reset", {
      authority: "fleet-supervisor",
      confirmation: TEST_MEMBER_ID,
    }) as DurableCommand;
    expect(authorizeDurableCommand(command, contextFor("fleet-supervisor"))).toMatchObject({
      ok: false,
      reason: "role-not-permitted",
    });
  });
});

describe("verified caller identity", () => {
  it("refuses a content steer whose claim disagrees with the bound tier", () => {
    const command = makeCommand("steer", { authority: "panel-human" });
    const result = authorizeDurableCommand(command, contextFor("fleet-supervisor"));
    expect(result).toMatchObject({ ok: false, reason: "authority-mismatch" });
  });

  it("refuses a gated reset claimed as panel-human on a supervisor binding", () => {
    const command = makeCommand("reset", { authority: "panel-human" });
    const result = authorizeDurableCommand(command, contextFor("fleet-supervisor"));
    expect(result).toMatchObject({ ok: false, reason: "authority-mismatch" });
  });

  it("does not accept a raw tier string where a verified identity is required", () => {
    // The brand is what prevents the escalation: a `DurableAuthority` string is
    // not assignable to `VerifiedAuthority`, so this mistake cannot compile.
    expectTypeOf<DurableAuthority>().not.toMatchTypeOf<VerifiedAuthority>();
    expectTypeOf<VerifiedAuthority["tier"]>().toEqualTypeOf<DurableAuthority>();
  });

  it("verifyAuthorityClaim accepts the bound tier and refuses any other claim", () => {
    const bound = bindOwnerAuthority("fleet-supervisor");
    expect(verifyAuthorityClaim(bound, "fleet-supervisor")).toMatchObject({ ok: true });
    expect(verifyAuthorityClaim(bound, "panel-human")).toMatchObject({
      ok: false,
      reason: "authority-mismatch",
    });
  });
});
