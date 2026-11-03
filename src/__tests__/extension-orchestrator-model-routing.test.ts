/**
 * Orchestrator session model routing at launch (bd-229).
 *
 * `/belayd`, `belayd_start_followup` and fleet members all create their child
 * session through `createOrchestratorSession`, and pi-web starts that session on
 * the operator's global default model — llmgateway in the live failure. The
 * harness's cooldown/capacity knowledge was only ever consulted for spawned
 * sub-agents, so every child died on its first turn with
 * `402 … "code":"billing_error"`.
 *
 * These drive `createLaunch` directly: the launch must either move the session
 * onto an available candidate before it is prompted, or refuse before any
 * session, lease or workflow state exists.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLaunch } from "../../extensions/capabilities/launch.js";
import { type CapacityCache, createCapacityCache } from "../capacity-cache.js";
import { buildHandoff } from "../handoff.js";
import { createModelCooldownStore } from "../model-cooldown.js";
import { workflowStateFilePath } from "../workflow-state.js";

// ── Mocks ──────────────────────────────────────────────────────────────

// Nothing in this path may spawn a real process: `bd` lookups fail (the temp
// project is not a beads workspace) and git probes report "not a repository".
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fail = (_file: string, _args: readonly string[], _o: unknown, cb: (e: Error) => void) => {
    cb(new Error("no bd in tests"));
    return { stdin: { on: () => {}, end: () => {} } };
  };
  return {
    ...actual,
    exec: vi.fn(),
    execFile: vi.fn(fail),
    execFileSync: vi.fn(() => {
      throw new Error("not a git repository");
    }),
    execSync: vi.fn(() => {
      throw new Error("not a git repository");
    }),
  };
});

const daemon = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const state = {
    sessionModel: undefined as { provider: string; id: string } | undefined,
    /** Hook a test can install to act between session creation and routing. */
    onCreateSession: undefined as (() => void) | undefined,
  };
  return {
    calls,
    state,
    clear: () => {
      calls.length = 0;
      state.sessionModel = undefined;
      state.onCreateSession = undefined;
    },
  };
});

const mockHttpRequest = vi.hoisted(() =>
  vi.fn(
    (
      opts: { method?: string; path?: string },
      callback: (res: {
        statusCode: number;
        on: (event: string, handler: (chunk: string) => void) => void;
      }) => void,
    ) => {
      const path = opts.path ?? "";
      let data = "{}";
      if (opts.method === "POST" && path === "/sessions") {
        daemon.state.onCreateSession?.();
        data = JSON.stringify({ id: "sess-child" });
      } else if (opts.method === "GET" && path.startsWith("/sessions/sess-child/status")) {
        data = JSON.stringify(
          daemon.state.sessionModel === undefined ? {} : { model: daemon.state.sessionModel },
        );
      }
      callback({
        statusCode: 200,
        on: vi.fn((event: string, handler: (chunk: string) => void) => {
          if (event === "data") handler(data);
          if (event === "end") handler("");
        }),
      });
      return {
        on: vi.fn(),
        write: vi.fn((body: string) => {
          daemon.calls.push({ method: opts.method ?? "", path, body });
        }),
        end: vi.fn(),
      };
    },
  ),
);

vi.mock("node:http", () => ({ request: mockHttpRequest }));

// ── Fixtures ───────────────────────────────────────────────────────────

const LLM = { provider: "llmgateway", id: "deepseek-v4.1-flash-1017" };
/** Providers a frontier class candidate can land on. */
const ALL_PROVIDERS = ["llmgateway", "opencode-go", "commandcode", "openrouter"];

let projectRoot: string;
let worktreePath: string;
let cooldownPath: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "belayd-launch-routing-"));
  worktreePath = `${projectRoot}.feat-bd-229`;
  mkdirSync(worktreePath, { recursive: true });
  cooldownPath = join(projectRoot, "cooldowns.json");
  daemon.clear();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(worktreePath, { recursive: true, force: true });
  mockHttpRequest.mockClear();
});

/** Write provider cooldowns in the shape the cooldown store persists. */
function writeCooldowns(providers: readonly string[], resetInMinutes = 120): void {
  const until = Date.now() + resetInMinutes * 60_000;
  const entries = Object.fromEntries(
    providers.map((provider) => [
      provider,
      { until, reason: "Quota/credit/rate limit (HTTP 402).", cause: "quota" },
    ]),
  );
  writeFileSync(cooldownPath, JSON.stringify({ version: 1, providers: entries, models: {} }));
}

