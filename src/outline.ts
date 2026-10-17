/**
 * Multi-language symbol outline for large source files.
 *
 * Sub-agents otherwise locate an edit anchor by re-reading a file in `read`
 * offset windows (pi truncates at 2000 lines / 50 KB). This module composes a
 * compact, line-ranged symbol map instead.
 *
 * Extraction is delegated to real parsers, not a hand-rolled lexer:
 * `outline-ctags.ts` (universal-ctags) supplies declarations for ~150
 * languages, and `outline-ast-grep.ts` (ast-grep) supplies the TypeScript
 * family's accurate declaration ranges plus the `pi.registerTool` / `pi.on`
 * registrations that sit inside a function body and are invisible to ctags.
 *
 * This module stays pure and synchronous: kind mapping, filters, the
 * byte-bounded formatter, symbol merging, and the target resolver. The only
 * side effect is `resolveOutlineTargets`, which reads the filesystem to turn a
 * path/dir/glob into a sorted file list.
 */

import type { Dirent, Stats } from "node:fs";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Symbol kinds the outline emits.
 *
 * The first group is shared: `function` covers `function`/`async function`/
 * generator declarations, `const`/`let`/`var` cover variable declarations, and
 * `registerTool`/`on` are pi plugin registrations. The second group
 * (`struct`/`union`/`trait`/`module`/`namespace`/`macro`/`field`) covers the
 * non-TypeScript languages ctags parses. Nested function-local declarations
 * are intentionally not emitted (see the extractors).
 */
export const OUTLINE_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "type",
  "const",
  "let",
  "var",
  "enum",
  "struct",
  "union",
  "trait",
  "module",
  "namespace",
  "macro",
  "field",
  "property",
  "registerTool",
  "on",
] as const;

export type OutlineKind = (typeof OUTLINE_KINDS)[number];

/** One symbol with its 1-based, inclusive line range. */
export interface OutlineSymbol {
  name: string;
  kind: OutlineKind;
  /** 1-based line of the declaration. */
  startLine: number;
  /** 1-based line of the declaration's closing brace or terminating `;`. */
  endLine: number;
  /** True when the declaration is exported (`export …`). */
  exported: boolean;
  /** Short human hint for ambiguous cases. */
  detail?: string;
}

/** A source file and its filtered symbol list. */
export interface OutlineFile {
  path: string;
  lineCount: number;
  symbols: OutlineSymbol[];
}

/** Symbols extracted for one file, before line counting. */
export interface OutlineSymbolGroup {
  path: string;
  symbols: OutlineSymbol[];
}

/** A file with resolved symbols and its line count, ready for filtering. */
export interface OutlineFileSymbols {
  path: string;
  lineCount: number;
  symbols: OutlineSymbol[];
}

/** Filters applied while building an outline. */
export interface OutlineFilesOptions {
  /** Keep only these kinds. */
  kind?: OutlineKind[];
  /** Case-insensitive substring match on the symbol name. */
  nameMatches?: string;
  /** Global cap on the number of symbols returned across all files. */
  maxSymbols?: number;
}

/** The filters actually applied to a result (for the output footer). */
export interface OutlineAppliedFilters {
  kind?: OutlineKind[];
  nameMatches?: string;
}

/** Aggregated outline across one or more files. */
export interface OutlineResult {
  files: OutlineFile[];
  /** Number of symbols included after filtering/truncation. */
  totalSymbols: number;
  /** True when `maxSymbols` dropped at least one symbol or file. */
  truncated: boolean;
  appliedFilters: OutlineAppliedFilters;
}

/** Maximum number of files `resolveOutlineTargets` returns in one call. */
export const OUTLINE_MAX_FILES = 200;

/**
 * Output byte budget for `formatOutline`. Kept small so a directory-wide
 * outline never becomes another large read; the caller narrows with filters.
 */
export const OUTLINE_MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * Hard cap on directory-walk entries so a glob rooted at `/` cannot traverse
 * the whole filesystem before the smaller `OUTLINE_MAX_FILES` result cap.
 */
export const OUTLINE_MAX_WALK_ENTRIES = 50_000;

