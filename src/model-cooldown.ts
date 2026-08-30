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
 * - **model** (`opencode-go/mimo-v2.5`): a transient failure (5xx, network) is
 *   endpoint-specific — the same bare model id may still be healthy on another
 *   provider, so only this exact endpoint is cooled.
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
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { providerOf } from "./model-classes.js";

export interface CooldownEntry {
  /** Epoch ms until which the target should not be attempted. */
  until: number;
  reason: string;
}

/** Which cooldown scope is blocking a model, when one is. */
export type CooldownScope = "provider" | "model";

export interface ModelCooldownStore {
  /** True when the model endpoint or its provider is cooling down. */
  isCoolingDown(model: string, nowMs?: number): boolean;
  /** Cool down one model endpoint (transient/service failures). */
  markCooldown(model: string, durationSeconds: number, reason: string, nowMs?: number): void;
  /** Cool down a whole provider (quota/credit exhaustion). */
  markProviderCooldown(
    provider: string,
    durationSeconds: number,
    reason: string,
    nowMs?: number,
  ): void;
  prune(nowMs?: number): void;
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

interface PersistedEntry {
  until: number;
  reason: string;
}

/** In-memory state, also the on-disk shape (`providers` + `models` maps). */
interface CooldownState {
  providers: Map<string, CooldownEntry>;
  models: Map<string, CooldownEntry>;
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
  return { providers: new Map(), models: new Map() };
}

/** Parse one scope map; a malformed entry is skipped, not fatal. */
function parseEntryMap(value: unknown): Map<string, CooldownEntry> {
  const result = new Map<string, CooldownEntry>();
  if (typeof value !== "object" || value === null) return result;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const until = (entry as { until?: unknown }).until;
    const reason = (entry as { reason?: unknown }).reason;
    if (typeof until === "number" && Number.isFinite(until) && typeof reason === "string") {
      result.set(key, { until, reason });
    }
  }
  return result;
}

/** Parse the persisted file; a corrupt file yields empty state, never a throw. */
function parseCooldownFile(text: string): CooldownState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyState();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyState();
  const record = parsed as { providers?: unknown; models?: unknown };
  return {
    providers: parseEntryMap(record.providers),
    models: parseEntryMap(record.models),
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

function pruneState(state: CooldownState, nowMs: number): void {
  pruneMap(state.providers, nowMs);
  pruneMap(state.models, nowMs);
}

function toRecord(entries: ReadonlyMap<string, CooldownEntry>): Record<string, PersistedEntry> {
  const record: Record<string, PersistedEntry> = {};
  for (const [key, entry] of entries) {
    record[key] = { until: entry.until, reason: entry.reason };
  }
  return record;
}

function serialize(state: CooldownState): string {
  return JSON.stringify(
    { version: FILE_VERSION, providers: toRecord(state.providers), models: toRecord(state.models) },
    null,
    2,
  );
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

  /**
   * Re-write the full state under the lock, merging with on-disk state so a
   * concurrent writer's entries are not clobbered by our snapshot.
   */
  function persist(): void {
    if (filePath === undefined || lockPath === undefined) return;
    // Best-effort: the in-memory state is already correct, so a disk error must
    // not fail a sub-agent spawn — persistence is swallowed, not propagated.
    try {
      withLock(fs, lockPath, now(), () => {
        const merged = loadState(fs, filePath);
        pruneState(merged, now());
        for (const [provider, entry] of state.providers) merged.providers.set(provider, entry);
        for (const [model, entry] of state.models) merged.models.set(model, entry);
        pruneState(merged, now());
        writeState(fs, filePath, merged);
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
    markCooldown(model, durationSeconds, reason, nowMs) {
      const t = nowMs ?? now();
      state.models.set(model, { until: t + durationSeconds * 1000, reason });
      persist();
    },
    markProviderCooldown(provider, durationSeconds, reason, nowMs) {
      const t = nowMs ?? now();
      state.providers.set(provider, { until: t + durationSeconds * 1000, reason });
      persist();
    },
    prune(nowMs) {
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
