/**
 * Unit tests for the pure `belayd_outline` layer.
 *
 * The ctags and ast-grep JSON parsers are driven by inline fixture strings —
 * no binaries, no mocks. Real-binary coverage (which skips when a CLI is
 * absent) lives in `outline-extract.test.ts`. Every lexer-behaviour case from
 * bd-115 was deleted rather than adapted, because the lexer no longer exists.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  OutlineFileSymbols,
  OutlineKind,
  OutlineSymbol,
  OutlineSymbolGroup,
} from "../outline.js";
import {
  formatOutline,
  isOutlineKind,
  mergeOutlineSymbols,
  OUTLINE_MAX_FILES,
  OUTLINE_MAX_OUTPUT_BYTES,
  outlineAstGrepLanguage,
  outlineFiles,
  resolveOutlineTargets,
} from "../outline.js";
import { buildAstGrepArgs, buildAstGrepRule, parseAstGrepJson } from "../outline-ast-grep.js";
import { buildCtagsArgs, mapCtagsKind, parseCtagsJson } from "../outline-ctags.js";

/** Compact symbol factory for merge/compose tests. */
function symbol(
  name: string,
  kind: OutlineKind,
  startLine: number,
  endLine: number,
  exported = false,
): OutlineSymbol {
  return { name, kind, startLine, endLine, exported };
}

function groupOf(
  groups: readonly OutlineSymbolGroup[],
  path: string,
): OutlineSymbolGroup | undefined {
  return groups.find((group) => group.path === path);
}

function namesOf(groups: readonly OutlineSymbolGroup[], path: string): string[] {
  return (groupOf(groups, path)?.symbols ?? []).map((entry) => entry.name);
}

