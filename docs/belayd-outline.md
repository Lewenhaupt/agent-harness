# Read-only symbol outline (`belayd_outline`, bd-115 / bd-118)

Sub-agents used to locate an edit anchor by re-reading a file in `read` offset
windows. Pi's `read` truncates at 2000 lines / 50 KB, so one full pass over
`extensions/index.ts` (~5 k lines, ~198 KB) costs about four calls, and every
"where is the next thing?" question restarts the loop: bd-115's evidence shows
421 `read` calls over that one file across 75 sub-agent sessions, with a 47%
same-path repeat rate in implement sessions.

`belayd_outline` replaces the loop with one call. It is a **read-only,
consult-callable, multi-language** pi tool that returns a compact symbol map
with line ranges for a file, directory, or glob, in line order. It is
registered in `extensions/index.ts` and exported for library consumers from
`src/index.ts`.

bd-115 shipped it on a hand-rolled TypeScript state-machine lexer. bd-118
deleted that lexer and moved extraction onto two real parsers — universal-ctags
for every language ctags knows, ast-grep for the structured signals ctags
cannot express. The tool surface (`path`, `kind`, `name`, `maxSymbols`) is
unchanged.

> **bd-118 breaking change.** The bd-115 `export` kind is gone. It never had an
> extractor behind it, so `export { x } from "./y"` produces no row, and
> `kind: ["export"]` is now rejected with the same `Unknown kind` error as any
> other unknown value instead of silently returning an empty outline.

