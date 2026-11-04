/**
 * bd gates — the bd-native "waiting on a human" marker (bd-152).
 *
 * The first design for the human answer channel wrote a marker file
 * (`.belayd/human-question.json`) and remembered a `baselineCommentId`. A bd
 * `human` gate replaces both: the gate's open/closed state IS the baseline, the
 * wait is visible in bd/Scotty for free, and `bd ready` / `bd blocked` are
 * already correct because the gate blocks the work bead.
 *
 * Lifecycle, all of it harness-side:
 *
 * 1. `belayd_ask_human` creates the gate (`buildGateCreateArgv`) and posts the
 *    question as an authored comment.
 * 2. The poll reads it (`lookupOpenHumanGate`); a comment by a non-`belayd:*`
 *    author is the answer. When the gate is already gone, that read settles the
 *    wait — and `lookupResolvedHumanGate` recovers whatever note the resolver
 *    left in the gate's `close_reason` (Scotty's Approve writes it there, not in
 *    the bead thread).
 * 3. The answer resolves the gate (`buildGateResolveArgv`), which reopens the
 *    work bead for the next phase.
 *
 * Writes never go through the allowlisted `bd` proxy: argv validation inspects
 * only `argv[0]`, so exposing `gate` there would expose the whole lifecycle.
 * They use `runBdCommand` directly, like `_flagForHumanReview`.
 */

import { isBdReadArgv } from "./bd-command.js";
import { BEAD_READ_MAX_BUFFER_BYTES, BEAD_READ_TIMEOUT_MS } from "./bead-comments.js";
import type { FleetBeadRunner } from "./fleet-beads.js";

/** The only gate type the human answer channel understands. */
const HUMAN_GATE_TYPE = "human";

/**
 * bd's native await type for ordering: the gate waits on another bead. The
 * ordering semantics live in the fleet, not in bd's auto-resolution (see
 * `fleet-ordering-gates.ts`); the type only keeps the wait off needs-you
 * surfaces that key on `human`.
 */
const BEAD_GATE_TYPE = "bead";

/**
 * Stable marker carried by the gates the fleet creates to order its own members
 * (bd-158), in both `--title` and `--reason`.
 *
 * New ordering gates are typed `bead` with the awaited bead set to the blocker
 * (bd-176): bd 1.3.0 supports `human`, `timer`, `gh:run`, `gh:pr`, and `bead`,
 * and `bead` makes the wait a native non-human wait instead of a `human` one a
 * needs-you surface lists. The marker still matters: it carries the
 * fleet id and both bead ids for dedup/adoption/reaping, and legacy gates the
 * fleet created before bd-176 are typed `human`, so the type alone cannot tell
 * them from a real human wait. `parseOpenHumanGate` refuses a marked record, so
 * the human-answer poll can never "answer" an ordering gate with a comment, and
 * the fleet view renders it as "waiting on member X" instead of "awaiting
 * human".
 *
 * The marker is *structured*, not a bare prefix: `<prefix> fleet:<fleetId>
 * <blocker> -> <blocked>`. Classification requires that whole shape, because a
 * bare prefix would be fail-open — a human gate (or `belayd_ask_human`'s own
 * question) whose title happened to start with the prefix would be read as
 * ordering, and the human wait would look resolved. Anything that only looks
 * like the marker stays a human gate, so the wait stays armed.
 */
export const FLEET_ORDERING_GATE_PREFIX = "belayd-fleet-ordering:";

/** The ordering facts a gate carries, in the only place bd keeps them: its text. */
export interface FleetOrderingGateMarker {
  fleetId: string;
  blocker: string;
  blocked: string;
}

/** Open fleet ordering gate as `bd gate list <bead> --json` reports it. */
export interface OpenFleetOrderingGate {
  gateId: string;
  fleetId: string;
  blocker: string;
  blocked: string;
}

/** A bd id (or fleet id) token; anchored so a parse can never yield prose. */
const ORDERING_TOKEN = "[A-Za-z0-9][A-Za-z0-9._-]*";

