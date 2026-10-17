/**
 * Real-binary coverage for `belayd_outline`.
 *
 * These tests spawn the actual `ctags` / `ast-grep` CLIs against temp-dir
 * fixtures and assert ordered names plus plausible line ranges. They skip
 * cleanly when a CLI is not on PATH, so `pnpm test` stays green in a bare
 * shell; under `nix develop -c` (which provides both) they execute for real.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import type { OutlineKind } from "../outline.js";
import { OUTLINE_LANGUAGES, outlineAstGrepLanguage, outlineFiles } from "../outline.js";
import { findExecutableOnPath } from "../outline-binary.js";
import { OUTLINE_CTAGS_MAP_OVERRIDES } from "../outline-ctags.js";
import { extractOutlineSymbols } from "../outline-extract.js";

const hasCtags = findExecutableOnPath("ctags", process.env.PATH) !== undefined;
const hasAstGrep = findExecutableOnPath("ast-grep", process.env.PATH) !== undefined;

const root = mkdtempSync(join(tmpdir(), "belayd-outline-extract-"));
const tsPath = join(root, "sample.ts");
const tsxPath = join(root, "sample.tsx");
const mtsPath = join(root, "sample.mts");
const ctsPath = join(root, "sample.cts");
const cjsPath = join(root, "sample.cjs");
const cjsQuirksPath = join(root, "quirks.cjs");
const cjsRegistrationPath = join(root, "registration.cjs");
const accessTsPath = join(root, "access.ts");
const accessTsxPath = join(root, "access.tsx");
const destructureTsPath = join(root, "destructure.ts");
const pyPath = join(root, "sample.py");
const rsPath = join(root, "sample.rs");
const goPath = join(root, "sample.go");
const rbPath = join(root, "sample.rb");
const javaPath = join(root, "sample.java");
const cPath = join(root, "sample.c");
const cppPath = join(root, "sample.cpp");
const goMethodsPath = join(root, "methods.go");
const shPath = join(root, "sample.sh");
const cppScopesPath = join(root, "scopes.cpp");
const cppMemberFormsPath = join(root, "member-forms.cpp");
const cppLambdaPath = join(root, "lambda.cpp");
const closurePyPath = join(root, "closure.py");
const closureJsPath = join(root, "closure.js");
const rustImplPath = join(root, "impl.rs");
const goRichPath = join(root, "rich.go");
const enumCPath = join(root, "enumerators.c");
const enumTsPath = join(root, "enumerators.ts");
const enumCsPath = join(root, "enumerators.cs");
const haskellPath = join(root, "shapes.hs");
const heredocPath = join(root, "heredoc.sh");
const unknownPyPath = join(root, "unknown.py");
const packageJavaPath = join(root, "package.java");
const rubyAccessorPath = join(root, "accessor.rb");
const jsGetterPath = join(root, "getset.js");
const csEventPath = join(root, "events.cs");
const kotlinPath = join(root, "widget.kt");
const phpPath = join(root, "defs.php");
const phpTraitPath = join(root, "traits.php");
const javaAnnotationPath = join(root, "marker.java");
const ocamlPath = join(root, "shape.ml");
const ocamlSigPath = join(root, "shape.mli");
const elixirPath = join(root, "example.ex");
const elixirRecordPath = join(root, "record.ex");
const tsGetterPath = join(root, "getset.ts");
const referenceCPath = join(root, "includes.c");
const referenceRbPath = join(root, "requires.rb");
const scriptOnlyPath = join(root, "script-only.sh");

writeFileSync(
  tsPath,
  [
    "export function alpha(value: number): number {",
    "  return value + 1;",
    "}",
    "",
    "export const beta = 2;",
    "",
    "export class Gamma {",
    "  method(): void {}",
    "}",
    "",
    "export default function harness(pi: { registerTool: (d: { name: string }) => void }): void {",
    '  pi.registerTool({ name: "belayd_outline" });',
    "}",
  ].join("\n"),
);
// The regression fixture: ctags 6.2.1 does not map `.tsx` without the override,
// so these ctags-only rows (an interface property, the second declarator, an
// enum) would silently vanish.
writeFileSync(
  tsxPath,
  [
    "export interface Box {",
    "  width: number;",
    "}",
    "",
    "export const a = 1, b = 2;",
    "",
    "export enum Colour { Red, Green }",
  ].join("\n"),
);
writeFileSync(mtsPath, ["export function runMts(): number {", "  return 1;", "}"].join("\n"));
writeFileSync(ctsPath, ["export function runCts(): number {", "  return 1;", "}"].join("\n"));
writeFileSync(
  cjsPath,
  ["const value = 1;", "function helper() {", "  return value;", "}"].join("\n"),
);
// ctags' JavaScript parser miskinds an arrow const as `function` and a
// generator declaration as `class`; ast-grep refines both. (The keyword-named
// destructuring artifact is TypeScript-parser specific and is covered by the
// `access.*` fixtures.)
writeFileSync(
  cjsQuirksPath,
  [
    "const arrow = (x) => x + 1;",
    "",
    "function* Producer() {",
    "  yield 1;",
    "}",
    "",
    'const { a: renamed } = require("x");',
    "",
    "class Holder {",
    "  const = 1;",
    "}",
  ].join("\n"),
);
// A top-level registration object; ctags' JS parser additionally invents an
// `anonymousObject<hash>` holder tag (kind `variable`) for the object literal.
writeFileSync(cjsRegistrationPath, 'pi.registerTool({ name: "x", execute() {} });\n');
// Keyword-named class fields are legal JS/TS. ctags' parsers tag only some of
// them (and misname others), so ast-grep's `public_field_definition` branch
// supplies the rest; none may be dropped by the keyword filter.
const accessSource = [
  "class Access {",
  "  public = 1;",
  "  static = 2;",
  "  interface = 3;",
  "  implements = 4;",
  '  function = "";',
  "  with = 5;",
  "  const = 1;",
  "}",
];
writeFileSync(accessTsPath, accessSource.join("\n"));
writeFileSync(accessTsxPath, [...accessSource, "export const element = <div />;"].join("\n"));
// ctags' TypeScript parser emits a `constant const` declaration row for a
// destructuring rename; ast-grep emits the non-identifier `LEXICAL` capture.
// Neither may surface as a `const` symbol.
writeFileSync(
  destructureTsPath,
  ["const a = 1;", "const b = 2;", "const { const: renamed } = obj;"].join("\n"),
);
writeFileSync(
  pyPath,
  ["class Foo:", "    def bar(self):", "        return 1", "", "def baz(x):", "    return x"].join(
    "\n",
  ),
);
writeFileSync(
  rsPath,
  ["pub struct Point { x: i32 }", "pub fn add(a: i32, b: i32) -> i32 { a + b }"].join("\n"),
);
writeFileSync(
  goPath,
  ["package main", "", "func Add(a int, b int) int { return a + b }"].join("\n"),
);
// Ruby exercises two things the TypeScript fixtures cannot: ctags' `module`
// kind and a class method (`def self.build`) that ctags reports as
// `singletonMethod` rather than `method`.
writeFileSync(
  rbPath,
  [
    "class Greeter",
    "  def hello(name)",
    '    "hi #{name}"',
    "  end",
    "",
    "  def self.build",
    "    new",
    "  end",
    "end",
    "",
    "def top_level(x)",
    "  x * 2",
    "end",
    "",
    "module Util",
    "  def helper",
    "    1",
    "  end",
    "end",
  ].join("\n"),
);
// Java emits `package` (unmapped, dropped), a constructor and an interface
// method both kinded `method`, and a `field`.
writeFileSync(
  javaPath,
  [
    "package demo;",
    "",
    "public class Widget {",
    "  private int count;",
    "",
    "  public Widget(int count) {",
    "    this.count = count;",
    "  }",
    "",
    "  public int increment() {",
    "    return count + 1;",
    "  }",
    "}",
    "",
    "interface Named {",
    "  String name();",
    "}",
  ].join("\n"),
);
// C emits `struct` + `member` (mapped to `field`) on one line, and functions
// with real `end` ranges.
writeFileSync(
  cPath,
  [
    "#include <stdio.h>",
    "",
    "struct Point { int x; int y; };",
    "",
    "int add(int a, int b) {",
    "  return a + b;",
    "}",
    "",
    "static void greet(void) {",
    '  printf("hi\\n");',
    "}",
  ].join("\n"),
);
writeFileSync(
  cppPath,
  [
    "class Widget {",
    "public:",
    "  int increment() {",
    "    return 1;",
    "  }",
    "};",
    "",
    "int add(int a, int b) {",
    "  return a + b;",
    "}",
  ].join("\n"),
);
// Go tags a method (`func (p Point) Dist`) as `func` with `scopeKind: struct`
// and a free function as `func` with `scopeKind: package`; only the scope
// separates them, so this fixture pins the `function` vs `method` split.
writeFileSync(
  goMethodsPath,
  [
    "package main",
    "",
    "type Point struct {",
    "\tX int",
    "\tY int",
    "}",
    "",
    "func (p Point) Dist() int { return p.X + p.Y }",
    "",
    "func Add(a int, b int) int { return a + b }",
  ].join("\n"),
);
// Sh functions get no `end` field from ctags, so endLine must fall back to the
// declaration line rather than being dropped or zeroed.
writeFileSync(
  shPath,
  [
    "greet() {",
    '  echo "hi"',
    "}",
    "",
    "function build {",
    '  echo "build"',
    "}",
    "",
    'VERSION="1.0"',
  ].join("\n"),
);
// C++ puts a `namespace` scope on a free function and a `class` scope on a
// member; only the latter may promote to `method`.
writeFileSync(
  cppScopesPath,
  [
    "namespace demo {",
    "int freeInNamespace(int a, int b) {",
    "  return a + b;",
    "}",
    "}",
    "",
    "int freeTopLevel(int a) {",
    "  return a;",
    "}",
    "",
    "class Widget {",
    "public:",
    "  static int count() {",
    "    return 1;",
    "  }",
    "  int increment() {",
    "    return 2;",
    "  }",
    "};",
  ].join("\n"),
);
// Out-of-line member definitions, a constructor/destructor/operator, and a
// `friend` declared in the class body: the friend is a free function and must
// stay `function` even though it appears inside a class.
writeFileSync(
  cppMemberFormsPath,
  [
    "class Widget {",
    "public:",
    "  int increment();",
    "  static int count();",
    "  friend int buddy(const Widget& w);",
    "  Widget();",
    "  ~Widget();",
    "  bool operator==(const Widget& other) const;",
    "};",
    "",
    "int Widget::increment() { return 1; }",
    "int Widget::count() { return 2; }",
    "int buddy(const Widget& w) { return 0; }",
    "Widget::Widget() {}",
    "Widget::~Widget() {}",
    "bool Widget::operator==(const Widget& other) const { return true; }",
  ].join("\n"),
);
// A C++ lambda gets `scopeKind: function` and must be dropped, never surfaced
// as a method; the namespace helper stays a function.
writeFileSync(
  cppLambdaPath,
  [
    "#include <functional>",
    "",
    "namespace ns {",
    "  int helper(int x) { return x + 1; }",
    "}",
    "",
    "struct S {",
    "  void run() {",
    "    auto f = [](int x) { return x; };",
    "    (void)f;",
    "  }",
    "};",
    "",
    "int freeTop(int x) { return x; }",
  ].join("\n"),
);
// Nested Python/JS functions carry `scopeKind: function` and are dropped, not
// relabelled methods.
writeFileSync(
  closurePyPath,
  [
    "def outer(x):",
    "    def inner(y):",
    "        return y + 1",
    "    return inner(x)",
    "",
    "def top(x):",
    "    return x",
  ].join("\n"),
);
writeFileSync(
  closureJsPath,
  [
    "function outer(x) {",
    "  function inner(y) {",
    "    return y + 1;",
    "  }",
    "  const arrow = (z) => z * 2;",
    "  return inner(x) + arrow(x);",
    "}",
    "",
    "function top(x) {",
    "  return x;",
    "}",
  ].join("\n"),
);
// Rust `impl` methods are kind `method` with a `scopeKind: implementation`; the
// `implementation` tag itself is a no-op, and the associated const survives.
writeFileSync(
  rustImplPath,
  [
    "struct Point { x: i32, y: i32 }",
    "",
    "impl Point {",
    "    const ORIGIN_X: i32 = 0;",
    "",
    "    fn new() -> Self { Point { x: 0, y: 0 } }",
    "    fn dist(&self) -> i32 { self.x + self.y }",
    "}",
    "",
    "trait Shape {",
    "    fn area(&self) -> i32;",
    "}",
    "",
    "impl Shape for Point {",
    "    fn area(&self) -> i32 { self.x * self.y }",
    "}",
    "",
    "impl Default for Point {",
    "    fn default() -> Self { Point::new() }",
    "}",
    "",
    "fn free_fn(a: i32) -> i32 { a }",
  ].join("\n"),
);
// Go's newly mapped kinds: `talias`, `const`, `anonMember`, `methodSpec`, with
// a package-level function next to receiver methods.
writeFileSync(
  goRichPath,
  [
    "package demo",
    "",
    "type Alias = int",
    "",
    "type Named interface {",
    "\tGreet(name string) string",
    "}",
    "",
    "type Base struct {",
    "\tID int",
    "}",
    "",
    "type Wrapper struct {",
    "\tBase",
    "\tLabel string",
    "}",
    "",
    "const Max = 10",
    "",
    "func (w Wrapper) Describe() string { return w.Label }",
    "",
    "func TopLevel(x int) int { return x }",
  ].join("\n"),
);
// `enumerator` is a no-op in every language that emits it; the enum type stays.
writeFileSync(
  enumCPath,
  [
    "enum Color { RED, GREEN, BLUE };",
    "",
    "enum Mode { Fast, Slow };",
    "",
    "int use(int c) { return c; }",
  ].join("\n"),
);
writeFileSync(
  enumTsPath,
  ["export enum Colour { Red, Green }", "export const enum Fast { A, B }"].join("\n"),
);
writeFileSync(
  enumCsPath,
  [
    "namespace Demo {",
    "  enum Colour { Red, Green }",
    "",
    "  class Widget {",
    "    public int Count;",
    "  }",
    "}",
  ].join("\n"),
);
// Haskell value constructors are kind `constructor` (a no-op); the data type
// is kept.
writeFileSync(
  haskellPath,
  [
    "module Shapes where",
    "",
    "data Colour = Red | Green | Blue",
    "",
    "newtype Wrapper = Wrapper Int",
  ].join("\n"),
);
// Shell here-document labels are kind `heredoc` (a no-op).
writeFileSync(
  heredocPath,
  [
    "cat <<EOF",
    "hello",
    "EOF",
    "",
    "cat <<'END'",
    "world",
    "END",
    "",
    "greet() {",
    "  echo hi",
    "}",
  ].join("\n"),
);
// A Python `from … import x as y` is kind `unknown` (a reference, not a binding).
writeFileSync(
  unknownPyPath,
  ["from module import thing as alias", "import os", "", "def use():", "    return alias"].join(
    "\n",
  ),
);
writeFileSync(
  packageJavaPath,
  [
    "package com.example.demo;",
    "",
    "import java.util.List;",
    "",
    "public class Widget {",
    "  private int count;",
    "",
    "  public int increment() { return count + 1; }",
    "}",
  ].join("\n"),
);
writeFileSync(
  rubyAccessorPath,
  [
    "class Person",
    "  attr_accessor :name",
    "  attr_reader :age",
    "  attr_writer :email",
    "end",
  ].join("\n"),
);
writeFileSync(
  jsGetterPath,
  [
    "class Access {",
    "  get current() {",
    "    return 1;",
    "  }",
    "  set current(next) {",
    "    this.value = next;",
    "  }",
    "}",
  ].join("\n"),
);
writeFileSync(
  csEventPath,
  [
    "using System;",
    "",
    "public class Publisher {",
    "  public event EventHandler Changed;",
    "",
    "  public int Count { get; set; }",
    "",
    "  public void Raise() {",
    "    Changed?.Invoke(this, EventArgs.Empty);",
    "  }",
    "}",
  ].join("\n"),
);
writeFileSync(
  kotlinPath,
  [
    "typealias Handler = () -> Unit",
    "",
    "object Singleton {",
    "  val value = 1",
    "}",
    "",
    "class Widget {",
    "  fun build(): Handler = {}",
    "}",
  ].join("\n"),
);
writeFileSync(
  phpPath,
  [
    "<?php",
    "define('MAX', 10);",
    "const MIN = 1;",
    "",
    "function top($x) { return $x; }",
    "",
    "class Widget {",
    "  public function inc() { return 1; }",
    "}",
  ].join("\n"),
);
// PHP tags a trait method as kind `function` with `scopeKind: trait`.
writeFileSync(
  phpTraitPath,
  [
    "<?php",
    "trait Greets {",
    '  public function greet() { return "hi"; }',
    '  protected function name() { return "x"; }',
    "}",
  ].join("\n"),
);
writeFileSync(
  javaAnnotationPath,
  ["package demo;", "", "public @interface Marker {", "  String value();", "}"].join("\n"),
);
writeFileSync(
  ocamlPath,
  [
    "type point = { x : int; y : int }",
    "",
    "let origin = { x = 0; y = 0 }",
    "",
    "let add a b = a + b",
  ].join("\n"),
);
writeFileSync(
  ocamlSigPath,
  ["val add : int -> int -> int", "", "type point = { x : int; y : int }"].join("\n"),
);
writeFileSync(
  elixirPath,
  [
    "defprotocol Printable do",
    "  def print(value)",
    "end",
    "",
    "defmodule Example do",
    "  defdelegate size(list), to: Enum",
    "",
    "  defguard is_even(value) when rem(value, 2) == 0",
    "",
    "  def run(value) do",
    "    value",
    "  end",
    "end",
  ].join("\n"),
);
writeFileSync(
  elixirRecordPath,
  [
    "defmodule Example do",
    "  require Record",
    "  Record.defrecord(:point, x: 0, y: 0)",
    "",
    "  def run(value), do: value",
    "end",
  ].join("\n"),
);
// TypeScript tags get/set accessors as `method`; only ctags' JavaScript parser
// emits the `getter`/`setter` kinds.
writeFileSync(
  tsGetterPath,
  [
    "export class Access {",
    "  private value = 1;",
    "",
    "  get current(): number {",
    "    return this.value;",
    "  }",
    "",
    "  set current(next: number) {",
    "    this.value = next;",
    "  }",
    "}",
  ].join("\n"),
);
// `#include` (C/C++ `header`), `require` (Ruby `library`), and the shell
// `script` kind are reference-only and the default args never request them.
writeFileSync(
  referenceCPath,
  ["#include <stdio.h>", '#include "local.h"', "", "int add(int a, int b) { return a + b; }"].join(
    "\n",
  ),
);
writeFileSync(
  referenceRbPath,
  [
    'require "json"',
    'require_relative "helper"',
    "",
    "class Thing",
    "  def go",
    "    1",
    "  end",
    "end",
  ].join("\n"),
);
writeFileSync(scriptOnlyPath, 'VERSION="1.0"\n');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function symbolsFor(
  path: string,
): Promise<Array<{ name: string; kind: string; startLine: number; endLine: number }>> {
  return extractOutlineSymbols([path]).then((extracted) => {
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return [];
    const file = extracted.files[0];
    return (file?.symbols ?? []).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      startLine: entry.startLine,
      endLine: entry.endLine,
    }));
  });
}

/** Names selected by one `kind` filter, preserving the extractor's order. */
async function kindNames(path: string, kind: OutlineKind): Promise<string[]> {
  const extracted = await extractOutlineSymbols([path]);
  expect(extracted.ok).toBe(true);
  if (!extracted.ok) return [];
  return outlineFiles(extracted.files, { kind: [kind] }).files.flatMap((file) =>
    file.symbols.map((symbol) => symbol.name),
  );
}

