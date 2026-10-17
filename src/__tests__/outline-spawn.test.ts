/**
 * Failure-path coverage for the outline spawn seam.
 *
 * Everything here is binary-independent: the "missing binary" cases point an
 * env override at a path that cannot exist, and the exit/timeout cases use
 * tiny executable shell scripts. The spawn wrapper must always resolve to a
 * value — a rejection must never escape into the tool.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAstGrep } from "../outline-ast-grep.js";
import { runCtags } from "../outline-ctags.js";

const CTAGS_TAG =
  '{"_type":"tag","name":"alpha","path":"/w/a.ts","pattern":"/^export function alpha() {$/","line":1,"kind":"function"}';
const AST_GREP_MATCH =
  '{"text":"export function alpha() {}","range":{"start":{"line":0,"column":0},"end":{"line":2,"column":1}},"file":"/w/a.ts","lines":"export function alpha() {}","metaVariables":{"single":{"FUNCTION":{"text":"alpha"}}}}';

describe("outline spawn failure paths", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "belayd-outline-spawn-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeScript(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  describe("missing binary", () => {
    it("returns an error value naming the ctags binary and its override", async () => {
      const result = await runCtags(["/w/a.ts"], {
        env: { BELAYD_CTAGS_BIN: "/nonexistent/ctags" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("/nonexistent/ctags");
      expect(result.error).toContain("BELAYD_CTAGS_BIN");
    });

    it("returns an error value naming the ast-grep binary and its override", async () => {
      const result = await runAstGrep(["/w/a.ts"], {
        env: { BELAYD_AST_GREP_BIN: "/nonexistent/ast-grep" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("/nonexistent/ast-grep");
      expect(result.error).toContain("BELAYD_AST_GREP_BIN");
    });
  });

  describe("non-zero exit with parseable partial stdout", () => {
    it("recovers ctags symbols and annotates the degraded result", async () => {
      const script = writeScript("fake-ctags", `printf '%s\\n' '${CTAGS_TAG}'\nexit 1`);
      const result = await runCtags(["/w/a.ts"], { env: { BELAYD_CTAGS_BIN: script } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.groups.flatMap((group) => group.symbols).map((symbol) => symbol.name),
      ).toContain("alpha");
      expect(result.note).toContain("partial output");
    });

    it("recovers ast-grep symbols and annotates the degraded result", async () => {
      const script = writeScript("fake-ast-grep", `printf '%s\\n' '${AST_GREP_MATCH}'\nexit 1`);
      const result = await runAstGrep(["/w/a.ts"], { env: { BELAYD_AST_GREP_BIN: script } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.groups.flatMap((group) => group.symbols).map((symbol) => symbol.name),
      ).toContain("alpha");
      expect(result.note).toContain("partial output");
    });
  });

  describe("failure with unusable stdout", () => {
    it("hard-fails ctags when the partial output parses to nothing", async () => {
      const script = writeScript("garbage-ctags", "echo this is not json\nexit 1");
      const result = await runCtags(["/w/a.ts"], { env: { BELAYD_CTAGS_BIN: script } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("Cannot run");
    });

    it("hard-fails ast-grep when the partial output parses to nothing", async () => {
      const script = writeScript("garbage-ast-grep", "echo this is not json\nexit 1");
      const result = await runAstGrep(["/w/a.ts"], { env: { BELAYD_AST_GREP_BIN: script } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("Cannot run");
    });
  });

  describe("later language group hard-fails", () => {
    it("keeps symbols from an earlier group and annotates the degradation", async () => {
      // The ts group (`sample.ts`) emits a match; the js group (`sample.cjs`)
      // fails with no parseable output. The ts symbol must survive.
      const script = writeScript(
        "split-ast-grep",
        `case "$*" in\n  *JavaScript*) echo 'this is not json'; exit 1;;\n  *) printf '%s\\n' '${AST_GREP_MATCH}'; exit 0;;\nesac`,
      );
      const result = await runAstGrep(["/w/a.ts", "/w/a.cjs"], {
        env: { BELAYD_AST_GREP_BIN: script },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.groups.flatMap((group) => group.symbols).map((symbol) => symbol.name),
      ).toContain("alpha");
      expect(result.note).toContain("returned no usable output");
    });
  });

  describe("timeout", () => {
    it("reports ctags as a timeout with the effective cap, not a generic command failure", async () => {
      const script = writeScript("slow-ctags", "sleep 5");
      const startedAt = Date.now();
      const result = await runCtags(["/w/a.ts"], {
        env: { BELAYD_CTAGS_BIN: script },
        timeoutInMs: 50,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("timed out");
      expect(result.error).toContain("50 ms");
      expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    it("reports ast-grep as a timeout with the effective cap, not a generic command failure", async () => {
      const script = writeScript("slow-ast-grep", "sleep 5");
      const startedAt = Date.now();
      const result = await runAstGrep(["/w/a.ts"], {
        env: { BELAYD_AST_GREP_BIN: script },
        timeoutInMs: 50,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("timed out");
      expect(result.error).toContain("50 ms");
      expect(Date.now() - startedAt).toBeLessThan(2000);
    });
  });

  describe("signal death", () => {
    it("reports a SIGSEGV as killed by SIGSEGV, never as a timeout", async () => {
      const script = writeScript("segv-ctags", "kill -SEGV $$");
      const result = await runCtags(["/w/a.ts"], {
        env: { BELAYD_CTAGS_BIN: script },
        timeoutInMs: 4321,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("killed by SIGSEGV");
      expect(result.error).not.toContain("timed out");
      expect(result.error).not.toContain("4321 ms");
    });

    it("reports a SIGKILL (e.g. OOM) as killed by SIGKILL, never as a timeout", async () => {
      const script = writeScript("kill-ast-grep", "kill -KILL $$");
      const result = await runAstGrep(["/w/a.ts"], {
        env: { BELAYD_AST_GREP_BIN: script },
        timeoutInMs: 4321,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("killed by SIGKILL");
      expect(result.error).not.toContain("timed out");
      expect(result.error).not.toContain("4321 ms");
    });
  });
});
