/**
 * Session-state capability: the per-session state store and its read/format
 * helpers (bd-179).
 *
 * The store is generic over the state type so the composer can instantiate it
 * with the fleet-inclusive `SessionState` while every helper here works on the
 * fleet-free `CoreSessionState`. Ask-hold (bd-177), beads-actor attribution
 * (bd-150), run tracking and handoff formatting live here because they are
 * session plumbing, not a workflow capability.
 */
import { ASK_HOLD_MAX_MS, askTail } from "../../src/ask-hold.js";
import { orchestratorActor, resolveBdActor, withActorArgv } from "../../src/beads-actor.js";
import {
  listPendingUserCompletions,
  markRunDelivered,
  type RunManifest,
} from "../../src/run-manifest.js";
import { getPhasesForType, WORKFLOW_REGISTRY } from "../../src/workflow-registry.js";
import type { HandedOffMarker } from "../../src/workflow-state.js";
import type { CoreSessionState } from "./context.js";

/**
 * The slice of a pi session context the state store needs.
 *
 * Declared here, not imported from pi, so the same store can be exercised by a
 * narrower test double.
 */
export interface SessionContext {
  sessionManager: { getSessionId: () => string };
}

/**
 * Per-session harness state, one object per pi session id.
 *
 * Module-level by design (as it was in the composer): the map is keyed by
 * session id and its lifetime is the process. The composer instantiates the
 * store with the full `SessionState` type, so fleet and core fields share the
 * one runtime object.
 */
export interface SessionStateStore<S extends CoreSessionState> {
  (ctx: SessionContext): S;
  /** The state for an id, if the session was seen. */
  peek(id: string): S | undefined;
  /** Forget a session's state (shutdown). */
  delete(id: string): void;
  /**
   * Drop every session's state, running the store's dispose hook first.
   *
   * Exists for tests: the map is keyed by session id and the suite reuses ids
   * like `supervisor-session`, so a leftover entry (a pending fleet-event ack,
   * an armed gate, a scheduled fleet tick) would be acted on by the next test.
   * The dispose hook is what stops a scheduled run loop; dropping only the
   * entry would leave its timer ticking the session id it was keyed by.
   * Production clears per id through `delete` on `session_shutdown`.
   */
  clear(): void;
}

export function createSessionStateStore<S extends CoreSessionState>(
  createInitial: () => S,
  disposeState?: (state: S) => void,
): SessionStateStore<S> {
  const sessionStates = new Map<string, S>();
  const store = (ctx: SessionContext): S => {
    const id = ctx.sessionManager.getSessionId();
    const existing = sessionStates.get(id);
    if (existing !== undefined) return existing;
    const created = createInitial();
    sessionStates.set(id, created);
    return created;
  };
  return Object.assign(store, {
    peek: (id: string) => sessionStates.get(id),
    delete: (id: string) => {
      sessionStates.delete(id);
    },
    clear: () => {
      for (const state of sessionStates.values()) disposeState?.(state);
      sessionStates.clear();
    },
  });
}

