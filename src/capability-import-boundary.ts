/**
 * Capability import boundary (bd-179).
 *
 * `extensions/index.ts` is the composer: it may import anything. The capability
 * modules under `extensions/capabilities/` must stay callable without the fleet
 * supervisor and without the process gate, because both the durable-member
 * runtime and the PR publish path need the process core outside an extension.
 *
 * The check resolves relative import specifiers to files and walks the **whole
 * transitive module graph** — plain imports, re-exports, and literal dynamic
 * imports — so a capability cannot reach the process gate through an
 * intermediate (`doctor.ts → tool-audit.ts → process-gate.ts`). Type-only
 * imports of intermediates are erased at runtime and are therefore not edges,
 * except at the capability itself, where any specifier naming a forbidden
 * module is a violation.
 *
 * Two independent rules:
 *
 * - `src/process-gate.ts` is forbidden for EVERY capability module, with no
 *   exemption list.
 * - `src/fleet-*.ts` / `src/fleet-state.ts` are forbidden except for the
 *   capability files named in the test's explicit `FLEET_IMPORT_ALLOWLIST`.
 *   Being fleet-allowlisted never permits the process gate.
 *
 * It fails closed: an unreadable module, an unresolvable relative specifier, or
 * a non-literal dynamic import is a violation naming the file and specifier.
 *
 * Pure functions take an injected `read`/`exists` seam so the rule is
 * unit-testable over synthetic module graphs.
 */
import { posix } from "node:path";

/** One import-like reference in a module. */
export interface ImportEdge {
  /** The literal specifier: `"./x.js"`, `"../../src/index.js"`, `"typebox"`. */
  specifier: string;
  /** Type-only edges are erased at runtime; see {@link parseModuleReferences}. */
  typeOnly: boolean;
  kind: "import" | "reexport" | "dynamic";
}

/** A module's references, split by how they bind. */
export interface ModuleReferences {
  /** Value imports, including side-effect imports. */
  imports: ImportEdge[];
  /** `import type` / all-`type`-specifier imports (runtime-erased). */
  typeImports: ImportEdge[];
  /** `export ... from` edges: these widen the module's surface. */
  reexports: ImportEdge[];
  /** Literal `await import("…")` specifiers. */
  dynamicImports: ImportEdge[];
  /** Dynamic imports whose argument is not a string literal (reported, never ignored). */
  nonLiteralDynamicImports: string[];
}

const IMPORT_START = /^[ \t]*import\b/;
const EXPORT_START = /^[ \t]*export\b/;
const REEXPORT_HEAD = /^[ \t]*export\s+(type\s+)?(\*|\{)/;
const FROM_CLAUSE = /\bfrom\s*["']([^"']+)["']/;
const BARE_IMPORT = /^[ \t]*import\s*["']([^"']+)["']/;
const TYPE_IMPORT_PREFIX = /^[ \t]*import\s+type\b/;
const NAMED_SPECIFIERS = /\{([\s\S]*?)\}/;

/**
 * Blank out comments while preserving strings and line structure.
 *
 * The scan must not classify a commented-out import, and the dynamic-import
 * scan must not see `import(` inside documentation. Strings are copied
 * verbatim because a specifier lives in one; comment characters become spaces
 * and newlines survive so line-oriented statement collection still works.
 */
function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'" || char === "`";
}

/** Blank one line comment, preserving the newline at its end. */
function skipLineComment(source: string, start: number): { text: string; end: number } {
  let index = start;
  while (index < source.length && source[index] !== "\n") index += 1;
  return { text: " ".repeat(index - start), end: index };
}

/** Blank one block comment, preserving its newlines. */
function skipBlockComment(source: string, start: number): { text: string; end: number } {
  let index = start + 2;
  while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
    index += 1;
  }
  const blanked = source
    .slice(start, index + 2)
    .split("")
    .map((char) => (char === "\n" ? "\n" : " "))
    .join("");
  return { text: blanked, end: index + 2 };
}

