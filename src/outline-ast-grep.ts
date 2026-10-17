/**
 * ast-grep extractor for `belayd_outline`.
 *
 * universal-ctags' TypeScript parser emits no `end` line and cannot see the
 * `pi.registerTool({ name })` / `pi.on("event", …)` calls that live inside
 * `belaydAgentHarness`'s function body. ast-grep fills both gaps for the
 * TypeScript family (`--lang ts` / `tsx` / `js`), with one structured rule per
 * language group. The `js` group covers `.cjs`, which ast-grep resolves with
 * the JavaScript grammar from the file extension. Non-TypeScript files stay
 * with ctags.
 *
 * `run --pattern` cannot express "function with an optional return type" or
 * "object whose `name` property appears at any position", so the rule set is
 * passed through `ast-grep scan --inline-rules` instead of a single pattern.
 *
 * The stream parser is pure and exported separately from the spawn seam.
 */

import type { OutlineKind, OutlineSymbol, OutlineSymbolGroup } from "./outline.js";
import { isOutlineJsTsKeyword, outlineAstGrepLanguage } from "./outline.js";
import { resolveOutlineBinary, spawnOutlineBinary } from "./outline-binary.js";

export const OUTLINE_AST_GREP_ENV = "BELAYD_AST_GREP_BIN";
export const OUTLINE_AST_GREP_DEFAULT = "ast-grep";
export const OUTLINE_AST_GREP_TIMEOUT_MS = 15_000;
export const OUTLINE_AST_GREP_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const OUTLINE_AST_GREP_INSTALL_HINT =
  "Install ast-grep (the devShell provides pkgs.ast-grep), or set BELAYD_AST_GREP_BIN.";

const AST_GREP_LANGUAGE_NAMES: Record<OutlineAstGrepLanguage, string> = {
  ts: "TypeScript",
  tsx: "Tsx",
  js: "JavaScript",
};

/** ast-grep grammar names the outline can drive. */
export type OutlineAstGrepLanguage = "ts" | "tsx" | "js";

/**
 * Outline kinds whose name is a declaration identifier. A declaration name can
 * never be reserved (ast-grep would otherwise surface a `const` capture from a
 * destructuring/lexical pattern); member kinds are excluded because
 * `property`/`method` names are legal keyword-named class members.
 */
const AST_GREP_DECLARATION_OUTLINE_KINDS: ReadonlySet<OutlineKind> = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "const",
  "let",
  "var",
  "namespace",
]);

/** Capture name → outline kind for declaration branches (LEXICAL handled below). */
const AST_GREP_DECLARATION_KINDS: ReadonlyArray<{ capture: string; kind: OutlineKind }> = [
  { capture: "FUNCTION", kind: "function" },
  { capture: "CLASS", kind: "class" },
  { capture: "INTERFACE", kind: "interface" },
  { capture: "TYPE", kind: "type" },
  { capture: "ENUM", kind: "enum" },
  { capture: "METHOD", kind: "method" },
  { capture: "PROPERTY", kind: "property" },
  { capture: "NAMESPACE", kind: "namespace" },
  { capture: "VARIABLE", kind: "var" },
  { capture: "REGISTER_TOOL", kind: "registerTool" },
  { capture: "ON", kind: "on" },
];

/** Declaration branches valid for the TypeScript and Tsx grammars. */
const AST_GREP_TS_DECLARATIONS = `            - kind: function_declaration
              has: { field: name, pattern: $FUNCTION }
            - kind: class_declaration
              has: { field: name, pattern: $CLASS }
            - kind: abstract_class_declaration
              has: { field: name, pattern: $CLASS }
            - kind: interface_declaration
              has: { field: name, pattern: $INTERFACE }
            - kind: type_alias_declaration
              has: { field: name, pattern: $TYPE }
            - kind: enum_declaration
              has: { field: name, pattern: $ENUM }
            - kind: method_definition
              has: { field: name, pattern: $METHOD }
            - kind: public_field_definition
              has: { field: name, pattern: $PROPERTY }
            - kind: internal_module
              has: { field: name, pattern: $NAMESPACE }
            - kind: lexical_declaration
              has:
                kind: variable_declarator
                has: { field: name, pattern: $LEXICAL }
            - kind: variable_declaration
              has:
                kind: variable_declarator
                has: { field: name, pattern: $VARIABLE }`;

