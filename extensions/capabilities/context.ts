/**
 * Shared plumbing for the harness capability modules (bd-179).
 *
 * Everything here is fleet-free by construction: the capability import boundary
 * test forbids `src/fleet-*.ts`, `src/fleet-state.ts` and `src/process-gate.ts`
 * from this directory (only `capabilities/fleet.ts` is allowlisted, and never
 * for the gate). `CoreSessionState` is the non-fleet half of the session state;
 * the composer intersects it with the fleet slice into one `SessionState`, so a
 * capability takes a `CoreSessionState` view of the same runtime object.
 *
 * These helpers are pure or confined side effects (subprocess execution, the
 * metrics log); nothing here holds pi state.
 */
import { execFile } from "node:child_process";

import { writePhaseArtifact } from "../../src/artifacts.js";
import type { BeadsAssigneeResult } from "../../src/beads-assignee.js";
import type { HandoffPacket } from "../../src/handoff.js";
import {
  appendMetricsEvent,
  buildGateResultEvent,
  buildReviewFindingsEvent,
  buildRunEndEvent,
  type MetricsEvent,
  metricsHostname,
} from "../../src/metrics.js";
import { countReviewFindings } from "../../src/review-context.js";
import { type RunDelivery, type RunHandle, RunStatus } from "../../src/run-detached.js";
import type { AwaitingHuman } from "../../src/workflow-phases.js";
import type { WorkflowSubType } from "../../src/workflow-registry.js";
import type { HandedOffMarker } from "../../src/workflow-state.js";

// Phase-name constants for the review↔fix loop helpers (bd-81). Hoisted so the
// loop checks and the guidance strings cannot drift from the workflow phase
// names.
export const IMPLEMENT_PHASE = "implement" as const;
export const REVIEW_PHASE = "review" as const;
export const COMMIT_PHASE = "commit" as const;
export const RESUMABLE_PHASES = [IMPLEMENT_PHASE, REVIEW_PHASE] as const;

/** True for phases that participate in the cross-run session-resume ledger. */
export function isResumablePhase(
  phaseName: string,
): phaseName is (typeof RESUMABLE_PHASES)[number] {
  return RESUMABLE_PHASES.some((phase) => phase === phaseName);
}

/**
 * Run a child process with an explicit argv array and no shell.
 *
 * A shell is what previously forced command strings through quoting rules and
 * made real newlines impossible (and escaped `\n` survive literally), while
 * interpolated content containing backticks or `$()` was executed outright.
 * With argv the arguments are passed verbatim, so multiline markdown reaches
 * the child intact. `stdin` lets large note/description bodies bypass argv
 * length limits (see bd-22 for the same class of failure on git commits).
 */
function runFileCommand(
  file: string,
  argv: readonly string[],
  options: {
    cwd: string;
    stdin: string | undefined;
    timeoutInMs: number;
    maxBufferInBytes: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...argv],
      {
        cwd: options.cwd,
        timeout: options.timeoutInMs,
        maxBuffer: options.maxBufferInBytes,
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );

    if (child.stdin) {
      // The child may exit before consuming stdin (e.g. on a validation
      // error), which turns the pending write into EPIPE; without a listener
      // that would surface as an unhandled stream error.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin ?? "");
    }
  });
}