describe.skipIf(!hasCtags || !hasAstGrep)("extractOutlineSymbols with real binaries", () => {
  it("returns ordered TypeScript declarations with real ranges", async () => {
    const symbols = await symbolsFor(tsPath);
    const alpha = symbols.find((entry) => entry.name === "alpha");
    expect(alpha).toMatchObject({ kind: "function", startLine: 1 });
    expect(alpha?.endLine).toBeGreaterThanOrEqual(3);

    const gamma = symbols.find((entry) => entry.name === "Gamma");
    expect(gamma?.kind).toBe("class");
    expect(gamma?.endLine).toBeGreaterThanOrEqual(gamma?.startLine ?? 0);

    const startLines = symbols.map((entry) => entry.startLine);
    expect([...startLines].sort((a, b) => a - b)).toEqual(startLines);
  });

  it("keeps ctags-only .tsx rows: interface property, second declarator, enum", async () => {
    const symbols = await symbolsFor(tsxPath);
    const names = symbols.map((entry) => entry.name);
    expect(names).toContain("Box");
    expect(names).toContain("width");
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).toContain("Colour");
    expect(symbols.find((entry) => entry.name === "width")?.kind).toBe("property");
  });

  it("tags an exported declaration in a .mts file", async () => {
    const names = (await symbolsFor(mtsPath)).map((entry) => entry.name);
    expect(names).toContain("runMts");
  });

  it("tags an exported declaration in a .cts file", async () => {
    const names = (await symbolsFor(ctsPath)).map((entry) => entry.name);
    expect(names).toContain("runCts");
  });

  it("produces a non-empty outline for a .cjs file", async () => {
    const symbols = await symbolsFor(cjsPath);
    const names = symbols.map((entry) => entry.name);
    expect(names).toContain("value");
    expect(names).toContain("helper");
  });

  it("collapses ctags' .cjs arrow and generator twins", async () => {
    const symbols = await symbolsFor(cjsQuirksPath);

    const arrow = symbols.filter((entry) => entry.name === "arrow");
    expect(arrow).toHaveLength(1);
    expect(arrow[0]?.kind).toBe("const");

    const producer = symbols.filter((entry) => entry.name === "Producer");
    expect(producer).toHaveLength(1);
    expect(producer[0]?.kind).toBe("function");
    expect(producer[0]?.endLine).toBeGreaterThanOrEqual(3);

    // The destructuring rename emits the bound name, never the `const` key.
    expect(symbols.some((entry) => entry.name === "const")).toBe(false);
  });

  it("emits every keyword-named class member for .ts and .tsx", async () => {
    const memberNames = [
      "public",
      "static",
      "interface",
      "implements",
      "function",
      "with",
      "const",
    ];
    for (const path of [accessTsPath, accessTsxPath]) {
      const symbols = await symbolsFor(path);
      const members = symbols.filter((entry) => memberNames.includes(entry.name));
      expect(members.map((entry) => entry.name).sort(), path).toEqual([...memberNames].sort());
      for (const member of members) {
        expect(member.kind, `${path} ${member.name}`).toBe("property");
        expect(member.startLine, `${path} ${member.name}`).toBeGreaterThanOrEqual(2);
        expect(member.endLine, `${path} ${member.name}`).toBeGreaterThanOrEqual(member.startLine);
      }
    }
  });

  it("drops the .cjs anonymousObject holder but keeps the real registration members", async () => {
    const symbols = await symbolsFor(cjsRegistrationPath);
    expect(symbols.some((entry) => entry.name.startsWith("anonymousObject"))).toBe(false);
    expect(symbols.some((entry) => entry.name === "name" && entry.kind === "property")).toBe(true);
    // ctags and ast-grep both tag the object method; the merge must keep one.
    expect(symbols.filter((entry) => entry.name === "execute")).toHaveLength(1);
    expect(symbols.some((entry) => entry.name === "x" && entry.kind === "registerTool")).toBe(true);
  });

  it("never surfaces a keyword from a TypeScript destructuring rename", async () => {
    const symbols = await symbolsFor(destructureTsPath);
    expect(symbols.some((entry) => entry.name === "const")).toBe(false);
    expect(symbols.map((entry) => entry.name)).toContain("a");
  });

  it("extracts a Python class, method, and function", async () => {
    const names = (await symbolsFor(pyPath)).map((entry) => entry.name);
    expect(names).toContain("Foo");
    expect(names).toContain("bar");
    expect(names).toContain("baz");
  });

  it("extracts Rust and Go declarations", async () => {
    const rustNames = (await symbolsFor(rsPath)).map((entry) => entry.name);
    expect(rustNames).toContain("add");
    expect(rustNames).toContain("Point");

    const goSymbols = await symbolsFor(goPath);
    const add = goSymbols.find((entry) => entry.name === "Add");
    expect(add?.kind).toBe("function");
    expect(add?.startLine).toBe(3);
  });

  it("resolves a mixed directory across languages", async () => {
    const extracted = await extractOutlineSymbols([tsPath, pyPath, rsPath, goPath]);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.files.map((file) => file.path)).toEqual([tsPath, pyPath, rsPath, goPath]);
    for (const file of extracted.files) expect(file.lineCount).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasCtags)("multi-language breadth (ctags only)", () => {
  it("extracts a Ruby class, module, and methods with ranges", async () => {
    const symbols = await symbolsFor(rbPath);

    const greeter = symbols.find((entry) => entry.name === "Greeter");
    expect(greeter).toMatchObject({ kind: "class", startLine: 1, endLine: 9 });

    const hello = symbols.find((entry) => entry.name === "hello");
    expect(hello).toMatchObject({ kind: "method", startLine: 2, endLine: 4 });

    const topLevel = symbols.find((entry) => entry.name === "top_level");
    expect(topLevel).toMatchObject({ kind: "method", startLine: 11, endLine: 13 });

    expect(symbols.find((entry) => entry.name === "Util")?.kind).toBe("module");
    expect(symbols.find((entry) => entry.name === "helper")?.kind).toBe("method");
  });

  it("extracts Java class, field, constructor/method, and interface with ranges", async () => {
    const symbols = await symbolsFor(javaPath);

    const widgetClass = symbols.find((entry) => entry.name === "Widget" && entry.kind === "class");
    expect(widgetClass).toMatchObject({ startLine: 3, endLine: 13 });

    // Java's constructor and methods are both ctags kind `method`.
    const widgetCtor = symbols.find((entry) => entry.name === "Widget" && entry.kind === "method");
    expect(widgetCtor).toMatchObject({ startLine: 6, endLine: 8 });

    const count = symbols.find((entry) => entry.name === "count");
    expect(count).toMatchObject({ kind: "field", startLine: 4, endLine: 4 });

    const increment = symbols.find((entry) => entry.name === "increment");
    expect(increment).toMatchObject({ kind: "method", startLine: 10, endLine: 12 });

    const named = symbols.find((entry) => entry.name === "Named");
    expect(named).toMatchObject({ kind: "interface", startLine: 15, endLine: 17 });

    // `package demo;` has no outline kind and must be dropped, not surfaced.
    expect(symbols.some((entry) => entry.name === "demo")).toBe(false);
  });

  it("extracts C functions and struct fields with ranges", async () => {
    const symbols = await symbolsFor(cPath);

    const add = symbols.find((entry) => entry.name === "add");
    expect(add).toMatchObject({ kind: "function", startLine: 5, endLine: 7 });

    const greet = symbols.find((entry) => entry.name === "greet");
    expect(greet).toMatchObject({ kind: "function", startLine: 9, endLine: 11 });

    const point = symbols.find((entry) => entry.name === "Point");
    expect(point).toMatchObject({ kind: "struct", startLine: 3 });

    for (const field of ["x", "y"] as const) {
      const symbol = symbols.find((entry) => entry.name === field);
      expect(symbol, field).toMatchObject({ kind: "field", startLine: 3 });
      expect(symbol?.endLine, field).toBeGreaterThanOrEqual(symbol?.startLine ?? 0);
    }
  });

  it("extracts shell functions and falls a missing ctags end back to the start line", async () => {
    const symbols = await symbolsFor(shPath);

    const greet = symbols.find((entry) => entry.name === "greet");
    const build = symbols.find((entry) => entry.name === "build");
    expect(greet).toMatchObject({ kind: "function", startLine: 1 });
    expect(build).toMatchObject({ kind: "function", startLine: 5 });
    // ctags' Sh parser emits no `end`; endLine must equal startLine, never 0 or undefined.
    expect(greet?.endLine).toBe(greet?.startLine);
    expect(build?.endLine).toBe(build?.startLine);

    // A shell variable assignment is not an outline declaration.
    expect(symbols.some((entry) => entry.name === "VERSION")).toBe(false);
  });

  // Regression for the `mapCtagsKind` hole: ctags tags Ruby's `def self.build`
  // as kind `singletonMethod`, which the mapping now routes to `method`.
  it("maps a Ruby singleton method as a method with its real range", async () => {
    const symbols = await symbolsFor(rbPath);
    const build = symbols.find((entry) => entry.name === "build");
    expect(build).toMatchObject({ kind: "method", startLine: 6, endLine: 8 });
  });
});

describe.skipIf(!hasCtags)("per-language kind mapping and filtering (ctags only)", () => {
  async function filteredNames(
    path: string,
    kind: "class" | "function" | "method",
  ): Promise<string[]> {
    const extracted = await extractOutlineSymbols([path]);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return [];
    return outlineFiles(extracted.files, { kind: [kind] }).files.flatMap((file) =>
      file.symbols.map((symbol) => symbol.name),
    );
  }

  it("maps Python class, function, and method so each filter selects exactly its group", async () => {
    expect(await filteredNames(pyPath, "class")).toEqual(["Foo"]);
    expect(await filteredNames(pyPath, "function")).toEqual(["baz"]);
    expect(await filteredNames(pyPath, "method")).toEqual(["bar"]);
  });

  it("maps Ruby class and method kinds and keeps the singleton method out of `function`", async () => {
    expect(await filteredNames(rbPath, "class")).toEqual(["Greeter"]);
    expect(await filteredNames(rbPath, "method")).toEqual([
      "hello",
      "build",
      "top_level",
      "helper",
    ]);
    expect(await filteredNames(rbPath, "function")).toEqual([]);
  });

  it("selects a Go method as `method` but leaves a free Go function as `function`", async () => {
    expect(await filteredNames(goMethodsPath, "method")).toEqual(["Dist"]);
    expect(await filteredNames(goMethodsPath, "function")).toEqual(["Add"]);
  });

  it("selects a C++ member function as `method` but leaves a free function as `function`", async () => {
    expect(await filteredNames(cppPath, "method")).toEqual(["increment"]);
    expect(await filteredNames(cppPath, "function")).toEqual(["add"]);
  });

  it("maps Java method, function, and class kinds", async () => {
    expect(await filteredNames(javaPath, "class")).toEqual(["Widget"]);
    expect(await filteredNames(javaPath, "function")).toEqual([]);
    expect(await filteredNames(javaPath, "method")).toEqual(["Widget", "increment", "name"]);
  });
});

describe.skipIf(!hasCtags)("read-only and concurrency safety", () => {
  it("produces identical output for repeated concurrent extractions and never mutates the source", async () => {
    const targets = [tsPath, pyPath, rbPath, javaPath, cPath, shPath];
    const before = new Map(targets.map((path) => [path, readFileSync(path, "utf8")]));

    const runs = await Promise.all(Array.from({ length: 6 }, () => extractOutlineSymbols(targets)));
    const baseline = JSON.stringify(runs[0]);
    for (const run of runs) expect(JSON.stringify(run)).toBe(baseline);

    for (const path of targets) {
      expect(readFileSync(path, "utf8"), path).toBe(before.get(path));
    }
  });
});

describe.skipIf(!hasCtags)("parseCtagsJson against real ctags output", () => {
  it("returns a non-empty symbol map for the TypeScript fixture", async () => {
    expect((await symbolsFor(tsPath)).length).toBeGreaterThan(2);
  });
});

describe.skipIf(!hasCtags || !hasAstGrep)("ast-grep registrations inside a function body", () => {
  it("resolves pi.registerTool and pi.on registrations", async () => {
    const regPath = join(root, "registrations.ts");
    writeFileSync(
      regPath,
      [
        "export default function harness(pi: any): void {",
        '  pi.registerTool({ name: "belayd_outline", label: "Outline" });',
        '  pi.on("tool_call", async () => {});',
        "}",
      ].join("\n"),
    );
    const symbols = await symbolsFor(regPath);
    expect(symbols.find((entry) => entry.name === "belayd_outline")?.kind).toBe("registerTool");
    const on = symbols.find((entry) => entry.name === "tool_call");
    expect(on?.kind).toBe("on");
    expect(on?.startLine).toBe(3);
  });
});

// ── Extension coverage invariant ──────────────────────────────────────
//
// The `.tsx`/`.mts`/`.cts`/`.cjs` regression was a table entry that neither
// extractor actually reached. This test asks the real ctags for its effective
// maps (including our `--map-<LANG>` overrides) and asserts every accepted
// extension is either ctags-mapped or routed to ast-grep — so a future
// extension cannot be added half-wired.
describe.skipIf(!hasCtags)("every accepted extension is covered by an extractor", () => {
  it("maps each OUTLINE_LANGUAGES extension or routes it to ast-grep", () => {
    const overrideArgs = OUTLINE_CTAGS_MAP_OVERRIDES.map(
      (override) => `--map-${override.language}=+${override.extension}`,
    );
    const listing = execFileSync("ctags", [...overrideArgs, "--list-maps"], { encoding: "utf8" });
    const ctagsExtensions = new Set<string>();
    for (const token of listing.split(/\s+/)) {
      const match = /^\*\.([A-Za-z0-9_.-]+)$/.exec(token);
      if (match !== null && match[1] !== undefined) ctagsExtensions.add(`.${match[1]}`);
    }

    const uncovered: string[] = [];
    for (const language of OUTLINE_LANGUAGES) {
      const ctagsCovered = ctagsExtensions.has(language.extension);
      const astGrepCovered = outlineAstGrepLanguage(language.extension) !== undefined;
      if (!ctagsCovered && !astGrepCovered)
        uncovered.push(`${language.extension} (${language.ctags})`);
    }

    expect(uncovered).toEqual([]);
    expect(ctagsExtensions.size).toBeGreaterThan(10);
  });
});

// ── Parser cross-check ────────────────────────────────────────────────
//
// The extractors are expected to reproduce the TypeScript parser's own view
// of every top-level declaration. Deriving the expectations from
// `ts.createSourceFile` (instead of hardcoding absolute line numbers) keeps
// these assertions valid as the files grow, and `typescript` stays a
// test-only devDependency — it is never imported from a `src/` runtime
// module, so the shipped library has no compiler-API dependency.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parserDeclaredName(statement: ts.Statement): string | undefined {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    const { name } = statement;
    return name === undefined ? undefined : name.text;
  }
  if (ts.isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations;
    // Multi-declarator statements (`const a = 1, b = 2;`) have no single
    // declaration line, so they are not comparable 1:1 with a symbol row.
    if (declarations.length !== 1) return undefined;
    const only = declarations[0];
    if (only === undefined || !ts.isIdentifier(only.name)) return undefined;
    return only.name.text;
  }
  return undefined;
}