/**
 * Declaration branches valid for the JavaScript grammar (`.cjs`).
 *
 * ast-grep validates every node kind against the grammar while parsing the
 * rule, so the TypeScript-only kinds (`abstract_class_declaration`,
 * `interface_declaration`, `internal_module`, …) cannot be reused here;
 * JavaScript uses `field_definition` where TypeScript uses
 * `public_field_definition`.
 */
const AST_GREP_JS_DECLARATIONS = `            - kind: function_declaration
              has: { field: name, pattern: $FUNCTION }
            - kind: generator_function_declaration
              has: { field: name, pattern: $FUNCTION }
            - kind: class_declaration
              has: { field: name, pattern: $CLASS }
            - kind: method_definition
              has: { field: name, pattern: $METHOD }
            - kind: field_definition
              has: { field: name, pattern: $PROPERTY }
            - kind: lexical_declaration
              has:
                kind: variable_declarator
                has: { field: name, pattern: $LEXICAL }
            - kind: variable_declaration
              has:
                kind: variable_declarator
                has: { field: name, pattern: $VARIABLE }`;

/**
 * The structured ast-grep rule for one language.
 *
 * Declaration branches are gated by `not: inside: statement_block`, which drops
 * function- and arrow-local declarations; registration branches are not, since
 * they intentionally sit inside `belaydAgentHarness`. Each branch captures its
 * name under a distinct meta-variable so the parser can recover the kind
 * without a second lookup. The declaration set is grammar-specific because
 * ast-grep rejects unknown kinds at rule-parse time.
 */
export function buildAstGrepRule(language: OutlineAstGrepLanguage): string {
  const declarations = language === "js" ? AST_GREP_JS_DECLARATIONS : AST_GREP_TS_DECLARATIONS;
  return `id: belayd-outline
language: ${AST_GREP_LANGUAGE_NAMES[language]}
rule:
  any:
    - all:
        - not:
            inside:
              kind: statement_block
        - any:
${declarations}
    - pattern: pi.on($ON, $$$REST)
    - all:
        - kind: call_expression
          has: { field: function, pattern: pi.registerTool }
        - has:
            field: arguments
            has:
              kind: object
              has:
                kind: pair
                all:
                  - has: { field: key, regex: "^name$" }
                  - has: { field: value, pattern: $REGISTER_TOOL }
`;
}

export function buildAstGrepArgs(
  language: OutlineAstGrepLanguage,
  files: readonly string[],
): string[] {
  return ["scan", "--inline-rules", buildAstGrepRule(language), "--json=stream", ...files];
}

/** Parse one JSON object line, or undefined when the line is not valid JSON. */
function parseJsonObject(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Flatten ast-grep's `metaVariables.single` map into `name → text`. */
function singleCaptures(match: Record<string, unknown>): Record<string, string> {
  const captures: Record<string, string> = {};
  const meta = asRecord(match.metaVariables);
  if (meta === undefined) return captures;
  const single = asRecord(meta.single);
  if (single === undefined) return captures;
  for (const [key, value] of Object.entries(single)) {
    const entry = asRecord(value);
    if (entry !== undefined && typeof entry.text === "string") captures[key] = entry.text;
  }
  return captures;
}

/**
 * `exported` is not visible in the matched node (the `export` keyword is on the
 * parent `export_statement`), so read the source line ast-grep echoes back and
 * check the text before the match's start column.
 */
function astGrepMatchIsExported(match: Record<string, unknown>): boolean {
  const lines = match.lines;
  const range = asRecord(match.range);
  const start = range === undefined ? undefined : asRecord(range.start);
  const column = start === undefined ? undefined : start.column;
  if (typeof lines !== "string" || typeof column !== "number") return false;
  const firstLine = lines.split("\n")[0];
  if (firstLine === undefined) return false;
  return /(^|\s)export(\s+default)?\s*$/.test(firstLine.slice(0, column));
}

/** Strip a quoted event/tool name; keep only identifier-like declaration names. */
function normalizeAstGrepName(raw: string): string | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const first = text.charAt(0);
  if (
    text.length >= 2 &&
    (first === '"' || first === "'" || first === "`") &&
    text.endsWith(first)
  ) {
    const inner = text.slice(1, -1);
    return inner === "" ? undefined : inner;
  }
  // Destructuring patterns (`{ x, y }`) are not declarations; ctags emits their
  // bound names instead, so drop the non-identifier capture here.
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text) ? text : undefined;
}

