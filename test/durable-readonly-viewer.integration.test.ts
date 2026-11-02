import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDurableStore } from "../src/durable-member/standalone-store.js";
import { DEFAULT_LIVE_STALE_AFTER_MS, openDurableViewer } from "../src/durable-member/viewer.js";

/**
 * Two-process WAL probe (bd-186).
 *
 * The bead says "prove it, do not assume": pi-durable documents one owner per
 * storage with no cross-process locking, while `readOnly` is the designed second
 * process and SQLite WAL allows concurrent readers. This test spawns a real
 * writer process (WAL, holding its write connection) and a real read-only viewer
 * process over the same file, asserts the viewer observes committed deltas while
 * the writer is live, and asserts the viewer's write is rejected.
 *
 * Both children use `node:sqlite` directly: the probe is about SQLite, not about
 * our TypeScript modules, so it must not depend on a TS toolchain. The test also
 * opens our own `openDurableViewer` against the same live file, so the panel's
 * actual read path is exercised under the same conditions.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(testDir, "fixtures");
const writerScript = join(fixtureDir, "durable-readonly-writer.mjs");
const viewerScript = join(fixtureDir, "durable-readonly-viewer.mjs");
const crashWriterScript = join(fixtureDir, "durable-crash-writer.mjs");

const sqliteProbe = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
});

const children: ReturnType<typeof spawn>[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
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
  readonly stdout: string;
  readonly stderr: string;
}

function runChild(
  script: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: childEnv() });
    children.push(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `child ${script} exceeded ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("durable member: read-only viewer as a second process", () => {
  it("receives WAL deltas from a live writer and its write attempt is rejected", async (context) => {
    if (sqliteProbe.status !== 0) {
      // Loud skip: a silent pass would hide that the probe never ran.
      console.warn(
        `Skipping integration test: node:sqlite unavailable (${String(sqliteProbe.stderr).trim()})`,
      );
      context.skip();
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "belayd-durable-probe-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "store.sqlite");
    const readyPath = join(dir, "writer-ready");
    const donePath = join(dir, "writer-done");

    // Create the schema (and switch the file to WAL) before the children start,
    // so the writer only inserts and the viewer only reads.
    const schema = openDurableStore({ path: dbPath });
    if (!schema.ok) throw new Error(schema.error);
    schema.store.close();

    const writer = spawn(process.execPath, [writerScript, dbPath, readyPath, donePath], {
      env: childEnv(),
    });
    children.push(writer);
    let writerStderr = "";
    writer.stderr?.setEncoding("utf8");
    writer.stderr?.on("data", (chunk: string) => {
      writerStderr += chunk;
    });

    await waitForFile(readyPath, 5_000);
    // The writer holds an open read-write connection from here on.

    const viewer = await runChild(viewerScript, [dbPath], 15_000);
    expect(viewer.code, `viewer failed\nstderr:\n${viewer.stderr}`).toBe(0);

    const lines = viewer.stdout.split("\n").filter((line) => line.trim() !== "");
    const summaryLine = lines.at(-1);
    expect(summaryLine, viewer.stdout).toBeDefined();
    const summary = JSON.parse(summaryLine ?? "{}") as {
      observed: number;
      last: number;
      afterWrite: number;
      writeRejected: boolean;
      writeError: string;
    };

    // Deltas observed while the writer's write connection stayed open: the
    // read-only process saw entries 1..5 as they were committed.
    expect(summary.observed, viewer.stdout).toBeGreaterThanOrEqual(2);
    expect(summary.last).toBe(5);
    expect(summary.writeRejected).toBe(true);
    expect(summary.writeError).toMatch(/readonly/i);
    expect(summary.afterWrite).toBe(5);

    await waitForFile(donePath, 5_000);

    // The panel's own read path, under the same live-writer conditions.
    const opened = openDurableViewer({
      storePath: dbPath,
      memberId: "member-a",
      conversationId: "member-a:main",
      pollIntervalMs: 10,
    });
    expect(opened.ok, opened.ok ? "" : opened.error).toBe(true);
    if (opened.ok) {
      expect(
        opened.reader
          .transcript()
          .window()
          .entries.map((entry) => entry.id),
      ).toEqual(["w-1", "w-2", "w-3", "w-4", "w-5"]);
      opened.reader.close();
    }

    // Stop the writer, then read as sole owner: the viewer's rejected write left
    // no row behind.
    if (writer.exitCode === null) writer.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      writer.once("exit", () => resolve());
    });
    expect(writerStderr).not.toMatch(/Error/);

    const finalStore = openDurableStore({ path: dbPath });
    if (!finalStore.ok) throw new Error(finalStore.error);
    const finalIds = finalStore.store
      .readEntryWindow("member-a:main", { limit: 10 })
      .entries.map((entry) => entry.id);
    expect(finalIds).toEqual(["w-1", "w-2", "w-3", "w-4", "w-5"]);
    finalStore.store.close();
  });

  // bd-186 AC (read): "a crashed member's last committed state still renders
  // after restart". The writer here dies with SIGKILL, so nothing was closed,
  // checkpointed or flushed by the member: whatever the readers show came from
  // the committed WAL, not from a clean shutdown path.
  it("still renders the last committed state after the writer is killed", async (context) => {
    if (sqliteProbe.status !== 0) {
      console.warn(
        `Skipping integration test: node:sqlite unavailable (${String(sqliteProbe.stderr).trim()})`,
      );
      context.skip();
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "belayd-durable-crash-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "store.sqlite");
    const readyPath = join(dir, "writer-ready");

    const schema = openDurableStore({ path: dbPath });
    if (!schema.ok) throw new Error(schema.error);
    schema.store.close();

    const crash = await runChild(crashWriterScript, [dbPath, readyPath], 15_000);
    expect(crash.code, `crash writer exited cleanly\nstderr:\n${crash.stderr}`).toBeNull();
    expect(crash.signal).toBe("SIGKILL");
    await waitForFile(readyPath, 5_000);
    // A SIGKILLed SQLite connection leaves its WAL behind; only a clean close of
    // the last connection removes it. This is what makes the case a crash.
    expect(existsSync(`${dbPath}-wal`), "no WAL left behind, so this was not a crash").toBe(true);

    // The panel's own read path over the crashed file.
    const opened = openDurableViewer({
      storePath: dbPath,
      memberId: "member-a",
      conversationId: "member-a:main",
      pollIntervalMs: 10,
    });
    expect(opened.ok, opened.ok ? "" : opened.error).toBe(true);
    if (!opened.ok) return;

    const iterator = opened.reader.conversation
      .watch({ pollIntervalMs: 10 })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.entriesWindow.map((entry) => entry.id)).toEqual(["c-1", "c-2", "c-3"]);
    // Nothing is live: a crashed member renders its committed window and no
    // live banner (`formatLiveBanner(null) === ""`).
    expect(first.value?.live).toBeNull();
    await iterator.return?.(undefined);
    expect(
      opened.reader
        .transcript()
        .window()
        .entries.map((entry) => entry.id),
    ).toEqual(["c-1", "c-2", "c-3"]);
    opened.reader.close();

    // The plugin's plain-JS reader serves the same crashed file to the panel.
    const { openDurableStoreReader } = await import(
      "../pi-web-plugins/durable-member/store-reader.js"
    );
    const reader = openDurableStoreReader({ path: dbPath });
    expect(reader.ok, reader.ok ? "" : reader.error).toBe(true);
    if (!reader.ok) return;
    expect(reader.store.readOnly).toBe(true);
    expect(
      reader.store.readEntryWindow("member-a:main", { limit: 10 }).entries.map((entry) => entry.id),
    ).toEqual(["c-1", "c-2", "c-3"]);
    expect(reader.store.readLiveGeneration("member-a:main")).toBeNull();
    reader.store.close();
  });

  // The case above crashes *before* committing a live row, so it never produces
  // the stale banner. Here the writer commits `status: "streaming"` and then
  // SIGKILLs itself: the row survives, and only the reader's liveness reduction
  // can tell that nothing is running any more.
  it("renders a live row committed by a writer that died as stale", async (context) => {
    if (sqliteProbe.status !== 0) {
      console.warn(
        `Skipping integration test: node:sqlite unavailable (${String(sqliteProbe.stderr).trim()})`,
      );
      context.skip();
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "belayd-durable-stale-live-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "store.sqlite");
    const readyPath = join(dir, "writer-ready");

    const schema = openDurableStore({ path: dbPath });
    if (!schema.ok) throw new Error(schema.error);
    schema.store.close();

    const crash = await runChild(crashWriterScript, [dbPath, readyPath, "--live"], 15_000);
    expect(crash.code, `crash writer exited cleanly\nstderr:\n${crash.stderr}`).toBeNull();
    expect(crash.signal).toBe("SIGKILL");
    await waitForFile(readyPath, 5_000);
    expect(existsSync(`${dbPath}-wal`), "no WAL left behind, so this was not a crash").toBe(true);

    // The committed row still claims to be streaming; that claim outlives its
    // owner, which is exactly the stale banner this case guards against.
    const probe = openDurableStore({ path: dbPath, readOnly: true });
    if (!probe.ok) throw new Error(probe.error);
    const rawLive = probe.store.readLiveGeneration("member-a:main");
    probe.store.close();
    expect(rawLive).toMatchObject({ generationId: "gen-crash", status: "streaming" });
    if (rawLive === null) throw new Error("crash writer committed no live row");

    // Owner known gone (the child was reaped), so the seam decides immediately.
    const byOwner = openDurableViewer({
      storePath: dbPath,
      memberId: "member-a",
      conversationId: "member-a:main",
      pollIntervalMs: 10,
      ownerAlive: () => false,
    });
    if (!byOwner.ok) throw new Error(byOwner.error);
    const ownerIterator = byOwner.reader.conversation
      .watch({ pollIntervalMs: 10 })
      [Symbol.asyncIterator]();
    const ownerFrame = await ownerIterator.next();
    expect(ownerFrame.value?.live).toMatchObject({
      generationId: "gen-crash",
      // Reported, not dropped: the partial text is the last known state.
      partialText: "about to die",
      stale: true,
      staleReason: "owner-gone",
    });
    await ownerIterator.return?.(undefined);
    byOwner.reader.close();

    // A reader that cannot probe the process still stales it once the heartbeat
    // bound passes; the clock is injected so the test never sleeps.
    const byAge = openDurableViewer({
      storePath: dbPath,
      memberId: "member-a",
      conversationId: "member-a:main",
      pollIntervalMs: 10,
      now: () => rawLive.updatedAt + DEFAULT_LIVE_STALE_AFTER_MS,
    });
    if (!byAge.ok) throw new Error(byAge.error);
    const ageIterator = byAge.reader.conversation
      .watch({ pollIntervalMs: 10 })
      [Symbol.asyncIterator]();
    const ageFrame = await ageIterator.next();
    expect(ageFrame.value?.live).toMatchObject({ stale: true, staleReason: "no-heartbeat" });
    await ageIterator.return?.(undefined);
    byAge.reader.close();
  });
});