/** Parser-derived `name → [startLine, endLine]` for top-level declarations. */
function parserRanges(relativePath: string): Map<string, [number, number]> {
  const file = join(REPO_ROOT, relativePath);
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const lineOf = (position: number): number =>
    sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const ranges = new Map<string, [number, number]>();
  for (const statement of sourceFile.statements) {
    const name = parserDeclaredName(statement);
    if (name === undefined) continue;
    ranges.set(name, [lineOf(statement.getStart(sourceFile)), lineOf(statement.getEnd())]);
  }
  return ranges;
}

const PARSER_CROSS_CHECK_FILES = ["src/agent-registry.ts", "extensions/index.ts"];

describe.skipIf(!hasCtags || !hasAstGrep)("extraction agrees with the TypeScript parser", () => {
  it.each(PARSER_CROSS_CHECK_FILES)(
    "emits every top-level declaration of %s with the parser's exact line range",
    async (relativePath) => {
      const expected = parserRanges(relativePath);
      const extracted = await extractOutlineSymbols([join(REPO_ROOT, relativePath)]);
      expect(extracted.ok).toBe(true);
      if (!extracted.ok) return;
      const actual = extracted.files[0]?.symbols ?? [];

      const mismatches: string[] = [];
      for (const [name, [expectedStart, expectedEnd]] of expected) {
        const found = actual.find(
          (symbol) => symbol.name === name && symbol.startLine === expectedStart,
        );
        if (found === undefined) {
          mismatches.push(
            `${name}@${expectedStart}: missing (parser says ${expectedStart}-${expectedEnd})`,
          );
          continue;
        }
        if (found.endLine !== expectedEnd) {
          mismatches.push(
            `${name}@${expectedStart}: end line ${found.endLine}, parser says ${expectedEnd}`,
          );
        }
      }

      expect(mismatches).toEqual([]);
      expect(expected.size).toBeGreaterThan(1);
    },
  );
});

