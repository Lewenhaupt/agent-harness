/**
 * Sandbox and socket paths for the per-repo AWS credential broker (bd-125).
 *
 * Everything in this module is pure so the bwrap argv can be unit-tested
 * without running bubblewrap. The argv rules encoded here were verified
 * against bubblewrap 0.11.2 and 0.12.0 on this host:
 *
 * - Masks must come *after* the base `--ro-bind / /`: bubblewrap applies
 *   mounts in argv order, so a later base bind would silently unmask
 *   `~/.aws` again (unit-tested below).
 * - A mask is a `--tmpfs <dir>` for a directory and a
 *   `--ro-bind /dev/null <file>` for a regular file. The two are not
 *   interchangeable, and neither alternative works (verified on bubblewrap
 *   0.11.2 on this host): `--tmpfs <file>` fails with `Can't mkdir <file>:
 *   Not a directory`, while `--ro-bind /dev/null <file>` reads `EACCES`
 *   (`cat: … Permission denied`) — not EOF. `EACCES` is the correct outcome:
 *   the path still exists inside the sandbox, it just cannot be opened, which
 *   is exactly what "masked" means for a file (an empty file would silently
 *   look like an empty certificate instead).
 * - Mask paths must be `realpath()`-resolved: masking a path that goes through
 *   a symlinked directory fails with `bwrap: Can't create file at …: No such
 *   file or directory` (verified), because bwrap creates the mount point in the
 *   *resolved* parent but is handed the unresolved path.
 * - `--tmpfs` only works on directories that already exist, and bubblewrap
 *   cannot create the path itself because the base bind makes `/` read-only
 *   ("Can't create file …: Read-only file system"). So `~/.aws`,
 *   `~/.config/aws` and the broker runtime base are pre-created by the plan
 *   resolver (which is also why the systemd broker unit declares
 *   `RuntimeDirectory`) before any argv referencing them exists. The plan
 *   resolver treats a failure to create them as `unavailable` rather than
 *   throwing, so a missing base degrades to "no AWS" instead of a broken
 *   shell.
 * - The *broker runtime base* (`<base>`, holding the control socket and every
 *   scope dir) is masked with `--tmpfs`, and only this worktree's scope dir is
 *   re-bound inside it. That is the property that keeps one repo's sandbox
 *   away from the control socket and from every sibling scope socket: socket
 *   mode 0600 is meaningless between same-uid processes, so the mask — not the
 *   file mode — is the isolation. A bind destination *inside* a tmpfs is
 *   created by bubblewrap, so the re-expose works even though `/` is
 *   read-only.
 * - Only the *user* namespace is unshared. `--unshare-pid/--unshare-ipc/
 *   --unshare-net` and `--tmpfs /tmp` are forbidden here: bd's dolt liveness
 *   check shells out to `ps -axo`, and terminals plus `nix build` rely on the
 *   host `/tmp` and host network. Unsharing the user namespace is what makes a
 *   same-uid `/proc/<pid>/environ` read from a sibling process fail, which is
 *   the property that actually protects credentials outside the sandbox.
 * - `--not-a-security-boundary` and `--disable-userns` are never emitted.
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/** Synthetic profile name the sandboxed agent sees (`AWS_PROFILE=agent`). */
export const SANDBOX_PROFILE_NAME = "agent";

/** Env key marking a process as already inside a scoped AWS sandbox. */
export const SANDBOX_ACTIVE_ENV_KEY = "BELAYD_SANDBOX_ACTIVE";

/** Every AWS credential/config env key scrubbed from a spawned agent. */
export const AWS_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
] as const;

/**
 * Prefix scrub for the container/ECS credential providers. A prefix sweep (not
 * an explicit list) because AWS adds `AWS_CONTAINER_CREDENTIALS_*` keys over
 * time and any one of them still resolves credentials.
 */
export const AWS_ENV_KEY_PREFIXES = ["AWS_CONTAINER_CREDENTIALS_"] as const;

/**
 * Keys the sandbox itself unsets (`bwrap --unsetenv`), independent of whatever
 * the launcher's environment happens to hold. `spawn.ts` and the shell wrapper
 * scrub too, but only the sandbox can guarantee it for every entry path —
 * including a hand-run `bwrap` argv and the `belayd-shell` re-exec, where the
 * inherited environment is the caller's.
 */
