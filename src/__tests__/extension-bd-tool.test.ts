/**
 * Tests for the `bd` tool proxy in extensions/index.ts.
 *
 * Regression coverage for the multiline bug: the tool used to interpolate the
 * command string into `/bin/sh -c`, which rejected real newlines and turned
 * escaped `\n` into literal backslash-n. It now parses argv and spawns `bd`
 * without a shell.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitContextFreeEnv } from "../../src/worktree.js";

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

/** A tool ctx with pi's session manager, the way a live session calls it. */
function sessionCtx(sessionName: string, cwd: string): Record<string, unknown> {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName: () => sessionName,
    },
  };
}

describe("bd tool proxy", () => {
  let cwd: string;
  let tool: BdTool;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-bd-tool-"));
    // bd-180: a phase session now resolves authority from the repo root, so the
    // fixture is a real repo with an explicit local authority.
    //
    // The env must be git-context free (bd-58): under a git hook from a LINKED
    // worktree git exports GIT_DIR=<common>/.git/worktrees/<name>, and an
    // inherited value makes `git init` ignore `cwd` — it reinitialises the
    // caller's repository from the worktree admin dir, which rewrites
    // `core.bare = true` in the shared config and breaks every worktree. The
    // wall-clock cost is one process; the alternative is a corrupted checkout.
    execFileSync("git", ["init", "-q"], { cwd, env: gitContextFreeEnv() });
    // Assert the fixture instead of trusting it: without this a leaked context
    // surfaces as nine unrelated assertion failures about authority resolution.
    if (!existsSync(join(cwd, ".git"))) {
      throw new Error(`fixture did not create a repository at ${cwd}`);
    }
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    writeFileSync(join(cwd, ".belayd", "config.json"), JSON.stringify({ authority: "bd" }));
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

  it("attributes a write to the orchestrator session's actor at index 1", async () => {
    await tool.execute(
      "c7",
      { command: "update --add-label from-agent -- bd-150" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150", cwd),
    );
    const args = execFileMock.calls[0]?.args ?? [];
    expect(args).toEqual([
      "update",
      "--actor",
      "belayd:bd-150:orchestrator",
      "--add-label",
      "from-agent",
      "--",
      "bd-150",
    ]);
    // argv[0] stays the subcommand: the read/write guards inspect it.
    expect(args[0]).toBe("update");
    expect(args.indexOf("--actor")).toBeLessThan(args.indexOf("--"));
  });

  it("attributes a write to the phase session's actor", async () => {
    await tool.execute(
      "c8",
      { command: "note bd-150 ok" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150-sub-review-abc123", cwd),
    );
    expect(execFileMock.calls[0]?.args).toEqual([
      "note",
      "--actor",
      "belayd:bd-150:review",
      "bd-150",
      "ok",
    ]);
  });

  it("refuses a phase write when the session repo root cannot be resolved", async () => {
    const outside = mkdtempSync(join(tmpdir(), "belayd-bd-tool-outside-"));
    try {
      const result = await tool.execute(
        "c8b",
        { command: "note bd-150 ok" },
        undefined,
        undefined,
        sessionCtx("belayd-bd-150-sub-review-abc123", outside),
      );
      expect(result.details.exitCode).toBe(1);
      expect(result.content[0]?.text).toContain("authority unresolved");
      expect(execFileMock.calls).toHaveLength(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("applies the GitHub-primary policy to a phase session, not the orchestrator", async () => {
    writeFileSync(
      join(cwd, ".belayd", "config.json"),
      JSON.stringify({ authority: "github", github: { owner: "acme", repo: "widgets" } }),
    );
    const phase = await tool.execute(
      "c8c",
      { command: "update bd-150 -s closed" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150-sub-review-abc123", cwd),
    );
    expect(phase.details.exitCode).toBe(1);
    expect(phase.content[0]?.text).toContain("GitHub owns status");
    expect(execFileMock.calls).toHaveLength(0);

    // The same lifecycle command keeps bd's own local-mode refusal for the
    // orchestrator, which is not subject to the append-only policy.
    const orchestrator = await tool.execute(
      "c8d",
      { command: "close bd-150" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150", cwd),
    );
    expect(orchestrator.details.exitCode).toBe(1);
    expect(orchestrator.content[0]?.text).toContain('bd subcommand "close" is not allowed');
  });

  it("names GitHub as the closure owner for a phase session", async () => {
    writeFileSync(
      join(cwd, ".belayd", "config.json"),
      JSON.stringify({ authority: "github", github: { owner: "acme", repo: "widgets" } }),
    );
    const result = await tool.execute(
      "c8e",
      { command: "close bd-150" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150-sub-review-abc123", cwd),
    );
    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toContain("GitHub owns closure");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("keeps a bd-authority phase session's writes and never forks gh", async () => {
    const result = await tool.execute(
      "c8h",
      { command: "dep add bd-2 bd-1" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150-sub-review-abc123", cwd),
    );
    expect(result.details.exitCode).toBe(0);
    expect(execFileMock.calls).toHaveLength(1);
    expect(execFileMock.calls[0]?.file).toBe("bd");
    expect(execFileMock.calls[0]?.args).toContain("dep");
    // Local mode never reaches a GitHub seam, so no other binary may be spawned.
    expect(execFileMock.calls.every((call) => call.file === "bd")).toBe(true);
  });

  it("keeps reads and appended comments open in a github-primary phase session", async () => {
    writeFileSync(
      join(cwd, ".belayd", "config.json"),
      JSON.stringify({ authority: "github", github: { owner: "acme", repo: "widgets" } }),
    );
    const phase = sessionCtx("belayd-bd-150-sub-review-abc123", cwd);
    const read = await tool.execute(
      "c8i",
      { command: "show bd-150 --json" },
      undefined,
      undefined,
      phase,
    );
    expect(read.details.exitCode).toBe(0);
    const comment = await tool.execute(
      "c8j",
      { command: "comment bd-150 shipped" },
      undefined,
      undefined,
      phase,
    );
    expect(comment.details.exitCode).toBe(0);
    expect(execFileMock.calls).toHaveLength(2);
    expect(execFileMock.calls.every((call) => call.file === "bd")).toBe(true);
  });

  it("exempts the orchestrator from the policy in a github-primary repo", async () => {
    writeFileSync(
      join(cwd, ".belayd", "config.json"),
      JSON.stringify({ authority: "github", github: { owner: "acme", repo: "widgets" } }),
    );
    const result = await tool.execute(
      "c8k",
      { command: "dep add bd-2 bd-1" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150", cwd),
    );
    expect(result.details.exitCode).toBe(0);
    expect(execFileMock.calls[0]?.args).toContain("dep");
  });

  it("resolves the authority from the repo root, not a subdirectory cwd", async () => {
    const nested = join(cwd, "src", "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(cwd, ".belayd", "config.json"),
      JSON.stringify({ authority: "github", github: { owner: "acme", repo: "widgets" } }),
    );
    const result = await tool.execute(
      "c8l",
      { command: "close bd-150" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150-sub-review-abc123", nested),
    );
    expect(result.details.exitCode).toBe(1);
    // Reading the config under the raw cwd would miss it and fall back to bd.
    expect(result.content[0]?.text).toContain("GitHub owns closure");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("refuses a phase write when the authority config is ambiguous", async () => {
    writeFileSync(
      join(cwd, ".belayd", "config.json"),
      JSON.stringify({ authority: "bd", github: { owner: "acme", repo: "widgets" } }),
    );
    const result = await tool.execute(
      "c8m",
      { command: "note bd-150 ok" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150-sub-review-abc123", cwd),
    );
    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toContain("bd write refused");
    expect(result.content[0]?.text).toContain("ambiguous authority");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("refuses a phase write when the session has no working directory", async () => {
    const result = await tool.execute("c8n", { command: "note bd-150 ok" }, undefined, undefined, {
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionName: () => "belayd-bd-150-sub-review-abc123",
      },
    });
    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toContain("no working directory");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("keeps bd's own hierarchy refusal for create --parent in a phase session", async () => {
    writeFileSync(
      join(cwd, ".belayd", "config.json"),
      JSON.stringify({ authority: "github", github: { owner: "acme", repo: "widgets" } }),
    );
    const result = await tool.execute(
      "c8o",
      { command: "create --title=child --parent bd-150" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150-sub-review-abc123", cwd),
    );
    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text).toContain("--parent");
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("warns once per session for the same broken authority config", async () => {
    writeFileSync(join(cwd, ".belayd", "config.json"), "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await tool.execute(
        "c8f",
        { command: "note bd-150 first" },
        undefined,
        undefined,
        sessionCtx("belayd-bd-150-sub-review-abc123", cwd),
      );
      const second = await tool.execute(
        "c8g",
        { command: "note bd-150 second" },
        undefined,
        undefined,
        sessionCtx("belayd-bd-150-sub-review-abc123", cwd),
      );
      expect(first.details.exitCode).toBe(0);
      expect(second.details.exitCode).toBe(0);
      expect(execFileMock.calls).toHaveLength(2);
      const configWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes(".belayd/config.json"),
      );
      expect(configWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("lets an explicit caller --actor win over the injected default", async () => {
    await tool.execute(
      "c9",
      { command: "update --actor custom:actor --add-label x -- bd-150" },
      undefined,
      undefined,
      sessionCtx("belayd-bd-150", cwd),
    );
    const args = [...(execFileMock.calls[0]?.args ?? [])];
    // The injected default is present, and the caller's later `--actor` is the
    // value bd applies, because bd's last flag wins. Positions are deliberately
    // not pinned: the contract is the winning value, not the argv layout.
    const actorValues = args.flatMap((arg, index) => (arg === "--actor" ? [args[index + 1]] : []));
    expect(actorValues).toContain("belayd:bd-150:orchestrator");
    expect(actorValues.at(-1)).toBe("custom:actor");
  });

  it("leaves a human session's write unattributed", async () => {
    await tool.execute(
      "c10",
      { command: "show bd-150" },
      undefined,
      undefined,
      sessionCtx("human-session", cwd),
    );
    expect(execFileMock.calls[0]?.args).toEqual(["show", "bd-150"]);
  });
});
