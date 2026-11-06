import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enqueueNote, FLEET_MERGE_LEASE_MS } from "../fleet-state.js";
import {
  importLegacyFleetState,
  legacyFleetIds,
  legacyFleetStateFiles,
  legacyFleetStateRefusal,
  migrateAndGuardLegacyFleetState,
} from "../fleet-state-import.js";
import {
  claimMigrationTarget,
  importLegacyState,
  type LegacyStateFs,
  legacyStateFiles,
  legacyStateRefusal,
  migrateAndGuardLegacyState,
  nodeFsSeam,
} from "../repo-state-import.js";
import {
  classifyStoreFailure,
  openRepoStateStore,
  REPO_LEASE_STALE_MS,
  REPO_STATE_FILE_ENV,
  REPO_STATE_SCHEMA_VERSION,
  type RepoStateStore,
  type RepoWorkflowState,
  resetRepoStatePaths,
  resetSharedRepoStateStore,
  resolveRepoStatePath,
  SHARED_REPO_STATE_RETRY_MS,
  sharedRepoStateStore,
} from "../repo-state-store.js";
import { openSqliteFile, type SqliteDatabaseLike } from "../sqlite-store-open.js";
import { readWorkflowState } from "../workflow-state.js";

let dir: string;
let storePath: string;
let store: RepoStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "belayd-repo-state-"));
  storePath = join(dir, "state.sqlite");
  const opened = openRepoStateStore({ path: storePath });
  if (!opened.ok) throw new Error(opened.error);
  store = opened.store;
});

afterEach(() => {
  store.close();
  resetSharedRepoStateStore();
  rmSync(dir, { recursive: true, force: true });
});

function workflowState(overrides: Partial<RepoWorkflowState> = {}): RepoWorkflowState {
  return {
    taskId: "bd-42",
    workflowType: "feature",
    branch: "feat/bd-42",
    originalCwd: "/repo.feat-bd-42",
    phaseOrder: ["scout", "plan"],
    completedPhaseNames: [],
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("schema", () => {
  it("creates the schema once and reopens idempotently", () => {
    const reopened = openRepoStateStore({ path: storePath });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) reopened.store.close();

    const rows = store.readFleet("fleet-a");
    expect(rows).toEqual({ ok: true, value: null });
  });

  it("records the schema version in user_version", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(storePath);
    const row = database.prepare("PRAGMA user_version").get() as { user_version?: number };
    database.close();
    expect(row.user_version).toBe(REPO_STATE_SCHEMA_VERSION);
  });

  it("opens a real file in WAL mode with a table for every execution fact", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    // A second handle on the same file is the two-worktree shape, and WAL is what
    // lets it read while the store writes.
    const raw = new DatabaseSync(storePath);
    const journal = raw.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    raw.close();

    expect(journal.journal_mode).toBe("wal");
    // The acceptance criterion names the facts, so the tables are asserted by name:
    // workflow state, the orchestrator lease, fleet intent/run/queue, the review
    // findings, the run manifest and the migration marker.
    expect(tables).toEqual(
      expect.arrayContaining([
        "migration",
        "workflow_state",
        "orchestrator_lease",
        "run_manifest",
        "review_findings",
        "proof_receipt",
        "fleet_intent",
        "fleet_queue",
        "fleet_lock",
        "fleet_audit",
      ]),
    );
  });
});

describe("orchestrator lease", () => {
  const leaseInput = (overrides: Partial<Parameters<RepoStateStore["acquireLease"]>[0]> = {}) => ({
    taskId: "bd-42",
    sessionId: "session-a",
    branch: "feat/bd-42",
    worktreePath: "/repo.feat-bd-42",
    pid: 100,
    nowMs: 1_000,
    ...overrides,
  });

  it("grants the lease to one of two racing sessions", () => {
    const second = openRepoStateStore({ path: storePath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const first = store.acquireLease(leaseInput());
    const loser = second.store.acquireLease(leaseInput({ sessionId: "session-b", pid: 200 }));
    second.store.close();

    expect(first.ok).toBe(true);
    expect(loser.ok).toBe(false);
    if (loser.ok) return;
    expect(loser.reason).toBe("held");
    // The loser is told who holds it, which is the whole point of the record.
    expect(loser.holder).toHaveProperty("sessionId", "session-a");
  });

  it("renews only for the owner and refuses an expired lease", () => {
    store.acquireLease(leaseInput());

    expect(
      store.heartbeatLease({ taskId: "bd-42", sessionId: "other", nowMs: 2_000 }),
    ).toHaveProperty("reason", "not-owner");
    const renewed = store.heartbeatLease({ taskId: "bd-42", sessionId: "session-a", nowMs: 2_000 });
    expect(renewed.ok).toBe(true);

    const expired = store.heartbeatLease({
      taskId: "bd-42",
      sessionId: "session-a",
      nowMs: 2_000 + REPO_LEASE_STALE_MS + 1,
    });
    expect(expired).toHaveProperty("reason", "expired");
  });

  it("reports a stale lease from the row, without reading any file", () => {
    store.acquireLease(leaseInput({ nowMs: 1_000 }));
    const now = 1_000 + REPO_LEASE_STALE_MS + 1;

    const read = store.readLease({ taskId: "bd-42" });
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) return;
    // Staleness is observable arithmetic on the row, not an inference.
    expect(read.value.expiresAt).toBeLessThan(now);
    expect(read.value.heartbeatAt).toBe(1_000);
  });

  it("takes over a cold lease only when the caller asks", () => {
    store.acquireLease(leaseInput({ nowMs: 1_000 }));
    const cold = 1_000 + REPO_LEASE_STALE_MS + 1;

    const refused = store.acquireLease(
      leaseInput({ sessionId: "session-b", nowMs: cold, taskId: "bd-99" }),
    );
    // Cold is not proof of death, so the record is still held.
    expect(refused).toHaveProperty("ok", false);

    const taken = store.acquireLease(
      leaseInput({ sessionId: "session-b", nowMs: cold, taskId: "bd-99", takeOverStale: true }),
    );
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.lease.taskId).toBe("bd-99");
    // One orchestrator per worktree: the displaced row is gone.
    expect(store.readLease({ taskId: "bd-42" })).toHaveProperty("value", null);
  });

  it("resolves the same row from a different worktree for the same task", () => {
    store.acquireLease(leaseInput({ worktreePath: "/repo.feat-bd-42" }));

    const read = store.readLease({ taskId: "bd-42" });
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) return;
    expect(read.value.taskId).toBe("bd-42");
    // Identity is the task: a second worktree looking up the worktree sees the
    // same record, which is what makes a copied lease impossible.
    expect(store.readLease({ worktreePath: "/repo.feat-bd-42" })).toHaveProperty(
      "value.taskId",
      "bd-42",
    );
  });

  it("adopts a pending lease by replacing its session id", () => {
    store.acquireLease(leaseInput({ sessionId: "pending:spawn" }));

    const adopted = store.assignLeaseSession({
      taskId: "bd-42",
      pendingSessionId: "pending:spawn",
      sessionId: "real-session",
      nowMs: 2_000,
    });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.lease.sessionId).toBe("real-session");
  });

  it("releases only the caller's own lease", () => {
    store.acquireLease(leaseInput());

    expect(store.releaseLease({ taskId: "bd-42", sessionId: "other" })).toHaveProperty(
      "value.released",
      false,
    );
    expect(store.releaseLease({ taskId: "bd-42", sessionId: "session-a" })).toHaveProperty(
      "value.released",
      true,
    );
    expect(store.readLease({ taskId: "bd-42" })).toHaveProperty("value", null);
  });
});

describe("workflow record", () => {
  it("binds a worktree to the task row so a cwd-only read resolves it", () => {
    store.writeWorkflow({ state: workflowState(), worktreePath: "/repo.feat-bd-42" });

    expect(store.readWorkflow({ worktreePath: "/repo.feat-bd-42" })).toHaveProperty(
      "value.taskId",
      "bd-42",
    );
    expect(store.readWorkflow({ taskId: "bd-42" })).toHaveProperty("value.taskId", "bd-42");
  });

  it("mutates inside one transaction and reports a foreign task as a mismatch", () => {
    store.writeWorkflow({ state: workflowState(), worktreePath: "/repo.feat-bd-42" });

    const mismatch = store.mutateWorkflow({
      locator: { taskId: "bd-42" },
      expectedTaskId: "bd-99",
      update: () => ({ kind: "skip" }),
    });
    expect(mismatch).toHaveProperty("value.kind", "task-mismatch");

    const written = store.mutateWorkflow({
      locator: { taskId: "bd-42" },
      update: () => ({
        kind: "write",
        state: workflowState({ completedPhaseNames: ["scout"], updatedAt: 5_000 }),
      }),
    });
    expect(written).toHaveProperty("value.kind", "written");
    if (!written.ok || written.value.kind !== "written") return;
    expect(written.value.generation).toBe(2);
    expect(store.readWorkflow({ taskId: "bd-42" })).toHaveProperty(
      "value.state.completedPhaseNames",
      ["scout"],
    );
  });

  it("does not lose state when two handles mutate the same row", () => {
    store.writeWorkflow({ state: workflowState(), worktreePath: "/repo.feat-bd-42" });
    const reader = openRepoStateStore({ path: storePath });
    if (!reader.ok) throw new Error(reader.error);

    const append = (name: string) =>
      store.mutateWorkflow({
        locator: { taskId: "bd-42" },
        update: (current) => ({
          kind: "write",
          state: {
            ...(current?.state ?? workflowState()),
            completedPhaseNames: [...(current?.state.completedPhaseNames ?? []), name],
          },
        }),
      });

    append("scout");
    const other = reader.store.mutateWorkflow({
      locator: { taskId: "bd-42" },
      update: (current) => ({
        kind: "write",
        state: {
          ...(current?.state ?? workflowState()),
          completedPhaseNames: [...(current?.state.completedPhaseNames ?? []), "plan"],
        },
      }),
    });
    reader.store.close();

    expect(other).toHaveProperty("value.kind", "written");
    expect(store.readWorkflow({ taskId: "bd-42" })).toHaveProperty(
      "value.state.completedPhaseNames",
      ["scout", "plan"],
    );
  });
});

