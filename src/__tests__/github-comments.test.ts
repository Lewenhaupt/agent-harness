/**
 * GitHub issue comments — the bd-182 answer channel (read and write halves).
 *
 * The tests pin the three properties the channel depends on: a read-only argv,
 * a tolerant parse of `gh --slurp`, and an identity filter that keeps the
 * harness's own question from being read back as the human's answer.
 */
import { describe, expect, it, vi } from "vitest";

import type { GhRunner, GithubIssueComment } from "../github-comments.js";
import {
  buildAuthenticatedUserArgv,
  buildIssueCommentCreateArgv,
  buildIssueCommentsArgv,
  harnessGithubLogins,
  isGhReadArgv,
  isHumanIssueComment,
  lookupAuthenticatedLogin,
  lookupIssueComments,
  parseIssueComments,
  parseIssueCommentsWithDropped,
  postIssueComment,
  selectHumanAnswer,
} from "../github-comments.js";

const TARGET = { owner: "acme", repo: "widgets", number: 42 };
const SINCE = "2026-10-26T20:00:00Z";

function comment(overrides: Partial<GithubIssueComment> = {}): GithubIssueComment {
  return {
    id: "c-1",
    author: "hugo",
    authorType: "User",
    createdAt: "2026-10-26T20:05:00Z",
    text: "option b",
    ...overrides,
  };
}

describe("buildIssueCommentsArgv", () => {
  it("addresses the issue comments endpoint with the gate time as a query cursor", () => {
    const built = buildIssueCommentsArgv({ ...TARGET, since: SINCE });
    expect(built).toEqual({
      ok: true,
      argv: [
        "api",
        "--paginate",
        "--slurp",
        "repos/acme/widgets/issues/42/comments?since=2026-10-26T20%3A00%3A00Z",
      ],
    });
  });

  it("refuses an owner, repo, number, or cursor that would reach an API path unchecked", () => {
    expect(buildIssueCommentsArgv({ ...TARGET, since: SINCE, owner: "-acme" }).ok).toBe(false);
    expect(buildIssueCommentsArgv({ ...TARGET, since: SINCE, owner: "ac me" }).ok).toBe(false);
    expect(buildIssueCommentsArgv({ ...TARGET, since: SINCE, repo: "widgets/../evil" }).ok).toBe(
      false,
    );
    expect(buildIssueCommentsArgv({ ...TARGET, since: SINCE, number: 0 }).ok).toBe(false);
    expect(buildIssueCommentsArgv({ ...TARGET, since: SINCE, number: -1 }).ok).toBe(false);
    expect(buildIssueCommentsArgv({ ...TARGET, since: SINCE, number: 4.2 }).ok).toBe(false);
    expect(buildIssueCommentsArgv({ ...TARGET, since: "not a date" }).ok).toBe(false);
  });
});

describe("buildIssueCommentCreateArgv", () => {
  it("posts to the issue comments endpoint with the body on stdin", () => {
    const built = buildIssueCommentCreateArgv(TARGET);
    expect(built).toEqual({
      ok: true,
      argv: ["api", "--method", "POST", "repos/acme/widgets/issues/42/comments", "--input", "-"],
    });
  });

  it("refuses a malformed target", () => {
    expect(buildIssueCommentCreateArgv({ ...TARGET, repo: "-widgets" }).ok).toBe(false);
    expect(buildIssueCommentCreateArgv({ ...TARGET, number: Number.NaN }).ok).toBe(false);
  });
});

describe("isGhReadArgv", () => {
  it("accepts a plain api read and an explicit GET", () => {
    expect(isGhReadArgv(["api", "--paginate", "repos/a/b/issues/1/comments"])).toBe(true);
    expect(isGhReadArgv(["api", "--method", "GET", "repos/a/b/issues/1/comments"])).toBe(true);
    expect(isGhReadArgv(["api", "--method=GET", "repos/a/b/issues/1/comments"])).toBe(true);
    expect(isGhReadArgv(["api", "-XGET", "repos/a/b/issues/1/comments"])).toBe(true);
  });

  it("rejects every mutating spelling", () => {
    expect(isGhReadArgv(["api", "--method", "POST", "repos/a/b/issues/1/comments"])).toBe(false);
    expect(isGhReadArgv(["api", "--method=POST", "repos/a/b/issues/1/comments"])).toBe(false);
    expect(isGhReadArgv(["api", "-X", "DELETE", "repos/a/b/issues/1/comments"])).toBe(false);
    expect(isGhReadArgv(["api", "--input", "-", "repos/a/b/issues/1/comments"])).toBe(false);
    expect(isGhReadArgv(["api", "-f", "body=x", "repos/a/b/issues/1/comments"])).toBe(false);
    expect(isGhReadArgv(["api", "-Fbody=x", "repos/a/b/issues/1/comments"])).toBe(false);
    expect(isGhReadArgv(["api", "--raw-field", "body=x", "repos/a/b/issues/1/comments"])).toBe(
      false,
    );
    expect(isGhReadArgv(["api", "--field=body=x", "repos/a/b/issues/1/comments"])).toBe(false);
  });

  it("rejects anything that is not an api call", () => {
    expect(isGhReadArgv(["pr", "view", "1"])).toBe(false);
    expect(isGhReadArgv([])).toBe(false);
  });
});