/**
 * Static language table.
 *
 * `ctags` is the universal-ctags language name (documentation only — ctags
 * auto-detects from the extension once {@link ./outline-ctags.js} has added its
 * explicit `--map-<LANG>` overrides). A defined `astGrep` language marks the
 * files ast-grep extracts, because ctags' TypeScript parser does not emit end
 * lines; it also supplies coverage for extensions ctags does not map by
 * default (`.tsx`/`.mts`/`.cts`/`.cjs`).
 */
export interface OutlineLanguage {
  extension: string;
  ctags: string;
  astGrep?: "ts" | "tsx" | "js";
}

export const OUTLINE_LANGUAGES: readonly OutlineLanguage[] = [
  { extension: ".ts", ctags: "TypeScript", astGrep: "ts" },
  { extension: ".tsx", ctags: "TypeScript", astGrep: "tsx" },
  { extension: ".mts", ctags: "TypeScript", astGrep: "ts" },
  { extension: ".cts", ctags: "TypeScript", astGrep: "ts" },
  { extension: ".js", ctags: "JavaScript" },
  { extension: ".jsx", ctags: "JavaScript" },
  { extension: ".mjs", ctags: "JavaScript" },
  { extension: ".cjs", ctags: "JavaScript", astGrep: "js" },
  { extension: ".py", ctags: "Python" },
  { extension: ".rs", ctags: "Rust" },
  { extension: ".go", ctags: "Go" },
  { extension: ".rb", ctags: "Ruby" },
  { extension: ".java", ctags: "Java" },
  { extension: ".c", ctags: "C" },
  { extension: ".h", ctags: "C" },
  { extension: ".cc", ctags: "C++" },
  { extension: ".cpp", ctags: "C++" },
  { extension: ".hpp", ctags: "C++" },
  { extension: ".cs", ctags: "C#" },
  { extension: ".php", ctags: "PHP" },
  { extension: ".lua", ctags: "Lua" },
  { extension: ".sh", ctags: "Sh" },
  { extension: ".bash", ctags: "Sh" },
  { extension: ".zsh", ctags: "Sh" },
  { extension: ".kt", ctags: "Kotlin" },
  { extension: ".ex", ctags: "Elixir" },
  { extension: ".exs", ctags: "Elixir" },
  { extension: ".hs", ctags: "Haskell" },
  { extension: ".ml", ctags: "OCaml" },
  { extension: ".mli", ctags: "OCaml" },
];

/** Every extension the outline accepts, derived from {@link OUTLINE_LANGUAGES}. */
export const OUTLINE_FILE_EXTENSIONS: readonly string[] = OUTLINE_LANGUAGES.map(
  (language) => language.extension,
);

/** TypeScript-family extensions, which ast-grep extracts. */
export const OUTLINE_TS_EXTENSIONS: readonly string[] = OUTLINE_LANGUAGES.filter(
  (language) => language.astGrep !== undefined,
).map((language) => language.extension);

/**
 * JS/TS words that cannot name a declaration.
 *
 * Only declaration/lexical positions use this: a declaration name can never be
 * a reserved word, so a keyword there is parser noise (ctags' JavaScript
 * parser emits a `constant const` row for `const { const: x } = obj;`).
 * Member names are checked separately, because `class C { public = 1; const =
 * 1 }` are legal keyword-named fields and must not be dropped.
 */
export const OUTLINE_JS_TS_KEYWORDS: ReadonlySet<string> = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** True when `name` is a JS/TS word that cannot be a declaration. */
export function isOutlineJsTsKeyword(name: string): boolean {
  return OUTLINE_JS_TS_KEYWORDS.has(name);
}

/**
 * ast-grep language for a path, or undefined when only ctags covers it.
 * Extension matching is case-insensitive; `.mts`/`.cts`/`.d.ts` map to `ts`,
 * `.tsx` maps to `tsx`, and `.cjs` maps to `js` (the JavaScript grammar, since
 * ast-grep's scan resolves the grammar from the file extension).
 */
export function outlineAstGrepLanguage(path: string): "ts" | "tsx" | "js" | undefined {
  const lower = path.toLowerCase();
  for (const language of OUTLINE_LANGUAGES) {
    if (language.astGrep !== undefined && lower.endsWith(language.extension)) {
      return language.astGrep;
    }
  }
  return undefined;
}

/** True when the path has an extension the outline can parse. */
export function isOutlineSupportedFile(path: string): boolean {
  const lower = path.toLowerCase();
  return OUTLINE_LANGUAGES.some((language) => lower.endsWith(language.extension));
}

