/**
 * Unit tests for the shared fleet state substrate (bd-126 P1–P4).
 *
 * Everything is exercised through injected seams: the pure layer (paths, note
 * names, audit formatting, parsers) needs no mocks at all, and the readers and
 * writers run against an in-memory fs that implements the same synchronous
 * contract as `node:fs`.
 */

import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ackNotes,
  addFleetOrderingGates,
  appendFleetAuditEntry,
  canAcquireFleetMerge,
  clearFleetLaunchMarker,
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
  FLEET_NOTE_KINDS,
  type FleetNote,
  type FleetStateFs,
  fleetDir,
  fleetRoot,
  formatAuditEntry,
  isFleetNoteKind,
  isLockExpired,
  parseFleetMergeQueue,
  parseFleetNote,
  pruneLandedFleetMember,
  readFleetIntent,
  readFleetMergeQueue,
  readRecentFleetAuditEntries,
  retireFleetDeferral,
  updateFleetIntent,
  updateFleetMergeQueue,
  withFleetLaunchMarker,
  withoutPauseFields,
  writeFleetIntent,
  writeFleetLaunchMarker,
  writeFleetMergeQueue,
} from "../fleet-state.js";
import type { FleetIntent } from "../fleet-status.js";
import {
  FLEET_INTENT_MEMBERS_MAX,
  FLEET_INTENT_ORDERING_GATES_MAX,
  FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS,
  FLEET_MEMBER_SPAWN_GRACE_MS,
  FLEET_SCHEMA_VERSION,
  FLEET_SPAWN_GRACE_MARGIN_MS,
  FLEET_SPAWN_RPC_ALLOWANCE_MS,
  fleetLaunchMarkerTaskIdRefusal,
  fleetSpawnInFlight,
  fleetStateDir,
  isFleetSpawnInFlight,
  parseFleetLaunchMarker,
  readFleetLaunchMarker,
} from "../fleet-status.js";
import {
  openRepoStateStore,
  REPO_STATE_AUDIT_TAIL_ROWS,
  type RepoStateStore,
} from "../repo-state-store.js";
import { WORKTREE_READY_TIMEOUT_MS } from "../worktree.js";

const commonDir = "/repo/.git";
const fleetId = "fleet-1";

interface FakeFs extends FleetStateFs {
  files: Map<string, string>;
  /** The in-memory repo store the intent/run row lives in (bd-281). */
  store: RepoStateStore;
}

/** One throwaway store per fake fs, so a fixture can never leak into another test. */
function openMemoryStore(): RepoStateStore {
  const opened = openRepoStateStore({ path: ":memory:" });
  if (!opened.ok) throw new Error(opened.error);
  return opened.store;
}

