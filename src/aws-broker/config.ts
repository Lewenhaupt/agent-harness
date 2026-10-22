/**
 * Operator allowlist + per-repo AWS profile config (bd-125).
 *
 * Two files decide whether an agent gets AWS credentials, and both must agree:
 *
 * 1. Operator allowlist (`~/.config/belayd/aws.yaml`) lists which worktrees
 *    exist and which credential profiles each one may use:
 *
 *    ```yaml
 *    region: eu-north-1                     # optional default region
 *    scopes:
 *      - worktree: /home/hugo/git/acme-*    # glob on the git toplevel
 *        profiles: [agent-readonly, agent-deploy]
 *        default: agent-readonly
 *        region: us-east-1                  # optional per-scope override
 *    ```
 *
 * 2. Repo file (`<worktree>/.belayd/aws.yaml`) names one *literal* profile:
 *
 *    ```yaml
 *    profile: agent-deploy
 *    ```
 *
 * Either level may also carry `mask:` — extra host paths the operator wants
 * hidden *inside* that scope's sandbox (an IAM RolesAnywhere certificate and
 * private key are the motivating case: the broker must read them, the agent
 * must not, or an agent can call the signing helper directly and bypass this
 * whole allowlist):
 *
 *    ```yaml
 *    mask: [/srv/aws/agent-cert]          # top level: applied to every scope
 *    scopes:
 *      - worktree: /home/hugo/git/acme-*
 *        profiles: [dev-agent]
 *        mask:
 *          - /srv/aws/acme-cert
 *          - /srv/aws/acme-key
 *    ```
 *
 * The repo file deliberately has no `mask:` key: a repo must not be able to
 * widen (or shrink) its own sandbox, so masks are operator-only.
 *
 * Everything here is pure: text in, discriminated union out. The repo file is
 * mandatory and must name a profile the allowlist grants that worktree — this
 * is the fail-closed rule. No repo file means no AWS inside the sandbox, not a
 * default profile.
 *
 * The parser is a deliberately tiny YAML subset (block maps, block/flow
 * sequences, quoted or bare scalars, `#` comments) rather than a new
 * dependency: `package.json` has no YAML package and the schema above is the
 * only shape this project ever needs. Anything outside the subset is rejected
 * with a line number instead of being silently ignored.
 */

/** One allowlist entry: a worktree glob plus the profiles it may use. */
export interface AwsScopeRule {
  /** Glob matched against the git toplevel (absolute path). */
  worktree: string;
  /** Literal profile names the repo file may name. */
  profiles: readonly string[];
  /** Allowlist default, used for diagnostics and documentation only. */
  defaultProfile?: string;
  /** Per-scope region override. */
  region?: string;
  /** Extra paths to mask inside this scope's sandbox, as written. */
  mask: readonly string[];
}

/** Parsed operator allowlist. */
export interface AwsAllowlist {
  scopes: readonly AwsScopeRule[];
  region?: string;
  /** Extra paths masked inside every scope's sandbox, as written. */
  mask: readonly string[];
}

/** Parsed repo file. */
export interface AwsRepoConfig {
  profile: string;
}

/** Parsed value or an actionable refusal reason. */
export type ConfigResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A resolved scope: the rule, the literal profile, and the region to deliver. */
export interface ResolvedAwsScope {
  rule: AwsScopeRule;
  profile: string;
  region: string | undefined;
}

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function ok<T>(value: T): ConfigResult<T> {
  return { ok: true, value };
}

function fail<T>(reason: string): ConfigResult<T> {
  return { ok: false, reason };
}

interface ConfigLine {
  indent: number;
  text: string;
  lineNumber: number;
}

/**
 * Strip a `#` comment that starts the line or follows whitespace. Quotes are
 * tracked so a `#` inside a profile name (not legal for AWS, but cheap to
 * handle) cannot truncate a value.
 */
function stripComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === undefined) break;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && isCommentStart(raw, index)) return raw.slice(0, index);
  }
  return raw;
}

