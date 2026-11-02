import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  DurableEntry,
  DurableLiveGeneration,
  DurableReader,
} from "../durable-member/contract.js";
import { type DurableStore, openDurableStore } from "../durable-member/standalone-store.js";
import {
  annotateLiveGeneration,
  assertReadOnlyViewer,
  DEFAULT_LIVE_STALE_AFTER_MS,
  openDurableViewer,
  reduceLiveLiveness,
} from "../durable-member/viewer.js";
import { makeStateDir, removeStateDir } from "./durable-fixtures.js";

const dirs: string[] = [];
const stores: DurableStore[] = [];

function store(): { path: string; writer: DurableStore } {
  const dir = makeStateDir();
  dirs.push(dir);
  const path = join(dir, "store.sqlite");
  const opened = openDurableStore({ path });
  if (!opened.ok) throw new Error(opened.error);
  stores.push(opened.store);
  return { path, writer: opened.store };
}

afterEach(() => {
  for (const opened of stores.splice(0)) {
    try {
      opened.close();
    } catch {
      // Already closed by the viewer path under test.
    }
  }
  for (const dir of dirs.splice(0)) removeStateDir(dir);
});

const memberId = "member-a";
const conversationId = "member-a:main";

function seed(writer: DurableStore): void {
  writer.appendEntry({
    id: "e1",
    conversationId,
    role: "user",
    kind: "message",
    timestamp: 10,
    text: "read the bead",
  });
  writer.appendEntry({
    id: "e2",
    conversationId,
    role: "assistant",
    kind: "message",
    timestamp: 20,
    text: "reading it",
  });
  writer.upsertTask({
    id: "task-1",
    title: "implement",
    status: "running",
    owner: { memberId, edge: "child" },
    waitingOn: ["task-0"],
    background: false,
  });
}

describe("reduceLiveLiveness", () => {
  const generation: DurableLiveGeneration = {
    conversationId,
    generationId: "gen-1",
    status: "streaming",
    partialText: "working",
    startedAt: 1_000,
    updatedAt: 2_000,
    attempt: 1,
    toolCalls: [],
  };

  it("reports a fresh generation as live when the owner is alive", () => {
    expect(reduceLiveLiveness({ live: generation, now: 2_500, ownerAlive: true })).toEqual({
      kind: "live",
      live: generation,
    });
  });

  it("reports a fresh generation as stale when the owner is known to be gone", () => {
    const outcome = reduceLiveLiveness({ live: generation, now: 2_500, ownerAlive: false });
    expect(outcome).toMatchObject({ kind: "stale", reason: "owner-gone" });
  });

  it("reports an old generation as stale by age even when the owner looks alive", () => {
    const outcome = reduceLiveLiveness({
      live: generation,
      now: 2_000 + DEFAULT_LIVE_STALE_AFTER_MS,
      ownerAlive: true,
    });
    expect(outcome).toMatchObject({ kind: "stale", reason: "no-heartbeat" });
  });

  it("treats an unset heartbeat as old rather than running", () => {
    // A real clock is used here on purpose: `updatedAt: 0` must never be
    // mistaken for a fresh heartbeat.
    const outcome = reduceLiveLiveness({
      live: { ...generation, updatedAt: 0 },
      now: Date.now(),
      ownerAlive: true,
    });
    expect(outcome).toMatchObject({ kind: "stale", reason: "no-heartbeat" });
  });

  it("honours a caller-supplied bound", () => {
    const input = { live: generation, now: 2_499, ownerAlive: true, staleAfterMs: 500 };
    expect(reduceLiveLiveness(input).kind).toBe("live");
    expect(reduceLiveLiveness({ ...input, now: 2_500 }).kind).toBe("stale");
  });

  it("never reports a stale generation as streaming", () => {
    for (const outcome of [
      reduceLiveLiveness({ live: generation, now: 2_500, ownerAlive: false }),
      reduceLiveLiveness({ live: generation, now: 999_999, ownerAlive: true }),
    ]) {
      expect(outcome.kind).toBe("stale");
      const annotated = annotateLiveGeneration(outcome);
      expect(annotated).toMatchObject({ stale: true });
      // The recorded status is history, not a claim: the flag is what a panel
      // reads, so a `streaming` row can never be rendered as running.
      expect(annotated?.status).toBe("streaming");
      expect(annotated?.staleReason).toMatch(/owner-gone|no-heartbeat/);
    }
  });

  it("reports nothing when the store holds no live row", () => {
    expect(reduceLiveLiveness({ live: null, now: 1, ownerAlive: true })).toEqual({ kind: "none" });
    expect(annotateLiveGeneration({ kind: "none" })).toBeNull();
  });
});

