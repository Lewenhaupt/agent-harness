/**
 * Unit tests for the shared fleet state substrate (bd-126 P1–P4).
 *
 * Everything is exercised through injected seams: the pure layer (paths, note
 * names, audit formatting, parsers) needs no mocks at all, and the readers and
 * writers run against an in-memory fs that implements the same synchronous
 * contract as `node:fs`.
 */

import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ackNotes,
  addFleetOrderingGates,
  appendFleetAuditEntry,
  canAcquireFleetMerge,
  createFleetIntent,
  createFleetMergeLock,
  createFleetMergeQueue,
  drainNotes,
  dropFleetOrderingGates,
  enqueueNote,
  enqueueNoteFanout,
  FLEET_AUDIT_ACTION_MAX_LENGTH,
  FLEET_AUDIT_ACTOR_MAX_LENGTH,
  FLEET_AUDIT_DETAIL_MAX_LENGTH,
  FLEET_AUDIT_TASK_ID_MAX_LENGTH,
  FLEET_AUDIT_TASK_IDS_MAX,
  FLEET_MERGE_ENTRY_STATES,
  FLEET_MERGE_LEASE_MS,
  FLEET_NOTE_ADDRESS_MAX_LENGTH,
  FLEET_NOTE_BODY_MAX_LENGTH,
  FLEET_NOTE_FILE_MAX_BYTES,
  FLEET_NOTE_KINDS,
  type FleetNote,
  type FleetStateFs,
  fleetAuditLogPath,
  fleetDir,
  fleetEventsDir,
  fleetInboxDir,
  fleetIntentFilePath,
  fleetMergeQueueFilePath,
  fleetNoteFileName,
  fleetRoot,
  formatAuditEntry,
  isFleetNoteKind,
  isLockExpired,
  parseFleetMergeQueue,
  parseFleetNote,
  pruneLandedFleetMember,
  readFleetIntent,
  readFleetMergeQueue,
  retireFleetDeferral,
  updateFleetIntent,
  updateFleetMergeQueue,
  withoutPauseFields,
  writeFleetIntent,
  writeFleetMergeQueue,
} from "../fleet-state.js";
import type { FleetIntent } from "../fleet-status.js";
import { FLEET_INTENT_ORDERING_GATES_MAX, fleetStateDir } from "../fleet-status.js";

const commonDir = "/repo/.git";
const fleetId = "fleet-1";

interface FakeFs extends FleetStateFs {
  files: Map<string, string>;
}

/** In-memory fs with the synchronous surface the fleet state layer uses. */
function createFakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync: (path) =>
      files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
    readFileSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    statSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { size: Buffer.byteLength(content), mtimeMs: 0 };
    },
    writeFileSync: (path, data) => {
      files.set(path, data);
    },
    appendFileSync: (path, data) => {
      files.set(path, `${files.get(path) ?? ""}${data}`);
    },
    renameSync: (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content === undefined) throw new Error(`ENOENT: ${oldPath}`);
      files.delete(oldPath);
      files.set(newPath, content);
    },
    mkdirSync: () => {
      // The in-memory fs has no directory hierarchy to create.
    },
    unlinkSync: (path) => {
      files.delete(path);
    },
    readdirSync: (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const head = file.slice(prefix.length).split("/")[0];
        if (head !== undefined && head !== "") names.add(head);
      }
      return [...names];
    },
    rmdirSync: () => {
      // The merge lock's real mkdir/rmdir primitive is exercised against a temp
      // directory in `fleet-merge.test.ts`; this fake never models directories.
    },
  };
}