describe("mapCtagsKind", () => {
  it("maps the universal kinds onto the outline vocabulary", () => {
    expect(mapCtagsKind("function", undefined)).toBe("function");
    expect(mapCtagsKind("func", undefined)).toBe("function");
    expect(mapCtagsKind("generator", undefined)).toBe("function");
    expect(mapCtagsKind("method", undefined)).toBe("method");
    expect(mapCtagsKind("class", undefined)).toBe("class");
    expect(mapCtagsKind("interface", undefined)).toBe("interface");
    expect(mapCtagsKind("alias", undefined)).toBe("type");
    expect(mapCtagsKind("constant", undefined)).toBe("const");
    expect(mapCtagsKind("variable", undefined)).toBe("var");
    expect(mapCtagsKind("enum", undefined)).toBe("enum");
    expect(mapCtagsKind("struct", undefined)).toBe("struct");
    expect(mapCtagsKind("union", undefined)).toBe("union");
    expect(mapCtagsKind("trait", undefined)).toBe("trait");
    expect(mapCtagsKind("namespace", undefined)).toBe("namespace");
    expect(mapCtagsKind("module", undefined)).toBe("module");
    expect(mapCtagsKind("macro", undefined)).toBe("macro");
    expect(mapCtagsKind("property", undefined)).toBe("property");
    expect(mapCtagsKind("field", undefined)).toBe("field");
  });

  it("disambiguates `member` by enclosing scope", () => {
    expect(mapCtagsKind("member", "class")).toBe("method");
    expect(mapCtagsKind("member", "implementation")).toBe("method");
    expect(mapCtagsKind("member", "trait")).toBe("method");
    expect(mapCtagsKind("member", "struct")).toBe("field");
    expect(mapCtagsKind("member", "package")).toBe("field");
    expect(mapCtagsKind("member", undefined)).toBe("field");
  });

  it("promotes a function-like declaration in a member scope to a method", () => {
    // C++ member functions, Go methods, and PHP trait methods are
    // `function`/`func` + a type scope.
    for (const scope of ["class", "struct", "union", "interface", "record", "trait"]) {
      expect(mapCtagsKind("function", scope), scope).toBe("method");
      expect(mapCtagsKind("func", scope), scope).toBe("method");
    }
    // A free declaration, or one nested in a namespace/package, stays a function.
    expect(mapCtagsKind("function", undefined)).toBe("function");
    expect(mapCtagsKind("func", "package")).toBe("function");
    expect(mapCtagsKind("function", "namespace")).toBe("function");
  });

  it("maps the audited per-language kinds onto the outline vocabulary", () => {
    expect(mapCtagsKind("singletonMethod", "class")).toBe("method");
    expect(mapCtagsKind("methodSpec", "interface")).toBe("method");
    expect(mapCtagsKind("const", "package")).toBe("const");
    expect(mapCtagsKind("define", "namespace")).toBe("const");
    expect(mapCtagsKind("talias", "package")).toBe("type");
    expect(mapCtagsKind("typealias", undefined)).toBe("type");
    expect(mapCtagsKind("accessor", "class")).toBe("property");
    expect(mapCtagsKind("getter", "class")).toBe("property");
    expect(mapCtagsKind("setter", "class")).toBe("property");
    expect(mapCtagsKind("event", "class")).toBe("property");
    expect(mapCtagsKind("anonMember", "struct")).toBe("field");
    expect(mapCtagsKind("RecordField", undefined)).toBe("field");
    expect(mapCtagsKind("object", undefined)).toBe("class");
    expect(mapCtagsKind("annotation", undefined)).toBe("interface");
    expect(mapCtagsKind("partition", undefined)).toBe("module");
    expect(mapCtagsKind("delegate", undefined)).toBe("function");
    expect(mapCtagsKind("guard", undefined)).toBe("function");
    expect(mapCtagsKind("operator", undefined)).toBe("function");
    expect(mapCtagsKind("record", undefined)).toBe("struct");
    expect(mapCtagsKind("protocol", undefined)).toBe("interface");
    expect(mapCtagsKind("val", undefined)).toBe("var");
  });

  it("drops unmapped kinds deterministically", () => {
    expect(mapCtagsKind("enumerator", "enum")).toBeUndefined();
    expect(mapCtagsKind("enumConstant", "enum")).toBeUndefined();
    expect(mapCtagsKind("package", undefined)).toBeUndefined();
    expect(mapCtagsKind("packageName", undefined)).toBeUndefined();
    expect(mapCtagsKind("implementation", undefined)).toBeUndefined();
    expect(mapCtagsKind("unknown", "module")).toBeUndefined();
    expect(mapCtagsKind("heredoc", undefined)).toBeUndefined();
    expect(mapCtagsKind("callback", undefined)).toBeUndefined();
    expect(mapCtagsKind("test", undefined)).toBeUndefined();
    expect(mapCtagsKind("exception", undefined)).toBeUndefined();
    expect(mapCtagsKind("constructor", undefined)).toBeUndefined();
    expect(mapCtagsKind("Constructor", undefined)).toBeUndefined();
    expect(mapCtagsKind("Exception", undefined)).toBeUndefined();
    expect(mapCtagsKind("totally-unknown", undefined)).toBeUndefined();
  });

  it("drops reference-only kinds the default ctags args never request", () => {
    // C/C++ `header` (#include), Ruby `library` (require), and Sh `script` are
    // enabled but REFONLY; `buildCtagsArgs` never passes `--extras=+r`, so these
    // cannot reach the parser. Pinned so a future `--extras` change cannot
    // silently surface them as declarations.
    expect(mapCtagsKind("header", undefined)).toBeUndefined();
    expect(mapCtagsKind("library", undefined)).toBeUndefined();
    expect(mapCtagsKind("script", undefined)).toBeUndefined();
  });
});

