/**
 * Extension-surface tests for the fleet supervisor (bd-126 P1): fleet mode and
 * its refusal, `belayd_fleet_launch`, the mailbox tools, `/fleet`, and the
 * member-side `events/` delivery at turn start.
 *
 * `resolveGitCommonDir` is replaced so the extension treats a temp directory as
 * the git common dir; every other fleet-state read/write is the real
 * implementation against that directory, so the assertions cover files that
 * actually appeared (or did not). Worktree creation and the session daemon are
 * stubbed: no member is really spawned here.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetForceStopSeams } from "../../extensions/index.js";
import type { HandoffPacket } from "../handoff.js";
import {
  buildFleetNote,
  COMMENT_EXCERPT_MAX_CHARS,
  createFleetMergeQueue,
  drainNotes,
  enqueueNote,
  FLEET_NOTE_BODY_MAX_LENGTH,
  fleetEventsDir,
  fleetInboxDir,
  fleetNoteFileName,
  formatFleetRefusal,
  readFleetIntent,
  writeFleetMergeQueue,
} from "../index.js";
import { RunStatus, writeRunManifest } from "../run-manifest.js";
import { writeWorkflowState } from "../workflow-state.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");
process.env.PI_WEB_SESSIOND_SOCKET = join(tmpdir(), "belayd-test-no-sessiond.sock");

const git = vi.hoisted(() => ({
  commonDir: "",
  failWith: undefined as string | undefined,
}));

const daemon = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string }>,
  failWith: undefined as string | undefined,
}));

const worktree = vi.hoisted(() => ({
  path: "",
  /** Set to make the stubbed worktree setup fail, so a launch cannot start. */
  failWith: undefined as string | undefined,
  /** Path `resolveWorktreePath` reports for a branch (W-D tests). */
  branchPath: "",
  /** Branch `readWorktreeBranch` reports (W-D tests). */
  branch: "",
}));

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return {
    ...actual,
    resolveGitCommonDir: (cwd: string) => {
      if (git.failWith !== undefined) return { ok: false as const, error: git.failWith };
      if (git.commonDir === "")
        return { ok: false as const, error: `not a git repository: ${cwd}` };
      return { ok: true as const, commonDir: git.commonDir };
    },
    setupWorktree: (_root: string, options: { branch: string }) => {
      if (worktree.failWith !== undefined) throw new Error(worktree.failWith);
      // One directory per branch: the worktree lease is per worktree, so a stub
      // that returned one path for every branch would refuse the second member.
      const path = join(worktree.path, options.branch.replace(/\//g, "-"));
      mkdirSync(path, { recursive: true });
      return path;
    },
    awaitWorktreeReady: async () => ({ ok: true as const }),
    readStackNode: () => undefined,
    // Worktree probes the fleet ownership preflight uses. Defaults reproduce the
    // "git unavailable" case (no worktree found, unreadable branch); a test that
    // needs an existing worktree sets `branchPath`/`branch`.
    resolveWorktreePath: () => (worktree.branchPath === "" ? undefined : worktree.branchPath),
    readWorktreeBranch: () =>
      worktree.branch === ""
        ? { ok: false as const, reason: "unavailable" as const, error: "git stubbed" }
        : { ok: true as const, branch: worktree.branch },
    // The real collector shells out to bd/git; the packet itself is irrelevant
    // here (only its absence is exercised), so a minimal stub keeps the launch
    // path deterministic.
    collectHandoffDefault: async () => undefined as unknown as HandoffPacket,
  };
});

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  // Minimal stand-in for the pi-web session daemon: creating a session returns an
  // id, everything else returns an empty object, and failing() makes the next
  // call reject so the per-member failure path is testable.
  const request = (options: { method?: string; path?: string }, callback: unknown) => {
    const path = options.path ?? "";
    daemon.calls.push({ method: options.method ?? "GET", path });
    const listeners: Record<string, (value?: unknown) => void> = {};
    const req = {
      on: (event: string, handler: (value?: unknown) => void) => {
        listeners[event] = handler;
        return req;
      },
      write: () => {},
      end: () => {
        if (daemon.failWith !== undefined) {
          listeners.error?.(new Error(daemon.failWith));
          return;
        }
        const body = path === "/sessions" ? JSON.stringify({ id: "member-session-id" }) : "{}";
        const res = {
          statusCode: 200,
          on: (event: string, handler: (value?: unknown) => void) => {
            if (event === "data") handler(Buffer.from(body));
            if (event === "end") handler();
            return res;
          },
        };
        (callback as (response: unknown) => void)(res);
      },
    };
    return req;
  };
  return { ...actual, request };
});

const childProcess = vi.hoisted(() => ({
  /** Every execFile call: argv plus the stdin body a write carried (bd-152). */
  execFileCalls: [] as Array<{ file: string; args: readonly string[]; stdin: string }>,
  /** Fail every `bd comment` write, to pin the mirror's best-effort behaviour. */
  failBdComment: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Any real git/bd/wt call throws: the probes then degrade exactly as they do
  // in a directory with no repository, and no test depends on a live binary.
  // Calls are recorded anyway, because the bd comment mirror (bd-152) is only
  // visible through argv + stdin.
  return {
    ...actual,
    execFile: vi.fn(
      (file: string, args: readonly string[], _options: unknown, callback: unknown) => {
        const done = callback as (error: Error | null, stdout: string, stderr: string) => void;
        const record = { file, args: [...args], stdin: "" };
        childProcess.execFileCalls.push(record);
        const fails = childProcess.failBdComment && file === "bd" && args[0] === "comment";
        // Answer synchronously, like the successful stub this file always had:
        // some callers (the fleet git runner) spawn through their own promise
        // wrapper and never close stdin. bd goes through `runFileCommand`, which
        // closes it right after, so the recorded body is still set before the
        // awaiting test resumes — and a failing comment rejects on that close,
        // where the real child would have failed.
        if (!fails) done(null, "", "");
        const childStdin = {
          on: () => {},
          end: (chunk?: string) => {
            record.stdin = chunk ?? "";
            if (fails) done(new Error("bd: comment write failed"), "", "");
          },
        };
        return { stdin: childStdin };
      },
    ),
    exec: vi.fn((_command: string, _options: unknown, callback: unknown) => {
      // `countUncommittedFiles` runs on agent_end; without a callback the handler
      // would never settle.
      const done = callback as (error: Error | null, stdout: string) => void;
      done(null, "");
    }),
    execFileSync: vi.fn(() => {
      throw new Error("spawnSync git ENOENT (stubbed)");
    }),
    execSync: vi.fn(() => {
      throw new Error("spawnSync git ENOENT (stubbed)");
    }),
  };
});

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number };
}

interface RegisteredTool {
  name: string;
  description?: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

interface PiCommand {
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

type AgentStartHandler = (
  event: { systemPromptOptions: Record<string, unknown> },
  ctx: unknown,
) => Promise<unknown> | unknown;

type ToolCallHandler = (event: { toolName: string }, ctx: unknown) => unknown;

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, PiCommand>;
  agentStart: AgentStartHandler[];
  agentEnd: AgentStartHandler[];
  toolCall: ToolCallHandler[];
  activeTools: () => string[];
  notifications: Array<{ message: string; level: string }>;
}

function createMockPi(): MockPi {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, PiCommand>();
  const agentStart: AgentStartHandler[] = [];
  const agentEnd: AgentStartHandler[] = [];
  const toolCall: ToolCallHandler[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let active: string[] = [];
  const api = {
    registerTool: (def: RegisteredTool) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, def: PiCommand) => {
      commands.set(name, def);
    },
    on: (event: string, handler: unknown) => {
      if (event === "before_agent_start") agentStart.push(handler as AgentStartHandler);
      if (event === "agent_end") agentEnd.push(handler as AgentStartHandler);
      if (event === "tool_call") toolCall.push(handler as ToolCallHandler);
    },
    sendMessage: () => {},
    appendEntry: () => {},
    getActiveTools: () => active,
    setActiveTools: (list: string[]) => {
      active = list;
    },
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return {
    api,
    tools,
    commands,
    agentStart,
    agentEnd,
    toolCall,
    activeTools: () => active,
    notifications,
  };
}

async function loadFleetExtension(seams: FleetForceStopSeams = {}): Promise<MockPi> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI, overrides?: FleetForceStopSeams) => void;
  const mock = createMockPi();
  register(mock.api, seams);
  return mock;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

function makeCtx(dir: string, sessionId: string) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => `belayd-${sessionId}`,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    },
    cwd: dir,
    ui: {
      notify: (message: string, level: string) => {
        ctxNotifications.push({ message, level });
      },
    },
  };
}

// Notifications are asserted per test; the mock pi and the ctx both expose the
// same sink so a refusal can be checked from either side.
let ctxNotifications: Array<{ message: string; level: string }> = [];

/**
 * Write a member's workflow snapshot, with a failed run for the pending phase.
 *
 * Matches the tick's own reading: a pending phase whose newest run failed is
 * `phase-failed`, and a workflow whose phases are all complete is `complete`.
 */
