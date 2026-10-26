/**
 * Bead comments: composition and reading.
 *
 * Two concerns share this module because both are about the same thread:
 *
 * 1. Phase-deliverable records (bd-151). A phase deliverable (userguide body,
 *    research findings, proof verdict) is recorded in the bead's comment
 *    thread: every comment is authored, timestamped and ordered, while appended
 *    notes all land in one unowned blob. The notes/description/design blob
 *    stays the PLAN, which is what `bd show` feeds back into later phase
 *    prompts. Every harness-authored deliverable opens with a `[belayd:<phase>]`
 *    header line, and `bd show`'s COMMENTS section is stripped before it
 *    reaches a prompt.
 *
 * 2. The human answer channel (bd-152). bd already stores a comment thread per
 *    bead and Scotty renders it, but until now nothing in the harness read or
 *    wrote it, so a human handoff was one-way: the bead appeared in "Needs You"
 *    and no answer could come back. The read half lives here (`bead-gates.ts`
 *    owns the gate that says "waiting on a human", and the extension owns the
 *    poll that delivers).
 *
 * The read split mirrors `fleet-beads.ts`: the argv builder and the process
 * runner are injected, so the read-only invariant is enforced on the argv that
 * will actually be spawned and a test can prove no write reaches `bd`.
 * Everything degrades to `{ ok: false }`: bd may be absent, slow, or pointed at
 * no database, and none of that may break a live workflow.
 */

import { isBdReadArgv } from "./bd-command.js";
import { isBelaydActor } from "./beads-actor.js";
import type { FleetBeadRunner } from "./fleet-beads.js";

/**
 * Phase names the harness may author a deliverable comment under.
 *
 * Closed on purpose: a typo would otherwise create an untraceable
 * `[belayd:<typo>]` tag that no reader expects. Extend this union when a new
 * phase starts writing comments; the prompt-only research writer
 * (`src/agent-registry.ts`) must emit the member name verbatim.
 */
export type PhaseCommentAuthor = "proof-verifier" | "research" | "userguide";

/** Prefix of the phase header line on every harness-authored bead comment. */
export const PHASE_COMMENT_PREFIX = "[belayd:";

/** Header line naming the phase that authored a deliverable comment. */
export function phaseCommentHeader(phase: PhaseCommentAuthor): string {
  return `${PHASE_COMMENT_PREFIX}${phase}]`;
}

/**
 * Compose a deliverable comment body: the phase header line, then the
 * deliverable verbatim.
 *
 * The content is never rewritten — a CRLF body stays CRLF — because it is a
 * record, not a rendered document; normalising it would make the stored comment
 * differ from what the phase produced.
 */
export function phaseCommentBody(phase: PhaseCommentAuthor, content: string): string {
  return `${phaseCommentHeader(phase)}\n${content}`;
}

/**
 * Drop `bd show`'s COMMENTS section from its plain-text output.
 *
 * Comments are not part of the plan: `bd show` prints the whole thread (pasted
 * guides, findings, proof detail), which would grow every later phase prompt
 * without bound and can carry secrets. `bd show` indents body content by two
 * spaces, so a column-0 heading is a real section boundary.
 *
 * Nothing follows COMMENTS in the current `bd show` layout, which is why the
 * whole tail is dropped. That layout assumption is pinned against a real
 * transcript (`src/__tests__/fixtures/bd-show-with-comments.txt`, captured
 * with `bd show sandbox-dfr` from a throwaway embedded-Dolt database): the
 * fixture test asserts COMMENTS is the last column-0 section, so a future bd
 * that appends sections after it fails the suite instead of silently deleting
 * plan content from every phase prompt.
 */
export function stripBdShowComments(showText: string): string {
  const commentsHeading = /(?:^|\r?\n)COMMENTS\b/.exec(showText);
  if (commentsHeading === null) return showText;
  return showText.slice(0, commentsHeading.index).replace(/\s+$/, "");
}

/**
 * Longest one comment read may take before it degrades to "no answers known".
 * Same bound as the fleet bead lookup: this read runs off a poll timer, so a
 * hung bd must not accumulate.
 */
export const BEAD_READ_TIMEOUT_MS = 15_000;

/** Cap on bd stdout for one bead read. A comment thread is never unbounded input. */
export const BEAD_READ_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** Longest comment text that may reach a prompt. */
export const COMMENT_EXCERPT_MAX_CHARS = 2_000;

/** Marker appended to a truncated excerpt; a single char, so the cap holds. */
const ELLIPSIS = "…";