describe("identity is the task, never the worktree path", () => {
  it("keeps one handoff row when two worktrees write the same task's marker", () => {
    store.writeHandoff({
      taskId: "bd-101",
      handoffKey: "caller-session",
      worktreePath: "/repo.feat-bd-101",
      marker: { taskId: "bd-101", branch: "feat/bd-101", sessionId: "child" },
    });
    store.writeHandoff({
      taskId: "bd-101",
      handoffKey: "caller-session",
      worktreePath: "/repo.feat-bd-101-resumed",
      marker: { taskId: "bd-101", branch: "feat/bd-101", sessionId: "child" },
    });

    // One row, last writer recorded — a second worktree cannot create a copy.
    expect(store.countHandoffs({ handoffKey: "caller-session" })).toEqual({ ok: true, value: 1 });
    expect(store.readHandoff({ taskId: "bd-101", handoffKey: "caller-session" })).toHaveProperty(
      "value.taskId",
      "bd-101",
    );
    // A session-only locator (what a restarting caller knows) resolves the same row.
    expect(store.readHandoff({ handoffKey: "caller-session" })).toHaveProperty(
      "value.sessionId",
      "child",
    );
  });

  it("keeps one review scope per task across worktrees", () => {
    store.writeReviewScope({
      taskId: "bd-42",
      worktreePath: "/repo.feat-bd-42",
      scope: { taskId: "bd-42", sha: "aaa", untracked: [], capturedAt: 1 },
    });
    store.writeReviewScope({
      taskId: "bd-42",
      worktreePath: "/repo.feat-bd-42-resumed",
      scope: { taskId: "bd-42", sha: "bbb", untracked: [], capturedAt: 2 },
    });

    // Same task, second worktree: the newest capture replaced the record instead of
    // adding a path-keyed one for a resumed review to miss.
    expect(store.readReviewScope("bd-42")).toHaveProperty("value.sha", "bbb");
    expect(
      store.writeReviewScope({
        taskId: "bd-99",
        scope: { taskId: "bd-99", sha: "ccc", untracked: [], capturedAt: 3 },
      }),
    ).toHaveProperty("ok", true);
    expect(store.readReviewScope("bd-42")).toHaveProperty("value.sha", "bbb");
  });

  it("migrates a v1 path-keyed store to the task-keyed schema", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const legacyPath = join(dir, "v1.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE workflow_handoff (
        worktree_path TEXT NOT NULL,
        handoff_key TEXT NOT NULL,
        task_id TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (worktree_path, handoff_key)
      );
      CREATE TABLE review_scope (
        worktree_path TEXT PRIMARY KEY,
        task_id TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL,
        captured_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    legacy
      .prepare("INSERT INTO workflow_handoff VALUES (?, ?, ?, ?, ?)")
      .run("/repo", "s1", "bd-101", JSON.stringify({ taskId: "bd-101" }), 5);
    legacy
      .prepare("INSERT INTO review_scope VALUES (?, ?, ?, ?)")
      .run("/repo", "bd-42", JSON.stringify({ taskId: "bd-42", sha: "abc" }), 6);
    legacy.close();

    const opened = openRepoStateStore({ path: legacyPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The rows survived the re-key, and a path-keyed write is no longer possible.
    expect(opened.store.readHandoff({ handoffKey: "s1" })).toHaveProperty("value.taskId", "bd-101");
    expect(opened.store.readReviewScope("bd-42")).toHaveProperty("value.sha", "abc");
    opened.store.close();
  });

  it("migrates a v2 store: lock diagnostics added and the supervisor table is usable", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const legacyPath = join(dir, "v2.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE fleet_lock (
        fleet_id TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    legacy
      .prepare("INSERT INTO fleet_lock VALUES (?, ?, ?, ?)")
      .run("fleet-a", "holder-1", 1_000, 2_000);
    legacy.close();

    const opened = openRepoStateStore({ path: legacyPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The v2 holder survived; its diagnostics are the neutral values it never had.
    expect(opened.store.readFleetLock("fleet-a")).toHaveProperty("value", {
      fleetId: "fleet-a",
      holder: "holder-1",
      taskId: "",
      pid: 0,
      acquiredAt: 1_000,
      expiresAt: 2_000,
    });
    // The v3 table is created by the schema step and the beat round-trips.
    expect(opened.store.readSupervisor("fleet-a")).toHaveProperty("value", null);
    expect(
      opened.store.writeSupervisor({
        fleetId: "fleet-a",
        sessionId: "session-1",
        pid: 4242,
        heartbeatAt: 9_000,
        nowMs: 9_000,
      }),
    ).toHaveProperty("value.heartbeatAt", 9_000);
    opened.store.close();
  });

  it("migrates a v3 note queue: the author is added, delivered_at dropped, seq kept", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const legacyPath = join(dir, "v3.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE fleet_note (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        fleet_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        acked_at INTEGER
      );
      PRAGMA user_version = 3;
    `);
    legacy
      .prepare(
        "INSERT INTO fleet_note (fleet_id, channel, target, kind, body, created_at, delivered_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("fleet-a", "event", "bd-1", "note", "queued before the upgrade", 1_000, 1_500);
    legacy.close();

    const opened = openRepoStateStore({ path: legacyPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The pending note survived with its seq (the ack handle); a row that predates
    // the author column keeps an empty one rather than inventing a sender.
    const queued = opened.store.drainNotes({ fleetId: "fleet-a", channel: "event" });
    expect(queued).toHaveProperty("value.length", 1);
    expect(queued).toHaveProperty("value.0.seq", 1);
    expect(queued).toHaveProperty("value.0.from", "");
    expect(queued).toHaveProperty("value.0.body", "queued before the upgrade");
    expect(opened.store.ackNotes({ fleetId: "fleet-a", seqs: [1] })).toHaveProperty(
      "value.seqs",
      [1],
    );
    // The rebuilt table takes a current note, author included.
    expect(
      opened.store.enqueueNote({
        fleetId: "fleet-a",
        channel: "event",
        target: "bd-2",
        from: "supervisor",
        kind: "note",
        body: "after the upgrade",
        audit: { action: "note" },
      }),
    ).toHaveProperty("ok", true);
    opened.store.close();
  });
});

describe("fleet intent, run record and landing transaction", () => {
  const intent = { fleetId: "fleet-a", members: ["bd-1"] };

  it("bumps the revision on every write", () => {
    const first = store.writeFleetIntent({ fleetId: "fleet-a", intent });
    const second = store.writeFleetIntent({
      fleetId: "fleet-a",
      intent: { ...intent, paused: true },
    });

    expect(first).toHaveProperty("value.revision", 1);
    expect(second).toHaveProperty("value.revision", 2);
  });

  it("refuses a stale revision instead of overwriting a newer document", () => {
    store.writeFleetIntent({ fleetId: "fleet-a", intent });
    store.updateFleetIntent({ fleetId: "fleet-a", expectedRevision: 1, intent: { version: 2 } });

    const stale = store.updateFleetIntent({
      fleetId: "fleet-a",
      expectedRevision: 1,
      intent: { version: 3 },
    });
    expect(stale).toHaveProperty("ok", false);
    if (stale.ok) return;
    expect(stale.error).toContain("revision conflict");
    expect(store.readFleet("fleet-a")).toHaveProperty("value.intent.version", 2);
  });

  it("lands a member and appends the audit row in the same transaction", () => {
    store.writeFleetIntent({ fleetId: "fleet-a", intent });
    const landed = store.landFleetMember({
      fleetId: "fleet-a",
      plan: (current) => ({
        kind: "write",
        run: { members: [{ taskId: "bd-1", landedAt: 9_000 }] },
        intent: { ...(current.intent as object), members: [] },
      }),
      audit: { action: "land", taskId: "bd-1" },
      nowMs: 9_000,
    });

    expect(landed).toHaveProperty("value.kind", "written");
    if (!landed.ok || landed.value.kind !== "written") return;
    // Member, revision bump and audit are one commit, so a reader can never see a
    // landed member without its audit row.
    expect(landed.value.revision).toBe(2);
    expect(landed.value.run).toHaveProperty("members", [{ taskId: "bd-1", landedAt: 9_000 }]);
    expect(store.readAudit({ fleetId: "fleet-a" })).toHaveProperty("value", [
      { seq: 1, fleetId: "fleet-a", at: 9_000, payload: { action: "land", taskId: "bd-1" } },
    ]);
  });

  it("commits nothing when the landing plan refuses", () => {
    store.writeFleetIntent({ fleetId: "fleet-a", intent });
    store.appendAudit({ fleetId: "fleet-a", entry: { action: "before" } });

    const refused = store.landFleetMember({
      fleetId: "fleet-a",
      plan: () => ({ kind: "conflict", error: "merge did not apply" }),
      audit: { action: "land" },
    });

    expect(refused).toHaveProperty("value.kind", "conflict");
    expect(store.readFleet("fleet-a")).toHaveProperty("value.revision", 1);
    // The audit row of the refused landing must not exist: no partial landing.
    expect(store.readAudit({ fleetId: "fleet-a" })).toHaveProperty("value.length", 1);
  });
});

describe("fleet merge queue and single-flight lock", () => {
  it("claims the lock once and reports the holder to the loser", () => {
    const first = store.acquireFleetLock({
      fleetId: "fleet-a",
      holder: "holder-1",
      taskId: "bd-1",
      pid: 4242,
      nowMs: 1_000,
      leaseMs: 5_000,
    });
    const second = openRepoStateStore({ path: storePath });
    if (!second.ok) throw new Error(second.error);
    const loser = second.store.acquireFleetLock({
      fleetId: "fleet-a",
      holder: "holder-2",
      taskId: "bd-1",
      pid: 4243,
      nowMs: 1_000,
      leaseMs: 5_000,
    });
    second.store.close();

    expect(first.ok).toBe(true);
    expect(loser.ok).toBe(false);
    if (loser.ok) return;
    expect(loser).toHaveProperty("holder", "holder-1");
  });

  it("refuses to displace a holder that claimed between its read and its write", () => {
    const opened = openSqliteFile({
      path: ":memory:",
      readOnly: false,
      label: "test store",
      schemaAttempts: 1,
      applySchema: () => {},
    });
    if (!opened.ok) throw new Error(opened.error);
    const inner = opened.value;
    let injected = false;
    // A second supervisor claims the row in the exact window this acquire's read-
    // then-write would leave open. Only the guarded upsert (the `WHERE` on the
    // lease) survives it, so this fails if the claim ever loses that guard.
    const database: SqliteDatabaseLike = {
      exec: (sql) => inner.exec(sql),
      prepare: (sql) => {
        const statement = inner.prepare(sql);
        return {
          run: (...params) => {
            if (!injected && sql.includes("INSERT INTO fleet_lock")) {
              injected = true;
              inner
                .prepare(
                  `INSERT INTO fleet_lock (fleet_id, holder, task_id, pid, acquired_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run("fleet-a", "session-b", "bd-2", 222, 1_000, 6_000);
            }
            return statement.run(...params);
          },
          get: (...params) => statement.get(...params),
          all: (...params) => statement.all(...params),
        };
      },
      close: () => inner.close(),
    };
    const contender = openRepoStateStore({ path: ":memory:", database });
    if (!contender.ok) throw new Error(contender.error);

    const outcome = contender.store.acquireFleetLock({
      fleetId: "fleet-a",
      holder: "session-a",
      taskId: "bd-1",
      pid: 111,
      nowMs: 1_000,
      leaseMs: 5_000,
    });
    contender.store.close();

    expect(injected).toBe(true);
    // The loser is refused and told who holds it, exactly as a second session at
    // the same instant would be: one row, one live holder.
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome).toHaveProperty("reason", "held");
    expect(outcome).toHaveProperty("holder", "session-b");
  });

  it("releases on expiry so a crashed holder cannot block the queue", () => {
    store.acquireFleetLock({
      fleetId: "fleet-a",
      holder: "holder-1",
      taskId: "bd-1",
      pid: 4242,
      nowMs: 1_000,
      leaseMs: 5_000,
    });

    const taken = store.acquireFleetLock({
      fleetId: "fleet-a",
      holder: "holder-2",
      taskId: "bd-1",
      pid: 4243,
      nowMs: 6_000,
      leaseMs: 5_000,
    });
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.lock.holder).toBe("holder-2");
  });

  it("renews only for the holder and releases only for the holder", () => {
    store.acquireFleetLock({
      fleetId: "fleet-a",
      holder: "holder-1",
      taskId: "bd-1",
      pid: 4242,
      nowMs: 1_000,
      leaseMs: 5_000,
    });

    expect(
      store.renewFleetLock({ fleetId: "fleet-a", holder: "other", nowMs: 2_000, leaseMs: 5_000 }),
    ).toHaveProperty("ok", false);
    expect(
      store.renewFleetLock({
        fleetId: "fleet-a",
        holder: "holder-1",
        nowMs: 2_000,
        leaseMs: 5_000,
      }),
    ).toHaveProperty("ok", true);
    expect(store.releaseFleetLock({ fleetId: "fleet-a", holder: "other" })).toHaveProperty(
      "value.released",
      false,
    );
  });

  it("transitions the queue by revision", () => {
    store.writeFleetQueue({ fleetId: "fleet-a", queue: { entries: [] } });
    const updated = store.updateFleetQueue({
      fleetId: "fleet-a",
      expectedRevision: 1,
      queue: { entries: [{ taskId: "bd-1" }] },
    });
    expect(updated).toHaveProperty("value.revision", 2);

    const stale = store.updateFleetQueue({
      fleetId: "fleet-a",
      expectedRevision: 1,
      queue: { entries: [] },
    });
    expect(stale).toHaveProperty("ok", false);
  });
});