/**
 * Why a successful resolution was truncated.
 *
 * `file-cap` means more `OUTLINE_MAX_FILES` matches were found and the list
 * was sliced; `totalMatches` then reports the true count. `walk-cap` means the
 * directory walk stopped at `OUTLINE_MAX_WALK_ENTRIES` entries, so the file
 * list itself may be incomplete and no true total is known.
 */
export type OutlineTruncationCause = "file-cap" | "walk-cap";

/**
 * Result of resolving a path/dir/glob to source files.
 * Truncation is reported as a value so the caller can surface it.
 */
export type OutlineTargetResolution =
  | {
      ok: true;
      files: string[];
      truncated: boolean;
      totalMatches?: number;
      truncatedBy?: OutlineTruncationCause;
    }
  | { ok: false; error: string };

/**
 * Optional, non-tool-facing knobs for `resolveOutlineTargets`.
 *
 * `maxWalkEntries` exists so tests can exercise the walk-entry cap on a tiny
 * fixture instead of materializing 50k filesystem entries. It is not wired to
 * any pi tool parameter.
 */
export interface ResolveOutlineTargetsOptions {
  /** Override `OUTLINE_MAX_WALK_ENTRIES` for this resolution. */
  maxWalkEntries?: number;
}

/** True for the string-literal union of supported outline kinds. */
export function isOutlineKind(value: unknown): value is OutlineKind {
  return typeof value === "string" && (OUTLINE_KINDS as readonly string[]).includes(value);
}

// ── Symbol merging ─────────────────────────────────────────────────────

/**
 * Identity for de-duplication across extractors.
 *
 * The two extractors disagree on kind for the same lexical declaration, so
 * `const`/`let`/`var`/`function`/`class` collapse into one identity and
 * ast-grep wins the kind. `function`/`class` join the variable identity
 * because ctags' JavaScript parser miskinds an arrow function as `function`
 * and a generator declaration as `class`, while ast-grep refines them to
 * `const` and `function`; without the shared identity the miskinded ctags row
 * survives as a contradictory twin. A genuine same-line, same-name pair drawn
 * from these declaration forms cannot exist in valid source, so collapsing is
 * safe. Genuinely distinct kinds on the same line stay separate: a property
 * and a method (`foo: () => number; foo() {}`) and the two captures of
 * `const t = pi.registerTool({ name: "t" })` (`const` and `registerTool`) are
 * different symbols and must not overwrite each other.
 */
function lexicalIdentity(kind: OutlineKind): string {
  switch (kind) {
    case "const":
    case "let":
    case "var":
    case "function":
    case "class":
      return "declaration";
    default:
      return kind;
  }
}

function symbolKey(symbol: OutlineSymbol): string {
  return `${symbol.startLine}:${lexicalIdentity(symbol.kind)}:${symbol.name}`;
}

/**
 * Merge two symbol sets for one file.
 *
 * `extra` (ast-grep) refines `base` (ctags) on a same-line, same-identity
 * collision: it wins the end line, kind, and exported flag. Symbols present in
 * only one set are kept, so ctags' multi-declarator rows survive ast-grep's
 * single-name captures and distinct same-line kinds coexist. Result is sorted
 * ascending by start line, then name (then kind, to keep the order stable).
 */
export function mergeOutlineSymbols(
  base: readonly OutlineSymbol[],
  extra: readonly OutlineSymbol[],
): OutlineSymbol[] {
  const byKey = new Map<string, OutlineSymbol>();
  for (const symbol of base) byKey.set(symbolKey(symbol), symbol);
  for (const symbol of extra) byKey.set(symbolKey(symbol), symbol);
  return [...byKey.values()].sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.kind.localeCompare(b.kind);
  });
}

// ── Aggregation & formatting ───────────────────────────────────────────

function matchesFilters(
  symbol: OutlineSymbol,
  kinds: OutlineKind[] | undefined,
  nameLower: string | undefined,
): boolean {
  if (kinds !== undefined && kinds.length > 0 && !kinds.includes(symbol.kind)) return false;
  if (
    nameLower !== undefined &&
    nameLower !== "" &&
    !symbol.name.toLowerCase().includes(nameLower)
  ) {
    return false;
  }
  return true;
}

