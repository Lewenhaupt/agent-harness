/**
 * Unit tests for accepting a landed member (bd-126 P5).
 *
 * Accepting is what lets a run continue without a human: close the bead (so bd
 * stops reporting the blocking edge) and remove the merged worktree. Both effects
 * are conservative, and these cases pin the conservatism: a dirty worktree is left
 * alone, an unmerged branch is never deleted, and an already-closed bead is not a
 * failure.
 */

import { describe, expect, it } from "vitest";
import type { AcceptLandedMemberOptions } from "../fleet-accept.js";
import { acceptLandedMember } from "../fleet-accept.js";

interface Call {
  argv: readonly string[];
}

/** A runner that records argv and fails for the commands a test names. */
function runner(options: {
  calls: Call[];
  failWhen?: (argv: readonly string[]) => string | undefined;
  stdout?: (argv: readonly string[]) => string;
}) {
  return async (argv: readonly string[]) => {
    options.calls.push({ argv });
    const failure = options.failWhen?.(argv);
    if (failure !== undefined) throw new Error(failure);
    return { stdout: options.stdout?.(argv) ?? "", stderr: "" };
  };
}

function baseOptions(
  overrides: Partial<AcceptLandedMemberOptions> & {
    calls: Call[];
    bdCalls: Call[];
    gitFail?: (argv: readonly string[]) => string | undefined;
    bdFail?: (argv: readonly string[]) => string | undefined;
    bdStdout?: (argv: readonly string[]) => string;
  },
): AcceptLandedMemberOptions {
  return {
    rootCwd: "/repo",
    taskId: "bd-12",
    branch: "feat/bd-12",
    worktreePath: "/repo.feat-bd-12",
    baseBranch: "main",
    closeBead: true,
    removeWorktree: true,
    now: 1_000,
    git: runner({
      calls: overrides.calls,
      ...(overrides.gitFail === undefined ? {} : { failWhen: overrides.gitFail }),
    }),
    runBd: runner({
      calls: overrides.bdCalls,
      ...(overrides.bdFail === undefined ? {} : { failWhen: overrides.bdFail }),
      ...(overrides.bdStdout === undefined ? {} : { stdout: overrides.bdStdout }),
    }),
    ...overrides,
  };
}

describe("acceptLandedMember", () => {
  it("closes the bead, removes the worktree and deletes the merged branch", async () => {
    const calls: Call[] = [];
    const bdCalls: Call[] = [];

    const result = await acceptLandedMember(baseOptions({ calls, bdCalls }));

    expect(result).toMatchObject({ ok: true, beadClosed: true, worktreeRemoved: true });
    expect(bdCalls.map((call) => [...call.argv])).toEqual([
      ["close", "bd-12", "--reason", "merged into main via belayd_fleet_merge"],
    ]);
    expect(calls.map((call) => [...call.argv])).toEqual([
      ["worktree", "remove", "/repo.feat-bd-12"],
      ["branch", "-d", "feat/bd-12"],
    ]);
  });

  it("leaves the bead alone when acceptance is disabled", async () => {
    const calls: Call[] = [];
    const bdCalls: Call[] = [];

    const result = await acceptLandedMember(baseOptions({ calls, bdCalls, closeBead: false }));

    expect(result).toMatchObject({ ok: true, beadClosed: false });
    expect(bdCalls).toEqual([]);
    expect(result.ok ? result.warnings : []).toEqual([]);
  });

  it("treats an already-closed bead as accepted", async () => {
    const calls: Call[] = [];
    const bdCalls: Call[] = [];
    const result = await acceptLandedMember(
      baseOptions({
        calls,
        bdCalls,
        bdFail: (argv) => (argv[0] === "close" ? "already closed" : undefined),
        bdStdout: () => JSON.stringify([{ id: "bd-12", status: "closed" }]),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.ok ? result.warnings[0] : "").toContain("already closed");
  });

  it("fails when the bead cannot be closed and is still open", async () => {
    const calls: Call[] = [];
    const bdCalls: Call[] = [];
    const result = await acceptLandedMember(
      baseOptions({
        calls,
        bdCalls,
        bdFail: (argv) => (argv[0] === "close" ? "db locked" : undefined),
        bdStdout: () => JSON.stringify([{ id: "bd-12", status: "in_progress" }]),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "bead-close-failed" });
    // The worktree is untouched: nothing about a failed accept is destructive.
    expect(calls).toEqual([]);
  });

  it("keeps a dirty worktree in place and reports it, without failing the accept", async () => {
    const calls: Call[] = [];
    const bdCalls: Call[] = [];
    const result = await acceptLandedMember(
      baseOptions({
        calls,
        bdCalls,
        gitFail: (argv) => (argv[0] === "worktree" ? "contains modified files" : undefined),
      }),
    );
    expect(result).toMatchObject({ ok: true, worktreeRemoved: false });
    expect(result.ok ? result.warnings.join("\n") : "").toContain("contains modified files");
    expect(calls.map((call) => call.argv[0])).toEqual(["worktree"]);
  });

  it("never force-deletes a branch that git refuses to delete", async () => {
    const calls: Call[] = [];
    const bdCalls: Call[] = [];
    const result = await acceptLandedMember(
      baseOptions({
        calls,
        bdCalls,
        gitFail: (argv) => (argv[0] === "branch" ? "not fully merged" : undefined),
      }),
    );
    expect(result).toMatchObject({ ok: true, worktreeRemoved: true });
    expect(result.ok ? result.warnings.join("\n") : "").toContain("not fully merged");
    const usedForce = calls.some(
      (call) => call.argv.includes("-D") || call.argv.includes("--force"),
    );
    expect(usedForce).toBe(false);
  });

  it("refuses to accept the repository's own checkout", async () => {
    const calls: Call[] = [];
    const bdCalls: Call[] = [];
    const result = await acceptLandedMember(baseOptions({ calls, bdCalls, worktreePath: "/repo" }));
    expect(result).toMatchObject({ ok: false, reason: "worktree-refused" });
    expect(calls).toEqual([]);
    expect(bdCalls).toEqual([]);
  });
});
