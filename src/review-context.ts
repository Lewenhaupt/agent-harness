/**
 * Review scoping and output bounding (bd-113).
 *
 * Review was 47% of recorded workflow spend, and most of that spend produced
 * no Critical finding: reviewers re-derived a change set the implement phase
 * already knew, re-explored the whole repository on every re-review, and
 * emitted narration bullets that invited a longer, more expensive response.
 *
 * This module narrows *scope* (inline the diff, scope a re-review to the fix
 * round) and *output shape* (bounded sections, defect-only bullets). It never
 * downgrades the reviewer's model class or drops a security convention: the
 * criticals measured for this bead were real, so review depth stays intact.
 */

import { execFile } from "node:child_process";
import { DEFAULT_BASE_BRANCH } from "./stack-rebase.js";

/** Per-section bullet caps enforced by {@link boundReviewOutput}. */
export const REVIEW_SECTION_LIMITS = {
  critical: 6,
  warnings: 6,
  suggestions: 4,
} as const;

/** Severities whose sections the output contract bounds. */
export type ReviewSeverity = keyof typeof REVIEW_SECTION_LIMITS;

/**
 * The single source of truth for the reviewer's output shape. The reviewer
 * system prompt and every review task embed this string, so the contract
 * cannot drift between the agent definition and the harness.
 */
export const REVIEW_OUTPUT_CONTRACT: string = [
  "Emit exactly these sections, in this order: `## Critical (must fix)`, `## Warnings (should fix)`, `## Suggestions (consider)`, and optionally `## Summary`.",
  `Cap each findings section: at most ${REVIEW_SECTION_LIMITS.critical} Critical, ${REVIEW_SECTION_LIMITS.warnings} Warnings, ${REVIEW_SECTION_LIMITS.suggestions} Suggestions bullets.`,
  "Every findings bullet MUST have the shape `- `path/to/file.ts:LINE` — <defect>`: a concrete defect at a concrete location, not a description of what the code does.",
  'When a findings section has no findings, its entire body MUST be exactly `None`. No "✓ correct" bullets, no verification narration, no "checked X, looks fine" bullets.',
  "Do not restate the diff or list reviewed files bullet-by-bullet; one optional `## Scope` line naming the diff range is enough.",
].join("\n");

