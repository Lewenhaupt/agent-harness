/**
 * Tests for the durable review-findings record (bd-175).
 *
 * The pure half is the whole contract: what counts as a finding, what the
 * durable record looks like, and what a human reads in the comment. The one
 * side effect (`writeReviewFindingsRecord`) is exercised against a temp dir.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateDeferredFindingsGate } from "../finding-publication.js";
import type { FindingPublicationDecision, FindingSensitivity } from "../finding-sensitivity.js";
import {
  applyPublicationAnswer,
  buildReviewFindingsRecord,
  carryForwardSensitivity,
  findingSensitivityKey,
  formatReviewFindingDisposition,
  formatReviewFindingsComment,
  hasReviewFindings,
  hasSensitiveFindings,
  nextReviewRound,
  REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
  REVIEW_FINDINGS_RECORD_RELATIVE_PATH,
  REVIEW_FIX_LOOP_REASON,
  REVIEW_HUMAN_GATE_REASON,
  type ReviewFindingDisposition,
  type ReviewFindingsRecord,
  readReviewFindingsRecord,
  recordPublicationAnswer,
  releasedPublicationIn,
  reviewFindingsGateReason,
  reviewFindingsGateTitle,
  reviewFindingsRecordPath,
  writeReviewFindingsRecord,
} from "../review-findings.js";

const REVIEW_WITH_FINDINGS = [
  "## Critical (must fix)",
  "- `src/a.ts:12` — off-by-one in the loop bound",
  "- (+3 more omitted; see the full findings in the review transcript)",
  "",
  "## Warnings (should fix)",
  "- `src/b.ts:5` — missing null check",
  "",
  "## Suggestions (consider)",
  "None",
  "",
  "## Summary",
  "Two real defects.",
].join("\n");

const CLEAN_REVIEW = [
  "## Critical (must fix)",
  "None",
  "",
  "## Warnings (should fix)",
  "None",
  "",
  "## Suggestions (consider)",
  "None",
].join("\n");

const SENSITIVE_FINDING =
  "`src/auth/session.ts:42` — session token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged";

const SENSITIVE_REVIEW = ["## Critical (must fix)", `- ${SENSITIVE_FINDING}`].join("\n");

/** A review the current rule table calls clean (no security topic or path). */
const PLAIN_REVIEW = [
  "## Critical (must fix)",
  "- `src/a.ts:12` — off-by-one in the loop bound",
].join("\n");

describe("hasReviewFindings", () => {
  it("is false for a clean review and true for one with findings", () => {
    expect(hasReviewFindings(CLEAN_REVIEW)).toBe(false);
    expect(hasReviewFindings(REVIEW_WITH_FINDINGS)).toBe(true);
  });

  it("ignores narration bullets that name no location", () => {
    const text = [
      "## Warnings (should fix)",
      "- Checked everything, it all looks fine",
      "- src/a.ts:9 - real finding",
    ].join("\n");
    expect(hasReviewFindings(text)).toBe(true);
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text });
    expect(record?.findings.map((finding) => finding.finding)).toEqual([
      "src/a.ts:9 - real finding",
    ]);
  });

  it("does not gate on a narration bullet that merely mentions a file:line (strict)", () => {
    // The anywhere-in-text match is fine for the metrics count but a false
    // positive here would open a human wait with no finding to decide.
    const text = "## Critical (must fix)\n- verified `src/x.ts:10` handles null correctly";
    expect(hasReviewFindings(text)).toBe(false);
    expect(buildReviewFindingsRecord({ taskId: "bd-1", text })).toBeUndefined();
  });

  it("gates on a prose-first finding whose location is mid-sentence", () => {
    // Lead-only strict mode dropped this shape and halted invisibly; the gate
    // path must gate on it instead (bd-175 review).
    const text = "## Critical (must fix)\n- Missing null check in src/b.ts:5";
    expect(hasReviewFindings(text)).toBe(true);
    expect(buildReviewFindingsRecord({ taskId: "bd-1", text })?.findings).toEqual([
      expect.objectContaining({ finding: "Missing null check in src/b.ts:5" }),
    ]);
  });

  it("gates on an imperative or affirmation-led bullet that carries a real defect", () => {
    // `correct`/`passed`/`looks`/`all good` are imperatives or prose openers, so
    // they only count as narration when the bullet is nothing else. Dropping
    // them here would be the invisible halt this bead exists to fix.
    for (const finding of [
      "- Correct the bounds in src/a.ts:12",
      "- Passed, though src/c.ts:9 crashes on retries",
      "- Looks good except `src/a.ts:5` — race",
      "- All good, but src/a.ts:5 races",
    ]) {
      expect(hasReviewFindings(`## Critical (must fix)\n${finding}`)).toBe(true);
    }
  });

  it("does not gate on a bare affirmation or an affirmation symbol", () => {
    // A check mark cannot introduce a defect, and an affirmation with nothing
    // after it has no finding for a human to decide.
    for (const narration of [
      "- ✓ src/x.ts:10 ok",
      "- ✔ src/x.ts:10 ok",
      "- ✅ src/x.ts:10",
      "- `Checked` `src/a.ts:5` handles null",
    ]) {
      expect(hasReviewFindings(`## Warnings (should fix)\n${narration}`)).toBe(false);
    }
    expect(
      hasReviewFindings(["## Warnings (should fix)", "- All good.", "- Looks good:"].join("\n")),
    ).toBe(false);
  });

  it("does not gate on an emphasis-wrapped narration marker", () => {
    // `**Verified**`/`__Checked__` is the same marker as the bare word, so a clean
    // review whose narration cites a file:line must stay on the fast path
    // (bd-175 review). Pinned: emphasis before a colon is narration too, matching
    // the plain `- Verified: ...` shape (see the documented limitation in
    // ParseReviewFindingsOptions).
    for (const narration of [
      "- **Verified** `src/x.ts:10` handles null correctly",
      "- __Checked__ `src/a.ts:5`",
      "- **Verified**: race in src/a.ts:5",
    ]) {
      expect(hasReviewFindings(`## Critical (must fix)\n${narration}`)).toBe(false);
    }
  });

  it("gates on an emphasized finding or an emphasized non-marker word", () => {
    // Emphasis must not swallow a real defect, and a word that merely starts
    // like a verb (`Checkouts`) is not the marker.
    for (const finding of [
      "- **Missing** null check in src/b.ts:5",
      "- **Checkouts** are broken in src/a.ts:5",
      "- **Correctness** is wrong in src/a.ts:5",
    ]) {
      expect(hasReviewFindings(`## Critical (must fix)\n${finding}`)).toBe(true);
    }
  });

  it("does not gate on a check-verb lead even when its clause restates a defect", () => {
    // Documented limitation (ParseReviewFindingsOptions.strict and
    // docs/fleet-run.md): a past-tense verb lead drops the whole bullet. The
    // alternative — a defect lexicon for the clause — would guess wrong and open
    // gates for nothing, so the false negative is disclosed and pinned here.
    for (const bullet of ["- Checked: race in src/a.ts:5", "- Reviewed — race in src/a.ts:5"]) {
      expect(hasReviewFindings(`## Critical (must fix)\n${bullet}`)).toBe(false);
    }
  });
});

