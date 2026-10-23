/**
 * Fleet launch: the decision half of `belayd_fleet_launch` / `/fleet` (bd-126 P1).
 *
 * Everything here is pure. The extension does the side effects — resolve the git
 * common dir, probe worktrees, write the intent, spawn members through the
 * existing single-bead launch path — because a second spawner would be a second
 * set of semantics for the same worktree/handoff contract.
 *
 * Two rules the launch exists to enforce:
 *
 * - **Validate before acting.** Every task id is checked before anything is
 *   created, so an invalid request cannot leave a half-built fleet behind.
 * - **The concurrency ceiling is a clamp, not a filter.** The locked decision is
 *   3 concurrent orchestrators; a larger request is clamped to 3 and *says so*,
 *   because silently accepting it would be a lie and silently dropping the
 *   request would hide the operator's intent.
 */

import type {
  FleetSupervisorLiveness,
  FleetSupervisorRecord,
  FleetSupervisorState,
} from "./fleet-mode.js";
import {
  classifyFleetSupervisor,
  createFleetSupervisorRecord,
  listFleetIds,
} from "./fleet-mode.js";
import type { FleetDependencyGraph, FleetSchedule, FleetScheduleResult } from "./fleet-schedule.js";
import { planFleetSchedule } from "./fleet-schedule.js";
import type { FleetStateFs } from "./fleet-state.js";
import {
  appendFleetAuditEntry,
  createFleetIntent,
  readFleetIntent,
  updateFleetIntent,
} from "./fleet-state.js";
import type { FleetIntent } from "./fleet-status.js";
import {
  DEFAULT_FLEET_ID,
  FLEET_INTENT_DEFERRED_MAX,
  FLEET_INTENT_MEMBERS_MAX,
  sanitizeFleetId,
} from "./fleet-status.js";
import { isValidTaskId } from "./session-naming.js";

/** Locked concurrency ceiling: concurrent orchestrators, not total agents. */
export const FLEET_MAX_CONCURRENT_ORCHESTRATORS = 3;

export interface FleetConcurrencyResolution {
  /** Ceiling actually stored in `fleet.json`. */
  maxConcurrent: number;
  /** Requested value when it was above the ceiling and had to be clamped down. */
  clampedFrom?: number;
  /** Requested value when it was fractional and had to be floored to a whole number. */
  flooredFrom?: number;
  /** Requested value when it was unusable (not a positive integer) and ignored. */
  ignoredRequested?: number;
}

/**
 * Resolve the requested concurrency against the ceiling.
 *
 * An unusable request (0, negative, fractional below 1, non-finite) falls back to
 * the ceiling instead of failing the launch: the operator asked to start work,
 * and the ceiling is the documented default. The value is reported back either
 * way — including a fraction that was floored (`flooredFrom`) — so the tool
 * result can never silently disagree with what was stored.
 */
export function resolveFleetConcurrency(requested: number | undefined): FleetConcurrencyResolution {
  if (requested === undefined) {
    return { maxConcurrent: FLEET_MAX_CONCURRENT_ORCHESTRATORS };
  }
  const floored = Math.floor(requested);
  if (!Number.isFinite(requested) || floored < 1) {
    return {
      maxConcurrent: FLEET_MAX_CONCURRENT_ORCHESTRATORS,
      ignoredRequested: requested,
    };
  }
  if (floored > FLEET_MAX_CONCURRENT_ORCHESTRATORS) {
    return {
      maxConcurrent: FLEET_MAX_CONCURRENT_ORCHESTRATORS,
      clampedFrom: requested,
    };
  }
  if (floored !== requested) {
    return { maxConcurrent: floored, flooredFrom: requested };
  }
  return { maxConcurrent: floored };
}

/**
 * Per-task facts the validator cannot derive itself.
 *
 * `ownershipError` is the *existing* bd-119 resolution (`matchOwnedWorktree`)
 * applied to a worktree that already exists for this member's branch, so the
 * fleet never re-derives bead ↔ branch ↔ worktree identity with its own rules.
 */
export interface FleetMemberProbe {
  taskId: string;
  ownershipError?: string;
}

export type FleetLaunchRefusalReason =
  | "empty-task-list"
  | "invalid-task-id"
  | "duplicate-task-id"
  | "already-member"
  | "conflicting-worktree"
  | "fleet-supervised"
  | "fleet-supervised-elsewhere";

export interface FleetLaunchRefusal {
  taskId?: string;
  reason: FleetLaunchRefusalReason;
  error: string;
}

/**
 * One fleet as the launch engine saw it.
 *
 * The launch needs membership *and* supervisor liveness per fleet, not just a
 * task-id map: a member of a fleet whose supervisor is dead may be re-armed, a
 * member of a live fleet may not, and a target fleet with another live supervisor
 * must not be silently taken over.
 */
export interface FleetLaunchFleet {
  fleetId: string;
  members: readonly string[];
  supervisor: FleetSupervisorState;
}

export interface ValidateFleetLaunchInput {
  /** Raw ids in caller order. Duplicates are refused, never collapsed. */
  taskIds: readonly string[];
  /** Every fleet in the repository, this one included. */
  fleets: readonly FleetLaunchFleet[];
  /** Fleet this launch targets (`/fleet --fleet <id>`); its members may be re-armed. */
  targetFleetId: string;
  /** Session asking to supervise; tells "my live fleet" from another session's. */
  sessionId: string;
  /**
   * The fleet this session already supervises, when it holds fleet mode.
   *
   * A supervisor session owns exactly one fleet: launching a second one from an
   * armed session would silently replace the in-memory arm, orphaning the first
   * fleet's record while its members still address a supervisor that no longer
   * answers. The extension resolves this from the arm token (never from a fleet
   * record alone), so the guard keys on real authority, not on a planted file.
   */
  sessionFleetId?: string;
  /** Worktree probes, one per id that has an existing worktree. */
  probes?: readonly FleetMemberProbe[];
  requestedConcurrency?: number;
}

export type FleetLaunchValidation =
  | {
      ok: true;
      /** Ids to launch now; a re-armed fleet's existing members are preserved. */
      taskIds: readonly string[];
      /** Existing target-fleet members echoed by the request: kept, not relaunched. */
      rearmedTaskIds: readonly string[];
      /** The target fleet existed with no live supervisor, so the record is re-armed. */
      rearm: boolean;
      maxConcurrent: number;
      clampedFrom?: number;
      flooredFrom?: number;
      ignoredRequestedConcurrency?: number;
    }
  | { ok: false; refusals: readonly FleetLaunchRefusal[]; error: string };

/** Format the refusal list as one operator-readable message. */
export function formatFleetLaunchRefusals(refusals: readonly FleetLaunchRefusal[]): string {
  const lines = refusals.map((refusal) =>
    refusal.taskId === undefined ? `- ${refusal.error}` : `- ${refusal.taskId}: ${refusal.error}`,
  );
  return `Fleet launch refused; nothing was created.\n${lines.join("\n")}`;
}

/**
 * Why an id already in a fleet cannot be launched again.
 *
 * The dead-supervisor wording matters: launching the bead into a *different* fleet
 * would split its mailbox (notes for it keep landing in a fleet no live supervisor
 * drains), so the operator is told to re-arm the owning fleet instead.
 */
function alreadyMemberError(holder: FleetLaunchFleet): string {
  switch (holder.supervisor.kind) {
    case "live":
      return (
        `already a member of fleet \`${holder.fleetId}\`, supervised by live session ` +
        `\`${holder.supervisor.sessionId}\`; stop it there before launching it again`
      );
    case "dead":
      return (
        `already a member of fleet \`${holder.fleetId}\`, whose supervisor is not running; ` +
        `re-arm that fleet (\`/fleet <ids> --fleet ${holder.fleetId}\`) instead of launching it ` +
        "into a second fleet, or its notes go to a mailbox no live supervisor drains"
      );
    case "none":
      return (
        `already a member of fleet \`${holder.fleetId}\` (no recorded supervisor); ` +
        `re-arm that fleet (\`/fleet <ids> --fleet ${holder.fleetId}\`) instead of launching it ` +
        "into a second fleet"
      );
  }
}

