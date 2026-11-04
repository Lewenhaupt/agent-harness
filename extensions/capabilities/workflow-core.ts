/**
 * Workflow core capability (bd-179): gate lifecycle, the phase ledger and the
 * handoff/recovery bookkeeping every workflow capability depends on.
 *
 * This is the seam the durable-member runtime and the PR publish path need: the
 * gate can be activated, evaluated, advanced and resumed from an injected state
 * store and injected gate primitives, with no extension global in sight. The
 * composer supplies the three process-gate primitives (`checkToolAllowed`,
 * `markPhaseCompleted`, `formatProcessState`) and the worktree-branch probe, so
 * this module never imports `src/process-gate.ts`, a fleet module or the
 * `src/index.ts` barrel.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPhaseToolName } from "../../src/agent-registry.js";
import { orchestratorActor, withActorArgv } from "../../src/beads-actor.js";
import { readHandoff, taskIdFromBranch } from "../../src/handoff.js";
import {
  adoptableWorktreeTaskId,
  matchSessionOwnedWorktree,
  type OwnedWorktreeResult,
  type readWorktreeBranch,
  type WorktreeBranch,
} from "../../src/owned-worktree.js";
import { userGuideDocPath } from "../../src/quality-gates.js";
import { PLANNING_TOOL_SET, workflowGateToolSet } from "../../src/role-tools.js";
import type { RunDelivery } from "../../src/run-detached.js";
import {
  listPendingUserCompletions,
  markRunDelivered,
  type RunManifest,
  readRunManifest,
  scanForInterruptedRuns,
} from "../../src/run-manifest.js";
import { type PhaseSessionRecord, resolvePhaseInvocation } from "../../src/session-naming.js";
import type { AwaitingHuman } from "../../src/workflow-phases.js";
import {
  getPhasesForType,
  isValidWorkflowType,
  parseWorkflowLabel,
  WF_LABEL_PREFIX,
  WORKFLOW_REGISTRY,
  WORKFLOW_SUB_TYPES,
  type WorkflowResolution,
  type WorkflowResolutionSource,
  type WorkflowSubType,
} from "../../src/workflow-registry.js";
import {
  archiveWorkflowState,
  classifyWorkflowClaimability,
  clearCallerHandoff,
  clearHandedOffMarker,
  type HandedOffMarker,
  readCallerHandoff,
  readWorkflowState,
  saveCompletedPhases,
  type WorkflowState,
  writeWorkflowState,
} from "../../src/workflow-state.js";
import type { CoreSessionState } from "./context.js";
import { abortToolCall, REVIEW_PHASE, runBdCommand } from "./context.js";
import { clearHumanAnswerWait } from "./human-gate.js";
import { resetModelTelemetry } from "./model.js";
import {
  isAwaitingReviewResponse,
  nextAwaitingReviewResponse,
  nextPhaseToolAfter,
  reviewFindingsGuidanceLines,
  reviewLoopDirective,
} from "./review.js";
import {
  type AskHoldContext,
  abortAndResetRunTracking,
  deliverFollowUp,
  formatHandedOffStatus,
  formatHandoffPendingNotice,
  markPendingCompletionsDelivered,
  type SessionContext,
} from "./session-state.js";

/**
 * The process-gate primitives, injected by the composer.
 *
 * They live in `src/process-gate.ts`, which a capability module may not import;
 * declaring the signature here keeps the rule enforceable while the composer
 * stays the single place that binds the primitive to its implementation.
 */
export interface WorkflowGateSeams {
  checkToolAllowed: (
    toolName: string,
    completed: string[],
    active: boolean,
    phaseOrder?: readonly string[],
    workflowType?: string,
    optionalPhases?: readonly string[],
    allowedExtraPhases?: readonly string[],
    awaitingHuman?: AwaitingHuman,
  ) => { allowed: boolean; reason?: string };
  markPhaseCompleted: (
    toolName: string,
    completed: string[],
    phaseOrder?: readonly string[],
  ) => string[];
  formatProcessState: (
    completed: string[],
    taskId: string,
    phaseOrder?: readonly string[],
  ) => string;
}

/** Everything the workflow core needs from its host. */
export interface WorkflowCoreDeps {
  pi: ExtensionAPI;
  getSessionState: (ctx: SessionContext) => CoreSessionState;
  gate: WorkflowGateSeams;
  /**
   * Injected because the extension tests swap it through the composer's
   * `src/index.js` barrel import; a direct import would bypass the mock.
   */
  readWorktreeBranch: typeof readWorktreeBranch;
}

