/**
 * Tests for the bd human gate seam (bd-152).
 *
 * Two failure modes are load-bearing here: reading a gate with an argv that
 * would write, and confusing the gate's id with the bead it blocks (resolving
 * the wrong one closes the work item instead of the wait).
 */

import { describe, expect, it, vi } from "vitest";

import { BD_GATE_READ_SUBCOMMANDS, isBdReadArgv, isBdReadSubcommand } from "../bd-command.js";
import { BEAD_READ_TIMEOUT_MS } from "../bead-comments.js";
import {
  buildGateCreateArgv,
  buildGateListAllArgv,
  buildGateListArgv,
  buildGateResolveArgv,
  humanGateResolveNote,
  lookupOpenHumanGate,
  lookupResolvedHumanGate,
  parseCreatedGateId,
  parseOpenHumanGate,
  parseResolvedHumanGate,
} from "../bead-gates.js";
import type { FleetBeadRunner } from "../fleet-beads.js";

function recorder(stdout = "[]"): {
  runBd: FleetBeadRunner;
  calls: Array<{ argv: readonly string[]; options: unknown }>;
} {
  const calls: Array<{ argv: readonly string[]; options: unknown }> = [];
  const runBd: FleetBeadRunner = async (argv, options) => {
    calls.push({ argv, options });
    return { stdout };
  };
  return { runBd, calls };
}

const openHumanGate = {
  id: "bd-159",
  title: "Gate: human",
  status: "open",
  issue_type: "gate",
  await_type: "human",
  created_at: "2026-10-26T20:14:26Z",
};

/** A gate Scotty closed: the decision line, then the person's own note. */
const APPROVED_CLOSE_REASON =
  "Approved by hugo via Scotty at 2026-11-01T09:52:05.582Z\n\nRetry proof";

const resolvedHumanGate = {
  ...openHumanGate,
  status: "closed",
  close_reason: APPROVED_CLOSE_REASON,
};

describe("gate argv builders", () => {
  it("creates a human gate that blocks the bead", () => {
    expect(buildGateCreateArgv({ beadId: "bd-152", reason: "which option?" })).toEqual([
      "gate",
      "create",
      "--blocks",
      "bd-152",
      "--type=human",
      "--reason",
      "which option?",
    ]);
  });

  it("lists the gates of one bead as JSON and resolves by gate id", () => {
    expect(buildGateListArgv("bd-152")).toEqual(["gate", "list", "bd-152", "--json"]);
    expect(buildGateResolveArgv("bd-159")).toEqual(["gate", "resolve", "bd-159"]);
  });

  it("reads closed gates only through a read-only --all list", () => {
    expect(buildGateListAllArgv("bd-152")).toEqual(["gate", "list", "bd-152", "--all", "--json"]);
    expect(isBdReadArgv(buildGateListAllArgv("bd-152"))).toBe(true);
  });
});

describe("isBdReadArgv", () => {
  it("accepts the gate reads and keeps isBdReadSubcommand unchanged", () => {
    expect(BD_GATE_READ_SUBCOMMANDS).toEqual(["list", "show"]);
    expect(isBdReadArgv(["gate", "list", "bd-152", "--json"])).toBe(true);
    expect(isBdReadArgv(["gate", "show", "bd-159", "--json"])).toBe(true);
    // The actor is injected at index 1, so the child must still be found.
    expect(isBdReadArgv(["gate", "--actor", "belayd:x", "list", "bd-152", "--json"])).toBe(true);
    expect(isBdReadSubcommand("gate")).toBe(false);
  });

  it("refuses the gate lifecycle and unknown gate children", () => {
    expect(isBdReadArgv(["gate", "create", "--blocks", "bd-152"])).toBe(false);
    expect(isBdReadArgv(["gate", "resolve", "bd-159"])).toBe(false);
    expect(isBdReadArgv(["gate", "--actor", "belayd:x", "resolve", "bd-159"])).toBe(false);
    expect(isBdReadArgv(["gate"])).toBe(false);
    for (const read of ["comments", "show", "list"]) {
      expect(isBdReadArgv([read, "bd-152"])).toBe(true);
    }
  });
});

describe("parseOpenHumanGate", () => {
  it("picks the open human gate and carries its creation time", () => {
    expect(parseOpenHumanGate([openHumanGate], "bd-152")).toEqual({
      gateId: "bd-159",
      createdAt: "2026-10-26T20:14:26Z",
    });
  });

  it("handles null, a single object, and a closed gate", () => {
    expect(parseOpenHumanGate(null, "bd-152")).toBeUndefined();
    expect(parseOpenHumanGate(openHumanGate, "bd-152")).toEqual({
      gateId: "bd-159",
      createdAt: "2026-10-26T20:14:26Z",
    });
    expect(parseOpenHumanGate([{ ...openHumanGate, status: "closed" }], "bd-152")).toBeUndefined();
  });

  it("never treats a non-human gate as a human wait", () => {
    expect(
      parseOpenHumanGate([{ ...openHumanGate, await_type: "timer" }], "bd-152"),
    ).toBeUndefined();
    expect(
      parseOpenHumanGate([{ ...openHumanGate, await_type: undefined }], "bd-152"),
    ).toBeUndefined();
  });

  it("never returns the blocked bead id as a gate id", () => {
    expect(parseOpenHumanGate([openHumanGate], "bd-159")).toBeUndefined();
  });
});

