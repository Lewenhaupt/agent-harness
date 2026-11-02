/**
 * Durable-member commands (bd-186).
 *
 * Nobody writes a member's storage: exactly one process owns it (pi-durable has
 * no cross-process locking), so every external actor — panel, supervisor, file
 * mailbox — sends a command and the owner translates it. These commands are the
 * whole vocabulary, and `requestId` is the single dedupe key: a retrying panel
 * or supervisor must not steer twice.
 *
 * The union covers exactly the pi-durable surface the control plane needs:
 * `submit({whenBusy:"steer"})`, `submit({whenBusy:"followup"})`,
 * `submit({type:"write"})`, `submission.abort()`, `abort()`, `configure()`,
 * `compact()` and `reset()`.
 *
 * Commands are fully untrusted boundary data, so this module validates with
 * **zod** (`commandSchema`) and maps the first issue onto the stable refusal
 * codes below. `command.authority` is only a claim; `authority.ts` binds the
 * verified tier at the transport and checks the claim against it.
 *
 * // SYNC WARNING: this contract and validator are duplicated in plain JS at
 * // `pi-web-plugins/durable-member/contract.js` (`validateCommand`), because the
 * // pi-web panel cannot import TypeScript. The TS side uses zod; the JS mirror
 * // is hand-rolled **on purpose** — the plugin is served from source with no
 * // build step and no runtime dependencies — and that asymmetry is the
 * // sanctioned exception, not drift. Every rule here — the allowed kinds and
 * // authorities, the request-id shape, the text limits, the write-entry shape
 * // and the first-issue refusal code — must be mirrored there and vice versa.
 * // The parity test `src/__tests__/durable-member-contract-parity.test.ts`
 * // drives both implementations over
 * // `pi-web-plugins/durable-member/fixtures/*.json`, including every rejection
 * // path, so a silent divergence fails the suite.
 */

import { z } from "zod";

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
] as const;

export type DurableCommandKind = (typeof DURABLE_COMMAND_KINDS)[number];

/** Who claims to be sending a command. The owner verifies it, never trusts it. */
export const DURABLE_AUTHORITIES = ["panel-human", "fleet-supervisor", "phase-subagent"] as const;

export type DurableAuthority = (typeof DURABLE_AUTHORITIES)[number];

/**
 * Tiers that can authenticate on the control socket.
 *
 * Each one owns a credential file; the credential, not the frame, decides the
 * tier. `phase-subagent` is deliberately absent: it gets no credential, so it
 * cannot authenticate at all (children own their own conversations and writes go
 * child → parent, never sideways).
 */
export const AUTHENTICATABLE_AUTHORITIES = ["panel-human", "fleet-supervisor"] as const;

export type AuthenticatableAuthority = (typeof AUTHENTICATABLE_AUTHORITIES)[number];

export function isAuthenticatableAuthority(value: unknown): value is AuthenticatableAuthority {
  return AUTHENTICATABLE_AUTHORITIES.some((authority) => authority === value);
}

/** Map an authenticatable tier to its credential/socket suffix. */
export const AUTHORITY_CREDENTIAL_SUFFIXES: Readonly<Record<AuthenticatableAuthority, string>> = {
  "panel-human": "panel",
  "fleet-supervisor": "supervisor",
};

/** Roles a `write` entry may carry: entries the model never sees. */
export const DURABLE_WRITE_ROLES = ["user", "assistant", "system"] as const;

export type DurableWriteRole = (typeof DURABLE_WRITE_ROLES)[number];

/** Upper bound on any command-authored text, measured in UTF-8 bytes. */
export const MAX_DURABLE_COMMAND_TEXT_BYTES = 64 * 1024;

/** Request ids name mailbox files, so the shape is also a path-safety rule. */
export const MAX_DURABLE_REQUEST_ID_LENGTH = 200;

/** Bound on member ids; they are directory names in the member state dir. */
export const MAX_DURABLE_MEMBER_ID_LENGTH = 200;

/** Bound on a submission id inside `abort-submission`. */
export const MAX_DURABLE_SUBMISSION_ID_LENGTH = 200;

/** Max tools a `configure` command may install. */
export const MAX_DURABLE_CONFIG_TOOLS = 200;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** A `write` command's entry: committed for the record, never sent to the model. */
export interface DurableWriteEntry {
  readonly role: DurableWriteRole;
  readonly text: string;
  /** Optional label so the transcript can distinguish harness notes from user text. */
  readonly kind?: "note" | "context";
}

/** Agent contract a `configure` command installs. */
export interface DurableAgentConfig {
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly systemPrompt?: string;
}

interface DurableCommandEnvelope {
  /** Dedupe key; the same id delivered twice applies once. */
  readonly requestId: string;
  readonly memberId: string;
  readonly authority: DurableAuthority;
  readonly issuedAt: number;
  /**
   * Explicit confirmation for the gated kinds (`configure`, `reset`). The
   * required value is the member id, see `authority.ts`: a deterministic token
   * that is hard to send by accident, not a security boundary by itself.
   */
  readonly confirmation?: string;
}

