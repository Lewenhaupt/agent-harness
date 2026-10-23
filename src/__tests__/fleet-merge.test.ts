/**
 * Unit tests for the P2 merge queue (bd-126): the out-of-band acquire primitive,
 * lease renewal/takeover, and the merge sequence itself.
 *
 * Two deliberate choices:
 *
 * - **The lock tests drive the real `mkdir` primitive against a temp directory**,
 *   not a stubbed filesystem — `EEXIST` atomicity is the property under test, so
 *   stubbing it would test the stub.
 * - **The merge tests run real git in throwaway `git init` fixture repositories.**
 *   One test snapshots this repository's HEAD/base ref/stash before and after a
 *   full merge run and asserts nothing changed, which is the standing proof that
 *   no P2 path can mutate the checkout the tests are running from.
 */

import { execFileSync } from "node:child_process";
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
import type { FleetMergeGateRunner, FleetMergeGitRunner } from "../fleet-merge.js";
import {
  acquireFleetMerge,
  checkRootCheckout,
  defaultFleetMergeGitRunner,
  drainFleetMerge,
  enqueueFleetMerge,
  FLEET_MERGE_ORPHAN_LOCK_GRACE_MS,
  formatFleetMergeQueue,
  readFleetGateCommands,
  releaseFleetMerge,
  renewFleetMergeLease,
  resolveFleetGateCommands,
  resolveFleetGateRunner,
  restoreRecordedStash,
} from "../fleet-merge.js";
import type { FleetMergeQueue } from "../fleet-state.js";
import {
  createFleetMergeLock,
  createFleetMergeQueue,
  drainNotes,
  fleetAuditLogPath,
  fleetEventsDir,
  fleetMergeLockDir,
  readFleetIntent,
  readFleetMergeQueue,
  updateFleetIntent,
  updateFleetMergeQueue,
} from "../fleet-state.js";
import { gitContextFreeEnv } from "../worktree.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `belayd-${label}-`));
  cleanup.push(dir);
  return dir;
}

// ── Lock primitive (real mkdir, real directory) ───────────────────────

describe("merge lock: atomic acquire, lease renewal, takeover", () => {
  function lockFixture(): { gitCommonDir: string; fleetId: string } {
    const gitCommonDir = tempDir("merge-lock");
    mkdirSync(join(gitCommonDir, "belayd", "fleet", "default"), { recursive: true });
    return { gitCommonDir, fleetId: "default" };
  }

  function writeQueue(gitCommonDir: string, queue: FleetMergeQueue): void {
    const written = updateFleetMergeQueue({
      gitCommonDir,
      fleetId: "default",
      update: () => queue,
    });
    if (!written.ok) throw new Error(written.error);
  }

  it("lets exactly one of two concurrent acquires win (real mkdir)", () => {
    const { gitCommonDir, fleetId } = lockFixture();

    const first = acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-a",
      taskId: "bd-12",
      pid: 111,
      now: 1000,
    });
    expect(first).toHaveProperty("ok", true);

    const second = acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-b",
      taskId: "bd-15",
      pid: 222,
      now: 1000,
    });
    expect(second).toHaveProperty("ok", false);
    if (second.ok) return;
    expect(second.reason).toBe("lock-held");
    expect(second.holder).toBe("session-a");

    // The primitive is a real directory, which is what made the second lose.
    expect(existsSync(fleetMergeLockDir(gitCommonDir, fleetId))).toBe(true);

    const queue = readFleetMergeQueue({ gitCommonDir, fleetId });
    if (!queue.ok) throw new Error(queue.error);
    expect(queue.queue?.lock?.holder).toBe("session-a");
  });

  it("refuses to release a lock held by another session", () => {
    const { gitCommonDir, fleetId } = lockFixture();
    acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-a",
      taskId: "bd-12",
      pid: 111,
      now: 1000,
    });

    const refused = releaseFleetMerge({ gitCommonDir, fleetId, holder: "session-b", now: 1100 });
    expect(refused).toHaveProperty("ok", false);
    if (refused.ok) return;
    expect(refused.reason).toBe("not-holder");

    // Nothing was released.
    const queue = readFleetMergeQueue({ gitCommonDir, fleetId });
    if (!queue.ok) throw new Error(queue.error);
    expect(queue.queue?.lock?.holder).toBe("session-a");

    const released = releaseFleetMerge({ gitCommonDir, fleetId, holder: "session-a", now: 1100 });
    expect(released).toHaveProperty("ok", true);
    expect(existsSync(fleetMergeLockDir(gitCommonDir, fleetId))).toBe(false);
    const after = readFleetMergeQueue({ gitCommonDir, fleetId });
    if (!after.ok) throw new Error(after.error);
    expect(after.queue?.lock).toBe(null);
  });

  it("takes over an expired lease without consulting the recorded pid", () => {
    const { gitCommonDir, fleetId } = lockFixture();
    const first = acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-a",
      taskId: "bd-12",
      pid: 111,
      now: 1000,
      leaseInMs: 500,
    });
    expect(first).toHaveProperty("ok", true);

    // Still inside the lease: held, even though the pid is obviously fake.
    const held = acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-b",
      taskId: "bd-15",
      pid: 222,
      now: 1499,
    });
    expect(held).toHaveProperty("ok", false);

    // Lease deadline is inclusive; expiry alone authorizes the takeover.
    const taken = acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-b",
      taskId: "bd-15",
      pid: 222,
      now: 1500,
    });
    expect(taken).toHaveProperty("ok", true);
    if (!taken.ok) return;
    expect(taken.reason).toBe("lease-expired");
    expect(taken.lock.holder).toBe("session-b");
  });

  it("extends the lease on renewal, and refuses to renew a foreign lease", () => {
    const { gitCommonDir, fleetId } = lockFixture();
    acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-a",
      taskId: "bd-12",
      pid: 111,
      now: 1000,
    });

    const renewed = renewFleetMergeLease({
      gitCommonDir,
      fleetId,
      holder: "session-a",
      taskId: "bd-12",
      now: 2000,
      leaseInMs: 60_000,
    });
    expect(renewed).toHaveProperty("ok", true);
    if (!renewed.ok) return;
    expect(renewed.lock.leaseExpiresAt).toBe(62_000);

    const queue = readFleetMergeQueue({ gitCommonDir, fleetId });
    if (!queue.ok) throw new Error(queue.error);
    expect(queue.queue?.lock?.leaseExpiresAt).toBe(62_000);

    const foreign = renewFleetMergeLease({
      gitCommonDir,
      fleetId,
      holder: "session-b",
      taskId: "bd-12",
      now: 3000,
    });
    expect(foreign).toHaveProperty("ok", false);
    if (foreign.ok) return;
    expect(foreign.reason).toBe("not-holder");
  });

  it("diagnoses a lock directory without a record, then recovers after the grace", () => {
    const { gitCommonDir, fleetId } = lockFixture();
    const lockDir = fleetMergeLockDir(gitCommonDir, fleetId);
    mkdirSync(lockDir, { recursive: true });
    const now = Date.now();

    const blocked = acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-a",
      taskId: "bd-12",
      pid: 111,
      now,
    });
    expect(blocked).toHaveProperty("ok", false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe("orphan-lock-dir");
    expect(blocked.error).toContain("merge.lock.d");

    // Age the primitive past the grace: a crash between mkdir and the record
    // write must not wedge the queue.
    const old = (now - FLEET_MERGE_ORPHAN_LOCK_GRACE_MS - 1000) / 1000;
    utimesSync(lockDir, old, old);

    const recovered = acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-a",
      taskId: "bd-12",
      pid: 111,
      now,
    });
    expect(recovered).toHaveProperty("ok", true);
  });

  it("diagnoses a record without the lock directory, and it becomes acquirable on expiry", () => {
    const { gitCommonDir, fleetId } = lockFixture();
    writeQueue(gitCommonDir, {
      ...createFleetMergeQueue(1000),
      lock: createFleetMergeLock({
        holder: "session-a",
        taskId: "bd-12",
        pid: 111,
        now: 1000,
        leaseInMs: 5000,
      }),
    });

    const blocked = acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-b",
      taskId: "bd-15",
      pid: 222,
      now: 2000,
    });
    expect(blocked).toHaveProperty("ok", false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe("record-without-lock");
    expect(blocked.error).toContain("merge.lock.d");

    const recovered = acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-b",
      taskId: "bd-15",
      pid: 222,
      now: 6000,
    });
    expect(recovered).toHaveProperty("ok", true);
  });

  it("refuses to renew a lease whose primitive is gone", () => {
    const { gitCommonDir, fleetId } = lockFixture();
    acquireFleetMerge({
      gitCommonDir,
      fleetId,
      holder: "session-a",
      taskId: "bd-12",
      pid: 111,
      now: 1000,
    });
    rmSync(fleetMergeLockDir(gitCommonDir, fleetId), { recursive: true });

    const renewed = renewFleetMergeLease({
      gitCommonDir,
      fleetId,
      holder: "session-a",
      taskId: "bd-12",
      now: 2000,
    });
    expect(renewed).toHaveProperty("ok", false);
    if (renewed.ok) return;
    expect(renewed.reason).toBe("lock-dir-missing");
  });
});

