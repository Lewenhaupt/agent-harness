/**
 * Unit tests for member-session liveness (bd-126 P4).
 *
 * The process table is injected everywhere, so no test reads a real `/proc` and
 * no test can ever signal a real process. What is asserted is the distinction the
 * rest of P4 depends on: `live` vs `absent` vs `unknown`, and that `unknown` never
 * becomes a reason to signal or prune.
 */

import { describe, expect, it } from "vitest";
import type {
  FleetPidProbe,
  FleetProcessFs,
  FleetProcessScan,
  FleetProcessSnapshot,
} from "../fleet-sessions.js";
import {
  classifyMemberLease,
  classifyMemberLiveness,
  classifyMemberLivenessFromScan,
  classifyMemberLivenessInWorktree,
  FLEET_PROC_SCAN_MAX_ENTRIES,
  isMemberOrchestratorArgv,
  memberSessionToken,
  revalidateMemberPid,
  scanProcesses,
  stopMemberSession,
} from "../fleet-sessions.js";
import { ORCHESTRATOR_CLAIM_STALE_MS } from "../orchestrator-claim.js";

function snapshot(pid: number, argv: readonly string[]): FleetProcessSnapshot {
  return { pid, argv };
}

/** An argv shaped like the one `buildSpawnArgs` produces for a member orchestrator. */
function orchestratorArgv(taskId: string): string[] {
  return [
    "--mode",
    "json",
    "--session-id",
    `belayd-${taskId}`,
    "--name",
    `belayd-${taskId}`,
    "start",
  ];
}

describe("session token matching", () => {
  it("uses the orchestrator session name, not a prefix", () => {
    expect(memberSessionToken("bd-12")).toBe("belayd-bd-12");
    expect(isMemberOrchestratorArgv({ taskId: "bd-12", argv: orchestratorArgv("bd-12") })).toBe(
      true,
    );
    // A phase sub-agent carries `belayd-bd-12-sub-...`, which is a prefix match
    // but not the orchestrator: the ceiling counts orchestrators.
    expect(
      isMemberOrchestratorArgv({
        taskId: "bd-12",
        argv: ["--session-id", "belayd-bd-12-sub-implement-abc"],
      }),
    ).toBe(false);
  });
});

describe("classifyMemberLiveness", () => {
  it("reports every matching pid, sorted", () => {
    const liveness = classifyMemberLiveness({
      taskId: "bd-12",
      processes: [
        snapshot(900, orchestratorArgv("bd-12")),
        snapshot(700, orchestratorArgv("bd-12")),
        snapshot(800, orchestratorArgv("bd-15")),
      ],
    });
    expect(liveness).toEqual({ kind: "live", pids: [700, 900] });
  });

  it("reports absent when the scan worked and nothing matches", () => {
    expect(
      classifyMemberLiveness({
        taskId: "bd-12",
        processes: [snapshot(800, orchestratorArgv("bd-15"))],
      }),
    ).toEqual({ kind: "absent" });
  });

  it("never counts the supervisor's own process", () => {
    expect(
      classifyMemberLiveness({
        taskId: "bd-12",
        processes: [snapshot(4242, orchestratorArgv("bd-12"))],
        selfPid: 4242,
      }),
    ).toEqual({ kind: "absent" });
  });

  it("keeps an unreadable process table distinct from 'gone'", () => {
    const scan: FleetProcessScan = { ok: false, reason: "no procfs" };
    expect(classifyMemberLivenessFromScan({ taskId: "bd-12", scan })).toEqual({
      kind: "unknown",
      reason: "no procfs",
    });
  });
});

