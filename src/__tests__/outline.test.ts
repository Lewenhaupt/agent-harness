import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { OutlineResult, OutlineSymbol } from "../outline.js";
import {
  formatOutline,
  OUTLINE_MAX_FILES,
  OUTLINE_MAX_OUTPUT_BYTES,
  outlineFiles,
  outlineSource,
  resolveOutlineTargets,
} from "../outline.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function lines(...parts: string[]): string {
  return parts.join("\n");
}

describe("outlineSource", () => {
  it("detects top-level exported and non-exported declarations with line ranges", () => {
    const source = lines(
      "export function alpha(a: string): number {",
      "  return a.length;",
      "}",
      "",
      "const beta = 7;",
      "",
      "export class Gamma {",
      "  method() {",
      "    const nested = 1;",
      "    return nested;",
      "  }",
      "}",
      "",
      "export interface Delta {",
      "  value: number;",
      "}",
      "",
      'export type Epsilon = "a" | "b";',
      "",
      "export enum Zeta {",
      "  One,",
      "}",
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine, s.exported])).toEqual([
      ["alpha", "function", 1, 3, true],
      ["beta", "const", 5, 5, false],
      ["Gamma", "class", 7, 12, true],
      ["Delta", "interface", 14, 16, true],
      ["Epsilon", "type", 18, 18, true],
      ["Zeta", "enum", 20, 22, true],
    ]);
  });

  it("excludes nested helpers declared inside a function body", () => {
    const source = lines(
      "export function outer() {",
      "  function inner() {",
      "    return 1;",
      "  }",
      "  const local = 2;",
      "  return inner() + local;",
      "}",
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => s.name)).toEqual(["outer"]);
    expect(symbols[0]?.endLine).toBe(7);
  });

  it("excludes a nested let at depth > 0", () => {
    const source = lines(
      "export function outer() {",
      "  let counter = 0;",
      "  return counter;",
      "}",
      "let top = 1;",
    );

    expect(outlineSource(source).map((s) => s.name)).toEqual(["outer", "top"]);
  });

  it("emits pi registrations inside a plugin entry function but excludes nested declarations", () => {
    const source = lines(
      "export default function plugin(pi) {",
      "  function helper() {}",
      "  pi.registerTool({",
      '    name: "belayd_x",',
      "  });",
      "}",
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine])).toEqual([
      ["plugin", "function", 1, 6],
      ["belayd_x", "registerTool", 3, 5],
    ]);
  });

  it("detects pi.registerTool and pi.on with string-literal names", () => {
    const source = lines(
      "pi.registerTool({",
      '  name: "belayd_x",',
      "  async execute() {},",
      "});",
      "",
      'pi.on("tool_call", () => {});',
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine, s.detail])).toEqual([
      ["belayd_x", "registerTool", 1, 4, "pi.registerTool"],
      ["tool_call", "on", 6, 6, "pi.on"],
    ]);
  });

  it("falls back to a line-based name when a registration name cannot be extracted", () => {
    const source = lines("pi.registerTool({", "  label: nope,", "});");
    const symbols = outlineSource(source);
    expect(symbols[0]?.name).toBe("registerTool@1");
  });

  it("does not let braces inside strings, templates, or comments corrupt depth", () => {
    const source = lines(
      'export const tricky = "}";',
      "export const template = `{`;",
      "// } </div> comment",
      "/* { unbalanced */",
      "export function after() {}",
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine])).toEqual([
      ["tricky", "const", 1, 1],
      ["template", "const", 2, 2],
      ["after", "function", 5, 5],
    ]);
  });

  it("does not let regex literals containing quotes/backticks/braces corrupt the lexer", () => {
    const source = lines(
      "const reQuotes = /[\"'`]/g;",
      "const reBraces = /[{}()]/;",
      "const reClose = /}/;",
      "export function after() {}",
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ["reQuotes", 1, 1],
      ["reBraces", 2, 2],
      ["reClose", 3, 3],
      ["after", 4, 4],
    ]);
  });

  it("keeps division after identifiers/strings and allows regex after a keyword or operator", () => {
    const source = lines(
      "const ratio = total / count;",
      "const doubled = ratio / 2;",
      'const match = "a" / 2;',
      "function scan() {",
      "  return /a\\/b/.test(source);",
      "}",
      "const computed = a + /b/.source;",
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => s.name)).toEqual(["ratio", "doubled", "match", "scan", "computed"]);
    expect(symbols[3]?.endLine).toBe(6);
  });

  it("does not treat a `/` after `}` as a regex", () => {
    const source = lines("function f() {", "  return {} / value;", "}", "const after = 1;");

    expect(outlineSource(source).map((s) => s.name)).toEqual(["f", "after"]);
  });

  it("does not read a JSX closing tag as a regex", () => {
    const source = lines("export const B = () => <div>v</div>;", "export const tail = 1;");
    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ["B", 1, 1],
      ["tail", 2, 2],
    ]);
  });

  it("handles self-closing, nested, and fragment JSX tags without over-running", () => {
    const selfClosing = lines(
      "export function C() {",
      "  return <img src={x} />;",
      "}",
      "export const tail = 1;",
    );
    expect(outlineSource(selfClosing).map((s) => [s.name, s.endLine])).toEqual([
      ["C", 3],
      ["tail", 4],
    ]);

    const nested = lines(
      "export const D = () => (",
      "  <div>",
      "    <span>{x}</span>",
      "  </div>",
      ");",
      "export const tail = 1;",
    );
    expect(outlineSource(nested).map((s) => [s.name, s.endLine])).toEqual([
      ["D", 5],
      ["tail", 6],
    ]);

    const fragment = lines("export const E = () => <>frag</>;", "export const tail = 1;");
    expect(outlineSource(fragment).map((s) => [s.name, s.endLine])).toEqual([
      ["E", 1],
      ["tail", 2],
    ]);
  });

  it("emits `export { default }` re-exports instead of dropping them", () => {
    const symbols = outlineSource('export { default } from "./m";');
    expect(symbols).toEqual([
      expect.objectContaining({
        kind: "export",
        name: "default",
        detail: "(default)",
        startLine: 1,
        endLine: 1,
      }),
    ]);
  });

  it("ends a multi-line signature at the closing brace and orders ascending", () => {
    const source = lines(
      "export function multiLine(",
      "  a: string,",
      "  b: number,",
      "): string {",
      "  return a + b;",
      "}",
      "export const tail = 1;",
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.startLine, s.endLine, s.name])).toEqual([
      [1, 6, "multiLine"],
      [7, 7, "tail"],
    ]);
  });

  it("handles inline object type literals in params without ending the declaration early", () => {
    const source = lines(
      "export function withOptions(options: {",
      "  retries: number;",
      "}): void {",
      "  console.log(options);",
      "}",
      "export const tail = 1;",
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ["withOptions", 1, 5],
      ["tail", 6, 6],
    ]);
  });

  it("terminates an overload signature with an inline object return type", () => {
    const source = lines(
      "export function over(): { a: 1 };",
      "export function over(): { a: 1 } {",
      "  return { a: 1 };",
      "}",
      "export const tail = 1;",
    );

    expect(outlineSource(source).map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ["over", 1, 1],
      ["over", 2, 4],
      ["tail", 5, 5],
    ]);
  });

  it("handles a type alias whose union members contain inline object literals", () => {
    const source = lines(
      "export type Union =",
      '  | { kind: "a"; value: number }',
      '  | { kind: "b"; value: string };',
      "export const tail = 1;",
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ["Union", 1, 3],
      ["tail", 4, 4],
    ]);
  });

  it("surfaces export { … } / export type { … } re-exports by name", () => {
    const source = lines(
      'export type { Foo, Bar } from "./x";',
      "export {",
      "  Baz,",
      "  Qux,",
      '} from "./y";',
    );

    const symbols = outlineSource(source);
    expect(symbols.map((s) => [s.kind, s.name, s.startLine, s.endLine])).toEqual([
      ["export", "Foo, Bar", 1, 1],
      ["export", "Baz, Qux", 2, 5],
    ]);
  });

  it("does not emit anonymous destructuring declarations", () => {
    const source = lines(
      "export const { a, b } = obj;",
      "export const [c, d] = list;",
      "export const named = 1;",
    );

    expect(outlineSource(source).map((s) => s.name)).toEqual(["named"]);
  });

  it("handles an anonymous default export", () => {
    const source = lines("export default function () {", "  return 1;", "}");
    const symbols = outlineSource(source);
    expect(symbols[0]?.name).toBe("default");
    expect(symbols[0]?.detail).toBe("anonymous default export");
    expect(symbols[0]?.exported).toBe(true);
  });

  it("handles const enum as an enum body", () => {
    const source = lines("export const enum Mode {", "  A,", "}");
    expect(outlineSource(source).map((s) => [s.kind, s.name, s.endLine])).toEqual([
      ["enum", "Mode", 3],
    ]);
  });
});