/** Built from the prefix constant so the marker and its parser cannot drift apart. */
const ORDERING_MARKER_LINE = new RegExp(
  `^${escapeRegExp(FLEET_ORDERING_GATE_PREFIX)}\\s+fleet:(${ORDERING_TOKEN})\\s+` +
    `(${ORDERING_TOKEN})\\s+->\\s+(${ORDERING_TOKEN})(?::|\\s*$)`,
  "u",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Render the canonical marker both the gate title and its reason start with. */
export function renderFleetOrderingGateMarker(input: FleetOrderingGateMarker): string {
  return `${FLEET_ORDERING_GATE_PREFIX} fleet:${input.fleetId} ${input.blocker} -> ${input.blocked}`;
}

/**
 * Parse one marker line, or undefined when it is not the exact structured shape.
 *
 * Prose after the blocked id is allowed (the reason says *why* after the marker),
 * but nothing before it: the fleet id and both bead ids must be real tokens.
 */
export function parseFleetOrderingGateMarkerLine(
  line: string,
): FleetOrderingGateMarker | undefined {
  const match = ORDERING_MARKER_LINE.exec(line.trim());
  if (match === null) return undefined;
  const fleetId = match[1];
  const blocker = match[2];
  const blocked = match[3];
  if (fleetId === undefined || blocker === undefined || blocked === undefined) return undefined;
  if (blocker === blocked) return undefined;
  return { fleetId, blocker, blocked };
}

/**
 * The marker a gate record carries, or undefined when it is not an ordering gate.
 *
 * Classification is a three-state join, and each state is chosen for a different
 * failure it must prevent:
 *
 * - **title parses, description carries no marker** (absent, empty, truncated, or
 *   re-folded by bd) → the title decides. bd owns the reason column and may cut or
 *   reformat it, so a real ordering gate whose reason lost its marker must still
 *   be an ordering gate: classifying it as a human gate would make
 *   `belayd_ask_human`'s poll wait for a comment answer no human will ever give.
 * - **title parses, description parses differently** → not an ordering gate. That
 *   fail-closed branch is the anti-forgery rule: two disagreeing sources cannot be
 *   read as a wait on a member.
 * - **description agrees** → an ordering gate.
 *
 * A description that *looks* marked but does not parse is reported by
 * {@link fleetOrderingGateDriftWarning} so the drift is visible rather than silent.
 */
export function fleetOrderingGateMarkerOf(
  record: Record<string, unknown>,
): FleetOrderingGateMarker | undefined {
  const title = record.title;
  if (typeof title !== "string") return undefined;
  const fromTitle = parseFleetOrderingGateMarkerLine(title);
  if (fromTitle === undefined) return undefined;
  const fromDescription = markerFromDescription(record.description);
  if (fromDescription === undefined) return fromTitle;
  return sameMarker(fromTitle, fromDescription) ? fromTitle : undefined;
}

/**
 * A drift finding, keyed by gate id so a caller can report it exactly once.
 *
 * The id is part of the payload rather than text inside the message because the
 * fleet loop reports gate warnings per gate: a warning string alone cannot be
 * deduplicated across ticks without re-warning every sweep.
 */
export interface FleetOrderingGateDrift {
  gateId: string;
  message: string;
}

/**
 * The reason-drift finding for a marked gate, or undefined when there is none.
 *
 * bd may truncate or re-fold `--reason`; the gate is still an ordering gate (the
 * title decides), but the loss is worth surfacing once, because a reader that
 * depended on the description — a human looking for the edge in `bd gate list`,
 * or a future stricter parser — would otherwise fail silently.
 */
export function fleetOrderingGateDrift(
  record: Record<string, unknown>,
): FleetOrderingGateDrift | undefined {
  if (fleetOrderingGateMarkerOf(record) === undefined) return undefined;
  const description = record.description;
  if (typeof description !== "string") return undefined;
  if (!description.includes(FLEET_ORDERING_GATE_PREFIX)) return undefined;
  if (markerFromDescription(description) !== undefined) return undefined;
  const gateId = record.id;
  return {
    gateId: typeof gateId === "string" && gateId !== "" ? gateId : "(no id)",
    message:
      `gate ${typeof gateId === "string" ? gateId : "(no id)"} carries the fleet ordering marker in ` +
      "its title but not in its reason (bd truncated or re-folded the reason); classified from the title",
  };
}

/** The drift message alone, for callers that only render text. */
export function fleetOrderingGateDriftWarning(record: Record<string, unknown>): string | undefined {
  return fleetOrderingGateDrift(record)?.message;
}

/** bd folds `--reason` into the description as "…\n\nReason: <reason>". */
function markerFromDescription(description: unknown): FleetOrderingGateMarker | undefined {
  if (typeof description !== "string") return undefined;
  for (const line of description.split("\n")) {
    const marker = parseFleetOrderingGateMarkerLine(line.replace(/^Reason:\s*/u, ""));
    if (marker !== undefined) return marker;
  }
  return undefined;
}

function sameMarker(left: FleetOrderingGateMarker, right: FleetOrderingGateMarker): boolean {
  return (
    left.fleetId === right.fleetId &&
    left.blocker === right.blocker &&
    left.blocked === right.blocked
  );
}

/** Open human gate as the answer channel needs it. */
export interface OpenHumanGate {
  gateId: string;
  /** bd's ISO creation timestamp; the answer baseline when present. */
  createdAt?: string;
  /**
   * The gate's own title, when bd stored one (bd-252).
   *
   * why: a restart finds the wait by listing gates, and only the title says
   * whether a rediscovered gate is the review publication question (which must
   * not block phase tools) or a plain ask (which must). The fleet-ordering
   * classifier reads `record.title` the same way.
   */
  title?: string;
}

/**
 * The await type of a bd gate create, as a discriminated union so a `bead` gate
 * cannot be built without the bead it awaits (bd-176).
 *
 * `human` emits `--type=human` with no `--await-id`; `bead` emits
 * `--type=bead --await-id <awaitId>`, which is how fleet ordering is expressed
 * natively. A `bead` gate without an await id is unrepresentable, not a runtime
 * check that can be forgotten.
 */
export type GateCreateOptions =
  | {
      awaitType: "human";
      beadId: string;
      reason: string;
      /** Custom gate title; bd's default (`Gate: human`) says nothing about the wait. */
      title?: string;
    }
  | {
      awaitType: "bead";
      /** The bead whose closure resolves the gate. */
      awaitId: string;
      beadId: string;
      reason: string;
      title?: string;
    };

/** `bd gate create --blocks <bead> --type=<type> [--await-id <bead>] …`. */
export function buildGateCreateArgv(options: GateCreateOptions): readonly string[] {
  const typeArgs =
    options.awaitType === "bead"
      ? [`--type=${BEAD_GATE_TYPE}`, "--await-id", options.awaitId]
      : [`--type=${HUMAN_GATE_TYPE}`];
  return [
    "gate",
    "create",
    "--blocks",
    options.beadId,
    ...typeArgs,
    ...(options.title === undefined ? [] : ["--title", options.title]),
    "--reason",
    options.reason,
  ];
}

/** `bd gate list <bead> --json` — the gates that block that bead. */
export function buildGateListArgv(beadId: string): readonly string[] {
  return ["gate", "list", beadId, "--json"];
}

/**
 * `bd gate list <bead> --all --json` — open *and* closed gates of that bead.
 *
 * Only used after the open read already said "no gate": a gate resolved by
 * someone else keeps its `close_reason`, which is where Scotty's approval note
 * (and any `bd gate resolve --reason`) puts the person's answer.
 */
export function buildGateListAllArgv(beadId: string): readonly string[] {
  return ["gate", "list", beadId, "--all", "--json"];
}

/** `bd gate resolve <gate-id>`; equivalent to `bd close <gate-id>`. */
export function buildGateResolveArgv(gateId: string): readonly string[] {
  return ["gate", "resolve", gateId];
}

/**
 * The open human gate blocking `beadId`, from `bd gate list <bead> --json`.
 *
 * bd answers `null` for no gates and an array of gate records otherwise, newest
 * first. Records without a usable `id`, a `status` other than `open`, or an
 * `await_type` other than `human` are not a human wait: a `timer`, `gh:run`, or
 * `bead` gate must never be "answered" by a comment. The blocked bead's own id is
 * rejected as a gate id, because treating it as one would make the harness
 * resolve the work item instead of the gate.
 */
export function parseOpenHumanGate(raw: unknown, beadId: string): OpenHumanGate | undefined {
  for (const record of gateRecordList(raw)) {
    const gate = openHumanGateFromRecord(record, beadId);
    if (gate !== undefined) return gate;
  }
  return undefined;
}

/** A human gate whose resolution left the person's own text behind. */
export interface ResolvedHumanGate {
  gateId: string;
  /** bd's verbatim `close_reason`, when it stores one. */
  closeReason?: string;
  /** The human text in `closeReason`, minus the tool's own decision line. */
  note?: string;
}

/**
 * The decision line a closing tool writes in front of the human's text.
 *
 * Scotty's Approve writes `Approved by <actor> via Scotty at <iso>` and appends
 * the approval note after a blank line, so that first line is bookkeeping, not
 * an answer. Matched narrowly (a whole line, a real ISO timestamp) because
 * anything unrecognized is kept as part of the note: delivering a stray line is
 * better than swallowing the person's answer.
 */
const RESOLVE_DECISION_LINE =
  /^(?:Approved|Resolved) by .+? (?:via Scotty )?at \d{4}-\d{2}-\d{2}T[\d:.]+Z$/u;

/**
 * The human text in a gate's `close_reason`, or undefined when it carries none.
 *
 * The note is returned verbatim (wrapped lines included); flattening and capping
 * happen at delivery, in `excerptComment`.
 */
export function humanGateResolveNote(closeReason: unknown): string | undefined {
  if (typeof closeReason !== "string") return undefined;
  const lines = closeReason.split("\n");
  if (lines.length > 0 && RESOLVE_DECISION_LINE.test(lines[0]?.trim() ?? "")) {
    lines.shift();
  }
  const note = lines.join("\n").trim();
  return note === "" ? undefined : note;
}

/**
 * The closed human gate that resolved `beadId`, from `bd gate list <bead> --all --json`.
 *
 * Fail closed: only a `closed` record of type `human` that is not a fleet
 * ordering gate and not the work bead itself counts. When the wait knows its
 * gate id, a different id is ignored — adopting the wrong gate would attribute
 * someone else's resolution (and its note) to this wait.
 */
export function parseResolvedHumanGate(
  raw: unknown,
  beadId: string,
  gateId?: string,
): ResolvedHumanGate | undefined {
  for (const record of gateRecordList(raw)) {
    const gate = resolvedHumanGateFromRecord(record, beadId, gateId);
    if (gate !== undefined) return gate;
  }
  return undefined;
}

function resolvedHumanGateFromRecord(
  record: Record<string, unknown>,
  beadId: string,
  gateId: string | undefined,
): ResolvedHumanGate | undefined {
  if (isFleetOrderingGateRecord(record)) return undefined;
  const id = record.id;
  if (typeof id !== "string" || id === "" || id === beadId) return undefined;
  if (gateId !== undefined && id !== gateId) return undefined;
  if (record.status !== "closed") return undefined;
  if (record.await_type !== HUMAN_GATE_TYPE) return undefined;
  const closeReason =
    typeof record.close_reason === "string" && record.close_reason !== ""
      ? record.close_reason
      : undefined;
  const note = humanGateResolveNote(closeReason);
  return {
    gateId: id,
    ...(closeReason === undefined ? {} : { closeReason }),
    ...(note === undefined ? {} : { note }),
  };
}

/** Array-or-single-object tolerance for untrusted bd JSON. */
export function gateRecordList(raw: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? [raw]
      : ([] as unknown[]);
  return values.filter(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
  );
}

/** Does this gate record carry the fleet's structured ordering marker? */
export function isFleetOrderingGateRecord(record: Record<string, unknown>): boolean {
  return fleetOrderingGateMarkerOf(record) !== undefined;
}

/**
 * The open human gate in one gate record, or undefined when it is not a human
 * wait. Exported for the GitHub-primary readiness classifier (bd-180), so the
 * gate-kind parser cannot drift from the answer channel's.
 */
export function openHumanGateFromRecord(
  record: Record<string, unknown>,
  beadId: string,
): OpenHumanGate | undefined {
  // An ordering gate is a wait on another *member*, never on a person.
  if (isFleetOrderingGateRecord(record)) return undefined;
  const gateId = record.id;
  if (typeof gateId !== "string" || gateId === "" || gateId === beadId) return undefined;
  if (record.status !== "open") return undefined;
  if (record.await_type !== HUMAN_GATE_TYPE) return undefined;
  const title = typeof record.title === "string" && record.title !== "" ? record.title : undefined;
  return {
    gateId,
    ...(typeof record.created_at === "string" ? { createdAt: record.created_at } : {}),
    ...(title === undefined ? {} : { title }),
  };
}

/**
 * The gate id `bd gate create` just minted.
 *
 * `--json` answers with the created gate record, so the id is normally a field.
 * The text form (`✓ Created gate bd-159 (type: human)`) is the fallback, and its
 * ids are matched narrowly and filtered against the blocked bead: the output
 * also names the *bead* it blocks, and resolving that instead of the gate would
 * close the work item.
 */
export function parseCreatedGateId(
  stdout: string,
  beadId: string,
  rawJson?: unknown,
): string | undefined {
  const fromJson = gateIdFromJson(rawJson) ?? gateIdFromJson(parseJson(stdout));
  if (fromJson !== undefined && fromJson !== beadId) return fromJson;

  for (const match of stdout.matchAll(/\bbd-\d+\b/gu)) {
    const candidate = match[0];
    if (candidate !== beadId) return candidate;
  }
  return undefined;
}

function gateIdFromJson(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = Array.isArray(raw) ? raw[0] : raw;
  if (typeof record !== "object" || record === null) return undefined;
  const id = (record as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Every open fleet ordering gate in one `bd gate list <bead> --json` answer.
 *
 * This is bd's truth, as opposed to the intent's records: a relaunch that lost a
 * record still finds (and can adopt) the gate it created, and a gate whose id the
 * fleet never recorded is still discoverable. Resolved gates are not listed by bd,
 * so everything here is open by construction — and `status` is re-checked anyway,
 * because a payload is untrusted input.
 */
export function parseOpenFleetOrderingGates(raw: unknown): readonly OpenFleetOrderingGate[] {
  return readOpenFleetOrderingGates(raw).gates;
}

/**
 * The open ordering gates in a gate-list answer, plus any drift it revealed.
 *
 * Drift is returned per gate id (this module is pure and decides nothing about
 * visibility): the caller decides what an operator sees, and the loop needs the id
 * to say it once per gate rather than once per sweep.
 */
export function readOpenFleetOrderingGates(raw: unknown): {
  gates: readonly OpenFleetOrderingGate[];
  drifts: readonly FleetOrderingGateDrift[];
} {
  const gates: OpenFleetOrderingGate[] = [];
  const drifts: FleetOrderingGateDrift[] = [];
  for (const record of gateRecordList(raw)) {
    if (record.status !== "open") continue;
    const gateId = record.id;
    if (typeof gateId !== "string" || gateId === "" || gateId.startsWith("-")) continue;
    const marker = fleetOrderingGateMarkerOf(record);
    if (marker === undefined) continue;
    const drift = fleetOrderingGateDrift(record);
    if (drift !== undefined) drifts.push(drift);
    gates.push({
      gateId,
      fleetId: marker.fleetId,
      blocker: marker.blocker,
      blocked: marker.blocked,
    });
  }
  return { gates, drifts };
}

/**
 * The member a fleet ordering gate is waiting on, from `bd gate list <bead> --json`.
 *
 * The marker names both beads, so the answer is read from the structure rather
 * than a positional token, and a gate that does not say it blocks this very bead
 * is ignored. Undefined means "no readable blocker", which the fleet view renders
 * as a plain scheduling wait.
 */
export function parseOpenOrderingGateBlocker(raw: unknown, beadId: string): string | undefined {
  const gate = parseOpenFleetOrderingGates(raw).find((candidate) => candidate.blocked === beadId);
  return gate?.blocker;
}

/** Outcome of one open-gate read. */
export type OpenHumanGateLookup =
  | { ok: true; status: "open"; gate: OpenHumanGate }
  | {
      ok: true;
      status: "none";
      /** The member this bead is ordered behind, when a fleet ordering gate blocks it. */
      orderingBlocker?: string;
    }
  | { ok: true; status: "unrecognized" }
  | { ok: false; error: string };

export interface LookupOpenHumanGateOptions {
  beadId: string;
  cwd: string;
  runBd: FleetBeadRunner;
  /** Test seam for the read-only guard; production always uses the default. */
  buildArgv?: (beadId: string) => readonly string[];
}

/**
 * Read the human gate blocking `beadId`, if any.
 *
 * Run on every poll tick, so it is guarded and bounded exactly like the comment
 * read: an argv that would write is refused before any process is spawned, and
 * bd being absent/slow degrades to `{ ok: false }` instead of throwing.
 *
 * The three success states are deliberately distinct (fail closed):
 *
 * - `open` — a parsed open human gate; the wait is real and comments are read.
 * - `none` — the command succeeded and reported zero open gates; the gate was
 *   genuinely resolved (by a human in bd/Scotty), so the workflow may proceed.
 * - `unrecognized` — records exist but none is an open human gate (a renamed
 *   `status`/`await_type`, a timer gate, a malformed record). Never treated as
 *   resolved: a parse failure must not unblock a workflow that is still waiting.
 */
export async function lookupOpenHumanGate(
  options: LookupOpenHumanGateOptions,
): Promise<OpenHumanGateLookup> {
  const buildArgv = options.buildArgv ?? buildGateListArgv;
  const argv = buildArgv(options.beadId);
  if (options.beadId === "" || options.beadId.startsWith("-")) {
    return { ok: false, error: `refusing to read gates for bead id "${options.beadId}"` };
  }
  if (!isBdReadArgv(argv)) {
    return { ok: false, error: `refusing non-read bd argv "${argv.join(" ")}"` };
  }

  try {
    const { stdout } = await options.runBd(argv, {
      cwd: options.cwd,
      stdin: undefined,
      timeoutInMs: BEAD_READ_TIMEOUT_MS,
      maxBufferInBytes: BEAD_READ_MAX_BUFFER_BYTES,
    });
    const parsed = JSON.parse(stdout) as unknown;
    const gate = parseOpenHumanGate(parsed, options.beadId);
    if (gate !== undefined) return { ok: true, status: "open", gate };
    // `null`/`[]` is bd's "no open gates". A fleet ordering gate is not a human
    // gate at all, so it must not degrade the answer to `unrecognized`; any other
    // record that did not parse is a contract change, not a resolution.
    const humanRecords = gateRecordList(parsed).filter(
      (record) => !isFleetOrderingGateRecord(record),
    );
    if (humanRecords.length > 0) return { ok: true, status: "unrecognized" };
    const orderingBlocker = parseOpenOrderingGateBlocker(parsed, options.beadId);
    return orderingBlocker === undefined
      ? { ok: true, status: "none" }
      : { ok: true, status: "none", orderingBlocker };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Outcome of one closed-gate read. */
export type ResolvedHumanGateLookup =
  | { ok: true; status: "none" }
  | { ok: true; status: "closed"; gate: ResolvedHumanGate }
  | { ok: false; error: string };

export interface LookupResolvedHumanGateOptions {
  beadId: string;
  /** The wait's own gate id, when bd reported it at creation time. */
  gateId?: string;
  cwd: string;
  runBd: FleetBeadRunner;
  /** Test seam for the read-only guard; production always uses the default. */
  buildArgv?: (beadId: string) => readonly string[];
}

/**
 * Read the already-resolved gate of a wait, so its note is not lost.
 *
 * Called only after {@link lookupOpenHumanGate} reported `none`, i.e. once per
 * wait, and guarded exactly like the open read. A failure here is not a reason
 * to keep the workflow blocked: bd already said the gate is gone, so the caller
 * keeps the resolution and only the note is lost.
 */
export async function lookupResolvedHumanGate(
  options: LookupResolvedHumanGateOptions,
): Promise<ResolvedHumanGateLookup> {
  const buildArgv = options.buildArgv ?? buildGateListAllArgv;
  const argv = buildArgv(options.beadId);
  if (options.beadId === "" || options.beadId.startsWith("-")) {
    return { ok: false, error: `refusing to read gates for bead id "${options.beadId}"` };
  }
  if (!isBdReadArgv(argv)) {
    return { ok: false, error: `refusing non-read bd argv "${argv.join(" ")}"` };
  }

  try {
    const { stdout } = await options.runBd(argv, {
      cwd: options.cwd,
      stdin: undefined,
      timeoutInMs: BEAD_READ_TIMEOUT_MS,
      maxBufferInBytes: BEAD_READ_MAX_BUFFER_BYTES,
    });
    const gate = parseResolvedHumanGate(
      JSON.parse(stdout) as unknown,
      options.beadId,
      options.gateId,
    );
    return gate === undefined ? { ok: true, status: "none" } : { ok: true, status: "closed", gate };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
