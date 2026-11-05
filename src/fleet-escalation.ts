/**
 * Fleet escalation as bd gates — one primitive for every human-relevant stop
 * (bd-279).
 *
 * Before this module a stopped member left a fact only `fleet.json` could answer:
 * `formatFleetRunStops` printed the reason and detail, but nothing on the bead
 * awaited a person, nothing was answerable, and once the run died nothing acted on
 * the line again. bd-277 paid for that three times in one wave — three members
 * stopped `land-failed`, each merged and released by hand, with the cause readable
 * only from the run record.
 *
 * The primitive is deliberately not a new channel: **the gate is the escalation**.
 * Its title carries a structured marker (`bead-gates.ts`), its reason says what
 * happened, which member/bead is affected, the stop detail, and what an answer may
 * be — retry, abandon, or release — and the person answers by resolving the gate
 * with a note. That note is written back onto the stop record, so the resolution
 * *is* the decision input a supervisor (or a later session) acts on.
 *
 * Which conditions escalate, and why the boundary sits there:
 *
 * - **All seven `FLEET_RUN_STOP_REASONS`.** Their own doc comment states every entry
 *   is a case where a human decision is needed and none is retried automatically.
 * - **A parked fleet.** A bd gate blocks a *bead*, and a park's human-relevant
 *   consequence is that its members cannot proceed (the root checkout holds work the
 *   merge could not restore). The park timestamp is the round, so re-ticking the
 *   same park adopts the same gate while a genuine re-park opens a new one.
 * - **Sensitive findings: deliberately not here, and no longer anywhere.** bd-286
 *   deleted the per-finding sensitivity classifier and its review gate; secrets are
 *   `betterleaks`' job (`gateSecrets`, and `src/secret-scan.ts` refuses a flagged
 *   outbound post instead of asking a person). So this module presents stop and park
 *   causes only, and `FLEET_ESCALATION_CAUSES` has no sensitivity entry.
 *
 * What deliberately does **not** escalate: an ordering wait (the fleet resolves it
 * on landing), a capacity deferral (another fleet's slot frees itself), and a
 * quality-gate failure the loop retries (an `advance` re-plans the same wave). Those
 * are conditions a machine resolves; gating them would be a second channel for
 * something the loop already owns, and the bead's "must not" line forbids it.
 *
 * Idempotence is per `(bead, cause, round)` and has two sources, like ordering
 * gates: the stop record's own `gateId` (a stop that already escalated is skipped by
 * the planner) and bd's truth (an open gate with the same marker is adopted instead
 * of duplicated). A bd read failure refuses before anything is created, because
 * creating blind is the failure mode this design exists to avoid.
 */

import { isBdReadArgv } from "./bd-command.js";
import { BEAD_READ_MAX_BUFFER_BYTES, BEAD_READ_TIMEOUT_MS } from "./bead-comments.js";
import {
  buildGateCreateArgv,
  buildGateListAllArgv,
  buildGateListArgv,
  buildGateResolveArgv,
  type FleetEscalationGateDrift,
  humanGateResolveNote,
  type OpenFleetEscalationGate,
  parseCreatedGateId,
  readOpenFleetEscalationGates,
  renderFleetEscalationGateMarker,
} from "./bead-gates.js";
import type { FleetBeadRunner } from "./fleet-beads.js";
import {
  FLEET_RUN_DETAIL_MAX_LENGTH,
  FLEET_RUN_STOP_REASONS,
  type FleetGateNotice,
  type FleetRun,
  type FleetRunStop,
  type FleetRunStopReason,
  recordRunStopGate,
  recordRunStopResolution,
} from "./fleet-run.js";

/**
 * Every condition that opens an escalation gate.
 *
 * One vocabulary for everything this planner can emit: the seven stop reasons and a
 * parked fleet. Sensitive findings are not here (bd-286 removed the classifier that
 * escalated them, see the module header), and neither are ordering, capacity, or
 * quality-gate conditions, which a machine resolves.
 */
export const FLEET_ESCALATION_CAUSES = [...FLEET_RUN_STOP_REASONS, "fleet-parked"] as const;

export type FleetEscalationCause = (typeof FLEET_ESCALATION_CAUSES)[number];

/** Narrowing guard for a marker's free-token cause (bd's payload is untrusted). */
export function isFleetEscalationCause(cause: string): cause is FleetEscalationCause {
  return (FLEET_ESCALATION_CAUSES as readonly string[]).includes(cause);
}

/** A parked fleet as the planner needs it: why, and the round a re-tick repeats. */
export interface ParkedFleetEscalation {
  reason: string;
  recordedAt: number;
}

/** One escalation the fleet must have open in bd, before any write happens. */
export interface FleetEscalationPlan {
  taskId: string;
  cause: FleetEscalationCause;
  /** The record this escalation is about: `stop.at`, or `park.recordedAt`. */
  round: number;
  /** Gate title: the structured marker alone. */
  title: string;
  /** Gate reason: the marker, then the description a person answers. */
  reasonText: string;
}

