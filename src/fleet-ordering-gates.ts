/**
 * Fleet ordering as bd gates, so landing never closes a bead (bd-158).
 *
 * bd derives blocked-ness from the *blocker bead's status*, so before this module
 * the only way a fleet could unblock a dependent was to close the blocker's bead.
 * `accept` therefore defaulted to true and a landed member's bead was closed to
 * express two different facts at once:
 *
 * - "nothing depends on this any more" — an ordering fact, and
 * - "a human accepted this work" — an acceptance fact.
 *
 * bd's own primitive for the first one is `bd gate`: a separate bead that blocks
 * a work bead and is resolved independently of it. Resolving a gate does not touch
 * the work bead (verified against bd 1.3.0), so the two facts get two objects and
 * two verbs:
 *
 * - **gate** = ordering. Created at launch for every dependency edge *between two
 *   members*, resolved when the blocker **lands** (merge succeeded), signalled by
 *   `fleet.json`'s `run.members[].landedAt`.
 * - **close** = acceptance. Only `src/fleet-accept.ts` closes, only when the launch
 *   asked for it (`--accept`), and the human otherwise accepts with `wt merge`.
 *
 * Gate type: bd 1.3.0 accepts `human`, `timer`, `gh:run`, and `gh:pr` only, with
 * no custom type. A `timer` gate would auto-resolve (wrong: the gate must be
 * resolved by a *landing*), so ordering gates are typed `human` and distinguished
 * by the structured marker in their title and reason:
 *
 *     belayd-fleet-ordering: fleet:<fleetId> <blocker> -> <blocked>
 *
 * The marker is structured on purpose — a bare prefix would be fail-open, since a
 * real human question may happen to start with it. `fleetOrderingGateMarkerOf`
 * requires the full shape (fleet id plus both bead ids), so an ordering gate is
 * never "answered" by the human-answer poll and a human gate is never mistaken for
 * ordering; see `bead-gates.ts`.
 *
 * Records: the intent (`fleet.json`) holds one `{ blocker, blocked, gateId }` per
 * created gate. bd is also read as truth here (`bd gate list <blocked>`), because
 * a crash between `bd gate create` and the intent write would otherwise leave an
 * unrecorded gate that blocks a dependent forever: the next launch adopts the gate
 * it finds instead of creating a second one, and resolves any duplicate for the
 * same edge.
 *
 * Trade-off, accepted explicitly: fleet ordering no longer appears in
 * `bd dep list` / `bd graph`; it lives in the gate's title/reason and in
 * `fleet.json`. An operator who wants bd's graph to show an edge can keep a plain
 * `blocks` edge for it — and then inherits bd's close-to-unblock rule for it.
 *
 * All argv builders and parsers here are pure; the drivers take an injected
 * `runBd` seam so unit tests never spawn a process.
 */

import { isBdReadArgv } from "./bd-command.js";
import { BEAD_READ_MAX_BUFFER_BYTES, BEAD_READ_TIMEOUT_MS } from "./bead-comments.js";
import {
  buildGateCreateArgv,
  buildGateListArgv,
  buildGateResolveArgv,
  type FleetOrderingGateDrift,
  type OpenFleetOrderingGate,
  parseCreatedGateId,
  readOpenFleetOrderingGates,
  renderFleetOrderingGateMarker,
} from "./bead-gates.js";
import type { FleetBeadRunner } from "./fleet-beads.js";
import type { FleetDependencyEdge } from "./fleet-schedule.js";
import { FLEET_INTENT_ORDERING_GATES_MAX } from "./fleet-status.js";

/** Recorded ordering gate: which member waits, on which member, under which gate. */
export interface FleetOrderingGate {
  blocker: string;
  blocked: string;
  gateId: string;
}

/** Write timeout for gate create/resolve; bd is a Dolt client and may be slow. */
const GATE_WRITE_TIMEOUT_MS = 120_000;