describe("fleet notes", () => {
  function enqueue(
    overrides: Partial<{
      channel: "event" | "inbox";
      kind: string;
      body: string;
      target: string;
      from: string;
    }> = {},
  ) {
    return store.enqueueNote({
      fleetId: "fleet-a",
      channel: "event",
      target: "bd-1",
      from: "supervisor",
      kind: "landed",
      body: "bd-1",
      audit: { action: "note" },
      ...overrides,
    });
  }

  it("drains at-least-once and acks idempotently", () => {
    enqueue();
    enqueue({ channel: "inbox", target: "supervisor", from: "bd-1", kind: "ask", body: "hi" });

    const first = store.drainNotes({ fleetId: "fleet-a", channel: "event" });
    expect(first).toHaveProperty("value.length", 1);
    expect(first).toHaveProperty("value.0.from", "supervisor");
    expect(first).toHaveProperty("value.0.target", "bd-1");
    // Draining does not delete: a consumer that dies before acking sees it again.
    const second = store.drainNotes({ fleetId: "fleet-a", channel: "event" });
    expect(second).toHaveProperty("value.length", 1);

    const acked = store.ackNotes({ fleetId: "fleet-a", seqs: [1], nowMs: 3_000 });
    expect(acked).toHaveProperty("value.acked", 1);
    expect(acked).toHaveProperty("value.seqs", [1]);
    const repeat = store.ackNotes({ fleetId: "fleet-a", seqs: [1], nowMs: 4_000 });
    expect(repeat).toHaveProperty("value.acked", 0);
    expect(repeat).toHaveProperty("value.seqs", []);
    expect(store.drainNotes({ fleetId: "fleet-a", channel: "event" })).toHaveProperty(
      "value.length",
      0,
    );
    // The other channel is untouched.
    expect(store.drainNotes({ fleetId: "fleet-a", channel: "inbox" })).toHaveProperty(
      "value.length",
      1,
    );
  });

  it("scopes an ack by fleet, so a borrowed seq is not acknowledged", () => {
    enqueue();
    const other = store.ackNotes({ fleetId: "fleet-b", seqs: [1] });
    expect(other).toHaveProperty("value.acked", 0);
    expect(store.drainNotes({ fleetId: "fleet-a", channel: "event" })).toHaveProperty(
      "value.length",
      1,
    );
  });

  it("audits the note in the same transaction as the insert", () => {
    enqueue({ body: "main moved" });
    const tail = store.readAudit({ fleetId: "fleet-a" });
    expect(tail).toHaveProperty("value.length", 1);
    expect(tail).toHaveProperty("value.0.payload.action", "note");
  });

  it("truncates a long body instead of rejecting it", () => {
    const written = enqueue({ kind: "long", body: "x".repeat(5_000) });
    expect(written).toHaveProperty("ok", true);
    if (!written.ok) return;
    expect(written.note.body).toHaveLength(2_000);
  });

  it("rejects a malformed note at insert, leaving no row and no audit line", () => {
    const written = enqueue({ kind: " " });
    expect(written).toHaveProperty("ok", false);
    if (written.ok) return;
    expect(written.reason).toBe("invalid-note");
    expect(store.drainNotes({ fleetId: "fleet-a", channel: "event" })).toHaveProperty(
      "value.length",
      0,
    );
    expect(store.readAudit({ fleetId: "fleet-a" })).toHaveProperty("value.length", 0);
  });

  it("rejects a note with no address or author", () => {
    expect(enqueue({ target: "" })).toHaveProperty("ok", false);
  });
});

describe("fleet audit", () => {
  it("reads a bounded tail in chronological order", () => {
    for (let index = 1; index <= 5; index += 1) {
      store.appendAudit({ fleetId: "fleet-a", entry: { index }, nowMs: index });
    }

    const tail = store.readAudit({ fleetId: "fleet-a", limit: 2 });
    expect(tail).toHaveProperty("value.length", 2);
    if (!tail.ok) return;
    expect(tail.value.map((row) => row.payload)).toEqual([{ index: 4 }, { index: 5 }]);
  });

  it("keeps fleets apart", () => {
    store.appendAudit({ fleetId: "fleet-a", entry: { a: 1 } });
    store.appendAudit({ fleetId: "fleet-b", entry: { b: 1 } });

    expect(store.readAudit({ fleetId: "fleet-b" })).toHaveProperty("value.length", 1);
  });
});

describe("run manifests", () => {
  it("round-trips and enforces the row key as authority (bd-242)", () => {
    const payload = { runId: "run-1", taskId: "bd-42", status: "running" };
    store.writeRun({ runId: "run-1", payload });

    expect(store.readRun("run-1")).toHaveProperty("value.payload", payload);

    const mismatched = store.writeRun({ runId: "run-2", payload });
    expect(mismatched).toHaveProperty("ok", false);
    expect(store.readRun("run-2")).toHaveProperty("value", null);
  });

  it("rejects an unsafe run id", () => {
    expect(store.writeRun({ runId: "../escape", payload: {} })).toHaveProperty("ok", false);
  });

  it("mutates a run inside one transaction", () => {
    store.writeRun({ runId: "run-1", payload: { runId: "run-1", status: "running" } });

    const updated = store.mutateRun({
      runId: "run-1",
      update: (current) => ({
        kind: "write",
        payload: { ...(current?.payload as object), status: "completed" },
      }),
    });
    expect(updated).toHaveProperty("value.payload.status", "completed");
  });

  it("lists runs in update order", () => {
    store.writeRun({ runId: "run-1", payload: { runId: "run-1" }, nowMs: 1_000 });
    store.writeRun({ runId: "run-2", payload: { runId: "run-2" }, nowMs: 2_000 });

    const runs = store.listRuns();
    expect(runs.ok).toBe(true);
    if (!runs.ok) return;
    expect(runs.value.map((row) => row.runId)).toEqual(["run-1", "run-2"]);
  });
});

describe("read-only and failure modes", () => {
  it("reads without writing and refuses every write", () => {
    store.writeWorkflow({ state: workflowState(), worktreePath: "/repo.feat-bd-42" });
    const readonly = openRepoStateStore({ path: storePath, readOnly: true });
    expect(readonly.ok).toBe(true);
    if (!readonly.ok) return;

    expect(readonly.store.readWorkflow({ taskId: "bd-42" })).toHaveProperty(
      "value.taskId",
      "bd-42",
    );
    expect(
      readonly.store.writeWorkflow({ state: workflowState(), worktreePath: "/repo" }),
    ).toHaveProperty("ok", false);
    readonly.store.close();
  });

  it("reports a read-only open of a missing file as unopenable", () => {
    const missing = openRepoStateStore({ path: join(dir, "absent.sqlite"), readOnly: true });
    expect(missing).toHaveProperty("ok", false);
  });

  it("classifies a bad path as a permanent failure", () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    const opened = openRepoStateStore({ path: join(blocked, "state.sqlite") });

    expect(opened).toHaveProperty("ok", false);
    if (opened.ok) return;
    expect(classifyStoreFailure(opened.error)).toBe("permanent");
  });

  it("refuses to write after close", () => {
    store.close();
    expect(store.writeWorkflow({ state: workflowState(), worktreePath: "/repo" })).toHaveProperty(
      "ok",
      false,
    );
  });
});

