/**
 * Extension-surface tests for the human answer channel (bd-152).
 *
 * Three invariants are exercised end to end against a stubbed `bd`:
 *
 * 1. `belayd_ask_human` is two authored bd writes (gate, then comment) and it
 *    makes every phase tool refuse;
 * 2. a comment by a non-`belayd:` author is delivered exactly once — as a user
 *    turn from the poll, or as an injected message at turn start — and resolves
 *    the gate;
 * 3. a `belayd:` comment is never an answer, and a failing/absent bd degrades to
 *    "no answer yet" instead of a crash or a permanent block.
 *
 * The stubbed `bd` answers from a per-test reply table keyed by the argv with
 * any `--actor` pair removed, so the assertions can check the actor separately
 * from the command shape.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeWorkflowState } from "../workflow-state.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");
process.env.PI_WEB_SESSIOND_SOCKET = join(tmpdir(), "belayd-test-no-sessiond.sock");

const ACTOR = "belayd:bd-152:orchestrator";

interface BdCallRecord {
  file: string;
  argv: readonly string[];
  stdin: string;
}

interface BdReply {
  stdout?: string;
  error?: string;
}

const bd = vi.hoisted(() => {
  const calls: Array<{ file: string; argv: readonly string[]; stdin: string }> = [];
  const replies = new Map<string, BdReply | undefined>();
  const state = { fail: undefined as string | undefined };

  /** Remove `--actor <value>` so replies key on the command shape only. */
  const keyOf = (argv: readonly string[]): string => {
    const kept: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i];
      if (token === "--actor") {
        i += 1;
        continue;
      }
      if (token !== undefined) kept.push(token);
    }
    return kept.join(" ");
  };

  // The reply is produced when the child's stdin closes, which is where the real
  // process would answer; `runFileCommand` always closes it.
  const execFile = vi.fn(
    (
      file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const record = { file, argv: [...args], stdin: "" };
      calls.push(record);
      const childStdin = {
        on: () => {},
        end: (chunk?: string) => {
          record.stdin = chunk ?? "";
          if (state.fail !== undefined) {
            callback(new Error(state.fail), "", "");
            return;
          }
          const reply = replies.get(keyOf(args)) ?? {};
          if (reply.error !== undefined) {
            callback(new Error(reply.error), "", "");
            return;
          }
          callback(null, reply.stdout ?? "", "");
        },
      };
      return { stdin: childStdin };
    },
  );

  return {
    keyOf,
    calls,
    replies,
    execFile,
    reply: (key: string, value: BdReply | undefined) => {
      replies.set(key, value);
    },
    failEverything: (error: string) => {
      state.fail = error;
    },
    reset: () => {
      calls.length = 0;
      replies.clear();
      state.fail = undefined;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) =>
      (bd.execFile as unknown as (...rest: unknown[]) => unknown)(...args),
    exec: vi.fn((_command: string, _options: unknown, callback: unknown) => {
      const done = callback as (error: Error | null, stdout: string) => void;
      done(null, "");
    }),
    execFileSync: vi.fn(() => ""),
    execSync: vi.fn(() => ""),
  };
});

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number };
}

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

type AgentStartHandler = (
  event: { systemPromptOptions: Record<string, unknown> },
  ctx: unknown,
) => Promise<unknown> | unknown;

type ToolCallHandler = (event: { toolName: string }, ctx: unknown) => unknown;

type SessionStartHandler = (event: unknown, ctx: unknown) => unknown;

interface PiCommand {
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, PiCommand>;
  agentStart: AgentStartHandler[];
  toolCall: ToolCallHandler[];
  sessionStart: SessionStartHandler[];
  sessionShutdown: SessionStartHandler[];
  sentUserMessages: string[];
  /** Make the next N `sendUserMessage` calls throw, as a dying session would. */
  failNextSends: (count: number) => void;
}

