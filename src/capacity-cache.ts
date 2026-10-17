/**
 * Pre-dispatch provider capacity cache.
 *
 * The fallback loop's cooldown store is reactive: it learns a provider is
 * exhausted only after a 429. This cache carries a *pre-dispatch* capacity
 * signal so the first attempt of a workflow can avoid a provider a prior run
 * already observed as exhausted — e.g. an opencode-go weekly limit whose reset
 * window `parseQuotaResetSeconds` extracted from the 429 body (bd-38).
 *
 * Windows come from a probe. By default the probe reads the persisted cooldown
 * store's provider entries; when `BELAYD_CAPACITY_PROBE_URL` is set the
 * extension instead probes that usage/reset endpoint. Probe results are cached
 * for `ttlInMs` (default {@link DEFAULT_CAPACITY_TTL_MS}) so a 6-phase workflow
 * re-probes at most once per TTL rather than once per phase. Mid-workflow 429s
 * are fed back in via `record`, so the cache stays fresh within the TTL too.
 *
 * A probe failure is never fatal to a spawn: `refreshIfStale` catches probe
 * errors/timeouts, drops the failed attempt (so the next call re-probes), and
 * leaves the previously cached windows untouched. Capacity ignorance is safe;
 * blocking a sub-agent on a capacity probe is not.
 */

import { providerOf } from "./model-classes.js";
import type { ModelCooldownStore } from "./model-cooldown.js";
import { parseQuotaResetSeconds } from "./quota-failure.js";

/** One provider's known exhaustion window. */
export interface CapacityWindow {
  provider: string;
  /** Epoch ms when the provider is expected to serve requests again. */
  resetAt: number;
  reason: string;
}

export interface CapacityProbeResult {
  windows: CapacityWindow[];
}

export type CapacityProbe = () => Promise<CapacityProbeResult> | CapacityProbeResult;

export interface CapacityCacheOptions {
  /** Capacity signal source. Omit for a record-only cache (tests, callers that seed it). */
  probe?: CapacityProbe;
  /** How long a probe result is trusted. Defaults to {@link DEFAULT_CAPACITY_TTL_MS}. */
  ttlInMs?: number;
  /** Hard bound on one probe call. Defaults to {@link DEFAULT_CAPACITY_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
  /** Epoch-ms clock (test seam). Defaults to Date.now. */
  now?: () => number;
}

export interface CapacityCache {
  /** True when the provider has an unexpired exhaustion window. */
  isExhausted(provider: string, nowMs?: number): boolean;
  /** True when the model's provider has an unexpired exhaustion window. */
  isModelExhausted(model: string, nowMs?: number): boolean;
  /**
   * Run the probe when no fresh result is cached; otherwise keep the cache.
   * Never rejects: probe errors/timeouts are swallowed and re-probed next call.
   */
  refreshIfStale(nowMs?: number): Promise<void>;
  /** Record an observed window (e.g. a freshly parsed 429 reset). */
  record(window: CapacityWindow): void;
  /** Snapshot of the unexpired windows. */
  windows(nowMs?: number): readonly CapacityWindow[];
  /** The cache's epoch-ms clock, so callers can stamp recorded windows consistently. */
  nowMs(): number;
}

/** Five minutes: one multi-phase workflow, short enough to notice a reset. */
export const DEFAULT_CAPACITY_TTL_MS = 5 * 60 * 1000;
/** Two seconds: bounded so a hung endpoint cannot stall every spawn in the loop. */
export const DEFAULT_CAPACITY_PROBE_TIMEOUT_MS = 2_000;
/** Cap on accepted provider windows, so a hostile/oversized body cannot blow up the cache. */
export const MAX_CAPACITY_WINDOWS = 50;
/** Cap on response body bytes the endpoint probe will parse. */
export const DEFAULT_CAPACITY_BODY_LIMIT_BYTES = 256 * 1024;
/** Env var naming the optional provider usage/reset endpoint. */
export const CAPACITY_PROBE_URL_ENV = "BELAYD_CAPACITY_PROBE_URL";

/** Default probe: treat persisted provider cooldowns as capacity windows. */
export function probeFromCooldownStore(store: ModelCooldownStore): CapacityProbe {
  return () => ({
    windows: [...store.providerEntries()].map(([provider, entry]) => ({
      provider,
      resetAt: entry.until,
      reason: entry.reason,
    })),
  });
}

