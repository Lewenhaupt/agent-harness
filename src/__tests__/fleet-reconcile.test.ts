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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FleetMergeGitRunner } from "../fleet-merge.js";
import { FLEET_MERGE_ORPHAN_LOCK_GRACE_MS } from "../fleet-merge.js";
import {
  diagnoseMergeQueue,
  FLEET_RECONCILE_ACTIVE_ENTRY_STATES,
  type RunFleetReconcileOptions,
  runFleetReconcile,
} from "../fleet-reconcile.js";
import type { FleetMemberLeaseProbe, FleetProcessScan } from "../fleet-sessions.js";
import type { FleetMergeQueue, FleetStateFs } from "../fleet-state.js";
import {
  createFleetMergeQueue,
  fleetAuditLogPath,
  fleetIntentFilePath,
  fleetMergeLockDir,
  readFleetIntent,
  readFleetMergeQueue,
  writeFleetIntent,
  writeFleetMergeQueue,
} from "../fleet-state.js";
import type { FleetIntent } from "../fleet-status.js";
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
      schemaVersion: 1,
      fleetId,
      taskIds: ["bd-12", "bd-15"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
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
  const path = fleetAuditLogPath(commonDir, fleetId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { action: string }).action);
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
      lockDirPresent: true,
      lockDirAgeInMs: 0,
      mergedIntoBase: [],
      now,
    });
    expect(repairs.map((repair) => [repair.anomaly, repair.action])).toEqual([
      ["expired-lease", "take-over-lock"],
    ]);
  });

  it("clears a lock record whose primitive is gone, even inside its lease", () => {
    const queue: FleetMergeQueue = {
      ...createFleetMergeQueue(1),
      lock: {
        holder: "session-a",
        taskId: "bd-12",
        pid: 111,
        acquiredAt: 1,
        leaseExpiresAt: now + 60_000,
      },
    };
    const repairs = diagnoseMergeQueue({
      queue,
      lockDirPresent: false,
      lockDirAgeInMs: undefined,
      mergedIntoBase: [],
      now,
    });
    expect(repairs.map((repair) => repair.action)).toEqual(["clear-lock-record"]);
  });

  it("leaves an orphaned lock directory alone inside the grace window", () => {
    const repairs = diagnoseMergeQueue({
      queue: undefined,
      lockDirPresent: true,
      lockDirAgeInMs: 1_000,
      mergedIntoBase: [],
      now,
      orphanGraceInMs: 60_000,
    });
    expect(repairs.map((repair) => repair.action)).toEqual(["leave-alone"]);
  });

  it("reclaims an orphaned lock directory past the grace window", () => {
    const repairs = diagnoseMergeQueue({
      queue: undefined,
      lockDirPresent: true,
      lockDirAgeInMs: 120_000,
      mergedIntoBase: [],
      now,
      orphanGraceInMs: 60_000,
    });
    expect(repairs.map((repair) => repair.action)).toEqual(["remove-lock-dir"]);
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
      lockDirPresent: false,
      lockDirAgeInMs: undefined,
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
        lockDirPresent: true,
        lockDirAgeInMs: 0,
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
    ...(options.orderingGates === undefined ? {} : { orderingGates: options.orderingGates }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
}

describe("runFleetReconcile: merge queue", () => {
  it("leaves a consistent queue byte-identical and is idempotent", async () => {
    const fixture = tempCommonDir("queue-clean");
    seedIntent(fixture.commonDir, fixture.fleetId);
    const before = readFileSync(
      join(fixture.commonDir, "belayd", "fleet", fixture.fleetId, "fleet.json"),
      "utf8",
    );

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
    expect(
      readFileSync(
        join(fixture.commonDir, "belayd", "fleet", fixture.fleetId, "fleet.json"),
        "utf8",
      ),
    ).toBe(before);
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
    expect(existsSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId))).toBe(false);
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
      queue: {
        ...createFleetMergeQueue(1),
        lock: {
          holder: "dead-session",
          taskId: "bd-12",
          pid: 111,
          acquiredAt: 1,
          leaseExpiresAt: 5,
        },
      },
    });
    mkdirSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId), { recursive: true });

    const first = await reconcile(fixture);
    expect(first.repairs).toContain("queue:take-over-lock");
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("queue-take-over-lock");
    // Released again: reconcile holds the lock only for the repair.
    expect(readQueue(fixture.commonDir, fixture.fleetId)?.lock).toBe(null);
    expect(existsSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId))).toBe(false);

    const second = await reconcile(fixture);
    expect(second.repairs).toEqual([]);
  });

  it("clears a lock record whose primitive is gone", async () => {
    const fixture = tempCommonDir("queue-record");
    seedIntent(fixture.commonDir, fixture.fleetId);
    writeFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      queue: {
        ...createFleetMergeQueue(1),
        lock: {
          holder: "crashed-session",
          taskId: "bd-12",
          pid: 111,
          acquiredAt: 1,
          leaseExpiresAt: 200_000,
        },
      },
    });

    const first = await reconcile(fixture);
    expect(first.repairs).toEqual(["queue:clear-lock-record"]);
    expect(readQueue(fixture.commonDir, fixture.fleetId)?.lock).toBe(null);
    expect(auditActions(fixture.commonDir, fixture.fleetId)).toContain("queue-clear-lock-record");

    const second = await reconcile(fixture);
    expect(second.repairs).toEqual([]);
  });

  it("surfaces a stale lock record that could not be cleared, and does not half-repair (gap)", async () => {
    const fixture = tempCommonDir("queue-clear-fail");
    seedIntent(fixture.commonDir, fixture.fleetId);
    writeFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      queue: {
        ...createFleetMergeQueue(1),
        lock: {
          holder: "crashed-session",
          taskId: "bd-12",
          pid: 111,
          acquiredAt: 1,
          leaseExpiresAt: 200_000,
        },
      },
    });
    const queuePath = join(
      fixture.commonDir,
      "belayd",
      "fleet",
      fixture.fleetId,
      "merge-queue.json",
    );
    // The record is readable, so the repair is attempted; only the write of the
    // repaired record fails.
    const failingQueueFs: FleetStateFs = {
      existsSync: (path) => nodeFs.existsSync(path),
      readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
      statSync: (path) => {
        const { size, mtimeMs } = nodeFs.statSync(path);
        return { size, mtimeMs };
      },
      writeFileSync: (path, data, writeOptions) => nodeFs.writeFileSync(path, data, writeOptions),
      appendFileSync: (path, data) => nodeFs.appendFileSync(path, data),
      renameSync: (from, to) => {
        if (to === queuePath) throw new Error("EIO: simulated queue write failure");
        nodeFs.renameSync(from, to);
      },
      mkdirSync: (path, mkdirOptions) => {
        nodeFs.mkdirSync(path, mkdirOptions);
      },
      unlinkSync: (path) => nodeFs.unlinkSync(path),
      readdirSync: (path) => nodeFs.readdirSync(path),
      rmdirSync: (path) => nodeFs.rmdirSync(path),
    };

    const result = await reconcile(fixture, {
      git: stubGit(() => undefined),
      fs: failingQueueFs,
    });

    // A repair that could not be written must be reported, never swallowed: the
    // operator has to know the queue is still holding a dead lock.
    expect(result.text).toContain("could not clear the stale lock record");
    expect(result.text).toContain("simulated queue write failure");
    expect(result.warnings.join("\n")).toContain("simulated queue write failure");
    expect(result.text).toContain("the stale lock record could not be cleared");
    expect(result.repairs).toEqual([]);
    expect(readQueue(fixture.commonDir, fixture.fleetId)?.lock?.holder).toBe("crashed-session");
  });

  it("leaves a live lease alone", async () => {
    const fixture = tempCommonDir("queue-live");
    seedIntent(fixture.commonDir, fixture.fleetId);
    writeFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      queue: {
        ...createFleetMergeQueue(1),
        lock: {
          holder: "live-session",
          taskId: "bd-12",
          pid: 111,
          acquiredAt: 90_000,
          leaseExpiresAt: 100_000 + 60_000,
        },
      },
    });
    mkdirSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId), { recursive: true });

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

  it("reclaims an orphaned lock directory past the grace window, and only once", async () => {
    const fixture = tempCommonDir("queue-orphan-stale");
    seedIntent(fixture.commonDir, fixture.fleetId);
    const lockDir = fleetMergeLockDir(fixture.commonDir, fixture.fleetId);
    mkdirSync(lockDir, { recursive: true });
    // Age the primitive past the grace: a crash between `mkdir` and the record
    // write leaves exactly this.
    const staleSeconds = (100_000 - FLEET_MERGE_ORPHAN_LOCK_GRACE_MS - 1000) / 1000;
    utimesSync(lockDir, staleSeconds, staleSeconds);

    const first = await reconcile(fixture);
    expect(first.repairs).toContain("queue:remove-lock-dir");
    // Reconcile's own lock is released again, so a drain can proceed.
    expect(existsSync(lockDir)).toBe(false);
    expect(readQueue(fixture.commonDir, fixture.fleetId)?.lock).toBe(null);

    const second = await reconcile(fixture);
    expect(second.repairs).toEqual([]);
  });

  it("leaves a fresh orphaned lock directory alone and says why", async () => {
    const fixture = tempCommonDir("queue-orphan-fresh");
    seedIntent(fixture.commonDir, fixture.fleetId);
    const lockDir = fleetMergeLockDir(fixture.commonDir, fixture.fleetId);
    mkdirSync(lockDir, { recursive: true });

    const result = await reconcile(fixture);
    expect(result.repairs).toEqual([]);
    expect(result.text).toContain("left alone");
    expect(result.text).toContain("grace window");
    // The winner may still be between `mkdir` and its lease write.
    expect(existsSync(lockDir)).toBe(true);
  });

  it("cannot repair a parked fleet while the queue is unreadable, and says so", async () => {
    const fixture = tempCommonDir("queue-corrupt-parked");
    seedIntent(fixture.commonDir, fixture.fleetId, {
      paused: true,
      park: { reason: "restore conflicted", stashRef: "a".repeat(40), recordedAt: 5 },
    });
    const queuePath = join(
      fixture.commonDir,
      "belayd",
      "fleet",
      fixture.fleetId,
      "merge-queue.json",
    );
    writeFileSync(queuePath, "{not json");

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
    expect(existsSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId))).toBe(false);

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
    const queuePath = join(
      fixture.commonDir,
      "belayd",
      "fleet",
      fixture.fleetId,
      "merge-queue.json",
    );
    let queueWrites = 0;
    const failingReleaseFs: FleetStateFs = {
      existsSync: (path) => nodeFs.existsSync(path),
      readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
      statSync: (path) => {
        const { size, mtimeMs } = nodeFs.statSync(path);
        return { size, mtimeMs };
      },
      writeFileSync: (path, data, writeOptions) => nodeFs.writeFileSync(path, data, writeOptions),
      appendFileSync: (path, data) => nodeFs.appendFileSync(path, data),
      renameSync: (from, to) => {
        if (to === queuePath) {
          queueWrites += 1;
          // The acquire's record landed; the release's update does not.
          if (queueWrites > 1) throw new Error("EIO: simulated release failure");
        }
        nodeFs.renameSync(from, to);
      },
      mkdirSync: (path, mkdirOptions) => {
        nodeFs.mkdirSync(path, mkdirOptions);
      },
      unlinkSync: (path) => nodeFs.unlinkSync(path),
      readdirSync: (path) => nodeFs.readdirSync(path),
      rmdirSync: (path) => nodeFs.rmdirSync(path),
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

    const result = await reconcile(fixture, { scan: live });
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

    const result = await reconcile(fixture, { scan: live, supervisorAlive: true });

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
    mkdirSync(join(commonDir, "belayd", "fleet", fleetId), { recursive: true });
    writeFileSync(
      fleetIntentFilePath(commonDir, fleetId),
      JSON.stringify({
        schemaVersion: 1,
        fleetId,
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        baseBranch: "main",
        paused: true,
        note: "restore conflicted",
        park: { reason: "restore conflicted", stashRef: stashSha, recordedAt: 5 },
      }),
    );

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
    writeFileSync(
      fleetIntentFilePath(commonDir, fleetId),
      JSON.stringify({
        schemaVersion: 1,
        fleetId,
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        baseBranch: "main",
        paused: true,
        note: "restore conflicted",
        park: { reason: "restore conflicted", stashRef: recorded, recordedAt: 5 },
      }),
    );

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

    // Fail the *intent* rename once: the root restore and stash drop succeed, but
    // the unpark CAS write does not, which is the state a crash leaves behind.
    const intentPath = fleetIntentFilePath(commonDir, fleetId);
    let intentWriteFailures = 1;
    const failingIntentFs: FleetStateFs = {
      existsSync: (path) => nodeFs.existsSync(path),
      readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
      statSync: (path) => {
        const { size, mtimeMs } = nodeFs.statSync(path);
        return { size, mtimeMs };
      },
      writeFileSync: (path, data, writeOptions) => nodeFs.writeFileSync(path, data, writeOptions),
      appendFileSync: (path, data) => nodeFs.appendFileSync(path, data),
      renameSync: (from, to) => {
        if (to === intentPath && intentWriteFailures > 0) {
          intentWriteFailures -= 1;
          throw new Error("EIO: simulated intent write failure");
        }
        nodeFs.renameSync(from, to);
      },
      mkdirSync: (path, mkdirOptions) => {
        nodeFs.mkdirSync(path, mkdirOptions);
      },
      unlinkSync: (path) => nodeFs.unlinkSync(path),
      readdirSync: (path) => nodeFs.readdirSync(path),
      rmdirSync: (path) => nodeFs.rmdirSync(path),
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
