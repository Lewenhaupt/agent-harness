/**
 * Model cooldown store with optional file persistence.
 *
 * When a model or provider hits a quota/rate limit it is marked unhealthy for a
 * period, and the fallback loop skips cooled-down candidates on subsequent
 * spawns. State lives in a closure rather than at module scope — callers own a
 * store instance (created once per orchestrator session) and pass it across
 * spawns, matching the repo's no-global-mutable-state rule.
 *
 * Cooldowns are scoped at two granularities, mirroring how failures actually
 * behave:
 *
 * - **provider** (`opencode-go`): a quota/credit/rate limit (402/429) exhausts
 *   the provider's whole quota bucket, so every model on it is dead until reset.
 * - **model** (`opencode-go/mimo-v2.6-flash`): a transient failure (5xx, network),
 *   or a model id the endpoint retired (404/410), is endpoint-specific — the same
 *   bare model id may still be healthy on another provider, so only this exact
 *   endpoint is cooled.
 *
 * `isCoolingDown(model)` reports true when either the model's provider or the
 * model endpoint itself is cooling down.
 *
 * Without a `filePath` the store is in-memory only (the historical behaviour,
 * still the default, so tests and callers that manage their own persistence are
 * unaffected). With a `filePath`, entries survive orchestrator restarts: the map
 * is loaded on creation (expired entries pruned), and every mark re-writes the
 * file atomically — temp file + rename in the same directory — behind a
 * same-machine lockfile, following the pattern in pi-gateway's state.ts.
 *
 * The file is shared between processes (fleet members each run their own
 * orchestrator), so `refresh()` re-reads it and merges it into memory. The
 * capacity probe calls it before reading, which is what makes a provider
 * cooldown written by another member visible without an orchestrator restart.
 * `refresh()` and `persist()` share one ordering rule (see `preferEntry`), so
 * neither direction can shorten or lengthen a window the other produced.
 *
 * Repeated *unhinted* provider cooldowns escalate (see
 * `COOLDOWN_ESCALATION_FACTOR`): a guessed window that already expired while the
 * provider was still exhausted must cost more the next time, or a weekly limit
 * gets re-probed on the same cadence forever. The ladder lives in its own map
 * (`escalations`) so it survives the entry's expiry and a restart; a *hinted*
 * reset is authoritative and clears it.
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { z } from "zod";

import { providerOf } from "./model-classes.js";

export interface CooldownEntry {
  /** Epoch ms until which the target should not be attempted. */
  until: number;
  /**
   * Display text for why the target is cooled. Never branch on it: a merged
   * entry can pair this reason with a window another mark produced.
   */
  reason: string;
  /**
   * How many consecutive unhinted marks produced this window (absent on hinted
   * windows). Mirrors the escalation ladder so a persisted file is diagnosable
   * and a merge can keep the higher count.
   */
  escalations?: number;
  /**
   * Epoch ms of the mark that produced this window.
   *
   * Merges order by this, never by `until`: a stale file must not lengthen *or*
   * shorten a window this process marked more recently, and a fresh short hint
   * must beat an older long guess. A file written before this field existed has
   * no stamp, and so does every entry an older-build fleet member still writes;
   * an unstamped entry is therefore *not* treated as old — when the stamps are
   * not comparable the merge falls back to `preferEntry`'s tie ordering.
   */
  lastMarkedAt?: number;
}

/**
 * Each repeated unhinted cooldown doubles the window: a guess that already
 * proved too short must not be reused verbatim.
 */
export const COOLDOWN_ESCALATION_FACTOR = 2;
/**
 * Ceiling on an escalated window (24 h). A single day bounds the damage of a
 * wrong guess: the provider is re-probed at least daily even if escalation ran
 * long, so an operator never has to hand-edit `model-cooldowns.json`.
 */
export const MAX_ESCALATED_COOLDOWN_SECONDS = 24 * 60 * 60;
/**
 * How long the escalation ladder is remembered after the last mark (7 days). A
 * weekly bucket that resets and re-exhausts inside a week is the same limit
 * escalating, not a fresh one.
 */
export const COOLDOWN_ESCALATION_MEMORY_MS = 7 * 86_400_000;

