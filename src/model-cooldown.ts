/**
 * Routing's cooldown view over the one shared model-state store (bd-256).
 *
 * bd-38/bd-116 kept cooldowns in `~/.pi/agent/model-cooldowns.json`, shared
 * between fleet members by a same-machine lockfile. bd-187 added the SQLite
 * {@link ModelStateStore} for the provider wrapper, but left the JSON store in
 * place: routing read one, the wrapper wrote the other, and neither could see
 * the other's verdict. This module is the adapter that collapses them —
 * `ModelCooldownStore` is now a thin typed view over `ModelStateStore`, so a
 * quota failure the wrapper records steers the next spawn, and a cooldown the
 * routing path records blocks the next wrapped dispatch.
 *
 * Everything above the persistence stays where it was: the capacity cache, the
 * telemetry store, `quota-failure` classification and the fallback loop all keep
 * their semantics. Only the storage moved.
 *
 * Cooldowns keep two granularities, mirroring how failures actually behave:
 *
 * - **provider** (`opencode-go`): a quota/credit/rate limit (402/429) exhausts
 *   the provider's whole quota bucket, so every model on it is dead until reset;
 *   a provider with no credential configured (`unconfigured`) is equally dead for
 *   every model, for a different reason.
 * - **model** (`opencode-go/mimo-v2.6-flash`): a transient failure (5xx, network),
 *   or a model id the endpoint retired (404/410), is endpoint-specific — the same
 *   bare model id may still be healthy on another provider, so only this exact
 *   endpoint is cooled. A model id with no provider is stored
 *   provider-agnostically, which is how it stays visible to every provider's
 *   readers.
 *
 * Repeated *unhinted* provider cooldowns escalate (see
 * {@link COOLDOWN_ESCALATION_FACTOR}): a guessed window that already expired
 * while the provider was still exhausted must cost more the next time, or a
 * weekly limit gets re-probed on the same cadence forever. The ladder lives in
 * the store's `cooldown_ladder` table so it survives the window and a restart;
 * a *hinted* reset is authoritative and clears it. Model-scoped windows never
 * escalate.
 *
 * The retired JSON file is imported once, on first use, so an operator who set
 * `BELAYD_MODEL_COOLDOWN_FILE` (or who has windows from an older build) does not
 * silently lose them. It is never written again: {@link defaultModelCooldownPath}
 * is now only a *source*. The import is remembered by a `.imported` marker next
 * to the file, and the user's file is left untouched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { providerOf } from "./model-classes.js";
import type {
  CooldownCause,
  CooldownRow,
  CooldownScope,
  ModelStateSeeder,
  ModelStateStore,
} from "./model-state-store.js";
import {
  cooldownProviderKey,
  modelStateSeederFor,
  openModelStateStore,
  PROVIDER_SCOPE_MODEL,
  sharedModelStateStore,
} from "./model-state-store.js";

export type { CooldownCause as ProviderCooldownCause, CooldownScope } from "./model-state-store.js";
export {
  COOLDOWN_ESCALATION_FACTOR,
  COOLDOWN_ESCALATION_MEMORY_MS,
  MAX_ESCALATED_COOLDOWN_SECONDS,
} from "./model-state-store.js";

/** One cooldown window, shaped for the routing readers. */
export interface CooldownEntry {
  /** Epoch ms until which the target should not be attempted. */
  until: number;
  /**
   * Display text for why the target is cooled. Never branch on it: a merged
   * entry can pair this reason with a window another mark produced.
   */
  reason: string;
  /**
   * Stable cause tag, set for provider-scoped marks. Absent on model-scoped
   * marks and on any caller that did not supply one; consumers must treat
   * absent as "unknown or capacity" rather than assuming a cause.
   */
  cause?: CooldownCause;
  /**
   * How many consecutive unhinted marks produced this window (absent on hinted
   * windows). Mirrors the store's escalation ladder so a skip row is
   * diagnosable without reading the ladder table.
   */
  escalations?: number;
  /** Epoch ms of the mark that produced this window. */
  lastMarkedAt?: number;
}

