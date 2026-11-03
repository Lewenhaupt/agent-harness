/**
 * Direct tests for the fleet tick's per-member observation fan-out (bd-219).
 *
 * The tick derives progress, stall accounting and the human-wait cap from
 * `observations`, and every consumer assumes exactly one entry per `taskIds`
 * member in the caller's order. That contract is easy to break silently when the
 * fan-out is bounded, so it is pinned here rather than through a live tick: the
 * observer below performs a real `lookupOpenHumanGate` read against a stubbed bd
 * runner, so the gate read is part of what is being ordered and bounded.
 */

import { describe, expect, it } from "vitest";

import { readMemberObservationsBounded } from "../../extensions/capabilities/fleet.js";
import { lookupOpenHumanGate } from "../bead-gates.js";
import type { FleetMemberObservation } from "../fleet-run.js";

/** Members past the module's read concurrency, so the pool is genuinely exercised. */
const TASK_IDS = ["bd-11", "bd-12", "bd-13", "bd-14", "bd-15", "bd-16", "bd-17"];
/** The one member whose bead has an open human gate in the stubbed read. */
const OPEN_BEAD = "bd-14";

/** bd's open human gate, as `bd gate list <bead> --json` renders it. */
const OPEN_GATE = JSON.stringify([
  {
    id: "gate-1",
    status: "open",
    issue_type: "gate",
    await_type: "human",
    created_at: "2026-11-01T10:00:00Z",
  },
]);

const NO_GATE = JSON.stringify([]);

/** A per-call delay so overlap (and therefore the bound) is observable. */
const READ_DELAY_MS = 5;

interface FanOutState {
  inFlight: number;
  maxInFlight: number;
  readOrder: string[];
}

async function observeWithStubbedGateRead(
  taskId: string,
  state: FanOutState,
): Promise<FleetMemberObservation> {
  state.inFlight += 1;
  state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
  try {
    await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
    const lookup = await lookupOpenHumanGate({
      beadId: taskId,
      cwd: "/repo",
      runBd: async (argv) => {
        state.readOrder.push(taskId);
        // `gate list <bead> --json`: the bead is the second argv entry.
        return { stdout: argv.includes(OPEN_BEAD) ? OPEN_GATE : NO_GATE };
      },
    });
    return {
      taskId,
      progress: { kind: "running", detail: "implement", key: "phases:2/5" },
      claim: "live",
      humanGateOpen: lookup.ok && lookup.status === "open",
    };
  } finally {
    state.inFlight -= 1;
  }
}

describe("readMemberObservationsBounded", () => {
  it("returns one observation per task id, in order, with bounded concurrency", async () => {
    const state: FanOutState = { inFlight: 0, maxInFlight: 0, readOrder: [] };

    const observations = await readMemberObservationsBounded({
      taskIds: TASK_IDS,
      observe: (taskId) => observeWithStubbedGateRead(taskId, state),
    });

    // One entry per member, in the caller's order: progress comparison, the stall
    // key and the "still in flight" list all index straight into this array.
    expect(observations.map((observation) => observation.taskId)).toEqual(TASK_IDS);
    expect(new Set(state.readOrder)).toEqual(new Set(TASK_IDS));
    expect(state.readOrder).toHaveLength(TASK_IDS.length);
    // 7 members, 4 at a time: the bound holds and the fan-out is really concurrent.
    expect(state.maxInFlight).toBeGreaterThan(1);
    expect(state.maxInFlight).toBeLessThanOrEqual(4);

    // The stubbed gate read landed on the member it belongs to, not on a neighbour.
    expect(
      observations
        .filter((observation) => observation.humanGateOpen)
        .map((observation) => observation.taskId),
    ).toEqual([OPEN_BEAD]);
  });

  it("returns no observations and reads nothing for an empty member list", async () => {
    const read: string[] = [];
    const observations = await readMemberObservationsBounded({
      taskIds: [],
      observe: async (taskId) => {
        read.push(taskId);
        return {
          taskId,
          progress: { kind: "missing", detail: "no workflow state" },
          claim: "absent",
          humanGateOpen: false,
        };
      },
    });
    expect(observations).toEqual([]);
    expect(read).toEqual([]);
  });
});