const SEVERITY_HEADINGS: ReadonlyArray<{ severity: ReviewSeverity; pattern: RegExp }> = [
  { severity: "critical", pattern: /^##\s+critical\b/i },
  { severity: "warnings", pattern: /^##\s+warnings?\b/i },
  { severity: "suggestions", pattern: /^##\s+suggestions?\b/i },
];

const BULLET_PATTERN = /^\s*[-*+]\s+/;
// Markers this module emits. Recognised so a second bounding pass is a no-op
// instead of treating a marker as narration and dropping it.
const TRUNCATION_NOTE_PATTERN = /^[-*+]\s+\(\+\d+ more omitted\b/;
const MALFORMED_NOTE_PATTERN = /^[-*+]\s+\(\+\d+ malformed bullets dropped\b/;
const FILE_LOCATION_PATTERN = /[\w./-]+:\d+/;

function severityOfHeading(line: string): ReviewSeverity | undefined {
  const trimmed = line.trim();
  for (const entry of SEVERITY_HEADINGS) {
    if (entry.pattern.test(trimmed)) return entry.severity;
  }
  return undefined;
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line.trim());
}

function isBullet(line: string): boolean {
  return BULLET_PATTERN.test(line);
}

function isTruncationNote(line: string): boolean {
  return TRUNCATION_NOTE_PATTERN.test(line.trim());
}

function isBoundMarkerNote(line: string): boolean {
  const trimmed = line.trim();
  return TRUNCATION_NOTE_PATTERN.test(trimmed) || MALFORMED_NOTE_PATTERN.test(trimmed);
}

function bulletText(line: string): string {
  return line.trim().replace(BULLET_PATTERN, "").trim();
}

/**
 * True when a leading bullet token names a file: it carries a `/` or a file
 * extension. Requiring the path to lead the bullet is what keeps
 * "Checked `src/a.ts` and it is fine" classified as narration.
 */
function looksLikeFilePathToken(token: string): boolean {
  const bare = token.replace(/`/g, "").replace(/:\d+$/, "");
  if (bare === "") return false;
  if (bare.includes("/")) return true;
  return /\.[A-Za-z0-9]+$/.test(bare);
}

/**
 * A bullet is a finding when it points at a location. "None" marks an
 * intentionally empty section. A path-only bullet (no `:LINE`) is accepted
 * because a real finding may not have a line number yet; narration bullets
 * (leading ✓ or prose) are dropped and disclosed by the caller.
 */
function isFindingBullet(line: string): boolean {
  const text = bulletText(line);
  if (text.toLowerCase() === "none") return true;
  const [firstToken] = text.split(/\s+/);
  if (firstToken !== undefined && looksLikeFilePathToken(firstToken)) return true;
  // A `file:line` anywhere still counts: the contract's canonical shape.
  return FILE_LOCATION_PATTERN.test(text);
}

function truncationNote(omitted: number): string {
  return `- (+${omitted} more omitted; see the full findings in the review transcript)`;
}

function malformedNote(dropped: number): string {
  return `- (+${dropped} malformed bullets dropped; see the full findings in the review transcript)`;
}

function takeSectionBody(
  lines: readonly string[],
  start: number,
): { body: string[]; next: number } {
  const body: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || isHeading(line)) break;
    body.push(line);
    index += 1;
  }
  return { body, next: index };
}

/**
 * Classify one section's body into kept lines, prior markers, and drop counts.
 * Extracted from {@link boundSectionBody} to stay under the complexity budget.
 */
function partitionSectionBody(
  body: readonly string[],
  limit: number,
): { kept: string[]; notes: string[]; omitted: number; malformed: number } {
  const kept: string[] = [];
  const notes: string[] = [];
  let keptBullets = 0;
  let omitted = 0;
  let malformed = 0;
  for (const line of body) {
    if (isBoundMarkerNote(line)) {
      notes.push(line);
      continue;
    }
    if (!isBullet(line)) {
      kept.push(line);
      continue;
    }
    if (!isFindingBullet(line)) {
      malformed += 1;
      continue;
    }
    if (keptBullets >= limit) {
      omitted += 1;
      continue;
    }
    kept.push(line);
    keptBullets += 1;
  }
  return { kept, notes, omitted, malformed };
}

/**
 * Cap one section's findings bullets, drop narration bullets, and append the
 * omission markers once each. Existing markers are preserved (not counted, not
 * duplicated) so re-bounding already-bounded text is idempotent.
 */
function boundSectionBody(
  body: readonly string[],
  limit: number,
): { lines: string[]; truncated: boolean } {
  const { kept, notes, omitted, malformed } = partitionSectionBody(body, limit);
  // Keep the section's trailing blank lines after the markers so the rendered
  // markdown spacing survives bounding.
  const trailing: string[] = [];
  while (kept.length > 0) {
    const last = kept[kept.length - 1];
    if (last === undefined || last.trim() !== "") break;
    kept.pop();
    trailing.unshift(last);
  }
  const lines = [...kept, ...notes];
  if (omitted > 0 && !notes.some((note) => isTruncationNote(note))) {
    lines.push(truncationNote(omitted));
  }
  if (malformed > 0 && !notes.some((note) => MALFORMED_NOTE_PATTERN.test(note.trim()))) {
    lines.push(malformedNote(malformed));
  }
  lines.push(...trailing);
  return { lines, truncated: omitted > 0 };
}

/**
 * Apply the review output contract to delivered review text. Unknown sections
 * and non-findings content pass through untouched; only the severity sections
 * are bounded, in place, without reordering.
 */
export function boundReviewOutput(text: string): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  const output: string[] = [];
  let truncated = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    output.push(line);
    index += 1;
    const severity = severityOfHeading(line);
    if (severity === undefined) continue;
    const section = takeSectionBody(lines, index);
    index = section.next;
    const bounded = boundSectionBody(section.body, REVIEW_SECTION_LIMITS[severity]);
    output.push(...bounded.lines);
    truncated = truncated || bounded.truncated;
  }
  return { text: output.join("\n"), truncated };
}

/** How much of a review a diff scopes: docs-only diffs get a cheaper pass. */
export type DiffScope = "docs-only" | "code";

const DOCS_ONLY_EXTENSIONS: readonly string[] = [
  ".md",
  ".mdx",
  ".markdown",
  ".txt",
  ".rst",
  ".adoc",
];

const DOCS_ONLY_BASENAMES = /^(readme|license|licence)(\.[^/]*)?$/i;

function isDocsOnlyPath(path: string): boolean {
  const lower = path.toLowerCase();
  // Committed diagrams live under docs/ but are HTML; they are still docs.
  if (lower.startsWith("docs/")) return true;
  if (DOCS_ONLY_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  const basename = lower.split("/").at(-1);
  if (basename === undefined) return false;
  return DOCS_ONLY_BASENAMES.test(basename);
}

/**
 * Classify a change set as docs-only or code. An empty list means the change
 * set is unknown, which must take the full adversarial review path.
 */
export function classifyDiffScope(changedFiles: readonly string[]): DiffScope {
  if (changedFiles.length === 0) return "code";
  return changedFiles.every(isDocsOnlyPath) ? "docs-only" : "code";
}

/** The bounded diff a review task inlines. */
export interface ReviewDiff {
  /** `first` reviews the whole change; `rereview` covers only the fix round. */
  mode: "first" | "rereview";
  /** Clean human-readable scope label, e.g. `abc1234` or a fallback note. */
  range: string;
  changedFiles: string[];
  /**
   * Paths git reports as untracked. They are absent from `git diff`, so the
   * task lists them explicitly and `changedFiles` includes them.
   */
  untrackedFiles: string[];
  stat: string;
  diff: string;
  truncated: boolean;
  docsOnly: boolean;
}

export interface CollectReviewDiffOptions {
  cwd: string;
  /** Base branch for a first review. Defaults to {@link DEFAULT_BASE_BRANCH}. */
  baseRef?: string;
  /**
   * HEAD sha recorded after the previous review. When present the collection
   * switches to fix-diff (re-review) mode.
   */
  reviewedSha?: string;
}

export type CollectReviewDiffResult =
  | { ok: true; value: ReviewDiff }
  | { ok: false; error: string };

const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DIFF_MAX_LINES = 800;
const DIFF_MAX_BYTES = 60_000;
// A reviewed sha must be a full or abbreviated git object name. Anything else
// (a ref name, a bogus value) is rejected instead of handed to `git diff`.
const REVIEWED_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type GitResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Run git with an explicit argv array (no shell) and resolve its stdout.
 *
 * Wrapped by hand rather than with `promisify(execFile)`: that resolves with
 * only the callback's second argument, while real execFile's custom promisify
 * resolves `{ stdout, stderr }`. The callback shape is identical either way, so
 * this wrapper behaves the same against real git and against test doubles.
 */
function execFileStdout(file: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { cwd, maxBuffer: GIT_MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      },
    );
    // Close stdin explicitly: git never reads it here, and leaving it open
    // keeps a test double that awaits the close from ever calling back.
    if (child.stdin) {
      // A child that exits before consuming stdin turns the pending write into
      // EPIPE; without a listener that surfaces as an unhandled stream error.
      child.stdin.on("error", () => {});
      child.stdin.end("");
    }
  });
}

/** Run git and never throw: failures come back as an error value. */
async function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  try {
    return { ok: true, value: await execFileStdout("git", args, cwd) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Cut a string to at most maxBytes of UTF-8 output, trimming any trailing
 * partial character. Caps a single oversized diff line.
 */
function cutToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  return new TextDecoder("utf-8", { fatal: false })
    .decode(buffer.subarray(0, maxBytes))
    .replace(/\uFFFD+$/u, "")
    .trimEnd();
}

/**
 * Bound an inlined diff by lines and bytes. A single oversized line (minified
 * bundle, lockfile blob) is cut rather than let through whole, so the byte
 * budget always holds — including the truncation note appended below it.
 */
function boundDiff(raw: string, diffArg: string): { diff: string; truncated: boolean } {
  const lines = raw.split("\n");
  const kept: string[] = [];
  let usedBytes = 0;
  let consumed = 0;
  let partial = false;
  let truncated = false;
  for (const line of lines) {
    if (kept.length >= DIFF_MAX_LINES) {
      truncated = true;
      break;
    }
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    const remaining = DIFF_MAX_BYTES - usedBytes;
    if (lineBytes <= remaining) {
      kept.push(line);
      usedBytes += lineBytes;
      consumed += 1;
      continue;
    }
    const cut = cutToBytes(line, remaining - 1);
    if (cut !== "") kept.push(cut);
    consumed += 1;
    partial = true;
    truncated = true;
    break;
  }
  if (!truncated) return { diff: raw, truncated: false };
  const omitted = Math.max(0, lines.length - consumed) + (partial ? 1 : 0);
  const note = `... (diff truncated: ${omitted} more lines; run \`git diff ${diffArg}\` for the rest)`;
  const budget = DIFF_MAX_BYTES - Buffer.byteLength(note, "utf8") - 1;
  const body = cutToBytes(kept.join("\n"), budget);
  return { diff: `${body}\n${note}`, truncated: true };
}

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Git C-quotes paths with unusual characters; unquote the common case. */
function unquoteGitPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    return path.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return path;
}

/**
 * Extract untracked paths from `git status --porcelain`. Untracked files never
 * appear in `git diff`, so without this the reviewer would be told not to look
 * for exactly the files a new change is most likely to contain.
 */
function parseUntrackedPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    const path = unquoteGitPath(line.slice(3).trim());
    if (path !== "") paths.push(path);
  }
  return paths;
}

interface DiffSegmentOptions {
  cwd: string;
  mode: ReviewDiff["mode"];
  /** Ref/sha handed to `git diff`. */
  diffArg: string;
  /** Clean label rendered to the reviewer. */
  range: string;
}

async function collectDiffSegment(options: DiffSegmentOptions): Promise<CollectReviewDiffResult> {
  const stat = await runGit(["diff", "--stat", options.diffArg], options.cwd);
  if (!stat.ok) return stat;
  const names = await runGit(["diff", "--name-only", options.diffArg], options.cwd);
  if (!names.ok) return names;
  const raw = await runGit(["diff", options.diffArg], options.cwd);
  if (!raw.ok) return raw;
  const status = await runGit(["status", "--porcelain"], options.cwd);
  if (!status.ok) return status;
  const untrackedFiles = parseUntrackedPaths(status.value);
  const changedFiles = [...new Set([...nonEmptyLines(names.value), ...untrackedFiles])];
  // The truncation hint names the actual git argument, so it stays valid on the
  // merge-base-fallback path where `range` carries an explanatory note.
  const bounded = boundDiff(raw.value, options.diffArg);
  return {
    ok: true,
    value: {
      mode: options.mode,
      range: options.range,
      changedFiles,
      untrackedFiles,
      stat: stat.value.trim(),
      diff: bounded.diff,
      truncated: bounded.truncated,
      docsOnly: classifyDiffScope(changedFiles) === "docs-only",
    },
  };
}

/**
 * Collect the diff a review should cover.
 *
 * A first review diffs from the merge base (working tree included, so
 * uncommitted work is reviewed too). A re-review diffs from the recorded
 * reviewed sha — the fix round only — and never silently falls back to the
 * whole change set: on failure the caller decides, with the error in hand.
 */
export async function collectReviewDiff(
  options: CollectReviewDiffOptions,
): Promise<CollectReviewDiffResult> {
  if (options.reviewedSha !== undefined && options.reviewedSha !== "") {
    if (!REVIEWED_SHA_PATTERN.test(options.reviewedSha)) {
      return { ok: false, error: `Invalid reviewed sha: ${options.reviewedSha}` };
    }
    return collectDiffSegment({
      cwd: options.cwd,
      mode: "rereview",
      diffArg: options.reviewedSha,
      range: options.reviewedSha,
    });
  }
  const baseRef = options.baseRef ?? DEFAULT_BASE_BRANCH;
  const mergeBase = await runGit(["merge-base", baseRef, "HEAD"], options.cwd);
  if (mergeBase.ok) {
    const sha = mergeBase.value.trim();
    if (sha !== "") {
      return collectDiffSegment({ cwd: options.cwd, mode: "first", diffArg: sha, range: sha });
    }
  }
  // Shallow clone or unrelated histories: diff against the base branch tip and
  // say so in the range, so the reviewer knows the scope is approximate.
  return collectDiffSegment({
    cwd: options.cwd,
    mode: "first",
    diffArg: baseRef,
    range: `${baseRef} (merge-base unavailable; diffed against the base branch tip)`,
  });
}

/** Instruction prepended to every review scope: read the diff, not the repo. */
export const REVIEW_SCOPE_INSTRUCTION =
  "Read only files in this diff and, when a call site genuinely matters, their direct callers. Do not run `git diff`/`git status`/repo-wide searches to rediscover the change set.";

const DOCS_ONLY_INSTRUCTION =
  "Docs-only diff: check factual/structural correctness only (links, commands, code samples, duplicated claims). Do not expand into unrelated code review.";

export type FormatReviewTaskOptions =
  | {
      paramsTask: string;
      /**
       * Findings the fix round was asked to address. On a re-review this is the
       * orchestrator's task text itself, which is why the section is skipped
       * when it would merely duplicate the task.
       */
      priorFindings?: string;
      diff: ReviewDiff;
    }
  | {
      paramsTask: string;
      priorFindings?: string;
      /**
       * Set when no diff could be collected. The task then discloses the gap and
       * tells the reviewer to establish the change set itself, instead of
       * silently sending a bare task with a no-discovery instruction.
       */
      diffUnavailable: string;
    };

/** The prior-findings body, or "" when it would merely duplicate the task. */
function priorFindingsFor(priorFindings: string | undefined, paramsTask: string): string {
  const trimmed = priorFindings?.trim() ?? "";
  if (trimmed === "" || trimmed === paramsTask.trim()) return "";
  return trimmed;
}

function outputContractLines(): string[] {
  return ["", "## Output contract", REVIEW_OUTPUT_CONTRACT];
}

/**
 * Compose the review phase prompt when no diff could be collected. Discloses
 * the reason and drops the no-discovery instruction, because in this case the
 * reviewer genuinely has to establish the change set itself.
 */
function formatUnavailableReviewTask(options: {
  paramsTask: string;
  reason: string;
  priorFindings?: string;
}): string {
  const lines = [
    "## Review scope — diff unavailable",
    `diff unavailable (${options.reason}); fall back to your own \`git diff\`/\`git status\` to establish the change set.`,
  ];
  const prior = priorFindingsFor(options.priorFindings, options.paramsTask);
  if (prior !== "") lines.push("", "## Prior findings to verify", prior);
  lines.push(...outputContractLines(), "", "## Task", options.paramsTask);
  return lines.join("\n");
}

/**
 * Compose the review phase prompt: the diff inlined, the prior findings to
 * verify, and the bounded output contract ahead of the orchestrator's task.
 *
 * The reviewer's model class is intentionally untouched by this function — and
 * by the harness-override path in `extensions/index.ts` — because bd-113's
 * measured criticals were real. Only scope and output shape are narrowed.
 */
export function formatReviewTask(options: FormatReviewTaskOptions): string {
  if ("diffUnavailable" in options) {
    return formatUnavailableReviewTask({
      paramsTask: options.paramsTask,
      reason: options.diffUnavailable,
      ...(options.priorFindings !== undefined ? { priorFindings: options.priorFindings } : {}),
    });
  }
  const { diff } = options;
  const modeLabel = diff.mode === "rereview" ? "re-review of fixes" : "first review";
  const lines = [
    "## Review scope — diff inlined, do NOT re-derive the change set",
    `mode: ${modeLabel}`,
    `range: ${diff.range}`,
    `changed files: ${diff.changedFiles.length} (docs-only diff: ${diff.docsOnly ? "yes" : "no"})`,
    "",
    REVIEW_SCOPE_INSTRUCTION,
  ];
  if (diff.docsOnly) lines.push("", DOCS_ONLY_INSTRUCTION);
  lines.push("", "## Changed files", diff.stat === "" ? "(no changed files)" : diff.stat);
  if (diff.untrackedFiles.length > 0) {
    lines.push(
      "",
      "New (untracked) files — read these directly; they are not in the diff:",
      ...diff.untrackedFiles.map((path) => `- \`${path}\``),
    );
  }
  lines.push("", "```diff", diff.diff, "```");
  const prior = priorFindingsFor(options.priorFindings, options.paramsTask);
  if (prior !== "") lines.push("", "## Prior findings to verify", prior);
  lines.push(...outputContractLines(), "", "## Task", options.paramsTask);
  return lines.join("\n");
}

/** Findings per severity in one review delivery. */
export interface ReviewFindingCounts {
  critical: number;
  warnings: number;
  suggestions: number;
}

/**
 * Count the findings bullets a review reported, per severity section.
 *
 * Used by the metrics log (bd-140): "did this review find anything, and how
 * serious was it" is the signal that tells us whether the review phase earns its
 * keep. A `None` body counts as zero, and the bounding markers this module
 * appends are not findings.
 */
export function countReviewFindings(text: string): ReviewFindingCounts {
  const counts: ReviewFindingCounts = { critical: 0, warnings: 0, suggestions: 0 };
  let current: ReviewSeverity | undefined;
  for (const line of text.split("\n")) {
    const severity = severityOfHeading(line);
    if (severity !== undefined) {
      current = severity;
      continue;
    }
    if (current === undefined) continue;
    if (isHeading(line)) {
      current = undefined;
      continue;
    }
    if (!isBullet(line)) continue;
    if (isBoundMarkerNote(line)) continue;
    counts[current] += 1;
  }
  return counts;
}