/** Steer: joins after the current tool round in the same run. */
export type DurableSteerCommand = DurableCommandEnvelope & {
  readonly kind: "steer";
  readonly text: string;
};

/** Follow-up: starts the next run. */
export type DurableFollowupCommand = DurableCommandEnvelope & {
  readonly kind: "followup";
  readonly text: string;
};

/** Write: an entry the model never sees. */
export type DurableWriteCommand = DurableCommandEnvelope & {
  readonly kind: "write";
  readonly entry: DurableWriteEntry;
};

/** Abort one submission. */
export type DurableAbortSubmissionCommand = DurableCommandEnvelope & {
  readonly kind: "abort-submission";
  readonly submissionId: string;
};

/** Abort the conversation; conversation and task teardown is the owner's `abort()` contract. */
export type DurableAbortCommand = DurableCommandEnvelope & {
  readonly kind: "abort";
  readonly reason?: string;
};

/** Configure: changes the agent's contract mid-run, therefore gated. */
export type DurableConfigureCommand = DurableCommandEnvelope & {
  readonly kind: "configure";
  readonly config: DurableAgentConfig;
};

/** Compact: collapse history into a summary. */
export type DurableCompactCommand = DurableCommandEnvelope & {
  readonly kind: "compact";
  readonly instructions?: string;
};

/** Reset: drop conversation state; gated because it changes the contract. */
export type DurableResetCommand = DurableCommandEnvelope & {
  readonly kind: "reset";
  readonly keepHistory?: boolean;
};

/** Any command the control plane can carry. */
export type DurableCommand =
  | DurableSteerCommand
  | DurableFollowupCommand
  | DurableWriteCommand
  | DurableAbortSubmissionCommand
  | DurableAbortCommand
  | DurableConfigureCommand
  | DurableCompactCommand
  | DurableResetCommand;

/** Stable validation failure codes, mirrored in the plain-JS contract. */
export type DurableCommandErrorCode =
  | "invalid-shape"
  | "unknown-kind"
  | "missing-request-id"
  | "missing-member-id"
  | "unknown-authority"
  | "invalid-issued-at"
  | "member-mismatch"
  | "missing-text"
  | "text-too-large"
  | "invalid-submission-id"
  | "invalid-confirmation"
  | "invalid-entry"
  | "invalid-config";

export type DurableCommandValidation =
  | { readonly ok: true; readonly value: DurableCommand }
  | { readonly ok: false; readonly code: DurableCommandErrorCode; readonly error: string };

