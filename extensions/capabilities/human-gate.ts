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
  lookupResolvedHumanGate,
  parseCreatedGateId,
} from "../../src/bead-gates.js";
import { orchestratorActor, withActorArgv } from "../../src/beads-actor.js";
import { parsePublicationAnswer } from "../../src/finding-sensitivity.js";
import type { GithubAnswerTarget, HumanAnswerChannel } from "../../src/github-answer-target.js";
import {
  type AuthenticatedLoginLookup,
  harnessGithubLogins,
  lookupAuthenticatedLogin,
  lookupIssueComments,
  postIssueComment,
  selectHumanAnswer,
} from "../../src/github-comments.js";
import {
  buildReviewFindingsRecord,
  carryForwardSensitivity,
  formatReviewFindingsComment,
  hasSensitiveFindings,
  isReviewFindingsGateTitle,
  nextReviewRound,
  type PublicationAnswerRefusalCause,
  REVIEW_FINDINGS_RECORD_RELATIVE_PATH,
  REVIEW_GATE_FAILURE_PREFIX,
  REVIEW_NO_FINDINGS_REASON,
  type ReviewFindingsRecord,
  readReviewFindingsRecord,
  recordPublicationAnswer,
  releasedPublicationIn,
  reviewFindingsGateReason,
  reviewFindingsGateTitle,
  writeReviewFindingsRecord,
} from "../../src/review-findings.js";
import { isValidTaskId } from "../../src/session-naming.js";
import type { AwaitingHuman } from "../../src/workflow-phases.js";
import {
  type CoreSessionState,
  errorText,
  runBdCommand,
  runGhCommand,
  textToolResult,
} from "./context.js";
import { HUMAN_ESCALATION_LINES } from "./review.js";

/** Composer-supplied seams: the session store and the beads-actor resolver. */
export interface HumanGateDeps {
  getSessionState: (ctx: { sessionManager: { getSessionId: () => string } }) => CoreSessionState;
  resolveSessionBdActor: (ctx: unknown) => string | undefined;
  /**
   * Which channel answers a bead's question (bd-182). Synchronous because every
   * reader it wraps is, and it runs on the 30 s poll as well as at ask time.
   */
  resolveGithubAnswerTarget: (ctx: { cwd?: string }, beadId: string) => GithubAnswerTarget;
  /** Deliver a detected answer as a real user turn. */
  sendUserMessage: (text: string) => void;
}

/**
 * The in-memory mirror of one open wait.
 *
 * `channel` records where the question actually went, so the waiting guidance
 * names the real place to answer instead of promising a bd comment on a
 * GitHub-primary repo. The bd gate stays the durable state either way.
 */
export interface HumanAnswerWait extends AwaitingHuman {
  gateId?: string;
  channel?: HumanAnswerChannel;
  /** The comment the harness itself posted; never an answer. */
  answerCommentId?: string;
  /**
   * The authenticated `gh` identity, cached for this wait once it resolves.
   *
   * In-memory only: a restart legitimately re-resolves it, and one wait must not
   * see two different harness identities mid-flight (bd-182 review S1). Only a
   * successful lookup is stored — a failure is retried on the next claim cycle
   * so one transient `gh` blip is not a wait that only a restart can answer.
   */
  harnessIdentity?: AuthenticatedLoginLookup;
  /**
   * The operator's bot-login allowlist, resolved once for this wait.
   *
   * In-memory only, like {@link harnessIdentity}: a restart re-reads the
   * environment, but one wait never sees two different allowlists (bd-182 W5).
   */
  harnessBotLogins?: readonly string[];
}

/** The channel a resolved target maps to; an unusable target falls back to bd. */
function channelOf(target: GithubAnswerTarget): HumanAnswerChannel {
  if (target.kind === "github") {
    return { kind: "github", owner: target.owner, repo: target.repo, issue: target.issue };
  }
  return { kind: "bd" };
}

/** Human wording for an error that names where the question was meant to go. */
function channelLabel(channel: HumanAnswerChannel): string {
  if (channel.kind === "github") {
    return `on GitHub issue #${channel.issue.toString()} (${channel.owner}/${channel.repo})`;
  }
  return "as a bd comment";
}

/**
 * The next-step block, or nothing while a blocking human answer is pending.
 *
 * Split out of {@link gateContextMessage} so the prompt builder stays under the
 * complexity limit, and because "no next step" is the whole rule: a waiting
 * workflow must not be told to call a phase tool the gate will refuse. A
 * publication-only wait (bd-252) refuses nothing, so it keeps the next step.
 */
export function nextStepBlockLines(state: CoreSessionState, nextStepLine: string): string[] {
  const blockingWait =
    state.awaitingHuman !== undefined && state.awaitingHuman.publicationOnly !== true;
  return blockingWait ? [] : ["", nextStepLine];
}

/**
 * Prompt guidance for the human answer channel (bd-152, bd-182, bd-219, bd-252).
 *
 * The ask line is the shared two-condition policy, repeated every turn because
 * the model reads it exactly when it feels blocked — which is the moment it is
 * tempted to gate instead of fixing what it can fix (bd-219). The wait block
 * replaces the "call belayd_X" next step, because a refused tool with no
 * explanation is what makes a model retry or guess instead of waiting. The reply
 * line names the real channel, so a GitHub-primary wait never tells anyone to
 * answer in a place its poll does not read.
 *
 * A publication-only wait (bd-252) says what is true: the PR-body question is
 * pending and the workflow continues; it must not claim phase tools are refused.
 */
