/**
 * Failure-path coverage for `runArchify`.
 *
 * `node:child_process` is mocked at the module boundary (repo convention) so
 * each exec outcome — ENOENT, kill/timeout, buffer overflow, non-zero exit —
 * can be exercised without spawning a real archify process.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runArchify } from "../archify.js";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

interface ExecCall {
  file: string;
  args: readonly string[];
  options: ExecOptions;
}

const execFileMock = vi.hoisted(() => {
  const calls: ExecCall[] = [];
  const state: { callback: ExecCallback | null } = { callback: null };
  const fn = vi.fn(
    (file: string, args: readonly string[], options: ExecOptions, callback: ExecCallback) => {
      calls.push({ file, args, options });
      state.callback = callback;
      return { stdin: undefined };
    },
  );
  return { fn, calls, state };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock.fn };
});

const OPTIONS = { cwd: "/tmp", timeoutInMs: 1_000, maxBufferInBytes: 1_024 };

function execCallback(): ExecCallback {
  const callback = execFileMock.state.callback;
  if (callback === null) throw new Error("execFile was not called");
  return callback;
}

describe("runArchify", () => {
  let tmpRoot: string;
  let outPath: string;

  beforeEach(() => {
    execFileMock.calls.length = 0;
    execFileMock.state.callback = null;
    tmpRoot = mkdtempSync(join(tmpdir(), "belayd-archify-run-"));
    outPath = join(tmpRoot, "out.html");
    writeFileSync(outPath, "diagram");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns an error when archify is absent (ENOENT)", async () => {
    const promise = runArchify(["validate", "architecture", "in.json", "--json"], OPTIONS);
    const error = Object.assign(new Error("spawn archify ENOENT"), { code: "ENOENT" });
    execCallback()(error, "", "");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("ENOENT");
  });

  it("treats a killed/timed-out child as a failure even when stdout parses", async () => {
    const promise = runArchify(["deliver", "workflow", "in.json", "--json"], OPTIONS);
    const error = Object.assign(new Error("Command failed: archify deliver"), {
      killed: true,
      signal: "SIGTERM",
    });
    execCallback()(error, JSON.stringify({ schemaVersion: 1, ok: true, command: "deliver" }), "");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("killed");
  });

  it("treats a buffer overflow as a failure even when stdout parses", async () => {
    const promise = runArchify(["deliver", "workflow", "in.json", "--json"], OPTIONS);
    const error = Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });
    execCallback()(error, '{"ok":true,"command":"deliver"}', "");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("buffer");
  });

  it("surfaces stderr for a non-zero exit with empty stdout", async () => {
    const promise = runArchify(["validate", "architecture", "in.json", "--json"], OPTIONS);
    execCallback()(Object.assign(new Error("Command failed"), { code: 1 }), "", "boom");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("boom");
  });

  it("falls back to the exec error message when stderr is empty", async () => {
    const promise = runArchify(["validate", "architecture", "in.json", "--json"], OPTIONS);
    execCallback()(new Error("Command failed with no stderr"), "", "");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("Command failed with no stderr");
  });

  it("returns a structured failure receipt even on a non-zero exit", async () => {
    const promise = runArchify(["validate", "architecture", "in.json", "--json"], OPTIONS);
    const receipt = JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: "validate",
      diagnostics: [],
    });
    execCallback()(Object.assign(new Error("exit 1"), { code: 1 }), receipt, "");

    const result = await promise;
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a receipt");
    expect(result.receipt).toHaveProperty("ok", false);
  });

  it("injects ARCHIFY_UPDATE_CHECK_DISABLED for offline-safe sessions", async () => {
    const promise = runArchify(["validate", "architecture", "in.json", "--json"], OPTIONS);
    execCallback()(null, JSON.stringify({ ok: true, command: "validate" }), "");
    await promise;

    expect(execFileMock.calls).toHaveLength(1);
    expect(execFileMock.calls[0]?.options.env).toHaveProperty("ARCHIFY_UPDATE_CHECK_DISABLED", "1");
  });

  it("synthesizes a receipt for render, which prints a path and no JSON", async () => {
    const promise = runArchify(
      ["render", "architecture", "in.json", outPath, "--quality", "showcase"],
      OPTIONS,
    );
    execCallback()(null, `${outPath}\n`, "");

    const result = await promise;
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a receipt");
    expect(result.receipt).toHaveProperty("command", "render");
    expect(result.receipt).toHaveProperty("type", "architecture");
    expect(result.receipt).toHaveProperty("input", "in.json");
    expect(result.receipt).toHaveProperty("output", outPath);
    expect(execFileMock.calls).toHaveLength(1);
    expect(execFileMock.calls[0]).toHaveProperty("file", "archify");
    expect(execFileMock.calls[0]?.args).not.toContain("--json");
  });

  it("synthesizes a receipt when render omits the optional type", async () => {
    const promise = runArchify(["render", "in.json", outPath, "--quality", "showcase"], OPTIONS);
    execCallback()(null, `${outPath}\n`, "");

    const result = await promise;
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a receipt");
    expect(result.receipt).toHaveProperty("type", undefined);
    expect(result.receipt).toHaveProperty("input", "in.json");
    expect(result.receipt).toHaveProperty("output", outPath);
  });

  it("accepts a render output path with a non-.html extension when the file exists", async () => {
    const txtPath = join(tmpRoot, "out.txt");
    writeFileSync(txtPath, "diagram");

    const promise = runArchify(
      ["render", "architecture", "in.json", txtPath, "--quality", "showcase"],
      OPTIONS,
    );
    execCallback()(null, `${txtPath}\n`, "");

    const result = await promise;
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a receipt");
    expect(result.receipt).toHaveProperty("output", txtPath);
    expect(existsSync(txtPath)).toBe(true);
  });

  it("fails when render claims an output path that does not exist on disk", async () => {
    const missingPath = join(tmpRoot, "missing.html");

    const promise = runArchify(
      ["render", "architecture", "in.json", missingPath, "--quality", "showcase"],
      OPTIONS,
    );
    execCallback()(null, `${missingPath}\n`, "");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("no file exists");
  });

  it("falls back to path synthesis when render is (needlessly) given --json", async () => {
    const promise = runArchify(
      ["render", "architecture", "in.json", outPath, "--quality", "showcase", "--json"],
      OPTIONS,
    );
    // Upstream silently ignores --json for render, so stdout is still the path.
    execCallback()(null, `${outPath}\n`, "");

    const result = await promise;
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a receipt");
    expect(result.receipt).toHaveProperty("command", "render");
    expect(result.receipt).toHaveProperty("output", outPath);
  });

  it("treats a render failure (empty stdout + stderr diagnostics) as a failure", async () => {
    const promise = runArchify(
      ["render", "architecture", "in.json", "out.html", "--quality", "showcase"],
      OPTIONS,
    );
    execCallback()(
      Object.assign(new Error("Command failed"), { code: 1 }),
      "",
      "Error: workflow schema validation failed:\n  / must have required property 'meta'",
    );

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("unexpected stdout");
    expect(result.error).toContain("workflow schema validation failed");
  });

  it("rejects non-path render stdout instead of fabricating success", async () => {
    const promise = runArchify(["render", "architecture", "in.json"], OPTIONS);
    execCallback()(null, "Usage:\n  archify render <type> <input.json>\n", "");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("unexpected stdout");
  });
});
