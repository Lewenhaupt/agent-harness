/**
 * Pure tests for the rebase-failure classification (bd-280).
 *
 * Nothing here touches a repository: the conflicted paths and the per-path commit
 * facts are exactly what the effectful layer in `src/fleet-merge.ts` fetches while
 * a rebase is stopped, so passing them in is the whole contract. The real-git
 * behaviour of the drain itself is pinned in `fleet-merge.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { ClassifyRebaseFailureInput, RebaseConflictedPath } from "../fleet-rebase-recovery.js";
import {
  classifyGeneratedPath,
  classifyRebaseFailure,
  FLEET_REBASE_GENERATED_LOCKFILES,
  formatBoundedPathDetail,
  formatRebasePathList,
  isGeneratedPath,
  parseConflictedPaths,
  REBASE_TEXT_PATH_LIMIT,
  rebaseConflictText,
} from "../fleet-rebase-recovery.js";

describe("parseConflictedPaths", () => {
  it("keeps only unmerged entries, sorted and deduped", () => {
    const porcelain = [
      "UU src/b.ts",
      "AA docs/a.md",
      "DD dist/old.js",
      " M src/ordinary.ts",
      "?? untracked.txt",
      "A  added.txt",
      "UU src/b.ts",
      "",
    ].join("\0");
    expect(parseConflictedPaths(porcelain)).toEqual(["dist/old.js", "docs/a.md", "src/b.ts"]);
  });

  it("covers every unmerged status pair git emits", () => {
    const statuses = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];
    const porcelain = statuses.map((status, index) => `${status} f${index}.txt`).join("\0");
    expect(parseConflictedPaths(porcelain)).toEqual(
      statuses.map((_, index) => `f${index}.txt`).sort(),
    );
  });

  it("skips the original-path field of a rename instead of reading it as a record", () => {
    // `-z` emits the destination first, then the source, so a naive split would
    // read the source path as if it carried a status of its own.
    const porcelain = ["R  new name.txt", "old name.txt", "UU src/conflict.ts"].join("\0");
    expect(parseConflictedPaths(porcelain)).toEqual(["src/conflict.ts"]);
  });

  it("keeps paths with spaces and non-ASCII characters verbatim", () => {
    const porcelain = ["UU docs/caf\u00e9 notes.md", "AA dist/bundle file.js"].join("\0");
    expect(parseConflictedPaths(porcelain)).toEqual([
      "dist/bundle file.js",
      "docs/caf\u00e9 notes.md",
    ]);
  });

  it("returns nothing for an empty status", () => {
    expect(parseConflictedPaths("")).toEqual([]);
  });
});

describe("isGeneratedPath", () => {
  it("recognizes lockfiles, derived trees and snapshots", () => {
    for (const path of [
      ...FLEET_REBASE_GENERATED_LOCKFILES,
      "dist/index.js",
      "build/lib/a.js",
      "coverage/lcov.info",
      "node_modules/left-pad/index.js",
      "result",
      ".next/server/page.js",
      "out/static/x.css",
      "__snapshots__/gate.test.ts.snap",
      "src/__tests__/__snapshots__/render.snap",
      "src/__tests__/render.test.ts.snap",
    ]) {
      expect(isGeneratedPath(path)).toBe(true);
    }
  });

  it("does not mistake authored paths for generated ones", () => {
    for (const path of [
      "src/dist-utils.ts",
      "src/build/tool.ts",
      "src/distribution/x.ts",
      "Dist/authored.css",
      "src/outbox.ts",
      "docs/snapshots/readme.md",
      "src/__snapshots__helper/render.ts",
      "package.json",
      "src/outcome.ts",
      ".gitignore",
      "",
    ]) {
      expect(isGeneratedPath(path)).toBe(false);
    }
  });

  it("recognizes the ambiguous derived trees only at the repository root", () => {
    expect(isGeneratedPath("build/lib/a.js")).toBe(true);
    expect(isGeneratedPath("result")).toBe(true);
    expect(isGeneratedPath("out/static/x.css")).toBe(true);
    // An authored `src/build/` or `src/out/` is not regenerable, and taking its base
    // side would silently drop the member's change.
    expect(isGeneratedPath("src/build/tool.ts")).toBe(false);
    expect(isGeneratedPath("src/out/report.ts")).toBe(false);
    expect(isGeneratedPath("packages/app/out/generated.ts")).toBe(false);
    // An unambiguous artifact tree is recognized at any depth (monorepos).
    expect(isGeneratedPath("packages/app/dist/index.js")).toBe(true);
  });

  it("names the kind, which is what decides how to regenerate", () => {
    expect(classifyGeneratedPath("pnpm-lock.yaml")).toBe("lockfile");
    expect(classifyGeneratedPath("dist/app.js")).toBe("derived");
    expect(classifyGeneratedPath("src/__tests__/a.test.ts.snap")).toBe("snapshot");
    expect(classifyGeneratedPath("src/app.ts")).toBeUndefined();
  });
});

// ── Classification ────────────────────────────────────────────────────

const FLEET_STARTED_AT = 1_700_000_000_000;

function conflict(
  path: string,
  options: {
    memberCommits?: readonly { sha: string; committedAt: number }[];
    baseCommits?: readonly { sha: string; committedAt: number }[];
  } = {},
): RebaseConflictedPath {
  return {
    path,
    memberCommits: options.memberCommits ?? [],
    baseCommits: options.baseCommits ?? [],
  };
}

function classify(overrides: Partial<ClassifyRebaseFailureInput>) {
  return classifyRebaseFailure({
    conflicts: [],
    fleetStartedAt: FLEET_STARTED_AT,
    memberLive: false,
    ...overrides,
  });
}

describe("classifyRebaseFailure", () => {
  it("is not-a-conflict when the stopped rebase has no conflicted paths", () => {
    expect(classify({ conflicts: [], memberLive: true })).toEqual({ kind: "not-a-conflict" });
  });

  it("is generated when every conflicted path is derived", () => {
    expect(
      classify({
        conflicts: [conflict("pnpm-lock.yaml"), conflict("dist/app.js")],
      }),
    ).toEqual({ kind: "generated", paths: ["pnpm-lock.yaml", "dist/app.js"] });
  });

  it("is never generated when one conflicted path is authored work", () => {
    const result = classify({
      conflicts: [conflict("pnpm-lock.yaml"), conflict("src/app.ts")],
    });
    expect(result.kind).not.toBe("generated");
    expect(result.kind).toBe("unknown");
  });

  it("is a contradiction when a base-side commit landed after the fleet started", () => {
    const result = classify({
      conflicts: [
        conflict("src/app.ts", {
          memberCommits: [{ sha: "a".repeat(40), committedAt: FLEET_STARTED_AT + 60_000 }],
          baseCommits: [{ sha: "b".repeat(40), committedAt: FLEET_STARTED_AT + 120_000 }],
        }),
      ],
      // A live lease does not make a landed sibling's conflict delegable.
      memberLive: true,
    });
    expect(result).toEqual({
      kind: "contradiction",
      paths: ["src/app.ts"],
      memberCommits: ["a".repeat(40)],
      baseCommits: ["b".repeat(40)],
      // Nothing proves a sibling wrote it, so none is named.
      landedSiblings: [],
    });
  });

  it("names only the siblings the run record proves landed", () => {
    const result = classify({
      landedSiblings: ["bd-15", "bd-12", "bd-15"],
      conflicts: [
        conflict("src/app.ts", {
          baseCommits: [{ sha: "b".repeat(40), committedAt: FLEET_STARTED_AT + 1 }],
        }),
      ],
    });
    expect(result.kind).toBe("contradiction");
    if (result.kind !== "contradiction") return;
    expect(result.landedSiblings).toEqual(["bd-12", "bd-15"]);
  });

  it("treats a mixed sibling/pre-existing conflict as a contradiction", () => {
    const result = classify({
      conflicts: [
        // Base work that predates the fleet: delegable on its own.
        conflict("docs/old.md", {
          baseCommits: [{ sha: "c".repeat(40), committedAt: FLEET_STARTED_AT - 60_000 }],
        }),
        // A sibling landed on this one after the fleet started.
        conflict("src/app.ts", {
          baseCommits: [{ sha: "d".repeat(40), committedAt: FLEET_STARTED_AT }],
        }),
      ],
      memberLive: true,
    });
    expect(result.kind).toBe("contradiction");
    if (result.kind !== "contradiction") return;
    expect(result.paths).toEqual(["docs/old.md", "src/app.ts"]);
    // Only the sibling's commit is named: the older base work is not the reason.
    expect(result.baseCommits).toEqual(["d".repeat(40)]);
  });

  it("never claims a contradiction without knowing when the fleet started", () => {
    const result = classify({
      fleetStartedAt: undefined,
      memberLive: true,
      conflicts: [
        conflict("src/app.ts", {
          baseCommits: [{ sha: "e".repeat(40), committedAt: Number.MAX_SAFE_INTEGER }],
        }),
      ],
    });
    expect(result).toEqual({
      kind: "delegable",
      paths: ["src/app.ts"],
      baseCommits: ["e".repeat(40)],
    });
  });

  it("is delegable when the base work predates the fleet and the member is live", () => {
    const result = classify({
      memberLive: true,
      conflicts: [
        conflict("src/app.ts", {
          memberCommits: [{ sha: "f".repeat(40), committedAt: FLEET_STARTED_AT + 1 }],
          baseCommits: [{ sha: "9".repeat(40), committedAt: FLEET_STARTED_AT - 1 }],
        }),
      ],
    });
    expect(result).toEqual({
      kind: "delegable",
      paths: ["src/app.ts"],
      baseCommits: ["9".repeat(40)],
    });
  });

  it("is unknown when no lease is live and no sibling landed on the path", () => {
    const result = classify({
      memberLive: false,
      conflicts: [
        conflict("src/app.ts", {
          baseCommits: [{ sha: "9".repeat(40), committedAt: FLEET_STARTED_AT - 1 }],
        }),
      ],
    });
    expect(result).toEqual({ kind: "unknown", paths: ["src/app.ts"] });
  });
});

// ── Bounded stop text ─────────────────────────────────────────────────

describe("rebaseConflictText", () => {
  const manyPaths = Array.from({ length: 8 }, (_, index) => `src/file-${index}.ts`);

  it("leads a contradiction with both commits, then the bounded path list", () => {
    const memberSha = "1234567890abcdef".repeat(2).slice(0, 40);
    const baseSha = "abcdef1234567890".repeat(2).slice(0, 40);
    const text = rebaseConflictText({
      rebaseClass: {
        kind: "contradiction",
        paths: manyPaths,
        memberCommits: [memberSha],
        baseCommits: [baseSha],
        landedSiblings: ["bd-15"],
      },
      branch: "feat/bd-12",
      baseBranch: "main",
    });
    expect(text).toContain("real contradiction");
    expect(text).toContain("landed bd-15");
    expect(text.indexOf(memberSha.slice(0, 12))).toBeLessThan(text.indexOf("src/file-0.ts"));
    expect(text.indexOf(baseSha.slice(0, 12))).toBeLessThan(text.indexOf("src/file-0.ts"));
    expect(text).toContain(`(+${manyPaths.length - REBASE_TEXT_PATH_LIMIT} more)`);
    // The complete list stays in the result's `paths`, not in this line.
    expect(text).not.toContain("src/file-7.ts");
  });

  it("does not claim a sibling when no landed member proves one (bd-280 W2)", () => {
    const text = rebaseConflictText({
      rebaseClass: {
        kind: "contradiction",
        paths: ["src/app.ts"],
        memberCommits: ["a".repeat(40)],
        baseCommits: ["b".repeat(40)],
        landedSiblings: [],
      },
      branch: "feat/bd-12",
      baseBranch: "main",
    });
    // Still a stop — someone has to decide — but the base commit is named as base
    // work committed after the fleet started, not as a sibling's landing.
    expect(text).toContain("real contradiction");
    expect(text).toContain("base work committed after this fleet started");
    expect(text).not.toContain("landed ");
    expect(text).toContain("src/app.ts");
  });

  it("bounds the path list of an unknown failure and keeps the reason", () => {
    const text = rebaseConflictText({
      rebaseClass: { kind: "unknown", paths: manyPaths },
      branch: "feat/bd-12",
      baseBranch: "main",
      reason: "rebase exploded",
    });
    expect(text).toContain("rebase exploded");
    expect(text).toContain(`(+${manyPaths.length - REBASE_TEXT_PATH_LIMIT} more)`);
    expect(text.length).toBeLessThan(400);
  });

  it("names the failed step of a generated-path recovery", () => {
    const text = rebaseConflictText({
      rebaseClass: { kind: "generated", paths: ["pnpm-lock.yaml"] },
      branch: "feat/bd-12",
      baseBranch: "main",
      reason: "regeneration failed: `pnpm install` failed: ENOSPC",
    });
    expect(text).toContain("generated paths (pnpm-lock.yaml)");
    expect(text).toContain("regeneration failed");
  });

  it("says a delegable conflict was not delegated when a reason is given", () => {
    // The caller passes a reason exactly when the hint could not be handed over, so
    // the text must not still read as a completed delegation (bd-280 W4).
    const text = rebaseConflictText({
      rebaseClass: {
        kind: "delegable",
        paths: ["src/app.ts"],
        baseCommits: ["b".repeat(40)],
      },
      branch: "feat/bd-12",
      baseBranch: "main",
      reason: "the rebase-hint could not be written",
    });
    expect(text).toContain("not delegated");
    expect(text).toContain("the rebase-hint could not be written");
    expect(text).toContain("src/app.ts");
    expect(text).not.toContain("delegated to the member");
  });

  it("says there were no conflicted paths instead of naming none", () => {
    const text = rebaseConflictText({
      rebaseClass: { kind: "unknown", paths: [] },
      branch: "feat/bd-12",
      baseBranch: "main",
      reason: "index.lock exists",
    });
    expect(text).toContain("no conflicted paths");
    expect(text).toContain("index.lock exists");
  });

  it("formats exactly the limit without a remainder pointer", () => {
    const paths = manyPaths.slice(0, REBASE_TEXT_PATH_LIMIT);
    expect(formatRebasePathList(paths)).toBe(paths.join(", "));
    expect(formatRebasePathList([...paths, "src/one-more.ts"])).toBe(
      `${paths.join(", ")} (+1 more)`,
    );
  });
});

// ── Bounded durable path detail ───────────────────────────────────────

describe("formatBoundedPathDetail", () => {
  it("keeps the count and every path that fits the budget", () => {
    const paths = ["a.txt", "b.txt", "c.txt"];
    expect(formatBoundedPathDetail({ prefix: "delegated bd-12", paths, budget: 400 })).toBe(
      "delegated bd-12 (3 paths): a.txt, b.txt, c.txt",
    );
  });

  it("names how many paths the cap hid instead of cutting one mid-token", () => {
    const paths = ["src/one.ts", "src/two.ts", "src/three.ts", "src/four.ts"];
    const detail = formatBoundedPathDetail({
      prefix: "delegated bd-12",
      paths,
      budget: "delegated bd-12 (4 paths): src/one.ts, src/two.ts (+2 more)".length,
    });
    expect(detail).toBe("delegated bd-12 (4 paths): src/one.ts, src/two.ts (+2 more)");
    expect(detail).not.toContain("src/thr");
  });

  it("keeps the total count even when no path fits", () => {
    const detail = formatBoundedPathDetail({
      prefix: "delegated bd-12",
      paths: ["a-very-long-path/one.ts", "a-very-long-path/two.ts"],
      budget: "delegated bd-12 (2 paths): (+2 more)".length,
    });
    expect(detail).toBe("delegated bd-12 (2 paths): (+2 more)");
  });

  it("uses the singular for one path", () => {
    expect(formatBoundedPathDetail({ prefix: "p", paths: ["a.ts"], budget: 400 })).toBe(
      "p (1 path): a.ts",
    );
  });
});
