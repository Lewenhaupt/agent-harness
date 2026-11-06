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
import { renderFleetEscalationGateMarker } from "../bead-gates.js";
import { writeFleetLaunchMarker } from "../fleet-state.js";
import { readFleetLaunchMarker } from "../fleet-status.js";
import type { HandoffPacket } from "../handoff.js";
import {
  buildFleetNote,
  COMMENT_EXCERPT_MAX_CHARS,
  createFleetMergeQueue,
  drainNotes,
  enqueueNote,
  FLEET_INTENT_ORDERING_GATES_MAX,
  FLEET_LAND_REPAIR_GRACE_MS,
  FLEET_NOTE_BODY_MAX_LENGTH,
  FLEET_REBASE_DELEGATION_GRACE_MS,
  FLEET_RUN_ACTION_TICK_INTERVAL_MS,
  FLEET_RUN_DETAIL_MAX_LENGTH,
  FLEET_RUN_MAX_IDLE_TICKS,
  FLEET_RUN_TICK_INTERVAL_MS,
  FLEET_SUPERVISOR_HEARTBEAT_STALE_MS,
  fleetEventsDir,
  fleetInboxDir,
  fleetMemberSignature,
  fleetNoteFileName,
  formatFleetRefusal,
  landRepairForMember,
  readFleetIntent,
  readFleetMergeQueue,
  readSupervisorHeartbeat,
  recordRunMemberLanded,
  startFleetRun,
  updateFleetIntent,
  writeFleetMergeQueue,
  writeSupervisorHeartbeat,
} from "../index.js";
import {
  ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS,
  ORCHESTRATOR_CLAIM_STALE_MS,
} from "../orchestrator-claim.js";
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
  /**
   * Branches that exist, for the deleted-worktree proof (bd-233): the real probe
   * shells out to git, and every git call in this file is stubbed to fail.
   */
  existingBranches: undefined as Set<string> | undefined,
  /**
   * Runs inside the spawn, right after the worktree is created.
   *
   * The only seam that observes the launch *while* it runs, which is what the
   * per-member spawn window has to cover (bd-233).
   */
  onSetup: undefined as ((branch: string) => void) | undefined,
}));

/** Force the next N intent writes to lose their CAS race (a two-attempt failure). */
const intentCas = vi.hoisted(() => ({
  conflictsRemaining: 0,
  /**
   * Runs once before the next real intent update.
   *
   * The only seam between a readoption scan and its compare-and-swap: a test uses it
   * to rewrite the record the way another session's arming would, which is exactly
   * the race the adoption CAS has to refuse (bd-169).
   */
  beforeUpdate: undefined as (() => void) | undefined,
}));

/**
 * Member orchestrators the stubbed process scan reports as running (bd-166).
 *
 * Capacity now counts liveness, so a test that needs a member to hold a slot must
 * say the member is running: the real scan would see nothing and correctly free the
 * slot.
 */
