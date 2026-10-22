import { describe, expect, it, vi } from "vitest";
import {
  buildExportCredentialsArgv,
  describeAwsFailure,
  parseCredentialDocument,
  resolveProfileCredentials,
} from "../aws-broker/aws-cli.js";
import {
  formatCredentialProcessDocument,
  parseBrokerResponse,
  parseClientArgv,
  runCredentialProcess,
} from "../aws-broker/client.js";

const DOCUMENT = {
  Version: 1 as const,
  AccessKeyId: "AKIAEXAMPLE",
  SecretAccessKey: "secret",
  SessionToken: "token",
  Expiration: "2026-01-01T08:00:00.000Z",
};

describe("aws-broker client: argv and document", () => {
  it("parses --socket and rejects anything else", () => {
    const parsed = parseClientArgv(["--socket", "/run/x/sock"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.socketPath).toBe("/run/x/sock");
    expect(parseClientArgv([])).toHaveProperty("ok", false);
    expect(parseClientArgv(["--socket"])).toHaveProperty("ok", false);
    expect(parseClientArgv(["--socket", "/x", "extra"])).toHaveProperty("ok", false);
  });

  it("emits exactly the credential_process document with Version 1", () => {
    const line = formatCredentialProcessDocument(DOCUMENT);
    expect(JSON.parse(line)).toEqual({
      Version: 1,
      AccessKeyId: "AKIAEXAMPLE",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: "2026-01-01T08:00:00.000Z",
    });
    expect(line).not.toContain("\n");
  });

  it("writes one complete document to stdout and nothing to stderr on success", async () => {
    const writeOut = vi.fn();
    const writeErr = vi.fn();
    const code = await runCredentialProcess({
      argv: ["--socket", "/run/x/sock"],
      writeOut,
      writeErr,
      request: async () => ({ ok: true, value: DOCUMENT }),
    });
    expect(code).toBe(0);
    expect(writeErr).not.toHaveBeenCalled();
    expect(writeOut).toHaveBeenCalledTimes(1);
    const written = writeOut.mock.calls[0]?.[0];
    if (typeof written !== "string") throw new Error("writeOut was not called with a string");
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written.trim())).toHaveProperty("Version", 1);
  });

  it("fails non-zero with the broker's message and no stdout", async () => {
    const writeOut = vi.fn();
    const writeErr = vi.fn();
    const code = await runCredentialProcess({
      argv: ["--socket", "/run/x/sock"],
      writeOut,
      writeErr,
      request: async () => ({ ok: false, error: "Token has expired and refresh failed" }),
    });
    expect(code).toBe(1);
    expect(writeOut).not.toHaveBeenCalled();
    expect(writeErr).toHaveBeenCalledTimes(1);
    expect(writeErr.mock.calls[0]?.[0]).toContain("Token has expired and refresh failed");
  });

  it("never emits partial JSON when argv is invalid", async () => {
    const writeOut = vi.fn();
    const writeErr = vi.fn();
    const code = await runCredentialProcess({ argv: [], writeOut, writeErr });
    expect(code).toBe(1);
    expect(writeOut).not.toHaveBeenCalled();
    expect(writeErr).toHaveBeenCalled();
  });

  it("parses broker responses, including refusals and malformed payloads", () => {
    const ok = parseBrokerResponse(JSON.stringify({ ok: true, credentials: DOCUMENT }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.AccessKeyId).toBe("AKIAEXAMPLE");

    const refused = parseBrokerResponse(JSON.stringify({ ok: false, error: "nope" }));
    expect(refused).toHaveProperty("ok", false);
    if (refused.ok) return;
    expect(refused.error).toBe("nope");

    expect(parseBrokerResponse("not json")).toHaveProperty("ok", false);
    expect(parseBrokerResponse(JSON.stringify({ ok: true }))).toHaveProperty("ok", false);
  });
});

