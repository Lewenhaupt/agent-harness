/**
 * Deterministic quality gates for Belayd agents.
 *
 * Each gate runs zero AI tokens — it shells out to deterministic checks
 * and returns pass/fail.
 */

import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { GateOptions, GateResult, SpawnDetails } from "./agent-registry.js";
import { cleanTerminalOutput, parseCast } from "./cast-utils.js";
import {
  checkPathTraversal,
  checkProofArtifactsExist,
  checkProofDirTraversal,
  findProofArtifactRefs,
  findWorkspaceRoot,
  resolveProofRefInDir,
} from "./proof-verification.js";

const execAsync = promisify(exec);

/**
 * Each captured stream is capped by both line count and character count: a
 * huge failure log must not re-inflate the retry prompt, and a single
 * minified/base64 line must not bypass the line cap.
 */
const MAX_GATE_OUTPUT_LINES = 50;
const MAX_GATE_OUTPUT_CHARS = 32 * 1024;

/** Prevent Biome/vitest diagnostics from being dropped at the default 1 MiB. */
const GATE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Cap on the failing file:line entries surfaced in the feedback header. */
const MAX_FAILING_LOCATION_ENTRIES = 10;

/**
 * Diagnostic lines are short; anything longer is machine output (bundles,
 * base64 blobs, long hashes) that cannot be a useful file:line entry and
 * would only make the location scan slower.
 */
const MAX_LOCATION_SCAN_LINE_CHARS = 2_048;

/**
 * Vitest prints its failure detail and `❯ file (N failed)` summary at the end
 * of large runs, so each stream is scanned as a head slice plus a tail slice.
 * The two slices are scanned separately (never joined), and their combined
 * budget equals the old single-slice cap: 32 KiB + 32 KiB per stream.
 */
const MAX_LOCATION_SCAN_HEAD_CHARS = 32 * 1024;
const MAX_LOCATION_SCAN_TAIL_CHARS = 32 * 1024;
const MAX_LOCATION_SCAN_CHARS = MAX_LOCATION_SCAN_HEAD_CHARS + MAX_LOCATION_SCAN_TAIL_CHARS;

const MAX_BUFFER_ERROR_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/**
 * Truncate a string by character count first, then line count. Both bounds
 * are applied so neither a few enormous lines nor many short lines can
 * produce unbounded feedback.
 */
function truncateOutput(
  text: string,
  maxLines = MAX_GATE_OUTPUT_LINES,
  maxChars = MAX_GATE_OUTPUT_CHARS,
): string {
  const charCapped = text.length > maxChars ? text.slice(0, maxChars) : text;
  const charTruncated = charCapped.length < text.length;
  const lines = charCapped.split("\n");
  const lineCapped = lines.length <= maxLines ? charCapped : lines.slice(0, maxLines).join("\n");

  if (charTruncated) {
    // The line remainder would be computed on the char-capped slice and
    // understate the true total, so the accurate char count is the only marker.
    return `${lineCapped}\n... (${text.length - maxChars} more chars truncated)`;
  }
  if (lines.length <= maxLines) return charCapped;
  return `${lineCapped}\n... (${lines.length - maxLines} more lines truncated)`;
}

const DEFAULT_TIMEOUT_MS = 60_000;

interface RunGateCommandOptions {
  /** Human-facing gate name, e.g. "Lint". */
  label: string;
  /** Exact command that was run, included so the retry does not have to guess. */
  command: string;
  cwd: string;
  timeoutInMs: number;
}

/** Narrowed `ExecException` shape; a thrown plain `Error` lacks the extra fields. */
interface GateCommandFailure {
  message: string;
  stdout: string;
  stderr: string;
  code: number | string | undefined;
  killed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toGateCommandFailure(error: unknown): GateCommandFailure {
  let message = "Command failed";
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  }

  if (!isRecord(error)) {
    return { message, stdout: "", stderr: "", code: undefined, killed: false };
  }

  const codeValue = error.code;
  const code =
    typeof codeValue === "number" || typeof codeValue === "string" ? codeValue : undefined;

  return {
    message,
    stdout: typeof error.stdout === "string" ? error.stdout : "",
    stderr: typeof error.stderr === "string" ? error.stderr : "",
    code,
    killed: error.killed === true,
  };
}

