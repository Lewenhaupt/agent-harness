// SYNC WARNING: this file is the plain-JS mirror of the durable-member contract
// in `src/durable-member/commands.ts` (validation) and
// `src/durable-member/contract.ts` (frame reduction and the conversation view
// state). The TS side validates boundary data with **zod**; this mirror stays
// hand-rolled on purpose — the plugin is served from source with no build step
// and no runtime dependencies, so it cannot import zod or TypeScript. That
// asymmetry is the sanctioned exception, not drift.
//
// Every rule must still match: the allowed kinds and authorities, the
// request-id shape (which is also a filename-safety rule), the 64 KiB UTF-8 text
// budget, the write-entry shape, the first-issue refusal codes, the dedupe-by-id
// merge, the `(timestamp, id)` ordering and the live-generation staleness rule
// (`reduceLiveLiveness`). The parity test
// `src/__tests__/durable-member-contract-parity.test.ts` drives both
// implementations over `fixtures/*.json` and fails on disagreement. The panel is
// never the authorization gate: `controlAvailability` below only decides which
// controls to offer, the server module forwards only the `panel-human` tier, and
// the member's owner verifies the claim against its bound tier in
// `src/durable-member/authority.ts`.

/** Every command kind the control plane accepts. */
export const DURABLE_COMMAND_KINDS = [
  "steer",
  "followup",
  "write",
  "abort-submission",
  "abort",
  "configure",
  "compact",
  "reset",
];

/** Who claims to be sending a command. */
export const DURABLE_AUTHORITIES = ["panel-human", "fleet-supervisor", "phase-subagent"];

/** Roles a `write` entry may carry. */
export const DURABLE_WRITE_ROLES = ["user", "assistant", "system"];

/** Upper bound on any command-authored text, measured in UTF-8 bytes. */
export const MAX_DURABLE_COMMAND_TEXT_BYTES = 64 * 1024;

/** Request ids name mailbox files, so the shape is also a path-safety rule. */
export const MAX_DURABLE_REQUEST_ID_LENGTH = 200;

export const MAX_DURABLE_MEMBER_ID_LENGTH = 200;

export const MAX_DURABLE_SUBMISSION_ID_LENGTH = 200;

/** Default entries retained by a merged conversation view. */
export const DEFAULT_VIEW_WINDOW = 200;

/** Kinds that change the agent's contract and therefore need confirmation. */
export const CONFIRMATION_REQUIRED_KINDS = ["configure", "reset"];

/** Kinds a human at the panel may send freely. */
export const PANEL_ALLOWED_KINDS = [
  "steer",
  "followup",
  "write",
  "abort-submission",
  "abort",
  "compact",
];

/** Kinds the fleet supervisor may send: lifecycle only. */
export const SUPERVISOR_ALLOWED_KINDS = ["abort-submission", "abort"];

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const encoder = new TextEncoder();

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value) {
  return encoder.encode(value).length;
}

function invalid(code, error) {
  return { ok: false, code, error };
}

function readIdentifier(value, maxLength) {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > maxLength) return undefined;
  return IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

function readText(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return byteLength(value) > MAX_DURABLE_COMMAND_TEXT_BYTES ? undefined : value;
}

function readRequiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, code: "missing-text", error: `${field} requires bounded non-empty text` };
  }
  if (byteLength(value) > MAX_DURABLE_COMMAND_TEXT_BYTES) {
    return {
      ok: false,
      code: "text-too-large",
      error: `${field} exceeds ${MAX_DURABLE_COMMAND_TEXT_BYTES} UTF-8 bytes`,
    };
  }
  return { ok: true, value };
}

function readOptionalText(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false };
  if (byteLength(value) > MAX_DURABLE_COMMAND_TEXT_BYTES) return { ok: false };
  return { ok: true, value };
}

