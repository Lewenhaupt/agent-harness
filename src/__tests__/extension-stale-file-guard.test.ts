/**
 * Tests for the stale-file-guard pi extension entry point
 * (extensions/stale-file-guard.ts) against pi-coding-agent 1.0.x
 * event/handler shapes.
 *
 * The user_bash handler is the bd-90 behavior change: `UserBashEventResult`
 * in 1.0.x is an exhaustive union (`{ operations }` xor `{ result }`), so the
 * pre-1.0 `{}` return fails pi's `isUserBashEventResult` check and makes
 * `ExtensionRunner#emitUserBash` throw on every `!`/`!!` bash invocation. The
 * handler now returns `void`/`undefined`, which `emitUserBash` treats as
 * "continue → pi's default local bash execution".
 *
 * No `node:child_process` or pi internals are mocked: the handlers are pure
 * event→result functions over the src/ hash map, so they are driven directly.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractEditPath } from "../../extensions/stale-file-guard.js";
import { checkEdit, getTrackedFileCount, recordRead, reset } from "../stale-file-guard.js";

// Mirrors the module-private marker constant in extensions/stale-file-guard.ts.
// The extension sets a process-wide flag so a second copy of the same guard
// (global + project-local install) does not register duplicate handlers.
const STALE_GUARD_LOAD_MARKER = "__belayd_stale_file_guard_loaded__";

// Extensions receive typed events; the harness only needs to record and
// replay them, so the loosest faithful signature is used here.
type CapturedHandler = (event: object, ctx: unknown) => unknown;

const handlers = new Map<string, CapturedHandler[]>();

function createMockPi(): ExtensionAPI {
  handlers.clear();
  const api = {
    on: (event: string, handler: CapturedHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  return api;
}

function getHandlers(event: string): CapturedHandler[] {
  const list = handlers.get(event);
  if (list === undefined || list.length === 0) {
    throw new Error(`no handler registered for ${event}`);
  }
  return list;
}

// Destructuring `handlers.get(...)[0]` yields `T | undefined` under
// noUncheckedIndexedAccess; guard it explicitly instead of asserting.
function getFirstHandler(event: string): CapturedHandler {
  const first = getHandlers(event)[0];
  if (first === undefined) {
    throw new Error(`no handler registered for ${event}`);
  }
  return first;
}

function clearLoadMarker(): void {
  delete (globalThis as Record<string, unknown>)[STALE_GUARD_LOAD_MARKER];
}

interface BlockResult {
  block?: boolean;
  reason?: string;
}

// Every tool_call handler runs in registration order; a block short-circuits in
// pi, so the first blocking result is what the session would actually see.
async function runToolCallHandlers(event: object): Promise<BlockResult | undefined> {
  let blocked: BlockResult | undefined;
  for (const handler of getHandlers("tool_call")) {
    const result = (await handler(event, undefined)) as BlockResult | undefined;
    if (result?.block) blocked = result;
  }
  return blocked;
}

async function runToolResultHandlers(event: object): Promise<unknown> {
  return getFirstHandler("tool_result")(event, undefined);
}

let tmpDir: string;

async function registerGuard(): Promise<void> {
  const mod = await import("../../extensions/stale-file-guard.js");
  mod.default(createMockPi());
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "stale-guard-ext-test-"));
  reset();
  clearLoadMarker();
  await registerGuard();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  reset();
  clearLoadMarker();
});

describe("user_bash handler (bd-90 compile + behavior fix)", () => {
  it("returns undefined so pi falls back to its default local bash execution", async () => {
    const handler = getFirstHandler("user_bash");
    // Faithful 1.0.2 UserBashEvent shape
    const event = {
      type: "user_bash" as const,
      command: "git status",
      excludeFromContext: false,
      cwd: tmpDir,
    };

    // pi 1.0.x emitUserBash: undefined → continue to local execution;
    // any other object must satisfy { operations } xor { result } or it throws.
    const result = await handler(event, undefined);
    expect(result).toBeUndefined();
  });

  it("clears all tracked read hashes (conservative invalidation)", async () => {
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "original", "utf8");
    recordRead(filePath, "original");
    writeFileSync(filePath, "modified", "utf8");
    expect(checkEdit(filePath)).toHaveProperty("allowed", false);

    const handler = getFirstHandler("user_bash");
    await handler(
      { type: "user_bash", command: "echo hi", excludeFromContext: false, cwd: tmpDir },
      undefined,
    );

    // No hash survives the invalidation, so edits are allowed again.
    expect(checkEdit(filePath)).toHaveProperty("allowed", true);
  });
});

describe("tool_result read recording", () => {
  it("records a read from a faithful 1.0.2 read tool_result event", async () => {
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "original", "utf8");
    const handler = getFirstHandler("tool_result");

    const event = {
      type: "tool_result" as const,
      toolCallId: "t1",
      toolName: "read",
      input: { path: filePath },
      content: [{ type: "text", text: "original" }],
      isError: false,
    };
    const result = await handler(event, undefined);
    // Unmodified result: the handler returns the empty passthrough object.
    expect(result).toEqual({});

    // The read is tracked: an external modification now blocks the edit guard.
    writeFileSync(filePath, "modified", "utf8");
    expect(checkEdit(filePath)).toHaveProperty("allowed", false);
  });

  it("tool_result handler returns {} without throwing for a non-read tool", async () => {
    const handler = getFirstHandler("tool_result");
    const event = {
      type: "tool_result" as const,
      toolCallId: "t2",
      toolName: "bash",
      input: { command: "ls" },
      content: [{ type: "text", text: "" }],
      isError: false,
    };
    expect(await handler(event, undefined)).toEqual({});
  });

  it("records a read for the capitalized Read tool name", async () => {
    const filePath = join(tmpDir, "capitalized-read.txt");
    writeFileSync(filePath, "original", "utf8");

    expect(
      await runToolResultHandlers({
        type: "tool_result" as const,
        toolCallId: "t12",
        toolName: "Read",
        input: { path: filePath },
        content: [{ type: "text", text: "original" }],
        isError: false,
      }),
    ).toEqual({});

    writeFileSync(filePath, "modified", "utf8");
    expect(checkEdit(filePath)).toHaveProperty("allowed", false);
  });

  it("tracks nothing for a read without a usable path or text content", async () => {
    const events: object[] = [
      // pi 1.0.x always sets input, but the handler narrows it, not asserts it.
      { type: "tool_result", toolCallId: "t13", toolName: "read", content: [], isError: false },
      {
        type: "tool_result",
        toolCallId: "t14",
        toolName: "read",
        input: { path: 42 },
        content: [{ type: "text", text: "x" }],
        isError: false,
      },
      {
        type: "tool_result",
        toolCallId: "t15",
        toolName: "read",
        input: { path: join(tmpDir, "empty.txt") },
        content: [{ type: "image", data: "", mimeType: "image/png" }],
        isError: false,
      },
    ];

    for (const event of events) {
      expect(await runToolResultHandlers(event)).toEqual({});
    }
    // No text and no usable path means no hash to compare against later.
    expect(getTrackedFileCount()).toBe(0);
  });
});

describe("tool_call guard handlers", () => {
  it("blocks git --no-verify bash commands", async () => {
    const bashHandlers = getHandlers("tool_call");
    const event = {
      type: "tool_call" as const,
      toolCallId: "t3",
      toolName: "bash",
      input: { command: "git commit --no-verify -m x" },
    };

    let blocked: { block?: boolean; reason?: string } | undefined;
    for (const handler of bashHandlers) {
      const result = (await handler(event, undefined)) as
        | { block?: boolean; reason?: string }
        | undefined;
      if (result?.block) blocked = result;
    }
    expect(blocked).toHaveProperty("block", true);
    expect(blocked?.reason).toContain("--no-verify");
  });

  it("does not block ordinary bash commands", async () => {
    const event = {
      type: "tool_call" as const,
      toolCallId: "t4",
      toolName: "bash",
      input: { command: "git commit -m x" },
    };
    for (const handler of getHandlers("tool_call")) {
      expect(await handler(event, undefined)).toEqual({});
    }
  });

  it("blocks a stale edit for a faithful 1.0.2 EditToolInput ({ path, edits[] })", async () => {
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "original", "utf8");
    recordRead(filePath, "original");
    writeFileSync(filePath, "modified", "utf8");

    const event = {
      type: "tool_call" as const,
      toolCallId: "t5",
      toolName: "edit",
      input: { path: filePath, edits: [{ oldText: "original", newText: "changed" }] },
    };
    let blocked: { block?: boolean; reason?: string } | undefined;
    for (const handler of getHandlers("tool_call")) {
      const result = (await handler(event, undefined)) as
        | { block?: boolean; reason?: string }
        | undefined;
      if (result?.block) blocked = result;
    }
    expect(blocked).toHaveProperty("block", true);
    expect(blocked?.reason).toContain("has changed since it was read");
  });

  it("does not block an edit the guard has no hash for", async () => {
    const event = {
      type: "tool_call" as const,
      toolCallId: "t6",
      toolName: "edit",
      input: { path: join(tmpDir, "untracked.txt"), edits: [{ oldText: "x", newText: "y" }] },
    };
    for (const handler of getHandlers("tool_call")) {
      expect(await handler(event, undefined)).toEqual({});
    }
  });

  it("does not block an edit for a file read and left unchanged", async () => {
    const filePath = join(tmpDir, "unchanged.txt");
    writeFileSync(filePath, "stable", "utf8");
    recordRead(filePath, "stable");

    const event = {
      type: "tool_call" as const,
      toolCallId: "t7",
      toolName: "edit",
      input: { path: filePath, edits: [{ oldText: "stable", newText: "edited" }] },
    };
    expect(await runToolCallHandlers(event)).toBeUndefined();
  });

  it("blocks a stale edit supplied through the legacy `filePath` field", async () => {
    const filePath = join(tmpDir, "legacy.txt");
    writeFileSync(filePath, "original", "utf8");
    recordRead(filePath, "original");
    writeFileSync(filePath, "modified", "utf8");

    const blocked = await runToolCallHandlers({
      type: "tool_call" as const,
      toolCallId: "t8",
      toolName: "edit",
      input: { filePath, oldText: "original", newText: "changed" },
    });
    expect(blocked).toHaveProperty("block", true);
    expect(blocked?.reason).toContain("has changed since it was read");
  });

  it("accepts the capitalized Edit tool name", async () => {
    const filePath = join(tmpDir, "capitalized.txt");
    writeFileSync(filePath, "original", "utf8");
    recordRead(filePath, "original");
    writeFileSync(filePath, "modified", "utf8");

    const blocked = await runToolCallHandlers({
      type: "tool_call" as const,
      toolCallId: "t9",
      toolName: "Edit",
      input: { path: filePath, edits: [{ oldText: "original", newText: "changed" }] },
    });
    expect(blocked).toHaveProperty("block", true);
  });

  it("does not throw or block on null, non-object or non-string path input", async () => {
    // LLM-generated input is untrusted: odd shapes must degrade to "no path",
    // i.e. pass through, never throw and never block an unrelated edit.
    const oddInputs: unknown[] = [
      undefined,
      null,
      "just-a-string",
      42,
      {},
      { path: null },
      { path: 42 },
      { path: "" },
      { path: [join(tmpDir, "array.txt")] },
      { filePath: 7 },
    ];

    for (const input of oddInputs) {
      const blocked = await runToolCallHandlers({
        type: "tool_call" as const,
        toolCallId: "t10",
        toolName: "edit",
        input,
      });
      expect(blocked).toBeUndefined();
    }
  });

  it("does not block a write tool_call (write is an intentional overwrite)", async () => {
    const filePath = join(tmpDir, "written.txt");
    writeFileSync(filePath, "original", "utf8");
    recordRead(filePath, "original");
    writeFileSync(filePath, "modified", "utf8");

    expect(
      await runToolCallHandlers({
        type: "tool_call" as const,
        toolCallId: "t11",
        toolName: "write",
        input: { path: filePath, content: "new" },
      }),
    ).toBeUndefined();
  });
});

describe("extractEditPath (pi 1.0.x edit input)", () => {
  it("reads `path` from the documented EditToolInput shape", () => {
    expect(extractEditPath({ path: "/tmp/a.txt", edits: [{ oldText: "a", newText: "b" }] })).toBe(
      "/tmp/a.txt",
    );
  });

  it("falls back to legacy `filePath` for older tool schemas", () => {
    expect(extractEditPath({ filePath: "/tmp/a.txt", oldText: "a" })).toBe("/tmp/a.txt");
  });

  it("prefers `path` when both fields are present", () => {
    expect(extractEditPath({ path: "/tmp/new.txt", filePath: "/tmp/old.txt" })).toBe(
      "/tmp/new.txt",
    );
  });

  it("returns undefined for missing, empty or non-string paths", () => {
    expect(extractEditPath(undefined)).toBeUndefined();
    expect(extractEditPath(null)).toBeUndefined();
    expect(extractEditPath("file.txt")).toBeUndefined();
    expect(extractEditPath({ path: "" })).toBeUndefined();
    expect(extractEditPath({ path: 42 })).toBeUndefined();
    expect(extractEditPath({ edits: [] })).toBeUndefined();
  });
});

describe("process-wide load marker dedupe", () => {
  it("registers handlers on first load and none while the marker is set", async () => {
    // The beforeEach registration set the marker; a second registration
    // on a fresh mock must be a no-op.
    const api = createMockPi();
    const mod = await import("../../extensions/stale-file-guard.js");
    mod.default(api);
    expect(handlers.get("user_bash")).toBeUndefined();

    // Clearing the marker allows a fresh registration again.
    clearLoadMarker();
    const reloaded = createMockPi();
    mod.default(reloaded);
    expect(handlers.get("user_bash")).toHaveLength(1);
    expect(handlers.get("tool_result")).toHaveLength(1);
    expect(handlers.get("tool_call")).toHaveLength(2);
  });
});