/**
 * Validate a whole launch before any side effect.
 *
 * Every problem is collected (not just the first) so one operator round-trip
 * fixes the whole request. Ids already present in a **live** fleet are refused
 * rather than treated as idempotent: re-launching a live member would put two
 * orchestrators on one bead, which is the invariant bd-119 exists to protect.
 *
 * **Re-arm (C2).** When the target fleet's supervisor is not running, the fleet's
 * own members are *preserved* instead of refused: a resumed supervisor re-arms
 * with `/fleet <existing ids> --fleet <id>`, which rewrites the supervisor record
 * and keeps members (and their intent) intact. Those ids are not relaunched —
 * their worktrees and sessions still exist — so `taskIds` (launch now) and
 * `rearmedTaskIds` (kept) are separate outputs. A live supervisor from another
 * session is refused outright (`fleet-supervised`), never silently replaced.
 */
/**
 * What one requested id is, before any side effect: launched now, preserved by a
 * re-arm, or refused with a reason.
 */
type FleetTaskClassification =
  | { kind: "launch" }
  | { kind: "rearm" }
  | { kind: "refusal"; refusal: FleetLaunchRefusal };

/**
 * Classify one requested id against the target fleet's state.
 *
 * Extracted from the loop so `validateFleetLaunch` stays a readable orchestration
 * of "collect, refuse-or-accept" rather than a nest of membership checks.
 */
function classifyLaunchTask(options: {
  taskId: string;
  seen: ReadonlySet<string>;
  target: FleetLaunchFleet | undefined;
  targetFleetId: string;
  rearmable: boolean;
  fleets: readonly FleetLaunchFleet[];
  probes: readonly FleetMemberProbe[] | undefined;
}): FleetTaskClassification {
  const { taskId } = options;
  if (!isValidTaskId(taskId)) {
    return {
      kind: "refusal",
      refusal: {
        taskId,
        reason: "invalid-task-id",
        error: `invalid task id (expected a beads id like bd-42 or bd-42.1)`,
      },
    };
  }
  if (options.seen.has(taskId)) {
    return {
      kind: "refusal",
      refusal: {
        taskId,
        reason: "duplicate-task-id",
        error: "listed more than once in this launch",
      },
    };
  }

  // Another fleet claiming the same member is a split-brain that a re-arm must
  // not paper over: the team that owns it there has to be re-armed or stopped.
  const otherHolder = options.fleets.find(
    (fleet) => fleet.fleetId !== options.targetFleetId && fleet.members.includes(taskId),
  );
  if (otherHolder !== undefined) {
    return {
      kind: "refusal",
      refusal: { taskId, reason: "already-member", error: alreadyMemberError(otherHolder) },
    };
  }

  const target = options.target;
  if (target?.members.includes(taskId)) {
    if (options.rearmable) return { kind: "rearm" };
    return {
      kind: "refusal",
      refusal: { taskId, reason: "already-member", error: alreadyMemberError(target) },
    };
  }

  const probe = options.probes?.find((candidate) => candidate.taskId === taskId);
  if (probe?.ownershipError !== undefined) {
    return {
      kind: "refusal",
      refusal: { taskId, reason: "conflicting-worktree", error: probe.ownershipError },
    };
  }

  return { kind: "launch" };
}

/**
 * Validate a whole launch before any side effect.
 *
 * Every problem is collected (not just the first) so one operator round-trip
 * fixes the whole request. Ids already present in a **live** fleet are refused
 * rather than treated as idempotent: re-launching a live member would put two
 * orchestrators on one bead, which is the invariant bd-119 exists to protect.
 *
 * **Re-arm (C2).** When the target fleet's supervisor is not running, the fleet's
 * own members are *preserved* instead of refused: a resumed supervisor re-arms
 * with `/fleet <existing ids> --fleet <id>`, which rewrites the supervisor record
 * and keeps members (and their intent) intact. Those ids are not relaunched —
 * their worktrees and sessions still exist — so `taskIds` (launch now) and
 * `rearmedTaskIds` (kept) are separate outputs. A live supervisor from another
 * session is refused outright (`fleet-supervised`), never silently replaced.
 */
/** One-refusal result for a request-wide guard. */
function singleRefusal(refusal: FleetLaunchRefusal): FleetLaunchValidation {
  return {
    ok: false,
    refusals: [refusal],
    error: formatFleetLaunchRefusals([refusal]),
  };
}

/** Refuse a request that names no ids. */
function emptyTaskListRefusal(): FleetLaunchValidation {
  return singleRefusal({
    reason: "empty-task-list",
    error: "no task ids given; pass one or more beads (e.g. bd-12 bd-15)",
  });
}

/**
 * Another session is live on this fleet: taking it over would de-supervise that
 * session with no warning, so the whole request is refused before any write.
 */
function foreignSupervisorRefusal(options: {
  targetFleetId: string;
  targetSupervisor: FleetSupervisorState;
  sessionId: string;
}): FleetLaunchValidation | undefined {
  const supervisor = options.targetSupervisor;
  if (supervisor.kind !== "live" || supervisor.sessionId === options.sessionId) return undefined;
  return singleRefusal({
    reason: "fleet-supervised",
    error:
      `fleet \`${options.targetFleetId}\` is already supervised by live session ` +
      `\`${supervisor.sessionId}\`; let that session keep scheduling it, or stop it ` +
      "before re-arming. Nothing was changed.",
  });
}

/**
 * One session supervises one fleet. Without this, launching a second fleet
 * replaces the in-memory arm token while the first fleet's record still names
 * this session: its inbox refuses (the session resolves to the new fleet) and
 * every other session is refused `fleet-supervised`, so the first fleet is
 * wedged until its pid dies or someone re-arms by hand.
 */
function secondFleetRefusal(options: {
  sessionFleetId: string | undefined;
  targetFleetId: string;
}): FleetLaunchValidation | undefined {
  const advisory = options.sessionFleetId;
  if (advisory === undefined || advisory === options.targetFleetId) return undefined;
  return singleRefusal({
    reason: "fleet-supervised-elsewhere",
    error:
      `this session already supervises fleet \`${advisory}\`; a session supervises one ` +
      `fleet at a time, so it cannot take over \`${options.targetFleetId}\` too. Keep scheduling ` +
      `\`${advisory}\`, or launch \`${options.targetFleetId}\` from another session. Nothing was ` +
      "changed.",
  });
}

export function validateFleetLaunch(input: ValidateFleetLaunchInput): FleetLaunchValidation {
  if (input.taskIds.length === 0) return emptyTaskListRefusal();

  const targetFleetId = sanitizeFleetId(input.targetFleetId);
  const target = input.fleets.find((fleet) => fleet.fleetId === targetFleetId);
  const targetSupervisor: FleetSupervisorState = target?.supervisor ?? { kind: "none" };

  const guarded =
    foreignSupervisorRefusal({
      targetFleetId,
      targetSupervisor,
      sessionId: input.sessionId,
    }) ??
    secondFleetRefusal({
      sessionFleetId:
        input.sessionFleetId === undefined ? undefined : sanitizeFleetId(input.sessionFleetId),
      targetFleetId,
    });
  if (guarded !== undefined) return guarded;

  const rearmable = target !== undefined && targetSupervisor.kind !== "live";
  const rearmedTaskIds: string[] = [];
  const launchTaskIds: string[] = [];
  const refusals: FleetLaunchRefusal[] = [];
  const seen = new Set<string>();

  for (const taskId of input.taskIds) {
    const classification = classifyLaunchTask({
      taskId,
      seen,
      target,
      targetFleetId,
      rearmable,
      fleets: input.fleets,
      probes: input.probes,
    });
    seen.add(taskId);
    switch (classification.kind) {
      case "rearm":
        rearmedTaskIds.push(taskId);
        break;
      case "refusal":
        refusals.push(classification.refusal);
        break;
      case "launch":
        launchTaskIds.push(taskId);
        break;
    }
  }

  if (refusals.length > 0) {
    return { ok: false, refusals, error: formatFleetLaunchRefusals(refusals) };
  }

  const concurrency = resolveFleetConcurrency(input.requestedConcurrency);
  return {
    ok: true,
    taskIds: launchTaskIds,
    rearmedTaskIds,
    rearm: rearmable && (rearmedTaskIds.length > 0 || launchTaskIds.length > 0),
    maxConcurrent: concurrency.maxConcurrent,
    ...(concurrency.clampedFrom === undefined ? {} : { clampedFrom: concurrency.clampedFrom }),
    ...(concurrency.flooredFrom === undefined ? {} : { flooredFrom: concurrency.flooredFrom }),
    ...(concurrency.ignoredRequested === undefined
      ? {}
      : { ignoredRequestedConcurrency: concurrency.ignoredRequested }),
  };
}

