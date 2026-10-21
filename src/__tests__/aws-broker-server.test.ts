import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAuditLine,
  chmodBestEffort,
  createAuditSink,
  formatAuditLine,
  resolveAuditPath,
} from "../aws-broker/audit.js";
import type { AwsCredentials } from "../aws-broker/aws-cli.js";
import { createCredentialCache } from "../aws-broker/cache.js";
import { parseControlRequest, startDaemon } from "../aws-broker/daemon.js";
import { formatPlanOutput, isEntrypoint, parseControlResponse } from "../aws-broker/main.js";
import { scopeIdFor } from "../aws-broker/scope.js";
import {
  closeServer,
  createSocketBindLock,
  handleScopeRequest,
  listenWithUmask,
  parseBrokerRequest,
  type ScopeService,
  startUnixSocketServer,
} from "../aws-broker/server.js";

const CREDENTIALS: AwsCredentials = {
  Version: 1,
  AccessKeyId: "AKIAEXAMPLE",
  SecretAccessKey: "secret",
  SessionToken: "token",
  Expiration: "2099-01-01T00:00:00.000Z",
};

interface AuditLine {
  scope: string;
  profile: string;
  action: string;
  outcome: string;
}

function createService(overrides: Partial<ScopeService> = {}): {
  service: ScopeService;
  audit: AuditLine[];
} {
  const audit: AuditLine[] = [];
  const service: ScopeService = {
    scopeId: "abc123abc123",
    worktree: "/home/hugo/git/acme",
    sourceProfile: "agent-readonly",
    sandboxProfile: "agent",
    cache: createCredentialCache({
      resolve: async () => ({ ok: true, value: CREDENTIALS }),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    }),
    audit: (entry) => audit.push(entry),
    ...overrides,
  };
  return { service, audit };
}

describe("aws-broker server: request parsing", () => {
  it("accepts credential_process with and without a profile, and whoami", () => {
    expect(parseBrokerRequest('{"action":"credential_process"}')).toHaveProperty("ok", true);
    expect(parseBrokerRequest('{"action":"credential_process","profile":"agent"}')).toHaveProperty(
      "ok",
      true,
    );
    expect(parseBrokerRequest('{"action":"whoami"}')).toHaveProperty("ok", true);
  });

  it("refuses unknown actions, malformed JSON, and non-string profiles", () => {
    const unknown = parseBrokerRequest('{"action":"export-everything"}');
    expect(unknown).toHaveProperty("ok", false);
    if (unknown.ok) return;
    expect(unknown.error).toContain("unsupported action");
    expect(parseBrokerRequest("nonsense")).toHaveProperty("ok", false);
    expect(parseBrokerRequest('{"action":"credential_process","profile":7}')).toHaveProperty(
      "ok",
      false,
    );
  });
});

describe("aws-broker server: request handling", () => {
  it("returns credentials for the scope profile and audits the success", async () => {
    const { service, audit } = createService();
    const response = await handleScopeRequest({
      line: '{"action":"credential_process"}',
      service,
    });
    const parsed = JSON.parse(response) as { ok: boolean; credentials: AwsCredentials };
    expect(parsed.ok).toBe(true);
    expect(parsed.credentials).toEqual(CREDENTIALS);
    expect(audit).toEqual([
      {
        ts: "",
        scope: "abc123abc123",
        worktree: "/home/hugo/git/acme",
        profile: "agent-readonly",
        action: "credential_process",
        outcome: "ok",
      },
    ]);
  });

  it("answers whoami with scope metadata only", async () => {
    const { service, audit } = createService();
    const parsed = JSON.parse(
      await handleScopeRequest({ line: '{"action":"whoami"}', service }),
    ) as {
      ok: boolean;
      profile: string;
      sandboxProfile: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.profile).toBe("agent-readonly");
    expect(parsed.sandboxProfile).toBe("agent");
    expect(audit[0]?.action).toBe("whoami");
  });

  it("refuses an unknown profile without touching the cache", async () => {
    const resolve = vi.fn(async () => ({ ok: true, value: CREDENTIALS }) as const);
    const { service, audit } = createService({
      cache: createCredentialCache({ resolve }),
    });
    const parsed = JSON.parse(
      await handleScopeRequest({
        line: '{"action":"credential_process","profile":"agent-deploy"}',
        service,
      }),
    ) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('profile "agent-deploy" is not served by this scope');
    expect(resolve).not.toHaveBeenCalled();
    expect(audit[0]?.outcome).toBe("error:unknown-profile");
  });

  it("refuses an unknown action and audits it as an invalid request", async () => {
    const { service, audit } = createService();
    const parsed = JSON.parse(
      await handleScopeRequest({ line: '{"action":"sts-assume-role"}', service }),
    ) as { ok: boolean };
    expect(parsed.ok).toBe(false);
    expect(audit[0]?.outcome).toBe("error:invalid-request");
  });

  it("surfaces a resolution failure without credentials", async () => {
    const { service, audit } = createService({
      cache: createCredentialCache({
        resolve: async () => ({ ok: false, error: "Token has expired and refresh failed" }),
      }),
    });
    const parsed = JSON.parse(
      await handleScopeRequest({ line: '{"action":"credential_process"}', service }),
    ) as { ok: boolean; error: string; credentials?: unknown };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Token has expired");
    expect(parsed.credentials).toBeUndefined();
    expect(audit[0]?.outcome).toBe("error:unavailable");
  });
});