/**
 * Window within which a second `refreshIfStale` is skipped.
 *
 * One spawn reads the store twice — once at candidate selection and again via
 * the capacity probe when its TTL expired — and invalidating the store's read
 * cache twice in one spawn is pure waste. The window is far below
 * `DEFAULT_CAPACITY_TTL_MS`, so a cooldown another fleet member writes is still
 * seen effectively immediately; callers that need certainty use `refresh()`.
 */
export const COOLDOWN_REFRESH_MAX_AGE_MS = 1_000;

export interface CooldownMarkOptions {
  /** Epoch-ms clock override (test seam). Defaults to the store clock. */
  nowMs?: number;
  /**
   * True when `durationSeconds` is a provider-supplied reset window. A hint is
   * authoritative: it replaces a provider entry exactly and clears the
   * escalation ladder. Ignored for model-scoped marks, which never escalate.
   * Omitted means the duration is a harness guess, so a repeat provider mark
   * escalates rather than re-guessing.
   */
  hinted?: boolean;
  /**
   * Stable cause tag stored on the entry (see `ProviderCooldownCause`), so a
   * reader does not have to match the human-readable `reason`. Ignored for
   * model-scoped marks, which are always endpoint-specific.
   */
  cause?: CooldownCause;
}

export interface ModelCooldownStore {
  /** True when the model endpoint or its provider is cooling down. */
  isCoolingDown(model: string, nowMs?: number): boolean;
  /** Cool down one model endpoint (transient/service failures). */
  markCooldown(
    model: string,
    durationSeconds: number,
    reason: string,
    options?: CooldownMarkOptions,
  ): void;
  /**
   * Cool down a whole provider (quota/credit exhaustion, or an absent
   * credential). An unhinted mark escalates a provider that was already cooled
   * recently; a hinted mark replaces the window exactly and clears the
   * escalation ladder.
   */
  markProviderCooldown(
    provider: string,
    durationSeconds: number,
    reason: string,
    options?: CooldownMarkOptions,
  ): void;
  prune(nowMs?: number): void;
  /**
   * Force the next read to observe another process's write.
   *
   * Launch pre-flight and in-session recovery need certainty before they refuse
   * a model, so this bypasses the store's bounded read cache. A missing or
   * unreadable store leaves every read permissive rather than throwing, so a
   * refresh can never fail a spawn.
   */
  refresh(nowMs?: number): void;
  /**
   * `refresh()` unless this store was already refreshed within `maxAgeInMs`
   * (default 0, i.e. always). The timestamp is per-store closure state, never
   * module state.
   */
  refreshIfStale(maxAgeInMs?: number, nowMs?: number): void;
  /** The scope blocking a model, or undefined when it is not cooling down. */
  cooldownScope(model: string, nowMs?: number): CooldownScope | undefined;
  /** Snapshot of model-scoped entries, keyed by model (test seam). */
  entries(): ReadonlyMap<string, CooldownEntry>;
  /** Snapshot of provider-scoped entries (test seam). */
  providerEntries(): ReadonlyMap<string, CooldownEntry>;
}

/** Resolve the shared truth lazily, so constructing a store opens nothing. */
export type ModelStateStoreProvider = () => ModelStateStore | null;

export interface ModelCooldownStoreOptions {
  /** Epoch-ms clock (test seam). Defaults to Date.now. */
  now?: () => number;
  /**
   * The one cooldown truth. Omitted means the process-wide shared store
   * (`sharedModelStateStore()`, path from `resolveModelStatePath()`), so a caller
   * that forgets the option can never fork a second truth. Pass `null` for a
   * permissive no-op, `"memory"` for a private in-memory store (tests and
   * callers that explicitly manage their own persistence), or a function when the
   * shared instance must be resolved lazily.
   */
  store?: ModelStateStore | null | "memory" | ModelStateStoreProvider;
  /**
   * Retired JSON cooldown file to import on first use. This never selects the
   * store path: the path always comes from `resolveModelStatePath()` (see
   * `store`), so the adapter and the rest of the process cannot disagree about
   * where the one truth lives. Setting it only names the migration source.
   *
   * A function defers the lookup to first use, so a caller that resolves the
   * source from the environment (`defaultModelCooldownPath()`) does not capture a
   * stale value at module load.
   */
  filePath?: string | (() => string);
}