// ── Intent merge ──────────────────────────────────────────────────────

export interface MergeFleetIntentInput {
  /** Intent already on disk for this fleet, or undefined for a first launch. */
  current: FleetIntent | undefined;
  fleetId: string;
  /** Members this launch adds; already validated as new to the fleet. */
  taskIds: readonly string[];
  now: number;
  maxConcurrent: number;
  baseBranch?: string;
  supervisor: NonNullable<FleetIntent["supervisor"]>;
  /**
   * Members P3 deferred this launch, with the reason each waits.
   *
   * Omitted by a re-arm (which adds no members), so the plan a previous launch
   * recorded survives a supervisor restart instead of being silently cleared.
   */
  deferred?: FleetIntent["deferred"];
}

/**
 * Merge a launch into the fleet intent.
 *
 * Operator intent accumulates: an earlier member set stays, the new ids are
 * appended in caller order, and the supervisor record is replaced (the session
 * that launched last is the live one). `createdAt`, `paused`, and the operator's
 * `note` are preserved — a launch must not overwrite facts it did not set.
 *
 * **Re-arm (C2) is the same merge with an empty `taskIds`**: the existing members
 * are kept as-is and only the supervisor record + `updatedAt` change, so a resumed
 * supervisor recovers its fleet without relaunching (or losing) any member.
 */
export function mergeFleetIntent(input: MergeFleetIntentInput): FleetIntent {
  const created = createFleetIntent({
    fleetId: input.fleetId,
    taskIds: [...(input.current?.taskIds ?? []), ...input.taskIds],
    now: input.now,
    maxConcurrent: input.maxConcurrent,
    ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
    supervisor: input.supervisor,
  });
  const current = input.current;
  // A launch restates the plan it just computed (it may have launched some of the
  // entries), but a deferral it did not schedule stays waiting: dropping it here
  // would make a wave-1 member vanish from both `taskIds` and `deferred`, which is
  // the one state the intent may never reach. A re-arm keeps the plan it inherited.
  const deferred =
    input.deferred === undefined
      ? current?.deferred
      : mergeDeferralLists({
          current: current?.deferred,
          launched: input.taskIds,
          planned: input.deferred,
        });
  if (current === undefined) {
    return deferred === undefined ? created : { ...created, deferred };
  }
  return {
    ...created,
    createdAt: current.createdAt,
    ...(current.paused === undefined ? {} : { paused: current.paused }),
    ...(current.park === undefined ? {} : { park: current.park }),
    ...(current.note === undefined ? {} : { note: current.note }),
    ...(deferred === undefined ? {} : { deferred }),
  };
}

/**
 * The new plan first, then the earlier entries it did not schedule.
 *
 * An entry is retired only by being launched (it is in `launched`) or by being
 * restated in the new plan; everything else is still waiting and is preserved in
 * its original order, so the list stays deterministic across re-launches.
 */
function mergeDeferralLists(options: {
  current: FleetIntent["deferred"];
  launched: readonly string[];
  planned: NonNullable<FleetIntent["deferred"]>;
}): NonNullable<FleetIntent["deferred"]> {
  const launched = new Set(options.launched);
  const planned = new Set(options.planned.map((entry) => entry.taskId));
  const preserved = (options.current ?? []).filter(
    (entry) => !launched.has(entry.taskId) && !planned.has(entry.taskId),
  );
  return [...options.planned, ...preserved];
}

// ── /fleet command parsing ────────────────────────────────────────────

export interface FleetCommandArgs {
  taskIds: readonly string[];
  fleetId?: string;
  concurrency?: number;
}

export type FleetCommandParse = { ok: true; args: FleetCommandArgs } | { ok: false; error: string };

/** Usage line shown for a bare or malformed `/fleet`. */
export function fleetUsageText(): string {
  return [
    "Usage: /fleet bd-12 bd-15 [bd-19] [--fleet <id>] [--concurrency <n>]",
    "  task ids: beads to run as members, each in its own worktree (1 or more)",
    `  --fleet <id>: fleet directory name (default: ${DEFAULT_FLEET_ID})`,
    `  --concurrency <n>: concurrent orchestrators, capped at ${FLEET_MAX_CONCURRENT_ORCHESTRATORS}`,
  ].join("\n");
}

const FLEET_FLAG_NAMES: readonly string[] = ["--fleet", "--concurrency"];

/**
 * Parse `/fleet` arguments.
 *
 * Whitespace splitting is enough for these tokens (bead ids and numeric
 * concurrency contain no spaces); anything that looks like a flag is validated
 * rather than treated as an id, so a typo cannot silently become a task id.
 */
function parseFleetFlagToken(tokens: readonly string[], index: number): FleetFlagParse {
  const token = tokens[index] ?? "";
  if (!FLEET_FLAG_NAMES.includes(token)) {
    return { ok: false, error: `Unknown flag ${token}.\n${fleetUsageText()}` };
  }
  const value = tokens[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return { ok: false, error: `${token} needs a value.\n${fleetUsageText()}` };
  }
  if (token === "--fleet") return { ok: true, consumed: 2, fleetId: value };

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `--concurrency needs a number, got "${value}".` };
  }
  return { ok: true, consumed: 2, concurrency: parsed };
}

type FleetFlagParse =
  | { ok: true; consumed: number; fleetId?: string; concurrency?: number }
  | { ok: false; error: string };

/**
 * Parse `/fleet` arguments.
 *
 * Whitespace splitting is enough for these tokens (bead ids and numeric
 * concurrency contain no spaces); anything that looks like a flag is validated
 * rather than treated as an id, so a typo cannot silently become a task id.
 */
export function parseFleetCommandArgs(raw: string): FleetCommandParse {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  if (tokens.length === 0) return { ok: false, error: fleetUsageText() };

  const taskIds: string[] = [];
  let fleetId: string | undefined;
  let concurrency: number | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("--")) {
      taskIds.push(token);
      continue;
    }
    const flag = parseFleetFlagToken(tokens, index);
    if (!flag.ok) return flag;
    index += flag.consumed - 1;
    if (flag.fleetId !== undefined) fleetId = flag.fleetId;
    if (flag.concurrency !== undefined) concurrency = flag.concurrency;
  }

  if (taskIds.length === 0) {
    return { ok: false, error: `No task ids given.\n${fleetUsageText()}` };
  }

  return {
    ok: true,
    args: {
      taskIds,
      ...(fleetId === undefined ? {} : { fleetId }),
      ...(concurrency === undefined ? {} : { concurrency }),
    },
  };
}

// ── Tool parameter narrowing ──────────────────────────────────────────

export type FleetTaskIdParse =
  | { ok: true; taskIds: readonly string[] }
  | { ok: false; error: string };

/**
 * Narrow the `tasks` tool parameter (one id or several) into a list.
 *
 * Accepts an array as well as a whitespace/comma separated string, because a
 * model may call the tool either way; an empty token is dropped rather than
 * becoming an invalid id.
 */
