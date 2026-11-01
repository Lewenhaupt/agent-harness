/**
 * Bead ↔ GitHub issue map (bd-180): pure parse/serialize/upsert/lookup plus the
 * never-throw file seams. The fs seam is an in-memory map so the corrupt-file and
 * refuse-to-overwrite paths are asserted without touching disk.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GithubIssueMapFsSeam, GithubMapRepo } from "../github-issue-map.js";
import {
  emptyGithubIssueMap,
  GITHUB_ISSUE_MAP_VERSION,
  githubIssueMapPath,
  lookupGithubIssue,
  parseGithubIssueMap,
  readGithubIssueMap,
  recordUnmappedDependency,
  removeGithubIssue,
  serializeGithubIssueMap,
  upsertGithubIssue,
  writeGithubIssueMap,
} from "../github-issue-map.js";

const REPO: GithubMapRepo = { owner: "acme", name: "widgets" };
const PATH = githubIssueMapPath("/repo");

function memoryFs(initial?: string): GithubIssueMapFsSeam & { files: Map<string, string> } {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(PATH, initial);
  return {
    files,
    readFileSync: (path) => {
      const value = files.get(path);
      if (value === undefined) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return value;
    },
    writeFileSync: (path, data) => {
      files.set(path, data);
    },
  };
}

describe("github issue map", () => {
  it("starts empty at the current version", () => {
    expect(emptyGithubIssueMap(REPO)).toEqual({
      version: GITHUB_ISSUE_MAP_VERSION,
      repo: REPO,
      issues: {},
      unmappedDependencies: [],
    });
  });

  it("round-trips through serialize and parse", () => {
    const first = upsertGithubIssue(emptyGithubIssueMap(REPO), "bd-2", {
      number: 9,
      nodeId: "I_9",
      title: "second",
    });
    const map = upsertGithubIssue(first, "bd-1", {
      number: 8,
      nodeId: "I_8",
      updatedAt: "2026-10-30T00:00:00Z",
    });
    const serialized = serializeGithubIssueMap(map);
    expect(parseGithubIssueMap(JSON.parse(serialized))).toEqual(map);
    // Deterministic: keys are sorted, so a stable map produces stable bytes.
    expect(serialized.indexOf('"bd-1"')).toBeLessThan(serialized.indexOf('"bd-2"'));
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("upserts, looks up, and removes without mutating the input", () => {
    const base = emptyGithubIssueMap(REPO);
    const first = upsertGithubIssue(base, "bd-1", { number: 1, nodeId: "I_1" });
    const second = upsertGithubIssue(first, "bd-2", { number: 2, nodeId: "I_2" });
    expect(base.issues).toEqual({});
    expect(lookupGithubIssue(second, "bd-1")).toEqual({ number: 1, nodeId: "I_1" });
    expect(lookupGithubIssue(second, "bd-unknown")).toBeUndefined();
    expect(removeGithubIssue(second, "bd-1").issues).toEqual({
      "bd-2": { number: 2, nodeId: "I_2" },
    });
  });

  it("records an unmapped dependency once per bead pair", () => {
    const once = recordUnmappedDependency(emptyGithubIssueMap(REPO), {
      beadId: "bd-2",
      dependsOnBeadId: "bd-1",
      reason: "blocker has no issue",
    });
    const twice = recordUnmappedDependency(once, {
      beadId: "bd-2",
      dependsOnBeadId: "bd-1",
      reason: "blocker still has no issue",
    });
    expect(twice.unmappedDependencies).toHaveLength(1);
    expect(twice.unmappedDependencies[0]?.reason).toBe("blocker still has no issue");
  });

  it("rejects a persisted map with the wrong shape", () => {
    expect(parseGithubIssueMap({ version: 1 })).toBeUndefined();
    expect(
      parseGithubIssueMap({ ...emptyGithubIssueMap(REPO), issues: { "bd-1": {} } }),
    ).toBeUndefined();
  });

  it("refuses a future map version instead of downgrading it", () => {
    expect(parseGithubIssueMap({ ...emptyGithubIssueMap(REPO), version: 2 })).toBeUndefined();
  });

  it("upserts over an existing bead without mutating either map", () => {
    const base = upsertGithubIssue(emptyGithubIssueMap(REPO), "bd-1", {
      number: 1,
      nodeId: "I_1",
      title: "first",
    });
    const sibling = upsertGithubIssue(base, "bd-2", { number: 2, nodeId: "I_2" });
    const replaced = upsertGithubIssue(sibling, "bd-1", { number: 9, nodeId: "I_9" });
    expect(lookupGithubIssue(replaced, "bd-1")).toEqual({ number: 9, nodeId: "I_9" });
    expect(lookupGithubIssue(replaced, "bd-2")).toEqual({ number: 2, nodeId: "I_2" });
    // The input map and its issue table are untouched, so a caller can keep the
    // pre-upsert value (the write path refuses rather than partially applying).
    expect(lookupGithubIssue(sibling, "bd-1")).toEqual({
      number: 1,
      nodeId: "I_1",
      title: "first",
    });
    expect(replaced).not.toBe(sibling);
    expect(replaced.issues).not.toBe(sibling.issues);
  });

  it("removing an unmapped bead is a no-op that still returns a new map", () => {
    const base = upsertGithubIssue(emptyGithubIssueMap(REPO), "bd-1", {
      number: 1,
      nodeId: "I_1",
    });
    const removed = removeGithubIssue(base, "bd-unknown");
    expect(removed).toEqual(base);
    expect(removed).not.toBe(base);
    expect(base.issues["bd-1"]).toEqual({ number: 1, nodeId: "I_1" });
  });

  it("keeps a bead id containing path separators as a JSON key, not a path", () => {
    // The map path is derived from the repo root alone; bead ids and repo fields
    // are data, never path segments, so `../` cannot escape `.belayd/`.
    const fs = memoryFs();
    const map = upsertGithubIssue(
      emptyGithubIssueMap({ owner: "../..", name: ".." }),
      "../../etc",
      {
        number: 1,
        nodeId: "I_1",
      },
    );
    expect(writeGithubIssueMap({ repoRoot: "/repo", map, fs })).toEqual({ ok: true, path: PATH });
    expect([...fs.files.keys()]).toEqual([PATH]);
    const read = readGithubIssueMap({ repoRoot: "/repo", repo: REPO, fs });
    expect(read).toHaveProperty("ok", true);
    if (!read.ok) return;
    expect(lookupGithubIssue(read.map, "../../etc")).toEqual({ number: 1, nodeId: "I_1" });
  });

  it("derives the map path from the repo root only", () => {
    expect(githubIssueMapPath("/repo")).toBe(join("/repo", ".belayd", "github-map.json"));
    expect(githubIssueMapPath("/repo/nested")).toBe(
      join("/repo/nested", ".belayd", "github-map.json"),
    );
  });
});

describe("readGithubIssueMap", () => {
  it("returns an empty map with no warning when the file is absent", () => {
    const result = readGithubIssueMap({ repoRoot: "/repo", repo: REPO, fs: memoryFs() });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.map).toEqual(emptyGithubIssueMap(REPO));
    expect(result.warnings).toEqual([]);
  });

  it("reads a valid map", () => {
    const map = upsertGithubIssue(emptyGithubIssueMap(REPO), "bd-1", {
      number: 1,
      nodeId: "I_1",
    });
    const result = readGithubIssueMap({
      repoRoot: "/repo",
      repo: REPO,
      fs: memoryFs(serializeGithubIssueMap(map)),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.map).toEqual(map);
  });

  it("warns and returns an empty map on corrupt JSON", () => {
    const result = readGithubIssueMap({ repoRoot: "/repo", repo: REPO, fs: memoryFs("{ nope") });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.map).toEqual(emptyGithubIssueMap(REPO));
    expect(result.warnings[0]).toContain("invalid JSON");
  });

  it("warns and returns an empty map on a valid-JSON wrong shape", () => {
    const result = readGithubIssueMap({
      repoRoot: "/repo",
      repo: REPO,
      fs: memoryFs(JSON.stringify({ version: 1 })),
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.warnings[0]).toContain("not a GitHub issue map");
  });

  it("refuses a future map version with a typed reason", () => {
    const result = readGithubIssueMap({
      repoRoot: "/repo",
      repo: REPO,
      fs: memoryFs(JSON.stringify({ ...emptyGithubIssueMap(REPO), version: 2 })),
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("unsupported GitHub issue map version");
    expect(result.error).toContain("refusing");
  });

  it("refuses a version it cannot match exactly, without coercing it", () => {
    // A quoted or fractional version is not `1`; downgrading `"1"` to the v1
    // reader is exactly the silent-downgrade the version gate exists to prevent.
    for (const version of ["1", 1.5, null, { major: 1 }]) {
      const result = readGithubIssueMap({
        repoRoot: "/repo",
        repo: REPO,
        fs: memoryFs(JSON.stringify({ ...emptyGithubIssueMap(REPO), version })),
      });
      expect(result, JSON.stringify(version)).toHaveProperty("ok", false);
      if (result.ok) continue;
      expect(result.error).toContain("refusing");
    }
  });

  it("warns and returns an empty map when the file cannot be read", () => {
    const result = readGithubIssueMap({
      repoRoot: "/repo",
      repo: REPO,
      fs: {
        readFileSync: () => {
          const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
        writeFileSync: () => undefined,
      },
    });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.map).toEqual(emptyGithubIssueMap(REPO));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("could not read");
    expect(result.warnings[0]).toContain("empty map");
  });

  it("warns on a JSON root that is not an object", () => {
    for (const raw of ["[]", "null", '"map"', "42"]) {
      const result = readGithubIssueMap({ repoRoot: "/repo", repo: REPO, fs: memoryFs(raw) });
      expect(result, raw).toHaveProperty("ok", true);
      if (!result.ok) continue;
      expect(result.warnings[0]).toContain("not a GitHub issue map");
    }
  });

  it("warns on a truncated (whitespace-only) file instead of reading it as absent", () => {
    const result = readGithubIssueMap({ repoRoot: "/repo", repo: REPO, fs: memoryFs("  \n") });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.warnings[0]).toContain("invalid JSON");
  });
});

describe("writeGithubIssueMap", () => {
  it("writes a new map and reads it back", () => {
    const fs = memoryFs();
    const map = upsertGithubIssue(emptyGithubIssueMap(REPO), "bd-1", {
      number: 1,
      nodeId: "I_1",
    });
    expect(writeGithubIssueMap({ repoRoot: "/repo", map, fs })).toEqual({
      ok: true,
      path: PATH,
    });
    const read = readGithubIssueMap({ repoRoot: "/repo", repo: REPO, fs });
    expect(read).toHaveProperty("ok", true);
    if (!read.ok) return;
    expect(read.map).toEqual(map);
  });

  it("refuses to overwrite an unparsable existing file", () => {
    const fs = memoryFs("{ broken");
    const result = writeGithubIssueMap({
      repoRoot: "/repo",
      map: emptyGithubIssueMap(REPO),
      fs,
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("refusing to overwrite");
    expect(fs.files.get(PATH)).toBe("{ broken");
  });

  it("refuses to overwrite a valid-JSON file with the wrong shape", () => {
    const fs = memoryFs(JSON.stringify({ version: 1 }));
    const result = writeGithubIssueMap({
      repoRoot: "/repo",
      map: emptyGithubIssueMap(REPO),
      fs,
    });
    expect(result).toHaveProperty("ok", false);
  });

  it("refuses to overwrite a future-version map", () => {
    const fs = memoryFs(JSON.stringify({ ...emptyGithubIssueMap(REPO), version: 2 }));
    const result = writeGithubIssueMap({
      repoRoot: "/repo",
      map: emptyGithubIssueMap(REPO),
      fs,
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("refusing to overwrite");
  });

  it("treats an empty existing file as absent", () => {
    const fs = memoryFs("  \n");
    const result = writeGithubIssueMap({
      repoRoot: "/repo",
      map: emptyGithubIssueMap(REPO),
      fs,
    });
    expect(result).toHaveProperty("ok", true);
  });

  it("refuses when the existing file cannot be read before the write", () => {
    const result = writeGithubIssueMap({
      repoRoot: "/repo",
      map: emptyGithubIssueMap(REPO),
      fs: {
        readFileSync: () => {
          throw new Error("EACCES: permission denied");
        },
        writeFileSync: () => undefined,
      },
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("could not read before write");
  });

  it("reports a write failure instead of throwing", () => {
    const result = writeGithubIssueMap({
      repoRoot: "/repo",
      map: emptyGithubIssueMap(REPO),
      fs: {
        readFileSync: () => {
          const error = new Error(`ENOENT: ${PATH}`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
        writeFileSync: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      },
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("could not write");
    expect(result.error).toContain("ENOSPC");
  });

  it("rewrites a stable map to identical bytes", () => {
    const fs = memoryFs();
    const map = upsertGithubIssue(
      recordUnmappedDependency(emptyGithubIssueMap(REPO), {
        beadId: "bd-2",
        dependsOnBeadId: "bd-1",
        reason: "blocker has no issue",
      }),
      "bd-1",
      { number: 1, nodeId: "I_1" },
    );
    expect(writeGithubIssueMap({ repoRoot: "/repo", map, fs })).toHaveProperty("ok", true);
    const first = fs.files.get(PATH);
    expect(writeGithubIssueMap({ repoRoot: "/repo", map, fs })).toHaveProperty("ok", true);
    expect(fs.files.get(PATH)).toBe(first);
  });
});
