/**
 * Honcho memory HTTP client — dependency-free fetch client for the Honcho v3 API.
 *
 * Two thin request builders produce `{ url, init }` pairs (pure, testable) and
 * one executor performs the fetch with an abort timeout. Every expected
 * failure — network rejection, HTTP non-2xx, non-JSON body — is returned as
 * `{ ok: false, error }`, never thrown.
 */

import type { HonchoConfig } from "./config.js";

export interface HonchoMessage {
  content: string;
  peerId: string;
  metadata?: Record<string, string>;
}

export type HonchoWriteResult = { ok: true } | { ok: false; error: string };

export type HonchoContextResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Fetch seam so tests can inject a mock without stubbing the global. */
export interface HonchoHttp {
  fetch: typeof fetch;
}

export interface HonchoRequest {
  url: string;
  init: RequestInit;
}

/** Build the POST request that appends messages to a Honcho session. */
export function buildCreateMessagesRequest(
  config: HonchoConfig,
  sessionId: string,
  messages: HonchoMessage[],
): HonchoRequest {
  const url =
    `${config.baseUrl}/v3/workspaces/${encodeURIComponent(config.workspaceId)}` +
    `/sessions/${encodeURIComponent(sessionId)}/messages`;
  return {
    url,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: messages.map((message) => ({
          content: message.content,
          peer_id: message.peerId,
          metadata: message.metadata,
        })),
      }),
    },
  };
}

/**
 * Build the GET request for session context. Honcho's session-context endpoint
 * accepts `peer_target`, `search_query`, `tokens`, and `summary` query params
 * and returns summary + matching context (the peer-level representation
 * endpoint is a wrapper around this shape, so this is the cleaner primitive).
 */
export function buildGetContextRequest(
  config: HonchoConfig,
  sessionId: string,
  peerId: string,
  query: string,
): HonchoRequest {
  const url =
    `${config.baseUrl}/v3/workspaces/${encodeURIComponent(config.workspaceId)}` +
    `/sessions/${encodeURIComponent(sessionId)}/context` +
    `?peer_target=${encodeURIComponent(peerId)}` +
    `&search_query=${encodeURIComponent(query)}` +
    `&tokens=${String(config.contextTokens)}` +
    `&summary=true`;

  return {
    url,
    init: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    },
  };
}

/**
 * Read a JSON response body, returning an error union for non-2xx statuses
 * and non-JSON bodies. Errors are values, not exceptions.
 */
async function readJsonResponse(
  response: Response,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "non-JSON response body" };
  }
}

/** Create a Honcho client with a write and read path. */
export function createHonchoClient(
  config: HonchoConfig,
  deps: HonchoHttp,
): {
  writeMessages(sessionId: string, messages: HonchoMessage[]): Promise<HonchoWriteResult>;
  readContext(sessionId: string, peerId: string, query: string): Promise<HonchoContextResult>;
} {
  async function writeMessages(
    sessionId: string,
    messages: HonchoMessage[],
  ): Promise<HonchoWriteResult> {
    const request = buildCreateMessagesRequest(config, sessionId, messages);
    let response: Response;
    try {
      response = await deps.fetch(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `failed to write messages: ${message}` };
    }

    const read = await readJsonResponse(response);
    if (!read.ok) return { ok: false, error: read.error };
    return { ok: true };
  }

  async function readContext(
    sessionId: string,
    peerId: string,
    query: string,
  ): Promise<HonchoContextResult> {
    const request = buildGetContextRequest(config, sessionId, peerId, query);
    let response: Response;
    try {
      response = await deps.fetch(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `failed to read context: ${message}` };
    }

    return readJsonResponse(response);
  }

  return { writeMessages, readContext };
}
