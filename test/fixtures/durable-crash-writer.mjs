// Crash writer process for the "crashed member" cases of
// `test/durable-readonly-viewer.integration.test.ts` (bd-186: "a crashed
// member's last committed state still renders after restart").
//
// Same rationale as the WAL probe fixtures: the subject is SQLite's recovery of
// committed rows after an unclean exit, not our TypeScript modules, so this must
// run without a TS toolchain. It inserts a few entries, signals readiness, and
// then kills itself with SIGKILL — no `close()`, no checkpoint, no flush.
//
// With `--live` it also commits a live-generation row immediately before dying,
// which is the case that leaves `status: "streaming"` behind forever unless the
// reader decides liveness itself.
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [dbPath, readyPath, ...flags] = process.argv.slice(2);
if (dbPath === undefined || readyPath === undefined) {
  console.error("usage: crash-writer.mjs <db> <ready-file> [--live]");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { timeout: 5000 });
db.exec("PRAGMA busy_timeout = 5000");
const insert = db.prepare(
  `INSERT INTO entries (id, conversation_id, role, kind, timestamp, text, payload)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

for (let index = 1; index <= 3; index += 1) {
  insert.run(
    `c-${String(index)}`,
    "member-a:main",
    "assistant",
    "message",
    index,
    `committed entry ${String(index)}`,
    "{}",
  );
}

if (flags.includes("--live")) {
  db.prepare(
    `INSERT INTO live_generations (conversation_id, payload) VALUES (?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET payload = excluded.payload`,
  ).run(
    "member-a:main",
    JSON.stringify({
      conversationId: "member-a:main",
      generationId: "gen-crash",
      status: "streaming",
      partialText: "about to die",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      attempt: 1,
      toolCalls: [],
    }),
  );
}

writeFileSync(readyPath, "committed\n");
process.kill(process.pid, "SIGKILL");
