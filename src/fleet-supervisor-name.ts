/**
 * The display name a fleet supervisor session carries.
 *
 * A supervisor is an ordinary chat session that holds the fleet's supervisor
 * record and drives the run loop. Nothing about it says "fleet" in the UI, so the
 * operator who started a fleet 14 hours ago cannot tell which of 238 sessions is
 * still ticking, and the member worktrees it drives live in other pi-web
 * workspaces. Naming the session after the members it supervises makes the
 * supervisor identifiable in pi-web's sidebar and in `pi --resume`, without
 * adding a second surface that can disagree with `fleet.json`.
 *
 * The name is derived, never stored: membership lives in the intent, so a rename
 * on every launch/advance/resume cannot drift from the fleet it describes.
 *
 * Splitting it out keeps the formatting pure and testable — the extension only has
 * to decide *when* to apply it.
 */

import type { FleetRun } from "./fleet-run.js";
import { isFleetRunActive } from "./fleet-run.js";
import { DEFAULT_FLEET_ID } from "./fleet-status.js";

/** Human-readable prefix; the whole name stays greppable as "Fleet supervisor". */
export const FLEET_SUPERVISOR_NAME_PREFIX = "Fleet supervisor";

/**
 * pi-web rejects an explicit `name` on session creation beyond 60 characters
 * (`requireInitialSessionName`), and a sidebar row longer than that is ellipsized
 * anyway. Renaming in-extension is not capped by the API, so the cap is ours.
 */
export const FLEET_SUPERVISOR_NAME_MAX_LENGTH = 60;

export interface FleetSupervisorNameInput {
  fleetId: string;
  /** Intent membership: launched members, and (post-bd-156) stopped ones too. */
  taskIds: readonly string[];
  /** Members the run launched — a subset of `taskIds`, kept for older intents. */
  memberTaskIds?: readonly string[];
  /** Members planned but not launched yet: they are part of the plan to supervise. */
  deferredTaskIds?: readonly string[];
  /**
   * Run status to append, e.g. `partial`. Absent while the run is active, so the
   * name of a live supervisor carries no stale verdict.
   */
  status?: string;
}

/**
 * The status a finished run contributes to the name, or undefined while active.
 *
 * A cooperative pause deliberately keeps its name: `belayd_fleet_resume` restarts
 * the same run, and a "(paused)" title would outlive the pause that produced it.
 */
export function supervisorRunStatus(run: FleetRun | undefined): string | undefined {
  if (run === undefined) return undefined;
  if (run.outcome !== undefined) return run.outcome;
  if (run.haltedReason !== undefined) return "halted";
  return isFleetRunActive(run) ? undefined : "finished";
}

/** Members to name, in plan order, deduplicated. */
export function collectSupervisorTaskIds(input: FleetSupervisorNameInput): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...input.taskIds,
    ...(input.memberTaskIds ?? []),
    ...(input.deferredTaskIds ?? []),
  ]) {
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * `Fleet supervisor: bd-150, bd-151` / `Fleet supervisor (merge): bd-150`.
 *
 * A non-default fleet carries its id because a repository can host several, and
 * two identically named supervisors would be indistinguishable.
 */
export function computeFleetSupervisorName(input: FleetSupervisorNameInput): string {
  const label =
    input.fleetId === DEFAULT_FLEET_ID
      ? FLEET_SUPERVISOR_NAME_PREFIX
      : `${FLEET_SUPERVISOR_NAME_PREFIX} (${input.fleetId})`;
  const tail = input.status === undefined || input.status === "" ? "" : ` (${input.status})`;
  return formatName(label, collectSupervisorTaskIds(input), tail);
}

/**
 * Fit the member list into the cap by dropping ids from the end.
 *
 * Truncation keeps a count ("+2 more") instead of silently shortening the list:
 * a supervisor named after three of five members would misreport the fleet.
 */
function formatName(label: string, ids: readonly string[], tail: string): string {
  if (ids.length === 0) return `${label}${tail}`;
  const full = `${label}: ${ids.join(", ")}${tail}`;
  if (full.length <= FLEET_SUPERVISOR_NAME_MAX_LENGTH) return full;
  // Keep at least one member: a bare "+5 more" says nothing about which fleet.
  for (let kept = ids.length - 1; kept >= 1; kept -= 1) {
    const listed = ids.slice(0, kept).join(", ");
    const name = `${label}: ${listed} +${ids.length - kept} more${tail}`;
    if (name.length <= FLEET_SUPERVISOR_NAME_MAX_LENGTH) return name;
  }
  return `${label} +${ids.length} more${tail}`;
}