/** The gate lifecycle, ledger and recovery surface the other capabilities use. */
export interface WorkflowCoreApi {
  evaluateToolCallGate: (
    event: ToolCallGateEvent,
    state: CoreSessionState,
  ) => { block?: boolean; reason?: string };
  formatWorkflowStatusSection: (state: CoreSessionState) => string;
  formatProcessState: WorkflowGateSeams["formatProcessState"];
  describePhase: (phase: string, workflowType: WorkflowSubType) => string;
  describeWorkflowType: (type: WorkflowSubType) => string;
  describeResolutionSource: (resolution: {
    source: WorkflowResolutionSource;
    matchedLabel?: string;
  }) => string;
  applyToolGate: (state: CoreSessionState) => void;
  applyWorkflowConfig: (state: CoreSessionState) => void;
  activateGate: (options: {
    ctx: SessionContext;
    taskId: string;
    workflowType?: WorkflowSubType;
    cwd: string;
    branch?: string;
    originalCwd?: string;
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
  }) => CoreSessionState;
  disarmForHandoff: (options: {
    state: CoreSessionState;
    cwd: string;
    marker: HandedOffMarker;
  }) => void;
  reportHandoffProblem: (message: string) => void;
  writeWorkflowTypeLabel: (options: {
    taskId: string;
    type: WorkflowSubType;
    cwd: string;
    existingLabels?: string[];
  }) => Promise<void>;
  resolveToolWorkflowResolution: (options: {
    ctx: ExtensionContext;
    taskId: string;
    resolution: WorkflowResolution;
    existingLabels?: string[];
  }) => Promise<
    | { kind: "resolved"; resolution: WorkflowResolution; persisted: boolean }
    | { kind: "denied"; text: string }
  >;
  /** Confirm a label-driven type (prompting) and persist the chosen label. */
  confirmAndPersistResolution: (options: {
    ctx: ExtensionContext;
    taskId: string;
    resolution: WorkflowResolution;
    existingLabels?: string[];
  }) => Promise<
    { kind: "resolved"; resolution: WorkflowResolution; persisted: boolean } | { kind: "cancelled" }
  >;
  sendWorkflowMessage: (options: {
    taskId: string;
    branch: string | null;
    workflowType?: WorkflowSubType;
    phaseOrder?: readonly string[];
    resolution?: { source: WorkflowResolutionSource; matchedLabel?: string };
  }) => void;
  missingTaskIdError: (toolName: string, cwd: string) => string;
  applyPhaseCompletion: (
    state: CoreSessionState,
    phaseName: string,
    outputText: string | undefined,
  ) => void;
  persistCompletedPhases: (options: {
    cwd: string;
    completedPhaseNames: string[];
    awaitingReviewResponse: boolean;
  }) => void;
  buildRunCompleteContent: (
    delivery: RunDelivery,
    reviewLoopHint: string,
    artifactLine: string,
  ) => string;
  userGuideArtifactLine: (
    delivery: RunDelivery,
    options: { cwd: string; taskId: string },
  ) => string;
  gateNextStepLine: (options: {
    activeRunCount: number;
    awaitingReviewResponse: boolean;
    remainingPhase: string;
  }) => string;
  advancePastExistingEpoch: (options: {
    prior: PhaseSessionRecord | undefined;
    freshSessionName: string;
    exists: (sessionName: string) => boolean;
  }) => {
    sessionName: string;
    resumeSession: boolean;
    next: PhaseSessionRecord;
  };
  activeWorkflowOwnership: (state: CoreSessionState, cwd: string) => OwnedWorktreeResult;
  adoptWorktreeTaskId: (state: CoreSessionState, cwd: string) => void;
  resumeWorkflowFromDisk: (state: CoreSessionState, cwd: string, sessionKey: string) => void;
  reconcileUserCompletions: (options: {
    state: CoreSessionState;
    ctx: AskHoldContext;
    cwd: string;
    runId?: string;
  }) => void;
}

/** The `tool_call` event subset the gate reads. */
export interface ToolCallGateEvent {
  toolName: string;
}

/**
 * Upper bound on the W6 collision-advance loop. A correctly-behaving `exists`
 * probe reaches the first absent epoch in a step or two; this cap only fires
 * when the injected probe never reports an absent epoch, guaranteeing the loop
 * terminates instead of spinning forever.
 */