describe("buildReviewFindingsRecord", () => {
  it("returns undefined for a clean review (the fast path writes nothing)", () => {
    expect(buildReviewFindingsRecord({ taskId: "bd-1", text: CLEAN_REVIEW })).toBeUndefined();
  });

  it("records each finding with severity, phase, round, disposition, and sensitivity", () => {
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    expect(record).toEqual({
      schemaVersion: 1,
      taskId: "bd-1",
      phase: "review",
      round: 1,
      reason: REVIEW_FIX_LOOP_REASON,
      artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
      findings: [
        {
          finding: "`src/a.ts:12` — off-by-one in the loop bound",
          severity: "critical",
          phase: "review",
          round: 1,
          disposition: { kind: "deferred", reason: REVIEW_FIX_LOOP_REASON },
          dispositionSource: "default",
          sensitivity: { sensitive: false, reasons: [] },
        },
        {
          finding: "`src/b.ts:5` — missing null check",
          severity: "warnings",
          phase: "review",
          round: 1,
          disposition: { kind: "deferred", reason: REVIEW_FIX_LOOP_REASON },
          dispositionSource: "default",
          sensitivity: { sensitive: false, reasons: [] },
        },
      ],
    });
  });

  it("classifies a security-class finding at build time and records no decision", () => {
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    expect(record?.findings[0]?.sensitivity?.sensitive).toBe(true);
    expect(record?.findings[0]?.sensitivity?.reasons.length).toBeGreaterThan(0);
    // No decision until a human answers: that absence is what blocks publishing.
    expect(record?.findings[0]?.publication).toBeUndefined();
  });

  it("defers a sensitive finding to the publication decision, not the fix loop (bd-219)", () => {
    // The bd-184 deferred surface renders this reason, and a security-class
    // finding's deferral is a human publication choice — saying "awaiting the fix
    // loop" there described a decision nobody was asked for.
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (record === undefined) throw new Error("expected a record");
    expect(record.findings[0]?.disposition).toEqual({
      kind: "deferred",
      reason: REVIEW_HUMAN_GATE_REASON,
    });
    // The record-level reason still describes the delivery, and the gate reason
    // built from the findings is unchanged.
    expect(record.reason).toBe(REVIEW_FIX_LOOP_REASON);
    expect(reviewFindingsGateReason(record)).toContain(REVIEW_HUMAN_GATE_REASON);
    expect(reviewFindingsGateReason(record)).toContain("publication decision");
  });

  it("honours an explicit round and disposition", () => {
    const record = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: REVIEW_WITH_FINDINGS,
      round: 3,
      disposition: { kind: "rejected", reason: "out of scope" },
    });
    expect(record?.round).toBe(3);
    expect(record?.findings.every((finding) => finding.round === 3)).toBe(true);
    expect(record?.findings[0]?.disposition).toEqual({
      kind: "rejected",
      reason: "out of scope",
    });
  });
});

describe("formatReviewFindingDisposition", () => {
  it("renders each disposition as a human-readable clause", () => {
    expect(formatReviewFindingDisposition({ kind: "fixed" })).toBe("addressed");
    expect(formatReviewFindingDisposition({ kind: "deferred", reason: "later" })).toBe(
      "deferred — later",
    );
    expect(formatReviewFindingDisposition({ kind: "rejected", reason: "no" })).toBe(
      "rejected — no",
    );
  });
});