// A path token plus one of the three diagnostic location suffixes. The token
// starts only at a line boundary or after whitespace/marker characters, so the
// regex engine cannot restart a scan at every offset (which made the previous
// unanchored pattern quadratic on long bundle lines). The optional leading
// slash preserves absolute paths.
const SOURCE_FILE_TOKEN = String.raw`(?:/)?[\w.@-]+(?:/[\w.@-]+)*\.(?:[cm]?[jt]sx?|jsonc?|css|svelte|vue|astro)`;
const LOCATION_BOUNDARY = String.raw`(?:^|[\s❯>(])`;
const VITEST_FAIL_LOCATION_RE = new RegExp(String.raw`^\s*FAIL\s+(${SOURCE_FILE_TOKEN})`);
const COLON_LOCATION_RE = new RegExp(
  String.raw`${LOCATION_BOUNDARY}(${SOURCE_FILE_TOKEN}):(\d+)(?::\d+)?`,
);
const PAREN_LOCATION_RE = new RegExp(
  String.raw`${LOCATION_BOUNDARY}(${SOURCE_FILE_TOKEN})\((\d+),\d+\)`,
);

interface SourceLocation {
  file: string;
  line: string | undefined;
}

function matchSourceLocation(line: string): SourceLocation | null {
  const failMatch = VITEST_FAIL_LOCATION_RE.exec(line);
  const failFile = failMatch?.[1];
  if (failFile !== undefined) return { file: failFile, line: undefined };

  const colonMatch = COLON_LOCATION_RE.exec(line);
  const colonFile = colonMatch?.[1];
  const colonLine = colonMatch?.[2];
  if (colonFile !== undefined && colonLine !== undefined) {
    return { file: colonFile, line: colonLine };
  }

  const parenMatch = PAREN_LOCATION_RE.exec(line);
  const parenFile = parenMatch?.[1];
  const parenLine = parenMatch?.[2];
  if (parenFile !== undefined && parenLine !== undefined) {
    return { file: parenFile, line: parenLine };
  }

  return null;
}

/**
 * Match one diagnostic line and claim its file path in `seenFiles`.
 * Returns null for oversized/machine lines, dependency frames, and repeated
 * files so the caller only has to append the result.
 */
function locationForDiagnosticLine(line: string, seenFiles: Set<string>): string | null {
  if (line.length > MAX_LOCATION_SCAN_LINE_CHARS) return null;
  // Dependency stack frames are noise; the retry cannot edit them.
  if (line.includes("node_modules")) return null;

  const location = matchSourceLocation(line);
  if (location === null || seenFiles.has(location.file)) return null;

  seenFiles.add(location.file);
  return location.line === undefined ? location.file : `${location.file}:${location.line}`;
}

/**
 * Split a stream into the bounded head and tail slices to scan. Slices are
 * trimmed to complete lines so a cut can never fabricate a diagnostic line,
 * and they stay separate so no line is joined across the seam.
 */
function locationScanSlices(text: string): string[] {
  if (text.length <= MAX_LOCATION_SCAN_CHARS) return [text];

  const headSlice = text.slice(0, MAX_LOCATION_SCAN_HEAD_CHARS);
  const headEnd = headSlice.lastIndexOf("\n");
  const head = headEnd === -1 ? "" : headSlice.slice(0, headEnd);

  const tailSlice = text.slice(text.length - MAX_LOCATION_SCAN_TAIL_CHARS);
  const tailStart = tailSlice.indexOf("\n");
  const tail = tailStart === -1 ? "" : tailSlice.slice(tailStart + 1);

  return [head, tail];
}

/** Arguments for a single location-scan pass over one text slice. */
interface ScanTextForLocationsArgs {
  text: string;
  seenFiles: Set<string>;
  locations: string[];
  maxEntries: number;
}

function scanTextForLocations({
  text,
  seenFiles,
  locations,
  maxEntries,
}: ScanTextForLocationsArgs): void {
  for (const scanText of locationScanSlices(text)) {
    for (const line of scanText.split("\n")) {
      if (locations.length >= maxEntries) return;

      const location = locationForDiagnosticLine(line, seenFiles);
      if (location !== null) locations.push(location);
    }
  }
}

/**
 * Scan a bounded set of diagnostic texts into file locations. Each text is
 * sliced before splitting so a 10 MiB capture never materializes as a large
 * line array, and each line must be short enough to be a diagnostic line.
 * Deduplication is by file path (first occurrence wins) so `FAIL file` and a
 * later `❯ file:line` stack frame do not report the same file twice.
 */
function collectFailingLocations(texts: readonly string[], maxEntries: number): string[] {
  const seenFiles = new Set<string>();
  const locations: string[] = [];

  for (const text of texts) {
    if (locations.length >= maxEntries) break;
    scanTextForLocations({ text, seenFiles, locations, maxEntries });
  }

  return locations;
}

/**
 * Extract the first failing file locations from biome (`file:line:col`),
 * tsc (`file(line,col): error`) and vitest (`FAIL file`, `❯ file:line:col`)
 * diagnostics. Order is preserved and duplicates are dropped so the retry can
 * start at the first broken file instead of re-running the gate blindly.
 */
export function extractFailingLocations(
  output: string,
  maxEntries = MAX_FAILING_LOCATION_ENTRIES,
): string[] {
  return collectFailingLocations([output], maxEntries);
}

