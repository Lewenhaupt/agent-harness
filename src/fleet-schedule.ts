/**
 * Fleet scheduling — P3 of the fleet supervisor (bd-126).
 *
 * P1 launches whatever the operator lists, in the operator's order. P3 is the
 * smallest honest piece of automation on top of that: given the members, the
 * blocking edges between them, and how many orchestrators are already running,
 * decide **which** members start now and **in what order** the rest are planned —
 * and say so.
 *
 * Three properties this module exists to deliver:
 *
 * 1. **Ordering follows real dependencies, not input order.** An edge comes from
 *    bd's own blocking relationship (`blocks`), never from a title, a label, or a
 *    guess. A member waits until the bead that blocks it has landed.
 * 2. **The ceiling counts orchestrators.** `capacity` is in-flight sessions, not
 *    sub-agents, and a start decision subtracts the ones already running. The
 *    locked ceiling is 3 (`FLEET_MAX_CONCURRENT_ORCHESTRATORS`); nothing here
 *    raises it, and the remainder is *deferred*, never dropped.
 * 3. **It is a pure function over already-read data.** No git, no bd, no fs: the
 *    caller reads the dependency graph and observes running work; this module
 *    only computes. That is what makes a cycle refusal and a capacity deferral
 *    testable without a repository.
 *
 * What P3 deliberately does not do: it does not advance waves. Wave 2 starts when
 * an operator calls `belayd_fleet_advance` (or an explicit launch names it), which
 * re-runs this same scheduler against the re-read dependency graph — there is no
 * poller, because an unsupervised background loop is not a decision anyone can
 * audit (docs/fleet-orchestrator.md).
 */

/** A blocking edge: `blocker` must land before `blocked` starts. */
export interface FleetDependencyEdge {
  blocker: string;
  blocked: string;
}

export interface FleetScheduleInput {
  /** Members to schedule, in caller order (the deterministic tie-break). */
  taskIds: readonly string[];
  /** Known blocking edges; a blocker outside `taskIds` means "wait for that bead". */
  edges: readonly FleetDependencyEdge[];
  /** Concurrency ceiling in effect (already clamped to the locked maximum). */
  capacity: number;
  /** Orchestrators already running, counted against the same ceiling. */
  activeCount: number;
}

/**
 * Why a member did not make the first launch.
 *
 * `dependency` — an in-set blocker is planned before it (a later wave).
 * `external-blocker` — a bead outside this launch still blocks it.
 * `capacity` — ready to go, but every slot is taken.
 *
 * The array is the single source of truth: the `fleet.json` intent schema
 * validates its persisted `deferred[].reason` against it, so a reason added here
 * cannot silently become unwritable (or an unknown persisted reason readable).
 */
export const FLEET_SCHEDULE_DEFERRAL_REASONS = [
  "capacity",
  "dependency",
  "external-blocker",
] as const;

export type FleetScheduleDeferralReason = (typeof FLEET_SCHEDULE_DEFERRAL_REASONS)[number];

export interface FleetScheduleDeferral {
  taskId: string;
  reason: FleetScheduleDeferralReason;
  /** Wave the member is planned for (0-based); absent when it cannot be planned. */
  wave?: number;
  /** Blockers that keep it out of wave 0. */
  blockers: readonly string[];
  detail: string;
}

export interface FleetScheduleWave {
  /** 0-based wave; wave 0 is the one this call may launch. */
  index: number;
  taskIds: readonly string[];
}

export interface FleetSchedule {
  capacity: number;
  activeCount: number;
  /** Free slots this call may fill: `max(0, capacity - activeCount)`. */
  slots: number;
  waves: readonly FleetScheduleWave[];
  /** Members to launch now: wave 0, limited to `slots`, in caller order. */
  launchNow: readonly string[];
  deferred: readonly FleetScheduleDeferral[];
  /** Operator-readable rationale; no scheduling decision is silent. */
  reasons: readonly string[];
  /** Non-fatal problems (unusable or contradictory input). */
  warnings: readonly string[];
}

