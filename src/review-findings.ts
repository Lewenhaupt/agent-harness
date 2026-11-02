/**
 * Review findings as a durable, human-visible record (bd-175).
 *
 * A non-empty review used to stop the member `awaiting-human` with the only
 * trace inside the member's worktree (`.belayd/review-findings.md`), so bd,
 * `needs-you` views, and the fleet's own `run.stopped[]` all reported a healthy
 * workflow while a human wait was open. This module turns the review delivery
 * into:
 *
 * 1. a per-finding disposition record (`{ finding, severity, phase, round,
 *    disposition }`) persisted beside the workflow state, so "the findings the
 *    orchestrator chose not to consider" is a queryable set rather than a file
 *    nobody opens; and
 * 2. a bead comment body that names each finding, its severity and its
 *    disposition plus the artifact path — the text a human actually reads.
 *
 * The gate reason is {@link REVIEW_HUMAN_GATE_REASON}: the fleet supervisor
 * imports the same constant for its `awaiting-human` stop detail, so the two
 * can never disagree about what the wait means.
 *
 * This module is pure except for {@link readReviewFindingsRecord} /
 * {@link writeReviewFindingsRecord}, documented best-effort side effects
 * confined to the record file.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  classifyFindingSensitivity,
  type FindingPublicationDecision,
  FindingPublicationDecisionSchema,
  type FindingSensitivity,
  FindingSensitivitySchema,
  mergeFindingSensitivity,
  parsePublicationAnswer,
  redactFindingToOneLiner,
} from "./finding-sensitivity.js";
import { parseReviewFindings, type ReviewSeverity } from "./review-context.js";

/**
 * The one reason string a review wait carries, wherever it is recorded: the bd
 * gate's `--reason`, the findings comment, and the fleet's `run.stopped[]`
 * detail. The supervisor imports it, so a stop can never describe a different
 * wait from the gate blocking the bead.
 */
export const REVIEW_HUMAN_GATE_REASON = "workflow is waiting for a review response";

/** Where the reviewer's full findings live inside the member's worktree. */
export const REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH = ".belayd/review-findings.md";

/** Where the durable disposition record is written; named in the answer message. */
export const REVIEW_FINDINGS_RECORD_RELATIVE_PATH = ".belayd/review-findings.json";

/** The mandatory phase a review finding is attributed to. */
export const REVIEW_FINDINGS_PHASE = "review";

/**
 * What became of one finding after the orchestrator considered it.
 *
 * `fixed` is addressed, `deferred` is deliberately postponed (the only
 * disposition bd-184 renders in a PR body), and `rejected` is declined with a
 * reason. The union is closed so a typo can never become a fourth state that no
 * downstream reader understands.
 */
export type ReviewFindingDisposition =
  | { kind: "fixed" }
  | { kind: "deferred"; reason: string }
  | { kind: "rejected"; reason: string };

/** One finding plus the metadata bd-183/bd-184 read back. */
export interface ReviewFindingRecord {
  finding: string;
  severity: ReviewSeverity;
  phase: string;
  round: number;
  disposition: ReviewFindingDisposition;
  /**
   * The deterministic classifier verdict (bd-183), recorded at build time so a
   * reader never has to re-derive it and so the gate wording is stable.
   * Optional on read: a record written before bd-183 has no field, and
   * {@link readReviewFindingsRecord} classifies those.
   */
  sensitivity?: FindingSensitivity;
  /**
   * The human's publication decision for a sensitive finding (bd-183). Absent
   * until someone answers the gate, which is exactly what keeps a sensitive
   * deferral out of a PR body: the publication gate treats "no decision" as
   * withheld.
   */
  publication?: FindingPublicationDecision;
}

/** The durable record one review delivery leaves behind. */
export interface ReviewFindingsRecord {
  schemaVersion: 1;
  taskId: string;
  phase: string;
  round: number;
  reason: string;
  artifactPath: string;
  findings: ReviewFindingRecord[];
}

const ReviewFindingDispositionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed") }),
  z.object({ kind: z.literal("deferred"), reason: z.string() }),
  z.object({ kind: z.literal("rejected"), reason: z.string() }),
]);

/**
 * Validate a record read back from disk; a corrupt file reads as "no record".
 *
 * `sensitivity`/`publication` stay optional and `schemaVersion` stays `1` on
 * purpose: the record file is short-lived (overwritten every review round in one
 * worktree), and bumping the version would make every in-flight round read as
 * "no record" — silently dropping the round count and the findings a human is
 * currently answering. An absent `sensitivity` is classified on read instead.
 */
const ReviewFindingsRecordSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  phase: z.string(),
  round: z.number().int(),
  reason: z.string(),
  artifactPath: z.string(),
  findings: z.array(
    z.object({
      finding: z.string(),
      severity: z.enum(["critical", "warnings", "suggestions"]),
      phase: z.string(),
      round: z.number().int(),
      disposition: ReviewFindingDispositionSchema,
      sensitivity: FindingSensitivitySchema.optional(),
      publication: FindingPublicationDecisionSchema.optional(),
    }),
  ),
});

/**
 * `true` when a review reported at least one finding (the gate trigger).
 *
 * Strict on purpose: the gate path must not treat a narration bullet that only
 * mentions a `file:line` as a finding, because that would open a human wait with
 * nothing for the human to decide (bd-175 review).
 */
export function hasReviewFindings(text: string): boolean {
  return parseReviewFindings(text, { strict: true }).length > 0;
}

/**
 * Build the durable record for a review delivery, or `undefined` for a clean
 * review (the fast path must not write a file or open a gate).
 *
 * The default disposition is `deferred` pending a human review response: at the
 * moment the gate opens nothing has been addressed yet, and `deferred` is the
 * one disposition that keeps the finding visible in the deferred surface
 * (bd-184) instead of silently claiming it was fixed.
 *
 * Every finding is classified (bd-183) at build time. No `publication` decision
 * is set here on purpose: a decision exists only after a human answers the gate,
 * and {@link applyPublicationAnswer} is what records it. Building the record is
 * therefore always in the withheld state for a sensitive finding.
 */
export function buildReviewFindingsRecord(options: {
  taskId: string;
  text: string;
  phase?: string;
  round?: number;
  disposition?: ReviewFindingDisposition;
}): ReviewFindingsRecord | undefined {
  const parsed = parseReviewFindings(options.text, { strict: true });
  if (parsed.length === 0) return undefined;
  const phase = options.phase ?? REVIEW_FINDINGS_PHASE;
  const round = options.round ?? 1;
  const disposition = options.disposition ?? {
    kind: "deferred",
    reason: REVIEW_HUMAN_GATE_REASON,
  };
  return {
    schemaVersion: 1,
    taskId: options.taskId,
    phase,
    round,
    reason: REVIEW_HUMAN_GATE_REASON,
    artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
    findings: parsed.map((finding) => ({
      finding: finding.text,
      severity: finding.severity,
      phase,
      round,
      disposition,
      sensitivity: classifyFindingSensitivity(finding.text),
    })),
  };
}

/** Human-readable disposition clause for one finding line. */
export function formatReviewFindingDisposition(disposition: ReviewFindingDisposition): string {
  switch (disposition.kind) {
    case "fixed":
      return "addressed";
    case "deferred":
      return `deferred — ${disposition.reason}`;
    case "rejected":
      return `rejected — ${disposition.reason}`;
  }
}

/** Counts per severity, used for the comment's one-line summary. */
function severityCounts(record: ReviewFindingsRecord): Record<ReviewSeverity, number> {
  const counts: Record<ReviewSeverity, number> = { critical: 0, warnings: 0, suggestions: 0 };
  for (const finding of record.findings) counts[finding.severity] += 1;
  return counts;
}

const SEVERITY_SECTION_TITLES: ReadonlyArray<{ severity: ReviewSeverity; title: string }> = [
  { severity: "critical", title: "Critical (must fix)" },
  { severity: "warnings", title: "Warnings (should fix)" },
  { severity: "suggestions", title: "Suggestions (consider)" },
];

/**
 * The bead comment body: the findings a human must see, grouped by severity,
 * each with its disposition, plus the artifact pointer and the one-line question
 * that makes the wait answerable. The `[belayd:review]` header is added by
 * `phaseCommentBody`, so the comment is never mistaken for a human answer.
 *
 * A security-class finding is marked in place and the comment gains the
 * disclosure section (bd-183), because the human answer to that section is what
 * decides whether anything about the finding may be published. A record with no
 * sensitive findings renders byte-for-byte what bd-175 rendered (pinned by a
 * test): operators read this comment every round, and gratuitous churn hides the
 * one line that matters.
 *
 * `previousDecisionsReset` announces that a re-review replaced a round whose
 * publication decisions existed, so a human is not surprised that their earlier
 * "publish" no longer applies (bd-183 review).
 */