describe("outlineSource against real repo files (parser-verified ranges)", () => {
  function symbolsFrom(relativePath: string): OutlineSymbol[] {
    return outlineSource(readFileSync(join(REPO_ROOT, relativePath), "utf8"));
  }

  function rangeOf(
    symbols: OutlineSymbol[],
    name: string,
  ): [number | undefined, number | undefined] {
    const found = symbols.find((s) => s.name === name);
    expect(found, name).toBeDefined();
    return [found?.startLine, found?.endLine];
  }

  it("matches the six cross-checked declaration ranges", () => {
    expect(rangeOf(symbolsFrom("src/agent-registry.ts"), "DEFAULT_AGENTS")).toEqual([531, 675]);
    expect(rangeOf(symbolsFrom("src/worktree.ts"), "setupWorktree")).toEqual([164, 213]);
    expect(rangeOf(symbolsFrom("extensions/index.ts"), "runFileCommand")).toEqual([233, 270]);
    expect(rangeOf(symbolsFrom("extensions/index.ts"), "PlanningTarget")).toEqual([185, 187]);
    expect(rangeOf(symbolsFrom("src/outline.ts"), "resolveSymbolName")).toEqual([795, 810]);
    expect(rangeOf(symbolsFrom("src/quality-gates.ts"), "unwrapShellWrapper")).toEqual([172, 180]);
  });

  it("ends inline object-literal return types at the real body close", () => {
    // Regression (bd-115 round 2): a `): { a: 1 } {` body-open was mistaken
    // for the return type's matching `}`, truncating the declaration mid-line.
    expect(rangeOf(symbolsFrom("src/process-gate.ts"), "checkToolAllowed")).toEqual([65, 101]);
    expect(rangeOf(symbolsFrom("src/process-gate.ts"), "checkToolOutsideOrder")).toEqual([
      108, 125,
    ]);
    expect(rangeOf(symbolsFrom("extensions/index.ts"), "evaluateToolCallGate")).toEqual([342, 383]);
    expect(rangeOf(symbolsFrom("extensions/index.ts"), "advancePastExistingEpoch")).toEqual([
      477, 504,
    ]);
    expect(rangeOf(symbolsFrom("extensions/index.ts"), "readOutlineSources")).toEqual([902, 915]);
    expect(rangeOf(symbolsFrom("extensions/index.ts"), "buildOutlineText")).toEqual([918, 942]);
    expect(rangeOf(symbolsFrom("src/outline.ts"), "applySymbolCap")).toEqual([941, 950]);
    expect(rangeOf(symbolsFrom("src/stack-rebase.ts"), "writeStackBase")).toEqual([91, 103]);
    expect(rangeOf(symbolsFrom("src/stack-rebase.ts"), "resolveStackChain")).toEqual([155, 192]);
    expect(rangeOf(symbolsFrom("src/stack-rebase.ts"), "planStackRebase")).toEqual([212, 237]);
    expect(rangeOf(symbolsFrom("src/spawn.ts"), "appendSystemPromptArgs")).toEqual([161, 192]);
    expect(rangeOf(symbolsFrom("src/archify.ts"), "countChecks")).toEqual([333, 344]);
  });

  it("still finds declarations past the regex literals in src/outline.ts", () => {
    // Regression: before regex-literal handling, the `["'\`]` patterns in this
    // file left the lexer opaque and dropped every declaration after them.
    const names = symbolsFrom("src/outline.ts").map((s) => s.name);
    for (const expected of [
      "outlineSource",
      "outlineFiles",
      "formatOutline",
      "resolveOutlineTargets",
      "detectDeclaration",
      "detectReExport",
      "findBodyEnd",
      "findStatementEnd",
      "findCallEnd",
      "scanSourceLines",
    ]) {
      expect(names, expected).toContain(expected);
    }
    expect(names).not.toContain("(anonymous)");
  });

  it("does not emit bogus anonymous re-export rows for src/index.ts", () => {
    const symbols = symbolsFrom("src/index.ts");
    expect(symbols.some((s) => s.name === "(anonymous)")).toBe(false);
    expect(symbols.filter((s) => s.kind === "export").length).toBeGreaterThan(0);
  });
});