describe("parseCtagsJson", () => {
  const sampleTs = "/w/sample.ts";
  const samplePy = "/w/lib.py";

  const stdout = [
    JSON.stringify({
      _type: "tag",
      name: "alpha",
      path: sampleTs,
      pattern: "/^export function alpha(a: number): number {$/",
      line: 1,
      kind: "function",
    }),
    JSON.stringify({
      _type: "tag",
      name: "Beta",
      path: sampleTs,
      pattern: "/^interface Beta {$/",
      line: 5,
      kind: "interface",
    }),
    JSON.stringify({
      _type: "tag",
      name: "gamma",
      path: sampleTs,
      pattern: "/^const gamma = 1;$/",
      line: 6,
      kind: "constant",
    }),
    JSON.stringify({
      _type: "tag",
      name: "nested",
      path: sampleTs,
      pattern: "/^  const nested = 1;$/",
      line: 7,
      kind: "constant",
      scope: "alpha",
      scopeKind: "function",
    }),
    JSON.stringify({
      _type: "tag",
      name: "A",
      path: sampleTs,
      pattern: "/^enum E { A, B }$/",
      line: 8,
      kind: "enumerator",
      scope: "E",
      scopeKind: "enum",
    }),
    JSON.stringify({
      _type: "tag",
      name: "F",
      path: sampleTs,
      pattern: "/^struct F {$/",
      line: 9,
      kind: "struct",
      end: 12,
    }),
    JSON.stringify({
      _type: "tag",
      name: "lost",
      path: sampleTs,
      pattern: "/^const lost = 1;$/",
      line: 13,
      kind: "totally-unknown",
    }),
    JSON.stringify({
      _type: "tag",
      name: "bar",
      path: samplePy,
      pattern: "/^def bar(x):$/",
      line: 1,
      kind: "function",
      signature: "(x)",
      end: 3,
    }),
    JSON.stringify({
      _type: "tag",
      name: "Baz",
      path: samplePy,
      pattern: "/^class Baz:$/",
      line: 5,
      kind: "class",
      end: 9,
    }),
    JSON.stringify({
      _type: "tag",
      name: "m",
      path: samplePy,
      pattern: "/^    def m(self):$/",
      line: 6,
      kind: "member",
      scope: "Baz",
      scopeKind: "class",
      end: 8,
    }),
    "not json at all",
    JSON.stringify({ _type: "ptag", name: "!TAG_KIND_DESCRIPTION", path: "NONE" }),
  ].join("\n");

  it("groups tags by path and maps kinds", () => {
    const groups = parseCtagsJson(stdout);
    expect(groups.map((group) => group.path).sort()).toEqual([samplePy, sampleTs]);

    const ts = groupOf(groups, sampleTs);
    expect(ts?.symbols.map((entry) => [entry.name, entry.kind])).toEqual([
      ["alpha", "function"],
      ["Beta", "interface"],
      ["gamma", "const"],
      ["F", "struct"],
    ]);
  });

  it("marks exported declarations from the pattern's first source line", () => {
    const ts = groupOf(parseCtagsJson(stdout), sampleTs);
    expect(ts?.symbols.find((entry) => entry.name === "alpha")?.exported).toBe(true);
    expect(ts?.symbols.find((entry) => entry.name === "Beta")?.exported).toBe(false);
  });

  it("uses the end field when present and falls back to the start line", () => {
    const groups = parseCtagsJson(stdout);
    const tsF = groupOf(groups, sampleTs)?.symbols.find((entry) => entry.name === "F");
    expect(tsF?.startLine).toBe(9);
    expect(tsF?.endLine).toBe(12);

    const tsAlpha = groupOf(groups, sampleTs)?.symbols.find((entry) => entry.name === "alpha");
    expect(tsAlpha?.startLine).toBe(1);
    expect(tsAlpha?.endLine).toBe(1);
  });

  it("drops function-local, unknown-kind, malformed, and non-tag records", () => {
    const groups = parseCtagsJson(stdout);
    const names = namesOf(groups, sampleTs);
    expect(names).not.toContain("nested");
    expect(names).not.toContain("A");
    expect(names).not.toContain("lost");
  });

  it("maps a Python class method through the class scope", () => {
    const py = groupOf(parseCtagsJson(stdout), samplePy);
    expect(py?.symbols.map((entry) => [entry.name, entry.kind])).toEqual([
      ["bar", "function"],
      ["Baz", "class"],
      ["m", "method"],
    ]);
    expect(py?.symbols.find((entry) => entry.name === "bar")?.endLine).toBe(3);
  });

  it("drops a keyword-named declaration tag as destructuring noise", () => {
    const noise = [
      JSON.stringify({
        _type: "tag",
        name: "const",
        path: "/w/ab.tsx",
        pattern: "/^const { const: x } = obj;$/",
        line: 3,
        kind: "constant",
      }),
      JSON.stringify({
        _type: "tag",
        name: "x",
        path: "/w/ab.tsx",
        pattern: "/^const { const: x } = obj;$/",
        line: 3,
        kind: "constant",
      }),
    ].join("\n");
    expect(namesOf(parseCtagsJson(noise), "/w/ab.tsx")).toEqual(["x"]);
  });

  it("keeps keyword-named member tags (they are legal field/method names)", () => {
    const members = ["public", "static", "interface", "implements", "function", "with", "const"]
      .map((name, index) =>
        JSON.stringify({
          _type: "tag",
          name,
          path: "/w/access.ts",
          pattern: `/^  ${name} = 1;$/`,
          line: index + 2,
          kind: "property",
          scope: "Access",
          scopeKind: "class",
        }),
      )
      .join("\n");
    expect(namesOf(parseCtagsJson(members), "/w/access.ts")).toEqual([
      "public",
      "static",
      "interface",
      "implements",
      "function",
      "with",
      "const",
    ]);
  });

  it("drops ctags' anonymousObject object-literal holder tags", () => {
    const holder = JSON.stringify({
      _type: "tag",
      name: "anonymousObject3e2a7b710105",
      path: "/w/reg.cjs",
      pattern: '/^pi.registerTool({ name: "x", execute() {} });$/',
      line: 1,
      kind: "variable",
    });
    expect(parseCtagsJson(holder)).toEqual([]);
  });

  it("keeps a non-JS/TS tag whose name happens to be a JS keyword", () => {
    const python = JSON.stringify({
      _type: "tag",
      name: "type",
      path: "/w/lib.py",
      pattern: "/^def type():$/",
      line: 1,
      kind: "function",
    });
    expect(namesOf(parseCtagsJson(python), "/w/lib.py")).toEqual(["type"]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseCtagsJson("")).toEqual([]);
  });
});

