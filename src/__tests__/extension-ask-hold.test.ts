/**
 * Completion follow-ups must not close an open `ask_user` question set (bd-177).
 *
 * PI WEB renders the questions as a form only while they are the tail of the
 * transcript: any appended entry turns the card into a dead closed card, records
 * no outcome, and tells the model nothing. So a phase completion that settles
 * while the questions are open is held until the question set is resolved.
 *
 * Covered here:
 * - a completion is held while an unanswered ask is the branch tail
 * - nothing is marked delivered while it is held
 * - the next turn start releases it exactly once, in order
 * - the daemon `/belayd-complete` sentinel does not release it (it appends nothing)
 * - an answered question set delivers immediately
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTempRepoState } from "./helpers/repo-state.js";

// Run manifests are store rows now (bd-281), so the temp worktree needs a store.
installTempRepoState();

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-ask-hold-test-cooldowns.json");

// ── Mocks ──────────────────────────────────────────────────────────────

const mockExec = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(new Error("pnpm not available in test environment"), "", "");
    },
  ),
);

// `bd` is unavailable: workflow resolution falls back to defaults, which is all
// these tests need.
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
  return {
    ...actual,
    exec: mockExec,
    execFile: mockExecFile,
    execSync: () => {
      throw new Error("no execSync in test");
    },
    execFileSync: () => "",
  };
});

vi.mock("node:http", () => ({
  request: (
    _opts: unknown,
    callback: (res: {
      statusCode: number;
      on: (event: string, handler: (chunk: string) => void) => void;
    }) => void,
  ) => {
    const body = JSON.stringify({ sessions: [{ id: "sess1", name: "belayd-bd-42" }] });
    callback({
      statusCode: 200,
      on: (event: string, handler: (chunk: string) => void) => {
        if (event === "data") handler(body);
        if (event === "end") handler("");
      },
    });
    return { on: () => {}, write: () => {}, end: () => {} };
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => unknown;

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  messages: Array<{ customType: string; content: string }>;
  handlers: Map<string, Handler[]>;
}

function createMockPi(): MockPi {
  const tools = new Map<
    string,
    { name: string; execute: (...args: unknown[]) => Promise<unknown> }
  >();
  const messages: Array<{ customType: string; content: string }> = [];
  const handlers = new Map<string, Handler[]>();
  const api = {
    registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(def.name, def);
    },
    registerCommand: () => {},
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (msg: { customType: string; content: string }) => {
      messages.push({ customType: msg.customType, content: msg.content });
    },
    appendEntry: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, tools, messages, handlers };
}

async function loadExtension(): Promise<(pi: ExtensionAPI) => void> {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

let sessionIdCounter = 0;

/** An orchestrator session whose transcript branch the test mutates directly. */
function makeOrchestratorCtx(cwd: string, branch: unknown[]) {
  sessionIdCounter += 1;
  return {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => `ask-hold-orch-${sessionIdCounter}`,
      getSessionName: () => "belayd-bd-42",
      getBranch: () => branch,
      getSessionFile: () => "/tmp/orchestrator.jsonl",
    },
  };
}

/** An unanswered `ask_user` result, as PI WEB persists it. */
const openAskEntry = {
  type: "message",
  message: {
    role: "toolResult",
    toolName: "ask_user",
    isError: false,
    details: { ask: { askId: "ask-1", askedAt: "2026-10-30T07:58:06.943Z", questions: [] } },
  },
};

const answersEntry = {
  type: "custom_message",
  customType: "pi-web.ask.answers",
  content: "The user submitted answers to your questions.",
  display: true,
  details: { askId: "ask-1", reason: "submitted" },
};

/** Seed a phase run the user completed from a sub-agent session, ready to reconcile. */
async function seedUserCompletion(cwd: string, runId: string): Promise<void> {
  const { completeRunByUser, writeRunManifest, RunStatus } = await import("../run-manifest.js");
  writeRunManifest({
    cwd,
    manifest: {
      schemaVersion: 1,
      runId,
      taskId: "bd-42",
      phase: "implement",
      sessionName: `belayd-bd-42-sub-implement-${runId}`,
      status: RunStatus.Running,
      startedAt: 1_000,
    },
  });
  completeRunByUser({ cwd, runId, report: "user recovered report" });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("completion follow-ups held behind an open ask_user (bd-177)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-ask-hold-"));
    mockExecFile.mockClear();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.useRealTimers();
  });

  async function startWorkflow(pi: MockPi, ctx: unknown): Promise<void> {
    const factory = await loadExtension();
    factory(pi.api);
    await pi.tools
      .get("belayd_start_task")
      ?.execute("call-start", { taskId: "bd-42" }, undefined, undefined, ctx);
  }

  function completionCount(pi: MockPi): number {
    return pi.messages.filter((message) => message.customType === "belayd-run-complete").length;
  }

  it("holds a completion while the question set is unanswered, then releases it on the next turn", async () => {
    const pi = createMockPi();
    const branch: unknown[] = [];
    const ctx = makeOrchestratorCtx(cwd, branch);
    await startWorkflow(pi, ctx);
    await seedUserCompletion(cwd, "run9");

    branch.push(openAskEntry);

    const inputHandler = pi.handlers.get("input")?.[0];
    expect(inputHandler).toBeDefined();
    // The daemon sentinel appends nothing to the transcript, so it must not
    // release the hold: the question form is still open.
    expect(
      inputHandler?.({ type: "input", text: "[belayd-complete:run9]", source: "extension" }, ctx),
    ).toEqual({
      action: "handled",
    });
    expect(completionCount(pi)).toBe(0);
    const { readRunManifest } = await import("../run-manifest.js");
    expect(readRunManifest({ cwd, runId: "run9" })?.deliveredAt).toBeUndefined();

    // The answer arrives as a new entry and starts the next turn.
    branch.push(answersEntry);
    for (const handler of pi.handlers.get("before_agent_start") ?? []) await handler({}, ctx);

    expect(completionCount(pi)).toBe(1);
    expect(
      pi.messages.find((message) => message.customType === "belayd-run-complete")?.content,
    ).toContain("user recovered report");
    expect(readRunManifest({ cwd, runId: "run9" })?.deliveredAt).toBeDefined();

    // One release only: the queue was drained and the manifest marker holds.
    for (const handler of pi.handlers.get("before_agent_start") ?? []) await handler({}, ctx);
    expect(completionCount(pi)).toBe(1);
  });

  it("delivers immediately when the question set was already answered", async () => {
    const pi = createMockPi();
    const branch: unknown[] = [openAskEntry, answersEntry];
    const ctx = makeOrchestratorCtx(cwd, branch);
    await startWorkflow(pi, ctx);
    await seedUserCompletion(cwd, "run10");

    const inputHandler = pi.handlers.get("input")?.[0];
    inputHandler?.({ type: "input", text: "[belayd-complete:run10]", source: "extension" }, ctx);

    expect(completionCount(pi)).toBe(1);
    const { readRunManifest } = await import("../run-manifest.js");
    expect(readRunManifest({ cwd, runId: "run10" })?.deliveredAt).toBeDefined();
  });

  it("holds nothing when the session never asked a question", async () => {
    const pi = createMockPi();
    const ctx = makeOrchestratorCtx(cwd, [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    ]);
    await startWorkflow(pi, ctx);
    await seedUserCompletion(cwd, "run11");

    pi.handlers.get("input")?.[0]?.(
      { type: "input", text: "[belayd-complete:run11]", source: "extension" },
      ctx,
    );

    expect(completionCount(pi)).toBe(1);
  });
});
