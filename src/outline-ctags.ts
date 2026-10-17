/**
 * universal-ctags extractor for `belayd_outline`.
 *
 * ctags is the universal extractor: one `ctags --output-format=json` process
 * covers every supported language in the file set, tagged with a stable
 * `kind`/`line` (and `end` where the language parser provides it). It is the
 * base symbol set; {@link ./outline-ast-grep.js} refines TypeScript.
 *
 * The JSON parsing is pure and exported separately from the spawn seam so the
 * unit tests can drive it with fixture strings and no binaries.
 */

import type { OutlineKind, OutlineSymbol, OutlineSymbolGroup } from "./outline.js";
import { isOutlineJsTsKeyword } from "./outline.js";
import { resolveOutlineBinary, spawnOutlineBinary } from "./outline-binary.js";

export const OUTLINE_CTAGS_ENV = "BELAYD_CTAGS_BIN";
export const OUTLINE_CTAGS_DEFAULT = "ctags";
export const OUTLINE_CTAGS_TIMEOUT_MS = 15_000;
export const OUTLINE_CTAGS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const OUTLINE_CTAGS_INSTALL_HINT =
  "Install universal-ctags (the devShell provides pkgs.universal-ctags), or set BELAYD_CTAGS_BIN.";

/**
 * Extensions ctags 6.2.1 does not map by default but that the outline accepts.
 *
 * `--map-<LANG>` accepts exactly one pattern per occurrence (see ctags(1)); a
 * comma-separated list is not parsed, so each entry becomes its own option.
 * Without these, `.tsx`/`.mts`/`.cts`/`.cjs` resolve as language `NONE` and
 * produce zero tags.
 */
export const OUTLINE_CTAGS_MAP_OVERRIDES: ReadonlyArray<{
  language: string;
  extension: string;
}> = [
  { language: "TypeScript", extension: ".tsx" },
  { language: "TypeScript", extension: ".mts" },
  { language: "TypeScript", extension: ".cts" },
  { language: "JavaScript", extension: ".cjs" },
];

function ctagsMapArgs(): string[] {
  return OUTLINE_CTAGS_MAP_OVERRIDES.map(
    (override) => `--map-${override.language}=+${override.extension}`,
  );
}

/**
 * Extensions ctags parses with its JavaScript or TypeScript grammar. Only
 * these can emit the keyword-named destructuring noise this module filters.
 */
const CTAGS_JS_TS_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/**
 * ctags kinds whose `name` is a declaration identifier. A declaration name can
 * never be a reserved word, so a keyword there is parser noise (the `constant
 * const` row ctags emits for `const { const: x } = obj;`). Member kinds are
 * deliberately excluded: `property`/`method`/`field`/`member` names are legal
 * keyword-named class members (`class Access { public = 1; const = 1 }`) and
 * must surface.
 */
const CTAGS_DECLARATION_KINDS: ReadonlySet<string> = new Set([
  "function",
  "func",
  "generator",
  "subroutine",
  "class",
  "interface",
  "type",
  "typedef",
  "alias",
  "enum",
  "constant",
  "variable",
]);