export type FleetScheduleRefusalReason = "no-tasks" | "dependency-cycle" | "invalid-capacity";

export type FleetScheduleResult =
  | { ok: true; schedule: FleetSchedule }
  | {
      ok: false;
      reason: FleetScheduleRefusalReason;
      text: string;
      /** The cycle, as a closed path (`["bd-12", "bd-15", "bd-12"]`). */
      cycle?: readonly string[];
    };

/**
 * Deduplicate ids while keeping the first (caller) position.
 *
 * The duplicate list is reported as a warning, but through the wired launch path
 * (`fleet-launch.ts`) it is unreachable: validation refuses duplicated ids before
 * the scheduler sees them. It is kept for direct callers (and tests) so the
 * scheduler stays honest about input it did receive rather than silently
 * collapsing it.
 */
function uniqueIds(taskIds: readonly string[]): { ids: string[]; duplicates: string[] } {
  const seen = new Set<string>();
  const ids: string[] = [];
  const duplicates: string[] = [];
  for (const taskId of taskIds) {
    if (seen.has(taskId)) {
      duplicates.push(taskId);
      continue;
    }
    seen.add(taskId);
    ids.push(taskId);
  }
  return { ids, duplicates };
}

function refusal(
  reason: FleetScheduleRefusalReason,
  text: string,
  cycle?: readonly string[],
): FleetScheduleResult {
  return { ok: false, reason, text, ...(cycle === undefined ? {} : { cycle }) };
}

/** Refusal reason for unusable input, or undefined when the input is usable. */
function validateScheduleInput(input: FleetScheduleInput): FleetScheduleRefusalReason | undefined {
  if (input.taskIds.length === 0) return "no-tasks";
  if (!Number.isInteger(input.capacity) || input.capacity < 1) return "invalid-capacity";
  return undefined;
}

/** Input problems that do not prevent a plan but must be visible. */
function scheduleInputWarnings(duplicates: readonly string[], activeCount: number): string[] {
  const warnings: string[] = [];
  if (duplicates.length > 0) {
    warnings.push(`duplicate task id(s) ignored while scheduling: ${duplicates.join(", ")}`);
  }
  if (!Number.isFinite(activeCount) || activeCount < 0) {
    warnings.push(
      `active orchestrator count ${activeCount} is unusable; assuming 0 (the capacity check may ` +
        "start work that should have waited)",
    );
  }
  return warnings;
}

/** Orchestrators to subtract from the ceiling; an unusable count becomes 0. */
function normalizeActiveCount(activeCount: number): number {
  return Number.isFinite(activeCount) && activeCount > 0 ? Math.floor(activeCount) : 0;
}

/**
 * Blocking edges that concern the planned members, deduplicated and deterministic.
 *
 * Caller order first, then blocker id: the same edges in a different order must
 * produce the same plan, which is what makes the report reproducible.
 */
