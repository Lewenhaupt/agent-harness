/**
 * Tests for the /belayd command's session-daemon delegation.
 *
 * Regression coverage: the session daemon scopes every per-session route by
 * cwd, so the `/sessions/:id/prompt` POST must include `cwd` in its body.
 * Without it the daemon rejects the request and pi surfaces:
 *   Extension "command:belayd" error: cwd field must be a string
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the extension's persistent cooldown store from the real user file.
process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

// ── Mocks ──────────────────────────────────────────────────────────────

// Shared with the hoisted mocks; the worktree path is created per-test.
const state = vi.hoisted(() => ({ worktreeDir: "" }));

// `bd show` lookups fail (no bd CLI in tests) → workflow falls back to "feature".
const mockExec = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(new Error("bd not available"), { stdout: "", stderr: "" });
    },
  ),
);

// `git worktree list --porcelain` must resolve to the temp worktree dir;
// every other call throws so `isInsideWorktreeForBranch` reports false.
const mockExecSync = vi.hoisted(() =>
  vi.fn((cmd: string) => {
    if (cmd === "git worktree list --porcelain") {
      return (
        `worktree ${state.worktreeDir}\n` +
        "HEAD 0000000000000000000000000000000000000000\n" +
        "branch refs/heads/feat/bd-42\n"
      );
    }
    throw new Error(`mock execSync: ${cmd}`);
  }),
);

// `git branch --list` returns empty (branch does not exist); `wt switch` succeeds.
const mockExecFileSync = vi.hoisted(() => vi.fn(() => ""));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: mockExec,
    execSync: mockExecSync,
    execFileSync: mockExecFileSync,
  };
});

// Capture daemon HTTP requests so the prompt body can be asserted on.
const httpCalls = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  return {
    calls,
    clear: () => {
      calls.length = 0;
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
      // Session creation returns an id; every other route returns an empty body.
      const statusCode = 200;
      let data = "{}";
      if (opts.method === "POST" && opts.path === "/sessions") {
        data = JSON.stringify({ id: "sess-123" });
      }
      callback({
        statusCode,
        on: vi.fn((event: string, handler: (chunk: string) => void) => {
          if (event === "data") handler(data);
          if (event === "end") handler("");
        }),
      });
      return {
        on: vi.fn(),
        write: vi.fn((body: string) => {
          httpCalls.calls.push({ method: opts.method ?? "", path: opts.path ?? "", body });
        }),
        end: vi.fn(),
      };
    },
  ),
);

vi.mock("node:http", () => ({ request: mockHttpRequest }));

// ── Helpers ────────────────────────────────────────────────────────────

function createMockPi(): {
  api: ExtensionAPI;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
} {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();

  const api: ExtensionAPI = {
    registerTool: () => {},
    registerCommand: (
      name: string,
      cmd: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, cmd);
    },
    on: () => {},
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    // The harness factory probes `pi.events` to dedupe duplicate copies; a
    // no-op bus makes the single mock the first (and only) registration.
    events: {
      emit: () => {},
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;

  return { api, commands };
}

async function loadExtension() {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("/belayd command daemon delegation", () => {
  let worktreeDir: string;

  beforeEach(() => {
    worktreeDir = mkdtempSync(join(tmpdir(), "belayd-cmd-test-"));
    state.worktreeDir = worktreeDir;
    // Simulate a completed dependency install so awaitWorktreeReady resolves
    // immediately instead of polling until the test times out.
    mkdirSync(join(worktreeDir, "node_modules"));
    writeFileSync(join(worktreeDir, "node_modules", ".modules.yaml"), "");
  });

  afterEach(() => {
    rmSync(worktreeDir, { recursive: true, force: true });
    mockExec.mockClear();
    mockExecSync.mockClear();
    mockExecFileSync.mockClear();
    mockHttpRequest.mockClear();
    httpCalls.clear();
  });

  it("includes cwd in the /sessions/:id/prompt request body", async () => {
    const { api, commands } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const belayd = commands.get("belayd");
    expect(belayd).toBeDefined();

    const notify = vi.fn();
    const ctx = {
      cwd: worktreeDir,
      ui: { notify },
      sessionManager: { getSessionId: () => "test-session" },
    };

    await belayd?.handler("bd-42", ctx);

    // The worktree was created and the orchestrator session delegated to the
    // daemon; the prompt route must carry cwd so the daemon can scope it.
    const promptCall = httpCalls.calls.find((call) => call.path === "/sessions/sess-123/prompt");
    expect(promptCall).toBeDefined();

    const body = JSON.parse(promptCall?.body ?? "{}") as { cwd?: string; text?: string };
    expect(body.cwd).toBe(worktreeDir);
    expect(body.text).toContain("Belayd feature workflow");
  });
});