describe("classifyMemberLivenessInWorktree (bd-166)", () => {
  const emptyScan: FleetProcessScan = { ok: true, processes: [] };

  it("treats a member with no worktree yet as unknown, not absent", () => {
    // The first half of the spawn window: the intent is written before the worktree
    // exists, so "nothing to probe" must never free the slot a launch is about to fill.
    expect(
      classifyMemberLivenessInWorktree({
        taskId: "bd-12",
        worktreePath: undefined,
        memberRanEvidence: false,
        scan: emptyScan,
      }),
    ).toMatchObject({ kind: "unknown" });
  });

  it("still reports a matching process as live when the worktree cannot be resolved", () => {
    // A CLI-spawned orchestrator has no lease, so its argv token is the evidence.
    expect(
      classifyMemberLivenessInWorktree({
        taskId: "bd-12",
        worktreePath: undefined,
        memberRanEvidence: false,
        scan: { ok: true, processes: [snapshot(700, orchestratorArgv("bd-12"))] },
      }),
    ).toEqual({ kind: "live", pids: [700] });
  });

  it("treats a bare worktree as a spawn in flight, not an absent member", () => {
    // The second half of the window: ensureWorktree + awaitWorktreeReady can take up
    // to a minute before the pending spawn lease is written, so a worktree with no
    // evidence its session ever ran (no state file, no run manifest of this task)
    // proves nothing about the member being gone.
    expect(
      classifyMemberLivenessInWorktree({
        taskId: "bd-12",
        worktreePath: "/repo.feat-bd-12",
        memberRanEvidence: false,
        scan: emptyScan,
      }),
    ).toMatchObject({ kind: "unknown" });
    // A process token is still positive evidence while the worktree is bare.
    expect(
      classifyMemberLivenessInWorktree({
        taskId: "bd-12",
        worktreePath: "/repo.feat-bd-12",
        memberRanEvidence: false,
        scan: { ok: true, processes: [snapshot(700, orchestratorArgv("bd-12"))] },
      }),
    ).toEqual({ kind: "live", pids: [700] });
  });

  it("keeps the real absence signal for a member that provably ran", () => {
    // The evidence is injected: the launch and status call sites derive it from a
    // workflow state file *or* a same-task run manifest, because completion deletes
    // the state file (`memberRanEvidence`, `fleet-run.ts`). Either way the member's
    // session existed, so no lease and no process means gone.
    expect(
      classifyMemberLivenessInWorktree({
        taskId: "bd-12",
        worktreePath: "/repo.feat-bd-12",
        memberRanEvidence: true,
        scan: emptyScan,
      }),
    ).toEqual({ kind: "absent" });
  });

  it("never turns an unreadable or corrupt lease into absence", () => {
    expect(
      classifyMemberLivenessInWorktree({
        taskId: "bd-12",
        worktreePath: "/repo.feat-bd-12",
        memberRanEvidence: true,
        scan: emptyScan,
        lease: { state: "corrupt", error: "not a lease" },
      }),
    ).toMatchObject({ kind: "unknown" });
    expect(
      classifyMemberLivenessInWorktree({
        taskId: "bd-12",
        worktreePath: "/repo.feat-bd-12",
        memberRanEvidence: true,
        scan: { ok: false, reason: "no procfs" },
      }),
    ).toMatchObject({ kind: "unknown" });
  });

  it("reports a live worktree lease as live even without a process", () => {
    expect(
      classifyMemberLivenessInWorktree({
        taskId: "bd-12",
        worktreePath: "/repo.feat-bd-12",
        memberRanEvidence: false,
        scan: emptyScan,
        lease: { state: "live", heartbeatAt: 1_000 },
      }),
    ).toEqual({ kind: "live", pids: [], leaseHeartbeatAt: 1_000 });
  });
});

