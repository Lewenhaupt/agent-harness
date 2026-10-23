/**
 * Tests for the batched read-only bead lookup seam (bd-126 P0 successor).
 *
 * The runner is injected, so the read-only invariant is exercised where it
 * runs: a guard that only inspected a hard-coded builder could never be tested,
 * and would silently pass if the argv ever changed.
 */

import { describe, expect, it, vi } from "vitest";

import {
  FLEET_BEAD_LOOKUP_MAX_BUFFER_BYTES,
  FLEET_BEAD_LOOKUP_TIMEOUT_MS,
  type FleetBeadRunner,
  lookupFleetBeads,
  lookupFleetDependencies,
} from "../fleet-beads.js";

function recorder(stdout = "[]"): {
  runBd: FleetBeadRunner;
  calls: Array<{ argv: readonly string[]; options: unknown }>;
} {
  const calls: Array<{ argv: readonly string[]; options: unknown }> = [];
  const runBd: FleetBeadRunner = async (argv, options) => {
    calls.push({ argv, options });
    return { stdout };
  };
  return { runBd, calls };
}

describe("lookupFleetBeads", () => {
  it("skips bd entirely when there is no task id to ask about", async () => {
    const { runBd, calls } = recorder();

    expect(await lookupFleetBeads({ taskIds: [], cwd: "/repo", runBd })).toEqual({
      ok: true,
      beads: [],
    });
    expect(calls).toEqual([]);
  });

  it("runs one batched read-only show with bounded process limits", async () => {
    const { runBd, calls } = recorder(
      JSON.stringify([{ id: "bd-12", title: "Fix login", status: "open", priority: 1 }]),
    );

    const result = await lookupFleetBeads({ taskIds: ["bd-12", "bd-15"], cwd: "/repo", runBd });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.beads.map((bead) => bead.id)).toEqual(["bd-12"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["show", "bd-12", "bd-15", "--json"]);
    expect(calls[0]?.options).toEqual({
      cwd: "/repo",
      stdin: undefined,
      timeoutInMs: FLEET_BEAD_LOOKUP_TIMEOUT_MS,
      maxBufferInBytes: FLEET_BEAD_LOOKUP_MAX_BUFFER_BYTES,
    });
  });

  it("refuses a non-read argv without spawning bd", async () => {
    const runBd = vi.fn<FleetBeadRunner>();

    const result = await lookupFleetBeads({
      taskIds: ["bd-12"],
      cwd: "/repo",
      runBd,
      // Simulates a future (or injected) builder regressing to a mutation.
      buildArgv: () => ["update", "bd-12", "--claim"],
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain('refusing non-read bd subcommand "update"');
    expect(runBd).not.toHaveBeenCalled();
  });

  it("refuses an argv with no subcommand at all without spawning bd", async () => {
    const runBd = vi.fn<FleetBeadRunner>();

    const result = await lookupFleetBeads({
      taskIds: ["bd-12"],
      cwd: "/repo",
      runBd,
      buildArgv: () => [],
    });

    expect(result).toHaveProperty("ok", false);
    expect(runBd).not.toHaveBeenCalled();
  });

  it("degrades to an error value when bd fails or prints non-JSON", async () => {
    const failing: FleetBeadRunner = async () => {
      throw new Error("no beads database found");
    };
    const failed = await lookupFleetBeads({ taskIds: ["bd-12"], cwd: "/repo", runBd: failing });
    expect(failed).toHaveProperty("ok", false);
    if (failed.ok) return;
    expect(failed.error).toContain("no beads database found");

    const { runBd } = recorder("Warning: .beads has permissions 0755");
    const malformed = await lookupFleetBeads({ taskIds: ["bd-12"], cwd: "/repo", runBd });
    expect(malformed).toHaveProperty("ok", false);
  });

  it("flattens an envelope payload to no beads rather than throwing", async () => {
    // bd wrapping its records would otherwise look like "the beads vanished";
    // the fleet layer turns this into a bounded warning instead of silence.
    const { runBd } = recorder(JSON.stringify({ issues: [{ id: "bd-12" }] }));

    const result = await lookupFleetBeads({ taskIds: ["bd-12"], cwd: "/repo", runBd });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.beads).toEqual([]);
  });
});

describe("lookupFleetDependencies (P3)", () => {
  it("reads one batched dependency graph with --brief-deps and no spawn for an empty set", async () => {
    const { runBd, calls } = recorder();
    expect(await lookupFleetDependencies({ taskIds: [], cwd: "/repo", runBd })).toEqual({
      edges: [],
      warnings: [],
    });
    expect(calls).toEqual([]);

    const populated = recorder(
      JSON.stringify([
        {
          id: "bd-15",
          dependencies: [{ id: "bd-12", status: "open", dependency_type: "blocks" }],
        },
      ]),
    );
    const graph = await lookupFleetDependencies({
      taskIds: ["bd-12", "bd-15"],
      cwd: "/repo",
      runBd: populated.runBd,
    });
    expect(graph.edges).toEqual([{ blocker: "bd-12", blocked: "bd-15" }]);
    expect(populated.calls[0]?.argv).toEqual(["show", "bd-12", "bd-15", "--json", "--brief-deps"]);
    expect(populated.calls[0]?.options).toMatchObject({
      cwd: "/repo",
      timeoutInMs: FLEET_BEAD_LOOKUP_TIMEOUT_MS,
    });
  });

  it("refuses a non-read argv without spawning bd", async () => {
    const runBd = vi.fn<FleetBeadRunner>();
    const graph = await lookupFleetDependencies({
      taskIds: ["bd-12"],
      cwd: "/repo",
      runBd,
      buildArgv: () => ["update", "bd-12", "--claim"],
    });
    expect(graph.edges).toEqual([]);
    expect(graph.warnings.join("\n")).toContain('refusing non-read bd subcommand "update"');
    expect(runBd).not.toHaveBeenCalled();
  });

  it("degrades to no edges when bd fails or prints garbage", async () => {
    const failing: FleetBeadRunner = async () => {
      throw new Error("bd: not found");
    };
    const failed = await lookupFleetDependencies({
      taskIds: ["bd-12"],
      cwd: "/repo",
      runBd: failing,
    });
    expect(failed.edges).toEqual([]);
    expect(failed.warnings.join("\n")).toContain("bd: not found");

    const garbage = await lookupFleetDependencies({
      taskIds: ["bd-12"],
      cwd: "/repo",
      runBd: recorder("this is not json").runBd,
    });
    expect(garbage.edges).toEqual([]);
    expect(garbage.warnings.join("\n")).toContain("without dependency ordering");
  });
});
