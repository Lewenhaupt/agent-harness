/**
 * Proof capability: proof dirs, receipt resolution and the advisory
 * `belayd_proof_verifier` tool (bd-179).
 *
 * The verifier is the piece the durable-member runtime needs without extension
 * globals, so it lives here with an explicitly typed dependency object instead
 * of reaching into the composer's session state.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { PROOF_VERIFIER_AGENT, PROOF_VERIFIER_TOOLS } from "../../src/agent-registry.js";
import type { CapacityCache } from "../../src/capacity-cache.js";
import { resolveModelSpec } from "../../src/model-classes.js";
import type { ModelCooldownStore } from "../../src/model-cooldown.js";
import type { ModelTelemetryStore } from "../../src/model-telemetry.js";
import type { OwnedWorktreeResult } from "../../src/owned-worktree.js";
import {
  ensureProofBridge,
  proofDirForTask,
  resolveProjectProofBase,
  resolveProofBase,
} from "../../src/proof-dir.js";
import {
  acceptedProofRefsFromScan,
  buildVerifierPrompt,
  collectChangeContext,
  extractProofArtifacts,
  findWorkspaceRoot,
  scanProofRefs,
} from "../../src/proof-verification.js";
import { userGuideDocPath } from "../../src/quality-gates.js";
import { generateShortRunId } from "../../src/session-naming.js";
import type { SpawnWithFallbackOptions } from "../../src/spawn-with-fallback.js";
import {
  type CoreSessionState,
  emptyUsage,
  missingWorkingDirectoryError,
  textToolResult,
} from "./context.js";

/**
 * Proof paths work on the fleet-free core state; the composer passes the full
 * `SessionState` intersection, which is assignable to it.
 */
export type ProofSessionState = CoreSessionState;

/** Model-routing seams the composer owns (bd-116 session state). */
export interface ProofModelRouting {
  cooldownStore: ModelCooldownStore;
  enabled: boolean;
  telemetry: ModelTelemetryStore;
  capacity: CapacityCache;
}

/** Everything the proof capability needs from the composer. */
export interface ProofDeps {
  /** Session reader; the aggregate state lives in the composer. */
  getSessionState: (ctx: { sessionManager: { getSessionId: () => string } }) => ProofSessionState;
  /** Worktree ownership preflight for the session's active workflow. */
  activeWorkflowOwnership: (state: CoreSessionState, cwd: string) => OwnedWorktreeResult;
  /** Injected because the extension test suite swaps it through the barrel mock. */
  spawnAgentWithFallback: (options: SpawnWithFallbackOptions) => Promise<{
    result: { content?: readonly { text?: string }[] };
  }>;
  modelRouting: ProofModelRouting;
}

/**
 * User-guide markdown used as functional context for the proof verifier.
 *
 * The phase deliverable lives on disk, so read it there; a session recovered
 * from an older capture (or a run whose file was never written) falls back to
 * the in-session text.
 */
export function readUserGuideForContext(options: {
  cwd: string;
  taskId: string;
  captured: string | undefined;
}): string | undefined {
  if (options.taskId !== "") {
    try {
      const content = readFileSync(resolve(options.cwd, userGuideDocPath(options.taskId)), "utf8");
      if (content.trim() !== "") return content;
    } catch {
      // No deliverable on disk — fall through to the captured text.
    }
  }
  return options.captured;
}

/**
 * Project-scoped proof base, falling back to the global base when the git
 * project key cannot be derived so proof handling never blocks a phase.
 */
export function resolveProjectProofBaseOrGlobal(env: NodeJS.ProcessEnv, cwd: string): string {
  const projectBase = resolveProjectProofBase(env, cwd);
  if (projectBase.ok) return projectBase.base;
  console.warn(
    `[belayd-harness] proof base project namespacing failed, using global base: ${projectBase.error}`,
  );
  return resolveProofBase(env);
}

/**
 * Prepare the phase proof env and per-task dir and ensure the bridge symlink.
 *
 * Proof artifacts live outside the worktree. The bridge symlink exposes them
 * at proof-of-work/ while the agent writes through BELAYD_PROOF_TASK_DIR
 * (the proof base; the agent creates the task-id subdirectory inside it).
 * The base is namespaced per project so identical task IDs in different
 * repos never collide; a key-derivation failure falls back to the global base
 * so it never blocks a phase.
 */
export function preparePhaseProof(
  state: ProofSessionState,
  cwd: string,
): {
  proofDir: string | undefined;
  spawnEnv: { BELAYD_PROOF_TASK_DIR: string } | undefined;
} {
  if (state.currentTaskId === "") {
    return { proofDir: undefined, spawnEnv: undefined };
  }
  const proofBase = resolveProjectProofBaseOrGlobal(process.env, cwd);
  // Cache unconditionally (namespaced result or global fallback) so the
  // verifier path reuses the exact base the spawn path selected; a later git
  // failure must not silently shift the verifier to a different base.
  state.proofBase = proofBase;
  const bridgeResult = ensureProofBridge(cwd, proofBase);
  if (!bridgeResult.ok) {
    console.warn(`[belayd-harness] proof-of-work bridge unavailable: ${bridgeResult.error}`);
  }
  return {
    proofDir: proofDirForTask(state.currentTaskId, proofBase),
    spawnEnv: { BELAYD_PROOF_TASK_DIR: proofBase },
  };
}

