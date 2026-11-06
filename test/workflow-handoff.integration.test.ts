/**
 * Integration coverage for bd-120: a caller that handed its workflow to a
 * child orchestrator must not re-activate that workflow on restart.
 *
 * Two records are involved: the caller's own workflow record (when the child runs
 * in another worktree) and the caller-scoped handoff marker (which survives a
 * same-directory handoff where the child owns the workflow record). The
 * `session_start` handler consults the caller-scoped marker first.
 *
 * bd-281 moved both into the shared per-repository store, keyed by task, so the
 * "archived copy kept for diagnosis" assertions became "the dead record is gone
 * and no copy exists anywhere" — a copy of executable state is the bug this bead
 * removes, not the mitigation.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTempRepoState } from "../src/__tests__/helpers/repo-state.js";
import { readOrchestratorClaim } from "../src/orchestrator-claim.js";
import {
  callerHandoffFilePath,
  readCallerHandoff,
  readWorkflowState,
  workflowStateFilePath,
  writeCallerHandoff,
  writeWorkflowState,
} from "../src/workflow-state.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

// Temp directories are not git repositories, so the shared execution store is
// pointed at a fresh file per test (bd-281).
installTempRepoState();

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
  ui: { notify: (message: string, level?: string) => void };
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

/**
 * The retired state paths this worktree must never contain again (bd-281).
 *
 * Nothing writes `.belayd/workflow.json`, `workflow.stale-*.json` or
 * `handoff-<session>.json`; a present one would be refused by the store's own
 * migration guard.
 */
function retiredStateFiles(cwd: string): string[] {
  const present: string[] = [];
  if (existsSync(workflowStateFilePath(cwd))) present.push(workflowStateFilePath(cwd));
  if (existsSync(join(cwd, ".belayd", "workflow.stale-1.json"))) {
    present.push(join(cwd, ".belayd", "workflow.stale-1.json"));
  }
  return present;
}

