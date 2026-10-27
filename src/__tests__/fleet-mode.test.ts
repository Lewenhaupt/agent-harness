/**
 * Unit tests for fleet supervisor mode (bd-126 P1).
 *
 * Everything is a pure decision over values or an injected fs seam, so no test
 * here shells out, spawns, or touches disk. The two properties that matter are
 * covered directly: the mode is *derived* from the intent (never a flag), and a
 * stale supervisor record cannot put a new session into it.
 */

import { describe, expect, it } from "vitest";

import {
  classifyFleetSupervisor,
  createFleetSupervisorRecord,
  FLEET_MIN_SUPERVISOR_PID,
  FLEET_REFUSED_TOOLS,
  formatFleetRefusal,
  isFleetRefusedTool,
  isProcessAlive,
  isSupervisorProcessAlive,
  listFleetIds,
  matchesFleetSupervisor,
  readProcessStartTime,
  resolveFleetMode,
  resolveMemberFleet,
  sessionSupervisesFleetRecord,
} from "../fleet-mode.js";
import { fleetEventsDir, fleetInboxDir, sanitizeFleetId } from "../fleet-status.js";
import { createFakeFleetFs } from "./helpers/fake-fleet-fs.js";

const commonDir = "/repo/.git";

function intentFile(fleetId: string): string {
  return `${commonDir}/belayd/fleet/${fleetId}/fleet.json`;
}

function intentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    fleetId: "default",
    taskIds: ["bd-12", "bd-15"],
    createdAt: 1,
    updatedAt: 1,
    supervisor: { sessionId: "supervisor-session", pid: 4242, armToken: "arm-token" },
    ...overrides,
  });
}

const TOKEN = "arm-token";

describe("supervisor matching", () => {
  const alive = (pid: number): boolean => pid === 4242;

  it("matches the recorded session while its process and arm token agree", () => {
    expect(
      matchesFleetSupervisor({
        supervisor: { sessionId: "supervisor-session", pid: 4242, armToken: TOKEN },
        sessionId: "supervisor-session",
        isPidAlive: alive,
        armToken: TOKEN,
      }),
    ).toBe(true);
  });

  it("does not match a different session", () => {
    expect(
      matchesFleetSupervisor({
        supervisor: { sessionId: "other-session", pid: 4242, armToken: TOKEN },
        sessionId: "supervisor-session",
        isPidAlive: alive,
        armToken: TOKEN,
      }),
    ).toBe(false);
  });

  it("does not match a record whose process is gone", () => {
    // The session id alone would keep a dead supervisor's authority alive; a
    // resumed session re-arms fleet mode with /fleet instead of inheriting it.
    expect(
      matchesFleetSupervisor({
        supervisor: { sessionId: "supervisor-session", pid: 999_999, armToken: TOKEN },
        sessionId: "supervisor-session",
        isPidAlive: alive,
        armToken: TOKEN,
      }),
    ).toBe(false);
  });

  it("refuses a planted record that names this session and a long-lived pid (W6)", () => {
    // pid 1 is alive forever and a session id is public, so neither can be an
    // identity on its own: without the arm token this session minted, no.
    expect(
      matchesFleetSupervisor({
        supervisor: { sessionId: "supervisor-session", pid: 1 },
        sessionId: "supervisor-session",
        isPidAlive: () => true,
        armToken: TOKEN,
      }),
    ).toBe(false);

    expect(
      matchesFleetSupervisor({
        supervisor: { sessionId: "supervisor-session", pid: 4242, armToken: "guessed" },
        sessionId: "supervisor-session",
        isPidAlive: alive,
        armToken: TOKEN,
      }),
    ).toBe(false);

    // A hand-written record with no token at all never matches.
    expect(
      matchesFleetSupervisor({
        supervisor: { sessionId: "supervisor-session", pid: 4242 },
        sessionId: "supervisor-session",
        isPidAlive: alive,
        armToken: TOKEN,
      }),
    ).toBe(false);
  });

  it("does not match an absent record or an empty session id", () => {
    expect(
      matchesFleetSupervisor({
        supervisor: undefined,
        sessionId: "s",
        isPidAlive: alive,
        armToken: TOKEN,
      }),
    ).toBe(false);
    expect(
      matchesFleetSupervisor({
        supervisor: { sessionId: "", pid: 4242, armToken: TOKEN },
        sessionId: "",
        isPidAlive: alive,
        armToken: TOKEN,
      }),
    ).toBe(false);
  });

  it("records the identity a later session needs, including the anti-reuse anchors", () => {
    expect(createFleetSupervisorRecord({ sessionId: "s1", pid: 7 })).toEqual({
      sessionId: "s1",
      pid: 7,
    });
    expect(
      createFleetSupervisorRecord({
        sessionId: "s1",
        pid: 7,
        pidStartTime: "1234",
        armToken: TOKEN,
      }),
    ).toEqual({ sessionId: "s1", pid: 7, pidStartTime: "1234", armToken: TOKEN });
  });
});

