/**
 * Model capability: the model-routing state (bd-116) and its telemetry sink
 * (bd-179).
 *
 * One object owns the pre-dispatch capacity cache and the per-workflow telemetry
 * store; this module is the documented module-level mutable-state exception for
 * model routing (see AGENTS.md) and owns every reset/flush rule. Consumers
 * import it rather than threading it through dependency objects.
 */
import {
  CAPACITY_PROBE_URL_ENV,
  createCapacityCache,
  createEndpointCapacityProbe,
  createFallbackCapacityProbe,
  probeFromCooldownStore,
} from "../../src/capacity-cache.js";
import { createModelCooldownStore, defaultModelCooldownPath } from "../../src/model-cooldown.js";
import {
  createModelSessionState,
  flushAndResetModelTelemetry,
  flushModelTelemetry,
  shouldWarnFlushFailure,
} from "../../src/model-session-state.js";
import { formatModelTelemetrySummary } from "../../src/model-telemetry.js";

// limit, subsequent spawns in this session skip it until the cooldown lapses.
// Persisted to disk so cooldowns survive orchestrator restarts; the file is
// shared with other fleet members, so the capacity probe re-reads it (refresh)
// and an unhinted quota window escalates on repeat instead of re-probing.
// Kill switch: BELAYD_MODEL_FALLBACK=0 disables candidate fallback entirely.
export const modelCooldown = createModelCooldownStore({ filePath: defaultModelCooldownPath() });
// Pre-dispatch capacity signal. When a usage/reset endpoint is configured it
// is probed directly; otherwise the persisted cooldown store's provider windows
// stand in. Results are cached (TTL) so a multi-phase workflow re-probes at
// most once per TTL, and mid-workflow 429s are recorded back into the cache.
const capacityProbeUrl = process.env[CAPACITY_PROBE_URL_ENV];
// Session-scoped model-routing state (bd-116): the pre-dispatch capacity
// cache, the per-workflow telemetry store, and the per-destination telemetry
// flush cursors. This one object is the documented module-level mutable-state
// exception for model routing; the module owns its reset semantics.
export const modelState = createModelSessionState({
  capacity:
    capacityProbeUrl !== undefined && capacityProbeUrl !== ""
      ? createCapacityCache({
          // A configured-but-unreachable endpoint must not silently disable the
          // capacity signal: fall back to the persisted cooldown store and warn
          // (throttled inside the probe) that the endpoint is not delivering.
          probe: createFallbackCapacityProbe(
            createEndpointCapacityProbe({
              url: capacityProbeUrl,
              onFailure: (reason) => {
                console.warn(
                  `[belayd-harness] ${CAPACITY_PROBE_URL_ENV} produced no capacity signal (${reason}); falling back to the cooldown store.`,
                );
              },
            }),
            probeFromCooldownStore(modelCooldown),
          ),
        })
      : createCapacityCache({ probe: probeFromCooldownStore(modelCooldown) }),
});
export const modelFallbackEnabled = process.env.BELAYD_MODEL_FALLBACK !== "0";

/**
 * Flush the finished workflow's telemetry, then start a fresh per-workflow
 * store. The store and every destination cursor are dropped only after the
 * flush succeeds: a failed final write must not discard rows that never
 * reached disk, and the cursor stays so the next flush retries them.
 */
export function resetModelTelemetry(cwd: string, options?: { log?: boolean }): void {
  const shouldLog = options?.log === true;
  const result = flushAndResetModelTelemetry({
    state: modelState,
    cwd,
    beforeReset: () => {
      if (shouldLog) logModelTelemetrySummary();
    },
  });
  if (!result.ok) {
    warnModelTelemetryFlushFailure(result.error);
  }
}

/**
 * Warn about a failed telemetry flush at most once per throttle window, so a
 * full disk does not spam the log on every settle, stop, and shutdown.
 */
function warnModelTelemetryFlushFailure(error: string): void {
  if (!shouldWarnFlushFailure(modelState)) return;
  console.warn(`[belayd-harness] failed to persist model telemetry: ${error}`);
}

function logModelTelemetrySummary(): void {
  const stats = modelState.telemetry.stats();
  if (stats.length === 0) return;
  console.log(formatModelTelemetrySummary(stats, modelState.telemetry.totals()));
}

/**
 * Merge only the rows added since this destination's last flush into
 * `.belayd/telemetry.json`. `appendModelTelemetry` read-merge-writes, so an
 * overwrite of the full store would re-append every earlier row on each
 * settle and grow counts quadratically. The per-cwd flush cursor tracks what
 * is already on disk for that destination; a failed write leaves the cursor
 * unchanged so the rows are retried. Logs the summary only when `log` is set,
 * so the 6+ phase settles do not each emit the full cumulative breakdown;
 * workflow completion and session shutdown request the log once.
 */
export function persistModelTelemetry(cwd: string, options?: { log?: boolean }): void {
  const flushed = flushModelTelemetry({ state: modelState, cwd });
  if (!flushed.ok) {
    warnModelTelemetryFlushFailure(flushed.error);
    return;
  }
  if (options?.log === true) logModelTelemetrySummary();
}
