/**
 * Tests for the `bd` tool proxy in extensions/index.ts.
 *
 * Regression coverage for the multiline bug: the tool used to interpolate the
 * command string into `/bin/sh -c`, which rejected real newlines and turned
 * escaped `\n` into literal backslash-n. It now parses argv and spawns `bd`
 * without a shell.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

interface ExecFileRecord {
  file: string;
  args: readonly string[];
  stdin: string;
  cwd: string | undefined;
}

const execFileMock = vi.hoisted(() => {
  const calls: ExecFileRecord[] = [];
  const fn = vi.fn(
    (
      file: string,
      args: readonly string[],
      options: { cwd?: string },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const record: ExecFileRecord = { file, args, stdin: "", cwd: options?.cwd };
      calls.push(record);
      const childStdin = {
        on: () => {},
        end: (chunk?: string) => {
          record.stdin = chunk ?? "";
          callback(null, `ran ${file}`, "");
        },
      };
      return { stdin: childStdin };
    },
  );
  return {
    fn,
    calls,
    clear: () => {
      calls.length = 0;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: vi.fn(), execFile: execFileMock.fn };
});

interface BdToolResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number; stderr?: string };
}

interface BdTool {
  name: string;
  execute: (...args: unknown[]) => Promise<BdToolResult>;
}

function createMockPi(): { api: ExtensionAPI; tools: Map<string, BdTool> } {
  const tools = new Map<string, BdTool>();
  const api = {
    registerTool: (def: BdTool) => {
      tools.set(def.name, def);
    },
    registerCommand: () => {},
    on: () => {},
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, tools };
}

async function loadBdTool(): Promise<BdTool> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const { api, tools } = createMockPi();
  register(api);
  const tool = tools.get("bd");
  if (tool === undefined) throw new Error("bd tool was not registered");
  return tool;
}

describe("bd tool proxy", () => {
  let cwd: string;
  let tool: BdTool;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-bd-tool-"));
    execFileMock.clear();
    tool = await loadBdTool();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("passes args as argv without a shell", async () => {
    await tool.execute(
      "c1",
      { command: 'create --title="Fix login" --type=bug' },
      undefined,
      undefined,
      {
        cwd,
      },
    );
    const call = execFileMock.calls[0];
    expect(call?.file).toBe("bd");
    expect(call?.args).toEqual(["create", "--title=Fix login", "--type=bug"]);
  });

  it("preserves a real newline inside a quoted description", async () => {
    await tool.execute(
      "c2",
      { command: 'update bd-42 --description "## Findings\n- x"' },
      undefined,
      undefined,
      { cwd },
    );
    expect(execFileMock.calls[0]?.args).toEqual([
      "update",
      "bd-42",
      "--description",
      "## Findings\n- x",
    ]);
  });

  it("keeps shell metacharacters as literal argv", async () => {
    await tool.execute("c3", { command: "show bd-42; rm -rf /" }, undefined, undefined, { cwd });
    expect(execFileMock.calls[0]?.file).toBe("bd");
    expect(execFileMock.calls[0]?.args).toEqual(["show", "bd-42;", "rm", "-rf", "/"]);
  });

  it("pipes the stdin payload when --stdin is present", async () => {
    await tool.execute(
      "c4",
      { command: "note bd-42 --stdin", stdin: "line one\nline two\n" },
      undefined,
      undefined,
      { cwd },
    );
    expect(execFileMock.calls[0]?.stdin).toBe("line one\nline two\n");
    expect(execFileMock.calls[0]?.args).toEqual(["note", "bd-42", "--stdin"]);
  });

  it("rejects a stdin payload without a stdin-reading flag", async () => {
    const result = await tool.execute(
      "c5",
      { command: "note bd-42 some text", stdin: "dropped" },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toContain("--stdin");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("rejects disallowed subcommands without spawning bd", async () => {
    const result = await tool.execute("c6", { command: "close bd-42" }, undefined, undefined, {
      cwd,
    });
    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toContain("not allowed");
    expect(execFileMock.calls).toHaveLength(0);
  });
});
