/**
 * Unix-socket protocol and plumbing for the broker (bd-125).
 *
 * One socket per repo scope, newline-delimited JSON, mode 0600 inside a 0700
 * directory. The protocol deliberately exposes a single action that returns
 * credentials (`credential_process`) plus `whoami` for diagnostics: a scope
 * socket is a capability for exactly one source profile, so there is nothing
 * else to ask it.
 *
 * The socket is bound with umask 0177 *and* chmodded 0600 before it is usable,
 * because the network namespace is shared with the sandbox: file mode is the
 * only access control the broker has.
 */

import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { AwsAuditSink } from "./audit.ts";
import type { AwsResult } from "./aws-cli.ts";
import type { CredentialCache } from "./cache.ts";
import { BROKER_DIR_MODE, BROKER_SOCKET_MODE } from "./scope.ts";

/** Actions a scope socket accepts. */
export type BrokerRequest =
  | { action: "credential_process"; profile?: string }
  | { action: "whoami" };

/** Everything a scope socket needs to answer a request. */
export interface ScopeService {
  scopeId: string;
  worktree: string;
  /** Operator allowlist profile, e.g. `agent-readonly`. */
  sourceProfile: string;
  /** Profile the sandbox sees; always `agent` today. */
  sandboxProfile: string;
  cache: CredentialCache;
  audit: AwsAuditSink;
}

/** Parse one NDJSON request line. */
export function parseBrokerRequest(line: string): AwsResult<BrokerRequest> {
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
  if (record.action !== "credential_process") {
    return {
      ok: false,
      error: `unsupported action ${JSON.stringify(record.action)}; this socket only serves "credential_process" and "whoami"`,
    };
  }
  const profile = record.profile;
  if (profile === undefined) return { ok: true, value: { action: "credential_process" } };
  if (typeof profile !== "string") {
    return { ok: false, error: "`profile` must be a string" };
  }
  return { ok: true, value: { action: "credential_process", profile } };
}

function errorResponse(error: string): string {
  return JSON.stringify({ ok: false, error });
}

/**
 * Answer one request. Unknown actions and unknown profiles are refused without
 * ever touching the cache, and every outcome (including refusals) is audited.
 */
export async function handleScopeRequest(options: {
  line: string;
  service: ScopeService;
}): Promise<string> {
  const { service } = options;
  const audit = (action: string, outcome: string): void => {
    service.audit({
      ts: "",
      scope: service.scopeId,
      worktree: service.worktree,
      profile: service.sourceProfile,
      action,
      outcome,
    });
  };

  const request = parseBrokerRequest(options.line);
  if (!request.ok) {
    audit("invalid", "error:invalid-request");
    return errorResponse(request.error);
  }

  if (request.value.action === "whoami") {
    audit("whoami", "ok");
    return JSON.stringify({
      ok: true,
      scope: service.scopeId,
      worktree: service.worktree,
      profile: service.sourceProfile,
      sandboxProfile: service.sandboxProfile,
    });
  }

  const requested = request.value.profile;
  if (requested !== undefined && requested !== service.sandboxProfile) {
    audit("credential_process", "error:unknown-profile");
    return errorResponse(
      `profile ${JSON.stringify(requested)} is not served by this scope (expected ${JSON.stringify(
        service.sandboxProfile,
      )})`,
    );
  }

  const credentials = await service.cache.get(service.sourceProfile);
  if (!credentials.ok) {
    audit("credential_process", "error:unavailable");
    return errorResponse(credentials.error);
  }
  audit("credential_process", "ok");
  return JSON.stringify({ ok: true, credentials: credentials.value });
}

/**
 * Listen on `socketPath` while umask 0177 narrows the socket's creation mode.
 *
 * The restore is one-shot and the `error` listener is detached as soon as the
 * listen callback runs: a later `error` on a *listening* server has nothing to
 * do with the umask window, and re-applying the captured previous value would
 * clobber any legitimate umask change made after the bind.
 */
