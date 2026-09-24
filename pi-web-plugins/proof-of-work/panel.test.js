import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Plain-JS vitest coverage for the proof-of-work panel helpers.
 *
 * panel.js defines a custom element that extends HTMLElement at module scope,
 * so Node needs the browser globals referenced during module evaluation.
 * `HTMLElement` is read while the class body is created; `customElements` is
 * stubbed too so defineProofPanelElement() stays callable from future tests.
 * window/document are only touched inside methods, never at import time.
 */
vi.stubGlobal("HTMLElement", class {});
vi.stubGlobal("customElements", {
  get: () => undefined,
  define: () => {},
});

const { showTraceCommand } = await import("./panel.js");

afterAll(() => {
  // Drop the stubbed module from the registry so other test files re-evaluate
  // panel.js with their own globals instead of inheriting the cached class.
  vi.resetModules();
  vi.unstubAllGlobals();
});

/** Validate a shell command's syntax by piping it to `bash -n` on stdin. */
function bashSyntaxError(command) {
  const result = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
  if (result.error) return String(result.error);
  return result.status === 0 ? undefined : (result.stderr ?? "").trim();
}

/** `bash -n` is a dev-host dependency; skip the syntax checks where it is absent. */
const bashAvailable = spawnSync("bash", ["--version"], { encoding: "utf8" }).error === undefined;

describe("showTraceCommand", () => {
  const tracePath = "/abs/proof-of-work/bd-63/trace.zip";

  it("escapes the find parentheses so bash groups them", () => {
    const command = showTraceCommand({ port: 9323, tracePath });

    // These assert the runtime string, not the source template literal: each
    // grouping paren find uses must carry one literal backslash. The pre-fix
    // template literal collapsed `\(` to `(`, so bash aborted before running.
    expect(command).toContain("find . \\(");
    expect(command).toContain("\\) -prune");
    expect(command).toContain("\\( -type f -o -type l \\)");
    expect(command).toContain('TRACE="/abs/proof-of-work/bd-63/trace.zip"');
    expect(command).toContain("PORT=9323");
  });

  it.skipIf(!bashAvailable)("is valid bash syntax (bash -n)", () => {
    expect(bashSyntaxError(showTraceCommand({ port: 9323, tracePath }))).toBeUndefined();
  });

  it.skipIf(!bashAvailable)("quotes the trace path so the shell cannot expand it", () => {
    const command = showTraceCommand({ port: 9323, tracePath: "/a b/$(whoami)/x.zip" });

    expect(command).toContain('TRACE="/a b/\\$(whoami)/x.zip"');
    expect(command).not.toContain('TRACE="/a b/$(whoami)/x.zip"');
    expect(bashSyntaxError(command)).toBeUndefined();
  });
});
