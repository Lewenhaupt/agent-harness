// Read-only viewer process for `test/durable-readonly-viewer.integration.test.ts`
// (bd-186 two-process WAL probe).
//
// Opens the writer's database with `{ readOnly: true }`, polls while the writer
// holds its write connection, reports each observed delta, then proves the
// read-only connection rejects a write. Last stdout line is a JSON summary the
// test asserts on.
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const [dbPath] = process.argv.slice(2);
if (dbPath === undefined) {
  console.error("usage: viewer.mjs <db>");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
db.exec("PRAGMA busy_timeout = 5000");

const countEntries = db.prepare(
  "SELECT COUNT(*) AS count FROM entries WHERE conversation_id = ?",
);

let last = -1;
let observed = 0;
const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  const row = countEntries.get("member-a:main");
  const count = Number(row?.count ?? 0);
  if (count > last) {
    last = count;
    observed += 1;
    console.log(`observed ${String(count)} committed entries`);
  }
  if (count >= 5) break;
  await delay(25);
}

let writeRejected = false;
let writeError = "";
try {
  db.prepare(
    `INSERT INTO entries (id, conversation_id, role, kind, timestamp, text, payload)
     VALUES ('viewer-write', 'member-a:main', 'user', 'message', 0, 'should not land', '{}')`,
  ).run();
} catch (error) {
  writeRejected = true;
  writeError = error instanceof Error ? error.message : String(error);
}

const afterWrite = Number(countEntries.get("member-a:main")?.count ?? 0);
db.close();
console.log(JSON.stringify({ observed, last, afterWrite, writeRejected, writeError }));