describe("supervisor process identity (S1)", () => {
  it("refuses pids that cannot plausibly be a supervisor session", () => {
    for (const pid of [1, FLEET_MIN_SUPERVISOR_PID - 1]) {
      expect(
        isSupervisorProcessAlive({
          supervisor: { sessionId: "s", pid },
          liveness: { isPidAlive: () => true },
        }),
      ).toBe(false);
    }
    expect(
      isSupervisorProcessAlive({
        supervisor: { sessionId: "s", pid: FLEET_MIN_SUPERVISOR_PID },
        liveness: { isPidAlive: () => true },
      }),
    ).toBe(true);
  });

  it("rejects a reused pid whose start time differs from the recorded one", () => {
    expect(
      isSupervisorProcessAlive({
        supervisor: { sessionId: "s", pid: 4242, pidStartTime: "100" },
        liveness: { isPidAlive: () => true, pidStartTime: () => "200" },
      }),
    ).toBe(false);
    expect(
      isSupervisorProcessAlive({
        supervisor: { sessionId: "s", pid: 4242, pidStartTime: "100" },
        liveness: { isPidAlive: () => true, pidStartTime: () => "100" },
      }),
    ).toBe(true);
    // A recorded start time the platform cannot read now falls back to liveness.
    expect(
      isSupervisorProcessAlive({
        supervisor: { sessionId: "s", pid: 4242, pidStartTime: "100" },
        liveness: { isPidAlive: () => true },
      }),
    ).toBe(true);
  });

  it("reads this process's start time from /proc", () => {
    const startTime = readProcessStartTime(process.pid);
    expect(startTime).toBeDefined();
    expect(startTime ?? "").toMatch(/^\d+$/);
    // Unreadable / refused pids are undefined, never a throw.
    expect(readProcessStartTime(0)).toBe(undefined);
    expect(readProcessStartTime(-1)).toBe(undefined);
    expect(readProcessStartTime(1.5)).toBe(undefined);
  });

  it("classifies a fleet supervisor as none, live, or dead", () => {
    const liveness = { isPidAlive: (pid: number) => pid === 4242 };
    expect(classifyFleetSupervisor({ supervisor: undefined, liveness })).toEqual({ kind: "none" });
    expect(
      classifyFleetSupervisor({
        supervisor: { sessionId: "s", pid: 4242, armToken: TOKEN },
        liveness,
      }),
    ).toEqual({ kind: "live", sessionId: "s" });
    expect(
      classifyFleetSupervisor({
        supervisor: { sessionId: "s", pid: 999_999, armToken: TOKEN },
        liveness,
      }),
    ).toEqual({ kind: "dead", sessionId: "s" });
  });
});

