/**
 * Fleet escalation as bd gates (bd-279).
 *
 * The design's promise is that one primitive covers every human-relevant stop: a
 * described gate per `(bead, cause, round)`, idempotent across ticks, drift-checked
 * against the run record, and never used for a condition a machine resolves. These
 * cases pin exactly that — the marker round-trip, one escalation per stop, the
 * adopt/second-tick-opens-nothing rule, the read-failure refusal, the conditions
 * that must stay gate-free, and the three drift outcomes.
 *
 * The bd seam is a fake runner: no process is spawned and every assertion is on the
 * exact argv (and on the record the pure layer hands back).
 */

import { describe, expect, it } from "vitest";
import { renderFleetEscalationGateMarker } from "../bead-gates.js";
import type { FleetBeadRunner } from "../fleet-beads.js";
import {
  applyFleetEscalationGates,
  checkFleetEscalationGates,
  ensureFleetEscalationGates,
  FLEET_ESCALATION_CAUSES,
  FLEET_ESCALATION_REASON_PROSE_MAX,
  fleetEscalationGateReason,
  fleetEscalationGateTitle,
  isFleetEscalationCause,
  listFleetEscalationGatesForBead,
  planFleetEscalations,
  reapFleetEscalationGatesByPrefix,
} from "../fleet-escalation.js";
import type { FleetRun } from "../fleet-run.js";
import {
  FLEET_RUN_DETAIL_MAX_LENGTH,
  FLEET_RUN_STOP_REASONS,
  recordRunMemberLanded,
  recordRunMemberStopped,
  recordRunStopGate,
  recordRunStopResolution,
  startFleetRun,
} from "../fleet-run.js";

const FLEET = "default";

function stoppedRun(
  stops: readonly {
    taskId: string;
    reason?: (typeof FLEET_RUN_STOP_REASONS)[number];
    detail?: string;
    at?: number;
  }[],
  taskIds: readonly string[] = stops.map((stop) => stop.taskId),
): FleetRun {
  let run = startFleetRun({
    now: 1_000,
    accept: false,
    members: taskIds.map((taskId) => ({ taskId })),
  });
  for (const stop of stops) {
    run = recordRunMemberStopped({
      run,
      taskId: stop.taskId,
      reason: stop.reason ?? "land-failed",
      detail: stop.detail ?? `detail for ${stop.taskId}`,
      now: stop.at ?? 2_000,
    });
  }
  return run;
}

interface FakeBdOptions {
  /** Open gates per bead, as `bd gate list <bead> --json` answers. */
  open?: (beadId: string) => unknown;
  /** All gates per bead, as `bd gate list <bead> --all --json` answers. */
  all?: (beadId: string) => unknown;
  failListWith?: string;
  failCreateWith?: string;
  /** Successful creates allowed before every further create fails. */
  failCreateAfter?: number;
  /** Gate ids whose resolve fails, so a partial sweep is testable. */
  failResolveFor?: readonly string[];
  /** Arbitrary bd text for one resolve, so a real bd error shape is testable. */
  resolveError?: (gateId: string) => string | undefined;
  /** Verbatim stdout of a create, for the exits-0-with-no-id contract break. */
  createStdout?: string;
  /** Minted ids, in create order. */
  gateIds?: readonly string[];
}

interface FakeBd {
  calls: readonly string[][];
  runBd: FleetBeadRunner;
}

/** A bd stub that lists, creates and resolves gates from tables. */
function fakeBd(options: FakeBdOptions = {}): FakeBd {
  const calls: string[][] = [];
  const gateIds = options.gateIds ?? ["bd-901", "bd-902", "bd-903", "bd-904"];
  const minted = { count: 0 };
  const runBd: FleetBeadRunner = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "gate" && argv[1] === "list") return listAnswer(options, argv);
    if (argv[0] === "gate" && argv[1] === "create") return createAnswer(options, gateIds, minted);
    if (argv[0] === "gate" && argv[1] === "resolve") return resolveAnswer(options, argv);
    return { stdout: "" };
  };
  return { calls, runBd };
}

function resolveAnswer(options: FakeBdOptions, argv: readonly string[]): { stdout: string } {
  const gateId = argv[2] ?? "";
  const arbitrary = options.resolveError?.(gateId);
  if (arbitrary !== undefined) throw new Error(arbitrary);
  if (options.failResolveFor?.includes(gateId)) throw new Error("bd: lock timeout");
  return { stdout: "" };
}

function listAnswer(options: FakeBdOptions, argv: readonly string[]): { stdout: string } {
  if (options.failListWith !== undefined) throw new Error(options.failListWith);
  const beadId = argv[2] ?? "";
  const answer = argv.includes("--all")
    ? (options.all?.(beadId) ?? null)
    : (options.open?.(beadId) ?? null);
  return { stdout: JSON.stringify(answer) };
}

