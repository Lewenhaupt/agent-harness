/**
 * Human-gate capability: `belayd_ask_human`, the human-answer poll/detection
 * and settlement, and gate reaping (bd-179, bd-152).
 *
 * The bd `human` gate is the durable wait; this module owns the in-memory
 * mirror, the polling timer and the turn-start fallback. Only the session reader
 * and the beads-actor resolver are composer-supplied.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  commentTimeInMs,
  excerptComment,
  isHumanComment,
  lookupBeadComments,
  phaseCommentBody,
} from "../../src/bead-comments.js";
import {
  buildGateCreateArgv,
  buildGateResolveArgv,
  lookupOpenHumanGate,
  parseCreatedGateId,
} from "../../src/bead-gates.js";
import { orchestratorActor, withActorArgv } from "../../src/beads-actor.js";
import {
  buildReviewFindingsRecord,
  formatReviewFindingsComment,
  nextReviewRound,
  reviewFindingsGateTitle,
  writeReviewFindingsRecord,
} from "../../src/review-findings.js";
import { isValidTaskId } from "../../src/session-naming.js";
import type { AwaitingHuman } from "../../src/workflow-phases.js";
import { type CoreSessionState, errorText, runBdCommand, textToolResult } from "./context.js";

/** Composer-supplied seams: the session store and the beads-actor resolver. */
export interface HumanGateDeps {
  getSessionState: (ctx: { sessionManager: { getSessionId: () => string } }) => CoreSessionState;
  resolveSessionBdActor: (ctx: unknown) => string | undefined;
  /** Deliver a detected answer as a real user turn. */
  sendUserMessage: (text: string) => void;
}

/**
 * The next-step block, or nothing while a human answer is pending.
 *
 * Split out of {@link gateContextMessage} so the prompt builder stays under the
 * complexity limit, and because "no next step" is the whole rule: a waiting
 * workflow must not be told to call a phase tool the gate will refuse.
 */
export function nextStepBlockLines(state: CoreSessionState, nextStepLine: string): string[] {
  return state.awaitingHuman === undefined ? ["", nextStepLine] : [];
}

/**
 * Prompt guidance for the human answer channel (bd-152).
 *
 * The ask line is unconditional: the one moment the orchestrator needs
 * `belayd_ask_human` is the moment it feels blocked, which is exactly when an
 * advisory note is not read unless it has been repeated every turn. The wait
 * block replaces the "call belayd_X" next step, because a refused tool with no
 * explanation is what makes a model retry or guess instead of waiting.
 */
export function humanAnswerGuidanceLines(state: CoreSessionState): string[] {
  const lines = [
    "",
    "**Blocked on a human decision?** Call `belayd_ask_human` with the question, then END YOUR TURN: it posts the question as a bd comment, opens a `human` gate, and refuses every phase tool until an answer arrives. Never guess and never proceed without the answer.",
  ];
  const awaiting = state.awaitingHuman;
  if (awaiting === undefined) return lines;
  lines.push(
    "",
    `⏸ **Waiting for a human answer on ${awaiting.beadId}** — phase tools are refused until the answer arrives.`,
    `Asked ${formatAskedAt(awaiting.askedAt)}. Reply on the bead (bd comment ${awaiting.beadId} --stdin, or in Scotty); the answer arrives in this session as a user message.`,
  );
  return lines;
}

/** Human-readable ask time; a corrupt timestamp must not throw in a prompt. */
export function formatAskedAt(askedAt: number): string {
  return Number.isFinite(askedAt) ? new Date(askedAt).toISOString() : "recently";
}

// ── Human answer channel (bd-152) ────────────────────────────────────
//
// A workflow blocked on a human used to be a dead end: the tool posts the
// question as an authored bd comment and opens a `human` gate, and this poll
// turns the first non-`belayd:` comment on the bead into a real user turn.
// The bd gate is the durable state (`bd gate list`), so a restart re-discovers
// the wait, and the timer is armed only while a question is open — the cost is
// bounded by open questions, normally 0–1.

/** How often an open question re-reads its gate and comments. */
const HUMAN_ANSWER_POLL_INTERVAL_MS = 30_000;

