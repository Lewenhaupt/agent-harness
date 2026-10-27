/**
 * Per-bead ownership/human engagement for the fleet view (bd-153).
 *
 * The fleet status surface used to read five bead fields (`id`, `title`,
 * `status`, `priority`, `labels`), so it could not answer "who drives this bead"
 * or "is a human blocking it". This reader adds the two read-only sources that
 * do: the comment thread (`bd comments <id> --json`) and the bd-152 `human` gate
 * (`bd gate list <id> --json`).
 *
 * Read-only by construction, exactly like `fleet-beads.ts`: the argv builders
 * live in `bead-comments.ts` / `bead-gates.ts` and both lookups refuse a
 * non-read argv before spawning, so this path cannot become a writer. No bd
 * write is issued on this path — no `bd gate create/resolve`, no `bd comment`.
 *
 * `fleet-status.ts` stays pure; this module owns the child processes and
 * degrades per bead instead of failing the fleet view.
 */

import {
  BEAD_READ_TIMEOUT_MS,
  type BeadComment,
  type BeadCommentLookup,
  commentTimeInMs,
  lookupBeadComments,
} from "./bead-comments.js";
import { lookupOpenHumanGate, type OpenHumanGateLookup } from "./bead-gates.js";
import type { FleetBeadRunner } from "./fleet-beads.js";
import {
  compareCodeUnits,
  type FleetBeadComment,
  type FleetBeadEngagement,
  type FleetEngagementLookup,
} from "./fleet-status.js";

/**
 * Beads read at once.
 *
 * Each bead costs two subprocesses (comments + gate list). A fleet status call
 * must not fork 2×N `bd` processes at once — bd is a Dolt client and a wide
 * burst starves the very members the view is describing — so the fan-out is a
 * small fixed pool while results keep the caller's order.
 */
export const ENGAGEMENT_CONCURRENCY = 4;

/**
 * Per-read watchdog on top of the runner's own timeout.
 *
 * The real runner enforces `timeoutInMs`, but an injected seam (tests, a future
 * caller) can return a promise that never settles; without this the pool would
 * await it forever and `belayd_fleet_status` would hang. The race makes the
 * bound self-contained rather than a convention callers must remember.
 */
const ENGAGEMENT_READ_WATCHDOG_MS = BEAD_READ_TIMEOUT_MS + 1_000;

export interface LookupFleetBeadEngagementOptions {
  /** Already filtered/de-duplicated by `fleetBeadTaskIds`; empty means no spawn. */
  taskIds: readonly string[];
  cwd: string;
  runBd: FleetBeadRunner;
  /** Test seam: overrides the per-bead comment read. */
  lookupComments?: typeof lookupBeadComments;
  /** Test seam: overrides the per-bead gate read. */
  lookupGate?: typeof lookupOpenHumanGate;
}

/**
 * Read the newest comment and the human wait for every task id.
 *
 * Per-bead failures are contained: a bead whose reads fail keeps `unknown`
 * columns while the rest of the fleet renders. `ok: false` is reserved for the
 * systemic case — every bead failed both reads (bd missing, wrong database) —
 * which the pure layer turns into exactly one fleet-level warning.
 */
export async function lookupFleetBeadEngagement(
  options: LookupFleetBeadEngagementOptions,
): Promise<FleetEngagementLookup> {
  if (options.taskIds.length === 0) return { ok: true, entries: [] };

  const lookupComments = options.lookupComments ?? lookupBeadComments;
  const lookupGate = options.lookupGate ?? lookupOpenHumanGate;

  const outcomes = await mapWithConcurrency(options.taskIds, ENGAGEMENT_CONCURRENCY, (taskId) =>
    readOne({ options, taskId, lookupComments, lookupGate }),
  );

  const usable = outcomes.filter((outcome) => outcome.usable);
  if (usable.length === 0) {
    // Nothing was readable, so there is nothing to degrade per member: this is
    // the one fleet-wide fact `applyFleetBeadEngagement` documents.
    return {
      ok: false,
      error: outcomes[0]?.error ?? "bd returned no usable bead engagement",
    };
  }

  return {
    ok: true,
    entries: outcomes.map((outcome) => ({
      taskId: outcome.taskId,
      engagement: outcome.engagement,
    })),
  };
}

