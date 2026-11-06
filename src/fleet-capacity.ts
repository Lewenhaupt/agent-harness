/**
 * Fleet capacity arithmetic (bd-166).
 *
 * The repository has one ceiling of concurrent orchestrators, shared by every
 * fleet under `<git-common-dir>/belayd/fleet/*`. This module is the one place that
 * decides whether a *recorded* member still consumes one of those slots, so the
 * number a launch enforces and the number `belayd_fleet_status` prints can never
 * drift apart.
 *
 * The rule is evidence-first:
 *
 * - `live` holds a slot (an orchestrator is running, whatever the record says);
 * - `unknown` holds a slot too, because a missing or unreadable probe is not proof
 *   that nothing is running, and starting work past the ceiling is the unsafe
 *   direction;
 * - `absent` does not, which is what stops a bead merged by hand, or a member
 *   stopped awaiting a human, from holding a slot forever;
 * - `released` does not, and is the explicit operator/terminal-run statement of the
 *   same fact.
 *
 * None of this removes anything from `taskIds`: the member keeps its bead,
 * worktree, transcript, and mailbox until it lands.
 */

import type { FleetMemberLiveness } from "./fleet-sessions.js";

/** Locked concurrency ceiling: concurrent orchestrators, not total agents. */
export const FLEET_MAX_CONCURRENT_ORCHESTRATORS = 3;

/** How a fleet's supervisor looks, as far as this arithmetic cares. */
export type FleetCapacitySupervisor = "live" | "dead" | "none";

export interface FleetCapacityMember {
  taskId: string;
  liveness: FleetMemberLiveness;
  /** The run stopped this member; its session is gone but its bead/worktree stay. */
  stopped?: boolean;
  /** An operator, a terminal run, or a landing explicitly gave this member's slot back. */
  released?: boolean;
  /**
   * The fleet's run recorded this member landing (bd-168).
   *
   * A landing is proof the work is on the base branch, so the member cannot be
   * running any more and holds no slot — even when a stale worktree is still on
   * disk and its liveness probe cannot classify it.
   */
  landed?: boolean;
}

export interface FleetCapacityFleet {
  fleetId: string;
  members: readonly FleetCapacityMember[];
  supervisor: FleetCapacitySupervisor;
}

/** Per-fleet rollup: the line `belayd_fleet_status` prints for one fleet. */
export interface FleetCapacityContributor {
  fleetId: string;
  members: number;
  live: number;
  unknown: number;
  absent: number;
  stopped: number;
  /** Explicitly released members that have not also recorded a landing. */
  released: number;
  /** Members whose run recorded landing; a separate population from a release. */
  landed: number;
  /** Members that actually hold a slot (live or unknown, and neither released nor landed). */
  counted: number;
  supervisor: FleetCapacitySupervisor;
}

export interface FleetCapacityArithmetic {
  ceiling: number;
  /** Slots held right now. */
  counted: number;
  free: number;
  contributors: readonly FleetCapacityContributor[];
}

/**
 * Whether one recorded member still holds a slot.
 *
 * Exported so the launch count and the status view share the predicate instead of
 * restating the rule twice; `released` is checked first because it is an explicit
 * decision that outranks a stale liveness probe.
 */
export function memberHoldsCapacity(member: FleetCapacityMember): boolean {
  if (member.released === true || member.landed === true) return false;
  return member.liveness.kind !== "absent";
}

function contributorOf(
  fleet: FleetCapacityFleet,
  launching: ReadonlySet<string>,
): FleetCapacityContributor {
  const counts = {
    fleetId: fleet.fleetId,
    members: fleet.members.length,
    live: 0,
    unknown: 0,
    absent: 0,
    stopped: 0,
    released: 0,
    landed: 0,
    counted: 0,
    supervisor: fleet.supervisor,
  };
  for (const member of fleet.members) {
    if (launching.has(member.taskId)) continue;
    addMemberCounts(counts, member);
  }
  return counts;
}

/** Add one member's classification to a fleet's rollup. */
function addMemberCounts(counts: FleetCapacityContributor, member: FleetCapacityMember): void {
  switch (member.liveness.kind) {
    case "live":
      counts.live += 1;
      break;
    case "unknown":
      counts.unknown += 1;
      break;
    case "absent":
      counts.absent += 1;
      break;
  }
  if (member.stopped === true) counts.stopped += 1;
  // Landed and explicitly-released members are different populations: a landing is
  // proof the work is on the base branch, a release is an operator/run decision. A
  // member with both (a drain also writes a `merged` release) is reported as landed
  // only, so the summary never counts one member twice (bd-168 S4).
  if (member.landed === true) counts.landed += 1;
  else if (member.released === true) counts.released += 1;
  if (memberHoldsCapacity(member)) counts.counted += 1;
}

/**
 * The whole repository's arithmetic: ceiling, held slots, free slots, per fleet.
 *
 * `launchingTaskIds` are excluded because they do not hold a slot *yet*: the plan
 * counts them separately against `maxConcurrent`.
 */
export function describeFleetCapacity(options: {
  ceiling: number;
  fleets: readonly FleetCapacityFleet[];
  launchingTaskIds?: readonly string[];
}): FleetCapacityArithmetic {
  const launching = new Set(options.launchingTaskIds ?? []);
  const contributors = options.fleets.map((fleet) => contributorOf(fleet, launching));
  const counted = contributors.reduce((sum, contributor) => sum + contributor.counted, 0);
  return {
    ceiling: options.ceiling,
    counted,
    free: Math.max(0, options.ceiling - counted),
    contributors,
  };
}
