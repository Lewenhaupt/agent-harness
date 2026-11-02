/**
 * Member-owned control socket (bd-186).
 *
 * A durable member's storage has exactly one writer, so interactive control
 * (steer/abort while it runs) cannot be a file: the caller needs an answer. Each
 * member owns one unix socket at `<memberStateDir>/control.sock` (mode 0600) and
 * one credential file **per authenticatable tier**:
 * `<memberStateDir>/control.panel.token` and
 * `<memberStateDir>/control.supervisor.token` (both mode 0600, stable across
 * restarts). There is no `phase-subagent` credential: that tier cannot
 * authenticate at all. An optional TCP fallback binds `127.0.0.1` only and
 * publishes its owner-chosen port in `<memberStateDir>/control.port`, so clients
 * never learn the port from a browser request — nothing here can listen on, or
 * be pointed at, another host.
 *
 * **Choice: one listener, credential→tier.** The single socket serves the tiers
 * the owner passes in `tiers`, and the auth handshake derives the connection's
 * tier from *which credential matched* (constant-time compare against every
 * served candidate, no early exit, one generic `unauthorized` answer). The
 * tier is therefore decided by the credential, not by the frame or by the
 * server's configuration alone. A frame whose `authority` claim differs from the
 * credential-derived tier is refused with `authority-mismatch` before the
 * dispatcher is reached, and `dispatch.ts` re-checks the same claim.
 *
 * Trust boundary, stated honestly: this stops cross-tier wiring mistakes — a
 * supervisor client pointed at the panel surface, a replayed or mis-tiered
 * mailbox file, a frame that relabels its own role. It does **not** stop a
 * hostile same-uid process, which can read the other tier's 0600 credential and
 * present it. It is a coordination boundary inside one user account, not a
 * privilege boundary between users.
 *
 * The first frame must be `{"type":"auth","token":...}`; anything else is
 * rejected and the channel closes before a command frame is parsed, so an
 * unauthenticated caller cannot even probe the command schema.
 *
 * // SYNC WARNING: this wire protocol is mirrored in plain JS at
 * // `pi-web-plugins/durable-member/control-client.js` (the pi-web server module
 * // and the supervisor-side client cannot import TypeScript): the
 * // `control.<suffix>.token` / `control.sock` / `control.port` names, the
 * // credential→tier derivation, the auth-then-command frame order, the 256 KiB
 * // frame bound, the `authority-mismatch` check and the `auth-ack` /
 * // `command-result` / `error` response shapes. Any change here must be mirrored
 * // there and vice versa.
 *
 * NDJSON framing is bounded: a frame larger than {@link MAX_CONTROL_FRAME_BYTES}
 * is refused instead of buffered indefinitely.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, Socket } from "node:net";
import { join } from "node:path";
import { bindOwnerAuthority, type VerifiedAuthority, verifyAuthorityClaim } from "./authority.js";
import {
  AUTHORITY_CREDENTIAL_SUFFIXES,
  type AuthenticatableAuthority,
  type DurableCommand,
  isAuthenticatableAuthority,
  validateDurableCommand,
} from "./commands.js";
import type { DurableDispatcher } from "./dispatch.js";

/** Socket filename inside the member state dir (one listener serves all tiers). */
export const CONTROL_SOCKET_FILE = "control.sock";

/** Published TCP fallback port filename inside the member state dir. */
export const CONTROL_PORT_FILE = "control.port";

/** Largest single NDJSON frame the server buffers or the client sends. */
export const MAX_CONTROL_FRAME_BYTES = 256 * 1024;

/** Default client deadline for one request/response round trip. */
export const DEFAULT_CONTROL_TIMEOUT_MS = 5000;

/** Unix socket paths are length-limited by the OS; fail early with guidance. */
const MAX_UNIX_SOCKET_PATH = 100;

/** Stable socket/protocol error codes, mirrored in the plain-JS client. */
export const CONTROL_ERROR_CODES = [
  "unauthorized",
  "authority-mismatch",
  "invalid-frame",
  "frame-too-large",
  "invalid-command",
  "timeout",
  "socket-unavailable",
  "protocol-error",
] as const;