export const AWS_SANDBOX_UNSET_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  // AWS_PROFILE is deliberately absent: the sandbox sets it to the synthetic
  // `agent` profile, and unsetting it after that would make the SDK look for
  // `[profile default]`, which does not exist in the generated config.
  "AWS_DEFAULT_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
] as const;

/** Filename of the per-scope unix socket inside the scope directory. */
export const SCOPE_SOCKET_FILENAME = "sock";

/** Filename of the generated `credential_process` shim inside the scope dir. */
export const SCOPE_SHIM_FILENAME = "credential-process";

/** Result of scrubbing AWS env keys from a child environment. */
export interface ScrubbedEnv {
  env: NodeJS.ProcessEnv;
  removed: readonly string[];
}

/** True when the process already runs inside a scoped AWS sandbox. */
export function isSandboxActive(env: NodeJS.ProcessEnv): boolean {
  return env[SANDBOX_ACTIVE_ENV_KEY] === "1";
}

/**
 * Remove every AWS credential source from an environment without mutating the
 * input. Returned `removed` names are for logging only — never values.
 */
export function scrubAwsEnv(env: NodeJS.ProcessEnv): ScrubbedEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  const removed: string[] = [];
  for (const key of Object.keys(scrubbed)) {
    const exact = (AWS_ENV_KEYS as readonly string[]).includes(key);
    const prefixed = AWS_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (!exact && !prefixed) continue;
    delete scrubbed[key];
    removed.push(key);
  }
  return { env: scrubbed, removed };
}

/** Stable per-worktree id: first 12 hex chars of the git-toplevel digest. */
export function scopeIdFor(worktreeRoot: string): string {
  return createHash("sha256").update(resolve(worktreeRoot)).digest("hex").slice(0, 12);
}

/** Env key overriding the broker runtime base directory. */
export const BROKER_RUNTIME_BASE_ENV_KEY = "BELAYD_AWS_RUNTIME_BASE_DIR";

/** `$XDG_RUNTIME_DIR`, falling back to a per-uid temp dir when unset. */
export function resolveRuntimeDir(options: {
  env: NodeJS.ProcessEnv;
  uid: number;
  temporaryDir: string;
}): string {
  const configured = options.env.XDG_RUNTIME_DIR;
  if (configured !== undefined && configured !== "") return resolve(configured);
  return join(options.temporaryDir, `belayd-aws-runtime-${options.uid}`);
}

/** Directory holding every scope dir and socket: `<runtime>/belayd/aws`. */
export function awsRuntimeBaseDirFor(runtimeDir: string): string {
  return join(runtimeDir, "belayd", "aws");
}

/**
 * Resolve the directory that holds the control socket and every scope dir.
 *
 * `BELAYD_AWS_RUNTIME_BASE_DIR` wins when set: the systemd broker unit points it
 * at a `RuntimeDirectory=` it owns (`/run/belayd/aws`), which exists without
 * logind ever creating `/run/user/<uid>` — a system-service user has no session
 * and would otherwise crash-loop the daemon on `mkdir`/bind. Otherwise the
 * historical `<XDG_RUNTIME_DIR>/belayd/aws` composition is used.
 */
export function resolveBrokerRuntimeBaseDir(options: {
  env: NodeJS.ProcessEnv;
  uid: number;
  temporaryDir: string;
}): string {
  const explicit = options.env[BROKER_RUNTIME_BASE_ENV_KEY];
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  return awsRuntimeBaseDirFor(resolveRuntimeDir(options));
}

/** This worktree's scope dir: `<runtimeBaseDir>/<scopeId>`. */
export function scopeDirFor(options: { runtimeBaseDir: string; scopeId: string }): string {
  return join(options.runtimeBaseDir, options.scopeId);
}

/** Per-scope credential socket served by the broker. */
export function socketPathFor(scopeDir: string): string {
  return join(scopeDir, SCOPE_SOCKET_FILENAME);
}

/** Broker control socket that `ensure-scope` talks to. */
export function controlSocketPathFor(runtimeBaseDir: string): string {
  return join(runtimeBaseDir, "control.sock");
}

/** Generated credential_process shim path. */
export function shimPathFor(scopeDir: string): string {
  return join(scopeDir, SCOPE_SHIM_FILENAME);
}

/** Generated synthetic `~/.aws/config` path inside the scope dir. */
export function syntheticAwsConfigPathFor(scopeDir: string): string {
  return join(scopeDir, "aws", "config");
}