interface ReadOneInput {
  options: LookupFleetBeadEngagementOptions;
  taskId: string;
  lookupComments: typeof lookupBeadComments;
  lookupGate: typeof lookupOpenHumanGate;
}

interface BeadReadOutcome {
  taskId: string;
  engagement: FleetBeadEngagement;
  /** True when at least one of the two reads succeeded. */
  usable: boolean;
  /** First per-bead read failure, for the fleet-wide degradation only. */
  error?: string;
}

type ReadAttempt<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Both reads for one bead.
 *
 * Each read is guarded on its own so a throwing comments seam still leaves the
 * gate signal available (and vice versa); the whole bead is only unusable when
 * both failed.
 */
async function readOne(input: ReadOneInput): Promise<BeadReadOutcome> {
  const comments = await attempt(() =>
    input.lookupComments({
      beadId: input.taskId,
      cwd: input.options.cwd,
      runBd: input.options.runBd,
    }),
  );
  const gate = await attempt(() =>
    input.lookupGate({
      beadId: input.taskId,
      cwd: input.options.cwd,
      runBd: input.options.runBd,
    }),
  );

  const commentLookup = comments.ok ? comments.value : undefined;
  const gateLookup = gate.ok ? gate.value : undefined;
  const commentsUsable = isCommentsUsable(commentLookup);
  const gateRead = gateLookup?.ok === true;
  const engagement: FleetBeadEngagement = {
    comments:
      commentLookup === undefined || !commentLookup.ok
        ? { state: "unknown" }
        : commentsState(commentLookup),
  };
  const awaitingHuman = gateLookup === undefined ? undefined : awaitingHumanFrom(gateLookup);
  if (awaitingHuman !== undefined) engagement.awaitingHuman = awaitingHuman;

  const error = firstError(comments, gate);
  return {
    taskId: input.taskId,
    engagement,
    usable: commentsUsable || gateRead,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Did the comment read produce something the view can trust?
 *
 * A successful read with an empty thread is usable, and so is a partially
 * malformed thread that still parsed at least one comment. A read that returned
 * records but parsed none is not: that is bd schema drift, the same
 * fail-closed case the gate column handles as `unrecognized`. It must not on
 * its own push the lookup to `ok: false` when the gate read succeeded — the
 * engagement still says `awaitingHuman` — but it does not count as the bead's
 * usable half either, so a bead whose only other read also failed is unusable.
 */
function isCommentsUsable(comments: BeadCommentLookup | undefined): boolean {
  if (comments === undefined || !comments.ok) return false;
  if (comments.comments.length > 0) return true;
  return comments.dropped === 0;
}

/** The read-as-value wrapper: `bd` may be absent, slow, or throw inside a seam. */
async function attempt<T>(read: () => Promise<T>): Promise<ReadAttempt<T>> {
  try {
    const value = await withWatchdog(read(), ENGAGEMENT_READ_WATCHDOG_MS);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function withWatchdog<T>(pending: Promise<T>, timeoutInMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`bd read timed out after ${timeoutInMs}ms`)),
      timeoutInMs,
    );
  });
  return Promise.race([pending, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstError(
  comments: ReadAttempt<BeadCommentLookup>,
  gate: ReadAttempt<OpenHumanGateLookup>,
): string | undefined {
  if (!comments.ok) return comments.error;
  if (!comments.value.ok) return comments.value.error;
  if (!gate.ok) return gate.error;
  if (!gate.value.ok) return gate.value.error;
  return undefined;
}

function commentsState(comments: BeadCommentLookup): FleetBeadEngagement["comments"] {
  if (!comments.ok) return { state: "unknown" };
  const newest = newestComment(comments.comments);
  if (newest !== undefined) return { state: "read", newest: viewComment(newest) };
  // No parsed comment: an empty thread really is `(none)`, but records bd
  // returned and the parser dropped are schema drift. The gate column says
  // `unknown` for its analogue (`unrecognized`); the comment column must too,
  // never claiming "thread empty" from data it could not read.
  return comments.dropped > 0 ? { state: "unknown" } : { state: "read" };
}

const ESCAPE_CODE = 0x1b;

/**
 * Display copy of a comment: control characters removed at the boundary.
 *
 * The formatter prints these fields into a terminal, so a C0/C1 byte (NUL, raw
 * ANSI escape) must not survive into tool output. CSI colour codes are dropped
 * whole so their printable remainder (`[31m`) does not leak either. This is
 * deliberately here rather than in the shared `excerptComment`, which prompt
 * paths rely on to keep whitespace collapsing only.
 *
 * Done by code point rather than regex: the lint rules (rightly) reject raw
 * control characters in a regex literal and then rewrite a constructed RegExp
 * back into one.
 */
function sanitizeCommentField(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === ESCAPE_CODE) {
      index = skipEscapeSequence(value, index);
      continue;
    }
    if (isControlCharacter(code)) {
      index += 1;
      continue;
    }
    result += value.charAt(index);
    index += 1;
  }
  return result;
}

