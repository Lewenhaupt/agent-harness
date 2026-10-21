/**
 * Sandbox plan resolution (bd-125): everything a caller needs to run a command
 * with a per-repo scoped AWS identity.
 *
 * A "plan" is the answer to one question — may this worktree get AWS, and if
 * so what argv wraps its processes. Resolution is fail-closed:
 *
 * - no operator allowlist, no `.belayd/aws.yaml`, or a worktree matched by no
 *   scope ⇒ `not-configured`/`refused`, and the caller runs the command
 *   *unwrapped* with no AWS (never a default profile);
 * - bubblewrap or a runtime dir missing ⇒ `unavailable`;
 * - everything present ⇒ the scope dir is (re)created with the synthetic
 *   `~/.aws/config` and the `credential_process` shim, and the bwrap argv is
 *   returned.
 *
 * The filesystem work here is deliberate and documented: the sandbox must see
 * a config file that exists on the host, and bubblewrap cannot create mount
 * destinations under a read-only `/`.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AwsAllowlist, parseAllowlist, parseRepoConfig, resolveScope } from "./config.ts";
import {
  BROKER_DIR_MODE,
  type BuildSandboxArgvOptions,
  buildSandboxArgv,
  isSandboxActive,
  resolveBrokerRuntimeBaseDir,
  SANDBOX_PROFILE_NAME,
  scopeDirFor,
  scopeIdFor,
  shimPathFor,
  socketPathFor,
  syntheticAwsConfigPathFor,
  withSandboxCommand,
} from "./scope.ts";

/** A resolved, ready-to-run AWS sandbox for one worktree. */
export interface AwsSandboxPlan {
  /** Git toplevel the plan belongs to. */
  worktree: string;
  scopeId: string;
  scopeDir: string;
  socketPath: string;
  /** Operator allowlist profile the broker resolves credentials for. */
  profile: string;
  /** Profile the sandbox sees (`agent`). */
  sandboxProfile: string;
  region: string;
  /** bwrap argv without a command; append `-- <cmd>` via {@link withSandboxCommand}. */
  argvPrefix: readonly string[];
}

/** Why a worktree has no sandbox. */
export type SandboxPlanSkipKind =
  | "not-configured"
  | "refused"
  | "unavailable"
  /** Already inside a scoped sandbox (a nested wrap would be a no-op). */
  | "already-sandboxed";

/** Plan outcome: a plan, or a reason the command runs without AWS. */
export type SandboxPlanOutcome =
  | { ok: true; plan: AwsSandboxPlan }
  | { ok: false; kind: SandboxPlanSkipKind; reason: string };

/** Options for {@link resolveSandboxPlan}; the overrides exist for tests. */
export interface ResolveSandboxPlanOptions {
  /** Directory to resolve the git toplevel from (the spawn cwd). */
  worktree: string;
  env: NodeJS.ProcessEnv;
  bwrapPath?: string;
  nodeBinary?: string;
  clientEntryPath?: string;
  homeDir?: string;
  /** Broker runtime base override (defaults to `<XDG_RUNTIME_DIR>/belayd/aws`). */
  runtimeBaseDir?: string;
  uid?: number;
  temporaryDir?: string;
  gitBinary?: string;
}

function skip(
  kind: SandboxPlanSkipKind,
  reason: string,
): { ok: false; kind: SandboxPlanSkipKind; reason: string } {
  return { ok: false, kind, reason };
}

/** Create a directory (and parents) and force its mode. */
export function ensureDirectory(path: string, mode: number = BROKER_DIR_MODE): void {
  mkdirSync(path, { recursive: true, mode });
  try {
    chmodSync(path, mode);
  } catch {
    /* existing directory owned elsewhere: leave it */
  }
}