/**
 * Characters after which a `/` starts a regex literal rather than a division.
 *
 * A regex body may contain quotes (`/["']/`), so treating one as ordinary code
 * would let `readQuoted` swallow every following line as string content and
 * hide the imports after it — the evasion corner this checker must not have.
 * The set is the expression-position prefixes a regex can legally follow; a
 * `/` after anything else stays division and is copied verbatim.
 */
const REGEX_PREFIX_CHARS = new Set(["=", "(", ",", "[", "{", ":", "!", "&", "|", "?", ";"]);
const REGEX_PREFIX_WORDS = new Set(["return", "typeof", "case", "delete", "void", "in", "of"]);

/** True when a `/` at `index` follows an expression-position token. */
function startsRegexLiteral(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor] ?? "")) cursor -= 1;
  const previous = source[cursor];
  if (previous === undefined) return true;
  if (REGEX_PREFIX_CHARS.has(previous)) return true;
  if (!/[\w$]/.test(previous)) return false;
  let wordStart = cursor;
  while (wordStart >= 0 && /[\w$]/.test(source[wordStart] ?? "")) wordStart -= 1;
  return REGEX_PREFIX_WORDS.has(source.slice(wordStart + 1, cursor + 1));
}

/**
 * Skip one regex literal starting at its opening `/`.
 *
 * Returns the index just past the closing `/` and its flags. A body that never
 * closes is read to the end of the current line at most: a mis-detected regex
 * must degrade to "skip this line", never to "hide the rest of the file".
 */
function skipRegexLiteral(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length && source[index] !== "\n" && (source[index] !== "/" || inClass)) {
    const char = source[index];
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    index += 1;
  }
  if (source[index] !== "/") return index;
  index += 1;
  while (index < source.length && /[a-z]/i.test(source[index] ?? "")) index += 1;
  return index;
}

function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && (next === "/" || next === "*")) {
      const skipped =
        next === "/" ? skipLineComment(source, index) : skipBlockComment(source, index);
      out += skipped.text;
      index = skipped.end;
      continue;
    }
    if (char === "/" && startsRegexLiteral(source, index)) {
      const end = skipRegexLiteral(source, index);
      out += source.slice(index, end);
      index = end;
      continue;
    }
    if (isQuote(char)) {
      const quoted = readQuoted(source, index);
      out += source.slice(index, quoted.end);
      index = quoted.end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Read a quoted string starting at `start` (the opening quote).
 *
 * Returns the raw text and the index just past the closing quote. Templates are
 * read to their closing backtick; interpolation is kept as text, which is why
 * the dynamic-import scan reports a template argument as non-literal.
 */
function readQuoted(source: string, start: number): { text: string; end: number } {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return { text: source.slice(start + 1, index), end: index + 1 };
    index += 1;
  }
  return { text: source.slice(start + 1), end: source.length };
}

/**
 * End index of a string or regex literal starting at `index`, or -1 when the
 * character is neither.
 *
 * A regex body may contain quotes, so it must be skipped as code: reading one as
 * an opening quote swallows the literal `import("…")` that follows it.
 */
function skipNonCode(code: string, index: number): number {
  const char = code[index];
  if (char === "/" && startsRegexLiteral(code, index)) return skipRegexLiteral(code, index);
  if (char === '"' || char === "'" || char === "`") return readQuoted(code, index).end;
  return -1;
}

/** Dynamic-import arguments found in code (never in strings or comments). */
function scanDynamicImports(code: string): { literal: string[]; nonLiteral: string[] } {
  const literal: string[] = [];
  const nonLiteral: string[] = [];
  let index = 0;
  while (index < code.length) {
    const skipped = skipNonCode(code, index);
    if (skipped !== -1) {
      index = skipped;
      continue;
    }
    const matchesImport = code.startsWith("import", index) && !/[\w$.]/.test(code[index - 1] ?? "");
    const argumentStart = matchesImport ? skipToArgument(code, index + "import".length) : -1;
    if (argumentStart === -1) {
      index += 1;
      continue;
    }
    const parsed = classifyDynamicArgument(code, argumentStart);
    if (parsed.literal !== undefined) literal.push(parsed.literal);
    else if (parsed.expression !== undefined) nonLiteral.push(parsed.expression);
    index = parsed.end;
  }
  return { literal, nonLiteral };
}

