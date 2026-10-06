/**
 * `/bootstrap` pi extension — scaffold a new pnpm + turbo repo in place.
 *
 * The command writes a self-contained monorepo skeleton (flakes, pnpm, turbo,
 * biome, lefthook, vitest, harness wiring, beads wiring) into the current
 * directory. The directory must be empty (or hold only `.git`), or be a
 * resumable `/bootstrap` scaffold from an earlier failed run. It then runs the
 * mechanical setup steps (`git init`, `git add -A`, `nix flake lock`, `direnv allow`,
 * `pnpm install`, `lefthook install`, `bd init`) and hands the prose work off
 * to the agent with a `belayd-bootstrap` message.
 *
 * Only the identifier tokens `__PROJECT_NAME__` / `__PACKAGE_SCOPE__` are
 * substituted by the script. The prose tokens (`__PROJECT_DESCRIPTION__`,
 * `__PROJECT_ONELINER__`) are deliberately left for the agent: they need human
 * judgement, and npm would reject an uppercase `@__PACKAGE_SCOPE__/core` if the
 * substitution were deferred past `pnpm install`.
 *
 * Design: pure helpers first (unit-tested in `src/__tests__`), then I/O steps.
 * Every step returns a discriminated `StepResult`; the handler aborts on the
 * first failure and reports which step failed plus the exact commands still
 * left to run. The scaffold is left in place, and a re-run overwrites the
 * template files and skips the steps whose on-disk artifacts already exist, so
 * a network failure (e.g. `nix flake lock`) can be resumed instead of starting
 * over.
 */

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { claimRegistrationOnce } from "../src/claim-registry.js";

// ── Result types ──────────────────────────────────────────────────────

/** Outcome of one bootstrap step. Errors are values, never exceptions. */
export type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Identifier tokens substituted by the scripted bootstrap. */
export interface BootstrapTokens {
  projectName: string;
  packageScope: string;
}

/** What the scripted steps produced, used for the handoff and summary. */
export interface BootstrapReport {
  projectName: string;
  packageScope: string;
  templateFiles: readonly string[];
  substitutedFiles: readonly string[];
  commands: readonly string[];
}

/** The possible relationships a target directory can have to a scaffold. */
export const TARGET_DIR_KINDS = {
  empty: "empty",
  resumable: "resumable",
  notEmpty: "not-empty",
  unknownEntries: "unknown-entries",
} as const;

/** String-literal union derived from `TARGET_DIR_KINDS`. */
export type TargetDirKind = (typeof TARGET_DIR_KINDS)[keyof typeof TARGET_DIR_KINDS];

/**
 * How the target directory relates to a (possibly partial) scaffold. Each
 * `kind` is derived from `TARGET_DIR_KINDS` so the classifier's return sites
 * and the `checkPreconditions` comparisons cannot drift from the type.
 */
export type TargetDirState =
  | { kind: typeof TARGET_DIR_KINDS.empty }
  | { kind: typeof TARGET_DIR_KINDS.resumable }
  | { kind: typeof TARGET_DIR_KINDS.notEmpty; unknownEntries: readonly string[] }
  | { kind: typeof TARGET_DIR_KINDS.unknownEntries; unknownEntries: readonly string[] };

/**
 * Top-level entries a scaffold can leave behind that are not template files:
 * `git`, dependency, Nix, build, and beads artifacts. Anything outside both
 * this set and the template tree means the directory is not ours to overwrite.
 */
export const GENERATED_TOP_LEVEL_ENTRIES: readonly string[] = [
  ".git",
  ".direnv",
  ".turbo",
  ".beads",
  ".beads.bak",
  ".pnpm-store",
  "node_modules",
  "flake.lock",
  "pnpm-lock.yaml",
  "result",
  "dist",
  "coverage",
];

// ── Pure helpers ──────────────────────────────────────────────────────

/**
 * Normalize a directory name into a package-safe identifier.
 *
 * npm forbids uppercase and most punctuation in package names, so this
 * lowercases, maps every disallowed run to a single dash, and trims the
 * leading/trailing separators that would make an invalid package name (npm
 * rejects names beginning with `.` or `_`).
 */
export function sanitizeProjectName(rawDirName: string): string {
  const lowered = rawDirName.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9._-]+/g, "-");
  const collapsed = replaced.replace(/-{2,}/g, "-");
  const trimmed = collapsed.replace(/^[-._]+/, "").replace(/[-._]+$/, "");
  return trimmed === "" ? "app" : trimmed;
}

