import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  BEAD_READ_MAX_BUFFER_BYTES,
  BEAD_READ_TIMEOUT_MS,
  buildBeadCommentsArgv,
  COMMENT_EXCERPT_MAX_CHARS,
  commentTimeInMs,
  excerptComment,
  isHumanComment,
  lookupBeadComments,
  parseBeadComments,
  phaseCommentBody,
  phaseCommentHeader,
  stripBdShowComments,
} from "../bead-comments.js";
import type { FleetBeadRunner } from "../fleet-beads.js";

// Real `bd show` transcript captured for the section-order invariant, so the
// "COMMENTS is last" assumption is checked against bd's actual layout rather
// than a hand-written fixture. Provenance: throwaway embedded-Dolt database
// (`bd init --non-interactive --prefix sandbox` in a temp dir), then
// `bd create "Fixture bead for bd show comment stripping" --type task`, a
// `--design`/`--notes` update, one `bd comment --stdin -- sandbox-dfr` with a
// `[belayd:userguide]` body, and `bd show sandbox-dfr` captured verbatim.
const REAL_SHOW_TRANSCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bd-show-with-comments.txt"),
  "utf8",
);

/** Column-0 ALL-CAPS lines; `bd show` indents every body line by two spaces. */
function sectionHeadings(text: string): string[] {
  return text.split("\n").filter((line) => /^[A-Z][A-Z ]+$/.test(line));
}

describe("phaseCommentHeader", () => {
  it("names the authoring phase", () => {
    expect(phaseCommentHeader("userguide")).toBe("[belayd:userguide]");
    expect(phaseCommentHeader("proof-verifier")).toBe("[belayd:proof-verifier]");
  });
});

describe("phaseCommentBody", () => {
  it("puts the phase header on its own first line", () => {
    const body = phaseCommentBody("research", "## Findings\nanswer");

    expect(body).toBe("[belayd:research]\n## Findings\nanswer");
    expect(body.split("\n")[0]).toBe("[belayd:research]");
  });

  it("keeps CRLF content verbatim", () => {
    const content = "## How to Verify\r\n1. Run tests";
    const body = phaseCommentBody("userguide", content);

    expect(body).toContain(content);
  });

  it("keeps blank content as a header-only comment", () => {
    expect(phaseCommentBody("proof-verifier", "")).toBe("[belayd:proof-verifier]\n");
  });
});

describe("stripBdShowComments", () => {
  const showText = [
    "◐ bd-42 · Add a thing   [P2 · IN_PROGRESS]",
    "",
    "DESCRIPTION",
    "",
    "  The plan body.",
    "",
    "NOTES",
    "",
    "  Notes body.",
    "",
    "RELATED",
    "  ↔ ✓ bd-41: parent P2",
    "",
    "COMMENTS",
    "  2026-10-26 10:00 Hugo",
    "",
    "      [belayd:userguide]",
    "",
    "      ## User guide",
  ].join("\n");

  it("keeps description/notes/design and drops the whole thread", () => {
    const plan = stripBdShowComments(showText);

    expect(plan).toContain("DESCRIPTION");
    expect(plan).toContain("The plan body.");
    expect(plan).toContain("NOTES");
    expect(plan).toContain("Notes body.");
    expect(plan).toContain("RELATED");
    expect(plan).not.toContain("COMMENTS");
    expect(plan).not.toContain("[belayd:userguide]");
    expect(plan).not.toContain("## User guide");
  });

  it("is a no-op when the bead has no comments", () => {
    const withoutComments = "bd-42 · Title\n\nDESCRIPTION\n\n  Plan body.\n";

    expect(stripBdShowComments(withoutComments)).toBe(withoutComments);
  });

  it("does not cut on an indented COMMENTS word inside the plan body", () => {
    const text = ["DESCRIPTION", "", "  COMMENTS are written at the end.", "", "NOTES", ""].join(
      "\n",
    );

    expect(stripBdShowComments(text)).toBe(text);
  });

  it("handles CRLF output", () => {
    const text = "DESCRIPTION\r\n\r\n  Plan body.\r\n\r\nCOMMENTS\r\n  2026-10-26 Hugo\r\n";

    expect(stripBdShowComments(text)).toBe("DESCRIPTION\r\n\r\n  Plan body.");
  });

  it("is idempotent", () => {
    const once = stripBdShowComments(showText);

    expect(stripBdShowComments(once)).toBe(once);
  });
});