function classifyAstGrepMatch(
  match: Record<string, unknown>,
  captures: Record<string, string>,
): { name: string; kind: OutlineKind } | undefined {
  const lexical = captures.LEXICAL;
  if (lexical !== undefined) {
    const text = typeof match.text === "string" ? match.text : "";
    return { name: lexical, kind: /^\s*let\b/.test(text) ? "let" : "const" };
  }
  for (const entry of AST_GREP_DECLARATION_KINDS) {
    const captured = captures[entry.capture];
    if (captured !== undefined) return { name: captured, kind: entry.kind };
  }
  return undefined;
}

function rangeLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function astGrepMatchToSymbol(
  match: Record<string, unknown>,
): { path: string; symbol: OutlineSymbol } | undefined {
  const path = match.file;
  if (typeof path !== "string" || path === "") return undefined;
  const range = asRecord(match.range);
  if (range === undefined) return undefined;
  const start = asRecord(range.start);
  const end = asRecord(range.end);
  if (start === undefined || end === undefined) return undefined;
  const startLine = rangeLine(start.line);
  const endLine = rangeLine(end.line);
  if (startLine === undefined || endLine === undefined) return undefined;

  const captures = singleCaptures(match);
  const classified = classifyAstGrepMatch(match, captures);
  if (classified === undefined) return undefined;
  const name = normalizeAstGrepName(classified.name);
  if (name === undefined) return undefined;
  // Only declaration positions can never be a reserved word; a keyword-named
  // `property`/`method` capture is a legal class member and must surface.
  if (AST_GREP_DECLARATION_OUTLINE_KINDS.has(classified.kind) && isOutlineJsTsKeyword(name)) {
    return undefined;
  }

  // ast-grep lines are 0-based; the outline is 1-based and inclusive.
  return {
    path,
    symbol: {
      name,
      kind: classified.kind,
      startLine: startLine + 1,
      endLine: endLine + 1,
      exported: astGrepMatchIsExported(match),
    },
  };
}

/**
 * Parse an `ast-grep scan --json=stream` stdout into per-file symbol lists.
 * Malformed individual lines are skipped rather than aborting the run.
 */
export function parseAstGrepJson(stdout: string): OutlineSymbolGroup[] {
  const groups = new Map<string, OutlineSymbol[]>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = parseJsonObject(trimmed);
    if (match === undefined) continue;
    const converted = astGrepMatchToSymbol(match);
    if (converted === undefined) continue;
    const existing = groups.get(converted.path);
    if (existing === undefined) groups.set(converted.path, [converted.symbol]);
    else existing.push(converted.symbol);
  }
  return [...groups.entries()].map(([path, symbols]) => ({ path, symbols }));
}

function groupFilesByLanguage(files: readonly string[]): Record<OutlineAstGrepLanguage, string[]> {
  const buckets: Record<OutlineAstGrepLanguage, string[]> = { ts: [], tsx: [], js: [] };
  for (const file of files) {
    const language = outlineAstGrepLanguage(file);
    if (language === undefined) continue;
    buckets[language].push(file);
  }
  return buckets;
}