/**
 * On-disk shape of the retired file. Only the fields the import replays are
 * read: the file is never rewritten.
 */
const LegacyEntrySchema = z.object({
  until: z.number().finite(),
  reason: z.string(),
  cause: z.enum(["quota", "unconfigured"]).optional(),
  // Present on an unhinted ladder window, absent on a hinted one. The rung is
  // replayed from the ladder map; this field only keeps the row diagnosable.
  escalations: z.number().int().positive().optional(),
  lastMarkedAt: z.number().finite().optional(),
});

const LegacyLadderSchema = z.object({
  // Zero is meaningful: the old store recorded a hinted reset as count 0.
  count: z.number().int().nonnegative(),
  lastMarkedAt: z.number().finite(),
});

const LegacyFileSchema = z
  .object({
    version: z.number().optional(),
    providers: z.record(z.string(), z.unknown()).optional(),
    models: z.record(z.string(), z.unknown()).optional(),
    escalations: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type LegacyEntry = z.infer<typeof LegacyEntrySchema>;
type LegacyLadder = z.infer<typeof LegacyLadderSchema>;

/**
 * One parsed legacy file.
 *
 * `present` separates "there was a file and it yielded nothing" (mark the
 * migration done) from "there is no file yet" (leave the migration pending), so
 * a corrupt or fully expired file is not re-parsed on every open while a
 * restored file is still imported.
 */
interface LegacyCooldowns {
  present: boolean;
  providers: Map<string, LegacyEntry>;
  models: Map<string, LegacyEntry>;
  escalations: Map<string, LegacyLadder>;
}

/** Default location of the retired JSON file, overridable via BELAYD_MODEL_COOLDOWN_FILE. */
export function defaultModelCooldownPath(): string {
  const override = process.env.BELAYD_MODEL_COOLDOWN_FILE;
  if (override !== undefined && override !== "") return override;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(home, ".pi", "agent", "model-cooldowns.json");
}

/** A JSON object, or an empty one — never a throw. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Parse one scope map; a malformed entry is skipped, not fatal. */
function parseLegacyEntries(value: unknown): Map<string, LegacyEntry> {
  const entries = new Map<string, LegacyEntry>();
  for (const [key, candidate] of Object.entries(asRecord(value))) {
    const parsed = LegacyEntrySchema.safeParse(candidate);
    if (!parsed.success) continue;
    entries.set(key, parsed.data);
  }
  return entries;
}

/** Parse the escalation ladder map; a malformed rung is skipped, not fatal. */
function parseLegacyLadders(value: unknown): Map<string, LegacyLadder> {
  const ladders = new Map<string, LegacyLadder>();
  for (const [provider, candidate] of Object.entries(asRecord(value))) {
    const parsed = LegacyLadderSchema.safeParse(candidate);
    if (!parsed.success) continue;
    ladders.set(provider, parsed.data);
  }
  return ladders;
}

/**
 * Read the retired file, keeping only windows that are still active.
 *
 * A missing file is reported as not present (the migration stays pending); an
 * unreadable or corrupt one is present-but-empty, so the migration is recorded
 * instead of re-parsing it forever. Never throws: an unreadable legacy file must
 * not stop a spawn.
 */
function readLegacyCooldowns(filePath: string, nowMs: number): LegacyCooldowns {
  const absent: LegacyCooldowns = {
    present: false,
    providers: new Map(),
    models: new Map(),
    escalations: new Map(),
  };
  if (!existsSync(filePath)) return absent;
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { ...absent, present: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...absent, present: true };
  }
  const file = LegacyFileSchema.safeParse(parsed);
  if (!file.success) return { ...absent, present: true };
  const active = (entries: Map<string, LegacyEntry>): Map<string, LegacyEntry> => {
    const kept = new Map<string, LegacyEntry>();
    for (const [key, entry] of entries) {
      if (entry.until > nowMs) kept.set(key, entry);
    }
    return kept;
  };
  return {
    present: true,
    providers: active(parseLegacyEntries(file.data.providers)),
    models: active(parseLegacyEntries(file.data.models)),
    escalations: parseLegacyLadders(file.data.escalations),
  };
}

/** The on-disk name of the "already imported" marker, next to the legacy file. */
function importedMarkerPath(filePath: string): string {
  return `${filePath}.imported`;
}

/**
 * Remember that the legacy file was imported, best effort.
 *
 * The marker is defence in depth: the import is an upsert that keeps the longer
 * window, so a second run would be harmless. `wx` keeps two concurrent
 * first-opens from rewriting it, and the parent directory is created because the
 * retired file may live in a `~/.pi/agent` this process has not touched yet.
 */
function writeImportedMarker(filePath: string, nowMs: number): void {
  const markerPath = importedMarkerPath(filePath);
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, String(nowMs), { flag: "wx" });
  } catch {
    /* already imported, or not ours to write */
  }
}

