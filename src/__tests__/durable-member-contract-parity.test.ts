import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateDurableCommand } from "../durable-member/commands.js";
import type {
  ConversationViewState,
  ConversationWatchFrame,
  DurableLiveGeneration,
  DurableTranscriptWindow,
} from "../durable-member/contract.js";
import {
  mergeEarlierTranscriptPage,
  reduceConversationFrames,
} from "../durable-member/contract.js";
import { type DurableStore, openDurableStore } from "../durable-member/standalone-store.js";
import type { LiveLiveness } from "../durable-member/viewer.js";
import {
  annotateLiveGeneration,
  DEFAULT_LIVE_STALE_AFTER_MS,
  reduceLiveLiveness,
} from "../durable-member/viewer.js";
import { makeStateDir, removeStateDir } from "./durable-fixtures.js";

/**
 * Cross-component contract parity (bd-186).
 *
 * The pi-web plugin is plain JS and cannot import TypeScript, so the command
 * validation, the conversation-view reduction and the store read schema exist
 * twice. This test drives BOTH implementations over shared JSON fixtures and
 * the same SQLite file. A mirror that drifts fails here instead of shipping a
 * panel that mis-renders or a validator that accepts what the owner refuses.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const pluginDir = join(repoRoot, "pi-web-plugins", "durable-member");
const fixturesDir = join(pluginDir, "fixtures");

interface MirrorValidation {
  readonly ok: boolean;
  readonly code?: string;
  readonly error?: string;
  readonly value?: unknown;
}

interface MirrorContract {
  validateCommand(raw: unknown, options?: { memberId?: string }): MirrorValidation;
  reduceConversationFrames(
    state: ConversationViewState | undefined,
    frame: ConversationWatchFrame,
    options?: { maxEntries?: number },
  ): ConversationViewState;
  mergeEarlierTranscriptPage(
    state: ConversationViewState,
    page: DurableTranscriptWindow,
    options?: { maxEntries?: number },
  ): ConversationViewState;
  controlAvailability(request: { kind: string; memberId: string; confirmation?: string }): {
    available: boolean;
    requiresConfirmation: false | "missing" | "mismatch";
  };
  formatTaskLine(node: unknown): string;
  reduceLiveLiveness(input: {
    readonly live: DurableLiveGeneration | null;
    readonly now: number;
    readonly ownerAlive?: boolean;
    readonly staleAfterMs?: number;
  }): LiveLiveness;
  annotateLiveGeneration(outcome: LiveLiveness): DurableLiveGeneration | null;
  readonly DEFAULT_LIVE_STALE_AFTER_MS?: number;
}

interface MirrorStore {
  readonly readOnly: true;
  readEntryWindow(
    conversationId: string,
    options?: Record<string, unknown>,
  ): DurableTranscriptWindow;
  readLiveGeneration(conversationId: string): unknown;
  readTaskGraph(): readonly unknown[];
  readEntryDetails(entryId: string): unknown;
  close(): void;
}

interface MirrorStoreModule {
  openDurableStoreReader(options: { path: string }): {
    ok: boolean;
    error?: string;
    store?: MirrorStore;
  };
}

/**
 * Import a plain-JS mirror. The file URL keeps Vite from bundling it, and the
 * native-require fallback covers runners whose dynamic import refuses a variable
 * file URL (Node >= 22.12 loads ESM through require()).
 */
async function importMirror<T>(fileName: string): Promise<T> {
  const absolute = join(pluginDir, fileName);
  try {
    return (await import(/* @vite-ignore */ pathToFileURL(absolute).href)) as T;
  } catch {
    return createRequire(import.meta.url)(absolute) as T;
  }
}

function readFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, fileName), "utf8")) as T;
}

interface CommandFixtureCase {
  readonly name: string;
  readonly memberId?: string;
  readonly expand?: { readonly field: string; readonly bytes: number };
  readonly input: Record<string, unknown>;
  readonly expected: { readonly ok: boolean; readonly code?: string; readonly value?: unknown };
}

