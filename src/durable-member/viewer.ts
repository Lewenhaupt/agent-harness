/**
 * Read-only viewer over a durable member's storage (bd-186).
 *
 * The viewer assembles a {@link DurableReader}: watch streams for the
 * conversation and the task graph, plus a paged transcript. It opens the
 * reference store with `readOnly: true` and then *proves* the invariant before
 * handing the reader out:
 *
 * 1. the handle reports `readOnly: true`;
 * 2. a write attempt throws {@link ReadOnlySessionError};
 * 3. `resume()` throws {@link ReadOnlySessionError};
 * 4. the reader surface has no `submit`/`resume`/`write` member.
 *
 * Those checks are tests, not comments: a viewer that could write would break
 * pi-durable's single-writer guarantee, and the SQLite read-only flag alone is
 * one refactor away from being dropped.
 *
 * Liveness is the reader's verdict, not the row's. A crashed owner leaves its
 * live generation behind with `status: "streaming"`, so
 * {@link reduceLiveLiveness} decides from the heartbeat (`updatedAt`) against
 * {@link DEFAULT_LIVE_STALE_AFTER_MS} and from the injected owner-liveness seam.
 * A stale row is reported with `stale: true` rather than dropped, because the
 * panel has to render "owner gone" instead of a banner that claims a dead
 * generation is still running.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ConversationWatchFrame,
  DurableEntryDetails,
  DurableLiveGeneration,
  DurableLiveStaleReason,
  DurableReader,
  DurableTaskGraphFrame,
  DurableTaskNode,
  DurableTranscript,
  DurableTranscriptWindow,
} from "./contract.js";
import { DEFAULT_WATCH_POLL_MS, ReadOnlySessionError } from "./contract.js";
import type { DurableEntryInput, DurableStore } from "./standalone-store.js";
import { DEFAULT_TRANSCRIPT_PAGE, openDurableStore } from "./standalone-store.js";

/** Reader members that would mean the viewer can mutate the member. */
const FORBIDDEN_READER_MEMBERS = ["submit", "resume", "write", "steer", "abort"] as const;

/**
 * Default heartbeat bound for a live generation.
 *
 * pi-durable commits partials at roughly 100 ms, so 30 s is ~300 missed updates —
 * far beyond any normal gap, and still bounded enough that a crashed owner's
 * banner stops claiming "streaming" promptly. A liveness probe that knows the
 * owner is gone short-circuits this bound entirely.
 */
export const DEFAULT_LIVE_STALE_AFTER_MS = 30_000;

/** The reader's verdict on one live row: absent, running, or last-known. */
export type LiveLiveness =
  | { readonly kind: "none" }
  | { readonly kind: "live"; readonly live: DurableLiveGeneration }
  | {
      readonly kind: "stale";
      readonly live: DurableLiveGeneration;
      readonly reason: DurableLiveStaleReason;
    };

export interface LiveLivenessInput {
  readonly live: DurableLiveGeneration | null;
  /** The reader's clock, injected so a test never sleeps or depends on wall time. */
  readonly now: number;
  /**
   * False when a liveness probe says the member process is gone. Absent means
   * "unknown", which is treated as alive so the heartbeat bound stays in charge
   * (the plain-JS mirror and the parity fixture pin the same default).
   */
  readonly ownerAlive?: boolean;
  readonly staleAfterMs?: number;
}

/**
 * Decide whether a live row is actually live.
 *
 * `status` is the owner's own claim and survives its crash, so liveness must be
 * derived from the heartbeat and from an explicit owner signal. Pure on purpose:
 * every input is a value, so the decision is unit-testable without timers.
 */
export function reduceLiveLiveness(input: LiveLivenessInput): LiveLiveness {
  const { live, now } = input;
  if (live === null) return { kind: "none" };
  if (input.ownerAlive === false) return { kind: "stale", live, reason: "owner-gone" };
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_LIVE_STALE_AFTER_MS;
  // An unset heartbeat (`updatedAt: 0`) is old against a wall clock, which is
  // the safe direction: an unknown heartbeat must not be presented as running.
  // The `?? 0` also covers a row parsed from plain JSON with no heartbeat at
  // all, where `now - undefined` would be `NaN` and read as fresh.
  const heartbeat = live.updatedAt ?? 0;
  if (now - heartbeat >= staleAfterMs) {
    return { kind: "stale", live, reason: "no-heartbeat" };
  }
  return { kind: "live", live };
}

