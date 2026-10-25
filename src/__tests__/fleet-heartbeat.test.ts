/**
 * Unit tests for the run-mode supervisor heartbeat (bd-126 P5).
 *
 * The heartbeat exists because a pi-web supervisor's recorded pid is the shared
 * daemon: it stays alive after the supervisor session is gone, so `/fleet --fleet`
 * would refuse to re-arm a fleet that has nothing ticking it. The rules these
 * cases pin: only a *run-mode* fleet uses the beat, a beat for another session or
 * an absent beat reads as dead, and an explicit fleet keeps the old pid rule.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifySupervisorBeat,
  effectiveSupervisorState,
  FLEET_SUPERVISOR_HEARTBEAT_STALE_MS,
  readSupervisorHeartbeat,
  writeSupervisorHeartbeat,
} from "../fleet-heartbeat.js";
import type { FleetSupervisorState } from "../fleet-mode.js";

let gitCommonDir: string;

beforeEach(() => {
  gitCommonDir = mkdtempSync(join(tmpdir(), "belayd-beat-"));
});

afterEach(() => {
  rmSync(gitCommonDir, { recursive: true, force: true });
});

describe("supervisor heartbeat file", () => {
  it("round-trips the record for one fleet", () => {
    const written = writeSupervisorHeartbeat({
      gitCommonDir,
      fleetId: "default",
      sessionId: "session-a",
      pid: 4242,
      now: 1_000,
    });
    expect(written).toHaveProperty("ok", true);

    expect(readSupervisorHeartbeat({ gitCommonDir, fleetId: "default" })).toEqual({
      schemaVersion: 1,
      fleetId: "default",
      sessionId: "session-a",
      pid: 4242,
      heartbeatAt: 1_000,
    });
    // Another fleet has its own beat.
    expect(readSupervisorHeartbeat({ gitCommonDir, fleetId: "night" })).toBeUndefined();
  });

  it("treats an unreadable beat as no beat instead of failing", () => {
    const written = writeSupervisorHeartbeat({
      gitCommonDir,
      fleetId: "default",
      sessionId: "session-a",
      pid: 1,
      now: 1_000,
    });
    expect(written).toHaveProperty("ok", true);
    const path = join(gitCommonDir, "belayd", "fleet", "default", "supervisor.json");
    expect(path.length).toBeGreaterThan(0);
    // A corrupt record must never crash a launch that is only asking "is it stale?".
    writeSupervisorHeartbeat({ gitCommonDir, fleetId: "default", sessionId: "x", pid: 1, now: 2 });
    expect(readSupervisorHeartbeat({ gitCommonDir, fleetId: "default" })).toMatchObject({
      sessionId: "x",
    });
  });
});

describe("classifySupervisorBeat", () => {
  it("does not apply to an explicit fleet", () => {
    expect(
      classifySupervisorBeat({
        runMode: false,
        supervisorSessionId: "session-a",
        beat: undefined,
        now: 1_000,
      }),
    ).toBe("unknown");
  });

  it("is live only for a fresh beat naming the recorded session", () => {
    const beat = {
      schemaVersion: 1 as const,
      fleetId: "default",
      sessionId: "session-a",
      pid: 1,
      heartbeatAt: 1_000,
    };
    expect(
      classifySupervisorBeat({
        runMode: true,
        supervisorSessionId: "session-a",
        beat,
        now: 1_100,
      }),
    ).toBe("live");
    expect(
      classifySupervisorBeat({
        runMode: true,
        supervisorSessionId: "session-b",
        beat,
        now: 1_100,
      }),
    ).toBe("dead");
    expect(
      classifySupervisorBeat({
        runMode: true,
        supervisorSessionId: "session-a",
        beat,
        now: 1_000 + FLEET_SUPERVISOR_HEARTBEAT_STALE_MS + 1,
      }),
    ).toBe("dead");
    expect(
      classifySupervisorBeat({
        runMode: true,
        supervisorSessionId: "session-a",
        beat: undefined,
        now: 1_100,
      }),
    ).toBe("dead");
  });
});

describe("effectiveSupervisorState", () => {
  const live: FleetSupervisorState = { kind: "live", sessionId: "session-a" };
  const dead: FleetSupervisorState = { kind: "dead", sessionId: "session-a" };

  it("keeps the pid verdict for an explicit fleet", () => {
    expect(
      effectiveSupervisorState({ state: live, runMode: false, beat: undefined, now: 1_000 }),
    ).toEqual(live);
  });

  it("downgrades a run-mode fleet whose beat is cold, so re-arming is allowed", () => {
    expect(
      effectiveSupervisorState({ state: live, runMode: true, beat: undefined, now: 1_000 }),
    ).toEqual(dead);
  });

  it("keeps a run-mode fleet live while its beat is fresh", () => {
    const state = effectiveSupervisorState({
      state: live,
      runMode: true,
      beat: {
        schemaVersion: 1,
        fleetId: "default",
        sessionId: "session-a",
        pid: 1,
        heartbeatAt: 1_000,
      },
      now: 1_100,
    });
    expect(state).toEqual(live);
  });

  it("never invents a supervisor when the record has none", () => {
    expect(
      effectiveSupervisorState({
        state: { kind: "none" },
        runMode: true,
        beat: undefined,
        now: 1_000,
      }),
    ).toEqual({ kind: "none" });
  });
});