/** A fresh session's state: no gate, no planning, feature phase order. */
export function createInitialSessionState(): CoreSessionState {
  return {
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
}

export type AskHoldContext = { sessionManager: { getBranch?: () => readonly unknown[] } };

/**
 * Emit one warning per session for a stable key.
 *
 * The per-call resolution stays untouched; only the log line is deduped, so an
 * operator typo in a repo config does not spam every phase `bd` invocation. The
 * set lives on the session state (the one allowed per-session home), so it dies
 * with the session instead of growing a process-global cache.
 */
export function warnOncePerSession(state: CoreSessionState, key: string, message: string): void {
  const seen = state.authorityWarningsSeen ?? new Set<string>();
  state.authorityWarningsSeen = seen;
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(message);
}

/** Structural guard for a pi context that can resolve a session state. */
export function hasSessionManager(ctx: unknown): ctx is SessionContext {
  const manager = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
  return typeof manager?.getSessionId === "function";
}

/**
 * Emit repo-config warnings once per session, or to the log when the context is
 * too narrow to resolve a session (a test double, a load-time call).
 *
 * Both authority seams that read `.belayd/config.json` use this so one operator
 * typo logs once, not once per bd call and not once per 30 s answer poll.
 */
export function emitSessionWarnings(
  ctx: unknown,
  warnings: readonly string[],
  getState: (ctx: SessionContext) => CoreSessionState,
): void {
  const state = hasSessionManager(ctx) ? getState(ctx) : undefined;
  for (const warning of warnings) {
    const message = `[belayd-harness] ${warning}`;
    if (state === undefined) console.warn(message);
    else warnOncePerSession(state, warning, message);
  }
}

/**
 * Read the active branch defensively.
 *
 * `getBranch` is the only accurate view of "what the human sees last", which is
 * what decides whether a PI WEB question form is still open. A manager without
 * it (a narrower test double, an older runtime) yields no entries, and the hold
 * then declines to hold rather than suspending every follow-up.
 */
export function askHoldBranch(ctx: AskHoldContext): readonly unknown[] {
  const branch = ctx.sessionManager.getBranch?.();
  return Array.isArray(branch) ? branch : [];
}

/**
 * Send a completion follow-up now, or hold it while a `ask_user` question set is
 * still unanswered (bd-177).
 *
 * Holding is deliberately scoped to the follow-up path: an answer, a skip, and a
 * user message each arrive as the next turn start, so {@link releaseHeldFollowUps}
 * runs from `before_agent_start`/`input` rather than from a poll. The timers only
 * bound the wait for a question set nobody touches.
 */
export function deliverFollowUp(
  state: CoreSessionState,
  ctx: AskHoldContext,
  label: string,
  send: () => void,
): void {
  if (askTail(askHoldBranch(ctx)).kind === "open") {
    const held = state.heldFollowUps ?? [];
    state.heldFollowUps = held;
    if (held.length === 0) {
      console.warn(
        `[belayd-harness] holding the ${label} follow-up: an ask_user question set is still unanswered, and PI WEB closes its form as soon as another message lands (bd-177)`,
      );
      const timer = setTimeout(() => {
        releaseHeldFollowUps(
          state,
          `no answer arrived within ${(ASK_HOLD_MAX_MS / 60_000).toString()} minutes`,
        );
      }, ASK_HOLD_MAX_MS);
      timer.unref();
      state.heldFollowUpTimer = timer;
    }
    held.push({ label, send });
    return;
  }
  releaseHeldFollowUps(state);
  send();
}

/**
 * Release held follow-ups in transcript order.
 *
 * Safe to call when nothing is held, so every turn start can call it
 * unconditionally: a wake means something was appended, which means the question
 * form the hold was protecting is already gone.
 */
export function releaseHeldFollowUps(state: CoreSessionState, reason?: string): void {
  if (state.heldFollowUpTimer !== undefined) {
    clearTimeout(state.heldFollowUpTimer);
    state.heldFollowUpTimer = undefined;
  }
  const held = state.heldFollowUps;
  state.heldFollowUps = undefined;
  if (held === undefined || held.length === 0) return;
  if (reason !== undefined) {
    console.warn(
      `[belayd-harness] releasing ${held.length.toString()} held follow-up(s) unanswered: ${reason}`,
    );
  }
  for (const followUp of held) followUp.send();
}

/** The subset of pi's session manager the bd actor resolution needs. */
type BdActorSessionManager = {
  getSessionName?: () => string | undefined;
  getSessionId?: () => string;
};

function bdActorSessionManager(ctx: unknown): BdActorSessionManager | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const manager = (ctx as { sessionManager?: unknown }).sessionManager;
  return typeof manager === "object" && manager !== null
    ? (manager as BdActorSessionManager)
    : undefined;
}