export function humanAnswerGuidanceLines(state: CoreSessionState): string[] {
  const lines = ["", ...HUMAN_ESCALATION_LINES];
  const awaiting = state.awaitingHuman;
  if (awaiting === undefined) return lines;
  if (awaiting.publicationOnly === true) {
    lines.push(
      "",
      `📝 **Publication choice pending for ${awaiting.beadId}** — sensitive review findings stay withheld from any PR body until it is answered; the workflow continues.`,
      `Asked ${formatAskedAt(awaiting.askedAt)}. ${replyChannelLine(awaiting)}; the answer arrives in this session as a user message.`,
    );
    return lines;
  }
  lines.push(
    "",
    `⏸ **Waiting for a human answer on ${awaiting.beadId}** — phase tools are refused until the answer arrives.`,
    `Asked ${formatAskedAt(awaiting.askedAt)}. ${replyChannelLine(awaiting)}; the answer arrives in this session as a user message.`,
  );
  return lines;
}

/** Where to answer, in the words a person can act on. */
function replyChannelLine(awaiting: HumanAnswerWait): string {
  if (awaiting.channel?.kind === "github") {
    return `Reply on GitHub issue #${awaiting.channel.issue.toString()} (${awaiting.channel.owner}/${awaiting.channel.repo})`;
  }
  return `Reply on the bead (bd comment ${awaiting.beadId} --stdin, or in Scotty)`;
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
  // A new question deserves its own warning budgets; the flags are separate so
  // one diagnosis (a failed read) cannot mute another (a malformed gate), and
  // the identity warning has its own flag again.
  state.humanAnswerWarned = false;
  state.humanUnrecognizedGateWarned = false;
  state.humanAnswerDroppedWarned = false;
  state.harnessIdentityWarned = false;
}

/** What one gate + comment read says about the open question. */
type HumanAnswerObservation =
  | { kind: "pending" }
  | { kind: "unknown" }
  /** `note` is the text the resolver left behind when the gate was closed, if any. */
  | { kind: "resolved"; note?: string }
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
  awaiting: HumanAnswerWait,
  cwd: string,
  deps: HumanGateDeps,
): Promise<HumanAnswerObservation> {
  const gate = await lookupOpenHumanGate({ beadId: awaiting.beadId, cwd, runBd: runBdCommand });
  if (!gate.ok) return { kind: "unknown" };
  if (gate.status === "unrecognized") {
    warnUnrecognizedHumanGate(state, awaiting.beadId);
    return { kind: "unknown" };
  }
  if (gate.status === "none") return resolvedObservation(awaiting, cwd);

  // The gate's creation time is the baseline: it is written by bd itself, so a
  // restart loses nothing (the old design had to persist the comment id). bd
  // timestamps have second granularity, hence `>=` — a human answering in the
  // same second the question was asked is still an answer.
  const gateTime = gate.gate.createdAt === undefined ? Number.NaN : Date.parse(gate.gate.createdAt);
  const baseline = Number.isFinite(gateTime) ? gateTime : awaiting.askedAt;
  // Read off the wait's recorded channel. Re-resolving every tick used to let a
  // later broken map override where the question was actually posted (bd-182
  // review C1), leaving a bd-answerable wait that the poll never read.
  const channel = awaiting.channel ?? resolveChannel(state, awaiting, cwd, deps);
  if (channel === undefined) return { kind: "unknown" };
  if (channel.kind === "bd") return observeBeadAnswer(awaiting.beadId, baseline, cwd);
  return observeGithubAnswer({ state, awaiting, channel, baseline, cwd });
}

/**
 * Resolve and record the channel for a wait that predates the channel field.
 *
 * Only a usable target is recorded: `unmapped`/`unknown` keeps failing closed
 * (the caller must not start reading a different thread just because a map went
 * bad). A recorded channel is never replaced by a later resolution.
 */
function resolveChannel(
  state: CoreSessionState,
  awaiting: HumanAnswerWait,
  cwd: string,
  deps: HumanGateDeps,
): HumanAnswerChannel | undefined {
  const target = deps.resolveGithubAnswerTarget({ cwd }, awaiting.beadId);
  if (target.kind === "unmapped" || target.kind === "unknown") {
    warnUnavailableHumanAnswer(state, awaiting.beadId, target.reason);
    return undefined;
  }
  const channel = channelOf(target);
  awaiting.channel = channel;
  return channel;
}

/** The bd-152 read: the first non-harness comment on the bead's thread. */
async function observeBeadAnswer(
  beadId: string,
  baseline: number,
  cwd: string,
): Promise<HumanAnswerObservation> {
  const comments = await lookupBeadComments({ beadId, cwd, runBd: runBdCommand });
  if (!comments.ok) return { kind: "unknown" };
  const answer = comments.comments.find(
    (comment) => isHumanComment(comment) && commentTimeInMs(comment) >= baseline,
  );
  if (answer === undefined) return { kind: "pending" };
  return { kind: "answered", author: answer.author, text: answer.text };
}