/** Write a file with an explicit mode, rewriting it every time. */
function writeFileWithMode(path: string, contents: string, mode: number): void {
  ensureDirectory(dirname(path));
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

/** Shell-quote a path for the generated shim (single quotes, POSIX). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Resolve an executable from an explicit path or `$PATH`. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (name.includes("/")) {
    return isExecutableFile(name) ? name : undefined;
  }
  const pathValue = env.PATH ?? "";
  for (const directory of pathValue.split(":")) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Resolve the git toplevel for a directory (side effect: spawns git). */
export function resolveWorktreeRoot(options: {
  worktree: string;
  gitBinary?: string;
}): { ok: true; value: string } | { ok: false; error: string } {
  const gitBinary = options.gitBinary ?? "git";
  try {
    const output = execFileSync(gitBinary, ["rev-parse", "--show-toplevel"], {
      cwd: options.worktree,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (output === "")
      return { ok: false, error: `git reported no toplevel for ${options.worktree}` };
    return { ok: true, value: resolve(output) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `not a git worktree (${message})` };
  }
}

/** The shim + synthetic config the sandbox sees. */
export interface ScopeFileContents {
  shim: string;
  awsConfig: string;
}

/** Render the generated `credential_process` shim. */
export function renderShim(options: {
  shimPath: string;
  nodeBinary: string;
  clientEntryPath: string;
  /** Prebuilt client wrapper (Nix store path); preferred when present. */
  clientBinary?: string;
}): string {
  const target =
    options.clientBinary !== undefined && options.clientBinary !== ""
      ? shellQuote(options.clientBinary)
      : `${shellQuote(options.nodeBinary)} ${shellQuote(options.clientEntryPath)}`;
  return [
    "#!/bin/sh",
    "# Generated by belayd (bd-125); rewritten whenever the sandbox plan is",
    "# resolved. Speaks the broker's newline-delimited JSON protocol and prints",
    "# exactly one credential_process document on success.",
    `exec ${target} "$@"`,
    "",
  ].join("\n");
}

/** Render the synthetic `~/.aws/config` visible inside the sandbox. */
export function renderSyntheticAwsConfig(options: {
  shimPath: string;
  socketPath: string;
  region: string;
  sandboxProfile?: string;
}): string {
  const profile = options.sandboxProfile ?? SANDBOX_PROFILE_NAME;
  return [
    "# Generated by belayd (bd-125). The sandbox masks ~/.aws, so this is the",
    "# only profile an agent can see; credentials come from the per-repo broker.",
    `[profile ${profile}]`,
    // botocore parses this with `shlex.split` (POSIX), so single quotes are the
    // correct way to survive a space in either path. Unquoted, a space in
    // `$XDG_RUNTIME_DIR` or `$HOME` would split the argv and break every
    // credential fetch.
    `credential_process = ${shellQuote(options.shimPath)} --socket ${shellQuote(
      options.socketPath,
    )}`,
    `region = ${options.region}`,
    "",
  ].join("\n");
}

/** Write the shim and synthetic config into the scope dir. */
export function prepareScopeFiles(options: {
  scopeDir: string;
  socketPath: string;
  region: string;
  sandboxProfile?: string;
  shimContents: string;
}): void {
  ensureDirectory(options.scopeDir);
  writeFileWithMode(shimPathFor(options.scopeDir), options.shimContents, 0o700);
  writeFileWithMode(
    syntheticAwsConfigPathFor(options.scopeDir),
    renderSyntheticAwsConfig({
      shimPath: shimPathFor(options.scopeDir),
      socketPath: options.socketPath,
      region: options.region,
      sandboxProfile: options.sandboxProfile,
    }),
    0o600,
  );
}

/** Default client entry: the TS source in-tree, or the compiled sibling. */
export function defaultClientEntryPath(moduleUrl: string = import.meta.url): string {
  const source = fileURLToPath(new URL("./client.ts", moduleUrl));
  if (existsSync(source)) return source;
  return fileURLToPath(new URL("./client.js", moduleUrl));
}

/** Read + parse the operator allowlist at its conventional location. */
export function allowlistPathFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configHome = env.XDG_CONFIG_HOME;
  const base =
    configHome !== undefined && configHome !== "" ? configHome : join(homeDir, ".config");
  return join(base, "belayd", "aws.yaml");
}

/** The configured (pre-sandbox) answer for one worktree. */
interface ConfiguredScope {
  worktreeRoot: string;
  profile: string;
  region: string;
}

/**
 * Resolve the allowlist + repo file into one granted profile.
 *
 * Split out of {@link resolveSandboxPlan} so the sandbox assembly below stays
 * readable: every refusal (unknown worktree, malformed file, ungranted
 * profile, missing region) is decided here, before any path or argv is built.
 */
function resolveConfiguredScope(options: {
  worktree: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  gitBinary?: string;
}):
  | { ok: true; value: ConfiguredScope }
  | { ok: false; kind: SandboxPlanSkipKind; reason: string } {
  const env = options.env;
  const rootResult = resolveWorktreeRoot({
    worktree: options.worktree,
    gitBinary: options.gitBinary,
  });
  if (!rootResult.ok) return skip("not-configured", rootResult.error);
  const worktreeRoot = rootResult.value;

  const allowlistPath = allowlistPathFor(env, options.homeDir);
  if (!existsSync(allowlistPath)) {
    return skip("not-configured", `no operator allowlist at ${allowlistPath}`);
  }
  const allowlistResult = parseAllowlist(readFileSync(allowlistPath, "utf-8"));
  if (!allowlistResult.ok) {
    return skip("refused", `invalid allowlist ${allowlistPath}: ${allowlistResult.reason}`);
  }
  const allowlist: AwsAllowlist = allowlistResult.value;

  const repoPath = join(worktreeRoot, ".belayd", "aws.yaml");
  if (!existsSync(repoPath)) return skip("not-configured", `no ${repoPath}`);
  const repoResult = parseRepoConfig(readFileSync(repoPath, "utf-8"));
  if (!repoResult.ok) return skip("refused", `invalid ${repoPath}: ${repoResult.reason}`);

  const resolved = resolveScope({ allowlist, repo: repoResult.value, worktreeRoot });
  if (!resolved.ok) return skip("refused", resolved.reason);

  const region = firstNonEmpty([resolved.value.region, env.AWS_REGION, env.AWS_DEFAULT_REGION]);
  if (region === undefined) {
    return skip(
      "refused",
      `scope for ${worktreeRoot} sets no region; add \`region\` to its allowlist scope (the repo file only carries \`profile\`) or export AWS_REGION for the broker`,
    );
  }
  return { ok: true, value: { worktreeRoot, profile: resolved.value.profile, region } };
}

/**
 * Resolve the sandbox plan for a worktree.
 *
 * Never throws for the expected "no AWS configured" states; callers decide
 * whether to log (refusals are worth a warning, plain absence is not an error).
 */
export function resolveSandboxPlan(options: ResolveSandboxPlanOptions): SandboxPlanOutcome {
  const env = options.env;
  if (isSandboxActive(env)) {
    return skip("already-sandboxed", "already inside a belayd AWS sandbox");
  }

  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const configured = resolveConfiguredScope({
    worktree: options.worktree,
    env,
    homeDir,
    gitBinary: options.gitBinary,
  });
  if (!configured.ok) return skip(configured.kind, configured.reason);
  const { worktreeRoot, profile, region } = configured.value;

  const bwrapPath = findExecutable(options.bwrapPath ?? env.BELAYD_BWRAP_BIN ?? "bwrap", env);
  if (bwrapPath === undefined) {
    return skip("unavailable", "bubblewrap (bwrap) is not on PATH");
  }

  const runtimeBaseDir =
    options.runtimeBaseDir ??
    resolveBrokerRuntimeBaseDir({
      env,
      uid: options.uid ?? currentUid(),
      temporaryDir: options.temporaryDir ?? tmpdir(),
    });
  const scopeId = scopeIdFor(worktreeRoot);
  const scopeDir = scopeDirFor({ runtimeBaseDir, scopeId });
  const socketPath = socketPathFor(scopeDir);

  // `--tmpfs` destinations must exist on the host (bubblewrap cannot create
  // them under a read-only `/`), and the scope dir has to exist before the
  // shim/config are written into it. The NixOS broker unit declares
  // `RuntimeDirectory` for the base; this covers the other entry paths. A
  // filesystem failure is a value (`unavailable`), never a throw: the caller
  // must still be able to run the command with a loud reason instead of
  // crashing the shell.
  const awsDir = join(homeDir, ".aws");
  const awsConfigDir = join(homeDir, ".config", "aws");
  try {
    ensureDirectory(runtimeBaseDir);
    ensureDirectory(awsDir);
    ensureDirectory(awsConfigDir);
    ensureDirectory(scopeDir);

    prepareScopeFiles({
      scopeDir,
      socketPath,
      region,
      shimContents: renderShim({
        shimPath: shimPathFor(scopeDir),
        nodeBinary: options.nodeBinary ?? process.execPath,
        clientEntryPath: options.clientEntryPath ?? defaultClientEntryPath(),
        clientBinary: env.BELAYD_AWS_CREDENTIAL_PROCESS_BIN,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return skip(
      "unavailable",
      `could not prepare the AWS sandbox for ${worktreeRoot} (${runtimeBaseDir}): ${message}`,
    );
  }

  const argvOptions: BuildSandboxArgvOptions = {
    bwrapPath,
    homeDir,
    runtimeBaseDir,
    scopeDir,
    maskDirs: [awsDir, awsConfigDir],
    region,
  };

  return {
    ok: true,
    plan: {
      worktree: worktreeRoot,
      scopeId,
      scopeDir,
      socketPath,
      profile,
      sandboxProfile: SANDBOX_PROFILE_NAME,
      region,
      argvPrefix: buildSandboxArgv(argvOptions),
    },
  };
}

/** `process.getuid()` with a portable fallback. */
function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/** First non-empty string in a candidate list. */
function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** Full argv for a planned command. */
export function planCommandArgv(plan: AwsSandboxPlan, command: readonly string[]): string[] {
  return withSandboxCommand(plan.argvPrefix, command);
}
