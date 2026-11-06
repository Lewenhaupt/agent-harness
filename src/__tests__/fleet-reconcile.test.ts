/**
 * Unit tests for fleet crash reconcile (bd-126 P4).
 *
 * Two fixture styles, chosen per property:
 *
 * - **Pure diagnosis** is table-tested directly: every anomaly → action → reason.
 * - **The engine** runs against a throwaway temp directory as the git common dir
 *   (the merge lock is a real `mkdir` primitive, so stubbing it would test the
 *   stub) with an injected git runner and an injected process table. Nothing here
 *   touches this repository: every path is under the OS temp dir, and the one git
 *   fixture is a `git init` repo the test creates.
 */

import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFleetCapacity } from "../fleet-capacity.js";
import { FLEET_SUPERVISOR_HEARTBEAT_STALE_MS } from "../fleet-heartbeat.js";
import { collectFleetLaunchContext, validateFleetLaunch } from "../fleet-launch.js";
import type { FleetMergeGitRunner } from "../fleet-merge.js";
import {
  diagnoseMergeQueue,
  FLEET_RECONCILE_ACTIVE_ENTRY_STATES,
  type RunFleetReconcileOptions,
  reconcileAuthority,
  reportMemberLiveness,
  runFleetReconcile,
  supervisorProvablyDead,
  supervisorRecordFingerprint,
  supervisorRecordMatches,
} from "../fleet-reconcile.js";
import {
  finishFleetRun,
  memberWorktreeExisted,
  recordRunMemberStopped,
  startFleetRun,
} from "../fleet-run.js";
import type { FleetMemberLeaseProbe, FleetProcessScan } from "../fleet-sessions.js";
import type { FleetMergeQueue, FleetStateFs } from "../fleet-state.js";
import {
  createFleetMergeQueue,
  readFleetIntent,
  readFleetMergeQueue,
  readRecentFleetAuditEntries,
  withFleetLaunchMarker,
  writeFleetIntent,
  writeFleetLaunchMarker,
  writeFleetMergeQueue,
} from "../fleet-state.js";
import type { FleetIntent } from "../fleet-status.js";
import {
  FLEET_MEMBER_SPAWN_GRACE_MS,
  FLEET_SCHEMA_VERSION,
  fleetSpawnInFlight,
} from "../fleet-status.js";
import { openRepoStateStore, repoStatePathForCommonDir } from "../repo-state-store.js";
import { gitContextFreeEnv } from "../worktree.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempCommonDir(label: string): { commonDir: string; fleetId: string } {
  const dir = mkdtempSync(join(tmpdir(), `belayd-reconcile-${label}-`));
  cleanup.push(dir);
  const fleetId = "default";
  mkdirSync(join(dir, "belayd", "fleet", fleetId), { recursive: true });
  return { commonDir: dir, fleetId };
}

function seedIntent(commonDir: string, fleetId: string, intent: Partial<FleetIntent> = {}): void {
  writeFleetIntent({
    gitCommonDir: commonDir,
    fleetId,
    intent: {
      schemaVersion: FLEET_SCHEMA_VERSION,
      fleetId,
      taskIds: ["bd-12", "bd-15"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
      publish: { mode: "local" },
      ...intent,
    },
  });
}

function readIntent(commonDir: string, fleetId: string): FleetIntent {
  const loaded = readFleetIntent({ gitCommonDir: commonDir, fleetId });
  if (!loaded.ok || loaded.intent === undefined) throw new Error("intent unreadable");
  return loaded.intent;
}

function readQueue(commonDir: string, fleetId: string): FleetMergeQueue | undefined {
  const loaded = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId });
  if (!loaded.ok) throw new Error("queue unreadable");
  return loaded.queue;
}

function auditActions(commonDir: string, fleetId: string): string[] {
  // bd-281: audit entries are store rows, not lines in audit.log.
  return readRecentFleetAuditEntries({ gitCommonDir: commonDir, fleetId, since: 0 }).map(
    (entry) => entry.action,
  );
}

/** Seed one merge-lock row (the retired fixture wrote it inside the queue file). */
function seedMergeLock(
  commonDir: string,
  fleetId: string,
  lock: {
    holder: string;
    taskId: string;
    pid: number;
    acquiredAt: number;
    leaseExpiresAt: number;
  },
): void {
  const opened = openRepoStateStore({ path: repoStatePathForCommonDir(commonDir) });
  if (!opened.ok) throw new Error(opened.error);
  const claimed = opened.store.acquireFleetLock({
    fleetId,
    holder: lock.holder,
    taskId: lock.taskId,
    pid: lock.pid,
    nowMs: lock.acquiredAt,
    leaseMs: Math.max(1, lock.leaseExpiresAt - lock.acquiredAt),
    takeOverExpired: true,
  });
  opened.store.close();
  if (!claimed.ok) throw new Error("could not seed the merge lock");
}

const noMembers: FleetProcessScan = { ok: true, processes: [] };

/** A git runner whose every command fails unless a response is scripted. */
function stubGit(responses: (argv: readonly string[]) => string | undefined): FleetMergeGitRunner {
  return async (argv) => {
    const stdout = responses(argv);
    return stdout === undefined
      ? { ok: false, error: `unexpected git ${argv.join(" ")}`, stdout: "", stderr: "not found" }
      : { ok: true, stdout, stderr: "" };
  };
}

// ── Pure diagnosis ────────────────────────────────────────────────────

describe("diagnoseMergeQueue", () => {
  const now = 10_000;

  it("takes over an expired lease", () => {
    const queue: FleetMergeQueue = {
      ...createFleetMergeQueue(1),
      lock: { holder: "dead-session", taskId: "bd-12", pid: 111, acquiredAt: 1, leaseExpiresAt: 5 },
    };
    const repairs = diagnoseMergeQueue({
      queue,
      mergedIntoBase: [],
      now,
    });
    expect(repairs.map((repair) => [repair.anomaly, repair.action])).toEqual([
      ["expired-lease", "take-over-lock"],
    ]);
  });

  it("marks a stuck entry merged only when git proves the branch landed", () => {
    const queue: FleetMergeQueue = {
      ...createFleetMergeQueue(1),
      entries: [
        { taskId: "bd-12", branch: "feat/bd-12", requestedAt: 1, state: "gating", attempts: 1 },
        { taskId: "bd-15", branch: "feat/bd-15", requestedAt: 2, state: "rebasing", attempts: 1 },
        { taskId: "bd-19", branch: "feat/bd-19", requestedAt: 3, state: "queued", attempts: 0 },
      ],
    };
    const repairs = diagnoseMergeQueue({
      queue,
      mergedIntoBase: ["bd-12"],
      now,
    });
    expect(repairs.map((repair) => [repair.taskId, repair.action])).toEqual([
      ["bd-12", "mark-merged"],
      ["bd-15", "reset-queued"],
    ]);
  });

  it("treats an in-flight entry as normal while a lock is live", () => {
    const queue: FleetMergeQueue = {
      ...createFleetMergeQueue(1),
      lock: {
        holder: "session-a",
        taskId: "bd-12",
        pid: 111,
        acquiredAt: 1,
        leaseExpiresAt: now + 60_000,
      },
      entries: [
        { taskId: "bd-12", branch: "feat/bd-12", requestedAt: 1, state: "merging", attempts: 1 },
      ],
    };
    expect(
      diagnoseMergeQueue({
        queue,
        mergedIntoBase: [],
        now,
      }),
    ).toEqual([]);
  });

  it("covers every in-flight state the reconcile table names", () => {
    expect([...FLEET_RECONCILE_ACTIVE_ENTRY_STATES]).toEqual(["rebasing", "gating", "merging"]);
  });
});

// ── Engine: queue repairs, idempotence ────────────────────────────────

interface EngineFixture {
  commonDir: string;
  fleetId: string;
}