function createAnswer(
  options: FakeBdOptions,
  gateIds: readonly string[],
  minted: { count: number },
): { stdout: string } {
  if (options.failCreateWith !== undefined) throw new Error(options.failCreateWith);
  if (options.failCreateAfter !== undefined && minted.count >= options.failCreateAfter) {
    throw new Error("bd: gate create failed");
  }
  const gateId = gateIds[minted.count] ?? `bd-${9_500 + minted.count}`;
  minted.count += 1;
  if (options.createStdout !== undefined) return { stdout: options.createStdout };
  return { stdout: JSON.stringify({ id: gateId }) };
}

/** An open escalation gate record bd would list for a bead. */
function openGate(input: {
  gateId?: string;
  fleetId?: string;
  taskId: string;
  cause: string;
  round: number;
  description?: string;
}) {
  const marker = renderFleetEscalationGateMarker({
    fleetId: input.fleetId ?? FLEET,
    taskId: input.taskId,
    cause: input.cause,
    round: input.round,
  });
  return {
    id: input.gateId ?? "bd-901",
    status: "open",
    await_type: "human",
    title: marker,
    description: input.description ?? `Reason: ${marker}: needs a human`,
  };
}

/** A closed escalation gate record bd would list for a bead. */
function closedGate(input: {
  gateId?: string;
  taskId: string;
  cause: string;
  round: number;
  closeReason?: string;
}) {
  return {
    ...openGate(input),
    status: "closed",
    ...(input.closeReason === undefined ? {} : { close_reason: input.closeReason }),
  };
}

