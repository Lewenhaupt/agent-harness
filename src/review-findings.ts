/**
 * Review findings as a durable, human-visible record (bd-175, bd-219).
 *
 * A non-empty review used to stop the member `awaiting-human` with the only
 * trace inside the member's worktree (`.belayd/review-findings.md`), so bd,
 * `needs-you` views, and the fleet's own `run.stopped[]` all reported a healthy
 * workflow while a human wait was open. bd-219 removed the enforced wait: the
 * review delivery is a trace the orchestrator acts on by running the fix loop,
 * not a question. This module turns the review delivery into:
 *
 * 1. a per-finding disposition record (`{ finding, severity, phase, round,
 *    disposition }`) persisted beside the workflow state, so "the findings the
 *    orchestrator chose not to consider" is a queryable set rather than a file
 *    nobody opens; and
 * 2. a bead comment body that names each finding, its severity and its
 *    disposition plus the artifact path — the text a human actually reads.
 *
 * No finding opens a gate or needs a human answer (bd-286): secrets and other
 * risk classes are a scanner's job (betterleaks, `pnpm scan:secrets`), and
 * anything needing judgement goes to a person or a sub-agent, never to a rule
 * table here. The only human gate a workflow can open is `belayd_ask_human`.
 *
 * This module is pure except for {@link readReviewFindingsRecord} /
 * {@link writeReviewFindingsRecord}, documented best-effort side effects on the
 * disposition record. bd-281 moved that record into the per-repository execution
 * store (table `review_findings`, keyed by task id) so a resumed session reads the
 * same round instead of a copy; the rendered `.belayd/review-findings.md` artifact
 * stays a file because the posted comment names its path.
 */
import { join } from "node:path";
import { z } from "zod";
import { type RepoStateStore, sharedRepoStateStore } from "./repo-state-store.js";
import { parseReviewFindings, type ReviewSeverity } from "./review-context.js";

/**
 * What a recorded finding is waiting on: the orchestrator's own fix loop. The
 * default state of every delivery — nobody is asked, so the record must not
 * claim a human decision is pending.
 */
export const REVIEW_FIX_LOOP_REASON = "awaiting the fix loop in this workflow";

/**
 * Why a review delivery did nothing: the review reported no findings.
 *
 * Shared with the delivery seam's caller, which must not log this expected no-op.
 */
export const REVIEW_NO_FINDINGS_REASON = "the review reported no findings";

/**
 * Why a review delivery did nothing: the host injected no delivery seam.
 *
 * A narrower host legitimately has no seam, so this is an expected outcome the
 * caller must stay silent about rather than warn on every findings review.
 */
export const REVIEW_NO_SEAM_REASON = "no review-findings seam";

/** Where the reviewer's full findings live inside the member's worktree. */
export const REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH = ".belayd/review-findings.md";

/**
 * Retired disposition record path (bd-281).
 *
 * The record is a store row now; the constant is kept because the migration
 * refusal, the import and older comments name it.
 */
export const REVIEW_FINDINGS_RECORD_RELATIVE_PATH = ".belayd/review-findings.json";

/** The mandatory phase a review finding is attributed to. */
export const REVIEW_FINDINGS_PHASE = "review";

/**
 * What became of one finding after the orchestrator considered it.
 *
 * `fixed` is addressed, `deferred` is deliberately postponed, and `rejected` is
 * declined with a reason. The union is closed so a typo can never become a
 * fourth state that no downstream reader understands.
 */
export type ReviewFindingDisposition =
  | { kind: "fixed" }
  | { kind: "deferred"; reason: string }
  | { kind: "rejected"; reason: string };

/**
 * The two sources a recorded disposition can have.
 *
 * One source of truth for the type and the disk schema: a new source must not
 * type-check and then fail `safeParse`, which would discard the whole record.
 */
export const REVIEW_DISPOSITION_SOURCES = ["default", "recorded"] as const;

/** Whether a disposition was written by this module or decided by someone else. */
export type ReviewDispositionSource = (typeof REVIEW_DISPOSITION_SOURCES)[number];

/** One finding plus the metadata a reader of the record sees (a human, the orchestrator). */
export interface ReviewFindingRecord {
  finding: string;
  severity: ReviewSeverity;
  phase: string;
  round: number;
  disposition: ReviewFindingDisposition;
  /**
   * Who owns the disposition: `"default"` is the deferral this module writes at
   * build time, `"recorded"` is a decision an orchestrator or human made.
   *
   * Optional on read so a record written before this marker still parses and
   * round-trips; absent is treated as recorded. The marker exists because the
   * reason text alone cannot distinguish the two: an orchestrator is free to
   * record a deferral that happens to quote {@link REVIEW_FIX_LOOP_REASON}.
   */
  dispositionSource?: ReviewDispositionSource;
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
 * `schemaVersion` stays `1` on purpose, and dropping the bd-183
 * `sensitivity`/`publication` finding fields (bd-286) is backward compatible
 * because this is a plain `z.object`: unknown keys are stripped, not rejected. A
 * record written by an older harness therefore still parses, so an in-flight
 * worktree keeps its round count and its findings instead of reading as "no
 * record" and resetting the fix loop.
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
      dispositionSource: z.enum(REVIEW_DISPOSITION_SOURCES).optional(),
    }),
  ),
});