/** True when `candidate` stays inside `root` (no `..`, no absolute escape). */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function sampleNote(overrides: Partial<FleetNote> = {}): FleetNote {
  return {
    schemaVersion: 1,
    kind: "note",
    from: "bd-12",
    to: "supervisor",
    body: "plan phase finished",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("fleet state paths", () => {
  it("places every artifact under <git-common-dir>/belayd/fleet/<fleetId>", () => {
    const dir = fleetDir(commonDir, fleetId);

    expect(fleetRoot(commonDir)).toBe(join(commonDir, "belayd", "fleet"));
    expect(dir).toBe(fleetStateDir(commonDir, fleetId));
    expect(dirname(dir)).toBe(fleetRoot(commonDir));
    expect(fleetIntentFilePath(commonDir, fleetId)).toBe(join(dir, "fleet.json"));
    expect(fleetInboxDir(commonDir, fleetId)).toBe(join(dir, "inbox"));
    expect(fleetEventsDir(commonDir, fleetId)).toBe(join(dir, "events"));
    expect(fleetMergeQueueFilePath(commonDir, fleetId)).toBe(join(dir, "merge-queue.json"));
    expect(fleetAuditLogPath(commonDir, fleetId)).toBe(join(dir, "audit.log"));
  });

  it("keeps traversal-shaped and NUL-bearing fleet ids inside the fleet root", () => {
    const root = fleetRoot(commonDir);

    for (const requested of [
      "../evil",
      "../../etc",
      "a/b",
      "a\\b",
      "..",
      ".",
      "",
      "evil\u0000id",
    ]) {
      const dir = fleetDir(commonDir, requested);
      expect(isInside(root, dir)).toBe(true);
      expect(dir).not.toContain("\u0000");
      expect(dirname(dir)).toBe(root);
    }

    expect(fleetDir(commonDir, "../evil")).toBe(join(root, ".._evil"));
    expect(fleetDir(commonDir, "..")).toBe(join(root, "default"));
    expect(fleetDir(commonDir, "evil\u0000id")).toBe(join(root, "evil_id"));
  });
});

describe("fleet.json intent", () => {
  const path = fleetIntentFilePath(commonDir, fleetId);

  it("round-trips a created intent through the writer and reader", () => {
    const fs = createFakeFs();
    const intent = createFleetIntent({
      fleetId,
      taskIds: ["bd-12", "bd-15"],
      now: 1_000,
      maxConcurrent: 2,
      baseBranch: "main",
      supervisor: { sessionId: "session-1", pid: 4242 },
      note: "night shift",
    });

    expect(writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent, fs })).toEqual({
      ok: true,
    });

    const loaded = readFleetIntent({ gitCommonDir: commonDir, fleetId, fs });
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent).toEqual({
      schemaVersion: 1,
      fleetId,
      taskIds: ["bd-12", "bd-15"],
      createdAt: 1_000,
      updatedAt: 1_000,
      maxConcurrent: 2,
      baseBranch: "main",
      supervisor: { sessionId: "session-1", pid: 4242 },
      note: "night shift",
    });
  });

  it("projects out only the pause fields, keeping every other fact (S3)", () => {
    const base = createFleetIntent({
      fleetId,
      taskIds: ["bd-12"],
      now: 1_000,
      maxConcurrent: 2,
      baseBranch: "main",
      supervisor: { sessionId: "session-1", pid: 4242, armToken: "token" },
      note: "restore conflicted",
    });
    const paused = {
      ...base,
      paused: true,
      park: { reason: "restore conflicted", stashRef: "a".repeat(40), recordedAt: 5 },
      deferred: [{ taskId: "bd-15", reason: "capacity" as const, detail: "no slot" }],
      // A field a later milestone adds: the projection must carry it, not drop it.
      futureField: "kept",
    };

    const projected = withoutPauseFields(paused, 2_000);
    expect(projected).not.toHaveProperty("paused");
    expect(projected).not.toHaveProperty("park");
    expect(projected).not.toHaveProperty("note");
    expect(projected).toMatchObject({
      schemaVersion: 1,
      fleetId,
      taskIds: ["bd-12"],
      createdAt: 1_000,
      updatedAt: 2_000,
      maxConcurrent: 2,
      baseBranch: "main",
      deferred: [{ taskId: "bd-15", reason: "capacity", detail: "no slot" }],
      futureField: "kept",
    });
    expect(projected.supervisor).toEqual({ sessionId: "session-1", pid: 4242, armToken: "token" });
  });

  it("omits optional fields it was not given", () => {
    const intent = createFleetIntent({ fleetId, taskIds: [], now: 5 });
    expect(intent).not.toHaveProperty("maxConcurrent");
    expect(intent).not.toHaveProperty("baseBranch");
    expect(intent).not.toHaveProperty("supervisor");
    expect(intent).not.toHaveProperty("note");
  });

  it("writes the sanitized directory id so the record cannot claim another fleet", () => {
    const fs = createFakeFs();
    const intent = createFleetIntent({ fleetId: "../evil", taskIds: [], now: 5 });

    expect(writeFleetIntent({ gitCommonDir: commonDir, fleetId: "../evil", intent, fs })).toEqual({
      ok: true,
    });
    expect([...fs.files.keys()]).toEqual([fleetIntentFilePath(commonDir, "../evil")]);

    const loaded = readFleetIntent({ gitCommonDir: commonDir, fleetId: "../evil", fs });
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.intent).toHaveProperty("fleetId", ".._evil");
  });

  it("reports absence separately from corruption", () => {
    const fs = createFakeFs();
    expect(readFleetIntent({ gitCommonDir: commonDir, fleetId, fs })).toEqual({
      ok: true,
      intent: undefined,
    });

    fs.files.set(path, "{ truncated");
    expect(readFleetIntent({ gitCommonDir: commonDir, fleetId, fs })).toHaveProperty(
      "reason",
      "corrupt-intent",
    );

    fs.files.set(path, JSON.stringify({ schemaVersion: 99, fleetId }));
    expect(readFleetIntent({ gitCommonDir: commonDir, fleetId, fs })).toHaveProperty(
      "reason",
      "corrupt-intent",
    );

    fs.files.set(path, JSON.stringify(createFleetIntent({ fleetId, taskIds: [], now: 1 })));
    fs.readFileSync = () => {
      throw new Error("EACCES: permission denied");
    };
    const failed = readFleetIntent({ gitCommonDir: commonDir, fleetId, fs });
    expect(failed).toHaveProperty("reason", "read-failed");
    if (failed.ok) return;
    expect(failed.error).toContain("EACCES");
  });

  it("returns an error value when the atomic write fails", () => {
    const fs = createFakeFs();
    const intent = createFleetIntent({ fleetId, taskIds: [], now: 1 });
    fs.writeFileSync = () => {
      throw new Error("EROFS: read-only file system");
    };

    const written = writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent, fs });
    expect(written).toHaveProperty("ok", false);
    if (written.ok) return;
    expect(written.error).toContain("EROFS");
    // A failed atomic write leaves no intent behind.
    expect(fs.files.has(path)).toBe(false);
  });

  it("updates an existing intent in place and refuses a corrupt one", () => {
    const fs = createFakeFs();
    const intent = createFleetIntent({ fleetId, taskIds: ["bd-12"], now: 1_000 });
    writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent, fs });

    const updated = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: (current) => ({ ...(current ?? intent), paused: true, updatedAt: 2_000 }),
    });
    expect(updated).toHaveProperty("ok", true);
    if (!updated.ok) return;
    expect(updated.intent).toHaveProperty("paused", true);
    expect(updated.intent).toHaveProperty("taskIds", ["bd-12"]);
    expect(readFleetIntent({ gitCommonDir: commonDir, fleetId, fs })).toHaveProperty(
      "intent.paused",
      true,
    );

    fs.files.set(path, "not json");
    const refused = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: () => intent,
    });
    expect(refused).toHaveProperty("reason", "corrupt-intent");
    // The unreadable record is preserved rather than replaced.
    expect(fs.files.get(path)).toBe("not json");
  });

  it("reports a write failure from updateFleetIntent", () => {
    const fs = createFakeFs();
    writeFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      intent: createFleetIntent({ fleetId, taskIds: [], now: 1 }),
      fs,
    });
    fs.writeFileSync = () => {
      throw new Error("ENOSPC: no space left on device");
    };

    expect(
      updateFleetIntent({
        gitCommonDir: commonDir,
        fleetId,
        fs,
        update: (current) => ({
          ...(current ?? createFleetIntent({ fleetId, taskIds: [], now: 1 })),
        }),
      }),
    ).toHaveProperty("reason", "write-failed");
  });

  it("refuses to replace a present but unparsable intent record", () => {
    const fs = createFakeFs();
    fs.files.set(path, JSON.stringify({ schemaVersion: 99, fleetId, taskIds: [] }));

    const written = writeFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      intent: createFleetIntent({ fleetId, taskIds: ["bd-12"], now: 1 }),
      fs,
    });

    expect(written).toHaveProperty("ok", false);
    if (written.ok) return;
    expect(written.error).toContain("refusing to replace unreadable fleet intent");
    // The newer-version record a human wrote survives untouched.
    expect(JSON.parse(fs.files.get(path) ?? "{}")).toHaveProperty("schemaVersion", 99);
  });

  it("writes a fresh intent when no record exists yet", () => {
    const fs = createFakeFs();
    const written = writeFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      intent: createFleetIntent({ fleetId, taskIds: ["bd-12"], now: 1 }),
      fs,
    });

    expect(written).toEqual({ ok: true });
    expect(fs.files.has(path)).toBe(true);
  });

  it("refuses an update whose base record changed since it was read", () => {
    const fs = createFakeFs();
    const base = createFleetIntent({ fleetId, taskIds: ["bd-12"], now: 1_000 });
    writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent: base, fs });

    const concurrent = { ...base, note: "operator edit", updatedAt: 2_000 };
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = (target) => {
      reads += 1;
      // First read is the update's base; every later read sees the newer record.
      return reads === 1 ? originalRead(target) : JSON.stringify(concurrent);
    };

    const updated = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: (current) => ({ ...(current ?? base), paused: true }),
    });

    expect(updated).toHaveProperty("reason", "conflict");
    // Compare-and-replace: the concurrent write is not clobbered.
    expect(JSON.parse(fs.files.get(path) ?? "{}")).toEqual(base);
  });

  it("prunes a landed member from both the member list and the deferred plan", () => {
    const intent = createFleetIntent({
      fleetId,
      taskIds: ["bd-12", "bd-15"],
      now: 1_000,
      deferred: [{ taskId: "bd-19", reason: "dependency", detail: "waits for bd-12" }],
    });

    const pruned = pruneLandedFleetMember(intent, "bd-12", 2_000);
    expect(pruned.taskIds).toEqual(["bd-15"]);
    expect(pruned.deferred).toEqual([
      { taskId: "bd-19", reason: "dependency", detail: "waits for bd-12" },
    ]);
    expect(pruned.updatedAt).toBe(2_000);
  });

  it("drops ordering-gate records by gate id, never by member id", () => {
    // C1: one blocker can order two dependents. Resolving one gate says nothing
    // about the other, so forgetting records by member would leave the sibling's
    // still-open bd gate with nothing able to resolve it.
    const intent: FleetIntent = {
      ...createFleetIntent({ fleetId, taskIds: ["bd-12", "bd-13", "bd-14"], now: 1_000 }),
      orderingGates: [
        { blocker: "bd-12", blocked: "bd-13", gateId: "bd-901" },
        { blocker: "bd-12", blocked: "bd-14", gateId: "bd-902" },
      ],
    };

    const dropped = dropFleetOrderingGates(intent, ["bd-901"], 2_000);
    expect(dropped.orderingGates).toEqual([
      { blocker: "bd-12", blocked: "bd-14", gateId: "bd-902" },
    ]);
    expect(dropped.updatedAt).toBe(2_000);
    // The last gate takes the field with it, so an empty list never reaches disk.
    expect(dropFleetOrderingGates(dropped, ["bd-902"], 3_000).orderingGates).toBeUndefined();
    // Nothing matched: the intent is returned as-is (no spurious write).
    expect(dropFleetOrderingGates(intent, ["bd-999"], 4_000)).toBe(intent);
  });

  it("refuses an adopted gate that would pass the intent's gate bound", () => {
    // C1: bd's gate count is bounded by nothing this process controls (a crashed
    // launch can leave arbitrarily many). One sweep must never append past the
    // bound: the written record would then fail its own reader, and every later
    // status/launch/tick/reconcile would report `corrupt-intent` forever.
    const atBound: FleetIntent = {
      ...createFleetIntent({ fleetId, taskIds: ["bd-12", "bd-13"], now: 1_000 }),
      orderingGates: Array.from({ length: FLEET_INTENT_ORDERING_GATES_MAX }, (_, index) => ({
        blocker: `bd-${3000 + index}`,
        blocked: `bd-${4000 + index}`,
        gateId: `bd-${5000 + index}`,
      })),
    };

    const refused = addFleetOrderingGates(
      atBound,
      [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-950" }],
      2_000,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refused.map((entry) => entry.gate.gateId)).toEqual(["bd-950"]);
    expect(refused.refused[0]?.error).toContain(
      `${FLEET_INTENT_ORDERING_GATES_MAX} ordering gates`,
    );
    expect(refused.refused[0]?.error).toContain("stays open in bd");
    // Never truncated: the recorded set is exactly what it was.
    expect(refused.intent.orderingGates).toEqual(atBound.orderingGates);
  });

  it("records the gates that fit and refuses only the ones past the bound", () => {
    const atBoundMinusOne: FleetIntent = {
      ...createFleetIntent({ fleetId, taskIds: ["bd-12", "bd-13", "bd-14"], now: 1_000 }),
      orderingGates: Array.from({ length: FLEET_INTENT_ORDERING_GATES_MAX - 1 }, (_, index) => ({
        blocker: `bd-${3000 + index}`,
        blocked: `bd-${4000 + index}`,
        gateId: `bd-${5000 + index}`,
      })),
    };

    const added = addFleetOrderingGates(
      atBoundMinusOne,
      [
        { blocker: "bd-12", blocked: "bd-13", gateId: "bd-950" },
        { blocker: "bd-12", blocked: "bd-14", gateId: "bd-951" },
      ],
      2_000,
    );
    expect(added.ok).toBe(false);
    if (added.ok) return;
    // The gate that fits is remembered (its blocker's landing resolves it); the one
    // that does not is reported and left open in bd.
    expect(added.intent.orderingGates).toHaveLength(FLEET_INTENT_ORDERING_GATES_MAX);
    expect(added.intent.orderingGates?.at(-1)).toEqual({
      blocker: "bd-12",
      blocked: "bd-13",
      gateId: "bd-950",
    });
    expect(added.refused.map((entry) => entry.gate.gateId)).toEqual(["bd-951"]);
  });

  it("refuses to write an intent record its own reader would reject", () => {
    // C1 defence in depth: the write choke point validates against the reader's
    // schema, so no caller can brick `fleet.json` with a record that only shows up
    // as `corrupt-intent` afterwards. One over-bound write is enough to lose the
    // fleet intent permanently.
    const fs = createFakeFs();
    const base = createFleetIntent({ fleetId, taskIds: ["bd-12"], now: 1_000 });
    writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent: base, fs });
    const before = fs.files.get(path);
    const overBound: FleetIntent = {
      ...base,
      orderingGates: Array.from({ length: FLEET_INTENT_ORDERING_GATES_MAX + 1 }, (_, index) => ({
        blocker: `bd-${3000 + index}`,
        blocked: `bd-${4000 + index}`,
        gateId: `bd-${5000 + index}`,
      })),
    };

    const written = writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent: overBound, fs });
    expect(written).toHaveProperty("ok", false);
    if (written.ok) return;
    expect(written.error).toContain("invalid fleet intent");
    expect(written.error).toContain("orderingGates");
    expect(fs.files.get(path)).toBe(before);

    const updated = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: () => overBound,
    });
    expect(updated).toHaveProperty("reason", "write-failed");
    if (updated.ok) return;
    expect(updated.error).toContain("invalid fleet intent");
    // The record on disk is untouched and still readable.
    expect(fs.files.get(path)).toBe(before);
    expect(readFleetIntent({ gitCommonDir: commonDir, fleetId, fs })).toHaveProperty(
      "intent.taskIds",
      ["bd-12"],
    );
  });

  it("retires a stopped member's deferral without forgetting the member", () => {
    const intent = createFleetIntent({
      fleetId,
      taskIds: ["bd-12", "bd-15"],
      now: 1_000,
      deferred: [
        { taskId: "bd-12", reason: "capacity", detail: "no slot" },
        { taskId: "bd-19", reason: "dependency", detail: "waits for bd-12" },
      ],
    });

    const retired = retireFleetDeferral(intent, "bd-12", 2_000);
    // The worktree, branch, and bead are still live: only the plan entry goes.
    expect(retired.taskIds).toEqual(["bd-12", "bd-15"]);
    expect(retired.deferred).toEqual([
      { taskId: "bd-19", reason: "dependency", detail: "waits for bd-12" },
    ]);
    expect(retired.updatedAt).toBe(2_000);
  });
});