describe("outlineFiles", () => {
  const files = [
    {
      path: "a.ts",
      source: lines(
        "export function alpha() {}",
        "export const beta = 1;",
        "export interface Gamma {",
        "  x: number;",
        "}",
      ),
    },
    { path: "b.ts", source: "export function delta() {}" },
  ];

  it("aggregates per-file symbols and line counts", () => {
    const result = outlineFiles(files);
    expect(result.totalSymbols).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.files.map((f) => [f.path, f.lineCount, f.symbols.length])).toEqual([
      ["a.ts", 5, 3],
      ["b.ts", 1, 1],
    ]);
  });

  it("filters by kind and case-insensitive name substring", () => {
    const filtered = outlineFiles(files, { kind: ["function"], nameMatches: "DELT" });
    expect(filtered.files[0]?.symbols).toEqual([]);
    expect(filtered.files[1]?.symbols.map((s) => s.name)).toEqual(["delta"]);
    expect(filtered.appliedFilters).toEqual({ kind: ["function"], nameMatches: "DELT" });
  });

  it("caps symbols across files and stops scanning further files", () => {
    const result = outlineFiles(files, { maxSymbols: 2 });
    expect(result.truncated).toBe(true);
    expect(result.totalSymbols).toBe(2);
    expect(result.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(result.files[0]?.symbols.map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("formats a bounded header/rows/footer summary", () => {
    const result = outlineFiles(files, { maxSymbols: 2 });
    const text = formatOutline(result);
    expect(text).toContain("a.ts (5 lines)");
    expect(text).toContain("1-1");
    expect(text).toContain("alpha [exported]");
    expect(text).toContain("note: symbol output truncated by maxSymbols");
  });

  it("bounds output by UTF-8 bytes and reserves the truncation footer", () => {
    const symbols: OutlineSymbol[] = Array.from({ length: 4000 }, (_, index) => ({
      name: `sym_${index}_${"é".repeat(8)}`,
      kind: "function",
      startLine: index + 1,
      endLine: index + 1,
      exported: false,
    }));
    const result: OutlineResult = {
      files: [{ path: "日本語/ファイル.ts", lineCount: 1, symbols }],
      totalSymbols: symbols.length,
      truncated: false,
      appliedFilters: {},
    };

    const text = formatOutline(result);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(OUTLINE_MAX_OUTPUT_BYTES);
    expect(text).toContain("output truncated at");
  });
});

describe("resolveOutlineTargets", () => {
  const roots: string[] = [];

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "belayd-outline-"));
    roots.push(root);
    return root;
  }

  function tempTree(): string {
    const root = tempRoot();
    mkdirSync(join(root, "sub"));
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "a.ts"), "export const a = 1;");
    writeFileSync(join(root, "b.tsx"), "export const b = 1;");
    writeFileSync(join(root, "c.txt"), "not typescript");
    writeFileSync(join(root, "sub", "d.ts"), "export const d = 1;");
    writeFileSync(join(root, "node_modules", "e.ts"), "export const e = 1;");
    writeFileSync(join(root, ".hidden", "f.ts"), "export const f = 1;");
    return root;
  }

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("walks a directory for .ts/.tsx, skipping node_modules and dot-directories", () => {
    const root = tempTree();
    const resolved = resolveOutlineTargets(root, ".");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.files.map((f) => f.slice(root.length + 1))).toEqual([
      "a.ts",
      "b.tsx",
      "sub/d.ts",
    ]);
  });

  it("distinguishes ** (recursive) from * (single segment)", () => {
    const root = tempTree();
    const deep = resolveOutlineTargets(root, "**/*.ts");
    const shallow = resolveOutlineTargets(root, "*.ts");
    expect(deep.ok).toBe(true);
    expect(shallow.ok).toBe(true);
    if (!deep.ok || !shallow.ok) return;
    expect(deep.files.map((f) => f.slice(root.length + 1))).toEqual(["a.ts", "sub/d.ts"]);
    expect(shallow.files.map((f) => f.slice(root.length + 1))).toEqual(["a.ts"]);
  });

  it("resolves a single file and reports a missing path as an error value", () => {
    const root = tempTree();
    const file = resolveOutlineTargets(root, "a.ts");
    expect(file).toMatchObject({ ok: true, truncated: false });
    if (file.ok) expect(file.files).toEqual([join(root, "a.ts")]);

    expect(resolveOutlineTargets(root, "missing.ts")).toEqual({
      ok: false,
      error: "No such file or directory: missing.ts",
    });
  });

  it("rejects a non-TS single file with a clear error", () => {
    const root = tempTree();
    const resolved = resolveOutlineTargets(root, "c.txt");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("Unsupported file extension");
    expect(resolved.error).toContain(".ts");
  });

  it("resolves absolute and outside-cwd targets", () => {
    const cwd = tempRoot();
    const other = tempTree();
    const resolved = resolveOutlineTargets(cwd, join(other, "a.ts"));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.files).toEqual([join(other, "a.ts")]);
  });

  it("follows symlinked files and guards against symlink directory loops", () => {
    const root = tempTree();
    symlinkSync(join(root, "a.ts"), join(root, "link.ts"));
    symlinkSync(root, join(root, "loop"), "dir");

    const resolved = resolveOutlineTargets(root, ".");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const relative = resolved.files.map((f) => f.slice(root.length + 1));
    expect(relative).toContain("link.ts");
    expect(relative.length).toBeLessThan(20);
  });

  it("collapses star runs in a glob (no runaway regex)", () => {
    const root = tempTree();
    // `***` collapses to one `(?:.*/)?` group and still matches.
    const resolved = resolveOutlineTargets(root, "sub/***/d.ts");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.files.map((f) => f.slice(root.length + 1))).toEqual(["sub/d.ts"]);
    }

    // A long run must not throw/hang.
    expect(resolveOutlineTargets(root, "a************b.ts").ok).toBe(false);
  });

  it("walks .tsx files without JSX over-runs", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "Comp.tsx"),
      lines("export const B = () => <div>v</div>;", "export const tail = 1;"),
    );
    const resolved = resolveOutlineTargets(root, ".");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.files.map((f) => f.slice(root.length + 1))).toEqual(["Comp.tsx"]);

    const files = resolved.files.map((path) => ({ path, source: readFileSync(path, "utf8") }));
    const result = outlineFiles(files);
    expect(result.files[0]?.symbols.map((s) => [s.name, s.endLine])).toEqual([
      ["B", 1],
      ["tail", 2],
    ]);
  });

  it("returns an error for a glob with no matches", () => {
    const root = tempTree();
    const resolved = resolveOutlineTargets(root, "sub/**/*.js");
    expect(resolved).toEqual({ ok: false, error: "No matching TypeScript files found." });
  });

  it("stops a directory walk at the injectable entry cap and reports the walk-cap cause", () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.ts"), "export const a = 1;");
    writeFileSync(join(root, "b.ts"), "export const b = 1;");
    writeFileSync(join(root, "c.ts"), "export const c = 1;");

    const resolved = resolveOutlineTargets(root, ".", { maxWalkEntries: 2 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.truncated).toBe(true);
    // A capped walk cannot know the true match count, so it must not claim one.
    expect(resolved.truncatedBy).toBe("walk-cap");
    expect(resolved.totalMatches).toBeUndefined();
    expect(resolved.files.length).toBeGreaterThan(0);
    expect(resolved.files.length).toBeLessThan(3);
  });

  it("applies the injectable entry cap to glob walks as well", () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.ts"), "export const a = 1;");
    writeFileSync(join(root, "b.ts"), "export const b = 1;");
    writeFileSync(join(root, "c.ts"), "export const c = 1;");

    const resolved = resolveOutlineTargets(root, "**/*.ts", { maxWalkEntries: 2 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved).toMatchObject({ truncated: true, truncatedBy: "walk-cap" });
    expect(resolved.files.length).toBeLessThan(3);
  });

  it("reports the file-cap cause with the true match count when more than OUTLINE_MAX_FILES match", () => {
    const root = tempRoot();
    const total = OUTLINE_MAX_FILES + 1;
    for (let index = 0; index < total; index++) {
      writeFileSync(join(root, `f${String(index).padStart(4, "0")}.ts`), "export const x = 1;");
    }

    const resolved = resolveOutlineTargets(root, ".");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.files.length).toBe(OUTLINE_MAX_FILES);
    expect(resolved.truncated).toBe(true);
    expect(resolved.truncatedBy).toBe("file-cap");
    expect(resolved.totalMatches).toBe(total);
  });

  it("lets the walk cap take precedence when both caps trigger", () => {
    const root = tempRoot();
    const total = OUTLINE_MAX_FILES + 5;
    for (let index = 0; index < total; index++) {
      writeFileSync(join(root, `g${String(index).padStart(4, "0")}.ts`), "export const x = 1;");
    }

    // The cap stops before every file is visited, leaving more than
    // OUTLINE_MAX_FILES collected — both the walk and file caps are hit.
    const resolved = resolveOutlineTargets(root, ".", { maxWalkEntries: total - 2 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.files.length).toBe(OUTLINE_MAX_FILES);
    expect(resolved.truncatedBy).toBe("walk-cap");
    expect(resolved.totalMatches).toBeUndefined();
  });
});
