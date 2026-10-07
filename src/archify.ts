/**
 * Archify diagram-generation wrapper.
 *
 * Archify compiles a typed JSON IR into a single self-contained interactive
 * HTML diagram. This module is the pure core: argument building, receipt
 * parsing, and human-readable formatting. The only side effect is
 * `runArchify`, which shells out to the archify CLI without a shell and
 * injects `ARCHIFY_UPDATE_CHECK_DISABLED` so spawned sessions stay
 * offline-safe (the update checker performs a fixed-manifest network GET).
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";

/** The five diagram IRs archify can render. Single source of truth. */
export const ARCHIFY_DIAGRAM_TYPES = [
  "architecture",
  "workflow",
  "sequence",
  "dataflow",
  "lifecycle",
] as const;

export type ArchifyDiagramType = (typeof ARCHIFY_DIAGRAM_TYPES)[number];

/**
 * Subcommands exposed through the harness. `visual-check` (needs Chrome via
 * `$ARCHIFY_CHROME`) and `preview` (opens a loopback HTTP server) are
 * deliberately excluded from the tool surface.
 */
export const ARCHIFY_COMMANDS = ["render", "validate", "deliver"] as const;

export type ArchifyCommand = (typeof ARCHIFY_COMMANDS)[number];

/**
 * Read-only guidance subcommands. They are deliberately NOT part of
 * `ARCHIFY_COMMANDS`: `isArchifyCommand` is the renderer-command guard, so
 * adding them there would let `guide`/`examples` masquerade as diagram
 * commands. `ARCHIFY_TOOL_COMMANDS` is the union the pi tool accepts.
 */
export const ARCHIFY_GUIDANCE_COMMANDS = ["guide", "examples", "inspect", "check"] as const;

export type ArchifyGuidanceCommand = (typeof ARCHIFY_GUIDANCE_COMMANDS)[number];

/** Every subcommand the `belayd_archify` tool accepts (renderer + guidance). */
export const ARCHIFY_TOOL_COMMANDS = [...ARCHIFY_COMMANDS, ...ARCHIFY_GUIDANCE_COMMANDS] as const;

export type ArchifyToolCommand = (typeof ARCHIFY_TOOL_COMMANDS)[number];

/** Composition quality profiles accepted by render/validate/deliver. */
export const ARCHIFY_QUALITY_PROFILES = ["standard", "showcase"] as const;

export type ArchifyQuality = (typeof ARCHIFY_QUALITY_PROFILES)[number];

/**
 * Subcommands that support `--json`. Upstream `render` rejects `--json` as an
 * unknown option (exit 2), so it prints the output path on stdout instead of a
 * receipt and callers must handle it separately.
 */
const ARCHIFY_JSON_COMMANDS: readonly ArchifyCommand[] = ["validate", "deliver"];

/** Narrow an arbitrary string to a supported diagram type. */
export function isArchifyDiagramType(value: string): value is ArchifyDiagramType {
  return (ARCHIFY_DIAGRAM_TYPES as readonly string[]).includes(value);
}

/** Narrow an arbitrary string to a supported command. */
export function isArchifyCommand(value: string): value is ArchifyCommand {
  return (ARCHIFY_COMMANDS as readonly string[]).includes(value);
}

/** Narrow an arbitrary string to a tool command (renderer or guidance). */
export function isArchifyToolCommand(value: string): value is ArchifyToolCommand {
  return (ARCHIFY_TOOL_COMMANDS as readonly string[]).includes(value);
}

/** Narrow an arbitrary string to a supported quality profile. */
export function isArchifyQuality(value: string): value is ArchifyQuality {
  return (ARCHIFY_QUALITY_PROFILES as readonly string[]).includes(value);
}

export interface BuildArchifyArgsOptions {
  command: ArchifyCommand;
  input: string;
  type?: ArchifyDiagramType;
  output?: string;
  quality?: ArchifyQuality;
  repoRoot?: string;
  json?: boolean;
}