/** One resolved `store` option, or "use the process-wide shared store". */
type ConfiguredStoreChoice =
  | { kind: "store"; store: ModelStateStore | null }
  | { kind: "pending" }
  | { kind: "default" };

/**
 * Interpret the `store` option without opening anything implicitly.
 *
 * `"memory"` is the explicit isolation escape hatch (tests, callers managing
 * their own persistence); `null` is the explicit permissive no-op. A provider
 * returning null stays "pending" so it is re-invoked, never memoized as absent.
 */
function resolveConfiguredStore(
  configured: ModelStateStore | null | "memory" | ModelStateStoreProvider | undefined,
  now: () => number,
): ConfiguredStoreChoice {
  if (configured === undefined) return { kind: "default" };
  if (configured === null) return { kind: "store", store: null };
  if (configured === "memory") {
    const opened = openModelStateStore({ path: ":memory:", now });
    return { kind: "store", store: opened.ok ? opened.store : null };
  }
  if (typeof configured === "function") {
    const provided = configured();
    return provided === null ? { kind: "pending" } : { kind: "store", store: provided };
  }
  return { kind: "store", store: configured };
}

/** Split a model id into the store's (provider, model) pair. */
function splitModel(model: string): { provider: string; model: string } {
  const provider = providerOf(model);
  if (provider === "") return { provider: "", model };
  return { provider, model: model.slice(provider.length + 1) };
}

/** Rebuild the routing-facing key for a stored row. */
function modelKey(row: CooldownRow): string {
  return row.provider === PROVIDER_SCOPE_MODEL ? row.model : `${row.provider}/${row.model}`;
}

/** The routing-facing entry for one stored row. */
function toEntry(row: CooldownRow): CooldownEntry {
  return {
    until: row.untilMs,
    reason: row.reason,
    ...(row.cause === undefined ? {} : { cause: row.cause }),
    ...(row.escalations === undefined ? {} : { escalations: row.escalations }),
    ...(row.lastMarkedAt <= 0 ? {} : { lastMarkedAt: row.lastMarkedAt }),
  };
}

