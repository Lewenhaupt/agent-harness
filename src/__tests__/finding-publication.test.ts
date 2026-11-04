/**
 * Tests for the publication safety surface (bd-183).
 *
 * The AC is "no path writes a sensitive finding into a PR body, including on
 * re-publish", so these tests treat `renderDeferredFindingsSection` as the only
 * way a body builder can obtain deferred text: before a human answer nothing is
 * rendered, a publish decision renders the raw text, a redact decision renders
 * the one-liner and never the raw text, and re-rendering is idempotent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateDeferredFindingsGate,
  findProjectionViolations,
  findReassemblyViolations,
  projectFindingText,
  renderDeferredFindingsSection,
  selectPublishableFindings,
} from "../finding-publication.js";
import { classifyFindingSensitivity } from "../finding-sensitivity.js";
import {
  applyPublicationAnswer,
  buildReviewFindingsRecord,
  carryForwardSensitivity,
  REVIEW_FIX_LOOP_REASON,
  type ReviewFindingRecord,
  type ReviewFindingsRecord,
  readReviewFindingsRecord,
  writeReviewFindingsRecord,
} from "../review-findings.js";

const SENSITIVE_FINDING =
  "`src/auth/session.ts:42` — session token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged";

const SENSITIVE_REVIEW = ["## Critical (must fix)", `- ${SENSITIVE_FINDING}`].join("\n");

const PLAIN_REVIEW = [
  "## Warnings (should fix)",
  "- `src/a.ts:12` — off-by-one in the loop bound",
].join("\n");

/**
 * The round-10 Critical: every whitespace chunk is shorter than the opaque-run
 * rule, so only a reassembled reading can see the body they spell.
 */
const CHUNKED_FINDING =
  "src/lib/logger.ts:12, the fixture stores gh.p_ 16C7e42F292c691 2E7710c8383 47Ae178B4a verbatim";

/** The 36-character body the chunks spell once the spaces are deleted. */
const CHUNKED_BODY = "16C7e42F292c6912E7710c838347Ae178B4a";

/** Every 8+ character window of a body: none of them may reach the section. */
function fragmentsOf(body: string): readonly string[] {
  return Array.from({ length: Math.max(0, body.length - 7) }, (_unused, index) =>
    body.slice(index, index + 8),
  );
}

/** The record for a review, or a failure: every test here needs one. */
function recordFor(reviewText: string): ReviewFindingsRecord {
  const record = buildReviewFindingsRecord({ taskId: "bd-1", text: reviewText });
  if (record === undefined) throw new Error("expected a record");
  return record;
}

/** A record whose findings are spelled out, for the cases the parser cannot build. */
function recordOf(findings: readonly ReviewFindingRecord[]): ReviewFindingsRecord {
  return {
    schemaVersion: 1,
    taskId: "bd-1",
    phase: "review",
    round: 1,
    reason: REVIEW_FIX_LOOP_REASON,
    artifactPath: ".belayd/review-findings.md",
    findings: [...findings],
  };
}

function deferredFinding(finding: string): ReviewFindingRecord {
  return {
    finding,
    severity: "warnings",
    phase: "review",
    round: 1,
    disposition: { kind: "deferred", reason: REVIEW_FIX_LOOP_REASON },
  };
}

