/**
 * Integration coverage for bd-151: phase deliverables (userguide body, research
 * findings, proof verdict) are recorded as authored, `[belayd:<phase>]`-tagged
 * bead comments instead of being appended to the bead's plan notes, and the
 * plan reader drops the comment thread so phase prompts stay bounded.
 *
 * Real extension factory, real worktree files and real workflow state; only the
 * process edges (bd/git and the sub-agent spawn) are stubbed — the same seam
 * other suites in this directory use. bd itself cannot be run here (issues live
 * on a shared Dolt server), so the assertions are on the exact `bd` argv and the
 * stdin body the harness hands to `bd comment --stdin`; bd's own authoring and
 * timestamping are what `src/__tests__/fixtures/bd-show-with-comments.txt`
 * records.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESEARCHER_SYSTEM_PROMPT } from "../src/agent-registry.js";
import { phaseCommentBody, phaseCommentHeader } from "../src/bead-comments.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");
process.env.BELAYD_PROOF_DIR = join(tmpdir(), "belayd-test-deliverable-proof");

const REPO_ROOT = resolve(import.meta.dirname, "..");

const VERDICT = "## Verdict\nreasonable: true\nreason: ok\nevidence: cast";
const USERGUIDE_REPORT = "## How to Verify\n1. Run pnpm test\n\n## How to Use\nSee the doc.\n";

// ── Process edges ──────────────────────────────────────────────────────

/**
 * Sub-agent spawns, keyed by the phase name appearing in the session name
 * (`belayd-bd-42-userguide-<run>`): `spawnAgentWithFallback` consumes `phase`
 * itself for telemetry, so it never reaches `spawnAgentProcess`.
 */
const mockSpawn = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  reports: new Map<string, string>(),
  clear() {
    this.calls.length = 0;
    this.reports.clear();
  },
}));

function reportFor(sessionName: string): string {
  for (const [phase, report] of mockSpawn.reports) {
    if (sessionName.includes(phase)) return report;
  }
  return "done";
}

vi.mock("../src/spawn.js", () => ({
  spawnAgentProcess: vi.fn((options: Record<string, unknown>) => {
    mockSpawn.calls.push(options);
    const sessionName =
      typeof options.sessionName === "string" ? options.sessionName : "mocked-deliverable";
    const text = reportFor(sessionName);
    return Promise.resolve({
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
      },
      sessionName,
    });
  }),
}));

interface ExecFileRecord {
  file: string;
  args: readonly string[];
  stdin: string;
  cwd: string | undefined;
}

const mockExecFile = vi.hoisted(() => {
  const calls: ExecFileRecord[] = [];
  /** Plain `bd show <id>` output; any other bd lookup fails. */
  let showOutput = "";
  /** Handle a recorded call, defaulting to success with empty output. */
  const respond = (
    record: ExecFileRecord,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    if (record.file === "bd" && record.args[0] === "show" && record.args.length === 2) {
      callback(null, showOutput, "");
      return;
    }
    if (record.file === "git" && record.args[0] === "rev-parse") {
      callback(null, "abc1234\n", "");
      return;
    }
    if (record.file === "bd" && record.args[0] === "show") {
      callback(new Error("bd show --json unavailable"), "", "");
      return;
    }
    callback(null, "", "");
  };
  const fn = vi.fn(
    (
      file: string,
      args: readonly string[],
      options: { cwd?: string },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const record: ExecFileRecord = { file, args, stdin: "", cwd: options?.cwd };
      calls.push(record);
      const childStdin = {
        on: () => {},
        end: (chunk?: string) => {
          record.stdin = chunk ?? "";
          respond(record, callback);
        },
      };
      return { stdin: childStdin };
    },
  );
  return {
    fn,
    calls,
    setShowOutput: (out: string) => {
      showOutput = out;
    },
    clear: () => {
      calls.length = 0;
      showOutput = "";
    },
  };
});

// Synchronous git seam: a non-stacked tree (branch probe empty, no stack node).
const mockSync = vi.hoisted(() =>
  vi.fn((file: string, args: readonly string[]) => {
    if (file === "git" && args[0] === "config") throw new Error("no such key");
    if (file === "git" && args[0] === "rev-parse") return "sha\n";
    return "";
  }),
);

// Quality gates shell out through `exec`; git change context uses the same seam.
const mockExec = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(new Error("pnpm not available in test environment"), { stdout: "", stderr: "" });
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: mockExec,
    execFile: mockExecFile.fn,
    execFileSync: mockSync,
    execSync: vi.fn(() => {
      throw new Error("execSync unavailable");
    }),
  };
});

// ── Harness ────────────────────────────────────────────────────────────

interface ToolLike {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

interface MockMessage {
  customType: string;
  content: string;
}

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, ToolLike>;
  messages: MockMessage[];
}