// The strip drops everything from the COMMENTS heading to the end of bd's
// output, so the layout must actually end there. This block enforces that
// invariant against the real transcript above: if a future bd prints a section
// after COMMENTS, these tests fail loudly instead of a silent plan-data loss.
describe("stripBdShowComments on a real bd show transcript", () => {
  it("has the plan sections the strip must preserve", () => {
    expect(sectionHeadings(REAL_SHOW_TRANSCRIPT)).toEqual([
      "DESCRIPTION",
      "DESIGN",
      "NOTES",
      "COMMENTS",
    ]);
    expect(REAL_SHOW_TRANSCRIPT).toContain("The notes blob stays the plan.");
    expect(REAL_SHOW_TRANSCRIPT).toContain("[belayd:userguide]");
  });

  it("ends at the COMMENTS section: no column-0 heading follows it", () => {
    const lines = REAL_SHOW_TRANSCRIPT.split("\n");
    const commentsIndex = lines.indexOf("COMMENTS");

    expect(commentsIndex).toBeGreaterThan(-1);
    expect(sectionHeadings(lines.slice(commentsIndex + 1).join("\n"))).toEqual([]);
  });

  it("keeps description/design/notes and drops the authored thread", () => {
    const plan = stripBdShowComments(REAL_SHOW_TRANSCRIPT);

    expect(plan).toContain("Fixture bead for bd show comment stripping");
    expect(plan).toContain("Capture output shape.");
    expect(plan).toContain("The notes blob stays the plan.");
    expect(plan).not.toContain("COMMENTS");
    expect(plan).not.toContain("[belayd:userguide]");
    expect(plan).not.toContain("docs/sandbox-dfr-userguide.md");
  });
});

// ---------------------------------------------------------------------------
// bd-152: the read-only comment reader (the human answer channel).
// ---------------------------------------------------------------------------

function recorder(stdout = "[]"): {
  runBd: FleetBeadRunner;
  calls: Array<{ argv: readonly string[]; options: unknown }>;
} {
  const calls: Array<{ argv: readonly string[]; options: unknown }> = [];
  const runBd: FleetBeadRunner = async (argv, options) => {
    calls.push({ argv, options });
    return { stdout };
  };
  return { runBd, calls };
}

describe("buildBeadCommentsArgv", () => {
  it("asks for one bead's thread as JSON", () => {
    expect(buildBeadCommentsArgv("bd-152")).toEqual(["comments", "bd-152", "--json"]);
  });
});

describe("parseBeadComments", () => {
  it("parses bd's record shape", () => {
    const comments = parseBeadComments([
      {
        id: "c-1",
        issue_id: "bd-152",
        author: "hugo",
        created_at: "2026-10-26T20:14:36Z",
        text: "yes, option b",
      },
    ]);

    expect(comments).toEqual([
      {
        id: "c-1",
        issueId: "bd-152",
        author: "hugo",
        createdAt: "2026-10-26T20:14:36Z",
        text: "yes, option b",
      },
    ]);
  });

  it("tolerates null, a single object, and junk records without throwing", () => {
    expect(parseBeadComments(null)).toEqual([]);
    expect(parseBeadComments("not json at all")).toEqual([]);
    expect(parseBeadComments({ id: "c-9", text: "one comment" })).toEqual([
      { id: "c-9", issueId: "", author: "", createdAt: "", text: "one comment" },
    ]);
    // Records without an id or a body cannot be delivered as an answer.
    expect(parseBeadComments([{ text: "no id" }, { id: "c-2" }, null, 7])).toEqual([]);
  });
});

describe("isHumanComment", () => {
  it("treats anything not authored by the harness as a human answer", () => {
    expect(isHumanComment({ author: "hugo" })).toBe(true);
    expect(isHumanComment({ author: "some-tool" })).toBe(true);
    expect(isHumanComment({ author: "" })).toBe(true);
    expect(isHumanComment({ author: "belayd:bd-152:orchestrator" })).toBe(false);
    expect(isHumanComment({ author: "belayd:supervisor" })).toBe(false);
  });

  it("accepts a bare author string", () => {
    expect(isHumanComment("belayd:bd-152:implement")).toBe(false);
    expect(isHumanComment("hugo")).toBe(true);
  });
});

