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
 * Only a security-class finding still escalates (bd-183): its publication
 * decision is a product/risk choice the orchestrator may not take itself, so
 * {@link REVIEW_HUMAN_GATE_REASON} remains that gate's reason. The fleet's own
 * `awaiting-human` detail is `FLEET_HUMAN_GATE_DETAIL` instead — the fleet waits
 * on any open bd human gate, not only this one — so the remaining coupling is the
 * gate text a human reads, not a shared constant.
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
 * The reason a review wait carries: the bd-183 publication gate's `--reason`, and
 * the sensitive finding's recorded disposition reason.
 *
 * The fleet does **not** share this constant (bd-219 review): its `awaiting-human`
 * detail is `FLEET_HUMAN_GATE_DETAIL`, because the fleet waits on any open bd
 * human gate, not only this one. The coupling that remains is the gate a human
 * reads: this string is what that gate says, and the gate is the durable record
 * the sensitive wait is derived from.
 */
export const REVIEW_HUMAN_GATE_REASON = "workflow is waiting for a review response";

/**
 * What a recorded non-sensitive finding is waiting on: the orchestrator's own
 * fix loop. bd-219 makes that the default state of a review delivery — nobody
 * is asked, so the record must not claim a human decision is pending.
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

/**
 * Prefix of the reason a failed bd-183 publication gate reports.
 *
 * Shared with the seam's caller so a refused gate is logged even though the
 * record and comment still landed.
 */
export const REVIEW_GATE_FAILURE_PREFIX = "could not open a human gate";

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

/**
 * The two sources a recorded disposition can have.
 *
 * One source of truth for the type and the disk schema: a new source must not
 * type-check and then fail `safeParse`, which would discard the whole record.
 */
export const REVIEW_DISPOSITION_SOURCES = ["default", "recorded"] as const;

/** Whether a disposition was written by this module or decided by someone else. */
export type ReviewDispositionSource = (typeof REVIEW_DISPOSITION_SOURCES)[number];

/** One finding plus the metadata bd-183/bd-184 read back. */
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
   * round-trips; absent is treated as recorded except where the legacy fix-loop
   * reason proves it is this module's default
   * ({@link isDefaultFixLoopDeferral}). The marker exists because the reason text
   * alone cannot distinguish the two: an orchestrator is free to record a
   * deferral that happens to quote {@link REVIEW_FIX_LOOP_REASON}.
   */
  dispositionSource?: ReviewDispositionSource;
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
      dispositionSource: z.enum(REVIEW_DISPOSITION_SOURCES).optional(),
      sensitivity: FindingSensitivitySchema.optional(),
      publication: FindingPublicationDecisionSchema.optional(),
    }),
  ),
});

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
 * The default disposition is `deferred`, and its reason depends on the finding:
 * a sensitive finding's deferral is a publication decision
 * ({@link REVIEW_HUMAN_GATE_REASON}) while every other finding is deferred to the
 * orchestrator's fix loop ({@link REVIEW_FIX_LOOP_REASON}) (bd-219 review). At the
 * moment the record is written nothing has been addressed yet, and `deferred` is
 * the one disposition that keeps the finding visible in the deferred surface
 * (bd-184) instead of silently claiming it was fixed.
 *
 * The record-level `reason` stays {@link REVIEW_FIX_LOOP_REASON} for every record:
 * it describes the delivery, not one finding, and the gate reason is built from
 * the findings themselves by {@link reviewFindingsGateReason}.
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
  return {
    schemaVersion: 1,
    taskId: options.taskId,
    phase,
    round,
    reason: REVIEW_FIX_LOOP_REASON,
    artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
    findings: parsed.map((finding) => {
      const sensitivity = classifyFindingSensitivity(finding.text);
      return {
        finding: finding.text,
        severity: finding.severity,
        phase,
        round,
        disposition: options.disposition ?? defaultDisposition(sensitivity.sensitive),
        // Why: the only disposition this module writes itself is the default, and
        // a carried verdict may re-label exactly that one. Marking the source
        // keeps a later orchestrator deferral from being mistaken for it even
        // when it quotes the same reason (bd-219 review).
        dispositionSource: options.disposition === undefined ? "default" : "recorded",
        sensitivity,
      };
    }),
  };
}

/**
 * The default `deferred` disposition for one finding, by its own sensitivity.
 *
 * Extracted so the rule is readable at the build site: a sensitive finding waits
 * on a person, everything else waits on the fix loop.
 */
