/**
 * The publication safety surface for deferred review findings (bd-183).
 *
 * bd-184 renders the deferred section of a PR body. This module is the only
 * supported way to obtain that text, which is what makes "no path writes a
 * sensitive finding into a PR body, including on re-publish" structural rather
 * than a one-time filter: {@link renderDeferredFindingsSection} re-derives what
 * may be published from the durable record (`.belayd/review-findings.json`) on
 * every call. There is no cached string to go stale, and nothing to remember to
 * re-check after a round changes.
 *
 * The rules:
 *
 * - only `disposition.kind === "deferred"` findings are candidates (`fixed` was
 *   addressed, `rejected` was declined);
 * - **every** rendered finding goes through {@link projectFindingText}, whatever the
 *   classifier said, so the body carries no credential-shaped run, no path, no code
 *   span and no non-ASCII text — the guarantee lives in the projection, not in the
 *   classifier;
 * - the projection is verified on one canonical reading: the emitted line with every
 *   character outside `[A-Za-z0-9+/=_-]` removed. That is exactly the string a reader
 *   reassembles by eye after deleting the spaces, the punctuation, the brackets and
 *   the printed `[code]`/`[path]`/`[value]` markers, so no separator shape can hide a
 *   split; a body it welds into a 16+ run that passes the guard turns the whole
 *   finding into `[redacted]` ({@link findReassemblyViolations});
 * - a sensitive finding is publishable only through a recorded human decision:
 *   `publish` (raw text for that finding, an explicit per-finding decision) or
 *   `redact` (the one-liner, itself projected);
 * - sensitive with no decision, or with `withhold`, is blocked. A record written
 *   before bd-183 has no decisions at all, so it blocks too — the safe default is
 *   "a human has not said yes yet".
 *
 * **The classifier is advisory.** It decides whether to *ask a human*, not whether
 * the text is safe to publish. "Is this string a secret?" is unbounded pattern
 * recognition against an adversary who can insert separators, homoglyphs or
 * brackets; every review round found another evasion. So the publish path stopped
 * depending on the answer: it emits a projection whose reassembly check welds the
 * emitted line back together on the canonical reading, so an under-match on a
 * class-mixed body is caught. Over-matching still costs one human question, which
 * is why the classifier stays as narrow as it can while being fail-closed.
 *
 * **The guarantee is exactly this.** A body is caught when removing everything
 * outside `[A-Za-z0-9+/=_-]` welds it into a 16+ character run that passes the guard
 * below. **One residual is stated, not hidden.** A body with no class mixing at all — all
 * one case with digits only at one end (`deadbeefdeadbeef`), all uppercase, or all
 * digits — is indistinguishable from welded prose, so it survives the projection
 * and publishes verbatim; Title-Case prose is redacted wholesale by the same guard.
 * Separating those from prose needs a dictionary, and redacting every long
 * single-case run eats genuine sentences and numeric configuration, so the trade is
 * documented in `docs/bd-183-userguide.md` instead of guessed at.
 *
 * `evaluateDeferredFindingsGate` answers "may the deferred section publish at
 * all?", while {@link renderDeferredFindingsSection} renders whatever subset is
 * publishable. The split matters for a mixed record: while one sensitive finding
 * awaits a human answer the gate is closed, but the non-sensitive deferrals stay
 * publishable so the PR is not held hostage by an unrelated security finding.
 *
 * Pure: record in, verdict/text out. `src/review-findings.ts` owns the record
 * I/O and `src/finding-sensitivity.ts` owns the rules.
 */

import { normalizeFindingText } from "./finding-sensitivity.js";
import {
  isSensitiveFinding,
  type ReviewFindingRecord,
  type ReviewFindingsRecord,
} from "./review-findings.js";

/** Cap bd-184 inherits: more than a handful of bullets is not a summary. */
const DEFAULT_MAX_DEFERRED_FINDINGS = 5;

