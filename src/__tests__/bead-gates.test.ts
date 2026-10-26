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
  buildGateListArgv,
  buildGateResolveArgv,
  lookupOpenHumanGate,
  parseCreatedGateId,
  parseOpenHumanGate,
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
