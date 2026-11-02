// SYNC WARNING: this server entry mirrors the durable-member read contract in
// `src/durable-member/{contract.ts,commands.ts,mailbox.ts}`:
//
//   - `members` describes `<membersDir>/<memberId>/{store.sqlite,member.json}`;
//   - `load-earlier` and `entry-details` return the same window/details shapes
//     as `DurableTranscript`;
//   - `control` forwards an unmodified command object to the member's control
//     socket (protocol mirrored in `control-client.js`, itself mirrored from
//     `src/durable-member/socket.ts`);
//   - receipts are the `<memberId>/receipts/<requestId>.json` files written by
//     `src/durable-member/mailbox.ts`;
//   - `control` forwards only `panel-human` commands and presents only
//     `control.panel.token` (this module's tier). The owner derives the tier
//     from that credential and refuses any frame whose claim disagrees.
//
// This module is a **reader and a command forwarder only**. It never opens a
// member's storage writable: `store-reader.js` has no write path, and
// `assertReadOnlyStore` below fails closed if that ever changes. Every steering
// decision belongs to the member's owner, which re-checks authority and dedupes
// by requestId. The member's own `control.port` file selects the transport; a
// browser request cannot redirect the member's token at another loopback port.
//
// Frame direction: the `watch` channel publishes the **wire frame**
// (`ConversationWatchFrame`: `entriesWindow` + `cursor` + `hasEarlier` + `live`)
// plus the task graph on the envelope. It does NOT publish a reduced view — the
// panel owns the single `reduceConversationFrames` pass.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DURABLE_STORE_FILE, openDurableStoreReader } from "./store-reader.js";
import { sendControlCommand } from "./control-client.js";
import {
  annotateLiveGeneration,
  reduceLiveLiveness,
  validateCommand,
  DEFAULT_LIVE_STALE_AFTER_MS,
} from "./contract.js";

/** Environment override for the member root (tests, seeded screenshot fixture). */
export const MEMBERS_DIR_ENV = "BELAYD_DURABLE_MEMBERS_DIR";

/** The tier this server module serves; every forwarded command must claim it. */
export const PANEL_AUTHORITY = "panel-human";

/** Default conversation id for a member that does not declare one. */
export const DEFAULT_CONVERSATION_ID = "main";

/** Watch cadence; pi-durable streams partial text at roughly this rate. */
export const WATCH_INTERVAL_MS = 100;

/** Default frame window, matching the panel's merged view cap. */
export const WATCH_WINDOW_SIZE = 200;

const MEMBER_META_FILE = "member.json";
const RECEIPTS_DIR = "receipts";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_MEMBER_ID_LENGTH = 200;

/** Store methods that must not exist on a reader (write paths). */
const FORBIDDEN_STORE_MEMBERS = ["appendEntry", "setLiveGeneration", "upsertTask", "resume"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the liveness seam once, from the activation's settings and its
 * process-local overrides.
 *
 * `staleAfterMs` may come from settings (JSON) or from an override; the clock
 * and the owner probe are functions, so tests inject them through `overrides`.
 * The defaults are the TypeScript viewer's: a 30 s heartbeat bound and "unknown
 * owner, treat as alive". Both call sites (the sidebar summary and the watch
 * channel) go through this seam, so a test can advance a fake clock across the
 * bound instead of crafting an already-stale row.
 *
 * @param {object} [settings] activation settings (`{ staleAfterMs?: number }`)
 * @param {{ clock?: () => number, ownerAlive?: (memberId: string) => boolean, staleAfterMs?: number }} [overrides]
 */
export function resolveLiveness(settings, overrides) {
  const source = overrides ?? {};
  const staleAfterMs =
    positiveMillis(source.staleAfterMs) ??
    positiveMillis(isRecord(settings) ? settings.staleAfterMs : undefined) ??
    DEFAULT_LIVE_STALE_AFTER_MS;
  return {
    clock: typeof source.clock === "function" ? source.clock : () => Date.now(),
    ownerAlive: typeof source.ownerAlive === "function" ? source.ownerAlive : () => true,
    staleAfterMs,
  };
}

function positiveMillis(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The frame's `live` field: the row reduced against the heartbeat bound and the
 * owner probe, then annotated so a stale generation is flagged, never dropped.
 */
function annotatedLive(store, conversationId, memberId, liveness) {
  return annotateLiveGeneration(
    reduceLiveLiveness({
      live: store.readLiveGeneration(conversationId),
      now: liveness.clock(),
      ownerAlive: liveness.ownerAlive(memberId),
      staleAfterMs: liveness.staleAfterMs,
    }),
  );
}

/** Member ids are directory names; reject separators before touching the filesystem. */
export function isSafeMemberId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_MEMBER_ID_LENGTH &&
    SAFE_IDENTIFIER.test(value)
  );
}

/**
 * Fail closed unless this is the read-only reader.
 *
 * The SQLite connection is already opened `readOnly: true`; this check exists
 * because the panel must never be the component that could write, and a future
 * edit to `store-reader.js` should break here rather than silently gain a write
 * path the security review did not see.
 */
