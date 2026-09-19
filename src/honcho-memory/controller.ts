/**
 * Honcho memory controller — orchestration plus a per-session retrieval cache.
 *
 * The controller owns a closure-scoped cache so a single agent run only pays
 * the Honcho round-trip once per session id. All client failures are values,
 * so retrieve silently degrades to undefined and record propagates its result.
 */

import type { HonchoMessage, HonchoWriteResult } from "./client.js";
import type { HonchoConfig } from "./config.js";
import { formatMemoryContext } from "./selectors.js";

export interface HonchoMemoryClient {
  writeMessages(sessionId: string, messages: HonchoMessage[]): Promise<HonchoWriteResult>;
  readContext(
    sessionId: string,
    peerId: string,
    query: string,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
}

export interface HonchoMemoryController {
  retrieve(sessionId: string, peerId: string, query: string): Promise<string | undefined>;
  record(sessionId: string, messages: HonchoMessage[]): Promise<HonchoWriteResult>;
  reset(): void;
}

/** Create a controller that caches retrieved memory per session id. */
// `config` is part of the public API (callers pass the same resolved config
// they hand to createHonchoClient), but this controller only needs the client.
export function createHonchoMemoryController(
  _config: HonchoConfig,
  client: HonchoMemoryClient,
): HonchoMemoryController {
  // Session-scoped cache: once a session's memory has been read (successfully
  // or not) we do not re-fetch, so a single task never pays multiple
  // round-trips. The cache short-circuits failures as `undefined`, which is
  // what "gracefully degrading" means here.
  const cache = new Map<string, string | undefined>();

  async function retrieve(
    sessionId: string,
    peerId: string,
    query: string,
  ): Promise<string | undefined> {
    if (cache.has(sessionId)) {
      const cached = cache.get(sessionId);
      return cached === undefined ? undefined : cached;
    }

    const result = await client.readContext(sessionId, peerId, query);
    if (!result.ok) {
      cache.set(sessionId, undefined);
      return undefined;
    }

    const formatted = formatMemoryContext(result.value);
    cache.set(sessionId, formatted);
    return formatted;
  }

  async function record(sessionId: string, messages: HonchoMessage[]): Promise<HonchoWriteResult> {
    // Writes do not touch the cache — the next agent run starts a fresh
    // session and should read the just-written memory back.
    return client.writeMessages(sessionId, messages);
  }

  function reset(): void {
    cache.clear();
  }

  return { retrieve, record, reset };
}