/**
 * True for a phase sub-agent session (`-sub-` marker from
 * `computeSubagentSessionName`).
 *
 * Sub-agents share their orchestrator's worktree and bead but must never act
 * for it (no gate arming, no fleet drain, no human-answer poll), so this one
 * heuristic is named once instead of being re-derived at each call site.
 */
export function isSubAgentSession(sessionName: string | undefined): boolean {
  return sessionName?.includes("-sub-") === true;
}

/**
 * Arm the self-poll. Mirrors the orchestrator lease heartbeat: the timer runs
 * in the session daemon while the session is idle, and `unref()` keeps a pi
 * process from living just to wait for an answer.
 */
export function startHumanAnswerPoll(
  state: CoreSessionState,
  ctx: ExtensionContext,
  deps: HumanGateDeps,
): void {
  stopHumanAnswerPoll(state);
  // A phase sub-agent shares its orchestrator's worktree and bead, so arming a
  // poll there would deliver the answer into a session that cannot act on it.
  if (isSubAgentSession(ctx.sessionManager.getSessionName())) return;
  const timer = setInterval(() => {
    void pollHumanAnswerOnce(state, ctx, deps).catch((error: unknown) => {
      console.warn(`[belayd-harness] human answer poll failed: ${errorText(error)}`);
    });
  }, HUMAN_ANSWER_POLL_INTERVAL_MS);
  timer.unref();
  state.humanAnswerTimer = timer;
}

export function stopHumanAnswerPoll(state: CoreSessionState): void {
  if (state.humanAnswerTimer === undefined) return;
  clearInterval(state.humanAnswerTimer);
  state.humanAnswerTimer = undefined;
}

/** Drop the in-memory wait and its timer; the bd gate is resolved separately. */
export function clearHumanAnswerWait(state: CoreSessionState): void {
  stopHumanAnswerPoll(state);
  state.awaitingHuman = undefined;
  // A new question deserves its own warning budget.
  state.humanAnswerWarned = false;
}

/** What one gate + comment read says about the open question. */
type HumanAnswerObservation =
  | { kind: "pending" }
  | { kind: "unknown" }
  | { kind: "resolved" }
  | { kind: "answered"; author: string; text: string };

/** Observations that carry something worth delivering. */
type DeliverableObservation = Extract<HumanAnswerObservation, { kind: "resolved" | "answered" }>;

function isDeliverable(observed: HumanAnswerObservation): observed is DeliverableObservation {
  return observed.kind === "resolved" || observed.kind === "answered";
}

/**
 * Read the gate and the thread and decide whether an answer exists.
 *
 * Fail closed: only `status: "open"` (then read the thread) and `status:
 * "none"` (the gate really is gone) can settle the wait. An `unrecognized`
 * gate record — renamed `status`/`await_type`, a timer gate, a malformed
 * entry — and a failed read both keep it armed, because "bd changed its JSON"
 * must never look like "a human answered".
 */
async function observeHumanAnswer(
  state: CoreSessionState,
  awaiting: AwaitingHuman & { gateId?: string },
  cwd: string,
): Promise<HumanAnswerObservation> {
  const gate = await lookupOpenHumanGate({ beadId: awaiting.beadId, cwd, runBd: runBdCommand });
  if (!gate.ok) return { kind: "unknown" };
  if (gate.status === "unrecognized") {
    warnUnrecognizedHumanGate(state, awaiting.beadId);
    return { kind: "unknown" };
  }
  if (gate.status === "none") return { kind: "resolved" };

  const comments = await lookupBeadComments({
    beadId: awaiting.beadId,
    cwd,
    runBd: runBdCommand,
  });
  if (!comments.ok) return { kind: "unknown" };

  // The gate's creation time is the baseline: it is written by bd itself, so a
  // restart loses nothing (the old design had to persist the comment id). bd
  // timestamps have second granularity, hence `>=` — a human answering in the
  // same second the question was asked is still an answer.
  const gateTime = gate.gate.createdAt === undefined ? Number.NaN : Date.parse(gate.gate.createdAt);
  const baseline = Number.isFinite(gateTime) ? gateTime : awaiting.askedAt;
  const answer = comments.comments.find(
    (comment) => isHumanComment(comment) && commentTimeInMs(comment) >= baseline,
  );
  if (answer === undefined) return { kind: "pending" };
  return { kind: "answered", author: answer.author, text: answer.text };
}

