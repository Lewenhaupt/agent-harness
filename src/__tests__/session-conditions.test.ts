/**
 * Tests for session-conditions.ts — uncommitted file detection.
 */

import { describe, expect, it, vi } from "vitest";

const mockExec = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  exec: mockExec,
}));

import { countUncommittedFiles } from "../session-conditions.js";

/** Set up the exec mock to succeed with the given stdout. */
function mockExecSuccess(stdout: string): void {
  mockExec.mockImplementationOnce((_cmd: string, opts: unknown, cb: unknown) => {
    const callback = typeof opts === "function" ? opts : cb;
    (callback as (err: null, stdout: string, stderr: string) => void)(null, stdout, "");
    return { on: vi.fn() } as unknown as ReturnType<typeof import("node:child_process").exec>;
  });
}

/** Set up the exec mock to fail. */
function mockExecFailure(): void {
  mockExec.mockImplementationOnce((_cmd: string, opts: unknown, cb: unknown) => {
    const callback = typeof opts === "function" ? opts : cb;
    (callback as (err: Error, stdout: string, stderr: string) => void)(
      new Error("git: not found"),
      "",
      "git: not found",
    );
    return { on: vi.fn() } as unknown as ReturnType<typeof import("node:child_process").exec>;
  });
}

describe("countUncommittedFiles", () => {
  it("returns 0 for a clean repo", async () => {
    mockExecSuccess("");
    const result = await countUncommittedFiles("/fake/repo");
    expect(result).toBe(0);
  });

  it("returns the correct count for modified + untracked files", async () => {
    mockExecSuccess(" M src/foo.ts\n?? new-file.ts\nM  src/bar.ts\n?? untracked-dir/");
    const result = await countUncommittedFiles("/fake/repo");
    expect(result).toBe(4);
  });

  it("returns 1 for a single uncommitted file", async () => {
    mockExecSuccess(" M src/solo.ts");
    const result = await countUncommittedFiles("/fake/repo");
    expect(result).toBe(1);
  });

  it("returns 0 for whitespace-only output", async () => {
    mockExecSuccess("  \n\t\n");
    const result = await countUncommittedFiles("/fake/repo");
    expect(result).toBe(0);
  });

  it("returns null when git fails (not a repo)", async () => {
    mockExecFailure();
    const result = await countUncommittedFiles("/not/a/repo");
    expect(result).toBeNull();
  });
});
