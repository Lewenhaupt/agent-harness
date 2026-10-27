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
  FLEET_INTENT_ORDERING_GATES_MAX,
  FLEET_NOTE_BODY_MAX_LENGTH,
  FLEET_RUN_MAX_IDLE_TICKS,
  fleetEventsDir,
  fleetInboxDir,
  fleetNoteFileName,
  formatFleetRefusal,
  readFleetIntent,
  readFleetMergeQueue,
  recordRunMemberLanded,
  startFleetRun,
  updateFleetIntent,
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
  /**
   * Per-branch worktree paths for tests that observe more than one member: the
   * real probe answers for the branch it is asked about, and a wave test needs
   * "bd-12's worktree here, bd-13's not created yet".
   */
  byBranch: undefined as Record<string, string> | undefined,
}));

/** Force the next N intent writes to lose their CAS race (a two-attempt failure). */
const intentCas = vi.hoisted(() => ({ conflictsRemaining: 0 }));

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
    resolveWorktreePath: (_root: string, branch: string) => {
      // A per-branch map is authoritative: the real probe answers for the branch
      // it is asked about, never "whatever worktree exists".
      const byBranch = worktree.byBranch;
      if (byBranch !== undefined) return byBranch[branch];
      return worktree.branchPath === "" ? undefined : worktree.branchPath;
    },
    readWorktreeBranch: () =>
      worktree.branch === ""
        ? { ok: false as const, reason: "unavailable" as const, error: "git stubbed" }
        : { ok: true as const, branch: worktree.branch },
    // The real collector shells out to bd/git; the packet itself is irrelevant
    // here (only its absence is exercised), so a minimal stub keeps the launch
    // path deterministic.
    collectHandoffDefault: async () => undefined as unknown as HandoffPacket,
    updateFleetIntent: (options: Parameters<typeof actual.updateFleetIntent>[0]) => {
      if (intentCas.conflictsRemaining > 0) {
        intentCas.conflictsRemaining -= 1;
        return { ok: false as const, reason: "conflict" as const, error: "stub conflict" };
      }
      return actual.updateFleetIntent(options);
    },
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
  /**
   * Stdout for one `bd` call, so a test can give the scheduler a real dependency
   * edge; every other call keeps the empty-output default.
   */
  bdStdout: undefined as ((args: readonly string[]) => string | undefined) | undefined,
  /** bd failure text for tests that pin a failed write (a gate resolve, say). */
  bdFailure: undefined as ((args: readonly string[]) => string | undefined) | undefined,
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
        const bdFailure = file === "bd" ? childProcess.bdFailure?.(args) : undefined;
        const fails =
          bdFailure !== undefined ||
          (childProcess.failBdComment && file === "bd" && args[0] === "comment");
        // Answer synchronously, like the successful stub this file always had:
        // some callers (the fleet git runner) spawn through their own promise
        // wrapper and never close stdin. bd goes through `runFileCommand`, which
        // closes it right after, so the recorded body is still set before the
        // awaiting test resumes — and a failing comment rejects on that close,
        // where the real child would have failed.
        if (!fails)
          done(null, (file === "bd" ? childProcess.bdStdout?.(args) : undefined) ?? "", "");
        const childStdin = {
          on: () => {},
          end: (chunk?: string) => {
            record.stdin = chunk ?? "";
            if (fails) {
              done(new Error(bdFailure ?? "bd: comment write failed"), "", "");
            }
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
  /** Every name the extension applied to this session, in order. */
  sessionNames: string[];
}

function createMockPi(): MockPi {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, PiCommand>();
  const agentStart: AgentStartHandler[] = [];
  const agentEnd: AgentStartHandler[] = [];
  const toolCall: ToolCallHandler[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const sessionNames: string[] = [];
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
    setSessionName: (name: string) => {
      sessionNames.push(name);
    },
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
    sessionNames,
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
        // One-shot hook for the window between the launch engine writing the new
        // plan (its warnings are notified right there) and the tick re-reading it.
        const hook = afterLaunchHook;
        afterLaunchHook = undefined;
        hook?.();
      },
    },
  };
}

/**
 * Runs inside a tick's first notification, i.e. after the launch engine returned.
 *
 * A test uses it to remove `fleet.json` in the same window a reconcile or an
 * operator cleanup would, which no filesystem seam of the engine can reach.
 */
let afterLaunchHook: (() => void) | undefined;

// Notifications are asserted per test; the mock pi and the ctx both expose the
// same sink so a refusal can be checked from either side.
let ctxNotifications: Array<{ message: string; level: string }> = [];

/**
 * Write a member's workflow snapshot, with a failed run for the pending phase.
 *
 * Matches the tick's own reading: a pending phase whose newest run failed is
 * `phase-failed`, and a workflow whose phases are all complete is `complete`.
 */