describe("sensitive deferrals block publication", () => {
  it("renders nothing and refuses the gate before a human answer", () => {
    const record = recordFor(SENSITIVE_REVIEW);
    expect(evaluateDeferredFindingsGate(record)).toEqual({
      ok: false,
      reason: "sensitive-findings-awaiting-human",
      findings: [SENSITIVE_FINDING],
    });
    expect(selectPublishableFindings(record)).toEqual([]);
    expect(renderDeferredFindingsSection(record)).toBe("");
  });

  it.each([
    ["an env file", "`/.env` is committed"],
    ["an ssh key", "`id_rsa` sits in the repository root"],
    ["a GitHub token", "committed ghp_16C7e42F292c6912E7710c838347Ae178B4a in a test"],
    ["a password assignment", "password = hunter2hunter2 in the fixture"],
    ["a PEM header", "-----BEGIN RSA PRIVATE KEY----- leaked into a fixture"],
    ["a letter lookalike", "`src/prоof/x.png` is unreviewed"],
  ])("still blocks %s with no recorded decision (bd-252 AC2)", (_label, finding) => {
    // The risk floor only removes bare topic words; credentials, deny paths,
    // anchors and letter lookalikes stay unconditional and still gate publishing.
    const record = recordOf([deferredFinding(finding)]);
    expect(classifyFindingSensitivity(finding).sensitive).toBe(true);
    expect(evaluateDeferredFindingsGate(record)).toMatchObject({
      ok: false,
      reason: "sensitive-findings-awaiting-human",
    });
    expect(renderDeferredFindingsSection(record)).toBe("");
  });

  it("renders the raw text only after a publish decision", () => {
    const record = applyPublicationAnswer(recordFor(SENSITIVE_REVIEW), "publish it");
    expect(evaluateDeferredFindingsGate(record).ok).toBe(true);
    const section = renderDeferredFindingsSection(record);
    expect(section).toContain(SENSITIVE_FINDING);
  });

  it("renders the one-liner and never the raw finding after a redact decision", () => {
    const record = applyPublicationAnswer(recordFor(SENSITIVE_REVIEW), "redact");
    const section = renderDeferredFindingsSection(record);
    expect(section).not.toBe("");
    expect(section).toContain("[redacted]");
    // The AC in one assertion: the credential and the sensitive path never reach
    // the rendered text, even though the human allowed a summary.
    expect(section).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
    expect(section).not.toContain("src/auth/session.ts");
    expect(section).not.toContain(SENSITIVE_FINDING);
  });

  it("renders nothing after a withhold decision, and says why the gate is shut", () => {
    const record = applyPublicationAnswer(recordFor(SENSITIVE_REVIEW), "withhold");
    expect(renderDeferredFindingsSection(record)).toBe("");
    expect(evaluateDeferredFindingsGate(record)).toEqual({
      ok: false,
      reason: "sensitive-findings-withheld",
      findings: [SENSITIVE_FINDING],
    });
  });

  it("is idempotent on re-render (the re-publish AC)", () => {
    const published = applyPublicationAnswer(recordFor(SENSITIVE_REVIEW), "publish it");
    const redacted = applyPublicationAnswer(recordFor(SENSITIVE_REVIEW), "redact");
    for (const record of [published, redacted]) {
      const first = renderDeferredFindingsSection(record);
      const second = renderDeferredFindingsSection(record);
      expect(second).toBe(first);
    }
    // Re-applying the same answer is also stable, so a re-delivered answer cannot
    // flip a withheld finding into a published one.
    const withheld = applyPublicationAnswer(recordFor(SENSITIVE_REVIEW), "don't publish");
    const twice = applyPublicationAnswer(withheld, "don't publish");
    expect(renderDeferredFindingsSection(twice)).toBe("");
  });

  it("blocks a redact decision whose one-liner is empty", () => {
    // Fail closed: a record hand-edited to `redact` with no line must not render a
    // bullet, and must never fall back to the raw finding.
    const record = recordOf([
      {
        ...deferredFinding(SENSITIVE_FINDING),
        publication: { kind: "redact", source: "human", answer: "redact", oneLiner: "  " },
      },
    ]);
    expect(renderDeferredFindingsSection(record)).toBe("");
    expect(evaluateDeferredFindingsGate(record)).toMatchObject({
      ok: false,
      reason: "sensitive-findings-withheld",
    });
  });
});

describe("the live classifier is authoritative", () => {
  it("ignores a stored `sensitive: false` on a security-class finding", () => {
    // A record built under an older rule table (or edited by hand) must not make
    // the raw text publishable (bd-183 review, Warning).
    const record = recordOf([
      {
        ...deferredFinding("`src/auth/session.ts:42` — the session token is logged"),
        sensitivity: { sensitive: false, reasons: [] },
      },
    ]);
    expect(renderDeferredFindingsSection(record)).toBe("");
    expect(selectPublishableFindings(record)).toEqual([]);
    expect(evaluateDeferredFindingsGate(record)).toEqual({
      ok: false,
      reason: "sensitive-findings-awaiting-human",
      findings: ["`src/auth/session.ts:42` — the session token is logged"],
    });
  });

  it("keeps a stale `sensitive: true` on a clean finding withheld", () => {
    // Union, never intersection: a finding once judged security-class must not
    // become publishable because a later rule table (or an edit) says otherwise.
    const record = recordOf([
      {
        ...deferredFinding("`src/a.ts:12` — off-by-one in the loop bound"),
        sensitivity: { sensitive: true, reasons: [{ kind: "security-topic", match: "auth" }] },
      },
    ]);
    expect(renderDeferredFindingsSection(record)).toBe("");
    expect(evaluateDeferredFindingsGate(record)).toMatchObject({ ok: false });
  });

  it("needs a human decision even for a downgraded record", () => {
    // The downgrade alone cannot release text; a human decision is still needed.
    const downgraded = recordOf([
      {
        ...deferredFinding("`src/auth/session.ts:42` — the session token is logged"),
        sensitivity: { sensitive: false, reasons: [] },
      },
    ]);
    const published = applyPublicationAnswer(downgraded, "publish it");
    expect(published.findings[0]?.publication?.kind).toBe("publish");
    expect(renderDeferredFindingsSection(published)).toContain("the session token is logged");
  });
});

