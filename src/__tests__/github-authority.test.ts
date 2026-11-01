/**
 * GitHub authority config and drift classification (bd-180).
 *
 * The config reader is asserted through the same injected fs seam the publish
 * tests use, so the two readers stay comparable. Drift is data in / records out.
 */
import { describe, expect, it } from "vitest";

import {
  classifyGithubDrift,
  githubDriftStatus,
  githubDriftWarning,
  parseGithubAuthority,
  readGithubAuthorityConfig,
  resolveGithubAuthorityForSession,
} from "../github-authority.js";
import type { GithubIssueMap } from "../github-issue-map.js";
import { emptyGithubIssueMap, upsertGithubIssue } from "../github-issue-map.js";

const CONFIG_PATH = "/repo/.belayd/config.json";

function fsWith(content: string | undefined): { readFileSync: (path: string) => string } {
  return {
    readFileSync: (path) => {
      if (content === undefined) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
  };
}

function mapWith(beadId: string, number = 7): GithubIssueMap {
  return upsertGithubIssue(emptyGithubIssueMap({ owner: "acme", name: "widgets" }), beadId, {
    number,
    nodeId: `I_${number.toString()}`,
  });
}

describe("readGithubAuthorityConfig", () => {
  it("defaults to bd when there is no config file", () => {
    const result = readGithubAuthorityConfig({ repoRoot: "/repo", fs: fsWith(undefined) });
    expect(result).toEqual({ ok: true, value: { authority: "bd" }, warnings: [] });
  });

  it("reads a github authority with owner/repo", () => {
    const result = readGithubAuthorityConfig({
      repoRoot: "/repo",
      fs: fsWith(
        JSON.stringify({ authority: "github", github: { owner: "acme", repo: "widgets" } }),
      ),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      authority: "github",
      github: { owner: "acme", repo: "widgets" },
    });
    expect(result.warnings).toEqual([]);
  });

  it("accepts an explicit bd authority and ignores an unrelated publish key", () => {
    const result = readGithubAuthorityConfig({
      repoRoot: "/repo",
      fs: fsWith(JSON.stringify({ authority: "bd", publish: { mode: "pr" } })),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.value).toEqual({ authority: "bd" });
    expect(result.warnings).toEqual([]);
  });

  it("refuses github authority without owner/repo", () => {
    for (const github of [undefined, {}, { owner: "acme" }, { repo: "widgets" }, 42]) {
      const result = readGithubAuthorityConfig({
        repoRoot: "/repo",
        fs: fsWith(JSON.stringify({ authority: "github", github })),
      });
      expect(result).toHaveProperty("ok", false);
      if (result.ok) continue;
      expect(result.error).toContain("requires github.owner and github.repo");
    }
  });

  it("refuses a config that sets both authorities", () => {
    const cases = [
      { authority: "bd", github: { owner: "acme", repo: "widgets" } },
      { github: { owner: "acme", repo: "widgets" } },
      { authority: ["bd", "github"] },
    ];
    for (const config of cases) {
      const result = readGithubAuthorityConfig({
        repoRoot: "/repo",
        fs: fsWith(JSON.stringify(config)),
      });
      expect(result).toHaveProperty("ok", false);
      if (result.ok) continue;
      expect(result.error).toContain("ambiguous authority");
    }
  });

  it("refuses an unknown authority string", () => {
    const result = readGithubAuthorityConfig({
      repoRoot: "/repo",
      fs: fsWith(JSON.stringify({ authority: "gitlab" })),
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("unknown authority");
  });

  it("refuses flag-shaped and control-character owner/repo values", () => {
    const cases = [
      { owner: "--upload-pack=evil", repo: "widgets" },
      { owner: "acme", repo: "wid\ngets" },
    ];
    for (const github of cases) {
      const result = readGithubAuthorityConfig({
        repoRoot: "/repo",
        fs: fsWith(JSON.stringify({ authority: "github", github })),
      });
      expect(result).toHaveProperty("ok", false);
    }
  });

  it("refuses every github block that is not exactly owner+repo", () => {
    // These values become REST paths and (for the owner) argv, so the ref-string
    // hardening has to cover empties, flag shapes, control characters, non
    // strings, over-long values, and any key the shape does not declare.
    const cases: readonly Record<string, unknown>[] = [
      { owner: "", repo: "widgets" },
      { owner: "acme", repo: "" },
      { owner: "-acme", repo: "widgets" },
      { owner: "acme", repo: "--upload-pack=evil" },
      { owner: "ac\tme", repo: "widgets" },
      { owner: "acme", repo: "wid\u007fgets" },
      { owner: 42, repo: "widgets" },
      { owner: "acme", repo: ["widgets"] },
      { owner: "x".repeat(129), repo: "widgets" },
      { owner: "acme", repo: "y".repeat(129) },
      { owner: "acme", repo: "widgets", extra: "nope" },
    ];
    for (const github of cases) {
      const result = readGithubAuthorityConfig({
        repoRoot: "/repo",
        fs: fsWith(JSON.stringify({ authority: "github", github })),
      });
      expect(result, JSON.stringify(github)).toHaveProperty("ok", false);
      if (result.ok) continue;
      expect(result.error).toContain("requires github.owner and github.repo");
    }
  });

  it("accepts owner/repo of the maximum length and ignores unrelated repo keys", () => {
    const longest = "a".repeat(128);
    const result = readGithubAuthorityConfig({
      repoRoot: "/repo",
      fs: fsWith(
        JSON.stringify({
          authority: "github",
          github: { owner: longest, repo: longest },
          publish: { mode: "pr", remote: "origin", base: "main" },
          fleet: { members: [] },
        }),
      ),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      authority: "github",
      github: { owner: longest, repo: longest },
    });
    expect(result.warnings).toEqual([]);
  });

  it("refuses a non-string authority value instead of narrowing it", () => {
    for (const authority of [42, true, null]) {
      const result = readGithubAuthorityConfig({
        repoRoot: "/repo",
        fs: fsWith(JSON.stringify({ authority })),
      });
      expect(result, JSON.stringify(authority)).toHaveProperty("ok", false);
      if (result.ok) continue;
      expect(result.error).toContain("unknown authority");
    }
    // An object authority is treated as a collection of markers, not a name.
    const objectAuthority = readGithubAuthorityConfig({
      repoRoot: "/repo",
      fs: fsWith(JSON.stringify({ authority: { name: "github" } })),
    });
    expect(objectAuthority).toHaveProperty("ok", false);
    if (objectAuthority.ok) return;
    expect(objectAuthority.error).toContain("ambiguous authority");
  });

  it("warns and keeps the bd default when the config root is not a JSON object", () => {
    for (const content of ['"github"', "[1,2]", "null", "42", "true"]) {
      const result = readGithubAuthorityConfig({ repoRoot: "/repo", fs: fsWith(content) });
      expect(result, content).toHaveProperty("ok", true);
      if (!result.ok) continue;
      expect(result.value).toEqual({ authority: "bd" });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("expected a JSON object");
    }
  });

  it("consults only the repo config file, never a git-config or gh seam", () => {
    // `authority:"bd"` must not fork anything. The reader's entire input is one
    // fs read of the repo config; there is no exec seam to reach.
    const requested: string[] = [];
    const result = readGithubAuthorityConfig({
      repoRoot: "/repo",
      fs: {
        readFileSync: (path) => {
          requested.push(path);
          return JSON.stringify({ authority: "bd" });
        },
      },
    });
    expect(result).toHaveProperty("ok", true);
    expect(requested).toEqual([CONFIG_PATH]);
  });

  it("warns and keeps the bd default on invalid JSON", () => {
    const result = readGithubAuthorityConfig({ repoRoot: "/repo", fs: fsWith("{ not json") });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.value).toEqual({ authority: "bd" });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(CONFIG_PATH);
  });

  it("warns and keeps the bd default when the file cannot be read", () => {
    const result = readGithubAuthorityConfig({
      repoRoot: "/repo",
      fs: {
        readFileSync: () => {
          throw new Error("EACCES: permission denied");
        },
      },
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.value).toEqual({ authority: "bd" });
    expect(result.warnings[0]).toContain("could not read");
  });
});

describe("parseGithubAuthority", () => {
  it("is a pure parser over an already-parsed object", () => {
    expect(parseGithubAuthority({})).toEqual({ ok: true, value: { authority: "bd" } });
    expect(
      parseGithubAuthority({ authority: "github", github: { owner: "a", repo: "b" } }),
    ).toEqual({ ok: true, value: { authority: "github", github: { owner: "a", repo: "b" } } });
  });
});

describe("classifyGithubDrift", () => {
  const githubAuthority = {
    authority: "github" as const,
    github: { owner: "acme", repo: "widgets" },
  };

  it("is in-sync when every bead maps to a matching open issue", () => {
    const drifts = classifyGithubDrift({
      authority: githubAuthority,
      map: mapWith("bd-1"),
      beads: [{ id: "bd-1", state: "open" }],
      issues: [{ beadId: "bd-1", state: "open" }],
    });
    expect(drifts).toEqual([]);
    expect(githubDriftStatus(drifts)).toBe("in-sync");
  });

  it("reports issue-missing for a bead with no map entry", () => {
    const drifts = classifyGithubDrift({
      authority: githubAuthority,
      map: emptyGithubIssueMap({ owner: "acme", name: "widgets" }),
      beads: [{ id: "bd-1", state: "open" }],
      issues: [],
    });
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ id: "bd-1", kind: "issue-missing" });
  });

  it("reports issue-missing when the mapped issue no longer resolves", () => {
    const drifts = classifyGithubDrift({
      authority: githubAuthority,
      map: mapWith("bd-1"),
      beads: [{ id: "bd-1", state: "open" }],
      issues: [{ beadId: "bd-1", state: "missing" }],
    });
    expect(drifts[0]).toMatchObject({ id: "bd-1", kind: "issue-missing" });
    expect(drifts[0]?.message).toContain("#7");
  });

  it("reports issue-closed-bead-open and mentions the holding gate", () => {
    const drifts = classifyGithubDrift({
      authority: githubAuthority,
      map: mapWith("bd-1"),
      beads: [{ id: "bd-1", state: "open" }],
      issues: [{ beadId: "bd-1", state: "closed" }],
      openGates: [{ beadId: "bd-1", gateId: "g-1" }],
    });
    expect(drifts[0]).toMatchObject({ id: "bd-1", kind: "issue-closed-bead-open" });
    expect(drifts[0]?.message).toContain("1 open local gate");
  });

  it("reports bead-missing for a map entry whose bead is gone", () => {
    const drifts = classifyGithubDrift({
      authority: githubAuthority,
      map: mapWith("bd-gone"),
      beads: [],
      issues: [{ beadId: "bd-gone", state: "open" }],
    });
    expect(drifts[0]).toMatchObject({ id: "bd-gone", kind: "bead-missing" });
  });

  it("reports unmapped-dependency per edge, not per blocked bead", () => {
    const map: GithubIssueMap = {
      ...mapWith("bd-1"),
      unmappedDependencies: [
        { beadId: "bd-1", dependsOnBeadId: "bd-2", reason: "blocker has no issue" },
        { beadId: "bd-1", dependsOnBeadId: "bd-3", reason: "blocker has no issue" },
      ],
    };
    const drifts = classifyGithubDrift({
      authority: githubAuthority,
      map,
      beads: [{ id: "bd-1", state: "open" }],
      issues: [{ beadId: "bd-1", state: "open" }],
    });
    expect(drifts).toHaveLength(2);
    expect(drifts.map((drift) => drift.id)).toEqual(["bd-1->bd-2", "bd-1->bd-3"]);
  });

  it("reports map-unreadable instead of derived issue-missing findings", () => {
    const drifts = classifyGithubDrift({
      authority: githubAuthority,
      map: emptyGithubIssueMap({ owner: "acme", name: "widgets" }),
      beads: [
        { id: "bd-1", state: "open" },
        { id: "bd-2", state: "open" },
      ],
      issues: [],
      mapUnreadableReason: "/repo/.belayd/github-map.json: invalid JSON",
    });
    expect(drifts).toEqual([expect.objectContaining({ id: "(map)", kind: "map-unreadable" })]);
    expect(drifts.some((drift) => drift.kind === "issue-missing")).toBe(false);
  });

  it("reports authority-mismatch and stops on a bd-authority repo", () => {
    const drifts = classifyGithubDrift({
      authority: { authority: "bd" },
      map: mapWith("bd-1"),
      beads: [{ id: "bd-1", state: "open" }],
      issues: [],
    });
    expect(drifts).toEqual([expect.objectContaining({ id: "(repo)", kind: "authority-mismatch" })]);
  });

  it("renders one deterministic warning line per drift", () => {
    expect(githubDriftWarning({ id: "bd-1", kind: "issue-missing", message: "no issue" })).toBe(
      "github drift [issue-missing] bd-1: no issue",
    );
  });
});

describe("resolveGithubAuthorityForSession", () => {
  const config = JSON.stringify({
    authority: "github",
    github: { owner: "acme", repo: "widgets" },
  });

  it("reads the config from the repo root, not the tool-call cwd", () => {
    const requested: string[] = [];
    const result = resolveGithubAuthorityForSession({
      cwd: "/repo/sub/dir",
      resolveGitCommonDir: () => ({ ok: true, commonDir: "/repo/.git" }),
      fs: {
        readFileSync: (path) => {
          requested.push(path);
          if (path === CONFIG_PATH) return config;
          const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      },
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.authority).toBe("github");
    expect(result.repoRoot).toBe("/repo");
    expect(requested).toContain(CONFIG_PATH);
  });

  it("fails closed when the repo root cannot be resolved", () => {
    const result = resolveGithubAuthorityForSession({
      cwd: "/tmp",
      resolveGitCommonDir: () => ({ ok: false, error: "not a git repository" }),
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("authority unresolved");
    expect(result.error).toContain("not a git repository");
  });

  it("refuses an ambiguous config instead of narrowing to bd", () => {
    const result = resolveGithubAuthorityForSession({
      cwd: "/repo",
      resolveGitCommonDir: () => ({ ok: true, commonDir: "/repo/.git" }),
      fs: fsWith(JSON.stringify({ authority: "bd", github: { owner: "a", repo: "b" } })),
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("ambiguous authority");
  });

  it("passes the config warnings through for a broken file and keeps local mode", () => {
    const result = resolveGithubAuthorityForSession({
      cwd: "/repo/sub",
      resolveGitCommonDir: () => ({ ok: true, commonDir: "/repo/.git" }),
      fs: fsWith("{ not json"),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.authority).toBe("bd");
    expect(result.repoRoot).toBe("/repo");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(CONFIG_PATH);
  });

  it("refuses an unknown authority string from the session path too", () => {
    const result = resolveGithubAuthorityForSession({
      cwd: "/repo",
      resolveGitCommonDir: () => ({ ok: true, commonDir: "/repo/.git" }),
      fs: fsWith(JSON.stringify({ authority: "gitlab" })),
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("unknown authority");
  });
});

describe("classifyGithubDrift ordering", () => {
  it("reports bead drifts, then orphan map entries, then unmapped edges", () => {
    const map: GithubIssueMap = {
      ...mapWith("bd-gone", 5),
      issues: {
        "bd-gone": { number: 5, nodeId: "I_5" },
        "bd-1": { number: 7, nodeId: "I_7" },
      },
      unmappedDependencies: [
        { beadId: "bd-1", dependsOnBeadId: "bd-9", reason: "blocker has no issue" },
      ],
    };
    const drifts = classifyGithubDrift({
      authority: { authority: "github", github: { owner: "acme", repo: "widgets" } },
      map,
      beads: [
        { id: "bd-1", state: "open" },
        { id: "bd-2", state: "open" },
      ],
      issues: [{ beadId: "bd-1", state: "open" }],
    });
    expect(drifts.map((drift) => drift.kind)).toEqual([
      "issue-missing",
      "bead-missing",
      "unmapped-dependency",
    ]);
    expect(drifts.map((drift) => drift.id)).toEqual(["bd-2", "bd-gone", "bd-1->bd-9"]);
  });

  it("is not in sync when only a map-unreadable record is present", () => {
    const drifts = classifyGithubDrift({
      authority: { authority: "github", github: { owner: "acme", repo: "widgets" } },
      map: emptyGithubIssueMap({ owner: "acme", name: "widgets" }),
      beads: [],
      issues: [],
      mapUnreadableReason: "/repo/.belayd/github-map.json: could not read (EACCES)",
    });
    expect(githubDriftStatus(drifts)).toBe("drift");
  });
});
