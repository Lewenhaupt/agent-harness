/**
 * Broker daemon (bd-125).
 *
 * One long-running process owns the control socket and every per-scope
 * credential socket. It is intentionally *not* sandboxed: it must read the
 * operator's `~/.aws` (through the AWS CLI) to resolve credentials, which is
 * exactly what agents may not do. Agents reach it only through a scope socket
 * they are allowed to see.
 *
 * Scopes are started on demand: `ensure-scope` resolves the repo's profile
 * against the operator allowlist, creates the scope dir (synthetic config +
 * shim), and starts a socket bound to that one profile. Fixing the allowlist
 * takes effect on the next `ensure-scope` without restarting the daemon.
 */

import { tmpdir } from "node:os";
import { type AwsAuditSink, createAuditSink, resolveAuditPath } from "./audit.ts";
import { type AwsCredentials, type AwsResult, resolveProfileCredentials } from "./aws-cli.ts";
import { type CredentialCache, createCredentialCache } from "./cache.ts";
import { type AwsSandboxPlan, type ResolveSandboxPlanOptions, resolveSandboxPlan } from "./plan.ts";
import { controlSocketPathFor, isSandboxActive, resolveBrokerRuntimeBaseDir } from "./scope.ts";
import {
  createSocketBindLock,
  handleScopeRequest,
  type ScopeService,
  startUnixSocketServer,
  type UnixSocketHandle,
} from "./server.ts";

/** Requests accepted on the control socket. */
export type ControlRequest = { action: "ensure-scope"; worktree: string } | { action: "whoami" };

/** Parse one control-socket request line. */
export function parseControlRequest(line: string): AwsResult<ControlRequest> {
  const trimmed = line.trim();
  if (trimmed === "") return { ok: false, error: "empty request" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "request is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "request is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.action === "whoami") return { ok: true, value: { action: "whoami" } };
  if (record.action !== "ensure-scope") {
    return {
      ok: false,
      error: `unsupported action ${JSON.stringify(record.action)}; this socket only serves "ensure-scope" and "whoami"`,
    };
  }
  const worktree = record.worktree;
  if (typeof worktree !== "string" || worktree === "") {
    return { ok: false, error: "`worktree` must be a non-empty path" };
  }
  return { ok: true, value: { action: "ensure-scope", worktree } };
}

interface RunningScope {
  plan: AwsSandboxPlan;
  handle: UnixSocketHandle;
  cache: CredentialCache;
}

/** Options for {@link startDaemon}. */
export interface StartDaemonOptions {
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  now?: () => number;
  /** AWS CLI binary; defaults to `aws` on `$PATH`. */
  awsBinary?: string;
  /** Inject the credential resolver (tests use a stub instead of the CLI). */
  resolveCredentials?: (profile: string) => Promise<AwsResult<AwsCredentials>>;
  auditPath?: string;
  /** Broker runtime base override (defaults to `<XDG_RUNTIME_DIR>/belayd/aws`). */
  runtimeBaseDir?: string;
  /** Plan-resolution overrides (bwrap/node/client paths) for tests. */
  planOverrides?: Omit<ResolveSandboxPlanOptions, "worktree" | "env">;
}

/** Handle for a running daemon. */
export interface DaemonHandle {
  controlSocketPath: string;
  close: () => Promise<void>;
}

