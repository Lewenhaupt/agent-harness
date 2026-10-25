/**
 * Unit tests for the worktree orchestrator lease.
 *
 * The lease is the only mechanism that keeps one orchestrator on one worktree, so
 * these cases pin the decisions that matter: a second session is refused while the
 * holder is alive, a cold lease can be taken over (and is archived, never deleted),
 * and a lease that is renewed during the takeover window is not displaced.
 *
 * Real files in a temp directory, no mocks: the atomic-create path (`wx`) is the
 * mutual exclusion, so it has to be the real one under test.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireOrchestratorClaim,
  adoptOrchestratorClaim,
  assignOrchestratorClaimSession,
  classifyOrchestratorClaim,
  describeOrchestratorClaim,
  heartbeatOrchestratorClaim,
  isPendingOrchestratorClaim,
  ORCHESTRATOR_CLAIM_PENDING_PREFIX,
  ORCHESTRATOR_CLAIM_STALE_MS,
  orchestratorClaimPath,
  readOrchestratorClaim,
  releaseOrchestratorClaim,
  replaceOrchestratorClaim,
} from "../orchestrator-claim.js";

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "belayd-claim-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

function acquire(options: {
  sessionId: string;
  now?: number;
  taskId?: string;
  takeOverStale?: boolean;
}) {
  return acquireOrchestratorClaim({
    worktreePath: worktree,
    taskId: options.taskId ?? "bd-12",
    branch: "feat/bd-12",
    sessionId: options.sessionId,
    pid: 4242,
    now: options.now ?? 1_000,
    ...(options.takeOverStale === undefined ? {} : { takeOverStale: options.takeOverStale }),
  });
}

describe("acquireOrchestratorClaim", () => {
  it("creates the lease and reads it back", () => {
    const acquired = acquire({ sessionId: "session-a" });
    expect(acquired).toHaveProperty("ok", true);

    const read = readOrchestratorClaim({ worktreePath: worktree });
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.claim).toMatchObject({
      taskId: "bd-12",
      branch: "feat/bd-12",
      sessionId: "session-a",
      pid: 4242,
      claimedAt: 1_000,
      heartbeatAt: 1_000,
    });
  });

  it("refuses a second session while the holder is alive", () => {
    expect(acquire({ sessionId: "session-a", now: 1_000 })).toHaveProperty("ok", true);

    const second = acquire({ sessionId: "session-b", now: 1_500, takeOverStale: true });
    expect(second).toHaveProperty("ok", false);
    if (second.ok) return;
    expect(second.reason).toBe("held");
    expect(second.verdict).toMatchObject({
      kind: "held",
      state: "live",
      sameSession: false,
      claim: { sessionId: "session-a" },
    });
    expect(describeOrchestratorClaim(second.verdict)).toContain("live orchestrator lease");
    // The holder's record is untouched.
    const read = readOrchestratorClaim({ worktreePath: worktree });
    expect(read.kind === "ok" ? read.claim.sessionId : "").toBe("session-a");
  });

  it("refuses a stale lease unless the caller opts into the takeover", () => {
    expect(acquire({ sessionId: "session-a", now: 1_000 })).toHaveProperty("ok", true);
    const staleNow = 1_000 + ORCHESTRATOR_CLAIM_STALE_MS + 1;

    const refused = acquire({ sessionId: "session-b", now: staleNow });
    expect(refused).toHaveProperty("ok", false);
    if (refused.ok) return;
    expect(refused.verdict).toMatchObject({ kind: "held", state: "stale" });
  });

  it("takes over a cold lease and archives the displaced record", () => {
    expect(acquire({ sessionId: "session-a", now: 1_000 })).toHaveProperty("ok", true);
    const staleNow = 1_000 + ORCHESTRATOR_CLAIM_STALE_MS + 1;

    const taken = acquire({ sessionId: "session-b", now: staleNow, takeOverStale: true });
    expect(taken).toHaveProperty("ok", true);
    if (!taken.ok) return;
    expect(taken.tookOverFrom).toEqual({ taskId: "bd-12", sessionId: "session-a" });
    expect(taken.archivedPath).toBeTypeOf("string");

    const archived = readdirSync(join(worktree, ".belayd")).filter((name) =>
      name.startsWith("orchestrator.stale-"),
    );
    expect(archived.length).toBe(1);
    const read = readOrchestratorClaim({ worktreePath: worktree });
    expect(read.kind === "ok" ? read.claim.sessionId : "").toBe("session-b");
  });

  it("archives an unreadable lease instead of overwriting it silently", () => {
    mkdirSync(join(worktree, ".belayd"), { recursive: true });
    writeFileSync(orchestratorClaimPath(worktree), "{ not json");

    const refused = acquire({ sessionId: "session-a", now: 1_000 });
    expect(refused).toHaveProperty("ok", false);
    if (refused.ok) return;
    expect(refused.reason).toBe("corrupt");

    const taken = acquire({ sessionId: "session-a", now: 1_100, takeOverStale: true });
    expect(taken).toHaveProperty("ok", true);
    const corrupt = readdirSync(join(worktree, ".belayd")).filter((name) =>
      name.includes(".corrupt"),
    );
    expect(corrupt.length).toBe(1);
  });
});

describe("heartbeatOrchestratorClaim", () => {
  it("renews only the owner's lease", () => {
    expect(acquire({ sessionId: "session-a", now: 1_000 })).toHaveProperty("ok", true);

    const renewed = heartbeatOrchestratorClaim({
      worktreePath: worktree,
      sessionId: "session-a",
      now: 2_000,
    });
    expect(renewed).toHaveProperty("ok", true);
    if (!renewed.ok) return;
    expect(renewed.claim.heartbeatAt).toBe(2_000);

    const other = heartbeatOrchestratorClaim({
      worktreePath: worktree,
      sessionId: "session-b",
      now: 3_000,
    });
    expect(other).toHaveProperty("ok", false);
    if (other.ok) return;
    expect(other.reason).toBe("not-owner");
  });

  it("reports a missing lease instead of creating one", () => {
    const result = heartbeatOrchestratorClaim({
      worktreePath: worktree,
      sessionId: "session-a",
      now: 1_000,
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(existsSync(orchestratorClaimPath(worktree))).toBe(false);
  });
});

describe("adoptOrchestratorClaim", () => {
  function adopt(sessionId: string, now: number) {
    return adoptOrchestratorClaim({
      worktreePath: worktree,
      taskId: "bd-12",
      branch: "feat/bd-12",
      sessionId,
      pid: 4242,
      now,
    });
  }

  it("creates a fresh lease for the first session", () => {
    const adopted = adopt("session-a", 1_000);
    expect(adopted).toHaveProperty("ok", true);
    if (!adopted.ok) return;
    expect(adopted.adopted).toBe("fresh");
  });

  it("renews its own lease instead of reporting a conflict", () => {
    expect(adopt("session-a", 1_000)).toHaveProperty("ok", true);
    const again = adopt("session-a", 2_000);
    expect(again).toHaveProperty("ok", true);
    if (!again.ok) return;
    expect(again.adopted).toBe("own");
    expect(again.claim.heartbeatAt).toBe(2_000);
  });

  it("adopts the spawner's pending lease", () => {
    const pendingId = `${ORCHESTRATOR_CLAIM_PENDING_PREFIX}spawn-token`;
    expect(acquire({ sessionId: pendingId, now: 1_000 })).toHaveProperty("ok", true);
    const read = readOrchestratorClaim({ worktreePath: worktree });
    expect(read.kind === "ok" && isPendingOrchestratorClaim(read.claim)).toBe(true);

    const adopted = adopt("session-a", 1_100);
    expect(adopted).toHaveProperty("ok", true);
    if (!adopted.ok) return;
    expect(adopted.adopted).toBe("pending");
    expect(adopted.claim.sessionId).toBe("session-a");
  });

  it("refuses a worktree held by another live session", () => {
    expect(adopt("session-a", 1_000)).toHaveProperty("ok", true);
    const refused = adopt("session-b", 1_100);
    expect(refused).toHaveProperty("ok", false);
    if (refused.ok) return;
    expect(refused.error).toContain("live orchestrator lease");
  });

  it("takes over a cold lease and archives it", () => {
    expect(adopt("session-a", 1_000)).toHaveProperty("ok", true);
    const adopted = adopt("session-b", 1_000 + ORCHESTRATOR_CLAIM_STALE_MS + 1);
    expect(adopted).toHaveProperty("ok", true);
    if (!adopted.ok) return;
    expect(adopted.adopted).toBe("stale");
    expect(adopted.archivedPath).toBeTypeOf("string");
  });
});

describe("releaseOrchestratorClaim", () => {
  it("removes only the owner's lease", () => {
    expect(acquire({ sessionId: "session-a", now: 1_000 })).toHaveProperty("ok", true);

    const wrong = releaseOrchestratorClaim({ worktreePath: worktree, sessionId: "session-b" });
    expect(wrong).toEqual({ ok: true, released: false });
    expect(existsSync(orchestratorClaimPath(worktree))).toBe(true);

    const own = releaseOrchestratorClaim({ worktreePath: worktree, sessionId: "session-a" });
    expect(own).toEqual({ ok: true, released: true });
    expect(existsSync(orchestratorClaimPath(worktree))).toBe(false);
  });
});

describe("assignOrchestratorClaimSession", () => {
  it("points a pending lease at the session daemon's id", () => {
    const pendingId = `${ORCHESTRATOR_CLAIM_PENDING_PREFIX}spawn-token`;
    expect(acquire({ sessionId: pendingId, now: 1_000 })).toHaveProperty("ok", true);

    const assigned = assignOrchestratorClaimSession({
      worktreePath: worktree,
      fromSessionId: pendingId,
      toSessionId: "session-real",
      now: 1_100,
    });
    expect(assigned).toEqual({ ok: true, assigned: true });
    const read = readOrchestratorClaim({ worktreePath: worktree });
    expect(read.kind === "ok" ? read.claim.sessionId : "").toBe("session-real");
  });

  it("is a no-op once the child has adopted the lease itself", () => {
    expect(acquire({ sessionId: "session-real", now: 1_000 })).toHaveProperty("ok", true);
    const assigned = assignOrchestratorClaimSession({
      worktreePath: worktree,
      fromSessionId: `${ORCHESTRATOR_CLAIM_PENDING_PREFIX}spawn-token`,
      toSessionId: "session-real",
      now: 1_100,
    });
    expect(assigned).toEqual({ ok: true, assigned: false });
  });

  it("never steals a lease that already names another session", () => {
    expect(acquire({ sessionId: "session-other", now: 1_000 })).toHaveProperty("ok", true);
    const assigned = assignOrchestratorClaimSession({
      worktreePath: worktree,
      fromSessionId: `${ORCHESTRATOR_CLAIM_PENDING_PREFIX}spawn-token`,
      toSessionId: "session-real",
      now: 1_100,
    });
    expect(assigned).toEqual({ ok: true, assigned: false });
    const read = readOrchestratorClaim({ worktreePath: worktree });
    expect(read.kind === "ok" ? read.claim.sessionId : "").toBe("session-other");
  });
});

describe("classifyOrchestratorClaim", () => {
  it("separates free, live, stale and corrupt", () => {
    expect(classifyOrchestratorClaim({ read: { kind: "absent" }, now: 1_000 })).toEqual({
      kind: "free",
    });

    expect(
      classifyOrchestratorClaim({
        read: { kind: "corrupt", path: "/x", error: "boom" },
        now: 1_000,
      }),
    ).toMatchObject({ kind: "corrupt", error: "boom" });

    expect(acquire({ sessionId: "session-a", now: 1_000 })).toHaveProperty("ok", true);
    const fresh = classifyOrchestratorClaim({
      read: readOrchestratorClaim({ worktreePath: worktree }),
      now: 1_100,
      sessionId: "session-a",
    });
    expect(fresh).toMatchObject({ kind: "held", state: "live", sameSession: true });

    const cold = classifyOrchestratorClaim({
      read: readOrchestratorClaim({ worktreePath: worktree }),
      now: 1_000 + ORCHESTRATOR_CLAIM_STALE_MS + 1,
    });
    expect(cold).toMatchObject({ kind: "held", state: "stale", sameSession: false });
  });
});

describe("replaceOrchestratorClaim", () => {
  it("turns this session's own lease into the spawner's pending one", () => {
    expect(acquire({ sessionId: "session-a", now: 1_000 })).toHaveProperty("ok", true);

    const replaced = replaceOrchestratorClaim({
      worktreePath: worktree,
      expectSessionId: "session-a",
      taskId: "bd-12",
      branch: "feat/bd-12",
      sessionId: `${ORCHESTRATOR_CLAIM_PENDING_PREFIX}spawn-token`,
      pid: 4242,
      now: 1_100,
    });
    expect(replaced).toHaveProperty("ok", true);
    const read = readOrchestratorClaim({ worktreePath: worktree });
    expect(read.kind === "ok" ? read.claim.sessionId : "").toBe(
      `${ORCHESTRATOR_CLAIM_PENDING_PREFIX}spawn-token`,
    );
  });

  it("refuses when another session has taken the lease over", () => {
    expect(acquire({ sessionId: "session-other", now: 1_000 })).toHaveProperty("ok", true);

    const replaced = replaceOrchestratorClaim({
      worktreePath: worktree,
      expectSessionId: "session-a",
      taskId: "bd-12",
      branch: "feat/bd-12",
      sessionId: `${ORCHESTRATOR_CLAIM_PENDING_PREFIX}spawn-token`,
      pid: 4242,
      now: 1_100,
    });
    expect(replaced).toHaveProperty("ok", false);
    if (replaced.ok) return;
    expect(replaced.reason).toBe("not-owner");
    const read = readOrchestratorClaim({ worktreePath: worktree });
    expect(read.kind === "ok" ? read.claim.sessionId : "").toBe("session-other");
  });
});