/**
 * The beads actor this session's `bd` writes carry (bd-150).
 *
 * Two sources, in order: the session name pi reports, then the armed gate. The
 * gate fallback exists because a `belayd --no-worktree` run drives a bead from a
 * session whose name pi cannot resolve to a task id. A human session (no gate,
 * no harness name) resolves to undefined on purpose: its writes keep the git
 * `user.name` / scotty's inherited `BEADS_ACTOR`, never a harness actor.
 */
export function resolveSessionBdActor(
  ctx: unknown,
  getSessionState: (ctx: SessionContext) => CoreSessionState,
): string | undefined {
  const manager = bdActorSessionManager(ctx);
  if (manager === undefined) return undefined;
  const sessionName =
    typeof manager.getSessionName === "function" ? manager.getSessionName() : undefined;
  const fromName = resolveBdActor(sessionName);
  if (fromName !== undefined) return fromName;
  if (typeof manager.getSessionId !== "function") return undefined;
  const state = getSessionState(ctx as { sessionManager: { getSessionId: () => string } });
  return state.gateActive && state.currentTaskId !== ""
    ? orchestratorActor(state.currentTaskId)
    : undefined;
}

/**
 * Attribute a validated `bd` argv to this session's actor, when one resolves.
 *
 * Kept out of the tool's `execute` so that callback stays under the complexity
 * limit; the argv is returned untouched for humans.
 */
export function attributedBdArgv(
  argv: readonly string[],
  ctx: unknown,
  getSessionState: (ctx: SessionContext) => CoreSessionState,
): readonly string[] {
  const actor = resolveSessionBdActor(ctx, getSessionState);
  return actor === undefined ? argv : withActorArgv(argv, actor);
}

export function formatHandedOffStatus(marker: HandedOffMarker): string {
  return (
    `**Handed off** — ${marker.taskId} is owned by session \`${marker.sessionId}\` ` +
    `in worktree \`${marker.branch}\`; this session no longer drives a workflow.`
  );
}

/** Active-run list for `belayd_status` (always printed, even when empty). */
export function formatActiveRunsSection(
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

/**
 * Mark the directory owner's pending user completions delivered; returns per-run
 * outcome labels.
 *
 * Only runs attributable to `taskId` are touched. A copy-ignored worktree holds
 * the primary checkout's manifests, and marking another bead's completion
 * delivered would be a write to foreign state that also swallows that bead's own
 * recovery (bd-242 review). The child's runs are skipped: they belong to the
 * orchestrator that owns them now.
 */
export function markPendingCompletionsDelivered(options: {
  cwd: string;
  /** The directory owner's bead; nothing outside it may be settled. */
  taskId: string;
  /** Runs for this task belong to the child orchestrator; leave them alone. */
  skipTaskId: string;
}): { delivered: string[]; undeliverable: string[] } {
  const delivered: string[] = [];
  const undeliverable: string[] = [];
  const pending = listPendingUserCompletions({ cwd: options.cwd, taskId: options.taskId });
  for (const run of pending) {
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
export function formatHandoffPendingNotice(options: {
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
export function abortActiveRuns(state: CoreSessionState): void {
  for (const { abortController } of state.activeRuns.values()) {
    abortController.abort();
  }
  state.activeRuns.clear();
}

/** Forget delivered-run and active-run bookkeeping without aborting anything. */
export function resetRunTracking(state: CoreSessionState): void {
  state.deliveredRunIds.clear();
  state.activeRuns.clear();
}

/** Abort every active background run, then forget run bookkeeping. */
export function abortAndResetRunTracking(state: CoreSessionState): void {
  abortActiveRuns(state);
  // Invalidate the aborted runs' watchers: they must not deliver or mutate
  // state after the teardown (see SessionState.runEpoch).
  state.runEpoch += 1;
  state.deliveredRunIds.clear();
}