describe("audit.log", () => {
  const path = fleetAuditLogPath(commonDir, fleetId);

  function entry(overrides: Partial<Parameters<typeof formatAuditEntry>[0]> = {}) {
    return {
      timestamp: 1_000,
      fleetId,
      actor: "session-1",
      action: "dispatch",
      taskIds: ["bd-12"],
      detail: "launched bd-12",
      ...overrides,
    };
  }

  it("formats one JSONL line with a fixed key order", () => {
    const line = formatAuditEntry(entry());
    expect(line).not.toContain("\n");
    expect(Object.keys(JSON.parse(line))).toEqual([
      "timestamp",
      "fleetId",
      "actor",
      "action",
      "taskIds",
      "detail",
    ]);
  });

  it("appends without rewriting earlier entries", () => {
    const fs = createFakeFs();
    appendFleetAuditEntry({ gitCommonDir: commonDir, fleetId, entry: entry(), fs });
    const afterFirst = fs.files.get(path) ?? "";

    appendFleetAuditEntry({
      gitCommonDir: commonDir,
      fleetId,
      entry: entry({ timestamp: 2_000, action: "note" }),
      fs,
    });
    appendFleetAuditEntry({
      gitCommonDir: commonDir,
      fleetId,
      entry: entry({ timestamp: 3_000, action: "merge", taskIds: ["bd-12", "bd-15"] }),
      fs,
    });

    const content = fs.files.get(path) ?? "";
    expect(content.startsWith(afterFirst)).toBe(true);
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line).action)).toEqual(["dispatch", "note", "merge"]);
  });

  it("bounds detail length so one message cannot bloat the log", () => {
    const fs = createFakeFs();
    appendFleetAuditEntry({
      gitCommonDir: commonDir,
      fleetId,
      entry: entry({ detail: "x".repeat(10_000) }),
      fs,
    });

    const record = JSON.parse(fs.files.get(path) ?? "{}");
    expect(record.detail.length).toBe(FLEET_AUDIT_DETAIL_MAX_LENGTH);
    expect(record.detail.endsWith("…")).toBe(true);
  });

  it("bounds every free-text audit field, not just detail", () => {
    const fs = createFakeFs();
    appendFleetAuditEntry({
      gitCommonDir: commonDir,
      fleetId,
      entry: entry({
        actor: "a".repeat(5_000),
        action: "b".repeat(5_000),
        taskIds: Array.from({ length: 10_000 }, (_, index) => `bd-${index}`),
      }),
      fs,
    });

    const record = JSON.parse(fs.files.get(path) ?? "{}");
    expect(record.actor.length).toBe(FLEET_AUDIT_ACTOR_MAX_LENGTH);
    expect(record.action.length).toBe(FLEET_AUDIT_ACTION_MAX_LENGTH);
    expect(record.taskIds).toHaveLength(FLEET_AUDIT_TASK_IDS_MAX);
    expect(record.actor.endsWith("…")).toBe(true);
    expect(record.action.endsWith("…")).toBe(true);
  });

  it("bounds each task id so one id cannot bloat the line", () => {
    const record = JSON.parse(formatAuditEntry(entry({ taskIds: ["i".repeat(5_000)] })));

    expect(record.taskIds).toHaveLength(1);
    expect(record.taskIds[0].length).toBe(FLEET_AUDIT_TASK_ID_MAX_LENGTH);
    expect(record.taskIds[0].endsWith("…")).toBe(true);
  });

  it("cannot split an entry with an embedded newline", () => {
    const line = formatAuditEntry(entry({ detail: "line one\nline two" }));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).detail).toBe("line one\nline two");
  });

  it("returns an error value when the append fails", () => {
    const fs = createFakeFs();
    fs.appendFileSync = () => {
      throw new Error("EROFS: read-only file system");
    };

    const appended = appendFleetAuditEntry({
      gitCommonDir: commonDir,
      fleetId,
      entry: entry(),
      fs,
    });
    expect(appended).toHaveProperty("ok", false);
    if (appended.ok) return;
    expect(appended.error).toContain("EROFS");
  });

  it("stores the sanitized fleet id even when the caller passed a raw one", () => {
    const fs = createFakeFs();
    appendFleetAuditEntry({
      gitCommonDir: commonDir,
      fleetId: "../evil",
      entry: entry({ fleetId: "../evil" }),
      fs,
    });

    const record = JSON.parse(fs.files.get(fleetAuditLogPath(commonDir, "../evil")) ?? "{}");
    expect(record.fleetId).toBe(".._evil");
  });
});

