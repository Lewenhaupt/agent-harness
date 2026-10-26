/**
 * Unit tests for the assignee ownership mirror (bd-150).
 *
 * The mirror is what makes "which agent is driving this bead?" visible, and its
 * whole value depends on the conservative cases: a human's assignment is never
 * clobbered, an already-correct assignment is a no-op, and a lost CAS race is
 * decided by re-reading the bead rather than by an exit code.
 */

import { describe, expect, it } from "vitest";
import type { BeadsAssigneeRunner } from "../beads-assignee.js";
import { clearAssignee, isGuardMismatch, mirrorAssignee } from "../beads-assignee.js";

const ACTOR = "belayd:bd-150:orchestrator";
const HUMAN = "Hugo Lewenhaupt";
/** What bd's CAS guard prints when `--if-assignee` no longer matches. */
const GUARD_MISMATCH = 'assignee mismatch: bd-150 is held by "someone", expected ""';

interface Call {
  argv: readonly string[];
}

/** A scripted `bd` runner: records argv, answers `show` from a queue, fails on request. */
function runner(options: {
  calls: Call[];
  showJson?: string[];
  failUpdate?: boolean;
  /** Fail only the first N writes, as a transient guard race would. */
  failFirstWrites?: number;
  /** The rejection the failed write throws (defaults to a guard mismatch). */
  updateError?: unknown;
  failShow?: boolean;
}): BeadsAssigneeRunner {
  let reads = 0;
  let writes = 0;
  const rejectWrite = (): never => {
    throw options.updateError ?? new Error(GUARD_MISMATCH);
  };
  return async (argv) => {
    options.calls.push({ argv });
    if (argv[0] === "show") {
      if (options.failShow === true) throw new Error("bd unavailable");
      const queue = options.showJson ?? [];
      const answer = queue[Math.min(reads, queue.length - 1)] ?? "";
      reads += 1;
      return { stdout: answer, stderr: "" };
    }
    writes += 1;
    const fails =
      options.updateError !== undefined ||
      options.failUpdate === true ||
      (options.failFirstWrites !== undefined && writes <= options.failFirstWrites);
    if (fails) rejectWrite();
    return { stdout: "", stderr: "" };
  };
}

function showRecord(assignee: string | undefined): string {
  return JSON.stringify([{ id: "bd-150", ...(assignee === undefined ? {} : { assignee }) }]);
}