/** A `#` starts a comment at line start or after whitespace. */
function isCommentStart(raw: string, index: number): boolean {
  if (index === 0) return true;
  const previous = raw[index - 1];
  return previous !== undefined && /\s/.test(previous);
}

/** Split into non-empty, comment-free lines with their indentation. */
function structuralLines(text: string): ConfigResult<readonly ConfigLine[]> {
  const lines: ConfigLine[] = [];
  const rawLines = text.split("\n");
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index] ?? "";
    const stripped = stripComment(raw);
    if (stripped.trim() === "") continue;
    if (stripped.includes("\t")) {
      return fail(`line ${index + 1}: tabs are not supported; indent with spaces`);
    }
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, text: stripped.trim(), lineNumber: index + 1 });
  }
  return ok(lines);
}

/** Remove surrounding single/double quotes from a scalar. */
function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

interface KeyValue {
  key: string;
  value: string;
}

/** Split `key: value` / `key:`; undefined when the line is not a map entry. */
function splitKeyValue(text: string): KeyValue | undefined {
  const colon = text.indexOf(":");
  if (colon <= 0) return undefined;
  const key = text.slice(0, colon).trim();
  if (key === "" || key.includes(" ")) return undefined;
  return { key, value: text.slice(colon + 1).trim() };
}

/** Parse `[a, b]`; undefined when the text is not a flow sequence. */
function parseFlowSequence(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((entry) => parseScalar(entry));
}

/** Validate a profile name once, at parse/compare time. */
function validateProfileName(name: string): ConfigResult<string> {
  if (name === "") return fail("profile names must not be empty");
  if (!PROFILE_NAME_PATTERN.test(name)) {
    return fail(`invalid profile name "${name}": expected letters, digits, "_", "." or "-"`);
  }
  return ok(name);
}

/** A scope under construction. */
interface PendingScope {
  worktree: string | undefined;
  profiles: string[];
  defaultProfile?: string;
  region?: string;
  mask: string[];
}

/** Scope keys whose value may be a block list (`- item` at indent 6). */
type BlockListKey = "profiles" | "mask";

/** Mutable parse state, threaded through the line handlers below. */
interface AllowlistParseState {
  scopes: AwsScopeRule[];
  region: string | undefined;
  mask: string[];
  current: PendingScope | undefined;
  /** Scope key the next indent-6 `- item` lines belong to. */
  blockListKey: BlockListKey | undefined;
  /**
   * True while `- item` lines are a top-level `mask` block instead of scope
   * entries. `mask:` is the only top-level key that takes a block list, so its
   * items would otherwise read as `scopes` entries — the state is what
   * disambiguates them, and any indent-0 line ends it. Items are accepted at
   * any indent ≥2 so a four-space habit is not mistaken for a broken scope
   * entry; a scope entry only ever starts at the pinned indent 2.
   */
  topLevelMaskBlock: boolean;
}

type AllowlistLineKind =
  | { kind: "top-level"; entry: KeyValue }
  | { kind: "scope-item"; rest: string }
  | { kind: "top-level-mask-item"; value: string }
  | { kind: "block-list-item"; key: BlockListKey; value: string }
  | { kind: "scope-key"; entry: KeyValue }
  | { kind: "invalid"; reason: string };

function invalidLine(line: ConfigLine, reason: string): AllowlistLineKind {
  return { kind: "invalid", reason: `line ${line.lineNumber}: ${reason}` };
}

/**
 * Classify one line from its indentation plus the current state. Keeping this
 * in one place is what makes the parser's shape (indent 0 keys, indent 2 scope
 * items, indent 4 scope keys, deeper block-list items) explicit.
 */
