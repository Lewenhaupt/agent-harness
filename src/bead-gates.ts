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
 *    author is the answer.
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

/** Open human gate as the answer channel needs it. */
export interface OpenHumanGate {
  gateId: string;
  /** bd's ISO creation timestamp; the answer baseline when present. */
  createdAt?: string;
}

/** `bd gate create --blocks <bead> --type=human --reason <reason>`. */
export function buildGateCreateArgv(options: {
  beadId: string;
  reason: string;
}): readonly string[] {
  return [
    "gate",
    "create",
    "--blocks",
    options.beadId,
    `--type=${HUMAN_GATE_TYPE}`,
    "--reason",
    options.reason,
  ];
}

/** `bd gate list <bead> --json` — the gates that block that bead. */
export function buildGateListArgv(beadId: string): readonly string[] {
  return ["gate", "list", beadId, "--json"];
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
 * `await_type` other than `human` are not a human wait: a timer or `gh:run`
 * gate must never be "answered" by a comment. The blocked bead's own id is
 * rejected as a gate id, because treating it as one would make the harness
 * resolve the work item instead of the gate.
 */
export function parseOpenHumanGate(raw: unknown, beadId: string): OpenHumanGate | undefined {
  for (const record of gateRecords(raw)) {
    const gate = openHumanGateFromRecord(record, beadId);
    if (gate !== undefined) return gate;
  }
  return undefined;
}

/** Array-or-single-object tolerance for untrusted bd JSON. */
function gateRecords(raw: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? [raw]
      : ([] as unknown[]);
  return values.filter(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
  );
}

/** One gate record, or undefined when it is not an open human gate. */
function openHumanGateFromRecord(
  record: Record<string, unknown>,
  beadId: string,
): OpenHumanGate | undefined {
  const gateId = record.id;
  if (typeof gateId !== "string" || gateId === "" || gateId === beadId) return undefined;
  if (record.status !== "open") return undefined;
  if (record.await_type !== HUMAN_GATE_TYPE) return undefined;
  return typeof record.created_at === "string"
    ? { gateId, createdAt: record.created_at }
    : { gateId };
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

/** Outcome of one open-gate read. */
export type OpenHumanGateLookup =
  | { ok: true; status: "open"; gate: OpenHumanGate }
  | { ok: true; status: "none" }
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
    // `null`/`[]` is bd's "no open gates". Records that did not parse are a
    // contract change, not a resolution.
    return gateRecords(parsed).length === 0
      ? { ok: true, status: "none" }
      : { ok: true, status: "unrecognized" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
