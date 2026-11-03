/**
 * Quality-gate runner — the retry loop around a phase's deterministic gates.
 *
 * Split out of `extensions/index.ts` (bd-179) so the process core is callable
 * without extension globals: the composer supplies the spawn, model-routing,
 * metrics and phase-name seams explicitly, and nothing here imports
 * `process-gate.ts`.
 */
import type { AgentDefinition, QualityGate, SpawnResult } from "./agent-registry.js";
import type { CapacityCache } from "./capacity-cache.js";
import { type ModelClass, resolveModelSpec } from "./model-classes.js";
import type { ModelCooldownStore } from "./model-cooldown.js";
import type { ModelTelemetryStore } from "./model-telemetry.js";
import { gateRetrySession } from "./session-naming.js";
import type {
  RunModelSelection,
  SpawnAttempt,
  SpawnWithFallbackOptions,
} from "./spawn-with-fallback.js";
import type { Phase } from "./workflow-phases.js";
import {
  resolveQualityGate,
  WORKFLOW_REGISTRY,
  type WorkflowSubType,
} from "./workflow-registry.js";

/** One gate attempt, reported to the composer's metrics log. */
export interface GateAttemptEvent {
  taskId: string | undefined;
  phase: string;
  runId: string;
  attempt: number;
  passed: boolean;
  durationMs: number;
  failureKind?: string;
}

/** Model-routing seams the composer owns (bd-116 session state). */
export interface QualityGateRouting {
  cooldownStore: ModelCooldownStore;
  enabled: boolean;
  telemetry: ModelTelemetryStore;
  capacity: CapacityCache;
}

/** Everything the gate runner needs from its host. */
export interface QualityGateRunnerDeps {
  spawnAgentWithFallback: (options: SpawnWithFallbackOptions) => Promise<{
    result: SpawnResult;
    attempts: SpawnAttempt[];
    /** Derived by the spawn layer; absent on narrower test seams. */
    selection?: RunModelSelection;
  }>;
  routing: QualityGateRouting;
  /** Metrics sink for one attempt; the composer wires this to the metrics log. */
  recordAttempt: (event: GateAttemptEvent) => void;
  /** Gate primitive injected by the composer (never imported from process-gate). */
  isKnownPhase: (phaseName: string) => phaseName is Phase;
}

/** Inputs for one quality-gate evaluation + retry run. */
export interface RunQualityGateOptions {
  agent: AgentDefinition;
  result: SpawnResult;
  task: string;
  workflowType: WorkflowSubType;
  phaseName: string;
  cwd?: string;
  proofDir?: string;
  /** Epoch ms when this phase run's spawn started (proof-gate freshness floor). */
  proofRunStartMs?: number;
  /**
   * Worktree-relative userguide deliverable, set for the userguide phase so the
   * gate validates the file the phase was told to write.
   */
  userGuidePath?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  model?: string;
  modelClass?: ModelClass;
  tools?: string[];
  sessionName?: string;
  /** Telemetry sink for gate-retry spawns; defaults to the workflow store. */
  telemetry?: ModelTelemetryStore;
  /** Task id for the metrics log; omitted for gate checks outside a workflow. */
  taskId?: string;
  /** Run id the gate verdict belongs to; emitted as `gate_result.runId`. */
  runId: string;
  /**
   * Receives each gate-retry spawn's selection, so the caller can fold it into
   * the run manifest (the retry may be served by a different candidate than the
   * phase's own spawn). Called once per retry, in order.
   */
  onSelection?: (selection: RunModelSelection) => void;
}

/** Maximum number of agent passes over the quality gate (1 initial + retries). */
const MAX_GATE_ATTEMPTS = 10;

/** Append a quality-gate verdict to an agent result. */
function withGateResult(result: SpawnResult, header: string, feedback: string): SpawnResult {
  const existingContent = result.content?.[0]?.text ?? "";
  return {
    content: [{ type: "text" as const, text: `${existingContent}\n\n---\n${header}\n${feedback}` }],
    details: result.details,
  };
}

