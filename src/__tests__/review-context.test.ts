/**
 * Tests for review scoping (bd-113): the bounded output contract, diff-scope
 * classification, diff collection, and the review task layout.
 *
 * The pure helpers are tested without mocks. `collectReviewDiff` shells out to
 * git, so `node:child_process` is mocked with an argv-recording fake exactly
 * like the commit-path tests do.
 */

import { describe, expect, it, vi } from "vitest";
import {
  boundReviewOutput,
  classifyDiffScope,
  collectReviewDiff,
  formatReviewTask,
  REVIEW_LINE_NUMBER_INSTRUCTION,
  REVIEW_OUTPUT_CONTRACT,
  REVIEW_PROCESS_INSTRUCTION,
  REVIEW_SCOPE_INSTRUCTION,
  REVIEW_SECTION_LIMITS,
  type ReviewDiff,
} from "../review-context.js";

// ── git exec fake ──────────────────────────────────────────────────────

const mockExecFile = vi.hoisted(() => {
  const calls: Array<{ file: string; args: readonly string[]; cwd: string | undefined }> = [];
  let handler: (args: readonly string[]) => { stdout: string; error?: Error } = () => ({
    stdout: "",
  });
  const fn = vi.fn(
    (
      file: string,
      args: readonly string[],
      options: { cwd?: string },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ file, args: [...args], cwd: options.cwd });
      const outcome = handler(args);
      if (outcome.error) {
        callback(outcome.error, "", "Command failed");
      } else {
        callback(null, outcome.stdout, "");
      }
      return { stdin: { on: () => {}, end: () => {} } };
    },
  );
  return {
    fn,
    calls,
    setHandler: (next: (args: readonly string[]) => { stdout: string; error?: Error }) => {
      handler = next;
    },
    reset: () => {
      calls.length = 0;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: mockExecFile.fn };
});

// ── helpers ────────────────────────────────────────────────────────────

function bullets(file: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `- \`${file}:${index + 1}\` — defect`);
}

function section(heading: string, body: readonly string[]): string[] {
  return [heading, ...body, ""];
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function diffFixture(overrides: Partial<ReviewDiff> = {}): ReviewDiff {
  return {
    mode: "first",
    range: "base123",
    changedFiles: ["src/a.ts"],
    untrackedFiles: [],
    stat: " src/a.ts | 2 +-",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+line",
    truncated: false,
    docsOnly: false,
    ...overrides,
  };
}

const PREVIOUS_HEADER = ["diff", "--stat", "base123"];

/** A diff with hunk headers, the shape the reviewer actually receives. */
const HUNKED_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " context one",
  "-removed one",
  "+added two",
  " context three",
  "@@ -40,2 +41,2 @@",
  " context 41",
  "-removed 42",
  " context 42",
  "",
].join("\n");

/**
 * Install a `collectReviewDiff` git fake that answers the three diff calls with
 * one canned diff body.
 */
function installDiffHandler(diffBody: string, nameOnly = "src/a.ts"): void {
  mockExecFile.setHandler((args) => {
    if (args[0] === "merge-base") return { stdout: "base123\n" };
    if (args[0] === "diff" && args.includes("--stat")) return { stdout: " src/a.ts | 4 ++--\n" };
    if (args[0] === "diff" && args.includes("--name-only")) return { stdout: `${nameOnly}\n` };
    return { stdout: diffBody };
  });
  mockExecFile.reset();
}

// ── boundReviewOutput ──────────────────────────────────────────────────