describe("mailbox notes", () => {
  const inbox = fleetInboxDir(commonDir, fleetId);
  const events = fleetEventsDir(commonDir, fleetId);

  it("derives a deterministic filename from content", () => {
    expect(fleetNoteFileName(sampleNote())).toBe(fleetNoteFileName(sampleNote()));
    expect(fleetNoteFileName(sampleNote())).toMatch(
      /^supervisor-note-1700000000000-[0-9a-f]{12}\.json$/,
    );
    expect(fleetNoteFileName(sampleNote({ kind: "rebase-hint" }))).not.toBe(
      fleetNoteFileName(sampleNote()),
    );
  });

  it("sanitizes every untrusted component of the filename", () => {
    for (const to of ["../../etc/passwd", "..", "a/b", "a\\b", "evil\u0000id", ""]) {
      const path = join(inbox, fleetNoteFileName(sampleNote({ to })));
      expect(isInside(inbox, path)).toBe(true);
      expect(dirname(path)).toBe(inbox);
      expect(path).not.toContain("\u0000");
    }
  });

  it("keeps notes whose ids sanitize identically apart by content", () => {
    const first = fleetNoteFileName(sampleNote({ to: "a/b" }));
    const second = fleetNoteFileName(sampleNote({ to: "a_b" }));
    expect(first).not.toBe(second);
  });

  it("enqueues atomically and treats identical content as idempotent", () => {
    const fs = createFakeFs();
    const first = enqueueNote({ dir: inbox, note: sampleNote(), fs });
    const second = enqueueNote({ dir: inbox, note: sampleNote(), fs });

    expect(first).toHaveProperty("ok", true);
    expect(second).toHaveProperty("ok", true);
    if (!first.ok || !second.ok) return;
    expect(second.path).toBe(first.path);
    expect([...fs.files.keys()]).toEqual([first.path]);
    // No temp file survives the atomic write.
    expect([...fs.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("bounds an over-long body before naming the file", () => {
    const fs = createFakeFs();
    const enqueued = enqueueNote({
      dir: inbox,
      note: sampleNote({ body: "b".repeat(FLEET_NOTE_BODY_MAX_LENGTH + 500) }),
      fs,
    });

    expect(enqueued).toHaveProperty("ok", true);
    if (!enqueued.ok) return;
    const stored = parseFleetNote(JSON.parse(fs.files.get(enqueued.path) ?? "{}"));
    expect(stored?.body.length).toBe(FLEET_NOTE_BODY_MAX_LENGTH);
    expect(stored?.body.endsWith("…")).toBe(true);
  });

  it("refuses a note whose createdAt cannot be interpolated safely", () => {
    const fs = createFakeFs();

    for (const createdAt of [
      "../../evil",
      "a/b",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
    ]) {
      const enqueued = enqueueNote({
        dir: inbox,
        note: sampleNote({ createdAt: createdAt as unknown as number }),
        fs,
      });
      expect(enqueued).toHaveProperty("ok", false);
    }

    // Nothing was named, so nothing escaped the mailbox directory.
    expect([...fs.files.keys()]).toEqual([]);
  });

  it("refuses a note missing its addressing fields instead of quarantining later", () => {
    const fs = createFakeFs();
    const enqueued = enqueueNote({
      dir: inbox,
      note: sampleNote({ from: "" }),
      fs,
    });

    expect(enqueued).toHaveProperty("ok", false);
    if (enqueued.ok) return;
    expect(enqueued.error).toContain("invalid fleet note");
    expect([...fs.files.keys()]).toEqual([]);
  });

  it("round-trips through enqueue and drain without deleting the note", () => {
    const fs = createFakeFs();
    const note = sampleNote();
    const enqueued = enqueueNote({ dir: inbox, note, fs });
    expect(enqueued).toHaveProperty("ok", true);
    if (!enqueued.ok) return;

    const drained = drainNotes({ dir: inbox, fs });
    expect(drained).toHaveProperty("ok", true);
    if (!drained.ok) return;
    expect(drained.deliveries).toHaveLength(1);
    expect(drained.deliveries[0]?.note).toEqual(note);
    expect(drained.deliveries[0]?.path).toBe(enqueued.path);
    expect(drained.warnings).toEqual([]);
    // Drain marks nothing: the file is still there for the next drain.
    expect(fs.files.has(enqueued.path)).toBe(true);

    // Re-draining replays the note (at-least-once), never loses it.
    const again = drainNotes({ dir: inbox, fs });
    expect(again).toHaveProperty("ok", true);
    if (!again.ok) return;
    expect(again.deliveries.map((delivery) => delivery.path)).toEqual([enqueued.path]);
  });

  it("drains in deterministic filename order", () => {
    const fs = createFakeFs();
    enqueueNote({ dir: inbox, note: sampleNote({ createdAt: 2, to: "bd-12" }), fs });
    enqueueNote({ dir: inbox, note: sampleNote({ createdAt: 1, to: "bd-15" }), fs });
    enqueueNote({ dir: inbox, note: sampleNote({ createdAt: 3, to: "bd-15", kind: "pause" }), fs });

    const drained = drainNotes({ dir: inbox, fs });
    expect(drained).toHaveProperty("ok", true);
    if (!drained.ok) return;
    const names = drained.deliveries.map((delivery) => delivery.path.split("/").pop() ?? "");
    expect(names).toEqual([...names].sort());
    expect(names).toHaveLength(3);
  });

  it("returns nothing for an absent or empty mailbox", () => {
    const fs = createFakeFs();
    expect(drainNotes({ dir: join(inbox, "absent"), fs })).toEqual({
      ok: true,
      deliveries: [],
      warnings: [],
    });

    fs.files.set(join(inbox, "leftover.tmp"), "not a note");
    expect(drainNotes({ dir: inbox, fs })).toEqual({ ok: true, deliveries: [], warnings: [] });
  });

  it("quarantines a corrupt note with a warning instead of dropping it", () => {
    const fs = createFakeFs();
    const corruptPath = join(inbox, "bad.json");
    fs.files.set(corruptPath, "{ truncated");

    const drained = drainNotes({ dir: inbox, fs });
    expect(drained).toHaveProperty("ok", true);
    if (!drained.ok) return;
    expect(drained.deliveries).toEqual([]);
    expect(drained.warnings).toHaveLength(1);
    expect(drained.warnings[0]).toContain("corrupt note");
    // Content preserved under a name drain ignores, so it cannot storm warnings.
    expect(fs.files.get(`${corruptPath}.corrupt`)).toBe("{ truncated");
    expect(fs.files.has(corruptPath)).toBe(false);

    const second = drainNotes({ dir: inbox, fs });
    expect(second).toHaveProperty("ok", true);
    if (!second.ok) return;
    expect(second.warnings).toEqual([]);
  });

  it("quarantines an oversize note without reading or parsing it", () => {
    const fs = createFakeFs();
    const oversizePath = join(inbox, "huge.json");
    fs.files.set(oversizePath, "x".repeat(FLEET_NOTE_FILE_MAX_BYTES + 1));
    const enqueued = enqueueNote({ dir: inbox, note: sampleNote(), fs });
    expect(enqueued).toHaveProperty("ok", true);

    // Proves the read is bounded rather than merely capped after the fact.
    const readPaths: string[] = [];
    const originalRead = fs.readFileSync;
    fs.readFileSync = (target) => {
      readPaths.push(target);
      return originalRead(target);
    };

    const drained = drainNotes({ dir: inbox, fs });
    expect(drained).toHaveProperty("ok", true);
    if (!drained.ok) return;

    expect(readPaths).not.toContain(oversizePath);
    expect(drained.deliveries).toHaveLength(1);
    expect(drained.warnings).toHaveLength(1);
    expect(drained.warnings[0]).toContain("oversize note");
    expect(fs.files.has(`${oversizePath}.corrupt`)).toBe(true);
    expect(fs.files.has(oversizePath)).toBe(false);
  });

  it("leaves a note written by another schema version in place and warns once", () => {
    const fs = createFakeFs();
    const newer = join(inbox, "supervisor-note-1-aaa.json");
    const newest = join(inbox, "supervisor-note-2-bbb.json");
    const garbage = join(inbox, "garbage.json");
    fs.files.set(newer, JSON.stringify({ ...sampleNote(), schemaVersion: 2 }));
    fs.files.set(newest, JSON.stringify({ ...sampleNote({ createdAt: 2 }), schemaVersion: 3 }));
    fs.files.set(garbage, JSON.stringify({ hello: "world" }));

    const drained = drainNotes({ dir: inbox, fs });
    expect(drained).toHaveProperty("ok", true);
    if (!drained.ok) return;

    // Version drift is not corruption: live mail survives an old reader.
    expect(fs.files.has(newer)).toBe(true);
    expect(fs.files.has(newest)).toBe(true);
    // Garbage still gets quarantined.
    expect(fs.files.has(`${garbage}.corrupt`)).toBe(true);
    expect(drained.deliveries).toEqual([]);

    const versionWarnings = drained.warnings.filter((warning) =>
      warning.includes("different note schema version"),
    );
    expect(versionWarnings).toHaveLength(1);
    expect(versionWarnings[0]).toContain("2 note(s)");
  });

  it("reports an unreadable mailbox as an error value", () => {
    const fs = createFakeFs();
    fs.files.set(join(inbox, "a-note.json"), JSON.stringify(sampleNote()));
    fs.readdirSync = () => {
      throw new Error("EACCES: permission denied");
    };

    const drained = drainNotes({ dir: inbox, fs });
    expect(drained).toHaveProperty("ok", false);
    if (drained.ok) return;
    expect(drained.reason).toBe("unreadable-mailbox");
    expect(drained.error).toContain("EACCES");
  });

  it("acknowledges drained notes once and idempotently", () => {
    const fs = createFakeFs();
    const note = sampleNote();
    const enqueued = enqueueNote({ dir: inbox, note, fs });
    if (!enqueued.ok) throw new Error("enqueue failed");

    const drained = drainNotes({ dir: inbox, fs });
    if (!drained.ok) throw new Error("drain failed");

    expect(ackNotes({ dir: inbox, deliveries: drained.deliveries, fs })).toEqual({
      ok: true,
      removed: [enqueued.path],
    });
    expect(fs.files.has(enqueued.path)).toBe(false);
    // A crash between drain and ack replays the note; a repeated ack is still success.
    expect(ackNotes({ dir: inbox, deliveries: drained.deliveries, fs })).toEqual({
      ok: true,
      removed: [],
    });
    expect(drainNotes({ dir: inbox, fs })).toEqual({ ok: true, deliveries: [], warnings: [] });
  });

  it("refuses to acknowledge a path outside the mailbox", () => {
    const fs = createFakeFs();
    fs.files.set("/etc/passwd", "root");

    const acked = ackNotes({
      dir: inbox,
      deliveries: [{ note: sampleNote(), path: "/etc/passwd" }],
      fs,
    });
    expect(acked).toHaveProperty("ok", false);
    if (acked.ok) return;
    expect(acked.error).toContain("not in");
    // The refused delivery is reported as remaining, not as consumed.
    expect(acked.removed).toEqual([]);
    expect(acked.remaining.map((delivery) => delivery.path)).toEqual(["/etc/passwd"]);
    expect(fs.files.has("/etc/passwd")).toBe(true);
  });

  it("keeps going after an unlink failure and reports consumed vs remaining (W5)", () => {
    const fs = createFakeFs();
    const first = enqueueNote({ dir: inbox, note: sampleNote({ createdAt: 1 }), fs });
    const second = enqueueNote({ dir: inbox, note: sampleNote({ createdAt: 2 }), fs });
    if (!first.ok || !second.ok) throw new Error("enqueue failed");

    const drained = drainNotes({ dir: inbox, fs });
    if (!drained.ok) throw new Error("drain failed");

    // Fail the first unlink only: the second must still be acknowledged, and the
    // first must be named as remaining instead of vanishing.
    const realUnlink = fs.unlinkSync;
    let calls = 0;
    fs.unlinkSync = (path) => {
      calls += 1;
      if (calls === 1) throw new Error("EACCES: permission denied");
      realUnlink(path);
    };

    const acked = ackNotes({ dir: inbox, deliveries: drained.deliveries, fs });
    expect(acked).toHaveProperty("ok", false);
    if (acked.ok) return;
    expect(acked.error).toContain("EACCES");
    expect(acked.removed).toEqual([second.path]);
    expect(acked.remaining.map((delivery) => delivery.path)).toEqual([first.path]);
    expect(fs.files.has(first.path)).toBe(true);
    expect(fs.files.has(second.path)).toBe(false);
  });

  it("fans a broadcast out to one file per member, each acked exactly once (C1)", () => {
    const fs = createFakeFs();
    const broadcast = sampleNote({ from: "supervisor", to: "all", body: "main moved" });

    const fanout = enqueueNoteFanout({
      dir: events,
      note: broadcast,
      recipients: ["bd-12", "bd-15"],
      fs,
    });
    expect(fanout).toHaveProperty("ok", true);
    if (!fanout.ok) return;
    expect(fanout.paths).toHaveLength(2);
    expect(new Set(fanout.paths).size).toBe(2);

    // Either drain order: each member sees its own copy, and the other's file is
    // untouched until that member drains it.
    const firstDrain = drainNotes({ dir: events, fs });
    if (!firstDrain.ok) throw new Error("drain failed");
    expect(firstDrain.deliveries.map((delivery) => delivery.note.to).sort()).toEqual([
      "bd-12",
      "bd-15",
    ]);
    expect(firstDrain.deliveries.every((delivery) => delivery.note.body === "main moved")).toBe(
      true,
    );

    const firstAck = ackNotes({
      dir: events,
      deliveries: [firstDrain.deliveries[0] as (typeof firstDrain.deliveries)[number]],
      fs,
    });
    expect(firstAck).toHaveProperty("ok", true);

    const secondDrain = drainNotes({ dir: events, fs });
    if (!secondDrain.ok) throw new Error("drain failed");
    // The sibling's copy survived the first ack: this is the property the single
    // `to: "all"` file could not provide.
    expect(secondDrain.deliveries).toHaveLength(1);
    expect(secondDrain.deliveries[0]?.note.to).not.toBe(firstDrain.deliveries[0]?.note.to);

    expect(ackNotes({ dir: events, deliveries: secondDrain.deliveries, fs })).toHaveProperty(
      "ok",
      true,
    );
    expect(drainNotes({ dir: events, fs })).toEqual({ ok: true, deliveries: [], warnings: [] });
  });

  it("reports a partial fan-out with the recipients it did reach", () => {
    const fs = createFakeFs();
    const realWrite = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (path, data) => {
      writes += 1;
      if (writes === 2) throw new Error("ENOSPC: no space left on device");
      realWrite(path, data);
    };

    const fanout = enqueueNoteFanout({
      dir: events,
      note: sampleNote({ from: "supervisor", to: "all" }),
      recipients: ["bd-12", "bd-15"],
      fs,
    });

    expect(fanout).toHaveProperty("ok", false);
    if (fanout.ok) return;
    expect(fanout.written).toHaveLength(1);
    // W-A: the audit derives its id list from this, so a partial broadcast names
    // the recipient whose file exists, not the intended set.
    expect(fanout.writtenRecipients).toEqual(["bd-12"]);
    expect(fanout.error).toContain("fan-out stopped at bd-15");
  });

  it("narrows a note kind with a real type guard, never a cast (S4)", () => {
    expect(isFleetNoteKind("rebase-hint")).toBe(true);
    for (const kind of FLEET_NOTE_KINDS) expect(isFleetNoteKind(kind)).toBe(true);
    expect(isFleetNoteKind("shutdown")).toBe(false);
    expect(isFleetNoteKind(undefined)).toBe(false);
    expect(isFleetNoteKind(7)).toBe(false);
  });

  it("round-trips a maximum-size legal note without quarantining it (W-A)", () => {
    const fs = createFakeFs();
    // Every bounded field at its limit: the note is legal by schema, so the
    // drain must deliver it — a legal note quarantined as "oversize" would mean
    // the file cap cannot be satisfied by the schema.
    const maximal = sampleNote({
      to: "t".repeat(FLEET_NOTE_ADDRESS_MAX_LENGTH),
      from: "f".repeat(FLEET_NOTE_ADDRESS_MAX_LENGTH),
      body: "b".repeat(FLEET_NOTE_BODY_MAX_LENGTH),
    });

    const enqueued = enqueueNote({ dir: inbox, note: maximal, fs });
    expect(enqueued).toHaveProperty("ok", true);
    if (!enqueued.ok) return;

    const stored = fs.files.get(enqueued.path) ?? "";
    expect(Buffer.byteLength(stored)).toBeLessThan(FLEET_NOTE_FILE_MAX_BYTES);
    expect(dirname(enqueued.path)).toBe(inbox);
    expect(enqueued.path.split("/").pop() ?? "").not.toContain("invalid");

    const drained = drainNotes({ dir: inbox, fs });
    expect(drained).toHaveProperty("ok", true);
    if (!drained.ok) return;
    expect(drained.warnings).toEqual([]);
    expect(drained.deliveries.map((delivery) => delivery.path)).toEqual([enqueued.path]);
    expect(drained.deliveries[0]?.note).toEqual(maximal);
  });

  it("keeps a note that exceeds the address bound out of the schema entirely", () => {
    // The schema bound is what makes the byte arithmetic hold: without it a
    // legal-looking record could be both schema-valid and above the file cap.
    const fs = createFakeFs();
    const tooLong = sampleNote({ to: "t".repeat(FLEET_NOTE_ADDRESS_MAX_LENGTH + 1) });

    expect(parseFleetNote(tooLong)).toBe(undefined);
    expect(enqueueNote({ dir: inbox, note: tooLong, fs })).toHaveProperty("ok", false);
    expect(fs.files.size).toBe(0);
  });

  it("never lets an exported filename helper interpolate a non-finite timestamp", () => {
    // fleetNoteFileName is exported, so a future caller that skips enqueueNote
    // must still be unable to write outside the mailbox directory.
    for (const createdAt of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "../.." as unknown as number,
      undefined as unknown as number,
    ]) {
      const name = fleetNoteFileName(sampleNote({ createdAt }));
      const path = join(inbox, name);
      expect(isInside(inbox, path)).toBe(true);
      expect(dirname(path)).toBe(inbox);
      expect(name).toContain("-invalid-");
      expect(name).not.toContain("/");
      expect(name).not.toContain("..");
    }
  });

  it("fails the drain when a corrupt note cannot be quarantined", () => {
    const fs = createFakeFs();
    const corruptPath = join(inbox, "bad.json");
    fs.files.set(corruptPath, "{ truncated");
    fs.renameSync = () => {
      throw new Error("EACCES: permission denied");
    };

    const drained = drainNotes({ dir: inbox, fs });
    // A warning storm is what quarantine exists to prevent, so a rename that
    // keeps failing must not be reported as a successful drain.
    expect(drained).toHaveProperty("ok", false);
    if (drained.ok) return;
    expect(drained.reason).toBe("quarantine-failed");
    expect(drained.error).toContain(corruptPath);
    expect(drained.error).toContain("move or remove it by hand");
    // Nothing was lost while failing: the file is still there.
    expect(fs.files.get(corruptPath)).toBe("{ truncated");
  });

  it("only accepts known note kinds and a complete record", () => {
    expect(FLEET_NOTE_KINDS).toContain("rebase-hint");
    expect(parseFleetNote(sampleNote())).toEqual(sampleNote());
    expect(parseFleetNote({ ...sampleNote(), kind: "shutdown" })).toBe(undefined);
    expect(parseFleetNote({ ...sampleNote(), from: "" })).toBe(undefined);
    expect(parseFleetNote({ ...sampleNote(), createdAt: "yesterday" })).toBe(undefined);
    expect(parseFleetNote("not an object")).toBe(undefined);
  });
});

describe("merge-queue.json", () => {
  const path = fleetMergeQueueFilePath(commonDir, fleetId);

  function sampleQueue() {
    return {
      schemaVersion: 1 as const,
      updatedAt: 2_000,
      lock: {
        holder: "session-1",
        taskId: "bd-12",
        pid: 4242,
        acquiredAt: 1_500,
        leaseExpiresAt: 1_500 + FLEET_MERGE_LEASE_MS,
      },
      entries: [
        {
          taskId: "bd-12",
          branch: "feat/bd-12",
          requestedAt: 1_000,
          state: "gating" as const,
          attempts: 1,
        },
        {
          taskId: "bd-15",
          branch: "feat/bd-15",
          requestedAt: 1_100,
          state: "queued" as const,
          attempts: 0,
          lastError: "previous attempt conflicted",
        },
      ],
    };
  }

  it("round-trips a queue with a held lock", () => {
    const fs = createFakeFs();
    const queue = sampleQueue();

    expect(writeFleetMergeQueue({ gitCommonDir: commonDir, fleetId, queue, fs })).toEqual({
      ok: true,
    });
    const loaded = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId, fs });
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.queue).toEqual(queue);
    expect(fs.files.has(path)).toBe(true);
  });

  it("starts empty with a free lock", () => {
    const fs = createFakeFs();
    const queue = createFleetMergeQueue(1_000);

    expect(queue).toEqual({ schemaVersion: 1, updatedAt: 1_000, lock: null, entries: [] });
    writeFleetMergeQueue({ gitCommonDir: commonDir, fleetId, queue, fs });
    const loaded = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId, fs });
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.queue).toHaveProperty("lock", null);
  });

  it("reports absence separately from corruption", () => {
    const fs = createFakeFs();
    expect(readFleetMergeQueue({ gitCommonDir: commonDir, fleetId, fs })).toEqual({
      ok: true,
      queue: undefined,
    });

    fs.files.set(path, "{ nope");
    expect(readFleetMergeQueue({ gitCommonDir: commonDir, fleetId, fs })).toHaveProperty(
      "reason",
      "corrupt-merge-queue",
    );
    expect(fs.files.has(path)).toBe(true);
  });

  it("rejects malformed entries", () => {
    const queue = sampleQueue();
    const withEntry = (entry: unknown) => ({ ...queue, entries: [entry] });

    expect(parseFleetMergeQueue(queue)).toEqual(queue);
    for (const state of FLEET_MERGE_ENTRY_STATES) {
      expect(parseFleetMergeQueue(withEntry({ ...queue.entries[0], state }))).toBeDefined();
    }

    expect(parseFleetMergeQueue(withEntry({ ...queue.entries[0], state: "shipped" }))).toBe(
      undefined,
    );
    expect(parseFleetMergeQueue(withEntry({ ...queue.entries[0], state: undefined }))).toBe(
      undefined,
    );
    expect(parseFleetMergeQueue(withEntry({ ...queue.entries[0], branch: "" }))).toBe(undefined);
    expect(parseFleetMergeQueue(withEntry({ ...queue.entries[0], taskId: undefined }))).toBe(
      undefined,
    );
    expect(parseFleetMergeQueue(withEntry({ ...queue.entries[0], attempts: -1 }))).toBe(undefined);
    expect(parseFleetMergeQueue(withEntry({ ...queue.entries[0], attempts: 1.5 }))).toBe(undefined);
    expect(parseFleetMergeQueue(withEntry({ ...queue.entries[0], requestedAt: "now" }))).toBe(
      undefined,
    );
    expect(parseFleetMergeQueue({ ...queue, entries: {} })).toBe(undefined);
    expect(parseFleetMergeQueue({ ...queue, schemaVersion: 2 })).toBe(undefined);
    expect(parseFleetMergeQueue({ ...queue, lock: { holder: "session-1" } })).toBe(undefined);
    expect(parseFleetMergeQueue("not a queue")).toBe(undefined);
  });

  it("expires a merge lock exactly at its lease deadline", () => {
    const lock = createFleetMergeLock({
      holder: "session-1",
      taskId: "bd-12",
      pid: 4242,
      now: 1_000,
      leaseInMs: 60_000,
    });

    expect(lock).toEqual({
      holder: "session-1",
      taskId: "bd-12",
      pid: 4242,
      acquiredAt: 1_000,
      leaseExpiresAt: 61_000,
    });
    expect(isLockExpired(lock, 60_999)).toBe(false);
    expect(isLockExpired(lock, 61_000)).toBe(true);
    expect(isLockExpired(lock, 61_001)).toBe(true);
    // No holder means nothing to wait for, so the predicate is total.
    expect(isLockExpired(null, 0)).toBe(true);
  });

  it("defaults the lease to FLEET_MERGE_LEASE_MS", () => {
    const lock = createFleetMergeLock({ holder: "session-1", taskId: "bd-12", pid: 1, now: 500 });

    expect(lock.leaseExpiresAt).toBe(500 + FLEET_MERGE_LEASE_MS);
    expect(FLEET_MERGE_LEASE_MS).toBeGreaterThan(0);
  });

  it("decides acquisition from queue presence, lock absence, and lease expiry", () => {
    expect(canAcquireFleetMerge(undefined, 0)).toEqual({ allowed: true, reason: "no-queue" });

    const queue = createFleetMergeQueue(0);
    expect(canAcquireFleetMerge(queue, 0)).toEqual({ allowed: true, reason: "lock-free" });

    const lock = createFleetMergeLock({
      holder: "session-1",
      taskId: "bd-12",
      pid: 4242,
      now: 1_000,
      leaseInMs: 60_000,
    });
    const held = { ...queue, lock };
    expect(canAcquireFleetMerge(held, 1_001)).toEqual({
      allowed: false,
      reason: "lock-held",
      holder: "session-1",
      taskId: "bd-12",
      leaseExpiresAt: 61_000,
    });

    // A crashed holder cannot wedge the queue: its expired lease is acquirable.
    expect(canAcquireFleetMerge(held, lock.leaseExpiresAt)).toEqual({
      allowed: true,
      reason: "lease-expired",
    });
  });

  it("rejects a lock that carries no holder pid or no lease", () => {
    const queue = sampleQueue();
    const withLock = (lock: unknown) => ({ ...queue, lock });

    expect(parseFleetMergeQueue(queue)).toEqual(queue);
    expect(parseFleetMergeQueue(withLock({ ...queue.lock, pid: undefined }))).toBe(undefined);
    expect(parseFleetMergeQueue(withLock({ ...queue.lock, pid: 0 }))).toBe(undefined);
    expect(parseFleetMergeQueue(withLock({ ...queue.lock, leaseExpiresAt: undefined }))).toBe(
      undefined,
    );
    expect(parseFleetMergeQueue(withLock({ ...queue.lock, leaseExpiresAt: "soon" }))).toBe(
      undefined,
    );
  });

  it("updates the queue with compare-and-replace (W-B)", () => {
    const fs = createFakeFs();
    writeFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      queue: createFleetMergeQueue(1_000),
      fs,
    });

    const enqueued = updateFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: (current) => {
        const base = current ?? createFleetMergeQueue(1_000);
        return {
          ...base,
          entries: [
            ...base.entries,
            {
              taskId: "bd-12",
              branch: "feat/bd-12",
              requestedAt: 1_000,
              state: "queued",
              attempts: 0,
            },
          ],
        };
      },
    });

    expect(enqueued).toHaveProperty("ok", true);
    if (!enqueued.ok) return;
    expect(enqueued.queue.entries.map((entry) => entry.taskId)).toEqual(["bd-12"]);
    const loaded = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId, fs });
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.queue).toEqual(enqueued.queue);
  });

  it("creates the queue when it is absent", () => {
    const fs = createFakeFs();
    const created = updateFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: (current) => current ?? createFleetMergeQueue(5_000),
    });

    expect(created).toHaveProperty("ok", true);
    if (!created.ok) return;
    expect(created.queue).toEqual(createFleetMergeQueue(5_000));
  });

  it("reports a conflict when the queue changed between read and write", () => {
    const fs = createFakeFs();
    writeFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      queue: createFleetMergeQueue(1_000),
      fs,
    });

    const conflicted = updateFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: (current) => {
        // A competing writer (lease renewal) lands between the engine's two reads.
        fs.files.set(path, JSON.stringify(createFleetMergeQueue(9_999)));
        return current ?? createFleetMergeQueue(1_000);
      },
    });

    expect(conflicted).toHaveProperty("ok", false);
    if (conflicted.ok) return;
    expect(conflicted.reason).toBe("conflict");
    expect(conflicted.error).toContain("re-read and retry");
    // The competing write survives; the loser did not overwrite it.
    expect(JSON.parse(fs.files.get(path) ?? "{}")).toEqual(createFleetMergeQueue(9_999));
  });

  it("refuses to replace a queue it cannot parse", () => {
    const fs = createFakeFs();
    fs.files.set(path, "{ nope");

    const written = writeFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      queue: createFleetMergeQueue(1_000),
      fs,
    });
    expect(written).toHaveProperty("ok", false);
    if (written.ok) return;
    expect(written.error).toContain("refusing to replace unreadable merge queue");
    expect(fs.files.get(path)).toBe("{ nope");

    const updated = updateFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: (current) => current ?? createFleetMergeQueue(1_000),
    });
    expect(updated).toHaveProperty("ok", false);
    if (updated.ok) return;
    expect(updated.reason).toBe("corrupt-merge-queue");
    expect(fs.files.get(path)).toBe("{ nope");
  });

  it("returns an error value when the atomic write fails", () => {
    const fs = createFakeFs();
    fs.renameSync = () => {
      throw new Error("EXDEV: cross-device link");
    };

    const written = writeFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      queue: sampleQueue(),
      fs,
    });
    expect(written).toHaveProperty("ok", false);
    if (written.ok) return;
    expect(written.error).toContain("EXDEV");
    expect(fs.files.has(path)).toBe(false);
  });
});
