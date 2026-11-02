/**
 * Phase-run capability (bd-179): the background launch of a phase sub-agent
 * (and of a planning scout/research run), its manifest/telemetry bookkeeping
 * and its completion delivery.
 *
 * The spawn, the quality-gate runner and the beam-task reader arrive as
 * dependencies: the extension tests replace `spawnAgentWithFallback` through the
 * composer's `src/index.js` import, and the gate runner is built by the composer
 * from `src/quality-gate-run.ts` seams. Nothing here imports a fleet module or
 * `src/process-gate.ts`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentDefinition,
  getPhaseToolName,
  type SpawnResult,
} from "../../src/agent-registry.js";
import { formatArtifactIndex } from "../../src/artifacts.js";
import { buildPhaseAdvanceEvent, buildRunStartEvent } from "../../src/metrics.js";
import { type ModelClass, resolveModelSpec } from "../../src/model-classes.js";
import {
  combineModelTelemetryStores,
  createModelTelemetryStore,
  type ModelTelemetryTotals,
} from "../../src/model-telemetry.js";
import { formatWorktreePreamble } from "../../src/owned-worktree.js";
import { collectChangeContext } from "../../src/proof-verification.js";
import { type RunQualityGateOptions, withFallbackNote } from "../../src/quality-gate-run.js";
import { userGuideDocPath } from "../../src/quality-gates.js";
import { hasReviewFindings } from "../../src/review-findings.js";
import {
  type RunDelivery,
  type RunHandle,
  spawnDetachedRun,
  watchRunCompletion,
} from "../../src/run-detached.js";
import {
  RunStatus,
  readRunManifest,
  setRunStatus,
  setRunTelemetry,
  writeRunManifest,
} from "../../src/run-manifest.js";
import {
  computePlanningSubagentSessionName,
  computeSubagentSessionName,
  resolveProjectSessionExists,
} from "../../src/session-naming.js";
import type { SpawnAttempt, SpawnWithFallbackOptions } from "../../src/spawn-with-fallback.js";
import { getNextPhase, type Phase } from "../../src/workflow-phases.js";
import type { WORKFLOW_REGISTRY } from "../../src/workflow-registry.js";
import {
  clearReviewScope,
  readReviewScope,
  readWorkflowState,
  savePhaseSession,
  saveReviewedSha,
} from "../../src/workflow-state.js";
import type { CoreSessionState } from "./context.js";
import {
  COMMIT_PHASE,
  IMPLEMENT_PHASE,
  isResumablePhase,
  METRICS_HOST,
  REVIEW_PHASE,
  recordMetric,
  recordPhaseArtifact,
  recordRunEndMetrics,
} from "./context.js";
import { modelCooldown, modelFallbackEnabled, modelState, persistModelTelemetry } from "./model.js";
import { preparePhaseProof, readUserGuideForContext } from "./proof.js";
import { boundReviewDelivery, buildReviewTask, reviewLoopDirective } from "./review.js";
import { deliverFollowUp, type SessionContext } from "./session-state.js";
import type { WorkflowCoreApi } from "./workflow-core.js";

/** Phase-run parameters a phase tool passes through. */
export interface PhaseToolParams {
  task: string;
}

/** Options for one background phase run. */
export interface StartPhaseRunOptions {
  agent: AgentDefinition;
  phaseName: string;
  params: PhaseToolParams;
  state: CoreSessionState;
  cwd: string;
  worktreeBranch: string | undefined;
  runId: string;
  /** The orchestrator's context: the follow-up hold reads its live branch (bd-177). */
  ctx: ExtensionContext;
}

/** Everything the phase runner needs from its host. */
export interface PhaseRunnerDeps {
  pi: ExtensionAPI;
  getSessionState: (ctx: SessionContext) => CoreSessionState;
  core: Pick<
    WorkflowCoreApi,
    | "applyPhaseCompletion"
    | "advancePastExistingEpoch"
    | "buildRunCompleteContent"
    | "persistCompletedPhases"
    | "userGuideArtifactLine"
  >;
  readTaskPlan: (taskId: string, cwd: string) => Promise<string | undefined>;
  /**
   * Injected: the extension tests replace it through the composer's
   * `src/index.js` import to patch a per-phase model override.
   */
  workflowRegistry: typeof WORKFLOW_REGISTRY;
  /** Injected: the extension tests replace it through `src/index.js`. */
  spawnAgentWithFallback: (
    options: SpawnWithFallbackOptions,
  ) => Promise<{ result: SpawnResult; attempts: SpawnAttempt[] }>;
  runQualityGate: (options: RunQualityGateOptions) => Promise<SpawnResult | null | undefined>;
  /**
   * Open a human gate for a review that reported findings (bd-175). Injected so
   * this module never reaches the human-gate capability directly; the composer
   * wires it to `openReviewHumanGate`. Absent in narrower hosts, where a review
   * delivery keeps the pre-bd-175 behaviour.
   */
  reviewGate?: ReviewGateSeam;
}

