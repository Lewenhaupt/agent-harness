/**
 * Deterministic quality gates for Belayd agents.
 *
 * Each gate runs zero AI tokens — it shells out to deterministic checks
 * and returns pass/fail.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GateOptions, GateResult, SpawnDetails } from "./agent-registry.js";

const execAsync = promisify(exec);

/**
 * Truncate a string to a maximum number of lines.
 */
function truncateOutput(text: string, maxLines = 50): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n... (${lines.length - maxLines} more lines truncated)`;
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

const PACKAGE_MANAGER_PATTERN = /^(pnpm|npm|yarn|npx|bun)$/i;
const GATE_RUNNER_PATTERN = /^(typecheck|lint|build|vitest|jest|mocha|cypress)$/i;
const TEST_SCRIPT_PATTERN = /^(?:test(?:[:._-]|$)|.+[:._-]test$)/i;
// Bare tokens exclude the plain `test` builtin; it is only a gate when a
// package manager invokes it (pnpm test / npm test) or a separator follows.
const TEST_SCRIPT_TOKEN_PATTERN = /^(?:test[:._-].+|.+[:._-]test)$/i;

/** True when a token names a gate runner. */
function isGateRunner(token: string): boolean {
  return GATE_RUNNER_PATTERN.test(token);
}

/** True when a package-manager sub-command names a test script (includes plain `test`). */
function isTestScript(token: string): boolean {
  return TEST_SCRIPT_PATTERN.test(token);
}

/** True when a bare token names a test script (excludes plain `test`). */
function isTestScriptToken(token: string): boolean {
  return TEST_SCRIPT_TOKEN_PATTERN.test(token);
}

/** True when the token after `playwright` is `test` (the test runner, not the trace viewer). */
function isPlaywrightTestInvocation(current: string, next: string): boolean {
  return current.toLowerCase() === "playwright" && next.toLowerCase() === "test";
}

/** The subcommand a package-manager token targets, skipping an optional `run`. */
function packageManagerTarget(tokens: string[], index: number): string {
  const after = (tokens[index + 1] ?? "").toLowerCase();
  if (after === "run") {
    return (tokens[index + 2] ?? "").toLowerCase();
  }
  return after;
}

/** Unwrap a single `bash -c '...'`-style shell wrapper, recursing once for double wrapping. */
function unwrapShellWrapper(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:bash|sh|zsh)(?:\s+-[a-z]*c[a-z]*)?\s+(['"])([\s\S]*)\1\s*$/i);
  if (match && match[2] !== undefined && match[2] !== "") {
    const inner = unwrapShellWrapper(match[2]);
    return inner === "" ? match[2] : inner;
  }
  return trimmed;
}

/** True when a single token at `index` flags the command as a quality gate or test runner. */
function tokenFlagsQualityGate(tokens: string[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined) return false;
  if (isPlaywrightTestInvocation(token, tokens[index + 1] ?? "")) return true;
  if (PACKAGE_MANAGER_PATTERN.test(token)) {
    const sub = packageManagerTarget(tokens, index);
    return sub !== "" && (isGateRunner(sub) || isTestScript(sub));
  }
  return isGateRunner(token) || isTestScriptToken(token);
}

/** True when a command re-runs a quality gate or test runner rather than exercising functional behavior. */
function isQualityGateCommand(command: string): boolean {
  const inner = unwrapShellWrapper(command).trim();
  if (inner === "") return false;
  const tokens = inner.split(/\s+/).filter((t) => t !== "");
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokenFlagsQualityGate(tokens, i)) return true;
  }
  return false;
}

/** Accepted proof artifact file extensions. */
const PROOF_ARTIFACT_EXTENSIONS: readonly string[] = [
  ".trace.zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".cast",
];

/** True when a path ends with one of the accepted proof artifact extensions. */
function isProofArtifactPath(path: string): boolean {
  return PROOF_ARTIFACT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** All proof-of-work/... references in the output that point at accepted artifact types. */
function findProofArtifactRefs(output: string): string[] {
  const matches = output.match(/\bproof-of-work\/[\w/.-]+\b/g);
  if (!matches) return [];
  return matches.filter(isProofArtifactPath);
}

/** Canonical skip-reason labels matched against the proof prompt's skip contract. */
const SKIPPABLE_REASONS: readonly string[] = [
  "rename/refactor",
  "config-only",
  "doc-only",
  "dependency bump",
  "typo",
] as const;

/** True when a documented skip reason equals a canonical label or begins with it followed by a boundary. */
function reasonMatchesLabel(reason: string, label: string): boolean {
  if (reason === label) return true;
  if (reason.startsWith(`${label} `)) return true;
  if (reason.startsWith(`${label}:`)) return true;
  if (reason.startsWith(`${label}-`)) return true;
  return false;
}

/**
 * Detect a documented proof-skip reason in the output.
 * Returns the canonical label when the skip marker is present and its reason
 * matches a known skip reason; otherwise null.
 */
function findDocumentedSkipReason(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!/proof\s+skipped/i.test(line)) continue;
    const match = line.match(/proof\s+skipped[:\- ]\s*(.+)$/i);
    if (!match || !match[1]) continue;
    const reasonLower = match[1]
      .trim()
      .replace(/^\*+|\*+$/g, "")
      .trim()
      .toLowerCase();
    for (const label of SKIPPABLE_REASONS) {
      if (reasonMatchesLabel(reasonLower, label)) return label;
    }
    return null;
  }
  return null;
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

  if (
    headerResult.header !== undefined &&
    isQualityGateCommand(String(headerResult.header.command))
  ) {
    return {
      passed: false,
      feedback: `Proof recording replicates a quality gate (${headerResult.header.command}); record functional behavior instead (${castPath})`,
    };
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
 * Check that referenced proof artifacts exist on disk.
 * Resolves accepted artifact refs (including .cast) against either the
 * workspace proof-of-work root or the external proof dir. Returns a failed
 * GateResult listing missing refs, or null when every referenced artifact exists.
 */
function checkProofArtifactsExist(
  output: string,
  proofWorkRoot: string,
  proofDir?: string,
): GateResult | null {
  const refs = findProofArtifactRefs(output);
  if (refs.length === 0) {
    return null;
  }

  const missingRefs: string[] = [];
  for (const ref of refs) {
    const normalizedRef = ref.startsWith("/") ? ref.slice(1) : ref;
    if (normalizedRef.includes("..")) {
      return { passed: false, feedback: `Path traversal detected: ${normalizedRef}` };
    }
    // Workspace refs resolve proof-of-work/<task>/... directly under proofWorkRoot
    // (via the proof-of-work symlink); the proofDir branch strips the prefix above.
    const resolvedPath =
      proofDir === undefined
        ? resolve(proofWorkRoot, normalizedRef)
        : resolveProofRefInDir(normalizedRef, proofDir);
    if (!existsSync(resolvedPath)) {
      missingRefs.push(normalizedRef);
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

/** Map a `proof-of-work/<task-id>/...` reference into an external task dir. */
function resolveProofRefInDir(ref: string, proofDir: string): string {
  const relative = ref.startsWith("proof-of-work/") ? ref.slice("proof-of-work/".length) : ref;
  return resolve(proofDir, ...relative.split("/").slice(1));
}

/**
 * Walk up from startDir to the nearest ancestor containing a `.git` entry.
 * Falls back to startDir when no git worktree root is found, preserving the
 * legacy behavior for ad-hoc directories that contain proof-of-work directly.
 */
function findWorkspaceRoot(startDir: string): string {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir);
}

/**
 * Validate that a cast file path does not escape the proof-of-work directory.
 * Returns a failed GateResult on path traversal, or null if safe.
 */
function checkPathTraversal(castPath: string, proofBase: string): GateResult | null {
  // Strip "proof-of-work/" prefix if present, since we resolve against proofBase + "proof-of-work/"
  const relativePath = castPath.startsWith("proof-of-work/")
    ? castPath.slice("proof-of-work/".length)
    : castPath;
  const resolved = resolve(proofBase, "proof-of-work", relativePath);
  const allowedDir = resolve(proofBase, "proof-of-work");
  if (!resolved.startsWith(allowedDir + sep)) {
    return { passed: false, feedback: `Path traversal detected: ${castPath}` };
  }
  return null;
}

/**
 * Validate that an absolute cast path stays inside the external proof dir.
 */
function checkProofDirTraversal(castPath: string, proofDir: string): GateResult | null {
  const resolved = resolve(castPath);
  const allowedDir = resolve(proofDir);
  if (resolved !== allowedDir && !resolved.startsWith(allowedDir + sep)) {
    return { passed: false, feedback: `Path traversal detected: ${castPath}` };
  }
  return null;
}

/**
 * Validate a single .cast artifact reference against its resolved path.
 * Applies the path-traversal guard for the active resolution mode, then
 * content-validates the recording.
 */
async function validateCastArtifact(
  artifact: string,
  cwd: string,
  proofDir: string | undefined,
): Promise<GateResult> {
  if (proofDir !== undefined) {
    const castPath = resolveProofRefInDir(artifact, proofDir);
    const traversalCheck = checkProofDirTraversal(castPath, proofDir);
    if (traversalCheck) return traversalCheck;
    return validateCastRecording(castPath);
  }

  const proofWorkRoot = findWorkspaceRoot(cwd);
  const traversalCheck = checkPathTraversal(artifact, proofWorkRoot);
  if (traversalCheck) return traversalCheck;
  return validateCastRecording(resolve(proofWorkRoot, artifact));
}

/**
 * Quality gate for proof-of-work content.
 *
 * Resolution order: optional proofRequired, documented skip reason, then
 * artifact validation. Artifacts must be referenced in the output; .cast
 * recordings are content-validated and every other accepted artifact type
 * must exist on disk. Never judges whether a proof is relevant.
 */
export async function gateProofContent(
  output: string,
  _details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  if (options?.proofRequired === false) {
    return { passed: true, feedback: "Proof not required for this workflow type" };
  }

  const skipReason = findDocumentedSkipReason(output);
  if (skipReason !== null) {
    return { passed: true, feedback: `Proof skipped: ${skipReason}` };
  }

  const artifacts = findProofArtifactRefs(output);
  if (artifacts.length === 0) {
    return { passed: false, feedback: "No proof artifacts produced or referenced" };
  }

  const cwd = options?.cwd ?? process.cwd();
  const proofDir = options?.proofDir !== undefined ? resolve(options.proofDir) : undefined;

  for (const artifact of artifacts) {
    if (artifact.endsWith(".cast")) {
      const castResult = await validateCastArtifact(artifact, cwd, proofDir);
      if (!castResult.passed) return castResult;
    }
  }

  const proofWorkRoot = findWorkspaceRoot(cwd);
  const missingRefsCheck = checkProofArtifactsExist(output, proofWorkRoot, proofDir);
  if (missingRefsCheck) return missingRefsCheck;

  return { passed: true, feedback: `${artifacts.length} proof artifact(s) validated` };
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
