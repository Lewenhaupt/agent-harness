/**
 * Unit tests for the P3 scheduler (bd-126): the pure ordering/wave/capacity
 * function and the bd dependency-graph parser.
 *
 * Everything here is data in / data out — no git, no bd, no filesystem — because
 * that is exactly the property P3 claims: the launch engine can be reasoned about
 * (and a cycle refused) without touching a repository.
 */

import { describe, expect, it } from "vitest";
import type { FleetSchedule } from "../fleet-schedule.js";
import {
  type FleetDependencyEdge,
  parseFleetDependencyEdges,
  planFleetSchedule,
} from "../fleet-schedule.js";

function scheduleOrFail(input: {
  taskIds: readonly string[];
  edges?: readonly FleetDependencyEdge[];
  capacity?: number;
  activeCount?: number;
}): FleetSchedule {
  const result = planFleetSchedule({
    taskIds: input.taskIds,
    edges: input.edges ?? [],
    capacity: input.capacity ?? 3,
    activeCount: input.activeCount ?? 0,
  });
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}: ${result.text}`);
  return result.schedule;
}

describe("planFleetSchedule: order, waves, capacity", () => {
  it("keeps caller order and starts everything when there is capacity", () => {
    const schedule = scheduleOrFail({ taskIds: ["bd-12", "bd-15"] });
    expect(schedule).toHaveProperty("slots", 3);
    expect(schedule.launchNow).toEqual(["bd-12", "bd-15"]);
    expect(schedule.waves).toEqual([{ index: 0, taskIds: ["bd-12", "bd-15"] }]);
    expect(schedule.deferred).toEqual([]);
    expect(schedule.reasons[0]).toContain("capacity 3, 0 orchestrator(s) already active → 3");
  });

  it("launches only the free slots and defers the rest for capacity", () => {
    const schedule = scheduleOrFail({
      taskIds: ["bd-12", "bd-15", "bd-19", "bd-22", "bd-25"],
    });
    expect(schedule.launchNow).toEqual(["bd-12", "bd-15", "bd-19"]);
    expect(schedule.deferred.map((deferral) => deferral.taskId)).toEqual(["bd-22", "bd-25"]);
    expect(schedule.deferred.every((deferral) => deferral.reason === "capacity")).toBe(true);
    // The remainder is planned in wave 0, so nothing is dropped or reordered.
    expect(schedule.waves[0]?.taskIds).toEqual(["bd-12", "bd-15", "bd-19", "bd-22", "bd-25"]);
  });

  it("counts orchestrators already active against the same ceiling", () => {
    const schedule = scheduleOrFail({
      taskIds: ["bd-12", "bd-15", "bd-19"],
      capacity: 3,
      activeCount: 2,
    });
    expect(schedule).toHaveProperty("slots", 1);
    expect(schedule).toHaveProperty("activeCount", 2);
    expect(schedule.launchNow).toEqual(["bd-12"]);
    expect(schedule.deferred.map((deferral) => [deferral.taskId, deferral.reason])).toEqual([
      ["bd-15", "capacity"],
      ["bd-19", "capacity"],
    ]);
  });

  it("starts nothing when every slot is occupied", () => {
    const schedule = scheduleOrFail({
      taskIds: ["bd-12", "bd-15"],
      activeCount: 3,
    });
    expect(schedule).toHaveProperty("slots", 0);
    expect(schedule.launchNow).toEqual([]);
    expect(schedule.deferred).toHaveLength(2);
    expect(schedule.deferred.every((deferral) => deferral.reason === "capacity")).toBe(true);
  });

  it("orders a blocked member into a later wave instead of the input order", () => {
    // bd-15 is listed first but bd-12 blocks it, so bd-12 is wave 0.
    const schedule = scheduleOrFail({
      taskIds: ["bd-15", "bd-12", "bd-19"],
      edges: [{ blocker: "bd-12", blocked: "bd-15" }],
    });
    expect(schedule.waves).toEqual([
      { index: 0, taskIds: ["bd-12", "bd-19"] },
      { index: 1, taskIds: ["bd-15"] },
    ]);
    expect(schedule.launchNow).toEqual(["bd-12", "bd-19"]);
    expect(schedule.deferred).toEqual([
      {
        taskId: "bd-15",
        reason: "dependency",
        wave: 1,
        blockers: ["bd-12"],
        detail:
          "wave 1: waits for bd-12 to land (launched by a later fleet launch or by " +
          "belayd_fleet_advance)",
      },
    ]);
  });

  it("computes one wave per dependency level, keeping caller order inside a wave", () => {
    const schedule = scheduleOrFail({
      taskIds: ["bd-12", "bd-15", "bd-19"],
      edges: [
        { blocker: "bd-12", blocked: "bd-15" },
        { blocker: "bd-15", blocked: "bd-19" },
      ],
    });
    expect(schedule.waves.map((wave) => wave.taskIds)).toEqual([["bd-12"], ["bd-15"], ["bd-19"]]);
    expect(schedule.launchNow).toEqual(["bd-12"]);
  });

  it("defers a member whose blocker is outside this launch", () => {
    const schedule = scheduleOrFail({
      taskIds: ["bd-12", "bd-15"],
      edges: [{ blocker: "bd-9", blocked: "bd-15" }],
    });
    expect(schedule.waves).toEqual([{ index: 0, taskIds: ["bd-12"] }]);
    expect(schedule.launchNow).toEqual(["bd-12"]);
    expect(schedule.deferred).toEqual([
      {
        taskId: "bd-15",
        reason: "external-blocker",
        blockers: ["bd-9"],
        detail:
          "blocked by bd-9, which is not part of this launch; it cannot be planned for any wave " +
          "until that bead lands",
      },
    ]);
    expect(schedule.reasons.join("\n")).toContain("blocked by a bead outside this launch");
  });

  it("propagates an external blocker through in-set edges", () => {
    const schedule = scheduleOrFail({
      taskIds: ["bd-12", "bd-15"],
      edges: [
        { blocker: "bd-9", blocked: "bd-12" },
        { blocker: "bd-12", blocked: "bd-15" },
      ],
    });
    expect(schedule.waves).toEqual([]);
    expect(schedule.launchNow).toEqual([]);
    expect(schedule.deferred.map((deferral) => [deferral.taskId, deferral.reason])).toEqual([
      ["bd-12", "external-blocker"],
      ["bd-15", "dependency"],
    ]);
    expect(schedule.deferred[1]?.blockers).toEqual(["bd-12"]);
  });

  it("refuses a dependency cycle with the cycle path instead of looping", () => {
    const result = planFleetSchedule({
      taskIds: ["bd-12", "bd-15"],
      edges: [
        { blocker: "bd-15", blocked: "bd-12" },
        { blocker: "bd-12", blocked: "bd-15" },
      ],
      capacity: 3,
      activeCount: 0,
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("dependency-cycle");
    expect(result.cycle).toBeDefined();
    const cycle = result.cycle ?? [];
    expect(cycle.length).toBeGreaterThanOrEqual(3);
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    expect(new Set(cycle).size).toBe(cycle.length - 1);
    expect(result.text).toContain(cycle.join(" → "));
    expect(result.text).toContain("nothing was created");
  });

  it("detects a self-dependency as a cycle", () => {
    const result = planFleetSchedule({
      taskIds: ["bd-12"],
      edges: [{ blocker: "bd-12", blocked: "bd-12" }],
      capacity: 3,
      activeCount: 0,
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("dependency-cycle");
    expect(result.cycle).toEqual(["bd-12", "bd-12"]);
  });

  it("is deterministic regardless of edge order", () => {
    const edges: FleetDependencyEdge[] = [
      { blocker: "bd-12", blocked: "bd-19" },
      { blocker: "bd-15", blocked: "bd-19" },
      { blocker: "bd-12", blocked: "bd-15" },
    ];
    const forward = scheduleOrFail({ taskIds: ["bd-19", "bd-15", "bd-12"], edges });
    const reversed = scheduleOrFail({
      taskIds: ["bd-19", "bd-15", "bd-12"],
      edges: [...edges].reverse(),
    });
    expect(reversed).toEqual(forward);
    expect(forward.waves.map((wave) => wave.taskIds)).toEqual([["bd-12"], ["bd-15"], ["bd-19"]]);
  });

  it("ignores edges that do not involve the planned members", () => {
    const schedule = scheduleOrFail({
      taskIds: ["bd-12"],
      edges: [
        { blocker: "bd-15", blocked: "bd-19" },
        { blocker: "bd-15", blocked: "bd-12" },
      ],
    });
    // bd-15 is not in the plan, so it is an external blocker, not a wave.
    expect(schedule.deferred).toHaveLength(1);
    expect(schedule.deferred[0]?.reason).toBe("external-blocker");
  });

  it("deduplicates repeated ids and says so", () => {
    const schedule = scheduleOrFail({ taskIds: ["bd-12", "bd-12", "bd-15"] });
    expect(schedule.launchNow).toEqual(["bd-12", "bd-15"]);
    expect(schedule.warnings).toContain("duplicate task id(s) ignored while scheduling: bd-12");
  });

  it("treats an unusable active count as zero with a warning", () => {
    const schedule = scheduleOrFail({ taskIds: ["bd-12"], activeCount: Number.NaN });
    expect(schedule).toHaveProperty("activeCount", 0);
    expect(schedule.warnings.join("\n")).toContain("assuming 0");
  });

  it("refuses an empty list and an unusable capacity", () => {
    const empty = planFleetSchedule({ taskIds: [], edges: [], capacity: 3, activeCount: 0 });
    expect(empty).toHaveProperty("ok", false);
    if (!empty.ok) expect(empty.reason).toBe("no-tasks");

    const capacity = planFleetSchedule({
      taskIds: ["bd-12"],
      edges: [],
      capacity: 0,
      activeCount: 0,
    });
    expect(capacity).toHaveProperty("ok", false);
    if (!capacity.ok) expect(capacity.reason).toBe("invalid-capacity");
  });
});

describe("parseFleetDependencyEdges: bd's blocking graph", () => {
  const bdShow = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    id: "bd-55",
    dependencies: [
      { id: "bd-19", status: "open", dependency_type: "blocks" },
      ...(Array.isArray(overrides.dependencies) ? overrides.dependencies : []),
    ],
    ...overrides,
  });

  it("reads blocking dependencies as blocker → blocked edges", () => {
    const graph = parseFleetDependencyEdges([bdShow({})], ["bd-19", "bd-55"]);
    expect(graph.edges).toEqual([{ blocker: "bd-19", blocked: "bd-55" }]);
    expect(graph.warnings).toEqual([]);
  });

  it("ignores non-blocking relationship types", () => {
    const graph = parseFleetDependencyEdges(
      [
        {
          id: "bd-55",
          dependencies: [{ id: "bd-19", status: "open", dependency_type: "related" }],
        },
      ],
      ["bd-19", "bd-55"],
    );
    expect(graph.edges).toEqual([]);
  });

  it("drops a blocker that has already finished", () => {
    const graph = parseFleetDependencyEdges(
      [
        {
          id: "bd-55",
          dependencies: [{ id: "bd-19", status: "closed", dependency_type: "blocks" }],
        },
      ],
      ["bd-19", "bd-55"],
    );
    expect(graph.edges).toEqual([]);
  });

  it("keeps an external blocker unfinished so the scheduler can wait on it", () => {
    const graph = parseFleetDependencyEdges(
      [
        {
          id: "bd-55",
          dependencies: [{ id: "bd-9", status: "in_progress", dependency_type: "blocks" }],
        },
      ],
      ["bd-55"],
    );
    expect(graph.edges).toEqual([{ blocker: "bd-9", blocked: "bd-55" }]);
  });

  it("ignores records for beads that are not being launched", () => {
    const graph = parseFleetDependencyEdges([bdShow({ id: "bd-99" })], ["bd-19", "bd-55"]);
    expect(graph.edges).toEqual([]);
  });

  it("degrades to no edges with a warning on unreadable output", () => {
    for (const raw of [undefined, null, "not json", { issues: [] }]) {
      const graph = parseFleetDependencyEdges(raw, ["bd-55"]);
      expect(graph.edges).toEqual([]);
      expect(graph.warnings.join("\n")).toContain("without dependency ordering");
    }
  });

  it("warns about malformed dependency records instead of inventing an edge", () => {
    const graph = parseFleetDependencyEdges(
      [{ id: "bd-55", dependencies: [{ status: "open", dependency_type: "blocks" }, null] }],
      ["bd-55"],
    );
    expect(graph.edges).toEqual([]);
    expect(graph.warnings.join("\n")).toContain("unreadable dependency record(s) ignored");
  });

  it("deduplicates edges and orders them by the caller's task order", () => {
    const graph = parseFleetDependencyEdges(
      [
        { id: "bd-15", dependencies: [{ id: "bd-12", status: "open", dependency_type: "blocks" }] },
        {
          id: "bd-12",
          dependencies: [{ id: "bd-9", status: "open", dependency_type: "blocks" }],
        },
        { id: "bd-15", dependencies: [{ id: "bd-12", status: "open", dependency_type: "blocks" }] },
      ],
      ["bd-12", "bd-15"],
    );
    expect(graph.edges).toEqual([
      { blocker: "bd-9", blocked: "bd-12" },
      { blocker: "bd-12", blocked: "bd-15" },
    ]);
  });
});