/** Directory mode for the broker's runtime tree. */
export const BROKER_DIR_MODE = 0o700;

/** Socket mode for the broker's unix sockets. */
export const BROKER_SOCKET_MODE = 0o600;

/**
 * One mask entry in the argv form it takes.
 *
 * Discriminated rather than a bare path list so a caller cannot accidentally
 * `--tmpfs` a file (`Not a directory`) or `--ro-bind /dev/null` a directory
 * (silently useless): the kind is decided from the filesystem by
 * `config.ts#validateMaskEntry`, not guessed here.
 */
export type SandboxMask = { kind: "tmpfs"; path: string } | { kind: "null-bind"; path: string };

/** Options for {@link buildSandboxArgv}. */
export interface BuildSandboxArgvOptions {
  /** bubblewrap binary to exec. */
  bwrapPath: string;
  /** Host home directory (`$HOME`); `~/.aws` inside the sandbox is masked. */
  homeDir: string;
  /**
   * Broker runtime base (control socket + every scope dir). Masked with a
   * tmpfs so this sandbox can reach neither the control socket nor a sibling
   * scope socket; must already exist on the host.
   */
  runtimeBaseDir: string;
  /** Scope dir holding the shim, synthetic config, and socket. */
  scopeDir: string;
  /**
   * Masks applied in order, after the base bind and before the runtime-base
   * mask. Directory entries must already exist on the host.
   */
  masks: readonly SandboxMask[];
  /** Region to export inside the sandbox. */
  region: string;
  /** Sandbox profile name; defaults to {@link SANDBOX_PROFILE_NAME}. */
  awsProfile?: string;
  /** Command to run; when omitted the argv prefix is returned. */
  command?: readonly string[];
}

/**
 * Build the bubblewrap argv for a scoped AWS sandbox.
 *
 * Order is load-bearing: base binds first, then every mask (including the
 * broker runtime base), then the single scope re-expose, then the synthetic
 * `~/.aws/config`, then the environment.
 */
export function buildSandboxArgv(options: BuildSandboxArgvOptions): string[] {
  const argv: string[] = [
    options.bwrapPath,
    "--unshare-user",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/",
    "/",
    "--dev-bind",
    "/dev",
    "/dev",
    "--proc",
    "/proc",
  ];

  // Masks strictly after the base bind: a later `--ro-bind / /` unmasks.
  for (const mask of options.masks) {
    if (mask.kind === "tmpfs") {
      argv.push("--tmpfs", mask.path);
      continue;
    }
    // A file mask is a `/dev/null` bind, which reads EACCES inside the
    // sandbox (see the module comment): `--tmpfs` on a file is a hard error.
    argv.push("--ro-bind", "/dev/null", mask.path);
  }

  // Hide the broker runtime base: the control socket ("ensure any scope") and
  // every sibling scope socket live there, and socket mode 0600 does not
  // separate same-uid processes. This mask is what makes per-repo scoping real
  // — without it a sandboxed agent could ask the broker for another repo's
  // credentials.
  argv.push("--tmpfs", options.runtimeBaseDir);
  // … then re-expose only this worktree's scope. The destination lives inside
  // the tmpfs, so bubblewrap can create it even though `/` is read-only.
  argv.push("--ro-bind", options.scopeDir, options.scopeDir);

  // The synthetic config is the only profile the agent can see, because the
  // whole `~/.aws` directory is a tmpfs and this is the single file mounted
  // into it.
  argv.push(
    "--ro-bind",
    syntheticAwsConfigPathFor(options.scopeDir),
    join(options.homeDir, ".aws", "config"),
  );

  argv.push("--setenv", "AWS_PROFILE", options.awsProfile ?? SANDBOX_PROFILE_NAME);
  argv.push("--setenv", "AWS_REGION", options.region);
  argv.push("--setenv", SANDBOX_ACTIVE_ENV_KEY, "1");
  // Unset after the setenvs: the sandbox's own identity must survive while any
  // inherited credential source does not.
  for (const key of AWS_SANDBOX_UNSET_ENV_KEYS) argv.push("--unsetenv", key);

  if (options.command !== undefined) argv.push("--", ...options.command);
  return argv;
}

/** Append a command to a sandbox argv prefix built without one. */
export function withSandboxCommand(
  argvPrefix: readonly string[],
  command: readonly string[],
): string[] {
  return [...argvPrefix, "--", ...command];
}
