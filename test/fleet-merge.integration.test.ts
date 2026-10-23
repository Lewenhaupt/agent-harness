/**
 * End-to-end merge drain (bd-126 P2) with the **default** git and gate runners.
 *
 * The unit tests inject a gate spy and a git wrapper; what they cannot show is
 * that the production seams work at all — a real `git` subprocess for every step
 * (rebase, stash, fast-forward, drop) and the project's own script through its
 * package manager. This test exercises those defaults against a throwaway
 * repository, and — the property that matters — proves a full destructive drain
 * changes nothing in the checkout the tests are running from.
 *
 * Nothing here can merge this repository: every repository is a fresh `git init`
 * under the OS temp dir, and the drain refuses any root that is not the fleet
 * record's own checkout (`checkRootCheckout`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drainFleetMerge, enqueueFleetMerge, readFleetMergeQueue } from "../src/index.js";
import { gitContextFreeEnv } from "../src/worktree.js";

function git(argv: readonly string[], cwd: string): string {
  return execFileSync("git", [...argv], {
    cwd,
    env: gitContextFreeEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(cwd: string, message: string): void {
  git(["add", "-A"], cwd);
  git(["commit", "-qm", message], cwd);
}

/**
 * Everything a stray drain could move in a checkout: every ref (not only the
 * base), `refs/stash`, HEAD, the branch, `git status`, and the stash list.
 */
function checkoutFingerprint(root: string): Record<string, string> {
  const refOrNone = (ref: string): string => {
    try {
      return git(["rev-parse", "--verify", ref], root);
    } catch {
      return "<absent>";
    }
  };
  return {
    head: git(["rev-parse", "HEAD"], root),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    status: git(["status", "--porcelain"], root),
    refs: git(["for-each-ref", "--format=%(refname) %(objectname)"], root),
    stash: refOrNone("refs/stash"),
    stashList: git(["stash", "list"], root),
  };
}

interface MergeFixture {
  root: string;
  memberPath: string;
  commonDir: string;
  fleetId: string;
  /** Marker the fixture's `test` script appends to, proving the gate really ran. */
  gateMarker: string;
}

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A fleet-shaped throwaway repository: `main` in the root, one member branch in a
 * sibling linked worktree, and a `test` gate that appends to a marker file when
 * the project's package manager really executes it.
 */
function createFleetRepo(): MergeFixture {
  const base = mkdtempSync(join(tmpdir(), "belayd-fleet-merge-integration-"));
  cleanup.push(base);
  // The member worktree is a sibling of the repository, never inside it: a nested
  // worktree would show up as untracked dirt in the root the drain auto-stashes.
  const root = join(base, "repo");
  const memberPath = join(base, "repo.feat-bd-12");
  const gateMarker = join(base, "gate-ran.txt");
  const fleetId = "default";

  mkdirSync(root, { recursive: true });
  git(["init", "-q"], root);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], root);
  git(["config", "user.email", "fleet-test@example.invalid"], root);
  git(["config", "user.name", "Fleet Test"], root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fleet-merge-fixture",
      packageManager: "npm@10.0.0",
      // The marker path is absolute, so the assertion below proves the script
      // body ran rather than that a command was merely resolved.
      scripts: {
        test: `node -e "require('node:fs').appendFileSync('${gateMarker}','test\\n')"`,
      },
    }),
  );
  writeFileSync(join(root, "base.txt"), "base\n");
  commit(root, "base");

  git(["worktree", "add", "-q", "-b", "feat/bd-12", memberPath], root);
  writeFileSync(join(memberPath, "member.txt"), "member work\n");
  commit(memberPath, "member bd-12");

  const commonDir = join(root, ".git");
  const fleetDir = join(commonDir, "belayd", "fleet", fleetId);
  mkdirSync(fleetDir, { recursive: true });
  writeFileSync(
    join(fleetDir, "fleet.json"),
    JSON.stringify({
      schemaVersion: 1,
      fleetId,
      taskIds: ["bd-12"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
    }),
  );
  return { root, memberPath, commonDir, fleetId, gateMarker };
}