// ── scopeKind reclassification cannot misfire ─────────────────────────
//
// `function`/`func` are promoted to `method` only when ctags gives them a
// member scope (`class`/`struct`/`union`/`interface`/`record`). These tests
// pin the negative cases: a free or nested function must never surface as a
// `method`, and a real member must never stay a `function`.
describe.skipIf(!hasCtags)("scopeKind reclassification keeps free functions free", () => {
  it("keeps a C++ namespace function free while promoting class members", async () => {
    expect(await kindNames(cppScopesPath, "function")).toEqual(["freeInNamespace", "freeTopLevel"]);
    expect(await kindNames(cppScopesPath, "method")).toEqual(["count", "increment"]);
  });

  it("promotes out-of-line members, ctors, dtors, and operators but keeps a friend free", async () => {
    expect(await kindNames(cppMemberFormsPath, "function")).toEqual(["buddy"]);
    const methods = await kindNames(cppMemberFormsPath, "method");
    expect(methods).toEqual(
      expect.arrayContaining(["increment", "count", "Widget", "~Widget", "operator =="]),
    );
    expect(methods).not.toContain("buddy");
  });

  it("drops a C++ lambda and keeps namespace/top-level functions free", async () => {
    const symbols = await symbolsFor(cppLambdaPath);
    expect(symbols.some((entry) => entry.name.startsWith("__anon"))).toBe(false);
    expect(await kindNames(cppLambdaPath, "function")).toEqual(["helper", "freeTop"]);
    expect(await kindNames(cppLambdaPath, "method")).toEqual(["run"]);
  });

  it("drops JS and Python closures instead of relabelling them methods", async () => {
    for (const path of [closureJsPath, closurePyPath]) {
      const names = (await symbolsFor(path)).map((entry) => entry.name);
      expect(names, path).not.toContain("inner");
      expect(await kindNames(path, "function"), path).toEqual(["outer", "top"]);
      expect(await kindNames(path, "method"), path).toEqual([]);
    }
    expect((await symbolsFor(closureJsPath)).map((entry) => entry.name)).not.toContain("arrow");
  });

  it("selects Rust impl methods as `method`, the free function as `function`, and drops the impl tag", async () => {
    expect(await kindNames(rustImplPath, "method")).toEqual(
      expect.arrayContaining(["new", "dist", "area", "default"]),
    );
    expect(await kindNames(rustImplPath, "function")).toEqual(["free_fn"]);
    // `implementation` is a no-op: the struct/method rows carry the members.
    expect(await kindNames(rustImplPath, "struct")).toEqual(["Point"]);
    expect(await kindNames(rustImplPath, "field")).toEqual(["x", "y"]);
    expect(await kindNames(rustImplPath, "const")).toEqual(["ORIGIN_X"]);
    const pointKinds = (await symbolsFor(rustImplPath))
      .filter((entry) => entry.name === "Point")
      .map((entry) => entry.kind);
    expect(pointKinds).toEqual(["struct"]);
  });

  it("keeps Go package-level functions free while promoting receivers and interface specs", async () => {
    expect(await kindNames(goRichPath, "function")).toEqual(["TopLevel"]);
    expect(await kindNames(goRichPath, "method")).toEqual(["Greet", "Describe"]);
    expect(await kindNames(goRichPath, "type")).toEqual(["Alias"]);
    expect(await kindNames(goRichPath, "const")).toEqual(["Max"]);
    expect(await kindNames(goRichPath, "interface")).toEqual(["Named"]);
    expect(await kindNames(goRichPath, "field")).toEqual(["ID", "Base", "Label"]);
  });

  it("promotes a PHP class method while keeping a free PHP function free", async () => {
    // PHP is the other language that emits `function` with a `class` scopeKind.
    expect(await kindNames(phpPath, "function")).toEqual(["top"]);
    expect(await kindNames(phpPath, "method")).toEqual(["inc"]);
  });

  // ctags tags a PHP trait method as `function` with `scopeKind: trait`, the
  // same shape as a class/interface member; it must promote to `method`.
  it("promotes a PHP trait method to `method` with its real range", async () => {
    expect(await kindNames(phpTraitPath, "method")).toEqual(["greet", "name"]);
    expect(await kindNames(phpTraitPath, "function")).toEqual([]);

    const symbols = await symbolsFor(phpTraitPath);
    const greet = symbols.find((entry) => entry.name === "greet");
    const name = symbols.find((entry) => entry.name === "name");
    // PHP's ctags parser emits no `end`, so endLine falls back to startLine.
    expect(greet).toMatchObject({ kind: "method", startLine: 3, endLine: 3 });
    expect(name).toMatchObject({ kind: "method", startLine: 4, endLine: 4 });
  });
});