describe("mirrorAssignee", () => {
  it("claims an unassigned bead with the CAS-guarded argv", async () => {
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord("")] }),
    });

    expect(result).toMatchObject({ ok: true, changed: true, warnings: [] });
    expect(calls.map((call) => [...call.argv])).toEqual([
      ["show", "bd-150", "--json"],
      ["update", "--actor", ACTOR, "--if-assignee", "", "--assignee", ACTOR, "--", "bd-150"],
    ]);
  });

  it("is a no-op when the bead already carries our actor", async () => {
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord(ACTOR)] }),
    });

    expect(result).toMatchObject({ ok: true, changed: false, warnings: [] });
    expect(calls.map((call) => call.argv[0])).toEqual(["show"]);
  });

  it("leaves a human assignment untouched and reports it", async () => {
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord(HUMAN)] }),
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.changed : true).toBe(false);
    expect(result.ok ? result.warnings.join("\n") : "").toContain(HUMAN);
    expect(calls.map((call) => call.argv[0])).toEqual(["show"]);
  });

  it("treats a failed write as success when the re-read shows our actor won", async () => {
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord(""), showRecord(ACTOR)], failUpdate: true }),
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update", "show"]);
  });

  it("reports a lost race to another writer as a warning, not a failure", async () => {
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord(""), showRecord(HUMAN)], failUpdate: true }),
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.warnings.join("\n") : "").toContain(HUMAN);
  });

  it("fails when the write failed and the bead is still unassigned", async () => {
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({ calls: [], showJson: [showRecord("")], failUpdate: true }),
    });

    expect(result.ok).toBe(false);
  });

  it("retries the CAS claim once when a lost guard left the bead unassigned", async () => {
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({
        calls,
        showJson: [showRecord(undefined), showRecord(undefined)],
        failFirstWrites: 1,
      }),
    });

    expect(result).toMatchObject({ ok: true, changed: true, warnings: [] });
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update", "show", "update"]);
  });

  it("reports a guard that keeps losing with a clear error", async () => {
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord(undefined)], failUpdate: true }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("guard kept losing");
    // The last write's rejection is surfaced so the failure stays diagnosable.
    expect(result.ok ? "" : result.error).toContain("assignee mismatch");
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update", "show", "update", "show"]);
  });

  it("reports a genuine write failure without retrying", async () => {
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({
        calls,
        showJson: [showRecord(undefined)],
        updateError: Object.assign(new Error("disk I/O error"), { code: 1 }),
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("disk I/O error");
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update"]);
  });

  it("fails without writing when the bead cannot be read", async () => {
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({ calls, failShow: true }),
    });

    expect(result.ok).toBe(false);
    expect(calls.map((call) => call.argv[0])).toEqual(["show"]);
  });

  it("fails when the re-read after a lost guard cannot be read", async () => {
    // The guard's outcome is unknowable without the re-read, so this must be a
    // failure rather than a silent success.
    const calls: Call[] = [];
    let reads = 0;
    const runBd: BeadsAssigneeRunner = async (argv) => {
      calls.push({ argv });
      if (argv[0] === "show") {
        reads += 1;
        if (reads === 1) return { stdout: showRecord(undefined), stderr: "" };
        throw new Error("bd unavailable");
      }
      throw new Error(GUARD_MISMATCH);
    };

    const result = await mirrorAssignee({ taskId: "bd-150", actor: ACTOR, cwd: "/repo", runBd });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("re-reading bd-150 after a lost guard failed");
    expect(result.ok ? "" : result.error).toContain("bd unavailable");
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update", "show"]);
  });

  it("reports a real failure on the retry without a third read", async () => {
    const calls: Call[] = [];
    let reads = 0;
    let writes = 0;
    const runBd: BeadsAssigneeRunner = async (argv) => {
      calls.push({ argv });
      if (argv[0] === "show") {
        reads += 1;
        return { stdout: showRecord(undefined), stderr: "" };
      }
      writes += 1;
      if (writes === 1) throw new Error(GUARD_MISMATCH);
      throw Object.assign(new Error("disk I/O error"), { code: 1 });
    };

    const result = await mirrorAssignee({ taskId: "bd-150", actor: ACTOR, cwd: "/repo", runBd });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("disk I/O error");
    expect(reads).toBe(2);
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update", "show", "update"]);
  });

  it("accepts the claim when the retry lost its guard but our actor is recorded", async () => {
    // The retry's guard can lose to our own earlier write landing late; the
    // recorded assignee decides, so this stays a success.
    const calls: Call[] = [];
    const result = await mirrorAssignee({
      taskId: "bd-150",
      actor: ACTOR,
      cwd: "/repo",
      runBd: runner({
        calls,
        showJson: [showRecord(undefined), showRecord(undefined), showRecord(ACTOR)],
        failUpdate: true,
      }),
    });

    expect(result).toMatchObject({ ok: true, changed: true, warnings: [] });
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update", "show", "update", "show"]);
  });
});

