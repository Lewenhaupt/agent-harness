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