describe("buildCtagsArgs", () => {
  it("adds language-map overrides for the extensions ctags does not map by default", () => {
    expect(buildCtagsArgs(["/w/a.ts", "/w/b.py"])).toEqual([
      "--output-format=json",
      "--fields=+neKS",
      "-f",
      "-",
      "--map-TypeScript=+.tsx",
      "--map-TypeScript=+.mts",
      "--map-TypeScript=+.cts",
      "--map-JavaScript=+.cjs",
      "/w/a.ts",
      "/w/b.py",
    ]);
  });
});

describe("parseAstGrepJson", () => {
  const stream = [
    JSON.stringify({
      text: "export function alpha(a: number): number {\n  return a + 1;\n}",
      range: { start: { line: 0, column: 7 }, end: { line: 3, column: 1 } },
      file: "/w/sample.ts",
      lines: "export function alpha(a: number): number {\n  return a + 1;\n}",
      metaVariables: { single: { FUNCTION: { text: "alpha" } } },
    }),
    JSON.stringify({
      text: "const arrow = (x: string) => x;",
      range: { start: { line: 4, column: 7 }, end: { line: 4, column: 38 } },
      file: "/w/sample.ts",
      lines: "export const arrow = (x: string) => x;",
      metaVariables: { single: { LEXICAL: { text: "arrow" } } },
    }),
    JSON.stringify({
      text: "let topLet = 2;",
      range: { start: { line: 5, column: 0 }, end: { line: 5, column: 14 } },
      file: "/w/sample.ts",
      lines: "let topLet = 2;",
      metaVariables: { single: { LEXICAL: { text: "topLet" } } },
    }),
    JSON.stringify({
      text: "const { x, y } = obj;",
      range: { start: { line: 6, column: 0 }, end: { line: 6, column: 20 } },
      file: "/w/sample.ts",
      lines: "const { x, y } = obj;",
      metaVariables: { single: { LEXICAL: { text: "{ x, y }" } } },
    }),
    JSON.stringify({
      text: 'pi.registerTool({ name: "belayd_outline", label: "x" })',
      range: { start: { line: 9, column: 2 }, end: { line: 9, column: 60 } },
      file: "/w/harness.ts",
      lines: '  pi.registerTool({ name: "belayd_outline", label: "x" });',
      metaVariables: { single: { REGISTER_TOOL: { text: '"belayd_outline"' } } },
    }),
    JSON.stringify({
      text: 'pi.on("tool_call", async (e) => {})',
      range: { start: { line: 10, column: 2 }, end: { line: 10, column: 37 } },
      file: "/w/harness.ts",
      lines: '  pi.on("tool_call", async (e) => {});',
      metaVariables: { single: { ON: { text: '"tool_call"' } } },
    }),
    JSON.stringify({
      text: "pi.on(eventName, handler)",
      range: { start: { line: 11, column: 2 }, end: { line: 11, column: 28 } },
      file: "/w/harness.ts",
      lines: "  pi.on(eventName, handler);",
      metaVariables: { single: { ON: { text: "eventName" } } },
    }),
    "{ this line is not valid json",
  ].join("\n");

  it("converts ast-grep's 0-based lines to 1-based inclusive ranges", () => {
    const ts = groupOf(parseAstGrepJson(stream), "/w/sample.ts");
    const alpha = ts?.symbols.find((entry) => entry.name === "alpha");
    expect(alpha).toMatchObject({ kind: "function", startLine: 1, endLine: 4, exported: true });
  });

  it("distinguishes const from let via the matched text", () => {
    const ts = groupOf(parseAstGrepJson(stream), "/w/sample.ts");
    expect(ts?.symbols.find((entry) => entry.name === "arrow")).toMatchObject({
      kind: "const",
      startLine: 5,
      endLine: 5,
      exported: true,
    });
    expect(ts?.symbols.find((entry) => entry.name === "topLet")).toMatchObject({
      kind: "let",
      startLine: 6,
      endLine: 6,
      exported: false,
    });
  });

  it("drops a destructuring capture that is not an identifier", () => {
    expect(namesOf(parseAstGrepJson(stream), "/w/sample.ts")).not.toContain("{ x, y }");
  });

  it("drops a keyword-named declaration capture but keeps keyword-named members", () => {
    const memberNames = [
      "public",
      "static",
      "interface",
      "implements",
      "function",
      "with",
      "const",
    ];
    const members = memberNames
      .map((name, index) =>
        JSON.stringify({
          text: `${name} = 1;`,
          range: { start: { line: index + 1, column: 2 }, end: { line: index + 1, column: 12 } },
          file: "/w/access.ts",
          lines: `  ${name} = 1;`,
          metaVariables: { single: { PROPERTY: { text: name } } },
        }),
      )
      .join("\n");
    expect(namesOf(parseAstGrepJson(members), "/w/access.ts")).toEqual(memberNames);

    const declarationNoise = JSON.stringify({
      text: "const =",
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 6 } },
      file: "/w/access.ts",
      lines: "const =",
      metaVariables: { single: { FUNCTION: { text: "const" } } },
    });
    expect(parseAstGrepJson(declarationNoise)).toEqual([]);
  });

  it("unquotes tool and event names and keeps identifiers", () => {
    const harness = groupOf(parseAstGrepJson(stream), "/w/harness.ts");
    expect(harness?.symbols.map((entry) => [entry.name, entry.kind])).toEqual([
      ["belayd_outline", "registerTool"],
      ["tool_call", "on"],
      ["eventName", "on"],
    ]);
  });

  it("skips malformed lines instead of aborting", () => {
    expect(parseAstGrepJson(stream).length).toBe(2);
    expect(parseAstGrepJson("").length).toBe(0);
  });
});

