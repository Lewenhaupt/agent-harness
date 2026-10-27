/**
 * Unit tests for fleet launch (bd-126 P1): ceiling, validation, command parsing,
 * intent merge, report rendering, and the launch engine itself.
 *
 * The engine is exercised with an injected fake fs and an injected member
 * launcher, so "zero side effects on a refusal" and "one member failing does not
 * abort the rest" are asserted on the writes that actually happened rather than
 * on mocks of them.
 */

import { describe, expect, it } from "vitest";
import {
  collectFleetLaunchContext,
  countActiveFleetOrchestrators,
  FLEET_MAX_CONCURRENT_ORCHESTRATORS,
  type FleetLaunchFleet,
  type FleetMemberLaunchOutcome,
  fleetUsageText,
  formatFleetLaunchReport,
  mergeFleetIntent,
  parseFleetCommandArgs,
  parseFleetTaskIds,
  planFleetAdvance,
  resolveFleetConcurrency,
  runFleetLaunch,
  validateFleetLaunch,
} from "../fleet-launch.js";
import { recordRunMemberStopped, startFleetRun } from "../fleet-run.js";
import { fleetDir, formatAuditEntry } from "../fleet-state.js";
import {
  FLEET_INTENT_DEFERRED_MAX,
  FLEET_INTENT_ORDERING_GATES_MAX,
  type FleetIntent,
} from "../fleet-status.js";
import { createFakeFleetFs } from "./helpers/fake-fleet-fs.js";

const commonDir = "/repo/.git";
const fleetId = "default";
const maxChars = FLEET_MAX_CONCURRENT_ORCHESTRATORS;