/**
 * The bd-182 read: the first human comment on the recorded issue at/after the gate.
 *
 * Identity is enforced twice (review C2): the harness's own posted comment id is
 * excluded, and the authenticated `gh` login joins the allowlist. When that
 * identity cannot be read, a known posted id still protects the wait; with
 * neither, the read fails closed rather than risk reading the question back.
 */
async function observeGithubAnswer(options: {
  state: CoreSessionState;
  awaiting: HumanAnswerWait;
  channel: Extract<HumanAnswerChannel, { kind: "github" }>;
  baseline: number;
  cwd: string;
}): Promise<HumanAnswerObservation> {
  const { state, awaiting, channel, baseline, cwd } = options;
  const subject = `${channel.owner}/${channel.repo}#${channel.issue.toString()}`;
  const identity = await waitHarnessIdentity(awaiting, cwd);
  const botLogins = waitHarnessBotLogins(awaiting);
  const allowlist = identity.ok ? [...botLogins, identity.login] : botLogins;
  if (!identity.ok) {
    const postedId = awaiting.answerCommentId;
    if (postedId === undefined) {
      // No primary exclusion and no identity: an issue comment cannot be told
      // apart from the harness's own question, so keep the wait armed. The
      // warning must say that — an operator chasing a stuck wait must not be
      // told an exclusion is protecting a read that never happens.
      warnHarnessIdentityUnavailable(
        state,
        subject,
        `could not resolve the authenticated gh login (${identity.error}) and no posted ` +
          "comment id is known, so the read fails closed: the wait stays armed until the " +
          "identity resolves",
      );
      return { kind: "unknown" };
    }
    warnHarnessIdentityUnavailable(
      state,
      subject,
      `could not resolve the authenticated gh login (${identity.error}); ` +
        `relying on the posted comment id ${postedId} and the bot/allowlist rules`,
    );
  }
  const comments = await lookupIssueComments({
    repo: { owner: channel.owner, repo: channel.repo },
    number: channel.issue,
    since: new Date(baseline).toISOString(),
    cwd,
    runGh: runGhCommand,
  });
  if (!comments.ok) {
    warnUnavailableHumanAnswer(state, subject, comments.error);
    return { kind: "unknown" };
  }
  if (comments.dropped > 0) warnDroppedComments(state, subject, comments.dropped);
  const answer = selectHumanAnswer(comments.comments, {
    sinceMs: baseline,
    allowlist,
    ...(awaiting.answerCommentId === undefined ? {} : { excludeId: awaiting.answerCommentId }),
  });
  if (answer === undefined) return { kind: "pending" };
  return { kind: "answered", author: answer.author, text: answer.text };
}

/**
 * Resolve the authenticated identity once per wait, caching only a success.
 *
 * A failed lookup is returned for this cycle but never stored, so the next claim
 * retries it. Caching the failure would mean a single transient `gh` error makes
 * a comment answer undeliverable until the process restarts; staying fail-closed
 * for the current cycle is enough (see {@link observeGithubAnswer}).
 */
async function waitHarnessIdentity(
  awaiting: HumanAnswerWait,
  cwd: string,
): Promise<AuthenticatedLoginLookup> {
  const cached = awaiting.harnessIdentity;
  if (cached?.ok === true) return cached;
  const identity = await lookupAuthenticatedLogin({ cwd, runGh: runGhCommand });
  if (identity.ok) awaiting.harnessIdentity = identity;
  return identity;
}

/**
 * Parse the operator's bot-login allowlist once per wait, not once per tick.
 *
 * A restart re-reads `BELAYD_GITHUB_BOT_LOGINS`; within one wait it is fixed, so
 * an env edit mid-wait cannot make the same wait see two allowlists.
 */
function waitHarnessBotLogins(awaiting: HumanAnswerWait): readonly string[] {
  const cached = awaiting.harnessBotLogins;
  if (cached !== undefined) return cached;
  const logins = harnessGithubLogins(process.env.BELAYD_GITHUB_BOT_LOGINS);
  awaiting.harnessBotLogins = logins;
  return logins;
}

/** Say once per wait why the answer channel could not be read; never spam the poll. */
function warnUnavailableHumanAnswer(
  state: CoreSessionState,
  subject: string,
  reason: string,
): void {
  if (state.humanAnswerWarned === true) return;
  state.humanAnswerWarned = true;
  console.warn(`[belayd-harness] cannot read the human answer channel for ${subject}: ${reason}`);
}

/**
 * Say once per wait that the `gh` identity is unknown.
 *
 * Its own flag (not `humanAnswerWarned`): the message names an outcome that
 * differs between the fail-closed path and the posted-id path, and it must not
 * consume the budget of a failed channel read.
 */
function warnHarnessIdentityUnavailable(
  state: CoreSessionState,
  subject: string,
  reason: string,
): void {
  if (state.harnessIdentityWarned === true) return;
  state.harnessIdentityWarned = true;
  console.warn(`[belayd-harness] cannot read the human answer channel for ${subject}: ${reason}`);
}