const liveness = vi.hoisted(() => ({ memberTaskIds: [] as string[] }));

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return {
    ...actual,
    scanProcesses: () => ({
      ok: true as const,
      processes: liveness.memberTaskIds.map((taskId, index) => ({
        pid: 4200 + index,
        argv: ["pi", `belayd-${taskId}`],
      })),
    }),
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
      worktree.onSetup?.(options.branch);
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
    // A surviving branch is the proof a deleted worktree leaves behind (bd-233).
    branchExists: (_cwd: string, branch: string) => worktree.existingBranches?.has(branch) === true,
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
      const hook = intentCas.beforeUpdate;
      intentCas.beforeUpdate = undefined;
      hook?.();
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
  /**
   * Answers for one git call, so a test can drive a real merge drain (bd-280).
   *
   * The file-wide default is "empty stdout, success", which no drain can get past
   * its preconditions with; a test states only the probes it asserts on. `failWith`
   * makes that one command fail, which is how a rebase conflict is simulated
   * without a repository.
   */
  gitAnswer: undefined as
    | ((input: {
        args: readonly string[];
        cwd: string;
      }) => { stdout?: string; failWith?: string } | undefined)
    | undefined,
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
      (file: string, args: readonly string[], rawOptions: unknown, callback: unknown) => {
        const done = callback as (error: Error | null, stdout: string, stderr: string) => void;
        const record = { file, args: [...args], stdin: "" };
        childProcess.execFileCalls.push(record);
        const bdFailure = file === "bd" ? childProcess.bdFailure?.(args) : undefined;
        const gitAnswer = gitAnswerFor(file, args, rawOptions);
        // A stubbed git failure settles right away: the fleet merge runner never
        // closes stdin, so waiting for it (as the bd path below does) would leave
        // the call pending forever.
        if (gitAnswer?.failWith !== undefined) {
          done(new Error(gitAnswer.failWith), gitAnswer.stdout ?? "", "");
          return { stdin: { on: () => {}, end: () => {} } };
        }
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
          done(null, (file === "bd" ? childProcess.bdStdout?.(args) : gitAnswer?.stdout) ?? "", "");
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

/** A stubbed merge-drain git answer (`undefined` keeps the empty default). */
type DrainGitAnswer = { stdout?: string; failWith?: string } | undefined;

interface DrainGitProbe {
  matches: (args: readonly string[], cwd: string) => boolean;
  answer: (args: readonly string[], cwd: string) => DrainGitAnswer;
}

/**
 * The git probes a real merge drain issues, as a rule table (bd-280).
 *
 * Each probe is its own matcher so the stub stays readable, and every unlisted
 * argv keeps the file-wide "empty stdout, success" default: a test states only the
 * facts it asserts on. The rebase fails, the base carries a commit that predates the
 * fleet, and the base's side of the conflicted path is old — the pre-existing-base-
 * work shape a live member is asked to resolve itself (`delegable`).
 */
function drainGitProbes(options: {
  commonDir: string;
  memberDir: string;
  onRebase: () => void;
  /** Conflicted paths the stopped rebase reports (default: one source path). */
  conflictedPaths?: readonly string[];
  /** Make the branch-containment probe fail instead of answering. */
  branchProbeFails?: boolean;
  /**
   * Committer date (epoch seconds) of the base side of the conflict.
   *
   * The default `2` is 1970: older than any armed fleet, which is what makes the
   * conflict `delegable` (base work predates this fleet). A recent value makes it a
   * `contradiction` — base work committed after the fleet started (bd-277's
   * "a real conflict" case).
   */
  baseCommitAt?: number;
}): readonly DrainGitProbe[] {
  const headSha = "a".repeat(40);
  const memberBaseSha = "b".repeat(40);
  const conflictedPaths = options.conflictedPaths ?? ["conflict.txt"];
  const isRevParse = (args: readonly string[], ...flags: string[]): boolean =>
    args[0] === "rev-parse" && flags.every((flag) => args.includes(flag));
  return [
    {
      matches: (args) => isRevParse(args, "--absolute-git-dir"),
      answer: () => ({ stdout: `${options.commonDir}\n` }),
    },
    {
      matches: (args) => isRevParse(args, "--path-format=absolute"),
      answer: () => ({ stdout: `${options.commonDir}\n` }),
    },
    {
      matches: (args) => isRevParse(args, "--abbrev-ref"),
      answer: (_args, cwd) => ({ stdout: cwd === options.memberDir ? "feat/bd-12\n" : "main\n" }),
    },
    {
      matches: (args) => args[0] === "worktree" && args[1] === "list",
      answer: (_args, cwd) => ({
        stdout:
          `worktree ${cwd}\0HEAD ${headSha}\0branch refs/heads/main\0\0` +
          `worktree ${options.memberDir}\0HEAD ${headSha}\0branch refs/heads/feat/bd-12\0\0`,
      }),
    },
    {
      // The guard asks about `main^{commit}` and `feat/bd-12^{commit}`: the base is
      // one commit and the member's branch is another, which the `merge-base`
      // answer reports as *not based* until the member rebases.
      matches: (args) => isRevParse(args, "--verify"),
      answer: (args) => ({
        stdout: `${args.includes("main^{commit}") ? headSha : memberBaseSha}\n`,
      }),
    },
    {
      matches: (args) => args[0] === "merge-base",
      answer: () =>
        options.branchProbeFails === true
          ? { failWith: "fatal: not a git repository" }
          : { stdout: `${memberBaseSha}\n` },
    },
    {
      // Before the plain `status` rule: this is the stopped rebase's conflicted path,
      // which is only readable before anything aborts it.
      matches: (args) => args.includes("status") && args.includes("-z"),
      answer: () => ({
        stdout: `${conflictedPaths.map((path) => `UU ${path}`).join("\0")}\0`,
      }),
    },
    { matches: (args) => args[0] === "status", answer: () => ({ stdout: "" }) },
    {
      // Committer dates come in seconds, so `2` is 1970: older than any armed fleet.
      matches: (args) => args[0] === "-c" && args[2] === "log",
      answer: () => ({ stdout: `${"c".repeat(40)} ${options.baseCommitAt ?? 2}\n` }),
    },
    {
      matches: (args, cwd) =>
        args[0] === "rebase" && args[1] === "main" && cwd === options.memberDir,
      answer: () => {
        options.onRebase();
        return { failWith: "CONFLICT (content): Merge conflict in conflict.txt" };
      },
    },
  ];
}

/** Bind {@link drainGitProbes} to the child-process mock, counting rebase attempts. */
function stubDrainGit(options: {
  commonDir: string;
  memberDir: string;
  conflictedPaths?: readonly string[];
  branchProbeFails?: boolean;
  baseCommitAt?: number;
}): {
  rebaseAttempts: () => number;
} {
  let rebaseAttempts = 0;
  const probes = drainGitProbes({
    ...options,
    onRebase: () => {
      rebaseAttempts += 1;
    },
  });
  childProcess.gitAnswer = ({ args, cwd }) =>
    probes.find((probe) => probe.matches(args, cwd))?.answer(args, cwd);
  return { rebaseAttempts: () => rebaseAttempts };
}

/**
 * Answer the git probes a merge drain issues up to a *publish refusal* (bd-277).
 *
 * Every precondition passes — the root is the repository's own checkout on `main`, the
 * member worktree is clean and on its own branch — and the payload diff carries proof
 * artifacts, so the drain refuses with `proof-artifacts-in-diff` before it mutates
 * anything. `head` is the member branch tip the repair round reads back.
 */
function stubRefusingPayloadGit(options: {
  commonDir: string;
  memberDir: string;
  head: string;
  changedPaths?: readonly string[];
  /** `git status --porcelain` output in the member worktree (default: clean). */
  statusOutput?: string;
}): {
  drains: () => number;
  /** Move the member branch: a repair is only proven by this tip changing. */
  setHead: (head: string) => void;
  /**
   * Make the member-branch tip probe fail.
   *
   * `rev-parse --verify feat/bd-12^{commit}` is the probe the repair hold and the ask
   * both read; every other `--verify` the drain issues keeps answering, so a test can
   * make exactly the tip unreadable.
   */
  setHeadProbeFails: (fails: boolean) => void;
} {
  const baseSha = "b".repeat(40);
  const changedPaths = options.changedPaths ?? ["docs/proof/run.png"];
  const branchProbe = "feat/bd-12^{commit}";
  let head = options.head;
  let headProbeFails = false;
  let drains = 0;
  const isRevParse = (args: readonly string[], ...flags: string[]): boolean =>
    args[0] === "rev-parse" && flags.every((flag) => args.includes(flag));
  const probes: readonly DrainGitProbe[] = [
    {
      matches: (args) => isRevParse(args, "--absolute-git-dir"),
      answer: () => ({ stdout: `${options.commonDir}\n` }),
    },
    {
      matches: (args) => isRevParse(args, "--path-format=absolute"),
      answer: () => ({ stdout: `${options.commonDir}\n` }),
    },
    {
      matches: (args) => isRevParse(args, "--abbrev-ref"),
      answer: (_args, cwd) => ({ stdout: cwd === options.memberDir ? "feat/bd-12\n" : "main\n" }),
    },
    {
      matches: (args) => args[0] === "worktree" && args[1] === "list",
      answer: (_args, cwd) => ({
        stdout:
          `worktree ${cwd}\0HEAD ${baseSha}\0branch refs/heads/main\0\0` +
          `worktree ${options.memberDir}\0HEAD ${head}\0branch refs/heads/feat/bd-12\0\0`,
      }),
    },
    {
      // The base and the member branch resolve to different shas: the repair round's
      // own `rev-parse` of the member branch is the same probe as the drain's.
      matches: (args) => isRevParse(args, "--verify"),
      answer: (args) => {
        if (headProbeFails && args.includes(branchProbe)) {
          return { failWith: `fatal: ambiguous argument '${branchProbe}'` };
        }
        return {
          stdout: `${args.some((arg) => String(arg).startsWith("main")) ? baseSha : head}\n`,
        };
      },
    },
    {
      matches: (args) => args[0] === "status",
      answer: () => ({ stdout: options.statusOutput ?? "" }),
    },
    {
      matches: (args) => args[0] === "-c" && args[2] === "diff",
      answer: () => {
        drains += 1;
        return { stdout: `${changedPaths.join("\0")}\0` };
      },
    },
  ];
  childProcess.gitAnswer = ({ args, cwd }) =>
    probes.find((probe) => probe.matches(args, cwd))?.answer(args, cwd);
  return {
    drains: () => drains,
    setHead: (next) => {
      head = next;
    },
    setHeadProbeFails: (fails) => {
      headProbeFails = fails;
    },
  };
}

/** The stubbed answer for one git call, or undefined for the empty default. */
function gitAnswerFor(
  file: string,
  args: readonly string[],
  rawOptions: unknown,
): { stdout?: string; failWith?: string } | undefined {
  if (file !== "git") return undefined;
  const cwd = (rawOptions as { cwd?: string } | undefined)?.cwd ?? "";
  return childProcess.gitAnswer?.({ args, cwd });
}

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

/** The `session_start` handler this extension registers (bd-169 restart cases). */
type SessionStartHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, PiCommand>;
  agentStart: AgentStartHandler[];
  agentEnd: AgentStartHandler[];
  toolCall: ToolCallHandler[];
  sessionStart: SessionStartHandler[];
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
  const sessionStart: SessionStartHandler[] = [];
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
      if (event === "session_start") sessionStart.push(handler as SessionStartHandler);
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
    sessionStart,
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

/**
 * Reset the process-global seams every case in this file shares (bd-173).
 *
 * The hoisted mock state and the extension module's session-state map both live
 * for the whole file, while these suites reuse session ids
 * (`supervisor-session`, `operator-session`, …) and a few of them stub the same
 * seams ad hoc. Without this reset a leftover entry acts on the next test's
 * world: a `pendingFleetEventAcks` acks the previous test's deleted paths, an
 * armed `fleetArm`/scheduled tick keeps a run loop alive, a leaked `bd …
 * resolve` argv fails a "no resolve happened" assertion, and a leaked `bd show`
 * stub rewrites the scheduler's wave order. Each of those only surfaces when a
 * case order lines the leak up with the case that reads it, which is why a
 * shuffled run finds them and the default order does not.
 *
 * Only defaults are restored here; a suite's own `beforeEach` still sets the
 * fixtures its cases need.
 */
async function resetProcessGlobalState(): Promise<void> {
  // The typing stub and the recorded argv both belong to one case.
  childProcess.execFileCalls = [];
  childProcess.bdStdout = undefined;
  childProcess.bdFailure = undefined;
  childProcess.gitAnswer = undefined;
  // Stop a leaked run loop before dropping its session: the loop closes over the
  // state object, so the store's dispose hook is what clears its timer.
  const mod = await import("../../extensions/index.js");
  mod.getSessionState.clear();
}

beforeEach(resetProcessGlobalState);

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
 * The reset the other suites rely on is only half the store: `clear()` drops the
 * entries, the composer's dispose hook is what stops a session's scheduled fleet
 * tick. Pin the wiring — a regression there still leaves every seed-order suite
 * below green while a leaked loop keeps ticking the reused session id.
 */
describe("session state reset (bd-173)", () => {
  it("stops a cleared session's scheduled fleet tick", async () => {
    const mod = await import("../../extensions/index.js");
    const dir = mkdtempSync(join(tmpdir(), "belayd-bd173-clear-"));
    // Imported before the clock is faked: the composer does not schedule anything
    // at import time today, but a shuffled order may run this case first.
    vi.useFakeTimers();
    try {
      const control = makeCtx(dir, "clear-control-session");
      const controlTick = vi.fn();
      mod.getSessionState(control).fleetRunTimer = setTimeout(() => {
        controlTick();
      }, FLEET_RUN_TICK_INTERVAL_MS);
      vi.advanceTimersByTime(FLEET_RUN_TICK_INTERVAL_MS);
      // Control: a scheduled tick does fire, so the assertion below can fail.
      expect(controlTick).toHaveBeenCalledTimes(1);

      const leaked = makeCtx(dir, "clear-leaked-session");
      const leakedTick = vi.fn();
      mod.getSessionState(leaked).fleetRunTimer = setTimeout(() => {
        leakedTick();
      }, FLEET_RUN_TICK_INTERVAL_MS);

      mod.getSessionState.clear();
      vi.advanceTimersByTime(FLEET_RUN_TICK_INTERVAL_MS * 3);

      expect(leakedTick).not.toHaveBeenCalled();
      expect(mod.getSessionState.peek("clear-leaked-session")).toBeUndefined();
      expect(mod.getSessionState.peek("clear-control-session")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a cleared session's orchestrator-lease heartbeat (bd-189 W2)", async () => {
    const mod = await import("../../extensions/index.js");
    const dir = mkdtempSync(join(tmpdir(), "belayd-bd189-lease-clear-"));
    vi.useFakeTimers();
    try {
      // Control: a lease heartbeat interval really does fire, so the assertion
      // below can fail rather than passing on an interval that never ran.
      const control = makeCtx(dir, "lease-clear-control");
      const controlBeat = vi.fn();
      mod.getSessionState(control).orchestratorLeaseTimer = setInterval(
        () => controlBeat(),
        ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS,
      );
      vi.advanceTimersByTime(ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS);
      expect(controlBeat).toHaveBeenCalledTimes(1);

      const leaked = makeCtx(dir, "lease-clear-leaked");
      const leakedBeat = vi.fn();
      mod.getSessionState(leaked).orchestratorLeaseTimer = setInterval(
        () => leakedBeat(),
        ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS,
      );

      mod.getSessionState.clear();
      vi.advanceTimersByTime(ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS * 3);

      // No heartbeat write/`bd` call after dispose: the interval was cleared.
      expect(leakedBeat).not.toHaveBeenCalled();
      // Isolation for the next case: a fresh session starts from a clean slate
      // and its own heartbeat fires exactly once per interval.
      const next = makeCtx(dir, "lease-clear-next");
      const nextBeat = vi.fn();
      const nextState = mod.getSessionState(next);
      expect(nextState.orchestratorLeaseTimer).toBeUndefined();
      nextState.orchestratorLeaseTimer = setInterval(
        () => nextBeat(),
        ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS,
      );
      vi.advanceTimersByTime(ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS);
      expect(nextBeat).toHaveBeenCalledTimes(1);
      mod.getSessionState.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});

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
    worktree.existingBranches = undefined;
    worktree.onSetup = undefined;
    mkdirSync(worktree.path, { recursive: true });
    daemon.calls = [];
    daemon.failWith = undefined;
    childProcess.failBdComment = false;
    ctxNotifications = [];
    afterLaunchHook = undefined;
    intentCas.conflictsRemaining = 0;
  });

  afterEach(() => {
    // The process-scan stub is global to the file, so a test's live members must not
    // leak into the next one (bd-166).
    liveness.memberTaskIds = [];
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
    // member is waiting: the advance has nothing it can start. The members must be
    // reported live for their slots to count (bd-166 counts liveness, not records).
    liveness.memberTaskIds = ["bd-12", "bd-15"];
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

  describe("mid-spawn capacity (bd-166)", () => {
    function bareMemberWorktree(taskId: string): string {
      const path = join(worktree.path, `feat-${taskId}`);
      mkdirSync(path, { recursive: true });
      worktree.byBranch = { [`feat/${taskId}`]: path };
      return path;
    }

    it("counts a bare spawn worktree against the ceiling, not as absent", async () => {
      // The launch writes the intent before `awaitWorktreeReady`, so the worktree can
      // exist for up to a minute with no lease and no workflow state. That is a spawn
      // in flight: a concurrent launch must not take its slot.
      bareMemberWorktree("bd-12");
      writeIntent({ taskIds: ["bd-12"], supervisor: { sessionId: "dead-session", pid: 999_999 } });
      const mock = await loadFleetExtension();
      const tool = mock.tools.get("belayd_fleet_launch");
      if (tool === undefined) throw new Error("belayd_fleet_launch was not registered");

      const result = await tool.execute(
        "launch-1",
        { tasks: "bd-13 bd-14", concurrency: 1 },
        undefined,
        undefined,
        makeCtx(cwd, "launcher-session"),
      );

      const text = textOf(result);
      expect(text).not.toContain("member(s) launched");
      expect(text).toContain("capacity 1, 1 already active, 0 free slot(s)");
      expect(text).toContain("deferred bd-13 (capacity)");
    });

    it("frees the slot of a member with workflow state but no orchestrator", async () => {
      // The hand-merged-bead case the bead is about: the worktree and state are
      // real, the session is gone, so the slot must come back.
      const path = bareMemberWorktree("bd-12");
      writeWorkflowState({
        cwd: path,
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
      writeIntent({ taskIds: ["bd-12"], supervisor: { sessionId: "dead-session", pid: 999_999 } });
      const mock = await loadFleetExtension();
      const tool = mock.tools.get("belayd_fleet_launch");
      if (tool === undefined) throw new Error("belayd_fleet_launch was not registered");

      const result = await tool.execute(
        "launch-1",
        { tasks: "bd-13", concurrency: 1 },
        undefined,
        undefined,
        makeCtx(cwd, "launcher-session"),
      );

      expect(textOf(result)).toContain("1/1 new member(s) launched");
    });
    it("frees the slot of a completed member whose state file was cleared (bd-166)", async () => {
      // `clearWorkflowState` deletes `.belayd/workflow.json` when a workflow finishes,
      // so a completed member leaves a bare-looking worktree plus its run manifests.
      // Without the manifest evidence the capacity count called it `unknown` (a spawn
      // in flight) and the finished member held a slot forever.
      const path = bareMemberWorktree("bd-12");
      const manifest = writeRunManifest({
        cwd: path,
        manifest: {
          schemaVersion: 1,
          runId: "finished-commit",
          taskId: "bd-12",
          phase: "commit",
          sessionName: "belayd-bd-12-sub-commit",
          status: RunStatus.Completed,
          // This execution wrote it, so it postdates the worktree it lives in. The
          // margin absorbs a sub-millisecond birthtime on the directory.
          startedAt: Date.now() + 1_000,
          completedAt: Date.now() + 1_000,
        },
      });
      expect(manifest).toHaveProperty("ok", true);
      writeIntent({ taskIds: ["bd-12"], supervisor: { sessionId: "dead-session", pid: 999_999 } });
      const mock = await loadFleetExtension();
      const tool = mock.tools.get("belayd_fleet_launch");
      if (tool === undefined) throw new Error("belayd_fleet_launch was not registered");

      const result = await tool.execute(
        "launch-1",
        { tasks: "bd-13", concurrency: 1 },
        undefined,
        undefined,
        makeCtx(cwd, "launcher-session"),
      );

      expect(textOf(result)).toContain("1/1 new member(s) launched");
    });

    it("does not free a slot for a re-launched bead whose earlier manifest was copied in (bd-166)", async () => {
      // `.belayd/` is gitignored and `wt step copy-ignored` copies it into a new
      // worktree, so a re-launched bd-12 inherits its *own* earlier run from the
      // primary checkout. That manifest names the task but predates this tree, so it
      // cannot be evidence that the spawn in flight already ran.
      const path = bareMemberWorktree("bd-12");
      const inherited = writeRunManifest({
        cwd: path,
        manifest: {
          schemaVersion: 1,
          runId: "inherited-commit",
          taskId: "bd-12",
          phase: "commit",
          sessionName: "belayd-bd-12-sub-commit",
          status: RunStatus.Completed,
          startedAt: 1,
          completedAt: 2,
        },
      });
      expect(inherited).toHaveProperty("ok", true);
      writeIntent({ taskIds: ["bd-12"], supervisor: { sessionId: "dead-session", pid: 999_999 } });
      const mock = await loadFleetExtension();
      const tool = mock.tools.get("belayd_fleet_launch");
      if (tool === undefined) throw new Error("belayd_fleet_launch was not registered");

      const deferred = await tool.execute(
        "launch-1",
        { tasks: "bd-13", concurrency: 1 },
        undefined,
        undefined,
        makeCtx(cwd, "launcher-session"),
      );
      expect(textOf(deferred)).not.toContain("member(s) launched");
      expect(textOf(deferred)).toContain("deferred bd-13 (capacity)");

      // Once this execution writes its own run, the member really did run here and
      // its slot comes back on the next launch.
      const own = writeRunManifest({
        cwd: path,
        manifest: {
          schemaVersion: 1,
          runId: "own-commit",
          taskId: "bd-12",
          phase: "commit",
          sessionName: "belayd-bd-12-sub-commit",
          status: RunStatus.Completed,
          startedAt: Date.now() + 1_000,
          completedAt: Date.now() + 1_000,
        },
      });
      expect(own).toHaveProperty("ok", true);

      const launched = await tool.execute(
        "launch-2",
        { tasks: "bd-13", concurrency: 1 },
        undefined,
        undefined,
        makeCtx(cwd, "launcher-session"),
      );
      expect(textOf(launched)).toContain("1/1 member(s) launched");
      expect(textOf(launched)).toContain("0 already active, 1 free slot(s)");
    });

    it("still counts a bare worktree holding only another bead's manifest (bd-166)", async () => {
      // bd-161: `.belayd/` is copied into a new worktree, so another bead's completed
      // run is there before this member ever starts. Inherited evidence must not free
      // the slot of an orchestrator that is still being spawned.
      const path = bareMemberWorktree("bd-12");
      const inherited = writeRunManifest({
        cwd: path,
        manifest: {
          schemaVersion: 1,
          runId: "bd37-commit",
          taskId: "bd-37",
          phase: "commit",
          sessionName: "belayd-bd-37-sub-commit",
          status: RunStatus.Completed,
          startedAt: 1,
          completedAt: 2,
        },
      });
      expect(inherited).toHaveProperty("ok", true);
      writeIntent({ taskIds: ["bd-12"], supervisor: { sessionId: "dead-session", pid: 999_999 } });
      const mock = await loadFleetExtension();
      const tool = mock.tools.get("belayd_fleet_launch");
      if (tool === undefined) throw new Error("belayd_fleet_launch was not registered");

      const result = await tool.execute(
        "launch-1",
        { tasks: "bd-13", concurrency: 1 },
        undefined,
        undefined,
        makeCtx(cwd, "launcher-session"),
      );

      const text = textOf(result);
      expect(text).not.toContain("member(s) launched");
      expect(text).toContain("deferred bd-13 (capacity)");
    });
  });
  describe("release (bd-166)", () => {
    /** Every audit line for one action, with the ids it named. */
    function auditEntries(action: string): Array<{ taskIds: readonly string[] }> {
      const path = join(commonDir, "belayd", "fleet", "default", "audit.log");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { action: string; taskIds?: string[] })
        .filter((entry) => entry.action === action)
        .map((entry) => ({ taskIds: entry.taskIds ?? [] }));
    }

    it("gives a member's slot back while keeping it a member", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);

      const tool = mock.tools.get("belayd_fleet_release");
      if (tool === undefined) throw new Error("belayd_fleet_release was not registered");
      const released = await tool.execute(
        "release-1",
        { taskId: "bd-12" },
        undefined,
        undefined,
        ctx,
      );
      expect(released.details).toHaveProperty("exitCode", 0);
      expect(textOf(released as ToolResult)).toContain("released bd-12's capacity slot");

      const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(intent).toHaveProperty("ok", true);
      if (!intent.ok) return;
      // The member stays: only the capacity slot is given back.
      expect(intent.intent?.taskIds).toEqual(["bd-12", "bd-15"]);
      expect(intent.intent?.released).toEqual([
        expect.objectContaining({ taskId: "bd-12", reason: "operator-release" }),
      ]);
      const audit = auditEntries("member-released");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.taskIds).toEqual(["bd-12"]);

      // Idempotent: a second release is a successful no-op.
      const again = await tool.execute("release-2", { taskId: "bd-12" }, undefined, undefined, ctx);
      expect(again.details).toHaveProperty("exitCode", 0);
      expect(textOf(again as ToolResult)).toContain("already released");
      const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(after).toHaveProperty("ok", true);
      if (!after.ok) return;
      expect(after.intent?.released).toHaveLength(1);
      expect(auditEntries("member-released")).toHaveLength(1);
    });

    it("refuses an id that is not a member of this fleet", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);

      const tool = mock.tools.get("belayd_fleet_release");
      if (tool === undefined) throw new Error("belayd_fleet_release was not registered");
      const refused = await tool.execute(
        "release-1",
        { taskId: "bd-99" },
        undefined,
        undefined,
        ctx,
      );
      expect(refused.details).toHaveProperty("exitCode", 1);
      expect(textOf(refused as ToolResult)).toContain("not a member");
    });

    it("refuses to release a member whose orchestrator is live", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      liveness.memberTaskIds = ["bd-12"];

      const tool = mock.tools.get("belayd_fleet_release");
      if (tool === undefined) throw new Error("belayd_fleet_release was not registered");
      const refused = await tool.execute(
        "release-1",
        { taskId: "bd-12" },
        undefined,
        undefined,
        ctx,
      );
      expect(refused.details).toHaveProperty("exitCode", 1);
      expect(textOf(refused as ToolResult)).toContain("orchestrator is live");
      const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(intent).toHaveProperty("ok", true);
      if (!intent.ok) return;
      expect(intent.intent?.released).toBeUndefined();
    });
  });

  describe("cross-fleet reconcile (bd-166)", () => {
    /** A second fleet whose own supervisor is long gone. */
    function writeDeadFleet(): void {
      mkdirSync(join(commonDir, "belayd", "fleet", "wave1"), { recursive: true });
      writeFileSync(
        join(commonDir, "belayd", "fleet", "wave1", "fleet.json"),
        JSON.stringify({
          schemaVersion: 1,
          fleetId: "wave1",
          taskIds: ["bd-31"],
          createdAt: 1,
          updatedAt: 1,
          supervisor: { sessionId: "dead-wave1-session", pid: 2_147_483_646 },
        }),
      );
    }

    it("AC1: recovers a sole provably dead fleet without naming it", async () => {
      // The operator shape the incident needed: one fleet in the repository, its
      // supervisor's pid gone, and a session that supervises nothing. Naming the fleet is
      // optional when it is the only one and provably dead (bd-233).
      const mock = await loadFleetExtension();
      writeIntent({
        taskIds: ["bd-12"],
        supervisor: { sessionId: "dead-default-session", pid: 2_147_483_646 },
      });

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const recovered = await tool.execute(
        "reconcile-1",
        {},
        undefined,
        undefined,
        makeCtx(cwd, "unarmed-session"),
      );
      expect(recovered.details).toHaveProperty("exitCode", 0);
      // Repair authority only: the record keeps its own (dead) supervisor.
      const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(intent).toHaveProperty("ok", true);
      if (!intent.ok) return;
      expect(intent.intent?.supervisor?.sessionId).toBe("dead-default-session");
    });

    it("refuses an unnamed target when more than one fleet exists, naming the escape hatch", async () => {
      // Ambiguity is not evidence of death: with two fleets the tool must not guess which
      // one the operator meant, and the refusal has to name how to say it.
      const mock = await loadFleetExtension();
      writeIntent({
        taskIds: ["bd-12"],
        supervisor: { sessionId: "dead-default-session", pid: 2_147_483_646 },
      });
      writeDeadFleet();

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const refused = await tool.execute(
        "reconcile-1",
        {},
        undefined,
        undefined,
        makeCtx(cwd, "unarmed-session"),
      );
      expect(refused.details).toHaveProperty("exitCode", 1);
      const text = textOf(refused as ToolResult);
      expect(text).toContain("supervisor-only");
      expect(text).toContain('belayd_fleet_reconcile {"fleetId":"<id>"}');
      expect(text).toContain("wave1");
    });

    it("repairs a named fleet's queue/park and audits the target", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      writeDeadFleet();
      // Give the dead fleet something to repair, so recovery authority is exercised with
      // a real repair and the S1 audit fires.
      writeFleetMergeQueue({
        gitCommonDir: commonDir,
        fleetId: "wave1",
        queue: {
          ...createFleetMergeQueue(1),
          lock: {
            holder: "dead-wave1-session",
            taskId: "bd-31",
            pid: 2_147_483_646,
            acquiredAt: 1,
            leaseExpiresAt: 9_999_999_999_999,
          },
        },
      });

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-1",
        { fleetId: "wave1" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details).toHaveProperty("exitCode", 0);
      expect(textOf(result as ToolResult)).toContain("Fleet `wave1` reconcile");

      const auditPath = join(commonDir, "belayd", "fleet", "wave1", "audit.log");
      expect(existsSync(auditPath)).toBe(true);
      const entries = readFileSync(auditPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { action: string; detail?: string });
      // bd-233: the stronger signal wins — a fleet whose supervisor is provably dead
      // is audited as a recovery, even when this session also supervises a fleet here.
      // S1: only because this pass actually repaired something.
      const recovery = entries.find((entry) => entry.action === "reconcile-recovery");
      expect(recovery?.detail).toContain("pid-dead");
      expect(recovery?.detail).toContain("repair(s)");
      // Repair does not touch the record: pruning another fleet needs its own
      // supervisor (bd-166).
      const repaired = readFleetIntent({ gitCommonDir: commonDir, fleetId: "wave1" });
      expect(repaired).toHaveProperty("ok", true);
      if (!repaired.ok) return;
      expect(repaired.intent?.taskIds).toEqual(["bd-31"]);
    });

    it("S1: a no-op recovery repair leaves no recovery claim in the target's audit log", async () => {
      const mock = await loadFleetExtension();
      writeDeadFleet();

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-1",
        { fleetId: "wave1" },
        undefined,
        undefined,
        makeCtx(cwd, "unarmed-session"),
      );
      expect(result.details).toHaveProperty("exitCode", 0);
      const auditPath = join(commonDir, "belayd", "fleet", "wave1", "audit.log");
      const actions = existsSync(auditPath)
        ? readFileSync(auditPath, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => (JSON.parse(line) as { action: string }).action)
        : [];
      expect(actions).not.toContain("reconcile-recovery");
    });

    it("AC1: prunes a provably dead fleet from a session that supervises another one", async () => {
      // bd-233: this used to be refused ("only allowed on this session's own fleet"),
      // which left a dead supervisor's phantom members holding capacity forever. The
      // refusal protects a *live* fleet's capacity decision; here nobody is live.
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      writeDeadFleet();
      worktree.existingBranches = new Set(["feat/bd-31"]);

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const pruned = await tool.execute(
        "reconcile-1",
        { fleetId: "wave1", pruneDeadMembers: true },
        undefined,
        undefined,
        ctx,
      );
      expect(pruned.details).toHaveProperty("exitCode", 0);
      const emptied = readFleetIntent({ gitCommonDir: commonDir, fleetId: "wave1" });
      expect(emptied).toHaveProperty("ok", true);
      if (!emptied.ok) return;
      expect(emptied.intent?.taskIds).toEqual([]);
      const auditPath = join(commonDir, "belayd", "fleet", "wave1", "audit.log");
      const actions = existsSync(auditPath)
        ? readFileSync(auditPath, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => (JSON.parse(line) as { action: string }).action)
        : [];
      expect(actions).toContain("member-pruned-dead");
      expect(actions).toContain("reconcile-recovery");
    });

    it("still refuses a cross-fleet prune while the target's supervisor is live", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      writeDeadFleet();
      writeFileSync(
        join(commonDir, "belayd", "fleet", "wave1", "fleet.json"),
        JSON.stringify({
          schemaVersion: 1,
          fleetId: "wave1",
          taskIds: ["bd-31"],
          createdAt: 1,
          updatedAt: 1,
          supervisor: { sessionId: "live-wave1-session", pid: process.pid },
        }),
      );

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const refused = await tool.execute(
        "reconcile-1",
        { fleetId: "wave1", pruneDeadMembers: true },
        undefined,
        undefined,
        ctx,
      );
      expect(refused.details).toHaveProperty("exitCode", 1);
      expect(textOf(refused as ToolResult)).toContain("only allowed on this session's own fleet");
      const untouched = readFleetIntent({ gitCommonDir: commonDir, fleetId: "wave1" });
      expect(untouched).toHaveProperty("ok", true);
      if (!untouched.ok) return;
      expect(untouched.intent?.taskIds).toEqual(["bd-31"]);
    });

    it("releases a dead foreign fleet's member through the audited recovery path (bd-168)", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      writeDeadFleet();

      const tool = mock.tools.get("belayd_fleet_release");
      if (tool === undefined) throw new Error("belayd_fleet_release was not registered");
      const released = await tool.execute(
        "release-1",
        { taskId: "bd-31", fleetId: "wave1" },
        undefined,
        undefined,
        ctx,
      );
      expect(released.details).toHaveProperty("exitCode", 0);
      expect(textOf(released as ToolResult)).toContain("released bd-31's capacity slot");

      const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "wave1" });
      expect(intent).toHaveProperty("ok", true);
      if (!intent.ok) return;
      expect(intent.intent?.released).toEqual([
        expect.objectContaining({ taskId: "bd-31", reason: "operator-release" }),
      ]);
      const auditPath = join(commonDir, "belayd", "fleet", "wave1", "audit.log");
      const actions = existsSync(auditPath)
        ? readFileSync(auditPath, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => (JSON.parse(line) as { action: string }).action)
        : [];
      expect(actions).toContain("member-released-recovery");
      expect(actions).not.toContain("member-released");
    });

    it("refuses to release a foreign fleet's member while its supervisor is live", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      writeDeadFleet();
      writeFileSync(
        join(commonDir, "belayd", "fleet", "wave1", "fleet.json"),
        JSON.stringify({
          schemaVersion: 1,
          fleetId: "wave1",
          taskIds: ["bd-31"],
          createdAt: 1,
          updatedAt: 1,
          supervisor: { sessionId: "live-wave1-session", pid: process.pid },
        }),
      );

      const tool = mock.tools.get("belayd_fleet_release");
      if (tool === undefined) throw new Error("belayd_fleet_release was not registered");
      const refused = await tool.execute(
        "release-1",
        { taskId: "bd-31", fleetId: "wave1" },
        undefined,
        undefined,
        ctx,
      );
      expect(refused.details).toHaveProperty("exitCode", 1);
      expect(textOf(refused as ToolResult)).toContain("supervisor is not provably dead");
      const untouched = readFleetIntent({ gitCommonDir: commonDir, fleetId: "wave1" });
      expect(untouched).toHaveProperty("ok", true);
      if (!untouched.ok) return;
      expect(untouched.intent?.released).toBeUndefined();
    });

    it("CRITICAL/W1: prunes a member with a deleted worktree on a ticking run", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      // The production shape: a run that is ticking right now, members launched long ago,
      // and their worktrees deleted. `intent.updatedAt` is rewritten by every tick, so the
      // spawn window must not be keyed on it (review round 2, Critical).
      worktree.existingBranches = new Set(["feat/bd-12", "feat/bd-15"]);
      const launchedAt = Date.now() - 3_600_000;
      const ticking = updateFleetIntent({
        gitCommonDir: commonDir,
        fleetId: "default",
        update: (current) =>
          current === undefined
            ? { refuse: "no intent" }
            : {
                ...current,
                updatedAt: Date.now(),
                run: {
                  schemaVersion: 1,
                  mode: "until-complete",
                  startedAt: launchedAt,
                  updatedAt: Date.now(),
                  ticks: 240,
                  members: [
                    { taskId: "bd-12", launchedAt },
                    { taskId: "bd-15", launchedAt },
                  ],
                },
              },
      });
      expect(ticking).toHaveProperty("ok", true);

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-1",
        { fleetId: "default", pruneDeadMembers: true },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details).toHaveProperty("exitCode", 0);

      const pruned = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(pruned).toHaveProperty("ok", true);
      if (!pruned.ok) return;
      expect(pruned.intent?.taskIds).toEqual([]);
      const auditPath = join(commonDir, "belayd", "fleet", "default", "audit.log");
      const actions = existsSync(auditPath)
        ? readFileSync(auditPath, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => (JSON.parse(line) as { action: string }).action)
        : [];
      // Naming the session's own fleet is not a cross-fleet operation.
      expect(actions).not.toContain("reconcile-cross-fleet");
    });

    it("W1: prunes a member whose listed worktree directory was deleted", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      // `git worktree list` still reports the worktree, but `rm -rf` removed the
      // directory: the listing is proof it existed, not proof it is there now. No
      // ageing: the spawn window is this member's marker, and there is none.
      worktree.byBranch = { "feat/bd-12": join(cwd, "vanished-member-bd-12") };

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-1",
        { fleetId: "default", pruneDeadMembers: true },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details).toHaveProperty("exitCode", 0);
      const pruned = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(pruned).toHaveProperty("ok", true);
      if (!pruned.ok) return;
      // bd-12 is absent (listing + deleted dir). bd-15 has neither a worktree nor a
      // branch, so it stays unknown and counted.
      expect(pruned.intent?.taskIds).toEqual(["bd-15"]);
    });

    it("W1: prunes a landed member whose clean landing removed the worktree and branch (bd-168)", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      const launchedAt = Date.now() - 3_600_000;
      const recorded = updateFleetIntent({
        gitCommonDir: commonDir,
        fleetId: "default",
        update: (current) =>
          current === undefined
            ? { refuse: "no intent" }
            : {
                ...current,
                taskIds: ["bd-12"],
                run: {
                  schemaVersion: 1,
                  mode: "until-complete",
                  startedAt: launchedAt,
                  updatedAt: Date.now(),
                  ticks: 12,
                  members: [{ taskId: "bd-12", launchedAt, landedAt: launchedAt + 60_000 }],
                },
              },
      });
      expect(recorded).toHaveProperty("ok", true);
      // A clean landing deleted both the worktree and the branch, so nothing on disk
      // proves the tree existed; the run's own landedAt record is the positive
      // evidence that must make it prunable (bd-168 #1).
      worktree.existingBranches = new Set();
      worktree.byBranch = {};

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-1",
        { fleetId: "default", pruneDeadMembers: true },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details).toHaveProperty("exitCode", 0);
      const text = textOf(result as ToolResult);
      expect(text).not.toContain("no proof one ever existed");
      const pruned = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(pruned).toHaveProperty("ok", true);
      if (!pruned.ok) return;
      expect(pruned.intent?.taskIds).toEqual([]);
    });

    it("W1/W2: a listed worktree on disk and a live spawn marker are both unknown", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      const memberDir = join(cwd, "bare-member-bd-12");
      mkdirSync(memberDir, { recursive: true });
      worktree.byBranch = { "feat/bd-12": memberDir };

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-1",
        { fleetId: "default", pruneDeadMembers: true },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details).toHaveProperty("exitCode", 0);
      const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(after).toHaveProperty("ok", true);
      if (!after.ok) return;
      expect(after.intent?.taskIds).toEqual(["bd-12", "bd-15"]);
    });

    it("W2/b: a member whose spawn marker is live is kept unknown and not pruned", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      worktree.existingBranches = new Set(["feat/bd-12", "feat/bd-15"]);
      // A relaunch of bd-12 is in flight right now; bd-15 has no marker.
      writeFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId: "default",
        taskId: "bd-12",
        owner: "test-spawn",
        now: Date.now(),
      });

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-1",
        { fleetId: "default", pruneDeadMembers: true },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details).toHaveProperty("exitCode", 0);
      const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(after).toHaveProperty("ok", true);
      if (!after.ok) return;
      // bd-12's own marker holds its slot; bd-15 (same fleet, same record) is pruned.
      expect(after.intent?.taskIds).toEqual(["bd-12"]);
    });

    it("AC2/W2: a launch writes the member's spawn marker for exactly as long as it spawns", async () => {
      // The marker is the only thing that keeps a member whose worktree is still being
      // created out of the `absent` verdict, so the launch path must own it: created
      // before the worktree exists, gone once the spawn returns (bd-233).
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      const inside: Array<{ taskId: string; marker: boolean }> = [];
      worktree.onSetup = (branch) => {
        const taskId = branch.replace(/^feat\//, "");
        inside.push({
          taskId,
          marker:
            readFleetLaunchMarker({
              gitCommonDir: commonDir,
              fleetId: "default",
              taskId,
            }) !== undefined,
        });
      };

      await arm(mock, ctx);

      expect(inside.map((entry) => entry.taskId)).toEqual(["bd-12", "bd-15"]);
      expect(inside.every((entry) => entry.marker)).toBe(true);
      for (const entry of inside) {
        expect(
          readFleetLaunchMarker({
            gitCommonDir: commonDir,
            fleetId: "default",
            taskId: entry.taskId,
          }),
        ).toBeUndefined();
      }
    });

    it("W2/d: a failed spawn leaves no launch marker behind", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      worktree.failWith = "wt switch failed";
      await arm(mock, ctx, "bd-12");
      expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain("NOT launched");
      // The marker exists only while the spawn runs; a thrown/failed launch must not
      // leave the member looking in flight forever.
      expect(
        readFleetLaunchMarker({ gitCommonDir: commonDir, fleetId: "default", taskId: "bd-12" }),
      ).toBeUndefined();
    });

    it("AC3: clears a recorded stop through retryMembers and audits it", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      const seeded = updateFleetIntent({
        gitCommonDir: commonDir,
        fleetId: "default",
        update: (current) =>
          current === undefined
            ? { refuse: "no intent" }
            : {
                ...current,
                run: {
                  ...startFleetRun({
                    now: 1,
                    accept: false,
                    members: [{ taskId: "bd-12" }],
                  }),
                  stopped: [
                    {
                      taskId: "bd-12",
                      reason: "orchestrator-missing" as const,
                      detail: "no live orchestrator lease holds the worktree",
                      at: 1,
                    },
                  ],
                },
              },
      });
      expect(seeded).toHaveProperty("ok", true);

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const retried = await tool.execute(
        "reconcile-1",
        { fleetId: "default", retryMembers: ["bd-12"] },
        undefined,
        undefined,
        ctx,
      );
      expect(retried.details).toHaveProperty("exitCode", 0);
      expect(textOf(retried)).toContain("retrying bd-12");
      const auditPath = join(commonDir, "belayd", "fleet", "default", "audit.log");
      const actions = existsSync(auditPath)
        ? readFileSync(auditPath, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => (JSON.parse(line) as { action: string }).action)
        : [];
      expect(actions).toContain("member-retry");
      const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
      expect(after).toHaveProperty("ok", true);
      if (!after.ok) return;
      expect(after.intent?.run?.stopped ?? []).toEqual([]);
    });

    it("warns with bd's own error text when an escalation gate cannot be resolved (bd-279 S2)", async () => {
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      const seeded = updateFleetIntent({
        gitCommonDir: commonDir,
        fleetId: "default",
        update: (current) =>
          current === undefined
            ? { refuse: "no intent" }
            : {
                ...current,
                run: {
                  ...startFleetRun({ now: 1, accept: false, members: [{ taskId: "bd-12" }] }),
                  stopped: [
                    {
                      taskId: "bd-12",
                      reason: "orchestrator-missing" as const,
                      detail: "no live orchestrator lease holds the worktree",
                      at: 1,
                    },
                  ],
                },
              },
      });
      expect(seeded).toHaveProperty("ok", true);

      // A real escalation gate blocks the bead, and resolving it fails with text that
      // does not contain "could not": the notification level must follow the result
      // shape, never the wording of a bd error.
      const marker = "belayd-fleet-escalation: fleet:default bd-12 orchestrator-missing r1";
      childProcess.bdStdout = (args) =>
        args[0] === "gate" && args[1] === "list"
          ? JSON.stringify([
              {
                id: "bd-940",
                status: "open",
                await_type: "human",
                title: marker,
                description: `Reason: ${marker}: needs a human`,
              },
            ])
          : undefined;
      childProcess.bdFailure = (args) =>
        args[0] === "gate" && args[1] === "resolve" ? "bd: lock timeout" : undefined;

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-s2",
        { fleetId: "default", retryMembers: ["bd-12"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details).toHaveProperty("exitCode", 0);

      const warnings = ctxNotifications
        .filter((entry) => entry.level === "warning")
        .map((entry) => entry.message)
        .join("\n");
      expect(warnings).toContain("bd: lock timeout");
    });

    it("resolves the escalation gate a retry orphaned, and audits it (bd-279)", async () => {
      // A retried member's stop (and with it the record the tick keys on) is cleared,
      // so the bead's own gate is the only evidence left. The sweep is by marker, and
      // the resolution is audited as the fleet's action rather than mined from text.
      const mock = await loadFleetExtension();
      const ctx = makeCtx(cwd, "supervisor-session");
      await arm(mock, ctx);
      const seeded = updateFleetIntent({
        gitCommonDir: commonDir,
        fleetId: "default",
        update: (current) =>
          current === undefined
            ? { refuse: "no intent" }
            : {
                ...current,
                run: {
                  ...startFleetRun({ now: 1, accept: false, members: [{ taskId: "bd-12" }] }),
                  stopped: [
                    {
                      taskId: "bd-12",
                      reason: "orchestrator-missing" as const,
                      detail: "no live orchestrator lease holds the worktree",
                      at: 1,
                      gateId: "bd-940",
                    },
                  ],
                },
              },
      });
      expect(seeded).toHaveProperty("ok", true);

      const marker = "belayd-fleet-escalation: fleet:default bd-12 orchestrator-missing r1";
      childProcess.bdStdout = (args) =>
        args[0] === "gate" && args[1] === "list"
          ? JSON.stringify([
              {
                id: "bd-940",
                status: "open",
                await_type: "human",
                title: marker,
                description: `Reason: ${marker}: needs a human`,
              },
            ])
          : undefined;

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-orphan",
        { fleetId: "default", retryMembers: ["bd-12"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details).toHaveProperty("exitCode", 0);

      expect(
        childProcess.execFileCalls
          .filter((call) => call.file === "bd" && call.args[0] === "gate")
          .map((call) => [...call.args]),
      ).toContainEqual(["gate", "resolve", "bd-940"]);
      const auditPath = join(commonDir, "belayd", "fleet", "default", "audit.log");
      const audited = readFileSync(auditPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { action: string; taskIds?: string[]; detail?: string })
        .filter((entry) => entry.action === "escalation-gates-resolved");
      expect(audited).toHaveLength(1);
      expect(audited[0]?.taskIds).toEqual(["bd-12"]);
      expect(audited[0]?.detail).toContain("retried member");
      expect(audited[0]?.detail).toContain("bd-940");
    });

    it("AC1: recovers a named fleet whose supervisor is provably dead from a session that supervises none", async () => {
      // bd-233: this used to be refused ("supervises no fleet in this repository"),
      // which is exactly the deadlock — repair was supervisor-only while the only
      // repair tool for a dead supervisor was itself supervisor-only.
      const mock = await loadFleetExtension();
      writeDeadFleet();

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const recovered = await tool.execute(
        "reconcile-1",
        { fleetId: "wave1" },
        undefined,
        undefined,
        makeCtx(cwd, "unarmed-session"),
      );
      expect(recovered.details).toHaveProperty("exitCode", 0);
      // S1: this pass repaired nothing, so it leaves no recovery claim behind (the
      // dedicated test above asserts that; here the point is the authority itself).
      // Repair authority only: the record still names its own (dead) supervisor.
      const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "wave1" });
      expect(intent).toHaveProperty("ok", true);
      if (!intent.ok) return;
      expect(intent.intent?.supervisor?.sessionId).toBe("dead-wave1-session");
      expect(intent.intent?.taskIds).toEqual(["bd-31"]);
    });

    it("refuses cross-fleet repair from a resumed session whose anchors no longer match", async () => {
      const mock = await loadFleetExtension();
      writeDeadFleet();
      // A *live* target supervisor, so bd-233's recovery arm cannot apply: this case
      // is about inherited authority, not about a provably dead fleet.
      writeFileSync(
        join(commonDir, "belayd", "fleet", "wave1", "fleet.json"),
        JSON.stringify({
          schemaVersion: 1,
          fleetId: "wave1",
          taskIds: ["bd-31"],
          createdAt: 1,
          updatedAt: 1,
          supervisor: { sessionId: "live-wave1-session", pid: process.pid },
        }),
      );
      // The record names this session id, but the process and token are stale: a
      // resumed session must not inherit cross-fleet authority from it.
      writeIntent({
        taskIds: ["bd-12"],
        supervisor: { sessionId: "supervisor-session", pid: 999_999, armToken: "stale-token" },
      });

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const refused = await tool.execute(
        "reconcile-1",
        { fleetId: "wave1" },
        undefined,
        undefined,
        makeCtx(cwd, "supervisor-session"),
      );

      expect(refused.details).toHaveProperty("exitCode", 1);
      expect(textOf(refused)).toContain("supervises no fleet in this repository");
    });

    it("still allows cross-fleet repair from a legacy record with no anchors", async () => {
      const mock = await loadFleetExtension();
      writeDeadFleet();
      // A record written before pidStartTime/armToken existed has only the session id;
      // the documented fallback keeps it repairable.
      writeIntent({
        taskIds: ["bd-12"],
        supervisor: { sessionId: "supervisor-session", pid: 999_999 },
      });

      const tool = mock.tools.get("belayd_fleet_reconcile");
      if (tool === undefined) throw new Error("belayd_fleet_reconcile was not registered");
      const result = await tool.execute(
        "reconcile-1",
        { fleetId: "wave1" },
        undefined,
        undefined,
        makeCtx(cwd, "supervisor-session"),
      );

      expect(result.details).toHaveProperty("exitCode", 0);
    });
  });

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

