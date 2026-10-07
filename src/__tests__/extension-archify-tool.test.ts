/**
 * Tests for the `belayd_archify` pi tool surface in extensions/index.ts.
 *
 * The real `validateArchifyParams` / `build*Args` / `ignoredArchifyParams`
 * logic runs unchanged; only `node:child_process` is mocked so dispatch,
 * argv shape, notes, and rejections can be asserted without a real archify.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

interface ExecFileRecord {
  file: string;
  args: readonly string[];
  cwd: string | undefined;
  env: Record<string, string | undefined> | undefined;
}

interface ExecOutcome {
  error: Error | null;
  stdout: string;
  stderr: string;
}

const execFileMock = vi.hoisted(() => {
  const calls: ExecFileRecord[] = [];
  const state: { respond: (record: ExecFileRecord) => ExecOutcome } = {
    respond: () => ({ error: null, stdout: "", stderr: "" }),
  };
  const fn = vi.fn(
    (
      file: string,
      args: readonly string[],
      options: { cwd?: string; env?: Record<string, string | undefined> },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const record: ExecFileRecord = { file, args, cwd: options?.cwd, env: options?.env };
      calls.push(record);
      const outcome = state.respond(record);
      callback(outcome.error, outcome.stdout, outcome.stderr);
      return { stdin: undefined };
    },
  );
  return {
    fn,
    calls,
    state,
    clear: () => {
      calls.length = 0;
      state.respond = () => ({ error: null, stdout: "", stderr: "" });
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: vi.fn(), execFile: execFileMock.fn };
});

interface ArchifyToolResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number };
}

interface ArchifyTool {
  name: string;
  execute: (...args: unknown[]) => Promise<ArchifyToolResult>;
}

interface PiCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, ArchifyTool>;
  commands: Map<string, PiCommand>;
  activeTools: () => string[];
}

function createMockPi(): MockPi {
  const tools = new Map<string, ArchifyTool>();
  const commands = new Map<string, PiCommand>();
  let active: string[] = [];
  const api = {
    registerTool: (def: ArchifyTool) => {
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

async function loadArchifyExtension(): Promise<MockPi> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const mock = createMockPi();
  register(mock.api);
  const tool = mock.tools.get("belayd_archify");
  if (tool === undefined) throw new Error("belayd_archify tool was not registered");
  return mock;
}

async function loadArchifyTool(): Promise<ArchifyTool> {
  const mock = await loadArchifyExtension();
  const tool = mock.tools.get("belayd_archify");
  if (tool === undefined) throw new Error("belayd_archify tool was not registered");
  return tool;
}

function respondText(stdout: string) {
  return { error: null, stdout, stderr: "" };
}

function textOf(result: ArchifyToolResult): string {
  return result.content[0]?.text ?? "";
}

describe("belayd_archify tool", () => {
  let cwd: string;
  let tool: ArchifyTool;
  let tmpRoots: string[];
  let savedArchifyHome: string | undefined;
  let hadArchifyHome: boolean;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-archify-tool-"));
    tmpRoots = [cwd];
    execFileMock.clear();
    hadArchifyHome = process.env.ARCHIFY_HOME !== undefined;
    savedArchifyHome = process.env.ARCHIFY_HOME;
    tool = await loadArchifyTool();
  });

  afterEach(() => {
    for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
    if (hadArchifyHome) {
      process.env.ARCHIFY_HOME = savedArchifyHome;
    } else {
      delete process.env.ARCHIFY_HOME;
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
  }

  it("dispatches the default deliver branch and formats the receipt", async () => {
    execFileMock.state.respond = () =>
      respondText(
        JSON.stringify({ schemaVersion: 1, ok: true, command: "deliver", type: "architecture" }),
      );

    const result = await tool.execute(
      "c1",
      { type: "architecture", input: "in.json" },
      undefined,
      undefined,
      {
        cwd,
      },
    );

    const call = execFileMock.calls[0];
    expect(call?.file).toBe("archify");
    expect(call?.args).toEqual([
      "deliver",
      "architecture",
      "in.json",
      join(cwd, "docs", "diagrams", "architecture.html"),
      "--quality",
      "showcase",
      "--json",
    ]);
    expect(result.details.exitCode).toBe(0);
    expect(textOf(result)).toContain("archify deliver architecture: ok");
  });

  it("forwards repoRoot for a non-architecture type (3.x supports all five types)", async () => {
    execFileMock.state.respond = () =>
      respondText(
        JSON.stringify({ schemaVersion: 1, ok: true, command: "validate", type: "workflow" }),
      );

    const result = await tool.execute(
      "c1b",
      { command: "validate", type: "workflow", input: "in.json", repoRoot: "/repo" },
      undefined,
      undefined,
      { cwd },
    );

    const call = execFileMock.calls[0];
    expect(call?.args).toEqual([
      "validate",
      "workflow",
      "in.json",
      "--quality",
      "showcase",
      "--repo-root",
      "/repo",
      "--json",
    ]);
    expect(result.details.exitCode).toBe(0);
  });

  it("routes command=guide with a scenario to the guide text path, not a diagram argv", async () => {
    execFileMock.state.respond = () => respondText('{"ok":true,"mode":"recommendation"}');

    const result = await tool.execute(
      "c2",
      { command: "guide", scenario: "login flow" },
      undefined,
      undefined,
      { cwd },
    );

    const call = execFileMock.calls[0];
    expect(call?.args).toEqual(["guide", "login flow", "--json"]);
    expect(call?.args).not.toContain("--quality");
    expect(result.details.exitCode).toBe(0);
    expect(textOf(result)).toContain("recommendation");
  });

  it("runs command=guide without a scenario", async () => {
    execFileMock.state.respond = () => respondText('{"ok":true,"mode":"list"}');

    const result = await tool.execute("c3", { command: "guide" }, undefined, undefined, { cwd });

    expect(execFileMock.calls[0]?.args).toEqual(["guide", "--json"]);
    expect(result.details.exitCode).toBe(0);
    expect(textOf(result)).toContain("list");
  });

  it("reports ARCHIFY_HOME as missing for command=examples", async () => {
    delete process.env.ARCHIFY_HOME;

    const result = await tool.execute("c4", { command: "examples" }, undefined, undefined, { cwd });

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("ARCHIFY_HOME");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("lists sorted example paths from a temp $ARCHIFY_HOME/examples", async () => {
    const home = tempDir("belayd-archify-home-");
    const examplesDir = join(home, "examples");
    mkdirSync(examplesDir);
    writeFileSync(join(examplesDir, "b.workflow.json"), "{}");
    writeFileSync(join(examplesDir, "a.architecture.json"), "{}");
    writeFileSync(join(examplesDir, "ignored.html"), "<html>");
    process.env.ARCHIFY_HOME = home;

    const result = await tool.execute("c5", { command: "examples" }, undefined, undefined, { cwd });

    const text = textOf(result);
    expect(result.details.exitCode).toBe(0);
    expect(text).toContain(join(examplesDir, "a.architecture.json"));
    expect(text).toContain(join(examplesDir, "b.workflow.json"));
    expect(text).not.toContain("ignored.html");
    expect(text.indexOf("a.architecture.json")).toBeLessThan(text.indexOf("b.workflow.json"));
  });

  it("rejects inspect for a non-architecture type", async () => {
    const result = await tool.execute(
      "c6",
      { command: "inspect", type: "workflow", input: "in.json" },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("inspect only supports the architecture type");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("builds inspect argv for architecture", async () => {
    execFileMock.state.respond = () => respondText('{"ok":true,"diagram_type":"architecture"}');

    const result = await tool.execute(
      "c7",
      { command: "inspect", type: "architecture", input: "in.json" },
      undefined,
      undefined,
      { cwd },
    );

    expect(execFileMock.calls[0]?.args).toEqual(["inspect", "architecture", "in.json"]);
    expect(result.details.exitCode).toBe(0);
  });

  it("rejects command=check without input", async () => {
    const result = await tool.execute("c8", { command: "check" }, undefined, undefined, { cwd });

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("input is required for command=check");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("builds check argv with the artifact path as input", async () => {
    execFileMock.state.respond = () => respondText('{"ok":true}');

    const result = await tool.execute(
      "c9",
      { command: "check", input: "out.html" },
      undefined,
      undefined,
      { cwd },
    );

    expect(execFileMock.calls[0]?.args).toEqual(["check", "out.html"]);
    expect(result.details.exitCode).toBe(0);
  });

  it("rejects an unknown command", async () => {
    const result = await tool.execute("c10", { command: "preview" }, undefined, undefined, { cwd });

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("Unknown command");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("rejects a diagram command with a missing type", async () => {
    const result = await tool.execute(
      "c11",
      { command: "deliver", input: "in.json" },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("Unknown diagram type");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("rejects a guide scenario that starts with --", async () => {
    const result = await tool.execute(
      "c12",
      { command: "guide", scenario: "--json" },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("scenario must not start with");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("notes ignored params for guide and omits the note when nothing is ignored", async () => {
    execFileMock.state.respond = () => respondText('{"ok":true}');

    const withIgnored = await tool.execute(
      "c13",
      { command: "guide", scenario: "login flow", quality: "showcase" },
      undefined,
      undefined,
      { cwd },
    );
    const withIgnoredText = textOf(withIgnored);
    expect(withIgnoredText).toContain("note:");
    expect(withIgnoredText).toContain("`quality`");
    expect(withIgnoredText).not.toContain("`scenario`");

    const clean = await tool.execute(
      "c14",
      { command: "guide", scenario: "login flow" },
      undefined,
      undefined,
      { cwd },
    );
    expect(textOf(clean)).not.toContain("note:");
  });

  it("notes ignored params for check without listing input", async () => {
    execFileMock.state.respond = () => respondText('{"ok":true}');

    const result = await tool.execute(
      "c15",
      { command: "check", input: "out.html", type: "architecture", output: "x.html" },
      undefined,
      undefined,
      { cwd },
    );

    const text = textOf(result);
    expect(text).toContain("`type`");
    expect(text).toContain("`output`");
    expect(text).not.toContain("`input`");
  });

  it("notes ignored params for inspect without listing type/input", async () => {
    execFileMock.state.respond = () => respondText('{"ok":true}');

    const result = await tool.execute(
      "c16",
      { command: "inspect", type: "architecture", input: "in.json", repoRoot: "/repo" },
      undefined,
      undefined,
      { cwd },
    );

    const text = textOf(result);
    expect(text).toContain("`repoRoot`");
    expect(text).not.toContain("`type`");
    expect(text).not.toContain("`input`");
  });

  it("notes ignored params for examples", async () => {
    const home = tempDir("belayd-archify-home-");
    mkdirSync(join(home, "examples"));
    writeFileSync(join(home, "examples", "a.architecture.json"), "{}");
    process.env.ARCHIFY_HOME = home;

    const result = await tool.execute(
      "c17",
      { command: "examples", quality: "showcase" },
      undefined,
      undefined,
      { cwd },
    );

    expect(textOf(result)).toContain("`quality`");
  });

  it("rejects inspect when the type is missing (only architecture is supported)", async () => {
    const result = await tool.execute(
      "c18",
      { command: "inspect", input: "in.json" },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("inspect only supports the architecture type");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("accepts a guide scenario containing an internal -- while a leading -- is rejected", async () => {
    execFileMock.state.respond = () => respondText('{"ok":true,"scenario":"login -- flow"}');

    const result = await tool.execute(
      "c19",
      { command: "guide", scenario: "login -- flow" },
      undefined,
      undefined,
      { cwd },
    );

    expect(execFileMock.calls[0]?.args).toEqual(["guide", "login -- flow", "--json"]);
    expect(result.details.exitCode).toBe(0);
    expect(textOf(result)).toContain("login -- flow");
  });

  it("reports command=check with a supplied type as ignored, not as an error", async () => {
    // `type` is meaningless for check, but it is not a rejection — the note
    // reports it as ignored while the artifact input still runs.
    execFileMock.state.respond = () => respondText('{"ok":true}');

    const result = await tool.execute(
      "c20",
      { command: "check", input: "out.html", type: "architecture" },
      undefined,
      undefined,
      { cwd },
    );

    expect(execFileMock.calls[0]?.args).toEqual(["check", "out.html"]);
    expect(result.details.exitCode).toBe(0);
    const text = textOf(result);
    expect(text).toContain("`type` ignored for command=check");
  });
});

describe("belayd_archify tool registration (opt-in, gated but not planning)", () => {
  let tmpRoots: string[];

  beforeEach(() => {
    execFileMock.clear();
    tmpRoots = [];
  });

  afterEach(() => {
    for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
  }

  function makeCtx(sessionId: string, dir: string) {
    return {
      sessionManager: { getSessionId: () => sessionId },
      cwd: dir,
      ui: { notify: () => {} },
    };
  }

  it("keeps belayd_archify available while the process gate is active (GATED_TOOLS)", async () => {
    const mock = await loadArchifyExtension();
    const gateCwd = tempDir("belayd-archify-gate-");

    const startTask = mock.tools.get("belayd_start_task");
    if (startTask === undefined) throw new Error("belayd_start_task was not registered");
    const started = (await startTask.execute(
      "gate-1",
      { taskId: "bd-87" },
      undefined,
      undefined,
      makeCtx("archify-gate-session", gateCwd),
    )) as ArchifyToolResult;
    expect(started.details.exitCode).toBe(0);

    // The gate set was actually applied before asserting availability.
    expect(mock.activeTools()).toContain("belayd_status");
    expect(mock.activeTools()).toContain("belayd_archify");
  });

  it("excludes belayd_archify from the planning-mode tool set (PLANNING_GATED_TOOLS)", async () => {
    const mock = await loadArchifyExtension();
    const planCwd = tempDir("belayd-archify-plan-");

    const plan = mock.commands.get("plan");
    if (plan === undefined) throw new Error("plan command was not registered");
    await plan.handler("diagram authoring guide", makeCtx("archify-plan-session", planCwd));

    const active = mock.activeTools();
    // The planning set was actually applied before asserting the exclusion.
    expect(active).toContain("belayd_plan_scout");
    expect(active).not.toContain("belayd_archify");
  });
});