async function reconcile(
  fixture: EngineFixture,
  options: {
    git?: FleetMergeGitRunner;
    scan?: FleetProcessScan;
    /** Worktree lease per member, the pi-web orchestrator's only liveness evidence. */
    leaseFor?: (taskId: string) => FleetMemberLeaseProbe | undefined;
    /** The member's worktree, when one still resolves (same probe as status). */
    memberWorktreeFor?: (taskId: string) => string | undefined;
    /** Whether anything in the worktree proves the member's session existed. */
    memberRanFor?: (taskId: string) => boolean;
    /** Whether the member's worktree provably existed (bd-233: deleted tree). */
    worktreeExistedFor?: (taskId: string) => boolean;
    retryMembers?: readonly string[];
    /** Recovery evidence: its fingerprint guards the prune against a concurrent re-arm. */
    recovery?: RunFleetReconcileOptions["recovery"];
    pruneDeadMembers?: boolean;
    supervisorAlive?: boolean;
    /** bd ordering-gate seam (bd-158): a prune must resolve the removed member's gates. */
    orderingGates?: RunFleetReconcileOptions["orderingGates"];
    fs?: FleetStateFs;
  } = {},
) {
  return runFleetReconcile({
    gitCommonDir: fixture.commonDir,
    fleetId: fixture.fleetId,
    sessionId: "supervisor-session",
    pid: process.pid,
    rootCwd: fixture.commonDir,
    now: 100_000,
    scan: options.scan ?? noMembers,
    git: options.git ?? stubGit(() => undefined),
    isPidAlive: () => options.supervisorAlive === true,
    selfPid: process.pid,
    ...(options.pruneDeadMembers === true ? { pruneDeadMembers: true } : {}),
    ...(options.leaseFor === undefined ? {} : { leaseFor: options.leaseFor }),
    ...(options.memberWorktreeFor === undefined
      ? {}
      : { memberWorktreeFor: options.memberWorktreeFor }),
    ...(options.memberRanFor === undefined ? {} : { memberRanFor: options.memberRanFor }),
    ...(options.worktreeExistedFor === undefined
      ? {}
      : { memberWorktreeExistedFor: options.worktreeExistedFor }),
    ...(options.retryMembers === undefined ? {} : { retryMembers: options.retryMembers }),
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    ...(options.orderingGates === undefined ? {} : { orderingGates: options.orderingGates }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
}

describe("runFleetReconcile: merge queue", () => {
  it("leaves a consistent queue byte-identical and is idempotent", async () => {
    const fixture = tempCommonDir("queue-clean");
    seedIntent(fixture.commonDir, fixture.fleetId);
    // bd-281: a no-op reconcile must not rewrite the intent row either.
    const before = readIntent(fixture.commonDir, fixture.fleetId);

    const first = await reconcile(fixture);
    expect(first).toHaveProperty("ok", true);
    expect(first.repairs).toEqual([]);
    expect(first.text).toContain("nothing to repair");
    expect(first.text).toContain("queue: consistent");

    const second = await reconcile(fixture);
    expect(second.repairs).toEqual([]);
    expect(second.text).toBe(first.text);
    // No queue file was created just to prove there was nothing to repair.
    expect(readQueue(fixture.commonDir, fixture.fleetId)).toBe(undefined);
    expect(readIntent(fixture.commonDir, fixture.fleetId)).toEqual(before);
  });

  it("resets a stuck entry to queued, preserving its attempt count", async () => {
    const fixture = tempCommonDir("queue-stuck");
    seedIntent(fixture.commonDir, fixture.fleetId);
    writeFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      queue: {
        ...createFleetMergeQueue(1),
        entries: [
          { taskId: "bd-12", branch: "feat/bd-12", requestedAt: 1, state: "gating", attempts: 2 },
        ],
      },
    });

    const first = await reconcile(fixture);
    expect(first.repairs).toEqual(["queue:reset-queued:bd-12"]);
    const entry = readQueue(fixture.commonDir, fixture.fleetId)?.entries[0];
    expect(entry).toMatchObject({ state: "queued", attempts: 2 });
    expect(entry?.lastError).toContain("reconcile");
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("queue-reset-queued");
    // The lock is released again, so a normal drain can proceed.
    expect(readQueue(fixture.commonDir, fixture.fleetId)?.lock).toBe(null);

    const second = await reconcile(fixture);
    expect(second.repairs).toEqual([]);
    expect(second.text).toContain("nothing to repair");
  });

  it("marks an entry merged when git proves the branch already landed", async () => {
    const fixture = tempCommonDir("queue-merged");
    seedIntent(fixture.commonDir, fixture.fleetId);
    writeFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      queue: {
        ...createFleetMergeQueue(1),
        entries: [
          { taskId: "bd-12", branch: "feat/bd-12", requestedAt: 1, state: "merging", attempts: 1 },
        ],
      },
    });

    const first = await reconcile(fixture, { git: stubGit(() => "") });
    expect(first.repairs).toEqual(["queue:mark-merged:bd-12"]);
    expect(readQueue(fixture.commonDir, fixture.fleetId)?.entries[0]?.state).toBe("merged");
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("queue-mark-merged");
  });

  it("takes over an expired lease and audits it", async () => {
    const fixture = tempCommonDir("queue-lease");
    seedIntent(fixture.commonDir, fixture.fleetId);
    writeFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      queue: createFleetMergeQueue(1),
    });
    seedMergeLock(fixture.commonDir, fixture.fleetId, {
      holder: "dead-session",
      taskId: "bd-12",
      pid: 111,
      acquiredAt: 1,
      leaseExpiresAt: 5,
    });

    const first = await reconcile(fixture);
    expect(first.repairs).toContain("queue:take-over-lock");
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("queue-take-over-lock");
    // Released again: reconcile holds the lock only for the repair.
    expect(readQueue(fixture.commonDir, fixture.fleetId)?.lock).toBe(null);

    const second = await reconcile(fixture);
    expect(second.repairs).toEqual([]);
  });

  it("leaves a live lease alone", async () => {
    const fixture = tempCommonDir("queue-live");
    seedIntent(fixture.commonDir, fixture.fleetId);
    writeFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      queue: createFleetMergeQueue(1),
    });
    seedMergeLock(fixture.commonDir, fixture.fleetId, {
      holder: "live-session",
      taskId: "bd-12",
      pid: 111,
      acquiredAt: 90_000,
      leaseExpiresAt: 100_000 + 60_000,
    });

    const result = await reconcile(fixture);
    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("lock held by live-session");
    // The holder's record is untouched.
    expect(readQueue(fixture.commonDir, fixture.fleetId)?.lock?.holder).toBe("live-session");
  });

  it("is idempotent after mark-merged: the second run neither re-probes nor re-marks", async () => {
    // `mark-merged` is a resting state once applied, so a second pass must not
    // ask git again and must not rewrite the entry (an entry that flipped back
    // would be re-merged, or a landed commit reported as pending forever).
    const fixture = tempCommonDir("queue-merged-twice");
    seedIntent(fixture.commonDir, fixture.fleetId);
    writeFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      queue: {
        ...createFleetMergeQueue(1),
        entries: [
          { taskId: "bd-12", branch: "feat/bd-12", requestedAt: 1, state: "merging", attempts: 1 },
        ],
      },
    });

    const probes: string[][] = [];
    const git = stubGit((argv) => {
      probes.push([...argv]);
      return "";
    });

    const first = await reconcile(fixture, { git });
    expect(first.repairs).toEqual(["queue:mark-merged:bd-12"]);
    const marked = readQueue(fixture.commonDir, fixture.fleetId);
    expect(marked?.entries[0]).toMatchObject({ state: "merged", attempts: 1 });

    probes.length = 0;
    const second = await reconcile(fixture, { git });
    expect(second.repairs).toEqual([]);
    expect(second.text).toContain("nothing to repair");
    // No ancestry probe: a resting entry is not an in-flight one.
    expect(probes).toEqual([]);
    expect(readQueue(fixture.commonDir, fixture.fleetId)).toEqual(marked);
  });

  it("cannot repair a parked fleet while the queue is unreadable, and says so", async () => {
    const fixture = tempCommonDir("queue-corrupt-parked");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      paused: true,
      park: { reason: "restore conflicted", stashRef: "a".repeat(40), recordedAt: 5 },
    });
    const opened = openRepoStateStore({ path: repoStatePathForCommonDir(fixture.commonDir) });
    if (!opened.ok) throw new Error(opened.error);
    opened.store.writeFleetQueue({ fleetId: fixture.fleetId, queue: "{not json" });
    opened.store.close();

    // No git command may run: without the lock the root is never touched.
    const calls: string[][] = [];
    const git = stubGit((argv) => {
      calls.push([...argv]);
      return "";
    });

    const first = await reconcile(fixture, { git });
    expect(first.ok).toBe(true);
    expect(first.repairs).toEqual([]);
    expect(first.warnings.join("\n")).toContain("merge queue could not be read");
    expect(first.text).toContain("park: not repaired");
    // The park pointer survives, so the work is still named.
    expect(readIntent(fixture.commonDir, fixture.fleetId)).toHaveProperty("park");
    expect(calls).toEqual([]);

    // A corrupt queue is not "repaired" by rewriting it, so the second pass
    // reports the same warning and applies nothing either.
    const second = await reconcile(fixture, { git });
    expect(second.repairs).toEqual([]);
    expect(second.warnings.join("\n")).toContain("merge queue could not be read");
  });
});

// ── Engine: parked fleet ──────────────────────────────────────────────

