/**
 * Terminal-output cleaning and asciicast parsing utilities.
 *
 * Extracted from quality-gates.ts so both the deterministic proof gate and
 * the advisory proof verifier can consume .cast recordings through the same
 * ANSI/OSC stripping and event-parsing logic.
 */

import { readFile } from "node:fs/promises";
import type { GateResult } from "./agent-registry.js";

/** Regex for ANSI escape sequences - built via RegExp to avoid lint warnings on control chars. */
const ansiPattern = "[\\u001b\\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]";
const ansiRegex = new RegExp(ansiPattern, "g");

/** Regex for OSC sequences - built via RegExp to avoid lint warnings on control chars. */
const oscPattern = "\\u001b\\].*?(?:\\u0007|\\u001b\\\\)";
const oscRegex = new RegExp(oscPattern, "g");

/**
 * Strip ANSI escape sequences from a string.
 */
function stripAnsi(text: string): string {
  return text.replace(ansiRegex, "");
}

/**
 * Strip OSC (Operating System Command) sequences.
 * These are ESC ] ... BEL or ESC ] ... ESC \ patterns used for
 * window titles, kitty cwd markers, shell integration, etc.
 */
function stripOscSequences(text: string): string {
  return text.replace(oscRegex, "");
}

/**
 * Strip OSC residues that survive after control char removal.
 * When ESC and BEL bytes are removed by stripControlChars, sequences
 * like ]2;shell, ]7;kitty-shell-cwd://path, or ]0;window-title
 * (terminal-title ST variant) remain. This removes them all.
 */
function stripOscResidues(text: string): string {
  return text.replace(/\]\d+[;:][^\n]*/g, "");
}

/**
 * Strip low control characters (non-printable) from text.
 * Uses charCode comparison to avoid control characters in regex literals.
 */
function stripControlChars(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Keep printable chars and common whitespace (tab 0x09, newline 0x0a, carriage return 0x0d)
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      result += text[i];
    }
  }
  return result;
}

/**
 * Clean terminal output by stripping all escape sequences and
 * control characters in the correct order.
 */
export function cleanTerminalOutput(text: string): string {
  let result = text;
  result = stripOscSequences(result);
  result = stripAnsi(result);
  result = stripControlChars(result);
  result = stripOscResidues(result);
  // A second pass removes residues revealed only after the first strip/control
  // pass (e.g. nested or interleaved terminal-title sequences).
  result = stripOscResidues(result);
  return result;
}

/** A single asciicast event: [time, type, data]. */
export type CastEvent = [number, string, string];

/** Parsed asciicast header (asciicast v2+ command metadata lives here). */
export interface CastHeader {
  [key: string]: unknown;
}

/** A parsed asciicast recording: its header plus ordered events. */
export interface ParsedCast {
  header: CastHeader;
  events: CastEvent[];
}

/**
 * Parse a full .cast recording (header line + event lines) into structured
 * form. Returns a failed GateResult on any malformed line with the same
 * error strings the proof gate historically emitted.
 */
export function parseCast(content: string, castPath: string): GateResult & Partial<ParsedCast> {
  const lines = content.trim().split("\n");
  if (lines.length < 1) {
    return { passed: false, feedback: `Malformed .cast file: empty (${castPath})` };
  }

  const firstLine = lines[0];
  if (firstLine === undefined) {
    return { passed: false, feedback: `Malformed .cast file: empty (${castPath})` };
  }

  let header: CastHeader;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (typeof parsed !== "object" || parsed === null) {
      return {
        passed: false,
        feedback: `Malformed .cast file: header is not an object (${castPath})`,
      };
    }
    header = parsed as CastHeader;
  } catch {
    return { passed: false, feedback: `Malformed .cast file: invalid header JSON (${castPath})` };
  }

  if (!("command" in header) || typeof header.command !== "string" || header.command === "") {
    return {
      passed: false,
      feedback: `Proof recording has no command in header: no command executed (${castPath})`,
    };
  }

  const events: CastEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const eventLine = lines[i];
    if (eventLine === undefined) {
      return {
        passed: false,
        feedback: `Malformed .cast file: missing event line ${i + 1} (${castPath})`,
      };
    }
    let event: unknown;
    try {
      event = JSON.parse(eventLine);
    } catch {
      return {
        passed: false,
        feedback: `Malformed .cast file: invalid JSON at event line ${i + 1} (${castPath})`,
      };
    }

    if (
      !Array.isArray(event) ||
      event.length < 3 ||
      typeof event[0] !== "number" ||
      typeof event[1] !== "string" ||
      typeof event[2] !== "string"
    ) {
      return {
        passed: false,
        feedback: `Malformed .cast file: invalid event format at line ${i + 1} (${castPath})`,
      };
    }
    events.push(event as CastEvent);
  }

  return { passed: true, header, events };
}

/**
 * Convert a parsed cast into a human-readable plain-text transcript.
 * Output events render their cleaned data; every other event renders its
 * type and data so timestamps/exit codes survive the conversion.
 */
export function castToText(parsed: ParsedCast): string {
  const lines: string[] = [];
  const command = typeof parsed.header.command === "string" ? parsed.header.command : undefined;
  if (command !== undefined && command !== "") {
    lines.push(`$ ${command}`);
  }

  for (const [time, type, data] of parsed.events) {
    if (type === "o") {
      const cleaned = cleanTerminalOutput(data).trim();
      if (cleaned !== "") lines.push(cleaned);
    } else if (type === "x") {
      lines.push(`[exit ${data}]`);
    } else {
      lines.push(`[${type} @${time.toFixed(3)}s] ${data}`);
    }
  }
  return lines.join("\n");
}

/**
 * Read a .cast file from disk and convert it to plain text. Failures return
 * an error string rather than throwing so callers can surface them as
 * advisory (non-blocking) feedback.
 */
export async function readCastToText(
  castPath: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let content: string;
  try {
    content = await readFile(castPath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read cast file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = parseCast(content, castPath);
  if (!parsed.passed || !parsed.header || !parsed.events) {
    return { ok: false, error: parsed.feedback ?? "Malformed .cast file" };
  }

  return { ok: true, text: castToText({ header: parsed.header, events: parsed.events }) };
}
