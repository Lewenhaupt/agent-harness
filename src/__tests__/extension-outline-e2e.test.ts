/**
 * End-to-end `belayd_outline` coverage with the real ctags/ast-grep binaries.
 *
 * The other extension-outline tests mock `extractOutlineSymbols` so they run
 * without a CLI. This file deliberately does not mock anything: it drives the
 * registered tool handler through the real resolver + extractors, so the text
 * under test comes from actual parser output rather than a fixture the mock
 * echoed back. It skips the success case in a bare shell (no `ctags`) and runs
 * for real under `nix develop -c`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findExecutableOnPath } from "../outline-binary.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

const hasCtags = findExecutableOnPath("ctags", process.env.PATH) !== undefined;

interface OutlineToolResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number };
}

interface OutlineTool {
  name: string;
  execute: (...args: unknown[]) => Promise<OutlineToolResult>;
}

function createMockPi(): { api: ExtensionAPI; tools: Map<string, OutlineTool> } {
  const tools = new Map<string, OutlineTool>();
  const api = {
    registerTool: (def: OutlineTool) => {
      tools.set(def.name, def);
    },
    registerCommand: () => {},
    on: () => {},
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, tools };
}

async function runOutlineTool(
  cwd: string,
  params: Record<string, unknown>,
): Promise<OutlineToolResult> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const mock = createMockPi();
  register(mock.api);
  const tool = mock.tools.get("belayd_outline");
  if (tool === undefined) throw new Error("belayd_outline was not registered");
  return tool.execute("e2e", params, undefined, undefined, { cwd });
}

describe("belayd_outline real extraction (end-to-end)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-outline-e2e-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it.skipIf(!hasCtags)(
    "renders a real ctags symbol map and leaves the source byte-identical",
    async () => {
      const file = join(cwd, "lib.py");
      const source = [
        "class Foo:",
        "    def bar(self):",
        "        return 1",
        "",
        "def baz(x):",
        "    return x",
      ].join("\n");
      writeFileSync(file, source);

      const result = await runOutlineTool(cwd, { path: "lib.py" });
      expect(result.details.exitCode).toBe(0);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("lib.py (6 lines)");
      expect(text).toContain("class         Foo");
      expect(text).toContain("method        bar");
      expect(text).toContain("function      baz");
      expect(readFileSync(file, "utf8")).toBe(source);
    },
  );

  it("surfaces a missing ctags binary as clean error text, not a crash", async () => {
    const file = join(cwd, "lib.py");
    writeFileSync(file, "def baz():\n    return 1\n");
    const previous = process.env.BELAYD_CTAGS_BIN;
    process.env.BELAYD_CTAGS_BIN = "/nonexistent/ctags-bd-118";
    try {
      const result = await runOutlineTool(cwd, { path: "lib.py" });
      expect(result.details.exitCode).toBe(1);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain('Cannot run "/nonexistent/ctags-bd-118"');
      expect(text).toContain("not found");
      // A raw stack trace would carry a frame like `at Object.`; the tool must
      // render only the actionable one-liner.
      expect(text).not.toContain("at Object.");
    } finally {
      if (previous === undefined) delete process.env.BELAYD_CTAGS_BIN;
      else process.env.BELAYD_CTAGS_BIN = previous;
    }
  });

  it("rejects a missing path with clean text through the real handler", async () => {
    const result = await runOutlineTool(cwd, { path: "does-not-exist.ts" });
    expect(result.details.exitCode).toBe(1);
    expect(result.content[0]?.text ?? "").toContain("No such file");
  });
});