/** Surface a model fallback (if any) as a trailing note on the agent result. */
export function withFallbackNote(result: SpawnResult, attempts: SpawnAttempt[]): SpawnResult {
  if (attempts.length <= 1) return result;
  const trail = attempts
    .map((a) => {
      if (a.skippedCooldown) return `${a.model} (cooldown)`;
      if (a.skippedProvider) return `${a.model} (provider ${a.skippedProvider} exhausted)`;
      if (a.skippedCapacity) return `${a.model} (provider ${a.skippedCapacity} capacity-exhausted)`;
      return `${a.model} (${a.classification.kind})`;
    })
    .join(" → ");
  const existingContent = result.content?.[0]?.text ?? "";
  return {
    ...result,
    content: [
      { type: "text" as const, text: `${existingContent}\n\n[belayd model fallback] ${trail}` },
    ],
  };
}

/** Options for one quality-gate fix-up attempt. */
interface GateRetryOptions {
  cwd?: string;
  signal?: AbortSignal;
  model?: string;
  modelClass?: ModelClass;
  tools?: string[];
  sessionName?: string;
  attempt: number;
  env?: Record<string, string>;
  /** Phase name for telemetry grouping. */
  phaseName: string;
  /** Telemetry sink for this run; defaults to the workflow store. */
  telemetry?: ModelTelemetryStore;
  /** Called with the retry spawn's selection (see `RunQualityGateOptions`). */
  onSelection?: (selection: RunModelSelection) => void;
  /** The phase's original task prompt, prepended on a fresh epoch. */
  originalTask: string;
  /** Every gate verdict so far, oldest first. */
  feedbackHistory: readonly string[];
}

/**
 * Spawn a single fix-up attempt for a failed quality gate.
 *
 * The session/epoch decision comes from `gateRetrySession`: the first two
 * retries resume the initial session, later two-attempt epochs resume a
 * freshly-minted `-retry-<n>` session. A fresh epoch never sees the prior
 * transcript, so it also gets the original task plus every gate verdict.
 */
function spawnGateRetry(
  agent: AgentDefinition,
  options: GateRetryOptions,
  deps: QualityGateRunnerDeps,
): Promise<SpawnResult> {
  const retry =
    options.sessionName !== undefined
      ? gateRetrySession(options.sessionName, options.attempt)
      : undefined;
  const resumeSession = retry?.resumeSession ?? false;
  const latestFeedback = options.feedbackHistory.at(-1) ?? "";
  const retryNote = `Previous attempt failed quality gate:\n${latestFeedback}\n\nFix the issues and retry.`;
  // A resumed session already carries the system prompt in its transcript, so
  // re-appending it would duplicate it. A fresh epoch needs it as usual.
  const systemPrompt = resumeSession ? "" : agent.systemPrompt;
  let task = retryNote;
  if (!resumeSession) {
    // A fresh epoch has no transcript, so it needs the original task plus
    // every gate verdict seen so far (resumed retries only need the latest).
    const previousFailures = options.feedbackHistory.join("\n---\n");
    task = `## Original task\n${options.originalTask}\n\n## Previous quality-gate failures\n${previousFailures}\n\nFix the issues and retry.`;
  }
  return deps
    .spawnAgentWithFallback({
      model: options.model ?? resolveModelSpec(agent).model,
      modelClass: options.modelClass,
      tools: options.tools ?? agent.tools,
      systemPrompt,
      task,
      cwd: options.cwd,
      signal: options.signal,
      detached: true,
      env: options.env,
      sessionName: retry?.sessionName,
      resumeSession,
      cooldownStore: deps.routing.cooldownStore,
      enabled: deps.routing.enabled,
      phase: options.phaseName,
      telemetry: options.telemetry ?? deps.routing.telemetry,
      capacity: deps.routing.capacity,
    })
    .then((r) => {
      // The retry has its own attempt trail: a gate fix-up that skipped a cooling
      // provider must say so in the delivery and in the manifest, not just in the
      // phase spawn's record.
      if (r.selection !== undefined) options.onSelection?.(r.selection);
      return withFallbackNote(r.result, r.attempts);
    });
}

/**
 * Classify a gate failure from its feedback text.
 *
 * The combined gates emit `### <check>` headings, so the failing check is
 * recoverable without a new return type. Metrics only needs a short label — the
 * full feedback stays in the run delivery.
 */
export function gateFailureKind(feedback: string | undefined): string | undefined {
  if (feedback === undefined || feedback === "") return undefined;
  const match = /^###\s+([a-z][a-z0-9_-]*)/im.exec(feedback);
  return match?.[1];
}

