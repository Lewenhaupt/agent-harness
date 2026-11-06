/**
 * Deployment switch for the advisory `belayd_proof_verifier` tool.
 *
 * Off unless `BELAYD_PROOF_VERIFIER=1`. Measured use (175 recorded runs across
 * this repository and the proof-of-work platform) found one `reasonable: false`
 * verdict ever, ~14% of runs returning no output at all, and the verdict readable
 * by nobody but the model that asked for it — so the tool ships dark instead of
 * charging an extra judge run per proof phase. The deterministic proof gate
 * (`gateProofContent`) is unaffected: it never consulted this tool.
 *
 * `src/proof-verification.ts` stays in use (artifact refs, the quality gate and
 * the publish gate all import it); only the tool registration is gated.
 */

/** Env var that turns the advisory verifier on. */
export const PROOF_VERIFIER_ENV = "BELAYD_PROOF_VERIFIER";

/** The tool name, so the flag and the registries cannot drift apart. */
export const PROOF_VERIFIER_TOOL = "belayd_proof_verifier";

const ENABLED_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/**
 * Whether the advisory proof verifier should be registered.
 *
 * Anything other than an explicit enable is off, including an unset variable,
 * an empty string and the `0`/`false`/`off` spellings a shell profile might
 * carry.
 */
export function isProofVerifierEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[PROOF_VERIFIER_ENV];
  if (raw === undefined) return false;
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}