describe("concurrency ceiling", () => {
  it("defaults to the ceiling and keeps a smaller request", () => {
    expect(resolveFleetConcurrency(undefined)).toEqual({ maxConcurrent: maxChars });
    expect(resolveFleetConcurrency(1)).toEqual({ maxConcurrent: 1 });
    expect(resolveFleetConcurrency(3)).toEqual({ maxConcurrent: 3 });
  });

  it("clamps a request above the ceiling and says what it clamped", () => {
    expect(resolveFleetConcurrency(5)).toEqual({ maxConcurrent: maxChars, clampedFrom: 5 });
    expect(resolveFleetConcurrency(9.9)).toEqual({ maxConcurrent: maxChars, clampedFrom: 9.9 });
  });

  it("reports a fraction it floored instead of silently storing a different number (S2)", () => {
    expect(resolveFleetConcurrency(2.5)).toEqual({ maxConcurrent: 2, flooredFrom: 2.5 });
    expect(resolveFleetConcurrency(3.9)).toEqual({ maxConcurrent: maxChars, flooredFrom: 3.9 });
  });

  it("ignores an unusable request instead of failing the launch", () => {
    for (const requested of [0, -2, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resolved = resolveFleetConcurrency(requested);
      expect(resolved.maxConcurrent).toBe(maxChars);
      expect(resolved.ignoredRequested).toBe(requested);
      expect(resolved.clampedFrom).toBe(undefined);
      expect(resolved.flooredFrom).toBe(undefined);
    }
  });
});

/** One fleet record for validation inputs; the target fleet is usually `default`. */
function fleet(
  fleetId: string,
  members: readonly string[],
  supervisor: FleetLaunchFleet["supervisor"] = { kind: "none" },
): FleetLaunchFleet {
  return { fleetId, members, supervisor };
}

describe("validateFleetLaunch", () => {
  const base = {
    fleets: [] as readonly FleetLaunchFleet[],
    targetFleetId: fleetId,
    sessionId: "supervisor-session",
  };

  it("accepts a fresh list and reports the resolved ceiling", () => {
    const result = validateFleetLaunch({
      ...base,
      taskIds: ["bd-12", "bd-15"],
      requestedConcurrency: 7,
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.taskIds).toEqual(["bd-12", "bd-15"]);
    expect(result.rearmedTaskIds).toEqual([]);
    expect(result.rearm).toBe(false);
    expect(result.maxConcurrent).toBe(maxChars);
    expect(result.clampedFrom).toBe(7);
  });

  it("refuses an empty list", () => {
    const result = validateFleetLaunch({ ...base, taskIds: [] });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.refusals[0]?.reason).toBe("empty-task-list");
    expect(result.error).toContain("nothing was created");
  });

  it("collects every problem instead of stopping at the first", () => {
    const result = validateFleetLaunch({
      ...base,
      fleets: [fleet("night", ["bd-19"], { kind: "live", sessionId: "night-session" })],
      taskIds: ["bd-12", "not-a-bead", "bd-12", "bd-19"],
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual([
      "invalid-task-id",
      "duplicate-task-id",
      "already-member",
    ]);
    expect(result.error).toContain("not-a-bead");
    expect(result.error).toContain("already a member of fleet `night`");
    expect(result.error).toContain("night-session");
  });

  it("refuses a member whose existing worktree belongs to another bead", () => {
    const result = validateFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probes: [{ taskId: "bd-12", ownershipError: "bd-99 lives in /repo.feat-bd-12" }],
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.refusals[0]?.reason).toBe("conflicting-worktree");
    expect(result.error).toContain("bd-99 lives in");
  });

  it("refuses to take over a fleet another live session supervises (W2)", () => {
    const result = validateFleetLaunch({
      ...base,
      fleets: [fleet(fleetId, ["bd-12"], { kind: "live", sessionId: "other-session" })],
      taskIds: ["bd-12"],
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.refusals[0]?.reason).toBe("fleet-supervised");
    expect(result.error).toContain("other-session");
    expect(result.error).toContain("Nothing was changed");
  });

  it("refuses a second fleet from a session that already supervises one (W-B)", () => {
    const result = validateFleetLaunch({
      ...base,
      fleets: [fleet("default", ["bd-12"], { kind: "live", sessionId: "supervisor-session" })],
      targetFleetId: "night",
      sessionFleetId: "default",
      taskIds: ["bd-15"],
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.refusals[0]?.reason).toBe("fleet-supervised-elsewhere");
    expect(result.error).toContain("already supervises fleet `default`");
    expect(result.error).toContain("Nothing was changed");
  });

  it("still accepts a launch into the fleet the session already supervises", () => {
    const result = validateFleetLaunch({
      ...base,
      fleets: [fleet("default", ["bd-12"], { kind: "live", sessionId: "supervisor-session" })],
      sessionFleetId: "default",
      taskIds: ["bd-15"],
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.taskIds).toEqual(["bd-15"]);
  });

  it("re-arms a dead fleet: its own members are preserved, not relaunched (C2)", () => {
    const result = validateFleetLaunch({
      ...base,
      fleets: [fleet(fleetId, ["bd-12", "bd-15"], { kind: "dead", sessionId: "old-session" })],
      taskIds: ["bd-12"],
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.taskIds).toEqual([]);
    expect(result.rearmedTaskIds).toEqual(["bd-12"]);
    expect(result.rearm).toBe(true);
  });

  it("adds a new member while re-arming a dead fleet", () => {
    const result = validateFleetLaunch({
      ...base,
      fleets: [fleet(fleetId, ["bd-12"], { kind: "dead", sessionId: "old-session" })],
      taskIds: ["bd-12", "bd-19"],
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.taskIds).toEqual(["bd-19"]);
    expect(result.rearmedTaskIds).toEqual(["bd-12"]);
  });

  it("refuses launching a member of another fleet whose supervisor is dead (split brain)", () => {
    const result = validateFleetLaunch({
      ...base,
      fleets: [fleet("night", ["bd-12"], { kind: "dead", sessionId: "old-session" })],
      taskIds: ["bd-12"],
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.refusals[0]?.reason).toBe("already-member");
    expect(result.error).toContain("supervisor is not running");
    expect(result.error).toContain("--fleet night");
  });
});

describe("collectFleetLaunchContext", () => {
  it("classifies every fleet's supervisor and returns the target intent", () => {
    const fs = createFakeFleetFs({
      [`${fleetDir(commonDir, "default")}/fleet.json`]: JSON.stringify({
        schemaVersion: 1,
        fleetId: "default",
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        supervisor: { sessionId: "dead-session", pid: 999_999 },
      }),
      [`${fleetDir(commonDir, "night")}/fleet.json`]: JSON.stringify({
        schemaVersion: 1,
        fleetId: "night",
        taskIds: ["bd-19"],
        createdAt: 1,
        updatedAt: 1,
        supervisor: { sessionId: "night-session", pid: 4242 },
      }),
    });

    const context = collectFleetLaunchContext({
      gitCommonDir: commonDir,
      fleetId: "default",
      liveness: { isPidAlive: (pid: number) => pid === 4242 },
      fs,
    });

    expect(context.targetFleetId).toBe("default");
    expect(context.targetIntent?.taskIds).toEqual(["bd-12"]);
    expect(context.fleets).toEqual([
      {
        fleetId: "default",
        members: ["bd-12"],
        supervisor: { kind: "dead", sessionId: "dead-session" },
      },
      {
        fleetId: "night",
        members: ["bd-19"],
        supervisor: { kind: "live", sessionId: "night-session" },
      },
    ]);
  });
});

describe("parseFleetCommandArgs", () => {
  it("parses ids plus the optional flags", () => {
    expect(parseFleetCommandArgs("bd-12 bd-15")).toEqual({
      ok: true,
      args: { taskIds: ["bd-12", "bd-15"] },
    });
    expect(parseFleetCommandArgs("  bd-12   bd-19 --fleet night --concurrency 5 ")).toEqual({
      ok: true,
      args: { taskIds: ["bd-12", "bd-19"], fleetId: "night", concurrency: 5 },
    });
  });

  it("rejects an empty id list with the usage text", () => {
    for (const raw of ["", "   "]) {
      const parsed = parseFleetCommandArgs(raw);
      expect(parsed).toHaveProperty("ok", false);
      if (parsed.ok) continue;
      expect(parsed.error).toBe(fleetUsageText());
    }
  });

  it("rejects flags-only input, unknown flags, and missing values", () => {
    const flagsOnly = parseFleetCommandArgs("--fleet night");
    expect(flagsOnly).toHaveProperty("ok", false);
    if (!flagsOnly.ok) expect(flagsOnly.error).toContain("No task ids given");

    const unknown = parseFleetCommandArgs("bd-12 --force");
    expect(unknown).toHaveProperty("ok", false);
    if (!unknown.ok) expect(unknown.error).toContain("Unknown flag --force");

    const missing = parseFleetCommandArgs("bd-12 --concurrency");
    expect(missing).toHaveProperty("ok", false);
    if (!missing.ok) expect(missing.error).toContain("--concurrency needs a value");

    const nan = parseFleetCommandArgs("bd-12 --concurrency soon");
    expect(nan).toHaveProperty("ok", false);
    if (!nan.ok) expect(nan.error).toContain('needs a number, got "soon"');
  });
});

describe("parseFleetTaskIds", () => {
  it("accepts an array, one string, or a comma list", () => {
    expect(parseFleetTaskIds(["bd-12", "bd-15"])).toEqual({
      ok: true,
      taskIds: ["bd-12", "bd-15"],
    });
    expect(parseFleetTaskIds("bd-12 bd-15")).toEqual({ ok: true, taskIds: ["bd-12", "bd-15"] });
    expect(parseFleetTaskIds("bd-12, bd-15")).toEqual({ ok: true, taskIds: ["bd-12", "bd-15"] });
  });

  it("refuses an absent or empty parameter", () => {
    expect(parseFleetTaskIds(undefined)).toHaveProperty("ok", false);
    expect(parseFleetTaskIds([])).toHaveProperty("ok", false);
    expect(parseFleetTaskIds("  ")).toHaveProperty("ok", false);
  });
});

describe("mergeFleetIntent", () => {
  const supervisor = { sessionId: "s2", pid: 22 };

  function current(): FleetIntent {
    return {
      schemaVersion: 1,
      fleetId,
      taskIds: ["bd-12"],
      createdAt: 10,
      updatedAt: 10,
      maxConcurrent: 2,
      paused: true,
      note: "operator note",
      baseBranch: "main",
      supervisor: { sessionId: "s1", pid: 11 },
    };
  }

  it("accumulates members, replaces the supervisor, and preserves operator fields", () => {
    const merged = mergeFleetIntent({
      current: current(),
      fleetId,
      taskIds: ["bd-15"],
      now: 20,
      maxConcurrent: 3,
      baseBranch: "develop",
      supervisor,
    });

    expect(merged.taskIds).toEqual(["bd-12", "bd-15"]);
    expect(merged.createdAt).toBe(10);
    expect(merged.updatedAt).toBe(20);
    expect(merged.maxConcurrent).toBe(3);
    expect(merged.paused).toBe(true);
    expect(merged.note).toBe("operator note");
    expect(merged.baseBranch).toBe("develop");
    expect(merged.supervisor).toEqual(supervisor);
  });

  it("creates the record on a first launch", () => {
    const merged = mergeFleetIntent({
      current: undefined,
      fleetId,
      taskIds: ["bd-12"],
      now: 20,
      maxConcurrent: 3,
      supervisor,
    });

    expect(merged.taskIds).toEqual(["bd-12"]);
    expect(merged.createdAt).toBe(20);
    expect(merged.fleetId).toBe(fleetId);
    expect(merged.supervisor).toEqual(supervisor);
  });
});

describe("formatFleetLaunchReport", () => {
  it("reports the clamp and per-member outcomes", () => {
    const text = formatFleetLaunchReport({
      fleetId,
      maxConcurrent: maxChars,
      clampedFrom: 6,
      outcomes: [
        { taskId: "bd-12", ok: true, detail: "worktree + session", workflowType: "bugfix" },
        { taskId: "bd-15", ok: false, detail: "worktree creation failed" },
      ],
    });

    expect(text).toContain("1/2 member(s) launched (maxConcurrent 3)");
    expect(text).toContain("Concurrency 6 is above the ceiling of 3");
    expect(text).toContain("- bd-12: launched (bugfix)");
    expect(text).toContain("- bd-15: NOT launched — worktree creation failed");
    expect(text).toContain("Removed bd-15 from the fleet intent");
    expect(text).toContain("runs no phases");
  });

  it("reports an ignored concurrency request", () => {
    const text = formatFleetLaunchReport({
      fleetId,
      maxConcurrent: maxChars,
      ignoredRequestedConcurrency: 0,
      outcomes: [],
    });
    expect(text).toContain("Concurrency 0 is not a positive whole number");
  });

  it("reports a floored fraction and a re-arm", () => {
    const floored = formatFleetLaunchReport({
      fleetId,
      maxConcurrent: 2,
      flooredFrom: 2.5,
      outcomes: [],
    });
    expect(floored).toContain("Concurrency 2.5 is not a whole number; stored 2");

    const rearmed = formatFleetLaunchReport({
      fleetId,
      maxConcurrent: 3,
      outcomes: [],
      rearm: true,
      rearmedTaskIds: ["bd-12", "bd-15"],
    });
    expect(rearmed).toContain("re-armed — supervisor record rewritten");
    expect(rearmed).toContain("2 existing member(s) preserved, no new members");
    expect(rearmed).toContain("Preserved existing member(s): bd-12, bd-15");
  });
});

describe("runFleetLaunch", () => {
  const base = {
    gitCommonDir: commonDir,
    fleetId,
    sessionId: "supervisor-session",
    pid: 4242,
    armToken: "arm-token",
    liveness: { isPidAlive: (pid: number) => pid === 4242 },
    now: 1_700_000_000_000,
    baseBranch: "main",
  };

  function auditLines(fs: ReturnType<typeof createFakeFleetFs>): string[] {
    const log = fs.files.get(`${fleetDir(commonDir, fleetId)}/audit.log`) ?? "";
    return log.split("\n").filter((line) => line !== "");
  }

  it("launches two members, records the intent, and audits each action", async () => {
    const fs = createFakeFleetFs();
    const launched: string[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12", "bd-15"],
      requestedConcurrency: 5,
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched.push(taskId);
        return { taskId, ok: true, detail: `/repo.feat-${taskId}`, workflowType: "feature" };
      },
      fs,
    });

    expect(result.ok).toBe(true);
    expect(launched).toEqual(["bd-12", "bd-15"]);
    expect(result.warnings).toEqual([]);
    expect(result.text).toContain("2/2 member(s) launched (maxConcurrent 3)");
    expect(result.text).toContain(
      "Concurrency 5 is above the ceiling of 3 orchestrators; stored 3",
    );

    const intent = JSON.parse(
      fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`) ?? "{}",
    ) as FleetIntent;
    expect(intent.taskIds).toEqual(["bd-12", "bd-15"]);
    expect(intent.maxConcurrent).toBe(maxChars);
    expect(intent.baseBranch).toBe("main");
    // The supervisor record carries all four anchors: session, pid, process start
    // time (when readable), and the arm token held only in the session's memory.
    expect(intent.supervisor).toMatchObject({
      sessionId: "supervisor-session",
      pid: 4242,
      armToken: "arm-token",
    });

    const actions = auditLines(fs).map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions).toEqual(["schedule-planned", "launch", "member-launch", "member-launch"]);
  });

  it("refuses an invalid request with zero side effects", async () => {
    const fs = createFakeFleetFs();
    let launched = 0;

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12", "nope"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched += 1;
        return { taskId, ok: true, detail: "unexpected" };
      },
      fs,
    });

    expect(result.ok).toBe(false);
    expect(launched).toBe(0);
    // No fleet dir, no intent, no audit line: validation runs before any write.
    expect(fs.files.size).toBe(0);
    expect(result.text).toContain("nope");
  });

  it("refuses a member of a live fleet without touching the existing fleet", async () => {
    const fs = createFakeFleetFs({
      [`${fleetDir(commonDir, fleetId)}/fleet.json`]: JSON.stringify({
        schemaVersion: 1,
        fleetId,
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        supervisor: { sessionId: "other-session", pid: 4242, armToken: "their-token" },
      }),
    });
    const before = fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`);

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "x" }),
      fs,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("already supervised by live session `other-session`");
    expect(fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`)).toBe(before);
    expect(auditLines(fs)).toEqual([]);
  });

  it("re-arms a dead fleet: supervisor rewritten, members kept, nothing relaunched (C2)", async () => {
    const fs = createFakeFleetFs({
      [`${fleetDir(commonDir, fleetId)}/fleet.json`]: JSON.stringify({
        schemaVersion: 1,
        fleetId,
        taskIds: ["bd-12", "bd-15"],
        createdAt: 1,
        updatedAt: 1,
        maxConcurrent: 2,
        paused: true,
        note: "operator note",
        supervisor: { sessionId: "dead-session", pid: 999_999 },
      }),
    });
    let launched = 0;

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched += 1;
        return { taskId, ok: true, detail: "should not happen" };
      },
      fs,
    });

    expect(result.ok).toBe(true);
    expect(result.rearmed).toBe(true);
    expect(launched).toBe(0);
    expect(result.text).toContain("re-armed");
    expect(result.text).toContain("1 existing member(s) preserved");
    expect(result.text).toContain("Preserved existing member(s): bd-12");

    const intent = JSON.parse(
      fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`) ?? "{}",
    ) as FleetIntent;
    expect(intent.taskIds).toEqual(["bd-12", "bd-15"]);
    expect(intent.supervisor).toMatchObject({ sessionId: "supervisor-session", pid: 4242 });
    // A re-arm restates supervision, not fleet policy.
    expect(intent.maxConcurrent).toBe(2);
    expect(intent.paused).toBe(true);
    expect(intent.note).toBe("operator note");
    expect(intent.createdAt).toBe(1);

    const actions = auditLines(fs).map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions).toEqual(["re-arm"]);
  });

  it("re-arms a dead fleet and adds the new members in the same call", async () => {
    const fs = createFakeFleetFs({
      [`${fleetDir(commonDir, fleetId)}/fleet.json`]: JSON.stringify({
        schemaVersion: 1,
        fleetId,
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        supervisor: { sessionId: "dead-session", pid: 999_999 },
      }),
    });
    const launched: string[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12", "bd-19"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched.push(taskId);
        return { taskId, ok: true, detail: "ok" };
      },
      fs,
    });

    expect(result.ok).toBe(true);
    expect(launched).toEqual(["bd-19"]);
    const intent = JSON.parse(
      fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`) ?? "{}",
    ) as FleetIntent;
    expect(intent.taskIds).toEqual(["bd-12", "bd-19"]);
    const actions = auditLines(fs).map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions).toEqual(["re-arm", "schedule-planned", "launch", "member-launch"]);
  });

  it("does not claim supervision when the written record does not read back (W6)", async () => {
    const fs = createFakeFleetFs();
    // A writer that replaces the record right after the atomic rename: the
    // read-back is the only thing that can catch it, and it must refuse to arm.
    const realRename = fs.renameSync;
    const realWrite = fs.writeFileSync;
    fs.renameSync = (oldPath, newPath) => {
      realRename(oldPath, newPath);
      if (!newPath.endsWith("fleet.json")) return;
      realWrite(
        newPath,
        JSON.stringify({
          schemaVersion: 1,
          fleetId,
          taskIds: ["bd-12"],
          createdAt: 1,
          updatedAt: 1,
          supervisor: { sessionId: "intruder", pid: 4242, armToken: "intruder-token" },
        }),
      );
    };

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "should not happen" }),
      fs,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("did not read back");
    expect(result.outcomes).toEqual([]);
  });

  it("refuses to claim supervision when the written record cannot be read back (F-gap)", async () => {
    const fs = createFakeFleetFs();
    // The write lands, then the record becomes unreadable (a racing writer, a
    // permission change, a torn external read). A supervisor that cannot verify its
    // own record is not the supervisor, and this must not be reported as a
    // content mismatch to a record that may in fact be correct.
    let written = false;
    const realRename = fs.renameSync;
    fs.renameSync = (oldPath, newPath) => {
      realRename(oldPath, newPath);
      if (newPath.endsWith("fleet.json")) written = true;
    };
    const realRead = fs.readFileSync;
    fs.readFileSync = (path) => {
      if (written && path.endsWith("fleet.json")) throw new Error("EIO: cannot read back");
      return realRead(path);
    };

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "should not happen" }),
      fs,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("could not read it back");
    expect(result.text).toContain("cannot read back");
    expect(result.outcomes).toEqual([]);
  });

  it("keeps the launched member, reports the failed one, and prunes it from the intent", async () => {
    const fs = createFakeFleetFs();
    const attempted: string[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12", "bd-15"],
      probeOwnership: () => undefined,
      launchMember: async (taskId): Promise<FleetMemberLaunchOutcome> => {
        attempted.push(taskId);
        return taskId === "bd-15"
          ? { taskId, ok: false, detail: "worktree creation failed" }
          : { taskId, ok: true, detail: `/repo.feat-${taskId}` };
      },
      fs,
    });

    // Documented failure semantics: the rest proceed, the failure is surfaced.
    expect(attempted).toEqual(["bd-12", "bd-15"]);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("- bd-15: NOT launched — worktree creation failed");
    expect(result.text).toContain("Removed bd-15 from the fleet intent");

    const intent = JSON.parse(
      fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`) ?? "{}",
    ) as FleetIntent;
    expect(intent.taskIds).toEqual(["bd-12"]);

    const actions = auditLines(fs).map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions).toEqual([
      "schedule-planned",
      "launch",
      "member-launch",
      "member-launch-failed",
      "member-pruned",
    ]);
  });

  it("reports a fleet whose members all failed as not started", async () => {
    const fs = createFakeFleetFs();
    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: false, detail: "daemon unavailable" }),
      fs,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("0/1 member(s) launched");
    const intent = JSON.parse(
      fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`) ?? "{}",
    ) as FleetIntent;
    expect(intent.taskIds).toEqual([]);
  });

  it("reports `armed` separately from `ok`, so a failed member launch keeps supervision (W-B)", async () => {
    const fs = createFakeFleetFs();
    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: false, detail: "daemon unavailable" }),
      fs,
    });

    // The supervisor record was written and read back, so the caller must arm
    // (and update its token), even though no member started.
    expect(result.armed).toBe(true);
    expect(result.fleetId).toBe(fleetId);
  });

  it("reports `armed: false` when the launch was refused", async () => {
    const fs = createFakeFleetFs();
    const result = await runFleetLaunch({
      ...base,
      taskIds: ["not-a-bead"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "ok" }),
      fs,
    });

    expect(result.ok).toBe(false);
    expect(result.armed).toBe(false);
  });

  it("surfaces an audit failure as a warning instead of failing the launch", async () => {
    const fs = createFakeFleetFs();
    fs.appendFileSync = () => {
      throw new Error("EROFS: read-only file system");
    };

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "ok" }),
      fs,
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("could not append to audit.log");
  });

  it("writes one audit line in the shared substrate format", async () => {
    const fs = createFakeFleetFs();
    await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "ok" }),
      fs,
    });

    const [line] = auditLines(fs);
    expect(line).toBeDefined();
    if (line === undefined) return;
    // Same formatter as the substrate: keys in a fixed order, fleet id sanitized.
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "timestamp",
      "fleetId",
      "actor",
      "action",
      "taskIds",
      "detail",
    ]);
    expect(parsed.actor).toBe("supervisor-session");
    expect(
      formatAuditEntry({
        ...parsed,
        fleetId,
        actor: "a",
        action: "b",
        detail: "",
        timestamp: 1,
        taskIds: [],
      }),
    ).toContain('"fleetId":"default"');
  });
});

// ── P3: scheduling wiring ─────────────────────────────────────────────

describe("runFleetLaunch: P3 ordering and capacity", () => {
  const base = {
    gitCommonDir: commonDir,
    fleetId,
    sessionId: "supervisor-session",
    pid: 4242,
    armToken: "arm-token",
    liveness: { isPidAlive: (pid: number) => pid === 4242 },
    now: 1_700_000_000_000,
    baseBranch: "main",
  };

  function actionsOf(fs: ReturnType<typeof createFakeFleetFs>): string[] {
    const log = fs.files.get(`${fleetDir(commonDir, fleetId)}/audit.log`) ?? "";
    return log
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { action: string }).action);
  }

  function intentOf(fs: ReturnType<typeof createFakeFleetFs>): FleetIntent {
    return JSON.parse(
      fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`) ?? "{}",
    ) as FleetIntent;
  }

  it("launches only the free capacity and records the deferred members", async () => {
    const fs = createFakeFleetFs();
    const launched: string[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12", "bd-15", "bd-19", "bd-22", "bd-25"],
      requestedConcurrency: 5,
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched.push(taskId);
        return { taskId, ok: true, detail: "ok" };
      },
      fs,
    });

    expect(result.ok).toBe(true);
    expect(launched).toEqual(["bd-12", "bd-15", "bd-19"]);
    expect(result.schedule).toHaveProperty("slots", 3);

    const intent = intentOf(fs);
    // Membership is what actually runs; the rest is deferred, with a reason.
    expect(intent.taskIds).toEqual(["bd-12", "bd-15", "bd-19"]);
    expect(intent.deferred?.map((entry) => [entry.taskId, entry.reason])).toEqual([
      ["bd-22", "capacity"],
      ["bd-25", "capacity"],
    ]);

    const actions = actionsOf(fs);
    expect(actions).toContain("schedule-planned");
    expect(actions.filter((action) => action === "capacity-blocked")).toHaveLength(2);
    expect(result.text).toContain("3 member(s) now, 2 deferred");
    expect(result.text).toContain("deferred bd-22 (capacity)");
  });

  it("orders members by bd's blocking edges and defers the dependent wave", async () => {
    const fs = createFakeFleetFs();
    const launched: string[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-15", "bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched.push(taskId);
        return { taskId, ok: true, detail: "ok" };
      },
      lookupDependencies: async () => ({
        edges: [{ blocker: "bd-12", blocked: "bd-15" }],
        warnings: [],
      }),
      fs,
    });

    expect(result.ok).toBe(true);
    // bd-15 is listed first, but bd-12 blocks it.
    expect(launched).toEqual(["bd-12"]);
    const intent = intentOf(fs);
    expect(intent.taskIds).toEqual(["bd-12"]);
    expect(intent.deferred).toEqual([
      expect.objectContaining({ taskId: "bd-15", reason: "dependency" }),
    ]);
    expect(actionsOf(fs)).toContain("member-deferred");
    expect(result.text).toContain("wave 1 (later launch): bd-15");
    expect(result.text).toContain("belayd_fleet_advance");
  });

  it("refuses a dependency cycle before any side effect", async () => {
    const fs = createFakeFleetFs();
    let launched = 0;

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12", "bd-15"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched += 1;
        return { taskId, ok: true, detail: "unexpected" };
      },
      lookupDependencies: async () => ({
        edges: [
          { blocker: "bd-12", blocked: "bd-15" },
          { blocker: "bd-15", blocked: "bd-12" },
        ],
        warnings: [],
      }),
      fs,
    });

    expect(result.ok).toBe(false);
    expect(launched).toBe(0);
    expect(fs.files.size).toBe(0);
    expect(result.text).toContain("dependency cycle");
    expect(result.text).toContain("nothing was created");
  });

  it("degrades to caller order when the dependency graph cannot be read", async () => {
    const fs = createFakeFleetFs();
    const launched: string[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12", "bd-15"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched.push(taskId);
        return { taskId, ok: true, detail: "ok" };
      },
      lookupDependencies: async () => {
        throw new Error("bd is not installed");
      },
      fs,
    });

    expect(result.ok).toBe(true);
    expect(launched).toEqual(["bd-12", "bd-15"]);
    expect(result.warnings.join("\n")).toContain("dependency graph unavailable");
    expect(intentOf(fs).deferred).toEqual([]);
  });

  it("records a fully deferred plan when every slot is already busy (W1)", async () => {
    const fs = createFakeFleetFs();
    // Three members of an abandoned fleet still hold the ceiling.
    writeIntentFile(fs, "abandoned", ["bd-30", "bd-31", "bd-32"], {
      supervisor: { sessionId: "long-gone", pid: 999_999 },
    });
    const launched: string[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12", "bd-15"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched.push(taskId);
        return { taskId, ok: true, detail: "unexpected" };
      },
      fs,
    });

    // Nothing launches, but the plan is still recorded: a member-less launch must
    // not drop `deferred`, or the waiting members become undiscoverable. Nothing
    // failed either, so the call is a success (W6).
    expect(result.ok).toBe(true);
    expect(launched).toEqual([]);
    const intent = intentOf(fs);
    expect(intent.taskIds).toEqual([]);
    expect(intent.deferred?.map((entry) => [entry.taskId, entry.reason])).toEqual([
      ["bd-12", "capacity"],
      ["bd-15", "capacity"],
    ]);
    expect(result.text).toContain("deferred bd-12 (capacity)");
  });

  it("keeps a deferral it did not schedule when a later launch adds members (W2)", async () => {
    const fs = createFakeFleetFs();
    writeIntentFile(fs, fleetId, ["bd-12"], {
      supervisor: { sessionId: "supervisor-session", pid: 4242, armToken: "arm-token" },
      deferred: [{ taskId: "bd-15", reason: "dependency", detail: "wave 1: waits for bd-12" }],
    });

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-19", "bd-22"],
      requestedConcurrency: 3,
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "ok" }),
      fs,
    });

    expect(result.ok).toBe(true);
    const intent = intentOf(fs);
    expect(intent.taskIds).toEqual(["bd-12", "bd-19", "bd-22"]);
    expect(intent.deferred).toEqual([
      expect.objectContaining({ taskId: "bd-15", reason: "dependency" }),
    ]);
  });

  it("treats a stopped fleet member as an internal blocker, never an outsider (C2)", async () => {
    // bd-150 was stopped by the run and kept as a member (bd-156), and bd-152 waits
    // on it. The schedule only sees that as a sibling dependency when the launch
    // supplies the fleet's existing members, so this asserts the wiring itself and
    // not just `planFleetSchedule`'s unit behavior.
    const fs = createFakeFleetFs();
    writeIntentFile(fs, fleetId, ["bd-150"], {
      supervisor: { sessionId: "supervisor-session", pid: 4242, armToken: "arm-token" },
      run: recordRunMemberStopped({
        run: startFleetRun({
          now: 1,
          accept: true,
          members: [{ taskId: "bd-150", sessionId: "member-session" }],
        }),
        taskId: "bd-150",
        reason: "phase-failed",
        detail: "phase test failed: gate failed",
        now: 2,
      }),
    });
    const launched: string[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-152"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched.push(taskId);
        return { taskId, ok: true, detail: "unexpected" };
      },
      lookupDependencies: async () => ({
        edges: [{ blocker: "bd-150", blocked: "bd-152" }],
        warnings: [],
      }),
      fs,
    });

    expect(result.ok).toBe(true);
    // Nothing starts: bd-150 is stopped until a human lands or removes it, and
    // bd-152 waits one wave behind it — it is never relaunched here.
    expect(launched).toEqual([]);
    const intent = intentOf(fs);
    expect(intent.taskIds).toEqual(["bd-150"]);
    expect(intent.run?.stopped?.map((entry) => entry.taskId)).toEqual(["bd-150"]);
    expect(intent.deferred).toEqual([
      expect.objectContaining({ taskId: "bd-152", reason: "dependency" }),
    ]);
    // The regression this guards: without `memberIds`, bd-150 reads as an outsider
    // and the sibling is deferred as an `external-blocker`.
    const details = (intent.deferred ?? []).map((entry) => entry.detail).join("\n");
    expect(details).not.toContain("outside this fleet");
    expect(result.text).not.toContain("not part of this fleet");
    expect(result.text).toContain("deferred bd-152 (dependency)");
  });

  it("audits a wave advance as `advance`, not as a fresh launch", async () => {
    const fs = createFakeFleetFs();
    writeIntentFile(fs, fleetId, ["bd-12"], {
      supervisor: { sessionId: "supervisor-session", pid: 4242, armToken: "arm-token" },
      deferred: [{ taskId: "bd-15", reason: "capacity", detail: "no slot" }],
    });

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-15"],
      origin: "advance",
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "ok" }),
      fs,
    });

    expect(result.ok).toBe(true);
    const actions = actionsOf(fs);
    expect(actions).toContain("advance");
    expect(actions).not.toContain("launch");
    // The launched member leaves the waiting list.
    expect(intentOf(fs).deferred).toEqual([]);
  });

  it("refuses to launch while the fleet is paused", async () => {
    const fs = createFakeFleetFs();
    writeIntentFile(fs, fleetId, ["bd-12"], {
      supervisor: { sessionId: "supervisor-session", pid: 4242, armToken: "arm-token" },
      paused: true,
      park: { reason: "root restore conflicted", stashRef: "abc123", recordedAt: 5 },
    });
    let launched = 0;

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-15"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched += 1;
        return { taskId, ok: true, detail: "unexpected" };
      },
      fs,
    });

    expect(result.ok).toBe(false);
    expect(launched).toBe(0);
    expect(result.text).toContain("is paused");
    expect(result.text).toContain("belayd_fleet_resume");
  });

  it("refuses to launch when another fleet's intent cannot be read (CR)", async () => {
    const fs = createFakeFleetFs({
      [`${fleetDir(commonDir, "abandoned")}/fleet.json`]: "{not json",
    });
    let launched = 0;

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched += 1;
        return { taskId, ok: true, detail: "unexpected" };
      },
      fs,
    });

    expect(result.ok).toBe(false);
    expect(launched).toBe(0);
    expect(result.text).toContain("orchestrator count is unknown");
    expect(result.text).toContain("abandoned");
    // A refusal leaves no fleet directory behind.
    expect(fs.files.has(`${fleetDir(commonDir, fleetId)}/fleet.json`)).toBe(false);
  });

  it("writes no intent when an abandoned fleet already exhausts the ceiling", async () => {
    const fs = createFakeFleetFs();
    writeIntentFile(fs, "abandoned", ["bd-30", "bd-31", "bd-32"], {
      supervisor: { sessionId: "long-gone", pid: 999_999 },
    });

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      requestedConcurrency: 5,
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: false, detail: "unexpected" }),
      fs,
    });

    // The ceiling of 3 cannot be exceeded: one new launch is deferred, not started.
    expect(result.schedule).toHaveProperty("slots", 0);
    expect(result.text).toContain("deferred bd-12 (capacity)");
    expect(intentOf(fs).taskIds).toEqual([]);
  });
});

