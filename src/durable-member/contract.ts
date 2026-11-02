/**
 * Read surface for durable members (bd-186).
 *
 * A durable member has none of the things the harness normally scrapes for
 * insight: no named pi session, no `pi --resume`, no session JSONL, no run
 * manifest. pi-durable exposes its committed state as a stream instead, and
 * this module is the typed shape of that stream. Nothing here performs I/O:
 * the reference store (`standalone-store.ts`) and the viewer (`viewer.ts`) make
 * it executable, and the pi-web plugin mirrors the reduction rules in
 * `pi-web-plugins/durable-member/contract.js`.
 *
 * The reader deliberately has **no** `submit`/`resume` member. A viewer holds
 * storage opened `readOnly: true`, and a writable method must be a type error,
 * not a runtime check.
 *
 * // SYNC WARNING: this read contract and the reduction rules at the bottom of
 * // this file are mirrored in plain JS at
 * // `pi-web-plugins/durable-member/contract.js` (`reduceConversationFrames`,
 * // `mergeEarlierTranscriptPage` and `reduceLiveLiveness`), because the pi-web
 * // panel cannot import TypeScript. Entry ordering, dedupe-by-id (newest copy
 * // wins), the window cap, the `hasEarlier` rule and the live-staleness rule
 * // must be mirrored there and vice versa; the parity test
 * // `src/__tests__/durable-member-contract-parity.test.ts` drives both over
 * // `pi-web-plugins/durable-member/fixtures/frames.json`.
 */

/** Who authored an entry. */
export type DurableEntryRole = "user" | "assistant" | "tool" | "system";

/**
 * What an entry represents. `retry`, `compaction` and `failure` are markers the
 * transcript renders inline because they explain a gap the text alone hides.
 */
export type DurableEntryKind =
  | "message"
  | "tool-call"
  | "tool-output"
  | "retry"
  | "compaction"
  | "failure";

/** One tool invocation as the model requested it. */
export interface DurableToolCall {
  readonly name: string;
  readonly input: unknown;
}

/** One tool result, including pi-durable's per-call `details` payload. */
export interface DurableToolOutput {
  readonly name: string;
  readonly output: string;
  readonly details?: unknown;
  readonly callId?: string;
}

/** A failed attempt that was retried; the retry marker explains the delay. */
export interface DurableRetryMarker {
  readonly attempt: number;
  readonly maxAttempts?: number;
  readonly reason?: string;
}

/** A context compaction; the marker explains why earlier text is summarized. */
export interface DurableCompactionMarker {
  readonly summaryId?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
}

/** A terminal run failure (`runFailure` on the live generation, kind on an entry). */
export interface DurableFailureMarker {
  readonly message: string;
  readonly code?: string;
}

/** One committed transcript entry. */
export interface DurableEntry {
  readonly id: string;
  readonly conversationId: string;
  /**
   * Opaque store position. It stays ordered with transcript pages so a UI can
   * ask for "entries older than this one" without knowing the storage engine.
   */
  readonly cursor: string;
  readonly role: DurableEntryRole;
  readonly kind: DurableEntryKind;
  readonly timestamp: number;
  readonly text: string;
  readonly toolCall?: DurableToolCall;
  readonly toolOutput?: DurableToolOutput;
  readonly retry?: DurableRetryMarker;
  readonly compaction?: DurableCompactionMarker;
  readonly failure?: DurableFailureMarker;
}

/** One in-flight tool call inside the live generation (partial output allowed). */
export interface DurableLiveToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly output?: string;
  readonly details?: unknown;
  readonly status: "running" | "done" | "failed";
}

/** Where the running generation currently is. */
export type DurableLiveStatus =
  | "streaming"
  | "tool-call"
  | "retrying"
  | "compacting"
  | "idle"
  | "failed";

/**
 * Why a live generation is stale rather than running: the owner is known to be
 * gone, or it stopped heartbeating for longer than the reader's bound. Set by
 * the reader's liveness reduction, never by a store.
 */
export type DurableLiveStaleReason = "owner-gone" | "no-heartbeat";

/**
 * The running generation: streamed partial text (~100ms cadence in pi-durable),
 * per-tool-call output and details, retry state, compaction state and
 * `runFailure`. A crash leaves the last *committed* entries, never this, which
 * is why the viewer treats `live` as ephemeral.
 */
