/**
 * Tests for the extension's modelClass threading (bd-36).
 *
 * The AC "all sub agents use modelClass" is otherwise only verified
 * transitively (spawn-with-fallback consumes it; DEFAULT_AGENTS declare it).
 * These tests drive the real extension factory with a mocked
 * `spawnAgentWithFallback` and assert the effective modelClass at the spawn
 * boundary, covering:
 * - agent-default modelClass threading (scout → "fast")
 * - workflow model override without a class → modelClass undefined (the class
 *   is derived from the override model inside candidatesForModel)
 * - gate-retry (spawnGateRetry) pass-through of the same effective model/modelClass
 *   (the documentation workflow used for this gate-retry test is a real
 *   workflow-registry entry; only the `feature` entry is patched via
 *   registryState, not synthesized)
 * - explicit override modelClass winning over both the agent default and the
 *   override model's own class
 *
 * Note on spawnGateRetry's model/modelClass asymmetry
 * (extensions/index.ts): `model` falls back to `resolveModelSpec(agent).model`
 * while `modelClass` does not fall back to `agent.modelClass`. That is correct
 * as long as runQualityGate always passes the resolved effective pair: when a
 * workflow overrides the model without a class, a blanket
 * `?? agent.modelClass` fallback would misclassify the override model with the
 * agent's default tier. The documentation-workflow test below pins this
 * behavior (retry receives modelClass undefined alongside the override model).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────

// Isolate the extension's persistent cooldown store and proof base from the
// real user directories. Both are resolved when the extension module loads
// (dynamic import below), so they must be set first.
process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-mc-cooldowns.json");
process.env.BELAYD_PROOF_DIR = join(tmpdir(), "belayd-test-mc-proof");

// Gate outcome control: how many remaining "pnpm test" runs must fail.
const gateState = vi.hoisted(() => ({ testFailuresRemaining: 0 }));

// Workflow-override control for the feature registry entry the extension
// reads (only the extension's view is patched; getPhasesForType and
// resolveQualityGate keep using the real registry).
const registryState = vi.hoisted(() => ({
  featureOverrides: undefined as
    | Record<string, { model?: string; modelClass?: string }>
    | undefined,
}));

// `bd show` fails (no bd CLI in tests) so workflow resolution falls back to
// the CLI type argument; pnpm gate commands are steered by gateState.
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

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: mockExec };
});

// Capture every spawnAgentWithFallback call the extension makes; everything
// else from the library stays real (registries, phase order, detached runs).
const mockSpawnAgentWithFallback = vi.hoisted(() => vi.fn());

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return {
    ...actual,
    spawnAgentWithFallback: mockSpawnAgentWithFallback,
    // Getter so a test can install feature-workflow overrides after module
    // load but before the phase tool runs.
    get WORKFLOW_REGISTRY() {
      return {
        ...actual.WORKFLOW_REGISTRY,
        feature: {
          ...actual.WORKFLOW_REGISTRY.feature,
          get agentOverrides() {
            return registryState.featureOverrides;
          },
        },
      };
    },
  };
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
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
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

// ── Tests ──────────────────────────────────────────────────────────────

describe("extension modelClass threading", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "belayd-mc-test-"));
    gateState.testFailuresRemaining = 0;
    registryState.featureOverrides = undefined;
    mockSpawnAgentWithFallback.mockReset();
    mockSpawnAgentWithFallback.mockImplementation((options: { model: string }) =>
      Promise.resolve(fallbackResult(options.model)),
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    mockExec.mockClear();
  });

  it("threads the agent's declared modelClass to spawnAgentWithFallback", async () => {
    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("mc-scout", workDir);
    // Phase runs need an active task id for session naming; activate in place.
    await commands.get("belayd")?.handler("bd-90 feature --no-worktree", ctx);

    const scout = tools.get("belayd_scout");
    expect(scout).toBeDefined();

    // Fresh session id: the extension keeps per-session state in a module map.
    await scout?.execute("call-1", { task: "recon the repo" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(mockSpawnAgentWithFallback).toHaveBeenCalledTimes(1));

    const options = mockSpawnAgentWithFallback.mock.calls[0]?.[0] as
      | { model: string; modelClass?: string; detached?: boolean }
      | undefined;
    expect(options?.model).toBe("opencode-go/mimo-v2.5");
    expect(options?.modelClass).toBe("fast");
    expect(options?.detached).toBe(true);
  });

  it("passes modelClass undefined for a workflow model override without a class, including gate retries", async () => {
    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("mc-doc", workDir);
    // --no-worktree: activate the documentation workflow in place (no daemon).
    await commands.get("belayd")?.handler("bd-99 documentation --no-worktree", ctx);

    // The implement phase's gate (gateFullValidation) fails once on tests,
    // forcing one spawnGateRetry before the run settles.
    gateState.testFailuresRemaining = 1;

    const implement = tools.get("belayd_implement");
    expect(implement).toBeDefined();
    await implement?.execute(
      "call-2",
      { task: "implement it", cwd: workDir },
      undefined,
      undefined,
      ctx,
    );

    await vi.waitFor(() => expect(mockSpawnAgentWithFallback).toHaveBeenCalledTimes(2));

    const first = mockSpawnAgentWithFallback.mock.calls[0]?.[0] as
      | { model: string; modelClass?: string }
      | undefined;
    // Documentation workflow overrides the implement model without a class:
    // the effective class is undefined so candidatesForModel derives it from
    // the override model — NOT the implementer agent's default "frontier".
    expect(first?.model).toBe("opencode-go/deepseek-v4-flash");
    expect(first?.modelClass).toBeUndefined();

    const retry = mockSpawnAgentWithFallback.mock.calls[1]?.[0] as
      | { model: string; modelClass?: string; sessionName?: string; task?: string }
      | undefined;
    expect(retry?.model).toBe("opencode-go/deepseek-v4-flash");
    // spawnGateRetry intentionally has no `?? agent.modelClass` fallback: with
    // an override model in play that fallback would misclassify the tier.
    expect(retry?.modelClass).toBeUndefined();
    expect(retry?.sessionName).toContain("-retry-1");
    expect(retry?.task).toContain("Previous attempt failed quality gate");
  });

  it("lets a workflow override modelClass win over the agent default and the override model's class", async () => {
    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("mc-override", workDir);
    await commands.get("belayd")?.handler("bd-91 feature --no-worktree", ctx);

    // glm-5.2 is "standard" by itself and the implementer agent declares
    // "frontier"; the explicit override class must beat both.
    registryState.featureOverrides = {
      implement: { model: "opencode-go/glm-5.2", modelClass: "fast" },
    };

    const implement = tools.get("belayd_implement");
    expect(implement).toBeDefined();
    await implement?.execute("call-3", { task: "implement it" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(mockSpawnAgentWithFallback).toHaveBeenCalledTimes(1));

    const options = mockSpawnAgentWithFallback.mock.calls[0]?.[0] as
      | { model: string; modelClass?: string }
      | undefined;
    expect(options?.model).toBe("opencode-go/glm-5.2");
    expect(options?.modelClass).toBe("fast");
  });

  it("resolves the planner's class-only declaration to the frontier primary (no per-role model pick)", async () => {
    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("mc-plan", workDir);
    await commands.get("belayd")?.handler("bd-92 feature --no-worktree", ctx);

    const plan = tools.get("belayd_plan");
    expect(plan).toBeDefined();
    await plan?.execute("call-4", { task: "plan it" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(mockSpawnAgentWithFallback).toHaveBeenCalledTimes(1));

    const options = mockSpawnAgentWithFallback.mock.calls[0]?.[0] as
      | { model: string; modelClass?: string }
      | undefined;
    expect(options?.model).toBe("opencode-go/deepseek-v4-pro");
    expect(options?.modelClass).toBe("frontier");
  });
});
