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
import { runArchify, runArchifyText } from "../archify.js";

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

  it("returns a 3.x argument-failure receipt on exit 2", async () => {
    // validate emits its argument error as an ok:false JSON receipt on stdout
    // with stage "arguments" and exits 2; runArchify must still surface it.
    const promise = runArchify(
      ["validate", "architecture", "in.json", "--bogus", "--json"],
      OPTIONS,
    );
    const receipt = JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: "validate",
      stage: "arguments",
      error: 'Unknown validate option "--bogus".',
      diagnostics: [
        {
          code: "arguments/unknown-option",
          severity: "error",
          message: 'Unknown validate option "--bogus".',
          supportedFixes: ["remove the unknown option and retry"],
        },
      ],
    });
    execCallback()(Object.assign(new Error("exit 2"), { code: 2 }), receipt, "");

    const result = await promise;
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a receipt");
    expect(result.receipt).toHaveProperty("ok", false);
    expect(result.receipt).toHaveProperty("stage", "arguments");
    expect(result.receipt.diagnostics[0]).toHaveProperty("code", "arguments/unknown-option");
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
    // archify 3.x rejects a non-.html CLI target upstream before rendering, so
    // the harness should never receive this stdout in practice. The existence
    // check is a version-independent safety net, so a claimed path that does
    // exist is still accepted rather than second-guessed here.
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

describe("runArchifyText", () => {
  beforeEach(() => {
    execFileMock.calls.length = 0;
    execFileMock.state.callback = null;
  });

  it("returns trimmed stdout text on a clean exit", async () => {
    const promise = runArchifyText(["guide", "--json"], OPTIONS);
    execCallback()(null, '{\n  "ok": true\n}\n', "");

    const result = await promise;
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a text result");
    expect(result.text).toBe('{\n  "ok": true\n}');
  });

  it("returns a placeholder when a clean exit produced no stdout", async () => {
    const promise = runArchifyText(["examples"], OPTIONS);
    execCallback()(null, "   \n", "");

    const result = await promise;
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a text result");
    expect(result.text).toBe("(no output)");
  });

  it("prefers stdout over stderr on a non-zero exit", async () => {
    const promise = runArchifyText(["check", "out.html"], OPTIONS);
    execCallback()(Object.assign(new Error("exit 1"), { code: 1 }), '{"ok":false}', "boom");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toBe('{"ok":false}');
  });

  it("falls back to the first stderr line when stdout is empty", async () => {
    const promise = runArchifyText(["inspect", "architecture", "in.json"], OPTIONS);
    execCallback()(Object.assign(new Error("exit 1"), { code: 1 }), "", "Error: not found\nmore");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toBe("Error: not found");
  });

  it("surfaces ENOENT from the exec error", async () => {
    const promise = runArchifyText(["guide"], OPTIONS);
    execCallback()(Object.assign(new Error("spawn archify ENOENT"), { code: "ENOENT" }), "", "");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("ENOENT");
  });

  it("treats a signal-only termination (no killed flag) as a failure", async () => {
    const promise = runArchifyText(["guide"], OPTIONS);
    // A signal without killed:true (e.g. an external kill before the timeout
    // path) must still be an interruption, so partial stdout is pre-empted.
    execCallback()(
      Object.assign(new Error("Command failed"), { signal: "SIGSEGV" }),
      "partial",
      "",
    );

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("terminated by signal SIGSEGV");
  });

  it("ignores an empty signal string (not an interruption) and keeps stdout as the failure", async () => {
    const promise = runArchifyText(["check", "out.html"], OPTIONS);
    execCallback()(
      Object.assign(new Error("exit 1"), { code: 1, signal: "" }),
      '{"ok":false}',
      "boom",
    );

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toBe('{"ok":false}');
  });

  it("falls back to stderr when a non-zero exit produced only whitespace stdout", async () => {
    const promise = runArchifyText(["inspect", "architecture", "in.json"], OPTIONS);
    execCallback()(Object.assign(new Error("exit 1"), { code: 1 }), "   \n", "Error: bad IR");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toBe("Error: bad IR");
  });

  it("falls back to the exec error message when stdout and stderr are both blank", async () => {
    const promise = runArchifyText(["guide"], OPTIONS);
    execCallback()(Object.assign(new Error("Command failed"), { code: 1 }), "  \t", "");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toBe("Command failed");
  });

  it("falls back to a generic message when stdout, stderr, and the error message are all blank", async () => {
    const promise = runArchifyText(["guide"], OPTIONS);
    execCallback()(new Error(""), "", "");

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toBe("archify command failed");
  });

  it("treats a killed child as a failure even with stdout", async () => {
    const promise = runArchifyText(["guide"], OPTIONS);
    execCallback()(
      Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }),
      "partial",
      "",
    );

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("killed");
  });

  it("treats a buffer overflow as a failure", async () => {
    const promise = runArchifyText(["inspect", "architecture", "in.json"], OPTIONS);
    execCallback()(
      Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
      "partial",
      "",
    );

    const result = await promise;
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("buffer");
  });

  it("injects ARCHIFY_UPDATE_CHECK_DISABLED, like runArchify", async () => {
    const promise = runArchifyText(["guide"], OPTIONS);
    execCallback()(null, "{}", "");
    await promise;

    expect(execFileMock.calls).toHaveLength(1);
    expect(execFileMock.calls[0]).toHaveProperty("file", "archify");
    expect(execFileMock.calls[0]?.options.env).toHaveProperty("ARCHIFY_UPDATE_CHECK_DISABLED", "1");
  });
});
