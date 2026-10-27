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
  FleetTickAction,
  FleetWorkflowProgressSnapshot,
} from "../fleet-run.js";
import {
  deriveFleetMemberProgress,
  emptyAdvanceAction,
  FLEET_RUN_GATE_NOTICE_IDS_MAX,
  FLEET_RUN_MAX_IDLE_TICKS,
  FLEET_RUN_START_GRACE_MS,
  finishFleetRun,
  formatFleetRunLine,
  formatFleetRunStops,
  isFleetRunActive,
  memberEvidenceCutoff,
  memberRanEvidence,
  planFleetTick,
  planGateNotices,
  planOutsideFleetLandings,
  recordFleetGateNotices,
  recordRunMemberLanded,
  recordRunMemberLaunched,
  recordRunMemberStopped,
  recordRunTick,
  releaseRunMembers,
  runsBelongingToMember,
  startFleetRun,
  worktreeCreatedAtFromStat,
} from "../fleet-run.js";
import type { FleetIntent } from "../fleet-status.js";
import type { RunManifest } from "../run-manifest.js";
import { RunStatus } from "../run-manifest.js";

const PHASES = ["plan", "implement", "review", "test", "commit"];

/** The fleet member these cases observe; run manifests of other tasks are not its evidence. */
const MEMBER = "bd-12";

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
      taskId: MEMBER,
      workflow: workflow({ completedPhaseNames: [...PHASES] }),
      runs: [run({ status: RunStatus.Running, runId: "live" })],
      now: 5_000,
    });
    expect(progress).toMatchObject({ kind: "running", detail: "phase run in flight: implement" });
  });

  it("reports an interrupted run as needing a human", () => {
    const progress = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: workflow(),
      runs: [run({ status: RunStatus.Interrupted })],
      now: 5_000,
      // A launch the run cannot predate is what attributes this failure to this
      // execution; without it the same-task manifest may be a copied older run.
      launchedAt: 900,
    });
    expect(progress.kind).toBe("phase-interrupted");
  });

  it("is complete when every phase in the phase order finished", () => {
    const progress = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: workflow({ completedPhaseNames: [...PHASES] }),
      runs: [],
      now: 5_000,
    });
    expect(progress).toEqual({ kind: "complete" });
  });

  it("is awaiting-human while a review response is pending", () => {
    const progress = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: workflow({ awaitingReviewResponse: true }),
      runs: [],
      now: 5_000,
    });
    expect(progress.kind).toBe("awaiting-human");
  });

  it("reports a failed pending phase", () => {
    const progress = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: workflow({ completedPhaseNames: ["plan", "implement"] }),
      runs: [run({ phase: "review", status: RunStatus.Failed, failureReason: "gate failed" })],
      now: 5_000,
      launchedAt: 900,
    });
    expect(progress).toMatchObject({
      kind: "phase-failed",
      detail: "phase review failed: gate failed",
    });
  });

  it("treats a missing state file plus a completed final phase as finished work", () => {
    const progress = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: { kind: "missing" },
      runs: [run({ phase: "commit", status: RunStatus.Completed })],
      now: 5_000,
    });
    expect(progress).toEqual({ kind: "complete" });
  });

  it("keeps deriving complete from its own final phase among another task's manifests", () => {
    const progress = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: { kind: "missing" },
      runs: [
        run({ runId: "own-commit", phase: "commit", status: RunStatus.Completed }),
        // Committed `.belayd/runs` entries for other beads (bd-146): newer, and
        // the newest manifest is what an unfiltered missing-state read follows.
        run({ runId: "bd16-scout", taskId: "bd-16", phase: "scout", startedAt: 3_000 }),
        run({ runId: "bd83-test", taskId: "bd-83", phase: "test", startedAt: 3_100 }),
        run({
          runId: "bd83-implement",
          taskId: "bd-83",
          phase: "implement",
          status: RunStatus.Failed,
          startedAt: 3_200,
        }),
      ],
      now: 5_000,
    });
    expect(progress).toEqual({ kind: "complete" });
  });

  it("reports a missing member only after the start grace", () => {
    const withinGrace = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: { kind: "missing" },
      runs: [],
      now: 1_500,
      launchedAt: 1_000,
    });
    expect(withinGrace.kind).toBe("starting");

    const pastGrace = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: { kind: "missing" },
      runs: [],
      now: 1_000 + FLEET_RUN_START_GRACE_MS + 1,
      launchedAt: 1_000,
    });
    expect(pastGrace.kind).toBe("missing");
  });

  it("reports unreadable state as corrupt, not as missing", () => {
    const progress = deriveFleetMemberProgress({
      taskId: MEMBER,
      workflow: { kind: "corrupt" },
      runs: [],
      now: 5_000,
    });
    expect(progress.kind).toBe("state-corrupt");
  });

  // bd-161: `.belayd/` is gitignored and copied into every new worktree, so the
  // primary checkout's failed bd-37 implement run (no failureReason) appeared in
  // each fresh member worktree (bd-12 here) and stopped it as `phase implement
  // failed` while it was still scouting.
  describe("run manifests inherited from the primary checkout", () => {
    const inherited: RunManifest = {
      schemaVersion: 1,
      runId: "mthosemh",
      taskId: "bd-37",
      phase: "implement",
      sessionName: "belayd-bd-37-sub-implement-mthosemh",
      status: RunStatus.Failed,
      startedAt: 1_788_207_858_953,
      completedAt: 1_788_208_222_826,
      exitCode: 143,
    };

    it("ignores another task's failed run and keeps the member starting", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: { kind: "missing" },
        runs: [inherited],
        now: 1_000 + 1,
        launchedAt: 1_000,
      });
      expect(progress.kind).toBe("starting");
    });

    it("does not revive another task's failed run after the start grace", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: { kind: "missing" },
        runs: [inherited],
        now: 1_000 + FLEET_RUN_START_GRACE_MS + 1,
        launchedAt: 1_000,
      });
      // No own run exists yet, so the honest reading is "nothing here", never a
      // failure borrowed from another bead.
      expect(progress).toMatchObject({ kind: "missing" });
    });

    it("ignores another task's failed run when no launch time is known", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: { kind: "missing" },
        runs: [inherited],
        now: 1_788_208_222_826 + 1,
      });
      // This branch rests on the task id alone, so it has to be enough on its own.
      expect(progress).toMatchObject({ kind: "missing" });
    });

    it("ignores this task's own manifest that predates the launch", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: { kind: "missing" },
        runs: [run({ status: RunStatus.Failed, startedAt: 500, completedAt: 600 })],
        now: 1_500,
        launchedAt: 1_000,
      });
      expect(progress.kind).toBe("starting");
    });

    it("does not borrow a same-task failure when no launch time is known", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: { kind: "missing" },
        runs: [run({ status: RunStatus.Failed, startedAt: 500, completedAt: 600 })],
        now: 5_000,
      });
      // The operator ran the task in the primary checkout before fleeting it into
      // this worktree. With no launch time the failure cannot be attributed to
      // this execution, so the non-fatal verdict wins instead of a false stop.
      expect(progress).toMatchObject({ kind: "missing" });
    });

    it("does not borrow a same-task interrupted run when no launch time is known", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: workflow(),
        runs: [run({ status: RunStatus.Interrupted, startedAt: 500, completedAt: 600 })],
        now: 5_000,
      });
      // An interrupted copy is the same shape as a failed one: without a launch
      // time it may be the previous execution, so it cannot demand a human.
      expect(progress).toMatchObject({ kind: "running" });
    });

    it("keeps a same-task run in flight even when it predates the launch", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: { kind: "missing" },
        runs: [run({ status: RunStatus.Running, startedAt: 500 })],
        now: 1_500,
        launchedAt: 1_000,
      });
      // A live run proves an execution is happening now; dropping it would make
      // the member `missing` and stop a healthy one as orchestrator-missing.
      expect(progress).toMatchObject({
        kind: "running",
        detail: "phase run in flight: implement",
      });
    });

    it("still reports the member's own failed run", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: { kind: "missing" },
        runs: [run({ status: RunStatus.Failed, startedAt: 1_200 })],
        now: 1_500,
        launchedAt: 1_000,
      });
      expect(progress).toMatchObject({
        kind: "phase-failed",
        detail: "phase implement failed",
      });
    });

    it("ignores another task's run that is still in flight", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: { kind: "missing" },
        runs: [run({ taskId: "bd-37", status: RunStatus.Running, startedAt: 1_200 })],
        now: 1_000 + FLEET_RUN_START_GRACE_MS + 1,
        launchedAt: 1_000,
      });
      // The in-flight bypass is scoped to this member's own runs: another bead's
      // live manifest would otherwise read as this worktree's execution.
      expect(progress).toMatchObject({ kind: "missing" });
    });

    it("still reports the member's own failed pending phase next to an inherited run", () => {
      const progress = deriveFleetMemberProgress({
        taskId: MEMBER,
        workflow: workflow({ completedPhaseNames: ["plan"] }),
        runs: [inherited, run({ phase: "implement", status: RunStatus.Failed, startedAt: 1_200 })],
        now: 1_500,
        launchedAt: 1_000,
      });
      expect(progress).toMatchObject({
        kind: "phase-failed",
        detail: "phase implement failed",
      });
    });
  });
});

