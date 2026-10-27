/**
 * Tests for the `belayd_fleet_status` pi tool surface in extensions/index.ts.
 *
 * `readFleetStatus` is replaced by a recorder so the assertions cover the
 * extension's own contract — fleet-id defaulting/trimming, result rendering,
 * error exit code, and gate membership — without shelling out to git.
 * `node:child_process` is mocked so gate activation's `bd` calls are inert.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFleetStatus } from "../fleet-status.js";
import type { WorkflowState } from "../workflow-state.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

const fleet = vi.hoisted(() => ({
  calls: [] as Array<{ cwd: string; fleetId: string }>,
  failWith: undefined as string | undefined,
  /** When set, the fleet reader returns this pre-built view instead of an empty one. */
  status: undefined as unknown,
}));

// Records the `bd` lookup the tool issues; `bd show` output is injected per case.
const bd = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: readonly string[] }>,
  stdout: "",
  failWith: undefined as string | undefined,
  /** Per-argv reply, for the `show` + `comments` + `gate list` mix. */
  respond: undefined as ((args: readonly string[]) => string) | undefined,
  /** When it returns true for an argv, that one read fails (per-bead failures). */
  failWhen: undefined as ((args: readonly string[]) => boolean) | undefined,
}));

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return {
    ...actual,
    readFleetStatus: (options: { cwd: string; fleetId: string }) => {
      fleet.calls.push({ cwd: options.cwd, fleetId: options.fleetId });
      if (fleet.failWith !== undefined) return { ok: false as const, error: fleet.failWith };
      if (fleet.status !== undefined) return { ok: true as const, value: fleet.status };
      return {
        ok: true as const,
        value: actual.buildFleetStatus({
          fleetId: options.fleetId,
          intent: undefined,
          members: [],
        }),
      };
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const respond = (
    file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    bd.calls.push({ file, args: [...args] });
    if (bd.failWhen?.(args) === true) {
      callback(
        Object.assign(new Error("bd read failed"), { stdout: "", stderr: "bd read failed" }),
        "",
        "bd read failed",
      );
      return { stdin: undefined };
    }
    if (bd.failWith !== undefined) {
      callback(
        Object.assign(new Error(bd.failWith), { stdout: "", stderr: bd.failWith }),
        "",
        bd.failWith,
      );
      return { stdin: undefined };
    }
    callback(null, bd.respond === undefined ? bd.stdout : bd.respond(args), "");
    return { stdin: undefined };
  };
  return { ...actual, exec: vi.fn(), execFile: vi.fn(respond) };
});

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number };
}

interface RegisteredTool {
  name: string;
  description?: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

interface PiCommand {
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, PiCommand>;
  activeTools: () => string[];
}

function createMockPi(): MockPi {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, PiCommand>();
  let active: string[] = [];
  const api = {
    registerTool: (def: RegisteredTool) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, def: PiCommand) => {
      commands.set(name, def);
    },
    on: () => {},
    sendMessage: () => {},
    getActiveTools: () => active,
    setActiveTools: (list: string[]) => {
      active = list;
    },
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, tools, commands, activeTools: () => active };
}

async function loadFleetExtension(): Promise<MockPi> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const mock = createMockPi();
  register(mock.api);
  return mock;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

/**
 * The only `bd` argvs a status read may issue: `show … --json`,
 * `comments <id> --json`, `gate list <id> --json`.
 *
 * A write subcommand, a bare `gate`, or a missing `--json` fails this.
 */
function isReadOnlyBdArgv(args: readonly string[]): boolean {
  if (args.at(-1) !== "--json") return false;
  switch (args[0]) {
    case "show":
      return args.length >= 3;
    case "comments":
      return args.length === 3;
    case "gate":
      return args[1] === "list" && args.length === 4;
    default:
      return false;
  }
}

function makeCtx(dir: string, sessionId = "fleet-status-session") {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => `belayd-${sessionId}`,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    },
    cwd: dir,
    ui: { notify: () => {} },
  };
}

function sampleWorkflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: 1,
    taskId: "bd-12",
    workflowType: "feature",
    branch: "feat/bd-12",
    originalCwd: "/repo.feat-bd-12",
    phaseOrder: ["plan", "implement"],
    completedPhaseNames: ["plan"],
    startedAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

