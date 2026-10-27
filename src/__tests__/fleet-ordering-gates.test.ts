/**
 * Fleet ordering gates (bd-158).
 *
 * The design's whole point is that two facts get two objects: a bd *gate* says
 * "wait for that member to land", a *closed bead* says "a human accepted". These
 * tests pin the pieces that make that true — which edges gate, the marker a human
 * reads in bd (and that classification is fail-closed in both directions), the
 * create/resolve lifecycle including bd-truth idempotence, and the by-prefix path
 * that closes the crash window between `bd gate create` and the intent write.
 *
 * The bd seam is a fake runner: no process is spawned, and every assertion is on
 * the exact argv the extension would run.
 */

import { describe, expect, it } from "vitest";

import {
  FLEET_ORDERING_GATE_PREFIX,
  fleetOrderingGateDriftWarning,
  isFleetOrderingGateRecord,
  lookupOpenHumanGate,
  parseOpenHumanGate,
  parseOpenOrderingGateBlocker,
} from "../bead-gates.js";
import {
  buildFleetOrderingGateArgv,
  createFleetOrderingGates,
  type FleetOrderingGate,
  fleetOrderingGateReason,
  fleetOrderingGateTitle,
  listFleetOrderingGatesForBead,
  planFleetOrderingGates,
  reapFleetOrderingGatesByPrefix,
  resolveFleetOrderingGates,
  resolveFleetOrderingGatesForBead,
} from "../fleet-ordering-gates.js";
import { FLEET_INTENT_ORDERING_GATES_MAX } from "../fleet-status.js";

const MARKER = `${FLEET_ORDERING_GATE_PREFIX} fleet:default bd-12 -> bd-13`;

describe("planFleetOrderingGates", () => {
  it("keeps only edges whose two ends are members of this launch", () => {
    const planned = planFleetOrderingGates({
      taskIds: ["bd-12", "bd-13"],
      edges: [
        { blocker: "bd-12", blocked: "bd-13" },
        { blocker: "bd-99", blocked: "bd-12" },
        { blocker: "bd-12", blocked: "bd-99" },
      ],
    });
    // An external blocker already blocks the member bead through bd's own edge.
    expect(planned).toEqual([{ blocker: "bd-12", blocked: "bd-13" }]);
  });

  it("dedupes repeated edges and orders them by the caller's task order", () => {
    const planned = planFleetOrderingGates({
      taskIds: ["bd-13", "bd-12", "bd-14"],
      edges: [
        { blocker: "bd-14", blocked: "bd-13" },
        { blocker: "bd-12", blocked: "bd-14" },
        { blocker: "bd-12", blocked: "bd-14" },
      ],
    });
    // Ordered by the dependent's position in the caller's list (bd-13 first),
    // never by gate id: two launches over the same edges must agree.
    expect(planned).toEqual([
      { blocker: "bd-14", blocked: "bd-13" },
      { blocker: "bd-12", blocked: "bd-14" },
    ]);
  });

  it("plans nothing for a member with no internal edges", () => {
    expect(
      planFleetOrderingGates({
        taskIds: ["bd-12"],
        edges: [{ blocker: "bd-12", blocked: "bd-9" }],
      }),
    ).toEqual([]);
  });

  it("plans a gate for an advance-added member blocked by an already-live member", () => {
    // The live member is in `taskIds` even though it is not part of this wave's
    // launch set; without it the edge would be dropped and bd would report the new
    // member blocked for the whole run.
    const planned = planFleetOrderingGates({
      taskIds: ["bd-12", "bd-20"],
      edges: [{ blocker: "bd-12", blocked: "bd-20" }],
    });
    expect(planned).toEqual([{ blocker: "bd-12", blocked: "bd-20" }]);
  });
});

