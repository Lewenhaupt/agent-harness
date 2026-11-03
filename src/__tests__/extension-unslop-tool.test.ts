/**
 * Tests for the `belayd_unslop` pi tool (bd-253).
 *
 * The composer is loaded with the real capability registration; only the spawn
 * seam on the barrel is mocked, so the assertions cover what the tool actually
 * hands the child (model class, tool list, prompt identity, session naming,
 * blocking mode, routing seams) and what it returns on each path.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUnslopTask } from "../../extensions/capabilities/unslop.js";
import { UNSLOP_AGENT, UNSLOP_TOOLS } from "../agent-registry.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

const spawn = vi.hoisted(() => ({
  calls: [] as unknown[],
  reply:
    "## Audit\npurple gradient on the hero\n\n## Direction\nProduct, Character, World, Moments, Signature",
  failWith: undefined as string | undefined,
  noContent: false,
}));

vi.mock("../index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../index.js")>();
  return {
    ...actual,
    spawnAgentWithFallback: vi.fn(async (options: unknown) => {
      spawn.calls.push(options);
      if (spawn.failWith !== undefined) throw new Error(spawn.failWith);
      return {
        result: {
          content: spawn.noContent ? [] : [{ type: "text" as const, text: spawn.reply }],
        },
      };
    }),
  };
});

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number };
}

interface RegisteredTool {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, RegisteredTool>;
}

function createMockPi(): MockPi {
  const tools = new Map<string, RegisteredTool>();
  let active: string[] = [];
  const api = {
    registerTool: (def: RegisteredTool) => {
      tools.set(def.name, def);
    },
    registerCommand: () => {},
    on: () => {},
    sendMessage: () => {},
    getActiveTools: () => active,
    setActiveTools: (list: string[]) => {
      active = list;
    },
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, tools };
}

async function loadUnslopTool(): Promise<RegisteredTool> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const mock = createMockPi();
  register(mock.api);
  const tool = mock.tools.get("belayd_unslop");
  if (tool === undefined) throw new Error("belayd_unslop was not registered");
  return tool;
}

function makeCtx(dir: string | undefined) {
  return {
    sessionManager: {
      getSessionId: () => "unslop-session",
      getSessionName: () => "belayd-bd-253",
      getSessionFile: () => "/tmp/unslop-session.jsonl",
    },
    ...(dir === undefined ? {} : { cwd: dir }),
    ui: { notify: () => {} },
  };
}

const CWD = "/repo/worktree";

describe("belayd_unslop tool contract (bd-253)", () => {
  beforeEach(() => {
    spawn.calls = [];
    spawn.reply = "## Audit\npurple gradient on the hero";
    spawn.failWith = undefined;
    spawn.noContent = false;
  });

  afterEach(() => {
    spawn.calls = [];
  });

  it("registers one tool with a `task` string parameter", async () => {
    const tool = await loadUnslopTool();

    expect(tool.name).toBe("belayd_unslop");
    expect(tool.description).toContain("AI-generated UI tells");
    expect(tool.description).toContain("## Audit + ## Direction");
    const parameters = tool.parameters as {
      type?: string;
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(parameters.type).toBe("object");
    expect(parameters.required).toEqual(["task"]);
    expect(parameters.properties?.task?.type).toBe("string");
  });

  it("hands the child the agent's model class, tools, prompt and blocking mode", async () => {
    const tool = await loadUnslopTool();
    const controller = new AbortController();

    const result = await tool.execute(
      "unslop-1",
      { task: "unslop src/app/page.tsx" },
      controller.signal,
      undefined,
      makeCtx(CWD),
    );

    expect(result.details.exitCode).toBe(0);
    expect(result.content[0]?.text).toBe(spawn.reply);

    const options = spawn.calls[0] as {
      model: string;
      modelClass: string;
      tools: string[];
      systemPrompt: string;
      task: string;
      sessionName: string;
      cwd: string;
      signal: AbortSignal | undefined;
      detached: boolean;
      phase: string;
      cooldownStore: unknown;
      enabled: boolean;
      telemetry: unknown;
      capacity: unknown;
    };
    expect(typeof options.model).toBe("string");
    expect(options.model.length).toBeGreaterThan(0);
    expect(options.modelClass).toBe("frontier");
    expect(options.tools).toEqual(UNSLOP_TOOLS);
    expect(options.systemPrompt).toBe(UNSLOP_AGENT.systemPrompt);
    // Two-pass protocol is the prompt's job, but the tool must not pre-empt it.
    expect(options.task).toContain("unslop src/app/page.tsx");
    expect(options.sessionName.startsWith("belayd-unslop-")).toBe(true);
    expect(options.cwd).toBe(CWD);
    expect(options.signal).toBe(controller.signal);
    // Blocking: the orchestrator needs the audit back in the same turn.
    expect(options.detached).toBe(false);
    expect(options.phase).toBe("unslop");
    expect(options.cooldownStore).toBeDefined();
    expect(typeof options.enabled).toBe("boolean");
    expect(options.telemetry).toBeDefined();
    expect(options.capacity).toBeDefined();
  });

  it("frames the task with the working directory so relative paths resolve", async () => {
    const tool = await loadUnslopTool();

    await tool.execute(
      "unslop-2",
      { task: "apply the confirmed direction" },
      undefined,
      undefined,
      makeCtx(CWD),
    );

    const options = spawn.calls[0] as { task: string };
    expect(options.task).toBe(buildUnslopTask({ task: "apply the confirmed direction", cwd: CWD }));
    expect(options.task.startsWith("## Task")).toBe(true);
    expect(options.task).toContain(`Working directory: ${CWD}`);
  });

  it("reports a failed spawn with exit code 1 instead of throwing", async () => {
    spawn.failWith = "no frontier provider available";
    const tool = await loadUnslopTool();

    const result = await tool.execute(
      "unslop-3",
      { task: "audit the hero" },
      undefined,
      undefined,
      makeCtx(CWD),
    );

    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toBe(
      "unslop agent could not run: no frontier provider available",
    );
  });

  it("refuses to run without a working directory and never spawns", async () => {
    const tool = await loadUnslopTool();

    const result = await tool.execute(
      "unslop-4",
      { task: "audit the hero" },
      undefined,
      undefined,
      makeCtx(undefined),
    );

    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toContain("belayd_unslop has no working directory");
    expect(spawn.calls).toEqual([]);
  });

  it("treats an empty cwd as missing rather than spawning at the host cwd", async () => {
    const tool = await loadUnslopTool();

    const result = await tool.execute(
      "unslop-5",
      { task: "audit the hero" },
      undefined,
      undefined,
      makeCtx(""),
    );

    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toContain("belayd_unslop has no working directory");
    // An empty cwd would otherwise resolve relative paths against the harness.
    expect(spawn.calls).toEqual([]);
  });

  it("reports a child that returned no text as success with an explicit message", async () => {
    spawn.noContent = true;
    const tool = await loadUnslopTool();

    const result = await tool.execute(
      "unslop-6",
      { task: "audit the hero" },
      undefined,
      undefined,
      makeCtx(CWD),
    );

    // The spawn succeeded, so the turn must not look like a spawn failure; the
    // message keeps an empty audit distinguishable from a real one.
    expect(result.details.exitCode).toBe(0);
    expect(result.content[0]?.text).toBe("The unslop agent produced no output.");
  });
});

describe("buildUnslopTask (bd-253)", () => {
  it("keeps the caller's steer verbatim between a heading and the cwd line", () => {
    const task = buildUnslopTask({ task: "Pass 1 only: audit docs/hero.html", cwd: "/w" });

    expect(task.split("\n")).toEqual([
      "## Task",
      "",
      "Pass 1 only: audit docs/hero.html",
      "",
      "Working directory: /w",
    ]);
  });
});