/**
 * Build the argv for one archify invocation (no shell).
 *
 * `--quality` defaults to `showcase` because generated diagrams are committed
 * documentation; callers opt down to `standard` explicitly. `--json` is only
 * ever appended for `validate`/`deliver`: archify 3.x rejects it for `render`
 * as an unknown option (exit 2) and prints the output path on stdout instead.
 * The `json` override therefore opts validate/deliver out of the receipt; it
 * is ignored for render, whose result `parseRenderReceipt` synthesizes from
 * that path.
 */
export function buildArchifyArgs(options: BuildArchifyArgsOptions): string[] {
  const args: string[] = [options.command];

  if (options.type !== undefined) args.push(options.type);
  args.push(options.input);

  if (options.output !== undefined) args.push(options.output);
  args.push("--quality", options.quality ?? "showcase");
  if (options.repoRoot !== undefined) args.push("--repo-root", options.repoRoot);
  const wantsJson = options.json ?? true;
  if (wantsJson && ARCHIFY_JSON_COMMANDS.includes(options.command)) args.push("--json");

  return args;
}

export interface BuildArchifyGuideArgsOptions {
  scenario?: string;
  lang?: string;
  json?: boolean;
}

/**
 * Build the argv for `archify guide [scenario] [--lang <lang>] [--json]`.
 * `--json` defaults on so callers get the structured recommendation/receipt
 * that is safe to parse; pass `json: false` only for raw prose output.
 */
export function buildArchifyGuideArgs(options: BuildArchifyGuideArgsOptions): string[] {
  const args: string[] = ["guide"];
  if (options.scenario !== undefined) args.push(options.scenario);
  if (options.lang !== undefined) args.push("--lang", options.lang);
  if (options.json ?? true) args.push("--json");
  return args;
}

export interface BuildArchifyInspectArgsOptions {
  type: ArchifyDiagramType;
  input: string;
}

/** Build the argv for `archify inspect <type> <input>`. */
export function buildArchifyInspectArgs(options: BuildArchifyInspectArgsOptions): string[] {
  return ["inspect", options.type, options.input];
}

/** Build the argv for `archify check <input>`. */
export function buildArchifyCheckArgs(input: string): string[] {
  return ["check", input];
}

/** Parameters a guidance subcommand can receive from the `belayd_archify` schema. */
export type ArchifyParamName = "type" | "input" | "output" | "quality" | "repoRoot" | "scenario";

/** Canonical order for reporting supplied-but-ignored params (stable messages). */
const ARCHIFY_PARAM_ORDER: readonly ArchifyParamName[] = [
  "type",
  "input",
  "output",
  "quality",
  "repoRoot",
  "scenario",
];

export type ArchifyParamSupply = Partial<Record<ArchifyParamName, string>>;

/** Params each guidance command actually consumes; everything else is noise. */
const ARCHIFY_GUIDANCE_USED_PARAMS: Record<ArchifyGuidanceCommand, readonly ArchifyParamName[]> = {
  guide: ["scenario"],
  examples: [],
  check: ["input"],
  inspect: ["type", "input"],
};

/**
 * Names of the supplied params that `command` will not read, in canonical
 * order. A guidance invocation must never silently drop, say, `quality` or
 * `repoRoot`; the caller turns this into an explicit note.
 */
export function ignoredArchifyParams(
  command: ArchifyGuidanceCommand,
  supplied: ArchifyParamSupply,
): ArchifyParamName[] {
  const used = ARCHIFY_GUIDANCE_USED_PARAMS[command];
  return ARCHIFY_PARAM_ORDER.filter((name) => supplied[name] !== undefined && !used.includes(name));
}

/** Render the ignored-params note; empty string when nothing was ignored. */
export function formatArchifyIgnoredParamsNote(
  command: ArchifyGuidanceCommand,
  ignored: readonly ArchifyParamName[],
): string {
  if (ignored.length === 0) return "";
  const list = ignored.map((name) => `\`${name}\``).join(", ");
  return `\n\nnote: ${list} ignored for command=${command}.`;
}

