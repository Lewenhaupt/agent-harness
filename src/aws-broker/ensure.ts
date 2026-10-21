/**
 * On-demand scope creation (bd-125).
 *
 * The broker daemon owns every scope socket, and the control socket lives
 * outside the sandbox (it is masked inside it, on purpose: a sandboxed process
 * must not be able to ask for another repo's credentials). So whoever builds a
 * plan — `src/spawn.ts` for a sub-agent, `belayd-aws plan` for the shell
 * wrapper — has to ask the daemon to start the scope socket.
 *
 * This is deliberately *best effort and synchronous*: `launchAgentProcess` is a
 * sync function by design, and a broker that is down must never turn into "run
 * unsandboxed". Callers keep the sandbox and surface the failure. The default
 * timeout is short because this call blocks the parent pi process.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { AwsResult } from "./aws-cli.ts";

/** Env key holding the `belayd-aws` CLI path (set by the NixOS module). */
export const BROKER_CLI_ENV_KEY = "BELAYD_AWS_BIN";

/** Env key holding the generated shim's wrapper path. */
export const CREDENTIAL_PROCESS_BIN_ENV_KEY = "BELAYD_AWS_CREDENTIAL_PROCESS_BIN";

/**
 * Resolve the `belayd-aws` CLI.
 *
 * `BELAYD_AWS_BIN` is explicit; otherwise the sibling of the configured shim
 * wrapper is used, because the Nix build installs `belayd-aws` next to it.
 */
export function resolveBrokerCliPath(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env[BROKER_CLI_ENV_KEY];
  if (explicit !== undefined && explicit !== "") return explicit;
  const shim = env[CREDENTIAL_PROCESS_BIN_ENV_KEY];
  if (shim !== undefined && shim !== "") return join(dirname(shim), "belayd-aws");
  return undefined;
}

/**
 * Ask the daemon for this worktree's scope socket (starting it on demand).
 *
 * Returns the socket path on success. Failures are values, never throws: the
 * caller has already decided to sandbox and only needs to log the shortfall.
 */
export function ensureScopeSync(options: {
  worktree: string;
  env: NodeJS.ProcessEnv;
  timeoutInMs?: number;
  run?: (argv: readonly string[]) => string;
}): AwsResult<{ socketPath: string }> {
  const binary = resolveBrokerCliPath(options.env);
  if (binary === undefined) {
    return {
      ok: false,
      error: `${BROKER_CLI_ENV_KEY} is not set and no ${CREDENTIAL_PROCESS_BIN_ENV_KEY} sibling is available`,
    };
  }
  const argv = [binary, "ensure-scope", "--worktree", options.worktree];
  const run =
    options.run ??
    ((command: readonly string[]): string => {
      const [executable, ...args] = command;
      if (executable === undefined) return "";
      return execFileSync(executable, args, {
        encoding: "utf-8",
        timeout: options.timeoutInMs ?? 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    });
  try {
    const socketPath = run(argv).trim();
    if (socketPath === "") {
      return { ok: false, error: "the AWS broker returned no socket path" };
    }
    return { ok: true, value: { socketPath } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not ensure the AWS scope socket: ${message}` };
  }
}