// ── Gate derivation ───────────────────────────────────────────────────

describe("restoreRecordedStash", () => {
  const recorded = "a".repeat(40);
  const other = "b".repeat(40);
  const commonDir = "/repo/.git";

  function stashGit(options: {
    onBase?: boolean;
    ownedCheckout?: boolean;
    reportedDropSha?: string;
    listedAfterDrop?: readonly string[];
  }): FleetMergeGitRunner {
    const ok = (stdout: string) => ({ ok: true as const, stdout, stderr: "" });
    const handlers: Record<string, () => ReturnType<typeof ok>> = {
      "rev-parse --verify": () => ok(recorded),
      "rev-parse --abbrev-ref": () => ok(options.onBase === false ? "feature-x" : "main"),
      "rev-parse --absolute-git-dir": () => ok(`${commonDir}\n`),
      "rev-parse --path-format=absolute": () =>
        ok(`${options.ownedCheckout === false ? "/repo/.git/worktrees/linked" : commonDir}\n`),
      "stash apply": () => ok(""),
      "stash list": () => ok((options.listedAfterDrop ?? [recorded]).join("\n")),
    };
    return async (argv) => {
      const key = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
      const handler = handlers[key];
      if (handler !== undefined) return handler();
      if (key === "stash drop") {
        return ok(`Dropped ${argv[2] ?? "stash@{0}"} (${options.reportedDropSha ?? recorded})\n`);
      }
      return {
        ok: false,
        error: `unexpected git ${argv.join(" ")}`,
        stdout: "",
        stderr: "not found",
      };
    };
  }

  it("applies the recorded sha and drops nothing when the drop matches", async () => {
    const restored = await restoreRecordedStash({
      rootCwd: "/repo",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git: stashGit({ listedAfterDrop: [] }),
    });
    expect(restored).toHaveProperty("ok", true);
    expect(restored.warnings).toEqual([]);
    expect(restored.ok ? restored.dropMismatch : "unexpected").toBe(undefined);
  });

  it("warns and reports a mismatch when the drop removed a different stash (W4)", async () => {
    const restored = await restoreRecordedStash({
      rootCwd: "/repo",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git: stashGit({ reportedDropSha: other, listedAfterDrop: [recorded] }),
    });
    expect(restored).toHaveProperty("ok", true);
    if (!restored.ok) return;
    expect(restored.dropMismatch).toContain("different stash entry");
    expect(restored.warnings.join("\n")).toContain(other);
    // The recorded entry surviving the drop is the cross-check, not the output text.
    expect(restored.warnings.join("\n")).toContain("still in `git stash list`");
  });

  it("warns, without dropping anything, when the stash list is unreadable after the apply", async () => {
    const calls: string[][] = [];
    const git: FleetMergeGitRunner = async (argv, runnerOptions) => {
      calls.push([...argv]);
      // Only the post-apply re-list matters here (requireListed is off, so this is
      // the drop's own lookup).
      if (argv[0] === "stash" && argv[1] === "list") {
        return { ok: false, error: "EACCES: cannot read reflog", stdout: "", stderr: "" };
      }
      return stashGit({})(argv, runnerOptions);
    };

    const restored = await restoreRecordedStash({
      rootCwd: "/repo",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git,
    });

    expect(restored).toHaveProperty("ok", true);
    if (!restored.ok) return;
    expect(restored.warnings.join("\n")).toContain("could not list the stash to drop it");
    expect(restored.warnings.join("\n")).toContain("still in `git stash list`");
    // An unreadable list is not proof of where the entry sits, so no drop is
    // attempted and nothing claims the stash was dropped.
    expect(calls.some((argv) => argv[0] === "stash" && argv[1] === "drop")).toBe(false);
    expect(restored.dropMismatch).toBe(undefined);
  });

  it("warns, without dropping anything, when the resolved position is not the recorded sha", async () => {
    const calls: string[][] = [];
    const git: FleetMergeGitRunner = async (argv, runnerOptions) => {
      calls.push([...argv]);
      // Another writer pushed a stash between the list and the resolve, so the
      // position the drop would use now names a different entry.
      if (argv[0] === "rev-parse" && argv[3] === "stash@{0}") {
        return { ok: true, stdout: `${other}\n`, stderr: "" };
      }
      return stashGit({})(argv, runnerOptions);
    };

    const restored = await restoreRecordedStash({
      rootCwd: "/repo",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git,
    });

    expect(restored).toHaveProperty("ok", true);
    if (!restored.ok) return;
    expect(restored.warnings.join("\n")).toContain("no longer at stash@{0}");
    expect(restored.warnings.join("\n")).toContain("not dropping a stash entry");
    expect(calls.some((argv) => argv[0] === "stash" && argv[1] === "drop")).toBe(false);
    expect(restored.dropMismatch).toBe(undefined);
  });

  it("warns that the applied entry survives when the drop itself fails", async () => {
    const calls: string[][] = [];
    const git: FleetMergeGitRunner = async (argv, runnerOptions) => {
      calls.push([...argv]);
      if (argv[0] === "stash" && argv[1] === "drop") {
        return { ok: false, error: "fatal: not a stash reference", stdout: "", stderr: "" };
      }
      return stashGit({})(argv, runnerOptions);
    };

    const restored = await restoreRecordedStash({
      rootCwd: "/repo",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git,
    });

    expect(restored).toHaveProperty("ok", true);
    if (!restored.ok) return;
    expect(restored.warnings.join("\n")).toContain("could not drop it");
    expect(restored.warnings.join("\n")).toContain("remove it by hand");
    expect(calls.filter((argv) => argv[0] === "stash" && argv[1] === "drop")).toHaveLength(1);
    // A failed drop is not a mismatch: the entry is still there, unclaimed by any
    // "dropped" report, so no cross-check warning is raised.
    expect(restored.dropMismatch).toBe(undefined);
  });

  it("refuses to restore when the root's git directory cannot be resolved", async () => {
    const git: FleetMergeGitRunner = async (argv, runnerOptions) => {
      if (argv[0] === "rev-parse" && argv[1] === "--absolute-git-dir") {
        return { ok: false, error: "fatal: not a git repository", stdout: "", stderr: "" };
      }
      return stashGit({})(argv, runnerOptions);
    };

    const verdict = await checkRootCheckout({
      rootCwd: "/repo",
      baseBranch: "main",
      gitCommonDir: commonDir,
      git,
    });

    expect(verdict).toHaveProperty("ok", false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("root-not-own-checkout");
    expect(verdict.text).toContain("could not resolve the git directory of /repo");
  });

  it("refuses to restore when only the common dir is unreadable", async () => {
    const git: FleetMergeGitRunner = async (argv, runnerOptions) => {
      if (argv[0] === "rev-parse" && argv[1] === "--path-format=absolute") {
        return { ok: false, error: "fatal: bad config", stdout: "", stderr: "" };
      }
      return stashGit({})(argv, runnerOptions);
    };

    const verdict = await checkRootCheckout({
      rootCwd: "/repo",
      baseBranch: "main",
      gitCommonDir: commonDir,
      git,
    });

    expect(verdict).toHaveProperty("ok", false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("root-not-own-checkout");
    expect(verdict.text).toContain("could not resolve the git directory of /repo");
  });

  it("refuses to apply onto another branch and names the recorded ref", async () => {
    const restored = await restoreRecordedStash({
      rootCwd: "/repo",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git: stashGit({ onBase: false }),
    });
    expect(restored).toHaveProperty("ok", false);
    if (restored.ok) return;
    expect(restored.reason).toBe("root-not-on-base");
    expect(restored.text).toContain(recorded);
  });

  it("refuses to restore into a linked worktree, naming the root (W4)", async () => {
    const restored = await restoreRecordedStash({
      rootCwd: "/repo.feet",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git: stashGit({ ownedCheckout: false }),
    });
    expect(restored).toHaveProperty("ok", false);
    if (restored.ok) return;
    expect(restored.reason).toBe("root-not-own-checkout");
    expect(restored.text).toContain("linked worktree");
    expect(restored.text).toContain(recorded);
  });

  it("never re-applies a recorded sha that is gone from the stash list (W3)", async () => {
    const applyCalls: string[][] = [];
    const git: FleetMergeGitRunner = async (argv, options) => {
      applyCalls.push([...argv]);
      return stashGit({ listedAfterDrop: [] })(argv, options);
    };
    const restored = await restoreRecordedStash({
      rootCwd: "/repo",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git,
      requireListed: true,
    });
    expect(restored).toHaveProperty("ok", false);
    if (restored.ok) return;
    expect(restored.reason).toBe("already-restored");
    expect(restored.text).toContain("already restored or dropped");
    expect(applyCalls.some((argv) => argv[0] === "stash" && argv[1] === "apply")).toBe(false);
    expect(applyCalls.some((argv) => argv[0] === "reset")).toBe(false);
  });

  it("refuses when the recorded sha no longer resolves, without applying or resetting", async () => {
    const calls: string[][] = [];
    // The recorded commit is unreadable: the operator's work is not in this
    // repository any more, and guessing (or popping position 0) would destroy
    // whatever is there instead.
    const git: FleetMergeGitRunner = async (argv, options) => {
      calls.push([...argv]);
      if (argv[0] === "rev-parse" && argv[1] === "--verify") {
        return { ok: true, stdout: "", stderr: "" };
      }
      return stashGit({ listedAfterDrop: [] })(argv, options);
    };

    const restored = await restoreRecordedStash({
      rootCwd: "/repo",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git,
    });

    expect(restored).toHaveProperty("ok", false);
    if (restored.ok) return;
    expect(restored.reason).toBe("unresolvable");
    expect(restored.text).toContain(recorded);
    expect(restored.text).toContain("git stash list");
    expect(calls.some((argv) => argv[0] === "stash" && argv[1] === "apply")).toBe(false);
    expect(calls.some((argv) => argv[0] === "reset")).toBe(false);
  });

  it("refuses under requireListed when the stash list cannot be read", async () => {
    const calls: string[][] = [];
    // An unreadable `git stash list` cannot prove the recorded sha is still
    // pending, so applying it would be a guess in the direction of destroying
    // work: the restore refuses instead.
    const git: FleetMergeGitRunner = async (argv, options) => {
      calls.push([...argv]);
      if (argv[0] === "stash" && argv[1] === "list") {
        return { ok: false, error: "EACCES: cannot read reflog", stdout: "", stderr: "" };
      }
      return stashGit({ listedAfterDrop: [] })(argv, options);
    };

    const restored = await restoreRecordedStash({
      rootCwd: "/repo",
      baseBranch: "main",
      fleetId: "default",
      gitCommonDir: commonDir,
      stashRef: recorded,
      git,
      requireListed: true,
    });

    expect(restored).toHaveProperty("ok", false);
    if (restored.ok) return;
    expect(restored.reason).toBe("unresolvable");
    expect(restored.text).toContain("cannot be proven still pending");
    expect(calls.some((argv) => argv[0] === "stash" && argv[1] === "apply")).toBe(false);
    expect(calls.some((argv) => argv[0] === "reset")).toBe(false);
  });
});

describe("merge gates come from the repository", () => {
  it("orders the project's own scripts and skips the ones it does not define", () => {
    const commands = resolveFleetGateCommands({
      typecheck: "tsc",
      test: "vitest",
      lint: "biome",
      dev: "vite",
    });
    expect(commands.map((command) => command.name)).toEqual(["test", "typecheck", "lint"]);
    expect(commands[0]).toHaveProperty("script", "vitest");
  });

  it("reads package.json scripts from the merge target", () => {
    const root = tempDir("merge-gates");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }),
    );
    const gates = readFleetGateCommands({ rootCwd: root });
    expect(gates).toHaveProperty("ok", true);
    if (!gates.ok) return;
    expect(gates.commands.map((command) => command.name)).toEqual(["test", "build"]);
  });

  it("refuses a target with no gate scripts", () => {
    const root = tempDir("merge-gates");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const gates = readFleetGateCommands({ rootCwd: root });
    expect(gates).toHaveProperty("ok", false);
    if (gates.ok) return;
    expect(gates.reason).toBe("no-gates");
  });
});