/** Replace the mechanical identifier tokens; prose tokens are left for the agent. */
export function substituteIdentifierTokens(content: string, tokens: BootstrapTokens): string {
  return content
    .replaceAll("__PROJECT_NAME__", tokens.projectName)
    .replaceAll("__PACKAGE_SCOPE__", tokens.packageScope);
}

/** True when a directory holds nothing but an optional `.git` entry. */
export function hasOnlyGitEntry(entries: readonly string[]): boolean {
  return entries.every((entry) => entry === ".git");
}

/**
 * Entries that mark a directory as a `/bootstrap` scaffold rather than an
 * unrelated repo that merely happens to contain known-named files. These are
 * copied early and are not generic enough (unlike `package.json` or
 * `README.md`) to collide with a normal project by accident.
 *
 * `flake.nix` and `.pi` are deliberately excluded: `nix flake init` produces
 * the former, and any pi-aware repo the latter, so either alone would
 * misclassify a real project as resumable and let `/bootstrap` clobber it.
 */
const SCAFFOLD_SIGNATURE_ENTRIES: readonly string[] = [
  ".config",
  "turbo.json",
  "pnpm-workspace.yaml",
  "lefthook.yml",
];

/**
 * Number of distinct signature entries a directory must show to count as ours.
 * Two rather than one so a stray `.config/` (or `turbo.json`) alone does not
 * qualify; a complete or near-complete scaffold always shows several.
 */
const SCAFFOLD_SIGNATURE_THRESHOLD = 2;

/**
 * Classify the target directory against the template tree.
 *
 * A fresh run needs an empty directory. A re-run needs a directory that is
 * recognisably *our* scaffold: empty/`.git`-only, or carrying at least two
 * scaffold-signature entries with every entry drawn from the template tree or
 * the generated artifact set. The signature check stops a plain user repo that
 * happens to contain e.g. a `package.json` from being treated as resumable and
 * overwritten.
 */
export function classifyTargetDir(
  entries: readonly string[],
  templateEntries: readonly string[],
  generatedEntries: readonly string[],
): TargetDirState {
  if (hasOnlyGitEntry(entries)) return { kind: TARGET_DIR_KINDS.empty };

  const signatureCount = SCAFFOLD_SIGNATURE_ENTRIES.filter((marker) =>
    entries.includes(marker),
  ).length;
  if (signatureCount < SCAFFOLD_SIGNATURE_THRESHOLD) {
    return {
      kind: TARGET_DIR_KINDS.notEmpty,
      unknownEntries: entries.filter((entry) => entry !== ".git"),
    };
  }

  const known = new Set<string>([".git", ...templateEntries, ...generatedEntries]);
  const unknownEntries = entries.filter((entry) => !known.has(entry));
  if (unknownEntries.length > 0) {
    return { kind: TARGET_DIR_KINDS.unknownEntries, unknownEntries };
  }
  return { kind: TARGET_DIR_KINDS.resumable };
}

/** Return the subset of tools that no PATH directory provides as an executable. */
export function findMissingTools(
  tools: readonly string[],
  pathValue: string,
  isExecutable: (candidate: string) => boolean,
): string[] {
  const dirs = pathValue.split(":").filter((dir) => dir !== "");
  return tools.filter((tool) => !dirs.some((dir) => isExecutable(join(dir, tool))));
}

/** Agent-owned portion of the scaffold, described as actionable steps. */
export function buildHandoffMessage(report: BootstrapReport): string {
  return [
    `The \`/bootstrap\` scaffold for \`${report.projectName}\` is written and installed.`,
    "",
    "Complete the agent-owned work, then report which parts were scripted vs. decided:",
    "",
    "1. Replace the remaining prose placeholders: `__PROJECT_DESCRIPTION__` in README.md and `__PROJECT_ONELINER__` in AGENTS.md.",
    "2. Fill the AGENTS.md project sections: the Technology Stack table, the Project Structure tree, and the Documentation Map.",
    "3. Rename/extend `packages/core` (and the `pnpm-workspace.yaml` globs) if the project needs more packages.",
    "4. Confirm `pnpm turbo run build typecheck lint test` is green.",
    "5. Create the initial commit (never commit secrets or `.env` files).",
    "",
    `Scripted steps already ran: ${report.commands.join(", ")}.`,
  ].join("\n");
}