/** Drop `ESC [ … final`; any other escape form is dropped one byte at a time. */
function skipEscapeSequence(value: string, start: number): number {
  if (value.charCodeAt(start + 1) !== "[".charCodeAt(0)) return start + 1;
  let cursor = start + 2;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x40 && code <= 0x7e) return cursor;
  }
  return cursor;
}

function isControlCharacter(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function viewComment(comment: BeadComment): FleetBeadComment {
  return {
    author: sanitizeCommentField(comment.author),
    // The formatter wraps this field in double quotes on one line; an embedded
    // `"` would break that quoting, so it becomes an apostrophe (1:1, so the
    // excerpt cap applied later still holds).
    text: sanitizeCommentField(comment.text).replace(/"/gu, "'"),
    createdAt: sanitizeCommentField(comment.createdAt),
  };
}

/**
 * Map a gate read to the tri-state wait.
 *
 * Fail closed: only a parsed open human gate is `true`, only bd's explicit
 * "no gates" is `false`. `unrecognized` (records exist but none is an open
 * human gate — a renamed field or malformed record) and a failed read are
 * `undefined`, so the view says `unknown` instead of claiming a human is not
 * needed.
 */
function awaitingHumanFrom(gate: OpenHumanGateLookup): boolean | undefined {
  if (!gate.ok) return undefined;
  switch (gate.status) {
    case "open":
      return true;
    case "none":
      return false;
    case "unrecognized":
      return undefined;
  }
}

/**
 * Newest comment by `createdAt`, ties broken by comment id.
 *
 * `Date.parse` can yield NaN for a malformed timestamp, which would silently
 * win or lose depending on comparison order; NaN ranks below every real time.
 * The id is the secondary key so equal second-granularity timestamps (bd's
 * granularity) still resolve the same way on every run.
 *
 * Caveat: the id tie-break is deterministic, not chronological — if bd ever
 * issues non-monotonic comment ids, equal-timestamp ties may not match thread
 * order. Determinism is what the view needs; `createdAt` remains the primary key.
 */
function newestComment(comments: readonly BeadComment[]): BeadComment | undefined {
  let newest: BeadComment | undefined;
  for (const comment of comments) {
    if (newest === undefined || isNewerComment(comment, newest)) newest = comment;
  }
  return newest;
}

function isNewerComment(candidate: BeadComment, current: BeadComment): boolean {
  const candidateMs = commentTimeInMs(candidate);
  const currentMs = commentTimeInMs(current);
  const candidateRank = Number.isNaN(candidateMs) ? Number.NEGATIVE_INFINITY : candidateMs;
  const currentRank = Number.isNaN(currentMs) ? Number.NEGATIVE_INFINITY : currentMs;
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  return compareCodeUnits(candidate.id, current.id) > 0;
}

/**
 * Bounded fan-out that preserves input order.
 *
 * `Promise.all` over the whole list would fork every bead at once; a worker
 * pool keeps at most `limit` beads (and because each bead reads sequentially,
 * at most `limit` bd processes) in flight.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  const run = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, run));
  return results;
}