/** Parse and strictly narrow a persisted record; an unknown shape is "no record". */
export function parseReviewFindingsRecord(raw: unknown): ReviewFindingsRecord | undefined {
  const parsed = ReviewFindingsRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `true` when a review reported at least one finding (the record trigger).
 *
 * Strict on purpose: the trace path must not treat a narration bullet that only
 * mentions a `file:line` as a finding, because that would record a disposition
 * for something nobody raised (bd-175 review).
 */
export function hasReviewFindings(text: string): boolean {
  return parseReviewFindings(text, { strict: true }).length > 0;
}

/**
 * Build the durable record for a review delivery, or `undefined` for a clean
 * review (the fast path must not write a file or a bd write).
 *
 * The default disposition is `deferred` to the orchestrator's fix loop: at the
 * moment the record is written nothing has been addressed yet, and `deferred` is
 * the one disposition that keeps the finding visible and open instead of
 * silently claiming it was fixed.
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
  return {
    schemaVersion: 1,
    taskId: options.taskId,
    phase,
    round,
    reason: REVIEW_FIX_LOOP_REASON,
    artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
    findings: parsed.map((finding) => ({
      finding: finding.text,
      severity: finding.severity,
      phase,
      round,
      disposition: options.disposition ?? { kind: "deferred", reason: REVIEW_FIX_LOOP_REASON },
      // Why: the only disposition this module writes itself is the default.
      // Marking the source keeps a later orchestrator deferral from being
      // mistaken for it even when it quotes the same reason (bd-219 review).
      dispositionSource: options.disposition === undefined ? "default" : "recorded",
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
 * The bead comment body: the findings the orchestrator must see, grouped by
 * severity, each with its disposition, plus the artifact pointer and the one
 * directive that tells the orchestrator how to proceed. The `[belayd:review]`
 * header is added by `phaseCommentBody`, so the comment is never mistaken for a
 * human answer.
 *
 * A trace, not a question (bd-219): the fix-loop contract already says the
 * orchestrator must address every Critical and Warning, so asking a human
 * whether to address them cost a wait on every review. Escalation is the
 * orchestrator's own judgement call, and the closing section names exactly the
 * two conditions that permit it.
 */
export function formatReviewFindingsComment(record: ReviewFindingsRecord): string {
  const counts = severityCounts(record);
  const lines = [
    `## Review findings (round ${record.round})`,
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
    "### Next step",
    "No human decision is required: address every Critical and Warning in the fix loop",
    "(`belayd_implement` with these findings, then `belayd_review`). Escalate with",
    "`belayd_ask_human` only if a Critical finding should not be implemented (a product, risk",
    "or scope decision), or you found a contradiction the bead and the repo cannot resolve.",
  );
  return lines.join("\n");
}

/** Retired absolute path of the disposition record (naming only). */
export function reviewFindingsRecordPath(cwd: string): string {
  return join(cwd, REVIEW_FINDINGS_RECORD_RELATIVE_PATH);
}

/** Store seam: an opened store instead of the module's shared one (tests). */
export interface ReviewFindingsStoreSeam {
  store?: RepoStateStore;
  /** Identity of the record: the bead, never the worktree. */
  taskId?: string;
}

function storeFor(
  options: ReviewFindingsStoreSeam & { cwd: string; taskId: string },
): RepoStateStore | null {
  if (options.store !== undefined) return options.store;
  return sharedRepoStateStore({ cwd: options.cwd }).store;
}

/**
 * Read the durable record for a task, if one exists and parses.
 *
 * A record that no longer matches the schema is "no record": the trace path must
 * be able to proceed and overwrite it.
 */
export function readReviewFindingsRecord(
  options: ReviewFindingsStoreSeam & { cwd: string },
): ReviewFindingsRecord | undefined {
  const taskId = options.taskId;
  if (taskId === undefined) return undefined;
  const store = storeFor({ ...options, taskId });
  if (store === null) return undefined;
  const row = store.readReviewFindings(taskId);
  if (!row.ok || row.value === undefined) return undefined;
  return parseReviewFindingsRecord(row.value);
}

/**
 * The round a new review record should carry: one past the persisted record.
 *
 * The round is what preserves the fix-round count across re-reviews (bd-175
 * review), and it is per task so a review resumed in another worktree continues
 * the count instead of restarting it.
 */
export function nextReviewRound(options: ReviewFindingsStoreSeam & { cwd: string }): number {
  return (readReviewFindingsRecord(options)?.round ?? 0) + 1;
}

/**
 * Persist the disposition record.
 *
 * Best-effort on purpose: the comment is the human-visible record, and a store
 * failure must not turn a review delivery into a failure. The caller reports the
 * warning and keeps whatever else it wrote.
 */
export function writeReviewFindingsRecord(
  options: ReviewFindingsStoreSeam & { cwd: string; record: ReviewFindingsRecord },
): { ok: true } | { ok: false; error: string } {
  const store = storeFor({ ...options, taskId: options.record.taskId });
  if (store === null) {
    return { ok: false, error: `repo state store unavailable for ${options.cwd}` };
  }
  const validated = parseReviewFindingsRecord(options.record);
  if (validated === undefined) {
    return { ok: false, error: "refusing to persist an invalid review-findings record" };
  }
  const written = store.writeReviewFindings({ taskId: validated.taskId, record: validated });
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}
