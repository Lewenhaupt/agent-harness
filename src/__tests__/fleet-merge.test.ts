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
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FleetMergeGateRunner,
  FleetMergeGitRunner,
  FleetMergeRegenerateRunner,
} from "../fleet-merge.js";
import {
  acquireFleetMerge,
  checkRootCheckout,
  defaultFleetMergeGitRunner,
  drainFleetMerge,
  enqueueFleetMerge,
  FLEET_MERGE_ORPHAN_LOCK_GRACE_MS,
  formatDrainResultText,
  formatFleetMergeQueue,
  readFleetGateCommands,
  releaseFleetMerge,
  renewFleetMergeLease,
  resolveFleetGateCommands,
  resolveFleetGateRunner,
  restoreRecordedStash,
} from "../fleet-merge.js";
import type { FleetMemberClaim } from "../fleet-run.js";
import type { FleetMergeQueue, FleetStateFs } from "../fleet-state.js";
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
import { serializeProofReceipt } from "../proof-receipt.js";
// The receipt branch of the proof gate is asserted against the same real
// worktree the drain reads, so "a receipt-published bead passes both gates with
// no proof in the diff" is one end-to-end property rather than two halves.
import { gateProofContent } from "../quality-gates.js";
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

/** The details one audit action recorded, in append order. */
function auditDetails(fixture: FixtureRepo, action: string): string[] {
  const path = fleetAuditLogPath(fixture.commonDir, fixture.fleetId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { action: string; detail?: string })
    .filter((entry) => entry.action === action)
    .map((entry) => entry.detail ?? "");
}

/** The `to` addresses of one delivered note kind, in delivery order. */
function noteRecipients(fixture: FixtureRepo, kind: string): string[] {
  const events = drainNotes({ dir: fleetEventsDir(fixture.commonDir, fixture.fleetId) });
  if (!events.ok) throw new Error(events.error);
  return events.deliveries
    .filter((delivery) => delivery.note.kind === kind)
    .map((delivery) => delivery.note.to);
}

/**
 * An fs seam whose **first** append of one audit action throws.
 *
 * The audit append goes through `appendFileSync`, not `atomicWriteJson`, so
 * `fsRefusingWrite` cannot reach it; this is how a test drives the "the landed audit
 * could not be written" arm and the retry that follows it (bd-280 S6).
 */
function fsFailingFirstAuditAppend(action: string): FleetStateFs {
  const base = fsRefusingWrite(() => false);
  let failed = false;
  return {
    ...base,
    appendFileSync: (path, data) => {
      if (!failed && data.includes(`"action":"${action}"`)) {
        failed = true;
        throw new Error("EIO: audit append failed");
      }
      appendFileSync(path, data);
    },
  };
}

/**
 * An fs seam that refuses the atomic write whose payload matches `refuse`.
 *
 * `atomicWriteJson` writes a temp file then renames it, so the payload is the only
 * place to tell one write from another: a test can fail exactly the queue write
 * that carries `delegatedAt`, or exactly the note write that carries a
 * `rebase-hint`, without breaking the reads and writes the drain needs to get there.
 */
function fsRefusingWrite(
  refuse: (input: { content: string; target: string }) => boolean,
): FleetStateFs {
  return {
    existsSync: (path) => existsSync(path),
    readFileSync: (path) => readFileSync(path, "utf8"),
    statSync: (path) => {
      const stat = statSync(path);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    writeFileSync: (path, data, options) => writeFileSync(path, data, options),
    appendFileSync: (path, data) => appendFileSync(path, data),
    renameSync: (from, to) => {
      if (refuse({ content: readFileSync(from, "utf8"), target: to })) {
        throw new Error("ENOSPC: no space left on device");
      }
      renameSync(from, to);
    },
    mkdirSync: (path, options) => {
      mkdirSync(path, options);
    },
    unlinkSync: (path) => unlinkSync(path),
    readdirSync: (path) => readdirSync(path),
    rmdirSync: (path) => rmdirSync(path),
  };
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
  options: {
    runGate?: FleetMergeGateRunner;
    git?: FleetMergeGitRunner;
    regenerate?: FleetMergeRegenerateRunner;
    memberLease?: FleetMemberClaim;
    fs?: FleetStateFs;
  } = {},
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
    ...(options.regenerate === undefined ? {} : { regenerate: options.regenerate }),
    ...(options.memberLease === undefined ? {} : { memberLease: options.memberLease }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
}

// ── Merge sequence ────────────────────────────────────────────────────

describe("drainFleetMerge: the documented merge sequence", () => {
  it("rebases, gates, fast-forwards the root, broadcasts, and releases the lock", async () => {
    const fixture = createFixtureRepo();
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);
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
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);
    // A successful drain now honours the documented removal (bd-168 #3).
    expect(existsSync(fixture.memberPath)).toBe(false);
    expect(git(fixture.root, ["branch", "--list", "feat/bd-12"])).toBe("");
    expect(result.text).toContain(
      `removed worktree ${fixture.memberPath} and merged branch feat/bd-12`,
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
    // The landed audit is written exactly once per merge (bd-280 S6).
    expect(actions.filter((action) => action === "merge-completed")).toHaveLength(1);

    // Merging is not closing: no bd command was run by any seam.
    expect(commands.every((argv) => argv[0] !== "bd")).toBe(true);
    expect(commands.some((argv) => argv.includes("bd-12") && argv[0] === "bd")).toBe(false);

    // The report states the bead is not closed.
    expect(result.text).toContain("merging is not closing");
  });

  it("records a merged member's landing release (bd-168)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", true);
    const loaded = readFleetIntent({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
    });
    if (!loaded.ok || loaded.intent === undefined) throw new Error("intent unreadable");
    expect(loaded.intent.released).toContainEqual({
      taskId: "bd-12",
      reason: "merged",
      at: expect.any(Number),
    });
    expect(auditActions(fixture)).toContain("member-merged-released");
  });

  it("reports a refused worktree removal without failing the drain (bd-168)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const refusing: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "worktree" && argv[1] === "remove") {
        return {
          ok: false,
          error: "fatal: working tree is dirty",
          stdout: "",
          stderr: "fatal: working tree is dirty",
        };
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: refusing });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(existsSync(fixture.memberPath)).toBe(true);
    expect(result.text).toContain(`kept worktree ${fixture.memberPath}`);
    expect(result.text).toContain(`git worktree remove ${fixture.memberPath}`);
    expect(result.warnings.join("\n")).toContain("could not remove");
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
    // Both sides are named: this is the class a person decides. No run record proves
    // a sibling landed here, so the base commit is narrated as base work committed
    // after the fleet started, never as a member-vs-member contradiction (W2).
    expect(result.paths).toEqual(["conflict.txt"]);
    expect(result.text).toContain("real contradiction");
    expect(result.text).toContain("base work committed after this fleet started");
    expect(result.text).toContain(memberHead.slice(0, 12));
    expect(result.text).toContain(rootHead.slice(0, 12));
    expect(git(fixture.memberPath, ["rev-parse", "feat/bd-12"])).toBe(memberHead);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(git(fixture.root, ["status", "--porcelain"])).toBe("");
    expect(readQueue(fixture).entries[0]?.state).toBe("failed");
    const actions = auditActions(fixture);
    expect(actions).toContain("merge-rebase-failed");
    expect(actions).toContain("merge-rebase-classified");
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

