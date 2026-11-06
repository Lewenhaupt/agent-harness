import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Plain-JS vitest coverage for the proof-of-work store reader (bd-303).
 *
 * The reader is the plugin's read half of the harness's per-repository store
 * (`src/repo-state-store.ts`), so the fixture is a real SQLite file with the
 * mirrored tables rather than a mock: the point of the module is its SQL
 * agreeing with the schema the harness writes.
 */

const sqliteProbe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
});
const sqliteAvailable = sqliteProbe.status === 0;
const describeSqlite = sqliteAvailable ? describe : describe.skip;

if (!sqliteAvailable) {
  console.warn(
    `Skipping store-reader tests: node:sqlite unavailable (${sqliteProbe.stderr.trim() || `exit ${String(sqliteProbe.status)}`})`,
  );
}

/** Load the reader lazily: its static `node:sqlite` import must not break the file. */
async function loadReader() {
  return await import("./store-reader.js");
}

async function sqlite() {
  return await import("node:sqlite");
}

const dirs = [];

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "belayd-proof-receipt-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A store file with only the tables the reader mirrors, so a test can also
 * create one table and prove the schema probe fails closed.
 */
async function makeStore({ binding = true, receipt = true } = {}) {
  const { DatabaseSync } = await sqlite();
  const path = join(makeDir(), "state.sqlite");
  const database = new DatabaseSync(path);
  if (binding) {
    database.exec(
      `CREATE TABLE workflow_binding (
         worktree_path TEXT PRIMARY KEY,
         task_id TEXT NOT NULL,
         bound_at INTEGER NOT NULL
       )`,
    );
  }
  if (receipt) {
    database.exec(
      `CREATE TABLE proof_receipt (
         task_id TEXT PRIMARY KEY,
         payload TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }
  return { path, database };
}

describeSqlite("openProofReceiptReader", () => {
  it("reads the task id bound to a worktree and the receipt row for it", async () => {
    const reader = await loadReader();
    const { path, database } = await makeStore();
    database
      .prepare("INSERT INTO workflow_binding (worktree_path, task_id, bound_at) VALUES (?, ?, ?)")
      .run("/ws/task", "bd-181", 10);
    database
      .prepare("INSERT INTO proof_receipt (task_id, payload, updated_at) VALUES (?, ?, ?)")
      .run("bd-181", JSON.stringify({ version: 1, taskId: "bd-181", id: "upload-42" }), 20);
    database.close();

    const opened = reader.openProofReceiptReader({ path });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;
    expect(store.readOnly).toBe(true);
    expect(store.path).toBe(path);
    expect(store.readBoundTaskId("/ws/task")).toBe("bd-181");
    expect(store.readBoundTaskId("/ws/other")).toBeNull();
    expect(store.readReceipt("bd-181")).toEqual({
      payload: JSON.stringify({ version: 1, taskId: "bd-181", id: "upload-42" }),
      updatedAt: 20,
    });
    expect(store.readReceipt("bd-missing")).toBeNull();
    store.close();
  });

  it("treats a cleared binding as no binding", async () => {
    const reader = await loadReader();
    const { path, database } = await makeStore();
    database
      .prepare("INSERT INTO workflow_binding (worktree_path, task_id, bound_at) VALUES (?, ?, ?)")
      .run("/ws/task", "", 10);
    database.close();

    const opened = reader.openProofReceiptReader({ path });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.store.readBoundTaskId("/ws/task")).toBeNull();
    opened.store.close();
  });

  it("exposes reads only", async () => {
    const reader = await loadReader();
    const { path, database } = await makeStore();
    database.close();

    const opened = reader.openProofReceiptReader({ path });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The panel must never open the store writable (bd-303); that is a property
    // of the handle, not a comment on the caller.
    expect(Object.keys(opened.store).sort()).toEqual([
      "close",
      "path",
      "readBoundTaskId",
      "readOnly",
      "readReceipt",
    ]);
    opened.store.close();
  });

  it("fails closed for a path that is not a SQLite database", async () => {
    const reader = await loadReader();
    const path = join(makeDir(), "state.sqlite");
    writeFileSync(path, "not a database\n");

    const opened = reader.openProofReceiptReader({ path });

    expect(opened.ok).toBe(false);
    // An existing file that cannot be read is a failure, not an absence.
    if (!opened.ok) expect(opened.absent).toBe(false);
  });

  it("reports a missing store file as absent, not a failure", async () => {
    const reader = await loadReader();

    const opened = reader.openProofReceiptReader({ path: join(makeDir(), "absent.sqlite") });

    // The harness creates the store on its first write, so a workspace that has
    // never run a phase tool is the ordinary "no receipt" case.
    expect(opened).toEqual({ ok: false, absent: true, error: expect.any(String) });
  });

  it("reports a missing store directory as absent", async () => {
    const reader = await loadReader();

    const opened = reader.openProofReceiptReader({ path: join(makeDir(), "belayd", "state.sqlite") });

    expect(opened).toEqual({ ok: false, absent: true, error: expect.any(String) });
  });

  it("fails closed for a store without the receipt table", async () => {
    const reader = await loadReader();
    const { path, database } = await makeStore({ receipt: false });
    database.close();

    const opened = reader.openProofReceiptReader({ path });

    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.absent).toBe(false);
      expect(opened.error).toContain("could not open");
    }
  });
});