describe("runFleetReconcile: parked fleet", () => {
  const stashSha = "a".repeat(40);

  /**
   * git stub for a parked-fleet restore.
   *
   * `rootDir` is what both checkout-identity probes report; `linked` makes them
   * disagree the way a linked worktree does, and `listed` says whether the
   * recorded sha is still pending in `git stash list`.
   */
  function parkGit(options: {
    rootDir: string;
    calls?: string[][];
    linked?: boolean;
    listed?: boolean;
    onBase?: boolean;
  }): FleetMergeGitRunner {
    let listed = options.listed ?? true;
    const ok = (stdout: string) => ({ ok: true as const, stdout, stderr: "" });
    const handlers: Record<string, () => ReturnType<typeof ok>> = {
      "rev-parse --verify": () => ok(`${stashSha}\n`),
      "rev-parse --abbrev-ref": () => ok(options.onBase === false ? "feature-x\n" : "main\n"),
      "rev-parse --absolute-git-dir": () => ok(`${options.rootDir}\n`),
      "rev-parse --path-format=absolute": () =>
        ok(
          `${options.linked === true ? `${options.rootDir}/.git/worktrees/linked` : options.rootDir}\n`,
        ),
      "stash apply": () => ok(""),
      "stash list": () => ok(listed ? `${stashSha}\n` : ""),
    };
    return async (argv) => {
      options.calls?.push([...argv]);
      const key = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
      const handler = handlers[key];
      if (handler !== undefined) return handler();
      if (key === "stash drop") {
        listed = false;
        return ok(`Dropped ${argv[2] ?? ""} (${stashSha})\n`);
      }
      return {
        ok: false,
        error: `unexpected git ${argv.join(" ")}`,
        stdout: "",
        stderr: "not found",
      };
    };
  }

  it("restores the recorded stash, unparks, and does not restore twice", async () => {
    const fixture = tempCommonDir("park");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      paused: true,
      note: "restore conflicted",
      park: { reason: "restore conflicted", stashRef: stashSha, recordedAt: 5 },
    });
    const calls: string[][] = [];

    const first = await reconcile(fixture, { git: parkGit({ rootDir: fixture.commonDir, calls }) });
    expect(first.repairs).toContain(`park:unparked:${stashSha}`);
    expect(first.text).toContain("restored the root work");
    const intent = readIntent(fixture.commonDir, fixture.fleetId);
    expect(intent).not.toHaveProperty("paused");
    expect(intent).not.toHaveProperty("park");
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("fleet-unparked");
    // The drop was cross-checked against the recorded sha, never a position.
    expect(calls.some((argv) => argv[0] === "stash" && argv[1] === "drop")).toBe(true);

    calls.length = 0;
    const second = await reconcile(fixture, {
      git: parkGit({ rootDir: fixture.commonDir, calls }),
    });
    expect(second.repairs).toEqual([]);
    expect(calls).toEqual([]);
    expect(readIntent(fixture.commonDir, fixture.fleetId)).not.toHaveProperty("park");
  });

  it("keeps the fleet parked when the root is on another branch, naming the fix", async () => {
    const fixture = tempCommonDir("park-branch");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      paused: true,
      park: { reason: "restore conflicted", stashRef: stashSha, recordedAt: 5 },
    });
    const git = parkGit({ rootDir: fixture.commonDir, onBase: false });

    const result = await reconcile(fixture, { git });
    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("still blocked");
    expect(result.text).toContain("check out main");
    expect(readIntent(fixture.commonDir, fixture.fleetId).paused).toBe(true);
  });

  it("refuses a park repair from a linked worktree (W4)", async () => {
    const fixture = tempCommonDir("park-linked");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      paused: true,
      park: { reason: "restore conflicted", stashRef: stashSha, recordedAt: 5 },
    });
    const calls: string[][] = [];
    const git = parkGit({ rootDir: fixture.commonDir, linked: true, calls });

    const result = await reconcile(fixture, { git });
    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("linked worktree");
    // Nothing was applied, dropped, or reset: the checkout is not the root.
    expect(calls.some((argv) => argv[0] === "stash")).toBe(false);
    expect(calls.some((argv) => argv[0] === "reset")).toBe(false);
    expect(readIntent(fixture.commonDir, fixture.fleetId).paused).toBe(true);
  });

  it("unparks a park whose stash is already restored or dropped, without applying it (W3)", async () => {
    const fixture = tempCommonDir("park-already");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      paused: true,
      park: { reason: "restore conflicted", stashRef: stashSha, recordedAt: 5 },
    });
    const calls: string[][] = [];
    // The sha still resolves as a dangling commit but is no longer pending.
    const git = parkGit({ rootDir: fixture.commonDir, listed: false, calls });

    const result = await reconcile(fixture, { git });
    expect(result.repairs).toContain(`park:unparked:${stashSha}`);
    expect(result.text).toContain("already restored or dropped");
    expect(result.text).toContain("was not modified");
    expect(calls.some((argv) => argv[0] === "stash" && argv[1] === "apply")).toBe(false);
    expect(calls.some((argv) => argv[0] === "reset")).toBe(false);
    expect(readIntent(fixture.commonDir, fixture.fleetId)).not.toHaveProperty("park");

    // And it is idempotent: the park is gone, so nothing is retried.
    const again = await reconcile(fixture, { git });
    expect(again.repairs).toEqual([]);
  });

  it("surfaces a failed release of reconcile's own lock as a warning (W5)", async () => {
    const fixture = tempCommonDir("park-release");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      paused: true,
      park: { reason: "restore conflicted", stashRef: stashSha, recordedAt: 5 },
    });
    // bd-281: the release is a lock-row DELETE, so the failing seam is the store.
    const opened = openRepoStateStore({ path: repoStatePathForCommonDir(fixture.commonDir) });
    if (!opened.ok) throw new Error(opened.error);
    const failingReleaseFs: FleetStateFs = {
      existsSync: (path) => nodeFs.existsSync(path),
      readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
      writeFileSync: (path, data, writeOptions) => nodeFs.writeFileSync(path, data, writeOptions),
      renameSync: (from, to) => nodeFs.renameSync(from, to),
      mkdirSync: (path, mkdirOptions) => {
        nodeFs.mkdirSync(path, mkdirOptions);
      },
      unlinkSync: (path) => nodeFs.unlinkSync(path),
      readdirSync: (path) => nodeFs.readdirSync(path),
      store: {
        ...opened.store,
        releaseFleetLock: () => ({ ok: false, error: "EIO: simulated release failure" }),
      },
    };

    const result = await reconcile(fixture, {
      git: parkGit({ rootDir: fixture.commonDir, listed: false }),
      fs: failingReleaseFs,
    });

    expect(result.warnings.join("\n")).toContain("could not release its own merge lock");
    expect(result.warnings.join("\n")).toContain("later merges will report it as held");
    // The repair itself still landed: the fleet is unparked.
    expect(result.repairs).toContain(`park:unparked:${stashSha}`);
    expect(readIntent(fixture.commonDir, fixture.fleetId)).not.toHaveProperty("park");
  });

  it("reports a hand-written pause with no recorded stash instead of clearing it", async () => {
    const fixture = tempCommonDir("park-hand");
    seedIntent(fixture.commonDir, fixture.fleetId, { paused: true, note: "operator pause" });

    const result = await reconcile(fixture);
    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("no stash ref is recorded");
    expect(result.text).toContain("belayd_fleet_resume");
    expect(readIntent(fixture.commonDir, fixture.fleetId).paused).toBe(true);
  });
});

// ── Engine: supervision ───────────────────────────────────────────────