// ── audited no-op kinds ────────────────────────────────────────────────
//
// Each of these ctags kinds has no sensible `OutlineKind`. The tests confirm on
// the real binary that dropping it loses no top-level declaration: the enclosing
// type/namespace/function still appears.
describe.skipIf(!hasCtags)("audited no-op kinds drop only non-declarations", () => {
  it("drops enum members but keeps the enum types (C, TS, C#)", async () => {
    const cases: ReadonlyArray<{ path: string; types: string[]; members: string[] }> = [
      {
        path: enumCPath,
        types: ["Color", "Mode"],
        members: ["RED", "GREEN", "BLUE", "Fast", "Slow"],
      },
      { path: enumTsPath, types: ["Colour", "Fast"], members: ["Red", "Green", "A", "B"] },
      { path: enumCsPath, types: ["Colour"], members: ["Red", "Green"] },
    ];
    for (const { path, types, members } of cases) {
      expect(await kindNames(path, "enum"), path).toEqual(types);
      const names = (await symbolsFor(path)).map((entry) => entry.name);
      for (const member of members) {
        expect(names, `${path} ${member}`).not.toContain(member);
      }
    }
  });

  it("drops Haskell constructors but keeps the data/newtype type names", async () => {
    expect(await kindNames(haskellPath, "type")).toEqual(["Colour", "Wrapper"]);
    const names = (await symbolsFor(haskellPath)).map((entry) => entry.name);
    expect(names).toContain("Colour");
    for (const valueConstructor of ["Red", "Green", "Blue"]) {
      expect(names, valueConstructor).not.toContain(valueConstructor);
    }
  });

  it("drops shell heredoc labels but keeps functions", async () => {
    expect(await kindNames(heredocPath, "function")).toEqual(["greet"]);
    const names = (await symbolsFor(heredocPath)).map((entry) => entry.name);
    expect(names).not.toContain("EOF");
    expect(names).not.toContain("END");
  });

  it("drops the Python `unknown` alias reference but keeps the real function", async () => {
    expect(await kindNames(unknownPyPath, "function")).toEqual(["use"]);
    expect((await symbolsFor(unknownPyPath)).map((entry) => entry.name)).not.toContain("alias");
  });

  it("drops Java and Go package headers", async () => {
    expect((await symbolsFor(packageJavaPath)).map((entry) => entry.name)).not.toContain(
      "com.example.demo",
    );
    expect((await symbolsFor(goPath)).map((entry) => entry.name)).not.toContain("main");
  });
});

