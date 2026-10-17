/**
 * Belayd agent harness — pi project-level extension.
 *
 * Auto-discovered by pi from `.pi/extensions/belayd-harness/index.ts`.
 *
 * Registers:
 * - `belayd_scout`, `belayd_plan`, etc. — tools that spawn specialized agents
 * - `belayd_start_task` — activates the process gate
 * - Process gate hooks — enforces phase order when active
 *
 * The process gate is **dormant by default**. Normal pi sessions are
 * unaffected. Only activates when `belayd_start_task` is called.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BashToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CAPACITY_PROBE_URL_ENV,
  createCapacityCache,
  createEndpointCapacityProbe,
  createFallbackCapacityProbe,
  probeFromCooldownStore,
} from "../src/capacity-cache.js";
import { claimRegistrationOnce } from "../src/claim-registry.js";
import type {
  AgentDefinition,
  ArchifyCommand,
  ArchifyDiagramType,
  ArchifyQuality,
  ArchifyTextResult,
  ModelClass,
  OutlineFilesOptions,
  OutlineKind,
  Phase,
  QualityGate,
  RunDelivery,
  RunHandle,
  RunManifest,
  SpawnResult,
  StackNode,
  SubagentSessionRef,
  WorkflowResolution,
  WorkflowResolutionSource,
  WorkflowState,
  WorkflowSubType,
} from "../src/index.js";
import {
  ALL_PHASE_NAMES,
  ALL_PHASE_TOOLS,
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_GUIDANCE_COMMANDS,
  ARCHIFY_QUALITY_PROFILES,
  ARCHIFY_TOOL_COMMANDS,
  acceptedProofRefsFromScan,
  awaitWorktreeReady,
  bdCommandReadsStdin,
  boundReviewOutput,
  buildArchifyArgs,
  buildArchifyCheckArgs,
  buildArchifyGuideArgs,
  buildArchifyInspectArgs,
  buildVerifierPrompt,
  checkToolAllowed,
  collectChangeContext,
  collectReviewDiff,
  createInstructionGroupCollector,
  currentBranch,
  DEFAULT_AGENTS,
  DEFAULT_BASE_BRANCH,
  defaultGitExec,
  extractProofArtifacts,
  findWorkspaceRoot,
  formatArchifyIgnoredParamsNote,
  formatArchifyResult,
  formatOutline,
  formatProcessState,
  formatReviewTask,
  getAgentByShortName,
  getNextPhase,
  getPhasesForType,
  getPhaseToolName,
  INSTRUCTION_GROUPS_CHANNEL,
  ignoredArchifyParams,
  isArchifyDiagramType,
  isArchifyQuality,
  isArchifyToolCommand,
  isInsideWorktreeForBranch,
  isOutlineKind,
  isValidTaskId,
  isValidWorkflowType,
  isWorkflowComplete,
  lastAssistantText,
  listArchifyExamples,
  listPendingUserCompletions,
  listRuns,
  manageInstructionGroups,
  manageInstructionGroupsWarning,
  markPhaseCompleted,
  NO_GROUP_REGISTERED_WARNING,
  OUTLINE_FILE_EXTENSIONS,
  OUTLINE_KINDS,
  outlineFiles,
  PLANNING_MODE_SYSTEM_PROMPT,
  PLANNING_MODE_TOOLS,
  PROOF_VERIFIER_AGENT,
  PROOF_VERIFIER_TOOLS,
  parseSubagentSessionName,
  parseWorkflowLabel,
  RESEARCHER_SYSTEM_PROMPT,
  RESEARCHER_TOOLS,
  RunStatus,
  readStackNode,
  resolveArchifyHome,
  resolveAutoRebaseEnabled,
  resolveBashTimeout,
  resolveModelSpec,
  resolveOutlineTargets,
  resolveQualityGate,
  resolveStackChain,
  resolveWorkflowSelection,
  runArchify,
  runArchifyText,
  runStackRebase,
  scanProofRefs,
  setupWorktree,
  spawnAgentWithFallback,
  spawnDetachedRun,
  validateBdCommand,
  WF_LABEL_PREFIX,
  WORKFLOW_REGISTRY,
  WORKFLOW_SUB_TYPES,
  watchRunCompletion,
} from "../src/index.js";
import { createModelCooldownStore, defaultModelCooldownPath } from "../src/model-cooldown.js";
import {
  createModelSessionState,
  flushAndResetModelTelemetry,
  flushModelTelemetry,
  shouldWarnFlushFailure,
} from "../src/model-session-state.js";
import {
  combineModelTelemetryStores,
  createModelTelemetryStore,
  formatModelTelemetrySummary,
  type ModelTelemetryStore,
  type ModelTelemetryTotals,
} from "../src/model-telemetry.js";
import {
  ensureProofBridge,
  proofDirForTask,
  resolveProjectProofBase,
  resolveProofBase,
} from "../src/proof-dir.js";
import {
  completeRunByUser,
  markRunDelivered,
  readRunManifest,
  scanForInterruptedRuns,
  setRunStatus,
  setRunTelemetry,
  writeRunManifest,
} from "../src/run-manifest.js";
import { countUncommittedFiles } from "../src/session-conditions.js";
import type { PhaseSessionRecord } from "../src/session-naming.js";
import {
  computeOrchestratorSessionName,
  computePlanningSubagentSessionName,
  computeSubagentSessionName,
  gateRetrySession,
  generateShortRunId,
  resolvePhaseInvocation,
  resolveProjectSessionExists,
} from "../src/session-naming.js";
import type { SpawnAttempt } from "../src/spawn-with-fallback.js";
import {
  clearWorkflowState,
  readWorkflowState,
  saveCompletedPhases,
  savePhaseSession,
  saveReviewedSha,
  writeWorkflowState,
} from "../src/workflow-state.js";

// ── Quality-gate run options ──────────────────────────────────────────

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
  env?: Record<string, string>;
  signal?: AbortSignal;
  model?: string;
  modelClass?: ModelClass;
  tools?: string[];
  sessionName?: string;
  /** Telemetry sink for gate-retry spawns; defaults to the workflow store. */
  telemetry?: ModelTelemetryStore;
}

// ── Process gate state ─────────────────────────────────────────────────
/** Planning mode target: either a new bead or an existing bead to refine. */
type PlanningTarget =
  | { kind: "new"; description: string }
  | { kind: "existing"; taskId: string; focus?: string };

type SessionState = {
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
};