// ── Fixture repositories ──────────────────────────────────────────────

interface FixtureRepo {
  root: string;
  commonDir: string;
  fleetId: string;
  memberPath: string;
  siblingPath: string;
}

/**
 * Fixture git always runs with inherited git-context variables stripped: under
 * `wt merge` / a git hook, `GIT_DIR` is exported, and an inherited value makes
 * `git init` on a temp fixture reinitialize the real checkout instead (bare
 * rewrite, refs moved, worktrees registered). See `gitContextFreeEnv`.
 */
function git(cwd: string, argv: readonly string[]): string {
  return execFileSync("git", [...argv], {
    cwd,
    env: gitContextFreeEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * Fingerprint everything a stray P2/P4 path could move in a checkout.
 *
 * Every ref (not just `main`), `refs/stash`, the stash list, `git status`, HEAD
 * and the current branch: a wrong-root merge, a leftover auto-stash, or a dirty
 * working tree each change at least one of them. Extracted so the no-mutation
 * guard and the sensitivity test below exercise the same fingerprint.
 */
function harnessSnapshot(root: string): Record<string, string> {
  const refOrNone = (ref: string): string => {
    try {
      return git(root, ["rev-parse", "--verify", ref]);
    } catch {
      return "<absent>";
    }
  };
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    main: git(root, ["rev-parse", "refs/heads/main"]),
    status: git(root, ["status", "--porcelain"]),
    refs: git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    stash: refOrNone("refs/stash"),
    stashList: git(root, ["stash", "list"]),
  };
}

/**
 * A throwaway repository shaped like a fleet: `main` in the root, a member
 * branch with one commit in a linked worktree, and a second member worktree.
 * Every path is under the OS temp dir — never this repository.
 */
function createFixtureRepo(options: { secondMember?: boolean } = {}): FixtureRepo {
  const root = tempDir("fleet-merge-repo");
  git(root, ["init", "-q"]);
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["config", "user.email", "fleet-test@example.invalid"]);
  git(root, ["config", "user.name", "Fleet Test"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { test: "vitest", typecheck: "tsc", lint: "biome" },
    }),
  );
  writeFileSync(join(root, "base.txt"), "base\n");
  commit(root, "base");

  // The linked worktrees live next to the root, so `cleanup` has to hold each
  // path explicitly: registering only the root leaves two directories behind on
  // every run, and under an inherited GIT_DIR those stale registrations used to
  // point at the real checkout.
  const memberPath = `${root}.feat-bd-12`;
  cleanup.push(memberPath);
  git(root, ["worktree", "add", "-q", "-b", "feat/bd-12", memberPath]);
  writeFileSync(join(memberPath, "member.txt"), "member work\n");
  commit(memberPath, "member bd-12");

  const siblingPath = `${root}.feat-bd-15`;
  if (options.secondMember !== false) {
    cleanup.push(siblingPath);
    git(root, ["worktree", "add", "-q", "-b", "feat/bd-15", siblingPath]);
  }

  const commonDir = join(root, ".git");
  const fleetId = "default";
  writeFleetIntent(commonDir, fleetId, ["bd-12", "bd-15"]);
  return { root, commonDir, fleetId, memberPath, siblingPath };
}