describe("liveness probe", () => {
  it("sees this process alive and rejects non-pids without signalling anything", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // pid 0 would signal the whole process group; the guard refuses it first.
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

describe("fleet directory scan", () => {
  it("lists fleet ids in code-unit order and tolerates a missing root", () => {
    const fs = createFakeFleetFs({
      [intentFile("zulu")]: intentJson({ fleetId: "zulu" }),
      [intentFile("alpha")]: intentJson({ fleetId: "alpha" }),
    });
    expect(listFleetIds({ gitCommonDir: commonDir, fs })).toEqual(["alpha", "zulu"]);
    expect(listFleetIds({ gitCommonDir: "/no-such-repo/.git", fs })).toEqual([]);
  });

  it("returns no fleets when the root cannot be read", () => {
    const fs = createFakeFleetFs();
    fs.readdirSync = () => {
      throw new Error("EACCES: permission denied");
    };
    // A reader inside the tool-call gate must never throw.
    expect(listFleetIds({ gitCommonDir: commonDir, fs })).toEqual([]);
  });
});

describe("sessionSupervisesFleetRecord (bd-166)", () => {
  const liveness = {
    isPidAlive: (pid: number) => pid === 4242,
    pidStartTime: (pid: number) => (pid === 4242 ? "start-1" : undefined),
  };
  const record = {
    sessionId: "session-1",
    pid: 4242,
    pidStartTime: "start-1",
    armToken: "token-1",
  };

  it("accepts a session holding the record's anchors and arm token", () => {
    expect(
      sessionSupervisesFleetRecord({
        supervisor: record,
        sessionId: "session-1",
        armToken: { fleetId: "default", token: "token-1" },
        liveness,
        fleetId: "default",
      }),
    ).toBe(true);
  });

  it("refuses a resumed session that lost the token or the process identity", () => {
    // Same session id, new process, no arm token: own-fleet mode already refuses
    // this, and cross-fleet authority must not be weaker.
    expect(
      sessionSupervisesFleetRecord({
        supervisor: record,
        sessionId: "session-1",
        liveness,
        fleetId: "default",
      }),
    ).toBe(false);
    // A reused pid with a different start time is not the same process.
    expect(
      sessionSupervisesFleetRecord({
        supervisor: record,
        sessionId: "session-1",
        armToken: { fleetId: "default", token: "token-1" },
        liveness: { ...liveness, pidStartTime: () => "start-2" },
        fleetId: "default",
      }),
    ).toBe(false);
    // A token minted for another fleet does not authorize this one.
    expect(
      sessionSupervisesFleetRecord({
        supervisor: record,
        sessionId: "session-1",
        armToken: { fleetId: "other", token: "token-1" },
        liveness,
        fleetId: "default",
      }),
    ).toBe(false);
  });

  it("falls back to the session id for a legacy record with no anchors", () => {
    expect(
      sessionSupervisesFleetRecord({
        supervisor: { sessionId: "session-1", pid: 999_999 },
        sessionId: "session-1",
        liveness: { isPidAlive: () => false },
        fleetId: "default",
      }),
    ).toBe(true);
  });

  it("still checks the process for a partial legacy record (start time, no token)", () => {
    expect(
      sessionSupervisesFleetRecord({
        supervisor: { sessionId: "session-1", pid: 4242, pidStartTime: "start-1" },
        sessionId: "session-1",
        liveness,
        fleetId: "default",
      }),
    ).toBe(true);
    expect(
      sessionSupervisesFleetRecord({
        supervisor: { sessionId: "session-1", pid: 4242, pidStartTime: "old-start" },
        sessionId: "session-1",
        liveness,
        fleetId: "default",
      }),
    ).toBe(false);
  });
});

describe("resolveFleetMode", () => {
  const options = (
    fs: ReturnType<typeof createFakeFleetFs>,
    sessionId = "supervisor-session",
    armedFleetId = "default",
  ) => ({
    gitCommonDir: commonDir,
    sessionId,
    isPidAlive: (pid: number) => pid === 4242,
    armToken: { fleetId: armedFleetId, token: TOKEN },
    fs,
  });

  it("returns the fleet this session supervises, with its mailbox paths", () => {
    const fs = createFakeFleetFs({ [intentFile("default")]: intentJson() });

    const mode = resolveFleetMode(options(fs));

    expect(mode?.fleetId).toBe("default");
    expect(mode?.gitCommonDir).toBe(commonDir);
    expect(mode?.inboxDir).toBe(fleetInboxDir(commonDir, "default"));
    expect(mode?.eventsDir).toBe(fleetEventsDir(commonDir, "default"));
    expect(mode?.intent.taskIds).toEqual(["bd-12", "bd-15"]);
  });

  it("does not claim a fleet whose supervisor record belongs to another session", () => {
    const fs = createFakeFleetFs({ [intentFile("default")]: intentJson() });
    expect(resolveFleetMode(options(fs, "fresh-session"))).toBe(undefined);
  });

  it("does not claim a fleet left behind by a dead supervisor process", () => {
    const fs = createFakeFleetFs({
      [intentFile("default")]: intentJson({
        supervisor: { sessionId: "supervisor-session", pid: 1, armToken: TOKEN },
      }),
    });
    expect(resolveFleetMode(options(fs))).toBe(undefined);
  });

  it("does not claim a fleet when this session holds no arm token (W6)", () => {
    const fs = createFakeFleetFs({ [intentFile("default")]: intentJson() });
    expect(
      resolveFleetMode({
        gitCommonDir: commonDir,
        sessionId: "supervisor-session",
        isPidAlive: (pid: number) => pid === 4242,
        fs,
      }),
    ).toBe(undefined);
  });

  it("does not claim a fleet whose arm token belongs to a different arming", () => {
    const fs = createFakeFleetFs({ [intentFile("default")]: intentJson() });
    expect(
      resolveFleetMode({
        ...options(fs),
        armToken: { fleetId: "default", token: "other-token" },
      }),
    ).toBe(undefined);
  });

  it("ignores an arm token minted for a different fleet id", () => {
    const fs = createFakeFleetFs({ [intentFile("default")]: intentJson() });
    expect(
      resolveFleetMode({
        ...options(fs),
        armToken: { fleetId: "night", token: TOKEN },
      }),
    ).toBe(undefined);
  });

  it("ignores an intent with no supervisor record at all", () => {
    const fs = createFakeFleetFs({
      [intentFile("default")]: intentJson({ supervisor: undefined }),
    });
    expect(resolveFleetMode(options(fs))).toBe(undefined);
  });

  it("skips a corrupt intent instead of failing the lookup", () => {
    const fs = createFakeFleetFs({
      [intentFile("default")]: "{ truncated",
      [intentFile("night")]: intentJson({ fleetId: "night" }),
    });
    expect(resolveFleetMode(options(fs, "supervisor-session", "night"))?.fleetId).toBe("night");
  });

  it("names the directory id, not a record-declared id", () => {
    const fs = createFakeFleetFs({ [intentFile("dir-name")]: intentJson({ fleetId: "../evil" }) });
    const mode = resolveFleetMode(options(fs, "supervisor-session", "dir-name"));
    expect(mode?.fleetId).toBe(sanitizeFleetId("dir-name"));
    expect(mode?.inboxDir).toBe(fleetInboxDir(commonDir, "dir-name"));
    expect(mode?.inboxDir).not.toContain("evil");
  });

  it("is not put into fleet mode by another repository's fleet", () => {
    const fs = createFakeFleetFs({
      "/elsewhere/.git/belayd/fleet/default/fleet.json": intentJson(),
    });
    expect(resolveFleetMode(options(fs))).toBe(undefined);
  });
});

describe("resolveMemberFleet", () => {
  it("finds the fleet that lists the member task id", () => {
    const fs = createFakeFleetFs({ [intentFile("default")]: intentJson() });
    expect(resolveMemberFleet({ gitCommonDir: commonDir, taskId: "bd-15", fs })?.fleetId).toBe(
      "default",
    );
    expect(resolveMemberFleet({ gitCommonDir: commonDir, taskId: "bd-99", fs })).toBe(undefined);
    expect(resolveMemberFleet({ gitCommonDir: commonDir, taskId: "", fs })).toBe(undefined);
  });

  it("returns the deterministic first fleet when two list the same id", () => {
    const fs = createFakeFleetFs({
      [intentFile("zulu")]: intentJson({ fleetId: "zulu" }),
      [intentFile("alpha")]: intentJson({ fleetId: "alpha" }),
    });
    // The launch refuses duplicate membership; if a hand-edited pair exists, the
    // scan must still be stable rather than readdir-order dependent.
    expect(resolveMemberFleet({ gitCommonDir: commonDir, taskId: "bd-12", fs })?.fleetId).toBe(
      "alpha",
    );
  });
});

describe("fleet refusal", () => {
  it("refuses the phase, proof, and commit tools plus gate arming", () => {
    for (const tool of [
      "belayd_plan",
      "belayd_implement",
      "belayd_commit",
      "belayd_proof",
      "belayd_proof_verifier",
      "belayd_start_task",
      "belayd_start_followup",
      "belayd_stop_task",
    ]) {
      expect(isFleetRefusedTool(tool)).toBe(true);
    }
    for (const tool of ["belayd_fleet_status", "belayd_fleet_note", "belayd_fleet_inbox", "read"]) {
      expect(isFleetRefusedTool(tool)).toBe(false);
    }
    expect(FLEET_REFUSED_TOOLS).toContain("belayd_commit");
  });

  it("words the refusal as fleet mode, not as a bd-119 ownership error", () => {
    const message = formatFleetRefusal({ toolName: "belayd_commit", fleetId: "night" });

    expect(message).toContain("Fleet supervisor sessions do not run phases");
    expect(message).toContain("belayd_commit");
    expect(message).toContain("night");
    expect(message).toContain("belayd_fleet_status");
    expect(message).toContain("belayd_fleet_launch");
    // Nothing here should read like a bd-119 ownership refusal.
    expect(message).not.toContain("lives in");
    expect(message).not.toContain("No Belayd workflow state in");
  });

  it("sanitizes the fleet id it echoes", () => {
    expect(formatFleetRefusal({ toolName: "belayd_plan", fleetId: "../../evil" })).toContain(
      sanitizeFleetId("../../evil"),
    );
  });
});