describe("marker and description (bd-279)", () => {
  it("renders the marker into the title so bd's own list names the escalation", () => {
    const plan = planFleetEscalations({
      fleetId: FLEET,
      run: stoppedRun([{ taskId: "bd-12", reason: "land-failed", detail: "gate refused" }]),
      taskIds: ["bd-12"],
    })[0];
    expect(FLEET_ESCALATION_CAUSES).toEqual([...FLEET_RUN_STOP_REASONS, "fleet-parked"]);
    expect(plan?.title).toBe(
      fleetEscalationGateTitle({
        fleetId: FLEET,
        taskId: "bd-12",
        cause: "land-failed",
        round: 2_000,
      }),
    );
    expect(plan?.title).toBe("belayd-fleet-escalation: fleet:default bd-12 land-failed r2000");
  });

  it("names the member, cause, detail and the three options a human may choose", () => {
    const reason = fleetEscalationGateReason({
      fleetId: FLEET,
      taskId: "bd-12",
      cause: "land-failed",
      round: 2_000,
      detail: "publish gate refused: proof-artifacts-in-diff",
    });
    expect(reason.startsWith("belayd-fleet-escalation:")).toBe(true);
    expect(reason).toContain("bd-12");
    expect(reason).toContain("land-failed");
    expect(reason).toContain("publish gate refused: proof-artifacts-in-diff");
    expect(reason).toContain("`bd gate resolve <gate-id> --reason");
    expect(reason).toContain("retry, abandon, or release");
    // A 400-char detail can never truncate the marker: the prose is what is bound.
    const long = fleetEscalationGateReason({
      fleetId: FLEET,
      taskId: "bd-12",
      cause: "state-corrupt",
      round: 2_000,
      detail: "x".repeat(FLEET_RUN_DETAIL_MAX_LENGTH * 3),
    });
    expect(long.startsWith("belayd-fleet-escalation:")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(
      renderFleetEscalationGateMarker({
        fleetId: FLEET,
        taskId: "bd-12",
        cause: "state-corrupt",
        round: 2_000,
      }).length + FLEET_ESCALATION_REASON_PROSE_MAX,
    );
    expect(long).not.toContain("\n");
  });

  it("bounds a hand-edited park reason exactly like a stop detail", () => {
    // A parked cause's detail comes from `fleet.json`, which an operator can edit by
    // hand: the park reason is unbounded there while a stop detail is schema-capped.
    // `oneLine` collapses it and the prose bound still applies, so the same bound
    // covers both causes.
    const parked = fleetEscalationGateReason({
      fleetId: FLEET,
      taskId: "bd-12",
      cause: "fleet-parked",
      round: 7_000,
      detail: `root stash\n\tcould not be restored ${"y".repeat(5_000)}`,
    });
    const marker = renderFleetEscalationGateMarker({
      fleetId: FLEET,
      taskId: "bd-12",
      cause: "fleet-parked",
      round: 7_000,
    });
    expect(parked.startsWith(marker)).toBe(true);
    expect(parked.length).toBeLessThanOrEqual(marker.length + FLEET_ESCALATION_REASON_PROSE_MAX);
    expect(parked).toContain("fleet-parked");
    expect(parked).not.toContain("\n");
    expect(parked).not.toContain("\t");
  });
});

describe("planFleetEscalations (bd-279)", () => {
  it("planFleetEscalations plans exactly one escalation per stop, for every reason", () => {
    const stops = FLEET_RUN_STOP_REASONS.map((reason, index) => ({
      taskId: `bd-${20 + index}`,
      reason,
      detail: `why ${reason}`,
      at: 2_000 + index,
    }));
    const planned = planFleetEscalations({
      fleetId: FLEET,
      run: stoppedRun(
        stops,
        stops.map((stop) => stop.taskId),
      ),
      taskIds: stops.map((stop) => stop.taskId),
    });

    expect(planned).toHaveLength(FLEET_RUN_STOP_REASONS.length);
    expect(planned.map((plan) => plan.cause)).toEqual([...FLEET_RUN_STOP_REASONS]);
    expect(planned.map((plan) => plan.round)).toEqual(stops.map((stop) => stop.at));
    for (const plan of planned) expect(plan.reasonText).toContain(plan.taskId);
  });

  it("does not re-plan a stop that was already escalated or answered", () => {
    let run = stoppedRun([{ taskId: "bd-12" }, { taskId: "bd-15", at: 2_100 }]);
    run = recordRunStopGate({ run, taskId: "bd-12", gateId: "bd-901", now: 3_000 });
    run = recordRunStopResolution({ run, taskId: "bd-15", note: "abandon", now: 3_000 });

    expect(planFleetEscalations({ fleetId: FLEET, run, taskIds: ["bd-12", "bd-15"] })).toEqual([]);
  });

  it("escalates a parked fleet once per member still in flight, with the park as the round", () => {
    const planned = planFleetEscalations({
      fleetId: FLEET,
      run: stoppedRun([{ taskId: "bd-15", reason: "phase-interrupted" }], ["bd-12", "bd-15"]),
      taskIds: ["bd-12", "bd-15"],
      parked: { reason: "root stash could not be restored", recordedAt: 7_000 },
    });

    // bd-15 has its own stop, so only bd-12 is stranded by the park.
    expect(planned.map((plan) => [plan.taskId, plan.cause, plan.round])).toEqual([
      ["bd-15", "phase-interrupted", 2_000],
      ["bd-12", "fleet-parked", 7_000],
    ]);
    expect(planned[1]?.reasonText).toContain("root stash could not be restored");
  });

  it("opens no parked gate for a landed member or a second one for a stopped member", () => {
    // A park strands the members still in flight. A landed member owes nobody a
    // decision, and a stopped one already has its own gate for its own cause, so a
    // second gate for the same park would be two questions about one condition.
    let run = stoppedRun(
      [{ taskId: "bd-15", reason: "phase-interrupted", at: 2_000 }],
      ["bd-12", "bd-15", "bd-18"],
    );
    run = recordRunMemberLanded({ run, taskId: "bd-18", now: 3_000 });

    const planned = planFleetEscalations({
      fleetId: FLEET,
      run,
      taskIds: ["bd-12", "bd-15", "bd-18"],
      parked: { reason: "root stash could not be restored", recordedAt: 7_000 },
    });

    expect(planned.map((plan) => [plan.taskId, plan.cause, plan.round])).toEqual([
      ["bd-15", "phase-interrupted", 2_000],
      ["bd-12", "fleet-parked", 7_000],
    ]);
    expect(planned.filter((plan) => plan.taskId === "bd-18")).toEqual([]);
  });

  it("adopts the park gate a previous tick already opened instead of stacking one", async () => {
    // A park has no per-member stop to carry the gate id, so its idempotence comes
    // from bd's own marker: re-planning is expected, re-creating is not.
    const parked = { reason: "root stash could not be restored", recordedAt: 7_000 };
    const plan = planFleetEscalations({
      fleetId: FLEET,
      run: stoppedRun([], ["bd-12"]),
      taskIds: ["bd-12"],
      parked,
    });
    expect(plan.map((entry) => entry.cause)).toEqual(["fleet-parked"]);

    const bd = fakeBd({
      open: () => [
        openGate({ gateId: "bd-903", taskId: "bd-12", cause: "fleet-parked", round: 7_000 }),
      ],
    });
    const ensured = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan,
    });
    expect(ensured).toHaveProperty("ok", true);
    if (!ensured.ok) return;
    expect(ensured.created).toEqual([]);
    expect(ensured.adopted.map((gate) => gate.gateId)).toEqual(["bd-903"]);
    expect(bd.calls.some((argv) => argv[0] === "gate" && argv[1] === "create")).toBe(false);
  });

  it("produces no escalation for ordering waits, capacity deferrals or quality gates", () => {
    // Those are conditions the loop resolves itself: they are absent from the
    // planner's input by construction (no stop record, no park), so an empty record
    // stays empty.
    const run = startFleetRun({
      now: 1_000,
      accept: false,
      members: [{ taskId: "bd-12" }],
    });
    expect(
      planFleetEscalations({
        fleetId: FLEET,
        run: { ...run, haltedReason: "stalled: capacity deferred bd-15" },
        taskIds: ["bd-12", "bd-15"],
      }),
    ).toEqual([]);
    // "fleet-parked" is the only park cause; a merely paused fleet opens nothing.
    expect(
      planFleetEscalations({ fleetId: FLEET, run, taskIds: ["bd-12"], parked: undefined }),
    ).toEqual([]);
    expect(isFleetEscalationCause("fleet-parked")).toBe(true);
    // A sensitivity cause is not in the vocabulary either: bd-286 deleted the
    // classifier that produced it (see the next case).
    expect(isFleetEscalationCause("sensitive-findings-withheld")).toBe(false);
    expect(isFleetEscalationCause("capacity")).toBe(false);
    expect(isFleetEscalationCause("ordering")).toBe(false);
  });

  it("opens no gate for a sensitivity cause that no longer exists", () => {
    // bd-286 deleted the per-finding sensitivity classifier and its review gate, so
    // there is no code path left that could mint an escalation for one. The pin:
    // the cause is not a cause, and a run whose only signal is a sensitivity cause
    // plans nothing.
    expect(FLEET_ESCALATION_CAUSES).not.toContain("sensitive-findings-withheld");
    const run = startFleetRun({
      now: 1_000,
      accept: false,
      members: [{ taskId: "bd-12" }],
    });
    expect(
      planFleetEscalations({ fleetId: FLEET, run, taskIds: ["bd-12"], parked: undefined }),
    ).toEqual([]);
  });
});

