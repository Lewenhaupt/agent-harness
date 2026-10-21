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
}

/** Parsed operator allowlist. */
export interface AwsAllowlist {
  scopes: readonly AwsScopeRule[];
  region?: string;
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
}

/** Mutable parse state, threaded through the line handlers below. */
interface AllowlistParseState {
  scopes: AwsScopeRule[];
  region: string | undefined;
  current: PendingScope | undefined;
  expectingProfilesBlock: boolean;
}

type AllowlistLineKind =
  | { kind: "top-level"; entry: KeyValue }
  | { kind: "scope-item"; rest: string }
  | { kind: "profiles-list-item"; value: string }
  | { kind: "scope-key"; entry: KeyValue }
  | { kind: "invalid"; reason: string };

function invalidLine(line: ConfigLine, reason: string): AllowlistLineKind {
  return { kind: "invalid", reason: `line ${line.lineNumber}: ${reason}` };
}

/**
 * Classify one line from its indentation plus the current state. Keeping this
 * in one place is what makes the parser's shape (indent 0 keys, indent 2 scope
 * items, indent 4 scope keys, indent 6 profile list items) explicit.
 */
function classifyAllowlistLine(line: ConfigLine, state: AllowlistParseState): AllowlistLineKind {
  const isSequenceItem = line.text === "-" || line.text.startsWith("- ");
  const entry = isSequenceItem ? undefined : splitKeyValue(line.text);

  if (line.indent === 0) {
    if (entry === undefined) return invalidLine(line, "expected `key: value`");
    return { kind: "top-level", entry };
  }
  if (isSequenceItem && line.indent === 2) {
    return { kind: "scope-item", rest: line.text.slice(1).trim() };
  }
  if (state.current === undefined) {
    return invalidLine(line, "expected a `- ` scope entry at indent 2");
  }
  if (isSequenceItem) {
    if (!state.expectingProfilesBlock) {
      return invalidLine(line, "unexpected list item; only `profiles` supports a block list");
    }
    return { kind: "profiles-list-item", value: parseScalar(line.text.slice(1)) };
  }
  if (line.indent !== 4 || entry === undefined) {
    return invalidLine(line, "unsupported indentation; scope keys must be at indent 4");
  }
  return { kind: "scope-key", entry };
}

/** Validate and push the pending scope; a no-op when there is none. */
function flushPendingScope(state: AllowlistParseState): ConfigResult<null> {
  const pending = state.current;
  state.current = undefined;
  state.expectingProfilesBlock = false;
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
  });
  return ok(null);
}

/** Apply a top-level \`key: value\` line (\`scopes\` / \`region\`). */
function applyTopLevelEntry(
  state: AllowlistParseState,
  entry: KeyValue,
  line: ConfigLine,
): ConfigResult<null> {
  const flushed = flushPendingScope(state);
  if (!flushed.ok) return flushed;
  switch (entry.key) {
    case "scopes":
      if (entry.value !== "") {
        return fail(`line ${line.lineNumber}: \`scopes\` must be a block sequence`);
      }
      return ok(null);
    case "region":
      state.region = parseScalar(entry.value);
      return ok(null);
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
  state.expectingProfilesBlock = entry.key === "profiles";
  switch (entry.key) {
    case "worktree": {
      const value = parseScalar(entry.value);
      if (value === "") return fail(`line ${line.lineNumber}: \`worktree\` must not be empty`);
      current.worktree = value;
      return ok(null);
    }
    case "profiles":
      return applyProfilesEntry(current, entry.value, line);
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
      state.current = { worktree: undefined, profiles: [] };
      if (classified.rest === "") return ok(null);
      return applyScopeEntry(state, classified.rest, line);
    }
    case "profiles-list-item":
      return appendProfile(state, classified.value, line);
    default:
      return applyScopeEntry(state, line.text, line);
  }
}

/** Push one validated profile onto the scope under construction. */
function appendProfile(
  state: AllowlistParseState,
  value: string,
  line: ConfigLine,
): ConfigResult<null> {
  const name = validateProfileName(value);
  if (!name.ok) return fail(`line ${line.lineNumber}: ${name.reason}`);
  const current = state.current;
  if (current === undefined) {
    return fail(`line ${line.lineNumber}: no scope to add a profile to`);
  }
  current.profiles.push(name.value);
  return ok(null);
}

/** Parse the operator allowlist. */
export function parseAllowlist(text: string): ConfigResult<AwsAllowlist> {
  const linesResult = structuralLines(text);
  if (!linesResult.ok) return linesResult;

  const state: AllowlistParseState = {
    scopes: [],
    region: undefined,
    current: undefined,
    expectingProfilesBlock: false,
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
  return ok({ scopes: state.scopes, region: state.region });
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