export function parseFleetTaskIds(raw: readonly string[] | string | undefined): FleetTaskIdParse {
  if (raw === undefined) return { ok: false, error: "tasks is required" };
  const tokens = Array.isArray(raw) ? raw : [raw];
  const taskIds = tokens
    .flatMap((token) => token.split(/[\s,]+/))
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (taskIds.length === 0) return { ok: false, error: "tasks is required" };
  return { ok: true, taskIds };
}

// ── Launch report ─────────────────────────────────────────────────────

export interface FleetMemberLaunchOutcome {
  taskId: string;
  ok: boolean;
  /** Worktree path on success, refusal/error text on failure. */
  detail: string;
  /** Workflow type the member was launched with (successful launches only). */
  workflowType?: string;
}

export interface FormatFleetLaunchReportInput {
  fleetId: string;
  maxConcurrent: number;
  clampedFrom?: number;
  flooredFrom?: number;
  ignoredRequestedConcurrency?: number;
  outcomes: readonly FleetMemberLaunchOutcome[];
  /** Existing members preserved by a re-arm (kept, not relaunched). */
  rearmedTaskIds?: readonly string[];
  /** The target fleet existed with no live supervisor, so the record was re-armed. */
  rearm?: boolean;
  /** P3 plan; absent when this call added no members to schedule. */
  schedule?: FleetSchedule;
}

/** Header line: a re-arm reads differently from a fresh launch. */
function formatLaunchHeader(input: FormatFleetLaunchReportInput): string {
  const launched = input.outcomes.filter((outcome) => outcome.ok);
  if (input.rearm !== true) {
    return (
      `Fleet \`${input.fleetId}\`: ${launched.length}/${input.outcomes.length} member(s) launched ` +
      `(maxConcurrent ${input.maxConcurrent}).`
    );
  }
  const newPart =
    input.outcomes.length === 0
      ? "no new members"
      : `${launched.length}/${input.outcomes.length} new member(s) launched`;
  const rearmedCount = (input.rearmedTaskIds ?? []).length;
  return (
    `Fleet \`${input.fleetId}\`: re-armed — supervisor record rewritten, ` +
    `${rearmedCount} existing member(s) preserved, ${newPart} (maxConcurrent ` +
    `${input.maxConcurrent}).`
  );
}

/** Concurrency lines: every adjustment to the stored value is stated. */
function formatConcurrencyLines(input: FormatFleetLaunchReportInput): string[] {
  const lines: string[] = [];
  if (input.clampedFrom !== undefined) {
    lines.push(
      `Concurrency ${input.clampedFrom} is above the ceiling of ` +
        `${FLEET_MAX_CONCURRENT_ORCHESTRATORS} orchestrators; stored ${input.maxConcurrent}.`,
    );
  }
  if (input.flooredFrom !== undefined) {
    lines.push(
      `Concurrency ${input.flooredFrom} is not a whole number; stored ${input.maxConcurrent}.`,
    );
  }
  if (input.ignoredRequestedConcurrency !== undefined) {
    lines.push(
      `Concurrency ${input.ignoredRequestedConcurrency} is not a positive whole number; ` +
        `stored the default ${input.maxConcurrent}.`,
    );
  }
  return lines;
}

/** Scheduling lines: the waves, what starts now, and why the rest waits (P3). */
function formatScheduleLines(schedule: FleetSchedule | undefined): string[] {
  if (schedule === undefined) return [];
  const lines = [
    `Scheduling: ${schedule.launchNow.length} member(s) now, ${schedule.deferred.length} ` +
      `deferred (capacity ${schedule.capacity}, ${schedule.activeCount} already active, ` +
      `${schedule.slots} free slot(s)).`,
  ];
  for (const wave of schedule.waves) {
    const when = wave.index === 0 ? "now" : "later launch";
    lines.push(`- wave ${wave.index} (${when}): ${wave.taskIds.join(", ")}`);
  }
  for (const deferral of schedule.deferred) {
    lines.push(`- deferred ${deferral.taskId} (${deferral.reason}): ${deferral.detail}`);
  }
  if (schedule.waves.length > 1) {
    lines.push(
      "Later waves are a plan, not a promise: this call launches only wave 0 up to capacity. " +
        "Advance a later wave explicitly with belayd_fleet_advance (there is no background poller).",
    );
  }
  return lines;
}

/**
 * Render one launch: what the fleet is, what each member did, and what the
 * operator has to fix. Failures are listed per member — a launch that dropped a
 * member silently would leave the operator believing three beads are running.
 */
export function formatFleetLaunchReport(input: FormatFleetLaunchReportInput): string {
  const failed = input.outcomes.filter((outcome) => !outcome.ok);
  const rearmed = input.rearmedTaskIds ?? [];

  const lines: string[] = [
    formatLaunchHeader(input),
    ...formatConcurrencyLines(input),
    ...formatScheduleLines(input.schedule),
  ];
  if (rearmed.length > 0) {
    lines.push(
      `Preserved existing member(s): ${rearmed.join(", ")} (not relaunched; their worktrees ` +
        "and orchestrators are untouched).",
    );
  }
  for (const outcome of input.outcomes) {
    if (!outcome.ok) {
      lines.push(`- ${outcome.taskId}: NOT launched — ${outcome.detail}`);
      continue;
    }
    const type = outcome.workflowType === undefined ? "" : ` (${outcome.workflowType})`;
    lines.push(`- ${outcome.taskId}: launched${type} — ${outcome.detail}`);
  }
  if (failed.length > 0) {
    lines.push(
      `Removed ${failed.map((outcome) => outcome.taskId).join(", ")} from the fleet intent, so a ` +
        `later launch can retry it. The remaining members are unaffected.`,
    );
  }
  lines.push(
    "Members are detached orchestrators; this session supervises them. It runs no phases and " +
      "owns no worktree — use belayd_fleet_status, belayd_fleet_note, and belayd_fleet_inbox.",
  );
  return lines.join("\n");
}

// ── The launch engine ─────────────────────────────────────────────────

/**
 * Every fleet's membership and supervisor state, from one intent read pass.
 *
 * The launch needs the target fleet's own record (to re-arm it) plus every other
 * fleet's membership (to refuse a split-brain launch), and it needs supervisor
 * liveness per fleet to word those refusals honestly.
 */
export interface FleetLaunchContext {
  fleets: readonly FleetLaunchFleet[];
  /** Raw intent for the target fleet, used to preserve its ceiling on a re-arm. */
  targetIntent: FleetIntent | undefined;
  /** Sanitized target fleet id (the same value passed to validation). */
  targetFleetId: string;
  /**
   * Fleet directory names whose intent could not be read or parsed.
   *
   * Their members are still running as detached sessions, but their count is
   * unknowable, so the launch refuses rather than assuming zero (see
   * `planLaunchSchedule`). Sanitized ids, code-unit sorted.
   */
  unknownFleets: readonly string[];
}

export interface CollectFleetLaunchContextOptions {
  gitCommonDir: string;
  fleetId: string;
  liveness: FleetSupervisorLiveness;
  fs?: FleetStateFs;
}