describe("listFleetEscalationGatesForBead guards (bd-279)", () => {
  it("refuses an empty or flag-shaped bead id before spawning bd", async () => {
    for (const beadId of ["", "-bd-12", "--json"]) {
      const calls: string[][] = [];
      const result = await listFleetEscalationGatesForBead({
        beadId,
        cwd: "/repo",
        runBd: async (argv) => {
          calls.push([...argv]);
          return { stdout: "null" };
        },
      });
      expect(result).toHaveProperty("ok", false);
      expect(calls).toEqual([]);
    }
  });

  it("refuses a non-read argv without spawning bd", async () => {
    // The read-only guard is the seam that keeps a bug in the argv builder from
    // turning a status read into a write; the identical guard the other bd readers
    // test. Both a resolve and a create must be refused before any process starts.
    for (const argv of [
      ["gate", "resolve", "bd-159"],
      ["gate", "create", "--blocks", "bd-12"],
    ]) {
      const calls: string[][] = [];
      const result = await listFleetEscalationGatesForBead({
        beadId: "bd-12",
        cwd: "/repo",
        runBd: async (spawned) => {
          calls.push([...spawned]);
          return { stdout: "null" };
        },
        buildArgv: () => argv,
      });
      expect(result).toHaveProperty("ok", false);
      expect(calls).toEqual([]);
    }
  });
});