function classifyAllowlistLine(line: ConfigLine, state: AllowlistParseState): AllowlistLineKind {
  if (line.indent === 0) {
    const entry = splitKeyValue(line.text);
    if (entry === undefined) return invalidLine(line, "expected `key: value`");
    return { kind: "top-level", entry };
  }
  const sequenceItem = classifySequenceItem(line, state);
  if (sequenceItem !== undefined) return sequenceItem;
  if (state.current === undefined) {
    return invalidLine(line, "expected a `- ` scope entry at indent 2");
  }
  const entry = splitKeyValue(line.text);
  if (line.indent !== 4 || entry === undefined) {
    return invalidLine(line, "unsupported indentation; scope keys must be at indent 4");
  }
  return { kind: "scope-key", entry };
}

/** Classify a `- item` line; undefined when the line is not a list item. */
function classifySequenceItem(
  line: ConfigLine,
  state: AllowlistParseState,
): AllowlistLineKind | undefined {
  if (line.text !== "-" && !line.text.startsWith("- ")) return undefined;
  const value = parseScalar(line.text.slice(1));
  // `topLevelMaskBlock` is only set between `mask:` and the next indent-0 key,
  // and no scope can be open in that window, so accepting any indent ≥2 here
  // cannot reattribute a scope item.
  if (state.topLevelMaskBlock && line.indent >= 2) {
    return { kind: "top-level-mask-item", value };
  }
  if (line.indent === 2) return { kind: "scope-item", rest: line.text.slice(1).trim() };
  if (state.current === undefined) {
    return invalidLine(line, "expected a `- ` scope entry at indent 2");
  }
  if (state.blockListKey === undefined) {
    return invalidLine(
      line,
      "unexpected list item; only `profiles` and `mask` support a block list",
    );
  }
  // A per-scope block item must sit deeper than its scope entry (indent 2); an
  // indent-1 item is a typo, not a shorter indent, and accepting it would make
  // the documented indent contract a lie.
  if (line.indent < 3) {
    return invalidLine(
      line,
      "block-list items under `profiles` / `mask` must be indented at least 3 spaces",
    );
  }
  return { kind: "block-list-item", key: state.blockListKey, value };
}

/** Validate and push the pending scope; a no-op when there is none. */
function flushPendingScope(state: AllowlistParseState): ConfigResult<null> {
  const pending = state.current;
  state.current = undefined;
  state.blockListKey = undefined;
  if (pending === undefined) return ok(null);
  if (pending.worktree === undefined) return fail("scope entry is missing `worktree`");
  if (pending.profiles.length === 0) {
    return fail(`scope "${pending.worktree}" is missing \`profiles\``);
  }
  if (pending.defaultProfile !== undefined && !pending.profiles.includes(pending.defaultProfile)) {
    return fail(
      `scope "${pending.worktree}" default "${pending.defaultProfile}" is not one of its profiles`,
    );
  }
  state.scopes.push({
    worktree: pending.worktree,
    profiles: pending.profiles,
    defaultProfile: pending.defaultProfile,
    region: pending.region,
    mask: pending.mask,
  });
  return ok(null);
}

/** Apply a top-level \`key: value\` line (\`scopes\` / \`region\` / \`mask\`). */
function applyTopLevelEntry(
  state: AllowlistParseState,
  entry: KeyValue,
  line: ConfigLine,
): ConfigResult<null> {
  const flushed = flushPendingScope(state);
  if (!flushed.ok) return flushed;
  // Any indent-0 line ends a top-level `mask` block, so a later `scopes:`
  // sequence cannot be mistaken for more mask entries.
  state.topLevelMaskBlock = false;
  switch (entry.key) {
    case "scopes":
      if (entry.value !== "") {
        return fail(`line ${line.lineNumber}: \`scopes\` must be a block sequence`);
      }
      return ok(null);
    case "region":
      state.region = parseScalar(entry.value);
      return ok(null);
    case "mask":
      if (entry.value === "") {
        state.topLevelMaskBlock = true;
        return ok(null);
      }
      return applyMaskFlow(state.mask, entry.value, line, "`mask`");
    default:
      return fail(`line ${line.lineNumber}: unknown top-level key "${entry.key}"`);
  }
}