export function createModelCooldownStore(): ModelCooldownStore;
export function createModelCooldownStore(now: () => number): ModelCooldownStore;
export function createModelCooldownStore(options: ModelCooldownStoreOptions): ModelCooldownStore;
export function createModelCooldownStore(
  arg: (() => number) | ModelCooldownStoreOptions = {},
): ModelCooldownStore {
  const options: ModelCooldownStoreOptions = typeof arg === "function" ? { now: arg } : arg;
  const now = options.now ?? Date.now;
  // Resolved once, on first use: a thunk lets the extension read
  // `BELAYD_MODEL_COOLDOWN_FILE` lazily without freezing it at import time.
  const legacyPathOption = options.filePath;
  let resolvedLegacyPath: string | undefined;
  function legacyFilePath(): string | undefined {
    if (resolvedLegacyPath !== undefined) return resolvedLegacyPath;
    resolvedLegacyPath =
      typeof legacyPathOption === "function" ? legacyPathOption() : legacyPathOption;
    return resolvedLegacyPath;
  }
  /**
   * The cached store; undefined until a genuinely usable one is resolved.
   *
   * Invariant: this only ever holds a store that can actually answer a read.
   * The transient facade never lands here (see {@link resolveStore}).
   */
  let resolved: ModelStateStore | undefined;
  /** True once the legacy import was actually settled against a real store. */
  let legacyImported = false;
  /** The store the import was last attempted against, settled or not. */
  let legacyAttemptedFor: ModelStateStore | undefined;
  /** Epoch ms of the last explicit refresh by this adapter. */
  let lastRefreshAt: number | undefined;
  /** Epoch ms of the last garbage-collection pass (see `prune`). */
  let lastPruneAt: number | undefined;

  /**
   * Run the one-time legacy import the first time a usable store is available.
   *
   * Two flags on purpose: the import is attempted once per *store instance*
   * (a read path must not stat the retired file on every cooldown read), but it
   * is only latched as done once it actually settled. A facade or a read-only
   * store cannot accept the rows, so latching there would drop the migration for
   * the whole adapter even after the store recovers.
   */
  function importOnce(store: ModelStateStore | null): ModelStateStore | null {
    if (store !== null && !legacyImported && legacyAttemptedFor !== store) {
      legacyAttemptedFor = store;
      legacyImported = importLegacy(store);
    }
    return store;
  }

  /**
   * Accept a store for caching, or serve a facade without caching it.
   *
   * Invariant: `resolved` only ever holds a store that is genuinely usable, so
   * the transient facade is served (it queues marks) but never memoized —
   * whichever branch produced it. The extension's provider thunk can hand back
   * `sharedModelStateStoreInstance()`'s facade exactly like the default branch
   * can, and caching it would pin "nothing is cooling down" for the session
   * while the wrapper recovers: the two-truths bug bd-256 removed.
   */
  function acceptStore(store: ModelStateStore | null): ModelStateStore | null {
    if (store === null) return null;
    if (store.pendingFlush === true) return store;
    resolved = store;
    return importOnce(store);
  }

  /**
   * Resolve the one truth for this adapter.
   *
   * Omitting `store` is the process-wide shared store: a caller that forgets the
   * option must not get a private per-call copy, which is exactly the amnesia
   * bd-256 removed. `null` and `"memory"` stay available as explicit escape
   * hatches (permissive no-op and test isolation), never as the default.
   */
  function resolveStore(): ModelStateStore | null {
    if (resolved !== undefined) return importOnce(resolved);
    const choice = resolveConfiguredStore(options.store, now);
    // A provider that yields null is retried on the next read: the shared
    // accessor may still be inside its post-failure backoff window.
    if (choice.kind === "pending") return null;
    if (choice.kind === "store") return acceptStore(choice.store);
    // The adapter clock is forwarded so the accessor's retry window and the
    // facade's queue run on the same time source as this adapter's marks.
    return acceptStore(sharedModelStateStore(now));
  }

  /**
   * Import the retired file into the shared store, once.
   *
   * The window is replayed exactly as the previous build observed it
   * (`seedCooldown`: absolute window end, longer-wins, the 24 h ceiling for an
   * escalated window) and its escalation ladder is replayed separately
   * (`seedCooldownLadder`). Importing a window as a "hinted" mark would delete
   * the ladder, so an already-escalated weekly bucket would restart at rung 1 —
   * the bd-38 re-probe churn the feature exists to prevent. A legacy entry with
   * no `escalations` field came from a hinted window (or a model window), whose
   * ladder was legitimately cleared at that time; the ladder map carries the
   * `count: 0` reset event for it.
   *
   * Returns true only when the migration is settled (nothing left to replay), so
   * the adapter can keep retrying it after a transient unavailable store.
   */
  function importLegacy(store: ModelStateStore): boolean {
    const legacyPath = legacyFilePath();
    // No source configured: there is nothing this adapter could ever import.
    if (legacyPath === undefined) return true;
    const nowMs = now();
    if (existsSync(importedMarkerPath(legacyPath))) return true;
    const seeder = modelStateSeederFor(store);
    // A read-only/unavailable store cannot accept the migration; the marker
    // stays absent so a writable process still imports the windows.
    if (seeder === null) return false;
    const legacy = readLegacyCooldowns(legacyPath, nowMs);
    // No file yet: leave the migration pending so a restored file still imports.
    if (!legacy.present) return false;
    const laddersSeeded = seedLegacyLadders({
      seeder,
      escalations: legacy.escalations,
      nowMs,
    });
    const providersSeeded = seedLegacyProviders({
      seeder,
      providers: legacy.providers,
      nowMs,
    });
    const modelsSeeded = seedLegacyModels({ seeder, models: legacy.models, nowMs });
    // A read-only or failing store keeps the marker absent, so the migration is
    // not recorded as done for a process that can actually write it. A file that
    // yields no windows is still marked, so a corrupt or fully expired file is
    // not re-parsed on every open.
    if (!laddersSeeded || !providersSeeded || !modelsSeeded) return false;
    writeImportedMarker(legacyPath, nowMs);
    return true;
  }

  /** The active cooldown for one model id, or null when none (or unreadable). */
  function activeCooldown(model: string, nowMs?: number): CooldownRow | null {
    const store = resolveStore();
    if (store === null) return null;
    const target = splitModel(model);
    // `cooldownFor` answers the scope question but not the row the routing
    // readers need (cause, ladder), so the row is taken from `listCooldowns`.
    // That read is one indexed query and keeps the adapter honest: every reader
    // sees the same rows the wrapper wrote.
    const rows = store.listCooldowns({ nowMs: nowMs ?? now() });
    if (!rows.ok) return null;
    let best: CooldownRow | null = null;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const row of rows.value) {
      const rank = rowRank(row, cooldownProviderKey(target.provider), target.model);
      if (rank === undefined || rank >= bestRank) continue;
      best = row;
      bestRank = rank;
    }
    return best;
  }

  return {
    isCoolingDown(model, nowMs) {
      return activeCooldown(model, nowMs) !== null;
    },
    markCooldown(model, durationSeconds, reason, markOptions) {
      const store = resolveStore();
      if (store === null) return;
      const target = splitModel(model);
      store.markCooldown({
        ...(target.provider === "" ? {} : { provider: target.provider }),
        model: target.model,
        durationMs: Math.round(durationSeconds * 1_000),
        reason,
        // The adapter clock is the single time source: forwarding only an
        // explicit markOptions.nowMs let a deterministic caller write real-time
        // windows while reading with its injected clock.
        nowMs: markOptions?.nowMs ?? now(),
      });
    },
    markProviderCooldown(provider, durationSeconds, reason, markOptions) {
      const store = resolveStore();
      if (store === null) return;
      store.markCooldown({
        provider,
        durationMs: Math.round(durationSeconds * 1_000),
        reason,
        hinted: markOptions?.hinted === true,
        ...(markOptions?.cause === undefined ? {} : { cause: markOptions.cause }),
        nowMs: markOptions?.nowMs ?? now(),
      });
    },
    prune(nowMs) {
      const store = resolveStore();
      if (store === null) return;
      const at = nowMs ?? now();
      // The fallback loop prunes before every candidate. Expired rows are
      // already invisible to every reader, so the delete is garbage collection:
      // running it per candidate would turn one spawn into a write transaction
      // per candidate and contend with every other daemon's marks.
      if (
        lastPruneAt !== undefined &&
        lastPruneAt <= at &&
        at - lastPruneAt < COOLDOWN_REFRESH_MAX_AGE_MS
      ) {
        return;
      }
      lastPruneAt = at;
      store.prune(at);
    },
    refresh(nowMs) {
      const store = resolveStore();
      store?.invalidateCooldownCache();
      lastRefreshAt = nowMs ?? now();
    },
    refreshIfStale(maxAgeInMs, nowMs) {
      const store = resolveStore();
      if (store === null) return;
      const at = nowMs ?? now();
      // A missing stamp and a regressed clock both mean "cannot prove freshness":
      // the first call must read, and a clock that moved backwards would
      // otherwise keep suppressing reads until wall time overtook the stamp.
      if (
        lastRefreshAt !== undefined &&
        lastRefreshAt <= at &&
        at - lastRefreshAt < (maxAgeInMs ?? 0)
      ) {
        return;
      }
      store.invalidateCooldownCache();
      lastRefreshAt = at;
    },
    cooldownScope(model, nowMs) {
      const row = activeCooldown(model, nowMs);
      if (row === null) return undefined;
      return row.model === PROVIDER_SCOPE_MODEL ? "provider" : "model";
    },
    entries() {
      const entries = new Map<string, CooldownEntry>();
      const store = resolveStore();
      if (store === null) return entries;
      const rows = store.listCooldowns({ nowMs: now() });
      if (!rows.ok) return entries;
      for (const row of rows.value) {
        if (row.model === PROVIDER_SCOPE_MODEL) continue;
        entries.set(modelKey(row), toEntry(row));
      }
      return entries;
    },
    providerEntries() {
      const entries = new Map<string, CooldownEntry>();
      const store = resolveStore();
      if (store === null) return entries;
      const rows = store.listCooldowns({ nowMs: now() });
      if (!rows.ok) return entries;
      for (const row of rows.value) {
        if (row.model !== PROVIDER_SCOPE_MODEL || row.provider === PROVIDER_SCOPE_MODEL) continue;
        entries.set(row.provider, toEntry(row));
      }
      return entries;
    },
  };
}

