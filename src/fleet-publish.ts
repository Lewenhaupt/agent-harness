/**
 * Fleet publish contract (bd-174.1): what happens to a fleet's merged work.
 *
 * `mode:"local"` is the default and stays deliberately inert — it resolves no
 * remote, runs no command, and touches no network. A later milestone (`bd-174.3`)
 * reads the *frozen* value recorded in `fleet.json` to drive PR/push publishing,
 * so this module owns only the schema and the pure resolution of flag → repo
 * config → git config → local default.
 *
 * The one side effect here is {@link readFleetPublishConfig}; it takes injected
 * filesystem and git-exec seams (the `defaultGitExec` pattern) so tests assert the
 * precedence without a real repository.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { GitExec } from "./stack-rebase.js";
import { defaultGitExec } from "./stack-rebase.js";

/** Publish modes, in the order the flag surface documents them. */
export const FLEET_PUBLISH_MODES = ["local", "pr", "push"] as const;

/**
 * Stack compositions a `pr` publish may use.
 *
 * `per-chain` is the only supported composition: each dependency chain becomes
 * its own stacked PR. `per-fleet` is an explicit non-goal, so it is rejected here
 * rather than silently accepted by a later writer.
 */
export const FLEET_PUBLISH_STACK_COMPOSITIONS = ["per-chain"] as const;

/** Publish mode (`local`, `pr`, or `push`). */
export type FleetPublishMode = (typeof FLEET_PUBLISH_MODES)[number];

/** Stack composition for a `pr` publish. */
export type FleetPublishStackComposition = (typeof FLEET_PUBLISH_STACK_COMPOSITIONS)[number];

/** The fields a publish contract can carry beyond its mode. */
type PublishField = "remote" | "base" | "ready" | "stacks";

const PUBLISH_FIELDS: readonly PublishField[] = ["remote", "base", "ready", "stacks"];

/**
 * Which modes may carry each field. A field supplied for a mode outside its list
 * is a launch-time refusal, never a silent drop: the frozen intent would
 * otherwise hide the loss from every later reader.
 */
const FIELD_APPLIES_TO: Record<PublishField, readonly FleetPublishMode[]> = {
  remote: ["pr", "push"],
  base: ["pr"],
  ready: ["pr"],
  stacks: ["pr"],
};

/**
 * Control characters and a leading `-` are rejected on every path (flag, repo
 * config, git config). These strings are frozen into the intent and later
 * executed by a different process (bd-174.3 `gh`/`git push` argv), so a
 * flag-shaped value (`--upload-pack=…`) or an embedded newline must never reach
 * the record.
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function publishRefString(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.startsWith("-"), { message: "must not start with '-'" })
    .refine((value) => !hasControlCharacter(value), {
      message: "must not contain control characters",
    });
}

const publishRemoteField = publishRefString(128);
const publishBaseField = publishRefString(256);

/**
 * The stored publish contract. A discriminated union on `mode` so every mode's
 * payload is explicit and a partial record cannot be read as complete.
 */
export const FleetPublishSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local") }),
  z.object({
    mode: z.literal("pr"),
    remote: publishRemoteField,
    base: publishBaseField,
    ready: z.boolean().optional(),
    stacks: z.enum(FLEET_PUBLISH_STACK_COMPOSITIONS).optional(),
  }),
  z.object({ mode: z.literal("push"), remote: publishRemoteField }),
]);

/** A validated, complete publish contract. */
export type FleetPublish = z.infer<typeof FleetPublishSchema>;

/**
 * Local mode is the default and is inherently inert: a `local` fleet never
 * resolves a remote, spawns a publisher, or touches the network. The constant is
 * frozen and every writer mints a fresh copy, so one in-place edit of a stored
 * intent can never corrupt the shared default.
 */
export const DEFAULT_FLEET_PUBLISH: Readonly<FleetPublish> = Object.freeze({ mode: "local" });

/** A fresh, mutable copy of the inert default, safe to store in an intent. */
export function defaultFleetPublish(): FleetPublish {
  return { ...DEFAULT_FLEET_PUBLISH };
}

/**
 * A publish request as it arrives from a flag, a config file, or git config.
 *
 * Partial on purpose: `--publish pr` alone names the mode while `remote`/`base`
 * are completed from the passed-in base branch at resolve time, and
 * `--publish-remote` without `--publish` applies to whatever mode the config
 * resolves to.
 */
export interface FleetPublishRequest {
  mode?: FleetPublishMode;
  remote?: string;
  base?: string;
  ready?: boolean;
  stacks?: FleetPublishStackComposition;
}