/** An escalation gate recorded against the member it escalates. */
export interface FleetEscalationGate {
  taskId: string;
  cause: FleetEscalationCause;
  round: number;
  gateId: string;
}

/** Bound on the prose after the marker; the marker itself is never truncated. */
export const FLEET_ESCALATION_REASON_PROSE_MAX = 700;

/** Write timeout for gate create/resolve; bd is a Dolt client and may be slow. */
const GATE_WRITE_TIMEOUT_MS = 120_000;

/**
 * The escalation key a gate and its record must agree on.
 *
 * The round is truncated because the marker renders an integer: a stop recorded
 * with a fractional timestamp must not read as a different escalation than the gate
 * bd holds for it.
 */
function escalationKey(input: { taskId: string; cause: string; round: number }): string {
  return `${input.taskId}\u0000${input.cause}\u0000${Math.trunc(input.round)}`;
}

/** One line of free text: whitespace collapsed, then bounded. */
function oneLine(text: string, maxChars: number): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

/**
 * What the person reading the gate needs to know about the cause, in prose.
 *
 * The cause token is kept in every sentence: it is the same word the marker and the
 * stop record use, so a human, a supervisor, and a grep all agree on what happened.
 */
function causeProse(cause: FleetEscalationCause): string {
  switch (cause) {
    case "fleet-parked":
      return "cannot proceed because the fleet is parked (fleet-parked)";
    default:
      return `stopped the run with cause \`${cause}\`, which needs a human decision`;
  }
}

/** Gate title: the structured marker alone, so `bd gate list` names the escalation. */
export function fleetEscalationGateTitle(input: {
  fleetId: string;
  taskId: string;
  cause: FleetEscalationCause;
  round: number;
}): string {
  return renderFleetEscalationGateMarker(input);
}

/**
 * Why the gate exists, in the two places a human sees it.
 *
 * bd gates carry no payload, so the reason *is* the description: the marker (never
 * truncated — `slice` is applied to the prose that follows it), the member it
 * affects, the cause, what happened, and the three answers a person may choose,
 * including the exact command that records the choice. A bare "blocked" would leave
 * the person to re-derive all of that from `fleet.json`, which is the defect this
 * primitive removes.
 */
export function fleetEscalationGateReason(input: {
  fleetId: string;
  taskId: string;
  cause: FleetEscalationCause;
  round: number;
  detail: string;
}): string {
  const marker = renderFleetEscalationGateMarker(input);
  const detail = oneLine(input.detail, FLEET_RUN_DETAIL_MAX_LENGTH);
  const prose =
    `: ${input.taskId} ${causeProse(input.cause)} — ${detail}. ` +
    'Answer with `bd gate resolve <gate-id> --reason "<what you chose>"`: retry, abandon, ' +
    "or release; the fleet records that note as the decision it acts on";
  return `${marker}${prose.slice(0, FLEET_ESCALATION_REASON_PROSE_MAX)}`;
}

/** `bd gate create --blocks <member> --type=human …`: a person must answer this one. */
export function buildFleetEscalationGateArgv(plan: FleetEscalationPlan): readonly string[] {
  return buildGateCreateArgv({
    awaitType: "human",
    beadId: plan.taskId,
    reason: plan.reasonText,
    title: plan.title,
  });
}

/** The members a park strands: still members, neither stopped nor landed. */
function parkedEscalationTargets(input: {
  run: FleetRun | undefined;
  taskIds: readonly string[];
}): readonly string[] {
  const stopped = new Set((input.run?.stopped ?? []).map((entry) => entry.taskId));
  const landed = new Set(
    (input.run?.members ?? [])
      .filter((member) => member.landedAt !== undefined)
      .map((member) => member.taskId),
  );
  return input.taskIds.filter((taskId) => !stopped.has(taskId) && !landed.has(taskId));
}

export interface PlanFleetEscalationsInput {
  fleetId: string;
  /** The run whose stops are escalated; absent means there is no run record. */
  run?: FleetRun;
  /** Every member the fleet still holds; a park strands the ones still in flight. */
  taskIds: readonly string[];
  /** The park record, when the fleet is parked. */
  parked?: ParkedFleetEscalation;
}

/**
 * The escalations a fleet must have open right now, deduped by `(bead, cause, round)`.
 *
 * A stop is planned once per *record*: an entry that already carries a `gateId` was
 * escalated and is owned by the drift check from then on (re-planning it would open a
 * second gate for the same round after a restart), and an entry with a `resolution`
 * is answered and must never be re-asked. That is what makes a re-tick open zero
 * gates even before bd is asked.
 */
