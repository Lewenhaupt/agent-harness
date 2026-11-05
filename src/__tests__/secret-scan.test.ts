/**
 * Tests for the outbound text scan (bd-286).
 *
 * `node:child_process` is mocked at the module boundary (repo convention) so every
 * classification is exercised without a real `betterleaks`: a clean run, a hit
 * (exit 1), a hit whose report overflowed `maxBuffer` (which must NOT fail open),
 * a missing binary, and a non-hit error. The scan must never leak the match text
 * into its result, because the refusal message is itself posted somewhere.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type SecretScanWarnBudget,
  scanOutboundText,
  secretRefusalText,
  warnScanUnavailable,
} from "../secret-scan.js";

interface ExecFailure extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: string;
}

interface ExecHarness {
  fn: ReturnType<typeof vi.fn>;
  state: {
    error: ExecFailure | null;
    stdout: string;
    args: string[][];
    stdin: string[];
    /** Simulate `execFile` returning no stdin pipe (the defensive branch). */
    stdinNull: boolean;
  };
}

const scanner = vi.hoisted((): ExecHarness => {
  const state: ExecHarness["state"] = {
    error: null,
    stdout: "",
    args: [],
    stdin: [],
    stdinNull: false,
  };
  const fn = vi.fn(
    (
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: ExecFailure | null, stdout: string, stderr: string) => void,
    ) => {
      state.args.push([...args]);
      if (state.stdinNull) return { stdin: null };
      const childStdin = {
        on: () => {},
        end: (chunk?: string) => {
          state.stdin.push(chunk ?? "");
          callback(state.error, state.stdout, "");
        },
      };
      return { stdin: childStdin };
    },
  );
  return { fn, state };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) =>
      (scanner.fn as unknown as (...rest: unknown[]) => unknown)(...args),
  };
});

/** The scanner's exit-1 payload, as `-f json -r -` prints it (redacted). */
const HIT_REPORT = JSON.stringify([
  { RuleID: "github-pat", Match: "REDACTED", Secret: "REDACTED", StartLine: 1, EndLine: 1 },
  { RuleID: "generic-api-key", Match: "REDACTED", Secret: "REDACTED", StartLine: 3, EndLine: 3 },
]);

function reset(): void {
  scanner.state.error = null;
  scanner.state.stdout = "";
  scanner.state.args.length = 0;
  scanner.state.stdin.length = 0;
  scanner.state.stdinNull = false;
}

/** A failing spawn carrying the exit code / errno Node puts on the error. */
function execFailure(props: {
  code?: string | number | null;
  message: string;
  killed?: boolean;
  signal?: string;
}): ExecFailure {
  return Object.assign(new Error(props.message), props);
}