/**
 * Fleet ordering gates created by the launch (bd-158).
 *
 * The engine decides *when* and *which edges*; the bd lifecycle lives behind the
 * injected seam, so these cases assert the seam's input and what landed in
 * `fleet.json` — never a spawned process.
 */
describe("runFleetLaunch ordering gates", () => {
  const base = {
    gitCommonDir: commonDir,
    fleetId,
    sessionId: "supervisor-session",
    pid: 4242,
    armToken: "arm-token",
    liveness: { isPidAlive: (pid: number) => pid === 4242 },
    now: 1_700_000_000_000,
    baseBranch: "main",
  };

  function intentOf(fs: ReturnType<typeof createFakeFleetFs>): FleetIntent {
    return JSON.parse(
      fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`) ?? "{}",
    ) as FleetIntent;
  }

  /** A seam that records what the engine asked for and mints deterministic ids. */
  function recordingSeam(): {
    seam: NonNullable<Parameters<typeof runFleetLaunch>[0]["orderingGates"]>;
    created: Parameters<
      NonNullable<Parameters<typeof runFleetLaunch>[0]["orderingGates"]>["create"]
    >[0][];
    reaped: { fleetId: string; beadIds: readonly string[] }[];
  } {
    const created: Parameters<
      NonNullable<Parameters<typeof runFleetLaunch>[0]["orderingGates"]>["create"]
    >[0][] = [];
    const reaped: { fleetId: string; beadIds: readonly string[] }[] = [];
    let next = 0;
    return {
      created,
      reaped,
      seam: {
        create: async (input) => {
          created.push(input);
          const planned = input.edges
            .filter(
              (edge) =>
                input.taskIds.includes(edge.blocker) && input.taskIds.includes(edge.blocked),
            )
            .map((edge) => {
              next += 1;
              return { ...edge, gateId: `bd-90${next}` };
            });
          return { ok: true, gates: planned, created: planned, adopted: [], warnings: [] };
        },
        resolve: async (input) => ({
          ok: true,
          resolved: [...input.gates],
          remaining: [],
        }),
        reapByPrefix: async (input) => {
          reaped.push(input);
          return { ok: true, resolved: [], warnings: [] };
        },
      },
    };
  }

  it("gates an advance-added member against an already-live member", async () => {
    // W6: the new member is blocked by a member launched in an earlier wave. The
    // gate plan must include that live member, or bd reports the new member blocked
    // for the whole run while the fleet believes its ordering is complete.
    const fs = createFakeFleetFs();
    writeIntentFile(fs, fleetId, ["bd-12"], {});
    const recorder = recordingSeam();

    await runFleetLaunch({
      ...base,
      taskIds: ["bd-13"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "launched" }),
      lookupDependencies: async () => ({
        edges: [{ blocker: "bd-12", blocked: "bd-13" }],
        warnings: [],
      }),
      orderingGates: recorder.seam,
      fs,
    });

    expect(recorder.created).toHaveLength(1);
    expect(recorder.created[0]?.taskIds).toEqual(expect.arrayContaining(["bd-12", "bd-13"]));
    expect(intentOf(fs).orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-13", gateId: "bd-901" },
    ]);
  });

  it("rolls back only the gates its own attempt created, named with their dependents", async () => {
    // W1: a refusal must never resolve ordering that predates it. The seam refuses
    // after minting one gate (the second edge fails), so the rollback resolves that
    // one id and by-prefix only the edge it belongs to; the pre-existing record for
    // a different edge survives and is named as still bd-blocking its dependent.
    const fs = createFakeFleetFs();
    const atBound = Array.from({ length: FLEET_INTENT_ORDERING_GATES_MAX }, (_, index) => ({
      blocker: `bd-${1000 + index}`,
      blocked: `bd-${2000 + index}`,
      gateId: `bd-${3000 + index}`,
    }));
    writeIntentFile(fs, fleetId, ["bd-12", "bd-14"], { orderingGates: atBound });
    const minted = [{ blocker: "bd-12", blocked: "bd-14", gateId: "bd-950" }];
    const resolved: string[] = [];
    const reaped: {
      beadIds: readonly string[];
      scope: string;
      edges?: readonly unknown[];
    }[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-14"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "launched" }),
      lookupDependencies: async () => ({
        edges: [{ blocker: "bd-12", blocked: "bd-14" }],
        warnings: [],
      }),
      orderingGates: {
        create: async () => ({
          ok: false,
          error: "bd gate create failed on the second edge",
          // What this attempt minted before failing; the adopted list is empty.
          created: minted,
          adopted: [],
          warnings: [],
        }),
        resolve: async (input) => {
          resolved.push(...input.gates.map((gate) => gate.gateId));
          return { ok: true, resolved: [...input.gates], remaining: [] };
        },
        reapByPrefix: async (input) => {
          reaped.push({
            beadIds: input.beadIds,
            scope: input.scope,
            ...(input.scope === "created-edges" ? { edges: input.edges } : {}),
          });
          return { ok: true, resolved: [], warnings: [] };
        },
      },
      fs,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("Could not create the bd ordering gates");
    // Exactly the one gate this attempt created was resolved…
    expect(resolved).toEqual(["bd-950"]);
    // …and the by-prefix sweep was scoped to its edge, not the whole worklist.
    expect(reaped).toEqual([
      {
        beadIds: ["bd-14"],
        scope: "created-edges",
        edges: [{ blocker: "bd-12", blocked: "bd-14" }],
      },
    ]);
    // The pre-existing records are untouched: a refusal never rewrites the fleet.
    expect(intentOf(fs).orderingGates).toEqual(atBound);
  });

  it("names a dependent left bd-blocked by an adopted gate that stays open", async () => {
    // A gate adopted from bd predates the attempt, so a refusal leaves it open. The
    // operator has to be told which bead stays out of `bd ready` and under which
    // gate, because nothing in the fleet records it yet.
    const fs = createFakeFleetFs();
    writeIntentFile(fs, fleetId, ["bd-12", "bd-14"], {});

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-14"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => ({ taskId, ok: true, detail: "launched" }),
      lookupDependencies: async () => ({
        edges: [{ blocker: "bd-12", blocked: "bd-14" }],
        warnings: [],
      }),
      orderingGates: {
        create: async (input) => ({
          ok: false,
          error: "could not write the intent",
          created: [],
          adopted: [{ blocker: "bd-12", blocked: input.taskIds[1] ?? "bd-14", gateId: "bd-940" }],
          warnings: [],
        }),
        resolve: async (input) => ({
          ok: true,
          resolved: [...input.gates],
          remaining: [],
        }),
        reapByPrefix: async () => ({ ok: true, resolved: [], warnings: [] }),
      },
      fs,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("bd-14 (gate bd-940) stays bd-blocked");
    expect(result.text).toContain("bd gate list bd-14");
  });
});

/** Seed a fleet intent directly (a fleet that already exists). */
function writeIntentFile(
  fs: ReturnType<typeof createFakeFleetFs>,
  targetFleetId: string,
  taskIds: readonly string[],
  extra: Partial<FleetIntent>,
): void {
  fs.files.set(
    `${fleetDir(commonDir, targetFleetId)}/fleet.json`,
    JSON.stringify({
      schemaVersion: 1,
      fleetId: targetFleetId,
      taskIds: [...taskIds],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
      ...extra,
    }),
  );
}

describe("countActiveFleetOrchestrators", () => {
  it("counts every known fleet's members, including an abandoned fleet's", () => {
    const fleets: readonly FleetLaunchFleet[] = [
      {
        fleetId: "default",
        members: ["bd-12", "bd-15"],
        supervisor: { kind: "live", sessionId: "live-session" },
      },
      {
        fleetId: "abandoned",
        members: ["bd-19"],
        supervisor: { kind: "dead", sessionId: "dead-session" },
      },
      { fleetId: "target", members: ["bd-22"], supervisor: { kind: "none" } },
    ];
    const active = countActiveFleetOrchestrators({
      fleets,
      launchingTaskIds: ["bd-12"],
    });
    // bd-12 is about to launch; bd-15 is live; bd-19's supervisor is dead but its
    // detached orchestrator may still run, so it counts too; bd-22 is preserved by
    // the target's re-arm.
    expect(active).toBe(3);
  });
});

describe("planFleetAdvance", () => {
  const intent: FleetIntent = {
    schemaVersion: 1,
    fleetId,
    taskIds: ["bd-12"],
    createdAt: 1,
    updatedAt: 1,
    deferred: [{ taskId: "bd-15", reason: "capacity", detail: "all slots taken" }],
  };

  it("hands the persisted deferred list to the launch engine", () => {
    const planned = planFleetAdvance({ fleetId, intent });
    expect(planned).toHaveProperty("ok", true);
    if (!planned.ok) return;
    expect(planned.worklist).toEqual(["bd-15"]);
    expect(planned.members).toEqual(["bd-12"]);
  });

  it("refuses with nothing deferred, no intent, or a paused fleet", () => {
    const none = planFleetAdvance({ fleetId, intent: { ...intent, deferred: [] } });
    expect(none).toHaveProperty("ok", false);
    if (none.ok) return;
    expect(none.reason).toBe("no-deferred");

    const missing = planFleetAdvance({ fleetId, intent: undefined });
    expect(missing).toHaveProperty("ok", false);
    if (missing.ok) return;
    expect(missing.reason).toBe("no-intent");

    const paused = planFleetAdvance({ fleetId, intent: { ...intent, paused: true } });
    expect(paused).toHaveProperty("ok", false);
    if (paused.ok) return;
    expect(paused.reason).toBe("paused");
    expect(paused.text).toContain("belayd_fleet_resume");
  });
});

// ── Intent bounds and the compare-and-replace capacity recount ────────

describe("intent bounds and the CAS capacity recount", () => {
  const base = {
    gitCommonDir: commonDir,
    fleetId,
    sessionId: "supervisor-session",
    pid: 4242,
    armToken: "arm-token",
    liveness: { isPidAlive: (pid: number) => pid === 4242 },
    now: 1_700_000_000_000,
    baseBranch: "main",
  };

  function intentOf(fs: ReturnType<typeof createFakeFleetFs>): FleetIntent {
    return JSON.parse(
      fs.files.get(`${fleetDir(commonDir, fleetId)}/fleet.json`) ?? "{}",
    ) as FleetIntent;
  }

  it("bounds the deferred list by its set union, so a full advance still fits (W1)", async () => {
    // The launching ids are drawn from the deferred list itself — exactly what an
    // advance does — so the bound must be an intersection-free union, not a sum.
    const deferred = Array.from({ length: FLEET_INTENT_DEFERRED_MAX }, (_unused, index) => ({
      taskId: `bd-${index + 1}`,
      reason: "capacity" as const,
      detail: "no free slot",
    }));
    const fs = createFakeFleetFs();
    writeIntentFile(fs, fleetId, [], { deferred });
    const launched: string[] = [];

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-1", "bd-2", "bd-3"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched.push(taskId);
        return { taskId, ok: true, detail: "ok" };
      },
      fs,
    });

    expect(result.ok).toBe(true);
    expect(launched).toEqual(["bd-1", "bd-2", "bd-3"]);
    // A launched member leaves the deferred list; the rest still waits.
    expect(intentOf(fs).deferred).toHaveLength(FLEET_INTENT_DEFERRED_MAX - 3);
    expect(result.text).not.toContain("above the intent's limit");
  });

  it("refuses when the recount inside the CAS no longer fits (W2)", async () => {
    // The other fleet reads as empty while planning, then as three live members
    // during `writeLaunchIntent`'s recount — the window a concurrent launch from
    // another fleet occupies.
    const otherFleet = "other";
    const otherPath = `${fleetDir(commonDir, otherFleet)}/fleet.json`;
    const emptyOther = JSON.stringify({
      schemaVersion: 1,
      fleetId: otherFleet,
      taskIds: [],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
    });
    const busyOther = JSON.stringify({
      schemaVersion: 1,
      fleetId: otherFleet,
      taskIds: ["bd-91", "bd-92", "bd-93"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
    });
    const fs = createFakeFleetFs({ [otherPath]: emptyOther });
    const readFile = fs.readFileSync;
    let otherReads = 0;
    fs.readFileSync = (path) => {
      if (path === otherPath) {
        otherReads += 1;
        if (otherReads >= 2) return busyOther;
      }
      return readFile(path);
    };
    let launched = 0;

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12", "bd-15"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched += 1;
        return { taskId, ok: true, detail: "unexpected" };
      },
      fs,
    });

    expect(result.ok).toBe(false);
    expect(result.armed).toBe(false);
    expect(result.text).toContain("count changed while launching");
    expect(launched).toBe(0);
    // Nothing was recorded for this fleet: the refusal is the same CAS window.
    expect(fs.files.has(`${fleetDir(commonDir, fleetId)}/fleet.json`)).toBe(false);
  });

  it("refuses when a foreign intent becomes unreadable during the recount (CR)", async () => {
    // The ceiling is only knowable if every fleet's member list can be read. A
    // foreign record that reads fine while planning and then becomes corrupt is
    // an unknown count, not a zero: assuming zero would start work past the
    // ceiling of 3.
    const otherFleet = "other";
    const otherPath = `${fleetDir(commonDir, otherFleet)}/fleet.json`;
    const readable = JSON.stringify({
      schemaVersion: 1,
      fleetId: otherFleet,
      taskIds: ["bd-91"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
    });
    const fs = createFakeFleetFs({ [otherPath]: readable });
    const readFile = fs.readFileSync;
    let otherReads = 0;
    fs.readFileSync = (path) => {
      if (path === otherPath) {
        otherReads += 1;
        if (otherReads >= 2) throw new Error("EIO: fleet.json unreadable");
      }
      return readFile(path);
    };
    let launched = 0;

    const result = await runFleetLaunch({
      ...base,
      taskIds: ["bd-12"],
      probeOwnership: () => undefined,
      launchMember: async (taskId) => {
        launched += 1;
        return { taskId, ok: true, detail: "unexpected" };
      },
      fs,
    });

    expect(result.ok).toBe(false);
    expect(result.armed).toBe(false);
    expect(result.text).toContain("count changed while launching and is now unknown");
    expect(result.text).toContain(otherFleet);
    expect(launched).toBe(0);
    // The refusal is the same CAS window, so nothing was recorded.
    expect(fs.files.has(`${fleetDir(commonDir, fleetId)}/fleet.json`)).toBe(false);
  });
});
