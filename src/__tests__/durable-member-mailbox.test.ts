import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableAuthority } from "../durable-member/commands.js";
import { createDedupeLedger, type DedupeLedger } from "../durable-member/dedupe.js";
import {
  createDurableDispatcher,
  type DurableSubmitInput,
  type DurableWriter,
} from "../durable-member/dispatch.js";
import {
  drainDurableCommands,
  enqueueDurableCommand,
  memberCommandsDir,
  memberReceiptsDir,
  memberRejectedDir,
  readCommandReceipts,
} from "../durable-member/mailbox.js";
import { makeCommand, makeStateDir, removeStateDir, TEST_MEMBER_ID } from "./durable-fixtures.js";

const stateDirs: string[] = [];

function stateDir(): string {
  const dir = makeStateDir();
  stateDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of stateDirs.splice(0)) removeStateDir(dir);
});

/** Minimal writer that records submits; the mailbox only needs the seam. */
function mailboxWriter(): { writer: DurableWriter; submitted: DurableSubmitInput[] } {
  const submitted: DurableSubmitInput[] = [];
  const writer: DurableWriter = {
    submit(input) {
      submitted.push(input);
      return { ok: true, submissionId: `sub-${submitted.length}` };
    },
    submission() {
      return null;
    },
    abort() {},
    configure() {},
    compact() {},
    reset() {},
  };
  return { writer, submitted };
}

function dispatcherFor(
  dir: string,
  writer: DurableWriter,
  authority: DurableAuthority = "panel-human",
) {
  const opened = createDedupeLedger({ stateDir: dir });
  if (!opened.ok) throw new Error(opened.error);
  return createDurableDispatcher({
    memberId: TEST_MEMBER_ID,
    authority,
    writer,
    ledger: opened.ledger,
  });
}

describe("durable command mailbox", () => {
  it("delivers a command queued while the member was down on the next start", async () => {
    const dir = stateDir();
    const queued = enqueueDurableCommand({ stateDir: dir, command: makeCommand("steer") });
    expect(queued.ok).toBe(true);
    if (queued.ok) {
      expect(queued.path).toBe(join(memberCommandsDir(dir), "req-steer-1.json"));
      // The mailbox is a file transport for a member that is not running yet.
      expect(statSync(queued.path).mode & 0o777).toBe(0o600);
    }

    const { writer, submitted } = mailboxWriter();
    const drained = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher: dispatcherFor(dir, writer),
    });

    expect(drained).toMatchObject({ ok: true, result: { applied: 1, duplicates: 0, rejected: 0 } });
    expect(submitted).toEqual([{ type: "message", text: "steer the member", whenBusy: "steer" }]);
    expect(readdirSync(memberCommandsDir(dir))).toEqual([]);

    const receipts = readCommandReceipts(dir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      requestId: "req-steer-1",
      memberId: TEST_MEMBER_ID,
      kind: "steer",
      ok: true,
      duplicate: false,
    });

    // A second drain (a restart, or a turn-start poll) applies nothing.
    const again = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher: dispatcherFor(dir, writer),
    });
    expect(again).toMatchObject({ ok: true, result: { applied: 0 } });
    expect(submitted).toHaveLength(1);
  });

  it("drains queued commands in issuedAt order, not filename order", async () => {
    const dir = stateDir();
    const later = makeCommand("followup", { requestId: "aaa-later", issuedAt: 2_000 });
    const earlier = makeCommand("steer", { requestId: "zzz-earlier", issuedAt: 1_000 });
    enqueueDurableCommand({ stateDir: dir, command: later });
    enqueueDurableCommand({ stateDir: dir, command: earlier });

    const { writer, submitted } = mailboxWriter();
    const drained = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher: dispatcherFor(dir, writer),
    });

    expect(drained.ok).toBe(true);
    expect(
      submitted.map((input) => (input.type === "message" ? input.whenBusy : input.type)),
    ).toEqual(["steer", "followup"]);
  });

  it("does not re-apply a command already delivered through the socket path", async () => {
    const dir = stateDir();
    const command = makeCommand("steer");
    const { writer, submitted } = mailboxWriter();
    const dispatcher = dispatcherFor(dir, writer);

    await dispatcher.dispatch(command);
    enqueueDurableCommand({ stateDir: dir, command });

    const drained = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher,
    });

    expect(drained).toMatchObject({ ok: true, result: { applied: 0, duplicates: 1 } });
    expect(submitted).toHaveLength(1);
    expect(readCommandReceipts(dir)).toEqual([
      expect.objectContaining({ requestId: "req-steer-1", duplicate: true }),
    ]);
  });

  it("rejects a queued file for another member and removes it", async () => {
    const dir = stateDir();
    enqueueDurableCommand({
      stateDir: dir,
      command: makeCommand("steer", { memberId: "member-b" }),
    });

    const { writer, submitted } = mailboxWriter();
    const drained = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher: dispatcherFor(dir, writer),
    });

    expect(drained).toMatchObject({ ok: true, result: { applied: 0, rejected: 1 } });
    expect(submitted).toHaveLength(0);
    expect(readdirSync(memberCommandsDir(dir))).toEqual([]);
    expect(readCommandReceipts(dir)).toEqual([
      expect.objectContaining({ requestId: "req-steer-1", ok: false }),
    ]);
  });

  it("rejects a malformed queued file instead of poisoning every later start", async () => {
    const dir = stateDir();
    mkdirSync(memberCommandsDir(dir), { recursive: true });
    const path = join(memberCommandsDir(dir), "req-broken.json");
    writeFileSync(path, "{ this is not json", { mode: 0o600 });

    const { writer, submitted } = mailboxWriter();
    const drained = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher: dispatcherFor(dir, writer),
    });

    expect(drained).toMatchObject({ ok: true, result: { applied: 0, rejected: 1 } });
    expect(submitted).toHaveLength(0);
    expect(readdirSync(memberCommandsDir(dir))).toEqual([]);
    expect(readFileSync(join(memberReceiptsDir(dir), "req-broken.json"), "utf8")).toContain(
      "not valid JSON",
    );
  });

  it("is a no-op when the mailbox directory does not exist", async () => {
    const dir = stateDir();
    const { writer } = mailboxWriter();
    const drained = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher: dispatcherFor(dir, writer),
    });
    expect(drained).toMatchObject({ ok: true, result: { applied: 0 } });
    expect(readCommandReceipts(dir)).toEqual([]);
  });

  it("refuses to enqueue an invalid command", () => {
    const dir = stateDir();
    const invalid = {
      kind: "steer",
      requestId: "../escape",
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      issuedAt: 1_000,
      text: "x",
    } as unknown as Parameters<typeof enqueueDurableCommand>[0]["command"];
    const queued = enqueueDurableCommand({ stateDir: dir, command: invalid });
    expect(queued).toMatchObject({ ok: false });
  });
});