describe("ensureFleetEscalationGates (bd-279)", () => {
  const plan = planFleetEscalations({
    fleetId: FLEET,
    run: stoppedRun([{ taskId: "bd-12", reason: "accept-failed", detail: "bead stayed open" }]),
    taskIds: ["bd-12"],
  });

  it("creates a human gate that blocks the stopped member", async () => {
    const bd = fakeBd();
    const ensured = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan,
    });

    expect(ensured).toHaveProperty("ok", true);
    if (!ensured.ok) return;
    expect(ensured.created).toEqual([
      { taskId: "bd-12", cause: "accept-failed", round: 2_000, gateId: "bd-901" },
    ]);
    const create = bd.calls.find((argv) => argv[0] === "gate" && argv[1] === "create");
    if (create === undefined) throw new Error("no gate create was issued");
    expect(create).toContain("--blocks");
    expect(create).toContain("bd-12");
    expect(create).toContain("--type=human");
    expect(create).toContain("--title");
    expect(create[create.length - 1]).toBe("--json");
  });

  it("adopts the gate bd already has, so a second tick opens nothing", async () => {
    const run = stoppedRun([{ taskId: "bd-12", reason: "accept-failed" }]);
    let bd = fakeBd();
    const first = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan,
    });
    expect(first).toHaveProperty("ok", true);
    if (!first.ok) return;

    // The same plan on the next tick, with bd now holding the gate it created.
    const open = openGate({ taskId: "bd-12", cause: "accept-failed", round: 2_000 });
    bd = fakeBd({ open: (beadId) => (beadId === "bd-12" ? [open] : null) });
    const second = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan,
    });
    expect(second).toHaveProperty("ok", true);
    if (!second.ok) return;
    expect(second.created).toEqual([]);
    expect(second.adopted).toEqual([
      { taskId: "bd-12", cause: "accept-failed", round: 2_000, gateId: "bd-901" },
    ]);
    expect(bd.calls.some((argv) => argv[0] === "gate" && argv[1] === "create")).toBe(false);
    // The planner agrees on the second tick: an escalated stop is not re-planned.
    const escalated = applyFleetEscalationGates({
      run,
      gates: first.gates,
      now: 3_000,
    });
    expect(escalated.stopped?.[0]?.gateId).toBe("bd-901");
    expect(planFleetEscalations({ fleetId: FLEET, run: escalated, taskIds: ["bd-12"] })).toEqual(
      [],
    );
  });

  it("refuses and creates nothing when bd's gate list fails", async () => {
    const bd = fakeBd({ failListWith: "bd: database locked" });
    const ensured = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan,
    });

    expect(ensured).toHaveProperty("ok", false);
    if (ensured.ok) return;
    expect(ensured.error).toContain("could not read the escalation gates of bd-12");
    expect(ensured.created).toEqual([]);
    expect(bd.calls.some((argv) => argv[0] === "gate" && argv[1] === "create")).toBe(false);
  });

  it("keeps the stop record exactly as written when bd's gate list fails", async () => {
    // Creating blind is the failure mode the read-then-write order exists to avoid:
    // the stop is a durable fact and must survive a bd outage untouched, so the next
    // tick plans the same escalation again instead of trusting a guess.
    const run = stoppedRun([{ taskId: "bd-12", reason: "land-failed", detail: "publish gate" }]);
    const bd = fakeBd({ failListWith: "bd: database locked" });
    const ensured = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan,
    });

    expect(ensured).toHaveProperty("ok", false);
    if (ensured.ok) return;
    expect(ensured.gates).toEqual([]);
    expect(ensured.adopted).toEqual([]);
    expect(ensured.error).toContain("database locked");
    // Nothing was created, so nothing can be recorded: the stop keeps no gate id and
    // the planner re-plans it on the next pass.
    expect(applyFleetEscalationGates({ run, gates: ensured.gates, now: 9_000 })).toBe(run);
    expect(planFleetEscalations({ fleetId: FLEET, run, taskIds: ["bd-12"] })).toHaveLength(1);
  });

  it("keeps the gates it opened when a later create fails", async () => {
    const twoStops = planFleetEscalations({
      fleetId: FLEET,
      run: stoppedRun([{ taskId: "bd-12" }, { taskId: "bd-15", at: 2_100 }], ["bd-12", "bd-15"]),
      taskIds: ["bd-12", "bd-15"],
    });
    const bd = fakeBd({ failCreateAfter: 1 });
    const ensured = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan: twoStops,
    });

    expect(ensured).toHaveProperty("ok", false);
    if (ensured.ok) return;
    // The first gate exists and must be recorded: forgetting it would create a second
    // one on the next tick while the first stayed open, unresolvable, forever.
    expect(ensured.created.map((gate) => [gate.taskId, gate.gateId])).toEqual([
      ["bd-12", "bd-901"],
    ]);
    expect(ensured.gates.map((gate) => gate.taskId)).toEqual(["bd-12"]);
  });

  it("reports a create that exited 0 without a usable gate id, and records nothing", async () => {
    // A gate created without a readable id may or may not exist: guessing the id would
    // either resolve the work bead or orphan a gate, so the failure names the exact
    // command that finishes the job by hand and no id is recorded.
    const bd = fakeBd({ createStdout: "created\n" });
    const ensured = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan,
    });

    expect(ensured).toHaveProperty("ok", false);
    if (ensured.ok) return;
    expect(ensured.gates).toEqual([]);
    expect(ensured.error).toContain("exited 0 but reported no usable gate id");
    expect(ensured.error).toContain("bd gate create --blocks bd-12 --type=human");
    expect(ensured.error).toContain("The stop stands and no gate id was recorded");
  });

  it("adopts an open gate with the same marker instead of creating a duplicate", async () => {
    const bd = fakeBd({
      open: (beadId) =>
        beadId === "bd-12"
          ? [
              openGate({
                gateId: "bd-777",
                taskId: "bd-12",
                cause: "accept-failed",
                round: 2_000,
              }),
              // A gate for another cause/round is not adopted for this plan entry.
              openGate({
                gateId: "bd-778",
                taskId: "bd-12",
                cause: "land-failed",
                round: 1_000,
              }),
            ]
          : null,
    });
    const ensured = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan,
    });

    expect(ensured).toHaveProperty("ok", true);
    if (!ensured.ok) return;
    expect(ensured.adopted.map((gate) => gate.gateId)).toEqual(["bd-777"]);
    expect(ensured.created).toEqual([]);
  });

  it("uses the gates the caller already read instead of reading bd again", async () => {
    const bd = fakeBd();
    const ensured = await ensureFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      plan,
      existingGates: [
        { gateId: "bd-777", fleetId: FLEET, taskId: "bd-12", cause: "accept-failed", round: 2_000 },
      ],
    });
    expect(ensured).toHaveProperty("ok", true);
    expect(bd.calls.some((argv) => argv[0] === "gate" && argv[1] === "list")).toBe(false);
  });
});

describe("applyFleetEscalationGates (bd-279)", () => {
  it("records the gate id back onto the stop record and skips park escalations", () => {
    const run = stoppedRun([{ taskId: "bd-12" }]);
    const applied = applyFleetEscalationGates({
      run,
      gates: [
        { taskId: "bd-12", cause: "land-failed", round: 2_000, gateId: "bd-901" },
        { taskId: "bd-15", cause: "fleet-parked", round: 7_000, gateId: "bd-902" },
      ],
      now: 3_000,
    });
    expect(applied.stopped?.[0]?.gateId).toBe("bd-901");
    expect(applied.stopped).toHaveLength(1);
  });
});