export interface DurableCommandValidationOptions {
  /** When set, a command for another member is rejected (per-member scoping). */
  readonly memberId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function invalid(code: DurableCommandErrorCode, error: string): DurableCommandValidation {
  return { ok: false, code, error };
}

function isCommandKind(value: unknown): value is DurableCommandKind {
  return DURABLE_COMMAND_KINDS.some((kind) => kind === value);
}

function byteBound(maxBytes: number, description: string): z.ZodType<string> {
  return z
    .string()
    .refine(
      (value) => byteLength(value) <= maxBytes,
      `${description} exceeds ${maxBytes} UTF-8 bytes`,
    );
}

/** Required command text: non-blank and within the size budget. */
function requiredText(description: string): z.ZodType<string> {
  return byteBound(MAX_DURABLE_COMMAND_TEXT_BYTES, description).refine(
    (value) => value.trim() !== "",
    `${description} requires non-empty text`,
  );
}

/** Optional text (an abort reason, compaction instructions) may be empty. */
function optionalText(description: string): z.ZodType<string | undefined> {
  return byteBound(MAX_DURABLE_COMMAND_TEXT_BYTES, description).optional();
}

function identifier(maxLength: number): z.ZodType<string> {
  return z.string().max(maxLength).regex(IDENTIFIER_PATTERN);
}

const writeEntrySchema = z.object({
  role: z.enum(DURABLE_WRITE_ROLES),
  text: requiredText("write entry text"),
  kind: z.enum(["note", "context"]).optional(),
});

const agentConfigSchema = z
  .strictObject({
    model: requiredText("model").optional(),
    tools: z.array(requiredText("tool name")).min(1).max(MAX_DURABLE_CONFIG_TOOLS).optional(),
    systemPrompt: requiredText("system prompt").optional(),
  })
  .refine(
    (config) => Object.keys(config).length > 0,
    "configure requires a config of model, tools or systemPrompt",
  );

const envelopeShape = {
  requestId: identifier(MAX_DURABLE_REQUEST_ID_LENGTH),
  memberId: identifier(MAX_DURABLE_MEMBER_ID_LENGTH),
  authority: z.enum(DURABLE_AUTHORITIES),
  issuedAt: z.number().finite().positive(),
  confirmation: z.string().optional(),
} as const;

const steerSchema = z.object({
  ...envelopeShape,
  kind: z.literal("steer"),
  text: requiredText("steer"),
});

const followupSchema = z.object({
  ...envelopeShape,
  kind: z.literal("followup"),
  text: requiredText("followup"),
});

const writeSchema = z.object({
  ...envelopeShape,
  kind: z.literal("write"),
  entry: writeEntrySchema,
});

const abortSubmissionSchema = z.object({
  ...envelopeShape,
  kind: z.literal("abort-submission"),
  submissionId: identifier(MAX_DURABLE_SUBMISSION_ID_LENGTH),
});

const abortSchema = z.object({
  ...envelopeShape,
  kind: z.literal("abort"),
  reason: optionalText("abort reason"),
});

const configureSchema = z.object({
  ...envelopeShape,
  kind: z.literal("configure"),
  config: agentConfigSchema,
});

const compactSchema = z.object({
  ...envelopeShape,
  kind: z.literal("compact"),
  instructions: optionalText("compact instructions"),
});

const resetSchema = z.object({
  ...envelopeShape,
  kind: z.literal("reset"),
  keepHistory: z.boolean().optional(),
});

const commandSchema = z.discriminatedUnion("kind", [
  steerSchema,
  followupSchema,
  writeSchema,
  abortSubmissionSchema,
  abortSchema,
  configureSchema,
  compactSchema,
  resetSchema,
]);

interface ZodIssueLike {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

/** Required text: missing/blank and oversized are different refusals. */
function textFailureCode(value: unknown): DurableCommandErrorCode {
  if (typeof value === "string" && byteLength(value) > MAX_DURABLE_COMMAND_TEXT_BYTES) {
    return "text-too-large";
  }
  return "missing-text";
}

/** A write entry failure keeps the old missing-text / too-large distinction. */
function entryFailureCode(value: unknown): DurableCommandErrorCode {
  if (!isRecord(value)) return "invalid-entry";
  const text = value.text;
  if (typeof text !== "string" || text.trim() === "") return "missing-text";
  if (byteLength(text) > MAX_DURABLE_COMMAND_TEXT_BYTES) return "text-too-large";
  return "invalid-entry";
}

/**
 * Map the first zod issue onto the stable refusal code the mirror also emits.
 *
 * Codes are part of the cross-component contract (the panel renders them), so
 * this mapping is explicit rather than exposing zod's internal issue codes.
 */
function failureCodeFor(
  raw: Record<string, unknown>,
  issue: ZodIssueLike,
): { readonly code: DurableCommandErrorCode; readonly error: string } {
  const field = issue.path[0];
  switch (field) {
    case "requestId":
      return { code: "missing-request-id", error: "requestId must be a bounded identifier" };
    case "memberId":
      return { code: "missing-member-id", error: "memberId must be a bounded identifier" };
    case "authority":
      return { code: "unknown-authority", error: "authority must be a known role" };
    case "issuedAt":
      return {
        code: "invalid-issued-at",
        error: "issuedAt must be a positive epoch millisecond",
      };
    case "confirmation":
      return {
        code: "invalid-confirmation",
        error: "confirmation must be a string when present",
      };
    case "text":
      return { code: textFailureCode(raw.text), error: issue.message };
    case "entry":
      return { code: entryFailureCode(raw.entry), error: issue.message };
    case "config":
      return { code: "invalid-config", error: issue.message };
    case "instructions":
    case "reason":
      return { code: "text-too-large", error: issue.message };
    case "submissionId":
      return {
        code: "invalid-submission-id",
        error: "abort-submission requires a bounded submissionId",
      };
    case "keepHistory":
      return { code: "invalid-shape", error: "reset keepHistory must be a boolean when present" };
    default:
      return { code: "invalid-shape", error: issue.message };
  }
}

/**
 * Validate an untrusted command (socket frame, mailbox file, panel request).
 *
 * Pure: the same input always yields the same result, and no field is trusted
 * because it was validated elsewhere. Lengths are UTF-8 bytes, so a 64 KiB
 * budget is the same number of bytes on every transport.
 */
export function validateDurableCommand(
  raw: unknown,
  options?: DurableCommandValidationOptions,
): DurableCommandValidation {
  if (!isRecord(raw)) return invalid("invalid-shape", "a command must be a JSON object");
  if (!isCommandKind(raw.kind)) {
    return invalid("unknown-kind", `kind must be one of ${DURABLE_COMMAND_KINDS.join(", ")}`);
  }

  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) return invalid("invalid-shape", "command does not match its schema");
    const failure = failureCodeFor(raw, issue);
    return invalid(failure.code, failure.error);
  }

  if (options?.memberId !== undefined && parsed.data.memberId !== options.memberId) {
    return invalid(
      "member-mismatch",
      `command targets member ${parsed.data.memberId}, this control surface owns ${options.memberId}`,
    );
  }

  return { ok: true, value: parsed.data };
}