describe("durable command mailbox tier and retry semantics", () => {
  it("refuses a queued command that claims another tier and quarantines it", async () => {
    const dir = stateDir();
    enqueueDurableCommand({
      stateDir: dir,
      command: makeCommand("steer", { authority: "panel-human" }),
    });
    const { writer, submitted } = mailboxWriter();

    const drained = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      // The queue origin is the owner's configuration, not the JSON body.
      authority: "fleet-supervisor",
      dispatcher: dispatcherFor(dir, writer, "fleet-supervisor"),
    });

    expect(drained).toMatchObject({
      ok: true,
      result: { applied: 0, rejected: 1, quarantined: 1 },
    });
    expect(submitted).toHaveLength(0);
    expect(readdirSync(memberCommandsDir(dir))).toEqual([]);
    expect(readdirSync(memberRejectedDir(dir))).toEqual(["req-steer-1.json"]);
    expect(readCommandReceipts(dir)).toEqual([
      expect.objectContaining({ ok: false, code: "authority-mismatch" }),
    ]);
  });

  it("retains a command whose apply failed so the next drain retries it", async () => {
    const dir = stateDir();
    enqueueDurableCommand({ stateDir: dir, command: makeCommand("steer") });

    const failing: DurableWriter = {
      ...mailboxWriter().writer,
      submit() {
        return { ok: false, error: "busy" };
      },
    };
    const first = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher: dispatcherFor(dir, failing),
    });

    expect(first).toMatchObject({ ok: true, result: { applied: 0, retained: 1 } });
    expect(readdirSync(memberCommandsDir(dir))).toEqual(["req-steer-1.json"]);
    expect(readCommandReceipts(dir)).toEqual([
      expect.objectContaining({ ok: false, code: "writer-failed" }),
    ]);

    const { writer, submitted } = mailboxWriter();
    const retried = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher: dispatcherFor(dir, writer),
    });
    expect(retried).toMatchObject({ ok: true, result: { applied: 1, retained: 0 } });
    expect(submitted).toHaveLength(1);
    expect(readdirSync(memberCommandsDir(dir))).toEqual([]);
  });

  it("quarantines an applied-but-unrecorded command instead of redelivering it", async () => {
    const dir = stateDir();
    enqueueDurableCommand({ stateDir: dir, command: makeCommand("steer") });
    const { writer, submitted } = mailboxWriter();
    const brokenLedger: DedupeLedger = {
      has: () => false,
      record: () => ({ ok: false, error: "disk full" }),
      size: () => 0,
      entries: () => [],
      tombstones: () => [],
    };

    const drained = await drainDurableCommands({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      dispatcher: createDurableDispatcher({
        memberId: TEST_MEMBER_ID,
        authority: "panel-human",
        writer,
        ledger: brokenLedger,
      }),
    });

    expect(submitted).toHaveLength(1);
    expect(drained).toMatchObject({
      ok: true,
      result: { applied: 0, retained: 0, quarantined: 1 },
    });
    expect(readdirSync(memberCommandsDir(dir))).toEqual([]);
    expect(readdirSync(memberRejectedDir(dir))).toEqual(["req-steer-1.json"]);
    expect(readCommandReceipts(dir)).toEqual([
      expect.objectContaining({ ok: false, code: "applied-unrecorded" }),
    ]);
  });
});

describe("durable command mailbox receipts", () => {
  it("reads an unknown receipt kind as unknown instead of casting it", () => {
    const dir = stateDir();
    mkdirSync(memberReceiptsDir(dir), { recursive: true });
    writeFileSync(
      join(memberReceiptsDir(dir), "req-x.json"),
      JSON.stringify({
        requestId: "req-x",
        memberId: TEST_MEMBER_ID,
        kind: "teleport",
        appliedAt: 1,
        ok: true,
      }),
    );

    expect(readCommandReceipts(dir)).toEqual([expect.objectContaining({ kind: "unknown" })]);
  });
});