describe("fleet merge drain (integration, real git and real gates)", () => {
  it("fast-forwards the fixture base through the default runners and leaves this checkout untouched", async () => {
    const harnessRoot = git(["rev-parse", "--show-toplevel"], process.cwd());
    const before = checkoutFingerprint(harnessRoot);

    const fixture = createFleetRepo();
    const queued = enqueueFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      taskId: "bd-12",
      branch: "feat/bd-12",
      now: Date.now(),
    });
    expect(queued).toHaveProperty("ok", true);

    const memberTip = git(["rev-parse", "feat/bd-12"], fixture.memberPath);
    const baseHeadBefore = git(["rev-parse", "HEAD"], fixture.root);

    // No `git`, no `runGate`: the production seams run here.
    const result = await drainFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      pid: process.pid,
      rootCwd: fixture.root,
      now: Date.now(),
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.taskId).toBe("bd-12");
    // A real fast-forward, not a no-op: the base moved onto the member tip and
    // the member's file is part of the base tree.
    expect(git(["rev-parse", "HEAD"], fixture.root)).not.toBe(baseHeadBefore);
    expect(git(["rev-parse", "HEAD"], fixture.root)).toBe(memberTip);
    expect(git(["cat-file", "-t", "HEAD:member.txt"], fixture.root)).toBe("blob");
    // The gate list came from the fixture's package.json and really executed.
    expect(result.text).toContain("gates passed on the rebased result: test");
    expect(readFileSync(fixture.gateMarker, "utf8")).toBe("test\n");

    const queue = readFleetMergeQueue({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
    });
    expect(queue).toHaveProperty("ok", true);
    if (!queue.ok) return;
    expect(queue.queue?.lock).toBe(null);
    expect(queue.queue?.entries[0]).toMatchObject({ state: "merged", attempts: 1 });
    // The lock primitive is gone, so the next drain can acquire it.
    expect(
      existsSync(join(fixture.commonDir, "belayd", "fleet", fixture.fleetId, "merge.lock.d")),
    ).toBe(false);

    // The repository the tests run from is byte-identical: no ref moved, no stash
    // appeared, nothing became dirty.
    expect(checkoutFingerprint(harnessRoot)).toEqual(before);
  });

  it("restores a dirty root's own work around the merge, through the default runners", async () => {
    const fixture = createFleetRepo();
    enqueueFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      taskId: "bd-12",
      branch: "feat/bd-12",
      now: Date.now(),
    });
    // The operator has unrelated uncommitted work in the root checkout.
    writeFileSync(join(fixture.root, "base.txt"), "operator work\n");

    const result = await drainFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      pid: process.pid,
      rootCwd: fixture.root,
      now: Date.now(),
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    // The root work was auto-stashed, restored, and dropped — not left behind and
    // not silently committed into the merge.
    expect(result.stashRef).toBeDefined();
    expect(readFileSync(join(fixture.root, "base.txt"), "utf8")).toBe("operator work\n");
    expect(git(["stash", "list"], fixture.root)).toBe("");
    expect(git(["status", "--porcelain"], fixture.root)).toBe("M base.txt");
    // The merge itself still landed.
    expect(git(["cat-file", "-t", "HEAD:member.txt"], fixture.root)).toBe("blob");
  });

  it("refuses a root that belongs to another repository, before touching either one", async () => {
    const fixture = createFleetRepo();
    const other = createFleetRepo();
    enqueueFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      taskId: "bd-12",
      branch: "feat/bd-12",
      now: Date.now(),
    });
    const fixtureBefore = checkoutFingerprint(fixture.root);
    const otherBefore = checkoutFingerprint(other.root);

    // The fleet record belongs to `fixture`; the operator's cwd is `other`.
    const result = await drainFleetMerge({
      gitCommonDir: fixture.commonDir,
      fleetId: fixture.fleetId,
      sessionId: "supervisor-session",
      pid: process.pid,
      rootCwd: other.root,
      now: Date.now(),
      // Injected gates so a refusal cannot execute a script anywhere.
      runGate: async () => {
        throw new Error("gates must not run for a refused drain");
      },
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("root-not-own-checkout");
    expect(checkoutFingerprint(fixture.root)).toEqual(fixtureBefore);
    expect(checkoutFingerprint(other.root)).toEqual(otherBefore);
  });
});