/** Apply a scope \`key: value\` line to the scope under construction. */
function applyScopeEntry(
  state: AllowlistParseState,
  text: string,
  line: ConfigLine,
): ConfigResult<null> {
  const current = state.current;
  if (current === undefined) {
    return fail(`line ${line.lineNumber}: expected a \`- \` scope entry at indent 2`);
  }
  const entry = splitKeyValue(text);
  if (entry === undefined) return fail(`line ${line.lineNumber}: expected \`key: value\``);
  state.blockListKey = entry.key === "profiles" || entry.key === "mask" ? entry.key : undefined;
  switch (entry.key) {
    case "worktree": {
      const value = parseScalar(entry.value);
      if (value === "") return fail(`line ${line.lineNumber}: \`worktree\` must not be empty`);
      current.worktree = value;
      return ok(null);
    }
    case "profiles":
      return applyProfilesEntry(current, entry.value, line);
    case "mask":
      return applyScopeMaskEntry(current, entry.value, line);
    case "default": {
      const name = validateProfileName(parseScalar(entry.value));
      if (!name.ok) return fail(`line ${line.lineNumber}: ${name.reason}`);
      current.defaultProfile = name.value;
      return ok(null);
    }
    case "region": {
      const value = parseScalar(entry.value);
      if (value === "") return fail(`line ${line.lineNumber}: \`region\` must not be empty`);
      current.region = value;
      return ok(null);
    }
    default:
      return fail(`line ${line.lineNumber}: unknown scope key "${entry.key}"`);
  }
}

/** Apply a scope \`mask\` value: flow list, or a header for a block list. */
function applyScopeMaskEntry(
  current: PendingScope,
  raw: string,
  line: ConfigLine,
): ConfigResult<null> {
  // An empty value is a block-list header; the items arrive through
  // `state.blockListKey` and `appendBlockListItem`.
  if (raw === "") return ok(null);
  return applyMaskFlow(current.mask, raw, line, "`mask`");
}

/** Apply a \`profiles\` value: flow list, or a header for a block list. */
function applyProfilesEntry(
  current: PendingScope,
  raw: string,
  line: ConfigLine,
): ConfigResult<null> {
  const flow = parseFlowSequence(raw);
  if (flow === undefined) {
    if (raw !== "") {
      return fail(
        `line ${line.lineNumber}: \`profiles\` must be a flow list ([a, b]) or a block list`,
      );
    }
    return ok(null);
  }
  for (const rawName of flow) {
    const name = validateProfileName(rawName);
    if (!name.ok) return fail(`line ${line.lineNumber}: ${name.reason}`);
    current.profiles.push(name.value);
  }
  return ok(null);
}

/** Apply one allowlist line, dispatching on its classified kind. */
function applyAllowlistLine(state: AllowlistParseState, line: ConfigLine): ConfigResult<null> {
  const classified = classifyAllowlistLine(line, state);
  switch (classified.kind) {
    case "invalid":
      return fail(classified.reason);
    case "top-level":
      return applyTopLevelEntry(state, classified.entry, line);
    case "scope-item": {
      const flushed = flushPendingScope(state);
      if (!flushed.ok) return flushed;
      state.current = { worktree: undefined, profiles: [], mask: [] };
      if (classified.rest === "") return ok(null);
      return applyScopeEntry(state, classified.rest, line);
    }
    case "top-level-mask-item":
      return appendMaskEntry(state.mask, classified.value, line);
    case "block-list-item":
      return appendBlockListItem(state, classified.key, classified.value, line);
    default:
      return applyScopeEntry(state, line.text, line);
  }
}

/** Push one validated block-list item onto the scope under construction. */
function appendBlockListItem(
  state: AllowlistParseState,
  key: BlockListKey,
  value: string,
  line: ConfigLine,
): ConfigResult<null> {
  const current = state.current;
  if (current === undefined) return fail(`line ${line.lineNumber}: no scope to add \`${key}\` to`);
  if (key === "mask") return appendMaskEntry(current.mask, value, line);
  const name = validateProfileName(value);
  if (!name.ok) return fail(`line ${line.lineNumber}: ${name.reason}`);
  current.profiles.push(name.value);
  return ok(null);
}