describe("parseCreatedGateId", () => {
  it("reads the id from bd gate create --json", () => {
    const stdout = JSON.stringify({ id: "bd-159", issue_type: "gate", status: "open" });
    expect(parseCreatedGateId(stdout, "bd-152")).toBe("bd-159");
  });

  it("falls back to the text form and skips the blocked bead id", () => {
    const stdout = [
      "✓ Created gate bd-159 (type: human)",
      "  Blocks: bd-152 (probe)",
      "",
      "Resolve with: bd gate resolve bd-159",
    ].join("\n");

    expect(parseCreatedGateId(stdout, "bd-152")).toBe("bd-159");
  });

  it("returns undefined when there is nothing to read", () => {
    expect(parseCreatedGateId("", "bd-152")).toBeUndefined();
    expect(parseCreatedGateId("Blocks: bd-152 only", "bd-152")).toBeUndefined();
  });
});

describe("lookupOpenHumanGate", () => {
  it("runs one bounded read-only gate list", async () => {
    const { runBd, calls } = recorder(JSON.stringify([openHumanGate]));

    const result = await lookupOpenHumanGate({ beadId: "bd-152", cwd: "/repo", runBd });

    expect(result).toEqual({
      ok: true,
      status: "open",
      gate: { gateId: "bd-159", createdAt: "2026-10-26T20:14:26Z" },
    });
    expect(calls[0]?.argv).toEqual(["gate", "list", "bd-152", "--json"]);
    expect(calls[0]?.options).toMatchObject({ cwd: "/repo", timeoutInMs: BEAD_READ_TIMEOUT_MS });
  });

  it("reports “none” — a real resolution — for null and an empty list", async () => {
    for (const stdout of ["null", "[]"]) {
      const { runBd } = recorder(stdout);
      expect(await lookupOpenHumanGate({ beadId: "bd-152", cwd: "/repo", runBd })).toEqual({
        ok: true,
        status: "none",
      });
    }
  });

  it("reports “unrecognized” — never a resolution — when records do not parse", async () => {
    // A renamed/absent status or await_type, a timer gate, or a malformed record
    // must not read as "the human resolved it" (bd-152 review, fail closed).
    const shapes = [
      [{ ...openHumanGate, status: undefined }],
      [{ ...openHumanGate, await_type: undefined }],
      [{ ...openHumanGate, await_type: "timer" }],
      [{ id: "bd-159" }],
      [null, { nope: true }],
    ];
    for (const shape of shapes) {
      const { runBd } = recorder(JSON.stringify(shape));
      expect(await lookupOpenHumanGate({ beadId: "bd-152", cwd: "/repo", runBd })).toEqual({
        ok: true,
        status: "unrecognized",
      });
    }
  });

  it("refuses a gate write and a gate create argv without spawning bd", async () => {
    const resolve = vi.fn<FleetBeadRunner>();
    const refusedResolve = await lookupOpenHumanGate({
      beadId: "bd-152",
      cwd: "/repo",
      runBd: resolve,
      buildArgv: () => ["gate", "resolve", "bd-159"],
    });
    expect(refusedResolve).toHaveProperty("ok", false);
    expect(resolve).not.toHaveBeenCalled();

    const create = vi.fn<FleetBeadRunner>();
    const refusedCreate = await lookupOpenHumanGate({
      beadId: "bd-152",
      cwd: "/repo",
      runBd: create,
      buildArgv: () => ["gate", "create", "--blocks", "bd-152"],
    });
    expect(refusedCreate).toHaveProperty("ok", false);
    expect(create).not.toHaveBeenCalled();
  });

  it("degrades to an error value when bd is absent or slow", async () => {
    const failing: FleetBeadRunner = async () => {
      throw new Error("spawn bd ENOENT");
    };
    const failed = await lookupOpenHumanGate({ beadId: "bd-152", cwd: "/repo", runBd: failing });
    expect(failed).toHaveProperty("ok", false);
    if (failed.ok) return;
    expect(failed.error).toContain("ENOENT");
  });
});