export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

export function isControlErrorCode(value: unknown): value is ControlErrorCode {
  return CONTROL_ERROR_CODES.some((code) => code === value);
}

/** Frames the server writes. */
export type ControlServerFrame =
  | { readonly type: "auth-ack"; readonly ok: true }
  | {
      readonly type: "command-result";
      readonly ok: true;
      readonly requestId: string;
      readonly duplicate: boolean;
    }
  | {
      readonly type: "error";
      readonly requestId?: string;
      readonly code: ControlErrorCode;
      readonly error: string;
    };

/** Where a member's control surface lives. Unix is the default and the only local one. */
export type ControlTarget =
  | { readonly transport: "unix"; readonly path: string }
  | { readonly transport: "tcp"; readonly host: "127.0.0.1"; readonly port: number };

export type ControlClientResult =
  | { readonly ok: true; readonly requestId: string; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: ControlErrorCode; readonly error: string };

/** One credential file per authenticatable tier. */
export function memberControlTokenPath(
  stateDir: string,
  authority: AuthenticatableAuthority,
): string {
  return join(stateDir, `control.${AUTHORITY_CREDENTIAL_SUFFIXES[authority]}.token`);
}

export function memberControlSocketPath(stateDir: string): string {
  return join(stateDir, CONTROL_SOCKET_FILE);
}

export function memberControlPortPath(stateDir: string): string {
  return join(stateDir, CONTROL_PORT_FILE);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Create the state dir with the tightest mode the member storage uses. */
function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
}

/**
 * Read one tier's credential, creating it on first use.
 *
 * The credential is state, not a per-connection nonce: a client that queued a
 * command while the member was down needs the same secret when the member
 * starts, and a restart must not invalidate a panel that is already open.
 * Nothing rotates it, because there is exactly one writer to coordinate.
 */
export function ensureControlToken(
  stateDir: string,
  authority: AuthenticatableAuthority,
): { readonly ok: true; readonly token: string } | { readonly ok: false; readonly error: string } {
  const path = memberControlTokenPath(stateDir, authority);
  try {
    ensureStateDir(stateDir);
    const existing = readTokenIfPresent(path);
    if (existing !== undefined) return { ok: true, token: existing };
    const token = randomBytes(32).toString("hex");
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return { ok: true, token };
  } catch (error) {
    return { ok: false, error: `could not prepare ${path}: ${errorMessage(error)}` };
  }
}

/** A first run has no credential yet; that is not an error, it is the create case. */
function readTokenIfPresent(path: string): string | undefined {
  try {
    const token = readFileSync(path, "utf8").trim();
    return token === "" ? undefined : token;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export function readControlToken(
  stateDir: string,
  authority: AuthenticatableAuthority,
): { readonly ok: true; readonly token: string } | { readonly ok: false; readonly error: string } {
  const path = memberControlTokenPath(stateDir, authority);
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token === "") return { ok: false, error: `${path} is empty` };
    return { ok: true, token };
  } catch (error) {
    return { ok: false, error: `could not read ${path}: ${errorMessage(error)}` };
  }
}