describe("runFleetReconcile: supervision", () => {
  const live: FleetProcessScan = {
    ok: true,
    processes: [{ pid: 700, argv: ["--session-id", "belayd-bd-12"] }],
  };

  it("reports per-member liveness from the process table, not from intent", async () => {
    const fixture = tempCommonDir("supervision");
    seedIntent(fixture.commonDir, fixture.fleetId);

    const result = await reconcile(fixture, {
      scan: live,
      // A launched member leaves its branch behind, so the deleted-tree proof makes a
      // missing worktree `absent` instead of `unknown` (bd-233).
      worktreeExistedFor: () => true,
    });
    expect(result.text).toContain("supervisor: none recorded");
    expect(result.text).toContain("member bd-12: orchestrator live (pid 700)");
    expect(result.text).toContain("member bd-15: orchestrator not running");
    // Reported, not pruned: pruning is opt-in.
    expect(result.repairs).toEqual([]);
  });

  it("prunes a member with no orchestrator process from a live supervisor", async () => {
    // The realistic case: `belayd_fleet_reconcile` only runs in a live supervisor
    // session, so a prune gated on a dead supervisor could never fire. This is the
    // regression test for that unreachable branch.
    const fixture = tempCommonDir("prune-live");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      supervisor: { sessionId: "supervisor-session", pid: 4242 },
    });
    // A member's worktree (with its own workflow state) is separate from the
    // intent; pruning changes which sessions the fleet counts, not what is on disk.
    const worktreeDir = join(fixture.commonDir, "worktrees", "bd-15");
    const workflowFile = join(worktreeDir, ".belayd", "workflow.json");
    mkdirSync(join(worktreeDir, ".belayd"), { recursive: true });
    writeFileSync(workflowFile, `${JSON.stringify({ taskId: "bd-15" })}\n`);

    const pruned = await reconcile(fixture, {
      scan: live,
      pruneDeadMembers: true,
      supervisorAlive: true,
      worktreeExistedFor: () => true,
    });

    expect(pruned.text).toContain("supervisor: live");
    expect(pruned.repairs).toEqual(["member-pruned:bd-15"]);
    expect(pruned.text).toContain("pruned bd-15");
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual(["bd-12"]);
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("member-pruned-dead");
    // The worktree and its workflow state are untouched.
    expect(readFileSync(workflowFile, "utf8")).toBe(`${JSON.stringify({ taskId: "bd-15" })}\n`);

    // Idempotent: the second run has nothing left to prune.
    const again = await reconcile(fixture, {
      scan: live,
      pruneDeadMembers: true,
      supervisorAlive: true,
    });
    expect(again.repairs).toEqual([]);
    expect(again.text).toContain("nothing to prune");
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual(["bd-12"]);
  });

  it("reports provably-dead members and hints at the flag instead of pruning", async () => {
    const fixture = tempCommonDir("prune-hint");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      supervisor: { sessionId: "supervisor-session", pid: 4242 },
    });

    const result = await reconcile(fixture, {
      scan: live,
      supervisorAlive: true,
      worktreeExistedFor: () => true,
    });

    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("member bd-15: orchestrator not running");
    expect(result.text).toContain("re-run with prune-dead-members");
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual(["bd-12", "bd-15"]);
  });

  it("never prunes on an unknown process table, and says the count stays conservative", async () => {
    const fixture = tempCommonDir("prune-unknown");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      supervisor: { sessionId: "supervisor-session", pid: 4242 },
    });

    // A scan that could not complete is "cannot see", never "gone": no read of
    // the table licenses dropping a member.
    for (const scan of [
      { ok: false, reason: "no procfs" },
      { ok: false, reason: "process table truncated at the scan cap" },
    ] as const) {
      const result = await reconcile(fixture, {
        scan,
        pruneDeadMembers: true,
        supervisorAlive: true,
      });
      expect(result.repairs).toEqual([]);
      expect(result.text).toContain("nothing pruned — liveness is unknown");
      expect(result.text).not.toContain("prune-dead-members to remove");
      expect(result.warnings.join("\n")).toContain("member liveness is unknown");
      expect(result.warnings.join("\n")).toContain("capacity");
      expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual(["bd-12", "bd-15"]);
    }
  });

  it("prunes nothing when every recorded member has a live orchestrator", async () => {
    const fixture = tempCommonDir("prune-none-dead");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      supervisor: { sessionId: "supervisor-session", pid: 4242 },
    });

    const result = await reconcile(fixture, {
      scan: {
        ok: true,
        processes: [
          { pid: 700, argv: ["--session-id", "belayd-bd-12"] },
          { pid: 701, argv: ["--session-id", "belayd-bd-15"] },
        ],
      },
      pruneDeadMembers: true,
      supervisorAlive: true,
    });

    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("nothing to prune");
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual(["bd-12", "bd-15"]);
  });

  it("resolves and forgets a pruned member's ordering gates", async () => {
    // W5: a pruned member can never land, so its open gate would be an orphan.
    // The prune path owns that resolve — the extension's post-tool reap is not a
    // guarantee a direct reconcile caller gets.
    const fixture = tempCommonDir("prune-gates");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      supervisor: { sessionId: "supervisor-session", pid: 4242 },
      orderingGates: [
        { blocker: "bd-12", blocked: "bd-15", gateId: "bd-901" },
        { blocker: "bd-15", blocked: "bd-16", gateId: "bd-902" },
      ],
    });
    const resolved: { blocker: string; blocked: string; gateId: string }[][] = [];
    const reaped: string[][] = [];

    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      supervisorAlive: true,
      worktreeExistedFor: () => true,
      orderingGates: {
        resolve: async (gates) => {
          resolved.push([...gates]);
          return { ok: true, resolved: [...gates], remaining: [] };
        },
        reapByPrefix: async (input) => {
          reaped.push([...input.beadIds]);
          return { ok: true, resolved: [], warnings: [] };
        },
      },
    });

    expect(result.repairs).toEqual(["member-pruned:bd-12", "member-pruned:bd-15"]);
    // Both gates touch a dead member (either side), so both are resolved first.
    expect(resolved.flat().map((gate) => gate.gateId)).toEqual(["bd-901", "bd-902"]);
    // And the unrecorded half: bd is asked about the dead beads themselves.
    expect(reaped).toEqual([["bd-12", "bd-15"]]);
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual([]);
    expect(readIntent(fixture.commonDir, fixture.fleetId).orderingGates).toBeUndefined();
  });

  it("keeps a pruned member's gate recorded when bd does not confirm the resolve", async () => {
    const fixture = tempCommonDir("prune-gates-fail");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      supervisor: { sessionId: "supervisor-session", pid: 4242 },
      orderingGates: [{ blocker: "bd-12", blocked: "bd-15", gateId: "bd-901" }],
    });

    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      supervisorAlive: true,
      worktreeExistedFor: () => true,
      orderingGates: {
        resolve: async () => ({
          ok: false,
          error: "bd: database is locked",
          resolved: [],
          remaining: [{ blocker: "bd-12", blocked: "bd-15", gateId: "bd-901" }],
        }),
        reapByPrefix: async () => ({
          ok: false,
          error: "bd: database is locked",
          resolved: [],
          warnings: [],
        }),
      },
    });

    expect(result.warnings.join("\n")).toContain("could not resolve the ordering gate(s)");
    // S4: the warning names the retry owner, so an operator knows the record is kept
    // for the always-on tick rather than forgotten.
    expect(result.warnings.join("\n")).toContain("next tick or reconcile retries");
    // The member is still pruned, but the record stays so a later tick can retry
    // instead of forgetting an open gate.
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual([]);
    expect(readIntent(fixture.commonDir, fixture.fleetId).orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-15", gateId: "bd-901" },
    ]);
  });

  it("reads liveness from the worktree lease, not only the process table", async () => {
    // A pi-web orchestrator is a session inside the daemon: no process carries
    // `belayd-<taskId>`, so the table is empty and the lease is the only evidence.
    // Without it this member was pruned while it was running, and a later launch
    // started a second orchestrator on the same worktree.
    const fixture = tempCommonDir("prune-lease-live");
    seedIntent(fixture.commonDir, fixture.fleetId);

    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      worktreeExistedFor: () => true,
      leaseFor: (taskId) =>
        taskId === "bd-12" ? { state: "live", heartbeatAt: 99_000 } : { state: "absent" },
    });

    expect(result.text).toContain("orchestrator live (worktree lease renewed");
    // bd-12 is live by lease; bd-15 has no lease and no process, so it is gone.
    expect(result.repairs).toContain("member-pruned:bd-15");
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual(["bd-12"]);
  });

  it("never prunes a member whose lease cannot be read", async () => {
    const fixture = tempCommonDir("prune-lease-corrupt");
    seedIntent(fixture.commonDir, fixture.fleetId);

    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      leaseFor: () => ({ state: "corrupt", error: "not an orchestrator lease" }),
    });

    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("liveness unknown");
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual(["bd-12", "bd-15"]);
  });

  it("reports an empty member list instead of a bare supervisor line", async () => {
    const fixture = tempCommonDir("prune-empty");
    seedIntent(fixture.commonDir, fixture.fleetId, { taskIds: [] });

    const result = await reconcile(fixture, { scan: noMembers, pruneDeadMembers: true });

    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("members: none recorded");
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual([]);
  });
});

// ── Engine: a real fixture repository (stash restore contract) ────────

