/**
 * Worktree launch capability (bd-179): the worktree/task helpers and the child
 * orchestrator launch (`/belayd`, `belayd_start_followup`, fleet members).
 *
 * Fleet-free by construction: the one fleet call the old composer code made
 * here (`stopOrchestratorLeaseTimer`) arrives as an injected dependency, so the
 * whole launch path — worktree creation, handoff packet, orchestrator session,
 * marker persistence, lease transfer — can run without the fleet supervisor.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { orchestratorActor } from "../../src/beads-actor.js";
import { mirrorAssignee } from "../../src/beads-assignee.js";
import type { CapacityCache } from "../../src/capacity-cache.js";
import type { HandoffPacket } from "../../src/handoff.js";
import { buildOrchestratorPrompt, taskIdFromBranch, writeHandoff } from "../../src/handoff.js";
import type { ModelCooldownStore } from "../../src/model-cooldown.js";
import {
  acquireOrchestratorClaim,
  assignOrchestratorClaimSession,
  ORCHESTRATOR_CLAIM_PENDING_PREFIX,
  readOrchestratorClaim,
  releaseOrchestratorClaim,
  replaceOrchestratorClaim,
} from "../../src/orchestrator-claim.js";
import {
  describeBlockedProviders,
  type ProviderWindow,
  planModelRoute,
  splitModelRoute,
} from "../../src/orchestrator-model.js";
import { computeOrchestratorSessionName } from "../../src/session-naming.js";
import type { TranscriptEntry } from "../../src/session-transcript.js";
import { hasConversation, narrowTranscriptEntries } from "../../src/session-transcript.js";
import { currentBranch } from "../../src/stack-rebase.js";
import {
  getPhasesForType,
  type WorkflowResolutionSource,
  type WorkflowSubType,
} from "../../src/workflow-registry.js";
import {
  clearWorkflowState,
  type HandedOffMarker,
  readWorkflowState,
  saveHandedOffMarker,
  writeCallerHandoff,
  writeWorkflowState,
} from "../../src/workflow-state.js";
import { isInsideWorktreeForBranch } from "../../src/worktree.js";
import type { CoreSessionState } from "./context.js";
import { errorText, reportAssigneeResult, runBdCommand, runBdForAssignee } from "./context.js";
import { daemonRequest } from "./daemon.js";
import type { SessionContext } from "./session-state.js";
import type { WorkflowCoreApi } from "./workflow-core.js";

/** Barrel symbols the extension tests replace through `src/index.js`. */
export interface LaunchSeams {
  setupWorktree: typeof import("../../src/worktree.js").setupWorktree;
  awaitWorktreeReady: typeof import("../../src/worktree.js").awaitWorktreeReady;
  readStackNode: typeof import("../../src/stack-rebase.js").readStackNode;
  collectHandoffDefault: typeof import("../../src/handoff.js").collectHandoffDefault;
  /** Injected: `src/bead-comments.ts` reaches fleet code, so it may not be imported here. */
  stripBdShowComments: (stdout: string) => string;
}

/** Everything the launch capability needs from its host. */
export interface LaunchDeps {
  pi: ExtensionAPI;
  getSessionState: (ctx: SessionContext) => CoreSessionState;
  core: Pick<WorkflowCoreApi, "disarmForHandoff" | "reportHandoffProblem">;
  /** Stops the worktree-lease heartbeat; the fleet capability owns the timer. */
  stopOrchestratorLeaseTimer: (state: CoreSessionState) => void;
  /** Model-routing state the composer owns (bd-116 session state). */
  modelRouting: LaunchModelRouting;
  seams: LaunchSeams;
}

/**
 * Routing seams the orchestrator launch reads (bd-229).
 *
 * The child session is created by the pi-web daemon, which starts pi on the
 * operator's global default model; the harness's own knowledge that a provider
 * is spent lives here, so the launch path has to consult it explicitly.
 */
export interface LaunchModelRouting {
  cooldownStore: ModelCooldownStore;
  capacity: CapacityCache;
  /** `BELAYD_MODEL_FALLBACK=0` opts out of every routing decision, including this one. */
  enabled: boolean;
}

/** Labels resolved from a beads issue. */
export interface TaskMetadata {
  labels?: string[];
}

