/**
 * The `BELAYD_PROOF_VERIFIER` deployment switch.
 *
 * The verifier is advisory only, so the switch is the only thing that decides
 * whether a session is offered the tool at all: an unset variable, an empty
 * string or any other spelling must leave it dark, and an explicit enable is the
 * only way back on.
 */

import { describe, expect, it } from "vitest";

import {
  isProofVerifierEnabled,
  PROOF_VERIFIER_ENV,
  PROOF_VERIFIER_TOOL,
} from "../proof-verifier-env.js";

describe("isProofVerifierEnabled", () => {
  it("is off when the variable is absent", () => {
    expect(isProofVerifierEnabled({})).toBe(false);
  });

  it("accepts the explicit enable spellings", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(isProofVerifierEnabled({ [PROOF_VERIFIER_ENV]: value }), value).toBe(true);
    }
  });

  it("stays off for the disable spellings and empty values", () => {
    for (const value of ["", "0", "false", "off", "no", "disabled", "2"]) {
      expect(isProofVerifierEnabled({ [PROOF_VERIFIER_ENV]: value }), value).toBe(false);
    }
  });

  it("reads only its own variable", () => {
    expect(isProofVerifierEnabled({ BELAYD_METRICS: "1", BELAYD_PROOF_DIR: "1" })).toBe(false);
  });
});

describe("PROOF_VERIFIER_TOOL", () => {
  it("is the pi tool name the registries list", () => {
    expect(PROOF_VERIFIER_TOOL).toBe("belayd_proof_verifier");
  });
});
