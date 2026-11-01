/**
 * GitHub issue comments: the human answer channel for GitHub-primary repos
 * (bd-182).
 *
 * The bd-152 channel already turns the first non-`belayd:` comment on a bead
 * into a real user turn. Under `authority: "github"` the same question must land
 * on the **issue** (never the PR), and the answer must be read from there. The
 * shape is unchanged: the bd `human` gate is the durable wait, the question is an
 * authored comment, the first qualifying comment at/after the gate's `createdAt`
 * is the answer.
 *
 * Two properties are load-bearing:
 *
 * 1. **Identity filter.** The harness comments as its GitHub App bot, so the
 *    question it posted would otherwise be read back as its own answer. A human
 *    comment is any comment whose author is not a bot login and not in the
 *    harness allowlist.
 * 2. **Read-only guard.** The argv builder is separated from the spawn, and the
 *    guard inspects the argv that will actually run, mirroring `isBdReadArgv`.
 *
 * Everything degrades to `{ ok: false }`: `gh` may be absent, unauthenticated, or
 * pointed elsewhere, and none of that may settle a wait or break a workflow.
 */

/** One issue comment, as `gh api …/issues/{n}/comments` answers it. */
export interface GithubIssueComment {
  id: string;
  /** `user.login`. */
  author: string;
  /** `user.type`, or `""` when GitHub omitted it. */
  authorType: string;
  /** `created_at`, second granularity. */
  createdAt: string;
  /** `body`. */
  text: string;
}

/**
 * Longest one comment read may take before it degrades to "no answer known".
 * Same bound as the bead thread read: this runs off a 30 s poll, so a hung `gh`
 * must not accumulate.
 */
export const GH_COMMAND_TIMEOUT_MS = 15_000;

/** Cap on `gh` stdout for one read. A comment thread is never unbounded input. */
export const GH_COMMAND_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Injected `gh` runner.
 *
 * Declared here rather than imported from a fleet module: a type-only import of
 * `src/fleet-*.ts` at a capability entry is a boundary violation (bd-179).
 */