/** Index of the first argument character after `import(`, or -1. */
function skipToArgument(code: string, from: number): number {
  let index = from;
  while (index < code.length && /\s/.test(code[index] ?? "")) index += 1;
  if (code[index] !== "(") return -1;
  index += 1;
  while (index < code.length && /\s/.test(code[index] ?? "")) index += 1;
  return index;
}

/** Read a string/template argument and check it is the whole call argument. */
function readLiteralArgument(
  code: string,
  start: number,
  quote: string,
): { literal?: string; expression?: string; end: number } {
  const quoted = readQuoted(code, start);
  const afterQuote = code.slice(quoted.end).match(/^\s*\)/);
  if (afterQuote === null) {
    // A quoted argument that is not the whole argument (`import("./x" + suffix)`)
    // is dynamic. Dropping it silently would make a genuinely unresolvable
    // specifier look like "nothing to report" in a fail-closed check, so it is
    // reported as the non-literal expression it is.
    const rest = readExpressionArgument(code, start);
    return { expression: rest.expression, end: rest.end };
  }
  const end = quoted.end + (afterQuote[0]?.length ?? 0);
  const interpolated = quote === "`" && quoted.text.includes("${");
  return interpolated ? { expression: quoted.text.trim(), end } : { literal: quoted.text, end };
}