function readWriteEntry(value) {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "invalid-entry",
      error: "write requires an entry with role, text and optional kind",
    };
  }
  if (typeof value.role !== "string" || !DURABLE_WRITE_ROLES.includes(value.role)) {
    return {
      ok: false,
      code: "invalid-entry",
      error: "write requires an entry with role, text and optional kind",
    };
  }
  const text = readRequiredText(value.text, "write entry text");
  if (!text.ok) return text;
  if (value.kind !== undefined && value.kind !== "note" && value.kind !== "context") {
    return { ok: false, code: "invalid-entry", error: "write entry kind must be note or context" };
  }
  const entry =
    value.kind === undefined
      ? { role: value.role, text: text.value }
      : { role: value.role, text: text.value, kind: value.kind };
  return { ok: true, entry };
}

function readConfig(value) {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length === 0) return undefined;
  for (const key of keys) {
    if (key !== "model" && key !== "tools" && key !== "systemPrompt") return undefined;
  }
  const config = {};
  if (value.model !== undefined) {
    const model = readText(value.model);
    if (model === undefined) return undefined;
    config.model = model;
  }
  if (value.systemPrompt !== undefined) {
    const systemPrompt = readText(value.systemPrompt);
    if (systemPrompt === undefined) return undefined;
    config.systemPrompt = systemPrompt;
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > 200) {
      return undefined;
    }
    const tools = [];
    for (const tool of value.tools) {
      const name = readText(tool);
      if (name === undefined) return undefined;
      tools.push(name);
    }
    config.tools = tools;
  }
  return config;
}

function readEnvelope(raw, options) {
  const requestId = readIdentifier(raw.requestId, MAX_DURABLE_REQUEST_ID_LENGTH);
  if (requestId === undefined) {
    return invalid("missing-request-id", "requestId must be a bounded identifier");
  }
  const memberId = readIdentifier(raw.memberId, MAX_DURABLE_MEMBER_ID_LENGTH);
  if (memberId === undefined) {
    return invalid("missing-member-id", "memberId must be a bounded identifier");
  }
  if (options?.memberId !== undefined && memberId !== options.memberId) {
    return invalid(
      "member-mismatch",
      `command targets member ${memberId}, this control surface owns ${options.memberId}`,
    );
  }
  if (!DURABLE_AUTHORITIES.includes(raw.authority)) {
    return invalid("unknown-authority", "authority must be a known role");
  }
  if (typeof raw.issuedAt !== "number" || !Number.isFinite(raw.issuedAt) || raw.issuedAt <= 0) {
    return invalid("invalid-issued-at", "issuedAt must be a positive epoch millisecond");
  }
  if (raw.confirmation !== undefined && typeof raw.confirmation !== "string") {
    return invalid("invalid-confirmation", "confirmation must be a string when present");
  }
  const envelope = { requestId, memberId, authority: raw.authority, issuedAt: raw.issuedAt };
  if (raw.confirmation !== undefined) envelope.confirmation = raw.confirmation;
  return { ok: true, envelope };
}

/**
 * Validate one untrusted command. Mirrors `validateDurableCommand`.
 *
 * @param {unknown} raw
 * @param {{ memberId?: string }} [options]
 * @returns {{ ok: true, value: object } | { ok: false, code: string, error: string }}
 */