interface FrameFixtureCase {
  readonly name: string;
  readonly maxEntries: number;
  readonly frames: readonly ConversationWatchFrame[];
  readonly expected: {
    readonly entries: readonly { readonly id: string; readonly text: string }[];
    readonly cursor: string | null;
    readonly hasEarlier: boolean;
    readonly live: unknown;
  };
}

interface MergeFixtureCase {
  readonly name: string;
  readonly maxEntries: number;
  readonly state: ConversationViewState;
  readonly page: DurableTranscriptWindow;
  readonly expected: FrameFixtureCase["expected"];
}

/**
 * The fixture row shape is the store's own, but one case deliberately omits
 * `updatedAt`: a plain-JSON reader can meet such a row, and an absent heartbeat
 * must not read as fresh. JSON parsing is unchecked, so a value the type cannot
 * spell still reaches both implementations here. That is the point.
 */
interface LivenessFixtureCase {
  readonly name: string;
  readonly input: {
    readonly live: DurableLiveGeneration | null;
    readonly now: number;
    readonly ownerAlive?: boolean;
    readonly staleAfterMs?: number;
  };
  readonly expected: {
    readonly kind: LiveLiveness["kind"];
    readonly reason: string | null;
    readonly annotated: {
      readonly generationId: string;
      readonly status: string;
      readonly stale: boolean;
      readonly staleReason: string | null;
    } | null;
  };
}

const dirs: string[] = [];
const stores: DurableStore[] = [];

function storePath(): string {
  const dir = makeStateDir();
  dirs.push(dir);
  return join(dir, "store.sqlite");
}