/**
 * Cap for one rendered finding, in code points.
 *
 * why: a deferred finding is a pointer for the PR reader, not a transcript. The cap
 * also bounds what a projection can leave behind on a pathological record.
 */
const DEFAULT_MAX_FINDING_CHARS = 200;

/** A fenced block; its contents may be a credential and are never trusted. */
const FENCED_CODE_PATTERN = /```[\s\S]*?```/gu;

/** An inline code span; the same reasoning as a fenced block. */
const INLINE_CODE_PATTERN = /`[^`]*`/gu;

/**
 * A `fence` or span marker left by the replacement, so the reader sees that
 * something was removed instead of an unexplained gap.
 */
const CODE_MARKER = "[code]";

/** The token replacement for a location (`src/a.ts:12`, `~/.ssh/id_rsa`). */
const PATH_MARKER = "[path]";

/** The replacement for an assignment value or an opaque run. */
const VALUE_MARKER = "[value]";

/**
 * The wholesale marker: the projection of a finding no fragment of which may
 * publish. Also the empty-projection fallback, so a renderer never substitutes
 * the raw finding for nothing.
 */
const REDACTED_MARKER = "[redacted]";

/** A whitespace run; the projection collapses it, the reassembly check deletes it. */
const WHITESPACE_RUN_PATTERN = /\s+/gu;

/**
 * Token separators: anything that ends a path or value token in prose, markdown
 * or inline code. Capturing, so the separators survive the rejoin.
 */
const PROJECTION_TOKEN_DELIMITERS = /([\s,;()<>'"`[\]{}|]+)/u;

/** Sentence punctuation around a token is not part of the location it names. */
const TOKEN_EDGE_PUNCTUATION = /^[.,;:!?]+|[.,;:!?]+$/gu;

/**
 * A file name: a letter-led token with a short alphanumeric extension.
 *
 * why letter-led and letter-suffixed: `.env`/`item.pem` are paths, while `1.0.2`
 * and `e.g.` are prose and must not disappear from a summary.
 */
const FILE_NAME_PATTERN = /^[A-Za-z][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/u;

/**
 * A `key[:=]value` whose value has enough body to be worth replacing.
 *
 * why the length threshold: `note: the` and `see: below` are prose, and replacing
 * them would make the summary unreadable; a value-shaped run of six or more
 * characters is what documentation writes as a value. Short values are still
 * covered by the path and opaque-run rules when they are shaped like one.
 *
 * why `[` and `]` are excluded from the value class: the marker this rule prints
 * (`[value]`) must not be re-read as a value on a second projection, or the text
 * grows on every render (`password = [value]} in compose` → `…[value]]}…`).
 * Projection is idempotent, and the property test pins that.
 */
const ASSIGNMENT_PATTERN =
  /(\b[A-Za-z_][\w.-]{0,39}\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^[\s,;()\]}]{6,})/gu;

/** An opaque run: the shape of every token body and key material. */
const OPAQUE_RUN_PATTERN = /[A-Za-z0-9+/=_-]{16,}/gu;

/**
 * Anything outside printable ASCII; the projection's invariant is that none of it
 * survives, so the same pattern replaces and verifies.
 */
const NON_ASCII_PATTERN = /[^\x20-\x7E]/gu;

/**
 * Benign typography, folded to the ASCII it reads as.
 *
 * why fold instead of `?`: the invariant is "printable ASCII", not "mangled". An
 * em dash, a curly quote and an ellipsis carry no hidden word, so replacing them
 * with `?` costs the reader a sentence for nothing — `secret — rotation` should
 * read `secret - rotation`. Anything else (a lookalike, an accent) is still `?`,
 * because that is text no rule could read.
 */
const TYPOGRAPHY_FOLD_PATTERN = /[\u2013\u2014\u2018\u2019\u201C\u201D\u2026]/gu;

/** The ASCII each folded character becomes; an ellipsis keeps its length in dots. */
const TYPOGRAPHY_ASCII: Readonly<Record<string, string>> = {
  "\u2013": "-",
  "\u2014": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u2026": "...",
};

