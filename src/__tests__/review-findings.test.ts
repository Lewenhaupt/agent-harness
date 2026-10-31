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

import {
  buildReviewFindingsRecord,
  formatReviewFindingDisposition,
  formatReviewFindingsComment,
  hasReviewFindings,
  nextReviewRound,
  REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
  REVIEW_HUMAN_GATE_REASON,
  readReviewFindingsRecord,
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

  it("records each finding with severity, phase, round, and disposition", () => {
    const record = buildReviewFindingsRecord({ taskId: "bd-1", text: REVIEW_WITH_FINDINGS });
    expect(record).toEqual({
      schemaVersion: 1,
      taskId: "bd-1",
      phase: "review",
      round: 1,
      reason: REVIEW_HUMAN_GATE_REASON,
      artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
      findings: [
        {
          finding: "`src/a.ts:12` — off-by-one in the loop bound",
          severity: "critical",
          phase: "review",
          round: 1,
          disposition: { kind: "deferred", reason: REVIEW_HUMAN_GATE_REASON },
        },
        {
          finding: "`src/b.ts:5` — missing null check",
          severity: "warnings",
          phase: "review",
          round: 1,
          disposition: { kind: "deferred", reason: REVIEW_HUMAN_GATE_REASON },
        },
      ],
    });
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
    expect(body).toContain(REVIEW_HUMAN_GATE_REASON);
    expect(body).toContain("**Findings:** 2 (Critical: 1, Warnings: 1, Suggestions: 0)");
    expect(body).toContain("### Critical (must fix)");
    expect(body).toContain("### Warnings (should fix)");
    expect(body).not.toContain("### Suggestions (consider)");
    expect(body).toContain("`src/a.ts:12` — off-by-one in the loop bound");
    expect(body).toContain(REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH);
    expect(body).toContain("### Question");
  });
});

describe("reviewFindingsGateTitle", () => {
  it("names the task and round so the gate is not mistaken for a question", () => {
    expect(reviewFindingsGateTitle({ taskId: "bd-1", round: 2 })).toBe(
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
    expect(written.reason).toBe(REVIEW_HUMAN_GATE_REASON);
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
});