afterEach(() => {
  for (const opened of stores.splice(0)) {
    try {
      opened.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) removeStateDir(dir);
});

function expandInput(fixture: CommandFixtureCase): Record<string, unknown> {
  const input = { ...fixture.input };
  if (fixture.expand !== undefined) {
    input[fixture.expand.field] = "a".repeat(fixture.expand.bytes);
  }
  return input;
}

function summarized(view: ConversationViewState): FrameFixtureCase["expected"] {
  return {
    entries: view.entries.map((entry) => ({ id: entry.id, text: entry.text })),
    cursor: view.cursor,
    hasEarlier: view.hasEarlier,
    live: view.live,
  };
}

function summarizedLiveness(
  outcome: LiveLiveness,
  annotated: DurableLiveGeneration | null,
): LivenessFixtureCase["expected"] {
  return {
    kind: outcome.kind,
    reason: outcome.kind === "stale" ? outcome.reason : null,
    annotated:
      annotated === null
        ? null
        : {
            generationId: annotated.generationId,
            status: annotated.status,
            stale: annotated.stale === true,
            staleReason: annotated.staleReason ?? null,
          },
  };
}

describe("durable-member contract parity: commands", () => {
  it("validates every fixture case identically in TypeScript and the plugin mirror", async () => {
    const mirror = await importMirror<MirrorContract>("contract.js");
    const fixture = readFixture<{ cases: CommandFixtureCase[] }>("commands.json");

    for (const testCase of fixture.cases) {
      const input = expandInput(testCase);
      const options = testCase.memberId === undefined ? undefined : { memberId: testCase.memberId };
      const typed = validateDurableCommand(input, options);
      const mirrored = mirror.validateCommand(input, options);

      expect(typed.ok, testCase.name).toBe(testCase.expected.ok);
      expect(mirrored.ok, `${testCase.name} (mirror)`).toBe(testCase.expected.ok);
      expect(mirrored.ok, `${testCase.name} (ts vs mirror)`).toBe(typed.ok);

      if (typed.ok) {
        expect(typed.value, testCase.name).toEqual(testCase.expected.value);
        expect(mirrored.value, `${testCase.name} (mirror)`).toEqual(testCase.expected.value);
      } else {
        expect(typed.code, testCase.name).toBe(testCase.expected.code);
        expect(mirrored.code, `${testCase.name} (mirror)`).toBe(typed.code);
      }
    }
  });
});

describe("durable-member contract parity: conversation view", () => {
  it("reduces watch frames identically", async () => {
    const mirror = await importMirror<MirrorContract>("contract.js");
    const fixture = readFixture<{ cases: FrameFixtureCase[] }>("frames.json");

    for (const testCase of fixture.cases) {
      let typed: ConversationViewState | undefined;
      let mirrored: ConversationViewState | undefined;
      for (const frame of testCase.frames) {
        typed = reduceConversationFrames(typed, frame, { maxEntries: testCase.maxEntries });
        mirrored = mirror.reduceConversationFrames(mirrored, frame, {
          maxEntries: testCase.maxEntries,
        });
      }
      expect(typed, testCase.name).toBeDefined();
      expect(mirrored, `${testCase.name} (mirror)`).toEqual(typed);
      expect(summarized(typed as ConversationViewState), testCase.name).toEqual(testCase.expected);
    }
  });

  it("merges earlier transcript pages identically", async () => {
    const mirror = await importMirror<MirrorContract>("contract.js");
    const fixture = readFixture<{ mergeCases: MergeFixtureCase[] }>("frames.json");

    for (const testCase of fixture.mergeCases) {
      const options = { maxEntries: testCase.maxEntries };
      const typed = mergeEarlierTranscriptPage(testCase.state, testCase.page, options);
      const mirrored = mirror.mergeEarlierTranscriptPage(testCase.state, testCase.page, options);

      expect(mirrored, `${testCase.name} (mirror)`).toEqual(typed);
      expect(summarized(typed), testCase.name).toEqual(testCase.expected);
    }
  });

  it("agrees on which controls the panel offers", async () => {
    const mirror = await importMirror<MirrorContract>("contract.js");
    const cases = [
      { kind: "steer", memberId: "member-a", expected: true },
      { kind: "abort", memberId: "member-a", expected: true },
      { kind: "reset", memberId: "member-a", expected: false },
      { kind: "reset", memberId: "member-a", confirmation: "member-a", expected: true },
      { kind: "configure", memberId: "member-a", confirmation: "member-b", expected: false },
      { kind: "steer", memberId: "member-a", confirmation: "member-a", expected: true },
    ];
    for (const testCase of cases) {
      const result = mirror.controlAvailability({
        kind: testCase.kind,
        memberId: testCase.memberId,
        ...(testCase.confirmation === undefined ? {} : { confirmation: testCase.confirmation }),
      });
      expect(result.available, `${testCase.kind} ${testCase.confirmation ?? ""}`).toBe(
        testCase.expected,
      );
    }
  });

  it("renders the same task line, including the owner edge and waiting-on", async () => {
    const mirror = await importMirror<MirrorContract>("contract.js");
    const node = {
      id: "task-2",
      title: "implement",
      status: "blocked",
      owner: { memberId: "member-a", edge: "child" },
      waitingOn: ["task-1"],
      background: true,
    };
    expect(mirror.formatTaskLine(node)).toBe(
      "task-2 [blocked] child:member-a · waiting on task-1 · background — implement",
    );
  });
});

describe("durable-member contract parity: live liveness", () => {
  it("reduces and annotates a live generation identically", async () => {
    const mirror = await importMirror<MirrorContract>("contract.js");
    const fixture = readFixture<{ cases: LivenessFixtureCase[] }>("liveness.json");

    // The default bound is a constant on both sides, so a fixture that only
    // supplied explicit bounds could hide a drifted default.
    expect(mirror.DEFAULT_LIVE_STALE_AFTER_MS, "mirror default bound").toBe(
      DEFAULT_LIVE_STALE_AFTER_MS,
    );

    for (const testCase of fixture.cases) {
      const typed = reduceLiveLiveness(testCase.input);
      const mirrored = mirror.reduceLiveLiveness(testCase.input);
      expect(mirrored, `${testCase.name} (ts vs mirror)`).toEqual(typed);

      const typedAnnotated = annotateLiveGeneration(typed);
      const mirroredAnnotated = mirror.annotateLiveGeneration(mirrored);
      expect(mirroredAnnotated, `${testCase.name} (annotated)`).toEqual(typedAnnotated);

      expect(summarizedLiveness(typed, typedAnnotated), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("durable-member contract parity: store reads", () => {
  it("reads one database identically from TypeScript and the plugin reader", async () => {
    const path = storePath();
    const conversationId = "member-a:main";
    const writable = openDurableStore({ path });
    if (!writable.ok) throw new Error(writable.error);
    stores.push(writable.store);
    writable.store.appendEntry({
      id: "e1",
      conversationId,
      role: "user",
      kind: "message",
      timestamp: 10,
      text: "read the bead",
      retry: { attempt: 1, maxAttempts: 2, reason: "rate limited" },
    });
    writable.store.appendEntry({
      id: "e-tool",
      conversationId,
      role: "tool",
      kind: "tool-output",
      timestamp: 20,
      text: "3 files",
      toolCall: { name: "read", input: { path: "src" } },
      toolOutput: { name: "read", output: "3 files", details: { bytes: 42 }, callId: "call-1" },
    });
    writable.store.appendEntry({
      id: "e-compact",
      conversationId,
      role: "system",
      kind: "compaction",
      timestamp: 30,
      text: "summarized",
      compaction: { summaryId: "sum-1", tokensBefore: 1200, tokensAfter: 400 },
    });
    writable.store.setLiveGeneration(conversationId, {
      conversationId,
      generationId: "gen-1",
      status: "streaming",
      partialText: "thinking",
      startedAt: 100,
      updatedAt: 200,
      attempt: 1,
      toolCalls: [{ callId: "call-2", name: "edit", input: { file: "a" }, status: "running" }],
      runFailure: { message: "boom", code: "E_BOOM" },
    });
    writable.store.upsertTask({
      id: "task-1",
      title: "scout",
      status: "done",
      waitingOn: [],
      background: false,
    });
    writable.store.upsertTask({
      id: "task-2",
      title: "implement",
      status: "blocked",
      owner: { memberId: "member-a", edge: "child" },
      waitingOn: ["task-1"],
      background: true,
    });
    writable.store.close();

    const typed = openDurableStore({ path, readOnly: true });
    if (!typed.ok) throw new Error(typed.error);
    stores.push(typed.store);

    const mirrorModule = await importMirror<MirrorStoreModule>("store-reader.js");
    const mirrorOpened = mirrorModule.openDurableStoreReader({ path });
    expect(mirrorOpened.ok).toBe(true);
    if (!mirrorOpened.ok || mirrorOpened.store === undefined) {
      throw new Error(mirrorOpened.error ?? "mirror reader did not open");
    }
    const mirror = mirrorOpened.store;
    expect(mirror.readOnly).toBe(true);

    const latest = typed.store.readEntryWindow(conversationId, { limit: 2 });
    expect(mirror.readEntryWindow(conversationId, { limit: 2 })).toEqual(latest);
    expect(mirror.readEntryWindow(conversationId, { before: latest.cursor, limit: 2 })).toEqual(
      typed.store.readEntryWindow(conversationId, { before: latest.cursor, limit: 2 }),
    );
    expect(mirror.readLiveGeneration(conversationId)).toEqual(
      typed.store.readLiveGeneration(conversationId),
    );
    expect(mirror.readTaskGraph()).toEqual(typed.store.readTaskGraph());
    expect(mirror.readEntryDetails("e-tool")).toEqual(typed.store.readEntryDetails("e-tool"));
    expect(mirror.readEntryDetails("missing")).toBeNull();
    mirror.close();
  });
});

describe("durable-member contract parity: SYNC WARNING markers", () => {
  it("keeps both sides of every mirrored contract marked", () => {
    const pairs = [
      ["src/durable-member/commands.ts", "pi-web-plugins/durable-member/contract.js"],
      ["src/durable-member/contract.ts", "pi-web-plugins/durable-member/contract.js"],
      ["src/durable-member/standalone-store.ts", "pi-web-plugins/durable-member/store-reader.js"],
      ["src/durable-member/socket.ts", "pi-web-plugins/durable-member/control-client.js"],
    ] as const;
    for (const [typescriptSide, pluginSide] of pairs) {
      const tsSource = readFileSync(join(repoRoot, typescriptSide), "utf8");
      const pluginSource = readFileSync(join(repoRoot, pluginSide), "utf8");
      expect(tsSource, typescriptSide).toContain("SYNC WARNING");
      expect(pluginSource, pluginSide).toContain("SYNC WARNING");
    }
  });
});