export function formatReviewFindingsComment(
  record: ReviewFindingsRecord,
  options?: { previousDecisionsReset?: boolean },
): string {
  const counts = severityCounts(record);
  const lines = [
    "## Review findings — human gate",
    "",
    `**Reason:** ${record.reason}`,
    "",
    `**Findings:** ${record.findings.length} ` +
      `(Critical: ${counts.critical}, Warnings: ${counts.warnings}, Suggestions: ${counts.suggestions})`,
    "",
    `Full findings: \`${record.artifactPath}\``,
  ];
  for (const section of SEVERITY_SECTION_TITLES) {
    const sectionFindings = record.findings.filter(
      (finding) => finding.severity === section.severity,
    );
    if (sectionFindings.length === 0) continue;
    lines.push("", `### ${section.title}`);
    for (const finding of sectionFindings) {
      const sensitive = isSensitiveFinding(finding) ? SENSITIVE_FINDING_MARKER : "";
      lines.push(
        `- ${finding.finding} — ${formatReviewFindingDisposition(finding.disposition)}${sensitive}`,
      );
    }
  }
  const sensitiveCount = record.findings.filter(isSensitiveFinding).length;
  if (sensitiveCount > 0) {
    lines.push(
      "",
      ...sensitiveFindingsSection(sensitiveCount, options?.previousDecisionsReset === true),
    );
  }
  lines.push(
    "",
    "### Question",
    "Should these findings be addressed, deferred to a bead (with a reason), or rejected? " +
      "Reply on this bead (or resolve the gate) with your decision, then the workflow resumes.",
  );
  return lines.join("\n");
}

/** Suffix that marks one finding as security-class in the comment. */
const SENSITIVE_FINDING_MARKER = " — **sensitive** (publication decision required)";

/** The one sentence that announces a reset, shared by the comment and the gate. */
const PREVIOUS_DECISIONS_RESET_NOTICE =
  "previous publication decisions were reset by this re-review; " +
  "answer again if you still want them published";

/**
 * The disclosure section: what a sensitive finding means for publishing.
 *
 * The three options are named verbatim so the human reply can be parsed back by
 * {@link parsePublicationAnswer}, and the "nothing reaches a PR" sentence is
 * spelled out because the orchestrator (not the human) decides what to publish.
 *
 * why the reset notice lives here: a decision answers one round's finding text,
 * and the rebuilt record carries no decision at all (see
 * {@link applyPublicationAnswer}), so the comment is the only place the human
 * could learn their earlier answer no longer applies.
 */
function sensitiveFindingsSection(count: number, previousDecisionsReset: boolean): string[] {
  const lines = [
    "### Sensitive findings — publication decision required",
    `${count} finding${count === 1 ? " is" : "s are"} security-class. Nothing about ` +
      `${count === 1 ? "it" : "them"} is published — not in a PR body, and not on a re-publish — ` +
      "unless a human says so:",
    "",
    "- **publish as-is** — the finding may appear in the PR body verbatim",
    "- **publish a redacted one-liner** — only a redacted summary appears",
    "- **withhold** (default) — nothing about it is published",
    "",
    "Any other reply keeps them withheld.",
  ];
  if (previousDecisionsReset) lines.push("", `_${PREVIOUS_DECISIONS_RESET_NOTICE}._`);
  return lines;
}

/**
 * True when the finding must be treated as security-class.
 *
 * **The live classifier alone is not sufficient**, in either direction:
 *
 * - The record file sits in a worktree a human or a model can edit, and a record
 *   built under an older rule table is missing rules added since — so a stored
 *   `sensitive: false` cannot be trusted to release text (bd-183 review).
 * - The rule table can also *weaken* between rounds (a topic or deny-path rule
 *   removed), so a finding judged security-class earlier would come back
 *   publishable if only the live verdict counted.
 *
 * The second half is upheld by {@link carryForwardSensitivity}, not by this
 * function: the live classifier can only answer for the current table, so
 * across rounds the guarantee depends entirely on that carry-forward running on
 * the `openReviewHumanGate` write path before the record and the gate are
 * written. A monotonic rule table is *not* the mechanism — removing the
 * carry-forward re-opens the hole where a weakened table stores
 * `sensitive: false` and the raw text publishes with no decision recorded.
 * Neither direction can release text on its own.
 */