/**
 * bd's answer for a gate id that does not exist: `Error: gate not found: <id>`.
 *
 * Anchored to that exact message *and* that exact id on purpose. A loose "not
 * found" match would swallow a database, config, or lock error and report a live
 * gate as resolved, dropping its record and orphaning the dependent. A gate that
 * was already resolved is not an error at all in bd 1.3.0 (it exits 0), so this is
 * only about a gate id bd has never heard of.
 */
const gateNotFoundMessage = (gateId: string): RegExp =>
  new RegExp(`(?:^|\\n)\\s*(?:Error:\\s*)?gate not found:\\s*${escapeRegExp(gateId)}\\s*$`, "u");

/**
 * The edges that need a gate: both ends are members of this launch.
 *
 * External blockers are bd's own business — they already block the member bead
 * through the ordinary dependency edge, and a gate would duplicate that. Order is
 * caller order (edges arrive sorted by `blocked`), deduped so a repeated edge from
 * two `bd show` records creates one gate.
 */
export function planFleetOrderingGates(input: {
  edges: readonly FleetDependencyEdge[];
  taskIds: readonly string[];
}): readonly FleetDependencyEdge[] {
  const members = new Set(input.taskIds);
  const order = new Map(input.taskIds.map((taskId, index) => [taskId, index]));
  const seen = new Set<string>();
  const planned: FleetDependencyEdge[] = [];
  for (const edge of input.edges) {
    if (!members.has(edge.blocker) || !members.has(edge.blocked)) continue;
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    planned.push({ blocker: edge.blocker, blocked: edge.blocked });
  }
  return planned.sort((left, right) => {
    const leftIndex = order.get(left.blocked) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right.blocked) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.blocker < right.blocker ? -1 : left.blocker > right.blocker ? 1 : 0;
  });
}

/**
 * Why the gate exists, in the two places a human sees it.
 *
 * bd gates carry no payload, so the marker *is* the record: it names the fleet the
 * gate belongs to and both beads, and the prose after it says why the dependent is
 * blocked. The prose is bounded rather than the composed line, so a long reason can
 * never truncate the marker the readers depend on.
 */
/** Bound on the prose after the marker; bd's reason column is not a log. */
const GATE_REASON_PROSE_MAX = 180;

export function fleetOrderingGateReason(input: {
  fleetId: string;
  blocker: string;
  blocked: string;
}): string {
  const marker = renderFleetOrderingGateMarker(input);
  const prose =
    `: ${input.blocker} must land (merge into the base branch) before ${input.blocked}` +
    " — this gate is fleet ordering, not a human question; resolve it with `bd gate resolve`";
  return `${marker}${prose.slice(0, GATE_REASON_PROSE_MAX)}`;
}

/** Gate title: the structured marker alone, so bd's list says what the gate orders. */
export function fleetOrderingGateTitle(input: {
  fleetId: string;
  blocker: string;
  blocked: string;
}): string {
  return renderFleetOrderingGateMarker(input);
}

/** `bd gate create --blocks <blocked> --type=human --title <marker> --reason …`. */
export function buildFleetOrderingGateArgv(input: {
  fleetId: string;
  blocker: string;
  blocked: string;
}): readonly string[] {
  return buildGateCreateArgv({
    beadId: input.blocked,
    reason: fleetOrderingGateReason(input),
    title: fleetOrderingGateTitle(input),
  });
}

/** Read one bead's open gates from bd: the truth a relaunch dedupes against. */
export type FleetOrderingGateListResult =
  | { ok: true; gates: readonly OpenFleetOrderingGate[]; drifts: readonly FleetOrderingGateDrift[] }
  | { ok: false; error: string };

/**
 * `bd gate list <bead> --json`, parsed into the ordering gates bd reports open.
 *
 * Read-only by construction: the argv is checked against the read-only subcommand
 * list before any process is spawned, exactly like the other bd readers.
 */