const MAX_EPOCH_ADVANCES = 1000;

/**
 * Bead whose run manifests a directory's handoff settle may touch, or undefined.
 *
 * Completion clears `.belayd/workflow.json`, so a restarted caller's only
 * surviving record can be its branch (bd-242 review). Undefined means no owner is
 * known, and a settle with no owner must write nothing: a copy-ignored tree holds
 * the primary checkout's runs, so flipping an unattributed manifest would be a
 * write to another bead's state.
 */
function directoryOwnerTaskId(input: {
  persisted: WorkflowState | undefined;
  sessionTaskId: string;
  branch: WorktreeBranch;
}): string | undefined {
  if (input.persisted !== undefined) return input.persisted.taskId;
  if (input.sessionTaskId !== "") return input.sessionTaskId;
  return input.branch.ok ? taskIdFromBranch(input.branch.branch) : undefined;
}

export function createWorkflowCore(deps: WorkflowCoreDeps): WorkflowCoreApi {
  const { pi, getSessionState, gate, readWorktreeBranch } = deps;

  /** Point the session state at a workflow's ordered phases and consult set. */
  function applyWorkflowConfig(state: CoreSessionState): void {
    state.phaseOrder = getPhasesForType(state.workflowType);
    state.optionalPhases = WORKFLOW_REGISTRY[state.workflowType].optionalPhases ?? [];
    state.consultPhases = WORKFLOW_REGISTRY[state.workflowType].consultPhases ?? [];
  }

  /**
   * Derive the active tool set from session state instead of stashing
   * incrementally. A single `fullTools` stash, guarded by the current mode
   * flags, makes interleaved gate↔planning transitions always converge on the
   * correct set — the full original tools are only restored once both modes
   * are off, so edit/write/bash can never leak back into an active mode.
   */
  function applyToolGate(state: CoreSessionState): void {
    if (state.planningActive) {
      if (state.fullTools === undefined) state.fullTools = pi.getActiveTools();
      pi.setActiveTools([...PLANNING_TOOL_SET]);
      return;
    }
    if (state.gateActive) {
      if (state.fullTools === undefined) state.fullTools = pi.getActiveTools();
      const phases =
        state.phaseOrder.length > 0 ? state.phaseOrder : getPhasesForType(state.workflowType);
      pi.setActiveTools(workflowGateToolSet({ phases, consultPhases: state.consultPhases }));
      return;
    }
    if (state.fullTools !== undefined) {
      pi.setActiveTools(state.fullTools);
      state.fullTools = undefined;
    }
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

  /** Build the workflow.json identity payload for a freshly-activated gate. */
  function buildPersistedWorkflowState(options: {
    state: CoreSessionState;
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
    state: CoreSessionState,
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

  function activateGate(options: {
    ctx: SessionContext;
    taskId: string;
    workflowType?: WorkflowSubType;
    cwd: string;
    branch?: string;
    originalCwd?: string;
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
  }): CoreSessionState {
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
    reconcileWorkflowState(state, { taskId, cwd, options });
    // Applied after reconcile: a resume restores the persisted workflow type and
    // phase order, so the declared set must be derived from the reconciled state.
    applyToolGate(state);
    return state;
  }

  /**
   * Stop the caller from driving a workflow it just handed to a child
   * orchestrator (bd-120). Two live orchestrators on one bead produced
   * duplicate phase runs, interleaved writes, and apparent reverts, so the
   * caller drops every phase/proof field, aborts its in-flight runs, and
   * restores the full tool set.
   */
  function disarmForHandoff(options: {
    state: CoreSessionState;
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
    // The child orchestrator takes over the bead, so a wait that belongs to this
    // session's gate goes quiet here; the child re-discovers the bd gate
    // (bd-152).
    clearHumanAnswerWait(state);
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
      // Attribute the label write-back to the workflow's orchestrator (bd-150).
      // It is a lifecycle write made *for* the workflow, so `bd history` must
      // name the driver rather than the operator. Index 1 keeps `update` as
      // argv[0] and the label before the `--` terminator.
      await runBdCommand(
        withActorArgv(
          ["update", "--add-label", label, "--", options.taskId],
          orchestratorActor(options.taskId),
        ),
        {
          cwd: options.cwd,
          stdin: undefined,
          timeoutInMs: 15_000,
          maxBufferInBytes: 1024 * 1024,
        },
      );
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
   * Human-readable phase description, workflow-aware.
   *
   * In research workflows the "plan" phase is overridden to the research agent,
   * which records findings as a `[belayd:research]` bead comment — it never writes
   * an implementation plan file. Label it accordingly; otherwise the orchestrator
   * reads "create implementation plan" and re-delegates `belayd_plan` to force a
   * research .md file that the researcher contract explicitly forbids.
   */
  function describePhase(phase: string, workflowType: WorkflowSubType): string {
    if (workflowType === "research" && phase === "plan") {
      return "Research the question and record findings as a bead comment (never a .md file)";
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
    // findings as a `[belayd:research]` bead comment (not a .md file). Create
    // follow-up tasks before committing so they're included in the final commit.
    if (type === "research") {
      lines.push(
        "",
        "**Research deliverable:**",
        "- `belayd_plan` is the research agent. Pass it the task ID and the research question; it records findings as a bead comment tagged `[belayd:research]` (never a research .md file).",
        "- The deliverable is the bead comment — NOT a committed file. Do not re-delegate `belayd_plan` to write a research .md file, and do not expect `belayd_commit` to commit one.",
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

  function sendWorkflowMessage(options: {
    taskId: string;
    branch: string | null;
    workflowType?: WorkflowSubType;
    phaseOrder?: readonly string[];
    resolution?: { source: WorkflowResolutionSource; matchedLabel?: string };
  }): void {
    const type = options.workflowType ?? "feature";
    const phases = options.phaseOrder ?? getPhasesForType(type);

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

    const provenanceLine = options.resolution
      ? [`Type provenance: ${describeResolutionSource(options.resolution)}.`]
      : [];
    const lines: string[] = [
      `**Belayd ${type} workflow started for ${options.taskId}.**`,
      ...(options.branch ? [`Worktree: \`${options.branch}\``, ""] : []),
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
      `- Flag this task for human review (NEVER close it yourself): pass \`taskId\` to \`belayd_commit\`, or run \`bd update ${options.taskId} --status in_progress --add-label human\` with the \`bd\` tool.`,
    );

    pi.sendMessage(
      {
        customType: "belayd-command",
        content: lines.join("\n"),
        display: true,
      },
      { triggerTurn: true },
    );
  }

  /**
   * Refusal for a phase tool that cannot name its run: without a bead id the
   * subagent session name, run metrics, and scoped review diff would all be
   * wrong, so the run is refused instead of failing later or bypassing them.
   */
  function missingTaskIdError(toolName: string, cwd: string): string {
    return (
      `${toolName} needs a bead id for its run, and this session has none: ` +
      `no Belayd workflow state in ${cwd} and its branch does not name a bead. ` +
      `Start a workflow here (belayd_start_task <taskId>) or check out the bead's branch ` +
      `(e.g. feat/bd-42) and retry.`
    );
  }

  /**
   * Evaluate the process gate for a tool call. Extracted from the `tool_call`
   * hook so the two blocking branches (in-flight run and out-of-order phase)
   * stay flat and the hook stays below the complexity limit.
   */
  function evaluateToolCallGate(
    event: ToolCallGateEvent,
    state: CoreSessionState,
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

    const check = gate.checkToolAllowed(
      toolName,
      state.completedPhaseNames,
      state.gateActive,
      state.phaseOrder,
      state.workflowType,
      state.optionalPhases,
      state.consultPhases,
      state.awaitingHuman,
    );
    if (!check.allowed) {
      abortToolCall(event, "phase-order-blocked", check.reason ?? "Phase order violation");
      return { block: true, reason: check.reason };
    }

    return {};
  }

  /**
   * First status section: a handoff wins over a live workflow, because a
   * handed-off session keeps no gate but must still explain where the bead went.
   */
  function formatWorkflowStatusSection(state: CoreSessionState): string {
    if (state.handedOffTo !== undefined) return formatHandedOffStatus(state.handedOffTo);
    if (!state.gateActive) return "Belayd process is inactive.";
    return gate.formatProcessState(
      state.completedPhaseNames,
      state.currentTaskId,
      state.phaseOrder,
    );
  }

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
      !delivery.success && delivery.failureReason
        ? `\n\n**Reason:** ${delivery.failureReason}`
        : "";
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
    state: CoreSessionState,
    phaseName: string,
    outputText: string | undefined,
  ): void {
    state.completedPhaseNames = gate.markPhaseCompleted(
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

  /**
   * Preflight for workflow-scoped runs: the session's task must own `cwd` and
   * its branch. A post-completion rework call (gate off, workflow state gone)
   * legitimately runs outside a workflow, so it stays allowed; any workflow
   * state present in cwd still pins that tree to its owner.
   */
  function activeWorkflowOwnership(state: CoreSessionState, cwd: string): OwnedWorktreeResult {
    return matchSessionOwnedWorktree({
      cwd,
      currentTaskId: state.currentTaskId,
      gateActive: state.gateActive,
      branch: readWorktreeBranch(cwd),
      persisted: readWorkflowState({ cwd }),
    });
  }

  /**
   * Restore the bead identity of a session that lost it across a restart.
   *
   * Completion deletes `.belayd/workflow.json` and `session_start` clears the
   * in-memory task id, so a resumed orchestrator came back with no identity and
   * every phase tool died in subagent session naming with the raw
   * `taskId must be a non-empty string` — which killed the post-completion
   * rework (rebases, review follow-ups) this preflight allows. The branch is the
   * surviving record of the bead; the gate stays off, so nothing is persisted
   * and no phase state is re-armed.
   */
  function adoptWorktreeTaskId(state: CoreSessionState, cwd: string): void {
    const taskId = adoptableWorktreeTaskId({
      currentTaskId: state.currentTaskId,
      gateActive: state.gateActive,
      handedOff: state.handedOffTo !== undefined,
      branch: readWorktreeBranch(cwd),
      persisted: readWorkflowState({ cwd }),
    });
    if (taskId === undefined) return;
    state.currentTaskId = taskId;
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

  /**
   * Resolve the pending user completions to reconcile: one run or all.
   *
   * `taskId` scopes the `runId === undefined` scan to this bead's manifests. The
   * explicit-runId branch ignores it: `readRunManifest`/`markRunDelivered` already
   * pin that id to its own file, and the caller checks ownership of the result.
   */
  function pendingCompletionsFor(
    cwd: string,
    runId: string | undefined,
    taskId: string,
  ): RunManifest[] {
    if (runId === undefined) return listPendingUserCompletions({ cwd, taskId });
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
    state: CoreSessionState;
    ctx: AskHoldContext;
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

    for (const run of pendingCompletionsFor(cwd, options.runId, state.currentTaskId)) {
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
      // Delivery and the delivered-once marker move together: a held follow-up
      // marks the manifest delivered only when it actually reaches the
      // transcript, so a crash while holding cannot drop the completion.
      deliverFollowUp(state, options.ctx, `user completion ${run.runId}`, () => {
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
      });
    }
  }

  /**
   * Record a handed-off resume and settle the caller's leftovers rather than
   * dropping them (bd-120). A handed-off session cannot apply a phase
   * completion to a workflow it no longer drives, and it can no longer deliver
   * a follow-up for it, so interrupted runs are flipped to `interrupted` and
   * pending user completions are marked delivered with a summary that
   * `belayd_status` surfaces.
   */
  function settleHandoffPendingItems(options: {
    state: CoreSessionState;
    cwd: string;
    marker: HandedOffMarker;
  }): void {
    const { state, cwd, marker } = options;
    state.gateActive = false;
    // Deliberately no assignee clear on handoff (bd-150). Ownership transfers to
    // the child orchestrator, which re-mirrors the identical
    // `belayd:<taskId>:orchestrator` actor string; a parent-side clear would race
    // that mirror and wipe the child's assignment. Completion, accept and stop
    // clear instead.
    state.handedOffTo = { ...marker };

    // In a same-directory handoff the child orchestrator owns this cwd's state
    // and run manifests. Settling them here would flip a live child run to
    // interrupted and swallow its pending user completions, so the caller only
    // settles leftovers in a directory it still owns.
    const persistedHere = readWorkflowState({ cwd });
    if (persistedHere !== undefined && persistedHere.taskId === marker.taskId) return;

    // Only the directory owner's own manifests are settled: a copy-ignored tree
    // holds the primary checkout's runs, and flipping another bead's running
    // manifest (or marking its completion delivered) would write foreign state and
    // report it under this handoff (bd-242). With no owner there is nothing to
    // attribute, so nothing is written at all — arming a workflow later settles
    // its own runs.
    const ownerTaskId = directoryOwnerTaskId({
      persisted: persistedHere,
      sessionTaskId: state.currentTaskId,
      branch: readWorktreeBranch(cwd),
    });
    const interrupted =
      ownerTaskId === undefined ? [] : scanForInterruptedRuns({ cwd, taskId: ownerTaskId });
    const { delivered, undeliverable } =
      ownerTaskId === undefined
        ? { delivered: [], undeliverable: [] }
        : markPendingCompletionsDelivered({ cwd, taskId: ownerTaskId, skipTaskId: marker.taskId });
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
    state: CoreSessionState,
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

    // Surface any phase runs that died with the previous orchestrator. Only this
    // bead's own manifests count: a fresh worktree inherits `.belayd/runs` from the
    // primary checkout, and flipping (or reporting) another bead's manifest would
    // attribute that bead's crashed run to this workflow (bd-242).
    const interrupted = scanForInterruptedRuns({ cwd, taskId: persisted.taskId });
    if (interrupted.length > 0) {
      console.warn(
        `[belayd-harness] ${interrupted.length} interrupted phase run(s) detected for ${persisted.taskId}`,
      );
    }
  }

  /**
   * Archive a persisted workflow this session will not drive (bd-165).
   *
   * Renaming keeps the dead record diagnosable while freeing the worktree, so
   * the next session neither claims a lease from it nor re-arms its gate.
   */
  function archiveInertWorkflow(cwd: string, taskId: string): void {
    const archived = archiveWorkflowState({ cwd });
    if (!archived.ok) {
      console.warn(
        `[belayd-harness] could not archive the stale workflow state in ${cwd}: ${archived.error}`,
      );
      return;
    }
    // A no-op means the file is already gone, so there is nothing to report.
    if (!archived.archived) return;
    // Name the archive path so the operator can find the diagnosis record
    // without listing `.belayd/`. This runs once per inert file: the rename
    // removes the source, so a later session cannot log it again.
    console.warn(
      `[belayd-harness] archived the inert workflow state for ${taskId} at ${archived.archivedPath}`,
    );
  }

  /**
   * Resume the gate from the persisted workflow state written by /belayd.
   * A completed workflow is cleared instead of resurrected; a sub-agent never
   * reaches this helper because its session has no workflow state file.
   */
  function resumeWorkflowFromDisk(state: CoreSessionState, cwd: string, sessionKey: string): void {
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
    const marker = persisted.handedOffTo;
    if (marker !== undefined) {
      settleHandoffPendingItems({ state, cwd, marker });
      // bd-165: a handed-off workflow is terminal, so leaving its state file
      // behind makes every later session in this worktree look like an
      // orchestrator for a bead that is already closed. Archive it (never
      // delete — the record must stay diagnosable) after settling the caller's
      // leftovers, which need the marker this file carries.
      //
      // No same-directory-child exemption is needed here: `persistHandoffMarkers`
      // writes `handedOffTo` only onto the caller's own cross-worktree state and
      // skips `saveHandedOffMarker` when the child shares this directory, so a
      // live child's workflow.json never carries this marker at all.
      archiveInertWorkflow(cwd, persisted.taskId);
      return;
    }

    // A valid record that this session cannot drive (every phase done, or a task
    // id that cannot name a bead) must not resurrect the gate, and its file is
    // the poison bd-165 removes. Corrupt JSON never reaches here: the reader
    // returns undefined for it.
    if (classifyWorkflowClaimability(persisted).kind === "inert") {
      archiveInertWorkflow(cwd, persisted.taskId);
      return;
    }

    armFromPersistedWorkflow(state, cwd, persisted);
  }

  return {
    evaluateToolCallGate,
    formatWorkflowStatusSection,
    formatProcessState: gate.formatProcessState,
    describePhase,
    describeWorkflowType,
    describeResolutionSource,
    applyToolGate,
    applyWorkflowConfig,
    activateGate,
    disarmForHandoff,
    reportHandoffProblem,
    writeWorkflowTypeLabel,
    resolveToolWorkflowResolution,
    confirmAndPersistResolution,
    sendWorkflowMessage,
    missingTaskIdError,
    applyPhaseCompletion,
    persistCompletedPhases,
    buildRunCompleteContent,
    userGuideArtifactLine,
    gateNextStepLine,
    advancePastExistingEpoch,
    activeWorkflowOwnership,
    adoptWorktreeTaskId,
    resumeWorkflowFromDisk,
    reconcileUserCompletions,
  };
}