function orderEdges(
  edges: readonly FleetDependencyEdge[],
  planned: ReadonlySet<string>,
  order: readonly string[],
): FleetDependencyEdge[] {
  const orderIndex = new Map(order.map((taskId, index) => [taskId, index]));
  const seen = new Set<string>();
  const relevant: FleetDependencyEdge[] = [];
  for (const edge of edges) {
    if (!planned.has(edge.blocked)) continue;
    const key = `${edge.blocker}\u0000${edge.blocked}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relevant.push({ blocker: edge.blocker, blocked: edge.blocked });
  }
  relevant.sort((left, right) => {
    const blocked = (orderIndex.get(left.blocked) ?? 0) - (orderIndex.get(right.blocked) ?? 0);
    if (blocked !== 0) return blocked;
    const blocker = (orderIndex.get(left.blocker) ?? 0) - (orderIndex.get(right.blocker) ?? 0);
    if (blocker !== 0) return blocker;
    return left.blocker < right.blocker ? -1 : 1;
  });
  return relevant;
}

interface BlockerMaps {
  /** In-set blockers per member (the ordering edges). */
  internal: ReadonlyMap<string, readonly string[]>;
  /** Blockers outside the launch per member. */
  external: ReadonlyMap<string, readonly string[]>;
}

/** Split the edges by whether the blocker is part of this launch. */
function collectBlockers(
  order: readonly string[],
  edges: readonly FleetDependencyEdge[],
  planned: ReadonlySet<string>,
): BlockerMaps {
  const internal = new Map<string, string[]>(order.map((taskId) => [taskId, []]));
  const external = new Map<string, string[]>(order.map((taskId) => [taskId, []]));
  for (const edge of edges) {
    if (!planned.has(edge.blocked)) continue;
    const target = planned.has(edge.blocker) ? internal : external;
    target.get(edge.blocked)?.push(edge.blocker);
  }
  return { internal, external };
}

/**
 * Members that cannot be planned because something outside the launch blocks
 * them — directly, or through an in-set blocker that cannot start either.
 */
function propagateUnplannable(
  order: readonly string[],
  internal: ReadonlyMap<string, readonly string[]>,
  external: ReadonlyMap<string, readonly string[]>,
): Map<string, readonly string[]> {
  const unplannable = new Map<string, readonly string[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const taskId of order) {
      if (unplannable.has(taskId)) continue;
      const outside = external.get(taskId) ?? [];
      if (outside.length > 0) {
        unplannable.set(taskId, outside);
        changed = true;
        continue;
      }
      const blockedBy = (internal.get(taskId) ?? []).filter((blocker) => unplannable.has(blocker));
      if (blockedBy.length === 0) continue;
      unplannable.set(taskId, blockedBy);
      changed = true;
    }
  }
  return unplannable;
}

/** Wave for one member, or undefined while a blocker has no wave yet. */
function waveForMember(
  taskId: string,
  internal: ReadonlyMap<string, readonly string[]>,
  waveOf: ReadonlyMap<string, number>,
): number | undefined {
  const levels = (internal.get(taskId) ?? []).map((blocker) => waveOf.get(blocker));
  if (levels.some((level) => level === undefined)) return undefined;
  return Math.max(...levels.map((level) => level ?? 0)) + 1;
}

/**
 * Assign each plannable member a wave: one past the deepest blocker it waits for.
 *
 * A member left without a wave is in (or behind) a cycle; the caller turns that
 * into a refusal with the path.
 */
function assignWaves(
  order: readonly string[],
  internal: ReadonlyMap<string, readonly string[]>,
  unplannable: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const waveOf = new Map<string, number>();
  for (const taskId of order) {
    if (!unplannable.has(taskId) && (internal.get(taskId) ?? []).length === 0) {
      waveOf.set(taskId, 0);
    }
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const taskId of order) {
      if (waveOf.has(taskId) || unplannable.has(taskId)) continue;
      const wave = waveForMember(taskId, internal, waveOf);
      if (wave === undefined) continue;
      waveOf.set(taskId, wave);
      progressed = true;
    }
  }
  return waveOf;
}

/** Group the placed members into deterministic waves. */
function buildWaves(
  order: readonly string[],
  waveOf: ReadonlyMap<string, number>,
): FleetScheduleWave[] {
  const indexes = [...new Set(waveOf.values())].sort((left, right) => left - right);
  return indexes.map((index) => ({
    index,
    taskIds: order.filter((taskId) => waveOf.get(taskId) === index),
  }));
}

/**
 * Find a dependency cycle and return it as a closed path.
 *
 * Only called when the wave placement left nodes behind, so a cycle exists.
 * Starting from the first leftover node in caller order keeps the reported path
 * deterministic, which is what makes the refusal reproducible in a test and
 * recognizable to the operator.
 */
function findCycle(
  unplaced: readonly string[],
  edges: readonly FleetDependencyEdge[],
): readonly string[] {
  const blockersOf = new Map<string, readonly string[]>();
  for (const edge of edges) {
    if (!unplaced.includes(edge.blocker) || !unplaced.includes(edge.blocked)) continue;
    blockersOf.set(edge.blocked, [...(blockersOf.get(edge.blocked) ?? []), edge.blocker]);
  }
  const start = unplaced[0];
  if (start === undefined) return [];
  const path: string[] = [];
  const indexInPath = new Map<string, number>();
  let current = start;
  while (!indexInPath.has(current)) {
    indexInPath.set(current, path.length);
    path.push(current);
    const next = (blockersOf.get(current) ?? [])[0];
    if (next === undefined) break;
    current = next;
  }
  const cycleStart = indexInPath.get(current);
  if (cycleStart === undefined) return [];
  return [...path.slice(cycleStart), current];
}

interface DeferralInput {
  order: readonly string[];
  waves: readonly FleetScheduleWave[];
  waveZero: readonly string[];
  slots: number;
  capacity: number;
  activeCount: number;
  edges: readonly FleetDependencyEdge[];
  unplannable: ReadonlyMap<string, readonly string[]>;
  planned: ReadonlySet<string>;
}

function capacityDeferrals(input: DeferralInput): FleetScheduleDeferral[] {
  return input.waveZero.slice(input.slots).map((taskId) => ({
    taskId,
    reason: "capacity" as const,
    wave: 0,
    blockers: [],
    detail:
      `ready, but all ${input.slots} free slot(s) are filled ` +
      `(capacity ${input.capacity}, ${input.activeCount} active)`,
  }));
}

function dependencyDeferrals(input: DeferralInput): FleetScheduleDeferral[] {
  const deferrals: FleetScheduleDeferral[] = [];
  for (const wave of input.waves) {
    if (wave.index === 0) continue;
    for (const taskId of wave.taskIds) {
      const blockers = input.edges
        .filter((edge) => edge.blocked === taskId)
        .map((edge) => edge.blocker);
      deferrals.push({
        taskId,
        reason: "dependency",
        wave: wave.index,
        blockers,
        detail:
          `wave ${wave.index}: waits for ${blockers.join(", ")} to land ` +
          "(launched by a later fleet launch or by belayd_fleet_advance)",
      });
    }
  }
  return deferrals;
}

function unplannableDeferrals(input: DeferralInput): FleetScheduleDeferral[] {
  const deferrals: FleetScheduleDeferral[] = [];
  for (const taskId of input.order) {
    const blockedBy = input.unplannable.get(taskId);
    if (blockedBy === undefined) continue;
    const outside = blockedBy.filter((blocker) => !input.planned.has(blocker));
    // A direct outside blocker and a member waiting for one that is itself
    // blocked read differently to the operator, so they get different reasons.
    if (outside.length > 0) {
      deferrals.push({
        taskId,
        reason: "external-blocker",
        blockers: outside,
        detail:
          `blocked by ${outside.join(", ")}, which is not part of this launch; it cannot be ` +
          "planned for any wave until that bead lands",
      });
      continue;
    }
    deferrals.push({
      taskId,
      reason: "dependency",
      blockers: blockedBy,
      detail:
        `waits for ${blockedBy.join(", ")}, which cannot start either (blocked by a bead ` +
        "outside this launch); no wave can be planned until that bead lands",
    });
  }
  return deferrals;
}

function buildDeferrals(input: DeferralInput): FleetScheduleDeferral[] {
  const deferrals = [
    ...capacityDeferrals(input),
    ...dependencyDeferrals(input),
    ...unplannableDeferrals(input),
  ];
  return deferrals.sort(
    (left, right) => input.order.indexOf(left.taskId) - input.order.indexOf(right.taskId),
  );
}

function buildReasons(input: DeferralInput): string[] {
  const reasons = [
    `capacity ${input.capacity}, ${input.activeCount} orchestrator(s) already active → ` +
      `${input.slots} slot(s)`,
  ];
  if (input.waves.length > 1) {
    reasons.push(
      `planned ${input.waves.length} waves: ` +
        input.waves.map((wave) => `wave ${wave.index} [${wave.taskIds.join(", ")}]`).join(", "),
    );
  }
  const outside = input.order.filter((taskId) =>
    (input.unplannable.get(taskId) ?? []).some((blocker) => !input.planned.has(blocker)),
  );
  if (outside.length > 0) {
    reasons.push(`${outside.join(", ")} cannot be planned: blocked by a bead outside this launch`);
  }
  return reasons;
}

/**
 * Plan which members start now and how the rest are ordered.
 *
 * Capacity is subtracted first: `slots = max(0, capacity - activeCount)`. Wave 0
 * is the set that could start now; only its first `slots` members are launched.
 * Everything else is deferred with a reason — capacity, an in-set dependency, or
 * a blocker outside this launch.
 *
 * A dependency cycle refuses the whole plan (with the path) instead of silently
 * dropping members: an order that cannot exist is not a plan, and launching part
 * of a cycle would leave the rest waiting forever.
 */
export function planFleetSchedule(input: FleetScheduleInput): FleetScheduleResult {
  const invalid = validateScheduleInput(input);
  if (invalid !== undefined) {
    return refusal(
      invalid,
      invalid === "no-tasks"
        ? "no members to schedule"
        : `concurrency capacity ${input.capacity} is not a positive whole number`,
    );
  }

  const { ids: order, duplicates } = uniqueIds(input.taskIds);
  const warnings = scheduleInputWarnings(duplicates, input.activeCount);
  const activeCount = normalizeActiveCount(input.activeCount);
  const capacity = input.capacity;
  const slots = Math.max(0, capacity - activeCount);
  const planned = new Set(order);

  const edges = orderEdges(input.edges, planned, order);
  const blockers = collectBlockers(order, edges, planned);
  const unplannable = propagateUnplannable(order, blockers.internal, blockers.external);
  const waveOf = assignWaves(order, blockers.internal, unplannable);

  const unplaced = order.filter((taskId) => !waveOf.has(taskId) && !unplannable.has(taskId));
  if (unplaced.length > 0) {
    const cycle = findCycle(unplaced, edges);
    const path = cycle.length === 0 ? unplaced.join(" → ") : cycle.join(" → ");
    return refusal(
      "dependency-cycle",
      `dependency cycle between fleet members: ${path}. Break the cycle with \`bd dep remove\` ` +
        "before launching; nothing was created.",
      cycle,
    );
  }

  const waves = buildWaves(order, waveOf);
  const waveZero = waves.find((wave) => wave.index === 0)?.taskIds ?? [];
  const launchNow = waveZero.slice(0, slots);
  const deferralInput: DeferralInput = {
    order,
    waves,
    waveZero,
    slots,
    capacity,
    activeCount,
    edges,
    unplannable,
    planned,
  };

  return {
    ok: true,
    schedule: {
      capacity,
      activeCount,
      slots,
      waves,
      launchNow,
      deferred: buildDeferrals(deferralInput),
      reasons: buildReasons(deferralInput),
      warnings,
    },
  };
}

