/**
 * Unit tests for the supervisor session name.
 *
 * Two things must hold: the name always identifies the fleet from its members, and
 * it never exceeds the 60 characters pi-web accepts for an explicit session name —
 * a truncated-at-the-server name would silently name the wrong members.
 */

import { describe, expect, it } from "vitest";
import type { FleetRun } from "../fleet-run.js";
import {
  collectSupervisorTaskIds,
  computeFleetSupervisorName,
  FLEET_SUPERVISOR_NAME_MAX_LENGTH,
  supervisorRunStatus,
} from "../fleet-supervisor-name.js";

function run(overrides: Partial<FleetRun> = {}): FleetRun {
  return {
    schemaVersion: 1,
    mode: "until-complete",
    startedAt: 1_000,
    updatedAt: 2_000,
    ticks: 3,
    ...overrides,
  };
}

describe("computeFleetSupervisorName", () => {
  it("lists the members of the default fleet", () => {
    expect(
      computeFleetSupervisorName({
        fleetId: "default",
        taskIds: ["bd-150", "bd-151", "bd-152", "bd-153"],
      }),
    ).toBe("Fleet supervisor: bd-150, bd-151, bd-152, bd-153");
  });

  it("names a non-default fleet by id so two supervisors stay distinguishable", () => {
    expect(computeFleetSupervisorName({ fleetId: "merge", taskIds: ["bd-12"] })).toBe(
      "Fleet supervisor (merge): bd-12",
    );
  });

  it("appends the run status when the run is no longer active", () => {
    expect(
      computeFleetSupervisorName({
        fleetId: "default",
        taskIds: ["bd-150", "bd-153"],
        status: "partial",
      }),
    ).toBe("Fleet supervisor: bd-150, bd-153 (partial)");
  });

  it("names a supervisor with no members yet from its fleet alone", () => {
    expect(computeFleetSupervisorName({ fleetId: "default", taskIds: [] })).toBe(
      "Fleet supervisor",
    );
    expect(computeFleetSupervisorName({ fleetId: "merge", taskIds: [], status: "complete" })).toBe(
      "Fleet supervisor (merge) (complete)",
    );
  });

  it("keeps deferred members: they are part of the plan being supervised", () => {
    expect(
      computeFleetSupervisorName({
        fleetId: "default",
        taskIds: ["bd-150"],
        deferredTaskIds: ["bd-152", "bd-153"],
      }),
    ).toBe("Fleet supervisor: bd-150, bd-152, bd-153");
  });

  it("unions run members into older intents that pruned a stopped member", () => {
    expect(
      computeFleetSupervisorName({
        fleetId: "default",
        taskIds: ["bd-151"],
        memberTaskIds: ["bd-150", "bd-151"],
      }),
    ).toBe("Fleet supervisor: bd-151, bd-150");
  });

  it("deduplicates ids that appear in more than one list", () => {
    expect(
      computeFleetSupervisorName({
        fleetId: "default",
        taskIds: ["bd-150", "bd-150"],
        memberTaskIds: ["bd-150"],
        deferredTaskIds: ["bd-150"],
      }),
    ).toBe("Fleet supervisor: bd-150");
  });

  it("reports how many members did not fit rather than dropping them silently", () => {
    const name = computeFleetSupervisorName({
      fleetId: "default",
      taskIds: ["bd-150", "bd-151", "bd-152", "bd-153", "bd-154", "bd-155", "bd-156"],
    });
    expect(name.length).toBeLessThanOrEqual(FLEET_SUPERVISOR_NAME_MAX_LENGTH);
    expect(name).toMatch(/^Fleet supervisor: bd-150/);
    expect(name).toMatch(/ \+\d+ more$/u);
  });

  it("still caps the name when the status suffix consumes the budget", () => {
    const name = computeFleetSupervisorName({
      fleetId: "default",
      taskIds: ["bd-150", "bd-151", "bd-152", "bd-153", "bd-154"],
      status: "partial",
    });
    expect(name.length).toBeLessThanOrEqual(FLEET_SUPERVISOR_NAME_MAX_LENGTH);
    expect(name.endsWith(" (partial)")).toBe(true);
  });
});

describe("collectSupervisorTaskIds", () => {
  it("keeps plan order and skips empty ids", () => {
    expect(
      collectSupervisorTaskIds({
        fleetId: "default",
        taskIds: ["bd-2", "", "bd-1"],
        deferredTaskIds: ["bd-3"],
      }),
    ).toEqual(["bd-2", "bd-1", "bd-3"]);
  });
});

describe("supervisorRunStatus", () => {
  it("has no status for an active run", () => {
    expect(supervisorRunStatus(run())).toBeUndefined();
    expect(supervisorRunStatus(undefined)).toBeUndefined();
  });

  it("carries the outcome of a finished run", () => {
    expect(supervisorRunStatus(run({ finishedAt: 5_000, outcome: "partial" }))).toBe("partial");
    expect(supervisorRunStatus(run({ finishedAt: 5_000, outcome: "complete" }))).toBe("complete");
  });

  it("marks a halted run, which has no outcome", () => {
    expect(supervisorRunStatus(run({ haltedReason: "parked: root is dirty" }))).toBe("halted");
  });

  it("keeps a paused run looking active, because a resume reuses the run", () => {
    expect(supervisorRunStatus(run({ haltedReason: undefined, ticks: 9 }))).toBeUndefined();
  });
});
