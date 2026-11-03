/**
 * On-disk session transcript reader (bd-189).
 *
 * Resolution is tested through all three of pi's session-directory precedence
 * branches, and parsing/paging against real JSONL shapes captured from a pi
 * session file: a header line, `session_info`, `model_change`, `custom`, and
 * `message` entries whose content is an array of `text`/`thinking`/`toolCall`/
 * `toolResult` blocks. A trailing newline, a garbage line and a blank line are
 * in the fixture on purpose — a session file can be read mid-write.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectSessionDir, resolveProjectSessionPath } from "../session-naming.js";
import {
  formatTranscriptPage,
  listSessionTranscriptFiles,
  nodeSessionTranscriptFs,
  parseTranscriptEntries,
  readTranscriptPage,
  readTranscriptSlice,
  selectSessionTranscript,
  TRANSCRIPT_HEADER_MAX_BYTES,
  TRANSCRIPT_MAX_INPUT_BYTES,
  TRANSCRIPT_PAGE_DEFAULT_LIMIT,
  TRANSCRIPT_PAGE_MAX_BYTES,
} from "../session-transcript-file.js";

const TASK_ID = "bd-189";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "belayd-transcript-file-"));
  env = {};
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSession(dir: string, sessionId: string, lines: readonly unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-11-02T10-00-00-000Z_${sessionId}.jsonl`);
  const body = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line)));
  writeFileSync(path, `${body.join("\n")}\n`, "utf8");
  return path;
}

function header(sessionId: string, cwd = "/repo") {
  return { type: "session", version: 3, id: sessionId, timestamp: "2026-11-02T10:00:00.000Z", cwd };
}

let sequence = 0;

function message(role: string, content: unknown) {
  sequence += 1;
  return {
    type: "message",
    id: `entry-${sequence.toString()}`,
    parentId: null,
    timestamp: `2026-11-02T10:00:${(sequence + 10).toString().padStart(2, "0")}.000Z`,
    message: { role, content },
  };
}

function text(value: string) {
  return { type: "text", text: value };
}

/** The three shapes a real phase transcript mixes: text, thinking and tools. */
function fixtureLines(): unknown[] {
  return [
    header(`belayd-${TASK_ID}-sub-implement-abc123`),
    {
      type: "session_info",
      id: "s1",
      parentId: null,
      name: `belayd-${TASK_ID}-sub-implement-abc123`,
    },
    { type: "model_change", provider: "commandcode", modelId: "deepseek/deepseek-v4.1-flash" },
    { type: "custom", customType: "plannotator", data: {} },
    message("system", ""),
    message("user", [text("implement bd-189")]),
    message("assistant", [
      { type: "thinking", thinking: "planning the edits" },
      { type: "toolCall", name: "read", arguments: {} },
      { type: "toolCall", name: "edit", arguments: {} },
    ]),
    message("toolResult", [text("file contents")]),
    message("assistant", [text("done: added the digest module")]),
    "this line is not json",
    "",
    message("assistant", [text("x".repeat(5_000))]),
  ];
}

const slugFor = (cwd: string): string => `--${cwd.replace(/^\//u, "").replace(/[/\\:]/gu, "-")}--`;

