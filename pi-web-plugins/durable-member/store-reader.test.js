import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDurableStoreReader } from "./store-reader.js";

/**
 * The plugin's store reader (bd-186).
 *
 * Schema parity with `src/durable-member/standalone-store.ts` is asserted in
 * `src/__tests__/durable-member-contract-parity.test.ts`; here the SQL is written
 * out by hand so this test keeps working (and fails loudly) even if the reader's
 * own setup code changes. The invariant under test is that the reader has no
 * write path at all.
 */

const dirs = [];

function fixtureDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "belayd-durable-reader-"));
  dirs.push(dir);
  const path = join(dir, "store.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE live_generations (conversation_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE task_nodes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  `);
  const insert = database.prepare(
    `INSERT INTO entries (id, conversation_id, role, kind, timestamp, text, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("e1", "member-a:main", "user", "message", 10, "read the bead", "{}");
  insert.run(
    "e2",
    "member-a:main",
    "tool",
    "tool-output",
    20,
    "3 files",
    JSON.stringify({
      toolCall: { name: "read", input: { path: "src" } },
      toolOutput: { name: "read", output: "3 files", details: { bytes: 42 }, callId: "call-1" },
    }),
  );
  insert.run(
    "e3",
    "member-a:main",
    "system",
    "compaction",
    30,
    "summarized",
    JSON.stringify({ compaction: { summaryId: "sum-1", tokensBefore: 1200, tokensAfter: 400 } }),
  );
  database
    .prepare("INSERT INTO live_generations (conversation_id, payload) VALUES (?, ?)")
    .run(
      "member-a:main",
      JSON.stringify({
        conversationId: "member-a:main",
        generationId: "gen-1",
        status: "retrying",
        partialText: "thinking",
        startedAt: 100,
        updatedAt: 200,
        attempt: 2,
        toolCalls: [
          { callId: "call-2", name: "edit", input: { file: "a" }, output: "ok", status: "done" },
        ],
        retry: { attempt: 2, maxAttempts: 3, reason: "rate limited" },
      }),
    );
  const task = database.prepare("INSERT INTO task_nodes (id, payload) VALUES (?, ?)");
  task.run(
    "task-1",
    JSON.stringify({
      id: "task-1",
      title: "scout",
      status: "done",
      waitingOn: [],
      background: false,
    }),
  );
  task.run(
    "task-2",
    JSON.stringify({
      id: "task-2",
      title: "implement",
      status: "blocked",
      owner: { memberId: "member-a", edge: "child" },
      waitingOn: ["task-1"],
      background: true,
    }),
  );
  database.close();
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("openDurableStoreReader", () => {
  it("opens read-only and exposes reads only", () => {
    const opened = openDurableStoreReader({ path: fixtureDatabase() });
    expect(opened.ok).toBe(true);
    expect(opened.store.readOnly).toBe(true);
    for (const writeMember of ["appendEntry", "setLiveGeneration", "upsertTask", "resume"]) {
      expect(opened.store[writeMember]).toBeUndefined();
    }
    opened.store.close();
  });

  it("reads an ordered window and pages backwards by cursor", () => {
    const opened = openDurableStoreReader({ path: fixtureDatabase() });
    if (!opened.ok) throw new Error(opened.error);
    const latest = opened.store.readEntryWindow("member-a:main", { limit: 2 });
    expect(latest.entries.map((row) => row.id)).toEqual(["e2", "e3"]);
    expect(latest.cursor).toBe(latest.entries[0].cursor);
    expect(latest.hasEarlier).toBe(true);

    const earlier = opened.store.readEntryWindow("member-a:main", {
      before: latest.cursor,
      limit: 2,
    });
    expect(earlier.entries.map((row) => row.id)).toEqual(["e1"]);
    expect(earlier.hasEarlier).toBe(false);
    opened.store.close();
  });

  it("reads the live generation, task graph and entry details", () => {
    const opened = openDurableStoreReader({ path: fixtureDatabase() });
    if (!opened.ok) throw new Error(opened.error);

    expect(opened.store.readLiveGeneration("member-a:main")).toMatchObject({
      generationId: "gen-1",
      status: "retrying",
      partialText: "thinking",
      attempt: 2,
      toolCalls: [{ callId: "call-2", name: "edit", output: "ok", status: "done" }],
      retry: { attempt: 2, reason: "rate limited" },
    });
    expect(opened.store.readTaskGraph().map((task) => task.id)).toEqual(["task-1", "task-2"]);
    expect(opened.store.readTaskGraph()[1]).toMatchObject({
      owner: { memberId: "member-a", edge: "child" },
      waitingOn: ["task-1"],
      background: true,
    });
    expect(opened.store.readEntryDetails("e2")).toMatchObject({
      entryId: "e2",
      toolCall: { name: "read", input: { path: "src" } },
      toolOutput: { name: "read", output: "3 files", details: { bytes: 42 }, callId: "call-1" },
    });
    expect(opened.store.readEntryDetails("missing")).toBeNull();
    opened.store.close();
  });

  it("returns an error value for a missing database", () => {
    const opened = openDurableStoreReader({ path: join(tmpdir(), "belayd-no-such-store.sqlite") });
    expect(opened).toMatchObject({ ok: false });
  });

  it("rejects a non-numeric cursor", () => {
    const opened = openDurableStoreReader({ path: fixtureDatabase() });
    if (!opened.ok) throw new Error(opened.error);
    expect(() => opened.store.readEntryWindow("member-a:main", { before: "nope" })).toThrow(
      /invalid transcript cursor/,
    );
    opened.store.close();
  });
});