/** One structured archify diagnostic (stable namespaced `code`). */
export interface ArchifyDiagnostic {
  code: string;
  severity: string;
  message: string;
  subject: Record<string, unknown> | undefined;
  evidence: Record<string, unknown> | undefined;
  supportedFixes: string[] | undefined;
}

/** Content hash + size for an input specification or rendered artifact. */
export interface ArchifySpecification {
  sha256: string;
  bytes: number;
}

export interface ArchifyArtifact {
  sha256: string;
  bytes: number;
}

/**
 * Composition validation summary. Normalized from the two upstream shapes:
 * `deliver` emits `validation:{checksPassed,checkCount,…}`, while `validate`
 * emits `checks:[{name,ok,details}]` plus `composition:{profile,status,summary}`.
 */
export interface ArchifyValidation {
  checksPassed: number;
  checkCount: number;
  compositionProfile: string | undefined;
  compositionStatus: string | undefined;
  errors: number;
  warnings: number;
}

/**
 * The `--json` receipt archify emits. Fields absent for a given command are
 * explicitly `undefined` rather than optional so callers must guard them.
 */
export interface ArchifyReceipt {
  schemaVersion: number;
  ok: boolean;
  command: string;
  type: string | undefined;
  input: string | undefined;
  output: string | undefined;
  stage: string | undefined;
  error: string | undefined;
  specification: ArchifySpecification | undefined;
  artifact: ArchifyArtifact | undefined;
  validation: ArchifyValidation | undefined;
  diagnostics: ArchifyDiagnostic[];
}

export type ArchifyReceiptParse =
  | { ok: true; receipt: ArchifyReceipt }
  | { ok: false; error: string };

export type ArchifyRunResult = { ok: true; receipt: ArchifyReceipt } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/**
 * Reduce raw child output to a single informative line. Node leaks full stack
 * traces (with store paths) for `render`, which has no `--json` diagnostics;
 * prefer an explicit `Error:` line when one is present.
 */
function firstInformativeLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return undefined;

  const first = lines[0];
  if (first === undefined) return undefined;
  return lines.find((line) => /^error[:\s]/i.test(line)) ?? first;
}

function parseDiagnostic(value: unknown): ArchifyDiagnostic | undefined {
  if (!isRecord(value)) return undefined;

  const code = readString(value, "code");
  const message = readString(value, "message");
  if (code === undefined || message === undefined) return undefined;

  const rawFixes = value.supportedFixes;
  const supportedFixes = Array.isArray(rawFixes)
    ? rawFixes.filter((fix): fix is string => typeof fix === "string")
    : undefined;

  return {
    code,
    severity: readString(value, "severity") ?? "error",
    message,
    subject: readRecord(value, "subject"),
    evidence: readRecord(value, "evidence"),
    supportedFixes,
  };
}

function parseSpecification(
  record: Record<string, unknown> | undefined,
): ArchifySpecification | undefined {
  if (record === undefined) return undefined;

  const sha256 = readString(record, "sha256");
  const bytes = readNumber(record, "bytes");
  if (sha256 === undefined || bytes === undefined) return undefined;

  return { sha256, bytes };
}

/** Count `checks:[{name,ok,…}]` entries, as emitted by `validate --json`. */
function countChecks(
  record: Record<string, unknown>,
): { passed: number; total: number } | undefined {
  const rawChecks = record.checks;
  if (!Array.isArray(rawChecks)) return undefined;

  let passed = 0;
  for (const check of rawChecks) {
    if (isRecord(check) && check.ok === true) passed += 1;
  }
  return { passed, total: rawChecks.length };
}