describe("re-publish after a re-review (the AC's `including on re-publish`)", () => {
  /** The record on disk is what a body builder re-reads, so the tests read it. */
  function reread(cwd: string): ReviewFindingsRecord {
    const record = readReviewFindingsRecord({ cwd });
    if (record === undefined) throw new Error("expected the written record");
    return record;
  }

  function persisted(record: ReviewFindingsRecord): ReviewFindingsRecord {
    const cwd = mkdtempSync(join(tmpdir(), "belayd-republish-"));
    try {
      expect(writeReviewFindingsRecord({ cwd, record })).toEqual({ ok: true });
      return reread(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it("releases nothing when a re-review rebuilds the round after a publish", () => {
    // Round 1 published, then a re-review rebuilt the same finding text for round
    // 2. The durable record is the only input a body builder has, so re-reading it
    // must yield no text — a decision answers one round, and the round-2 text was
    // never approved.
    const roundOne = persisted(applyPublicationAnswer(recordFor(SENSITIVE_REVIEW), "publish it"));
    expect(renderDeferredFindingsSection(roundOne)).toContain(SENSITIVE_FINDING);
    expect(evaluateDeferredFindingsGate(roundOne).ok).toBe(true);

    const rebuilt = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: SENSITIVE_REVIEW,
      round: 2,
    });
    if (rebuilt === undefined) throw new Error("expected a record");
    expect(rebuilt.findings.map((finding) => finding.finding)).toEqual(
      roundOne.findings.map((finding) => finding.finding),
    );

    const roundTwo = persisted(carryForwardSensitivity({ record: rebuilt, previous: roundOne }));
    expect(roundTwo.round).toBe(2);
    expect(roundTwo.findings[0]?.publication).toBeUndefined();
    expect(roundTwo.findings[0]?.sensitivity?.sensitive).toBe(true);
    // The re-publish render is stable and empty: nothing about the finding appears.
    const section = renderDeferredFindingsSection(roundTwo);
    expect(renderDeferredFindingsSection(roundTwo)).toBe(section);
    expect(section).toBe("");
    expect(section).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
    expect(evaluateDeferredFindingsGate(roundTwo)).toEqual({
      ok: false,
      reason: "sensitive-findings-awaiting-human",
      findings: [SENSITIVE_FINDING],
    });
  });

  it("renders nothing for a widened ambiguous key", () => {
    // A re-review that reports two findings differing only in casing/emphasis
    // cannot be told apart by the sensitivity key, so the earlier sensitive verdict
    // widens to both. Neither has a decision, so neither may be rendered.
    const stored = "`src/a.ts:12` — off-by-one in the loop bound";
    const recased = "**src/a.ts:12** — Off-By-One In The Loop Bound";
    const previous = persisted(
      recordOf([
        {
          ...deferredFinding(stored),
          sensitivity: {
            sensitive: true,
            reasons: [{ kind: "security-topic", match: "auth" }],
          },
        },
      ]),
    );
    const rebuilt = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: ["## Critical (must fix)", `- ${stored}`, `- ${recased}`].join("\n"),
      round: 2,
    });
    if (rebuilt === undefined) throw new Error("expected a record");
    expect(rebuilt.findings).toHaveLength(2);

    const widened = persisted(carryForwardSensitivity({ record: rebuilt, previous }));
    expect(widened.findings.every((finding) => finding.sensitivity?.sensitive === true)).toBe(true);
    expect(renderDeferredFindingsSection(widened)).toBe("");
    expect(evaluateDeferredFindingsGate(widened)).toMatchObject({
      ok: false,
      reason: "sensitive-findings-awaiting-human",
    });
  });
});