export function planFleetEscalations(
  input: PlanFleetEscalationsInput,
): readonly FleetEscalationPlan[] {
  const seen = new Set<string>();
  const planned: FleetEscalationPlan[] = [];
  const push = (
    taskId: string,
    cause: FleetEscalationCause,
    round: number,
    detail: string,
  ): void => {
    const key = escalationKey({ taskId, cause, round });
    if (seen.has(key)) return;
    seen.add(key);
    planned.push({
      taskId,
      cause,
      round,
      title: fleetEscalationGateTitle({ fleetId: input.fleetId, taskId, cause, round }),
      reasonText: fleetEscalationGateReason({
        fleetId: input.fleetId,
        taskId,
        cause,
        round,
        detail,
      }),
    });
  };

  for (const entry of input.run?.stopped ?? []) {
    if (entry.gateId !== undefined || entry.resolution !== undefined) continue;
    if (!isFleetEscalationCause(entry.reason)) continue;
    push(entry.taskId, entry.reason, entry.at, entry.detail);
  }
  const parked = input.parked;
  if (parked !== undefined) {
    for (const taskId of parkedEscalationTargets({ run: input.run, taskIds: input.taskIds })) {
      push(taskId, "fleet-parked", parked.recordedAt, parked.reason);
    }
  }
  return planned;
}

/**
 * The escalations bd must still hold for this record, answered ones excluded.
 *
 * The drift check compares the *open* gates against this set, so an answered stop is
 * neither re-escalated nor reported as drift.
 */
function currentEscalationKeys(input: PlanFleetEscalationsInput): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of input.run?.stopped ?? []) {
    if (entry.resolution !== undefined) continue;
    if (!isFleetEscalationCause(entry.reason)) continue;
    keys.add(escalationKey({ taskId: entry.taskId, cause: entry.reason, round: entry.at }));
  }
  if (input.parked !== undefined) {
    for (const taskId of parkedEscalationTargets({ run: input.run, taskIds: input.taskIds })) {
      keys.add(escalationKey({ taskId, cause: "fleet-parked", round: input.parked.recordedAt }));
    }
  }
  return keys;
}

/** Read one bead's open gates as the escalation family sees them. */
export type FleetEscalationGateListResult =
  | {
      ok: true;
      gates: readonly OpenFleetEscalationGate[];
      drifts: readonly FleetEscalationGateDrift[];
    }
  | { ok: false; error: string };

/**
 * `bd gate list <bead> --json`, parsed into the open escalation gates bd reports.
 *
 * Read-only by construction: the argv is checked against the read-only subcommand
 * list before any process is spawned, exactly like the other bd readers.
 */