export async function listFleetOrderingGatesForBead(options: {
  beadId: string;
  cwd: string;
  runBd: FleetBeadRunner;
}): Promise<FleetOrderingGateListResult> {
  if (!isUsableBeadId(options.beadId)) {
    return { ok: false, error: `refusing to read gates for bead id "${options.beadId}"` };
  }
  const argv = buildGateListArgv(options.beadId);
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
    const { gates, drifts } = readOpenFleetOrderingGates(JSON.parse(stdout) as unknown);
    return { ok: true, gates, drifts };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export interface CreateFleetOrderingGatesOptions {
  fleetId: string;
  edges: readonly FleetDependencyEdge[];
  /**
   * Every member this fleet knows about — the wave being launched *and* the
   * members already live. A member added by an advance can be blocked by a member
   * that started in an earlier wave; that edge needs a gate too, so the set is
   * "fleet members", not "this launch's members".
   */
  taskIds: readonly string[];
  /** Gates already recorded for this fleet, so a relaunch does not duplicate them. */
  existing?: readonly FleetOrderingGate[];
  cwd: string;
  runBd: FleetBeadRunner;
}

export type CreateFleetOrderingGatesResult =
  | {
      ok: true;
      /** Every record the caller must write: adopted gates plus the ones created now. */
      gates: readonly FleetOrderingGate[];
      /** Only the gates this call minted, so a rollback never touches an older one. */
      created: readonly FleetOrderingGate[];
      /** Gates that already existed in bd and only needed their record restored. */
      adopted: readonly FleetOrderingGate[];
      warnings: readonly string[];
    }
  | {
      ok: false;
      error: string;
      /** Only the gates this call minted; a refusal rolls back exactly these. */
      created: readonly FleetOrderingGate[];
      /** Adopted gates stay open (they predate this call) and keep their bead blocked. */
      adopted: readonly FleetOrderingGate[];
      warnings: readonly string[];
    };

/** What this launch decided for one edge, before any write happens. */
type EdgeDecision =
  | { kind: "adopt"; gate: FleetOrderingGate; duplicates: readonly string[] }
  | { kind: "create"; edge: FleetDependencyEdge };

/**
 * The record count the intent would hold: how many gate records fit the bound.
 *
 * This is a trust boundary on the intent (untrusted input to every reader), so
 * exceeding it is refused rather than truncated: a cut record is an open gate in
 * bd with nothing able to resolve it again.
 */
export function orderingGateBudgetRefusal(count: number): string | undefined {
  return count <= FLEET_INTENT_ORDERING_GATES_MAX
    ? undefined
    : `this fleet would record ${count} ordering gates, over the ` +
        `${FLEET_INTENT_ORDERING_GATES_MAX}-gate bound of \`fleet.json\`; nothing was written ` +
        "(resolve or remove a fleet's gates before adding more members)";
}

/**
 * Create one gate per internal edge, after asking bd what already exists.
 *
 * Idempotence has two sources, because neither alone is enough: the intent's
 * records (the normal case) and bd itself. A record can be lost — a crash between
 * `bd gate create` and the intent write, a truncation, a corrupt-intent recovery —
 * and without the bd read the next launch would create a *second* gate for the same
 * edge while the first stayed open, unresolvable, forever. So for each dependent
 * bead bd is asked once which ordering gates it already has:
 *
 * - a gate for the same edge is **adopted** (recorded, not re-created);
 * - extra gates for the same edge are **resolved** as duplicates;
 * - a gate naming a different edge is left alone (that edge is planned separately).
 *
 * The record budget is checked against the **post-adoption** set, because adoption
 * is not creation: a fleet already at the bound relaunching with every edge already
 * gated in bd must succeed. Only a launch that would add a *new* record is refused,
 * and it is refused before anything is created (the bd reads above are all pure
 * reads), so a refusal has nothing of its own to roll back.
 *
 * A bd read failure refuses the launch instead of guessing: creating a gate blind
 * is the failure mode this whole design exists to avoid.
 */
export async function createFleetOrderingGates(
  options: CreateFleetOrderingGatesOptions,
): Promise<CreateFleetOrderingGatesResult> {
  const existingKeys = new Set((options.existing ?? []).map((gate) => edgeKey(gate)));
  const planned = planFleetOrderingGates(options).filter(
    (edge) => !existingKeys.has(edgeKey(edge)),
  );
  const decided = await decideEdges(options, planned);
  if (!decided.ok) {
    return {
      ok: false,
      error: decided.error,
      created: [],
      adopted: [],
      warnings: decided.warnings,
    };
  }
  const { decisions, warnings } = decided;

  // Adoption adds a *record* for a gate that already exists, so it counts toward
  // the bound — but it is not something this launch created, so it is never rolled
  // back. Only a genuinely new record can push the fleet over.
  const prospective = new Set([
    ...existingKeys,
    ...decisions.flatMap((decision) =>
      decision.kind === "adopt" ? [edgeKey(decision.gate)] : [edgeKey(decision.edge)],
    ),
  ]);
  const refusal = orderingGateBudgetRefusal(prospective.size);
  if (refusal !== undefined) {
    return { ok: false, error: refusal, created: [], adopted: [], warnings };
  }

  const written = await writeDecisions(options, decisions);
  return written.ok
    ? {
        ok: true,
        gates: [...written.adopted, ...written.created],
        created: written.created,
        adopted: written.adopted,
        warnings,
      }
    : {
        ok: false,
        error: written.error,
        created: written.created,
        adopted: written.adopted,
        warnings,
      };
}

/**
 * Read-only phase: decide adopt-vs-create for every planned edge.
 *
 * Nothing is written here, so a budget refusal or an unreadable bd leaves bd exactly
 * as it was — the refusal has nothing of its own to roll back.
 */
async function decideEdges(
  options: CreateFleetOrderingGatesOptions,
  planned: readonly FleetDependencyEdge[],
): Promise<
  | { ok: true; decisions: readonly EdgeDecision[]; warnings: readonly string[] }
  | { ok: false; error: string; warnings: readonly string[] }
> {
  const warnings: string[] = [];
  const decisions: EdgeDecision[] = [];
  const byBead = new Map<string, FleetOrderingGateListResult>();
  for (const edge of planned) {
    const truth = await gatesForBead(options, edge.blocked, byBead);
    if (!truth.ok) {
      return {
        ok: false,
        error: `could not read the ordering gates of ${edge.blocked}: ${truth.error}`,
        warnings,
      };
    }
    warnings.push(...truth.drifts.map((drift) => drift.message));
    decisions.push(decideEdge(options, edge, truth.gates));
  }
  return { ok: true, decisions, warnings };
}

/** Write phase: resolve an adopted edge's duplicates, create the rest. */
async function writeDecisions(
  options: CreateFleetOrderingGatesOptions,
  decisions: readonly EdgeDecision[],
): Promise<
  | { ok: true; adopted: readonly FleetOrderingGate[]; created: readonly FleetOrderingGate[] }
  | {
      ok: false;
      error: string;
      adopted: readonly FleetOrderingGate[];
      created: readonly FleetOrderingGate[];
    }
> {
  const adopted: FleetOrderingGate[] = [];
  const created: FleetOrderingGate[] = [];
  for (const decision of decisions) {
    if (decision.kind === "adopt") {
      const cleanup = await resolveDuplicates(options, decision.duplicates);
      if (cleanup !== undefined) return { ok: false, error: cleanup, adopted, created };
      adopted.push(decision.gate);
      continue;
    }
    const outcome = await createOneGate(options, decision.edge);
    if (!outcome.ok) return { ok: false, error: outcome.error, adopted, created };
    created.push(outcome.gate);
  }
  return { ok: true, adopted, created };
}

/** Resolve every duplicate gate of one edge; undefined means all gone. */
async function resolveDuplicates(
  options: CreateFleetOrderingGatesOptions,
  duplicates: readonly string[],
): Promise<string | undefined> {
  for (const duplicate of duplicates) {
    const resolved = await resolveGateId(duplicate, options);
    if (!resolved.ok) return resolved.error;
  }
  return undefined;
}

/** Reuse bd's gate for `edge` when it exists; otherwise plan to create one. */
function decideEdge(
  options: CreateFleetOrderingGatesOptions,
  edge: FleetDependencyEdge,
  open: readonly OpenFleetOrderingGate[],
): EdgeDecision {
  const sameEdge = open.filter(
    (gate) =>
      gate.fleetId === options.fleetId &&
      gate.blocker === edge.blocker &&
      gate.blocked === edge.blocked,
  );
  const [adopt, ...duplicates] = sameEdge;
  if (adopt === undefined) return { kind: "create", edge };
  return {
    kind: "adopt",
    gate: { ...edge, gateId: adopt.gateId },
    duplicates: duplicates.map((gate) => gate.gateId),
  };
}

async function createOneGate(
  options: CreateFleetOrderingGatesOptions,
  edge: FleetDependencyEdge,
): Promise<{ ok: true; gate: FleetOrderingGate } | { ok: false; error: string }> {
  const argv = buildFleetOrderingGateArgv({ ...edge, fleetId: options.fleetId });
  try {
    const { stdout } = await options.runBd([...argv, "--json"], writeOptions(options.cwd));
    const gateId = parseCreatedGateId(stdout, edge.blocked);
    if (gateId === undefined) {
      return { ok: false, error: unusableGateCreateText(options.fleetId, edge, stdout) };
    }
    return { ok: true, gate: { ...edge, gateId } };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Why a create that exited 0 still left the launch unable to continue, and how to.
 *
 * `bd gate create` succeeding without a readable id is a version/payload mismatch,
 * not an ordinary failure: the gate may or may not exist, and guessing its id would
 * either resolve the work bead or leave an orphan. So the launch is refused and the
 * operator is handed the three facts they need — what happened, what to check, and
 * the exact command that finishes the job by hand.
 */
function unusableGateCreateText(
  fleetId: string,
  edge: FleetDependencyEdge,
  stdout: string,
): string {
  const title = fleetOrderingGateTitle({ fleetId, ...edge });
  const reason = fleetOrderingGateReason({ fleetId, ...edge });
  const output = stdout.trim().slice(0, 200) || "(empty)";
  return (
    `bd gate create for ${edge.blocker} -> ${edge.blocked} exited 0 but reported no usable ` +
    `gate id (output: ${output}). The launch was refused and nothing was left open: ` +
    `check \`bd version\` (this harness expects bd 1.3.0's \`--json\` payload or the ` +
    `\`✓ Created gate bd-N\` text form), then create the gate by hand with: bd gate create ` +
    `--blocks ${edge.blocked} --type=human --title '${title}' --reason '${reason}'`
  );
}

/** One `bd gate list` per blocked bead per launch, shared by every edge into it. */
async function gatesForBead(
  options: CreateFleetOrderingGatesOptions,
  beadId: string,
  cache: Map<string, FleetOrderingGateListResult>,
): Promise<FleetOrderingGateListResult> {
  const cached = cache.get(beadId);
  if (cached !== undefined) return cached;
  const lookup = await listFleetOrderingGatesForBead({
    beadId,
    cwd: options.cwd,
    runBd: options.runBd,
  });
  cache.set(beadId, lookup);
  return lookup;
}

export interface ResolveFleetOrderingGatesOptions {
  gates: readonly FleetOrderingGate[];
  cwd: string;
  runBd: FleetBeadRunner;
  /** Only gates whose blocker is this bead: the member that just landed. */
  blocker?: string;
  /** Only gates touching this bead on either side: a closed bead or a removed member. */
  beadId?: string;
}

export type ResolveFleetOrderingGatesResult =
  | { ok: true; resolved: readonly FleetOrderingGate[]; remaining: readonly FleetOrderingGate[] }
  /** `remaining` keeps the failed gates *and* the untouched ones, so nothing is lost. */
  | {
      ok: false;
      error: string;
      resolved: readonly FleetOrderingGate[];
      remaining: readonly FleetOrderingGate[];
    };

/**
 * Resolve the selected gates, treating "bd has never heard of this id" as success.
 *
 * Every selected gate is attempted even after one fails: the rest of the ordering
 * is independent, and one stale gate id must not stall the others. A failure
 * returns the gates that still need resolving so the caller can retry after a stop
 * instead of forgetting them. `resolved` is the exact list the caller may drop from
 * the intent — dropping by *gate id*, never by member id, or a shared blocker's
 * other (still open) gate would be forgotten and could never be resolved.
 */
export async function resolveFleetOrderingGates(
  options: ResolveFleetOrderingGatesOptions,
): Promise<ResolveFleetOrderingGatesResult> {
  const { selected, untouched } = selectGates(options);
  const resolved: FleetOrderingGate[] = [];
  const stuck: FleetOrderingGate[] = [];
  const failures: string[] = [];
  for (const gate of selected) {
    const container = { cwd: options.cwd, runBd: options.runBd };
    const outcome = await resolveGate(gate, container);
    if (outcome.ok) {
      resolved.push(gate);
      continue;
    }
    stuck.push(gate);
    failures.push(outcome.error);
  }
  const error = failures[0];
  return error === undefined
    ? { ok: true, resolved, remaining: untouched }
    : { ok: false, error, resolved, remaining: [...stuck, ...untouched] };
}

/** Split the recorded gates into the ones this call resolves and the rest. */
function selectGates(options: ResolveFleetOrderingGatesOptions): {
  selected: FleetOrderingGate[];
  untouched: FleetOrderingGate[];
} {
  const selected: FleetOrderingGate[] = [];
  const untouched: FleetOrderingGate[] = [];
  for (const gate of options.gates) {
    if (gateMatches(gate, options)) selected.push(gate);
    else untouched.push(gate);
  }
  return { selected, untouched };
}

function gateMatches(
  gate: FleetOrderingGate,
  options: { blocker?: string; beadId?: string },
): boolean {
  if (options.blocker !== undefined && gate.blocker !== options.blocker) return false;
  if (options.beadId === undefined) return true;
  return gate.blocker === options.beadId || gate.blocked === options.beadId;
}

/** Resolve one recorded gate; a "gate not found" answer means there is nothing left. */
async function resolveGate(
  gate: FleetOrderingGate,
  options: { cwd: string; runBd: FleetBeadRunner },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isUsableGateId(gate.gateId)) {
    return {
      ok: false,
      error: `refusing to resolve gate id "${gate.gateId}" for ${gate.blocker} -> ${gate.blocked}`,
    };
  }
  return resolveGateId(gate.gateId, options);
}

async function resolveGateId(
  gateId: string,
  options: { cwd: string; runBd: FleetBeadRunner },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await options.runBd(buildGateResolveArgv(gateId), writeOptions(options.cwd));
    return { ok: true };
  } catch (caught) {
    const detail = errorMessage(caught);
    return gateNotFoundMessage(gateId).test(detail) ? { ok: true } : { ok: false, error: detail };
  }
}

/**
 * Reap every recorded gate that touches `beadId`, in either direction.
 *
 * A member that landed (or was closed by a human, or removed) ends the gate's
 * purpose on both sides, so both are resolved.
 */
export function resolveFleetOrderingGatesForBead(
  options: Omit<ResolveFleetOrderingGatesOptions, "blocker" | "beadId"> & { beadId: string },
): Promise<ResolveFleetOrderingGatesResult> {
  return resolveFleetOrderingGates(options);
}

export type ReapFleetOrderingGatesResult =
  | { ok: true; resolved: readonly FleetOrderingGate[]; warnings: readonly string[] }
  | {
      ok: false;
      error: string;
      resolved: readonly FleetOrderingGate[];
      warnings: readonly string[];
    };

/**
 * What a by-prefix reap may touch.
 *
 * The discriminator exists because the two callers mean opposite things by "this
 * bead's gates": a rollback must resolve only the edges *it* created (anything else
 * is a live ordering it would otherwise destroy), while a bead that left the fleet
 * has no live ordering left at all. A bare optional `edges` let either caller pass
 * the loose form by accident, and the loose form is the destructive one.
 */
export type FleetOrderingGateReapScope =
  | { scope: "created-edges"; edges: readonly FleetDependencyEdge[] }
  | { scope: "whole-bead" };

/**
 * Resolve ordering gates bd knows about for these beads, whatever the intent says.
 *
 * This is the crash-window path: a gate can exist in bd while `fleet.json` has no
 * record of it (a crash between create and the intent write, a truncated record).
 * The reaper cannot find such a gate from the intent, so the beads that must not
 * stay gated are asked directly. Only gates whose marker names *this* fleet are
 * touched — another fleet's ordering is not ours to resolve.
 *
 * `scope` narrows the sweep to the edges a caller actually touched. A launch
 * rollback needs that: resolving every gate blocking a bead would also resolve the
 * fleet's *pre-existing* ordering for an unrelated edge, leaving a half-unordered
 * fleet behind.
 */
export async function reapFleetOrderingGatesByPrefix(
  options: {
    fleetId: string;
    beadIds: readonly string[];
    cwd: string;
    runBd: FleetBeadRunner;
  } & FleetOrderingGateReapScope,
): Promise<ReapFleetOrderingGatesResult> {
  const resolved: FleetOrderingGate[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  for (const beadId of uniqueBeadIds(options.beadIds)) {
    const outcome = await reapPrefixForBead(beadId, options);
    resolved.push(...outcome.resolved);
    warnings.push(...outcome.warnings);
    if (outcome.error !== undefined) failures.push(outcome.error);
  }
  const error = failures[0];
  return error === undefined
    ? { ok: true, resolved, warnings }
    : { ok: false, error, resolved, warnings };
}

/** Resolve this fleet's matching gates blocking one bead; one read, N resolves. */
async function reapPrefixForBead(
  beadId: string,
  options: {
    fleetId: string;
    cwd: string;
    runBd: FleetBeadRunner;
  } & FleetOrderingGateReapScope,
): Promise<{
  resolved: readonly FleetOrderingGate[];
  warnings: readonly string[];
  error?: string;
}> {
  const lookup = await listFleetOrderingGatesForBead({
    beadId,
    cwd: options.cwd,
    runBd: options.runBd,
  });
  if (!lookup.ok) return { resolved: [], warnings: [], error: lookup.error };
  const resolved: FleetOrderingGate[] = [];
  const failures: string[] = [];
  for (const gate of lookup.gates) {
    if (gate.fleetId !== options.fleetId) continue;
    if (!edgeSelected(gate, options)) continue;
    const outcome = await resolveGateId(gate.gateId, options);
    if (outcome.ok) {
      resolved.push({ blocker: gate.blocker, blocked: gate.blocked, gateId: gate.gateId });
    } else {
      failures.push(outcome.error);
    }
  }
  const warnings = lookup.drifts.map((drift) => drift.message);
  const error = failures[0];
  return error === undefined ? { resolved, warnings } : { resolved, warnings, error };
}

function edgeSelected(
  gate: { blocker: string; blocked: string },
  scope: FleetOrderingGateReapScope,
): boolean {
  if (scope.scope === "whole-bead") return true;
  return scope.edges.some((edge) => edge.blocker === gate.blocker && edge.blocked === gate.blocked);
}

function uniqueBeadIds(beadIds: readonly string[]): readonly string[] {
  return [...new Set(beadIds)].filter((beadId) => isUsableBeadId(beadId));
}

function edgeKey(edge: { blocker: string; blocked: string }): string {
  return `${edge.blocker}\u0000${edge.blocked}`;
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

/** A gate id must be a real id, never a token that bd could read as a flag. */
function isUsableGateId(gateId: string): boolean {
  return gateId !== "" && !gateId.startsWith("-");
}

/** Same rule for a bead id read as a `bd` argument. */
function isUsableBeadId(beadId: string): boolean {
  return beadId !== "" && !beadId.startsWith("-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