function defaultDisposition(sensitive: boolean): ReviewFindingDisposition {
  return {
    kind: "deferred",
    reason: sensitive ? REVIEW_HUMAN_GATE_REASON : REVIEW_FIX_LOOP_REASON,
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
 *
 * A security-class finding is marked in place and the comment gains the
 * disclosure section (bd-183), because the human answer to that section is what
 * decides whether anything about the finding may be published — that one still
 * needs an answer. A record with no sensitive findings renders the same body a
 * non-sensitive round always renders (pinned by a test): operators read this
 * comment every round, and gratuitous churn hides the one line that matters.
 *
 * `previousDecisionsReset` announces that a re-review replaced a round whose
 * publication decisions existed, so a human is not surprised that their earlier
 * "publish" no longer applies (bd-183 review). `publicationReaskRequired` says
 * the publication question could not be armed for this round because a human wait
 * is already open, so the section has to be asked again explicitly — without that
 * line the current round's decision would be lost silently (bd-219 review).
 */
export function formatReviewFindingsComment(
  record: ReviewFindingsRecord,
  options?: { previousDecisionsReset?: boolean; publicationReaskRequired?: boolean },
): string {
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
      "",
      "The sensitive findings above need an answer before anything about them is published; " +
        "every other finding stays in the fix loop below.",
    );
    if (options?.publicationReaskRequired === true) {
      lines.push("", PUBLICATION_REASK_NOTICE);
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

/** Suffix that marks one finding as security-class in the comment. */
const SENSITIVE_FINDING_MARKER = " — **sensitive** (publication decision required)";

/**
 * The line that keeps a lost round's publication question visible.
 *
 * why (bd-219 review): a sensitive delivery while another human wait is open
 * cannot create a second gate, but it has already advanced the round, so the
 * open gate's answer would be refused as `round-mismatch`. Naming the re-ask here
 * is the only place the human and the orchestrator can learn it happened.
 */
const PUBLICATION_REASK_NOTICE =
  "**Publication question not armed for this round.** A human wait is already open on this " +
  "bead, so these sensitive findings could not open a gate and an answer to the older wait " +
  "cannot decide them. Re-ask them with `belayd_ask_human` once that answer arrives; nothing " +
  "about them may be published until a decision is recorded.";

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
 * the `deliverReviewFindings` write path before the record and the gate are
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
 * A widened verdict also re-labels the finding's default deferral: a build-time
 * clean finding written as "awaiting the fix loop" is in fact awaiting a
 * publication decision, and bd-184 renders that reason (bd-219 review). Only the
 * module's own default deferral is rewritten — detected by its
 * `dispositionSource` marker, with the legacy reason text as the fallback for
 * records written before the marker. An orchestrator's `fixed`, explicit
 * `rejected` or explicitly reasoned `deferred` is a decision, not a default, even
 * when it quotes {@link REVIEW_FIX_LOOP_REASON} verbatim.
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
      const disposition: ReviewFindingDisposition =
        merged.sensitive && isDefaultFixLoopDeferral(finding)
          ? { kind: "deferred", reason: REVIEW_HUMAN_GATE_REASON }
          : finding.disposition;
      return { ...finding, sensitivity: merged, disposition };
    }),
  };
}

/**
 * True for the default deferral this module writes, the only disposition a
 * carried-forward verdict may re-label. Anything else is a decision someone made.
 *
 * The `dispositionSource` marker is the authority; the reason text is only a
 * fallback for records written before the marker existed, where a fix-loop
 * deferral with {@link REVIEW_FIX_LOOP_REASON} is this module's default by
 * construction. Keying solely on the text would re-label a future
 * orchestrator-recorded deferral that reuses the same words (bd-219 review).
 */
function isDefaultFixLoopDeferral(finding: ReviewFindingRecord): boolean {
  if (finding.disposition.kind !== "deferred") return false;
  switch (finding.dispositionSource) {
    case "default":
      return true;
    case "recorded":
      return false;
    case undefined:
      return finding.disposition.reason === REVIEW_FIX_LOOP_REASON;
  }
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
 * Since bd-219 only a security-class finding opens a gate, so the plain branch is
 * the historical non-sensitive review wait (no live caller produces it any more);
 * the sensitive branch is the one a live review still produces. The plain branch
 * stays because the function is the record layer's single gate-reason source and
 * its output is pinned by tests.
 *
 * {@link REVIEW_HUMAN_GATE_REASON} is the text a human reads on that gate. It is
 * not shared with the fleet: `FLEET_HUMAN_GATE_DETAIL` describes an open gate of
 * any kind, so the two strings serve different surfaces and are not coupled.
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
 * is "no record": the trace path must be able to proceed and overwrite it.
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
 * purpose: the comment and the bd-183 gate are the human-visible record, and a
 * read-only worktree must not turn a review delivery into a failure. The caller
 * reports the warning and keeps whatever else it wrote.
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