describe("runFleetReconcile: real git fixture", () => {
  // Inherited git-context variables would point these fixtures at the real
  // checkout (see gitContextFreeEnv).
  function git(cwd: string, argv: readonly string[]): string {
    return execFileSync("git", [...argv], {
      cwd,
      env: gitContextFreeEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  it("restores a real parked stash and leaves the checkout clean", async () => {
    const root = mkdtempSync(join(tmpdir(), "belayd-reconcile-repo-"));
    cleanup.push(root);
    git(root, ["init", "-q"]);
    git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(root, ["config", "user.email", "fleet-test@example.invalid"]);
    git(root, ["config", "user.name", "Fleet Test"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "base"]);

    writeFileSync(join(root, "base.txt"), "operator work\n");
    git(root, ["stash", "push", "--include-untracked", "-m", "fleet park"]);
    const stashSha = git(root, ["rev-parse", "--verify", "refs/stash"]);

    const commonDir = join(root, ".git");
    const fleetId = "default";
    // The fleet dir still holds the queue, audit log and merge lock (bd-281 moved
    // only the intent), so the fixture keeps creating it.
    mkdirSync(join(commonDir, "belayd", "fleet", fleetId), { recursive: true });
    // bd-281: the intent (park pointer included) is a store row, not fleet.json.
    seedIntent(commonDir, fleetId, {
      taskIds: ["bd-12"],
      paused: true,
      note: "restore conflicted",
      park: { reason: "restore conflicted", stashRef: stashSha, recordedAt: 5 },
    });

    const result = await runFleetReconcile({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      pid: process.pid,
      rootCwd: root,
      now: Date.now(),
      scan: noMembers,
      git: async (argv, options) => {
        try {
          const stdout = execFileSync("git", [...argv], {
            cwd: options.cwd,
            env: gitContextFreeEnv(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { ok: true, stdout, stderr: "" };
        } catch (error) {
          const failure = error as { stderr?: string; message: string };
          return {
            ok: false,
            error: failure.message,
            stdout: "",
            stderr: failure.stderr ?? "",
          };
        }
      },
      isPidAlive: () => false,
    });

    expect(result.ok).toBe(true);
    expect(result.repairs).toContain(`park:unparked:${stashSha}`);
    expect(readFileSync(join(root, "base.txt"), "utf8")).toBe("operator work\n");
    expect(git(root, ["stash", "list"])).toBe("");
    expect(git(root, ["status", "--porcelain"])).toBe("M base.txt");
    expect(readIntent(commonDir, fleetId)).not.toHaveProperty("park");

    // A second run must not restore anything again (the stash is gone).
    const again = await runFleetReconcile({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      pid: process.pid,
      rootCwd: root,
      now: Date.now(),
      scan: noMembers,
      git: async () => ({ ok: false, error: "no git expected", stdout: "", stderr: "" }),
      isPidAlive: () => false,
    });
    expect(again.repairs).toEqual([]);
    expect(again.ok).toBe(true);
  });

  it("does not re-apply the stash when the first run restored it but its intent write failed (W3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "belayd-reconcile-cas-"));
    cleanup.push(root);
    git(root, ["init", "-q"]);
    git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(root, ["config", "user.email", "fleet-test@example.invalid"]);
    git(root, ["config", "user.name", "Fleet Test"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "base"]);

    writeFileSync(join(root, "base.txt"), "operator work\n");
    git(root, ["stash", "push", "--include-untracked", "-m", "fleet park"]);
    const recorded = git(root, ["rev-parse", "--verify", "refs/stash"]);

    const commonDir = join(root, ".git");
    const fleetId = "default";
    mkdirSync(join(commonDir, "belayd", "fleet", fleetId), { recursive: true });
    seedIntent(commonDir, fleetId, {
      taskIds: ["bd-12"],
      paused: true,
      note: "restore conflicted",
      park: { reason: "restore conflicted", stashRef: recorded, recordedAt: 5 },
    });

    // The git runner records every command so the second run's restraint is
    // asserted against what git was actually asked to do.
    const calls: string[][] = [];
    const runner: FleetMergeGitRunner = async (argv, options) => {
      calls.push([...argv]);
      try {
        const stdout = execFileSync("git", [...argv], {
          cwd: options.cwd,
          env: gitContextFreeEnv(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, stdout, stderr: "" };
      } catch (error) {
        const failure = error as { stderr?: string; message: string };
        return { ok: false, error: failure.message, stdout: "", stderr: failure.stderr ?? "" };
      }
    };

    // Fail the *intent* transaction once: the root restore and stash drop succeed,
    // but the unpark write does not, which is the state a crash leaves behind.
    const opened = openRepoStateStore({ path: repoStatePathForCommonDir(commonDir) });
    if (!opened.ok) throw new Error(opened.error);
    const realStore = opened.store;
    let intentWriteFailures = 1;
    const failingIntentFs: FleetStateFs = {
      existsSync: (path) => nodeFs.existsSync(path),
      readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
      writeFileSync: (path, data, writeOptions) => nodeFs.writeFileSync(path, data, writeOptions),
      renameSync: (from, to) => nodeFs.renameSync(from, to),
      mkdirSync: (path, mkdirOptions) => {
        nodeFs.mkdirSync(path, mkdirOptions);
      },
      unlinkSync: (path) => nodeFs.unlinkSync(path),
      readdirSync: (path) => nodeFs.readdirSync(path),
      store: {
        ...realStore,
        mutateFleet: (input) => {
          if (intentWriteFailures > 0) {
            intentWriteFailures -= 1;
            return { ok: false, error: "EIO: simulated intent write failure" };
          }
          return realStore.mutateFleet(input);
        },
      },
    };

    const first = await runFleetReconcile({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      pid: process.pid,
      rootCwd: root,
      now: Date.now(),
      scan: noMembers,
      git: runner,
      isPidAlive: () => false,
      fs: failingIntentFs,
    });
    // The work was restored, the stash dropped, and the park survives because its
    // CAS write failed.
    expect(readFileSync(join(root, "base.txt"), "utf8")).toBe("operator work\n");
    expect(git(root, ["stash", "list"])).toBe("");
    expect(first.text).toContain("could not");
    expect(readIntent(commonDir, fleetId)).toHaveProperty("park");

    calls.length = 0;
    const second = await runFleetReconcile({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      pid: process.pid,
      rootCwd: root,
      now: Date.now(),
      scan: noMembers,
      git: runner,
      isPidAlive: () => false,
    });

    // The dangling commit is not applied again, and nothing is reset over the
    // restored work.
    expect(calls.some((argv) => argv[0] === "stash" && argv[1] === "apply")).toBe(false);
    expect(calls.some((argv) => argv[0] === "reset")).toBe(false);
    expect(readFileSync(join(root, "base.txt"), "utf8")).toBe("operator work\n");
    expect(second.repairs).toContain(`park:unparked:${recorded}`);
    expect(second.text).toContain("already restored or dropped");
    expect(readIntent(commonDir, fleetId)).not.toHaveProperty("park");

    // And a third run is a no-op again.
    const third = await runFleetReconcile({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      pid: process.pid,
      rootCwd: root,
      now: Date.now(),
      scan: noMembers,
      git: runner,
      isPidAlive: () => false,
    });
    expect(third.repairs).toEqual([]);
  });
});

describe("reconcileAuthority (bd-166)", () => {
  const base = {
    targetFleetId: "wave1",
    supervisedFleetIds: ["default"],
    repoFleetIds: ["default", "wave1", "wave2"],
    sessionId: "supervisor-session",
  };

  it("allows a supervisor to repair its own fleet", () => {
    expect(
      reconcileAuthority({ ...base, targetFleetId: "default", ownFleetId: "default" }),
    ).toEqual({ ok: true, crossFleet: false, recovery: false });
  });

  it("allows a named fleet when the session supervises some fleet in the repository", () => {
    // The wave1 supervisor died; this session owns wave2 and is the operator's
    // repair path, so no hand edit of fleet.json is needed. Queue/park repair only.
    expect(
      reconcileAuthority({
        ...base,
        targetFleetId: "wave1",
        ownFleetId: "wave2",
        supervisedFleetIds: ["wave2"],
      }),
    ).toEqual({ ok: true, crossFleet: true, recovery: false });
    expect(
      reconcileAuthority({
        ...base,
        targetFleetId: "wave1",
        ownFleetId: "wave2",
        supervisedFleetIds: ["wave2"],
        pruneDeadMembers: false,
      }),
    ).toEqual({ ok: true, crossFleet: true, recovery: false });
  });

  it("refuses a cross-fleet prune, naming the owning supervisor path (bd-166)", () => {
    const refused = reconcileAuthority({
      ...base,
      targetFleetId: "wave1",
      ownFleetId: "wave2",
      supervisedFleetIds: ["wave2"],
      pruneDeadMembers: true,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("only allowed on this session's own fleet");
    expect(refused.error).toContain("wave1");
    expect(refused.error).toContain("belayd_fleet_release");
  });

  it("allows pruning the session's own fleet", () => {
    expect(
      reconcileAuthority({
        ...base,
        targetFleetId: "default",
        ownFleetId: "default",
        pruneDeadMembers: true,
      }),
    ).toEqual({ ok: true, crossFleet: false, recovery: false });
  });

  it("refuses a named fleet when this session supervises none, naming the reason", () => {
    const refused = reconcileAuthority({ ...base, supervisedFleetIds: [] });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("supervises no fleet in this repository");
    expect(refused.error).toContain("wave1");
    expect(refused.error).toContain("default, wave1, wave2");
  });
});

// ── Recovery authority and member retry (bd-233) ──────────────────────

const deadSupervisor = { sessionId: "dead-session", pid: 4_242, pidStartTime: "1234" };

function beatAt(heartbeatAt: number, sessionId = "dead-session") {
  return { schemaVersion: 1 as const, fleetId: "default", sessionId, pid: 4_242, heartbeatAt };
}

function runRecord(taskIds: readonly string[], stoppedTaskId?: string) {
  const run = startFleetRun({
    now: 1_000,
    accept: false,
    members: taskIds.map((taskId) => ({ taskId })),
  });
  return stoppedTaskId === undefined
    ? run
    : recordRunMemberStopped({
        run,
        taskId: stoppedTaskId,
        reason: "orchestrator-missing",
        detail: "no live orchestrator lease holds the worktree",
        now: 2_000,
      });
}

describe("supervisorProvablyDead (bd-233)", () => {
  const now = 1_000_000;

  function intent(overrides: Partial<FleetIntent> = {}): FleetIntent {
    return {
      schemaVersion: FLEET_SCHEMA_VERSION,
      fleetId: "default",
      taskIds: ["bd-12"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
      publish: { mode: "local" },
      supervisor: deadSupervisor,
      run: runRecord(["bd-12"]),
      ...overrides,
    };
  }
  const alive = { isPidAlive: () => true };
  const dead = { isPidAlive: () => false };

  it("is not dead for a live pid with a fresh beat", () => {
    expect(
      supervisorProvablyDead({ intent: intent(), beat: beatAt(now - 1_000), now, liveness: alive }),
    ).toEqual({ dead: false, reason: "fresh-beat" });
  });

  it("W6: a fresh beat refutes a dead recorded pid", () => {
    // Some loop is ticking this run right now, so a recorded pid that looks gone (or was
    // reused) must not license a repair against a live run — even when the beat names a
    // different session.
    expect(
      supervisorProvablyDead({ intent: intent(), beat: beatAt(now - 1_000), now, liveness: dead }),
    ).toEqual({ dead: false, reason: "fresh-beat" });
    expect(
      supervisorProvablyDead({
        intent: intent(),
        beat: beatAt(now - 1_000, "another-session"),
        now,
        liveness: dead,
      }),
    ).toEqual({ dead: false, reason: "fresh-beat" });
  });

  it("is dead for a dead pid once its beat is cold", () => {
    expect(
      supervisorProvablyDead({
        intent: intent(),
        beat: beatAt(now - FLEET_SUPERVISOR_HEARTBEAT_STALE_MS),
        now,
        liveness: dead,
      }),
    ).toEqual({ dead: true, reason: "pid-dead", sessionId: "dead-session" });
  });

  it("is dead for a stale beat when the process probe cannot see the pid", () => {
    expect(
      supervisorProvablyDead({
        intent: intent(),
        beat: beatAt(now - FLEET_SUPERVISOR_HEARTBEAT_STALE_MS),
        now,
        // An unreadable /proc is "cannot see": the beat is then the only evidence,
        // and a cold one proves the loop is gone.
        liveness: { isPidAlive: () => true, pidStartTime: () => undefined },
      }),
    ).toEqual({ dead: true, reason: "cold-beat", sessionId: "dead-session" });
  });

  it("is dead when a run-mode fleet has no beat at all", () => {
    expect(
      supervisorProvablyDead({ intent: intent(), beat: undefined, now, liveness: alive }),
    ).toEqual({ dead: true, reason: "missing-beat", sessionId: "dead-session" });
  });

  it("ignores a fresh beat from another session but not a cold one", () => {
    expect(
      supervisorProvablyDead({
        intent: intent(),
        beat: beatAt(now - 1_000, "another-session"),
        now,
        liveness: alive,
      }),
    ).toEqual({ dead: false, reason: "fresh-beat" });
    expect(
      supervisorProvablyDead({
        intent: intent(),
        beat: beatAt(now - FLEET_SUPERVISOR_HEARTBEAT_STALE_MS - 1, "another-session"),
        now,
        liveness: alive,
      }),
    ).toEqual({ dead: true, reason: "other-session", sessionId: "dead-session" });
  });

  it("is never dead for a fleet with no record, or an explicit fleet with a live pid", () => {
    // Nothing to recover: no supervisor to replace and no beat that applies.
    expect(
      supervisorProvablyDead({
        intent: intent({ supervisor: undefined, run: undefined }),
        beat: undefined,
        now,
        liveness: alive,
      }),
    ).toEqual({ dead: false, reason: "no-record" });
    expect(
      supervisorProvablyDead({
        intent: intent({ run: undefined }),
        beat: undefined,
        now,
        liveness: alive,
      }),
    ).toEqual({ dead: false, reason: "no-beat-signal" });
  });
});

describe("reconcileAuthority recovery arm (bd-233)", () => {
  const base = {
    targetFleetId: "wave1",
    supervisedFleetIds: [] as readonly string[],
    repoFleetIds: ["wave1"],
    sessionId: "operator-session",
    supervisorDead: { dead: true as const, reason: "cold-beat" as const },
  };

  it("AC1: allows a named fleet whose supervisor is provably dead", () => {
    expect(reconcileAuthority(base)).toEqual({ ok: true, crossFleet: true, recovery: true });
  });

  it("AC1: allows a prune under recovery authority", () => {
    // The cross-fleet prune refusal protects another *live* supervisor's capacity
    // decision; a provably dead supervisor has none to protect.
    expect(reconcileAuthority({ ...base, pruneDeadMembers: true })).toEqual({
      ok: true,
      crossFleet: true,
      recovery: true,
    });
  });

  it("still refuses a cross-fleet prune while the target's supervisor is live", () => {
    const refused = reconcileAuthority({
      ...base,
      supervisedFleetIds: ["wave2"],
      supervisorDead: { dead: false, reason: "no-beat-signal" },
      pruneDeadMembers: true,
    });
    expect(refused).toHaveProperty("ok", false);
  });

  it("keeps own-fleet precedence, so a dead verdict cannot widen it", () => {
    // Owning the fleet is already the strongest authority, and it is not a recovery: the
    // audit must not claim one for a fleet the session supervises.
    expect(
      reconcileAuthority({
        ...base,
        targetFleetId: "default",
        ownFleetId: "default",
        pruneDeadMembers: true,
      }),
    ).toEqual({ ok: true, crossFleet: false, recovery: false });
  });
});

describe("runFleetReconcile: member retry and pruned stops (bd-233)", () => {
  it("AC3: clears a recorded stop, audits it, and reports what the loop will do", async () => {
    const fixture = tempCommonDir("retry-stop");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-12"],
      run: runRecord(["bd-12"], "bd-12"),
    });

    const result = await reconcile(fixture, { retryMembers: ["bd-12"] });

    expect(result.repairs).toContain("member-retry:bd-12");
    expect(result.text).toContain("retrying bd-12");
    expect(result.text).toContain("next tick");
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("member-retry");
    expect(readIntent(fixture.commonDir, fixture.fleetId).run?.stopped ?? []).toEqual([]);

    // Idempotent: the stop is already gone, so the second call says so.
    const again = await reconcile(fixture, { retryMembers: ["bd-12"] });
    expect(again.repairs).toEqual([]);
    expect(again.text).toContain("had no recorded stop");
  });

  it("warns about an id that is not a member instead of silently ignoring it", async () => {
    const fixture = tempCommonDir("retry-unknown");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-12"],
      run: runRecord(["bd-12"], "bd-12"),
    });

    const result = await reconcile(fixture, { retryMembers: ["bd-12", "bd-99"] });

    expect(result.warnings.join("\n")).toContain("not a member");
    expect(result.warnings.join("\n")).toContain("bd-99");
    expect(result.repairs).toEqual(["member-retry:bd-12"]);
  });

  it("drops the stop of a member it prunes", async () => {
    const fixture = tempCommonDir("prune-stop");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-12", "bd-15"],
      run: runRecord(["bd-12", "bd-15"], "bd-15"),
    });

    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      worktreeExistedFor: () => true,
    });

    expect(result.repairs).toEqual(["member-pruned:bd-12", "member-pruned:bd-15"]);
    const intent = readIntent(fixture.commonDir, fixture.fleetId);
    expect(intent.taskIds).toEqual([]);
    // A fleet must not keep reporting "needs a human" for a member it removed.
    expect(intent.run?.stopped ?? []).toEqual([]);
  });
});

describe("bd-233 regression: a dead supervisor wedges nothing", () => {
  it("re-arms, recovers, prunes, and frees all three slots", async () => {
    const fixture = tempCommonDir("bd-233-dead-supervisor");
    const now = 10_000_000;
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-188", "bd-189", "bd-173"],
      supervisor: deadSupervisor,
      run: runRecord(["bd-188", "bd-189", "bd-173"], "bd-188"),
    });
    const beat = beatAt(now - FLEET_SUPERVISOR_HEARTBEAT_STALE_MS);
    // The incident: pid 1481 gone, last beat 21:32:03Z, members with no worktree and
    // no lease. The branches survive the deleted worktrees, which is the proof that
    // turns `unknown` into the honest `absent`.
    const worktreeExistedFor = (taskId: string): boolean =>
      memberWorktreeExisted({
        taskId,
        branchExists: true,
        worktreeListed: false,
        spawnInFlight: fleetSpawnInFlight({
          gitCommonDir: fixture.commonDir,
          fleetId: fixture.fleetId,
          taskId,
          now,
        }),
      });
    const dead = { isPidAlive: () => false };

    // (1) Launch may re-arm instead of refusing "already a member of fleet default".
    const context = collectFleetLaunchContext({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      liveness: dead,
      supervisorBeat: () => beat,
      now,
    });
    expect(context.fleets[0]?.supervisor).toEqual({ kind: "dead", sessionId: "dead-session" });
    const launch = validateFleetLaunch({
      fleets: context.fleets,
      targetFleetId: fixture.fleetId,
      sessionId: "operator-session",
      taskIds: ["bd-188", "bd-189", "bd-173"],
    });
    expect(launch).toHaveProperty("ok", true);
    if (!launch.ok) return;
    expect(launch.rearm).toBe(true);

    // (2) A session that is not the supervisor may reconcile the named fleet, and the
    // recovery arm may prune.
    const authority = reconcileAuthority({
      targetFleetId: fixture.fleetId,
      supervisedFleetIds: [],
      repoFleetIds: [fixture.fleetId],
      sessionId: "operator-session",
      pruneDeadMembers: true,
      supervisorDead: supervisorProvablyDead({
        intent: readIntent(fixture.commonDir, fixture.fleetId),
        beat,
        now,
        liveness: dead,
      }),
    });
    expect(authority).toEqual({ ok: true, crossFleet: true, recovery: true });

    const report = reportMemberLiveness({
      members: ["bd-188", "bd-189", "bd-173"],
      scan: noMembers,
      worktreeExistedFor,
    });
    expect(report.map((member) => member.liveness.kind)).toEqual(["absent", "absent", "absent"]);

    const pruned = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      worktreeExistedFor,
    });
    expect(pruned.repairs).toEqual([
      "member-pruned:bd-188",
      "member-pruned:bd-189",
      "member-pruned:bd-173",
    ]);
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual([]);
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("member-pruned-dead");

    // (3) Capacity: 0 of 3 slots held, and no member left `unknown`.
    const capacity = describeFleetCapacity({
      ceiling: 3,
      fleets: [
        {
          fleetId: fixture.fleetId,
          supervisor: "dead",
          members: report.map((member) => ({ taskId: member.taskId, liveness: member.liveness })),
        },
      ],
    });
    expect(capacity).toHaveProperty("counted", 0);
    expect(capacity).toHaveProperty("free", 3);
    expect(capacity.contributors[0]).toHaveProperty("unknown", 0);
    expect(capacity.contributors[0]).toHaveProperty("absent", 3);
  });
});