/** Say once per wait that comments could not be parsed, e.g. a deleted account. */
function warnDroppedComments(state: CoreSessionState, subject: string, dropped: number): void {
  if (state.humanAnswerDroppedWarned === true) return;
  state.humanAnswerDroppedWarned = true;
  console.warn(
    `[belayd-harness] dropped ${dropped.toString()} unparsable issue comment(s) on ${subject}; ` +
      "a comment with no author or body can never be delivered as the answer.",
  );
}

/**
 * A closed gate is a resolution; its `close_reason` may also carry the answer.
 *
 * Resolving out of band (Scotty's Approve, `bd gate resolve --reason`) records
 * the person's text on the *gate*, not on the bead, so without this second read
 * the workflow resumes with "resolved without a comment" and the note is lost.
 * Deliberately not fail-closed: the gate is already gone, so a failed read keeps
 * the resolution (only the note is dropped) instead of waiting on a gate bd will
 * never report again.
 */
async function resolvedObservation(
  awaiting: HumanAnswerWait,
  cwd: string,
): Promise<HumanAnswerObservation> {
  const closed = await lookupResolvedHumanGate({
    beadId: awaiting.beadId,
    ...(awaiting.gateId === undefined ? {} : { gateId: awaiting.gateId }),
    cwd,
    runBd: runBdCommand,
  });
  if (!closed.ok || closed.status === "none" || closed.gate.note === undefined) {
    return { kind: "resolved" };
  }
  return { kind: "resolved", note: closed.gate.note };
}

/** Say once per wait that bd's gate JSON no longer parses; never spam the poll. */
function warnUnrecognizedHumanGate(state: CoreSessionState, beadId: string): void {
  if (state.humanUnrecognizedGateWarned === true) return;
  state.humanUnrecognizedGateWarned = true;
  console.warn(
    `[belayd-harness] bd reported gates for ${beadId} that are not open human gates; ` +
      "the human wait stays armed (bd gate JSON may have changed).",
  );
}

/** A detected answer plus the wait it belongs to. */
interface DetectedHumanAnswer {
  awaiting: HumanAnswerWait;
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
  deps: HumanGateDeps,
): Promise<DetectedHumanAnswer | undefined> {
  const awaiting = state.awaitingHuman;
  if (awaiting === undefined) return undefined;
  if (state.humanAnswerClaimed === true) return undefined;
  state.humanAnswerClaimed = true;
  try {
    const observed = await observeHumanAnswer(state, awaiting, ctx.cwd, deps);
    if (isDeliverable(observed) && state.awaitingHuman === awaiting) {
      // The publication choice is recorded before the answer is delivered, so the
      // message can tell the orchestrator what the record now says. `awaiting` is
      // the wait that was answered: only a review wait carries
      // `reviewFindings`, so an unrelated question's answer can never release a
      // withheld finding (bd-183 review, Critical).
      const choice = recordPublicationChoice({
        cwd: ctx.cwd,
        answer: deliverableAnswerText(observed),
        waiting: awaiting,
      });
      const message = humanAnswerText(awaiting, observed);
      return { awaiting, message: choice === undefined ? message : `${message}\n${choice}` };
    }
  } catch (error) {
    console.warn(`[belayd-harness] human answer check failed: ${errorText(error)}`);
  }
  state.humanAnswerClaimed = false;
  return undefined;
}

/** The message a delivered answer (or an out-of-band gate resolve) becomes. */
function humanAnswerText(awaiting: HumanAnswerWait, observed: DeliverableObservation): string {
  if (observed.kind === "resolved") {
    const base = `The human gate on ${awaiting.beadId} was resolved without a comment`;
    if (observed.note === undefined) return `${base}; you may proceed.`;
    return `${base}; the resolver's note was "${excerptComment(observed.note)}". You may proceed.`;
  }
  return `${observed.author} answered: ${excerptComment(observed.text)}`;
}

/** The answer's own words; an out-of-band resolve may only leave a note. */
function deliverableAnswerText(observed: DeliverableObservation): string {
  return observed.kind === "answered" ? observed.text : (observed.note ?? "");
}

/**
 * Record the human's publication choice for the review's sensitive findings.
 *
 * Returns the line the session is shown, or `undefined` when the answered wait is
 * not a review wait with sensitive findings (a bare `belayd_ask_human` question,
 * a restart-discovered gate, an ordinary review) — then the answer message keeps
 * its bd-152 shape and nothing is written.
 *
 * **Keyed on the wait, never on the file.** why: `.belayd/review-findings.json`
 * exists in every worktree that ever ran a review, so "a sensitive record exists"
 * would let any later human answer in the worktree ("yes, ship it") release every
 * withheld finding (bd-183 review, Critical). `reviewFindings` is set only by
 * {@link deliverReviewFindings}, only when the record has sensitive findings, and
 * carries the round so a re-review's record cannot be answered by an older wait.
 *
 * Fail-closed: no marker → no recording; a write failure or a refused recording →
 * only a warning/message, and a record without a decision already blocks
 * publishing (see `src/finding-publication.ts`).
 */
