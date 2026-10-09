/**
 * Detached background run orchestration.
 *
 * A phase tool starts a run and returns immediately; the actual agent spawn
 * and quality-gate retry happen on a background promise. This module owns that
 * lifecycle: it turns spawn/gate work into a never-rejecting `RunHandle`
 * promise and drives delivery exactly once when the run settles.
 *
 * Pure orchestration: no pi API, no filesystem. All side effects arrive
 * through the injected `WatchRunDeps`.
 */

import type { SpawnResult } from "./agent-registry.js";

/** Lifecycle status of a detached run. */
export enum RunStatus {
  Running = "running",
  Completed = "completed",
  Failed = "failed",
}

/** Handle returned by the phase tool before the run finishes. */
export interface RunHandle {
  runId: string;
  phaseName: string;
  status: RunStatus;
  startedAtInMs: number;
  /** Never rejects: spawn/gate failures resolve to a failure SpawnResult. */
  promise: Promise<SpawnResult>;
}

/** What gets handed to the delivery side effect once a run settles. */
export interface RunDelivery {
  runId: string;
  phaseName: string;
  result: SpawnResult;
  success: boolean;
  /** Present only when `success` is false; explains the failure to the orchestrator. */
  failureReason?: string;
}

/** Inputs for `spawnDetachedRun`. */
export interface DetachedRunOptions {
  runId: string;
  phaseName: string;
  startedAtInMs: number;
  /** Initial spawn plus fallback note. Must not throw. */
  spawnAgent: () => Promise<SpawnResult>;
  /** Quality-gate retry; returns the original result when no gate applies. */
  runGate: (result: SpawnResult) => Promise<SpawnResult>;
}

/** Side effects `watchRunCompletion` needs from the caller. */
export interface WatchRunDeps {
  onSettled: (info: {
    runId: string;
    phaseName: string;
    result: SpawnResult;
    success: boolean;
  }) => void;
  persistStatus: (info: {
    runId: string;
    result: SpawnResult;
    success: boolean;
    failureReason?: string;
  }) => void;
  onPhaseComplete: (info: { runId: string; phaseName: string; result: SpawnResult }) => void;
  deliver: (delivery: RunDelivery) => void;
  isDelivered: (runId: string) => boolean;
  markDelivered: (runId: string) => void;
}

/** Inline failure result used when spawn/gate throws. */
function inlineFailureResult(err: unknown): SpawnResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Agent process failed: ${message}` }],
    details: {
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 },
      exitCode: 1,
    },
  };
}

/**
 * Start a detached run. The returned promise resolves (never rejects) once the
 * spawn and quality-gate retry settle.
 */
export function spawnDetachedRun(options: DetachedRunOptions): RunHandle {
  const promise = (async (): Promise<SpawnResult> => {
    try {
      const result = await options.spawnAgent();
      return await options.runGate(result);
    } catch (err) {
      return inlineFailureResult(err);
    }
  })();

  return {
    runId: options.runId,
    phaseName: options.phaseName,
    status: RunStatus.Running,
    startedAtInMs: options.startedAtInMs,
    promise,
  };
}

/** Max characters of stderr echoed into a failure reason. */
const STDERR_REASON_LIMIT = 400;

/**
 * Verdict for one settled run. Pure and total: it never throws and never
 * consults module state, so it can be unit-tested from a bare `SpawnResult`.
 */
export type RunOutcome = { success: true } | { success: false; reason: string };

/**
 * Decide whether a settled agent run actually did phase work.
 *
 * A non-zero exit is always a failure. A zero exit is only success when the
 * agent made at least one tool call: phase agents are entirely tool-driven, so
 * an exit-0 run with zero tool calls means the LLM/provider loop never ran
 * (e.g. an entitlement 403 that pi swallows). Treating that as success turns a
 * hard infrastructure failure into a silent no-op, so it must fail instead.
 * Assistant text does not rescue the verdict — a text-only reply did no work.
 *
 * When the fallback loop aggregated several attempts, the tool-call count is
 * taken from the final attempt (`finalAttemptToolCalls`) rather than the summed
 * reporting total, so real work from an earlier attempt cannot mask a silent
 * no-op final attempt.
 */
export function classifyRunOutcome(result: SpawnResult): RunOutcome {
  const { exitCode, usage, stderr, finalAttemptToolCalls } = result.details;

  if (exitCode !== 0) {
    const tail = stderr?.trim();
    const suffix = tail ? `: ${truncate(tail, STDERR_REASON_LIMIT)}` : "";
    return { success: false, reason: `agent process exited with code ${exitCode}${suffix}` };
  }

  const toolCalls = finalAttemptToolCalls ?? usage.toolCalls;
  if (toolCalls === 0) {
    const outputChars = result.content[0]?.text?.length ?? 0;
    return {
      success: false,
      reason:
        `Sub-agent completed with exit code 0 but made no tool calls ` +
        `(turns=${usage.turns}, output=${outputChars} chars) — likely an upstream ` +
        `LLM/provider or infrastructure failure, not a completed phase.`,
    };
  }

  return { success: true };
}

/** Keep a failure reason short enough for a follow-up message. */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

/**
 * Watch a run and drive its side effects exactly once when it settles.
 *
 * Phase completion (in-memory state) happens BEFORE persistence and delivery
 * so the persisted phase list and the follow-up message both observe the
 * already-updated gate state. The whole body is wrapped in a try/catch so a
 * throwing side effect can never crash the host.
 */
export function watchRunCompletion(handle: RunHandle, deps: WatchRunDeps): void {
  void (async () => {
    try {
      const result = await handle.promise;
      const outcome = classifyRunOutcome(result);
      const success = outcome.success;
      const failureReason = outcome.success ? undefined : outcome.reason;
      handle.status = success ? RunStatus.Completed : RunStatus.Failed;

      // onSettled runs for BOTH outcomes: a failed run must still release its
      // activeRuns entry, otherwise the gate deadlocks waiting for a follow-up
      // that never fires.
      deps.onSettled({ runId: handle.runId, phaseName: handle.phaseName, result, success });

      if (success) {
        deps.onPhaseComplete({ runId: handle.runId, phaseName: handle.phaseName, result });
      }
      deps.persistStatus({ runId: handle.runId, result, success, failureReason });

      if (!deps.isDelivered(handle.runId)) {
        deps.deliver({
          runId: handle.runId,
          phaseName: handle.phaseName,
          result,
          success,
          failureReason,
        });
        deps.markDelivered(handle.runId);
      }
    } catch (err) {
      console.warn(`[belayd-harness] run watcher failed for ${handle.runId}`, err);
    }
  })();
}
