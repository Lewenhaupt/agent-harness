/**
 * Cross-extension registration dedup.
 *
 * Several harness copies can load into one pi session: the Nix-installed
 * global copy, the project `.pi/settings.json` copy, and the explicit `-e`
 * copies from `bin/pi`. They share the extension load batch's event bus, so
 * each copy probes the bus for an existing registration claim and only the
 * first copy registers its tools/commands. Without this, pi's post-load
 * conflict detection reports every duplicated `belayd_*` tool as
 * "Tool X conflicts with ...".
 *
 * The counter travels through `emit` as the event payload, so every listener
 * (our own plus any earlier copy's) mutates the *same* object. Per-call state
 * would only see its own increment and never detect a prior copy. `emit`
 * dispatches synchronously (the bus wraps handlers in async fns, but the
 * handler body up to its first `await` runs before `emit` returns), so the
 * count is final when `emit` returns.
 *
 * Scoping to the bus (rather than a process-wide boolean) is deliberate: the
 * provider-bootstrap pass and each real session get their own bus, so a claim
 * is "this session". A process-wide flag leaked across pi-web's bootstrap pass
 * and the sessions that followed, so later sessions registered nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * True when no other extension in this load batch has claimed `channel`.
 *
 * The probe listener is left in place for the first copy so later copies in
 * the same batch count it and yield; the shared bus is discarded with its
 * session, so nothing leaks across sessions.
 */
export function claimRegistrationOnce(pi: ExtensionAPI, channel: string): boolean {
  const counter = { responses: 0 };
  const respond = (data: unknown): void => {
    (data as { responses: number }).responses += 1;
  };
  const unsubscribe = pi.events.on(channel, respond);
  pi.events.emit(channel, counter);

  const isFirstCopy = counter.responses <= 1;
  if (!isFirstCopy) {
    unsubscribe();
  }
  return isFirstCopy;
}