/** One-line summary for `ctx.ui.notify`, listing the written files. */
export function buildSummary(report: BootstrapReport): string {
  return [
    `Scaffolded ${report.projectName}: ${report.templateFiles.length} template files`,
    `(${report.substitutedFiles.length} with substituted identifiers): ${report.templateFiles.join(", ")}.`,
    `Scripted: ${report.commands.join(", ")}.`,
    "Agent-owned: prose placeholders, AGENTS.md project sections, package layout, initial commit.",
  ].join(" ");
}

// ── Side-effecting helpers ────────────────────────────────────────────

/**
 * Tools the flow must have on the *host* PATH before it can write anything.
 *
 * `nix` locks and enters the new flake, `git` inits and stages the scaffold
 * (Nix refuses to evaluate untracked files, so staging must precede
 * `nix flake lock`), and `direnv` approves the generated `.envrc`. None of the
 * three is provided by the scaffold's own devShell in time to be useful, so
 * they cannot be self-provisioned the way `pnpm`/`bd`/`node` are.
 */
export const REQUIRED_TOOL_NAMES = ["nix", "git", "direnv"] as const;

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const FLAKE_TIMEOUT_MS = 15 * 60_000;
const DIRENV_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * The mechanical steps in order, each with a stable id and the command line
 * shown to the user. Step execution and the "remaining commands" report both
 * read from this list, so a command label cannot drift from the step that runs
 * it. `git init`, `nix flake lock`, `pnpm install`, and the lefthook install
 * are skipped when their on-disk artifact already exists; `git add -A` and
 * `bd init --init-if-missing` are idempotent and always run. `git add -A` in
 * particular must not be skipped on `.git`'s existence: `nix flake lock`
 * refuses to evaluate files that Git does not track, so a resume after a
 * flake-lock failure has to re-stage the scaffold before retrying.
 */
export const STEP_DEFINITIONS = [
  { id: "git-init", command: "git init" },
  { id: "git-add", command: "git add -A" },
  { id: "flake-lock", command: "nix flake lock" },
  { id: "direnv-allow", command: "direnv allow" },
  { id: "pnpm-install", command: "pnpm install" },
  { id: "lefthook-install", command: "./node_modules/.bin/lefthook install" },
  {
    id: "bd-init",
    command: "bd init --shared-server --external --non-interactive --init-if-missing",
  },
  { id: "bd-config-auto-start", command: "bd config set dolt.auto-start false" },
  { id: "bd-prime", command: "bd prime" },
] as const satisfies readonly { id: string; command: string }[];

/** Union of the step ids, so an unknown id is a compile error. */
export type BootstrapStepId = (typeof STEP_DEFINITIONS)[number]["id"];

/** All step ids in execution order. */
const STEP_IDS: readonly BootstrapStepId[] = STEP_DEFINITIONS.map((step) => step.id);