/**
 * HTML comment syntax. A bullet that contains `<!-- belayd:usage -->` would forge a
 * bd-174.3 marker pair, so both delimiters are neutralized as text, not as comment.
 *
 * why not rely on the newline collapse: forging needs no newline at all. The 5-char
 * `usage` value slips under {@link ASSIGNMENT_PATTERN}'s 6-char value threshold, so
 * `<!-- belayd:usage -->` passed through verbatim while the longer markers were
 * destroyed only incidentally (round 10, Warning). The delimiters are removed
 * whatever surrounds them, which also covers a split spelling.
 */
const HTML_COMMENT_DELIMITER_PATTERN = /<!--|-->/gu;

/**
 * A backtick run of two or more: a fence opener, a fence closer or a
 * double-backtick span.
 *
 * why every run and not a parity count (round 12): a longer run is still a valid
 * opener, so parity cannot decide anything — six backticks count as even and open a
 * real fence that swallows the rest of the body. Replacing all of them is applied
 * after the complete-fence pass, so a paired fence is dropped with its content and
 * every leftover run goes too.
 */
const MULTI_BACKTICK_PATTERN = /`{2,}/gu;

/**
 * A tilde run of two or more: `~~` is strikethrough and three or more open a
 * fenced block, neither of which a finding may do to the body around it.
 */
const TILDE_FENCE_PATTERN = /~{2,}/gu;

/** A single backtick left after the span passes: an orphan no rule paired. */
const ORPHAN_BACKTICK_PATTERN = /`/gu;

/** A run shorter than this cannot be a token body, split or not. */
const REASSEMBLY_MIN_RUN = 16;

/**
 * Digits separated by letters: a token body interleaves its digits and letters
 * (`16C7e42F…`, `8f14e45f…`), while prose numbers do not — `lines 1-9 are stale`
 * deletes to `lines1-9arestale`, which has no digit-letter-digit span.
 */
const INTERLEAVED_DIGIT_PATTERN = /[0-9][A-Za-z]+[0-9]/u;

/** The case classes the reassembly guard distinguishes. */
const LOWER_LETTER_PATTERN = /[a-z]/u;
const UPPER_LETTER_PATTERN = /[A-Z]/u;

/**
 * True when a token names a location rather than a word.
 *
 * why these three shapes: a slash is a path by definition, a leading `~` is a home
 * directory even with no slash yet, and a letter-led extension is a file name
 * (`item.pem`, `id_rsa.bak`). Everything else stays prose, so the projection
 * keeps the finding readable.
 */
function isPathLikeToken(token: string): boolean {
  if (token.includes("/") || token.includes("\\")) return true;
  if (token.startsWith("~")) return true;
  return FILE_NAME_PATTERN.test(token);
}

/** A token without the sentence punctuation around it. */
function trimTokenEdges(token: string): string {
  return token.replace(TOKEN_EDGE_PUNCTUATION, "");
}

/**
 * Replace every location-shaped token with {@link PATH_MARKER}, keeping prose.
 *
 * Splitting with a capturing separator keeps the separators, so the sentence around
 * a path survives unchanged; only the token itself is replaced.
 */
function replacePathTokens(text: string): string {
  return text
    .split(PROJECTION_TOKEN_DELIMITERS)
    .map((part) => (isPathLikeToken(trimTokenEdges(part)) ? PATH_MARKER : part))
    .join("");
}

/** Fold benign typography to ASCII, leaving every other character untouched. */
function foldBenignTypography(text: string): string {
  return text.replace(
    TYPOGRAPHY_FOLD_PATTERN,
    (character) => TYPOGRAPHY_ASCII[character] ?? character,
  );
}

/** Replace HTML comment delimiters, so no bullet can forge a marker pair. */
function neutralizeCommentDelimiters(text: string): string {
  return text.replace(HTML_COMMENT_DELIMITER_PATTERN, ` ${CODE_MARKER} `);
}