function mergeGroups(groups: readonly OutlineSymbolGroup[]): OutlineSymbolGroup[] {
  const byPath = new Map<string, OutlineSymbol[]>();
  for (const group of groups) {
    const existing = byPath.get(group.path);
    if (existing === undefined) byPath.set(group.path, [...group.symbols]);
    else existing.push(...group.symbols);
  }
  return [...byPath.entries()].map(([path, symbols]) => ({ path, symbols }));
}

/**
 * Run ast-grep once per TypeScript-family language group. Files whose extension
 * ctags owns (`.py`, `.rs`, …) are ignored entirely. A missing binary is only
 * an error when there is TypeScript work to do.
 *
 * Per-group failures that still emitted parseable JSON are folded into a
 * degraded success with a note rather than discarding the whole run.
 */
export type OutlineAstGrepResult =
  | { ok: true; groups: OutlineSymbolGroup[]; note?: string }
  | { ok: false; error: string };

/** Per-call knobs; `env`/`timeoutInMs` exist so tests can drive failure paths. */
export interface OutlineAstGrepRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutInMs?: number;
}

function hasAnySymbol(groups: readonly OutlineSymbolGroup[]): boolean {
  return groups.some((group) => group.symbols.length > 0);
}

export async function runAstGrep(
  files: readonly string[],
  options: OutlineAstGrepRunOptions = {},
): Promise<OutlineAstGrepResult> {
  const buckets = groupFilesByLanguage(files);
  const groupsInput = (["ts", "tsx", "js"] as const).filter(
    (language) => buckets[language].length > 0,
  );
  if (groupsInput.length === 0) return { ok: true, groups: [] };

  const binary = resolveOutlineBinary(
    {
      envName: OUTLINE_AST_GREP_ENV,
      defaultBinary: OUTLINE_AST_GREP_DEFAULT,
      installHint: OUTLINE_AST_GREP_INSTALL_HINT,
    },
    options.env ?? process.env,
  );
  if (!binary.ok) return { ok: false, error: binary.error };

  const collected: OutlineSymbolGroup[] = [];
  const notes: string[] = [];
  const failures: Array<{ note: string; error: string }> = [];
  for (const language of groupsInput) {
    const outcome = await spawnOutlineBinary({
      binary: binary.path,
      args: buildAstGrepArgs(language, buckets[language]),
      timeoutInMs: options.timeoutInMs ?? OUTLINE_AST_GREP_TIMEOUT_MS,
      maxBufferBytes: OUTLINE_AST_GREP_MAX_BUFFER_BYTES,
      installHint: OUTLINE_AST_GREP_INSTALL_HINT,
    });
    if (outcome.ok) {
      collected.push(...parseAstGrepJson(outcome.stdout));
      continue;
    }
    const recovered = parseAstGrepJson(outcome.stdout);
    if (hasAnySymbol(recovered)) {
      collected.push(...recovered);
      notes.push(
        `note: ast-grep (${language}) ${spawnReason(outcome)} before completing; the outline lists only the symbols recovered from its partial output.`,
      );
      continue;
    }
    // Do not discard symbols already recovered from an earlier language group:
    // remember the failure and only hard-fail if nothing usable survives.
    failures.push({
      note: `note: ast-grep (${language}) ${spawnReason(outcome)} and returned no usable output.`,
      error: outcome.error,
    });
  }
  const merged = mergeGroups(collected);
  if (hasAnySymbol(merged)) {
    const combined = [...notes, ...failures.map((failure) => failure.note)];
    return combined.length > 0
      ? { ok: true, groups: merged, note: combined.join(" ") }
      : { ok: true, groups: merged };
  }
  const firstFailure = failures[0];
  if (firstFailure !== undefined) return { ok: false, error: firstFailure.error };
  return { ok: true, groups: merged };
}

/** Phrase a spawn failure from its classified outcome, never from message text. */
function spawnReason(outcome: { timedOut: boolean }): string {
  return outcome.timedOut ? "timed out" : "exited early";
}
