/**
 * Validation for `bd` (beads) commands proxied by the `bd` tool.
 *
 * The process gate disables `bash` so the orchestrator cannot bypass the
 * phase-order restrictions with raw shell access. Task tracking still needs
 * the `bd` CLI, so the extension exposes a scoped `bd` tool. This module
 * keeps the tool restricted to a single, safe `bd` invocation.
 *
 * Commands are parsed into an argv array and executed without a shell, so
 * shell metacharacters (`;`, `|`, `&`, `<`, `>`, backticks, `$(...)`) are
 * inert literal arguments rather than injection vectors. Skipping the shell
 * is also what lets multiline notes/descriptions pass through intact: a real
 * newline inside a quoted argument stays a newline.
 */

import { parseArgv } from "./argv.js";

/**
 * Read-only `bd` subcommands that never mutate the beads database.
 *
 * Exported so read-only consumers (fleet status bead enrichment) and their
 * tests can assert that they only ever issue a read.
 */
export const BD_READ_SUBCOMMANDS: readonly string[] = [
  "blocked",
  "children",
  "comments",
  "list",
  "memories",
  "orphans",
  "prime",
  "query",
  "ready",
  // Reading one memory by key. `bd prime` injects the memory bodies but tells an
  // agent to `bd recall <key>` for the full content, so the proxy must allow it.
  "recall",
  "search",
  "show",
  "state",
  "version",
];

/** Task-management `bd` subcommands that are safe during a gated workflow. */
const BD_WRITE_SUBCOMMANDS: readonly string[] = [
  "assign",
  "comment",
  "create",
  "defer",
  "dep",
  "heartbeat",
  "label",
  "link",
  "note",
  "priority",
  "remember",
  "set-state",
  "tag",
  "undefer",
  "update",
];

/**
 * Subcommands the `bd` tool may execute. Everything else — notably `close`,
 * `delete`, `edit`, `sql`, and `admin` — is rejected so the orchestrator
 * cannot close tasks (the human closes on merge) or run arbitrary commands.
 */
export const BD_ALLOWED_SUBCOMMANDS: readonly string[] = [
  ...BD_READ_SUBCOMMANDS,
  ...BD_WRITE_SUBCOMMANDS,
].sort();

/** `bd gate <child>` invocations that only read (bd-152). */
export const BD_GATE_READ_SUBCOMMANDS: readonly string[] = ["list", "show"];

/**
 * One long bd flag plus its optional one-letter shorthand.
 *
 * Flags are described once and matched by {@link bdArgvHasFlag}, so the bd
 * option validation (bd-179) and the GitHub-primary append-only policy (bd-180)
 * cannot disagree about which spellings of a graph-owning flag exist.
 */
export interface BdFlagForm {
  readonly long: string;
  readonly short?: string;
}

/** Status mutation (`bd update -s/--status`). */
export const BD_STATUS_FLAG: BdFlagForm = { long: "--status", short: "-s" };
/** Assignment (`bd update -a/--assignee`). */
export const BD_ASSIGNEE_FLAG: BdFlagForm = { long: "--assignee", short: "-a" };
/** Ownership (`bd update --owner`). */
export const BD_OWNER_FLAG: BdFlagForm = { long: "--owner" };
/** Priority (`bd update -p/--priority`). */
export const BD_PRIORITY_FLAG: BdFlagForm = { long: "--priority", short: "-p" };
/** Reparenting (`bd update/create --parent`). */
export const BD_PARENT_FLAG: BdFlagForm = { long: "--parent" };
/** Lease claim (`bd update/create --claim`). */
export const BD_CLAIM_FLAG: BdFlagForm = { long: "--claim" };
/** Deferral (`bd update --defer`). */
export const BD_DEFER_FLAG: BdFlagForm = { long: "--defer" };
/** Label removal (`bd update --remove-label`). */
export const BD_REMOVE_LABEL_FLAG: BdFlagForm = { long: "--remove-label" };
/** Whole-label replacement (`bd update --set-labels`). */
export const BD_SET_LABELS_FLAG: BdFlagForm = { long: "--set-labels" };

function matchesFlagForm(token: string, form: BdFlagForm): boolean {
  if (token === form.long || token.startsWith(`${form.long}=`)) return true;
  const short = form.short;
  if (short === undefined) return false;
  if (token === short || token.startsWith(`${short}=`)) return true;
  // pflag accepts an attached shorthand value (`-sclosed`). A long flag starts
  // with `--`, so it can never be mistaken for the one-letter form.
  return !token.startsWith("--") && token.startsWith(short) && token.length > short.length;
}

/**
 * Does argv carry a flag, in any spelling bd accepts?
 *
 * Long (`--status`, `--status=closed`), separate (`-s closed`), equals
 * (`-s=closed`), and attached (`-sclosed`) shorthand values all match. Matching
 * is intentionally broader than bd's grammar for invalid tokens: a token that
 * merely looks like the shorthand is refused rather than assumed harmless.
 */
export function bdArgvHasFlag(argv: readonly string[], form: BdFlagForm): boolean {
  return argv.some((token) => matchesFlagForm(token, form));
}

/** Whether `bd <subcommand>` is on the read-only list. */
export function isBdReadSubcommand(subcommand: string): boolean {
  return BD_READ_SUBCOMMANDS.includes(subcommand);
}

/**
 * Whether an argv only reads beads, including the `bd gate <child>` reads.
 *
 * `gate` is deliberately absent from {@link BD_ALLOWED_SUBCOMMANDS}: argv
 * validation inspects only `argv[0]`, so allowing `gate` through the `bd` proxy
 * would expose `gate create`/`gate resolve` too. The harness still needs to READ
 * gates (the human-answer poll), so the read-only predicate is widened here
 * instead — the writers go through a direct `runBdCommand` call.
 *
 * The child is the first positional token after the subcommand, skipping
 * `--actor <value>` because the actor is injected at index 1.
 */