/**
 * Replace every fence run, so no bullet can open a code region or restyle the body.
 *
 * why unconditional (round 12): Markdown opens a fence on any run of at least the
 * marker length and closes it on the next run of at least that length, so no count
 * is safe to keep — six backticks look even but open a valid fence, and a run
 * longer than its closer still opens one. Parity cannot describe that, so every run
 * goes; a reader loses a decoded example, the body keeps its text.
 */
function neutralizeFenceRuns(text: string): string {
  return text
    .replace(MULTI_BACKTICK_PATTERN, ` ${CODE_MARKER} `)
    .replace(TILDE_FENCE_PATTERN, ` ${CODE_MARKER} `);
}

/** Adjacent letter pairs that flip case: a base64 body does, prose does not. */
function caseFlipCount(run: string): number {
  let flips = 0;
  let previous = "";
  for (const character of run) {
    const flipped =
      (LOWER_LETTER_PATTERN.test(previous) && UPPER_LETTER_PATTERN.test(character)) ||
      (UPPER_LETTER_PATTERN.test(previous) && LOWER_LETTER_PATTERN.test(character));
    if (flipped) flips += 1;
    previous = character;
  }
  return flips;
}

/**
 * True when a run reads as a token body however it was split.
 *
 * why the reassembled reading exists at all: the contiguous run rule is defeated by
 * any split into pieces shorter than 16 characters. Inserting spaces (or commas, or
 * brackets) into `16C7e42F292c6912E7710c838347Ae178B4a` gives chunks of 15, 11 and
 * 10 characters, none of which the substitution sees, and deleting those separators
 * again reassembles the body (round 10, Critical).
 *
 * why the guard is not "contains a digit and a letter": welding ordinary
 * prose puts one number inside its words — `a 16 character sentence of words`
 * deletes to `a16charactersentenceofwords` and must still project as written — and
 * a hyphenated range looks like two numbers, not a body. So a run has to look
 * *interleaved*: digits separated by letters (`16C7e42F…`, `8f14e45f…`, a UUID),
 * or case flips on a third of its pairs (base64). `off by one in the loop bound`,
 * `the deferred findings are capped` and `lines 1-9 are stale` have neither, and
 * neither do `the IPv6 path` or `the Backtrace Shows IPv6 Fallbacks` (5 flips on 30
 * characters), which is why the case guard is a density and not "contains
 * uppercase".
 *
 * The case guard does fire on Title-Case prose: `The Retry Logic Is Bounded` flips
 * on 3 of its 21 pairs and tightens to the third-of-pairs density once the spaces
 * go, so an ordinary sentence written that way is redacted wholesale. That is the
 * accepted cost — the alternative density that spares it also spares base64 — and
 * it is pinned by a test rather than left to be discovered (`docs/bd-183-userguide.md`
 * states it as a cost, not a mistake).
 *
 * The residual is stated rather than hidden. Three shapes publish verbatim and
 * reassemble by eye — all one case with digits only at one end (`0123456789abcdef`,
 * `deadbeefdeadbeef`, `mfrggzdfmztwq2lk`), all uppercase letters
 * (`ABCDEFGHIJKLMNOP`), and all digits (`1234567890 123456`) — while Title-Case
 * prose is redacted wholesale, which is the cost described above. Separating the
 * three from prose would take a dictionary, and redacting every long single-case
 * run would eat genuine sentences and numeric configuration; the classifier's
 * anchors (`ghp_`, `AKIA`, PEM headers, `BEARER`) are the rules that catch those
 * families, and this guard is the projection's backstop for the shapes that have
 * no anchor and interleave.
 */
function isReassemblableRun(run: string): boolean {
  if (run.length < REASSEMBLY_MIN_RUN) return false;
  if (INTERLEAVED_DIGIT_PATTERN.test(run)) return true;
  return caseFlipCount(run) >= Math.ceil(run.length / 3);
}