describe("reconcile guards from review round 2 (bd-233)", () => {
  it("CRITICAL: a ticking run's deleted worktree is still absent", async () => {
    // `persistFleetRun` rewrites `intent.updatedAt` every 15 s, so a window keyed on
    // it was permanently open and pruned nothing on a live run. The window is now the
    // member's own launch marker: no marker means no window, whatever the record says.
    const now = 100_000; // reconcile()'s clock
    const fixture = tempCommonDir("ticking-run-absent");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-12"],
      // Ticked five seconds ago; the member was launched an hour ago.
      updatedAt: now - 5_000,
      run: {
        ...startFleetRun({
          now: now - 5_000,
          accept: false,
          members: [{ taskId: "bd-12" }],
        }),
        updatedAt: now - 5_000,
        ticks: 240,
        members: [{ taskId: "bd-12", launchedAt: now - 3_600_000 }],
      },
    });

    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      worktreeExistedFor: (taskId) =>
        memberWorktreeExisted({
          taskId,
          branchExists: true,
          worktreeListed: false,
          spawnInFlight: fleetSpawnInFlight({
            gitCommonDir: fixture.commonDir,
            fleetId: fixture.fleetId,
            taskId,
            now,
          }),
        }),
    });

    expect(result.repairs).toEqual(["member-pruned:bd-12"]);
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual([]);
  });

  it("W2: refuses to prune a member whose spawn marker is live", async () => {
    // A relaunch reuses the surviving branch, so the branch alone would classify as
    // absence while the new worktree is still being created. Only that member's marker
    // holds its slot; nothing about the fleet record does.
    const now = 100_000; // reconcile()'s clock
    const worktreeExistedFor =
      (gitCommonDir: string, fleetId: string) =>
      (taskId: string): boolean =>
        memberWorktreeExisted({
          taskId,
          branchExists: true,
          worktreeListed: false,
          spawnInFlight: fleetSpawnInFlight({ gitCommonDir, fleetId, taskId, now }),
        });

    const fresh = tempCommonDir("spawn-window-fresh");
    seedIntent(fresh.commonDir, fresh.fleetId, { taskIds: ["bd-12"], updatedAt: 1 });
    writeFleetLaunchMarker({
      gitCommonDir: fresh.commonDir,
      fleetId: fresh.fleetId,
      taskId: "bd-12",
      owner: "test-spawn",
      now: now - 5_000,
    });
    const inside = await reconcile(fresh, {
      scan: noMembers,
      pruneDeadMembers: true,
      worktreeExistedFor: worktreeExistedFor(fresh.commonDir, fresh.fleetId),
    });
    expect(inside.repairs).toEqual([]);
    expect(inside.text).toContain("liveness unknown");
    expect(readIntent(fresh.commonDir, fresh.fleetId).taskIds).toEqual(["bd-12"]);

    // A marker older than the grace is an abandoned spawn, not a window.
    const stale = tempCommonDir("spawn-window-stale");
    seedIntent(stale.commonDir, stale.fleetId, { taskIds: ["bd-12"], updatedAt: 1 });
    writeFleetLaunchMarker({
      gitCommonDir: stale.commonDir,
      fleetId: stale.fleetId,
      taskId: "bd-12",
      owner: "test-spawn",
      now: now - FLEET_MEMBER_SPAWN_GRACE_MS - 1,
    });
    const after = await reconcile(stale, {
      scan: noMembers,
      pruneDeadMembers: true,
      worktreeExistedFor: worktreeExistedFor(stale.commonDir, stale.fleetId),
    });
    expect(after.repairs).toEqual(["member-pruned:bd-12"]);
    expect(readIntent(stale.commonDir, stale.fleetId).taskIds).toEqual([]);
  });

  it("W1: a spawn that outlives twice the grace while refreshing is still not pruned", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(100_000);
      const fixture = tempCommonDir("spawn-window-refresh");
      seedIntent(fixture.commonDir, fixture.fleetId, { taskIds: ["bd-12"], updatedAt: 1 });
      let release: (value: string) => void = () => undefined;
      const held = new Promise<string>((resolve) => {
        release = resolve;
      });
      const spawner = withFleetLaunchMarker({
        gitCommonDir: fixture.commonDir,
        fleetId: fixture.fleetId,
        taskId: "bd-12",
        now: Date.now(),
        clock: () => Date.now(),
        spawn: () => held,
      });

      // The spawn began two graces ago and is still running; every refresh re-stamped
      // its marker, so expiry means "no refresh for a grace", not "old spawn".
      vi.advanceTimersByTime(2 * FLEET_MEMBER_SPAWN_GRACE_MS);
      const result = await reconcile(fixture, {
        scan: noMembers,
        pruneDeadMembers: true,
        worktreeExistedFor: (taskId) =>
          memberWorktreeExisted({
            taskId,
            branchExists: true,
            worktreeListed: false,
            spawnInFlight: fleetSpawnInFlight({
              gitCommonDir: fixture.commonDir,
              fleetId: fixture.fleetId,
              taskId,
              now: Date.now(),
            }),
          }),
      });

      expect(result.repairs).toEqual([]);
      expect(result.text).toContain("liveness unknown");
      expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual(["bd-12"]);

      release("session-1");
      expect(await spawner).toHaveProperty("ok", true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("W3/W5: refuses the whole recovery pass when a re-arm rewrote the record", async () => {
    const fixture = tempCommonDir("prune-rearm-race");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-12"],
      updatedAt: 1,
      supervisor: deadSupervisor,
    });
    const verdictIntent = readIntent(fixture.commonDir, fixture.fleetId);
    const fingerprint = supervisorRecordFingerprint(verdictIntent);
    expect(fingerprint).toBeDefined();
    if (fingerprint === undefined) return;

    // The documented runbook says "prune, then re-arm". A second session re-armed in
    // between: no write of this pass may touch the record the new supervisor just wrote.
    writeFleetIntent({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      intent: {
        ...verdictIntent,
        updatedAt: 9_000,
        supervisor: { sessionId: "new-session", pid: process.pid, armToken: "new-token" },
      },
    });

    const gateCalls: string[] = [];
    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      worktreeExistedFor: () => true,
      retryMembers: ["bd-12"],
      recovery: { fingerprint, reason: "cold-beat" },
      orderingGates: {
        resolve: async (gates) => {
          gateCalls.push(...gates.map((gate) => gate.gateId));
          return { ok: true, resolved: [...gates], remaining: [] };
        },
        reapByPrefix: async (input) => {
          gateCalls.push(...input.beadIds);
          return { ok: true, resolved: [], warnings: [] };
        },
      },
    });

    expect(result).toHaveProperty("ok", false);
    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("changed since the recovery verdict");
    expect(result.text).toContain("re-run");
    expect(readIntent(fixture.commonDir, fixture.fleetId).taskIds).toEqual(["bd-12"]);
    // W4: bd is touched only after a successful CAS, so a refused pass leaves the
    // member's ordering gates alone.
    expect(gateCalls).toEqual([]);
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("reconcile-refused");
  });

  it("W4: resolves bd gates only for members the CAS actually removed", async () => {
    const fixture = tempCommonDir("prune-gates-after-cas");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-12", "bd-15"],
      updatedAt: 1,
      supervisor: deadSupervisor,
      orderingGates: [{ blocker: "bd-12", blocked: "bd-15", gateId: "bd-901" }],
    });
    const gateCalls: string[] = [];

    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      // Only bd-12 is absent; bd-15 is live, so only bd-12 may be pruned and only its
      // gates may be resolved.
      worktreeExistedFor: (taskId) => taskId === "bd-12",
      orderingGates: {
        resolve: async (gates) => {
          gateCalls.push(...gates.map((gate) => gate.gateId));
          return { ok: true, resolved: [...gates], remaining: [] };
        },
        reapByPrefix: async (input) => {
          gateCalls.push(...input.beadIds);
          return { ok: true, resolved: [], warnings: [] };
        },
      },
    });

    expect(result.repairs).toEqual(["member-pruned:bd-12"]);
    // The gate still records bd-15 (a live member), but its bd record was resolved only
    // after the prune committed.
    expect(gateCalls).toEqual(["bd-901", "bd-12"]);
    const intent = readIntent(fixture.commonDir, fixture.fleetId);
    expect(intent.taskIds).toEqual(["bd-15"]);
    expect(intent.orderingGates ?? []).toEqual([]);
  });

  it("W2: a re-arm between the prune and the gate drop keeps the gate records", async () => {
    const fixture = tempCommonDir("gate-drop-rearm-race");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-12"],
      updatedAt: 1,
      supervisor: deadSupervisor,
      orderingGates: [{ blocker: "bd-12", blocked: "bd-15", gateId: "bd-901" }],
    });
    const verdictIntent = readIntent(fixture.commonDir, fixture.fleetId);
    const fingerprint = supervisorRecordFingerprint(verdictIntent);
    if (fingerprint === undefined) throw new Error("fingerprint missing");

    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      worktreeExistedFor: () => true,
      recovery: { fingerprint, reason: "cold-beat" },
      orderingGates: {
        resolve: async (gates) => {
          // The re-arm lands inside the bd round-trips: after the prune CAS committed and
          // before the gate-drop CAS. The stale pass must not restamp that record.
          writeFleetIntent({
            gitCommonDir: fixture.commonDir,
            fleetId: fixture.fleetId,
            intent: {
              ...readIntent(fixture.commonDir, fixture.fleetId),
              updatedAt: 9_000,
              supervisor: { sessionId: "new-session", pid: process.pid, armToken: "new-token" },
            },
          });
          return { ok: true, resolved: [...gates], remaining: [] };
        },
        reapByPrefix: async () => ({ ok: true, resolved: [], warnings: [] }),
      },
    });

    const after = readIntent(fixture.commonDir, fixture.fleetId);
    // The prune committed before the re-arm, so the dead member is gone.
    expect(result.repairs).toEqual(["member-pruned:bd-12"]);
    expect(after.taskIds).toEqual([]);
    // The gate records survive and the new supervisor's clock is untouched.
    expect(after.orderingGates ?? []).toEqual([
      { blocker: "bd-12", blocked: "bd-15", gateId: "bd-901" },
    ]);
    expect(after.supervisor?.sessionId).toBe("new-session");
    expect(after.supervisor?.armToken).toBe("new-token");
    expect(after.updatedAt).toBe(9_000);
    expect(result.warnings.join("\n")).toContain("kept their ordering-gate record(s)");
  });
});