function createMockPi(): MockPi {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, PiCommand>();
  const agentStart: AgentStartHandler[] = [];
  const toolCall: ToolCallHandler[] = [];
  const sessionStart: SessionStartHandler[] = [];
  const sessionShutdown: SessionStartHandler[] = [];
  const sentUserMessages: string[] = [];
  const pendingSendFailures = { remaining: 0 };
  const api = {
    registerTool: (def: RegisteredTool) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, def: PiCommand) => {
      commands.set(name, def);
    },
    on: (event: string, handler: unknown) => {
      if (event === "before_agent_start") agentStart.push(handler as AgentStartHandler);
      if (event === "tool_call") toolCall.push(handler as ToolCallHandler);
      if (event === "session_start") sessionStart.push(handler as SessionStartHandler);
      if (event === "session_shutdown") sessionShutdown.push(handler as SessionStartHandler);
    },
    sendMessage: () => {},
    sendUserMessage: (content: string) => {
      if (pendingSendFailures.remaining > 0) {
        pendingSendFailures.remaining -= 1;
        throw new Error("session is gone");
      }
      sentUserMessages.push(content);
    },
    appendEntry: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return {
    api,
    tools,
    commands,
    agentStart,
    toolCall,
    sessionStart,
    sessionShutdown,
    sentUserMessages,
    failNextSends: (count: number) => {
      pendingSendFailures.remaining = count;
    },
  };
}

async function loadExtension(): Promise<MockPi> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const mock = createMockPi();
  register(mock.api);
  return mock;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

// Every ctx gets its own session id: the extension keeps session state in a
// module-level map, so a shared id would leak `awaitingHuman` between tests.
let sessionCounter = 0;

function makeCtx(dir: string, sessionName = "belayd-bd-152") {
  sessionCounter += 1;
  const sessionId = `session-${sessionCounter}`;
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => sessionName,
      getSessionFile: () => `/tmp/${sessionName}.jsonl`,
    },
    cwd: dir,
    ui: { notify: () => {} },
  };
}

/** Run the session_shutdown handlers, as pi does when a session is deleted. */
async function shutdownSession(mock: MockPi, ctx: unknown): Promise<void> {
  for (const handler of mock.sessionShutdown) {
    await handler({}, ctx);
  }
}

/** The reason the tool_call gate attaches, if it blocks. */
async function blockReason(mock: MockPi, toolName: string, ctx: unknown): Promise<unknown> {
  for (const handler of mock.toolCall) {
    const outcome = (await handler({ toolName }, ctx)) as { block?: boolean; reason?: string };
    if (outcome?.block === true) return outcome.reason;
  }
  return undefined;
}

/** Run the turn-start handlers, collecting the injected messages. */
async function startTurn(
  mock: MockPi,
  ctx: unknown,
): Promise<Array<{ customType: string; content: string }>> {
  const messages: Array<{ customType: string; content: string }> = [];
  for (const handler of mock.agentStart) {
    const outcome = (await handler({ systemPromptOptions: {} }, ctx)) as
      | { message?: { customType: string; content: string } }
      | undefined;
    if (outcome?.message !== undefined) messages.push(outcome.message);
  }
  return messages;
}

/** The human-answer message a turn injected, if any. */
function humanAnswer(
  messages: Array<{ customType: string; content: string }>,
): { customType: string; content: string } | undefined {
  return messages.find((message) => message.customType === "belayd-human-answer");
}

/** Let a fire-and-forget bd read (session-start discovery) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Drain the microtask chain of a fire-and-forget poll tick under fake timers. */
async function settleMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** Seed `.belayd/workflow.json` so the session_start reconcile arms the gate. */
function seedWorkflow(dir: string): void {
  mkdirSync(join(dir, ".belayd"), { recursive: true });
  const written = writeWorkflowState({
    cwd: dir,
    state: {
      schemaVersion: 1,
      taskId: "bd-152",
      workflowType: "feature",
      resolutionSource: "default",
      branch: "feat/bd-152",
      originalCwd: dir,
      phaseOrder: ["implement"],
      completedPhaseNames: [],
      startedAt: 1,
      updatedAt: 1,
    },
  });
  if (!written.ok) throw new Error(`could not seed workflow state: ${written.error}`);
}

/** Everything a session_start needs to arm the gate from disk. */
async function startSession(mock: MockPi, ctx: unknown): Promise<void> {
  for (const handler of mock.sessionStart) {
    await handler({}, ctx);
  }
  await flush();
}

/** A recorded call's argv with the injected actor pair removed. */
function callKey(call: BdCallRecord): string {
  return bd.keyOf(call.argv);
}

