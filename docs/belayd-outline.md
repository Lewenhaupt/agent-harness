# Read-only symbol outline (`belayd_outline`, bd-115)

Sub-agents used to locate an edit anchor by re-reading a file in `read` offset
windows. Pi's `read` truncates at 2000 lines / 50 KB, so one full pass over
`extensions/index.ts` (~4.6k lines, ~173 KB) costs about four calls, and every
"where is the next thing?" question restarts the loop: bd-115's evidence shows
421 `read` calls over that one file across 75 sub-agent sessions, with a 47%
same-path repeat rate in implement sessions.

`belayd_outline` replaces the loop with one call. It is a **read-only,
consult-callable** pi tool that returns a compact symbol map with line ranges
for one TypeScript file, a directory, or a glob: top-level
functions/consts/classes/types/interfaces/enums plus `pi.registerTool` / `pi.on`
registrations, in line order. It is registered in `extensions/index.ts`
(`pi.registerTool({ name: "belayd_outline", … })`), built on the
dependency-free scanner in `src/outline.ts`, and exported for library consumers
from `src/index.ts`.

Deliberately **not** used here: the `typescript` compiler API. `typescript` is a
devDependency and is not bundled into the Nix `belayd-harness` derivation, so a
compiler-API import would break the packaged extension at runtime.
`src/outline.ts` walks the raw source with a small state-machine lexer instead.

Two prompt bullets shipped with it (`CODE_EXPLORATION_GUIDANCE` in
`src/agent-registry.ts`, mirrored in `AGENTS.md`):

- "Your working directory is already the worktree root — run commands directly,
  never prefix `cd <absolute worktree path> &&`."
- "After an edit, do NOT re-read the file to locate the next anchor — use
  `belayd_outline` for the symbol map or a targeted `grep -n` for text."

## How to Verify

Run everything from the repository root.

### 1. Tests, typecheck, lint, build

```bash
pnpm vitest run \
  src/__tests__/outline.test.ts \
  src/__tests__/extension-outline-tool.test.ts \
  src/__tests__/extension-outline-notes.test.ts
```

Expected: `3 passed (3)` test files, `54 passed (54)` tests.

```bash
pnpm test
```

Expected: `64 passed (64)` files, `1369 passed (1369)` tests.

```bash
pnpm typecheck && pnpm lint && pnpm build
```

Expected: each exits 0.

### 2. Outline a real file (no pi session needed)

`src/outline.ts` is dependency-free TypeScript and the repo requires Node
`>=23.6.0`, which strips types by default — so the scanner can be driven
directly. Create a throwaway driver once (later steps reuse it):

```bash
cat > /tmp/belayd-outline.mjs <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(join(process.cwd(), "src/outline.ts")).href;
const { resolveOutlineTargets, outlineFiles, formatOutline } = await import(moduleUrl);

const target = process.argv[2] ?? "extensions/index.ts";
const resolved = resolveOutlineTargets(process.cwd(), target);
if (!resolved.ok) {
  console.error(`ERROR: ${resolved.error}`);
  process.exit(1);
}
const files = resolved.files.map((path) => ({ path, source: readFileSync(path, "utf8") }));
const text = formatOutline(outlineFiles(files));
console.log(text);
console.error(
  `[files=${resolved.files.length} bytes=${Buffer.byteLength(text, "utf8")} truncated=${resolved.truncated}]`,
);
EOF

node /tmp/belayd-outline.mjs extensions/index.ts
```

Expected (assert structure — do not pin exact counts, the file keeps growing):

- Header `<absolute worktree path>/extensions/index.ts (<N> lines)`, `N` ≈ 4632.
- One row per symbol, **ascending by start line**, formatted as
  `  <start>-<end>  <kind>  <name>[ [exported]]`, e.g.
  `  167-181  interface     RunQualityGateOptions [exported]`.
- Roughly 73 rows: ~51 top-level declarations plus ~22 `registerTool` / `on`
  registration rows.
- Total output ≈ 3.5 KB (3,590 bytes when measured on this branch), not 173 KB.
- Specific well-known symbols are present with plausible ranges:
  `belaydAgentHarness` as `function` (958-4631), `belayd_status` and
  `belayd_outline` as `registerTool`, `belayd_commit` as the last
  `registerTool`, then four `on` rows (`tool_call`, `tool_call`, `agent_end`,
  `agent_end`).
- No nested helper is listed: declarations inside `belaydAgentHarness` are
  excluded, except the `pi.registerTool` / `pi.on` registrations, which are
  emitted at any depth because plugin entry points register inside that
  function.

Spot-check just the anchors:

```bash
node /tmp/belayd-outline.mjs extensions/index.ts | grep -E "belaydAgentHarness|belayd_outline|belayd_status|belayd_commit"
```

### 3. Same thing through the live tool

The tool only exists inside a session that has the harness extension loaded:

```bash
pi install -l "$PWD"
pi
```

Then ask the agent to call `belayd_outline` with `path: "extensions/index.ts"`
(or issue the tool call yourself). Expected: the same ordered rows and line
ranges as step 2, and a tool description that lists all four scanned
extensions (`.ts`, `.tsx`, `.mts`, `.cts`).

### 4. Survives the process gate, absent from planning mode

Static source of truth (`extensions/index.ts`):

```bash
grep -n "const GATED_TOOLS" -A 16 extensions/index.ts
grep -n "const PLANNING_GATED_TOOLS" -A 6 extensions/index.ts
```

Expected: `"belayd_outline"` appears in `GATED_TOOLS` (so it stays callable
while the gate is active, alongside `belayd_status`, `read`, `grep`, `bd`, …)
and does **not** appear in `PLANNING_GATED_TOOLS`.

Live checks:

1. Start a task (`/belayd bd-115 --no-worktree`, or the `belayd_start_task`
   tool) and ask the agent to call `belayd_outline` on `src/outline.ts`.
   Expected: it returns a symbol map — no process-gate rejection. It is
   consult-callable at any phase and never a required workflow step.
2. Start planning mode (`/plan "outline large files"`) and try the same call.
   Expected: `belayd_outline` is not in the active tool set, so the call is
   unavailable (planning mode deliberately exposes only
   `PLANNING_GATED_TOOLS`).

Unit-level equivalents if you want them pinned:
`src/__tests__/extension-outline-tool.test.ts` →
"keeps belayd_outline available while the process gate is active (GATED_TOOLS)"
and "excludes belayd_outline from the planning-mode tool set
(PLANNING_GATED_TOOLS)". Also confirm every default agent is offered the tool:

```bash
grep -c '"belayd_outline"' src/agent-registry.ts   # expected: 9 (one per default agent)
```

### 5. Read-only: the target file is byte-identical afterwards

```bash
sha256sum extensions/index.ts > /tmp/outline-before.sha
node /tmp/belayd-outline.mjs extensions/index.ts > /dev/null
node /tmp/belayd-outline.mjs extensions/index.ts > /dev/null
sha256sum -c /tmp/outline-before.sha
```

Expected: `extensions/index.ts: OK` — unchanged across repeated runs.

There is no edit/write/bash path in the tool. Its whole implementation is
`validateOutlineParams` → `resolveOutlineTargets` (readdir/stat/realpath only)
→ `readFileSync` → the pure formatter/`outlineFiles`. The test
"registers the tool and returns a symbol map without mutating the file" asserts
byte-identity on a fixture file.

### 6. Filters