function writeFleetIntent(commonDir: string, fleetId: string, taskIds: string[]): void {
  const dir = join(commonDir, "belayd", "fleet", fleetId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fleet.json"),
    JSON.stringify({
      schemaVersion: 1,
      fleetId,
      taskIds,
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
    }),
  );
}

function auditActions(fixture: FixtureRepo): string[] {
  const path = fleetAuditLogPath(fixture.commonDir, fixture.fleetId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { action: string }).action);
}

function readQueue(fixture: FixtureRepo): FleetMergeQueue {
  const loaded = readFleetMergeQueue({
    gitCommonDir: fixture.commonDir,
    fleetId: fixture.fleetId,
  });
  if (!loaded.ok || loaded.queue === undefined) throw new Error("queue unreadable");
  return loaded.queue;
}

function enqueue(fixture: FixtureRepo, taskId = "bd-12"): void {
  const queued = enqueueFleetMerge({
    gitCommonDir: fixture.commonDir,
    fleetId: fixture.fleetId,
    sessionId: "supervisor-session",
    taskId,
    branch: `feat/${taskId}`,
    now: 1000,
  });
  if (!queued.ok) throw new Error(queued.error);
}

/** Gate runner stub: records the calls, passes unless told to fail. */
function gateSpy(options: { failAt?: string } = {}): {
  runGate: FleetMergeGateRunner;
  calls: Array<{ name: string; cwd: string }>;
} {
  const calls: Array<{ name: string; cwd: string }> = [];
  return {
    calls,
    runGate: async (input) => {
      calls.push({ name: input.name, cwd: input.cwd });
      if (options.failAt === input.name) return { ok: false, error: "gate exploded" };
      return { ok: true };
    },
  };
}