/** Which cooldown scope is blocking a model, when one is. */
export type CooldownScope = "provider" | "model";

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
   * Cool down a whole provider (quota/credit exhaustion). An unhinted mark
   * escalates a provider that was already cooled recently; a hinted mark
   * replaces the window exactly and clears the escalation ladder.
   */
  markProviderCooldown(
    provider: string,
    durationSeconds: number,
    reason: string,
    options?: CooldownMarkOptions,
  ): void;
  prune(nowMs?: number): void;
  /**
   * Re-read the persisted file and merge it into memory using the shared
   * mark-time ordering (see `preferEntry`), pruning expired entries. No-op for an
   * in-memory store; a missing, corrupt, or unreadable file leaves memory
   * untouched rather than throwing, so a probe refresh can never fail a spawn.
   */
  refresh(nowMs?: number): void;
  /** The scope blocking a model, or undefined when it is not cooling down. */
  cooldownScope(model: string, nowMs?: number): CooldownScope | undefined;
  /** Snapshot of model-scoped entries (test seam). */
  entries(): ReadonlyMap<string, CooldownEntry>;
  /** Snapshot of provider-scoped entries (test seam). */
  providerEntries(): ReadonlyMap<string, CooldownEntry>;
}

/**
 * Subset of node:fs sync operations the store needs. Tests inject an in-memory
 * implementation so no real disk I/O happens; production uses the node:fs
 * wrappers below.
 */
export interface CooldownFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string, options?: { flag?: string }): void;
  renameSync(oldPath: string, newPath: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
}

export interface ModelCooldownStoreOptions {
  /** Epoch-ms clock (test seam). Defaults to Date.now. */
  now?: () => number;
  /** JSON file to persist cooldowns to. Omit to keep the store in-memory only. */
  filePath?: string;
  /** Filesystem seam (test seam). Defaults to node:fs sync wrappers. */
  fs?: CooldownFs;
}

const FILE_VERSION = 1;
/** A lock older than this is treated as abandoned (its owner died mid-write). */
const LOCK_STALE_MS = 30_000;
/** Lock acquisition is bounded; the critical section is a single rename. */
const MAX_LOCK_ATTEMPTS = 100;

/**
 * On-disk shapes. `.passthrough()` keeps unknown keys from a newer/older version
 * alive through a read-modify-write (see `serialize`), and `z.infer` derives the
 * write types so reader and writer cannot drift apart.
 */
const PersistedEntrySchema = z
  .object({
    until: z.number().finite(),
    reason: z.string(),
    // Zero is meaningless on an entry (the ladder map is the authority for the
    // count and carries the timestamp), so a stored 0 normalizes to absent.
    escalations: z.number().int().positive().optional(),
    lastMarkedAt: z.number().finite().optional(),
  })
  .passthrough();

const EscalationRecordSchema = z
  .object({
    // Zero *is* meaningful here: a hinted mark records "ladder cleared" as a
    // count-0 event whose timestamp still has to win the merge.
    count: z.number().int().nonnegative(),
    lastMarkedAt: z.number().finite(),
  })
  .passthrough();

/**
 * A scope map is validated per entry rather than as a whole, so one malformed
 * entry is skipped instead of discarding every healthy sibling.
 */
const ScopeMapSchema = z.record(z.string(), z.unknown());

const CooldownFileSchema = z
  .object({
    version: z.number().optional(),
    providers: ScopeMapSchema.optional(),
    models: ScopeMapSchema.optional(),
    escalations: ScopeMapSchema.optional(),
  })
  .passthrough();

type PersistedEntry = z.infer<typeof PersistedEntrySchema>;

/** The escalation ladder for one provider, kept across window expiry. */
type EscalationRecord = z.infer<typeof EscalationRecordSchema>;

/**
 * In-memory state, also the on-disk shape (`providers`/`models` entries plus the
 * provider escalation ladders). `extras` is the raw file object of the last
 * load, adopt or refresh, kept so unknown keys written by another version
 * survive the next rewrite; `serialize` reads it, so any new path that writes
 * the file must refresh `extras` (or reload) first.
 */
interface CooldownState {
  providers: Map<string, CooldownEntry>;
  models: Map<string, CooldownEntry>;
  escalations: Map<string, EscalationRecord>;
  extras: Record<string, unknown>;
}

const nodeFsSeam: CooldownFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
  writeFileSync: (path, data, options) => nodeFs.writeFileSync(path, data, options),
  renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path, options),
  unlinkSync: (path) => nodeFs.unlinkSync(path),
};