/** Publish the owner-chosen TCP fallback port so clients never guess it. */
export function publishControlPort(
  stateDir: string,
  port: number,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  const path = memberControlPortPath(stateDir);
  try {
    ensureStateDir(stateDir);
    writeFileSync(path, `${port}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: `could not publish ${path}: ${errorMessage(error)}` };
  }
}

function readPublishedControlPort(stateDir: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(memberControlPortPath(stateDir), "utf8").trim();
  } catch {
    return undefined;
  }
  if (!/^[0-9]+$/.test(text)) return undefined;
  const port = Number(text);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/**
 * Resolve where a member's control surface listens.
 *
 * Clients read the owner-published port file instead of accepting a port from a
 * caller (a browser request must not be able to point a member credential at an
 * arbitrary loopback port).
 */
export function readMemberControlTarget(stateDir: string): ControlTarget {
  const port = readPublishedControlPort(stateDir);
  if (port !== undefined) return { transport: "tcp", host: "127.0.0.1", port };
  return { transport: "unix", path: memberControlSocketPath(stateDir) };
}

/** Constant-time comparison; a length mismatch is simply false. */
function tokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string") return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * The one answer for every failed authentication.
 *
 * Identical for a missing, malformed, oversized or merely wrong credential: the
 * token-length and frame-size bounds are DoS guards, not diagnostics, so a
 * rejection must not tell the caller which check refused it.
 */
const AUTH_FAILURE_MESSAGE = "credential does not match any tier this surface serves";

/**
 * Read the auth frame, enforcing the token-length DoS bound.
 *
 * The reason for a rejection is deliberately not returned: every caller failure
 * has to collapse into {@link AUTH_FAILURE_MESSAGE} anyway, so a per-check
 * message would only be a diagnostic the surface must not emit.
 */
function parseAuthFrame(raw: unknown): { ok: true; token: string } | { ok: false } {
  if (!isRecord(raw)) return { ok: false };
  if (raw.type !== "auth") return { ok: false };
  if (typeof raw.token !== "string" || raw.token === "" || raw.token.length > 1024) {
    return { ok: false };
  }
  return { ok: true, token: raw.token };
}

/** One tier this listener is willing to serve, with its credential and writer. */
export interface ControlServedTier {
  readonly authority: AuthenticatableAuthority;
  readonly dispatcher: DurableDispatcher;
}

interface ServedCredential {
  readonly authority: AuthenticatableAuthority;
  readonly credential: string;
  readonly dispatcher: DurableDispatcher;
}

/**
 * Derive the tier from the presented credential.
 *
 * Every candidate is compared and the pick is a single assignment *after* the
 * comparisons, so "all comparisons run, no early exit" holds by the shape of the
 * code rather than by how the comparisons happen to behave: there is no
 * per-candidate branch that could skip the remaining candidates. `tokenMatches`
 * itself stays constant time, which is what makes the ordering unobservable.
 *
 * The failure is one generic `undefined` — the caller cannot learn which tier
 * was compared or how close the credential was.
 */
function deriveServedTier(
  served: readonly ServedCredential[],
  presented: unknown,
): ServedCredential | undefined {
  const matches = served.filter((candidate) => tokenMatches(candidate.credential, presented));
  const [matchedTier] = matches;
  return matchedTier;
}

type ParsedCommandFrame =
  | { readonly ok: true; readonly command: DurableCommand }
  | { readonly ok: false; readonly code: ControlErrorCode; readonly error: string };

/**
 * Validate one command frame and integrity-check its authority claim against the
 * credential-derived tier. A disagreement is refused before the dispatcher (and
 * therefore the writer) is reached.
 */
function parseCommandFrame(
  raw: unknown,
  memberId: string,
  authority: VerifiedAuthority,
): ParsedCommandFrame {
  if (!isRecord(raw)) {
    return { ok: false, code: "invalid-frame", error: "command frame must be an object" };
  }
  if (raw.type !== "command") {
    return { ok: false, code: "invalid-frame", error: "expected a command frame" };
  }
  const validated = validateDurableCommand(raw.command, { memberId });
  if (!validated.ok) return { ok: false, code: "invalid-command", error: validated.error };
  const claim = verifyAuthorityClaim(authority, validated.value.authority);
  return claim.ok
    ? { ok: true, command: validated.value }
    : { ok: false, code: claim.reason, error: claim.error };
}

export interface ControlServerOptions {
  readonly stateDir: string;
  readonly memberId: string;
  /**
   * The tiers this listener serves. Credentials are created only for these
   * tiers; a presented credential selects one of them.
   */
  readonly tiers: readonly ControlServedTier[];
  readonly transport?: "unix" | "tcp";
  /** TCP fallback port; 0 asks the OS for one. Ignored for unix. */
  readonly port?: number;
  readonly maxFrameBytes?: number;
}

export type ControlServerStart =
  | {
      readonly ok: true;
      readonly address: ControlTarget;
      readonly credentials: readonly {
        readonly authority: AuthenticatableAuthority;
        readonly token: string;
      }[];
      /** Idempotent; closes the listener and removes its socket/port file. */
      close(): Promise<void>;
    }
  | { readonly ok: false; readonly error: string };

function writeFrame(socket: Socket, frame: ControlServerFrame): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(frame)}\n`);
}

type NormalizedTiers =
  | { readonly ok: true; readonly tiers: readonly ControlServedTier[] }
  | { readonly ok: false; readonly error: string };

/** Refuse an empty, duplicate, non-authenticatable or mismatched tier setup. */
function normalizeServedTiers(tiers: readonly ControlServedTier[]): NormalizedTiers {
  if (tiers.length === 0) return { ok: false, error: "at least one served tier is required" };
  const seen = new Set<AuthenticatableAuthority>();
  for (const tier of tiers) {
    if (!isAuthenticatableAuthority(tier.authority)) {
      return {
        ok: false,
        error: `${String(tier.authority)} cannot authenticate on the control socket`,
      };
    }
    if (seen.has(tier.authority)) {
      return { ok: false, error: `duplicate served tier ${tier.authority}` };
    }
    if (tier.dispatcher.authority !== tier.authority) {
      return {
        ok: false,
        error: `dispatcher serves ${tier.dispatcher.authority}, tier is ${tier.authority}`,
      };
    }
    seen.add(tier.authority);
  }
  return { ok: true, tiers };
}

/**
 * Start the control surface for one member.
 *
 * The listener serves the configured tiers; the auth handshake binds each
 * connection to the tier its credential proves, and only that tier's dispatcher
 * can be reached. No command is applied without a successful auth frame, and no
 * frame is applied without passing the owner's member and tier checks.
 */
export async function startControlServer(
  options: ControlServerOptions,
): Promise<ControlServerStart> {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_CONTROL_FRAME_BYTES;
  const normalized = normalizeServedTiers(options.tiers);
  if (!normalized.ok) return normalized;

  const served: ServedCredential[] = [];
  for (const tier of normalized.tiers) {
    const credential = ensureControlToken(options.stateDir, tier.authority);
    if (!credential.ok) return credential;
    served.push({
      authority: tier.authority,
      credential: credential.token,
      dispatcher: tier.dispatcher,
    });
  }

  if ((options.transport ?? "unix") === "unix") {
    const prepared = prepareUnixSocketPath(options.stateDir);
    if (!prepared.ok) return prepared;
  }

  const server: Server = createServer();
  server.on("connection", (connection) => {
    handleConnection(connection, {
      memberId: options.memberId,
      served,
      maxFrameBytes,
    });
  });

  const listened = await bindListener(server, options);
  if (!listened.ok) {
    if (server.listening) server.close();
    return { ok: false, error: listened.error };
  }

  const published = await restrictPublishedListener(server, options.stateDir, listened.address);
  if (!published.ok) return { ok: false, error: published.error };

  return {
    ok: true,
    address: listened.address,
    credentials: served.map((tier) => ({ authority: tier.authority, token: tier.credential })),
    close: () => closeServer(server, published.socketPath, published.portPath),
  };
}

function bindListener(server: Server, options: ControlServerOptions): Promise<ListenOutcome> {
  return (options.transport ?? "unix") === "tcp"
    ? listenServer(server, { host: "127.0.0.1", port: options.port ?? 0 })
    : listenServer(server, { path: memberControlSocketPath(options.stateDir) });
}

type ListenerFiles =
  | { readonly ok: true; readonly socketPath?: string; readonly portPath?: string }
  | { readonly ok: false; readonly error: string };

/**
 * Apply the mode and publish the owner-chosen address after the listener binds.
 * A failure here closes the listener before returning the error value.
 */
async function restrictPublishedListener(
  server: Server,
  stateDir: string,
  address: ControlTarget,
): Promise<ListenerFiles> {
  if (address.transport === "tcp") {
    const published = publishControlPort(stateDir, address.port);
    if (!published.ok) {
      await closeServer(server, undefined, undefined);
      return published;
    }
    return { ok: true, portPath: memberControlPortPath(stateDir) };
  }
  try {
    chmodSync(address.path, 0o600);
  } catch (error) {
    await closeServer(server, undefined, undefined);
    return { ok: false, error: `could not restrict ${address.path}: ${errorMessage(error)}` };
  }
  return { ok: true, socketPath: address.path };
}

type ListenOutcome =
  | { readonly ok: true; readonly address: ControlTarget }
  | { readonly ok: false; readonly error: string };

/**
 * Bind the listener and report its real address.
 *
 * The first `error` (EADDRINUSE, EACCES, path too long) is the answer to this
 * call; later listener errors (EMFILE and friends) must not crash the member
 * process that owns the socket, so they are swallowed once listening succeeds.
 */
function listenServer(
  server: Server,
  target: { readonly path: string } | { readonly host: string; readonly port: number },
): Promise<ListenOutcome> {
  return new Promise<ListenOutcome>((resolve) => {
    const fail = (error: unknown): void => {
      resolve({ ok: false, error: errorMessage(error) });
    };
    server.once("error", fail);
    server.listen(target, () => {
      server.off("error", fail);
      server.on("error", () => {
        // Deliberately empty: see the comment above.
      });
      const address = server.address();
      if (address === null) {
        resolve({ ok: false, error: "control listener has no address" });
        return;
      }
      if (typeof address === "string") {
        resolve({ ok: true, address: { transport: "unix", path: address } });
        return;
      }
      resolve({ ok: true, address: { transport: "tcp", host: "127.0.0.1", port: address.port } });
    });
  });
}

/** Guard the unix socket path length and replace a stale socket from a crash. */
function prepareUnixSocketPath(
  stateDir: string,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  const socketPath = memberControlSocketPath(stateDir);
  if (socketPath.length > MAX_UNIX_SOCKET_PATH) {
    return {
      ok: false,
      error: `unix socket path is ${socketPath.length} bytes (limit ${MAX_UNIX_SOCKET_PATH}); use the 127.0.0.1 fallback`,
    };
  }
  // Single-writer invariant: a stale socket file from a crashed owner is ours to
  // replace; a live owner is a bug the caller must fix, not a race.
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if (!isMissingFile(error)) {
      return { ok: false, error: `could not replace ${socketPath}: ${errorMessage(error)}` };
    }
  }
  return { ok: true, path: socketPath };
}