describe("non-sensitive deferrals publish their projection", () => {
  it("renders the projected finding and leaves the record untouched", () => {
    const record = recordFor(PLAIN_REVIEW);
    // Updated deliberately for the typography fold (bd-183 round 11): the code span
    // is gone and the em dash is folded to `-` rather than `?`, because the
    // invariant is ASCII and an em dash reads as a hyphen. Only this row changes.
    expect(renderDeferredFindingsSection(record)).toBe(
      ["### Deferred findings", "- [code] - off-by-one in the loop bound"].join("\n"),
    );
    expect(evaluateDeferredFindingsGate(record).ok).toBe(true);
    // No sensitive finding means nothing to record: the same record comes back.
    expect(applyPublicationAnswer(record, "publish it")).toBe(record);
  });

  it("publishes a clean finding whose text has no credential shape verbatim", () => {
    // The projection is not a blanket redaction: ordinary prose and a plain word
    // path survive, so the deferred section still reads like the review.
    const record = recordOf([deferredFinding("the retry loop allocates on every iteration")]);
    expect(renderDeferredFindingsSection(record)).toBe(
      ["### Deferred findings", "- the retry loop allocates on every iteration"].join("\n"),
    );
  });

  it("caps the rendered items so bd-184 inherits one limit", () => {
    const findings = Array.from({ length: 7 }, (_unused, index) =>
      deferredFinding(`\`src/f${index}.ts:1\` — finding ${index}`),
    );
    const record = recordOf(findings);
    const bullets = renderDeferredFindingsSection(record).split("\n").slice(1);
    expect(bullets).toHaveLength(5);
    expect(
      renderDeferredFindingsSection(record, { maxItems: 2 }).split("\n").slice(1),
    ).toHaveLength(2);
  });

  it("keeps a mixed record's non-sensitive deferrals publishable while a sensitive one waits", () => {
    const record = recordOf([
      deferredFinding("`src/a.ts:12` — off-by-one in the loop bound"),
      { ...deferredFinding(SENSITIVE_FINDING) },
    ]);
    expect(evaluateDeferredFindingsGate(record)).toMatchObject({
      ok: false,
      reason: "sensitive-findings-awaiting-human",
    });
    const section = renderDeferredFindingsSection(record);
    expect(section).toContain("off-by-one in the loop bound");
    expect(section).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
  });

  it("ignores findings that are not deferred", () => {
    // A fixed/rejected finding is not a deferral: it is not rendered, and it does
    // not block the gate even when it is security-class.
    const record = recordOf([
      {
        ...deferredFinding(SENSITIVE_FINDING),
        disposition: { kind: "fixed" },
      },
      {
        ...deferredFinding(SENSITIVE_FINDING),
        disposition: { kind: "rejected", reason: "out of scope" },
      },
    ]);
    expect(evaluateDeferredFindingsGate(record)).toEqual({ ok: true, publishable: [] });
    expect(renderDeferredFindingsSection(record)).toBe("");
  });
});

describe("projectFindingText is the only shape deferred text takes", () => {
  it.each([
    ["a code span", "`src/a.ts:12` is stale", "[code] is stale"],
    ["a fenced block", "see\n```\nkey=abc\n```\nfor details", "see [code] for details"],
    ["a path token", "the file src/parser.ts:88 is stale", "the file [path] is stale"],
    ["a home path", "rotate ~/.ssh/id_rsa keys", "rotate [path] keys"],
    [
      "an assignment value",
      "password=hunter2hunter2 in the fixture",
      "password=[value] in the fixture",
    ],
    [
      "an opaque run",
      "the digest 0123456789abcdef0123456789abcdef is wrong",
      "the digest [value] is wrong",
    ],
    ["a lookalike outside a run", "the prоof directory is unread", "the pr?of directory is unread"],
  ])("projects %s", (_label, finding, expected) => {
    expect(projectFindingText(finding)).toBe(expected);
    expect(findProjectionViolations(projectFindingText(finding))).toEqual([]);
  });

  it("collapses to one line and caps by code point", () => {
    const projected = projectFindingText(`a\n\nb   c ${"word ".repeat(80)}`, { maxChars: 24 });
    expect(projected.startsWith("a b c word")).toBe(true);
    expect(Array.from(projected).length).toBeLessThanOrEqual(24);
    // ASCII on purpose: the invariant admits no non-ASCII character, the ellipsis
    // of the redacted one-liner included.
    expect(projected.endsWith("...")).toBe(true);
  });

  it("never returns an empty projection for an empty finding", () => {
    expect(projectFindingText("   ")).toBe("[redacted]");
  });

  it("keeps a punctuation-split anchor out of the body (the documented classifier boundary)", () => {
    // `.` inside an anchor is a different string, so the classifier misses it; the
    // projection is what makes that miss harmless (round 10's structural point).
    // The body here is contiguous, so the opaque-run rule masks it; a body that was
    // also *split* is caught by the reassembly check in the next block.
    for (const finding of [
      "gh.p_16C7e42F292c6912E7710c838347Ae178B4a leaked",
      "AK.IAIOSFODNN7EXAMPLE leaked",
      "id.rsa sits in the repository root",
    ]) {
      const projected = projectFindingText(finding);
      expect(findProjectionViolations(projected), finding).toEqual([]);
      expect(projected, finding).not.toMatch(
        /16C7e42F292c6912E7710c838347Ae178B4a|IOSFODNN7EXAMPLE|id\.rsa/u,
      );
    }
  });
});

