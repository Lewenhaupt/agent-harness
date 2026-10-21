/**
 * `belayd-aws` CLI entry point (bd-125).
 *
 * Four subcommands, matching the four ways this code is entered:
 *
 * - `daemon` — the long-running broker (systemd unit `pi-web-aws-broker`).
 * - `ensure-scope --worktree <path>` — ask the daemon for this worktree's
 *   socket path, starting the scope socket on demand.
 * - `plan --worktree <path> [--print0]` — print the sandbox argv prefix and
 *   (best effort) start this worktree's scope socket; used by
 *   `scripts/belayd-shell.sh` to re-exec itself through bubblewrap.
 * - `credential-process --socket <path>` — the shim botocore execs.
 *
 * Node 24 strips TypeScript types natively, so the Nix wrappers run this file
 * directly and the broker has no build step.
 */

import { connect } from "node:net";
import type { AwsResult } from "./aws-cli.ts";
import { runCredentialProcess } from "./client.ts";
import { startDaemon } from "./daemon.ts";
import { ensureScopeSync } from "./ensure.ts";
import { isEntrypoint } from "./entrypoint.ts";
import { type AwsSandboxPlan, resolveSandboxPlan } from "./plan.ts";
import { controlSocketPathFor, resolveBrokerRuntimeBaseDir } from "./scope.ts";

/** Re-exported so callers can validate the guard without importing both files. */
export { isEntrypoint };

/** Usage text shown for an unknown or missing subcommand. */
export const CLI_USAGE = [
  "usage: belayd-aws <command> [options]",
  "",
  "  daemon                              run the credential broker (long-running)",
  "  ensure-scope --worktree <path>      print this worktree's scope socket path",
  "  plan --worktree <path> [--print0]   print the bubblewrap argv prefix",
  "  credential-process --socket <path>  credential_process shim (stdout JSON)",
].join("\n");

/** Named option value: `--name value`. */
function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value === "") return undefined;
  return value;
}

/** Options for {@link main}; IO is injected so tests never touch stdio. */
export interface MainOptions {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  /** Resolves when the daemon should shut down (tests pass a resolved signal). */
  waitForShutdown?: () => Promise<void>;
}

/** Broker runtime base used by every subcommand; one place for agreement. */
function runtimeBaseDirFor(env: NodeJS.ProcessEnv): string {
  return resolveBrokerRuntimeBaseDir({
    env,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    temporaryDir: env.TMPDIR ?? "/tmp",
  });
}

