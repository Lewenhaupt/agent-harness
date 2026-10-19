/**
 * Integration coverage for bd-120: a caller that handed its workflow to a
 * child orchestrator must not re-activate that workflow on restart.
 *
 * Two records are involved: the caller's `.belayd/workflow.json` marker (when
 * the child runs in another worktree) and the caller-scoped
 * `.belayd/handoff-<sessionId>.json` (which survives a same-directory handoff
 * where the child owns workflow.json). The `session_start` handler consults the
 * caller-scoped file first. This test uses the real filesystem and only stubs
 * the process/daemon edges.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCallerHandoff,
  readWorkflowState,
  writeCallerHandoff,
  writeWorkflowState,
} from "../src/workflow-state.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: vi.fn(),
    execFile: vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const stdin = { on: () => {}, end: () => cb(new Error("unavailable"), "", "") };
        return { stdin };
      },
    ),
    execSync: vi.fn(() => {
      throw new Error("execSync unavailable");
    }),
    execFileSync: vi.fn(() => ""),
  };
});

vi.mock("node:http", () => ({
  request: vi.fn(() => ({ on: vi.fn(), write: vi.fn(), end: vi.fn() })),
}));

interface OrchestratorCtx {
  cwd: string;
  ui: { notify: () => void };
  sessionManager: {
    getSessionId: () => string;
    getSessionName: () => string;
    getSessionFile: () => string;
  };
}

function createOrchestratorCtx(cwd: string, sessionId: string): OrchestratorCtx {
  return {
    cwd,
    ui: { notify: () => {} },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "orchestrator-session",
      getSessionFile: () => join(cwd, "session.jsonl"),
    },
  };
}

async function bootHarness(): Promise<{
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  activeTools: () => string[];
}> {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  let activeTools: string[] = ["read", "write", "edit", "bash"];
  const api = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    sendMessage: () => {},
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => {
      activeTools = next;
    },
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;

  const mod = await import("../extensions/index.js");
  (mod.default as (pi: ExtensionAPI) => void)(api);
  return { handlers, activeTools: () => activeTools };
}

/** Fan out `before_agent_start` like pi and report any gate context message. */
async function gateMessage(
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
  ctx: OrchestratorCtx,
): Promise<string | undefined> {
  for (const handler of handlers.get("before_agent_start") ?? []) {
    try {
      const result = (await handler({}, ctx)) as { message?: { content?: string } } | undefined;
      if (result?.message?.content !== undefined) return result.message.content;
    } catch {
      // pi isolates handler failures; keep looking for the gate message.
    }
  }
  return undefined;
}

function baseState(taskId: string) {
  return {
    schemaVersion: 1 as const,
    taskId,
    workflowType: "feature",
    branch: `feat/${taskId}`,
    originalCwd: "/home/user/repo",
    phaseOrder: ["implement", "review", "test", "userguide", "proof", "commit"],
    completedPhaseNames: ["implement", "review"],
    startedAt: 1_000,
    updatedAt: 1_000,
  };
}

describe("workflow handoff across a caller restart (integration)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function freshCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), "belayd-handoff-int-"));
    dirs.push(dir);
    return dir;
  }

  it("does not re-activate a handed-off workflow from .belayd/workflow.json", async () => {
    const cwd = freshCwd();
    writeWorkflowState({
      cwd,
      state: {
        ...baseState("bd-100"),
        handedOffTo: { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" },
      },
    });

    const harness = await bootHarness();
    const ctx = createOrchestratorCtx(cwd, "restarted-caller");

    const sessionStart = harness.handlers.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();
    await sessionStart?.({}, ctx);

    // Gate stays off: no gated tool set, no workflow context message.
    expect(await gateMessage(harness.handlers, ctx)).toBeUndefined();
    expect(harness.activeTools()).toEqual(["read", "write", "edit", "bash"]);

    // The marker survives (status still reports the handoff from it).
    expect(readWorkflowState({ cwd })).toHaveProperty("handedOffTo", {
      taskId: "bd-101",
      branch: "feat/bd-101",
      sessionId: "sess-child",
    });
  });

  it("does not re-activate after a same-directory handoff (caller-scoped marker)", async () => {
    const cwd = freshCwd();
    // The child orchestrator now owns workflow.json in this directory; the
    // caller's only surviving record is its session-keyed marker file.
    writeWorkflowState({ cwd, state: baseState("bd-101") });
    const callerId = "same-dir-caller";
    writeCallerHandoff({
      cwd,
      sessionKey: callerId,
      marker: { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" },
    });

    const harness = await bootHarness();
    const ctx = createOrchestratorCtx(cwd, callerId);
    await harness.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(await gateMessage(harness.handlers, ctx)).toBeUndefined();
    expect(harness.activeTools()).toEqual(["read", "write", "edit", "bash"]);
    expect(readCallerHandoff({ cwd, sessionKey: callerId })).toHaveProperty(
      "sessionId",
      "sess-child",
    );

    // A different (child) session in the same directory arms the child state.
    const childHarness = await bootHarness();
    const childCtx = createOrchestratorCtx(cwd, "child-session");
    await childHarness.handlers.get("session_start")?.[0]?.({}, childCtx);
    expect(await gateMessage(childHarness.handlers, childCtx)).toContain("bd-101");
  });

  it("still re-activates an identical state without the marker (control)", async () => {
    const cwd = freshCwd();
    writeWorkflowState({ cwd, state: baseState("bd-100") });

    const harness = await bootHarness();
    const ctx = createOrchestratorCtx(cwd, "restarted-caller-control");

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, ctx);

    const message = await gateMessage(harness.handlers, ctx);
    expect(message).toBeTruthy();
    expect(message).toContain("BELAYD WORKFLOW ACTIVE");
    expect(message).toContain("bd-100");
    expect(harness.activeTools()).not.toEqual(["read", "write", "edit", "bash"]);
  });
});
