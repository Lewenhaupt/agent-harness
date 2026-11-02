#!/usr/bin/env node
// Seeds a reference durable-member storage so the panel can be screenshotted (or
// demoed) with no live member and no pi-durable install (bd-186).
//
// Usage:
//   node pi-web-plugins/durable-member/fixtures/seed-member.mjs [membersRoot] [memberId]
//
// Defaults to `$BELAYD_DURABLE_MEMBERS_DIR` or `~/.pi-web/durable-members` and a
// `bd-186-fixture` member. The SQL below is the reference-store schema
// (`src/durable-member/standalone-store.ts`); `store-reader.js` reads exactly
// these tables. The fixture is a fixture, not a durability claim.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const membersRoot =
  process.argv[2] ?? process.env.BELAYD_DURABLE_MEMBERS_DIR ?? join(homedir(), ".pi-web", "durable-members");
const memberId = process.argv[3] ?? "bd-186-fixture";
const memberDir = join(membersRoot, memberId);
const conversationId = `${memberId}:main`;

mkdirSync(join(memberDir, "receipts"), { recursive: true });
writeFileSync(
  join(memberDir, "member.json"),
  `${JSON.stringify({ conversationId, label: "bd-186 fixture" })}\n`,
);

const database = new DatabaseSync(join(memberDir, "store.sqlite"));
database.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS entries_conversation_seq ON entries (conversation_id, seq);
  CREATE TABLE IF NOT EXISTS live_generations (conversation_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS task_nodes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  DELETE FROM entries;
  DELETE FROM live_generations;
  DELETE FROM task_nodes;
`);

const base = Date.now() - 60_000;
const insert = database.prepare(
  `INSERT INTO entries (id, conversation_id, role, kind, timestamp, text, payload)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

insert.run(
  "fixture-1",
  conversationId,
  "user",
  "message",
  base,
  "Implement bd-186: observe and steer durable members.",
  "{}",
);
insert.run(
  "fixture-2",
  conversationId,
  "assistant",
  "message",
  base + 1_000,
  "Reading the bead, then the pi-web plugin contract.",
  "{}",
);
insert.run(
  "fixture-3",
  conversationId,
  "assistant",
  "tool-call",
  base + 2_000,
  "",
  JSON.stringify({ toolCall: { name: "read", input: { path: "node_modules/@jmfederico/pi-web/dist/plugin-api.d.ts" } } }),
);
insert.run(
  "fixture-4",
  conversationId,
  "tool",
  "tool-output",
  base + 3_000,
  "Read 812 lines",
  JSON.stringify({
    toolOutput: { name: "read", output: "Read 812 lines", details: { bytes: 41_233, lines: 812 }, callId: "call-1" },
  }),
);
insert.run(
  "fixture-5",
  conversationId,
  "system",
  "retry",
  base + 4_000,
  "provider rate limited; retrying in 2s",
  JSON.stringify({ retry: { attempt: 2, maxAttempts: 3, reason: "429 rate limited" } }),
);
insert.run(
  "fixture-6",
  conversationId,
  "system",
  "compaction",
  base + 5_000,
  "compacted the transcript",
  JSON.stringify({ compaction: { summaryId: "sum-1", tokensBefore: 82_000, tokensAfter: 21_000 } }),
);
insert.run(
  "fixture-7",
  conversationId,
  "assistant",
  "message",
  base + 6_000,
  "The plugin declares browser apiVersion 5 so the panel gets `context.backend`.",
  "{}",
);

database
  .prepare("INSERT INTO live_generations (conversation_id, payload) VALUES (?, ?)")
  .run(
    conversationId,
    JSON.stringify({
      conversationId,
      generationId: "gen-fixture",
      status: "tool-call",
      partialText: "Writing the contract parity test…",
      startedAt: base + 7_000,
      // The heartbeat is now, not the historical transcript time: a reader
      // stales a live row older than its bound (30 s), and a screenshot fixture
      // must render as a running member.
      updatedAt: Date.now(),
      attempt: 2,
      retry: { attempt: 2, maxAttempts: 3, reason: "429 rate limited" },
      toolCalls: [
        {
          callId: "call-2",
          name: "write",
          input: { path: "src/__tests__/durable-member-contract-parity.test.ts" },
          status: "running",
        },
      ],
    }),
  );

const task = database.prepare("INSERT INTO task_nodes (id, payload) VALUES (?, ?)");
task.run(
  "bd-186-scout",
  JSON.stringify({
    id: "bd-186-scout",
    title: "scout the pi-web plugin contract",
    status: "done",
    waitingOn: [],
    background: false,
  }),
);
task.run(
  "bd-186-implement",
  JSON.stringify({
    id: "bd-186-implement",
    title: "implement the panel and control plane",
    status: "running",
    owner: { memberId, edge: "child" },
    waitingOn: ["bd-186-scout"],
    background: false,
  }),
);
task.run(
  "bd-186-proof",
  JSON.stringify({
    id: "bd-186-proof",
    title: "capture the panel screenshot",
    status: "blocked",
    owner: { memberId, edge: "child" },
    waitingOn: ["bd-186-implement"],
    background: true,
  }),
);
database.close();

writeFileSync(
  join(memberDir, "receipts", "fixture-request.json"),
  `${JSON.stringify({
    requestId: "fixture-request",
    memberId,
    kind: "steer",
    appliedAt: base + 7_500,
    ok: true,
    duplicate: false,
  })}\n`,
);

console.log(`seeded durable member ${memberId} at ${memberDir}`);
console.log(`point the plugin at it with: ${"BELAYD_DURABLE_MEMBERS_DIR"}=${membersRoot}`);