function recordPublicationChoice(options: {
  cwd: string;
  answer: string;
  waiting: AwaitingHuman & { gateId?: string };
}): string | undefined {
  const reviewWait = options.waiting.reviewFindings;
  if (reviewWait === undefined) return undefined;
  const written = recordPublicationAnswer({
    cwd: options.cwd,
    answer: options.answer,
    round: reviewWait.round,
  });
  if (!written.ok) {
    console.warn(`[belayd-harness] could not record the publication choice: ${written.error}`);
    return (
      "Sensitive findings: the publication choice could not be recorded, so they stay withheld — " +
      "nothing about them can appear in a PR until the record says publish."
    );
  }
  if (!written.recorded) {
    return publicationAnswerRefusalLine(written.cause, reviewWait.round);
  }
  const chosen = parsePublicationAnswer(options.answer).kind;
  return (
    `Sensitive findings: publication choice "${chosen}" is recorded in ` +
    `${REVIEW_FINDINGS_RECORD_RELATIVE_PATH}; nothing about them may appear in a PR unless that ` +
    "choice is publish (it is re-read from the record on every publish)."
  );
}

/**
 * The one line for a refused recording, phrased from its cause.
 *
 * why: "no record", "the record moved to another round" and "it has no sensitive
 * finding" need different follow-ups (re-open a gate / answer the current one /
 * nothing to do), so a single generic sentence would hide the state from the
 * orchestrator (bd-183 review). Every cause is still a non-write and therefore
 * withheld — only the explanation differs.
 */
function publicationAnswerRefusalLine(cause: PublicationAnswerRefusalCause, round: number): string {
  switch (cause) {
    case "no-record":
      return (
        "Sensitive findings: no review record was found, so the publication choice was not " +
        "recorded and they stay withheld — nothing about them can appear in a PR."
      );
    case "round-mismatch":
      return (
        `Sensitive findings: the review record is no longer round ${round}, so the publication ` +
        "choice was not recorded and they stay withheld — answer the current review gate."
      );
    case "no-sensitive-findings":
      return (
        "Sensitive findings: the review record has no security-class finding any more, so there " +
        "was no publication choice to record."
      );
  }
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
  awaiting: HumanAnswerWait;
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
  awaiting: HumanAnswerWait;
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
  awaiting: HumanAnswerWait,
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
  const detected = await claimHumanAnswer(state, ctx, deps);
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
  const detected = await claimHumanAnswer(state, ctx, deps);
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
    // Re-resolve the channel now: a restart must not lose that this repo asks on
    // GitHub. The cursor still comes from the gate's `createdAt`, never from the
    // restart time, so an answer posted before the restart is still delivered.
    // Only a usable target is recorded: a broken map must not pin the wait to a
    // guessed bd channel, so `resolveChannel` retries on the next tick instead.
    const target = options.deps.resolveGithubAnswerTarget({ cwd: ctx.cwd }, beadId);
    // A rediscovered publication gate stays publication-only (bd-252): its title
    // is the only durable marker a restart has, and only the full title shape for
    // this bead is accepted. A drifted or bare-prefix title stays blocking
    // (fail-closed). Never set `reviewFindings` here — an answer to a wait the
    // process did not arm must not release withheld findings (bd-183).
    const publicationOnly =
      found.gate.title !== undefined && isReviewFindingsGateTitle(found.gate.title, beadId);
    state.awaitingHuman = {
      beadId,
      gateId: found.gate.gateId,
      askedAt: Date.now(),
      ...(publicationOnly ? { publicationOnly: true as const } : {}),
      ...(target.kind === "github" ? { channel: channelOf(target) } : {}),
    };
    startHumanAnswerPoll(state, ctx, options.deps);
  })().catch((error: unknown) => {
    console.warn(`[belayd-harness] human gate discovery failed: ${errorText(error)}`);
  });
}

/**
 * Record an answer that was posted just before completion reaped the gate
 * (bd-252 review).
 *
 * A publication-only wait no longer blocks the fix loop, so the workflow can
 * finish with the gate still open. If a human already answered, the choice must
 * be written before the gate is resolved: resolving first loses the wait key and
 * the answer can never be recorded. Every failure is contained here — completion
 * must still resolve the gate and the hook must not throw.
 */
async function recordPublicationAnswerBeforeReap(options: {
  ctx: ExtensionContext;
  state: CoreSessionState;
  awaiting: HumanAnswerWait;
  deps: HumanGateDeps;
}): Promise<void> {
  try {
    const observed = await observeHumanAnswer(
      options.state,
      options.awaiting,
      options.ctx.cwd,
      options.deps,
    );
    if (!isDeliverable(observed)) {
      console.warn(
        "[belayd-harness] publication gate reaped at workflow completion without a publication " +
          "answer; sensitive findings stay withheld",
      );
      return;
    }
    // A resolved gate with no note is an out-of-band close, not a publication
    // choice: writing a default withhold would fabricate a decision the human
    // never made. The unanswered record is already fail-closed.
    const answer = observed.kind === "answered" ? observed.text : observed.note;
    if (answer === undefined) {
      console.warn(
        "[belayd-harness] publication gate reaped at workflow completion without a publication " +
          "answer; sensitive findings stay withheld",
      );
      return;
    }
    recordPublicationChoice({
      cwd: options.ctx.cwd,
      answer,
      waiting: options.awaiting,
    });
  } catch (error) {
    console.warn(
      `[belayd-harness] could not check the publication answer before reaping the gate: ` +
        `${errorText(error)}; sensitive findings stay withheld`,
    );
  }
}