/** The first recorded call whose actor-free argv starts with `prefix`. */
function findCall(prefix: string): BdCallRecord | undefined {
  return bd.calls.find((call) => callKey(call).startsWith(prefix));
}

const ASK_GATE_KEY = "gate create --blocks bd-152 --type=human --reason Which option? --json";
const ASK_COMMENT_KEY = "comment --stdin -- bd-152";
const GATE_LIST_KEY = "gate list bd-152 --json";
const COMMENTS_KEY = "comments bd-152 --json";
const RESOLVE_KEY = "gate resolve bd-159";

const OPEN_GATE = JSON.stringify([
  {
    id: "bd-159",
    status: "open",
    issue_type: "gate",
    await_type: "human",
    created_at: "2026-10-26T20:00:00Z",
  },
]);

function commentsJson(entries: Array<{ author: string; createdAt: string; text: string }>): string {
  return JSON.stringify(
    entries.map((entry, index) => ({
      id: `c-${index}`,
      issue_id: "bd-152",
      author: entry.author,
      created_at: entry.createdAt,
      text: entry.text,
    })),
  );
}

const ASK_COMMENT = { author: ACTOR, createdAt: "2026-10-26T20:00:01Z", text: "Which option?" };

function humanComment(text = "option b, ship it"): string {
  return commentsJson([ASK_COMMENT, { author: "hugo", createdAt: "2026-10-26T20:05:00Z", text }]);
}

