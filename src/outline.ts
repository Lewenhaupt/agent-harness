/**
 * Structural symbol outline for large TypeScript files.
 *
 * Sub-agents otherwise locate an edit anchor by re-reading a file in
 * `read` offset windows (pi truncates at 2000 lines / 50 KB). This module
 * produces a compact, line-ranged symbol map instead.
 *
 * The scanner is intentionally dependency-free: `typescript` is a
 * devDependency and is NOT bundled into the Nix `belayd-harness` derivation,
 * so a compiler-API import would break the packaged extension at runtime.
 * Everything here uses a small state-machine lexer over the raw source.
 *
 * `outlineSource` / `outlineFiles` / `formatOutline` are pure. The only
 * side-effecting function is `resolveOutlineTargets`, which reads the
 * filesystem to turn a path/dir/glob into a sorted file list.
 */

import type { Dirent, Stats } from "node:fs";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Symbol kinds the outline emits.
 *
 * `function` covers `function`/`async function`/generator declarations;
 * `const`/`let`/`var` cover variable declarations (including arrow-function
 * consts); the rest are the matching named declarations. `registerTool` and
 * `on` are pi plugin registrations (`pi.registerTool` / `pi.on`). `export`
 * covers `export { … }` / `export type { … }` re-export lists, whose names
 * are surfaced instead of an anonymous `type` row. Nested declarations are
 * intentionally not emitted (see `outlineSource`).
 */
export const OUTLINE_KINDS = [
  "function",
  "const",
  "let",
  "var",
  "class",
  "type",
  "interface",
  "enum",
  "export",
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
  /** True when the declaration starts with `export`. */
  exported: boolean;
  /** Short human hint for ambiguous cases (e.g. anonymous default exports). */
  detail?: string;
}

/** A source file and its filtered symbol list. */
export interface OutlineFile {
  path: string;
  lineCount: number;
  symbols: OutlineSymbol[];
}

