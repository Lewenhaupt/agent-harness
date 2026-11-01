import { describe, expect, it } from "vitest";
import {
  PROOF_DIR_MARKER_PATH,
  PROOF_OF_WORK_ROOT,
  PROOF_RECEIPT_PATH,
  getFileExtension,
  listTaskDirs,
  listTaskFiles,
  mediaPreviewUrl,
  readProofFile,
  resolveProofReceipt,
  resolveProofRoot,
  resolveTracePath,
  traceFileAvailable,
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

describe("resolveProofReceipt", () => {
  const receipt = { version: 1, taskId: "bd-181", url: "https://proof.example.com/u/1" };

  it("exposes the gitignored receipt path", () => {
    expect(PROOF_RECEIPT_PATH).toBe(".belayd/proof-receipt.json");
  });

  it("returns none when the receipt file is missing", async () => {
    const files = fakeFiles({ readFile: () => rejectWith("Path does not exist") });

    expect(await resolveProofReceipt(files)).toEqual({ kind: "none" });
  });

  it("returns the normalized receipt when one exists", async () => {
    const files = fakeFiles({
      readFile: async () =>
        readFileReturning(JSON.stringify({ ...receipt, taskId: "  bd-181  " })),
    });

    expect(await resolveProofReceipt(files)).toEqual({ kind: "receipt", receipt });
  });

  it("accepts an id-only receipt", async () => {
    const files = fakeFiles({
      readFile: async () => readFileReturning(JSON.stringify({ version: 1, taskId: "bd-181", id: "upload-42" })),
    });

    expect(await resolveProofReceipt(files)).toEqual({
      kind: "receipt",
      receipt: { version: 1, taskId: "bd-181", id: "upload-42" },
    });
  });

  it("reports invalid JSON", async () => {
    const files = fakeFiles({ readFile: async () => readFileReturning("{not json") });

    expect(await resolveProofReceipt(files)).toEqual({
      kind: "invalid",
      detail: "proof receipt is not valid JSON",
    });
  });

  it("reports a binary receipt", async () => {
    const files = fakeFiles({
      readFile: async () => readFileReturning("", { binary: true }),
    });

    expect(await resolveProofReceipt(files)).toEqual({
      kind: "invalid",
      detail: "proof receipt is binary",
    });
  });

  it("reports a denied read", async () => {
    const files = fakeFiles({ readFile: () => rejectWith("Path outside allowed paths") });

    expect(await resolveProofReceipt(files)).toEqual({
      kind: "invalid",
      detail: "Path outside allowed paths",
    });
  });

  it.each([
    ["a newer version", { version: 2, taskId: "bd-181", url: receipt.url }],
    ["no reference", { version: 1, taskId: "bd-181" }],
    ["a relative url", { version: 1, taskId: "bd-181", url: "proof.example.com/x" }],
    ["a non-http url", { version: 1, taskId: "bd-181", url: "ftp://proof.example.com/x" }],
    // The contract is https-only (mirrors `isProofReceiptUrl`); a plain-http
    // receipt must be invalid here exactly as it is on the TypeScript side.
    ["a plain-http url", { version: 1, taskId: "bd-181", url: "http://proof.example.com/x" }],
    ["a url without a path", { version: 1, taskId: "bd-181", url: "https://proof.example.com" }],
    ["a prose id", { version: 1, taskId: "bd-181", id: "done" }],
    ["a short id", { version: 1, taskId: "bd-181", id: "u-1" }],
    ["an empty task id", { version: 1, taskId: " ", url: receipt.url }],
    ["an unknown key", { version: 1, taskId: "bd-181", url: receipt.url, proof: "x" }],
  ])("rejects %s as invalid", async (_label, raw) => {
    const files = fakeFiles({ readFile: async () => readFileReturning(JSON.stringify(raw)) });

    expect(await resolveProofReceipt(files)).toEqual({
      kind: "invalid",
      detail: "proof receipt does not match the receipt contract",
    });
  });
});

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
      readFile: async () => ({
        content: "hello",
        binary: true,
        truncated: true,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      }),
    });

    const result = await readProofFile(files, "/abs/base/bd-1/notes.md");

    expect(result).toEqual({
      kind: "loaded",
      content: "hello",
      binary: true,
      truncated: true,
      modifiedAt: "2026-01-01T00:00:00.000Z",
    });
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

describe("resolveTracePath", () => {
  it("maps the logical proof-of-work path onto the external proof base", () => {
    const result = resolveTracePath(
      { kind: "external", path: "/abs/base" },
      "/home/alice/wt",
      "proof-of-work/bd-108/trace.zip",
    );

    expect(result).toBe("/abs/base/bd-108/trace.zip");
  });

  it("trims a trailing slash from the external base", () => {
    const result = resolveTracePath(
      { kind: "external", path: "/abs/base/" },
      "/home/alice/wt",
      "proof-of-work/bd-108/trace.zip",
    );

    expect(result).toBe("/abs/base/bd-108/trace.zip");
  });

  it("passes an already-absolute external path through unchanged", () => {
    const result = resolveTracePath(
      { kind: "external", path: "/abs/base" },
      "/home/alice/wt",
      "/abs/base/bd-108/trace.zip",
    );

    expect(result).toBe("/abs/base/bd-108/trace.zip");
  });

  it("joins the workspace path when the proof root is workspace-relative", () => {
    const result = resolveTracePath(
      { kind: "workspace", path: "proof-of-work" },
      "/home/alice/wt/",
      "proof-of-work/bd-108/trace.zip",
    );

    expect(result).toBe("/home/alice/wt/proof-of-work/bd-108/trace.zip");
  });

  it("falls back to the workspace path for a non-proof-relative path", () => {
    const result = resolveTracePath(
      { kind: "external", path: "/abs/base" },
      "/home/alice/wt",
      "other/dir/trace.zip",
    );

    expect(result).toBe("/home/alice/wt/other/dir/trace.zip");
  });

  it("falls back to the workspace path when the proof root is unknown", () => {
    const result = resolveTracePath(undefined, "/home/alice/wt", "proof-of-work/bd-108/trace.zip");

    expect(result).toBe("/home/alice/wt/proof-of-work/bd-108/trace.zip");
  });
});