describe("a whitespace-chunked body cannot be reassembled from the section", () => {
  // Round-10 Critical: 15/11/10-character chunks, so the contiguous run rule never
  // fires, while deleting the spaces reassembles the 36-character body. The
  // classifier may well call this spelling clean; the projection is what decides.
  it("projects wholesale to [redacted] and publishes no fragment", () => {
    expect(classifyFindingSensitivity(CHUNKED_FINDING).sensitive).toBe(false);
    expect(projectFindingText(CHUNKED_FINDING)).toBe("[redacted]");
    const record = recordFor(["## Critical (must fix)", `- ${CHUNKED_FINDING}`].join("\n"));
    expect(evaluateDeferredFindingsGate(record).ok).toBe(true);
    const section = renderDeferredFindingsSection(record);
    expect(section).toBe(["### Deferred findings", "- [redacted]"].join("\n"));
    for (const fragment of fragmentsOf(CHUNKED_BODY)) {
      expect(section, fragment).not.toContain(fragment);
    }
  });

  it("does not let a recorded redact one-liner re-introduce the chunks", () => {
    // The one-liner is re-projected on every render, so a stored line that
    // reassembles must not survive that second pass either.
    const record = recordOf([
      {
        ...deferredFinding(CHUNKED_FINDING),
        sensitivity: { sensitive: true, reasons: [{ kind: "credential-shaped", match: "gh.p_" }] },
        publication: {
          kind: "redact",
          source: "human",
          answer: "redact",
          oneLiner: CHUNKED_FINDING,
        },
      },
    ]);
    const section = renderDeferredFindingsSection(record);
    expect(section).toBe(["### Deferred findings", "- [redacted]"].join("\n"));
    expect(section).not.toContain(CHUNKED_BODY);
    for (const fragment of fragmentsOf(CHUNKED_BODY)) {
      expect(section, fragment).not.toContain(fragment);
    }
    expect(renderDeferredFindingsSection(record)).toBe(section);
  });

  it("reports the reassembly through the checker and the renderer from one predicate", () => {
    // The renderer rejects on a non-empty result and the checker reports the same
    // strings, so a test cannot pass while the published section leaks.
    const chunked = `the fixture stores gh.p_ ${CHUNKED_BODY.slice(0, 15)} ${CHUNKED_BODY.slice(
      15,
      26,
    )} ${CHUNKED_BODY.slice(26)} verbatim`;
    expect(findReassemblyViolations(chunked).length).toBeGreaterThan(0);
    expect(findProjectionViolations(chunked).length).toBeGreaterThan(0);
    expect(projectFindingText(chunked)).toBe("[redacted]");
  });

  it.each([
    "off by one in the loop bound",
    "the deferred findings are capped",
    "a 16 character sentence of words",
    "the retry loop allocates 3 times on every iteration",
    "the IPv6 path",
    "the Backtrace Shows IPv6 Fallbacks",
    // Named as a survivor in docs/bd-183-userguide.md, so it is pinned here: a
    // change that redacts it must change the doc row in the same commit.
    "lines 1-9 are stale",
  ])("still projects prose as written: %s", (finding) => {
    // The guard must not redact a sentence that happens to weld into a long run.
    // `a 16 character sentence of words` is one digit group, not an interleaving.
    expect(projectFindingText(finding)).toBe(finding);
    expect(findProjectionViolations(projectFindingText(finding))).toEqual([]);
  });

  it("does not treat a welded sentence boundary as a reassembled path", () => {
    // why the path arm is only a slash: `the loop is slow. fix it` welds to
    // `theloopisslow.fixit`, and redacting every finding that ends a sentence would
    // cost bd-184 its summary. The file-name shape is a path only per token.
    expect(projectFindingText("the loop is slow. fix it")).toBe("the loop is slow. fix it");
    expect(findReassemblyViolations("theloopisslow.fixit")).toEqual([]);
  });

  it("redacts a comma-split body (round-12 Critical)", () => {
    // Round 12: a body split on a token delimiter (`,` here, but `.`, `;`, `|`, `[`,
    // `(` and `"` are the same class) escaped both enumerated readings. One reading
    // that deletes everything outside `[A-Za-z0-9+/=_-]` catches it by construction.
    const finding = "the header is abcd12,34efgh,56ijkl,90mnop,12qrst,34uvwx verify please";
    const body = "abcd1234efgh56ijkl90mnop12qrst34uvwx";
    expect(classifyFindingSensitivity(finding).sensitive).toBe(false);
    expect(projectFindingText(finding)).toBe("[redacted]");
    const record = recordOf([deferredFinding(finding)]);
    expect(evaluateDeferredFindingsGate(record).ok).toBe(true);
    const section = renderDeferredFindingsSection(record);
    expect(section).toBe(["### Deferred findings", "- [redacted]"].join("\n"));
    for (const fragment of fragmentsOf(body)) {
      expect(section, fragment).not.toContain(fragment);
    }
  });

  it("sees through the projection's own markers and every other separator (rounds 11–12)", () => {
    // A chunked body interleaved with path-token fillers: the printed markers are
    // published text, so a reader drops their brackets along with the spaces. The
    // canonical reading deletes both in one pass — and with them every separator
    // round 12 showed the enumerated readings could not cover.
    const body = CHUNKED_BODY;
    const fragments = [
      body.slice(0, 7),
      body.slice(7, 14),
      body.slice(14, 21),
      body.slice(21, 28),
      body.slice(28, 35),
      body.slice(35),
    ];
    const filler = [
      "src/x.ts:12,",
      ...fragments.flatMap((fragment) => [fragment, "src/a"]),
      "are logged",
    ].join(" ");
    expect(classifyFindingSensitivity(filler).sensitive).toBe(false);
    expect(projectFindingText(filler)).toBe("[redacted]");

    // The emitted bullet, checked directly: one reading, and the run rule is what
    // fires (the body welds back together once the brackets and commas go).
    const emitted = [
      "[path],",
      ...fragments.flatMap((fragment) => [fragment, "[path]"]),
      "are logged",
    ].join(" ");
    const violations = findReassemblyViolations(emitted);
    expect(violations.some((violation) => violation.startsWith("reassembled run:"))).toBe(true);
    expect(violations.every((violation) => !violation.includes("deleted"))).toBe(true);

    const record = recordFor(["## Critical (must fix)", `- ${filler}`].join("\n"));
    expect(evaluateDeferredFindingsGate(record).ok).toBe(true);
    const section = renderDeferredFindingsSection(record);
    expect(section).toBe(["### Deferred findings", "- [redacted]"].join("\n"));
    for (const fragment of fragmentsOf(body)) {
      expect(section, fragment).not.toContain(fragment);
    }
  });
});

