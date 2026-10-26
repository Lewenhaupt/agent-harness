/**
 * Phase-deliverable records on beads.
 *
 * A phase deliverable (userguide body, research findings, proof verdict) records
 * what one phase produced, so it belongs in the bead's comment thread: every
 * comment is authored, timestamped and ordered, while appended notes all land in
 * one unowned blob. The notes/description/design blob stays the PLAN, which is
 * what `bd show` feeds back into later phase prompts.
 *
 * Every harness-authored comment opens with a `[belayd:<phase>]` header line, so
 * the authoring phase survives even when a reader only sees the comment body.
 */

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