describe("traceFileAvailable", () => {
  it("is true when the trace entry is listed", async () => {
    const files = fakeFiles({
      listFiles: async (path) => ({
        path,
        entries: [
          { name: "notes.md", path: `${path}/notes.md`, type: "file" },
          { name: "trace.zip", path: `${path}/trace.zip`, type: "file" },
        ],
      }),
    });

    await expect(traceFileAvailable(files, "/abs/base/bd-108/trace.zip")).resolves.toBe(true);
  });

  it("is false when the trace entry is gone", async () => {
    const files = fakeFiles({
      listFiles: async (path) => ({
        path,
        entries: [{ name: "notes.md", path: `${path}/notes.md`, type: "file" }],
      }),
    });

    await expect(traceFileAvailable(files, "/abs/base/bd-108/trace.zip")).resolves.toBe(false);
  });

  it("is false when the directory listing rejects", async () => {
    const files = fakeFiles({ listFiles: () => rejectWith("Path does not exist") });

    await expect(traceFileAvailable(files, "/abs/base/bd-108/trace.zip")).resolves.toBe(false);
  });

  it("is false when the matching entry is a directory", async () => {
    const files = fakeFiles({
      listFiles: async (path) => ({
        path,
        entries: [{ name: "trace.zip", path: `${path}/trace.zip`, type: "directory" }],
      }),
    });

    await expect(traceFileAvailable(files, "/abs/base/bd-108/trace.zip")).resolves.toBe(false);
  });

  it("is false for the filesystem root without listing a directory", async () => {
    const listed = [];
    const files = fakeFiles({
      listFiles: async (path) => {
        listed.push(path);
        return { path, entries: [{ name: "", path, type: "file" }] };
      },
    });

    await expect(traceFileAvailable(files, "/")).resolves.toBe(false);
    // The empty basename must short-circuit before any listing, so an empty-name
    // entry can never be treated as the trace.
    expect(listed).toEqual([]);
  });

  it("is false for a trailing-slash path without looking up a parent", async () => {
    const listed = [];
    const files = fakeFiles({
      listFiles: async (path) => {
        listed.push(path);
        return { path, entries: [{ name: "trace.zip", path, type: "file" }] };
      },
    });

    await expect(traceFileAvailable(files, "/abs/base/bd-108/trace.zip/")).resolves.toBe(false);
    expect(listed).toEqual([]);
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

describe("mediaPreviewUrl", () => {
  it("builds the local preview URL shape", () => {
    expect(mediaPreviewUrl({
      machineId: "local-machine",
      machineKind: "local",
      projectId: "proj-1",
      workspaceId: "ws-1",
      filePath: "proof-of-work/TASK-1/screenshot.png",
    })).toBe("/api/projects/proj-1/workspaces/ws-1/file/preview?path=proof-of-work%2FTASK-1%2Fscreenshot.png");
  });

  it("builds the remote preview URL shape through the machines proxy", () => {
    expect(mediaPreviewUrl({
      machineId: "m-42",
      machineKind: "remote",
      projectId: "proj-1",
      workspaceId: "ws-1",
      filePath: "proof-of-work/TASK-1/demo.webm",
    })).toBe("/api/machines/m-42/projects/proj-1/workspaces/ws-1/file/preview?path=proof-of-work%2FTASK-1%2Fdemo.webm");
  });

  it("encodes the path query parameter", () => {
    expect(mediaPreviewUrl({
      machineId: "m",
      machineKind: "local",
      projectId: "p",
      workspaceId: "w",
      filePath: "a b&c=d?e#f.png",
    })).toBe("/api/projects/p/workspaces/w/file/preview?path=a%20b%26c%3Dd%3Fe%23f.png");
  });

  it("encodes projectId and workspaceId in the path", () => {
    expect(mediaPreviewUrl({
      machineId: "m",
      machineKind: "local",
      projectId: "proj/id",
      workspaceId: "ws one",
      filePath: "file.png",
    })).toBe("/api/projects/proj%2Fid/workspaces/ws%20one/file/preview?path=file.png");
  });

  it("omits the cache-busting param when modifiedAt is not provided", () => {
    expect(mediaPreviewUrl({
      machineId: "m",
      machineKind: "local",
      projectId: "p",
      workspaceId: "w",
      filePath: "file.png",
    })).toBe("/api/projects/p/workspaces/w/file/preview?path=file.png");
  });

  it("appends a cache-busting param when modifiedAt is provided", () => {
    expect(mediaPreviewUrl({
      machineId: "m",
      machineKind: "local",
      projectId: "p",
      workspaceId: "w",
      filePath: "file.png",
      modifiedAt: "2026-01-01T00:00:00.000Z",
    })).toBe("/api/projects/p/workspaces/w/file/preview?path=file.png&v=2026-01-01T00%3A00%3A00.000Z");
  });
});