describe("checkFleetEscalationGates drift trio (bd-279)", () => {
  it("stays silent when an open gate matches the stop record", async () => {
    const run = recordRunStopGate({
      run: stoppedRun([{ taskId: "bd-12", reason: "land-failed", at: 2_000 }]),
      taskId: "bd-12",
      gateId: "bd-901",
      now: 3_000,
    });
    const bd = fakeBd({
      open: () => [openGate({ taskId: "bd-12", cause: "land-failed", round: 2_000 })],
    });

    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run,
      now: 4_000,
    });

    expect(checked.notices).toEqual([]);
    expect(checked.reaped).toEqual([]);
    expect(checked.warnings).toEqual([]);
    expect(checked.run).toEqual(run);
  });

  it("reaps and warns once when the gate no longer matches a stop record", async () => {
    // Retry then re-stop: the member is stopped again, so the bead still has a stop to
    // key on, but the new round means the open gate answers a question nobody asks any
    // more. That is the drift the check exists to catch, and it is the same shape as a
    // retried stop seen from bd's side.
    const run = stoppedRun([{ taskId: "bd-12", reason: "land-failed", at: 5_000 }]);
    const bd = fakeBd({
      open: () => [openGate({ taskId: "bd-12", cause: "land-failed", round: 2_000 })],
    });

    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run,
      now: 6_000,
    });

    expect(checked.notices.map((notice) => notice.gateId)).toEqual(["bd-901"]);
    expect(checked.notices[0]?.message).toContain("no open stop or park matches it any more");
    expect(checked.reaped).toEqual(["bd-901"]);
    expect(bd.calls.some((argv) => argv[0] === "gate" && argv[1] === "resolve")).toBe(true);
  });

  it("adopts a park gate on a re-tick and reaps the one an earlier park left", async () => {
    const run = stoppedRun([], ["bd-12"]);
    const parked = { reason: "root stash could not be restored", recordedAt: 7_000 };

    // Same park, same recordedAt: bd's gate is the escalation, so the check is silent.
    const quietBd = fakeBd({
      open: () => [
        openGate({ gateId: "bd-903", taskId: "bd-12", cause: "fleet-parked", round: 7_000 }),
      ],
    });
    const quiet = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: quietBd.runBd,
      fleetId: FLEET,
      run,
      now: 8_000,
      taskIds: ["bd-12"],
      parked,
    });
    expect(quiet.notices).toEqual([]);
    expect(quiet.reaped).toEqual([]);
    expect(quiet.warnings).toEqual([]);
    // A park gate belongs to no stop record, so the run is returned unchanged.
    expect(quiet.run).toEqual(run);

    // A genuine re-park is a new round: the old gate answers a state that is gone,
    // so it is resolved and reported once rather than left blocking the bead.
    const staleBd = fakeBd({
      open: () => [
        openGate({ gateId: "bd-903", taskId: "bd-12", cause: "fleet-parked", round: 7_000 }),
      ],
    });
    const stale = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: staleBd.runBd,
      fleetId: FLEET,
      run,
      now: 8_000,
      taskIds: ["bd-12"],
      parked: { reason: "second park", recordedAt: 9_500 },
    });
    expect(stale.reaped).toEqual(["bd-903"]);
    expect(stale.notices).toHaveLength(1);
    expect(stale.notices[0]?.message).toContain("no open stop or park matches it any more");
    expect(stale.warnings).toEqual([]);
  });

  it("treats bd's exact gate-not-found answer as resolved, any other failure as a warning", async () => {
    // A reap is a write whose failure must not abort the sweep, but a loose "not found"
    // match would swallow a lock or database error and report a live gate as resolved.
    const run = stoppedRun([{ taskId: "bd-12", reason: "land-failed", at: 5_000 }]);
    const gone = fakeBd({
      open: () => [openGate({ taskId: "bd-12", cause: "land-failed", round: 2_000 })],
      resolveError: (gateId) => `Error: gate not found: ${gateId}`,
    });
    const swept = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: gone.runBd,
      fleetId: FLEET,
      run,
      now: 6_000,
    });
    expect(swept.reaped).toEqual(["bd-901"]);
    expect(swept.warnings).toEqual([]);

    for (const failure of ["bd: database locked", "gate not found: bd-999", "not found"]) {
      const broken = fakeBd({
        open: () => [openGate({ taskId: "bd-12", cause: "land-failed", round: 2_000 })],
        resolveError: () => failure,
      });
      const failed = await checkFleetEscalationGates({
        cwd: "/repo",
        runBd: broken.runBd,
        fleetId: FLEET,
        run,
        now: 6_000,
      });
      expect(failed.reaped).toEqual([]);
      expect(failed.notices).toEqual([]);
      expect(failed.warnings).toEqual([`Fleet default: ${failure}`]);
    }
  });

  it("reads a closed gate's note into the stop record and fires no warning", async () => {
    const run = recordRunStopGate({
      run: stoppedRun([{ taskId: "bd-12", reason: "land-failed", at: 2_000 }]),
      taskId: "bd-12",
      gateId: "bd-901",
      now: 3_000,
    });
    const bd = fakeBd({
      open: () => null,
      all: () => [
        closedGate({
          taskId: "bd-12",
          cause: "land-failed",
          round: 2_000,
          closeReason:
            "Approved by hugo via Scotty at 2026-11-01T09:52:05.582Z\n\ntrim the diff and retry",
        }),
      ],
    });

    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run,
      now: 4_000,
    });

    expect(checked.notices).toEqual([]);
    expect(checked.warnings).toEqual([]);
    expect(checked.run.stopped?.[0]?.resolution).toEqual({
      note: "trim the diff and retry",
      at: 4_000,
    });
    // An answered stop is never escalated again.
    expect(planFleetEscalations({ fleetId: FLEET, run: checked.run, taskIds: ["bd-12"] })).toEqual(
      [],
    );
  });

  it("warns about a recorded gate bd has never heard of", async () => {
    const run = recordRunStopGate({
      run: stoppedRun([{ taskId: "bd-12", reason: "land-failed", at: 2_000 }]),
      taskId: "bd-12",
      gateId: "bd-901",
      now: 3_000,
    });
    const bd = fakeBd({ open: () => null, all: () => [] });

    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run,
      now: 4_000,
    });

    expect(checked.notices.map((notice) => notice.gateId)).toEqual(["bd-901"]);
    expect(checked.notices[0]?.message).toContain("bd has no such gate");
    // The notice must not promise a re-escalation the planner does not perform: it
    // names the state (the stop keeps that id) and the recovery a person can run.
    expect(checked.notices[0]?.message).toContain("no new escalation is opened");
    expect(checked.notices[0]?.message).toContain("retryMembers");
    expect(checked.notices[0]?.message).not.toContain("re-escalate it");
    expect(checked.run.stopped?.[0]?.resolution).toBeUndefined();
  });

  it("adopts an open gate whose stop record lost its gate id", async () => {
    const run = stoppedRun([{ taskId: "bd-12", reason: "land-failed", at: 2_000 }]);
    const bd = fakeBd({
      open: () => [
        openGate({ gateId: "bd-777", taskId: "bd-12", cause: "land-failed", round: 2_000 }),
      ],
    });

    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run,
      now: 4_000,
    });

    expect(checked.notices).toEqual([]);
    expect(checked.reaped).toEqual([]);
    expect(checked.run.stopped?.[0]?.gateId).toBe("bd-777");
  });

  it("reports a read failure instead of treating it as answered", async () => {
    const run = recordRunStopGate({
      run: stoppedRun([{ taskId: "bd-12", reason: "land-failed", at: 2_000 }]),
      taskId: "bd-12",
      gateId: "bd-901",
      now: 3_000,
    });
    const bd = fakeBd({ failListWith: "bd: database locked" });

    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run,
      now: 4_000,
    });

    expect(checked.warnings).toHaveLength(1);
    expect(checked.warnings[0]).toContain("could not read the escalation gates of bd-12");
    expect(checked.run.stopped?.[0]?.resolution).toBeUndefined();
  });

  it("does nothing when the run stopped nobody and the fleet is not parked", async () => {
    const bd = fakeBd();
    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run: startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-12" }] }),
      now: 2_000,
    });
    expect(checked).toEqual({
      run: startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-12" }] }),
      reaped: [],
      notices: [],
      warnings: [],
    });
    expect(bd.calls).toEqual([]);
  });
});

