/**
 * Tests for the `belayd_outline` pi tool surface in extensions/index.ts.
 *
 * The real param validation and src/outline.ts scanner run unchanged; only
 * `node:child_process` is mocked so gate activation's `bd` calls are inert.
 * `belayd_outline` itself never shells out — it only reads files.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

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

interface OutlineToolResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number };
}

interface OutlineTool {
  name: string;
  description?: string;
  execute: (...args: unknown[]) => Promise<OutlineToolResult>;
}

interface PiCommand {
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, OutlineTool>;
  commands: Map<string, PiCommand>;
  activeTools: () => string[];
}

function createMockPi(): MockPi {
  const tools = new Map<string, OutlineTool>();
  const commands = new Map<string, PiCommand>();
  let active: string[] = [];
  const api = {
    registerTool: (def: OutlineTool) => {
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

async function loadOutlineExtension(): Promise<MockPi> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const mock = createMockPi();
  register(mock.api);
  return mock;
}

function textOf(result: OutlineToolResult): string {
  return result.content[0]?.text ?? "";
}

describe("belayd_outline tool", () => {
  let cwd: string;
  let roots: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-outline-tool-"));
    roots = [cwd];
  });

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function makeCtx(dir: string, sessionId = "outline-session") {
    return {
      sessionManager: { getSessionId: () => sessionId },
      cwd: dir,
      ui: { notify: () => {} },
    };
  }

  it("registers the tool and returns a symbol map without mutating the file", async () => {
    const mock = await loadOutlineExtension();
    const tool = mock.tools.get("belayd_outline");
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    // The description must list every scanned extension, not just .ts/.tsx.
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      expect(tool.description, extension).toContain(extension);
    }

    const source = [
      "export function alpha(): number {",
      "  return 1;",
      "}",
      "export const beta = 2;",
    ].join("\n");
    const file = join(cwd, "sample.ts");
    writeFileSync(file, source);
    const before = readFileSync(file, "utf8");

    const result = await tool.execute("c1", { path: "sample.ts" }, undefined, undefined, {
      cwd,
    });

    expect(result.details.exitCode).toBe(0);
    const text = textOf(result);
    expect(text).toContain("sample.ts (4 lines)");
    expect(text).toContain("1-3");
    expect(text).toContain("alpha [exported]");
    expect(text).toContain("beta");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("rejects a missing path with an error result", async () => {
    const mock = await loadOutlineExtension();
    const tool = mock.tools.get("belayd_outline");
    if (tool === undefined) throw new Error("belayd_outline was not registered");

    const result = await tool.execute("c2", { path: "missing.ts" }, undefined, undefined, {
      cwd,
    });
    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("No such file");
  });

  it("rejects an unknown kind", async () => {
    const mock = await loadOutlineExtension();
    const tool = mock.tools.get("belayd_outline");
    if (tool === undefined) throw new Error("belayd_outline was not registered");

    const result = await tool.execute("c3", { path: ".", kind: ["bogus"] }, undefined, undefined, {
      cwd,
    });
    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("Unknown kind");
  });

  it("filters by name through the registered tool", async () => {
    const mock = await loadOutlineExtension();
    const tool = mock.tools.get("belayd_outline");
    if (tool === undefined) throw new Error("belayd_outline was not registered");

    writeFileSync(
      join(cwd, "names.ts"),
      ["export function alpha() {}", "export function beta() {}"].join("\n"),
    );

    const result = await tool.execute(
      "c4",
      { path: "names.ts", name: "ALP" },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.details.exitCode).toBe(0);
    const text = textOf(result);
    expect(text).toContain("alpha");
    expect(text).not.toContain("beta");
  });

  it("caps symbols with maxSymbols through the registered tool", async () => {
    const mock = await loadOutlineExtension();
    const tool = mock.tools.get("belayd_outline");
    if (tool === undefined) throw new Error("belayd_outline was not registered");

    writeFileSync(
      join(cwd, "many.ts"),
      ["export function a() {}", "export function b() {}", "export function c() {}"].join("\n"),
    );

    const result = await tool.execute(
      "c5",
      { path: "many.ts", maxSymbols: 1 },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.details.exitCode).toBe(0);
    const text = textOf(result);
    expect(text).toContain("note: symbol output truncated by maxSymbols");
    expect(text).not.toContain("  b  ");
  });

  it("rejects non-positive or fractional maxSymbols", async () => {
    const mock = await loadOutlineExtension();
    const tool = mock.tools.get("belayd_outline");
    if (tool === undefined) throw new Error("belayd_outline was not registered");

    for (const maxSymbols of [0, -1, 1.5]) {
      const result = await tool.execute("c6", { path: ".", maxSymbols }, undefined, undefined, {
        cwd,
      });
      expect(result.details.exitCode, `maxSymbols=${maxSymbols}`).toBe(1);
      expect(textOf(result)).toContain("maxSymbols must be a positive integer");
    }
  });

  it("keeps belayd_outline available while the process gate is active (GATED_TOOLS)", async () => {
    const mock = await loadOutlineExtension();
    const startTask = mock.tools.get("belayd_start_task");
    if (startTask === undefined) throw new Error("belayd_start_task was not registered");

    const started = await startTask.execute(
      "gate-1",
      { taskId: "bd-115" },
      undefined,
      undefined,
      makeCtx(cwd, "outline-gate-session"),
    );
    expect(started.details.exitCode).toBe(0);
    expect(mock.activeTools()).toContain("belayd_status");
    expect(mock.activeTools()).toContain("belayd_outline");
  });

  it("excludes belayd_outline from the planning-mode tool set (PLANNING_GATED_TOOLS)", async () => {
    const mock = await loadOutlineExtension();
    const plan = mock.commands.get("plan");
    if (plan === undefined) throw new Error("plan command was not registered");

    await plan.handler("outline large files", makeCtx(cwd, "outline-plan-session"));
    const active = mock.activeTools();
    expect(active).toContain("belayd_plan_scout");
    expect(active).not.toContain("belayd_outline");
  });
});