/** Parse the `deliver`-style `validation:{checksPassed,checkCount,…}` shape. */
function parseDeliverValidation(
  record: Record<string, unknown> | undefined,
): ArchifyValidation | undefined {
  if (record === undefined) return undefined;

  const checksPassed = readNumber(record, "checksPassed");
  const checkCount = readNumber(record, "checkCount");
  if (checksPassed === undefined || checkCount === undefined) return undefined;

  return {
    checksPassed,
    checkCount,
    compositionProfile: readString(record, "compositionProfile"),
    compositionStatus: readString(record, "compositionStatus"),
    errors: readNumber(record, "errors") ?? 0,
    warnings: readNumber(record, "warnings") ?? 0,
  };
}

/**
 * Normalize a receipt's validation section. Prefers the `deliver` shape when
 * present and otherwise derives the summary from the `validate` shape.
 */
function parseValidationSummary(record: Record<string, unknown>): ArchifyValidation | undefined {
  const direct = parseDeliverValidation(readRecord(record, "validation"));
  if (direct !== undefined) return direct;

  const counts = countChecks(record);
  const composition = readRecord(record, "composition");
  if (counts === undefined && composition === undefined) return undefined;

  const summary = composition === undefined ? undefined : readRecord(composition, "summary");
  return {
    checksPassed: counts === undefined ? 0 : counts.passed,
    checkCount: counts === undefined ? 0 : counts.total,
    compositionProfile: composition === undefined ? undefined : readString(composition, "profile"),
    compositionStatus: composition === undefined ? undefined : readString(composition, "status"),
    errors: summary === undefined ? 0 : (readNumber(summary, "errors") ?? 0),
    warnings: summary === undefined ? 0 : (readNumber(summary, "warnings") ?? 0),
  };
}

/**
 * Parse archify's `--json` stdout into a receipt.
 *
 * Tolerant of empty stdout (e.g. the process was killed before writing) and
 * of non-JSON output, and rejects JSON that lacks the boolean `ok`
 * discriminator so callers never mistake an unrelated object for a receipt.
 */
export function parseArchifyReceipt(stdout: string): ArchifyReceiptParse {
  const trimmed = stdout.trim();
  if (trimmed === "") return { ok: false, error: "archify produced no JSON output" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `archify output was not valid JSON: ${message}` };
  }

  if (!isRecord(parsed)) return { ok: false, error: "archify JSON output was not an object" };

  const ok = parsed.ok;
  if (typeof ok !== "boolean") {
    return { ok: false, error: "archify JSON output is missing a boolean `ok` field" };
  }

  const rawDiagnostics = parsed.diagnostics;
  const diagnostics = Array.isArray(rawDiagnostics)
    ? rawDiagnostics
        .map(parseDiagnostic)
        .filter((diagnostic): diagnostic is ArchifyDiagnostic => diagnostic !== undefined)
    : [];

  return {
    ok: true,
    receipt: {
      schemaVersion: readNumber(parsed, "schemaVersion") ?? 0,
      ok,
      command: readString(parsed, "command") ?? "unknown",
      type: readString(parsed, "type"),
      input: readString(parsed, "input"),
      output: readString(parsed, "output"),
      stage: readString(parsed, "stage"),
      error: readString(parsed, "error"),
      specification: parseSpecification(readRecord(parsed, "specification")),
      artifact: parseSpecification(readRecord(parsed, "artifact")),
      validation: parseValidationSummary(parsed),
      diagnostics,
    },
  };
}

/** Positional operands of a render invocation (`type` is optional). */
interface RenderPositionals {
  type: ArchifyDiagramType | undefined;
  input: string | undefined;
  output: string | undefined;
}

/** Extract render's positional operands, stopping at the first flag. */
function parseRenderPositionals(args: readonly string[]): RenderPositionals {
  const positionals: string[] = [];
  for (const token of args.slice(1)) {
    if (token.startsWith("--")) break;
    positionals.push(token);
  }

  const first = positionals[0];
  if (first !== undefined && isArchifyDiagramType(first)) {
    return { type: first, input: positionals[1], output: positionals[2] };
  }
  return { type: undefined, input: first, output: positionals[1] };
}