/** Command line for a step id, used for both the report and the remaining list. */
function stepCommand(stepId: BootstrapStepId): string {
  for (const step of STEP_DEFINITIONS) {
    if (step.id === stepId) return step.command;
  }
  return stepId;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutInMs: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `candidate` is an executable regular file on disk. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(options: RunCommandOptions): Promise<StepResult<CommandResult>> {
  return new Promise((resolvePromise) => {
    execFile(
      options.file,
      [...options.args],
      {
        cwd: options.cwd,
        timeout: options.timeoutInMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() !== "" ? stderr.trim() : error.message;
          resolvePromise({
            ok: false,
            error: `\`${options.file} ${options.args.join(" ")}\` failed: ${detail}`,
          });
          return;
        }
        resolvePromise({ ok: true, value: { stdout, stderr } });
      },
    );
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Recursive list of regular files under `root`, as absolute paths. */
async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
      continue;
    }
    if (entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * Absolute paths of symlinks under `root`.
 *
 * `listFilesRecursive` skips symlinks while `cp` follows them, so a symlinked
 * template entry would be copied without ever being token-substituted — and
 * could point outside the template tree. Reject rather than copy.
 */
async function findSymlinks(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const links: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      links.push(full);
      continue;
    }
    if (entry.isDirectory()) links.push(...(await findSymlinks(full)));
  }
  return links;
}

interface CopyResult {
  /** Absolute paths of the template files, in copy order. */
  files: string[];
}

/**
 * True when `path` holds any `bd`-injected managed AGENTS.md block.
 *
 * Matching the shared `BEGIN BEADS ` prefix covers the current managed blocks
 * (`INTEGRATION`, `CODEX SETUP`, …); the legacy `BEADS GUIDELINES START`
 * marker is kept as a fallback for older bd versions. A re-run must preserve
 * them all instead of the two markers that existed when this was written.
 */
export async function hasBeadsManagedBlock(path: string): Promise<boolean> {
  try {
    const content = await readFile(path, "utf-8");
    return content.includes("BEGIN BEADS ") || content.includes("BEADS GUIDELINES START");
  } catch {
    return false;
  }
}

/**
 * Copy the template tree into the target, overwriting existing template files.
 *
 * Overwriting (rather than `errorOnExist`) is what makes a re-run after a
 * failed step resumable: the copy step is the first to run, so it must not
 * dead-end on the files the previous attempt left behind. `AGENTS.md` is the
 * exception once `bd init` has injected its managed blocks into it: a re-run
 * skips `bd init`, so overwriting would silently drop those blocks. A plain
 * (not-yet-injected) `AGENTS.md` is still overwritten, so a partially copied
 * one is repaired.
 */
export async function copyTemplateTree(
  templateDir: string,
  targetDir: string,
): Promise<StepResult<CopyResult>> {
  try {
    const symlinks = await findSymlinks(templateDir);
    if (symlinks.length > 0) {
      return {
        ok: false,
        error: `template contains symlinks (refusing to copy): ${symlinks.join(", ")}`,
      };
    }

    const topLevel = await readdir(templateDir, { withFileTypes: true });
    for (const entry of topLevel) {
      const target = join(targetDir, entry.name);
      if (entry.name === "AGENTS.md" && (await hasBeadsManagedBlock(target))) continue;
      await cp(join(templateDir, entry.name), target, {
        recursive: true,
        errorOnExist: false,
        force: true,
      });
    }
    const files = await listFilesRecursive(templateDir);
    return { ok: true, value: { files } };
  } catch (error) {
    return { ok: false, error: `copying templates failed: ${errorMessage(error)}` };
  }
}

/**
 * Replace identifier tokens in the copied template files only, writing each
 * substituted copy to its mirrored path under `targetDir`.
 *
 * Restricting to the known template file list matters on a re-run: walking the
 * whole target would descend into `node_modules` (and `.beads`, `dist`, …),
 * reading and rewriting generated files as text.
 */
export async function substituteTree(
  templateDir: string,
  targetDir: string,
  files: readonly string[],
  tokens: BootstrapTokens,
): Promise<StepResult<string[]>> {
  try {
    const changed: string[] = [];
    for (const file of files) {
      // `files` holds absolute *template* paths; read them, but write the
      // substituted copy to the mirrored target path. Writing back to `file`
      // would mutate the shared template tree (EROFS in the Nix store) and
      // leave the target un-substituted.
      const target = join(targetDir, relative(templateDir, file));
      // Mirror `copyTemplateTree`'s preservation of a bd-injected AGENTS.md: a
      // skipped copy must not be overwritten here either.
      if (await hasBeadsManagedBlock(target)) continue;
      const content = await readFile(file, "utf-8");
      const substituted = substituteIdentifierTokens(content, tokens);
      if (substituted === content) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, substituted);
      changed.push(relative(targetDir, target));
    }
    return { ok: true, value: changed };
  } catch (error) {
    return { ok: false, error: `substituting tokens failed: ${errorMessage(error)}` };
  }
}