describe("aws-broker aws-cli", () => {
  it("builds an argv-only export-credentials call", () => {
    expect(buildExportCredentialsArgv({ awsBinary: "aws", profile: "agent-readonly" })).toEqual([
      "aws",
      "configure",
      "export-credentials",
      "--profile",
      "agent-readonly",
      "--format",
      "process",
    ]);
  });

  it("accepts and normalizes a valid document", () => {
    const parsed = parseCredentialDocument(JSON.stringify(DOCUMENT));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveProperty("Version", 1);
    expect(parsed.value.Expiration).toBe("2026-01-01T08:00:00.000Z");
  });

  it("normalizes a +00:00 expiration to the ISO-8601 Z form", () => {
    const parsed = parseCredentialDocument(
      JSON.stringify({ ...DOCUMENT, Expiration: "2026-01-01T08:00:00+00:00" }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.Expiration).toBe("2026-01-01T08:00:00.000Z");
  });

  it("rejects malformed documents without echoing the payload", () => {
    const cases = [
      "",
      "not json",
      JSON.stringify({ ...DOCUMENT, Version: 2 }),
      JSON.stringify({ ...DOCUMENT, AccessKeyId: "" }),
      JSON.stringify({ ...DOCUMENT, Expiration: "yesterday" }),
      JSON.stringify([DOCUMENT]),
    ];
    for (const raw of cases) {
      const parsed = parseCredentialDocument(raw);
      expect(parsed).toHaveProperty("ok", false);
      if (parsed.ok) continue;
      expect(parsed.error).not.toContain("AKIAEXAMPLE");
      expect(parsed.error).not.toContain("secret");
    }
  });

  it("refuses long-lived (IAM-user) credentials with an actionable message", () => {
    // `aws configure export-credentials --format process` omits SessionToken and
    // Expiration for static keys; the broker only serves temporary SSO creds.
    const staticOnly = parseCredentialDocument(
      JSON.stringify({
        Version: 1,
        AccessKeyId: "AKIAEXAMPLE",
        SecretAccessKey: "secret",
      }),
    );
    expect(staticOnly).toHaveProperty("ok", false);
    if (staticOnly.ok) return;
    expect(staticOnly.error).toContain("long-lived credentials");
    expect(staticOnly.error).toContain("temporary/role credentials");
    expect(staticOnly.error).toContain("IAM RolesAnywhere");
    expect(staticOnly.error).toContain(".belayd/aws.yaml");

    const missingExpiration = parseCredentialDocument(
      JSON.stringify({ ...DOCUMENT, Expiration: "" }),
    );
    expect(missingExpiration).toHaveProperty("ok", false);
    if (missingExpiration.ok) return;
    expect(missingExpiration.error).toContain("Expiration");
  });

  it("maps botocore failures to AWS's verbatim text plus the login instruction", () => {
    const message = describeAwsFailure({
      profile: "agent-readonly",
      stderr: "Token has expired and refresh failed\n",
      exitCode: 255,
    });
    expect(message).toContain("Token has expired and refresh failed");
    expect(message).toContain("exit 255");
    expect(message).toContain("aws sso login --profile agent-readonly");
    expect(message).toContain("on the host");
  });

  it("does not prescribe an SSO login for a non-SSO failure", () => {
    // An IAM RolesAnywhere profile fails for reasons `aws sso login` cannot
    // fix (missing helper, expired x509 material, wrong ARN). AWS's own text
    // stays verbatim and the hint points at those, not at the SSO command.
    const message = describeAwsFailure({
      profile: "dev-agent",
      stderr:
        "An error occurred (InvalidSignatureException) when calling the CreateSession operation: Signature expired\n",
      exitCode: 255,
    });
    expect(message).toContain("InvalidSignatureException");
    expect(message).not.toContain("aws sso login");
    expect(message).toContain("credential_process");
    expect(message).toContain("IAM RolesAnywhere");
    expect(message).toContain("trust anchor / profile / role ARNs");
  });

  it("resolves credentials through the injected spawner and fails loud", async () => {
    const spawnCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(DOCUMENT),
      stderr: "",
    }));
    const resolved = await resolveProfileCredentials({
      awsBinary: "aws",
      profile: "agent-readonly",
      spawnCommand,
    });
    expect(resolved.ok).toBe(true);
    expect(spawnCommand).toHaveBeenCalledWith([
      "aws",
      "configure",
      "export-credentials",
      "--profile",
      "agent-readonly",
      "--format",
      "process",
    ]);

    const failed = await resolveProfileCredentials({
      awsBinary: "aws",
      profile: "agent-readonly",
      spawnCommand: async () => ({
        exitCode: 255,
        stdout: "",
        stderr: "Error loading SSO Token: The SSO session has expired",
      }),
    });
    expect(failed).toHaveProperty("ok", false);
    if (failed.ok) return;
    expect(failed.error).toContain("Error loading SSO Token");
    expect(failed.error).toContain("aws sso login --profile agent-readonly");
  });

  it("turns a spawner exception into a message instead of throwing", async () => {
    const failed = await resolveProfileCredentials({
      awsBinary: "aws",
      profile: "agent-readonly",
      spawnCommand: async () => {
        throw new Error("spawn aws ENOENT");
      },
    });
    expect(failed).toHaveProperty("ok", false);
    if (failed.ok) return;
    expect(failed.error).toContain("spawn aws ENOENT");
  });
});