async function closeServer(
  server: Server,
  socketPath: string | undefined,
  portPath: string | undefined,
): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  for (const path of [socketPath, portPath]) {
    if (path === undefined) continue;
    try {
      unlinkSync(path);
    } catch {
      // Already removed, or the listener never bound it. Nothing to clean up.
    }
  }
}

interface ConnectionHandling {
  readonly memberId: string;
  readonly served: readonly ServedCredential[];
  readonly maxFrameBytes: number;
}

interface AuthenticatedConnection {
  readonly authority: VerifiedAuthority;
  readonly dispatcher: DurableDispatcher;
}

/**
 * One client connection: auth first, then sequential command frames.
 *
 * The auth frame selects the tier by credential; every later frame is checked
 * against that derived tier only. Frames are handled in order through a promise
 * chain because dispatch is asynchronous, which keeps two frames from the same
 * caller deterministic.
 */
function handleConnection(socket: Socket, handling: ConnectionHandling): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let authenticated: AuthenticatedConnection | undefined;
  let closed = false;
  let pending: Promise<void> = Promise.resolve();

  const close = (): void => {
    closed = true;
    if (!socket.destroyed) socket.end();
  };

  const fail = (code: ControlErrorCode, error: string, requestId?: string): void => {
    writeFrame(
      socket,
      requestId === undefined
        ? { type: "error", code, error }
        : { type: "error", code, error, requestId },
    );
    close();
  };

  /** Auth phase: nothing about the command schema is read before this passes. */
  const handleAuthFrame = (raw: unknown): void => {
    const auth = parseAuthFrame(raw);
    if (!auth.ok) {
      fail("unauthorized", AUTH_FAILURE_MESSAGE);
      return;
    }
    const served = deriveServedTier(handling.served, auth.token);
    if (served === undefined) {
      // One generic answer for every candidate: never reveal which tier was
      // compared, how close the credential was, or which check refused it.
      fail("unauthorized", AUTH_FAILURE_MESSAGE);
      return;
    }
    authenticated = {
      authority: bindOwnerAuthority(served.authority),
      dispatcher: served.dispatcher,
    };
    writeFrame(socket, { type: "auth-ack", ok: true });
  };

  /** Command phase: the derived tier validates the claim, authorizes, applies. */
  const handleCommandFrame = async (raw: unknown): Promise<void> => {
    if (authenticated === undefined) {
      // Still a pre-auth failure, so it gets the same answer as a bad credential.
      fail("unauthorized", AUTH_FAILURE_MESSAGE);
      return;
    }
    const parsed = parseCommandFrame(raw, handling.memberId, authenticated.authority);
    if (!parsed.ok) {
      fail(parsed.code, parsed.error);
      return;
    }
    const result = await authenticated.dispatcher.dispatch(parsed.command);
    writeFrame(
      socket,
      result.ok
        ? {
            type: "command-result",
            ok: true,
            requestId: result.requestId,
            duplicate: result.duplicate,
          }
        : {
            type: "error",
            code: "invalid-command",
            error: result.error,
            requestId: result.requestId,
          },
    );
  };

  const handleFrame = async (frameText: string): Promise<void> => {
    if (closed || frameText.trim() === "") return;
    const parsed = parseFrameJson(frameText);
    if (!parsed.ok) {
      fail("invalid-frame", parsed.error);
      return;
    }
    if (authenticated === undefined) {
      handleAuthFrame(parsed.raw);
      return;
    }
    await handleCommandFrame(parsed.raw);
  };

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer += chunk.toString("utf8");
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const frameText = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      pending = pending
        .then(() => handleFrame(frameText))
        .catch(() => {
          // Unreachable in practice: dispatch returns error values and a closed
          // socket is checked before each frame. Catch anyway so one unexpected
          // failure cannot poison the queue for the rest of the connection.
        });
    }
    if (buffer.length > handling.maxFrameBytes) {
      buffer = "";
      fail("frame-too-large", `frame exceeded ${handling.maxFrameBytes} bytes`);
    }
  });

  socket.on("error", () => {
    closed = true;
    socket.destroy();
  });

  socket.on("close", () => {
    closed = true;
  });
}