export function collectFleetLaunchContext(
  options: CollectFleetLaunchContextOptions,
): FleetLaunchContext {
  const targetFleetId = sanitizeFleetId(options.fleetId);
  const fleets: FleetLaunchFleet[] = [];
  const unknownFleets: string[] = [];
  let targetIntent: FleetIntent | undefined;
  for (const fleetId of listFleetIds(options)) {
    const loaded = readFleetIntent({
      gitCommonDir: options.gitCommonDir,
      fleetId,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
    const sanitized = sanitizeFleetId(fleetId);
    // Neither a corrupt record nor a read failure may be treated as "no members":
    // the count below is the ceiling's only guard, so an unreadable fleet is
    // recorded and escalates to a refusal.
    if (!loaded.ok) {
      unknownFleets.push(sanitized);
      continue;
    }
    if (loaded.intent === undefined) continue;
    fleets.push({
      fleetId: sanitized,
      members: [...loaded.intent.taskIds],
      supervisor: classifyFleetSupervisor({
        supervisor: loaded.intent.supervisor,
        liveness: options.liveness,
      }),
    });
    if (sanitized === targetFleetId) targetIntent = loaded.intent;
  }
  return { fleets, targetIntent, targetFleetId, unknownFleets: unknownFleets.sort() };
}

export interface RunFleetLaunchOptions {
  /** `<git-common-dir>`, resolved by the caller (the shell-out stays there). */
  gitCommonDir: string;
  fleetId: string;
  taskIds: readonly string[];
  requestedConcurrency?: number;
  /**
   * Read-only bead dependency lookup for P3 ordering.
   *
   * Injected so the engine stays free of child processes; absent means "no known
   * edges", which schedules in caller order with no ordering. A failing lookup
   * must degrade to that same state (see `readDependencyGraph`).
   */
  lookupDependencies?: (taskIds: readonly string[]) => Promise<FleetDependencyGraph>;
  /** Supervisor session id, recorded in the intent and used as the audit actor. */
  sessionId: string;
  /** Fleet this session already supervises (fleet mode), so a second fleet is refused. */
  sessionFleetId?: string;
  /** Supervisor pid, so a later session can tell a live supervisor from a dead one. */
  pid: number;
  /** Supervisor process start time, so pid reuse cannot impersonate it (S1). */
  pidStartTime?: string;
  /**
   * Secret minted by this session when it arms the fleet and held only in the
   * session's memory (W6). Written into `fleet.json` so `matchesFleetSupervisor`
   * has something only the arming session could have written.
   */
  armToken: string;
  /** Injected process probes, so tests need no real pids. */
  liveness: FleetSupervisorLiveness;
  /** Clock value supplied by the caller: one timestamp per launch, deterministic in tests. */
  now: number;
  /**
   * Which decision this call is: an explicit launch, or a P4 wave advance.
   *
   * Only the audit wording and the report header change — the advance is the same
   * engine, so it cannot grow a second set of validation or capacity rules.
   */
  origin?: "launch" | "advance";
  baseBranch?: string;
  /** bd-119 ownership verdict for an existing member worktree, or undefined. */
  probeOwnership: (taskId: string) => string | undefined;
  /** The existing single-bead launch path, injected so this engine stays testable. */
  launchMember: (taskId: string) => Promise<FleetMemberLaunchOutcome>;
  fs?: FleetStateFs;
}

export interface RunFleetLaunchResult {
  /**
   * Whether the request was carried out: false for a refusal, or when every
   * member that was attempted failed. A capacity-blocked plan (nothing fits, all
   * members deferred) is true — nothing failed, the plan just waits.
   */
  ok: boolean;
  text: string;
  outcomes: readonly FleetMemberLaunchOutcome[];
  /** Non-fatal problems the caller must surface (audit/intent write failures). */
  warnings: readonly string[];
  /** True when this call re-armed an existing fleet instead of launching it fresh. */
  rearmed: boolean;
  /** P3 plan for the members this call scheduled (absent for a re-arm with no new members). */
  schedule?: FleetSchedule;
  /**
   * Sanitized fleet id this call targeted. Present so the caller arms the
   * *directory actually written*, not the raw request.
   */
  fleetId: string;
  /**
   * True when this call wrote and verified the supervisor record.
   *
   * Deliberately separate from `ok`: a launch whose members all failed still
   * armed the session (the record on disk now carries its token), while a launch
   * refused or whose record did not read back armed nothing. The caller must key
   * its in-memory arm on this, never on `ok` — clearing the arm after a failed
   * member launch disarms a session whose fleet record still names it.
   */
  armed: boolean;
}

/** Append one audit line, returning a warning instead of throwing. */
function audit(options: {
  gitCommonDir: string;
  fleetId: string;
  sessionId: string;
  now: number;
  action: string;
  taskIds: readonly string[];
  detail: string;
  fs?: FleetStateFs;
}): string | undefined {
  const appended = appendFleetAuditEntry({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    entry: {
      timestamp: options.now,
      fleetId: options.fleetId,
      actor: options.sessionId,
      action: options.action,
      taskIds: [...options.taskIds],
      detail: options.detail,
    },
  });
  if (appended.ok) return undefined;
  return `fleet ${options.fleetId}: could not append to audit.log (${appended.error})`;
}

/** Validated launch request: everything the side effects need. */
interface FleetLaunchPlan {
  fleetId: string;
  /** Members to launch now: wave 0, limited to the free capacity slots. */
  taskIds: readonly string[];
  /** Existing members preserved by a re-arm. */
  rearmedTaskIds: readonly string[];
  rearm: boolean;
  maxConcurrent: number;
  clampedFrom?: number;
  flooredFrom?: number;
  ignoredRequestedConcurrency?: number;
  supervisor: FleetSupervisorRecord;
  /** P3 plan; absent on a re-arm that adds nothing to schedule. */
  schedule?: FleetSchedule;
  /** Members this launch deferred, recorded in the intent. */
  deferred: FleetIntent["deferred"];
  /** Non-fatal problems from reading the dependency graph / scheduling input. */
  warnings: readonly string[];
}

/**
 * Orchestrators plausibly already running, counted against the same ceiling (P3).
 *
 * **Every known fleet's members count, whatever its supervisor's liveness.** A
 * detached member orchestrator keeps running after the supervisor session that
 * launched it dies, and validation keeps members disjoint across fleets, so a sum
 * is the count. Supervisor liveness deliberately qualifies only the *wording* of
 * reports, never the subtraction: counting live fleets only would under-count in
 * exactly the common recently-dead-supervisor case, and under-counting starts work
 * past the locked ceiling of 3.
 *
 * The one case this cannot see (a fleet whose intent is unreadable) is refused by
 * the caller rather than assumed to contribute zero — the unknown is escalated,
 * never guessed in the unsafe direction.
 */
export function countActiveFleetOrchestrators(options: {
  fleets: readonly FleetLaunchFleet[];
  /** Members this call is about to launch; they are not active yet. */
  launchingTaskIds: readonly string[];
}): number {
  const launching = new Set(options.launchingTaskIds);
  let active = 0;
  for (const fleet of options.fleets) {
    active += fleet.members.filter((taskId) => !launching.has(taskId)).length;
  }
  return active;
}

/**
 * Ask the scheduler to plan the validated members, or refuse the launch.
 *
 * Runs before any write: a dependency cycle is a refusal of the whole request,
 * not a partially launched fleet, so it must not be discovered after the intent
 * (or a worktree) already exists.
 */
function planLaunchSchedule(options: {
  context: FleetLaunchContext;
  taskIds: readonly string[];
  maxConcurrent: number;
  dependencyGraph: FleetDependencyGraph;
}): { ok: true; schedule?: FleetSchedule } | { ok: false; text: string } {
  // An unreadable fleet intent makes the true orchestrator count unknowable, and
  // assuming those members are gone is the unsafe direction: the ceiling of 3 is
  // the scheduling contract, so an unknown count refuses the launch instead of
  // guessing. The count is re-checked inside the intent write (see
  // `recountLaunchCapacity`).
  if (options.context.unknownFleets.length > 0) {
    return {
      ok: false,
      text:
        "Fleet launch refused; nothing was created. The orchestrator count is unknown: " +
        `${options.context.unknownFleets.length} fleet intent(s) under this repository's fleet ` +
        `root cannot be read (${options.context.unknownFleets.join(", ")}). Counting only the ` +
        "readable fleets could exceed the ceiling of 3, so fix or remove those records and " +
        "launch again.",
    };
  }
  if (options.taskIds.length === 0) return { ok: true };
  const activeCount = countActiveFleetOrchestrators({
    fleets: options.context.fleets,
    launchingTaskIds: options.taskIds,
  });
  const scheduled: FleetScheduleResult = planFleetSchedule({
    taskIds: options.taskIds,
    edges: options.dependencyGraph.edges,
    capacity: options.maxConcurrent,
    activeCount,
  });
  return scheduled.ok
    ? { ok: true, schedule: scheduled.schedule }
    : { ok: false, text: scheduled.text };
}

/**
 * The next-wave worklist an explicit advance re-schedules (P4).
 *
 * The advance decision is deliberately a *plan*, not a daemon: it reads the
 * persisted `deferred` list — which Part 0 made durable and visible — and hands it
 * to the ordinary launch engine, which re-reads bd's blocking edges, re-applies the
 * ceiling of 3, and refuses a cycle. Nothing polls: a wave advances only when the
 * operator (or a supervisor turn) asks for it.
 */
export type FleetAdvancePlan =
  | {
      ok: true;
      worklist: readonly string[];
      /** Members already launched that the deferred entries are waiting on. */
      members: readonly string[];
    }
  | { ok: false; reason: "no-intent" | "no-deferred" | "paused"; text: string };

export function planFleetAdvance(options: {
  fleetId: string;
  intent: FleetIntent | undefined;
}): FleetAdvancePlan {
  const intent = options.intent;
  if (intent === undefined) {
    return {
      ok: false,
      reason: "no-intent",
      text: `no fleet intent for \`${options.fleetId}\`; launch the fleet first`,
    };
  }
  if (intent.paused === true) {
    return {
      ok: false,
      reason: "paused",
      text:
        `fleet \`${options.fleetId}\` is paused` +
        (intent.park === undefined ? "" : ` (${intent.park.reason})`) +
        "; resume it with belayd_fleet_resume before advancing a wave",
    };
  }
  const worklist = (intent.deferred ?? []).map((entry) => entry.taskId);
  if (worklist.length === 0) {
    return {
      ok: false,
      reason: "no-deferred",
      text:
        `fleet \`${options.fleetId}\` has no deferred members; nothing to advance ` +
        "(a launch that fits within the ceiling defers nobody)",
    };
  }
  return { ok: true, worklist, members: [...intent.taskIds] };
}

/**
 * Refuse a launch into a paused fleet.
 *
 * The cooperative half of the pause contract: the flag every starting action
 * checks is written by `belayd_fleet_pause` (and by the merge's park), so a launch
 * must never be the path that quietly starts work in a stopped fleet.
 */
function pausedFleetRefusal(context: FleetLaunchContext): string | undefined {
  const intent = context.targetIntent;
  if (intent?.paused !== true) return undefined;
  const park = intent.park;
  return (
    `Fleet \`${context.targetFleetId}\` is paused` +
    (park === undefined ? "" : ` (${park.reason})`) +
    "; resume it with belayd_fleet_resume before launching more members" +
    (park === undefined ? "" : " (run belayd_fleet_reconcile first if the root work is parked)")
  );
}

/**
 * Refuse a launch whose record its own reader would reject.
 *
 * Both intent lists are bounded because the record is untrusted input to the
 * read-only view; writing an oversized one would make the fleet unreadable to
 * `belayd_fleet_status` and to the next launch, which is worse than refusing now.
 */
function intentBoundsRefusal(options: {
  context: FleetLaunchContext;
  launchingTaskIds: readonly string[];
}): string | undefined {
  const current = options.context.targetIntent;
  const membersAfter = (current?.taskIds.length ?? 0) + options.launchingTaskIds.length;
  if (membersAfter > FLEET_INTENT_MEMBERS_MAX) {
    return (
      `Fleet launch refused; nothing was created. Fleet \`${options.context.targetFleetId}\` would ` +
      `hold ${membersAfter} members, above the intent's limit of ${FLEET_INTENT_MEMBERS_MAX}. ` +
      "Split the work across fleets."
    );
  }
  // The launching ids *are* the deferred entries an advance restates, so this is
  // a set union, not a sum: a fleet with more than half the limit deferred could
  // otherwise never advance even though the list itself fits.
  const deferredAfter = new Set([
    ...(current?.deferred ?? []).map((entry) => entry.taskId),
    ...options.launchingTaskIds,
  ]).size;
  if (deferredAfter > FLEET_INTENT_DEFERRED_MAX) {
    return (
      `Fleet launch refused; nothing was created. Fleet \`${options.context.targetFleetId}\` would ` +
      `hold ${deferredAfter} waiting members, above the intent's limit of ` +
      `${FLEET_INTENT_DEFERRED_MAX}. Advance the waiting members with belayd_fleet_advance ` +
      "(a launched member leaves the deferred list), or split the work across fleets."
    );
  }
  return undefined;
}

/** Run the per-id validation with the ownership probes the caller injected. */
function validateAgainstContext(
  options: RunFleetLaunchOptions,
  context: FleetLaunchContext,
): FleetLaunchValidation {
  // A re-arm that does not restate `--concurrency` keeps the stored ceiling: the
  // operator is recovering a supervisor, not restating fleet policy.
  const requestedConcurrency = options.requestedConcurrency ?? context.targetIntent?.maxConcurrent;
  return validateFleetLaunch({
    taskIds: options.taskIds,
    fleets: context.fleets,
    targetFleetId: context.targetFleetId,
    sessionId: options.sessionId,
    ...(options.sessionFleetId === undefined ? {} : { sessionFleetId: options.sessionFleetId }),
    probes: options.taskIds.map((taskId) => {
      const ownershipError = options.probeOwnership(taskId);
      return { taskId, ...(ownershipError === undefined ? {} : { ownershipError }) };
    }),
    ...(requestedConcurrency === undefined ? {} : { requestedConcurrency }),
  });
}

/** Validate the whole request, or return the refusal text. */
function planFleetLaunch(
  options: RunFleetLaunchOptions,
  dependencyGraph: FleetDependencyGraph,
): { ok: true; plan: FleetLaunchPlan } | { ok: false; text: string } {
  const context = collectFleetLaunchContext({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    liveness: options.liveness,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  const validation = validateAgainstContext(options, context);
  if (!validation.ok) return { ok: false, text: validation.error };

  // A re-arm launches nothing (it preserves members), so it stays available while
  // paused: that is the path back to a supervised fleet. Only a request that would
  // actually start a member is refused.
  if (validation.taskIds.length > 0) {
    const paused = pausedFleetRefusal(context);
    if (paused !== undefined) return { ok: false, text: paused };
  }
  const bounds = intentBoundsRefusal({
    context,
    launchingTaskIds: validation.taskIds,
  });
  if (bounds !== undefined) return { ok: false, text: bounds };

  const scheduled = planLaunchSchedule({
    context,
    taskIds: validation.taskIds,
    maxConcurrent: validation.maxConcurrent,
    dependencyGraph,
  });
  if (!scheduled.ok) return { ok: false, text: scheduled.text };

  return {
    ok: true,
    plan: {
      fleetId: context.targetFleetId,
      // Only the wave-0 prefix the scheduler allowed is launched now; the rest is
      // deferred and reported, never silently dropped.
      taskIds: scheduled.schedule?.launchNow ?? validation.taskIds,
      rearmedTaskIds: validation.rearmedTaskIds,
      rearm: validation.rearm,
      maxConcurrent: validation.maxConcurrent,
      ...(validation.clampedFrom === undefined ? {} : { clampedFrom: validation.clampedFrom }),
      ...(validation.flooredFrom === undefined ? {} : { flooredFrom: validation.flooredFrom }),
      ...(validation.ignoredRequestedConcurrency === undefined
        ? {}
        : { ignoredRequestedConcurrency: validation.ignoredRequestedConcurrency }),
      supervisor: createFleetSupervisorRecord({
        sessionId: options.sessionId,
        pid: options.pid,
        ...(options.pidStartTime === undefined ? {} : { pidStartTime: options.pidStartTime }),
        armToken: options.armToken,
      }),
      ...(scheduled.schedule === undefined ? {} : { schedule: scheduled.schedule }),
      deferred: scheduled.schedule?.deferred.map((deferral) => ({
        taskId: deferral.taskId,
        reason: deferral.reason,
        detail: deferral.detail,
      })),
      warnings: [...dependencyGraph.warnings, ...(scheduled.schedule?.warnings ?? [])],
    },
  };
}

/**
 * Re-count the active orchestrators from a fresh read of every fleet intent.
 *
 * The plan's slots come from a context read before `bd --brief-deps` (a process
 * spawn), so another supervisor can spend those slots in that window. This recount
 * runs *inside* `updateFleetIntent`'s compare-and-replace, so the target fleet's
 * decision and write are one window; a count that no longer fits refuses the
 * launch instead of recording an over-subscribed fleet.
 */
function recountLaunchCapacity(
  options: RunFleetLaunchOptions,
  plan: FleetLaunchPlan,
): { ok: true } | { ok: false; text: string } {
  if (plan.taskIds.length === 0) return { ok: true };
  const context = collectFleetLaunchContext({
    gitCommonDir: options.gitCommonDir,
    fleetId: plan.fleetId,
    liveness: options.liveness,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  if (context.unknownFleets.length > 0) {
    return {
      ok: false,
      text:
        "Fleet launch refused; nothing was launched. The orchestrator count changed while " +
        "launching and is now unknown: " +
        `${context.unknownFleets.length} fleet intent(s) under this repository's fleet root ` +
        `cannot be read (${context.unknownFleets.join(", ")}). Fix or remove those records and ` +
        "launch again.",
    };
  }
  const activeCount = countActiveFleetOrchestrators({
    fleets: context.fleets,
    launchingTaskIds: plan.taskIds,
  });
  if (activeCount + plan.taskIds.length <= plan.maxConcurrent) return { ok: true };
  return {
    ok: false,
    text:
      "Fleet launch refused; nothing was launched. The orchestrator count changed while " +
      `launching: ${activeCount} orchestrator(s) are active and this launch would start ` +
      `${plan.taskIds.length} more, above the ceiling of ${plan.maxConcurrent}. The slots this ` +
      "launch planned were taken by a concurrent launch from another fleet; re-run it (or " +
      "belayd_fleet_advance) once a slot frees.",
  };
}

/**
 * Merge the plan into `fleet.json`, then prove the record read back as written.
 *
 * The read-back is the second half of W6: `atomicWriteJson` guarantees the write
 * was not torn, but not that it survived a concurrent writer. A supervisor that
 * cannot verify its own record is not the supervisor, so it must not claim to be.
 */
function writeLaunchIntent(
  options: RunFleetLaunchOptions,
  plan: FleetLaunchPlan,
): { ok: true } | { ok: false; text: string } {
  const written = updateFleetIntent({
    gitCommonDir: options.gitCommonDir,
    fleetId: plan.fleetId,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    update: (current) => {
      const recount = recountLaunchCapacity(options, plan);
      if (!recount.ok) return { refuse: recount.text };
      return mergeFleetIntent({
        current,
        fleetId: plan.fleetId,
        taskIds: plan.taskIds,
        now: options.now,
        maxConcurrent: plan.maxConcurrent,
        ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }),
        supervisor: plan.supervisor,
        // A launch restates the deferred plan it computed, including a plan whose
        // wave 0 is empty (all slots busy): a member-less launch that dropped
        // `deferred` would make waiting members undiscoverable. A re-arm computes
        // no plan at all (`undefined`) and keeps the one it inherited.
        ...(plan.deferred === undefined ? {} : { deferred: plan.deferred }),
      });
    },
  });
  if (!written.ok) {
    return {
      ok: false,
      text: `Could not write the fleet intent for \`${plan.fleetId}\`: ${written.error}`,
    };
  }

  const reread = readFleetIntent({
    gitCommonDir: options.gitCommonDir,
    fleetId: plan.fleetId,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  if (!reread.ok) {
    return {
      ok: false,
      text: `Wrote the fleet intent for \`${plan.fleetId}\` but could not read it back: ${reread.error}`,
    };
  }
  const recorded = reread.intent?.supervisor;
  const matches =
    recorded !== undefined &&
    recorded.sessionId === plan.supervisor.sessionId &&
    recorded.pid === plan.supervisor.pid &&
    recorded.pidStartTime === plan.supervisor.pidStartTime &&
    recorded.armToken === plan.supervisor.armToken;
  if (!matches) {
    return {
      ok: false,
      text:
        `The fleet intent for \`${plan.fleetId}\` did not read back with this session's supervisor ` +
        "record (another writer replaced it?); not claiming supervision. Re-run /fleet to re-arm.",
    };
  }
  return { ok: true };
}

/**
 * Launch every planned member, auditing each outcome.
 *
 * One member failing never aborts the rest: the outcome is recorded per member
 * and the loop continues, which is the documented failure semantics.
 */
async function launchAllMembers(
  options: RunFleetLaunchOptions,
  plan: FleetLaunchPlan,
): Promise<{ outcomes: FleetMemberLaunchOutcome[]; warnings: string[] }> {
  const outcomes: FleetMemberLaunchOutcome[] = [];
  const warnings: string[] = [];
  for (const taskId of plan.taskIds) {
    const outcome = await options.launchMember(taskId);
    outcomes.push(outcome);
    const memberAudit = audit({
      gitCommonDir: options.gitCommonDir,
      fleetId: plan.fleetId,
      sessionId: options.sessionId,
      now: options.now,
      action: outcome.ok ? "member-launch" : "member-launch-failed",
      taskIds: [taskId],
      detail: outcome.detail,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
    if (memberAudit !== undefined) warnings.push(memberAudit);
  }
  return { outcomes, warnings };
}

/**
 * Remove failed members from the intent so they are retryable, never phantom.
 *
 * The rewrite is a cross-tree mutation, so it is audited (`member-pruned`) like
 * every other one; the audit failure is returned as a warning instead of being
 * swallowed.
 */
function pruneFailedMembers(
  options: RunFleetLaunchOptions,
  plan: FleetLaunchPlan,
  failed: readonly string[],
): string[] {
  if (failed.length === 0) return [];
  const pruned = updateFleetIntent({
    gitCommonDir: options.gitCommonDir,
    fleetId: plan.fleetId,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    update: (current) =>
      current === undefined
        ? mergeFleetIntent({
            current: undefined,
            fleetId: plan.fleetId,
            taskIds: [],
            now: options.now,
            maxConcurrent: plan.maxConcurrent,
            supervisor: plan.supervisor,
          })
        : {
            ...current,
            taskIds: current.taskIds.filter((taskId) => !failed.includes(taskId)),
            updatedAt: options.now,
          },
  });

  const warnings: string[] = [];
  if (!pruned.ok) {
    warnings.push(
      `fleet ${plan.fleetId}: could not clear failed members from the intent (${pruned.error}); ` +
        `${failed.join(", ")} may still look like members`,
    );
    return warnings;
  }
  const prunedAudit = audit({
    gitCommonDir: options.gitCommonDir,
    fleetId: plan.fleetId,
    sessionId: options.sessionId,
    now: options.now,
    action: "member-pruned",
    taskIds: [...failed],
    detail: "failed launches removed from the fleet intent so they are retryable",
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  if (prunedAudit !== undefined) warnings.push(prunedAudit);
  return warnings;
}

/** Audit the re-arm of an existing fleet (a cross-tree intent write). */
function auditReArm(options: RunFleetLaunchOptions, plan: FleetLaunchPlan): string | undefined {
  if (!plan.rearm) return undefined;
  return audit({
    gitCommonDir: options.gitCommonDir,
    fleetId: plan.fleetId,
    sessionId: options.sessionId,
    now: options.now,
    action: "re-arm",
    taskIds: [...plan.rearmedTaskIds, ...plan.taskIds],
    detail:
      "supervisor record rewritten for a fleet whose supervisor was not running; " +
      `${plan.rearmedTaskIds.length} member(s) preserved`,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
}

/** Audit the launch request itself (one line per call, before any member starts). */
function auditLaunchRequest(
  options: RunFleetLaunchOptions,
  plan: FleetLaunchPlan,
): string | undefined {
  if (plan.taskIds.length === 0) return undefined;
  const clamped = plan.clampedFrom === undefined ? "" : ` (clamped from ${plan.clampedFrom})`;
  const base = options.baseBranch === undefined ? "" : ` base ${options.baseBranch}`;
  const advance = options.origin === "advance";
  return audit({
    gitCommonDir: options.gitCommonDir,
    fleetId: plan.fleetId,
    sessionId: options.sessionId,
    now: options.now,
    action: advance ? "advance" : "launch",
    taskIds: plan.taskIds,
    detail:
      (advance ? "advanced from the persisted deferred worklist; " : "") +
      `maxConcurrent ${plan.maxConcurrent}${clamped}${base}`,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
}

/**
 * Audit the P3 plan and every deferral.
 *
 * `schedule-planned` records the whole decision (waves, slots); each deferred
 * member gets its own line so a member that never started is never invisible in
 * the history. A capacity deferral is distinguished from a dependency one because
 * they call for different operator actions.
 */
function auditSchedule(options: RunFleetLaunchOptions, plan: FleetLaunchPlan): string[] {
  const schedule = plan.schedule;
  if (schedule === undefined) return [];
  const warnings: string[] = [];
  const plannedAudit = audit({
    gitCommonDir: options.gitCommonDir,
    fleetId: plan.fleetId,
    sessionId: options.sessionId,
    now: options.now,
    action: "schedule-planned",
    taskIds: [...schedule.launchNow, ...schedule.deferred.map((deferral) => deferral.taskId)],
    detail:
      `wave 0: ${schedule.waves.find((wave) => wave.index === 0)?.taskIds.join(", ") || "(none)"}; ` +
      `${schedule.waves.length} wave(s); capacity ${schedule.capacity}, active ` +
      `${schedule.activeCount}, slots ${schedule.slots}`,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  if (plannedAudit !== undefined) warnings.push(plannedAudit);

  for (const deferral of schedule.deferred) {
    const deferralAudit = audit({
      gitCommonDir: options.gitCommonDir,
      fleetId: plan.fleetId,
      sessionId: options.sessionId,
      now: options.now,
      action: deferral.reason === "capacity" ? "capacity-blocked" : "member-deferred",
      taskIds: [deferral.taskId],
      detail: `${deferral.reason}: ${deferral.detail}`,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
    if (deferralAudit !== undefined) warnings.push(deferralAudit);
  }
  return warnings;
}

/** Render input for the plan, so the engine body stays a short orchestration. */
function reportInput(
  plan: FleetLaunchPlan,
  outcomes: readonly FleetMemberLaunchOutcome[],
): FormatFleetLaunchReportInput {
  return {
    fleetId: plan.fleetId,
    maxConcurrent: plan.maxConcurrent,
    ...(plan.clampedFrom === undefined ? {} : { clampedFrom: plan.clampedFrom }),
    ...(plan.flooredFrom === undefined ? {} : { flooredFrom: plan.flooredFrom }),
    ...(plan.ignoredRequestedConcurrency === undefined
      ? {}
      : { ignoredRequestedConcurrency: plan.ignoredRequestedConcurrency }),
    outcomes,
    rearmedTaskIds: plan.rearmedTaskIds,
    rearm: plan.rearm,
    ...(plan.schedule === undefined ? {} : { schedule: plan.schedule }),
  };
}

/**
 * Read the dependency graph, degrading to "no known edges" on any failure.
 *
 * An unreadable graph must never crash a launch or invent an edge: the members
 * are still launchable, just without ordering, and the caller is told.
 */
async function readDependencyGraph(options: RunFleetLaunchOptions): Promise<FleetDependencyGraph> {
  const lookup = options.lookupDependencies;
  if (lookup === undefined) return { edges: [], warnings: [] };
  try {
    return await lookup(options.taskIds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      edges: [],
      warnings: [
        `bead dependency graph unavailable (${detail}); scheduling in the order given, without ` +
          "dependency ordering",
      ],
    };
  }
}

/**
 * The one launch engine behind \`/fleet\` and \`belayd_fleet_launch\`.
 *
 * Order is validate -> write intent -> launch -> prune:
 *
 * 1. **Validate.** Every id is checked (valid, not duplicated, not already a
 *    member of a live fleet, no worktree owned by another bead) before anything
 *    is created, so a refused request leaves no fleet directory, worktree, or
 *    session behind. A member of this fleet whose supervisor is dead is a
 *    *re-arm*: preserved, not relaunched.
 * 2. **Schedule.** The validated ids are ordered by bd's blocking edges and cut to
 *    the free capacity (`capacity - already active`). Wave 0 up to that limit
 *    launches now; the rest is recorded in the intent as deferred, with the
 *    reason, and reported. A dependency cycle refuses the launch outright.
 * 3. **Write the intent, then read it back.** A member finds its mailbox by task
 *    id, so the record must exist before the first member session starts — and a
 *    record that did not survive a concurrent writer is not a supervision claim.
 * 4. **Launch.** Each new member goes through the existing single-bead path; a
 *    failure is caught per member so the rest still proceed.
 * 5. **Prune.** A member that failed is removed from the intent — reported and
 *    audited, never silently dropped, and still retryable — so
 *    \`belayd_fleet_status\` does not report a phantom member forever.
 *
 * Every cross-tree action (the intent write, a re-arm, the schedule, each launch
 * attempt, each deferral, the prune) is appended to \`audit.log\`. Nothing here
 * merges, pauses, or mutates a bead, and no wave is advanced automatically.
 */
export async function runFleetLaunch(
  options: RunFleetLaunchOptions,
): Promise<RunFleetLaunchResult> {
  const targetFleetId = sanitizeFleetId(options.fleetId);
  const dependencyGraph = await readDependencyGraph(options);
  const planned = planFleetLaunch(options, dependencyGraph);
  if (!planned.ok) {
    return {
      ok: false,
      text: planned.text,
      outcomes: [],
      warnings: [...dependencyGraph.warnings],
      rearmed: false,
      fleetId: targetFleetId,
      armed: false,
    };
  }
  const plan = planned.plan;

  const written = writeLaunchIntent(options, plan);
  if (!written.ok) {
    return {
      ok: false,
      text: written.text,
      outcomes: [],
      warnings: [],
      rearmed: false,
      fleetId: plan.fleetId,
      armed: false,
    };
  }

  const warnings: string[] = [...plan.warnings];
  for (const auditWarning of [
    auditReArm(options, plan),
    ...auditSchedule(options, plan),
    auditLaunchRequest(options, plan),
  ]) {
    if (auditWarning !== undefined) warnings.push(auditWarning);
  }

  const launched = await launchAllMembers(options, plan);
  warnings.push(...launched.warnings);
  warnings.push(
    ...pruneFailedMembers(
      options,
      plan,
      launched.outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.taskId),
    ),
  );

  const launchedAnything = launched.outcomes.some((outcome) => outcome.ok);
  // A launch whose plan was to wait is not a failure: every slot was busy, so
  // nothing started and every member is recorded as deferred. It is reported as
  // a success like the drain's `no-queued-entry`, while a member that was
  // *attempted* and failed still fails the call.
  const plannedToWait = plan.taskIds.length === 0 && (plan.deferred?.length ?? 0) > 0;
  return {
    ok: launchedAnything || plannedToWait || (plan.rearm && plan.rearmedTaskIds.length > 0),
    text: formatFleetLaunchReport(reportInput(plan, launched.outcomes)),
    outcomes: launched.outcomes,
    warnings,
    rearmed: plan.rearm,
    fleetId: plan.fleetId,
    armed: true,
    ...(plan.schedule === undefined ? {} : { schedule: plan.schedule }),
  };
}