async function drain(
  fixture: FixtureRepo,
  options: { runGate?: FleetMergeGateRunner; git?: FleetMergeGitRunner } = {},
) {
  return drainFleetMerge({
    gitCommonDir: fixture.commonDir,
    fleetId: fixture.fleetId,
    sessionId: "supervisor-session",
    pid: 4242,
    rootCwd: fixture.root,
    now: 2000,
    ...(options.runGate === undefined ? {} : { runGate: options.runGate }),
    ...(options.git === undefined ? {} : { git: options.git }),
  });
}

// ── Merge sequence ────────────────────────────────────────────────────

describe("drainFleetMerge: the documented merge sequence", () => {
  it("rebases, gates, fast-forwards the root, broadcasts, and releases the lock", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const gate = gateSpy();
    const commands: string[][] = [];
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      commands.push([...argv]);
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gate.runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.taskId).toBe("bd-12");
    expect(result.mergeCommit).toBe(git(fixture.root, ["rev-parse", "HEAD"]));
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(
      git(fixture.memberPath, ["rev-parse", "feat/bd-12"]),
    );

    // Gates ran against the rebased member worktree, in the project's order.
    expect(gate.calls.map((call) => call.name)).toEqual(["test", "typecheck", "lint"]);
    expect(gate.calls.every((call) => call.cwd === fixture.memberPath)).toBe(true);

    // Queue + lock are coherent after the merge.
    const queue = readQueue(fixture);
    expect(queue.lock).toBe(null);
    expect(queue.entries.find((entry) => entry.taskId === "bd-12")).toMatchObject({
      state: "merged",
      attempts: 1,
    });
    expect(existsSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId))).toBe(false);

    // Base-moved propagation went through the per-recipient fan-out.
    const events = drainNotes({ dir: fleetEventsDir(fixture.commonDir, fixture.fleetId) });
    if (!events.ok) throw new Error(events.error);
    const kinds = events.deliveries.map((delivery) => delivery.note.kind).sort();
    expect(kinds).toEqual(["base-moved", "rebase-hint", "sibling-landed"]);
    expect(events.deliveries.every((delivery) => delivery.note.to === "bd-15")).toBe(true);

    const actions = auditActions(fixture);
    for (const action of [
      "merge-enqueued",
      "merge-acquired",
      "merge-completed",
      "merge-released",
      "base-moved",
      "sibling-landed",
      "rebase-hint",
    ]) {
      expect(actions).toContain(action);
    }

    // Merging is not closing: no bd command was run by any seam.
    expect(commands.every((argv) => argv[0] !== "bd")).toBe(true);
    expect(commands.some((argv) => argv.includes("bd-12") && argv[0] === "bd")).toBe(false);

    // The report states the bead is not closed.
    expect(result.text).toContain("merging is not closing");
  });

  it("does not mutate this repository: a full merge run changes only the fixture", async () => {
    // Snapshot the checkout the tests run from. A P2 path that fell back to
    // process.cwd() for git, or merged into the wrong root, would move one of
    // these. Every ref (not just `main`) and `refs/stash` are included (S2): a
    // stray stash or side ref in the harness checkout would otherwise pass
    // vacuously.
    const harnessRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    const before = harnessSnapshot(harnessRoot);

    const fixture = createFixtureRepo();
    enqueue(fixture);
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);
    const rootHeadBefore = git(fixture.root, ["rev-parse", "HEAD"]);
    const result = await drain(fixture, { runGate: gateSpy().runGate });
    expect(result).toHaveProperty("ok", true);

    // A real merge happened in the fixture, so the comparison below cannot pass
    // by observing a no-op: the fast-forward moved the base onto the member tip
    // and the member's file is now part of the base tree.
    expect(git(fixture.root, ["rev-parse", "HEAD"])).not.toBe(rootHeadBefore);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);
    expect(git(fixture.root, ["cat-file", "-t", "HEAD:member.txt"])).toBe("blob");

    // The merge target was the fixture, never the harness checkout.
    expect(result.ok ? result.mergeCommit : "").toBe(git(fixture.root, ["rev-parse", "HEAD"]));

    expect(harnessSnapshot(harnessRoot)).toEqual(before);
  });

  it("the harness snapshot it compares is sensitive to refs, stashes, and dirt", () => {
    // The guard above only means something if the fingerprint changes when a
    // checkout is mutated. Proved here on a throwaway repository, with exactly
    // the three mutations a stray P2 path would leave behind.
    const repo = tempDir("snapshot-sensitivity");
    git(repo, ["init", "-q"]);
    git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(repo, ["config", "user.email", "fleet-test@example.invalid"]);
    git(repo, ["config", "user.name", "Fleet Test"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    commit(repo, "base");

    const initial = harnessSnapshot(repo);
    expect(harnessSnapshot(repo)).toEqual(initial);

    // 1. A ref moves: the fast-forward a wrong-root merge would perform.
    git(repo, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(repo, "side.txt"), "side\n");
    commit(repo, "side");
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "--ff-only", "-q", "side"]);
    const moved = harnessSnapshot(repo);
    expect(moved.head).not.toBe(initial.head);
    expect(moved.refs).not.toBe(initial.refs);

    // 2. A stash appears: the root auto-stash, left behind.
    writeFileSync(join(repo, "base.txt"), "operator work\n");
    git(repo, ["stash", "push", "-m", "stray stash"]);
    const stashed = harnessSnapshot(repo);
    expect(stashed.stash).not.toBe(initial.stash);
    expect(stashed.stashList).not.toBe(moved.stashList);
    expect(stashed.refs).not.toBe(moved.refs);

    // 3. The working tree is dirty: `git status` no longer matches.
    writeFileSync(join(repo, "base.txt"), "unstaged change\n");
    const dirty = harnessSnapshot(repo);
    expect(dirty.status).not.toBe(stashed.status);
    expect(dirty.status).toContain("base.txt");
  });

  it("aborts before mutation when the member worktree is dirty", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const rootHead = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFileSync(join(fixture.memberPath, "member.txt"), "uncommitted\n");

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("member-worktree-dirty");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(readQueue(fixture).entries[0]?.state).toBe("queued");
    expect(auditActions(fixture)).not.toContain("merge-acquired");
  });

  it("refuses when the root is not on the base branch", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    git(fixture.root, ["checkout", "-q", "-b", "not-main"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("root-not-on-base");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("refuses a linked worktree as the merge target", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const escaped = `${fixture.root}.not-the-root`;
    cleanup.push(escaped);
    git(fixture.root, ["worktree", "add", "-q", "-b", "not-main", escaped]);

    const result = await drainFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      pid: 4242,
      rootCwd: escaped,
      now: 2000,
      runGate: gateSpy().runGate,
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("root-not-own-checkout");
    expect(readQueue(fixture).entries[0]?.state).toBe("queued");
  });

  it("fails closed on a failing gate: root unchanged, member unmerged, lock released", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const rootHead = git(fixture.root, ["rev-parse", "HEAD"]);
    const gate = gateSpy({ failAt: "typecheck" });

    const result = await drain(fixture, { runGate: gate.runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("gate-failed");
    expect(result.text).toContain("typecheck");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(git(fixture.root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(readQueue(fixture).lock).toBe(null);
    expect(existsSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId))).toBe(false);
    expect(readQueue(fixture).entries[0]).toMatchObject({ state: "failed" });
    // The member's commits still exist; only the merge was aborted.
    expect(git(fixture.memberPath, ["rev-parse", "--verify", "feat/bd-12"]).length).toBeGreaterThan(
      0,
    );
    const actions = auditActions(fixture);
    expect(actions).toContain("merge-gate-failed");
    expect(actions).toContain("merge-released");
    expect(actions).not.toContain("merge-completed");
  });

  it("auto-stashes a dirty root and restores it immediately", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    writeFileSync(join(fixture.root, "base.txt"), "operator work in progress\n");

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.stashRef).toBeDefined();
    // The operator's uncommitted edit is back, not stranded in a stash.
    expect(readFileSync(join(fixture.root, "base.txt"), "utf8")).toBe(
      "operator work in progress\n",
    );
    expect(git(fixture.root, ["stash", "list"])).toBe("");
    const actions = auditActions(fixture);
    expect(actions).toContain("merge-stash");
    expect(actions).toContain("merge-restore");
  });

  it("audits a drop mismatch and never claims the recorded stash was dropped", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    writeFileSync(join(fixture.root, "base.txt"), "operator work in progress\n");
    const foreign = "b".repeat(40);

    // The drop really runs, but git reports a different commit. Verify-then-drop is
    // two operations, so the output is the only evidence of what was removed; it
    // must be cross-checked, audited, and never reported as the recorded entry.
    const git: FleetMergeGitRunner = async (argv, options) => {
      const result = await defaultFleetMergeGitRunner(argv, options);
      if (argv[0] === "stash" && argv[1] === "drop" && result.ok) {
        return { ...result, stdout: `Dropped ${argv[2] ?? "stash@{0}"} (${foreign})\n` };
      }
      return result;
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    const warnings = result.warnings.join("\n");
    expect(warnings).toContain("was restored but the drop removed a different stash entry");
    expect(warnings).toContain(foreign);
    // The recorded entry did leave the list (the drop ran), so the warning must not
    // claim it is still there, and no warning may call the recorded entry dropped.
    expect(warnings).not.toContain("which is still in `git stash list`");
    expect(auditActions(fixture)).toContain("merge-stash-drop-mismatch");
  });

  it("parks the fleet and keeps the stash when restoring the root conflicts", async () => {
    const fixture = createFixtureRepo();
    // The member and the operator both change base.txt, so the post-merge pop
    // cannot apply cleanly.
    writeFileSync(join(fixture.memberPath, "base.txt"), "member changed this\n");
    commit(fixture.memberPath, "member edits base");
    enqueue(fixture);
    writeFileSync(join(fixture.root, "base.txt"), "operator changed this\n");

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("restore-conflict");
    expect(result.parked).toBe(true);
    expect(result.stashRef).toBeDefined();

    // The merge landed, the root is clean, and the operator's work is still in
    // the stash (not discarded, not silently dropped).
    expect(git(fixture.root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(git(fixture.root, ["status", "--porcelain"])).toBe("");
    expect(git(fixture.root, ["stash", "list"]).length).toBeGreaterThan(0);

    const intent = readFleetIntent({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
    });
    if (!intent.ok) throw new Error(intent.error);
    expect(intent.intent?.paused).toBe(true);
    expect(intent.intent?.note).toContain("stash");
    // The structured park record is what reconcile restores from (P4): the exact
    // sha, not a position and not prose the operator has to parse.
    expect(intent.intent?.park?.stashRef).toBe(result.stashRef);
    expect(intent.intent?.park?.reason).toContain("stash");
    expect(result.text).toContain("stash");

    const actions = auditActions(fixture);
    expect(actions).toContain("merge-completed");
    expect(actions).toContain("merge-restore-conflict");
    expect(actions).toContain("fleet-parked");
  });

  it("aborts a conflicting rebase, leaving the member branch and root untouched", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.memberPath, "conflict.txt"), "member version\n");
    commit(fixture.memberPath, "member conflict commit");
    const memberHead = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);
    writeFileSync(join(fixture.root, "conflict.txt"), "main version\n");
    const rootHead = commit(fixture.root, "main conflict commit");
    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("rebase-failed");
    expect(git(fixture.memberPath, ["rev-parse", "feat/bd-12"])).toBe(memberHead);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(git(fixture.root, ["status", "--porcelain"])).toBe("");
    expect(readQueue(fixture).entries[0]?.state).toBe("failed");
    expect(auditActions(fixture)).toContain("merge-rebase-failed");
  });

  it("refuses to drain a paused fleet", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const rootHead = git(fixture.root, ["rev-parse", "HEAD"]);
    updateFleetIntent({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      update: (current) => {
        if (current === undefined) throw new Error("fleet intent missing in fixture");
        return { ...current, paused: true, note: "operator pause" };
      },
    });

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("fleet-paused");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
  });

  it("reports an empty queue without treating it as a failure", async () => {
    const fixture = createFixtureRepo();
    const result = await drain(fixture, { runGate: gateSpy().runGate });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("no-queued-entry");
  });
});