/**
 * A launch whose routing state is per-test (no shared module state): the
 * capacity cache probes the cooldown store, which is the same wiring the
 * composer uses. `capacity` can be injected to isolate one signal.
 */
function createTestLaunch(options: { enabled?: boolean; capacity?: CapacityCache } = {}) {
  const cooldownStore = createModelCooldownStore({ filePath: cooldownPath });
  const capacity =
    options.capacity ??
    createCapacityCache({
      probe: () => {
        cooldownStore.refresh();
        return {
          windows: [...cooldownStore.providerEntries()].map(([provider, entry]) => ({
            provider,
            resetAt: entry.until,
            reason: entry.reason,
          })),
        };
      },
    });
  const launch = createLaunch({
    pi: { sendMessage: vi.fn() } as unknown as ExtensionAPI,
    getSessionState: () =>
      ({ activeRuns: new Map(), heldLeaseSessionId: undefined, gateActive: false }) as never,
    core: { disarmForHandoff: vi.fn(), reportHandoffProblem: vi.fn() },
    stopOrchestratorLeaseTimer: vi.fn(),
    modelRouting: { cooldownStore, capacity, enabled: options.enabled ?? true },
    seams: {
      setupWorktree: () => worktreePath,
      awaitWorktreeReady: async () => ({ ok: true }),
      readStackNode: () => undefined,
      collectHandoffDefault: async (input) =>
        buildHandoff({
          taskId: input.taskId,
          workflowType: input.workflowType,
          branch: input.branch,
          worktreePath: input.worktreePath,
        }),
      stripBdShowComments: (stdout) => stdout,
    },
  });
  return { launch };
}