/** Reject after `timeoutMs` if `promise` has not settled; clears the timer either way. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("capacity probe timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Tolerant reset-time extraction from one provider entry: an absolute epoch ms
 * (`resetAt`/`until`) or a relative window (`resetsInSeconds`/`resetInSeconds`
 * number, or a "Resets in 7hr 57min" string).
 */
function resetAtOf(record: Record<string, unknown>, nowMs: number): number | undefined {
  const absolute =
    numberField(record, "resetAt") ??
    numberField(record, "until") ??
    numberField(record, "resetsAt");
  if (absolute !== undefined) return absolute;

  const seconds = numberField(record, "resetsInSeconds") ?? numberField(record, "resetInSeconds");
  if (seconds !== undefined) return nowMs + seconds * 1000;

  const hint = stringField(record, "resetsIn") ?? stringField(record, "message");
  if (hint === undefined) return undefined;
  const parsed = parseQuotaResetSeconds(hint);
  return parsed === undefined ? undefined : nowMs + parsed * 1000;
}

function windowFromEntry(
  provider: string,
  entry: unknown,
  nowMs: number,
): CapacityWindow | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const resetAt = resetAtOf(record, nowMs);
  if (resetAt === undefined) return undefined;
  const reason = stringField(record, "reason") ?? "endpoint capacity";
  return { provider, resetAt, reason };
}

function windowsFromList(list: readonly unknown[], nowMs: number): CapacityWindow[] {
  const windows: CapacityWindow[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const provider = stringField(entry as Record<string, unknown>, "provider");
    if (provider === undefined) continue;
    const window = windowFromEntry(provider, entry, nowMs);
    if (window !== undefined) windows.push(window);
  }
  return windows;
}

function windowsFromProviderMap(map: unknown, nowMs: number): CapacityWindow[] {
  if (typeof map !== "object" || map === null) return [];
  const windows: CapacityWindow[] = [];
  for (const [provider, entry] of Object.entries(map as Record<string, unknown>)) {
    const window = windowFromEntry(provider, entry, nowMs);
    if (window !== undefined) windows.push(window);
  }
  return windows;
}

/**
 * Parse a usage/reset endpoint body into provider windows. Accepts a direct
 * `{ windows: [...] }`, a nested `{ providers: { ... } }`, or a top-level
 * provider map. Anything unrecognized yields no windows (capacity ignorance).
 */
export function parseCapacityWindows(body: unknown, nowMs: number): CapacityWindow[] {
  if (typeof body !== "object" || body === null) return [];
  const root = body as Record<string, unknown>;
  const windows = Array.isArray(root.windows)
    ? windowsFromList(root.windows, nowMs)
    : root.providers !== undefined
      ? windowsFromProviderMap(root.providers, nowMs)
      : windowsFromProviderMap(root, nowMs);
  return windows.slice(0, MAX_CAPACITY_WINDOWS);
}