/**
 * Push one mask entry after checking only its *syntax*.
 *
 * Path-relationship and existence checks need the worktree, home, runtime
 * base, and a `realpath()`/`stat()`, so they live in {@link validateMaskEntry}
 * and run at plan time. Anything absolute is accepted here; anything that is
 * not absolute cannot be a mount target and is refused with the line number.
 */
function appendMaskEntry(target: string[], value: string, line: ConfigLine): ConfigResult<null> {
  const validated = validateMaskEntrySyntax(value);
  if (!validated.ok) return fail(`line ${line.lineNumber}: ${validated.reason}`);
  target.push(validated.value);
  return ok(null);
}

/** Apply a \`mask\` flow sequence to a target list. */
function applyMaskFlow(
  target: string[],
  raw: string,
  line: ConfigLine,
  label: string,
): ConfigResult<null> {
  const flow = parseFlowSequence(raw);
  if (flow === undefined) {
    return fail(`line ${line.lineNumber}: ${label} must be a flow list ([path, path])`);
  }
  for (const entry of flow) {
    const appended = appendMaskEntry(target, entry, line);
    if (!appended.ok) return appended;
  }
  return ok(null);
}

/** Absolute-path check for one `mask:` entry (context-free part). */
export function validateMaskEntrySyntax(entry: string): ConfigResult<string> {
  if (entry === "") return fail("mask entries must not be empty");
  if (!entry.startsWith("/")) {
    return fail(`mask entry "${entry}" must be an absolute path`);
  }
  if (entry === "/") return fail('mask entry "/" would hide the entire filesystem');
  return ok(entry);
}

/** Parse the operator allowlist. */
export function parseAllowlist(text: string): ConfigResult<AwsAllowlist> {
  const linesResult = structuralLines(text);
  if (!linesResult.ok) return linesResult;

  const state: AllowlistParseState = {
    scopes: [],
    region: undefined,
    mask: [],
    current: undefined,
    blockListKey: undefined,
    topLevelMaskBlock: false,
  };

  for (const line of linesResult.value) {
    const applied = applyAllowlistLine(state, line);
    if (!applied.ok) return applied;
  }

  const flushed = flushPendingScope(state);
  if (!flushed.ok) return flushed;
  if (state.scopes.length === 0) {
    return fail("allowlist defines no scopes; AWS access stays disabled");
  }
  return ok({ scopes: state.scopes, region: state.region, mask: state.mask });
}

/** Parse `<worktree>/.belayd/aws.yaml`. */
export function parseRepoConfig(text: string): ConfigResult<AwsRepoConfig> {
  const linesResult = structuralLines(text);
  if (!linesResult.ok) return linesResult;

  let profile: string | undefined;
  for (const line of linesResult.value) {
    const entry = splitKeyValue(line.text);
    if (line.indent !== 0 || entry === undefined) {
      return fail(`line ${line.lineNumber}: expected a single \`profile: <name>\` entry`);
    }
    if (entry.key !== "profile") {
      return fail(
        `line ${line.lineNumber}: unknown key "${entry.key}"; only \`profile\` is allowed`,
      );
    }
    if (profile !== undefined) {
      return fail(`line ${line.lineNumber}: duplicate \`profile\` entry`);
    }
    const name = validateProfileName(parseScalar(entry.value));
    if (!name.ok) return fail(`line ${line.lineNumber}: ${name.reason}`);
    profile = name.value;
  }
  if (profile === undefined) return fail("no `profile` entry");
  return ok({ profile });
}