function describeFailureStatus(
  options: RunGateCommandOptions,
  failure: GateCommandFailure,
): string {
  if (failure.killed) {
    return `timed out after ${Math.round(options.timeoutInMs / 1000)}s`;
  }
  if (failure.code === undefined) return "failed";
  if (typeof failure.code === "string") return `spawn error ${failure.code}`;
  return `exit ${failure.code}`;
}

function isMaxBufferFailure(failure: GateCommandFailure): boolean {
  return failure.code === MAX_BUFFER_ERROR_CODE;
}

function renderGateFailure(options: RunGateCommandOptions, failure: GateCommandFailure): string {
  const sections: string[] = [
    `${options.label} failed (${options.command}, ${describeFailureStatus(options, failure)}):`,
  ];

  const streams = [
    { name: "stdout", text: failure.stdout },
    { name: "stderr", text: failure.stderr },
  ].filter((stream) => stream.text.trim() !== "");

  // Scan the streams separately, each with its own input bound, so a huge
  // stdout capture neither hides stderr diagnostics nor forces a full join.
  const failingLocations = collectFailingLocations(
    streams.map((stream) => stream.text),
    MAX_FAILING_LOCATION_ENTRIES,
  );
  if (failingLocations.length > 0) {
    sections.push("", "Failing files:");
    for (const location of failingLocations) {
      sections.push(`  ${location}`);
    }
  }

  if (streams.length === 0) {
    const message = failure.message.trim();
    sections.push("", truncateOutput(message !== "" ? message : "No diagnostic output captured."));
  } else {
    for (const stream of streams) {
      sections.push("", `--- ${stream.name} ---`, truncateOutput(stream.text.trimEnd()));
    }
  }

  if (isMaxBufferFailure(failure)) {
    sections.push(
      "",
      `Diagnostic output exceeded the ${GATE_MAX_BUFFER_BYTES} byte capture limit; output shown above is incomplete.`,
    );
  }

  sections.push("", `Run \`${options.command}\` for the full output.`);
  return sections.join("\n");
}

/**
 * Run a gate command and turn its failure into diagnostic feedback.
 *
 * The shell redirect that used to merge streams is intentionally gone: exec
 * keeps stdout and stderr separate, which matters because biome and vitest
 * write their diagnostics to stdout while Node's reject message only carries
 * stderr.
 */
async function runGateCommand(options: RunGateCommandOptions): Promise<GateResult> {
  try {
    await execAsync(options.command, {
      cwd: options.cwd,
      timeout: options.timeoutInMs,
      maxBuffer: GATE_MAX_BUFFER_BYTES,
    });
    return { passed: true };
  } catch (error) {
    return {
      passed: false,
      feedback: renderGateFailure(options, toGateCommandFailure(error)),
    };
  }
}

/**
 * Run pnpm typecheck and return pass/fail.
 */
export async function gateTypecheck(
  _output: string,
  _details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  return runGateCommand({
    label: "Typecheck",
    command: "pnpm typecheck",
    cwd: options?.cwd ?? process.cwd(),
    timeoutInMs: options?.timeoutInMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/**
 * Run pnpm lint and return pass/fail.
 */
export async function gateLint(
  _output: string,
  _details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  return runGateCommand({
    label: "Lint",
    command: "pnpm lint",
    cwd: options?.cwd ?? process.cwd(),
    timeoutInMs: options?.timeoutInMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/**
 * Run pnpm test and return pass/fail.
 */
export async function gateTests(
  _output: string,
  _details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  return runGateCommand({
    label: "Tests",
    command: "pnpm test",
    cwd: options?.cwd ?? process.cwd(),
    timeoutInMs: options?.timeoutInMs ?? DEFAULT_TIMEOUT_MS,
  });
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
 * - Exit code event ("x" type) present
 */
export async function validateCastRecording(castPath: string): Promise<GateResult> {
  let content: string;
  try {
    content = await readFile(castPath, "utf-8");
  } catch {
    return { passed: false, feedback: `Proof file not found on disk: ${castPath}` };
  }

  const parsed = parseCast(content, castPath);
  if (!parsed.passed) {
    return parsed;
  }

  const header = parsed.header;
  if (header === undefined) {
    return { passed: false, feedback: `Malformed .cast file: empty (${castPath})` };
  }

  if (isQualityGateCommand(String(header.command))) {
    return {
      passed: false,
      feedback: `Proof recording replicates a quality gate (${header.command}); record functional behavior instead (${castPath})`,
    };
  }

  const events = parsed.events;
  if (events === undefined) {
    return { passed: false, feedback: `Malformed .cast file: empty (${castPath})` };
  }

  const outputCheck = checkSubstantiveOutput(events);
  if (outputCheck) {
    return {
      passed: false,
      feedback: `${outputCheck.feedback} (${castPath})`,
    };
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