describe("boundReviewOutput", () => {
  it("caps each section and appends one omission note per truncated section", () => {
    const text = [
      ...section("## Critical (must fix)", bullets("src/crit.ts", 9)),
      ...section("## Warnings (should fix)", bullets("src/warn.ts", 8)),
      ...section("## Suggestions (consider)", bullets("src/sugg.ts", 6)),
    ].join("\n");

    const result = boundReviewOutput(text);

    expect(countOccurrences(result.text, "src/crit.ts:")).toBe(REVIEW_SECTION_LIMITS.critical);
    expect(countOccurrences(result.text, "src/warn.ts:")).toBe(REVIEW_SECTION_LIMITS.warnings);
    expect(countOccurrences(result.text, "src/sugg.ts:")).toBe(REVIEW_SECTION_LIMITS.suggestions);
    expect(result.text).toContain(
      "- (+3 more omitted; see the full findings in the review transcript)",
    );
    expect(countOccurrences(result.text, "- (+2 more omitted")).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("preserves an explicit None section untouched", () => {
    const text = [...section("## Critical (must fix)", ["None"]), "## Task\nreview"].join("\n");
    const result = boundReviewOutput(text);
    expect(result.text).toContain("## Critical (must fix)\nNone");
    expect(result.truncated).toBe(false);
  });

  it("drops narration bullets, discloses the drop, and keeps a path-only finding", () => {
    const text = section("## Warnings (should fix)", [
      "- ✓ All error paths look correct",
      "- Checked `src/a.ts` and it is fine",
      "- `src/b.ts:12` — swallowed error",
      "- `src/only-path.ts` — wrong default",
    ]).join("\n");

    const result = boundReviewOutput(text);

    expect(result.text).not.toContain("✓");
    expect(result.text).not.toContain("it is fine");
    expect(result.text).toContain("- `src/b.ts:12` — swallowed error");
    // A path without a line number is a legitimate finding shape (W4).
    expect(result.text).toContain("- `src/only-path.ts` — wrong default");
    expect(result.text).toContain(
      "- (+2 malformed bullets dropped; see the full findings in the review transcript)",
    );
    expect(result.truncated).toBe(false);
  });

  it("keeps a path-only Critical and never drops it as malformed", () => {
    const text = section("## Critical (must fix)", ["- `src/a.ts` — wrong default"]).join("\n");
    const result = boundReviewOutput(text);
    expect(result.text).toContain("- `src/a.ts` — wrong default");
    expect(result.text).not.toContain("malformed bullets dropped");
  });

  it("leaves unknown sections and their bullets untouched", () => {
    const text = [
      "## Files Reviewed",
      "- `src/a.ts` (lines 1-2)",
      "",
      "## Summary",
      "Two defects found.",
    ].join("\n");

    const result = boundReviewOutput(text);

    expect(result.text).toBe(text);
  });

  it("is idempotent", () => {
    const text = [
      ...section("## Critical (must fix)", bullets("src/crit.ts", 9)),
      ...section("## Summary", ["Lots of issues."]),
    ].join("\n");

    const once = boundReviewOutput(text);
    const twice = boundReviewOutput(once.text);

    expect(twice.text).toBe(once.text);
    expect(twice.truncated).toBe(false);
    expect(countOccurrences(once.text, "- (+3 more omitted")).toBe(1);
  });

  it("is idempotent for the malformed-bullet marker too", () => {
    const text = section("## Warnings (should fix)", [
      "- ✓ All error paths look correct",
      "- `src/b.ts:12` — swallowed error",
    ]).join("\n");

    const once = boundReviewOutput(text);
    const twice = boundReviewOutput(once.text);

    expect(twice.text).toBe(once.text);
    expect(countOccurrences(once.text, "malformed bullets dropped")).toBe(1);
    expect(once.text).toContain("- `src/b.ts:12` — swallowed error");
  });

  it("bounds a repeated section independently and tolerates a missing trailing newline", () => {
    const text = [
      ...section("## Critical (must fix)", bullets("src/crit.ts", 8)),
      ...section("## Critical (must fix)", bullets("src/other.ts", 2)),
      "## Summary",
      "done",
    ]
      .join("\n")
      .trimEnd();

    const result = boundReviewOutput(text);

    expect(countOccurrences(result.text, "src/crit.ts:")).toBe(REVIEW_SECTION_LIMITS.critical);
    expect(countOccurrences(result.text, "src/other.ts:")).toBe(2);
    expect(result.text.endsWith("done")).toBe(true);
  });
});

// ── classifyDiffScope ─────────────────────────────────────────────────

describe("classifyDiffScope", () => {
  it("treats documentation paths as docs-only", () => {
    expect(classifyDiffScope(["docs/guide.md", "README.md", "LICENSE", "CHANGELOG.mdx"])).toBe(
      "docs-only",
    );
  });

  it("treats committed diagrams under docs/ as docs-only", () => {
    expect(classifyDiffScope(["docs/diagrams/architecture.html"])).toBe("docs-only");
  });

  it("treats a mixed change set as code", () => {
    expect(classifyDiffScope(["docs/guide.md", "src/a.ts"])).toBe("code");
  });

  it("treats an empty change set as code (unknown is not docs-only)", () => {
    expect(classifyDiffScope([])).toBe("code");
  });

  it("treats code paths as code", () => {
    expect(classifyDiffScope(["src/review-context.ts"])).toBe("code");
  });
});

// ── collectReviewDiff ─────────────────────────────────────────────────

describe("collectReviewDiff", () => {
  function installDefaultHandler(): void {
    mockExecFile.setHandler((args) => {
      if (args[0] === "merge-base") return { stdout: "base123\n" };
      if (args[0] === "diff" && args.includes("--stat")) {
        return { stdout: " src/a.ts | 2 +-\n" };
      }
      if (args[0] === "diff" && args.includes("--name-only")) {
        return { stdout: "src/a.ts\n" };
      }
      return { stdout: "diff --git a/src/a.ts b/src/a.ts\n+line\n" };
    });
  }

  it("diffs a first review from the merge base, working tree included", async () => {
    installDefaultHandler();
    mockExecFile.reset();

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("first");
    expect(result.value.range).toBe("base123");
    expect(result.value.changedFiles).toEqual(["src/a.ts"]);
    expect(result.value.stat).toBe("src/a.ts | 2 +-");
    expect(result.value.docsOnly).toBe(false);
    expect(result.value.truncated).toBe(false);
    const argv = mockExecFile.calls.map((call) => call.args);
    expect(argv).toContainEqual(["merge-base", "main", "HEAD"]);
    expect(argv).toContainEqual(["diff", "base123"]);
    expect(argv).toContainEqual(PREVIOUS_HEADER);
    expect(argv).toContainEqual(["diff", "--name-only", "base123"]);
  });

  it("diffs a re-review from the recorded sha only", async () => {
    installDefaultHandler();
    mockExecFile.reset();

    const result = await collectReviewDiff({ cwd: "/repo", reviewedSha: "abc4567" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("rereview");
    expect(result.value.range).toBe("abc4567");
    const argv = mockExecFile.calls.map((call) => call.args);
    expect(argv).toContainEqual(["diff", "abc4567"]);
    expect(argv.some((args) => args[0] === "merge-base")).toBe(false);
  });

  it("rejects a reviewed sha that is not a hex object name (S2)", async () => {
    mockExecFile.setHandler(() => ({ stdout: "" }));
    mockExecFile.reset();

    const result = await collectReviewDiff({ cwd: "/repo", reviewedSha: "main; rm -rf" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid reviewed sha");
    expect(mockExecFile.calls).toHaveLength(0);
  });

  it("collects untracked files into the change set and the docs-only decision (W1)", async () => {
    mockExecFile.setHandler((args) => {
      if (args[0] === "merge-base") return { stdout: "base123\n" };
      if (args[0] === "status") {
        return { stdout: '?? src/new.ts\n?? "docs/note with space.md"\n M src/a.ts\n' };
      }
      if (args.includes("--name-only")) return { stdout: "docs/guide.md\n" };
      if (args.includes("--stat")) return { stdout: " docs/guide.md | 1 +\n" };
      return { stdout: "diff --git a/docs/guide.md b/docs/guide.md\n" };
    });

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.untrackedFiles).toEqual(["src/new.ts", "docs/note with space.md"]);
    expect(result.value.changedFiles).toEqual([
      "docs/guide.md",
      "src/new.ts",
      "docs/note with space.md",
    ]);
    // The untracked code file must force the docs-only fast path off.
    expect(result.value.docsOnly).toBe(false);
  });

  it("stays docs-only when every tracked and untracked path is docs (W1)", async () => {
    mockExecFile.setHandler((args) => {
      if (args[0] === "merge-base") return { stdout: "base123\n" };
      if (args[0] === "status") return { stdout: "?? docs/new.md\n" };
      if (args.includes("--name-only")) return { stdout: "README.md\n" };
      if (args.includes("--stat")) return { stdout: " README.md | 1 +\n" };
      return { stdout: "diff --git a/README.md b/README.md\n" };
    });

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.docsOnly).toBe(true);
    expect(result.value.changedFiles).toEqual(["README.md", "docs/new.md"]);
  });

  it("reports a re-review failure instead of falling back to the whole change set", async () => {
    mockExecFile.setHandler((args) => {
      if (args.includes("abc7890")) return { stdout: "", error: new Error("unknown revision") };
      return { stdout: "base123\n" };
    });

    const result = await collectReviewDiff({ cwd: "/repo", reviewedSha: "abc7890" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("unknown revision");
  });

  it("falls back to the base branch and notes it when merge-base fails", async () => {
    mockExecFile.setHandler((args) => {
      if (args[0] === "merge-base") return { stdout: "", error: new Error("shallow clone") };
      if (args.includes("--name-only")) return { stdout: "docs/guide.md\n" };
      return { stdout: "diff --git a/docs/guide.md b/docs/guide.md\n" };
    });

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.range).toContain("main");
    expect(result.value.range).toContain("merge-base unavailable");
    expect(result.value.docsOnly).toBe(true);
  });

  it("truncates an oversized diff at the line cap with a git-range hint", async () => {
    const longDiff = Array.from({ length: 900 }, (_, index) => `+line ${index}`).join("\n");
    mockExecFile.setHandler((args) => {
      if (args[0] === "merge-base") return { stdout: "base123\n" };
      if (args.includes("--name-only")) return { stdout: "src/a.ts\n" };
      if (args.includes("--stat")) return { stdout: " src/a.ts | 2 +-\n" };
      return { stdout: longDiff };
    });

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.diff).toContain("(diff truncated: 100 more lines");
    expect(result.value.diff).toContain("git diff base123");
  });

  it("caps a single huge line instead of inlining it whole (W5)", async () => {
    const hugeLine = `+${"x".repeat(1024 * 1024)}`;
    mockExecFile.setHandler((args) => {
      if (args[0] === "merge-base") return { stdout: "base123\n" };
      if (args.includes("--name-only")) return { stdout: "src/bundle.ts\n" };
      if (args.includes("--stat")) return { stdout: " src/bundle.ts | 1 +\n" };
      return { stdout: hugeLine };
    });

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(Buffer.byteLength(result.value.diff, "utf8")).toBeLessThanOrEqual(60_000);
  });

  it("points the truncation hint at the actual git argument on the fallback path (S1)", async () => {
    const longDiff = Array.from({ length: 900 }, (_, index) => `+line ${index}`).join("\n");
    mockExecFile.setHandler((args) => {
      if (args[0] === "merge-base") return { stdout: "", error: new Error("shallow clone") };
      if (args.includes("--name-only")) return { stdout: "src/a.ts\n" };
      if (args.includes("--stat")) return { stdout: " src/a.ts | 2 +-\n" };
      return { stdout: longDiff };
    });

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `range` keeps its explanatory note, but the printed command stays valid.
    expect(result.value.range).toContain("merge-base unavailable");
    expect(result.value.diff).toContain("`git diff main`");
  });
});

// ── annotated diff line numbers (bd-159) ─────────────────────────────

describe("collectReviewDiff line-number gutter", () => {
  it("numbers added and context lines with their post-change line", async () => {
    installDiffHandler(HUNKED_DIFF);

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.diff.split("\n");
    // Headers, hunk headers and removed lines carry a blank gutter so the
    // numbering column stays aligned but never invents a line number.
    expect(lines[0]).toBe("      diff --git a/src/a.ts b/src/a.ts");
    expect(lines[4]).toBe("      @@ -1,3 +1,4 @@");
    expect(lines[5]).toBe("    1  context one");
    expect(lines[6]).toBe("      -removed one");
    expect(lines[7]).toBe("    2 +added two");
    expect(lines[8]).toBe("    3  context three");
  });

  it("restarts the numbering at each hunk header", async () => {
    installDiffHandler(HUNKED_DIFF);

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.diff.split("\n");
    expect(lines[9]).toBe("      @@ -40,2 +41,2 @@");
    expect(lines[10]).toBe("   41  context 41");
    expect(lines[11]).toBe("      -removed 42");
    expect(lines[12]).toBe("   42  context 42");
  });

  it("leaves a no-newline marker unnumbered and does not advance the cursor", async () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    installDiffHandler(diff);

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.diff.split("\n");
    expect(lines[4]).toBe("      -old");
    expect(lines[5]).toBe("    1 +new");
    expect(lines[6]).toBe("      \\ No newline at end of file");
  });

  it("keeps the gutter on a diff that hits the line cap", async () => {
    const longDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1,900 +1,900 @@",
      ...Array.from({ length: 900 }, (_, index) => `+line ${index}`),
    ].join("\n");
    installDiffHandler(longDiff);

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    const lines = result.value.diff.split("\n");
    // The last kept hunk line is still numbered, and the truncation note is not.
    const noteIndex = lines.findIndex((line) => line.includes("(diff truncated:"));
    expect(noteIndex).toBeGreaterThan(0);
    expect(lines[noteIndex - 1]).toMatch(/^ +\d+ \+line /);
    expect(lines[noteIndex]).not.toMatch(/^ +\d+ /);
  });

  it("keeps the byte cap while numbering lines", async () => {
    const hugeLine = `+${"x".repeat(1024 * 1024)}`;
    installDiffHandler(
      ["diff --git a/src/a.ts b/src/a.ts", "@@ -1,1 +1,1 @@", hugeLine, ""].join("\n"),
    );

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(Buffer.byteLength(result.value.diff, "utf8")).toBeLessThanOrEqual(60_000);
    expect(result.value.diff).toMatch(/^ {6}diff --git/m);
  });

  it("keeps the reviewer's own scratchpad out of the change set (bd-159)", async () => {
    mockExecFile.setHandler((args) => {
      if (args[0] === "merge-base") return { stdout: "base123\n" };
      if (args[0] === "status") {
        return { stdout: "?? .belayd/review-findings.md\n?? src/new.ts\n" };
      }
      if (args.includes("--name-only")) return { stdout: "src/a.ts\n" };
      if (args.includes("--stat")) return { stdout: " src/a.ts | 2 +-\n" };
      return { stdout: HUNKED_DIFF };
    });
    mockExecFile.reset();

    const result = await collectReviewDiff({ cwd: "/repo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.untrackedFiles).toEqual(["src/new.ts"]);
    expect(result.value.changedFiles).toEqual(["src/a.ts", "src/new.ts"]);
  });
});

// ── review process rules (bd-159) ────────────────────────────────────

describe("REVIEW_PROCESS_INSTRUCTION", () => {
  it("carries the scratchpad, one-check-per-response, and precedence rules", () => {
    expect(REVIEW_PROCESS_INSTRUCTION).toContain(".belayd/review-findings.md");
    expect(REVIEW_PROCESS_INSTRUCTION).toContain("Never re-derive a confirmed finding");
    expect(REVIEW_PROCESS_INSTRUCTION).toContain("one check per response");
    expect(REVIEW_PROCESS_INSTRUCTION).toContain("outranks the task text");
  });
});

// ── formatReviewTask ──────────────────────────────────────────────────

describe("formatReviewTask", () => {
  it("inlines the diff, the range, and the output contract for a first review", () => {
    const text = formatReviewTask({ paramsTask: "Review the change.", diff: diffFixture() });

    expect(text).toContain("## Review scope — diff inlined, do NOT re-derive the change set");
    expect(text).toContain("mode: first review");
    expect(text).toContain("range: base123");
    expect(text).toContain("changed files: 1 (docs-only diff: no)");
    expect(text).toContain("```diff");
    expect(text).toContain("+line");
    expect(text).toContain(REVIEW_SCOPE_INSTRUCTION);
    expect(text).toContain(REVIEW_LINE_NUMBER_INSTRUCTION);
    expect(text).toContain("## Output contract");
    expect(text).toContain(REVIEW_OUTPUT_CONTRACT);
    expect(text).toContain("## Task\nReview the change.");
    expect(text).not.toContain("## Prior findings to verify");
  });

  it("marks re-review mode and never quotes the task text twice", () => {
    const task = "Fix these findings: `src/a.ts:12` — swallowed error";
    const text = formatReviewTask({
      paramsTask: task,
      diff: diffFixture({ mode: "rereview", range: "fix456" }),
      priorFindings: task,
    });

    expect(text).toContain("mode: re-review of fixes");
    expect(text).toContain("range: fix456");
    expect(text).not.toContain("## Prior findings to verify");
    expect(countOccurrences(text, task)).toBe(1);
  });

  it("lists distinct prior findings for verification", () => {
    const text = formatReviewTask({
      paramsTask: "Verify the fix round.",
      diff: diffFixture({ mode: "rereview", range: "fix456" }),
      priorFindings: "- `src/a.ts:12` — swallowed error",
    });

    expect(text).toContain("## Prior findings to verify");
    expect(text).toContain("- `src/a.ts:12` — swallowed error");
    expect(text).toContain("Verify the fix round.");
  });

  it("adds the docs-only instruction only for a docs-only diff", () => {
    const codeText = formatReviewTask({ paramsTask: "t", diff: diffFixture() });
    const docsText = formatReviewTask({
      paramsTask: "t",
      diff: diffFixture({ changedFiles: ["docs/a.md"], docsOnly: true }),
    });

    expect(codeText).not.toContain("Docs-only diff:");
    expect(docsText).toContain("Docs-only diff:");
    expect(docsText).toContain("docs-only diff: yes");
  });

  it("lists untracked files with an instruction to read them directly (W1)", () => {
    const text = formatReviewTask({
      paramsTask: "Review.",
      diff: diffFixture({
        changedFiles: ["src/a.ts", "src/new.ts"],
        untrackedFiles: ["src/new.ts"],
      }),
    });

    expect(text).toContain("changed files: 2");
    expect(text).toContain("New (untracked) files — read these directly");
    expect(text).toContain("- `src/new.ts`");
  });

  it("discloses an unavailable diff and drops the no-discovery instruction (W3)", () => {
    const text = formatReviewTask({
      paramsTask: "Review.",
      diffUnavailable: "merge-base failed",
    });

    expect(text).toContain("## Review scope — diff unavailable");
    expect(text).toContain("diff unavailable (merge-base failed)");
    expect(text).toContain("fall back to your own `git diff`/`git status`");
    expect(text).not.toContain(REVIEW_SCOPE_INSTRUCTION);
    // No diff is inlined here, so there is no gutter to read either.
    expect(text).not.toContain(REVIEW_LINE_NUMBER_INSTRUCTION);
    expect(text).toContain("## Output contract");
    expect(text).toContain("## Task\nReview.");
  });

  it("keeps distinct prior findings in the unavailable-diff task", () => {
    const text = formatReviewTask({
      paramsTask: "Verify the fix round.",
      priorFindings: "- `src/a.ts:12` — swallowed error",
      diffUnavailable: "git failed",
    });

    expect(text).toContain("## Prior findings to verify");
    expect(text).toContain("- `src/a.ts:12` — swallowed error");
    expect(text).toContain("## Task\nVerify the fix round.");
  });
});