describe("gate argv, title and reason", () => {
  it("builds a human-typed gate whose title is the structured marker", () => {
    const argv = buildFleetOrderingGateArgv({
      fleetId: "default",
      blocker: "bd-12",
      blocked: "bd-13",
    });
    expect(argv).toEqual([
      "gate",
      "create",
      "--blocks",
      "bd-13",
      "--type=human",
      "--title",
      MARKER,
      "--reason",
      fleetOrderingGateReason({ fleetId: "default", blocker: "bd-12", blocked: "bd-13" }),
    ]);
  });

  it("names both beads and the fleet so a human reading bd sees why it is blocked", () => {
    const reason = fleetOrderingGateReason({
      fleetId: "night",
      blocker: "bd-12",
      blocked: "bd-13",
    });
    expect(reason).toContain("bd-12");
    expect(reason).toContain("bd-13");
    expect(reason).toContain("fleet:night");
    expect(reason).toContain("must land");
  });

  it("keeps the marker intact when the prose is long", () => {
    const title = fleetOrderingGateTitle({
      fleetId: "a-very-long-fleet-id-that-should-not-matter",
      blocker: "bd-12",
      blocked: "bd-13",
    });
    expect(title.startsWith(FLEET_ORDERING_GATE_PREFIX)).toBe(true);
    expect(isFleetOrderingGateRecord({ title })).toBe(true);
  });
});

/**
 * Classification is the safety-critical half: getting it wrong either unblocks a
 * human wait with no answer, or lets a comment "answer" an ordering gate.
 */