describe("aws-broker server: unix socket plumbing", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "belayd-aws-server-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * One broker instance's sockets share a bind lock (see server.ts). Tests that
   * exercise concurrency pass the same lock to every call.
   */
  const startServer = (socketPath: string, bindLock = createSocketBindLock()) =>
    startUnixSocketServer({
      socketPath,
      onLine: async () => "{}",
      bindLock,
    });

  it("binds a 0600 socket in a 0700 directory and answers one request", async () => {
    const socketPath = join(root, "scope", "sock");
    const server = await startUnixSocketServer({
      socketPath,
      onLine: async () => JSON.stringify({ ok: true, credentials: CREDENTIALS }),
      bindLock: createSocketBindLock(),
    });
    expect(server.ok).toBe(true);
    if (!server.ok) return;
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "scope")).mode & 0o777).toBe(0o700);

    const response = await new Promise<string>((resolvePromise, reject) => {
      const socket = connect(socketPath, () => {
        socket.write('{"action":"whoami"}\n');
      });
      socket.on("data", (data: Buffer) => {
        socket.end();
        resolvePromise(data.toString("utf-8"));
      });
      socket.on("error", reject);
    });
    expect(JSON.parse(response.trim())).toHaveProperty("ok", true);
    await server.value.close();
  });

  it("unlinks a stale socket file and refuses a second listener on the same path", async () => {
    const socketPath = join(root, "scope", "sock");
    mkdirSync(dirname(socketPath), { recursive: true });
    // Simulate a socket file left behind by a crashed daemon.
    writeFileSync(socketPath, "");
    const bindLock = createSocketBindLock();
    const first = await startServer(socketPath, bindLock);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(statSync(socketPath).isSocket()).toBe(true);

    const second = await startServer(socketPath, bindLock);
    expect(second).toHaveProperty("ok", false);
    await first.value.close();
  });

  it("serializes concurrent binds and always restores the process umask", async () => {
    // process.umask() is process-global: without the bind lock, two overlapping
    // starts capture each other's 0o177 and the daemon is stuck at it forever.
    const originalUmask = process.umask();
    const bindLock = createSocketBindLock();
    const paths = [join(root, "a", "sock"), join(root, "b", "sock")];
    const results = await Promise.all(paths.map((socketPath) => startServer(socketPath, bindLock)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(process.umask()).toBe(originalUmask);
    for (const result of results) {
      if (result.ok) await result.value.close();
    }
  });

  it("restores the process umask once and detaches the listen error listener", async () => {
    // A second `error` after a successful bind must not re-apply the captured
    // previous umask: that would clobber an umask change made after the bind.
    const originalUmask = process.umask();
    const socketPath = join(root, "umask", "sock");
    mkdirSync(dirname(socketPath), { recursive: true });
    const server = createServer();
    try {
      const result = await listenWithUmask(server, socketPath);
      expect(result).toHaveProperty("ok", true);
      expect(process.umask()).toBe(originalUmask);

      const laterUmask = originalUmask === 0o022 ? 0o077 : 0o022;
      process.umask(laterUmask);
      const seen: Error[] = [];
      server.on("error", (error: Error) => seen.push(error));
      server.emit("error", new Error("late error"));
      expect(seen).toHaveLength(1);
      expect(process.umask()).toBe(laterUmask);
    } finally {
      process.umask(originalUmask);
      await closeServer(server, new Set());
    }
  });

  it("lets exactly one of two concurrent starts win the same socket path", async () => {
    const socketPath = join(root, "same", "sock");
    const bindLock = createSocketBindLock();
    const results = await Promise.all([
      startServer(socketPath, bindLock),
      startServer(socketPath, bindLock),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results) {
      if (result.ok) await result.value.close();
    }
  });
});

describe("aws-broker audit log", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "belayd-aws-audit-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves $XDG_STATE_HOME then the home fallback", () => {
    expect(resolveAuditPath({ env: { XDG_STATE_HOME: "/state" }, homeDir: "/home/x" })).toBe(
      "/state/belayd/aws-audit.jsonl",
    );
    expect(resolveAuditPath({ env: {}, homeDir: "/home/x" })).toBe(
      "/home/x/.local/state/belayd/aws-audit.jsonl",
    );
  });

  it("formats exactly the documented keys and never credential material", () => {
    const line = formatAuditLine({
      ts: "2026-01-01T00:00:00.000Z",
      scope: "abc",
      worktree: "/repo",
      profile: "agent-readonly",
      action: "credential_process",
      outcome: "ok",
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ["action", "outcome", "profile", "scope", "ts", "worktree"].sort(),
    );
    expect(line).not.toContain("AKIA");
    expect(line).not.toContain("SecretAccessKey");
  });

  it("appends 0600 JSONL lines, one per request", () => {
    const auditPath = join(root, "belayd", "aws-audit.jsonl");
    const sink = createAuditSink({ auditPath, now: () => Date.parse("2026-01-01T00:00:00.000Z") });
    sink({
      ts: "",
      scope: "abc",
      worktree: "/repo",
      profile: "agent-readonly",
      action: "credential_process",
      outcome: "ok",
    });
    sink({
      ts: "",
      scope: "abc",
      worktree: "/repo",
      profile: "agent-readonly",
      action: "credential_process",
      outcome: "error:unavailable",
    });
    const contents = readFileSync(auditPath, "utf-8");
    expect(contents.trimEnd().split("\n")).toHaveLength(2);
    expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "belayd")).mode & 0o777).toBe(0o700);
    expect(contents).not.toContain("AKIAEXAMPLE");
    expect(contents).not.toContain("SecretAccessKey");
  });

  it("survives an unwritable audit path instead of failing the request", () => {
    const onError = vi.fn();
    const sink = createAuditSink({ auditPath: "/dev/null/audit.jsonl", onError });
    expect(() =>
      sink({
        ts: "",
        scope: "abc",
        worktree: "/repo",
        profile: "agent-readonly",
        action: "credential_process",
        outcome: "ok",
      }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it("creates the file with 0600 on first write even when it does not exist yet", () => {
    const auditPath = join(root, "fresh.jsonl");
    const result = appendAuditLine({
      auditPath,
      entry: {
        ts: "2026-01-01T00:00:00.000Z",
        scope: "abc",
        worktree: "/repo",
        profile: "agent-readonly",
        action: "whoami",
        outcome: "ok",
      },
    });
    expect(existsSync(auditPath)).toBe(true);
    expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    // Nothing to report when the modes could be applied.
    expect(result.warnings).toEqual([]);
  });

  it("reports a mode it could not tighten instead of failing silently", () => {
    // A dangling symlink makes chmod fail deterministically (ENOENT) for any
    // uid, so the diagnostic path is exercised without needing a root-owned
    // file.
    const dangling = join(root, "dangling");
    symlinkSync(join(root, "missing-target"), dangling);
    const warning = chmodBestEffort(dangling, 0o600);
    expect(warning).toBeDefined();
    expect(warning).toContain("could not set mode 600");
    expect(warning).toContain(dangling);
    expect(chmodBestEffort(root, 0o700)).toBeUndefined();
  });
});

describe("aws-broker daemon and CLI plumbing", () => {
  it("refuses to start inside a belayd AWS sandbox", async () => {
    // The broker must read the operator's ~/.aws, so it can never run under the
    // mask that hides it. Fail closed before touching the runtime dir.
    const result = await startDaemon({ env: { BELAYD_SANDBOX_ACTIVE: "1" } });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("refusing to start the AWS broker");
  });

  it("parses control requests", () => {
    const ensure = parseControlRequest('{"action":"ensure-scope","worktree":"/repo"}');
    expect(ensure.ok).toBe(true);
    if (!ensure.ok) return;
    expect(ensure.value).toEqual({ action: "ensure-scope", worktree: "/repo" });
    expect(parseControlRequest('{"action":"whoami"}')).toHaveProperty("ok", true);
    expect(parseControlRequest('{"action":"ensure-scope"}')).toHaveProperty("ok", false);
    expect(parseControlRequest('{"action":"drop-table"}')).toHaveProperty("ok", false);
  });

  it("parses control responses, surfacing broker errors", () => {
    const ok = parseControlResponse('{"ok":true,"socketPath":"/run/x/sock"}');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value).toHaveProperty("socketPath", "/run/x/sock");
    const failed = parseControlResponse('{"ok":false,"error":"not covered by any scope"}');
    expect(failed).toHaveProperty("ok", false);
    if (failed.ok) return;
    expect(failed.error).toContain("not covered by any scope");
  });

  it("formats plan output as NUL-separated argv for the shell wrapper", () => {
    const plan = {
      worktree: "/repo",
      scopeId: scopeIdFor("/repo"),
      scopeDir: "/run/x/scope",
      socketPath: "/run/x/scope/sock",
      profile: "agent-readonly",
      sandboxProfile: "agent",
      region: "eu-north-1",
      argvPrefix: ["bwrap", "--unshare-user"],
    };
    expect(formatPlanOutput(plan, true)).toBe("bwrap\0--unshare-user\0");
    expect(formatPlanOutput(plan, false)).toBe("bwrap\n--unshare-user\n");
  });

  it("detects its own entry point", () => {
    expect(
      isEntrypoint("/repo/src/aws-broker/main.ts", "file:///repo/src/aws-broker/main.ts"),
    ).toBe(true);
    expect(isEntrypoint(undefined, "file:///repo/src/aws-broker/main.ts")).toBe(false);
    expect(isEntrypoint("/other/main.ts", "file:///repo/src/aws-broker/main.ts")).toBe(false);
  });
});