describe("kept ordering-gate records (bd-233 W1)", () => {
  it("W1: the kept-records warning names the always-on tick and the reconcile retry", async () => {
    const fixture = tempCommonDir("kept-gates-warning");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-12"],
      updatedAt: 1,
      supervisor: deadSupervisor,
      orderingGates: [{ blocker: "bd-12", blocked: "bd-15", gateId: "bd-901" }],
    });
    const verdictIntent = readIntent(fixture.commonDir, fixture.fleetId);
    const fingerprint = supervisorRecordFingerprint(verdictIntent);
    if (fingerprint === undefined) throw new Error("fingerprint missing");

    const result = await reconcile(fixture, {
      scan: noMembers,
      pruneDeadMembers: true,
      worktreeExistedFor: () => true,
      recovery: { fingerprint, reason: "cold-beat" },
      orderingGates: {
        resolve: async (gates) => {
          // A re-arm lands during the bd round-trips, so the drop CAS is refused.
          writeFleetIntent({
            gitCommonDir: fixture.commonDir,
            fleetId: fixture.fleetId,
            intent: {
              ...readIntent(fixture.commonDir, fixture.fleetId),
              updatedAt: 9_000,
              supervisor: { sessionId: "new-session", pid: process.pid, armToken: "new-token" },
            },
          });
          return { ok: true, resolved: [...gates], remaining: [] };
        },
        reapByPrefix: async () => ({ ok: true, resolved: [], warnings: [] }),
      },
    });

    const warning = result.warnings.join("\n");
    expect(warning).toContain("the next tick or reconcile resolves them");
  });
});