async function checkPreconditions(
  cwd: string,
  templateDir: string,
): Promise<StepResult<{ templateDir: string }>> {
  try {
    if (!(await stat(templateDir)).isDirectory()) {
      return { ok: false, error: `template path is not a directory: ${templateDir}` };
    }
  } catch {
    return { ok: false, error: `template directory not found: ${templateDir}` };
  }

  let entries: string[];
  let templateEntries: string[];
  try {
    entries = await readdir(cwd);
    templateEntries = await readdir(templateDir);
  } catch (error) {
    return { ok: false, error: `reading the target directory failed: ${errorMessage(error)}` };
  }

  const state = classifyTargetDir(entries, templateEntries, GENERATED_TOP_LEVEL_ENTRIES);
  if (state.kind === TARGET_DIR_KINDS.notEmpty) {
    return {
      ok: false,
      error: `${cwd} is not empty (found: ${state.unknownEntries.join(", ")}). /bootstrap needs an empty directory or a resumable scaffold.`,
    };
  }
  if (state.kind === TARGET_DIR_KINDS.unknownEntries) {
    return {
      ok: false,
      error: `${cwd} contains entries /bootstrap did not write (${state.unknownEntries.join(", ")}). Refusing to overwrite them.`,
    };
  }

  const missing = findMissingTools(REQUIRED_TOOL_NAMES, process.env.PATH ?? "", isExecutableFile);
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `missing tools on PATH: ${missing.join(", ")}. ` +
        `/bootstrap needs nix, git, and direnv on the host PATH; ` +
        "pnpm and bd come from the scaffold's own devShell and are self-provisioned.",
    };
  }

  return { ok: true, value: { templateDir } };
}

interface ScriptedStepInput {
  cwd: string;
  templateDir: string;
  projectName: string;
  packageScope: string;
}

/** Failure half of `StepResult`, used to abort the scripted sequence. */
interface StepFailure {
  ok: false;
  error: string;
}

interface StepControls {
  cwd: string;
  markDone: (stepId: BootstrapStepId) => void;
  markSkipped: (stepId: BootstrapStepId) => void;
  fail: (error: string) => StepFailure;
}

interface StepRun {
  controls: StepControls;
  stepId: BootstrapStepId;
  file: string;
  args: readonly string[];
  timeoutInMs: number;
  /**
   * Tools whose absence routes the step through the scaffold's own devShell
   * (`nix develop <cwd> -c …`). Omit for host tools the precondition
   * guarantees (`git`, `nix`, `direnv`). `node` is named for the lefthook
   * step because the local `node_modules/.bin/lefthook` shebang needs it;
   * `bd`/`dolt` are paired because `bd` shells out to `dolt` for SQL.
   */
  devShellTools?: readonly string[];
}

/** A command line after host PATH / scaffold-devShell resolution. */
export interface ResolvedCommand {
  file: string;
  args: string[];
  viaDevShell: boolean;
}

/**
 * Resolve a command to its executable argv.
 *
 * When `devShellTools` is given and any of them is missing from the host PATH,
 * the command runs as `nix develop <cwd> -c <file> <args…>`: the scaffold was
 * copied before any devShell-provided step runs, so its flake already supplies
 * pnpm/node/bd/dolt. This is what removes the old requirement that pi itself
 * be launched from the harness devShell just to get `bd` on PATH.
 */
export function resolveCommand(input: {
  file: string;
  args: readonly string[];
  cwd: string;
  devShellTools?: readonly string[];
  pathValue: string;
  isExecutable: (candidate: string) => boolean;
}): ResolvedCommand {
  const tools = input.devShellTools ?? [];
  if (
    tools.length === 0 ||
    findMissingTools(tools, input.pathValue, input.isExecutable).length === 0
  ) {
    return { file: input.file, args: [...input.args], viaDevShell: false };
  }
  return {
    file: "nix",
    args: ["develop", input.cwd, "-c", input.file, ...input.args],
    viaDevShell: true,
  };
}

/** Resolve using the live process PATH and filesystem (the impure wrapper). */
function resolveStepCommand(run: StepRun): ResolvedCommand {
  return resolveCommand({
    file: run.file,
    args: run.args,
    cwd: run.controls.cwd,
    devShellTools: run.devShellTools,
    pathValue: process.env.PATH ?? "",
    isExecutable: isExecutableFile,
  });
}

interface SkippableStepRun extends StepRun {
  artifactExists: () => Promise<boolean>;
}

/** Run an idempotent command unconditionally, recording it on success. */
async function invokeStep(run: StepRun): Promise<StepFailure | null> {
  const command = resolveStepCommand(run);
  const result = await runCommand({
    file: command.file,
    args: command.args,
    cwd: run.controls.cwd,
    timeoutInMs: run.timeoutInMs,
  });
  if (!result.ok) return run.controls.fail(result.error);
  run.controls.markDone(run.stepId);
  return null;
}

/** Run a command whose artifact may already exist; skip it instead of failing. */
async function runStepOrSkip(run: SkippableStepRun): Promise<StepFailure | null> {
  if (await run.artifactExists()) {
    run.controls.markSkipped(run.stepId);
    return null;
  }
  return invokeStep(run);
}

