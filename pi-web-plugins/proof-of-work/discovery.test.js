import { describe, expect, it } from "vitest";
import {
  PROOF_DIR_MARKER_PATH,
  PROOF_OF_WORK_ROOT,
  getFileExtension,
  listTaskDirs,
  listTaskFiles,
  readProofFile,
  resolveProofRoot,
} from "./discovery.js";

/**
 * Plain-JS vitest coverage for the proof-of-work discovery helpers.
 *
 * pi-web plugins have no build step, so this file mirrors the plugin runtime
 * exactly (an ES module, no transpilation) and injects data through a fake
 * `files` object instead of mocking modules. It is served by pi-web but is
 * never imported by the plugin entry module (`pi-web-plugin.js`).
 */

/** Build a fake pi-web `files` API around the given handler functions. */
function fakeFiles(handlers) {
  return {
    readFile: handlers.readFile,
    listFiles: handlers.listFiles,
  };
}

function readFileReturning(content, extra = {}) {
  return { content, binary: false, truncated: false, ...extra };
}

function rejectWith(message) {
  return Promise.reject(new Error(message));
}

describe("resolveProofRoot", () => {
  it("resolves the external base from an absolute marker", async () => {
    const files = fakeFiles({ readFile: async () => readFileReturning("/abs/base\n") });

    const result = await resolveProofRoot(files);

    expect(result).toEqual({ kind: "external", path: "/abs/base" });
  });

  it("falls back to the workspace proof-of-work root when the marker is missing", async () => {
    const files = fakeFiles({ readFile: () => rejectWith("Path does not exist") });

    const result = await resolveProofRoot(files);

    expect(result).toEqual({ kind: "workspace", path: "proof-of-work" });
  });

  it("treats an empty marker as unavailable", async () => {
    const files = fakeFiles({ readFile: async () => readFileReturning("  \n") });

    const result = await resolveProofRoot(files);

    expect(result).toEqual({ kind: "unavailable", detail: "proof-dir marker is empty" });
  });

  it("treats a marker with no text content as unavailable", async () => {
    const files = fakeFiles({ readFile: async () => readFileReturning(null) });

    const result = await resolveProofRoot(files);

    expect(result).toEqual({ kind: "unavailable", detail: "proof-dir marker has no text content" });
  });

  it("treats the filesystem root as unavailable", async () => {
    const files = fakeFiles({ readFile: async () => readFileReturning("/\n") });

    const result = await resolveProofRoot(files);

    expect(result).toEqual({
      kind: "unavailable",
      detail: "proof-dir marker must not point at the filesystem root",
    });
  });

  it("treats a relative marker as unavailable", async () => {
    const files = fakeFiles({ readFile: async () => readFileReturning("proof-of-work") });

    const result = await resolveProofRoot(files);

    expect(result).toEqual({
      kind: "unavailable",
      detail: "proof-dir marker is not an absolute path: proof-of-work",
    });
  });

  it("treats a binary marker as unavailable", async () => {
    const files = fakeFiles({
      readFile: async () => readFileReturning("/abs/base\n", { binary: true }),
    });

    const result = await resolveProofRoot(files);

    expect(result).toEqual({ kind: "unavailable", detail: "proof-dir marker is binary" });
  });

  it("treats an unexpected read error as unavailable", async () => {
    const files = fakeFiles({ readFile: () => rejectWith("boom") });

    const result = await resolveProofRoot(files);

    expect(result).toEqual({ kind: "unavailable", detail: "boom" });
  });

  it("uses the marker path under .belayd", () => {
    expect(PROOF_DIR_MARKER_PATH).toBe(".belayd/proof-dir");
    expect(PROOF_OF_WORK_ROOT).toBe("proof-of-work");
  });
});

describe("listTaskDirs", () => {
  it("lists directory entries under the given absolute root", async () => {
    const calls = [];
    const files = fakeFiles({
      listFiles: (path) => {
        calls.push(path);
        return Promise.resolve({
          entries: [
            { name: "bd-1", path: "/abs/base/bd-1", type: "directory" },
            { name: "bd-2", path: "/abs/base/bd-2", type: "directory" },
            { name: "notes.md", path: "/abs/base/notes.md", type: "file" },
          ],
        });
      },
    });

    const result = await listTaskDirs(files, "/abs/base");

    expect(calls).toEqual(["/abs/base"]);
    expect(result).toEqual({
      kind: "loaded",
      tasks: [
        { name: "bd-1", path: "/abs/base/bd-1" },
        { name: "bd-2", path: "/abs/base/bd-2" },
      ],
    });
  });

  it("maps a missing root to { kind: 'missing' }", async () => {
    const files = fakeFiles({ listFiles: () => rejectWith("Path does not exist") });

    const result = await listTaskDirs(files, "/abs/base");

    expect(result).toEqual({ kind: "missing" });
  });

  it.each(["Path escapes workspace", "Absolute paths are not allowed", "Path is outside allowed paths", "Path traversal is not allowed"])(
    "maps denied root error %s to { kind: 'denied' }",
    async (message) => {
      const files = fakeFiles({ listFiles: () => rejectWith(message) });

      const result = await listTaskDirs(files, "/abs/base");

      expect(result).toEqual({ kind: "denied", detail: message });
    },
  );
});

describe("listTaskFiles", () => {
  it("maps denied errors to { kind: 'denied' }", async () => {
    const files = fakeFiles({ listFiles: () => rejectWith("Path is outside allowed paths") });

    const result = await listTaskFiles(files, "/abs/base/bd-1");

    expect(result).toEqual({ kind: "denied", detail: "Path is outside allowed paths" });
  });

  it("maps path traversal errors to { kind: 'denied' }", async () => {
    const files = fakeFiles({ listFiles: () => rejectWith("Path traversal is not allowed") });

    const result = await listTaskFiles(files, "/abs/base/bd-1");

    expect(result).toEqual({ kind: "denied", detail: "Path traversal is not allowed" });
  });
});

describe("readProofFile", () => {
  it("passes content, binary, and truncated through", async () => {
    const files = fakeFiles({
      readFile: async () => ({ content: "hello", binary: true, truncated: true }),
    });

    const result = await readProofFile(files, "/abs/base/bd-1/notes.md");

    expect(result).toEqual({ kind: "loaded", content: "hello", binary: true, truncated: true });
  });

  it("maps denied errors to { kind: 'denied' }", async () => {
    const files = fakeFiles({ readFile: () => rejectWith("Path escapes workspace") });

    const result = await readProofFile(files, "/abs/base/bd-1/notes.md");

    expect(result).toEqual({ kind: "denied", detail: "Path escapes workspace" });
  });

  it("maps path traversal errors to { kind: 'denied' }", async () => {
    const files = fakeFiles({ readFile: () => rejectWith("Path traversal is not allowed") });

    const result = await readProofFile(files, "/abs/base/bd-1/notes.md");

    expect(result).toEqual({ kind: "denied", detail: "Path traversal is not allowed" });
  });
});

describe("getFileExtension", () => {
  it("returns the lowercase extension including the dot", () => {
    expect(getFileExtension("/a/b/FILE.CAST")).toBe(".cast");
  });

  it("returns an empty string when there is no extension", () => {
    expect(getFileExtension("/a/b/Makefile")).toBe("");
  });
});