function createCtx(model?: { provider: string; id: string }) {
  const notify = vi.fn();
  const ctx = {
    cwd: projectRoot,
    ui: { notify },
    ...(model === undefined ? {} : { model }),
    sessionManager: {
      getSessionId: () => "caller-session",
      getSessionName: () => "orchestrator-session",
      getSessionFile: () => join(projectRoot, "session.jsonl"),
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;
  return { ctx, notify };
}

function launchWorkflow(ctx: ExtensionContext, options: { enabled?: boolean } = {}) {
  const { launch } = createTestLaunch(options);
  return launch.launchWorktreeWorkflow({
    ctx,
    taskId: "bd-229",
    workflowType: "bugfix",
    branch: "feat/bd-229",
  });
}

const pathIndex = (suffix: string) => daemon.calls.findIndex((call) => call.path.endsWith(suffix));

// ── Tests ──────────────────────────────────────────────────────────────

describe("orchestrator launch model routing", () => {
  it("moves the child session off a spent provider before prompting it", async () => {
    writeCooldowns(["llmgateway"]);
    daemon.state.sessionModel = LLM;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = createCtx(LLM);

    const result = await launchWorkflow(ctx);

    expect(result.ok).toBe(true);
    const modelCall = daemon.calls.find((call) => call.path === "/sessions/sess-child/model");
    expect(modelCall).toBeDefined();
    const body = JSON.parse(modelCall?.body ?? "{}") as {
      cwd?: string;
      provider?: string;
      modelId?: string;
    };
    // llmgateway is cooling, so the same model on its next preferred provider wins.
    expect(body.provider).toBe("opencode-go");
    expect(body.modelId).toBe("deepseek-v4.1-flash");
    // The daemon scopes per-session routes by cwd.
    expect(body.cwd).toBe(worktreePath);
    // The model is set while the session is still idle, before it is prompted.
    expect(pathIndex("/model")).toBeLessThan(pathIndex("/prompt"));
    // The switch is announced, so an operator can see why the run moved.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("opencode-go"));
    warn.mockRestore();
  });

  it("leaves a healthy session model alone", async () => {
    daemon.state.sessionModel = LLM;
    const { ctx } = createCtx(LLM);

    const result = await launchWorkflow(ctx);

    expect(result.ok).toBe(true);
    expect(pathIndex("/model")).toBe(-1);
    expect(pathIndex("/prompt")).toBeGreaterThan(-1);
  });

  it("sees a cooldown another process wrote after the store was created", async () => {
    // The capacity signal reports nothing, so only the cooldown store can block
    // a candidate here. The store is created first and the file is written
    // afterwards: on a creation-time snapshot llmgateway looks healthy and the
    // launch would be refused, so this pins the preflight refresh (bd-234).
    const capacity = createCapacityCache({ probe: () => ({ windows: [] }) });
    const { launch } = createTestLaunch({ capacity });
    writeCooldowns(["llmgateway"]);
    daemon.state.sessionModel = LLM;
    const { ctx } = createCtx(LLM);

    const result = await launch.launchWorktreeWorkflow({
      ctx,
      taskId: "bd-229",
      workflowType: "bugfix",
      branch: "feat/bd-229",
    });

    expect(result.ok).toBe(true);
    const modelCall = daemon.calls.find((call) => call.path === "/sessions/sess-child/model");
    const body = JSON.parse(modelCall?.body ?? "{}") as { provider?: string };
    expect(body.provider).toBe("opencode-go");
  });

  it("refuses before any side effect when another process spent every provider after the store loaded", async () => {
    // The store is created (empty snapshot) before the file is written, and the
    // capacity signal is isolated, so only the preflight's own refresh can see
    // the cooldowns. Without it this launch would create a session that cannot
    // serve a single turn.
    const capacity = createCapacityCache({ probe: () => ({ windows: [] }) });
    const { launch } = createTestLaunch({ capacity });
    writeCooldowns(ALL_PROVIDERS);
    daemon.state.sessionModel = LLM;
    const { ctx } = createCtx(LLM);

    const result = await launch.launchWorktreeWorkflow({
      ctx,
      taskId: "bd-234",
      workflowType: "bugfix",
      branch: "feat/bd-234",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Refusing to launch");
    expect(result.error).toContain("llmgateway");
    // Nothing was created: the refusal precedes every side effect.
    expect(daemon.calls.some((call) => call.method === "POST" && call.path === "/sessions")).toBe(
      false,
    );
  });

  it("re-checks the shared cooldown store when routing the created child", async () => {
    // Preflight runs while every provider is healthy; the operator's fleet spends
    // llmgateway between session creation and the post-create check. The capacity
    // probe is isolated, so only `routeOrchestratorModel`'s own refresh can move
    // the child off the provider that just went away.
    const capacity = createCapacityCache({ probe: () => ({ windows: [] }) });
    const { launch } = createTestLaunch({ capacity });
    daemon.state.sessionModel = LLM;
    daemon.state.onCreateSession = () => writeCooldowns(["llmgateway"]);
    const { ctx } = createCtx(LLM);

    const result = await launch.launchWorktreeWorkflow({
      ctx,
      taskId: "bd-234",
      workflowType: "bugfix",
      branch: "feat/bd-234",
    });

    expect(result.ok).toBe(true);
    const modelCall = daemon.calls.find((call) => call.path === "/sessions/sess-child/model");
    const body = JSON.parse(modelCall?.body ?? "{}") as { provider?: string };
    expect(body.provider).toBe("opencode-go");
    expect(pathIndex("/model")).toBeLessThan(pathIndex("/prompt"));
  });

  it("routes even when the caller's model differs from the child's", async () => {
    // The child is the authoritative one: preflight on a healthy caller passes,
    // and the post-create check still moves the blocked child.
    writeCooldowns(["llmgateway"]);
    daemon.state.sessionModel = LLM;
    const { ctx } = createCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });

    const result = await launchWorkflow(ctx);

    expect(result.ok).toBe(true);
    const modelCall = daemon.calls.find((call) => call.path === "/sessions/sess-child/model");
    const body = JSON.parse(modelCall?.body ?? "{}") as { provider?: string };
    expect(body.provider).not.toBe("llmgateway");
  });

  it("refuses before any side effect when every provider is spent", async () => {
    writeCooldowns(ALL_PROVIDERS);
    daemon.state.sessionModel = LLM;
    const { ctx } = createCtx(LLM);

    const result = await launchWorkflow(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Refusing to launch");
    expect(result.error).toContain("llmgateway");
    expect(result.error).toContain("resets");
    // No session, no prompt, no workflow state: the launch left no trace.
    expect(daemon.calls.some((call) => call.method === "POST" && call.path === "/sessions")).toBe(
      false,
    );
    expect(existsSync(workflowStateFilePath(worktreePath))).toBe(false);
  });

  it("skips routing entirely when fallback is disabled", async () => {
    writeCooldowns(["llmgateway"]);
    daemon.state.sessionModel = LLM;
    const { ctx } = createCtx(LLM);

    const result = await launchWorkflow(ctx, { enabled: false });

    expect(result.ok).toBe(true);
    expect(pathIndex("/model")).toBe(-1);
    expect(pathIndex("/prompt")).toBeGreaterThan(-1);
  });
});