function createMockPi(): MockPi {
  const tools = new Map<string, ToolLike>();
  const messages: MockMessage[] = [];
  const api = {
    registerTool: (def: ToolLike) => {
      tools.set(def.name, def);
    },
    registerCommand: () => {},
    on: () => {},
    sendMessage: (msg: MockMessage) => {
      messages.push(msg);
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, tools, messages };
}

async function loadExtension(): Promise<(pi: ExtensionAPI) => void> {
  const mod = await import("../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

function makeCtx(cwd: string, sessionId: string) {
  return {
    cwd,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => sessionId },
  };
}

type Ctx = ReturnType<typeof makeCtx>;

function tool(tools: Map<string, ToolLike>, name: string): ToolLike {
  const found = tools.get(name);
  if (found === undefined) throw new Error(`${name} was not registered`);
  return found;
}

/** Wait for one phase run to settle so its background retries cannot leak. */
async function waitForRunComplete(messages: MockMessage[]): Promise<void> {
  await vi.waitFor(() => {
    expect(messages.some((msg) => msg.customType === "belayd-run-complete")).toBe(true);
  });
}

/** `bd <subcommand>` calls recorded on the execFile seam. */
function bdCalls(subcommand: string): ExecFileRecord[] {
  return mockExecFile.calls.filter((call) => call.file === "bd" && call.args[0] === subcommand);
}

/** A guide body that passes the userguide gate (sections + minimum length). */
const GUIDE_FILE_BODY = [
  "## How to Verify",
  "1. Run pnpm test",
  "",
  "## How to Use",
  "Call `record()` from the harness.",
  "x".repeat(200),
].join("\n");

// ── Tests ──────────────────────────────────────────────────────────────

describe("phase deliverables are authored bead comments (integration)", () => {
  let cwd: string;
  let pi: MockPi;
  let ctx: Ctx;
  // Extra worktrees created mid-test; removed with the fixture worktree.
  const scratchDirs: string[] = [];

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-deliverable-"));
    mockExecFile.clear();
    mockExec.mockClear();
    mockSync.mockClear();
    mockSpawn.clear();
    mockSpawn.reports.set("userguide", USERGUIDE_REPORT);
    mockSpawn.reports.set("proof-verifier", VERDICT);
    pi = createMockPi();
    const factory = await loadExtension();
    factory(pi.api);
    ctx = makeCtx(cwd, "deliverable-session");
  });

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes one authored comment per phase deliverable and no bead note", async () => {
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "bd-42-userguide.md"), GUIDE_FILE_BODY, "utf8");

    await tool(pi.tools, "belayd_start_task").execute(
      "start",
      { taskId: "bd-42", workflowType: "feature" },
      undefined,
      undefined,
      ctx,
    );

    await tool(pi.tools, "belayd_userguide").execute(
      "userguide",
      { task: "write the guide" },
      undefined,
      undefined,
      ctx,
    );
    await waitForRunComplete(pi.messages);

    await tool(pi.tools, "belayd_proof_verifier").execute(
      "verify",
      { task: "bd-42", proof: "proof-of-work/bd-42/demo.cast" },
      undefined,
      undefined,
      ctx,
    );

    mockExecFile.clear();
    const commit = (await tool(pi.tools, "belayd_commit").execute(
      "commit",
      { message: "feat: deliverable comments", taskId: "bd-42" },
      undefined,
      undefined,
      ctx,
    )) as { details: { exitCode: number } };
    expect(commit.details.exitCode).toBe(0);

    const comments = bdCalls("comment");
    // One entry per phase deliverable, both addressed at the bead via stdin.
    expect(comments.map((call) => call.args)).toEqual([
      ["comment", "--stdin", "--", "bd-42"],
      ["comment", "--stdin", "--", "bd-42"],
    ]);
    // Each entry names its authoring phase on the first line.
    expect(comments.map((call) => call.stdin.split("\n")[0])).toEqual([
      phaseCommentHeader("userguide"),
      phaseCommentHeader("proof-verifier"),
    ]);
    expect(comments[0]?.stdin.split("\n")[0]).toBe("[belayd:userguide]");
    expect(comments[1]?.stdin.split("\n")[0]).toBe("[belayd:proof-verifier]");

    // The userguide body is a pointer to the committed guide plus the report.
    const userguideBody = comments[0]?.stdin ?? "";
    expect(userguideBody).toContain("docs/bd-42-userguide.md");
    expect(userguideBody).toContain(USERGUIDE_REPORT);
    // The proof verdict travels verbatim under its own header.
    expect(comments[1]?.stdin).toBe(phaseCommentBody("proof-verifier", VERDICT));

    // Deliverables never fall back to the single notes blob.
    expect(bdCalls("note")).toEqual([]);
  });

  it("keeps the thread body's CRLF line endings verbatim", async () => {
    const crlfReport = [
      "## How to Verify",
      "1. Run pnpm test",
      "",
      "## How to Use",
      "See the doc.",
    ].join("\r\n");
    mockSpawn.reports.set("userguide", crlfReport);
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "bd-42-userguide.md"), GUIDE_FILE_BODY, "utf8");

    await tool(pi.tools, "belayd_start_task").execute(
      "start",
      { taskId: "bd-42", workflowType: "feature" },
      undefined,
      undefined,
      ctx,
    );
    await tool(pi.tools, "belayd_userguide").execute(
      "userguide",
      { task: "write the guide" },
      undefined,
      undefined,
      ctx,
    );
    await waitForRunComplete(pi.messages);

    mockExecFile.clear();
    await tool(pi.tools, "belayd_commit").execute(
      "commit",
      { message: "feat: crlf report", taskId: "bd-42" },
      undefined,
      undefined,
      ctx,
    );

    const comment = bdCalls("comment")[0];
    expect(comment).toBeDefined();
    const stdin = comment?.stdin ?? "";
    // The report is stored byte-for-byte after the header and the pointer: a
    // normalising writer would collapse these CRLF pairs into bare LFs and the
    // contiguous block below would no longer match. The quality-gate verdict the
    // harness appends afterwards is LF-only, so every CRLF pair in the body is
    // the phase's own.
    expect(stdin).toContain(crlfReport);
    const crlfCount = stdin.match(/\r\n/g)?.length ?? 0;
    expect(crlfCount).toBe(crlfReport.match(/\r\n/g)?.length ?? 0);
  });

  it("writes no deliverable comment when no phase produced content", async () => {
    await tool(pi.tools, "belayd_start_task").execute(
      "start",
      { taskId: "bd-42", workflowType: "feature" },
      undefined,
      undefined,
      ctx,
    );

    mockExecFile.clear();
    const commit = (await tool(pi.tools, "belayd_commit").execute(
      "commit",
      { message: "feat: nothing to record", taskId: "bd-42" },
      undefined,
      undefined,
      ctx,
    )) as { details: { exitCode: number } };
    expect(commit.details.exitCode).toBe(0);

    // The human-review flag still lands, so the absence below is "no content",
    // not "the commit slot never ran".
    expect(bdCalls("update").length).toBeGreaterThanOrEqual(1);
    expect(bdCalls("comment")).toEqual([]);
    expect(bdCalls("note")).toEqual([]);
  });

  /** A fresh worktree that is removed with the test's fixture worktree. */
  function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "belayd-deliverable-"));
    scratchDirs.push(dir);
    return dir;
  }

  /** Run one implement phase and return its first spawn task. */
  async function implementTask(options: {
    showOutput: string;
    sessionId: string;
    runCwd: string;
  }): Promise<string> {
    mockExecFile.setShowOutput(options.showOutput);
    mockSpawn.clear();
    const implPi = createMockPi();
    const factory = await loadExtension();
    factory(implPi.api);
    const implCtx = makeCtx(options.runCwd, options.sessionId);

    await tool(implPi.tools, "belayd_start_task").execute(
      "start",
      { taskId: "bd-42", workflowType: "feature" },
      undefined,
      undefined,
      implCtx,
    );
    await tool(implPi.tools, "belayd_implement").execute(
      "implement",
      { task: "implement the plan" },
      undefined,
      undefined,
      implCtx,
    );
    await waitForRunComplete(implPi.messages);

    const first = mockSpawn.calls[0];
    expect(first).toBeDefined();
    const task = first?.task;
    expect(typeof task).toBe("string");
    return typeof task === "string" ? task : "";
  }

  it("bounds the implement prompt by the plan, not the comment thread", async () => {
    const threadLine = "  THREAD-CHUNK a deliverable that must never reach a prompt";
    const hugeThread = Array.from({ length: 2000 }, () => threadLine).join("\n");
    const plan = "DESCRIPTION\n\n  Plan text here.\n";
    const withShortThread = `${plan}\nCOMMENTS\n  2026-10-26 10:00 Hugo\n\n      [belayd:userguide]\n`;
    const withHugeThread = `${plan}\nCOMMENTS\n${hugeThread}\n`;

    const shortTask = await implementTask({
      showOutput: withShortThread,
      sessionId: "bounded-short",
      runCwd: scratchDir(),
    });
    const hugeTask = await implementTask({
      showOutput: withHugeThread,
      sessionId: "bounded-huge",
      runCwd: scratchDir(),
    });

    expect(shortTask).toContain("Plan text here.");
    expect(hugeTask).toContain("Plan text here.");
    // The 2000-line thread adds nothing to the prompt beyond formatting noise.
    expect(hugeTask).not.toContain("THREAD-CHUNK");
    expect(hugeTask.length - shortTask.length).toBeLessThan(1024);
    // Sanity: the discarded thread alone is two orders of magnitude larger.
    expect(withHugeThread.length).toBeGreaterThan(100_000);
  });

  it("keeps no phase deliverable on the bd note path", () => {
    const extensionSource = readFileSync(join(REPO_ROOT, "extensions", "index.ts"), "utf8");

    // The only deliverable writer is appendPhaseDeliverables -> bd comment.
    expect(extensionSource).not.toContain('["note", "--stdin"');
    expect(extensionSource).toContain('["comment", "--stdin", "--"');
    // The research prompt is prose-authored, so its instruction is the contract.
    expect(RESEARCHER_SYSTEM_PROMPT).toContain(phaseCommentHeader("research"));
    expect(RESEARCHER_SYSTEM_PROMPT).toContain("comment <task-id> --stdin");
    expect(RESEARCHER_SYSTEM_PROMPT).not.toContain("note <task-id> --stdin");
  });
});