export function validateCommand(raw, options) {
  if (!isRecord(raw)) return invalid("invalid-shape", "a command must be a JSON object");
  if (!DURABLE_COMMAND_KINDS.includes(raw.kind)) {
    return invalid(
      "unknown-kind",
      `kind must be one of ${DURABLE_COMMAND_KINDS.join(", ")}`,
    );
  }
  const envelope = readEnvelope(raw, options);
  if (!envelope.ok) return envelope;
  const base = envelope.envelope;

  switch (raw.kind) {
    case "steer":
    case "followup": {
      const text = readRequiredText(raw.text, raw.kind);
      if (!text.ok) return text;
      return { ok: true, value: { ...base, kind: raw.kind, text: text.value } };
    }
    case "write": {
      const entry = readWriteEntry(raw.entry);
      if (!entry.ok) return entry;
      return { ok: true, value: { ...base, kind: "write", entry: entry.entry } };
    }
    case "abort-submission": {
      const submissionId = readIdentifier(raw.submissionId, MAX_DURABLE_SUBMISSION_ID_LENGTH);
      if (submissionId === undefined) {
        return invalid("invalid-submission-id", "abort-submission requires a bounded submissionId");
      }
      return { ok: true, value: { ...base, kind: "abort-submission", submissionId } };
    }
    case "abort": {
      const reason = readOptionalText(raw.reason);
      if (!reason.ok) return invalid("text-too-large", "abort reason is too large");
      return {
        ok: true,
        value:
          reason.value === undefined
            ? { ...base, kind: "abort" }
            : { ...base, kind: "abort", reason: reason.value },
      };
    }
    case "configure": {
      const config = readConfig(raw.config);
      if (config === undefined) {
        return invalid(
          "invalid-config",
          "configure requires a config of model, tools or systemPrompt",
        );
      }
      return { ok: true, value: { ...base, kind: "configure", config } };
    }
    case "compact": {
      const instructions = readOptionalText(raw.instructions);
      if (!instructions.ok) return invalid("text-too-large", "compact instructions are too large");
      return {
        ok: true,
        value:
          instructions.value === undefined
            ? { ...base, kind: "compact" }
            : { ...base, kind: "compact", instructions: instructions.value },
      };
    }
    case "reset": {
      if (raw.keepHistory !== undefined && typeof raw.keepHistory !== "boolean") {
        return invalid("invalid-shape", "reset keepHistory must be a boolean when present");
      }
      return {
        ok: true,
        value:
          raw.keepHistory === undefined
            ? { ...base, kind: "reset" }
            : { ...base, kind: "reset", keepHistory: raw.keepHistory },
      };
    }
    default:
      return invalid("unknown-kind", `kind must be one of ${DURABLE_COMMAND_KINDS.join(", ")}`);
  }
}

