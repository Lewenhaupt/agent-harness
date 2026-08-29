/**
 * Deterministic quality gates for Belayd agents.
 *
 * Each gate runs zero AI tokens — it shells out to deterministic checks
 * and returns pass/fail.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GateResult, SpawnDetails } from "./agent-registry.js";

const execAsync = promisify(exec);

/**
 * Truncate a string to a maximum number of lines.
 */
function truncateOutput(text: string, maxLines = 50): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n... (${lines.length - maxLines} more lines truncated)`;
}

/**
 * Options for running quality gates.
 */
export interface GateOptions {
  /** Working directory for shell commands. */
  cwd?: string;
  /** Timeout in milliseconds for each check. */
  timeoutInMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run pnpm typecheck and return pass/fail.
 */
export async function gateTypecheck(
  _output: string,
  _details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  try {
    const { stdout: _stdout } = await execAsync("pnpm typecheck 2>&1", {
      cwd: options?.cwd ?? process.cwd(),
      timeout: options?.timeoutInMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { passed: true };
  } catch (err) {
    const stderr = err instanceof Error ? err.message : "Typecheck failed";
    return { passed: false, feedback: `Typecheck failed:\n${truncateOutput(stderr)}` };
  }
}

/**
 * Run pnpm lint and return pass/fail.
 */
export async function gateLint(
  _output: string,
  _details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  try {
    const { stdout: _stdout } = await execAsync("pnpm lint 2>&1", {
      cwd: options?.cwd ?? process.cwd(),
      timeout: options?.timeoutInMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { passed: true };
  } catch (err) {
    const stderr = err instanceof Error ? err.message : "Lint failed";
    return { passed: false, feedback: `Lint failed:\n${truncateOutput(stderr)}` };
  }
}

/**
 * Run pnpm test and return pass/fail.
 */
export async function gateTests(
  _output: string,
  _details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  try {
    const { stdout: _stdout } = await execAsync("pnpm test 2>&1", {
      cwd: options?.cwd ?? process.cwd(),
      timeout: options?.timeoutInMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { passed: true };
  } catch (err) {
    const stderr = err instanceof Error ? err.message : "Tests failed";
    return { passed: false, feedback: `Tests failed:\n${truncateOutput(stderr)}` };
  }
}

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
 * like ]2;shell or ]7;kitty-shell-cwd://path remain. This removes them.
 */
function stripOscResidues(text: string): string {
  return text.replace(/\]\d+;[^\n]*/g, "");
}

/**
 * Clean terminal output by stripping all escape sequences and
 * control characters in the correct order.
 */
function cleanTerminalOutput(text: string): string {
  let result = text;
  result = stripOscSequences(result);
  result = stripAnsi(result);
  result = stripControlChars(result);
  result = stripOscResidues(result);
  return result;
}

/** Minimum content length for a user guide to be considered valid. */
const MIN_USER_GUIDE_LENGTH = 200;

/**
 * Quality gate for user guide content.
 *
 * Checks that the output contains both "How to Verify" and "How to Use"
 * sections, and that the combined content exceeds the minimum length.
 */
export async function gateUserGuide(
  output: string,
  _details: SpawnDetails,
  _options?: GateOptions,
): Promise<GateResult> {
  const failures: string[] = [];

  const hasHowToVerify = /##\s+How\s+to\s+Verify/i.test(output);
  if (!hasHowToVerify) {
    failures.push('Missing "## How to Verify" section');
  }

  const hasHowToUse = /##\s+How\s+to\s+Use/i.test(output);
  if (!hasHowToUse) {
    failures.push('Missing "## How to Use" section');
  }

  if (output.length < MIN_USER_GUIDE_LENGTH) {
    failures.push(
      `User guide too short (${output.length} chars, minimum ${MIN_USER_GUIDE_LENGTH})`,
    );
  }

  if (failures.length > 0) {
    return { passed: false, feedback: `User guide quality issues:\n${failures.join("\n")}` };
  }

  return { passed: true };
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
 * Parse an asciicast v2 file path from the agent output.
 * Returns the first .cast file path mentioned, or null.
 */
function findCastFilePath(output: string): string | null {
  const lines = output.split("\n");
  for (const line of lines) {
    const match = line.match(/\bproof-of-work\/[\w/.-]+\.cast\b/);
    if (match) return match[0];
  }
  return null;
}

/**
 * Parse the header line of an asciicast file and check for a command field.
 */
function parseCastHeader(
  headerJson: string,
  castPath: string,
): GateResult & { header?: Record<string, unknown> } {
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(headerJson);
  } catch {
    return { passed: false, feedback: `Malformed .cast file: invalid header JSON (${castPath})` };
  }

  if (typeof header !== "object" || header === null) {
    return {
      passed: false,
      feedback: `Malformed .cast file: header is not an object (${castPath})`,
    };
  }

  if (!("command" in header) || typeof header.command !== "string" || header.command === "") {
    return {
      passed: false,
      feedback: `Proof recording has no command in header: no command executed (${castPath})`,
    };
  }

  return { passed: true, header };
}

/**
 * Parse asciicast events from lines (index 1+), returning events or a failure.
 */
function parseCastEvents(
  lines: string[],
  castPath: string,
): GateResult & { events?: Array<[number, string, string]> } {
  const events: Array<[number, string, string]> = [];
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
    events.push(event as [number, string, string]);
  }
  return { passed: true, events };
}

/**
 * Check that at least one event has substantive output text.
 */
function checkSubstantiveOutput(events: Array<[number, string, string]>): GateResult | null {
  if (events.length === 0) {
    return {
      passed: false,
      feedback: "Proof recording has no events: empty events array",
    };
  }
  for (const [, type, data] of events) {
    if (type === "o") {
      const cleaned = cleanTerminalOutput(data).trim();
      if (cleaned.length >= 3) {
        return null; // found substantive output
      }
    }
  }
  return {
    passed: false,
    feedback: "Proof recording has no substantive output: all output is empty or ANSI-only",
  };
}

/**
 * Validate a parsed asciicast recording against proof quality standards.
 *
 * Requirements:
 * - Header must contain a "command" field (asciicast v2 style)
 * - At least one substantive output event (>= 3 printable chars after stripping ANSI)
 * - Total elapsed time > 0.1s
 * - Exit code event ("x" type) present
 */
export async function validateCastRecording(castPath: string): Promise<GateResult> {
  let content: string;
  try {
    content = await readFile(castPath, "utf-8");
  } catch {
    return { passed: false, feedback: `Proof file not found on disk: ${castPath}` };
  }

  const lines = content.trim().split("\n");
  if (lines.length < 1) {
    return { passed: false, feedback: `Malformed .cast file: empty (${castPath})` };
  }

  const firstLine = lines[0];
  if (firstLine === undefined) {
    return { passed: false, feedback: `Malformed .cast file: empty (${castPath})` };
  }

  const headerResult = parseCastHeader(firstLine, castPath);
  if (!headerResult.passed) {
    return headerResult;
  }

  const eventResult = parseCastEvents(lines, castPath);
  if (!eventResult.passed || !eventResult.events) {
    return eventResult;
  }
  const { events } = eventResult;

  const outputCheck = checkSubstantiveOutput(events);
  if (outputCheck) {
    return {
      passed: false,
      feedback: `${outputCheck.feedback} (${castPath})`,
    };
  }

  if (events.length > 0) {
    const maxTime = Math.max(...events.map((e) => e[0]));
    if (maxTime <= 0.1) {
      return {
        passed: false,
        feedback: `Proof recording elapsed time too short (${maxTime.toFixed(3)}s, minimum 0.1s) (${castPath})`,
      };
    }
  }

  const hasExitCode = events.some(([, type]) => type === "x");
  if (!hasExitCode) {
    return {
      passed: false,
      feedback: `Proof recording missing exit code: no "x" event type (${castPath})`,
    };
  }

  return { passed: true };
}

/**
 * Check that referenced non-.cast proof files exist on disk.
 * Returns a failed GateResult if any are missing, or null if all exist or none referenced.
 */
function checkNonCastProofRefs(output: string, cwd: string): GateResult | null {
  const proofRefMatch = output.match(/\bproof-of-work\/[\w/.-]+\b/g);
  if (!proofRefMatch || proofRefMatch.length === 0) {
    return null;
  }

  const missingRefs: string[] = [];
  for (const ref of proofRefMatch) {
    if (ref.endsWith(".cast")) continue;
    if (ref.includes("..")) continue;
    const resolvedPath = resolve(cwd, ref);
    if (!existsSync(resolvedPath)) {
      missingRefs.push(ref);
    }
  }

  if (missingRefs.length > 0) {
    return {
      passed: false,
      feedback: `Referenced proof files not found on disk: ${missingRefs.join(", ")}`,
    };
  }
  return null;
}

/**
 * Validate that a cast file path does not escape the proof-of-work directory.
 * Returns a failed GateResult on path traversal, or null if safe.
 */
function checkPathTraversal(castPath: string, cwd: string): GateResult | null {
  const resolved = resolve(cwd, castPath);
  const proofDir = resolve(cwd, "proof-of-work");
  if (!resolved.startsWith(proofDir + sep)) {
    return { passed: false, feedback: `Path traversal detected: ${castPath}` };
  }
  return null;
}

/**
 * Quality gate for proof-of-work content.
 *
 * Scans the agent output for a .cast file path, then validates the recording
 * against proof quality standards. If no .cast file is found (e.g. video or
 * screenshot modality), the gate passes with a warning, but also checks that
 * any referenced proof files exist on disk.
 */
export async function gateProofContent(
  output: string,
  _details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  const cwd = options?.cwd ?? process.cwd();
  const castPath = findCastFilePath(output);

  if (castPath) {
    const traversalCheck = checkPathTraversal(castPath, cwd);
    if (traversalCheck) return traversalCheck;
    return validateCastRecording(resolve(cwd, castPath));
  }

  const missingRefsCheck = checkNonCastProofRefs(output, cwd);
  if (missingRefsCheck) return missingRefsCheck;

  return {
    passed: true,
    feedback: "No .cast file found in output (other proof modalities OK)",
  };
}

/**
 * Combined quality gate: typecheck + lint + test.
 */
export async function gateFullValidation(
  output: string,
  details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  const gates = [
    { name: "typecheck", gate: gateTypecheck },
    { name: "lint", gate: gateLint },
    { name: "tests", gate: gateTests },
  ];

  const failures: string[] = [];
  for (const { name, gate } of gates) {
    const result = await gate(output, details, options);
    if (!result.passed) {
      failures.push(`### ${name}\n${result.feedback ?? "Failed"}`);
    }
  }

  if (failures.length === 0) {
    return { passed: true };
  }

  return {
    passed: false,
    feedback: `**Quality gates failed:**\n\n${failures.join("\n\n")}`,
  };
}