function writeMemberState(options: {
  cwd: string;
  completedPhaseNames: readonly string[];
  /** Defaults to bd-12; a wave test writes more than one member's worktree. */
  taskId?: string;
}): void {
  const taskId = options.taskId ?? "bd-12";
  const phaseOrder = ["plan", "implement"];
  const pending =
    phaseOrder.find((phase) => !options.completedPhaseNames.includes(phase)) ?? "commit";
  const state = writeWorkflowState({
    cwd: options.cwd,
    state: {
      schemaVersion: 1,
      taskId,
      workflowType: "feature",
      resolutionSource: "default",
      branch: `feat/${taskId}`,
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
      taskId,
      phase: pending,
      sessionName: `belayd-${taskId}-${pending}`,
      status: RunStatus.Failed,
      // The member's own run, dated at/after its launch, so both run filters keep
      // it: the taskId matches and it does not predate the launch (bd-161).
      startedAt: Date.now(),
      completedAt: Date.now(),
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
    worktree.byBranch = undefined;
    mkdirSync(worktree.path, { recursive: true });
    daemon.calls = [];
    daemon.failWith = undefined;
    childProcess.failBdComment = false;
    ctxNotifications = [];
    afterLaunchHook = undefined;
    intentCas.conflictsRemaining = 0;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
    git.failWith = undefined;
    afterLaunchHook = undefined;
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

  it("sweeps every member's unrecorded ordering gates on a reconcile pass", async () => {
    // W4: a reconcile is an explicit repair, not a heartbeat, so the sweep must ask
    // bd about every member. A rotating tick asks one bead (alphabetically first),
    // which would leave the gate on bd-15 undiscovered while the output claimed a
    // repair happened.
    const sessionId = "supervisor-session";
    const marker = (blocker: string, blocked: string, id: string): Record<string, unknown> => {
      const text = `belayd-fleet-ordering: fleet:default ${blocker} -> ${blocked}`;
      return {
        id,
        status: "open",
        await_type: "human",
        title: text,
        description: `Ad-hoc gate blocking ${blocked}\n\nReason: ${text}`,
      };
    };
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate" && args[1] === "list") {
        // Only bd-15 is gated: the member a one-bead rotation would skip.
        return args[2] === "bd-15" ? JSON.stringify([marker("bd-12", "bd-15", "bd-970")]) : "null";
      }
      return undefined;
    };
    try {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, sessionId);
      await arm(mock, ctx);

      const reconciled = await mock.tools
        .get("belayd_fleet_reconcile")
        ?.execute("call-1", {}, undefined, undefined, ctx);
      expect(reconciled?.details).toHaveProperty("exitCode", 0);

      const loaded = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(loaded).toHaveProperty("ok", true);
      if (!loaded.ok) return;
      expect(loaded.intent?.orderingGates).toEqual([
        { blocker: "bd-12", blocked: "bd-15", gateId: "bd-970" },
      ]);
      expect(auditActions()).toContain("ordering-gates-adopted");
    } finally {
      childProcess.bdStdout = undefined;
    }
  });

  it("leaves fleet.json readable when a sweep cannot adopt past the gate bound", async () => {
    // C1: a crash window can leave more gates in bd than `fleet.json` may record.
    // One full sweep must refuse the extra adoption (and leave that gate open, since
    // resolving it would release a dependent before its blocker landed) rather than
    // write an over-bound record that every later reader rejects as `corrupt-intent`.
    const sessionId = "supervisor-session";
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, sessionId);
    await arm(mock, ctx);

    const atBound = Array.from({ length: FLEET_INTENT_ORDERING_GATES_MAX }, (_, index) => ({
      blocker: "bd-15",
      blocked: "bd-12",
      gateId: `bd-${5000 + index}`,
    }));
    const seeded = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) =>
        current === undefined ? { refuse: "no intent" } : { ...current, orderingGates: atBound },
    });
    expect(seeded).toHaveProperty("ok", true);

    const text = `belayd-fleet-ordering: fleet:default bd-12 -> bd-15`;
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate" && args[1] === "list") {
        if (args[2] !== "bd-15") return "null";
        return JSON.stringify([
          { id: "bd-970", status: "open", await_type: "human", title: text, description: text },
        ]);
      }
      return undefined;
    };
    try {
      const reconciled = await mock.tools
        .get("belayd_fleet_reconcile")
        ?.execute("call-1", {}, undefined, undefined, ctx);
      expect(reconciled?.details).toHaveProperty("exitCode", 0);

      const reported = ctxNotifications.map((entry) => entry.message).join("\n");
      expect(reported).toContain("bd-970");
      expect(reported).toContain("bd-12 -> bd-15");
      expect(reported).toContain("could not be recorded");

      // The gate stays open: nothing resolved it. On a `bd gate list` of bd-15 it
      // must still be reachable for the human who inspects it.
      const resolves = childProcess.execFileCalls
        .filter((call) => call.file === "bd" && call.args[0] === "gate")
        .filter((call) => call.args[1] === "resolve")
        .map((call) => [...call.args]);
      expect(resolves).toEqual([]);

      // And the fleet is still a real fleet: readable, at the bound, and tickable.
      const loaded = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(loaded).toHaveProperty("ok", true);
      if (!loaded.ok) return;
      expect(loaded.intent?.orderingGates).toHaveLength(FLEET_INTENT_ORDERING_GATES_MAX);

      const again = await mock.tools
        .get("belayd_fleet_reconcile")
        ?.execute("call-2", {}, undefined, undefined, ctx);
      expect(again?.details).toHaveProperty("exitCode", 0);
      const reread = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(reread).toHaveProperty("ok", true);
    } finally {
      childProcess.bdStdout = undefined;
    }
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
    worktree.byBranch = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    worktree.byBranch = undefined;
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
    worktree.byBranch = undefined;
    worktree.failWith = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    worktree.byBranch = undefined;
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
    worktree.byBranch = undefined;
    worktree.path = join(cwd, "member-worktree");
    worktree.failWith = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    worktree.byBranch = undefined;
    mkdirSync(worktree.path, { recursive: true });
    daemon.calls = [];
    daemon.failWith = undefined;
    childProcess.bdStdout = undefined;
    childProcess.bdFailure = undefined;
    ctxNotifications = [];
    afterLaunchHook = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    childProcess.bdStdout = undefined;
    afterLaunchHook = undefined;
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
  });

  function intentRun(): { mode?: string; accept?: boolean; members?: unknown } | undefined {
    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    if (!intent.ok) return undefined;
    return intent.intent?.run;
  }

  /** Every audit entry of one action, with the ids and detail it recorded. */
  function auditEntries(action: string): Array<{ taskIds: readonly string[]; detail: string }> {
    const path = join(commonDir, "belayd", "fleet", "default", "audit.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { action: string; taskIds?: string[]; detail?: string })
      .filter((entry) => entry.action === action)
      .map((entry) => ({ taskIds: entry.taskIds ?? [], detail: entry.detail ?? "" }));
  }

  /** Rewrite the armed fleet record, the way a rival fleet or an operator would. */
  function editIntent(mutate: (intent: Record<string, unknown>) => Record<string, unknown>): void {
    const path = join(commonDir, "belayd", "fleet", "default", "fleet.json");
    const intent = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(mutate(intent)));
  }

  /**
   * Start a run whose only member then stops itself, ready for the advance cases.
   *
   * No worktree is resolvable for the member, so once the start grace passes the
   * tick reads `orchestrator-missing` and stops it — the state the bd-157 report
   * observed, with the member still in `taskIds` (bd-156).
   */
  async function stopEveryMemberInRun(): Promise<void> {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    // Ticks land at 15 s while the member is only `starting`; the stop tick is the
    // one at the 120 s grace boundary, and nothing is scheduled before 121 s.
    await vi.advanceTimersByTimeAsync(121_000);
    const stopped = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(stopped).toHaveProperty("ok", true);
    if (!stopped.ok) return;
    expect(stopped.intent?.run?.stopped).toEqual([
      expect.objectContaining({ taskId: "bd-12", reason: "orchestrator-missing" }),
    ]);
  }

  it("ends a stopped-everything run as partial on the next tick, not after 240", async () => {
    // The bd-157 report: nothing working, the deferred wave unplannable, and the loop
    // re-planning it every 15 s until the idle cap halted the run as stalled.
    await stopEveryMemberInRun();

    // bd reports bd-19 blocked by the stopped (still-a-member) bd-12, so the advance
    // is a dependency wave it can only re-defer. The internal edge also needs a real
    // gate (bd-158): a launch whose `bd gate create` yields no id refuses instead of
    // planning, which would skip the wave this test is about.
    childProcess.bdStdout = (args) => {
      if (args[0] === "show") {
        return args.includes("bd-19")
          ? JSON.stringify([
              {
                id: "bd-19",
                dependencies: [{ id: "bd-12", dependency_type: "blocks", status: "in_progress" }],
              },
            ])
          : undefined;
      }
      if (args[0] !== "gate") return undefined;
      // bd answers `null` for a bead with no open gates.
      if (args[1] === "list") return "null";
      return JSON.stringify({ id: "bd-950", status: "open", await_type: "human" });
    };
    editIntent((intent) => ({
      ...intent,
      deferred: [
        {
          taskId: "bd-19",
          reason: "dependency",
          blockers: ["bd-12"],
          detail: "wave 1: waits for bd-12 to land",
        },
      ],
    }));

    // The stop tick reschedules at the 2 s action interval; that next tick is the
    // empty advance, and it must also be the last one.
    await vi.advanceTimersByTimeAsync(2_000);

    const finished = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(finished).toHaveProperty("ok", true);
    if (!finished.ok) return;
    expect(finished.intent?.run?.finishedAt).toEqual(expect.any(Number));
    expect(finished.intent?.run?.outcome).toBe("partial");
    expect(finished.intent?.run?.idleTicks).toBe(0);
    expect(finished.intent?.run?.haltedReason).toBeUndefined();

    const plannedForWave = auditEntries("schedule-planned").filter((entry) =>
      entry.taskIds.includes("bd-19"),
    );
    expect(plannedForWave).toHaveLength(1);
    expect(
      auditEntries("member-deferred").filter((entry) => entry.taskIds.includes("bd-19")),
    ).toHaveLength(1);
    const completed = auditEntries("fleet-run-complete");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.detail).toContain("bd-19 (dependency)");

    // The loop is over: minutes of would-be ticks add nothing.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(
      auditEntries("schedule-planned").filter((entry) => entry.taskIds.includes("bd-19")),
    ).toHaveLength(1);
    expect(auditEntries("fleet-run-complete")).toHaveLength(1);
  });

  it("completes on a hard launch refusal instead of waiting out a capacity block", async () => {
    await stopEveryMemberInRun();

    // A corrupt sibling intent makes the orchestrator count unknowable, so the launch
    // engine refuses hard (`ok: false`). Capacity deferrals must not turn that into a
    // wait: the engine would refuse identically on every tick.
    mkdirSync(join(commonDir, "belayd", "fleet", "other"), { recursive: true });
    writeFileSync(join(commonDir, "belayd", "fleet", "other", "fleet.json"), "{not json");
    editIntent((intent) => ({
      ...intent,
      maxConcurrent: 1,
      deferred: [{ taskId: "bd-19", reason: "capacity", blockers: [], detail: "no free slot" }],
    }));

    await vi.advanceTimersByTimeAsync(2_000);

    const finished = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(finished).toHaveProperty("ok", true);
    if (!finished.ok) return;
    expect(finished.intent?.run?.outcome).toBe("partial");
    const completed = auditEntries("fleet-run-complete");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.detail).toContain("orchestrator count is unknown");
  });

  it("waits on a capacity-blocked advance, then halts as stalled at the idle cap", async () => {
    await stopEveryMemberInRun();

    // One slot, already held by the stopped-but-still-a-member bd-12, so the wave is
    // capacity-blocked. The idle count is seeded one tick below the cap: the first
    // empty advance waits (a slot elsewhere can still free), the next halts.
    editIntent((intent) => {
      const run = intent.run as Record<string, unknown>;
      return {
        ...intent,
        maxConcurrent: 1,
        deferred: [{ taskId: "bd-19", reason: "capacity", blockers: [], detail: "no free slot" }],
        run: { ...run, idleTicks: FLEET_RUN_MAX_IDLE_TICKS - 1 },
      };
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const waiting = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(waiting).toHaveProperty("ok", true);
    if (!waiting.ok) return;
    expect(waiting.intent?.run?.finishedAt).toBeUndefined();
    expect(waiting.intent?.run?.idleTicks).toBe(FLEET_RUN_MAX_IDLE_TICKS);

    await vi.advanceTimersByTimeAsync(15_000);
    const halted = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(halted).toHaveProperty("ok", true);
    if (!halted.ok) return;
    // Still not finished: a halt is terminal for the run record, not a completion.
    expect(halted.intent?.run?.finishedAt).toBeUndefined();
    expect(halted.intent?.run?.haltedReason).toContain("stalled");
    expect(halted.intent?.run?.haltedReason).toContain("bd-19 (capacity)");
    // The tick that gives up must not reset the count that justified it: like the
    // plan's own `idleOrWait` halt, it counts as one more idle tick (never `0`).
    expect(halted.intent?.run?.idleTicks).toBe(FLEET_RUN_MAX_IDLE_TICKS + 1);
    expect(auditEntries("fleet-run-halted")).toHaveLength(1);

    // The timer is stopped: the cap costs one last re-plan (the halt is decided after
    // the advance), and further minutes add neither a plan nor a second halt.
    const plannedBefore = auditEntries("capacity-blocked").length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(auditEntries("capacity-blocked")).toHaveLength(plannedBefore);
    expect(auditEntries("fleet-run-halted")).toHaveLength(1);
  });

  it("halts when the fleet record disappears while an advance is in flight", async () => {
    await stopEveryMemberInRun();

    editIntent((intent) => ({
      ...intent,
      maxConcurrent: 1,
      deferred: [{ taskId: "bd-19", reason: "capacity", blockers: [], detail: "no free slot" }],
    }));
    const plannedBefore = auditEntries("schedule-planned").length;
    // An unreadable dependency graph is a warning the launch engine reports after it
    // has written the plan, which is the hook point below.
    childProcess.bdStdout = (args) => (args[0] === "show" ? "{not json" : undefined);
    const fleetFile = join(commonDir, "belayd", "fleet", "default", "fleet.json");
    // The engine's own warnings are notified after it wrote the re-planned intent and
    // before the tick re-reads it: the window a reconcile or an operator cleanup can
    // empty, which would otherwise let the tick classify from the pre-launch plan.
    afterLaunchHook = () => rmSync(fleetFile, { force: true });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(existsSync(fleetFile)).toBe(false);
    const lines = ctxNotifications.map((entry) => entry.message).join("\n");
    // The advance's own report is kept as the leading line, then the run stops
    // instead of classifying from the plan the advance just replaced.
    expect(lines).toContain("Scheduling: 0 member(s) now, 1 deferred");
    expect(lines).toContain("run halted — the fleet intent for `default` is gone");
    // A halt is not a completion: nothing was classified, nothing was written.
    expect(auditEntries("fleet-run-complete")).toHaveLength(0);
    expect(auditEntries("fleet-run-halted")).toHaveLength(0);

    // `stop: true` means the timer is gone, so minutes of would-be ticks add nothing.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(auditEntries("schedule-planned")).toHaveLength(plannedBefore + 1);
    expect(auditEntries("fleet-run-complete")).toHaveLength(0);
  });

  it("records a run for the members it launched and starts the loop", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12", ctx);

    const run = intentRun();
    // bd-158: acceptance is opt-in. A bare /fleet lands members and leaves every
    // bead in_progress + human; ordering comes from bd gates, not from a close.
    expect(run).toMatchObject({ mode: "until-complete", accept: false });
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

  it("names the supervisor session after the members it supervises", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-name-launch");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12", ctx);

    // The supervisor is an ordinary session whose work happens in a timer, so the
    // name is the only thing that says which beads it is driving.
    expect(mock.sessionNames).toEqual(["Fleet supervisor: bd-12"]);
  });

  it("does not re-apply the same supervisor name on every tick", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-name-idle");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12", ctx);
    await vi.advanceTimersByTimeAsync(60_000);

    // Each rename appends a `session_info` entry to the transcript; an idle run
    // must not grow the session just to restate its name.
    expect(mock.sessionNames).toEqual(["Fleet supervisor: bd-12"]);
  });

  it("keeps the supervisor name when the run is only paused", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-name-paused");
    const command = mock.commands.get("fleet");
    const pause = mock.tools.get("belayd_fleet_pause");
    if (command === undefined || pause === undefined) {
      throw new Error("/fleet and belayd_fleet_pause must be registered");
    }

    await command.handler("bd-12", ctx);
    await pause.execute("pause-1", { reason: "stepping away" }, undefined, undefined, ctx);
    await vi.advanceTimersByTimeAsync(15_000);

    // A pause resumes the same run, so a "(paused)" suffix would outlive the pause.
    expect(mock.sessionNames).toEqual(["Fleet supervisor: bd-12"]);
  });

  // bd-161: `.belayd/` is gitignored and `wt step copy-ignored` copies it into every
  // new worktree, so a member inherited the primary checkout's failed bd-37 implement
  // run and was stopped as `phase implement failed` while it was still scouting.
  it("ignores a run manifest inherited from the primary checkout", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    const inherited = writeRunManifest({
      cwd: memberDir,
      manifest: {
        schemaVersion: 1,
        runId: "mthosemh",
        taskId: "bd-37",
        phase: "implement",
        sessionName: "belayd-bd-37-sub-implement-mthosemh",
        status: RunStatus.Failed,
        startedAt: 1_788_207_858_953,
        completedAt: 1_788_208_222_826,
        exitCode: 143,
      },
    });
    expect(inherited).toHaveProperty("ok", true);

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    await vi.advanceTimersByTimeAsync(1);

    const observed = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(observed).toHaveProperty("ok", true);
    if (!observed.ok) return;
    // Another bead's failure is not this member's evidence: no stop, still in flight.
    expect(observed.intent?.run?.stopped ?? []).toEqual([]);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).not.toContain(
      "stopped bd-12",
    );
  });

  it("ignores this member's own run manifest copied in from an earlier launch", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    // The same bead, but from the execution before this fleet launched it: the
    // manifest carries a matching taskId, so only the launch cutoff rejects it.
    const copied = writeRunManifest({
      cwd: memberDir,
      manifest: {
        schemaVersion: 1,
        runId: "earlier-run",
        taskId: "bd-12",
        phase: "implement",
        sessionName: "belayd-bd-12-sub-implement-earlier-run",
        status: RunStatus.Failed,
        startedAt: 2,
        completedAt: 3,
        failureReason: "gate failed",
      },
    });
    expect(copied).toHaveProperty("ok", true);

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    await vi.advanceTimersByTimeAsync(1);

    const observed = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(observed).toHaveProperty("ok", true);
    if (!observed.ok) return;
    // Re-launching a bead into a fresh worktree must not inherit its own past
    // failure as a stop verdict for the new execution.
    expect(observed.intent?.run?.stopped ?? []).toEqual([]);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).not.toContain(
      "stopped bd-12",
    );
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

    // --no-accept is still parsed: it restates the (new) default, so an older
    // muscle memory is not a parse error.
    expect(intentRun()).toMatchObject({ mode: "until-complete", accept: false });
  });

  it("accepts landed beads only when --accept asked for it", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12 --accept", ctx);

    expect(intentRun()).toMatchObject({ mode: "until-complete", accept: true });
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
 * Fleet ordering as bd gates (bd-158).
 *
 * The fleet used to unblock a dependent by closing its blocker's bead, which is
 * also the human's acceptance signal. These cases pin the replacement: the launch
 * creates one gate per *internal* edge, a landing resolves it, and neither path
 * closes a bead or touches its labels. The reap cases cover the two ways a gate
 * loses its reason to exist without a landing: the bead was closed by a human, or
 * the member is gone.
 *
 * bd is stubbed at \`execFile\`, so the assertions cover the exact argv the
 * extension would run against a real database.
 */
describe("fleet ordering gates", () => {
  let cwd: string;
  let commonDir: string;
  let mintedGate: number;

  beforeEach(() => {
    vi.useFakeTimers();
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-gates-"));
    commonDir = join(cwd, ".git");
    mkdirSync(join(commonDir, "belayd", "fleet", "default"), { recursive: true });
    git.commonDir = commonDir;
    git.failWith = undefined;
    worktree.path = join(cwd, "member-worktree");
    worktree.failWith = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    worktree.byBranch = undefined;
    mkdirSync(worktree.path, { recursive: true });
    daemon.calls = [];
    daemon.failWith = undefined;
    childProcess.bdStdout = undefined;
    childProcess.bdFailure = undefined;
    childProcess.execFileCalls = [];
    ctxNotifications = [];
    mintedGate = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
  });

  /** bd answers the dependency graph and mints a gate for every create. */
  function stubBd(dependencies: unknown[], beadStatuses: Record<string, string> = {}): void {
    childProcess.bdStdout = (args) => answerBd(args, dependencies, beadStatuses);
  }

  function answerBd(
    args: readonly string[],
    dependencies: unknown[],
    beadStatuses: Record<string, string>,
  ): string | undefined {
    if (args[0] === "show") return showAnswer(args, dependencies, beadStatuses);
    if (args[0] === "gate") return gateAnswer(args);
    return undefined;
  }

  function showAnswer(
    args: readonly string[],
    dependencies: unknown[],
    beadStatuses: Record<string, string>,
  ): string {
    if (args.includes("--brief-deps")) return JSON.stringify(dependencies);
    const ids = args.slice(1).filter((arg) => !arg.startsWith("-"));
    return JSON.stringify(ids.map((id) => ({ id, status: beadStatuses[id] ?? "open" })));
  }

  function gateAnswer(args: readonly string[]): string | undefined {
    if (args[1] === "create") {
      mintedGate += 1;
      return JSON.stringify({ id: `bd-90${mintedGate}`, status: "open", await_type: "human" });
    }
    // bd answers `null` for a bead with no open gates.
    if (args[1] === "list") return "null";
    if (args[1] === "resolve") return `✓ Gate resolved: ${args[2] ?? ""}\n`;
    return undefined;
  }

  function intent(): ReturnType<typeof readFleetIntent> {
    return readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
  }

  function bdCalls(predicate: (args: readonly string[]) => boolean): string[][] {
    return childProcess.execFileCalls
      .filter((call) => call.file === "bd" && predicate(call.args))
      .map((call) => [...call.args]);
  }

  it("gates an internal edge once and leaves external blockers to bd", async () => {
    stubBd([
      { id: "bd-12", dependencies: [{ id: "bd-13", dependency_type: "blocks", status: "open" }] },
      { id: "bd-13", dependencies: [{ id: "bd-99", dependency_type: "blocks", status: "open" }] },
    ]);
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-launch");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12 bd-13", ctx);

    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    // Only the member -> member edge is fleet-owned ordering. bd-99 already blocks
    // bd-13's bead through the ordinary dependency edge.
    expect(loaded.intent?.orderingGates).toEqual([
      { blocker: "bd-13", blocked: "bd-12", gateId: "bd-901" },
    ]);
    const creates = bdCalls((args) => args[0] === "gate" && args[1] === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("--blocks");
    expect(creates[0]).toContain("bd-12");
    // The gate is marked as fleet ordering, so no human-wait reader picks it up.
    expect(creates[0]?.join(" ")).toContain("belayd-fleet-ordering:");
  });

  it("creates no gate when every blocker is outside the fleet", async () => {
    stubBd([
      { id: "bd-12", dependencies: [{ id: "bd-99", dependency_type: "blocks", status: "open" }] },
    ]);
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-launch-external");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12", ctx);

    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.orderingGates).toBeUndefined();
    expect(bdCalls((args) => args[0] === "gate" && args[1] === "create")).toEqual([]);
  });

  it("refuses the launch when a gate cannot be created, resolving what it made", async () => {
    stubBd([
      { id: "bd-12", dependencies: [{ id: "bd-13", dependency_type: "blocks", status: "open" }] },
      { id: "bd-13", dependencies: [] },
    ]);
    childProcess.bdFailure = (args) =>
      args[0] === "gate" && args[1] === "create" ? "bd: database unavailable" : undefined;
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-launch-refused");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12 bd-13", ctx);

    // Ordering correctness beats convenience: a launch that cannot gate its edges
    // must not start members whose dependents bd knows nothing about.
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "Could not create the bd ordering gates",
    );
    const loaded = intent();
    expect(loaded.ok ? (loaded.intent?.taskIds ?? []) : []).toEqual([]);
  });

  it("resolves its ordering gates on landing and never closes the bead", async () => {
    stubBd([
      { id: "bd-12", dependencies: [] },
      { id: "bd-13", dependencies: [] },
    ]);
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-landing");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    const injected = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) =>
        current === undefined
          ? { refuse: "no intent" }
          : {
              ...current,
              // bd-12 lands before bd-13: the gate the landing must resolve.
              orderingGates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" }],
            },
    });
    expect(injected).toHaveProperty("ok", true);

    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    mkdirSync(memberDir, { recursive: true });
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    const queue = createFleetMergeQueue(1);
    writeFleetMergeQueue({
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

    await vi.advanceTimersByTimeAsync(2_000);

    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([
      ["gate", "resolve", "bd-900"],
    ]);
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    // The gate's record goes with the gate: a later supervisor must not try to
    // resolve an id bd already resolved.
    expect(loaded.intent?.orderingGates).toBeUndefined();
    expect(loaded.intent?.run?.members?.find((member) => member.taskId === "bd-12")).toMatchObject({
      landedAt: expect.any(Number),
    });
    // Merging is not closing, and acceptance is not this path's business: no
    // close, and no label write either (the human marker must survive the landing).
    expect(bdCalls((args) => args[0] === "close" || args[0] === "label")).toEqual([]);
  });

  it("records the landing when its ordering gate cannot be resolved, then retries without re-merging", async () => {
    stubBd([
      { id: "bd-12", dependencies: [] },
      { id: "bd-13", dependencies: [] },
    ]);
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-landing-failed");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) =>
        current === undefined
          ? { refuse: "no intent" }
          : {
              ...current,
              orderingGates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" }],
            },
    });
    childProcess.bdFailure = (args) =>
      args[0] === "gate" && args[1] === "resolve" ? "bd: database is locked" : undefined;

    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    mkdirSync(memberDir, { recursive: true });
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    const queue = createFleetMergeQueue(1);
    writeFleetMergeQueue({
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

    await vi.advanceTimersByTimeAsync(2_000);

    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    // The merge happened, so the land is recorded: a transient bd failure must not
    // leave a merged member looking unlanded (that would hold its capacity slot and
    // stall its dependents on an event that already happened).
    expect(
      loaded.intent?.run?.members?.find((member) => member.taskId === "bd-12")?.landedAt,
    ).toEqual(expect.any(Number));
    // No stop for bd-12: the gate resolve is retried from the record, not escalated
    // to a human-relevant failure (bd-12 has already merged and cannot be undone).
    expect((loaded.intent?.run?.stopped ?? []).filter((entry) => entry.taskId === "bd-12")).toEqual(
      [],
    );
    expect(loaded.intent?.orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" },
    ]);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "could not resolve its ordering gate(s)",
    );
    const failedAttempts = bdCalls((args) => args[0] === "gate" && args[1] === "resolve");
    expect(failedAttempts.length).toBeGreaterThan(0);

    // bd recovers: the next tick resolves the still-recorded gate and drops it —
    // from the record only, because the merge already happened and a second merge
    // of the same member must be impossible.
    childProcess.bdFailure = undefined;
    await vi.advanceTimersByTimeAsync(20_000);

    const healed = intent();
    expect(healed).toHaveProperty("ok", true);
    if (!healed.ok) return;
    const resolvedCalls = bdCalls((args) => args[0] === "gate" && args[1] === "resolve");
    expect(resolvedCalls.length).toBeGreaterThan(failedAttempts.length);
    expect(healed.intent?.orderingGates).toBeUndefined();
    const afterQueue = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId: "default" });
    expect(afterQueue).toHaveProperty("ok", true);
    if (!afterQueue.ok) return;
    // Still the single merge attempt from before the failure: nothing re-ran it.
    expect(afterQueue.queue?.entries?.[0]?.attempts).toBe(1);
  });

  it("reaps a gate whose bead a human closed", async () => {
    // A complete answer reaps only the closed bead: bd-12 -> bd-13 goes
    // (bd-13 is closed), bd-12 -> bd-14 stays (both beads are still open).
    stubBd(
      [
        { id: "bd-12", dependencies: [] },
        { id: "bd-13", dependencies: [] },
        { id: "bd-14", dependencies: [] },
      ],
      {
        "bd-13": "closed",
      },
    );
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-reap-closed");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13 bd-14", ctx);

    updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) =>
        current === undefined
          ? { refuse: "no intent" }
          : {
              ...current,
              orderingGates: [
                { blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" },
                { blocker: "bd-12", blocked: "bd-14", gateId: "bd-901" },
              ],
            },
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([
      ["gate", "resolve", "bd-900"],
    ]);
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-14", gateId: "bd-901" },
    ]);
  });

  it("reaps a gate whose member was removed", async () => {
    stubBd([{ id: "bd-12", dependencies: [] }]);
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-reap-removed");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    // A member pruned by reconcile leaves its gate record behind (resolving it
    // there would need bd); the tick is what must notice and finish the job.
    updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) =>
        current === undefined
          ? { refuse: "no intent" }
          : {
              ...current,
              taskIds: [],
              orderingGates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" }],
            },
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([
      ["gate", "resolve", "bd-900"],
    ]);
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.orderingGates).toBeUndefined();
  });

  /**
   * An open ordering gate as bd renders it in `bd gate list <bead> --json`.
   *
   * The marker shape has to be exact: classification is fail-closed, so a record
   * that merely starts with the prefix stays a human gate.
   */
  function markerGate(input: {
    id: string;
    fleetId?: string;
    blocker: string;
    blocked: string;
  }): Record<string, unknown> {
    const marker =
      `belayd-fleet-ordering: fleet:${input.fleetId ?? "default"} ` +
      `${input.blocker} -> ${input.blocked}`;
    return {
      id: input.id,
      status: "open",
      await_type: "human",
      title: marker,
      description: `Ad-hoc gate blocking ${input.blocked}\n\nReason: ${marker}`,
    };
  }

  it("reaps one dependent of a shared blocker without forgetting the other's gate", async () => {
    // C1 regression. bd-12 blocks bd-13 (whose bead the human closed) and bd-14
    // (still live). Resolving bd-12->bd-13 says nothing about bd-12->bd-14, so the
    // bookkeeping must be per gate id: dropping records by member would forget the
    // live dependent's gate while its bd gate stayed open, and nothing could ever
    // resolve it again.
    stubBd(
      [
        { id: "bd-12", dependencies: [] },
        { id: "bd-13", dependencies: [] },
        { id: "bd-14", dependencies: [] },
      ],
      { "bd-13": "closed" },
    );
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-shared-blocker");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13 bd-14", ctx);

    updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) =>
        current === undefined
          ? { refuse: "no intent" }
          : {
              ...current,
              orderingGates: [
                { blocker: "bd-12", blocked: "bd-13", gateId: "bd-901" },
                { blocker: "bd-12", blocked: "bd-14", gateId: "bd-902" },
              ],
            },
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([
      ["gate", "resolve", "bd-901"],
    ]);
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-14", gateId: "bd-902" },
    ]);
  });

  it("reaps nothing when bd's bead payload shape is unrecognized", async () => {
    // C3 regression: a successful read that parses to no records is ambiguous, not
    // "every bead is gone". Mass-resolving on it would release dependents whose
    // blockers have not landed.
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate") return gateAnswer(args);
      if (args[0] === "show") {
        if (args.includes("--brief-deps")) {
          return JSON.stringify([
            { id: "bd-12", dependencies: [] },
            { id: "bd-13", dependencies: [] },
          ]);
        }
        // bd wrapping (or renaming) its records: readable as JSON, not as beads.
        return JSON.stringify({ data: { beads: [] } });
      }
      return undefined;
    };
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-drifted-payload");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) =>
        current === undefined
          ? { refuse: "no intent" }
          : {
              ...current,
              orderingGates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-901" }],
            },
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([]);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "could not read the beads behind its ordering gates",
    );
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-13", gateId: "bd-901" },
    ]);
  });

  it("adopts the gate bd already has instead of creating a duplicate on relaunch", async () => {
    // W4: a crash between `bd gate create` and the intent write leaves a real gate
    // with no record. A relaunch must find it in bd, not mint a second one (the
    // first would then block the dependent forever with no record to resolve it).
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate" && args[1] === "list") {
        return JSON.stringify([markerGate({ id: "bd-950", blocker: "bd-12", blocked: "bd-13" })]);
      }
      if (args[0] === "gate") return gateAnswer(args);
      if (args[0] === "show") {
        if (args.includes("--brief-deps")) {
          return JSON.stringify([
            {
              id: "bd-13",
              dependencies: [{ id: "bd-12", dependency_type: "blocks", status: "open" }],
            },
            { id: "bd-12", dependencies: [] },
          ]);
        }
        const ids = args.slice(1).filter((arg) => !arg.startsWith("-"));
        return JSON.stringify(ids.map((id) => ({ id, status: "open" })));
      }
      return undefined;
    };
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-relaunch-adopt");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    await command.handler("bd-12 bd-13", ctx);

    expect(bdCalls((args) => args[0] === "gate" && args[1] === "create")).toEqual([]);
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-13", gateId: "bd-950" },
    ]);
  });

  it("reaps an unrecorded gate whose blocker is gone (crash-window sweep)", async () => {
    // W1: a gate can exist in bd with no record naming it. The tick asks bd
    // directly, one member bead per tick, and resolves only gates whose blocker
    // already landed or left — a dependent waiting on a live blocker stays blocked.
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate" && args[1] === "list") {
        // bd-19 is not (or no longer) a member: the gate is an orphan.
        return JSON.stringify([markerGate({ id: "bd-960", blocker: "bd-19", blocked: "bd-12" })]);
      }
      if (args[0] === "gate") return gateAnswer(args);
      if (args[0] === "show") {
        if (args.includes("--brief-deps")) {
          return JSON.stringify([
            { id: "bd-12", dependencies: [] },
            { id: "bd-13", dependencies: [] },
          ]);
        }
        const ids = args.slice(1).filter((arg) => !arg.startsWith("-"));
        return JSON.stringify(ids.map((id) => ({ id, status: "open" })));
      }
      return undefined;
    };
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-crash-window");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    await vi.advanceTimersByTimeAsync(1);

    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([
      ["gate", "resolve", "bd-960"],
    ]);
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    // It was never recorded, and the sweep does not invent a record for it.
    expect(loaded.intent?.orderingGates).toBeUndefined();
  });

  it("adopts an unrecorded gate whose blocker is still working instead of releasing it", async () => {
    // W2: a crash-window gate whose blocker has not landed must NOT be resolved
    // (that would release its dependent early). The fleet adopts it: the record is
    // written, the gate stays open, and the blocker's landing resolves it like any
    // other ordering gate.
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate" && args[1] === "list") {
        return JSON.stringify([markerGate({ id: "bd-961", blocker: "bd-13", blocked: "bd-12" })]);
      }
      if (args[0] === "gate") return gateAnswer(args);
      if (args[0] === "show") {
        if (args.includes("--brief-deps")) {
          return JSON.stringify([
            { id: "bd-12", dependencies: [] },
            { id: "bd-13", dependencies: [] },
          ]);
        }
        const ids = args.slice(1).filter((arg) => !arg.startsWith("-"));
        return JSON.stringify(ids.map((id) => ({ id, status: "open" })));
      }
      return undefined;
    };
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-crash-adopt");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    await vi.advanceTimersByTimeAsync(1);

    // Left open: bd-13 is still working, so bd-12's bead stays blocked.
    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([]);
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.orderingGates).toEqual([
      { blocker: "bd-13", blocked: "bd-12", gateId: "bd-961" },
    ]);
  });

  it("names the adopted gate ids when the intent write loses its race twice", async () => {
    // S2: a CAS failure leaves the adopted gate open in bd with no record in
    // `fleet.json`. The operator must still learn which ids to resolve by hand;
    // without them the only recovery is `bd gate list` on every member.
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate" && args[1] === "list") {
        return JSON.stringify([markerGate({ id: "bd-961", blocker: "bd-13", blocked: "bd-12" })]);
      }
      if (args[0] === "gate") return gateAnswer(args);
      if (args[0] === "show") {
        if (args.includes("--brief-deps")) {
          return JSON.stringify([
            { id: "bd-12", dependencies: [] },
            { id: "bd-13", dependencies: [] },
          ]);
        }
        const ids = args.slice(1).filter((arg) => !arg.startsWith("-"));
        return JSON.stringify(ids.map((id) => ({ id, status: "open" })));
      }
      return undefined;
    };
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-crash-cas");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    // Two attempts, both lost: `mutateFleetIntent` gives up and the adoption is lost.
    intentCas.conflictsRemaining = 2;
    await vi.advanceTimersByTimeAsync(1);

    const report = ctxNotifications.map((entry) => entry.message).join("\n");
    expect(report).toContain("changed twice");
    expect(report).toContain("bd-961");
  });

  it("adopts one gate of an edge and resolves its duplicate in the same sweep", async () => {
    // Two crash-window gates for one edge: adopting both would record one id and
    // leave the other open with nothing able to resolve it later.
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate" && args[1] === "list") {
        return JSON.stringify([
          markerGate({ id: "bd-962", blocker: "bd-13", blocked: "bd-12" }),
          markerGate({ id: "bd-963", blocker: "bd-13", blocked: "bd-12" }),
        ]);
      }
      if (args[0] === "gate") return gateAnswer(args);
      if (args[0] === "show") {
        if (args.includes("--brief-deps")) {
          return JSON.stringify([
            { id: "bd-12", dependencies: [] },
            { id: "bd-13", dependencies: [] },
          ]);
        }
        const ids = args.slice(1).filter((arg) => !arg.startsWith("-"));
        return JSON.stringify(ids.map((id) => ({ id, status: "open" })));
      }
      return undefined;
    };
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-crash-duplicate");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    await vi.advanceTimersByTimeAsync(1);

    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([
      ["gate", "resolve", "bd-963"],
    ]);
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.orderingGates).toEqual([
      { blocker: "bd-13", blocked: "bd-12", gateId: "bd-962" },
    ]);
  });

  it("warns once per drifted gate across consecutive ticks", async () => {
    // W1: the tick sweep asks one bead per tick and rotates, so a gate bd reports
    // with a truncated reason is rediscovered on every rotation. The warning must be
    // shown once per gate per run, not on every pass, or a one-member fleet gets a
    // notification storm every 15 s.
    const drifted = (input: { id: string; blocker: string; blocked: string }): unknown => ({
      id: input.id,
      status: "open",
      await_type: "human",
      title: `belayd-fleet-ordering: fleet:default ${input.blocker} -> ${input.blocked}`,
      // bd truncated the reason: the title still classifies, the marker in the
      // reason no longer parses.
      description: "Reason: belayd-fleet-ordering: fleet:default bd-",
    });
    const gatesByBead: Record<string, readonly unknown[]> = {
      "bd-12": [drifted({ id: "bd-960", blocker: "bd-13", blocked: "bd-12" })],
      "bd-13": [drifted({ id: "bd-961", blocker: "bd-12", blocked: "bd-13" })],
    };
    const members = [
      { id: "bd-12", dependencies: [] },
      { id: "bd-13", dependencies: [] },
    ];
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate" && args[1] === "list") {
        const gates = gatesByBead[args[2] ?? ""];
        return gates === undefined ? "null" : JSON.stringify(gates);
      }
      return answerBd(args, members, {});
    };
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-drift-once");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    // Several ticks: the rotation sweeps bd-12, then bd-13, then bd-12 again.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const driftLines = ctxNotifications
      .map((entry) => entry.message)
      .filter((message) => message.includes("classified from the title"));
    expect(driftLines.filter((message) => message.includes("bd-960"))).toHaveLength(1);
    expect(driftLines.filter((message) => message.includes("bd-961"))).toHaveLength(1);

    // The ledger rides on the run record, so a supervisor restart does not re-warn.
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    // At least three ticks: the rotation swept bd-12 twice, so the second pass is
    // what proves the gate was not re-warned.
    expect(loaded.intent?.run?.ticks).toBeGreaterThanOrEqual(3);
    expect(loaded.intent?.run?.gateNoticeIds).toEqual(["bd-960", "bd-961"]);
  });

  it("reaps nothing when bd answers for only some of the gated beads", async () => {
    // W3: a partial answer is ambiguous. Treating the missing record as "that bead
    // is gone" would mass-resolve gates whose blockers have not landed.
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate") return gateAnswer(args);
      if (args[0] === "show") {
        if (args.includes("--brief-deps")) {
          return JSON.stringify([
            { id: "bd-12", dependencies: [] },
            { id: "bd-13", dependencies: [] },
          ]);
        }
        // bd-13 is silently dropped from the answer; only bd-12 comes back.
        return JSON.stringify([{ id: "bd-12", status: "closed" }]);
      }
      return undefined;
    };
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-partial-answer");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) =>
        current === undefined
          ? { refuse: "no intent" }
          : {
              ...current,
              orderingGates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-901" }],
            },
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([]);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "no record for 1 of 2 bead(s)",
    );
    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-13", gateId: "bd-901" },
    ]);
  });

  /**
   * The record a launch leaves before its blocker lands: bd-12 is a live member
   * and bd-13 sits in the persisted deferred plan, waiting on it.
   *
   * `landed` records bd-12's merge — the one fact bd cannot express, because the
   * landing leaves the bead open (bd-158).
   */
  function seedDeferredDependent(options: { landed: boolean }): void {
    const started = startFleetRun({ now: 1, accept: false, members: [{ taskId: "bd-12" }] });
    const run = options.landed
      ? recordRunMemberLanded({ run: started, taskId: "bd-12", now: 2 })
      : started;
    const written = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) =>
        current === undefined
          ? { refuse: "no intent" }
          : {
              ...current,
              deferred: [
                {
                  taskId: "bd-13",
                  reason: "dependency",
                  detail: "wave 1: waits for bd-12 to land",
                },
              ],
              run,
            },
    });
    expect(written).toHaveProperty("ok", true);
  }

  it("advances a dependent whose blocker landed, though bd still reports the edge and the bead open", async () => {
    // The seam bd-158 turns on (extensions/index.ts fleetLandedTaskIds): bd keeps
    // reporting `bd-13 blocked by bd-12` and `bd-12 in_progress`, because landing
    // never closes a bead. The release can only come from the landing recorded in
    // fleet.json, and the dependent must be launched, not deferred again.
    stubBd(
      [
        { id: "bd-12", dependencies: [] },
        {
          id: "bd-13",
          dependencies: [{ id: "bd-12", dependency_type: "blocks", status: "in_progress" }],
        },
      ],
      { "bd-12": "in_progress", "bd-13": "in_progress" },
    );
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-landed-seam");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 --manual", ctx);
    seedDeferredDependent({ landed: true });

    const advanced = await mock.tools
      .get("belayd_fleet_advance")
      ?.execute("call-1", {}, undefined, undefined, ctx);
    expect(advanced?.details).toHaveProperty("exitCode", 0);
    const text = textOf(advanced as ToolResult);
    expect(text).toContain("- bd-13: launched");
    expect(text).not.toContain("deferred bd-13");

    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    // The dependent is now a launched member and nothing is left waiting.
    expect(loaded.intent?.taskIds).toEqual(["bd-12", "bd-13"]);
    expect(loaded.intent?.deferred ?? []).toEqual([]);
    expect(existsSync(join(worktree.path, "feat-bd-13"))).toBe(true);
    // The release was ordering, never acceptance: no bead was closed or relabelled.
    expect(bdCalls((args) => args[0] === "close" || args[0] === "label")).toEqual([]);
  });

  it("keeps that dependent deferred as a dependency while its blocker has not landed", async () => {
    // The negative twin: bd reports exactly the same edge and status, and the only
    // difference is the missing `landedAt`. A blocker that is merely in progress
    // must still hold the wave.
    stubBd(
      [
        { id: "bd-12", dependencies: [] },
        {
          id: "bd-13",
          dependencies: [{ id: "bd-12", dependency_type: "blocks", status: "in_progress" }],
        },
      ],
      { "bd-12": "in_progress", "bd-13": "in_progress" },
    );
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-unlanded-seam");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 --manual", ctx);
    seedDeferredDependent({ landed: false });

    const advanced = await mock.tools
      .get("belayd_fleet_advance")
      ?.execute("call-1", {}, undefined, undefined, ctx);
    // A plan that waits is a success, not a failure (W6).
    expect(advanced?.details).toHaveProperty("exitCode", 0);
    const text = textOf(advanced as ToolResult);
    expect(text).toContain("- deferred bd-13 (dependency)");
    expect(text).toContain("waits for bd-12 to land");
    expect(text).not.toContain("bd-13: launched");

    const loaded = intent();
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    // Nothing started: bd-13 is not a member and is still the waiting plan entry.
    expect(loaded.intent?.taskIds).toEqual(["bd-12"]);
    expect(loaded.intent?.deferred).toEqual([
      expect.objectContaining({ taskId: "bd-13", reason: "dependency" }),
    ]);
    expect(existsSync(join(worktree.path, "feat-bd-13"))).toBe(false);
    expect(bdCalls((args) => args[0] === "close" || args[0] === "label")).toEqual([]);
  });

  it("lands a blocker, then advances and lands its dependent, closing neither bead", async () => {
    // bd-158 bullet (a) end to end: blocker-land -> dependent-launch -> both landed,
    // with bd reporting the edge and both beads open for the whole run. The wave
    // advances on the landing, and no path here closes or relabels a bead.
    stubBd(
      [
        { id: "bd-12", dependencies: [] },
        {
          id: "bd-13",
          dependencies: [{ id: "bd-12", dependency_type: "blocks", status: "in_progress" }],
        },
      ],
      { "bd-12": "in_progress", "bd-13": "in_progress" },
    );
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "gate-both-landed");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13", ctx);

    // Launch: bd-12 starts, bd-13 is wave 1, and the edge has its own gate.
    const launched = intent();
    expect(launched).toHaveProperty("ok", true);
    if (!launched.ok) return;
    expect(launched.intent?.taskIds).toEqual(["bd-12"]);
    expect(launched.intent?.deferred).toEqual([
      expect.objectContaining({ taskId: "bd-13", reason: "dependency" }),
    ]);
    expect(launched.intent?.orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-13", gateId: "bd-901" },
    ]);
    const creates = bdCalls((args) => args[0] === "gate" && args[1] === "create");
    expect(creates).toHaveLength(1);
    // The gate blocks the dependent, so bd's own readiness tracks the landing.
    expect(creates[0]).toContain("bd-13");
    // The dependent is not launched before its blocker lands.
    expect(existsSync(join(worktree.path, "feat-bd-13"))).toBe(false);
    expect(bdCalls((args) => args[0] === "close" || args[0] === "label")).toEqual([]);

    // bd-12 finishes and merges. Its bead stays `in_progress` (bd-158).
    const firstDir = join(cwd, "member-bd-12");
    worktree.branchPath = firstDir;
    worktree.branch = "feat/bd-12";
    // Only bd-12 has a worktree so far: bd-13's launch must not find one.
    worktree.byBranch = { "feat/bd-12": firstDir };
    mkdirSync(firstDir, { recursive: true });
    writeMemberState({ cwd: firstDir, completedPhaseNames: ["plan", "implement"] });
    writeMergedQueue(["bd-12"]);

    await vi.advanceTimersByTimeAsync(2_000);

    // The landing resolved the edge's gate...
    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([
      ["gate", "resolve", "bd-901"],
    ]);
    const afterLanding = intent();
    expect(afterLanding).toHaveProperty("ok", true);
    if (!afterLanding.ok) return;
    expect(
      afterLanding.intent?.run?.members?.find((member) => member.taskId === "bd-12"),
    ).toMatchObject({ landedAt: expect.any(Number) });
    // ...and the next tick advanced the wave: bd-13 is launched although bd still
    // reports `bd-12 in_progress` and the blocking edge.
    expect(afterLanding.intent?.taskIds).toEqual(["bd-13"]);
    expect(afterLanding.intent?.deferred ?? []).toEqual([]);
    expect(existsSync(join(worktree.path, "feat-bd-13"))).toBe(true);

    // bd-13 finishes and merges; its own landing releases nothing extra.
    const secondDir = join(worktree.path, "feat-bd-13");
    worktree.branchPath = secondDir;
    worktree.branch = "feat/bd-13";
    worktree.byBranch = { "feat/bd-12": firstDir, "feat/bd-13": secondDir };
    writeMemberState({
      cwd: secondDir,
      completedPhaseNames: ["plan", "implement"],
      taskId: "bd-13",
    });
    writeMergedQueue(["bd-12", "bd-13"]);

    await vi.advanceTimersByTimeAsync(30_000);

    const afterSecondLanding = intent();
    expect(afterSecondLanding).toHaveProperty("ok", true);
    if (!afterSecondLanding.ok) return;
    expect(
      afterSecondLanding.intent?.run?.members?.find((member) => member.taskId === "bd-13"),
    ).toMatchObject({ landedAt: expect.any(Number) });
    // Both are landed members, the run finished, and no gate work happened twice.
    expect(afterSecondLanding.intent?.taskIds).toEqual([]);
    expect(afterSecondLanding.intent?.run?.outcome).toBe("complete");
    expect(bdCalls((args) => args[0] === "gate" && args[1] === "create")).toHaveLength(1);
    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([
      ["gate", "resolve", "bd-901"],
    ]);
    // Neither bead was ever accepted: the human closes on merge, not the fleet.
    expect(bdCalls((args) => args[0] === "close" || args[0] === "label")).toEqual([]);

    // The dependent was launched strictly after the blocker landed.
    const audit = readFileSync(join(commonDir, "belayd", "fleet", "default", "audit.log"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { action: string; taskIds?: readonly string[] });
    const firstIndex = (action: string, taskId: string): number =>
      audit.findIndex(
        (entry) => entry.action === action && entry.taskIds?.includes(taskId) === true,
      );
    expect(firstIndex("fleet-landed", "bd-12")).toBeGreaterThanOrEqual(0);
    expect(firstIndex("member-launch", "bd-13")).toBeGreaterThan(
      firstIndex("fleet-landed", "bd-12"),
    );
  });

  /** Seed the merge queue as the drain leaves it: one entry per landed member. */
  function writeMergedQueue(taskIds: readonly string[]): void {
    const queue = createFleetMergeQueue(1);
    writeFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId: "default",
      queue: {
        ...queue,
        entries: taskIds.map((taskId) => ({
          taskId,
          branch: `feat/${taskId}`,
          requestedAt: 1,
          state: "merged" as const,
          attempts: 1,
          updatedAt: 2,
        })),
      },
    });
  }
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
    worktree.byBranch = undefined;
    git.failWith = undefined;
    worktree.path = join(cwd, "member-worktree");
    worktree.failWith = undefined;
    worktree.branchPath = "";
    worktree.branch = "";
    worktree.byBranch = undefined;
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
