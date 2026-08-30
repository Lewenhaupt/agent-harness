/**
 * Validation for `bd` (beads) commands proxied by the `bd` tool.
 *
 * The process gate disables `bash` so the orchestrator cannot bypass the
 * phase-order restrictions with raw shell access. Task tracking still needs
 * the `bd` CLI, so the extension exposes a scoped `bd` tool. This module
 * keeps the tool restricted to a single, safe `bd` invocation.
 */

/** Read-only `bd` subcommands that never mutate the beads database. */
const BD_READ_SUBCOMMANDS: readonly string[] = [
  "blocked",
  "children",
  "comments",
  "list",
  "memories",
  "orphans",
  "prime",
  "query",
  "ready",
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

/** Outcome of validating a `bd` command string. */
export type BdCommandValidation = { ok: true; subcommand: string } | { ok: false; error: string };

/**
 * Validate a `bd` command string before it is passed to `exec`.
 *
 * Rejects unknown subcommands and shell metacharacters. The metacharacter
 * guard matters because the string is run through `/bin/sh -c`; without it an
 * agent could chain a second command onto the `bd` invocation.
 */
export function validateBdCommand(command: string): BdCommandValidation {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty bd command." };
  }

  const subcommand = trimmed.split(/\s+/)[0] ?? "";
  if (!subcommand) {
    return { ok: false, error: "Missing bd subcommand." };
  }

  if (!BD_ALLOWED_SUBCOMMANDS.includes(subcommand)) {
    return {
      ok: false,
      error: `bd subcommand "${subcommand}" is not allowed. Allowed: ${BD_ALLOWED_SUBCOMMANDS.join(", ")}`,
    };
  }

  // Command chaining/substitution/redirection and parameter expansion are the
  // injection vectors when a string is executed by a shell.
  if (/[\r\n;|&<>`]|\$\(|\$\{/.test(trimmed)) {
    return {
      ok: false,
      error:
        "bd command must not contain shell metacharacters (;, |, &, <, >, backtick, newline, or command/parameter substitution).",
    };
  }

  return { ok: true, subcommand };
}