function writeMemberState(options: { cwd: string; completedPhaseNames: readonly string[] }): void {
  const phaseOrder = ["plan", "implement"];
  const pending =
    phaseOrder.find((phase) => !options.completedPhaseNames.includes(phase)) ?? "commit";
  const state = writeWorkflowState({
    cwd: options.cwd,
    state: {
      schemaVersion: 1,
      taskId: "bd-12",
      workflowType: "feature",
      resolutionSource: "default",
      branch: "feat/bd-12",
      originalCwd: options.cwd,
      phaseOrder,
      completedPhaseNames: [...options.completedPhaseNames],
      startedAt: 1,
      updatedAt: 1,
    },
  });
  if (!state.ok) throw new Error(`could not write workflow state: ${state.error}`);
  const manifest = writeRunManifest({
    cwd: options.cwd,
    manifest: {
      schemaVersion: 1,
      runId: `run-${pending}`,
      taskId: "bd-12",
      phase: pending,
      sessionName: `belayd-bd-12-${pending}`,
      status: RunStatus.Failed,
      startedAt: 2,
      completedAt: 3,
      failureReason: "gate failed",
    },
  });
  if (!manifest.ok) throw new Error(`could not write run manifest: ${manifest.error}`);
}

describe("fleet supervisor mode", () => {
  let cwd: string;
  let commonDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-p1-"));
    commonDir = join(cwd, ".git");
    mkdirSync(join(commonDir, "belayd", "fleet", "default"), { recursive: true });
    git.commonDir = commonDir;
    git.failWith = undefined;
    worktree.path = join(cwd, "member-worktree");
    worktree.failWith = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    mkdirSync(worktree.path, { recursive: true });
    daemon.calls = [];
    daemon.failWith = undefined;
    childProcess.failBdComment = false;
    ctxNotifications = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
    git.failWith = undefined;
  });

  function writeIntent(options: {
    taskIds?: string[];
    supervisor?: { sessionId: string; pid: number; armToken?: string } | undefined;
    fleetId?: string;
  }): void {
    const fleetId = options.fleetId ?? "default";
    mkdirSync(join(commonDir, "belayd", "fleet", fleetId), { recursive: true });
    writeFileSync(
      join(commonDir, "belayd", "fleet", fleetId, "fleet.json"),
      JSON.stringify({
        schemaVersion: 1,
        fleetId,
        taskIds: options.taskIds ?? ["bd-12", "bd-15"],
        createdAt: 1,
        updatedAt: 1,
        ...(options.supervisor === undefined ? {} : { supervisor: options.supervisor }),
      }),
    );
  }

  /** Arm this session through the real `/fleet` path (the only way to hold a token). */
  async function arm(
    mock: MockPi,
    ctx: ReturnType<typeof makeCtx>,
    args = "bd-12 bd-15",
  ): Promise<void> {
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    // These cases pin the explicit surface; run-mode behaviour has its own suite.
    await command.handler(args.includes("--manual") ? args : `${args} --manual`, ctx);
  }

  function auditActions(): string[] {
    const path = join(commonDir, "belayd", "fleet", "default", "audit.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { action: string }).action);
  }

  function supervisorFor(sessionId: string): { sessionId: string; pid: number } {
    return { sessionId, pid: process.pid };
  }

  async function blockReason(
    mock: MockPi,
    toolName: string,
    ctx: ReturnType<typeof makeCtx>,
  ): Promise<unknown> {
    for (const handler of mock.toolCall) {
      const outcome = (await handler({ toolName }, ctx)) as { block?: boolean; reason?: string };
      if (outcome?.block === true) return outcome.reason;
    }
    return undefined;
  }

  it("registers the fleet tool family and the /fleet command", async () => {
    const mock = await loadFleetExtension();

    for (const name of [
      "belayd_fleet_status",
      "belayd_fleet_launch",
      "belayd_fleet_note",
      "belayd_fleet_inbox",
      "belayd_fleet_merge",
      "belayd_fleet_pause",
      "belayd_fleet_resume",
      "belayd_fleet_advance",
      "belayd_fleet_reconcile",
    ]) {
      expect(mock.tools.has(name)).toBe(true);
    }
    expect(mock.commands.has("fleet")).toBe(true);
    expect(mock.tools.get("belayd_fleet_launch")?.description).toContain("at most 3 orchestrators");
    // The forceful path states its limit where the model reads it.
    expect(mock.tools.get("belayd_fleet_pause")?.description).toContain("SIGTERM");
    expect(mock.tools.get("belayd_fleet_pause")?.description).toContain(
      "does not guarantee the process exited",
    );
    // Pruning is gated on the member's evidence, not the supervisor's liveness —
    // the description must not promise the unreachable dead-supervisor rule.
    const reconcileDescription = mock.tools.get("belayd_fleet_reconcile")?.description ?? "";
    expect(reconcileDescription).toContain("no live lease AND no matching process");
    expect(reconcileDescription).toContain("`unknown` is never");
    expect(reconcileDescription).not.toContain("supervisor is not running");
  });

  it("pauses and resumes the fleet through the record, audited", async () => {
    const sessionId = "supervisor-session";
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, sessionId);
    await arm(mock, ctx);

    const paused = await mock.tools
      .get("belayd_fleet_pause")
      ?.execute("call-1", { reason: "stepping away" }, undefined, undefined, ctx);
    expect(paused?.details).toHaveProperty("exitCode", 0);

    let intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    if (!intent.ok) throw new Error(intent.error);
    expect(intent.intent?.paused).toBe(true);
    expect(intent.intent?.note).toBe("stepping away");
    expect(auditActions()).toContain("fleet-paused");
    // The members were told, through their own mailbox.
    const events = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
    expect(events).toHaveProperty("ok", true);
    if (!events.ok) return;
    expect(events.deliveries.map((delivery) => delivery.note.kind)).toEqual(["pause", "pause"]);

    // A paused fleet refuses new work through the launch tool.
    const refusedLaunch = await mock.tools
      .get("belayd_fleet_launch")
      ?.execute("call-2", { tasks: "bd-19" }, undefined, undefined, ctx);
    expect(refusedLaunch?.details).toHaveProperty("exitCode", 1);
    expect(textOf(refusedLaunch as ToolResult)).toContain("is paused");

    const resumed = await mock.tools
      .get("belayd_fleet_resume")
      ?.execute("call-3", {}, undefined, undefined, ctx);
    expect(resumed?.details).toHaveProperty("exitCode", 0);
    intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    if (!intent.ok) throw new Error(intent.error);
    expect(intent.intent).not.toHaveProperty("paused");
    expect(auditActions()).toContain("fleet-resumed");

    // Resuming an already-running fleet is a successful no-op, mirroring pause:
    // the documented "reconcile, then resume" path still succeeds when reconcile
    // already unparked the fleet.
    const again = await mock.tools
      .get("belayd_fleet_resume")
      ?.execute("call-4", {}, undefined, undefined, ctx);
    expect(again?.details).toHaveProperty("exitCode", 0);
    expect(textOf(again as ToolResult)).toContain("already running");
  });

  it("never signals a process when no pid can be tied to the member (forceful pause)", async () => {
    // The forceful path is the only code in the product that sends a signal. The
    // member id below cannot be a live session token on any host, so the scan can
    // never match this test — the assertion is "nothing was signalled", which holds
    // whether /proc is readable (member absent) or not (liveness unknown).
    const impossibleTaskId = "bd-zz-fixture-never-a-real-session-token";
    const sessionId = "supervisor-session";
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, sessionId);
    await arm(mock, ctx);

    const path = join(commonDir, "belayd", "fleet", "default", "fleet.json");
    const armed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...armed, taskIds: ["bd-12", impossibleTaskId] }));

    const paused = await mock.tools
      .get("belayd_fleet_pause")
      ?.execute("call-1", { reason: "runaway member", force: true }, undefined, undefined, ctx);
    expect(paused?.details).toHaveProperty("exitCode", 0);
    const text = textOf(paused as ToolResult);

    // The cooperative half applied...
    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    if (!intent.ok) throw new Error(intent.error);
    expect(intent.intent?.paused).toBe(true);
    expect(auditActions()).toContain("fleet-paused");
    // ...and no process was killed: no `member-stopped` audit exists at all, so a
    // signal can never have been delivered by this path in a test run.
    expect(auditActions()).not.toContain("member-stopped");
    expect(text).toContain("- forceful pause:");
    expect(text).toMatch(/not signalled|could not identify member sessions/u);
    // The signal attempt is recorded per member (or per fleet when the process
    // table cannot be read at all), so an operator can see that the stop did not
    // happen and that only the cooperative pause applies.
    const actions = auditActions();
    expect(actions).toContain("fleet-paused");
    expect(
      actions.some(
        (action) => action === "member-stop-skipped" || action === "member-stop-unavailable",
      ),
    ).toBe(true);
  });

  it("signals a verified member pid once and audits it, never a real process (forceful pause)", async () => {
    // The positive half of the forceful path: a scan that positively identifies the
    // member's orchestrator and a probe that re-proves the same identity. Both are
    // injected, so the signal lands on the seam instead of a host process.
    const sessionId = "supervisor-session";
    const memberToken = "belayd-bd-12";
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const realKill = vi.spyOn(process, "kill");
    try {
      const mock = await loadFleetExtension({
        scan: () => ({
          ok: true,
          processes: [{ pid: 4321, argv: ["pi", "--session-id", memberToken] }],
        }),
        probe: {
          startTime: () => "100",
          argv: () => ["pi", "--session-id", memberToken],
        },
        startTime: () => "100",
        signal: (pid, signalName) => {
          signalled.push({ pid, signal: signalName });
        },
      });
      const ctx = makeCtx(cwd, sessionId);
      await arm(mock, ctx);

      const paused = await mock.tools
        .get("belayd_fleet_pause")
        ?.execute("call-1", { reason: "runaway member", force: true }, undefined, undefined, ctx);
      expect(paused?.details).toHaveProperty("exitCode", 0);
      const text = textOf(paused as ToolResult);

      expect(signalled).toEqual([{ pid: 4321, signal: "SIGTERM" }]);
      // The signal went through the seam, never to the host process table. (A
      // signal-0 liveness probe elsewhere may legitimately call `process.kill`,
      // so assert on the member pid and on SIGTERM delivery, not on the spy's
      // total call count.)
      expect(realKill.mock.calls.filter((call) => call[0] === 4321)).toEqual([]);
      expect(realKill.mock.calls.filter((call) => call[1] === "SIGTERM")).toEqual([]);
      expect(text).toContain("SIGTERM sent to bd-12's orchestrator pid 4321");

      const entries = readFileSync(
        join(commonDir, "belayd", "fleet", "default", "audit.log"),
        "utf8",
      )
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { action: string; detail?: string });
      const stopped = entries.find((entry) => entry.action === "member-stopped");
      if (stopped === undefined) throw new Error("no member-stopped audit entry");
      // The audit names the matched token, so the pid can be tied back to the
      // identity it was signalled as after the process is gone.
      expect(stopped.detail).toContain("pid 4321");
      expect(stopped.detail).toContain(memberToken);
    } finally {
      realKill.mockRestore();
    }
  });

  it("treats a capacity-blocked advance as success, not as a failure (W6)", async () => {
    const sessionId = "supervisor-session";
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, sessionId);
    await arm(mock, ctx);

    // Rewrite the armed fleet so every slot is already taken and a deferred
    // member is waiting: the advance has nothing it can start.
    const path = join(commonDir, "belayd", "fleet", "default", "fleet.json");
    const armed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({
        ...armed,
        maxConcurrent: 1,
        deferred: [{ taskId: "bd-19", reason: "capacity", detail: "no free slot" }],
      }),
    );

    const advanced = await mock.tools
      .get("belayd_fleet_advance")
      ?.execute("call-1", {}, undefined, undefined, ctx);
    expect(advanced?.details).toHaveProperty("exitCode", 0);
    const text = textOf(advanced as ToolResult);
    // Nothing was attempted, so there is no failed member — the plan waits.
    expect(text).toContain("0/0 member(s) launched");
    expect(text).toContain("deferred bd-19 (capacity)");
    // Nothing was spawned, but the plan (and its deferral) was recorded.
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(2);
  });

  it("reports a consistent fleet from reconcile and refuses it from a non-supervisor", async () => {
    const sessionId = "supervisor-session";
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, sessionId);
    await arm(mock, ctx);

    const reconciled = await mock.tools
      .get("belayd_fleet_reconcile")
      ?.execute("call-1", {}, undefined, undefined, ctx);
    expect(reconciled?.details).toHaveProperty("exitCode", 0);
    const text = textOf(reconciled as ToolResult);
    expect(text).toContain("nothing to repair");
    expect(text).toContain("supervisor: live");

    const outsider = makeCtx(cwd, "ordinary-session");
    const refused = await mock.tools
      .get("belayd_fleet_reconcile")
      ?.execute("call-2", {}, undefined, undefined, outsider);
    expect(refused?.details).toHaveProperty("exitCode", 1);
    expect(textOf(refused as ToolResult)).toContain("supervisor-only");

    const noWave = await mock.tools
      .get("belayd_fleet_advance")
      ?.execute("call-3", {}, undefined, undefined, ctx);
    expect(noWave?.details).toHaveProperty("exitCode", 1);
    expect(textOf(noWave as ToolResult)).toContain("no deferred members");
  });

  it("repairs a stuck merge-queue entry through the tool, and a second call is a no-op", async () => {
    // `node:child_process` is stubbed to succeed in this file, so `git merge-base
    // --is-ancestor` answers "ancestor": the entry is proven landed and is marked
    // merged rather than re-queued. The point here is the tool plumbing and the
    // idempotent second pass; both repair actions are covered directly against
    // `diagnoseMergeQueue` in fleet-reconcile.test.ts.
    const sessionId = "supervisor-session";
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, sessionId);
    await arm(mock, ctx);

    // An in-flight entry left behind by a crash: no lock, so no merge is running.
    const fleetDir = join(commonDir, "belayd", "fleet", "default");
    writeFileSync(
      join(fleetDir, "merge-queue.json"),
      JSON.stringify({
        schemaVersion: 1,
        fleetId: "default",
        updatedAt: 1,
        lock: null,
        entries: [
          { taskId: "bd-12", branch: "feat/bd-12", requestedAt: 1, state: "merging", attempts: 2 },
        ],
      }),
    );

    const repaired = await mock.tools
      .get("belayd_fleet_reconcile")
      ?.execute("call-1", {}, undefined, undefined, ctx);
    expect(repaired?.details).toHaveProperty("exitCode", 0);
    const text = textOf(repaired as ToolResult);
    expect(text).toContain("queue: bd-12 → merged");
    expect(auditActions()).toContain("queue-mark-merged");

    const queue = JSON.parse(readFileSync(join(fleetDir, "merge-queue.json"), "utf8")) as {
      lock: unknown;
      entries: Array<{ state: string; attempts: number }>;
    };
    // Marked merged with its attempt count intact, and the lock reconcile took is
    // released again.
    expect(queue.entries[0]).toMatchObject({ state: "merged", attempts: 2 });
    expect(queue.lock).toBe(null);
    expect(existsSync(join(fleetDir, "merge.lock.d"))).toBe(false);

    const again = await mock.tools
      .get("belayd_fleet_reconcile")
      ?.execute("call-2", {}, undefined, undefined, ctx);
    expect(again?.details).toHaveProperty("exitCode", 0);
    expect(textOf(again as ToolResult)).toContain("nothing to repair");
  });

  it("refuses phase, proof, and commit tools with the fleet-specific message", async () => {
    const sessionId = "supervisor-session";
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, sessionId);
    await arm(mock, ctx);

    for (const toolName of ["belayd_plan", "belayd_commit", "belayd_proof_verifier"]) {
      const reason = await blockReason(mock, toolName, ctx);
      expect(reason).toBe(formatFleetRefusal({ toolName, fleetId: "default" }));
      expect(String(reason)).toContain("Fleet supervisor sessions do not run phases");
    }

    // Arming a gate would make the scheduler look like an orchestrator.
    expect(await blockReason(mock, "belayd_start_task", ctx)).toContain(
      "Fleet supervisor sessions do not run phases",
    );
    // The fleet family itself stays callable.
    expect(await blockReason(mock, "belayd_fleet_status", ctx)).toBe(undefined);
  });

  it("leaves a normal orchestrator session unaffected", async () => {
    const mock = await loadFleetExtension();
    await arm(mock, makeCtx(cwd, "supervisor-session"));
    const ctx = makeCtx(cwd, "ordinary-session");

    expect(await blockReason(mock, "belayd_commit", ctx)).toBe(undefined);
  });

  it("is not entered by a supervisor record left behind by a dead process", async () => {
    const sessionId = "resumed-session";
    writeIntent({ supervisor: { sessionId, pid: 999_999 } });
    const mock = await loadFleetExtension();

    expect(await blockReason(mock, "belayd_commit", makeCtx(cwd, sessionId))).toBe(undefined);
  });

  it("is not entered by a hand-planted record naming this session and a live pid (W6)", async () => {
    // pid 1 would pass a bare liveness probe forever; a token this session never
    // minted is the anchor a writer cannot forge.
    writeIntent({ supervisor: { sessionId: "planted-session", pid: 1, armToken: "guessed" } });
    const mock = await loadFleetExtension();

    expect(await blockReason(mock, "belayd_commit", makeCtx(cwd, "planted-session"))).toBe(
      undefined,
    );

    writeIntent({
      supervisor: { sessionId: "planted-session", pid: process.pid, armToken: "guessed" },
    });
    const fresh = await loadFleetExtension();
    expect(await blockReason(fresh, "belayd_commit", makeCtx(cwd, "planted-session"))).toBe(
      undefined,
    );
  });

  it("is not entered by an intent with no supervisor record", async () => {
    writeIntent({});
    const mock = await loadFleetExtension();

    expect(await blockReason(mock, "belayd_plan", makeCtx(cwd, "fresh-session"))).toBe(undefined);
  });

  it("keeps the bd-119 refusal for a member worktree (fleet refusal comes first, not instead)", async () => {
    const sessionId = "member-session";
    writeIntent({ taskIds: ["bd-99"], supervisor: supervisorFor(sessionId) });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, sessionId);

    const startTask = mock.tools.get("belayd_start_task");
    if (startTask === undefined) throw new Error("belayd_start_task was not registered");
    const started = await startTask.execute(
      "gate-1",
      { taskId: "bd-12" },
      undefined,
      undefined,
      ctx,
    );
    expect(started.details.exitCode).toBe(0);

    // Another bead owns this directory now; the bd-119 preflight must still win.
    const other = writeWorkflowState({
      cwd,
      state: {
        schemaVersion: 1,
        taskId: "bd-99",
        workflowType: "feature",
        resolutionSource: "default",
        branch: "feat/bd-99",
        originalCwd: cwd,
        phaseOrder: ["plan"],
        completedPhaseNames: [],
        startedAt: 1,
        updatedAt: 1,
      },
    });
    expect(other).toHaveProperty("ok", true);

    expect(await blockReason(mock, "belayd_plan", ctx)).toBe(undefined);
    const plan = mock.tools.get("belayd_plan");
    if (plan === undefined) throw new Error("belayd_plan was not registered");
    const refused = await plan.execute("plan-1", { task: "x" }, undefined, undefined, ctx);

    expect(refused.details.exitCode).toBe(1);
    expect(textOf(refused)).toContain("bd-99 lives in");
    expect(textOf(refused)).not.toContain("Fleet supervisor sessions");
  });

  describe("/fleet", () => {
    it("rejects an empty id list and arms no gate", async () => {
      const mock = await loadFleetExtension();
      const command = mock.commands.get("fleet");
      if (command === undefined) throw new Error("/fleet was not registered");

      await command.handler("   ", makeCtx(cwd, "operator-session"));

      expect(ctxNotifications).toHaveLength(1);
      expect(ctxNotifications[0]?.level).toBe("error");
      expect(ctxNotifications[0]?.message).toContain("Usage: /fleet");
      // No gate, no tool-set change, no fleet directory.
      expect(mock.activeTools()).toEqual([]);
      expect(readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" }).ok).toBe(true);
      const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(intent).toEqual({ ok: true, intent: undefined });
    });

    it("reports a launch outside a git repository and arms no gate", async () => {
      git.failWith = "not a git repository";
      const mock = await loadFleetExtension();
      const command = mock.commands.get("fleet");
      if (command === undefined) throw new Error("/fleet was not registered");

      await command.handler("bd-12 bd-15 --manual", makeCtx(cwd, "operator-session"));

      expect(ctxNotifications[0]?.level).toBe("error");
      expect(ctxNotifications[0]?.message).toContain("needs a git repository");
      expect(mock.activeTools()).toEqual([]);
    });

    it("launches members, records the intent, audits it, and still arms no gate", async () => {
      const mock = await loadFleetExtension();
      const command = mock.commands.get("fleet");
      if (command === undefined) throw new Error("/fleet was not registered");

      await command.handler(
        "bd-12 bd-15 --concurrency 9 --manual",
        makeCtx(cwd, "operator-session"),
      );

      const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(intent).toHaveProperty("ok", true);
      if (!intent.ok) return;
      expect(intent.intent?.taskIds).toEqual(["bd-12", "bd-15"]);
      expect(intent.intent?.maxConcurrent).toBe(3);
      // Session + pid + process start time + the token held only in this session's
      // memory: a record alone is not enough to be the supervisor.
      expect(intent.intent?.supervisor).toMatchObject({
        sessionId: "operator-session",
        pid: process.pid,
      });
      expect(intent.intent?.supervisor?.armToken).toBeTypeOf("string");
      expect((intent.intent?.supervisor?.armToken ?? "").length).toBeGreaterThan(10);

      const report = ctxNotifications.map((entry) => entry.message).join("\n");
      expect(report).toContain("2/2 member(s) launched (maxConcurrent 3)");
      expect(report).toContain("Concurrency 9 is above the ceiling of 3");
      // Both member sessions were created through the existing single-bead path.
      expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(2);
      expect(mock.activeTools()).toEqual([]);
    });

    it("audits the launch and each member attempt", async () => {
      const mock = await loadFleetExtension();
      const command = mock.commands.get("fleet");
      if (command === undefined) throw new Error("/fleet was not registered");

      await command.handler("bd-12 --manual", makeCtx(cwd, "audited-session"));

      expect(auditActions()).toEqual(["schedule-planned", "launch", "member-launch"]);
    });

    it("re-arms a dead fleet: members kept, record rewritten, audited (C2)", async () => {
      writeIntent({
        taskIds: ["bd-12", "bd-15"],
        supervisor: { sessionId: "dead-session", pid: 999_999 },
      });
      const before = readFileSync(
        join(commonDir, "belayd", "fleet", "default", "fleet.json"),
        "utf8",
      );
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "resumed-supervisor");

      await arm(mock, ctx, "bd-12");

      const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      if (!intent.ok) throw new Error("intent unreadable");
      expect(intent.intent?.taskIds).toEqual(["bd-12", "bd-15"]);
      expect(intent.intent?.supervisor).toMatchObject({ sessionId: "resumed-supervisor" });
      // Without a re-arm, this record would be unrecoverable except by hand.
      expect(
        readFileSync(join(commonDir, "belayd", "fleet", "default", "fleet.json"), "utf8"),
      ).not.toBe(before);
      expect(auditActions()).toEqual(["re-arm"]);
      // bd-12 was already running as a member: a re-arm must not spawn a second
      // orchestrator on the same bead.
      expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(0);

      // The re-armed session is now the live supervisor (it holds the token).
      expect(await blockReason(mock, "belayd_commit", ctx)).toContain(
        "Fleet supervisor sessions do not run phases",
      );
      expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain("re-armed");
    });

    it("refuses to take over a fleet another live session supervises (W2)", async () => {
      writeIntent({
        taskIds: ["bd-12"],
        supervisor: { sessionId: "other-session", pid: process.pid, armToken: "their-token" },
      });
      const path = join(commonDir, "belayd", "fleet", "default", "fleet.json");
      const before = readFileSync(path, "utf8");
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "intruder-session");

      await arm(mock, ctx, "bd-12");

      expect(readFileSync(path, "utf8")).toBe(before);
      expect(daemon.calls).toEqual([]);
      const report = ctxNotifications.map((entry) => entry.message).join("\n");
      expect(report).toContain("already supervised by live session `other-session`");
      // The refused session was never armed.
      expect(await blockReason(mock, "belayd_commit", ctx)).toBe(undefined);
    });

    it("refuses a second fleet from an armed session and keeps the first drainable (W-B)", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx, "bd-12");

      const inbox = mock.tools.get("belayd_fleet_inbox");
      if (inbox === undefined) throw new Error("belayd_fleet_inbox was not registered");
      const before = await inbox.execute("inbox-1", {}, undefined, undefined, ctx);
      expect(before.details.exitCode).toBe(0);

      await arm(mock, ctx, "bd-15 --fleet night");

      const report = ctxNotifications.map((entry) => entry.message).join("\n");
      expect(report).toContain("already supervises fleet `default`");
      expect(report).toContain("Nothing was changed");
      // No second fleet directory and no second member session.
      expect(existsSync(join(commonDir, "belayd", "fleet", "night"))).toBe(false);
      expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);

      // Fleet A is still supervised and still drainable: the arm was not
      // replaced, so its inbox remains this session's inbox.
      expect(await blockReason(mock, "belayd_commit", ctx)).toContain(
        "Fleet supervisor sessions do not run phases",
      );
      const after = await inbox.execute("inbox-2", {}, undefined, undefined, ctx);
      expect(after.details.exitCode).toBe(0);
      expect(textOf(after)).toContain("inbox");
    });

    it("keeps supervision when a member launch in the same fleet fails (W-B)", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx, "bd-12");

      worktree.failWith = "worktree creation failed";
      await arm(mock, ctx, "bd-99");

      const report = ctxNotifications.map((entry) => entry.message).join("\n");
      expect(report).toContain("NOT launched");

      // The failed launch still rewrote the supervisor record with a new token;
      // the session must keep (and update) its arm, not be disarmed.
      expect(await blockReason(mock, "belayd_commit", ctx)).toContain(
        "Fleet supervisor sessions do not run phases",
      );
      const inbox = mock.tools.get("belayd_fleet_inbox");
      if (inbox === undefined) throw new Error("belayd_fleet_inbox was not registered");
      const drained = await inbox.execute("inbox-3", {}, undefined, undefined, ctx);
      expect(drained.details.exitCode).toBe(0);
    });

    it("refuses a worktree already driven by a standalone orchestrator (W-D)", async () => {
      const driven = join(cwd, "driven-bd-12");
      writeWorkflowState({
        cwd: driven,
        state: {
          schemaVersion: 1,
          taskId: "bd-12",
          workflowType: "feature",
          resolutionSource: "default",
          branch: "feat/bd-12",
          originalCwd: cwd,
          phaseOrder: ["plan"],
          completedPhaseNames: [],
          startedAt: 1,
          updatedAt: 1,
        },
      });
      const manifest = writeRunManifest({
        cwd: driven,
        manifest: {
          schemaVersion: 1,
          runId: "run-1",
          taskId: "bd-12",
          phase: "plan",
          sessionName: "belayd-bd-12",
          status: RunStatus.Running,
          startedAt: 1,
        },
      });
      expect(manifest).toHaveProperty("ok", true);
      worktree.branchPath = driven;
      worktree.branch = "feat/bd-12";

      const mock = await loadFleetExtension();
      await arm(mock, makeCtx(cwd, "operator-session"), "bd-12");

      const report = ctxNotifications.map((entry) => entry.message).join("\n");
      expect(report).toContain("already driven by a standalone orchestrator");
      // Refused before any spawn and before the intent was written.
      expect(daemon.calls).toEqual([]);
      const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(intent).toEqual({ ok: true, intent: undefined });
    });

    it("audits the recipients a partial broadcast actually reached (W-A)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      try {
        const mock = await loadFleetExtension();
        const ctx = makeCtx(cwd, "supervisor-session");
        await arm(mock, ctx, "bd-12 bd-15");

        // Make the second recipient's note path unwritable by planting a
        // directory with the exact content-addressed filename there: the fan-out
        // then writes bd-12 and fails on bd-15.
        const events = fleetEventsDir(commonDir, "default");
        const blocked = buildFleetNote({
          kind: "note",
          from: "supervisor",
          to: "bd-15",
          body: "hello fleet",
          now: Date.now(),
        });
        mkdirSync(join(events, fleetNoteFileName(blocked)), { recursive: true });

        const note = mock.tools.get("belayd_fleet_note");
        if (note === undefined) throw new Error("belayd_fleet_note was not registered");
        const refused = await note.execute(
          "note-1",
          { to: "all", body: "hello fleet" },
          undefined,
          undefined,
          ctx,
        );
        expect(refused.details.exitCode).toBe(1);

        const auditPath = join(commonDir, "belayd", "fleet", "default", "audit.log");
        const entries = readFileSync(auditPath, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as { action: string; taskIds: string[] });
        const partial = entries.find((entry) => entry.action === "note-partial");
        expect(partial).toBeDefined();
        expect(partial?.taskIds).toEqual(["bd-12"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * The fleet-events message the turn-start handlers produced, if any.
   *
   * Handlers are called in registration order; only the fleet handler attaches a
   * `belayd-fleet-events` message.
   */
  async function startTurn(
    mock: MockPi,
    ctx: ReturnType<typeof makeCtx>,
  ): Promise<string | undefined> {
    const messages: Array<{ customType: string; content: string }> = [];
    for (const handler of mock.agentStart) {
      const outcome = (await handler({ systemPromptOptions: {} }, ctx)) as
        | { message?: { customType: string; content: string } }
        | undefined;
      if (outcome?.message !== undefined) messages.push(outcome.message);
    }
    return messages.find((message) => message.customType === "belayd-fleet-events")?.content;
  }

  /** End the turn: the fleet ack runs here, after the model has read the message. */
  async function endTurn(mock: MockPi, ctx: ReturnType<typeof makeCtx>): Promise<void> {
    for (const handler of mock.agentEnd) {
      await handler({ systemPromptOptions: {} }, ctx);
    }
  }

  /**
   * A member session context: its own worktree directory (so two members can be
   * drained in one test) holding the workflow state that names its task id.
   */
  function makeMemberCtx(taskId: string): ReturnType<typeof makeCtx> {
    const memberCwd = join(cwd, `wt-${taskId}`);
    mkdirSync(memberCwd, { recursive: true });
    const written = writeWorkflowState({
      cwd: memberCwd,
      state: {
        schemaVersion: 1,
        taskId,
        workflowType: "feature",
        resolutionSource: "default",
        branch: `feat/${taskId}`,
        originalCwd: memberCwd,
        phaseOrder: ["plan"],
        completedPhaseNames: [],
        startedAt: 1,
        updatedAt: 1,
      },
    });
    if (!written.ok) throw new Error(`could not seed ${taskId} workflow state`);
    return makeCtx(memberCwd, `session-${taskId}`);
  }

  describe("mailbox", () => {
    it("writes a supervisor note into events/ and audits it", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      const note = mock.tools.get("belayd_fleet_note");
      if (note === undefined) throw new Error("belayd_fleet_note was not registered");

      const result = await note.execute(
        "note-1",
        { to: "bd-15", body: "main moved; rebase before review", kind: "rebase-hint" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details.exitCode).toBe(0);
      expect(textOf(result)).toContain("rebase-hint from supervisor to bd-15 queued in events");
      const drained = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      expect(drained).toHaveProperty("ok", true);
      if (!drained.ok) return;
      expect(drained.deliveries.map((delivery) => delivery.note.body)).toEqual([
        "main moved; rebase before review",
      ]);
      expect(auditActions()).toContain("note");
    });

    it("mirrors a supervisor note onto the recipient's bead as a belayd comment (bd-152)", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      // Only the note write matters here; the launch issued its own bd calls.
      childProcess.execFileCalls.length = 0;
      const note = mock.tools.get("belayd_fleet_note");
      if (note === undefined) throw new Error("belayd_fleet_note was not registered");

      const result = await note.execute(
        "note-1",
        { to: "bd-15", body: "main moved; rebase before review", kind: "base-moved" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details.exitCode).toBe(0);
      expect(textOf(result)).toContain("Mirrored to 1 bd comment(s)");
      const mirror = childProcess.execFileCalls.find(
        (call) =>
          call.file === "bd" && call.args.includes("comment") && call.args.includes("bd-15"),
      );
      expect(mirror?.stdin).toBe("[belayd:supervisor->bd-15] main moved; rebase before review");
      // A mirror must never look like a human answer, even from a session whose
      // own actor does not resolve.
      const actorIndex = mirror?.args.indexOf("--actor") ?? -1;
      expect(mirror?.args[actorIndex + 1]).toBe("belayd:supervisor");
      // The file mailbox is still the delivery protocol, so the note is queued.
      const drained = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!drained.ok) throw new Error("drain failed");
      expect(drained.deliveries.map((delivery) => delivery.note.to)).toEqual(["bd-15"]);
    });

    it("mirrors a broadcast as one comment per recipient bead, excerpt-capped (bd-152)", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      childProcess.execFileCalls.length = 0;
      const note = mock.tools.get("belayd_fleet_note");
      if (note === undefined) throw new Error("belayd_fleet_note was not registered");

      // Longer than a comment mirror may inject, so the cap is observable.
      const body = `line one\n\n${"detail ".repeat(1_000)}`;
      const result = await note.execute(
        "broadcast-1",
        { to: "all", body, kind: "base-moved" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details.exitCode).toBe(0);
      expect(textOf(result)).toContain("Mirrored to 2 bd comment(s)");
      const mirrors = childProcess.execFileCalls.filter(
        (call) => call.file === "bd" && call.args[0] === "comment",
      );
      // One comment per recipient bead — not one for the broadcast address.
      expect(mirrors.map((call) => call.args[call.args.length - 1]).sort()).toEqual([
        "bd-12",
        "bd-15",
      ]);
      for (const mirror of mirrors) {
        const recipient = mirror.args[mirror.args.length - 1];
        const prefix = `[belayd:supervisor->${recipient}] `;
        expect(mirror.stdin.startsWith(prefix)).toBe(true);
        expect(mirror.stdin).not.toContain("\n");
        expect(mirror.stdin).toHaveLength(prefix.length + COMMENT_EXCERPT_MAX_CHARS);
        expect(mirror.stdin.endsWith("…")).toBe(true);
        expect(mirror.args[mirror.args.indexOf("--actor") + 1]).toBe("belayd:supervisor");
      }
    });

    it("keeps the note delivered when the bd mirror fails (bd-152)", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      childProcess.execFileCalls.length = 0;
      childProcess.failBdComment = true;
      const note = mock.tools.get("belayd_fleet_note");
      if (note === undefined) throw new Error("belayd_fleet_note was not registered");

      const result = await note.execute(
        "note-1",
        { to: "bd-15", body: "main moved; rebase before review", kind: "base-moved" },
        undefined,
        undefined,
        ctx,
      );

      // The file mailbox is the delivery protocol: a bd refusal must not fail the
      // note, and the tool must not claim a mirror it did not write.
      expect(result.details.exitCode).toBe(0);
      expect(textOf(result)).toContain("queued in events");
      expect(textOf(result)).not.toContain("Mirrored to");
      const drained = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!drained.ok) throw new Error("drain failed");
      expect(drained.deliveries.map((delivery) => delivery.note.to)).toEqual(["bd-15"]);

      const auditPath = join(commonDir, "belayd", "fleet", "default", "audit.log");
      const entries = readFileSync(auditPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { action: string; detail: string });
      const failure = entries.find((entry) => entry.action === "note-mirror-failed");
      expect(failure?.detail).toContain("bd: comment write failed");
      expect(auditActions()).toContain("note");
    });

    it("fans a broadcast out to one file per member, each delivered exactly once (C1)", async () => {
      const mock = await loadFleetExtension();
      const supervisorCtx = makeCtx(cwd, "supervisor-session");
      await arm(mock, supervisorCtx);
      const note = mock.tools.get("belayd_fleet_note");
      if (note === undefined) throw new Error("belayd_fleet_note was not registered");

      const written = await note.execute(
        "broadcast-1",
        { to: "all", body: "main moved; rebase before the next phase", kind: "base-moved" },
        undefined,
        undefined,
        supervisorCtx,
      );
      expect(written.details.exitCode).toBe(0);
      expect(textOf(written)).toContain("to 2 members (bd-12, bd-15)");
      expect(textOf(written)).toContain("2 file(s)");

      const pending = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!pending.ok) throw new Error("drain failed");
      expect(pending.deliveries.map((delivery) => delivery.note.to).sort()).toEqual([
        "bd-12",
        "bd-15",
      ]);

      // Two members, drained in either order: each gets its own copy, and the
      // sibling's copy is untouched until that member acks (ack is deferred to
      // agent_end, so end the turn before checking the remaining mailbox).
      const first = makeMemberCtx("bd-12");
      const second = makeMemberCtx("bd-15");
      expect(await startTurn(mock, first)).toContain("main moved");
      await endTurn(mock, first);
      const stillPending = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!stillPending.ok) throw new Error("drain failed");
      expect(stillPending.deliveries.map((delivery) => delivery.note.to)).toEqual(["bd-15"]);

      expect(await startTurn(mock, second)).toContain("main moved");
      // Each copy is acked once; a later drain returns nothing.
      await endTurn(mock, second);
      const drained = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!drained.ok) throw new Error("drain failed");
      expect(drained.deliveries).toEqual([]);
      expect(await startTurn(mock, first)).toBe(undefined);
      expect(await startTurn(mock, second)).toBe(undefined);
    });

    it("refuses a typo target instead of creating mail nobody can receive (S3)", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      const note = mock.tools.get("belayd_fleet_note");
      if (note === undefined) throw new Error("belayd_fleet_note was not registered");

      const result = await note.execute(
        "typo-1",
        { to: "bd-51", body: "hello" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details.exitCode).toBe(1);
      expect(textOf(result)).toContain("not a member of this fleet");
      expect(textOf(result)).toContain("bd-12, bd-15");
      // Nothing was written, so no immortal dead mail accumulates.
      const drained = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!drained.ok) throw new Error("drain failed");
      expect(drained.deliveries).toEqual([]);
    });

    it("refuses a member writing into events/ for each kind (W1)", async () => {
      const mock = await loadFleetExtension();
      const supervisorCtx = makeCtx(cwd, "supervisor-session");
      await arm(mock, supervisorCtx);
      const note = mock.tools.get("belayd_fleet_note");
      if (note === undefined) throw new Error("belayd_fleet_note was not registered");
      const memberCtx = makeMemberCtx("bd-12");

      for (const kind of ["pause", "base-moved", "rebase-hint", "note"]) {
        const result = await note.execute(
          `spoof-${kind}`,
          { to: "bd-15", body: "sibling says stop", kind, channel: "events" },
          undefined,
          undefined,
          memberCtx,
        );
        expect(result.details.exitCode).toBe(1);
        expect(textOf(result)).toContain("events/ is supervisor-only");
      }

      // The member's own surface still works, addressed to the supervisor only.
      const inboxNote = await note.execute(
        "member-ok",
        { to: "supervisor", body: "phase done" },
        undefined,
        undefined,
        memberCtx,
      );
      expect(inboxNote.details.exitCode).toBe(0);

      const wrongAddress = await note.execute(
        "member-wrong-address",
        { to: "bd-15", body: "hello sibling" },
        undefined,
        undefined,
        memberCtx,
      );
      expect(wrongAddress.details.exitCode).toBe(1);
      expect(textOf(wrongAddress)).toContain("only be addressed to `supervisor`");
    });

    it("round-trips a note through the inbox and acknowledges it once", async () => {
      const mock = await loadFleetExtension();
      const note = mock.tools.get("belayd_fleet_note");
      const inbox = mock.tools.get("belayd_fleet_inbox");
      if (note === undefined || inbox === undefined) {
        throw new Error("fleet mailbox tools were not registered");
      }
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);

      const written = await note.execute(
        "note-2",
        { to: "supervisor", body: "plan finished", channel: "inbox" },
        undefined,
        undefined,
        ctx,
      );
      expect(written.details.exitCode).toBe(0);
      expect(textOf(written)).toContain("queued in inbox");

      const drained = await inbox.execute("inbox-1", {}, undefined, undefined, ctx);
      expect(drained.details.exitCode).toBe(0);
      expect(textOf(drained)).toContain("1 note(s) drained and acknowledged");
      expect(textOf(drained)).toContain("plan finished");

      const again = await inbox.execute("inbox-2", {}, undefined, undefined, ctx);
      expect(textOf(again)).toContain("(the mailbox was empty)");
    });

    it("renders an inbox note even when its ack fails, and says what remains (W5)", async () => {
      const mock = await loadFleetExtension();
      const note = mock.tools.get("belayd_fleet_note");
      const inbox = mock.tools.get("belayd_fleet_inbox");
      if (note === undefined || inbox === undefined) throw new Error("tools were not registered");
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);

      const written = await note.execute(
        "note-w5",
        { to: "supervisor", body: "details that must not vanish", channel: "inbox" },
        undefined,
        undefined,
        ctx,
      );
      expect(written.details.exitCode).toBe(0);

      // A read-only inbox lets the drain succeed and the unlink fail, which is
      // exactly the partial-ack case: the note was consumed for this result but
      // is still on disk, so its content must be reported *and* named as queued.
      const inboxDir = fleetInboxDir(commonDir, "default");
      chmodSync(inboxDir, 0o500);
      try {
        const drained = await inbox.execute("inbox-w5", {}, undefined, undefined, ctx);
        expect(textOf(drained)).toContain("details that must not vanish");
        expect(drained.details.exitCode).toBe(1);
        expect(textOf(drained)).toContain("still queued in inbox/");
        expect(textOf(drained)).toContain("Acknowledge failed");
      } finally {
        chmodSync(inboxDir, 0o700);
      }
    });

    it("refuses a non-supervisor session and an unknown fleet id", async () => {
      const mock = await loadFleetExtension();
      const inbox = mock.tools.get("belayd_fleet_inbox");
      const note = mock.tools.get("belayd_fleet_note");
      if (inbox === undefined || note === undefined) throw new Error("tools were not registered");

      const refused = await inbox.execute(
        "inbox-3",
        {},
        undefined,
        undefined,
        makeCtx(cwd, "nobody"),
      );
      expect(refused.details.exitCode).toBe(1);
      expect(textOf(refused)).toContain("supervisor-only");

      const noMailbox = await note.execute(
        "note-3",
        { to: "supervisor", body: "hello" },
        undefined,
        undefined,
        makeCtx(cwd, "nobody"),
      );
      expect(noMailbox.details.exitCode).toBe(1);
      expect(textOf(noMailbox)).toContain("neither a fleet supervisor nor a member");
    });

    it("refuses a fleet id the session does not supervise", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      const note = mock.tools.get("belayd_fleet_note");
      if (note === undefined) throw new Error("belayd_fleet_note was not registered");

      const result = await note.execute(
        "note-6",
        { to: "bd-12", body: "hello", fleetId: "night" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details.exitCode).toBe(1);
      expect(textOf(result)).toContain("This session supervises fleet `default`, not `night`.");
    });

    it("refuses an unknown note kind and an over-long body is truncated, not rejected", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      const note = mock.tools.get("belayd_fleet_note");
      if (note === undefined) throw new Error("belayd_fleet_note was not registered");

      const unknown = await note.execute(
        "note-4",
        { to: "bd-12", body: "x", kind: "shutdown" },
        undefined,
        undefined,
        ctx,
      );
      expect(unknown.details.exitCode).toBe(1);
      expect(textOf(unknown)).toContain("Valid kinds:");

      const long = await note.execute(
        "note-5",
        { to: "bd-12", body: "b".repeat(FLEET_NOTE_BODY_MAX_LENGTH + 50) },
        undefined,
        undefined,
        ctx,
      );
      expect(long.details.exitCode).toBe(0);
      const drained = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!drained.ok) throw new Error("drain failed");
      expect(drained.deliveries[0]?.note.body.length).toBe(FLEET_NOTE_BODY_MAX_LENGTH);
    });
  });

  describe("member events at turn start", () => {
    it("injects a pending event once, and acks it at agent_end (W4)", async () => {
      writeIntent({
        taskIds: ["bd-15"],
        supervisor: { sessionId: "supervisor-session", pid: 999_999 },
      });
      const ctx = makeMemberCtx("bd-15");

      const enqueued = enqueueNote({
        dir: fleetEventsDir(commonDir, "default"),
        note: {
          schemaVersion: 1,
          kind: "base-moved",
          from: "supervisor",
          to: "bd-15",
          body: "main moved to abc123; rebase before the next phase",
          createdAt: 42,
        },
      });
      expect(enqueued).toHaveProperty("ok", true);

      const mock = await loadFleetExtension();

      const first = await startTurn(mock, ctx);
      expect(first).toContain("main moved to abc123");

      // Still on disk: injection is not consumption. A crash here replays.
      const beforeAck = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!beforeAck.ok) throw new Error("drain failed");
      expect(beforeAck.deliveries).toHaveLength(1);

      await endTurn(mock, ctx);

      const afterAck = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!afterAck.ok) throw new Error("drain failed");
      expect(afterAck.deliveries).toEqual([]);
      expect(await startTurn(mock, ctx)).toBe(undefined);
      // The consumption is a cross-tree mutation, so it is audited (W3).
      expect(auditActions()).toContain("events-acked");
    });

    it("replays an event whose turn never ended (at-least-once)", async () => {
      writeIntent({
        taskIds: ["bd-15"],
        supervisor: { sessionId: "supervisor-session", pid: 999_999 },
      });
      const ctx = makeMemberCtx("bd-15");
      enqueueNote({
        dir: fleetEventsDir(commonDir, "default"),
        note: {
          schemaVersion: 1,
          kind: "rebase-hint",
          from: "supervisor",
          to: "bd-15",
          body: "rebase due",
          createdAt: 5,
        },
      });
      const mock = await loadFleetExtension();

      // Two turn starts without an agent_end (a crash between them): the note is
      // injected again instead of being lost silently.
      expect(await startTurn(mock, ctx)).toContain("rebase due");
      expect(await startTurn(mock, ctx)).toContain("rebase due");
    });

    it("leaves a sibling's event on disk and injects nothing", async () => {
      writeIntent({
        taskIds: ["bd-12", "bd-15"],
        supervisor: { sessionId: "supervisor-session", pid: 999_999 },
      });
      const ctx = makeMemberCtx("bd-12");
      enqueueNote({
        dir: fleetEventsDir(commonDir, "default"),
        note: {
          schemaVersion: 1,
          kind: "note",
          from: "supervisor",
          to: "bd-15",
          body: "for the sibling only",
          createdAt: 7,
        },
      });

      const mock = await loadFleetExtension();
      expect(await startTurn(mock, ctx)).toBe(undefined);

      const remaining = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!remaining.ok) throw new Error("drain failed");
      expect(remaining.deliveries).toHaveLength(1);
      expect(remaining.deliveries[0]?.note.to).toBe("bd-15");
    });

    it("ignores an event in events/ that a member planted (W1, defense in depth)", async () => {
      writeIntent({
        taskIds: ["bd-12"],
        supervisor: { sessionId: "supervisor-session", pid: 999_999 },
      });
      const ctx = makeMemberCtx("bd-12");
      enqueueNote({
        dir: fleetEventsDir(commonDir, "default"),
        note: {
          schemaVersion: 1,
          kind: "pause",
          from: "bd-13",
          to: "bd-12",
          body: "sibling says stop",
          createdAt: 8,
        },
      });

      const mock = await loadFleetExtension();
      const injected = await startTurn(mock, ctx);
      expect(injected).toContain("not supervisor-authored and were ignored");
      expect(injected).not.toContain("sibling says stop");
    });

    it("does not let a phase sub-agent consume the orchestrator's events", async () => {
      writeIntent({
        taskIds: ["bd-12"],
        supervisor: { sessionId: "supervisor-session", pid: 999_999 },
      });
      const ctx = makeMemberCtx("bd-12");
      enqueueNote({
        dir: fleetEventsDir(commonDir, "default"),
        note: {
          schemaVersion: 1,
          kind: "rebase-hint",
          from: "supervisor",
          to: "bd-12",
          body: "for the orchestrator, not its sub-agents",
          createdAt: 11,
        },
      });

      const mock = await loadFleetExtension();
      // Sub-agent sessions share this worktree and workflow state, so the drain
      // must not claim a note the orchestrator has not seen.
      const subAgent = makeCtx(ctx.cwd, "bd-12-sub-plan-abc123");
      expect(await startTurn(mock, subAgent)).toBe(undefined);

      const remaining = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
      if (!remaining.ok) throw new Error("drain failed");
      expect(remaining.deliveries).toHaveLength(1);
    });

    it("injects nothing for an empty mailbox or a session outside a fleet", async () => {
      writeIntent({
        taskIds: ["bd-12"],
        supervisor: { sessionId: "supervisor-session", pid: 999_999 },
      });
      const mock = await loadFleetExtension();

      expect(await startTurn(mock, makeCtx(cwd, "empty-mailbox-session"))).toBe(undefined);

      writeWorkflowState({
        cwd,
        state: {
          schemaVersion: 1,
          taskId: "bd-77",
          workflowType: "feature",
          resolutionSource: "default",
          branch: "feat/bd-77",
          originalCwd: cwd,
          phaseOrder: ["plan"],
          completedPhaseNames: [],
          startedAt: 1,
          updatedAt: 1,
        },
      });
      // bd-77 is not a member of any fleet, so there is no mailbox to drain.
      expect(await startTurn(mock, makeCtx(cwd, "non-member-session"))).toBe(undefined);
    });
  });
});