/** Per-task proof dir, or undefined when no task is active. */
export function proofDirForActiveTask(state: ProofSessionState, cwd: string): string | undefined {
  if (state.currentTaskId === "") return undefined;
  // Reuse the base the spawn path already resolved. Only a state restored
  // from a persisted manifest (no cached base) derives and caches it here.
  let proofBase = state.proofBase;
  if (proofBase === undefined) {
    proofBase = resolveProjectProofBaseOrGlobal(process.env, cwd);
    state.proofBase = proofBase;
  }
  return proofDirForTask(state.currentTaskId, proofBase);
}

/** Assemble the verifier prompt from proof output and change context. */
export async function buildProofVerifierPrompt(options: {
  params: { task?: string; proof?: string };
  state: ProofSessionState;
  cwd: string;
}): Promise<{ prompt: string; cwd: string; skipped: boolean }> {
  const { params, state, cwd } = options;
  const taskText = params.task ?? state.currentTaskId;
  const proofOutput = params.proof ?? state.proofOutput ?? "";
  const changeContext = await collectChangeContext(
    cwd,
    readUserGuideForContext({
      cwd,
      taskId: state.currentTaskId,
      captured: state.userGuideContent,
    }),
  );
  // A single scan classifies canonical refs without the proof base, so the
  // early return below skips before any git-backed base derivation. Raw
  // absolute candidates are carried forward and normalized once the base is
  // known instead of scanning the output a second time.
  const scan = scanProofRefs(proofOutput);

  if (scan.accepted.length === 0 && changeContext === "") {
    return { prompt: "", cwd, skipped: true };
  }

  const proofDir = proofDirForActiveTask(state, cwd);
  // Accept absolute proof-dir paths here too, so the advisory verifier sees the
  // same artifacts the deterministic gate accepts.
  const refs = acceptedProofRefsFromScan(scan, proofDir);
  const proofWorkRoot = findWorkspaceRoot(cwd);
  const extraction = await extractProofArtifacts(refs, proofWorkRoot, proofDir);
  const artifacts = extraction.ok ? extraction.artifacts : [];
  const prompt = buildVerifierPrompt({
    taskText,
    changeContext,
    proofOutput: extraction.ok
      ? proofOutput
      : `${proofOutput}\n\n(artifact extraction skipped: ${extraction.error})`,
    artifacts,
  });
  return { prompt, cwd, skipped: false };
}

/** Run the verifier judge; every path returns a non-blocking verdict. */
export async function runProofVerifier(options: {
  prompt: string;
  cwd: string;
  state: ProofSessionState;
  deps: ProofDeps;
  signal?: AbortSignal;
}): Promise<{ text: string }> {
  const { prompt, cwd, state, deps, signal } = options;
  const runId = generateShortRunId();
  const sessionName = `belayd-proof-verifier-${runId}`;
  try {
    const result = await deps.spawnAgentWithFallback({
      model: resolveModelSpec(PROOF_VERIFIER_AGENT).model,
      modelClass: PROOF_VERIFIER_AGENT.modelClass,
      tools: PROOF_VERIFIER_TOOLS,
      systemPrompt: PROOF_VERIFIER_AGENT.systemPrompt,
      task: prompt,
      sessionName,
      cwd,
      signal,
      // detached: false blocks the orchestrator turn on purpose: the verdict
      // must be synchronously available for the response that returns it.
      detached: false,
      cooldownStore: deps.modelRouting.cooldownStore,
      enabled: deps.modelRouting.enabled,
      phase: "proof-verifier",
      telemetry: deps.modelRouting.telemetry,
      capacity: deps.modelRouting.capacity,
    });
    const text = result.result.content?.[0]?.text ?? "Proof verifier produced no output.";
    state.proofVerifierVerdict = text;
    return { text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const advisory = [
      "## Verdict",
      "reasonable: false",
      `reason: proof verifier could not run (${message})`,
      "evidence: none",
    ].join("\n");
    state.proofVerifierVerdict = advisory;
    return { text: advisory };
  }
}

/** Register `belayd_proof_verifier`; the composer supplies the pi API. */
export function registerProof(pi: ExtensionAPI, deps: ProofDeps): void {
  pi.registerTool({
    name: "belayd_proof_verifier",
    label: "Proof verifier",
    description:
      "Advisory, non-blocking review of proof relevance and plausibility. " +
      "Runs a read-only judge over the proof phase output and records a verdict.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "The task the proof should demonstrate" })),
      proof: Type.Optional(Type.String({ description: "Optional proof output override" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const state = deps.getSessionState(ctx);
      const cwd = ctx.cwd;
      if (cwd === undefined || cwd === "") {
        return textToolResult(missingWorkingDirectoryError("Proof verifier"), 1);
      }
      const ownership = deps.activeWorkflowOwnership(state, cwd);
      if (!ownership.ok) {
        return textToolResult(ownership.error, 1);
      }
      const built = await buildProofVerifierPrompt({ params, state, cwd });
      if (built.skipped) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Proof verifier skipped: no proof artifacts referenced and no change context available.",
            },
          ],
          details: { messages: [], usage: emptyUsage(), exitCode: 0 },
        };
      }
      const verdict = await runProofVerifier({
        prompt: built.prompt,
        cwd: built.cwd,
        state,
        deps,
        signal,
      });
      return {
        content: [{ type: "text" as const, text: verdict.text }],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });
}