/**
 * Project a liveness verdict onto the watch frame's `live` field.
 *
 * A stale generation is reported with `stale: true`, not dropped: the panel has
 * to be able to say "owner gone, this is what it last committed" instead of
 * showing nothing.
 */
export function annotateLiveGeneration(outcome: LiveLiveness): DurableLiveGeneration | null {
  switch (outcome.kind) {
    case "none":
      return null;
    case "live":
      return outcome.live;
    case "stale":
      return { ...outcome.live, stale: true, staleReason: outcome.reason };
  }
}

export interface DurableViewerOptions {
  readonly storePath: string;
  readonly memberId: string;
  readonly conversationId: string;
  /** Poll cadence for the reference store (pi-durable streams partials at ~100ms). */
  readonly pollIntervalMs?: number;
  /** Entries per watch frame and per transcript page. */
  readonly windowSize?: number;
  /** Heartbeat bound after which a live row is stale. Defaults to 30 s. */
  readonly staleAfterMs?: number;
  /** Clock seam for the liveness reduction; defaults to `Date.now()`. */
  readonly now?: () => number;
  /**
   * Liveness seam: return false when the member process is known to be gone
   * (e.g. its control socket no longer accepts a connection). Defaults to
   * "unknown, treat as alive", which leaves the heartbeat bound in charge.
   */
  readonly ownerAlive?: (memberId: string) => boolean;
}

export type DurableViewerOpen =
  | { readonly ok: true; readonly reader: DurableReader }
  | { readonly ok: false; readonly error: string };

export type ReadOnlyInvariantCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Assert that a reader exposes no write path.
 *
 * The TypeScript type already forbids it; this runtime half exists because the
 * pi-web panel consumes the same shape through plain JS, where a stray
 * `submit` would otherwise pass unnoticed.
 */
export function assertReadOnlyViewer(reader: DurableReader): ReadOnlyInvariantCheck {
  const probe = reader as unknown as Record<string, unknown>;
  for (const member of FORBIDDEN_READER_MEMBERS) {
    if (typeof probe[member] === "function") {
      return { ok: false, error: `read-only reader exposes ${member}()` };
    }
  }
  if (typeof reader.close !== "function") {
    return { ok: false, error: "read-only reader has no close()" };
  }
  if (reader.conversation === undefined || typeof reader.conversation.watch !== "function") {
    return { ok: false, error: "read-only reader has no conversation.watch()" };
  }
  if (reader.harness === undefined || typeof reader.harness.watchTaskGraph !== "function") {
    return { ok: false, error: "read-only reader has no harness.watchTaskGraph()" };
  }
  return { ok: true };
}

/**
 * Refuse a store that does not report itself read-only.
 *
 * This is a flag check, not a probe: the write probe runs against a scratch
 * database (below), so a regression here can never append a row to the owner's
 * real storage.
 */
function assertReadOnlyStoreFlag(store: DurableStore): ReadOnlyInvariantCheck {
  if (!store.readOnly) {
    return { ok: false, error: `refusing to build a viewer over writable store ${store.path}` };
  }
  return { ok: true };
}

/** The row the scratch probe attempts; it must never land anywhere real. */
function probeEntry(): DurableEntryInput {
  return {
    id: "__belayd_readonly_probe__",
    conversationId: "__belayd_readonly_probe__",
    role: "system",
    kind: "message",
    timestamp: 0,
    text: "",
  };
}

function expectReadOnlyRefusal(operation: () => void): ReadOnlyInvariantCheck {
  try {
    operation();
  } catch (error) {
    if (error instanceof ReadOnlySessionError) return { ok: true };
    return { ok: false, error: `read-only probe failed unexpectedly: ${String(error)}` };
  }
  return { ok: false, error: "read-only handle accepted a mutation" };
}

/**
 * Prove the store refuses writes and `resume()` on a throwaway database.
 *
 * A scratch file (not the owner's store) is used because a regression must not
 * be able to write `__belayd_readonly_probe__` into real member data. An
 * in-memory database cannot be reopened read-only by a second handle, hence the
 * temp file; the directory is removed afterwards.
 */