export interface DurableLiveGeneration {
  readonly conversationId: string;
  readonly generationId: string;
  readonly status: DurableLiveStatus;
  readonly partialText: string;
  readonly startedAt: number;
  /**
   * The owner's last heartbeat for this generation. A reader decides liveness
   * from this and its own clock instead of trusting `status`, because a crashed
   * owner leaves the row behind with `status: "streaming"`.
   */
  readonly updatedAt: number;
  readonly attempt: number;
  readonly toolCalls: readonly DurableLiveToolCall[];
  readonly retry?: DurableRetryMarker;
  readonly compaction?: DurableCompactionMarker;
  readonly runFailure?: DurableFailureMarker;
  /**
   * Set by the reader's liveness reduction, never stored: this is the *last
   * known* generation, not a running one. A stale generation is reported (not
   * dropped) so a panel can say "owner gone" instead of showing nothing.
   */
  readonly stale?: boolean;
  /** Why {@link stale} is set; absent while the generation is live. */
  readonly staleReason?: DurableLiveStaleReason;
}

/** One watch frame: a committed window plus the live generation. */
export interface ConversationWatchFrame {
  readonly conversationId: string;
  readonly entriesWindow: readonly DurableEntry[];
  /** Cursor of the oldest entry in the window, or null when the window is empty. */
  readonly cursor: string | null;
  /** True when the store holds entries older than this window. */
  readonly hasEarlier: boolean;
  readonly live: DurableLiveGeneration | null;
  readonly emittedAt: number;
}

/** Task lifecycle as the harness reports it. */
export type DurableTaskStatus = "pending" | "running" | "blocked" | "done" | "failed";

/** Which way the owner edge points: the owner's child, parent, or a peer task. */
export type DurableTaskOwnerEdge = "parent" | "child" | "peer";

/** Owner edge of a task node: who owns it and in which direction. */
export interface DurableTaskOwner {
  readonly memberId: string;
  readonly edge: DurableTaskOwnerEdge;
}

/** One node of the durable task graph. */
export interface DurableTaskNode {
  readonly id: string;
  readonly title: string;
  readonly status: DurableTaskStatus;
  readonly owner?: DurableTaskOwner;
  /** Task ids this node is blocked on. */
  readonly waitingOn: readonly string[];
  readonly background: boolean;
}

/** One task-graph watch frame. */
export interface DurableTaskGraphFrame {
  readonly tasks: readonly DurableTaskNode[];
  readonly emittedAt: number;
}

/** One transcript page. */
export interface DurableTranscriptWindow {
  readonly entries: readonly DurableEntry[];
  /** Cursor to pass to `loadEarlier`, or null when there is nothing older. */
  readonly cursor: string | null;
  readonly hasEarlier: boolean;
}

/** A single entry with the raw stored payload, for a details drawer. */
export interface DurableEntryDetails {
  readonly entryId: string;
  readonly entry: DurableEntry;
  readonly toolCall?: DurableToolCall;
  readonly toolOutput?: DurableToolOutput;
  /** The stored payload exactly as read back, including fields the UI ignores. */
  readonly raw: unknown;
}

/**
 * Paged transcript handle. `window()` is the current page, `loadEarlier()`
 * fetches one page before a cursor, and `details()` opens one entry's payload.
 * Merging is the caller's job (see {@link reduceConversationFrames}).
 */
export interface DurableTranscript {
  readonly conversationId: string;
  window(): DurableTranscriptWindow;
  loadEarlier(cursor: string): Promise<DurableTranscriptWindow>;
  details(entryId: string): DurableEntryDetails | null;
  close(): void;
}

/** Options for the conversation watch stream. */
export interface DurableConversationWatchOptions {
  /** Poll cadence for the reference store; pi-durable streams at ~100ms. */
  readonly pollIntervalMs?: number;
  /** Entries per frame. */
  readonly windowSize?: number;
}

/** Options for the task-graph watch stream. */
export interface DurableTaskGraphWatchOptions {
  readonly pollIntervalMs?: number;
}

/**
 * Read-only handle over one member's durable storage. It exposes watch streams,
 * a transcript and `close` — and nothing that could write, resume or steer.
 */