// ── bd dependency graph (read → pure) ────────────────────────────────

/** bd's blocking dependency type; every other relationship type is not an order. */
export const FLEET_BLOCKING_DEPENDENCY_TYPES: readonly string[] = ["blocks"];

/** Bead statuses that mean a blocker needs no waiting for. */
export const FLEET_FINISHED_BEAD_STATUSES: readonly string[] = ["closed", "done"];

/** What a dependency read produced: edges, plus why they might be incomplete. */
export interface FleetDependencyGraph {
  edges: readonly FleetDependencyEdge[];
  warnings: readonly string[];
}

/** Cap on warning lines, so a hostile payload cannot bloat a tool result. */
const DEPENDENCY_WARNING_MAX = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DependencyParse =
  | { kind: "blocker"; blocker: string }
  | { kind: "skip" }
  | { kind: "malformed" };

/**
 * One `dependencies[]` entry → an ordering blocker, a deliberate skip, or noise.
 *
 * Only `blocks` orders work; a blocker that already finished has landed and is a
 * skip; anything without a usable id/type is malformed (reported, never turned
 * into a fabricated edge).
 */
function parseDependency(dependency: unknown): DependencyParse {
  if (!isRecord(dependency) || typeof dependency.id !== "string") {
    return { kind: "malformed" };
  }
  const type = dependency.dependency_type;
  if (typeof type !== "string" || !FLEET_BLOCKING_DEPENDENCY_TYPES.includes(type)) {
    return { kind: "skip" };
  }
  const status = typeof dependency.status === "string" ? dependency.status : undefined;
  if (status !== undefined && FLEET_FINISHED_BEAD_STATUSES.includes(status)) {
    return { kind: "skip" };
  }
  return { kind: "blocker", blocker: dependency.id };
}