describe("formatReviewFindingsComment", () => {
  it("names the reason, the counts, every finding, and the artifact", () => {
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    if (record === undefined) throw new Error("expected a record");
    const body = formatReviewFindingsComment(record);
    expect(body).toContain("## Review findings (round 1)");
    expect(body).toContain(REVIEW_FIX_LOOP_REASON);
    expect(body).toContain("**Findings:** 2 (Critical: 1, Warnings: 1, Suggestions: 0)");
    expect(body).toContain("### Critical (must fix)");
    expect(body).toContain("### Warnings (should fix)");
    expect(body).not.toContain("### Suggestions (consider)");
    expect(body).toContain("`src/a.ts:12` — off-by-one in the loop bound");
    expect(body).toContain(REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH);
    expect(body).toContain("### Next step");
    expect(body).not.toContain("### Question");
  });

  it("renders the bd-219 trace verbatim for a record with no sensitive findings", () => {
    // Pinned: operators read this comment every round, so a non-sensitive record
    // must render exactly one fixed body — no marker, no publication section, no
    // question. Any drift here means the round's comment gained or lost a line.
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    if (record === undefined) throw new Error("expected a record");
    expect(formatReviewFindingsComment(record)).toBe(
      [
        "## Review findings (round 1)",
        "",
        `**Reason:** ${REVIEW_FIX_LOOP_REASON}`,
        "",
        "**Findings:** 2 (Critical: 1, Warnings: 1, Suggestions: 0)",
        "",
        `Full findings: \`${REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH}\``,
        "",
        "### Critical (must fix)",
        `- \`src/a.ts:12\` — off-by-one in the loop bound — deferred — ${REVIEW_FIX_LOOP_REASON}`,
        "",
        "### Warnings (should fix)",
        `- \`src/b.ts:5\` — missing null check — deferred — ${REVIEW_FIX_LOOP_REASON}`,
        "",
        "### Next step",
        "No human decision is required: address every Critical and Warning in the fix loop",
        "(`belayd_implement` with these findings, then `belayd_review`). Escalate with",
        "`belayd_ask_human` only if a Critical finding should not be implemented (a product, risk",
        "or scope decision), or you found a contradiction the bead and the repo cannot resolve.",
      ].join("\n"),
    );
  });

  it("marks a sensitive finding and names the three publication options", () => {
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (record === undefined) throw new Error("expected a record");
    const body = formatReviewFindingsComment(record);
    expect(body).toContain("**sensitive** (publication decision required)");
    expect(body).toContain("### Sensitive findings — publication decision required");
    expect(body).toContain("**publish as-is**");
    expect(body).toContain("**publish a redacted one-liner**");
    expect(body).toContain("**withhold** (default)");
    expect(body).toContain("not in a PR body, and not on a re-publish");
  });
});

describe("sensitivity helpers", () => {
  it("reports whether a record carries a sensitive finding", () => {
    const plain = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    const sensitive = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (plain === undefined || sensitive === undefined) throw new Error("expected records");
    expect(hasSensitiveFindings(plain)).toBe(false);
    expect(hasSensitiveFindings(sensitive)).toBe(true);
  });

  it("adds the disclosure wording to the gate reason only when needed", () => {
    const plain = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    const sensitive = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (plain === undefined || sensitive === undefined) throw new Error("expected records");
    // The constant itself stays untouched: it is the text a human reads on the
    // bd-183 gate. The fleet's own detail is `FLEET_HUMAN_GATE_DETAIL`.
    expect(reviewFindingsGateReason(plain)).toBe(REVIEW_HUMAN_GATE_REASON);
    expect(reviewFindingsGateReason(sensitive)).toContain(REVIEW_HUMAN_GATE_REASON);
    expect(reviewFindingsGateReason(sensitive)).toContain("publication decision");
  });

  it("announces a re-review reset in the gate reason and the comment", () => {
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW, round: 2 });
    if (record === undefined) throw new Error("expected a record");
    const reason = reviewFindingsGateReason(record, { previousDecisionsReset: true });
    expect(reason).toContain("previous publication decisions were reset by this re-review");
    const comment = formatReviewFindingsComment(record, { previousDecisionsReset: true });
    expect(comment).toContain("_previous publication decisions were reset by this re-review");
    // Without the flag both stay exactly as before.
    expect(reviewFindingsGateReason(record)).not.toContain("reset");
    expect(formatReviewFindingsComment(record)).not.toContain("reset");
    expect(
      reviewFindingsGateTitle({
        taskId: "bd-1",
        round: 2,
        sensitive: true,
        previousDecisionsReset: true,
      }),
    ).toBe("belayd-review: bd-1 sensitive findings (round 2; previous decisions reset)");
  });

  it("keeps the fix-loop reason on the record, not a wait it never had", () => {
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    expect(record?.reason).toBe(REVIEW_FIX_LOOP_REASON);
  });
});

describe("reviewFindingsGateTitle", () => {
  it("names the task and round so the gate is not mistaken for a question", () => {
    expect(reviewFindingsGateTitle({ taskId: "bd-1", round: 2 })).toBe(
      "belayd-review: bd-1 findings (round 2)",
    );
  });

  it("says `sensitive findings` when a publication decision is needed", () => {
    expect(reviewFindingsGateTitle({ taskId: "bd-1", round: 2, sensitive: true })).toBe(
      "belayd-review: bd-1 sensitive findings (round 2)",
    );
    expect(reviewFindingsGateTitle({ taskId: "bd-1", round: 2, sensitive: false })).toBe(
      "belayd-review: bd-1 findings (round 2)",
    );
  });
});