/** Run the mechanical steps in order; stop at the first failure. */
async function runScriptedSteps(input: ScriptedStepInput): Promise<StepResult<BootstrapReport>> {
  const tokens: BootstrapTokens = {
    projectName: input.projectName,
    packageScope: input.packageScope,
  };
  const commands: string[] = [];
  const remaining = new Set<BootstrapStepId>(STEP_IDS);
  const controls: StepControls = {
    cwd: input.cwd,
    markDone: (stepId) => {
      commands.push(stepCommand(stepId));
      remaining.delete(stepId);
    },
    markSkipped: (stepId) => remaining.delete(stepId),
    fail: (error) => {
      const pending =
        remaining.size > 0
          ? STEP_IDS.filter((stepId) => remaining.has(stepId)).map(stepCommand)
          : ["(none)"];
      const manual = pending.map((command) => `  ${command}`).join("\n");
      return {
        ok: false,
        error: `${error}\n\nFinish the remaining steps manually from ${input.cwd}:\n${manual}`,
      };
    },
  };

  const copied = await copyTemplateTree(input.templateDir, input.cwd);
  if (!copied.ok) return controls.fail(copied.error);

  const substituted = await substituteTree(
    input.templateDir,
    input.cwd,
    copied.value.files,
    tokens,
  );
  if (!substituted.ok) return controls.fail(substituted.error);

  const gitFailure = await runStepOrSkip({
    controls,
    stepId: "git-init",
    artifactExists: () => pathExists(join(input.cwd, ".git")),
    file: "git",
    args: ["init"],
    timeoutInMs: DEFAULT_TIMEOUT_MS,
  });
  if (gitFailure) return gitFailure;

  // Stage the scaffold before locking. `nix flake lock` evaluates the flake
  // through Git and errors on any file it cannot see as tracked, so without
  // this an untouched `git init` state makes every fresh run abort. The step is
  // idempotent, so it runs unconditionally (including on resume after a
  // flake-lock failure, when `.git` already exists but nothing is staged).
  const gitAddFailure = await invokeStep({
    controls,
    stepId: "git-add",
    file: "git",
    args: ["add", "-A"],
    timeoutInMs: DEFAULT_TIMEOUT_MS,
  });
  if (gitAddFailure) return gitAddFailure;

  const flakeFailure = await runStepOrSkip({
    controls,
    stepId: "flake-lock",
    artifactExists: () => pathExists(join(input.cwd, "flake.lock")),
    file: "nix",
    args: ["flake", "lock"],
    timeoutInMs: FLAKE_TIMEOUT_MS,
  });
  if (flakeFailure) return flakeFailure;

  const direnvFailure = await invokeStep({
    controls,
    stepId: "direnv-allow",
    file: "direnv",
    args: ["allow"],
    timeoutInMs: DIRENV_TIMEOUT_MS,
  });
  if (direnvFailure) return direnvFailure;

  const installFailure = await runStepOrSkip({
    controls,
    stepId: "pnpm-install",
    artifactExists: () => pathExists(join(input.cwd, "node_modules")),
    file: "pnpm",
    args: ["install"],
    timeoutInMs: INSTALL_TIMEOUT_MS,
    devShellTools: ["pnpm"],
  });
  if (installFailure) return installFailure;

  const lefthookFailure = await runStepOrSkip({
    controls,
    stepId: "lefthook-install",
    artifactExists: () => pathExists(join(input.cwd, ".git", "hooks", "pre-commit")),
    file: join(input.cwd, "node_modules", ".bin", "lefthook"),
    args: ["install"],
    timeoutInMs: DEFAULT_TIMEOUT_MS,
    devShellTools: ["node"],
  });
  if (lefthookFailure) return lefthookFailure;

  // `bd init --shared-server --external` joins the already-running shared Dolt
  // server and writes `dolt.shared-server: true` plus `dolt_mode: server` into
  // the workspace metadata. A plain `bd init` produces an embedded database,
  // and setting `dolt.shared-server` afterwards leaves metadata pinned to
  // "embedded", so subsequent `bd` commands cannot open the shared database.
  // `--init-if-missing` makes a re-run a no-op instead of failing.
  const bdInitFailure = await invokeStep({
    controls,
    stepId: "bd-init",
    file: "bd",
    args: ["init", "--shared-server", "--external", "--non-interactive", "--init-if-missing"],
    timeoutInMs: DEFAULT_TIMEOUT_MS,
    devShellTools: ["bd", "dolt"],
  });
  if (bdInitFailure) return bdInitFailure;

  const bdSetFailure = await invokeStep({
    controls,
    stepId: "bd-config-auto-start",
    file: "bd",
    args: ["config", "set", "dolt.auto-start", "false"],
    timeoutInMs: DEFAULT_TIMEOUT_MS,
    devShellTools: ["bd", "dolt"],
  });
  if (bdSetFailure) return bdSetFailure;

  // `bd config set` stores the value in config.yaml; verify it landed as the
  // boolean `false` (bd 1.2.2 does) rather than silently ignoring the key.
  const bdProbe = resolveCommand({
    file: "bd",
    args: ["config", "get", "dolt.auto-start"],
    cwd: input.cwd,
    devShellTools: ["bd", "dolt"],
    pathValue: process.env.PATH ?? "",
    isExecutable: isExecutableFile,
  });
  const bdAutoStartCheck = await runCommand({
    file: bdProbe.file,
    args: bdProbe.args,
    cwd: input.cwd,
    timeoutInMs: DEFAULT_TIMEOUT_MS,
  });
  if (!bdAutoStartCheck.ok) return controls.fail(bdAutoStartCheck.error);
  const autoStartValue = bdAutoStartCheck.value.stdout.trim();
  if (autoStartValue !== "false") {
    return controls.fail(
      `bd config get dolt.auto-start returned "${autoStartValue}" (expected "false"). ` +
        "Set `dolt.auto-start: false` in .beads/config.yaml manually.",
    );
  }

  const bdPrimeFailure = await invokeStep({
    controls,
    stepId: "bd-prime",
    file: "bd",
    args: ["prime"],
    timeoutInMs: DEFAULT_TIMEOUT_MS,
    devShellTools: ["bd", "dolt"],
  });
  if (bdPrimeFailure) return bdPrimeFailure;

  return {
    ok: true,
    value: {
      projectName: input.projectName,
      packageScope: input.packageScope,
      templateFiles: copied.value.files.map((file) => file.slice(input.templateDir.length + 1)),
      substitutedFiles: substituted.value,
      commands,
    },
  };
}

