/**
 * Tests for the truncation note `belayd_outline` appends to its output.
 *
 * Both truncation causes — file cap and walk cap — are driven by mocking only
 * `resolveOutlineTargets` (the real formatter/validator still run) so neither
 * note needs 50k directory entries or 201 source files to reach. This is the
 * end-to-end seam for the wording fixed in bd-115: a walk-capped result must
 * not claim a true "matched N files" total it never computed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineTargetResolution } from "../outline.js";
import { OUTLINE_MAX_OUTPUT_BYTES } from "../outline.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-test-model-cooldowns.json");

const mockResolveOutlineTargets = vi.hoisted(() => vi.fn());

// Partial-extraction notes the mocked extractor reports back, so the tool's
// note ordering and budget can be exercised without a real ctags timeout.
const mockExtractionNotes = vi.hoisted(() => ({ current: [] as string[] }));

// Extraction spawns ctags/ast-grep; stub it so the truncation-note wording is
// tested without depending on either binary being on PATH.
const mockExtractOutlineSymbols = vi.hoisted(() =>
  vi.fn((files: readonly string[]) => ({
    ok: true as const,
    files: files.map((path) => ({
      path,
      lineCount: 1,
      symbols: [
        { name: "alpha", kind: "function" as const, startLine: 1, endLine: 1, exported: true },
      ],
    })),
    ...(mockExtractionNotes.current.length > 0 ? { notes: [...mockExtractionNotes.current] } : {}),
  })),
);

vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  return {
    ...actual,
    resolveOutlineTargets: mockResolveOutlineTargets,
    extractOutlineSymbols: mockExtractOutlineSymbols,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const ok = (
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    callback(null, "", "");
    return { stdin: undefined };
  };
  return { ...actual, exec: vi.fn(), execFile: vi.fn(ok) };
});

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

async function runOutlineTool(cwd: string): Promise<string> {
  const mod = await import("../../extensions/index.js");
  const register = mod.default as (pi: ExtensionAPI) => void;
  const mock = createMockPi();
  register(mock.api);
  const tool = mock.tools.get("belayd_outline");
  if (tool === undefined) throw new Error("belayd_outline was not registered");

  const result = await tool.execute("notes", { path: "." }, undefined, undefined, { cwd });
  expect(result.details.exitCode).toBe(0);
  return result.content[0]?.text ?? "";
}

describe("belayd_outline truncation notes", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-outline-notes-"));
    writeFileSync(join(cwd, "a.ts"), "export function alpha() {}\n");
    mockResolveOutlineTargets.mockReset();
    mockExtractionNotes.current = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reports the true match count for a file-cap truncation", async () => {
    mockResolveOutlineTargets.mockReturnValue({
      ok: true,
      files: [join(cwd, "a.ts")],
      truncated: true,
      truncatedBy: "file-cap",
      totalMatches: 512,
    } satisfies OutlineTargetResolution);

    const text = await runOutlineTool(cwd);
    expect(text).toContain("note: matched 512 files; showing the first 1.");
  });

  it("prints the walk-cap note and never the file-cap wording", async () => {
    mockResolveOutlineTargets.mockReturnValue({
      ok: true,
      files: [join(cwd, "a.ts")],
      truncated: true,
      truncatedBy: "walk-cap",
    } satisfies OutlineTargetResolution);

    const text = await runOutlineTool(cwd);
    expect(text).toContain("note: walk stopped at the entry cap; results may be incomplete.");
    expect(text).not.toContain("matched");
  });

  it("appends no note when the resolution is complete", async () => {
    mockResolveOutlineTargets.mockReturnValue({
      ok: true,
      files: [join(cwd, "a.ts")],
      truncated: false,
    } satisfies OutlineTargetResolution);

    const text = await runOutlineTool(cwd);
    expect(text).toContain("alpha");
    expect(text).not.toContain("note:");
  });

  it("renders a partial-extraction note once, after the truncation note, inside the budget", async () => {
    mockResolveOutlineTargets.mockReturnValue({
      ok: true,
      files: [join(cwd, "a.ts")],
      truncated: true,
      truncatedBy: "file-cap",
      totalMatches: 3,
    } satisfies OutlineTargetResolution);
    mockExtractionNotes.current = [
      "note: ctags timed out before completing; the outline lists only the symbols recovered from its partial output.",
    ];

    const text = await runOutlineTool(cwd);
    const partialIndex = text.indexOf("note: ctags timed out");
    const truncationIndex = text.indexOf("note: matched 3 files");
    expect(partialIndex).toBeGreaterThan(-1);
    expect(truncationIndex).toBeGreaterThan(-1);
    expect(partialIndex).toBeGreaterThan(truncationIndex);
    expect(text.split("note: ctags timed out").length - 1).toBe(1);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(OUTLINE_MAX_OUTPUT_BYTES);
  });
});
