/**
 * `credential_process` client (bd-125).
 *
 * This is the shim botocore runs inside the sandbox. Its contract is strict:
 *
 * - it is exec'd with argv (never a shell), so the entry point must be a real
 *   executable and must not rely on shell syntax;
 * - on success it prints **exactly** one `{"Version":1, …}` document on stdout
 *   and **nothing** on stderr — botocore logs stderr, and a stray line turns a
 *   working credential into a confusing warning;
 * - on failure it prints the broker's message on stderr and exits non-zero;
 * - it never emits partial JSON, so a truncated read can never be mistaken for
 *   a credential document.
 */

import { connect } from "node:net";
import type { AwsCredentials, AwsResult } from "./aws-cli.ts";
import { parseCredentialDocument } from "./aws-cli.ts";
import { isEntrypoint } from "./entrypoint.ts";

/** Default broker round-trip budget for one credential fetch. */
export const CLIENT_TIMEOUT_MS = 20_000;

/** Parse the shim's argv: `--socket <path>`. */
export function parseClientArgv(argv: readonly string[]): AwsResult<{ socketPath: string }> {
  let socketPath: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--socket") {
      const value = argv[index + 1];
      if (value === undefined || value === "") {
        return { ok: false, error: "missing value for --socket" };
      }
      socketPath = value;
      index++;
      continue;
    }
    return {
      ok: false,
      error: `unsupported argument ${JSON.stringify(arg)}; usage: --socket <path>`,
    };
  }
  if (socketPath === undefined) {
    return { ok: false, error: "usage: belayd-aws-credential-process --socket <path>" };
  }
  return { ok: true, value: { socketPath } };
}

/** The exact document botocore expects from a credential_process. */
export function formatCredentialProcessDocument(credentials: AwsCredentials): string {
  return JSON.stringify({
    Version: 1,
    AccessKeyId: credentials.AccessKeyId,
    SecretAccessKey: credentials.SecretAccessKey,
    SessionToken: credentials.SessionToken,
    Expiration: credentials.Expiration,
  });
}

/**
 * Ask the broker for credentials over its newline-delimited JSON socket.
 *
 * The response is validated with the same parser the broker uses, so a
 * malformed or truncated reply fails here rather than inside the SDK.
 */
export function requestCredentialDocument(options: {
  socketPath: string;
  timeoutMs?: number;
}): Promise<AwsResult<AwsCredentials>> {
  const timeoutMs = options.timeoutMs ?? CLIENT_TIMEOUT_MS;
  return new Promise<AwsResult<AwsCredentials>>((resolvePromise) => {
    let buffer = "";
    let settled = false;
    const socket = connect(options.socketPath);
    const timer = setTimeout(() => {
      finish({ ok: false, error: `timed out waiting for the AWS broker on ${options.socketPath}` });
    }, timeoutMs);
    timer.unref();

    const finish = (result: AwsResult<AwsCredentials>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(result);
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ action: "credential_process" })}\n`);
    });
    socket.on("data", (data: Buffer) => {
      buffer += data.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      finish(parseBrokerResponse(buffer.slice(0, newline)));
    });
    socket.on("error", (error: Error) => {
      finish({
        ok: false,
        error: `could not reach the AWS broker at ${options.socketPath}: ${error.message}`,
      });
    });
    socket.on("end", () => {
      finish({
        ok: false,
        error: `the AWS broker at ${options.socketPath} closed the connection without a response`,
      });
    });
  });
}

/** Parse one broker response line. */
export function parseBrokerResponse(line: string): AwsResult<AwsCredentials> {
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
  if (record.ok !== true) {
    const error = record.error;
    return {
      ok: false,
      error:
        typeof error === "string" && error !== "" ? error : "the AWS broker refused the request",
    };
  }
  const credentials = record.credentials;
  if (credentials === undefined || credentials === null || typeof credentials !== "object") {
    return { ok: false, error: "the AWS broker response is missing `credentials`" };
  }
  return parseCredentialDocument(JSON.stringify(credentials));
}

/** IO surface of {@link runCredentialProcess}; injectable for tests. */
export interface CredentialProcessIo {
  argv: readonly string[];
  writeOut: (chunk: string) => void;
  writeErr: (chunk: string) => void;
  request?: (options: { socketPath: string }) => Promise<AwsResult<AwsCredentials>>;
}

/**
 * Run the shim: resolve credentials and write the document, or fail loud.
 *
 * Returns the process exit code (0 success, 1 failure) so the CLI entry point
 * stays a one-liner.
 */
export async function runCredentialProcess(io: CredentialProcessIo): Promise<number> {
  const parsed = parseClientArgv(io.argv);
  if (!parsed.ok) {
    io.writeErr(`belayd-aws-credential-process: ${parsed.error}\n`);
    return 1;
  }
  const request = io.request ?? requestCredentialDocument;
  const result = await request({ socketPath: parsed.value.socketPath });
  if (!result.ok) {
    io.writeErr(`belayd-aws-credential-process: ${result.error}\n`);
    return 1;
  }
  // Single write of a complete document: a partial JSON document must never
  // reach stdout.
  io.writeOut(`${formatCredentialProcessDocument(result.value)}\n`);
  return 0;
}

// The generated per-scope shim runs this file directly (`exec node client.ts
// --socket …`) whenever the Nix wrapper is not available, so it needs its own
// entry guard. Importing it from main.ts must not run anything.
const entry = process.argv[1];
if (isEntrypoint(entry, import.meta.url)) {
  const code = await runCredentialProcess({
    argv: process.argv.slice(2),
    writeOut: (chunk) => process.stdout.write(chunk),
    writeErr: (chunk) => process.stderr.write(chunk),
  });
  process.exitCode = code;
}