/** The injected review-gate opener (bd-175); see `reviewGate` above. */
export type ReviewGateSeam = (options: {
  state: CoreSessionState;
  ctx: ExtensionContext;
  taskId: string;
  reviewText: string;
}) => Promise<{ opened: boolean; reason: string }>;

/**
 * Call the injected review-gate opener without ever letting it fail the review
 * delivery. Extracted so the catch path is unit-testable without a live run.
 */
export async function tryOpenReviewGate(options: {
  open: ReviewGateSeam;
  state: CoreSessionState;
  ctx: ExtensionContext;
  taskId: string;
  reviewText: string;
}): Promise<boolean> {
  try {
    const outcome = await options.open({
      state: options.state,
      ctx: options.ctx,
      taskId: options.taskId,
      reviewText: options.reviewText,
    });
    return outcome.opened;
  } catch (error) {
    console.warn("[belayd-harness] could not open the review human gate", error);
    return false;
  }
}

/**
 * The review loop directive appended to a successful review delivery, or "" for
 * any other delivery. Extracted so the `deliver` watcher callback stays within
 * the cognitive-complexity budget.
 */
function reviewLoopHintFor(delivery: RunDelivery, state: CoreSessionState): string {
  if (!delivery.success || delivery.phaseName !== REVIEW_PHASE) return "";
  // Outside an active workflow there is no next phase to advance to, so the
  // loop directive would name a phase tool the gate is not driving.
  if (!state.gateActive) return "";
  // The "advance" tool is the next incomplete phase, not just review's
  // successor, so a late re-review after test points at the right phase.
  const nextIncompletePhase =
    getNextPhase(state.completedPhaseNames, state.phaseOrder) ?? COMMIT_PHASE;
  return (
    `\n\n---\n**When review findings remain:** ` +
    reviewLoopDirective(getPhaseToolName(nextIncompletePhase))
  );
}

/**
 * The loop hint a run-complete delivery carries, withheld when this delivery
 * opened a human gate (bd-175).
 *
 * A member blocked by that gate cannot call the next phase tool the hint names,
 * so offering it would only invite a refused call. Pure so all three inputs are
 * pinned directly: opening the gate is the only thing that withholds the hint —
 * a clean review and a host with no gate seam both arrive here as
 * `reviewGateOpened: false` and keep the pre-bd-175 delivery.
 */
export function runCompleteLoopHint(options: {
  delivered: RunDelivery;
  state: CoreSessionState;
  reviewGateOpened: boolean;
}): string {
  if (options.reviewGateOpened) return "";
  return reviewLoopHintFor(options.delivered, options.state);
}

/** The background-run surface the phase and planning tools drive. */
export interface PhaseRunnerApi {
  startPhaseRun: (options: StartPhaseRunOptions) => {
    handle: RunHandle;
    sessionName: string;
    ledgerWarning?: string;
  };
  startPlanningRun: (
    spec: { name: string; modelClass: ModelClass; tools: string[]; systemPrompt: string },
    phaseName: "scout" | "research",
    params: { task: string },
    state: CoreSessionState,
    effectiveCwd: string,
    runId: string,
    ctx: { sessionManager: { getBranch?: () => readonly unknown[] } },
  ) => { handle: RunHandle; sessionName: string };
}

