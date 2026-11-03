/**
 * Two-process proof for the shared model-state store (bd-187).
 *
 * The acceptance criteria are cross-process facts, so they are proven with real
 * child processes over one SQLite file:
 *
 * - two processes see ONE cooldown window (including the short read-cache lapse
 *   a second process's store needs before it observes a window written after it
 *   opened);
 * - a lease left by a SIGKILLed daemon expires and frees capacity without any
 *   pid being alive;
 * - spend rows reconcile exactly with provider-reported usage for a fixed
 *   workload.
 *
 * The child fixture talks to `node:sqlite` directly (see its header); our own
 * store is exercised in the parent for the same file.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openModelStateStore } from "../src/model-state-store.js";
import { createProviderPolicy } from "../src/provider-policy.js";
import type { ProviderLike, ProviderStreamLike } from "../src/provider-wrapper.js";
import { wrapProvider } from "../src/provider-wrapper.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureScript = join(testDir, "fixtures", "model-state-process.mjs");

const sqliteProbe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
});

const sqliteAvailable = sqliteProbe.status === 0;
if (!sqliteAvailable) {
  console.warn(
    `Skipping integration test: node:sqlite unavailable (${sqliteProbe.stderr.trim() || `exit ${String(sqliteProbe.status)}`})`,
  );
}
const describeSqlite = sqliteAvailable ? describe : describe.skip;

const children: ReturnType<typeof spawn>[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-model-state-integration-"));
  tempDirs.push(dir);
  return dir;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

interface ChildOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function runChild(args: readonly string[]): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixtureScript, ...args], { env: { ...process.env } });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("close", () => {
      if (stderr !== "") process.stderr.write(stderr);
    });
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Poll a JSON file written by a child, tolerating a partially written read. */
async function waitForJson(
  path: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const parsed = readJson(path);
        if (predicate(parsed)) return parsed;
      } catch {
        /* the child is mid-write; retry */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path} to satisfy its predicate`);
}

describeSqlite("shared model-state store across processes (bd-187)", () => {
  it("two concurrent processes see one cooldown window, after the reader's cache lapses", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "model-state.sqlite");
    const untilFile = join(dir, "until.json");
    const readFile = join(dir, "read.json");

    // Open the reader store BEFORE the window exists: this is the case that the
    // read cache can hide for one window.
    let fakeNow = 0;
    const opened = openModelStateStore({ path: dbPath, now: () => fakeNow });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const reader = opened.store;

    const cached = reader.cooldownFor({
      provider: "llmgateway",
      model: "shared-model",
      nowMs: fakeNow,
    });
    expect(cached).toMatchObject({ ok: true, value: null });

    const writeOutcome = await runChild([dbPath, "write-cooldown", "60000", untilFile]);
    expect(writeOutcome).toMatchObject({ code: 0 });
    const written = readJson(untilFile);
    const untilMs = Number(written.until_ms);
    expect(untilMs).toBeGreaterThan(0);

    // Inside the read-cache window the second process's store cannot know yet.
    fakeNow = 500;
    const stillCached = reader.cooldownFor({
      provider: "llmgateway",
      model: "shared-model",
      nowMs: fakeNow,
    });
    expect(stillCached).toMatchObject({ ok: true, value: null });

    // After the cache window every process sees the same window.
    fakeNow = 1_500;
    const visible = reader.cooldownFor({
      provider: "llmgateway",
      model: "shared-model",
      nowMs: fakeNow,
    });
    expect(visible).toMatchObject({
      ok: true,
      value: { scope: "model", untilMs, retryAfterMs: 60_000 },
    });

    // A second real process reads the same row independently.
    const readerOutcome = await runChild([dbPath, "read-cooldown", readFile]);
    expect(readerOutcome).toMatchObject({ code: 0 });
    const observed = readJson(readFile);
    expect(observed.row).toMatchObject({
      provider: "llmgateway",
      model: "shared-model",
      until_ms: untilMs,
      retry_after_ms: 60_000,
    });

    reader.close();
  });

  it("a lease left by SIGKILL expires and frees capacity", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "model-state.sqlite");
    const readyFile = join(dir, "ready.json");
    // Long enough that opening the store after the crash cannot race the expiry
    // on a slow machine; the test advances its own clock instead of waiting.
    const leaseTtlMs = 60_000;

    // Create the schema through the real store first (a write open owns it).
    const owner = openModelStateStore({ path: dbPath });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    owner.store.close();

    const crashOutcome = await runChild([dbPath, "crash-lease", String(leaseTtlMs), readyFile]);
    expect(crashOutcome.signal).toBe("SIGKILL");
    await waitForFile(readyFile, 5_000);

    let fakeNow = Date.now();
    const opened = openModelStateStore({ path: dbPath, now: () => fakeNow });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    const blocked = store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "second-daemon",
      nowMs: fakeNow,
    });
    expect(blocked).toMatchObject({
      ok: true,
      value: { granted: false, reason: "capacity-exhausted", inUse: 1, limit: 1 },
    });

    // No pid check involved: the dead daemon's lease simply runs out.
    fakeNow += leaseTtlMs + 1_000;
    const granted = store.reserveCapacity({
      provider: "llmgateway",
      class: "standard",
      limit: 1,
      leaseId: "second-daemon",
      nowMs: fakeNow,
    });
    expect(granted).toMatchObject({
      ok: true,
      value: { granted: true, leaseId: "second-daemon", inUse: 1, limit: 1 },
    });

    const capacity = store.readCapacity({
      provider: "llmgateway",
      class: "standard",
      nowMs: fakeNow,
    });
    expect(capacity).toMatchObject({ ok: true, value: { inUse: 1, limit: 1 } });

    store.close();
  });

  it("a live child keeps its lease renewed past the original TTL across connections", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "model-state.sqlite");
    const progressFile = join(dir, "progress.json");
    const releaseFile = join(dir, "release");
    // Real time here: the heartbeat is what keeps the slot alive, and the point
    // is that a SECOND connection sees the renewal (WAL visibility).
    const leaseTtlMs = 1_500;
    const intervalMs = 200;

    // Create the schema through the real store first (a write open owns it).
    const owner = openModelStateStore({ path: dbPath });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    owner.store.close();

    const childRun = runChild([
      dbPath,
      "hold-lease",
      String(leaseTtlMs),
      String(intervalMs),
      progressFile,
      releaseFile,
    ]);

    // Wait until the child has renewed well past its ORIGINAL TTL (8 renewals at
    // 200 ms is 1.6 s > 1.5 s), so a plain expiry can no longer explain the slot
    // still being held.
    const progress = await waitForJson(
      progressFile,
      (value) => Number(value.renewals) >= 8,
      10_000,
    );
    expect(progress.renewals as number).toBeGreaterThanOrEqual(8);
    expect(Date.now() - Number(progress.started_ms)).toBeGreaterThan(leaseTtlMs);

    const opened = openModelStateStore({ path: dbPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;

    // The parent's own connection sees the renewed lease: the child is alive.
    expect(
      store.reserveCapacity({
        provider: "llmgateway",
        class: "standard",
        limit: 1,
        leaseId: "parent-daemon",
        nowMs: Date.now(),
      }),
    ).toMatchObject({ ok: true, value: { granted: false, reason: "capacity-exhausted" } });

    // Release, then the same bucket accepts the next reservation.
    writeFileSync(releaseFile, "release");
    expect(await childRun).toMatchObject({ code: 0 });
    const released = readJson(progressFile);
    expect(released).toMatchObject({ released: true });

    expect(
      store.reserveCapacity({
        provider: "llmgateway",
        class: "standard",
        limit: 1,
        leaseId: "parent-daemon",
        nowMs: Date.now(),
      }),
    ).toMatchObject({ ok: true, value: { granted: true, leaseId: "parent-daemon" } });

    store.close();
  });

  it("spend rows reconcile exactly with provider-reported usage", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "model-state.sqlite");
    const opened = openModelStateStore({ path: dbPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.store;
    const policy = createProviderPolicy({ store: () => store });

    const usage = { input: 1_000, output: 250, cacheRead: 40, cacheWrite: 10 };
    const cost = 0.125;
    const calls = 4;
    const provider: ProviderLike = {
      id: "llmgateway",
      stream: () =>
        ({
          result: async () => ({
            role: "assistant",
            stopReason: "end",
            model: "shared-model",
            usage: { ...usage, cost: { total: cost } },
          }),
        }) satisfies ProviderStreamLike,
      streamSimple: () => {
        throw new Error("unused");
      },
    };
    const wrapped = wrapProvider(provider, policy, { phase: "scout", taskId: "bd-187" });

    for (let index = 0; index < calls; index += 1) {
      const stream = (
        wrapped.stream as unknown as (model: unknown, context: unknown) => ProviderStreamLike
      )({ id: "shared-model" }, {});
      await stream.result();
    }

    const totals = store.spendTotals();
    expect(totals).toMatchObject({
      ok: true,
      value: {
        rows: calls,
        input: usage.input * calls,
        output: usage.output * calls,
        cacheRead: usage.cacheRead * calls,
        cacheWrite: usage.cacheWrite * calls,
        cost: cost * calls,
      },
    });

    store.close();
  });
});