describe("writeReviewFindingsRecord / readReviewFindingsRecord", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
  });

  it("writes the record beside the workflow state", () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    if (record === undefined) throw new Error("expected a record");
    const result = writeReviewFindingsRecord({ cwd, record });
    expect(result).toEqual({ ok: true });
    const written = JSON.parse(readFileSync(reviewFindingsRecordPath(cwd), "utf8"));
    expect(written.findings).toHaveLength(2);
    expect(written.reason).toBe(REVIEW_FIX_LOOP_REASON);
    expect(readReviewFindingsRecord({ cwd })?.round).toBe(1);
  });

  it("reports an error and leaves no temp file behind when the rename fails", () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    // A directory where the record file belongs makes rename fail after the temp
    // write; the caller keeps the gate and the temp file must be cleaned up.
    mkdirSync(reviewFindingsRecordPath(cwd), { recursive: true });
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    if (record === undefined) throw new Error("expected a record");
    const result = writeReviewFindingsRecord({ cwd, record });
    expect(result.ok).toBe(false);
    expect(readReviewFindingsRecord({ cwd })).toBeUndefined();
  });

  it("advances the round from the persisted record and treats corruption as absent", () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    expect(nextReviewRound({ cwd })).toBe(1);
    const record = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: REVIEW_WITH_FINDINGS,
      round: 1,
    });
    if (record === undefined) throw new Error("expected a record");
    writeReviewFindingsRecord({ cwd, record });
    expect(nextReviewRound({ cwd })).toBe(2);

    writeFileSync(reviewFindingsRecordPath(cwd), "{ not json");
    expect(readReviewFindingsRecord({ cwd })).toBeUndefined();
    expect(nextReviewRound({ cwd })).toBe(1);
  });

  it("discards a record whose sensitivity verdict violates the reasons invariant", () => {
    // `{ sensitive: true, reasons: [] }` cannot be shown to a human or trusted by
    // the gate, so the whole record reads as corrupt ("no record") — fail-closed:
    // nothing may be published from a record nobody can interpret.
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    const base = {
      schemaVersion: 1,
      taskId: "bd-1",
      phase: "review",
      round: 1,
      reason: REVIEW_HUMAN_GATE_REASON,
      artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
    };
    const finding = {
      finding: SENSITIVE_FINDING,
      severity: "critical",
      phase: "review",
      round: 1,
      disposition: { kind: "deferred", reason: REVIEW_HUMAN_GATE_REASON },
    };
    for (const sensitivity of [
      { sensitive: true, reasons: [] },
      { sensitive: false, reasons: [{ kind: "security-topic", match: "session" }] },
    ]) {
      writeFileSync(
        join(cwd, REVIEW_FINDINGS_RECORD_RELATIVE_PATH),
        JSON.stringify({ ...base, findings: [{ ...finding, sensitivity }] }),
      );
      expect(readReviewFindingsRecord({ cwd })).toBeUndefined();
    }
    // The gate therefore keeps the worktree withheld: there is no record to read.
    expect(nextReviewRound({ cwd })).toBe(1);
  });

  it("reads a record whose sensitivity verdict keeps the invariant", () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (record === undefined) throw new Error("expected a record");
    writeReviewFindingsRecord({ cwd, record });
    expect(readReviewFindingsRecord({ cwd })?.findings[0]?.sensitivity).toEqual(
      record.findings[0]?.sensitivity,
    );
  });

  it("round-trips an unclassifiable-text verdict instead of discarding the record", () => {
    // The reason kinds are single-sourced from the zod schema, so a kind the disk
    // validator does not know would make the whole record read as corrupt ("no
    // record" publishes nothing). A lookalike finding must survive the round trip.
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    const record = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: ["## Critical (must fix)", "- `src/prоof/x.png` is unreviewed"].join("\n"),
    });
    if (record === undefined) throw new Error("expected a record");
    expect(record.findings[0]?.sensitivity?.reasons.map((reason) => reason.kind)).toContain(
      "unclassifiable-text",
    );
    expect(writeReviewFindingsRecord({ cwd, record })).toEqual({ ok: true });
    expect(readReviewFindingsRecord({ cwd })?.findings[0]?.sensitivity).toEqual(
      record.findings[0]?.sensitivity,
    );
  });

  it("round-trips the sensitivity and publication fields", () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (record === undefined) throw new Error("expected a record");
    expect(writeReviewFindingsRecord({ cwd, record })).toEqual({ ok: true });
    const fresh = readReviewFindingsRecord({ cwd });
    expect(fresh?.findings[0]?.sensitivity?.sensitive).toBe(true);
    expect(fresh?.findings[0]?.publication).toBeUndefined();

    const answered = applyPublicationAnswer(record, "redact");
    expect(writeReviewFindingsRecord({ cwd, record: answered })).toEqual({ ok: true });
    const reread = readReviewFindingsRecord({ cwd })?.findings[0]?.publication;
    expect(reread?.kind).toBe("redact");
    if (reread?.kind !== "redact") throw new Error("expected a redact decision");
    expect(reread.oneLiner).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
  });

  it("reads a v1 record written before bd-183 and classifies it on read", () => {
    // The schemaVersion stays 1 on purpose: bumping it would make an in-flight
    // round read as "no record" and silently drop the findings a human is
    // currently answering. An absent `sensitivity` is derived instead.
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    writeFileSync(
      join(cwd, REVIEW_FINDINGS_RECORD_RELATIVE_PATH),
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bd-1",
        phase: "review",
        round: 2,
        reason: REVIEW_HUMAN_GATE_REASON,
        artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
        findings: [
          {
            finding: SENSITIVE_FINDING,
            severity: "critical",
            phase: "review",
            round: 2,
            disposition: { kind: "deferred", reason: REVIEW_HUMAN_GATE_REASON },
          },
        ],
      }),
    );
    const read = readReviewFindingsRecord({ cwd });
    expect(read?.round).toBe(2);
    expect(read?.findings[0]?.sensitivity?.sensitive).toBe(true);
    expect(read?.findings[0]?.publication).toBeUndefined();
  });
});

