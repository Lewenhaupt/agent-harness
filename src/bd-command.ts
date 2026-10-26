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

/** Whether `bd <subcommand>` is on the read-only list. */
export function isBdReadSubcommand(subcommand: string): boolean {
  return BD_READ_SUBCOMMANDS.includes(subcommand);
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
  if (argv.some((token) => token === "--parent" || token.startsWith("--parent="))) {
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
    if (argv.some((token) => token === "--status" || token.startsWith("--status="))) {
      return {
        ok: false,
        error: "bd <sub> --status is not allowed through the bd tool. Leave beads open/backlog.",
      };
    }
    if (argv.some((token) => token === "--claim")) {
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
