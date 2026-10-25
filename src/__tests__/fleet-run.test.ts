/**
 * Unit tests for the fleet run loop's decision layer (bd-126 P5).
 *
 * `planFleetTick` is the whole contract of "run until complete": one pure decision
 * per tick, in a fixed order, that never invents progress. These cases pin that
 * order (land before stop before advance), the stop reasons (a member that needs a
 * human is stopped, never relaunched), and the run record's idempotence.
 */

import { describe, expect, it } from "vitest";
import type {
  FleetMemberObservation,
  FleetMemberProgress,
  FleetRun,
  FleetWorkflowProgressSnapshot,
} from "../fleet-run.js";
import {
  deriveFleetMemberProgress,
  FLEET_RUN_MAX_IDLE_TICKS,
  FLEET_RUN_START_GRACE_MS,
  finishFleetRun,
  formatFleetRunLine,
  formatFleetRunStops,
  isFleetRunActive,
  planFleetTick,
  recordRunMemberLanded,
  recordRunMemberLaunched,
  recordRunMemberStopped,
  recordRunTick,
  startFleetRun,
} from "../fleet-run.js";
import type { FleetIntent } from "../fleet-status.js";
import type { RunManifest } from "../run-manifest.js";
import { RunStatus } from "../run-manifest.js";

const PHASES = ["plan", "implement", "review", "test", "commit"];

function run(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    runId: overrides.runId ?? "run-1",
    taskId: "bd-12",
    phase: "implement",
    sessionName: "belayd-bd-12-sub-implement-run-1",
    status: RunStatus.Completed,
    startedAt: 1_000,
    completedAt: 2_000,
    ...overrides,
  };
}

function workflow(
  overrides: Partial<Extract<FleetWorkflowProgressSnapshot, { kind: "ok" }>> = {},
): Extract<FleetWorkflowProgressSnapshot, { kind: "ok" }> {
  return {
    kind: "ok",
    completedPhaseNames: ["plan"],
    phaseOrder: PHASES,
    awaitingReviewResponse: false,
    ...overrides,
  };
}

describe("deriveFleetMemberProgress", () => {
  it("reports a run in flight before anything the state file says", () => {
    const progress = deriveFleetMemberProgress({
      workflow: workflow({ completedPhaseNames: [...PHASES] }),
      runs: [run({ status: RunStatus.Running, runId: "live" })],
      now: 5_000,
    });
    expect(progress).toMatchObject({ kind: "running", detail: "phase run in flight: implement" });
  });

  it("reports an interrupted run as needing a human", () => {
    const progress = deriveFleetMemberProgress({
      workflow: workflow(),
      runs: [run({ status: RunStatus.Interrupted })],
      now: 5_000,
    });
    expect(progress.kind).toBe("phase-interrupted");
  });

  it("is complete when every phase in the phase order finished", () => {
    const progress = deriveFleetMemberProgress({
      workflow: workflow({ completedPhaseNames: [...PHASES] }),
      runs: [],
      now: 5_000,
    });
    expect(progress).toEqual({ kind: "complete" });
  });

  it("is awaiting-human while a review response is pending", () => {
    const progress = deriveFleetMemberProgress({
      workflow: workflow({ awaitingReviewResponse: true }),
      runs: [],
      now: 5_000,
    });
    expect(progress.kind).toBe("awaiting-human");
  });

  it("reports a failed pending phase", () => {
    const progress = deriveFleetMemberProgress({
      workflow: workflow({ completedPhaseNames: ["plan", "implement"] }),
      runs: [run({ phase: "review", status: RunStatus.Failed, failureReason: "gate failed" })],
      now: 5_000,
    });
    expect(progress).toMatchObject({
      kind: "phase-failed",
      detail: "phase review failed: gate failed",
    });
  });

  it("treats a missing state file plus a completed final phase as finished work", () => {
    const progress = deriveFleetMemberProgress({
      workflow: { kind: "missing" },
      runs: [run({ phase: "commit", status: RunStatus.Completed })],
      now: 5_000,
    });
    expect(progress).toEqual({ kind: "complete" });
  });

  it("reports a missing member only after the start grace", () => {
    const withinGrace = deriveFleetMemberProgress({
      workflow: { kind: "missing" },
      runs: [],
      now: 1_500,
      launchedAt: 1_000,
    });
    expect(withinGrace.kind).toBe("starting");

    const pastGrace = deriveFleetMemberProgress({
      workflow: { kind: "missing" },
      runs: [],
      now: 1_000 + FLEET_RUN_START_GRACE_MS + 1,
      launchedAt: 1_000,
    });
    expect(pastGrace.kind).toBe("missing");
  });

  it("reports unreadable state as corrupt, not as missing", () => {
    const progress = deriveFleetMemberProgress({
      workflow: { kind: "corrupt" },
      runs: [],
      now: 5_000,
    });
    expect(progress.kind).toBe("state-corrupt");
  });
});

