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
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  AckNotesResult,
  AgentDefinition,
  ArchifyCommand,
  ArchifyDiagramType,
  ArchifyQuality,
  ArchifyTextResult,
  BelaydCommandArgs,
  FleetBeadLookup,
  FleetEventBatch,
  FleetMemberLaunchOutcome,
  FleetMode,
  FleetNoteDelivery,
  FleetNoteKind,
  FleetPidProbe,
  FleetProcessScan,
  FleetStatus,
  HandedOffMarker,
  HandoffPacket,
  MemberPidOutcome,
  ModelClass,
  OutlineFilesOptions,
  OutlineKind,
  OwnedWorktreeResult,
  Phase,
  QualityGate,
  RunDelivery,
  RunHandle,
  RunManifest,
  SpawnResult,
  StackNode,
  SubagentSessionRef,
  TranscriptEntry,
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
  ackNotes,
  appendFleetAuditEntry,
  applyFleetBeadLookup,
  assertOwnedWorktree,
  awaitWorktreeReady,
  bdCommandReadsStdin,
  boundReviewOutput,
  buildArchifyArgs,
  buildArchifyCheckArgs,
  buildArchifyGuideArgs,
  buildArchifyInspectArgs,
  buildFleetNote,
  buildOrchestratorPrompt,
  buildVerifierPrompt,
  checkToolAllowed,
  clearHandoff,
  collectChangeContext,
  collectHandoffDefault,
  collectReviewDiff,
  createInstructionGroupCollector,
  currentBranch,
  DEFAULT_AGENTS,
  DEFAULT_BASE_BRANCH,
  DEFAULT_FLEET_ID,
  defaultFleetMergeGitRunner,
  defaultGitExec,
  drainFleetMerge,
  drainNotes,
  enqueueFleetMerge,
  enqueueNoteFanout,
  extractOutlineSymbols,
  extractProofArtifacts,
  FLEET_NOTE_BROADCAST,
  FLEET_NOTE_KINDS,
  FLEET_NOTE_SUPERVISOR,
  findWorkspaceRoot,
  fleetBeadTaskIds,
  fleetMemberTaskIds,
  formatArchifyIgnoredParamsNote,
  formatArchifyResult,
  formatFleetInbox,
  formatFleetMergeQueue,
  formatFleetRefusal,
  formatFleetStatus,
  formatHandoffBlock,
  formatOutline,
  formatProcessState,
  formatReviewTask,
  formatWorktreePreamble,
  getAgentByShortName,
  getNextPhase,
  getPhasesForType,
  getPhaseToolName,
  INSTRUCTION_GROUPS_CHANNEL,
  ignoredArchifyParams,
  isArchifyDiagramType,
  isArchifyQuality,
  isArchifyToolCommand,
  isFleetNoteKind,
  isFleetRefusedTool,
  isInsideWorktreeForBranch,
  isOutlineKind,
  isProcessAlive,
  isSafeChdirTarget,
  isSameOrDescendantTask,
  isValidTaskId,
  isValidWorkflowType,
  isWorkflowComplete,
  lastAssistantText,
  listArchifyExamples,
  listPendingUserCompletions,
  listRuns,
  lookupFleetBeads,
  lookupFleetDependencies,
  manageInstructionGroups,
  manageInstructionGroupsWarning,
  markPhaseCompleted,
  matchOwnedWorktree,
  matchSessionOwnedWorktree,
  memberSessionToken,
  NO_GROUP_REGISTERED_WARNING,
  narrowTranscriptEntries,
  OUTLINE_FILE_EXTENSIONS,
  OUTLINE_KINDS,
  outlineFiles,
  PLANNING_MODE_SYSTEM_PROMPT,
  PLANNING_MODE_TOOLS,
  PROOF_VERIFIER_AGENT,
  PROOF_VERIFIER_TOOLS,
  parseBelaydCommandArgs,
  parseFleetCommandArgs,
  parseFleetTaskIds,
  parseSubagentSessionName,
  parseWorkflowLabel,
  pauseFleet,
  planFleetAdvance,
  RESEARCHER_SYSTEM_PROMPT,
  RESEARCHER_TOOLS,
  RunStatus,
  readFleetIntent,
  readFleetMergeQueue,
  readFleetStatus,
  readHandoff,
  readHandoffFileArg,
  readProcessStartTime,
  readStackNode,
  readWorktreeBranch,
  resolveArchifyHome,
  resolveAutoRebaseEnabled,
  resolveBashTimeout,
  resolveFleetMode,
  resolveFleetNoteRecipients,
  resolveGitCommonDir,
  resolveMemberFleet,
  resolveModelSpec,
  resolveOutlineTargets,
  resolveQualityGate,
  resolveStackChain,
  resolveWorkflowSelection,
  resolveWorktreePath,
  resumeFleet,
  runArchify,
  runArchifyText,
  runFleetLaunch as runFleetLaunchEngine,
  runFleetReconcile,
  runStackRebase,
  sanitizeFleetId,
  scanProcesses,
  scanProofRefs,
  selectFleetEvents,
  setupWorktree,
  spawnAgentWithFallback,
  spawnDetachedRun,
  stopMemberSession,
  taskIdFromBranch,
  userGuideDocPath,
  validateBdCommand,
  WF_LABEL_PREFIX,
  WORKFLOW_REGISTRY,
  WORKFLOW_SUB_TYPES,
  watchRunCompletion,
  writeHandoff,
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
  clearCallerHandoff,
  clearHandedOffMarker,
  clearWorkflowState,
  readCallerHandoff,
  readWorkflowState,
  saveCompletedPhases,
  saveHandedOffMarker,
  savePhaseSession,
  saveReviewedSha,
  writeCallerHandoff,
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
   * The arm token this session minted for a fleet it supervises (W6). It exists
   * only here — never written anywhere but the fleet intent — so a `fleet.json`
   * planted by another writer cannot match it.
   */
  fleetArm?: { fleetId: string; token: string };
  /**
   * Events injected into the current turn and not yet acknowledged (W4).
   *
   * The ack happens in `agent_end`, *after* the model has read the injected
   * message, so a crash between injection and ack replays the note instead of
   * losing it (at-least-once). Acking inside `before_agent_start` would make the
   * delivery at-most-once, which is what the docstring used to claim.
   */
  pendingFleetEventAcks?: {
    fleetId: string;
    gitCommonDir: string;
    dir: string;
    deliveries: FleetNoteDelivery[];
  };
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
/**
 * Resolve a `--handoff` value into text. `@path` reads the file relative to the
 * calling session's cwd — pi-web processes run with cwd `/`, so resolving
 * against `process.cwd()` would silently miss the file. The read itself is
 * bounded and regular-file-only (see `readHandoffFileArg`).
 */
function resolveHandoffArg(
  handoff: string | undefined,
  cwd: string,
): { ok: true; text: string | undefined } | { ok: false; error: string } {
  if (handoff === undefined || !handoff.startsWith("@")) {
    return { ok: true, text: handoff };
  }
  const handoffPath = handoff.slice(1);
  const resolvedPath = isAbsolute(handoffPath) ? handoffPath : join(cwd, handoffPath);
  const read = readHandoffFileArg({ path: resolvedPath });
  return read.ok ? { ok: true, text: read.text } : read;
}

/** Usage text for `/belayd`; shared by every rejection path. */
function belaydUsageText(): string {
  return [
    "Usage: /belayd bd-42 [type] [--no-worktree] [--handoff <text|@path>] [--force]",
    "  taskId: beads issue or subtask ID (e.g. bd-42, bd-42.1)",
    "  type: optional; omit to use the bead's wf:<type> label. Valid: feature (default), bugfix, research, chore, documentation, refactor, hotfix",
    "  --no-worktree: activate gate in the current directory, no worktree or daemon",
    "  --handoff <text|@path>: context for the spawned orchestrator. Everything after the flag is its value (quote multi-word text); `@path` reads a file relative to the current directory",
    "  --force: hand off even while this session has phase runs in flight or is already inside the target worktree (the live runs are abandoned)",
  ].join("\n");
}

/**
 * Whether the parsed arguments can start a workflow. A bare `--handoff` is a
 * usage error rather than "no handoff": silently dropping it would launch a
 * child with no context while looking successful.
 */
function isUsableBelaydInvocation(args: BelaydCommandArgs): boolean {
  return (
    args.taskId !== "" &&
    isValidTaskId(args.taskId) &&
    (!args.handoffFlagPresent || args.handoff !== undefined)
  );
}
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

/** Normalize an unknown thrown/rejected value for an error message. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Status line for a session that handed its workflow to a child orchestrator.
 * It must never read like a live workflow: the caller has no gate and no phase
 * tools, and the bead is owned by the child session (bd-120).
 */
function formatHandedOffStatus(marker: HandedOffMarker): string {
  return (
    `**Handed off** — ${marker.taskId} is owned by session \`${marker.sessionId}\` ` +
    `in worktree \`${marker.branch}\`; this session no longer drives a workflow.`
  );
}

/**
 * First status section: a handoff wins over a live workflow, because a
 * handed-off session keeps no gate but must still explain where the bead went.
 */
function formatWorkflowStatusSection(state: SessionState): string {
  if (state.handedOffTo !== undefined) return formatHandedOffStatus(state.handedOffTo);
  if (!state.gateActive) return "Belayd process is inactive.";
  return formatProcessState(state.completedPhaseNames, state.currentTaskId, state.phaseOrder);
}

/** Active-run list for `belayd_status` (always printed, even when empty). */
function formatActiveRunsSection(
  activeRuns: ReadonlyMap<string, { handle: { phaseName: string; status: string } }>,
): string {
  const lines = ["**Active runs**"];
  if (activeRuns.size === 0) {
    lines.push("(none)");
    return lines.join("\n");
  }
  for (const [runId, { handle }] of activeRuns) {
    lines.push(`- \`${runId}\` — ${handle.phaseName} (${handle.status})`);
  }
  return lines.join("\n");
}

/** Mark every pending user completion delivered; returns per-run outcome labels. */
function markPendingCompletionsDelivered(options: {
  cwd: string;
  /** Runs for this task belong to the child orchestrator; leave them alone. */
  skipTaskId: string;
}): { delivered: string[]; undeliverable: string[] } {
  const delivered: string[] = [];
  const undeliverable: string[] = [];
  for (const run of listPendingUserCompletions({ cwd: options.cwd })) {
    if (run.taskId === options.skipTaskId) continue;
    const result = markRunDelivered({ cwd: options.cwd, runId: run.runId });
    if (result.ok) {
      delivered.push(`${run.runId} (${run.phase})`);
    } else {
      undeliverable.push(`${run.runId} (${run.phase}: ${result.error})`);
    }
  }
  return { delivered, undeliverable };
}

