/**
 * Per-scope credential cache (bd-125).
 *
 * The SDK never caches a `credential_process` result — botocore re-runs the
 * shim for every credential lookup — so the broker is the cache. Two
 * properties matter:
 *
 * - **Single flight**: N concurrent requests for the same profile must cause
 *   exactly one `aws` spawn. Otherwise a burst of SDK calls turns into a burst
 *   of CLI processes all hitting IAM Identity Center.
 * - **Bounded**: one entry per profile, capped by a small LRU, so a scope can
 *   never grow an unbounded credential store in memory.
 */

import type { AwsCredentials, AwsResult } from "./aws-cli.ts";

/** Refresh this long before `Expiration` so an in-flight request never gets a
 * credential that expires mid-call. */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Cap on cached profiles per scope. A scope serves exactly one today, so this
 * only bounds the diagnostics/future-multi-profile case. */
export const DEFAULT_MAX_ENTRIES = 4;

/** Options for {@link createCredentialCache}. */
export interface CredentialCacheOptions {
  /** Inject the resolver (the AWS CLI in production). */
  resolve: (profile: string) => Promise<AwsResult<AwsCredentials>>;
  /** Clock, milliseconds since epoch. */
  now?: () => number;
  /** Refresh window before expiry. */
  refreshSkewMs?: number;
  /** Maximum cached profiles (LRU bound). */
  maxEntries?: number;
}

/** Cache surface used by the scope server. */
export interface CredentialCache {
  get(profile: string): Promise<AwsResult<AwsCredentials>>;
  /** Number of cached entries; for tests and diagnostics. */
  size(): number;
  /** Drop everything (used on shutdown). */
  clear(): void;
}

interface CacheEntry {
  credentials: AwsCredentials;
  expiresAtMs: number;
}

/** Create a singly-flighted, LRU-bounded credential cache. */
export function createCredentialCache(options: CredentialCacheOptions): CredentialCache {
  const now = options.now ?? Date.now;
  const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  // Map insertion order doubles as LRU order: delete + set on every hit.
  const entries = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<AwsResult<AwsCredentials>>>();

  const isFresh = (entry: CacheEntry): boolean => entry.expiresAtMs - refreshSkewMs > now();

  const store = (profile: string, credentials: AwsCredentials): void => {
    entries.delete(profile);
    entries.set(profile, {
      credentials,
      expiresAtMs: new Date(credentials.Expiration).getTime(),
    });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  };

  const get = (profile: string): Promise<AwsResult<AwsCredentials>> => {
    const cached = entries.get(profile);
    if (cached !== undefined && isFresh(cached)) {
      // Refresh LRU position.
      entries.delete(profile);
      entries.set(profile, cached);
      return Promise.resolve({ ok: true, value: cached.credentials });
    }
    if (cached !== undefined) entries.delete(profile);

    const pending = inFlight.get(profile);
    if (pending !== undefined) return pending;

    const request = options.resolve(profile).then((result) => {
      inFlight.delete(profile);
      if (result.ok) {
        const expiresAtMs = new Date(result.value.Expiration).getTime();
        if (Number.isNaN(expiresAtMs) || expiresAtMs <= now()) {
          // An already-expired document is still returned once (the caller
          // decides), but it must not be cached: the next request re-resolves
          // so a fresh `aws sso login` is picked up immediately.
          return result;
        }
        store(profile, result.value);
      }
      // Failures propagate unchanged and are never cached, so the operator's
      // `aws sso login` takes effect on the very next request.
      return result;
    });
    inFlight.set(profile, request);
    return request;
  };

  return {
    get,
    size: () => entries.size,
    clear: () => {
      entries.clear();
      inFlight.clear();
    },
  };
}