/**
 * Whether stdout looks like the single output path `render` prints. Rejects
 * empty/multi-line output and usage/error banners so a warning line can never
 * be mistaken for a rendered artifact. Upstream 3.x enforces a non-empty
 * `.html` CLI target (rejecting a non-.html path before rendering), but the
 * harness stays extension-agnostic here: it only checks that stdout is a
 * plausible path and separately verifies existence in `buildRunResult`, where
 * the filesystem is available. That existence check is cheap and independent
 * of the upstream validation rules.
 */
function looksLikeRenderOutputPath(value: string): boolean {
  if (value === "" || value.includes("\n") || value.includes("\r")) return false;
  return !/^(usage|error|warning|file:\/\/|node:)/i.test(value);
}

/**
 * Parse `render` output.
 *
 * Verified against archify 3.0.1: on success `render` prints exactly the
 * output path followed by a newline; it has no `--json` flag and rejects one
 * as an unknown option (exit 2). On other failures (invalid IR, missing input
 * file, unknown type, non-.html target, usage error) it prints a human
 * diagnostic to stderr and exits non-zero. Synthesize the minimal receipt the
 * formatter expects from the printed path; a structured receipt is still
 * honored if one ever appears here.
 */
function parseRenderReceipt(stdout: string, args: readonly string[]): ArchifyReceiptParse {
  const asJson = parseArchifyReceipt(stdout);
  if (asJson.ok) return asJson;

  const outputPath = stdout.trim();
  if (!looksLikeRenderOutputPath(outputPath)) {
    const firstLine = firstInformativeLine(outputPath) ?? "(empty stdout)";
    return {
      ok: false,
      error: `archify render produced unexpected stdout instead of an output path: ${firstLine}`,
    };
  }

  const { type, input } = parseRenderPositionals(args);
  return {
    ok: true,
    receipt: {
      schemaVersion: 0,
      ok: true,
      command: "render",
      type,
      input,
      output: outputPath,
      stage: undefined,
      error: undefined,
      specification: undefined,
      artifact: undefined,
      validation: undefined,
      diagnostics: [],
    },
  };
}

function formatSubject(subject: Record<string, unknown> | undefined): string {
  if (subject === undefined) return "";

  const entries = Object.entries(subject);
  if (entries.length === 0) return "";

  return entries.map(([key, value]) => `${key}=${String(value)}`).join(", ");
}

function formatArtifactSection(receipt: ArchifyReceipt): string[] {
  if (receipt.output === undefined) return [];

  const lines = [`artifact: ${receipt.output}`];
  if (receipt.artifact !== undefined) {
    lines.push(`  sha256: ${receipt.artifact.sha256} (${receipt.artifact.bytes} bytes)`);
  }
  return lines;
}

function formatValidationSection(receipt: ArchifyReceipt): string[] {
  const validation = receipt.validation;
  if (validation === undefined) return [];

  const profile =
    validation.compositionProfile === undefined ? "" : `, ${validation.compositionProfile}`;
  const status =
    validation.compositionStatus === undefined ? "" : `, ${validation.compositionStatus}`;
  return [
    `validation: ${validation.checksPassed}/${validation.checkCount} checks passed${profile}${status}`,
  ];
}

function formatDiagnosticsSection(diagnostics: readonly ArchifyDiagnostic[]): string[] {
  if (diagnostics.length === 0) return [];

  const lines = ["diagnostics:"];
  for (const diagnostic of diagnostics) {
    const subject = formatSubject(diagnostic.subject);
    const suffix = subject === "" ? "" : ` (${subject})`;
    lines.push(`  - ${diagnostic.code}: ${diagnostic.message}${suffix}`);
    for (const fix of diagnostic.supportedFixes ?? []) {
      lines.push(`      fix: ${fix}`);
    }
  }
  return lines;
}

/**
 * Render a run result as human-readable text for the tool response.
 *
 * Every optional receipt field is guarded explicitly; a receipt that omits
 * artifact/validation data still produces a useful summary.
 */
