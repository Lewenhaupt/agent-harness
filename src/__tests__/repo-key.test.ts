/**
 * Unit tests for project-key derivation and project-scoped proof bases (bd-58).
 *
 * `projectKeyFromRepoRoot` is deterministic and uses the real filesystem (it
 * hashes the realpath), so these tests use real temp directories. `resolveRepoKey`
 * takes an injected exec seam, which lets us cover absolute/relative git output
 * and git failures without shelling out.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectProofBase } from "../proof-dir.js";
import { projectKeyFromRepoRoot, resolveRepoKey } from "../worktree.js";

/**
 * Git-context variables that override the process cwd. Test helpers strip
 * them so temp repos and git queries are pinned to their arguments even when
 * the ambient environment (e.g. a git hook) has exported them.
 */
const GIT_CONTEXT_ENV_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

/** Copy `process.env` without the git-context variables, leaving it unmutated. */
function withoutGitContextEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_CONTEXT_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/** Initialize a throwaway git repo so real `git rev-parse` succeeds. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], {
    env: withoutGitContextEnv(),
    timeout: 10_000,
    stdio: "pipe",
  });
}

/**
 * Report the checkout's own git dir, ignoring the ambient git-context
 * variables so the result does not depend on the test environment.
 */
function gitDirOfCurrentCheckout(): string {
  return execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: process.cwd(),
    env: withoutGitContextEnv(),
    timeout: 10_000,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

describe("projectKeyFromRepoRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "repo-key-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is deterministic for one root", () => {
    const repoRoot = join(tmpDir, "my-repo");
    mkdirSync(repoRoot);

    expect(projectKeyFromRepoRoot(repoRoot)).toBe(projectKeyFromRepoRoot(repoRoot));
  });

  it("differs across roots with the same basename", () => {
    const first = join(tmpDir, "a", "shared-name");
    const second = join(tmpDir, "b", "shared-name");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    const firstKey = projectKeyFromRepoRoot(first);
    const secondKey = projectKeyFromRepoRoot(second);

    expect(firstKey).not.toBe(secondKey);
    expect(firstKey.startsWith("shared-name-")).toBe(true);
    expect(secondKey.startsWith("shared-name-")).toBe(true);
  });

  it("sanitizes unsafe characters in the basename", () => {
    const repoRoot = join(tmpDir, "my repo!@#");
    mkdirSync(repoRoot);

    const key = projectKeyFromRepoRoot(repoRoot);

    expect(key.startsWith("my-repo---")).toBe(true);
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("falls back to the literal repo name when the basename sanitizes to empty", () => {
    // path.basename("/") is empty, so the readable part falls back to "repo".
    const key = projectKeyFromRepoRoot("/");

    expect(key.startsWith("repo-")).toBe(true);
  });

  it('treats a "." basename as "repo" instead of a hidden key', () => {
    // A trailing "/." leaves basename as ".", which survives sanitization and
    // would otherwise produce a hidden directory like ".-<hash>" under the
    // proof root. realpathSync resolves it to the parent, which must exist.
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(repoRoot);

    // A template literal avoids path.join normalizing the trailing "".".
    const key = projectKeyFromRepoRoot(`${repoRoot}/.`);

    expect(key.startsWith("repo-")).toBe(true);
  });

  it('treats a ".." basename as "repo" instead of a traversal-like key', () => {
    // A trailing "/.." leaves basename as "..", which would otherwise produce
    // a "..-<hash>" key; realpathSync resolves it to tmpDir, which exists.
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(repoRoot);

    // A template literal avoids path.join normalizing the trailing "/..".
    const key = projectKeyFromRepoRoot(`${repoRoot}/..`);

    expect(key.startsWith("repo-")).toBe(true);
  });
});

describe("resolveRepoKey", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "repo-key-exec-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("derives the key from an absolute git-common-dir", () => {
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(repoRoot);
    const exec = (): string => `${join(repoRoot, ".git")}\n`;

    const result = resolveRepoKey(repoRoot, exec);

    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.key).toBe(projectKeyFromRepoRoot(repoRoot));
    }
  });

  it("resolves a relative git-common-dir against the cwd", () => {
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(repoRoot);
    const exec = (): string => ".git\n";

    const result = resolveRepoKey(repoRoot, exec);

    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.key).toBe(projectKeyFromRepoRoot(repoRoot));
    }
  });

  it("returns an error when git fails", () => {
    const exec = (): string => {
      throw new Error("not a git repository");
    };

    const result = resolveRepoKey(tmpDir, exec);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.error).toContain("git rev-parse --git-common-dir failed");
      expect(result.error).toContain("not a git repository");
    }
  });

  it("returns an error when git reports an empty common dir", () => {
    const result = resolveRepoKey(tmpDir, () => "\n");

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.error).toContain("empty common dir");
    }
  });

  it("pins the documented bare-repo limitation: a bare common dir resolves to its parent", () => {
    // A bare repo reports itself as the git-common-dir, so dirname yields the
    // parent — two bare repos under one parent collide. This is a documented
    // out-of-scope limitation, not supported behavior.
    const parent = join(tmpDir, "bare-parent");
    const bareRepo = join(parent, "repo.git");
    mkdirSync(bareRepo, { recursive: true });
    const exec = (): string => `${bareRepo}\n`;

    const result = resolveRepoKey(bareRepo, exec);

    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.key).toBe(projectKeyFromRepoRoot(parent));
    }
  });
});

describe("resolveProjectProofBase", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "project-proof-base-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("namespaces a custom BELAYD_PROOF_DIR by project key", () => {
    const repoRoot = join(tmpDir, "repo");
    initRepo(repoRoot);
    const globalRoot = join(tmpDir, "external", "proof");

    const result = resolveProjectProofBase({ BELAYD_PROOF_DIR: globalRoot }, repoRoot);

    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.base).toBe(join(globalRoot, projectKeyFromRepoRoot(repoRoot)));
    }
  });

  it("returns an error for a cwd with no git repo", () => {
    const noRepo = join(tmpDir, "plain-dir");
    mkdirSync(noRepo);

    const result = resolveProjectProofBase({ BELAYD_PROOF_DIR: join(tmpDir, "proof") }, noRepo);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.error).toContain("git rev-parse --git-common-dir failed");
    }
  });
});

describe("resolveRepoKey with inherited git-context env (bd-58 regression)", () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "repo-key-env-test-"));
    savedEnv = {};
    for (const key of GIT_CONTEXT_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of GIT_CONTEXT_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("derives the key from the passed cwd even when GIT_DIR points at another repo", () => {
    // initRepo runs before GIT_DIR is set so the throwaway repo is created in
    // tmpDir rather than in the checkout the inherited variables point at.
    const repoRoot = join(tmpDir, "tmp-repo");
    initRepo(repoRoot);
    process.env.GIT_DIR = gitDirOfCurrentCheckout();
    process.env.GIT_WORK_TREE = process.cwd();

    const result = resolveRepoKey(repoRoot);

    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.key).toBe(projectKeyFromRepoRoot(repoRoot));
    }
  });

  it("returns an error for a non-repo cwd even when GIT_DIR points at the real repo", () => {
    const noRepo = join(tmpDir, "plain-dir");
    mkdirSync(noRepo);
    process.env.GIT_DIR = gitDirOfCurrentCheckout();

    const result = resolveProjectProofBase({ BELAYD_PROOF_DIR: join(tmpDir, "proof") }, noRepo);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.error).toContain("git rev-parse --git-common-dir failed");
    }
  });
});