export async function listFleetEscalationGatesForBead(options: {
  beadId: string;
  cwd: string;
  runBd: FleetBeadRunner;
  /** Test seam for the read-only guard, mirroring the other bd gate readers. */
  buildArgv?: (beadId: string) => readonly string[];
}): Promise<FleetEscalationGateListResult> {
  if (!isUsableBeadId(options.beadId)) {
    return { ok: false, error: `refusing to read gates for bead id "${options.beadId}"` };
  }
  const argv = (options.buildArgv ?? buildGateListArgv)(options.beadId);
  if (!isBdReadArgv(argv)) {
    return { ok: false, error: `refusing non-read bd argv "${argv.join(" ")}"` };
  }
  try {
    const { stdout } = await options.runBd(argv, readOptions(options.cwd));
    const { gates, drifts } = readOpenFleetEscalationGates(JSON.parse(stdout) as unknown);
    return { ok: true, gates, drifts };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export type EnsureFleetEscalationGatesResult =
  | {
      ok: true;
      /** Every gate the caller must record: adopted gates plus the ones created now. */
      gates: readonly FleetEscalationGate[];
      created: readonly FleetEscalationGate[];
      adopted: readonly FleetEscalationGate[];
      warnings: readonly string[];
    }
  | {
      ok: false;
      error: string;
      /** Partial success: the gates opened before the failure still count. */
      gates: readonly FleetEscalationGate[];
      created: readonly FleetEscalationGate[];
      adopted: readonly FleetEscalationGate[];
      warnings: readonly string[];
    };

export interface EnsureFleetEscalationGatesOptions {
  cwd: string;
  runBd: FleetBeadRunner;
  fleetId: string;
  plan: readonly FleetEscalationPlan[];
  /**
   * Open escalation gates the caller already read this pass.
   *
   * Supplying them skips the per-bead read; leaving them out makes this function
   * read bd itself, which is the normal path (a read failure must refuse before
   * anything is created).
   */
  existingGates?: readonly OpenFleetEscalationGate[];
}

/**
 * Open every planned escalation gate, adopting the ones bd already has.
 *
 * Order is read-then-write: no gate is created until every planned bead's gate list
 * has been read, so a bd failure leaves bd exactly as it was (nothing to roll back)
 * and the next tick retries from the same plan.
 */
export async function ensureFleetEscalationGates(
  options: EnsureFleetEscalationGatesOptions,
): Promise<EnsureFleetEscalationGatesResult> {
  if (options.plan.length === 0) {
    return { ok: true, gates: [], created: [], adopted: [], warnings: [] };
  }
  const read = await readOpenGates(options);
  if (!read.ok) {
    return {
      ok: false,
      error: read.error,
      gates: [],
      created: [],
      adopted: [],
      warnings: read.warnings,
    };
  }
  const created: FleetEscalationGate[] = [];
  const adopted: FleetEscalationGate[] = [];
  for (const plan of options.plan) {
    const open = read.byBead.get(plan.taskId) ?? [];
    const match = open.find(
      (gate) =>
        gate.fleetId === options.fleetId &&
        gate.taskId === plan.taskId &&
        gate.cause === plan.cause &&
        Math.trunc(gate.round) === Math.trunc(plan.round),
    );
    if (match !== undefined) {
      adopted.push({
        taskId: plan.taskId,
        cause: plan.cause,
        round: plan.round,
        gateId: match.gateId,
      });
      continue;
    }
    const outcome = await createOneGate(options, plan);
    if (!outcome.ok) {
      return {
        ok: false,
        error: outcome.error,
        gates: [...adopted, ...created],
        created,
        adopted,
        warnings: read.warnings,
      };
    }
    created.push(outcome.gate);
  }
  return { ok: true, gates: [...adopted, ...created], created, adopted, warnings: read.warnings };
}

/** The read half of {@link ensureFleetEscalationGates}: one gate list per bead. */
async function readOpenGates(options: EnsureFleetEscalationGatesOptions): Promise<
  | {
      ok: true;
      byBead: ReadonlyMap<string, readonly OpenFleetEscalationGate[]>;
      warnings: readonly string[];
    }
  | { ok: false; error: string; warnings: readonly string[] }
> {
  const byBead = new Map<string, readonly OpenFleetEscalationGate[]>();
  const warnings: string[] = [];
  if (options.existingGates !== undefined) {
    for (const gate of options.existingGates) {
      byBead.set(gate.taskId, [...(byBead.get(gate.taskId) ?? []), gate]);
    }
    return { ok: true, byBead, warnings };
  }
  for (const beadId of uniqueBeadIds(options.plan.map((plan) => plan.taskId))) {
    const lookup = await listFleetEscalationGatesForBead({
      beadId,
      cwd: options.cwd,
      runBd: options.runBd,
    });
    if (!lookup.ok) {
      return {
        ok: false,
        error: `could not read the escalation gates of ${beadId}: ${lookup.error}`,
        warnings,
      };
    }
    warnings.push(...lookup.drifts.map((drift) => drift.message));
    byBead.set(beadId, lookup.gates);
  }
  return { ok: true, byBead, warnings };
}

async function createOneGate(
  options: EnsureFleetEscalationGatesOptions,
  plan: FleetEscalationPlan,
): Promise<{ ok: true; gate: FleetEscalationGate } | { ok: false; error: string }> {
  const argv = buildFleetEscalationGateArgv(plan);
  try {
    const { stdout } = await options.runBd([...argv, "--json"], writeOptions(options.cwd));
    const gateId = parseCreatedGateId(stdout, plan.taskId);
    if (gateId === undefined) {
      return { ok: false, error: unusableGateCreateText(plan, stdout) };
    }
    return {
      ok: true,
      gate: { taskId: plan.taskId, cause: plan.cause, round: plan.round, gateId },
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Why a create that exited 0 still left the escalation unanswerable, and what to do.
 *
 * A gate created without a readable id may or may not exist; guessing the id would
 * either resolve the work bead or leave an orphan, so the failure is reported with
 * the exact command that finishes the job by hand.
 */
function unusableGateCreateText(plan: FleetEscalationPlan, stdout: string): string {
  const output = stdout.trim().slice(0, 200) || "(empty)";
  return (
    `bd gate create for ${plan.taskId} (${plan.cause}) exited 0 but reported no usable gate id ` +
    `(output: ${output}). The stop stands and no gate id was recorded; create it by hand with: ` +
    `bd gate create --blocks ${plan.taskId} --type=human --title '${plan.title}' ` +
    `--reason '${plan.reasonText}'`
  );
}

/**
 * Attach the opened gates to the stop records they escalate.
 *
 * Only a stop is a record of a gate: a parked-fleet escalation has no per-member stop
 * (that is the point — the member is fine, the fleet is not), so it is found again
 * through bd's own marker on the next pass.
 */
export function applyFleetEscalationGates(options: {
  run: FleetRun;
  gates: readonly FleetEscalationGate[];
  now: number;
}): FleetRun {
  let run = options.run;
  for (const gate of options.gates) {
    if (!isStopReason(gate.cause)) continue;
    const entry = (run.stopped ?? []).find((candidate) => candidate.taskId === gate.taskId);
    if (entry === undefined || entry.gateId === gate.gateId) continue;
    run = recordRunStopGate({
      run,
      taskId: gate.taskId,
      gateId: gate.gateId,
      now: options.now,
    });
  }
  return run;
}

export interface CheckFleetEscalationGatesOptions {
  cwd: string;
  runBd: FleetBeadRunner;
  fleetId: string;
  run: FleetRun;
  now: number;
  /** Members the fleet still holds; only read for a parked-fleet reconciliation. */
  taskIds?: readonly string[];
  parked?: ParkedFleetEscalation;
}

export interface CheckFleetEscalationGatesResult {
  run: FleetRun;
  /** Gate ids resolved because their stop (or park) is gone; drop them from ledgers. */
  reaped: readonly string[];
  /** Per-gate findings: the caller reports each once per run via `planGateNotices`. */
  notices: readonly FleetGateNotice[];
  warnings: readonly string[];
}

/**
 * Make bd's escalation gates agree with the run record in both directions.
 *
 * Two disagreements matter, and they are not the same failure:
 *
 * - **open gate, no matching stop** (the member was retried, landed, or removed):
 *   the escalation outlived its reason, so it is resolved and reported once by gate
 *   id. Leaving it open would block the bead in bd forever.
 * - **recorded `gateId`, no open gate**: the person answered it (or it vanished).
 *   The `--all` read recovers the resolution note and writes it onto the stop record
 *   — that answer is the decision input — and fires **no** warning, because the two
 *   sides agree. Only a gate the record names and bd has never heard of is real
 *   drift, and that warns.
 *
 * An open gate for the right `(bead, cause, round)` whose record lost its `gateId`
 * (a failed intent write) is adopted back onto the record instead of being reaped:
 * the stop still stands, so the escalation is still the right one.
 */
export async function checkFleetEscalationGates(
  options: CheckFleetEscalationGatesOptions,
): Promise<CheckFleetEscalationGatesResult> {
  const stops = (options.run.stopped ?? []).filter((entry) => isFleetEscalationCause(entry.reason));
  if (stops.length === 0 && options.parked === undefined) {
    return { run: options.run, reaped: [], notices: [], warnings: [] };
  }
  const keys = currentEscalationKeys({
    fleetId: options.fleetId,
    run: options.run,
    taskIds: options.taskIds ?? [],
    ...(options.parked === undefined ? {} : { parked: options.parked }),
  });
  const beads = uniqueBeadIds([
    ...stops.map((entry) => entry.taskId),
    ...(options.parked === undefined
      ? []
      : parkedEscalationTargets({ run: options.run, taskIds: options.taskIds ?? [] })),
  ]);

  let run = options.run;
  const reaped: string[] = [];
  const notices: FleetGateNotice[] = [];
  const warnings: string[] = [];
  for (const beadId of beads) {
    const checked = await checkOneBead({ beadId, stops, keys, options, run });
    run = checked.run;
    reaped.push(...checked.reaped);
    notices.push(...checked.notices);
    warnings.push(...checked.warnings);
  }
  return { run, reaped, notices, warnings };
}

/** What one bead's gate read decided, so the caller can fold it in. */
interface CheckedBead {
  run: FleetRun;
  reaped: readonly string[];
  notices: readonly FleetGateNotice[];
  warnings: readonly string[];
}

/**
 * Reconcile one bead's escalation gates with the stops that belong to it.
 *
 * Split from the sweep so each half stays readable: the open gates are compared with
 * the live keys (adopt or reap), then the recorded ids are compared with what bd
 * reports (answer or drift).
 */
async function checkOneBead(input: {
  beadId: string;
  stops: readonly FleetRunStop[];
  keys: ReadonlySet<string>;
  options: CheckFleetEscalationGatesOptions;
  run: FleetRun;
}): Promise<CheckedBead> {
  const { beadId, options } = input;
  const lookup = await listFleetEscalationGatesForBead({
    beadId,
    cwd: options.cwd,
    runBd: options.runBd,
  });
  if (!lookup.ok) {
    return {
      run: input.run,
      reaped: [],
      notices: [],
      warnings: [
        `Fleet ${options.fleetId}: could not read the escalation gates of ${beadId}: ` +
          lookup.error,
      ],
    };
  }
  const open = lookup.gates.filter((gate) => gate.fleetId === options.fleetId);
  const openSweep = await reconcileOpenGates({
    open,
    keys: input.keys,
    run: input.run,
    options,
  });
  const recorded = await reconcileRecordedGates({
    beadId,
    openIds: new Set(open.map((gate) => gate.gateId)),
    stops: input.stops,
    run: openSweep.run,
    options,
  });
  return {
    run: recorded.run,
    reaped: openSweep.reaped,
    notices: [...lookup.drifts, ...openSweep.notices, ...recorded.notices],
    warnings: [...openSweep.warnings, ...recorded.warnings],
  };
}

/** Adopt one gate per live escalation key, resolve the extras, reap the unclaimed. */
async function reconcileOpenGates(input: {
  open: readonly OpenFleetEscalationGate[];
  keys: ReadonlySet<string>;
  run: FleetRun;
  options: CheckFleetEscalationGatesOptions;
}): Promise<{
  run: FleetRun;
  reaped: readonly string[];
  notices: readonly FleetGateNotice[];
  warnings: readonly string[];
}> {
  let run = input.run;
  const reaped: string[] = [];
  const notices: FleetGateNotice[] = [];
  const warnings: string[] = [];
  const claimed = new Map<string, OpenFleetEscalationGate[]>();
  for (const gate of input.open) {
    const key = escalationKey(gate);
    if (input.keys.has(key)) {
      claimed.set(key, [...(claimed.get(key) ?? []), gate]);
      continue;
    }
    const swept = await reapUnclaimedGate(gate, input.options);
    reaped.push(...swept.reaped);
    notices.push(...swept.notices);
    warnings.push(...swept.warnings);
  }
  for (const gates of claimed.values()) {
    const keeper = keeperGate({ gates, recordedGateId: recordedGateIdOf(input.run, gates) });
    if (keeper === undefined) continue;
    run = adoptOpenGate({ run, gate: keeper, now: input.options.now });
    // A second gate for one escalation comes from a crash between `bd gate create` and
    // the record write, or from two supervisors. Only the keeper is recorded, and the
    // duplicate's marker still matches the stop, so no orphan sweep would ever take it:
    // a human answering the keeper would leave the duplicate blocking the bead forever.
    for (const duplicate of gates.filter((gate) => gate.gateId !== keeper.gateId)) {
      const resolved = await resolveGateId(duplicate.gateId, input.options);
      if (!resolved.ok) {
        warnings.push(`Fleet ${input.options.fleetId}: ${resolved.error}`);
        continue;
      }
      reaped.push(duplicate.gateId);
      notices.push({
        gateId: duplicate.gateId,
        message:
          `gate ${duplicate.gateId} duplicated the escalation of ${duplicate.taskId} ` +
          `(${duplicate.cause}, round ${duplicate.round}) recorded as gate ${keeper.gateId}; ` +
          "resolved the duplicate",
      });
    }
  }
  return { run, reaped, notices, warnings };
}

/** Resolve one open gate whose `(bead, cause, round)` no longer matches any record. */
async function reapUnclaimedGate(
  gate: OpenFleetEscalationGate,
  options: CheckFleetEscalationGatesOptions,
): Promise<{
  reaped: readonly string[];
  notices: readonly FleetGateNotice[];
  warnings: readonly string[];
}> {
  const resolved = await resolveGateId(gate.gateId, options);
  if (!resolved.ok)
    return { reaped: [], notices: [], warnings: [`Fleet ${options.fleetId}: ${resolved.error}`] };
  return {
    reaped: [gate.gateId],
    notices: [
      {
        gateId: gate.gateId,
        message:
          `gate ${gate.gateId} escalated ${gate.taskId} (${gate.cause}, round ` +
          `${gate.round}) but no open stop or park matches it any more; resolved it`,
      },
    ],
    warnings: [],
  };
}

/**
 * The gate to keep when one escalation has several: the recorded one, else the lowest id.
 *
 * The record is the only side that says which gate a stop's `gateId` points at, so a
 * recorded gate always wins. Without one, code-unit order is arbitrary but stable: any
 * deterministic pick keeps every later sweep choosing the same keeper.
 */
function keeperGate(input: {
  gates: readonly OpenFleetEscalationGate[];
  recordedGateId: string | undefined;
}): OpenFleetEscalationGate | undefined {
  const sorted = [...input.gates].sort((left, right) =>
    left.gateId < right.gateId ? -1 : left.gateId > right.gateId ? 1 : 0,
  );
  const recorded = sorted.find((gate) => gate.gateId === input.recordedGateId);
  return recorded ?? sorted[0];
}

/** The gate id a stop records for the escalation one of these open gates describes. */
function recordedGateIdOf(
  run: FleetRun,
  gates: readonly OpenFleetEscalationGate[],
): string | undefined {
  const gate = gates[0];
  if (gate === undefined) return undefined;
  return stopForEscalation(run, gate)?.gateId;
}

/** The stop record an escalation belongs to, matched on the full `(bead, cause, round)`. */
function stopForEscalation(
  run: FleetRun,
  gate: { taskId: string; cause: string; round: number },
): FleetRunStop | undefined {
  return (run.stopped ?? []).find(
    (candidate) =>
      candidate.taskId === gate.taskId &&
      candidate.reason === gate.cause &&
      Math.trunc(candidate.at) === Math.trunc(gate.round),
  );
}

/** Record the answer of a resolved gate, or warn when the record names a missing one. */
async function reconcileRecordedGates(input: {
  beadId: string;
  openIds: ReadonlySet<string>;
  stops: readonly FleetRunStop[];
  run: FleetRun;
  options: CheckFleetEscalationGatesOptions;
}): Promise<{ run: FleetRun; notices: readonly FleetGateNotice[]; warnings: readonly string[] }> {
  let run = input.run;
  const notices: FleetGateNotice[] = [];
  const warnings: string[] = [];
  for (const entry of input.stops) {
    // An answered stop is settled: re-reading its gate every tick would rewrite the
    // answer instant and let a later note-less read erase the decision (bd-279 review).
    if (entry.resolution !== undefined) continue;
    if (entry.taskId !== input.beadId || entry.gateId === undefined) continue;
    if (input.openIds.has(entry.gateId)) continue;
    const answered = await readClosedGate(entry.gateId, input.beadId, input.options);
    if (!answered.ok) {
      warnings.push(`Fleet ${input.options.fleetId}: ${answered.error}`);
      continue;
    }
    if (answered.status === "closed") {
      run = recordRunStopResolution({
        run,
        taskId: entry.taskId,
        ...(answered.note === undefined ? {} : { note: answered.note }),
        now: input.options.now,
      });
      continue;
    }
    notices.push({
      gateId: entry.gateId,
      message:
        `the stop of ${entry.taskId} (${entry.reason}) records gate ${entry.gateId}, but bd has ` +
        "no such gate; the stop keeps that id, so no new escalation is opened for it — clear " +
        `the stop with belayd_fleet_reconcile {"retryMembers":["${entry.taskId}"]} (the next ` +
        "tick then opens a fresh escalation), or recreate the gate by hand",
    });
  }
  return { run, notices, warnings };
}

/** Attach an already-open gate to the stop that lost its record, if any. */
function adoptOpenGate(options: {
  run: FleetRun;
  gate: OpenFleetEscalationGate;
  now: number;
}): FleetRun {
  if (!isStopReason(options.gate.cause)) return options.run;
  const entry = stopForEscalation(options.run, options.gate);
  if (entry === undefined || entry.gateId === options.gate.gateId) return options.run;
  return recordRunStopGate({
    run: options.run,
    taskId: options.gate.taskId,
    gateId: options.gate.gateId,
    now: options.now,
  });
}

type ClosedGateRead =
  | { ok: true; status: "none" }
  | { ok: true; status: "closed"; note?: string }
  | { ok: false; error: string };

/**
 * The closed escalation gate a stop recorded, from `bd gate list <bead> --all --json`.
 *
 * Read fail-closed: a failed or unparseable read is an error, never "answered". Only
 * the exact recorded id counts, because attributing another gate's `close_reason` to
 * this stop would fabricate the decision a supervisor acts on.
 */
async function readClosedGate(
  gateId: string,
  beadId: string,
  options: { cwd: string; runBd: FleetBeadRunner },
): Promise<ClosedGateRead> {
  const argv = buildGateListAllArgv(beadId);
  if (!isBdReadArgv(argv)) {
    return { ok: false, error: `refusing non-read bd argv "${argv.join(" ")}"` };
  }
  try {
    const { stdout } = await options.runBd(argv, readOptions(options.cwd));
    const records = asRecordList(JSON.parse(stdout) as unknown);
    const record = records.find((candidate) => candidate.id === gateId);
    if (record === undefined || record.status !== "closed") return { ok: true, status: "none" };
    const note = humanGateResolveNote(record.close_reason);
    return note === undefined
      ? { ok: true, status: "closed" }
      : { ok: true, status: "closed", note };
  } catch (error) {
    return {
      ok: false,
      error: `could not read gate ${gateId} of ${beadId}: ${errorMessage(error)}`,
    };
  }
}

/** Resolve one gate; "bd has never heard of it" is success (nothing left to answer). */
async function resolveGateId(
  gateId: string,
  options: { cwd: string; runBd: FleetBeadRunner },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isUsableGateId(gateId)) {
    return { ok: false, error: `refusing to resolve gate id "${gateId}"` };
  }
  try {
    await options.runBd(buildGateResolveArgv(gateId), writeOptions(options.cwd));
    return { ok: true };
  } catch (caught) {
    const detail = errorMessage(caught);
    return gateNotFoundMessage(gateId).test(detail) ? { ok: true } : { ok: false, error: detail };
  }
}

/** What a by-prefix reap may touch. */
export type FleetEscalationReapScope =
  | { scope: "causes"; causes: readonly FleetEscalationCause[] }
  | { scope: "whole-bead" };

export type ReapFleetEscalationGatesResult =
  | { ok: true; resolved: readonly FleetEscalationGate[]; warnings: readonly string[] }
  | {
      ok: false;
      error: string;
      resolved: readonly FleetEscalationGate[];
      warnings: readonly string[];
    };

/**
 * Resolve escalation gates bd knows about for these beads, whatever the record says.
 *
 * The repair path: a park cleared by `belayd_fleet_resume`/reconcile leaves gates the
 * run no longer has a park record for, and a pruned member leaves gates nothing can
 * answer. Only gates whose marker names *this* fleet are touched, and `causes`
 * narrows the sweep so an unpark never destroys a *stop* escalation that is still in
 * force for the same bead.
 */
export async function reapFleetEscalationGatesByPrefix(
  options: {
    fleetId: string;
    beadIds: readonly string[];
    cwd: string;
    runBd: FleetBeadRunner;
  } & FleetEscalationReapScope,
): Promise<ReapFleetEscalationGatesResult> {
  const resolved: FleetEscalationGate[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const causes = scopeCauses(options);
  for (const beadId of uniqueBeadIds(options.beadIds)) {
    const swept = await reapPrefixForBead({ beadId, causes, options });
    resolved.push(...swept.resolved);
    warnings.push(...swept.warnings);
    if (swept.error !== undefined) failures.push(swept.error);
  }
  const error = failures[0];
  return error === undefined
    ? { ok: true, resolved, warnings }
    : { ok: false, error, resolved, warnings };
}

/** Resolve the selected escalation gates blocking one bead; one read, N resolves. */
async function reapPrefixForBead(input: {
  beadId: string;
  causes: readonly FleetEscalationCause[] | undefined;
  options: {
    fleetId: string;
    cwd: string;
    runBd: FleetBeadRunner;
  };
}): Promise<{
  resolved: readonly FleetEscalationGate[];
  warnings: readonly string[];
  error?: string;
}> {
  const { beadId, options } = input;
  const lookup = await listFleetEscalationGatesForBead({
    beadId,
    cwd: options.cwd,
    runBd: options.runBd,
  });
  if (!lookup.ok) return { resolved: [], warnings: [], error: lookup.error };
  const resolved: FleetEscalationGate[] = [];
  const failures: string[] = [];
  for (const gate of lookup.gates) {
    if (gate.fleetId !== options.fleetId) continue;
    if (!causeSelected(gate.cause, input.causes)) continue;
    if (!isFleetEscalationCause(gate.cause)) continue;
    const outcome = await resolveGateId(gate.gateId, options);
    if (!outcome.ok) {
      failures.push(outcome.error);
      continue;
    }
    resolved.push({
      taskId: gate.taskId,
      cause: gate.cause,
      round: gate.round,
      gateId: gate.gateId,
    });
  }
  const warnings = lookup.drifts.map((drift) => drift.message);
  const error = failures[0];
  return error === undefined ? { resolved, warnings } : { resolved, warnings, error };
}

function causeSelected(
  cause: string,
  causes: readonly FleetEscalationCause[] | undefined,
): boolean {
  // No causes means "every escalation on this bead": the member left the fleet, so
  // nothing about its waits can still be live.
  if (causes === undefined) return true;
  if (!isFleetEscalationCause(cause)) return false;
  return causes.includes(cause);
}

/** The causes a reap is limited to, or undefined for a whole-bead sweep. */
function scopeCauses(scope: FleetEscalationReapScope): readonly FleetEscalationCause[] | undefined {
  return scope.scope === "causes" ? scope.causes : undefined;
}

function isStopReason(cause: string): cause is FleetRunStopReason {
  return (FLEET_RUN_STOP_REASONS as readonly string[]).includes(cause);
}

/** Array-or-single-object tolerance for untrusted bd JSON. */
function asRecordList(raw: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? [raw]
      : ([] as unknown[]);
  return values.filter(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
  );
}

function uniqueBeadIds(beadIds: readonly string[]): readonly string[] {
  return [...new Set(beadIds)].filter((beadId) => isUsableBeadId(beadId));
}

/** A gate id must be a real id, never a token that bd could read as a flag. */
function isUsableGateId(gateId: string): boolean {
  return gateId !== "" && !gateId.startsWith("-");
}

/** Same rule for a bead id read as a `bd` argument. */
function isUsableBeadId(beadId: string): boolean {
  return beadId !== "" && !beadId.startsWith("-");
}

/**
 * bd's answer for a gate id that does not exist: `Error: gate not found: <id>`.
 *
 * Anchored to that exact message and id, like the ordering reaper: a loose "not
 * found" match would swallow a database or lock error and report a live gate as
 * resolved.
 */
const gateNotFoundMessage = (gateId: string): RegExp =>
  new RegExp(`(?:^|\\n)\\s*(?:Error:\\s*)?gate not found:\\s*${escapeRegExp(gateId)}\\s*$`, "u");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readOptions(cwd: string): {
  cwd: string;
  stdin: undefined;
  timeoutInMs: number;
  maxBufferInBytes: number;
} {
  return {
    cwd,
    stdin: undefined,
    timeoutInMs: BEAD_READ_TIMEOUT_MS,
    maxBufferInBytes: BEAD_READ_MAX_BUFFER_BYTES,
  };
}

function writeOptions(cwd: string): {
  cwd: string;
  stdin: undefined;
  timeoutInMs: number;
  maxBufferInBytes: number;
} {
  return {
    cwd,
    stdin: undefined,
    timeoutInMs: GATE_WRITE_TIMEOUT_MS,
    maxBufferInBytes: BEAD_READ_MAX_BUFFER_BYTES,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