function isCtagsJsTsPath(path: string): boolean {
  const lower = path.toLowerCase();
  return CTAGS_JS_TS_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * True when a ctags tag is JS/TS parser noise rather than a symbol. Two
 * shapes are dropped: the `anonymousObject<hash>` holder tag ctags invents for
 * an object literal, and a reserved word captured in a declaration/lexical
 * position (the `constant const` row for `const { const: x } = obj;`). Member
 * kinds are not keyword-filtered because keyword-named class members are legal.
 */
function isCtagsNoise(path: string, name: string, kind: string): boolean {
  if (!isCtagsJsTsPath(path)) return false;
  if (name.startsWith("anonymousObject")) return true;
  return CTAGS_DECLARATION_KINDS.has(kind) && isOutlineJsTsKeyword(name);
}

/**
 * Scope kinds that enclose members of a type. ctags tags a C++ member
 * function, a Go method, and a PHP trait method as `function`/`func` and only
 * the enclosing `scopeKind` distinguishes them from free functions, so these
 * select the `method` arm. `implementation` is deliberately absent: it is a
 * ctags `member` scope, handled separately below.
 */
const CTAGS_MEMBER_SCOPE_KINDS: ReadonlySet<string> = new Set([
  "class",
  "struct",
  "union",
  "interface",
  "record",
  "trait",
]);

/** `+n` line, `+e` end, `+K` long kind name, `+S` signature. */
export function buildCtagsArgs(files: readonly string[]): string[] {
  return ["--output-format=json", "--fields=+neKS", "-f", "-", ...ctagsMapArgs(), ...files];
}

/**
 * Map a ctags `kind` (long name) onto the outline vocabulary.
 *
 * `scopeKind` disambiguates two overloaded ctags kinds: a Python class method
 * and a Go struct field are both `member`, and a C++/Go member function and a
 * free function are both `function`/`func`; only the enclosing scope separates
 * them. Kinds with no outline counterpart (enumerators, packages,
 * implementations, …) are dropped deterministically via the explicit no-op
 * arm at the bottom.
 */
export function mapCtagsKind(kind: string, scopeKind: string | undefined): OutlineKind | undefined {
  switch (kind) {
    // Function-like declarations. A `function`/`func` nested in a type scope is
    // a method (C++ member functions, Go methods); a plain declaration stays a
    // function. `generator`/`subroutine` share the arm because ctags uses them
    // for the same declaration shape in JS and Perl.
    case "function":
    case "func":
    case "generator":
    case "subroutine":
      return scopeKind !== undefined && CTAGS_MEMBER_SCOPE_KINDS.has(scopeKind)
        ? "method"
        : "function";
    // Ruby tags `def self.x` as `singletonMethod` and Go interface method
    // specifications as `methodSpec`; both are method declarations.
    case "method":
    case "singletonMethod":
    case "methodSpec":
      return "method";
    // ctags overloads `member`: a Python class method and a Go/C++ struct
    // field are both `member`, separated by the enclosing scope.
    case "member":
      return scopeKind === "class" || scopeKind === "implementation" || scopeKind === "trait"
        ? "method"
        : "field";
    // Kotlin `object Foo` is a singleton class declaration.
    case "class":
    case "object":
      return "class";
    // Java `@interface Foo` and Elixir `defprotocol` are interface-like.
    case "interface":
    case "annotation":
    case "protocol":
      return "interface";
    case "type":
    case "typedef":
    case "alias":
    case "talias":
    case "typealias":
      return "type";
    case "enum":
      return "enum";
    // Go emits `const` where C-family languages emit `constant`; PHP constants
    // are `define`, whether declared with `const` or `define()`.
    case "constant":
    case "const":
    case "define":
      return "const";
    case "variable":
    case "val":
      return "var";
    // Ruby `attr_accessor` and JS `get`/`set` accessors are property-like, as
    // are C# events.
    case "property":
    case "accessor":
    case "getter":
    case "setter":
    case "event":
      return "property";
    // Go anonymous (embedded) struct members and OCaml record fields are fields.
    case "field":
    case "anonMember":
    case "RecordField":
      return "field";
    case "struct":
    case "record":
      return "struct";
    case "union":
      return "union";
    case "trait":
      return "trait";
    // A C++20 module partition is a module fragment.
    case "module":
    case "partition":
      return "module";
    case "namespace":
      return "namespace";
    case "macro":
      return "macro";
    // Elixir `defdelegate`/`defguard`/`defmacro a op b` all declare callables.
    case "delegate":
    case "guard":
    case "operator":
      return "function";

    // Real, enabled ctags kinds with no matching outline kind. They are
    // dropped deliberately rather than misrepresented:
    //   - `enumerator`/`enumConstant`: enum members have no enum-member kind in
    //     the vocabulary; reporting them as `const` would flatten an enum type.
    //   - `package`/`packageName`: package headers and imported package names
    //     are not declarations.
    //   - `implementation`: a Rust `impl`/Elixir `defimpl` block has no name.
    //   - `unknown`: a Python `from … import x as y` reference, not a binding.
    //   - `heredoc`: a shell here-document label.
    //   - `callback`: an Elixir `@callback` type specification.
    //   - `test`: an Elixir `test "…"` block.
    //   - `exception`: an Elixir `defexception` module.
    //   - `constructor`/`Constructor`: a Haskell/OCaml value constructor.
    //   - `Exception`: an OCaml exception declaration.
    case "enumerator":
    case "enumConstant":
    case "package":
    case "packageName":
    case "implementation":
    case "unknown":
    case "heredoc":
    case "callback":
    case "test":
    case "exception":
    case "constructor":
    case "Constructor":
    case "Exception":
      return undefined;
    default:
      return undefined;
  }
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

/**
 * ctags' TypeScript parser has no `end` field and does not mark exports, so
 * derive `exported` from the pattern's first source line.
 */
function ctagsPatternIsExported(pattern: unknown): boolean {
  if (typeof pattern !== "string") return false;
  const body = pattern.startsWith("/^") && pattern.endsWith("$/") ? pattern.slice(2, -2) : pattern;
  return /^export\b/.test(body);
}

function ctagsTagToSymbol(
  tag: Record<string, unknown>,
): { path: string; symbol: OutlineSymbol } | undefined {
  const name = tag.name;
  const path = tag.path;
  const line = tag.line;
  const kind = tag.kind;
  if (typeof name !== "string" || name === "") return undefined;
  if (typeof path !== "string" || path === "") return undefined;
  if (typeof line !== "number" || !Number.isFinite(line) || line < 1) return undefined;
  if (typeof kind !== "string" || kind === "") return undefined;
  if (isCtagsNoise(path, name, kind)) return undefined;

  const scopeKind = typeof tag.scopeKind === "string" ? tag.scopeKind : undefined;
  // ctags reports a `const` declared inside a function body with a function
  // scope; the outline is top-level declarations, so drop those.
  if (scopeKind === "function" || scopeKind === "method" || scopeKind === "local") {
    return undefined;
  }
  const outlineKind = mapCtagsKind(kind, scopeKind);
  if (outlineKind === undefined) return undefined;

  const startLine = Math.trunc(line);
  const end = tag.end;
  const endLine =
    typeof end === "number" && Number.isFinite(end) && end >= startLine
      ? Math.trunc(end)
      : startLine;

  return {
    path,
    symbol: {
      name,
      kind: outlineKind,
      startLine,
      endLine,
      exported: ctagsPatternIsExported(tag.pattern),
    },
  };
}

/**
 * Group `ctags --output-format=json` lines into per-file symbol lists.
 *
 * Non-tag records (`ptag`), malformed JSON lines, unparsable tags, unknown
 * kinds, and function-local tags are skipped; one bad line never aborts the
 * run.
 */
export function parseCtagsJson(stdout: string): OutlineSymbolGroup[] {
  const groups = new Map<string, OutlineSymbol[]>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const tag = parseJsonObject(trimmed);
    if (tag === undefined) continue;
    if (tag._type !== "tag") continue;
    const converted = ctagsTagToSymbol(tag);
    if (converted === undefined) continue;
    const existing = groups.get(converted.path);
    if (existing === undefined) groups.set(converted.path, [converted.symbol]);
    else existing.push(converted.symbol);
  }
  return [...groups.entries()].map(([path, symbols]) => ({ path, symbols }));
}

/**
 * Run ctags once over the whole file set. A missing binary or a failed run is
 * an error value, never a throw; the 15 s timeout and 32 MB buffer keep a hung
 * or chatty binary from wedging the tool.
 *
 * When the process fails but still emitted parseable JSON (a timeout or a
 * buffer overflow is the common case), the recovered symbols are returned as a
 * degraded success with a note instead of discarding the whole run.
 */
export type OutlineCtagsResult =
  | { ok: true; groups: OutlineSymbolGroup[]; note?: string }
  | { ok: false; error: string };

/** Per-call knobs; `env`/`timeoutInMs` exist so tests can drive failure paths. */
export interface OutlineCtagsRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutInMs?: number;
}

