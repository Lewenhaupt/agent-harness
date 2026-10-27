/**
 * Metrics log wiring tests (bd-140 acceptance).
 *
 * The unit tests cover the builders, the append and the queries; these drive the
 * real extension factory so the acceptance criteria are proven on the code path
 * that actually runs a phase:
 * - a phase spawn appends `run_start`, every gate attempt appends
 *   `gate_result` (a retry is `attempt: 2`), a completed phase appends
 *   `phase_advance`, and delivery appends `run_end`
 * - `BELAYD_METRICS=0` writes nothing at all
 *
 * `src/__tests__/setup-env.ts` disables the log for the whole suite, so each test
 * here turns it on against its own temp directory instead of the operator's
 * state directory.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METRICS_DIR_ENV, METRICS_ENABLED_ENV, type MetricsEvent } from "../metrics.js";

// Isolate the extension's persistent cooldown store and proof base from the real
// user directories; both resolve when the extension module loads below.
process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-metrics-cooldowns.json");
process.env.BELAYD_PROOF_DIR = join(tmpdir(), "belayd-test-metrics-proof");

// Number of `pnpm test` runs the gate must still see fail.
const gateState = vi.hoisted(() => ({ testFailuresRemaining: 0 }));

const mockExec = vi.hoisted(() =>
  vi.fn(
    (
      cmd: string,
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      if (cmd.startsWith("pnpm test")) {
        if (gateState.testFailuresRemaining > 0) {
          gateState.testFailuresRemaining -= 1;
          cb(new Error("tests failed"), { stdout: "", stderr: "tests failed" });
          return;
        }
        cb(null, { stdout: "ok", stderr: "" });
        return;
      }
      if (cmd.startsWith("pnpm typecheck") || cmd.startsWith("pnpm lint")) {
        cb(null, { stdout: "ok", stderr: "" });
        return;
      }
      cb(new Error("bd not available"), { stdout: "", stderr: "" });
    },
  ),
);

// `bd show` runs through execFile (no shell); fail it because there is no bd CLI
// in tests, so workflow resolution falls back to the CLI type argument.
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

const mockSpawnAgentWithFallback = vi.hoisted(() => vi.fn());

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return { ...actual, spawnAgentWithFallback: mockSpawnAgentWithFallback };
});

// ── Helpers ────────────────────────────────────────────────────────────

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
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  tools: Map<string, RegisteredTool>;
} {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools = new Map<string, RegisteredTool>();

  const api: ExtensionAPI = {
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (
      name: string,
      cmd: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, cmd);
    },
    on: () => {},
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: {
      emit: () => {},
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;

  return { api, commands, tools };
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
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 0,
          cost: 0.5,
          turns: 1,
          toolCalls: 2,
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

/** Read every event the run appended under `dir`, oldest file first. */
function readEvents(dir: string): MetricsEvent[] {
  const files = readdirSync(dir)
    .filter((entry) => entry.startsWith("events-") && entry.endsWith(".jsonl"))
    .sort();
  return files.flatMap((file) =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as MetricsEvent),
  );
}