describe("runsBelongingToMember", () => {
  it("drops every manifest of another task, whatever its status", () => {
    const foreign = [
      run({ taskId: "bd-37", status: RunStatus.Running }),
      run({ taskId: "bd-37", status: RunStatus.Failed }),
      run({ taskId: "bd-37", status: RunStatus.Completed }),
    ];
    expect(runsBelongingToMember({ taskId: MEMBER, runs: foreign, launchedAt: 1_000 })).toEqual([]);
  });

  it("keeps a run that started exactly at the launch instant", () => {
    const atLaunch = run({ status: RunStatus.Completed, startedAt: 1_000 });
    // The boundary matters: the supervisor and the member read the clock
    // independently, so equality has to count as the member's own work.
    expect(runsBelongingToMember({ taskId: MEMBER, runs: [atLaunch], launchedAt: 1_000 })).toEqual([
      atLaunch,
    ]);
  });

  it("drops this task's own completed run from before the launch", () => {
    const preLaunch = run({ status: RunStatus.Completed, startedAt: 999 });
    // A copied final-phase completion would otherwise mark a fresh execution as
    // finished the moment it starts.
    expect(runsBelongingToMember({ taskId: MEMBER, runs: [preLaunch], launchedAt: 1_000 })).toEqual(
      [],
    );
  });

  it("keeps a pre-launch completed run when no launch time is known", () => {
    const preLaunch = run({ status: RunStatus.Completed, startedAt: 999 });
    // Only terminal failures need launch proof. Completion carries no stop
    // verdict, so with no launch time it stays visible (matching the file truth).
    expect(runsBelongingToMember({ taskId: MEMBER, runs: [preLaunch] })).toEqual([preLaunch]);
  });

  it("keeps a pre-launch failure when the caller does not require a launch", () => {
    const preLaunch = run({ status: RunStatus.Failed, startedAt: 999 });
    // The policy is opt-in: `fleet-status` without a run record reports files as
    // read, and only the stop decision refuses unattributed failures.
    expect(
      runsBelongingToMember({ taskId: MEMBER, runs: [preLaunch], failuresRequireLaunch: false }),
    ).toEqual([preLaunch]);
  });
});

