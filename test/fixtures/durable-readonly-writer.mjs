// Reference-store writer process for `test/durable-readonly-viewer.integration.test.ts`
// (bd-186 two-process WAL probe).
//
// Deliberately plain JS and raw SQL: the probe's subject is SQLite's WAL
// single-writer/multi-reader behaviour, not our TypeScript modules, so this
// process must not need a TS toolchain. The column list below is the reference
// store's schema (`src/durable-member/standalone-store.ts`); the parity test
// reads fixture rows through both implementations, so a schema drift fails there
// even if this script kept working.
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const [dbPath, readyPath, donePath] = process.argv.slice(2);
if (dbPath === undefined || readyPath === undefined || donePath === undefined) {
  console.error("usage: writer.mjs <db> <ready-file> <done-file>");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { timeout: 5000 });
db.exec("PRAGMA busy_timeout = 5000");
const insert = db.prepare(
  `INSERT INTO entries (id, conversation_id, role, kind, timestamp, text, payload)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET text = excluded.text`,
);

for (let index = 1; index <= 5; index += 1) {
  insert.run(
    `w-${String(index)}`,
    "member-a:main",
    "assistant",
    "message",
    Date.now(),
    `writer entry ${String(index)}`,
    "{}",
  );
  if (index === 1) writeFileSync(readyPath, "ready\n");
  // Slow enough for the read-only viewer to observe several deltas from its own
  // process while this write connection stays open.
  await delay(80);
}

writeFileSync(donePath, "done\n");
// Hold the write connection open until the parent kills this process, so the
// viewer's read-only connection must coexist with a live writer.
while (true) {
  await delay(100);
}