/** Run `bd` with an explicit argv array and no shell. */
export function runBdCommand(
  argv: readonly string[],
  options: {
    cwd: string;
    stdin: string | undefined;
    timeoutInMs: number;
    maxBufferInBytes: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return runFileCommand("bd", argv, options);
}

/**
 * `bd` runner for the assignee mirror (bd-150).
 *
 * The mirror only reads `bd show --json` and writes one CAS-guarded `update`, so
 * it never has content for stdin and takes the narrower runner shape the fleet
 * accept path already uses.
 */
export function runBdForAssignee(
  argv: readonly string[],
  options: { cwd: string; timeoutInMs: number; maxBufferInBytes: number },
): Promise<{ stdout: string; stderr: string }> {
  return runBdCommand(argv, { ...options, stdin: undefined });
}

/**
 * Report an assignee mirror/clear outcome without ever blocking the caller.
 *
 * Ownership is a reporting property (bd-150): a missing or refused assignment
 * must degrade to a log line, never to a refused launch, accept, or stop.
 */
export function reportAssigneeResult(result: BeadsAssigneeResult): void {
  if (!result.ok) {
    console.warn(`[belayd-harness] beads assignee update failed: ${result.error}`);
    return;
  }
  for (const warning of result.warnings) console.warn(`[belayd-harness] ${warning}`);
}

/** Run `git` with an explicit argv array and no shell. */
export function runGitCommand(
  argv: readonly string[],
  options: { cwd: string; timeoutInMs: number; maxBufferInBytes: number },
): Promise<{ stdout: string; stderr: string }> {
  return runFileCommand("git", argv, { ...options, stdin: undefined });
}

/** Abort a tool call when the event exposes pi's optional abort hook. */
export function abortToolCall(event: unknown, code: string, reason: string): void {
  const abort = (event as { abort?: (code: string, reason: string) => void }).abort;
  if (typeof abort === "function") {
    abort(code, reason);
  }
}

/** Normalize an unknown thrown/rejected value for an error message. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  toolCalls: 0,
});

/** Shape a plain-text tool response with an explicit exit code. */
export function textToolResult(text: string, exitCode: number) {
  return {
    content: [{ type: "text" as const, text }],
    details: { messages: [], usage: emptyUsage(), exitCode },
  };
}

/** Shared no-cwd refusal for every tool that must stay pinned to a worktree. */
export function missingWorkingDirectoryError(label: string): string {
  return `${label} has no working directory: this session cannot be pinned to a worktree.`;
}

// ── Metrics log (bd-140) ───────────────────────────────────────────────

/** Hostname stamp for every event; resolved once per process. */
export const METRICS_HOST = metricsHostname();

/** Warn once per process: a failing log must not spam every phase. */
let metricsWarningEmitted = false;

/** Emit one gate_result event, if this gate is attached to a workflow task. */
export function recordGateAttemptMetric(options: {
  taskId: string | undefined;
  phase: string;
  runId: string;
  attempt: number;
  passed: boolean;
  durationMs: number;
  failureKind?: string;
}): void {
  if (options.taskId === undefined) return;
  recordMetric(
    buildGateResultEvent({
      now: Date.now(),
      host: METRICS_HOST,
      task: options.taskId,
      phase: options.phase,
      runId: options.runId,
      attempt: options.attempt,
      passed: options.passed,
      durationMs: options.durationMs,
      ...(options.failureKind === undefined ? {} : { failureKind: options.failureKind }),
    }),
  );
}

/**
 * Persist a delivered phase output as a worktree artifact (bd-141).
 *
 * Only a successful delivery becomes an artifact: a failed run's text is error
 * output, and a later phase reading it as context would be misled.
 */
export function recordPhaseArtifact(options: {
  cwd: string;
  delivery: RunDelivery;
  taskId: string;
}): void {
  if (!options.delivery.success) return;
  const written = writePhaseArtifact({
    cwd: options.cwd,
    phase: options.delivery.phaseName,
    taskId: options.taskId,
    text: options.delivery.result.content?.[0]?.text ?? "",
  });
  if (written.ok) return;
  console.warn(`[belayd-harness] phase artifact not written: ${written.error}`);
}

/**
 * Emit run_end plus, for a successful review, its per-severity finding counts.
 *
 * Kept out of the delivery callback so that callback stays inside the cognitive
 * complexity budget; recordMetric swallows a metrics failure.
 */
export function recordRunEndMetrics(options: {
  taskId: string;
  delivery: RunDelivery;
  delivered: RunDelivery;
  runStartedAt: number;
}): void {
  const usage = options.delivery.result.details.usage;
  recordMetric(
    buildRunEndEvent({
      now: Date.now(),
      host: METRICS_HOST,
      task: options.taskId,
      phase: options.delivery.phaseName,
      runId: options.delivery.runId,
      status: options.delivery.success ? RunStatus.Completed : RunStatus.Failed,
      exitCode: options.delivery.result.details.exitCode,
      toolCalls: usage.toolCalls,
      cost: usage.cost,
      tokensIn: usage.input,
      tokensOut: usage.output,
      tokensCacheRead: usage.cacheRead,
      wallMs: Date.now() - options.runStartedAt,
      ...(options.delivery.result.details.model === undefined
        ? {}
        : { model: options.delivery.result.details.model }),
    }),
  );
  if (!options.delivered.success || options.delivered.phaseName !== REVIEW_PHASE) return;
  const findings = countReviewFindings(options.delivered.result.content?.[0]?.text ?? "");
  recordMetric(
    buildReviewFindingsEvent({
      now: Date.now(),
      host: METRICS_HOST,
      task: options.taskId,
      critical: findings.critical,
      warnings: findings.warnings,
      suggestions: findings.suggestions,
    }),
  );
}

/**
 * Append one metrics event.
 *
 * Best effort by design: the log answers questions about the workflow, so it
 * must never be able to fail one. A real error is reported once, then dropped.
 */
export function recordMetric(event: MetricsEvent): void {
  const result = appendMetricsEvent({ env: process.env, event });
  if (result.ok || result.disabled === true || metricsWarningEmitted) return;
  metricsWarningEmitted = true;
  console.warn(`[belayd-harness] metrics append failed: ${result.error}`);
}

// ── Session state: the non-fleet core ──────────────────────────────────
/** Planning mode target: either a new bead or an existing bead to refine. */
export type PlanningTarget =
  | { kind: "new"; description: string }
  | { kind: "existing"; taskId: string; focus?: string };

/** A completion follow-up waiting for the open question set to be resolved. */
export interface HeldFollowUp {
  label: string;
  send: () => void;
}

/**
 * The capability-facing half of the harness session state.
 *
 * The composer composes this with the allowlisted fleet slice
 * (`FleetSessionState`, `extensions/capabilities/fleet.ts`) into one
 * `SessionState` intersection, so there is still exactly one runtime object per
 * session. Everything here is fleet-free: no field names a fleet type, which is
 * what lets a non-fleet capability module take a narrow view of this state
 * without importing a fleet module.
 */
export interface CoreSessionState {
  gateActive: boolean;
  planningActive: boolean;
  planningTarget: PlanningTarget | undefined;
  consultPhases: readonly string[];
  completedPhaseNames: string[];
  currentTaskId: string;
  /** Proof base resolved for the current task, cached so the spawn and verifier paths agree. */
  proofBase?: string;
  fullTools: string[] | undefined;
  workflowType: WorkflowSubType;
  phaseOrder: string[];
  optionalPhases: readonly string[];
  userGuideContent?: string;
  proofOutput?: string;
  proofVerifierVerdict?: string;
  /** True after a review run completes and before a later phase runs again. */
  awaitingReviewResponse: boolean;
  /**
   * Handoff packet received from the parent session that launched this
   * orchestrator (`.belayd/handoff.json`). Re-read on resume so a restart or
   * compaction re-injects the parent's context instead of losing it.
   */
  handoff?: HandoffPacket;
  /**
   * Set when this session handed its workflow to a child orchestrator in
   * another worktree. While present the session drives nothing: the gate stays
   * disarmed and `belayd_status` reports the handoff instead of a workflow.
   */
  handedOffTo?: HandedOffMarker;
  /**
   * Summary of caller-side leftovers found when resuming a handed-off session
   * (interrupted runs, pending user completions). Surfaced by `belayd_status`
   * instead of being silently dropped (bd-120).
   */
  handoffPendingNotice?: string;
  /**
   * Monotonic teardown counter, bumped whenever the active workflow is torn
   * down (start/stop task, /plan entry, workflow completion, session restart).
   * A run captures it at launch so runs started before a teardown can be told
   * apart from runs started after it. The gate flag alone cannot do this:
   * `currentTaskId` lingers after a completed/stopped workflow, and a run
   * started after that teardown begins with `gateActive === false` — exactly
   * like an in-flight run whose gate was just torn down.
   */
  runEpoch: number;
  deliveredRunIds: Set<string>;
  activeRuns: Map<string, { handle: RunHandle; abortController: AbortController }>;
  /**
   * Interval renewing this session's worktree orchestrator lease.
   *
   * Session-scoped on purpose: the lease must stop being renewed exactly when this
   * session stops, which is what makes "cold lease" mean "no orchestrator".
   */
  orchestratorLeaseTimer?: ReturnType<typeof setInterval>;
  /** Refusal text when another live session already owns this worktree's workflow. */
  orchestratorLeaseRefusal?: string;
  /** Session id this session's worktree lease names (cleared when it is released). */
  heldLeaseSessionId?: string;
  /**
   * Set while the workflow waits on a human answer (bd-152): the open `human` bd
   * gate, mirrored in memory so the tool gate can refuse synchronously.
   *
   * The bd gate — not this field — is the durable state: a restart re-discovers
   * it at session start, and delivering the answer clears both together.
   */
  awaitingHuman?: AwaitingHuman & { gateId?: string };
  /**
   * Set synchronously while a review gate is being opened, before its bd writes
   * complete (bd-175). It reserves the wait so a second concurrent delivery
   * cannot open a duplicate gate, but — unlike `awaitingHuman` — it must not be
   * visible to the answer poll, because the gate does not exist yet and an empty
   * gate list would read as "the human resolved it".
   */
  reviewGatePending?: boolean;
  /**
   * Interval polling the open human gate and its comment thread. Armed only for
   * an orchestrator session that asked a question, so an idle fleet of members
   * with nothing outstanding spawns no `bd` at all.
   */
  humanAnswerTimer?: ReturnType<typeof setInterval>;
  /**
   * One delivery at a time: the timer and the turn-start fallback can overlap,
   * and only the caller holding this claim may send the answer or settle it.
   */
  humanAnswerClaimed?: boolean;
  /** The unrecognized-gate warning was already logged for the current wait. */
  humanAnswerWarned?: boolean;
  /**
   * Completion follow-ups held because an unanswered `ask_user` question set is
   * open (bd-177).
   *
   * PI WEB renders a question set as a form only while it is the tail of the
   * transcript; any appended entry closes the card with no controls and records
   * no outcome. Delivering a completion then both destroys the human's chance to
   * answer and wakes the model to proceed without it, so the follow-up waits for
   * the next turn start, which is where an answer, a skip, or the human's own
   * message arrives.
   */
  heldFollowUps?: HeldFollowUp[];
  /** Bounded release for {@link heldFollowUps}; see {@link ASK_HOLD_MAX_MS}. */
  heldFollowUpTimer?: ReturnType<typeof setTimeout>;
}
