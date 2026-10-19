import { describe, expect, it } from "vitest";
import { isSafeChdirTarget } from "../chdir-guard.js";

const repoPath = "/home/user/repo";

/** Existence/directory probes over a fixed set of directories. */
function probes(directories: readonly string[]): {
  existsSync: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
} {
  return {
    existsSync: (path) => directories.includes(path),
    isDirectory: (path) => directories.includes(path),
  };
}

describe("isSafeChdirTarget", () => {
  it("allows an existing absolute directory", () => {
    expect(isSafeChdirTarget({ path: repoPath, ...probes([repoPath]) })).toEqual({
      allowed: true,
      path: repoPath,
    });
  });

  it("rejects a path that exists but is a regular file", () => {
    const result = isSafeChdirTarget({
      path: repoPath,
      existsSync: () => true,
      // The path survives on disk, but as a file: process.chdir would throw
      // ENOTDIR out of the tool handler.
      isDirectory: () => false,
    });

    expect(result.allowed).toBe(false);
    expect(result).toHaveProperty("reason", `${repoPath} is not a directory`);
  });

  it("rejects a missing directory", () => {
    const result = isSafeChdirTarget({ path: "/home/user/gone", ...probes([repoPath]) });

    expect(result.allowed).toBe(false);
    expect(result).toHaveProperty("reason", "/home/user/gone does not exist");
  });

  it("rejects the filesystem root", () => {
    const result = isSafeChdirTarget({
      path: "/",
      existsSync: () => true,
      isDirectory: () => true,
    });

    expect(result.allowed).toBe(false);
    expect(result).toHaveProperty("reason", "/ is the filesystem root");
  });

  it("rejects an empty path", () => {
    const result = isSafeChdirTarget({ path: "   ", ...probes([repoPath]) });

    expect(result.allowed).toBe(false);
    expect(result).toHaveProperty("reason", "the recorded directory is empty");
  });

  it("rejects a relative path instead of resolving it against the current cwd", () => {
    const result = isSafeChdirTarget({ path: "repo", ...probes([repoPath]) });

    expect(result.allowed).toBe(false);
    expect(result).toHaveProperty("reason", '"repo" is not an absolute path');
  });

  it("honours a non-root rootPath override", () => {
    const result = isSafeChdirTarget({
      path: "/work",
      existsSync: () => true,
      isDirectory: () => true,
      rootPath: "/work",
    });

    expect(result.allowed).toBe(false);
  });
});