/** The launch surface the fleet supervisor and the workflow commands share. */
export interface LaunchApi {
  ensureWorktree: (projectRoot: string, branch: string, base?: string) => string | undefined;
  readTaskMetadata: (taskId: string, cwd: string) => Promise<TaskMetadata | undefined>;
  readTaskPlan: (taskId: string, cwd: string) => Promise<string | undefined>;
  launchBlocker: (options: {
    state: CoreSessionState;
    cwd: string;
    branch: string;
    force: boolean;
  }) => string | undefined;
  launchWorktreeWorkflow: (options: {
    ctx: ExtensionContext;
    taskId: string;
    workflowType: WorkflowSubType;
    branch: string;
    base?: string;
    handoff?: string;
    resolutionSource?: WorkflowResolutionSource;
    matchedLabel?: string;
    force?: boolean;
    role?: "handoff" | "fleet-member";
  }) => Promise<{ ok: true; handoff: HandedOffMarker } | { ok: false; error: string }>;
}

export function createLaunch(deps: LaunchDeps): LaunchApi {
  const { pi, getSessionState, core, stopOrchestratorLeaseTimer, modelRouting, seams } = deps;

  // ── Worktree creation helper ────────────────────────────────────────
  function ensureWorktree(projectRoot: string, branch: string, base?: string): string | undefined {
    try {
      return isInsideWorktreeForBranch(projectRoot, branch)
        ? projectRoot
        : seams.setupWorktree(projectRoot, { branch, base });
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
   * Read a bead's plan via `bd show <taskId>`: description, design, notes and
   * relations only. The COMMENTS thread is dropped because deliverables land
   * there and would otherwise grow every later phase prompt without bound (and
   * can carry secrets). Returns undefined on error so callers can proceed
   * without the plan.
   */
  async function readTaskPlan(taskId: string, cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await runBdCommand(["show", taskId], {
        cwd,
        stdin: undefined,
        timeoutInMs: 15_000,
        maxBufferInBytes: 1024 * 1024,
      });
      return seams.stripBdShowComments(stdout).trim() || undefined;
    } catch {
      return undefined;
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

  /** Whether this session currently holds the worktree's orchestrator lease. */
  function ownsWorktreeLease(worktreePath: string, sessionId: string): boolean {
    const read = readOrchestratorClaim({ worktreePath });
    return read.kind === "ok" && read.claim.sessionId === sessionId;
  }

  /**
   * Take a spawner's lease on the member worktree, or refuse the launch.
   *
   * The lease must exist before the child session starts; its session id does not
   * exist yet, so it is written as `pending:<token>` and adopted by the child on
   * its first turn (then pointed at the real id).
   */
  function claimWorktreeForSpawn(options: {
    ctx: ExtensionContext;
    worktreePath: string;
    taskId: string;
    branch: string;
  }): { ok: true; pendingClaimId: string } | { ok: false; error: string } {
    const pendingClaimId = `${ORCHESTRATOR_CLAIM_PENDING_PREFIX}${randomUUID()}`;
    // A forced same-directory handoff spawns the child into the caller's own
    // worktree. The caller holds the lease there, so the spawner replaces its own
    // record instead of being refused by it; the caller stops renewing.
    const callerSessionId = options.ctx.sessionManager.getSessionId();
    if (ownsWorktreeLease(options.worktreePath, callerSessionId)) {
      const replaced = replaceOrchestratorClaim({
        worktreePath: options.worktreePath,
        expectSessionId: callerSessionId,
        taskId: options.taskId,
        branch: options.branch,
        sessionId: pendingClaimId,
        pid: process.pid,
        now: Date.now(),
      });
      if (!replaced.ok) {
        return {
          ok: false,
          error: `Refusing to launch ${options.taskId} in ${options.worktreePath}: ${replaced.error}`,
        };
      }
      const state = getSessionState(options.ctx);
      stopOrchestratorLeaseTimer(state);
      state.heldLeaseSessionId = undefined;
      return { ok: true, pendingClaimId };
    }
    const claimed = acquireOrchestratorClaim({
      worktreePath: options.worktreePath,
      taskId: options.taskId,
      branch: options.branch,
      sessionId: pendingClaimId,
      pid: process.pid,
      now: Date.now(),
      takeOverStale: true,
    });
    if (!claimed.ok) {
      return {
        ok: false,
        error:
          `Refusing to launch ${options.taskId} in ${options.worktreePath}: ${claimed.error}. ` +
          "One orchestrator per worktree — finish or stop the session that owns it, or remove " +
          "`.belayd/orchestrator.json` once that session is gone.",
      };
    }
    if (claimed.tookOverFrom !== undefined) {
      options.ctx.ui.notify(
        `Took over an abandoned orchestrator lease for ${options.taskId} in ${options.worktreePath} ` +
          `(previous session ${claimed.tookOverFrom.sessionId}` +
          (claimed.archivedPath === undefined ? ")." : `, archived at ${claimed.archivedPath}).`),
        "warning",
      );
    }
    return { ok: true, pendingClaimId };
  }

  // ── Orchestrator model routing (bd-229) ────────────────────────────────

  /**
   * True when a candidate's provider (or its exact endpoint) is known to be
   * unable to serve a turn: a reactive cooldown mark from an earlier failure, or
   * a pre-dispatch capacity window.
   */
  function candidateBlocked(candidate: string): boolean {
    if (modelRouting.cooldownStore.cooldownScope(candidate) !== undefined) return true;
    return modelRouting.capacity.isModelExhausted(candidate);
  }

  /**
   * Reset windows from both sources, so a refusal can name when a provider is
   * back. The cooldown store is the reactive record; the capacity cache adds a
   * configured usage endpoint's view of the same provider.
   */
  function exhaustionWindows(): ProviderWindow[] {
    const windows: ProviderWindow[] = [];
    for (const [provider, entry] of modelRouting.cooldownStore.providerEntries()) {
      windows.push({ provider, resetAt: entry.until });
    }
    windows.push(...modelRouting.capacity.windows());
    return windows;
  }

  /** Refusal text naming every provider that cannot serve this launch. */
  function describeNoModelAvailable(blocked: readonly string[], detail?: string): string {
    const named = describeBlockedProviders({
      candidates: blocked,
      windows: exhaustionWindows(),
      nowMs: Date.now(),
    });
    return (
      `Refusing to launch: no model candidate can serve a turn (${named}). Wait for that ` +
      "window to lapse or top up the provider, then retry. BELAYD_MODEL_FALLBACK=0 skips this " +
      "check, but the session will fail on the same provider." +
      (detail === undefined ? "" : ` Last error: ${detail}`)
    );
  }

  /**
   * Refuse a launch before any side effect when the caller's model has no usable
   * candidate.
   *
   * The caller's model stands in for the child's here: pi-web resolves both from
   * the same global default (plus any workspace `.pi/settings.json` override), so
   * it answers "is any provider able to serve this launch" without creating
   * anything. The authoritative per-session check happens after creation.
   */
  async function preflightModelAvailability(
    current: string | undefined,
  ): Promise<string | undefined> {
    if (!modelRouting.enabled || current === undefined) return undefined;
    await modelRouting.capacity.refreshIfStale();
    const plan = planModelRoute({ current, isBlocked: candidateBlocked });
    if (plan.available.length > 0) return undefined;
    return describeNoModelAvailable(plan.blocked);
  }

  /**
   * The model a newly created child session is about to run on.
   *
   * `GET /sessions/:id/status` is authoritative: pi-web resolves the session
   * model from the global default plus a workspace override, and this route
   * reports the resolved model. A daemon that cannot answer leaves the caller's
   * model as the best available stand-in.
   */
  async function readSessionModel(sessionId: string, cwd: string): Promise<string | undefined> {
    try {
      const status = await daemonRequest(
        "GET",
        `/sessions/${sessionId}/status?cwd=${encodeURIComponent(cwd)}`,
      );
      return providerQualifiedModel(status.model);
    } catch {
      return undefined;
    }
  }

  /** Ask pi-web to run the child session on `candidate`. */
  async function setSessionModel(options: {
    sessionId: string;
    cwd: string;
    candidate: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const route = splitModelRoute(options.candidate);
    if (route === undefined) {
      return { ok: false, error: `cannot set the unqualified model id ${options.candidate}` };
    }
    try {
      await daemonRequest("POST", `/sessions/${options.sessionId}/model`, {
        cwd: options.cwd,
        provider: route.provider,
        modelId: route.modelId,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /**
   * Move a newly created child session off a blocked model, before it is
   * prompted.
   *
   * Errors are values: a candidate pi-web refuses (unknown wire id, no
   * credential) falls through to the next one, and only a session left on a
   * blocked model is a launch failure — that session would die on its first
   * turn, which is exactly the outcome bd-229 exists to prevent.
   */
  async function routeOrchestratorModel(options: {
    sessionId: string;
    cwd: string;
    callerModel: string | undefined;
  }): Promise<{ ok: true; model?: string; previous?: string } | { ok: false; error: string }> {
    if (!modelRouting.enabled) return { ok: true };
    await modelRouting.capacity.refreshIfStale();
    const current = (await readSessionModel(options.sessionId, options.cwd)) ?? options.callerModel;
    if (current === undefined) return { ok: true };

    const plan = planModelRoute({ current, isBlocked: candidateBlocked });
    if (plan.currentUsable) return { ok: true };

    let lastError: string | undefined;
    for (const candidate of plan.available) {
      const applied = await setSessionModel({
        sessionId: options.sessionId,
        cwd: options.cwd,
        candidate,
      });
      if (applied.ok) return { ok: true, model: candidate, previous: current };
      lastError = applied.error;
    }
    return { ok: false, error: describeNoModelAvailable(plan.blocked, lastError) };
  }

  /**
   * Drop a child session that cannot be routed, so a refused launch does not
   * leave a live orphan: stop it, then archive it out of the active list.
   *
   * Best effort by design — a daemon that cannot stop the session must not mask
   * the routing error the caller needs to see.
   */
  async function abandonUnroutableSession(options: {
    sessionId: string;
    worktreePath: string;
  }): Promise<void> {
    for (const action of ["stop", "archive"] as const) {
      try {
        await daemonRequest("POST", `/sessions/${options.sessionId}/${action}`, {
          cwd: options.worktreePath,
        });
      } catch (error) {
        console.warn(
          `[belayd-harness] could not ${action} unroutable session ${options.sessionId}: ${errorText(error)}`,
        );
      }
    }
  }

  /**
   * Route a newborn child session, and drop it when it cannot be routed.
   *
   * A refused launch must leave nothing behind: the session is stopped and
   * archived, the lease it was given is released, and the workflow state written
   * for its first turn is cleared. That state is written before the session
   * exists (its `session_start` reads it), so cleanup is the only way back.
   */
  async function routeOrAbandon(options: {
    sessionId: string;
    worktreePath: string;
    taskId: string;
    callerModel: string | undefined;
  }): Promise<{ ok: true; model?: string; previous?: string } | { ok: false; error: string }> {
    const routed = await routeOrchestratorModel({
      sessionId: options.sessionId,
      cwd: options.worktreePath,
      callerModel: options.callerModel,
    });
    if (routed.ok) {
      if (routed.model !== undefined) {
        console.warn(
          `[belayd-harness] orchestrator ${options.taskId} routed to ${routed.model} ` +
            `because ${routed.previous} is unavailable`,
        );
      }
      return routed;
    }
    await abandonUnroutableSession({
      sessionId: options.sessionId,
      worktreePath: options.worktreePath,
    });
    releaseOrchestratorClaim({
      worktreePath: options.worktreePath,
      sessionId: options.sessionId,
    });
    clearWorkflowState({ cwd: options.worktreePath });
    return routed;
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

    // The caller's model is the pre-create stand-in for the child's (see
    // `preflightModelAvailability`), which the launch already checked.
    const callerModel = providerQualifiedModel(ctx.model);

    // Claim the worktree before the session exists.
    //
    // The lease is what makes a second launch refuse, and it must be in place
    // before the child session starts, or two spawns in the same window both see
    // an unclaimed worktree. The session id does not exist yet, so the lease is
    // written as `pending:<token>` and adopted by the child on its first turn
    // (then pointed at the real id below).
    const claim = claimWorktreeForSpawn({ ctx, worktreePath, taskId, branch });
    if (!claim.ok) return claim;
    const pendingClaimId = claim.pendingClaimId;

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

    // Mirror the driving actor as the bead's assignee (bd-150). Only an
    // unassigned bead is taken (CAS-guarded), and a failure is a warning: a
    // missing assignee degrades ownership reporting, it does not block work.
    const mirrored = await mirrorAssignee({
      taskId,
      actor: orchestratorActor(taskId),
      cwd: worktreePath,
      runBd: runBdForAssignee,
    });
    reportAssigneeResult(mirrored);

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
      releaseOrchestratorClaim({ worktreePath, sessionId: pendingClaimId });
      return {
        ok: false,
        error: `Session daemon rejected the orchestrator request: ${errorText(error)}. No child session was created.`,
      };
    }

    if (!created.id) {
      releaseOrchestratorClaim({ worktreePath, sessionId: pendingClaimId });
      return { ok: false, error: "Session daemon returned no session id." };
    }

    // Point the lease at the real session. The child may already have adopted the
    // pending record (same id), in which case this is a no-op.
    const assigned = assignOrchestratorClaimSession({
      worktreePath,
      fromSessionId: pendingClaimId,
      toSessionId: created.id,
      now: Date.now(),
    });
    if (!assigned.ok) {
      console.warn(
        `[belayd-harness] could not record the orchestrator session in ${worktreePath}: ${assigned.error}`,
      );
    }

    // Route the child off a model its provider cannot serve, before it is
    // prompted (bd-229): pi-web started it on the operator's global default.
    const routed = await routeOrAbandon({
      sessionId: created.id,
      worktreePath,
      taskId,
      callerModel,
    });
    if (!routed.ok) return { ok: false, error: routed.error };

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
  function describeInFlightLaunchRefusal(state: CoreSessionState): string {
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
    state: CoreSessionState;
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
      core.reportHandoffProblem(
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

    // Refuse before any side effect when no provider can serve the child's first
    // turn (bd-229). This runs before the worktree is created too: a launch that
    // can only fail should not leave a worktree, a lease and armed state behind.
    const unusable = await preflightModelAvailability(providerQualifiedModel(options.ctx.model));
    if (unusable !== undefined) return { ok: false, error: unusable };

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
    const ready = await seams.awaitWorktreeReady(worktreePath);
    if (!ready.ok) return { ok: false, error: `Worktree not ready: ${ready.error}` };

    // The worktree create path records the effective base + fork point, so the
    // packet's stack identity comes from git rather than from a re-derivation.
    const stack = seams.readStackNode(options.ctx.cwd, options.branch);
    const base = options.base ?? stack?.base;
    const parent = resolveParentIdentity(options.ctx, base);
    const handoff = await seams.collectHandoffDefault({
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
   * Hand a same-directory worktree lease to the child orchestrator.
   *
   * The caller stops renewing first: a lease names exactly one session, and the
   * child must find the worktree free (or already its own) on its first turn.
   */
  function transferOrchestratorLease(options: {
    state: CoreSessionState;
    cwd: string;
    toSessionId: string;
  }): void {
    const fromSessionId = options.state.heldLeaseSessionId;
    stopOrchestratorLeaseTimer(options.state);
    options.state.heldLeaseSessionId = undefined;
    if (fromSessionId === undefined) return;
    const assigned = assignOrchestratorClaimSession({
      worktreePath: options.cwd,
      fromSessionId,
      toSessionId: options.toSessionId,
      now: Date.now(),
    });
    if (!assigned.ok) {
      console.warn(
        `[belayd-harness] could not transfer the orchestrator lease in ${options.cwd}: ${assigned.error}`,
      );
    }
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
    state: CoreSessionState;
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

    core.disarmForHandoff({ state: options.state, cwd: ctx.cwd, marker });
    // A same-directory handoff shares one worktree, so the caller's orchestrator
    // lease must move to the child: leaving it with the caller (which is now
    // disarmed but still alive) would make the child refuse its own worktree.
    if (options.sameDirectory) {
      transferOrchestratorLease({
        state: options.state,
        cwd: ctx.cwd,
        toSessionId: marker.sessionId,
      });
    }
    // Only a session that already holds a conversation is told about the
    // handoff. Nothing in a message-less session can act on it, and because the
    // follow-up is sent with `triggerTurn: true` it would also start a model
    // turn whose only possible answer is a restatement — an output the user
    // never asked for. The launch is announced by the `ctx.ui.notify` in
    // `createOrchestratorSession`, and `belayd_status` still reports the handoff
    // (bd-148).
    if (hasConversation(readSessionBranch(ctx))) {
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
    }
    return { ok: true, handoff: marker };
  }

  return {
    ensureWorktree,
    readTaskMetadata,
    readTaskPlan,
    launchBlocker,
    launchWorktreeWorkflow,
  };
}

/**
 * A `provider/modelId` id from a pi model object or a daemon status field, or
 * undefined when it is not a qualified model.
 *
 * Shared by the caller's `ctx.model` and the child's `status.model`: both are
 * untrusted at the boundary (the daemon response is `Record<string, unknown>`),
 * and an unqualified id must not reach the model route or a cooldown mark as a
 * provider-less model.
 */
function providerQualifiedModel(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { provider?: unknown; id?: unknown };
  if (typeof record.provider !== "string" || record.provider === "") return undefined;
  if (typeof record.id !== "string" || record.id === "") return undefined;
  return `${record.provider}/${record.id}`;
}
