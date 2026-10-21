/**
 * Credential resolution for the broker, delegated to the AWS CLI (bd-125).
 *
 * The broker never parses `~/.aws/sso/cache` itself: that cache layout is a
 * botocore internal (CLI >= 2.22 splits token and client-registration files),
 * and `aws configure export-credentials --format process` already returns
 * exactly the `credential_process` document. The CLI is spawned with argv only
 * (no shell), which is also the contract the shim owes botocore.
 */

import { execFile } from "node:child_process";

/** The `credential_process` document (Version 1). */
export interface AwsCredentials {
  Version: 1;
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  /** ISO-8601 UTC timestamp, normalized to the `toISOString` form. */
  Expiration: string;
}

/** Result of a broker operation: value or a human-actionable message. */
export type AwsResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Outcome of one spawned AWS CLI invocation. */
export interface AwsCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable spawner so cache/cli tests never shell out. */
export type SpawnAwsCommand = (argv: readonly string[]) => Promise<AwsCommandResult>;

function ok<T>(value: T): AwsResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): AwsResult<T> {
  return { ok: false, error };
}

/** Argv for the export-credentials call. Never a shell string. */
export function buildExportCredentialsArgv(options: {
  awsBinary: string;
  profile: string;
}): string[] {
  return [
    options.awsBinary,
    "configure",
    "export-credentials",
    "--profile",
    options.profile,
    "--format",
    "process",
  ];
}

/**
 * Validate a `--format process` document.
 *
 * Only *temporary* credentials are accepted: the broker exists to hand a repo a
 * scoped SSO/assumed-role identity, and `aws configure export-credentials
 * --format process` omits `SessionToken`/`Expiration` for long-lived IAM-user
 * keys. A static-credential profile is refused with a message that names the
 * real fix (use an SSO profile) instead of failing forever on a missing field.
 *
 * Failure messages deliberately never echo the payload: stdout can contain
 * live credentials, and the broker's errors are surfaced in tool output and
 * audit lines.
 */
export function parseCredentialDocument(stdout: string): AwsResult<AwsCredentials> {
  const trimmed = stdout.trim();
  if (trimmed === "") return fail("aws returned an empty credential document");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return fail("aws returned malformed JSON for the credential document");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("aws credential document is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.Version !== 1) {
    return fail("aws credential document is missing `Version: 1`");
  }
  const {
    AccessKeyId: accessKeyId,
    SecretAccessKey: secretAccessKey,
    SessionToken: sessionToken,
    Expiration: expiration,
  } = record;
  if (typeof accessKeyId !== "string" || accessKeyId === "") {
    return fail("aws credential document is missing a non-empty `AccessKeyId`");
  }
  if (typeof secretAccessKey !== "string" || secretAccessKey === "") {
    return fail("aws credential document is missing a non-empty `SecretAccessKey`");
  }
  if (typeof sessionToken !== "string" || sessionToken === "") {
    return fail(
      "aws returned long-lived credentials (no `SessionToken`); the belayd broker only serves temporary SSO credentials — point this repo's `.belayd/aws.yaml` at an SSO/assumed-role profile",
    );
  }
  if (typeof expiration !== "string" || expiration === "") {
    return fail("aws credential document is missing `Expiration` (required with a `SessionToken`)");
  }
  const expiresAt = new Date(expiration);
  if (Number.isNaN(expiresAt.getTime())) {
    return fail("aws credential document has a non-ISO-8601 `Expiration`");
  }
  return ok({
    Version: 1,
    AccessKeyId: accessKeyId,
    SecretAccessKey: secretAccessKey,
    SessionToken: sessionToken,
    Expiration: expiresAt.toISOString(),
  });
}

/** Botocore messages that mean "the operator must run aws sso login again". */
const EXPIRY_PATTERNS: readonly RegExp[] = [
  /token has expired/i,
  /sso session .* expired/i,
  /error loading sso token/i,
  /failed to refresh sso token/i,
  /refresh failed/i,
];

/** Turn a failed AWS CLI invocation into an actionable message. */
export function describeAwsFailure(options: {
  profile: string;
  stderr: string;
  exitCode: number | null;
}): string {
  // Surface AWS's own text verbatim: it is the only place the real cause
  // (expired portal session, missing registration, wrong role) is named.
  const verbatim = options.stderr.trim();
  const detail = verbatim === "" ? "(aws wrote no error text)" : verbatim;
  const exit = options.exitCode === null ? "killed" : `exit ${options.exitCode}`;
  const expiryHint = EXPIRY_PATTERNS.some((pattern) => pattern.test(verbatim))
    ? "\nThe IAM Identity Center session is no longer valid. Refresh it on the host, outside every sandbox: aws sso login --profile "
    : "\nIf the profile's SSO session or client registration expired, refresh it on the host, outside every sandbox: aws sso login --profile ";
  return `aws failed for profile "${options.profile}" (${exit}): ${detail}${expiryHint}${options.profile}`;
}

/** Default spawner: `execFile`, argv only, no shell. */
export const defaultSpawnAwsCommand: SpawnAwsCommand = (argv) =>
  new Promise<AwsCommandResult>((resolvePromise) => {
    const [binary, ...args] = argv;
    if (binary === undefined) {
      resolvePromise({ exitCode: null, stdout: "", stderr: "empty aws argv" });
      return;
    }
    execFile(
      binary,
      args,
      { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        const exitCode =
          error === null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : typeof error.code === "string"
                ? 127
                : null;
        resolvePromise({ exitCode, stdout, stderr });
      },
    );
  });

/**
 * Resolve one profile's credentials through the AWS CLI.
 *
 * No retries: the broker retries nothing, because an expired SSO session is a
 * human-in-the-loop state and a silent retry would only add latency before the
 * same loud failure.
 */
export async function resolveProfileCredentials(options: {
  awsBinary: string;
  profile: string;
  spawnCommand?: SpawnAwsCommand;
}): Promise<AwsResult<AwsCredentials>> {
  const spawnCommand = options.spawnCommand ?? defaultSpawnAwsCommand;
  let result: AwsCommandResult;
  try {
    result = await spawnCommand(
      buildExportCredentialsArgv({ awsBinary: options.awsBinary, profile: options.profile }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`could not run aws for profile "${options.profile}": ${message}`);
  }
  if (result.exitCode !== 0) {
    return fail(
      describeAwsFailure({
        profile: options.profile,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }),
    );
  }
  return parseCredentialDocument(result.stdout);
}
