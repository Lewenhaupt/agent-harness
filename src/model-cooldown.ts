/**
 * In-memory model cooldown store.
 *
 * When a model hits a quota/rate limit it is marked unhealthy for a period, and
 * the fallback loop skips cooled-down candidates on subsequent spawns. State
 * lives in a closure rather than at module scope — callers own a store instance
 * (created once per orchestrator session) and pass it across spawns, matching
 * the repo's no-global-mutable-state rule.
 *
 * Persistence to disk (atomic write + lockfile, as in pi-gateway's state.ts) is
 * a documented follow-up; in-memory cooldown is sufficient while the
 * orchestrator process is live.
 */

export interface CooldownEntry {
  /** Epoch ms until which the model should not be attempted. */
  until: number;
  reason: string;
}

export interface ModelCooldownStore {
  isCoolingDown(model: string, nowMs?: number): boolean;
  markCooldown(model: string, durationSeconds: number, reason: string, nowMs?: number): void;
  prune(nowMs?: number): void;
  /** Snapshot of current entries (test seam). */
  entries(): ReadonlyMap<string, CooldownEntry>;
}

export function createModelCooldownStore(now: () => number = Date.now): ModelCooldownStore {
  const cooldowns = new Map<string, CooldownEntry>();

  return {
    isCoolingDown(model, nowMs) {
      const entry = cooldowns.get(model);
      if (!entry) return false;
      return entry.until > (nowMs ?? now());
    },
    markCooldown(model, durationSeconds, reason, nowMs) {
      const t = nowMs ?? now();
      cooldowns.set(model, { until: t + durationSeconds * 1000, reason });
    },
    prune(nowMs) {
      const t = nowMs ?? now();
      for (const [model, entry] of cooldowns) {
        if (entry.until <= t) cooldowns.delete(model);
      }
    },
    entries() {
      return cooldowns;
    },
  };
}