/** Replay the legacy escalation ladder; true when every rung write succeeded. */
function seedLegacyLadders(input: {
  seeder: ModelStateSeeder;
  escalations: ReadonlyMap<string, LegacyLadder>;
  nowMs: number;
}): boolean {
  let allWritten = true;
  for (const [provider, ladder] of input.escalations) {
    // `"*"` is not a provider; a bare model row never feeds a ladder.
    if (cooldownProviderKey(provider) === PROVIDER_SCOPE_MODEL) continue;
    const seeded = input.seeder.seedCooldownLadder({
      provider,
      escalations: ladder.count,
      lastMarkedAt: ladder.lastMarkedAt,
      nowMs: input.nowMs,
    });
    if (!seeded.ok) allWritten = false;
  }
  return allWritten;
}

/**
 * Replay the legacy provider windows; true when every write succeeded.
 *
 * `seedCooldown` keeps the longer window and never touches the ladder, so a
 * longer file window can replace a shorter escalated one without losing the rung
 * the process had already recorded.
 */
function seedLegacyProviders(input: {
  seeder: ModelStateSeeder;
  providers: ReadonlyMap<string, LegacyEntry>;
  nowMs: number;
}): boolean {
  let allWritten = true;
  for (const [provider, entry] of input.providers) {
    const seeded = input.seeder.seedCooldown({
      provider,
      untilMs: entry.until,
      reason: entry.reason,
      ...(entry.cause === undefined ? {} : { cause: entry.cause }),
      // Present only on an unhinted (laddered) window; the old store omitted it
      // on hinted windows, whose ladder was cleared.
      ...(entry.escalations === undefined ? {} : { escalations: entry.escalations }),
      ...(entry.lastMarkedAt === undefined ? {} : { lastMarkedAt: entry.lastMarkedAt }),
      nowMs: input.nowMs,
    });
    if (!seeded.ok) allWritten = false;
  }
  return allWritten;
}