export function listenWithUmask(server: Server, socketPath: string): Promise<AwsResult<null>> {
  return new Promise<AwsResult<null>>((resolvePromise) => {
    // umask 0177 makes the socket 0600 at creation time, before any client can
    // reach it; the chmod below is the belt-and-braces pass for platforms that
    // ignore the umask.
    const previousUmask = process.umask(0o177);
    let restored = false;
    const restoreUmask = (): void => {
      if (restored) return;
      restored = true;
      process.umask(previousUmask);
    };
    const onError = (error: Error): void => {
      restoreUmask();
      resolvePromise({
        ok: false,
        error: `could not listen on ${socketPath}: ${error.message}`,
      });
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      restoreUmask();
      try {
        chmodSync(socketPath, BROKER_SOCKET_MODE);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolvePromise({ ok: false, error: `could not chmod socket: ${message}` });
        return;
      }
      resolvePromise({ ok: true, value: null });
    });
  });
}

/** Handle for a listening unix socket. */
export interface UnixSocketHandle {
  socketPath: string;
  close: () => Promise<void>;
}

/**
 * True when something is already accepting connections on the socket path.
 *
 * Blindly unlinking would let a second daemon steal a live scope socket (and
 * with it, silently replace the profile that socket serves), so a stale file is
 * distinguished from a live listener by an actual connect attempt.
 */
function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const probe = connect(socketPath);
    const done = (live: boolean): void => {
      probe.destroy();
      resolvePromise(live);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/**
 * Serializes socket preparation and binding for one broker instance.
 *
 * Two things need the same lock: `process.umask()` is process-global, so two
 * overlapping binds would each capture "the previous" value and the second
 * restore can leave the daemon stuck at 0o177 forever; and the stale-socket
 * check + unlink must not interleave with another bind of the same path (the
 * loser would unlink the winner's live socket). One promise chain makes the
 * whole prepare/bind window single-owner, which is what the daemon wants (one
 * control socket plus one socket per scope).
 *
 * The queue is deliberately *not* module-level state: `startDaemon` creates
 * one lock and threads it through every `startUnixSocketServer` call it makes,
 * so two brokers in one process (tests, mostly) cannot deadlock each other and
 * the module stays free of mutable state.
 */
export interface SocketBindLock {
  run: <T>(task: () => Promise<T>) => Promise<T>;
}

/** Create one bind lock; pass the same instance to every socket of a broker. */
export function createSocketBindLock(): SocketBindLock {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    run: <T>(task: () => Promise<T>): Promise<T> => {
      const next = queue.then(task);
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

/** Options for {@link startUnixSocketServer}. */
export interface UnixSocketServerOptions {
  socketPath: string;
  onLine: (line: string) => Promise<string>;
  log?: (message: string) => void;
  /** Bind lock shared by every socket of one broker instance. */
  bindLock: SocketBindLock;
}

/**
 * Bind a newline-delimited-JSON unix socket.
 *
 * A stale socket file from a crashed daemon is unlinked first; a live one is
 * refused so two daemons can never serve the same scope.
 */
export async function startUnixSocketServer(
  options: UnixSocketServerOptions,
): Promise<AwsResult<UnixSocketHandle>> {
  const directory = dirname(options.socketPath);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data: Buffer) => {
      buffer += data.toString("utf-8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void options
          .onLine(line)
          .then((response) => {
            if (!socket.destroyed) socket.write(`${response}\n`);
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            options.log?.(`aws-broker: request failed: ${message}`);
            if (!socket.destroyed) socket.write(`${errorResponse(message)}\n`);
          });
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => {
      options.log?.(`aws-broker: socket error: ${error.message}`);
    });
  });

  const listenResult = await options.bindLock.run(async () => {
    try {
      mkdirSync(directory, { recursive: true, mode: BROKER_DIR_MODE });
      chmodSync(directory, BROKER_DIR_MODE);
      if (existsSync(options.socketPath)) {
        if (await socketIsLive(options.socketPath)) {
          return {
            ok: false as const,
            error: `another process is already listening on ${options.socketPath}`,
          };
        }
        unlinkSync(options.socketPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false as const, error: `could not prepare ${directory}: ${message}` };
    }

    return listenWithUmask(server, options.socketPath);
  });

  if (!listenResult.ok) {
    await closeServer(server, sockets);
    return { ok: false, error: listenResult.error };
  }

  return {
    ok: true,
    value: {
      socketPath: options.socketPath,
      close: () => closeServer(server, sockets),
    },
  };
}

/** Close a server and every live connection so shutdown cannot hang. */
export function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolvePromise());
  });
}