/** Say once per wait that bd's gate JSON no longer parses; never spam the poll. */
function warnUnrecognizedHumanGate(state: CoreSessionState, beadId: string): void {
  if (state.humanAnswerWarned === true) return;
  state.humanAnswerWarned = true;
  console.warn(
    `[belayd-harness] bd reported gates for ${beadId} that are not open human gates; ` +
      "the human wait stays armed (bd gate JSON may have changed).",
  );
}

/** A detected answer plus the wait it belongs to. */
interface DetectedHumanAnswer {
  awaiting: AwaitingHuman & { gateId?: string };
  message: string;
}

/**
 * Detect an answer and claim its delivery, without delivering anything yet.
 *
 * The claim (a per-session flag) is what stops the poll timer and the
 * turn-start fallback from both delivering: the first caller holds it until it
 * settles (success) or releases it (nothing deliverable, failed send). The
 * wait is NOT cleared here — clearing before the send is what used to lose an
 * answer when `sendUserMessage` threw.
 */
export async function claimHumanAnswer(
  state: CoreSessionState,
  ctx: ExtensionContext,
): Promise<DetectedHumanAnswer | undefined> {
  const awaiting = state.awaitingHuman;
  if (awaiting === undefined) return undefined;
  if (state.humanAnswerClaimed === true) return undefined;
  state.humanAnswerClaimed = true;
  try {
    const observed = await observeHumanAnswer(state, awaiting, ctx.cwd);
    if (isDeliverable(observed) && state.awaitingHuman === awaiting) {
      return { awaiting, message: humanAnswerText(awaiting, observed) };
    }
  } catch (error) {
    console.warn(`[belayd-harness] human answer check failed: ${errorText(error)}`);
  }
  state.humanAnswerClaimed = false;
  return undefined;
}

/** The message a delivered answer (or an out-of-band gate resolve) becomes. */
function humanAnswerText(
  awaiting: AwaitingHuman & { gateId?: string },
  observed: DeliverableObservation,
): string {
  if (observed.kind === "resolved") {
    return `The human gate on ${awaiting.beadId} was resolved without a comment; you may proceed.`;
  }
  return `${observed.author} answered: ${excerptComment(observed.text)}`;
}

/**
 * Settle a delivered answer: clear the wait, stop the timer, resolve the gate.
 *
 * Called only after the delivery succeeded (or, at turn start, immediately
 * before returning the message that IS the delivery), so an unblocked workflow
 * and a resolved gate always mean the answer actually reached the session.
 */
async function settleHumanAnswer(options: {
  state: CoreSessionState;
  ctx: ExtensionContext;
  awaiting: AwaitingHuman & { gateId?: string };
  deps: HumanGateDeps;
}): Promise<void> {
  try {
    clearHumanAnswerWait(options.state);
    await resolveHumanGate({
      awaiting: options.awaiting,
      ctx: options.ctx,
      deps: options.deps,
    });
  } finally {
    options.state.humanAnswerClaimed = false;
  }
}

/**
 * Resolve the human gate after an answer (or on teardown).
 *
 * Reports whether the gate is actually gone: the ask tool's compensation path
 * must keep the wait armed when it is not, so a failed resolve cannot leave an
 * open gate with nobody watching it. A failure here after a successful delivery
 * is only logged — the answer already reached the session, and a restart
 * re-discovers the still-open gate.
 */
async function resolveHumanGate(options: {
  awaiting: AwaitingHuman & { gateId?: string };
  ctx: ExtensionContext;
  deps: HumanGateDeps;
}): Promise<{ resolved: boolean; error?: string }> {
  const gateId = await findHumanGateId(options.awaiting, options.ctx.cwd);
  if (gateId === undefined) {
    return {
      resolved: false,
      error: `no open human gate found for ${options.awaiting.beadId}`,
    };
  }
  const actor =
    options.deps.resolveSessionBdActor(options.ctx) ?? orchestratorActor(options.awaiting.beadId);
  try {
    await runBdCommand(withActorArgv(buildGateResolveArgv(gateId), actor), {
      cwd: options.ctx.cwd,
      stdin: undefined,
      timeoutInMs: 15_000,
      maxBufferInBytes: 1024 * 1024,
    });
    return { resolved: true };
  } catch (error) {
    const detail = errorText(error);
    console.warn(
      `[belayd-harness] could not resolve the human gate ${gateId} on ${options.awaiting.beadId}: ${detail}`,
    );
    return { resolved: false, error: detail };
  }
}