describe("reapFleetEscalationGatesByPrefix (bd-279)", () => {
  function twoGates(beadId: string) {
    if (beadId !== "bd-12") return null;
    return [
      openGate({
        gateId: "bd-901",
        taskId: "bd-12",
        cause: "fleet-parked",
        round: 7_000,
      }),
      openGate({
        gateId: "bd-902",
        taskId: "bd-12",
        cause: "land-failed",
        round: 2_000,
      }),
      // Another fleet's escalation is not this fleet's to resolve.
      openGate({
        gateId: "bd-903",
        fleetId: "other",
        taskId: "bd-12",
        cause: "fleet-parked",
        round: 7_000,
      }),
    ];
  }

  it("resolves only the selected cause, leaving a member's stop escalation in force", async () => {
    const bd = fakeBd({ open: twoGates });
    const reaped = await reapFleetEscalationGatesByPrefix({
      fleetId: FLEET,
      beadIds: ["bd-12"],
      scope: "causes",
      causes: ["fleet-parked"],
      cwd: "/repo",
      runBd: bd.runBd,
    });

    expect(reaped).toHaveProperty("ok", true);
    if (!reaped.ok) return;
    expect(reaped.resolved.map((gate) => gate.gateId)).toEqual(["bd-901"]);
    const resolved = bd.calls
      .filter((argv) => argv[0] === "gate" && argv[1] === "resolve")
      .map((argv) => argv[2]);
    expect(resolved).toEqual(["bd-901"]);
  });

  it("resolves every escalation on a bead that left the fleet", async () => {
    const bd = fakeBd({ open: twoGates });
    const reaped = await reapFleetEscalationGatesByPrefix({
      fleetId: FLEET,
      beadIds: ["bd-12"],
      scope: "whole-bead",
      cwd: "/repo",
      runBd: bd.runBd,
    });

    expect(reaped).toHaveProperty("ok", true);
    if (!reaped.ok) return;
    expect(reaped.resolved.map((gate) => gate.cause)).toEqual(["fleet-parked", "land-failed"]);
  });

  it("reports a read failure without resolving anything", async () => {
    const bd = fakeBd({ failListWith: "bd: database locked" });
    const reaped = await reapFleetEscalationGatesByPrefix({
      fleetId: FLEET,
      beadIds: ["bd-12"],
      scope: "whole-bead",
      cwd: "/repo",
      runBd: bd.runBd,
    });

    expect(reaped).toHaveProperty("ok", false);
    if (reaped.ok) return;
    expect(reaped.error).toContain("database locked");
    expect(bd.calls.some((argv) => argv[0] === "gate" && argv[1] === "resolve")).toBe(false);
  });
});

