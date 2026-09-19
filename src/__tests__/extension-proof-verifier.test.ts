/**
 * Extension tests for the advisory proof verifier (bd-48).
 *
 * Drives the real extension factory with a mocked spawn and asserts:
 * - `belayd_proof_verifier` is registered and present in GATED_TOOLS
 * - the skip path returns exitCode 0 without spawning when there are no
 *   artifact references and no change context
 * - a completed proof phase captures output and the verifier records a
 *   non-blocking verdict (exitCode 0 even when the judge "fails")
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the extension's persistent cooldown store and proof base.
process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-pv-cooldowns.json");
process.env.BELAYD_PROOF_DIR = join(tmpdir(), "belayd-test-pv-proof");

const mockExec = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      // git change-context commands produce no output → empty context.
      cb(null, { stdout: "", stderr: "" });
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: mockExec };
});

const mockSpawnAgentWithFallback = vi.hoisted(() => vi.fn());

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return { ...actual, spawnAgentWithFallback: mockSpawnAgentWithFallback };
});

function createMockPi(): {
  api: ExtensionAPI;
  tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  activeTools: () => string[];
} {
  const tools = new Map<
    string,
    { name: string; execute: (...args: unknown[]) => Promise<unknown> }
  >();
  let active: string[] = [];

  const api: ExtensionAPI = {
    registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(def.name, def);
    },
    registerCommand: () => {},
    on: () => {},
    sendMessage: () => {},
    getActiveTools: () => active,
    setActiveTools: (list: string[]) => {
      active = list;
    },
    events: {
      emit: () => {},
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;

  return { api, tools, activeTools: () => active };
}

function makeCtx(sessionId: string, cwd: string) {
  return { sessionManager: { getSessionId: () => sessionId }, cwd, ui: { notify: () => {} } };
}

async function loadExtension() {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

describe("belayd_proof_verifier (bd-48)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "belayd-pv-test-"));
    mockExec.mockReset();
    // Empty git context by default.
    mockExec.mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => cb(null, { stdout: "", stderr: "" }),
    );
    mockSpawnAgentWithFallback.mockReset();
    mockSpawnAgentWithFallback.mockResolvedValue({
      result: {
        content: [
          {
            type: "text" as const,
            text: "## Verdict\nreasonable: true\nreason: ok\nevidence: cast",
          },
        ],
        details: {
          messages: [],
          usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
          exitCode: 0,
        },
      },
      attempts: [],
    });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("registers the proof verifier tool outside the phase-tool loop", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    expect(tools.has("belayd_proof_verifier")).toBe(true);
    // The phase-tool loop only creates tools for DEFAULT_AGENTS; the verifier
    // tool must exist next to (not inside) the phase tool names.
    expect(tools.get("belayd_proof_verifier")?.name).toBe("belayd_proof_verifier");
  });

  it("adds belayd_proof_verifier to GATED_TOOLS when the gate activates", async () => {
    const { api, tools, activeTools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const startTask = tools.get("belayd_start_task");
    await startTask?.execute(
      "call-1",
      { taskId: "bd-48" },
      undefined,
      undefined,
      makeCtx("pv-1", workDir),
    );

    expect(activeTools()).toContain("belayd_proof_verifier");
  });

  it("skips without spawning when no artifacts and no change context", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("pv-skip", workDir);
    const tool = tools.get("belayd_proof_verifier");
    expect(tool).toBeDefined();

    const result = (await tool?.execute(
      "call-skip",
      { task: "bd-48" },
      undefined,
      undefined,
      ctx,
    )) as {
      content: Array<{ text: string }>;
      details: { exitCode: number };
    };

    expect(result.details.exitCode).toBe(0);
    expect(result.content[0]?.text).toContain("skipped");
    expect(mockSpawnAgentWithFallback).not.toHaveBeenCalled();
  });

  it("records an unavailable context without crashing when git fails", async () => {
    mockExec.mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => cb(new Error("git unavailable"), { stdout: "", stderr: "" }),
    );

    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("pv-git-fail", workDir);
    await tools
      .get("belayd_start_task")
      ?.execute("call-1", { taskId: "bd-48" }, undefined, undefined, ctx);

    const tool = tools.get("belayd_proof_verifier");
    const result = (await tool?.execute(
      "call-git-fail",
      { task: "bd-48" },
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ text: string }>; details: { exitCode: number } };

    // Git failures produce an advisory "unavailable" change context, so the
    // verifier still spawns and returns a non-blocking verdict.
    expect(result.details.exitCode).toBe(0);
    expect(result.content[0]?.text).toContain("## Verdict");
    expect(mockSpawnAgentWithFallback).toHaveBeenCalledTimes(1);
    const options = mockSpawnAgentWithFallback.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(options.task)).toContain("unavailable");
  });

  it("records a verdict without failing when the judge returns an exit code", async () => {
    mockSpawnAgentWithFallback.mockResolvedValue({
      result: {
        content: [
          {
            type: "text" as const,
            text: "## Verdict\nreasonable: false\nreason: weak\nevidence: none",
          },
        ],
        details: {
          messages: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
          exitCode: 1,
        },
      },
      attempts: [],
    });

    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("pv-verdict", workDir);

    // Simulate a captured proof output by activating the gate and stashing
    // a proof reference through the verifier's `proof` override.
    await tools
      .get("belayd_start_task")
      ?.execute("call-1", { taskId: "bd-48" }, undefined, undefined, ctx);

    const tool = tools.get("belayd_proof_verifier");
    const result = (await tool?.execute(
      "call-verdict",
      { task: "bd-48", proof: "proof-of-work/bd-48/demo.cast" },
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ text: string }>; details: { exitCode: number } };

    // Non-blocking: exit code is always 0 even if the judge result had exit 1.
    expect(result.details.exitCode).toBe(0);
    expect(result.content[0]?.text).toContain("## Verdict");
    expect(mockSpawnAgentWithFallback).toHaveBeenCalledTimes(1);

    // The spawn is not a detached phase run and uses the verifier session prefix.
    const options = mockSpawnAgentWithFallback.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.detached).toBe(false);
    expect(options.sessionName).toMatch(/^belayd-proof-verifier-/);
  });
});