/** The wait's gate id, re-read from the bead when `bd gate create` did not name it. */
async function findHumanGateId(
  awaiting: AwaitingHuman & { gateId?: string },
  cwd: string,
): Promise<string | undefined> {
  if (awaiting.gateId !== undefined) return awaiting.gateId;
  const found = await lookupOpenHumanGate({ beadId: awaiting.beadId, cwd, runBd: runBdCommand });
  return found.ok && found.status === "open" ? found.gate.gateId : undefined;
}

/**
 * One poll tick: detect, own, deliver, THEN settle.
 *
 * The send comes first on purpose. A failed send releases the claim and leaves
 * the wait armed, so the next tick retries and the gate stays open as the
 * durable record of the unanswered question.
 */
async function pollHumanAnswerOnce(
  state: CoreSessionState,
  ctx: ExtensionContext,
  deps: HumanGateDeps,
): Promise<void> {
  if (state.awaitingHuman === undefined) {
    stopHumanAnswerPoll(state);
    return;
  }
  const detected = await claimHumanAnswer(state, ctx);
  if (detected === undefined) return;
  if (!sendHumanAnswer(detected.message, deps)) {
    state.humanAnswerClaimed = false;
    return;
  }
  await settleHumanAnswer({ state, ctx, awaiting: detected.awaiting, deps });
}

/**
 * Deliver a detected answer as a real user turn (bd-148: no triggerTurn needed).
 * Returns whether the session accepted it, so the caller can retry later.
 */
function sendHumanAnswer(text: string, deps: HumanGateDeps): boolean {
  try {
    deps.sendUserMessage(text);
    return true;
  } catch (error) {
    console.warn(`[belayd-harness] could not deliver a human answer: ${errorText(error)}`);
    return false;
  }
}

/**
 * Turn-start fallback for the self-poll.
 *
 * The timer needs the session daemon to keep running; when that route is not
 * available the next turn still injects the answer. Both paths share the claim,
 * so the answer is delivered exactly once either way; here the returned message
 * IS the delivery, so the wait settles before returning.
 */
export async function humanAnswerMessage(
  ctx: ExtensionContext,
  deps: HumanGateDeps,
): Promise<{ message: { customType: string; content: string; display: boolean } } | undefined> {
  const state = deps.getSessionState(ctx);
  const detected = await claimHumanAnswer(state, ctx);
  if (detected === undefined) return undefined;
  await settleHumanAnswer({ state, ctx, awaiting: detected.awaiting, deps });
  return {
    message: { customType: "belayd-human-answer", content: detected.message, display: true },
  };
}

/**
 * Re-arm the wait after a restart (bd-152): the bd gate IS the durable state.
 *
 * One read of the active bead's gates restores exactly what the dropped marker
 * file would have stored, so nothing persistent is written and no stale marker
 * can survive a workflow that already ended.
 */
export function discoverHumanAnswerWait(options: {
  ctx: ExtensionContext;
  state: CoreSessionState;
  deps: HumanGateDeps;
}): void {
  const { ctx, state } = options;
  if (!state.gateActive || state.awaitingHuman !== undefined) return;
  const beadId = state.currentTaskId;
  if (beadId === "") return;
  void (async () => {
    const found = await lookupOpenHumanGate({ beadId, cwd: ctx.cwd, runBd: runBdCommand });
    // Only a real open human gate re-arms the wait: `unrecognized` records are
    // not a wait the poll could ever answer (bd-152 fail-closed).
    if (!found.ok || found.status !== "open") return;
    // The workflow may have been torn down while the read was in flight.
    if (!state.gateActive || state.awaitingHuman !== undefined) return;
    state.awaitingHuman = { beadId, gateId: found.gate.gateId, askedAt: Date.now() };
    startHumanAnswerPoll(state, ctx, options.deps);
  })().catch((error: unknown) => {
    console.warn(`[belayd-harness] human gate discovery failed: ${errorText(error)}`);
  });
}

/**
 * Resolve a torn-down workflow's human gate (bd-152).
 *
 * An orphan gate keeps the bead blocked in bd/Scotty long after the workflow
 * stopped, so the gate goes with the workflow. Best-effort and bounded: a
 * teardown must never fail because bd did.
 */