/** Replay the legacy endpoint windows; true when every write succeeded. */
function seedLegacyModels(input: {
  seeder: ModelStateSeeder;
  models: ReadonlyMap<string, LegacyEntry>;
  nowMs: number;
}): boolean {
  let allWritten = true;
  for (const [model, entry] of input.models) {
    const target = splitModel(model);
    const seeded = input.seeder.seedCooldown({
      provider: target.provider,
      model: target.model,
      untilMs: entry.until,
      reason: entry.reason,
      ...(entry.lastMarkedAt === undefined ? {} : { lastMarkedAt: entry.lastMarkedAt }),
      nowMs: input.nowMs,
    });
    if (!seeded.ok) allWritten = false;
  }
  return allWritten;
}

/**
 * Rank a stored row against a model id: 0 provider-wide, 1 exact endpoint, 2
 * provider-agnostic bare model, undefined when the row does not block it.
 *
 * A provider-wide window outranks the endpoint one, matching the store's
 * `cooldownFor`: a spent credential blocks every model on it, so that is the
 * stronger diagnosis and the one a skip row should carry.
 */
function rowRank(row: CooldownRow, provider: string, model: string): number | undefined {
  if (row.provider === provider && row.model === PROVIDER_SCOPE_MODEL) return 0;
  if (row.provider === provider && row.model === model) return 1;
  if (row.provider === PROVIDER_SCOPE_MODEL && row.model === model) return 2;
  return undefined;
}