function intent(overrides: Partial<FleetIntent> = {}): FleetIntent {
  return {
    schemaVersion: 1,
    fleetId: "default",
    taskIds: ["bd-12", "bd-15"],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function observation(
  taskId: string,
  progress: FleetMemberProgress,
  claim: FleetMemberObservation["claim"] = "live",
  launchedAt?: number,
): FleetMemberObservation {
  return { taskId, progress, claim, ...(launchedAt === undefined ? {} : { launchedAt }) };
}

describe("planFleetTick", () => {
  it("halts a paused or parked fleet instead of starting work", () => {
    expect(
      planFleetTick({
        intent: intent({ paused: true, note: "stepping away" }),
        observations: [],
        now: 5_000,
      }),
    ).toMatchObject({ kind: "halt", reason: "paused", detail: "stepping away" });

    expect(
      planFleetTick({
        intent: intent({ park: { reason: "stash conflict", recordedAt: 1_000 } }),
        observations: [],
        now: 5_000,
      }),
    ).toMatchObject({ kind: "halt", reason: "parked" });
  });

  it("lands a finished member before doing anything else", () => {
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12", "bd-15"] }),
      observations: [
        observation("bd-12", { kind: "complete" }),
        observation("bd-15", { kind: "awaiting-human", detail: "review" }),
      ],
      now: 5_000,
    });
    expect(action).toEqual({ kind: "land", taskId: "bd-12" });
  });

  it("stops a member that needs a human, with the reason carried through", () => {
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"] }),
      observations: [observation("bd-12", { kind: "phase-failed", detail: "gate failed" })],
      now: 5_000,
    });
    expect(action).toEqual({
      kind: "stop",
      taskId: "bd-12",
      reason: "phase-failed",
      detail: "gate failed",
    });
  });

  it("waits while a member is working under a live lease", () => {
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"] }),
      observations: [observation("bd-12", { kind: "running", detail: "2/5" }, "live", 1_000)],
      now: 5_000,
    });
    expect(action.kind).toBe("wait");
  });

  it("stops a member whose orchestrator is gone once the start grace has passed", () => {
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"] }),
      observations: [
        observation("bd-12", { kind: "running", detail: "2/5 phases complete" }, "absent", 1_000),
      ],
      now: 1_000 + FLEET_RUN_START_GRACE_MS + 1,
    });
    expect(action).toMatchObject({
      kind: "stop",
      taskId: "bd-12",
      reason: "orchestrator-missing",
    });
  });

  it("does not declare a just-launched member missing", () => {
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"] }),
      observations: [
        observation("bd-12", { kind: "starting", detail: "just launched" }, "absent", 1_000),
      ],
      now: 1_500,
    });
    expect(action.kind).toBe("wait");
  });

  it("advances when nothing is left to land or stop and members are deferred", () => {
    const action = planFleetTick({
      intent: intent({
        taskIds: [],
        deferred: [{ taskId: "bd-19", reason: "dependency", detail: "waits for bd-12" }],
      }),
      observations: [],
      now: 5_000,
    });
    expect(action).toEqual({ kind: "advance" });
  });

  it("completes when every member landed, and reports a partial run when one stopped", () => {
    expect(
      planFleetTick({ intent: intent({ taskIds: [] }), observations: [], now: 5_000 }),
    ).toMatchObject({ kind: "complete", outcome: "complete" });

    const run0 = recordRunMemberStopped({
      run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
      taskId: "bd-12",
      reason: "phase-failed",
      detail: "gate failed",
      now: 2_000,
    });
    expect(
      planFleetTick({
        intent: intent({ taskIds: [], run: run0 }),
        observations: [],
        now: 5_000,
      }),
    ).toMatchObject({ kind: "complete", outcome: "partial" });
  });

  it("stops the loop when nothing has progressed for too long", () => {
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"] }),
      observations: [observation("bd-12", { kind: "running", detail: "2/5" })],
      now: 5_000,
      idleTicks: FLEET_RUN_MAX_IDLE_TICKS,
    });
    expect(action).toMatchObject({ kind: "halt", reason: "stalled" });
  });

  it("skips members the run already stopped", () => {
    const run0 = recordRunMemberStopped({
      run: startFleetRun({
        now: 1_000,
        accept: true,
        members: [{ taskId: "bd-12" }, { taskId: "bd-15" }],
      }),
      taskId: "bd-12",
      reason: "phase-failed",
      detail: "gate failed",
      now: 2_000,
    });
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12", "bd-15"], run: run0 }),
      observations: [
        observation("bd-12", { kind: "phase-failed", detail: "gate failed" }),
        observation("bd-15", { kind: "complete" }),
      ],
      now: 5_000,
    });
    expect(action).toEqual({ kind: "land", taskId: "bd-15" });
  });
});