export async function reapHumanGateForTask(options: {
  ctx: ExtensionContext;
  state: CoreSessionState;
  beadId: string;
  deps: HumanGateDeps;
}): Promise<void> {
  const awaiting = options.state.awaitingHuman;
  clearHumanAnswerWait(options.state);
  if (options.beadId === "") return;
  if (awaiting !== undefined && awaiting.beadId !== options.beadId) return;
  await resolveHumanGate({
    awaiting: awaiting ?? { beadId: options.beadId, askedAt: Date.now() },
    ctx: options.ctx,
    deps: options.deps,
  });
}

/**
 * Implement `belayd_ask_human`: gate + authored question, then stop.
 *
 * Two bd writes, deliberately NOT through the `bd` proxy: argv validation only
 * inspects `argv[0]`, so allowing `gate` there would expose the whole gate
 * lifecycle (src/bd-command.ts). Order matters — the gate is created first, so
 * the wait is visible in bd/Scotty even if the comment write fails; the comment
 * carries the question and is authored by the workflow actor, which is what
 * keeps it from ever counting as the answer.
 */
async function askHuman(options: {
  params: { question?: string; beadId?: string };
  ctx: ExtensionContext;
  deps: HumanGateDeps;
}): Promise<ReturnType<typeof textToolResult>> {
  const { ctx, deps } = options;
  const state = deps.getSessionState(ctx);
  const target = resolveAskTarget(options.params, state);
  if (!target.ok) return textToolResult(target.error, target.exitCode);
  if (state.awaitingHuman !== undefined) {
    return textToolResult(
      `Already waiting for a human answer on ${state.awaitingHuman.beadId} — END YOUR TURN.`,
      0,
    );
  }

  const actor = deps.resolveSessionBdActor(ctx) ?? orchestratorActor(target.taskId);
  const created = await createHumanGate({
    taskId: target.taskId,
    question: target.question,
    actor,
    ctx,
  });
  if (!created.ok) {
    // No gate means no wait: leave awaitingHuman unset so the workflow is not
    // blocked on a gate bd never created.
    return textToolResult(`belayd_ask_human: could not open a human gate: ${created.error}`, 1);
  }
  const awaiting: AwaitingHuman & { gateId?: string } = {
    beadId: target.taskId,
    askedAt: Date.now(),
    ...(created.gateId === undefined ? {} : { gateId: created.gateId }),
  };

  const posted = await runBdResult(
    withActorArgv(["comment", "--stdin", "--", target.taskId], actor),
    { cwd: ctx.cwd, stdin: target.question },
  );
  if (!posted.ok) {
    // An unasked question must not leave an orphan gate blocking the bead. When
    // the compensation also fails the gate is genuinely open (that is usually
    // why both writes failed), so the wait stays armed: the poll keeps watching
    // the bead, and a teardown reaps the gate instead of leaving it orphaned.
    const cleaned = await resolveHumanGate({ awaiting, ctx, deps: options.deps });
    if (!cleaned.resolved) {
      state.awaitingHuman = awaiting;
      startHumanAnswerPoll(state, ctx, options.deps);
      return textToolResult(
        [
          `belayd_ask_human: could not post the question as a bd comment (${posted.error}).`,
          `Resolving the gate it created also failed (${cleaned.error ?? "unknown error"}).`,
          "The bead may be left blocked by an open human gate and the question may not be posted.",
          `Check with bd gate list ${target.taskId}, resolve it with bd gate resolve <gate>, or retry.`,
        ].join(" "),
        1,
      );
    }
    return textToolResult(
      `belayd_ask_human: could not post the question as a bd comment: ${posted.error}`,
      1,
    );
  }

  state.awaitingHuman = awaiting;
  startHumanAnswerPoll(state, ctx, deps);
  return textToolResult(askResultText({ taskId: target.taskId, gateId: created.gateId }), 0);
}

/**
 * Upper bound on one question: it is interpolated into `bd gate create
 * --reason` argv, which bd/posix caps well below a comment body, so an
 * over-long question fails here with a clear message instead of at spawn.
 */
const ASK_HUMAN_QUESTION_MAX_CHARS = 2_000;