/**
 * Everything a reader deletes when reassembling a body by eye.
 *
 * why one class and not a list of separators: the reader is not enumerating
 * separators either — they drop whatever is not part of the token, so spaces,
 * commas, `;`, `|`, brackets, quotes, an em dash and a zero-width character all
 * disappear the same way. Round 12 proved the enumeration could not be completed: a
 * comma-separated body split into 6-character chunks escaped both readings because
 * neither dropped the comma.
 */
const REASSEMBLY_DELETED_PATTERN = /[^A-Za-z0-9+/=_-]+/gu;

/** The canonical reading: `text` with everything outside a token body removed. */
function reassembledReading(text: string): string {
  return text.replace(REASSEMBLY_DELETED_PATTERN, "");
}

/**
 * The token bodies and structural paths one reading reassembles.
 *
 * The printed `[code]`/`[path]`/`[value]` markers are published text, so a reader
 * drops their brackets too; the run-class deletion does that as part of the one
 * reading, which is why a marker standing in for a separator needs no second pass
 * (round 11, Critical).
 */
function reassemblyViolations(reading: string): readonly string[] {
  const violations: string[] = [];
  for (const run of reading.match(OPAQUE_RUN_PATTERN) ?? []) {
    if (isReassemblableRun(run)) violations.push(`reassembled run: ${run}`);
  }
  // why a bare slash check: the reading has dropped every separator, and the
  // file-name shape is excluded above, so a surviving `/` is the whole structural
  // signal left (a backslash and a leading `~` are outside the run class and never
  // reach here).
  if (reading.includes("/")) violations.push("reassembled path: /");
  return violations;
}

/**
 * Everything `text` reassembles into on the canonical reading; empty when safe.
 *
 * Single-sourced: {@link projectFindingText} rejects wholesale on a non-empty
 * result and {@link findProjectionViolations} reports the same strings, so the
 * renderer and the tests cannot disagree about what a split hides.
 *
 * One reading, because every separator a reader ignores is already outside the run
 * class: spaces, tabs, newlines, the token delimiters, the brackets around the
 * printed markers, typography that is not a letter — all deleted. A body split into
 * pieces shorter than 16 characters therefore shows up whole, which is the only
 * split the contiguous run rule cannot see.
 *
 * The path arm keeps only the structural shape of {@link isPathLikeToken}. why not
 * the file-name shape as well: a welded sentence boundary has it — `the loop is
 * slow. fix it` deletes to `theloopisslowfixit` — and redacting every finding that
 * ends a sentence would cost bd-184 its summary. An unsplit file name is still
 * replaced per token by {@link replacePathTokens}.
 */
export function findReassemblyViolations(text: string): readonly string[] {
  return reassemblyViolations(reassembledReading(text));
}

/** Cap by code point, ending a truncated projection with ASCII `...`. */
function capProjected(text: string, maxChars: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  if (maxChars <= 3) return characters.slice(0, maxChars).join("");
  return `${characters
    .slice(0, maxChars - 3)
    .join("")
    .trimEnd()}...`;
}