/** Start the daemon: bind the control socket and serve scope requests. */
export async function startDaemon(options: StartDaemonOptions): Promise<AwsResult<DaemonHandle>> {
  const env = options.env;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const now = options.now ?? Date.now;

  if (isSandboxActive(env)) {
    return {
      ok: false,
      error: "refusing to start the AWS broker inside a belayd AWS sandbox",
    };
  }

  const runtimeBaseDir =
    options.runtimeBaseDir ??
    resolveBrokerRuntimeBaseDir({
      env,
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      temporaryDir: tmpdir(),
    });
  const controlSocketPath = controlSocketPathFor(runtimeBaseDir);
  const audit: AwsAuditSink = createAuditSink({
    auditPath: options.auditPath ?? resolveAuditPath({ env }),
    now,
    onError: log,
  });

  const scopes = new Map<string, RunningScope>();
  // One bind lock for this broker: the control socket and every scope socket
  // share it, so `process.umask()` handling and the stale-socket check stay
  // single-owner without module-level state.
  const bindLock = createSocketBindLock();
  // Serialize scope startup. `ensure-scope` arrives asynchronously on the
  // control socket, so two requests for the same worktree could otherwise race
  // two listeners onto one socket path (the loser also thrashing the
  // process-global umask). One queue keeps the scope map and the socket set
  // consistent and matches the daemon's single-threaded request handler.
  let ensureQueue: Promise<unknown> = Promise.resolve();

  const startScope = async (plan: AwsSandboxPlan): Promise<AwsResult<UnixSocketHandle>> => {
    const resolve =
      options.resolveCredentials ??
      ((profile: string) =>
        resolveProfileCredentials({
          awsBinary: options.awsBinary ?? "aws",
          profile,
        }));
    const cache = createCredentialCache({ resolve, now });
    const service: ScopeService = {
      scopeId: plan.scopeId,
      worktree: plan.worktree,
      sourceProfile: plan.profile,
      sandboxProfile: plan.sandboxProfile,
      cache,
      audit,
    };
    const handle = await startUnixSocketServer({
      socketPath: plan.socketPath,
      onLine: (line) => handleScopeRequest({ line, service }),
      log,
      bindLock,
    });
    if (!handle.ok) return handle;
    scopes.set(plan.scopeId, { plan, handle: handle.value, cache });
    log(
      `aws-broker: scope ${plan.scopeId} serving profile "${plan.profile}" for ${plan.worktree} on ${plan.socketPath}`,
    );
    return handle;
  };

  const ensureScopeOnce = async (worktree: string): Promise<string> => {
    const outcome = resolveSandboxPlan({
      worktree,
      env,
      ...options.planOverrides,
    });
    if (!outcome.ok) {
      audit({
        ts: "",
        scope: "",
        worktree,
        profile: "",
        action: "ensure-scope",
        outcome: `error:${outcome.kind}`,
      });
      return JSON.stringify({ ok: false, kind: outcome.kind, error: outcome.reason });
    }
    const plan = outcome.plan;
    const existing = scopes.get(plan.scopeId);
    if (existing !== undefined && existing.plan.profile === plan.profile) {
      // Same scope, same profile: keep the live socket (and its cache).
      return JSON.stringify({
        ok: true,
        socketPath: existing.handle.socketPath,
        scopeId: plan.scopeId,
        profile: plan.profile,
        sandboxProfile: plan.sandboxProfile,
        region: plan.region,
      });
    }
    if (existing !== undefined) {
      // The allowlist changed under a live scope: replace it so the new
      // profile takes effect without a daemon restart.
      await existing.handle.close();
      existing.cache.clear();
      scopes.delete(plan.scopeId);
    }
    const started = await startScope(plan);
    if (!started.ok) {
      audit({
        ts: "",
        scope: plan.scopeId,
        worktree: plan.worktree,
        profile: plan.profile,
        action: "ensure-scope",
        outcome: "error:listen",
      });
      return JSON.stringify({ ok: false, kind: "unavailable", error: started.error });
    }
    audit({
      ts: "",
      scope: plan.scopeId,
      worktree: plan.worktree,
      profile: plan.profile,
      action: "ensure-scope",
      outcome: "ok",
    });
    return JSON.stringify({
      ok: true,
      socketPath: started.value.socketPath,
      scopeId: plan.scopeId,
      profile: plan.profile,
      sandboxProfile: plan.sandboxProfile,
      region: plan.region,
    });
  };

  /**
   * Queue one control-socket task behind every earlier one.
   *
   * `whoami` goes through the same chain as `ensure-scope`, so it can never
   * observe the `scopes` map mid-replacement (a transiently partial list would
   * be a lie about which scopes are live).
   */
  const queued = <T>(task: () => Promise<T> | T): Promise<T> => {
    const run = ensureQueue.then(() => task());
    ensureQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const ensureScope = (worktree: string): Promise<string> =>
    queued(() => ensureScopeOnce(worktree));

  const control = await startUnixSocketServer({
    socketPath: controlSocketPath,
    log,
    bindLock,
    onLine: async (line) => {
      const request = parseControlRequest(line);
      if (!request.ok) {
        // A malformed control request is still a broker access attempt, and
        // the audit log is the only place it can show up (there is no caller
        // identity on a unix socket).
        audit({
          ts: "",
          scope: "",
          worktree: "",
          profile: "",
          action: "invalid",
          outcome: "error:invalid-request",
        });
        return JSON.stringify({ ok: false, error: request.error });
      }
      if (request.value.action === "whoami") {
        return queued(() => {
          audit({
            ts: "",
            scope: "",
            worktree: "",
            profile: "",
            action: "whoami",
            outcome: "ok",
          });
          return JSON.stringify({
            ok: true,
            pid: process.pid,
            scopes: [...scopes.values()].map((scope) => ({
              scopeId: scope.plan.scopeId,
              worktree: scope.plan.worktree,
              profile: scope.plan.profile,
              sandboxProfile: scope.plan.sandboxProfile,
              socketPath: scope.handle.socketPath,
            })),
          });
        });
      }
      return ensureScope(request.value.worktree);
    },
  });
  if (!control.ok) return { ok: false, error: control.error };

  return {
    ok: true,
    value: {
      controlSocketPath,
      close: async () => {
        for (const scope of scopes.values()) {
          scope.cache.clear();
          await scope.handle.close();
        }
        scopes.clear();
        await control.value.close();
      },
    },
  };
}