describe("launch tool validation", () => {
  let cwd: string;
  let commonDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-launch-"));
    commonDir = join(cwd, ".git");
    mkdirSync(join(commonDir, "belayd", "fleet", "default"), { recursive: true });
    git.commonDir = commonDir;
    git.failWith = undefined;
    worktree.path = join(cwd, "member-worktree");
    worktree.failWith = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    mkdirSync(worktree.path, { recursive: true });
    daemon.calls = [];
    daemon.failWith = undefined;
    ctxNotifications = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
    git.failWith = undefined;
  });

  it("refuses an invalid id with no fleet intent and no spawn", async () => {
    const mock = await loadFleetExtension();
    const launch = mock.tools.get("belayd_fleet_launch");
    if (launch === undefined) throw new Error("belayd_fleet_launch was not registered");

    const result = await launch.execute(
      "launch-1",
      { tasks: ["bd-12", "not-a-bead"] },
      undefined,
      undefined,
      makeCtx(cwd, "operator-session"),
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("not-a-bead");
    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toEqual({ ok: true, intent: undefined });
    expect(drainNotes({ dir: fleetInboxDir(commonDir, "default") })).toEqual({
      ok: true,
      deliveries: [],
      warnings: [],
    });
  });

  it("refuses a duplicate id", async () => {
    const mock = await loadFleetExtension();
    const launch = mock.tools.get("belayd_fleet_launch");
    if (launch === undefined) throw new Error("belayd_fleet_launch was not registered");

    const result = await launch.execute(
      "launch-2",
      { tasks: "bd-12 bd-12" },
      undefined,
      undefined,
      makeCtx(cwd, "operator-session"),
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("listed more than once");
  });

  it("clamps an over-ceiling request and says so", async () => {
    worktree.failWith = "wt is not installed";
    const mock = await loadFleetExtension();
    const launch = mock.tools.get("belayd_fleet_launch");
    if (launch === undefined) throw new Error("belayd_fleet_launch was not registered");

    const result = await launch.execute(
      "launch-3",
      { tasks: ["bd-12", "bd-15"], concurrency: 8 },
      undefined,
      undefined,
      makeCtx(cwd, "operator-session"),
    );

    const text = textOf(result);
    expect(text).toContain("Concurrency 8 is above the ceiling of 3 orchestrators");
    expect(text).toContain("NOT launched — Worktree creation failed");
    // Members failed, so the tool reports a non-zero exit code but still shows
    // the per-member outcome instead of disappearing.
    expect(result.details.exitCode).toBe(1);
  });

  it("refuses a launch while this session drives a workflow", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gated-session");
    const startTask = mock.tools.get("belayd_start_task");
    const launch = mock.tools.get("belayd_fleet_launch");
    if (startTask === undefined || launch === undefined) {
      throw new Error("tools were not registered");
    }
    await startTask.execute("gate-1", { taskId: "bd-12" }, undefined, undefined, ctx);

    const result = await launch.execute(
      "launch-4",
      { tasks: ["bd-15"] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("arms no process gate");
  });
});

describe("belayd_fleet_merge", () => {
  let cwd: string;
  let commonDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-merge-tool-"));
    commonDir = join(cwd, ".git");
    mkdirSync(join(commonDir, "belayd", "fleet", "default"), { recursive: true });
    git.commonDir = commonDir;
    git.failWith = undefined;
    worktree.path = join(cwd, "member-worktree");
    worktree.failWith = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    mkdirSync(worktree.path, { recursive: true });
    daemon.calls = [];
    daemon.failWith = undefined;
    ctxNotifications = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
    git.failWith = undefined;
  });

  it("registers the merge tool and refuses it outside supervisor mode", async () => {
    const mock = await loadFleetExtension();
    const tool = mock.tools.get("belayd_fleet_merge");
    if (tool === undefined) throw new Error("belayd_fleet_merge was not registered");

    const refused = await tool.execute(
      "merge-1",
      { action: "list" },
      undefined,
      undefined,
      makeCtx(cwd, "ordinary-session"),
    );
    expect(refused.details.exitCode).toBe(1);
    expect(textOf(refused)).toContain("supervisor-only");
  });

  it("lists an empty merge queue for an armed supervisor", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 --manual", ctx);

    const tool = mock.tools.get("belayd_fleet_merge");
    if (tool === undefined) throw new Error("belayd_fleet_merge was not registered");
    const listed = await tool.execute("merge-2", { action: "list" }, undefined, undefined, ctx);
    expect(listed.details.exitCode).toBe(0);
    expect(textOf(listed)).toContain("merge queue: empty");
  });

  it("enqueues one member and audits it, leaving the bead open", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    worktree.branchPath = join(cwd, "member-bd-12");
    worktree.branch = "feat/bd-12";
    mkdirSync(worktree.branchPath, { recursive: true });

    const tool = mock.tools.get("belayd_fleet_merge");
    if (tool === undefined) throw new Error("belayd_fleet_merge was not registered");
    const queued = await tool.execute(
      "merge-3",
      { action: "enqueue", task: "bd-12" },
      undefined,
      undefined,
      ctx,
    );
    expect(queued.details.exitCode).toBe(0);
    expect(textOf(queued)).toContain("queued for merge");

    const listed = await tool.execute("merge-4", { action: "list" }, undefined, undefined, ctx);
    expect(textOf(listed)).toContain("bd-12 (feat/bd-12): queued");

    const auditPath = join(commonDir, "belayd", "fleet", "default", "audit.log");
    const actions = readFileSync(auditPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions).toContain("merge-enqueued");
    // No bead mutation happened: there is no bd seam in the merge family at all.
    expect(actions).not.toContain("bd-close");
  });

  it("reports an empty queue from drain without failing the tool", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    const tool = mock.tools.get("belayd_fleet_merge");
    if (tool === undefined) throw new Error("belayd_fleet_merge was not registered");
    const drained = await tool.execute("merge-5", { action: "drain" }, undefined, undefined, ctx);
    expect(drained.details.exitCode).toBe(0);
    expect(textOf(drained)).toContain("nothing is queued for merge");
  });
});