describe("ordering gates and human gates stay separate", () => {
  const orderingRecord = {
    id: "bd-900",
    status: "open",
    await_type: "human",
    title: MARKER,
    description: `Ad-hoc gate blocking bd-13\n\nReason: ${MARKER}: bd-12 must land`,
  };
  const humanRecord = {
    id: "bd-910",
    status: "open",
    await_type: "human",
    title: "Gate: human",
    description: "Gate blocking bd-13\n\nReason: which option should ship?",
  };
  /** A human gate whose question happens to start with the fleet's prefix. */
  const prefixOnlyHumanGate = {
    id: "bd-911",
    status: "open",
    await_type: "human",
    title: `${FLEET_ORDERING_GATE_PREFIX} should we ship option A?`,
    description: `Gate blocking bd-13\n\nReason: ${FLEET_ORDERING_GATE_PREFIX} should we ship option A?`,
  };

  it("never reads a fleet ordering gate as a human question", () => {
    expect(isFleetOrderingGateRecord(orderingRecord)).toBe(true);
    expect(parseOpenHumanGate([orderingRecord], "bd-13")).toBeUndefined();
    expect(parseOpenOrderingGateBlocker([orderingRecord], "bd-13")).toBe("bd-12");
  });

  it("never reads a human question as an ordering gate", () => {
    expect(isFleetOrderingGateRecord(humanRecord)).toBe(false);
    expect(parseOpenOrderingGateBlocker([humanRecord], "bd-13")).toBeUndefined();
    expect(parseOpenHumanGate([humanRecord], "bd-13")).toMatchObject({ gateId: "bd-910" });
  });

  it("keeps a human gate that merely starts with the prefix a human wait", () => {
    // Fail-closed: only the exact structured shape (prefix + fleet id + both bead
    // ids) may classify a record as ordering. Otherwise a human gate whose
    // question begins with the marker would look resolved and the workflow would
    // proceed with no answer.
    expect(isFleetOrderingGateRecord(prefixOnlyHumanGate)).toBe(false);
    expect(parseOpenHumanGate([prefixOnlyHumanGate], "bd-13")).toMatchObject({
      gateId: "bd-911",
    });
  });

  it("reports an unparseable prefix-only record as unrecognized, never as resolved", async () => {
    const runBd = async (): Promise<{ stdout: string }> => ({
      // No await_type: a record the human reader cannot classify must not become
      // `status: "none"` (which callers read as "the wait is over").
      stdout: JSON.stringify([
        { id: "bd-911", status: "open", title: `${FLEET_ORDERING_GATE_PREFIX}?` },
      ]),
    });
    const result = await lookupOpenHumanGate({ beadId: "bd-13", cwd: "/repo", runBd });
    expect(result).toHaveProperty("status", "unrecognized");
  });

  it("treats a real ordering gate as no human wait, and names the blocker", async () => {
    const runBd = async (): Promise<{ stdout: string }> => ({
      stdout: JSON.stringify([orderingRecord]),
    });
    const result = await lookupOpenHumanGate({ beadId: "bd-13", cwd: "/repo", runBd });
    expect(result).toEqual({ ok: true, status: "none", orderingBlocker: "bd-12" });
  });

  it("ignores a resolved ordering gate", () => {
    expect(
      parseOpenOrderingGateBlocker([{ ...orderingRecord, status: "closed" }], "bd-13"),
    ).toBeUndefined();
  });

  it("rejects a record whose title and description disagree about the edge", () => {
    // Two sources, one answer: a mismatched record is not safely readable, so it
    // falls back to the conservative classification (a human gate, wait armed).
    const mismatched = {
      ...orderingRecord,
      description: "Reason: belayd-fleet-ordering: fleet:default bd-77 -> bd-13",
    };
    expect(isFleetOrderingGateRecord(mismatched)).toBe(false);
    expect(parseOpenHumanGate([mismatched], "bd-13")).toMatchObject({ gateId: "bd-900" });
  });

  it("keeps a real ordering gate ordering when bd truncated its reason", () => {
    // C1: bd owns the reason column and may cut or re-fold it. Classifying the
    // fleet's own gate as a human gate would make `belayd_ask_human`'s poll wait
    // forever for a comment answer no human will give — wedging the dependent.
    const truncated = {
      ...orderingRecord,
      description: "Ad-hoc gate blocking bd-13\n\nReason: belayd-fleet-ordering: fleet:default bd-",
    };
    expect(isFleetOrderingGateRecord(truncated)).toBe(true);
    expect(parseOpenOrderingGateBlocker([truncated], "bd-13")).toBe("bd-12");
    expect(parseOpenHumanGate([truncated], "bd-13")).toBeUndefined();
  });

  it("never arms a human wait for an ordering gate whose reason drifted", async () => {
    // The reader the poll actually uses, not just the predicate under it.
    const truncated = {
      ...orderingRecord,
      description: "Ad-hoc gate blocking bd-13\n\nReason: belayd-fleet-ordering: truncated",
    };
    const runBd = async (): Promise<{ stdout: string }> => ({
      stdout: JSON.stringify([truncated]),
    });
    const result = await lookupOpenHumanGate({ beadId: "bd-13", cwd: "/repo", runBd });
    expect(result).toEqual({ ok: true, status: "none", orderingBlocker: "bd-12" });
  });

  it("warns about the reason drift without changing the classification", () => {
    const truncated = {
      ...orderingRecord,
      description: "Reason: belayd-fleet-ordering: fleet:default bd-",
    };
    const warning = fleetOrderingGateDriftWarning(truncated);
    expect(warning).toContain("bd-900");
    expect(warning).toContain("classified from the title");
    // No drift when the two sources agree, or when the reason carries no marker.
    expect(fleetOrderingGateDriftWarning(orderingRecord)).toBeUndefined();
    expect(
      fleetOrderingGateDriftWarning({ ...orderingRecord, description: "Reason: ship it?" }),
    ).toBeUndefined();
  });
});

interface FakeBd {
  calls: readonly string[][];
  runBd: Parameters<typeof createFleetOrderingGates>[0]["runBd"];
}