/** A ctx whose notifications are captured, so a stray refusal is detectable. */
function capturingCtx(
  cwd: string,
  sessionId: string,
): {
  ctx: OrchestratorCtx;
  notifications: Array<{ message: string; level: string | undefined }>;
} {
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const ctx: OrchestratorCtx = {
    ...createOrchestratorCtx(cwd, sessionId),
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    },
  };
  return { ctx, notifications };
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
  // Sessions whose `session_start` ran, so the lease heartbeat each one may
  // have started is stopped through pi's own shutdown path rather than waiting
  // for a tick to fail on a deleted temp dir.
  const bootedSessions: Array<{
    handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
    ctx: OrchestratorCtx;
  }> = [];

  function trackSession(
    handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
    ctx: OrchestratorCtx,
  ): void {
    bootedSessions.push({ handlers, ctx });
  }

  afterEach(async () => {
    for (const { handlers, ctx } of bootedSessions.splice(0)) {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({}, ctx);
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function freshCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), "belayd-handoff-int-"));
    dirs.push(dir);
    return dir;
  }

  it("does not claim a lease from a handed-off workflow and archives it (real record shape)", async () => {
    const cwd = freshCwd();
    // The real bd-165 record: a cross-worktree handoff writes `handedOffTo` onto
    // the caller's own state, so the marker's task id equals the state's.
    writeWorkflowState({
      cwd,
      state: {
        ...baseState("bd-101"),
        handedOffTo: { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" },
      },
    });

    const harness = await bootHarness();
    const { ctx, notifications } = capturingCtx(cwd, "restarted-caller");
    trackSession(harness.handlers, ctx);

    const sessionStart = harness.handlers.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();
    await sessionStart?.({}, ctx);

    // Gate stays off: no gated tool set, no workflow context message.
    expect(await gateMessage(harness.handlers, ctx)).toBeUndefined();
    expect(harness.activeTools()).toEqual(["read", "write", "edit", "bash"]);

    // No lease was claimed from the dead record, and nothing was refused.
    expect(readOrchestratorClaim({ worktreePath: cwd }).kind).toBe("absent");
    expect(notifications).toEqual([]);

    // The parent's terminal record is discarded, not left to poison the
    // worktree's next session, and no copy of it survives anywhere.
    expect(readWorkflowState({ cwd })).toBeUndefined();
    expect(retiredStateFiles(cwd)).toEqual([]);
  });

  it("archives a handed-off record whose marker names another task", async () => {
    const cwd = freshCwd();
    // A reused worktree can carry a marker for a task the state does not name.
    writeWorkflowState({
      cwd,
      state: {
        ...baseState("bd-100"),
        handedOffTo: { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" },
      },
    });

    const harness = await bootHarness();
    const { ctx, notifications } = capturingCtx(cwd, "restarted-caller-mismatch");
    trackSession(harness.handlers, ctx);
    await harness.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(readOrchestratorClaim({ worktreePath: cwd }).kind).toBe("absent");
    expect(notifications).toEqual([]);
    expect(readWorkflowState({ cwd })).toBeUndefined();
    expect(retiredStateFiles(cwd)).toEqual([]);
  });

  it("does not claim a lease from a completed workflow and archives it", async () => {
    const cwd = freshCwd();
    const completed = baseState("bd-102");
    writeWorkflowState({
      cwd,
      state: { ...completed, completedPhaseNames: [...completed.phaseOrder] },
    });

    const harness = await bootHarness();
    const { ctx, notifications } = capturingCtx(cwd, "fresh-session");
    trackSession(harness.handlers, ctx);
    await harness.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(readOrchestratorClaim({ worktreePath: cwd }).kind).toBe("absent");
    const refusalTexts = notifications.map((entry) => entry.message).join("\n");
    expect(refusalTexts).not.toContain("Refusing to drive");
    expect(readWorkflowState({ cwd })).toBeUndefined();
    expect(retiredStateFiles(cwd)).toEqual([]);

    // A later session in the same worktree is lease-free too.
    const laterHarness = await bootHarness();
    const laterCtx = createOrchestratorCtx(cwd, "later-session");
    trackSession(laterHarness.handlers, laterCtx);
    await laterHarness.handlers.get("session_start")?.[0]?.({}, laterCtx);
    expect(readOrchestratorClaim({ worktreePath: cwd }).kind).toBe("absent");
  });

  it("lets a later session claim a lease for a new bead after the stale state is archived", async () => {
    const cwd = freshCwd();
    // The bead's user-visible promise: the dead handed-off record is archived,
    // so the worktree is not poisoned for the next session's new task.
    writeWorkflowState({
      cwd,
      state: {
        ...baseState("bd-101"),
        handedOffTo: { taskId: "bd-101", branch: "feat/bd-101", sessionId: "sess-child" },
      },
    });

    const staleHarness = await bootHarness();
    const stale = capturingCtx(cwd, "stale-workflow-session");
    trackSession(staleHarness.handlers, stale.ctx);
    await staleHarness.handlers.get("session_start")?.[0]?.({}, stale.ctx);

    expect(readOrchestratorClaim({ worktreePath: cwd }).kind).toBe("absent");
    expect(stale.notifications).toEqual([]);
    expect(readWorkflowState({ cwd })).toBeUndefined();
    expect(retiredStateFiles(cwd)).toEqual([]);
    // The caller-scoped handoff marker is a row too, so nothing is left behind.
    expect(existsSync(callerHandoffFilePath(cwd, "stale-workflow-session"))).toBe(false);

    // A genuinely new, in-progress bead in the same worktree must be drivable.
    writeWorkflowState({ cwd, state: baseState("bd-202") });
    const newHarness = await bootHarness();
    const fresh = capturingCtx(cwd, "new-bead-session");
    trackSession(newHarness.handlers, fresh.ctx);
    await newHarness.handlers.get("session_start")?.[0]?.({}, fresh.ctx);

    const claim = readOrchestratorClaim({ worktreePath: cwd });
    expect(claim.kind).toBe("ok");
    if (claim.kind === "ok") {
      expect(claim.claim.taskId).toBe("bd-202");
      expect(claim.claim.sessionId).toBe("new-bead-session");
    }
    expect(fresh.notifications.map((entry) => entry.message).join("\n")).not.toContain(
      "Refusing to drive",
    );
    // The recovery left no copy behind, and the new bead owns the worktree's row.
    expect(retiredStateFiles(cwd)).toEqual([]);
    expect(readWorkflowState({ cwd })).toHaveProperty("taskId", "bd-202");
  });

  it("claims the lease for a genuinely in-progress workflow (control)", async () => {
    const cwd = freshCwd();
    writeWorkflowState({ cwd, state: baseState("bd-103") });

    const harness = await bootHarness();
    const ctx = createOrchestratorCtx(cwd, "driving-session");
    trackSession(harness.handlers, ctx);
    await harness.handlers.get("session_start")?.[0]?.({}, ctx);

    const claim = readOrchestratorClaim({ worktreePath: cwd });
    expect(claim.kind).toBe("ok");
    if (claim.kind === "ok") expect(claim.claim.taskId).toBe("bd-103");
    // The claimable state is untouched: this session resumes it.
    expect(readWorkflowState({ cwd })).toHaveProperty("taskId", "bd-103");
    expect(retiredStateFiles(cwd)).toEqual([]);
  });

  it("stops the lease heartbeat through session_shutdown", async () => {
    const cwd = freshCwd();
    writeWorkflowState({ cwd, state: baseState("bd-104") });

    const harness = await bootHarness();
    const ctx = createOrchestratorCtx(cwd, "shutdown-session");
    trackSession(harness.handlers, ctx);
    await harness.handlers.get("session_start")?.[0]?.({}, ctx);
    expect(readOrchestratorClaim({ worktreePath: cwd }).kind).toBe("ok");

    for (const handler of harness.handlers.get("session_shutdown") ?? []) {
      await handler({}, ctx);
    }

    // `releaseSessionOrchestratorLease` clears the 20 s timer before releasing
    // the claim, so an absent claim is the observable proof that the heartbeat
    // is gone. This is the same route `afterEach` uses for every booted session.
    expect(readOrchestratorClaim({ worktreePath: cwd }).kind).toBe("absent");
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
    trackSession(harness.handlers, ctx);
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
    trackSession(childHarness.handlers, childCtx);
    await childHarness.handlers.get("session_start")?.[0]?.({}, childCtx);
    expect(await gateMessage(childHarness.handlers, childCtx)).toContain("bd-101");
  });

  it("still re-activates an identical state without the marker (control)", async () => {
    const cwd = freshCwd();
    writeWorkflowState({ cwd, state: baseState("bd-100") });

    const harness = await bootHarness();
    const ctx = createOrchestratorCtx(cwd, "restarted-caller-control");
    trackSession(harness.handlers, ctx);

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, ctx);

    const message = await gateMessage(harness.handlers, ctx);
    expect(message).toBeTruthy();
    expect(message).toContain("BELAYD WORKFLOW ACTIVE");
    expect(message).toContain("bd-100");
    expect(harness.activeTools()).not.toEqual(["read", "write", "edit", "bash"]);
  });
});
