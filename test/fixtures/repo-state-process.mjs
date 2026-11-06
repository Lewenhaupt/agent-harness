// Cross-process fixture for the per-repository execution state store (bd-281).
//
// The subject is cross-PROCESS behaviour (one lease winner, no lost update), not
// our TypeScript modules, so this fixture talks to SQLite directly: it must run
// without a TypeScript build step. The table and column names below are the
// store's schema contract; `src/__tests__/repo-state-store.test.ts` pins the same
// names, so a schema change fails there before it can silently orphan this
// fixture.
//
// Modes:
//   claim-lease   <db> <task> <session> <worktree> <start-file>
//                 (waits for <start-file>, then claims the orchestrator lease in
//                  one BEGIN IMMEDIATE and prints won:<session> or lost:<holder>)
//   append-phase  <db> <task> <phase> <start-file>
//                 (waits for <start-file>, then appends one completed phase with a
//                  read-modify-write inside BEGIN IMMEDIATE)
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [dbPath, mode, ...rest] = process.argv.slice(2);
if (dbPath === undefined || mode === undefined) {
  console.error("usage: repo-state-process.mjs <db> <mode> ...");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { timeout: 5000 });
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS workflow_state (
  task_id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL DEFAULT '',
  resolution_source TEXT,
  matched_label TEXT,
  branch TEXT NOT NULL DEFAULT '',
  original_cwd TEXT NOT NULL DEFAULT '',
  phase_order TEXT NOT NULL DEFAULT '[]',
  completed_phase_names TEXT NOT NULL DEFAULT '[]',
  phase_sessions TEXT,
  awaiting_review_response INTEGER,
  reviewed_sha TEXT,
  reviewed_untracked TEXT,
  handed_off_to TEXT,
  awaiting_human TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orchestrator_lease (
  task_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  worktree_path TEXT NOT NULL,
  pid INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1
);
`);

function waitForFile(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
  }
  throw new Error(`timed out waiting for ${String(path)}`);
}

function inTransaction(body) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = body();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction is already gone */
    }
    throw error;
  }
}

if (mode === "claim-lease") {
  const [task, session, worktree, startFile] = rest;
  waitForFile(startFile);
  const now = Date.now();
  const outcome = inTransaction(() => {
    const holder = db
      .prepare(
        `SELECT session_id, expires_at FROM orchestrator_lease
          WHERE task_id = ? OR worktree_path = ?
          ORDER BY heartbeat_at DESC LIMIT 1`,
      )
      .get(task, worktree);
    if (holder !== undefined && holder.expires_at > now && holder.session_id !== session) {
      return `lost:${holder.session_id}`;
    }
    db.prepare(
      `INSERT INTO orchestrator_lease (
         task_id, session_id, branch, worktree_path, pid, claimed_at, heartbeat_at,
         expires_at, generation
       ) VALUES (?, ?, '', ?, 0, ?, ?, ?, 1)
       ON CONFLICT(task_id) DO UPDATE SET
         session_id = excluded.session_id,
         worktree_path = excluded.worktree_path,
         heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at,
         generation = orchestrator_lease.generation + 1`,
    ).run(task, session, worktree, now, now, now + 180_000);
    db.prepare("DELETE FROM orchestrator_lease WHERE worktree_path = ? AND task_id <> ?").run(
      worktree,
      task,
    );
    return `won:${session}`;
  });
  process.stdout.write(`${outcome}\n`);
  process.exit(0);
}

if (mode === "append-phase") {
  const [task, phase, startFile] = rest;
  waitForFile(startFile);
  inTransaction(() => {
    const row = db
      .prepare("SELECT completed_phase_names FROM workflow_state WHERE task_id = ?")
      .get(task);
    const current = row === undefined ? [] : JSON.parse(row.completed_phase_names);
    const next = [...current, phase];
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflow_state (task_id, phase_order, completed_phase_names, started_at, updated_at)
       VALUES (?, '[]', ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         completed_phase_names = excluded.completed_phase_names,
         updated_at = excluded.updated_at,
         generation = workflow_state.generation + 1`,
    ).run(task, JSON.stringify(next), now, now);
    return next;
  });
  process.stdout.write("ok\n");
  process.exit(0);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