The driver above applies no filters; use a live session, or a one-off variant,
to exercise `kind` / `name` / `maxSymbols` exactly as the tool does:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const m = await import("./src/outline.ts");
const r = m.resolveOutlineTargets(process.cwd(), "extensions/index.ts");
if (!r.ok) { console.error(r.error); process.exit(1); }
const files = r.files.map((p) => ({ path: p, source: readFileSync(p, "utf8") }));
console.log(m.formatOutline(m.outlineFiles(files, { kind: ["registerTool"] })));
' | tail -3
```

Expected footer line: `filters: kind=registerTool`. Same shape for
`{ nameMatches: "belayd_" }` → footer `filters: name~=belayd_`, and for
`{ maxSymbols: 3 }` → exactly three symbol rows plus
`note: symbol output truncated by maxSymbols; narrow with path/kind/name.`

Invalid input is reported as text with exit code 1, never a crash:

| Input | Expected message |
| --- | --- |
| no `path` | `path is required (a file, directory, or glob such as src/**/*.ts).` |
| `kind: ["bogus"]` | `Unknown kind: bogus. Supported kinds: function, const, let, var, class, type, interface, enum, export, registerTool, on.` |
| `maxSymbols: 0` or `1.5` | `maxSymbols must be a positive integer.` |
| non-TS file `AGENTS.md` | `Unsupported file extension: AGENTS.md. Supported: .ts, .tsx, .mts, .cts.` |
| `src/nope.ts` | `No such file or directory: src/nope.ts` |
| `src/*.zzz` | `No matching TypeScript files found.` |

The first three come from `validateOutlineParams` in `extensions/index.ts` (tool
only); the last three come from `resolveOutlineTargets` and are reproducible
with the step 2 driver, e.g.:

```bash
node /tmp/belayd-outline.mjs AGENTS.md   # ERROR: Unsupported file extension: …
```

### 7. Directory and glob targets

```bash
node /tmp/belayd-outline.mjs "src/archify*.ts"   # single-segment glob -> src/archify.ts header
node /tmp/belayd-outline.mjs "src/**/*.ts"       # recursive glob
node /tmp/belayd-outline.mjs src                 # bare directory walk
```

Expected: one `<absolute path> (<N> lines)` header per file, that file's symbols
beneath it, files sorted lexicographically, and `node_modules`/`dist`/`.git` plus
dot-directories never walked. `src` and `src/**/*.ts` both report
`[files=94 bytes=… truncated=false]` on stderr on this branch — same set, both
complete.

### 8. Truncation notes are honest

The output budget is 16 KB. Outline the whole `src/` tree:

```bash
node /tmp/belayd-outline.mjs "src/**/*.ts" 2>&1 | tail -2
```

Expected: the footer note
`note: output truncated at 16384 bytes; narrow with a path/kind/name filter.`
appears (just above the stderr `[files=…]` summary), and there are fewer
than 94 file headers (≈50 on this branch) — proof the bound is real.

The two resolver caps print **different** notes, and only the tool (not
`formatOutline`) appends them. The file cap is reproducible by hand — make 201
files, then ask the live tool for that directory:

```bash
mkdir -p /tmp/ol201 && for i in $(seq 1 201); do echo "export const s$i = $i;" > "/tmp/ol201/f$i.ts"; done
```

In a pi session: `belayd_outline path="/tmp/ol201"`. Expected: 200 file headers
plus `note: matched 201 files; showing the first 200.`

The **walk cap** (50,000 directory entries) cannot be reproduced by hand —
`OUTLINE_MAX_WALK_ENTRIES` is not a tool parameter. Its note is
`note: walk stopped at the entry cap; results may be incomplete.` and it is
covered by `src/__tests__/extension-outline-notes.test.ts` ("prints the walk-cap
note and never the file-cap wording") plus the resolver tests "stops a directory
walk at the injectable entry cap and reports the walk-cap cause" and "reports
the file-cap cause with the true match count when more than OUTLINE_MAX_FILES
match". The distinction matters: a walk-capped result never computed a true
match total, so it must not claim "matched N files".

Clean up: `rm -rf /tmp/ol201 /tmp/outline-before.sha /tmp/belayd-outline.mjs`.

### 9. Acceptance caveat

bd-115's "measured read calls on `extensions/index.ts` drop on a comparable
implement run" is a **post-merge behavioural measurement**. No before/after
number appears in this document and none can be produced by the checks above —
compare `read` tool-call counts in session logs under
`~/.pi/agent/sessions/<cwd-slug>/` before and after the change lands, on
comparable implement runs.

## How to Use

### The call

One required param, three optional filters:

| Param | Required | Meaning |
| --- | --- | --- |
| `path` | yes | File, directory, or glob relative to the session cwd (`*`, `?`, `**`). Absolute paths and paths outside cwd are allowed. |
| `kind` | no | Array of `function`, `const`, `let`, `var`, `class`, `type`, `interface`, `enum`, `export`, `registerTool`, `on`. |
| `name` | no | Case-insensitive substring match on the symbol name. |
| `maxSymbols` | no | Positive integer cap on total symbols across all files. |

Single file:

```
belayd_outline path="extensions/index.ts"
belayd_outline path="src/agent-registry.ts" name="gate"
belayd_outline path="extensions/index.ts" kind=["registerTool"]
```

Glob or directory — survey a module, or find a symbol by name without knowing
which file it lives in:

```
belayd_outline path="src/**/*.ts" kind=["interface"] name="Options"
belayd_outline path="src" maxSymbols=40
```

Registrations answer "which tools/phases does the harness expose?" cheaply:

```
belayd_outline path="extensions/index.ts" kind=["registerTool", "on"]
```

### Output shape

```
/abs/path/extensions/index.ts (4632 lines)
  167-181  interface     RunQualityGateOptions [exported]
  189-219  type          SessionState
  958-4631 function      belaydAgentHarness
  3459-3503  registerTool  belayd_status (pi.registerTool)
  3673-3712  registerTool  belayd_outline (pi.registerTool)
  4557-4561  on            tool_call (pi.on)