/**
 * Pure aggregation of pre-extracted symbols across files with optional filters.
 *
 * `maxSymbols` caps the global symbol count in file order. Once the cap is
 * reached the remaining files are not scanned at all (they add no headers),
 * and `truncated` is set.
 */
export function outlineFiles(
  files: readonly OutlineFileSymbols[],
  options?: OutlineFilesOptions,
): OutlineResult {
  const kindFilter = options?.kind;
  const nameFilter = options?.nameMatches?.toLowerCase();
  const maxSymbols = options?.maxSymbols;
  const resultFiles: OutlineFile[] = [];
  let totalSymbols = 0;
  let truncated = false;

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (file === undefined) continue;
    const filtered = file.symbols.filter((symbol) =>
      matchesFilters(symbol, kindFilter, nameFilter),
    );
    const capped = applySymbolCap(filtered, totalSymbols, maxSymbols);
    if (capped.truncated) truncated = true;
    totalSymbols += capped.kept.length;
    resultFiles.push({ path: file.path, lineCount: file.lineCount, symbols: capped.kept });

    if (maxSymbols !== undefined && totalSymbols >= maxSymbols) {
      if (index < files.length - 1) truncated = true;
      break;
    }
  }

  const appliedFilters: OutlineAppliedFilters = {};
  if (kindFilter !== undefined) appliedFilters.kind = kindFilter;
  if (options?.nameMatches !== undefined) appliedFilters.nameMatches = options.nameMatches;

  return { files: resultFiles, totalSymbols, truncated, appliedFilters };
}

/** Slice `symbols` down to the remaining global budget. */
function applySymbolCap(
  symbols: OutlineSymbol[],
  totalSoFar: number,
  maxSymbols: number | undefined,
): { kept: OutlineSymbol[]; truncated: boolean } {
  if (maxSymbols === undefined) return { kept: symbols, truncated: false };
  const remaining = Math.max(0, maxSymbols - totalSoFar);
  if (symbols.length <= remaining) return { kept: symbols, truncated: false };
  return { kept: symbols.slice(0, remaining), truncated: true };
}

function formatSymbolRow(symbol: OutlineSymbol): string {
  const exported = symbol.exported ? " [exported]" : "";
  const detail = symbol.detail !== undefined ? ` (${symbol.detail})` : "";
  return `  ${symbol.startLine}-${symbol.endLine}  ${symbol.kind.padEnd(12)}  ${symbol.name}${exported}${detail}`;
}

function collectOutlineLines(result: OutlineResult): string[] {
  const lines: string[] = [];
  for (const file of result.files) {
    lines.push(`${file.path} (${file.lineCount} lines)`);
    if (file.symbols.length === 0) {
      lines.push("  (no matching symbols)");
      continue;
    }
    for (const symbol of file.symbols) lines.push(formatSymbolRow(symbol));
  }
  return lines;
}