describe("applyPublicationAnswer / recordPublicationAnswer", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
  });

  it("decides every sensitive finding and leaves non-sensitive ones alone", () => {
    const record = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: [
        "## Critical (must fix)",
        `- ${SENSITIVE_FINDING}`,
        "",
        "## Warnings (should fix)",
        "- `src/b.ts:5` — missing null check",
      ].join("\n"),
    });
    if (record === undefined) throw new Error("expected a record");
    const answered = applyPublicationAnswer(record, "publish it");
    expect(answered.findings[0]?.publication).toMatchObject({ kind: "publish", source: "human" });
    expect(answered.findings[1]?.publication).toBeUndefined();
    expect(answered.findings[1]?.finding).toBe("`src/b.ts:5` — missing null check");
  });

  it("returns the record unchanged when nothing is sensitive", () => {
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    if (record === undefined) throw new Error("expected a record");
    expect(applyPublicationAnswer(record, "publish it")).toBe(record);
  });

  it("generates the redacted one-liner from each finding", () => {
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (record === undefined) throw new Error("expected a record");
    const publication = applyPublicationAnswer(record, "redact").findings[0]?.publication;
    if (publication?.kind !== "redact") throw new Error("expected a redact decision");
    expect(publication.oneLiner).toContain("[redacted]");
    expect(publication.oneLiner).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
  });

  it("reads, applies and writes the human's choice", () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (record === undefined) throw new Error("expected a record");
    writeReviewFindingsRecord({ cwd, record });
    expect(recordPublicationAnswer({ cwd, answer: "publish as-is", round: record.round })).toEqual({
      ok: true,
      recorded: true,
    });
    expect(readReviewFindingsRecord({ cwd })?.findings[0]?.publication?.kind).toBe("publish");
  });

  it("records nothing (and does not write) when there is no sensitive finding", () => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    expect(recordPublicationAnswer({ cwd, answer: "publish it", round: 1 })).toEqual({
      ok: true,
      recorded: false,
      cause: "no-record",
    });
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    if (record === undefined) throw new Error("expected a record");
    writeReviewFindingsRecord({ cwd, record });
    expect(recordPublicationAnswer({ cwd, answer: "publish it", round: record.round })).toEqual({
      ok: true,
      recorded: false,
      cause: "no-sensitive-findings",
    });
    expect(readReviewFindingsRecord({ cwd })?.findings[0]?.publication).toBeUndefined();
  });

  it("refuses a decision for a different round", () => {
    // A decision answers one round's finding text; consuming it in a later round
    // would republish text the human never saw (bd-183 review).
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW, round: 2 });
    if (record === undefined) throw new Error("expected a record");
    writeReviewFindingsRecord({ cwd, record });
    expect(recordPublicationAnswer({ cwd, answer: "publish it", round: 1 })).toEqual({
      ok: true,
      recorded: false,
      cause: "round-mismatch",
    });
    expect(readReviewFindingsRecord({ cwd })?.findings[0]?.publication).toBeUndefined();
    // The matching round records normally.
    expect(recordPublicationAnswer({ cwd, answer: "publish it", round: 2 })).toEqual({
      ok: true,
      recorded: true,
    });
  });

  it("drops a recorded decision when the same findings are rebuilt for a new round", () => {
    const roundOne = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: SENSITIVE_REVIEW,
      round: 1,
    });
    if (roundOne === undefined) throw new Error("expected a record");
    const published = applyPublicationAnswer(roundOne, "publish it");
    expect(releasedPublicationIn(published)).toBe(true);
    const roundTwo = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: SENSITIVE_REVIEW,
      round: 2,
    });
    if (roundTwo === undefined) throw new Error("expected a record");
    // Same finding text, new round: the decision is gone, not carried over.
    expect(roundTwo.findings.map((finding) => finding.finding)).toEqual(
      roundOne.findings.map((finding) => finding.finding),
    );
    expect(roundTwo.findings[0]?.publication).toBeUndefined();
    expect(releasedPublicationIn(roundTwo)).toBe(false);
  });

  it("counts only a release as a publication that a reset can undo", () => {
    // A previous round whose only decision was a withhold could never publish, so
    // announcing "answer again if you still want them published" would be wrong.
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (record === undefined) throw new Error("expected a record");
    expect(releasedPublicationIn(applyPublicationAnswer(record, "withhold"))).toBe(false);
    expect(releasedPublicationIn(applyPublicationAnswer(record, "redact"))).toBe(true);
    expect(releasedPublicationIn(applyPublicationAnswer(record, "publish it"))).toBe(true);
  });

  it("round-trips every publication kind and every reason kind", () => {
    // Single-sourced schema pin: the writer and the disk validator are the same
    // declarations, so a new kind/source cannot type-check and then fail
    // `safeParse` (which would discard the record, round count and all).
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    const base = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW });
    if (base === undefined) throw new Error("expected a record");
    const [baseFinding] = base.findings;
    if (baseFinding === undefined) throw new Error("expected a finding");

    const decisions: readonly FindingPublicationDecision[] = [
      { kind: "publish", source: "human", answer: "publish it" },
      { kind: "redact", source: "human", answer: "redact", oneLiner: "[redacted]" },
      { kind: "withhold", source: "human", reason: "withheld" },
      { kind: "withhold", source: "default", reason: "unrecognised" },
    ];
    for (const publication of decisions) {
      const record: ReviewFindingsRecord = {
        ...base,
        findings: [{ ...baseFinding, publication }],
      };
      writeReviewFindingsRecord({ cwd, record });
      expect(readReviewFindingsRecord({ cwd })).toEqual(record);
    }

    const sensitivities: readonly FindingSensitivity[] = [
      { sensitive: true, reasons: [{ kind: "security-topic", match: "session" }] },
      { sensitive: true, reasons: [{ kind: "credential-shaped", match: "ghp_abc" }] },
      { sensitive: true, reasons: [{ kind: "deny-path", match: "src/auth/session.ts" }] },
      { sensitive: false, reasons: [] },
    ];
    for (const sensitivity of sensitivities) {
      const record: ReviewFindingsRecord = {
        ...base,
        findings: [{ ...baseFinding, sensitivity }],
      };
      writeReviewFindingsRecord({ cwd, record });
      expect(readReviewFindingsRecord({ cwd })).toEqual(record);
    }
  });

  it("reads a record written before the disposition marker", () => {
    // The marker is optional on read with no schemaVersion bump: in-flight rounds
    // written by the previous build must still load their round and findings.
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
    const base = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    if (base === undefined) throw new Error("expected a record");
    const [baseFinding] = base.findings;
    if (baseFinding === undefined) throw new Error("expected a finding");
    const legacyFinding = { ...baseFinding };
    delete legacyFinding.dispositionSource;
    const legacy: ReviewFindingsRecord = { ...base, findings: [legacyFinding] };

    writeReviewFindingsRecord({ cwd, record: legacy });
    expect(readReviewFindingsRecord({ cwd })).toEqual(legacy);
  });
});