/**
 * Publish contract at the launch surface (bd-174.1).
 *
 * Every case drives the real `/fleet` command or the real `belayd_fleet_launch`
 * tool against a temp fleet directory, so the resolver, the repo-config reader and
 * the intent write are the real implementations and only spawning is stubbed.
 * That is what makes a refusal observable as files that never appeared: no
 * `fleet.json`, no `audit.log`, no member worktree, no session.
 */
describe("fleet publish config (bd-174.1)", () => {
  let cwd: string;
  let commonDir: string;
  const fleetId = "default";

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-publish-"));
    commonDir = join(cwd, ".git");
    mkdirSync(join(commonDir, "belayd", "fleet", fleetId), { recursive: true });
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
    liveness.memberTaskIds = [];
    ctxNotifications = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
    git.failWith = undefined;
    liveness.memberTaskIds = [];
  });

  function intentNow() {
    const read = readFleetIntent({ gitCommonDir: commonDir, fleetId });
    if (!read.ok) throw new Error(`intent unreadable: ${read.error}`);
    return read.intent;
  }

  function auditActions(): string[] {
    const auditPath = join(commonDir, "belayd", "fleet", fleetId, "audit.log");
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { action: string }).action);
  }

  function notificationText(): string {
    return ctxNotifications.map((entry) => entry.message).join("\n");
  }

  function writeRepoConfig(publish: unknown, root = cwd): void {
    mkdirSync(join(root, ".belayd"), { recursive: true });
    writeFileSync(join(root, ".belayd", "config.json"), JSON.stringify({ publish }));
  }

  /** Everything a launch would leave behind had it got past publish resolution. */
  function expectNothingLaunched(): void {
    expect(intentNow()).toBe(undefined);
    expect(auditActions()).toEqual([]);
    expect(daemon.calls).toEqual([]);
    expect(existsSync(join(worktree.path, "feat-bd-12"))).toBe(false);
  }

  async function runFleet(args: string, sessionId = "publisher-session") {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, sessionId);
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler(args, ctx);
    return { mock, ctx };
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

  it("freezes the inert local contract when nothing configures publishing", async () => {
    const { mock } = await runFleet("bd-12 --manual");

    const intent = intentNow();
    // Local is the default and carries no remote field at all: nothing to publish.
    expect(intent?.publish).toEqual({ mode: "local" });
    // The stub answers no branch, so the documented repository default is frozen
    // rather than left absent for a reader to guess at.
    expect(intent?.baseBranch).toBe("main");
    // The harness's git stub fails every `git config` call, which is deliberately
    // reported as a warning (a real failure must not look like "unset"); no publish
    // *source* warned, so nothing here says the config was unusable.
    expect(
      ctxNotifications.filter((entry) =>
        /config\.json|invalid publish|unknown publish/.test(entry.message),
      ),
    ).toEqual([]);
    // The launch itself is unchanged: same audit trail, one member session.
    expect(auditActions()).toEqual(["schedule-planned", "launch", "member-launch"]);
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);
    expect(await blockReason(mock, "belayd_commit", makeCtx(cwd, "publisher-session"))).toContain(
      "Fleet supervisor sessions do not run phases",
    );
  });

  it("reads the mode from .belayd/config.json when no flag names one", async () => {
    writeRepoConfig({ mode: "pr", remote: "cfg", base: "develop" });

    await runFleet("bd-12 --manual");

    expect(intentNow()?.publish).toEqual({ mode: "pr", remote: "cfg", base: "develop" });
  });

  it("lets --publish beat the repo config per field", async () => {
    writeRepoConfig({ mode: "pr", remote: "cfg" });

    await runFleet("bd-12 --manual --publish push --publish-remote flag-remote");

    // The flag supplies the mode and the remote; the config's own mode loses.
    expect(intentNow()?.publish).toEqual({ mode: "push", remote: "flag-remote" });
  });

  it("warns and ignores an invalid repo config instead of refusing the launch", async () => {
    writeRepoConfig({ mode: "sometimes" });

    await runFleet("bd-12 --manual");

    // A broken repo config degrades to a warning and the inert default, never to a
    // launch refusal: the operator can still start the fleet.
    expect(notificationText()).toContain("invalid publish");
    expect(ctxNotifications.some((entry) => entry.level === "warning")).toBe(true);
    expect(intentNow()?.publish).toEqual({ mode: "local" });
  });

  it("reads the repo config from the main checkout, not the linked worktree", async () => {
    const mainCheckout = join(cwd, "main-checkout");
    const linkedWorktree = join(cwd, "wt-feat-bd-12");
    mkdirSync(linkedWorktree, { recursive: true });
    // `.belayd/config.json` is repo-scoped: gitCommonDir is shared by every
    // worktree, so the main checkout's copy wins and the worktree's is not read.
    writeRepoConfig({ mode: "pr", remote: "main-remote" }, mainCheckout);
    writeRepoConfig({ mode: "push", remote: "worktree-remote" }, linkedWorktree);
    commonDir = join(mainCheckout, ".git");
    mkdirSync(join(commonDir, "belayd", "fleet", fleetId), { recursive: true });
    git.commonDir = commonDir;

    const mock = await loadFleetExtension();
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 --manual", makeCtx(linkedWorktree, "publisher-session"));

    expect(intentNow()?.publish).toEqual({
      mode: "pr",
      remote: "main-remote",
      base: "main",
    });
  });

  it("never re-reads the contract on a re-arm", async () => {
    mkdirSync(join(commonDir, "belayd", "fleet", fleetId), { recursive: true });
    writeFileSync(
      join(commonDir, "belayd", "fleet", fleetId, "fleet.json"),
      JSON.stringify({
        schemaVersion: 2,
        fleetId,
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        baseBranch: "develop",
        publish: { mode: "pr", remote: "origin", base: "develop" },
        supervisor: { sessionId: "dead-session", pid: 999_999 },
      }),
    );
    // Both other sources now disagree with the recorded contract, which is exactly
    // the mid-run edit the freeze exists to survive.
    writeRepoConfig({ mode: "local" });

    await runFleet("bd-12 --manual --publish push --publish-remote other-remote");

    const intent = intentNow();
    expect(intent?.publish).toEqual({ mode: "pr", remote: "origin", base: "develop" });
    expect(intent?.baseBranch).toBe("develop");
    // The re-arm did happen: the record names this session's supervisor now.
    expect(intent?.supervisor).toMatchObject({ sessionId: "publisher-session" });
    expect(auditActions()).toContain("re-arm");
  });

  it("refuses a config contract its mode cannot carry and touches nothing", async () => {
    // `base` belongs to `pr` alone: a push fleet has no base branch to target.
    writeRepoConfig({ mode: "push", base: "develop" });
    const { mock, ctx } = await runFleet("bd-12 --manual");

    const text = notificationText();
    expect(text).toContain('publish: "base" only applies to mode "pr"');
    expect(text).toContain('mode resolved to "push"');
    // The refusal is the only error reported: it happens before scheduling, so no
    // member (and no scheduler warning) got that far.
    const errors = ctxNotifications.filter((entry) => entry.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("only applies to mode");
    expectNothingLaunched();
    // Resolve-before-side-effect ordering: the session was never armed, so its
    // tools still work normally.
    expect(await blockReason(mock, "belayd_commit", ctx)).toBe(undefined);
  });

  it("refuses a flag contract its mode cannot carry from the launch tool", async () => {
    const mock = await loadFleetExtension();
    const launch = mock.tools.get("belayd_fleet_launch");
    if (launch === undefined) throw new Error("belayd_fleet_launch was not registered");

    const result = await launch.execute(
      "launch-publish-1",
      { tasks: ["bd-12"], untilComplete: false, publish: "local", publishRemote: "fork" },
      undefined,
      undefined,
      makeCtx(cwd, "publisher-session"),
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain('publish: "remote" only applies to mode "pr"/"push"');
    expectNothingLaunched();
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
    liveness.memberTaskIds = [];
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
   * Rewrite the recorded repair round's own clock (bd-277).
   *
   * Ticking through thirty minutes of fake time would run a hundred holds; the record
   * owns the clock, so moving its `at` is the same state an old round reaches. The
   * absolute form is what makes the grace boundary assertable at one millisecond: the
   * tick reads `now` when it fires, so `at` is set against the tick that will observe
   * it, never against a wall clock the test does not control.
   */
  function setRepairRoundAt(at: number): void {
    editIntent((current) => {
      const run = current.run as
        | { members?: Array<{ taskId: string; landRepair?: { at: number } }> }
        | undefined;
      if (run?.members === undefined) return current;
      const members = run.members.map((member) =>
        member.landRepair === undefined
          ? member
          : { ...member, landRepair: { ...member.landRepair, at } },
      );
      return { ...current, run: { ...run, members } };
    });
  }

  /** Age the run's recorded repair round by `milliseconds` from now. */
  function ageRepairRound(milliseconds: number): void {
    setRepairRoundAt(Date.now() - milliseconds);
  }

  /**
   * The `now` of the tick that asked for the repair.
   *
   * Read back from the record rather than assumed: the first tick fires when the fake
   * clock advances, so the test cannot know its instant a priori. Asserting on this
   * value is also what makes the grace-boundary arithmetic self-checking.
   */
  function repairRoundAt(): number {
    const read = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    if (!read.ok) throw new Error(`intent unreadable: ${read.error}`);
    const at = read.intent?.run?.members?.[0]?.landRepair?.at;
    if (at === undefined) throw new Error("no repair round was recorded");
    return at;
  }

  /**
   * Arm a one-member run and replace git with the publish-refusal probes (bd-277).
   *
   * The member's worktree is the directory the launch's lease write and the tick's own
   * lease probe both read (`feat-bd-12`), so the repair round's hold observes the same
   * claim production writes.
   */
  async function armRefusedLanding(
    options: { statusOutput?: string; headProbeFails?: boolean } = {},
  ): Promise<{
    drain: {
      drains: () => number;
      setHead: (head: string) => void;
      setHeadProbeFails: (fails: boolean) => void;
    };
    memberDir: string;
  }> {
    const memberDir = join(worktree.path, "feat-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    const drain = stubRefusingPayloadGit({
      commonDir,
      memberDir,
      head: "d".repeat(40),
      ...(options.statusOutput === undefined ? {} : { statusOutput: options.statusOutput }),
    });
    if (options.headProbeFails === true) drain.setHeadProbeFails(true);
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    return { drain, memberDir };
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

  it("opens one described escalation gate for the stop it just recorded, and none on the next tick", async () => {
    // The wiring case: the tick is the only place that sees the run record after
    // every stop writer, so a stop recorded by this very tick must be escalated in the
    // same pass and its gate id persisted with the record (bd-279).
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");

    const creates: string[][] = [];
    let openGates: unknown = null;
    childProcess.bdStdout = (args) => {
      if (args[0] !== "gate") return undefined;
      if (args[1] === "list") return JSON.stringify(openGates);
      if (args[1] === "create") {
        creates.push([...args]);
        return JSON.stringify({ id: "bd-901" });
      }
      return undefined;
    };

    await command.handler("bd-12", ctx);
    await vi.advanceTimersByTimeAsync(121_000);

    const escalationCreates = (): string[][] =>
      creates.filter((argv) => argv.join(" ").includes("belayd-fleet-escalation:"));
    expect(escalationCreates()).toHaveLength(1);
    const create = escalationCreates()[0] ?? [];
    expect(create).toContain("--blocks");
    expect(create).toContain("bd-12");
    expect(create).toContain("--type=human");
    // The gate is described, not a bare "blocked": the reason says what happened and
    // what an answer may be.
    const reason = create[create.indexOf("--reason") + 1] ?? "";
    expect(reason).toContain("orchestrator-missing");
    expect(reason).toContain("retry, abandon, or release");
    const title = create[create.indexOf("--title") + 1] ?? "";
    expect(title).toContain("belayd-fleet-escalation: fleet:default bd-12 orchestrator-missing");

    const opened = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(opened).toHaveProperty("ok", true);
    if (!opened.ok) return;
    expect(opened.intent?.run?.stopped).toEqual([
      expect.objectContaining({ taskId: "bd-12", gateId: "bd-901" }),
    ]);
    expect(auditEntries("escalation-gates-opened").map((entry) => entry.taskIds)).toEqual([
      ["bd-12"],
    ]);

    // The next tick reads the gate it created, so the record and bd agree: nothing is
    // created twice and the recorded id is left alone.
    openGates = [
      { id: "bd-901", status: "open", await_type: "human", title, description: `Reason: ${title}` },
    ];
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);
    expect(escalationCreates()).toHaveLength(1);

    const retick = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(retick).toHaveProperty("ok", true);
    if (!retick.ok) return;
    expect(retick.intent?.run?.stopped).toEqual([
      expect.objectContaining({ taskId: "bd-12", gateId: "bd-901" }),
    ]);
  });

  it("keeps the stop record when bd's gate list fails, creating nothing blind", async () => {
    // A bd outage must not lose the stop or invent a gate: the stop is the durable
    // fact, and a create without the read is exactly the blind write the read-then-write
    // order exists to prevent.
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    childProcess.bdFailure = (args) =>
      args[0] === "gate" && args[1] === "list" ? "bd: database locked" : undefined;

    await command.handler("bd-12", ctx);
    await vi.advanceTimersByTimeAsync(121_000);

    const loaded = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent?.run?.stopped).toEqual([
      expect.objectContaining({ taskId: "bd-12", reason: "orchestrator-missing" }),
    ]);
    expect(loaded.intent?.run?.stopped?.[0]).not.toHaveProperty("gateId");
    expect(
      childProcess.execFileCalls.filter(
        (call) => call.file === "bd" && call.args[0] === "gate" && call.args[1] === "create",
      ),
    ).toEqual([]);
    // The failure is reported as a tick line, so an operator sees why no gate exists.
    const reported = ctxNotifications.map((entry) => entry.message).join("\n");
    expect(reported).toContain(
      "could not open the escalation gate(s) for bd-12 (orchestrator-missing)",
    );
    expect(reported).toContain("the stop record stands");
  });

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
    // bd-166: a stopped member holds its slot only while it is actually running; this
    // test is about the capacity path, so the member is reported live.
    liveness.memberTaskIds = ["bd-12"];

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
    // The tick that gives up must not reset the count that justified it, and the
    // recorded counter is clamped to the cap so the record agrees with the audit line.
    expect(halted.intent?.run?.idleTicks).toBe(FLEET_RUN_MAX_IDLE_TICKS);
    expect(auditEntries("fleet-run-halted")).toHaveLength(1);

    // The timer is stopped: the cap costs one last re-plan (the halt is decided after
    // the advance), and further minutes add neither a plan nor a second halt.
    const plannedBefore = auditEntries("capacity-blocked").length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(auditEntries("capacity-blocked")).toHaveLength(plannedBefore);
    expect(auditEntries("fleet-run-halted")).toHaveLength(1);
  });

  it("does not stall a healthy member whose phase advanced since the last tick (bd-172)", async () => {
    // The observed bug: a single-member wave whose phase takes longer than the cap
    // halted as stalled while the member was working, because only a landing, stop,
    // or launch reset the counter. The tick's own observation is progress.
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    // The member's worktree is running its implement phase, so this tick observes
    // `phase run in flight: implement` where the previous tick saw `starting`.
    const memberPath = join(worktree.path, "feat-bd-12");
    // The probe is stubbed: without this the tick would read the member as missing.
    worktree.branchPath = memberPath;
    const written = writeWorkflowState({
      cwd: memberPath,
      state: {
        schemaVersion: 1,
        taskId: "bd-12",
        workflowType: "feature",
        resolutionSource: "default",
        branch: "feat/bd-12",
        originalCwd: memberPath,
        phaseOrder: ["plan", "implement"],
        completedPhaseNames: [],
        startedAt: 1,
        updatedAt: 1,
      },
    });
    if (!written.ok) throw new Error(`could not write workflow state: ${written.error}`);
    const manifest = writeRunManifest({
      cwd: memberPath,
      manifest: {
        schemaVersion: 1,
        runId: "run-implement",
        taskId: "bd-12",
        phase: "implement",
        sessionName: "belayd-bd-12-implement",
        status: RunStatus.Running,
        startedAt: Date.now(),
      },
    });
    if (!manifest.ok) throw new Error(`could not write run manifest: ${manifest.error}`);

    // Seeded *at* the cap: this is the tick the old accounting halted on, so a plan
    // that reads the record's counter instead of the tick's would give up here. The
    // baseline is the one the previous tick would have stored. Built through the
    // persisted type (not a raw cast): the record is the contract.
    const seeded = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId: "default",
      update: (current) => {
        if (current?.run === undefined) return { refuse: "the run record is missing" };
        return {
          ...current,
          run: {
            ...current.run,
            idleTicks: FLEET_RUN_MAX_IDLE_TICKS,
            memberSignatures: [
              {
                taskId: "bd-12",
                // What production would have stored on the tick that saw the member
                // before its phase run started.
                signature: fleetMemberSignature({
                  kind: "starting",
                  detail: "launched, no phase has started yet",
                }),
              },
            ],
          },
        };
      },
    });
    expect(seeded).toHaveProperty("ok", true);

    await vi.advanceTimersByTimeAsync(1);

    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.haltedReason).toBeUndefined();
    expect(after.intent?.run?.finishedAt).toBeUndefined();
    expect(after.intent?.run?.idleTicks).toBe(0);
    expect(after.intent?.run?.memberSignatures).toEqual([
      { taskId: "bd-12", signature: "running:in-flight:implement" },
    ]);
    expect(auditEntries("fleet-run-halted")).toHaveLength(0);
  });

  it("waits on the member's open bd human gate, never on the review phase flag (bd-219)", async () => {
    // The tick is the only place the gate read lands: `deriveFleetMemberProgress`
    // could be right while the wiring that fills `humanGateOpen` is gone, and then
    // a member on a real gate would read as running (no 12 h cap, no stop). The
    // workflow carries the post-review flag the whole time and never moves the
    // member; only the bead's gate does.
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    const memberPath = join(worktree.path, "feat-bd-12");
    // The probe is stubbed: without this the tick would read the member as missing.
    worktree.branchPath = memberPath;
    const written = writeWorkflowState({
      cwd: memberPath,
      state: {
        schemaVersion: 1,
        taskId: "bd-12",
        workflowType: "feature",
        resolutionSource: "default",
        branch: "feat/bd-12",
        originalCwd: memberPath,
        phaseOrder: ["plan", "implement", "review", "test", "commit"],
        completedPhaseNames: ["plan", "implement", "review"],
        awaitingReviewResponse: true,
        startedAt: 1,
        updatedAt: 1,
      },
    });
    if (!written.ok) throw new Error(`could not write workflow state: ${written.error}`);

    /** bd's `gate list` answer; `null` is its empty-list rendering. */
    const gateListAnswer = (answer: string) => (args: readonly string[]) =>
      args[0] === "gate" && args[1] === "list" ? answer : undefined;
    childProcess.bdStdout = gateListAnswer("null");

    await vi.advanceTimersByTimeAsync(1);
    const openTick = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(openTick).toHaveProperty("ok", true);
    if (!openTick.ok) return;
    // No gate: the post-review flag alone is not a wait, so nothing is stopped.
    expect(openTick.intent?.run?.stopped).toBeUndefined();
    expect(openTick.intent?.run?.memberSignatures?.[0]?.signature).toMatch(/^running:/);

    // The same member, the same flag, now with an open human gate on its bead.
    childProcess.bdStdout = gateListAnswer(
      JSON.stringify([
        { id: "bd-960", status: "open", await_type: "human", created_at: "2026-11-01T10:00:00Z" },
      ]),
    );
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);

    const gatedTick = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(gatedTick).toHaveProperty("ok", true);
    if (!gatedTick.ok) return;
    // The gate read reached the plan as `awaiting-human`, and the tick recorded it
    // in `run.stopped[]` so the 12 h human cap and the halt reason apply to it.
    expect(gatedTick.intent?.run?.stopped).toEqual([
      expect.objectContaining({ taskId: "bd-12", reason: "awaiting-human" }),
    ]);
  });

  it("keeps the capacity wait alive on a tick whose member moved (bd-172)", async () => {
    // The capacity wait halts on its own counter because it only runs with no member
    // in flight, so it must read the same tick value the plan did: a stale record
    // counter here would give up on the very tick a member advanced.
    await stopEveryMemberInRun();
    liveness.memberTaskIds = ["bd-12"];

    // What moves this tick is the stopped member's retry: its implement phase failed
    // where the previous tick's baseline saw the phase run in flight. A failed phase
    // is not "a live retry" (`stoppedMembersRetrying` only credits `starting` and a
    // live-lease `running`), so with every member stopped the tick reaches the
    // capacity-blocked advance instead of the in-flight wait.
    const memberPath = join(worktree.path, "feat-bd-12");
    // Per-branch: only bd-12 has a worktree, so the wave's bd-19 is not mistaken for
    // a second orchestrator in the member's tree.
    worktree.byBranch = { "feat/bd-12": memberPath };
    const written = writeWorkflowState({
      cwd: memberPath,
      state: {
        schemaVersion: 1,
        taskId: "bd-12",
        workflowType: "feature",
        resolutionSource: "default",
        branch: "feat/bd-12",
        originalCwd: memberPath,
        phaseOrder: ["plan", "implement"],
        completedPhaseNames: [],
        startedAt: 1,
        updatedAt: 1,
      },
    });
    if (!written.ok) throw new Error(`could not write workflow state: ${written.error}`);
    const manifest = writeRunManifest({
      cwd: memberPath,
      manifest: {
        schemaVersion: 1,
        runId: "run-implement",
        taskId: "bd-12",
        phase: "implement",
        sessionName: "belayd-bd-12-implement",
        status: RunStatus.Failed,
        failureReason: "gate exited 1",
        startedAt: Date.now(),
      },
    });
    if (!manifest.ok) throw new Error(`could not write run manifest: ${manifest.error}`);

    // One slot, already held by the live bd-12, so the wave is capacity-blocked. The
    // counter is seeded at the cap and the baseline one signature behind (the phase
    // run the failure ended), exactly as a run that reached the cap just before that
    // phase failed would look.
    editIntent((intent) => {
      const run = intent.run as Record<string, unknown>;
      return {
        ...intent,
        maxConcurrent: 1,
        deferred: [{ taskId: "bd-19", reason: "capacity", blockers: [], detail: "no free slot" }],
        run: {
          ...run,
          idleTicks: FLEET_RUN_MAX_IDLE_TICKS,
          memberSignatures: [
            {
              taskId: "bd-12",
              signature: fleetMemberSignature({
                kind: "running",
                detail: "phase run in flight: implement",
                key: "in-flight:implement",
              }),
            },
          ],
        },
      };
    });

    await vi.advanceTimersByTimeAsync(2_000);

    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.haltedReason).toBeUndefined();
    expect(after.intent?.run?.idleTicks).toBe(0);
    expect(auditEntries("capacity-blocked").length).toBeGreaterThan(0);
    expect(auditEntries("fleet-run-halted")).toHaveLength(0);
  });

  it("drops the progress baseline when a pause halts the loop (bd-172 review)", async () => {
    // A paused run is resumable, so its baseline would otherwise be compared across
    // the operator's wall-clock gap. The pause tick must leave no baseline behind.
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    // The first tick establishes the baseline the pause tick must drop.
    await vi.advanceTimersByTimeAsync(1);
    const baselined = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(baselined).toHaveProperty("ok", true);
    if (!baselined.ok) return;
    expect(baselined.intent?.run?.memberSignatures).toHaveLength(1);

    const pause = mock.tools.get("belayd_fleet_pause");
    if (pause === undefined) throw new Error("belayd_fleet_pause was not registered");
    const paused = await pause.execute(
      "pause-1",
      { reason: "stepping away" },
      undefined,
      undefined,
      ctx,
    );
    expect(paused.details).toHaveProperty("exitCode", 0);
    // The ticker stops at its next tick, which is the pause halt.
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS);

    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    // Paused, not halted: the run is still active so a resume can tick it again.
    expect(after.intent?.run?.haltedReason).toBeUndefined();
    expect(after.intent?.run?.finishedAt).toBeUndefined();
    expect(after.intent?.run).not.toHaveProperty("memberSignatures");
  });

  it("halts when the fleet record disappears while an advance is in flight", async () => {
    await stopEveryMemberInRun();
    // Capacity-blocked needs a live holder (bd-166 counts liveness, not records).
    liveness.memberTaskIds = ["bd-12"];

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
    // Publish config is resolved before the launch engine and can notify a
    // warning first; skip those so the hook still fires on the engine's own
    // post-write warning, the window this test is about.
    const deleteAfterLaunchEngine = (): void => {
      const last = ctxNotifications[ctxNotifications.length - 1];
      if (
        last?.message.startsWith("git config ") ||
        last?.message.includes(".belayd/config.json")
      ) {
        afterLaunchHook = deleteAfterLaunchEngine;
        return;
      }
      rmSync(fleetFile, { force: true });
    };
    afterLaunchHook = deleteAfterLaunchEngine;

    await vi.advanceTimersByTimeAsync(2_000);

    expect(existsSync(fleetFile)).toBe(false);
    const lines = ctxNotifications.map((entry) => entry.message).join("\n");
    // The advance's own report is kept as the leading line, then the run stops
    // instead of classifying from the plan the advance just replaced.
    expect(lines).toContain("Scheduling: 0 member(s) now, 1 deferred");
    expect(lines).toContain(
      "run loop stopped — the fleet intent for `default` is gone, so nothing can advance this run",
    );
    // bd-169 review W1: the lost record inside an advance is a lost loop, not a halt,
    // so it is audited and reported like the tick's own re-read — never a silent stop.
    expect(lines).toContain("/fleet bd-12 --fleet default");
    expect(auditEntries("supervisor-intent-lost")).toHaveLength(1);
    expect(ctxNotifications.filter((entry) => entry.message.includes("run loop stopped"))).toEqual([
      expect.objectContaining({ level: "warning" }),
    ]);
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

  /**
   * Seed a live orchestrator lease in a member worktree (bd-280 delegation).
   *
   * Written after the launch: the launch path refuses a worktree that already has a
   * live orchestrator, and the tick's own observation is what the drain reads.
   */
  function seedLiveMemberLease(memberDir: string): void {
    const dir = join(memberDir, ".belayd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "orchestrator.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bd-12",
        branch: "feat/bd-12",
        sessionId: "member-session-id",
        pid: 4242,
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );
  }

  /**
   * Age the lease the *launch* wrote in its worktree, so a repair relaunch may take it.
   *
   * A member whose work is complete has a session that stopped renewing its lease; the
   * real relaunch takes that cold record over. The stubbed launch writes a fresh one
   * (pid = this test process, heartbeat = now), which is indistinguishable from a live
   * orchestrator, so the test ages it instead of pretending the session died.
   */
  function expireMemberSpawnClaim(branch: string): void {
    const path = join(worktree.path, branch.replace(/\//g, "-"), ".belayd", "orchestrator.json");
    if (!existsSync(path)) return;
    const claim = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({ ...claim, heartbeatAt: Date.now() - ORCHESTRATOR_CLAIM_STALE_MS - 1 }),
    );
  }

  /**
   * Answer the git probes a real merge drain issues, and count its rebase attempts.
   *
   * See {@link drainGitProbes} for what the stub states: a failed rebase, base work
   * that predates the fleet, and a member branch that does not contain the base.
   */
  function stubDelegatingDrainGit(
    memberDir: string,
    options: { conflictedPaths?: readonly string[]; branchProbeFails?: boolean } = {},
  ): { rebaseAttempts: () => number } {
    return stubDrainGit({ commonDir, memberDir, ...options });
  }

  it("delegates a resolvable rebase instead of stopping the member (bd-280)", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    const drain = stubDelegatingDrainGit(memberDir);

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    seedLiveMemberLease(memberDir);
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(2_000);

    // The drain classified the conflict as the member's own to resolve and said so
    // in one line naming the member — no `land-failed` stop, no retirement.
    const text = ctxNotifications.map((entry) => entry.message).join("\n");
    expect(text).toContain("asked bd-12 to resolve its own rebase");
    expect(text).not.toContain("could not land bd-12");
    expect(drain.rebaseAttempts()).toBe(1);

    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    // The run is still live and the member is still a member: nothing was stopped.
    expect(after.intent?.run?.stopped ?? []).toEqual([]);
    expect(after.intent?.taskIds).toEqual(["bd-12"]);
    expect(after.intent?.deferred ?? []).toEqual([]);

    // The queue carries the delegation, and exactly one rebase-hint reached it.
    const queue = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId: "default" });
    expect(queue).toHaveProperty("ok", true);
    if (!queue.ok) return;
    expect(queue.queue?.entries[0]).toMatchObject({
      taskId: "bd-12",
      state: "failed",
      delegatedAt: expect.any(Number),
    });
    const notes = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
    if (!notes.ok) throw new Error(notes.error);
    expect(
      notes.deliveries.filter((delivery) => delivery.note.kind === "rebase-hint"),
    ).toHaveLength(1);
  });

  it("records a delegated member's complete conflicted-path list (bd-280 W5)", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    // More paths than the bounded stop text names, so the audit is the only place
    // the operator can still see all of them.
    const conflictedPaths = Array.from({ length: 7 }, (_, index) => `src/conflict-${index + 1}.ts`);
    stubDelegatingDrainGit(memberDir, { conflictedPaths });

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    seedLiveMemberLease(memberDir);
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(2_000);

    // The tick line is bounded but states how many paths there are.
    const text = ctxNotifications.map((entry) => entry.message).join("\n");
    expect(text).toContain("in 7 paths");
    expect(text).toContain("(+2 more)");

    // The durable record carries every path, so acting on the delegation does not
    // depend on reading the bounded line.
    const delegated = auditEntries("fleet-land-delegated");
    expect(delegated).toHaveLength(1);
    expect(delegated[0]?.taskIds).toEqual(["bd-12"]);
    expect(delegated[0]?.detail).toContain("(7 paths)");
    for (const path of conflictedPaths) expect(delegated[0]?.detail).toContain(path);
  });

  it("does not re-drain a delegated member whose branch still lacks the base (bd-280)", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    const drain = stubDelegatingDrainGit(memberDir);

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    seedLiveMemberLease(memberDir);
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drain.rebaseAttempts()).toBe(1);

    // The next tick sees the same finished member and no stop. Draining again would
    // be the same rebase against the same base — the guard makes it a hold, and a
    // hold is not an action, so the loop falls back to the normal tick interval.
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);

    expect(drain.rebaseAttempts()).toBe(1);
    const text = ctxNotifications.map((entry) => entry.message).join("\n");
    expect(text).toContain("waits for that rebase");
    expect(text).not.toContain("could not land bd-12");

    const notes = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
    if (!notes.ok) throw new Error(notes.error);
    expect(
      notes.deliveries.filter((delivery) => delivery.note.kind === "rebase-hint"),
    ).toHaveLength(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.stopped ?? []).toEqual([]);
    expect(after.intent?.taskIds).toEqual(["bd-12"]);
  });

  it("holds a delegated member when the branch probe fails, and still stops at the grace (bd-280 S4)", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    // The probe cannot answer at all (`merge-base` fails): the landing must not fall
    // through to a drain, which would re-send the hint and rewrite `delegatedAt` on
    // every tick and so starve the grace window forever.
    const drain = stubDelegatingDrainGit(memberDir, { branchProbeFails: true });

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    seedLiveMemberLease(memberDir);
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drain.rebaseAttempts()).toBe(1);

    const delegatedAt = () => {
      const queue = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId: "default" });
      if (!queue.ok) throw new Error(queue.error);
      return queue.queue?.entries[0]?.delegatedAt;
    };
    const firstDelegatedAt = delegatedAt();
    expect(firstDelegatedAt).toEqual(expect.any(Number));

    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);

    // Held, not re-drained: one rebase attempt, one hint, the same marker.
    expect(drain.rebaseAttempts()).toBe(1);
    expect(delegatedAt()).toBe(firstDelegatedAt);
    const notes = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
    if (!notes.ok) throw new Error(notes.error);
    expect(
      notes.deliveries.filter((delivery) => delivery.note.kind === "rebase-hint"),
    ).toHaveLength(1);
    const text = ctxNotifications.map((entry) => entry.message).join("\n");
    expect(text).toContain("could not verify");
    expect(text).not.toContain("could not land bd-12");

    // The wait is still bounded: with the probe still failing, the grace expires and
    // the member is stopped for a human instead of looping forever.
    const queue = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId: "default" });
    if (!queue.ok || queue.queue === undefined) throw new Error("queue unreadable");
    const entry = queue.queue.entries[0];
    if (entry === undefined) throw new Error("no queue entry");
    const written = writeFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId: "default",
      queue: {
        ...queue.queue,
        entries: [{ ...entry, delegatedAt: Date.now() - FLEET_REBASE_DELEGATION_GRACE_MS - 1 }],
      },
    });
    expect(written).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);

    expect(drain.rebaseAttempts()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.stopped).toEqual([
      expect.objectContaining({ taskId: "bd-12", reason: "land-failed" }),
    ]);
    expect(after.intent?.run?.stopped?.[0]?.detail).toContain("stopping it for a human");
  });

  it("stops a delegated member whose rebase never arrives (bd-280 grace)", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    const drain = stubDelegatingDrainGit(memberDir);

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    seedLiveMemberLease(memberDir);
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(2_000);

    // Age the delegation past its grace instead of ticking through it: the wait has
    // to end, because a live member that never rebases leaves nobody who can decide.
    const queue = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId: "default" });
    if (!queue.ok || queue.queue === undefined) throw new Error("queue unreadable");
    const entry = queue.queue.entries[0];
    if (entry === undefined) throw new Error("no queue entry");
    const written = writeFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId: "default",
      queue: {
        ...queue.queue,
        entries: [{ ...entry, delegatedAt: Date.now() - FLEET_REBASE_DELEGATION_GRACE_MS - 1 }],
      },
    });
    expect(written).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);

    expect(drain.rebaseAttempts()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.stopped).toEqual([
      expect.objectContaining({ taskId: "bd-12", reason: "land-failed" }),
    ]);
    const stopped = after.intent?.run?.stopped?.[0];
    expect(stopped?.detail).toContain("stopping it for a human");
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "could not land bd-12",
    );
  });

  it("asks a member to repair a repairable refused landing instead of stopping it (bd-277)", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    mkdirSync(memberDir, { recursive: true });
    const head = "d".repeat(40);
    const drain = stubRefusingPayloadGit({ commonDir, memberDir, head });

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    expireMemberSpawnClaim("feat/bd-12");
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    // One tick: the first is scheduled 1 ms after the arm.
    await vi.advanceTimersByTimeAsync(1);

    // AC 1: the refusal was classified by its reason, the member was asked to fix its
    // own diff, and nothing was stopped or retired.
    expect(drain.drains()).toBe(1);
    const text = ctxNotifications.map((entry) => entry.message).join("\n");
    expect(text).toContain("asked bd-12 to repair its refused landing (repair 1 of 1)");
    expect(text).toContain("proof-artifacts-in-diff");
    expect(text).not.toContain("could not land bd-12");

    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.stopped ?? []).toEqual([]);
    expect(after.intent?.taskIds).toEqual(["bd-12"]);
    expect(after.intent?.deferred ?? []).toEqual([]);
    expect(after.intent?.run?.members?.[0]).toMatchObject({
      taskId: "bd-12",
      landRepair: {
        attempts: 1,
        head,
        refusal: expect.stringContaining("proof-artifacts-in-diff"),
      },
    });

    // One launch at /fleet and one repair relaunch through the same spawn path.
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(2);
    const audited = auditEntries("fleet-land-repair");
    expect(audited).toHaveLength(1);
    expect(audited[0]?.taskIds).toEqual(["bd-12"]);
    expect(audited[0]?.detail).toContain("repair 1 of 1");

    // AC 4: membership and capacity are untouched. The member keeps its worktree, bead,
    // session and capacity slot — nothing was released, retired, or closed.
    expect(existsSync(memberDir)).toBe(true);
    expect(after.intent?.released ?? []).toEqual([]);
    expect(after.intent?.run?.members?.[0]?.landedAt).toBe(undefined);
    expect(auditEntries("members-released")).toEqual([]);
    // No bead transition: closing is the landing's job and nothing landed.
    expect(
      childProcess.execFileCalls.filter((call) => call.file === "bd" && call.args[0] === "close"),
    ).toEqual([]);
    expect(
      childProcess.execFileCalls.filter(
        (call) => call.file === "bd" && call.args.includes("--status"),
      ),
    ).toEqual([]);
  });

  it("records the repair relaunch, holds on its fresh claim, then stops on a second refusal (bd-277 W4/S2)", async () => {
    // The production layout: the member's worktree *is* the directory the launch claims
    // and the tick's lease probe reads, so the repair relaunch's fresh `pending:` claim is
    // visible to the next tick. The old fake put them in different directories, which let
    // tick 2 re-drain a route production never takes.
    const memberDir = join(worktree.path, "feat-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    const drain = stubRefusingPayloadGit({ commonDir, memberDir, head: "d".repeat(40) });

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    // Name the pre-repair session explicitly, so "the record was rewritten" is a fact the
    // assertions can see rather than two timestamps that happen to be equal under fake
    // timers.
    editIntent((current) => {
      const run = current.run as { members?: Array<Record<string, unknown>> };
      return {
        ...current,
        run: {
          ...run,
          members: (run.members ?? []).map((member) => ({
            ...member,
            launchedAt: 1,
            sessionId: "dead-session",
          })),
        },
      };
    });
    // The member's pre-repair session is gone, which is why its work is finished but its
    // claim is cold: the repair round takes the worktree over.
    expireMemberSpawnClaim("feat/bd-12");
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(1);

    // W4: the relaunch is recorded as a launch of this member (fresh start-grace clock and
    // the session that now owns the worktree), and it did not reset the attempt or stop
    // anything.
    const relaunched = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(relaunched).toHaveProperty("ok", true);
    if (!relaunched.ok) return;
    const relaunchedMember = relaunched.intent?.run?.members?.[0];
    expect(relaunchedMember).toMatchObject({
      taskId: "bd-12",
      sessionId: "member-session-id",
      landRepair: { attempts: 1 },
    });
    expect(relaunchedMember?.launchedAt).toBeGreaterThan(1);
    expect(relaunched.intent?.run?.stopped ?? []).toEqual([]);
    expect(drain.drains()).toBe(1);

    // The repair session finished its turn without committing: the member reads complete
    // while the fresh claim is live, so the landing is HELD — no drain, no stop, and the
    // tick did not act.
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drain.drains()).toBe(1);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "has not moved yet",
    );
    const held = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(held).toHaveProperty("ok", true);
    if (!held.ok) return;
    expect(held.intent?.run?.stopped ?? []).toEqual([]);

    // The claim decays (that session is gone too) with the tip unchanged: the next tick
    // drains, is refused again, and the spent round stops the member.
    expireMemberSpawnClaim("feat/bd-12");
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);

    expect(drain.drains()).toBe(2);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    // AC 2: the provenance leads, so the bounded record still says which round spent the
    // attempt and still names the refusal.
    expect(stopped[0]?.detail.startsWith("repair 1 of 1 did not clear this")).toBe(true);
    expect(stopped[0]?.detail).toContain("proof-artifacts-in-diff");
    expect(stopped[0]?.detail).toContain("docs/proof/run.png");
    // No third attempt was asked: the relaunch count is still the original plus one.
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(2);
  });

  it("keeps the second-refusal provenance through the 400-char record bound (bd-277 W2)", async () => {
    const memberDir = join(worktree.path, "feat-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    // A refusal carrying a full path list is far longer than the record's 400-character
    // detail bound, which is exactly the case a suffix marker used to lose.
    const changedPaths = Array.from(
      { length: 40 },
      (_, index) => `docs/proof/capture-${String(index).padStart(3, "0")}-screenshot.png`,
    );
    stubRefusingPayloadGit({ commonDir, memberDir, head: "d".repeat(40), changedPaths });

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    expireMemberSpawnClaim("feat/bd-12");
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(1);
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    expireMemberSpawnClaim("feat/bd-12");
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);

    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const detail = after.intent?.run?.stopped?.[0]?.detail ?? "";
    expect(detail.startsWith("repair 1 of 1 did not clear this (proof-artifacts-in-diff) — ")).toBe(
      true,
    );
    expect(detail.length).toBeLessThanOrEqual(FLEET_RUN_DETAIL_MAX_LENGTH);
    expect(detail).toContain("docs/proof/capture-000-screenshot.png");
    // The cut is inside the refusal's own list and at a word boundary: every
    // path-shaped token is either a whole path from the list or the ellipsis marker.
    const tokens = detail.split(" ").filter((token) => token.includes("/"));
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      const cleaned = token.replace(/[,;]$/, "");
      if (cleaned.endsWith("…")) continue;
      expect(changedPaths).toContain(cleaned);
    }
    expect(detail.endsWith("…")).toBe(true);
  });

  it("keeps the ask-failure provenance through the record bound (bd-277 W2)", async () => {
    const memberDir = join(worktree.path, "feat-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    const changedPaths = Array.from(
      { length: 40 },
      (_, index) => `docs/proof/capture-${String(index).padStart(3, "0")}-screenshot.png`,
    );
    stubRefusingPayloadGit({ commonDir, memberDir, head: "d".repeat(40), changedPaths });

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    expireMemberSpawnClaim("feat/bd-12");
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    // The repair relaunch cannot start: the worktree setup fails, so nobody was asked.
    worktree.failWith = "wt is not installed";
    await vi.advanceTimersByTimeAsync(1);

    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const detail = after.intent?.run?.stopped?.[0]?.detail ?? "";
    expect(detail.startsWith("could not ask bd-12 to repair its landing (")).toBe(true);
    expect(detail).toContain("proof-artifacts-in-diff");
    expect(detail.length).toBeLessThanOrEqual(FLEET_RUN_DETAIL_MAX_LENGTH);
    // Same bound rules as the second refusal: the marker leads, and the refusal is cut
    // at a word boundary inside its own path list, never inside a path.
    const tokens = detail.split(" ").filter((token) => token.includes("/"));
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      const cleaned = token.replace(/[,;]$/, "");
      if (cleaned.endsWith("…")) continue;
      expect(changedPaths).toContain(cleaned);
    }
    // The round was recorded before the ask (crash safety) and the stop is what a status
    // surface shows: the member is not presented as still repairing (W1).
    expect(after.intent?.run?.members?.[0]?.landRepair?.attempts).toBe(1);
    expect(after.intent?.run?.stopped?.[0]).toMatchObject({ reason: "land-failed" });
  });

  it("stops a real conflict with no repair round (bd-277 AC3)", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    // Base work committed after the fleet started, so the rebase conflict is a real
    // contradiction: a person decides, and no commit in the member's diff can.
    const drain = stubDrainGit({
      commonDir,
      memberDir,
      baseCommitAt: Math.floor(Date.now() / 1000) + 60,
    });

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(drain.rebaseAttempts()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    expect(stopped[0]?.detail).toContain("real contradiction");
    expect(after.intent?.run?.members?.[0]?.landRepair).toBe(undefined);
    expect(auditEntries("fleet-land-repair")).toEqual([]);
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);
  });

  it("repairs nothing when the fleet is paused (bd-277 AC3)", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    mkdirSync(memberDir, { recursive: true });
    const drain = stubRefusingPayloadGit({ commonDir, memberDir, head: "d".repeat(40) });

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    editIntent((current) => ({ ...current, paused: true, note: "stepping away" }));
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(2_000);

    // A paused fleet halts before any land action: no drain, no repair round.
    expect(drain.drains()).toBe(0);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.members?.[0]?.landRepair).toBe(undefined);
    expect(after.intent?.run?.stopped ?? []).toEqual([]);
    expect(auditEntries("fleet-land-repair")).toEqual([]);
  });

  it("notes a live member and holds its unchanged branch until the repair grace (bd-277)", async () => {
    const memberDir = join(cwd, "member-bd-12");
    worktree.branchPath = memberDir;
    worktree.branch = "feat/bd-12";
    mkdirSync(memberDir, { recursive: true });
    const drain = stubRefusingPayloadGit({ commonDir, memberDir, head: "d".repeat(40) });

    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    seedLiveMemberLease(memberDir);
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    // AC 4: the note asks the member to act in its own worktree, so the record it is
    // working from must not move under it (no relaunch, no retirement, no bead write).
    const memberStatePath = join(memberDir, ".belayd", "workflow.json");
    const memberStateBytes = readFileSync(memberStatePath, "utf8");
    await vi.advanceTimersByTimeAsync(2_000);

    // One orchestrator per worktree: the live member is asked by note, not relaunched.
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);
    const notes = drainNotes({ dir: fleetEventsDir(commonDir, "default") });
    if (!notes.ok) throw new Error(notes.error);
    const repairs = notes.deliveries.filter((delivery) => delivery.note.kind === "land-repair");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.note.to).toBe("bd-12");
    expect(repairs[0]?.note.body).toContain("proof-artifacts-in-diff");
    const noted = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(noted).toHaveProperty("ok", true);
    if (!noted.ok) return;
    expect(noted.intent?.run?.members?.[0]).toMatchObject({ landRepair: { attempts: 1 } });
    expect(noted.intent?.run?.stopped ?? []).toEqual([]);
    expect(readFileSync(memberStatePath, "utf8")).toBe(memberStateBytes);
    expect(noted.intent?.taskIds).toEqual(["bd-12"]);
    expect(noted.intent?.released ?? []).toEqual([]);
    expect(auditEntries("members-released")).toEqual([]);
    expect(existsSync(memberDir)).toBe(true);

    // The unchanged branch is held, not re-drained: the registered attempt would turn
    // a repeat into an immediate stop before the member could commit.
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);
    expect(drain.drains()).toBe(1);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "has not moved yet",
    );
    const held = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(held).toHaveProperty("ok", true);
    if (!held.ok) return;
    expect(held.intent?.run?.stopped ?? []).toEqual([]);

    // A repair that changes nothing ends as the ordinary land stop once the grace
    // expires: nobody is left who could decide.
    ageRepairRound(FLEET_LAND_REPAIR_GRACE_MS + 1_000);
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);
    expect(drain.drains()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    expect(stopped[0]?.detail).toContain("still at");
    expect(stopped[0]?.detail).toContain("stopping it for a human");
  });

  it("stops a dirty member worktree with no repair round (bd-277 AC3)", async () => {
    // A queue/state refusal is the supervisor's condition, not a defect in the
    // member's diff: the member keeps today's terminal stop and no round is spent.
    const { drain, memberDir } = await armRefusedLanding({
      statusOutput: " M docs/proof/run.png\n",
    });
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    await vi.advanceTimersByTimeAsync(1);

    expect(drain.drains()).toBe(0);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    // The provenance leads even on a terminal reason, so the record says why no round
    // was worth spending.
    expect(stopped[0]?.detail.startsWith("member-worktree-dirty is not something")).toBe(true);
    expect(stopped[0]?.detail).toContain("uncommitted changes");
    expect(after.intent?.run?.members?.[0]?.landRepair).toBe(undefined);
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);
    expect(auditEntries("fleet-land-repair")).toEqual([]);
    expect(drainNotes({ dir: fleetEventsDir(commonDir, "default") })).toEqual({
      ok: true,
      deliveries: [],
      warnings: [],
    });
  });

  it("stops without asking when the repair attempt cannot be persisted (bd-277)", async () => {
    const { drain, memberDir } = await armRefusedLanding();
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    seedLiveMemberLease(memberDir);
    // Two lost compare-and-swaps: `mutateFleetIntent` retries once, so the attempt
    // never reaches disk. Without the count there is no bound left, so the round must
    // not be started at all.
    intentCas.conflictsRemaining = 2;
    try {
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      intentCas.conflictsRemaining = 0;
    }

    expect(drain.drains()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    expect(stopped[0]?.detail.startsWith("could not ask bd-12 to repair its landing (")).toBe(true);
    expect(stopped[0]?.detail).toContain("could not record the repair attempt");
    expect(stopped[0]?.detail).toContain("proof-artifacts-in-diff");
    expect(stopped[0]?.detail.length).toBeLessThanOrEqual(FLEET_RUN_DETAIL_MAX_LENGTH);
    // The attempt rides on the run the tick persisted: a first-write failure narrows
    // the crash-safety window, it does not un-spend the round.
    expect(after.intent?.run?.members?.[0]).toMatchObject({
      taskId: "bd-12",
      landRepair: { attempts: 1 },
    });
    // Nobody was asked: no relaunch, no note, no audit entry.
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);
    expect(auditEntries("fleet-land-repair")).toEqual([]);
    expect(drainNotes({ dir: fleetEventsDir(commonDir, "default") })).toEqual({
      ok: true,
      deliveries: [],
      warnings: [],
    });
  });

  it("stops without asking when the run does not list the member it would repair (bd-277 S3)", async () => {
    // A round for a member the run does not list cannot bound anything: it used to
    // synthesise the member (inventing a `launchedAt` and a start-grace window) so the
    // attempt counted against a launch the run never did. The round is refused now, and
    // the member keeps today's terminal stop with the refusal text.
    const { drain, memberDir } = await armRefusedLanding();
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    seedLiveMemberLease(memberDir);
    // Hand-edited or half-written code record: the task is still a fleet member whose
    // branch is complete, but `run.members` no longer lists it.
    editIntent((current) => {
      const run = current.run as { members?: unknown[] } | undefined;
      return { ...current, run: { ...run, members: [] } };
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(drain.drains()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    expect(stopped[0]?.detail.startsWith("could not ask bd-12 to repair its landing (")).toBe(true);
    expect(stopped[0]?.detail).toContain("is not a member of this run");
    expect(stopped[0]?.detail).toContain("proof-artifacts-in-diff");
    // No fabricated member and no round: the run is what the tick found.
    expect(after.intent?.run?.members).toEqual([]);
    expect(landRepairForMember(after.intent?.run, "bd-12")).toBe(undefined);
    // Nobody was asked: no relaunch, no note, no audit entry.
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);
    expect(auditEntries("fleet-land-repair")).toEqual([]);
    expect(drainNotes({ dir: fleetEventsDir(commonDir, "default") })).toEqual({
      ok: true,
      deliveries: [],
      warnings: [],
    });
  });

  it("stops without asking when the repair note cannot be written (bd-277)", async () => {
    const { drain, memberDir } = await armRefusedLanding();
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    seedLiveMemberLease(memberDir);
    // A live member is asked by note (one orchestrator per worktree), so a note drop
    // that cannot be created is a member nobody told.
    const eventsPath = fleetEventsDir(commonDir, "default");
    writeFileSync(eventsPath, "not a directory");
    await vi.advanceTimersByTimeAsync(1);

    expect(drain.drains()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    expect(stopped[0]?.detail.startsWith("could not ask bd-12 to repair its landing (")).toBe(true);
    expect(stopped[0]?.detail).toContain("the repair note could not be written");
    expect(stopped[0]?.detail).toContain("proof-artifacts-in-diff");
    expect(after.intent?.run?.members?.[0]?.landRepair?.attempts).toBe(1);
    // The note path never relaunches and never audits a delivery it could not make.
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);
    expect(auditEntries("fleet-land-repair")).toEqual([]);
    expect(readFileSync(eventsPath, "utf8")).toBe("not a directory");
  });

  it("stops when the member branch tip cannot be read to bound a repair (bd-277)", async () => {
    // Without the tip there is no way to tell a repair from an unchanged branch, so
    // the round could not be bounded and must not be started.
    const { drain, memberDir } = await armRefusedLanding({ headProbeFails: true });
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    seedLiveMemberLease(memberDir);
    await vi.advanceTimersByTimeAsync(1);

    expect(drain.drains()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    expect(stopped[0]?.detail.startsWith("could not ask bd-12 to repair its landing (")).toBe(true);
    expect(stopped[0]?.detail).toContain("could not read feat/bd-12's tip to bound a repair");
    expect(after.intent?.run?.members?.[0]?.landRepair).toBe(undefined);
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);
    expect(auditEntries("fleet-land-repair")).toEqual([]);
  });

  it("holds on an unreadable branch tip, then stops at the repair grace (bd-277)", async () => {
    const { drain, memberDir } = await armRefusedLanding();
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    seedLiveMemberLease(memberDir);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain.drains()).toBe(1);

    // "I could not look" must never read as "the branch moved": the landing holds
    // instead of draining a diff nobody repaired.
    drain.setHeadProbeFails(true);
    await vi.advanceTimersByTimeAsync(FLEET_RUN_ACTION_TICK_INTERVAL_MS);
    expect(drain.drains()).toBe(1);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "the branch probe failed",
    );
    const held = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(held).toHaveProperty("ok", true);
    if (!held.ok) return;
    expect(held.intent?.run?.stopped ?? []).toEqual([]);

    // Past the grace the same unreadable tip ends the hold: the stop carries the probe
    // failure as the evidence that nobody could have decided.
    setRepairRoundAt(Date.now() - FLEET_LAND_REPAIR_GRACE_MS - 1_000);
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);
    expect(drain.drains()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    expect(stopped[0]?.detail).toContain("still at");
    expect(stopped[0]?.detail).toContain("the branch probe also failed");
    expect(stopped[0]?.detail).toContain("stopping it for a human");
  });

  it("ends the repair hold exactly at FLEET_LAND_REPAIR_GRACE_MS (bd-277)", async () => {
    const { drain, memberDir } = await armRefusedLanding();
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    seedLiveMemberLease(memberDir);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain.drains()).toBe(1);

    // The record's `at` is the asking tick's own clock and the ask acted, so the next
    // tick fires one action interval later. Aging the record against *that* instant is
    // what makes the boundary exact however the fake clock starts.
    const askedAt = repairRoundAt();
    const nextTickAt = askedAt + FLEET_RUN_ACTION_TICK_INTERVAL_MS;
    setRepairRoundAt(nextTickAt - FLEET_LAND_REPAIR_GRACE_MS);
    await vi.advanceTimersByTimeAsync(nextTickAt - Date.now());

    expect(drain.drains()).toBe(1);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    expect(stopped[0]?.detail).toContain("still at");
    expect(stopped[0]?.detail).toContain("after 30 min");
  });

  it("still holds one millisecond before the repair grace (bd-277)", async () => {
    const { drain, memberDir } = await armRefusedLanding();
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    seedLiveMemberLease(memberDir);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain.drains()).toBe(1);

    const askedAt = repairRoundAt();
    const nextTickAt = askedAt + FLEET_RUN_ACTION_TICK_INTERVAL_MS;
    setRepairRoundAt(nextTickAt - (FLEET_LAND_REPAIR_GRACE_MS - 1));
    await vi.advanceTimersByTimeAsync(nextTickAt - Date.now());

    // One millisecond short of the grace is still a hold: the member was asked and
    // nothing says it has stopped working yet.
    expect(drain.drains()).toBe(1);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "has not moved yet",
    );
    const held = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(held).toHaveProperty("ok", true);
    if (!held.ok) return;
    expect(held.intent?.run?.stopped ?? []).toEqual([]);
  });

  it("drains again once the repair moves the branch tip (bd-277)", async () => {
    const { drain, memberDir } = await armRefusedLanding();
    writeMemberState({ cwd: memberDir, completedPhaseNames: ["plan", "implement"] });
    seedLiveMemberLease(memberDir);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain.drains()).toBe(1);

    // The member committed its repair: the tip moved, so the hold is answered and the
    // landing is the next thing that should happen — here the same refusal again, which
    // is what spends the round and stops the member.
    drain.setHead("e".repeat(40));
    await vi.advanceTimersByTimeAsync(FLEET_RUN_ACTION_TICK_INTERVAL_MS);

    expect(drain.drains()).toBe(2);
    const after = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    const stopped = after.intent?.run?.stopped ?? [];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ taskId: "bd-12", reason: "land-failed" });
    expect(stopped[0]?.detail.startsWith("repair 1 of 1 did not clear this")).toBe(true);
    // The moved tip answered the round; it did not buy a second one.
    expect(daemon.calls.filter((call) => call.path === "/sessions")).toHaveLength(1);
    expect(auditEntries("fleet-land-repair")).toHaveLength(1);
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

  it("lands a member whose bead is closed and whose branch is already on the base (bd-166)", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    // A human merged with `wt merge` and closed the bead: the member's worktree and
    // branch still resolve, bd reports it closed, and the git probe answers that the
    // branch is an ancestor of the base (the stubbed git runner exits 0).
    const memberPath = join(worktree.path, "feat-bd-12");
    mkdirSync(memberPath, { recursive: true });
    worktree.byBranch = { "feat/bd-12": memberPath };
    worktree.branch = "feat/bd-12";
    childProcess.bdStdout = (args) => {
      if (args[0] === "gate") return "null";
      if (args[0] !== "show") return undefined;
      return JSON.stringify([{ id: "bd-12", status: "closed" }]);
    };

    await vi.advanceTimersByTimeAsync(15_000);

    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    // Landed and pruned: no merge ran, the branch was already on the base.
    expect(intent.intent?.taskIds).toEqual([]);
    expect(intent.intent?.run?.members?.find((member) => member.taskId === "bd-12")).toMatchObject({
      landedAt: expect.any(Number),
    });
    const auditPath = join(commonDir, "belayd", "fleet", "default", "audit.log");
    const entries = readFileSync(auditPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { action: string; detail?: string });
    const landed = entries.find((entry) => entry.action === "fleet-landed");
    expect(landed?.detail).toContain("already on main");
    expect(entries.some((entry) => entry.action === "merge-enqueued")).toBe(false);
  });

  it("sweeps one member bead per tick, rotating with the run ticks (bd-166)", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12 bd-13 bd-14", ctx);
    const launched = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(launched).toHaveProperty("ok", true);
    if (!launched.ok) return;
    expect(launched.intent?.run?.members?.map((member) => member.taskId)).toEqual([
      "bd-12",
      "bd-13",
      "bd-14",
    ]);

    const probedBeads = (): string[] =>
      childProcess.execFileCalls
        .filter((call) => call.file === "bd" && call.args[0] === "show")
        .flatMap((call) => call.args.filter((arg) => /^bd-\d+$/u.test(arg)));

    childProcess.execFileCalls.length = 0;
    await vi.advanceTimersByTimeAsync(0);
    const firstTick = probedBeads();
    childProcess.execFileCalls.length = 0;
    await vi.advanceTimersByTimeAsync(15_000);
    const secondTick = probedBeads();

    // A regression to one batched `bd show` would probe all three in a single tick.
    expect(firstTick).toHaveLength(1);
    expect(secondTick).toHaveLength(1);
    expect(firstTick[0]).not.toBe(secondTick[0]);
  });
  it("releases a finished run's unlanded member without pruning it (bd-166)", async () => {
    await stopEveryMemberInRun();

    // The stop tick reschedules at the action interval; the next tick finds nothing
    // to land or stop and finishes the run as partial.
    await vi.advanceTimersByTimeAsync(2_000);

    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    expect(intent.intent?.run?.outcome).toBe("partial");
    // The member keeps its record (bead, worktree, transcript) but stops holding a
    // capacity slot: the finished run can never land it.
    expect(intent.intent?.taskIds).toEqual(["bd-12"]);
    expect(intent.intent?.released).toEqual([
      expect.objectContaining({ taskId: "bd-12", reason: "run-complete" }),
    ]);
    const released = auditEntries("members-released");
    expect(released).toHaveLength(1);
    expect(released[0]?.taskIds).toEqual(["bd-12"]);
  });

  it("releases a halted run's unlanded members (bd-166)", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    // Park the fleet: the next tick halts the run with a haltedReason (terminal, not
    // resumable), so its members can never be landed by this run.
    editIntent((intent) => ({
      ...intent,
      park: { reason: "root checkout is dirty", recordedAt: 1 },
    }));
    await vi.advanceTimersByTimeAsync(15_000);

    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    expect(intent.intent?.run?.haltedReason).toContain("parked");
    expect(intent.intent?.released).toEqual([
      expect.objectContaining({ taskId: "bd-12", reason: "run-halted" }),
    ]);
    expect(auditEntries("members-released")[0]?.taskIds).toEqual(["bd-12"]);
  });

  it("does not release members when a run merely pauses (bd-166)", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    // A pause stops the ticker but leaves the run resumable: releasing its members
    // would free slots for work that a resume continues.
    editIntent((intent) => ({ ...intent, paused: true }));

    await vi.advanceTimersByTimeAsync(15_000);

    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    expect(intent.intent?.run?.finishedAt).toBeUndefined();
    expect(intent.intent?.run?.haltedReason).toBeUndefined();
    expect(intent.intent?.released).toBeUndefined();
    expect(auditEntries("members-released")).toHaveLength(0);
  });

  it("records an advance-launched member in the live run and beats the heartbeat (bd-166)", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    // A second wave waits on capacity that has since freed.
    editIntent((intent) => ({
      ...intent,
      deferred: [{ taskId: "bd-19", reason: "capacity", detail: "no free slot" }],
    }));

    const tool = mock.tools.get("belayd_fleet_advance");
    if (tool === undefined) throw new Error("belayd_fleet_advance was not registered");
    const advanced = await tool.execute("advance-1", {}, undefined, undefined, ctx);
    expect(advanced.details).toHaveProperty("exitCode", 0);

    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    // The advance is a step of the live run, so its member must be in run.members:
    // wave2's record named only the first member while two more were in flight.
    expect(intent.intent?.run?.members?.map((member) => member.taskId)).toEqual(["bd-12", "bd-19"]);
    expect(readSupervisorHeartbeat({ gitCommonDir: commonDir, fleetId: "default" })).toMatchObject({
      sessionId: "supervisor-session",
    });
  });
});