describe("memberRanEvidence (bd-166)", () => {
  it("counts a workflow state file as proof the member ran", () => {
    // A live member: the launch persisted state, so absence means gone.
    expect(memberRanEvidence({ taskId: MEMBER, workflowStatePresent: true, runs: [] })).toBe(true);
  });

  it("counts a same-task manifest this execution wrote, with no state file", () => {
    // The completion shape: `clearWorkflowState` deletes the state file, and the
    // manifests stay. Keying on the state file alone counted a finished member
    // forever, which is the leak this test pins.
    expect(
      memberRanEvidence({
        taskId: MEMBER,
        workflowStatePresent: false,
        runs: [run({ taskId: MEMBER, status: RunStatus.Completed, startedAt: 2_000 })],
        since: 1_000,
      }),
    ).toBe(true);
  });

  it("rejects a same-task manifest older than the cutoff (the inherited case)", () => {
    // `.belayd/` is copied into a new worktree, so a re-launched bd-12 inherits its
    // own earlier run from the primary checkout. It names the task but predates the
    // tree that holds it, so it proves nothing about the spawn in flight.
    expect(
      memberRanEvidence({
        taskId: MEMBER,
        workflowStatePresent: false,
        runs: [run({ taskId: MEMBER, status: RunStatus.Completed, startedAt: 999 })],
        since: 1_000,
      }),
    ).toBe(false);
  });

  it("never guesses when no cutoff is available", () => {
    // A manifest that only names the task cannot be attributed to this execution.
    expect(
      memberRanEvidence({
        taskId: MEMBER,
        workflowStatePresent: false,
        runs: [run({ taskId: MEMBER, status: RunStatus.Completed })],
      }),
    ).toBe(false);
  });

  it("counts a running same-task manifest even before the cutoff", () => {
    // `runsBelongingToMember` keeps a live run regardless of the launch cut: an
    // execution is happening now, so the member is real whatever the clock says.
    expect(
      memberRanEvidence({
        taskId: MEMBER,
        workflowStatePresent: false,
        runs: [run({ taskId: MEMBER, status: RunStatus.Running, startedAt: 999 })],
        since: 1_000,
      }),
    ).toBe(true);
  });

  it("reports no evidence for a bare worktree with no manifests", () => {
    // The spawn-in-flight shape: the worktree exists, nothing has run in it yet.
    expect(memberRanEvidence({ taskId: MEMBER, workflowStatePresent: false, runs: [] })).toBe(
      false,
    );
  });

  it("does not treat an inherited manifest of another task as this member's evidence", () => {
    // bd-161: `.belayd/` is copied into a new worktree, so another bead's run is
    // present from the first second. It must not free this member's slot.
    expect(
      memberRanEvidence({
        taskId: MEMBER,
        workflowStatePresent: false,
        runs: [run({ taskId: "bd-37", status: RunStatus.Completed })],
        since: 1_000,
      }),
    ).toBe(false);
  });
});

describe("memberEvidenceCutoff (bd-166)", () => {
  it("takes the later of the worktree creation instant and the recorded launch", () => {
    expect(memberEvidenceCutoff({ worktreeCreatedAt: 1_000, launchedAt: 3_000 })).toBe(3_000);
    expect(memberEvidenceCutoff({ worktreeCreatedAt: 3_000, launchedAt: 1_000 })).toBe(3_000);
  });

  it("falls back to whichever instant exists", () => {
    expect(memberEvidenceCutoff({ worktreeCreatedAt: 1_000 })).toBe(1_000);
    expect(memberEvidenceCutoff({ launchedAt: 2_000 })).toBe(2_000);
  });

  it("returns no cutoff when nothing is known", () => {
    // No cutoff means manifests are not evidence: the conservative direction.
    expect(memberEvidenceCutoff({})).toBeUndefined();
  });
});