export function isSensitiveFinding(finding: ReviewFindingRecord): boolean {
  const stored = finding.sensitivity?.sensitive === true;
  return classifyFindingSensitivity(finding.finding).sensitive || stored;
}

/** True when any finding in the record is security-class (bd-183 gate wording). */
export function hasSensitiveFindings(record: ReviewFindingsRecord): boolean {
  return record.findings.some(isSensitiveFinding);
}

/**
 * True when a human released publication (publish or redact) for a sensitive finding.
 *
 * Deliberately narrower than "a decision exists": a previous round whose only
 * decision was a **withhold** could never have published anything, so announcing
 * "answer again if you still want them published" would be wrong (bd-183 review).
 */
export function releasedPublicationIn(record: ReviewFindingsRecord): boolean {
  return record.findings.some(
    (finding) =>
      isSensitiveFinding(finding) &&
      (finding.publication?.kind === "publish" || finding.publication?.kind === "redact"),
  );
}

/**
 * The key that decides "this is the same finding an earlier round flagged".
 *
 * Not exact string equality on purpose: a re-review is written by a model, and the
 * same defect comes back with reflowed whitespace, different emphasis, or without
 * the backticks around a path. An exact match would drop a carried-forward
 * security verdict over cosmetics — the one direction that must never happen.
 *
 * The key is deliberately coarse, so it can also collide: two distinct findings
 * that differ only in casing or emphasis share one. Making it case-sensitive
 * would trade that fail-closed over-ask for a fail-open miss (a re-review that
 * re-cases a finding would lose its verdict), so the collision is handled where
 * it is carried — see {@link carryForwardSensitivity}: a colliding key with a
 * sensitive earlier verdict marks *every* candidate sensitive (the gate widens,
 * no text is released), while a collision with no sensitive earlier verdict
 * carries nothing and each candidate keeps its own live verdict.
 */