/** Default on-disk location, overridable via BELAYD_MODEL_COOLDOWN_FILE. */
export function defaultModelCooldownPath(): string {
  const override = process.env.BELAYD_MODEL_COOLDOWN_FILE;
  if (override !== undefined && override !== "") return override;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? nodeOs.homedir();
  return nodePath.join(home, ".pi", "agent", "model-cooldowns.json");
}

function emptyState(): CooldownState {
  return { providers: new Map(), models: new Map(), escalations: new Map(), extras: {} };
}

/** A JSON object, or an empty one — never a throw. */
function asRecord(value: unknown): Record<string, unknown> {
  const parsed = ScopeMapSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** Parse one scope map; a malformed entry is skipped, not fatal. */
function parseEntryMap(value: unknown): Map<string, CooldownEntry> {
  const entries = new Map<string, CooldownEntry>();
  for (const [key, candidate] of Object.entries(asRecord(value))) {
    const parsed = PersistedEntrySchema.safeParse(candidate);
    if (!parsed.success) continue;
    const entry: CooldownEntry = { until: parsed.data.until, reason: parsed.data.reason };
    if (parsed.data.escalations !== undefined) entry.escalations = parsed.data.escalations;
    if (parsed.data.lastMarkedAt !== undefined) entry.lastMarkedAt = parsed.data.lastMarkedAt;
    entries.set(key, entry);
  }
  return entries;
}

/** Parse the escalation map; a malformed record is skipped, not fatal. */
function parseEscalationMap(value: unknown): Map<string, EscalationRecord> {
  const records = new Map<string, EscalationRecord>();
  for (const [key, candidate] of Object.entries(asRecord(value))) {
    const parsed = EscalationRecordSchema.safeParse(candidate);
    if (!parsed.success) continue;
    records.set(key, { count: parsed.data.count, lastMarkedAt: parsed.data.lastMarkedAt });
  }
  return records;
}

/** Parse the persisted file; a corrupt file yields empty state, never a throw. */
function parseCooldownFile(text: string): CooldownState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyState();
  }
  const file = CooldownFileSchema.safeParse(parsed);
  if (!file.success) return emptyState();
  return {
    providers: parseEntryMap(file.data.providers),
    models: parseEntryMap(file.data.models),
    escalations: parseEscalationMap(file.data.escalations),
    extras: { ...file.data },
  };
}

function loadState(fs: CooldownFs, filePath: string): CooldownState {
  if (!fs.existsSync(filePath)) return emptyState();
  let text: string;
  try {
    text = fs.readFileSync(filePath);
  } catch {
    return emptyState(); // unreadable file: treat as empty, never crash the store
  }
  return parseCooldownFile(text);
}

function pruneMap(entries: Map<string, CooldownEntry>, nowMs: number): void {
  for (const [key, entry] of entries) {
    if (entry.until <= nowMs) entries.delete(key);
  }
}

function pruneEscalations(escalations: Map<string, EscalationRecord>, nowMs: number): void {
  for (const [key, record] of escalations) {
    if (nowMs - record.lastMarkedAt > COOLDOWN_ESCALATION_MEMORY_MS) escalations.delete(key);
  }
}

function pruneState(state: CooldownState, nowMs: number): void {
  pruneMap(state.providers, nowMs);
  pruneMap(state.models, nowMs);
  pruneEscalations(state.escalations, nowMs);
}

function toRecord(entries: ReadonlyMap<string, CooldownEntry>): Record<string, PersistedEntry> {
  const record: Record<string, PersistedEntry> = {};
  for (const [key, entry] of entries) {
    const persisted: PersistedEntry = { until: entry.until, reason: entry.reason };
    if ((entry.escalations ?? 0) > 0) persisted.escalations = entry.escalations;
    if (entry.lastMarkedAt !== undefined) persisted.lastMarkedAt = entry.lastMarkedAt;
    record[key] = persisted;
  }
  return record;
}

/** Fields this module owns per entry; anything else is carried over verbatim. */
const ENTRY_KEYS: ReadonlySet<string> = new Set(["until", "reason", "escalations", "lastMarkedAt"]);
const ESCALATION_KEYS: ReadonlySet<string> = new Set(["count", "lastMarkedAt"]);