describe("run record", () => {
  it("starts a run with one member record per launched member", () => {
    const started = startFleetRun({
      now: 1_000,
      accept: true,
      members: [{ taskId: "bd-12", sessionId: "s-1" }, { taskId: "bd-15" }],
    });
    expect(started).toMatchObject({ mode: "until-complete", ticks: 0, accept: true });
    expect(started.members).toEqual([
      { taskId: "bd-12", launchedAt: 1_000, sessionId: "s-1" },
      { taskId: "bd-15", launchedAt: 1_000 },
    ]);
    expect(isFleetRunActive(started)).toBe(true);
  });

  it("adds a member launched by a later wave and clears any earlier stop", () => {
    const stopped = recordRunMemberStopped({
      run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
      taskId: "bd-15",
      reason: "land-failed",
      detail: "conflict",
      now: 2_000,
    });
    const launched = recordRunMemberLaunched({
      run: stopped,
      taskId: "bd-15",
      launchedAt: 3_000,
      sessionId: "s-2",
    });
    expect(launched.members?.map((member) => member.taskId)).toEqual(["bd-12", "bd-15"]);
    expect(launched.stopped).toEqual([]);
  });

  it("records a landed member idempotently", () => {
    const started = startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] });
    const once = recordRunMemberLanded({ run: started, taskId: "bd-12", now: 2_000 });
    const twice = recordRunMemberLanded({ run: once, taskId: "bd-12", now: 3_000 });
    expect(twice.members).toHaveLength(1);
    expect(twice.members?.[0]?.landedAt).toBe(3_000);
  });

  it("counts ticks and resets the idle counter on progress", () => {
    const started = startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] });
    const idle = recordRunTick({ run: started, now: 2_000, progressed: false });
    expect(idle).toMatchObject({ ticks: 1, idleTicks: 1 });
    const acted = recordRunTick({ run: idle, now: 3_000, progressed: true });
    expect(acted).toMatchObject({ ticks: 2, idleTicks: 0 });
  });

  it("finishes a run so no later tick resumes it", () => {
    const started = startFleetRun({ now: 1_000, accept: true, members: [] });
    const finished = finishFleetRun({ run: started, now: 2_000, outcome: "complete" });
    expect(finished).toMatchObject({ outcome: "complete", finishedAt: 2_000 });
    expect(isFleetRunActive(finished)).toBe(false);
  });
});

describe("rendering", () => {
  it("renders a run line without a clock, so two reads are byte-identical", () => {
    const started = startFleetRun({ now: 1_000, accept: true, members: [] });
    expect(formatFleetRunLine(started)).toBe(
      "run: until-complete — 0 tick(s), last tick 1970-01-01T00:00:01.000Z",
    );
    expect(formatFleetRunLine(undefined)).toBeUndefined();
  });

  it("renders a halted and a finished run", () => {
    const started = startFleetRun({ now: 1_000, accept: true, members: [] });
    expect(formatFleetRunLine({ ...started, haltedReason: "paused: stepping away" })).toContain(
      "halted: paused: stepping away",
    );
    expect(
      formatFleetRunLine({ ...started, finishedAt: 2_000, outcome: "partial", ticks: 4 }),
    ).toBe("run: until-complete — partial at 1970-01-01T00:00:02.000Z (4 tick(s))");
  });

  it("lists stopped members one per line", () => {
    const stopped: FleetRun = recordRunMemberStopped({
      run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
      taskId: "bd-12",
      reason: "orchestrator-missing",
      detail: "no lease",
      now: 2_000,
    });
    expect(formatFleetRunStops(stopped)).toEqual([
      "stopped bd-12 (orchestrator-missing): no lease",
    ]);
  });
});
