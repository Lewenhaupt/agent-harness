/**
 * Regression test for bd-111: the proof gate's freshness floor is captured once
 * per PHASE RUN and reused by every gate retry attempt. If it were refreshed on
 * each attempt, a retry could accept pre-run leftovers instead of artifacts
 * written during the run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateOptions, GateResult } from "../agent-registry.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-proof-freshness-cooldowns.json");

const mockExec = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const stdin = { on: () => {}, end: () => cb(new Error("bd not available"), "", "") };
      return { stdin };
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: mockExec, execFile: mockExecFile };
});

// Record every gate call's freshness floor; always fail so the run retries.
const mockGateProofContent = vi.hoisted(() => vi.fn());

vi.mock("../../src/quality-gates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/quality-gates.js")>();
  return { ...actual, gateProofContent: mockGateProofContent };
});

const mockSpawnAgentWithFallback = vi.hoisted(() => vi.fn());

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return { ...actual, spawnAgentWithFallback: mockSpawnAgentWithFallback };
});

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
}

function createMockPi(): {
  api: ExtensionAPI;
  tools: Map<string, RegisteredTool>;
} {
  const tools = new Map<string, RegisteredTool>();
  const api: ExtensionAPI = {
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
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

async function loadExtension() {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

/** A successful spawn result shaped like the real SpawnWithFallbackResult. */
function fallbackResult(model: string): {
  result: {
    content: Array<{ type: "text"; text: string }>;
    details: { messages: unknown[]; usage: unknown; exitCode: number; model: string };
  };
  attempts: Array<{ model: string; classification: { kind: string } }>;
} {
  return {
    result: {
      content: [{ type: "text", text: `agent output for ${model}` }],
      details: {
        messages: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
          toolCalls: 1,
        },
        exitCode: 0,
        model,
      },
    },
    attempts: [{ model, classification: { kind: "success" } }],
  };
}

function makeCtx(
  sessionId: string,
  cwd: string,
): {
  sessionManager: { getSessionId: () => string };
  cwd: string;
  ui: { notify: () => void };
} {
  return { sessionManager: { getSessionId: () => sessionId }, cwd, ui: { notify: () => {} } };
}

describe("proof freshness floor is per phase run (bd-111)", () => {
  let workDir: string;
  const observedFloors: Array<number | undefined> = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "belayd-proof-freshness-"));
    observedFloors.length = 0;
    mockExec.mockReset();
    mockExec.mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => cb(new Error("git unavailable"), { stdout: "", stderr: "" }),
    );
    mockGateProofContent.mockReset();
    mockGateProofContent.mockImplementation(
      (_output: string, _details: unknown, options?: GateOptions): Promise<GateResult> => {
        observedFloors.push(options?.proofRunStartMs);
        return Promise.resolve({ passed: false, feedback: "forced proof failure" });
      },
    );
    mockSpawnAgentWithFallback.mockReset();
    mockSpawnAgentWithFallback.mockImplementation((options: { model: string }) =>
      Promise.resolve(fallbackResult(options.model)),
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("reuses one freshness floor across gate retry attempts", async () => {
    const { api, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("pfc-1", workDir);
    await tools
      .get("belayd_start_task")
      ?.execute("call-start", { taskId: "bd-42" }, undefined, undefined, ctx);
    await tools
      .get("belayd_proof")
      ?.execute("call-proof", { task: "do proof" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(observedFloors.length).toBeGreaterThanOrEqual(2), {
      timeout: 10_000,
    });

    const first = observedFloors[0];
    expect(first).toBeTypeOf("number");
    for (const floor of observedFloors.slice(1)) {
      expect(floor).toBe(first);
    }
  });
});