// ── Enqueue validation and rendering ──────────────────────────────────

describe("enqueueFleetMerge", () => {
  it("refuses a task that is not a fleet member", () => {
    const fixture = createFixtureRepo();
    const result = enqueueFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      taskId: "bd-99",
      branch: "feat/bd-99",
      now: 1000,
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("not-member");
    const queue = readFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
    });
    if (!queue.ok) throw new Error(queue.error);
    expect(queue.queue?.entries ?? []).toEqual([]);
  });

  it("is idempotent for an active entry and refuses to re-merge a merged one", () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    enqueue(fixture);
    expect(readQueue(fixture).entries).toHaveLength(1);

    updateFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      update: (queue) => {
        const base = queue ?? createFleetMergeQueue(1000);
        return {
          ...base,
          entries: base.entries.map((entry) => ({ ...entry, state: "merged" as const })),
        };
      },
    });
    const again = enqueueFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      taskId: "bd-12",
      branch: "feat/bd-12",
      now: 3000,
    });
    expect(again).toHaveProperty("ok", false);
    if (again.ok) return;
    expect(again.reason).toBe("already-merged");
  });

  it("renders the queue and its lock", () => {
    const queue: FleetMergeQueue = {
      ...createFleetMergeQueue(1000),
      lock: createFleetMergeLock({
        holder: "s",
        taskId: "bd-15",
        pid: 1,
        now: 1000,
        leaseInMs: 1000,
      }),
      entries: [
        { taskId: "bd-12", branch: "feat/bd-12", requestedAt: 1, state: "queued", attempts: 0 },
      ],
    };
    const text = formatFleetMergeQueue({ fleetId: "default", queue, now: 2500 });
    expect(text).toContain("bd-12 (feat/bd-12): queued");
    expect(text).toContain("expired");
  });
});