/** Read a non-literal argument expression up to its closing paren. */
function readExpressionArgument(code: string, start: number): { expression: string; end: number } {
  let index = start;
  let depth = 0;
  while (index < code.length) {
    const current = code[index];
    if (isQuote(current)) {
      index = readQuoted(code, index).end;
      continue;
    }
    if (current === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (current === ")" && depth === 0) break;
    if (current === ")") depth -= 1;
    index += 1;
  }
  return { expression: code.slice(start, index).trim(), end: index + 1 };
}

/** Classify an `import(` argument: literal specifier, expression, or neither. */
function classifyDynamicArgument(
  code: string,
  start: number,
): { literal?: string; expression?: string; end: number } {
  const char = code[start];
  return isQuote(char)
    ? readLiteralArgument(code, start, char ?? "")
    : readExpressionArgument(code, start);
}

/**
 * Collect import/export statements.
 *
 * A statement starts at a line beginning with `import`/`export` and ends at the
 * **first `;` character** — not at the end of a line, because a trailing
 * comment after the semicolon (`import "./x.js"; // note;`) would otherwise
 * swallow the next import into the same blob and hide it from the classifier.
 * Only statements whose head is a binding form are kept, so a multi-line
 * `export function` body cannot be mistaken for one.
 */
function statements(source: string): string[] {
  const collected: string[] = [];
  let current = "";
  let collecting = false;
  const append = (text: string): void => {
    current = current === "" ? text : `${current}\n${text}`;
  };
  for (const line of source.split("\n")) {
    let rest = line;
    while (rest !== "") {
      if (!collecting) {
        if (!IMPORT_START.test(rest) && !EXPORT_START.test(rest)) break;
        collecting = true;
        current = "";
      }
      const semicolon = rest.indexOf(";");
      if (semicolon === -1) {
        append(rest);
        break;
      }
      append(rest.slice(0, semicolon));
      collected.push(current);
      collecting = false;
      current = "";
      rest = rest.slice(semicolon + 1).trimStart();
    }
  }
  if (collecting) collected.push(current);
  return collected;
}

/** True when every named specifier inside `{…}` carries `type`. */
function namedSpecifiersAreTypeOnly(statement: string): boolean {
  const match = NAMED_SPECIFIERS.exec(statement);
  if (match?.[1] === undefined) return false;
  const parts = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length > 0 && parts.every((part) => part.startsWith("type "));
}

/** Classify one statement, or null when it binds no specifier. */
function classifyStatement(statement: string): ImportEdge | null {
  if (IMPORT_START.test(statement)) {
    const from = FROM_CLAUSE.exec(statement);
    if (from?.[1] !== undefined) {
      const typeOnly = TYPE_IMPORT_PREFIX.test(statement) || namedSpecifiersAreTypeOnly(statement);
      return { specifier: from[1], typeOnly, kind: "import" };
    }
    const bare = BARE_IMPORT.exec(statement);
    return bare?.[1] === undefined ? null : { specifier: bare[1], typeOnly: false, kind: "import" };
  }
  if (!REEXPORT_HEAD.test(statement)) return null;
  const from = FROM_CLAUSE.exec(statement);
  if (from?.[1] === undefined) return null;
  const typeOnly = /^[ \t]*export\s+type\b/.test(statement);
  return { specifier: from[1], typeOnly, kind: "reexport" };
}

/** Split a module's source into import, re-export and dynamic-import references. */
export function parseModuleReferences(rawSource: string): ModuleReferences {
  const references: ModuleReferences = {
    imports: [],
    typeImports: [],
    reexports: [],
    dynamicImports: [],
    nonLiteralDynamicImports: [],
  };
  const source = stripComments(rawSource);
  for (const statement of statements(source)) {
    const edge = classifyStatement(statement);
    if (edge === null) continue;
    if (edge.kind === "reexport") references.reexports.push(edge);
    else if (edge.typeOnly) references.typeImports.push(edge);
    else references.imports.push(edge);
  }
  const dynamic = scanDynamicImports(source);
  for (const specifier of dynamic.literal) {
    references.dynamicImports.push({ specifier, typeOnly: false, kind: "dynamic" });
  }
  references.nonLiteralDynamicImports.push(...dynamic.nonLiteral);
  return references;
}

/** True for the specifiers the boundary rule resolves: relative paths only. */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Resolve a relative specifier against the importing module's repo-relative
 * path.
 *
 * TypeScript source imports carry a `.js` extension that names the *emitted*
 * file, so `.js` maps to `.ts`; a bare directory resolves to its `index.ts`.
 * Returns null when nothing on disk matches — the caller reports that as a
 * violation rather than skipping it.
 */
export function resolveRelativeSpecifier(
  fromFile: string,
  specifier: string,
  exists: (repoRelativePath: string) => boolean,
): string | null {
  if (!isRelativeSpecifier(specifier)) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const candidates = specifier.endsWith(".js")
    ? [`${base.slice(0, -3)}.ts`]
    : specifier.endsWith(".ts")
      ? [base]
      : [`${base}.ts`, posix.join(base, "index.ts")];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** `src/process-gate.ts` is forbidden for every capability module. */
export function isForbiddenProcessGate(repoRelativePath: string): boolean {
  return repoRelativePath === "src/process-gate.ts";
}

/** `src/fleet-*.ts` and `src/fleet-state.ts` are forbidden unless allowlisted. */
export function isForbiddenFleetImport(repoRelativePath: string): boolean {
  if (!repoRelativePath.startsWith("src/")) return false;
  const local = repoRelativePath.slice("src/".length);
  if (local.includes("/")) return false;
  return local === "fleet-state.ts" || local.startsWith("fleet-");
}

/** Why a scan failed. */
export type BoundaryViolationKind =
  | "process-gate"
  | "fleet"
  | "unresolvable-specifier"
  | "unreadable-module"
  | "dynamic-non-literal";

/** One boundary failure, with the module chain that produced it. */
export interface BoundaryViolation {
  kind: BoundaryViolationKind;
  /** Repo-relative modules from the capability to the offending module/specifier. */
  chain: string[];
  /** Human-readable explanation naming the file and specifier. */
  detail: string;
}

/** Injected filesystem seams so the walk is testable without fixtures on disk. */
export interface ModuleGraphSeams {
  read: (repoRelativePath: string) => string | undefined;
  exists: (repoRelativePath: string) => boolean;
}

/** Inputs for one capability scan. */
export interface BoundaryScanOptions {
  /** Repo-relative capability module. */
  entry: string;
  seams: ModuleGraphSeams;
  /** True when this exact file is named in `FLEET_IMPORT_ALLOWLIST`. */
  fleetAllowed: boolean;
}

/** The walk is breadth-first; one node's edges are classified by `classifyEdge`. */
interface PendingModule {
  module: string;
  chain: string[];
}

function forbiddenViolation(
  target: string,
  chain: string[],
  fleetAllowed: boolean,
): BoundaryViolation | null {
  if (isForbiddenProcessGate(target)) {
    return {
      kind: "process-gate",
      chain,
      detail: `${chain[0] ?? ""} reaches src/process-gate.ts via ${chain.join(" -> ")}`,
    };
  }
  if (!fleetAllowed && isForbiddenFleetImport(target)) {
    return {
      kind: "fleet",
      chain,
      detail: `${chain[0] ?? ""} reaches fleet module ${target} via ${chain.join(" -> ")}`,
    };
  }
  return null;
}

/** Mutable walk state shared by one scan. */
interface ScanState {
  entry: string;
  seams: ModuleGraphSeams;
  fleetAllowed: boolean;
  visited: Set<string>;
  queue: PendingModule[];
}

/** Collect the violations one module contributes and enqueue its clean imports. */
function processModule(state: ScanState, pending: PendingModule): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const source = state.seams.read(pending.module);
  if (source === undefined) {
    return [
      {
        kind: "unreadable-module",
        chain: pending.chain,
        detail: `cannot read ${pending.module} (imported via ${pending.chain.join(" -> ")})`,
      },
    ];
  }
  const references = parseModuleReferences(source);
  // Type-only imports of intermediates are erased at runtime; the capability's
  // own imports are checked whatever their form.
  const edges = [
    ...references.imports,
    ...(pending.module === state.entry ? references.typeImports : []),
    ...references.reexports,
    ...references.dynamicImports,
  ];
  for (const edge of edges) {
    const violation = visitEdge({
      edge,
      pending,
      seams: state.seams,
      fleetAllowed: state.fleetAllowed,
      queue: state.queue,
    });
    if (violation !== null) violations.push(violation);
  }
  for (const expression of references.nonLiteralDynamicImports) {
    violations.push({
      kind: "dynamic-non-literal",
      chain: pending.chain,
      detail:
        `${pending.module} uses a non-literal dynamic import (${expression}); ` +
        "the boundary rule cannot resolve it",
    });
  }
  return violations;
}

/**
 * Scan one capability module's transitive graph.
 *
 * `fleetAllowed` only relaxes the fleet rule; the process gate stays forbidden
 * for that file too.
 */
export function scanCapabilityModule(options: BoundaryScanOptions): BoundaryViolation[] {
  const state: ScanState = {
    entry: options.entry,
    seams: options.seams,
    fleetAllowed: options.fleetAllowed,
    visited: new Set<string>(),
    queue: [{ module: options.entry, chain: [options.entry] }],
  };
  const violations: BoundaryViolation[] = [];
  while (state.queue.length > 0) {
    const pending = state.queue.shift();
    if (pending === undefined) break;
    if (state.visited.has(pending.module)) continue;
    state.visited.add(pending.module);
    violations.push(...processModule(state, pending));
  }
  return violations;
}

/** Resolve and classify one edge; enqueue the target when it is clean. */
function visitEdge(input: {
  edge: ImportEdge;
  pending: PendingModule;
  seams: ModuleGraphSeams;
  fleetAllowed: boolean;
  queue: PendingModule[];
}): BoundaryViolation | null {
  const { edge, pending, seams, fleetAllowed, queue } = input;
  const { module, chain } = pending;
  if (!isRelativeSpecifier(edge.specifier)) return null; // node:* and package deps
  const resolved = resolveRelativeSpecifier(module, edge.specifier, seams.exists);
  if (resolved === null) {
    return {
      kind: "unresolvable-specifier",
      chain: [...chain, edge.specifier],
      detail: `${module} imports "${edge.specifier}", which resolves to no file on disk`,
    };
  }
  const nextChain = [...chain, resolved];
  const forbidden = forbiddenViolation(resolved, nextChain, fleetAllowed);
  if (forbidden !== null) return forbidden;
  queue.push({ module: resolved, chain: nextChain });
  return null;
}