/** One request/response round trip on the daemon's control socket. */
export function sendControlRequest(options: {
  controlSocketPath: string;
  request: unknown;
  timeoutMs?: number;
}): Promise<AwsResult<string>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise<AwsResult<string>>((resolvePromise) => {
    let buffer = "";
    let settled = false;
    const socket = connect(options.controlSocketPath);
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `timed out talking to the AWS broker at ${options.controlSocketPath}`,
      });
    }, timeoutMs);
    timer.unref();

    const finish = (result: AwsResult<string>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(result);
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(options.request)}\n`);
    });
    socket.on("data", (data: Buffer) => {
      buffer += data.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      finish({ ok: true, value: buffer.slice(0, newline) });
    });
    socket.on("error", (error: Error) => {
      finish({ ok: false, error: error.message });
    });
    socket.on("end", () => {
      finish({ ok: false, error: "the AWS broker closed the connection without a response" });
    });
  });
}

/** Parse the `ok`/`error` fields of a control response. */
export function parseControlResponse(line: string): AwsResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: "the AWS broker sent a malformed response" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "the AWS broker sent a non-object response" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.ok === true) return { ok: true, value: record };
  const error = record.error;
  return {
    ok: false,
    error: typeof error === "string" && error !== "" ? error : "the AWS broker refused the request",
  };
}

/** Format the sandbox argv prefix for the shell wrapper. */
export function formatPlanOutput(plan: AwsSandboxPlan, print0: boolean): string {
  return print0 ? `${plan.argvPrefix.join("\0")}\0` : `${plan.argvPrefix.join("\n")}\n`;
}

/**
 * Run one CLI invocation. Returns the process exit code.
 *
 * Failures are errors-as-values with actionable text: an agent hitting a
 * refusal must be able to tell "this repo has no AWS" from "the broker is
 * down" without reading source.
 */
export async function main(options: MainOptions): Promise<number> {
  const [command, ...rest] = options.argv;
  switch (command) {
    case "daemon":
      return runDaemonCommand(options);
    case "ensure-scope":
      return runEnsureScopeCommand(options, rest);
    case "plan":
      return runPlanCommand(options, rest);
    case "credential-process":
      return runCredentialProcess({
        argv: rest,
        writeOut: options.stdout,
        writeErr: options.stderr,
      });
    default:
      options.stderr(`${CLI_USAGE}\n`);
      return 2;
  }
}

/** `daemon`: run until SIGTERM/SIGINT, then close every socket. */
async function runDaemonCommand(options: MainOptions): Promise<number> {
  const daemon = await startDaemon({
    env: options.env,
    log: (message) => options.stderr(`${message}\n`),
  });
  if (!daemon.ok) {
    options.stderr(`belayd-aws: ${daemon.error}\n`);
    return 1;
  }
  options.stderr(`aws-broker: listening on ${daemon.value.controlSocketPath}\n`);
  const waitForShutdown = options.waitForShutdown ?? defaultWaitForShutdown();
  try {
    await waitForShutdown();
  } finally {
    await daemon.value.close();
  }
  return 0;
}

/** `ensure-scope`: ask the daemon for this worktree's scope socket path. */
async function runEnsureScopeCommand(options: MainOptions, rest: string[]): Promise<number> {
  const worktree = readOption(rest, "--worktree");
  if (worktree === undefined) {
    options.stderr(`belayd-aws: ensure-scope requires --worktree <path>\n${CLI_USAGE}\n`);
    return 2;
  }
  const controlSocketPath = controlSocketPathFor(runtimeBaseDirFor(options.env));
  const response = await sendControlRequest({
    controlSocketPath,
    request: { action: "ensure-scope", worktree },
  });
  if (!response.ok) {
    options.stderr(
      `belayd-aws: the AWS credential broker is not reachable at ${controlSocketPath} (${response.error}).\n` +
        "Start it with: systemctl start pi-web-aws-broker (it must NOT run inside a sandbox).\n",
    );
    return 1;
  }
  const parsed = parseControlResponse(response.value);
  if (!parsed.ok) {
    options.stderr(`belayd-aws: ${parsed.error}\n`);
    return 1;
  }
  const socketPath = parsed.value.socketPath;
  if (typeof socketPath !== "string" || socketPath === "") {
    options.stderr("belayd-aws: broker response is missing socketPath\n");
    return 1;
  }
  options.stdout(`${socketPath}\n`);
  return 0;
}

/** `plan`: print the bubblewrap argv prefix for the shell wrapper. */
function runPlanCommand(options: MainOptions, rest: string[]): number {
  const worktree = readOption(rest, "--worktree");
  if (worktree === undefined) {
    options.stderr(`belayd-aws: plan requires --worktree <path>\n${CLI_USAGE}\n`);
    return 2;
  }
  const outcome = resolveSandboxPlan({ worktree, env: options.env });
  if (!outcome.ok) {
    // `plan` is the shell wrapper's probe: a non-zero exit means "run
    // unwrapped", so the reason goes to stderr and never to stdout.
    options.stderr(`belayd-aws: ${outcome.reason}\n`);
    return 1;
  }
  // Starting the scope socket is part of making the plan real: the shim can
  // only reach its own scope socket, and the control socket is masked inside
  // the sandbox, so the daemon must be asked from *outside*. A broker that is
  // down is reported but never turns the sandbox off — the mask is the
  // security property, AWS access is not.
  const ensured = ensureScopeSync({ worktree: outcome.plan.worktree, env: options.env });
  if (!ensured.ok) options.stderr(`belayd-aws: ${ensured.error}\n`);
  options.stdout(formatPlanOutput(outcome.plan, rest.includes("--print0")));
  return 0;
}

/** Wait for SIGTERM/SIGINT so systemd can stop the daemon cleanly. */
function defaultWaitForShutdown(): () => Promise<void> {
  return () =>
    new Promise<void>((resolvePromise) => {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.once(signal, () => resolvePromise());
      }
    });
}

const entry = process.argv[1];
if (isEntrypoint(entry, import.meta.url)) {
  const code = await main({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  });
  process.exitCode = code;
}