describe("openDurableViewer", () => {
  it("hands out a reader with no write members (type and runtime)", () => {
    const { path, writer } = store();
    seed(writer);
    const opened = openDurableViewer({ storePath: path, memberId, conversationId });
    if (!opened.ok) throw new Error(opened.error);

    // Type-level: a writable method on the reader is a compile error, not a
    // runtime check. (The lines below fail `pnpm typecheck` if that changes.)
    expectTypeOf<DurableReader>().not.toHaveProperty("submit");
    expectTypeOf<DurableReader>().not.toHaveProperty("resume");
    expectTypeOf<DurableReader>().not.toHaveProperty("write");

    // Runtime: the same absence is asserted for plain-JS consumers.
    expect(opened.reader).not.toHaveProperty("submit");
    expect(assertReadOnlyViewer(opened.reader)).toEqual({ ok: true });
    expect(opened.reader.memberId).toBe(memberId);
    expect(opened.reader.conversationId).toBe(conversationId);
    opened.reader.close();
  });

  it("streams the committed window and then the delta while the writer is live", async () => {
    const { path, writer } = store();
    seed(writer);
    const opened = openDurableViewer({
      storePath: path,
      memberId,
      conversationId,
      pollIntervalMs: 10,
      windowSize: 10,
      // Fixture timestamps are tiny, so the clock is pinned to them; otherwise
      // the liveness reduction would (correctly) call them decades stale.
      now: () => 40,
    });
    if (!opened.ok) throw new Error(opened.error);

    const iterator = opened.reader.conversation
      .watch({ pollIntervalMs: 10, windowSize: 10 })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.entriesWindow.map((entry: DurableEntry) => entry.id)).toEqual(["e1", "e2"]);
    expect(first.value?.hasEarlier).toBe(false);
    expect(first.value?.live).toBeNull();

    writer.appendEntry({
      id: "e3",
      conversationId,
      role: "tool",
      kind: "tool-output",
      timestamp: 30,
      text: "done",
    });
    writer.setLiveGeneration(conversationId, {
      conversationId,
      generationId: "gen-1",
      status: "streaming",
      partialText: "working",
      startedAt: 30,
      updatedAt: 40,
      attempt: 1,
      toolCalls: [],
    });

    const second = await iterator.next();
    expect(second.value?.entriesWindow.map((entry: DurableEntry) => entry.id)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(second.value?.live).toMatchObject({ generationId: "gen-1", partialText: "working" });
    expect(second.value?.live?.stale).not.toBe(true);

    opened.reader.close();
    await iterator.return?.(undefined);
  });

  it("marks a live row stale when the owner seam says it is gone", async () => {
    const { path, writer } = store();
    seed(writer);
    writer.setLiveGeneration(conversationId, {
      conversationId,
      generationId: "gen-dead",
      status: "streaming",
      partialText: "half a sentence",
      startedAt: 30,
      updatedAt: 40,
      attempt: 1,
      toolCalls: [],
    });
    const opened = openDurableViewer({
      storePath: path,
      memberId,
      conversationId,
      pollIntervalMs: 10,
      now: () => 40,
      ownerAlive: () => false,
    });
    if (!opened.ok) throw new Error(opened.error);

    const iterator = opened.reader.conversation
      .watch({ pollIntervalMs: 10 })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    // Reported, not dropped: the panel needs the last known generation.
    expect(first.value?.live).toMatchObject({
      generationId: "gen-dead",
      partialText: "half a sentence",
      stale: true,
      staleReason: "owner-gone",
    });

    opened.reader.close();
    await iterator.return?.(undefined);
  });

  it("streams the task graph with owner edge and waiting-on", async () => {
    const { path, writer } = store();
    seed(writer);
    const opened = openDurableViewer({
      storePath: path,
      memberId,
      conversationId,
      pollIntervalMs: 10,
    });
    if (!opened.ok) throw new Error(opened.error);

    const iterator = opened.reader.harness
      .watchTaskGraph({ pollIntervalMs: 10 })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.tasks).toEqual([
      {
        id: "task-1",
        title: "implement",
        status: "running",
        owner: { memberId, edge: "child" },
        waitingOn: ["task-0"],
        background: false,
      },
    ]);

    opened.reader.close();
    const ended = await iterator.next();
    expect(ended.done).toBe(true);
  });

  it("pages the transcript backwards and opens entry details", async () => {
    const { path, writer } = store();
    seed(writer);
    const opened = openDurableViewer({
      storePath: path,
      memberId,
      conversationId,
      windowSize: 1,
    });
    if (!opened.ok) throw new Error(opened.error);
    const transcript = opened.reader.transcript();

    const latest = transcript.window();
    expect(latest.entries.map((entry) => entry.id)).toEqual(["e2"]);
    expect(latest.hasEarlier).toBe(true);

    const earlier = await transcript.loadEarlier(latest.cursor ?? "");
    expect(earlier.entries.map((entry) => entry.id)).toEqual(["e1"]);
    expect(earlier.hasEarlier).toBe(false);

    expect(transcript.details("e1")).toMatchObject({
      entryId: "e1",
      entry: { text: "read the bead" },
    });
    expect(transcript.details("missing")).toBeNull();
    opened.reader.close();
  });

  it("never leaves the probe write behind", () => {
    const { path, writer } = store();
    seed(writer);
    const opened = openDurableViewer({ storePath: path, memberId, conversationId });
    if (!opened.ok) throw new Error(opened.error);
    opened.reader.close();
    expect(writer.readEntryWindow("__belayd_readonly_probe__", { limit: 10 }).entries).toHaveLength(
      0,
    );
  });

  it("rejects a fake reader that exposes a write member", () => {
    const fake = {
      memberId,
      conversationId,
      conversation: { watch: async function* () {} },
      harness: { watchTaskGraph: async function* () {} },
      transcript: () => {
        throw new Error("unused");
      },
      close: () => {},
      submit: () => {},
    } as unknown as DurableReader;

    expect(assertReadOnlyViewer(fake)).toMatchObject({ ok: false });
  });

  it("returns an error value for a missing store", () => {
    const dir = makeStateDir();
    dirs.push(dir);
    const opened = openDurableViewer({
      storePath: join(dir, "missing.sqlite"),
      memberId,
      conversationId,
    });
    expect(opened).toMatchObject({ ok: false });
  });
});