describe("supervisorRecordMatches (bd-233 W5)", () => {
  function intent(): FleetIntent {
    return {
      schemaVersion: FLEET_SCHEMA_VERSION,
      fleetId: "default",
      taskIds: ["bd-12"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
      publish: { mode: "local" },
      supervisor: { sessionId: "dead-session", pid: 4_242, armToken: "token-a" },
    };
  }

  it("matches the exact record and refuses every anchor change", () => {
    const base = intent();
    const fingerprint = supervisorRecordFingerprint(base);
    expect(fingerprint).toBeDefined();
    if (fingerprint === undefined) return;
    expect(supervisorRecordMatches(base, fingerprint)).toBe(true);
    expect(
      supervisorRecordMatches(
        { ...base, supervisor: { sessionId: "new-session", pid: 4_242, armToken: "token-b" } },
        fingerprint,
      ),
    ).toBe(false);
    expect(supervisorRecordMatches({ ...base, updatedAt: 2 }, fingerprint)).toBe(false);
  });

  it("accepts a revision this pass itself stamped", () => {
    const base = intent();
    const fingerprint = supervisorRecordFingerprint(base);
    if (fingerprint === undefined) throw new Error("fingerprint missing");
    expect(
      supervisorRecordMatches({ ...base, updatedAt: 100_000 }, fingerprint, {
        alsoAllowUpdatedAt: 100_000,
      }),
    ).toBe(true);
    // A re-arm still fails: the anchors move with it.
    expect(
      supervisorRecordMatches(
        {
          ...base,
          updatedAt: 100_000,
          supervisor: { sessionId: "new-session", pid: 4_242, armToken: "token-b" },
        },
        fingerprint,
        { alsoAllowUpdatedAt: 100_000 },
      ),
    ).toBe(false);
  });
});

describe("supervisorRecordFingerprint without a record (bd-233 W5)", () => {
  it("has no fingerprint, and matches nothing, when the intent names no supervisor", () => {
    // A fingerprint is what licenses a recovery prune; no record must mint none, or a
    // fleet with nothing to recover would look recoverable.
    const bare: FleetIntent = {
      schemaVersion: FLEET_SCHEMA_VERSION,
      fleetId: "default",
      taskIds: ["bd-12"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
      publish: { mode: "local" },
    };
    expect(supervisorRecordFingerprint(bare)).toBeUndefined();

    const recorded = supervisorRecordFingerprint({
      ...bare,
      supervisor: { sessionId: "dead-session", pid: 4_242 },
    });
    if (recorded === undefined) throw new Error("fingerprint missing");
    // ...and a record that lost its supervisor can never satisfy a verdict it never had.
    expect(supervisorRecordMatches(bare, recorded)).toBe(false);
  });
});

describe("retryStoppedMembers on an inactive run (bd-233 W3)", () => {
  it("W3: leaves the stop intact and warns instead of promising a next tick", async () => {
    const fixture = tempCommonDir("retry-inactive-run");
    const stopped = runRecord(["bd-12"], "bd-12");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      taskIds: ["bd-12"],
      run: finishFleetRun({ run: stopped, now: 3_000, outcome: "partial" }),
    });

    const result = await reconcile(fixture, { retryMembers: ["bd-12"] });

    expect(result.repairs).toEqual([]);
    expect(result.warnings.join("\n")).toContain("bd-12 was not retried");
    expect(result.warnings.join("\n")).toContain("Re-arm the fleet");
    expect(result.text).not.toContain("next tick reconsiders");
    expect(auditActions(fixture.commonDir, fixture.fleetId)).not.toContain("member-retry");
    // The human-facing record survives: nothing will plan the member, so nothing hides it.
    expect(readIntent(fixture.commonDir, fixture.fleetId).run?.stopped).toEqual([
      {
        taskId: "bd-12",
        reason: "orchestrator-missing",
        detail: "no live orchestrator lease holds the worktree",
        at: 2_000,
      },
    ]);
  });
});