/** A bd stub that mints gate ids, answers gate lists, and resolves from a table. */
function fakeBd(
  options: {
    minted?: readonly string[];
    /** Existing open gates per blocked bead, as `bd gate list <bead> --json` answers. */
    openGates?: (beadId: string) => readonly unknown[] | undefined;
    resolveError?: (gateId: string) => string | undefined;
    listError?: string;
  } = {},
): FakeBd {
  const calls: string[][] = [];
  const minted = [...(options.minted ?? [])];
  let nextMinted = 0;

  function listGates(beadId: string): { stdout: string } {
    if (options.listError !== undefined) throw new Error(options.listError);
    const gates = options.openGates?.(beadId) ?? [];
    // bd answers `null` (not `[]`) for a bead with no open gates.
    return { stdout: JSON.stringify(gates.length === 0 ? null : gates) };
  }

  function createGate(): { stdout: string } {
    const id = minted[nextMinted] ?? `bd-9${nextMinted + 1}`;
    nextMinted += 1;
    return { stdout: JSON.stringify({ id, status: "open", await_type: "human" }) };
  }

  function resolveGate(gateId: string): { stdout: string } {
    const failure = options.resolveError?.(gateId);
    if (failure !== undefined) throw new Error(failure);
    return { stdout: `✓ Gate resolved: ${gateId}\n` };
  }

  function answer(argv: readonly string[]): { stdout: string } {
    const verb = argv[1];
    if (argv[0] !== "gate") return { stdout: "" };
    if (verb === "list") return listGates(argv[2] ?? "");
    if (verb === "create") return createGate();
    if (verb === "resolve") return resolveGate(argv[2] ?? "");
    return { stdout: "" };
  }

  return {
    calls,
    runBd: async (argv, runnerOptions) => {
      calls.push([...argv]);
      // The lookup refuses a bead id that could be read as a flag before spawning.
      expect(runnerOptions.cwd).toBe("/repo");
      return answer(argv);
    },
  };
}

/** An open ordering gate record as bd would render it. */
function openMarkerGate(input: {
  id: string;
  fleetId?: string;
  blocker: string;
  blocked: string;
}): unknown {
  const marker =
    `${FLEET_ORDERING_GATE_PREFIX} fleet:${input.fleetId ?? "default"} ` +
    `${input.blocker} -> ${input.blocked}`;
  return {
    id: input.id,
    status: "open",
    await_type: "human",
    title: marker,
    description: `Ad-hoc gate blocking ${input.blocked}\n\nReason: ${marker}`,
  };
}