describe("humanGateResolveNote", () => {
  it("keeps the person's text and drops the closing tool's decision line", () => {
    expect(humanGateResolveNote(APPROVED_CLOSE_REASON)).toBe("Retry proof");
    // Wrapped notes survive verbatim; flattening happens at delivery.
    expect(
      humanGateResolveNote("Resolved by hand at 2026-11-01T09:52:05Z\n\noption b\nkeep the shim"),
    ).toBe("option b\nkeep the shim");
  });

  it("reports no note when the reason is only bookkeeping", () => {
    expect(humanGateResolveNote(undefined)).toBeUndefined();
    expect(humanGateResolveNote("")).toBeUndefined();
    expect(
      humanGateResolveNote("Approved by hugo via Scotty at 2026-11-01T09:52:05.582Z"),
    ).toBeUndefined();
    expect(
      humanGateResolveNote("Approved by hugo via Scotty at 2026-11-01T09:52:05.582Z\n\n   \n"),
    ).toBeUndefined();
    expect(humanGateResolveNote(42)).toBeUndefined();
  });

  it("keeps an unrecognized reason whole rather than guessing", () => {
    // Fail open on the *note*: a stray bookkeeping line beats a swallowed answer.
    expect(humanGateResolveNote("closed by the fleet rollup")).toBe("closed by the fleet rollup");
    expect(humanGateResolveNote("Approved by hugo via Scotty\n\nRetry proof")).toBe(
      "Approved by hugo via Scotty\n\nRetry proof",
    );
  });
});

describe("parseResolvedHumanGate", () => {
  it("returns the closed human gate with its note", () => {
    expect(parseResolvedHumanGate([resolvedHumanGate], "bd-152")).toEqual({
      gateId: "bd-159",
      closeReason: APPROVED_CLOSE_REASON,
      note: "Retry proof",
    });
  });

  it("returns a closed gate even when it carries no note", () => {
    const bare = { ...openHumanGate, status: "closed" };
    expect(parseResolvedHumanGate([bare], "bd-152")).toEqual({ gateId: "bd-159" });
  });

  it("ignores an open gate, a non-human await type, and an unparsable record", () => {
    expect(parseResolvedHumanGate([openHumanGate], "bd-152")).toBeUndefined();
    expect(
      parseResolvedHumanGate([{ ...resolvedHumanGate, await_type: "timer" }], "bd-152"),
    ).toBeUndefined();
    expect(parseResolvedHumanGate([{ id: "bd-159" }], "bd-152")).toBeUndefined();
    expect(parseResolvedHumanGate(null, "bd-152")).toBeUndefined();
  });

  it("ignores a fleet ordering gate and the work bead's own id", () => {
    const ordering = {
      ...resolvedHumanGate,
      title: "belayd-fleet-ordering: fleet:default bd-179 -> bd-152",
      description:
        "Ad-hoc gate blocking bd-152\n\nReason: belayd-fleet-ordering: fleet:default bd-179 -> bd-152: bd-179 must land first",
    };
    expect(parseResolvedHumanGate([ordering], "bd-152")).toBeUndefined();
    expect(parseResolvedHumanGate([resolvedHumanGate], "bd-159")).toBeUndefined();
  });

  it("ignores a different gate when the wait knows its own id", () => {
    expect(parseResolvedHumanGate([resolvedHumanGate], "bd-152", "bd-159")).toHaveProperty(
      "gateId",
      "bd-159",
    );
    expect(parseResolvedHumanGate([resolvedHumanGate], "bd-152", "bd-160")).toBeUndefined();
  });
});

describe("lookupResolvedHumanGate", () => {
  it("runs one bounded read-only --all list", async () => {
    const { runBd, calls } = recorder(JSON.stringify([resolvedHumanGate]));

    const result = await lookupResolvedHumanGate({ beadId: "bd-152", cwd: "/repo", runBd });

    expect(result).toEqual({
      ok: true,
      status: "closed",
      gate: { gateId: "bd-159", closeReason: APPROVED_CLOSE_REASON, note: "Retry proof" },
    });
    expect(calls[0]?.argv).toEqual(["gate", "list", "bd-152", "--all", "--json"]);
    expect(calls[0]?.options).toMatchObject({ cwd: "/repo", timeoutInMs: BEAD_READ_TIMEOUT_MS });
  });

  it("reports “none” for no gates, an open gate, or a closed non-human gate", async () => {
    for (const raw of [
      [],
      null,
      [openHumanGate],
      [{ ...resolvedHumanGate, await_type: "gh:pr" }],
    ]) {
      const { runBd } = recorder(JSON.stringify(raw));
      expect(await lookupResolvedHumanGate({ beadId: "bd-152", cwd: "/repo", runBd })).toEqual({
        ok: true,
        status: "none",
      });
    }
  });

  it("refuses a gate write without spawning bd", async () => {
    const resolve = vi.fn<FleetBeadRunner>();
    const refused = await lookupResolvedHumanGate({
      beadId: "bd-152",
      cwd: "/repo",
      runBd: resolve,
      buildArgv: () => ["gate", "resolve", "bd-159"],
    });
    expect(refused).toHaveProperty("ok", false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("degrades to an error value when bd is absent or slow", async () => {
    const failing: FleetBeadRunner = async () => {
      throw new Error("spawn bd ENOENT");
    };
    const failed = await lookupResolvedHumanGate({
      beadId: "bd-152",
      cwd: "/repo",
      runBd: failing,
    });
    expect(failed).toHaveProperty("ok", false);
    if (failed.ok) return;
    expect(failed.error).toContain("ENOENT");
  });
});