describe("buildAstGrepRule / buildAstGrepArgs", () => {
  it("selects the tree-sitter language and includes the registration branches", () => {
    expect(buildAstGrepRule("ts")).toContain("language: TypeScript");
    expect(buildAstGrepRule("tsx")).toContain("language: Tsx");
    expect(buildAstGrepRule("js")).toContain("language: JavaScript");
    expect(buildAstGrepRule("ts")).toContain("pi.registerTool");
    expect(buildAstGrepRule("ts")).toContain("pi.on($ON, $$$REST)");

    const args = buildAstGrepArgs("ts", ["/w/a.ts"]);
    expect(args.slice(0, 2)).toEqual(["scan", "--inline-rules"]);
    expect(args).toContain("--json=stream");
    expect(args.at(-1)).toBe("/w/a.ts");
  });
});

describe("mergeOutlineSymbols", () => {
  it("keeps ctags-only rows and lets ast-grep refine an end line", () => {
    const base = [symbol("alpha", "function", 1, 1, true), symbol("b", "const", 1, 1)];
    const extra = [symbol("alpha", "function", 1, 4, true)];
    const merged = mergeOutlineSymbols(base, extra);
    expect(merged.map((entry) => entry.name)).toEqual(["alpha", "b"]);
    expect(merged.find((entry) => entry.name === "alpha")?.endLine).toBe(4);
  });

  it("sorts ascending by start line then name", () => {
    const merged = mergeOutlineSymbols(
      [symbol("zeta", "function", 5, 5), symbol("beta", "const", 1, 1)],
      [symbol("alpha", "const", 1, 1)],
    );
    expect(merged.map((entry) => entry.name)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("collapses ctags' miskinded arrow-function and generator twins onto ast-grep", () => {
    const arrow = mergeOutlineSymbols(
      [symbol("arrow", "function", 1, 1)],
      [symbol("arrow", "const", 1, 1)],
    );
    expect(arrow).toEqual([symbol("arrow", "const", 1, 1)]);

    // ctags tags `function* Producer() {}` as `class`; ast-grep refines it to
    // `function` with the real range. The shared identity collapses the twin.
    const generator = mergeOutlineSymbols(
      [symbol("Producer", "class", 1, 1)],
      [symbol("Producer", "function", 1, 3)],
    );
    expect(generator).toEqual([symbol("Producer", "function", 1, 3)]);
  });

  it("keeps a property and a method with the same name on the same line", () => {
    const merged = mergeOutlineSymbols(
      [symbol("foo", "property", 1, 1)],
      [symbol("foo", "method", 1, 1)],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.kind)).toEqual(["method", "property"]);
  });

  it("keeps the const and registerTool captures of one assignment line", () => {
    const merged = mergeOutlineSymbols(
      [],
      [symbol("t", "registerTool", 1, 1), symbol("t", "const", 1, 1)],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.kind)).toEqual(["const", "registerTool"]);
  });

  it("still collapses a ctags `var` into the ast-grep `let` refinement", () => {
    const merged = mergeOutlineSymbols([symbol("x", "var", 3, 3)], [symbol("x", "let", 3, 3)]);
    expect(merged).toEqual([symbol("x", "let", 3, 3)]);
  });
});

describe("outlineFiles / formatOutline", () => {
  function file(path: string, lineCount: number, symbols: OutlineSymbol[]): OutlineFileSymbols {
    return { path, lineCount, symbols };
  }

  const files = [
    file("/w/a.ts", 3, [symbol("alpha", "function", 1, 3, true), symbol("Beta", "class", 4, 8)]),
    file("/w/b.py", 2, [symbol("gamma", "const", 1, 1)]),
  ];

  it("aggregates per-file symbols and line counts", () => {
    const result = outlineFiles(files);
    expect(result.totalSymbols).toBe(3);
    expect(result.files[0]).toMatchObject({ path: "/w/a.ts", lineCount: 3 });
    expect(result.truncated).toBe(false);
  });

  it("filters by kind and case-insensitive name substring", () => {
    const byKind = outlineFiles(files, { kind: ["class"] });
    expect(byKind.files[0]?.symbols.map((entry) => entry.name)).toEqual(["Beta"]);

    const byName = outlineFiles(files, { nameMatches: "ALPH" });
    expect(byName.files[0]?.symbols.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(byName.files[1]?.symbols).toEqual([]);
  });

  it("caps symbols globally and reports the truncation note", () => {
    const result = outlineFiles(files, { maxSymbols: 2 });
    expect(result.totalSymbols).toBe(2);
    expect(result.truncated).toBe(true);
    expect(formatOutline(result)).toContain("note: symbol output truncated by maxSymbols");
  });

  it("applies `name` + `maxSymbols` across files in file order and stops scanning early", () => {
    const multi = [
      file("/w/one.ts", 3, [
        symbol("alpha", "function", 1, 1),
        symbol("alpine", "function", 2, 2),
        symbol("beta", "function", 3, 3),
      ]),
      file("/w/two.ts", 3, [symbol("alarm", "function", 1, 1), symbol("amber", "function", 2, 2)]),
      file("/w/three.ts", 1, [symbol("azure", "function", 1, 1)]),
    ];

    // `al` matches alpha/alpine/alarm. The global cap of 3 is filled across
    // the first two files; `three.ts` is never scanned once the cap is hit.
    const result = outlineFiles(multi, { nameMatches: "al", maxSymbols: 3 });
    expect(result.files.map((entry) => entry.path)).toEqual(["/w/one.ts", "/w/two.ts"]);
    expect(result.files[0]?.symbols.map((entry) => entry.name)).toEqual(["alpha", "alpine"]);
    expect(result.files[1]?.symbols.map((entry) => entry.name)).toEqual(["alarm"]);
    expect(result.totalSymbols).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("can render the maxSymbols note, a partial-output note, and the 16 KB note together", () => {
    // Long names push the body past the 16 KB budget while `maxSymbols` still
    // truncates the symbol set, proving the three footer notes coexist and the
    // reserved-footer arithmetic survives the combination.
    const longName = "n".repeat(6000);
    const huge = file(
      "/w/huge.ts",
      4,
      [1, 2, 3, 4].map((line) => symbol(`${longName}${line}`, "function", line, line)),
    );
    const partial =
      "note: ctags timed out before completing; the outline lists only the symbols recovered from its partial output.";

    const capped = outlineFiles([huge], { maxSymbols: 3 });
    expect(capped.truncated).toBe(true);
    const text = formatOutline(capped, [partial]);

    const maxSymbolsIndex = text.indexOf("note: symbol output truncated by maxSymbols");
    const partialIndex = text.indexOf(partial);
    const bytecapIndex = text.indexOf("note: output truncated at");
    expect(maxSymbolsIndex).toBeGreaterThan(-1);
    expect(partialIndex).toBeGreaterThan(maxSymbolsIndex);
    expect(bytecapIndex).toBeGreaterThan(partialIndex);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(OUTLINE_MAX_OUTPUT_BYTES);
  });

  it("renders a header, rows, and filter notes", () => {
    const text = formatOutline(outlineFiles(files, { kind: ["function"], nameMatches: "a" }));
    expect(text).toContain("/w/a.ts (3 lines)");
    expect(text).toContain("1-3");
    expect(text).toContain("alpha [exported]");
    expect(text).toContain("filters: kind=function, name~=a");
  });

  it("bounds output by UTF-8 bytes and reserves the truncation footer", () => {
    const many: OutlineSymbol[] = [];
    for (let index = 0; index < 500; index++) {
      many.push(
        symbol(`symbolNumber${String(index).padStart(4, "0")}`, "function", index + 1, index + 1),
      );
    }
    const text = formatOutline(outlineFiles([file("/w/big.ts", 500, many)]));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(OUTLINE_MAX_OUTPUT_BYTES);
    expect(text).toContain("note: output truncated at");
  });

  it("filters and renders distinct same-line kinds independently", () => {
    const collision = file(
      "/w/collide.ts",
      1,
      mergeOutlineSymbols([symbol("foo", "property", 1, 1)], [symbol("foo", "method", 1, 1)]),
    );

    const byMethod = outlineFiles([collision], { kind: ["method"] });
    expect(byMethod.totalSymbols).toBe(1);
    expect(byMethod.files[0]?.symbols.map((entry) => entry.kind)).toEqual(["method"]);

    const text = formatOutline(outlineFiles([collision]));
    expect(text).toContain("method        foo");
    expect(text).toContain("property      foo");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(OUTLINE_MAX_OUTPUT_BYTES);
  });
});

describe("outlineAstGrepLanguage", () => {
  it("routes the TypeScript family (including .cjs) to ast-grep", () => {
    expect(outlineAstGrepLanguage("a.ts")).toBe("ts");
    expect(outlineAstGrepLanguage("a.mts")).toBe("ts");
    expect(outlineAstGrepLanguage("a.cts")).toBe("ts");
    expect(outlineAstGrepLanguage("a.cjs")).toBe("js");
    expect(outlineAstGrepLanguage("Comp.tsx")).toBe("tsx");
    expect(outlineAstGrepLanguage("a.py")).toBeUndefined();
    expect(outlineAstGrepLanguage("a.rs")).toBeUndefined();
  });
});

describe("isOutlineKind", () => {
  it("accepts every curated kind and rejects others", () => {
    expect(isOutlineKind("struct")).toBe(true);
    expect(isOutlineKind("registerTool")).toBe(true);
    expect(isOutlineKind("on")).toBe(true);
    expect(isOutlineKind("export")).toBe(false);
    expect(isOutlineKind("bogus")).toBe(false);
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
    writeFileSync(join(root, "c.py"), "def c():\n    return 1\n");
    writeFileSync(join(root, "d.rs"), "pub fn d() {}\n");
    writeFileSync(join(root, "e.go"), "package main\n");
    writeFileSync(join(root, "notes.txt"), "not source");
    writeFileSync(join(root, "sub", "f.ts"), "export const f = 1;");
    writeFileSync(join(root, "node_modules", "g.ts"), "export const g = 1;");
    writeFileSync(join(root, ".hidden", "h.ts"), "export const h = 1;");
    return root;
  }

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("walks a directory across languages, skipping node_modules and dot-directories", () => {
    const root = tempTree();
    const resolved = resolveOutlineTargets(root, ".");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.files.map((entry) => entry.slice(root.length + 1))).toEqual([
      "a.ts",
      "b.tsx",
      "c.py",
      "d.rs",
      "e.go",
      "sub/f.ts",
    ]);
  });

  it("distinguishes ** (recursive) from * (single segment)", () => {
    const root = tempTree();
    const deep = resolveOutlineTargets(root, "**/*.ts");
    const shallow = resolveOutlineTargets(root, "*.ts");
    expect(deep.ok).toBe(true);
    expect(shallow.ok).toBe(true);
    if (!deep.ok || !shallow.ok) return;
    expect(deep.files.map((entry) => entry.slice(root.length + 1))).toEqual(["a.ts", "sub/f.ts"]);
    expect(shallow.files.map((entry) => entry.slice(root.length + 1))).toEqual(["a.ts"]);
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

  it("accepts non-TypeScript source extensions and rejects unsupported ones", () => {
    const root = tempTree();
    for (const name of ["c.py", "d.rs", "e.go", "a.ts"]) {
      expect(resolveOutlineTargets(root, name)).toMatchObject({ ok: true });
    }
    const rejected = resolveOutlineTargets(root, "notes.txt");
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toContain("Unsupported file extension");
    expect(rejected.error).toContain(".py");
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
    const relative = resolved.files.map((entry) => entry.slice(root.length + 1));
    expect(relative).toContain("link.ts");
    expect(relative.length).toBeLessThan(20);
  });

  it("collapses star runs in a glob (no runaway regex)", () => {
    const root = tempTree();
    const resolved = resolveOutlineTargets(root, "sub/***/f.ts");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.files.map((entry) => entry.slice(root.length + 1))).toEqual(["sub/f.ts"]);
    }
    expect(resolveOutlineTargets(root, "a************b.ts").ok).toBe(false);
  });

  it("returns an error for a glob with no matches", () => {
    const root = tempTree();
    const resolved = resolveOutlineTargets(root, "sub/**/*.lua");
    expect(resolved).toEqual({ ok: false, error: "No matching source files found." });
  });

  it("resolves a symlinked file as a single target, not only inside a walk", () => {
    const root = tempTree();
    const link = join(root, "direct-link.ts");
    symlinkSync(join(root, "a.ts"), link);

    const resolved = resolveOutlineTargets(root, "direct-link.ts");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.files).toEqual([link]);
  });

  it("matches extensions case-insensitively for a single file and a directory walk", () => {
    const root = tempRoot();
    writeFileSync(join(root, "Upper.TS"), "export const a = 1;");
    writeFileSync(join(root, "Script.PY"), "def a():\n    return 1\n");

    const upper = resolveOutlineTargets(root, "Upper.TS");
    expect(upper.ok).toBe(true);
    if (upper.ok) expect(upper.files).toEqual([join(root, "Upper.TS")]);

    const walked = resolveOutlineTargets(root, ".");
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    const names = walked.files.map((entry) => entry.slice(root.length + 1));
    expect(names).toContain("Upper.TS");
    expect(names).toContain("Script.PY");
  });

  it("returns No matching source files for a directory with only unsupported extensions", () => {
    const root = tempRoot();
    writeFileSync(join(root, "notes.txt"), "not source");
    writeFileSync(join(root, "Makefile"), "all:");

    expect(resolveOutlineTargets(root, ".")).toEqual({
      ok: false,
      error: "No matching source files found.",
    });
  });

  it("counts only accepted extensions toward the 200-file cap", () => {
    const root = tempRoot();
    const supported = OUTLINE_MAX_FILES + 1;
    for (let index = 0; index < supported; index++) {
      writeFileSync(join(root, `s${String(index).padStart(4, "0")}.ts`), "export const x = 1;");
    }
    // Noise that must not consume cap slots: the cap is on outline files.
    for (let index = 0; index < 25; index++) {
      writeFileSync(join(root, `n${String(index).padStart(4, "0")}.txt`), "not source");
    }

    const resolved = resolveOutlineTargets(root, ".");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.files.length).toBe(OUTLINE_MAX_FILES);
    expect(resolved.truncatedBy).toBe("file-cap");
    expect(resolved.totalMatches).toBe(supported);
    expect(resolved.files.every((entry) => entry.endsWith(".ts"))).toBe(true);
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

  it("reports the file-cap cause with the true match count", () => {
    const root = tempRoot();
    const total = OUTLINE_MAX_FILES + 1;
    for (let index = 0; index < total; index++) {
      writeFileSync(join(root, `f${String(index).padStart(4, "0")}.ts`), "export const x = 1;");
    }

    const resolved = resolveOutlineTargets(root, ".");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.files.length).toBe(OUTLINE_MAX_FILES);
    expect(resolved.truncatedBy).toBe("file-cap");
    expect(resolved.totalMatches).toBe(total);
  });

  it("lets the walk cap take precedence when both caps trigger", () => {
    const root = tempRoot();
    const total = OUTLINE_MAX_FILES + 5;
    for (let index = 0; index < total; index++) {
      writeFileSync(join(root, `g${String(index).padStart(4, "0")}.ts`), "export const x = 1;");
    }

    const resolved = resolveOutlineTargets(root, ".", { maxWalkEntries: total - 2 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.files.length).toBe(OUTLINE_MAX_FILES);
    expect(resolved.truncatedBy).toBe("walk-cap");
    expect(resolved.totalMatches).toBeUndefined();
  });
});
