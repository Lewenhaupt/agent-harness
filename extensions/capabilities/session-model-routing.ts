/**
 * Session model pre-flight (bd-257).
 *
 * bd-229 taught the `/belayd` launch path to move a *newborn orchestrator* off a
 * spent provider, but a session the operator creates directly in pi-web got no
 * such check: it started on the global default
 * (`~/.pi/agent/settings.json` → `defaultProvider`/`defaultModel`) verbatim, and
 * when that default was cooling for quota its first turn spent a `402` before
 * `model-recovery` could switch. One failed request per session, and none at all
 * when the first failure is not classified as fallback-worthy.
 *
 * This capability closes that gap at `session_start`, before the first turn:
 *
 * - it switches only when the session's current provider/endpoint is *known*
 *   unable to serve (cooldown store or capacity window). A healthy default is
 *   left exactly as the operator chose it — this must not fight the operator.
 * - the accepted model is recorded by `pi.setModel` in the session transcript
 *   (`appendModelChange`), so it survives a restart without rewriting the
 *   operator's global default.
 * - when no candidate can serve, the session is told so once, naming every
 *   blocked provider and its reset window, instead of starting silently dead.
 *
 * Phase sub-agents are deliberately excluded: each spawn resolves its own model
 * (`resolveModelSpec` plus the workflow's per-phase override) and its fallback
 * accounting belongs to `spawn-with-fallback`. A session-level switch here would
 * tell those attempts and the telemetry a model the phase did not run on.
 *
 * `BELAYD_MODEL_FALLBACK=0` disables the whole pre-flight, like every other
 * routing decision.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeBlockedProviders, planModelRoute } from "../../src/orchestrator-model.js";
import {
  candidateBlocked,
  currentModelId,
  exhaustionWindows,
  type ModelAvailabilityRouting,
  refreshModelAvailability,
  switchToFirstUsableModel,
} from "./model-availability.js";

/** Everything the session pre-flight needs from its host. */
export interface SessionModelRoutingDeps {
  pi: ExtensionAPI;
  routing: ModelAvailabilityRouting & { enabled: boolean };
  /** True for a phase sub-agent session, whose model accounting lives in the spawner. */
  isSubAgent: (ctx: ExtensionContext) => boolean;
  /** Reports the routing decision; defaults to the harness log sink. */
  notify?: (text: string, level: "info" | "warning") => void;
}

export function registerSessionModelRouting(deps: SessionModelRoutingDeps): void {
  const { pi, routing } = deps;
  const notify = deps.notify ?? logNotice;

  pi.on("session_start", async (_event, ctx) => {
    try {
      // Kill switch first: a disabled pre-flight must not even read the stores.
      if (!routing.enabled) return;
      // Phase sub-agents are owned by spawn-with-fallback's per-attempt accounting.
      if (deps.isSubAgent(ctx)) return;

      const current = currentModelId(ctx);
      if (current === undefined) return;

      // One decision before the first turn, so it pays for a current capacity
      // signal: the probe is TTL-gated, so this permits a stale-cache read
      // rather than forcing one. Cooldown freshness needs nothing extra — reads
      // go straight to the shared store (bd-256).
      await refreshModelAvailability(routing, { probeCapacity: true });
      const plan = planModelRoute({
        current,
        isBlocked: (candidate) => candidateBlocked(routing, candidate),
      });

      // The operator's model is healthy: leave it alone, silently.
      //
      // A `/belayd` child (`belayd-<taskId>`, no `-sub-`) also reaches this hook,
      // on its own `session_start` and before the launch path's
      // `POST /sessions/:id/model`. That overlap is deliberate and harmless: both
      // paths run the same deterministic plan, so whichever observes second sees
      // an already-routed model (`currentUsable`) and does nothing. A double
      // apply needs the launch path's status read to race the child's switch, and
      // even then both apply the same candidate.
      if (plan.currentUsable) return;

      const switched = await switchToFirstUsableModel(pi, ctx, plan.available);
      if (switched !== undefined) {
        const reason = describeBlockedProviders({
          candidates: [current],
          windows: exhaustionWindows(routing),
          nowMs: Date.now(),
        });
        notify(
          `session model routed from ${current} to ${switched} because ${reason} cannot serve a turn.`,
          "info",
        );
        return;
      }

      // Every candidate is blocked (or none has a credential): report it, and do
      // NOT start a turn on a model that cannot serve one.
      const named = describeBlockedProviders({
        candidates: plan.blocked,
        windows: exhaustionWindows(routing),
        nowMs: Date.now(),
      });
      const blocked =
        `No model candidate can serve this session's first turn (${named}). ` +
        "Wait for that window to lapse or top up the provider, then retry; " +
        "BELAYD_MODEL_FALLBACK=0 skips this check, but the first turn will fail on " +
        "the same provider.";
      notify(blocked, "warning");
      ctx.ui.notify(blocked, "warning");
    } catch (error) {
      // Never abort the remaining `session_start` handlers (telemetry reset,
      // bd-187 provider wrapping, gate resume): a routing failure is reported,
      // not thrown.
      const message = error instanceof Error ? error.message : String(error);
      notify(`session model pre-flight failed: ${message}`, "warning");
    }
  });
}

/** Default notice sink: the harness log, so the decision is visible without a UI. */
function logNotice(text: string, level: "info" | "warning"): void {
  const line = `[belayd-harness] ${text}`;
  if (level === "warning") console.warn(line);
  else console.log(line);
}