describe("carryForwardSensitivity", () => {
  const PLAIN_FINDING = "`src/a.ts:12` — off-by-one in the loop bound";

  function previousRecord(sensitivity: FindingSensitivity | undefined): ReviewFindingsRecord {
    return {
      schemaVersion: 1,
      taskId: "bd-1",
      phase: "review",
      round: 1,
      reason: REVIEW_HUMAN_GATE_REASON,
      artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
      findings: [
        {
          finding: PLAIN_FINDING,
          severity: "critical",
          phase: "review",
          round: 1,
          disposition: { kind: "deferred", reason: REVIEW_HUMAN_GATE_REASON },
          ...(sensitivity === undefined ? {} : { sensitivity }),
        },
      ],
    };
  }

  it("matches findings across cosmetic drift, not exact text", () => {
    // A re-review is written by a model: whitespace, emphasis and backticks drift.
    expect(findingSensitivityKey("`src/a.ts` — Off By One")).toBe(
      findingSensitivityKey("src/a.ts — off by   one"),
    );
    expect(findingSensitivityKey("**src/a.ts** — off by one")).toBe(
      findingSensitivityKey("src/a.ts — off by one"),
    );
    expect(findingSensitivityKey("src/a.ts — off by one")).not.toBe(
      findingSensitivityKey("src/b.ts — off by one"),
    );
  });

  it("keeps a finding sensitive when the live table no longer matches it", () => {
    const previous = previousRecord({
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    });
    const rebuilt = buildReviewFindingsRecord({ taskId: "bd-1", text: PLAIN_REVIEW, round: 2 });
    if (rebuilt === undefined) throw new Error("expected a record");
    // The current table calls this finding clean; the earlier verdict stands.
    expect(rebuilt.findings[0]?.sensitivity?.sensitive).toBe(false);
    const carried = carryForwardSensitivity({ record: rebuilt, previous });
    expect(carried.findings[0]?.sensitivity).toEqual({
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    });
    // The carried record is what a gate and the publication surface read.
    expect(hasSensitiveFindings(carried)).toBe(true);
    // A decision answers one round: nothing is carried into the rebuilt record.
    expect(carried.findings[0]?.publication).toBeUndefined();
  });

  it("re-labels the default deferral when a carried verdict makes the finding sensitive (bd-219)", () => {
    // The exact bd-183 scenario: the live table weakened, so the rebuilt record is
    // built clean and gets the fix-loop deferral, while the carry makes it
    // security-class. bd-184 renders the reason, so it must name the decision.
    const previous = previousRecord({
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    });
    const rebuilt = buildReviewFindingsRecord({ taskId: "bd-1", text: PLAIN_REVIEW, round: 2 });
    if (rebuilt === undefined) throw new Error("expected a record");
    expect(rebuilt.findings[0]?.disposition).toEqual({
      kind: "deferred",
      reason: REVIEW_FIX_LOOP_REASON,
    });
    expect(rebuilt.findings[0]?.dispositionSource).toBe("default");

    const carried = carryForwardSensitivity({ record: rebuilt, previous });
    expect(carried.findings[0]?.disposition).toEqual({
      kind: "deferred",
      reason: REVIEW_HUMAN_GATE_REASON,
    });
    // Still module-owned, so a later round may re-label it again; it is not a
    // decision someone made.
    expect(carried.findings[0]?.dispositionSource).toBe("default");
    // The label is not a decision: publication stays fail-closed.
    expect(carried.findings[0]?.publication).toBeUndefined();
  });

  it("keeps an orchestrator deferral that reuses the fix-loop reason (bd-219 review)", () => {
    // The marker, not the text, decides who owns the disposition: an orchestrator
    // may record a deferral whose reason happens to quote the module's default.
    const previous = previousRecord({
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    });
    const recorded: ReviewFindingDisposition = {
      kind: "deferred",
      reason: REVIEW_FIX_LOOP_REASON,
    };
    const rebuilt = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: PLAIN_REVIEW,
      round: 2,
      disposition: recorded,
    });
    if (rebuilt === undefined) throw new Error("expected a record");
    expect(rebuilt.findings[0]?.dispositionSource).toBe("recorded");

    const carried = carryForwardSensitivity({ record: rebuilt, previous });
    expect(carried.findings[0]?.sensitivity?.sensitive).toBe(true);
    expect(carried.findings[0]?.disposition).toEqual(recorded);
    expect(carried.findings[0]?.dispositionSource).toBe("recorded");
  });

  it("still re-labels a legacy default deferral that predates the marker", () => {
    // A record written by an older build has no `dispositionSource`. Its fix-loop
    // deferral is this module's default by construction, so the reason fallback
    // keeps the existing re-label behaviour for in-flight rounds.
    const previous = previousRecord({
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    });
    const rebuilt = buildReviewFindingsRecord({ taskId: "bd-1", text: PLAIN_REVIEW, round: 2 });
    if (rebuilt === undefined) throw new Error("expected a record");
    const finding = rebuilt.findings[0];
    if (finding === undefined) throw new Error("expected a finding");
    const legacyFinding = { ...finding };
    delete legacyFinding.dispositionSource;
    const legacy: ReviewFindingsRecord = { ...rebuilt, findings: [legacyFinding] };

    const carried = carryForwardSensitivity({ record: legacy, previous });
    expect(carried.findings[0]?.disposition).toEqual({
      kind: "deferred",
      reason: REVIEW_HUMAN_GATE_REASON,
    });
    expect(carried.findings[0]?.dispositionSource).toBeUndefined();
  });

  it("never rewrites a disposition the orchestrator made", () => {
    const previous = previousRecord({
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    });
    const decisions: readonly ReviewFindingDisposition[] = [
      { kind: "fixed" },
      { kind: "rejected", reason: "out of scope" },
      { kind: "deferred", reason: "tracked as bd-42" },
    ];
    for (const disposition of decisions) {
      const rebuilt = buildReviewFindingsRecord({
        taskId: "bd-1",
        text: PLAIN_REVIEW,
        round: 2,
        disposition,
      });
      if (rebuilt === undefined) throw new Error("expected a record");
      const carried = carryForwardSensitivity({ record: rebuilt, previous });
      expect(carried.findings[0]?.sensitivity?.sensitive).toBe(true);
      expect(carried.findings[0]?.disposition).toEqual(disposition);
    }
  });

  it("returns the rebuilt record unchanged when the previous round had nothing sensitive", () => {
    const rebuilt = buildReviewFindingsRecord({ taskId: "bd-1", text: PLAIN_REVIEW, round: 2 });
    if (rebuilt === undefined) throw new Error("expected a record");
    expect(carryForwardSensitivity({ record: rebuilt, previous: undefined })).toBe(rebuilt);
    expect(
      carryForwardSensitivity({
        record: rebuilt,
        previous: previousRecord({ sensitive: false, reasons: [] }),
      }),
    ).toBe(rebuilt);
  });

  it("leaves a finding the previous round did not flag alone", () => {
    const previous = previousRecord({
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    });
    const rebuilt = buildReviewFindingsRecord({ taskId: "bd-1", text: SENSITIVE_REVIEW, round: 2 });
    if (rebuilt === undefined) throw new Error("expected a record");
    const carried = carryForwardSensitivity({ record: rebuilt, previous });
    // Different finding text: its own live verdict is what is stored.
    expect(carried.findings[0]?.sensitivity?.sensitive).toBe(true);
    expect(carried.findings[0]?.finding).toBe(SENSITIVE_FINDING);
  });

  describe("ambiguous keys (bd-183 review)", () => {
    let cwd: string;

    afterEach(() => {
      if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
    });

    const STORED_VERDICT: FindingSensitivity = {
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    };
    // The live table calls all of these clean; a stored verdict is the only thing
    // that could make one of them sensitive.
    const CLEAN_TEXT = "`src/a.ts:12` — off-by-one in the loop bound";
    /** The same bullet re-cased and re-emphasised: an identical sensitivity key. */
    const CLEAN_TEXT_RECASED = "**src/a.ts:12** — Off-By-One In The Loop Bound";

    function recordOf(
      findings: ReadonlyArray<{ finding: string; sensitivity?: FindingSensitivity }>,
      round = 1,
    ): ReviewFindingsRecord {
      return {
        schemaVersion: 1,
        taskId: "bd-1",
        phase: "review",
        round,
        reason: REVIEW_HUMAN_GATE_REASON,
        artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
        findings: findings.map((entry) => ({
          finding: entry.finding,
          severity: "critical",
          phase: "review",
          round,
          disposition: { kind: "deferred", reason: REVIEW_HUMAN_GATE_REASON },
          ...(entry.sensitivity === undefined ? {} : { sensitivity: entry.sensitivity }),
        })),
      };
    }

    function rebuiltFrom(bullets: readonly string[]): ReviewFindingsRecord {
      const record = buildReviewFindingsRecord({
        taskId: "bd-1",
        text: ["## Critical (must fix)", ...bullets.map((bullet) => `- ${bullet}`)].join("\n"),
        round: 2,
      });
      if (record === undefined) throw new Error("expected a record");
      return record;
    }

    /** Write the carried record and read it back: the record is what publishes. */
    function persist(record: ReviewFindingsRecord): ReviewFindingsRecord {
      cwd = mkdtempSync(join(tmpdir(), "belayd-review-findings-"));
      const written = writeReviewFindingsRecord({ cwd, record });
      expect(written).toEqual({ ok: true });
      const read = readReviewFindingsRecord({ cwd });
      if (read === undefined) throw new Error("expected the written record");
      return read;
    }

    it("widens every same-key candidate when the earlier verdict was sensitive", () => {
      // Round 1 flagged one finding. Round 2 reports two, differing only in casing
      // and emphasis, so both share the key: the carry cannot tell which candidate
      // the verdict names, so *both* are marked sensitive. Refusing the carry would
      // store their clean live verdicts and publish raw text with no decision.
      const previous = recordOf([{ finding: CLEAN_TEXT, sensitivity: STORED_VERDICT }]);
      const rebuilt = rebuiltFrom([CLEAN_TEXT, CLEAN_TEXT_RECASED]);
      expect(rebuilt.findings).toHaveLength(2);
      expect(findingSensitivityKey(rebuilt.findings[0]?.finding ?? "")).toBe(
        findingSensitivityKey(rebuilt.findings[1]?.finding ?? ""),
      );

      const carried = carryForwardSensitivity({ record: rebuilt, previous });
      const persisted = persist(carried);

      expect(persisted.findings.map((finding) => finding.sensitivity)).toEqual([
        STORED_VERDICT,
        STORED_VERDICT,
      ]);
      // Widening must not invent a decision for the human.
      for (const finding of persisted.findings) {
        expect(finding.publication).toBeUndefined();
      }
      expect(evaluateDeferredFindingsGate(persisted)).toMatchObject({
        ok: false,
        reason: "sensitive-findings-awaiting-human",
      });
    });

    it("still carries across a cosmetic reflow when the match is unambiguous", () => {
      const previous = recordOf([
        { finding: "**src/a.ts:12** — off-by-one in the  loop bound", sensitivity: STORED_VERDICT },
      ]);
      const rebuilt = rebuiltFrom([CLEAN_TEXT]);
      expect(rebuilt.findings[0]?.sensitivity).toEqual({ sensitive: false, reasons: [] });

      const persisted = persist(carryForwardSensitivity({ record: rebuilt, previous }));

      expect(persisted.findings[0]?.sensitivity).toEqual(STORED_VERDICT);
      expect(evaluateDeferredFindingsGate(persisted)).toMatchObject({
        ok: false,
        reason: "sensitive-findings-awaiting-human",
      });
    });

    const ambiguityCases: ReadonlyArray<{
      case: string;
      previous: ReviewFindingsRecord;
      rebuilt: ReviewFindingsRecord;
    }> = [
      {
        case: "the previous record duplicates the key",
        previous: recordOf([
          { finding: CLEAN_TEXT, sensitivity: STORED_VERDICT },
          { finding: CLEAN_TEXT_RECASED, sensitivity: { sensitive: false, reasons: [] } },
        ]),
        rebuilt: rebuiltFrom([CLEAN_TEXT]),
      },
      {
        case: "the rebuilt record duplicates the key",
        previous: recordOf([{ finding: CLEAN_TEXT, sensitivity: STORED_VERDICT }]),
        rebuilt: rebuiltFrom([CLEAN_TEXT, CLEAN_TEXT_RECASED]),
      },
    ];

    for (const ambiguity of ambiguityCases) {
      it(`widens every candidate when ${ambiguity.case}`, () => {
        const carried = carryForwardSensitivity({
          record: ambiguity.rebuilt,
          previous: ambiguity.previous,
        });
        const persisted = persist(carried);

        for (const finding of persisted.findings) {
          expect(finding.sensitivity).toEqual(STORED_VERDICT);
          expect(finding.publication).toBeUndefined();
        }
        expect(evaluateDeferredFindingsGate(persisted)).toMatchObject({
          ok: false,
          reason: "sensitive-findings-awaiting-human",
        });
      });
    }

    it("carries nothing when a colliding key had no sensitive previous verdict", () => {
      // Ambiguity without a security verdict is already fail-closed: every
      // candidate keeps its own live (clean) verdict, so nothing is released.
      const clean: FindingSensitivity = { sensitive: false, reasons: [] };
      const previous = recordOf([
        { finding: CLEAN_TEXT, sensitivity: clean },
        { finding: CLEAN_TEXT_RECASED, sensitivity: clean },
      ]);
      const rebuilt = rebuiltFrom([CLEAN_TEXT, CLEAN_TEXT_RECASED]);

      const persisted = persist(carryForwardSensitivity({ record: rebuilt, previous }));

      expect(persisted.findings.map((finding) => finding.sensitivity)).toEqual([clean, clean]);
      expect(evaluateDeferredFindingsGate(persisted)).toEqual(
        evaluateDeferredFindingsGate(rebuilt),
      );
      expect(evaluateDeferredFindingsGate(persisted)).toMatchObject({ ok: true });
    });
  });
});