/**
 * Rebuild one persisted map from this process's entries, carrying over unknown
 * keys that sit next to a known one (see `.passthrough()` above). Known fields
 * always come from the entry, so a field the entry omits disappears — a hinted
 * window must not inherit the previous entry's stale `escalations`. Keys absent
 * here are dropped: which entries exist is owned by the in-memory state, not by
 * a stale file.
 */
function withEntryExtras<T extends object>(
  raw: unknown,
  entries: Record<string, T>,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const extras = asRecord(raw);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const previous = extras[key];
    const carried: Record<string, unknown> = {};
    if (typeof previous === "object" && previous !== null) {
      for (const [field, value] of Object.entries(previous)) {
        if (!knownKeys.has(field)) carried[field] = value;
      }
    }
    result[key] = { ...carried, ...entry };
  }
  return result;
}

function serialize(state: CooldownState): string {
  const body: Record<string, unknown> = {
    ...state.extras,
    version: FILE_VERSION,
    providers: withEntryExtras(state.extras.providers, toRecord(state.providers), ENTRY_KEYS),
    models: withEntryExtras(state.extras.models, toRecord(state.models), ENTRY_KEYS),
    escalations: withEntryExtras(
      state.extras.escalations,
      Object.fromEntries(state.escalations),
      ESCALATION_KEYS,
    ),
  };
  return JSON.stringify(body, null, 2);
}

/** Write atomically: temp file in the same directory, then rename over the target. */
function writeState(fs: CooldownFs, filePath: string, state: CooldownState): void {
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, serialize(state));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** Known mark time, or an explicit "unknown" — never a sentinel time. */
type MarkStamp = { readonly stamped: true; readonly at: number } | { readonly stamped: false };

function markStampOf(entry: CooldownEntry): MarkStamp {
  return entry.lastMarkedAt === undefined
    ? { stamped: false }
    : { stamped: true, at: entry.lastMarkedAt };
}

/** The safer of two windows when mark order cannot decide. */
function saferEntry(a: CooldownEntry, b: CooldownEntry): CooldownEntry {
  if (a.until !== b.until) return a.until > b.until ? a : b;
  return (a.escalations ?? 0) >= (b.escalations ?? 0) ? a : b;
}

/**
 * The ordering rule shared by `refresh()` and `persist()`: compare *when a window
 * was marked*, never how long it is.
 *
 * Ordering by `until` made the two directions disagree — refresh kept the
 * longer window while persist kept this process's — so a stale file could
 * silently shorten or lengthen a live window depending on which path ran. With
 * mark times, the newest observation of a key always wins in both directions,
 * and a shorter *fresh* hint beats an older longer guess because it is newer,
 * not because it is short.
 *
 * A three-way rule, because stamp presence is not evidence of recency:
 *
 * 1. **Both stamped** and the times differ: the later mark wins, in both
 *    directions (this is the decisive case).
 * 2. **Exactly one stamped**: the stamps are not comparable — a fleet member
 *    still running an older build writes genuinely *fresh* entries with no
 *    `lastMarkedAt`, so treating "unstamped" as old would make this build
 *    ignore that member's newest windows and clobber them on the next write.
 *    Fall through to the tie ordering instead.
 * 3. **Neither stamped** (two pre-mark-time files): also the tie ordering.
 *
 * The tie ordering is the safer window — the longer `until`, then the higher
 * escalation count. Two marks whose order cannot be proven do not justify
 * cooling less, and a ceiling-clamped ladder can make two rungs share one
 * `until`.
 */
function preferEntry(a: CooldownEntry, b: CooldownEntry): CooldownEntry {
  const aStamp = markStampOf(a);
  const bStamp = markStampOf(b);
  if (aStamp.stamped && bStamp.stamped && aStamp.at !== bStamp.at) {
    return aStamp.at > bStamp.at ? a : b;
  }
  return saferEntry(a, b);
}

/**
 * Merge `incoming` into `target` per key, keeping the *whole* winning entry.
 *
 * The winner's `until`, `reason`, `escalations` and `lastMarkedAt` travel
 * together on purpose: pairing one side's window with the other side's reason or
 * escalation count would describe a mark that never happened. A ladder count is
 * only forgotten here when a newer mark superseded it, which is exactly what a
 * hinted reset is; the ladder map itself merges separately and never loses a
 * count on a tie (see `mergeEscalationMaps`).
 */