/** A fleet view, as the real reader would produce it, with one member per task id. */
function memberStatus(taskIds: readonly string[] = ["bd-12"]) {
  return buildFleetStatus({
    fleetId: "default",
    intent: undefined,
    members: taskIds.map((taskId) => ({
      worktreePath: `/repo.feat-${taskId}`,
      isMainWorktree: false,
      branch: `feat/${taskId}`,
      workflow: {
        kind: "ok" as const,
        state: sampleWorkflow({ taskId, branch: `feat/${taskId}` }),
      },
      runs: [],
      lease: { state: "absent" as const },
    })),
  });
}

describe("belayd_fleet_status tool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-status-tool-"));
    fleet.calls = [];
    fleet.failWith = undefined;
    fleet.status = undefined;
    bd.calls = [];
    bd.stdout = "";
    bd.respond = undefined;
    bd.failWith = undefined;
    bd.failWhen = undefined;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("registers a tool that advertises read-only aggregation", async () => {
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");

    expect(tool).toBeDefined();
    expect(tool?.description).toContain("Read-only");
    expect(tool?.description).toContain("no writes, no merges, no spawns");
    expect(tool?.description).toContain("default");
  });

  it("defaults the fleet id and renders the sanitized view", async () => {
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const result = await tool.execute("fleet-1", {}, undefined, undefined, { cwd });

    expect(result.details.exitCode).toBe(0);
    expect(fleet.calls).toEqual([{ cwd, fleetId: "default" }]);
    expect(textOf(result)).toContain("Fleet default");
    expect(textOf(result)).toContain("No fleet members");
  });

  it("trims a supplied fleet id and treats a blank one as the default", async () => {
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    await tool.execute("fleet-2", { fleetId: "  night-shift  " }, undefined, undefined, { cwd });
    await tool.execute("fleet-3", { fleetId: "   " }, undefined, undefined, { cwd });

    expect(fleet.calls).toEqual([
      { cwd, fleetId: "night-shift" },
      { cwd, fleetId: "default" },
    ]);
  });

  it("reports a reader failure as a non-zero exit code with the error text", async () => {
    fleet.failWith = "git rev-parse --git-common-dir failed: not a git repository";
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const result = await tool.execute("fleet-4", {}, undefined, undefined, { cwd });

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("not a git repository");
  });

  it("keeps belayd_fleet_status available while the process gate is active (GATED_TOOLS)", async () => {
    const mock = await loadFleetExtension();
    const startTask = mock.tools.get("belayd_start_task");
    if (startTask === undefined) throw new Error("belayd_start_task was not registered");

    const started = await startTask.execute(
      "gate-1",
      { taskId: "bd-126" },
      undefined,
      undefined,
      makeCtx(cwd, "fleet-gate-session"),
    );

    expect(started.details.exitCode).toBe(0);
    expect(mock.activeTools()).toContain("belayd_status");
    expect(mock.activeTools()).toContain("belayd_fleet_status");
  });

  it("excludes belayd_fleet_status from the planning-mode tool set (PLANNING_GATED_TOOLS)", async () => {
    const mock = await loadFleetExtension();
    const plan = mock.commands.get("plan");
    if (plan === undefined) throw new Error("plan command was not registered");

    await plan.handler("fleet orchestration", makeCtx(cwd, "fleet-plan-session"));

    const active = mock.activeTools();
    expect(active).toContain("belayd_plan_scout");
    expect(active).not.toContain("belayd_fleet_status");
  });

  it("enriches members from one batched read-only bd show", async () => {
    fleet.status = memberStatus();
    bd.stdout = JSON.stringify([
      { id: "bd-12", title: "Fix login", status: "open", priority: 1, labels: ["fleet"] },
    ]);
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const result = await tool.execute("fleet-5", {}, undefined, undefined, { cwd });

    expect(result.details.exitCode).toBe(0);
    expect(textOf(result)).toContain("bead: Fix login (open)");
    // One batched show, then the two read-only engagement reads for the same id.
    expect(bd.calls.map((call) => call.args)).toEqual([
      ["show", "bd-12", "--json"],
      ["comments", "bd-12", "--json"],
      ["gate", "list", "bd-12", "--json"],
    ]);
    const show = bd.calls[0];
    expect(show?.file).toBe("bd");
    // The read-only guard itself is exercised against a non-read argv (and
    // zero spawns) in src/__tests__/fleet-beads.test.ts.
  });

  it("makes no bd call when no member has a task id", async () => {
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const result = await tool.execute("fleet-6", {}, undefined, undefined, { cwd });

    expect(result.details.exitCode).toBe(0);
    expect(bd.calls).toEqual([]);
  });

  it("degrades to no bead metadata when bd fails", async () => {
    fleet.status = memberStatus();
    bd.failWith = "Error: no beads database found";
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const result = await tool.execute("fleet-7", {}, undefined, undefined, { cwd });

    expect(result.details.exitCode).toBe(0);
    const text = textOf(result);
    expect(text).toContain("Member bd-12");
    expect(text).not.toContain("  bead: ");
    expect(text).toContain("bead metadata unavailable");
    expect(text).toContain("no beads database found");
  });

  it("degrades to no bead metadata when bd prints something other than JSON", async () => {
    fleet.status = memberStatus();
    bd.stdout = "Warning: .beads has permissions 0755\nnot json at all";
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const result = await tool.execute("fleet-8", {}, undefined, undefined, { cwd });

    expect(result.details.exitCode).toBe(0);
    expect(textOf(result)).toContain("bead metadata unavailable");
    expect(textOf(result)).not.toContain("  bead: ");
  });

  it("renders ownership, the human wait, the newest comment and the Needs you block", async () => {
    fleet.status = memberStatus();
    bd.respond = (args) => {
      if (args[0] === "show") {
        return JSON.stringify([
          {
            id: "bd-12",
            title: "Fix login",
            status: "open",
            priority: 1,
            labels: ["human"],
            assignee: "belayd:bd-12:implement",
            owner: "hugo",
            comment_count: 1,
            updated_at: "2026-10-27T07:47:29Z",
          },
        ]);
      }
      if (args[0] === "comments") {
        return JSON.stringify([
          {
            id: "c-1",
            issue_id: "bd-12",
            author: "hugo",
            created_at: "2026-10-27T07:47:29Z",
            text: "should we drop the marker?",
          },
        ]);
      }
      return JSON.stringify([{ id: "gate-1", status: "open", await_type: "human" }]);
    };
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const result = await tool.execute("fleet-9", {}, undefined, undefined, { cwd });
    const text = textOf(result);

    expect(result.details.exitCode).toBe(0);
    expect(text).toContain("  owner: hugo");
    expect(text).toContain("  assignee: belayd:bd-12:implement");
    expect(text).toContain("  human: yes");
    expect(text).toContain("  bead updated: 2026-10-27T07:47:29Z");
    expect(text).toContain("  comment count: 1");
    expect(text).toContain("  awaiting human: yes");
    expect(text).toContain(
      '  newest comment: hugo 2026-10-27T07:47:29Z: "should we drop the marker?"',
    );
    expect(text).toContain("Needs you (1): bd-12");
  });

  it("renders an unrecognized gate as unknown, never no", async () => {
    fleet.status = memberStatus();
    bd.respond = (args) => {
      if (args[0] === "show") return JSON.stringify([{ id: "bd-12", labels: [] }]);
      if (args[0] === "comments") return JSON.stringify(null);
      // A renamed status/await_type: records exist, but none is an open human gate.
      return JSON.stringify([{ id: "gate-1", status: "renamed", await_type: "human" }]);
    };
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const text = textOf(await tool.execute("fleet-10", {}, undefined, undefined, { cwd }));

    expect(text).toContain("  awaiting human: unknown");
    expect(text).not.toContain("  awaiting human: no");
    expect(text).not.toContain("Needs you");
  });

  it("renders (unknown), never (none), when the comments read fails", async () => {
    fleet.status = memberStatus();
    bd.respond = (args) => {
      if (args[0] === "show") return JSON.stringify([{ id: "bd-12", labels: [] }]);
      if (args[0] === "comments") return "not json at all";
      return JSON.stringify(null);
    };
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const text = textOf(await tool.execute("fleet-11", {}, undefined, undefined, { cwd }));

    expect(text).toContain("  newest comment: (unknown)");
    expect(text).not.toContain("  newest comment: (none)");
  });

  it("emits exactly one engagement warning for a fleet-wide bd outage", async () => {
    fleet.status = memberStatus(["bd-12", "bd-15"]);
    bd.failWith = "no beads database found";
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const text = textOf(await tool.execute("fleet-12", {}, undefined, undefined, { cwd }));

    // Counted, not merely present: a per-member warning would be a storm.
    expect(text.match(/bead engagement unavailable/gu)).toHaveLength(1);
    expect(text.match(/bead metadata unavailable/gu)).toHaveLength(1);
    expect(text).toContain("Warnings (2):");
    // The warning carries the outage, so no member invents an engagement line.
    expect(text).not.toContain("awaiting human:");
    expect(text).not.toContain("newest comment:");
    expect(text).toContain("Member bd-12");
    expect(text).toContain("Member bd-15");
  });

  it("degrades one bead's failed reads and emits no warning for the rest", async () => {
    fleet.status = memberStatus(["bd-12", "bd-15"]);
    // Both engagement reads for bd-12 fail; its batched `show` and bd-15 succeed.
    bd.failWhen = (args) => args[0] !== "show" && args.includes("bd-12");
    bd.respond = (args) => {
      if (args[0] === "show") {
        return JSON.stringify([
          { id: "bd-12", title: "Fleet status", status: "open", labels: [] },
          { id: "bd-15", title: "Fleet run", status: "open", labels: [] },
        ]);
      }
      return JSON.stringify(null);
    };
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const text = textOf(await tool.execute("fleet-13", {}, undefined, undefined, { cwd }));

    // A mixed outcome is not a fleet-wide fact, so it never warns.
    expect(text).not.toContain("bead engagement unavailable");
    expect(text).not.toContain("Warnings (");
    const [, failed, healthy] = text.split("\nMember ");
    expect(failed).toContain("  bead: Fleet status (open)");
    expect(failed).toContain("  awaiting human: unknown");
    expect(failed).toContain("  newest comment: (unknown)");
    expect(healthy).toContain("  awaiting human: no");
    expect(healthy).toContain("  newest comment: (none)");
  });

  it("belayd_fleet_status writes nothing and issues only read subcommands", async () => {
    fleet.status = memberStatus(["bd-12"]);
    bd.respond = (args) => {
      if (args[0] === "show") return JSON.stringify([{ id: "bd-12", labels: [] }]);
      return JSON.stringify(null);
    };
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    await tool.execute("fleet-14", { fleetId: "night-shift" }, undefined, undefined, { cwd });

    expect(bd.calls.map((call) => call.args).sort()).toEqual(
      [
        ["comments", "bd-12", "--json"],
        ["gate", "list", "bd-12", "--json"],
        ["show", "bd-12", "--json"],
      ].sort(),
    );
    expect(bd.calls.every((call) => isReadOnlyBdArgv(call.args))).toBe(true);
    // Neither the bd-152 marker file nor a fleet intent file is created.
    expect(existsSync(join(cwd, ".belayd", "human-question.json"))).toBe(false);
    expect(existsSync(join(cwd, ".belayd", "fleet"))).toBe(false);
  });

  it("belayd_status reads only show/comments/gate list and writes nothing", async () => {
    const mock = await loadFleetExtension();
    const startTask = mock.tools.get("belayd_start_task");
    const status = mock.tools.get("belayd_status");
    if (startTask === undefined || status === undefined) {
      throw new Error("belayd_start_task / belayd_status were not registered");
    }
    const sessionId = "status-read-only-session";
    await startTask.execute(
      "status-8",
      { taskId: "bd-126" },
      undefined,
      undefined,
      makeCtx(cwd, sessionId),
    );
    // Only the status call's reads are under test.
    bd.calls = [];
    bd.respond = (args) => {
      if (args[0] === "show") {
        return JSON.stringify([{ id: "bd-126", title: "Fleet status", status: "open" }]);
      }
      return JSON.stringify(null);
    };

    const text = textOf(
      await status.execute("status-9", {}, undefined, undefined, makeCtx(cwd, sessionId)),
    );

    expect(bd.calls.map((call) => call.args).sort()).toEqual(
      [
        ["comments", "bd-126", "--json"],
        ["gate", "list", "bd-126", "--json"],
        ["show", "bd-126", "--json"],
      ].sort(),
    );
    expect(bd.calls.every((call) => isReadOnlyBdArgv(call.args))).toBe(true);
    // An empty thread and a resolved (`none`) gate: the two known outcomes.
    expect(text).toContain("- awaiting human: no");
    expect(text).toContain("- newest comment: (none)");
    expect(text).not.toContain("- awaiting human: unknown");
    expect(text).not.toContain("- newest comment: (unknown)");
    // Pre-existing sections keep their content and order around the new one.
    expect(text.startsWith("**Process state for bd-126**")).toBe(true);
    const ownershipAt = text.indexOf("**Bead bd-126**");
    expect(ownershipAt).toBeGreaterThan(0);
    expect(ownershipAt).toBeLessThan(text.indexOf("**Active runs**"));
    expect(existsSync(join(cwd, ".belayd", "human-question.json"))).toBe(false);
    expect(existsSync(join(cwd, ".belayd", "fleet"))).toBe(false);
  });

  it("belayd_status keeps its existing sections when bd is absent", async () => {
    const mock = await loadFleetExtension();
    const startTask = mock.tools.get("belayd_start_task");
    const status = mock.tools.get("belayd_status");
    if (startTask === undefined || status === undefined) {
      throw new Error("belayd_start_task / belayd_status were not registered");
    }
    const sessionId = "status-bd-absent-session";
    await startTask.execute(
      "status-10",
      { taskId: "bd-126" },
      undefined,
      undefined,
      makeCtx(cwd, sessionId),
    );
    // bd not installed: execFile fails with ENOENT-shaped output.
    bd.failWith = "spawn bd ENOENT";

    const result = await status.execute(
      "status-11",
      {},
      undefined,
      undefined,
      makeCtx(cwd, sessionId),
    );
    const text = textOf(result);

    expect(result.details.exitCode).toBe(0);
    expect(text.startsWith("**Process state for bd-126**")).toBe(true);
    expect(text).toContain("**Active runs**");
    expect(text).toContain("bead detail unavailable (bd read failed): spawn bd ENOENT");
  });

  it("belayd_status adds the ownership/human section for the current bead", async () => {
    const mock = await loadFleetExtension();
    const startTask = mock.tools.get("belayd_start_task");
    const status = mock.tools.get("belayd_status");
    if (startTask === undefined || status === undefined) {
      throw new Error("belayd_start_task / belayd_status were not registered");
    }
    const sessionId = "status-ownership-session";
    const started = await startTask.execute(
      "status-1",
      { taskId: "bd-126" },
      undefined,
      undefined,
      makeCtx(cwd, sessionId),
    );
    expect(started.details.exitCode).toBe(0);

    bd.respond = (args) => {
      if (args[0] === "show") {
        return JSON.stringify([
          {
            id: "bd-126",
            title: "Fleet status",
            status: "in_progress",
            labels: ["human", "fleet"],
            assignee: "belayd:bd-126:orchestrator",
            owner: "hugo",
          },
        ]);
      }
      if (args[0] === "comments") return JSON.stringify(null);
      return JSON.stringify([{ id: "gate-1", status: "open", await_type: "human" }]);
    };

    const result = await status.execute(
      "status-2",
      {},
      undefined,
      undefined,
      makeCtx(cwd, sessionId),
    );
    const text = textOf(result);

    expect(result.details.exitCode).toBe(0);
    expect(text).toContain("**Bead bd-126**");
    expect(text).toContain("- owner: hugo");
    expect(text).toContain("- assignee: belayd:bd-126:orchestrator");
    expect(text).toContain("- human: yes");
    expect(text).toContain("- awaiting human: yes");
    expect(text).toContain("- newest comment: (none)");
    expect(text).toContain("**Needs you** — bd-126 is waiting on a human.");
  });

  it("belayd_status degrades a bd failure to one bounded line", async () => {
    const mock = await loadFleetExtension();
    const startTask = mock.tools.get("belayd_start_task");
    const status = mock.tools.get("belayd_status");
    if (startTask === undefined || status === undefined) {
      throw new Error("belayd_start_task / belayd_status were not registered");
    }
    const sessionId = "status-degraded-session";
    await startTask.execute(
      "status-3",
      { taskId: "bd-126" },
      undefined,
      undefined,
      makeCtx(cwd, sessionId),
    );

    bd.failWith = "no beads database found";
    const result = await status.execute(
      "status-4",
      {},
      undefined,
      undefined,
      makeCtx(cwd, sessionId),
    );
    const text = textOf(result);

    expect(result.details.exitCode).toBe(0);
    expect(text).toContain("bead detail unavailable (bd read failed): no beads database found");
  });

  it("belayd_status keeps the bead columns when only the engagement read failed", async () => {
    const mock = await loadFleetExtension();
    const startTask = mock.tools.get("belayd_start_task");
    const status = mock.tools.get("belayd_status");
    if (startTask === undefined || status === undefined) {
      throw new Error("belayd_start_task / belayd_status were not registered");
    }
    const sessionId = "status-partial-session";
    await startTask.execute(
      "status-6",
      { taskId: "bd-126" },
      undefined,
      undefined,
      makeCtx(cwd, sessionId),
    );

    bd.respond = (args) => {
      if (args[0] === "show") {
        return JSON.stringify([
          {
            id: "bd-126",
            title: "Fleet status",
            status: "in_progress",
            labels: [],
            owner: "hugo",
          },
        ]);
      }
      throw new Error("comments/gate unavailable");
    };

    const text = textOf(
      await status.execute("status-7", {}, undefined, undefined, makeCtx(cwd, sessionId)),
    );

    // The show read succeeded, so its columns survive next to the error line.
    expect(text).toContain("**Bead bd-126**");
    expect(text).toContain("- title: Fleet status");
    expect(text).toContain("- owner: hugo");
    expect(text).toContain("bead engagement unavailable (bd read failed)");
  });

  it("belayd_status renders (unknown), never (none), when only the comments read failed", async () => {
    const mock = await loadFleetExtension();
    const startTask = mock.tools.get("belayd_start_task");
    const status = mock.tools.get("belayd_status");
    if (startTask === undefined || status === undefined) {
      throw new Error("belayd_start_task / belayd_status were not registered");
    }
    const sessionId = "status-comments-failed-session";
    await startTask.execute(
      "status-12",
      { taskId: "bd-126" },
      undefined,
      undefined,
      makeCtx(cwd, sessionId),
    );

    bd.respond = (args) => {
      if (args[0] === "show") {
        return JSON.stringify([{ id: "bd-126", title: "Fleet status", status: "open" }]);
      }
      // `comments` returns garbage (a failed read); the gate read still answers.
      if (args[0] === "comments") return "not json at all";
      return JSON.stringify(null);
    };

    const text = textOf(
      await status.execute("status-13", {}, undefined, undefined, makeCtx(cwd, sessionId)),
    );

    // The gate answered (`none`), so the wait is `no`; the thread is unread, so
    // it is `(unknown)` and never the false claim `(none)`.
    expect(text).toContain("- awaiting human: no");
    expect(text).toContain("- newest comment: (unknown)");
    expect(text).not.toContain("- newest comment: (none)");
    expect(text).toContain("**Bead bd-126**");
  });

  it("belayd_status prints no ownership section without a task id", async () => {
    const mock = await loadFleetExtension();
    const status = mock.tools.get("belayd_status");
    if (status === undefined) throw new Error("belayd_status was not registered");

    const result = await status.execute("status-5", {}, undefined, undefined, makeCtx(cwd));

    expect(result.details.exitCode).toBe(0);
    expect(textOf(result)).not.toContain("**Bead ");
    expect(bd.calls).toEqual([]);
  });
});