/**
 * `/fleet` runs to completion by default (bd-126 P5).
 *
 * The loop itself is exercised by the pure `fleet-run` cases; what is pinned here
 * is the wiring: the launch records a run, names the members it started, and
 * starts the ticker — and `--manual` / `untilComplete: false` writes no run at all,
 * so the explicit surface is still reachable.
 *
 * Fake timers keep the first tick from running mid-assertion: this suite is about
 * the record, and a tick would run project gates.
 */
describe("fleet run mode", () => {
  let cwd: string;
  let commonDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-run-"));
    commonDir = join(cwd, ".git");
    mkdirSync(join(commonDir, "belayd", "fleet", "default"), { recursive: true });
    git.commonDir = commonDir;
    git.failWith = undefined;
    worktree.path = join(cwd, "member-worktree");
    worktree.failWith = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    mkdirSync(worktree.path, { recursive: true });
    daemon.calls = [];
    daemon.failWith = undefined;
    ctxNotifications = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
  });

  function intentRun(): { mode?: string; accept?: boolean; members?: unknown } | undefined {
    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    if (!intent.ok) return undefined;
    return intent.intent?.run;
  }

  it("records a run for the members it launched and starts the loop", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12", ctx);

    const run = intentRun();
    expect(run).toMatchObject({ mode: "until-complete", accept: true });
    expect(run?.members).toEqual([
      { taskId: "bd-12", launchedAt: expect.any(Number), sessionId: "member-session-id" },
    ]);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "running until every member is landed",
    );
    // The supervisor beat is what lets a later session tell a dead run-mode
    // supervisor from a live one (the recorded pid is the shared daemon).
    expect(existsSync(join(commonDir, "belayd", "fleet", "default", "supervisor.json"))).toBe(true);
  });

  it("keeps a stopped member in the fleet, and still lands it once its retry finishes", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    // The member's own run failed: the first tick stops it for a human. The state
    // is written after the launch, because a worktree that already holds workflow
    // state is refused as a second orchestrator.
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan"] });
    await vi.advanceTimersByTimeAsync(1);

    const stopped = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(stopped).toHaveProperty("ok", true);
    if (!stopped.ok) return;
    // A stop reports the session; it never erases membership (bd-156).
    expect(stopped.intent?.taskIds).toEqual(["bd-12"]);
    expect(stopped.intent?.deferred ?? []).toEqual([]);
    expect(stopped.intent?.run?.stopped).toEqual([
      expect.objectContaining({ taskId: "bd-12", reason: "phase-failed" }),
    ]);

    // The member's own retry finished: the run must still land it, even though it
    // is stopped, and a refused land must keep the membership too.
    writeMemberState({
      cwd: memberDir,
      completedPhaseNames: ["plan", "implement"],
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "could not land bd-12",
    );
    const afterLandAttempt = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(afterLandAttempt).toHaveProperty("ok", true);
    if (!afterLandAttempt.ok) return;
    expect(afterLandAttempt.intent?.taskIds).toEqual(["bd-12"]);
    expect(afterLandAttempt.intent?.run?.stopped?.map((entry) => entry.reason)).toEqual([
      "land-failed",
    ]);
  });

  it("lands a stopped member once its retry finished and the merge went through", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan"] });
    await vi.advanceTimersByTimeAsync(1);
    const stopped = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(stopped).toHaveProperty("ok", true);
    if (!stopped.ok) return;
    expect(stopped.intent?.run?.stopped).toEqual([
      expect.objectContaining({ taskId: "bd-12", reason: "phase-failed" }),
    ]);

    // The retry finished and the work is on the base branch: the queue says
    // `merged`, so the landing tick must prune the member rather than skip it
    // because it is stopped.
    const queue = createFleetMergeQueue(1);
    const written = writeFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId: "default",
      queue: {
        ...queue,
        entries: [
          {
            taskId: "bd-12",
            branch: "feat/bd-12",
            requestedAt: 1,
            state: "merged",
            attempts: 1,
            updatedAt: 2,
          },
        ],
      },
    });
    expect(written).toEqual({ ok: true });
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(2_000);

    const afterLand = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(afterLand).toHaveProperty("ok", true);
    if (!afterLand.ok) return;
    // Landing is the one automatic path that prunes: the member leaves taskIds
    // and the run records when it landed.
    expect(afterLand.intent?.taskIds).toEqual([]);
    expect(afterLand.intent?.run?.members?.[0]).toMatchObject({
      taskId: "bd-12",
      landedAt: expect.any(Number),
    });
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).not.toContain(
      "could not land bd-12",
    );
  });

  it("leaves beads for the human with --no-accept", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12 --no-accept", ctx);

    expect(intentRun()).toMatchObject({ mode: "until-complete", accept: false });
  });

  it("writes no run record with --manual", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12 --manual", ctx);

    expect(intentRun()).toBeUndefined();
    expect(existsSync(join(commonDir, "belayd", "fleet", "default", "supervisor.json"))).toBe(
      false,
    );
  });

  it("honours untilComplete: false on the launch tool", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const tool = mock.tools.get("belayd_fleet_launch");
    if (tool === undefined) throw new Error("belayd_fleet_launch was not registered");

    const result = await tool.execute(
      "launch-1",
      { tasks: "bd-12", untilComplete: false },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details.exitCode).toBe(0);
    expect(intentRun()).toBeUndefined();
  });
});