/**
 * A run loop whose supervisor session restarted (bd-169).
 *
 * The wave2 incident: the daemon restarted, the loop's in-memory arm token died
 * with it, and nothing landed or warned for nine hours while status called the run
 * active. These cases pin the repair and its boundaries: a session_start re-adopts
 * the active run its own record names when the beat is cold, never adopts another
 * session's fleet, reports a tick that loses authority with the recovery command,
 * and an advance restarts a dead timer.
 */
describe("supervisor restart re-adoption (bd-169)", () => {
  let cwd: string;
  let commonDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-readopt-"));
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
    childProcess.failBdComment = false;
    ctxNotifications = [];
    afterLaunchHook = undefined;
  });

  afterEach(() => {
    liveness.memberTaskIds = [];
    intentCas.beforeUpdate = undefined;
    vi.useRealTimers();
    childProcess.bdStdout = undefined;
    afterLaunchHook = undefined;
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
  });

  function fleetFile(fleetId = "default"): string {
    return join(commonDir, "belayd", "fleet", fleetId, "fleet.json");
  }

  function runTicks(fleetId = "default"): number | undefined {
    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId });
    return intent.ok ? intent.intent?.run?.ticks : undefined;
  }

  function auditActions(fleetId = "default"): string[] {
    const path = join(commonDir, "belayd", "fleet", fleetId, "audit.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { action: string }).action);
  }

  /** The detail of every audit entry of one action, in append order. */
  function auditDetails(action: string, fleetId = "default"): string[] {
    const path = join(commonDir, "belayd", "fleet", fleetId, "audit.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { action: string; detail?: string })
      .filter((entry) => entry.action === action)
      .map((entry) => entry.detail ?? "");
  }

  /** The persisted shape the wave2 incident left: an active run with a dead beat. */
  function seedActiveRun(options: {
    supervisorSessionId: string;
    ticks?: number;
    /** `/proc/<pid>/stat` field 22 at arm time, when the arming could read it. */
    pidStartTime?: string;
  }): void {
    seedFleetRun({ fleetId: "default", ...options });
  }

  /** The same shape under any fleet id, for the multi-fleet cases. */
  function seedFleetRun(options: {
    fleetId: string;
    supervisorSessionId: string;
    ticks?: number;
    /** `run.updatedAt`: the tie-break between two adoptable fleets. */
    runUpdatedAt?: number;
    pidStartTime?: string;
  }): void {
    mkdirSync(join(commonDir, "belayd", "fleet", options.fleetId), { recursive: true });
    writeFileSync(
      join(commonDir, "belayd", "fleet", options.fleetId, "fleet.json"),
      JSON.stringify({
        schemaVersion: 1,
        fleetId: options.fleetId,
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        supervisor: {
          sessionId: options.supervisorSessionId,
          pid: process.pid,
          ...(options.pidStartTime === undefined ? {} : { pidStartTime: options.pidStartTime }),
          armToken: "stale-arm-token",
        },
        run: {
          schemaVersion: 1,
          mode: "until-complete",
          startedAt: 1,
          updatedAt: options.runUpdatedAt ?? 1,
          ticks: options.ticks ?? 3,
          accept: false,
          members: [{ taskId: "bd-12", launchedAt: 1 }],
        },
      }),
    );
    writeSupervisorHeartbeat({
      gitCommonDir: commonDir,
      fleetId: options.fleetId,
      sessionId: options.supervisorSessionId,
      pid: process.pid,
      now: Date.now() - FLEET_SUPERVISOR_HEARTBEAT_STALE_MS - 1_000,
    });
  }

  /** Rewrite one fleet's record, the way an operator or a rival writer would. */
  function editFleetIntent(
    fleetId: string,
    mutate: (intent: Record<string, unknown>) => Record<string, unknown>,
  ): void {
    const path = join(commonDir, "belayd", "fleet", fleetId, "fleet.json");
    const intent = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(mutate(intent)));
  }

  /** An active run whose record names nobody: no supervisor record at all. */
  function seedLeaderlessRun(options: { beatAt?: number } = {}): void {
    writeFileSync(
      fleetFile(),
      JSON.stringify({
        schemaVersion: 1,
        fleetId: "default",
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        run: {
          schemaVersion: 1,
          mode: "until-complete",
          startedAt: 1,
          updatedAt: 1,
          ticks: 3,
          accept: false,
          members: [{ taskId: "bd-12", launchedAt: 1 }],
        },
      }),
    );
    if (options.beatAt === undefined) return;
    writeSupervisorHeartbeat({
      gitCommonDir: commonDir,
      fleetId: "default",
      sessionId: "unnamed-supervisor",
      pid: process.pid,
      now: options.beatAt,
    });
  }

  function leaderlessReports(): Array<{ message: string; level: string }> {
    return ctxNotifications.filter((entry) =>
      entry.message.includes("no usable supervisor record"),
    );
  }

  async function fireSessionStart(mock: MockPi, ctx: ReturnType<typeof makeCtx>): Promise<void> {
    expect(mock.sessionStart.length).toBeGreaterThan(0);
    for (const handler of mock.sessionStart) await handler({}, ctx);
  }

  it("re-adopts the active run of a restarted supervisor and ticks it", async () => {
    seedActiveRun({ supervisorSessionId: "restarted-session", ticks: 3 });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "restarted-session");

    await fireSessionStart(mock, ctx);

    const rewritten = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(rewritten).toHaveProperty("ok", true);
    if (!rewritten.ok) return;
    expect(rewritten.intent?.supervisor?.sessionId).toBe("restarted-session");
    // The record now carries a token this process minted, and the beat names it.
    const token = rewritten.intent?.supervisor?.armToken;
    expect(token).toBeDefined();
    expect(token).not.toBe("stale-arm-token");
    expect(readSupervisorHeartbeat({ gitCommonDir: commonDir, fleetId: "default" })).toMatchObject({
      sessionId: "restarted-session",
    });
    // W6: the token is never persisted outside the record it belongs to, and the
    // beat file in particular stays token-free.
    const beat = readFileSync(
      join(commonDir, "belayd", "fleet", "default", "supervisor.json"),
      "utf8",
    );
    expect(beat).not.toContain("armToken");
    expect(beat).not.toContain(token ?? "");
    expect(auditActions()).toContain("supervisor-readopted");
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "re-adopted the active run",
    );

    // The loop is really scheduled: the persisted run record ticks.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(runTicks()).toBeGreaterThan(3);
  });

  it("reports a tick that lost its authority with the re-arm command", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    // Another session re-armed: the record's token no longer matches this session.
    const parsed = JSON.parse(readFileSync(fleetFile(), "utf8")) as {
      supervisor?: Record<string, unknown>;
    };
    writeFileSync(
      fleetFile(),
      JSON.stringify({
        ...parsed,
        supervisor: { ...parsed.supervisor, armToken: "rotated-token" },
      }),
    );

    await vi.advanceTimersByTimeAsync(16_000);

    const lost = ctxNotifications.filter((entry) =>
      entry.message.includes("no longer the live supervisor"),
    );
    expect(lost).toHaveLength(1);
    expect(lost[0]?.level).toBe("warning");
    expect(lost[0]?.message).toContain("/fleet bd-12 --fleet default");
    expect(auditActions()).toContain("supervisor-lost");
    // The run is left alone: another session's loop may own that record now.
    expect(runTicks()).toBe(0);
  });

  it("restarts the timer when an advance finds an active run with no loop", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    const armed = readFileSync(fleetFile(), "utf8");

    // Rotate the record's token so the next tick loses authority and the loop dies;
    // this session still holds its own token and the active run survives.
    const parsed = JSON.parse(armed) as { supervisor?: Record<string, unknown> };
    writeFileSync(
      fleetFile(),
      JSON.stringify({
        ...parsed,
        supervisor: { ...parsed.supervisor, armToken: "rotated-token" },
      }),
    );
    await vi.advanceTimersByTimeAsync(16_000);
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "no longer the live supervisor",
    );

    // The record comes back (reconcile, or an operator restore) and is advanced.
    const restored = {
      ...(JSON.parse(armed) as Record<string, unknown>),
      deferred: [{ taskId: "bd-19", reason: "capacity", detail: "no free slot" }],
    };
    writeFileSync(fleetFile(), JSON.stringify(restored));
    const ticksBefore = runTicks() ?? 0;
    const tool = mock.tools.get("belayd_fleet_advance");
    if (tool === undefined) throw new Error("belayd_fleet_advance was not registered");
    await tool.execute("advance-1", {}, undefined, undefined, ctx);

    expect(auditActions()).toContain("fleet-run-restarted");
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "run loop restarted",
    );

    await vi.advanceTimersByTimeAsync(16_000);
    expect(runTicks()).toBeGreaterThan(ticksBefore);
  });

  it("never adopts another session's fleet, even with a cold beat", async () => {
    seedActiveRun({ supervisorSessionId: "someone-else", ticks: 3 });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "restarted-session");

    await fireSessionStart(mock, ctx);

    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    expect(intent.intent?.supervisor?.sessionId).toBe("someone-else");
    expect(intent.intent?.supervisor?.armToken).toBe("stale-arm-token");
    expect(auditActions()).not.toContain("supervisor-readopted");
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).not.toContain("re-adopted");
    // No timer was started for it: the run record does not move.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTicks()).toBe(3);
  });

  it("reports an active run whose record has no usable supervisor (bd-169 W5)", async () => {
    // No session is named, so "wait for the supervisor's next start" never happens:
    // without this report the run stays unticked and silent forever.
    writeFileSync(
      fleetFile(),
      JSON.stringify({
        schemaVersion: 1,
        fleetId: "default",
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        run: {
          schemaVersion: 1,
          mode: "until-complete",
          startedAt: 1,
          updatedAt: 1,
          ticks: 3,
          accept: false,
          members: [{ taskId: "bd-12", launchedAt: 1 }],
        },
      }),
    );
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "some-session");

    await fireSessionStart(mock, ctx);

    const warning = ctxNotifications.find((entry) =>
      entry.message.includes("no usable supervisor record"),
    );
    expect(warning?.level).toBe("warning");
    expect(warning?.message).toContain("/fleet bd-12 --fleet default");
    expect(auditActions()).toContain("supervisor-readopt-refused");
    expect(auditDetails("supervisor-readopt-refused")[0]).toContain("no supervisor record");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTicks()).toBe(3);
  });

  it("distinguishes an empty supervisor session id from a missing record (bd-169)", async () => {
    // A record that exists but names no session is a different state from an intent
    // with no record at all: the audit must let a reader tell which one it saw.
    writeFileSync(
      fleetFile(),
      JSON.stringify({
        schemaVersion: 1,
        fleetId: "default",
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        supervisor: { sessionId: "", pid: process.pid, armToken: "stale-arm-token" },
        run: {
          schemaVersion: 1,
          mode: "until-complete",
          startedAt: 1,
          updatedAt: 1,
          ticks: 3,
          accept: false,
          members: [{ taskId: "bd-12", launchedAt: 1 }],
        },
      }),
    );
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "some-session");

    await fireSessionStart(mock, ctx);

    expect(leaderlessReports()).toHaveLength(1);
    const [detail] = auditDetails("supervisor-readopt-refused");
    expect(detail).toContain("other-session");
    expect(detail).toContain("empty session id");
    expect(detail).not.toContain("no supervisor record");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTicks()).toBe(3);
  });

  it("stays quiet about an explicit fleet that has no run record (bd-169 W5)", async () => {
    writeFileSync(
      fleetFile(),
      JSON.stringify({
        schemaVersion: 1,
        fleetId: "default",
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "some-session");

    await fireSessionStart(mock, ctx);

    // An `--manual` fleet is legitimately leaderless: nothing ticks, nothing warns.
    const reported = ctxNotifications.map((entry) => entry.message).join("\n");
    expect(reported).not.toContain("no usable supervisor record");
    expect(reported).not.toContain("not re-adopted");
    expect(reported).not.toContain("re-adopted the active run");
    expect(reported).not.toContain("run loop restarted");
    expect(auditActions()).not.toContain("supervisor-readopt-refused");
    // Nothing was adopted either: a fleet with no run has no loop to repair, so the
    // record must stay exactly as the operator wrote it and no timer may appear.
    expect(auditActions()).not.toContain("supervisor-readopted");
    expect(auditActions()).not.toContain("supervisor-readopt-skipped");
    const untouched = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(untouched).toHaveProperty("ok", true);
    if (!untouched.ok) return;
    expect(untouched.intent).toMatchObject({ taskIds: ["bd-12"] });
    expect(untouched.intent?.supervisor).toBeUndefined();
    expect(untouched.intent?.run).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    const stillUntouched = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(stillUntouched).toHaveProperty("ok", true);
    if (!stillUntouched.ok) return;
    expect(stillUntouched.intent?.run).toBeUndefined();
  });

  it("stays quiet about a leaderless run whose beat is fresh (bd-169 W1)", async () => {
    // The record names nobody, but some session is beating the run right now: calling
    // that "nothing is ticking it" would be false, so status remains the surface.
    seedLeaderlessRun({ beatAt: Date.now() - 1_000 });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "some-session");

    await fireSessionStart(mock, ctx);

    expect(leaderlessReports()).toHaveLength(0);
    expect(auditActions()).not.toContain("supervisor-readopt-refused");
  });

  it("reports a leaderless run once its beat is cold (bd-169 W1)", async () => {
    seedLeaderlessRun({ beatAt: Date.now() - FLEET_SUPERVISOR_HEARTBEAT_STALE_MS - 1_000 });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "some-session");

    await fireSessionStart(mock, ctx);

    const reports = leaderlessReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.level).toBe("warning");
    // The stale beat is named, so the operator can tell a wedge from a missing record.
    expect(reports[0]?.message).toContain("beat ");
    expect(reports[0]?.message).toContain("/fleet bd-12 --fleet default");
  });

  it("reports a leaderless run once per cooldown window (bd-169 W2)", async () => {
    seedLeaderlessRun();
    const mock = await loadFleetExtension();

    await fireSessionStart(mock, makeCtx(cwd, "session-one"));
    expect(leaderlessReports()).toHaveLength(1);
    expect(auditActions()).toEqual(["supervisor-readopt-refused"]);

    // Another session starting inside the window must not repeat the same alarm, and
    // must not append a second audit entry for it.
    await vi.advanceTimersByTimeAsync(60_000);
    await fireSessionStart(mock, makeCtx(cwd, "session-two"));
    expect(leaderlessReports()).toHaveLength(1);
    expect(auditActions()).toHaveLength(1);

    // After the window the alarm repeats: the wedge may still be there, and a
    // suppressed report is not a resolution.
    await vi.advanceTimersByTimeAsync(FLEET_SUPERVISOR_HEARTBEAT_STALE_MS);
    await fireSessionStart(mock, makeCtx(cwd, "session-three"));
    expect(leaderlessReports()).toHaveLength(2);
    expect(auditActions()).toHaveLength(2);
  });

  it("refuses to adopt when the record gains a token between scan and write (bd-169 W4)", async () => {
    // A legacy record with no `armToken` is adoptable; the strict comparison must still
    // reject the write when another arming adds one in the window before the CAS.
    writeFileSync(
      fleetFile(),
      JSON.stringify({
        schemaVersion: 1,
        fleetId: "default",
        taskIds: ["bd-12"],
        createdAt: 1,
        updatedAt: 1,
        supervisor: { sessionId: "restarted-session", pid: process.pid },
        run: {
          schemaVersion: 1,
          mode: "until-complete",
          startedAt: 1,
          updatedAt: 1,
          ticks: 3,
          accept: false,
          members: [{ taskId: "bd-12", launchedAt: 1 }],
        },
      }),
    );
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "restarted-session");
    intentCas.beforeUpdate = () => {
      const current = JSON.parse(readFileSync(fleetFile(), "utf8")) as {
        supervisor: Record<string, unknown>;
      };
      writeFileSync(
        fleetFile(),
        JSON.stringify({
          ...current,
          supervisor: { ...current.supervisor, armToken: "another-arm" },
        }),
      );
    };

    await fireSessionStart(mock, ctx);

    // The other arming keeps the record; this session did not take it over.
    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    expect(intent.intent?.supervisor?.armToken).toBe("another-arm");
    expect(auditActions()).toContain("supervisor-readopt-failed");
    expect(auditActions()).not.toContain("supervisor-readopted");
    const failure = ctxNotifications.find((entry) =>
      entry.message.includes("could not re-adopt the active run"),
    );
    expect(failure?.level).toBe("warning");
    expect(failure?.message).toContain("/fleet bd-12 --fleet default");
    expect(failure?.message).toContain("arm token");
    // No loop was started for a fleet this session does not hold.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTicks()).toBe(3);
  });

  it("refuses the adoption when only the recorded pid drifted (bd-169 W2)", async () => {
    // The CAS re-checks every anchor, not just the token: a re-arm that keeps the
    // session id and token but points at another process is still a different
    // supervisor, and overwriting it would strand the record on the wrong pid.
    seedActiveRun({ supervisorSessionId: "restarted-session" });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "restarted-session");
    intentCas.beforeUpdate = () => {
      const current = JSON.parse(readFileSync(fleetFile(), "utf8")) as {
        supervisor: Record<string, unknown>;
      };
      writeFileSync(
        fleetFile(),
        JSON.stringify({ ...current, supervisor: { ...current.supervisor, pid: process.pid + 1 } }),
      );
    };

    await fireSessionStart(mock, ctx);

    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    expect(intent.intent?.supervisor?.pid).toBe(process.pid + 1);
    expect(intent.intent?.supervisor?.armToken).toBe("stale-arm-token");
    expect(auditActions()).toContain("supervisor-readopt-failed");
    expect(auditActions()).not.toContain("supervisor-readopted");
    expect(auditDetails("supervisor-readopt-failed")[0]).toContain("pid changed");
    // Nothing adopted it, so no loop ticks the run.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTicks()).toBe(3);
  });

  it("refuses the adoption when only the recorded process start time drifted (bd-169 W2)", async () => {
    // A reused pid is the case the start time exists for: same pid, different process.
    seedActiveRun({ supervisorSessionId: "restarted-session", pidStartTime: "1111" });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "restarted-session");
    intentCas.beforeUpdate = () => {
      const current = JSON.parse(readFileSync(fleetFile(), "utf8")) as {
        supervisor: Record<string, unknown>;
      };
      writeFileSync(
        fleetFile(),
        JSON.stringify({
          ...current,
          supervisor: { ...current.supervisor, pidStartTime: "2222" },
        }),
      );
    };

    await fireSessionStart(mock, ctx);

    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    expect(intent.intent?.supervisor?.pidStartTime).toBe("2222");
    expect(intent.intent?.supervisor?.armToken).toBe("stale-arm-token");
    expect(auditActions()).toContain("supervisor-readopt-failed");
    expect(auditActions()).not.toContain("supervisor-readopted");
    expect(auditDetails("supervisor-readopt-failed")[0]).toContain("process start time changed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTicks()).toBe(3);
  });

  it("adopts only the newest of two fleets that name this session (bd-169)", async () => {
    seedFleetRun({
      fleetId: "alpha",
      supervisorSessionId: "restarted-session",
      runUpdatedAt: 10,
      ticks: 3,
    });
    seedFleetRun({
      fleetId: "zulu",
      supervisorSessionId: "restarted-session",
      runUpdatedAt: 20,
      ticks: 7,
    });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "restarted-session");

    await fireSessionStart(mock, ctx);

    // One session supervises one fleet: `zulu` has the newer run, so it wins even
    // though `alpha` sorts first in the directory scan.
    const adopted = readFleetIntent({ gitCommonDir: commonDir, fleetId: "zulu" });
    expect(adopted).toHaveProperty("ok", true);
    if (!adopted.ok) return;
    expect(adopted.intent?.supervisor?.sessionId).toBe("restarted-session");
    expect(adopted.intent?.supervisor?.armToken).not.toBe("stale-arm-token");
    expect(auditActions("zulu")).toContain("supervisor-readopted");

    // The other candidate is left exactly as it was, and reported with its own
    // recovery command — silence there would be the original bug again.
    const skipped = readFleetIntent({ gitCommonDir: commonDir, fleetId: "alpha" });
    expect(skipped).toHaveProperty("ok", true);
    if (!skipped.ok) return;
    expect(skipped.intent?.supervisor?.armToken).toBe("stale-arm-token");
    expect(auditActions("alpha")).toContain("supervisor-readopt-skipped");
    const report = ctxNotifications.find((entry) =>
      entry.message.includes("Fleet alpha: not re-adopted"),
    );
    expect(report?.level).toBe("warning");
    expect(report?.message).toContain("`zulu` holds the newer active run");
    expect(report?.message).toContain("/fleet bd-12 --fleet alpha");

    // Only the adopted fleet ticks; the skipped one is not driven by this session.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTicks("zulu")).toBeGreaterThan(7);
    expect(runTicks("alpha")).toBe(3);
  });

  it("breaks a tie between equally new runs by fleet id (bd-169)", async () => {
    seedFleetRun({
      fleetId: "alpha",
      supervisorSessionId: "restarted-session",
      runUpdatedAt: 20,
      ticks: 3,
    });
    seedFleetRun({
      fleetId: "zulu",
      supervisorSessionId: "restarted-session",
      runUpdatedAt: 20,
      ticks: 7,
    });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "restarted-session");

    await fireSessionStart(mock, ctx);

    // Equal `run.updatedAt`: the tie-break is the fleet id, ascending, so the choice
    // is deterministic across two runs of the same sweep.
    const adopted = readFleetIntent({ gitCommonDir: commonDir, fleetId: "alpha" });
    expect(adopted).toHaveProperty("ok", true);
    if (!adopted.ok) return;
    expect(adopted.intent?.supervisor?.armToken).not.toBe("stale-arm-token");
    expect(auditActions("alpha")).toContain("supervisor-readopted");
    expect(auditActions("zulu")).toContain("supervisor-readopt-skipped");
    const report = ctxNotifications.find((entry) =>
      entry.message.includes("Fleet zulu: not re-adopted"),
    );
    expect(report?.message).toContain("`alpha` holds the newer active run");
    const skipped = readFleetIntent({ gitCommonDir: commonDir, fleetId: "zulu" });
    expect(skipped).toHaveProperty("ok", true);
    if (!skipped.ok) return;
    expect(skipped.intent?.supervisor?.armToken).toBe("stale-arm-token");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTicks("alpha")).toBeGreaterThan(3);
    expect(runTicks("zulu")).toBe(7);
  });

  it("never adopts from a sub-agent session (bd-169)", async () => {
    // Sub-agents share the orchestrator's worktree and bead but must never act for
    // it: session_start returns before the sweep for them, so a `-sub-` session
    // starts no ticker and leaves the record to its orchestrator.
    seedActiveRun({ supervisorSessionId: "restarted-session" });
    const mock = await loadFleetExtension();
    const orchestrator = makeCtx(cwd, "restarted-session");
    const subAgent: ReturnType<typeof makeCtx> = {
      ...orchestrator,
      sessionManager: {
        ...orchestrator.sessionManager,
        getSessionName: () => "belayd-bd-169-implement-sub-1",
      },
    };

    await fireSessionStart(mock, subAgent);

    const intent = readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
    expect(intent).toHaveProperty("ok", true);
    if (!intent.ok) return;
    expect(intent.intent?.supervisor?.armToken).toBe("stale-arm-token");
    expect(auditActions()).not.toContain("supervisor-readopted");
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).not.toContain("re-adopted");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runTicks()).toBe(3);
  });

  it("does not chain a second timer when ensure runs twice in a row (bd-169)", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    // Settle one cadence: the launch tick runs at 0 ms, the next is one interval
    // later. While the member is only `starting`, every tick is idle, so that
    // interval is the 15 s one.
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS);
    const settled = runTicks() ?? 0;
    expect(settled).toBeGreaterThanOrEqual(1);

    const addDeferred = (intent: Record<string, unknown>): Record<string, unknown> => ({
      ...intent,
      deferred: [{ taskId: "bd-19", reason: "capacity", detail: "no free slot" }],
    });
    editFleetIntent("default", addDeferred);
    const tool = mock.tools.get("belayd_fleet_advance");
    if (tool === undefined) throw new Error("belayd_fleet_advance was not registered");
    const timersBefore = vi.getTimerCount();
    await tool.execute("advance-1", {}, undefined, undefined, ctx);
    // The first advance may consume the deferral; re-add it so the second call takes
    // the same path instead of refusing before `ensureFleetRunTimer`.
    editFleetIntent("default", addDeferred);
    await tool.execute("advance-2", {}, undefined, undefined, ctx);

    // Neither call restarted the loop, and no second timer chain appeared.
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(auditActions()).not.toContain("fleet-run-restarted");
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).not.toContain(
      "run loop restarted",
    );
    // A reset cadence would tick immediately (restart schedules at 0 ms); the real
    // loop waits out the interval it already had, then ticks exactly once.
    await vi.advanceTimersByTimeAsync(1);
    expect(runTicks()).toBe(settled);
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS);
    expect(runTicks()).toBe(settled + 1);
  });

  it("keeps the cadence when an advance runs inside a tick that is in flight (bd-169)", async () => {
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    // A capacity-blocked wave makes the next tick an acting tick that reports after
    // the launch engine wrote its plan: `afterLaunchHook` therefore runs inside that
    // tick, while `fleetTickInFlight` is still true, which is the window a second
    // `ensureFleetRunTimer` must leave alone.
    liveness.memberTaskIds = ["bd-12"];
    editFleetIntent("default", (intent) => ({
      ...intent,
      maxConcurrent: 1,
      deferred: [{ taskId: "bd-19", reason: "capacity", detail: "no free slot" }],
    }));
    const tool = mock.tools.get("belayd_fleet_advance");
    if (tool === undefined) throw new Error("belayd_fleet_advance was not registered");
    let invoked = false;
    afterLaunchHook = () => {
      invoked = true;
      void tool.execute("advance-in-tick", {}, undefined, undefined, ctx);
    };

    await vi.advanceTimersByTimeAsync(1);
    expect(invoked).toBe(true);
    // Let the mid-tick advance finish its awaits.
    await vi.advanceTimersByTimeAsync(1);

    expect(auditActions()).not.toContain("fleet-run-restarted");
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).not.toContain(
      "run loop restarted",
    );
    const settled = runTicks() ?? 0;
    // Still the loop's own cadence: nothing was rescheduled at 0 ms.
    await vi.advanceTimersByTimeAsync(1);
    expect(runTicks()).toBe(settled);
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

/**
 * Fleet escalation gates follow only human-relevant stops (bd-279).
 *
 * Two halves, both at the wiring level (the pure planning and drift rules live in
 * `fleet-escalation.test.ts`):
 *
 * - a condition a machine resolves must open **no** `belayd-fleet-escalation:` gate
 *   (the bead's explicit "must not"), asserted on a real tick's `gate create` argv
 *   rather than on the planner's absent input;
 * - the gates a stop *did* open are resolved when the reason for them ends — a
 *   landing, a relaunch, an unpark (the latter scoped so it can never answer a
 *   member's own stop escalation).
 */
describe("fleet escalation reap paths (bd-279)", () => {
  let cwd: string;
  let commonDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    cwd = mkdtempSync(join(tmpdir(), "belayd-fleet-escalation-reap-"));
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
    ctxNotifications = [];
    afterLaunchHook = undefined;
  });

  afterEach(() => {
    liveness.memberTaskIds = [];
    vi.useRealTimers();
    childProcess.bdStdout = undefined;
    rmSync(cwd, { recursive: true, force: true });
    git.commonDir = "";
  });

  interface BdStubOptions {
    /** Open gates per bead, as `bd gate list <bead> --json` answers before resolves. */
    openGates?: (beadId: string) => readonly Record<string, unknown>[];
    /** `bd show --brief-deps` graph; absent means "no edges". */
    edges?: readonly unknown[];
    /** Ids `bd gate create` mints, in create order. */
    mintIds?: readonly string[];
  }

  interface BdStub {
    /** Gate ids this stub was asked to resolve, in order. */
    resolved: string[];
  }

  /**
   * A bd stub covering what these cases read: the dependency graph, bead statuses,
   * and gate list/create/resolve.
   *
   * A resolved gate drops out of the stub's own `gate list` answer, so "the gate is
   * no longer open" is a real assertion rather than a restatement of the call.
   */
  function stubBd(options: BdStubOptions = {}): BdStub {
    const resolved: string[] = [];
    const minted = { count: 0 };
    const show = (args: readonly string[]): string => {
      if (args.includes("--brief-deps")) return JSON.stringify(options.edges ?? []);
      const ids = args.slice(1).filter((arg) => !arg.startsWith("-"));
      return JSON.stringify(ids.map((id) => ({ id, status: "open" })));
    };
    const gate = (args: readonly string[]): string | undefined => {
      switch (args[1]) {
        case "list":
          return JSON.stringify(
            (options.openGates?.(args[2] ?? "") ?? []).filter(
              (record) => !resolved.includes(String(record.id)),
            ),
          );
        case "create": {
          const id = options.mintIds?.[minted.count] ?? "bd-960";
          minted.count += 1;
          return JSON.stringify({ id, status: "open" });
        }
        case "resolve":
          resolved.push(args[2] ?? "");
          return "";
        default:
          return undefined;
      }
    };
    childProcess.bdStdout = (args) =>
      args[0] === "show" ? show(args) : args[0] === "gate" ? gate(args) : undefined;
    return { resolved };
  }

  function intent(): ReturnType<typeof readFleetIntent> {
    return readFleetIntent({ gitCommonDir: commonDir, fleetId: "default" });
  }

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

  function bdCalls(predicate: (args: readonly string[]) => boolean): string[][] {
    return childProcess.execFileCalls
      .filter((call) => call.file === "bd" && predicate(call.args))
      .map((call) => [...call.args]);
  }

  function gateCreates(): string[][] {
    return bdCalls((args) => args[0] === "gate" && args[1] === "create");
  }

  /** Escalation creates only: the marker is the one channel this change owns. */
  function escalationCreates(): string[][] {
    return gateCreates().filter((argv) => argv.join(" ").includes("belayd-fleet-escalation:"));
  }

  function editIntent(mutate: (intent: Record<string, unknown>) => Record<string, unknown>): void {
    const path = join(commonDir, "belayd", "fleet", "default", "fleet.json");
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(mutate(current)));
  }

  function escalationMarker(taskId: string, cause: string, round: number): string {
    return renderFleetEscalationGateMarker({ fleetId: "default", taskId, cause, round });
  }

  function openEscalationGate(input: {
    gateId: string;
    taskId: string;
    cause: string;
    round: number;
  }): Record<string, unknown> {
    const title = escalationMarker(input.taskId, input.cause, input.round);
    return {
      id: input.gateId,
      status: "open",
      await_type: "human",
      title,
      description: `Reason: ${title}: needs a human`,
    };
  }

  /** Stand a landed member in the run record, as a previous landing would have. */
  function standLandedRun(current: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(current.run as Record<string, unknown>),
      members: [{ taskId: "bd-12", launchedAt: 1, landedAt: 2 }],
    };
  }

  /** Mark bd-12 complete and its merge done, so the tick's next action is a landing. */
  function arrangeLandedMember(): void {
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
  }

  it("writes a capacity deferral without opening an escalation gate", async () => {
    // The bead's "must not": a capacity wait is a condition the loop resolves (a
    // slot frees itself), so no person is asked. The fixture is the real shape — the
    // run's only member has landed, the next wave waits for another fleet's slot.
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    // Another fleet holds the repository's only slot, and default's landed member
    // leaves a deferred wave that cannot start.
    mkdirSync(join(commonDir, "belayd", "fleet", "other"), { recursive: true });
    writeFileSync(
      join(commonDir, "belayd", "fleet", "other", "fleet.json"),
      JSON.stringify({
        schemaVersion: 1,
        fleetId: "other",
        taskIds: ["bd-15"],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    liveness.memberTaskIds = ["bd-15"];
    stubBd();
    editIntent((current) => ({
      ...current,
      taskIds: [],
      maxConcurrent: 1,
      deferred: [{ taskId: "bd-19", reason: "capacity", detail: "no free slot" }],
      run: standLandedRun(current),
    }));

    await vi.advanceTimersByTimeAsync(2_000);

    // The tick really did hit the capacity path, so the assertion is not vacuous.
    expect(auditEntries("capacity-blocked").map((entry) => entry.taskIds)).toContainEqual([
      "bd-19",
    ]);
    // No gate of any family: nothing was launched, so not even an ordering gate.
    expect(gateCreates()).toEqual([]);
    expect(escalationCreates()).toEqual([]);
    const after = intent();
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.stopped ?? []).toEqual([]);
  });

  it("creates only the ordering gate for a dependency wait, never an escalation", async () => {
    // bd-158's gate is the machine's own answer: the dependent starts when the
    // blocker lands. It must stay the only gate the tick creates (bd-279).
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    stubBd({
      edges: [
        { id: "bd-13", dependencies: [{ id: "bd-12", dependency_type: "blocks", status: "open" }] },
      ],
      mintIds: ["bd-901"],
    });

    await command.handler("bd-12 bd-13", ctx);
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);

    const creates = gateCreates();
    expect(creates).toHaveLength(1);
    expect(creates[0]?.join(" ")).toContain("belayd-fleet-ordering:");
    // Created, not touched: no gate was resolved on this wait either.
    expect(bdCalls((args) => args[0] === "gate" && args[1] === "resolve")).toEqual([]);
    expect(escalationCreates()).toEqual([]);
    const after = intent();
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.stopped ?? []).toEqual([]);
  });

  it("opens no escalation for a machine-resolvable gate failure the loop retries", async () => {
    // The nearest reachable equivalent of the "quality gate the loop retries" case:
    // on the run path a *publish/diff* refusal records `land-failed` by design
    // (bd-277 measured exactly that), so the machine-resolvable failure a tick
    // retries without a stop is the ordering-gate resolve. It must not escalate:
    // the retry, not a person, is what fixes it.
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    stubBd({ mintIds: ["bd-901"] });
    await command.handler("bd-12", ctx);

    // The merge already happened; bd refuses the gate resolve, so the loop retries it
    // from the record instead of ending the member.
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
    arrangeLandedMember();

    await vi.advanceTimersByTimeAsync(2_000);

    const after = intent();
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.run?.stopped ?? []).toEqual([]);
    expect(after.intent?.orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-13", gateId: "bd-900" },
    ]);
    // The retried failure opened no gate of any kind, and the ordering gate it could
    // not resolve is still the only one recorded.
    expect(gateCreates()).toEqual([]);
    expect(escalationCreates()).toEqual([]);
  });

  it("resolves a landed member's escalation gate and audits the landing", async () => {
    // A landing clears the stop (and the record the tick keys on), so the bead's own
    // gate is the only handle left: reap it, or the merged member stays blocked by a
    // question nobody can answer any more.
    const bd = stubBd({
      openGates: (beadId) =>
        beadId === "bd-12"
          ? [
              openEscalationGate({
                gateId: "bd-941",
                taskId: "bd-12",
                cause: "land-failed",
                round: 2,
              }),
            ]
          : [],
    });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);
    arrangeLandedMember();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(bd.resolved).toEqual(["bd-941"]);
    // The stub drops resolved gates from its `list` answer, so this proves the gate is
    // no longer open: the next tick reads none and resolves nothing a second time.
    await vi.advanceTimersByTimeAsync(FLEET_RUN_TICK_INTERVAL_MS + 1_000);
    expect(bd.resolved).toEqual(["bd-941"]);
    const audited = auditEntries("escalation-gates-resolved");
    expect(audited).toHaveLength(1);
    expect(audited[0]?.detail).toContain("landed member");
    expect(audited[0]?.detail).toContain("bd-941");
    const after = intent();
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(
      after.intent?.run?.members?.find((member) => member.taskId === "bd-12")?.landedAt,
    ).toEqual(expect.any(Number));
    expect(after.intent?.run?.stopped ?? []).toEqual([]);
  });

  it("resolves a relaunched member's old escalation gate on the advance tick", async () => {
    // A relaunch clears any stop the member carried, so its old escalation has no
    // record left to be reaped from: the advance sweep by marker is what answers it.
    const bd = stubBd({
      openGates: (beadId) =>
        beadId === "bd-19"
          ? [
              openEscalationGate({
                gateId: "bd-942",
                taskId: "bd-19",
                cause: "phase-failed",
                round: 1,
              }),
            ]
          : [],
    });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    await command.handler("bd-12", ctx);

    // The run's only member landed; the deferred wave is free to start now.
    editIntent((current) => ({
      ...current,
      taskIds: [],
      deferred: [
        { taskId: "bd-19", reason: "dependency", blockers: [], detail: "the blocker landed" },
      ],
      run: standLandedRun(current),
    }));

    await vi.advanceTimersByTimeAsync(2_000);

    const after = intent();
    expect(after).toHaveProperty("ok", true);
    if (!after.ok) return;
    expect(after.intent?.taskIds).toEqual(["bd-19"]);
    expect(bd.resolved).toEqual(["bd-942"]);
    const audited = auditEntries("escalation-gates-resolved");
    expect(audited).toHaveLength(1);
    expect(audited[0]?.detail).toContain("relaunched member");
    expect(audited[0]?.detail).toContain("bd-942");
  });

  it("unparks only the parked-fleet escalation, never a member's stop escalation", async () => {
    // The documented scope guarantee: an unpark answers the park, not a stop. Both
    // gates block the same bead, which is exactly when a whole-bead sweep would be
    // wrong — it would report a stopped member as unblocked.
    const bd = stubBd({
      openGates: (beadId) =>
        beadId === "bd-12"
          ? [
              openEscalationGate({
                gateId: "bd-970",
                taskId: "bd-12",
                cause: "fleet-parked",
                round: 7_000,
              }),
              openEscalationGate({
                gateId: "bd-971",
                taskId: "bd-12",
                cause: "land-failed",
                round: 2,
              }),
            ]
          : [],
    });
    const mock = await loadFleetExtension();
    const ctx = makeCtx(cwd, "supervisor-session");
    const command = mock.commands.get("fleet");
    if (command === undefined) throw new Error("/fleet was not registered");
    // `--manual` keeps the explicit surface: no tick competes with this assertion.
    await command.handler("bd-12 --manual", ctx);

    editIntent((current) => ({
      ...current,
      park: { reason: "root stash could not be restored", recordedAt: 7_000 },
    }));

    const resume = mock.tools.get("belayd_fleet_resume");
    if (resume === undefined) throw new Error("belayd_fleet_resume was not registered");
    const resumed = await resume.execute("resume-1", {}, undefined, undefined, ctx);
    expect(resumed.details).toHaveProperty("exitCode", 0);

    // Only the park cause was selected; the stop escalation is still open.
    expect(bd.resolved).toEqual(["bd-970"]);
    const audited = auditEntries("escalation-gates-resolved");
    expect(audited).toHaveLength(1);
    expect(audited[0]?.detail).toContain("parked-fleet");
    expect(audited[0]?.detail).toContain("bd-970");
    expect(audited[0]?.detail).not.toContain("bd-971");
    expect(ctxNotifications.map((entry) => entry.message).join("\n")).toContain(
      "resolved 1 escalation gate(s)",
    );
  });
});
