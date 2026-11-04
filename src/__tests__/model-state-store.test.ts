import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOLDOWN_ESCALATION_MEMORY_MS, createModelCooldownStore } from "../model-cooldown.js";
import type { ModelStateStore, SqliteDatabaseLike } from "../model-state-store.js";
import {
  classifyStoreFailure,
  defaultModelStatePath,
  LEGACY_COOLDOWN_FILE_ENV,
  MAX_PENDING_COOLDOWN_AGE_MS,
  MAX_PENDING_COOLDOWN_MARKS,
  MODEL_STATE_FILE_ENV,
  MODEL_STATE_SCHEMA_VERSION,
  openModelStateStore,
  PROVIDER_SCOPE_MODEL,
  resetSharedModelStateStore,
  resolveModelStatePath,
  SHARED_MODEL_STATE_RETRY_MS,
  sharedModelStateStore,
} from "../model-state-store.js";
import { createProviderPolicy } from "../provider-policy.js";

const sqliteProbe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
});
const describeSqlite = sqliteProbe.status === 0 ? describe : describe.skip;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-model-state-"));
  tempDirs.push(dir);
  return join(dir, "state", "model-state.sqlite");
}

interface RawStatement {
  get(...params: unknown[]): unknown;
  all(): unknown[];
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

function rawOpen(path: string): RawDatabase {
  const require = createRequire(import.meta.url);
  const sqlite = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => RawDatabase;
  };
  return new sqlite.DatabaseSync(path);
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

describe("model state path", () => {
  it("honours BELAYD_MODEL_STATE_FILE", () => {
    expect(
      resolveModelStatePath({
        env: { [MODEL_STATE_FILE_ENV]: "/tmp/custom-state.sqlite" },
        homeDir: "/home/operator",
      }),
    ).toBe("/tmp/custom-state.sqlite");
  });

  it("defaults to $XDG_STATE_HOME/belayd/model-state.sqlite", () => {
    expect(
      resolveModelStatePath({ env: { XDG_STATE_HOME: "/xdg/state" }, homeDir: "/home/operator" }),
    ).toBe("/xdg/state/belayd/model-state.sqlite");
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    expect(resolveModelStatePath({ env: {}, homeDir: "/home/operator" })).toBe(
      "/home/operator/.local/state/belayd/model-state.sqlite",
    );
  });

  it("keeps the retired cooldown file's location as the state store (bd-256)", () => {
    // An operator who set BELAYD_MODEL_COOLDOWN_FILE keeps one store, beside the
    // file whose windows are imported into it — not a second XDG store plus a
    // stale legacy file. BELAYD_MODEL_STATE_FILE still wins.
    expect(
      resolveModelStatePath({
        env: { [LEGACY_COOLDOWN_FILE_ENV]: "/state/model-cooldowns.json" },
      }),
    ).toBe("/state/model-cooldowns.sqlite");
    expect(
      resolveModelStatePath({
        env: {
          [LEGACY_COOLDOWN_FILE_ENV]: "/state/model-cooldowns.json",
          [MODEL_STATE_FILE_ENV]: "/state/explicit.sqlite",
        },
      }),
    ).toBe("/state/explicit.sqlite");
  });

  it("resolves the production path from the process environment", () => {
    expect(defaultModelStatePath()).toContain("model-state.sqlite");
  });
});

describeSqlite("model state store (bd-187)", () => {
  it("creates the schema in WAL mode with a schema marker", () => {
    const path = tempDbPath();
    const opened = openModelStateStore({ path });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.store.close();

    const raw = rawOpen(path);
    const journal = recordOf(raw.prepare("PRAGMA journal_mode").get());
    expect(journal.journal_mode).toBe("wal");
    const version = recordOf(raw.prepare("PRAGMA user_version").get());
    expect(version.user_version).toBe(MODEL_STATE_SCHEMA_VERSION);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => recordOf(row).name);
    expect(tables).toEqual(expect.arrayContaining(["cooldown", "capacity", "lease", "spend"]));
    raw.close();
  });

  it("uses the bead's cooldown column names plus the v2 diagnostics columns", () => {
    const path = tempDbPath();
    const opened = openModelStateStore({ path });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.store.close();

    const raw = rawOpen(path);
    const columns = raw
      .prepare("SELECT name FROM pragma_table_info('cooldown')")
      .all()
      .map((row) => recordOf(row).name);
    expect(columns).toEqual([
      "provider",
      "model",
      "until_ms",
      "reason",
      "retry_after_ms",
      "cause",
      "escalations",
      "last_mark_ms",
    ]);
    raw.close();
  });

  it("migrates a v1 cooldown table in place instead of reading a store it cannot write", () => {
    const path = tempDbPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = rawOpen(path);
    raw.exec(`
      CREATE TABLE cooldown (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        until_ms INTEGER NOT NULL,
        reason TEXT NOT NULL,
        retry_after_ms INTEGER NOT NULL,
        PRIMARY KEY (provider, model)
      );
      INSERT INTO cooldown VALUES ('llmgateway', '*', 999999, 'quota', 1000);
      PRAGMA user_version = 1;
    `);
    raw.close();

    const opened = openModelStateStore({ path, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The pre-existing row is readable, and a new mark can write the v2 fields.
    expect(
      opened.store.cooldownFor({ provider: "llmgateway", model: "m", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { scope: "provider", reason: "quota" } });
    opened.store.markCooldown({
      provider: "llmgateway",
      durationMs: 1_000,
      reason: "quota",
      cause: "quota",
      nowMs: 0,
    });
    const rows = opened.store.listCooldowns({ nowMs: 0 });
    expect(rows).toMatchObject({
      ok: true,
      value: [{ cause: "quota", escalations: 1, lastMarkedAt: 0 }],
    });
    opened.store.close();
  });

  it("lets two connections open the same v1 file without racing the migration", () => {
    // Two fleet members can open the same v1 file at once (bd-256 review). The
    // migration is one BEGIN IMMEDIATE transaction, so the second opener sees a
    // complete schema instead of racing the same ALTER.
    const path = tempDbPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = rawOpen(path);
    raw.exec(`
      CREATE TABLE cooldown (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        until_ms INTEGER NOT NULL,
        reason TEXT NOT NULL,
        retry_after_ms INTEGER NOT NULL,
        PRIMARY KEY (provider, model)
      );
      INSERT INTO cooldown VALUES ('llmgateway', '*', 999999, 'quota', 1000);
      PRAGMA user_version = 1;
    `);
    raw.close();

    const first = openModelStateStore({ path, now: () => 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The second connection opens while the first is still live.
    const second = openModelStateStore({ path, now: () => 0 });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      first.store.close();
      return;
    }
    expect(
      second.store.cooldownFor({ provider: "llmgateway", model: "m", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { scope: "provider", reason: "quota" } });
    second.store.close();
    first.store.close();
  });

  it("tolerates a partially migrated v1 table", () => {
    // A migration that committed one ALTER before dying leaves a mix of v1 and
    // v2 columns with user_version still 1. Reopening must finish it, not fail.
    const path = tempDbPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = rawOpen(path);
    raw.exec(`
      CREATE TABLE cooldown (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        until_ms INTEGER NOT NULL,
        reason TEXT NOT NULL,
        retry_after_ms INTEGER NOT NULL,
        cause TEXT,
        PRIMARY KEY (provider, model)
      );
      INSERT INTO cooldown VALUES ('llmgateway', '*', 999999, 'quota', 1000, 'quota');
      PRAGMA user_version = 1;
    `);
    raw.close();

    const opened = openModelStateStore({ path, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.store.listCooldowns({ nowMs: 0 })).toMatchObject({
      ok: true,
      value: [{ cause: "quota" }],
    });
    opened.store.close();

    const reopened = rawOpen(path);
    const columns = reopened
      .prepare("SELECT name FROM pragma_table_info('cooldown')")
      .all()
      .map((row) => recordOf(row).name);
    const version = recordOf(reopened.prepare("PRAGMA user_version").get());
    reopened.close();
    expect(columns).toEqual(expect.arrayContaining(["cause", "escalations", "last_mark_ms"]));
    expect(version.user_version).toBe(MODEL_STATE_SCHEMA_VERSION);
  });

  it("does not re-run the migration on an already-v2 file", () => {
    const path = tempDbPath();
    const first = openModelStateStore({ path, now: () => 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.store.markCooldown({
      provider: "llmgateway",
      durationMs: 60_000,
      reason: "429",
      cause: "quota",
      nowMs: 0,
    });
    first.store.close();

    const reopened = openModelStateStore({ path, now: () => 0 });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    // A migration replayed over v2 would lose the diagnostics columns' values.
    expect(reopened.store.listCooldowns({ nowMs: 0 })).toMatchObject({
      ok: true,
      value: [{ cause: "quota", escalations: 1 }],
    });
    reopened.store.close();
  });

  it("upserts and reads a model-scoped cooldown, then prunes it after expiry", () => {
    const path = tempDbPath();
    const opened = openModelStateStore({ path, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    const marked = store.markCooldown({
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      durationMs: 60_000,
      reason: "429",
      nowMs: 0,
    });
    expect(marked).toMatchObject({
      ok: true,
      value: {
        provider: "llmgateway",
        model: "mimo-v2.6-flash",
        untilMs: 60_000,
        retryAfterMs: 60_000,
      },
    });

    // A second mark for the same key is an upsert, not a duplicate row.
    store.markCooldown({
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      durationMs: 30_000,
      reason: "transient",
      nowMs: 1_000,
    });
    const active = store.cooldownFor({
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      nowMs: 1_000,
    });
    expect(active).toMatchObject({
      ok: true,
      value: { scope: "model", untilMs: 31_000, retryAfterMs: 30_000, reason: "transient" },
    });

    // A provider-wide mark is a different row and wins the scope decision.
    store.markCooldown({
      provider: "llmgateway",
      durationMs: 120_000,
      reason: "quota",
      nowMs: 1_000,
    });
    const providerWide = store.cooldownFor({
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      nowMs: 1_000,
    });
    expect(providerWide).toMatchObject({
      ok: true,
      value: { scope: "provider", retryAfterMs: 120_000 },
    });
    const otherModel = store.cooldownFor({
      provider: "llmgateway",
      model: "another-model",
      nowMs: 1_000,
    });
    expect(otherModel).toMatchObject({ ok: true, value: { scope: "provider" } });

    const expired = store.cooldownFor({
      provider: "llmgateway",
      model: "another-model",
      nowMs: 500_000,
    });
    expect(expired).toMatchObject({ ok: true, value: null });

    const pruned = store.prune(500_000 + COOLDOWN_ESCALATION_MEMORY_MS);
    expect(pruned).toMatchObject({ ok: true, value: { cooldowns: 2 } });

    store.close();
  });

  it("serves a cached cooldown read and invalidates it on a write", () => {
    const path = tempDbPath();
    let fakeNow = 0;
    const reader = openModelStateStore({ path, now: () => fakeNow });
    const writer = openModelStateStore({ path, now: () => fakeNow });
    expect(reader.ok).toBe(true);
    expect(writer.ok).toBe(true);
    if (!reader.ok || !writer.ok) return;

    const first = reader.store.cooldownFor({
      provider: "llmgateway",
      model: "cached-model",
      nowMs: fakeNow,
    });
    expect(first).toMatchObject({ ok: true, value: null });

    // Another process's write is invisible inside the reader's cache window...
    writer.store.markCooldown({
      provider: "llmgateway",
      model: "cached-model",
      durationMs: 60_000,
      reason: "429",
      nowMs: fakeNow,
    });
    fakeNow = 500;
    const insideWindow = reader.store.cooldownFor({
      provider: "llmgateway",
      model: "cached-model",
      nowMs: fakeNow,
    });
    expect(insideWindow).toMatchObject({ ok: true, value: null });

    // ...and visible once the window lapses.
    fakeNow = 1_500;
    const afterWindow = reader.store.cooldownFor({
      provider: "llmgateway",
      model: "cached-model",
      nowMs: fakeNow,
    });
    expect(afterWindow).toMatchObject({ ok: true, value: { scope: "model" } });

    // A local write invalidates immediately.
    reader.store.markCooldown({
      provider: "llmgateway",
      model: "fresh-model",
      durationMs: 60_000,
      reason: "429",
      nowMs: fakeNow,
    });
    const localWrite = reader.store.cooldownFor({
      provider: "llmgateway",
      model: "fresh-model",
      nowMs: fakeNow,
    });
    expect(localWrite).toMatchObject({ ok: true, value: { scope: "model" } });

    reader.store.close();
    writer.store.close();
  });

  it("reserves and releases capacity in one transaction and refuses past the limit", () => {
    const path = tempDbPath();
    const opened = openModelStateStore({ path, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    const first = store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 2,
      leaseId: "lease-a",
      nowMs: 0,
    });
    expect(first).toMatchObject({ ok: true, value: { granted: true, inUse: 1, limit: 2 } });

    const second = store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 2,
      leaseId: "lease-b",
      nowMs: 0,
    });
    expect(second).toMatchObject({ ok: true, value: { granted: true, inUse: 2, limit: 2 } });

    const refused = store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 2,
      leaseId: "lease-c",
      nowMs: 0,
    });
    expect(refused).toMatchObject({
      ok: true,
      value: { granted: false, reason: "capacity-exhausted", inUse: 2, limit: 2 },
    });

    const released = store.releaseCapacity({
      provider: "llmgateway",
      class: "standard",
      leaseId: "lease-a",
      nowMs: 0,
    });
    expect(released).toMatchObject({ ok: true, value: { released: true, inUse: 1 } });

    const unknown = store.releaseCapacity({
      provider: "llmgateway",
      class: "standard",
      leaseId: "lease-z",
      nowMs: 0,
    });
    expect(unknown).toMatchObject({ ok: true, value: { released: false, inUse: 1 } });

    const snapshot = store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 });
    expect(snapshot).toMatchObject({ ok: true, value: { inUse: 1, limit: 2 } });

    store.close();
  });

  it("frees an expired lease without any pid being alive", () => {
    const path = tempDbPath();
    let fakeNow = 0;
    const opened = openModelStateStore({ path, now: () => fakeNow });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    const lease = store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "killed-daemon",
      ttlMs: 1_000,
      nowMs: 0,
    });
    expect(lease).toMatchObject({ ok: true, value: { granted: true } });

    // A second daemon cannot take the slot while the lease is live.
    fakeNow = 500;
    const blocked = store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "second-daemon",
      nowMs: fakeNow,
    });
    expect(blocked).toMatchObject({
      ok: true,
      value: { granted: false, reason: "capacity-exhausted" },
    });

    // Expiry, not liveness: the killed daemon's pid is never consulted.
    fakeNow = 1_500;
    const granted = store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "second-daemon",
      nowMs: fakeNow,
    });
    expect(granted).toMatchObject({ ok: true, value: { granted: true, inUse: 1 } });

    store.close();
  });

  it("inserts spend rows and reconciles their totals", () => {
    const path = tempDbPath();
    const opened = openModelStateStore({ path, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    const row = {
      ts: 1_000,
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      phase: "scout",
      taskId: "bd-187",
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 5,
      cost: 0.25,
    };
    expect(store.recordSpend(row)).toMatchObject({ ok: true });
    expect(store.recordSpend({ ...row, input: 200, output: 60, cost: 0.5 })).toMatchObject({
      ok: true,
    });

    expect(store.spendTotals()).toMatchObject({
      ok: true,
      value: {
        rows: 2,
        input: 300,
        output: 100,
        cacheRead: 20,
        cacheWrite: 10,
        cost: 0.75,
      },
    });

    store.close();
  });

  it("opens read-only, serves reads and fails every write as a value", () => {
    const path = tempDbPath();
    const writer = openModelStateStore({ path, now: () => 0 });
    expect(writer.ok).toBe(true);
    if (!writer.ok) return;
    writer.store.markCooldown({
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      durationMs: 60_000,
      reason: "429",
      nowMs: 0,
    });
    writer.store.close();

    const opened = openModelStateStore({ path, readOnly: true, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;
    expect(store.readOnly).toBe(true);

    const read = store.cooldownFor({
      provider: "llmgateway",
      model: "mimo-v2.6-flash",
      nowMs: 1_000,
    });
    expect(read).toMatchObject({ ok: true, value: { scope: "model", untilMs: 60_000 } });
    expect(store.spendTotals()).toMatchObject({ ok: true, value: { rows: 0 } });

    const write = store.markCooldown({
      provider: "llmgateway",
      durationMs: 1_000,
      reason: "nope",
      nowMs: 1_000,
    });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error).toContain("read-only");

    const spend = store.recordSpend({
      ts: 1,
      provider: "p",
      model: "m",
      phase: "x",
      taskId: "",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
    expect(spend.ok).toBe(false);

    const reserve = store.reserveCapacity({
      provider: "p",
      class: "standard",
      limit: 1,
      leaseId: "l",
      nowMs: 1_000,
    });
    expect(reserve.ok).toBe(false);

    store.close();
  });

  it("returns a factory error for an unopenable path instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "belayd-model-state-bad-"));
    tempDirs.push(dir);
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");

    const opened = openModelStateStore({ path: join(blocker, "model-state.sqlite") });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error).toContain("could not open");

    const missing = openModelStateStore({
      path: join(dir, "absent.sqlite"),
      readOnly: true,
    });
    expect(missing.ok).toBe(false);
  });

  it("uses the provider-scope sentinel for a provider-wide row", () => {
    const path = tempDbPath();
    const opened = openModelStateStore({ path, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const marked = opened.store.markCooldown({
      provider: "llmgateway",
      durationMs: 1_000,
      reason: "quota",
      nowMs: 0,
    });
    expect(marked).toMatchObject({ ok: true, value: { model: PROVIDER_SCOPE_MODEL } });
    opened.store.close();
  });
});

describeSqlite("model state store ownership and file modes (bd-187 review)", () => {
  it("refuses a lease release from a different daemon", () => {
    const path = tempDbPath();
    const owner = openModelStateStore({ path, host: "host-a", daemonPid: 111, now: () => 0 });
    const intruder = openModelStateStore({ path, host: "host-b", daemonPid: 222, now: () => 0 });
    expect(owner.ok).toBe(true);
    expect(intruder.ok).toBe(true);
    if (!owner.ok || !intruder.ok) return;

    expect(
      owner.store.reserveCapacity({
        provider: "llmgateway",
        class: "standard",
        limit: 1,
        leaseId: "shared-lease",
        nowMs: 0,
      }),
    ).toMatchObject({ ok: true, value: { granted: true, inUse: 1 } });

    expect(
      intruder.store.releaseCapacity({
        provider: "llmgateway",
        class: "standard",
        leaseId: "shared-lease",
        nowMs: 0,
      }),
    ).toMatchObject({ ok: false, reason: "lease-not-owned" });

    // The refused release changed nothing.
    expect(
      owner.store.readCapacity({ provider: "llmgateway", class: "standard", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: { inUse: 1, limit: 1 } });

    expect(
      owner.store.releaseCapacity({
        provider: "llmgateway",
        class: "standard",
        leaseId: "shared-lease",
        nowMs: 0,
      }),
    ).toMatchObject({ ok: true, value: { released: true, inUse: 0 } });

    owner.store.close();
    intruder.store.close();
  });

  it("tightens the sqlite file and its WAL sidecars to 0600, directory 0700", () => {
    if (process.platform === "win32") return;
    const path = tempDbPath();
    const opened = openModelStateStore({ path, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    // A write creates/keeps the WAL sidecars alive.
    store.markCooldown({ provider: "llmgateway", durationMs: 1_000, reason: "429", nowMs: 0 });
    store.recordSpend({
      ts: 0,
      provider: "llmgateway",
      model: "m",
      phase: "scout",
      taskId: "bd-187",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
    });

    const dir = dirname(path);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const databaseFiles = readdirSync(dir).filter((name) => name.startsWith("model-state.sqlite"));
    expect(databaseFiles).toContain("model-state.sqlite");
    for (const name of databaseFiles) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }

    store.close();
  });
});

describeSqlite("model state store lease renewal (bd-187 W1)", () => {
  it("renews a live lease and never resurrects an expired one", () => {
    const path = tempDbPath();
    let fakeNow = 0;
    const opened = openModelStateStore({ path, now: () => fakeNow });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    expect(
      store.reserveCapacity({
        provider: "llmgateway",
        class: "standard",
        limit: 1,
        leaseId: "renew-me",
        ttlMs: 1_000,
        nowMs: 0,
      }),
    ).toMatchObject({ ok: true, value: { granted: true, expiresMs: 1_000 } });

    fakeNow = 500;
    expect(
      store.renewLease({
        leaseId: "renew-me",
        provider: "llmgateway",
        class: "standard",
        ttlMs: 1_000,
        nowMs: fakeNow,
      }),
    ).toMatchObject({ ok: true, value: { leaseId: "renew-me", expiresMs: 1_500 } });

    // Past the ORIGINAL expiry but inside the renewed one: the slot is still
    // held by the live stream.
    fakeNow = 1_200;
    expect(
      store.reserveCapacity({
        provider: "llmgateway",
        class: "standard",
        limit: 1,
        leaseId: "intruder",
        nowMs: fakeNow,
      }),
    ).toMatchObject({ ok: true, value: { granted: false, reason: "capacity-exhausted" } });

    // Past the renewed expiry the lease is gone; another process may hold the
    // slot, so the old lease cannot be renewed back to life.
    fakeNow = 1_600;
    expect(
      store.renewLease({
        leaseId: "renew-me",
        provider: "llmgateway",
        class: "standard",
        ttlMs: 1_000,
        nowMs: fakeNow,
      }),
    ).toMatchObject({ ok: false, reason: "lease-expired" });

    expect(
      store.reserveCapacity({
        provider: "llmgateway",
        class: "standard",
        limit: 1,
        leaseId: "intruder",
        nowMs: fakeNow,
      }),
    ).toMatchObject({ ok: true, value: { granted: true, inUse: 1 } });

    // Now that someone else holds the slot, the old lease must still not revive.
    expect(
      store.renewLease({
        leaseId: "renew-me",
        provider: "llmgateway",
        class: "standard",
        ttlMs: 1_000,
        nowMs: fakeNow + 100,
      }),
    ).toMatchObject({ ok: false, reason: "lease-expired" });

    store.close();
  });

  it("invalidates the read cache on renewal, like release", () => {
    const path = tempDbPath();
    let fakeNow = 0;
    const reader = openModelStateStore({ path, now: () => fakeNow });
    const writer = openModelStateStore({ path, now: () => fakeNow });
    expect(reader.ok).toBe(true);
    expect(writer.ok).toBe(true);
    if (!reader.ok || !writer.ok) return;

    expect(
      reader.store.reserveCapacity({
        provider: "llmgateway",
        class: "standard",
        limit: 1,
        leaseId: "renew-me",
        ttlMs: 10_000,
        nowMs: 0,
      }),
    ).toMatchObject({ ok: true, value: { granted: true } });

    // Prime the reader's cooldown cache with a miss.
    expect(
      reader.store.cooldownFor({ provider: "llmgateway", model: "m", nowMs: 0 }),
    ).toMatchObject({ ok: true, value: null });
    writer.store.markCooldown({
      provider: "llmgateway",
      model: "m",
      durationMs: 60_000,
      reason: "429",
      nowMs: 0,
    });

    fakeNow = 500;
    // Still inside the cache window: the other connection's row is hidden.
    expect(
      reader.store.cooldownFor({ provider: "llmgateway", model: "m", nowMs: fakeNow }),
    ).toMatchObject({ ok: true, value: null });

    expect(
      reader.store.renewLease({
        leaseId: "renew-me",
        provider: "llmgateway",
        class: "standard",
        ttlMs: 10_000,
        nowMs: fakeNow,
      }),
    ).toMatchObject({ ok: true });

    // The renewal commit invalidated the cache, so the row is visible now.
    expect(
      reader.store.cooldownFor({ provider: "llmgateway", model: "m", nowMs: fakeNow }),
    ).toMatchObject({ ok: true, value: { scope: "model", retryAfterMs: 60_000 } });

    reader.store.close();
    writer.store.close();
  });

  it("re-tightens the file modes on renewal, like release", () => {
    if (process.platform === "win32") return;
    const path = tempDbPath();
    const opened = openModelStateStore({ path, now: () => 0 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "renew-me",
      ttlMs: 10_000,
      nowMs: 0,
    });
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    expect(
      store.renewLease({
        leaseId: "renew-me",
        provider: "llmgateway",
        class: "standard",
        ttlMs: 10_000,
        nowMs: 100,
      }),
    ).toMatchObject({ ok: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    store.close();
  });

  it("refuses renewal from a different daemon", () => {
    const path = tempDbPath();
    const owner = openModelStateStore({ path, host: "host-a", daemonPid: 111, now: () => 0 });
    const intruder = openModelStateStore({ path, host: "host-b", daemonPid: 222, now: () => 0 });
    expect(owner.ok).toBe(true);
    expect(intruder.ok).toBe(true);
    if (!owner.ok || !intruder.ok) return;

    owner.store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "owned",
      nowMs: 0,
    });
    expect(
      intruder.store.renewLease({
        leaseId: "owned",
        provider: "llmgateway",
        class: "standard",
        nowMs: 100,
      }),
    ).toMatchObject({ ok: false, reason: "lease-not-owned" });

    owner.store.close();
    intruder.store.close();
  });
});

describe("store failure classification (bd-256 review)", () => {
  function codeError(code: string, message: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
  }

  it.each([
    ["SQLITE_BUSY: database is locked", "transient"],
    ["SQLITE_LOCKED: database table is locked", "transient"],
    ["SQLITE_BUSY_SNAPSHOT: database is locked (snapshot)", "transient"],
    ["SQLITE_PROTOCOL: locking protocol", "transient"],
    ["SQLITE_IOERR: disk I/O error", "transient"],
    ["disk I/O error", "transient"],
    ["SQLITE_IOERR_SHMOPEN: unable to open shared memory", "transient"],
    ["SQLITE_FULL: database or disk is full", "transient"],
    ["database or disk is full", "transient"],
    ["SQLITE_NOMEM: out of memory", "transient"],
    ["SQLITE_INTERRUPT: interrupted", "transient"],
    ["database is busy", "transient"],
    ["EIO: i/o error", "transient"],
    ["EINTR: interrupted system call", "transient"],
    ["ENOMEM: not enough memory", "transient"],
    ["ENOTDIR: not a directory, mkdir '/tmp/x/blocker/nested'", "permanent"],
    ["EACCES: permission denied, mkdir '/root/state'", "permanent"],
    ["EROFS: read-only file system", "permanent"],
    ["node:sqlite unavailable: Cannot find module", "permanent"],
    ["unable to open database file", "permanent"],
    ["file is not a database", "permanent"],
    ["SQLITE_READONLY: attempt to write a readonly database", "permanent"],
    ["something nobody has seen before", "permanent"],
  ])("classifies %s as %s", (message, expected) => {
    expect(classifyStoreFailure(new Error(message))).toBe(expected);
  });

  it("reads a structured error code as well as the message", () => {
    expect(classifyStoreFailure(codeError("SQLITE_BUSY", "whatever"))).toBe("transient");
    expect(classifyStoreFailure(codeError("EACCES", "whatever"))).toBe("permanent");
  });

  it("classifies node:sqlite's numeric errcode (extended codes masked)", () => {
    // node:sqlite reports `code: "ERR_SQLITE_ERROR"` plus a numeric `errcode`
    // and the bare errstr, so the text alone is not always enough.
    function sqliteError(errcode: number, message: string): Error & { errcode: number } {
      const error = new Error(message) as Error & { errcode: number; code: string };
      error.code = "ERR_SQLITE_ERROR";
      error.errcode = errcode;
      return error;
    }
    // 10 = SQLITE_IOERR, 517 = SQLITE_IOERR_BUSY_SNAPSHOT-style extended code.
    expect(classifyStoreFailure(sqliteError(10, "disk I/O error"))).toBe("transient");
    expect(classifyStoreFailure(sqliteError(5 | (2 << 8), "database is locked"))).toBe("transient");
    // 0 is SQLITE_OK: nonsense as a failure, so it falls through to permanent.
    expect(classifyStoreFailure(sqliteError(0, "nobody knows"))).toBe("permanent");
  });

  it("lets a permanent classification win over a transient word in the message", () => {
    expect(
      classifyStoreFailure(new Error("SQLITE_NOTADB: file is not a database (busy lock)")),
    ).toBe("permanent");
  });
});

describeSqlite("schema retry policy (bd-256 review)", () => {
  interface FakeSchemaDatabase extends SqliteDatabaseLike {
    beginAttempts(): number;
  }

  /** A database whose first `BEGIN IMMEDIATE` calls fail with the given messages. */
  function fakeSchemaDatabase(failures: readonly string[]): FakeSchemaDatabase {
    let attempts = 0;
    const columns = [
      "provider",
      "model",
      "until_ms",
      "reason",
      "retry_after_ms",
      "cause",
      "escalations",
      "last_mark_ms",
    ];
    return {
      beginAttempts: () => attempts,
      exec(sql) {
        if (sql !== "BEGIN IMMEDIATE") return;
        const failure = failures[attempts];
        attempts += 1;
        if (failure !== undefined) throw new Error(failure);
      },
      prepare(sql) {
        return {
          run: () => ({ changes: 1, lastInsertRowid: 1 }),
          get: () => undefined,
          all: () => (sql.includes("pragma_table_info") ? columns.map((name) => ({ name })) : []),
        };
      },
      close: () => undefined,
    };
  }

  it("fails on the first attempt for a permanent error", () => {
    const database = fakeSchemaDatabase([
      "SQLITE_NOTADB: file is not a database",
      "this attempt must never run",
    ]);
    const attempts: number[] = [];
    const opened = openModelStateStore({
      path: "/tmp/belayd-fake-state.sqlite",
      database,
      onSchemaAttempt: (attempt) => attempts.push(attempt),
    });

    expect(opened.ok).toBe(false);
    expect(attempts).toEqual([1]);
    expect(database.beginAttempts()).toBe(1);
  });

  it("retries a busy error and succeeds", () => {
    const database = fakeSchemaDatabase(["SQLITE_BUSY: database is locked"]);
    const attempts: number[] = [];
    const opened = openModelStateStore({
      path: "/tmp/belayd-fake-state.sqlite",
      database,
      onSchemaAttempt: (attempt) => attempts.push(attempt),
    });

    expect(opened.ok).toBe(true);
    expect(attempts).toEqual([1, 2]);
    if (opened.ok) opened.store.close();
  });
});

describeSqlite("shared store failure handling (bd-256 review)", () => {
  const ENV_KEYS = [MODEL_STATE_FILE_ENV, LEGACY_COOLDOWN_FILE_ENV, "XDG_STATE_HOME"] as const;
  const savedEnv = new Map<string, string | undefined>();
  const openedStores: ModelStateStore[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    delete process.env[LEGACY_COOLDOWN_FILE_ENV];
    process.env.XDG_STATE_HOME = join(tempDirForReview(), "xdg");
    resetSharedModelStateStore();
  });

  afterEach(() => {
    resetSharedModelStateStore();
    for (const store of openedStores.splice(0)) store.close();
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  function tempDirForReview(): string {
    const dir = mkdtempSync(join(tmpdir(), "belayd-shared-store-"));
    tempDirs.push(dir);
    return dir;
  }

  function openTempStore(path: string, now: () => number): ModelStateStore {
    const opened = openModelStateStore({ path, now });
    if (!opened.ok) throw new Error(opened.error);
    openedStores.push(opened.store);
    return opened.store;
  }

  it("stops retrying a permanent failure and warns once", () => {
    const dir = tempDirForReview();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    process.env[MODEL_STATE_FILE_ENV] = join(blocker, "nested", "state.sqlite");
    resetSharedModelStateStore();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      expect(sharedModelStateStore()).toBeNull();
      // Many accesses across many retry windows: a permanent failure is not
      // retried, so the warning cannot repeat every 30 s forever.
      for (let step = 1; step <= 5; step += 1) {
        vi.setSystemTime(t0 + step * SHARED_MODEL_STATE_RETRY_MS * 2);
        expect(sharedModelStateStore()).toBeNull();
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("not retrying");
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("does not capture marks for a permanent failure", () => {
    const dir = tempDirForReview();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    process.env[MODEL_STATE_FILE_ENV] = join(blocker, "nested", "state.sqlite");
    resetSharedModelStateStore();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      createModelCooldownStore().markProviderCooldown("commandcode", 600, "quota");
    } finally {
      warn.mockRestore();
    }

    // A later healthy access must not resurrect the dropped mark.
    const path = join(tempDirForReview(), "recovered.sqlite");
    process.env[MODEL_STATE_FILE_ENV] = path;
    resetSharedModelStateStore();
    const adapter = createModelCooldownStore();
    expect(adapter.providerEntries().size).toBe(0);
  });

  it("queues a mark across a transient outage and flushes it before serving reads", () => {
    const path = join(tempDirForReview(), "state.sqlite");
    process.env[MODEL_STATE_FILE_ENV] = path;
    resetSharedModelStateStore();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      const transient = sharedModelStateStore(() => Date.now(), {
        open: () => ({ ok: false, error: "database is locked" }),
      });
      expect(transient?.pendingFlush).toBe(true);

      // Both write paths record into the facade while persistence is gone.
      const policy = createProviderPolicy({ store: () => sharedModelStateStore() });
      policy.recordFailure({
        provider: "llmgateway",
        model: "mimo-v2.6-flash",
        classification: {
          kind: "quota",
          model: "mimo-v2.6-flash",
          reason: "quota",
          cooldownSeconds: 900,
          cooldownHinted: false,
        },
      });
      const routing = createModelCooldownStore();
      routing.markProviderCooldown("opencode-go", 600, "quota", { cause: "quota" });

      // Nothing is durable yet, so reads stay permissive (and report degraded).
      expect(
        policy.decideDispatch({ provider: "llmgateway", model: "mimo-v2.6-flash" }),
      ).toMatchObject({ allowed: true, degraded: true });
      expect(routing.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(false);

      // The lock clears; the next access after the retry window opens, and the
      // flush happens before the store serves the read.
      vi.setSystemTime(t0 + SHARED_MODEL_STATE_RETRY_MS + 1);
      const recovered = openTempStore(path, () => Date.now());
      const opened = sharedModelStateStore(() => Date.now(), {
        open: () => ({ ok: true, store: recovered }),
      });
      expect(opened).toBe(recovered);

      expect(
        policy.decideDispatch({ provider: "llmgateway", model: "mimo-v2.6-flash" }),
      ).toMatchObject({ allowed: false, scope: "provider" });
      expect(routing.isCoolingDown("opencode-go/mimo-v2.6-flash")).toBe(true);
      expect(routing.providerEntries().get("opencode-go")).toHaveProperty("cause", "quota");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("bounds the pending queue to the most recent marks", () => {
    const path = join(tempDirForReview(), "state.sqlite");
    process.env[MODEL_STATE_FILE_ENV] = path;
    resetSharedModelStateStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const facade = sharedModelStateStore(() => Date.now(), {
        open: () => ({ ok: false, error: "SQLITE_BUSY: database is locked" }),
      });
      if (facade === null) throw new Error("expected the transient facade");
      for (let index = 0; index < MAX_PENDING_COOLDOWN_MARKS + 8; index += 1) {
        facade.markCooldown({ provider: `provider-${index}`, durationMs: 60_000, reason: "quota" });
      }

      // Past the retry window, so the next access really opens (and flushes).
      vi.setSystemTime(Date.now() + SHARED_MODEL_STATE_RETRY_MS + 1);
      const flushPath = join(tempDirForReview(), "flush.sqlite");
      const recovered = openTempStore(flushPath, () => Date.now());
      sharedModelStateStore(() => Date.now(), { open: () => ({ ok: true, store: recovered }) });

      const rows = recovered.listCooldowns({ nowMs: Date.now() });
      expect(rows.ok).toBe(true);
      if (!rows.ok) return;
      expect(rows.value).toHaveLength(MAX_PENDING_COOLDOWN_MARKS);
      expect(rows.value.map((row) => row.provider)).not.toContain("provider-0");
      expect(rows.value.map((row) => row.provider)).toContain(
        `provider-${MAX_PENDING_COOLDOWN_MARKS + 7}`,
      );
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("drops a pending mark whose window already elapsed", () => {
    process.env[MODEL_STATE_FILE_ENV] = join(tempDirForReview(), "state.sqlite");
    resetSharedModelStateStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      const facade = sharedModelStateStore(() => Date.now(), {
        open: () => ({ ok: false, error: "database is locked" }),
      });
      if (facade === null) throw new Error("expected the transient facade");
      facade.markCooldown({ provider: "opencode-go", durationMs: 60_000, reason: "quota" });

      vi.setSystemTime(t0 + MAX_PENDING_COOLDOWN_AGE_MS + 1);
      const path = join(tempDirForReview(), "flush.sqlite");
      const recovered = openTempStore(path, () => Date.now());
      sharedModelStateStore(() => Date.now(), { open: () => ({ ok: true, store: recovered }) });

      const rows = recovered.listCooldowns({ nowMs: Date.now() });
      expect(rows).toMatchObject({ ok: true, value: [] });
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("replays a live long window queued during an outage longer than the age bound", () => {
    process.env[MODEL_STATE_FILE_ENV] = join(tempDirForReview(), "state.sqlite");
    resetSharedModelStateStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      const facade = sharedModelStateStore(() => Date.now(), {
        open: () => ({ ok: false, error: "SQLITE_BUSY: database is locked" }),
      });
      if (facade === null) throw new Error("expected the transient facade");
      // A laddered weekly bucket and a hinted 20-minute reset, both queued while
      // persistence is gone. Both are still live after an 11-minute outage, so
      // dropping them by queue age would re-probe a provider already spent.
      facade.markCooldown({
        provider: "commandcode",
        durationMs: 24 * 3_600_000,
        reason: "weekly limit",
      });
      facade.markCooldown({
        provider: "opencode-go",
        durationMs: 1_200_000,
        reason: "Resets in 20min",
        hinted: true,
      });

      vi.setSystemTime(t0 + MAX_PENDING_COOLDOWN_AGE_MS + 60_000);
      const path = join(tempDirForReview(), "flush.sqlite");
      const recovered = openTempStore(path, () => Date.now());
      sharedModelStateStore(() => Date.now(), { open: () => ({ ok: true, store: recovered }) });

      const rows = recovered.listCooldowns({ nowMs: Date.now() });
      expect(rows.ok).toBe(true);
      if (!rows.ok) return;
      expect(rows.value.map((row) => row.provider).sort()).toEqual(["commandcode", "opencode-go"]);
      const policy = createProviderPolicy({ store: () => recovered });
      expect(policy.decideDispatch({ provider: "commandcode", model: "glm-5.3" })).toMatchObject({
        allowed: false,
        scope: "provider",
      });
      expect(
        policy.decideDispatch({ provider: "opencode-go", model: "mimo-v2.6-flash" }),
      ).toMatchObject({ allowed: false, scope: "provider" });
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("evicts a stale and a duplicate mark before a live provider's window", () => {
    process.env[MODEL_STATE_FILE_ENV] = join(tempDirForReview(), "state.sqlite");
    resetSharedModelStateStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      const facade = sharedModelStateStore(() => Date.now(), {
        open: () => ({ ok: false, error: "SQLITE_BUSY: database is locked" }),
      });
      if (facade === null) throw new Error("expected the transient facade");

      // A zero-length window is already stale; a second, longer mark for the
      // same row supersedes the shorter one.
      for (let index = 0; index < MAX_PENDING_COOLDOWN_MARKS - 3; index += 1) {
        facade.markCooldown({ provider: `filler-${index}`, durationMs: 60_000, reason: "quota" });
      }
      facade.markCooldown({ provider: "stale-go", durationMs: 0, reason: "quota" });
      facade.markCooldown({
        provider: "llmgateway",
        model: "mimo-v2.6-flash",
        durationMs: 60_000,
        reason: "short",
      });
      facade.markCooldown({
        provider: "llmgateway",
        model: "mimo-v2.6-flash",
        durationMs: 6 * 3_600_000,
        reason: "long",
      });

      // Two overflow pushes: the stale mark goes first, then the superseded
      // duplicate. Neither may evict the oldest live mark (filler-0).
      facade.markCooldown({ provider: "filler-last", durationMs: 60_000, reason: "quota" });
      facade.markCooldown({ provider: "filler-last-2", durationMs: 60_000, reason: "quota" });

      vi.setSystemTime(t0 + SHARED_MODEL_STATE_RETRY_MS + 1);
      const path = join(tempDirForReview(), "flush.sqlite");
      const recovered = openTempStore(path, () => Date.now());
      sharedModelStateStore(() => Date.now(), { open: () => ({ ok: true, store: recovered }) });

      const rows = recovered.listCooldowns({ nowMs: Date.now() });
      expect(rows.ok).toBe(true);
      if (!rows.ok) return;
      const providers = rows.value.map((row) => row.provider);
      expect(providers).not.toContain("stale-go");
      expect(providers).toContain("filler-0");
      expect(providers).toContain("filler-last-2");
      const llmgateway = rows.value.find((row) => row.provider === "llmgateway");
      // The longer window of the duplicate pair is the one that survived.
      expect(llmgateway).toHaveProperty("reason", "long");
      expect(rows.value).toHaveLength(MAX_PENDING_COOLDOWN_MARKS);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("treats SQLITE_IOERR at first open as transient and recovers", () => {
    const recoveredPath = join(tempDirForReview(), "ioerr.sqlite");
    process.env[MODEL_STATE_FILE_ENV] = recoveredPath;
    resetSharedModelStateStore();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      // node:sqlite reports a bare "disk I/O error" with code ERR_SQLITE_ERROR;
      // classifying that as permanent would switch cooldown tracking off for
      // the process after a single storage hiccup.
      const facade = sharedModelStateStore(() => Date.now(), {
        open: () => ({ ok: false, error: "SQLITE_IOERR: disk I/O error" }),
      });
      expect(facade?.pendingFlush).toBe(true);
      expect(String(warn.mock.calls[0]?.[0])).toContain("queued and retried");

      vi.setSystemTime(t0 + SHARED_MODEL_STATE_RETRY_MS + 1);
      const recovered = sharedModelStateStore(() => Date.now());
      expect(recovered).not.toBeNull();
      expect(recovered?.pendingFlush).toBeUndefined();
      expect(recovered?.path).toBe(recoveredPath);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});