// ── Rebase failure classification (bd-280) ────────────────────────────

describe("drainFleetMerge: rebase failure classification (bd-280)", () => {
  /**
   * A member and a base that both changed `path`, so the drain's rebase conflicts.
   *
   * `createdAt` is left at the fixture default (1) unless a test overrides it, so
   * the base-side commit reads as work that landed *after* the fleet started — the
   * sibling case. A test that wants pre-existing base work moves `createdAt` past
   * the commits instead.
   */
  function createConflictFixture(options: { path?: string } = {}): {
    fixture: FixtureRepo;
    memberSha: string;
    baseSha: string;
  } {
    const path = options.path ?? "conflict.txt";
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.memberPath, path), "member version\n");
    const memberSha = commit(fixture.memberPath, "member conflict commit");
    writeFileSync(join(fixture.root, path), "base version\n");
    const baseSha = commit(fixture.root, "base conflict commit");
    enqueue(fixture);
    return { fixture, memberSha, baseSha };
  }

  /** Move the fleet's start past the fixture's commits (pre-existing base work). */
  function startFleetAfterCommits(fixture: FixtureRepo): void {
    const createdAt = Date.now() + 60_000;
    const written = updateFleetIntent({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      update: (current) => {
        if (current === undefined) throw new Error("fleet intent missing in fixture");
        return { ...current, createdAt, updatedAt: createdAt };
      },
    });
    if (!written.ok) throw new Error(written.error);
  }

  /** The path git would leave a stopped rebase state at, resolved for the check. */
  function rebaseStatePath(memberPath: string): string {
    const raw = git(memberPath, ["rev-parse", "--git-path", "rebase-merge"]);
    return raw.startsWith("/") ? raw : join(memberPath, raw);
  }

  function assertNoRebaseLeft(fixture: FixtureRepo): void {
    // A successful drain removes the worktree, so there is no rebase state left to
    // inspect (bd-168); the removal itself is asserted by the sequence test.
    if (!existsSync(fixture.memberPath)) return;
    expect(existsSync(rebaseStatePath(fixture.memberPath))).toBe(false);
    expect(git(fixture.memberPath, ["status", "--porcelain"])).toBe("");
  }

  it("recovers a failure with no conflicted paths and retries exactly once", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);
    const gate = gateSpy();

    // A transient no-conflict failure (a stale index lock, a crashed earlier
    // attempt): the first rebase fails without touching the index, the retry is a
    // real `git rebase` and succeeds.
    let rebaseAttempts = 0;
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "rebase" && argv[1] === "main") {
        rebaseAttempts += 1;
        if (rebaseAttempts === 1) {
          return {
            ok: false,
            error: "fatal: Unable to create '.git/index.lock': File exists.",
            stdout: "",
            stderr: "fatal: Unable to create '.git/index.lock': File exists.",
          };
        }
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gate.runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(rebaseAttempts).toBe(2);
    expect(gate.calls.length).toBeGreaterThan(0);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);
    const actions = auditActions(fixture);
    expect(actions).toContain("merge-rebase-classified");
    expect(actions).toContain("merge-rebase-recovered");
    assertNoRebaseLeft(fixture);
  });

  it("stops after one failed recovery retry, with no second retry", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const memberHead = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);
    // The base has to move for the rebase to have anything to do; otherwise git
    // reports "up to date" and the failure under test never happens.
    writeFileSync(join(fixture.root, "base-extra.txt"), "base moved\n");
    commit(fixture.root, "base moves");

    // A live index lock is what a crashed attempt leaves behind; nothing is
    // conflicted, so this is the stale-state class, and the retry proves the lock
    // is still held. Deleting the lock is not ours to do: a live member's process
    // can hold it.
    const indexPath = git(fixture.memberPath, ["rev-parse", "--git-path", "index"]);
    const lockPath = `${indexPath.startsWith("/") ? indexPath : join(fixture.memberPath, indexPath)}.lock`;
    writeFileSync(lockPath, "");

    let rebaseAttempts = 0;
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "rebase" && argv[1] === "main") rebaseAttempts += 1;
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("rebase-failed");
    expect(result.text).toContain("retry:");
    expect(result.text).toContain("index.lock");
    expect(rebaseAttempts).toBe(2);
    expect(git(fixture.memberPath, ["rev-parse", "feat/bd-12"])).toBe(memberHead);
    expect(readQueue(fixture).entries[0]?.state).toBe("failed");

    rmSync(lockPath, { force: true });
    assertNoRebaseLeft(fixture);
  });

  it("regenerates a conflict confined to generated paths and continues the merge", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.memberPath, "pnpm-lock.yaml"), "lockfileVersion: 2\n");
    const memberSha = commit(fixture.memberPath, "member edits the lockfile");
    writeFileSync(join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: 3\n");
    commit(fixture.root, "base edits the lockfile");
    enqueue(fixture);

    const regenerations: Array<{ paths: readonly string[]; installRequired: boolean }> = [];
    const regenerate: FleetMergeRegenerateRunner = async (input) => {
      regenerations.push({ paths: input.paths, installRequired: input.installRequired });
      // The seam stands in for the package manager: the base side is already in
      // the index, so the regenerated content is what the test asserts on.
      return { ok: true };
    };
    const gate = gateSpy();

    const result = await drain(fixture, { runGate: gate.runGate, regenerate });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(regenerations).toEqual([{ paths: ["pnpm-lock.yaml"], installRequired: true }]);
    // The rebased member branch carries the base's lockfile; the member's lockfile
    // commit became empty and git dropped it during the continue, which is the
    // honest outcome of regenerating that change wholesale. The successful drain
    // then removed the member branch, so the base HEAD is the landing itself.
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(result.mergeCommit);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).not.toBe(memberSha);
    expect(git(fixture.root, ["log", "-1", "--format=%s"])).toBe("member bd-12");
    expect(git(fixture.root, ["show", "HEAD:pnpm-lock.yaml"])).toBe("lockfileVersion: 3");
    expect(gate.calls.length).toBeGreaterThan(0);
    const actions = auditActions(fixture);
    expect(actions).toContain("merge-rebase-recovered");
    expect(readQueue(fixture).entries[0]?.state).toBe("merged");
    assertNoRebaseLeft(fixture);
  });

  it("aborts a generated-path recovery that fails, naming the step", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.memberPath, "pnpm-lock.yaml"), "lockfileVersion: 2\n");
    commit(fixture.memberPath, "member edits the lockfile");
    writeFileSync(join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: 3\n");
    const rootHead = commit(fixture.root, "base edits the lockfile");
    enqueue(fixture);
    const memberHead = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);
    const gate = gateSpy();

    const result = await drain(fixture, {
      runGate: gate.runGate,
      regenerate: async () => ({ ok: false, error: "`pnpm install` failed: ENOSPC" }),
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("rebase-failed");
    expect(result.paths).toEqual(["pnpm-lock.yaml"]);
    expect(result.text).toContain("could not be regenerated");
    expect(result.text).toContain("ENOSPC");
    expect(gate.calls).toEqual([]);
    expect(git(fixture.memberPath, ["rev-parse", "feat/bd-12"])).toBe(memberHead);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(readQueue(fixture).entries[0]?.state).toBe("failed");
    assertNoRebaseLeft(fixture);
  });

  it("delegates a conflict with pre-existing base work to a live member", async () => {
    const { fixture, memberSha, baseSha } = createConflictFixture();
    startFleetAfterCommits(fixture);
    const gate = gateSpy();

    const result = await drain(fixture, {
      runGate: gate.runGate,
      memberLease: "live" as FleetMemberClaim,
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("rebase-delegated");
    // The complete conflicted list travels with the delegation, not only the
    // bounded text the operator sees (W5).
    expect(result.delegated).toEqual({ taskId: "bd-12", paths: ["conflict.txt"] });
    expect(result.paths).toEqual(["conflict.txt"]);
    expect(result.text).toContain("delegated to the member");
    expect(result.text).toContain(baseSha.slice(0, 12));
    // Not stopped, not merged: the entry is what carries the delegation forward.
    const entry = readQueue(fixture).entries[0];
    expect(entry?.state).toBe("failed");
    expect(entry?.delegatedAt).toEqual(expect.any(Number));
    expect(entry?.lastError).toContain("delegated to the member");
    expect(gate.calls).toEqual([]);

    const notes = drainNotes({ dir: fleetEventsDir(fixture.commonDir, fixture.fleetId) });
    if (!notes.ok) throw new Error(notes.error);
    const hints = notes.deliveries.filter((delivery) => delivery.note.kind === "rebase-hint");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.note.to).toBe("bd-12");
    expect(hints[0]?.note.body).toContain("Resolve the conflict");

    expect(git(fixture.memberPath, ["rev-parse", "feat/bd-12"])).toBe(memberSha);
    expect(existsSync(rebaseStatePath(fixture.memberPath))).toBe(false);
    expect(git(fixture.memberPath, ["status", "--porcelain"])).toBe("");
    expect(auditActions(fixture)).toContain("merge-rebase-classified");
  });

  it("stops as unknown when nobody alive can decide the conflict", async () => {
    const { fixture, memberSha } = createConflictFixture();
    startFleetAfterCommits(fixture);

    // A stale lease: the member cannot resolve its own rebase any more.
    const result = await drain(fixture, { runGate: gateSpy().runGate, memberLease: "stale" });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("rebase-failed");
    expect(result.paths).toEqual(["conflict.txt"]);
    expect(result.text).toContain("conflicted paths: conflict.txt");
    expect(git(fixture.memberPath, ["rev-parse", "feat/bd-12"])).toBe(memberSha);
    expect(existsSync(rebaseStatePath(fixture.memberPath))).toBe(false);
    expect(git(fixture.memberPath, ["status", "--porcelain"])).toBe("");
    const actions = auditActions(fixture);
    expect(actions).toContain("merge-rebase-failed");
  });

  it("clears a stopped rebase before reporting a lost lock (bd-280 C1)", async () => {
    const { fixture } = createConflictFixture();
    const memberHead = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);

    let rebaseAttempts = 0;
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "rebase" && argv[1] === "main") {
        rebaseAttempts += 1;
        // A crashed attempt left a real stopped rebase behind, and something staged
        // its resolution before dying: the state exists, nothing is conflicted — the
        // stale-state class. The lease is lost at the same moment, which used to
        // return before the state was cleared.
        await defaultFleetMergeGitRunner(["rebase", "main"], options);
        await defaultFleetMergeGitRunner(["checkout", "--ours", "--", "conflict.txt"], options);
        await defaultFleetMergeGitRunner(["add", "--", "conflict.txt"], options);
        rmSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId), {
          recursive: true,
          force: true,
        });
        return {
          ok: false,
          error: "fatal: It seems that there is already a rebase-merge directory",
          stdout: "",
          stderr: "",
        };
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("lock-unavailable");
    expect(rebaseAttempts).toBe(1);
    // The invariant every other class keeps: the stopped rebase is cleared. The
    // worktree is not handed to the next attempt mid-rebase.
    expect(existsSync(rebaseStatePath(fixture.memberPath))).toBe(false);
    expect(git(fixture.memberPath, ["status", "--porcelain"])).toBe("");
    expect(git(fixture.memberPath, ["rev-parse", "feat/bd-12"])).toBe(memberHead);
  });

  it("classifies a recovery retry's conflict instead of binning it as unknown (bd-280 W1)", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.memberPath, "pnpm-lock.yaml"), "lockfileVersion: 2\n");
    commit(fixture.memberPath, "member edits the lockfile");
    writeFileSync(join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: 3\n");
    commit(fixture.root, "base edits the lockfile");
    enqueue(fixture);

    let rebaseAttempts = 0;
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "rebase" && argv[1] === "main") {
        rebaseAttempts += 1;
        // The first attempt dies on a stale state and never produces a conflict; the
        // retry is a real rebase, and it conflicts on the generated path.
        if (rebaseAttempts === 1) {
          return {
            ok: false,
            error: "fatal: Unable to create '.git/index.lock': File exists.",
            stdout: "",
            stderr: "",
          };
        }
      }
      return defaultFleetMergeGitRunner(argv, options);
    };
    const regenerations: Array<readonly string[]> = [];

    const result = await drain(fixture, {
      runGate: gateSpy().runGate,
      git: gitRunner,
      regenerate: async (input) => {
        regenerations.push(input.paths);
        return { ok: true };
      },
    });

    // The retry's failure is classified like any other: generated paths are
    // regenerated and the merge continues, instead of a hard stop as `unknown`.
    expect(result).toHaveProperty("ok", true);
    expect(rebaseAttempts).toBe(2);
    expect(regenerations).toEqual([["pnpm-lock.yaml"]]);
    // Once per failed rebase, so both the first attempt and the retry are audited.
    expect(auditDetails(fixture, "merge-rebase-classified")).toEqual([
      "not-a-conflict: ",
      "generated: pnpm-lock.yaml",
    ]);
    expect(readQueue(fixture).entries[0]?.state).toBe("merged");
    assertNoRebaseLeft(fixture);
  });

  it("names the landed sibling the run record proves (bd-280 W2)", async () => {
    const { fixture, memberSha, baseSha } = createConflictFixture();
    // A sibling landed through this fleet before bd-12's rebase, and that landing is
    // the run record's proof: only then may the stop text call the base work a
    // land, and name whose it is.
    const written = updateFleetIntent({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      update: (current) => {
        if (current === undefined) throw new Error("fleet intent missing in fixture");
        return {
          ...current,
          run: {
            schemaVersion: 1,
            mode: "until-complete",
            startedAt: 1,
            updatedAt: 2,
            ticks: 1,
            members: [
              { taskId: "bd-15", launchedAt: 1, landedAt: 2 },
              { taskId: "bd-12", launchedAt: 1 },
            ],
          },
        };
      },
    });
    if (!written.ok) throw new Error(written.error);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("rebase-failed");
    expect(result.text).toContain("vs landed bd-15");
    expect(result.text).toContain(memberSha.slice(0, 12));
    expect(result.text).toContain(baseSha.slice(0, 12));
    expect(result.paths).toEqual(["conflict.txt"]);
  });

  it("stops when the queue cannot record the delegation (bd-280 W3)", async () => {
    const { fixture } = createConflictFixture();
    startFleetAfterCommits(fixture);

    // The `failed` transition that carries `delegatedAt` cannot be written: reporting
    // a delegation nothing durable records would re-run the rebase (and a fresh
    // hint) on every acting tick.
    const result = await drain(fixture, {
      runGate: gateSpy().runGate,
      memberLease: "live",
      fs: fsRefusingWrite(({ content }) => content.includes('"delegatedAt"')),
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("rebase-failed");
    expect(result).not.toHaveProperty("delegated");
    expect(result.paths).toEqual(["conflict.txt"]);
    expect(result.text).toContain("could not be recorded");
    expect(readQueue(fixture).entries[0]?.delegatedAt).toBeUndefined();
    assertNoRebaseLeft(fixture);
    expect(auditDetails(fixture, "merge-rebase-failed")).toHaveLength(1);
  });

  it("stops when the rebase-hint could not be written (bd-280 W4)", async () => {
    const { fixture, memberSha } = createConflictFixture();
    startFleetAfterCommits(fixture);

    // A member that was never asked cannot be expected to act, so a failed hint is a
    // stop, not a delegation with an honest footnote.
    const result = await drain(fixture, {
      runGate: gateSpy().runGate,
      memberLease: "live",
      fs: fsRefusingWrite(
        ({ content, target }) =>
          target.includes(join("fleet", fixture.fleetId, "events")) &&
          content.includes("rebase-hint"),
      ),
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("rebase-failed");
    expect(result).not.toHaveProperty("delegated");
    expect(result.text).toContain("rebase-hint could not be written");
    expect(readQueue(fixture).entries[0]).toMatchObject({ state: "failed" });
    expect(readQueue(fixture).entries[0]?.delegatedAt).toBeUndefined();
    expect(git(fixture.memberPath, ["rev-parse", "feat/bd-12"])).toBe(memberSha);
    assertNoRebaseLeft(fixture);
  });

  it("releases the lock and clears the rebase when a merge step throws (bd-280 W6)", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.memberPath, "pnpm-lock.yaml"), "lockfileVersion: 2\n");
    commit(fixture.memberPath, "member edits the lockfile");
    writeFileSync(join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: 3\n");
    commit(fixture.root, "base edits the lockfile");
    enqueue(fixture);
    const memberHead = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);
    const rootHead = git(fixture.root, ["rev-parse", "HEAD"]);

    const result = await drain(fixture, {
      runGate: gateSpy().runGate,
      regenerate: async () => {
        throw new Error("regenerate exploded");
      },
    });

    // A throwing seam yields a defined refusal instead of a rejected promise.
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("step-failed");
    expect(result.text).toContain("regenerate exploded");
    expect(auditActions(fixture)).toContain("merge-step-threw");
    // The lock does not outlive the drain, and the interrupted rebase is cleared.
    expect(readQueue(fixture).lock ?? null).toBeNull();
    expect(existsSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId))).toBe(false);
    assertNoRebaseLeft(fixture);
    expect(git(fixture.memberPath, ["rev-parse", "feat/bd-12"])).toBe(memberHead);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
  });

  it("keeps a merge that landed when a step after it throws (bd-280 WF)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);

    let fastForwarded = false;
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "merge" && argv[1] === "--ff-only") fastForwarded = true;
      // The base branch has already advanced, but reading its new HEAD throws: the
      // merge happened, so the refusal must say so instead of recording a failure.
      if (fastForwarded && argv[0] === "rev-parse" && argv[1] === "HEAD") {
        throw new Error("rev-parse seam exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("step-failed");
    expect(result.text).toContain("merged bd-12 into main at an unreadable sha");
    expect(result.text).toContain("rev-parse seam exploded");
    expect(readQueue(fixture).entries[0]?.state).toBe("merged");
    expect(readQueue(fixture).lock ?? null).toBeNull();
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);
    // The landed merge still gets its one completion entry, even though the throw hit
    // before the success finisher could write it (bd-280 S6).
    expect(auditActions(fixture).filter((action) => action === "merge-completed")).toHaveLength(1);
    expect(auditDetails(fixture, "merge-completed")[0]).toContain("at an unreadable sha");
    // An unreadable base commit is named, not probed: every remaining member is hinted
    // without asking git to compare against an empty sha (bd-280 S8).
    expect(noteRecipients(fixture, "rebase-hint")).toEqual(["bd-15"]);
    expect(auditDetails(fixture, "rebase-hint")[0]).toContain("the merge commit was unreadable");
    expect(result.warnings.join("\n")).toContain("every remaining member was sent a rebase-hint");

    // The base moved, so the landed-then-threw arm must still free the slot and
    // clean up the tree (bd-168 W1), exactly like the clean success arm.
    const loaded = readFleetIntent({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
    });
    if (!loaded.ok || loaded.intent === undefined) throw new Error("intent unreadable");
    expect(loaded.intent.released).toContainEqual({
      taskId: "bd-12",
      reason: "merged",
      at: expect.any(Number),
    });
    expect(auditActions(fixture)).toContain("member-merged-released");
    expect(existsSync(fixture.memberPath)).toBe(false);
    expect(git(fixture.root, ["branch", "--list", "feat/bd-12"])).toBe("");

    // Re-entering the drain after the landed arm is a no-op, not a second release
    // or audit entry.
    const again = await drain(fixture, { runGate: gateSpy().runGate });
    expect(again).toHaveProperty("ok", false);
    expect(
      auditActions(fixture).filter((action) => action === "member-merged-released"),
    ).toHaveLength(1);
    const after = readFleetIntent({ gitCommonDir: fixture.commonDir, fleetId: fixture.fleetId });
    if (!after.ok || after.intent === undefined) throw new Error("intent unreadable");
    expect((after.intent.released ?? []).filter((entry) => entry.taskId === "bd-12")).toHaveLength(
      1,
    );
  });

  it("reports cleanup honestly when branch deletion throws after removal (bd-168 W4)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "branch" && argv[1] === "-d") {
        throw new Error("branch seam exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(existsSync(fixture.memberPath)).toBe(false);
    expect(result.text).toContain("cleanup did not finish (branch seam exploded)");
    expect(result.text).toContain(`worktree ${fixture.memberPath} is gone`);
    expect(result.text).toContain("branch feat/bd-12 still exists");
    expect(result.text).not.toContain("kept worktree");
    expect(result.warnings.join("\n")).toContain("cleanup did not finish");
  });

  it("reports an unverifiable branch probe as unknown, never as gone (bd-168 W1)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "for-each-ref") {
        return {
          ok: false,
          error: "fatal: not a git repository",
          stdout: "",
          stderr: "fatal: not a git repository",
        };
      }
      if (argv[0] === "branch" && argv[1] === "-d") {
        throw new Error("branch seam exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.text).toContain("branch feat/bd-12 state is unknown");
    expect(result.text).not.toContain("branch feat/bd-12 is gone");
  });

  it("reports a branch that disappeared as already gone, not kept (bd-168 S1)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    let probes = 0;
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "for-each-ref") {
        probes += 1;
        // The first probe cannot answer, so the drain tries the delete; the re-probe
        // after the refusal is a successful query that finds no ref: absence (bd-168 R3).
        return probes === 1
          ? { ok: false, error: "probe failed", stdout: "", stderr: "probe failed" }
          : { ok: true, stdout: "", stderr: "" };
      }
      if (argv[0] === "branch" && argv[1] === "-d") {
        return {
          ok: false,
          error: "error: branch 'feat/bd-12' not found",
          stdout: "",
          stderr: "error: branch 'feat/bd-12' not found.",
        };
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.text).toContain("branch feat/bd-12 was already gone");
    expect(result.text).not.toContain("kept branch");
  });

  it("classifies a refusal by the re-probe, not by a 'not found' branch name (bd-168 R3 W1)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      // The real probe keeps answering "present": the branch is still there, whatever
      // git's refusal message happens to say about it.
      if (argv[0] === "branch" && argv[1] === "-d") {
        return {
          ok: false,
          error: "error: Cannot delete branch",
          stdout: "",
          stderr: "error: Cannot delete branch 'feat/not found hack' checked out at somewhere",
        };
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.text).toContain("kept branch feat/bd-12");
    expect(result.text).not.toContain("was already gone");
    expect(git(fixture.root, ["branch", "--list", "feat/bd-12"])).not.toBe("");
  });

  it("reports an unanswered re-probe after a refusal as unverified (bd-168 R3 W1)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    let probes = 0;
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "for-each-ref") {
        probes += 1;
        return probes === 1
          ? { ok: true, stdout: "refs/heads/feat/bd-12\n", stderr: "" }
          : {
              ok: false,
              error: "fatal: not a git repository",
              stdout: "",
              stderr: "fatal: not a git repository",
            };
      }
      if (argv[0] === "branch" && argv[1] === "-d") {
        return {
          ok: false,
          error: "error: Cannot delete branch",
          stdout: "",
          stderr: "error: Cannot delete branch 'feat/bd-12' checked out at somewhere",
        };
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.text).toContain("branch feat/bd-12 may still exist");
    expect(result.text).not.toContain("was already gone");
    expect(result.text).not.toContain("kept branch");
  });

  it("reports a real branch-delete refusal as kept (bd-168 S1)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "branch" && argv[1] === "-d") {
        return {
          ok: false,
          error: "error: Cannot delete branch checked out",
          stdout: "",
          stderr: "error: Cannot delete branch 'feat/bd-12' checked out at somewhere",
        };
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.text).toContain("kept branch feat/bd-12");
    expect(result.text).not.toContain("was already gone");
  });

  it("does not leave a phantom release for an already-pruned member (bd-168 S3)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture, "bd-12");
    // Another operator pruned bd-12 from the fleet before this manual drain.
    writeFleetIntent(fixture.commonDir, fixture.fleetId, ["bd-15"]);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", true);
    const loaded = readFleetIntent({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
    });
    if (!loaded.ok || loaded.intent === undefined) throw new Error("intent unreadable");
    expect(loaded.intent.released).toBeUndefined();
    expect(auditActions(fixture)).not.toContain("member-merged-released");
  });

  it("reports a finisher throw after the merge as landed, never as failed (bd-280 WF)", async () => {
    const fixture = createFixtureRepo();
    // A dirty root is stashed before the rebase, so the restore is a post-merge step
    // this test can make throw.
    writeFileSync(join(fixture.root, "operator-work.txt"), "uncommitted\n");
    enqueue(fixture);
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);

    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "stash" && argv[1] === "apply") {
        throw new Error("restore seam exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    // A throw in the finisher must not reject the drain.
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("step-failed");
    expect(result.text).toContain(`merged bd-12 into main at ${memberTip.slice(0, 12)}`);
    expect(result.text).toContain("the merge landed and is not retried");
    expect(result.text).toContain("restore seam exploded");
    // The member landed and stays landed: the throw came after the merged transition.
    expect(readQueue(fixture).entries[0]?.state).toBe("merged");
    expect(readQueue(fixture).lock ?? null).toBeNull();
    expect(existsSync(fleetMergeLockDir(fixture.commonDir, fixture.fleetId))).toBe(false);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);
    expect(auditActions(fixture)).toContain("merge-step-threw");
    // One landed audit and one throw: the merge happened, and the arm that found it
    // landed did not write a second completion entry (bd-280 S6).
    expect(auditActions(fixture).filter((action) => action === "merge-completed")).toHaveLength(1);
    expect(auditActions(fixture).filter((action) => action === "merge-step-threw")).toHaveLength(1);
  });

  it("broadcasts the base move when a finisher throws after the merge (bd-280 S5)", async () => {
    const fixture = createFixtureRepo();
    // Two members remain: bd-15 and bd-19, both still on the pre-merge base, so each
    // is due a `base-moved`, a `sibling-landed` and a `rebase-hint`.
    const thirdPath = `${fixture.root}.feat-bd-19`;
    cleanup.push(thirdPath);
    git(fixture.root, ["worktree", "add", "-q", "-b", "feat/bd-19", thirdPath]);
    writeFleetIntent(fixture.commonDir, fixture.fleetId, ["bd-12", "bd-15", "bd-19"]);
    // A dirty root is stashed before the rebase, so the restore is a post-merge step
    // this test can make throw.
    writeFileSync(join(fixture.root, "operator-work.txt"), "uncommitted\n");
    enqueue(fixture);
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);

    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "stash" && argv[1] === "apply") {
        throw new Error("restore seam exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    // The throw is reported as a landed merge, not as a rejected drain.
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("step-failed");
    expect(result.text).toContain("the merge landed and is not retried");
    expect(readQueue(fixture).entries[0]?.state).toBe("merged");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);

    // The siblings were still told: their branches are on a stale base either way.
    const events = drainNotes({ dir: fleetEventsDir(fixture.commonDir, fixture.fleetId) });
    if (!events.ok) throw new Error(events.error);
    const delivered = events.deliveries.map(
      (delivery) => `${delivery.note.kind}:${delivery.note.to}`,
    );
    expect(delivered.sort()).toEqual([
      "base-moved:bd-15",
      "base-moved:bd-19",
      "rebase-hint:bd-15",
      "rebase-hint:bd-19",
      "sibling-landed:bd-15",
      "sibling-landed:bd-19",
    ]);
  });

  it("turns a broadcast throw after the merge into a warning, never a second failure (bd-280 S5)", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);

    // The fan-out writes its notes and then the branch probe throws, so the retry on
    // the landed arm finds those notices already recorded and does not repeat them.
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "merge-base" && argv.includes("--is-ancestor")) {
        throw new Error("branch probe exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("step-failed");
    expect(result.text).toContain("the merge landed and is not retried");
    expect(result.warnings.join("\n")).toContain("could not send the base-moved notices");
    expect(readQueue(fixture).entries[0]?.state).toBe("merged");
    expect(readQueue(fixture).lock ?? null).toBeNull();
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);

    // The two kinds that did go out are not sent a second time by the retry.
    const events = drainNotes({ dir: fleetEventsDir(fixture.commonDir, fixture.fleetId) });
    if (!events.ok) throw new Error(events.error);
    const kinds = events.deliveries.map((delivery) => delivery.note.kind).sort();
    expect(kinds).toEqual(["base-moved", "sibling-landed"]);
  });

  it("audits one merge-completed when the merged transition failed and a finisher throws (bd-280 S6)", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.root, "operator-work.txt"), "uncommitted\n");
    enqueue(fixture);
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);

    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "stash" && argv[1] === "apply") {
        throw new Error("restore seam exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };
    // The `merged` transition is refused, so the queue entry never records the merge:
    // the landed audit must not be keyed on it (that wrote a second entry).
    const fs = fsRefusingWrite(
      ({ content, target }) => target.endsWith("merge-queue.json") && content.includes('"merged"'),
    );

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner, fs });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("step-failed");
    expect(result.text).toContain("the merge landed and is not retried");
    // The entry never recorded `merged` (it stays at the pre-merge `merging`); the
    // merge still landed on the base branch.
    expect(readQueue(fixture).entries[0]?.state).toBe("merging");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);
    expect(auditActions(fixture).filter((action) => action === "merge-completed")).toHaveLength(1);
    expect(auditActions(fixture).filter((action) => action === "merge-step-threw")).toHaveLength(1);
  });

  it("retries a merge-completed audit whose own append failed (bd-280 S6)", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.root, "operator-work.txt"), "uncommitted\n");
    enqueue(fixture);
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);

    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "stash" && argv[1] === "apply") {
        throw new Error("restore seam exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, {
      runGate: gateSpy().runGate,
      git: gitRunner,
      fs: fsFailingFirstAuditAppend("merge-completed"),
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("step-failed");
    // The failed append is reported, and the landed arm wrote the entry the operator
    // greps for — the log holds one, not zero and not two.
    expect(result.warnings.join("\n")).toContain("could not append to audit.log");
    expect(auditActions(fixture).filter((action) => action === "merge-completed")).toHaveLength(1);
    expect(auditActions(fixture).filter((action) => action === "merge-step-threw")).toHaveLength(1);
    expect(readQueue(fixture).entries[0]?.state).toBe("merged");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);
  });

  it("resumes a partial broadcast with only the members it missed (bd-280 S7)", async () => {
    const fixture = createFixtureRepo();
    const thirdPath = `${fixture.root}.feat-bd-19`;
    cleanup.push(thirdPath);
    git(fixture.root, ["worktree", "add", "-q", "-b", "feat/bd-19", thirdPath]);
    writeFleetIntent(fixture.commonDir, fixture.fleetId, ["bd-12", "bd-15", "bd-19"]);
    enqueue(fixture);

    // bd-19's note writes fail twice (one per kind on the first attempt), so the first
    // fan-out is partial: bd-15 was written and bd-19 was not.
    let bd19Refusals = 0;
    const fs = fsRefusingWrite(({ content }) => {
      if (!content.includes('"to": "bd-19"')) return false;
      bd19Refusals += 1;
      return bd19Refusals <= 2;
    });
    // The branch probe throws once, after the two partial fan-outs, so the retry is
    // the landed arm's.
    let probes = 0;
    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "merge-base" && argv.includes("--is-ancestor")) {
        probes += 1;
        if (probes === 1) throw new Error("branch probe exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner, fs });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("step-failed");
    expect(result.warnings.join("\n")).toContain("partially sent to bd-15");
    // Every member got every kind exactly once: the retry wrote only the missing
    // recipient and never a second file for bd-15.
    expect(noteRecipients(fixture, "base-moved").sort()).toEqual(["bd-15", "bd-19"]);
    expect(noteRecipients(fixture, "sibling-landed").sort()).toEqual(["bd-15", "bd-19"]);
    expect(noteRecipients(fixture, "rebase-hint").sort()).toEqual(["bd-15", "bd-19"]);
    expect(
      auditDetails(fixture, "base-moved").some((detail) => detail.startsWith("partial fan-out")),
    ).toBe(true);
  });

  it("keeps the primary reason when the failure finisher throws (bd-280 WF)", async () => {
    const fixture = createFixtureRepo();
    writeFileSync(join(fixture.root, "operator-work.txt"), "uncommitted\n");
    enqueue(fixture);
    const rootHead = git(fixture.root, ["rev-parse", "HEAD"]);

    const gitRunner: FleetMergeGitRunner = async (argv, options) => {
      if (argv[0] === "stash" && argv[1] === "apply") {
        throw new Error("restore seam exploded");
      }
      return defaultFleetMergeGitRunner(argv, options);
    };

    const result = await drain(fixture, {
      runGate: gateSpy({ failAt: "test" }).runGate,
      git: gitRunner,
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    // The gate refusal is what the operator has to fix; the cleanup throw is added
    // to it rather than replacing it.
    expect(result.reason).toBe("gate-failed");
    expect(result.text).toContain("gate exploded");
    expect(result.text).toContain("finishing this drain also threw");
    expect(result.text).toContain("restore seam exploded");
    expect(readQueue(fixture).entries[0]?.state).toBe("failed");
    expect(readQueue(fixture).lock ?? null).toBeNull();
    expect(auditActions(fixture)).toContain("merge-step-threw");
    // Nothing reached the base branch: the ff-merge never ran.
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
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
    const memberTip = git(fixture.memberPath, ["rev-parse", "feat/bd-12"]);
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
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(memberTip);
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

describe("drainFleetMerge: publish payload guard (bd-181)", () => {
  it("refuses a branch that still carries proof artifacts, naming them", async () => {
    const fixture = createFixtureRepo();
    mkdirSync(join(fixture.memberPath, "docs", "proof", "bd-12"), { recursive: true });
    writeFileSync(join(fixture.memberPath, "docs", "proof", "bd-12", "shot.png"), "png");
    commit(fixture.memberPath, "commit proof artifact");
    enqueue(fixture);

    const rootHead = git(fixture.root, ["rev-parse", "HEAD"]);
    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    expect(result.text).toContain("proof-artifacts-in-diff");
    expect(result.text).toContain("docs/proof/bd-12/shot.png");
    expect(result.paths).toStrictEqual(["docs/proof/bd-12/shot.png"]);
    // Nothing was mutated before the refusal: no lock, no stash, no rebase.
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(readQueue(fixture).entries.find((entry) => entry.taskId === "bd-12")?.state).toBe(
      "queued",
    );
    expect(auditActions(fixture)).not.toContain("merge-acquired");
  });

  it("refuses harness-local paths in the payload with paths-outside-scope", async () => {
    const fixture = createFixtureRepo();
    mkdirSync(join(fixture.memberPath, ".belayd"), { recursive: true });
    writeFileSync(join(fixture.memberPath, ".belayd", "workflow.json"), "{}\n");
    commit(fixture.memberPath, "commit harness bookkeeping");
    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("paths-outside-scope");
    expect(result.text).toContain("paths-outside-scope");
    expect(result.text).toContain(".belayd/workflow.json");
    expect(result.paths).toStrictEqual([".belayd/workflow.json"]);
  });

  it("refuses a proof path with a space and non-ASCII characters (git would C-quote it)", async () => {
    const fixture = createFixtureRepo();
    // Default `git diff --name-only` renders this as
    // `"docs/proof/bd-12/caf\303\251 proof.png"`, which matches neither the proof
    // directory prefix nor the `.png` extension. The NUL-delimited, quotePath-free
    // read is what makes the gate see the real path.
    mkdirSync(join(fixture.memberPath, "docs", "proof", "bd-12"), { recursive: true });
    writeFileSync(join(fixture.memberPath, "docs", "proof", "bd-12", "café proof.png"), "png");
    commit(fixture.memberPath, "commit quoted-proof artifact");
    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    expect(result.text).toContain("docs/proof/bd-12/café proof.png");
    expect(result.paths).toStrictEqual(["docs/proof/bd-12/café proof.png"]);
  });

  it("normalizes a `.//proof/` path before classifying it", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    // A real repository cannot hold this path in an index entry (git normalizes
    // it), so the seam returns the exact bytes a NUL-delimited diff would carry.
    const gitRunner: FleetMergeGitRunner = async (argv, options) =>
      argv.includes("diff") && argv.includes("--name-only")
        ? { ok: true, stdout: "member.txt\0.//proof/bd-12/shot.png\0", stderr: "" }
        : defaultFleetMergeGitRunner(argv, options);

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    expect(result.text).toContain("proof/bd-12/shot.png");
    expect(result.paths).toStrictEqual(["proof/bd-12/shot.png"]);
  });

  it("fails closed when the payload diff cannot be read", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);
    const rootHead = git(fixture.root, ["rev-parse", "HEAD"]);
    const gitRunner: FleetMergeGitRunner = async (argv, options) =>
      argv.includes("diff") && argv.includes("--name-only")
        ? { ok: false, error: "diff exploded", stdout: "", stderr: "" }
        : defaultFleetMergeGitRunner(argv, options);

    const result = await drain(fixture, { runGate: gateSpy().runGate, git: gitRunner });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("publish-payload-unreadable");
    expect(result.text).toContain("diff exploded");
    expect(result.paths).toBeUndefined();
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(readQueue(fixture).entries[0]?.state).toBe("queued");
  });

  it("leaves the ordinary merge path green when the payload is clean", async () => {
    const fixture = createFixtureRepo();
    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", true);
  });

  it("merges a receipt-published bead whose diff carries no proof files", async () => {
    const fixture = createFixtureRepo();
    // Mirror the real repository: `.belayd/` is gitignored, which is what makes
    // the receipt invisible to the payload diff. Without it the untracked
    // receipt would make the member worktree dirty and the drain would refuse
    // for an unrelated reason.
    writeFileSync(join(fixture.memberPath, ".gitignore"), ".belayd/\n");
    writeFileSync(join(fixture.memberPath, "src-change.txt"), "source change\n");
    commit(fixture.memberPath, "receipt-published change");

    mkdirSync(join(fixture.memberPath, ".belayd"), { recursive: true });
    writeFileSync(
      join(fixture.memberPath, ".belayd", "proof-receipt.json"),
      serializeProofReceipt({
        version: 1,
        taskId: "bd-12",
        url: "https://proof.example.com/uploads/bd-12",
      }),
    );
    enqueue(fixture);

    // The proof gate accepts the same workspace on the strength of the receipt
    // alone: no artifact refs, no files in the tree.
    const proof = await gateProofContent(
      "Proof uploaded; nothing committed.\n",
      {
        messages: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
          toolCalls: 0,
        },
        exitCode: 0,
      },
      { cwd: fixture.memberPath, proofDir: join(tmpdir(), "belayd-external-proof", "bd-12") },
    );
    expect(proof).toHaveProperty("passed", true);
    expect(proof.feedback).toContain(
      "Proof receipt accepted: https://proof.example.com/uploads/bd-12",
    );

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", true);
    // The receipt itself was never carried: the merged root has no receipt file,
    // and the successful drain removed the member worktree (bd-168 #3).
    expect(existsSync(join(fixture.root, ".belayd", "proof-receipt.json"))).toBe(false);
    expect(existsSync(fixture.memberPath)).toBe(false);
  });

  it("refuses a payload that commits the receipt file itself", async () => {
    const fixture = createFixtureRepo();
    // No `.gitignore` in the fixture root, so `git add -A` commits the receipt:
    // bypassing the ignore rule must still be refused, not published.
    mkdirSync(join(fixture.memberPath, ".belayd"), { recursive: true });
    writeFileSync(
      join(fixture.memberPath, ".belayd", "proof-receipt.json"),
      serializeProofReceipt({ version: 1, taskId: "bd-12", id: "upload-42" }),
    );
    commit(fixture.memberPath, "commit the receipt");
    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("paths-outside-scope");
    expect(result.paths).toStrictEqual([".belayd/proof-receipt.json"]);
    expect(result.text).toContain(".belayd/proof-receipt.json");
  });

  it("carries every refused path in `paths` while keeping `text` to one line", async () => {
    const fixture = createFixtureRepo();
    mkdirSync(join(fixture.memberPath, "docs", "proof", "bd-12"), { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(join(fixture.memberPath, "docs", "proof", "bd-12", `shot-${index}.png`), "png");
    }
    commit(fixture.memberPath, "commit many proof artifacts");
    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    // `text` stays a single readable line and points at the full data.
    expect(result.text.split("\n")).toHaveLength(1);
    expect(result.text).toContain("(+2 more — the full list is in `paths`)");
    // `paths` is complete, sorted, and rendered by the report helper.
    expect(result.paths).toHaveLength(12);
    expect(result.paths).toStrictEqual(
      [...(result.paths ?? [])].sort((left, right) => (left < right ? -1 : 1)),
    );
    const report = formatDrainResultText(result);
    expect(report).toContain("Refused paths (12):");
    expect(report).toContain("- docs/proof/bd-12/shot-0.png");
    expect(report).toContain("- docs/proof/bd-12/shot-11.png");
  });

  it("merges a branch that deletes a legacy proof artifact (the migration direction)", async () => {
    const fixture = createFixtureRepo();
    // Legacy in-tree proof has to land on the base first: `base...branch` diffs
    // the merge-base, so a deletion is only visible when the base already holds
    // the file. Rebasing the member onto that commit makes the removal part of
    // the payload rather than a stale base difference.
    mkdirSync(join(fixture.root, "docs", "proof", "bd-12"), { recursive: true });
    writeFileSync(join(fixture.root, "docs", "proof", "bd-12", "shot.png"), "legacy png");
    commit(fixture.root, "legacy in-tree proof on base");
    git(fixture.memberPath, ["rebase", "-q", "main"]);
    git(fixture.memberPath, ["rm", "-q", "-r", "docs/proof"]);
    commit(fixture.memberPath, "upload proof, delete the in-tree artifact");

    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    // Removing proof is the sanctioned migration, not a publish payload: the
    // guard refuses proof carried *in*, never proof taken out.
    expect(result).toHaveProperty("ok", true);
    expect(result).not.toHaveProperty("paths");
    expect(existsSync(join(fixture.root, "docs", "proof", "bd-12", "shot.png"))).toBe(false);
  });

  it("still refuses a branch that deletes one proof artifact and adds another", async () => {
    const fixture = createFixtureRepo();
    mkdirSync(join(fixture.root, "docs", "proof", "bd-12"), { recursive: true });
    writeFileSync(join(fixture.root, "docs", "proof", "bd-12", "old.png"), "old legacy png");
    commit(fixture.root, "legacy in-tree proof on base");
    git(fixture.memberPath, ["rebase", "-q", "main"]);
    git(fixture.memberPath, ["rm", "-q", "docs/proof/bd-12/old.png"]);
    mkdirSync(join(fixture.memberPath, "docs", "proof", "bd-12"), { recursive: true });
    writeFileSync(join(fixture.memberPath, "docs", "proof", "bd-12", "new.png"), "brand new png");
    commit(fixture.memberPath, "delete one proof file, carry in another");

    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    // Only the carried-in path is named; the deletion is not an offence.
    expect(result.paths).toStrictEqual(["docs/proof/bd-12/new.png"]);
    expect(result.text).toContain("docs/proof/bd-12/new.png");
    expect(result.text).not.toContain("docs/proof/bd-12/old.png");
  });

  it("refuses a proof artifact renamed out of the proof directory", async () => {
    const fixture = createFixtureRepo();
    mkdirSync(join(fixture.root, "docs", "proof", "bd-12"), { recursive: true });
    writeFileSync(join(fixture.root, "docs", "proof", "bd-12", "shot.png"), "renamable png");
    commit(fixture.root, "legacy in-tree proof on base");
    git(fixture.memberPath, ["rebase", "-q", "main"]);
    mkdirSync(join(fixture.memberPath, "assets"), { recursive: true });
    // A rename is reported as `R` and `--name-only` emits only the destination,
    // so the delete half never reaches the gate: the destination path carries
    // the proof extension and is what trips `proof-artifacts-in-diff`. (If git
    // ever reported this fixture as delete+add instead, the add is likewise the
    // path that trips it.)
    git(fixture.memberPath, ["mv", "docs/proof/bd-12/shot.png", "assets/shot.png"]);
    commit(fixture.memberPath, "move proof artifact into a source path");

    enqueue(fixture);

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    expect(result.paths).toStrictEqual(["assets/shot.png"]);
  });

  it("formatDrainResultText leaves a result without paths untouched", () => {
    expect(
      formatDrainResultText({
        ok: false,
        reason: "merge-failed",
        text: "merge of feat/bd-12 into main failed",
        parked: false,
        warnings: [],
      }),
    ).toBe("merge of feat/bd-12 into main failed");
  });
});

describe("drainFleetMerge: repo proof policy (bd-276)", () => {
  /** Put a proof-carrying branch in the member worktree and declare the policy on base. */
  function fixtureWithProof(options: { policy: string }): FixtureRepo {
    const fixture = createFixtureRepo();
    mkdirSync(join(fixture.root, ".belayd"), { recursive: true });
    writeFileSync(
      join(fixture.root, ".belayd", "config.json"),
      JSON.stringify({ proof: { artifacts: options.policy } }),
    );
    commit(fixture.root, "declare the repo proof policy");

    mkdirSync(join(fixture.memberPath, "docs", "proof", "bd-12"), { recursive: true });
    writeFileSync(join(fixture.memberPath, "docs", "proof", "bd-12", "README.md"), "evidence\n");
    writeFileSync(join(fixture.memberPath, "docs", "proof", "bd-12", "run.cast"), "cast\n");
    commit(fixture.memberPath, "commit the bead's text evidence");
    enqueue(fixture);
    return fixture;
  }

  it("lands a proof-carrying branch when the repo declares proof.artifacts=in-tree", async () => {
    const fixture = fixtureWithProof({ policy: "in-tree" });

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    // Carrying proof past the gate is a policy decision, so it is reported on the
    // landing instead of happening silently.
    expect(result.warnings).toContain(
      "carried 2 proof artifact path(s) under the repo policy proof.artifacts=in-tree: " +
        "docs/proof/bd-12/README.md, docs/proof/bd-12/run.cast",
    );
    expect(git(fixture.root, ["show", "--name-only", "--pretty=format:", "HEAD"])).toContain(
      "docs/proof/bd-12/README.md",
    );
  });

  it("still refuses when the declaration itself is unusable", async () => {
    const fixture = fixtureWithProof({ policy: "in-git" });

    const result = await drain(fixture, { runGate: gateSpy().runGate });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    expect(result.warnings.some((warning) => warning.includes("invalid proof policy"))).toBe(true);
    expect(readQueue(fixture).entries.find((entry) => entry.taskId === "bd-12")?.state).toBe(
      "queued",
    );
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