describe("createFleetOrderingGates", () => {
  const edges = [
    { blocker: "bd-12", blocked: "bd-13" },
    { blocker: "bd-99", blocked: "bd-12" },
  ];

  it("creates one gate per internal edge and records the minted id", async () => {
    const bd = fakeBd({ minted: ["bd-900"] });
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13"],
      edges,
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toEqual({
      ok: true,
      gates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" }],
      created: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" }],
      adopted: [],
      warnings: [],
    });
    // One list (bd truth) then one create.
    expect(bd.calls.map((call) => call[1])).toEqual(["list", "create"]);
    expect(bd.calls[1]?.slice(0, 4)).toEqual(["gate", "create", "--blocks", "bd-13"]);
  });

  it("does not create a second gate for an edge it already recorded", async () => {
    const bd = fakeBd();
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13"],
      edges,
      existing: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" }],
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toEqual({ ok: true, gates: [], created: [], adopted: [], warnings: [] });
    expect(bd.calls).toEqual([]);
  });

  it("adopts the gate bd already has when the record was lost", async () => {
    // W4: record loss (truncation, a crash before the intent write) must not mint
    // a second gate for the same edge — the first would become an orphan.
    const bd = fakeBd({
      openGates: (beadId) =>
        beadId === "bd-13"
          ? [openMarkerGate({ id: "bd-940", blocker: "bd-12", blocked: "bd-13" })]
          : [],
    });
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13"],
      edges,
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toEqual({
      ok: true,
      gates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-940" }],
      created: [],
      adopted: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-940" }],
      warnings: [],
    });
    expect(bd.calls.some((call) => call[1] === "create")).toBe(false);
  });

  it("resolves a duplicate gate for the same edge instead of leaving it behind", async () => {
    const bd = fakeBd({
      openGates: () => [
        openMarkerGate({ id: "bd-940", blocker: "bd-12", blocked: "bd-13" }),
        openMarkerGate({ id: "bd-941", blocker: "bd-12", blocked: "bd-13" }),
      ],
    });
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13"],
      edges,
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toEqual({
      ok: true,
      gates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-940" }],
      created: [],
      adopted: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-940" }],
      warnings: [],
    });
    expect(bd.calls.filter((call) => call[1] === "resolve")).toEqual([
      ["gate", "resolve", "bd-941"],
    ]);
  });

  it("ignores another fleet's ordering gate for the same beads", async () => {
    const bd = fakeBd({
      minted: ["bd-950"],
      openGates: () => [
        openMarkerGate({ id: "bd-940", fleetId: "other", blocker: "bd-12", blocked: "bd-13" }),
      ],
    });
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13"],
      edges,
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toEqual({
      ok: true,
      gates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-950" }],
      created: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-950" }],
      adopted: [],
      warnings: [],
    });
  });

  it("refuses to guess when bd cannot list the dependent's gates", async () => {
    const bd = fakeBd({ listError: "bd: database unavailable" });
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13"],
      edges,
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("database unavailable");
    expect(bd.calls.some((call) => call[1] === "create")).toBe(false);
  });

  it("reports bd's failure together with the gates it had already created", async () => {
    let creates = 0;
    const runBd: FakeBd["runBd"] = async (argv) => {
      if (argv[1] === "list") return { stdout: "null" };
      creates += 1;
      if (creates > 1) throw new Error("bd: database unavailable");
      return { stdout: JSON.stringify({ id: "bd-900", status: "open" }) };
    };
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13", "bd-14"],
      edges: [
        { blocker: "bd-12", blocked: "bd-13" },
        { blocker: "bd-12", blocked: "bd-14" },
      ],
      cwd: "/repo",
      runBd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("database unavailable");
    // `created` is the rollback list: exactly the one gate this attempt minted.
    expect(result.created).toEqual([{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" }]);
  });

  it("tells the operator how to finish a create that exited 0 with no gate id", async () => {
    // W2: a successful exit with unreadable output is a bd version/payload
    // mismatch. The launch is refused (no gate-less fallback: without the gate the
    // dependent stays bd-blocked forever), so the message must name what to check
    // and the exact command that completes the work by hand.
    const runBd: FakeBd["runBd"] = async (argv) => {
      if (argv[1] === "list") return { stdout: "null" };
      return { stdout: "gate created\n" };
    };
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13"],
      edges: [{ blocker: "bd-12", blocked: "bd-13" }],
      cwd: "/repo",
      runBd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bd-12 -> bd-13");
    expect(result.error).toContain("exited 0");
    expect(result.error).toContain("bd version");
    expect(result.error).toContain("Created gate bd-N");
    expect(result.error).toContain("launch was refused and nothing was left open");
    expect(result.error).toContain(
      "bd gate create --blocks bd-13 --type=human --title " +
        "'belayd-fleet-ordering: fleet:default bd-12 -> bd-13'",
    );
    expect(result.created).toEqual([]);
  });

  it("relaunches a fleet already at the bound when every edge is adopted", async () => {
    // W1: adoption adds a record, not a creation. Counting the planned edge as if
    // it were new would refuse a launch that creates zero gates — and then the
    // refusal would resolve the fleet's live ordering, stranding it half-ordered.
    const atBound = Array.from({ length: FLEET_INTENT_ORDERING_GATES_MAX - 1 }, (_, index) => ({
      blocker: `bd-${3000 + index}`,
      blocked: `bd-${4000 + index}`,
      gateId: `bd-${5000 + index}`,
    }));
    const bd = fakeBd({
      openGates: (beadId) =>
        beadId === "bd-13"
          ? [openMarkerGate({ id: "bd-940", blocker: "bd-12", blocked: "bd-13" })]
          : [],
    });
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13"],
      edges: [{ blocker: "bd-12", blocked: "bd-13" }],
      existing: atBound,
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toEqual({
      ok: true,
      gates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-940" }],
      created: [],
      adopted: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-940" }],
      warnings: [],
    });
    // Adoption is a read: nothing was created and nothing was resolved.
    expect(bd.calls.map((call) => call[1])).toEqual(["list"]);
  });

  it("refuses before creating anything when one new record would pass the bound", async () => {
    const atBound = Array.from({ length: FLEET_INTENT_ORDERING_GATES_MAX }, (_, index) => ({
      blocker: `bd-${3000 + index}`,
      blocked: `bd-${4000 + index}`,
      gateId: `bd-${5000 + index}`,
    }));
    const bd = fakeBd({ minted: ["bd-950"] });
    const result = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: ["bd-12", "bd-13"],
      edges: [{ blocker: "bd-12", blocked: "bd-13" }],
      existing: atBound,
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(`${FLEET_INTENT_ORDERING_GATES_MAX}-gate bound`);
    // Refused in the read phase, so there is nothing of this attempt's to roll back
    // — and the pre-existing records were never resolved.
    expect(result.created).toEqual([]);
    expect(bd.calls.map((call) => call[1])).toEqual(["list"]);
  });
});

describe("resolveFleetOrderingGates", () => {
  const firstGate = { blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" };
  const recorded: readonly FleetOrderingGate[] = [
    firstGate,
    { blocker: "bd-14", blocked: "bd-15", gateId: "bd-901" },
  ];

  it("resolves the selected gates and keeps the others recorded", async () => {
    const bd = fakeBd();
    const result = await resolveFleetOrderingGates({
      gates: recorded,
      blocker: "bd-12",
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toEqual({ ok: true, resolved: [recorded[0]], remaining: [recorded[1]] });
    expect(bd.calls).toEqual([["gate", "resolve", "bd-900"]]);
  });

  it("treats bd's exact unknown-gate answer as resolved", async () => {
    const bd = fakeBd({ resolveError: (gateId) => `Error: gate not found: ${gateId}` });
    const result = await resolveFleetOrderingGates({
      gates: recorded,
      cwd: "/repo",
      runBd: bd.runBd,
    });
    // Idempotence: a second tick after a crash must not report a failure that
    // did not happen.
    expect(result).toEqual({ ok: true, resolved: recorded, remaining: [] });
  });

  it("does not accept a not-found answer that names a different gate id", async () => {
    // The message must be about the gate that was asked about, or a stale error
    // from another call would resolve this record.
    const bd = fakeBd({ resolveError: () => "Error: gate not found: bd-999" });
    const result = await resolveFleetOrderingGates({
      gates: [firstGate],
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toHaveProperty("ok", false);
  });

  it("does not read a database error as an already-resolved gate", async () => {
    // W2: "not found" appears in ordinary bd failures; only `gate not found: <id>`
    // may count as resolved, or a live gate's record is dropped and the dependent
    // stays blocked with nothing able to resolve it.
    const bd = fakeBd({ resolveError: () => "Error: database file not found: /repo/.beads/db" });
    const result = await resolveFleetOrderingGates({
      gates: [firstGate],
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual([recorded[0]]);
  });

  it("fails loudly on any other bd error and keeps the gate recorded", async () => {
    const bd = fakeBd({ resolveError: () => "Error: database is locked" });
    const result = await resolveFleetOrderingGates({
      gates: recorded,
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("database is locked");
    expect(result.remaining).toEqual(recorded);
  });

  it("matches either side of a bead, so a closed bead reaps its gates", async () => {
    const bd = fakeBd();
    const result = await resolveFleetOrderingGatesForBead({
      gates: recorded,
      beadId: "bd-14",
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toEqual({ ok: true, resolved: [recorded[1]], remaining: [recorded[0]] });
    expect(bd.calls).toEqual([["gate", "resolve", "bd-901"]]);
  });
});

describe("reapFleetOrderingGatesByPrefix", () => {
  it("resolves the fleet's own unrecorded gates and leaves other fleets alone", async () => {
    const gatesByBead = new Map<string, readonly unknown[]>([
      [
        "bd-13",
        [
          openMarkerGate({ id: "bd-930", blocker: "bd-12", blocked: "bd-13" }),
          openMarkerGate({ id: "bd-931", fleetId: "other", blocker: "bd-12", blocked: "bd-13" }),
        ],
      ],
    ]);
    const bd = fakeBd({ openGates: (beadId) => gatesByBead.get(beadId) ?? [] });
    const result = await reapFleetOrderingGatesByPrefix({
      fleetId: "default",
      beadIds: ["bd-13", "bd-13"],
      scope: "whole-bead",
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result).toEqual({
      ok: true,
      resolved: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-930" }],
      warnings: [],
    });
    // One read for the de-duplicated bead, one resolve for this fleet's gate.
    expect(bd.calls).toEqual([
      ["gate", "list", "bd-13", "--json"],
      ["gate", "resolve", "bd-930"],
    ]);
  });

  it("resolves only the edges a scoped caller created", async () => {
    // S1: the scope discriminator, not an optional edge list, says what the caller
    // owns. A rollback that resolved the whole bead would also destroy the fleet's
    // pre-existing ordering for an edge it never touched.
    const gatesByBead = new Map<string, readonly unknown[]>([
      [
        "bd-13",
        [
          openMarkerGate({ id: "bd-930", blocker: "bd-12", blocked: "bd-13" }),
          openMarkerGate({ id: "bd-931", blocker: "bd-14", blocked: "bd-13" }),
        ],
      ],
    ]);
    const bd = fakeBd({ openGates: (beadId) => gatesByBead.get(beadId) ?? [] });
    const scoped = await reapFleetOrderingGatesByPrefix({
      fleetId: "default",
      beadIds: ["bd-13"],
      scope: "created-edges",
      edges: [{ blocker: "bd-12", blocked: "bd-13" }],
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(scoped).toEqual({
      ok: true,
      resolved: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-930" }],
      warnings: [],
    });

    // The whole-bead scope is the "member is gone" form: both gates go.
    const whole = await reapFleetOrderingGatesByPrefix({
      fleetId: "default",
      beadIds: ["bd-13"],
      scope: "whole-bead",
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(whole.resolved.map((gate) => gate.gateId)).toEqual(["bd-930", "bd-931"]);
  });

  it("skips a bead id that could be read as a flag and reports read failures", async () => {
    const bd = fakeBd({ listError: "bd: database unavailable" });
    const result = await reapFleetOrderingGatesByPrefix({
      fleetId: "default",
      beadIds: ["--json", "bd-13"],
      scope: "whole-bead",
      cwd: "/repo",
      runBd: bd.runBd,
    });
    expect(result.ok).toBe(false);
    expect(bd.calls).toEqual([["gate", "list", "bd-13", "--json"]]);
  });
});

describe("listFleetOrderingGatesForBead", () => {
  it("refuses a bead id that could be read as a flag, without spawning bd", async () => {
    let spawned = false;
    const result = await listFleetOrderingGatesForBead({
      beadId: "--all",
      cwd: "/repo",
      runBd: async () => {
        spawned = true;
        return { stdout: "null" };
      },
    });
    expect(result.ok).toBe(false);
    expect(spawned).toBe(false);
  });

  it("parses bd's null answer as no open gates", async () => {
    const result = await listFleetOrderingGatesForBead({
      beadId: "bd-13",
      cwd: "/repo",
      runBd: async () => ({ stdout: "null" }),
    });
    expect(result).toEqual({ ok: true, gates: [], drifts: [] });
  });

  it("surfaces reason drift as a warning without dropping the gate", async () => {
    const record = {
      id: "bd-940",
      status: "open",
      await_type: "human",
      title: `${FLEET_ORDERING_GATE_PREFIX} fleet:default bd-12 -> bd-13`,
      // bd truncated the reason: the title still classifies, the marker in the
      // reason no longer parses, and the operator is told.
      description: `Reason: ${FLEET_ORDERING_GATE_PREFIX} fleet:default bd-`,
    };
    const result = await listFleetOrderingGatesForBead({
      beadId: "bd-13",
      cwd: "/repo",
      runBd: async () => ({ stdout: JSON.stringify([record]) }),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.gates).toEqual([
      { gateId: "bd-940", fleetId: "default", blocker: "bd-12", blocked: "bd-13" },
    ]);
    expect(result.drifts.map((drift) => drift.message).join("\n")).toContain(
      "classified from the title",
    );
    expect(result.drifts.map((drift) => drift.gateId)).toEqual(["bd-940"]);
  });
});