/** One comment record, as bd answers `bd comments <id> --json`. */
export interface BeadComment {
  id: string;
  issueId: string;
  author: string;
  /** bd's ISO timestamp, second granularity. */
  createdAt: string;
  text: string;
}

/** `bd comments <id> --json`. */
export function buildBeadCommentsArgv(beadId: string): readonly string[] {
  return ["comments", beadId, "--json"];
}

/**
 * Tolerant parse of `bd comments --json`.
 *
 * bd answers with a JSON array of records, `null` for an empty thread, or a
 * single object for one comment depending on version and code path. Records
 * that lack the fields the answer channel needs are dropped rather than fatal:
 * one malformed comment must not hide the human's answer, and this never throws
 * because it runs inside a poll that may not surface an exception.
 */
export function parseBeadComments(raw: unknown): BeadComment[] {
  const records = normalizeRecords(raw);
  const comments: BeadComment[] = [];
  for (const record of records) {
    if (typeof record.id !== "string" || record.id === "") continue;
    if (typeof record.text !== "string") continue;
    comments.push({
      id: record.id,
      issueId: typeof record.issue_id === "string" ? record.issue_id : "",
      // An unattributed comment counts as human: `isHumanComment` only excuses
      // authors the harness itself wrote, and the mirror always carries one.
      author: typeof record.author === "string" ? record.author : "",
      createdAt: typeof record.created_at === "string" ? record.created_at : "",
      text: record.text,
    });
  }
  return comments;
}

/** Array-or-single-object tolerance for untrusted bd JSON. */
function normalizeRecords(raw: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? [raw]
      : ([] as unknown[]);
  return values.filter(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
  );
}

/**
 * Whether a comment came from a human rather than the harness.
 *
 * This is the whole author filter: everything the harness writes is attributed
 * to a `belayd:` actor (bd-150), so anything else — a person in Scotty, another
 * tool, or bd's own inherited `BEADS_ACTOR` — is an answer. The prefix itself is
 * owned by `src/beads-actor.ts`, so "harness author" has one definition.
 */
export function isHumanComment(comment: Pick<BeadComment, "author"> | string): boolean {
  const author = typeof comment === "string" ? comment : comment.author;
  return !isBelaydActor(author);
}

/**
 * Collapse a comment body to one line and cap it.
 *
 * Comment text is model-authored or human-authored free text that is injected
 * into a prompt, so it is flattened (a fenced block or a multi-paragraph answer
 * would wreck the injected message) and truncated. The cap includes the
 * ellipsis, so the result never exceeds `maxChars`.
 */
export function excerptComment(text: string, maxChars: number = COMMENT_EXCERPT_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  const cap = Math.max(1, maxChars);
  if (collapsed.length <= cap) return collapsed;
  if (cap === 1) return ELLIPSIS;
  return `${collapsed.slice(0, cap - 1).trimEnd()}${ELLIPSIS}`;
}

/** Outcome of one comment read. */
export type BeadCommentLookup =
  | { ok: true; comments: BeadComment[] }
  | { ok: false; error: string };

export interface LookupBeadCommentsOptions {
  beadId: string;
  cwd: string;
  runBd: FleetBeadRunner;
  /** Test seam for the read-only guard; production always uses the default. */
  buildArgv?: (beadId: string) => readonly string[];
}

/**
 * Run one read-only `bd comments <id> --json` and parse the thread.
 *
 * The guard runs against the argv that will execute, not the builder's source,
 * so an injected or regressed builder cannot turn the answer poll into a writer.
 */
export async function lookupBeadComments(
  options: LookupBeadCommentsOptions,
): Promise<BeadCommentLookup> {
  const buildArgv = options.buildArgv ?? buildBeadCommentsArgv;
  const argv = buildArgv(options.beadId);
  // A value starting with `-` would be read by bd as a flag; refuse before spawn.
  if (options.beadId === "" || options.beadId.startsWith("-")) {
    return { ok: false, error: `refusing to read comments for bead id "${options.beadId}"` };
  }
  if (!isBdReadArgv(argv)) {
    return { ok: false, error: `refusing non-read bd argv "${argv.join(" ")}"` };
  }

  try {
    const { stdout } = await options.runBd(argv, {
      cwd: options.cwd,
      stdin: undefined,
      timeoutInMs: BEAD_READ_TIMEOUT_MS,
      maxBufferInBytes: BEAD_READ_MAX_BUFFER_BYTES,
    });
    return { ok: true, comments: parseBeadComments(JSON.parse(stdout)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Milliseconds for a bd ISO timestamp; NaN when bd printed something else. */
export function commentTimeInMs(comment: BeadComment): number {
  return Date.parse(comment.createdAt);
}