/** Validate the ask target: a trimmed question plus the bead it concerns. */
function resolveAskTarget(
  params: { question?: string; beadId?: string },
  state: CoreSessionState,
): { ok: true; taskId: string; question: string } | { ok: false; error: string; exitCode: number } {
  const question = (params.question ?? "").trim();
  if (question === "") {
    return {
      ok: false,
      exitCode: 1,
      error: "belayd_ask_human: the question is empty — ask something answerable in a comment.",
    };
  }
  if (question.includes("\u0000")) {
    return {
      ok: false,
      exitCode: 1,
      error: "belayd_ask_human: the question must not contain NUL bytes.",
    };
  }
  if (question.length > ASK_HUMAN_QUESTION_MAX_CHARS) {
    return {
      ok: false,
      exitCode: 1,
      error:
        `belayd_ask_human: the question is ${question.length} characters; keep it under ` +
        `${ASK_HUMAN_QUESTION_MAX_CHARS} so it fits bd gate create --reason ` +
        "(summarize the question and put the details in a bead note).",
    };
  }
  const taskId = (params.beadId ?? "").trim() || state.currentTaskId;
  if (taskId === "" || !isValidTaskId(taskId)) {
    return {
      ok: false,
      exitCode: 1,
      error:
        "belayd_ask_human: no bead to ask about. It needs an active workflow, or an explicit beadId.",
    };
  }
  return { ok: true, taskId, question };
}

/** Create the `human` bd gate for one question. */
async function createHumanGate(options: {
  taskId: string;
  question: string;
  actor: string;
  /** Custom gate title; bd's default says nothing about which wait this is. */
  title?: string;
  ctx: { cwd: string };
}): Promise<{ ok: true; gateId?: string } | { ok: false; error: string }> {
  const created = await runBdResult(
    withActorArgv(
      [
        ...buildGateCreateArgv({
          beadId: options.taskId,
          reason: options.question,
          ...(options.title === undefined ? {} : { title: options.title }),
        }),
        "--json",
      ],
      options.actor,
    ),
    { cwd: options.ctx.cwd, stdin: undefined },
  );
  if (!created.ok) return { ok: false, error: created.error };
  const gateId = parseCreatedGateId(created.stdout, options.taskId);
  return gateId === undefined ? { ok: true } : { ok: true, gateId };
}

/** What the orchestrator is told after a question was asked. */
function askResultText(options: { taskId: string; gateId?: string }): string {
  const gate = options.gateId === undefined ? "" : ` (gate ${options.gateId})`;
  const lines = [
    `Asked a human on ${options.taskId}${gate}.`,
    "The bead is blocked by a `human` gate and every phase tool is REFUSED until an answer arrives.",
    "END YOUR TURN NOW — do not guess, do not proceed, do not call another phase tool. The answer arrives as a user message.",
  ];
  if (options.gateId === undefined) {
    lines.push("Note: bd did not report the gate id; the poll re-reads the gate from the bead.");
  }
  return lines.join("\n");
}

/**
 * Turn a review that reported findings into the same human wait `belayd_ask_human`
 * opens (bd-175).
 *
 * Three writes, in this order: the gate first (so the wait is visible in
 * bd/Scotty even if a later write fails), then the durable disposition record
 * (only once the gate exists — a record with no gate would claim a wait bd and
 * the fix loop cannot see), then the findings comment authored by the workflow
 * actor (so it can never count as the human's answer).
 *
 * The wait is reserved synchronously before the first `await` via
 * `state.reviewGatePending`, so two review deliveries settling concurrently
 * cannot both pass the check and open two gates. The pending marker is never
 * exposed as `awaitingHuman`: the gate does not exist yet, and the answer poll
 * would read the empty gate list as "the human resolved it". The marker is
 * released in a `finally` that touches nothing else, so even a throw inside the
 * gated section cannot strand it — nor can it unblock a gate that already exists.
 *
 * Called from the review phase's completion delivery, so a non-empty review
 * stops the member on a *findable* wait: the gate blocks the bead, `needs-you`
 * views list it, and resolving it (or answering in a comment) resumes the
 * member through the existing answer poll.
 */