// ── newly mapped per-language kinds ────────────────────────────────────
//
// Real-binary coverage for the kinds the audit added: each must reach its
// outline kind through the actual parser output, not just `mapCtagsKind`.
describe.skipIf(!hasCtags)("newly mapped per-language kinds surface on the real binary", () => {
  it("maps Ruby accessors to `property`", async () => {
    expect(await kindNames(rubyAccessorPath, "property")).toEqual([
      "name",
      "name=",
      "age",
      "email=",
    ]);
    expect(await kindNames(rubyAccessorPath, "method")).toEqual([]);
  });

  it("maps JS getters/setters to `property`", async () => {
    expect(await kindNames(jsGetterPath, "property")).toEqual(["current", "current"]);
    expect(await kindNames(jsGetterPath, "method")).toEqual([]);
  });

  it("maps a C# event to `property`", async () => {
    expect(await kindNames(csEventPath, "property")).toEqual(["Changed", "Count"]);
  });

  it("maps Kotlin `typealias` to `type` and `object` to `class`", async () => {
    expect(await kindNames(kotlinPath, "type")).toEqual(["Handler"]);
    expect(await kindNames(kotlinPath, "class")).toEqual(["Singleton", "Widget"]);
  });

  it("maps PHP `define`/`const` to `const`", async () => {
    expect(await kindNames(phpPath, "const")).toEqual(["MAX", "MIN"]);
  });

  it("maps a Java `@interface` to `interface`", async () => {
    expect(await kindNames(javaAnnotationPath, "interface")).toEqual(["Marker"]);
  });

  it("maps OCaml record fields to `field` and `val` to `var`", async () => {
    expect(await kindNames(ocamlPath, "field")).toEqual(["x", "y"]);
    expect(await kindNames(ocamlSigPath, "field")).toEqual(["x", "y"]);
    expect(await kindNames(ocamlSigPath, "var")).toEqual(["add"]);
    expect(await kindNames(ocamlPath, "type")).toEqual(["point"]);
  });

  it("maps Elixir protocol/delegate/guard callables and record kinds", async () => {
    expect(await kindNames(elixirPath, "interface")).toEqual(["Printable"]);
    expect(await kindNames(elixirPath, "function")).toEqual(["print", "size", "is_even", "run"]);
    expect(await kindNames(elixirRecordPath, "struct")).toEqual(["point"]);
  });

  it("pins that a TypeScript accessor is `method` while the backing field is `property`", async () => {
    // TS tags get/set as `method` (ast-grep also refines to method); only the
    // JavaScript parser emits `getter`/`setter`, which map to `property`.
    expect(await kindNames(tsGetterPath, "method")).toEqual(["current", "current"]);
    expect(await kindNames(tsGetterPath, "property")).toEqual(["value"]);
  });
});

// ── reference-only kinds never leak ────────────────────────────────────
//
// C/C++ `header`, Ruby `library`, and Sh `script` are enabled but
// reference-only; `buildCtagsArgs` never passes `--extras=+r`, so they cannot
// reach the parser. These tests pin that the outline stays declaration-only.
describe.skipIf(!hasCtags)("reference-only ctags kinds never leak into the outline", () => {
  it("never emits C `header` reference tags for #include", async () => {
    const names = (await symbolsFor(referenceCPath)).map((entry) => entry.name);
    expect(names).toEqual(["add"]);
    expect(names).not.toContain("stdio.h");
    expect(names).not.toContain("local.h");
  });

  it("never emits Ruby `library` reference tags for require", async () => {
    const names = (await symbolsFor(referenceRbPath)).map((entry) => entry.name);
    expect(names).toContain("Thing");
    expect(names).not.toContain("json");
    expect(names).not.toContain("helper");
  });

  it("never emits a shell `script` tag for a script with no declarations", async () => {
    expect(await symbolsFor(scriptOnlyPath)).toEqual([]);
  });
});