describe("markdown structure cannot leak out of the released raw path", () => {
  /** A sensitive finding a human released with `publish as-is`. */
  function releasedRecord(finding: string): ReviewFindingsRecord {
    return recordOf([
      {
        ...deferredFinding(finding),
        sensitivity: { sensitive: true, reasons: [{ kind: "security-topic", match: "token" }] },
        publication: { kind: "publish", source: "human", answer: "publish it" },
      },
    ]);
  }

  function releasedBullet(finding: string): string {
    return renderDeferredFindingsSection(releasedRecord(finding)).split("\n")[1] ?? "";
  }

  it.each([
    [
      "a single fence",
      "token = hunter2leak1 ``` opens an unclosed fence",
      "opens an unclosed fence",
    ],
    ["a fence at end of string", "token = hunter2leak1 ```", "token = hunter2leak1"],
    ["six backticks", "see `````` a", "see"],
    ["a four-backtick fence", "see ```` a", "see"],
    ["tildes at the start", "~~~rotate the key", "rotate the key"],
    ["tildes mid-line", "see ~~~ rotate", "see"],
  ])("replaces %s on the released path", (_label, finding, survives) => {
    // Any run of two or more opens a code region or restyles the body around it,
    // so every run goes — parity cannot decide it (round 12).
    const bullet = releasedBullet(finding);
    expect(bullet).not.toContain("`");
    expect(bullet).not.toContain("~~");
    expect(bullet).toContain("[code]");
    expect(bullet).toContain(survives);
  });

  it("neutralizes both fences of an even pair (the change from parity, deliberate)", () => {
    // Round 12: a longer run is still a valid opener, so "even" never meant paired.
    // Two three-backtick runs used to survive as an example; now both are markers.
    const bullet = releasedBullet("```example``` is the documented shape");
    expect(bullet).not.toContain("```");
    expect(bullet.split("[code]").length - 1).toBe(2);
    expect(bullet).toContain("example");
  });

  it.each([
    ["a fenced block", "see\n```\nkey=abc\n```\nfor details", "see [code] for details"],
    ["six backticks", "see `````` a", "see [code] a"],
    ["a four-backtick fence", "see ```` a", "see [code] a"],
    ["tildes at the start", "~~~rotate the key", "[code] rotate the key"],
    ["tildes mid-line", "see ~~~ rotate", "see [code] rotate"],
  ])("projects %s to one marker", (_label, finding, expected) => {
    expect(projectFindingText(finding)).toBe(expected);
    expect(findProjectionViolations(projectFindingText(finding))).toEqual([]);
  });
});