function hasAnySymbol(groups: readonly OutlineSymbolGroup[]): boolean {
  return groups.some((group) => group.symbols.length > 0);
}

export async function runCtags(
  files: readonly string[],
  options: OutlineCtagsRunOptions = {},
): Promise<OutlineCtagsResult> {
  if (files.length === 0) return { ok: true, groups: [] };
  const binary = resolveOutlineBinary(
    {
      envName: OUTLINE_CTAGS_ENV,
      defaultBinary: OUTLINE_CTAGS_DEFAULT,
      installHint: OUTLINE_CTAGS_INSTALL_HINT,
    },
    options.env ?? process.env,
  );
  if (!binary.ok) return { ok: false, error: binary.error };

  const outcome = await spawnOutlineBinary({
    binary: binary.path,
    args: buildCtagsArgs(files),
    timeoutInMs: options.timeoutInMs ?? OUTLINE_CTAGS_TIMEOUT_MS,
    maxBufferBytes: OUTLINE_CTAGS_MAX_BUFFER_BYTES,
    installHint: OUTLINE_CTAGS_INSTALL_HINT,
  });
  if (outcome.ok) return { ok: true, groups: parseCtagsJson(outcome.stdout) };

  const recovered = parseCtagsJson(outcome.stdout);
  if (hasAnySymbol(recovered)) {
    return {
      ok: true,
      groups: recovered,
      note: `note: ctags ${spawnReason(outcome)} before completing; the outline lists only the symbols recovered from its partial output.`,
    };
  }
  return { ok: false, error: outcome.error };
}

/** Phrase a spawn failure from its classified outcome, never from message text. */
function spawnReason(outcome: { timedOut: boolean }): string {
  return outcome.timedOut ? "timed out" : "exited early";
}