export function createPhaseRunner(deps: PhaseRunnerDeps): PhaseRunnerApi {
  const { pi, core, readTaskPlan, spawnAgentWithFallback, runQualityGate, workflowRegistry } = deps;

  /** Persist the "running" manifest so a mid-phase crash is resumable. */
  function persistRunningManifest(options: {
    state: CoreSessionState;
    manifestCwd: string;
    runId: string;
    phaseName: string;
    subagentSessionName: string;
    model: string;
  }): void {
    if (!options.state.gateActive || options.state.currentTaskId === "") return;
    const writeResult = writeRunManifest({
      cwd: options.manifestCwd,
      manifest: {
        schemaVersion: 1,
        runId: options.runId,
        taskId: options.state.currentTaskId,
        phase: options.phaseName,
        sessionName: options.subagentSessionName,
        status: RunStatus.Running,
        startedAt: Date.now(),
        model: options.model,
      },
    });
    if (!writeResult.ok) {
      console.warn(`[belayd-harness] failed to persist run manifest: ${writeResult.error}`);
    }
  }

  /** Resolve a phase's effective capability tier from agent + workflow overrides. */
  function resolveEffectiveModelClass(
    agentClass: ModelClass | undefined,
    overrides: { model?: string; modelClass?: ModelClass } | undefined,
  ): ModelClass | undefined {
    // Edge-case matrix: an override model has no class here (undefined) so
    // the derivation happens inside candidatesForModel via modelClassOf, not
    // via MODEL_TO_CLASS directly; an explicit override modelClass wins over
    // both the override model and the agent's default class.
    return overrides?.modelClass ?? (overrides?.model ? undefined : agentClass);
  }

  /**
   * Resolve a phase's session name across invocations: the first call mints a
   * fresh session, later calls resume it (under the cross-run `-run-<n>` epoch
   * scheme) so the implement/review review↔fix loop keeps its context. Only
   * implement and review participate; other phases keep a fresh name per run.
   *
   * `ledgerWarning` is set when the handle could not be persisted, so the
   * phase tool response can surface it instead of silently re-resolving the
   * same attempt forever.
   */
  function resolveTrackedPhaseSession(options: {
    cwd: string;
    phaseName: string;
    taskId: string;
    freshSessionName: string;
    env?: Record<string, string>;
  }): { sessionName: string; resumeSession: boolean; ledgerWarning?: string } {
    if (!isResumablePhase(options.phaseName) || options.taskId === "") {
      return { sessionName: options.freshSessionName, resumeSession: false };
    }
    const persisted = readWorkflowState({ cwd: options.cwd });
    // The ledger is keyed by (task, phase) but stored under the cwd's single
    // workflow.json. A phase tool may pass a `cwd` other than the one that
    // wrote the state; without this check we'd resume another task's session
    // and then corrupt that task's ledger on write.
    if (persisted === undefined || persisted.taskId !== options.taskId) {
      return { sessionName: options.freshSessionName, resumeSession: false };
    }
    // Mirror spawn.ts's env resolution (merge over process.env) so this
    // pre-check and the spawn layer's own shouldResumeSession check can never
    // diverge on the session directory.
    const sessionEnv = options.env === undefined ? process.env : { ...process.env, ...options.env };
    const prior = persisted.phaseSessions?.[options.phaseName];
    const resolved = core.advancePastExistingEpoch({
      prior,
      freshSessionName: options.freshSessionName,
      exists: (sessionName) =>
        resolveProjectSessionExists(sessionName, { cwd: options.cwd, env: sessionEnv }),
    });
    const saveResult = savePhaseSession({
      cwd: options.cwd,
      phaseName: options.phaseName,
      record: resolved.next,
      existingState: persisted,
    });
    const ledgerWarning = saveResult.ok
      ? undefined
      : `Phase-session ledger not saved (${saveResult.error}); this invocation may repeat the same session next time.`;
    if (!saveResult.ok) {
      console.warn(
        `[belayd-harness] failed to persist phase session for ${options.phaseName}: ${saveResult.error}`,
      );
    }
    // The spawn layer falls back to a fresh session when the resume target is
    // not on disk (spawn.ts shouldResumeSession). Detect that here too so the
    // caller still prepends the bead plan instead of sending a bare task to a
    // fresh, transcript-less session.
    const canResume =
      resolved.resumeSession &&
      resolveProjectSessionExists(resolved.sessionName, {
        cwd: options.cwd,
        env: sessionEnv,
      });
    return {
      sessionName: resolved.sessionName,
      resumeSession: canResume,
      ledgerWarning,
    };
  }

  /**
   * Userguide prompt: name the exact deliverable path and state that the file,
   * not the chat answer, is what the gate and the human read. The path is
   * derived here (not left to the agent) so the gate, the commit note, and the
   * agent cannot disagree about where the guide lives.
   */
  function buildUserGuideTask(options: { taskId: string; paramsTask: string }): string {
    const docPath = userGuideDocPath(options.taskId);
    return `${options.paramsTask}

## Deliverable

Write the guide to \`${docPath}\` (create \`docs/\` when missing) using the \`write\` tool. The file is the record: a quality gate reads it back from the worktree, so pasting the guide into your final message instead of writing the file fails this phase.`;
  }

  /**
   * Build the full phase prompt: the bead plan for implement, the inlined diff
   * for review, the change context for proof, the deliverable path for
   * userguide, or the raw task otherwise. Used for the initial spawn and to
   * re-supply a fresh-epoch gate retry that has no transcript.
   */
  async function buildFullPhaseTask(options: {
    phaseName: string;
    taskId: string;
    paramsTask: string;
    cwd: string;
    userGuideContent: string | undefined;
  }): Promise<string> {
    if (options.phaseName === IMPLEMENT_PHASE && options.taskId !== "") {
      const plan = await readTaskPlan(options.taskId, options.cwd);
      if (plan) {
        return `## Bead plan (${options.taskId})\n${plan}\n\n${options.paramsTask}`;
      }
      return options.paramsTask;
    }
    if (options.phaseName === REVIEW_PHASE) {
      return buildReviewTask({
        taskId: options.taskId,
        paramsTask: options.paramsTask,
        cwd: options.cwd,
      });
    }
    if (options.phaseName === "userguide") {
      return buildUserGuideTask(options);
    }
    if (options.phaseName === "proof") {
      const proofContext = await collectChangeContext(
        options.cwd,
        readUserGuideForContext({
          cwd: options.cwd,
          taskId: options.taskId,
          captured: options.userGuideContent,
        }),
      );
      return `${options.paramsTask}${proofContext}`;
    }
    return options.paramsTask;
  }

  /**
   * A phase run is complete. Turn a review that reported findings into a human
   * gate through the injected seam (bd-175).
   *
   * Best-effort: the gate is the visible record, but a bd failure must never
   * fail an otherwise delivered review. Returns whether the gate actually
   * opened, so the caller can withhold the resumable-fix directive that a
   * blocked workflow could not act on.
   */
  async function openReviewGateIfFound(options: {
    delivered: RunDelivery;
    state: CoreSessionState;
    ctx: ExtensionContext;
  }): Promise<boolean> {
    const openGate = deps.reviewGate;
    if (openGate === undefined) return false;
    const reviewText = options.delivered.result.content?.[0]?.text ?? "";
    if (!hasReviewFindings(reviewText)) return false;
    return tryOpenReviewGate({
      open: openGate,
      state: options.state,
      ctx: options.ctx,
      taskId: options.state.currentTaskId,
      reviewText,
    });
  }

  /**
   * Promote the review scope captured when this review's task was built, so the
   * next re-review diffs only the fix round (bd-113, bd-228).
   *
   * Promotion happens at completion, never at capture: a mid-review edit must
   * not enter the baseline, or the next re-review would hide a change the
   * reviewer never read. The scope is consumed here so only the newest review
   * build's record can ever seed a baseline. Best-effort: a disk failure must
   * never affect an otherwise successful review delivery.
   */
  function persistReviewedSha(options: { cwd: string; taskId: string }): void {
    const scope = readReviewScope({ cwd: options.cwd });
    if (scope === undefined) {
      // No scope means no recorded revision: the next review is a
      // whole-change-set first review, which is wider, never narrower.
      console.warn(
        `[belayd-harness] no review scope recorded for ${options.taskId}; the next review starts from the whole change set`,
      );
      return;
    }
    if (scope.taskId !== options.taskId) {
      // Not ours to consume or promote; the next build rewrites it anyway.
      console.warn(
        `[belayd-harness] skipped the reviewed state: the review scope belongs to ${scope.taskId}, not ${options.taskId}`,
      );
      return;
    }
    // Consume before promoting: a failed write then leaves no scope, so the
    // next review cannot promote a record from this one.
    const cleared = clearReviewScope({ cwd: options.cwd });
    if (!cleared.ok) {
      console.warn(`[belayd-harness] failed to clear the review scope: ${cleared.error}`);
    }
    // The identity check lives in saveReviewedSha so it shares the read that
    // immediately precedes the write: a state swap must not redirect this
    // task's reviewed state into another task's workflow.json. The sha and its
    // untracked manifest go in one write so they cannot disagree.
    const saveResult = saveReviewedSha({
      cwd: options.cwd,
      sha: scope.sha,
      untracked: scope.untracked,
      expectedTaskId: options.taskId,
    });
    if (saveResult.ok) return;
    if (saveResult.reason === "missing-state") return;
    if (saveResult.reason === "task-mismatch") {
      console.warn(
        `[belayd-harness] skipped the reviewed sha: workflow state belongs to ${saveResult.actualTaskId}, not ${options.taskId}`,
      );
      return;
    }
    console.warn(`[belayd-harness] failed to persist the reviewed sha: ${saveResult.error}`);
  }

  /** Mark a completed/failed phase run in its manifest. */
  function persistRunStatus(options: {
    state: CoreSessionState;
    manifestCwd: string;
    runId: string;
    status: RunStatus.Completed | RunStatus.Failed;
    exitCode: number;
    failureReason?: string;
    /** This run's own telemetry totals (from its private run store). */
    telemetry: ModelTelemetryTotals;
  }): void {
    if (!options.state.gateActive || options.state.currentTaskId === "") return;
    const statusResult = setRunStatus({
      cwd: options.manifestCwd,
      runId: options.runId,
      status: options.status,
      exitCode: options.exitCode,
      ...(options.failureReason !== undefined ? { failureReason: options.failureReason } : {}),
    });
    if (!statusResult.ok) {
      console.warn(`[belayd-harness] failed to update run manifest: ${statusResult.error}`);
    }
    // Attach this run's own telemetry totals to its manifest. A private
    // per-run store (not a process-cumulative delta) keeps attribution exact
    // even when another run overlaps, and a mid-run workflow-store reset cannot
    // collapse it to zero.
    if (options.telemetry.attempts > 0) {
      const telemetryResult = setRunTelemetry({
        cwd: options.manifestCwd,
        runId: options.runId,
        telemetry: options.telemetry,
      });
      if (!telemetryResult.ok) {
        console.warn(
          `[belayd-harness] failed to attach telemetry to run manifest: ${telemetryResult.error}`,
        );
      }
    }
    persistModelTelemetry(options.manifestCwd);
    if (options.status === RunStatus.Completed) {
      // The in-memory phase list is marked in the run watcher's
      // onPhaseComplete, and disk only records a phase once its run actually
      // completed — this is what makes resume re-run an interrupted phase.
      // Never persist on "failed".
      core.persistCompletedPhases({
        cwd: options.manifestCwd,
        completedPhaseNames: options.state.completedPhaseNames,
        awaitingReviewResponse: options.state.awaitingReviewResponse,
      });
    }
  }

  /**
   * Start a phase run in the background and return its handle immediately.
   *
   * The run owns its abort signal — the tool-call signal belongs to the
   * (now non-blocking) tool response and must not cancel the background run.
   */
  function startPhaseRun(options: StartPhaseRunOptions): {
    handle: RunHandle;
    sessionName: string;
    ledgerWarning?: string;
  } {
    // Wall-clock floor for the run_end event, captured before the spawn so a
    // gate retry's extra time is attributed to the run that caused it.
    const runStartedAt = Date.now();
    const { agent, phaseName, params, state, cwd, worktreeBranch, runId } = options;
    const overrides = workflowRegistry[state.workflowType].agentOverrides?.[phaseName as Phase];
    const resolvedModel = resolveModelSpec(agent);
    const effectiveModel = overrides?.model ?? resolvedModel.model;
    const effectiveModelClass = resolveEffectiveModelClass(resolvedModel.modelClass, overrides);
    const effectiveTools = overrides?.tools ?? agent.tools;
    const effectiveSystemPrompt = overrides?.systemPrompt ?? agent.systemPrompt;
    const freshSessionName = computeSubagentSessionName(state.currentTaskId, phaseName, runId);
    // Resolve the proof base before the session ledger so the same env (which
    // may later carry session-dir overrides) feeds both existence checks.
    const { proofDir, spawnEnv } = preparePhaseProof(state, cwd);
    const {
      sessionName: subagentSessionName,
      resumeSession,
      ledgerWarning,
    } = resolveTrackedPhaseSession({
      cwd,
      phaseName,
      taskId: state.currentTaskId,
      freshSessionName,
      env: spawnEnv,
    });

    persistRunningManifest({
      state,
      manifestCwd: cwd,
      runId,
      phaseName,
      subagentSessionName,
      model: effectiveModel,
    });

    recordMetric(
      buildRunStartEvent({
        now: runStartedAt,
        host: METRICS_HOST,
        task: state.currentTaskId,
        phase: phaseName,
        runId,
        workflowType: state.workflowType,
        model: effectiveModel,
        session: subagentSessionName,
      }),
    );

    // A private store gives this run an exact per-run manifest delta even when
    // another run overlaps; the fan-out also feeds the shared workflow store
    // that owns persistence and logging.
    const runTelemetry = createModelTelemetryStore();
    const runTelemetrySink = combineModelTelemetryStores(modelState.telemetry, runTelemetry);

    const abortController = new AbortController();

    // Guard watcher callbacks against a workflow teardown: once
    // belayd_start_task, belayd_stop_task, or /plan bumps the run epoch (and
    // aborts/clears these runs), their still-pending promises must not mutate
    // the new task's state or deliver the old task's follow-up.
    //
    // The gate flag alone cannot express this: `currentTaskId` lingers after a
    // completed/stopped workflow, and a run started AFTER that teardown begins
    // with `gateActive === false` — exactly like an in-flight run whose gate
    // was just torn down. The epoch tells the two apart, so a post-completion
    // rework run still delivers while a torn-down run never does.
    const epochAtStart = state.runEpoch;
    const taskIdAtStart = state.currentTaskId;
    const runNotSuperseded = (): boolean =>
      state.runEpoch === epochAtStart && state.currentTaskId === taskIdAtStart;
    // Workflow state is only advanced while the gate owns the run. A report
    // run started outside a workflow (e.g. rework after completion) delivers
    // its output but must not resurrect workflow.json or phase state.
    const gateOwnsRun = (): boolean => state.gateActive && runNotSuperseded();

    /**
     * True when a settled run may be delivered to the orchestrator. A
     * `/belayd-complete` recovery owns delivery: a still-running child that
     * settles after the user marked the run must not deliver its raw output
     * (`reconcileUserCompletions` owns the follow-up and the phase completion
     * for user-completed runs).
     */
    const shouldDeliverRun = (delivery: RunDelivery): boolean => {
      if (!runNotSuperseded()) return false;
      if (isRunDelivered(delivery.runId)) return false;
      return readRunManifest({ cwd, runId: delivery.runId })?.completedBy !== "user";
    };

    /**
     * Deliver one settled run. Extracted from the `deliver` callback so the
     * callback stays under the cognitive-complexity budget. Async so the
     * reviewed sha lands on disk before the follow-up turn can start a
     * re-review that depends on it.
     */
    const deliverRunCompletion = async (delivery: RunDelivery): Promise<void> => {
      if (!shouldDeliverRun(delivery)) return;
      // The watcher does not await this callback, so any throw would become an
      // unhandled rejection instead of reaching the watcher's own catch.
      try {
        const delivered = boundReviewDelivery(delivery);
        // Only a gate-owned, successful review records the reviewed sha — a
        // post-completion rework run must not scope the next task's review.
        // A review that reported findings opens a human gate here (bd-175), so
        // the stop is findable in bd instead of only inside the worktree.
        let reviewGateOpened = false;
        if (gateOwnsRun() && delivery.success && delivery.phaseName === REVIEW_PHASE) {
          persistReviewedSha({ cwd, taskId: state.currentTaskId });
          reviewGateOpened = await openReviewGateIfFound({
            delivered,
            state,
            ctx: options.ctx,
          });
        }
        recordRunEndMetrics({
          taskId: state.currentTaskId,
          delivery,
          delivered,
          runStartedAt,
        });
        recordPhaseArtifact({
          cwd,
          delivery,
          taskId: state.currentTaskId,
        });
        deliverFollowUp(state, options.ctx, `${delivery.phaseName} run ${delivery.runId}`, () => {
          pi.sendMessage(
            {
              customType: "belayd-run-complete",
              content: core.buildRunCompleteContent(
                delivered,
                runCompleteLoopHint({ delivered, state, reviewGateOpened }),
                core.userGuideArtifactLine(delivered, { cwd, taskId: state.currentTaskId }),
              ),
              display: true,
              details: {
                runId: delivery.runId,
                phaseName: delivery.phaseName,
                taskId: state.currentTaskId,
                exitCode: delivery.result.details.exitCode,
                ...(delivery.failureReason !== undefined
                  ? { failureReason: delivery.failureReason }
                  : {}),
              },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        });
      } catch (error) {
        console.warn(`[belayd-harness] failed to deliver run ${delivery.runId}`, error);
      }
    };

    // The full task (bead plan / change context included). A fresh-epoch gate
    // retry has no transcript, so it must be re-supplied this full prompt even
    // when the invocation itself resumed. spawnAgent runs before runGate (see
    // spawnDetachedRun), so it is populated in time.
    let fullTask: string = params.task;

    const spawnAgent = (): Promise<SpawnResult> => {
      const buildTask = async (): Promise<string> => {
        const preamble = formatWorktreePreamble({
          cwd,
          branch: worktreeBranch,
        });
        // bd-141: name the artifacts earlier phases wrote, so this agent reads a
        // file instead of re-deriving context the harness already has.
        const artifactIndex = formatArtifactIndex({ cwd, forPhase: phaseName });
        const artifactBlock = artifactIndex === "" ? "" : `${artifactIndex}\n\n`;
        fullTask = `${preamble}\n\n${artifactBlock}${await buildFullPhaseTask({
          phaseName,
          taskId: state.currentTaskId,
          paramsTask: params.task,
          cwd,
          userGuideContent: state.userGuideContent,
        })}`;
        // On a cross-run resume the transcript already contains the bead plan,
        // so sending the full task would duplicate context; the orchestrator
        // supplies the review findings it wants fixed in params.task instead.
        // Review and proof are exempt: their full task carries context the
        // session has never seen — a freshly computed diff (the fix diff on a
        // re-review) and fresh change context, respectively. Returning
        // params.task there would hand a resumed re-review no diff at all.
        const needsFullTask = !resumeSession || phaseName === "proof" || phaseName === REVIEW_PHASE;
        return needsFullTask ? fullTask : `${preamble}\n\n${artifactBlock}${params.task}`;
      };
      return buildTask().then((task) =>
        spawnAgentWithFallback({
          model: effectiveModel,
          modelClass: effectiveModelClass,
          tools: effectiveTools,
          systemPrompt: effectiveSystemPrompt,
          task,
          sessionName: subagentSessionName,
          resumeSession,
          cwd,
          signal: abortController.signal,
          // Background runs use detached:true so a terminal Ctrl-C in the
          // orchestrator does not kill the sub-agent; explicit cancellation goes
          // through this run's AbortController.
          detached: true,
          env: spawnEnv,
          cooldownStore: modelCooldown,
          enabled: modelFallbackEnabled,
          phase: phaseName,
          telemetry: runTelemetrySink,
          capacity: modelState.capacity,
        }).then((r) => withFallbackNote(r.result, r.attempts)),
      );
    };

    // Captured immediately before the spawn so the proof gate can distinguish
    // artifacts produced by this run from a previous attempt's leftovers. The
    // floor is deliberately per PHASE RUN, not per gate attempt: it is passed
    // down as a plain value and never refreshed inside the attempt loop, so
    // every attempt's artifacts are >= the first attempt's start while pre-run
    // leftovers stay filtered out.
    const proofRunStartMs = Date.now();
    const runGate = (result: SpawnResult): Promise<SpawnResult> =>
      runQualityGate({
        agent,
        result,
        task: fullTask,
        cwd,
        proofDir,
        proofRunStartMs,
        // Only the userguide phase has a file deliverable; the path is derived
        // from the bead id so the gate reads exactly what the prompt named.
        userGuidePath:
          phaseName === "userguide" && state.currentTaskId !== ""
            ? userGuideDocPath(state.currentTaskId)
            : undefined,
        env: spawnEnv,
        workflowType: state.workflowType,
        phaseName,
        signal: abortController.signal,
        model: effectiveModel,
        modelClass: effectiveModelClass,
        tools: effectiveTools,
        sessionName: subagentSessionName,
        telemetry: runTelemetrySink,
        // Emitted as gate_result; undefined outside a gate-owned workflow.
        taskId: state.currentTaskId === "" ? undefined : state.currentTaskId,
        runId,
      }).then((gateResult) => gateResult ?? result);

    const handle = spawnDetachedRun({
      runId,
      phaseName,
      startedAtInMs: Date.now(),
      spawnAgent,
      runGate,
    });

    state.activeRuns.set(runId, { handle, abortController });

    /** True once this run's result has been delivered (in-memory or persisted). */
    const isRunDelivered = (id: string): boolean =>
      state.deliveredRunIds.has(id) ||
      readRunManifest({ cwd, runId: id })?.deliveredAt !== undefined;

    watchRunCompletion(handle, {
      onSettled: (info) => {
        // A failed run must still release its activeRuns entry; skip only when
        // the task has already switched (the new task cleared activeRuns).
        if (runNotSuperseded()) state.activeRuns.delete(info.runId);
      },
      persistStatus: (info) => {
        // An aborted/abandoned run's manifest stays "running" and is flipped
        // to "interrupted" by scanForInterruptedRuns on the next session start
        // (bd-40 semantics) — never persist completion under the wrong task.
        // Manifest and phase state are workflow-scoped: a post-completion
        // rework run reports its result but leaves no workflow state behind.
        if (!gateOwnsRun()) return;
        // A manual `/belayd-complete` owns the manifest; a later settle of the
        // resumed/recovered child must not downgrade a user completion.
        if (readRunManifest({ cwd, runId: info.runId })?.completedBy === "user") return;
        persistRunStatus({
          state,
          manifestCwd: cwd,
          runId: info.runId,
          status: info.success ? RunStatus.Completed : RunStatus.Failed,
          exitCode: info.result.details.exitCode,
          failureReason: info.failureReason,
          telemetry: runTelemetry.totals(),
        });
      },
      onPhaseComplete: (info) => {
        if (!gateOwnsRun()) return;
        // A `/belayd-complete` recovery owns the run: once the user's report is
        // delivered (or the manifest is tagged completedBy "user"), a
        // still-running child that settles later must not overwrite the
        // recovered output (state.userGuideContent / state.proofOutput).
        if (isRunDelivered(info.runId)) return;
        if (readRunManifest({ cwd, runId: info.runId })?.completedBy === "user") return;
        core.applyPhaseCompletion(state, info.phaseName, info.result.content?.[0]?.text);
        const nextPhase = getNextPhase(state.completedPhaseNames, state.phaseOrder);
        if (nextPhase !== undefined) {
          recordMetric(
            buildPhaseAdvanceEvent({
              now: Date.now(),
              host: METRICS_HOST,
              task: state.currentTaskId,
              phase: info.phaseName,
              nextPhase,
            }),
          );
        }
      },
      deliver: deliverRunCompletion,
      isDelivered: isRunDelivered,
      markDelivered: (id) => {
        // The watcher marks delivery after `deliver`; a user-completed run must
        // stay undelivered so the sentinel reconcile still owns it. Without
        // this, the in-memory marker would make reconcile skip the user report.
        if (readRunManifest({ cwd, runId: id })?.completedBy === "user") return;
        state.deliveredRunIds.add(id);
      },
    });

    return { handle, sessionName: subagentSessionName, ledgerWarning };
  }

  /**
   * Start a planning sub-agent run (scout or research) in the background.
   *
   * Planning runs are not task-gated: no quality gate, no run manifest, no
   * proof bridge. Completion is delivered as a planning-specific follow-up so
   * the planning orchestrator can synthesize the results.
   */
  function startPlanningRun(
    spec: { name: string; modelClass: ModelClass; tools: string[]; systemPrompt: string },
    phaseName: "scout" | "research",
    params: { task: string },
    state: CoreSessionState,
    effectiveCwd: string,
    runId: string,
    ctx: { sessionManager: { getBranch?: () => readonly unknown[] } },
  ): { handle: RunHandle; sessionName: string } {
    const sessionName = computePlanningSubagentSessionName(phaseName, runId);
    const abortController = new AbortController();

    // Guard watcher callbacks against planning-mode exit or a new /plan target:
    // once stop_planning (or a new /plan) aborts and clears these runs, their
    // still-pending promises must not deliver the old target's follow-up.
    const targetAtStart = state.planningTarget;
    const runStillRelevant = (): boolean =>
      state.planningActive && state.planningTarget === targetAtStart;

    const spawnAgent = (): Promise<SpawnResult> =>
      spawnAgentWithFallback({
        model: resolveModelSpec(spec).model,
        modelClass: spec.modelClass,
        tools: spec.tools,
        systemPrompt: spec.systemPrompt,
        task: params.task,
        sessionName,
        cwd: effectiveCwd,
        signal: abortController.signal,
        detached: true,
        cooldownStore: modelCooldown,
        enabled: modelFallbackEnabled,
        phase: phaseName,
        telemetry: modelState.telemetry,
        capacity: modelState.capacity,
      }).then((r) => r.result);

    const handle = spawnDetachedRun({
      runId,
      phaseName,
      startedAtInMs: Date.now(),
      spawnAgent,
      runGate: (result) => Promise.resolve(result),
    });

    state.activeRuns.set(runId, { handle, abortController });

    watchRunCompletion(handle, {
      onSettled: (info) => {
        if (runStillRelevant()) state.activeRuns.delete(info.runId);
      },
      persistStatus: () => {},
      onPhaseComplete: () => {},
      deliver: (delivery) => {
        if (!runStillRelevant()) return;
        const text = delivery.result.content?.[0]?.text ?? "";
        const header = delivery.success
          ? `✅ **planning ${delivery.phaseName} complete** (run \`${delivery.runId}\`)`
          : `❌ **planning ${delivery.phaseName} failed** (run \`${delivery.runId}\`)`;
        deliverFollowUp(state, ctx, `planning ${delivery.phaseName} run ${delivery.runId}`, () => {
          pi.sendMessage(
            {
              customType: "belayd-planning-run-complete",
              content: `${header}\n\n${text}`,
              display: true,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        });
        persistModelTelemetry(effectiveCwd);
      },
      isDelivered: (id) => state.deliveredRunIds.has(id),
      markDelivered: (id) => {
        state.deliveredRunIds.add(id);
      },
    });

    return { handle, sessionName };
  }

  return { startPhaseRun, startPlanningRun };
}
