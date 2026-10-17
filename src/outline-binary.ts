/**
 * Binary resolution and spawn-failure formatting shared by the outline
 * extractor modules.
 *
 * The extractors are external CLI binaries (universal-ctags, ast-grep) that
 * the devShell puts on PATH; they are deliberately NOT npm dependencies, so
 * the Nix `belayd-harness` derivation can leave them out. Resolution never
 * throws: a missing binary is returned as an error value the tool renders as
 * plain text.
 */

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Environment variable name and default for one extractor. */
export interface OutlineBinarySpec {
  /** Override env var, e.g. `BELAYD_CTAGS_BIN`. */
  envName: string;
  /** Default executable name looked up on PATH, e.g. `ctags`. */
  defaultBinary: string;
  /** One-line remediation shown when the binary cannot be found. */
  installHint: string;
}

/** Resolved removable binary, or an actionable error value. */
export type OutlineBinaryResolution = { ok: true; path: string } | { ok: false; error: string };

/** True when `candidate` exists and is executable. */
function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * First executable named `binary` on `pathValue`, or undefined.
 * A relative entry would resolve against the process cwd, which matches exec
 * semantics, so it is accepted as-is.
 */
export function findExecutableOnPath(
  binary: string,
  pathValue: string | undefined,
): string | undefined {
  if (pathValue === undefined || pathValue === "") return undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function formatSpawnFailure(input: {
  binary: string;
  installHint: string;
  error: unknown;
  /** Effective timeout, echoed when the failure is classified as a timeout. */
  timeoutInMs?: number;
}): string {
  if (input.error instanceof Error) {
    const code = errorCode(input.error);
    if (code === "ENOENT") {
      return `Cannot run "${input.binary}": not found. ${input.installHint}`;
    }
    if (isTimeoutError(input.error)) {
      const elapsed = input.timeoutInMs === undefined ? "" : ` after ${input.timeoutInMs} ms`;
      return `Cannot run "${input.binary}": timed out${elapsed}.`;
    }
    const signal = errorSignal(input.error);
    if (signal !== undefined) {
      return `Cannot run "${input.binary}": killed by ${signal}.`;
    }
    const stderr = errorStderr(input.error);
    if (stderr !== undefined && stderr.trim() !== "") {
      return `Cannot run "${input.binary}": ${stderr.trim()}`;
    }
    return `Cannot run "${input.binary}": ${input.error.message}`;
  }
  return `Cannot run "${input.binary}": ${String(input.error)}`;
}

/** Node's `ExecException` carries `code`/`stderr` beyond the Error surface. */
interface ExecErrorFields {
  code?: unknown;
  stderr?: unknown;
  signal?: unknown;
  killed?: unknown;
}

function asExecErrorFields(error: Error): ExecErrorFields {
  return error as ExecErrorFields;
}

/**
 * Classify an `execFile` failure as a timeout.
 *
 * Node 24 does not put the word "timed out" in the error message: on timeout
 * it kills the process with `SIGTERM` and reports `killed: true` with `signal:
 * "SIGTERM"`. Only that combination is a timeout — a parser felled by
 * `SIGSEGV` or an OOM `SIGKILL` also has `signal` set and `code: null`, so
 * treating every signalled death as a timeout would mislabel it.
 */
export function isTimeoutError(error: Error): boolean {
  const fields = asExecErrorFields(error);
  return fields.signal === "SIGTERM" && fields.killed === true;
}

/** Signal that terminated the child, or undefined when it exited normally. */
function errorSignal(error: Error): string | undefined {
  const signal = asExecErrorFields(error).signal;
  return typeof signal === "string" && signal !== "" ? signal : undefined;
}

function errorCode(error: Error): string | undefined {
  const code = asExecErrorFields(error).code;
  return typeof code === "string" ? code : undefined;
}

function errorStderr(error: Error): string | undefined {
  const stderr = asExecErrorFields(error).stderr;
  if (typeof stderr === "string") return stderr;
  if (stderr instanceof Uint8Array) return Buffer.from(stderr).toString("utf8");
  return undefined;
}

/**
 * Resolve an override env var first, then PATH.
 *
 * The override is trusted without an existence check: if it is wrong,
 * `execFile` fails with ENOENT and {@link formatSpawnFailure} turns that
 * into the same actionable message.
 */
export function resolveOutlineBinary(
  spec: OutlineBinarySpec,
  env: NodeJS.ProcessEnv = process.env,
): OutlineBinaryResolution {
  const override = env[spec.envName];
  if (override !== undefined && override.trim() !== "") {
    return { ok: true, path: override };
  }
  const found = findExecutableOnPath(spec.defaultBinary, env.PATH);
  if (found === undefined) {
    return {
      ok: false,
      error: `Cannot run "${spec.defaultBinary}": not found on PATH (set ${spec.envName} to override). ${spec.installHint}`,
    };
  }
  return { ok: true, path: found };
}

/** Arguments for one extractor spawn. */
export interface OutlineSpawnOptions {
  binary: string;
  args: readonly string[];
  /** Hard wall-clock cap for the process, in milliseconds. */
  timeoutInMs: number;
  /** Hard stdout/stderr buffer cap, in bytes. */
  maxBufferBytes: number;
  /** Remediation line folded into the failure text. */
  installHint: string;
}

/**
 * Outcome of one extractor spawn.
 *
 * `ok: false` still carries whatever stdout the process managed to emit before
 * it failed, timed out, or overflowed the buffer: a non-zero exit with
 * parseable partial JSON is a degraded success, and the caller decides whether
 * the recovered bytes are usable. The promise never rejects — every failure is
 * a value.
 */
export type OutlineSpawnOutcome =
  | { ok: true; stdout: string }
  | { ok: false; error: string; stdout: string; timedOut: boolean };

/**
 * Spawn an extractor binary asynchronously so a slow parser cannot block pi's
 * event loop. Uses promisified-style `execFile` (callback seam, no shell) with
 * a hard timeout and buffer cap; the callback is always invoked, so the
 * promise always resolves.
 */
export function spawnOutlineBinary(options: OutlineSpawnOptions): Promise<OutlineSpawnOutcome> {
  return new Promise((resolve) => {
    execFile(
      options.binary,
      [...options.args],
      {
        timeout: options.timeoutInMs,
        maxBuffer: options.maxBufferBytes,
        encoding: "utf8",
      },
      (error, stdout) => {
        const partialStdout = typeof stdout === "string" ? stdout : "";
        if (error === null) {
          resolve({ ok: true, stdout: partialStdout });
          return;
        }
        const timedOut = isTimeoutError(error);
        resolve({
          ok: false,
          error: formatSpawnFailure({
            binary: options.binary,
            installHint: options.installHint,
            error,
            timeoutInMs: options.timeoutInMs,
          }),
          stdout: partialStdout,
          timedOut,
        });
      },
    );
  });
}