/** Edges contributed by one `bd show` record, or undefined when it is not ours. */
function recordEdges(
  record: unknown,
  planned: ReadonlySet<string>,
): { edges: FleetDependencyEdge[]; malformed: number } | undefined {
  if (!isRecord(record)) return { edges: [], malformed: 1 };
  if (typeof record.id !== "string" || !planned.has(record.id)) return undefined;
  const dependencies = record.dependencies;
  if (dependencies === undefined) return { edges: [], malformed: 0 };
  if (!Array.isArray(dependencies)) return { edges: [], malformed: 1 };

  const edges: FleetDependencyEdge[] = [];
  let malformed = 0;
  for (const dependency of dependencies) {
    const parsed = parseDependency(dependency);
    if (parsed.kind === "malformed") malformed += 1;
    if (parsed.kind === "blocker") edges.push({ blocker: parsed.blocker, blocked: record.id });
  }
  return { edges, malformed };
}

/**
 * Parse `bd show <ids> --json --brief-deps` into blocking edges.
 *
 * `dependencies` on a `bd show` record lists the beads the record depends on
 * (bd-55 → dependency bd-19 with `dependency_type: "blocks"` means bd-19 blocks
 * bd-55). Only blocking relationships are ordering edges; `related` and the other
 * link types say nothing about order, so inventing an edge from them would stall
 * work that could start.
 *
 * An already-finished blocker is dropped: it has landed, so it cannot be a
 * reason to wait. Everything unreadable degrades to "no known edges" plus a
 * warning — never a crash, never a fabricated edge.
 */
export function parseFleetDependencyEdges(
  raw: unknown,
  taskIds: readonly string[],
): FleetDependencyGraph {
  if (!Array.isArray(raw)) {
    return {
      edges: [],
      warnings: [
        "could not read the bead dependency graph (unexpected bd output); scheduling in the " +
          "order given, without dependency ordering",
      ],
    };
  }

  const planned = new Set(taskIds);
  const edges: FleetDependencyEdge[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  for (const record of raw) {
    const parsed = recordEdges(record, planned);
    if (parsed === undefined) continue;
    malformed += parsed.malformed;
    for (const edge of parsed.edges) {
      const key = `${edge.blocker}\u0000${edge.blocked}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }

  const warnings: string[] = [];
  if (malformed > 0) {
    warnings.push(
      `${malformed} unreadable dependency record(s) ignored; those members may start earlier ` +
        "than their blockers",
    );
  }
  edges.sort((left, right) => {
    const leftIndex = taskIds.indexOf(left.blocked);
    const rightIndex = taskIds.indexOf(right.blocked);
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.blocker < right.blocker ? -1 : left.blocker > right.blocker ? 1 : 0;
  });
  return { edges, warnings: warnings.slice(0, DEPENDENCY_WARNING_MAX) };
}