/** Input file for `outlineFiles` (source already read by the caller). */
export interface OutlineSourceFile {
  path: string;
  source: string;
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

/** File extensions the outline scans (TS-family only, no JS). */
export const OUTLINE_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

/**
 * Hard cap on directory-walk entries so a glob rooted at `/` cannot traverse
 * the whole filesystem before the smaller `OUTLINE_MAX_FILES` result cap.
 */
export const OUTLINE_MAX_WALK_ENTRIES = 50_000;

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
 * Result of resolving a path/dir/glob to TypeScript files.
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

// ── Source scanner ─────────────────────────────────────────────────────

/**
 * Lexer state. `regex` and `jsx-tag` span at most one line; neither can wrap.
 */
type ScanState =
  | "code"
  | "line-comment"
  | "block-comment"
  | "single"
  | "double"
  | "template"
  | "regex"
  | "jsx-tag";

interface ScanLine {
  /** Brace depth at the first character of the line. */
  braceBefore: number;
  /** Paren depth at the first character of the line. */
  parenBefore: number;
  /** Bracket depth at the first character of the line. */
  bracketBefore: number;
  /** True when the line begins inside a block comment / multi-line string. */
  startedInOpaque: boolean;
  /** The line with comments/strings/regexes blanked to spaces. */
  code: string;
  /** The untouched source line (used to extract registration names). */
  raw: string;
}

/** Mutable lexer state threaded across a single file's lines. */
interface LexState {
  braceDepth: number;
  parenDepth: number;
  bracketDepth: number;
  state: ScanState;
  escaped: boolean;
  /** True while inside a regex `[...]` character class. */
  regexInClass: boolean;
  /** Last significant code character, or "" at file start. */
  previousSignificant: string;
  /** Last completed identifier/keyword, used to allow regex after keywords. */
  previousWord: string;
  /** Identifier currently being accumulated. */
  word: string;
}

interface LexStep {
  output: string;
  consumed: number;
}

interface AdvanceInput {
  lex: LexState;
  ch: string;
  next: string;
}

/** Keywords after which a `/` starts a regex literal, not division. */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "case",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

const IDENTIFIER_CHAR_RE = /[\w$]/;

function isIdentifierChar(ch: string): boolean {
  return IDENTIFIER_CHAR_RE.test(ch);
}

/**
 * Decide whether a `/` at this point starts a regex literal.
 *
 * A regex may follow an operator/punctuator or an expression-expecting
 * keyword; it may not follow an identifier, number, `)`, `]`, or `}` (the
 * standard heuristic). See `REGEX_PRECEDING_KEYWORDS` for the keyword case.
 */
function regexAllowed(lex: LexState): boolean {
  const prev = lex.previousSignificant;
  if (prev === "") return true;
  // `)`, `]`, `}` end a value/expression, so a following `/` is division.
  if (prev === ")" || prev === "]" || prev === "}") return false;
  if (isIdentifierChar(prev)) return REGEX_PRECEDING_KEYWORDS.has(lex.previousWord);
  return true;
}

/** Handle one character while in `code` (lexical) state. */
function advanceCode(lex: LexState, ch: string, next: string): LexStep {
  const isWordChar = isIdentifierChar(ch);
  if (!isWordChar && lex.word !== "") {
    lex.previousWord = lex.word;
    lex.word = "";
  }

  if (ch === "/" && next === "/") {
    lex.state = "line-comment";
    return { output: "  ", consumed: 2 };
  }
  if (ch === "/" && next === "*") {
    lex.state = "block-comment";
    return { output: "  ", consumed: 2 };
  }
  if (ch === "/" && lex.previousSignificant === "<") {
    // A JSX closing tag (`</div>`) is not a regex: blank the tag up to `>`.
    lex.state = "jsx-tag";
    return { output: " ", consumed: 1 };
  }
  if (ch === "/" && regexAllowed(lex)) {
    lex.state = "regex";
    lex.regexInClass = false;
    lex.escaped = false;
    return { output: " ", consumed: 1 };
  }

  if (isWordChar) {
    lex.word += ch;
    lex.previousSignificant = ch;
    return { output: ch, consumed: 1 };
  }

  if (ch.trim() !== "") lex.previousSignificant = ch;

  switch (ch) {
    case "(":
      lex.parenDepth += 1;
      break;
    case ")":
      lex.parenDepth = Math.max(0, lex.parenDepth - 1);
      break;
    case "[":
      lex.bracketDepth += 1;
      break;
    case "]":
      lex.bracketDepth = Math.max(0, lex.bracketDepth - 1);
      break;
    case "{":
      lex.braceDepth += 1;
      break;
    case "}":
      lex.braceDepth = Math.max(0, lex.braceDepth - 1);
      break;
    case '"':
      lex.state = "double";
      // A string literal is a value: the next `/` is division, not a regex.
      lex.previousSignificant = ")";
      break;
    case "'":
      lex.state = "single";
      lex.previousSignificant = ")";
      break;
    case "`":
      lex.state = "template";
      lex.previousSignificant = ")";
      break;
    default:
      break;
  }
  return { output: ch, consumed: 1 };
}

/** Advance one character inside a single/double-quoted string or template. */
function advanceQuoted(lex: LexState, ch: string, quote: string): LexStep {
  if (lex.escaped) {
    lex.escaped = false;
  } else if (ch === "\\") {
    lex.escaped = true;
  } else if (ch === quote) {
    lex.state = "code";
  }
  return { output: " ", consumed: 1 };
}

/** Advance one character inside a regex literal. */
function advanceRegex(lex: LexState, ch: string): LexStep {
  if (lex.escaped) {
    lex.escaped = false;
  } else if (ch === "\\") {
    lex.escaped = true;
  } else if (ch === "[") {
    lex.regexInClass = true;
  } else if (ch === "]") {
    lex.regexInClass = false;
  } else if (ch === "/" && !lex.regexInClass) {
    lex.state = "code";
    // The closed regex is a value; a following `/` is division.
    lex.previousSignificant = ")";
  }
  return { output: " ", consumed: 1 };
}

/** Advance one character while blanking an opaque JSX tag. */
function advanceJsxTag(lex: LexState, ch: string): LexStep {
  if (ch === ">") {
    lex.state = "code";
    // A JSX element is a value; a following `/` is division, not a regex.
    lex.previousSignificant = ")";
  }
  return { output: " ", consumed: 1 };
}

/** Dispatch one character through the lexer state machine. */
function advanceScan(input: AdvanceInput): LexStep {
  const { lex, ch, next } = input;
  switch (lex.state) {
    case "code":
      return advanceCode(lex, ch, next);
    case "line-comment":
      return { output: " ", consumed: 1 };
    case "block-comment":
      if (ch === "*" && next === "/") {
        lex.state = "code";
        return { output: "  ", consumed: 2 };
      }
      return { output: " ", consumed: 1 };
    case "single":
      return advanceQuoted(lex, ch, "'");
    case "double":
      return advanceQuoted(lex, ch, '"');
    case "template":
      return advanceQuoted(lex, ch, "`");
    case "regex":
      return advanceRegex(lex, ch);
    case "jsx-tag":
      return advanceJsxTag(lex, ch);
  }
}

function createLexState(): LexState {
  return {
    braceDepth: 0,
    parenDepth: 0,
    bracketDepth: 0,
    state: "code",
    escaped: false,
    regexInClass: false,
    previousSignificant: "",
    previousWord: "",
    word: "",
  };
}

/**
 * Split source into lines annotated with the brace/paren/bracket depth at
 * each line start.
 *
 * Comments, single/double-quoted strings, template literals, and regex
 * literals are blanked so braces/quotes inside them cannot desync depth or
 * flip the lexer into a bogus string state. Template `${}` expressions are
 * treated as opaque template content — a documented simplification.
 */
function scanSourceLines(source: string): ScanLine[] {
  const scanned: ScanLine[] = [];
  const lex = createLexState();

  for (const raw of source.split("\n")) {
    const braceBefore = lex.braceDepth;
    const parenBefore = lex.parenDepth;
    const bracketBefore = lex.bracketDepth;
    const startedInOpaque = lex.state !== "code";
    let code = "";
    let i = 0;
    while (i < raw.length) {
      const step = advanceScan({ lex, ch: raw.charAt(i), next: raw.charAt(i + 1) });
      code += step.output;
      i += step.consumed;
    }
    // Regex literals cannot span lines; treat an unterminated one as code so
    // the next line is not swallowed.
    if (lex.state === "line-comment" || lex.state === "regex" || lex.state === "jsx-tag") {
      lex.state = "code";
    }
    scanned.push({ braceBefore, parenBefore, bracketBefore, startedInOpaque, code, raw });
  }
  return scanned;
}

// ── Declaration detection ──────────────────────────────────────────────

/** How the end of a declaration is located. */
type DetectionEndStyle = "body" | "statement" | "call";

/** Mutual brace/paren/bracket/angle depth while locating a declaration end. */
interface DepthState {
  brace: number;
  paren: number;
  bracket: number;
  /**
   * Approximate `<…>` generic depth. Tracked only outside parens/brackets in
   * declaration headers so a generic type literal like `Promise<{ x: 1 }>`
   * does not register as the declaration body.
   */
  angle: number;
}

interface DetectedDeclaration {
  kind: OutlineKind;
  name: string | undefined;
  exported: boolean;
  endStyle: DetectionEndStyle;
  detail?: string;
}

const DECLARATION_RE =
  /^(?<exported>export\s+)?(?<default>default\s+)?(?<async>async\s+)?(?<abstract>abstract\s+)?(?<declare>declare\s+)?(?<keyword>function\s*\*?|class|const\s+enum|const|let|var|type|interface|enum)\s*(?<name>[A-Za-z_$][\w$]*)?/;

const RE_EXPORT_RE = /^export\s+(type\s+)?\{/;

const KEYWORD_TO_KIND: Record<string, OutlineKind> = {
  class: "class",
  const: "const",
  let: "let",
  var: "var",
  type: "type",
  interface: "interface",
  enum: "enum",
  "const enum": "enum",
};

function outlineKindForKeyword(keyword: string): OutlineKind | undefined {
  if (keyword.startsWith("function")) return "function";
  return KEYWORD_TO_KIND[keyword];
}

function endStyleForKind(kind: OutlineKind): DetectionEndStyle {
  switch (kind) {
    case "function":
    case "class":
    case "interface":
    case "enum":
      return "body";
    default:
      return "statement";
  }
}

function detectDeclaration(trimmed: string): DetectedDeclaration | undefined {
  const match = DECLARATION_RE.exec(trimmed);
  const groups = match?.groups;
  if (groups === undefined) return undefined;
  const kind = outlineKindForKeyword(groups.keyword ?? "");
  if (kind === undefined) return undefined;

  const isDefault = groups.default !== undefined;
  const rawName = groups.name;
  // Destructuring (`const { a } = …`) and other anonymous declarations have no
  // stable name; skip them rather than emitting a bogus "(anonymous)" row.
  const name = rawName ?? (isDefault ? "default" : undefined);
  if (name === undefined) return undefined;

  const detail = rawName === undefined && isDefault ? "anonymous default export" : undefined;
  return {
    kind,
    name,
    exported: groups.exported !== undefined,
    endStyle: endStyleForKind(kind),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/** Detect pi plugin registrations that are not ordinary declarations. */
function detectRegistration(trimmed: string): DetectedDeclaration | undefined {
  if (/^pi\.registerTool\s*\(/.test(trimmed)) {
    return {
      kind: "registerTool",
      name: undefined,
      exported: false,
      endStyle: "call",
      detail: "pi.registerTool",
    };
  }
  if (/^pi\.on\s*\(/.test(trimmed)) {
    return { kind: "on", name: undefined, exported: false, endStyle: "call", detail: "pi.on" };
  }
  return undefined;
}

/** Reserved words that can appear inside a re-export brace list. */
const RE_EXPORT_NON_NAMES: ReadonlySet<string> = new Set(["default", "as", "type"]);

/**
 * Detect `export { a, b }` / `export type { … } from "…"` and surface the
 * exported names. `DECLARATION_RE` would otherwise read `export type` as an
 * anonymous type declaration.
 */
function detectReExport(lines: ScanLine[], index: number): DetectedDeclaration | undefined {
  const line = lines[index];
  if (line === undefined || !RE_EXPORT_RE.test(line.code.trim())) return undefined;
  const all = collectBraceNames(lines, index);
  if (all.length === 0) return undefined;

  const names = all.filter((name) => !RE_EXPORT_NON_NAMES.has(name));
  if (names.length === 0) {
    // `export { default } from "…"` has no non-reserved name; keep the row
    // (with a marker) instead of silently dropping the re-export.
    if (!all.includes("default")) return undefined;
    return {
      kind: "export",
      name: "default",
      exported: true,
      endStyle: "statement",
      detail: "(default)",
    };
  }
  return {
    kind: "export",
    name: formatExportName(names),
    exported: true,
    endStyle: "statement",
    detail: "re-export",
  };
}

/** Only the next few lines can hold a re-export brace list. */
const RE_EXPORT_WINDOW_LINES = 16;

/** Collect the identifiers inside the first `{…}` starting at `startIndex`. */
function collectBraceNames(lines: ScanLine[], startIndex: number): string[] {
  const code = lines
    .slice(startIndex, startIndex + RE_EXPORT_WINDOW_LINES)
    .map((line) => line?.code ?? "")
    .join("\n");
  const open = code.indexOf("{");
  if (open === -1) return [];

  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return extractIdentifiers(code.slice(open + 1, i));
    }
  }
  return [];
}

function extractIdentifiers(text: string): string[] {
  const matches = text.match(/[A-Za-z_$][\w$]*/g);
  return matches ?? [];
}

function formatExportName(names: string[]): string {
  const joined = names.join(", ");
  if (joined.length <= 120) return joined;
  return `${names.slice(0, 8).join(", ")} (+${names.length - 8} more)`;
}

/**
 * Find the last line of a `function`/`class`/`interface`/`enum` body.
 *
 * Only a `{` opened at paren===0 && bracket===0 && brace===0 is the body-open;
 * inline object type literals inside parameters/generics therefore cannot end
 * the declaration early. A `;` before the body opens terminates an overload
 * signature. The declaration ends at the brace matching the body-open.
 */
interface BodyScanResult {
  bodyOpened: boolean;
  terminated: boolean;
}

/** Advance the body scan one character; report the matching body close. */
function advanceBodyScan(state: DepthState, bodyOpened: boolean, ch: string): BodyScanResult {
  switch (ch) {
    case "(":
      state.paren += 1;
      return { bodyOpened, terminated: false };
    case ")":
      state.paren = Math.max(0, state.paren - 1);
      return { bodyOpened, terminated: false };
    case "[":
      state.bracket += 1;
      return { bodyOpened, terminated: false };
    case "]":
      state.bracket = Math.max(0, state.bracket - 1);
      return { bodyOpened, terminated: false };
    case "<":
      if (state.paren === 0 && state.bracket === 0) state.angle += 1;
      return { bodyOpened, terminated: false };
    case ">":
      if (state.paren === 0 && state.bracket === 0) state.angle = Math.max(0, state.angle - 1);
      return { bodyOpened, terminated: false };
    case "{": {
      const opened =
        bodyOpened ||
        (state.paren === 0 && state.bracket === 0 && state.angle === 0 && state.brace === 0);
      state.brace += 1;
      return { bodyOpened: opened, terminated: false };
    }
    case "}":
      state.brace = Math.max(0, state.brace - 1);
      // Termination is deferred to end-of-line (see findBodyEnd): a mid-line
      // `}` may be an inline object-literal return type, not the body close.
      return { bodyOpened, terminated: false };
    case ";":
      // A top-level `;` ends an overload signature. It can occur after an
      // inline object return type, so do not gate on `bodyOpened` here.
      return {
        bodyOpened,
        terminated:
          state.brace === 0 && state.paren === 0 && state.bracket === 0 && state.angle === 0,
      };
    default:
      return { bodyOpened, terminated: false };
  }
}

function findBodyEnd(lines: ScanLine[], startIndex: number): number {
  const state: DepthState = { brace: 0, paren: 0, bracket: 0, angle: 0 };
  let bodyOpened = false;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    for (const ch of line.code) {
      const result = advanceBodyScan(state, bodyOpened, ch);
      bodyOpened = result.bodyOpened;
      if (result.terminated) return i;
    }
    // Only a body close that ends the line terminates: an inline object return
    // type (`): { a: 1 } {`) returns brace to 0 mid-line but is followed by
    // the real body `{`. A one-liner body (`function f() { return 1; }`) ends
    // the line on `}` at depth 0, so it still terminates here.
    if (bodyOpened && state.brace === 0 && line.code.trimEnd().endsWith("}")) return i;
  }
  return Math.max(0, lines.length - 1);
}

/**
 * Find the last line of a `const`/`let`/`var`/`type` declaration.
 *
 * Braces/parens/brackets are balanced so a `;` nested in an object literal or
 * call argument does not terminate early; the declaration ends at the first
 * `;` with all three depths at zero.
 */
function findStatementEnd(lines: ScanLine[], startIndex: number): number {
  const state: DepthState = { brace: 0, paren: 0, bracket: 0, angle: 0 };
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    for (const ch of line.code) {
      switch (ch) {
        case "{":
          state.brace += 1;
          break;
        case "}":
          state.brace = Math.max(0, state.brace - 1);
          break;
        case "(":
          state.paren += 1;
          break;
        case ")":
          state.paren = Math.max(0, state.paren - 1);
          break;
        case "[":
          state.bracket += 1;
          break;
        case "]":
          state.bracket = Math.max(0, state.bracket - 1);
          break;
        case ";":
          if (state.brace === 0 && state.paren === 0 && state.bracket === 0) return i;
          break;
        default:
          break;
      }
    }
  }
  return Math.max(0, lines.length - 1);
}

/** Mutual paren state while locating the end of a registration call. */
interface CallScanState {
  paren: number;
  opened: boolean;
}

/** Advance the call scan one character; true when the call's `)` closes. */
function advanceCallScan(state: CallScanState, ch: string): boolean {
  switch (ch) {
    case "(":
      state.paren += 1;
      state.opened = true;
      return false;
    case ")":
      state.paren = Math.max(0, state.paren - 1);
      return state.opened && state.paren === 0;
    case ";":
      return !state.opened;
    default:
      return false;
  }
}

/** Find the line where the `pi.registerTool(` / `pi.on(` call's `)` closes. */
function findCallEnd(lines: ScanLine[], startIndex: number): number {
  const state: CallScanState = { paren: 0, opened: false };
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    for (const ch of line.code) {
      if (advanceCallScan(state, ch)) return i;
    }
  }
  return Math.max(0, lines.length - 1);
}

function endDeclaration(lines: ScanLine[], startIndex: number, style: DetectionEndStyle): number {
  switch (style) {
    case "body":
      return findBodyEnd(lines, startIndex);
    case "call":
      return findCallEnd(lines, startIndex);
    case "statement":
      return findStatementEnd(lines, startIndex);
  }
}

function extractRegistrationName(rawLines: string[], pattern: RegExp): string | undefined {
  const match = pattern.exec(rawLines.join("\n"));
  return match?.[1];
}

function resolveSymbolName(
  detected: DetectedDeclaration,
  rawLines: string[],
  startLine: number,
): string {
  if (detected.kind === "registerTool") {
    return (
      extractRegistrationName(rawLines, /name\s*:\s*["'`]([^"'`]+)["'`]/) ??
      `registerTool@${startLine}`
    );
  }
  if (detected.kind === "on") {
    return extractRegistrationName(rawLines, /pi\.on\(\s*["'`]([^"'`]+)["'`]/) ?? `on@${startLine}`;
  }
  return detected.name ?? "(anonymous)";
}

/** Materialize a detected symbol with its resolved line range and name. */
function buildSymbol(
  lines: ScanLine[],
  index: number,
  detected: DetectedDeclaration,
): OutlineSymbol {
  const startLine = index + 1;
  const endIndex = endDeclaration(lines, index, detected.endStyle);
  const rawLines = lines.slice(index, endIndex + 1).map((scanLine) => scanLine.raw);
  return {
    name: resolveSymbolName(detected, rawLines, startLine),
    kind: detected.kind,
    startLine,
    endLine: endIndex + 1,
    exported: detected.exported,
    ...(detected.detail !== undefined ? { detail: detected.detail } : {}),
  };
}

/**
 * Pure structural scan of TypeScript source.
 *
 * Emits top-level declarations and pi registrations, ordered by ascending
 * start line. Nested declarations/object methods are excluded (they start at
 * brace/paren/bracket depth > 0); `pi.registerTool` / `pi.on` are emitted at
 * any depth because plugin entry points register tools inside their
 * default-export function.
 */
export function outlineSource(source: string): OutlineSymbol[] {
  const lines = scanSourceLines(source);
  const symbols: OutlineSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const symbol = detectSymbolAt(lines, i);
    if (symbol !== undefined) symbols.push(symbol);
  }
  return symbols;
}

/** Detect one symbol at `index`, or undefined when there is none. */
function detectSymbolAt(lines: ScanLine[], index: number): OutlineSymbol | undefined {
  const line = lines[index];
  if (line === undefined || line.startedInOpaque) return undefined;
  const trimmed = line.code.trim();
  if (trimmed === "") return undefined;

  const registration = detectRegistration(trimmed);
  if (registration !== undefined) return buildSymbol(lines, index, registration);

  if (line.braceBefore !== 0 || line.parenBefore !== 0 || line.bracketBefore !== 0) {
    return undefined;
  }

  const reExport = detectReExport(lines, index);
  if (reExport !== undefined) return buildSymbol(lines, index, reExport);

  const declaration = detectDeclaration(trimmed);
  if (declaration === undefined) return undefined;
  return buildSymbol(lines, index, declaration);
}

// ── Aggregation & formatting ───────────────────────────────────────────

function countLines(source: string): number {
  return source.length === 0 ? 0 : source.split("\n").length;
}

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
 * Pure aggregation of `outlineSource` across files with optional filters.
 *
 * `maxSymbols` caps the global symbol count in file order. Once the cap is
 * reached the remaining files are not scanned at all (they add no headers),
 * and `truncated` is set.
 */
export function outlineFiles(
  files: readonly OutlineSourceFile[],
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
    const filtered = outlineSource(file.source).filter((symbol) =>
      matchesFilters(symbol, kindFilter, nameFilter),
    );
    const capped = applySymbolCap(filtered, totalSymbols, maxSymbols);
    if (capped.truncated) truncated = true;
    totalSymbols += capped.kept.length;
    resultFiles.push({
      path: file.path,
      lineCount: countLines(file.source),
      symbols: capped.kept,
    });

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
 * `startLine-endLine  kind  name` rows, then optional filter/truncation notes.
 * Total output is bounded by `OUTLINE_MAX_OUTPUT_BYTES` (UTF-8 bytes); the
 * footer is reserved up front so it can never be dropped by the budget.
 */
export function formatOutline(result: OutlineResult): string {
  const body = collectOutlineLines(result);
  const footerNotes = formatOutlineFooter(result);
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
  return OUTLINE_FILE_EXTENSIONS.some((extension) => name.endsWith(extension));
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

function walkTypeScriptFiles(dir: string, out: string[], state: WalkState): void {
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
    walkTypeScriptFiles(fullPath, out, state);
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
  if (unique.length === 0) return { ok: false, error: "No matching TypeScript files found." };
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
    walkTypeScriptFiles(absolute, files, state);
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
  walkTypeScriptFiles(base, candidates, state);
  return capFiles(
    candidates.filter((candidate) => matcher.test(toPosix(candidate))),
    state.capped,
  );
}

/**
 * Resolve a file path, directory, or glob (`*`, `?`, `**`) to a sorted,
 * de-duplicated list of TypeScript files relative to `cwd`.
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