/** In-memory fs with the synchronous surface the fleet state layer uses. */
function createFakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    store: openMemoryStore(),
    existsSync: (path) =>
      files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
    readFileSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFileSync: (path, data) => {
      files.set(path, data);
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
    // A documented survivor of the file era: no state is written there any more, and
    // the note mailboxes are rows, but the legacy fleet-id scan and the importer
    // still need the directory.
    expect(fleetStateDir(commonDir, fleetId)).toBe(join(fleetRoot(commonDir), fleetId));
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

describe("fleet intent store row", () => {
  /** Seed one raw intent document, bypassing the writer's validation (a corrupt row). */
  function seedRawRow(fs: FakeFs, raw: unknown): void {
    const written = fs.store.writeFleetIntent({ fleetId, intent: raw });
    if (!written.ok) throw new Error(written.error);
  }

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
      schemaVersion: FLEET_SCHEMA_VERSION,
      fleetId,
      taskIds: ["bd-12", "bd-15"],
      createdAt: 1_000,
      updatedAt: 1_000,
      maxConcurrent: 2,
      baseBranch: "main",
      publish: { mode: "local" },
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
      schemaVersion: FLEET_SCHEMA_VERSION,
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
    // baseBranch and publish are frozen fields, not optional: a launch always
    // records a concrete landing contract.
    expect(intent).toHaveProperty("baseBranch", "main");
    expect(intent).toHaveProperty("publish", { mode: "local" });
    expect(intent).not.toHaveProperty("supervisor");
    expect(intent).not.toHaveProperty("note");
  });

  it("writes the sanitized row id so the record cannot claim another fleet", () => {
    const fs = createFakeFs();
    const intent = createFleetIntent({ fleetId: "../evil", taskIds: [], now: 5 });

    expect(writeFleetIntent({ gitCommonDir: commonDir, fleetId: "../evil", intent, fs })).toEqual({
      ok: true,
    });
    // bd-281: the id is the row key, and no fleet.json file is written.
    expect(fs.files.size).toBe(0);
    expect(fs.store.readFleet(".._evil")).toHaveProperty("value.fleetId", ".._evil");

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

    seedRawRow(fs, "{ truncated");
    expect(readFleetIntent({ gitCommonDir: commonDir, fleetId, fs })).toHaveProperty(
      "reason",
      "corrupt-intent",
    );

    seedRawRow(fs, { schemaVersion: 99, fleetId });
    expect(readFleetIntent({ gitCommonDir: commonDir, fleetId, fs })).toHaveProperty(
      "reason",
      "corrupt-intent",
    );

    // A store read failure is reported as such, never as absence: a caller that
    // cannot read the row must not decide the fleet has no intent.
    const failing: FakeFs = {
      ...fs,
      store: { ...fs.store, readFleet: () => ({ ok: false, error: "EACCES: permission denied" }) },
    };
    const failed = readFleetIntent({ gitCommonDir: commonDir, fleetId, fs: failing });
    expect(failed).toHaveProperty("reason", "read-failed");
    if (failed.ok) return;
    expect(failed.error).toContain("EACCES");
  });

  it("returns an error value when the store write fails", () => {
    const fs = createFakeFs();
    const intent = createFleetIntent({ fleetId, taskIds: [], now: 1 });
    const failing: FakeFs = {
      ...fs,
      store: {
        ...fs.store,
        writeFleetIntent: () => ({ ok: false, error: "EROFS: read-only file system" }),
      },
    };

    const written = writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent, fs: failing });
    expect(written).toHaveProperty("ok", false);
    if (written.ok) return;
    expect(written.error).toContain("EROFS");
    // A failed write leaves no intent row behind.
    expect(fs.store.readFleet(fleetId)).toHaveProperty("value", null);
  });

  it("updates an existing intent in place and refuses a corrupt row", () => {
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

    seedRawRow(fs, "not json");
    const refused = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: () => intent,
    });
    expect(refused).toHaveProperty("reason", "corrupt-intent");
    // The unreadable record is preserved rather than replaced.
    expect(fs.store.readFleet(fleetId)).toHaveProperty("value.intent", "not json");
  });

  it("reports a write failure from updateFleetIntent", () => {
    const fs = createFakeFs();
    writeFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      intent: createFleetIntent({ fleetId, taskIds: [], now: 1 }),
      fs,
    });
    const failing: FakeFs = {
      ...fs,
      store: {
        ...fs.store,
        mutateFleet: () => ({ ok: false, error: "ENOSPC: no space left on device" }),
      },
    };

    expect(
      updateFleetIntent({
        gitCommonDir: commonDir,
        fleetId,
        fs: failing,
        update: (current) => ({
          ...(current ?? createFleetIntent({ fleetId, taskIds: [], now: 1 })),
        }),
      }),
    ).toHaveProperty("reason", "write-failed");
  });

  it("refuses to replace a present but unparsable intent row", () => {
    const fs = createFakeFs();
    seedRawRow(fs, { schemaVersion: 99, fleetId, taskIds: [] });

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
    expect(fs.store.readFleet(fleetId)).toHaveProperty("value.intent.schemaVersion", 99);
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
    expect(fs.store.readFleet(fleetId)).not.toHaveProperty("value", null);
  });

  it("upgrades a legacy v1 record to the current shape before writing it", () => {
    // `fleetIntentWriteRefusal` validates v2 only, so a v1 record handed to a
    // writer (an older caller, a fixture) is migrated first: the stored row is
    // always the current shape, never a v1 record the next read has to upgrade
    // again.
    const fs = createFakeFs();
    const legacy = {
      schemaVersion: 1,
      fleetId,
      taskIds: ["bd-12"],
      createdAt: 1_000,
      updatedAt: 2_000,
    } as unknown as FleetIntent;

    expect(writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent: legacy, fs })).toEqual({
      ok: true,
    });
    expect(fs.store.readFleet(fleetId)).toHaveProperty("value.intent", {
      schemaVersion: FLEET_SCHEMA_VERSION,
      fleetId,
      taskIds: ["bd-12"],
      createdAt: 1_000,
      updatedAt: 2_000,
      baseBranch: "main",
      publish: { mode: "local" },
    });

    // A legacy record that names its own base branch keeps it verbatim.
    const named = { ...legacy, baseBranch: "develop", updatedAt: 3_000 };
    expect(writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent: named, fs })).toEqual({
      ok: true,
    });
    const stored = fs.store.readFleet(fleetId);
    expect(stored).toHaveProperty("value.intent.schemaVersion", FLEET_SCHEMA_VERSION);
    expect(stored).toHaveProperty("value.intent.baseBranch", "develop");
    expect(stored).toHaveProperty("value.intent.publish", { mode: "local" });

    // Migration never upgrades an invalid record into a valid one: a v1 record over
    // a v1 bound is still refused, and the previous row survives.
    const before = stored.ok ? stored.value?.intent : undefined;
    const overBound = {
      ...legacy,
      taskIds: Array.from(
        { length: FLEET_INTENT_MEMBERS_MAX + 1 },
        (_, index) => `bd-${1000 + index}`,
      ),
    } as unknown as FleetIntent;
    const refused = writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent: overBound, fs });
    expect(refused).toHaveProperty("ok", false);
    if (refused.ok) return;
    expect(refused.error).toContain("invalid fleet intent");
    expect(fs.store.readFleet(fleetId)).toHaveProperty("value.intent", before);
  });

  it("runs each update against the row the transaction just read", () => {
    // bd-281: the updater runs inside `BEGIN IMMEDIATE`, so an update computed from
    // a stale snapshot still composes on a newer row instead of clobbering it.
    const fs = createFakeFs();
    const base = createFleetIntent({ fleetId, taskIds: ["bd-12"], now: 1_000 });
    writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent: base, fs });

    // The first writer lands an operator edit after this caller read the row.
    const snapshot = readFleetIntent({ gitCommonDir: commonDir, fleetId, fs });
    expect(snapshot).toHaveProperty("intent.taskIds", ["bd-12"]);
    updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: (current) => ({ ...(current ?? base), note: "operator edit", updatedAt: 2_000 }),
    });

    const updated = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: (current) => ({ ...(current ?? base), paused: true }),
    });

    expect(updated).toHaveProperty("ok", true);
    if (!updated.ok) return;
    // Both writes survive: the second updater saw the note it never read itself.
    expect(updated.intent).toHaveProperty("note", "operator edit");
    expect(updated.intent).toHaveProperty("paused", true);
    expect(fs.store.readFleet(fleetId)).toHaveProperty("value.revision", 3);
  });
  // Compare-and-replace: the concurrent write is not clobbered.
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

  it("drops a landed member's release entry (bd-166)", () => {
    const intent: FleetIntent = {
      ...createFleetIntent({ fleetId, taskIds: ["bd-12", "bd-15"], now: 1_000 }),
      released: [
        { taskId: "bd-12", reason: "operator-release", at: 1_100 },
        { taskId: "bd-15", reason: "run-halted", at: 1_200 },
      ],
    };

    const pruned = pruneLandedFleetMember(intent, "bd-12", 2_000);
    // The member is gone, so a release that skipped its slot describes nothing; the
    // sibling's release is untouched.
    expect(pruned.released).toEqual([{ taskId: "bd-15", reason: "run-halted", at: 1_200 }]);
    expect(pruned.taskIds).toEqual(["bd-15"]);
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
    // schema, so no caller can brick the fleet row with a record that only shows up
    // as `corrupt-intent` afterwards. One over-bound write is enough to lose the
    // fleet intent permanently.
    const fs = createFakeFs();
    const base = createFleetIntent({ fleetId, taskIds: ["bd-12"], now: 1_000 });
    writeFleetIntent({ gitCommonDir: commonDir, fleetId, intent: base, fs });
    const before = fs.store.readFleet(fleetId);
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
    expect(fs.store.readFleet(fleetId)).toEqual(before);

    const updated = updateFleetIntent({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: () => overBound,
    });
    expect(updated).toHaveProperty("reason", "write-failed");
    if (updated.ok) return;
    expect(updated.error).toContain("invalid fleet intent");
    // The row is untouched and still readable.
    expect(fs.store.readFleet(fleetId)).toEqual(before);
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

describe("fleet audit rows", () => {
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

  function storedActions(fs: ReturnType<typeof createFakeFs>, id = fleetId): string[] {
    const rows = fs.store.readAudit({ fleetId: id });
    if (!rows.ok) throw new Error(rows.error);
    return rows.value.map((row) => (row.payload as { action: string }).action);
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

    // bd-281: three rows in append order, not three lines in a file.
    expect(storedActions(fs)).toEqual(["dispatch", "note", "merge"]);
  });

  it("bounds detail length so one message cannot bloat the row", () => {
    const fs = createFakeFs();
    appendFleetAuditEntry({
      gitCommonDir: commonDir,
      fleetId,
      entry: entry({ detail: "x".repeat(10_000) }),
      fs,
    });

    const row = fs.store.readAudit({ fleetId });
    if (!row.ok) throw new Error(row.error);
    const record = row.value[0]?.payload as { detail: string };
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

    const row = fs.store.readAudit({ fleetId });
    if (!row.ok) throw new Error(row.error);
    const record = row.value[0]?.payload as {
      actor: string;
      action: string;
      taskIds: string[];
    };
    expect(record.actor.length).toBe(FLEET_AUDIT_ACTOR_MAX_LENGTH);
    expect(record.action.length).toBe(FLEET_AUDIT_ACTION_MAX_LENGTH);
    expect(record.taskIds).toHaveLength(FLEET_AUDIT_TASK_IDS_MAX);
    expect(record.actor.endsWith("…")).toBe(true);
    expect(record.action.endsWith("…")).toBe(true);
  });

  it("bounds each task id so one id cannot bloat the entry", () => {
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
    fs.store = {
      ...fs.store,
      appendAudit: () => ({ ok: false, error: "EROFS: read-only file system" }),
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

    const row = fs.store.readAudit({ fleetId: ".._evil" });
    if (!row.ok) throw new Error(row.error);
    expect((row.value[0]?.payload as { fleetId: string }).fleetId).toBe(".._evil");
  });

  it("reads recent entries from the tail, filtered by window and action", () => {
    const fs = createFakeFs();
    for (const [timestamp, action] of [
      [900, "supervisor-readopt-refused"],
      [1_500, "merge"],
      [2_000, "supervisor-readopt-refused"],
    ] as const) {
      appendFleetAuditEntry({
        gitCommonDir: commonDir,
        fleetId,
        entry: entry({ timestamp, action }),
        fs,
      });
    }

    const recent = readRecentFleetAuditEntries({
      gitCommonDir: commonDir,
      fleetId,
      since: 1_000,
      action: "supervisor-readopt-refused",
      fs,
    });

    expect(recent.map((record) => record.timestamp)).toEqual([2_000]);
    // Without an action filter the window decides.
    expect(
      readRecentFleetAuditEntries({ gitCommonDir: commonDir, fleetId, since: 1_000, fs }).map(
        (record) => record.action,
      ),
    ).toEqual(["merge", "supervisor-readopt-refused"]);
  });

  it("skips a malformed stored row and an absent fleet instead of failing the read", () => {
    const fs = createFakeFs();
    appendFleetAuditEntry({
      gitCommonDir: commonDir,
      fleetId,
      entry: entry({ timestamp: 9_000 }),
      fs,
    });
    // A row this reader cannot parse is skipped, never thrown: the alarm it feeds is a
    // dedup signal, not authority.
    fs.store.appendAudit({ fleetId, entry: { timestamp: 1, action: "torn" } });

    expect(
      readRecentFleetAuditEntries({ gitCommonDir: commonDir, fleetId, since: 0, fs }),
    ).toHaveLength(1);
    expect(
      readRecentFleetAuditEntries({ gitCommonDir: commonDir, fleetId: "absent", since: 0, fs }),
    ).toEqual([]);
  });

  it("bounds the read by rows, not by bytes", () => {
    const fs = createFakeFs();
    const total = REPO_STATE_AUDIT_TAIL_ROWS + 5;
    for (let index = 0; index < total; index += 1) {
      appendFleetAuditEntry({
        gitCommonDir: commonDir,
        fleetId,
        entry: entry({ timestamp: index, action: `action-${index}` }),
        fs,
      });
    }

    const recent = readRecentFleetAuditEntries({ gitCommonDir: commonDir, fleetId, since: 0, fs });
    // The store's row window, oldest-first within it: the first five rows fell out.
    expect(recent).toHaveLength(REPO_STATE_AUDIT_TAIL_ROWS);
    expect(recent[0]?.action).toBe("action-5");
    expect(recent.at(-1)?.action).toBe(`action-${total - 1}`);
  });
});

describe("mailbox notes (store rows)", () => {
  /** One enqueue with the fixture's default note; `channel` decides the mailbox. */
  function enqueue(
    fs: FakeFs,
    overrides: Partial<FleetNote> = {},
    channel: "event" | "inbox" = "inbox",
  ) {
    return enqueueNote({
      gitCommonDir: commonDir,
      fleetId,
      channel,
      note: sampleNote(overrides),
      fs,
    });
  }

  /** Every stored note, both channels, in seq order. */
  function storedNotes(fs: FakeFs) {
    const events = fs.store.drainNotes({ fleetId, channel: "event" });
    const inbox = fs.store.drainNotes({ fleetId, channel: "inbox" });
    if (!events.ok || !inbox.ok) throw new Error("store drain failed");
    return [...events.value, ...inbox.value];
  }

  it("stores one row and audits it in the same transaction", () => {
    const fs = createFakeFs();
    const enqueued = enqueue(fs);
    expect(enqueued).toHaveProperty("ok", true);
    if (!enqueued.ok) return;

    const rows = storedNotes(fs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: enqueued.seq,
      channel: "inbox",
      target: "supervisor",
      from: "bd-12",
      kind: "note",
      body: "plan phase finished",
    });
    // Nothing is written under the fleet directory any more.
    expect(fs.files.size).toBe(0);
    const audit = fs.store.readAudit({ fleetId });
    expect(audit).toHaveProperty("value.length", 1);
    expect(audit).toHaveProperty("value.0.payload.action", "note");
  });

  it("truncates an over-long body, the only repair a write makes", () => {
    const fs = createFakeFs();
    const enqueued = enqueue(fs, { body: "b".repeat(FLEET_NOTE_BODY_MAX_LENGTH + 500) });
    expect(enqueued).toHaveProperty("ok", true);

    const rows = storedNotes(fs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body.length).toBe(FLEET_NOTE_BODY_MAX_LENGTH);
    expect(rows[0]?.body.endsWith("…")).toBe(true);
  });

  it("rejects a malformed note at insert instead of quarantining it at drain", () => {
    const fs = createFakeFs();

    for (const createdAt of ["../../evil", Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const enqueued = enqueue(fs, { createdAt: createdAt as unknown as number });
      expect(enqueued).toHaveProperty("ok", false);
    }
    // A missing address is refused too: the row needs both ends of the address.
    for (const overrides of [
      { from: "" },
      { to: "" },
      { to: "t".repeat(FLEET_NOTE_ADDRESS_MAX_LENGTH + 1) },
    ]) {
      const refused = enqueue(fs, overrides);
      expect(refused).toHaveProperty("ok", false);
      if (refused.ok) return;
      expect(refused.error).toContain("invalid fleet note");
    }

    // Nothing became a row, so no drain can ever report a corrupt note: the refusal
    // replaced the `.corrupt` quarantine rather than moving it later.
    expect(storedNotes(fs)).toEqual([]);
    expect(fs.store.readAudit({ fleetId })).toHaveProperty("value.length", 0);
  });

  it("round-trips through enqueue and drain without marking the note acked", () => {
    const fs = createFakeFs();
    const note = sampleNote();
    const enqueued = enqueue(fs, note);
    expect(enqueued).toHaveProperty("ok", true);
    if (!enqueued.ok) return;

    const drained = drainNotes({ gitCommonDir: commonDir, fleetId, channel: "inbox", fs });
    expect(drained).toHaveProperty("ok", true);
    if (!drained.ok) return;
    expect(drained.deliveries).toHaveLength(1);
    expect(drained.deliveries[0]?.note).toEqual(note);
    expect(drained.deliveries[0]?.seq).toBe(enqueued.seq);
    expect(drained.warnings).toEqual([]);

    // Re-draining replays the note (at-least-once), never loses it.
    const again = drainNotes({ gitCommonDir: commonDir, fleetId, channel: "inbox", fs });
    expect(again).toHaveProperty("ok", true);
    if (!again.ok) return;
    expect(again.deliveries.map((delivery) => delivery.seq)).toEqual([enqueued.seq]);
  });

  it("drains in enqueue (seq) order", () => {
    const fs = createFakeFs();
    const first = enqueue(fs, { createdAt: 2, to: "bd-12" });
    const second = enqueue(fs, { createdAt: 1, to: "bd-15" });
    const third = enqueue(fs, { createdAt: 3, to: "bd-15", kind: "pause" });
    if (!first.ok || !second.ok || !third.ok) throw new Error("enqueue failed");

    const drained = drainNotes({ gitCommonDir: commonDir, fleetId, channel: "inbox", fs });
    expect(drained).toHaveProperty("ok", true);
    if (!drained.ok) return;
    expect(drained.deliveries.map((delivery) => delivery.seq)).toEqual([
      first.seq,
      second.seq,
      third.seq,
    ]);
  });

  it("narrows a drain by channel, target and fleet", () => {
    const fs = createFakeFs();
    enqueue(fs, { to: "bd-12" }, "event");
    enqueue(fs, { to: "bd-15" }, "event");
    enqueue(fs, { to: "supervisor" }, "inbox");

    const addressed = drainNotes({
      gitCommonDir: commonDir,
      fleetId,
      channel: "event",
      target: "bd-15",
      fs,
    });
    expect(addressed).toHaveProperty("ok", true);
    if (!addressed.ok) return;
    expect(addressed.deliveries.map((delivery) => delivery.note.to)).toEqual(["bd-15"]);

    const otherFleet = drainNotes({
      gitCommonDir: commonDir,
      fleetId: "absent",
      channel: "event",
      fs,
    });
    expect(otherFleet).toEqual({ ok: true, deliveries: [], warnings: [] });
  });

  it("reports an unavailable store as an error value, never as an empty mailbox", () => {
    const fs = createFakeFs();
    enqueue(fs);
    const drained = drainNotes({
      gitCommonDir: commonDir,
      fleetId,
      channel: "inbox",
      fs: {
        ...fs,
        store: {
          ...fs.store,
          drainNotes: () => ({ ok: false, error: "EIO: simulated read failure" }),
        },
      },
    });
    // "I could not read" must never read as "there is no mail".
    expect(drained).toHaveProperty("ok", false);
  });

  it("acknowledges drained notes once, idempotently, by seq", () => {
    const fs = createFakeFs();
    const enqueued = enqueue(fs);
    if (!enqueued.ok) throw new Error("enqueue failed");

    const drained = drainNotes({ gitCommonDir: commonDir, fleetId, channel: "inbox", fs });
    if (!drained.ok) throw new Error("drain failed");

    expect(
      ackNotes({ gitCommonDir: commonDir, fleetId, deliveries: drained.deliveries, fs }),
    ).toEqual({
      ok: true,
      acked: [enqueued.seq],
    });
    // A crash between drain and ack replays the note; a repeated ack is still success.
    expect(
      ackNotes({ gitCommonDir: commonDir, fleetId, deliveries: drained.deliveries, fs }),
    ).toEqual({
      ok: true,
      acked: [],
    });
    expect(drainNotes({ gitCommonDir: commonDir, fleetId, channel: "inbox", fs })).toEqual({
      ok: true,
      deliveries: [],
      warnings: [],
    });
  });

  it("refuses to acknowledge a seq belonging to another fleet", () => {
    const fs = createFakeFs();
    enqueue(fs);
    const drained = drainNotes({ gitCommonDir: commonDir, fleetId, channel: "inbox", fs });
    if (!drained.ok) throw new Error("drain failed");

    // The row key is (fleet, seq): a borrowed seq acknowledges nothing, which is the
    // guarantee the path-containment check used to provide.
    const acked = ackNotes({
      gitCommonDir: commonDir,
      fleetId: "other-fleet",
      deliveries: drained.deliveries,
      fs,
    });
    expect(acked).toEqual({ ok: true, acked: [] });
    expect(drainNotes({ gitCommonDir: commonDir, fleetId, channel: "inbox", fs })).toHaveProperty(
      "ok",
      true,
    );
  });

  it("reports every delivery as queued when the ack cannot commit", () => {
    const fs = createFakeFs();
    enqueue(fs);
    const drained = drainNotes({ gitCommonDir: commonDir, fleetId, channel: "inbox", fs });
    if (!drained.ok) throw new Error("drain failed");

    const acked = ackNotes({
      gitCommonDir: commonDir,
      fleetId,
      deliveries: drained.deliveries,
      fs: {
        ...fs,
        store: {
          ...fs.store,
          ackNotes: () => ({ ok: false, error: "EIO: simulated ack failure" }),
        },
      },
    });
    expect(acked).toHaveProperty("ok", false);
    if (acked.ok) return;
    expect(acked.acked).toEqual([]);
    // Nothing committed, so nothing may be reported as consumed.
    expect(acked.remaining).toEqual(drained.deliveries);
  });

  it("fans a broadcast out to one row per member, each acked exactly once (C1)", () => {
    const fs = createFakeFs();
    const broadcast = sampleNote({ from: "supervisor", to: "all", body: "main moved" });

    const fanout = enqueueNoteFanout({
      gitCommonDir: commonDir,
      fleetId,
      channel: "event",
      note: broadcast,
      recipients: ["bd-12", "bd-15"],
      fs,
    });
    expect(fanout).toHaveProperty("ok", true);
    if (!fanout.ok) return;
    expect(fanout.seqs).toHaveLength(2);
    expect(new Set(fanout.seqs).size).toBe(2);

    // Either drain order: each member sees its own row, and the sibling's row is
    // untouched until that member drains it.
    const firstDrain = drainNotes({ gitCommonDir: commonDir, fleetId, channel: "event", fs });
    if (!firstDrain.ok) throw new Error("drain failed");
    expect(firstDrain.deliveries.map((delivery) => delivery.note.to).sort()).toEqual([
      "bd-12",
      "bd-15",
    ]);
    expect(firstDrain.deliveries.every((delivery) => delivery.note.body === "main moved")).toBe(
      true,
    );

    const firstAck = ackNotes({
      gitCommonDir: commonDir,
      fleetId,
      deliveries: [firstDrain.deliveries[0] as (typeof firstDrain.deliveries)[number]],
      fs,
    });
    expect(firstAck).toHaveProperty("ok", true);

    const secondDrain = drainNotes({ gitCommonDir: commonDir, fleetId, channel: "event", fs });
    if (!secondDrain.ok) throw new Error("drain failed");
    // The sibling's copy survived the first ack: this is the property the single
    // `to: "all"` row could not provide.
    expect(secondDrain.deliveries).toHaveLength(1);
    expect(secondDrain.deliveries[0]?.note.to).not.toBe(firstDrain.deliveries[0]?.note.to);

    expect(
      ackNotes({ gitCommonDir: commonDir, fleetId, deliveries: secondDrain.deliveries, fs }),
    ).toHaveProperty("ok", true);
    expect(drainNotes({ gitCommonDir: commonDir, fleetId, channel: "event", fs })).toEqual({
      ok: true,
      deliveries: [],
      warnings: [],
    });
  });

  it("reports a partial fan-out with the recipients it did reach", () => {
    const fs = createFakeFs();
    // An unaddressable recipient stops the fan-out at insert, after the first row
    // was stored: the same partial-send a failing file write used to produce.
    const fanout = enqueueNoteFanout({
      gitCommonDir: commonDir,
      fleetId,
      channel: "event",
      note: sampleNote({ from: "supervisor", to: "all" }),
      recipients: ["bd-12", "x".repeat(FLEET_NOTE_ADDRESS_MAX_LENGTH + 1)],
      fs,
    });

    expect(fanout).toHaveProperty("ok", false);
    if (fanout.ok) return;
    expect(fanout.written).toHaveLength(1);
    // W-A: the audit derives its id list from this, so a partial broadcast names
    // the recipient whose row exists, not the intended set.
    expect(fanout.writtenRecipients).toEqual(["bd-12"]);
    expect(fanout.error).toContain("fan-out stopped at");

    const rows = storedNotes(fs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe("bd-12");
  });

  it("narrows a note kind with a real type guard, never a cast (S4)", () => {
    expect(isFleetNoteKind("rebase-hint")).toBe(true);
    for (const kind of FLEET_NOTE_KINDS) expect(isFleetNoteKind(kind)).toBe(true);
    expect(isFleetNoteKind("shutdown")).toBe(false);
    expect(isFleetNoteKind(undefined)).toBe(false);
    expect(isFleetNoteKind(7)).toBe(false);
  });

  it("keeps an unreadable row queued and reports it instead of rendering it", () => {
    const fs = createFakeFs();
    // A row written by a newer version (an unknown kind) is not mail this reader can
    // render, and dropping it would lose it: it stays queued and is named.
    const written = fs.store.enqueueNote({
      fleetId,
      channel: "event",
      target: "bd-12",
      from: "supervisor",
      kind: "shutdown",
      body: "unplugged",
      audit: { action: "note" },
    });
    expect(written).toHaveProperty("ok", true);

    const drained = drainNotes({ gitCommonDir: commonDir, fleetId, channel: "event", fs });
    expect(drained).toHaveProperty("ok", true);
    if (!drained.ok) return;
    expect(drained.deliveries).toEqual([]);
    expect(drained.warnings).toHaveLength(1);
    expect(drained.warnings[0]).toContain("unknown kind");
    expect(storedNotes(fs)).toHaveLength(1);
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

describe("fleet merge queue rows", () => {
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

  it("round-trips a queue whose lock is its own row", () => {
    const fs = createFakeFs();
    const queue = sampleQueue();

    // bd-281: the queue row never carries a lock copy; the lock is a second row and
    // the reader composes the record every consumer expects.
    expect(writeFleetMergeQueue({ gitCommonDir: commonDir, fleetId, queue, fs })).toEqual({
      ok: true,
    });
    const lock = queue.lock;
    const claimed = fs.store.acquireFleetLock({
      fleetId,
      holder: lock.holder,
      taskId: lock.taskId,
      pid: lock.pid,
      nowMs: lock.acquiredAt,
      leaseMs: lock.leaseExpiresAt - lock.acquiredAt,
    });
    expect(claimed).toHaveProperty("ok", true);
    const loaded = readFleetMergeQueue({ gitCommonDir: commonDir, fleetId, fs });
    expect(loaded).toHaveProperty("ok", true);
    if (!loaded.ok) return;
    expect(loaded.queue).toEqual(queue);
    expect(fs.store.readFleetQueue(fleetId)).toHaveProperty("value.queue.lock", null);
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

    fs.store.writeFleetQueue({ fleetId, queue: "{ nope" });
    expect(readFleetMergeQueue({ gitCommonDir: commonDir, fleetId, fs })).toHaveProperty(
      "reason",
      "corrupt-merge-queue",
    );
    expect(fs.store.readFleetQueue(fleetId)).toHaveProperty("value.queue", "{ nope");
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
        // A competing writer (lease renewal) commits between the engine's read and
        // its revision-compared write.
        fs.store.updateFleetQueue({
          fleetId,
          expectedRevision: 1,
          queue: createFleetMergeQueue(9_999),
        });
        return current ?? createFleetMergeQueue(1_000);
      },
    });

    expect(conflicted).toHaveProperty("ok", false);
    if (conflicted.ok) return;
    expect(conflicted.reason).toBe("conflict");
    expect(conflicted.error).toContain("revision conflict");
    // The competing write survives; the loser did not overwrite it.
    expect(fs.store.readFleetQueue(fleetId)).toHaveProperty(
      "value.queue",
      createFleetMergeQueue(9_999),
    );
  });

  it("refuses to replace a queue it cannot parse", () => {
    const fs = createFakeFs();
    fs.store.writeFleetQueue({ fleetId, queue: "{ nope" });

    const written = writeFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      queue: createFleetMergeQueue(1_000),
      fs,
    });
    expect(written).toHaveProperty("ok", false);
    if (written.ok) return;
    expect(written.error).toContain("refusing to replace unreadable merge queue");
    expect(fs.store.readFleetQueue(fleetId)).toHaveProperty("value.queue", "{ nope");

    const updated = updateFleetMergeQueue({
      gitCommonDir: commonDir,
      fleetId,
      fs,
      update: (current) => current ?? createFleetMergeQueue(1_000),
    });
    expect(updated).toHaveProperty("ok", false);
    if (updated.ok) return;
    expect(updated.reason).toBe("corrupt-merge-queue");
    expect(fs.store.readFleetQueue(fleetId)).toHaveProperty("value.queue", "{ nope");
  });

  it("returns an error value when the store write fails", () => {
    const fs = createFakeFs();
    fs.store = {
      ...fs.store,
      writeFleetQueue: () => ({ ok: false, error: "EXDEV: cross-device link" }),
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
    expect(fs.store.readFleetQueue(fleetId)).toHaveProperty("value", null);
  });
});

// ── Spawn markers (bd-233 review round 2) ─────────────────────────────

/** Whether a marker row exists for one member. */
function hasMarker(fs: ReturnType<typeof createFakeFs>, taskId: string): boolean {
  const row = fs.store.readLaunchMarker(taskId);
  return row.ok && row.value !== null;
}

/** Seed one marker row directly (hand-written or ownerless fixtures). */
function seedMarker(fs: ReturnType<typeof createFakeFs>, taskId: string, marker: unknown): void {
  const written = fs.store.writeLaunchMarker({ taskId, fleetId, marker });
  if (!written.ok) throw new Error(written.error);
}

describe("fleet spawn markers (bd-233)", () => {
  const now = 1_000_000;

  it("writes, reads and clears one member's marker under launch/", () => {
    const fs = createFakeFs();
    const written = writeFleetLaunchMarker({
      gitCommonDir: commonDir,
      fleetId,
      taskId: "bd-12",
      now,
      owner: "spawn-a",
      fs,
    });
    expect(written).toHaveProperty("ok", true);
    expect(hasMarker(fs, "bd-12")).toBe(true);
    expect(
      readFleetLaunchMarker({ gitCommonDir: commonDir, fleetId, taskId: "bd-12", fs }),
    ).toEqual({ schemaVersion: 1, taskId: "bd-12", startedAt: now, owner: "spawn-a" });

    const cleared = clearFleetLaunchMarker({
      gitCommonDir: commonDir,
      fleetId,
      taskId: "bd-12",
      owner: "spawn-a",
      fs,
    });
    expect(cleared).toHaveProperty("ok", true);
    expect(
      readFleetLaunchMarker({ gitCommonDir: commonDir, fleetId, taskId: "bd-12", fs }),
    ).toBeUndefined();
    // Idempotent: clearing an absent marker is success.
    expect(
      clearFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-12",
        owner: "spawn-a",
        fs,
      }),
    ).toEqual({ ok: true });
  });

  it("bounds the window by the grace and ignores an expired or corrupt marker", () => {
    const marker = { schemaVersion: 1 as const, taskId: "bd-12", startedAt: now - 1_000 };
    expect(isFleetSpawnInFlight({ marker, now })).toBe(true);
    expect(
      isFleetSpawnInFlight({
        marker: { ...marker, startedAt: now - FLEET_MEMBER_SPAWN_GRACE_MS },
        now,
      }),
    ).toBe(false);
    // No marker means no window: the git evidence decides.
    expect(isFleetSpawnInFlight({ marker: undefined, now })).toBe(false);
    expect(parseFleetLaunchMarker({ taskId: "bd-12" })).toBeUndefined();
    expect(parseFleetLaunchMarker("not a marker")).toBeUndefined();
  });

  it("reports in-flight only for a live marker, and never for another member", () => {
    const fs = createFakeFs();
    writeFleetLaunchMarker({
      gitCommonDir: commonDir,
      fleetId,
      taskId: "bd-12",
      now: now - 1_000,
      owner: "spawn-a",
      fs,
    });
    expect(fleetSpawnInFlight({ gitCommonDir: commonDir, fleetId, taskId: "bd-12", now, fs })).toBe(
      true,
    );
    expect(fleetSpawnInFlight({ gitCommonDir: commonDir, fleetId, taskId: "bd-15", now, fs })).toBe(
      false,
    );
  });

  it("refuses to clear a marker another spawn owns, and never an ownerless one", () => {
    const fs = createFakeFs();
    writeFleetLaunchMarker({
      gitCommonDir: commonDir,
      fleetId,
      taskId: "bd-12",
      now,
      owner: "spawn-b",
      fs,
    });

    // The relaunch's own clear is the only one that may end a window (round 4).
    const foreign = clearFleetLaunchMarker({
      gitCommonDir: commonDir,
      fleetId,
      taskId: "bd-12",
      owner: "spawn-a",
      fs,
    });
    expect(foreign).toHaveProperty("ok", false);
    if (foreign.ok) return;
    expect(foreign.error).toContain("spawn-b");
    expect(hasMarker(fs, "bd-12")).toBe(true);
    expect(fleetSpawnInFlight({ gitCommonDir: commonDir, fleetId, taskId: "bd-12", now, fs })).toBe(
      true,
    );

    // A hand-written or pre-owner marker still opens a window, so it must survive too:
    // a spawner that cannot prove it wrote it must not delete it.
    seedMarker(fs, "bd-15", { schemaVersion: 1, taskId: "bd-15", startedAt: now });
    const ownerless = clearFleetLaunchMarker({
      gitCommonDir: commonDir,
      fleetId,
      taskId: "bd-15",
      owner: "spawn-a",
      fs,
    });
    expect(ownerless).toHaveProperty("ok", false);
    if (ownerless.ok) return;
    expect(ownerless.error).toContain("absent");
    expect(hasMarker(fs, "bd-15")).toBe(true);
    expect(fleetSpawnInFlight({ gitCommonDir: commonDir, fleetId, taskId: "bd-15", now, fs })).toBe(
      true,
    );
  });

  it("reads an unparsable marker file as no window instead of throwing", () => {
    const fs = createFakeFs();
    seedMarker(fs, "bd-12", "{ not json");

    expect(
      readFleetLaunchMarker({ gitCommonDir: commonDir, fleetId, taskId: "bd-12", fs }),
    ).toBeUndefined();
    // A corrupt marker is a hand edit, never a permanent window: the member's own git
    // evidence decides (bd-233).
    expect(fleetSpawnInFlight({ gitCommonDir: commonDir, fleetId, taskId: "bd-12", now, fs })).toBe(
      false,
    );
  });

  it("clears the marker after a successful spawn and after a thrown one", async () => {
    const successful = createFakeFs();
    let inFlightDuringSpawn = false;
    const spawned = await withFleetLaunchMarker({
      gitCommonDir: commonDir,
      fleetId,
      taskId: "bd-12",
      now,
      fs: successful,
      spawn: async () => {
        inFlightDuringSpawn = fleetSpawnInFlight({
          gitCommonDir: commonDir,
          fleetId,
          taskId: "bd-12",
          now,
          fs: successful,
        });
        return "session-1";
      },
    });
    expect(spawned).toEqual({ ok: true, value: "session-1" });
    expect(inFlightDuringSpawn).toBe(true);
    expect(hasMarker(successful, "bd-12")).toBe(false);

    const failing = createFakeFs();
    await expect(
      withFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-15",
        now,
        fs: failing,
        spawn: async () => {
          throw new Error("spawn failed");
        },
      }),
    ).rejects.toThrow("spawn failed");
    expect(hasMarker(failing, "bd-15")).toBe(false);
  });

  it("refuses to spawn when the window cannot be recorded", async () => {
    const readOnly = createFakeFs();
    readOnly.store = {
      ...readOnly.store,
      writeLaunchMarker: () => ({ ok: false, error: "EROFS" }),
    };
    let spawned = false;
    const result = await withFleetLaunchMarker({
      gitCommonDir: commonDir,
      fleetId,
      taskId: "bd-12",
      now,
      fs: readOnly,
      spawn: async () => {
        spawned = true;
        return "never";
      },
    });
    expect(result).toHaveProperty("ok", false);
    expect(spawned).toBe(false);
  });

  it("W1: refreshes a live spawn's marker past twice the grace", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(now);
      const fs = createFakeFs();
      const inFlight: boolean[] = [];
      let release: (value: string) => void = () => undefined;
      const held = new Promise<string>((resolve) => {
        release = resolve;
      });
      const spawner = withFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-12",
        now: Date.now(),
        clock: () => Date.now(),
        fs,
        spawn: () => held,
      });

      const steps = Math.ceil(
        (2 * FLEET_MEMBER_SPAWN_GRACE_MS) / FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS,
      );
      for (let step = 0; step < steps; step += 1) {
        vi.advanceTimersByTime(FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS);
        inFlight.push(
          fleetSpawnInFlight({
            gitCommonDir: commonDir,
            fleetId,
            taskId: "bd-12",
            now: Date.now(),
            fs,
          }),
        );
      }
      // A spawn that began more than two graces ago is still inside its window, because
      // every refresh re-stamps it: the old fixed-window shape would have expired here.
      expect(Date.now() - now).toBeGreaterThanOrEqual(2 * FLEET_MEMBER_SPAWN_GRACE_MS);
      expect(inFlight.every(Boolean)).toBe(true);

      release("session-1");
      expect(await spawner).toEqual({ ok: true, value: "session-1" });
      expect(vi.getTimerCount()).toBe(0);
      expect(hasMarker(fs, "bd-12")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("S3: a failed marker clear keeps the spawn and carries the reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fs = createFakeFs();
      fs.store = {
        ...fs.store,
        clearLaunchMarker: () => ({ ok: false, error: "EACCES" }),
      };
      const spawned = await withFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-12",
        now,
        fs,
        spawn: async () => "session-1",
      });
      // Best effort: the launch succeeds, the marker expires with the grace, and the
      // launch outcome carries why the slot frees late instead of only a console line.
      expect(spawned).toHaveProperty("ok", true);
      if (!spawned.ok) return;
      expect(spawned.warning).toContain("could not be cleared");
      expect(hasMarker(fs, "bd-12")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("W1 (round 4): reports degraded protection when refreshes fail", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      vi.setSystemTime(now);
      const fs = createFakeFs();
      // The initial window write succeeds; every refresh write then fails.
      let writes = 0;
      const realWrite = fs.store.writeLaunchMarker.bind(fs.store);
      fs.store = {
        ...fs.store,
        writeLaunchMarker: (input) => {
          writes += 1;
          if (writes > 1) return { ok: false, error: "ENOSPC" };
          return realWrite(input);
        },
      };
      let release: (value: string) => void = () => undefined;
      const held = new Promise<string>((resolve) => {
        release = resolve;
      });
      const spawner = withFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-12",
        now: Date.now(),
        clock: () => Date.now(),
        fs,
        spawn: () => held,
      });

      const failures = 3;
      for (let step = 0; step < failures; step += 1) {
        vi.advanceTimersByTime(FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS);
      }
      release("session-1");
      const spawned = await spawner;
      expect(spawned).toHaveProperty("ok", true);
      if (!spawned.ok) return;
      // Not console-only: the spawn outcome carries the degraded window and its cause.
      expect(spawned.warning).toContain("spawn window protection degraded");
      expect(spawned.warning).toContain("3 marker refresh attempt(s) failed");
      expect(spawned.warning).toContain("ENOSPC");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("W1 (round 4): a stale spawn's clear never deletes a newer spawn's marker", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      vi.setSystemTime(now);
      const fs = createFakeFs();
      let releaseA: (value: string) => void = () => undefined;
      let releaseB: (value: string) => void = () => undefined;
      const heldA = new Promise<string>((resolve) => {
        releaseA = resolve;
      });
      const heldB = new Promise<string>((resolve) => {
        releaseB = resolve;
      });
      const base = {
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-12",
        now,
        clock: () => Date.now(),
        fs,
      };
      // A relaunch (B) overwrites A's marker with its own owner token.
      const spawnerA = withFleetLaunchMarker({ ...base, spawn: () => heldA });
      const spawnerB = withFleetLaunchMarker({ ...base, spawn: () => heldB });
      const ownerAfterRelaunch = readFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-12",
        fs,
      })?.owner;
      expect(ownerAfterRelaunch).toBeDefined();

      // A's next refresh must not steal the window back from B.
      vi.advanceTimersByTime(FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS);
      expect(
        readFleetLaunchMarker({ gitCommonDir: commonDir, fleetId, taskId: "bd-12", fs })?.owner,
      ).toBe(ownerAfterRelaunch);

      releaseA("session-a");
      const spawnedA = await spawnerA;
      expect(spawnedA).toHaveProperty("ok", true);
      if (!spawnedA.ok) return;
      // A's refresh stopped and its clear refused: the marker on disk belongs to B.
      expect(spawnedA.warning).toContain("spawn window protection degraded");
      expect(spawnedA.warning).toContain("another spawn");
      expect(
        fleetSpawnInFlight({ gitCommonDir: commonDir, fleetId, taskId: "bd-12", now, fs }),
      ).toBe(true);

      releaseB("session-b");
      expect(await spawnerB).toEqual({ ok: true, value: "session-b" });
      expect(hasMarker(fs, "bd-12")).toBe(false);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("W1: a marker with no refresh expires, and the timer never leaks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(now);
      const unrefreshed = createFakeFs();
      writeFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-15",
        now,
        owner: "spawn-a",
        fs: unrefreshed,
      });
      vi.advanceTimersByTime(2 * FLEET_MEMBER_SPAWN_GRACE_MS);
      // No wrapper, so nothing refreshed it: a full grace with no write is abandonment.
      expect(
        fleetSpawnInFlight({
          gitCommonDir: commonDir,
          fleetId,
          taskId: "bd-15",
          now: Date.now(),
          fs: unrefreshed,
        }),
      ).toBe(false);

      // Success, throw, and a refused marker write all leave no interval behind.
      const success = await withFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-12",
        now: Date.now(),
        clock: () => Date.now(),
        fs: createFakeFs(),
        spawn: async () => "session-1",
      });
      expect(success).toHaveProperty("ok", true);
      expect(vi.getTimerCount()).toBe(0);

      await expect(
        withFleetLaunchMarker({
          gitCommonDir: commonDir,
          fleetId,
          taskId: "bd-15",
          now: Date.now(),
          clock: () => Date.now(),
          fs: createFakeFs(),
          spawn: async () => {
            throw new Error("spawn failed");
          },
        }),
      ).rejects.toThrow("spawn failed");
      expect(vi.getTimerCount()).toBe(0);

      const readOnly = createFakeFs();
      readOnly.store = {
        ...readOnly.store,
        writeLaunchMarker: () => ({ ok: false, error: "EROFS" }),
      };
      const refused = await withFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-12",
        now: Date.now(),
        clock: () => Date.now(),
        fs: readOnly,
        spawn: async () => "never",
      });
      expect(refused).toHaveProperty("ok", false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("spawn grace derivation (bd-233)", () => {
  it("derives the grace from the waits one spawn actually allows", () => {
    // The window must outlive the dependency install it protects, or a cold
    // `wt switch`/`pnpm install` would look like an abandoned spawn.
    expect(FLEET_MEMBER_SPAWN_GRACE_MS).toBe(
      WORKTREE_READY_TIMEOUT_MS + FLEET_SPAWN_RPC_ALLOWANCE_MS + FLEET_SPAWN_GRACE_MARGIN_MS,
    );
    expect(FLEET_MEMBER_SPAWN_GRACE_MS).toBeGreaterThan(WORKTREE_READY_TIMEOUT_MS);

    // Three refreshes per grace: two consecutive late refreshes (a blocked event loop)
    // still leave the marker inside the window, and every grace contains a refresh.
    expect(FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS * 2).toBeLessThan(FLEET_MEMBER_SPAWN_GRACE_MS);
    expect(FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS * 3).toBeGreaterThanOrEqual(
      FLEET_MEMBER_SPAWN_GRACE_MS,
    );
  });
});

// ── Marker id containment (bd-233 review round 3) ─────────────────────

describe("fleet launch marker ids (bd-233 W3)", () => {
  it("refuses every id that could not be one row key for a spawn marker", () => {
    for (const bad of ["..", ".", "a/b", ""]) {
      expect(fleetLaunchMarkerTaskIdRefusal(bad)).toBeDefined();
    }
  });

  it("keeps a valid bead id addressable as a marker row", () => {
    expect(fleetLaunchMarkerTaskIdRefusal("bd-12")).toBeUndefined();
    const fs = createFakeFs();
    expect(
      writeFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "bd-12",
        now: 1,
        owner: "spawn-a",
        fs,
      }),
    ).toHaveProperty("ok", true);
    expect(hasMarker(fs, "bd-12")).toBe(true);
  });

  it("reads a bad id as no marker and reports why instead of throwing", () => {
    const fs = createFakeFs();
    const warnings: string[] = [];
    expect(
      readFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "..",
        fs,
        onWarning: (message) => warnings.push(message),
      }),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("..");
    expect(warnings[0]).toContain("no spawn window");
  });

  it("refuses to write or clear under a bad id", () => {
    const fs = createFakeFs();
    expect(
      writeFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: ".",
        now: 1,
        owner: "spawn-a",
        fs,
      }),
    ).toHaveProperty("ok", false);
    expect(
      clearFleetLaunchMarker({
        gitCommonDir: commonDir,
        fleetId,
        taskId: "..",
        owner: "spawn-a",
        fs,
      }),
    ).toHaveProperty("ok", false);
  });
});