function mergeEntryMaps(
  target: Map<string, CooldownEntry>,
  incoming: ReadonlyMap<string, CooldownEntry>,
): void {
  for (const [key, entry] of incoming) {
    const current = target.get(key);
    target.set(key, current === undefined ? entry : preferEntry(current, entry));
  }
}

/**
 * Merge escalation ladders by event order: the later mark wins, because a hinted
 * reset replaces an earlier ladder rather than being out-voted by it.
 *
 * A tie cannot prove the ladder was cleared (two members may mark the same
 * provider within clock skew), so the higher count wins in *both* directions
 * instead of depending on which side happened to be `incoming`.
 */
function mergeEscalationMaps(
  target: Map<string, EscalationRecord>,
  incoming: ReadonlyMap<string, EscalationRecord>,
): void {
  for (const [key, record] of incoming) {
    const current = target.get(key);
    if (current === undefined) {
      target.set(key, record);
      continue;
    }
    if (record.lastMarkedAt > current.lastMarkedAt) {
      target.set(key, record);
      continue;
    }
    if (record.lastMarkedAt < current.lastMarkedAt) continue;
    if (record.count > current.count) target.set(key, record);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function lockIsStale(fs: CooldownFs, lockPath: string, nowMs: number): boolean {
  if (!fs.existsSync(lockPath)) return true;
  let created: number;
  try {
    created = Number.parseInt(fs.readFileSync(lockPath), 10);
  } catch {
    return true;
  }
  if (!Number.isFinite(created)) return true;
  return nowMs - created > LOCK_STALE_MS;
}

/**
 * Acquire the lockfile via an exclusive "wx" write. Returns true when held;
 * falls back to proceeding without it (the atomic rename still keeps the file
 * uncorrupted) rather than throwing — a cooldown write must never fail a spawn.
 */
function acquireLock(fs: CooldownFs, lockPath: string, nowMs: number): boolean {
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(nowMs), { flag: "wx" });
      return true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) return false;
    }
    if (lockIsStale(fs, lockPath, nowMs)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore — raced with the releaser */
      }
    }
  }
  return false;
}