export function isBdReadArgv(argv: readonly string[]): boolean {
  const subcommand = argv[0] ?? "";
  if (isBdReadSubcommand(subcommand)) return true;
  if (subcommand !== "gate") return false;
  return BD_GATE_READ_SUBCOMMANDS.includes(gateChildArgv(argv));
}

/** First positional token after `bd gate`, skipping flags and their values. */
function gateChildArgv(argv: readonly string[]): string {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === "--actor") {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return "";
}

/**
 * argv for one batched read-only bead lookup: `bd show <id>... --json`.
 *
 * `show` is on {@link BD_READ_SUBCOMMANDS}; batching keeps a whole fleet view to
 * a single subprocess, and `show` tolerates ids it cannot find (it returns the
 * records it did find), so one purged bead does not hide its siblings. Callers
 * must filter the ids first (`fleetBeadTaskIds` does): a value starting with `-`
 * would otherwise be read by bd as a flag.
 */
export function buildBeadShowArgv(taskIds: readonly string[]): readonly string[] {
  return ["show", ...taskIds, "--json"];
}

/** `bd` flags that make the process read a note/description/body from stdin. */
const BD_STDIN_FLAGS: readonly string[] = ["--stdin"];

/** Flags whose `-` value means "read from stdin". */
const BD_STDIN_FILE_FLAGS: readonly string[] = ["--file", "--body-file"];

/** Outcome of parsing a raw command string into process arguments. */
export type BdCommandParse = { ok: true; argv: readonly string[] } | { ok: false; error: string };

/** Outcome of validating a `bd` command string. */
export type BdCommandValidation =
  | { ok: true; subcommand: string; argv: readonly string[] }
  | { ok: false; error: string };

/**
 * Split a command string into argv without invoking a shell.
 *
 * The tokenizer lives in `argv.ts` because `/belayd` needs exactly the same
 * quoting rules; this wrapper only maps the parse failure onto the bd error
 * shape. POSIX quoting is honored but no expansion happens: `$`, backticks,
 * and other metacharacters are plain characters, and whitespace inside quotes
 * (including newlines) is preserved.
 */
export function parseBdCommand(command: string): BdCommandParse {
  const parsed = parseArgv(command);
  if (!parsed.ok) {
    const name = parsed.quote === "'" ? "single" : "double";
    return { ok: false, error: `Unterminated ${name} quote in bd command.` };
  }
  return { ok: true, argv: parsed.argv };
}

/**
 * Validate a `bd` command string before it is passed to the process spawner.
 *
 * Rejects unknown subcommands, NUL bytes, and beads hierarchy/lifecycle
 * mutations. Shell metacharacters are intentionally allowed: without a shell
 * they cannot chain commands, and content fields legitimately contain
 * markdown (`|`, backticks, `<`, `>`).
 */
export function validateBdCommand(command: string): BdCommandValidation {
  if (command.trim() === "") {
    return { ok: false, error: "Empty bd command." };
  }

  if (command.includes("\u0000")) {
    return { ok: false, error: "bd command must not contain NUL bytes." };
  }

  const parsed = parseBdCommand(command);
  if (!parsed.ok) return parsed;

  const { argv } = parsed;
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === "") {
    return { ok: false, error: "Missing bd subcommand." };
  }

  if (!BD_ALLOWED_SUBCOMMANDS.includes(subcommand)) {
    return {
      ok: false,
      error: `bd subcommand "${subcommand}" is not allowed. Allowed: ${BD_ALLOWED_SUBCOMMANDS.join(", ")}`,
    };
  }

  // Beads hierarchy mutations must not be reachable through the bd tool:
  // parent-child links need `bd dep`/`bd link` instead, and task lifecycle
  // (status/claim) stays with the human via `wt merge`.
  if (bdArgvHasFlag(argv, BD_PARENT_FLAG)) {
    return {
      ok: false,
      error:
        "Creating child beads (--parent) is not allowed. Use top-level beads + bd dep instead.",
    };
  }
  if (argv.some((token) => token === "parent-child" || token === "--type=parent-child")) {
    return {
      ok: false,
      error: "parent-child links are not allowed. Use bd dep / bd link (blocks|related) instead.",
    };
  }
  if (subcommand === "create" || subcommand === "update") {
    if (bdArgvHasFlag(argv, BD_STATUS_FLAG)) {
      return {
        ok: false,
        error: "bd <sub> --status is not allowed through the bd tool. Leave beads open/backlog.",
      };
    }
    if (bdArgvHasFlag(argv, BD_CLAIM_FLAG)) {
      // Load-bearing for assignment (bd-150): a claim takes a lease on the bead,
      // and every later `bd update --assignee`/`bd assign` refuses while a lease
      // is live. The harness instead mirrors the driving actor as the assignee
      // with a CAS-guarded `--if-assignee` write (see src/beads-actor.ts), which
      // only works because no harness code path ever takes a claim.
      return {
        ok: false,
        error: "bd <sub> --claim is not allowed through the bd tool.",
      };
    }
  }

  return { ok: true, subcommand, argv };
}

/**
 * Whether the parsed argv already tells `bd` to read content from stdin.
 *
 * The `bd` tool refuses a `stdin` payload when no such flag is present,
 * because `bd` would ignore stdin and the note/description would be silently
 * lost.
 */
export function bdCommandReadsStdin(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (BD_STDIN_FLAGS.includes(token)) return true;
    if (token === "--file=-" || token === "--body-file=-") return true;
    if (BD_STDIN_FILE_FLAGS.includes(token) && argv[i + 1] === "-") return true;
  }
  return false;
}