- [Architecture](#architecture) — extractors, merge rules, name filtering
- [Language coverage](#language-coverage)
- [Kind vocabulary](#kind-vocabulary)
- [Binary requirement and failure modes](#binary-requirement-and-failure-modes)
- [Limits, filters, and interaction notes](#limits-filters-and-interaction-notes)
- [How to Verify](#how-to-verify) — 9 runnable checks, every expected output reproduced from a real run
- [How to Use](#how-to-use) — tool parameters, library API, adding a language

## Architecture

| Concern | Owner | Why |
| --- | --- | --- |
| Declarations for every language ctags recognizes | **universal-ctags**, one process per file set: `ctags --output-format=json --fields=+neKS -f - --map-TypeScript=+.tsx --map-TypeScript=+.mts --map-TypeScript=+.cts --map-JavaScript=+.cjs <files…>` | stable `kind`/`line`, plus `end` where the language parser provides it. The `--map-<LANG>` overrides add the TypeScript-family extensions ctags 6.2.1 leaves as language `NONE`; each override takes exactly one pattern, so every extension is its own argument |
| TypeScript-family declaration ranges | **ast-grep**: `ast-grep scan --inline-rules … --json=stream` | ctags' TypeScript parser emits no `end` line, so ast-grep supplies accurate ranges and refines `const`/`let`, including on `.cjs` |
| `pi.registerTool({ name })` / `pi.on("event", …)` registrations | **ast-grep** | they live inside `belaydAgentHarness`'s function body, invisible to ctags' top-level view |
| kind mapping, filters, 16 KB formatter, target resolver, merge/dedupe | `src/outline.ts` (pure) | shared, testable without binaries |

```text
src/outline.ts          pure layer: kinds, filters, formatter, resolver, merge
src/outline-ctags.ts    buildCtagsArgs + parseCtagsJson (pure) + runCtags
src/outline-ast-grep.ts buildAstGrepRule/Args + parseAstGrepJson (pure) + runAstGrep
src/outline-extract.ts  extractOutlineSymbols: run both, merge, count lines
src/outline-binary.ts   BELAYD_*_BIN resolution + spawn-failure text
```

There is **no hand-rolled lexer** anywhere in `src/`. ast-grep runs once per
language group (`ts`, `tsx`, and `js` for `.cjs`); every other file goes to
ctags only. Neither extractor is a silent catch-all: the accepted extension set
is explicit (`OUTLINE_LANGUAGES`), and a real-binary coverage test fails if an
accepted extension is reachable by neither extractor.

Per file the two sets are merged on a `startLine` + name + kind-identity key.
`const`/`let`/`var`/`function`/`class` collapse into one identity so ast-grep
wins the refinement — ctags' JavaScript parser miskinds an arrow const as
`function` and a generator declaration as `class`, and without the shared
identity the miskinded ctags row would survive as a contradictory twin.
Genuinely distinct kinds on the same line both survive: a `property` and a
`method` (`foo: () => number; foo() {}`), and the `const` and `registerTool`
captures of `const t = pi.registerTool({ name: "t" })`. ast-grep wins the end
line and kind; ctags-only rows (a multi-declarator `const a = 1, b = 2;`, an
interface property, an enum) survive; the result is sorted ascending by start
line then name.

### Name filtering, and its trade-offs

A captured name in a **declaration/lexical** position that is a JS/TS reserved
word is dropped, because a declaration name can never be a reserved word: ctags'
TypeScript parser emits a `constant const` row for a destructuring rename
(`const { const: x } = obj;`) and ast-grep emits a non-identifier `LEXICAL`
capture for the same pattern. Member positions are deliberately **not**
keyword-filtered — `class Access { public = 1; static = 2; const = 1 }` are
legal keyword-named fields and every one is emitted as `property`. ctags' JS
parser also invents an `anonymousObject<hash>` holder tag (kind `variable`) for
an object literal, which is dropped by name prefix.

Two accepted trade-offs, documented rather than fixed:

- A **non-keyword** destructuring key still surfaces as `const` through ctags'
  `constant` kind: `const { foo: bar } = obj;` yields a `foo` row. Filtering by
  name would risk dropping real bindings.
- The `anonymousObject*` noise filter is a prefix match, so a genuine
  identifier with exactly that prefix would be dropped.

## Language coverage

`OUTLINE_LANGUAGES` (exported; 30 extensions):

- **ctags + ast-grep:** `.ts`, `.tsx`, `.mts`, `.cts`, `.cjs`
- **ctags-only:** `.js`, `.jsx`, `.mjs`, `.py`, `.rs`, `.go`, `.rb`, `.java`,
  `.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.cs`, `.php`, `.lua`, `.sh`, `.bash`,
  `.zsh`, `.kt`, `.ex`, `.exs`, `.hs`, `.ml`, `.mli`

universal-ctags itself knows ~150 more languages (add an entry to the table
*and* a `--map-<LANG>` override when ctags does not map the new extension by
default). A single file with an unsupported extension is rejected with the full
supported list; inside a directory walk an unsupported file is skipped.

`.swift` and `.scala` are **not** accepted: this ctags build has no parser for
them, so they always produced an empty outline. They are rejected like any
other unsupported extension rather than silently returning nothing.

Coverage caveat: ctags' C/C++ `prototype` kind is disabled by default, so a
member function *declared* in a header without a body produces no row — only
definitions appear. Java/Go package headers, enum members, Elixir `test` blocks
and similar kinds are dropped deliberately (see the no-op list below), never
misrepresented as declarations.

## Kind vocabulary

`OUTLINE_KINDS` (exported; 19 kinds): `function`, `method`, `class`,
`interface`, `type`, `const`, `let`, `var`, `enum`, `struct`, `union`, `trait`,
`module`, `namespace`, `macro`, `field`, `property`, `registerTool`, `on`.

ctags' long kind names are mapped through an explicit table (`mapCtagsKind`).
`scopeKind` disambiguates the two overloaded kinds ctags emits: `member` with a
class/implementation/trait scope is a `method` (otherwise a `field`), and a
`function`/`func` with a
`class`/`struct`/`union`/`interface`/`record`/`trait` scope is a `method` —
that is how Go methods, C++ member functions, and PHP trait methods (ctags tags
all of them as `function`/`func`) are separated from free functions.
Function-local declarations (`scopeKind: function`) are dropped, so a C++
lambda, a JS closure, and a nested Python `def` never appear.

Kinds with no outline counterpart are listed explicitly as no-ops rather than
silently vanishing: `enumerator`/`enumConstant` (there is no enum-member kind),
`package`/`packageName`, `implementation`, `unknown` (a Python
`from … import` reference), `heredoc`, `callback`, `test`, `exception`,
`constructor`/`Constructor`, and `Exception`. Kinds that were previously
dropped and are now mapped: Ruby `singletonMethod`/`accessor`, Go
`const`/`talias`/`methodSpec`/`anonMember`, PHP `define`, Java `annotation`,
C++ `partition`, Kotlin `typealias`/`object`, C# `event`, JS `getter`/`setter`,
Elixir `delegate`/`guard`/`operator`/`record`/`protocol`, and OCaml
`val`/`RecordField`. TypeScript interface properties and object-literal methods
do appear as `property`/`method` rows.

`export` is removed by bd-118 (see the breaking-change note at the top);
`isOutlineKind("export")` returns `false`.

## Binary requirement and failure modes

Both binaries are external CLIs, **never npm dependencies** (the Nix
`belayd-harness` derivation deliberately does not bundle them, so adding them
as deps would move `fetchPnpmDeps`). `flake.nix` adds `pkgs.universal-ctags`
and `pkgs.ast-grep` to `devShellTools`, which flows into `devShells.default`
and `pi-web-runtime-env` — every spawned agent session has them on PATH.
Resolution order (`src/outline-binary.ts`) is `BELAYD_CTAGS_BIN` /
`BELAYD_AST_GREP_BIN` first, then `ctags` / `ast-grep` on `PATH`.

A missing binary is an error **value**, never a throw. The tool result is plain
text, e.g.:

```text
Cannot run "ctags": not found on PATH (set BELAYD_CTAGS_BIN to override). Install universal-ctags (the devShell provides pkgs.universal-ctags), or set BELAYD_CTAGS_BIN.
```

If there is no TypeScript-family file in the target, ast-grep is not required
and an absent `ast-grep` changes nothing. Extraction runs through an async
`execFile` seam with a hard **15 s** timeout and **32 MB** output buffer per
invocation, so a hung or chatty binary cannot wedge pi's event loop.

Failure classification is field-based, not message-text-based:

| Cause | Text |
| --- | --- |
| binary not found (PATH) | `Cannot run "ctags": not found on PATH (set BELAYD_CTAGS_BIN to override). …` |
| binary not found (override path) | `Cannot run "/nonexistent/ctags": not found. …` |
| wall-clock cap | `Cannot run "…": timed out after 15000 ms.` |
| killed by a signal (`SIGSEGV`, an OOM `SIGKILL`) | `Cannot run "…": killed by SIGSEGV.` |
| non-zero exit with no parseable output | `Cannot run "…": <stderr, or Node's Command failed line>` |

Only `signal === "SIGTERM" && killed === true` is classified as a timeout; any
other signalled death is reported as `killed by <SIG>`, never as a timeout with
the cap as though it were elapsed time. A non-zero exit that still emitted
**parseable** JSON (timeout, buffer overflow, crash after some tags) is a
**degraded success**: the recovered symbols are kept and a
`note: … partial output` line is appended, so a partial result is never
mistaken for a complete one.

`ctags` also shells out to `sort -u` for its default tag ordering, so the
environment that runs the tool needs coreutils' `sort` on `PATH` too (the
devShell and `pi-web-runtime-env` have it). Without it ctags exits non-zero
with `ctags: cannot sort tag file: system ("sort -u") exited with …`, which
surfaces as the last row of the table above.

## Limits, filters, and interaction notes

- Output budget **16 KB** (`OUTLINE_MAX_OUTPUT_BYTES`). The footer — filter
  notes, the file/walk-cap note, any partial-extraction note — is folded into
  the formatted output and reserved up front, so the tool text never exceeds
  the budget. When the body does not fit:
  `note: output truncated at 16384 bytes; narrow with a path/kind/name filter.`
- **200 files** per call (`OUTLINE_MAX_FILES`); **50 000** walk entries
  (`OUTLINE_MAX_WALK_ENTRIES`). The truncation cause is discriminated so the
  note never overstates coverage:
  - `truncatedBy: "file-cap"` reports the true total —
    `note: matched 205 files; showing the first 200.`
  - `truncatedBy: "walk-cap"` knows no true total and does not claim one —
    `note: walk stopped at the entry cap; results may be incomplete.`
- Filters: `kind` (one or more of the vocabulary above), `name`
  (case-insensitive substring), `maxSymbols` (global cap; adds
  `note: symbol output truncated by maxSymbols; narrow with path/kind/name.`).
  Applied filters are echoed in a `filters: kind=…, name~=…` footer line.
- Notes are ordered file/walk-cap → partial extraction → `maxSymbols`, all
  inside the 16 KB budget.
- Directory walks skip dot-directories and `node_modules`/`dist`/`.git`;
  symlinked files/directories are followed with a realpath loop guard.
- Invalid input is reported as text with exit code 1, never a crash:

| Input | Message |
| --- | --- |
| no `path`, or a blank `path` | `path is required (a file, directory, or glob such as src/**/*.ts).` |
| `kind: ["bogus"]` or `["export"]` | `Unknown kind: bogus. Supported kinds: function, method, class, interface, type, const, let, var, enum, struct, union, trait, module, namespace, macro, field, property, registerTool, on.` |
| `maxSymbols: 0` or `1.5` | `maxSymbols must be a positive integer.` |
| non-source file e.g. `AGENTS.md` | `Unsupported file extension: AGENTS.md. Supported: …` |
| path that does not exist | `No such file or directory: nope.ts` |
| glob with no match, e.g. `src/*.zzz` | `No matching source files found.` |

## Read-only guarantee

The whole implementation is `validateOutlineParams` → `resolveOutlineTargets`
(readdir/stat/realpath only) → `extractOutlineSymbols` (spawns ctags/ast-grep,
both read-only) → the pure formatter. It exposes no edit/write/bash path and
never mutates the target;
`src/__tests__/extension-outline-e2e.test.ts` asserts byte-identity on a real
fixture.

## Prompt guidance

Two bullets shipped with the tool (`CODE_EXPLORATION_GUIDANCE` in
`src/agent-registry.ts`; `AGENTS.md` mirrors them and adds a note that editing
this tool shifts `extensions/index.ts` line anchors):

- "Your working directory is already the worktree root — run commands directly,
  never prefix `cd <absolute worktree path> &&`."
- "After an edit, do NOT re-read the file to locate the next anchor — use
  `belayd_outline` for the symbol map or a targeted `grep -n` for text.
  `belayd_outline` is multi-language (universal-ctags + ast-grep) and needs
  `ctags` and `ast-grep` on PATH (the devShell provides them)."

## How to Verify

Run every command from the repository root. The commands that spawn an
extractor need the devShell binaries on `PATH`, so they are wrapped in
`nix develop -c bash -lc '…'`.

The tool needs a live pi session, so the steps below drive the registered tool
directly: a ~30-line script registers the extension's tools against a stub pi
API and calls `belayd_outline.execute`, which runs the real
validation → resolver → ctags + ast-grep → formatter path.

### 1. Binaries and static checks

Confirm the binaries the tool will find:

```bash
nix develop -c bash -lc 'which ctags ast-grep; ctags --version | head -1; ast-grep --version'
```

```text
/nix/store/…-universal-ctags-6.2.1/bin/ctags
/nix/store/…-ast-grep-0.45.0/bin/ast-grep
Universal Ctags 6.2.1, Copyright (C) 2015-2025 Universal Ctags Team
ast-grep 0.45.0
```

Then the tests and build gates. The focused set covers the pure layer, both
JSON parsers, the failure paths, the truncation notes, and the real registered
tool:

```bash
nix develop -c pnpm vitest run \
  src/__tests__/outline.test.ts \
  src/__tests__/outline-extract.test.ts \
  src/__tests__/outline-spawn.test.ts \
  src/__tests__/extension-outline-tool.test.ts \
  src/__tests__/extension-outline-notes.test.ts \
  src/__tests__/extension-outline-e2e.test.ts
```

Expected: `Test Files 6 passed (6)` and `Tests 138 passed (138)`
(56 + 53 + 11 + 11 + 4 + 3). `outline.test.ts` never spawns a binary;
`outline-spawn.test.ts` drives the failure paths with tiny fake scripts;
`outline-extract.test.ts` (53) and the success case in
`extension-outline-e2e.test.ts` spawn the real CLIs. In a shell without
`ctags`/`ast-grep` those 54 tests skip instead of failing, so the suite stays
green in a bare environment.

```bash
nix develop -c pnpm test              # 75 files, 1695 tests passed
nix develop -c pnpm test:integration  # 5 files, 58 tests passed
nix develop -c pnpm typecheck
nix develop -c pnpm lint              # Checked 138 files … No fixes applied.
nix develop -c pnpm build
```

### 2. Install the driver

```bash
cat > /tmp/belayd-outline-tool.ts <<'TS'
// Run with: node_modules/.bin/jiti /tmp/belayd-outline-tool.ts '<params JSON>' [cwd]
interface OutlineToolResult {
  content: Array<{ text: string }>;
  details: { exitCode: number };
}
interface OutlineTool {
  execute: (...args: unknown[]) => Promise<OutlineToolResult>;
}

const repo = process.env.BELAYD_REPO ?? process.cwd();
const mod = (await import(`${repo}/extensions/index.ts`)) as { default: (api: unknown) => void };

const tools = new Map<string, OutlineTool>();
const api = {
  registerTool: (def: OutlineTool & { name: string }) => tools.set(def.name, def),
  registerCommand: () => {},
  on: () => {},
  sendMessage: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
  events: { emit: () => {}, on: () => () => {} },
};
mod.default(api);

const tool = tools.get("belayd_outline");
if (tool === undefined) throw new Error("belayd_outline was not registered");

const result = await tool.execute("doc", JSON.parse(process.argv[2] ?? "{}"), undefined, undefined, {
  cwd: process.argv[3] ?? repo,
});
console.log(result.content.map((part) => part.text).join("\n"));
console.error(`[exitCode=${result.details.exitCode}]`);
process.exit(result.details.exitCode ?? 0);
TS
```

Every invocation prints the extension's own banner on stderr first, then the
tool text:

```text
[belayd-harness] registering tools/commands from file://…/extensions/index.ts
```

Set the two variables used below (`jiti` transpiles the TypeScript extension on
load, so no build step is needed for this driver):

```bash
export BELAYD_REPO=$(pwd)
J=$BELAYD_REPO/node_modules/.bin/jiti
T=/tmp/belayd-outline-tool.ts
```

### 3. Outline a real file

```bash
nix develop -c bash -lc "$J $T '{\"path\":\"extensions/index.ts\"}'" | head -6
```

Observed head on this branch (line numbers drift as the file grows):

```text
/home/…/extensions/index.ts (5041 lines)
  157-157  type          ModelTelemetryStore
  158-158  type          ModelTelemetryTotals
  199-217  interface     RunQualityGateOptions [exported]
  200-200  property      agent
  201-201  property      result
```

Assert the structure, not the counts: one header `<absolute path> (<N> lines)`,
then rows ascending by start line formatted
`  <start>-<end>  <kind>  <name>[ [exported]]`. The map is tiny compared with
the source:

```bash
nix develop -c bash -lc "$J $T '{\"path\":\"extensions/index.ts\"}'" 2>/dev/null | wc -c   # 11242
wc -c extensions/index.ts                                                                  # 198351
```

`belaydAgentHarness` is one `function` row spanning to the end of the file, with
the registrations resolving inside its body:

```bash
nix develop -c bash -lc "$J $T '{\"path\":\"extensions/index.ts\"}'" 2>/dev/null \
  | grep -E "belaydAgentHarness|registerTool  belayd_(outline|status|commit)"
```

```text
  1101-5040  function      belaydAgentHarness [exported]
  3850-3894  registerTool  belayd_status
  4070-4115  registerTool  belayd_outline
  4869-4953  registerTool  belayd_commit
```

Their ranges come from ast-grep, not ctags, so they move with every edit above
them.

### 4. One directory, three languages

This is the headline change: the same call parses Python, Go and C++ through
ctags, and TypeScript through ctags + ast-grep.

```bash
D=$(mktemp -d)
mkdir -p "$D/polyglot"
cat > "$D/polyglot/lib.py" <<'PY'
class Greeter:
    def hello(self, name):        # method
        return f"hi {name}"

    @staticmethod
    def build():                  # method
        return Greeter()

def top_level(value):             # function
    return value * 2
PY
cat > "$D/polyglot/shapes.go" <<'GO'
package shapes

type Point struct {
	X int
	Y int
}

func (p Point) Sum() int {        // method: scopeKind=struct
	return p.X + p.Y
}

func Add(a int, b int) int {      // function: scopeKind=package
	return a + b
}
GO
cat > "$D/polyglot/shapes.cpp" <<'CPP'
class Shape {
public:
    double area() const {         // method: scopeKind=class
        return 0.0;
    }
};

int freeFunction(int a) {         // function
    return a + 1;
}
CPP
cat > "$D/polyglot/harness.ts" <<'TS'
export function belaydAgentHarness(pi: ToolHost): void {
  pi.registerTool({ name: "belayd_outline" });
  pi.on("tool_call", async () => {});
}
TS
nix develop -c bash -lc "$J $T '{\"path\":\".\"}' $D/polyglot"
```

Observed — one header per file, lexicographic order:

```text
/tmp/…/polyglot/harness.ts (5 lines)
  1-4  function      belaydAgentHarness [exported]
  2-2  registerTool  belayd_outline
  3-3  on            tool_call
/tmp/…/polyglot/lib.py (11 lines)
  1-7  class         Greeter
  2-3  method        hello
  6-7  method        build
  9-10  function      top_level
/tmp/…/polyglot/shapes.cpp (11 lines)
  1-6  class         Shape
  3-5  method        area
  8-10  function      freeFunction
/tmp/…/polyglot/shapes.go (15 lines)
  3-6  struct        Point
  4-4  field         X
  5-5  field         Y
  8-10  method        Sum
  12-14  function      Add
[exitCode=0]
```

What to check:

- Python class/method/function and Go struct/fields all appear, with ranges and
  `end` lines from ctags where the language parser has them.
- Go's `func (p Point) Sum` is a `method` (scope is the `Point` struct), while
  `func Add` is a `function` (scope is the package). The same `scopeKind` rule
  separates C++'s `Shape::area` from `freeFunction`.
- A header-only C++ declaration would **not** appear: ctags' `prototype` kind is
  off by default, so only definitions get rows.
- `kind` filters work across languages:

```bash
nix develop -c bash -lc "$J $T '{\"path\":\".\",\"kind\":[\"method\"]}' $D/polyglot"
```

Observed: exactly the four methods (`hello`, `build`, `area`, `Sum`), a header
with `(no matching symbols)` where a file matched nothing, and a
`filters: kind=method` footer.

### 5. Why ast-grep is still needed

Raw ctags sees only the enclosing function; the registrations live inside its
body:

```bash
nix develop -c bash -lc "ctags --output-format=json --fields=+neKS -f - --map-TypeScript=+.tsx --map-TypeScript=+.mts --map-TypeScript=+.cts --map-JavaScript=+.cjs $D/polyglot/harness.ts"
```

Observed — one tag, no `end`, no `registerTool`/`on` rows:

```text
{"_type": "tag", "name": "belaydAgentHarness", "path": "/tmp/…/harness.ts", "pattern": "/^export function belaydAgentHarness(pi: ToolHost): void {$/", "line": 1, "kind": "function"}
```

Through the tool the same file yields `1-4 function belaydAgentHarness
[exported]`, `2-2 registerTool belayd_outline`, `3-3 on tool_call` (step 4), and
on `extensions/index.ts` every `belayd_*` tool surfaces as a `registerTool` row
(step 3).

### 6. Filters and the output budget

```bash
nix develop -c bash -lc "$J $T '{\"path\":\"extensions/index.ts\",\"kind\":[\"registerTool\"]}'" | tail -1
nix develop -c bash -lc "$J $T '{\"path\":\"extensions/index.ts\",\"name\":\"belayd_\"}'" | tail -1
nix develop -c bash -lc "$J $T '{\"path\":\"extensions/index.ts\",\"maxSymbols\":3}'" | tail -1
```

```text
filters: kind=registerTool
filters: name~=belayd_
note: symbol output truncated by maxSymbols; narrow with path/kind/name.
```

Overflow the 16 KB budget with the whole `src` tree (114 `.ts` files, most of
which do not fit):

```bash
nix develop -c bash -lc "$J $T '{\"path\":\"src/**/*.ts\"}'" 2>/dev/null | tail -1
```

```text
note: output truncated at 16384 bytes; narrow with a path/kind/name filter.
```

The file list is not truncated here (`114` files is below the 200-file cap), so
`truncated` stays `false`; the byte clip is a separate, independent note.

Check the keyword/noise filters neither over- nor under-shoot:

```bash
F=$(mktemp -d)
cat > "$F/members.ts" <<'TS'
export class Access {
  public = 1;
  static = 2;
  interface = 3;
  const = 1;
}
TS
cat > "$F/destructure.ts" <<'TS'
const a = 1;
const { const: renamed } = obj;
const { foo: bar } = obj;
TS
cat > "$F/quirks.cjs" <<'JS'
const arrow = (x) => x + 1;

function* Producer() {
  yield 1;
}
JS
nix develop -c bash -lc "$J $T '{\"path\":\".\"}' $F"
```

Observed — keyword-named class members survive as `property`, the keyword
destructuring rename is dropped, the non-keyword destructuring key `foo` still
surfaces (the documented trade-off), and the `.cjs` arrow/generator twins
collapse to one row each:

```text
/tmp/…/destructure.ts (4 lines)
  1-1  const         a
  3-3  const         foo
/tmp/…/members.ts (7 lines)
  1-6  class         Access [exported]
  2-2  property      public
  3-3  property      static
  4-4  property      interface
  5-5  property      const
/tmp/…/quirks.cjs (6 lines)
  1-1  const         arrow
  3-5  function      Producer
[exitCode=0]
```

### 7. Failure modes

Each case below creates a fake `ctags` and shows what the tool renders.

**Partial output** — exit 1 after emitting one valid tag:

```bash
P=$(mktemp -d)
printf 'export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n' > "$P/a.ts"
cat > "$P/fake-ctags" <<'EOS'
#!/bin/sh
for last; do :; done
printf '{"_type":"tag","name":"alpha","path":"%s","pattern":"/^export function alpha() {$/","line":1,"kind":"function"}\n' "$last"
exit 1
EOS
chmod +x "$P/fake-ctags"
nix develop -c bash -lc "BELAYD_CTAGS_BIN=$P/fake-ctags $J $T '{\"path\":\"a.ts\"}' $P"
```

Observed — the recovered symbols are kept (the rest came from ast-grep) and the
degradation is stated, with `[exitCode=0]`:

```text
/tmp/…/a.ts (8 lines)
  1-3  function      alpha [exported]
  5-7  function      beta [exported]
note: ctags exited early before completing; the outline lists only the symbols recovered from its partial output.
[exitCode=0]
```

If the fake binary prints **no** parseable JSON the run hard-fails with
`Cannot run "<binary>": Command failed: …` and `[exitCode=1]`.

**Signal death** — a crashed parser is never reported as a timeout:

```bash
cat > "$P/segv-ctags" <<'EOS'
#!/bin/sh
kill -SEGV $$
EOS
chmod +x "$P/segv-ctags"
nix develop -c bash -lc "BELAYD_CTAGS_BIN=$P/segv-ctags $J $T '{\"path\":\"a.ts\"}' $P"
```

```text
Cannot run "/tmp/…/segv-ctags": killed by SIGSEGV.
[exitCode=1]
```

**Wall-clock cap.** The tool's cap is hardcoded at 15 s, so exercise the same
classification with the library's injectable timeout:

```bash
cat > "$P/slow-ctags" <<'EOS'
#!/bin/sh
sleep 30
EOS
chmod +x "$P/slow-ctags"
nix develop -c bash -lc "node --input-type=module -e '
const { extractOutlineSymbols } = await import(\"file://$BELAYD_REPO/dist/src/outline-extract.js\");
const r = await extractOutlineSymbols([\"$P/a.ts\"], {
  env: { ...process.env, BELAYD_CTAGS_BIN: \"$P/slow-ctags\" },
  ctagsTimeoutInMs: 500,
});
console.log(JSON.stringify(r));
'"
```

```text
{"ok":false,"error":"Cannot run \"/tmp/…/slow-ctags\": timed out after 500 ms."}
```

With the real cap the text reads `timed out after 15000 ms.`

**Missing binaries.**

```bash
nix develop -c bash -lc "BELAYD_CTAGS_BIN=/nonexistent/ctags $J $T '{\"path\":\"extensions/index.ts\"}'"
nix develop -c bash -lc "BELAYD_AST_GREP_BIN=/nonexistent/ast-grep $J $T '{\"path\":\"extensions/index.ts\"}'"
```

```text
Cannot run "/nonexistent/ctags": not found. Install universal-ctags (the devShell provides pkgs.universal-ctags), or set BELAYD_CTAGS_BIN.
Cannot run "/nonexistent/ast-grep": not found. Install ast-grep (the devShell provides pkgs.ast-grep), or set BELAYD_AST_GREP_BIN.
```

A missing `PATH` entry (rather than a bad override) produces the other wording.
This one goes through the library so the `PATH` the resolver sees can be
controlled; re-run `pnpm build` first if `dist/` is stale:

```bash
nix develop -c bash -lc 'node --input-type=module -e "
const { extractOutlineSymbols } = await import(\"file://'$(pwd)'/dist/src/outline-extract.js\");
const r = await extractOutlineSymbols([\"extensions/index.ts\"], { env: { PATH: \"/nonexistent\" } });
console.log(JSON.stringify(r));
"'
```

```text
{"ok":false,"error":"Cannot run \"ctags\": not found on PATH (set BELAYD_CTAGS_BIN to override). Install universal-ctags (the devShell provides pkgs.universal-ctags), or set BELAYD_CTAGS_BIN."}
```

A Python-only target does **not** need ast-grep:

```bash
printf 'def ok():\n    pass\n' > "$P/only.py"
nix develop -c bash -lc "BELAYD_AST_GREP_BIN=/nonexistent/ast-grep $J $T '{\"path\":\"only.py\"}' $P"
```

Observed: the `ok` row and `[exitCode=0]`.

### 8. Error values, globs, and the truncation notes

```bash
nix develop -c bash -lc "$J $T '{}'"                                        # path is required (…)
nix develop -c bash -lc "$J $T '{\"path\":\"extensions/index.ts\",\"kind\":[\"export\"]}'"
nix develop -c bash -lc "$J $T '{\"path\":\"extensions/index.ts\",\"maxSymbols\":0}'"
nix develop -c bash -lc "$J $T '{\"path\":\"AGENTS.md\"}'"
nix develop -c bash -lc "$J $T '{\"path\":\"src/*.zzz\"}'"
nix develop -c bash -lc "$J $T '{\"path\":\"nope.ts\"}'"
```

Observed, each with `[exitCode=1]`:

```text
path is required (a file, directory, or glob such as src/**/*.ts).
Unknown kind: export. Supported kinds: function, method, class, interface, type, const, let, var, enum, struct, union, trait, module, namespace, macro, field, property, registerTool, on.
maxSymbols must be a positive integer.
Unsupported file extension: AGENTS.md. Supported: .ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs, .py, .rs, .go, .rb, .java, .c, .h, .cc, .cpp, .hpp, .cs, .php, .lua, .sh, .bash, .zsh, .kt, .ex, .exs, .hs, .ml, .mli.
No matching source files found.
No such file or directory: nope.ts
```

This is also the `.swift`/`.scala` behavior: they are simply absent from the
supported list, so `{"path": "a.swift"}` returns the same
`Unsupported file extension` error. `isOutlineKind("export")` returns `false`
and `OUTLINE_KINDS.length` is `19`:

```bash
nix develop -c bash -lc 'node --input-type=module -e "
const m = await import(\"file://'$(pwd)'/dist/src/index.js\");
console.log(\"isOutlineKind(export):\", m.isOutlineKind(\"export\"));
console.log(\"kinds:\", m.OUTLINE_KINDS.length);
"'
```

Globs and directory pruning:

```bash
nix develop -c bash -lc "$J $T '{\"path\":\"src/*.ts\"}'" 2>/dev/null | grep -c "^/"        # 10
nix develop -c bash -lc "$J $T '{\"path\":\"src/**/*.ts\"}'" 2>/dev/null | grep -c "^/"     # 14 of 114 (16 KB clip)
nix develop -c bash -lc "$J $T '{\"path\":\"src/archify*.ts\"}'" 2>/dev/null | grep "^/"    # src/archify.ts only
```

`node_modules`, `dist`, `.git` and dot-directories are never walked
(`src/__tests__/outline.test.ts` covers the pruning rules).

Truncation notes. A file cap needs 201+ matching files:

```bash
C=$(mktemp -d)
for i in $(seq -w 1 205); do printf 'def f%s():\n    pass\n' "$i" > "$C/m$i.py"; done
nix develop -c bash -lc "$J $T '{\"path\":\".\"}' $C" 2>/dev/null | tail -1
```

```text
note: matched 205 files; showing the first 200.
```

A walk cap needs more than 50 000 walked entries (takes about 2 s):

```bash
W=$(mktemp -d)
( cd "$W" && seq -f 'f%06g.py' 1 55000 | xargs -n 200 touch )
nix develop -c bash -lc "$J $T '{\"path\":\".\"}' $W" 2>/dev/null | tail -1
```

```text
note: walk stopped at the entry cap; results may be incomplete.
```

### 9. Read-only and gate wiring

```bash
sha256sum extensions/index.ts > /tmp/outline-before.sha
nix develop -c bash -lc "$J $T '{\"path\":\"extensions/index.ts\"}'" > /dev/null
sha256sum -c /tmp/outline-before.sha
```

Expected: `extensions/index.ts: OK`.

```bash
grep -n "const GATED_TOOLS" -A 16 extensions/index.ts          # "belayd_outline" present
grep -n "const PLANNING_GATED_TOOLS" -A 6 extensions/index.ts  # absent
grep -c '"belayd_outline"' src/agent-registry.ts               # 9 (one per default agent)
```

Live equivalent: start a task and call `belayd_outline` — no process-gate
rejection. Start planning mode and the tool is not in the active set.

## How to Use

Inside a pi session the tool is available in all 9 default agents and in
`GATED_TOOLS`, so it stays callable while a workflow phase gate is active. It is
**not** in `PLANNING_GATED_TOOLS`, so it is unavailable in planning mode. It is
consult-callable and never required by a phase ordering.

### Tool parameters

| Param | Required | Meaning |
| --- | --- | --- |
| `path` | yes | file, directory, or glob (`*`, `?`, `**`; brace expansion and character classes are not supported) |
| `kind` | no | one or more of the 19 kinds; unknown values are rejected with the full list |
| `name` | no | case-insensitive substring match on the symbol name |
| `maxSymbols` | no | global cap across all files; a positive integer |

```json
{
  "path": "extensions/index.ts",
  "kind": ["function", "method"],
  "name": "belayd_",
  "maxSymbols": 40
}
```

Typical calls:

- `{"path": "extensions/index.ts"}` — full map of one file.
- `{"path": "src/**/*.ts", "kind": ["class"]}` — every class in the tree.
- `{"path": "src", "name": "outline", "maxSymbols": 20}` — walk a directory and
  keep the first 20 name matches.
- `{"path": "shapes.go", "kind": ["method"]}` — Go receiver methods only.

Read the footer, not just the body: `filters: …` echoes what was applied, and
`note: …` warns when the file list was capped, the walk stopped, an extractor
returned partial output, or `maxSymbols` clipped the list. Treat any `note:`
line as "this is not the whole answer — narrow the path or filter".

### Outside a pi session (library API)

The package re-exports the whole layer from `src/index.ts`:

```typescript
import {
  extractOutlineSymbols, // runs ctags + ast-grep, returns { ok, files } | { ok: false, error }
  formatOutline,         // 16 KB-bounded text rendering
  outlineFiles,          // pure filtering (kind / nameMatches / maxSymbols)
  resolveOutlineTargets, // file / dir / glob → sorted source file list
} from "belayd-agent-harness";

const resolved = resolveOutlineTargets(process.cwd(), "src/outline-ctags.ts");
if (!resolved.ok) throw new Error(resolved.error);

const extracted = await extractOutlineSymbols(resolved.files);
if (!extracted.ok) throw new Error(extracted.error);

console.log(formatOutline(outlineFiles(extracted.files, { kind: ["function"] })));
```

That prints, for this repository:

```text
/home/…/src/outline-ctags.ts (402 lines)
  42-46  function      ctagsMapArgs
  86-89  function      isCtagsJsTsPath
  98-102  function      isCtagsNoise
  121-123  function      buildCtagsArgs [exported]
  135-251  function      mapCtagsKind [exported]
  …
filters: kind=function
```

Inside this repository, import from `./dist/src/index.js` instead — that is what
the timeout step above does. The same module also exports `isOutlineKind`,
`isOutlineSupportedFile`, `mergeOutlineSymbols`, `OUTLINE_KINDS`,
`OUTLINE_LANGUAGES`, `OUTLINE_FILE_EXTENSIONS`, `OUTLINE_TS_EXTENSIONS`,
`OUTLINE_MAX_FILES`, `OUTLINE_MAX_OUTPUT_BYTES`, `OUTLINE_MAX_WALK_ENTRIES`,
`outlineAstGrepLanguage`, and the low-level extractors (`buildCtagsArgs` /
`parseCtagsJson` / `runCtags`, `buildAstGrepRule` / `buildAstGrepArgs` /
`parseAstGrepJson` / `runAstGrep`, `resolveOutlineBinary` /
`spawnOutlineBinary`, `mapCtagsKind`) for consumers that want to drive one
parser directly or unit-test a parser against captured output.

To reuse a captured symbol set without re-running the parsers, call
`formatOutline(outlineFiles(files, options))` directly; it is pure and bounded.

### Adding a language

1. Add `{ extension: ".xy", ctags: "<CtagsLanguageName>" }` to
   `OUTLINE_LANGUAGES` in `src/outline.ts`. Add `astGrep: "ts" | "tsx" | "js"`
   only if the file is TypeScript-family.
2. If ctags 6.2.1 does not map `.xy` by default, add an entry to
   `OUTLINE_CTAGS_MAP_OVERRIDES` in `src/outline-ctags.ts` — a **separate**
   `--map-<LANG>=+.xy` argument per extension, because the comma-list form is
   mis-parsed by 6.2.1.
3. If the new language emits a ctags kind with no outline counterpart, either
   map it in `mapCtagsKind` or add it to the explicit no-op arm with a comment
   explaining why it is dropped.
4. The real-binary coverage test fails if an accepted extension is reachable by
   neither extractor, so a half-wired language cannot land.