const sessionStates = new Map<string, SessionState>();

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
function runBdCommand(
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

/** Run `git` with an explicit argv array and no shell. */
function runGitCommand(
  argv: readonly string[],
  options: { cwd: string; timeoutInMs: number; maxBufferInBytes: number },
): Promise<{ stdout: string; stderr: string }> {
  return runFileCommand("git", argv, { ...options, stdin: undefined });
}

// Shared per-orchestrator model cooldown store: when a model hits a quota/rate
// limit, subsequent spawns in this session skip it until the cooldown lapses.
// Persisted to disk so cooldowns survive orchestrator restarts.
// Kill switch: BELAYD_MODEL_FALLBACK=0 disables candidate fallback entirely.
const modelCooldown = createModelCooldownStore({ filePath: defaultModelCooldownPath() });
// Pre-dispatch capacity signal. When a usage/reset endpoint is configured it
// is probed directly; otherwise the persisted cooldown store's provider windows
// stand in. Results are cached (TTL) so a multi-phase workflow re-probes at
// most once per TTL, and mid-workflow 429s are recorded back into the cache.
const capacityProbeUrl = process.env[CAPACITY_PROBE_URL_ENV];
// Session-scoped model-routing state (bd-116): the pre-dispatch capacity
// cache, the per-workflow telemetry store, and the per-destination telemetry
// flush cursors. This one object is the documented module-level mutable-state
// exception for model routing; the module owns its reset semantics.
const modelState = createModelSessionState({
  capacity:
    capacityProbeUrl !== undefined && capacityProbeUrl !== ""
      ? createCapacityCache({
          // A configured-but-unreachable endpoint must not silently disable the
          // capacity signal: fall back to the persisted cooldown store and warn
          // (throttled inside the probe) that the endpoint is not delivering.
          probe: createFallbackCapacityProbe(
            createEndpointCapacityProbe({
              url: capacityProbeUrl,
              onFailure: (reason) => {
                console.warn(
                  `[belayd-harness] ${CAPACITY_PROBE_URL_ENV} produced no capacity signal (${reason}); falling back to the cooldown store.`,
                );
              },
            }),
            probeFromCooldownStore(modelCooldown),
          ),
        })
      : createCapacityCache({ probe: probeFromCooldownStore(modelCooldown) }),
});
const modelFallbackEnabled = process.env.BELAYD_MODEL_FALLBACK !== "0";

function getSessionState(ctx: { sessionManager: { getSessionId: () => string } }): SessionState {
  const id = ctx.sessionManager.getSessionId();
  let state = sessionStates.get(id);
  if (!state) {
    state = {
      gateActive: false,
      planningActive: false,
      planningTarget: undefined,
      consultPhases: [],
      completedPhaseNames: [],
      currentTaskId: "",
      fullTools: undefined,
      workflowType: "feature",
      phaseOrder: getPhasesForType("feature"),
      optionalPhases: WORKFLOW_REGISTRY.feature.optionalPhases ?? [],
      runEpoch: 0,
      deliveredRunIds: new Set(),
      activeRuns: new Map(),
      awaitingReviewResponse: false,
    };
    sessionStates.set(id, state);
  }
  return state;
}

interface ToolCallGateEvent {
  toolName: string;
}

/** Abort a tool call when the event exposes pi's optional abort hook. */
function abortToolCall(event: unknown, code: string, reason: string): void {
  const abort = (event as { abort?: (code: string, reason: string) => void }).abort;
  if (typeof abort === "function") {
    abort(code, reason);
  }
}

/**
 * Evaluate the process gate for a tool call. Extracted from the `tool_call`
 * hook so the two blocking branches (in-flight run and out-of-order phase)
 * stay flat and the hook stays below the complexity limit.
 */
function evaluateToolCallGate(
  event: ToolCallGateEvent,
  state: SessionState,
): { block?: boolean; reason?: string } {
  const toolName = event.toolName;

  // While a background phase run is active, block starting another phase
  // (or the commit) — completion is delivered asynchronously, so the
  // orchestrator must wait for that follow-up instead of racing ahead.
  // Checked before phase-order so the reason names the in-flight run.
  const toolBase = toolName.startsWith("belayd_") ? toolName.slice(7) : "";
  // `commit` is a safety net: it already appears in every phaseOrder, so this
  // clause catches a commit racing ahead during a phase run.
  const isPhaseRunTarget =
    state.phaseOrder.includes(toolBase) ||
    state.consultPhases.includes(toolBase) ||
    toolBase === "commit";
  if (state.activeRuns.size > 0 && isPhaseRunTarget) {
    const activeRunIds = [...state.activeRuns.keys()].join(", ");
    const reason =
      `A phase run is already in progress (run ${activeRunIds}). ` +
      `Wait for its follow-up result, or check progress with belayd_status.`;
    abortToolCall(event, "phase-run-in-flight", reason);
    return { block: true, reason };
  }

  const check = checkToolAllowed(
    toolName,
    state.completedPhaseNames,
    state.gateActive,
    state.phaseOrder,
    state.workflowType,
    state.optionalPhases,
    state.consultPhases,
  );
  if (!check.allowed) {
    abortToolCall(event, "phase-order-blocked", check.reason ?? "Phase order violation");
    return { block: true, reason: check.reason };
  }

  return {};
}

/** Abort every active background run, then drop their handles. */
function abortActiveRuns(state: SessionState): void {
  for (const { abortController } of state.activeRuns.values()) {
    abortController.abort();
  }
  state.activeRuns.clear();
}

/** Forget delivered-run and active-run bookkeeping without aborting anything. */
function resetRunTracking(state: SessionState): void {
  state.deliveredRunIds.clear();
  state.activeRuns.clear();
}

/** Abort every active background run, then forget run bookkeeping. */
function abortAndResetRunTracking(state: SessionState): void {
  abortActiveRuns(state);
  // Invalidate the aborted runs' watchers: they must not deliver or mutate
  // state after the teardown (see SessionState.runEpoch).
  state.runEpoch += 1;
  state.deliveredRunIds.clear();
}

/**
 * Human-readable phase description, workflow-aware.
 *
 * In research workflows the "plan" phase is overridden to the research agent,
 * which records findings as a bead note — it never writes an implementation
 * plan file. Label it accordingly; otherwise the orchestrator reads "create
 * implementation plan" and re-delegates `belayd_plan` to force a research .md
 * file that the researcher contract explicitly forbids.
 */
function describePhase(phase: string, workflowType: WorkflowSubType): string {
  if (workflowType === "research" && phase === "plan") {
    return "Research the question and record findings as a bead note (never a .md file)";
  }
  const descriptions: Record<string, string> = {
    scout: "Fast codebase recon — returns structured findings",
    plan: "Create implementation plan",
    implement: "Implements code (runs typecheck+lint+tests)",
    review: "Adversarial code review",
    test: "Run the test suite",
    userguide: "Generate user-facing How to Verify and How to Use docs",
    proof:
      "Capture verifiable proof — UI changes need both a Playwright trace and playwright-cli screenshots",
    commit: "Commit changes",
  };
  return descriptions[phase] ?? phase;
}

/**
 * Shared fix-loop wording. The gate context, the workflow-start message, and
 * the run-completion follow-up all instruct the orchestrator the same way; one
 * helper keeps them from drifting.
 */
const REVIEW_LOOP_FIX_STEP =
  "call `belayd_implement` with those findings (it resumes the implementation session, so it sees its earlier work), then call `belayd_review` again (it resumes the review session) to verify";

// Phase-name constants for the review↔fix loop helpers (bd-81). Hoisted so the
// loop checks and the guidance strings cannot drift from the workflow phase
// names.
const IMPLEMENT_PHASE = "implement" as const;
const REVIEW_PHASE = "review" as const;
const COMMIT_PHASE = "commit" as const;
const RESUMABLE_PHASES = [IMPLEMENT_PHASE, REVIEW_PHASE] as const;

/** True for phases that participate in the cross-run session-resume ledger. */
function isResumablePhase(phaseName: string): phaseName is (typeof RESUMABLE_PHASES)[number] {
  return RESUMABLE_PHASES.some((phase) => phase === phaseName);
}

/**
 * Upper bound on the W6 collision-advance loop. A correctly-behaving `exists`
 * probe reaches the first absent epoch in a step or two; this cap only fires
 * when the injected probe never reports an absent epoch, guaranteeing the loop
 * terminates instead of spinning forever.
 */
const MAX_EPOCH_ADVANCES = 1000;

/**
 * Resolve a re-invocation's session, skipping past fresh cross-run epochs whose
 * name already exists on disk.
 *
 * A re-invocation that resolves to a FRESH epoch whose name already exists
 * means an earlier invocation minted that epoch but failed to persist the
 * ledger advance (W6). Spawning it as "fresh" would let pi's create-or-resume
 * `--session-id` silently replay the stale transcript with the system prompt
 * re-appended. Advance to the next non-colliding odd `-run-N` epoch instead of
 * resuming the collision: skipping preserves the transcript-bounding guarantee
 * even while the ledger write keeps failing (resuming would let one epoch grow
 * unbounded). `exists` is injected so the caller controls the on-disk probe.
 */
function advancePastExistingEpoch(options: {
  prior: PhaseSessionRecord | undefined;
  freshSessionName: string;
  exists: (sessionName: string) => boolean;
}): { sessionName: string; resumeSession: boolean; next: PhaseSessionRecord } {
  let resolved = resolvePhaseInvocation(options.prior, options.freshSessionName);
  if (options.prior === undefined) return resolved;
  let advances = 0;
  while (!resolved.resumeSession && options.exists(resolved.sessionName)) {
    if (advances >= MAX_EPOCH_ADVANCES) {
      // The `exists` probe never reported an absent epoch (e.g. a buggy or
      // mocked implementation). Stop probing and hand back a name outside the
      // `-run-<n>` namespace so termination never depends on the probe.
      const uniqueName = `${resolved.next.base}-run-x-${randomUUID()}`;
      return {
        sessionName: uniqueName,
        resumeSession: false,
        next: { base: resolved.next.base, invocations: resolved.next.invocations + 1 },
      };
    }
    advances += 1;
    resolved = resolvePhaseInvocation(
      { base: resolved.next.base, invocations: resolved.next.invocations + 1 },
      options.freshSessionName,
    );
  }
  return resolved;
}

/**
 * The resumable-fix directive: address findings before advancing. `nextPhaseTool`
 * is the tool that follows review in this workflow's phase order, so the
 * "advance only when clean" clause stays correct for any phaseOrder.
 */
function reviewLoopDirective(nextPhaseTool: string): string {
  return `If any Critical/Warnings remain, ${REVIEW_LOOP_FIX_STEP}. Only once no Critical/Warnings remain, call \`${nextPhaseTool}\`.`;
}

/**
 * Compose the body of the `belayd-run-complete` follow-up. Extracted from the
 * `deliver` callback so the callback stays under the complexity budget.
 */
function buildRunCompleteContent(delivery: RunDelivery, reviewLoopHint: string): string {
  const text = delivery.result.content?.[0]?.text ?? "";
  const header = delivery.success
    ? `✅ **${delivery.phaseName} phase completed** (run \`${delivery.runId}\`)`
    : `❌ **${delivery.phaseName} phase failed** (run \`${delivery.runId}\`)`;
  // Surface the classifier's reason so a zero-tool-call no-op is
  // distinguishable from a genuine agent failure without reading the log.
  const reasonNote =
    !delivery.success && delivery.failureReason ? `\n\n**Reason:** ${delivery.failureReason}` : "";
  const failureGuidance = delivery.success
    ? ""
    : `\n\nInspect the output and re-run \`belayd_${delivery.phaseName}\` if needed.`;
  return `${header}${reasonNote}\n\n${text}${failureGuidance}${reviewLoopHint}`;
}

/**
 * Apply the review output contract to a delivery (bd-113). Only a successful
 * review is bounded: a failed run's text is error output and must survive
 * intact for the orchestrator to act on.
 */
function boundReviewDelivery(delivery: RunDelivery): RunDelivery {
  if (!delivery.success || delivery.phaseName !== REVIEW_PHASE) return delivery;
  const [first, ...rest] = delivery.result.content;
  if (first === undefined) return delivery;
  return {
    ...delivery,
    result: {
      ...delivery.result,
      content: [{ ...first, text: boundReviewOutput(first.text).text }, ...rest],
    },
  };
}

/**
 * Build the review phase prompt with the change set inlined (bd-113).
 *
 * A first review sees the whole change; a re-review sees only the fix diff
 * since the sha the previous review recorded. When nothing can be collected
 * the task discloses the gap instead of silently sending a bare task. Any git
 * failure falls back to a disclosed scope rather than failing the phase.
 */
async function buildReviewTask(options: {
  taskId: string;
  paramsTask: string;
  cwd: string;
}): Promise<string> {
  const persisted = readWorkflowState({ cwd: options.cwd });
  // Only this task's recorded sha may scope the review; a stale workflow.json
  // from another task must not narrow (or widen) this task's diff.
  const reviewedSha =
    persisted !== undefined && persisted.taskId === options.taskId
      ? persisted.reviewedSha
      : undefined;
  if (reviewedSha === undefined || reviewedSha === "") {
    const firstReview = await collectReviewDiff({ cwd: options.cwd });
    if (!firstReview.ok) {
      return formatReviewTask({
        paramsTask: options.paramsTask,
        diffUnavailable: firstReview.error,
      });
    }
    return formatReviewTask({ paramsTask: options.paramsTask, diff: firstReview.value });
  }
  const rereview = await collectReviewDiff({ cwd: options.cwd, reviewedSha });
  if (rereview.ok) {
    return formatReviewTask({
      paramsTask: options.paramsTask,
      diff: rereview.value,
      priorFindings: options.paramsTask,
    });
  }
  // The whole-change-set diff is only needed for this fallback, so it is
  // collected lazily: paying for it on every re-review would re-introduce the
  // cost bd-113 removes.
  const firstReview = await collectReviewDiff({ cwd: options.cwd });
  if (!firstReview.ok) {
    return formatReviewTask({
      paramsTask: options.paramsTask,
      // Both scopes failed: disclose both reasons so the reviewer can pick up
      // the change set itself.
      diffUnavailable: `fix-only diff failed (${rereview.error}); whole-change-set diff failed (${firstReview.error})`,
      priorFindings: options.paramsTask,
    });
  }
  // The fix-only diff could not be computed (commonly: the recorded sha was
  // removed by a rebase). Fall back to the whole change set and say so, so the
  // reviewer knows the scope is wider than the fix round.
  const fallbackNote =
    `> Note: the fix-only diff since the previously reviewed revision could not be computed ` +
    `(${rereview.error}). This review covers the whole change set instead.`;
  return `${fallbackNote}\n\n${formatReviewTask({
    paramsTask: options.paramsTask,
    diff: firstReview.value,
    priorFindings: options.paramsTask,
  })}`;
}

/**
 * Review-findings guidance shared by the workflow-start and gate-context
 * messages. The reviewer emits Critical/Warnings/Suggestions; the orchestrator
 * must treat all three as input and disclose anything it declines.
 */
function reviewFindingsGuidanceLines(nextPhaseTool: string): string[] {
  return [
    "",
    "**Review findings** (after `belayd_review`):",
    "- Consider EVERY finding: Critical (must fix), Warnings (should fix), and Suggestions (consider).",
    "- Address all Critical and Warnings findings — you may NOT dismiss them.",
    `- Re-run the fix loop yourself: ${REVIEW_LOOP_FIX_STEP}.`,
    `- Repeat until no Critical/Warnings remain, then call \`${nextPhaseTool}\`. You may decline only Suggestions, and only with a reason.`,
    "- In the task's Final Summary, list every finding you chose not to address, each with a one-line reason.",
  ];
}

/**
 * Derive the tool for the phase that follows `phaseName` (defaulting to commit
 * at the end of the order), so loop messages never hard-code a phase name.
 */
function nextPhaseToolAfter(phaseName: string, phaseOrder: readonly string[]): string {
  const index = phaseOrder.indexOf(phaseName);
  if (index === -1) return getPhaseToolName(COMMIT_PHASE);
  return getPhaseToolName(phaseOrder[index + 1] ?? COMMIT_PHASE);
}

/**
 * True when review is completed and no later phase has run since — i.e. review
 * produced findings the orchestrator has not yet answered. Serves as the
 * disk-resume fallback; in-session updates use `nextAwaitingReviewResponse`
 * because `completedPhaseNames` never records a repeat of an already-completed
 * phase.
 */
function isAwaitingReviewResponse(
  completedPhaseNames: readonly string[],
  phaseOrder: readonly string[],
): boolean {
  const reviewIndex = phaseOrder.indexOf(REVIEW_PHASE);
  if (reviewIndex === -1 || !completedPhaseNames.includes(REVIEW_PHASE)) return false;
  return !completedPhaseNames.some((name) => phaseOrder.indexOf(name) > reviewIndex);
}

/**
 * Advance the resumable-fix flag for one completed phase. Review arms it; a
 * phase after review (test/userguide/proof/commit) disarms it; earlier phases
 * (scout, plan) leave it unchanged. An implement re-run re-arms it once review
 * has run, because implement is the fix half of the loop — a late fix loop
 * after test/userguide must still point back at review, not the next phase.
 * Pure set membership on `completedPhaseNames` cannot express this.
 */
function nextAwaitingReviewResponse(options: {
  awaiting: boolean;
  completedPhaseName: string;
  phaseOrder: readonly string[];
  reviewCompleted: boolean;
}): boolean {
  const reviewIndex = options.phaseOrder.indexOf(REVIEW_PHASE);
  if (reviewIndex === -1) return false;
  if (options.completedPhaseName === REVIEW_PHASE) return true;
  if (options.phaseOrder.indexOf(options.completedPhaseName) > reviewIndex) return false;
  if (options.completedPhaseName === IMPLEMENT_PHASE && options.reviewCompleted) return true;
  return options.awaiting;
}

/**
 * Apply one phase completion to the in-memory gate state. Shared by the run
 * watcher and the user-completion reconcile path so a recovered sub-agent
 * result advances the gate exactly like a normal settle.
 *
 * `outputText` is the phase's report: the spawn result's first text block on a
 * normal run, or the manifest's `completionReport` on a `/belayd-complete`
 * recovery. It feeds the userguide capture and the proof output the commit
 * phase consumes.
 */
function applyPhaseCompletion(
  state: SessionState,
  phaseName: string,
  outputText: string | undefined,
): void {
  state.completedPhaseNames = markPhaseCompleted(
    getPhaseToolName(phaseName),
    state.completedPhaseNames,
    state.phaseOrder,
  );
  // Order-sensitive: review arms the resumable-fix directive, a later phase
  // disarms it, and an earlier re-run (e.g. implement) leaves it alone so a
  // late re-review after test can re-arm it.
  state.awaitingReviewResponse = nextAwaitingReviewResponse({
    awaiting: state.awaitingReviewResponse,
    completedPhaseName: phaseName,
    phaseOrder: state.phaseOrder,
    reviewCompleted: state.completedPhaseNames.includes(REVIEW_PHASE),
  });
  if (phaseName === "userguide" && outputText !== undefined && outputText !== "") {
    state.userGuideContent = outputText;
  }
  if (phaseName === "proof") {
    state.proofOutput = outputText ?? "";
  }
}

/**
 * The per-turn next-step directive shown in the gate context. Extracted so the
 * three-way choice (wait / resumable fix loop / plain next phase) does not push
 * gateContextMessage over the cognitive-complexity limit.
 */
function gateNextStepLine(options: {
  activeRunCount: number;
  awaitingReviewResponse: boolean;
  remainingPhase: string;
}): string {
  if (options.activeRunCount > 0) {
    return "Waiting for active runs to complete — see above.";
  }
  if (options.awaitingReviewResponse) {
    return `Review findings need addressing. ${reviewLoopDirective(
      getPhaseToolName(options.remainingPhase),
    )}`;
  }
  return `Next required step: call \`${getPhaseToolName(options.remainingPhase)}\``;
}

// ── Extension factory ──────────────────────────────────────────────────

// This extension ships in two places that can load in the same process:
// globally at ~/.pi/agent/extensions/belayd-harness.ts (Nix-installed) and
// project-locally via .pi/settings.json → extensions/index.ts. When pi runs
// inside this repo or one of its worktrees, both load, and pi's post-load
// conflict detection reports every duplicate belayd_* tool as
// "Tool X conflicts with ...".
//
// Dedup keys on the extension load batch's shared event bus (via `pi.events`).
// Every extension in one `loadExtensions` call shares one bus; separate
// batches — the pi-web provider-bootstrap pass and each session — get their
// own. A claim on the bus therefore scopes to "this session":
// - CLI: only one copy loads anyway (bin/pi and the Nix pi both use -ne).
// - pi-web: the global and project copies in one session share a bus, so the
//   first copy wins and the second is a no-op; a later session has a fresh bus
//   and registers again.
//
// A process-wide boolean was tried and broke pi-web: the provider-bootstrap
// pass set it once, then every real session saw the stale flag and registered
// nothing. `pi.getAllTools()` / `pi.getCommands()` can't be used here either —
// they are "action methods" that throw "Extension runtime not initialized"
// until Runner.bindCore() runs after all extensions finish loading.
const CLAIM_CHANNEL = "__belayd_harness_claim__";

/**
 * True when another harness copy in this load batch already claimed
 * registration. The probe listener is left in place for the first copy so
 * later copies in the same batch count it and yield; the shared bus is
 * discarded with its session, so nothing leaks across sessions.
 */
function harnessAlreadyLoaded(pi: ExtensionAPI): boolean {
  return !claimRegistrationOnce(pi, CLAIM_CHANNEL);
}

// Build identity for the stale-build guard. In the Nix-installed copy this is
// file:///nix/store/<hash>-belayd-harness/extensions/index.ts, so the load log
// below reveals exactly which build registered the tools — the trap hit when
// pi-web kept a pre-fallback extension in memory after a rebuild.
const HARNESS_MODULE_PATH: string = import.meta.url;

/** Raw `belayd_archify` parameters before validation/defaults. */
interface ArchifyRawParams {
  type?: string;
  input?: string;
  output?: string;
  command?: string;
  quality?: string;
  repoRoot?: string;
  scenario?: string;
}

/**
 * A validated `belayd_archify` invocation, tagged by the work to perform.
 * `diagram` covers the original render/validate/deliver path; the rest are
 * read-only guidance commands. `inspect` is modeled with the literal
 * `architecture` type because archify only supports inspection of that IR.
 */
type ArchifyValidatedParams =
  | {
      kind: "diagram";
      command: ArchifyCommand;
      type: ArchifyDiagramType;
      quality: ArchifyQuality;
      input: string;
      output: string | undefined;
      repoRoot: string | undefined;
    }
  | { kind: "inspect"; type: "architecture"; input: string }
  | { kind: "check"; input: string }
  | { kind: "guide"; scenario: string | undefined }
  | { kind: "examples" };

type ArchifyParamValidation =
  | { ok: true; value: ArchifyValidatedParams }
  | { ok: false; error: string };

/** Validate render/validate/deliver params (the diagram-writing path). */
function validateDiagramParams(
  params: ArchifyRawParams,
  command: ArchifyCommand,
): ArchifyParamValidation {
  const type = params.type;
  if (type === undefined || !isArchifyDiagramType(type)) {
    return {
      ok: false,
      error: `Unknown diagram type: ${type ?? "(missing)"}. Supported types: ${ARCHIFY_DIAGRAM_TYPES.join(", ")}.`,
    };
  }

  const input = params.input;
  if (input === undefined || input === "") {
    return { ok: false, error: "input is required for render/validate/deliver commands." };
  }

  const quality = params.quality ?? "showcase";
  if (!isArchifyQuality(quality)) {
    return {
      ok: false,
      error: `Unknown quality profile: ${quality}. Supported profiles: ${ARCHIFY_QUALITY_PROFILES.join(", ")}.`,
    };
  }

  return {
    ok: true,
    value: {
      kind: "diagram",
      command,
      type,
      quality,
      input,
      output: params.output,
      repoRoot: params.repoRoot,
    },
  };
}

/** Validate `inspect`, which archify only exposes for architecture IRs. */
function validateInspectParams(params: ArchifyRawParams): ArchifyParamValidation {
  if (params.type !== "architecture") {
    return { ok: false, error: "inspect only supports the architecture type." };
  }
  const input = params.input;
  if (input === undefined || input === "") {
    return { ok: false, error: "input is required for command=inspect." };
  }
  return { ok: true, value: { kind: "inspect", type: "architecture", input } };
}

/** Validate `check`, which takes only the delivered artifact path. */
function validateCheckParams(params: ArchifyRawParams): ArchifyParamValidation {
  const input = params.input;
  if (input === undefined || input === "") {
    return { ok: false, error: "input is required for command=check." };
  }
  return { ok: true, value: { kind: "check", input } };
}

/**
 * Validate the raw `belayd_archify` params and apply command/quality defaults.
 *
 * Kept separate from the tool's `execute` so the rejection messages stay flat
 * (and the tool body stays under the cognitive-complexity budget). Per-command
 * rules live in small helpers dispatched from one switch.
 */
function validateArchifyParams(params: ArchifyRawParams): ArchifyParamValidation {
  const command = params.command ?? "deliver";
  if (!isArchifyToolCommand(command)) {
    return {
      ok: false,
      error: `Unknown command: ${command}. Supported commands: ${ARCHIFY_TOOL_COMMANDS.join(", ")}.`,
    };
  }

  switch (command) {
    case "guide": {
      const scenario = params.scenario;
      // A leading `--` would be parsed by upstream as a flag, not a scenario.
      if (scenario?.startsWith("--")) {
        return {
          ok: false,
          error:
            "scenario must not start with `--` (archify would parse it as a flag); pass plain text.",
        };
      }
      return { ok: true, value: { kind: "guide", scenario } };
    }
    case "examples":
      return { ok: true, value: { kind: "examples" } };
    case "inspect":
      return validateInspectParams(params);
    case "check":
      return validateCheckParams(params);
    case "render":
    case "validate":
    case "deliver":
      return validateDiagramParams(params, command);
    default:
      return { ok: false, error: `Unknown command: ${command}.` };
  }
}

/** Raw `belayd_outline` parameters before validation. */
interface OutlineRawParams {
  path?: string;
  kind?: string[];
  name?: string;
  maxSymbols?: number;
}

/** Validated `belayd_outline` params. */
interface OutlineValidatedParams {
  path: string;
  kind: OutlineKind[] | undefined;
  name: string | undefined;
  maxSymbols: number | undefined;
}

type OutlineParamValidation =
  | { ok: true; value: OutlineValidatedParams }
  | { ok: false; error: string };

/**
 * Validate the raw `belayd_outline` params.
 *
 * Kept separate from `execute` so rejection messages stay flat and the tool
 * body stays under the cognitive-complexity budget.
 */
function validateOutlineParams(params: OutlineRawParams): OutlineParamValidation {
  const path = params.path;
  if (path === undefined || path.trim() === "") {
    return {
      ok: false,
      error: "path is required (a file, directory, or glob such as src/**/*.ts).",
    };
  }

  const rawKinds = params.kind;
  let kind: OutlineKind[] | undefined;
  if (rawKinds !== undefined) {
    for (const value of rawKinds) {
      if (!isOutlineKind(value)) {
        return {
          ok: false,
          error: `Unknown kind: ${value}. Supported kinds: ${OUTLINE_KINDS.join(", ")}.`,
        };
      }
    }
    kind = rawKinds.filter(isOutlineKind);
  }

  const maxSymbols = params.maxSymbols;
  if (maxSymbols !== undefined && (!Number.isInteger(maxSymbols) || maxSymbols < 1)) {
    return { ok: false, error: "maxSymbols must be a positive integer." };
  }

  return { ok: true, value: { path, kind, name: params.name, maxSymbols } };
}

/**
 * Read every resolved outline target into memory.
 *
 * Returns an error value (never throws) so the tool can report a partial
 * failure as text instead of crashing the session.
 */
function readOutlineSources(
  paths: string[],
): { ok: true; files: Array<{ path: string; source: string }> } | { ok: false; error: string } {
  const files: Array<{ path: string; source: string }> = [];
  for (const path of paths) {
    try {
      files.push({ path, source: readFileSync(path, "utf8") });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to read ${path}: ${message}` };
    }
  }
  return { ok: true, files };
}

/** Resolve, read, and format an outline. Errors are values, never throws. */
function buildOutlineText(
  cwd: string,
  params: OutlineValidatedParams,
): { ok: true; text: string } | { ok: false; error: string } {
  const resolved = resolveOutlineTargets(cwd, params.path);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const sources = readOutlineSources(resolved.files);
  if (!sources.ok) return { ok: false, error: sources.error };

  const options: OutlineFilesOptions = {};
  if (params.kind !== undefined) options.kind = params.kind;
  if (params.name !== undefined) options.nameMatches = params.name;
  if (params.maxSymbols !== undefined) options.maxSymbols = params.maxSymbols;

  // A walk-capped resolution knows no true match total (the walk stopped
  // early), so the file-cap "matched N files" wording would be a false claim.
  // Distinguish the two causes so the note never overstates coverage.
  const truncatedNote =
    resolved.truncatedBy === "walk-cap"
      ? "\n\nnote: walk stopped at the entry cap; results may be incomplete."
      : `\n\nnote: matched ${resolved.totalMatches ?? resolved.files.length} files; showing the first ${resolved.files.length}.`;
  const note = resolved.truncated ? truncatedNote : "";
  return { ok: true, text: `${formatOutline(outlineFiles(sources.files, options))}${note}` };
}

/**
 * Narrow a `tool_call` event to pi's built-in bash input.
 *
 * Pi's `ToolCallEvent` union does not discriminate on `toolName` because
 * `CustomToolCallEvent.toolName` is `string` and therefore overlaps every
 * literal, so a direct `event.toolName === "bash"` check does not narrow. The
 * predicate accepts pi's canonical "bash" plus the legacy "Bash" casing used
 * by the other guards in this extension, and narrows `input` to `BashToolInput`
 * so the in-place timeout patch typechecks without widening it to `unknown`.
 */
function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
  return event.toolName === "bash" || event.toolName === "Bash";
}

export default function belaydAgentHarness(pi: ExtensionAPI): void {
  if (harnessAlreadyLoaded(pi)) return;

  console.warn(`[belayd-harness] registering tools/commands from ${HARNESS_MODULE_PATH}`);

  const GATED_TOOLS = [
    ...ALL_PHASE_TOOLS,
    "belayd_start_task",
    "belayd_start_followup",
    "belayd_stack_rebase",
    "belayd_stop_task",
    "belayd_status",
    "belayd_proof_verifier",
    "belayd_archify",
    "belayd_outline",
    "bd",
    "read",
    "grep",
    "find",
    "ls",
  ];

  const PLANNING_GATED_TOOLS = [
    ...PLANNING_MODE_TOOLS,
    "belayd_plan_scout",
    "belayd_plan_research",
    "belayd_status",
    "belayd_stop_planning",
  ];

  /**
   * Derive the active tool set from session state instead of stashing
   * incrementally. A single `fullTools` stash, guarded by the current mode
   * flags, makes interleaved gate↔planning transitions always converge on the
   * correct set — the full original tools are only restored once both modes
   * are off, so edit/write/bash can never leak back into an active mode.
   */
  function applyToolGate(state: SessionState): void {
    if (state.planningActive) {
      if (state.fullTools === undefined) state.fullTools = pi.getActiveTools();
      pi.setActiveTools(PLANNING_GATED_TOOLS);
      return;
    }
    if (state.gateActive) {
      if (state.fullTools === undefined) state.fullTools = pi.getActiveTools();
      pi.setActiveTools(GATED_TOOLS);
      return;
    }
    if (state.fullTools !== undefined) {
      pi.setActiveTools(state.fullTools);
      state.fullTools = undefined;
    }
  }

  function activateGate(options: {
    ctx: { sessionManager: { getSessionId: () => string } };
    taskId: string;
    workflowType?: WorkflowSubType;
    cwd: string;
    branch?: string;
    originalCwd?: string;
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
  }): SessionState {
    const { ctx, taskId, workflowType, cwd } = options;
    // A new workflow starts a fresh per-workflow telemetry store; flush the
    // previous workflow's rows first so they are not lost on reset.
    resetModelTelemetry(cwd);
    const state = getSessionState(ctx);
    state.gateActive = true;
    state.planningActive = false;
    state.planningTarget = undefined;
    state.completedPhaseNames = [];
    state.currentTaskId = taskId;
    state.proofBase = undefined;
    state.workflowType = workflowType ?? "feature";
    applyWorkflowConfig(state);
    state.userGuideContent = undefined;
    state.proofOutput = undefined;
    state.proofVerifierVerdict = undefined;
    state.awaitingReviewResponse = false;
    abortAndResetRunTracking(state);
    applyToolGate(state);
    reconcileWorkflowState(state, { taskId, cwd, options });
    return state;
  }

  /** Point the session state at a workflow's ordered phases and consult set. */
  function applyWorkflowConfig(state: SessionState): void {
    state.phaseOrder = getPhasesForType(state.workflowType);
    state.optionalPhases = WORKFLOW_REGISTRY[state.workflowType].optionalPhases ?? [];
    state.consultPhases = WORKFLOW_REGISTRY[state.workflowType].consultPhases ?? [];
  }

  /** Build the workflow.json identity payload for a freshly-activated gate. */
  function buildPersistedWorkflowState(options: {
    state: SessionState;
    taskId: string;
    cwd: string;
    branch?: string;
    originalCwd?: string;
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
  }): WorkflowState {
    const now = Date.now();
    return {
      schemaVersion: 1,
      taskId: options.taskId,
      workflowType: options.state.workflowType,
      resolutionSource: options.resolutionSource ?? "default",
      ...(options.matchedLabel !== undefined ? { matchedLabel: options.matchedLabel } : {}),
      branch: options.branch ?? "",
      originalCwd: options.originalCwd ?? options.cwd,
      phaseOrder: [...options.state.phaseOrder],
      completedPhaseNames: [],
      startedAt: now,
      updatedAt: now,
    };
  }

  /** Reconcile a newly-activated gate with persisted workflow state. */
  function reconcileWorkflowState(
    state: SessionState,
    input: {
      taskId: string;
      cwd: string;
      options: {
        branch?: string;
        originalCwd?: string;
        resolutionSource?: WorkflowResolutionSource;
        matchedLabel?: string;
      };
    },
  ): void {
    const persisted = readWorkflowState({ cwd: input.cwd });
    if (persisted === undefined || persisted.taskId !== input.taskId) {
      const writeResult = writeWorkflowState({
        cwd: input.cwd,
        state: buildPersistedWorkflowState({
          state,
          taskId: input.taskId,
          cwd: input.cwd,
          branch: input.options.branch,
          originalCwd: input.options.originalCwd,
          resolutionSource: input.options.resolutionSource,
          matchedLabel: input.options.matchedLabel,
        }),
      });
      if (!writeResult.ok) {
        console.warn(`[belayd-harness] failed to persist workflow state: ${writeResult.error}`);
      }
      return;
    }

    state.workflowType = isValidWorkflowType(persisted.workflowType)
      ? persisted.workflowType
      : "feature";
    state.phaseOrder = [...persisted.phaseOrder];
    state.optionalPhases = WORKFLOW_REGISTRY[state.workflowType].optionalPhases ?? [];
    state.consultPhases = WORKFLOW_REGISTRY[state.workflowType].consultPhases ?? [];
    state.completedPhaseNames = persisted.completedPhaseNames.filter((phase) =>
      state.phaseOrder.includes(phase),
    );
    state.awaitingReviewResponse =
      persisted.awaitingReviewResponse ??
      isAwaitingReviewResponse(state.completedPhaseNames, state.phaseOrder);
  }

  /** One-line phases/proof summary for a workflow type. */
  function describeWorkflowType(type: WorkflowSubType): string {
    const config = WORKFLOW_REGISTRY[type];
    const proof = config.proofRequired ? "proof required" : "no proof";
    return `${type}: ${config.phases.join(" → ")} (${proof})`;
  }

  /** Human-facing provenance phrase for the resolved workflow type. */
  function describeResolutionSource(resolution: {
    source: WorkflowResolutionSource;
    matchedLabel?: string;
  }): string {
    switch (resolution.source) {
      case "arg":
        return "type set explicitly";
      case "label":
        return `resolved from label ${resolution.matchedLabel ?? `${WF_LABEL_PREFIX}<type>`}`;
      case "default":
        return "defaulted to feature (no explicit type)";
    }
  }

  /**
   * Persist the effective type back to the bead as a `wf:<type>` label so a
   * later run resolves without prompting. Best-effort: a bd failure is logged
   * but never blocks an already-resolved workflow.
   */
  async function writeWorkflowTypeLabel(options: {
    taskId: string;
    type: WorkflowSubType;
    cwd: string;
    existingLabels?: string[];
  }): Promise<void> {
    if (parseWorkflowLabel(options.existingLabels)?.type === options.type) return;
    const label = `${WF_LABEL_PREFIX}${options.type}`;
    try {
      await runBdCommand(["update", "--add-label", label, "--", options.taskId], {
        cwd: options.cwd,
        stdin: undefined,
        timeoutInMs: 15_000,
        maxBufferInBytes: 1024 * 1024,
      });
    } catch (error) {
      console.warn(
        `[belayd-harness] could not write ${label} to ${options.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  type WorkflowConfirmationOutcome =
    | { kind: "confirmed"; type: WorkflowSubType; source: WorkflowResolutionSource }
    | { kind: "cancelled" };

  /**
   * Confirm a wf: label-driven resolution and write the effective type back to
   * the bead as a `wf:<type>` label. A non-label resolution passes straight
   * through. Returns `cancelled` when the user declines (or no UI is present).
   *
   * `persisted` reports whether this helper already wrote the confirmed label,
   * so a caller must not issue a second identical `bd update` (the label was
   * written from a stale label snapshot and would otherwise round-trip).
   */
  async function confirmAndPersistResolution(options: {
    ctx: ExtensionContext;
    taskId: string;
    resolution: WorkflowResolution;
    existingLabels?: string[];
  }): Promise<
    { kind: "resolved"; resolution: WorkflowResolution; persisted: boolean } | { kind: "cancelled" }
  > {
    const { ctx, taskId, resolution, existingLabels } = options;
    if (!resolution.requiresConfirmation) {
      return { kind: "resolved", resolution, persisted: false };
    }

    const confirmation = await confirmLabelWorkflowType({ ctx, resolution });
    if (confirmation.kind === "cancelled") return { kind: "cancelled" };

    const resolved: WorkflowResolution = {
      type: confirmation.type,
      source: confirmation.source,
      matchedLabel: resolution.matchedLabel,
      requiresConfirmation: false,
    };
    await writeWorkflowTypeLabel({
      taskId,
      type: confirmation.type,
      cwd: ctx.cwd,
      existingLabels,
    });
    return { kind: "resolved", resolution: resolved, persisted: true };
  }

  /** Explain why a wf:-driven workflow was not started, without side effects. */
  function deniedConfirmationText(resolution: WorkflowResolution): string {
    return (
      `Workflow type "${resolution.type}" comes from bead label "${resolution.matchedLabel}" ` +
      "and requires confirmation, but no interactive confirmation was available. " +
      "No workflow was started. Confirm with /belayd, or pass workflowType explicitly to override."
    );
  }

  /**
   * Resolve a wf: label for a *tool* call. Tools prompt only when the session
   * reports UI ({@link ExtensionContext.hasUI}); a headless `pi --mode json`
   * subagent denies instead of silently defaulting.
   */
  async function resolveToolWorkflowResolution(options: {
    ctx: ExtensionContext;
    taskId: string;
    resolution: WorkflowResolution;
    existingLabels?: string[];
  }): Promise<
    | { kind: "resolved"; resolution: WorkflowResolution; persisted: boolean }
    | { kind: "denied"; text: string }
  > {
    const { ctx, taskId, resolution, existingLabels } = options;
    if (!resolution.requiresConfirmation) {
      return { kind: "resolved", resolution, persisted: false };
    }
    if (ctx.hasUI !== true) return { kind: "denied", text: deniedConfirmationText(resolution) };

    const confirmed = await confirmAndPersistResolution({
      ctx,
      taskId,
      resolution,
      existingLabels,
    });
    if (confirmed.kind === "cancelled") {
      return { kind: "denied", text: deniedConfirmationText(resolution) };
    }
    return { kind: "resolved", resolution: confirmed.resolution, persisted: confirmed.persisted };
  }

  /**
   * Confirm a label-driven workflow type before any side effects. A choose-
   * another-type pick is explicit, so it is reported with `source: "arg"` and
   * does not prompt again. A dismissed dialog — or a JSON-mode subagent whose
   * `ctx.ui` has no interactive implementation — resolves to `undefined`, which
   * is treated as cancel rather than a silent default.
   */
  async function confirmLabelWorkflowType(options: {
    ctx: ExtensionContext;
    resolution: WorkflowResolution;
  }): Promise<WorkflowConfirmationOutcome> {
    const { ctx, resolution } = options;
    const matchedLabel = resolution.matchedLabel ?? `${WF_LABEL_PREFIX}<type>`;
    const choice = await ctx.ui.select(
      `Workflow type "${resolution.type}" came from label "${matchedLabel}".\n${describeWorkflowType(
        resolution.type,
      )}\nConfirm this workflow type?`,
      [`Confirm ${resolution.type}`, "Choose another type", "Cancel"],
    );
    if (choice === undefined || choice === "Cancel") return { kind: "cancelled" };
    if (choice === "Choose another type") {
      const picked = await ctx.ui.select(
        "Choose a workflow type",
        WORKFLOW_SUB_TYPES.map((type) => describeWorkflowType(type)),
      );
      if (picked === undefined) return { kind: "cancelled" };
      const type = WORKFLOW_SUB_TYPES.find((candidate) => picked.startsWith(`${candidate}:`));
      if (type === undefined) return { kind: "cancelled" };
      return { kind: "confirmed", type, source: "arg" };
    }
    return { kind: "confirmed", type: resolution.type, source: "label" };
  }

  /** Append type-specific guidance bullets to an in-progress workflow message. */
  function appendWorkflowGuidance(
    lines: string[],
    type: WorkflowSubType,
    phases: readonly string[],
  ): void {
    // When the workflow declares consult phases, the bead's description/design/
    // notes are the plan — /plan already wrote it. The scout/plan tools remain
    // available only as consultation when that plan is unclear, and are NOT
    // required steps in the phase order.
    const consultPhases = WORKFLOW_REGISTRY[type].consultPhases ?? [];
    if (consultPhases.length > 0) {
      const consultTools = consultPhases.map((p) => `\`belayd_${p}\``).join(" and ");
      lines.push(
        "",
        "**Plan source** — this bead's description/design/notes are the implementation plan. Read them first (via `bd show`) and implement from them.",
        `${consultTools} are available as consultation (NOT required steps) — use them if the plan is sparse or unclear before implementing. They do not gate progress.`,
      );
    }

    // Research workflows: the plan phase is the research agent — it records
    // findings as a bead note (not a .md file). Create follow-up tasks before
    // committing so they're included in the final commit.
    if (type === "research") {
      lines.push(
        "",
        "**Research deliverable:**",
        "- `belayd_plan` is the research agent. Pass it the task ID and the research question; it records findings as a bead note (never a research .md file).",
        "- The deliverable is the bead note — NOT a committed file. Do not re-delegate `belayd_plan` to write a research .md file, and do not expect `belayd_commit` to commit one.",
        "",
        "**Before `belayd_commit`:**",
        '- Create follow-up implementation tasks with the `bd` tool (e.g. `bd create --title="..." --type=task`) for any action items uncovered.',
      );
    }

    // Only workflows that include a review phase need this rule; the reviewer
    // output otherwise never exists.
    if (phases.includes(REVIEW_PHASE)) {
      lines.push(...reviewFindingsGuidanceLines(nextPhaseToolAfter(REVIEW_PHASE, phases)));
    }

    if (phases.includes("proof")) {
      lines.push(
        "",
        "A `belayd_proof_verifier` tool is available after the proof phase — it is an advisory, non-blocking review of proof relevance and plausibility.",
        "For UI changes, the `belayd_proof` task MUST require both a Playwright trace and playwright-cli screenshots of the changed pages; a missing test-runner browser is not a skip reason.",
      );
    }
  }

  function sendWorkflowMessage(
    sender: { sendMessage: ExtensionAPI["sendMessage"] },
    taskId: string,
    branch: string | null,
    workflowType?: WorkflowSubType,
    phaseOrder?: readonly string[],
    resolution?: { source: WorkflowResolutionSource; matchedLabel?: string },
  ): void {
    const type = workflowType ?? "feature";
    const phases = phaseOrder ?? getPhasesForType(type);

    const typeDescriptions: Record<string, string> = {
      feature: "This is a FEATURE task — new functionality.",
      bugfix: "This is a BUGFIX task — fixing a bug.",
      research: "This is a RESEARCH task — no code changes expected.",
      chore:
        "This is a CHORE task — small, low-risk tooling/config changes; no review or proof phase.",
      documentation: "This is a DOCUMENTATION task — docs-only changes.",
      refactor: "This is a REFACTOR task — internal code changes, no behavioral change.",
      hotfix: "This is a HOTFIX task — urgent fix, minimal process.",
    };

    const provenanceLine = resolution
      ? [`Type provenance: ${describeResolutionSource(resolution)}.`]
      : [];
    const lines: string[] = [
      `**Belayd ${type} workflow started for ${taskId}.**`,
      ...(branch ? [`Worktree: \`${branch}\``, ""] : []),
      "",
      typeDescriptions[type] ?? `Workflow type: ${type}.`,
      ...provenanceLine,
      `Phases: ${phases.join(" → ")}`,
      "",
      "Editing and writing tools are DISABLED. You MUST delegate to phase tools:",
    ];

    phases.forEach((phase, i) => {
      lines.push(`${i + 1}. \`belayd_${phase}\` — ${describePhase(phase, type)}`);
    });

    lines.push("", `Next required step: call \`belayd_${phases[0] ?? "commit"}\``);
    appendWorkflowGuidance(lines, type, phases);

    lines.push("", "**After workflow completion:**");
    lines.push(
      `- Flag this task for human review (NEVER close it yourself): pass \`taskId\` to \`belayd_commit\`, or run \`bd update ${taskId} --status in_progress --add-label human\` with the \`bd\` tool.`,
    );

    sender.sendMessage(
      {
        customType: "belayd-command",
        content: lines.join("\n"),
        display: true,
      },
      { triggerTurn: true },
    );
  }

  const emptyUsage = () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    toolCalls: 0,
  });

  /** Shape a plain-text tool response with an explicit exit code. */
  function textToolResult(text: string, exitCode: number) {
    return {
      content: [{ type: "text" as const, text }],
      details: { messages: [], usage: emptyUsage(), exitCode },
    };
  }

  /** Shape a read-only guidance result (exit 1 on transport/parse failure). */
  function textResultFromRun(result: ArchifyTextResult, note: string) {
    const base = result.ok ? result.text : result.error;
    return textToolResult(`${base}${note}`, result.ok ? 0 : 1);
  }

  /** Exec options shared by every archify subcommand (renderer and guidance). */
  function archifyRunOptions(cwd: string) {
    return { cwd, timeoutInMs: 60_000, maxBufferInBytes: 8 * 1024 * 1024 };
  }

  /** Render/validate/deliver path: unchanged from bd-85. */
  async function archifyDiagramToolResult(
    value: Extract<ArchifyValidatedParams, { kind: "diagram" }>,
    cwd: string,
  ) {
    const { type, command, quality, input, output, repoRoot } = value;
    const defaultOutput = join(cwd, "docs", "diagrams", `${type}.html`);

    // `validate` takes no output positional; only render/deliver write files.
    const args = buildArchifyArgs({
      command,
      type,
      input,
      output: command === "validate" ? undefined : (output ?? defaultOutput),
      quality,
      repoRoot,
    });

    const result = await runArchify(args, archifyRunOptions(cwd));
    const note =
      command === "validate" && output !== undefined
        ? "\n\nnote: `output` is ignored for `validate`; only render/deliver write files."
        : "";
    return textToolResult(
      `${formatArchifyResult(result)}${note}`,
      result.ok && result.receipt.ok ? 0 : 1,
    );
  }

  /**
   * Run one read-only guidance subcommand (`guide`/`inspect`/`check`/`examples`)
   * and shape its tool response. Split from `execute` so neither function
   * exceeds the cognitive-complexity budget.
   */
  async function archifyGuidanceToolResult(
    value: Exclude<ArchifyValidatedParams, { kind: "diagram" }>,
    cwd: string,
    note: string,
  ) {
    switch (value.kind) {
      case "guide":
        return textResultFromRun(
          await runArchifyText(
            buildArchifyGuideArgs({ scenario: value.scenario }),
            archifyRunOptions(cwd),
          ),
          note,
        );
      case "inspect":
        return textResultFromRun(
          await runArchifyText(
            buildArchifyInspectArgs({ type: value.type, input: value.input }),
            archifyRunOptions(cwd),
          ),
          note,
        );
      case "check":
        return textResultFromRun(
          await runArchifyText(buildArchifyCheckArgs(value.input), archifyRunOptions(cwd)),
          note,
        );
      case "examples":
        return archifyExamplesToolResult(note);
    }
  }

  /**
   * `examples` lists the packaged IR files directly. Shelling out to
   * `archify examples` is not an option: it renders HTML into the read-only
   * Nix store at `$ARCHIFY_HOME/examples/`, which fails at runtime.
   */
  function archifyExamplesToolResult(note: string) {
    const home = resolveArchifyHome(process.env);
    if (!home.ok) return textToolResult(`${home.error}${note}`, 1);

    const listed = listArchifyExamples(home.home);
    if (!listed.ok) return textToolResult(`${listed.error}${note}`, 1);
    if (listed.examples.length === 0) {
      return textToolResult(`No example IRs found under ${home.home}/examples.${note}`, 0);
    }

    const lines = [
      `archify examples (${listed.examples.length}):`,
      ...listed.examples.map((path) => `  ${path}`),
    ];
    return textToolResult(`${lines.join("\n")}${note}`, 0);
  }

  /** Maximum number of agent passes over the quality gate (1 initial + retries). */
  const MAX_GATE_ATTEMPTS = 10;

  /** Append a quality-gate verdict to an agent result. */
  function withGateResult(result: SpawnResult, header: string, feedback: string): SpawnResult {
    const existingContent = result.content?.[0]?.text ?? "";
    return {
      content: [
        { type: "text" as const, text: `${existingContent}\n\n---\n${header}\n${feedback}` },
      ],
      details: result.details,
    };
  }

  /** Surface a model fallback (if any) as a trailing note on the agent result. */
  function withFallbackNote(result: SpawnResult, attempts: SpawnAttempt[]): SpawnResult {
    if (attempts.length <= 1) return result;
    const trail = attempts
      .map((a) => {
        if (a.skippedCooldown) return `${a.model} (cooldown)`;
        if (a.skippedProvider) return `${a.model} (provider ${a.skippedProvider} exhausted)`;
        if (a.skippedCapacity)
          return `${a.model} (provider ${a.skippedCapacity} capacity-exhausted)`;
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
  function spawnGateRetry(agent: AgentDefinition, options: GateRetryOptions): Promise<SpawnResult> {
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
    return spawnAgentWithFallback({
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
      cooldownStore: modelCooldown,
      enabled: modelFallbackEnabled,
      phase: options.phaseName,
      telemetry: options.telemetry ?? modelState.telemetry,
      capacity: modelState.capacity,
    }).then((r) => r.result);
  }

  /** Gate context forwarded into `GateOptions` for the run that produced the output. */
  interface GateRunContext {
    cwd?: string;
    proofDir?: string;
    proofRequired?: boolean;
    proofRunStartMs?: number;
  }

  /** Run a quality gate over a result, normalizing the feedback text. */
  async function evaluateGate(
    gate: QualityGate,
    result: SpawnResult,
    context: GateRunContext,
  ): Promise<{ passed: boolean; feedback: string }> {
    const { cwd, proofDir, proofRequired, proofRunStartMs } = context;
    const options =
      cwd !== undefined ||
      proofDir !== undefined ||
      proofRequired !== undefined ||
      proofRunStartMs !== undefined
        ? { cwd, proofDir, proofRequired, proofRunStartMs }
        : undefined;
    const text = result.content?.[0]?.text ?? "";
    const outcome = await gate(text, result.details, options);
    return {
      passed: outcome.passed,
      feedback: outcome.feedback ?? (outcome.passed ? "All quality gates passed." : "Failed"),
    };
  }

  async function runQualityGate(options: RunQualityGateOptions): Promise<SpawnResult | null> {
    const { agent, result, task, workflowType, phaseName } = options;
    if (!ALL_PHASE_NAMES.includes(phaseName)) return null;
    const effectiveGate = resolveQualityGate(phaseName as Phase, workflowType, agent.qualityGate);
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
      current = await spawnGateRetry(agent, {
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
        originalTask: task,
        feedbackHistory,
      });
    }

    return current;
  }

  // ── Worktree creation helper ────────────────────────────────────────
  function ensureWorktree(projectRoot: string, branch: string, base?: string): string | undefined {
    try {
      return isInsideWorktreeForBranch(projectRoot, branch)
        ? projectRoot
        : setupWorktree(projectRoot, { branch, base });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pi.sendMessage({
        customType: "belayd-error",
        content: `Worktree creation failed: ${message}`,
        display: true,
      });
      return undefined;
    }
  }

  // ── Task file helpers ─────────────────────────────────────────────────

  /** Labels resolved from a beads issue. */
  interface TaskMetadata {
    labels?: string[];
  }

  /** Read labels from a beads issue via `bd show --json`. */
  async function readTaskMetadata(taskId: string, cwd: string): Promise<TaskMetadata | undefined> {
    try {
      const { stdout } = await runBdCommand(["show", taskId, "--json"], {
        cwd,
        stdin: undefined,
        timeoutInMs: 15_000,
        maxBufferInBytes: 1024 * 1024,
      });
      return parseTaskMetadata(stdout);
    } catch {
      return undefined;
    }
  }

  /** Parse the output of `bd show --json` into task metadata. */
  function parseTaskMetadata(stdout: string): TaskMetadata | undefined {
    try {
      const parsed: unknown = JSON.parse(stdout);
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!item || typeof item !== "object") return undefined;
      const record = item as { labels?: unknown };
      return {
        labels: Array.isArray(record.labels)
          ? record.labels.filter((l): l is string => typeof l === "string")
          : undefined,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Read a bead's full plain-text content via `bd show <taskId>`.
   * Returns undefined on error so callers can proceed without the plan.
   */
  async function readTaskPlan(taskId: string, cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await runBdCommand(["show", taskId], {
        cwd,
        stdin: undefined,
        timeoutInMs: 15_000,
        maxBufferInBytes: 1024 * 1024,
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // ── Session daemon helpers ────────────────────────────────────────────

  /** Path to the pi-web session daemon Unix socket. */
  function sessiondSocketPath(): string {
    return process.env.PI_WEB_SESSIOND_SOCKET ?? join(homedir(), ".pi-web", "sessiond.sock");
  }

  /** Make an HTTP request to the session daemon via Unix socket. */
  function daemonRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: sessiondSocketPath(),
          method,
          path,
          headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            if (res.statusCode !== undefined && res.statusCode >= 400) {
              reject(errorFromResponse(data, res.statusCode));
            } else {
              resolve(responseBodyOrRaw(data));
            }
          });
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /** Build an Error from a non-2xx daemon response body. */
  function errorFromResponse(data: string, statusCode: number): Error {
    try {
      const parsed = JSON.parse(data) as { error?: string };
      return new Error(parsed.error ?? data);
    } catch {
      return new Error(data || `HTTP ${statusCode}`);
    }
  }

  /** Parse a daemon JSON body, falling back to the raw string. */
  function responseBodyOrRaw(data: string): Record<string, unknown> {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return data as unknown as Record<string, unknown>;
    }
  }

  /** Compact completed subagent sessions for a task. */
  async function compactTaskSessions(taskId: string, completedPhases: string[]): Promise<void> {
    for (const phase of completedPhases) {
      try {
        const sessions = (await daemonRequest("GET", "/sessions")) as {
          sessions?: Array<{ id: string; name?: string }>;
        };
        if (!sessions?.sessions) continue;

        const prefix = `belayd-${taskId}-sub-${phase}`;
        for (const session of sessions.sessions) {
          if (session.name?.startsWith(prefix)) {
            await daemonRequest("POST", `/sessions/${session.id}/compact`, {});
          }
        }
      } catch {
        // Daemon or endpoint not available — sessions remain uncompacted (acceptable for Phase 1)
      }
    }
  }

  /** Delegate a worktree workflow to the pi-web session daemon. */
  async function createOrchestratorSession(
    ctx: ExtensionContext,
    taskId: string,
    workflowType: WorkflowSubType,
    branch: string,
    worktreePath: string,
    base?: string,
    resolutionSource?: WorkflowResolutionSource,
    matchedLabel?: string,
  ): Promise<void> {
    const originalCwd = process.cwd();
    const phaseOrder = getPhasesForType(workflowType);
    const prompt = [
      `Start the Belayd ${workflowType} workflow for ${taskId}.`,
      `The worktree is \`${branch}\`.`,
      ...(base !== undefined ? [`Stacked on \`${base}\`.`] : []),
      "",
      `Follow the enforced phase order: ${phaseOrder.join(" → ")}.`,
      `Begin by calling \`belayd_${phaseOrder[0] ?? "commit"}\` to start.`,
    ].join("\n");

    // Persist workflow state so the new session's session_start handler can
    // activate (and later resume) the gate.
    const now = Date.now();
    const writeResult = writeWorkflowState({
      cwd: worktreePath,
      state: {
        schemaVersion: 1,
        taskId,
        workflowType,
        resolutionSource: resolutionSource ?? "default",
        ...(matchedLabel !== undefined ? { matchedLabel } : {}),
        branch,
        originalCwd,
        phaseOrder,
        completedPhaseNames: [],
        startedAt: now,
        updatedAt: now,
      },
    });
    if (!writeResult.ok) {
      ctx.ui.notify(`Failed to persist Belayd workflow state: ${writeResult.error}`, "error");
      return;
    }

    // Delegate to pi-web session daemon for persistent session management.
    const orchestrationName = computeOrchestratorSessionName(taskId);

    // Try setting name at creation time
    const created = (await daemonRequest("POST", "/sessions", {
      cwd: worktreePath,
      name: orchestrationName,
    })) as { id?: string };

    if (!created.id) {
      ctx.ui.notify("Session daemon returned no session id.", "error");
      return;
    }

    // The session daemon's per-session routes scope every request by cwd, so
    // the prompt body must carry the worktree path alongside the prompt text.
    await daemonRequest("POST", `/sessions/${created.id}/prompt`, {
      cwd: worktreePath,
      text: prompt,
    });

    ctx.ui.notify(`Belayd ${workflowType} workflow started for ${taskId} (${branch}).`, "info");
  }

  /**
   * Shared tail of the `/belayd` command and `belayd_start_followup`: ensure the
   * worktree (stacking on `base` when given), wait for its dependencies, then
   * delegate the orchestrator session. Returns an error result instead of
   * throwing so callers can render their own tool/notify response.
   */
  async function launchWorktreeWorkflow(options: {
    ctx: ExtensionContext;
    taskId: string;
    workflowType: WorkflowSubType;
    branch: string;
    base?: string;
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const worktreePath = ensureWorktree(options.ctx.cwd, options.branch, options.base);
    if (!worktreePath) {
      return {
        ok: false,
        error:
          "Worktree creation failed. Use --no-worktree to skip isolation, or check that wt is installed.",
      };
    }

    // Hardening: `wt switch` can return before background post-start hooks
    // finish installing deps. Wait for them so the new session does not fail
    // to load the harness extension (e.g. "Cannot find module 'zod'").
    const ready = await awaitWorktreeReady(worktreePath);
    if (!ready.ok) return { ok: false, error: `Worktree not ready: ${ready.error}` };

    await createOrchestratorSession(
      options.ctx,
      options.taskId,
      options.workflowType,
      options.branch,
      worktreePath,
      options.base,
      options.resolutionSource,
      options.matchedLabel,
    );
    return { ok: true };
  }

  // ── Slash command: /plan <description> | /plan bd-x ───────────────
  pi.registerCommand("plan", {
    description:
      "Enter planning mode: investigate and write an implementation-ready plan into beads. " +
      'Usage: /plan "description" or /plan bd-x [focus]',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "") {
        ctx.ui.notify(
          'Usage: /plan "description of the work to plan" or /plan bd-x [focus]',
          "error",
        );
        return;
      }

      const state = getSessionState(ctx);
      if (state.gateActive) {
        ctx.ui.notify(
          "A /belayd workflow is active for " +
            state.currentTaskId +
            ". Stop it first (belayd_stop_task) before entering planning mode.",
          "error",
        );
        return;
      }

      const parts = trimmed.split(/\s+/);
      const first = parts[0] ?? "";
      let planningTarget: PlanningTarget;
      if (isValidTaskId(first)) {
        const focus = parts.slice(1).join(" ");
        planningTarget =
          focus !== ""
            ? { kind: "existing", taskId: first, focus }
            : { kind: "existing", taskId: first };
      } else {
        planningTarget = { kind: "new", description: trimmed };
      }

      // Reset any prior implementation gate before entering planning mode.
      abortAndResetRunTracking(state);
      state.gateActive = false;
      clearWorkflowState({ cwd: ctx.cwd });

      state.planningActive = true;
      state.planningTarget = planningTarget;
      applyToolGate(state);

      const targetLabel =
        planningTarget.kind === "new"
          ? `New plan: ${planningTarget.description}`
          : `Existing bead ${planningTarget.taskId}`;
      const focusSuffix =
        planningTarget.kind === "existing" && planningTarget.focus !== undefined
          ? ` Focus: ${planningTarget.focus}.`
          : "";
      const kickoff =
        planningTarget.kind === "existing"
          ? `Planning for bead \`${planningTarget.taskId}\`. Start by running \`bd show ${planningTarget.taskId}\` to read the current content.${focusSuffix} Clarify any ambiguity with the user first, then write the refined plan back with \`bd update ${planningTarget.taskId} --description=... --design=... --notes=...\`.`
          : `Planning a new bead: ${planningTarget.description}. Investigate the codebase with \`belayd_plan_scout\`/\`belayd_plan_research\`, clarify any ambiguity with the user first, then write the finalized plan into a new bead with \`bd create ...\`.`;
      ctx.ui.notify(targetLabel, "info");
      pi.sendMessage(
        {
          customType: "belayd-plan",
          content: kickoff,
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });

  // ── Slash command: /belayd bd-42 [type] ────────────────────────────
  pi.registerCommand("belayd", {
    description:
      "Start enforced Belayd workflow. Usage: /belayd bd-42 [type] [--no-worktree]. " +
      "Omit type to use the bead's wf:<type> label (confirmed before launch).",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const taskId = parts[0] ?? "";

      // Filter out flags from type arg
      const noWorktree = parts.includes("--no-worktree");
      const typeArg = parts.slice(1).find((p) => p !== "--no-worktree");

      if (!taskId || !isValidTaskId(taskId)) {
        ctx.ui.notify(
          "Usage: /belayd bd-42 [type] [--no-worktree]\n" +
            "  taskId: beads issue or subtask ID (e.g. bd-42, bd-42.1)\n" +
            "  type: optional; omit to use the bead's wf:<type> label. Valid: feature (default), bugfix, research, chore, documentation, refactor, hotfix\n" +
            "  --no-worktree: activate gate in the current directory, no worktree or daemon",
          "error",
        );
        return;
      }

      // Explicit signals only: a CLI arg or a namespaced wf:<type> label. Title
      // keywords and plain labels never drive the choice (bd-106).
      const metadata = await readTaskMetadata(taskId, ctx.cwd);
      let resolution = resolveWorkflowSelection(typeArg, metadata?.labels);

      if (typeArg && !isValidWorkflowType(typeArg)) {
        ctx.ui.notify(
          `Unknown workflow type: "${typeArg}".\nValid types: feature, bugfix, research, chore, documentation, refactor, hotfix\nFalling back to "${resolution.type}".`,
          "warning",
        );
      }

      // A wf: label drives the type -> confirm before any side effects. A
      // cancelled (or unavailable) dialog aborts the run untouched.
      const confirmed = await confirmAndPersistResolution({
        ctx,
        taskId,
        resolution,
        existingLabels: metadata?.labels,
      });
      if (confirmed.kind === "cancelled") {
        ctx.ui.notify("Belayd workflow cancelled — no changes made.", "info");
        return;
      }
      resolution = confirmed.resolution;

      const workflowType = resolution.type;

      // --no-worktree mode: activate gate in-place, no isolation
      if (noWorktree) {
        activateGate({
          ctx,
          taskId,
          workflowType,
          cwd: ctx.cwd,
          originalCwd: process.cwd(),
          resolutionSource: resolution.source,
          matchedLabel: resolution.matchedLabel,
        });
        ctx.ui.notify(
          `Belayd ${workflowType} workflow started for ${taskId} (no worktree). ${describeResolutionSource(
            resolution,
          )}.`,
          "info",
        );
        sendWorkflowMessage(pi, taskId, null, workflowType, undefined, resolution);
        return;
      }

      const branch = `feat/${taskId}`;
      const outcome = await launchWorktreeWorkflow({
        ctx,
        taskId,
        workflowType,
        branch,
        resolutionSource: resolution.source,
        matchedLabel: resolution.matchedLabel,
      });
      if (!outcome.ok) {
        ctx.ui.notify(outcome.error, "error");
        return;
      }
    },
  });

  // ── Slash command: /belayd-complete [report] ───────────────────────
  //
  // Manual, out-of-band recovery for a phase sub-agent whose result was lost:
  // the child died/stalled, or the orchestrator restarted and its in-process
  // watcher vanished. Runs inside the sub-agent session, persists the report
  // into the run manifest, and wakes the orchestrator (or lets its
  // session_start / before_agent_start reconcile pick it up from disk).
  pi.registerCommand("belayd-complete", {
    description:
      "Mark this phase sub-agent run complete and feed its last assistant response back to the " +
      "orchestrator. Usage: /belayd-complete [report text]",
    handler: async (args, ctx) => {
      const sessionName = ctx.sessionManager.getSessionName();
      const parsed = sessionName === undefined ? undefined : parseSubagentSessionName(sessionName);
      if (sessionName === undefined || parsed === undefined) {
        ctx.ui.notify(
          "/belayd-complete is only available inside a phase sub-agent session " +
            "(belayd-<taskId>-sub-<phase>-<runId>).",
          "error",
        );
        return;
      }

      const provided = args.trim();
      const report =
        provided !== "" ? provided : (lastAssistantText(ctx.sessionManager.getBranch()) ?? "");
      if (report === "") {
        ctx.ui.notify(
          "No report text found. Pass the report explicitly: /belayd-complete <report text>",
          "error",
        );
        return;
      }

      const manifest = findRunForSession({ cwd: ctx.cwd, sessionName, parsed });
      if (manifest === undefined) {
        ctx.ui.notify(
          `No run manifest in ${ctx.cwd}/.belayd/runs matches session ${sessionName}.`,
          "error",
        );
        return;
      }

      const completed = completeRunByUser({ cwd: ctx.cwd, runId: manifest.runId, report });
      if (!completed.ok) {
        ctx.ui.notify(`Failed to mark run ${manifest.runId} complete: ${completed.error}`, "error");
        return;
      }

      // Best-effort: the manifest record plus the orchestrator's reconcile
      // scans still recover the result if the daemon is unavailable.
      await wakeOrchestrator({ taskId: parsed.taskId, runId: manifest.runId, cwd: ctx.cwd });

      pi.appendEntry("belayd-complete", {
        runId: manifest.runId,
        taskId: parsed.taskId,
        phase: parsed.phase,
      });
      ctx.ui.notify(
        `Run ${manifest.runId} (${parsed.phase}) marked complete; the orchestrator will resume it.`,
        "info",
      );
    },
  });

  /** Find the run manifest for a sub-agent session, by exact name or parsed components. */
  function findRunForSession(options: {
    cwd: string;
    sessionName: string;
    parsed: SubagentSessionRef;
  }): RunManifest | undefined {
    const runs = listRuns({ cwd: options.cwd });
    const exact = runs.find((run) => run.sessionName === options.sessionName);
    if (exact !== undefined) return exact;
    return runs.find((run) => {
      const named = parseSubagentSessionName(run.sessionName);
      if (named !== undefined) {
        return (
          named.taskId === options.parsed.taskId &&
          named.phase === options.parsed.phase &&
          named.shortRunId === options.parsed.shortRunId
        );
      }
      return (
        run.runId === options.parsed.shortRunId &&
        run.taskId === options.parsed.taskId &&
        run.phase === options.parsed.phase
      );
    });
  }

  /**
   * Narrow an untrusted daemon response's session list. `daemonRequest` returns
   * `Record<string, unknown>`, so a malformed entry must not reach a URL path
   * (`/sessions/<id>/prompt`) as `[object Object]`.
   */
  function parseDaemonSessions(
    response: Record<string, unknown>,
  ): Array<{ id: string; name?: string }> {
    const raw = response.sessions;
    if (!Array.isArray(raw)) return [];
    const sessions: Array<{ id: string; name?: string }> = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || record.id === "") continue;
      sessions.push({
        id: record.id,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
      });
    }
    return sessions;
  }

  /**
   * Ask the pi-web session daemon to prompt the orchestrator with the recovery
   * sentinel. Failures are swallowed: the persisted manifest and the
   * orchestrator-side reconcile are the authoritative recovery path.
   */
  async function wakeOrchestrator(options: {
    taskId: string;
    runId: string;
    cwd: string;
  }): Promise<void> {
    try {
      const response = await daemonRequest("GET", "/sessions");
      const targetName = computeOrchestratorSessionName(options.taskId);
      const session = parseDaemonSessions(response).find(
        (candidate) => candidate.name === targetName,
      );
      if (session === undefined) return;
      await daemonRequest("POST", `/sessions/${session.id}/prompt`, {
        cwd: options.cwd,
        text: `[belayd-complete:${options.runId}]`,
      });
    } catch (err) {
      console.warn(`[belayd-harness] failed to wake orchestrator for ${options.taskId}`, err);
    }
  }

  /** Body of the user-completion follow-up delivered to the orchestrator. */
  function buildUserCompletionContent(run: RunManifest): string {
    const report = run.completionReport ?? "";
    return (
      `✅ **${run.phase} phase completed by user** (run \`${run.runId}\`)\n\n` +
      `${report}\n\n---\nThis result was supplied manually via \`/belayd-complete\`; ` +
      "treat it as the sub-agent's final answer and continue the workflow."
    );
  }

  /** Resolve the pending user completions to reconcile: one run or all. */
  function pendingCompletionsFor(cwd: string, runId: string | undefined): RunManifest[] {
    if (runId === undefined) return listPendingUserCompletions({ cwd });
    const manifest = readRunManifest({ cwd, runId });
    if (manifest === undefined || manifest.completedBy !== "user") return [];
    if (manifest.deliveredAt !== undefined) return [];
    if (manifest.completionReport === undefined || manifest.completionReport === "") return [];
    return [manifest];
  }

  /**
   * Deliver any user-completed runs whose report has not been delivered yet.
   *
   * Both the daemon sentinel and the orchestrator restart path converge here.
   * `deliveredAt` on the manifest is the persistent delivery-once marker, so a
   * repeated sentinel, a later normal settle, or a second restart never
   * duplicates the follow-up. The in-memory `deliveredRunIds` set is a fallback
   * for when the disk marker cannot be written, so this process still delivers
   * at most once.
   */
  function reconcileUserCompletions(options: {
    state: SessionState;
    cwd: string;
    runId?: string;
  }): void {
    const { state, cwd } = options;
    if (!state.gateActive || state.currentTaskId === "") return;

    /** Record delivery once, in memory and on disk; a failed write still suppresses a retry. */
    const markDeliveredOnce = (runId: string): void => {
      state.deliveredRunIds.add(runId);
      const result = markRunDelivered({ cwd, runId });
      if (!result.ok) {
        console.warn(`[belayd-harness] failed to mark run ${runId} delivered: ${result.error}`);
      }
    };

    for (const run of pendingCompletionsFor(cwd, options.runId)) {
      if (run.taskId !== state.currentTaskId) continue;
      if (state.deliveredRunIds.has(run.runId)) continue;
      // A phase already completed here must not stall the scan: mark the
      // manifest delivered so it is never replayed.
      if (state.completedPhaseNames.includes(run.phase)) {
        markDeliveredOnce(run.runId);
        continue;
      }
      applyPhaseCompletion(state, run.phase, run.completionReport);
      persistCompletedPhases({
        cwd,
        completedPhaseNames: state.completedPhaseNames,
        awaitingReviewResponse: state.awaitingReviewResponse,
      });
      pi.sendMessage(
        {
          customType: "belayd-run-complete",
          content: buildUserCompletionContent(run),
          display: true,
          details: {
            runId: run.runId,
            phaseName: run.phase,
            taskId: run.taskId,
            exitCode: 0,
            completedBy: "user",
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      markDeliveredOnce(run.runId);
    }
  }

  // ── Input sentinel: daemon-injected /belayd-complete wake ───────────
  //
  // The orchestrator is woken with `[belayd-complete:<runId>]`; reconcile it
  // and swallow the raw prompt so it never reaches the LLM as user input. The
  // match is end-anchored so a sentinel-looking prefix with trailing user text
  // is treated as ordinary input, not silently dropped. A well-formed sentinel
  // is always handled (even with no active gate) so the control token can
  // never leak to the model.
  pi.on("input", (event, ctx) => {
    const match = /^\[belayd-complete:([^\]]+)\]$/.exec(event.text.trim());
    if (match === null) return { action: "continue" };
    const runId = match[1];
    if (runId === undefined) return { action: "continue" };
    const state = getSessionState(ctx);
    if (state.gateActive && state.currentTaskId !== "") {
      reconcileUserCompletions({ state, cwd: ctx.cwd, runId });
    }
    return { action: "handled" };
  });

  /**
   * Resume the gate from the persisted workflow state written by /belayd.
   * A completed workflow is cleared instead of resurrected; a sub-agent never
   * reaches this helper because its session has no workflow state file.
   */
  function resumeWorkflowFromDisk(state: SessionState, cwd: string): void {
    const persisted = readWorkflowState({ cwd });
    if (persisted === undefined) return;

    if (!isValidTaskId(persisted.taskId)) {
      // A crafted/corrupt workflow.json must not reach the `bd show ${taskId}` shell sink.
      clearWorkflowState({ cwd });
      return;
    }

    // A stale workflow.json that already finished must not resurrect the gate.
    if (isWorkflowComplete(persisted.completedPhaseNames, persisted.phaseOrder)) {
      clearWorkflowState({ cwd });
      return;
    }

    state.gateActive = true;
    state.currentTaskId = persisted.taskId;
    state.workflowType = isValidWorkflowType(persisted.workflowType)
      ? persisted.workflowType
      : "feature";
    state.phaseOrder = [...persisted.phaseOrder];
    state.optionalPhases = WORKFLOW_REGISTRY[state.workflowType].optionalPhases ?? [];
    state.consultPhases = WORKFLOW_REGISTRY[state.workflowType].consultPhases ?? [];
    state.completedPhaseNames = [...persisted.completedPhaseNames];
    state.awaitingReviewResponse =
      persisted.awaitingReviewResponse ??
      isAwaitingReviewResponse(persisted.completedPhaseNames, persisted.phaseOrder);
    applyToolGate(state);

    // Surface any phase runs that died with the previous orchestrator.
    const interrupted = scanForInterruptedRuns({ cwd });
    if (interrupted.length > 0) {
      console.warn(
        `[belayd-harness] ${interrupted.length} interrupted phase run(s) detected for ${persisted.taskId}`,
      );
    }
  }

  pi.on("session_start", (_event, ctx) => {
    // A session can restart mid-workflow (compaction/resume). Flush pending
    // rows before dropping the store, otherwise telemetry recorded since the
    // last settle is lost. Per-run stores keep an open run's own delta exact.
    resetModelTelemetry(ctx.cwd);
    const state = getSessionState(ctx);
    state.gateActive = false;
    state.planningActive = false;
    state.planningTarget = undefined;
    state.consultPhases = [];
    state.completedPhaseNames = [];
    state.currentTaskId = "";
    state.proofBase = undefined;
    state.userGuideContent = undefined;
    state.proofOutput = undefined;
    state.proofVerifierVerdict = undefined;
    state.awaitingReviewResponse = false;
    state.runEpoch = 0;
    resetRunTracking(state);
    applyToolGate(state);

    // Sub-agents have "-sub-" in their session name (set by computeSubagentSessionName).
    // Only the orchestrator session should activate the gate; sub-agents get their
    // tool restrictions from their agent definition's tools allowlist, not the gate.
    const sessionName = ctx.sessionManager.getSessionName();
    const isSubAgent = sessionName?.includes("-sub-");
    if (!ctx.sessionManager.getSessionFile() || isSubAgent) return;
    resumeWorkflowFromDisk(state, ctx.cwd);
    // A user completion persisted before an orchestrator restart is recovered
    // from disk; the in-memory delivery marker was lost with the process.
    reconcileUserCompletions({ state, cwd: ctx.cwd });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Flush telemetry recorded after the last run settle (e.g. the proof
    // verifier) and log the workflow summary once before the store is dropped.
    resetModelTelemetry(ctx.cwd, { log: true });
    const id = ctx.sessionManager.getSessionId();
    const state = sessionStates.get(id);
    if (state) {
      // In-flight background runs must not outlive their session.
      abortActiveRuns(state);
    }
    sessionStates.delete(id);
  });

  // ── Inject workflow context when gate is active ────────────────────

  /** Build the planning-mode context message, or undefined when inactive. */
  function planningContextMessage(
    state: SessionState,
  ): { message: { customType: string; content: string; display: boolean } } | undefined {
    if (!state.planningActive) return undefined;
    const target = state.planningTarget;
    const targetLine =
      target?.kind === "existing"
        ? `Refine existing bead \`${target.taskId}\`${target.focus !== undefined ? ` (focus: ${target.focus})` : ""}. Start with \`bd show ${target.taskId}\`, then write the refined plan back with \`bd update\`.`
        : target?.kind === "new"
          ? `Plan new work: ${target.description}`
          : "Plan new work.";

    const activeRunLines: string[] = [];
    if (state.activeRuns.size > 0) {
      activeRunLines.push("", "⏳ **Planning runs in progress — WAIT, do not act:**");
      for (const [runId, { handle }] of state.activeRuns) {
        activeRunLines.push(`- \`${handle.phaseName}\` (run \`${runId}\`) — ${handle.status}`);
      }
      activeRunLines.push(
        "",
        "Do NOT launch another planning sub-agent. The result will arrive as a follow-up message.",
      );
    }

    return {
      message: {
        customType: "belayd-planning-context",
        content: [
          "[BELAYD PLANNING MODE ACTIVE]",
          PLANNING_MODE_SYSTEM_PROMPT,
          "",
          `Target: ${targetLine}`,
          ...activeRunLines,
        ].join("\n"),
        display: false,
      },
    };
  }

  /**
   * Proof modality requirements, returned only for proof workflows.
   *
   * The orchestrator writes the `belayd_proof` task prompt, so the requirement
   * must be restated every turn: UI changes need BOTH a Playwright trace and
   * playwright-cli screenshots, and a missing test-runner browser is a
   * workaround problem, never a reason to skip visual proof.
   */
  function proofModalityGuidanceLines(phaseOrder: readonly string[]): string[] {
    if (!phaseOrder.includes("proof")) return [];
    return [
      "",
      "**Proof modality** (before calling `belayd_proof`):",
      "- UI change → the `belayd_proof` task MUST require BOTH a Playwright trace (E2E spec) and playwright-cli screenshots of the changed pages.",
      "- Tell the proof agent to explore the built UI in a browser (playwright-cli open → click through → screenshot), not just run the E2E spec.",
      "- A missing/incompatible Playwright browser is NOT a skip reason, and `playwright install` is forbidden on this host (CDN binaries need FHS libs that NixOS lacks): require the project devShell env (`direnv exec <repo> <cmd>` / `nix develop -c <cmd>`) or a Nix browser tree whose revision matches, then produce the artifact.",
      "- Browser-proof trouble is absent from the proof agent's `**Proof skipped:**` reason list — reject a UI proof that skips visuals for that reason.",
    ];
  }

  /** Proof-verifier guidance lines, returned only for proof workflows. */
  function proofVerifierGuidanceLines(phaseOrder: readonly string[]): string[] {
    if (!phaseOrder.includes("proof")) return [];
    return [
      "",
      "**Proof verifier** (after `belayd_proof`):",
      "- Call `belayd_proof_verifier` when proof relevance or quality is uncertain.",
      "- It is ADVISORY and non-blocking: a `reasonable: false` verdict is worth investigating, but never blocks the commit phase.",
      "- Record the verdict in the task's Final Summary and bead notes.",
    ];
  }

  /**
   * Stale-worktree guidance, restated every turn for every workflow type.
   *
   * The orchestrator farms work out to sub-agents whose branches may sit behind
   * the base branch; without a per-turn reminder an already-merged task looks
   * "missing" and gets re-implemented, so this is unconditional rather than
   * tied to a phase.
   */
  function worktreeSyncGuidanceLines(): string[] {
    return [
      "",
      "**Stale worktree?**",
      "- The worktree branch may be behind the base branch (`main`); a task closed elsewhere may simply not be in this branch yet — check `main` before duplicating work.",
      "- If the work already landed on `main`, rebase with `git rebase main` instead of re-implementing apparently-missing work.",
      "- Mid-rebase conflicts are expected: when the branch re-implements merged work, prefer the already-landed `main` implementation over the duplicate.",
      "",
      "**Stacked follow-up worktree?**",
      "- A branch created with `belayd_start_followup` records its base in `branch.<name>.belaydBase` and fork point in `branch.<name>.belaydForkPoint`.",
      "- When the recorded base lands, replay only this branch with `belayd_stack_rebase` (or `git rebase --onto main <belaydForkPoint> <branch>`), never a plain `git rebase <parent>` — the parent's commits are already in `main`.",
    ];
  }

  /** Build the implementation-gate context message, or undefined when inactive. */
  function gateContextMessage(
    state: SessionState,
  ): { message: { customType: string; content: string; display: boolean } } | undefined {
    if (!state.gateActive) return undefined;

    const remaining = getNextPhase(state.completedPhaseNames, state.phaseOrder) ?? "commit";
    const phaseOrder = state.phaseOrder;
    const workflowType = state.workflowType;

    const phaseLines = phaseOrder.map(
      (p) => `- \`belayd_${p}\` — ${describePhase(p, workflowType)}`,
    );

    // Research workflows record findings as a bead note — there is no research
    // .md file to write and no committed-file deliverable. State this every
    // turn, not just at workflow start, because the orchestrator otherwise
    // re-delegates `belayd_plan` to force a research .md file that the
    // researcher contract explicitly forbids.
    const researchGuidance =
      workflowType === "research"
        ? [
            "",
            "RESEARCH workflow: the `plan` phase is the research agent. Its deliverable is a bead note (via `bd note`) — NOT a committed file or research .md document. Do not re-delegate to write a research file.",
          ]
        : [];

    // The reviewer's output has three severity sections. The orchestrator must
    // treat all of them as input — not just "Critical" — and disclose anything
    // it declines so the human reviewer sees what was consciously skipped. The
    // "then call X" phase is review's successor, not the next incomplete phase:
    // before review runs, the latter would name review itself.
    const reviewFindingsGuidance = phaseOrder.includes(REVIEW_PHASE)
      ? reviewFindingsGuidanceLines(nextPhaseToolAfter(REVIEW_PHASE, phaseOrder))
      : [];

    // When phase runs are active, tell the orchestrator to wait instead of
    // repeating "call belayd_X" — the phase is already running, and the
    // gate will block any re-call, creating a contradictory loop.
    const activeRunLines: string[] = [];
    if (state.activeRuns.size > 0) {
      activeRunLines.push("", "⏳ **Phase runs in progress — WAIT, do not act:**");
      for (const [runId, { handle }] of state.activeRuns) {
        activeRunLines.push(`- \`${handle.phaseName}\` (run \`${runId}\`) — ${handle.status}`);
      }
      activeRunLines.push(
        "",
        "Do NOT call any phase tools. Do NOT call belayd_status on your own initiative.",
        "The result will arrive as a follow-up message when each run completes.",
        "If the user explicitly asks you to check progress, you may call belayd_status.",
      );
    }

    // Build the next-step line: "wait" when runs are active; after review the
    // gate used to say "call belayd_test" even though the findings were still
    // unaddressed. Point the orchestrator back at the resumable fix loop until
    // no Critical/Warnings remain.
    const nextStepLine = gateNextStepLine({
      activeRunCount: state.activeRuns.size,
      awaitingReviewResponse: state.awaitingReviewResponse,
      remainingPhase: remaining,
    });

    return {
      message: {
        customType: "belayd-gate-context",
        content: [
          "[BELAYD WORKFLOW ACTIVE]",
          `Task: ${state.currentTaskId} (${workflowType})`,
          `Progress: ${formatProcessState(state.completedPhaseNames, state.currentTaskId, phaseOrder)}`,
          "",
          `Phases: ${phaseOrder.join(" → ")}`,
          "",
          "Editing and writing tools are DISABLED. You MUST delegate ALL code changes to the phase tools:",
          ...phaseLines,
          ...researchGuidance,
          ...reviewFindingsGuidance,
          ...proofVerifierGuidanceLines(phaseOrder),
          ...proofModalityGuidanceLines(phaseOrder),
          ...worktreeSyncGuidanceLines(),
          ...activeRunLines,
          "",
          "Task tracking: the `bd` tool is available for beads commands (create, update, label, note, show, search, list, ready, etc.).",
          "",
          nextStepLine,
        ].join("\n"),
        display: false,
      },
    };
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    const state = getSessionState(ctx);
    // File-only fallback: if the daemon wake path never fired (e.g. restart),
    // a pending user completion is still recovered on the next turn.
    if (state.gateActive) reconcileUserCompletions({ state, cwd: ctx.cwd });
    return planningContextMessage(state) ?? gateContextMessage(state);
  });

  // Managed instruction groups. Agent extensions (e.g. pi-agent-browser) ship
  // a large prompt section and register an eager fallback that writes it every
  // turn regardless of whether their tools are callable. Nothing in pi 1.0.2
  // emits `pi:instruction-groups`, so the harness emits it itself and owns the
  // gate. A dedicated handler (separate from the process-gate handler above)
  // keeps the gate's early returns from skipping it. The body lives in
  // `src/instruction-groups.ts` so the wiring is unit-testable without pi.
  const instructionCollector = createInstructionGroupCollector();
  // A pi with no instruction-group extension at all legitimately leaves the
  // collector empty forever, so the same "no group registered" line would
  // repeat every turn. Warn once per session; every other message can signal a
  // state change and keeps logging every turn.
  let noGroupWarningEmitted = false;
  const warnInstructionGroups = (message: string): void => {
    if (message === NO_GROUP_REGISTERED_WARNING) {
      if (noGroupWarningEmitted) return;
      noGroupWarningEmitted = true;
    }
    console.warn(`[belayd-harness] ${message}`);
  };
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const result = manageInstructionGroups({
        collector: instructionCollector,
        emitInstructionGroups: (collector) => pi.events.emit(INSTRUCTION_GROUPS_CHANNEL, collector),
        systemPromptOptions: event.systemPromptOptions,
        ctx,
        warn: warnInstructionGroups,
      });
      const warning = manageInstructionGroupsWarning(result);
      if (warning !== undefined) console.warn(`[belayd-harness] ${warning}`);
    } catch (error) {
      console.warn(`[belayd-harness] instruction-group prompt gate failed: ${String(error)}`);
    }
  });

  // ── Map agent tool names to phase names ────────────────────────────
  const AGENT_TO_PHASE: Record<string, string> = {
    "belayd-planner": "plan",
    "belayd-implementer": "implement",
    "belayd-reviewer": "review",
    "belayd-tester": "test",
    "belayd-userguide": "userguide",
    "belayd-proof-generator": "proof",
    "belayd-committer": "commit",
  };

  interface PhaseToolContext {
    sessionManager: { getSessionId: () => string };
    cwd?: string;
  }

  interface PhaseToolParams {
    task: string;
    cwd?: string;
  }

  /** Persist the "running" manifest so a mid-phase crash is resumable. */
  function persistRunningManifest(options: {
    state: SessionState;
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
    const resolved = advancePastExistingEpoch({
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
   * Build the full phase prompt: the bead plan for implement, the inlined diff
   * for review, the change context for proof, or the raw task otherwise. Used
   * for the initial spawn and to re-supply a fresh-epoch gate retry that has no
   * transcript.
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
    if (options.phaseName === "proof") {
      const proofContext = await collectChangeContext(options.cwd, options.userGuideContent);
      return `${options.paramsTask}${proofContext}`;
    }
    return options.paramsTask;
  }

  /**
   * The review loop directive appended to a successful review delivery, or ""
   * for any other delivery. Extracted so the `deliver` watcher callback stays
   * within the cognitive-complexity budget.
   */
  function reviewLoopHintFor(delivery: RunDelivery, state: SessionState): string {
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
   * Start a phase run in the background and return its handle immediately.
   *
   * The run owns its abort signal — the tool-call signal belongs to the
   * (now non-blocking) tool response and must not cancel the background run.
   */
  function startPhaseRun(
    agent: AgentDefinition,
    phaseName: string,
    params: PhaseToolParams,
    state: SessionState,
    effectiveCwd: string | undefined,
    runId: string,
  ): { handle: RunHandle; sessionName: string; ledgerWarning?: string } {
    const overrides = WORKFLOW_REGISTRY[state.workflowType].agentOverrides?.[phaseName as Phase];
    const resolvedModel = resolveModelSpec(agent);
    const effectiveModel = overrides?.model ?? resolvedModel.model;
    const effectiveModelClass = resolveEffectiveModelClass(resolvedModel.modelClass, overrides);
    const effectiveTools = overrides?.tools ?? agent.tools;
    const effectiveSystemPrompt = overrides?.systemPrompt ?? agent.systemPrompt;
    const cwd = effectiveCwd ?? process.cwd();
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
        // Only a gate-owned, successful review records the reviewed sha — a
        // post-completion rework run must not scope the next task's review.
        if (gateOwnsRun() && delivery.success && delivery.phaseName === REVIEW_PHASE) {
          await persistReviewedSha({ cwd, taskId: state.currentTaskId });
        }
        const delivered = boundReviewDelivery(delivery);
        pi.sendMessage(
          {
            customType: "belayd-run-complete",
            content: buildRunCompleteContent(delivered, reviewLoopHintFor(delivered, state)),
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
        fullTask = await buildFullPhaseTask({
          phaseName,
          taskId: state.currentTaskId,
          paramsTask: params.task,
          cwd,
          userGuideContent: state.userGuideContent,
        });
        // On a cross-run resume the transcript already contains the bead plan,
        // so sending the full task would duplicate context; the orchestrator
        // supplies the review findings it wants fixed in params.task instead.
        // Review and proof are exempt: their full task carries context the
        // session has never seen — a freshly computed diff (the fix diff on a
        // re-review) and fresh change context, respectively. Returning
        // params.task there would hand a resumed re-review no diff at all.
        const needsFullTask = !resumeSession || phaseName === "proof" || phaseName === REVIEW_PHASE;
        return needsFullTask ? fullTask : params.task;
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
          cwd: effectiveCwd,
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
        cwd: effectiveCwd,
        proofDir,
        proofRunStartMs,
        env: spawnEnv,
        workflowType: state.workflowType,
        phaseName,
        signal: abortController.signal,
        model: effectiveModel,
        modelClass: effectiveModelClass,
        tools: effectiveTools,
        sessionName: subagentSessionName,
        telemetry: runTelemetrySink,
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
        applyPhaseCompletion(state, info.phaseName, info.result.content?.[0]?.text);
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
    state: SessionState,
    effectiveCwd: string | undefined,
    runId: string,
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
        pi.sendMessage(
          {
            customType: "belayd-planning-run-complete",
            content: `${header}\n\n${text}`,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        persistModelTelemetry(effectiveCwd ?? process.cwd());
      },
      isDelivered: (id) => state.deliveredRunIds.has(id),
      markDelivered: (id) => {
        state.deliveredRunIds.add(id);
      },
    });

    return { handle, sessionName };
  }

  /** Persist the completed phase list (best-effort, after a phase succeeds). */
  function persistCompletedPhases(options: {
    cwd: string;
    completedPhaseNames: string[];
    awaitingReviewResponse: boolean;
  }): void {
    const saveResult = saveCompletedPhases({
      cwd: options.cwd,
      completedPhaseNames: options.completedPhaseNames,
      awaitingReviewResponse: options.awaitingReviewResponse,
    });
    if (!saveResult.ok) {
      console.warn(`[belayd-harness] failed to persist completed phases: ${saveResult.error}`);
    }
  }

  /**
   * Merge only the rows added since this destination's last flush into
   * `.belayd/telemetry.json`. `appendModelTelemetry` read-merge-writes, so an
   * overwrite of the full store would re-append every earlier row on each
   * settle and grow counts quadratically. The per-cwd flush cursor tracks what
   * is already on disk for that destination; a failed write leaves the cursor
   * unchanged so the rows are retried. Logs the summary only when `log` is set,
   * so the 6+ phase settles do not each emit the full cumulative breakdown;
   * workflow completion and session shutdown request the log once.
   */
  function persistModelTelemetry(cwd: string, options?: { log?: boolean }): void {
    const flushed = flushModelTelemetry({ state: modelState, cwd });
    if (!flushed.ok) {
      warnModelTelemetryFlushFailure(flushed.error);
      return;
    }
    if (options?.log === true) logModelTelemetrySummary();
  }

  /**
   * Flush the finished workflow's telemetry, then start a fresh per-workflow
   * store. The store and every destination cursor are dropped only after the
   * flush succeeds: a failed final write must not discard rows that never
   * reached disk, and the cursor stays so the next flush retries them.
   */
  function resetModelTelemetry(cwd: string, options?: { log?: boolean }): void {
    const shouldLog = options?.log === true;
    const result = flushAndResetModelTelemetry({
      state: modelState,
      cwd,
      beforeReset: () => {
        if (shouldLog) logModelTelemetrySummary();
      },
    });
    if (!result.ok) {
      warnModelTelemetryFlushFailure(result.error);
    }
  }

  /**
   * Warn about a failed telemetry flush at most once per throttle window, so a
   * full disk does not spam the log on every settle, stop, and shutdown.
   */
  function warnModelTelemetryFlushFailure(error: string): void {
    if (!shouldWarnFlushFailure(modelState)) return;
    console.warn(`[belayd-harness] failed to persist model telemetry: ${error}`);
  }

  function logModelTelemetrySummary(): void {
    const stats = modelState.telemetry.stats();
    if (stats.length === 0) return;
    console.log(formatModelTelemetrySummary(stats, modelState.telemetry.totals()));
  }

  /**
   * Record the revision a completed review covered, so the next re-review can
   * diff only the fix round (bd-113). Best-effort: a git or disk failure must
   * never affect an otherwise successful review delivery.
   */
  async function persistReviewedSha(options: { cwd: string; taskId: string }): Promise<void> {
    let sha: string;
    try {
      const { stdout } = await runGitCommand(["rev-parse", "HEAD"], {
        cwd: options.cwd,
        timeoutInMs: 15_000,
        maxBufferInBytes: 1024 * 1024,
      });
      sha = stdout.trim();
    } catch (error) {
      console.warn(`[belayd-harness] failed to resolve HEAD for the reviewed sha:`, error);
      return;
    }
    if (sha === "") return;
    // The identity check lives in saveReviewedSha so it shares the read that
    // immediately precedes the write: a state swap during the rev-parse await
    // must not redirect this task's sha into another task's workflow.json.
    const saveResult = saveReviewedSha({ cwd: options.cwd, sha, expectedTaskId: options.taskId });
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
    state: SessionState;
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
      persistCompletedPhases({
        cwd: options.manifestCwd,
        completedPhaseNames: options.state.completedPhaseNames,
        awaitingReviewResponse: options.state.awaitingReviewResponse,
      });
    }
  }

  // ── Register agent tools ────────────────────────────────────────────
  for (const agent of DEFAULT_AGENTS) {
    if (agent.name === "belayd-committer") continue;
    const phaseName = AGENT_TO_PHASE[agent.name] ?? agent.name.replace("belayd-", "");
    const toolName = getPhaseToolName(phaseName);
    pi.registerTool({
      name: toolName,
      label: agent.description,
      description: agent.description,
      parameters: Type.Object({
        task: Type.String({ description: "Task to delegate to this agent" }),
        cwd: Type.Optional(Type.String({ description: "Working directory" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = getSessionState(ctx);
        const ctxWithCwd = ctx as PhaseToolContext;
        const effectiveCwd = params.cwd ?? ctxWithCwd.cwd;
        const runId = generateShortRunId();
        const { sessionName, ledgerWarning } = startPhaseRun(
          agent,
          phaseName,
          params,
          state,
          effectiveCwd,
          runId,
        );
        const ledgerNotice = ledgerWarning === undefined ? "" : `\n\n⚠️ ${ledgerWarning}`;
        return {
          content: [
            {
              type: "text" as const,
              text:
                `belayd ${phaseName} run started in the background.\n\n` +
                `Run ID: ${runId}\nSession: ${sessionName}\n` +
                `The result will be delivered as a follow-up message when the run (and its quality gate) completes.\n` +
                `Wait for the follow-up — do NOT call belayd_status on your own initiative.` +
                ` Only call belayd_status if the user explicitly asks you to.` +
                `\nDo not re-call this phase tool — the run is already in progress.` +
                ledgerNotice,
            },
          ],
          details: { messages: [], usage: emptyUsage(), exitCode: 0 },
        };
      },
    });
  }

  // ── Planning sub-agent tools ─────────────────────────────────────────
  pi.registerTool({
    name: "belayd_plan_scout",
    label: "Planning scout",
    description: "Fast codebase recon for planning mode. Returns structured findings.",
    parameters: Type.Object({
      task: Type.String({ description: "What to investigate" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const scout = getAgentByShortName("scout");
      if (!scout) {
        return {
          content: [{ type: "text" as const, text: "Scout agent not found." }],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }
      const runId = generateShortRunId();
      const { sessionName } = startPlanningRun(
        {
          name: scout.name,
          modelClass: scout.modelClass ?? "fast",
          tools: scout.tools.filter((t) => t !== "bash"),
          systemPrompt: scout.systemPrompt,
        },
        "scout",
        params,
        state,
        (ctx as { cwd?: string }).cwd,
        runId,
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              `belayd_plan_scout run started in the background.\n\n` +
              `Run ID: ${runId}\nSession: ${sessionName}\n` +
              `Wait for the follow-up message before synthesizing.`,
          },
        ],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });

  pi.registerTool({
    name: "belayd_plan_research",
    label: "Planning research",
    description: "Deeper investigation for planning mode. Returns evidence-based findings.",
    parameters: Type.Object({
      task: Type.String({ description: "The research question" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const runId = generateShortRunId();
      const { sessionName } = startPlanningRun(
        {
          name: "belayd-plan-research",
          modelClass: "frontier",
          // Keep bash (research must be able to run CLI tools); strip only bd so
          // planning sub-agents never create or mutate beads. Scout still drops
          // bash to stay strictly read-only.
          tools: RESEARCHER_TOOLS.filter((t) => t !== "bd"),
          systemPrompt: RESEARCHER_SYSTEM_PROMPT,
        },
        "research",
        params,
        state,
        (ctx as { cwd?: string }).cwd,
        runId,
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              `belayd_plan_research run started in the background.\n\n` +
              `Run ID: ${runId}\nSession: ${sessionName}\n` +
              `Wait for the follow-up message before synthesizing.`,
          },
        ],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });

  /**
   * Project-scoped proof base, falling back to the global base when the git
   * project key cannot be derived so proof handling never blocks a phase.
   */
  function resolveProjectProofBaseOrGlobal(env: NodeJS.ProcessEnv, cwd: string): string {
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
  function preparePhaseProof(
    state: SessionState,
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
  function proofDirForActiveTask(state: SessionState, cwd: string): string | undefined {
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
  async function buildProofVerifierPrompt(
    params: {
      task?: string;
      proof?: string;
      cwd?: string;
    },
    state: SessionState,
    ctx: unknown,
  ): Promise<{ prompt: string; cwd: string; skipped: boolean }> {
    const cwd = params.cwd ?? (ctx as { cwd?: string }).cwd ?? process.cwd();
    const taskText = params.task ?? state.currentTaskId;
    const proofOutput = params.proof ?? state.proofOutput ?? "";
    const changeContext = await collectChangeContext(cwd, state.userGuideContent);
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
  async function runProofVerifier(
    prompt: string,
    cwd: string,
    state: SessionState,
    signal?: AbortSignal,
  ): Promise<{ text: string }> {
    const runId = generateShortRunId();
    const sessionName = `belayd-proof-verifier-${runId}`;
    try {
      const result = await spawnAgentWithFallback({
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
        cooldownStore: modelCooldown,
        enabled: modelFallbackEnabled,
        phase: "proof-verifier",
        telemetry: modelState.telemetry,
        capacity: modelState.capacity,
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

  // ── Register proof verifier tool ────────────────────────────────────
  pi.registerTool({
    name: "belayd_proof_verifier",
    label: "Proof verifier",
    description:
      "Advisory, non-blocking review of proof relevance and plausibility. " +
      "Runs a read-only judge over the proof phase output and records a verdict.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "The task the proof should demonstrate" })),
      proof: Type.Optional(Type.String({ description: "Optional proof output override" })),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const built = await buildProofVerifierPrompt(params, state, ctx);
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
      const verdict = await runProofVerifier(built.prompt, built.cwd, state, signal);
      return {
        content: [{ type: "text" as const, text: verdict.text }],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });

  // ── Register status tool ─────────────────────────────────────────────
  pi.registerTool({
    name: "belayd_status",
    label: "Belayd Status",
    description: "Show Belayd process state, active background runs, and run history.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const sections: string[] = [];

      sections.push(
        state.gateActive
          ? formatProcessState(state.completedPhaseNames, state.currentTaskId, state.phaseOrder)
          : "Belayd process is inactive.",
      );

      const activeLines = ["**Active runs**"];
      if (state.activeRuns.size > 0) {
        for (const [runId, { handle }] of state.activeRuns) {
          activeLines.push(`- \`${runId}\` — ${handle.phaseName} (${handle.status})`);
        }
      } else {
        activeLines.push("(none)");
      }
      sections.push(activeLines.join("\n"));

      const runs = listRuns({ cwd });
      if (runs.length > 0) {
        const lines = ["**Run history**", ""];
        lines.push("| runId | phase | status | startedAt | exitCode | model |");
        lines.push("| --- | --- | --- | --- | --- | --- |");
        for (const run of runs) {
          lines.push(
            `| \`${run.runId}\` | ${run.phase} | ${run.status} | ${new Date(run.startedAt).toISOString()} | ${run.exitCode ?? ""} | ${run.model ?? ""} |`,
          );
        }
        sections.push(lines.join("\n"));
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n\n") }],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });

  // ── Register bd (beads) tool ─────────────────────────────────────────
  // The gate disables bash so editing tools can't be abused, but task
  // tracking still needs the bd CLI. This tool proxies bd through a safe
  // subcommand allowlist so the orchestrator can manage beads without raw
  // shell access. It is included in GATED_TOOLS, so it stays available while
  // the gate is active.
  pi.registerTool({
    name: "bd",
    label: "Beads task tracker",
    description:
      "Run a beads (bd) CLI command for task tracking. Restricted to safe " +
      "subcommands (create, update, label, note, show, search, list, ready, " +
      "prime, remember, and similar). Cannot close, delete, or edit issues. " +
      "Multiline content is supported: quote arguments containing spaces or " +
      "newlines, or pass content via the `stdin` parameter together with " +
      "`--stdin` (recommended for long notes/descriptions).",
    parameters: Type.Object({
      command: Type.String({
        description:
          'Full bd command including subcommand and flags, e.g. "create --title=\\"Fix login\\" --type=bug" or "list --status=open"',
      }),
      stdin: Type.Optional(
        Type.String({
          description:
            "Content piped to bd's stdin. Pair with `--stdin` (or `--file -` / `--body-file -`) to write multiline notes, descriptions, or comments without shell quoting or argv length limits.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validation = validateBdCommand(params.command);
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: validation.error }],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }

      const stdin = params.stdin;
      if (stdin !== undefined && stdin !== "" && !bdCommandReadsStdin(validation.argv)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "bd command received a `stdin` payload but has no flag that reads stdin. " +
                "Append `--stdin` (or `--file -` / `--body-file -`) so bd consumes it.",
            },
          ],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }

      const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
      try {
        const { stdout, stderr } = await runBdCommand(validation.argv, {
          cwd,
          stdin,
          timeoutInMs: 30_000,
          maxBufferInBytes: 1024 * 1024,
        });
        const text = stdout.trim() || stderr.trim() || "(no output)";
        return {
          content: [{ type: "text" as const, text }],
          details: {
            messages: [],
            usage: emptyUsage(),
            exitCode: 0,
            ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `bd command failed: ${message}` }],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }
    },
  });

  // ── Register archify (diagram generation) tool ──────────────────────
  // Archify compiles a typed JSON IR into one self-contained interactive
  // HTML diagram. It is opt-in (consult-callable) and non-phase, so it is
  // listed in GATED_TOOLS only to survive the process gate — never a
  // required phase step, and never in PLANNING_GATED_TOOLS. `visual-check`
  // and `preview` are excluded upstream subcommands.
  pi.registerTool({
    name: "belayd_archify",
    label: "Archify diagram generator",
    description:
      "Compile a typed archify JSON IR into a self-contained interactive HTML " +
      `diagram. Types: ${ARCHIFY_DIAGRAM_TYPES.join(", ")}. Renderer commands: deliver ` +
      "(default: renders, validates, and writes), render, validate. Read-only guidance " +
      `commands: ${ARCHIFY_GUIDANCE_COMMANDS.join(", ")} — guide returns a recipe list, ` +
      "or a type/scenario recommendation when `scenario` is given; examples lists packaged " +
      "IRs, inspect dumps an architecture layout, check re-validates a delivered HTML. " +
      "Irrelevant params supplied to a guidance command are reported as ignored. " +
      "Authoring guidance lives in .agents/skills/archify/SKILL.md and `$ARCHIFY_HOME` " +
      "(SKILL.md, schemas/, examples/, references/). Output defaults to " +
      "<cwd>/docs/diagrams/<type>.html; committed diagrams live under docs/diagrams/.",
    parameters: Type.Object({
      type: Type.Optional(
        Type.Union(
          ARCHIFY_DIAGRAM_TYPES.map((diagramType) => Type.Literal(diagramType)),
          {
            description: `Diagram type: ${ARCHIFY_DIAGRAM_TYPES.join(", ")}`,
          },
        ),
      ),
      input: Type.Optional(
        Type.String({
          description: "Path to the archify JSON IR file (or an artifact for command=check)",
        }),
      ),
      output: Type.Optional(
        Type.String({
          description: "Output HTML path (default: <cwd>/docs/diagrams/<type>.html)",
        }),
      ),
      command: Type.Optional(
        Type.Union(
          ARCHIFY_TOOL_COMMANDS.map((archifyCommand) => Type.Literal(archifyCommand)),
          {
            description: `Archify command: deliver (default), render, validate, ${ARCHIFY_GUIDANCE_COMMANDS.join(", ")}`,
          },
        ),
      ),
      quality: Type.Optional(
        Type.Union(
          ARCHIFY_QUALITY_PROFILES.map((profile) => Type.Literal(profile)),
          {
            description: "Composition profile: showcase (default) or standard",
          },
        ),
      ),
      repoRoot: Type.Optional(
        Type.String({
          description:
            "Repository root for verified repository source evidence (supported for all five diagram types)",
        }),
      ),
      scenario: Type.Optional(Type.String({ description: "Scenario/question for command=guide" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validation = validateArchifyParams(params);
      if (!validation.ok) {
        return textToolResult(validation.error, 1);
      }

      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const value = validation.value;
      if (value.kind === "diagram") {
        return archifyDiagramToolResult(value, cwd);
      }

      const ignored = ignoredArchifyParams(value.kind, params);
      const note = formatArchifyIgnoredParamsNote(value.kind, ignored);
      return archifyGuidanceToolResult(value, cwd, note);
    },
  });

  // ── Register outline (read-only symbol map) tool ────────────────────
  // A read-only symbol map with line ranges for large TypeScript files.
  // Sub-agents otherwise re-read a file in offset windows to locate the next
  // edit anchor. It is consult-callable and non-phase, so it is listed in
  // GATED_TOOLS only to survive the process gate — never a required workflow
  // step, and never in PLANNING_GATED_TOOLS. The tool only reads files
  // (resolveOutlineTargets + outlineFiles); it exposes no edit/write/bash path.
  pi.registerTool({
    name: "belayd_outline",
    label: "Belayd outline",
    description:
      "Read-only symbol map with line ranges for a TypeScript file, directory, or glob " +
      `(supports *, ?, **; directories are walked for ${OUTLINE_FILE_EXTENSIONS.join("/")}). ` +
      "Returns top-level " +
      "functions, consts, classes, types, interfaces, and enums plus pi.registerTool / " +
      "pi.on registrations, in line order. Use this instead of re-reading a large file " +
      "in offset windows to locate the next edit anchor; pair with `grep -n` for text. " +
      "Output is bounded (~16 KB) and can be narrowed with `kind` or a `name` substring.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "File, directory, or glob relative to the working directory (e.g. src/**/*.ts)",
      }),
      kind: Type.Optional(
        Type.Array(
          Type.Union(
            OUTLINE_KINDS.map((outlineKind) => Type.Literal(outlineKind)),
            { description: `Restrict to kinds: ${OUTLINE_KINDS.join(", ")}` },
          ),
        ),
      ),
      name: Type.Optional(
        Type.String({ description: "Case-insensitive substring filter on the symbol name" }),
      ),
      maxSymbols: Type.Optional(
        Type.Number({ description: "Cap the total number of symbols returned" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validation = validateOutlineParams(params);
      if (!validation.ok) return textToolResult(validation.error, 1);

      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const built = buildOutlineText(cwd, validation.value);
      return built.ok ? textToolResult(built.text, 0) : textToolResult(built.error, 1);
    },
  });

  // ── Register start-task tool ────────────────────────────────────────
  pi.registerTool({
    name: "belayd_start_task",
    label: "Start Belayd Task",
    description:
      "Activate enforced Belayd process. Accepts optional workflow type (feature, bugfix, research, chore, documentation, refactor, hotfix).",
    parameters: Type.Object({
      taskId: Type.String({ description: "Beads issue ID, e.g. bd-42" }),
      workflowType: Type.Optional(
        Type.String({
          description:
            "Workflow sub-type: feature (default), bugfix, research, chore, documentation, refactor, hotfix",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isValidTaskId(params.taskId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid task id: ${params.taskId}. Expected a beads id like "bd-42" or "bd-42.1" (letters/digits after "bd-", dot-separated segments).`,
            },
          ],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }

      const cwd = ctx.cwd ?? process.cwd();
      const metadata = await readTaskMetadata(params.taskId, cwd);
      const toolResolution = await resolveToolWorkflowResolution({
        ctx,
        taskId: params.taskId,
        resolution: resolveWorkflowSelection(params.workflowType, metadata?.labels),
        existingLabels: metadata?.labels,
      });
      if (toolResolution.kind === "denied") return textToolResult(toolResolution.text, 1);

      const resolution = toolResolution.resolution;
      const workflowType = resolution.type;
      // A choose-another-type confirmation already persisted the label; only an
      // explicit arg needs the write-back here.
      if (resolution.source === "arg" && !toolResolution.persisted) {
        await writeWorkflowTypeLabel({
          taskId: params.taskId,
          type: workflowType,
          cwd,
          existingLabels: metadata?.labels,
        });
      }

      const state = activateGate({
        ctx,
        taskId: params.taskId,
        workflowType,
        cwd,
        resolutionSource: resolution.source,
        matchedLabel: resolution.matchedLabel,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `${workflowType} process started for ${params.taskId}.\n\n${formatProcessState([], params.taskId, state.phaseOrder)}`,
          },
        ],
        details: {
          messages: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
            toolCalls: 0,
          },
          exitCode: 0,
        },
      };
    },
  });

  // ── Register start-followup tool ────────────────────────────────────
  //
  // A follow-up workflow is cut from the orchestrator's *current* branch
  // instead of `main`, so the new task builds on the parent's unmerged work.
  // The worktree create path records `branch.<b>.belaydBase` +
  // `.belaydForkPoint` so the stack can later be replayed onto `main` with
  // `git rebase --onto`, even after the parent branch is deleted.
  /** Short human summary of the resolved stack the follow-up branch joins. */
  function describeFollowupStack(cwd: string, leaf: string, base: string): string {
    const resolved = resolveStackChain(cwd, leaf);
    if (resolved.ok && resolved.chain.length > 0) {
      return `Stack: ${resolved.chain.map((node) => node.branch).join(" → ")} → ${DEFAULT_BASE_BRANCH}`;
    }
    return `Stacked on ${base}.`;
  }

  pi.registerTool({
    name: "belayd_start_followup",
    label: "Start stacked follow-up workflow",
    description:
      "Start a new Belayd workflow for a follow-up bead, stacked on the current branch " +
      "instead of main. Records the base branch and fork point so it can later be rebased " +
      "onto main with belayd_stack_rebase.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Beads issue ID for the follow-up, e.g. bd-43" }),
      workflowType: Type.Optional(
        Type.String({
          description:
            "Workflow sub-type: feature (default), bugfix, research, chore, documentation, refactor, hotfix",
        }),
      ),
      base: Type.Optional(
        Type.String({
          description: "Base branch to stack on (defaults to the current branch)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isValidTaskId(params.taskId)) {
        return textToolResult(
          `Invalid task id: ${params.taskId}. Expected a beads id like "bd-42" or "bd-42.1".`,
          1,
        );
      }

      const cwd = ctx.cwd ?? process.cwd();
      const branch = `feat/${params.taskId}`;
      const base = params.base ?? currentBranch(cwd);
      if (base === undefined) {
        return textToolResult(
          "Cannot determine the base branch: the repository is in a detached HEAD state. Pass `base` explicitly.",
          1,
        );
      }
      if (base === branch) {
        return textToolResult(`The follow-up branch ${branch} cannot be stacked on itself.`, 1);
      }

      const metadata = await readTaskMetadata(params.taskId, cwd);
      const toolResolution = await resolveToolWorkflowResolution({
        ctx,
        taskId: params.taskId,
        resolution: resolveWorkflowSelection(params.workflowType, metadata?.labels),
        existingLabels: metadata?.labels,
      });
      if (toolResolution.kind === "denied") return textToolResult(toolResolution.text, 1);

      const resolution = toolResolution.resolution;
      const workflowType = resolution.type;
      // A choose-another-type confirmation already persisted the label; only an
      // explicit arg needs the write-back here.
      if (resolution.source === "arg" && !toolResolution.persisted) {
        await writeWorkflowTypeLabel({
          taskId: params.taskId,
          type: workflowType,
          cwd,
          existingLabels: metadata?.labels,
        });
      }

      const outcome = await launchWorktreeWorkflow({
        ctx,
        taskId: params.taskId,
        workflowType,
        branch,
        base,
        resolutionSource: resolution.source,
        matchedLabel: resolution.matchedLabel,
      });
      if (!outcome.ok) return textToolResult(outcome.error, 1);

      const chainText = describeFollowupStack(cwd, branch, base);
      return textToolResult(
        `Follow-up ${workflowType} workflow started for ${params.taskId} on ${branch}, stacked on ${base}.\n\n${chainText}`,
        0,
      );
    },
  });

  /**
   * Whether a resolved chain has nothing to replay: either it carries no
   * recorded stack metadata, or it is a single level already rooted at main
   * (unless an explicit landed signal forces a replay).
   */
  function isStackAlreadyOnMain(chain: readonly StackNode[], forceLanded: boolean): boolean {
    if (chain.length === 0) return true;
    if (forceLanded || chain.length !== 1) return false;
    const only = chain[0];
    return (
      only !== undefined && only.base === DEFAULT_BASE_BRANCH && only.landedParent === undefined
    );
  }

  // ── Register stack-rebase tool ──────────────────────────────────────
  pi.registerTool({
    name: "belayd_stack_rebase",
    label: "Rebase stacked workflow",
    description:
      "Replay the current stacked branch onto its base after the base has landed, using " +
      "`git rebase --onto` so the base's commits are not replayed. Pass `baseLanded: true` " +
      "when the immediate parent landed but its branch ref still exists (squash-merge case).",
    parameters: Type.Object({
      baseLanded: Type.Optional(
        Type.Boolean({
          description:
            "Explicit confirmation that the immediate parent has landed; forces the branch onto main even if the parent ref still exists.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const branch = currentBranch(cwd);
      if (branch === undefined) {
        return textToolResult(
          "Cannot determine the current branch (detached HEAD?); nothing to rebase.",
          1,
        );
      }

      const forceLanded = params.baseLanded === true;
      const resolved = resolveStackChain(cwd, branch);
      if (!resolved.ok) {
        return textToolResult(`Stack resolution failed: ${resolved.error}`, 1);
      }
      if (isStackAlreadyOnMain(resolved.chain, forceLanded)) {
        return textToolResult(
          `${branch} is already based on ${DEFAULT_BASE_BRANCH}; nothing to rebase.`,
          0,
        );
      }

      const result = runStackRebase(defaultGitExec, {
        cwd,
        leaf: branch,
        stash: true,
        forceLanded,
      });
      if (!result.ok) {
        return textToolResult(
          formatStackRebaseFailure({
            result,
            fallbackBranch: branch,
            fallbackCwd: cwd,
            retryCommand: "belayd_stack_rebase",
          }),
          1,
        );
      }

      if (result.rebased.length === 0) {
        const reasons = result.skipped
          .map((skip) => `  - ${skip.branch}: ${skip.reason}`)
          .join("\n");
        return textToolResult(
          `${branch} is already up to date with its base; nothing to rebase.${reasons === "" ? "" : `\n${reasons}`}`,
          0,
        );
      }

      const lines = [
        `Rebased ${result.rebased.length} branch(es) stepwise onto their bases:`,
        ...result.rebased.map((name) => `  - ${name}`),
      ];
      return textToolResult(lines.join("\n"), 0);
    },
  });

  // ── Register stop-task tool ─────────────────────────────────────────
  pi.registerTool({
    name: "belayd_stop_task",
    label: "Stop Belayd Task",
    description: "Deactivate the enforced Belayd process for the current task.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const telemetryCwd = ctx.cwd;

      // In-flight background runs must not survive task teardown.
      abortAndResetRunTracking(state);

      // Restore original cwd if we're in a worktree
      const persisted = readWorkflowState({ cwd: ctx.cwd });
      if (persisted) {
        process.chdir(persisted.originalCwd);
        clearWorkflowState({ cwd: ctx.cwd });
      }

      state.gateActive = false;
      state.completedPhaseNames = [];
      state.workflowType = "feature";
      state.phaseOrder = getPhasesForType("feature");
      state.optionalPhases = WORKFLOW_REGISTRY.feature.optionalPhases ?? [];
      state.consultPhases = WORKFLOW_REGISTRY.feature.consultPhases ?? [];
      state.userGuideContent = undefined;
      state.proofOutput = undefined;
      state.proofVerifierVerdict = undefined;
      state.awaitingReviewResponse = false;
      applyToolGate(state);
      // Flush and log the stopped workflow's telemetry once, then reset.
      resetModelTelemetry(telemetryCwd, { log: true });
      return {
        content: [
          {
            type: "text" as const,
            text: "Belayd process deactivated.",
          },
        ],
        details: {
          messages: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
            toolCalls: 0,
          },
          exitCode: 0,
        },
      };
    },
  });

  // ── Register stop-planning tool ──────────────────────────────────────
  pi.registerTool({
    name: "belayd_stop_planning",
    label: "Stop planning mode",
    description: "Exit planning mode, abort any planning sub-agent runs, and restore full tools.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      abortAndResetRunTracking(state);
      state.planningActive = false;
      state.planningTarget = undefined;
      applyToolGate(state);
      return {
        content: [
          {
            type: "text" as const,
            text: "Planning mode deactivated.",
          },
        ],
        details: {
          messages: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
            toolCalls: 0,
          },
          exitCode: 0,
        },
      };
    },
  });

  // ── Helpers for commit tool ─────────────────────────────────────────
  //
  // Residual risk: argv removes shell injection, but argument confusion is
  // only partly fixed. `--` shields `git add` paths and the `bd update`/`bd
  // note` taskId positionals; taskId safety additionally rests on the
  // `isValidTaskId` guard at the `belayd_commit` entry point.

  /**
   * Recovery note for a pre-rebase `git stash` entry, which is deliberately left
   * in place on any conflict so uncommitted work is never lost. The two kinds
   * differ: an interrupted rebase still needs the stash reapplied, while a
   * failed `git stash pop` already applied its changes (with conflicts) and only
   * needs the stale entry dropped.
   */
  function stashRecoveryNote(result: { stashed?: boolean; stashPopConflicted?: boolean }): string {
    if (result.stashed !== true) return "";
    if (result.stashPopConflicted === true) {
      return (
        "\n\nA `git stash` entry created before this rebase is still present. The rebase " +
        "itself succeeded but restoring the stash conflicted; resolve those conflicts, then run " +
        "`git stash drop` (the changes are already in the worktree)."
      );
    }
    return (
      "\n\nYour uncommitted changes were stashed before this rebase and the stash entry is " +
      "still present; run `git stash pop` after the rebase conflict is resolved to restore them."
    );
  }

  /**
   * Render a failed stack-rebase result as actionable text. Conflicts include
   * the branch's worktree and the continue/abort/retry steps so the agent (or
   * human) can recover without guessing where the rebase stopped.
   */
  function formatStackRebaseFailure(options: {
    result: {
      error: string;
      branch?: string;
      worktree?: string;
      conflicts?: boolean;
      stashed?: boolean;
      stashPopConflicted?: boolean;
    };
    fallbackBranch: string;
    fallbackCwd: string;
    retryCommand: string;
  }): string {
    const branch = options.result.branch ?? options.fallbackBranch;
    if (options.result.conflicts !== true) {
      return `Stack rebase failed for ${branch}: ${options.result.error}`;
    }
    const location = options.result.worktree ?? options.fallbackCwd;
    return (
      `Stack rebase failed for ${branch}: ${options.result.error}\n\n` +
      `Resolve the conflicts in ${location}, then run \`git rebase --continue\` ` +
      `(or \`git rebase --abort\` to back out), and re-run \`${options.retryCommand}\`.` +
      stashRecoveryNote(options.result)
    );
  }

  /**
   * Rebase a stacked branch before committing when its base has landed.
   *
   * The landed signal is authoritative only when explicit (`rebaseStack`) or
   * corroborated by a recorded parent that is gone; ambiguous cases are left
   * untouched so a wrong guess never rewrites history. Toggle off with
   * `BELAYD_STACK_AUTO_REBASE` or `git config belayd.stack.autoRebase false`.
   */
  async function maybeAutoRebaseBeforeCommit(options: {
    cwd: string;
    force: boolean;
  }): Promise<{ ok: true; rebased: string[] } | { ok: false; error: string }> {
    const branch = currentBranch(options.cwd);
    if (branch === undefined || readStackNode(options.cwd, branch) === undefined) {
      return { ok: true, rebased: [] };
    }

    const resolved = resolveStackChain(options.cwd, branch);
    if (!resolved.ok) return { ok: false, error: `Stack resolution failed: ${resolved.error}` };
    const hasLandedParent = resolved.chain.some((node) => node.landedParent !== undefined);
    if (!options.force && !hasLandedParent) return { ok: true, rebased: [] };
    if (!resolveAutoRebaseEnabled(options.cwd)) return { ok: true, rebased: [] };

    const result = runStackRebase(defaultGitExec, {
      cwd: options.cwd,
      leaf: branch,
      stash: true,
      forceLanded: options.force,
    });
    if (!result.ok) {
      return {
        ok: false,
        error: formatStackRebaseFailure({
          result,
          fallbackBranch: branch,
          fallbackCwd: options.cwd,
          retryCommand: "belayd_commit",
        }),
      };
    }
    return { ok: true, rebased: result.rebased };
  }

  async function _stageChanges(cwd: string, files?: string[]): Promise<string | null> {
    try {
      const paths = (files ?? []).filter((file) => file.length > 0);
      // `--` keeps leading-dash paths literal.
      const argv = paths.length > 0 ? ["add", "--", ...paths] : ["add", "-A"];
      await runGitCommand(argv, { cwd, timeoutInMs: 30_000, maxBufferInBytes: 1024 * 1024 });
      return null;
    } catch (err) {
      return `Failed to stage changes: ${err instanceof Error ? err.message : err}`;
    }
  }

  /**
   * Read the new commit's short hash.
   *
   * `rev-parse` is authoritative; the regex fallback covers a git too old (or
   * a hook that swallows stdout) to be trusted. Never throws — an unknown hash
   * is cosmetic and must not fail an otherwise successful commit.
   */
  async function resolveCommitHash(cwd: string, output: string): Promise<string> {
    try {
      const { stdout } = await runGitCommand(["rev-parse", "--short", "HEAD"], {
        cwd,
        timeoutInMs: 15_000,
        maxBufferInBytes: 1024 * 1024,
      });
      const hash = stdout.trim();
      if (hash.length > 0) return hash;
    } catch {
      // fall through to parsing the commit output
    }
    // Covers git's `[<branch> <hash>]` summary line; the branch may contain
    // spaces in git's abbreviated form, so anchor on the last token.
    const match = output.match(/\[[^\]]*?\s([0-9a-f]{7,})\]/);
    return match?.[1] ?? "unknown";
  }

  async function _runCommit(
    message: string,
    cwd: string,
  ): Promise<{ hash: string; output: string } | string> {
    // `randomUUID` (not a timestamp) keeps two commits in the same process and
    // millisecond from sharing a file and clobbering each other's message.
    const messageFile = join(tmpdir(), `belayd-commit-msg-${process.pid}-${randomUUID()}.txt`);
    try {
      // `-F` avoids both shell interpolation and argv length limits. Unlike an
      // editor-driven message, git defaults `-F` to cleanup=whitespace, so a
      // leading `#` line survives instead of being stripped as a comment — but
      // only when the message is non-empty after cleanup; an all-`#`/whitespace
      // message strips to empty and git aborts (exit 1), surfacing as a raw git
      // error through the catch below. That failure path is acceptable.
      writeFileSync(messageFile, message, "utf-8");
      const { stdout, stderr } = await runGitCommand(["commit", "-F", messageFile], {
        cwd,
        timeoutInMs: 300_000,
        maxBufferInBytes: 10 * 1024 * 1024,
      });
      const output = stdout || stderr;
      return { hash: await resolveCommitHash(cwd, output), output };
    } catch (err) {
      return err instanceof Error ? err.message : "Commit failed";
    } finally {
      removeFileQuietly(messageFile);
    }
  }

  async function _flagForHumanReview(taskId: string, cwd: string): Promise<string | null> {
    try {
      // The `human` label surfaces the bead in Bead Me Up, Scotty's "Needs You"
      // inbox; `in_progress` keeps it out of `bd ready` until the human merges.
      // Flags precede `--` so the taskId is parsed as a positional even if it
      // starts with `-`; pflag stops flag parsing at the separator.
      await runBdCommand(
        ["update", "--status", "in_progress", "--add-label", "human", "--", taskId],
        {
          cwd,
          stdin: undefined,
          timeoutInMs: 15_000,
          maxBufferInBytes: 1024 * 1024,
        },
      );
      return null;
    } catch (err) {
      return `Failed to flag beads issue for human review: ${err instanceof Error ? err.message : err}`;
    }
  }

  async function extractCommitFeedback(
    rawOutput: string,
    ctx: ExtensionContext | undefined,
  ): Promise<string> {
    if (!ctx?.modelRegistry || !ctx?.model) return rawOutput;
    try {
      const response = await ctx.modelRegistry.complete(ctx.model, {
        systemPrompt:
          "You are a commit-failure analyzer. Given the raw output of a failed `git commit` " +
          "(which includes lefthook pre-commit hook output with lint, typecheck, and test results), " +
          "extract ONLY the actionable failure messages. Focus on: actual errors, test failures, " +
          "lint violations, type errors. Ignore progress bars, cache messages, summary lines. " +
          "Return a concise bullet list of what needs to be fixed.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: rawOutput }],
            timestamp: Date.now(),
          },
        ],
      });
      const extracted = response.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      return extracted.trim() || rawOutput;
    } catch {
      return rawOutput;
    }
  }

  /** Flag a beads issue for human review, surfacing any failure as a warning. */
  async function flagForHumanReview(taskId: string, cwd: string): Promise<void> {
    const updateError = await _flagForHumanReview(taskId, cwd);
    if (updateError) {
      pi.sendMessage(
        { customType: "belayd-warning", content: updateError, display: true },
        { triggerTurn: false },
      );
    }
  }

  /** Append user-guide content to a task's notes; best-effort and non-blocking. */
  async function appendUserGuideNote(taskId: string, content: string, cwd: string): Promise<void> {
    try {
      // Piping via `--stdin` keeps the body out of argv and avoids a temp file
      // that could leak if the process dies mid-append.
      await runBdCommand(["note", "--stdin", "--", taskId], {
        cwd,
        stdin: content,
        timeoutInMs: 15_000,
        maxBufferInBytes: 1024 * 1024,
      });
    } catch {
      // Best-effort: don't block commit on note append failure
    }
  }

  /** Unlink a file, ignoring any failure (used for temp-message cleanup). */
  function removeFileQuietly(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // cleanup failed, file will be removed eventually
    }
  }

  /** Build the failure result returned when commit fails. */
  function commitFailure(text: string, stderr?: string) {
    return {
      content: [{ type: "text" as const, text }],
      details: {
        messages: [],
        usage: emptyUsage(),
        exitCode: 1,
        ...(stderr !== undefined ? { stderr } : {}),
      },
    };
  }

  /** Record the commit phase's "running" manifest, returning whether the gate owns the run. */
  function startCommitRunManifest(options: {
    state: SessionState;
    cwd: string;
    runId: string;
  }): boolean {
    if (!options.state.gateActive || options.state.currentTaskId === "") return false;
    const writeResult = writeRunManifest({
      cwd: options.cwd,
      manifest: {
        schemaVersion: 1,
        runId: options.runId,
        taskId: options.state.currentTaskId,
        phase: "commit",
        sessionName: computeSubagentSessionName(
          options.state.currentTaskId,
          "commit",
          options.runId,
        ),
        status: RunStatus.Running,
        startedAt: Date.now(),
      },
    });
    if (!writeResult.ok) {
      console.warn(`[belayd-harness] failed to persist commit run manifest: ${writeResult.error}`);
    }
    return true;
  }

  /** Mark the commit run finished and, on success, persist the completed phases. */
  function finalizeCommitRun(options: {
    state: SessionState;
    cwd: string;
    runId: string;
    status: RunStatus.Completed | RunStatus.Failed;
    gateCommit: boolean;
  }): void {
    if (!options.gateCommit) return;
    markCommitRunStatus({
      cwd: options.cwd,
      runId: options.runId,
      status: options.status,
    });
    if (options.status === RunStatus.Completed) {
      // Commit is no longer marked at tool_call time (phase runs are
      // non-blocking), so record it here for the agent_end workflow-complete
      // check to fire.
      options.state.completedPhaseNames = markPhaseCompleted(
        "belayd_commit",
        options.state.completedPhaseNames,
        options.state.phaseOrder,
      );
      // Commit is the last phase; completing it disarms the resumable-fix loop.
      options.state.awaitingReviewResponse = nextAwaitingReviewResponse({
        awaiting: options.state.awaitingReviewResponse,
        completedPhaseName: COMMIT_PHASE,
        phaseOrder: options.state.phaseOrder,
        reviewCompleted: options.state.completedPhaseNames.includes(REVIEW_PHASE),
      });
      persistCompletedPhases({
        cwd: options.cwd,
        completedPhaseNames: options.state.completedPhaseNames,
        awaitingReviewResponse: options.state.awaitingReviewResponse,
      });
    }
  }

  /** Mark a commit phase run's manifest status (best-effort). */
  function markCommitRunStatus(options: {
    cwd: string;
    runId: string;
    status: RunStatus.Completed | RunStatus.Failed;
  }): void {
    const statusResult = setRunStatus({
      cwd: options.cwd,
      runId: options.runId,
      status: options.status,
      exitCode: options.status === RunStatus.Completed ? 0 : 1,
    });
    if (!statusResult.ok) {
      console.warn(`[belayd-harness] failed to update commit run manifest: ${statusResult.error}`);
    }
  }

  /** Append userguide + proof-verifier verdict notes (best-effort). */
  async function appendTaskNotes(taskId: string, state: SessionState, cwd: string): Promise<void> {
    if (state.userGuideContent && state.phaseOrder.includes("userguide")) {
      await appendUserGuideNote(taskId, state.userGuideContent, cwd);
    }
    if (state.proofVerifierVerdict) {
      await appendUserGuideNote(taskId, state.proofVerifierVerdict, cwd);
    }
  }

  /** Tool failure result for an invalid commit task id. */
  function invalidCommitTaskIdResult(taskId: string) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Invalid task id: ${taskId}. Expected a beads id like "bd-42" or "bd-42.1" (letters/digits after "bd-", dot-separated segments).`,
        },
      ],
      details: { messages: [], usage: emptyUsage(), exitCode: 1 },
    };
  }

  /** Flag a task for human review and append its notes, when a task id was given. */
  async function maybeFlagTaskForHumanReview(
    taskId: string | undefined,
    state: SessionState,
    cwd: string,
  ): Promise<void> {
    if (taskId === undefined) return;
    await flagForHumanReview(taskId, cwd);
    await appendTaskNotes(taskId, state, cwd);
  }

  // ── Register commit tool ────────────────────────────────────────────
  pi.registerTool({
    name: "belayd_commit",
    label: "Commit changes",
    description:
      "Stage changes and commit with a conventional commit message. " +
      "Stage only the given files when provided; otherwise stage everything. " +
      "On failure, extracts actionable feedback using a cheap model.",
    parameters: Type.Object({
      message: Type.String({
        description: "Conventional commit subject line, e.g. 'feat(auth): add OIDC flow (bd-42)'",
      }),
      body: Type.Optional(
        Type.String({ description: "Extended commit body with details (optional)" }),
      ),
      files: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description:
            "File paths to stage specifically. Omit or pass an empty array to stage all changes.",
        }),
      ),
      taskId: Type.Optional(
        Type.String({ description: "Beads issue ID to flag for human review (e.g. bd-42)" }),
      ),
      rebaseStack: Type.Optional(
        Type.Boolean({
          description:
            "Force a stack rebase before committing (confirm the parent landed). Also controlled by BELAYD_STACK_AUTO_REBASE / git config belayd.stack.autoRebase.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.taskId !== undefined && !isValidTaskId(params.taskId)) {
        return invalidCommitTaskIdResult(params.taskId);
      }

      const cwd = ctx?.cwd ?? process.cwd();
      const state = getSessionState(ctx);
      const runId = generateShortRunId();
      const gateCommit = startCommitRunManifest({ state, cwd, runId });

      // Rebase before staging so the commit lands on the landed base. Abort on
      // failure: committing a half-rebased tree would produce a broken history.
      const rebase = await maybeAutoRebaseBeforeCommit({
        cwd,
        force: params.rebaseStack === true,
      });
      if (!rebase.ok) {
        finalizeCommitRun({ state, cwd, runId, gateCommit, status: RunStatus.Failed });
        return commitFailure(rebase.error);
      }
      const rebasedBranches = rebase.rebased;

      // Flag the issue for human review (agents never close — human closes on wt merge).
      // Done before staging so the JSONL export (export.auto + git-add) is committed.
      await maybeFlagTaskForHumanReview(params.taskId, state, cwd);

      const stageError = await _stageChanges(cwd, params.files);
      if (stageError) {
        finalizeCommitRun({ state, cwd, runId, gateCommit, status: RunStatus.Failed });
        return commitFailure(stageError);
      }

      const fullMessage = params.body ? `${params.message}\n\n${params.body}` : params.message;

      const commitResult = await _runCommit(fullMessage, cwd);
      if (typeof commitResult === "string") {
        finalizeCommitRun({ state, cwd, runId, gateCommit, status: RunStatus.Failed });
        const feedback = await extractCommitFeedback(commitResult, ctx);
        return commitFailure(feedback, commitResult);
      }

      finalizeCommitRun({ state, cwd, runId, gateCommit, status: RunStatus.Completed });

      const rebaseNote =
        rebasedBranches.length > 0
          ? `\nRebased stacked branch(es): ${rebasedBranches.join(", ")}`
          : "";
      return {
        content: [
          { type: "text" as const, text: `Committed as ${commitResult.hash}${rebaseNote}` },
        ],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });

  // ── Bash timeout enforcement ───────────────────────────────────────
  // Separate from the process-gate `tool_call` handler below so the gate's
  // early returns cannot skip it. Mutates `event.input` in place (pi applies
  // the patch before execution and does not re-validate) instead of blocking,
  // guaranteeing every bash call — orchestrator or sub-agent — is bounded.
  // Registered first, do not reorder: pi's emitToolCall short-circuits once a
  // handler returns `block: true`, so moving this below the process gate would
  // let a rejected call skip the timeout patch.
  pi.on("tool_call", (event) => {
    if (!isBashToolCallEvent(event)) return {};
    event.input.timeout = resolveBashTimeout(event.input);
    return {};
  });

  // ── Process gate: block out-of-sequence tool calls ──────────────────
  pi.on("tool_call", (event, ctx) => {
    const state = getSessionState(ctx);
    if (state.planningActive) {
      const toolName = event.toolName;
      const isPlanningSubagent =
        toolName === "belayd_plan_scout" || toolName === "belayd_plan_research";
      const isBlockedDuringRun =
        (isPlanningSubagent || toolName === "bd") && state.activeRuns.size > 0;
      if (isBlockedDuringRun) {
        const activeRunIds = [...state.activeRuns.keys()].join(", ");
        const reason =
          `A planning run is already in progress (run ${activeRunIds}). ` +
          `Wait for its follow-up result before launching another sub-agent or writing beads.`;
        abortToolCall(event, "planning-run-in-flight", reason);
        return { block: true, reason };
      }
      return {};
    }
    if (!state.gateActive) return {};
    return evaluateToolCallGate(event, state);
  });

  // ── Uncommitted-files notification ────────────────────────────────
  pi.on("agent_end", async (_event, ctx) => {
    const count = await countUncommittedFiles(ctx.cwd);
    if (count !== null && count > 0) {
      const label = count === 1 ? "file" : "files";
      ctx.ui.notify(`${count} uncommitted ${label}`, "warning");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getSessionState(ctx);
    if (!state.gateActive) return;
    if (isWorkflowComplete(state.completedPhaseNames, state.phaseOrder)) {
      const currentPhaseOrder = [...state.phaseOrder];
      const currentTaskId = state.currentTaskId;
      const currentCompleted = [...state.completedPhaseNames];

      // Compact completed phase sessions before resetting state
      await compactTaskSessions(currentTaskId, currentCompleted);

      // Workflow complete: the persisted state file is no longer needed.
      clearWorkflowState({ cwd: ctx.cwd });
      // Log the workflow's telemetry summary exactly once here, then start a
      // fresh store so a later phase-run settle cannot re-log it.
      resetModelTelemetry(ctx.cwd, { log: true });

      state.gateActive = false;
      // Any watcher still pending across completion is now stale.
      state.runEpoch += 1;
      state.completedPhaseNames = [];
      state.workflowType = "feature";
      state.phaseOrder = getPhasesForType("feature");
      state.optionalPhases = WORKFLOW_REGISTRY.feature.optionalPhases ?? [];
      state.consultPhases = WORKFLOW_REGISTRY.feature.consultPhases ?? [];
      state.userGuideContent = undefined;
      state.proofOutput = undefined;
      state.proofVerifierVerdict = undefined;
      applyToolGate(state);
      pi.sendMessage(
        {
          customType: "process-complete",
          content: formatProcessState(currentCompleted, currentTaskId, currentPhaseOrder),
          display: true,
        },
        { triggerTurn: false },
      );
    }
  });
}