describe("clearAssignee", () => {
  it("clears a harness actor with the holder-guarded argv", async () => {
    const calls: Call[] = [];
    const result = await clearAssignee({
      taskId: "bd-150",
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord(ACTOR)] }),
    });

    expect(result).toMatchObject({ ok: true, changed: true, warnings: [] });
    expect(calls.map((call) => [...call.argv])).toEqual([
      ["show", "bd-150", "--json"],
      ["update", "--actor", ACTOR, "--if-assignee", ACTOR, "--assignee", "", "--", "bd-150"],
    ]);
  });

  it("clears a holder the caller names even without the belayd: prefix", async () => {
    const calls: Call[] = [];
    const result = await clearAssignee({
      taskId: "bd-150",
      holder: "belayd-old-runner",
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord("belayd-old-runner")] }),
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update"]);
  });

  it("leaves a human assignee alone", async () => {
    const calls: Call[] = [];
    const result = await clearAssignee({
      taskId: "bd-150",
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord(HUMAN)] }),
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.changed : true).toBe(false);
    expect(result.ok ? result.warnings.join("\n") : "").toContain(HUMAN);
    expect(calls.map((call) => call.argv[0])).toEqual(["show"]);
  });

  it("is a no-op when the bead is unassigned", async () => {
    const calls: Call[] = [];
    const result = await clearAssignee({
      taskId: "bd-150",
      cwd: "/repo",
      runBd: runner({ calls, showJson: [showRecord(undefined)] }),
    });

    expect(result).toMatchObject({ ok: true, changed: false, warnings: [] });
    expect(calls.map((call) => call.argv[0])).toEqual(["show"]);
  });

  it("treats a failed clear as success when the re-read shows it landed", async () => {
    const result = await clearAssignee({
      taskId: "bd-150",
      cwd: "/repo",
      runBd: runner({
        calls: [],
        showJson: [showRecord(ACTOR), showRecord("")],
        failUpdate: true,
      }),
    });

    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it("fails when the holder is still recorded after a failed clear", async () => {
    const result = await clearAssignee({
      taskId: "bd-150",
      cwd: "/repo",
      runBd: runner({
        calls: [],
        showJson: [showRecord(ACTOR), showRecord(ACTOR)],
        failUpdate: true,
      }),
    });

    expect(result.ok).toBe(false);
  });

  it("reports a re-assignment that beat the clear as a warning, not a failure", async () => {
    const calls: Call[] = [];
    const result = await clearAssignee({
      taskId: "bd-150",
      cwd: "/repo",
      runBd: runner({
        calls,
        showJson: [showRecord(ACTOR), showRecord(HUMAN)],
        updateError: Object.assign(new Error("guard lost"), { code: 13 }),
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.changed : true).toBe(false);
    expect(result.ok ? result.warnings.join("\n") : "").toContain(HUMAN);
  });

  it("reports a genuine clear failure without re-reading", async () => {
    const calls: Call[] = [];
    const result = await clearAssignee({
      taskId: "bd-150",
      cwd: "/repo",
      runBd: runner({
        calls,
        showJson: [showRecord(ACTOR)],
        updateError: Object.assign(new Error("permission denied"), { code: 1 }),
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("permission denied");
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update"]);
  });

  it("fails without writing when the bead cannot be read", async () => {
    const calls: Call[] = [];
    const result = await clearAssignee({
      taskId: "bd-150",
      cwd: "/repo",
      runBd: runner({ calls, failShow: true }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("could not read bd-150");
    expect(calls.map((call) => call.argv[0])).toEqual(["show"]);
  });

  it("fails when the re-read after a lost clear cannot be read", async () => {
    const calls: Call[] = [];
    let reads = 0;
    const runBd: BeadsAssigneeRunner = async (argv) => {
      calls.push({ argv });
      if (argv[0] === "show") {
        reads += 1;
        if (reads === 1) return { stdout: showRecord(ACTOR), stderr: "" };
        throw new Error("bd unavailable");
      }
      throw new Error(GUARD_MISMATCH);
    };

    const result = await clearAssignee({ taskId: "bd-150", cwd: "/repo", runBd });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(
      "clearing bd-150 lost its guard and the re-read failed",
    );
    expect(calls.map((call) => call.argv[0])).toEqual(["show", "update", "show"]);
  });
});

describe("isGuardMismatch", () => {
  it("classifies bd's exit 13 as a lost guard", () => {
    expect(isGuardMismatch(Object.assign(new Error("command failed"), { code: 13 }))).toBe(true);
  });

  it("classifies the assignee-mismatch text as a lost guard", () => {
    expect(isGuardMismatch(new Error(GUARD_MISMATCH))).toBe(true);
    expect(
      isGuardMismatch(Object.assign(new Error("command failed"), { stderr: GUARD_MISMATCH })),
    ).toBe(true);
    // runFileCommand appends stderr to a `Command failed:` message.
    expect(
      isGuardMismatch(new Error(`Command failed: bd update --if-assignee ''\n${GUARD_MISMATCH}`)),
    ).toBe(true);
  });

  it("classifies bd's real two-line guard rejection as a lost guard", () => {
    // Real bd 1.3 output: the guard sentence is never at line start, so this
    // pins the fallback against the format bd actually prints rather than a
    // synthetic anchor-free string.
    const stderr = [
      'Error updating bd-150: assignee mismatch: bd-150 is held by "", expected "zzz"',
      "Error: 1 of 1 issues failed to update",
      '  bd-150: updating issue: assignee mismatch: bd-150 is held by "", expected "zzz"',
    ].join("\n");
    expect(isGuardMismatch(Object.assign(new Error("Command failed: bd update"), { stderr }))).toBe(
      true,
    );
  });

  it("does not treat usage/help text that mentions guard semantics as a lost guard", () => {
    const usage = new Error(
      [
        "Command failed: bd update --if-assignee ''",
        "usage: bd update [flags]",
        "  --if-assignee string   refuse the write on an assignee mismatch (exit 13)",
        "flag provided but not defined: --bogus",
      ].join("\n"),
    );
    expect(isGuardMismatch(Object.assign(usage, { code: 1 }))).toBe(false);
  });

  it("does not classify real failures or non-errors as a lost guard", () => {
    expect(isGuardMismatch(Object.assign(new Error("disk I/O error"), { code: 1 }))).toBe(false);
    expect(isGuardMismatch(new Error("bd: command not found"))).toBe(false);
    expect(isGuardMismatch(new Error("assignee mismatch"))).toBe(false);
    expect(isGuardMismatch(undefined)).toBe(false);
    expect(isGuardMismatch("assignee mismatch")).toBe(false);
  });
});