export async function openReviewHumanGate(options: {
  state: CoreSessionState;
  ctx: ExtensionContext;
  deps: HumanGateDeps;
  taskId: string;
  reviewText: string;
}): Promise<{ opened: boolean; reason: string }> {
  const { state } = options;
  if (state.awaitingHuman !== undefined) {
    return { opened: false, reason: `already waiting on ${state.awaitingHuman.beadId}` };
  }
  if (state.reviewGatePending === true) {
    return { opened: false, reason: "a review gate is already being opened" };
  }
  // Same guard `resolveAskTarget` applies to the ask path: a crafted task id must
  // never reach `orchestratorActor` or a bd argv.
  if (!isValidTaskId(options.taskId)) {
    return { opened: false, reason: `invalid task id "${options.taskId}"` };
  }
  const record = buildReviewFindingsRecord({
    taskId: options.taskId,
    text: options.reviewText,
    round: nextReviewRound({ cwd: options.ctx.cwd }),
  });
  if (record === undefined) {
    return { opened: false, reason: "the review reported no findings" };
  }

  const actor =
    options.deps.resolveSessionBdActor(options.ctx) ?? orchestratorActor(options.taskId);
  // Reserve synchronously so a concurrent delivery bails at the check above
  // instead of racing this one to a second gate. `reviewGatePending`, not
  // `awaitingHuman`, because the gate does not exist yet.
  const askedAt = Date.now();
  state.reviewGatePending = true;
  try {
    const created = await createHumanGate({
      taskId: options.taskId,
      question: record.reason,
      actor,
      title: reviewFindingsGateTitle({ taskId: options.taskId, round: record.round }),
      ctx: options.ctx,
    });
    if (!created.ok) {
      return { opened: false, reason: `could not open a human gate: ${created.error}` };
    }
    state.awaitingHuman = {
      beadId: options.taskId,
      askedAt,
      ...(created.gateId === undefined ? {} : { gateId: created.gateId }),
    };

    const written = writeReviewFindingsRecord({ cwd: options.ctx.cwd, record });
    if (!written.ok) {
      console.warn(`[belayd-harness] could not record the review findings: ${written.error}`);
    }

    // A failed comment must not remove the gate: the gate's reason is itself the
    // visible wait, so the member stays stopped on a findable record either way.
    const posted = await runBdResult(
      withActorArgv(["comment", "--stdin", "--", options.taskId], actor),
      {
        cwd: options.ctx.cwd,
        stdin: phaseCommentBody("review", formatReviewFindingsComment(record)),
      },
    );
    if (!posted.ok) {
      console.warn(`[belayd-harness] could not post the review findings comment: ${posted.error}`);
    }

    startHumanAnswerPoll(state, options.ctx, options.deps);
    return { opened: true, reason: record.reason };
  } finally {
    // Only the reservation is released here. `awaitingHuman` is the wait itself
    // and must survive a throw: clearing it in `finally` would silently unblock a
    // member whose gate is already open and visible in bd.
    state.reviewGatePending = undefined;
  }
}

/** `runBdCommand` as an error value, so tool handlers never throw on bd. */
async function runBdResult(
  argv: readonly string[],
  options: { cwd: string; stdin: string | undefined },
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }> {
  try {
    const result = await runBdCommand(argv, {
      ...options,
      timeoutInMs: 15_000,
      maxBufferInBytes: 1024 * 1024,
    });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** Register `belayd_ask_human`; the composer supplies the pi API and state seams. */
export function registerHumanGate(pi: ExtensionAPI, deps: HumanGateDeps): void {
  // Orchestrator-only and deliberately gate-free: this is the one action a
  // blocked workflow must still be able to take. It is in
  // WORKFLOW_CONTROL_TOOLS so a gated session can see it at the blocked moment.
  pi.registerTool({
    name: "belayd_ask_human",
    label: "Ask a human",
    description:
      "Stop and ask a human a question about the current bead. Posts the question as a bd " +
      "comment, opens a `human` bd gate that blocks the bead, and refuses every phase tool " +
      "until someone answers (a comment authored by anyone other than belayd:*). The answer " +
      "arrives in this session as a user message. Use this instead of guessing when the work " +
      "is blocked on a decision only a human can make; END YOUR TURN after calling it.",
    parameters: Type.Object({
      question: Type.String({
        description:
          "The question, with the options you are choosing between (answerable in a comment)",
      }),
      beadId: Type.Optional(
        Type.String({ description: "Bead to ask about (default: the active workflow's bead)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return askHuman({ params, ctx: ctx as ExtensionContext, deps });
    },
  });
}
