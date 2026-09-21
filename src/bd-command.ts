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

function isBdWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isBdQuote(char: string): char is "'" | '"' {
  return char === "'" || char === '"';
}

/**
 * A run of characters read at one parser position: its decoded value, the
 * index to resume at, and — for quoted runs — the quote that never closed.
 */
type BdSegment = { value: string; nextIndex: number; unclosedQuote: "'" | '"' | null };

/**
 * Read a single- or double-quoted run starting at `start` (the opening quote).
 *
 * Single quotes are fully literal. In double quotes a backslash only escapes
 * `"` and `\`; anything else (including `\n`) stays literal, matching shell
 * semantics and keeping written markdown intact.
 */
function readBdQuoted(command: string, start: number, quote: "'" | '"'): BdSegment {
  let value = "";
  let i = start + 1;

  while (i < command.length) {
    const char = command[i] ?? "";
    if (char === quote) return { value, nextIndex: i + 1, unclosedQuote: null };

    if (quote === '"' && char === "\\") {
      const next = command[i + 1];
      if (next === '"' || next === "\\") {
        value += next;
        i += 2;
        continue;
      }
    }

    value += char;
    i += 1;
  }

  return { value, nextIndex: i, unclosedQuote: quote };
}

/** Read an unquoted run until whitespace or a quote, honoring backslash escapes. */
function readBdUnquoted(command: string, start: number): BdSegment {
  let value = "";
  let i = start;

  while (i < command.length) {
    const char = command[i] ?? "";
    if (isBdWhitespace(char) || isBdQuote(char)) break;

    if (char === "\\") {
      const next = command[i + 1];
      if (next === undefined) {
        value += char;
        i += 1;
        continue;
      }
      value += next;
      i += 2;
      continue;
    }

    value += char;
    i += 1;
  }

  return { value, nextIndex: i, unclosedQuote: null };
}

/** Read the segment starting at `start`, dispatching on quote vs. bare text. */
function readBdSegment(command: string, start: number): BdSegment {
  const char = command[start] ?? "";
  return isBdQuote(char) ? readBdQuoted(command, start, char) : readBdUnquoted(command, start);
}

function unterminatedQuoteError(kind: "'" | '"'): BdCommandParse {
  const name = kind === "'" ? "single" : "double";
  return { ok: false, error: `Unterminated ${name} quote in bd command.` };
}

/**
 * Split a command string into argv without invoking a shell.
 *
 * POSIX quoting is honored (`'...'`, `"..."`, backslash escapes) but no
 * expansion happens: `$`, backticks, and other metacharacters are plain
 * characters. Whitespace inside quotes — including newlines — is preserved.
 * An unterminated quote is reported instead of silently swallowed.
 */
export function parseBdCommand(command: string): BdCommandParse {
  const argv: string[] = [];
  let current: string | null = null;
  let i = 0;

  while (i < command.length) {
    const char = command[i] ?? "";

    if (isBdWhitespace(char)) {
      if (current !== null) argv.push(current);
      current = null;
      i += 1;
      continue;
    }

    const segment = readBdSegment(command, i);
    if (segment.unclosedQuote !== null) return unterminatedQuoteError(segment.unclosedQuote);

    current = (current ?? "") + segment.value;
    i = segment.nextIndex;
  }

  if (current !== null) argv.push(current);
  return { ok: true, argv };
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
