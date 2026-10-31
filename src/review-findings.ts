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

/** Where the durable disposition record is written. */
const REVIEW_FINDINGS_RECORD_RELATIVE_PATH = ".belayd/review-findings.json";

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

/** Validate a record read back from disk; a corrupt file reads as "no record". */
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
 */
export function formatReviewFindingsComment(record: ReviewFindingsRecord): string {
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
      lines.push(`- ${finding.finding} — ${formatReviewFindingDisposition(finding.disposition)}`);
    }
  }
  lines.push(
    "",
    "### Question",
    "Should these findings be addressed, deferred to a bead (with a reason), or rejected? " +
      "Reply on this bead (or resolve the gate) with your decision, then the workflow resumes.",
  );
  return lines.join("\n");
}

/** The bd gate title, distinct from a fleet ordering gate or an ask question. */
export function reviewFindingsGateTitle(options: { taskId: string; round: number }): string {
  return `belayd-review: ${options.taskId} findings (round ${options.round})`;
}

/** Absolute path of the durable disposition record for a worktree. */
export function reviewFindingsRecordPath(cwd: string): string {
  return join(cwd, REVIEW_FINDINGS_RECORD_RELATIVE_PATH);
}

/**
 * Read the durable record, if one exists and parses. A corrupt/unreadable file
 * is "no record": the gate path must be able to proceed and overwrite it.
 */
export function readReviewFindingsRecord(options: {
  cwd: string;
}): ReviewFindingsRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(reviewFindingsRecordPath(options.cwd), "utf8"));
    const parsed = ReviewFindingsRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
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