/**
 * One orchestrator per worktree (bd-126 P5).
 *
 * The worktree lease is taken by the spawner before the session exists, so a
 * launch into a worktree whose orchestrator is still alive must be refused before
 * any session is created. This is the invariant the duplicate-bd-37 incident broke.
 */
describe("worktree orchestrator lease", () => {
  let cwd: string;
  let commonDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-lease-"));
    commonDir = join(cwd, ".git");
    mkdirSync(join(commonDir, "belayd", "fleet", "default"), { recursive: true });
    git.commonDir = commonDir;
    git.failWith = undefined;
    worktree.path = join(cwd, "member-worktree");
    worktree.failWith = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    mkdirSync(worktree.path, { recursive: true });
    daemon.calls = [];
    daemon.failWith = undefined;
    ctxNotifications = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
  });

  function seedLiveLease(branch: string, sessionId: string): void {
    const dir = join(worktree.path, branch.replace(/\//g, "-"), ".belayd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "orchestrator.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bd-12",
        branch,
        sessionId,
        pid: 4242,
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );
  }

  it("refuses a member whose worktree already has a live orchestrator", async () => {
    seedLiveLease("feat/bd-12", "other-session");
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12 --manual", ctx);

    const text = ctxNotifications.map((entry) => entry.message).join("\n");
    expect(text).toContain("live orchestrator lease");
    expect(text).toContain("other-session");
    // No session was created, and the refused member is not recorded as a member.
    expect(daemon.calls.some((call) => call.path === "/sessions")).toBe(false);
    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent.ok ? intent.intent?.taskIds : undefined).toEqual([]);
  });
});