describe("session transcript path resolution", () => {
  it("prefers PI_CODING_AGENT_SESSION_DIR over everything else", () => {
    const override = join(root, "override");
    const path = writeSession(override, `belayd-${TASK_ID}-sub-implement-abc123`, [header("x")]);
    const agentDir = join(root, "agent");
    env = { PI_CODING_AGENT_SESSION_DIR: override, PI_CODING_AGENT_DIR: agentDir };

    expect(resolveProjectSessionDir({ cwd: "/repo", env })).toBe(override);
    expect(resolveProjectSessionPath("x", { cwd: "/repo", env })).toBe(path);
    expect(resolveProjectSessionPath("missing", { cwd: "/repo", env })).toBeUndefined();
  });

  it("uses sessionDir from <agentDir>/settings.json when the override is unset", () => {
    const agentDir = join(root, "agent");
    const configured = join(root, "configured");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ sessionDir: configured }),
      "utf8",
    );
    writeSession(configured, "custom-id", [header("custom-id")]);
    env = { PI_CODING_AGENT_DIR: agentDir };

    expect(resolveProjectSessionDir({ cwd: "/repo", env })).toBe(configured);
    expect(resolveProjectSessionPath("custom-id", { cwd: "/repo", env })).toBeDefined();
  });

  it("falls back to <agentDir>/sessions/<project-slug>/", () => {
    const agentDir = join(root, "agent");
    const cwd = "/repo.feat-bd-189";
    writeSession(join(agentDir, "sessions", slugFor(cwd)), "slug-id", [header("slug-id")]);
    env = { PI_CODING_AGENT_DIR: agentDir };

    expect(resolveProjectSessionDir({ cwd, env })).toBe(join(agentDir, "sessions", slugFor(cwd)));
    expect(resolveProjectSessionPath("slug-id", { cwd, env })).toBeDefined();
    // Belt and braces: the documented layout is what the reader enumerates.
    expect(listSessionTranscriptFiles({ cwd, env }).map((file) => file.sessionId)).toEqual([
      "slug-id",
    ]);
  });

  it("ignores session files whose header is missing or unparsable", () => {
    const dir = join(root, "override");
    writeSession(dir, "good", [header("good")]);
    writeFileSync(join(dir, "broken.jsonl"), "not json at all\n", "utf8");
    // A directory can carry a `.jsonl` name too; enumerating must not throw on it.
    mkdirSync(join(dir, "2026-11-02T10-00-00-000Z_is-a-directory.jsonl"), { recursive: true });
    env = { PI_CODING_AGENT_SESSION_DIR: dir };

    expect(listSessionTranscriptFiles({ env }).map((file) => file.sessionId)).toEqual(["good"]);
  });
});