function compareEntries(left, right) {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function orderAndTrim(merged, maxEntries) {
  const ordered = [...merged.values()].sort(compareEntries);
  const trimmed = ordered.length > maxEntries ? ordered.slice(ordered.length - maxEntries) : ordered;
  return { ordered, trimmed };
}

/**
 * Merge one watch frame into a conversation view. Mirrors
 * `reduceConversationFrames`: dedupe by id (newer copy wins), order by
 * `(timestamp, id)`, cap to the newest `maxEntries` and keep `hasEarlier` when
 * anything was trimmed or the store reported older entries.
 *
 * @param {object | undefined} state
 * @param {object} frame
 * @param {{ maxEntries?: number }} [options]
 */
export function reduceConversationFrames(state, frame, options) {
  const maxEntries = options?.maxEntries ?? DEFAULT_VIEW_WINDOW;
  const merged = new Map();
  if (state !== undefined && state.conversationId === frame.conversationId) {
    for (const entry of state.entries) merged.set(entry.id, entry);
  }
  for (const entry of frame.entriesWindow) merged.set(entry.id, entry);
  const { ordered, trimmed } = orderAndTrim(merged, maxEntries);
  return {
    conversationId: frame.conversationId,
    entries: trimmed,
    cursor: trimmed.length === 0 ? null : trimmed[0].cursor,
    hasEarlier: frame.hasEarlier || trimmed.length < ordered.length,
    live: frame.live,
  };
}

/**
 * Prepend one earlier transcript page. Mirrors `mergeEarlierTranscriptPage`.
 *
 * @param {object} state
 * @param {{ entries: object[], cursor: string | null, hasEarlier: boolean }} page
 * @param {{ maxEntries?: number }} [options]
 */
export function mergeEarlierTranscriptPage(state, page, options) {
  const maxEntries = options?.maxEntries ?? DEFAULT_VIEW_WINDOW;
  const merged = new Map();
  for (const entry of page.entries) merged.set(entry.id, entry);
  for (const entry of state.entries) merged.set(entry.id, entry);
  const { ordered, trimmed } = orderAndTrim(merged, maxEntries);
  return {
    conversationId: state.conversationId,
    entries: trimmed,
    cursor: trimmed.length === 0 ? null : trimmed[0].cursor,
    hasEarlier: page.hasEarlier || trimmed.length < ordered.length,
    live: state.live,
  };
}

/**
 * Default heartbeat bound for a live generation; mirrors
 * `DEFAULT_LIVE_STALE_AFTER_MS` in `src/durable-member/viewer.ts`.
 */
export const DEFAULT_LIVE_STALE_AFTER_MS = 30_000;

/**
 * Decide whether a live row is actually live. Mirrors `reduceLiveLiveness`.
 *
 * `status` is the owner's claim and survives its crash, so liveness comes from
 * the heartbeat (`updatedAt`) and an explicit owner signal instead. Pure over
 * values, so the panel side never needs a timer to test it.
 *
 * @param {{ live: object | null, now: number, ownerAlive?: boolean, staleAfterMs?: number }} input
 * @returns {{ kind: "none" } | { kind: "live", live: object } | { kind: "stale", live: object, reason: "owner-gone" | "no-heartbeat" }}
 */
export function reduceLiveLiveness(input) {
  const live = input.live;
  if (live === null || live === undefined) return { kind: "none" };
  if (input.ownerAlive === false) return { kind: "stale", live, reason: "owner-gone" };
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_LIVE_STALE_AFTER_MS;
  // An unset heartbeat is old by any bound: unknown must never look running.
  if (input.now - (live.updatedAt ?? 0) >= staleAfterMs) {
    return { kind: "stale", live, reason: "no-heartbeat" };
  }
  return { kind: "live", live };
}

/**
 * Project a liveness verdict onto a frame's `live` field. Mirrors
 * `annotateLiveGeneration`: a stale generation is reported with `stale: true`
 * rather than dropped, so the panel can say "owner gone" instead of nothing.
 *
 * @param {object} outcome
 */
export function annotateLiveGeneration(outcome) {
  if (outcome.kind === "none") return null;
  if (outcome.kind === "live") return outcome.live;
  return { ...outcome.live, stale: true, staleReason: outcome.reason };
}

/**
 * Which controls the panel offers for one command kind.
 *
 * UX only: the owner re-checks with `authorizeDurableCommand`. `available` is
 * false for anything the owner would refuse outright, and `requiresConfirmation`
 * marks the kinds that need the typed member-id token first.
 *
 * @param {{ kind: string, memberId: string, confirmation?: string }} request
 * @returns {{ available: boolean, requiresConfirmation: false | "missing" | "mismatch" }}
 */
export function controlAvailability(request) {
  if (CONFIRMATION_REQUIRED_KINDS.includes(request.kind)) {
    if (request.confirmation === undefined || request.confirmation === "") {
      return { available: false, requiresConfirmation: "missing" };
    }
    if (request.confirmation !== request.memberId) {
      return { available: false, requiresConfirmation: "mismatch" };
    }
    return { available: true, requiresConfirmation: false };
  }
  return { available: PANEL_ALLOWED_KINDS.includes(request.kind), requiresConfirmation: false };
}

/**
 * Human-readable one-line summary of a task node, used by the panel and its
 * tests. Owner edge and "waiting on" are rendered inline because a durable task
 * graph is unreadable without them.
 *
 * @param {object} node
 */
export function formatTaskLine(node) {
  const owner = node.owner === undefined ? "unowned" : `${node.owner.edge}:${node.owner.memberId}`;
  const waiting = node.waitingOn.length === 0 ? "not waiting" : `waiting on ${node.waitingOn.join(", ")}`;
  const background = node.background ? "background" : "foreground";
  return `${node.id} [${node.status}] ${owner} · ${waiting} · ${background} — ${node.title}`;
}