describe("excerptComment", () => {
  it("collapses whitespace and newlines into one line", () => {
    expect(excerptComment("yes\n\n  option   b\r\n")).toBe("yes option b");
  });

  it("truncates at the cap without exceeding it", () => {
    const long = "a".repeat(COMMENT_EXCERPT_MAX_CHARS + 500);
    const excerpt = excerptComment(long);

    expect(excerpt).toHaveLength(COMMENT_EXCERPT_MAX_CHARS);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("keeps text exactly at the cap intact and truncates one char over it", () => {
    const atCap = "a".repeat(COMMENT_EXCERPT_MAX_CHARS);
    // Exactly at the cap: no ellipsis, nothing dropped.
    expect(excerptComment(atCap)).toBe(atCap);

    const excerpt = excerptComment(`${atCap}b`);
    expect(excerpt).toHaveLength(COMMENT_EXCERPT_MAX_CHARS);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.slice(0, -1)).toBe("a".repeat(COMMENT_EXCERPT_MAX_CHARS - 1));
  });

  it("honors an explicit cap and keeps short text intact", () => {
    expect(excerptComment("short", 10)).toBe("short");
    expect(excerptComment("abcdef", 4)).toBe("abc…");
    expect(excerptComment("abcdef", 1)).toBe("…");
  });
});

describe("commentTimeInMs", () => {
  it("parses bd's ISO timestamp and reports junk as NaN", () => {
    expect(
      commentTimeInMs({
        id: "c-1",
        issueId: "bd-152",
        author: "hugo",
        createdAt: "2026-10-26T20:14:36Z",
        text: "x",
      }),
    ).toBe(Date.parse("2026-10-26T20:14:36Z"));
    expect(
      Number.isNaN(
        commentTimeInMs({ id: "c-1", issueId: "", author: "", createdAt: "later", text: "x" }),
      ),
    ).toBe(true);
  });
});

describe("lookupBeadComments", () => {
  it("runs one bounded read-only comments command", async () => {
    const { runBd, calls } = recorder(
      JSON.stringify([{ id: "c-1", issue_id: "bd-152", author: "hugo", text: "ok" }]),
    );

    const result = await lookupBeadComments({ beadId: "bd-152", cwd: "/repo", runBd });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.comments.map((comment) => comment.author)).toEqual(["hugo"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["comments", "bd-152", "--json"]);
    expect(calls[0]?.options).toEqual({
      cwd: "/repo",
      stdin: undefined,
      timeoutInMs: BEAD_READ_TIMEOUT_MS,
      maxBufferInBytes: BEAD_READ_MAX_BUFFER_BYTES,
    });
  });

  it("refuses a non-read argv without spawning bd", async () => {
    const runBd = vi.fn<FleetBeadRunner>();

    const result = await lookupBeadComments({
      beadId: "bd-152",
      cwd: "/repo",
      runBd,
      buildArgv: () => ["comment", "--stdin", "--", "bd-152"],
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("refusing non-read bd argv");
    expect(runBd).not.toHaveBeenCalled();
  });

  it("refuses a flag-like bead id without spawning bd", async () => {
    const runBd = vi.fn<FleetBeadRunner>();
    const result = await lookupBeadComments({ beadId: "--stdin", cwd: "/repo", runBd });

    expect(result).toHaveProperty("ok", false);
    expect(runBd).not.toHaveBeenCalled();
  });

  it("degrades to an error value when bd fails or prints non-JSON", async () => {
    const failing: FleetBeadRunner = async () => {
      throw new Error("no beads database found");
    };
    const failed = await lookupBeadComments({ beadId: "bd-152", cwd: "/repo", runBd: failing });
    expect(failed).toHaveProperty("ok", false);
    if (failed.ok) return;
    expect(failed.error).toContain("no beads database found");

    const malformed = await lookupBeadComments({
      beadId: "bd-152",
      cwd: "/repo",
      runBd: recorder("Warning: .beads has permissions 0755").runBd,
    });
    expect(malformed).toHaveProperty("ok", false);
  });
});