export function formatArchifyResult(result: ArchifyRunResult): string {
  if (!result.ok) return `archify: failed\n${result.error}`;

  const { receipt } = result;
  const typeSuffix = receipt.type === undefined ? "" : ` ${receipt.type}`;
  const lines: string[] = [
    `archify ${receipt.command}${typeSuffix}: ${receipt.ok ? "ok" : "failed"}`,
  ];

  if (receipt.stage !== undefined) lines.push(`stage: ${receipt.stage}`);
  if (receipt.error !== undefined) lines.push(`error: ${receipt.error}`);

  lines.push(...formatArtifactSection(receipt));
  lines.push(...formatValidationSection(receipt));
  lines.push(...formatDiagnosticsSection(receipt.diagnostics));

  return lines.join("\n");
}

export interface RunArchifyOptions {
  cwd: string;
  timeoutInMs: number;
  maxBufferInBytes: number;
}

type ArchifyExecError = Error & {
  killed?: boolean;
  signal?: string | null;
  code?: string | number;
};

/** Narrow a caught exec error to the fields Node attaches to it. */
function isArchifyExecError(value: unknown): value is ArchifyExecError {
  return value instanceof Error;
}

/**
 * Describe an exec-level interruption (kill, signal, or buffer overflow) that
 * must not be mistaken for a successful run even when stdout parses.
 */
function describeExecFailure(error: unknown): string | undefined {
  if (!isArchifyExecError(error)) return undefined;

  if (error.killed === true) {
    return "archify was killed before completing (timeout or signal)";
  }
  if (typeof error.signal === "string" && error.signal !== "") {
    return `archify was terminated by signal ${error.signal}`;
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "archify output exceeded the configured buffer limit";
  }
  return undefined;
}

/** Build a failure result, preferring a single informative stderr line. */
function failureResult(primary: string, stderr: string, error: unknown): ArchifyRunResult {
  const fromStderr = firstInformativeLine(stderr);
  const fromError = error instanceof Error ? firstInformativeLine(error.message) : undefined;
  const detail = fromStderr ?? fromError;
  return { ok: false, error: detail === undefined ? primary : `${primary}: ${detail}` };
}

/**
 * Reduce one exec outcome to a run result. Kept separate from the execFile
 * callback so the callback stays a single call.
 */
function buildRunResult(
  args: readonly string[],
  error: unknown,
  stdout: string,
  stderr: string,
  cwd: string,
): ArchifyRunResult {
  const command = args[0];
  const parsed =
    command === "render" ? parseRenderReceipt(stdout, args) : parseArchifyReceipt(stdout);
  const interruption = describeExecFailure(error);

  // A kill/timeout/buffer overflow is authoritative over any partial stdout,
  // including a structured ok:false receipt that may have been truncated.
  if (interruption !== undefined) return failureResult(interruption, stderr, error);

  // A structured receipt (ok:true or ok:false) is authoritative even when the
  // process exits non-zero.
  if (parsed.ok) {
    // `render` has no structured receipt, so its output path is only a claim.
    // Confirm the file exists before reporting success: stdout banners or a
    // future format change must not be mistaken for a rendered artifact.
    const renderedPath = parsed.receipt.output;
    if (
      parsed.receipt.command === "render" &&
      renderedPath !== undefined &&
      !existsSync(resolvePath(cwd, renderedPath))
    ) {
      return {
        ok: false,
        error: `archify render reported output ${renderedPath} but no file exists at that path`,
      };
    }
    return { ok: true, receipt: parsed.receipt };
  }

  return failureResult(parsed.error, stderr, error);
}

/**
 * Execute the archify CLI (argv as built by `buildArchifyArgs`) and parse its
 * output.
 *
 * A non-zero exit is not treated as a failure on its own: archify emits a
 * structured `ok: false` receipt for validation failures, so stdout is parsed
 * regardless of exit code. Kills/timeouts/buffer overflows are always
 * failures, even if the truncated stdout happens to parse.
 */
