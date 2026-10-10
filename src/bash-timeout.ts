/**
 * Enforce a bounded timeout on every agent bash call.
 *
 * Pi's built-in bash tool accepts an optional `timeout` in seconds and has no
 * default, so an omitted timeout lets a command run until pi's own ~24-day
 * ceiling. The `tool_call` extension hook can mutate `event.input` in place
 * before execution, so the harness patches a deterministic value in. The
 * policy is intentionally hardcoded: there is no env-var or settings knob.
 */

/** Timeout applied when the caller supplied no usable value. */
export const BASH_DEFAULT_TIMEOUT_SECONDS = 600;

/** Upper bound; larger explicit values are clamped to this. */
export const BASH_MAX_TIMEOUT_SECONDS = 1800;

/**
 * Resolve the effective bash timeout, in seconds.
 *
 * Only a finite, positive number within the cap is honored unchanged. A finite
 * number above the cap is clamped, and everything else (undefined, NaN,
 * Infinity, zero, negatives, non-numbers) falls back to the default. Pi does
 * not re-validate mutated input, so the guarantee here is that the returned
 * value is always a positive finite number no greater than the cap.
 */
export function resolveBashTimeout(input: { timeout?: unknown }): number {
  const value = input.timeout;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return BASH_DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(value, BASH_MAX_TIMEOUT_SECONDS);
}