describe("worktreeCreatedAtFromStat (bd-166)", () => {
  it("prefers the birth time when it is the earlier one", () => {
    expect(worktreeCreatedAtFromStat({ birthtimeMs: 1_000, mtimeMs: 2_000 })).toBe(1_000);
  });

  it("takes the earlier time, because a directory's mtime only moves later", () => {
    // A restored/rewritten tree can report a birth time after its mtime; using the
    // earlier one keeps the cutoff from sliding past this member's own manifests.
    expect(worktreeCreatedAtFromStat({ birthtimeMs: 2_000, mtimeMs: 1_000 })).toBe(1_000);
  });

  it("falls back to the mtime when the filesystem cannot report a birth time", () => {
    // Some filesystems report birthtimeMs 0; a directory's mtime never moves
    // backwards, so it still cannot postdate an inherited manifest into evidence.
    expect(worktreeCreatedAtFromStat({ birthtimeMs: 0, mtimeMs: 2_000 })).toBe(2_000);
  });

  it("returns undefined when neither time is usable", () => {
    expect(worktreeCreatedAtFromStat({ birthtimeMs: 0, mtimeMs: 0 })).toBeUndefined();
    expect(worktreeCreatedAtFromStat({})).toBeUndefined();
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

/** A single-member run that already stopped its member for a failed phase. */
function stopRun(options: { taskId: string }): FleetRun {
  return recordRunMemberStopped({
    run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: options.taskId }] }),
    taskId: options.taskId,
    reason: "phase-failed",
    detail: "gate failed",
    now: 2_000,
  });
}

/** A run that already stopped every member for a failed phase. */
function stoppedRun(taskIds: readonly string[]): FleetRun {
  return taskIds.reduce<FleetRun>(
    (acc, taskId) =>
      recordRunMemberStopped({
        run: acc,
        taskId,
        reason: "phase-failed",
        detail: "gate failed",
        now: 2_000,
      }),
    startFleetRun({
      now: 1_000,
      accept: true,
      members: taskIds.map((taskId) => ({ taskId })),
    }),
  );
}

/** The detail line of an action; empty when it carries none (land/advance). */
function detailOf(action: FleetTickAction): string {
  return "detail" in action ? action.detail : "";
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

  it("waits on a missing member while a live lease holds its worktree", () => {
    // Phase files are copies that can be stale or inherited (bd-161); only the
    // lease proves an execution owns the worktree, so a wrong `missing` must not
    // stop a healthy member.
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"] }),
      observations: [observation("bd-12", { kind: "missing", detail: "no state" }, "live")],
      now: 5_000,
    });
    expect(action.kind).toBe("wait");
  });

  it("stops a missing member once no lease holds it", () => {
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"] }),
      observations: [observation("bd-12", { kind: "missing", detail: "no state" }, "absent")],
      now: 5_000,
    });
    expect(action).toMatchObject({
      kind: "stop",
      taskId: "bd-12",
      reason: "orchestrator-missing",
    });
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

  it("lands a stopped member whose own retry finished the work", () => {
    const run0 = recordRunMemberStopped({
      run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
      taskId: "bd-12",
      reason: "phase-failed",
      detail: "gate failed",
      now: 2_000,
    });
    // The member stayed in the fleet after the stop, so the loop still observes it
    // and must land the work its retry finished instead of stranding the branch.
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"], run: run0 }),
      observations: [observation("bd-12", { kind: "complete" })],
      now: 5_000,
    });
    expect(action).toEqual({ kind: "land", taskId: "bd-12" });
  });

  it("never retries a member stopped by a land attempt", () => {
    const run0 = recordRunMemberStopped({
      run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
      taskId: "bd-12",
      reason: "land-failed",
      detail: "rebase conflict",
      now: 2_000,
    });
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"], run: run0 }),
      observations: [observation("bd-12", { kind: "complete" })],
      now: 5_000,
    });
    expect(action).toMatchObject({ kind: "complete", outcome: "partial" });
  });

  it("does not land a member the run already landed", () => {
    const landed = recordRunMemberLanded({
      run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
      taskId: "bd-12",
      now: 2_000,
    });
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"], run: landed }),
      observations: [observation("bd-12", { kind: "complete" })],
      now: 5_000,
    });
    expect(action.kind).not.toBe("land");
  });

  it("keeps the run open while a stopped member's retry is alive (single-member fleet)", () => {
    // The stop tick must not be the run's last tick: the retry may still deliver
    // work, and a finished run can never be resumed.
    const stopped = stopRun({ taskId: "bd-12" });
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"], run: stopped }),
      observations: [observation("bd-12", { kind: "running", detail: "2/5" }, "live")],
      now: 5_000,
    });
    expect(action).toMatchObject({ kind: "wait" });
  });

  it("completes partial once a stopped member's retry has no live lease", () => {
    // The phase files may still say `running`; without a lease nothing is running
    // the work, and waiting would hold the run and its capacity slots forever.
    const stopped = stopRun({ taskId: "bd-12" });
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"], run: stopped }),
      observations: [observation("bd-12", { kind: "running", detail: "2/5" }, "absent")],
      now: 5_000,
    });
    expect(action).toMatchObject({ kind: "complete", outcome: "partial" });
  });

  it("bounds the wait for a stopped retry with the idle cap", () => {
    const stopped = stopRun({ taskId: "bd-12" });
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"], run: stopped }),
      observations: [observation("bd-12", { kind: "running", detail: "2/5" }, "live")],
      now: 5_000,
      idleTicks: FLEET_RUN_MAX_IDLE_TICKS,
    });
    expect(action).toMatchObject({ kind: "halt", reason: "stalled" });
  });

  it("never waits on a stopped member a land attempt gave up on", () => {
    const stopped = recordRunMemberStopped({
      run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
      taskId: "bd-12",
      reason: "land-failed",
      detail: "rebase conflict",
      now: 2_000,
    });
    const action = planFleetTick({
      intent: intent({ taskIds: ["bd-12"], run: stopped }),
      observations: [observation("bd-12", { kind: "running", detail: "2/5" }, "live")],
      now: 5_000,
    });
    expect(action).toMatchObject({ kind: "complete", outcome: "partial" });
  });

  it("lands a stopped retry that finished, then completes the run", () => {
    const stopped = stopRun({ taskId: "bd-12" });
    const land = planFleetTick({
      intent: intent({ taskIds: ["bd-12"], run: stopped }),
      observations: [observation("bd-12", { kind: "complete" })],
      now: 5_000,
    });
    expect(land).toEqual({ kind: "land", taskId: "bd-12" });

    // What the landing tick does: merge, prune the member, record the landing.
    const landed = recordRunMemberLanded({ run: stopped, taskId: "bd-12", now: 6_000 });
    const after = planFleetTick({
      intent: intent({ taskIds: [], run: landed }),
      observations: [],
      now: 7_000,
    });
    expect(after).toMatchObject({ kind: "complete", outcome: "complete" });
  });
});