const FleetPublishRequestSchema = z
  .object({
    mode: z.enum(FLEET_PUBLISH_MODES).optional(),
    remote: publishRemoteField.optional(),
    base: publishBaseField.optional(),
    ready: z.boolean().optional(),
    stacks: z.enum(FLEET_PUBLISH_STACK_COMPOSITIONS).optional(),
  })
  .strict();

/** Validated complete contract, or undefined for anything unrecognised. */
export function parseFleetPublish(raw: unknown): FleetPublish | undefined {
  const result = FleetPublishSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

export type FleetPublishSource = "flag" | "config-file" | "git-config" | "default";

export type FleetPublishResolveResult =
  | { ok: true; publish: FleetPublish; source: FleetPublishSource }
  | { ok: false; error: string };

type PublishSourceTuple = readonly [FleetPublishRequest | undefined, FleetPublishSource];

/**
 * Refuse a supplied field the resolved mode cannot carry (or that the source's
 * own declared mode cannot carry), naming the exact field and mode.
 *
 * This fires for every source, before any completion happens: a config object
 * that carries a field its own mode cannot use is an operator error, not
 * something a later reader should have to guess about.
 */
function firstInapplicableField(
  request: FleetPublishRequest | undefined,
  mode: FleetPublishMode,
): PublishField | undefined {
  for (const field of PUBLISH_FIELDS) {
    if (request?.[field] === undefined) continue;
    if (!FIELD_APPLIES_TO[field].includes(mode)) return field;
  }
  return undefined;
}

function publishFieldConflict(
  sources: readonly PublishSourceTuple[],
  resolvedMode: FleetPublishMode,
): string | undefined {
  for (const [request] of sources) {
    const field = firstInapplicableField(request, resolvedMode);
    if (field !== undefined) return conflictError(field, resolvedMode, "resolved");
  }
  for (const [request] of sources) {
    const declared = request?.mode;
    if (declared === undefined) continue;
    const field = firstInapplicableField(request, declared);
    if (field !== undefined) return conflictError(field, declared, "declared");
  }
  return undefined;
}

function conflictError(
  field: PublishField,
  mode: FleetPublishMode,
  kind: "resolved" | "declared",
): string {
  const modes = FIELD_APPLIES_TO[field].map((allowed) => `"${allowed}"`).join("/");
  const tail =
    kind === "resolved"
      ? `mode resolved to "${mode}". Drop the flag or set a mode that uses it.`
      : `the config declares "${mode}". Remove the field or change the mode.`;
  return `publish: "${field}" only applies to mode ${modes}, but ${tail}`;
}

/**
 * Resolve the publish contract from its sources, pure and without side effects.
 *
 * Precedence is exactly flag → config file → git config → local default, applied
 * per field: a later source only supplies what the earlier one (and the ones
 * before it) left undefined. The mode is the one exception the source label
 * tracks, because the operator needs to know where the contract came from.
 * `baseBranch` completes a `pr` request (`base`) and the default `origin` remote
 * so the frozen record is fully explicit and no reader ever falls back.
 *
 * A supplied field the resolved mode cannot carry is refused, never silently
 * dropped.
 */
export function resolveFleetPublish(input: {
  flag?: FleetPublishRequest;
  configFile?: FleetPublishRequest;
  gitConfig?: FleetPublishRequest;
  baseBranch: string;
}): FleetPublishResolveResult {
  const sources: readonly PublishSourceTuple[] = [
    [input.flag, "flag"],
    [input.configFile, "config-file"],
    [input.gitConfig, "git-config"],
  ];
  const source: PublishSource =
    sources.find(([request]) => request?.mode !== undefined)?.[1] ?? "default";
  const mode = sources.reduce<FleetPublishMode | undefined>(
    (chosen, [request]) => chosen ?? request?.mode,
    undefined,
  );
  const resolvedMode = mode ?? "local";
  const conflict = publishFieldConflict(sources, resolvedMode);
  if (conflict !== undefined) return { ok: false, error: conflict };

  const remote = firstDefined(sources, "remote");
  const base = firstDefined(sources, "base");
  const ready = firstDefined(sources, "ready");
  const stacks = firstDefined(sources, "stacks");

  let completed: unknown;
  switch (resolvedMode) {
    case "local":
      completed = { mode: "local" };
      break;
    case "pr":
      completed = {
        mode: "pr",
        remote: remote ?? "origin",
        base: base ?? input.baseBranch,
        ...(ready === undefined ? {} : { ready }),
        ...(stacks === undefined ? {} : { stacks }),
      };
      break;
    case "push":
      completed = { mode: "push", remote: remote ?? "origin" };
      break;
  }
  const validated = FleetPublishSchema.safeParse(completed);
  if (!validated.success) {
    return {
      ok: false,
      error: `invalid publish contract (${describeIssues(validated.error.issues)})`,
    };
  }
  return { ok: true, publish: validated.data, source };
}

type PublishSource = FleetPublishSource;

function firstDefined(
  sources: readonly PublishSourceTuple[],
  field: PublishField,
): FleetPublishRequest[PublishField] {
  for (const [request] of sources) {
    if (request === undefined) continue;
    const value = request[field];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** One-line human summary for the launch report / audit detail. */
export function formatFleetPublish(publish: FleetPublish): string {
  switch (publish.mode) {
    case "local":
      return "local";
    case "pr":
      return `pr → ${publish.remote}/${publish.base}`;
    case "push":
      return `push → ${publish.remote}`;
  }
}

/** Injected git exec seam; mirrors `GitExec` from `stack-rebase.ts`. */
export type FleetPublishGitExec = GitExec;

/** Injected filesystem seam; only the one read the config reader performs. */
export interface FleetPublishFsSeam {
  readFileSync: (path: string) => string;
}

export interface ReadFleetPublishConfigOptions {
  repoRoot: string;
  exec?: FleetPublishGitExec;
  fs?: FleetPublishFsSeam;
}

export interface ReadFleetPublishConfigResult {
  configFile?: FleetPublishRequest;
  gitConfig?: FleetPublishRequest;
  warnings: readonly string[];
}

const defaultFs: FleetPublishFsSeam = {
  readFileSync: (path) => readFileSync(path, "utf8"),
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `git config --get` outcome: a value, the normal unset case, or a real failure. */
type GitConfigRead =
  | { kind: "value"; value: string }
  | { kind: "unset" }
  | { kind: "error"; error: string };

/**
 * Exit code 1 (or git's "no such key" wording) is the normal unset answer;
 * anything else — a spawn error, a timeout, another exit code — is a real
 * failure that must be reported, not silently treated as "the operator set
 * nothing".
 */
function isMissingKey(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 1) return true;
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" && stderr.toLowerCase().includes("no such key");
}

function gitConfigGet(cwd: string, key: string, exec: FleetPublishGitExec): GitConfigRead {
  try {
    const value = exec(["config", "--get", key], cwd).trim();
    return value === "" ? { kind: "unset" } : { kind: "value", value };
  } catch (error) {
    if (isMissingKey(error)) return { kind: "unset" };
    return { kind: "error", error: errorMessage(error) };
  }
}

/** Read one key, reporting a real failure as a warning (never throwing). */
function readGitConfigKey(
  cwd: string,
  key: string,
  exec: FleetPublishGitExec,
  warnings: string[],
): string | undefined {
  const read = gitConfigGet(cwd, key, exec);
  if (read.kind === "error") {
    warnings.push(`git config ${key}: ${read.error}; treating it as unset`);
    return undefined;
  }
  return read.kind === "value" ? read.value : undefined;
}

function narrowMode(value: string): FleetPublishMode | undefined {
  return (FLEET_PUBLISH_MODES as readonly string[]).includes(value)
    ? (value as FleetPublishMode)
    : undefined;
}

function narrowStacks(value: string): FleetPublishStackComposition | undefined {
  return (FLEET_PUBLISH_STACK_COMPOSITIONS as readonly string[]).includes(value)
    ? (value as FleetPublishStackComposition)
    : undefined;
}

function narrowField(schema: z.ZodType<string>, value: string): string | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseGitBoolean(value: string): boolean | undefined {
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  return undefined;
}

/**
 * Read the publish contract from repo config, never throwing.
 *
 * `<repoRoot>/.belayd/config.json` accepts either `{"publish": { ... }}` or the
 * shorthand `{"publish": "pr"|"local"|"push"}`. `git config belayd.publish` and
 * its `remote`/`base`/`ready`/`stacks` companions are read from the same root.
 * An unreadable or invalid value is a warning and is ignored — it never silently
 * upgrades the mode, and it never aborts a launch. The two sources are returned
 * separately so {@link resolveFleetPublish} can apply the documented precedence.
 */
export function readFleetPublishConfig(
  options: ReadFleetPublishConfigOptions,
): ReadFleetPublishConfigResult {
  const exec = options.exec ?? defaultGitExec;
  const fs = options.fs ?? defaultFs;
  const warnings: string[] = [];
  const configPath = join(options.repoRoot, ".belayd", "config.json");

  let configFile: FleetPublishRequest | undefined;
  let rawConfig: string | undefined;
  try {
    rawConfig = fs.readFileSync(configPath);
  } catch (error) {
    // Absent file is the normal "no repo config" case; anything else is a warning.
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      warnings.push(`${configPath}: could not read (${errorMessage(error)})`);
    }
  }
  if (rawConfig !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawConfig);
    } catch (error) {
      warnings.push(`${configPath}: invalid JSON (${errorMessage(error)})`);
      parsed = undefined;
    }
    if (parsed !== undefined) {
      configFile = readRepoConfigPublish(configPath, parsed, warnings);
    }
  }

  const gitConfig = readGitConfigPublish(options.repoRoot, exec, warnings);
  return {
    ...(configFile === undefined ? {} : { configFile }),
    ...(gitConfig === undefined ? {} : { gitConfig }),
    warnings,
  };
}

