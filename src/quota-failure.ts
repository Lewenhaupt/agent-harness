/**
 * Quota/credit/rate-limit failure classification.
 *
 * The harness spawns pi as a subprocess and historically watched exit code +
 * stderr. Empirically (bd-16 prototype) a quota/credit failure does NOT
 * surface that way: pi exits 0, stderr is empty, and the failure is only in
 * the structured `message_end` event (role=assistant, stopReason="error",
 * errorMessage="429: {...}"). This classifier reads `SpawnDetails` and returns
 * a discriminated union; the fallback loop acts only on "quota"/"transient".
 *
 * Status codes and network-error signatures harvested from
 * @pedro_klein/pi-gateway's detect.ts.
 */

import type { SpawnDetails } from "./agent-registry.js";

export type FailureKind = "success" | "quota" | "transient" | "auth" | "other";

export interface FailureClassification {
  kind: FailureKind;
  /** Model id reported by the failing event, if any. */
  model?: string;
  /** Human-readable reason for the classification. */
  reason?: string;
  /** Suggested cooldown, when kind is quota/transient. */
  cooldownSeconds?: number;
}

/** Default cooldown when a quota failure has no parseable reset hint. */
export const DEFAULT_QUOTA_COOLDOWN_SECONDS = 15 * 60;
/** Cooldown for transient network/service failures. */
export const DEFAULT_TRANSIENT_COOLDOWN_SECONDS = 5 * 60;

/** Status codes indicating a capacity/quota/credit/rate limit. */
const QUOTA_STATUS_CODES = new Set([402, 429]);
/** Status codes indicating a transient service failure. */
const TRANSIENT_STATUS_CODES = new Set([408, 425, 500, 502, 503, 504]);
/** Status codes indicating an auth problem — not solved by switching models. */
const AUTH_STATUS_CODES = new Set([401, 403]);

/** Statusless network-error signatures (matches pi-gateway detect.ts). */
const NETWORK_ERROR_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|connection reset|service unavailable/i;

/**
 * Classify a spawn result into one of the failure kinds.
 *
 * Pure — reads only the passed-in details and returns a value.
 */
export function classifySpawnFailure(details: SpawnDetails): FailureClassification {
  const assistant = lastAssistantMessage(details.messages);

  // No assistant error event: either clean success, or a startup/config failure
  // (model not found, bad flag) that surfaces via exit code + stderr.
  if (!assistant || assistant.stopReason !== "error") {
    if (details.exitCode !== 0) {
      return {
        kind: "other",
        reason:
          "Process exited non-zero without an assistant error event (startup or config failure).",
      };
    }
    return { kind: "success" };
  }

  const status = extractStatus(assistant);
  const model = typeof assistant.model === "string" ? assistant.model : details.model;
  const errorMessage =
    typeof assistant.errorMessage === "string" ? assistant.errorMessage : undefined;

  return classifyAssistantError(status, model, errorMessage);
}

/** Classify an assistant `message_end` error by its HTTP status / network signature. */
function classifyAssistantError(
  status: number | undefined,
  model: string | undefined,
  errorMessage: string | undefined,
): FailureClassification {
  if (status !== undefined && QUOTA_STATUS_CODES.has(status)) {
    return {
      kind: "quota",
      model,
      reason: `Quota/credit/rate limit (HTTP ${status}).`,
      cooldownSeconds: parseQuotaResetSeconds(errorMessage) ?? DEFAULT_QUOTA_COOLDOWN_SECONDS,
    };
  }
  if (status !== undefined && AUTH_STATUS_CODES.has(status)) {
    return {
      kind: "auth",
      model,
      reason: `Authentication/authorization failure (HTTP ${status}).`,
    };
  }
  if (status !== undefined && TRANSIENT_STATUS_CODES.has(status)) {
    return {
      kind: "transient",
      model,
      reason: `Transient service failure (HTTP ${status}).`,
      cooldownSeconds: DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
    };
  }
  if (
    status === undefined &&
    errorMessage !== undefined &&
    NETWORK_ERROR_PATTERN.test(errorMessage)
  ) {
    return {
      kind: "transient",
      model,
      reason: "Network error.",
      cooldownSeconds: DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
    };
  }

  return {
    kind: "other",
    model,
    reason: `Unrecognized failure (stopReason=error${status !== undefined ? `, HTTP ${status}` : ""}).`,
  };
}

/** Parse "Resets in 2d 3h 45m"-style hints into total seconds, if present. */
export function parseQuotaResetSeconds(errorMessage?: string): number | undefined {
  if (!errorMessage) return undefined;
  const match =
    /resets in\s+(?:(\d+)\s*(?:d|day|days))?\s*(?:(\d+)\s*(?:hr|h|hour|hours))?\s*(?:(\d+)\s*(?:min|m|minute|minutes))?/i.exec(
      errorMessage,
    );
  if (!match) return undefined;

  const days = match[1] ? Number(match[1]) : 0;
  const hours = match[2] ? Number(match[2]) : 0;
  const minutes = match[3] ? Number(match[3]) : 0;
  if (days === 0 && hours === 0 && minutes === 0) return undefined;

  return days * 86_400 + hours * 3_600 + minutes * 60;
}

/** The most recent assistant message, or undefined if none. */
function lastAssistantMessage(messages: unknown[]): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as Record<string, unknown> | null;
    if (msg && msg.role === "assistant") return msg;
  }
  return undefined;
}

/**
 * Extract an HTTP status from a message: a structured `errorStatus` field, or
 * the leading "NNN:" prefix of `errorMessage` (e.g. "429: {...}").
 */
function extractStatus(msg: Record<string, unknown>): number | undefined {
  const errorStatus = msg.errorStatus;
  if (typeof errorStatus === "number" && Number.isInteger(errorStatus)) return errorStatus;

  const errorMessage = msg.errorMessage;
  if (typeof errorMessage !== "string") return undefined;
  const match = /^(\d{3})\b/.exec(errorMessage);
  return match ? Number(match[1]) : undefined;
}