// ── Review hardening (bd-126 increment 4) ─────────────────────────────

describe("drainFleetMerge: root and stash safety", () => {
  it("re-checks the root branch before the fast-forward (CR-1)", async () => {
    // The gates run for minutes; the operator can switch branches in their own
    // checkout during that window. `merge --ff-only` would then move that branch.
    const fixture = createFixtureRepo();
    const rootHead = git(fixture.root, ["rev-parse", "HEAD"]);
    enqueue(fixture);
    writeFileSync(join(fixture.root, "base.txt"), "operator work\n");

    let gates = 0;
    const runGate: FleetMergeGateRunner = async () => {
      gates += 1;
      if (gates === 2) git(fixture.root, ["checkout", "-q", "-b", "not-main"]);
      return { ok: true };
    };
    const result = await drain(fixture, { runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("root-not-on-base");
    expect(result.text).toContain("not-main");
    // No branch moved: the fast-forward never ran.
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(rootHead);
    expect(git(fixture.root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("not-main");
    expect(readQueue(fixture).entries[0]?.state).toBe("failed");
    // The operator's work is not applied to the wrong branch: it stays stashed
    // and the fleet is parked so the operator is told where it is.
    expect(git(fixture.root, ["stash", "list"])).toContain("belayd fleet");
    expect(result.parked).toBe(true);
    expect(result.stashRef).toBeDefined();
    expect(auditActions(fixture)).toContain("merge-restore-conflict");
  });

  it("restores the recorded stash by sha, never stash@{0} (CR-2)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    writeFileSync(join(fixture.root, "base.txt"), "operator work\n");

    let gates = 0;
    const runGate: FleetMergeGateRunner = async () => {
      gates += 1;
      if (gates === 1) {
        // The operator stashes unrelated work into the root mid-merge. It lands
        // at stash@{0}, pushing the drain's stash to stash@{1}.
        writeFileSync(join(fixture.root, "interloper.txt"), "unrelated work\n");
        git(fixture.root, ["stash", "push", "-u", "-m", "operator interloper"]);
      }
      return { ok: true };
    };

    const result = await drain(fixture, { runGate });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.stashRef).toBeDefined();
    const recorded = result.stashRef ?? "";

    // The drain's stash was applied and dropped; the interloper survives.
    const stashList = git(fixture.root, ["stash", "list", "--format=%H %gs"]);
    expect(stashList).toContain("operator interloper");
    expect(stashList).not.toContain(recorded);
    expect(readFileSync(join(fixture.root, "base.txt"), "utf8")).toBe("operator work\n");
    expect(existsSync(join(fixture.root, "interloper.txt"))).toBe(false);
    // The report names the ref that was actually restored.
    expect(result.text).toContain(`root work was stashed and restored (${recorded})`);
  });

  it("fails the stash step when the stash ref cannot be verified (S3)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    writeFileSync(join(fixture.root, "base.txt"), "operator work\n");

    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "rev-parse" && argv.includes("refs/stash")) {
        return { ok: true, stdout: "", stderr: "" };
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("stash-failed");
    expect(result.text).toContain("could not be verified");
    expect(result.stashRef).toBeUndefined();
    // The work is still in the stash, not silently lost.
    expect(git(fixture.root, ["stash", "list"])).toContain("belayd fleet");
  });

  it("warns when the post-conflict reset fails (W5)", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.memberPath, "base.txt"), "member changed this\n");
    commit(fixture.memberPath, "member edits base");
    enqueue(fixture);
    writeFileSync(join(fixture.root, "base.txt"), "operator changed this\n");

    const gitRunner: FleetMergeGitRunner = async (argv, options) =>
      argv[0] === "reset" && argv[1] === "--hard"
        ? { ok: false, error: "reset exploded", stdout: "", stderr: "" }
        : defaultFleetMergeGitRunner(argv, options);

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("restore-conflict");
    expect(result.warnings.join("\n")).toContain("could not reset");
    expect(result.warnings.join("\n")).toContain("conflict markers");
  });

  it("warns when the rebase abort fails (W6)", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.memberPath, "conflict.txt"), "member version\n");
    commit(fixture.memberPath, "member conflict commit");
    writeFileSync(join(fixture.root, "conflict.txt"), "main version\n");
    commit(fixture.root, "main conflict commit");
    enqueue(fixture);

    const gitRunner: FleetMergeGitRunner = async (argv, options) =>
      argv[0] === "rebase" && argv[1] === "--abort"
        ? { ok: false, error: "abort exploded", stdout: "", stderr: "" }
        : defaultFleetMergeGitRunner(argv, options);

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("rebase-failed");
    expect(result.warnings.join("\n")).toContain("could not abort the rebase");
    expect(result.warnings.join("\n")).toContain("abort exploded");
  });

  it("refuses to park a fleet whose intent record is gone (S4)", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.memberPath, "base.txt"), "member changed this\n");
    commit(fixture.memberPath, "member edits base");
    enqueue(fixture);
    writeFileSync(join(fixture.root, "base.txt"), "operator changed this\n");

    const fleetFile = join(fixture.commonDir, "belayd", "fleet", fixture.fleetId, "fleet.json");
    const runGate: FleetMergeGateRunner = async () => {
      rmSync(fleetFile, { force: true });
      return { ok: true };
    };

    const result = await drain(fixture, { runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("restore-conflict");
    // The rest of the drain still holds: the merge landed, the root is clean.
    expect(git(fixture.root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    // But no stale in-memory member list was resurrected into a new fleet.json.
    expect(result.parked).toBe(false);
    expect(existsSync(fleetFile)).toBe(false);
    expect(result.warnings.join("\n")).toContain("refusing to park");
  });
});