describe("belayd_ask_human", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-human-answer-"));
    bd.reset();
    bd.reply(ASK_GATE_KEY, { stdout: JSON.stringify({ id: "bd-159", status: "open" }) });
    bd.reply(ASK_COMMENT_KEY, { stdout: "" });
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("opens a human gate, posts an authored comment, and refuses phase tools", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);

    const ask = mock.tools.get("belayd_ask_human");
    if (ask === undefined) throw new Error("belayd_ask_human was not registered");
    const result = await ask.execute(
      "call-1",
      { question: "Which option?" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.exitCode).toBe(0);
    expect(textOf(result)).toContain("END YOUR TURN NOW");
    expect(textOf(result)).toContain("bd-159");

    // Gate first, then the question as a `belayd:` comment with `--` before the
    // bead: the actor is what keeps the question out of the answer filter.
    expect(findCall("gate create")?.argv).toEqual([
      "gate",
      "--actor",
      ACTOR,
      "create",
      "--blocks",
      "bd-152",
      "--type=human",
      "--reason",
      "Which option?",
      "--json",
    ]);
    const commentCall = findCall(ASK_COMMENT_KEY);
    expect(commentCall?.stdin).toBe("Which option?");
    expect(commentCall?.argv).toEqual(["comment", "--actor", ACTOR, "--stdin", "--", "bd-152"]);

    // Blocking is enforced, not advisory.
    expect(String(await blockReason(mock, "belayd_implement", ctx))).toContain(
      "Waiting for a human answer on bd-152",
    );
    expect(await blockReason(mock, "belayd_commit", ctx)).toBeDefined();
    expect(await blockReason(mock, "belayd_start_followup", ctx)).toBeDefined();
    expect(await blockReason(mock, "belayd_ask_human", ctx)).toBeUndefined();
    expect(await blockReason(mock, "belayd_status", ctx)).toBeUndefined();
    expect(await blockReason(mock, "read", ctx)).toBeUndefined();
  });

  it("does not block anything when the gate could not be created", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    bd.failEverything("bd: command not found");

    const ask = mock.tools.get("belayd_ask_human");
    if (ask === undefined) throw new Error("belayd_ask_human was not registered");
    const result = await ask.execute(
      "call-1",
      { question: "Which option?" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("could not open a human gate");
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeUndefined();
  });

  it("refuses an empty question and a session with no bead", async () => {
    const mock = await loadExtension();
    const ask = mock.tools.get("belayd_ask_human");
    if (ask === undefined) throw new Error("belayd_ask_human was not registered");

    const empty = await ask.execute(
      "call-1",
      { question: "   " },
      undefined,
      undefined,
      makeCtx(cwd),
    );
    expect(empty.details.exitCode).toBe(1);
    expect(textOf(empty)).toContain("question is empty");

    const noBead = await ask.execute(
      "call-2",
      { question: "which?" },
      undefined,
      undefined,
      makeCtx(cwd, "human-session"),
    );
    expect(noBead.details.exitCode).toBe(1);
    expect(textOf(noBead)).toContain("no bead to ask about");
    expect(bd.calls).toHaveLength(0);
  });

  it("refuses an over-long question before spawning bd (S3)", async () => {
    const mock = await loadExtension();
    const ask = mock.tools.get("belayd_ask_human");
    if (ask === undefined) throw new Error("belayd_ask_human was not registered");

    const result = await ask.execute(
      "call-1",
      { question: "x".repeat(2_001), beadId: "bd-152" },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("keep it under 2000");
    expect(bd.calls).toHaveLength(0);
  });

  it("keeps the wait armed when the question write and the compensating resolve both fail (W2)", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    bd.reply(ASK_COMMENT_KEY, { error: "bd: comment write failed" });
    bd.reply(RESOLVE_KEY, { error: "bd: resolve failed" });

    const ask = mock.tools.get("belayd_ask_human");
    if (ask === undefined) throw new Error("belayd_ask_human was not registered");
    const result = await ask.execute(
      "call-1",
      { question: "Which option?" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("could not post the question");
    expect(textOf(result)).toContain("may be left blocked by an open human gate");
    // The gate is genuinely open, so the workflow must stay refused and watched.
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeDefined();
  });

  it("clears the wait when the compensating resolve succeeds (W2)", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    bd.reply(ASK_COMMENT_KEY, { error: "bd: comment write failed" });

    const ask = mock.tools.get("belayd_ask_human");
    if (ask === undefined) throw new Error("belayd_ask_human was not registered");
    const result = await ask.execute(
      "call-1",
      { question: "Which option?" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.exitCode).toBe(1);
    expect(textOf(result)).toContain("could not post the question as a bd comment");
    expect(findCall(RESOLVE_KEY)).toBeDefined();
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeUndefined();
  });
});

describe("human answer delivery", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-human-answer-"));
    bd.reset();
    bd.reply(ASK_GATE_KEY, { stdout: JSON.stringify({ id: "bd-159", status: "open" }) });
    bd.reply(ASK_COMMENT_KEY, { stdout: "" });
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    bd.reply(COMMENTS_KEY, { stdout: humanComment() });
    bd.reply(RESOLVE_KEY, { stdout: "resolved" });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  /** The registered ask tool; a missing registration is a wiring bug. */
  function askTool(mock: MockPi): RegisteredTool {
    const tool = mock.tools.get("belayd_ask_human");
    if (tool === undefined) throw new Error("belayd_ask_human was not registered");
    return tool;
  }

  /** Ask, so the session holds an in-memory wait mirroring the open bd gate. */
  async function ask(mock: MockPi, ctx: unknown): Promise<void> {
    await askTool(mock).execute("ask", { question: "Which option?" }, undefined, undefined, ctx);
  }

  it("delivers exactly once when the poll fires and the next turn also runs", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
    await startSession(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    vi.useFakeTimers();
    try {
      await ask(mock, ctx);
      await vi.advanceTimersByTimeAsync(30_000);
      await settleMicrotasks();
      expect(mock.sentUserMessages).toEqual(["hugo answered: option b, ship it"]);

      // The turn that follows the poll delivery must not inject the same answer
      // again, and the timer must not either.
      expect(humanAnswer(await startTurn(mock, ctx))).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      await settleMicrotasks();
      expect(mock.sentUserMessages).toHaveLength(1);
      expect(bd.calls.filter((call) => callKey(call).startsWith("gate resolve"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers exactly once when the turn starts before the poll fires", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
    await startSession(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    vi.useFakeTimers();
    try {
      await ask(mock, ctx);
      expect(vi.getTimerCount()).toBe(1);

      // The return value is the delivery (bd-148); settling stops the poll, so
      // the interval that would have delivered cannot fire afterwards.
      expect(humanAnswer(await startTurn(mock, ctx))?.content).toBe(
        "hugo answered: option b, ship it",
      );
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      await settleMicrotasks();
      expect(mock.sentUserMessages).toEqual([]);
      expect(bd.calls.filter((call) => callKey(call).startsWith("gate resolve"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens no second gate and arms no second poll for a second ask", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
    await startSession(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    vi.useFakeTimers();
    try {
      await ask(mock, ctx);
      expect(vi.getTimerCount()).toBe(1);

      const second = await askTool(mock).execute(
        "ask-2",
        { question: "Which option?" },
        undefined,
        undefined,
        ctx,
      );

      // Answering the tool call in the affirmative would make the model believe a
      // second question was posted; nothing may be written either.
      expect(second.details.exitCode).toBe(0);
      expect(textOf(second)).toContain("Already waiting for a human answer on bd-152");
      expect(bd.calls.filter((call) => callKey(call).startsWith("gate create"))).toHaveLength(1);
      expect(bd.calls.filter((call) => callKey(call) === ASK_COMMENT_KEY)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not deliver a human comment posted before the gate was created", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    await ask(mock, ctx);
    // The gate was created at 20:00:00Z: an earlier human comment answers a
    // previous question (or predates the ask), never this one.
    bd.reply(COMMENTS_KEY, {
      stdout: commentsJson([
        ASK_COMMENT,
        { author: "hugo", createdAt: "2026-10-26T19:00:00Z", text: "stale earlier answer" },
      ]),
    });

    expect(humanAnswer(await startTurn(mock, ctx))).toBeUndefined();
    expect(findCall(RESOLVE_KEY)).toBeUndefined();
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeDefined();
    // Leave no live poll behind for this file's remaining tests.
    await shutdownSession(mock, ctx);
  });

  it("never reads the comment thread of a different bead", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    await ask(mock, ctx);
    // The human answered another bead: that thread must never reach this wait.
    bd.reply("comments bd-999 --json", { stdout: humanComment("answer for another bead") });
    bd.reply(COMMENTS_KEY, { stdout: commentsJson([ASK_COMMENT]) });

    expect(humanAnswer(await startTurn(mock, ctx))).toBeUndefined();
    expect(findCall(RESOLVE_KEY)).toBeUndefined();
    expect(bd.calls.some((call) => callKey(call) === COMMENTS_KEY)).toBe(true);
    expect(bd.calls.some((call) => callKey(call) === "comments bd-999 --json")).toBe(false);
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeDefined();
    await shutdownSession(mock, ctx);
  });

  it("never treats a belayd-authored comment as the answer, whoever wrote it", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    await ask(mock, ctx);

    // The question itself (the session actor), a supervisor→member fleet note
    // mirror, a phase agent's note, and a proof-verifier note. `resolveBdActor`
    // derives the first and third from the session name, so this also pins the
    // actor derived in this session rather than only the literal in `ASK_COMMENT`.
    const authors = [
      "belayd:bd-152:orchestrator",
      "belayd:supervisor",
      "belayd:bd-152:implement",
      "belayd:bd-152:proof_verifier",
    ];
    for (const author of authors) {
      bd.reply(COMMENTS_KEY, {
        stdout: commentsJson([
          ASK_COMMENT,
          { author, createdAt: "2026-10-26T20:05:00Z", text: `note from ${author}` },
        ]),
      });
      expect(humanAnswer(await startTurn(mock, ctx)), author).toBeUndefined();
    }
    expect(findCall(RESOLVE_KEY)).toBeUndefined();
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeDefined();
    await shutdownSession(mock, ctx);
  });

  it("reaps the gate and stops the poll on belayd_stop_task", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
    await startSession(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    vi.useFakeTimers();
    const previousCwd = process.cwd();
    try {
      await ask(mock, ctx);
      expect(vi.getTimerCount()).toBe(1);

      const stop = mock.tools.get("belayd_stop_task");
      if (stop === undefined) throw new Error("belayd_stop_task was not registered");
      const result = await stop.execute("stop", {}, undefined, undefined, ctx);

      expect(result.details.exitCode).toBe(0);
      // No orphan gate: a stopped workflow must not leave the bead blocked in bd.
      expect(findCall(RESOLVE_KEY)?.argv).toContain("bd-159");
      expect(vi.getTimerCount()).toBe(0);
      expect(await blockReason(mock, "belayd_implement", ctx)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(120_000);
      await settleMicrotasks();
      expect(mock.sentUserMessages).toEqual([]);
    } finally {
      vi.useRealTimers();
      // `belayd_stop_task` restores the persisted original cwd (the temp dir).
      process.chdir(previousCwd);
    }
  });

  it("clears the wait on stop even when bd is failing, so it cannot stick", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
    await startSession(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    vi.useFakeTimers();
    const previousCwd = process.cwd();
    try {
      await ask(mock, ctx);
      bd.failEverything("bd: command not found");

      const stop = mock.tools.get("belayd_stop_task");
      if (stop === undefined) throw new Error("belayd_stop_task was not registered");
      const result = await stop.execute("stop", {}, undefined, undefined, ctx);

      // Teardown is best-effort: a bd failure is logged/warned, never a throw,
      // and the in-memory wait is gone so nothing can wait forever.
      expect(result.details.exitCode).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(await blockReason(mock, "belayd_implement", ctx)).toBeUndefined();
    } finally {
      vi.useRealTimers();
      process.chdir(previousCwd);
    }
  });

  it("reaps the gate and stops the poll when /plan drops the workflow", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
    await startSession(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    const previousCwd = process.cwd();
    try {
      // A stopped workflow keeps `currentTaskId` and drops `gateActive`, which is
      // the state /plan can drop: an open bd gate with a poll and no armed phase
      // gate. (While the gate is armed, /plan refuses instead.)
      const stop = mock.tools.get("belayd_stop_task");
      if (stop === undefined) throw new Error("belayd_stop_task was not registered");
      await stop.execute("stop", {}, undefined, undefined, ctx);
      bd.calls.length = 0;

      vi.useFakeTimers();
      const asked = await askTool(mock).execute(
        "ask",
        { question: "Which option?" },
        undefined,
        undefined,
        ctx,
      );
      expect(asked.details.exitCode).toBe(0);
      expect(vi.getTimerCount()).toBe(1);

      const plan = mock.commands.get("plan");
      if (plan === undefined) throw new Error("/plan was not registered");
      await plan.handler("start something else", ctx);

      // /plan clears workflow.json, which is the rediscovery path: the gate must
      // be resolved here or the bead stays blocked with no answer channel (W3).
      expect(findCall(RESOLVE_KEY)?.argv).toContain("bd-159");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      await settleMicrotasks();
      expect(mock.sentUserMessages).toEqual([]);
    } finally {
      vi.useRealTimers();
      process.chdir(previousCwd);
    }
  });

  it("delivers a human comment exactly once and resolves the gate", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    await ask(mock, ctx);

    const answer = humanAnswer(await startTurn(mock, ctx));
    expect(answer?.content).toBe("hugo answered: option b, ship it");

    const resolve = findCall(RESOLVE_KEY);
    expect(resolve?.argv).toContain("bd-159");
    expect(resolve?.argv).toContain(ACTOR);

    // Exactly once: the wait is gone, so a second turn injects nothing and the
    // phase tools are no longer refused.
    expect(humanAnswer(await startTurn(mock, ctx))).toBeUndefined();
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeUndefined();
    expect(bd.calls.filter((call) => callKey(call).startsWith("gate resolve"))).toHaveLength(1);
  });

  it("never treats a belayd comment as the answer", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    await ask(mock, ctx);
    bd.reply(COMMENTS_KEY, { stdout: commentsJson([ASK_COMMENT]) });

    expect(humanAnswer(await startTurn(mock, ctx))).toBeUndefined();
    expect(findCall(RESOLVE_KEY)).toBeUndefined();
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeDefined();
  });

  it("reports a gate resolved without a comment so the workflow can proceed", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    await ask(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });

    const answer = humanAnswer(await startTurn(mock, ctx));
    expect(answer?.content).toContain("was resolved without a comment");
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeUndefined();
  });

  it("degrades to no answer when bd is unavailable, without unblocking or throwing", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    await ask(mock, ctx);
    bd.failEverything("bd: command not found");

    expect(humanAnswer(await startTurn(mock, ctx))).toBeUndefined();
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeDefined();
  });

  it("keeps the wait armed when the gate record does not parse (W1)", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    await ask(mock, ctx);
    // bd renamed/dropped `await_type`: records exist but none is an open human
    // gate, so this must stay PENDING — never "the human resolved it".
    bd.reply(GATE_LIST_KEY, {
      stdout: JSON.stringify([{ id: "bd-159", status: "open" }]),
    });

    expect(humanAnswer(await startTurn(mock, ctx))).toBeUndefined();
    expect(findCall(RESOLVE_KEY)).toBeUndefined();
    expect(await blockReason(mock, "belayd_implement", ctx)).toBeDefined();
  });

  it("delivers through the self-poll timer while the session is idle", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    // The session starts with no open gate (nothing is being asked yet); the
    // gate appears with the ask below. Real timers for the session-start read,
    // then fake ones so the poll can be advanced without waiting 30 real seconds.
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
    await startSession(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    vi.useFakeTimers();
    try {
      await ask(mock, ctx);
      expect(mock.sentUserMessages).toEqual([]);

      await vi.advanceTimersByTimeAsync(30_000);
      // The tick's bd reads/writes resolve on microtasks, which the timer advance
      // does not await (the interval callback is fire-and-forget).
      await settleMicrotasks();
      expect(mock.sentUserMessages).toEqual(["hugo answered: option b, ship it"]);

      // The timer stopped with the wait, so a later tick cannot deliver twice.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mock.sentUserMessages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries after a failed send instead of losing the answer (W4)", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
    await startSession(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    vi.useFakeTimers();
    try {
      await ask(mock, ctx);
      // The session is being torn down: the send throws once.
      mock.failNextSends(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await settleMicrotasks();

      expect(mock.sentUserMessages).toEqual([]);
      // Nothing was settled: the wait is armed, the gate is still open.
      expect(await blockReason(mock, "belayd_implement", ctx)).toBeDefined();
      expect(findCall(RESOLVE_KEY)).toBeUndefined();

      // The next tick retries and delivers exactly once.
      await vi.advanceTimersByTimeAsync(30_000);
      await settleMicrotasks();
      expect(mock.sentUserMessages).toEqual(["hugo answered: option b, ship it"]);
      expect(findCall(RESOLVE_KEY)).toBeDefined();
      await vi.advanceTimersByTimeAsync(60_000);
      await settleMicrotasks();
      expect(mock.sentUserMessages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the poll on session shutdown (C1)", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    bd.reply(GATE_LIST_KEY, { stdout: JSON.stringify([]) });
    await startSession(mock, ctx);
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    vi.useFakeTimers();
    try {
      await ask(mock, ctx);
      expect(vi.getTimerCount()).toBe(1);

      await shutdownSession(mock, ctx);
      expect(vi.getTimerCount()).toBe(0);

      // A leaked interval would keep reading bd and could deliver into the dead
      // session; nothing may be sent after shutdown.
      await vi.advanceTimersByTimeAsync(120_000);
      await settleMicrotasks();
      expect(mock.sentUserMessages).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncates a long answer before it reaches the prompt", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);
    await ask(mock, ctx);
    bd.reply(COMMENTS_KEY, { stdout: humanComment("x".repeat(5000)) });

    const answer = humanAnswer(await startTurn(mock, ctx));

    expect(answer?.content.endsWith("…")).toBe(true);
    expect(answer?.content.length).toBeLessThan(2100);
  });
});

describe("human wait discovery after a restart", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-human-answer-"));
    bd.reset();
    bd.reply(GATE_LIST_KEY, { stdout: OPEN_GATE });
    bd.reply(COMMENTS_KEY, { stdout: humanComment() });
    bd.reply(RESOLVE_KEY, { stdout: "" });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("re-arms the wait from the open bd gate and delivers the pending answer", async () => {
    const mock = await loadExtension();
    const ctx = makeCtx(cwd);
    seedWorkflow(cwd);
    await startSession(mock, ctx);

    // Nothing was asked in this process: the wait comes from bd alone.
    expect(bd.calls.some((call) => callKey(call) === GATE_LIST_KEY)).toBe(true);
    expect(humanAnswer(await startTurn(mock, ctx))?.content).toBe(
      "hugo answered: option b, ship it",
    );
  });
});
