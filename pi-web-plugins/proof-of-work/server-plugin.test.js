import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Plain-JS vitest coverage for the proof-of-work server entry (bd-303).
 *
 * The server module is what replaces the retired `.belayd/proof-receipt.json`
 * browser read: given a workspace scope it must resolve the harness's store from
 * the git common dir and return the `proof_receipt` payload unchanged. The store
 * below is a real SQLite file, so the queries are exercised for real.
 */

const sqliteProbe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
});
const sqliteAvailable = sqliteProbe.status === 0;
const describeSqlite = sqliteAvailable ? describe : describe.skip;

if (!sqliteAvailable) {
  console.warn(`Skipping server-plugin store tests: node:sqlite unavailable`);
}

async function loadPlugin() {
  return await import("./server-plugin.js");
}

async function sqlite() {
  return await import("node:sqlite");
}

const dirs = [];

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "belayd-proof-server-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeContext(execFile) {
  return {
    apiVersion: 5,
    pluginId: "proof-of-work",
    packageRoot: ".",
    dataDirectory: ".",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
    execFile,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  };
}

function execFileReturning(commonDir) {
  return async () => ({
    exitCode: 0,
    signal: null,
    stdout: `${commonDir}\n`,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}

function execFileFailing({ exitCode = 128, stderr = "fatal: not a git repository" } = {}) {
  return async () => ({
    exitCode,
    signal: null,
    stdout: "",
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}

/** A probe killed by a timeout/signal: no exit status, per the host contract. */
function execFileKilled({ signal = "SIGTERM" } = {}) {
  return async () => ({
    exitCode: null,
    signal,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}

function workspaceRequest(workspacePath, input = {}) {
  return {
    operation: "receipt",
    scope: {
      kind: "workspace",
      project: { id: "project-1" },
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        path: workspacePath,
        label: "ws",
        isMain: true,
      },
    },
    input,
    signal: new AbortController().signal,
  };
}

/** A store at `<commonDir>/belayd/state.sqlite` with the two mirrored tables. */
async function makeStoreWithCommonDir({ binding } = {}) {
  const { DatabaseSync } = await sqlite();
  const commonDir = makeDir();
  const belaydDir = join(commonDir, "belayd");
  mkdirSync(belaydDir, { recursive: true });
  const path = join(belaydDir, "state.sqlite");
  const database = new DatabaseSync(path);
  database.exec(
    `CREATE TABLE workflow_binding (
       worktree_path TEXT PRIMARY KEY,
       task_id TEXT NOT NULL,
       bound_at INTEGER NOT NULL
     )`,
  );
  database.exec(
    `CREATE TABLE proof_receipt (
       task_id TEXT PRIMARY KEY,
       payload TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  );
  if (binding !== undefined) {
    database
      .prepare("INSERT INTO workflow_binding (worktree_path, task_id, bound_at) VALUES (?, ?, ?)")
      .run(binding.worktreePath, binding.taskId, 10);
  }
  if (binding !== undefined && binding.payload !== undefined) {
    database
      .prepare("INSERT INTO proof_receipt (task_id, payload, updated_at) VALUES (?, ?, ?)")
      .run(binding.taskId, binding.payload, 20);
  }
  database.close();
  return { commonDir, path };
}

describeSqlite("createProofOfWorkPeer receipt operation", () => {
  it("resolves the store from the git common dir and returns the bound row verbatim", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const payload = JSON.stringify({ version: 1, taskId: "bd-181", id: "upload-42" });
    const { commonDir } = await makeStoreWithCommonDir({
      binding: { worktreePath: "/ws/task", taskId: "bd-181", payload },
    });
    const calls = [];
    const peer = createProofOfWorkPeer(
      fakeContext(async (request) => {
        calls.push(request);
        return execFileReturning(commonDir)(request);
      }),
      { env: {} },
    );

    const result = await peer.request(workspaceRequest("/ws/task"));

    expect(result).toEqual({ kind: "receipt", payload, updatedAt: 20 });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("git");
    expect(calls[0].args).toEqual([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    expect(calls[0].cwd).toBe("/ws/task");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    // Git-context parity with the harness's `gitContextFreeEnv()`: an inherited
    // GIT_DIR must not redirect the probe at another repository's store.
    expect(calls[0].unsetEnv).toEqual([
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
    ]);
  });

  it("ignores an unexpected task id in the input", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const bound = JSON.stringify({ version: 1, taskId: "bd-181", id: "upload-42" });
    const other = JSON.stringify({ version: 1, taskId: "bd-999", url: "https://p.example/x/1" });
    const { commonDir, path } = await makeStoreWithCommonDir({
      binding: { worktreePath: "/ws/task", taskId: "bd-181", payload: bound },
    });
    const { DatabaseSync } = await sqlite();
    const database = new DatabaseSync(path);
    database
      .prepare("INSERT INTO proof_receipt (task_id, payload, updated_at) VALUES (?, ?, ?)")
      .run("bd-999", other, 30);
    database.close();
    const peer = createProofOfWorkPeer(fakeContext(execFileReturning(commonDir)), { env: {} });

    // The receipt is the workspace's bound task's receipt; workspace scope alone
    // must never read another bead's row.
    const result = await peer.request(workspaceRequest("/ws/task", { taskId: "bd-999" }));

    expect(result).toEqual({ kind: "receipt", payload: bound, updatedAt: 20 });
  });

  it("refuses a non-object input", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const peer = createProofOfWorkPeer(fakeContext(execFileFailing()), { env: {} });

    await expect(
      peer.request({ ...workspaceRequest("/ws/task"), input: "bd-181" }),
    ).rejects.toThrow(/input must be an object/);
  });

  it("reads a workspace whose store file was never created as no receipt", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const commonDir = makeDir();
    const peer = createProofOfWorkPeer(fakeContext(execFileReturning(commonDir)), { env: {} });

    // No `<commonDir>/belayd/state.sqlite` exists: the harness creates it on the
    // first write, so this is the ordinary case, not an unreadable receipt.
    expect(await peer.request(workspaceRequest("/ws/task"))).toEqual({ kind: "none" });
  });

  it("honours BELAYD_REPO_STATE_FILE before probing git", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const payload = JSON.stringify({ version: 1, taskId: "bd-777", id: "upload-7" });
    const { path } = await makeStoreWithCommonDir({
      binding: { worktreePath: "/ws/task", taskId: "bd-777", payload },
    });
    const peer = createProofOfWorkPeer(fakeContext(execFileFailing()), {
      env: { BELAYD_REPO_STATE_FILE: path },
    });

    const result = await peer.request(workspaceRequest("/ws/task"));

    expect(result).toEqual({ kind: "receipt", payload, updatedAt: 20 });
  });

  it("reports none when the worktree has no binding", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const { commonDir } = await makeStoreWithCommonDir();
    const peer = createProofOfWorkPeer(fakeContext(execFileReturning(commonDir)), { env: {} });

    expect(await peer.request(workspaceRequest("/ws/unbound"))).toEqual({ kind: "none" });
  });

  it("reports none when the bound task has no receipt row", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const { commonDir } = await makeStoreWithCommonDir({
      binding: { worktreePath: "/ws/task", taskId: "bd-181" },
    });
    const peer = createProofOfWorkPeer(fakeContext(execFileReturning(commonDir)), { env: {} });

    expect(await peer.request(workspaceRequest("/ws/task"))).toEqual({ kind: "none" });
  });

  it("reports none for a workspace that is not inside a repository", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const workspacePath = makeDir();
    const peer = createProofOfWorkPeer(fakeContext(execFileFailing()), { env: {} });

    // Git ran and exited non-zero, and no `.git` marker exists above the
    // workspace: that is an observed absence, not a broken store.
    expect(await peer.request(workspaceRequest(workspacePath))).toEqual({ kind: "none" });
  });

  it("reports unavailable when git fails inside a repository", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const workspacePath = makeDir();
    mkdirSync(join(workspacePath, ".git"), { recursive: true });
    const peer = createProofOfWorkPeer(fakeContext(execFileFailing()), { env: {} });

    const result = await peer.request(workspaceRequest(workspacePath));

    expect(result.kind).toBe("unavailable");
    expect(result.detail).toContain("not a git repository");
  });

  it("reports unavailable when the git probe was killed outside a repository", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const workspacePath = makeDir();
    const peer = createProofOfWorkPeer(fakeContext(execFileKilled()), { env: {} });

    // A killed probe is `indeterminate`, never an observed absence: the gate
    // fails closed on exactly this outcome, so "I could not ask git" must not
    // render as "no receipt".
    const result = await peer.request(workspaceRequest(workspacePath));

    expect(result.kind).toBe("unavailable");
    expect(result.detail).toContain("SIGTERM");
  });

  it("reports unavailable when the git probe was killed inside a repository", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const workspacePath = makeDir();
    mkdirSync(join(workspacePath, ".git"), { recursive: true });
    const peer = createProofOfWorkPeer(fakeContext(execFileKilled()), { env: {} });

    const result = await peer.request(workspaceRequest(workspacePath));

    expect(result.kind).toBe("unavailable");
  });

  it("reports unavailable when the probe exited without an exit status", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const peer = createProofOfWorkPeer(
      fakeContext(async () => ({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      })),
      { env: {} },
    );

    expect((await peer.request(workspaceRequest(makeDir()))).kind).toBe("unavailable");
  });

  it("reports unavailable when the store will not open", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const commonDir = makeDir();
    const belaydDir = join(commonDir, "belayd");
    mkdirSync(belaydDir, { recursive: true });
    writeFileSync(join(belaydDir, "state.sqlite"), "not a database\n");
    const peer = createProofOfWorkPeer(fakeContext(execFileReturning(commonDir)), { env: {} });

    const result = await peer.request(workspaceRequest("/ws/task"));

    expect(result.kind).toBe("unavailable");
  });

  it("refuses a request that is not scoped to a workspace", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const peer = createProofOfWorkPeer(fakeContext(execFileFailing()), { env: {} });

    await expect(
      peer.request({
        operation: "receipt",
        scope: { kind: "project", project: { id: "project-1" } },
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/workspace scope is required/);
  });

  it("refuses an unknown operation", async () => {
    const { createProofOfWorkPeer } = await loadPlugin();
    const peer = createProofOfWorkPeer(fakeContext(execFileFailing()), { env: {} });

    await expect(
      peer.request({ ...workspaceRequest("/ws/task"), operation: "write" }),
    ).rejects.toThrow(/unknown proof-of-work operation/);
  });
});