describe("path resolution", () => {
  it("honours BELAYD_REPO_STATE_FILE", () => {
    resetRepoStatePaths();
    const resolved = resolveRepoStatePath({
      cwd: "/repo",
      env: { [REPO_STATE_FILE_ENV]: "/tmp/override.sqlite" },
    });
    expect(resolved).toEqual({ ok: true, value: "/tmp/override.sqlite" });
  });

  it("resolves <git-common-dir>/belayd/state.sqlite and caches it", () => {
    resetRepoStatePaths();
    let probes = 0;
    const resolver = () => {
      probes += 1;
      return { ok: true as const, commonDir: "/repo/.git" };
    };

    expect(resolveRepoStatePath({ cwd: "/repo/wt", env: {}, resolveCommonDir: resolver })).toEqual({
      ok: true,
      value: "/repo/.git/belayd/state.sqlite",
    });
    expect(resolveRepoStatePath({ cwd: "/repo/wt", env: {}, resolveCommonDir: resolver })).toEqual({
      ok: true,
      value: "/repo/.git/belayd/state.sqlite",
    });
    expect(probes).toBe(1);
  });

  it("refuses to invent a worktree-local store outside a git repository", () => {
    resetRepoStatePaths();
    const resolved = resolveRepoStatePath({
      cwd: "/tmp/not-a-repo",
      env: {},
      resolveCommonDir: () => ({ ok: false, error: "not a git repository" }),
    });
    // A store inside the worktree is forbidden, and it would re-create the
    // copied-state bug: no common dir means no store, reported as an error.
    expect(resolved).toHaveProperty("ok", false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("needs a git common dir");
    expect(resolved.error).toContain("/tmp/not-a-repo");
    expect(resolved.error).not.toContain(".belayd");
    const opened = openRepoStateStore({
      cwd: "/tmp/not-a-repo",
      env: {},
      resolveCommonDir: () => ({ ok: false, error: "not a git repository" }),
    });
    expect(opened).toHaveProperty("ok", false);
  });
});

describe("process-global state (bd-281)", () => {
  it("keeps the migration guard per store path and per target", () => {
    const otherPath = join(dir, "other.sqlite");
    const other = openRepoStateStore({ path: otherPath });
    if (!other.ok) throw new Error(other.error);
    try {
      // The first claim takes the slot; the second call is the short-circuit that
      // keeps every store access from re-scanning a directory.
      expect(claimMigrationTarget(store, "worktree:/repo.a")).toBe(false);
      expect(claimMigrationTarget(store, "worktree:/repo.a")).toBe(true);
      // A different worktree, and the fleet half of the same worktree, are
      // different slots: one half preparing must never suppress the other.
      expect(claimMigrationTarget(store, "worktree:/repo.b")).toBe(false);
      expect(claimMigrationTarget(store, "fleet:/repo.a")).toBe(false);
      // The guard carries the store path, so a test (or an operator) that relocates
      // the store starts clean instead of inheriting another store's guard.
      expect(claimMigrationTarget(other.store, "worktree:/repo.a")).toBe(false);
    } finally {
      other.store.close();
    }
  });

  it("consults BELAYD_REPO_STATE_FILE before the cached worktree resolution", () => {
    resetRepoStatePaths();
    expect(
      resolveRepoStatePath({
        cwd: "/repo/wt",
        env: {},
        resolveCommonDir: () => ({ ok: true, commonDir: "/repo/.git" }),
      }),
    ).toEqual({ ok: true, value: "/repo/.git/belayd/state.sqlite" });

    // The override wins over the cached path and over the git probe, so an operator
    // (or a test that relocates the store) never reads a stale location.
    expect(
      resolveRepoStatePath({
        cwd: "/repo/wt",
        env: { [REPO_STATE_FILE_ENV]: "/elsewhere/state.sqlite" },
        resolveCommonDir: () => ({ ok: false, error: "must not probe git" }),
      }),
    ).toEqual({ ok: true, value: "/elsewhere/state.sqlite" });
    resetRepoStatePaths();
  });

  it("serves one handle per path, and a reset reopens a fresh one", () => {
    const first = sharedRepoStateStore({ path: storePath });
    if (first.store === null) throw new Error(first.error ?? "store did not open");
    // One handle per repository per process: two callers in one session must not
    // open (and migrate) the same file twice.
    expect(sharedRepoStateStore({ path: storePath }).store).toBe(first.store);

    resetSharedRepoStateStore();
    // The reset closes the handles, so nothing writes through a dead store...
    expect(first.store.writeRun({ runId: "run-1", payload: { runId: "run-1" } })).toHaveProperty(
      "ok",
      false,
    );
    // ...and the next open is a fresh handle on the same path.
    const reopened = sharedRepoStateStore({ path: storePath });
    if (reopened.store === null) throw new Error(reopened.error ?? "store did not reopen");
    expect(reopened.store).not.toBe(first.store);
    expect(reopened.store.writeRun({ runId: "run-1", payload: { runId: "run-1" } })).toHaveProperty(
      "ok",
      true,
    );
  });

  it("does not serve one store's rows after the file override moves", () => {
    const before = join(dir, "before.sqlite");
    const after = join(dir, "after.sqlite");
    process.env[REPO_STATE_FILE_ENV] = before;
    resetSharedRepoStateStore();
    const first = sharedRepoStateStore({ cwd: dir });
    if (first.store === null) throw new Error(first.error ?? "store did not open");
    first.store.writeWorkflow({ state: workflowState(), worktreePath: "/repo.feat-bd-42" });
    expect(first.store.path).toBe(before);

    // A second test (or a relocated store) points the seam somewhere else; a
    // process-global handle keyed only by cwd would hand back the first file's row.
    process.env[REPO_STATE_FILE_ENV] = after;
    resetSharedRepoStateStore();
    try {
      const second = sharedRepoStateStore({ cwd: dir });
      if (second.store === null) throw new Error(second.error ?? "store did not open");
      expect(second.store.path).toBe(after);
      expect(second.store.readWorkflow({ taskId: "bd-42" })).toHaveProperty("value", null);
    } finally {
      delete process.env[REPO_STATE_FILE_ENV];
      resetSharedRepoStateStore();
    }
  });
});

/**
 * The shared-open failure gate and its `bypassFailureGate` seam (bd-281 round 12).
 *
 * The gate is process-global state keyed by resolved store path, so every case
 * here asserts the two ways it could leak between callers: a bypass that clears
 * or shortens another caller's cooldown, and a cooldown that outlives the test
 * (or the repository) that created it.
 */
describe("shared open failure gate (bd-281)", () => {
  /**
   * A database seam whose schema step always fails with a transient lock error.
   *
   * `exec` throws first, which is what `inImmediateTransaction` calls, so the
   * open fails before any statement is prepared — no real file is needed and no
   * sleep is incurred (the schema retry has no backoff).
   */
  function busyDatabase(attempts: { count: number }): SqliteDatabaseLike {
    return {
      exec() {
        attempts.count += 1;
        throw new Error("SQLITE_BUSY: database is locked");
      },
      prepare() {
        throw new Error("prepare reached a store that never opened");
      },
      close() {},
    };
  }

  const t0 = 1_700_000_000_000;

  it("does not pre-clear or extend the cooldown a bypassed open records", () => {
    resetSharedRepoStateStore();
    const gatePath = join(dir, "gate.sqlite");
    const attempts = { count: 0 };
    try {
      // A normal open fails: the cooldown starts at this caller's clock.
      const first = sharedRepoStateStore({
        path: gatePath,
        now: () => t0,
        database: busyDatabase(attempts),
      });
      expect(first).toHaveProperty("store", null);
      expect(first.failureClass).toBe("transient");
      expect(first.error).toContain("SQLITE_BUSY");
      expect(attempts.count).toBeGreaterThan(0);

      // Inside the window a normal open is refused without touching the store: the
      // gated result carries no error and the attempt count does not move, which
      // is what distinguishes `failureGate` from a failed open.
      const beforeBypass = attempts.count;
      expect(sharedRepoStateStore({ path: gatePath, now: () => t0 + 1 })).toStrictEqual({
        store: null,
        failureClass: "transient",
      });
      expect(attempts.count).toBe(beforeBypass);

      // A bypassed open — the proof receipt's one bounded retry — does attempt the
      // store and, failing again, re-anchors the window at its own clock reading.
      const bypassed = sharedRepoStateStore({
        path: gatePath,
        now: () => t0 + 1,
        database: busyDatabase(attempts),
        bypassFailureGate: true,
      });
      expect(bypassed).toHaveProperty("store", null);
      expect(bypassed.failureClass).toBe("transient");
      expect(attempts.count).toBeGreaterThan(beforeBypass);
      const afterBypass = attempts.count;

      // The window restarted at t0+1, so 29 999 ms after the *bypass* it is still
      // closed. A bypass that only read the gate (or re-stamped a stale time) would
      // have opened it here.
      expect(
        sharedRepoStateStore({ path: gatePath, now: () => t0 + SHARED_REPO_STATE_RETRY_MS }),
      ).toStrictEqual({ store: null, failureClass: "transient" });
      expect(attempts.count).toBe(afterBypass);

      // Exactly one documented window after the last failed attempt it reopens, so
      // the cooldown is the documented 30 s and not a longer one.
      const reopened = sharedRepoStateStore({
        path: gatePath,
        now: () => t0 + 1 + SHARED_REPO_STATE_RETRY_MS,
      });
      if (reopened.store === null) throw new Error(reopened.error ?? "gate did not reopen");
      expect(reopened.store.path).toBe(gatePath);
    } finally {
      resetSharedRepoStateStore();
    }
  });

  it("gates only the path that failed, so one repository cannot silence another", () => {
    resetSharedRepoStateStore();
    const failedPath = join(dir, "failed.sqlite");
    const otherPath = join(dir, "other.sqlite");
    try {
      const failed = sharedRepoStateStore({
        path: failedPath,
        now: () => t0,
        database: busyDatabase({ count: 0 }),
      });
      expect(failed.failureClass).toBe("transient");
      expect(sharedRepoStateStore({ path: failedPath, now: () => t0 })).toHaveProperty(
        "store",
        null,
      );

      // A different repository (the next test suite's fixture) opens normally: the
      // cooldown is per resolved path, never a process-wide switch.
      const other = sharedRepoStateStore({ path: otherPath, now: () => t0 });
      if (other.store === null) throw new Error(other.error ?? "other store did not open");
      expect(other.store.path).toBe(otherPath);
    } finally {
      resetSharedRepoStateStore();
    }
  });

  it("drops the cooldown and the cached resolution on reset", () => {
    resetRepoStatePaths();
    let probes = 0;
    const resolver = (cwd: string) => {
      probes += 1;
      return { ok: true as const, commonDir: `${cwd}/.git` };
    };
    const cached = resolveRepoStatePath({
      cwd: "/repo/wt",
      env: {},
      resolveCommonDir: resolver,
    });
    expect(cached).toStrictEqual({ ok: true, value: "/repo/wt/.git/belayd/state.sqlite" });
    expect(probes).toBe(1);

    resetSharedRepoStateStore();

    // The next suite re-resolves instead of reusing a path whose fixture was just
    // deleted — the hazard the fleet-merge fixture reset exists for.
    expect(
      resolveRepoStatePath({ cwd: "/repo/wt", env: {}, resolveCommonDir: resolver }),
    ).toStrictEqual({ ok: true, value: "/repo/wt/.git/belayd/state.sqlite" });
    expect(probes).toBe(2);

    // ...and a cooldown recorded before the reset no longer gates an open, so a
    // suite cannot inherit an earlier suite's outage.
    const gatePath = join(dir, "reset.sqlite");
    const attempts = { count: 0 };
    sharedRepoStateStore({ path: gatePath, now: () => t0, database: busyDatabase(attempts) });
    expect(attempts.count).toBeGreaterThan(0);
    resetSharedRepoStateStore();
    const attemptsAfterReset = attempts.count;
    sharedRepoStateStore({
      path: gatePath,
      now: () => t0,
      database: busyDatabase(attempts),
    });
    expect(attempts.count).toBeGreaterThan(attemptsAfterReset);
    resetSharedRepoStateStore();
  });
});

describe("legacy state import (bd-281)", () => {
  /**
   * Seed one worktree's pre-store files.
   *
   * `suffix` gives the second worktree its own task ids: the "each worktree imports
   * its own files" case needs distinct rows, while the "a shared task is never
   * clobbered" case deliberately reuses the same ids.
   */
  function seedLegacy(cwd: string, suffix = ""): void {
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    writeFileSync(
      join(cwd, ".belayd", "workflow.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: `bd-42${suffix}`,
        workflowType: "feature",
        branch: `feat/bd-42${suffix}`,
        originalCwd: cwd,
        phaseOrder: ["scout", "plan"],
        completedPhaseNames: ["scout"],
        startedAt: 1,
        updatedAt: 2,
      }),
    );
    writeFileSync(
      join(cwd, ".belayd", `handoff-handoffsession${suffix}.json`),
      JSON.stringify({
        taskId: `bd-101${suffix}`,
        branch: `feat/bd-101${suffix}`,
        sessionId: "sess-child",
      }),
    );
    writeFileSync(
      join(cwd, ".belayd", "review-scope.json"),
      JSON.stringify({ taskId: `bd-42${suffix}`, sha: "abc1234", untracked: [], capturedAt: 3 }),
    );
  }

  it("imports every legacy file once and reports a per-file summary", () => {
    const cwd = join(dir, "worktree");
    seedLegacy(cwd);

    const first = importLegacyState({ cwd, store, nowMs: 5_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.alreadyImported).toBe(false);
    expect(first.value.imported).toBe(3);
    expect(store.readWorkflow({ worktreePath: cwd })).toHaveProperty(
      "value.state.completedPhaseNames",
      ["scout"],
    );
    expect(store.readHandoff({ taskId: "bd-101", handoffKey: "handoffsession" })).toHaveProperty(
      "value.taskId",
      "bd-101",
    );
    expect(store.readReviewScope("bd-42")).toHaveProperty("value.sha", "abc1234");

    const second = importLegacyState({ cwd, store });
    expect(second).toHaveProperty("value.alreadyImported", true);
    expect(second).toHaveProperty("value.imported", 0);
  });

  it("imports the retired proof receipt as a row keyed by its task id", () => {
    const cwd = join(dir, "worktree");
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    writeFileSync(
      join(cwd, ".belayd", "proof-receipt.json"),
      JSON.stringify({ version: 1, taskId: "bd-42", id: "upload-42" }),
    );

    // Absent-first: a live row written before the file was read still wins.
    expect(
      store.writeProofReceipt({
        taskId: "bd-42",
        receipt: { version: 1, taskId: "bd-42", id: "upload-99" },
      }),
    ).toHaveProperty("ok", true);

    const summary = importLegacyState({ cwd, store });
    expect(summary).toHaveProperty("value.imported", 0);
    expect(summary).toHaveProperty("value.entries", [
      expect.objectContaining({
        kind: "proof-receipt",
        imported: false,
        skipped: "a proof receipt already exists",
      }),
    ]);
    expect(store.readProofReceipt({ taskId: "bd-42" })).toHaveProperty("value.id", "upload-99");
  });

  it("imports a valid proof receipt when no row exists", () => {
    const cwd = join(dir, "worktree");
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    writeFileSync(
      join(cwd, ".belayd", "proof-receipt.json"),
      JSON.stringify({ version: 1, taskId: "bd-42", id: "upload-42" }),
    );

    expect(importLegacyState({ cwd, store })).toHaveProperty("value.imported", 1);
    expect(store.readProofReceipt({ taskId: "bd-42" })).toStrictEqual({
      ok: true,
      value: { version: 1, taskId: "bd-42", id: "upload-42" },
    });
  });

  it("refuses through the guard a proof receipt put back after the marker is set", () => {
    const cwd = join(dir, "worktree");
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    const receiptPath = join(cwd, ".belayd", "proof-receipt.json");
    writeFileSync(receiptPath, JSON.stringify({ version: 1, taskId: "bd-42", id: "upload-42" }));
    expect(importLegacyState({ cwd, store })).toHaveProperty("value.imported", 1);
    rmSync(receiptPath);
    // A restored checkout or a copied worktree reintroduces the file; it must be
    // named by the refusal, not silently read as a second receipt.
    writeFileSync(receiptPath, JSON.stringify({ version: 1, taskId: "bd-42", id: "upload-77" }));

    const refusals: string[] = [];
    const imported: unknown[] = [];
    migrateAndGuardLegacyState({
      cwd,
      store,
      onRefusal: (message) => refusals.push(message),
      onImported: (summary) => imported.push(summary),
    });

    expect(imported).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("bd-281");
    expect(refusals[0]).toContain("proof-receipt.json");
    expect(refusals[0]).toContain("not read and not re-imported");
    // The row is still the imported receipt, not the copy that reappeared.
    expect(store.readProofReceipt({ taskId: "bd-42" })).toHaveProperty("value.id", "upload-42");
  });

  it("skips a file the validators reject instead of guessing", () => {
    const cwd = join(dir, "worktree");
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    writeFileSync(join(cwd, ".belayd", "workflow.json"), '{"taskId": 42}');

    const summary = importLegacyState({ cwd, store });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.entries).toEqual([
      {
        path: join(cwd, ".belayd", "workflow.json"),
        kind: "workflow",
        imported: false,
        skipped: "not a valid workflow state",
      },
    ]);
    expect(store.readWorkflow({ worktreePath: cwd })).toHaveProperty("value", null);
  });

  it("names the migration when a legacy file is present after the import", () => {
    const cwd = join(dir, "worktree");
    seedLegacy(cwd);
    importLegacyState({ cwd, store });

    const present = legacyStateFiles(cwd);
    expect(present).toHaveLength(3);

    const refusal = legacyStateRefusal(present);
    expect(refusal).toContain("bd-281");
    expect(refusal).toContain("state.sqlite");
    expect(refusal).toContain("workflow.json");
    expect(refusal).toContain("not read and not re-imported");
  });

  it("refuses through the guard a legacy file put back after the marker is set", () => {
    const cwd = join(dir, "worktree");
    seedLegacy(cwd);
    expect(importLegacyState({ cwd, store })).toHaveProperty("value.imported", 3);
    // The operator deleted the retired files, as the refusal tells them to. One
    // comes back: a `git stash pop`, an old branch checkout, a copied worktree.
    for (const path of legacyStateFiles(cwd)) rmSync(path, { force: true });
    expect(legacyStateFiles(cwd)).toEqual([]);
    writeFileSync(
      join(cwd, ".belayd", "workflow.json"),
      JSON.stringify({ schemaVersion: 1, taskId: "bd-42" }),
    );

    const refusals: string[] = [];
    const imported: unknown[] = [];
    migrateAndGuardLegacyState({
      cwd,
      store,
      onRefusal: (message) => refusals.push(message),
      onImported: (summary) => imported.push(summary),
    });

    // The guard is the live session's entry point, so this is the message a human
    // actually sees. It has to name the file and the migration, and say what to do.
    expect(imported).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("bd-281");
    expect(refusals[0]).toContain("bd-281-legacy-workflow-state");
    expect(refusals[0]).toContain("workflow.json");
    expect(refusals[0]).toContain("not read and not re-imported");
    // The reappearing file was not imported over the row the first import wrote.
    expect(store.readWorkflow({ taskId: "bd-42" })).toHaveProperty(
      "value.state.completedPhaseNames",
      ["scout"],
    );
  });

  it("reads the store row even when a retired file still sits beside it", () => {
    const cwd = join(dir, "worktree");
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    // A file the retired reader would have preferred: another task, another ledger.
    writeFileSync(
      join(cwd, ".belayd", "workflow.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bd-99",
        workflowType: "feature",
        branch: "feat/bd-99",
        originalCwd: cwd,
        phaseOrder: ["scout", "plan"],
        completedPhaseNames: ["scout", "plan"],
        startedAt: 1,
        updatedAt: 2,
      }),
    );
    store.writeWorkflow({
      state: workflowState({ completedPhaseNames: ["scout"] }),
      worktreePath: cwd,
    });

    // The import path is gone: a present file is refused (above), never read, so a
    // stale copy cannot become the session's state again.
    const read = readWorkflowState({ cwd, store });
    expect(read).toHaveProperty("taskId", "bd-42");
    expect(read).toHaveProperty("completedPhaseNames", ["scout"]);
  });

  it("imports the lease, run and review-findings records, refusing to clobber", () => {
    const cwd = join(dir, "worktree");
    const belayd = join(cwd, ".belayd");
    mkdirSync(join(belayd, "runs"), { recursive: true });
    writeFileSync(
      join(belayd, "orchestrator.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bd-42",
        branch: "feat/bd-42",
        sessionId: "session-a",
        pid: 4242,
        claimedAt: 1_000,
        heartbeatAt: 1_000,
      }),
    );
    writeFileSync(
      join(belayd, "review-findings.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bd-42",
        phase: "review",
        round: 2,
        reason: "awaiting the fix loop in this workflow",
        artifactPath: ".belayd/review-findings.md",
        findings: [],
      }),
    );
    writeFileSync(
      join(belayd, "runs", "run-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        taskId: "bd-42",
        phase: "plan",
        sessionName: "belayd-bd-42-sub-plan-run-1",
        status: "running",
        startedAt: 1_000,
      }),
    );

    const summary = importLegacyState({ cwd, store, nowMs: 5_000 });
    expect(summary).toHaveProperty("value.imported", 3);
    // The lease keeps its own heartbeat, so a cold record stays cold.
    expect(store.readLease({ taskId: "bd-42" })).toHaveProperty("value.heartbeatAt", 1_000);
    expect(store.readReviewFindings("bd-42")).toHaveProperty("value.round", 2);
    expect(store.readRun("run-1")).toHaveProperty("value.payload.phase", "plan");

    // The refusal covers every retired path.
    expect(legacyStateRefusal(legacyStateFiles(cwd))).toContain("orchestrator.json");
    expect(legacyStateRefusal(legacyStateFiles(cwd))).toContain("runs/*.json");
  });

  it("never overwrites a row an import finds already there", () => {
    const cwd = join(dir, "worktree");
    const belayd = join(cwd, ".belayd");
    mkdirSync(belayd, { recursive: true });
    writeFileSync(
      join(belayd, "orchestrator.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bd-42",
        branch: "feat/bd-42",
        sessionId: "stale-file",
        pid: 1,
        claimedAt: 1_000,
        heartbeatAt: 1_000,
      }),
    );
    store.acquireLease({
      taskId: "bd-42",
      branch: "feat/bd-42",
      sessionId: "live-session",
      worktreePath: "/repo.feat-bd-42",
      pid: 9,
      nowMs: 2_000,
      takeOverStale: true,
    });

    const summary = importLegacyState({ cwd, store });
    expect(summary).toHaveProperty("value.imported", 0);
    // The newer row survives: a migration fills gaps, it does not roll state back.
    expect(store.readLease({ taskId: "bd-42" })).toHaveProperty("value.sessionId", "live-session");
  });

  it("keeps a second worktree's legacy files importable", () => {
    const first = join(dir, "worktree-a");
    const second = join(dir, "worktree-b");
    seedLegacy(first);
    seedLegacy(second, "-b");

    expect(importLegacyState({ cwd: first, store })).toHaveProperty("value.imported", 3);
    // The marker names the worktree, because the files do; a repository-wide
    // marker would silently refuse the second worktree instead of importing it.
    expect(importLegacyState({ cwd: second, store })).toHaveProperty("value.imported", 3);
  });

  it("never overwrites a newer workflow row with a stale worktree copy", () => {
    const first = join(dir, "worktree-a");
    const second = join(dir, "worktree-b");
    // The same task in two worktrees: both legacy copies name bd-42.
    seedLegacy(first);
    seedLegacy(second);
    importLegacyState({ cwd: first, store });

    // The live orchestrator advances the shared row after A's import; B still holds
    // its pre-upgrade copy of the same task.
    const advanced = store.mutateWorkflow({
      locator: { taskId: "bd-42" },
      update: (current) =>
        current === null
          ? { kind: "skip" }
          : {
              kind: "write",
              state: { ...current.state, completedPhaseNames: ["scout", "plan"], updatedAt: 9_000 },
            },
    });
    expect(advanced).toHaveProperty("ok", true);
    const live = store.readWorkflow({ taskId: "bd-42" });
    expect(live).toHaveProperty("ok", true);
    if (!live.ok || live.value === null) return;
    const generation = live.value.generation;

    const summary = importLegacyState({ cwd: second, store });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    // The stale copy is reported, not written: two copies of one task's phase ledger
    // cannot be merged, so the row the orchestrator is driving wins.
    expect(summary.value.entries.find((entry) => entry.kind === "workflow")).toHaveProperty(
      "skipped",
      `a workflow row already exists (generation ${generation})`,
    );
    expect(summary.value.imported).toBe(0);
    expect(store.readWorkflow({ taskId: "bd-42" })).toHaveProperty(
      "value.state.completedPhaseNames",
      ["scout", "plan"],
    );
    expect(store.readWorkflow({ taskId: "bd-42" })).toHaveProperty("value.generation", generation);
  });

  it("keeps a workflow row the orchestrator wrote after the file was read", () => {
    const cwd = join(dir, "worktree");
    seedLegacy(cwd);
    let interleaved = false;
    const fs: LegacyStateFs = {
      ...nodeFsSeam,
      readFileSync: (path) => {
        // The live orchestrator advances the ledger between the legacy file read and
        // the import's write: that is the window the retired check-then-write pair
        // left open, and the plan helper's check runs inside the write transaction.
        if (!interleaved && path.endsWith("workflow.json")) {
          interleaved = true;
          store.mutateWorkflow({
            locator: { taskId: "bd-42" },
            update: () => ({
              kind: "write",
              state: workflowState({
                originalCwd: cwd,
                completedPhaseNames: ["scout", "plan"],
              }),
            }),
            nowMs: 9_000,
          });
        }
        return readFileSync(path, "utf8");
      },
    };

    const summary = importLegacyState({ cwd, store, fs });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const workflowEntry = summary.value.entries.find((entry) => entry.kind === "workflow");
    expect(workflowEntry).toHaveProperty("imported", false);
    expect(workflowEntry?.skipped ?? "").toContain("a workflow row already exists");
    // The live ledger survives untouched; the legacy copy did not win the race.
    expect(store.readWorkflow({ taskId: "bd-42" })).toHaveProperty(
      "value.state.completedPhaseNames",
      ["scout", "plan"],
    );
    expect(store.readWorkflow({ taskId: "bd-42" })).toHaveProperty("value.state.updatedAt", 9_000);
  });

  it("runs the once-per-worktree guard once per process", () => {
    const cwd = join(dir, "worktree");
    seedLegacy(cwd);
    const refusals: string[] = [];
    let imports = 0;
    const deps = {
      cwd,
      store,
      onRefusal: (message: string) => refusals.push(message),
      onImported: () => {
        imports += 1;
      },
    };

    migrateAndGuardLegacyState(deps);
    const firstRefusals = refusals.length;
    // The files are still on disk after the import, so the guard's one run reports
    // the refusal once; the second call must not repeat the scan or the import.
    expect(firstRefusals).toBeGreaterThan(0);
    expect(imports).toBe(1);
    migrateAndGuardLegacyState(deps);
    expect(refusals).toHaveLength(firstRefusals);
    expect(imports).toBe(1);
  });
});