export type GhRunner = (
  argv: readonly string[],
  options: {
    cwd: string;
    stdin: string | undefined;
    timeoutInMs: number;
    maxBufferInBytes: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

/** Owner/repo/number + the cursor for one read. */
export interface IssueCommentsTarget {
  owner: string;
  repo: string;
  number: number;
  since: string;
}

/** A builder refusal or the argv to spawn; never a malformed argv. */
export type GhArgvBuild = { ok: true; argv: readonly string[] } | { ok: false; error: string };

/** GitHub names are path segments, so only the ordinary segment alphabet is safe. */
const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

/** Validate the owner/repo/number/since quad before it reaches an API path. */
function validateTarget(target: IssueCommentsTarget): { ok: true } | { ok: false; error: string } {
  for (const [label, value] of [
    ["owner", target.owner],
    ["repo", target.repo],
  ] as const) {
    // A leading `-` would be read as a flag by anything downstream, so it is
    // refused even though the segment alphabet would otherwise allow it.
    if (!GITHUB_NAME.test(value) || value.startsWith("-")) {
      return { ok: false, error: `refusing GitHub ${label} "${value}"` };
    }
  }
  if (!Number.isSafeInteger(target.number) || target.number <= 0) {
    return {
      ok: false,
      error: `refusing GitHub issue number "${String(target.number)}"`,
    };
  }
  if (!Number.isFinite(Date.parse(target.since))) {
    return { ok: false, error: `refusing GitHub comment cursor "${target.since}"` };
  }
  return { ok: true };
}

/**
 * `gh api --paginate --slurp repos/{owner}/{repo}/issues/{n}/comments?since=…`.
 *
 * `since` is a query parameter, not a `gh` flag, and `--slurp` is required so
 * every page stays inside one JSON document the caller can parse.
 */
export function buildIssueCommentsArgv(target: IssueCommentsTarget): GhArgvBuild {
  const valid = validateTarget(target);
  if (!valid.ok) return valid;
  return {
    ok: true,
    argv: [
      "api",
      "--paginate",
      "--slurp",
      `repos/${target.owner}/${target.repo}/issues/${target.number.toString()}/comments?since=${encodeURIComponent(target.since)}`,
    ],
  };
}

/** `gh api --method POST repos/{owner}/{repo}/issues/{n}/comments --input -`. */
export function buildIssueCommentCreateArgv(
  target: Pick<IssueCommentsTarget, "owner" | "repo" | "number">,
): GhArgvBuild {
  const valid = validateTarget({ ...target, since: new Date(0).toISOString() });
  if (!valid.ok) return valid;
  return {
    ok: true,
    argv: [
      "api",
      "--method",
      "POST",
      `repos/${target.owner}/${target.repo}/issues/${target.number.toString()}/comments`,
      "--input",
      "-",
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten `gh --slurp` output: an array of page arrays, a plain array, or one
 * object. One level is enough because that is exactly what `--slurp` produces.
 */
function flattenRecords(raw: unknown): unknown[] {
  const pages = Array.isArray(raw) ? raw : [raw];
  const records: unknown[] = [];
  for (const page of pages) {
    if (Array.isArray(page)) records.push(...page);
    else records.push(page);
  }
  return records;
}

function recordId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}

/** Comments plus the records the parser could not use, so a gap is diagnosable. */
export interface ParsedIssueComments {
  comments: GithubIssueComment[];
  /** Records that lacked a usable id/body/created_at/user.login (schema drift, not an empty thread). */
  dropped: number;
}

/**
 * Tolerant parse of the issue-comment payload.
 *
 * A record missing the fields the answer channel needs is dropped, not fatal:
 * one malformed comment must not hide the human's answer, and this never throws
 * because it runs inside a poll that may not surface an exception. The dropped
 * count is returned so a null/deleted `user` cannot look like "no answer yet".
 */
export function parseIssueCommentsWithDropped(raw: unknown): ParsedIssueComments {
  const comments: GithubIssueComment[] = [];
  let dropped = 0;
  for (const record of flattenRecords(raw)) {
    if (!isRecord(record)) {
      dropped += 1;
      continue;
    }
    const id = recordId(record.id);
    const user = record.user;
    if (
      id === undefined ||
      typeof record.body !== "string" ||
      typeof record.created_at !== "string" ||
      !isRecord(user) ||
      typeof user.login !== "string"
    ) {
      dropped += 1;
      continue;
    }
    comments.push({
      id,
      author: user.login,
      authorType: typeof user.type === "string" ? user.type : "",
      createdAt: record.created_at,
      text: record.body,
    });
  }
  return { comments, dropped };
}

/** The usable comments; display paths that need the gap use the WithDropped form. */
export function parseIssueComments(raw: unknown): GithubIssueComment[] {
  return parseIssueCommentsWithDropped(raw).comments;
}

/**
 * Parse `BELAYD_GITHUB_BOT_LOGINS` (comma/whitespace separated).
 *
 * Read at the call site and passed in: this module holds no state, so a test can
 * pin the parse without touching the process environment.
 */
export function harnessGithubLogins(source: string | undefined): string[] {
  if (source === undefined) return [];
  const logins: string[] = [];
  const seen = new Set<string>();
  for (const part of source.split(/[,\s]+/u)) {
    const login = part.trim().toLowerCase();
    if (login === "" || seen.has(login)) continue;
    seen.add(login);
    logins.push(login);
  }
  return logins;
}

/**
 * Whether a comment came from a human rather than the harness bot.
 *
 * This is a defence in depth, not the primary guarantee (bd-182 review C2): the
 * harness comments as a GitHub App, so `user.type` is `Bot` or the login ends in
 * `[bot]`, and the allowlist catches a bot whose metadata does not say so. Login
 * matching is case-insensitive on purpose, so a `[BOT]`/`Belayd-Bot` spelling
 * cannot bypass it. The definitive exclusion is the posted comment's id, which
 * `selectHumanAnswer` drops even when gh authenticates as a human account.
 */
export function isHumanIssueComment(
  comment: GithubIssueComment,
  allowlist: readonly string[],
): boolean {
  if (comment.authorType.toLowerCase() === "bot") return false;
  const login = comment.author.toLowerCase();
  if (login.endsWith("[bot]")) return false;
  return !allowlist.some((entry) => entry.trim().toLowerCase() === login);
}

function compareIds(a: string, b: string): number {
  // GitHub ids are numeric; `"100" < "9"` lexically would order same-second
  // comments wrong. Fall back to lexical only for non-numeric ids.
  if (/^\d+$/u.test(a) && /^\d+$/u.test(b)) {
    const numericA = Number(a);
    const numericB = Number(b);
    if (Number.isSafeInteger(numericA) && Number.isSafeInteger(numericB) && numericA !== numericB) {
      return numericA - numericB;
    }
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareComments(a: GithubIssueComment, b: GithubIssueComment): number {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid && aTime !== bTime) return aTime - bTime;
  // An unparseable timestamp cannot be the first answer, but it must still sort
  // deterministically so page order cannot change which comment is "first".
  if (aValid !== bValid) return aValid ? -1 : 1;
  return compareIds(a.id, b.id);
}

/**
 * The first human comment at/after the cursor, or undefined.
 *
 * The gate's own `createdAt` is the cursor (second granularity, hence `>=`), so
 * no comment id has to be persisted: a restart re-arms from the open gate and
 * still sees an answer posted before the restart.
 */
export function selectHumanAnswer(
  comments: readonly GithubIssueComment[],
  options: {
    sinceMs: number;
    allowlist: readonly string[];
    /** The harness's own posted question: never an answer, whoever authored it. */
    excludeId?: string;
  },
): GithubIssueComment | undefined {
  const ordered = [...comments].sort(compareComments);
  return ordered.find((comment) => {
    if (options.excludeId !== undefined && comment.id === options.excludeId) return false;
    const createdAt = Date.parse(comment.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < options.sinceMs) return false;
    return isHumanIssueComment(comment, options.allowlist);
  });
}

/** Flags that would turn an `api` call into a write. */
const MUTATING_VALUE_FLAGS = new Set(["--method", "-X"]);
const MUTATING_FLAGS = new Set(["--input", "-f", "--raw-field", "-F", "--field"]);

function isMutatingFlag(token: string): boolean {
  const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  if (MUTATING_FLAGS.has(flag)) return true;
  // Attached short spellings: `-fbody=…`, `-Ffield=…`.
  return (token.startsWith("-f") || token.startsWith("-F")) && token.length > 2;
}

/** True for a `--method=…`/`-X…` spelling that names anything but GET. */
function isNonGetMethodSpelling(token: string): boolean {
  if (token.startsWith("--method=")) {
    return token.slice("--method=".length).toUpperCase() !== "GET";
  }
  if (token.startsWith("-X") && token.length > 2) {
    return token.slice(2).toUpperCase() !== "GET";
  }
  return false;
}

/**
 * True only for a read-only `gh api` call.
 *
 * The guard runs against the argv that will execute, so an injected or regressed
 * builder cannot turn the answer poll into a writer.
 */
export function isGhReadArgv(argv: readonly string[]): boolean {
  if (argv[0] !== "api") return false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (MUTATING_VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.toUpperCase() !== "GET") return false;
      index += 1;
      continue;
    }
    if (isNonGetMethodSpelling(token) || isMutatingFlag(token)) return false;
  }
  return true;
}

/** Outcome of one issue-comment read. */
export type IssueCommentsLookup =
  | { ok: true; comments: GithubIssueComment[]; dropped: number }
  | { ok: false; error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one read-only issue-comment lookup.
 *
 * `gh` absent (ENOENT), unauthenticated, non-zero exit, non-JSON stdout, or a
 * bad owner/repo/number/since are all `{ ok: false }`: a failure is never read as
 * "no answer yet", it is read as "unknown", which leaves the wait armed.
 */
export async function lookupIssueComments(options: {
  repo: { owner: string; repo: string };
  number: number;
  since: string;
  cwd: string;
  runGh: GhRunner;
}): Promise<IssueCommentsLookup> {
  const built = buildIssueCommentsArgv({
    owner: options.repo.owner,
    repo: options.repo.repo,
    number: options.number,
    since: options.since,
  });
  if (!built.ok) return built;
  if (!isGhReadArgv(built.argv)) {
    return { ok: false, error: `refusing non-read gh argv "${built.argv.join(" ")}"` };
  }
  try {
    const { stdout } = await options.runGh(built.argv, {
      cwd: options.cwd,
      stdin: undefined,
      timeoutInMs: GH_COMMAND_TIMEOUT_MS,
      maxBufferInBytes: GH_COMMAND_MAX_BUFFER_BYTES,
    });
    const parsed: unknown = JSON.parse(stdout);
    return { ok: true, ...parseIssueCommentsWithDropped(parsed) };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** `gh api user`: a read that names the authenticated account, never a shell. */
export function buildAuthenticatedUserArgv(): readonly string[] {
  return ["api", "user"];
}

/** The login `gh` actually authenticates as, or a refusal. */
export type AuthenticatedLoginLookup = { ok: true; login: string } | { ok: false; error: string };

/**
 * Read the login `gh` currently authenticates as.
 *
 * This is the secondary identity check (bd-182 review C2): the harness's own
 * posted comment id is the primary guarantee, and this catches a question posted
 * by a bot account whose metadata does not identify it as one. A failed read is
 * not permission to accept any author; the caller decides how to fail closed,
 * and the caller owns the cadence: `human-gate.ts` calls this on every claim
 * until it succeeds, then caches that success for the life of one wait.
 */
export async function lookupAuthenticatedLogin(options: {
  cwd: string;
  runGh: GhRunner;
}): Promise<AuthenticatedLoginLookup> {
  const argv = buildAuthenticatedUserArgv();
  if (!isGhReadArgv(argv)) {
    return { ok: false, error: `refusing non-read gh argv "${argv.join(" ")}"` };
  }
  try {
    const { stdout } = await options.runGh(argv, {
      cwd: options.cwd,
      stdin: undefined,
      timeoutInMs: GH_COMMAND_TIMEOUT_MS,
      maxBufferInBytes: GH_COMMAND_MAX_BUFFER_BYTES,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed) || typeof parsed.login !== "string" || parsed.login === "") {
      return { ok: false, error: "gh api user returned no login" };
    }
    return { ok: true, login: parsed.login };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/**
 * Post the question (or a review's findings) as an issue comment.
 *
 * The body goes on stdin as `{"body": …}` JSON, so a long markdown question
 * never appears in argv and never hits its length limit.
 */
export async function postIssueComment(options: {
  repo: { owner: string; repo: string };
  number: number;
  body: string;
  cwd: string;
  runGh: GhRunner;
}): Promise<{ ok: true; commentId?: string } | { ok: false; error: string }> {
  const built = buildIssueCommentCreateArgv({
    owner: options.repo.owner,
    repo: options.repo.repo,
    number: options.number,
  });
  if (!built.ok) return built;
  try {
    const { stdout } = await options.runGh(built.argv, {
      cwd: options.cwd,
      stdin: JSON.stringify({ body: options.body }),
      timeoutInMs: GH_COMMAND_TIMEOUT_MS,
      maxBufferInBytes: GH_COMMAND_MAX_BUFFER_BYTES,
    });
    // The created id is what lets the poll exclude the harness's own question
    // even when gh authenticates as a human account. A response without one is
    // not a failed post; the identity check still has to carry the wait.
    const commentId = createdCommentId(stdout);
    return commentId === undefined ? { ok: true } : { ok: true, commentId };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** The created comment's id from the POST response, when it carries one. */
function createdCommentId(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) ? recordId(parsed.id) : undefined;
  } catch {
    return undefined;
  }
}