export interface EndpointCapacityProbeOptions {
  url: string;
  /** Bound on the HTTP request itself. Defaults to the shared probe timeout. */
  timeoutMs?: number;
  /** Fetch seam (test seam). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Epoch-ms clock (test seam). Defaults to Date.now. */
  now?: () => number;
  /** Cap on body bytes read before parsing. Defaults to {@link DEFAULT_CAPACITY_BODY_LIMIT_BYTES}. */
  maxBodyBytes?: number;
  /** Called with a short reason when the probe fails or yields no windows. */
  onFailure?: (reason: string) => void;
  /** Minimum gap between `onFailure` calls; bounds log spam. Defaults to 5 minutes. */
  failureWarnIntervalMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read a response body, refusing anything over `maxBytes`. */
async function readCappedText(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers?.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;

  const body = response.body;
  if (body === null || body === undefined) {
    // No readable stream means the body cannot be bounded as it arrives, so
    // refuse it rather than buffering an unbounded `text()` past the cap.
    return undefined;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

/**
 * Provider usage/reset endpoint probe. Never rejects and never returns a
 * partial parse: a non-200 response, malformed JSON, timeout, abort, or an
 * oversized body all yield an empty window list so the spawn loop proceeds on
 * ignorance. `onFailure` is throttled so a persistently broken endpoint cannot
 * warn once per spawn.
 */
export function createEndpointCapacityProbe(options: EndpointCapacityProbeOptions): CapacityProbe {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPACITY_PROBE_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_CAPACITY_BODY_LIMIT_BYTES;
  const now = options.now ?? Date.now;
  const onFailure = options.onFailure;
  const warnIntervalMs = options.failureWarnIntervalMs ?? DEFAULT_CAPACITY_TTL_MS;
  let lastFailureAt: number | undefined;

  function reportFailure(reason: string): void {
    if (onFailure === undefined) return;
    const at = now();
    if (lastFailureAt !== undefined && at - lastFailureAt < warnIntervalMs) return;
    lastFailureAt = at;
    onFailure(reason);
  }

  return async () => {
    let response: Response;
    try {
      response = await withTimeout(
        fetchFn(options.url, {
          method: "GET",
          headers: { accept: "application/json" },
          // AbortSignal makes the timeout cancel the actual request, not just
          // the race; otherwise a hung endpoint keeps its connection open.
          signal: AbortSignal.timeout(timeoutMs),
        }),
        timeoutMs,
      );
    } catch (error) {
      reportFailure(`request failed (${errorMessage(error)})`);
      return { windows: [] };
    }

    if (!response.ok) {
      reportFailure(`HTTP ${response.status}`);
      return { windows: [] };
    }

    let text: string | undefined;
    try {
      text = await readCappedText(response, maxBodyBytes);
    } catch (error) {
      reportFailure(`body read failed (${errorMessage(error)})`);
      return { windows: [] };
    }
    if (text === undefined) {
      reportFailure(`response body exceeded ${maxBodyBytes} bytes`);
      return { windows: [] };
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      reportFailure("malformed JSON body");
      return { windows: [] };
    }

    const windows = parseCapacityWindows(body, now());
    if (windows.length === 0) reportFailure("endpoint returned no capacity windows");
    return { windows };
  };
}

/**
 * First probe yielding windows wins; a rejecting probe is skipped. Used to keep
 * the cooldown-store signal as a fallback when the configured endpoint is
 * misconfigured or unreachable.
 */
export function createFallbackCapacityProbe(...probes: readonly CapacityProbe[]): CapacityProbe {
  return async () => {
    for (const probe of probes) {
      try {
        const result = await probe();
        if (result.windows.length > 0) return result;
      } catch {
        // Try the next probe; refreshIfStale also swallows a total failure.
      }
    }
    return { windows: [] };
  };
}

/**
 * Partition candidates into available-then-exhausted, preserving each group's
 * original order. Pure, so the ordering rule is testable without a cache.
 * Exhausted candidates stay in the list (as a last resort) rather than being
 * dropped, so a reset that lands mid-loop can still be used.
 */
export function orderCandidatesByCapacity(
  candidates: readonly string[],
  isExhausted: (candidate: string) => boolean,
): string[] {
  const available: string[] = [];
  const exhausted: string[] = [];
  for (const candidate of candidates) {
    if (isExhausted(candidate)) {
      exhausted.push(candidate);
    } else {
      available.push(candidate);
    }
  }
  return [...available, ...exhausted];
}

export function createCapacityCache(options: CapacityCacheOptions = {}): CapacityCache {
  const now = options.now ?? Date.now;
  const ttlInMs = options.ttlInMs ?? DEFAULT_CAPACITY_TTL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_CAPACITY_PROBE_TIMEOUT_MS;
  const probe = options.probe;
  const cached = new Map<string, CapacityWindow>();
  let lastProbeAt: number | undefined;

  function isExhausted(provider: string, nowMs?: number): boolean {
    if (provider === "") return false;
    const window = cached.get(provider);
    return window !== undefined && window.resetAt > (nowMs ?? now());
  }

  return {
    isExhausted,
    isModelExhausted(model, nowMs) {
      return isExhausted(providerOf(model), nowMs);
    },
    async refreshIfStale(nowMs) {
      if (probe === undefined) return;
      const at = nowMs ?? now();
      if (lastProbeAt !== undefined && at - lastProbeAt < ttlInMs) return;
      // Optimistically mark the attempt fresh, then roll back on failure so a
      // failed probe is retried on the next call instead of being suppressed
      // for the whole TTL. The previous windows remain cached either way.
      lastProbeAt = at;
      try {
        const result = await withTimeout(Promise.resolve(probe()), probeTimeoutMs);
        for (const window of result.windows) cached.set(window.provider, window);
      } catch {
        lastProbeAt = undefined;
      }
    },
    record(window) {
      cached.set(window.provider, window);
    },
    windows(nowMs) {
      const at = nowMs ?? now();
      return [...cached.values()].filter((window) => window.resetAt > at);
    },
    nowMs() {
      return now();
    },
  };
}
