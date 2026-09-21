/**
 * Tests for the /plan command and planning-mode sub-agents (bd-51).
 *
 * Covers:
 * - /plan "<description>" enters planning mode with no worktree/daemon I/O
 * - /plan bd-42 resolves to an existing-bead target and instructs `bd show`
 * - planning sub-agent tools spawn with the right spec, no quality gate
 * - /belayd implement-first workflow messages do not list scout/plan as steps
 * - /belayd implement task text prepends the bead plan when `bd show` succeeds
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

// ── Mocks ──────────────────────────────────────────────────────────────

const mockExec = vi.hoisted(() => {
  let showOutput = "";
  const fn = vi.fn(
    (
      cmd: string,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (cmd === "bd show bd-42") {
        cb(null, showOutput, "");
        return;
      }
      cb(new Error("bd not available"), "", "");
    },
  );
  return {
    fn,
    setShowOutput: (out: string) => {
      showOutput = out;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: mockExec.fn,
    execSync: () => {
      throw new Error("no execSync in test");
    },
    execFileSync: () => "",
  };
});

const httpCalls = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string }> = [];
  return {
    calls,
    clear: () => {
      calls.length = 0;
    },
  };
});

const mockHttpRequest = vi.hoisted(() =>
  vi.fn(
    (
      opts: { method?: string; path?: string },
      callback: (res: {
        statusCode: number;
        on: (event: string, handler: (chunk: string) => void) => void;
      }) => void,
    ) => {
      httpCalls.calls.push({ method: opts.method ?? "", path: opts.path ?? "" });
      callback({
        statusCode: 200,
        on: vi.fn((event: string, handler: (chunk: string) => void) => {
          if (event === "data") handler("{}");
          if (event === "end") handler("");
        }),
      });
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    },
  ),
);

vi.mock("node:http", () => ({ request: mockHttpRequest }));

// Capture spawns so the research/scout sub-agents can be asserted on.
const spawnCalls = vi.hoisted(() => {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    clear: () => {
      calls.length = 0;
    },
  };
});

vi.mock("../spawn.js", () => ({
  spawnAgentProcess: vi.fn((opts: Record<string, unknown>) => {
    spawnCalls.calls.push(opts);
    return Promise.resolve({
      content: [{ type: "text", text: "planning result" }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
      },
      sessionName: opts.sessionName,
    });
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  messages: Array<{ customType: string; content: string; options?: Record<string, unknown> }>;
  getActiveToolsList(): string[];
}

function createMockPi(): MockPi {
  const tools = new Map<
    string,
    { name: string; execute: (...args: unknown[]) => Promise<unknown> }
  >();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const messages: Array<{
    customType: string;
    content: string;
    options?: Record<string, unknown>;
  }> = [];
  const activeToolsBox: { list: string[] } = { list: [] };

  const api: ExtensionAPI = {
    registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(def.name, def);
    },
    registerCommand: (
      name: string,
      cmd: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, cmd);
    },
    on: () => {},
    sendMessage: (msg: { customType: string; content: string }, opts?: Record<string, unknown>) => {
      messages.push({ customType: msg.customType, content: msg.content, options: opts });
    },
    getActiveTools: () => activeToolsBox.list,
    setActiveTools: (list: string[]) => {
      activeToolsBox.list = list;
    },
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;

  const proxy: MockPi = {
    api,
    tools,
    commands,
    messages,
    getActiveToolsList: () => activeToolsBox.list,
  };
  return proxy;
}

async function loadExtension(): Promise<(pi: ExtensionAPI) => void> {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

let sessionIdCounter = 0;

function makeCtx(cwd: string) {
  sessionIdCounter += 1;
  return {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => `plan-test-session-${sessionIdCounter}` },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("/plan command (bd-51)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-plan-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    mockExec.fn.mockClear();
    mockExec.setShowOutput("");
    mockHttpRequest.mockClear();
    httpCalls.clear();
    spawnCalls.clear();
  });

  it('enters planning mode with no worktree or daemon calls for /plan "<description>"', async () => {
    const { api, commands, messages, getActiveToolsList } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx(cwd);
    const plan = commands.get("plan");
    expect(plan).toBeDefined();
    await plan?.handler("Add user auth", ctx);

    expect(httpCalls.calls).toHaveLength(0);
    const activeTools = getActiveToolsList();
    expect(activeTools).toContain("belayd_plan_scout");
    expect(activeTools).toContain("belayd_plan_research");
    expect(activeTools).toContain("bd");
    expect(activeTools).not.toContain("edit");

    const kickoff = messages.find((m) => m.customType === "belayd-plan");
    expect(kickoff).toBeDefined();
    expect(kickoff?.content).toContain("Add user auth");
  });

  it("/plan bd-42 resolves to mode B and instructs bd show", async () => {
    const { api, commands, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx(cwd);
    await commands.get("plan")?.handler("bd-42", ctx);

    const kickoff = messages.find((m) => m.customType === "belayd-plan");
    expect(kickoff).toBeDefined();
    expect(kickoff?.content).toContain("bd-42");
    expect(kickoff?.content).toContain("bd show");
    // Mode B must write the refined plan back into the same bead.
    expect(kickoff?.content).toContain("bd update");
    expect(kickoff?.content).toContain("Clarify");
  });

  it('/plan bd-42 "focus" carries the focus into the kickoff', async () => {
    const { api, commands, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx(cwd);
    await commands.get("plan")?.handler('bd-42 "focus on caching"', ctx);

    const kickoff = messages.find((m) => m.customType === "belayd-plan");
    expect(kickoff?.content).toContain("focus on caching");
  });

  it("belayd_plan_research spawns with RESEARCHER_SYSTEM_PROMPT and RESEARCHER_TOOLS", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx(cwd);
    const research = tools.get("belayd_plan_research");
    expect(research).toBeDefined();

    await research?.execute("call-1", { task: "how does auth work?" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(spawnCalls.calls.length).toBeGreaterThan(0);
    });

    const spawn = spawnCalls.calls[spawnCalls.calls.length - 1];
    expect(spawn?.tools).toEqual(expect.arrayContaining(["read"]));
    expect(spawn?.tools).not.toContain("bd");
    expect(spawn?.systemPrompt).toContain("researcher");
    // The planning research run uses a frontier-class spec; spawnAgentWithFallback
    // expands it to a concrete model via its modelClass and leaves the spec's
    // class in the options. Assert on the session name and tools, which are
    // stable regardless of the concrete candidate model.
    expect(spawn?.sessionName).toMatch(/^belayd-planning-sub-research-/);
  });

  it("belayd_plan_scout spawns with tools that do NOT contain bash", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx(cwd);
    const scout = tools.get("belayd_plan_scout");
    expect(scout).toBeDefined();

    await scout?.execute("call-1", { task: "recon auth flow" }, undefined, undefined, ctx);
    await vi.waitFor(() => {
      expect(spawnCalls.calls.length).toBeGreaterThan(0);
    });

    const spawn = spawnCalls.calls[spawnCalls.calls.length - 1];
    expect(spawn?.tools).toEqual(expect.arrayContaining(["read"]));
    expect(spawn?.tools).not.toContain("bash");
  });

  it("rejects /plan while a gate is active", async () => {
    const { api, commands, tools, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx(cwd);
    const start = tools.get("belayd_start_task");
    expect(start).toBeDefined();
    await start?.execute("call-start", { taskId: "bd-42" }, undefined, undefined, ctx);

    await commands.get("plan")?.handler("x", ctx);

    expect(messages.filter((m) => m.customType === "belayd-plan")).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("active"), "error");
  });

  it("delivers a belayd-planning-run-complete follow-up after a planning run", async () => {
    const { api, commands, tools, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx(cwd);
    await commands.get("plan")?.handler("Add user auth", ctx);

    const research = tools.get("belayd_plan_research");
    await research?.execute("call-1", { task: "research" }, undefined, undefined, ctx);

    await vi.waitFor(() => {
      const done = messages.find((m) => m.customType === "belayd-planning-run-complete");
      expect(done).toBeDefined();
      if (done) {
        expect(done.options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
      }
    });
  });
});

describe("/belayd implement-first workflow (bd-51)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-impl-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    mockExec.fn.mockClear();
    mockExec.setShowOutput("");
    mockHttpRequest.mockClear();
    spawnCalls.clear();
  });

  it("lists implement first and does not list scout/plan as required steps", async () => {
    const { api, commands, messages } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx(cwd);
    await commands.get("belayd")?.handler("bd-42 feature --no-worktree", ctx);

    const workflowMsg = messages.find((m) => m.customType === "belayd-command");
    expect(workflowMsg).toBeDefined();
    const content = workflowMsg?.content ?? "";
    expect(content).toContain("implement");
    expect(content).toContain("consultation");
    // scout/plan must not appear as numbered required-step bullets.
    const stepBullets = content.match(/^\d+\. `belayd_\w+`/gm) ?? [];
    expect(stepBullets.some((s) => s.includes("belayd_scout"))).toBe(false);
    expect(stepBullets.some((s) => s.includes("belayd_plan"))).toBe(false);
  });

  it("prepends the bead plan when bd show bd-42 returns output", async () => {
    mockExec.setShowOutput("## Overview\nPlan text here");
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx(cwd);

    // Activate the gate so currentTaskId is set; then run the implement phase.
    const start = tools.get("belayd_start_task");
    expect(start).toBeDefined();
    await start?.execute("call-start", { taskId: "bd-42" }, undefined, undefined, ctx);

    const impl = tools.get("belayd_implement");
    expect(impl).toBeDefined();
    await impl?.execute("call-1", { task: "implement plan" }, undefined, undefined, ctx);

    await vi.waitFor(() => {
      expect(spawnCalls.calls.length).toBeGreaterThan(0);
    });

    // The implement run failed the mocked quality gate and retried; the FIRST
    // spawn call is the initial implement attempt and carries the bead plan.
    const first = spawnCalls.calls[0] as { task?: string };
    expect(first.task).toContain("Bead plan (bd-42)");
    expect(first.task).toContain("Plan text here");
  });
});