export interface DurableReader {
  readonly memberId: string;
  readonly conversationId: string;
  readonly conversation: {
    watch(options?: DurableConversationWatchOptions): AsyncIterable<ConversationWatchFrame>;
  };
  readonly harness: {
    watchTaskGraph(options?: DurableTaskGraphWatchOptions): AsyncIterable<DurableTaskGraphFrame>;
  };
  transcript(): DurableTranscript;
  close(): void;
}

/**
 * Raised by the reference store when a write or `resume()` is attempted on a
 * session opened `readOnly: true`. This is the runtime half of the read-only
 * invariant; the type half is {@link DurableReader} having no write members.
 */
export class ReadOnlySessionError extends Error {
  constructor(operation: string) {
    super(`session was opened readOnly: ${operation} is not available`);
    this.name = "ReadOnlySessionError";
  }
}

/** Default entries retained by a merged conversation view. */
export const DEFAULT_VIEW_WINDOW = 200;

/** Default poll cadence, matching pi-durable's ~100ms partial-text cadence. */
export const DEFAULT_WATCH_POLL_MS = 100;

/** Merged view state: deduped entries, the live generation, and paging state. */
export interface ConversationViewState {
  readonly conversationId: string;
  readonly entries: readonly DurableEntry[];
  readonly cursor: string | null;
  readonly hasEarlier: boolean;
  readonly live: DurableLiveGeneration | null;
}

export interface ConversationViewOptions {
  readonly maxEntries?: number;
}

/**
 * Merge one watch frame into a conversation view.
 *
 * Frames are windows, not deltas, so entries are deduped by id (the newer copy
 * wins: a streaming entry can be re-sent with more text) and kept ordered by
 * `(timestamp, id)`. A frame for a different conversation restarts the view —
 * the frame is authoritative, and silently mixing two transcripts is the one
 * failure mode a panel must never have.
 *
 * The cap drops the oldest entries and sets `hasEarlier`, so the UI cannot
 * lose the "load earlier" affordance just because it trimmed memory.
 */
export function reduceConversationFrames(
  state: ConversationViewState | undefined,
  frame: ConversationWatchFrame,
  options?: ConversationViewOptions,
): ConversationViewState {
  const maxEntries = options?.maxEntries ?? DEFAULT_VIEW_WINDOW;
  const sameConversation = state !== undefined && state.conversationId === frame.conversationId;
  const merged = new Map<string, DurableEntry>();
  if (sameConversation) {
    for (const entry of state.entries) merged.set(entry.id, entry);
  }
  for (const entry of frame.entriesWindow) merged.set(entry.id, entry);

  const ordered = [...merged.values()].sort(compareEntries);
  const trimmed =
    ordered.length > maxEntries ? ordered.slice(ordered.length - maxEntries) : ordered;

  return {
    conversationId: frame.conversationId,
    entries: trimmed,
    cursor: trimmed.length === 0 ? null : (trimmed[0]?.cursor ?? null),
    hasEarlier: frame.hasEarlier || trimmed.length < ordered.length,
    live: frame.live,
  };
}

/**
 * Prepend one earlier page to a conversation view.
 *
 * `loadEarlier` pages are older than the current oldest entry, so they go in
 * front; dedupe and ordering are shared with the frame merge so a re-sent entry
 * can never appear twice.
 */
export function mergeEarlierTranscriptPage(
  state: ConversationViewState,
  page: DurableTranscriptWindow,
  options?: ConversationViewOptions,
): ConversationViewState {
  const maxEntries = options?.maxEntries ?? DEFAULT_VIEW_WINDOW;
  const merged = new Map<string, DurableEntry>();
  for (const entry of page.entries) merged.set(entry.id, entry);
  for (const entry of state.entries) merged.set(entry.id, entry);

  const ordered = [...merged.values()].sort(compareEntries);
  const trimmed =
    ordered.length > maxEntries ? ordered.slice(ordered.length - maxEntries) : ordered;

  return {
    conversationId: state.conversationId,
    entries: trimmed,
    cursor: trimmed.length === 0 ? null : (trimmed[0]?.cursor ?? null),
    hasEarlier: page.hasEarlier || trimmed.length < ordered.length,
    live: state.live,
  };
}

/** Ascending transcript order. Ties break on id so merging is deterministic. */
function compareEntries(left: DurableEntry, right: DurableEntry): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