describe("drainFleetMerge: clock, lease, environment, branches", () => {
  it("stamps each step with the live clock (W1)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    let tick = 2_000;
    const clock = () => {
      tick += 60_000;
      return tick;
    };

    const result = await drainFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      pid: 4242,
      rootCwd: fixture.root,
      now: 2_000,
      clock,
      runGate: gateSpy().runGate,
    });
    expect(result).toHaveProperty("ok", true);

    const entries = readFileSync(fleetAuditLogPath(fixture.commonDir, fixture.fleetId), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { action: string; timestamp: number });
    const acquired = entries.find((entry) => entry.action === "merge-acquired")?.timestamp ?? 0;
    const completed = entries.find((entry) => entry.action === "merge-completed")?.timestamp ?? 0;
    expect(acquired).toBeGreaterThan(2_000);
    expect(completed).toBeGreaterThan(acquired);
  });

  it("renews the lease between gates so a live holder is never deposed (W2)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    let tick = 2_000;
    const clock = () => {
      tick += 5 * 60_000;
      return tick;
    };
    const expiries: number[] = [];
    const gate = gateSpy();
    const runGate: FleetMergeGateRunner = async (input) => {
      const lock = readQueue(fixture).lock;
      expiries.push(lock?.leaseExpiresAt ?? 0);
      return gate.runGate(input);
    };

    const result = await drainFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      pid: 4242,
      rootCwd: fixture.root,
      now: 2_000,
      clock,
      runGate,
    });

    expect(result).toHaveProperty("ok", true);
    expect(expiries).toHaveLength(3);
    for (let index = 1; index < expiries.length; index += 1) {
      expect(expiries[index]).toBeGreaterThan(expiries[index - 1] ?? 0);
    }
  });

  it("runs git with a context-free environment, ignoring an inherited GIT_DIR (W4)", async () => {
    const fixture = createFixtureRepo();
    const decoy = createFixtureRepo();
    const decoyHead = git(decoy.root, ["rev-parse", "HEAD"]);
    enqueue(fixture);

    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoy.root, ".git");
    let result: Awaited<ReturnType<typeof drain>>;
    try {
      result = await drain(fixture, { runGate: gateSpy().runGate });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }

    expect(result).toHaveProperty("ok", true);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(
      git(fixture.memberPath, ["rev-parse", "feat/bd-12"]),
    );
    // The decoy repository the poisoned env pointed at was never touched.
    expect(git(decoy.root, ["rev-parse", "HEAD"])).toBe(decoyHead);
  });

  it("resolves a member's real branch before sending a rebase-hint (W3)", async () => {
    const root = tempDir("fleet-merge-branch");
    git(root, ["init", "-q"]);
    git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(root, ["config", "user.email", "fleet-test@example.invalid"]);
    git(root, ["config", "user.name", "Fleet Test"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    writeFileSync(join(root, "base.txt"), "base\n");
    commit(root, "base");

    const memberPath = `${root}.feat-bd-12`;
    cleanup.push(memberPath);
    git(root, ["worktree", "add", "-q", "-b", "feat/bd-12", memberPath]);
    writeFileSync(join(memberPath, "member.txt"), "member work\n");
    commit(memberPath, "member bd-12");

    // The sibling is on a branch that does not follow `feat/<id>` at all.
    const siblingPath = `${root}.work-bd-15`;
    cleanup.push(siblingPath);
    git(root, ["worktree", "add", "-q", "-b", "work/bd-15", siblingPath, "feat/bd-12"]);
    mkdirSync(join(siblingPath, ".belayd"), { recursive: true });
    writeFileSync(
      join(siblingPath, ".belayd", "workflow.json"),
      JSON.stringify({ taskId: "bd-15" }),
    );

    const commonDir = join(root, ".git");
    writeFleetIntent(commonDir, "default", ["bd-12", "bd-15"]);
    const fixture: FixtureRepo = {
      root,
      commonDir,
      fleetId: "default",
      memberPath,
      siblingPath,
    };
    enqueue(fixture);
    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", true);
    const events = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
    if (!events.ok) throw new Error(events.error);
    const kinds = events.deliveries.map((delivery) => delivery.note.kind).sort();
    // `work/bd-15` already contains the new base, so no rebase-hint is due; the
    // old hardcoded `feat/bd-15` would have produced a spurious one.
    expect(kinds).toEqual(["base-moved", "sibling-landed"]);
  });
});

describe("merge gate runner detection (S1)", () => {
  it("honors packageManager, then the lockfile, then falls back to npm", () => {
    expect(resolveFleetGateRunner({ packageManager: "pnpm@9.12.0", lockfiles: [] })).toBe("pnpm");
    expect(resolveFleetGateRunner({ packageManager: "yarn@4.1.0", lockfiles: [] })).toBe("yarn");
    expect(resolveFleetGateRunner({ packageManager: "npm@10.0.0", lockfiles: [] })).toBe("npm");
    expect(resolveFleetGateRunner({ packageManager: undefined, lockfiles: ["yarn.lock"] })).toBe(
      "yarn",
    );
    expect(
      resolveFleetGateRunner({ packageManager: undefined, lockfiles: ["pnpm-lock.yaml"] }),
    ).toBe("pnpm");
    expect(
      resolveFleetGateRunner({ packageManager: undefined, lockfiles: ["package-lock.json"] }),
    ).toBe("npm");
    expect(resolveFleetGateRunner({ packageManager: undefined, lockfiles: [] })).toBe("npm");
    expect(resolveFleetGateRunner({ packageManager: "bun@1", lockfiles: [] })).toBe("npm");
  });

  it("reports the runner the merge target actually uses", () => {
    const root = tempDir("merge-gate-runner");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" }, packageManager: "yarn@4.1.0" }),
    );
    const gates = readFleetGateCommands({ rootCwd: root });
    expect(gates).toHaveProperty("ok", true);
    if (!gates.ok) return;
    expect(gates).toHaveProperty("runner", "yarn");
  });
});