/**
 * The only shape in which deferred-finding text may reach a PR body.
 *
 * Deterministic, lossy on the safe side, and independent of the classifier: it
 * cannot know whether the text *is* a secret, so it removes everything a secret
 * could hide in. The result satisfies
 * {@link findProjectionViolations} by construction:
 *
 * 1. normalise (`\p{Cf}` stripped, NFKC), so a fullwidth or invisible spelling is
 *    projected like the ASCII it reads as, and fold benign typography to ASCII
 *    (`—` → `-`, `’` → `'`, `…` → `...`) — before any substitution, because the
 *    fold welds words and a weld is exactly what the run rule must see;
 * 2. HTML comment delimiters become `[code]`, so a bullet cannot forge a bd-174.3
 *    marker pair;
 * 3. fenced blocks and inline code spans become `[code]` — a span can carry a
 *    credential no rule describes, so its content is not trusted;
 * 4. every remaining backtick run of two or more and every tilde run of two or
 *    more become `[code]`, and so does any orphan single backtick, so no bullet can
 *    open a code region or a strikethrough that restyles the body around it (round
 *    12, Warning). This runs after the block pass on purpose: a complete fence is
 *    dropped with its content, and only the leftovers are neutralized;
 * 5. path-like tokens become `[path]`;
 * 6. assignment values become `[value]`;
 * 7. opaque runs (`[A-Za-z0-9+/=_-]{16,}`) become `[value]` — that is exactly the
 *    shape of every token body, hex digest and base64 blob;
 * 8. whitespace collapses to one line;
 * 9. any remaining non-printable-ASCII character becomes `?`;
 * 10. if the canonical reassembled reading still carries a token body or a
 *    structural path ({@link findReassemblyViolations}), or nothing survived, the
 *    whole finding is `[redacted]`;
 * 11. otherwise the text is capped by code point.
 *
 * Steps 6 and 7 run after step 5, so a value that was already replaced is not
 * re-read, and step 9 runs last, so nothing it inserts — and no character the cap
 * keeps — can be a path, an opaque run or a line break. Step 10 is what makes a
 * split body safe: it is checked on the substituted line with every separator a
 * reader ignores deleted, so a chunk that is too short to be a run on its own is
 * judged together with its neighbours whatever the split used — spaces, commas,
 * brackets, or the printed markers themselves.
 */
export function projectFindingText(finding: string, options?: { maxChars?: number }): string {
  const maxChars = Math.max(1, options?.maxChars ?? DEFAULT_MAX_FINDING_CHARS);
  const normalized = foldBenignTypography(normalizeFindingText(finding));
  const withoutCode = neutralizeFenceRuns(
    neutralizeCommentDelimiters(normalized).replace(FENCED_CODE_PATTERN, ` ${CODE_MARKER} `),
  )
    .replace(INLINE_CODE_PATTERN, ` ${CODE_MARKER} `)
    .replace(ORPHAN_BACKTICK_PATTERN, ` ${CODE_MARKER} `);
  const withoutPaths = replacePathTokens(withoutCode);
  const withoutValues = withoutPaths
    .replace(ASSIGNMENT_PATTERN, `$1${VALUE_MARKER}`)
    .replace(OPAQUE_RUN_PATTERN, VALUE_MARKER);
  const singleLine = withoutValues
    .replace(WHITESPACE_RUN_PATTERN, " ")
    .trim()
    .replace(NON_ASCII_PATTERN, "?");
  // why the fallback: an empty bullet would let a renderer substitute the raw
  // finding, exactly like an empty redact one-liner.
  if (singleLine === "") return capProjected(REDACTED_MARKER, maxChars);
  // why wholesale and not a partial mask: there is no fragment of a reassembled
  // body that is safe to keep, and a partly masked line still reveals its shape.
  if (findReassemblyViolations(singleLine).length > 0) {
    return capProjected(REDACTED_MARKER, maxChars);
  }
  return capProjected(singleLine, maxChars);
}

/**
 * Everything about `text` that breaks the projection invariant; empty when safe.
 *
 * Single-sourced with the projection so a test and the renderer cannot disagree
 * about what "safe" means: single line, printable ASCII only, no code delimiter, no
 * opaque run of 16+ characters, no path-like token, and no canonical reassembled
 * reading that welds a token body or a structural path
 * ({@link findReassemblyViolations}).
 */
export function findProjectionViolations(text: string): readonly string[] {
  const violations: string[] = [];
  if (/[\r\n]/u.test(text)) violations.push("not single-line");
  // why a plain check: the pattern is global, so `.test` would carry `lastIndex`.
  if (text.includes("`")) violations.push("code delimiter");
  const nonAscii = text.match(NON_ASCII_PATTERN);
  if (nonAscii !== null) violations.push(`non-ASCII: ${nonAscii.slice(0, 4).join(" ")}`);
  for (const run of text.match(OPAQUE_RUN_PATTERN) ?? []) violations.push(`opaque run: ${run}`);
  for (const part of text.split(PROJECTION_TOKEN_DELIMITERS)) {
    const token = trimTokenEdges(part);
    if (isPathLikeToken(token)) violations.push(`path-like token: ${token}`);
  }
  violations.push(...findReassemblyViolations(text));
  return violations;
}