describe("emptyAdvanceAction", () => {
  const deferred: NonNullable<FleetIntent["deferred"]> = [
    { taskId: "bd-152", reason: "external-blocker", detail: "waits on bd-100" },
    { taskId: "bd-153", reason: "dependency", detail: "waits on bd-152" },
  ];

  it("completes partial and names every deferred member with its reason", () => {
    const stopped = stoppedRun(["bd-148", "bd-149"]);
    const action = emptyAdvanceAction({
      intent: intent({ taskIds: ["bd-148", "bd-149"], run: stopped, deferred }),
    });
    expect(action).toMatchObject({ kind: "complete", outcome: "partial" });
    expect(detailOf(action)).toContain("bd-152 (external-blocker)");
    expect(detailOf(action)).toContain("bd-153 (dependency)");
    expect(detailOf(action)).toContain("2 member(s) need a human: bd-148, bd-149");
  });

  it("waits when capacity is what re-deferred the wave", () => {
    const action = emptyAdvanceAction({
      intent: intent({
        taskIds: [],
        deferred: [
          { taskId: "bd-152", reason: "capacity", detail: "4/4 slots are busy" },
          { taskId: "bd-153", reason: "capacity", detail: "4/4 slots are busy" },
        ],
      }),
    });
    // Capacity is held by another fleet and frees itself, so this must not end the run.
    expect(action.kind).toBe("wait");
    expect(detailOf(action)).toContain("bd-152 (capacity)");
    expect(detailOf(action)).toContain("bd-153 (capacity)");
    expect(detailOf(action)).toContain("capacity");
  });

  it("waits on a mixed list, because capacity can still free", () => {
    const action = emptyAdvanceAction({
      intent: intent({
        taskIds: [],
        deferred: [
          { taskId: "bd-152", reason: "capacity", detail: "4/4 slots are busy" },
          { taskId: "bd-153", reason: "dependency", detail: "waits for bd-152" },
        ],
      }),
    });
    expect(action.kind).toBe("wait");
  });

  it("completes a run with nothing deferred and nothing stopped", () => {
    const action = emptyAdvanceAction({ intent: intent({ taskIds: [] }) });
    expect(action).toMatchObject({
      kind: "complete",
      outcome: "complete",
      detail: "nothing launched",
    });
  });

  it("includes the plan's refusal text in the terminal line", () => {
    const action = emptyAdvanceAction({
      intent: intent({ taskIds: [], deferred }),
      reason: "the fleet is paused",
    });
    expect(action.kind).toBe("complete");
    expect(detailOf(action)).toContain("the fleet is paused");
  });

  it("completes after a refusal, even when the deferrals name capacity", () => {
    // A refusal means the plan will not advance at all, so capacity freed elsewhere
    // cannot help; waiting would re-ask the same refused plan every tick.
    const action = emptyAdvanceAction({
      intent: intent({
        taskIds: [],
        deferred: [{ taskId: "bd-152", reason: "capacity", detail: "4/4 slots are busy" }],
      }),
      reason: "no deferred work",
      refused: true,
    });
    expect(action.kind).toBe("complete");
  });

  it("tells the operator that a refused wave is still recoverable", () => {
    // The recount race the engine reports frees itself once another fleet's slot
    // frees, so the terminal line must not read like an unplannable wave.
    const action = emptyAdvanceAction({
      intent: intent({ taskIds: [], deferred }),
      reason: "no free slot; re-run it once a slot frees",
      refused: true,
    });
    const detail = detailOf(action);
    expect(action).toMatchObject({ kind: "complete", outcome: "partial" });
    expect(detail).toContain("no free slot; re-run it once a slot frees");
    expect(detail).toContain("belayd_fleet_advance or a fresh launch");
    expect(detail.endsWith("or a fresh launch")).toBe(true);
  });

  it("keeps the recoverable clause inside the bound for a long refusal", () => {
    const action = emptyAdvanceAction({
      intent: intent({ taskIds: [], deferred }),
      reason:
        "Fleet launch refused; nothing was launched. The orchestrator count changed while " +
        "launching: 3 orchestrator(s) are active and this launch would start 1 more, above the " +
        "ceiling of 3. The slots this launch planned were taken by a concurrent launch from " +
        "another fleet; re-run it (or belayd_fleet_advance) once a slot frees.",
      refused: true,
    });
    const detail = detailOf(action);
    expect(detail.length).toBeLessThanOrEqual(400);
    // Truncation eats the engine's tail first, never the actionable clause.
    expect(detail.endsWith("or a fresh launch")).toBe(true);
    expect(detail).toContain("Fleet launch refused");
  });

  it("classifies from the fresh deferrals the advance left behind", () => {
    const action = emptyAdvanceAction({
      intent: intent({
        taskIds: [],
        deferred: [{ taskId: "bd-152", reason: "dependency", detail: "stale plan" }],
      }),
      deferred: [{ taskId: "bd-152", reason: "capacity", detail: "4/4 slots are busy" }],
    });
    expect(action.kind).toBe("wait");
  });

  it("bounds a long deferred list to one audit-sized line", () => {
    const action = emptyAdvanceAction({
      intent: intent({
        taskIds: [],
        deferred: Array.from({ length: 20 }, (_, index) => ({
          taskId: `bd-${200 + index}`,
          reason: "dependency" as const,
          detail: "waits for a sibling",
        })),
      }),
    });
    expect(action).toMatchObject({ kind: "complete", outcome: "partial" });
    expect(detailOf(action).length).toBeLessThanOrEqual(400);
    expect(detailOf(action)).toContain("+12 more");
  });

  it("keeps the deferred member names when both lists are long", () => {
    // The durable record is the 400-char detail, so a long stop list must not eat
    // the deferral names the bug's single audit line has to name.
    const action = emptyAdvanceAction({
      intent: intent({
        taskIds: [],
        run: stoppedRun(Array.from({ length: 20 }, (_, index) => `bd-${100 + index}`)),
        deferred: Array.from({ length: 20 }, (_, index) => ({
          taskId: `bd-${index}`,
          reason: "dependency" as const,
          detail: "waits for a sibling",
        })),
      }),
      reason:
        "the advance refused the whole wave after re-reading the dependency graph: " +
        "every blocker of every deferred member is still open and none of them is a member " +
        "of this fleet, so no wave can be planned until an operator closes one of those beads",
    });
    const detail = detailOf(action);
    expect(action).toMatchObject({ kind: "complete", outcome: "partial" });
    expect(detail.length).toBeLessThanOrEqual(400);
    expect(detail).toContain("bd-0 (dependency)");
    expect(detail).toContain("+12 more");
    // Cuts land on a part boundary, so no id or reason is left half-written.
    expect(detail).toMatch(/more$|\)$/u);
    expect((detail.match(/\(/gu) ?? []).length).toBe((detail.match(/\)/gu) ?? []).length);
  });

  it("halts a capacity wait at the idle cap instead of re-planning forever", () => {
    // Nothing is in flight on this path, so the plan's own stall cap can never fire:
    // the capacity wait must carry the cap itself or it loops until the process dies.
    const capacity = [
      { taskId: "bd-152", reason: "capacity" as const, detail: "4/4 slots are busy" },
      { taskId: "bd-153", reason: "capacity" as const, detail: "4/4 slots are busy" },
    ];
    const belowCap = emptyAdvanceAction({
      intent: intent({ taskIds: [], deferred: capacity }),
      idleTicks: FLEET_RUN_MAX_IDLE_TICKS - 1,
    });
    expect(belowCap.kind).toBe("wait");

    const atCap = emptyAdvanceAction({
      intent: intent({ taskIds: [], deferred: capacity }),
      idleTicks: FLEET_RUN_MAX_IDLE_TICKS,
    });
    expect(atCap).toMatchObject({ kind: "halt", reason: "stalled" });
    expect(detailOf(atCap)).toContain("bd-152 (capacity)");
    expect(detailOf(atCap)).toContain("bd-153 (capacity)");
    expect(detailOf(atCap)).toContain(`${FLEET_RUN_MAX_IDLE_TICKS} ticks`);
  });

  it("ends a stopped-everything run on the second tick, not the 240th", () => {
    // The observed bug: every member stopped, the deferred wave unplannable, and
    // planFleetTick advancing on every tick until the idle cap stalled the run.
    const stopped = stoppedRun(["bd-148", "bd-149"]);
    const base = intent({ taskIds: ["bd-148", "bd-149"], run: stopped, deferred });
    expect(planFleetTick({ intent: base, observations: [], now: 5_000 })).toEqual({
      kind: "advance",
    });

    const action = emptyAdvanceAction({ intent: base });
    expect(action).toMatchObject({ kind: "complete", outcome: "partial" });

    // What the executor does with that action: finish the run, then tick it once.
    const finished = finishFleetRun({ run: stopped, now: 5_000, outcome: "partial" });
    const ticked = recordRunTick({ run: finished, now: 5_000, progressed: true });
    expect(ticked.idleTicks).toBe(0);
    expect(isFleetRunActive(ticked)).toBe(false);
  });

  it("keeps a real launch as progress and waits on the member afterwards", () => {
    const launched = recordRunMemberLaunched({
      run: startFleetRun({ now: 1_000, accept: true, members: [] }),
      taskId: "bd-12",
      launchedAt: 2_000,
    });
    const ticked = recordRunTick({ run: launched, now: 2_500, progressed: true });
    expect(ticked.idleTicks).toBe(0);

    const next = planFleetTick({
      intent: intent({ taskIds: ["bd-12"], run: ticked }),
      observations: [observation("bd-12", { kind: "running", detail: "2/5" }, "live", 2_000)],
      now: 3_000,
    });
    expect(next).toMatchObject({ kind: "wait" });
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

  it("clears a stop record once the member lands", () => {
    const stopped = recordRunMemberStopped({
      run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
      taskId: "bd-12",
      reason: "phase-failed",
      detail: "gate failed",
      now: 2_000,
    });
    const landed = recordRunMemberLanded({ run: stopped, taskId: "bd-12", now: 3_000 });
    expect(landed.stopped).toEqual([]);
    expect(landed.members?.[0]).toMatchObject({ taskId: "bd-12", landedAt: 3_000 });
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

describe("gate notices", () => {
  it("shows a gate's warning once and remembers that it did", () => {
    // W1: the tick sweep rediscovers a drifted gate on every rotation, and the loop
    // notifies every line it returns. Without a ledger the same warning would repeat
    // every tick — every 15 s on a one-member fleet.
    const first = planGateNotices({
      notices: [{ gateId: "bd-960", message: "gate bd-960 drifted" }],
    });
    expect(first.fresh.map((notice) => notice.gateId)).toEqual(["bd-960"]);
    expect(first.noticeIds).toEqual(["bd-960"]);

    const second = planGateNotices({
      existing: first.noticeIds,
      notices: [{ gateId: "bd-960", message: "gate bd-960 drifted" }],
    });
    expect(second.fresh).toEqual([]);
    expect(second.noticeIds).toEqual(["bd-960"]);
  });

  it("warns separately about a different gate", () => {
    const planned = planGateNotices({
      existing: ["bd-960"],
      notices: [
        { gateId: "bd-960", message: "already shown" },
        { gateId: "bd-961", message: "new drift" },
      ],
    });
    expect(planned.fresh.map((notice) => notice.gateId)).toEqual(["bd-961"]);
    expect(planned.noticeIds).toEqual(["bd-960", "bd-961"]);
  });

  it("forgets a gate once bd confirms it resolved", () => {
    const planned = planGateNotices({
      existing: ["bd-960", "bd-961"],
      notices: [],
      releasedGateIds: ["bd-960"],
    });
    expect(planned.noticeIds).toEqual(["bd-961"]);
  });

  it("stays quiet instead of growing past its bound", () => {
    const existing = Array.from(
      { length: FLEET_RUN_GATE_NOTICE_IDS_MAX },
      (_, index) => `bd-${5000 + index}`,
    );
    const planned = planGateNotices({
      existing,
      notices: [{ gateId: "bd-970", message: "one more drift" }],
    });
    // Refusing to remember would re-warn forever, so the overflow is suppressed.
    expect(planned.fresh).toEqual([]);
    expect(planned.noticeIds).toHaveLength(FLEET_RUN_GATE_NOTICE_IDS_MAX);
  });

  it("keeps the ledger on the run and drops the field when it empties", () => {
    const started = startFleetRun({ now: 1_000, accept: true, members: [] });
    const recorded = recordFleetGateNotices(started, ["bd-960"]);
    expect(recorded.gateNoticeIds).toEqual(["bd-960"]);
    expect(recordFleetGateNotices(recorded, []).gateNoticeIds).toBeUndefined();
  });
});

describe("releaseRunMembers (bd-166)", () => {
  /** bd-12 landed, bd-15 stopped, bd-19 complete, bd-22 never started. */
  function terminalRun(): FleetRun {
    const started = startFleetRun({
      now: 1_000,
      accept: true,
      members: [{ taskId: "bd-12" }, { taskId: "bd-15" }, { taskId: "bd-19" }, { taskId: "bd-22" }],
    });
    const landed = recordRunMemberLanded({ run: started, taskId: "bd-12", now: 1_100 });
    return recordRunMemberStopped({
      run: landed,
      taskId: "bd-15",
      reason: "phase-failed",
      detail: "gate failed",
      now: 1_200,
    });
  }

  function observations(): FleetMemberObservation[] {
    return [
      observation("bd-12", { kind: "complete" }, "absent"),
      observation("bd-15", { kind: "phase-failed", detail: "gate failed" }, "absent"),
      observation("bd-19", { kind: "complete" }, "absent"),
      observation("bd-22", { kind: "missing", detail: "never started" }, "absent"),
    ];
  }

  it("releases stopped and never-started members and keeps completed ones landable", () => {
    const current = intent({ taskIds: ["bd-12", "bd-15", "bd-19", "bd-22"] });
    const plan = releaseRunMembers({
      intent: current,
      run: terminalRun(),
      observations: observations(),
      reason: "run-complete",
      now: 2_000,
    });

    // bd-15 stopped, bd-22 never started; bd-12 already landed; bd-19 is done and
    // still landable, so it keeps its slot until the landing path finishes it.
    expect(plan.released).toEqual(["bd-15", "bd-22"]);
    expect(plan.intent.released).toEqual([
      { taskId: "bd-15", reason: "run-complete", at: 2_000 },
      { taskId: "bd-22", reason: "run-complete", at: 2_000 },
    ]);
    expect(plan.intent.taskIds).toEqual(["bd-12", "bd-15", "bd-19", "bd-22"]);
    expect(plan.intent.updatedAt).toBe(2_000);
  });

  it("is idempotent: the same reason twice releases nothing new", () => {
    const current = intent({ taskIds: ["bd-15", "bd-22"] });
    const first = releaseRunMembers({
      intent: current,
      run: terminalRun(),
      observations: observations(),
      reason: "run-halted",
      now: 2_000,
    });
    const second = releaseRunMembers({
      intent: first.intent,
      run: terminalRun(),
      observations: observations(),
      reason: "run-halted",
      now: 3_000,
    });

    expect(second.released).toEqual([]);
    expect(second.intent.released).toEqual(first.intent.released);
  });

  it("keeps a stopped member's slot while its orchestrator is live", () => {
    const plan = releaseRunMembers({
      intent: intent({ taskIds: ["bd-15"] }),
      run: terminalRun(),
      observations: [observation("bd-15", { kind: "running", detail: "2/5" }, "live", 1_000)],
      reason: "run-halted",
      now: 2_000,
    });

    // A live lease means something is still driving the worktree; releasing it would
    // let the next fleet start work past the ceiling.
    expect(plan.released).toEqual([]);
    expect(plan.intent).toEqual(intent({ taskIds: ["bd-15"] }));
  });

  it("never releases a member this tick did not observe (bd-166)", () => {
    const running = startFleetRun({
      now: 1_000,
      accept: true,
      members: [{ taskId: "bd-12" }, { taskId: "bd-15" }],
    });
    const plan = releaseRunMembers({
      intent: intent({ taskIds: ["bd-12", "bd-15"] }),
      run: running,
      // bd-15 was added to `taskIds` by a concurrent writer after the tick read: no
      // observation is "no evidence", not "no work".
      observations: [observation("bd-12", { kind: "complete" }, "absent")],
      reason: "run-halted",
      now: 2_000,
    });

    expect(plan.released).toEqual([]);
  });

  it("keeps counting a running member the terminal run did not stop", () => {
    const running = startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-15" }] });
    const plan = releaseRunMembers({
      intent: intent({ taskIds: ["bd-15"] }),
      run: running,
      observations: [observation("bd-15", { kind: "running", detail: "3/5" }, "absent", 1_000)],
      reason: "run-halted",
      now: 2_000,
    });

    expect(plan.released).toEqual([]);
  });
});

describe("planOutsideFleetLandings (bd-166)", () => {
  it("lands a member whose bead is closed and whose branch git proves is on the base", async () => {
    const landed = await planOutsideFleetLandings({
      intent: intent({ taskIds: ["bd-12", "bd-15"] }),
      run: startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-12" }] }),
      closedBeadIds: new Set(["bd-12"]),
      branchOnBase: async () => true,
    });
    expect(landed).toEqual(["bd-12"]);
  });

  it("requires both facts: a closed bead alone or an ancestor alone is not a landing", async () => {
    const run = startFleetRun({ now: 1_000, accept: false, members: [] });
    expect(
      await planOutsideFleetLandings({
        intent: intent({ taskIds: ["bd-12", "bd-15"] }),
        run,
        closedBeadIds: new Set(["bd-12"]),
        branchOnBase: async () => false,
      }),
    ).toEqual([]);
    expect(
      await planOutsideFleetLandings({
        intent: intent({ taskIds: ["bd-12", "bd-15"] }),
        run,
        closedBeadIds: new Set([]),
        branchOnBase: async () => true,
      }),
    ).toEqual([]);
  });

  it("skips a member this run already landed, so a landing is recorded once", async () => {
    const started = startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-12" }] });
    const already = recordRunMemberLanded({ run: started, taskId: "bd-12", now: 2_000 });

    expect(
      await planOutsideFleetLandings({
        intent: intent({ taskIds: ["bd-12"] }),
        run: already,
        closedBeadIds: new Set(["bd-12"]),
        branchOnBase: async () => true,
      }),
    ).toEqual([]);
  });
});
