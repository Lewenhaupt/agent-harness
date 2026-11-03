import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COOLDOWN_ESCALATION_MEMORY_MS } from "../model-cooldown.js";
import {
  defaultModelStatePath,
  MODEL_STATE_FILE_ENV,
  MODEL_STATE_SCHEMA_VERSION,
  openModelStateStore,
  PROVIDER_SCOPE_MODEL,
  resolveModelStatePath,
} from "../model-state-store.js";

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

  it("uses the bead's cooldown column names", () => {
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
    expect(columns).toEqual(["provider", "model", "until_ms", "reason", "retry_after_ms"]);
    raw.close();
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
