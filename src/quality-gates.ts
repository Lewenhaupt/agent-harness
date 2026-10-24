/**
 * Deterministic quality gates for Belayd agents.
 *
 * Each gate runs zero AI tokens — it shells out to deterministic checks
 * and returns pass/fail.
 */

import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GateOptions, GateResult, QualityGate, SpawnDetails } from "./agent-registry.js";
import { cleanTerminalOutput, parseCast } from "./cast-utils.js";
import {
  checkPathTraversal,
  checkProofArtifactsExist,
  checkProofDirTraversal,
  enumerateProofDirArtifacts,
  findOutsideProofDirRefs,
  findProofArtifactRefs,
  findTraversalProofRefs,
  findWorkspaceRoot,
  hasExtensionIgnoreCase,
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
 * Worktree-relative path of the userguide phase deliverable.
 *
 * Derived from the bead id so an orchestrator, a gate retry, and the commit
 * note all agree on one path without passing it around: `docs/bd-42-userguide.md`.
 */
export function userGuideDocPath(taskId: string): string {
  const trimmed = taskId.trim();
  return trimmed === "" ? "docs/userguide.md" : `docs/${trimmed}-userguide.md`;
}

/** Section and length problems in a guide body, shared by both gate contracts. */
function userGuideContentFailures(content: string): string[] {
  const failures: string[] = [];
  if (!/##\s+How\s+to\s+Verify/i.test(content)) {
    failures.push('Missing "## How to Verify" section');
  }
  if (!/##\s+How\s+to\s+Use/i.test(content)) {
    failures.push('Missing "## How to Use" section');
  }
  if (content.length < MIN_USER_GUIDE_LENGTH) {
    failures.push(
      `User guide too short (${content.length} chars, minimum ${MIN_USER_GUIDE_LENGTH})`,
    );
  }
  return failures;
}

/**
 * Read the deliverable, refusing any path that escapes the worktree. The path
 * reaches the gate from the phase run, and a retry agent can edit the guide, so
 * a traversal-shaped value must fail closed rather than be probed.
 */
async function readUserGuideFile(options: {
  path: string;
  cwd: string;
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const root = resolve(options.cwd);
  const absolute = resolve(root, options.path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    return { ok: false, error: `User guide path escapes the worktree: ${options.path}` };
  }
  try {
    return { ok: true, content: await readFile(absolute, "utf8") };
  } catch {
    return {
      ok: false,
      error: `Missing user guide file: ${options.path} — write the guide there (the file is the deliverable, not your chat output)`,
    };
  }
}

/**
 * Quality gate for the userguide phase.
 *
 * With a `userGuidePath` (the normal workflow path) the gate validates the file
 * on disk: it is the record a reviewer or operator opens later, so a chat-only
 * answer must not pass. Without a path the gate keeps the legacy text contract.
 */
export async function gateUserGuide(
  output: string,
  _details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  if (options?.userGuidePath === undefined) {
    return userGuideVerdict(userGuideContentFailures(output));
  }

  const read = await readUserGuideFile({
    path: options.userGuidePath,
    cwd: options.cwd ?? process.cwd(),
  });
  if (!read.ok) return { passed: false, feedback: `User guide quality issues:\n${read.error}` };

  const failures = userGuideContentFailures(read.content).map(
    (failure) => `${failure} in ${options.userGuidePath}`,
  );
  return userGuideVerdict(failures);
}

/** Shape a userguide verdict from its collected failures. */
function userGuideVerdict(failures: readonly string[]): GateResult {
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

/** Proof refs for a run, plus whether they were recovered from the task dir. */
interface ResolvedProofArtifacts {
  refs: string[];
  recoveredFromTaskDir: boolean;
}

/**
 * Resolve accepted proof refs for the output, falling back to fresh artifacts
 * left in the task dir. The fallback is freshness-floored so a retry cannot
 * pass on a failed attempt's leftovers.
 */
function resolveProofArtifacts(
  output: string,
  proofDir: string | undefined,
  proofRunStartMs: number | undefined,
): ResolvedProofArtifacts {
  const refs = findProofArtifactRefs(output, proofDir);
  if (refs.length > 0 || proofDir === undefined) {
    return { refs, recoveredFromTaskDir: false };
  }
  const recovered = enumerateProofDirArtifacts(proofDir, { newerThanMs: proofRunStartMs });
  return { refs: recovered, recoveredFromTaskDir: recovered.length > 0 };
}

/** Failure feedback naming artifact-shaped paths that were ignored as outside the proof dir. */
function noProofArtifactsFeedback(output: string, proofDir: string | undefined): string {
  const ignoredRefs = proofDir === undefined ? [] : findOutsideProofDirRefs(output, proofDir);
  if (ignoredRefs.length === 0) return "No proof artifacts produced or referenced";
  return `No proof artifacts produced or referenced (${ignoredRefs.length} artifact path(s) outside the proof task dir ignored: ${ignoredRefs.join(", ")})`;
}

/**
 * Quality gate for proof-of-work content.
 *
 * Resolution order: optional proofRequired, documented skip reason, then
 * artifact validation. Artifacts must be referenced in the output (canonical
 * `proof-of-work/...` refs or absolute paths inside the proof task dir); when
 * nothing is recognized but the task dir holds accepted artifacts, those are
 * used instead of failing. .cast recordings are content-validated and every
 * other accepted artifact type must exist on disk. Never judges whether a
 * proof is relevant.
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

  const cwd = options?.cwd ?? process.cwd();
  const proofDir = options?.proofDir !== undefined ? resolve(options.proofDir) : undefined;

  // Fail closed on traversal-shaped refs before the enumeration fallback can
  // rescue a fabricated ref with artifacts that do happen to exist on disk.
  const traversalRefs = findTraversalProofRefs(output, proofDir);
  if (traversalRefs.length > 0) {
    return { passed: false, feedback: `Path traversal detected: ${traversalRefs.join(", ")}` };
  }

  const { refs: artifacts, recoveredFromTaskDir } = resolveProofArtifacts(
    output,
    proofDir,
    options?.proofRunStartMs,
  );
  if (artifacts.length === 0) {
    return { passed: false, feedback: noProofArtifactsFeedback(output, proofDir) };
  }

  for (const artifact of artifacts) {
    if (hasExtensionIgnoreCase(artifact, ".cast")) {
      const castResult = await validateCastArtifact(artifact, cwd, proofDir);
      if (!castResult.passed) return castResult;
    }
  }

  const proofWorkRoot = findWorkspaceRoot(cwd);
  const missingRefsCheck = checkProofArtifactsExist(output, proofWorkRoot, proofDir);
  if (missingRefsCheck) return missingRefsCheck;

  return {
    passed: true,
    feedback: recoveredFromTaskDir
      ? `${artifacts.length} proof artifact(s) recovered from the task dir (none referenced in output)`
      : `${artifacts.length} proof artifact(s) validated`,
  };
}

/**
 * Run gates in order, collecting every failure.
 *
 * Both combined gates share this so a failure message names each check the same
 * way, and so adding a check is a one-line change in the caller.
 */
async function runGateSequence(options: {
  output: string;
  details: SpawnDetails;
  gateOptions?: GateOptions;
  gates: ReadonlyArray<{ name: string; gate: QualityGate }>;
}): Promise<GateResult> {
  const failures: string[] = [];
  for (const { name, gate } of options.gates) {
    const result = await gate(options.output, options.details, options.gateOptions);
    if (!result.passed) failures.push(`### ${name}\n${result.feedback ?? "Failed"}`);
  }
  if (failures.length === 0) return { passed: true };
  return {
    passed: false,
    feedback: `**Quality gates failed:**\n\n${failures.join("\n\n")}`,
  };
}

/**
 * Static validation: typecheck + lint, no test run.
 *
 * The implement phase uses this when the workflow has a later `test` phase
 * (bd-139): the suite used to run twice per workflow — once in the implement
 * gate and again in the test gate — for no extra signal. Workflows with no test
 * phase keep gateFullValidation, which is then the only chance to run it.
 */
export async function gateStaticValidation(
  output: string,
  details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  return runGateSequence({
    output,
    details,
    gateOptions: options,
    gates: [
      { name: "typecheck", gate: gateTypecheck },
      { name: "lint", gate: gateLint },
    ],
  });
}

/** Combined quality gate: typecheck + lint + test. */
export async function gateFullValidation(
  output: string,
  details: SpawnDetails,
  options?: GateOptions,
): Promise<GateResult> {
  return runGateSequence({
    output,
    details,
    gateOptions: options,
    gates: [
      { name: "typecheck", gate: gateTypecheck },
      { name: "lint", gate: gateLint },
      { name: "tests", gate: gateTests },
    ],
  });
}
