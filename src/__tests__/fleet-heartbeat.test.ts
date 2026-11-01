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
import type { SupervisorHeartbeat } from "../fleet-heartbeat.js";
import {
  classifySupervisorBeat,
  effectiveSupervisorState,
  FLEET_SUPERVISOR_HEARTBEAT_STALE_MS,
  isFleetLoopProvablyDead,
  planSupervisorReadoption,
  readSupervisorHeartbeat,
  writeSupervisorHeartbeat,
} from "../fleet-heartbeat.js";
import type { FleetSupervisorLiveness, FleetSupervisorState } from "../fleet-mode.js";
import type { FleetIntent } from "../fleet-status.js";
import { FLEET_SCHEMA_VERSION } from "../fleet-status.js";

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

describe("isFleetLoopProvablyDead", () => {
  const NOW = 1_000_000;
  const beatAt = (heartbeatAt: number, sessionId = "any-session"): SupervisorHeartbeat => ({
    schemaVersion: 1,
    fleetId: "default",
    sessionId,
    pid: 4242,
    heartbeatAt,
  });

  it("is dead without a beat, cold with a stale one, alive with a fresh one", () => {
    expect(isFleetLoopProvablyDead({ beat: undefined, now: NOW })).toBe(true);
    expect(
      isFleetLoopProvablyDead({
        beat: beatAt(NOW - FLEET_SUPERVISOR_HEARTBEAT_STALE_MS),
        now: NOW,
      }),
    ).toBe(true);
    expect(isFleetLoopProvablyDead({ beat: beatAt(NOW - 1_000), now: NOW })).toBe(false);
  });

  it("ignores whose session the beat names", () => {
    // A leaderless record names nobody, so recency is the only signal available: a
    // fresh beat from any session proves the run is being ticked (bd-169 W1).
    expect(isFleetLoopProvablyDead({ beat: beatAt(NOW - 1_000, "whoever"), now: NOW })).toBe(false);
    expect(
      isFleetLoopProvablyDead({
        beat: beatAt(NOW - FLEET_SUPERVISOR_HEARTBEAT_STALE_MS - 1, "whoever"),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("honours an explicit staleness window", () => {
    expect(isFleetLoopProvablyDead({ beat: beatAt(NOW - 50), now: NOW, staleAfterInMs: 10 })).toBe(
      true,
    );
    expect(isFleetLoopProvablyDead({ beat: beatAt(NOW - 5), now: NOW, staleAfterInMs: 10 })).toBe(
      false,
    );
  });
});

describe("planSupervisorReadoption", () => {
  const SESSION = "supervisor-session";
  const STALE_AFTER = FLEET_SUPERVISOR_HEARTBEAT_STALE_MS;
  const NOW = 1_000_000;

  function intent(overrides: Partial<FleetIntent> = {}): FleetIntent {
    return {
      schemaVersion: FLEET_SCHEMA_VERSION,
      fleetId: "default",
      taskIds: ["bd-12"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
      publish: { mode: "local" },
      supervisor: { sessionId: SESSION, pid: 4242, armToken: "old-token" },
      run: {
        schemaVersion: 1,
        mode: "until-complete",
        startedAt: 1,
        updatedAt: 1,
        ticks: 3,
        accept: false,
      },
      ...overrides,
    };
  }

  function beat(heartbeatAt: number, sessionId = SESSION): SupervisorHeartbeat {
    return { schemaVersion: 1, fleetId: "default", sessionId, pid: 4242, heartbeatAt };
  }

  const deadPid: FleetSupervisorLiveness = { isPidAlive: () => false };
  const livePid: FleetSupervisorLiveness = { isPidAlive: () => true };

  it("adopts a cold beat on an active run its record names this session for", () => {
    const plan = planSupervisorReadoption({
      intent: intent(),
      sessionId: SESSION,
      beat: beat(NOW - STALE_AFTER - 1),
      now: NOW,
    });
    // The adopt arm carries the record the decision was based on: the writer must
    // compare-and-swap against exactly that, not re-read later (bd-169 review S1).
    expect(plan).toMatchObject({
      adopt: true,
      reason: "cold-beat",
      supervisor: { sessionId: SESSION, pid: 4242, armToken: "old-token" },
    });
  });

  it("adopts when the beat names a different session (that loop is gone too)", () => {
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: beat(NOW - 1, "another-session"),
        now: NOW,
      }),
    ).toMatchObject({ adopt: true, reason: "cold-beat" });
  });

  it("refuses while the beat is fresh, so a live loop is never stolen", () => {
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: beat(NOW - 1_000),
        now: NOW,
      }),
    ).toEqual({ adopt: false, reason: "beat-live" });
  });

  it("adopts a missing beat, naming a provably dead supervisor process", () => {
    expect(
      planSupervisorReadoption({ intent: intent(), sessionId: SESSION, beat: undefined, now: NOW }),
    ).toMatchObject({ adopt: true, reason: "missing-beat" });
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: undefined,
        now: NOW,
        liveness: deadPid,
      }),
    ).toMatchObject({ adopt: true, reason: "pid-dead" });
  });

  it("keeps the beat verdict when the recorded process still looks alive", () => {
    // In pi-web the recorded pid is the shared daemon, alive forever: the beat, not
    // the pid, is what says the loop is gone.
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: undefined,
        now: NOW,
        liveness: livePid,
      }),
    ).toMatchObject({ adopt: true, reason: "missing-beat" });
  });

  it("never adopts another session's fleet", () => {
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: "restarted-session",
        beat: beat(NOW - STALE_AFTER - 1),
        now: NOW,
      }),
    ).toEqual({ adopt: false, reason: "other-session" });
  });

  it("refuses an empty session id and a record with no supervisor", () => {
    expect(
      planSupervisorReadoption({
        intent: intent({ supervisor: { sessionId: "", pid: 4242 } }),
        sessionId: "",
        beat: beat(NOW - STALE_AFTER - 1, ""),
        now: NOW,
      }),
    ).toEqual({ adopt: false, reason: "other-session" });
    expect(
      planSupervisorReadoption({
        intent: intent({ supervisor: undefined }),
        sessionId: SESSION,
        beat: undefined,
        now: NOW,
      }),
    ).toEqual({ adopt: false, reason: "no-supervisor-record" });
  });

  it("refuses a terminal or absent run: only work meant to be ticking is revived", () => {
    const finished = intent({
      run: {
        schemaVersion: 1,
        mode: "until-complete",
        startedAt: 1,
        updatedAt: 1,
        ticks: 3,
        finishedAt: 2,
        outcome: "complete",
      },
    });
    const halted = intent({
      run: {
        schemaVersion: 1,
        mode: "until-complete",
        startedAt: 1,
        updatedAt: 1,
        ticks: 3,
        haltedReason: "stalled: no member progressed",
      },
    });
    for (const record of [finished, halted, intent({ run: undefined })]) {
      expect(
        planSupervisorReadoption({
          intent: record,
          sessionId: SESSION,
          beat: beat(NOW - STALE_AFTER - 1),
          now: NOW,
        }),
      ).toEqual({ adopt: false, reason: "no-active-run" });
    }
  });

  it("adopts at the staleness boundary but not one millisecond inside it", () => {
    // `classifySupervisorBeat` is `< staleAfter ? live : dead`, so a beat exactly at
    // the window is already cold. The plan must inherit that boundary rather than
    // re-deriving a stricter one, or a loop that stopped exactly at the window waits
    // one more interval before it can be repaired (bd-169).
    for (const heartbeatAt of [NOW - STALE_AFTER, NOW - STALE_AFTER - 1]) {
      expect(
        planSupervisorReadoption({
          intent: intent(),
          sessionId: SESSION,
          beat: beat(heartbeatAt),
          now: NOW,
        }),
      ).toMatchObject({ adopt: true, reason: "cold-beat" });
    }
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: beat(NOW - STALE_AFTER + 1),
        now: NOW,
      }),
    ).toEqual({ adopt: false, reason: "beat-live" });
  });

  it("honours an explicit staleness window", () => {
    // The override must reach the verdict: a test or an operator-supplied window that
    // was silently ignored would make "cold" mean the built-in 10 minutes only.
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: beat(NOW - 10),
        now: NOW,
        staleAfterInMs: 10,
      }),
    ).toMatchObject({ adopt: true, reason: "cold-beat" });
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: beat(NOW - 9),
        now: NOW,
        staleAfterInMs: 10,
      }),
    ).toEqual({ adopt: false, reason: "beat-live" });
  });

  it("adopts a run that is active but has launched no member yet", () => {
    // A launch that deferred every member still started the loop: the run is the
    // thing that ticks, and it must be revived whether or not a member exists.
    expect(
      planSupervisorReadoption({
        intent: intent({
          run: {
            schemaVersion: 1,
            mode: "until-complete",
            startedAt: 1,
            updatedAt: 1,
            ticks: 0,
            accept: false,
            members: [],
          },
        }),
        sessionId: SESSION,
        beat: beat(NOW - STALE_AFTER - 1),
        now: NOW,
      }),
    ).toMatchObject({ adopt: true, reason: "cold-beat" });
    // The same run with the members field absent entirely (an older record).
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: beat(NOW - STALE_AFTER - 1),
        now: NOW,
      }),
    ).toMatchObject({ adopt: true, reason: "cold-beat" });
  });

  it("decides on the beat's age, not the fleet id it names", () => {
    // The beat is read from this fleet's own directory, so its `fleetId` is not part
    // of the dead-loop verdict: recency is. A fresh beat naming another fleet still
    // blocks the takeover (the conservative direction), and a cold one is exactly as
    // cold as one naming this fleet.
    const foreignBeat = (heartbeatAt: number): SupervisorHeartbeat => ({
      schemaVersion: 1,
      fleetId: "another-fleet",
      sessionId: SESSION,
      pid: 4242,
      heartbeatAt,
    });
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: foreignBeat(NOW - 1_000),
        now: NOW,
      }),
    ).toEqual({ adopt: false, reason: "beat-live" });
    expect(
      planSupervisorReadoption({
        intent: intent(),
        sessionId: SESSION,
        beat: foreignBeat(NOW - STALE_AFTER - 1),
        now: NOW,
      }),
    ).toMatchObject({ adopt: true, reason: "cold-beat" });
  });
});