function releaseLock(fs: CooldownFs, lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

function withLock<T>(fs: CooldownFs, lockPath: string, nowMs: number, body: () => T): T {
  const held = acquireLock(fs, lockPath, nowMs);
  try {
    return body();
  } finally {
    if (held) releaseLock(fs, lockPath);
  }
}

export function createModelCooldownStore(): ModelCooldownStore;
export function createModelCooldownStore(now: () => number): ModelCooldownStore;
export function createModelCooldownStore(options: ModelCooldownStoreOptions): ModelCooldownStore;
export function createModelCooldownStore(
  arg: (() => number) | ModelCooldownStoreOptions = {},
): ModelCooldownStore {
  const options: ModelCooldownStoreOptions = typeof arg === "function" ? { now: arg } : arg;
  const now = options.now ?? Date.now;
  const fs = options.fs ?? nodeFsSeam;
  const filePath = options.filePath;
  const lockPath = filePath === undefined ? undefined : `${filePath}.lock`;

  const state = filePath === undefined ? emptyState() : loadState(fs, filePath);
  if (filePath !== undefined) pruneState(state, now());

  /** Replace the in-memory state with `source` (already merged and pruned). */
  function adopt(source: CooldownState): void {
    state.providers.clear();
    state.models.clear();
    state.escalations.clear();
    for (const [key, entry] of source.providers) state.providers.set(key, entry);
    for (const [key, entry] of source.models) state.models.set(key, entry);
    for (const [key, record] of source.escalations) state.escalations.set(key, record);
    state.extras = source.extras;
  }

  /**
   * Re-write the full state under the lock, merging with the file through the
   * same `mergeEntryMaps`/`mergeEscalationMaps` rules `refresh` uses. Those rules
   * order by *mark time* when both sides have one, so this process cannot
   * overwrite a key it did not mark more recently — a stale file cannot shorten a
   * live escalated window, and a fresh hinted window is not reset back to an
   * older guess. Unstamped sides fall back to the safer window, so a mixed-version
   * fleet member's fresh entry is not clobbered just for lacking a stamp.
   */
  function persist(): void {
    if (filePath === undefined || lockPath === undefined) return;
    // Best-effort: the in-memory state is already correct, so a disk error must
    // not fail a sub-agent spawn — persistence is swallowed, not propagated.
    try {
      withLock(fs, lockPath, now(), () => {
        const merged = loadState(fs, filePath);
        mergeEntryMaps(merged.providers, state.providers);
        mergeEntryMaps(merged.models, state.models);
        mergeEscalationMaps(merged.escalations, state.escalations);
        pruneState(merged, now());
        writeState(fs, filePath, merged);
        // Keep memory in step with what was written: another process may hold
        // entries or ladders our snapshot never saw.
        adopt(merged);
      });
    } catch {
      /* ignore */
    }
  }

  function scopeOf(model: string, nowMs?: number): CooldownScope | undefined {
    const t = nowMs ?? now();
    const provider = providerOf(model);
    if (provider !== "") {
      const entry = state.providers.get(provider);
      if (entry && entry.until > t) return "provider";
    }
    const entry = state.models.get(model);
    if (entry && entry.until > t) return "model";
    return undefined;
  }

  return {
    isCoolingDown(model, nowMs) {
      return scopeOf(model, nowMs) !== undefined;
    },
    markCooldown(model, durationSeconds, reason, markOptions) {
      const t = markOptions?.nowMs ?? now();
      // Model scope never escalates, by design: a transient fault or a retired id
      // is endpoint-specific (the same bare id is usually still served by another
      // provider), so laddering a model window would only prolong hiding a
      // healthy candidate. `escalations` stays a provider-only field, and the
      // `hinted` flag is ignored here.
      state.models.set(model, {
        until: t + durationSeconds * 1000,
        reason,
        lastMarkedAt: t,
      });
      persist();
    },
    markProviderCooldown(provider, durationSeconds, reason, markOptions) {
      const t = markOptions?.nowMs ?? now();
      const previousCount = state.escalations.get(provider)?.count ?? 0;
      if (markOptions?.hinted === true) {
        // A provider-supplied reset window is authoritative: set it exactly (even
        // when a previous guess escalated past it) and record the reset as the
        // latest ladder event, so a stale escalated ladder cannot out-vote it.
        state.escalations.set(provider, { count: 0, lastMarkedAt: t });
        state.providers.set(provider, {
          until: t + durationSeconds * 1000,
          reason,
          lastMarkedAt: t,
        });
        persist();
        return;
      }
      const count = previousCount + 1;
      state.escalations.set(provider, { count, lastMarkedAt: t });
      state.providers.set(provider, {
        until: escalatedUntil(durationSeconds, count, t),
        reason,
        escalations: count,
        lastMarkedAt: t,
      });
      persist();
    },
    prune(nowMs) {
      pruneState(state, nowMs ?? now());
    },
    refresh(nowMs) {
      if (filePath === undefined) return;
      // `loadState` already maps a missing, unreadable, or corrupt file to empty
      // state, so a refresh can never throw at a caller like the capacity probe.
      const onDisk = loadState(fs, filePath);
      mergeEntryMaps(state.providers, onDisk.providers);
      mergeEntryMaps(state.models, onDisk.models);
      mergeEscalationMaps(state.escalations, onDisk.escalations);
      // Keep the cached raw file object in step with what was just read: a later
      // serialize must not resurrect unknown fields from the pre-refresh file.
      state.extras = onDisk.extras;
      pruneState(state, nowMs ?? now());
    },
    cooldownScope(model, nowMs) {
      return scopeOf(model, nowMs);
    },
    entries() {
      return state.models;
    },
    providerEntries() {
      return state.providers;
    },
  };
}

/**
 * Epoch ms the `count`-th consecutive unhinted mark cools the provider until.
 * Doubling from the *requested* duration (rather than from the previous
 * remaining time) keeps the ladder monotonic even when the caller's guess
 * changes between marks, and the ceiling bounds a wrong guess at one day.
 */
function escalatedUntil(durationSeconds: number, count: number, nowMs: number): number {
  const escalatedSeconds = Math.min(
    durationSeconds * COOLDOWN_ESCALATION_FACTOR ** (count - 1),
    MAX_ESCALATED_COOLDOWN_SECONDS,
  );
  return nowMs + escalatedSeconds * 1000;
}