describe("parseIssueComments", () => {
  it("flattens an array of pages from --slurp", () => {
    const parsed = parseIssueComments([
      [
        {
          id: 1,
          body: "first",
          created_at: "2026-10-26T20:00:00Z",
          user: { login: "hugo", type: "User" },
        },
      ],
      [
        {
          id: 2,
          body: "second",
          created_at: "2026-10-26T20:01:00Z",
          user: { login: "belayd[bot]", type: "Bot" },
        },
      ],
    ]);
    expect(parsed).toEqual([
      {
        id: "1",
        author: "hugo",
        authorType: "User",
        createdAt: "2026-10-26T20:00:00Z",
        text: "first",
      },
      {
        id: "2",
        author: "belayd[bot]",
        authorType: "Bot",
        createdAt: "2026-10-26T20:01:00Z",
        text: "second",
      },
    ]);
  });

  it("accepts a single object and a plain array", () => {
    const single = {
      id: "c-1",
      body: "answer",
      created_at: "2026-10-26T20:05:00Z",
      user: { login: "hugo" },
    };
    expect(parseIssueComments(single)).toHaveLength(1);
    expect(parseIssueComments([single])).toHaveLength(1);
    // `user.type` is optional metadata, not a parse requirement.
    expect(parseIssueComments(single)[0]?.authorType).toBe("");
  });

  it("drops malformed records instead of crashing", () => {
    const parsed = parseIssueComments([
      null,
      "text",
      { body: "no id", created_at: "2026-10-26T20:00:00Z", user: { login: "hugo" } },
      { id: 1, created_at: "2026-10-26T20:00:00Z", user: { login: "hugo" } },
      { id: 2, body: "no time", user: { login: "hugo" } },
      { id: 3, body: "no user", created_at: "2026-10-26T20:00:00Z" },
      { id: 4, body: "no login", created_at: "2026-10-26T20:00:00Z", user: { type: "User" } },
      { id: 5, body: "kept", created_at: "2026-10-26T20:00:00Z", user: { login: "hugo" } },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("5");
  });

  it("returns nothing for a non-JSON shape", () => {
    expect(parseIssueComments(undefined)).toEqual([]);
    expect(parseIssueComments("nope")).toEqual([]);
  });

  it("counts records it had to drop instead of silently losing a human answer", () => {
    const parsed = parseIssueCommentsWithDropped([
      null,
      {
        id: 1,
        body: "deleted account",
        created_at: "2026-10-26T20:00:00Z",
        user: null,
      },
      {
        id: 2,
        body: "kept",
        created_at: "2026-10-26T20:00:00Z",
        user: { login: "hugo" },
      },
    ]);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.dropped).toBe(2);
  });
});

describe("harnessGithubLogins", () => {
  it("splits on commas and whitespace, lowercases, dedupes, and drops blanks", () => {
    expect(harnessGithubLogins(" Belayd-Bot, harness\n belayd-bot ,,other ")).toEqual([
      "belayd-bot",
      "harness",
      "other",
    ]);
    expect(harnessGithubLogins(undefined)).toEqual([]);
    expect(harnessGithubLogins("   ")).toEqual([]);
  });
});

describe("isHumanIssueComment", () => {
  const allowlist = ["belayd-bot"];

  it("rejects a Bot-typed author, a [bot] login, and an allowlisted login", () => {
    expect(isHumanIssueComment(comment({ authorType: "Bot" }), allowlist)).toBe(false);
    expect(isHumanIssueComment(comment({ authorType: "bot" }), allowlist)).toBe(false);
    expect(isHumanIssueComment(comment({ author: "belayd[bot]" }), allowlist)).toBe(false);
    // Login matching is case-insensitive so a capitalized suffix cannot slip by.
    expect(isHumanIssueComment(comment({ author: "belayd[BOT]" }), allowlist)).toBe(false);
    expect(isHumanIssueComment(comment({ author: "Belayd-Bot" }), allowlist)).toBe(false);
  });

  it("accepts a plain human", () => {
    expect(isHumanIssueComment(comment(), allowlist)).toBe(true);
    expect(isHumanIssueComment(comment({ authorType: "" }), [])).toBe(true);
  });
});

describe("selectHumanAnswer", () => {
  const sinceMs = Date.parse("2026-10-26T20:00:00Z");

  it("returns the first human comment at/after the cursor", () => {
    const answer = selectHumanAnswer(
      [
        comment({ id: "late", createdAt: "2026-10-26T20:10:00Z", text: "late" }),
        comment({ id: "exact", createdAt: "2026-10-26T20:00:00Z", text: "exact" }),
      ],
      { sinceMs, allowlist: [] },
    );
    expect(answer?.text).toBe("exact");
  });

  it("ignores a comment posted before the cursor", () => {
    const answer = selectHumanAnswer([comment({ createdAt: "2026-10-26T19:59:59Z" })], {
      sinceMs,
      allowlist: [],
    });
    expect(answer).toBeUndefined();
  });

  it("is stable across page order: createdAt, then id", () => {
    const sameSecond = [
      comment({ id: "c-b", createdAt: "2026-10-26T20:01:00Z", text: "b" }),
      comment({ id: "c-a", createdAt: "2026-10-26T20:01:00Z", text: "a-first" }),
    ];
    expect(selectHumanAnswer([...sameSecond].reverse(), { sinceMs, allowlist: [] })?.text).toBe(
      "a-first",
    );
    expect(selectHumanAnswer(sameSecond, { sinceMs, allowlist: [] })?.text).toBe("a-first");
  });

  it("tie-breaks numeric comment ids numerically, not lexically", () => {
    const sameSecond = [
      comment({ id: "100", createdAt: "2026-10-26T20:01:00Z", text: "later id" }),
      comment({ id: "9", createdAt: "2026-10-26T20:01:00Z", text: "earlier id" }),
    ];
    expect(selectHumanAnswer(sameSecond, { sinceMs, allowlist: [] })?.text).toBe("earlier id");
  });

  it("excludes the harness's own posted comment id even when its author is human", () => {
    const answer = selectHumanAnswer(
      [
        comment({ id: "900", author: "hugo", text: "Which option?" }),
        comment({ id: "901", author: "hugo", text: "option b" }),
      ],
      { sinceMs, allowlist: [], excludeId: "900" },
    );
    expect(answer?.text).toBe("option b");
  });

  it("never qualifies an unparseable createdAt", () => {
    const answer = selectHumanAnswer([comment({ createdAt: "not a date" })], {
      sinceMs,
      allowlist: [],
    });
    expect(answer).toBeUndefined();
  });

  it("skips bot and allowlisted comments", () => {
    const answer = selectHumanAnswer(
      [
        comment({ authorType: "Bot", createdAt: "2026-10-26T20:01:00Z" }),
        comment({ author: "belayd[bot]", createdAt: "2026-10-26T20:02:00Z" }),
        comment({ author: "harness", createdAt: "2026-10-26T20:03:00Z" }),
        comment({ id: "human", createdAt: "2026-10-26T20:04:00Z", text: "real" }),
      ],
      { sinceMs, allowlist: ["harness"] },
    );
    expect(answer?.text).toBe("real");
  });
});

describe("lookupIssueComments", () => {
  const since = SINCE;

  function runner(stdout: string): { runGh: GhRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runGh: GhRunner = async (argv, _options) => {
      calls.push([...argv]);
      return { stdout, stderr: "" };
    };
    return { runGh, calls };
  }

  it("runs one guarded read and returns the parsed comments", async () => {
    const { runGh, calls } = runner(
      JSON.stringify([
        [
          {
            id: 7,
            body: "option b",
            created_at: "2026-10-26T20:05:00Z",
            user: { login: "hugo", type: "User" },
          },
        ],
      ]),
    );
    const result = await lookupIssueComments({
      repo: { owner: "acme", repo: "widgets" },
      number: 42,
      since,
      cwd: "/repo",
      runGh,
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.comments).toHaveLength(1);
    expect(result.dropped).toBe(0);
    expect(calls).toEqual([
      [
        "api",
        "--paginate",
        "--slurp",
        "repos/acme/widgets/issues/42/comments?since=2026-10-26T20%3A00%3A00Z",
      ],
    ]);
  });

  it("returns ok:false when gh is absent (ENOENT)", async () => {
    const runGh: GhRunner = async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    };
    const result = await lookupIssueComments({
      repo: { owner: "acme", repo: "widgets" },
      number: 42,
      since,
      cwd: "/repo",
      runGh,
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("ENOENT");
  });

  it("returns ok:false on a non-zero exit and on non-JSON stdout", async () => {
    const failing: GhRunner = async () => {
      throw new Error("gh: HTTP 401: Bad credentials");
    };
    const unauthenticated = await lookupIssueComments({
      repo: { owner: "acme", repo: "widgets" },
      number: 42,
      since,
      cwd: "/repo",
      runGh: failing,
    });
    expect(unauthenticated).toHaveProperty("ok", false);
    if (!unauthenticated.ok) expect(unauthenticated.error).toContain("401");

    const notJson = await lookupIssueComments({
      repo: { owner: "acme", repo: "widgets" },
      number: 42,
      since,
      cwd: "/repo",
      runGh: runner("Not Found").runGh,
    });
    expect(notJson).toHaveProperty("ok", false);
  });

  it("returns ok:false before spawning on a bad owner, number, or cursor", async () => {
    const runGh = vi.fn<GhRunner>(async () => ({ stdout: "[]", stderr: "" }));
    const result = await lookupIssueComments({
      repo: { owner: "acme", repo: "widgets" },
      number: 0,
      since,
      cwd: "/repo",
      runGh,
    });
    expect(result).toHaveProperty("ok", false);
    expect(runGh).not.toHaveBeenCalled();
  });

  it("surfaces dropped records in the success payload", async () => {
    const { runGh } = runner(
      JSON.stringify([{ id: 1, body: "no user", created_at: "2026-10-26T20:00:00Z", user: null }]),
    );
    const result = await lookupIssueComments({
      repo: { owner: "acme", repo: "widgets" },
      number: 42,
      since,
      cwd: "/repo",
      runGh,
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.comments).toEqual([]);
    expect(result.dropped).toBe(1);
  });
});

describe("lookupAuthenticatedLogin", () => {
  it("reads the authenticated login from a guarded api read", async () => {
    const calls: string[][] = [];
    const runGh: GhRunner = async (argv) => {
      calls.push([...argv]);
      return { stdout: JSON.stringify({ login: "belayd-harness[bot]" }), stderr: "" };
    };
    const result = await lookupAuthenticatedLogin({ cwd: "/repo", runGh });
    expect(result).toEqual({ ok: true, login: "belayd-harness[bot]" });
    expect(calls).toEqual([[...buildAuthenticatedUserArgv()]]);
  });

  it("fails closed on a missing login or a failed read", async () => {
    const noLogin = await lookupAuthenticatedLogin({
      cwd: "/repo",
      runGh: async () => ({ stdout: "{}", stderr: "" }),
    });
    expect(noLogin).toHaveProperty("ok", false);

    const failed = await lookupAuthenticatedLogin({
      cwd: "/repo",
      runGh: async () => {
        throw new Error("gh: not logged in");
      },
    });
    expect(failed).toHaveProperty("ok", false);
    if (!failed.ok) expect(failed.error).toContain("not logged in");
  });
});

describe("postIssueComment", () => {
  it("sends the body as JSON on stdin, never in argv", async () => {
    const calls: Array<{ argv: readonly string[]; stdin: string | undefined }> = [];
    const runGh: GhRunner = async (argv, options) => {
      calls.push({ argv, stdin: options.stdin });
      return { stdout: JSON.stringify({ id: 900 }), stderr: "" };
    };
    const result = await postIssueComment({
      repo: { owner: "acme", repo: "widgets" },
      number: 42,
      body: "Which option?\n\n- a\n- b",
      cwd: "/repo",
      runGh,
    });
    expect(result).toEqual({ ok: true, commentId: "900" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.stdin).toBe(JSON.stringify({ body: "Which option?\n\n- a\n- b" }));
    expect(calls[0]?.argv.join(" ")).not.toContain("Which option?");
  });

  it("returns ok:false instead of throwing when the post fails", async () => {
    const runGh: GhRunner = async () => {
      throw new Error("gh: HTTP 403: Resource not accessible");
    };
    const result = await postIssueComment({
      repo: { owner: "acme", repo: "widgets" },
      number: 42,
      body: "question",
      cwd: "/repo",
      runGh,
    });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.error).toContain("403");
  });

  it("still reports success when the response carries no created id", async () => {
    const result = await postIssueComment({
      repo: { owner: "acme", repo: "widgets" },
      number: 42,
      body: "question",
      cwd: "/repo",
      runGh: async () => ({ stdout: "not json", stderr: "" }),
    });
    expect(result).toEqual({ ok: true });
  });
});