describe("scanOutboundText", () => {
  it("pipes the text through `betterleaks stdin` and reports a clean scan", async () => {
    reset();
    const result = await scanOutboundText({ text: "Looks good to me.", cwd: "/tmp/wt" });

    expect(result).toEqual({ ok: true });
    expect(scanner.state.args[0]).toEqual([
      "stdin",
      "--redact",
      "--no-banner",
      "--exit-code",
      "1",
      "-f",
      "json",
      "-r",
      "-",
    ]);
    // The body goes on stdin, never argv (it may contain anything).
    expect(scanner.state.stdin[0]).toBe("Looks good to me.");
  });

  it("refuses on a hit and names the rule ids only", async () => {
    reset();
    scanner.state.error = execFailure({ code: 1, message: "Command failed: betterleaks stdin" });
    scanner.state.stdout = HIT_REPORT;

    const result = await scanOutboundText({
      text: "token: ghp_example",
      cwd: "/tmp/wt",
    });

    expect(result).toEqual({ ok: false, rules: ["github-pat", "generic-api-key"] });
    // Rule ids only: the match/secret fields are dropped, so the refusal cannot
    // echo what it refused.
    expect(JSON.stringify(result)).not.toContain("REDACTED");
    expect(JSON.stringify(result)).not.toContain("ghp_example");
  });

  it("still refuses when a hit's report cannot be parsed, naming no rule", async () => {
    reset();
    scanner.state.error = execFailure({ code: 1, message: "Command failed: betterleaks stdin" });
    scanner.state.stdout = "not json";

    expect(await scanOutboundText({ text: "x", cwd: "/tmp/wt" })).toEqual({
      ok: false,
      rules: [],
    });
    // The exit code is the hit decision, so the post is refused; the message
    // falls back to "an unnamed rule".
    expect(secretRefusalText([])).toContain("an unnamed rule");
  });

  it("refuses when the report overflowed maxBuffer instead of failing open", async () => {
    reset();
    // A body dense with matches is exactly when the report is largest; Node
    // aborts the child with this code, never with the scanner's exit 1.
    scanner.state.error = execFailure({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      message: "stdout maxBuffer length exceeded",
    });
    scanner.state.stdout = HIT_REPORT.slice(0, 40);

    const result = await scanOutboundText({ text: "x".repeat(10), cwd: "/tmp/wt" });

    // The truncated report cannot be parsed, so the hit is refused with no rule
    // name — the important half is that it is a refusal, not `unavailable`.
    expect(result).toEqual({ ok: false, rules: [] });
  });

  it("treats a maxBuffer overflow reported only in the message as a hit too", async () => {
    reset();
    scanner.state.error = execFailure({ message: "Command failed: stdout maxBuffer exceeded" });

    const result = await scanOutboundText({ text: "x", cwd: "/tmp/wt" });

    expect(result).toEqual({ ok: false, rules: [] });
  });

  it("reports a missing binary as unavailable, never as a hit", async () => {
    reset();
    scanner.state.error = execFailure({ code: "ENOENT", message: "spawn betterleaks ENOENT" });

    const result = await scanOutboundText({ text: "x", cwd: "/tmp/wt" });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("unavailable");
    expect(result).not.toHaveProperty("rules");
  });

  it("treats a timeout as unavailable rather than a hit", async () => {
    reset();
    // Node's real timeout shape: the child is killed, `code` is null, and the
    // error carries `killed`/`signal`. It must read as unavailable (warn and
    // post): the repo gate is what enforces, so a slow machine cannot stop every
    // comment.
    scanner.state.error = execFailure({
      code: null,
      killed: true,
      signal: "SIGTERM",
      message: "Command failed: betterleaks stdin",
    });

    const result = await scanOutboundText({ text: "x", cwd: "/tmp/wt" });

    expect(result).toEqual({ ok: false, unavailable: "Command failed: betterleaks stdin" });
    expect(result).not.toHaveProperty("rules");
  });

  it("treats a timeout-reported ETIMEDOUT as unavailable too", async () => {
    reset();
    scanner.state.error = execFailure({
      code: "ETIMEDOUT",
      message: "Command failed: betterleaks stdin",
    });

    expect(await scanOutboundText({ text: "x", cwd: "/tmp/wt" })).toHaveProperty("unavailable");
  });

  it("reports unavailable when the child has no stdin pipe to write the body to", async () => {
    reset();
    scanner.state.stdinNull = true;

    const result = await scanOutboundText({ text: "x", cwd: "/tmp/wt" });

    expect(result).toEqual({ ok: false, unavailable: "stdin was not available to the scanner" });
  });

  it("treats any other non-hit exit as unavailable, never as clean", async () => {
    reset();
    scanner.state.error = execFailure({ code: 2, message: "betterleaks: invalid config" });

    const result = await scanOutboundText({ text: "x", cwd: "/tmp/wt" });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("unavailable");
  });
});

describe("warnScanUnavailable", () => {
  it("warns once per budget, not once per post", () => {
    const budget: SecretScanWarnBudget = {};
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnScanUnavailable({ budget, reason: "spawn betterleaks ENOENT" });
      warnScanUnavailable({ budget, reason: "spawn betterleaks ENOENT" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("outbound secret scan"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("betterleaks"));
      // The budget is caller-owned, so a new session warns again.
      warnScanUnavailable({ budget: {}, reason: "spawn betterleaks ENOENT" });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("carries the reason of the first failure and ignores later ones", () => {
    const budget: SecretScanWarnBudget = {};
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnScanUnavailable({ budget, reason: "spawn betterleaks ENOENT" });
      warnScanUnavailable({ budget, reason: "a different later failure" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn betterleaks ENOENT"));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("a different later failure"));
      expect(budget.secretScanWarned).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("secretRefusalText", () => {
  it("names the rules and tells the author to describe the location in prose", () => {
    const text = secretRefusalText(["github-pat"]);
    expect(text).toContain("refused to post");
    expect(text).toContain("github-pat");
    expect(text).toContain("name the location in prose");
  });
});