describe("documented residual families publish verbatim", () => {
  // The guard cannot separate these from prose without a dictionary, and redacting
  // them wholesale eats genuine sentences and numeric configuration, so the cost is
  // stated in docs/bd-183-userguide.md instead of hidden. Pinned here so a later
  // change to either side is deliberate.
  it.each([
    ["lowercase with digits at one end", "deadbeefdead beef"],
    ["all uppercase letters", "ABCDEFGHIJ KLMNOP"],
    ["all digits", "1234567890 123456"],
    ["lowercase base36-style", "mfrggzdfmzt wq2lk"],
  ])("publishes %s as written", (_label, finding) => {
    expect(projectFindingText(finding)).toBe(finding);
    expect(findProjectionViolations(projectFindingText(finding))).toEqual([]);
  });

  it.each([
    "The Retry Logic Is Bounded",
    "A Bug In The Main Path Handler",
    // The exact density boundary the docs quantify (6 case flips on 18 characters),
    // so a one-word edit to either side is visible here as a test change.
    "the GitHub API is slow",
  ])("redacts Title-Case prose wholesale: %s", (finding) => {
    // The cost of the case-flip arm: prose written this way flips case often enough
    // to reach the density, while `the Backtrace Shows IPv6 Fallbacks` survives.
    // Fail-closed, and pinned so the cost is deliberate rather than discovered.
    expect(projectFindingText(finding)).toBe("[redacted]");
  });
});

describe("HTML comment syntax cannot forge a marker pair", () => {
  it.each([
    "the body carries <!-- belayd:summary --> already",
    "a forged <!-- belayd:usage --> marker",
    "a forged <!-- belayd:deferred --> marker",
    "a split <!-- belayd:usa ge --> marker",
  ])("neutralizes %s", (finding) => {
    // bd-174.3 rewrites only the text inside its own marker pairs; a forged sibling
    // would put finding text outside the region the upsert controls. `usage` slips
    // the 6-character assignment-value threshold, so the newline was never the only
    // vector — the delimiters are removed whatever surrounds them.
    const projected = projectFindingText(finding);
    expect(projected).not.toContain("<!--");
    expect(projected).not.toContain("-->");
    expect(findProjectionViolations(projected)).toEqual([]);
  });

  it("neutralizes a marker in a released raw finding too", () => {
    // The released path deliberately skips the projection, so the delimiter removal
    // is repeated by the one-line assembly: a forged sibling would break bd-174.3's
    // rewrite whichever path produced the bullet.
    const released = "<!-- belayd:usage --> stays in the compiled output";
    const record = recordOf([
      {
        ...deferredFinding(released),
        sensitivity: { sensitive: true, reasons: [{ kind: "security-topic", match: "token" }] },
        publication: { kind: "publish", source: "human", answer: "publish it" },
      },
    ]);
    const section = renderDeferredFindingsSection(record);
    expect(section).toContain("stays in the compiled output");
    expect(section).not.toContain("<!--");
    expect(section).not.toContain("-->");
  });

  it.each([
    ["an em dash", "the projection—not the rules—decides", "the projection-not the rules-decides"],
    ["curly quotes", "the ’quoted’ value is stale", "the 'quoted' value is stale"],
    ["an ellipsis", "the retry loop… allocates", "the retry loop... allocates"],
    ["an en dash", "lines 1–9 are stale", "lines 1-9 are stale"],
  ])("folds %s to ASCII", (_label, finding, expected) => {
    // The invariant is printable ASCII, not mangled text: typography that carries no
    // hidden word folds to the ASCII it reads as, and `?` stays for the rest.
    const projected = projectFindingText(finding);
    expect(projected).toBe(expected);
    expect(findProjectionViolations(projected)).toEqual([]);
  });
});

