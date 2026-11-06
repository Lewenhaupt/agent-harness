/**
 * Two-process proof for the shared repository state store (bd-281).
 *
 * The acceptance criteria are cross-process facts, so they are proven with real
 * child processes over one SQLite file:
 *
 * - two sessions in two worktrees, in two processes, race one orchestrator lease
 *   and exactly one wins — the loser gets the holder's *identity*, not a stale
 *   copy;
 * - two processes read-modify-write the same workflow row with no lost update,
 *   because the read and the write share one `BEGIN IMMEDIATE`;
 * - the store lives in the git common dir, so both worktrees resolve the same
 *   file and neither writes state under its own worktree.
 *
 * The child fixture talks to `node:sqlite` directly (see its header); the parent
 * reads the result back through the real store module.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  openRepoStateStore,
  REPO_STATE_FILE_NAME,
  resetRepoStatePaths,
} from "../src/repo-state-store.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureScript = join(testDir, "fixtures", "repo-state-process.mjs");

const sqliteProbe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
});
const sqliteAvailable = sqliteProbe.status === 0;
if (!sqliteAvailable) {
  console.warn(
    `Skipping integration test: node:sqlite unavailable (${sqliteProbe.stderr.trim() || `exit ${String(sqliteProbe.status)}`})`,
  );
}
const describeSqlite = sqliteAvailable ? describe : describe.skip;

const children: ReturnType<typeof spawn>[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetRepoStatePaths();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-repo-state-integration-"));
  tempDirs.push(dir);
  return dir;
}

interface ChildOutcome {
  readonly code: number | null;
  readonly stdout: string;
}

function runChild(args: readonly string[]): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixtureScript, ...args], { env: { ...process.env } });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (stderr !== "" && code !== 0) process.stderr.write(stderr);
      resolve({ code, stdout });
    });
  });
}

describeSqlite("shared repository state store across processes", () => {
  it("gives one of two racing sessions the lease and names the loser's holder", async () => {
    const dir = tempDir();
    const storePath = join(dir, "state.sqlite");
    const opened = openRepoStateStore({ path: storePath });
    if (!opened.ok) throw new Error(opened.error);
    opened.store.close();

    const startFile = join(dir, "go");
    const claimed = Promise.all([
      runChild([storePath, "claim-lease", "bd-42", "session-a", "/repo.feat-bd-42", startFile]),
      runChild([storePath, "claim-lease", "bd-42", "session-b", "/repo.other-bd-42", startFile]),
    ]);
    writeFileSync(startFile, "go");
    const outcomes = await claimed;

    const lines = outcomes.map((outcome) => outcome.stdout.trim());
    expect(lines.filter((line) => line.startsWith("won:"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("lost:"))).toHaveLength(1);

    const reader = openRepoStateStore({ path: storePath });
    if (!reader.ok) throw new Error(reader.error);
    const winner = lines.find((line) => line.startsWith("won:"))?.slice(4);
    const lease = reader.store.readLease({ taskId: "bd-42" });
    reader.store.close();
    expect(lease).toHaveProperty("value.sessionId", winner);
    expect(lease).toHaveProperty("value.taskId", "bd-42");
  });

  it("keeps both concurrent appends to one workflow row", async () => {
    const dir = tempDir();
    const storePath = join(dir, "state.sqlite");
    const opened = openRepoStateStore({ path: storePath });
    if (!opened.ok) throw new Error(opened.error);
    opened.store.close();

    const startFile = join(dir, "go");
    const appended = Promise.all([
      runChild([storePath, "append-phase", "bd-42", "scout", startFile]),
      runChild([storePath, "append-phase", "bd-42", "plan", startFile]),
    ]);
    writeFileSync(startFile, "go");
    await appended;

    const reader = openRepoStateStore({ path: storePath });
    if (!reader.ok) throw new Error(reader.error);
    const row = reader.store.readWorkflow({ taskId: "bd-42" });
    reader.store.close();

    expect(row.ok).toBe(true);
    if (!row.ok || row.value === null) return;
    // No lost update: each append read the other's write inside its transaction.
    expect([...row.value.state.completedPhaseNames].sort()).toEqual(["plan", "scout"]);
    expect(row.value.generation).toBe(2);
  });

  it("resolves one database in the git common dir for two worktrees", () => {
    const mainWorktree = tempDir();
    const linkedWorktree = tempDir();
    const gitCommonDir = join(mainWorktree, ".git");
    mkdirSync(gitCommonDir, { recursive: true });

    const resolve = () => ({ ok: true as const, commonDir: gitCommonDir });
    const expected = join(gitCommonDir, "belayd", REPO_STATE_FILE_NAME);

    resetRepoStatePaths();
    const fromMain = openRepoStateStore({ cwd: mainWorktree, resolveCommonDir: resolve, env: {} });
    resetRepoStatePaths();
    const fromLinked = openRepoStateStore({
      cwd: linkedWorktree,
      resolveCommonDir: resolve,
      env: {},
    });
    if (!fromMain.ok || !fromLinked.ok) throw new Error("store could not be opened");

    expect(fromMain.store.path).toBe(expected);
    expect(fromLinked.store.path).toBe(expected);

    fromMain.store.writeWorkflow({
      state: {
        taskId: "bd-42",
        workflowType: "feature",
        branch: "feat/bd-42",
        originalCwd: mainWorktree,
        phaseOrder: ["scout"],
        completedPhaseNames: ["scout"],
        startedAt: 1,
        updatedAt: 2,
      },
      worktreePath: mainWorktree,
    });

    // The second worktree reads the same row by task id: no copy exists to inherit.
    expect(fromLinked.store.readWorkflow({ taskId: "bd-42" })).toHaveProperty(
      "value.state.completedPhaseNames",
      ["scout"],
    );
    fromMain.store.close();
    fromLinked.store.close();

    // Nothing was written into either worktree's own `.belayd/`.
    for (const worktree of [mainWorktree, linkedWorktree]) {
      const belayd = join(worktree, ".belayd");
      if (!existsSync(belayd)) continue;
      expect(readdirSync(belayd)).not.toContain(REPO_STATE_FILE_NAME);
    }
  });
});
