/**
 * Extension test for the bd-58 proof-base cache invariant.
 *
 * `preparePhaseProof` (spawn path) and `proofDirForActiveTask` (verifier path)
 * must agree on one proof base per task. We mock the git-backed
 * `resolveProjectProofBase` seam: the spawn path resolves it once (ok), after
 * which the seam starts failing as a transient git outage. The verifier path
 * must reuse the cached base — a second resolver call (which would fall back to
 * the global base) reintroduces the cross-project collision this cache fixes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the extension's persistent cooldown store and proof root from the
// real user directories; both are read when the extension module loads below.
process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-pbc-cooldowns.json");
process.env.BELAYD_PROOF_DIR = join(tmpdir(), "belayd-test-pbc-global-proof");

const mockResolveProjectProofBase = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: mockExec };
});

// Replace only the git-backed base resolution; bridge and path helpers stay real.
vi.mock("../../src/proof-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/proof-dir.js")>();
  return { ...actual, resolveProjectProofBase: mockResolveProjectProofBase };
});

const mockSpawnAgentWithFallback = vi.hoisted(() => vi.fn());

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return { ...actual, spawnAgentWithFallback: mockSpawnAgentWithFallback };
});

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
}

function createMockPi(): {
  api: ExtensionAPI;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  tools: Map<string, RegisteredTool>;
} {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools = new Map<string, RegisteredTool>();

  const api: ExtensionAPI = {
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
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
    events: {
      emit: () => {},
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;

  return { api, commands, tools };
}

async function loadExtension() {
  const mod = await import("../../extensions/index.js");
  return mod.default as (pi: ExtensionAPI) => void;
}

/** A successful spawn result shaped like the real SpawnWithFallbackResult. */
function fallbackResult(model: string): {
  result: {
    content: Array<{ type: "text"; text: string }>;
    details: { messages: unknown[]; usage: unknown; exitCode: number; model: string };
  };
  attempts: Array<{ model: string; classification: { kind: string } }>;
} {
  return {
    result: {
      content: [{ type: "text", text: `agent output for ${model}` }],
      details: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: 0,
        model,
      },
    },
    attempts: [{ model, classification: { kind: "success" } }],
  };
}

function makeCtx(
  sessionId: string,
  cwd: string,
): {
  sessionManager: { getSessionId: () => string };
  cwd: string;
  ui: { notify: () => void };
} {
  return { sessionManager: { getSessionId: () => sessionId }, cwd, ui: { notify: () => {} } };
}

describe("proof base cache (bd-58)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "belayd-pbc-test-"));
    mockResolveProjectProofBase.mockReset();
    mockExec.mockReset();
    // git and bd are unavailable in tests; both degrade gracefully.
    mockExec.mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => cb(new Error("git unavailable"), { stdout: "", stderr: "" }),
    );
    mockSpawnAgentWithFallback.mockReset();
    mockSpawnAgentWithFallback.mockImplementation((options: { model: string }) =>
      Promise.resolve(fallbackResult(options.model)),
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    mockExec.mockClear();
  });

  it("reuses the spawn-path proof base for the verifier without re-deriving it", async () => {
    // Nested under workDir so the afterEach cleanup covers it.
    const namespacedBase = join(workDir, "namespaced-proof");
    let resolveCalls = 0;
    mockResolveProjectProofBase.mockImplementation(() => {
      resolveCalls += 1;
      if (resolveCalls === 1) return { ok: true, base: namespacedBase };
      return { ok: false, error: "transient git failure" };
    });

    // The artifact lives only under the namespaced base. If the verifier-safe
    // path re-derived (and fell back to the global base) this file would be
    // invisible and extraction would report it as not found.
    const proofDir = join(namespacedBase, "bd-42");
    mkdirSync(proofDir, { recursive: true });
    const cast = [
      JSON.stringify({ version: 3, command: "NAMESPACED-CAST-MARKER" }),
      JSON.stringify([0.0, "o", "ok\n"]),
      JSON.stringify([1.0, "x", "0"]),
    ].join("\n");
    writeFileSync(join(proofDir, "evidence.cast"), cast, "utf-8");

    const { api, commands, tools } = createMockPi();
    const factory = await loadExtension();
    factory(api);

    const ctx = makeCtx("pbc-1", workDir);
    await commands.get("belayd")?.handler("bd-42 feature --no-worktree", ctx);

    // Spawn path: resolves and caches the namespaced base.
    const scout = tools.get("belayd_scout");
    expect(scout).toBeDefined();
    await scout?.execute("call-1", { task: "recon" }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(mockSpawnAgentWithFallback).toHaveBeenCalledTimes(1));

    const spawnOptions = mockSpawnAgentWithFallback.mock.calls[0]?.[0] as
      | { env?: Record<string, string> }
      | undefined;
    expect(spawnOptions?.env?.BELAYD_PROOF_TASK_DIR).toBe(namespacedBase);

    // Verifier path: the seam now fails, so any re-derivation would fall back
    // to the global base. The cache must keep the resolver at one call.
    const verifier = tools.get("belayd_proof_verifier");
    expect(verifier).toBeDefined();
    await verifier?.execute(
      "call-2",
      { task: "bd-42", proof: "Proof recording: proof-of-work/bd-42/evidence.cast" },
      undefined,
      undefined,
      ctx,
    );

    // Exactly one derivation: the verifier reused the cached namespaced base.
    expect(mockResolveProjectProofBase).toHaveBeenCalledTimes(1);
    const verifierCall = mockSpawnAgentWithFallback.mock.calls.find((call) =>
      String((call[0] as { sessionName?: string }).sessionName).startsWith(
        "belayd-proof-verifier-",
      ),
    );
    expect(verifierCall).toBeDefined();
    expect(String((verifierCall?.[0] as { task?: string }).task)).toContain(
      "NAMESPACED-CAST-MARKER",
    );
  });
});