function formatOutlineFooter(result: OutlineResult): string[] {
  const notes: string[] = [];
  const { kind, nameMatches } = result.appliedFilters;
  if (kind !== undefined || nameMatches !== undefined) {
    const parts: string[] = [];
    if (kind !== undefined) parts.push(`kind=${kind.join("|")}`);
    if (nameMatches !== undefined) parts.push(`name~=${nameMatches}`);
    notes.push(`filters: ${parts.join(", ")}`);
  }
  if (result.truncated) {
    notes.push("note: symbol output truncated by maxSymbols; narrow with path/kind/name.");
  }
  return notes;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Token-cheap text rendering of an outline.
 *
 * One header per file (`path (N lines)`), then
 * `startLine-endLine  kind  name` rows, then optional filter/truncation notes
 * and any caller-supplied `extraNotes`. Total output is bounded by
 * `OUTLINE_MAX_OUTPUT_BYTES` (UTF-8 bytes); the footer — including
 * `extraNotes` — is reserved up front so a caller note (partial extraction,
 * file-cap truncation) can never push the result past the budget.
 */
export function formatOutline(result: OutlineResult, extraNotes: readonly string[] = []): string {
  const body = collectOutlineLines(result);
  const footerNotes = [...formatOutlineFooter(result), ...extraNotes];
  const truncationNote = `note: output truncated at ${OUTLINE_MAX_OUTPUT_BYTES} bytes; narrow with a path/kind/name filter.`;
  const reservedFooterBytes = [...footerNotes, truncationNote].reduce(
    (sum, line) => sum + utf8ByteLength(line) + 1,
    0,
  );
  const bodyBudget = Math.max(0, OUTLINE_MAX_OUTPUT_BYTES - reservedFooterBytes);

  const output: string[] = [];
  let size = 0;
  let clipped = false;
  for (const line of body) {
    const cost = utf8ByteLength(line) + 1;
    if (size + cost > bodyBudget) {
      clipped = true;
      break;
    }
    output.push(line);
    size += cost;
  }

  const notes = clipped ? [...footerNotes, truncationNote] : footerNotes;
  for (const note of notes) {
    const cost = utf8ByteLength(note) + 1;
    if (size + cost > OUTLINE_MAX_OUTPUT_BYTES) break;
    output.push(note);
    size += cost;
  }
  return output.join("\n");
}

// ── Target resolution (the module's only filesystem side effect) ───────

/** Directories never walked when expanding a directory or glob target. */
const OUTLINE_SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function hasOutlineExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return OUTLINE_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function escapeRegExpChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Translate a run of `*` characters at `start` into its regex fragment.
 * Consecutive stars collapse to a single `.*` (or one optional-directory
 * group) so a pattern like `a************b` cannot produce a runaway regex.
 */
function globStarPattern(glob: string, start: number): { source: string; nextIndex: number } {
  let count = 0;
  while (glob.charAt(start + count) === "*") count += 1;
  if (count >= 2) {
    if (glob.charAt(start + count) === "/") {
      return { source: "(?:.*/)?", nextIndex: start + count + 1 };
    }
    return { source: ".*", nextIndex: start + count };
  }
  return { source: "[^/]*", nextIndex: start + 1 };
}

/**
 * Convert a glob to a RegExp.
 *
 * Supports `*` (one path segment), `**` (any characters, including path
 * separators — so `src/**` recurses; this deliberately deviates from the
 * strict "`**` is a whole segment" reading), and `?` (one non-separator
 * character). Other regex metacharacters are escaped literally, so brace
 * expansion and character classes are not supported.
 */
function globToRegExp(absoluteGlob: string): RegExp {
  const glob = toPosix(absoluteGlob);
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      const star = globStarPattern(glob, i);
      source += star.source;
      i = star.nextIndex;
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    source += escapeRegExpChar(ch);
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

interface WalkState {
  /** Real paths of directories already entered (symlink-loop guard). */
  visitedDirs: Set<string>;
  /** Total directory entries inspected (whole-walk cap). */
  visitedEntries: number;
  /** Entry count at which the walk stops; defaults to the module constant. */
  maxWalkEntries: number;
  /** True once the entry cap stopped the walk before it finished. */
  capped: boolean;
}

function classifyDirent(entry: Dirent, fullPath: string): "directory" | "file" | "other" {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return "other";
  // Dirent.isFile() is false for symlinks even when they point at a regular
  // file, so follow the link explicitly to outline symlinked sources.
  try {
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {
    return "other";
  }
  return "other";
}

function walkSourceFiles(dir: string, out: string[], state: WalkState): void {
  if (state.visitedEntries >= state.maxWalkEntries) {
    state.capped = true;
    return;
  }

  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return;
  }
  if (state.visitedDirs.has(realDir)) return;
  state.visitedDirs.add(realDir);

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (state.visitedEntries > state.maxWalkEntries) {
      state.capped = true;
      return;
    }
    visitEntry(entry, dir, out, state);
  }
}

/** Classify one directory entry and either recurse or collect the file. */
function visitEntry(entry: Dirent, dir: string, out: string[], state: WalkState): void {
  state.visitedEntries += 1;
  if (state.visitedEntries > state.maxWalkEntries) {
    state.capped = true;
    return;
  }

  const fullPath = join(dir, entry.name);
  const kind = classifyDirent(entry, fullPath);
  if (kind === "directory") {
    if (entry.name.startsWith(".") || OUTLINE_SKIP_DIRS.has(entry.name)) return;
    walkSourceFiles(fullPath, out, state);
    return;
  }
  if (kind === "file" && hasOutlineExtension(entry.name)) out.push(fullPath);
}

function createWalkState(maxWalkEntries: number): WalkState {
  return {
    visitedDirs: new Set<string>(),
    visitedEntries: 0,
    maxWalkEntries,
    capped: false,
  };
}

function capFiles(files: string[], walkCapped: boolean): OutlineTargetResolution {
  const unique = [...new Set(files)].sort((a, b) => a.localeCompare(b));
  if (unique.length === 0) return { ok: false, error: "No matching source files found." };
  // A capped walk may have missed entries entirely, so no collected count is
  // authoritative. Report the walk cap ahead of the list-slice cap: "results
  // may be incomplete" is always true, whereas "matched N" would not be.
  if (walkCapped) {
    return {
      ok: true,
      files: unique.slice(0, OUTLINE_MAX_FILES),
      truncated: true,
      truncatedBy: "walk-cap",
    };
  }
  if (unique.length > OUTLINE_MAX_FILES) {
    return {
      ok: true,
      files: unique.slice(0, OUTLINE_MAX_FILES),
      truncated: true,
      truncatedBy: "file-cap",
      totalMatches: unique.length,
    };
  }
  return { ok: true, files: unique, truncated: false };
}

function resolveSingleTarget(
  cwd: string,
  normalized: string,
  maxWalkEntries: number,
): OutlineTargetResolution {
  const absolute = resolve(cwd, normalized);
  let stat: Stats;
  try {
    stat = statSync(absolute);
  } catch {
    return { ok: false, error: `No such file or directory: ${normalized}` };
  }
  if (stat.isFile()) {
    if (!hasOutlineExtension(absolute)) {
      return {
        ok: false,
        error: `Unsupported file extension: ${normalized}. Supported: ${OUTLINE_FILE_EXTENSIONS.join(", ")}.`,
      };
    }
    return { ok: true, files: [absolute], truncated: false };
  }
  if (stat.isDirectory()) {
    const files: string[] = [];
    const state = createWalkState(maxWalkEntries);
    walkSourceFiles(absolute, files, state);
    return capFiles(files, state.capped);
  }
  return { ok: false, error: `Not a file or directory: ${normalized}` };
}

function resolveGlobTarget(
  cwd: string,
  normalized: string,
  maxWalkEntries: number,
): OutlineTargetResolution {
  const wildcardIndex = normalized.search(/[?*[]/);
  const prefix = normalized.slice(0, wildcardIndex);
  const slashIndex = prefix.lastIndexOf("/");
  const basePart = slashIndex === -1 ? "." : prefix.slice(0, slashIndex);
  const base = resolve(cwd, basePart === "" ? "/" : basePart);
  let stat: Stats;
  try {
    stat = statSync(base);
  } catch {
    return { ok: false, error: `Base directory not found: ${basePart}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `Base path is not a directory: ${basePart}` };

  const matcher = globToRegExp(resolve(cwd, normalized));
  const candidates: string[] = [];
  const state = createWalkState(maxWalkEntries);
  walkSourceFiles(base, candidates, state);
  return capFiles(
    candidates.filter((candidate) => matcher.test(toPosix(candidate))),
    state.capped,
  );
}

/**
 * Resolve a file path, directory, or glob (`*`, `?`, `**`) to a sorted,
 * de-duplicated list of parseable source files relative to `cwd`.
 *
 * This is the module's only filesystem side effect. Absolute paths and paths
 * that resolve outside `cwd` are allowed: the tool that consumes this output
 * is read-only and runs in a trusted local session. Walks skip dot-directories
 * and `node_modules`/`dist`; symlinked files/directories are followed with a
 * realpath loop guard; results are capped at `OUTLINE_MAX_FILES` and the walk
 * itself at `OUTLINE_MAX_WALK_ENTRIES`.
 */
export function resolveOutlineTargets(
  cwd: string,
  pattern: string,
  options?: ResolveOutlineTargetsOptions,
): OutlineTargetResolution {
  if (pattern.trim() === "") return { ok: false, error: "path is required." };
  const maxWalkEntries = options?.maxWalkEntries ?? OUTLINE_MAX_WALK_ENTRIES;
  const normalized = pattern.replaceAll("\\", "/");
  if (!/[?*[]/.test(normalized)) return resolveSingleTarget(cwd, normalized, maxWalkEntries);
  return resolveGlobTarget(cwd, normalized, maxWalkEntries);
}