function probeReadOnlyRefusal(): ReadOnlyInvariantCheck {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "belayd-durable-readonly-probe-"));
    const path = join(dir, "probe.sqlite");
    const writable = openDurableStore({ path });
    if (!writable.ok) return { ok: false, error: writable.error };
    writable.store.close();

    const reader = openDurableStore({ path, readOnly: true });
    if (!reader.ok) return { ok: false, error: reader.error };
    try {
      const append = expectReadOnlyRefusal(() => reader.store.appendEntry(probeEntry()));
      if (!append.ok) return append;
      const resume = expectReadOnlyRefusal(() => reader.store.resume("probe"));
      if (!resume.ok) return resume;
      return { ok: true };
    } finally {
      reader.store.close();
    }
  } catch (error) {
    return { ok: false, error: `read-only probe could not run: ${String(error)}` };
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/** A watch frame signature: enough to detect a real change, cheap to compute. */
function conversationSignature(
  window: DurableTranscriptWindow,
  live: ConversationWatchFrame["live"],
): string {
  const entries = window.entries.map((entry) => `${entry.cursor}:${entry.id}:${entry.text.length}`);
  return JSON.stringify({
    entries,
    cursor: window.cursor,
    hasEarlier: window.hasEarlier,
    live,
  });
}

/**
 * Build a read-only reader over the reference store.
 *
 * A missing or unreadable store is an error value: a crashed member must still
 * render its last committed state, and "no storage" is a different condition
 * from "empty conversation" that the panel has to show honestly.
 */
export function openDurableViewer(options: DurableViewerOptions): DurableViewerOpen {
  const opened = openDurableStore({ path: options.storePath, readOnly: true });
  if (!opened.ok) return opened;
  const store = opened.store;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WATCH_POLL_MS;
  const windowSize = options.windowSize ?? DEFAULT_TRANSCRIPT_PAGE;
  const conversationId = options.conversationId;
  const clock = options.now ?? (() => Date.now());
  const ownerAlive = options.ownerAlive ?? (() => true);

  const readOnlyCheck = assertReadOnlyStoreFlag(store);
  if (!readOnlyCheck.ok) {
    store.close();
    return { ok: false, error: readOnlyCheck.error };
  }
  const probe = probeReadOnlyRefusal();
  if (!probe.ok) {
    store.close();
    return { ok: false, error: probe.error };
  }

  let closed = false;
  const isClosed = (): boolean => closed;

  const readConversation = (): {
    window: DurableTranscriptWindow;
    live: ConversationWatchFrame["live"];
  } => ({
    window: store.readEntryWindow(conversationId, { limit: windowSize }),
    // The row's own status is the owner's claim; liveness is decided here.
    live: annotateLiveGeneration(
      reduceLiveLiveness({
        live: store.readLiveGeneration(conversationId),
        now: clock(),
        ownerAlive: ownerAlive(options.memberId),
        ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
      }),
    ),
  });

  async function* watchConversation(): AsyncGenerator<ConversationWatchFrame> {
    let signature = "";
    while (!isClosed()) {
      let current: ReturnType<typeof readConversation>;
      try {
        current = readConversation();
      } catch {
        return;
      }
      const next = conversationSignature(current.window, current.live);
      if (next !== signature) {
        signature = next;
        yield {
          conversationId,
          entriesWindow: current.window.entries,
          cursor: current.window.cursor,
          hasEarlier: current.window.hasEarlier,
          live: current.live,
          emittedAt: Date.now(),
        };
      }
      if (isClosed()) return;
      await delay(pollIntervalMs);
    }
  }

  async function* watchTaskGraph(): AsyncGenerator<DurableTaskGraphFrame> {
    let signature = "";
    while (!isClosed()) {
      let tasks: readonly DurableTaskNode[];
      try {
        tasks = store.readTaskGraph();
      } catch {
        return;
      }
      const next = JSON.stringify(tasks);
      if (next !== signature) {
        signature = next;
        yield { tasks, emittedAt: Date.now() };
      }
      if (isClosed()) return;
      await delay(pollIntervalMs);
    }
  }

  const transcript = (): DurableTranscript => {
    const readPage = (before?: string): DurableTranscriptWindow =>
      store.readEntryWindow(conversationId, {
        limit: windowSize,
        ...(before === undefined ? {} : { before }),
      });
    return {
      conversationId,
      window: () => readPage(),
      loadEarlier: async (cursor) => readPage(cursor),
      details: (entryId: string): DurableEntryDetails | null => store.readEntryDetails(entryId),
      close: () => {},
    };
  };

  const reader: DurableReader = {
    memberId: options.memberId,
    conversationId,
    conversation: { watch: () => watchConversation() },
    harness: { watchTaskGraph: () => watchTaskGraph() },
    transcript,
    close() {
      if (closed) return;
      closed = true;
      store.close();
    },
  };

  const readerCheck = assertReadOnlyViewer(reader);
  if (!readerCheck.ok) {
    reader.close();
    return { ok: false, error: readerCheck.error };
  }

  return { ok: true, reader };
}