/** Convert a worktree glob into an anchored regular expression. */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index++;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** True when the absolute worktree path matches an allowlist glob. */
export function worktreeMatchesGlob(pattern: string, worktreeRoot: string): boolean {
  const normalizedRoot = worktreeRoot.endsWith("/")
    ? worktreeRoot.replace(/\/+$/, "")
    : worktreeRoot;
  const normalizedPattern = pattern.endsWith("/") ? pattern.replace(/\/+$/, "") : pattern;
  return globToRegExp(normalizedPattern).test(normalizedRoot);
}

/** Find the allowlist entry covering a worktree (first match in file order). */
export function matchScope(
  allowlist: AwsAllowlist,
  worktreeRoot: string,
): ConfigResult<AwsScopeRule> {
  for (const rule of allowlist.scopes) {
    if (worktreeMatchesGlob(rule.worktree, worktreeRoot)) return ok(rule);
  }
  return fail(
    `worktree ${worktreeRoot} is not covered by any scope in the belayd AWS allowlist (${allowlist.scopes
      .map((rule) => rule.worktree)
      .join(", ")})`,
  );
}

/**
 * Resolve the profile an agent may use for a worktree.
 *
 * Fail closed and loud: a repo file naming a profile the scope does not grant
 * is refused with the granted list, and the operator's `default` is never
 * substituted (a repo must state its intent explicitly).
 */
export function resolveScope(options: {
  allowlist: AwsAllowlist;
  repo: AwsRepoConfig;
  worktreeRoot: string;
}): ConfigResult<ResolvedAwsScope> {
  const rule = matchScope(options.allowlist, options.worktreeRoot);
  if (!rule.ok) return rule;
  if (!rule.value.profiles.includes(options.repo.profile)) {
    return fail(
      `profile "${options.repo.profile}" is not permitted for worktree ${options.worktreeRoot} (allowed: ${rule.value.profiles.join(
        ", ",
      )})`,
    );
  }
  return ok({
    rule: rule.value,
    profile: options.repo.profile,
    region: rule.value.region ?? options.allowlist.region,
  });
}

/**
 * Merge mask lists in precedence order (top-level first, then per-scope),
 * dropping duplicates by the entry text as written.
 */
export function mergeMaskEntries(...lists: readonly (readonly string[])[]): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if (!merged.includes(entry)) merged.push(entry);
    }
  }
  return merged;
}

/**
 * What the filesystem says about one mask entry at plan time.
 *
 * `other` covers everything bwrap cannot mask cleanly: sockets, fifos, and
 * device nodes. `missing` is what a `realpath()` failure becomes, so a typo in
 * `mask:` refuses the whole scope instead of silently leaving the path
 * readable.
 */
export type MaskPathStat =
  | { kind: "directory" }
  | { kind: "file" }
  | { kind: "other"; description: string }
  | { kind: "missing" };

/** A mask entry resolved into the exact argv form it takes. */
export interface ResolvedMaskEntry {
  /** Entry exactly as the allowlist wrote it (for messages). */
  entry: string;
  /** `realpath()`-resolved path — what bwrap must be given (see below). */
  path: string;
  /** Directories become a tmpfs mount; regular files a `/dev/null` bind. */
  kind: "tmpfs" | "null-bind";
}

/** Context a mask entry is validated against. */
export interface MaskValidationContext {
  worktreeRoot: string;
  homeDir: string;
  runtimeBaseDir: string;
  scopeDir: string;
  /** Allowlist file, named in every refusal so a typo is findable. */
  allowlistPath: string;
}