describe("session transcript selection", () => {
  beforeEach(() => {
    env = { PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") };
  });

  it("selects the orchestrator session and never a look-alike task id", () => {
    const dir = join(root, "sessions");
    writeSession(dir, "belayd-bd-18", [header("belayd-bd-18")]);
    const wanted = writeSession(dir, `belayd-${TASK_ID}`, [header(`belayd-${TASK_ID}`)]);

    expect(selectSessionTranscript({ taskId: TASK_ID, range: "orchestrator", env })?.path).toBe(
      wanted,
    );
    expect(
      selectSessionTranscript({ taskId: "bd-18", range: "orchestrator", env })?.sessionId,
    ).toBe("belayd-bd-18");
  });

  it("narrows the phase range by phase name", () => {
    const dir = join(root, "sessions");
    writeSession(dir, `belayd-${TASK_ID}-sub-implement-a`, [
      header(`belayd-${TASK_ID}-sub-implement-a`),
    ]);
    writeSession(dir, `belayd-${TASK_ID}-sub-review-b`, [header(`belayd-${TASK_ID}-sub-review-b`)]);

    expect(
      selectSessionTranscript({ taskId: TASK_ID, range: "phase", phase: "review", env })?.sessionId,
    ).toBe(`belayd-${TASK_ID}-sub-review-b`);
    expect(selectSessionTranscript({ taskId: TASK_ID, range: "phase", env })?.sessionId).toBe(
      `belayd-${TASK_ID}-sub-review-b`,
    );
  });

  it("reports a missing transcript as an error value instead of throwing", () => {
    const result = readTranscriptPage({ taskId: TASK_ID, range: "phase", env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`no phase transcript found for ${TASK_ID}`);
  });
});

describe("session transcript parsing", () => {
  it("keeps conversational entries and drops the system prompt and non-messages", () => {
    const entries = parseTranscriptEntries(
      fixtureLines()
        .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
        .join("\n"),
    );

    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "assistant",
    ]);
    expect(entries[0]?.text).toBe("implement bd-189");
    expect(entries[1]?.text).toBe("[tool: read] [tool: edit]");
    expect(entries[2]?.text).toBe("file contents");
    expect(entries[3]?.text.startsWith("done: added")).toBe(true);
    // Indices are stable positions among transcript entries, which is what
    // paging offsets count.
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("tolerates a trailing newline, blank lines and garbage lines", () => {
    const raw = [
      JSON.stringify(header("id")),
      "",
      "}",
      JSON.stringify(message("assistant", [text("kept")])),
      "",
    ].join("\n");
    expect(parseTranscriptEntries(raw).map((entry) => entry.text)).toEqual(["kept"]);
  });
});

describe("session transcript paging", () => {
  beforeEach(() => {
    env = { PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") };
    const lines: unknown[] = [header(`belayd-${TASK_ID}-sub-implement-abc123`)];
    for (let index = 0; index < 30; index += 1) {
      lines.push(message("assistant", [text(`step ${index.toString()}`)]));
    }
    writeSession(join(root, "sessions"), `belayd-${TASK_ID}-sub-implement-abc123`, lines);
  });

  it("returns the newest page first, with offset/total/hasMore and a next hint", () => {
    const result = readTranscriptPage({
      taskId: TASK_ID,
      range: "phase",
      env,
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.page.offset).toBe(0);
    expect(result.page.total).toBe(30);
    expect(result.page.hasMore).toBe(true);
    expect(result.page.lines).toHaveLength(5);
    expect(result.page.lines.at(-1)).toContain("step 29");
    expect(result.page.lines[0]).toContain("step 25");

    const text = formatTranscriptPage(result.page);
    expect(text).toContain("offset 0, total 30, hasMore yes");
    expect(text).toContain("next: call belayd_transcript with offset 5 for older entries");
  });

  it("pages backwards, so page 2 differs from page 1 and ends at the hint", () => {
    const page1 = readTranscriptPage({ taskId: TASK_ID, range: "phase", env, limit: 5 });
    const page2 = readTranscriptPage({ taskId: TASK_ID, range: "phase", env, limit: 5, offset: 5 });
    const last = readTranscriptPage({ taskId: TASK_ID, range: "phase", env, limit: 5, offset: 25 });
    expect(page1.ok && page2.ok && last.ok).toBe(true);
    if (!page1.ok || !page2.ok || !last.ok) return;

    expect(page2.page.lines).not.toEqual(page1.page.lines);
    expect(page2.page.lines.at(-1)).toContain("step 24");
    expect(last.page.lines[0]).toContain("step 0");
    expect(last.page.hasMore).toBe(false);
    expect(formatTranscriptPage(last.page)).toContain("end of transcript");
  });

  it("caps a page's bytes and truncates individual entries", () => {
    const dir = join(root, "big");
    const lines: unknown[] = [header(`belayd-${TASK_ID}-sub-implement-big`)];
    for (let index = 0; index < 20; index += 1) {
      lines.push(message("assistant", [text(`entry ${index.toString()} ${"y".repeat(2_000)}`)]));
    }
    writeSession(dir, `belayd-${TASK_ID}-sub-implement-big`, lines);
    const result = readTranscriptPage({
      taskId: TASK_ID,
      range: "phase",
      env: { PI_CODING_AGENT_SESSION_DIR: dir },
      limit: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.page.truncated).toBe(true);
    expect(result.page.hasMore).toBe(true);
    expect(Buffer.byteLength(result.page.lines.join("\n"), "utf8")).toBeLessThanOrEqual(
      TRANSCRIPT_PAGE_MAX_BYTES,
    );
    // Per-entry cap, not a whole-entry drop.
    expect(result.page.lines.at(-1)?.endsWith("…")).toBe(true);
  });

  it("defaults to a small page instead of the whole session", () => {
    const result = readTranscriptPage({ taskId: TASK_ID, range: "phase", env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.lines).toHaveLength(TRANSCRIPT_PAGE_DEFAULT_LIMIT);
  });

  it("accepts offset === total as the explicit end of the transcript", () => {
    const result = readTranscriptPage({ taskId: TASK_ID, range: "phase", env, offset: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.page.offset).toBe(30);
    expect(result.page.lines).toEqual([]);
    expect(result.page.hasMore).toBe(false);
    expect(formatTranscriptPage(result.page)).toContain("end of transcript");
  });

  it("refuses an offset past the end by name instead of clamping it (S2a)", () => {
    const result = readTranscriptPage({ taskId: TASK_ID, range: "phase", env, offset: 400 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("offset 400 is past the end of this transcript (30 entries)");
  });

  it("emits an over-budget entry truncated and advances instead of looping (S2b)", () => {
    const dir = join(root, "huge");
    const lines: unknown[] = [
      header(`belayd-${TASK_ID}-sub-implement-huge`),
      message("assistant", [text(`huge entry ${"z".repeat(20_000)}`)]),
      message("assistant", [text(`small step`)]),
    ];
    writeSession(dir, `belayd-${TASK_ID}-sub-implement-huge`, lines);
    const env2 = { PI_CODING_AGENT_SESSION_DIR: dir };

    // `offset === total - 1` lands on the byte-cap-exceeding entry: it is still
    // emitted (cut) so the caller reaches the end instead of looping on it.
    const oldest = readTranscriptPage({
      taskId: TASK_ID,
      range: "phase",
      env: env2,
      offset: 1,
      limit: 1,
      maxBytes: 400,
      entryMaxChars: 20_000,
    });
    expect(oldest.ok).toBe(true);
    if (!oldest.ok) return;
    expect(oldest.page.lines).toHaveLength(1);
    expect(oldest.page.lines[0]).toContain("huge entry");
    expect(oldest.page.lines[0]).toContain("… truncated");
    expect(oldest.page.hasMore).toBe(false);
    expect(formatTranscriptPage(oldest.page)).toContain("end of transcript");

    // When it is instead the newest entry, the page consumes it and the next
    // offset actually moves: no repeat of the same request.
    const newest = readTranscriptPage({
      taskId: TASK_ID,
      range: "phase",
      env: env2,
      offset: 0,
      limit: 1,
      maxBytes: 400,
      entryMaxChars: 20_000,
    });
    expect(newest.ok).toBe(true);
    if (!newest.ok) return;
    expect(newest.page.lines).toHaveLength(1);
    expect(newest.page.lines[0]).toContain("small step");
    expect(formatTranscriptPage(newest.page)).toContain("offset 1 for older entries");
  });

  it("reports a file it cannot read instead of throwing (S4)", () => {
    const dir = join(root, "sessions2");
    const path = writeSession(dir, `belayd-${TASK_ID}-sub-implement-unreadable`, [
      header(`belayd-${TASK_ID}-sub-implement-unreadable`),
      message("assistant", [text("hidden")]),
    ]);
    // A directory where a file is expected, then an unreadable file: both are
    // errors-as-values (a real chmod 000 does not fail when tests run as root).
    const asDirectory = {
      ...nodeSessionTranscriptFs,
      readTail: () => {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), {
          code: "EISDIR",
        });
      },
    };
    const result = readTranscriptPage({
      taskId: TASK_ID,
      range: "phase",
      env: { PI_CODING_AGENT_SESSION_DIR: dir },
      fs: asDirectory,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("could not be read");
    expect(result.error).toContain(path);
  });

  it("bounds the input read and says the session was only partly read (S2c)", () => {
    const dir = join(root, "long");
    const lines: unknown[] = [header(`belayd-${TASK_ID}-sub-implement-long`)];
    for (let index = 0; index < 60; index += 1) {
      lines.push(message("assistant", [text(`entry ${index.toString()} ${"q".repeat(200)}`)]));
    }
    writeSession(dir, `belayd-${TASK_ID}-sub-implement-long`, lines);
    const result = readTranscriptPage({
      taskId: TASK_ID,
      range: "phase",
      env: { PI_CODING_AGENT_SESSION_DIR: dir },
      maxInputBytes: 2_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.page.partialRead).toBe(true);
    expect(result.page.total).toBeLessThan(60);
    expect(formatTranscriptPage(result.page)).toContain(
      "only the newest part of the session was read",
    );
  });

  it("never reads a whole session file, however large it is (W1)", () => {
    // A small real header, then a body far larger than both the tail bound and
    // the header prefix. Resolution must read a bounded head, paging a bounded
    // tail, and nothing may slurp the file.
    const dir = join(root, "huge-session");
    const sessionId = `belayd-${TASK_ID}-sub-implement-vast`;
    mkdirSync(dir, { recursive: true });
    const filler = message("assistant", [text(`filler ${"f".repeat(4_000)}`)]);
    const body = Array.from({ length: 1_100 }, () => JSON.stringify(filler)).join("\n");
    const path = join(dir, `2026-11-02T10-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify(header(sessionId))}\n${body}\n` +
        `${JSON.stringify(message("assistant", [text("newest step")]))}\n`,
      "utf8",
    );
    const fileSize = statSync(path).size;
    expect(fileSize).toBeGreaterThan(TRANSCRIPT_MAX_INPUT_BYTES);

    const reads: Array<{ kind: string; maxBytes: number }> = [];
    const recordingFs = {
      ...nodeSessionTranscriptFs,
      readHead: (target: string, maxBytes: number) => {
        reads.push({ kind: "head", maxBytes });
        return nodeSessionTranscriptFs.readHead(target, maxBytes);
      },
      readTail: (target: string, maxBytes: number) => {
        reads.push({ kind: "tail", maxBytes });
        return nodeSessionTranscriptFs.readTail(target, maxBytes);
      },
      readFileSync: (target: string, encoding: "utf8") => {
        reads.push({ kind: "whole-file", maxBytes: Number.POSITIVE_INFINITY });
        return nodeSessionTranscriptFs.readFileSync(target, encoding);
      },
    };

    const result = readTranscriptPage({
      taskId: TASK_ID,
      range: "phase",
      env: { PI_CODING_AGENT_SESSION_DIR: dir },
      fs: recordingFs,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Resolution and paging worked from the bounded reads alone.
    expect(result.page.sessionId).toBe(sessionId);
    expect(result.page.path).toBe(path);
    expect(result.page.lines.at(-1)).toContain("newest step");
    expect(result.page.partialRead).toBe(true);
    // The header read is the fixed header prefix, never the file.
    const headReads = reads.filter((read) => read.kind === "head");
    expect(headReads.length).toBeGreaterThan(0);
    expect(headReads.every((read) => read.maxBytes === TRANSCRIPT_HEADER_MAX_BYTES)).toBe(true);
    // No read — head, tail or otherwise — was allowed to cover the whole file.
    expect(reads.every((read) => read.maxBytes < fileSize)).toBe(true);
    expect(reads.some((read) => read.kind === "whole-file")).toBe(false);
  });

  it("fails soft on a header longer than the header prefix", () => {
    const dir = join(root, "long-header");
    mkdirSync(dir, { recursive: true });
    // A JSON header padded past the prefix: it cannot be identified, so it must
    // not match, and must not trigger a whole-file read to try.
    const sessionId = `belayd-${TASK_ID}-sub-implement-longheader`;
    const path = join(dir, `2026-11-02T10-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        pad: "p".repeat(TRANSCRIPT_HEADER_MAX_BYTES * 2),
        id: sessionId,
      })}\n`,
      "utf8",
    );
    const noticed: string[] = [];
    const fs = {
      ...nodeSessionTranscriptFs,
      readFileSync: (target: string, encoding: "utf8") => {
        noticed.push(target);
        return nodeSessionTranscriptFs.readFileSync(target, encoding);
      },
    };

    const selected = selectSessionTranscript({
      taskId: TASK_ID,
      range: "phase",
      env: { PI_CODING_AGENT_SESSION_DIR: dir },
      fs,
    });

    expect(selected).toBeUndefined();
    expect(noticed).toEqual([]);
  });

  it("drops a final line that was cut mid-JSON", () => {
    const dir = join(root, "cut");
    mkdirSync(dir, { recursive: true });
    const sessionId = `belayd-${TASK_ID}-sub-implement-cut`;
    const written = writeSession(dir, sessionId, [
      header(sessionId),
      message("assistant", [text("whole entry")]),
    ]);
    const partial = JSON.stringify(message("assistant", [text("half written entry")])).slice(0, 40);
    writeFileSync(
      written,
      `${JSON.stringify(header(sessionId))}\n${JSON.stringify(message("assistant", [text("whole entry")]))}\n${partial}`,
      "utf8",
    );

    const result = readTranscriptPage({
      taskId: TASK_ID,
      range: "phase",
      env: { PI_CODING_AGENT_SESSION_DIR: dir },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.total).toBe(1);
    expect(result.page.lines[0]).toContain("whole entry");
  });
});

describe("session transcript slice", () => {
  beforeEach(() => {
    env = { PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") };
    const lines: unknown[] = [header(`belayd-${TASK_ID}-sub-implement-abc123`)];
    for (let index = 0; index < 10; index += 1) {
      lines.push(message("assistant", [text(`step ${index.toString()}`)]));
    }
    writeSession(join(root, "sessions"), `belayd-${TASK_ID}-sub-implement-abc123`, lines);
  });

  it("returns the newest entries and says how many were omitted", () => {
    const result = readTranscriptSlice({ taskId: TASK_ID, range: "phase", env, maxEntries: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.total).toBe(10);
    expect(result.omitted).toBe(7);
    expect(result.text).toContain("… 7 earlier entries omitted");
    expect(result.text).toContain("step 9");
    expect(result.text).not.toContain("step 6");
    expect(result.sessionId).toBe(`belayd-${TASK_ID}-sub-implement-abc123`);
  });
});