export function findingSensitivityKey(finding: string): string {
  return finding.replace(/[`*]/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Carry an earlier round's sensitivity verdict into a rebuilt record.
 *
 * why (bd-183 review, Critical): `buildReviewFindingsRecord` stores only the fresh
 * verdict, so a rule table that *weakens* between rounds (a topic/deny-path rule
 * removed) would store `sensitive: false`; the live classifier would agree, the
 * union in {@link isSensitiveFinding} would be false, and the raw finding would be
 * publishable with no decision ever recorded — and the sensitive guard in
 * `reviewFindingsGateReason` would drop the reset announcement too.
 *
 * Union by {@link findingSensitivityKey}: a finding sensitive in *any* earlier
 * round stays sensitive. The stored verdict keeps the merged reasons so the record
 * can still explain itself, and `publication` is never carried (decisions answer
 * exactly one round).
 *
 * The key is coarse enough to collide (two distinct findings that differ only in
 * casing or emphasis share one), and ambiguity may only ever *widen* the gate:
 * when any previous finding under a key carried a sensitive verdict, every
 * rebuilt finding with that key is marked sensitive (its own live verdict unioned
 * with the earlier one), because the carry cannot say which candidate the earlier
 * verdict named (bd-183 review, Critical). Withholding the carry on a collision
 * would instead store the rebuilt finding's own clean verdict and publish its raw
 * text with no decision — the exact hole this function exists to seal. A
 * collision with no sensitive previous verdict under the key carries nothing;
 * that direction is already fail-closed, because each candidate keeps its own
 * live verdict.
 */
export function carryForwardSensitivity(options: {
  record: ReviewFindingsRecord;
  previous: ReviewFindingsRecord | undefined;
}): ReviewFindingsRecord {
  const previous = options.previous;
  if (previous === undefined) return options.record;
  const earlier = new Map<string, FindingSensitivity>();
  for (const finding of previous.findings) {
    const key = findingSensitivityKey(finding.finding);
    const verdicts = earlier.get(key);
    const merged = mergeFindingSensitivity([
      ...(verdicts === undefined ? [] : [verdicts]),
      classifyFindingSensitivity(finding.finding),
      ...(finding.sensitivity === undefined ? [] : [finding.sensitivity]),
    ]);
    if (merged.sensitive) earlier.set(key, merged);
  }
  if (earlier.size === 0) return options.record;
  return {
    ...options.record,
    findings: options.record.findings.map((finding) => {
      const carried = earlier.get(findingSensitivityKey(finding.finding));
      if (carried === undefined) return finding;
      const merged = mergeFindingSensitivity([
        classifyFindingSensitivity(finding.finding),
        ...(finding.sensitivity === undefined ? [] : [finding.sensitivity]),
        carried,
      ]);
      // The carried verdict has at least one reason by the schema invariant, so
      // `merged.sensitive` is true and it never stores an empty sensitive verdict.
      return { ...finding, sensitivity: merged };
    }),
  };
}

/** The bd gate title, distinct from a fleet ordering gate or an ask question. */
export function reviewFindingsGateTitle(options: {
  taskId: string;
  round: number;
  /** Adds the disclosure wording so the gate itself surfaces the question. */
  sensitive?: boolean;
  /** Adds the short reset marker when a re-review dropped earlier decisions. */
  previousDecisionsReset?: boolean;
}): string {
  // why: bd/needs-you shows the title only; a gate indistinguishable from a
  // normal review wait is the one place the publication question gets lost.
  const kind = options.sensitive === true ? "sensitive findings" : "findings";
  const reset = options.previousDecisionsReset === true ? "; previous decisions reset" : "";
  return `belayd-review: ${options.taskId} ${kind} (round ${options.round}${reset})`;
}

/**
 * The gate reason for one record: the shared review wait, plus the disclosure
 * question when a sensitive finding is present.
 *
 * {@link REVIEW_HUMAN_GATE_REASON} itself stays unchanged: the fleet supervisor
 * imports it as the `awaiting-human` detail, so the wait's meaning must not
 * depend on the findings.
 *
 * `previousDecisionsReset` is the one-line announcement that a re-review replaced
 * a round whose publication decisions existed; without it the human would see the
 * findings withheld again with no explanation.
 */
export function reviewFindingsGateReason(
  record: ReviewFindingsRecord,
  options?: { previousDecisionsReset?: boolean },
): string {
  if (!hasSensitiveFindings(record)) return REVIEW_HUMAN_GATE_REASON;
  const reset =
    options?.previousDecisionsReset === true ? ` — ${PREVIOUS_DECISIONS_RESET_NOTICE}` : "";
  return (
    `${REVIEW_HUMAN_GATE_REASON} — sensitive findings need a publication decision: ` +
    `publish as-is, publish a redacted one-liner, or withhold (default)${reset}`
  );
}

/** Absolute path of the durable disposition record for a worktree. */
export function reviewFindingsRecordPath(cwd: string): string {
  return join(cwd, REVIEW_FINDINGS_RECORD_RELATIVE_PATH);
}

/**
 * Read the durable record, if one exists and parses. A corrupt/unreadable file
 * is "no record": the gate path must be able to proceed and overwrite it.
 *
 * A record written before bd-183 carries no `sensitivity`; it is filled in here so
 * every reader has the metadata. That filling is **not** what safety depends on:
 * publishing decisions re-classify the raw finding text every time
 * ({@link isSensitiveFinding}), because a stored verdict in a worktree file is
 * editable and can predate a rule added since.
 */
export function readReviewFindingsRecord(options: {
  cwd: string;
}): ReviewFindingsRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(reviewFindingsRecordPath(options.cwd), "utf8"));
    const parsed = ReviewFindingsRecordSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    return {
      ...parsed.data,
      findings: parsed.data.findings.map((finding) => ({
        ...finding,
        sensitivity: finding.sensitivity ?? classifyFindingSensitivity(finding.finding),
      })),
    };
  } catch {
    return undefined;
  }
}

/**
 * The round a new review record should carry: one past the persisted record.
 *
 * The record file is per-worktree and overwritten each review, so the round is
 * what preserves the fix-round count across re-reviews (bd-175 review).
 */
export function nextReviewRound(options: { cwd: string }): number {
  return (readReviewFindingsRecord(options)?.round ?? 0) + 1;
}

/**
 * Persist the disposition record next to the workflow state, atomically.
 *
 * Temp file in the record's own directory then `renameSync`, so a crash mid-write
 * cannot leave truncated JSON for the bd-183/bd-184 readers. Best-effort on
 * purpose: the bd gate and comment are the human-visible record, and a read-only
 * worktree must not turn a review delivery into a failure. The caller reports
 * the warning and keeps the gate.
 */
export function writeReviewFindingsRecord(options: {
  cwd: string;
  record: ReviewFindingsRecord;
}): { ok: true } | { ok: false; error: string } {
  const path = reviewFindingsRecordPath(options.cwd);
  const tmpPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(options.record, null, 2));
    renameSync(tmpPath, path);
    return { ok: true };
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Temp cleanup is best-effort; the original error is what matters.
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Record a human's publication answer on every sensitive finding in the record.
 *
 * Pure: the answer is parsed once (so every finding in one round shares the
 * decision) and each sensitive finding gets its own redacted one-liner, because
 * the redaction depends on that finding's text. Non-sensitive findings are left
 * untouched — their text is publishable through the projection in
 * `src/finding-publication.ts`, not as-is — and a record with no sensitive
 * findings is returned unchanged (same reference), so a caller can detect "there
 * was nothing to record" without comparing JSON.
 *
 * Sensitive means {@link isSensitiveFinding} (live classifier union stored), so a
 * hand-edited `sensitive: false` still gets the decision rather than staying a
 * raw-text record with no decision.
 *
 * Re-applying a different answer overwrites the previous decision, which is what
 * makes a human changing their mind work; re-applying the same answer is
 * idempotent.
 *
 * **Decisions are per round.** Building a new record (a re-review) starts with no
 * `publication` field at all, so a round-N decision can never be consumed by the
 * round-N+1 text: the findings may be byte-identical while the human only ever saw
 * round N, and the rule table may have changed in between. The reset is announced
 * in the gate/comment (`previousDecisionsReset`) rather than carried silently.
 */
export function applyPublicationAnswer(
  record: ReviewFindingsRecord,
  answerText: string,
): ReviewFindingsRecord {
  const decision = parsePublicationAnswer(answerText);
  const sensitivities = record.findings.map((finding) => ({
    finding,
    sensitivity: finding.sensitivity ?? classifyFindingSensitivity(finding.finding),
    sensitive: isSensitiveFinding(finding),
  }));
  if (!sensitivities.some((entry) => entry.sensitive)) return record;
  return {
    ...record,
    findings: sensitivities.map((entry) =>
      entry.sensitive
        ? {
            ...entry.finding,
            sensitivity: entry.sensitivity,
            publication: withOneLiner(decision, entry.finding.finding),
          }
        : entry.finding,
    ),
  };
}

/** A redact decision carries the finding's own one-liner; the rest pass through. */
function withOneLiner(
  decision: FindingPublicationDecision,
  finding: string,
): FindingPublicationDecision {
  return decision.kind === "redact"
    ? { ...decision, oneLiner: redactFindingToOneLiner(finding) }
    : decision;
}

/**
 * Read the durable record, apply a human's publication answer, write it back.
 *
 * Best-effort like the record writer: a failure leaves the record without
 * decisions, which already blocks publishing (an unanswered sensitive finding is
 * withheld), so the caller logs a warning and continues instead of failing the
 * answer delivery.
 *
 * `round` is the round the answered wait belongs to. A record from a different
 * round is left untouched: decisions answer one round, and consuming them in a
 * later round would republish text the human never saw.
 *
 * `recorded: false` carries the **cause**, because the three states need
 * different words for the orchestrator: there is no record to answer, the record
 * has moved on to another round, or it holds no security-class finding. All three
 * are non-writes and all three stay fail-closed; only the explanation differs.
 */
export type PublicationAnswerRefusalCause =
  | "no-record"
  | "round-mismatch"
  | "no-sensitive-findings";

/** What an answer recording attempt did. */
export type PublicationAnswerRecordResult =
  | { ok: true; recorded: true }
  | { ok: true; recorded: false; cause: PublicationAnswerRefusalCause }
  | { ok: false; error: string };

export function recordPublicationAnswer(options: {
  cwd: string;
  answer: string;
  round: number;
}): PublicationAnswerRecordResult {
  const record = readReviewFindingsRecord({ cwd: options.cwd });
  if (record === undefined) return { ok: true, recorded: false, cause: "no-record" };
  if (record.round !== options.round) {
    return { ok: true, recorded: false, cause: "round-mismatch" };
  }
  const updated = applyPublicationAnswer(record, options.answer);
  if (updated === record) {
    return { ok: true, recorded: false, cause: "no-sensitive-findings" };
  }
  const written = writeReviewFindingsRecord({ cwd: options.cwd, record: updated });
  return written.ok ? { ok: true, recorded: true } : written;
}