export interface ControlClientOptions {
  readonly target: ControlTarget;
  /** The credential for the tier the client is presenting. */
  readonly token: string;
  readonly command: DurableCommand;
  readonly timeoutMs?: number;
}

/** Read the credential for `authority` and send from it. */
export function sendMemberControlCommand(options: {
  readonly stateDir: string;
  readonly authority: AuthenticatableAuthority;
  readonly command: DurableCommand;
  readonly timeoutMs?: number;
}): Promise<ControlClientResult> {
  const credential = readControlToken(options.stateDir, options.authority);
  if (!credential.ok) {
    return Promise.resolve({ ok: false, code: "socket-unavailable", error: credential.error });
  }
  return sendControlCommand({
    target: readMemberControlTarget(options.stateDir),
    token: credential.token,
    command: options.command,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/**
 * Send one command to a member's control surface from an already-read
 * credential. The credential selects the tier; the command must claim it.
 *
 * Returns an error value instead of throwing: a panel or supervisor must render
 * "member is not accepting control commands", not crash on a stale socket.
 */
export function sendControlCommand(options: ControlClientOptions): Promise<ControlClientResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  return new Promise<ControlClientResult>((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = connect(options.target);

    const finish = (result: ControlClientResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, code: "timeout", error: `no response within ${timeoutMs}ms` });
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "auth", token: options.token })}\n`);
      socket.write(`${JSON.stringify({ type: "command", command: options.command })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const index = buffer.indexOf("\n");
        if (index === -1) break;
        const frameText = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const outcome = interpretServerFrame(frameText);
        if (outcome.kind === "continue") continue;
        finish(outcome.kind === "result" ? outcome.result : outcome.failure);
        return;
      }
    });
    socket.on("error", (error) => {
      finish({ ok: false, code: "socket-unavailable", error: errorMessage(error) });
    });
    socket.on("end", () => {
      finish({
        ok: false,
        code: "protocol-error",
        error: "member closed the control channel before answering",
      });
    });
  });
}

