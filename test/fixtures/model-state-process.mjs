// Cross-process fixture for the shared model-state store (bd-187).
//
// The subject is cross-PROCESS behaviour (one cooldown window, a lease left by a
// killed daemon), not our TypeScript modules, so this fixture talks to SQLite
// directly: it must run without a TypeScript build step. The table and column
// names below are the store's schema contract; the unit suite
// (`src/__tests__/model-state-store.test.ts`) pins the same names, so a schema
// change fails there before it can silently orphan this fixture.
//
// Modes:
//   write-cooldown <db> <duration-ms> <until-file>
//   read-cooldown  <db> <until-file>            (polls, prints the row as JSON)
//   crash-lease    <db> <ttl-ms> <ready-file>   (reserves, then SIGKILLs itself)
//   hold-lease     <db> <ttl-ms> <interval-ms> <progress-file> <release-file>
//                  (holds one lease, renews it on a heartbeat past the ORIGINAL
//                   ttl, then frees it when <release-file> appears)
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [dbPath, mode, ...rest] = process.argv.slice(2);
if (dbPath === undefined || mode === undefined) {
  console.error("usage: model-state-process.mjs <db> <mode> ...");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { timeout: 5000 });
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS cooldown (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  retry_after_ms INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
CREATE TABLE IF NOT EXISTS capacity (
  provider TEXT NOT NULL,
  class TEXT NOT NULL,
  "limit" INTEGER NOT NULL,
  in_use INTEGER NOT NULL,
  PRIMARY KEY (provider, class)
);
CREATE TABLE IF NOT EXISTS lease (
  lease_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  class TEXT NOT NULL,
  daemon_pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
);
`);

function readCooldown(provider, model) {
  const row = db
    .prepare(
      `SELECT provider, model, until_ms, reason, retry_after_ms
         FROM cooldown
        WHERE provider = ? AND model = ?
        LIMIT 1`,
    )
    .get(provider, model);
  return row === undefined ? null : { ...row };
}

switch (mode) {
  case "write-cooldown": {
    const [durationArg, untilFile] = rest;
    const durationMs = Number(durationArg);
    const untilMs = Date.now() + durationMs;
    db.prepare(
      `INSERT INTO cooldown (provider, model, until_ms, reason, retry_after_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider, model) DO UPDATE SET
         until_ms = excluded.until_ms,
         reason = excluded.reason,
         retry_after_ms = excluded.retry_after_ms`,
    ).run("llmgateway", "shared-model", untilMs, "cross-process 429", durationMs);
    writeFileSync(untilFile, JSON.stringify({ until_ms: untilMs }));
    db.close();
    break;
  }

  case "read-cooldown": {
    const [untilFile] = rest;
    const deadline = Date.now() + 5000;
    let row = null;
    while (Date.now() < deadline) {
      row = readCooldown("llmgateway", "shared-model");
      if (row !== null) break;
      // A spin is fine here: the writer commits in a separate process and the
      // parent asserts we observed the same window, not our polling cadence.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    writeFileSync(untilFile, JSON.stringify({ row }));
    db.close();
    break;
  }

  case "crash-lease": {
    const [ttlArg, readyFile] = rest;
    const expiresMs = Date.now() + Number(ttlArg);
    db.prepare(
      `INSERT INTO capacity (provider, class, "limit", in_use) VALUES (?, ?, ?, ?)
       ON CONFLICT(provider, class) DO UPDATE SET "limit" = excluded."limit"`,
    ).run("llmgateway", "standard", 1, 1);
    db.prepare(
      `INSERT OR REPLACE INTO lease (lease_id, provider, class, daemon_pid, host, expires_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("crashed-lease", "llmgateway", "standard", process.pid, "crash-fixture", expiresMs);
    writeFileSync(readyFile, JSON.stringify({ expires_ms: expiresMs }));
    // No close(), no checkpoint: the point is that SQLite recovers the committed
    // lease and that only its expires_ms can free the slot.
    process.kill(process.pid, "SIGKILL");
    break;
  }

  case "hold-lease": {
    const [ttlArg, intervalArg, progressFile, releaseFile] = rest;
    if (
      ttlArg === undefined ||
      intervalArg === undefined ||
      progressFile === undefined ||
      releaseFile === undefined
    ) {
      console.error("usage: hold-lease <db> <ttl-ms> <interval-ms> <progress-file> <release-file>");
      process.exit(2);
    }
    const ttlMs = Number(ttlArg);
    const intervalMs = Number(intervalArg);
    const leaseId = "held-lease";
    const host = "hold-fixture";
    const startedMs = Date.now();
    let renewals = 0;
    const writeProgress = (released) => {
      writeFileSync(
        progressFile,
        JSON.stringify({ renewals, released, pid: process.pid, started_ms: startedMs }),
      );
    };
    db.prepare(
      `INSERT INTO capacity (provider, class, "limit", in_use) VALUES (?, ?, 1, 1)
       ON CONFLICT(provider, class) DO UPDATE SET "limit" = 1, in_use = 1`,
    ).run("llmgateway", "standard");
    db.prepare(
      `INSERT OR REPLACE INTO lease (lease_id, provider, class, daemon_pid, host, expires_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(leaseId, "llmgateway", "standard", process.pid, host, startedMs + ttlMs);
    writeProgress(false);

    const heartbeat = setInterval(() => {
      const updated = db
        .prepare(
          `UPDATE lease SET expires_ms = ?
            WHERE lease_id = ? AND provider = ? AND class = ? AND host = ? AND daemon_pid = ?`,
        )
        .run(Date.now() + ttlMs, leaseId, "llmgateway", "standard", host, process.pid);
      if (Number(updated.changes) === 0) return;
      renewals += 1;
      writeProgress(false);
    }, intervalMs);

    const waitForRelease = setInterval(() => {
      if (!existsSync(releaseFile)) return;
      clearInterval(waitForRelease);
      clearInterval(heartbeat);
      db.prepare(
        `DELETE FROM lease WHERE lease_id = ? AND provider = ? AND class = ? AND host = ? AND daemon_pid = ?`,
      ).run(leaseId, "llmgateway", "standard", host, process.pid);
      db.prepare("UPDATE capacity SET in_use = 0 WHERE provider = ? AND class = ?").run(
        "llmgateway",
        "standard",
      );
      writeProgress(true);
      db.close();
      process.exit(0);
    }, 25);
    break;
  }

  default: {
    console.error(`unknown mode ${mode}`);
    process.exit(2);
  }
}

export {};