describe("legacy fleet state import (bd-281)", () => {
  function commonDir(): string {
    return join(dir, "repo", ".git");
  }

  function fleetPath(fleetId = "default"): string {
    return join(commonDir(), "belayd", "fleet", fleetId);
  }

  function intentRecord(fleetId = "default", overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 2,
      fleetId,
      taskIds: ["bd-12"],
      createdAt: 900,
      updatedAt: 1_200,
      baseBranch: "main",
      publish: { mode: "local" },
      run: {
        schemaVersion: 1,
        mode: "until-complete",
        startedAt: 1_000,
        updatedAt: 1_200,
        ticks: 2,
        members: [{ taskId: "bd-12", launchedAt: 1_000 }],
      },
      ...overrides,
    };
  }

  function queueRecord(lock: unknown = null) {
    return {
      schemaVersion: 1,
      updatedAt: 1_000,
      lock,
      entries: [
        { taskId: "bd-12", branch: "feat/bd-12", requestedAt: 900, state: "queued", attempts: 0 },
      ],
    };
  }

  function liveLock() {
    return {
      holder: "supervisor-session",
      taskId: "bd-12",
      pid: 42,
      acquiredAt: 1_100,
      leaseExpiresAt: 1_100 + FLEET_MERGE_LEASE_MS,
    };
  }

  function noteRecord(to: string, from: string, createdAt: number) {
    return { schemaVersion: 1, kind: "note", to, from, body: `hello ${to}`, createdAt };
  }

  function auditLine(timestamp: number, action: string) {
    return {
      timestamp,
      fleetId: "default",
      actor: "supervisor-session",
      action,
      taskIds: ["bd-12"],
      detail: action,
    };
  }

  /** A complete pre-store fleet directory, one of every legacy file. */
  function seedFleet(fleetId = "default"): string {
    const path = fleetPath(fleetId);
    for (const child of ["merge.lock.d", "launch", "inbox", "events"]) {
      mkdirSync(join(path, child), { recursive: true });
    }
    writeFileSync(join(path, "fleet.json"), JSON.stringify(intentRecord(fleetId)));
    writeFileSync(join(path, "merge-queue.json"), JSON.stringify(queueRecord(liveLock())));
    writeFileSync(
      join(path, "audit.log"),
      `${JSON.stringify(auditLine(1_050, "dispatch"))}\n${JSON.stringify(auditLine(1_060, "merge"))}\n`,
    );
    writeFileSync(
      join(path, "launch", "bd-12"),
      JSON.stringify({ schemaVersion: 1, taskId: "bd-12", startedAt: 900 }),
    );
    writeFileSync(
      join(path, "supervisor.json"),
      JSON.stringify({
        schemaVersion: 1,
        fleetId,
        sessionId: "supervisor-session",
        pid: 42,
        heartbeatAt: 1_150,
      }),
    );
    writeFileSync(
      join(path, "inbox", "supervisor-note-1000-abc.json"),
      JSON.stringify(noteRecord("supervisor", "bd-12", 1_000)),
    );
    writeFileSync(
      join(path, "events", "bd-12-note-1001-def.json"),
      JSON.stringify(noteRecord("bd-12", "supervisor", 1_001)),
    );
    return path;
  }

  it("imports every legacy fleet file once and reports a per-file summary", () => {
    seedFleet();

    const first = importLegacyFleetState({ gitCommonDir: commonDir(), store, nowMs: 2_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.alreadyImported).toBe(false);
    expect(first.value.fleets).toEqual(["default"]);
    // intent + queue + lock + 2 audit rows + supervisor + marker + 2 notes
    expect(first.value.rows).toBe(9);
    expect(first.value.entries.map((entry) => entry.kind).sort()).toEqual([
      "fleet-audit",
      "fleet-intent",
      "fleet-launch-marker",
      "fleet-lock",
      "fleet-note",
      "fleet-note",
      "fleet-queue",
      "fleet-supervisor",
    ]);

    // The intent document and the run record share the row, in their own columns.
    expect(store.readFleet("default")).toHaveProperty("value.intent.taskIds", ["bd-12"]);
    expect(store.readFleet("default")).toHaveProperty("value.run.members.0.taskId", "bd-12");
    expect(store.readFleetQueue("default")).toHaveProperty("value.queue.entries.0.state", "queued");
    // The lock is its own row, not a copy inside the queue document.
    expect(store.readFleetQueue("default")).toHaveProperty("value.queue.lock", null);
    expect(store.readFleetLock("default")).toHaveProperty("value.holder", "supervisor-session");
    expect(store.readAudit({ fleetId: "default" })).toHaveProperty("value.length", 2);
    expect(store.readLaunchMarker("bd-12")).toHaveProperty("value.taskId", "bd-12");
    expect(store.readSupervisor("default")).toHaveProperty("value.sessionId", "supervisor-session");
    expect(store.drainNotes({ fleetId: "default", channel: "inbox" })).toHaveProperty(
      "value.0.target",
      "supervisor",
    );
    expect(store.drainNotes({ fleetId: "default", channel: "event" })).toHaveProperty(
      "value.0.from",
      "supervisor",
    );

    const second = importLegacyFleetState({ gitCommonDir: commonDir(), store });
    expect(second).toHaveProperty("value.alreadyImported", true);
    expect(second).toHaveProperty("value.rows", 0);
  });

  it("lands one row per fact no matter how many worktrees import", () => {
    seedFleet();
    const worktreeA = join(dir, "repo", "feat-bd-12");
    const worktreeB = join(dir, "repo", "feat-bd-13");
    mkdirSync(worktreeA, { recursive: true });
    mkdirSync(worktreeB, { recursive: true });

    // Both worktrees resolve the same common dir, because that is where the fleet
    // files lived: the second import is a no-op, not a second copy. The import clock
    // is the caller's, so the recorded lock is still inside its lease.
    expect(
      importLegacyFleetState({ gitCommonDir: commonDir(), store, nowMs: 2_000 }),
    ).toHaveProperty("value.rows", 9);
    expect(importLegacyFleetState({ gitCommonDir: commonDir(), store })).toHaveProperty(
      "value.alreadyImported",
      true,
    );
    expect(store.drainNotes({ fleetId: "default", channel: "inbox" })).toHaveProperty(
      "value.length",
      1,
    );
    expect(store.readAudit({ fleetId: "default" })).toHaveProperty("value.length", 2);
  });

  it("inserts one audit row per legacy line when a second importer races it", () => {
    seedFleet();
    // The first worktree's import already wrote these two lines.
    for (const timestamp of [1_050, 1_060]) {
      const seeded = store.importAudit({
        fleetId: "default",
        entry: auditLine(timestamp, timestamp === 1_050 ? "dispatch" : "merge"),
        nowMs: timestamp,
      });
      expect(seeded).toHaveProperty("value.imported", true);
    }

    // The second worktree still has the same audit.log and runs before any marker
    // exists for it, so the tail is read and every insert is attempted again.
    const summary = importLegacyFleetState({ gitCommonDir: commonDir(), store });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.entries.find((entry) => entry.kind === "fleet-audit")).toHaveProperty(
      "skipped",
      "every line is already an audit row",
    );
    expect(store.readAudit({ fleetId: "default" })).toHaveProperty("value.length", 2);
  });

  it("never overwrites a row the import finds already there", () => {
    seedFleet();
    // Newer state than the files: a live intent and a note with the same identity.
    expect(
      store.mutateFleet({
        fleetId: "default",
        update: () => ({ kind: "write", intent: intentRecord("default", { taskIds: ["bd-99"] }) }),
      }),
    ).toHaveProperty("ok", true);
    const seedNote = store.importNote({
      fleetId: "default",
      channel: "inbox",
      target: "supervisor",
      from: "bd-12",
      kind: "note",
      body: "the row that was already there",
      createdAt: 1_000,
    });
    expect(seedNote).toHaveProperty("value.imported", true);

    const summary = importLegacyFleetState({ gitCommonDir: commonDir(), store });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(store.readFleet("default")).toHaveProperty("value.intent.taskIds", ["bd-99"]);
    expect(store.drainNotes({ fleetId: "default", channel: "inbox" })).toHaveProperty(
      "value.0.body",
      "the row that was already there",
    );
    expect(summary.value.entries.find((entry) => entry.kind === "fleet-intent")).toHaveProperty(
      "skipped",
      "a fleet intent row already exists",
    );
  });

  it("never resurrects a lock from an expired record or a bare directory", () => {
    const path = seedFleet();
    writeFileSync(
      join(path, "merge-queue.json"),
      JSON.stringify(
        queueRecord({
          ...liveLock(),
          acquiredAt: 1_000,
          leaseExpiresAt: 1_500,
        }),
      ),
    );

    const summary = importLegacyFleetState({ gitCommonDir: commonDir(), store, nowMs: 2_000 });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    // The queue row is state and is imported; the lock is not, so nothing can hold
    // the merge single-flight on a lease that already ended.
    expect(store.readFleetQueue("default")).toHaveProperty("value.queue.entries.0.taskId", "bd-12");
    expect(store.readFleetLock("default")).toHaveProperty("value", null);
    expect(summary.value.entries.find((entry) => entry.kind === "fleet-lock")).toHaveProperty(
      "skipped",
      "the recorded lock lease expired, so no lock row was created",
    );
  });

  it("keeps a merge queue a live drain wrote after the file was read", () => {
    const fleetDirPath = seedFleet();
    let interleaved = false;
    const fs: LegacyStateFs = {
      ...nodeFsSeam,
      readFileSync: (path) => {
        // A drain advanced the queue between this read and the import's write. The
        // plan helper's absence check runs inside the write transaction, so the
        // newer queue is what it sees, and the legacy copy is skipped.
        if (!interleaved && path === join(fleetDirPath, "merge-queue.json")) {
          interleaved = true;
          store.mutateFleetQueue({
            fleetId: "default",
            queue: { schemaVersion: 1, updatedAt: 8_000, lock: null, entries: [] },
            update: () => ({ kind: "write" }),
            nowMs: 8_000,
          });
        }
        return readFileSync(path, "utf8");
      },
    };

    const summary = importLegacyFleetState({
      gitCommonDir: commonDir(),
      store,
      fs,
      nowMs: 2_000,
    });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.entries.find((entry) => entry.kind === "fleet-queue")).toHaveProperty(
      "skipped",
      "a merge queue row already exists",
    );
    // The live queue and its revision survive: the legacy entries did not replace it.
    expect(store.readFleetQueue("default")).toHaveProperty("value.queue.entries", []);
    expect(store.readFleetQueue("default")).toHaveProperty("value.revision", 1);
  });

  it("does not import a lock record whose directory primitive is gone", () => {
    const path = seedFleet();
    rmSync(join(path, "merge.lock.d"), { recursive: true, force: true });
    writeFileSync(join(path, "merge-queue.json"), JSON.stringify(queueRecord(liveLock())));

    const summary = importLegacyFleetState({ gitCommonDir: commonDir(), store, nowMs: 2_000 });
    expect(summary.ok).toBe(true);
    expect(store.readFleetLock("default")).toHaveProperty("value", null);
  });

  it("reports a bad file per fleet without aborting the others", () => {
    seedFleet();
    const broken = fleetPath("broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "fleet.json"), '{"taskId": 42}');
    writeFileSync(join(broken, "merge-queue.json"), '"not a queue"');

    const summary = importLegacyFleetState({ gitCommonDir: commonDir(), store, nowMs: 2_000 });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.fleets).toEqual(["broken", "default"]);
    expect(store.readFleet("default")).toHaveProperty("value.intent.taskIds", ["bd-12"]);
    expect(store.readFleet("broken")).toHaveProperty("value", null);
    expect(summary.value.entries.filter((entry) => entry.fleetId === "broken")).toEqual([
      expect.objectContaining({ kind: "fleet-intent", skipped: "not a valid fleet intent" }),
      expect.objectContaining({ kind: "fleet-queue", skipped: "not a valid merge queue" }),
    ]);
  });

  it("reports a quarantined file and leaves it exactly where it was", () => {
    const path = seedFleet();
    const quarantined = join(path, "inbox", "supervisor-note-999-zzz.json.corrupt");
    writeFileSync(quarantined, "{not json");

    const summary = importLegacyFleetState({ gitCommonDir: commonDir(), store });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    // Evidence of a record the old reader could not parse is neither mail nor state.
    expect(summary.value.quarantined).toEqual([quarantined]);
    expect(existsSync(quarantined)).toBe(true);
    expect(store.drainNotes({ fleetId: "default", channel: "inbox" })).toHaveProperty(
      "value.length",
      1,
    );
  });

  it("names the migration when a legacy fleet file is present after the import", () => {
    seedFleet();
    importLegacyFleetState({ gitCommonDir: commonDir(), store });
    const present = legacyFleetStateFiles(commonDir());
    expect(present).toHaveLength(8);
    expect(legacyFleetIds(commonDir())).toEqual(["default"]);

    const refusal = legacyFleetStateRefusal(present);
    expect(refusal).toContain("bd-281");
    expect(refusal).toContain("state.sqlite");
    expect(refusal).toContain("bd-281-legacy-fleet-state");
    for (const name of [
      "fleet.json",
      "merge-queue.json",
      "merge.lock.d",
      "audit.log",
      "launch",
      "supervisor.json",
      "inbox",
      "events",
    ]) {
      expect(refusal).toContain(name);
    }
    // A quarantined file is evidence, so it is neither refused as state nor imported.
    expect(refusal).not.toContain(".corrupt");
  });

  it("refuses through the guard a legacy fleet file put back after the marker is set", () => {
    const path = seedFleet();
    expect(
      importLegacyFleetState({ gitCommonDir: commonDir(), store, nowMs: 2_000 }),
    ).toHaveProperty("value.rows", 9);
    // The retired files are deleted after the import; one reappears, which is how a
    // restored checkout or a copied repository reintroduces a copied fleet record.
    for (const file of legacyFleetStateFiles(commonDir())) {
      rmSync(file, { recursive: true, force: true });
    }
    expect(legacyFleetStateFiles(commonDir())).toEqual([]);
    writeFileSync(join(path, "fleet.json"), JSON.stringify(intentRecord()));

    const refusals: string[] = [];
    const imported: unknown[] = [];
    migrateAndGuardLegacyFleetState({
      gitCommonDir: commonDir(),
      store,
      onRefusal: (message) => refusals.push(message),
      onImported: (summary) => imported.push(summary),
    });

    // The fleet half's refusal must be as actionable as the worktree half's: it is
    // the message a supervising session surfaces, and it names the migration.
    expect(imported).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("bd-281");
    expect(refusals[0]).toContain("bd-281-legacy-fleet-state");
    expect(refusals[0]).toContain("fleet.json");
    expect(refusals[0]).toContain("not read and not re-imported");
    // Nothing was re-imported over the live rows: the one intent row the first
    // import wrote is still the row, at the revision it had.
    expect(store.readFleet("default")).toHaveProperty("value.intent.taskIds", ["bd-12"]);
    expect(store.readFleet("default")).toHaveProperty("value.revision", 1);
  });

  it("runs the once-per-repository fleet guard once per process", () => {
    seedFleet();
    const refusals: string[] = [];
    let imports = 0;
    const deps = {
      gitCommonDir: commonDir(),
      store,
      onRefusal: (message: string) => refusals.push(message),
      onImported: () => {
        imports += 1;
      },
    };

    migrateAndGuardLegacyFleetState(deps);
    // The legacy files are still on disk after the import, so the guard's single run
    // reports the refusal once and the import once.
    const firstRefusals = refusals.length;
    expect(firstRefusals).toBeGreaterThan(0);
    expect(imports).toBe(1);

    // Every fleet operation resolves the common dir, so this runs on the hot path:
    // the second call must neither re-scan nor repeat either report.
    migrateAndGuardLegacyFleetState(deps);
    expect(refusals).toHaveLength(firstRefusals);
    expect(imports).toBe(1);

    // The guard is per target, not a latch: the worktree half of the same
    // repository still gets its own one shot.
    expect(claimMigrationTarget(store, "worktree:/repo.a")).toBe(false);
    expect(claimMigrationTarget(store, `fleet:${commonDir()}`)).toBe(true);
  });

  it("never refuses or imports a file that is deliberately still a file", () => {
    const worktree = join(dir, "repo", "feat-bd-12");
    mkdirSync(join(worktree, ".belayd", "artifacts"), { recursive: true });
    writeFileSync(join(worktree, ".belayd", "proof-dir"), "proof-of-work\n");
    writeFileSync(join(worktree, ".belayd", "config.json"), "{}");
    writeFileSync(join(worktree, ".belayd", "review-findings.md"), "# findings\n");
    writeFileSync(join(worktree, ".belayd", "handoff.json"), "{}");
    writeFileSync(join(worktree, ".belayd", "telemetry.json"), "{}");
    writeFileSync(join(worktree, ".belayd", "github-map.json"), "{}");

    expect(legacyStateFiles(worktree)).toEqual([]);
    const summary = importLegacyState({ cwd: worktree, store });
    expect(summary).toHaveProperty("value.imported", 0);
  });
});

