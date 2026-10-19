/**
 * Minimal POSIX-ish argv tokenizer, shared by the `bd` tool and `/belayd`
 * argument parsing.
 *
 * Both call sites need the same guarantees without a shell: quoted runs stay a
 * single token (including real newlines and markdown metacharacters), backslash
 * escapes are honored, and an unterminated quote is reported instead of being
 * silently swallowed. Keeping one implementation means `/belayd --handoff "..."`
 * and `bd note "..."` cannot drift apart.
 *
 * This is intentionally NOT a shell: `$`, backticks, `;`, `|`, and friends are
 * plain characters with no expansion or chaining.
 */

export type ArgvParse =
  | { ok: true; argv: readonly string[] }
  | { ok: false; reason: "unterminated-quote"; quote: "'" | '"' };

/**
 * A run of characters read at one parser position: its decoded value, the
 * index to resume at, and — for quoted runs — the quote that never closed.
 */
interface ArgvSegment {
  value: string;
  nextIndex: number;
  unclosedQuote: "'" | '"' | null;
}

function isArgvWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isArgvQuote(char: string): char is "'" | '"' {
  return char === "'" || char === '"';
}

/**
 * Read a single- or double-quoted run starting at `start` (the opening quote).
 *
 * Single quotes are fully literal. In double quotes a backslash only escapes
 * `"` and `\`; anything else (including `\n`) stays literal, matching shell
 * semantics and keeping written markdown intact.
 */
function readQuotedSegment(command: string, start: number, quote: "'" | '"'): ArgvSegment {
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
function readUnquotedSegment(command: string, start: number): ArgvSegment {
  let value = "";
  let i = start;

  while (i < command.length) {
    const char = command[i] ?? "";
    if (isArgvWhitespace(char) || isArgvQuote(char)) break;

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
function readSegment(command: string, start: number): ArgvSegment {
  const char = command[start] ?? "";
  return isArgvQuote(char)
    ? readQuotedSegment(command, start, char)
    : readUnquotedSegment(command, start);
}

/**
 * Split a command string into argv without invoking a shell.
 *
 * POSIX quoting is honored (`'...'`, `"..."`, backslash escapes) but no
 * expansion happens. Whitespace inside quotes — including newlines — is
 * preserved.
 */
export function parseArgv(command: string): ArgvParse {
  const argv: string[] = [];
  let current: string | null = null;
  let i = 0;

  while (i < command.length) {
    const char = command[i] ?? "";

    if (isArgvWhitespace(char)) {
      if (current !== null) argv.push(current);
      current = null;
      i += 1;
      continue;
    }

    const segment = readSegment(command, i);
    if (segment.unclosedQuote !== null) {
      return { ok: false, reason: "unterminated-quote", quote: segment.unclosedQuote };
    }

    current = (current ?? "") + segment.value;
    i = segment.nextIndex;
  }

  if (current !== null) argv.push(current);
  return { ok: true, argv };
}