function readRepoConfigPublish(
  configPath: string,
  parsed: unknown,
  warnings: string[],
): FleetPublishRequest | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${configPath}: expected a JSON object`);
    return undefined;
  }
  const publish = (parsed as Record<string, unknown>).publish;
  if (publish === undefined) return undefined;
  if (typeof publish === "string") {
    const mode = narrowMode(publish);
    if (mode === undefined) {
      warnings.push(`${configPath}: unknown publish "${publish}"; ignoring`);
      return undefined;
    }
    return { mode };
  }
  const result = FleetPublishRequestSchema.safeParse(publish);
  if (!result.success) {
    warnings.push(
      `${configPath}: invalid publish (${describeIssues(result.error.issues)}); ignoring`,
    );
    return undefined;
  }
  return result.data;
}

/** Narrow one git-config value; a value the parser rejects becomes a warning. */
function narrowGitValue<T>(
  raw: string | undefined,
  parse: (value: string) => T | undefined,
  invalid: (value: string) => string,
  warnings: string[],
): T | undefined {
  if (raw === undefined) return undefined;
  const narrowed = parse(raw);
  if (narrowed === undefined) warnings.push(invalid(raw));
  return narrowed;
}

/**
 * Read the git-config source, ignoring a key whose value is invalid.
 *
 * Every value is narrowed through the same field schema the request/config path
 * uses, so an over-long, flag-shaped, or control-character value is a warning
 * and that key is ignored — never a launch-killing refusal and never a value
 * frozen for a later process to execute.
 */
function readGitConfigPublish(
  cwd: string,
  exec: FleetPublishGitExec,
  warnings: string[],
): FleetPublishRequest | undefined {
  const raw = {
    mode: readGitConfigKey(cwd, "belayd.publish", exec, warnings),
    remote: readGitConfigKey(cwd, "belayd.publish.remote", exec, warnings),
    base: readGitConfigKey(cwd, "belayd.publish.base", exec, warnings),
    ready: readGitConfigKey(cwd, "belayd.publish.ready", exec, warnings),
    stacks: readGitConfigKey(cwd, "belayd.publish.stacks", exec, warnings),
  };
  if (Object.values(raw).every((value) => value === undefined)) return undefined;

  const mode = narrowGitValue(
    raw.mode,
    narrowMode,
    (value) => `git config belayd.publish: unknown value "${value}"`,
    warnings,
  );
  const remote = narrowGitValue(
    raw.remote,
    (value) => narrowField(publishRemoteField, value),
    (value) => `git config belayd.publish.remote: invalid value "${value}"`,
    warnings,
  );
  const base = narrowGitValue(
    raw.base,
    (value) => narrowField(publishBaseField, value),
    (value) => `git config belayd.publish.base: invalid value "${value}"`,
    warnings,
  );
  const ready = narrowGitValue(
    raw.ready,
    parseGitBoolean,
    (value) => `git config belayd.publish.ready: not a boolean ("${value}")`,
    warnings,
  );
  const stacks = narrowGitValue(
    raw.stacks,
    narrowStacks,
    (value) => `git config belayd.publish.stacks: unknown value "${value}"`,
    warnings,
  );
  const request: FleetPublishRequest = {
    ...(mode === undefined ? {} : { mode }),
    ...(remote === undefined ? {} : { remote }),
    ...(base === undefined ? {} : { base }),
    ...(ready === undefined ? {} : { ready }),
    ...(stacks === undefined ? {} : { stacks }),
  };
  return Object.keys(request).length === 0 ? undefined : request;
}

function describeIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