/**
 * The review-round fixes on the store itself (bd-281 round 9).
 *
 * Each case drives the real store code: the retry is measured on the real
 * `BEGIN IMMEDIATE` wrapper, and the two-writer audit case uses two independent
 * `DatabaseSync` handles on one file, which is the shape two worktrees have.
 */
describe("store write retry and diagnoses (bd-281 review)", () => {
  interface FaultSwitch {
    /** Failures still owed; armed after the schema so the open is unaffected. */
    remaining: number;
    message: string;
    attempts: number;
  }

  /**
   * A real in-memory store whose `BEGIN IMMEDIATE` fails on demand.
   *
   * The fault is armed after the schema is applied, so a test measures only the
   * write it is exercising. Everything else delegates to the real database, so the
   * transaction, schema and classification are the production ones.
   */
  function flakyStore(): {
    store: RepoStateStore;
    arm: (failures: number, message: string) => void;
    /** Fail the `COMMIT` *after* it applied — the ambiguous-commit replay case. */
    armCommit: (message: string) => void;
    /** Fail the next prepared-statement `run`, i.e. mid-transaction. */
    armRun: (message: string) => void;
    attempts: () => number;
  } {
    const opened = openSqliteFile({
      path: ":memory:",
      readOnly: false,
      label: "test store",
      schemaAttempts: 1,
      applySchema: () => {},
    });
    if (!opened.ok) throw new Error(opened.error);
    const inner = opened.value;
    const fault: FaultSwitch = { remaining: 0, message: "", attempts: 0 };
    const runFault: FaultSwitch = { remaining: 0, message: "", attempts: 0 };
    const commitFault: FaultSwitch = { remaining: 0, message: "", attempts: 0 };
    const database: SqliteDatabaseLike = {
      exec: (sql) => {
        if (sql.startsWith("BEGIN IMMEDIATE")) {
          fault.attempts += 1;
          if (fault.remaining > 0) {
            fault.remaining -= 1;
            throw new Error(fault.message);
          }
        }
        inner.exec(sql);
        // The commit applied and then threw: SQLite reports the IO error after the
        // transaction is durable, which is exactly the replay the retry must survive.
        if (sql === "COMMIT" && commitFault.remaining > 0) {
          commitFault.remaining -= 1;
          throw new Error(commitFault.message);
        }
      },
      prepare: (sql) => {
        const statement = inner.prepare(sql);
        return {
          run: (...params) => {
            if (runFault.remaining > 0) {
              runFault.remaining -= 1;
              throw new Error(runFault.message);
            }
            return statement.run(...params);
          },
          get: (...params) => statement.get(...params),
          all: (...params) => statement.all(...params),
        };
      },
      close: () => inner.close(),
    };
    const store = openRepoStateStore({ path: ":memory:", database });
    if (!store.ok) throw new Error(store.error);
    return {
      store: store.store,
      arm: (failures, message) => {
        fault.remaining = failures;
        fault.message = message;
        fault.attempts = 0;
      },
      armCommit: (message) => {
        fault.attempts = 0;
        commitFault.remaining = 1;
        commitFault.message = message;
      },
      armRun: (message) => {
        fault.attempts = 0;
        runFault.remaining = 1;
        runFault.message = message;
      },
      attempts: () => fault.attempts,
    };
  }

  it("retries a transient write failure once and succeeds", () => {
    const flaky = flakyStore();
    flaky.arm(1, "SQLITE_BUSY: database is locked");

    const written = flaky.store.writeRun({ runId: "run-1", payload: { runId: "run-1" } });
    expect(written).toHaveProperty("ok", true);
    // One failed attempt plus the retry that committed.
    expect(flaky.attempts()).toBe(2);
  });

  it("never retries a permanent write failure", () => {
    const flaky = flakyStore();
    flaky.arm(3, "file is not a database");

    const written = flaky.store.writeRun({ runId: "run-1", payload: { runId: "run-1" } });
    expect(written).toHaveProperty("ok", false);
    expect(written.ok ? "" : written.error).toContain("writeRun failed");
    expect(flaky.attempts()).toBe(1);
  });

  it("bounds the retries and then reports the failure", () => {
    const flaky = flakyStore();
    flaky.arm(10, "SQLITE_BUSY: database is locked");

    const written = flaky.store.writeRun({ runId: "run-1", payload: { runId: "run-1" } });
    expect(written).toHaveProperty("ok", false);
    // Three attempts in total, so a genuinely busy store surfaces instead of
    // stalling the caller's tick.
    expect(flaky.attempts()).toBe(3);
    expect(flaky.store.readRun("run-1")).toHaveProperty("value", null);
  });

  it("imports the same audit entry once when two writers hold the store", () => {
    const second = openRepoStateStore({ path: storePath });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    try {
      const entry = {
        timestamp: 1_000,
        fleetId: "default",
        actor: "session-a",
        action: "merge",
        taskIds: ["bd-12"],
        detail: "merge",
      };
      expect(store.importAudit({ fleetId: "default", entry, nowMs: 1_000 })).toHaveProperty(
        "value.imported",
        true,
      );
      expect(second.store.importAudit({ fleetId: "default", entry, nowMs: 1_000 })).toHaveProperty(
        "value.imported",
        false,
      );
      expect(store.readAudit({ fleetId: "default" })).toHaveProperty("value.length", 1);
    } finally {
      second.store.close();
    }
  });

  it("keeps a store failure out of the invalid-note diagnosis", () => {
    const flaky = flakyStore();
    flaky.arm(1, "file is not a database");

    const failed = flaky.store.enqueueNote({
      fleetId: "default",
      channel: "inbox",
      target: "supervisor",
      from: "bd-12",
      kind: "note",
      body: "hello",
      audit: { timestamp: 1 },
    });
    expect(failed).toMatchObject({ ok: false, reason: "write-failed" });
    expect(failed.ok ? "" : failed.error).toContain("enqueueNote failed");
  });

  it("still calls malformed input an invalid note", () => {
    const failed = store.enqueueNote({
      fleetId: "default",
      channel: "inbox",
      target: "",
      from: "bd-12",
      kind: "note",
      body: "hello",
      audit: { timestamp: 1 },
    });
    expect(failed).toMatchObject({ ok: false, reason: "invalid-note" });
  });

  it("carries the write diagnosis through fleet-state's enqueueNote", () => {
    const flaky = flakyStore();
    flaky.arm(1, "file is not a database");

    const result = enqueueNote({
      gitCommonDir: "/repo/.git",
      fleetId: "default",
      store: flaky.store,
      channel: "inbox",
      note: {
        schemaVersion: 1,
        kind: "note",
        to: "supervisor",
        from: "bd-12",
        body: "hello",
        createdAt: 1_000,
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "write-failed" });
    expect(result.ok ? "" : result.error).toContain("enqueueNote failed");
  });

  /**
   * A landing fold that only records what the row does not already say.
   *
   * Idempotent on purpose: that is what makes a replayed transaction recompute the
   * committed document and lets the store recognise the replay.
   */
  function landingPlan(options: {
    taskIds: readonly string[];
    taskId: string;
    nowMs: number;
  }): (current: { intent: unknown; run: unknown; revision: number }) => {
    kind: "write";
    intent: unknown;
    run: unknown;
  } {
    return (current) => ({
      kind: "write",
      intent: {
        ...(current.intent as Record<string, unknown>),
        taskIds: options.taskIds.filter((taskId) => taskId !== options.taskId),
        updatedAt: options.nowMs,
      },
      run: { members: [{ taskId: options.taskId, landedAt: options.nowMs }] },
    });
  }

  function landingAudits(flaky: { store: RepoStateStore }) {
    const read = flaky.store.readAudit({ fleetId: "fleet-a" });
    if (!read.ok) throw new Error(read.error);
    return read.value;
  }

  it("replays an ambiguous commit as one revision bump and one landing audit row", () => {
    const flaky = flakyStore();
    flaky.store.writeFleetIntent({
      fleetId: "fleet-a",
      intent: { fleetId: "fleet-a", taskIds: ["bd-1"] },
    });
    flaky.armCommit("SQLITE_IOERR: disk I/O error on commit");

    const landed = flaky.store.landFleetMember({
      fleetId: "fleet-a",
      plan: landingPlan({ taskIds: ["bd-1"], taskId: "bd-1", nowMs: 9_000 }),
      audit: { action: "fleet-landed", taskIds: ["bd-1"] },
      nowMs: 9_000,
    });

    expect(landed).toHaveProperty("value.kind", "written");
    // The commit applied and then threw, so the retry re-read what it had already
    // written: the replay writes, bumps and audits nothing, while still reporting
    // the landing (a merged member must never look unlanded).
    expect(flaky.attempts()).toBe(2);
    expect(flaky.store.readFleet("fleet-a")).toHaveProperty("value.revision", 2);
    expect(landingAudits(flaky)).toHaveLength(1);
    expect(landingAudits(flaky)[0]).toHaveProperty("payload.action", "fleet-landed");
    expect(flaky.store.readFleet("fleet-a")).toHaveProperty("value.run.members.length", 1);
  });

  it("keeps the retry contract: a landing that failed mid-transaction replays as one bump and one audit row", () => {
    const flaky = flakyStore();
    flaky.store.writeFleetIntent({
      fleetId: "fleet-a",
      intent: { fleetId: "fleet-a", taskIds: ["bd-1"] },
    });
    // The earlier suite faulted only `BEGIN IMMEDIATE`; this is the retry contract
    // for a landing whose statements had started before the store refused it.
    flaky.armRun("SQLITE_BUSY: database is locked");

    const landed = flaky.store.landFleetMember({
      fleetId: "fleet-a",
      plan: landingPlan({ taskIds: ["bd-1"], taskId: "bd-1", nowMs: 9_000 }),
      audit: { action: "fleet-landed", taskIds: ["bd-1"] },
      nowMs: 9_000,
    });

    expect(landed).toHaveProperty("value.kind", "written");
    expect(flaky.attempts()).toBe(2);
    expect(flaky.store.readFleet("fleet-a")).toHaveProperty("value.revision", 2);
    expect(landingAudits(flaky)).toHaveLength(1);
    expect(flaky.store.readFleet("fleet-a")).toHaveProperty("value.run.members.length", 1);
  });

  it("keeps a faulted write's transaction closed, so the next write commits", () => {
    const flaky = flakyStore();
    flaky.store.writeFleetIntent({
      fleetId: "fleet-a",
      intent: { fleetId: "fleet-a", taskIds: ["bd-1"] },
    });
    // A permanent fault mid-transaction: no retry, so it surfaces at once.
    flaky.armRun("file is not a database");

    const failed = flaky.store.landFleetMember({
      fleetId: "fleet-a",
      plan: landingPlan({ taskIds: ["bd-1"], taskId: "bd-1", nowMs: 9_000 }),
      audit: { action: "fleet-landed", taskIds: ["bd-1"] },
      nowMs: 9_000,
    });
    expect(failed).toHaveProperty("ok", false);
    // Rolled back, not half-applied: the intent is still the first revision and no
    // audit row exists for the landing that never committed.
    expect(flaky.store.readFleet("fleet-a")).toHaveProperty("value.revision", 1);
    expect(landingAudits(flaky)).toHaveLength(0);

    // And no transaction was left open: a leaked `BEGIN` would make the next write
    // fail with "cannot start a transaction within a transaction".
    const landed = flaky.store.landFleetMember({
      fleetId: "fleet-a",
      plan: landingPlan({ taskIds: ["bd-1"], taskId: "bd-1", nowMs: 9_000 }),
      audit: { action: "fleet-landed", taskIds: ["bd-1"] },
      nowMs: 9_000,
    });
    expect(landed).toHaveProperty("value.kind", "written");
    expect(flaky.store.readFleet("fleet-a")).toHaveProperty("value.revision", 2);
    expect(landingAudits(flaky)).toHaveLength(1);
  });

  it("bumps for a genuine second landing of a different member", () => {
    store.writeFleetIntent({
      fleetId: "fleet-a",
      intent: { fleetId: "fleet-a", taskIds: ["bd-1", "bd-2"] },
    });

    const first = store.landFleetMember({
      fleetId: "fleet-a",
      plan: landingPlan({ taskIds: ["bd-1", "bd-2"], taskId: "bd-1", nowMs: 9_000 }),
      audit: { action: "fleet-landed", taskIds: ["bd-1"] },
      nowMs: 9_000,
    });
    const second = store.landFleetMember({
      fleetId: "fleet-a",
      plan: landingPlan({ taskIds: ["bd-2"], taskId: "bd-2", nowMs: 9_100 }),
      audit: { action: "fleet-landed", taskIds: ["bd-2"] },
      nowMs: 9_100,
    });

    // A later fold changes the document, so it is a landing rather than a replay of
    // the one that already committed.
    expect(first).toHaveProperty("value.revision", 2);
    expect(second).toHaveProperty("value.revision", 3);
    const audits = store.readAudit({ fleetId: "fleet-a" });
    expect(audits).toHaveProperty("value.length", 2);
  });
});

/**
 * The import's check-then-write fix (bd-281 round 10).
 *
 * Every importer writes through a plan helper, so the absence check runs inside the
 * insert's `BEGIN IMMEDIATE` and a live row that appeared after the legacy file was
 * read cannot be overwritten by the copy.
 */
describe("the one-shot import writes through plans (bd-281)", () => {
  /**
   * Store methods the import must not call directly.
   *
   * A source-text guard, not a structural one, because the structural alternative
   * needs an external parser in `pnpm test`; the import check below closes the alias
   * hole that string matching alone leaves open.
   */
  const BARE_STORE_WRITES = [
    "writeWorkflow",
    "writeHandoff",
    "writeReviewScope",
    "writeRun",
    "writeReviewFindings",
    "writeFleetIntent",
    "writeFleetQueue",
    "writeSupervisor",
    "writeLaunchMarker",
    "writeNote",
  ] as const;

  function sourceOf(modulePath: string): string {
    return readFileSync(fileURLToPath(new URL(modulePath, import.meta.url)), "utf8");
  }

  /** Every name a module imports, with `type` markers and aliases reduced to the name. */
  function importedBindings(source: string): string[] {
    const bindings: string[] = [];
    for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const specifier of (match[1] ?? "").split(",")) {
        const imported =
          specifier
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0]
            ?.trim() ?? "";
        if (imported !== "") bindings.push(imported);
      }
    }
    return bindings;
  }

  it("imports and calls no bare store write in either import module", () => {
    for (const modulePath of ["../repo-state-import.ts", "../fleet-state-import.ts"]) {
      const source = sourceOf(modulePath);
      const imported = importedBindings(source);
      for (const write of BARE_STORE_WRITES) {
        // Whitespace before the call and an alias both slip past a literal `name(`
        // search; the binding check catches the alias because it must be imported.
        expect(source).not.toMatch(new RegExp(`\\b${write}\\s*\\(`));
        expect(imported).not.toContain(write);
      }
    }
    // The plan helpers are what replaced them, so the absence above is not vacuous.
    const worktree = sourceOf("../repo-state-import.ts");
    for (const helper of [
      "mutateWorkflow",
      "mutateHandoff",
      "mutateReviewScope",
      "mutateRun",
      "mutateReviewFindings",
    ]) {
      expect(worktree).toMatch(new RegExp(`\\b${helper}\\s*\\(`));
    }
    const fleet = sourceOf("../fleet-state-import.ts");
    for (const helper of [
      "mutateFleet",
      "mutateFleetQueue",
      "mutateSupervisor",
      "mutateLaunchMarker",
    ]) {
      expect(fleet).toMatch(new RegExp(`\\b${helper}\\s*\\(`));
    }
  });
});

/**
 * The bead's "must not add a dependency" rule, as a guard (bd-281).
 *
 * `node:sqlite` ships with the runtime, so the store never needed a driver. A
 * driver dependency would be a new install surface and a second SQLite build in
 * the Nix bundle, so the manifests are checked rather than the code: any name
 * carrying `sqlite` in `package.json`, or any known driver in the lockfile, is the
 * regression.
 */
describe("no new dependency (bd-281)", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

  it("keeps the state store on the runtime's node:sqlite", () => {
    const manifests = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifests.dependencies ?? {}),
      ...Object.keys(manifests.devDependencies ?? {}),
    ];
    expect(declared.filter((name) => /sqlite/i.test(name))).toEqual([]);

    const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
    for (const driver of [
      "better-sqlite3",
      "node-sqlite3",
      "sqlite3",
      "@libsql/client",
      "sql.js",
    ]) {
      expect(lockfile).not.toContain(driver);
    }
  });
});