/** Gate context forwarded into `GateOptions` for the run that produced the output. */
interface GateRunContext {
  cwd?: string;
  proofDir?: string;
  proofRequired?: boolean;
  proofRunStartMs?: number;
  userGuidePath?: string;
}

/** Run a quality gate over a result, normalizing the feedback text. */
async function evaluateGate(
  gate: QualityGate,
  result: SpawnResult,
  context: GateRunContext,
): Promise<{ passed: boolean; failureKind?: string; durationMs: number; feedback: string }> {
  const { cwd, proofDir, proofRequired, proofRunStartMs, userGuidePath } = context;
  const options =
    cwd !== undefined ||
    proofDir !== undefined ||
    proofRequired !== undefined ||
    proofRunStartMs !== undefined ||
    userGuidePath !== undefined
      ? { cwd, proofDir, proofRequired, proofRunStartMs, userGuidePath }
      : undefined;
  const text = result.content?.[0]?.text ?? "";
  const startedAt = Date.now();
  const outcome = await gate(text, result.details, options);
  return {
    passed: outcome.passed,
    failureKind: gateFailureKind(outcome.feedback),
    durationMs: Date.now() - startedAt,
    feedback: outcome.feedback ?? (outcome.passed ? "All quality gates passed." : "Failed"),
  };
}

/**
 * Build the gate runner for one harness install.
 *
 * The returned function has the same contract the composer's local closure had:
 * evaluate the phase's quality gate, retry failures up to MAX_GATE_ATTEMPTS, and
 * return the last result (with the verdict appended) or null when the phase has
 * no gate.
 */
export function createQualityGateRunner(
  deps: QualityGateRunnerDeps,
): (options: RunQualityGateOptions) => Promise<SpawnResult | null> {
  async function runQualityGate(options: RunQualityGateOptions): Promise<SpawnResult | null> {
    const { agent, result, task, workflowType, phaseName } = options;
    if (!deps.isKnownPhase(phaseName)) return null;
    const effectiveGate = resolveQualityGate(phaseName, workflowType, agent.qualityGate);
    if (!effectiveGate) return null;

    let current = result;
    const feedbackHistory: string[] = [];

    // Re-check the gate after every pass, retrying until MAX_GATE_ATTEMPTS
    // total passes are exhausted. Retries resume the prior session for the
    // first IN_SESSION_RETRY_LIMIT attempts, then alternate fresh epochs and
    // resumes so context growth stays bounded.
    //
    // `options.proofRunStartMs` is this phase run's spawn time and is reused for
    // every attempt by design — do NOT refresh it per attempt, or a retry could
    // accept artifacts written before the run began.
    for (let attempt = 1; attempt <= MAX_GATE_ATTEMPTS; attempt += 1) {
      const verdict = await evaluateGate(effectiveGate, current, {
        cwd: options.cwd,
        proofDir: options.proofDir,
        proofRequired: WORKFLOW_REGISTRY[workflowType].proofRequired,
        proofRunStartMs: options.proofRunStartMs,
        userGuidePath: options.userGuidePath,
      });

      deps.recordAttempt({
        taskId: options.taskId,
        phase: phaseName,
        runId: options.runId,
        attempt,
        passed: verdict.passed,
        durationMs: verdict.durationMs,
        failureKind: verdict.failureKind,
      });
      if (verdict.passed) {
        return withGateResult(current, "✅ **Quality Gates**", verdict.feedback);
      }
      // attempt === MAX_GATE_ATTEMPTS short-circuits before spawnGateRetry, so
      // the final `-retry-9` epoch is created but never resumed.
      if (attempt === MAX_GATE_ATTEMPTS || (options.signal?.aborted ?? false)) {
        return withGateResult(
          current,
          `❌ **Quality Gates still failing after ${attempt - 1} retries**`,
          verdict.feedback,
        );
      }

      feedbackHistory.push(verdict.feedback);
      current = await spawnGateRetry(
        agent,
        {
          cwd: options.cwd,
          signal: options.signal,
          model: options.model,
          modelClass: options.modelClass,
          tools: options.tools,
          sessionName: options.sessionName,
          attempt,
          env: options.env,
          phaseName,
          telemetry: options.telemetry,
          onSelection: options.onSelection,
          originalTask: task,
          feedbackHistory,
        },
        deps,
      );
    }

    return current;
  }

  return runQualityGate;
}