/**
 * One publishable deferred finding.
 *
 * `text` is the only field that may be rendered, and it is the **projection**
 * ({@link projectFindingText}) except for a finding a human explicitly released
 * with a `publish` decision. `finding` is the record key (kept for diagnostics and
 * for matching a rendered line back to the record); it is the raw text and must
 * never reach a PR body.
 */
export interface PublishableFinding {
  finding: string;
  text: string;
}

/** Why a sensitive deferral blocks publication. */
export type DeferredFindingsBlockReason =
  | "sensitive-findings-awaiting-human"
  | "sensitive-findings-withheld";

/** The gate verdict: either everything publishable, or the blocking findings. */
export type DeferredFindingsGate =
  | { ok: true; publishable: readonly PublishableFinding[] }
  | {
      ok: false;
      reason: DeferredFindingsBlockReason;
      findings: readonly string[];
    };

/** Per-finding assessment, discriminated so no branch ever falls back to raw text. */
type DeferredAssessment =
  | { kind: "publishable"; finding: string; text: string }
  | { kind: "blocked"; finding: string; reason: DeferredFindingsBlockReason };

/**
 * One deferred finding's publishable text, or the reason it is blocked.
 *
 * `isSensitiveFinding` is the live classifier ORed with the stored verdict, never
 * the stored field alone: a record built under an older rule table, or edited to
 * `sensitive: false`, must not make the raw text publishable, and a finding once
 * judged security-class stays that way (bd-183 review, Warning). A record from
 * before bd-183 has no field at all and is classified fresh.
 *
 * The classifier only decides *whether a human is asked*: the text this returns is
 * the projection for every finding, so an under-match on a class-mixed body cannot
 * leak. The single
 * exception is a recorded `publish` decision, which is the human's explicit,
 * per-finding yes to this exact text (raw is allowed there and nowhere else).
 */
function assessDeferredFinding(
  finding: ReviewFindingRecord,
  maxFindingChars: number,
): DeferredAssessment {
  const projected = projectFindingText(finding.finding, { maxChars: maxFindingChars });
  if (!isSensitiveFinding(finding)) {
    return { kind: "publishable", finding: finding.finding, text: projected };
  }
  const publication = finding.publication;
  switch (publication?.kind) {
    case "publish":
      // why raw is allowed here: the human read this finding and chose to publish
      // it as-is; the flag is on this finding, in this round, not on the record.
      return {
        kind: "publishable",
        finding: finding.finding,
        text: capProjected(oneLine(finding.finding), maxFindingChars),
      };
    case "redact": {
      const oneLiner = publication.oneLiner.trim();
      // An empty one-liner is a redact decision with nothing safe to say; treat
      // it as withheld rather than render an empty bullet (or, worse, the raw
      // finding as a fallback).
      return oneLiner === ""
        ? { kind: "blocked", finding: finding.finding, reason: "sensitive-findings-withheld" }
        : {
            kind: "publishable",
            finding: finding.finding,
            // why projected again: the one-liner was derived when the answer was
            // recorded, so it is re-checked against the invariant on every render
            // like every other path.
            text: projectFindingText(oneLiner, { maxChars: maxFindingChars }),
          };
    }
    case "withhold":
      return { kind: "blocked", finding: finding.finding, reason: "sensitive-findings-withheld" };
    case undefined:
      return {
        kind: "blocked",
        finding: finding.finding,
        reason: "sensitive-findings-awaiting-human",
      };
  }
}

/** Narrowing guard: keeps the blocked branch free of a raw-text fallback. */
function isBlockedAssessment(
  assessment: DeferredAssessment,
): assessment is Extract<DeferredAssessment, { kind: "blocked" }> {
  return assessment.kind === "blocked";
}

