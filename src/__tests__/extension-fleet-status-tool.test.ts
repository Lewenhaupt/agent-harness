/**
 * Tests for the `belayd_fleet_status` pi tool surface in extensions/index.ts.
 *
 * `readFleetStatus` is replaced by a recorder so the assertions cover the
 * extension's own contract — fleet-id defaulting/trimming, result rendering,
 * error exit code, and gate membership — without shelling out to git.
 * `node:child_process` is mocked so gate activation's `bd` calls are inert.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

const fleet = vi.hoisted(() => ({
  calls: [] as Array<{ cwd: string; fleetId: string }>,
  failWith: undefined as string | undefined,
}));

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return {
    ...actual,
    readFleetStatus: (options: { cwd: string; fleetId: string }) => {
      fleet.calls.push({ cwd: options.cwd, fleetId: options.fleetId });
      if (fleet.failWith !== undefined) return { ok: false as const, error: fleet.failWith };
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
  const ok = (
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    callback(null, "", "");
    return { stdin: undefined };
  };
  return { ...actual, exec: vi.fn(), execFile: vi.fn(ok) };
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

describe("belayd_fleet_status tool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-status-tool-"));
    fleet.calls = [];
    fleet.failWith = undefined;
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
});
