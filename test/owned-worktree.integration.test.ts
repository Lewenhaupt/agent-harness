/**
 * End-to-end worktree ownership preflight (bd-119).
 *
 * Builds two real linked worktrees and drives the extension's phase tool: a
 * session whose workflow owns A must refuse to run a phase against B, and
 * neither tree may be modified by the rejected call.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertOwnedWorktree,
  getPhasesForType,
  readWorktreeBranch,
  writeWorkflowState,
} from "../src/index.js";
import { gitContextFreeEnv } from "../src/worktree.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-owned-integration-cooldowns.json");
process.env.BELAYD_PROOF_DIR = join(tmpdir(), "belayd-owned-integration-proof");

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    env: gitContextFreeEnv(),
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(["add", "."], cwd);
  git(["commit", "-qm", message], cwd);
}

function seedWorkflow(cwd: string, taskId: string, branch: string): void {
  const now = Date.now();
  const result = writeWorkflowState({
    cwd,
    state: {
      schemaVersion: 1,
      taskId,
      workflowType: "feature",
      branch,
      originalCwd: cwd,
      phaseOrder: getPhasesForType("feature"),
      completedPhaseNames: [],
      startedAt: now,
      updatedAt: now,
    },
  });
  expect(result).toEqual({ ok: true });
}

/** Run manifests are gitignored, so inspect `.belayd/runs` directly. */
function runManifests(cwd: string): string[] {
  const runsDir = join(cwd, ".belayd", "runs");
  return existsSync(runsDir) ? readdirSync(runsDir) : [];
}

interface ToolResult {
  content: Array<{ text: string }>;
  details: { exitCode: number };
}

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<ToolResult>;
}

type ExtensionHandler = (event: unknown, ctx: unknown) => unknown;

function createMockPi(): {
  api: ExtensionAPI;
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, ExtensionHandler[]>;
} {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, ExtensionHandler[]>();

  const api = {
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => {},
    on: (event: string, handler: ExtensionHandler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: {
      emit: () => {},
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;

  return { api, tools, handlers };
}

function makeCtx(sessionId: string, cwd: string) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => `belayd-${sessionId}`,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    },
    cwd,
    ui: { notify: () => {} },
  };
}

describe("owned worktree preflight (integration)", () => {
  let repo: string;
  let worktreeA: string;
  let worktreeB: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "belayd-owned-"));
    worktreeA = `${repo}-a`;
    worktreeB = `${repo}-b`;

    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "test@example.com"], repo);
    git(["config", "user.name", "Test"], repo);
    commit(repo, ".gitignore", ".belayd/\n", "base");
    git(["worktree", "add", "-q", "-b", "feat/bd-a", worktreeA, "main"], repo);
    git(["worktree", "add", "-q", "-b", "feat/bd-b", worktreeB, "main"], repo);

    seedWorkflow(worktreeA, "bd-a", "feat/bd-a");
    seedWorkflow(worktreeB, "bd-b", "feat/bd-b");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreeA, { recursive: true, force: true });
    rmSync(worktreeB, { recursive: true, force: true });
  });

  it("matches the owning worktree and real branch", () => {
    expect(
      assertOwnedWorktree({
        cwd: worktreeA,
        taskId: "bd-a",
        branch: readWorktreeBranch(worktreeA),
      }),
    ).toEqual({ ok: true, branch: "feat/bd-a" });
  });

  it("rejects a session that owns A when it points a phase at B, leaving both trees clean", async () => {
    const mod = await import("../extensions/index.js");
    const { api, tools, handlers } = createMockPi();
    (mod.default as (pi: ExtensionAPI) => void)(api);

    const ctxA = makeCtx("owned-integration", worktreeA);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, ctxA);
    }

    const implement = tools.get("belayd_implement");
    expect(implement).toBeDefined();

    const result = await implement?.execute(
      "call-1",
      { task: "run the phase in the wrong worktree" },
      undefined,
      undefined,
      { ...ctxA, cwd: worktreeB },
    );

    expect(result?.details.exitCode).toBe(1);
    expect(result?.content[0]?.text).toContain("bd-b lives in");
    expect(result?.content[0]?.text).toContain("bd-a");
    expect(result?.content[0]?.text).toContain("bd-b");
    expect(result?.content[0]?.text).toContain("owns bd-a's worktree");

    expect(git(["status", "--porcelain"], worktreeA)).toBe("");
    expect(git(["status", "--porcelain"], worktreeB)).toBe("");
    expect(runManifests(worktreeA)).toEqual([]);
    expect(runManifests(worktreeB)).toEqual([]);
  });

  it("refuses a session with no active task in another task's live worktree", async () => {
    const mod = await import("../extensions/index.js");
    const { api, tools } = createMockPi();
    (mod.default as (pi: ExtensionAPI) => void)(api);

    const implement = tools.get("belayd_implement");
    const result = await implement?.execute(
      "call-no-task",
      { task: "run without owning this tree" },
      undefined,
      undefined,
      makeCtx("owned-integration-no-task", worktreeA),
    );

    expect(result?.details.exitCode).toBe(1);
    expect(result?.content[0]?.text).toContain("bd-a owns");
    expect(result?.content[0]?.text).toContain("start bd-a");
    expect(runManifests(worktreeA)).toEqual([]);
  });
});
