/**
 * Tests for bd-106 workflow-type confirmation gating.
 *
 * A `wf:<type>` bead label must never launch a workflow on its own: the
 * interactive `/belayd` command confirms first (cancel is side-effect-free),
 * and a tool call with no UI auto-denies instead of silently defaulting.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

// ── Mocks ──────────────────────────────────────────────────────────────

const bdState = vi.hoisted(() => ({
  labels: [] as string[],
  title: "",
  updateCalls: [] as string[][],
}));

const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      let stdout = "";
      if (args[0] === "show") {
        stdout = JSON.stringify([{ title: bdState.title, labels: bdState.labels }]);
      } else if (args[0] === "update") {
        bdState.updateCalls.push([...args]);
      }
      const stdin = { on: () => {}, end: () => cb(null, stdout, "") };
      return { stdin };
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: vi.fn(),
    execFile: mockExecFile,
    execSync: vi.fn(),
    execFileSync: vi.fn(),
  };
});

// ── Helpers ────────────────────────────────────────────────────────────

interface CommandLike {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface ToolLike {
  name: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ text: string }>;
    details: { exitCode: number };
  }>;
}

function createMockPi(): {
  api: ExtensionAPI;
  commands: Map<string, CommandLike>;
  tools: Map<string, ToolLike>;
  sentMessages: unknown[];
} {
  const commands = new Map<string, CommandLike>();
  const tools = new Map<string, ToolLike>();
  const sentMessages: unknown[] = [];
  const api = {
    registerTool: (def: ToolLike) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, cmd: CommandLike) => {
      commands.set(name, cmd);
    },
    on: () => {},
    sendMessage: (message: unknown) => {
      sentMessages.push(message);
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, commands, tools, sentMessages };
}

async function loadExtension() {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

function workflowStatePath(cwd: string): string {
  return join(cwd, ".belayd", "workflow.json");
}

interface WorkflowStateFile {
  workflowType?: string;
  resolutionSource?: string;
  matchedLabel?: string;
}

function readWorkflowStateFile(cwd: string): WorkflowStateFile {
  return JSON.parse(readFileSync(workflowStatePath(cwd), "utf8")) as WorkflowStateFile;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("workflow type confirmation (bd-106)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-confirm-"));
    bdState.labels = ["wf:chore"];
    bdState.title = "Producer authentication: project-scoped upload tokens and CI OIDC exchange";
    bdState.updateCalls.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("cancel is side-effect-free: no gate state and no workflow message", async () => {
    const { api, commands, sentMessages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const select = vi.fn(async () => undefined);
    const notify = vi.fn();
    await commands.get("belayd")?.handler("bd-42 --no-worktree", {
      cwd,
      ui: { select, notify },
      sessionManager: { getSessionId: () => "cancel-session" },
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(existsSync(workflowStatePath(cwd))).toBe(false);
    expect(sentMessages).toHaveLength(0);
    expect(bdState.updateCalls).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith("Belayd workflow cancelled — no changes made.", "info");
  });

  it("confirm proceeds with the label type and skips a redundant write-back", async () => {
    const { api, commands, sentMessages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const select = vi.fn(async () => "Confirm chore");
    await commands.get("belayd")?.handler("bd-42 --no-worktree", {
      cwd,
      ui: { select, notify: vi.fn() },
      sessionManager: { getSessionId: () => "confirm-session" },
    });

    const state = readWorkflowStateFile(cwd);
    expect(state.workflowType).toBe("chore");
    expect(state.resolutionSource).toBe("label");
    expect(state.matchedLabel).toBe("wf:chore");
    // The driving label is already present, so no redundant write-back.
    expect(bdState.updateCalls).toHaveLength(0);
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(JSON.stringify(sentMessages[0])).toContain("Belayd chore workflow started");
  });

  it("choose-another-type overrides to an explicit type", async () => {
    const { api, commands, sentMessages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const select = vi
      .fn()
      .mockResolvedValueOnce("Choose another type")
      .mockResolvedValueOnce("bugfix: implement → review → test → proof → commit (proof required)");
    await commands.get("belayd")?.handler("bd-42 --no-worktree", {
      cwd,
      ui: { select, notify: vi.fn() },
      sessionManager: { getSessionId: () => "override-session" },
    });

    const state = readWorkflowStateFile(cwd);
    expect(state.workflowType).toBe("bugfix");
    expect(state.resolutionSource).toBe("arg");
    // The override type is persisted exactly once for the next run.
    expect(bdState.updateCalls).toEqual([["update", "--add-label", "wf:bugfix", "--", "bd-42"]]);
    expect(JSON.stringify(sentMessages[0])).toContain("Belayd bugfix workflow started");
  });

  it("bd-17-style title with no labels defaults to feature without confirming", async () => {
    bdState.labels = [];
    bdState.title = "Producer authentication: project-scoped upload tokens and CI OIDC exchange";
    const { api, commands, sentMessages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const select = vi.fn();
    await commands.get("belayd")?.handler("bd-42 --no-worktree", {
      cwd,
      ui: { select, notify: vi.fn() },
      sessionManager: { getSessionId: () => "bd17-session" },
    });

    // The word "CI" in the title must not trigger a prompt or a demotion.
    expect(select).not.toHaveBeenCalled();
    const state = readWorkflowStateFile(cwd);
    expect(state.workflowType).toBe("feature");
    expect(state.resolutionSource).toBe("default");
    expect(state.matchedLabel).toBeUndefined();
    expect(bdState.updateCalls).toHaveLength(0);
    expect(JSON.stringify(sentMessages[0])).toContain("Belayd feature workflow started");
  });

  it("plain type labels no longer drive resolution or confirmation", async () => {
    for (const label of ["chore", "bug", "investigation"]) {
      bdState.labels = [label];
      const { api, commands } = createMockPi();
      const factory = await loadExtension();
      factory(api);

      const select = vi.fn();
      await commands.get("belayd")?.handler("bd-42 --no-worktree", {
        cwd,
        ui: { select, notify: vi.fn() },
        sessionManager: { getSessionId: () => `plain-${label}-session` },
      });

      expect(select, label).not.toHaveBeenCalled();
      const state = readWorkflowStateFile(cwd);
      expect(state.workflowType, label).toBe("feature");
      expect(state.resolutionSource, label).toBe("default");
      expect(bdState.updateCalls, label).toHaveLength(0);
      rmSync(workflowStatePath(cwd), { force: true });
    }
  });

  it("an invalid wf: label is ignored and defaults to feature without confirming", async () => {
    bdState.labels = ["implementation", "wf:nope"];
    const { api, commands } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const select = vi.fn();
    await commands.get("belayd")?.handler("bd-42 --no-worktree", {
      cwd,
      ui: { select, notify: vi.fn() },
      sessionManager: { getSessionId: () => "invalid-wf-session" },
    });

    expect(select).not.toHaveBeenCalled();
    const state = readWorkflowStateFile(cwd);
    expect(state.workflowType).toBe("feature");
    expect(state.resolutionSource).toBe("default");
    expect(state.matchedLabel).toBeUndefined();
    expect(bdState.updateCalls).toHaveLength(0);
  });

  it("belayd_start_task auto-denies a wf: label with no UI", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const result = await tools
      .get("belayd_start_task")
      ?.execute("call-1", { taskId: "bd-42" }, undefined, undefined, {
        cwd,
        ui: { notify: vi.fn() },
        sessionManager: { getSessionId: () => "tool-session" },
      });

    expect(result?.details.exitCode).toBe(1);
    expect(result?.content[0]?.text).toContain("requires confirmation");
    expect(existsSync(workflowStatePath(cwd))).toBe(false);
  });

  it("belayd_start_followup auto-denies a wf: label with no UI", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const result = await tools
      .get("belayd_start_followup")
      ?.execute("call-followup", { taskId: "bd-42", base: "main" }, undefined, undefined, {
        cwd,
        ui: { notify: vi.fn() },
        sessionManager: { getSessionId: () => "tool-followup-session" },
      });

    expect(result?.details.exitCode).toBe(1);
    expect(result?.content[0]?.text).toContain("requires confirmation");
    // Denied before launch: no worktree state, no gate, no label write-back.
    expect(existsSync(workflowStatePath(cwd))).toBe(false);
    expect(existsSync(`${cwd}.feat-bd-42`)).toBe(false);
    expect(bdState.updateCalls).toHaveLength(0);
  });

  it("belayd_start_task confirms a wf: label when the session has UI", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const result = await tools
      .get("belayd_start_task")
      ?.execute("call-ui", { taskId: "bd-42" }, undefined, undefined, {
        cwd,
        hasUI: true,
        ui: { select: vi.fn(async () => "Confirm chore"), notify: vi.fn() },
        sessionManager: { getSessionId: () => "tool-ui-session" },
      });

    expect(result?.details.exitCode).toBe(0);
    const state = readWorkflowStateFile(cwd);
    expect(state.workflowType).toBe("chore");
    expect(state.resolutionSource).toBe("label");
  });

  it("belayd_start_task persists a chosen override exactly once", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const select = vi
      .fn()
      .mockResolvedValueOnce("Choose another type")
      .mockResolvedValueOnce("bugfix: implement → review → test → proof → commit (proof required)");
    const result = await tools
      .get("belayd_start_task")
      ?.execute("call-override", { taskId: "bd-42" }, undefined, undefined, {
        cwd,
        hasUI: true,
        ui: { select, notify: vi.fn() },
        sessionManager: { getSessionId: () => "tool-override-session" },
      });

    expect(result?.details.exitCode).toBe(0);
    const state = readWorkflowStateFile(cwd);
    expect(state.workflowType).toBe("bugfix");
    expect(state.resolutionSource).toBe("arg");
    // confirmAndPersistResolution writes the label; the tool must not write it
    // a second time from its stale label snapshot.
    expect(bdState.updateCalls.filter((call) => call.includes("wf:bugfix"))).toHaveLength(1);
  });

  it("belayd_start_task proceeds when an explicit type is passed", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const result = await tools
      .get("belayd_start_task")
      ?.execute("call-2", { taskId: "bd-42", workflowType: "bugfix" }, undefined, undefined, {
        cwd,
        ui: { notify: vi.fn() },
        sessionManager: { getSessionId: () => "tool-arg-session" },
      });

    expect(result?.details.exitCode).toBe(0);
    const state = readWorkflowStateFile(cwd);
    expect(state.workflowType).toBe("bugfix");
    expect(state.resolutionSource).toBe("arg");
  });
});
