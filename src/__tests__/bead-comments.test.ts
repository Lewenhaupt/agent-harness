import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { phaseCommentBody, phaseCommentHeader, stripBdShowComments } from "../bead-comments.js";

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
