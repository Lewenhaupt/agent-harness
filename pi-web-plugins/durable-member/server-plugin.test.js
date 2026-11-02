import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertReadOnlyStore,
  createDurableMemberPeer,
  isSafeMemberId,
  listMembers,
  memberRoot,
  MEMBERS_DIR_ENV,
  PANEL_AUTHORITY,
  readMemberMeta,
  resolveLiveness,
} from "./server-plugin.js";
import { DEFAULT_LIVE_STALE_AFTER_MS } from "./contract.js";

/**
 * Server-module tests (bd-186).
 *
 * The server entry is a reader and a command forwarder only. These tests drive
 * it with a fixture data directory: a member's store, member metadata and
 * receipts, but no running member (so control forwarding fails honestly).
 */

const dirs = [];

const ENTRY_SCHEMA = `
  CREATE TABLE entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE live_generations (conversation_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE task_nodes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
`;

function seedMemberStore(memberDir, options = {}) {
  mkdirSync(memberDir, { recursive: true });
  const database = new DatabaseSync(join(memberDir, "store.sqlite"));
  database.exec(ENTRY_SCHEMA);
  const insert = database.prepare(
    `INSERT INTO entries (id, conversation_id, role, kind, timestamp, text, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("e1", "member-a:main", "user", "message", 10, "read the bead", "{}");
  insert.run("e2", "member-a:main", "assistant", "message", 20, "reading", "{}");
  database
    .prepare("INSERT INTO live_generations (conversation_id, payload) VALUES (?, ?)")
    .run(
      "member-a:main",
      JSON.stringify({
        conversationId: "member-a:main",
        generationId: "gen-1",
        status: "streaming",
        partialText: "working",
        startedAt: 1,
        // A live row is only "live" while its heartbeat is fresh, so the
        // fixture makes that explicit instead of relying on a magic timestamp.
        updatedAt: options.liveHeartbeatAt ?? Date.now(),
        attempt: 1,
        toolCalls: [],
      }),
    );
  const task = database.prepare("INSERT INTO task_nodes (id, payload) VALUES (?, ?)");
  task.run(
    "task-1",
    JSON.stringify({ id: "task-1", title: "scout", status: "done", waitingOn: [], background: false }),
  );
  task.run(
    "task-2",
    JSON.stringify({
      id: "task-2",
      title: "implement",
      status: "blocked",
      owner: { memberId: "member-a", edge: "child" },
      waitingOn: ["task-1"],
      background: true,
    }),
  );
  database.close();
}

function fixture(options = {}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "belayd-durable-plugin-"));
  dirs.push(dataDirectory);
  const memberDir = join(dataDirectory, "members", "member-a");
  seedMemberStore(memberDir, options);
  writeFileSync(
    join(memberDir, "member.json"),
    `${JSON.stringify({ conversationId: "member-a:main", label: "alpha" })}\n`,
  );
  mkdirSync(join(memberDir, "receipts"), { recursive: true });
  writeFileSync(
    join(memberDir, "receipts", "req-1.json"),
    `${JSON.stringify({ requestId: "req-1", memberId: "member-a", kind: "steer", appliedAt: 5, ok: true })}\n`,
  );
  return { dataDirectory, memberDir };
}

function peer(dataDirectory) {
  return createDurableMemberPeer({
    dataDirectory,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

/** A resolved liveness seam pinned to one clock value, for bound-crossing tests. */
function livenessAt(now) {
  return resolveLiveness(undefined, { clock: () => now });
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server plugin: member discovery", () => {
  it("lists a member with its label, live flag, task count and receipts", () => {
    const { dataDirectory } = fixture();
    const members = listMembers(dataDirectory);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      memberId: "member-a",
      conversationId: "member-a:main",
      label: "alpha",
      readable: true,
      live: true,
      lastEntryAt: 20,
      taskCount: 2,
      receipts: 1,
      controlSocket: false,
    });
  });

  it("does not count a live row whose heartbeat went stale as live", () => {
    // A crash leaves the row behind with `status: "streaming"`; only the
    // heartbeat separates that from a running member.
    const { dataDirectory } = fixture({
      liveHeartbeatAt: Date.now() - DEFAULT_LIVE_STALE_AFTER_MS - 1_000,
    });
    expect(listMembers(dataDirectory)[0]).toMatchObject({
      memberId: "member-a",
      readable: true,
      live: false,
    });
  });

  it("returns an empty list for a data directory with no members", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "belayd-durable-empty-"));
    dirs.push(dataDirectory);
    expect(listMembers(dataDirectory)).toEqual([]);
  });

  it("defaults a member conversation when member.json is absent", () => {
    const { dataDirectory } = fixture();
    const otherDir = join(dataDirectory, "members", "member-b");
    seedMemberStore(otherDir);
    expect(readMemberMeta(otherDir)).toEqual({ conversationId: "main" });
  });

  it("honours the member-root override", () => {
    const { dataDirectory } = fixture();
    const previous = process.env[MEMBERS_DIR_ENV];
    process.env[MEMBERS_DIR_ENV] = join(dataDirectory, "members");
    try {
      expect(memberRoot("/somewhere/else")).toBe(join(dataDirectory, "members"));
      expect(listMembers("/somewhere/else")).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env[MEMBERS_DIR_ENV];
      else process.env[MEMBERS_DIR_ENV] = previous;
    }
  });

  it("rejects unsafe member ids before touching the filesystem", () => {
    expect(isSafeMemberId("member-a")).toBe(true);
    expect(isSafeMemberId("../escape")).toBe(false);
    expect(isSafeMemberId("a/b")).toBe(false);
    expect(isSafeMemberId("")).toBe(false);
  });
});

describe("server plugin: liveness seam", () => {
  it("counts a member live while the injected clock is inside the bound", () => {
    const { dataDirectory } = fixture({ liveHeartbeatAt: 1_000 });
    const justInside = livenessAt(1_000 + DEFAULT_LIVE_STALE_AFTER_MS - 1);
    expect(listMembers(dataDirectory, justInside)[0]).toMatchObject({
      memberId: "member-a",
      live: true,
    });
  });

  it("stops counting a member live on the tick that reaches the bound", () => {
    const { dataDirectory } = fixture({ liveHeartbeatAt: 1_000 });
    const atBound = livenessAt(1_000 + DEFAULT_LIVE_STALE_AFTER_MS);
    expect(listMembers(dataDirectory, atBound)[0]).toMatchObject({
      memberId: "member-a",
      live: false,
    });
  });

  it("honours a staleAfterMs from activation settings", () => {
    const { dataDirectory } = fixture({ liveHeartbeatAt: 1_000 });
    // Fresh against the 30 s default, stale against a 100 ms configured bound.
    const seam = resolveLiveness(undefined, { clock: () => 1_101, staleAfterMs: 100 });
    expect(listMembers(dataDirectory, seam)[0]).toMatchObject({ live: false });
    expect(resolveLiveness({ staleAfterMs: 100 }).staleAfterMs).toBe(100);
    expect(resolveLiveness({ staleAfterMs: "soon" }).staleAfterMs).toBe(
      DEFAULT_LIVE_STALE_AFTER_MS,
    );
    // An override wins over settings, so a test can widen the bound too.
    expect(resolveLiveness({ staleAfterMs: 100 }, { staleAfterMs: 5_000 }).staleAfterMs).toBe(
      5_000,
    );
  });

  it("flips a streamed frame from live to no-heartbeat on the crossing tick", async () => {
    const { dataDirectory } = fixture({ liveHeartbeatAt: 1_000 });
    let now = 1_000;
    const watcher = createDurableMemberPeer({
      dataDirectory,
      settings: {},
      liveness: { clock: () => now },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    vi.useFakeTimers();
    const controller = new AbortController();
    const frames = [];
    try {
      const channel = await watcher.openChannel({
        operation: "watch",
        input: { memberId: "member-a", intervalMs: 25 },
        signal: controller.signal,
        send: (frame) => frames.push(frame),
      });

      expect(frames).toHaveLength(1);
      expect(frames[0].frame.live).toMatchObject({ generationId: "gen-1" });
      expect(frames[0].frame.live).not.toHaveProperty("stale");

      // Still inside the bound: the row is unchanged, so no frame is published.
      now = 1_000 + DEFAULT_LIVE_STALE_AFTER_MS - 1;
      await vi.advanceTimersByTimeAsync(25);
      expect(frames).toHaveLength(1);

      // The crossing tick changes the reduction, which is part of the frame
      // signature, so the flip is published even with no new committed entry.
      now = 1_000 + DEFAULT_LIVE_STALE_AFTER_MS;
      await vi.advanceTimersByTimeAsync(25);
      expect(frames).toHaveLength(2);
      expect(frames[1].frame.live).toMatchObject({
        generationId: "gen-1",
        status: "streaming",
        stale: true,
        staleReason: "no-heartbeat",
      });
      channel.close();
    } finally {
      controller.abort();
    }
  });
});

describe("server plugin: read-only invariant", () => {
  it("accepts the reader and rejects anything writable", () => {
    expect(() => assertReadOnlyStore({ readOnly: true })).not.toThrow();
    expect(() => assertReadOnlyStore({ readOnly: false })).toThrow(/writable/);
    expect(() =>
      assertReadOnlyStore({ readOnly: true, appendEntry() {} }),
    ).toThrow(/appendEntry/);
  });
});

describe("server plugin: peer requests", () => {
  it("serves the member list", async () => {
    const { dataDirectory } = fixture();
    await expect(peer(dataDirectory).request({ operation: "members", input: null })).resolves.toMatchObject({
      members: [expect.objectContaining({ memberId: "member-a" })],
    });
  });

  it("serves an earlier transcript page", async () => {
    const { dataDirectory } = fixture();
    const latest = await peer(dataDirectory).request({
      operation: "load-earlier",
      input: { memberId: "member-a", cursor: "2" },
    });
    expect(latest.entries.map((entry) => entry.id)).toEqual(["e1"]);
  });

  it("serves entry details", async () => {
    const { dataDirectory } = fixture();
    const details = await peer(dataDirectory).request({
      operation: "entry-details",
      input: { memberId: "member-a", entryId: "e1" },
    });
    expect(details).toMatchObject({ entryId: "e1", entry: { text: "read the bead" } });
  });

  it("fails a control forward when the member is not running", async () => {
    const { dataDirectory } = fixture();
    const result = await peer(dataDirectory).request({
      operation: "control",
      input: {
        command: {
          kind: "steer",
          requestId: "req-steer-9",
          memberId: "member-a",
          authority: "panel-human",
          issuedAt: 1000,
          text: "hello",
        },
      },
    });
    expect(result).toMatchObject({ ok: false, code: "socket-unavailable" });
  });

  it("refuses an invalid command before connecting to a member", async () => {
    const { dataDirectory } = fixture();
    const result = await peer(dataDirectory).request({
      operation: "control",
      input: {
        command: {
          kind: "steer",
          requestId: "req-1",
          memberId: "member-a",
          authority: "panel-human",
          issuedAt: 1000,
          text: "",
        },
      },
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-command" });
  });

  it("forwards only the panel tier and refuses a supervisor-claimed command", async () => {
    const { dataDirectory } = fixture();
    const result = await peer(dataDirectory).request({
      operation: "control",
      input: {
        command: {
          kind: "followup",
          requestId: "req-followup-9",
          memberId: "member-a",
          authority: "fleet-supervisor",
          issuedAt: 1000,
          text: "start the next run",
        },
      },
    });
    expect(PANEL_AUTHORITY).toBe("panel-human");
    expect(result).toMatchObject({ ok: false, code: "authority-mismatch" });
  });

  it("ignores a browser-supplied port instead of redirecting the member token", async () => {
    const { dataDirectory } = fixture();
    const connections = [];
    const trap = createServer((socket) => {
      connections.push("connected");
      socket.destroy();
    });
    await new Promise((resolve) => trap.listen(0, "127.0.0.1", resolve));
    const address = trap.address();
    try {
      const result = await peer(dataDirectory).request({
        operation: "control",
        input: {
          port: address.port,
          command: {
            kind: "steer",
            requestId: "req-steer-port",
            memberId: "member-a",
            authority: "panel-human",
            issuedAt: 1000,
            text: "hello",
          },
        },
      });
      // The member has no control.port and no control.sock: the client used the
      // unix transport, never the caller-supplied TCP port.
      expect(result).toMatchObject({ ok: false, code: "socket-unavailable" });
      expect(connections).toEqual([]);
    } finally {
      await new Promise((resolve) => trap.close(resolve));
    }
  });

  it("presents only the panel credential, resolved through control.port", async () => {
    const { dataDirectory, memberDir } = fixture();
    const presented = [];
    const trap = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        while (true) {
          const index = buffer.indexOf("\n");
          if (index === -1) break;
          const frame = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (frame.type === "auth") presented.push(frame.token);
          if (frame.type === "command") {
            socket.write(
              `${JSON.stringify({
                type: "auth-ack",
                ok: true,
              })}\n`,
            );
            socket.write(
              `${JSON.stringify({
                type: "command-result",
                ok: true,
                requestId: frame.command.requestId,
                duplicate: false,
              })}\n`,
            );
          }
        }
      });
    });
    await new Promise((resolve) => trap.listen(0, "127.0.0.1", resolve));
    const address = trap.address();
    try {
      writeFileSync(join(memberDir, "control.panel.token"), "panel-secret\n", { mode: 0o600 });
      writeFileSync(join(memberDir, "control.supervisor.token"), "supervisor-secret\n", {
        mode: 0o600,
      });
      writeFileSync(join(memberDir, "control.port"), `${String(address.port)}\n`, {
        mode: 0o600,
      });
      const result = await peer(dataDirectory).request({
        operation: "control",
        input: {
          command: {
            kind: "abort",
            requestId: "req-abort-port",
            memberId: "member-a",
            authority: "panel-human",
            issuedAt: 1000,
          },
        },
      });
      expect(result).toEqual({ ok: true, requestId: "req-abort-port", duplicate: false });
      // The panel module never presents the supervisor credential, even though
      // the file exists in the member dir.
      expect(presented).toEqual(["panel-secret"]);
    } finally {
      await new Promise((resolve) => trap.close(resolve));
    }
  });

  it("refuses to send when no panel credential exists, even if a supervisor one does", async () => {
    const { dataDirectory, memberDir } = fixture();
    writeFileSync(join(memberDir, "control.supervisor.token"), "supervisor-secret\n", {
      mode: 0o600,
    });
    const result = await peer(dataDirectory).request({
      operation: "control",
      input: {
        command: {
          kind: "steer",
          requestId: "req-steer-no-panel-token",
          memberId: "member-a",
          authority: "panel-human",
          issuedAt: 1000,
          text: "hello",
        },
      },
    });
    expect(result).toMatchObject({ ok: false, code: "socket-unavailable" });
    expect(JSON.stringify(result)).toContain("control.panel.token");
  });

  it("rejects a traversal memberId and an unknown operation", async () => {
    const { dataDirectory } = fixture();
    await expect(
      peer(dataDirectory).request({
        operation: "load-earlier",
        input: { memberId: "../escape", cursor: "1" },
      }),
    ).rejects.toThrow(/invalid memberId/);
    await expect(
      peer(dataDirectory).request({ operation: "delete-everything", input: null }),
    ).rejects.toThrow(/unknown durable-member operation/);
  });
});

describe("server plugin: watch channel", () => {
  it("marks a stale live row in the streamed frame instead of calling it live", async () => {
    const { dataDirectory } = fixture({
      liveHeartbeatAt: Date.now() - DEFAULT_LIVE_STALE_AFTER_MS - 1_000,
    });
    const controller = new AbortController();
    const frames = [];
    const channel = await peer(dataDirectory).openChannel({
      operation: "watch",
      input: { memberId: "member-a", intervalMs: 25 },
      signal: controller.signal,
      send: (frame) => frames.push(frame),
    });

    expect(frames[0].frame.live).toMatchObject({
      generationId: "gen-1",
      partialText: "working",
      stale: true,
      staleReason: "no-heartbeat",
    });

    channel.close();
    controller.abort();
  });

  it("streams a conversation frame with the task graph and then stops on abort", async () => {
    const { dataDirectory } = fixture();
    const controller = new AbortController();
    const frames = [];
    const channel = await peer(dataDirectory).openChannel({
      operation: "watch",
      input: { memberId: "member-a", intervalMs: 25 },
      signal: controller.signal,
      send: (frame) => frames.push(frame),
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "frame",
      frame: {
        conversationId: "member-a:main",
        hasEarlier: false,
        live: { generationId: "gen-1", partialText: "working" },
      },
      tasks: [
        expect.objectContaining({ id: "task-1" }),
        expect.objectContaining({ id: "task-2", background: true }),
      ],
    });
    expect(frames[0].frame.entriesWindow.map((entry) => entry.id)).toEqual(["e1", "e2"]);
    // The channel publishes the wire frame the panel reduces; a pre-reduced
    // view here would double-reduce in the browser (`wire-seam.test.js`).
    expect(frames[0].frame).not.toHaveProperty("entries");
    expect(frames[0].frame).toMatchObject({
      cursor: "1",
      hasEarlier: false,
      emittedAt: expect.any(Number),
    });

    channel.close();
    controller.abort();
    // Closing twice (channel.close() then the abort listener) must be harmless.
    channel.close();
  });

  it("rejects an unknown channel and a traversal memberId", async () => {
    const { dataDirectory } = fixture();
    const controller = new AbortController();
    await expect(
      peer(dataDirectory).openChannel({
        operation: "drive",
        input: { memberId: "member-a" },
        signal: controller.signal,
        send: () => {},
      }),
    ).rejects.toThrow(/unknown durable-member channel/);
    await expect(
      peer(dataDirectory).openChannel({
        operation: "watch",
        input: { memberId: "../escape" },
        signal: controller.signal,
        send: () => {},
      }),
    ).rejects.toThrow(/invalid memberId/);
  });
});