/** A publishable assessment as a list entry; blocked ones contribute nothing. */
function publishableOf(assessment: DeferredAssessment): readonly PublishableFinding[] {
  return assessment.kind === "publishable"
    ? [{ finding: assessment.finding, text: assessment.text }]
    : [];
}

/** Assessments for the deferred findings only, in record order. */
function assessDeferredFindings(
  record: ReviewFindingsRecord,
  maxFindingChars: number,
): readonly DeferredAssessment[] {
  return record.findings
    .filter((finding) => finding.disposition.kind === "deferred")
    .map((finding) => assessDeferredFinding(finding, maxFindingChars));
}

/** The findings that may appear in a body right now. */
export function selectPublishableFindings(
  record: ReviewFindingsRecord,
  options?: { maxFindingChars?: number },
): readonly PublishableFinding[] {
  return assessDeferredFindings(
    record,
    Math.max(1, options?.maxFindingChars ?? DEFAULT_MAX_FINDING_CHARS),
  ).flatMap(publishableOf);
}

/**
 * May the deferred section publish?
 *
 * An explicit withhold outranks an unanswered finding: "a human said no" is a
 * final answer, and reporting it as still-awaiting would invite the orchestrator
 * to ask again for a decision that already exists.
 */
export function evaluateDeferredFindingsGate(record: ReviewFindingsRecord): DeferredFindingsGate {
  const assessments = assessDeferredFindings(record, DEFAULT_MAX_FINDING_CHARS);
  const blocked = assessments.filter(isBlockedAssessment);
  if (blocked.length > 0) {
    const withheld = blocked.some(
      (assessment) => assessment.reason === "sensitive-findings-withheld",
    );
    return {
      ok: false,
      reason: withheld ? "sensitive-findings-withheld" : "sensitive-findings-awaiting-human",
      findings: blocked.map((assessment) => assessment.finding),
    };
  }
  return { ok: true, publishable: assessments.flatMap(publishableOf) };
}

/**
 * The deferred section of a PR body, or `""` when nothing may be published.
 *
 * **This is the only supported source of deferred-finding text for bd-184.** The
 * item cap lives here (default {@link DEFAULT_MAX_DEFERRED_FINDINGS}) so the body
 * builder inherits it instead of inventing a second limit. The function is pure
 * and re-derives from the record, so calling it again on a re-publish yields the
 * same safe output — that is the re-publish guarantee, not a filter applied once.
 *
 * bd-184 owns the `<!-- belayd:deferred -->` marker pair; this returns the section
 * body only.
 */
export function renderDeferredFindingsSection(
  record: ReviewFindingsRecord,
  options?: { maxItems?: number; maxFindingChars?: number },
): string {
  const maxItems = Math.max(1, options?.maxItems ?? DEFAULT_MAX_DEFERRED_FINDINGS);
  const items = selectPublishableFindings(record, {
    maxFindingChars: options?.maxFindingChars,
  }).slice(0, maxItems);
  if (items.length === 0) return "";
  // why no further processing: `text` is already the projection (or the single
  // human-released raw finding), so re-projecting here would silently discard the
  // hand's `publish as-is` decision.
  const bullets = items.map((item) => `- ${oneLine(item.text)}`);
  return ["### Deferred findings", ...bullets].join("\n");
}

/**
 * A finding must stay on one line, must not carry HTML comment syntax and must not
 * open a fence.
 *
 * The projection neutralizes the comment delimiters already; this repeats it for
 * the one line that skips the projection (a recorded `publish` decision), because
 * a forged bd-174.3 marker breaks the region rewrite whichever path produced it.
 * The fence rule has the same scope and the same reason: any fence opener on the
 * released line swallows or restyles the rest of the PR body, and the human's
 * "publish as-is" is a decision about the finding, not about markdown structure.
 */
function oneLine(text: string): string {
  return neutralizeFenceRuns(neutralizeCommentDelimiters(text))
    .replace(WHITESPACE_RUN_PATTERN, " ")
    .trim();
}