/**
 * Resolve a torn-down workflow's human gate (bd-152).
 *
 * An orphan gate keeps the bead blocked in bd/Scotty long after the workflow
 * stopped, so the gate goes with the workflow. Best-effort and bounded: a
 * teardown must never fail because bd did.
 *
 * A publication-only wait gets one answer check first (bd-252 review): completion
 * no longer waits for the gate, so an answer posted in the race window is
 * recorded before the gate is resolved. The plain ask-human wait keeps its
 * original reap path.
 */
export async function reapHumanGateForTask(options: {
  ctx: ExtensionContext;
  state: CoreSessionState;
  beadId: string;
  deps: HumanGateDeps;
}): Promise<void> {
  const awaiting = options.state.awaitingHuman;
  if (
    awaiting?.publicationOnly === true &&
    options.beadId !== "" &&
    awaiting.beadId === options.beadId
  ) {
    await recordPublicationAnswerBeforeReap({
      ctx: options.ctx,
      state: options.state,
      awaiting,
      deps: options.deps,
    });
  }
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
 * Post a question or findings on the wait's channel.
 *
 * GitHub-primary posts to the mapped **issue** (never a PR); local mode keeps
 * the authored bd comment byte for byte. The body never reaches argv: it goes on
 * stdin, either as `{"body": …}` JSON or verbatim.
 */
async function postChannelBody(options: {
  channel: HumanAnswerChannel;
  body: string;
  actor: string;
  taskId: string;
  cwd: string;
}): Promise<{ ok: true; commentId?: string } | { ok: false; error: string }> {
  if (options.channel.kind === "github") {
    return postIssueComment({
      repo: { owner: options.channel.owner, repo: options.channel.repo },
      number: options.channel.issue,
      body: options.body,
      cwd: options.cwd,
      runGh: runGhCommand,
    });
  }
  const posted = await runBdResult(
    withActorArgv(["comment", "--stdin", "--", options.taskId], options.actor),
    { cwd: options.cwd, stdin: options.body },
  );
  return posted.ok ? { ok: true } : { ok: false, error: posted.error };
}

/**
 * Implement `belayd_ask_human`: gate + authored question, then stop.
 *
 * Two writes, deliberately NOT through the `bd` proxy: argv validation only
 * inspects `argv[0]`, so allowing `gate` there would expose the whole gate
 * lifecycle (src/bd-command.ts). Order matters — the gate is created first, so
 * the wait is visible in bd/Scotty even if the question write fails; the
 * question is authored by the workflow actor (or the GitHub App bot), which is
 * what keeps it from ever counting as the answer.
 *
 * The channel is resolved BEFORE the gate exists (bd-182): a bead with no
 * mapped issue has no answer channel under GitHub-primary, and an unanswerable
 * wait must not block the bead.
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
  const answerTarget = deps.resolveGithubAnswerTarget({ cwd: ctx.cwd }, target.taskId);
  if (answerTarget.kind === "unmapped" || answerTarget.kind === "unknown") {
    return textToolResult(
      `belayd_ask_human: cannot ask about ${target.taskId}: ${answerTarget.reason}. ` +
        "Map the bead to a GitHub issue in .belayd/github-map.json (or fix .belayd/config.json) and retry; no gate was opened.",
      1,
    );
  }
  const channel = channelOf(answerTarget);
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
  const awaiting: HumanAnswerWait = {
    beadId: target.taskId,
    askedAt: Date.now(),
    channel,
    ...(created.gateId === undefined ? {} : { gateId: created.gateId }),
  };

  const posted = await postChannelBody({
    channel,
    body: target.question,
    actor,
    taskId: target.taskId,
    cwd: ctx.cwd,
  });
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
          `belayd_ask_human: could not post the question ${channelLabel(channel)} (${posted.error}).`,
          `Resolving the gate it created also failed (${cleaned.error ?? "unknown error"}).`,
          "The bead may be left blocked by an open human gate and the question may not be posted.",
          `Check with bd gate list ${target.taskId}, resolve it with bd gate resolve <gate>, or retry.`,
        ].join(" "),
        1,
      );
    }
    return textToolResult(
      `belayd_ask_human: could not post the question ${channelLabel(channel)}: ${posted.error}`,
      1,
    );
  }

  if (posted.commentId !== undefined) awaiting.answerCommentId = posted.commentId;
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
          awaitType: "human",
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

/**
 * The reason prefix a failed record write contributes to the delivery result.
 *
 * The seam owns the "could not record the review findings" line; the delivery
 * reason reuses the same words so the caller's single "not fully delivered" line
 * names the lost record in the same terms as the daemon log.
 */
const REVIEW_RECORD_FAILURE_PREFIX = "could not record the review findings";

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
 * Record a review that reported findings, and escalate only the one decision the
 * orchestrator may not take itself (bd-219).
 *
 * The delivery is a **trace**, not a question: the durable disposition record is
 * always written and the findings comment is always posted by the workflow
 * actor, so a human can read what the review found and the orchestrator can read
 * it too. No gate, no wait and no answer poll is created for ordinary findings —
 * the fix-loop contract already says every Critical and Warning must be
 * addressed, so asking a human whether to address them only bought a wait per
 * review (bd-219).
 *
 * The one exception is a security-class finding (bd-183): its *publication* is a
 * risk decision, so the gate is created first (so the wait is visible in
 * bd/Scotty even if a later write fails), then the same record and comment, then
 * the answer poll. A record with no sensitive findings leaves
 * `state.awaitingHuman` untouched. If a human wait is already open the round
 * still advances but no second gate is created: the comment carries the re-ask
 * notice and the result names the skipped publication question, because the open
 * gate would otherwise answer this round with `round-mismatch`.
 *
 * The reservation (`state.reviewGatePending`) is still taken synchronously
 * before the first `await`, so two sensitive deliveries settling concurrently
 * cannot both create a gate. It is never exposed as `awaitingHuman`: while it is
 * set no gate exists yet, and the answer poll would read the empty gate list as
 * "the human resolved it". The marker is released in a `finally` that touches
 * nothing else, so a throw inside the section can neither strand it nor unblock a
 * gate that already exists.
 */
export async function deliverReviewFindings(options: {
  state: CoreSessionState;
  ctx: ExtensionContext;
  deps: HumanGateDeps;
  taskId: string;
  reviewText: string;
}): Promise<{ recorded: boolean; gateOpened: boolean; reason: string }> {
  const { state } = options;
  if (state.reviewGatePending === true) {
    return {
      recorded: false,
      gateOpened: false,
      reason: "a review delivery is already in progress",
    };
  }
  // Same guard `resolveAskTarget` applies to the ask path: a crafted task id must
  // never reach `orchestratorActor` or a bd argv. It also guards the record write,
  // which names the task id.
  if (!isValidTaskId(options.taskId)) {
    return { recorded: false, gateOpened: false, reason: `invalid task id "${options.taskId}"` };
  }
  // Read once for the reset announcement and the cross-round union below; the
  // round itself still comes from `nextReviewRound`, so the two can never disagree
  // about the round count.
  const previous = readReviewFindingsRecord({ cwd: options.ctx.cwd });
  const rebuilt = buildReviewFindingsRecord({
    taskId: options.taskId,
    text: options.reviewText,
    round: nextReviewRound({ cwd: options.ctx.cwd }),
  });
  if (rebuilt === undefined) {
    // Fast path: a clean review must not touch bd or the record file at all.
    return { recorded: false, gateOpened: false, reason: REVIEW_NO_FINDINGS_REASON };
  }
  // A finding that was security-class in an earlier round stays security-class
  // even when the live rule table no longer matches it (bd-183 review, Critical).
  const record = carryForwardSensitivity({ record: rebuilt, previous });
  const sensitive = hasSensitiveFindings(record);
  // A re-review rebuilds the record without decisions, so an earlier round's
  // "publish" silently stops applying. Announce that instead of letting the
  // human re-discover it as a withheld finding (bd-183 review).
  const previousDecisionsReset =
    previous !== undefined && previous.round < record.round && releasedPublicationIn(previous);

  const actor =
    options.deps.resolveSessionBdActor(options.ctx) ?? orchestratorActor(options.taskId);
  // Reserve synchronously so a concurrent delivery bails at the check above
  // instead of racing this one to a second gate.
  const askedAt = Date.now();
  state.reviewGatePending = true;
  try {
    const gate = await createSensitiveReviewGate({
      state,
      ctx: options.ctx,
      taskId: options.taskId,
      record,
      sensitive,
      previousDecisionsReset,
      actor,
    });

    const written = writeReviewFindingsRecord({ cwd: options.ctx.cwd, record });
    if (!written.ok) {
      console.warn(`[belayd-harness] ${REVIEW_RECORD_FAILURE_PREFIX}: ${written.error}`);
    }

    // The comment is the trace a human reads and the orchestrator acts on. A
    // failed post must not remove a gate that already blocks the bead.
    const channel = channelOf(
      options.deps.resolveGithubAnswerTarget({ cwd: options.ctx.cwd }, options.taskId),
    );
    const posted = await postChannelBody({
      channel,
      body: phaseCommentBody(
        "review",
        formatReviewFindingsComment(record, {
          previousDecisionsReset,
          publicationReaskRequired: gate.status === "already-waiting",
        }),
      ),
      actor,
      taskId: options.taskId,
      cwd: options.ctx.cwd,
    });
    if (!posted.ok) {
      console.warn(`[belayd-harness] could not post the review findings comment: ${posted.error}`);
    }

    if (gate.status === "opened") {
      const wait: HumanAnswerWait = {
        beadId: options.taskId,
        askedAt,
        channel,
        ...(gate.gateId === undefined ? {} : { gateId: gate.gateId }),
        // A publication answer decides only the PR body and withholding is the
        // default, so this wait must not block phase tools (bd-252).
        publicationOnly: true,
        // Only a sensitive review wait may record a publication decision; the ask
        // tool and restart discovery never set this marker.
        reviewFindings: { round: record.round },
      };
      if (posted.ok && posted.commentId !== undefined) {
        // The findings comment is the question here; exclude it like the ask path.
        wait.answerCommentId = posted.commentId;
      }
      state.awaitingHuman = wait;
      startHumanAnswerPoll(state, options.ctx, options.deps);
    }

    return {
      recorded: written.ok,
      gateOpened: gate.status === "opened",
      reason: reviewDeliveryReason({ record, written, gate }),
    };
  } finally {
    // Only the reservation is released here. `awaitingHuman` is the wait itself
    // and must survive a throw: clearing it in `finally` would silently unblock a
    // member whose gate is already open and visible in bd.
    state.reviewGatePending = undefined;
  }
}

/**
 * The delivery reason for a record whose write and/or sensitive gate may have
 * failed.
 *
 * Both failures can happen in the same delivery: bd refuses the publication gate
 * and the worktree record cannot be written. Each has its own console line (the
 * write here, the gate in {@link createSensitiveReviewGate}), but the caller's
 * single "not fully delivered" line quotes only this string, so naming just the
 * gate hides the lost record. A double failure therefore names both with their
 * own labels, record first; success and every single failure keep their existing
 * wording. The labels matter because either constituent can itself contain `;`
 * (the already-waiting reason does), so a bare `; ` would not separate them.
 */
function reviewDeliveryReason(options: {
  record: ReviewFindingsRecord;
  written: { ok: true } | { ok: false; error: string };
  gate: SensitiveGateOutcome;
}): string {
  const gateReason = gateSkippedReason(options.gate);
  if (options.written.ok || gateReason === undefined) return gateReason ?? options.record.reason;
  return (
    `${REVIEW_RECORD_FAILURE_PREFIX}: ${options.written.error}` +
    ` and the sensitive-findings gate was not armed: ${gateReason}`
  );
}

/**
 * Why a sensitive record did or did not get its bd-183 publication gate.
 *
 * `already-waiting` and `failed` are deliberately different: the first means a
 * human wait exists and the round's question could not be attached to it, the
 * second means bd refused the gate. Both keep the record + comment path running,
 * and both need their own words in the delivery result.
 */
type SensitiveGateOutcome =
  | { status: "not-sensitive" }
  | { status: "opened"; gateId?: string }
  | { status: "already-waiting"; reason: string }
  | { status: "failed"; reason: string };

/** The reason a skipped sensitive gate carries, or `undefined` when it opened. */
function gateSkippedReason(gate: SensitiveGateOutcome): string | undefined {
  switch (gate.status) {
    case "already-waiting":
    case "failed":
      return gate.reason;
    case "not-sensitive":
    case "opened":
      return undefined;
  }
}

/**
 * Create the bd-183 publication gate, or report why none was created.
 *
 * Split out of {@link deliverReviewFindings} because the decision has four
 * separate outcomes (not sensitive, gate opened, a human wait already open, a bd
 * failure) and each one has to keep the record + comment path running.
 *
 * This function owns the **single** log line for each escalation it cannot arm
 * (a refused gate, an already-open human wait). The phase-run caller only logs a
 * skipped record, so one failed gate never produces two lines.
 */
async function createSensitiveReviewGate(options: {
  state: CoreSessionState;
  ctx: ExtensionContext;
  taskId: string;
  record: ReviewFindingsRecord;
  sensitive: boolean;
  previousDecisionsReset: boolean;
  actor: string;
}): Promise<SensitiveGateOutcome> {
  if (!options.sensitive) return { status: "not-sensitive" };
  if (options.state.awaitingHuman !== undefined) {
    // why: the record's round has already advanced, so the gate the human can see
    // answers `round-mismatch` to this round's publication question. A second gate
    // is worse (two polls, one answer), so the loss is announced instead of hidden
    // — the comment names the re-ask and this log line names the member.
    const reason =
      `already waiting on ${options.state.awaitingHuman.beadId}; ` +
      "the new round's publication question is not armed";
    console.warn(
      `[belayd-harness] could not arm the sensitive-findings publication question: ${reason}`,
    );
    return { status: "already-waiting", reason };
  }
  const created = await createHumanGate({
    taskId: options.taskId,
    question: reviewFindingsGateReason(options.record, {
      previousDecisionsReset: options.previousDecisionsReset,
    }),
    actor: options.actor,
    title: reviewFindingsGateTitle({
      taskId: options.taskId,
      round: options.record.round,
      sensitive: true,
      previousDecisionsReset: options.previousDecisionsReset,
    }),
    ctx: options.ctx,
  });
  if (!created.ok) {
    // The gate failing must not silence the bd-183 surface: without this line the
    // skipped publication question was only visible as an unused return value.
    console.warn(
      "[belayd-harness] could not open the sensitive-findings human gate",
      created.error,
    );
    return { status: "failed", reason: `${REVIEW_GATE_FAILURE_PREFIX}: ${created.error}` };
  }
  return created.gateId === undefined
    ? { status: "opened" }
    : { status: "opened", gateId: created.gateId };
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
      "Stop and ask a human a question about the current bead. Posts the question (as a bd " +
      "comment, or on the mapped GitHub issue for a GitHub-primary repo), opens a `human` bd " +
      "gate that blocks the bead, and refuses every phase tool until someone answers (a " +
      "comment from a human, not from the harness). The answer arrives in this session as a " +
      "user message. Use this instead of guessing when the work is blocked on a decision only " +
      "a human can make; END YOUR TURN after calling it.",
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