/** Resolve the template tree relative to this module (dev checkout or Nix store). */
export function resolveTemplateDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates", "bootstrap");
}

async function handleBootstrap(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const templateDir = resolveTemplateDir();
  const projectName = sanitizeProjectName(basename(ctx.cwd));

  const preconditions = await checkPreconditions(ctx.cwd, templateDir);
  if (!preconditions.ok) {
    ctx.ui.notify(`/bootstrap aborted: ${preconditions.error}`, "error");
    return;
  }

  const result = await runScriptedSteps({
    cwd: ctx.cwd,
    templateDir,
    projectName,
    packageScope: projectName,
  });
  if (!result.ok) {
    ctx.ui.notify(
      `/bootstrap failed: ${result.error}\n\nThe scaffold is left in place; re-run /bootstrap to resume.`,
      "error",
    );
    return;
  }

  pi.sendMessage(
    { customType: "belayd-bootstrap", content: buildHandoffMessage(result.value), display: true },
    { triggerTurn: true },
  );
  ctx.ui.notify(buildSummary(result.value), "info");
}

// ── Extension factory ─────────────────────────────────────────────────

// The extension ships in up to three places (Nix store, `.pi/settings.json`,
// and an explicit `-e` in `bin/pi`). Registering `/bootstrap` more than once in
// one load batch would surface a suffixed `bootstrap:2` command, so the first
// copy claims the shared event bus and later copies yield. The dedup mechanism
// and its correctness rationale live in `src/claim-registry.ts` so it stays in
// sync with the main harness extension, which uses the same helper.
const CLAIM_CHANNEL = "__belayd_bootstrap_claim__";

export default function bootstrapExtension(pi: ExtensionAPI): void {
  if (!claimRegistrationOnce(pi, CLAIM_CHANNEL)) return;

  pi.registerCommand("bootstrap", {
    description:
      "Scaffold a new pnpm + turbo repo (flake, harness, beads) in the current empty directory.",
    handler: async (_args, ctx) => {
      await handleBootstrap(pi, ctx);
    },
  });
}