export function runArchify(
  args: readonly string[],
  options: RunArchifyOptions,
): Promise<ArchifyRunResult> {
  return new Promise((resolve) => {
    execFile(
      "archify",
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutInMs,
        maxBuffer: options.maxBufferInBytes,
        encoding: "utf-8",
        env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: "1" },
      },
      (error, stdout, stderr) => resolve(buildRunResult(args, error, stdout, stderr, options.cwd)),
    );
  });
}

/** Result of a read-only guidance invocation that emits human/JSON text. */
export type ArchifyTextResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Reduce one exec outcome for a text-emitting subcommand. Unlike
 * `runArchify`, there is no structured receipt to parse: a clean exit means
 * the stdout is the answer, and a non-zero exit prefers stdout (some
 * diagnostics still print JSON there) over stderr over the exec error.
 */
function buildTextResult(error: unknown, stdout: string, stderr: string): ArchifyTextResult {
  const interruption = describeExecFailure(error);
  if (interruption !== undefined) return { ok: false, error: interruption };

  const trimmed = stdout.trim();
  if (error === null || error === undefined) {
    return { ok: true, text: trimmed === "" ? "(no output)" : trimmed };
  }
  if (trimmed !== "") return { ok: false, error: trimmed };

  const fromStderr = firstInformativeLine(stderr);
  if (fromStderr !== undefined) return { ok: false, error: fromStderr };
  const fromError = error instanceof Error ? firstInformativeLine(error.message) : undefined;
  return { ok: false, error: fromError ?? "archify command failed" };
}

/**
 * Execute a read-only guidance subcommand (`guide`/`inspect`/`check`) and
 * return its text output. Uses the same exec shape and offline-safe env as
 * `runArchify` so kills/timeouts/buffer overflows are handled identically.
 */
export function runArchifyText(
  args: readonly string[],
  options: RunArchifyOptions,
): Promise<ArchifyTextResult> {
  return new Promise((resolve) => {
    execFile(
      "archify",
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutInMs,
        maxBuffer: options.maxBufferInBytes,
        encoding: "utf-8",
        env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: "1" },
      },
      (error, stdout, stderr) => resolve(buildTextResult(error, stdout, stderr)),
    );
  });
}

export type ArchifyHomeResult = { ok: true; home: string } | { ok: false; error: string };

/**
 * Resolve `$ARCHIFY_HOME`, the stable path to the pinned package's agent
 * assets. The wrapper, the devShell shellHook, and the pi-web runtime env all
 * export it, so a spawned session inherits it without filesystem spelunking.
 */
export function resolveArchifyHome(env: Record<string, string | undefined>): ArchifyHomeResult {
  const home = env.ARCHIFY_HOME;
  if (home === undefined || home.trim() === "") {
    return {
      ok: false,
      error:
        "ARCHIFY_HOME is not set. It is exported by the archify wrapper and by the devShell / pi-web runtime env; run `nix develop` or use a harness-provided shell.",
    };
  }
  return { ok: true, home };
}

export type ArchifyExamplesResult = { ok: true; examples: string[] } | { ok: false; error: string };

/**
 * List the packaged example IR files under `<home>/examples`.
 *
 * This intentionally reads the directory instead of shelling out to
 * `archify examples`: that subcommand renders HTML into the (read-only) Nix
 * store at `$ARCHIFY_HOME/examples/`, so it fails at runtime. Listing the
 * packaged `*.json` IRs is the correct read-only behavior.
 */
export function listArchifyExamples(home: string): ArchifyExamplesResult {
  const examplesDir = joinPath(home, "examples");
  let entries: string[];
  try {
    entries = readdirSync(examplesDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `could not read archify examples at ${examplesDir}: ${message}` };
  }

  const examples = entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => joinPath(examplesDir, entry))
    .sort();
  return { ok: true, examples };
}