describe("re-reading an answered gate (bd-279 review W1)", () => {
  it("keeps the first answer and its instant, and stops re-reading the closed gate", async () => {
    const run = recordRunStopGate({
      run: stoppedRun([{ taskId: "bd-12", reason: "land-failed", at: 2_000 }]),
      taskId: "bd-12",
      gateId: "bd-901",
      now: 3_000,
    });
    let closeReason: string | undefined =
      "Approved by hugo via Scotty at 2026-11-01T09:52:05.582Z\n\nabandon it";
    const bd = fakeBd({
      open: () => null,
      all: () => [
        {
          ...closedGate({ taskId: "bd-12", cause: "land-failed", round: 2_000 }),
          ...(closeReason === undefined ? {} : { close_reason: closeReason }),
        },
      ],
    });
    const allReads = (): number =>
      bd.calls.filter((argv) => argv[0] === "gate" && argv[1] === "list" && argv.includes("--all"))
        .length;

    const first = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run,
      now: 4_000,
    });
    expect(first.run.stopped?.[0]?.resolution).toEqual({ note: "abandon it", at: 4_000 });
    expect(allReads()).toBe(1);

    // The same closed gate, now without a note. A second tick must neither move the
    // answer instant nor drop the decision already recorded.
    closeReason = undefined;
    const second = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run: first.run,
      now: 9_000,
    });
    expect(second.run.stopped?.[0]?.resolution).toEqual({ note: "abandon it", at: 4_000 });
    expect(second.notices).toEqual([]);
    expect(second.warnings).toEqual([]);
    // An answered stop is settled: its closed gate is not read again every tick.
    expect(allReads()).toBe(1);
  });
});

describe("duplicate gates for one escalation (bd-279 review W2)", () => {
  function duplicateRun(gateId: string | undefined): FleetRun {
    const stopped = stoppedRun([{ taskId: "bd-12", reason: "land-failed", at: 2_000 }]);
    if (gateId === undefined) return stopped;
    return recordRunStopGate({ run: stopped, taskId: "bd-12", gateId, now: 3_000 });
  }

  function twoGates() {
    return [
      openGate({ gateId: "bd-902", taskId: "bd-12", cause: "land-failed", round: 2_000 }),
      openGate({ gateId: "bd-901", taskId: "bd-12", cause: "land-failed", round: 2_000 }),
    ];
  }

  it("keeps the recorded gate and resolves the duplicate", async () => {
    const bd = fakeBd({ open: twoGates });
    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run: duplicateRun("bd-902"),
      now: 4_000,
    });

    // The recorded gate is the one a human answers; the other would block the bead
    // forever with its key still matching, so it is resolved now.
    expect(checked.run.stopped?.[0]?.gateId).toBe("bd-902");
    expect(checked.reaped).toEqual(["bd-901"]);
    expect(checked.notices.map((notice) => notice.gateId)).toEqual(["bd-901"]);
    expect(checked.notices[0]?.message).toContain("duplicated the escalation");
    expect(checked.warnings).toEqual([]);
    const resolved = bd.calls
      .filter((argv) => argv[0] === "gate" && argv[1] === "resolve")
      .map((argv) => argv[2]);
    expect(resolved).toEqual(["bd-901"]);
  });

  it("keeps the lowest gate id deterministically when none is recorded", async () => {
    const bd = fakeBd({ open: twoGates });
    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run: duplicateRun(undefined),
      now: 4_000,
    });

    expect(checked.run.stopped?.[0]?.gateId).toBe("bd-901");
    expect(checked.reaped).toEqual(["bd-902"]);
  });

  it("still resolves the other duplicates when one resolve fails", async () => {
    const bd = fakeBd({
      open: () => [
        ...twoGates(),
        openGate({ gateId: "bd-903", taskId: "bd-12", cause: "land-failed", round: 2_000 }),
      ],
      failResolveFor: ["bd-902"],
    });
    const checked = await checkFleetEscalationGates({
      cwd: "/repo",
      runBd: bd.runBd,
      fleetId: FLEET,
      run: duplicateRun(undefined),
      now: 4_000,
    });

    // One failed resolve must not abort the sweep: the other duplicate is still gone
    // and the failure is reported rather than swallowed.
    expect(checked.run.stopped?.[0]?.gateId).toBe("bd-901");
    expect(checked.warnings).toHaveLength(1);
    expect(checked.warnings[0]).toContain("lock timeout");
    expect(checked.reaped).toEqual(["bd-903"]);
    expect(checked.notices.map((notice) => notice.gateId)).toEqual(["bd-903"]);
  });
});