describe("classifyMemberLease (bd-166)", () => {
  const pending = (heartbeatAt: number) => ({
    kind: "ok" as const,
    claim: {
      schemaVersion: 1 as const,
      taskId: "bd-12",
      branch: "feat/bd-12",
      sessionId: "pending:spawn-token",
      pid: 42,
      claimedAt: heartbeatAt,
      heartbeatAt,
    },
  });

  it("treats a fresh pending spawn claim as live", () => {
    expect(classifyMemberLease({ read: pending(1_000), now: 1_500 })).toEqual({
      state: "live",
      heartbeatAt: 1_000,
    });
  });

  it("treats a stale pending spawn claim as unclassifiable, never absent", () => {
    const stale = classifyMemberLease({
      read: pending(1_000),
      now: 1_000 + ORCHESTRATOR_CLAIM_STALE_MS + 1,
    });
    expect(stale.state).toBe("corrupt");
    // Through the member classifier it is `unknown` (counted), matching the
    // launch/reconcile probe and the status view.
    expect(
      classifyMemberLivenessInWorktree({
        taskId: "bd-12",
        worktreePath: "/repo.feat-bd-12",
        memberRanEvidence: true,
        scan: { ok: true, processes: [] },
        lease: stale,
      }),
    ).toMatchObject({ kind: "unknown" });
  });
});
describe("scanProcesses", () => {
  function fakeProc(entries: Record<string, string>): FleetProcessFs {
    return {
      readdirSync: () => Object.keys(entries),
      readFileSync: (path) => {
        const parts = path.split("/");
        const name = parts[parts.length - 2] ?? "";
        const content = entries[name];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
    };
  }

  it("reads NUL-separated argv for numeric pids only", () => {
    const scan = scanProcesses({
      procRoot: "/proc",
      fs: fakeProc({
        "700": orchestratorArgv("bd-12").join("\u0000"),
        "701": "",
        self: "not-a-pid",
      }),
    });
    expect(scan).toHaveProperty("ok", true);
    if (!scan.ok) return;
    expect(scan.processes).toEqual([snapshot(700, orchestratorArgv("bd-12"))]);
  });

  it("reports an unreadable proc root instead of an empty table", () => {
    const scan = scanProcesses({
      procRoot: "/proc",
      fs: {
        readdirSync: () => {
          throw new Error("EACCES");
        },
        readFileSync: () => "",
      },
    });
    expect(scan).toHaveProperty("ok", false);
    if (scan.ok) return;
    expect(scan.reason).toContain("EACCES");
  });

  it("reports an oversized process table as unknown instead of scanning part of it", () => {
    // A truncated scan would report every member it did not reach as `absent`,
    // which is the direction that prunes live members and frees their slots.
    const names = Array.from({ length: FLEET_PROC_SCAN_MAX_ENTRIES + 1 }, (_unused, index) =>
      String(700 + index),
    );
    const scan = scanProcesses({
      procRoot: "/proc",
      fs: {
        readdirSync: () => names,
        readFileSync: () => orchestratorArgv("bd-12").join("\u0000"),
      },
    });
    expect(scan).toHaveProperty("ok", false);
    if (scan.ok) return;
    expect(scan.reason).toContain(`${names.length} processes`);
    expect(scan.reason).toContain(`above the scan cap of ${FLEET_PROC_SCAN_MAX_ENTRIES}`);
  });
});

describe("revalidateMemberPid", () => {
  function probe(options: {
    argv?: readonly string[] | undefined;
    startTime?: string | undefined;
  }): FleetPidProbe {
    return {
      startTime: () => options.startTime,
      argv: () => options.argv,
    };
  }

  it("accepts a pid whose token and start time are unchanged", () => {
    expect(
      revalidateMemberPid({
        taskId: "bd-12",
        matched: { pid: 700, startTime: "100" },
        probe: probe({ argv: orchestratorArgv("bd-12"), startTime: "100" }),
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a changed start time even when the token still matches", () => {
    const outcome = revalidateMemberPid({
      taskId: "bd-12",
      matched: { pid: 700, startTime: "100" },
      probe: probe({ argv: orchestratorArgv("bd-12"), startTime: "200" }),
    });
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("identity-changed");
  });

  it("rejects an unreadable start time instead of assuming it is unchanged", () => {
    const outcome = revalidateMemberPid({
      taskId: "bd-12",
      matched: { pid: 700, startTime: "100" },
      probe: probe({ argv: orchestratorArgv("bd-12") }),
    });
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("identity-unavailable");
  });

  it("rejects a gone process and a token that moved to another pid", () => {
    for (const argv of [undefined, orchestratorArgv("bd-15")]) {
      const outcome = revalidateMemberPid({
        taskId: "bd-12",
        matched: { pid: 700 },
        probe: probe({ argv, startTime: "100" }),
      });
      expect(outcome).toHaveProperty("ok", false);
      if (outcome.ok) continue;
      expect(outcome.reason).toBe("cmdline-changed");
    }
  });

  it("never accepts a reserved pid", () => {
    const outcome = revalidateMemberPid({
      taskId: "bd-12",
      matched: { pid: 1 },
      probe: probe({ argv: orchestratorArgv("bd-12"), startTime: "100" }),
    });
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("reserved-pid");
  });
});

describe("stopMemberSession", () => {
  const scan: FleetProcessScan = {
    ok: true,
    processes: [snapshot(700, orchestratorArgv("bd-12"))],
  };

  /** Probes whose argv always carries the token and whose start time is stable. */
  function stableProbe(taskId: string): FleetPidProbe {
    return {
      startTime: () => "100",
      argv: (pid) => (pid === 700 || pid === 701 ? orchestratorArgv(taskId) : undefined),
    };
  }

  it("signals exactly the orchestrator pids and reports them", () => {
    const signalled: Array<{ pid: number; signal: string }> = [];
    const result = stopMemberSession({
      taskId: "bd-12",
      scan,
      probe: stableProbe("bd-12"),
      signal: (pid, signalName) => signalled.push({ pid, signal: signalName }),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.pids).toEqual([700]);
    expect(result.outcomes).toEqual([{ pid: 700, kind: "signalled" }]);
    expect(signalled).toEqual([{ pid: 700, signal: "SIGTERM" }]);
  });

  it("refuses to signal anything when the process table is unreadable", () => {
    const signalled: number[] = [];
    const result = stopMemberSession({
      taskId: "bd-12",
      scan: { ok: false, reason: "no procfs" },
      probe: stableProbe("bd-12"),
      signal: (pid) => signalled.push(pid),
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("unidentifiable");
    expect(signalled).toEqual([]);
  });

  it("reports nothing-to-stop when the member has no orchestrator", () => {
    const result = stopMemberSession({
      taskId: "bd-12",
      scan: { ok: true, processes: [] },
      probe: stableProbe("bd-12"),
      signal: () => {
        throw new Error("must not signal");
      },
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("not-running");
  });

  it("never signals a pid that was recycled between match and kill (CR)", () => {
    const signalled: number[] = [];
    // Match captures start time "100"; the re-read immediately before the signal
    // sees "200", which is a different process that inherited the pid.
    const startTimes = ["100", "200"];
    const result = stopMemberSession({
      taskId: "bd-12",
      scan,
      probe: {
        startTime: () => startTimes.shift(),
        argv: () => orchestratorArgv("bd-12"),
      },
      signal: (pid) => signalled.push(pid),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(signalled).toEqual([]);
    expect(result.pids).toEqual([]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ pid: 700, kind: "skipped", reason: "identity-changed" }),
    ]);
  });

  it("never signals a pid whose cmdline no longer carries the token (CR)", () => {
    const signalled: number[] = [];
    const result = stopMemberSession({
      taskId: "bd-12",
      scan,
      probe: { startTime: () => "100", argv: () => ["--session-id", "belayd-bd-15"] },
      signal: (pid) => signalled.push(pid),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(signalled).toEqual([]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ pid: 700, kind: "skipped", reason: "cmdline-changed" }),
    ]);
  });

  it("skips a pid whose start time could not be read at match time (CR)", () => {
    const signalled: number[] = [];
    const result = stopMemberSession({
      taskId: "bd-12",
      scan,
      // Verification would succeed: argv still carries the token and the start
      // time reads back fine. Only the match-time capture failed.
      probe: {
        startTime: () => "100",
        argv: () => orchestratorArgv("bd-12"),
      },
      startTime: () => undefined,
      signal: (pid) => signalled.push(pid),
    });
    // An unreadable start time is identity-unavailable, never "unchanged": on
    // Linux the field is readable for any live pid, so its absence means the
    // process was already gone or the table is inaccessible — argv alone is not
    // enough identity for a signal that cannot be taken back.
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(signalled).toEqual([]);
    expect(result.pids).toEqual([]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ pid: 700, kind: "skipped", reason: "identity-unavailable" }),
    ]);
  });

  it("skips only the recycled pid and still signals its sibling (CR)", () => {
    const signalled: number[] = [];
    // One script per pid, consumed in call order: capture(pid) then re-read(pid).
    const startTimes: Record<number, string[]> = {
      700: ["100", "200"],
      701: ["300", "300"],
    };
    const result = stopMemberSession({
      taskId: "bd-12",
      scan: {
        ok: true,
        processes: [
          snapshot(700, orchestratorArgv("bd-12")),
          snapshot(701, orchestratorArgv("bd-12")),
        ],
      },
      // pid 700 was recycled between match and signal; pid 701 was not.
      probe: {
        startTime: (pid) => startTimes[pid]?.shift(),
        argv: (pid) => (pid === 700 || pid === 701 ? orchestratorArgv("bd-12") : undefined),
      },
      signal: (pid) => signalled.push(pid),
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(signalled).toEqual([701]);
    expect(result.pids).toEqual([701]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ pid: 700, kind: "skipped", reason: "identity-changed" }),
      { pid: 701, kind: "signalled" },
    ]);
  });

  it("signals the remaining pids when one pid's kill throws (CR)", () => {
    const signalled: number[] = [];
    const result = stopMemberSession({
      taskId: "bd-12",
      scan: {
        ok: true,
        processes: [
          snapshot(700, orchestratorArgv("bd-12")),
          snapshot(701, orchestratorArgv("bd-12")),
        ],
      },
      probe: stableProbe("bd-12"),
      signal: (pid) => {
        if (pid === 700) throw new Error("ESRCH: no such process");
        signalled.push(pid);
      },
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(signalled).toEqual([701]);
    expect(result.pids).toEqual([701]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ pid: 700, kind: "failed" }),
      { pid: 701, kind: "signalled" },
    ]);
  });

  it("excludes the supervisor's own pid, prefix-matching ids, and reserved pids (CR)", () => {
    const signalled: number[] = [];
    const result = stopMemberSession({
      taskId: "bd-1",
      scan: {
        ok: true,
        processes: [
          // The supervisor itself, shaped like a member.
          snapshot(4242, orchestratorArgv("bd-1")),
          // A different member whose id starts with this one.
          snapshot(700, orchestratorArgv("bd-12")),
          // A phase sub-agent of this member: same prefix, not the orchestrator.
          snapshot(701, ["--session-id", "belayd-bd-1-sub-implement-abc"]),
          // init must never be signalled, however the table is corrupt.
          snapshot(1, orchestratorArgv("bd-1")),
        ],
      },
      selfPid: 4242,
      probe: {
        startTime: () => "100",
        argv: (pid) =>
          pid === 1 ? orchestratorArgv("bd-1") : orchestratorArgv(pid === 700 ? "bd-12" : "bd-1"),
      },
      signal: (pid) => signalled.push(pid),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    // Only pid 1 matched, and it is reserved.
    expect(result.outcomes).toEqual([
      expect.objectContaining({ pid: 1, kind: "skipped", reason: "reserved-pid" }),
    ]);
    expect(signalled).toEqual([]);
  });
});
