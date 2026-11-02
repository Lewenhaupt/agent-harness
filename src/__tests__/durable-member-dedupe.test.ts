import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDedupeLedger, DEDUPE_LEDGER_FILE } from "../durable-member/dedupe.js";
import { makeStateDir, removeStateDir } from "./durable-fixtures.js";

const stateDirs: string[] = [];

function stateDir(): string {
  const dir = makeStateDir();
  stateDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of stateDirs.splice(0)) removeStateDir(dir);
});

describe("createDedupeLedger", () => {
  it("replays the ledger on start so a retry after a restart still dedupes", () => {
    const dir = stateDir();
    const first = createDedupeLedger({ stateDir: dir });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.ledger.has("req-1")).toBe(false);
    expect(first.ledger.record({ requestId: "req-1", kind: "steer", appliedAt: 10 })).toEqual({
      ok: true,
      pruned: 0,
    });

    const restarted = createDedupeLedger({ stateDir: dir });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.ledger.has("req-1")).toBe(true);
    expect(restarted.ledger.size()).toBe(1);
    expect(restarted.ledger.entries()).toEqual([
      { requestId: "req-1", kind: "steer", appliedAt: 10 },
    ]);
  });

  it("treats a repeated record as idempotent and does not append twice", () => {
    const dir = stateDir();
    const opened = createDedupeLedger({ stateDir: dir });
    if (!opened.ok) throw new Error(opened.error);

    opened.ledger.record({ requestId: "req-1", kind: "steer", appliedAt: 10 });
    opened.ledger.record({ requestId: "req-1", kind: "steer", appliedAt: 20 });

    expect(opened.ledger.size()).toBe(1);
    const lines = readFileSync(join(dir, DEDUPE_LEDGER_FILE), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ requestId: "req-1", appliedAt: 10 });
  });

  it("prunes deterministically under the cap and rewrites the ledger from the retained set", () => {
    const dir = stateDir();
    const opened = createDedupeLedger({ stateDir: dir, maxEntries: 3 });
    if (!opened.ok) throw new Error(opened.error);

    for (let index = 1; index <= 5; index += 1) {
      const result = opened.ledger.record({
        requestId: `req-${index}`,
        kind: "steer",
        appliedAt: index,
      });
      expect(result.ok).toBe(true);
    }

    expect(opened.ledger.size()).toBe(3);
    expect(opened.ledger.entries().map((record) => record.requestId)).toEqual([
      "req-3",
      "req-4",
      "req-5",
    ]);

    const replayed = createDedupeLedger({ stateDir: dir, maxEntries: 3 });
    if (!replayed.ok) throw new Error(replayed.error);
    expect(replayed.ledger.entries().map((record) => record.requestId)).toEqual([
      "req-3",
      "req-4",
      "req-5",
    ]);
    const lines = readFileSync(join(dir, DEDUPE_LEDGER_FILE), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(3);
  });

  it("skips malformed ledger lines instead of trusting them", () => {
    const dir = stateDir();
    const path = join(dir, DEDUPE_LEDGER_FILE);
    writeFileSync(
      path,
      [
        JSON.stringify({ requestId: "req-1", kind: "steer", appliedAt: 1 }),
        "not json",
        JSON.stringify({ requestId: "", kind: "steer", appliedAt: 2 }),
        JSON.stringify({ requestId: "req-2", kind: "teleport", appliedAt: 3 }),
        JSON.stringify({ requestId: "req-3", kind: "abort", appliedAt: 4 }),
        "",
      ].join("\n"),
    );

    const opened = createDedupeLedger({ stateDir: dir });
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.ledger.entries().map((record) => record.requestId)).toEqual(["req-1", "req-3"]);
  });

  it("rejects a state dir that is not writable", () => {
    const dir = stateDir();
    // The file at `stateDir` makes the append path fail: dedupe must not
    // silently degrade to "always apply".
    writeFileSync(join(dir, "blocker"), "");
    const opened = createDedupeLedger({ stateDir: join(dir, "blocker") });
    expect(opened).toMatchObject({ ok: false });
  });
});

describe("createDedupeLedger tombstones", () => {
  it("keeps recently pruned request ids deduplicated, across a restart", () => {
    const dir = stateDir();
    const opened = createDedupeLedger({ stateDir: dir, maxEntries: 2, tombstoneEntries: 2 });
    if (!opened.ok) throw new Error(opened.error);

    for (let index = 1; index <= 3; index += 1) {
      opened.ledger.record({ requestId: `req-${index}`, kind: "steer", appliedAt: index });
    }

    // req-1 fell out of the applied window but stays deduplicated as a tombstone.
    expect(opened.ledger.entries().map((record) => record.requestId)).toEqual(["req-2", "req-3"]);
    expect(opened.ledger.tombstones().map((record) => record.requestId)).toEqual(["req-1"]);
    expect(opened.ledger.has("req-1")).toBe(true);

    const replayed = createDedupeLedger({
      stateDir: dir,
      maxEntries: 2,
      tombstoneEntries: 2,
    });
    if (!replayed.ok) throw new Error(replayed.error);
    expect(replayed.ledger.has("req-1")).toBe(true);

    // The tombstone window is bounded too: two more applies push req-1 out.
    replayed.ledger.record({ requestId: "req-4", kind: "steer", appliedAt: 4 });
    replayed.ledger.record({ requestId: "req-5", kind: "steer", appliedAt: 5 });
    expect(replayed.ledger.tombstones().map((record) => record.requestId)).toEqual([
      "req-2",
      "req-3",
    ]);
    expect(replayed.ledger.has("req-1")).toBe(false);
    expect(replayed.ledger.has("req-2")).toBe(true);
  });
});