/** Compose the handed-off pending-items summary, or undefined when nothing was found. */
function formatHandoffPendingNotice(options: {
  taskId: string;
  interrupted: RunManifest[];
  delivered: string[];
  undeliverable: string[];
}): string | undefined {
  const parts: string[] = [];
  if (options.interrupted.length > 0) {
    const runs = options.interrupted.map((run) => `${run.runId} (${run.phase})`).join(", ");
    parts.push(`${options.interrupted.length} interrupted phase run(s): ${runs}`);
  }
  if (options.delivered.length > 0) {
    parts.push(
      `${options.delivered.length} pending user completion(s) marked delivered without applying them ` +
        `(this session no longer drives ${options.taskId}): ${options.delivered.join(", ")}`,
    );
  }
  if (options.undeliverable.length > 0) {
    parts.push(
      `could not mark ${options.undeliverable.length} pending user completion(s) delivered: ` +
        options.undeliverable.join(", "),
    );
  }
  if (parts.length === 0) return undefined;
  return `Handed off to ${options.taskId}: ${parts.join("; ")}.`;
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
 *
 * `artifactLine` names the phase's on-disk deliverable when it produced one
 * (the userguide markdown), so the operator sees the record without opening
 * beads or the worktree.
 */
function buildRunCompleteContent(
  delivery: RunDelivery,
  reviewLoopHint: string,
  artifactLine: string,
): string {
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
  return `${header}${reasonNote}\n\n${artifactLine}${text}${failureGuidance}${reviewLoopHint}`;
}

/**
 * Deliverable pointer for a completed userguide run, or "" when the phase left
 * no artifact. Gated on the file actually existing: the follow-up must never
 * claim a record that a failed run did not write.
 */
function userGuideArtifactLine(
  delivery: RunDelivery,
  options: { cwd: string; taskId: string },
): string {
  if (!delivery.success || delivery.phaseName !== "userguide" || options.taskId === "") return "";
  const docPath = userGuideDocPath(options.taskId);
  if (!existsSync(resolve(options.cwd, docPath))) return "";
  return `📄 **User guide written to \`${docPath}\`** — How to Verify + How to Use.\n\n`;
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
 * Resolve, extract, and format an outline. Errors are values, never throws.
 *
 * Extraction shells out to universal-ctags and ast-grep through an async
 * `execFile` seam, so a slow or hung parser never blocks pi's event loop; a
 * missing binary, a bad exit, or a partial-output recovery all come back as
 * values the tool renders as plain text.
 */
async function buildOutlineText(
  cwd: string,
  params: OutlineValidatedParams,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const resolved = resolveOutlineTargets(cwd, params.path);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const extracted = await extractOutlineSymbols(resolved.files);
  if (!extracted.ok) return { ok: false, error: extracted.error };

  const options: OutlineFilesOptions = {};
  if (params.kind !== undefined) options.kind = params.kind;
  if (params.name !== undefined) options.nameMatches = params.name;
  if (params.maxSymbols !== undefined) options.maxSymbols = params.maxSymbols;

  // A walk-capped resolution knows no true match total (the walk stopped
  // early), so the file-cap "matched N files" wording would be a false claim.
  // Distinguish the two causes so the note never overstates coverage. Notes
  // are rendered through the formatter's footer so they stay inside the 16 KB
  // output budget instead of being appended past it.
  const extraNotes: string[] = [];
  if (resolved.truncated) {
    extraNotes.push(
      resolved.truncatedBy === "walk-cap"
        ? "note: walk stopped at the entry cap; results may be incomplete."
        : `note: matched ${resolved.totalMatches ?? resolved.files.length} files; showing the first ${resolved.files.length}.`,
    );
  }
  extraNotes.push(...(extracted.notes ?? []));
  return {
    ok: true,
    text: formatOutline(outlineFiles(extracted.files, options), extraNotes),
  };
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

export interface FleetForceStopSeams {
  /**
   * Process-table snapshot; defaults to this host's `/proc` scan.
   *
   * Injected because the forceful pause is the only code path in the product that
   * sends a signal: a test must be able to drive a *verified* member pid through a
   * fake table without touching a real process, and the real table is not a
   * fixture.
   */
  scan?: () => FleetProcessScan;
  /** Identity probes used to re-verify a matched pid; defaults to `/proc`. */
  probe?: FleetPidProbe;
  /** Start-time capture at match time; defaults to the probe's own reader. */
  startTime?: (pid: number) => string | undefined;
  /** Signal delivery; defaults to `process.kill`. */
  signal?: (pid: number, signalName: NodeJS.Signals) => void;
}

export default function belaydAgentHarness(
  pi: ExtensionAPI,
  seamOverrides: FleetForceStopSeams = {},
): void {
  if (harnessAlreadyLoaded(pi)) return;

  const seams: Required<Pick<FleetForceStopSeams, "scan" | "signal">> &
    Omit<FleetForceStopSeams, "scan" | "signal"> = {
    ...seamOverrides,
    scan: seamOverrides.scan ?? (() => scanProcesses()),
    signal:
      seamOverrides.signal ??
      ((pid, signalName) => {
        process.kill(pid, signalName);
      }),
  };

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
    "belayd_fleet_status",
    "belayd_fleet_note",
    "belayd_fleet_merge",
    "belayd_fleet_pause",
    "belayd_fleet_resume",
    "belayd_fleet_advance",
    "belayd_fleet_reconcile",
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
    // A new task supersedes an earlier handoff; keeping the marker would make a
    // later restart refuse to resume this workflow (bd-120).
    state.handedOffTo = undefined;
    state.handoffPendingNotice = undefined;
    const clearedMarker = clearHandedOffMarker({ cwd });
    if (!clearedMarker.ok) {
      // A stale marker wins over the phase ledger on resume, so a silent failure
      // would make the restarted session refuse to drive the NEW task.
      reportHandoffProblem(
        `Belayd could not clear the handoff marker in ${cwd}/.belayd/workflow.json ` +
          `(${clearedMarker.error}); a restart may refuse to resume ${taskId} until it is removed.`,
      );
    }
    // The caller-scoped marker is authoritative on resume, so it must be gone
    // too or the new workflow would look handed off after a restart.
    const clearedCallerMarker = clearCallerHandoff({
      cwd,
      sessionKey: ctx.sessionManager.getSessionId(),
    });
    if (!clearedCallerMarker.ok) {
      reportHandoffProblem(
        `Belayd could not clear this session's handoff marker (${clearedCallerMarker.error}); ` +
          `a restart may refuse to resume ${taskId} until ${cwd}/.belayd/handoff-<session>.json is removed.`,
      );
    }
    state.proofBase = undefined;
    state.workflowType = workflowType ?? "feature";
    applyWorkflowConfig(state);
    state.userGuideContent = undefined;
    state.proofOutput = undefined;
    state.proofVerifierVerdict = undefined;
    // A fresh gate carries no parent packet; only the worktree launch writes
    // one, and only resume-from-disk reads it back.
    state.handoff = undefined;
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

  /**
   * Surface a handoff-persistence problem in the UI as well as the log. These
   * failures are rare but correctness-relevant: the marker is what stops a
   * restarted session from driving a workflow it no longer owns.
   */
  function reportHandoffProblem(message: string): void {
    const text = `[belayd-harness] ${message}`;
    console.warn(text);
    pi.sendMessage({ customType: "belayd-error", content: message, display: true });
  }

  /**
   * Stop the caller from driving a workflow it just handed to a child
   * orchestrator (bd-120). Two live orchestrators on one bead produced
   * duplicate phase runs, interleaved writes, and apparent reverts, so the
   * caller drops every phase/proof field, aborts its in-flight runs, and
   * restores the full tool set.
   */
  function disarmForHandoff(options: {
    state: SessionState;
    cwd: string;
    marker: HandedOffMarker;
  }): void {
    const { state } = options;
    // The delegated workflow is this session's only telemetry producer from
    // here on; flush its rows instead of losing them with the dropped run state.
    resetModelTelemetry(options.cwd);
    abortAndResetRunTracking(state);
    state.planningActive = false;
    state.planningTarget = undefined;
    state.gateActive = false;
    state.currentTaskId = "";
    // Neutral phase configuration: no phase-order check can trip on a workflow
    // the session no longer owns (the gate itself is off).
    state.workflowType = "feature";
    applyWorkflowConfig(state);
    state.completedPhaseNames = [];
    state.awaitingReviewResponse = false;
    state.proofBase = undefined;
    state.proofOutput = undefined;
    state.userGuideContent = undefined;
    state.proofVerifierVerdict = undefined;
    state.handedOffTo = { ...options.marker };
    state.handoffPendingNotice = undefined;
    applyToolGate(state);
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

  /** Shared no-cwd refusal for every tool that must stay pinned to a worktree. */
  function missingWorkingDirectoryError(label: string): string {
    return `${label} has no working directory: this session cannot be pinned to a worktree.`;
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
    userGuidePath?: string;
  }

  /** Run a quality gate over a result, normalizing the feedback text. */
  async function evaluateGate(
    gate: QualityGate,
    result: SpawnResult,
    context: GateRunContext,
  ): Promise<{ passed: boolean; feedback: string }> {
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
        userGuidePath: options.userGuidePath,
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

  /**
   * Write the child worktree's workflow state and (when present) the handoff
   * packet, before its session exists. Split out of `createOrchestratorSession`
   * to keep that function's branch count readable.
   */
  function persistChildWorkflowState(options: {
    taskId: string;
    workflowType: WorkflowSubType;
    branch: string;
    worktreePath: string;
    originalCwd: string;
    phaseOrder: string[];
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
    handoff?: HandoffPacket;
  }): { ok: true } | { ok: false; error: string } {
    const now = Date.now();
    const writeResult = writeWorkflowState({
      cwd: options.worktreePath,
      state: {
        schemaVersion: 1,
        taskId: options.taskId,
        workflowType: options.workflowType,
        resolutionSource: options.resolutionSource ?? "default",
        ...(options.matchedLabel !== undefined ? { matchedLabel: options.matchedLabel } : {}),
        branch: options.branch,
        originalCwd: options.originalCwd,
        phaseOrder: options.phaseOrder,
        completedPhaseNames: [],
        startedAt: now,
        updatedAt: now,
      },
    });
    if (!writeResult.ok) {
      return { ok: false, error: `Failed to persist Belayd workflow state: ${writeResult.error}` };
    }

    // Persist the handoff beside the workflow state so a child restart (which
    // only reads disk) can recover it; written before the session exists.
    if (options.handoff !== undefined) {
      const handoffResult = writeHandoff({ cwd: options.worktreePath, packet: options.handoff });
      if (!handoffResult.ok) {
        // A missing packet degrades the child's first turn, it does not block
        // the launch: the workflow state and prompt are already complete.
        console.warn(`[belayd-harness] failed to persist handoff packet: ${handoffResult.error}`);
      }
    }
    return { ok: true };
  }

  /** Delegate a worktree workflow to the pi-web session daemon. */
  async function createOrchestratorSession(options: {
    ctx: ExtensionContext;
    taskId: string;
    workflowType: WorkflowSubType;
    branch: string;
    worktreePath: string;
    base?: string;
    forkPoint?: string;
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
    handoff?: HandoffPacket;
  }): Promise<{ ok: true; sessionId: string; sessionName: string } | { ok: false; error: string }> {
    const { ctx, taskId, workflowType, branch, worktreePath } = options;
    // ctx.cwd is the calling session's directory; process.cwd() is `/` in
    // pi-web session processes, and belayd_stop_task chdirs back to this value.
    const originalCwd = ctx.cwd;
    const phaseOrder = getPhasesForType(workflowType);
    const prompt = buildOrchestratorPrompt({
      taskId,
      workflowType,
      worktreePath,
      branch,
      phaseOrder,
      base: options.base,
      forkPoint: options.forkPoint,
      handoff: options.handoff,
    });

    // Persist workflow state so the new session's session_start handler can
    // activate (and later resume) the gate.
    const persisted = persistChildWorkflowState({
      taskId,
      workflowType,
      branch,
      worktreePath,
      originalCwd,
      phaseOrder,
      resolutionSource: options.resolutionSource,
      matchedLabel: options.matchedLabel,
      handoff: options.handoff,
    });
    if (!persisted.ok) return { ok: false, error: persisted.error };

    // Delegate to pi-web session daemon for persistent session management.
    const orchestrationName = computeOrchestratorSessionName(taskId);

    // Errors-as-values: daemonRequest rejects on socket errors and non-2xx
    // responses. Letting that escape would leave an unprompted child session
    // and an armed caller, so a retry would create a second zombie
    // orchestrator (bd-120).
    let created: { id?: string };
    try {
      // Try setting name at creation time
      created = (await daemonRequest("POST", "/sessions", {
        cwd: worktreePath,
        name: orchestrationName,
      })) as { id?: string };
    } catch (error) {
      return {
        ok: false,
        error: `Session daemon rejected the orchestrator request: ${errorText(error)}. No child session was created.`,
      };
    }

    if (!created.id) {
      return { ok: false, error: "Session daemon returned no session id." };
    }

    // The session daemon's per-session routes scope every request by cwd, so
    // the prompt body must carry the worktree path alongside the prompt text.
    try {
      await daemonRequest("POST", `/sessions/${created.id}/prompt`, {
        cwd: worktreePath,
        text: prompt,
      });
    } catch (error) {
      return {
        ok: false,
        error:
          `Created session ${created.id} for ${taskId} but could not send it the workflow prompt ` +
          `(${errorText(error)}). The child has no work queued; stop/delete session ${created.id} ` +
          "before retrying, so a retry does not leave two orchestrators behind.",
      };
    }

    ctx.ui.notify(`Belayd ${workflowType} workflow started for ${taskId} (${branch}).`, "info");
    return { ok: true, sessionId: created.id, sessionName: orchestrationName };
  }

  /**
   * Refusal text for a launch attempted while this session still has phase
   * runs in flight: naming each live run is what lets the model decide between
   * waiting and forcing (bd-120).
   */
  function describeInFlightLaunchRefusal(state: SessionState): string {
    const live = [...state.activeRuns.entries()].map(([runId, { handle }]) => {
      const owner = state.currentTaskId === "" ? "" : ` for ${state.currentTaskId}`;
      return `\`${runId}\` (${handle.phaseName}${owner})`;
    });
    return (
      `Cannot launch a child workflow while this session has phase runs in flight: ${live.join(", ")}. ` +
      "Wait for their follow-up results, or pass force: true (--force for /belayd) to abandon them and hand off anyway."
    );
  }

  /**
   * Refusal text for a launch from inside the target worktree.
   *
   * The child orchestrator would share this directory's `.belayd/workflow.json`
   * and overwrite it with its own workflow, and no marker can be stored there
   * because the child owns that file. Two sessions then race on one branch
   * (bd-120), so the same-directory launch is refused unless forced.
   */
  function describeSameWorktreeRefusal(branch: string): string {
    return (
      `Refusing to launch a workflow for \`${branch}\`: this session is already inside that ` +
      "worktree, and the workflow state file would be shared, so a second orchestrator would " +
      "fight this one over the same branch. One session per worktree: launch from the parent " +
      "worktree (or main), or pass force: true (--force for /belayd) to hand off here anyway " +
      "— a forced same-directory handoff replaces this session's workflow.json and records the " +
      "handoff in .belayd/handoff-<sessionId>.json instead."
    );
  }

  /**
   * Blockers that must be cleared before a child launch has any side effect.
   * Shared by `launchWorktreeWorkflow` and the follow-up tool (which writes bead
   * labels before launching and must not mutate them for a refused launch).
   */
  function launchBlocker(options: {
    state: SessionState;
    cwd: string;
    branch: string;
    force: boolean;
  }): string | undefined {
    if (options.force) return undefined;
    if (options.state.activeRuns.size > 0) {
      return describeInFlightLaunchRefusal(options.state);
    }
    // Already inside the target worktree: the child would share this cwd's
    // state file (see describeSameWorktreeRefusal).
    if (isInsideWorktreeForBranch(options.cwd, options.branch)) {
      return describeSameWorktreeRefusal(options.branch);
    }
    return undefined;
  }

  /**
   * Persist the two handoff records after the child session exists.
   *
   * The caller-scoped marker is required: it is the one record the child cannot
   * clobber (a same-directory child owns the shared `workflow.json`), and
   * `resumeWorkflowFromDisk` consults it first. The `workflow.json` marker is a
   * best-effort secondary record for a *new* session in this directory; a
   * failure there is loud but leaves this session's restart guarded.
   */
  function persistHandoffMarkers(options: {
    ctx: ExtensionContext;
    marker: HandedOffMarker;
    sameDirectory: boolean;
  }): { ok: true } | { ok: false; error: string } {
    const callerMarker = writeCallerHandoff({
      cwd: options.ctx.cwd,
      sessionKey: options.ctx.sessionManager.getSessionId(),
      marker: options.marker,
    });
    if (!callerMarker.ok) {
      return {
        ok: false,
        error:
          `Created orchestrator session ${options.marker.sessionId} for ${options.marker.taskId} ` +
          `but could not persist the handoff marker (${callerMarker.error}); the caller stays ` +
          `armed. Stop session ${options.marker.sessionId} and retry, or check write access to ` +
          `${options.ctx.cwd}/.belayd.`,
      };
    }

    if (options.sameDirectory) return { ok: true };
    if (readWorkflowState({ cwd: options.ctx.cwd }) === undefined) return { ok: true };

    const saved = saveHandedOffMarker({ cwd: options.ctx.cwd, marker: options.marker });
    if (!saved.ok) {
      reportHandoffProblem(
        `the handoff marker in ${options.ctx.cwd}/.belayd/workflow.json could not be written ` +
          `(${saved.error}); this session's restart is still guarded by ` +
          `.belayd/handoff-<sessionId>.json, but a new session in this directory will not see the handoff.`,
      );
    }
    return { ok: true };
  }

  /**
   * The calling session's branch entries, narrowed for the transcript helper.
   * Older/other runtimes may not expose `getBranch`; the handoff then simply
   * has no transcript-derived summary instead of failing the launch.
   */
  function readSessionBranch(ctx: ExtensionContext): TranscriptEntry[] {
    const manager: { getBranch?: () => unknown } = ctx.sessionManager;
    if (typeof manager.getBranch !== "function") return [];
    try {
      // pi hands back its own SessionEntry[]; narrow it at the boundary instead
      // of casting, so a runtime change degrades to "no transcript" rather
      // than undefined shape failures downstream.
      return narrowTranscriptEntries(manager.getBranch());
    } catch {
      return [];
    }
  }

  /**
   * Identity of the session launching a workflow, recorded in the child's
   * handoff packet so the child can tell its parent from an unrelated run.
   */
  function resolveParentIdentity(
    ctx: ExtensionContext,
    base: string | undefined,
  ): {
    parentTaskId?: string;
    parentBranch?: string;
    parentSessionId?: string;
    parentWorktreePath?: string;
  } {
    const state = getSessionState(ctx);
    const parentBranch = base ?? currentBranch(ctx.cwd);
    const activeTaskId =
      state.gateActive && state.currentTaskId !== "" ? state.currentTaskId : undefined;
    // A `/belayd` branch is cut from the caller's branch, so the branch name is
    // the only record of which bead the parent workflow belonged to.
    const parentTaskId =
      activeTaskId ?? (parentBranch !== undefined ? taskIdFromBranch(parentBranch) : undefined);
    const sessionId = ctx.sessionManager.getSessionId();
    return {
      ...(parentTaskId !== undefined ? { parentTaskId } : {}),
      ...(parentBranch !== undefined ? { parentBranch } : {}),
      ...(sessionId !== "" ? { parentSessionId: sessionId } : {}),
      parentWorktreePath: ctx.cwd,
    };
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
    /** Explicit caller handoff text; overrides only the transcript summary. */
    handoff?: string;
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
    /** Explicit override: hand off even with phase runs in flight or in-place. */
    force?: boolean;
    /**
     * `handoff` (default) is the `/belayd` contract: this session stops driving
     * the bead, records a handoff marker, and announces it. `fleet-member` is the
     * fleet supervisor's contract: the supervisor keeps scheduling the fleet, so
     * launching one member must neither disarm it nor claim it handed off.
     */
    role?: "handoff" | "fleet-member";
  }): Promise<{ ok: true; handoff: HandedOffMarker } | { ok: false; error: string }> {
    // Guard before any side effect: creating a worktree/session while a phase
    // run is still writing (or from inside the target worktree) would leave two
    // orchestrators on one bead (bd-120).
    const state = getSessionState(options.ctx);
    const force = options.force === true;
    const blocker = launchBlocker({
      state,
      cwd: options.ctx.cwd,
      branch: options.branch,
      force,
    });
    if (blocker !== undefined) return { ok: false, error: blocker };

    const worktreePath = ensureWorktree(options.ctx.cwd, options.branch, options.base);
    if (!worktreePath) {
      return {
        ok: false,
        error:
          "Worktree creation failed. Use --no-worktree to skip isolation, or check that wt is installed.",
      };
    }

    // `ensureWorktree` returns the caller's own directory when it already sits
    // in the target worktree; re-check after resolution so a mismatch between
    // the git probe and the worktree resolver cannot bypass the refusal.
    const sameDirectory = worktreePath === options.ctx.cwd;
    if (sameDirectory && !force) {
      return { ok: false, error: describeSameWorktreeRefusal(options.branch) };
    }

    // Hardening: `wt switch` can return before background post-start hooks
    // finish installing deps. Wait for them so the new session does not fail
    // to load the harness extension (e.g. "Cannot find module 'zod'").
    const ready = await awaitWorktreeReady(worktreePath);
    if (!ready.ok) return { ok: false, error: `Worktree not ready: ${ready.error}` };

    // The worktree create path records the effective base + fork point, so the
    // packet's stack identity comes from git rather than from a re-derivation.
    const stack = readStackNode(options.ctx.cwd, options.branch);
    const base = options.base ?? stack?.base;
    const parent = resolveParentIdentity(options.ctx, base);
    const handoff = await collectHandoffDefault({
      cwd: options.ctx.cwd,
      taskId: options.taskId,
      workflowType: options.workflowType,
      branch: options.branch,
      worktreePath,
      base,
      forkPoint: stack?.forkPoint,
      parentTaskId: parent.parentTaskId,
      parentBranch: parent.parentBranch,
      parentSessionId: parent.parentSessionId,
      parentWorktreePath: parent.parentWorktreePath,
      // Merge semantics: an explicit handoff replaces only the free-text
      // summary; task ids, branch/base/fork point, phase list and dirty files
      // are always collected mechanically so they cannot drift from git/bd.
      parentSummary: options.handoff,
      transcript: readSessionBranch(options.ctx),
      deps: { showTask: (taskId) => readTaskPlan(taskId, options.ctx.cwd) },
    });

    const created = await createOrchestratorSession({
      ctx: options.ctx,
      taskId: options.taskId,
      workflowType: options.workflowType,
      branch: options.branch,
      worktreePath,
      base,
      forkPoint: stack?.forkPoint,
      resolutionSource: options.resolutionSource,
      matchedLabel: options.matchedLabel,
      handoff,
    });
    if (!created.ok) return { ok: false, error: created.error };

    const marker: HandedOffMarker = {
      taskId: options.taskId,
      branch: options.branch,
      sessionId: created.sessionId,
    };
    return completeWorktreeLaunch({
      ctx: options.ctx,
      state,
      marker,
      sameDirectory,
      sessionName: created.sessionName,
      role: options.role,
    });
  }

  /**
   * Finish a worktree launch once the orchestrator session exists.
   *
   * Two contracts share this tail. A `/belayd` handoff records the handoff
   * markers and disarms the caller, because that session stops driving the bead.
   * A fleet member launch does neither: the supervisor keeps scheduling the
   * fleet, so a handoff marker would make its own restart refuse to resume
   * supervision, and it never had a gate to disarm.
   */
  function completeWorktreeLaunch(options: {
    ctx: ExtensionContext;
    state: SessionState;
    marker: HandedOffMarker;
    sameDirectory: boolean;
    sessionName: string;
    role: "handoff" | "fleet-member" | undefined;
  }): { ok: true; handoff: HandedOffMarker } | { ok: false; error: string } {
    const { ctx, marker } = options;
    if (options.role === "fleet-member") return { ok: true, handoff: marker };

    // Persistence is a precondition for disarming, not a best-effort side
    // effect: without the marker the next restart resurrects this workflow next
    // to the running child.
    const persisted = persistHandoffMarkers({
      ctx,
      marker,
      sameDirectory: options.sameDirectory,
    });
    if (!persisted.ok) return { ok: false, error: persisted.error };

    disarmForHandoff({ state: options.state, cwd: ctx.cwd, marker });
    pi.sendMessage(
      {
        customType: "belayd-handoff",
        content:
          `Handed off ${marker.taskId} to session ${options.sessionName} in \`${marker.branch}\`; ` +
          "you no longer drive a workflow. The new orchestrator owns this bead — do not start " +
          "phase runs for it here.",
        display: true,
      },
      { triggerTurn: true },
    );
    return { ok: true, handoff: marker };
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
      clearHandoff({ cwd: ctx.cwd });

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

  /**
   * `/belayd --no-worktree`: activate the gate in this session. Extracted from
   * the command handler so the handler stays a readable sequence of guards.
   */
  function startInSessionWorkflow(options: {
    ctx: ExtensionContext;
    taskId: string;
    workflowType: WorkflowSubType;
    resolution: WorkflowResolution;
  }): void {
    const { ctx, taskId, workflowType, resolution } = options;
    activateGate({
      ctx,
      taskId,
      workflowType,
      cwd: ctx.cwd,
      originalCwd: ctx.cwd,
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
  }

  /**
   * Resolve `--handoff` for a `/belayd` launch. In `--no-worktree` mode there is
   * no child to hand off to, so the flag is reported as ignored (and the file
   * is not read) rather than accepted and silently discarded.
   */
  function resolveBelaydHandoff(options: {
    ctx: ExtensionContext;
    args: BelaydCommandArgs;
  }): { ok: true; text: string | undefined } | { ok: false; error: string } {
    if (!options.args.noWorktree) {
      return resolveHandoffArg(options.args.handoff, options.ctx.cwd);
    }
    if (options.args.handoffFlagPresent) {
      options.ctx.ui.notify(
        "`--handoff` is ignored with `--no-worktree`: the gate runs in this session, so no child orchestrator is spawned.",
        "warning",
      );
    }
    return { ok: true, text: undefined };
  }

  /**
   * Resolve the workflow type (including the wf: label confirmation) and start
   * the workflow — in-session for `--no-worktree`, otherwise in a delegated
   * worktree session. Split out of the command handler so the handler stays a
   * short sequence of guards.
   */
  async function runBelaydLaunch(options: {
    ctx: ExtensionContext;
    args: BelaydCommandArgs;
  }): Promise<void> {
    const { ctx, args } = options;

    // Resolve the explicit handoff before any side effect, so an unreadable
    // file aborts the command untouched rather than half-launching a child.
    const handoffArg = resolveBelaydHandoff({ ctx, args });
    if (!handoffArg.ok) {
      ctx.ui.notify(handoffArg.error, "error");
      return;
    }

    // Explicit signals only: a CLI arg or a namespaced wf:<type> label. Title
    // keywords and plain labels never drive the choice (bd-106).
    const metadata = await readTaskMetadata(args.taskId, ctx.cwd);
    let resolution = resolveWorkflowSelection(args.typeArg, metadata?.labels);

    if (args.typeArg !== undefined && !isValidWorkflowType(args.typeArg)) {
      ctx.ui.notify(
        `Unknown workflow type: "${args.typeArg}".\nValid types: feature, bugfix, research, chore, documentation, refactor, hotfix\nFalling back to "${resolution.type}".`,
        "warning",
      );
    }

    // A wf: label drives the type -> confirm before any side effects. A
    // cancelled (or unavailable) dialog aborts the run untouched.
    const confirmed = await confirmAndPersistResolution({
      ctx,
      taskId: args.taskId,
      resolution,
      existingLabels: metadata?.labels,
    });
    if (confirmed.kind === "cancelled") {
      ctx.ui.notify("Belayd workflow cancelled — no changes made.", "info");
      return;
    }
    resolution = confirmed.resolution;

    if (args.noWorktree) {
      startInSessionWorkflow({
        ctx,
        taskId: args.taskId,
        workflowType: resolution.type,
        resolution,
      });
      return;
    }

    const outcome = await launchWorktreeWorkflow({
      ctx,
      taskId: args.taskId,
      workflowType: resolution.type,
      branch: `feat/${args.taskId}`,
      handoff: handoffArg.text,
      resolutionSource: resolution.source,
      matchedLabel: resolution.matchedLabel,
      force: args.force,
    });
    if (!outcome.ok) ctx.ui.notify(outcome.error, "error");
  }

  // ── Slash command: /belayd bd-42 [type] ────────────────────────────
  pi.registerCommand("belayd", {
    description:
      "Start enforced Belayd workflow. Usage: /belayd bd-42 [type] [--no-worktree] [--handoff <text|@path>] [--force]. " +
      "Omit type to use the bead's wf:<type> label (confirmed before launch).",
    handler: async (args, ctx) => {
      const parsedArgs = parseBelaydCommandArgs(args);
      if (!parsedArgs.ok) {
        ctx.ui.notify(parsedArgs.error, "error");
        return;
      }
      const parsed = parsedArgs.args;
      if (!isUsableBelaydInvocation(parsed)) {
        ctx.ui.notify(belaydUsageText(), "error");
        return;
      }
      await runBelaydLaunch({ ctx, args: parsed });
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
   * Record a handed-off resume and settle the caller's leftovers rather than
   * dropping them (bd-120). A handed-off session cannot apply a phase
   * completion to a workflow it no longer drives, and it can no longer deliver
   * a follow-up for it, so interrupted runs are flipped to `interrupted` and
   * pending user completions are marked delivered with a summary that
   * `belayd_status` surfaces.
   */
  function settleHandoffPendingItems(options: {
    state: SessionState;
    cwd: string;
    marker: HandedOffMarker;
  }): void {
    const { state, cwd, marker } = options;
    state.gateActive = false;
    state.handedOffTo = { ...marker };

    // In a same-directory handoff the child orchestrator owns this cwd's state
    // and run manifests. Settling them here would flip a live child run to
    // interrupted and swallow its pending user completions, so the caller only
    // settles leftovers in a directory it still owns.
    const persistedHere = readWorkflowState({ cwd });
    if (persistedHere !== undefined && persistedHere.taskId === marker.taskId) return;

    const interrupted = scanForInterruptedRuns({ cwd });
    const { delivered, undeliverable } = markPendingCompletionsDelivered({
      cwd,
      skipTaskId: marker.taskId,
    });
    const notice = formatHandoffPendingNotice({
      taskId: marker.taskId,
      interrupted,
      delivered,
      undeliverable,
    });
    if (notice === undefined) return;

    state.handoffPendingNotice = notice;
    console.warn(`[belayd-harness] ${notice}`);
  }

  /** Arm the gate from a validated persisted workflow and surface dead runs. */
  function armFromPersistedWorkflow(
    state: SessionState,
    cwd: string,
    persisted: WorkflowState,
  ): void {
    state.gateActive = true;
    state.currentTaskId = persisted.taskId;
    state.workflowType = isValidWorkflowType(persisted.workflowType)
      ? persisted.workflowType
      : "feature";
    state.phaseOrder = [...persisted.phaseOrder];
    state.optionalPhases = WORKFLOW_REGISTRY[state.workflowType].optionalPhases ?? [];
    state.consultPhases = WORKFLOW_REGISTRY[state.workflowType].consultPhases ?? [];
    state.completedPhaseNames = [...persisted.completedPhaseNames];
    // Re-read the parent's handoff so a restart/compaction re-injects it; the
    // packet lives beside workflow.json rather than inside it (bd-121). A
    // packet for a different task is stale (worktree reused) and must not be
    // injected into this workflow.
    const handoff = readHandoff({ cwd });
    state.handoff = handoff?.taskId === persisted.taskId ? handoff : undefined;
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

  /**
   * Resume the gate from the persisted workflow state written by /belayd.
   * A completed workflow is cleared instead of resurrected; a sub-agent never
   * reaches this helper because its session has no workflow state file.
   */
  function resumeWorkflowFromDisk(state: SessionState, cwd: string, sessionKey: string): void {
    // The caller-scoped marker wins over any workflow.json: a same-directory
    // handoff cannot store the marker in the shared state file (the child owns
    // it), so this file is the only reliable record for THIS session.
    const callerMarker = readCallerHandoff({ cwd, sessionKey });
    if (callerMarker !== undefined) {
      settleHandoffPendingItems({ state, cwd, marker: callerMarker });
      return;
    }

    const persisted = readWorkflowState({ cwd });
    if (persisted === undefined) return;

    // A handed-off workflow belongs to the child orchestrator. Re-arming this
    // session's gate would put two orchestrators on the same bead again — the
    // exact failure bd-120 fixes — so the marker wins over the phase ledger.
    if (persisted.handedOffTo !== undefined) {
      settleHandoffPendingItems({ state, cwd, marker: persisted.handedOffTo });
      return;
    }

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

    armFromPersistedWorkflow(state, cwd, persisted);
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
    state.handoff = undefined;
    state.awaitingReviewResponse = false;
    state.handedOffTo = undefined;
    state.handoffPendingNotice = undefined;
    state.runEpoch = 0;
    resetRunTracking(state);
    applyToolGate(state);

    // Sub-agents have "-sub-" in their session name (set by computeSubagentSessionName).
    // Only the orchestrator session should activate the gate; sub-agents get their
    // tool restrictions from their agent definition's tools allowlist, not the gate.
    const sessionName = ctx.sessionManager.getSessionName();
    const isSubAgent = sessionName?.includes("-sub-");
    if (!ctx.sessionManager.getSessionFile() || isSubAgent) return;
    resumeWorkflowFromDisk(state, ctx.cwd, ctx.sessionManager.getSessionId());
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

    // The handoff section is additive: an absent packet (older workflow, or a
    // launch that never had a parent session) leaves the gate text unchanged.
    const handoffLines = state.handoff !== undefined ? ["", formatHandoffBlock(state.handoff)] : [];

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
          ...handoffLines,
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

  // Fleet member delivery. Separate handler for the same reason as the
  // instruction-group handler below: the gate handler's early returns must not
  // be able to skip it. A supervisor → member note is a file in `events/`, so it
  // is drained here, at the start of the turn, bounded, acked once, and silent
  // when nothing is addressed to this member.
  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      return drainFleetEventsMessage(ctx);
    } catch (error) {
      console.warn(`[belayd-harness] fleet events delivery failed: ${errorText(error)}`);
      return undefined;
    }
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

  interface PhaseToolParams {
    task: string;
  }

  interface StartPhaseRunOptions {
    agent: AgentDefinition;
    phaseName: string;
    params: PhaseToolParams;
    state: SessionState;
    cwd: string;
    worktreeBranch: string | undefined;
    runId: string;
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
   * User-guide markdown used as functional context for the proof verifier.
   *
   * The phase deliverable lives on disk, so read it there; a session recovered
   * from an older capture (or a run whose file was never written) falls back to
   * the in-session text.
   */
  function readUserGuideForContext(options: {
    cwd: string;
    taskId: string;
    captured: string | undefined;
  }): string | undefined {
    if (options.taskId !== "") {
      try {
        const content = readFileSync(
          resolve(options.cwd, userGuideDocPath(options.taskId)),
          "utf8",
        );
        if (content.trim() !== "") return content;
      } catch {
        // No deliverable on disk — fall through to the captured text.
      }
    }
    return options.captured;
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
   * Preflight for workflow-scoped runs: the session's task must own `cwd` and
   * its branch. A post-completion rework call (gate off, workflow state gone)
   * legitimately runs outside a workflow, so it stays allowed; any workflow
   * state present in cwd still pins that tree to its owner.
   */
  function activeWorkflowOwnership(state: SessionState, cwd: string): OwnedWorktreeResult {
    return matchSessionOwnedWorktree({
      cwd,
      currentTaskId: state.currentTaskId,
      gateActive: state.gateActive,
      branch: readWorktreeBranch(cwd),
      persisted: readWorkflowState({ cwd }),
    });
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
    const { agent, phaseName, params, state, cwd, worktreeBranch, runId } = options;
    const overrides = WORKFLOW_REGISTRY[state.workflowType].agentOverrides?.[phaseName as Phase];
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
            content: buildRunCompleteContent(
              delivered,
              reviewLoopHintFor(delivered, state),
              userGuideArtifactLine(delivered, { cwd, taskId: state.currentTaskId }),
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
        fullTask = `${preamble}\n\n${await buildFullPhaseTask({
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
        return needsFullTask ? fullTask : `${preamble}\n\n${params.task}`;
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
    effectiveCwd: string,
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
        persistModelTelemetry(effectiveCwd);
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
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = getSessionState(ctx);
        const cwd = ctx.cwd;
        if (cwd === undefined || cwd === "") {
          return textToolResult(missingWorkingDirectoryError("Belayd phase run"), 1);
        }
        const ownership = activeWorkflowOwnership(state, cwd);
        if (!ownership.ok) return textToolResult(ownership.error, 1);
        const runId = generateShortRunId();
        const { sessionName, ledgerWarning } = startPhaseRun({
          agent,
          phaseName,
          params,
          state,
          cwd,
          worktreeBranch: ownership.branch,
          runId,
        });
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
      const cwd = ctx.cwd;
      if (cwd === undefined || cwd === "") {
        return textToolResult(missingWorkingDirectoryError("belayd_plan_scout"), 1);
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
        cwd,
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
      const cwd = ctx.cwd;
      if (cwd === undefined || cwd === "") {
        return textToolResult(missingWorkingDirectoryError("belayd_plan_research"), 1);
      }
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
        cwd,
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
    },
    state: SessionState,
    cwd: string,
  ): Promise<{ prompt: string; cwd: string; skipped: boolean }> {
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
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);
      const cwd = ctx.cwd;
      if (cwd === undefined || cwd === "") {
        return textToolResult(missingWorkingDirectoryError("Proof verifier"), 1);
      }
      const ownership = activeWorkflowOwnership(state, cwd);
      if (!ownership.ok) return textToolResult(ownership.error, 1);
      const built = await buildProofVerifierPrompt(params, state, cwd);
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
      const sections: string[] = [formatWorkflowStatusSection(state)];

      // Leftovers from the caller's own directory are reported instead of lost
      // when a handed-off session resumes (bd-120).
      if (state.handoffPendingNotice !== undefined) {
        sections.push(`**Pending items from the handoff** — ${state.handoffPendingNotice}`);
      }

      sections.push(formatActiveRunsSection(state.activeRuns));

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
  // A read-only, multi-language symbol map with line ranges. Sub-agents
  // otherwise re-read a file in offset windows to locate the next edit anchor.
  // Declarations come from universal-ctags (with explicit `--map-<LANG>`
  // overrides for the TypeScript-family extensions ctags 6.2.1 does not map:
  // .tsx/.mts/.cts/.cjs); ast-grep supplies accurate
  // TypeScript-family ranges plus the pi.registerTool / pi.on registrations
  // that live inside belaydAgentHarness's body (there is no hand-rolled
  // lexer). It is consult-callable and non-phase, so it is listed in
  // GATED_TOOLS only to survive the process gate — never a required workflow
  // step, and never in PLANNING_GATED_TOOLS. The tool only reads files
  // (resolveOutlineTargets + extractOutlineSymbols); it exposes no
  // edit/write/bash path.
  pi.registerTool({
    name: "belayd_outline",
    label: "Belayd outline",
    description:
      "Read-only, multi-language symbol map with line ranges for a source file, directory, " +
      `or glob (supports *, ?, **; directories are walked for ${OUTLINE_FILE_EXTENSIONS.join("/")}). ` +
      "Extracts top-level functions, methods, classes, interfaces, types, enums, consts, and " +
      "structs/fields across the languages universal-ctags recognizes (map overrides add the " +
      "TypeScript-family extensions ctags does not map by default), and refines TypeScript-family " +
      "ranges plus pi.registerTool / pi.on registrations via ast-grep. Neither extractor is a " +
      "catch-all; the accepted extension set is explicit and rejects the rest. Returns rows in " +
      "line order. Re-export " +
      "barrels are not emitted (the bd-115 `export` kind was removed). Use this instead of " +
      "re-reading a large file in offset windows to locate the next edit anchor; pair with " +
      "`grep -n` for text. Output is bounded (~16 KB) and can be narrowed with `kind` or a " +
      "`name` substring. Requires the `ctags` and `ast-grep` binaries on PATH (the devShell " +
      "provides them; BELAYD_CTAGS_BIN / BELAYD_AST_GREP_BIN override).",
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
      const built = await buildOutlineText(cwd, validation.value);
      return built.ok ? textToolResult(built.text, 0) : textToolResult(built.error, 1);
    },
  });

  // ── Register fleet status (read-only fleet aggregation) tool ─────────
  // Milestone P0 of the multi-bead fleet supervisor (docs/fleet-orchestrator.md):
  // a scheduler's observation view, never a phase worker. It reads every
  // worktree's `.belayd/workflow.json` + run manifests plus the optional fleet
  // intent file, writes nothing, spawns nothing, merges nothing, and arms no
  // gate. Listed in GATED_TOOLS only to survive the process gate — never a
  // required workflow step, and never in PLANNING_GATED_TOOLS.
  //
  // Bead metadata comes from one batched read-only `bd show <ids> --json`.
  // bd is an optional, frequently-absent dependency (no beads database, version
  // drift, slow server) and the workflow view is derived from workflow state,
  // so every failure degrades to "no bead metadata" plus exactly one
  // fleet-level warning instead of failing the call.
  async function readFleetBeads(status: FleetStatus, cwd: string): Promise<FleetBeadLookup> {
    return lookupFleetBeads({
      taskIds: fleetBeadTaskIds(status),
      cwd,
      runBd: (argv, options) => runBdCommand(argv, options),
    });
  }

  pi.registerTool({
    name: "belayd_fleet_status",
    label: "Belayd fleet status",
    description:
      "Read-only fleet status: aggregates every git worktree's Belayd workflow into one " +
      "view (task id, bead title/status, branch, workflow type, completed/pending phases, " +
      "latest run per phase with its status, interrupted-run count, last update, derived " +
      "state) and warns about duplicate task ids, workflow task ids that disagree with the " +
      "branch or directory, and worktrees without workflow state. Reads only: no writes, no " +
      "merges, no spawns, no phase runs. Bead metadata is one best-effort `bd show --json` " +
      "read; without bd the view still renders. fleetId selects " +
      `<git-common-dir>/belayd/fleet/<fleetId>/fleet.json (default: ${DEFAULT_FLEET_ID}); ` +
      "P0 never creates that file.",
    parameters: Type.Object({
      fleetId: Type.Optional(
        Type.String({
          description: `Fleet intent directory name under <git-common-dir>/belayd/fleet/ (default: ${DEFAULT_FLEET_ID})`,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const requested = params.fleetId;
      const fleetId =
        requested === undefined || requested.trim() === "" ? DEFAULT_FLEET_ID : requested.trim();
      const result = readFleetStatus({ cwd, fleetId });
      if (!result.ok) return textToolResult(result.error, 1);
      const lookup = await readFleetBeads(result.value, cwd);
      return textToolResult(formatFleetStatus(applyFleetBeadLookup(result.value, lookup)), 0);
    },
  });

  // ── Fleet supervisor (bd-126 P1–P4): launch, mailbox, merge, pause, reconcile ──
  //
  // The supervisor is a scheduler: it arms no gate, runs no phase, and owns no
  // worktree. Its only authority is the fleet family below, and every action it
  // takes across worktrees is appended to `<fleet>/audit.log`. Nothing here merges,
  // advances a wave, pauses, or mutates a bead on its own: each of those is an
  // explicit, audited call.

  /** `<git-common-dir>` for a session's directory, or an error value. */
  function gitCommonDirFor(
    cwd: string,
  ): { ok: true; gitCommonDir: string } | { ok: false; error: string } {
    const resolved = resolveGitCommonDir(cwd);
    return resolved.ok ? { ok: true, gitCommonDir: resolved.commonDir } : resolved;
  }

  /**
   * The fleet this session supervises, or undefined.
   *
   * Derived from `fleet.json` on every call (session id + live, unchanged
   * supervisor process + the arm token this session minted), so no in-memory flag
   * can survive a lifecycle reset and a record left or planted by another writer
   * cannot put this session into fleet mode. The token is the only piece that is
   * not on disk: a corrupt or malicious `fleet.json` cannot guess it.
   */
  function fleetModeFor(ctx: ExtensionContext): FleetMode | undefined {
    const common = gitCommonDirFor(ctx.cwd);
    if (!common.ok) return undefined;
    const state = getSessionState(ctx);
    return resolveFleetMode({
      gitCommonDir: common.gitCommonDir,
      sessionId: ctx.sessionManager.getSessionId(),
      isPidAlive: isProcessAlive,
      pidStartTime: readProcessStartTime,
      ...(state.fleetArm === undefined ? {} : { armToken: state.fleetArm }),
    });
  }

  /** The fleet a member task belongs to (member → fleet lookup by task id). */
  function memberFleetFor(ctx: ExtensionContext, taskId: string): FleetMode | undefined {
    const common = gitCommonDirFor(ctx.cwd);
    if (!common.ok) return undefined;
    return resolveMemberFleet({ gitCommonDir: common.gitCommonDir, taskId });
  }

  /** Append one cross-tree audit entry; a failure is reported, never swallowed. */
  function auditFleetAction(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    fleetId: string;
    action: string;
    taskIds: readonly string[];
    detail: string;
  }): void {
    const appended = appendFleetAuditEntry({
      gitCommonDir: options.gitCommonDir,
      fleetId: options.fleetId,
      entry: {
        timestamp: Date.now(),
        fleetId: options.fleetId,
        actor: options.ctx.sessionManager.getSessionId(),
        action: options.action,
        taskIds: [...options.taskIds],
        detail: options.detail,
      },
    });
    if (appended.ok) return;
    // Cross-tree authority must be auditable; an unlogged action is a bug the
    // operator has to see, not a detail.
    options.ctx.ui.notify(
      `Fleet ${options.fleetId}: could not append to audit.log (${appended.error}).`,
      "warning",
    );
    console.warn(`[belayd-harness] failed to append fleet audit entry: ${appended.error}`);
  }

  /**
   * bd-119 conflict check for a member whose worktree already exists.
   *
   * Reuses `matchOwnedWorktree` instead of re-deriving bead ↔ branch ↔ worktree
   * identity, so the fleet cannot disagree with the phase/commit/proof preflight
   * about who owns a tree. A worktree with no workflow state belongs to nobody
   * yet and is reusable; anything else is refused with the bd-119 wording.
   */
  function fleetMemberOwnershipError(root: string, taskId: string): string | undefined {
    const worktreePath = resolveWorktreePath(root, `feat/${taskId}`);
    if (worktreePath === undefined) return undefined;
    const persisted = readWorkflowState({ cwd: worktreePath });
    if (persisted === undefined) return undefined;

    // bd-119 only answers "does another bead own this tree": a worktree whose
    // state is for *this* bead resolves `ok`, yet a standalone `/belayd`
    // orchestrator is already driving it. A fleet launch there would spawn a
    // second detached orchestrator on one bead — the exact invariant bd-119
    // exists to protect — so the fleet adds the missing precondition. Any
    // recorded workflow state for the task means the tree is already driven; a
    // dead orchestrator is recovered by re-arming the fleet (a re-arm preserves
    // members instead of relaunching), or by using that session.
    if (persisted.taskId === taskId) {
      return (
        `${taskId} is already driven by a standalone orchestrator in ${worktreePath} ` +
        `(workflow state for ${taskId} on branch ` +
        `${persisted.branch === "" ? "an unpinned branch" : persisted.branch}). Use that ` +
        "orchestrator's session, or re-arm the fleet (`/fleet <id> --fleet <fleetId>`) instead of " +
        "launching a second orchestrator on the same worktree."
      );
    }

    const owned = matchOwnedWorktree({
      cwd: worktreePath,
      taskId,
      branch: readWorktreeBranch(worktreePath),
      persisted,
    });
    return owned.ok ? undefined : owned.error;
  }

  /**
   * Launch one member through the existing single-bead path.
   *
   * There is deliberately no second spawner: `launchWorktreeWorkflow` owns the
   * worktree, handoff packet, workflow state, and daemon session. The fleet only
   * decides *which* members to launch and records the outcome.
   */
  async function launchFleetMember(options: {
    ctx: ExtensionContext;
    taskId: string;
    base?: string;
  }): Promise<FleetMemberLaunchOutcome> {
    const { ctx, taskId } = options;
    try {
      // Explicit signals only for the workflow type: `/fleet` has no type
      // argument, so a namespaced wf:<type> label decides and anything else is
      // `feature`. No interactive confirmation here: a fleet launch cannot
      // prompt once per member, and the operator's id list is the authority.
      const metadata = await readTaskMetadata(taskId, ctx.cwd);
      const resolution = resolveWorkflowSelection(undefined, metadata?.labels);
      const launched = await launchWorktreeWorkflow({
        ctx,
        taskId,
        workflowType: resolution.type,
        branch: `feat/${taskId}`,
        ...(options.base === undefined ? {} : { base: options.base }),
        resolutionSource: resolution.source,
        ...(resolution.matchedLabel === undefined ? {} : { matchedLabel: resolution.matchedLabel }),
        role: "fleet-member",
      });
      if (!launched.ok) return { taskId, ok: false, detail: launched.error };
      return {
        taskId,
        ok: true,
        detail: `worktree \`feat/${taskId}\`, orchestrator session ${launched.handoff.sessionId}`,
        workflowType: resolution.type,
      };
    } catch (error) {
      return { taskId, ok: false, detail: errorText(error) };
    }
  }

  interface FleetLaunchResult {
    ok: boolean;
    text: string;
  }

  /**
   * `/fleet` and `belayd_fleet_launch` share this wrapper: the launch engine
   * itself is `runFleetLaunch` in src/fleet-launch.ts (validation, intent write,
   * per-member launch, prune), with the two side-effecting halves injected — the
   * bd-119 ownership probe and the existing single-bead launch path.
   *
   * Order is validate -> schedule -> write intent -> launch -> prune: the intent
   * must exist before a member starts (a member finds its mailbox by task id), a
   * member that fails is removed from the intent afterwards so the failure is
   * visible, audited, and retryable, and the P3 schedule decides which members
   * start now (waves + capacity) before anything is written.
   */
  /** Refuse a launch from a session that is already driving a workflow or plan. */
  function fleetLaunchBlockedText(state: SessionState): string | undefined {
    if (!state.gateActive && !state.planningActive) return undefined;
    return (
      "A fleet supervisor arms no process gate, so this session cannot launch a fleet while it " +
      "is driving a workflow or a planning session. Finish or stop that work first, then launch " +
      "the fleet from a session with no gate (normally the repository root)."
    );
  }

  /**
   * Apply a launch result to the session: surface warnings, then arm only when
   * the launch wrote and verified its supervisor record.
   *
   * `armed` is separate from `ok` on purpose: a failed member launch still
   * rewrote the record with this call's token, so clearing the arm would leave a
   * fleet whose record names this session while the session refuses its own
   * inbox. A refused or unread-back launch armed nothing and must not clear an
   * existing arm.
   */
  function applyFleetLaunchResult(options: {
    ctx: ExtensionContext;
    state: SessionState;
    result: {
      ok: boolean;
      text: string;
      warnings: readonly string[];
      armed: boolean;
      fleetId: string;
    };
    armToken: string;
  }): FleetLaunchResult {
    for (const warning of options.result.warnings) {
      options.ctx.ui.notify(warning, "warning");
      console.warn(`[belayd-harness] ${warning}`);
    }
    if (options.result.armed) {
      options.state.fleetArm = { fleetId: options.result.fleetId, token: options.armToken };
    }
    return { ok: options.result.ok, text: options.result.text };
  }

  async function runFleetLaunch(options: {
    ctx: ExtensionContext;
    taskIds: readonly string[];
    fleetId: string;
    requestedConcurrency?: number;
    /** `advance` when the worklist came from the persisted deferred plan (P4). */
    origin?: "launch" | "advance";
  }): Promise<FleetLaunchResult> {
    const { ctx } = options;
    const state = getSessionState(ctx);
    const blocked = fleetLaunchBlockedText(state);
    if (blocked !== undefined) return { ok: false, text: blocked };

    const common = gitCommonDirFor(ctx.cwd);
    if (!common.ok) {
      return { ok: false, text: `Fleet launch needs a git repository: ${common.error}` };
    }
    const baseBranch = currentBranch(ctx.cwd);

    // Minted per arming and kept only in this session's memory: the intent carries
    // it, so the on-disk record alone is not enough to become the supervisor.
    const armToken = randomUUID();
    const pidStartTime = readProcessStartTime(process.pid);
    // A session supervises one fleet. Pass the fleet it actually holds (derived
    // from its arm token, not from a record alone) so validation can refuse a
    // second fleet before any write.
    const supervised = fleetModeFor(ctx);

    const result = await runFleetLaunchEngine({
      gitCommonDir: common.gitCommonDir,
      fleetId: options.fleetId,
      taskIds: options.taskIds,
      sessionId: ctx.sessionManager.getSessionId(),
      ...(supervised === undefined ? {} : { sessionFleetId: supervised.fleetId }),
      pid: process.pid,
      ...(pidStartTime === undefined ? {} : { pidStartTime }),
      armToken,
      liveness: { isPidAlive: isProcessAlive, pidStartTime: readProcessStartTime },
      now: Date.now(),
      ...(baseBranch === undefined ? {} : { baseBranch }),
      ...(options.requestedConcurrency === undefined
        ? {}
        : { requestedConcurrency: options.requestedConcurrency }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      probeOwnership: (taskId) => fleetMemberOwnershipError(ctx.cwd, taskId),
      launchMember: (taskId) => launchFleetMember({ ctx, taskId, base: baseBranch }),
      // P3 ordering: one batched, read-only `bd show --brief-deps`. Any failure
      // degrades to "no known edges" inside the seam, never to a crashed launch.
      lookupDependencies: (taskIds) =>
        lookupFleetDependencies({
          taskIds,
          cwd: ctx.cwd,
          runBd: (argv, runnerOptions) => runBdCommand(argv, runnerOptions),
        }),
    });

    return applyFleetLaunchResult({ ctx, state, result, armToken });
  }

  /** Normalize the optional fleet-id tool parameter. */
  function fleetIdParam(raw: string | undefined): string {
    return raw === undefined || raw.trim() === "" ? DEFAULT_FLEET_ID : raw.trim();
  }

  pi.registerTool({
    name: "belayd_fleet_launch",
    label: "Belayd fleet launch",
    description:
      "Explicitly launch several beads as concurrent Belayd workflows, each in its own worktree " +
      "and detached orchestrator session, and record them in the fleet intent " +
      "(<git-common-dir>/belayd/fleet/<fleetId>/fleet.json). Validates every task id first: an " +
      "invalid, duplicated, already-member, or worktree-conflicting id refuses the whole launch " +
      "with no side effects. Orders members by bd's blocking dependencies (blocked-by edges; a " +
      "dependency cycle refuses the launch and names the cycle) and launches only the free " +
      "capacity: at most 3 orchestrators in flight, counting the ones already running. Members " +
      "beyond that, or in a later wave, are deferred — reported per member and recorded in " +
      "fleet.json — never silently dropped. Later waves are advanced explicitly with " +
      "belayd_fleet_advance (there is no background poller). This session becomes the fleet " +
      "supervisor: it runs no phases and owns no worktree — observe with belayd_fleet_status, " +
      "message members with belayd_fleet_note, read reports with belayd_fleet_inbox, pause with " +
      "belayd_fleet_pause, repair crashes with belayd_fleet_reconcile. No merges " +
      "(belayd_fleet_merge is explicit).",
    parameters: Type.Object({
      tasks: Type.Union([
        Type.String({ description: "One task id or a whitespace/comma separated list" }),
        Type.Array(Type.String(), { description: 'Task ids, e.g. ["bd-12", "bd-15"]' }),
      ]),
      fleetId: Type.Optional(
        Type.String({
          description: `Fleet directory name under <git-common-dir>/belayd/fleet/ (default: ${DEFAULT_FLEET_ID})`,
        }),
      ),
      concurrency: Type.Optional(
        Type.Number({ description: "Concurrent orchestrators (capped at 3)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const parsed = parseFleetTaskIds(params.tasks);
      if (!parsed.ok) return textToolResult(`belayd_fleet_launch: ${parsed.error}.`, 1);
      const result = await runFleetLaunch({
        ctx: extensionCtx,
        taskIds: parsed.taskIds,
        fleetId: fleetIdParam(params.fleetId),
        ...(params.concurrency === undefined ? {} : { requestedConcurrency: params.concurrency }),
      });
      return textToolResult(result.text, result.ok ? 0 : 1);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_note",
    label: "Belayd fleet note",
    description:
      "Write fleet mailbox notes. The supervisor writes into events/ for one member or `all` " +
      "(a broadcast is materialized as one file per member, so every member receives its own " +
      "copy); a member writes into inbox/ and may only address `supervisor`. The target is " +
      "validated against live fleet membership, so a typo is refused instead of becoming mail " +
      "nobody ever reads. Kinds: note, rebase-hint, base-moved, sibling-landed, pause, resume. " +
      "Delivery is files-first: a member sees queued events at the start of its next turn; the " +
      "supervisor reads inbox/ with belayd_fleet_inbox. Body is bounded and every note is " +
      "audited in audit.log.",
    parameters: Type.Object({
      to: Type.String({
        description: "Target task id, `supervisor` (inbox only), or `all` (every member)",
      }),
      body: Type.String({ description: "Note body (truncated to 2000 characters)" }),
      kind: Type.Optional(
        Type.String({ description: `One of: ${FLEET_NOTE_KINDS.join(", ")} (default: note)` }),
      ),
      channel: Type.Optional(
        Type.String({ description: "inbox (member → supervisor) or events (supervisor → member)" }),
      ),
      fleetId: Type.Optional(
        Type.String({ description: "Fleet id (default: this session's fleet)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const kind = normalizeFleetNoteKind(params.kind);
      if (kind === undefined) {
        return textToolResult(
          `Unknown note kind \`${params.kind ?? ""}\`. Valid kinds: ${FLEET_NOTE_KINDS.join(", ")}.`,
          1,
        );
      }
      const resolved = resolveFleetNoteTarget({
        ctx: extensionCtx,
        fleetId: params.fleetId,
        channel: params.channel,
      });
      if (!resolved.ok) return textToolResult(resolved.error, 1);

      const written = writeFleetNote({
        ctx: extensionCtx,
        resolved,
        kind,
        to: params.to,
        body: params.body,
      });
      return written.ok ? textToolResult(written.text, 0) : textToolResult(written.error, 1);
    },
  });

  /**
   * Validate the address, fan the note out, and audit the outcome.
   *
   * Split out of the tool handler so the handler stays a short orchestration of
   * "narrow the parameter → resolve the mailbox → write → report".
   */
  function writeFleetNote(options: {
    ctx: ExtensionContext;
    resolved: FleetNoteTarget;
    kind: FleetNoteKind;
    to: string;
    body: string;
  }): { ok: true; text: string } | { ok: false; error: string } {
    const { ctx, resolved, kind } = options;
    const recipients = resolveFleetNoteRecipients({
      direction: resolved.channel === "events" ? "supervisor-to-member" : "member-to-supervisor",
      to: options.to,
      members: resolved.members,
    });
    if (!recipients.ok) return { ok: false, error: `Fleet note refused: ${recipients.error}` };

    const enqueued = enqueueNoteFanout({
      dir: resolved.dir,
      note: buildFleetNote({
        kind,
        from: resolved.from,
        // Replaced per recipient by the fan-out; kept as the caller asked so a
        // single-recipient note is byte-identical to the old behaviour.
        to: options.to,
        body: options.body,
        now: Date.now(),
      }),
      recipients: recipients.recipients,
    });
    if (!enqueued.ok) {
      // A partial fan-out means some members already have the note. The audit
      // records exactly the recipients whose file was written — not the request
      // — so a broadcast that reached two of three members never claims three.
      auditFleetAction({
        ctx,
        gitCommonDir: resolved.gitCommonDir,
        fleetId: resolved.fleetId,
        action: "note-partial",
        taskIds: enqueued.writtenRecipients,
        detail: `${resolved.channel} ${kind}: ${enqueued.error}`,
      });
      return { ok: false, error: `Fleet note refused: ${enqueued.error}` };
    }

    auditFleetAction({
      ctx,
      gitCommonDir: resolved.gitCommonDir,
      fleetId: resolved.fleetId,
      action: "note",
      taskIds: recipients.recipients,
      detail: `${resolved.channel} ${kind} to ${recipients.recipients.length} recipient(s)`,
    });
    const audience =
      recipients.recipients.length === 1
        ? `to ${recipients.recipients[0] ?? ""}`
        : `to ${recipients.recipients.length} members (${recipients.recipients.join(", ")})`;
    return {
      ok: true,
      text:
        `Fleet \`${resolved.fleetId}\`: ${kind} from ${resolved.from} ${audience} queued in ` +
        `${resolved.channel} (${enqueued.paths.length} file(s)).`,
    };
  }

  /** Audit detail for an inbox drain; a partial ack is stated, never hidden. */
  function inboxDrainDetail(drainedCount: number, acked: AckNotesResult): string {
    if (acked.ok) return `${drainedCount} note(s) drained and acknowledged`;
    return (
      `${drainedCount} note(s) drained; ${acked.removed.length} acknowledged, ` +
      `${acked.remaining.length} still queued (${acked.error})`
    );
  }

  /** Render a drain plus its ack outcome, with the ack failure as an explicit field. */
  function formatFleetInboxResult(options: {
    mode: FleetMode;
    drained: { deliveries: readonly FleetNoteDelivery[]; warnings: readonly string[] };
    acked: AckNotesResult;
  }): string {
    const ackFailure = options.acked.ok
      ? {}
      : {
          ackFailure: {
            error: options.acked.error,
            removedCount: options.acked.removed.length,
            remaining: options.acked.remaining,
          },
        };
    return formatFleetInbox({
      fleetId: options.mode.fleetId,
      deliveries: options.drained.deliveries,
      warnings: options.drained.warnings,
      ...ackFailure,
    });
  }

  pi.registerTool({
    name: "belayd_fleet_inbox",
    label: "Belayd fleet inbox",
    description:
      "Drain the fleet supervisor's inbox/ (member → supervisor notes), acknowledge each note, and " +
      "return them. At-least-once: a note is removed only after this call consumed it. Supervisor " +
      "sessions only — events/ is delivered to members automatically at turn start.",
    parameters: Type.Object({
      fleetId: Type.Optional(
        Type.String({ description: `Fleet id (default: ${DEFAULT_FLEET_ID})` }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) {
        return textToolResult(
          "belayd_fleet_inbox is supervisor-only: this session is not the live supervisor of a " +
            "fleet (a stale supervisor record from a dead process does not count). Start one with " +
            "/fleet or belayd_fleet_launch.",
          1,
        );
      }
      const requested = params.fleetId;
      if (requested !== undefined && requested.trim() !== "" && requested.trim() !== mode.fleetId) {
        return textToolResult(
          `This session supervises fleet \`${mode.fleetId}\`, not \`${requested.trim()}\`.`,
          1,
        );
      }

      const drained = drainNotes({ dir: mode.inboxDir });
      if (!drained.ok) return textToolResult(`Fleet inbox unavailable: ${drained.error}`, 1);

      // Render first, ack second. If an unlink fails, the note bodies this call
      // consumed are already in the result, and the rendered text states exactly
      // what remains queued — nothing vanishes off the record.
      const acked = ackNotes({ dir: mode.inboxDir, deliveries: drained.deliveries });

      if (drained.deliveries.length > 0) {
        auditFleetAction({
          ctx: extensionCtx,
          gitCommonDir: mode.gitCommonDir,
          fleetId: mode.fleetId,
          action: "inbox-drain",
          taskIds: drained.deliveries.map((delivery) => delivery.note.from),
          detail: inboxDrainDetail(drained.deliveries.length, acked),
        });
      }

      return textToolResult(formatFleetInboxResult({ mode, drained, acked }), acked.ok ? 0 : 1);
    },
  });

  /**
   * The branch a member worktree currently has checked out, or an error value.
   *
   * The queue stores the branch it will merge, so it must be the branch the
   * worktree actually holds — a queue entry is not the place to guess
   * `feat/<id>` when the operator renamed the branch.
   */
  function memberMergeBranch(
    rootCwd: string,
    taskId: string,
  ): { ok: true; branch: string; worktreePath: string } | { ok: false; error: string } {
    const worktreePath = resolveWorktreePath(rootCwd, `feat/${taskId}`);
    if (worktreePath === undefined) {
      return {
        ok: false,
        error:
          `no worktree is checked out for feat/${taskId}; launch the member first ` +
          `(belayd_fleet_launch) or name the branch it actually has`,
      };
    }
    const branch = readWorktreeBranch(worktreePath);
    if (!branch.ok) {
      return { ok: false, error: `could not read the branch in ${worktreePath}` };
    }
    return { ok: true, branch: branch.branch, worktreePath };
  }

  /** `action: list` — render the queue without touching it. */
  function fleetMergeListAction(mode: FleetMode, now: number) {
    const loaded = readFleetMergeQueue({
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
    });
    if (!loaded.ok) return textToolResult(`Merge queue unavailable: ${loaded.error}`, 1);
    return textToolResult(
      formatFleetMergeQueue({ fleetId: mode.fleetId, queue: loaded.queue, now }),
      0,
    );
  }

  /** `action: enqueue` — queue exactly one member branch. */
  function fleetMergeEnqueueAction(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    task: string | undefined;
    now: number;
  }) {
    const parsed = options.task === undefined ? undefined : parseFleetTaskIds(options.task);
    if (parsed === undefined || !parsed.ok) {
      return textToolResult("belayd_fleet_merge enqueue needs a member task id (`task`).", 1);
    }
    if (parsed.taskIds.length !== 1) {
      return textToolResult(
        "belayd_fleet_merge enqueue takes exactly one task id; one merge at a time.",
        1,
      );
    }
    const taskId = parsed.taskIds[0] ?? "";
    const branch = memberMergeBranch(options.ctx.cwd, taskId);
    if (!branch.ok) return textToolResult(branch.error, 1);
    const queued = enqueueFleetMerge({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      sessionId: options.ctx.sessionManager.getSessionId(),
      taskId,
      branch: branch.branch,
      now: options.now,
    });
    if (!queued.ok) {
      return textToolResult(`Merge enqueue refused: ${queued.error}`, 1);
    }
    // An unlogged cross-tree write is a bug the operator has to see.
    for (const warning of queued.warnings) {
      options.ctx.ui.notify(warning, "warning");
      console.warn(`[belayd-harness] ${warning}`);
    }
    return textToolResult(queued.text, 0);
  }

  /** `action: drain` — one explicit merge attempt, with every warning surfaced. */
  async function fleetMergeDrainAction(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    task: string | undefined;
    now: number;
  }) {
    const parsed = options.task === undefined ? undefined : parseFleetTaskIds(options.task);
    const taskId =
      parsed === undefined || !parsed.ok || parsed.taskIds.length === 0
        ? undefined
        : parsed.taskIds[0];
    const drained = await drainFleetMerge({
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      sessionId: options.ctx.sessionManager.getSessionId(),
      pid: process.pid,
      rootCwd: options.ctx.cwd,
      now: options.now,
      ...(taskId === undefined ? {} : { taskId }),
    });
    for (const warning of drained.warnings) {
      options.ctx.ui.notify(warning, "warning");
      console.warn(`[belayd-harness] ${warning}`);
    }
    // An empty queue is not a failure: the operator asked for the next merge and
    // there is none, which exits 0 with an explanatory result.
    const exitCode = drained.ok || drained.reason === "no-queued-entry" ? 0 : 1;
    return textToolResult(drained.text, exitCode);
  }

  pi.registerTool({
    name: "belayd_fleet_merge",
    label: "Belayd fleet merge",
    description:
      "Explicit single-flight merge queue for a fleet supervisor. action=enqueue queues one " +
      "member's branch; action=drain merges one queued member into the fleet base branch in the " +
      "operator's root checkout (rebase → project gates → fast-forward merge → base-moved " +
      "notifications), and action=list renders the queue. A dirty root is auto-stashed and " +
      "restored; a conflicting restore parks the fleet with the stash ref in fleet.json (repair " +
      "with belayd_fleet_reconcile, then belayd_fleet_resume). " +
      "Merging is not closing: the bead stays in_progress + human. Supervisor sessions only.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("enqueue"), Type.Literal("drain"), Type.Literal("list")], {
        description: "enqueue one member, drain one queued member, or list the queue",
      }),
      task: Type.Optional(
        Type.String({
          description:
            "Member task id. Required for enqueue; optional for drain (default: the oldest queued entry)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) {
        return textToolResult(
          "belayd_fleet_merge is supervisor-only: this session is not the live supervisor of a " +
            "fleet (a stale supervisor record from a dead process does not count). Start one with " +
            "/fleet or belayd_fleet_launch.",
          1,
        );
      }
      const now = Date.now();
      switch (params.action) {
        case "list":
          return fleetMergeListAction(mode, now);
        case "enqueue":
          return fleetMergeEnqueueAction({
            ctx: extensionCtx,
            mode,
            task: params.task,
            now,
          });
        case "drain":
          return fleetMergeDrainAction({ ctx: extensionCtx, mode, task: params.task, now });
      }
    },
  });

  /**
   * The uniform refusal for fleet tools that need live supervision authority.
   *
   * A stale record from a dead process does not count: `fleetModeFor` re-derives
   * mode from the record, the process identity, and this session's arm token on
   * every call, so these tools can never be driven by a planted `fleet.json`.
   */
  function fleetSupervisorOnly(toolName: string): string {
    return (
      `${toolName} is supervisor-only: this session is not the live supervisor of a fleet ` +
      "(a stale supervisor record from a dead process does not count). Start one with /fleet or " +
      "belayd_fleet_launch."
    );
  }

  /**
   * Send one supervisor → member note through the validated fan-out, auditing it.
   *
   * Best effort on purpose: a pause that failed to *queue* its advisory note still
   * wrote the intent flag, which is the enforceable half, so the report says which
   * members were reached instead of failing the pause.
   */
  function announceToMembers(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    kind: FleetNoteKind;
    body: string;
  }): readonly string[] {
    const recipients = resolveFleetNoteRecipients({
      direction: "supervisor-to-member",
      to: FLEET_NOTE_BROADCAST,
      members: fleetMemberTaskIds(options.mode.intent),
    });
    if (!recipients.ok) return [];
    const enqueued = enqueueNoteFanout({
      dir: options.mode.eventsDir,
      note: buildFleetNote({
        kind: options.kind,
        from: FLEET_NOTE_SUPERVISOR,
        to: FLEET_NOTE_BROADCAST,
        body: options.body,
        now: Date.now(),
      }),
      recipients: recipients.recipients,
    });
    if (!enqueued.ok) {
      auditFleetAction({
        ctx: options.ctx,
        gitCommonDir: options.mode.gitCommonDir,
        fleetId: options.mode.fleetId,
        action: "note-partial",
        taskIds: enqueued.writtenRecipients,
        detail: `${options.kind}: ${enqueued.error}`,
      });
      return enqueued.writtenRecipients;
    }
    auditFleetAction({
      ctx: options.ctx,
      gitCommonDir: options.mode.gitCommonDir,
      fleetId: options.mode.fleetId,
      action: "note",
      taskIds: enqueued.recipients,
      detail: `events ${options.kind} to ${enqueued.recipients.length} recipient(s)`,
    });
    return enqueued.recipients;
  }

  pi.registerTool({
    name: "belayd_fleet_pause",
    label: "Belayd fleet pause",
    description:
      "Pause a fleet so it starts no new work: the intent's `paused` flag is written through the " +
      "compare-and-replace path and audited (fleet-paused), launches refuse and merges refuse " +
      "until belayd_fleet_resume. Every member also gets a `pause` note in events/ (delivered at " +
      "its next turn start). This is cooperative: a running phase is NOT interrupted and a member " +
      "that ignores the note keeps working. force=true additionally sends SIGTERM to each " +
      "member's orchestrator process, identified only by the exact `belayd-<taskId>` session " +
      "token in its argv and re-verified (argv token + process start time) immediately before " +
      "each signal, so a recycled pid is skipped and audited instead of signalled (audited per " +
      "pid); it does not guarantee the process exited, does not " +
      "stop that member's phase sub-agents, and refuses outright when the process table cannot be " +
      "read or a member's process cannot be identified. Supervisor sessions only.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Operator-visible pause reason" })),
      force: Type.Optional(
        Type.Boolean({ description: "Also signal each member orchestrator (SIGTERM)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) return textToolResult(fleetSupervisorOnly("belayd_fleet_pause"), 1);

      const paused = pauseFleet({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        sessionId: extensionCtx.sessionManager.getSessionId(),
        now: Date.now(),
        ...(params.reason === undefined ? {} : { reason: params.reason }),
      });
      for (const warning of paused.warnings) {
        extensionCtx.ui.notify(warning, "warning");
        console.warn(`[belayd-harness] ${warning}`);
      }
      if (!paused.ok) return textToolResult(`Fleet pause refused: ${paused.error}`, 1);

      const notified = announceToMembers({
        ctx: extensionCtx,
        mode,
        kind: "pause",
        body:
          `Fleet \`${mode.fleetId}\` is paused` +
          (params.reason === undefined ? "" : `: ${params.reason}`) +
          ". Start no new phase; finish or park your current work and wait for a `resume` event.",
      });

      const lines = [paused.text];
      lines.push(
        notified.length === 0
          ? "- pause note: no member to notify (no members recorded)"
          : `- pause note queued for ${notified.join(", ")} (delivered at their next turn start)`,
      );
      if (params.force === true) {
        lines.push(...forceStopMembers({ ctx: extensionCtx, mode }));
      }
      return textToolResult(lines.join("\n"), 0);
    },
  });

  /**
   * Forceful pause: SIGTERM every member orchestrator we can positively identify.
   *
   * One process-table snapshot for all members, so two members cannot be matched
   * against two different tables. Everything that could not be proven is reported
   * as such — this path exists to stop a member that will not cooperate, not to
   * pretend a kill succeeded.
   */
  function forceStopMembers(options: { ctx: ExtensionContext; mode: FleetMode }): string[] {
    const { ctx, mode } = options;
    const scan = seams.scan();
    if (!scan.ok) {
      const warning =
        `forceful pause could not identify member sessions (${scan.reason}); nothing was ` +
        "signalled. The fleet is still paused (cooperative), so no new work starts.";
      auditFleetAction({
        ctx,
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        action: "member-stop-unavailable",
        taskIds: [...mode.intent.taskIds],
        detail: scan.reason,
      });
      return [`- forceful pause: ${warning}`];
    }

    return mode.intent.taskIds.flatMap((taskId) => stopOneMember({ ctx, mode, scan, taskId }));
  }

  /**
   * Stop one member and report every matched pid separately.
   *
   * One process-table snapshot is shared by all members (two members must not be
   * matched against two different tables), but each pid is re-verified and
   * signalled on its own: a pid that was recycled is skipped while its sibling is
   * still signalled, and one failing kill does not abort the rest.
   */
  function stopOneMember(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    scan: ReturnType<typeof scanProcesses>;
    taskId: string;
  }): string[] {
    const { ctx, mode, scan, taskId } = options;
    const token = memberSessionToken(taskId);
    let outcome: ReturnType<typeof stopMemberSession>;
    try {
      outcome = stopMemberSession({
        taskId,
        scan,
        selfPid: process.pid,
        signal: seams.signal,
        ...(seams.probe === undefined ? {} : { probe: seams.probe }),
        ...(seams.startTime === undefined ? {} : { startTime: seams.startTime }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      auditFleetAction({
        ctx,
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        action: "member-stop-failed",
        taskIds: [taskId],
        detail: `${detail} (session token ${token})`,
      });
      return [`- forceful pause: ${taskId} could not be signalled (${detail})`];
    }
    if (!outcome.ok) {
      auditFleetAction({
        ctx,
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        action: "member-stop-skipped",
        taskIds: [taskId],
        detail: `${outcome.reason}: ${outcome.error}`,
      });
      return [`- forceful pause: ${taskId} not signalled — ${outcome.error}`];
    }

    const lines = outcome.outcomes.flatMap((pidOutcome) =>
      reportMemberPidOutcome({ ctx, mode, taskId, token, pidOutcome }),
    );
    if (outcome.pids.length === 0 && outcome.outcomes.length > 0) {
      lines.push(
        `- forceful pause: ${taskId} had matched orchestrator pids but none was signalled; ` +
          "the cooperative pause is the only stop that applied",
      );
    }
    return lines;
  }

  /**
   * Report and audit one matched pid's outcome.
   *
   * Every line and audit detail names the matched `belayd-<taskId>` token, so the
   * pid can be tied back to the identity it was signalled as after the process is
   * gone.
   */
  function reportMemberPidOutcome(options: {
    ctx: ExtensionContext;
    mode: FleetMode;
    taskId: string;
    token: string;
    pidOutcome: MemberPidOutcome;
  }): string[] {
    const { ctx, mode, taskId, token, pidOutcome } = options;
    const audit = (action: string, detail: string): void => {
      auditFleetAction({
        ctx,
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        action,
        taskIds: [taskId],
        detail,
      });
    };
    switch (pidOutcome.kind) {
      case "signalled":
        audit("member-stopped", `SIGTERM sent to pid ${pidOutcome.pid} (session token ${token})`);
        return [
          `- forceful pause: SIGTERM sent to ${taskId}'s orchestrator pid ${pidOutcome.pid} ` +
            "(delivery only: verify the session stopped and the worktree is clean before relaunching)",
        ];
      case "skipped":
        audit(
          "member-stop-skipped",
          `pid ${pidOutcome.pid} (session token ${token}): ${pidOutcome.reason}: ${pidOutcome.detail}`,
        );
        return [
          `- forceful pause: ${taskId} pid ${pidOutcome.pid} was NOT signalled — ` +
            `${pidOutcome.reason}: ${pidOutcome.detail}`,
        ];
      case "failed":
        audit(
          "member-stop-failed",
          `pid ${pidOutcome.pid} (session token ${token}): ${pidOutcome.error}`,
        );
        return [
          `- forceful pause: ${taskId} pid ${pidOutcome.pid} could not be signalled ` +
            `(${pidOutcome.error}); the other matched pids were signalled`,
        ];
    }
  }
  pi.registerTool({
    name: "belayd_fleet_resume",
    label: "Belayd fleet resume",
    description:
      "Resume a paused or parked fleet: clears the intent's `paused` flag, the park record and its " +
      "note through the compare-and-replace path, audited (fleet-resumed, fleet-unparked). A park " +
      "that records a stash ref is refused unless force=true: run belayd_fleet_reconcile first so " +
      "the operator's stashed root work is restored (reconcile verifies the root is this " +
      "repository's own checkout on the base branch, applies the recorded sha, and unparks); " +
      "force clears the pause and leaves the stash untouched, naming the ref. Resuming a fleet " +
      "that is already running is a successful no-op. Members get a `resume` note in events/. " +
      "Supervisor sessions only.",
    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({
          description: "Clear a park whose stash was not verified as restored (the stash is kept)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) return textToolResult(fleetSupervisorOnly("belayd_fleet_resume"), 1);

      const resumed = resumeFleet({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        sessionId: extensionCtx.sessionManager.getSessionId(),
        now: Date.now(),
        ...(params.force === true ? { force: true } : {}),
      });
      for (const warning of resumed.warnings) {
        extensionCtx.ui.notify(warning, "warning");
        console.warn(`[belayd-harness] ${warning}`);
      }
      if (!resumed.ok) return textToolResult(`Fleet resume refused: ${resumed.error}`, 1);
      // An already-running fleet is a no-op: no member is told a pause ended that
      // never started, and nothing is fanned out.
      if (resumed.alreadyResumed) return textToolResult(resumed.text, 0);

      const notified = announceToMembers({
        ctx: extensionCtx,
        mode,
        kind: "resume",
        body:
          `Fleet \`${mode.fleetId}\` resumed. You may start new work again; re-read ` +
          "belayd_fleet_status before assuming a sibling's premises still hold.",
      });
      const lines = [resumed.text];
      if (notified.length > 0) {
        lines.push(`- resume note queued for ${notified.join(", ")}`);
      }
      return textToolResult(lines.join("\n"), 0);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_advance",
    label: "Belayd fleet advance",
    description:
      "Explicitly advance the fleet's next wave. The worklist is the intent's persisted `deferred` " +
      "list (members a previous launch could not start); the ordinary launch engine re-reads bd's " +
      "blocking edges, refuses a cycle, re-applies the ceiling of 3 orchestrators and launches only " +
      "what fits, recording the rest as deferred again. Every decision is audited (`advance`, " +
      "`schedule-planned`, per-member deferrals). There is no background poller: a wave advances " +
      "only when this tool (or another explicit launch) is called. A dependency wave advances only " +
      "once bd stops reporting the blocking edge — merging a sibling is not closing its bead. " +
      "Refused while the fleet is paused. Supervisor sessions only.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) return textToolResult(fleetSupervisorOnly("belayd_fleet_advance"), 1);

      const loaded = readFleetIntent({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
      });
      if (!loaded.ok) {
        return textToolResult(`Could not read the fleet intent: ${loaded.error}`, 1);
      }
      const planned = planFleetAdvance({ fleetId: mode.fleetId, intent: loaded.intent });
      if (!planned.ok) return textToolResult(planned.text, 1);

      const result = await runFleetLaunch({
        ctx: extensionCtx,
        taskIds: planned.worklist,
        fleetId: mode.fleetId,
        origin: "advance",
      });
      const header =
        `Advancing fleet \`${mode.fleetId}\`: ${planned.worklist.length} deferred member(s) ` +
        `(${planned.worklist.join(", ")}) re-scheduled; ${planned.members.length} already ` +
        "launched.";
      return textToolResult(`${header}\n${result.text}`, result.ok ? 0 : 1);
    },
  });

  pi.registerTool({
    name: "belayd_fleet_reconcile",
    label: "Belayd fleet reconcile",
    description:
      "Repair a fleet after a crash, audited and idempotent. Merge queue: takes over an expired " +
      "lease, clears a lock record whose merge.lock.d is gone, reclaims an orphaned lock " +
      "directory past its grace window, and re-queues (or marks merged when git proves it landed) " +
      "an entry frozen mid-flight — all under the existing single-flight merge lock, so it never " +
      "interleaves with a merge. Parked fleet: restores the recorded stash ref when the root is " +
      "this repository's own checkout on the base branch and unparks, or reports exactly what " +
      "blocks it (the stash is never discarded); a recorded sha that is no longer in `git stash " +
      "list` is reported as already restored or dropped and never applied again. Supervision: " +
      "reports the supervisor's liveness and each member's orchestrator " +
      "liveness from the process table; prune-dead-members=true removes members whose orchestrator " +
      "is provably gone (positive `absent` evidence from a completed scan — `unknown` is never " +
      "pruned, and a live supervisor may prune); worktrees, transcripts, and beads stay. A second " +
      "run finds nothing to do. Supervisor sessions only; acts in this session's root checkout.",
    parameters: Type.Object({
      pruneDeadMembers: Type.Optional(
        Type.Boolean({
          description:
            "Remove members whose orchestrator process is provably gone (a completed scan found " +
            "no `belayd-<taskId>` process); unknown liveness is never pruned and worktrees stay",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const extensionCtx = ctx as ExtensionContext;
      const mode = fleetModeFor(extensionCtx);
      if (mode === undefined) {
        return textToolResult(fleetSupervisorOnly("belayd_fleet_reconcile"), 1);
      }

      const result = await runFleetReconcile({
        gitCommonDir: mode.gitCommonDir,
        fleetId: mode.fleetId,
        sessionId: extensionCtx.sessionManager.getSessionId(),
        pid: process.pid,
        rootCwd: extensionCtx.cwd,
        now: Date.now(),
        scan: scanProcesses(),
        git: defaultFleetMergeGitRunner,
        isPidAlive: isProcessAlive,
        pidStartTime: readProcessStartTime,
        selfPid: process.pid,
        ...(params.pruneDeadMembers === true ? { pruneDeadMembers: true } : {}),
      });
      for (const warning of result.warnings) {
        extensionCtx.ui.notify(warning, "warning");
        console.warn(`[belayd-harness] ${warning}`);
      }
      return textToolResult(result.text, result.ok ? 0 : 1);
    },
  });

  /** Narrow a note kind parameter; undefined means "not a known kind". */
  function normalizeFleetNoteKind(raw: string | undefined): FleetNoteKind | undefined {
    if (raw === undefined || raw.trim() === "") return "note";
    const candidate = raw.trim();
    return isFleetNoteKind(candidate) ? candidate : undefined;
  }

  interface FleetNoteTarget {
    ok: true;
    gitCommonDir: string;
    fleetId: string;
    dir: string;
    channel: "inbox" | "events";
    from: string;
    /** Fleet members from the intent: the audience a note's `to` is checked against. */
    members: readonly string[];
  }

  /**
   * Resolve where a note goes, who it is from, and which mailbox it lands in.
   *
   * Defaults follow the direction of travel: a supervisor writes to `events/`
   * (its messages are for members), a member writes to `inbox/` (its messages
   * are for the supervisor). The channel can be overridden explicitly, but the
   * fleet itself cannot: a session may only write into a fleet it supervises or
   * is a member of.
   */
  function resolveFleetNoteTarget(options: {
    ctx: ExtensionContext;
    fleetId: string | undefined;
    channel: string | undefined;
  }): FleetNoteTarget | { ok: false; error: string } {
    const { ctx } = options;
    const common = gitCommonDirFor(ctx.cwd);
    if (!common.ok)
      return { ok: false, error: `Fleet mail needs a git repository: ${common.error}` };

    const requestedFleetId =
      options.fleetId === undefined || options.fleetId.trim() === ""
        ? undefined
        : sanitizeFleetId(options.fleetId.trim());
    const channel = normalizeFleetChannel(options.channel);
    if (!channel.ok) return channel;

    // A supervisor's own fleet wins; otherwise the session writes as a member.
    const supervised = fleetModeFor(ctx);
    if (supervised !== undefined) {
      if (requestedFleetId !== undefined && requestedFleetId !== supervised.fleetId) {
        return {
          ok: false,
          error: `This session supervises fleet \`${supervised.fleetId}\`, not \`${requestedFleetId}\`.`,
        };
      }
      return supervisorNoteTarget(supervised, channel.channel);
    }
    return memberNoteTarget({
      ctx,
      gitCommonDir: common.gitCommonDir,
      requestedFleetId,
      channel: channel.channel,
    });
  }

  /** Narrow the optional `channel` parameter to the two mailboxes. */
  function normalizeFleetChannel(
    raw: string | undefined,
  ): { ok: true; channel: "inbox" | "events" | undefined } | { ok: false; error: string } {
    if (raw === undefined) return { ok: true, channel: undefined };
    if (raw === "inbox" || raw === "events") return { ok: true, channel: raw };
    return { ok: false, error: "channel must be `inbox` or `events`" };
  }

  /** A supervisor addresses members: default mailbox `events/`. */
  function supervisorNoteTarget(
    mode: FleetMode,
    channel: "inbox" | "events" | undefined,
  ): FleetNoteTarget {
    const resolved = channel ?? "events";
    return {
      ok: true,
      gitCommonDir: mode.gitCommonDir,
      fleetId: mode.fleetId,
      dir: resolved === "inbox" ? mode.inboxDir : mode.eventsDir,
      channel: resolved,
      from: FLEET_NOTE_SUPERVISOR,
      // Deferred members are addressable too: mail queued for a member that has not
      // started yet is delivered at that session's first turn, and the P0 member
      // *count* stays `taskIds`-only (a deferred member has no worktree to observe).
      members: fleetMemberTaskIds(mode.intent),
    };
  }

  /** A member addresses the supervisor: default mailbox `inbox/`. */
  function memberNoteTarget(options: {
    ctx: ExtensionContext;
    gitCommonDir: string;
    requestedFleetId: string | undefined;
    channel: "inbox" | "events" | undefined;
  }): FleetNoteTarget | { ok: false; error: string } {
    const { ctx } = options;
    const state = getSessionState(ctx);
    const memberTaskId =
      state.currentTaskId !== ""
        ? state.currentTaskId
        : (readWorkflowState({ cwd: ctx.cwd })?.taskId ?? "");
    const member = memberTaskId === "" ? undefined : memberFleetFor(ctx, memberTaskId);
    if (member === undefined) {
      return {
        ok: false,
        error:
          "This session is neither a fleet supervisor nor a member of a fleet, so it has no mailbox. " +
          "Start one with /fleet or belayd_fleet_launch.",
      };
    }
    if (options.requestedFleetId !== undefined && options.requestedFleetId !== member.fleetId) {
      return {
        ok: false,
        error: `This session is a member of fleet \`${member.fleetId}\`, not \`${options.requestedFleetId}\`.`,
      };
    }
    // events/ is supervisor → member only. Letting a member write it would be
    // cross-worktree prompt injection: it could hand a sibling a fake `pause`,
    // `base-moved`, or `rebase-hint` that the sibling renders as supervisor
    // instructions. The member's own surface is inbox/ → supervisor.
    if (options.channel === "events") {
      return {
        ok: false,
        error:
          "events/ is supervisor-only: a fleet member writes to the supervisor via inbox/, so it " +
          "cannot inject a turn-start event into a sibling's session. Use channel inbox (the " +
          "default) and address `supervisor`.",
      };
    }
    return {
      ok: true,
      gitCommonDir: member.gitCommonDir,
      fleetId: member.fleetId,
      dir: member.inboxDir,
      channel: "inbox",
      from: memberTaskId,
      members: [...member.intent.taskIds],
    };
  }

  /**
   * Member-side delivery: drain this member's `events/` at turn start.
   *
   * Files-first by design (members are detached sessions, so there is no
   * in-memory channel). Bounded by note count and character budget, silent when
   * nothing is addressed to this member.
   *
   * **The ack is deferred (W4).** Selection only records the deliveries on the
   * session state; `ackFleetEventsAfterTurn` removes them in `agent_end`, after
   * the model has actually read the injected message. Acking here — before the
   * message reaches the model — would be at-most-once: a crash between ack and
   * read would lose the note silently while the docstring promised replay.
   */
  function drainFleetEventsMessage(
    ctx: ExtensionContext,
  ): { message: { customType: string; content: string; display: boolean } } | undefined {
    // A phase sub-agent shares its orchestrator's worktree and workflow state, so
    // draining here would consume the orchestrator's events in a session the
    // supervisor never addressed (and that cannot act on them).
    if (ctx.sessionManager.getSessionName()?.includes("-sub-") === true) return undefined;
    // Delivery keys on the worktree's task id, so the fleet assumes one member
    // orchestrator per worktree (docs/fleet-launch.md "One session per
    // worktree"). A second session opened in the same worktree would drain and
    // ack that member's mail alongside its owner; bd-119 keeps a worktree pinned
    // to one bead, and the fleet launch refuses a worktree already driven, but
    // this handler deliberately does not try to tell two same-cwd sessions apart
    // (pi exposes no ownership relation between them).
    const taskId = inferredTaskId(ctx);
    if (taskId === "") return undefined;
    const fleet = memberFleetFor(ctx, taskId);
    if (fleet === undefined) return undefined;

    const batch = selectMemberEvents(fleet, taskId);
    if (batch === undefined) return undefined;

    queueFleetEventAcks(getSessionState(ctx), fleet, batch.delivered);
    return {
      message: { customType: "belayd-fleet-events", content: batch.content, display: true },
    };
  }

  /** Drain and select this member's events; undefined when nothing is addressed. */
  function selectMemberEvents(member: FleetMode, taskId: string): FleetEventBatch | undefined {
    const drained = drainNotes({ dir: member.eventsDir });
    if (!drained.ok) {
      console.warn(`[belayd-harness] fleet events drain failed: ${drained.error}`);
      return undefined;
    }
    return selectFleetEvents({
      fleetId: member.fleetId,
      taskId,
      deliveries: drained.deliveries,
    });
  }

  /**
   * Remember the events this turn injected, for the `agent_end` ack.
   *
   * Accumulates, never overwrites: a turn that drains twice before `agent_end`
   * must ack the union, not just the last batch.
   */
  function queueFleetEventAcks(
    state: SessionState,
    member: FleetMode,
    deliveries: readonly FleetNoteDelivery[],
  ): void {
    const pending = state.pendingFleetEventAcks ?? {
      fleetId: member.fleetId,
      gitCommonDir: member.gitCommonDir,
      dir: member.eventsDir,
      deliveries: [],
    };
    for (const delivery of deliveries) {
      if (!pending.deliveries.some((existing) => existing.path === delivery.path)) {
        pending.deliveries.push(delivery);
      }
    }
    state.pendingFleetEventAcks = pending;
  }

  /**
   * Ack the events injected into the turn that just ended (W4).
   *
   * Runs in `agent_end`, i.e. after the model has read the message. A crash before
   * this point leaves the files on disk and the next turn replays them: the
   * delivery guarantee for events is at-least-once, and repeats must be treated
   * as the same event. The delete is a cross-tree mutation, so it is audited.
   */
  function ackFleetEventsAfterTurn(ctx: ExtensionContext): void {
    const state = getSessionState(ctx);
    const pending = state.pendingFleetEventAcks;
    if (pending === undefined) return;
    // Clear first: a throwing ack must not make the next turn re-ack the set.
    state.pendingFleetEventAcks = undefined;
    if (pending.deliveries.length === 0) return;

    const acked = ackNotes({ dir: pending.dir, deliveries: pending.deliveries });
    const taskId = inferredTaskId(ctx);
    if (acked.ok) {
      auditFleetAction({
        ctx,
        gitCommonDir: pending.gitCommonDir,
        fleetId: pending.fleetId,
        action: "events-acked",
        taskIds: [taskId],
        detail: `${acked.removed.length} event(s) acknowledged after the turn that read them`,
      });
      return;
    }
    console.warn(`[belayd-harness] fleet events could not be acknowledged: ${acked.error}`);
    auditFleetAction({
      ctx,
      gitCommonDir: pending.gitCommonDir,
      fleetId: pending.fleetId,
      action: "events-ack-failed",
      taskIds: [taskId],
      detail: `${acked.error}; ${acked.remaining.length} event(s) remain and will be re-delivered`,
    });
  }

  /** Task id this session is working on, from memory or the worktree state. */
  function inferredTaskId(ctx: ExtensionContext): string {
    const state = getSessionState(ctx);
    return state.currentTaskId !== ""
      ? state.currentTaskId
      : (readWorkflowState({ cwd: ctx.cwd })?.taskId ?? "");
  }

  pi.on("agent_end", async (_event, ctx) => {
    try {
      ackFleetEventsAfterTurn(ctx);
    } catch (error) {
      console.warn(`[belayd-harness] fleet events ack failed: ${errorText(error)}`);
    }
  });

  // ── Slash command: /fleet bd-12 bd-15 ──────────────────────────────
  //
  // The operator-facing entry point. It launches the members and records this
  // session as the fleet supervisor; it arms no gate, and afterwards every
  // phase/proof/commit tool is refused with the fleet message (see the
  // tool_call handler).
  pi.registerCommand("fleet", {
    description:
      "Start a fleet supervisor session for several beads, each as its own worktree workflow. " +
      "Members are ordered by bd dependencies and only the free capacity starts now (max 3 " +
      "orchestrators); deferred members are reported and recorded. " +
      "Usage: /fleet bd-12 bd-15 [--fleet <id>] [--concurrency <n>].",
    handler: async (args, ctx) => {
      const parsed = parseFleetCommandArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      const result = await runFleetLaunch({
        ctx,
        taskIds: parsed.args.taskIds,
        fleetId: fleetIdParam(parsed.args.fleetId),
        ...(parsed.args.concurrency === undefined
          ? {}
          : { requestedConcurrency: parsed.args.concurrency }),
      });
      ctx.ui.notify(result.text, result.ok ? "info" : "error");
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

  /**
   * Resolve the branch a follow-up is stacked on, rejecting the detached-HEAD
   * and self-stacking cases. Extracted so the tool handler stays under the
   * complexity budget.
   */
  function resolveFollowupBase(options: {
    branch: string;
    requested?: string;
    cwd: string;
  }): { ok: true; base: string } | { ok: false; error: string } {
    const base = options.requested ?? currentBranch(options.cwd);
    if (base === undefined) {
      return {
        ok: false,
        error:
          "Cannot determine the base branch: the repository is in a detached HEAD state. Pass `base` explicitly.",
      };
    }
    if (base === options.branch) {
      return {
        ok: false,
        error: `The follow-up branch ${options.branch} cannot be stacked on itself.`,
      };
    }
    return { ok: true, base };
  }

  /**
   * Write back an explicit `workflowType` as a `wf:<type>` label. Called only
   * after the launch guards pass, so a refused launch never mutates the bead.
   */
  async function persistExplicitWorkflowLabel(options: {
    taskId: string;
    cwd: string;
    resolution: WorkflowResolution;
    /** True when a confirmation flow already wrote the label. */
    alreadyPersisted: boolean;
    existingLabels?: string[];
  }): Promise<void> {
    if (options.resolution.source !== "arg" || options.alreadyPersisted) return;
    await writeWorkflowTypeLabel({
      taskId: options.taskId,
      type: options.resolution.type,
      cwd: options.cwd,
      existingLabels: options.existingLabels,
    });
  }

  pi.registerTool({
    name: "belayd_start_followup",
    label: "Start stacked follow-up workflow",
    description:
      "Start a new Belayd workflow for a follow-up bead, stacked on the current branch " +
      "instead of main. Records the base branch and fork point so it can later be rebased " +
      "onto main with belayd_stack_rebase. Hands the workflow off to a new orchestrator " +
      "session and disarms this one. Set force: true to hand off even while this session " +
      "has phase runs in flight (they are abandoned).",
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
      handoff: Type.Optional(
        Type.String({
          description:
            "Free-text context for the spawned orchestrator. Overrides only the parent-summary line; task ids, branch/base/fork point and the completed phase list are always collected from the parent session.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Hand off even while this session has phase runs in flight; the live runs are abandoned.",
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
      const baseResult = resolveFollowupBase({ branch, requested: params.base, cwd });
      if (!baseResult.ok) return textToolResult(baseResult.error, 1);
      const base = baseResult.base;

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

      // Refuse a launch that would duplicate this session's own work *before*
      // writing the wf:<type> label, so a refused launch leaves the bead
      // untouched (bd-120). The same guards run again inside
      // launchWorktreeWorkflow for callers that do not pre-check.
      const blocker = launchBlocker({
        state: getSessionState(ctx),
        cwd,
        branch,
        force: params.force === true,
      });
      if (blocker !== undefined) return textToolResult(blocker, 1);

      await persistExplicitWorkflowLabel({
        taskId: params.taskId,
        cwd,
        resolution,
        alreadyPersisted: toolResolution.persisted,
        existingLabels: metadata?.labels,
      });

      const outcome = await launchWorktreeWorkflow({
        ctx,
        taskId: params.taskId,
        workflowType,
        branch,
        base,
        handoff: params.handoff,
        resolutionSource: resolution.source,
        matchedLabel: resolution.matchedLabel,
        force: params.force === true,
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

      // Restore original cwd if we're in a worktree. The recorded path comes
      // from another process (and older workflows recorded `/`), so it is
      // validated before chdir instead of trusted blindly.
      let chdirNote = "";
      const persisted = readWorkflowState({ cwd: ctx.cwd });
      if (persisted) {
        const target = isSafeChdirTarget({
          path: persisted.originalCwd,
          existsSync: (path) => existsSync(path),
          // statSync can race a concurrent delete; a probe failure means "not a
          // directory" and must not throw out of the tool handler.
          isDirectory: (path) => {
            try {
              return statSync(path).isDirectory();
            } catch {
              return false;
            }
          },
        });
        if (target.allowed) {
          process.chdir(target.path);
        } else {
          chdirNote = `\nWorking directory unchanged: ${target.reason}.`;
        }
        clearWorkflowState({ cwd: ctx.cwd });
      }

      // Teardown always drops the packet, even when workflow.json is missing: a
      // stale handoff must never be re-injected by the next workflow that runs
      // in this worktree.
      clearHandoff({ cwd: ctx.cwd });

      state.gateActive = false;
      state.completedPhaseNames = [];
      // A stopped session no longer hands anything off; leaving the marker in
      // memory would keep `belayd_status` reporting "Handed off" until restart.
      state.handedOffTo = undefined;
      state.handoffPendingNotice = undefined;
      const clearedCallerMarker = clearCallerHandoff({
        cwd: ctx.cwd,
        sessionKey: ctx.sessionManager.getSessionId(),
      });
      if (!clearedCallerMarker.ok) {
        reportHandoffProblem(
          `Belayd could not clear this session's handoff marker (${clearedCallerMarker.error}); ` +
            "a restart may still report a handoff that was stopped here.",
        );
      }
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
            text: `Belayd process deactivated.${chdirNote}`,
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

  /** Append a note to a task's notes field; best-effort and non-blocking. */
  async function appendTaskNote(taskId: string, content: string, cwd: string): Promise<void> {
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
      await appendTaskNote(
        taskId,
        userGuideNoteBody({ cwd, taskId: state.currentTaskId, report: state.userGuideContent }),
        cwd,
      );
    }
    if (state.proofVerifierVerdict) {
      await appendTaskNote(taskId, state.proofVerifierVerdict, cwd);
    }
  }

  /**
   * Bead note for the userguide phase: a stable pointer to the committed guide
   * plus the agent's own report. The pointer is emitted on its own line so
   * `bd show` names the record even when the report is only a summary, and it
   * is omitted when no file was written rather than claiming one that is absent.
   */
  function userGuideNoteBody(options: { cwd: string; taskId: string; report: string }): string {
    const docPath = userGuideDocPath(options.taskId);
    const wroteFile = existsSync(resolve(options.cwd, docPath));
    const pointer = wroteFile
      ? `## User guide\n\n\`${docPath}\` — How to Verify and How to Use.\n\n`
      : "## User guide\n\n(no guide file found in the worktree — see the report below)\n\n";
    return `${pointer}${options.report}`;
  }

  /** Tool failure result for an invalid commit task id. */
  function invalidCommitTaskIdText(taskId: string): string {
    return `Invalid task id: ${taskId}. Expected a beads id like "bd-42" or "bd-42.1" (letters/digits after "bd-", dot-separated segments).`;
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

  /**
   * Error text when this cwd does not own the commit's task/branch. A repo with
   * no workflow state has no identity contract to violate, so standalone
   * commits still stage normally there.
   */
  function commitOwnershipError(options: {
    cwd: string;
    state: SessionState;
    taskId: string | undefined;
  }): string | undefined {
    const persisted = readWorkflowState({ cwd: options.cwd });
    if (persisted === undefined) return undefined;

    const sessionTaskId = options.state.currentTaskId;
    const taskId = options.taskId ?? sessionTaskId;
    // A session may commit its own task or a sub-bead of it (bd-42.1), never an
    // unrelated bead or a parent from a sub-bead session.
    if (sessionTaskId !== "" && !isSameOrDescendantTask(taskId, sessionTaskId)) {
      return (
        `this session owns ${sessionTaskId}; refusing to commit ${taskId} in ${options.cwd} — ` +
        `use the orchestrator that owns ${taskId}'s worktree.`
      );
    }

    // Anchor the cwd preflight on workflow.json's task. A supplied sub-bead
    // resolves to its owning parent; an unrelated id still fails the matcher.
    const ownershipTaskId =
      taskId === "" || isSameOrDescendantTask(taskId, persisted.taskId) ? persisted.taskId : taskId;
    const owned = assertOwnedWorktree({
      cwd: options.cwd,
      taskId: ownershipTaskId,
      branch: readWorktreeBranch(options.cwd),
      readState: () => persisted,
    });
    return owned.ok ? undefined : owned.error;
  }

  /** Validate the commit invocation before any run manifest or staging starts. */
  function commitPreflight(options: {
    cwd: string | undefined;
    taskId: string | undefined;
    state: SessionState;
  }): { ok: true; cwd: string } | { ok: false; error: string } {
    if (options.taskId !== undefined && !isValidTaskId(options.taskId)) {
      return { ok: false, error: invalidCommitTaskIdText(options.taskId) };
    }
    const cwd = options.cwd;
    if (cwd === undefined || cwd === "") {
      return { ok: false, error: missingWorkingDirectoryError("belayd_commit") };
    }
    const ownershipError = commitOwnershipError({
      cwd,
      state: options.state,
      taskId: options.taskId,
    });
    return ownershipError === undefined ? { ok: true, cwd } : { ok: false, error: ownershipError };
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
      const state = getSessionState(ctx);
      const preflight = commitPreflight({ cwd: ctx?.cwd, taskId: params.taskId, state });
      if (!preflight.ok) return commitFailure(preflight.error);
      const cwd = preflight.cwd;
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
  /**
   * Fleet-mode refusal for one tool call, or undefined when the call is fine.
   *
   * A gated or planning session is never a supervisor (fleet mode arms no gate),
   * so this can never pre-empt the process gate or the bd-119 ownership
   * preflight with a fleet message — a member keeps its own refusal.
   */
  function fleetRefusalFor(options: {
    ctx: ExtensionContext;
    state: SessionState;
    toolName: string;
  }): string | undefined {
    if (options.state.gateActive || options.state.planningActive) return undefined;
    if (!isFleetRefusedTool(options.toolName)) return undefined;
    const fleet = fleetModeFor(options.ctx);
    if (fleet === undefined) return undefined;
    return formatFleetRefusal({ toolName: options.toolName, fleetId: fleet.fleetId });
  }

  pi.on("tool_call", (event, ctx) => {
    const state = getSessionState(ctx);
    // Fleet mode is an additional, earlier refusal with its own wording: a fleet
    // supervisor owns no worktree, so a phase tool is wrong here for a different
    // reason than bd-119.
    const fleetReason = fleetRefusalFor({ ctx, state, toolName: event.toolName });
    if (fleetReason !== undefined) {
      abortToolCall(event, "fleet-supervisor", fleetReason);
      return { block: true, reason: fleetReason };
    }
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
      clearHandoff({ cwd: ctx.cwd });
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