export function assertReadOnlyStore(store) {
  if (store.readOnly !== true) {
    throw new Error("durable-member server plugin refuses a writable store");
  }
  for (const member of FORBIDDEN_STORE_MEMBERS) {
    if (typeof store[member] === "function") {
      throw new Error(`durable-member server plugin reader exposes ${member}()`);
    }
  }
}

/** Member root: the host's plugin data directory unless explicitly overridden. */
export function memberRoot(dataDirectory) {
  const override = process.env[MEMBERS_DIR_ENV];
  if (typeof override === "string" && override !== "") return override;
  return join(dataDirectory, "members");
}

/** Read `<memberDir>/member.json`; a missing file means the documented defaults. */
export function readMemberMeta(memberDir) {
  const path = join(memberDir, MEMBER_META_FILE);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw)) return { conversationId: DEFAULT_CONVERSATION_ID };
    const conversationId =
      typeof raw.conversationId === "string" && raw.conversationId !== ""
        ? raw.conversationId
        : DEFAULT_CONVERSATION_ID;
    return {
      conversationId,
      ...(typeof raw.label === "string" && raw.label !== "" ? { label: raw.label } : {}),
    };
  } catch {
    return { conversationId: DEFAULT_CONVERSATION_ID };
  }
}

function openMemberStore(memberDir) {
  const opened = openDurableStoreReader({ path: join(memberDir, DURABLE_STORE_FILE) });
  if (!opened.ok) throw new Error(opened.error);
  assertReadOnlyStore(opened.store);
  return opened.store;
}

/** Read the receipts the owner wrote for queued (file transport) commands. */
export function readReceipts(memberDir) {
  const dir = join(memberDir, RECEIPTS_DIR);
  let files;
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const receipts = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (isRecord(raw) && typeof raw.requestId === "string") receipts.push(raw);
    } catch {
      // A malformed receipt is history the panel can skip; it is not control
      // input and must not fail the whole listing.
    }
  }
  return receipts;
}

/** Describe one member for the sidebar. Storage errors are reported, not hidden. */
export function describeMember(memberId, memberDir, liveness) {
  const seam = liveness ?? resolveLiveness();
  const meta = readMemberMeta(memberDir);
  const base = {
    memberId,
    conversationId: meta.conversationId,
    ...(meta.label === undefined ? {} : { label: meta.label }),
    controlSocket: existsSync(join(memberDir, "control.sock")),
  };
  let store;
  try {
    store = openMemberStore(memberDir);
  } catch (error) {
    return {
      ...base,
      readable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const window = store.readEntryWindow(meta.conversationId, { limit: 1 });
    const latest = window.entries[0];
    // A crashed owner leaves its live row behind with `status: "streaming"`, so
    // the sidebar counts a generation as live only when it is not stale.
    const live = annotatedLive(store, meta.conversationId, memberId, seam);
    const tasks = store.readTaskGraph();
    return {
      ...base,
      readable: true,
      live: live !== null && live.stale !== true,
      lastEntryAt: latest === undefined ? null : latest.timestamp,
      taskCount: tasks.length,
      receipts: readReceipts(memberDir).length,
    };
  } finally {
    store.close();
  }
}

/**
 * List every member with a store under the member root.
 *
 * An empty root is the normal empty state ("no durable members"), not an error:
 * the panel must be screenshot-able with no live member.
 */
export function listMembers(dataDirectory, liveness) {
  const root = memberRoot(dataDirectory);
  const seam = liveness ?? resolveLiveness();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const members = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const memberId = entry.name;
    if (!isSafeMemberId(memberId)) continue;
    const memberDir = join(root, memberId);
    if (!existsSync(join(memberDir, DURABLE_STORE_FILE))) continue;
    members.push(describeMember(memberId, memberDir, seam));
  }
  return members.sort((left, right) => (left.memberId < right.memberId ? -1 : 1));
}

function memberDirFor(dataDirectory, memberId) {
  if (!isSafeMemberId(memberId)) {
    throw new Error(`invalid memberId: ${String(memberId)}`);
  }
  return join(memberRoot(dataDirectory), memberId);
}

function readMemberConversation(dataDirectory, memberId, requested) {
  const memberDir = memberDirFor(dataDirectory, memberId);
  const meta = readMemberMeta(memberDir);
  return {
    memberDir,
    conversationId: typeof requested === "string" && requested !== "" ? requested : meta.conversationId,
  };
}

function readLoadEarlier(dataDirectory, input) {
  if (!isRecord(input)) throw new Error("load-earlier input must be an object");
  const { memberId, cursor } = input;
  const { memberDir, conversationId } = readMemberConversation(
    dataDirectory,
    memberId,
    input.conversationId,
  );
  if (typeof cursor !== "string" || cursor === "") throw new Error("load-earlier needs a cursor");
  const store = openMemberStore(memberDir);
  try {
    return store.readEntryWindow(conversationId, { before: cursor, limit: WATCH_WINDOW_SIZE });
  } finally {
    store.close();
  }
}