function connect(target: ControlTarget): Socket {
  const socket = new Socket();
  if (target.transport === "unix") socket.connect({ path: target.path });
  else socket.connect({ host: target.host, port: target.port });
  return socket;
}

function parseFrameJson(
  frameText: string,
): { readonly ok: true; readonly raw: unknown } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, raw: JSON.parse(frameText) };
  } catch {
    return { ok: false, error: "frame is not JSON" };
  }
}

/** A failed client result. */
type ControlFailure = Extract<ControlClientResult, { readonly ok: false }>;

type ServerFrameOutcome =
  | { readonly kind: "continue" }
  | { readonly kind: "result"; readonly result: ControlClientResult }
  | { readonly kind: "failure"; readonly failure: ControlFailure };

/**
 * Classify one server frame for the client loop: an auth ack means keep waiting,
 * a command result resolves, an error (or an oversized/malformed frame) fails.
 */
function interpretServerFrame(frameText: string): ServerFrameOutcome {
  if (frameText.length > MAX_CONTROL_FRAME_BYTES) {
    return {
      kind: "failure",
      failure: { ok: false, code: "frame-too-large", error: "control response frame is too large" },
    };
  }
  const parsed = parseServerFrame(frameText);
  if (!parsed.ok) {
    return { kind: "failure", failure: { ok: false, code: "protocol-error", error: parsed.error } };
  }
  switch (parsed.frame.type) {
    case "auth-ack":
      return { kind: "continue" };
    case "command-result":
      return {
        kind: "result",
        result: {
          ok: true,
          requestId: parsed.frame.requestId,
          duplicate: parsed.frame.duplicate,
        },
      };
    case "error":
      return {
        kind: "failure",
        failure: { ok: false, code: parsed.frame.code, error: parsed.frame.error },
      };
  }
}

/** Membership-check an untrusted code; unknown codes become `protocol-error`. */
function readErrorCode(value: unknown): ControlErrorCode {
  return isControlErrorCode(value) ? value : "protocol-error";
}

function parseServerFrame(
  frameText: string,
): { ok: true; frame: ControlServerFrame } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(frameText);
  } catch {
    return { ok: false, error: "control response is not JSON" };
  }
  if (!isRecord(raw)) return { ok: false, error: "control response must be an object" };
  if (raw.type === "auth-ack" && raw.ok === true) {
    return { ok: true, frame: { type: "auth-ack", ok: true } };
  }
  if (raw.type === "command-result" && raw.ok === true && typeof raw.requestId === "string") {
    return {
      ok: true,
      frame: {
        type: "command-result",
        ok: true,
        requestId: raw.requestId,
        duplicate: raw.duplicate === true,
      },
    };
  }
  if (raw.type === "error" && typeof raw.error === "string") {
    const code = readErrorCode(raw.code);
    return {
      ok: true,
      frame:
        typeof raw.requestId === "string"
          ? { type: "error", code, error: raw.error, requestId: raw.requestId }
          : { type: "error", code, error: raw.error },
    };
  }
  return { ok: false, error: "control response does not match the protocol" };
}
