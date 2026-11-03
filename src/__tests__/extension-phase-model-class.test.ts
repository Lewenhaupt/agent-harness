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

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelCooldownPath } from "../model-cooldown.js";
import { listRuns, RunStatus, writeRunManifest } from "../run-manifest.js";

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

// `bd show` now runs through execFile (no shell); fail it because there is no
// bd CLI in tests so workflow resolution falls back to the CLI type argument.
const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const stdin = {
        on: () => {},
        end: () => cb(new Error("bd not available"), "", ""),
      };
      return { stdin };
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: mockExec, execFile: mockExecFile };
});

// Capture every spawnAgentWithFallback call the extension makes; everything
// else from the library stays real (registries, phase order, detached runs).
const mockSpawnAgentWithFallback = vi.hoisted(() => vi.fn());

// The fallback loop's only process boundary. One test drives the REAL
// `spawnAgentWithFallback` (selection-time cooldown refresh included) so this
// mock keeps that path off the disk; the others use the mocked spawn entirely.
const mockSpawnAgentProcess = vi.hoisted(() => vi.fn());

vi.mock("../spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spawn.js")>()),
  spawnAgentProcess: mockSpawnAgentProcess,
}));

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
function fallbackResult(
  model: string,
  text: string = `agent output for ${model}`,
): {
  result: {
    content: Array<{ type: "text"; text: string }>;
    details: { messages: unknown[]; usage: unknown; exitCode: number; model: string };
  };
  attempts: Array<{ model: string; classification: { kind: string } }>;
} {
  return {
    result: {
      content: [{ type: "text", text }],
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

// ── Tests ──────────────────────────────────────────────────────────────

describe("extension modelClass threading", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "belayd-mc-test-"));
    gateState.testFailuresRemaining = 0;
    registryState.featureOverrides = undefined;
    mockSpawnAgentWithFallback.mockReset();
    mockSpawnAgentProcess.mockReset();
    mockSpawnAgentWithFallback.mockImplementation((options: { model: string }) =>
      Promise.resolve(fallbackResult(options.model)),
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    mockExec.mockClear();
    mockExecFile.mockClear();
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
    expect(options?.model).toBe("llmgateway/mimo-v2.6-flash");
    expect(options?.modelClass).toBe("fast");
    expect(options?.detached).toBe(true);
  });

  it("persists no skippedModels key when a run skips nothing", async () => {
    // bd-234 review S1: an empty skip list must not become `skippedModels: []`
    // in every healthy run's manifest. The selection still has to be written,
    // which `model` proves — assert the KEY is absent, not merely empty.
    mockSpawnAgentWithFallback.mockImplementation((options: { model: string }) =>
      Promise.resolve({
        ...fallbackResult(options.model),
        selection: { servedModel: options.model, requestedModel: options.model, skipped: [] },
      }),
    );

    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("mc-manifest", workDir);
    await commands.get("belayd")?.handler("bd-95 feature --no-worktree", ctx);

    const scout = tools.get("belayd_scout");
    expect(scout).toBeDefined();
    await scout?.execute("call-6", { task: "recon the repo" }, undefined, undefined, ctx);

    await vi.waitFor(() => {
      const run = listRuns({ cwd: workDir }).find((entry) => entry.requestedModel !== undefined);
      expect(run?.model).toBe("llmgateway/mimo-v2.6-flash");
    });

    const run = listRuns({ cwd: workDir }).find((entry) => entry.requestedModel !== undefined);
    expect(run).not.toHaveProperty("skippedModels");
  });

  it("serves a phase run through the fallback loop and records the served model", async () => {
    // End-to-end-ish: the extension's own phase spawn runs the real fallback
    // loop (only the pi process is mocked) against a file-backed cooldown store,
    // seeded with bd-234's observed state after this process loaded it, and the
    // run manifest must name the provider that actually served the run.
    const realSpawn = await vi.importActual<typeof import("../spawn-with-fallback.js")>(
      "../spawn-with-fallback.js",
    );
    mockSpawnAgentWithFallback.mockImplementation(realSpawn.spawnAgentWithFallback);
    mockSpawnAgentProcess.mockResolvedValueOnce(
      fallbackResult("commandcode/xiaomi/mimo-v2.6-flash").result,
    );

    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("mc-fallback", workDir);
    await commands.get("belayd")?.handler("bd-234 feature --no-worktree", ctx);

    // Another fleet member's view: opencode-go 24h, llmgateway 5.6h,
    // commandcode clean. Marked through the extension's own file-backed store
    // so the seed lands in the shared cooldown file the way a peer's write
    // would (the cross-process write-after-creation path is pinned separately).
    const cooldownPath = defaultModelCooldownPath();
    const { modelCooldown, modelState } = await import("../../extensions/capabilities/model.js");
    try {
      // The capacity probe answers from its 5-minute cache, so it is primed
      // while every provider is healthy: this run's ordering is then decided by
      // the cooldown store, which is the interleaving that produces skip rows
      // instead of silently reordering the candidates.
      await modelState.capacity.refreshIfStale();
      modelCooldown.markProviderCooldown("opencode-go", 24 * 3600, "quota", { cause: "quota" });
      modelCooldown.markProviderCooldown("llmgateway", 5.6 * 3600, "quota", { cause: "quota" });
      const persisted = JSON.parse(readFileSync(cooldownPath, "utf8")) as {
        providers: Record<string, { until: number }>;
      };
      expect(Object.keys(persisted.providers)).toEqual(
        expect.arrayContaining(["llmgateway", "opencode-go"]),
      );
      expect(persisted.providers.commandcode).toBeUndefined();

      const scout = tools.get("belayd_scout");
      expect(scout).toBeDefined();
      await scout?.execute("call-fb", { task: "recon the repo" }, undefined, undefined, ctx);

      await vi.waitFor(() => {
        const run = listRuns({ cwd: workDir }).find((entry) => entry.requestedModel !== undefined);
        expect(run?.model).toBe("commandcode/xiaomi/mimo-v2.6-flash");
      });

      const run = listRuns({ cwd: workDir }).find((entry) => entry.requestedModel !== undefined);
      // `model` = what served the run, `requestedModel` = the pre-dispatch pick,
      // and the skip rows stay in class preference order (llmgateway first for
      // the fast class primary, then opencode-go).
      expect(run).toHaveProperty("requestedModel", "llmgateway/mimo-v2.6-flash");
      expect(run?.skippedModels).toEqual([
        {
          model: "llmgateway/mimo-v2.6-flash",
          reason:
            "Provider llmgateway is cooling down after a quota failure; skipping remaining models on it.",
        },
        {
          model: "opencode-go/mimo-v2.6-flash",
          reason:
            "Provider opencode-go is cooling down after a quota failure; skipping remaining models on it.",
        },
      ]);
      // One spawn, on the one healthy provider: no wasted attempt on a cooldown.
      expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(1);
      const spawned = mockSpawnAgentProcess.mock.calls[0]?.[0] as { model?: string } | undefined;
      expect(spawned?.model).toBe("commandcode/xiaomi/mimo-v2.6-flash");
    } finally {
      rmSync(cooldownPath, { force: true });
    }
  });

  it("renders a requestedModel-only manifest in belayd_status without inventing a model", async () => {
    // A run that spawned nothing has `requestedModel` but no `model`: the run
    // history table must render its row and leave the model cell empty rather
    // than crash or print `undefined`.
    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);
    const ctx = makeCtx("mc-status", workDir);
    await commands.get("belayd")?.handler("bd-235 feature --no-worktree", ctx);

    const written = writeRunManifest({
      cwd: workDir,
      manifest: {
        schemaVersion: 1,
        runId: "pending-run",
        taskId: "bd-235",
        phase: "scout",
        sessionName: "belayd-bd-235-sub-scout",
        status: RunStatus.Running,
        startedAt: 1_000,
        requestedModel: "llmgateway/mimo-v2.6-flash",
        skippedModels: [
          {
            model: "llmgateway/mimo-v2.6-flash",
            reason: "Provider llmgateway is cooling down after a quota failure.",
          },
        ],
      },
    });
    expect(written).toEqual({ ok: true });

    const status = (await tools
      .get("belayd_status")
      ?.execute("call-status", {}, undefined, undefined, ctx)) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = status.content[0]?.text ?? "";

    expect(text).toContain("Run history");
    expect(text).toContain("| `pending-run` | scout | running |");
    expect(text).not.toContain("undefined");
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
      | { model: string; modelClass?: string; sessionName?: string }
      | undefined;
    // Documentation workflow overrides the implement model without a class:
    // the effective class is undefined so candidatesForModel derives it from
    // the override model — NOT the implementer agent's default "frontier".
    expect(first?.model).toBe("llmgateway/deepseek-v4-flash");
    expect(first?.modelClass).toBeUndefined();

    const retry = mockSpawnAgentWithFallback.mock.calls[1]?.[0] as
      | {
          model: string;
          modelClass?: string;
          sessionName?: string;
          task?: string;
          resumeSession?: boolean;
        }
      | undefined;
    expect(retry?.model).toBe("llmgateway/deepseek-v4-flash");
    // spawnGateRetry intentionally has no `?? agent.modelClass` fallback: with
    // an override model in play that fallback would misclassify the tier.
    expect(retry?.modelClass).toBeUndefined();
    // The first retry resumes the original session rather than minting a new
    // -retry-N id (bd-74).
    expect(retry?.resumeSession).toBe(true);
    expect(retry?.sessionName).toBe(first?.sessionName);
    expect(retry?.task).toContain("Previous attempt failed quality gate");
  });

  it("lets a workflow override modelClass win over the agent default and the override model's class", async () => {
    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("mc-override", workDir);
    await commands.get("belayd")?.handler("bd-91 feature --no-worktree", ctx);

    // glm-5.3-flash is "standard" by itself and the implementer agent declares
    // "frontier"; the explicit override class must beat both.
    registryState.featureOverrides = {
      implement: { model: "opencode-go/glm-5.3-flash", modelClass: "fast" },
    };

    const implement = tools.get("belayd_implement");
    expect(implement).toBeDefined();
    await implement?.execute("call-3", { task: "implement it" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(mockSpawnAgentWithFallback).toHaveBeenCalledTimes(1));

    const options = mockSpawnAgentWithFallback.mock.calls[0]?.[0] as
      | { model: string; modelClass?: string }
      | undefined;
    expect(options?.model).toBe("opencode-go/glm-5.3-flash");
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
    expect(options?.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(options?.modelClass).toBe("frontier");
  });

  it("threads the proof generator's frontier class to spawnAgentWithFallback", async () => {
    // The proof agent declares modelClass "frontier" with no per-role model,
    // so resolveModelSpec resolves to the frontier primary. Its quality gate
    // (gateProofContent) inspects the run output; returning a documented skip
    // reason lets the gate pass on the first attempt so exactly one spawn
    // happens — mirroring the planner's single-spawn assertion shape.
    mockSpawnAgentWithFallback.mockImplementation((options: { model: string }) =>
      Promise.resolve(fallbackResult(options.model, "**Proof skipped:** doc-only")),
    );

    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("mc-proof", workDir);
    await commands.get("belayd")?.handler("bd-93 feature --no-worktree", ctx);

    const proof = tools.get("belayd_proof");
    expect(proof).toBeDefined();
    await proof?.execute("call-5", { task: "capture proof" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect(mockSpawnAgentWithFallback).toHaveBeenCalledTimes(1));

    const options = mockSpawnAgentWithFallback.mock.calls[0]?.[0] as
      | { model: string; modelClass?: string }
      | undefined;
    expect(options?.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(options?.modelClass).toBe("frontier");
  });
});