function readEntryDetails(dataDirectory, input) {
  if (!isRecord(input)) throw new Error("entry-details input must be an object");
  const { memberId, entryId } = input;
  const { memberDir } = readMemberConversation(dataDirectory, memberId, input.conversationId);
  if (typeof entryId !== "string" || entryId === "") throw new Error("entry-details needs entryId");
  const store = openMemberStore(memberDir);
  try {
    return store.readEntryDetails(entryId);
  } finally {
    store.close();
  }
}

/**
 * Forward one panel command to the owning member.
 *
 * The transport comes from the member's published state, never from `input`:
 * `input.port` is deliberately ignored so a browser request cannot point the
 * member's token at an arbitrary loopback service. The claim must equal this
 * module's tier; the owner re-checks it against its own bound tier.
 */
async function forwardControl(dataDirectory, input) {
  if (!isRecord(input)) throw new Error("control input must be an object");
  const command = input.command;
  if (!isRecord(command) || typeof command.memberId !== "string") {
    throw new Error("control needs a command with a memberId");
  }
  const validated = validateCommand(command, { memberId: command.memberId });
  if (!validated.ok) {
    return { ok: false, code: "invalid-command", error: validated.error };
  }
  if (validated.value.authority !== PANEL_AUTHORITY) {
    return {
      ok: false,
      code: "authority-mismatch",
      error: `the panel forwards only ${PANEL_AUTHORITY} commands, got ${String(
        validated.value.authority,
      )}`,
    };
  }
  const memberDir = memberDirFor(dataDirectory, command.memberId);
  return sendControlCommand({
    memberDir,
    authority: PANEL_AUTHORITY,
    command: validated.value,
  });
}

/**
 * Build the plugin peer handlers.
 *
 * Separated from `activate()` so tests can drive the operations with a fixture
 * data directory and no host runtime.
 */
export function createDurableMemberPeer(context) {
  const dataDirectory = context.dataDirectory;
  // One seam per activation: a watch channel and the sidebar agree on what
  // "live" means, and tests advance the same clock across both.
  const liveness = resolveLiveness(context.settings, context.liveness);

  return {
    async request({ operation, input }) {
      switch (operation) {
        case "members":
          return { members: listMembers(dataDirectory, liveness) };
        case "load-earlier":
          return readLoadEarlier(dataDirectory, input);
        case "entry-details":
          return readEntryDetails(dataDirectory, input);
        case "control":
          return forwardControl(dataDirectory, input);
        default:
          throw new Error(`unknown durable-member operation: ${String(operation)}`);
      }
    },
    async openChannel({ operation, input, signal, send }) {
      if (operation !== "watch") {
        throw new Error(`unknown durable-member channel: ${String(operation)}`);
      }
      if (!isRecord(input)) throw new Error("watch input must be an object");
      const { memberDir, conversationId } = readMemberConversation(
        dataDirectory,
        input.memberId,
        input.conversationId,
      );
      const store = openMemberStore(memberDir);
      const intervalMs =
        typeof input.intervalMs === "number" && input.intervalMs >= 25
          ? input.intervalMs
          : WATCH_INTERVAL_MS;

      let signature = "";
      let published = false;
      let timer;
      const stop = () => {
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        store.close();
      };
      const publish = () => {
        if (signal.aborted) return;
        try {
          const window = store.readEntryWindow(conversationId, { limit: WATCH_WINDOW_SIZE });
          // The reduction runs on every publish tick and is part of the frame
          // signature below, so a heartbeat crossing the bound emits a frame
          // even when no committed entry changed.
          const live = annotatedLive(store, conversationId, input.memberId, liveness);
          const tasks = store.readTaskGraph();
          const next = JSON.stringify({
            ids: window.entries.map((entry) => `${entry.cursor}:${entry.id}:${entry.text.length}`),
            cursor: window.cursor,
            hasEarlier: window.hasEarlier,
            live,
            tasks,
          });
          if (next === signature && published) return;
          signature = next;
          published = true;
          const emittedAt = Date.now();
          // The wire frame, verbatim: the panel reduces it exactly once (see
          // the module docblock). Publishing a pre-reduced view here is what
          // made the shipped panel read `frame.entriesWindow` from a view that
          // only had `entries`.
          send({
            type: "frame",
            frame: {
              conversationId,
              entriesWindow: window.entries,
              cursor: window.cursor,
              hasEarlier: window.hasEarlier,
              live,
              emittedAt,
            },
            tasks,
            emittedAt,
          });
        } catch (error) {
          send({
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          });
          stop();
        }
      };

      timer = setInterval(publish, intervalMs);
      signal.addEventListener("abort", stop, { once: true });
      publish();

      return {
        async receive() {
          // Read-only watch: the browser side has nothing to say here. Control
          // commands travel through `request("control")`, where the owner
          // re-checks authority.
        },
        close() {
          stop();
        },
      };
    },
  };
}

const plugin = {
  apiVersion: 5,
  name: "Durable Member",
  activate(context) {
    return { peer: createDurableMemberPeer(context) };
  },
};

export default plugin;
