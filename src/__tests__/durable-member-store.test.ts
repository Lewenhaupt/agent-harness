import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadOnlySessionError } from "../durable-member/contract.js";
import type { DurableEntryInput } from "../durable-member/standalone-store.js";
import { openDurableStore } from "../durable-member/standalone-store.js";
import { makeStateDir, removeStateDir } from "./durable-fixtures.js";

const dirs: string[] = [];

function storePath(): string {
  const dir = makeStateDir();
  dirs.push(dir);
  return join(dir, "store.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeStateDir(dir);
});

const conversationId = "member-a:main";

function entry(id: string, timestamp: number, text: string): DurableEntryInput {
  return {
    id,
    conversationId,
    role: "assistant",
    kind: "message",
    timestamp,
    text,
  };
}

describe("reference durable store", () => {
  it("stores entries, returns them oldest-first, and pages backwards by cursor", () => {
    const opened = openDurableStore({ path: storePath() });
    if (!opened.ok) throw new Error(opened.error);
    const store = opened.store;

    store.appendEntry(entry("e1", 10, "one"));
    store.appendEntry(entry("e2", 20, "two"));
    store.appendEntry(entry("e3", 30, "three"));

    const latest = store.readEntryWindow(conversationId, { limit: 2 });
    expect(latest.entries.map((row) => row.id)).toEqual(["e2", "e3"]);
    expect(latest.cursor).toBe(latest.entries[0]?.cursor);
    expect(latest.hasEarlier).toBe(true);

    const earlier = store.readEntryWindow(conversationId, {
      before: latest.cursor,
      limit: 2,
    });
    expect(earlier.entries.map((row) => row.id)).toEqual(["e1"]);
    expect(earlier.hasEarlier).toBe(false);

    store.close();
  });

  it("upserts an entry by id so a re-sent entry updates instead of duplicating", () => {
    const opened = openDurableStore({ path: storePath() });
    if (!opened.ok) throw new Error(opened.error);
    const store = opened.store;

    store.appendEntry(entry("e1", 10, "partial"));
    store.appendEntry(entry("e1", 10, "complete"));

    const window = store.readEntryWindow(conversationId, { limit: 10 });
    expect(window.entries).toHaveLength(1);
    expect(window.entries[0]?.text).toBe("complete");
    store.close();
  });

  it("round-trips the live generation scratch row and clears it with null", () => {
    const opened = openDurableStore({ path: storePath() });
    if (!opened.ok) throw new Error(opened.error);
    const store = opened.store;

    expect(store.readLiveGeneration(conversationId)).toBeNull();
    store.setLiveGeneration(conversationId, {
      conversationId,
      generationId: "gen-1",
      status: "tool-call",
      partialText: "thinking",
      startedAt: 100,
      updatedAt: 200,
      attempt: 2,
      toolCalls: [
        { callId: "call-1", name: "read", input: { path: "a" }, output: "a", status: "done" },
      ],
      retry: { attempt: 2, maxAttempts: 3, reason: "rate limited" },
      runFailure: { message: "boom", code: "E_BOOM" },
    });

    expect(store.readLiveGeneration(conversationId)).toMatchObject({
      generationId: "gen-1",
      status: "tool-call",
      partialText: "thinking",
      attempt: 2,
      toolCalls: [{ callId: "call-1", name: "read", output: "a", status: "done" }],
      retry: { attempt: 2, reason: "rate limited" },
      runFailure: { message: "boom", code: "E_BOOM" },
    });

    store.setLiveGeneration(conversationId, null);
    expect(store.readLiveGeneration(conversationId)).toBeNull();
    store.close();
  });

  it("round-trips the task graph with owner edge, waiting-on and background flags", () => {
    const opened = openDurableStore({ path: storePath() });
    if (!opened.ok) throw new Error(opened.error);
    const store = opened.store;

    store.upsertTask({
      id: "task-2",
      title: "implement",
      status: "blocked",
      owner: { memberId: "member-a", edge: "child" },
      waitingOn: ["task-1"],
      background: true,
    });
    store.upsertTask({
      id: "task-1",
      title: "scout",
      status: "done",
      waitingOn: [],
      background: false,
    });

    expect(store.readTaskGraph()).toEqual([
      {
        id: "task-1",
        title: "scout",
        status: "done",
        waitingOn: [],
        background: false,
      },
      {
        id: "task-2",
        title: "implement",
        status: "blocked",
        owner: { memberId: "member-a", edge: "child" },
        waitingOn: ["task-1"],
        background: true,
      },
    ]);
    store.close();
  });

  it("returns tool details for one entry and null for an unknown id", () => {
    const opened = openDurableStore({ path: storePath() });
    if (!opened.ok) throw new Error(opened.error);
    const store = opened.store;

    store.appendEntry({
      id: "e-tool",
      conversationId,
      role: "tool",
      kind: "tool-output",
      timestamp: 10,
      text: "3 files",
      toolCall: { name: "read", input: { path: "src" } },
      toolOutput: { name: "read", output: "3 files", details: { bytes: 42 }, callId: "call-1" },
    });

    const details = store.readEntryDetails("e-tool");
    expect(details).toMatchObject({
      entryId: "e-tool",
      toolCall: { name: "read", input: { path: "src" } },
      toolOutput: { name: "read", output: "3 files", details: { bytes: 42 }, callId: "call-1" },
    });
    expect(store.readEntryDetails("missing")).toBeNull();
    store.close();
  });

  it("resumes a conversation the store knows", () => {
    const opened = openDurableStore({ path: storePath() });
    if (!opened.ok) throw new Error(opened.error);
    const store = opened.store;
    store.appendEntry(entry("e1", 10, "one"));
    expect(() => store.resume(conversationId)).not.toThrow();
    expect(() => store.resume("unknown")).toThrow();
    store.close();
  });

  it("rejects every write and resume() on a readOnly handle", () => {
    const path = storePath();
    const writable = openDurableStore({ path });
    if (!writable.ok) throw new Error(writable.error);
    writable.store.appendEntry(entry("e1", 10, "one"));
    writable.store.upsertTask({
      id: "task-1",
      title: "scout",
      status: "done",
      waitingOn: [],
      background: false,
    });
    writable.store.close();

    const opened = openDurableStore({ path, readOnly: true });
    if (!opened.ok) throw new Error(opened.error);
    const store = opened.store;
    expect(store.readOnly).toBe(true);
    expect(() => store.appendEntry(entry("e2", 20, "two"))).toThrow(ReadOnlySessionError);
    expect(() =>
      store.setLiveGeneration(conversationId, {
        conversationId,
        generationId: "gen-1",
        status: "idle",
        partialText: "",
        startedAt: 0,
        updatedAt: 0,
        attempt: 0,
        toolCalls: [],
      }),
    ).toThrow(ReadOnlySessionError);
    expect(() =>
      store.upsertTask({
        id: "task-2",
        title: "implement",
        status: "pending",
        waitingOn: [],
        background: false,
      }),
    ).toThrow(ReadOnlySessionError);
    expect(() => store.resume(conversationId)).toThrow(ReadOnlySessionError);

    // Reads keep working, and the refused writes left no trace.
    expect(
      store.readEntryWindow(conversationId, { limit: 10 }).entries.map((row) => row.id),
    ).toEqual(["e1"]);
    expect(store.readTaskGraph()).toHaveLength(1);
    store.close();
  });

  it("fails as an error value when the readOnly file does not exist", () => {
    const opened = openDurableStore({ path: join(storePath(), "missing.sqlite"), readOnly: true });
    expect(opened).toMatchObject({ ok: false });
  });

  it("rejects a non-numeric cursor instead of reading the wrong page", () => {
    const opened = openDurableStore({ path: storePath() });
    if (!opened.ok) throw new Error(opened.error);
    opened.store.appendEntry(entry("e1", 10, "one"));
    expect(() => opened.store.readEntryWindow(conversationId, { before: "not-a-cursor" })).toThrow(
      /invalid transcript cursor/,
    );
    opened.store.close();
  });
});