describe("renderer invariant — the projection holds for every finding", () => {
  /**
   * The adversarial corpus: each row is a shape an earlier review round proved the
   * classifier could miss, plus prose and placeholder rows that must survive as
   * readable text. Every bullet the renderer emits must satisfy the invariant
   * whatever the classifier answered — this is the durable guard that replaced
   * round-after-round archaeology.
   */
  const CORPUS = [
    "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN RSA PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "postgres://appuser:s3cr3t@db.internal/app",
    "id_rsa",
    ".env",
    "ghp_<token> appears in the docs",
    "AKIAXXXX is a placeholder in the README",
    "password=<token> is the documented shape",
    "the loop allocates on every iteration",
    "the fixture stores gh.p_ 16C7e42F292c691 2E7710c8383 47Ae178B4a verbatim",
    "16C7e42F292c6 91 src/a 12E7710c8383 47Ae178B4a src/a are logged",
    // Round-12 Critical: the split uses a token delimiter, not whitespace.
    "the fixture stores abcd12,34efgh,56ijkl,90mnop,12qrst,34uvwx verbatim",
  ] as const;

  /** Every separator class the rules and the projection are written for. */
  const SEPARATORS = [" ", "\t", "\n", "—", ".", "·", "\u200B", "р", ",", ";"] as const;

  /** Every bullet line the renderer produced, header excluded. */
  function bullets(section: string): readonly string[] {
    if (section === "") return [];
    const lines = section.split("\n");
    expect(lines[0]).toBe("### Deferred findings");
    return lines.slice(1);
  }

  it("holds for every separator inserted at every sampled position", () => {
    // Sampled (stride) rather than every position so the suite stays fast; the
    // classifier's own split-invariance test covers every position.
    for (const secret of CORPUS) {
      const stride = Math.max(1, Math.ceil(secret.length / 12));
      for (const separator of SEPARATORS) {
        for (let position = 0; position <= secret.length; position += stride) {
          const text = `audit note: ${secret.slice(0, position)}${separator}${secret.slice(position)} in the log`;
          const record = recordOf([deferredFinding(text)]);
          for (const bullet of bullets(renderDeferredFindingsSection(record))) {
            expect(findProjectionViolations(bullet), `${JSON.stringify(text)} → ${bullet}`).toEqual(
              [],
            );
            expect(findReassemblyViolations(bullet), `${JSON.stringify(text)} → ${bullet}`).toEqual(
              [],
            );
          }
        }
      }
    }
  });

  it("holds for the placeholder and prose rows", () => {
    const findings = CORPUS.map((text) => deferredFinding(text));
    const record = recordOf(findings);
    const section = renderDeferredFindingsSection(record, { maxItems: findings.length });
    for (const bullet of bullets(section)) {
      expect(findProjectionViolations(bullet), bullet).toEqual([]);
      // The reassembled reading: deleting everything outside a token body must not
      // weld one back together — the only check a chunked row can fail.
      expect(findReassemblyViolations(bullet), bullet).toEqual([]);
    }
  });

  it("is idempotent for every corpus row and stays inside the invariant", () => {
    // Round-11 Suggestion: `[value]` was re-read as an assignment value, so a second
    // projection grew the line (`password = [value]} in compose` → `…[value]]}…`).
    // The extra rows are the shapes the corpus does not carry: a marker followed by
    // `}`/`)`, an unpaired fence, typography, and a Title-Case sentence.
    const extraRows = [
      "password = [value]} in compose",
      "password = [value]) in compose",
      "password = [value]] in compose",
      "the digest [value] and [code] markers",
      "token = hunter2leak1 ``` opens an unclosed fence",
      "see\n```\nkey=abc\n```\nfor details",
      "the projection—not the rules—decides",
      "The Retry Logic Is Bounded",
      "the loop is slow. fix it",
    ];
    for (const text of [...CORPUS, ...extraRows]) {
      const once = projectFindingText(text);
      expect(projectFindingText(once), text).toBe(once);
      expect(findProjectionViolations(once), text).toEqual([]);
    }
  });

  it("allows raw text only for the finding a human released", () => {
    // A keyed exception, not a blanket one: the neighbour is projected even though
    // both findings are sensitive and the same human answered the gate.
    const released = SENSITIVE_FINDING;
    const neighbour =
      "`src/auth/session.ts:9` — session cookie ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged";
    const record = recordOf([
      {
        ...deferredFinding(released),
        publication: { kind: "publish", source: "human", answer: "publish it" },
      },
      deferredFinding(neighbour),
    ]);
    const section = renderDeferredFindingsSection(record);
    expect(section).toContain(released);
    expect(section).not.toContain(neighbour);
    expect(section).not.toContain("src/auth/session.ts:9");
    // Still single-line and capped, even for the released text.
    expect(
      section
        .split("\n")
        .slice(1)
        .every((line) => !line.includes("\n")),
    ).toBe(true);
    expect(Array.from(section.split("\n")[1] ?? "").length).toBeLessThanOrEqual(210);
  });

  it("caps a released raw finding rather than shipping it whole", () => {
    const long = `the loop allocates ${"and copies ".repeat(80)}in the hot path`;
    const record = recordOf([
      {
        ...deferredFinding(long),
        publication: { kind: "publish", source: "human", answer: "publish it" },
      },
    ]);
    const bullet =
      renderDeferredFindingsSection(record, { maxFindingChars: 40 }).split("\n")[1] ?? "";
    expect(Array.from(bullet).length).toBeLessThanOrEqual(42);
  });

  it("projects a non-sensitive finding even when the classifier missed a secret", () => {
    // The structural guarantee: the classifier is advisory, so a finding it calls
    // clean (`.`. inside an anchor) still cannot carry the token into the body.
    const token = "16C7e42F292c6912E7710c838347Ae178B4a";
    const record = recordOf([deferredFinding(`gh.p_${token} leaked in the log`)]);
    expect(evaluateDeferredFindingsGate(record).ok).toBe(true);
    const section = renderDeferredFindingsSection(record);
    expect(section).not.toBe("");
    expect(section).not.toContain(token);
  });
});
