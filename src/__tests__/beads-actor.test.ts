/**
 * Unit tests for beads actor identity (bd-150).
 *
 * The actor is what makes `bd history` attribute a write to an agent instead of
 * the operator's git `user.name`, so these cases pin the format, the session
 * shapes that must NOT resolve to an actor, and the argv placement that keeps
 * both `argv[0]` (subcommand guards) and the `--` terminator honest.
 */

import { describe, expect, it } from "vitest";
import {
  clearAssigneeArgv,
  isBelaydActor,
  orchestratorActor,
  parseAssignee,
  phaseActor,
  resolveBdActor,
  setAssigneeArgv,
  withActorArgv,
  withActorForSession,
} from "../beads-actor.js";

describe("actor strings", () => {
  it("names the orchestrator of a task", () => {
    expect(orchestratorActor("bd-150")).toBe("belayd:bd-150:orchestrator");
  });

  it("names a phase of a task", () => {
    expect(phaseActor("bd-150", "review")).toBe("belayd:bd-150:review");
  });

  it("recognizes only harness actors as ours", () => {
    expect(isBelaydActor("belayd:bd-150:orchestrator")).toBe(true);
    expect(isBelaydActor("Hugo Lewenhaupt")).toBe(false);
    expect(isBelaydActor("")).toBe(false);
    expect(isBelaydActor(undefined)).toBe(false);
  });
});

describe("resolveBdActor", () => {
  it("resolves an orchestrator session name", () => {
    expect(resolveBdActor("belayd-bd-150")).toBe("belayd:bd-150:orchestrator");
  });

  it("resolves a subtask orchestrator session name", () => {
    expect(resolveBdActor("belayd-bd-150.2")).toBe("belayd:bd-150.2:orchestrator");
  });

  it("resolves a phase session name", () => {
    expect(resolveBdActor("belayd-bd-150-sub-review-abc123")).toBe("belayd:bd-150:review");
  });

  it("keeps the actor across gate-retry, cross-run and fallback epochs", () => {
    for (const name of [
      "belayd-bd-150-sub-review-abc123-retry-3",
      "belayd-bd-150-sub-review-abc123-run-3",
      "belayd-bd-150-sub-review-abc123-fallback-2",
    ]) {
      expect(resolveBdActor(name), name).toBe("belayd:bd-150:review");
    }
  });

  it("never attributes planning sessions", () => {
    expect(resolveBdActor("belayd-planning-sub-scout-abc123")).toBeUndefined();
  });

  it("never attributes proof-verifier sessions", () => {
    expect(resolveBdActor("belayd-proof-verifier-abc123")).toBeUndefined();
  });

  it("leaves humans and unnamed sessions unattributed", () => {
    expect(resolveBdActor(undefined)).toBeUndefined();
    expect(resolveBdActor("")).toBeUndefined();
    expect(resolveBdActor("orchestrator-session")).toBeUndefined();
    expect(resolveBdActor("belayd-bd-150-extra")).toBeUndefined();
  });
});

describe("withActorArgv", () => {
  it("inserts --actor at index 1 so argv[0] stays the subcommand", () => {
    const argv = withActorArgv(["update", "bd-150", "--add-label", "x"], "belayd:bd-150:review");
    expect(argv).toEqual([
      "update",
      "--actor",
      "belayd:bd-150:review",
      "bd-150",
      "--add-label",
      "x",
    ]);
    expect(argv[0]).toBe("update");
  });

  it("places --actor before any -- terminator", () => {
    const argv = withActorArgv(["update", "--add-label", "x", "--", "bd-150"], "a:b");
    expect(argv).toEqual(["update", "--actor", "a:b", "--add-label", "x", "--", "bd-150"]);
    expect(argv.indexOf("--actor")).toBeLessThan(argv.indexOf("--"));
  });

  it("handles a bare subcommand and an empty argv", () => {
    expect(withActorArgv(["show"], "a:b")).toEqual(["show", "--actor", "a:b"]);
    expect(withActorArgv([], "a:b")).toEqual([]);
  });

  it("attributes argv for a session name and leaves humans untouched", () => {
    expect(withActorForSession(["show", "bd-150"], "belayd-bd-150")).toEqual([
      "show",
      "--actor",
      "belayd:bd-150:orchestrator",
      "bd-150",
    ]);
    expect(withActorForSession(["show", "bd-150"], "human-session")).toEqual(["show", "bd-150"]);
    expect(withActorForSession(["show", "bd-150"], undefined)).toEqual(["show", "bd-150"]);
  });
});

describe("assignee argv", () => {
  it("claims an unassigned bead with a CAS guard and carries the actor", () => {
    expect(setAssigneeArgv({ taskId: "bd-150", actor: "belayd:bd-150:orchestrator" })).toEqual([
      "update",
      "--actor",
      "belayd:bd-150:orchestrator",
      "--if-assignee",
      "",
      "--assignee",
      "belayd:bd-150:orchestrator",
      "--",
      "bd-150",
    ]);
  });

  it("clears only the observed holder and carries its actor", () => {
    expect(clearAssigneeArgv({ taskId: "bd-150", holder: "belayd:bd-150:orchestrator" })).toEqual([
      "update",
      "--actor",
      "belayd:bd-150:orchestrator",
      "--if-assignee",
      "belayd:bd-150:orchestrator",
      "--assignee",
      "",
      "--",
      "bd-150",
    ]);
  });

  it("clears a non-harness holder without claiming its actor", () => {
    // No `--actor` here: the holder is not a workflow actor, so attributing the
    // clear to it would invent an identity for a human or another tool.
    expect(clearAssigneeArgv({ taskId: "bd-150", holder: "Hugo Lewenhaupt" })).toEqual([
      "update",
      "--if-assignee",
      "Hugo Lewenhaupt",
      "--assignee",
      "",
      "--",
      "bd-150",
    ]);
  });
});

describe("parseAssignee", () => {
  it("reads the assignee from an array record", () => {
    expect(
      parseAssignee(JSON.stringify([{ id: "bd-150", assignee: "belayd:bd-150:review" }])),
    ).toBe("belayd:bd-150:review");
  });

  it("reads the assignee from a single record", () => {
    expect(parseAssignee(JSON.stringify({ assignee: "Hugo Lewenhaupt" }))).toBe("Hugo Lewenhaupt");
  });

  it("treats an unassigned bead as undefined", () => {
    expect(parseAssignee(JSON.stringify([{ id: "bd-150", assignee: "" }]))).toBeUndefined();
    expect(parseAssignee(JSON.stringify([{ id: "bd-150" }]))).toBeUndefined();
    expect(parseAssignee(JSON.stringify([]))).toBeUndefined();
  });

  it("is total for malformed and non-record input", () => {
    expect(parseAssignee("")).toBeUndefined();
    expect(parseAssignee("not json")).toBeUndefined();
    expect(parseAssignee("null")).toBeUndefined();
    expect(parseAssignee(JSON.stringify(["bd-150"]))).toBeUndefined();
    expect(parseAssignee(JSON.stringify([{ assignee: 42 }]))).toBeUndefined();
  });
});