/** Drop trailing slashes so path comparisons are stable. */
function normalizeMaskPath(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** True when `candidate` is `base` itself or lives underneath it. */
export function isPathWithin(candidate: string, base: string): boolean {
  const normalizedCandidate = normalizeMaskPath(candidate);
  const normalizedBase = normalizeMaskPath(base);
  if (normalizedBase === "/") return true;
  if (normalizedCandidate === normalizedBase) return true;
  return normalizedCandidate.startsWith(`${normalizedBase}/`);
}

/**
 * Validate one resolved mask entry and decide its argv form.
 *
 * Pure: the caller supplies the `realpath()` result and the filesystem kind,
 * so every refusal below is unit-testable without touching the disk. `path`
 * must already be resolved because bwrap cannot create a mount point through a
 * symlinked directory (`bwrap: Can't create file at …: No such file or
 * directory`, verified on bubblewrap 0.11.2).
 *
 * Refusing instead of ignoring is the whole point: a mask entry that does not
 * apply (bad path, wrong type) must never leave a certificate readable.
 */
export function validateMaskEntry(options: {
  entry: string;
  resolvedPath: string;
  stat: MaskPathStat;
  context: MaskValidationContext;
}): ConfigResult<ResolvedMaskEntry> {
  const { context } = options;
  const syntax = validateMaskEntrySyntax(options.entry);
  if (!syntax.ok) return fail(`${syntax.reason} (in ${context.allowlistPath})`);

  const resolvedPath = normalizeMaskPath(options.resolvedPath);
  const refuse = (detail: string): ConfigResult<ResolvedMaskEntry> =>
    fail(`mask entry "${options.entry}" ${detail} (in ${context.allowlistPath})`);

  // A path that failed `realpath()` cannot be masked, and this check must come
  // before the containment rules: with an unresolved entry the text as written
  // is all we have, so a dangling symlink whose literal path sits inside the
  // worktree would be blamed on the worktree instead of being reported as
  // missing. Only resolvable entries reach the rules below.
  const stat = options.stat;
  if (stat.kind === "missing") {
    return refuse(
      "does not exist or cannot be resolved; a mask typo would leave it readable, so the scope is refused — fix or remove the entry",
    );
  }

  if (resolvedPath === "/") return refuse("resolves to the filesystem root");
  if (resolvedPath === normalizeMaskPath(context.homeDir)) {
    return refuse("is the home directory itself");
  }
  if (isPathWithin(resolvedPath, context.scopeDir)) {
    return refuse(
      `is inside this scope's runtime dir ${context.scopeDir}, which holds the generated shim, config and socket; masking it would break the sandbox`,
    );
  }
  if (isPathWithin(resolvedPath, context.runtimeBaseDir)) {
    return refuse(
      `is inside the broker runtime base ${context.runtimeBaseDir}; masking it would hide this scope's own socket`,
    );
  }
  if (isPathWithin(resolvedPath, context.worktreeRoot)) {
    return refuse(
      `is inside the worktree ${context.worktreeRoot}; the operator allowlist, not the repo, decides what is hidden`,
    );
  }
  // The inverse direction matters just as much: a mask that *contains* a
  // protected path hides it wholesale. Masking the runtime base's parent would
  // take out the control socket and every scope socket; masking the worktree's
  // parent would hide the sandboxed spawn's own cwd. Both must fail at plan
  // time, not as a bwrap error (or a mysteriously broken session) later.
  if (isPathWithin(context.runtimeBaseDir, resolvedPath)) {
    return refuse(
      `hides the broker runtime base ${context.runtimeBaseDir}; masking it would disable the control socket and every scope socket, including this one`,
    );
  }
  if (isPathWithin(context.scopeDir, resolvedPath)) {
    return refuse(
      `hides this scope's runtime dir ${context.scopeDir}, which holds the generated shim, config and socket; masking it would break the sandbox`,
    );
  }
  if (isPathWithin(context.worktreeRoot, resolvedPath)) {
    return refuse(
      `hides the worktree ${context.worktreeRoot}; a sandboxed spawn would start in a hidden working directory`,
    );
  }
  if (isPathWithin(context.homeDir, resolvedPath)) {
    return refuse(
      `hides the home directory ${context.homeDir}; mask a specific path inside it instead`,
    );
  }

  switch (stat.kind) {
    case "other":
      return refuse(`is a ${stat.description}, which cannot be masked cleanly`);
    case "directory":
      return ok({ entry: options.entry, path: resolvedPath, kind: "tmpfs" });
    case "file":
      return ok({ entry: options.entry, path: resolvedPath, kind: "null-bind" });
  }
}