filters: kind=registerTool
```

- Header per file: absolute path and its line count (absolute so a match pastes
  straight into `read offset=… limit=…`).
- Rows: `start-end  kind  name`, 1-based inclusive line ranges, ascending.
- `[exported]` marks `export`ed declarations; `(pi.registerTool)` / `(pi.on)` /
  `(re-export)` / `(anonymous default export)` are short disambiguation hints.
  A registration whose string name cannot be extracted falls back to
  `registerTool@<line>` / `on@<line>`.
- Footer: the applied filters, then at most one truncation note.

The line ranges are the point: `958-4631  function  belaydAgentHarness` means
"read around 958 to start, then `grep -n` inside the range" instead of paging the
whole file.

### Limits

| Limit | Value | Constant |
| --- | --- | --- |
| Output budget | 16 KB | `OUTLINE_MAX_OUTPUT_BYTES` (16384) |
| Files per call | 200 | `OUTLINE_MAX_FILES` |
| Directory-walk entries | 50,000 | `OUTLINE_MAX_WALK_ENTRIES` |
| Scanned extensions | `.ts`, `.tsx`, `.mts`, `.cts` | `OUTLINE_FILE_EXTENSIONS` |
| Skipped dirs | `node_modules`, `dist`, `.git`, dot-directories | `OUTLINE_SKIP_DIRS` |

When you hit a limit, narrow instead of raising it:

- `note: output truncated at 16384 bytes; narrow with a path/kind/name filter.`
  — the 16 KB budget clipped the rows (the footer is always reserved).
- `note: symbol output truncated by maxSymbols; narrow with path/kind/name.`
  — your own `maxSymbols` cap was hit; later files may be unscanned.
- `note: matched <N> files; showing the first 200.` — more than
  `OUTLINE_MAX_FILES` files matched; `<N>` is the true count.
- `note: walk stopped at the entry cap; results may be incomplete.` — the
  directory walk itself stopped at 50,000 entries, so even the file list may be
  partial and no total is claimed.

### What it does not do

- No JavaScript — TypeScript extensions only; a non-TS single file is rejected
  with the supported list.
- No nested symbols. Function-local declarations and object methods are excluded
  on purpose; `pi.registerTool` / `pi.on` are the only depth-agnostic
  exceptions. Use `grep -n` or `ast_grep` for anything inside a body.
- No content. It returns names and ranges, not code — pair it with a targeted
  `read`/`grep -n` window.
- No index or cache. Every call re-reads the files it resolves.
- Not a phase, not a gate. Callable at any time under an active process gate;
  unavailable in planning mode (`PLANNING_GATED_TOOLS` does not include it).

### Read-only guarantee

The tool reads files and formats text. `resolveOutlineTargets` is the only
filesystem side effect (readdir/stat/realpath); there is no edit, write, or bash
path reachable from it, and repeated runs leave targets byte-identical. It can
therefore be handed to read-only agents (scout, reviewer, userguide, committer)
without loosening their tool allowlists — all 9 default agents in
`src/agent-registry.ts` list it.

### Working-directory guidance

Spawned sub-agent sessions already run with cwd = the worktree root (`runCwd` in
`src/spawn.ts`), so commands run directly:

```bash
pnpm test                       # correct
cd /abs/worktree && pnpm test   # redundant — this prefix was in 68% of sub-agent bash calls
```

The same applies to `belayd_outline`: `path` resolves against the session cwd,
so `path="src/outline.ts"` just works. Use relative paths; no absolute prefix
needed.

### Library use

`src/index.ts` re-exports the module for programmatic use:

```ts
import {
  formatOutline,
  isOutlineKind,
  outlineFiles,
  outlineSource,
  resolveOutlineTargets,
  OUTLINE_MAX_FILES,
  OUTLINE_MAX_OUTPUT_BYTES,
  OUTLINE_MAX_WALK_ENTRIES,
} from "belayd-agent-harness";

// Pure: scan source you already have.
const symbols = outlineSource(readFileSync("src/outline.ts", "utf8"));

// Pure: aggregate across files with filters.
const result = outlineFiles([{ path: "src/outline.ts", source }], {
  kind: ["function"],
  nameMatches: "outline",
  maxSymbols: 20,
});

// Side effect: resolve a file/dir/glob to a sorted TypeScript file list.
const resolved = resolveOutlineTargets(process.cwd(), "src/**/*.ts");
if (resolved.ok) {
  console.log(resolved.files.length, resolved.truncatedBy ?? "complete");
}

console.log(formatOutline(result));
```

`resolveOutlineTargets` returns the discriminated union
`{ ok: true; files; truncated; truncatedBy?: "file-cap" | "walk-cap"; totalMatches? } | { ok: false; error }`
— expected failures are values, never throws, matching the repo's
errors-as-values style.