function eventsNamed(events: readonly MetricsEvent[], name: MetricsEvent["event"]): MetricsEvent[] {
  return events.filter((event) => event.event === name);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("extension metrics wiring", { timeout: 20_000 }, () => {
  let workDir: string;
  let metricsDir: string;
  let previousMetricsEnabled: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "belayd-metrics-flow-"));
    metricsDir = mkdtempSync(join(tmpdir(), "belayd-metrics-events-"));
    previousMetricsEnabled = process.env[METRICS_ENABLED_ENV];
    // setup-env.ts pins the kill switch for the suite; this file opts back in.
    process.env[METRICS_ENABLED_ENV] = "1";
    process.env[METRICS_DIR_ENV] = metricsDir;
    gateState.testFailuresRemaining = 0;
    mockSpawnAgentWithFallback.mockReset();
    mockSpawnAgentWithFallback.mockImplementation((options: { model: string }) =>
      Promise.resolve(fallbackResult(options.model)),
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(metricsDir, { recursive: true, force: true });
    if (previousMetricsEnabled === undefined) delete process.env[METRICS_ENABLED_ENV];
    else process.env[METRICS_ENABLED_ENV] = previousMetricsEnabled;
    delete process.env[METRICS_DIR_ENV];
  });

  it("appends run_start, both gate attempts and run_end, with attempt 2 on the retry", async () => {
    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("metrics-retry", workDir);
    // --no-worktree activates the workflow in place (no worktree daemon).
    await commands.get("belayd")?.handler("bd-95 documentation --no-worktree", ctx);
    // Fail the gate once, forcing exactly one gate retry.
    gateState.testFailuresRemaining = 1;

    const implement = tools.get("belayd_implement");
    expect(implement).toBeDefined();
    await implement?.execute(
      "call-1",
      { task: "implement it", cwd: workDir },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(
      () => {
        expect(eventsNamed(readEvents(metricsDir), "run_end")).toHaveLength(1);
      },
      { timeout: 10_000 },
    );

    const events = readEvents(metricsDir);
    const starts = eventsNamed(events, "run_start");
    expect(starts).toHaveLength(1);
    const start = starts[0];
    expect(start).toHaveProperty("task", "bd-95");
    expect(start).toHaveProperty("phase", "implement");
    expect(start).toHaveProperty("workflowType", "documentation");
    expect(start).toHaveProperty("ts");
    expect(start).toHaveProperty("host");
    expect(start).toHaveProperty("model");
    if (start?.event !== "run_start") throw new Error("unreachable");

    const gates = eventsNamed(events, "gate_result");
    expect(gates).toHaveLength(2);
    const attempts = gates.map((event) => (event.event === "gate_result" ? event.attempt : -1));
    expect(attempts).toEqual([1, 2]);
    expect(gates.map((event) => (event.event === "gate_result" ? event.passed : null))).toEqual([
      false,
      true,
    ]);
    for (const gate of gates) {
      if (gate.event !== "gate_result") throw new Error("unreachable");
      expect(gate.task).toBe("bd-95");
      expect(gate.phase).toBe("implement");
      // A verdict is tied to the spawn whose output it judged.
      expect(gate.runId).toBe(start.runId);
      expect(typeof gate.durationMs).toBe("number");
    }

    // A completed phase advances the workflow, and its next phase is recorded.
    const advances = eventsNamed(events, "phase_advance");
    expect(advances).toHaveLength(1);
    expect(advances[0]).toHaveProperty("phase", "implement");

    const ends = eventsNamed(events, "run_end");
    const end = ends[0];
    if (end?.event !== "run_end") throw new Error("unreachable");
    expect(end.task).toBe("bd-95");
    expect(end.phase).toBe("implement");
    expect(end.runId).toBe(start.runId);
    expect(end.status).toBe("completed");
    expect(end.exitCode).toBe(0);
    expect(end.toolCalls).toBe(2);
    expect(end.cost).toBe(0.5);
    expect(end.tokensIn).toBe(10);
    expect(end.tokensOut).toBe(20);
    expect(end.tokensCacheRead).toBe(30);
    expect(typeof end.wallMs).toBe("number");
  });

  it("writes nothing when BELAYD_METRICS=0", async () => {
    process.env[METRICS_ENABLED_ENV] = "0";
    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("metrics-disabled", workDir);
    await commands.get("belayd")?.handler("bd-96 documentation --no-worktree", ctx);

    const implement = tools.get("belayd_implement");
    expect(implement).toBeDefined();
    await implement?.execute(
      "call-2",
      { task: "implement it", cwd: workDir },
      undefined,
      undefined,
      ctx,
    );

    // The run still spawns; only the metrics append is skipped.
    await vi.waitFor(() => expect(mockSpawnAgentWithFallback).toHaveBeenCalled());
    expect(readdirSync(metricsDir)).toEqual([]);
  });
});
