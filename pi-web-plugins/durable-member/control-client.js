// SYNC WARNING: the wire protocol below is the plain-JS mirror of
// `src/durable-member/socket.ts` (member-owned control socket). The pi-web
// server module runs in the daemon and cannot import TypeScript, so framing is
// written twice on purpose:
//
//   - one unix socket at `<memberStateDir>/control.sock` (mode 0600); the
//     optional TCP fallback binds 127.0.0.1 only and publishes its port in
//     `<memberStateDir>/control.port` (mode 0600);
//   - one credential file per authenticatable tier:
//     `control.panel.token` and `control.supervisor.token` (0600). There is no
//     phase-subagent credential;
//   - the owner derives the tier from **which credential matched** (constant
//     time, generic `unauthorized` on failure) and refuses a command whose
//     `authority` claim differs from that derived tier (`authority-mismatch`);
//   - NDJSON frames, bounded at 256 KiB;
//   - the first frame must be `{"type":"auth","token":...}`, then
//     `{"type":"command","command":...}`;
//   - the owner answers `{"type":"auth-ack","ok":true}` and then either
//     `{"type":"command-result","ok":true,"requestId":...,"duplicate":...}` or
//     `{"type":"error","code":...,"error":...,"requestId"?:...}`.
//
// The port and the credential are read from the member's own state, never from
// a caller/browser request: a request-supplied port would let the panel point a
// member credential at an arbitrary loopback service, and the caller picks only
// the tier whose credential file it reads.
//
// Any change here must be mirrored in `src/durable-member/socket.ts`, and vice
// versa. Trust boundary: this separates tiers within one uid. A hostile same-uid
// process can still read the other tier's 0600 credential; that is documented in
// `docs/durable-member-panel.md`, not prevented here.

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { validateCommand } from "./contract.js";

/** Socket filename inside the member state dir (one listener serves all tiers). */
export const CONTROL_SOCKET_FILE = "control.sock";

/** Owner-published TCP fallback port filename inside the member state dir. */
export const CONTROL_PORT_FILE = "control.port";

/** Credential file per authenticatable tier (mirrors `commands.ts`). */
export const AUTHORITY_CREDENTIAL_FILES = {
  "panel-human": "control.panel.token",
  "fleet-supervisor": "control.supervisor.token",
};

/** Largest single NDJSON frame either side accepts. */
export const MAX_CONTROL_FRAME_BYTES = 256 * 1024;

/** Default client deadline for one round trip. */
export const DEFAULT_CONTROL_TIMEOUT_MS = 5000;

/**
 * Read one tier's credential.
 *
 * @param {string} memberDir
 * @param {string} authority
 * @returns {{ ok: true, token: string } | { ok: false, error: string }}
 */
export function readControlToken(memberDir, authority) {
  const file = AUTHORITY_CREDENTIAL_FILES[authority];
  if (file === undefined) {
    return { ok: false, error: `${String(authority)} cannot authenticate on the control socket` };
  }
  const path = join(memberDir, file);
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token === "") return { ok: false, error: `${path} is empty` };
    return { ok: true, token };
  } catch (error) {
    return {
      ok: false,
      error: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Where the member published its control surface.
 *
 * A published `control.port` switches to the 127.0.0.1 fallback; otherwise the
 * unix socket is used. Callers never supply this.
 *
 * @param {string} memberDir
 * @returns {{ transport: "unix", path: string } | { transport: "tcp", host: "127.0.0.1", port: number }}
 */
export function readControlTarget(memberDir) {
  let port;
  try {
    const text = readFileSync(join(memberDir, CONTROL_PORT_FILE), "utf8").trim();
    if (/^[0-9]+$/.test(text)) {
      const parsed = Number(text);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) port = parsed;
    }
  } catch {
    // No published port: the unix socket is the transport.
  }
  if (port === undefined) {
    return { transport: "unix", path: join(memberDir, CONTROL_SOCKET_FILE) };
  }
  return { transport: "tcp", host: "127.0.0.1", port };
}

/**
 * Send one command as the given tier.
 *
 * Only that tier's credential file is read, so the panel client can present
 * nothing but the panel credential. The owner still checks the frame's
 * `authority` claim against the credential-derived tier.
 *
 * @param {{ memberDir: string, authority: string, command: object, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, requestId: string, duplicate: boolean } | { ok: false, code: string, error: string }>}
 */
export function sendControlCommand(options) {
  const validated = validateCommand(options.command, { memberId: options.command.memberId });
  if (!validated.ok) {
    return Promise.resolve({ ok: false, code: "invalid-command", error: validated.error });
  }
  const token = readControlToken(options.memberDir, options.authority);
  if (!token.ok) {
    return Promise.resolve({ ok: false, code: "socket-unavailable", error: token.error });
  }
  const target = readControlTarget(options.memberDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket =
      target.transport === "unix"
        ? createConnection({ path: target.path })
        : createConnection({ host: target.host, port: target.port });

    const finish = (result) => {
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
      socket.write(`${JSON.stringify({ type: "auth", token: token.token })}\n`);
      socket.write(`${JSON.stringify({ type: "command", command: validated.value })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const index = buffer.indexOf("\n");
        if (index === -1) break;
        const frameText = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (frameText.length > MAX_CONTROL_FRAME_BYTES) {
          finish({ ok: false, code: "frame-too-large", error: "control response frame is too large" });
          return;
        }
        let frame;
        try {
          frame = JSON.parse(frameText);
        } catch {
          finish({ ok: false, code: "protocol-error", error: "control response is not JSON" });
          return;
        }
        if (typeof frame !== "object" || frame === null) {
          finish({ ok: false, code: "protocol-error", error: "control response must be an object" });
          return;
        }
        if (frame.type === "auth-ack") continue;
        if (frame.type === "command-result" && frame.ok === true) {
          finish({
            ok: true,
            requestId: String(frame.requestId ?? ""),
            duplicate: frame.duplicate === true,
          });
          return;
        }
        if (frame.type === "error") {
          finish({
            ok: false,
            code: String(frame.code ?? "protocol-error"),
            error: String(frame.error ?? "member refused the command"),
          });
          return;
        }
        finish({ ok: false, code: "protocol-error", error: "control response is not a known frame" });
        return;
      }
    });
    socket.on("error", (error) => {
      finish({
        ok: false,
        code: "socket-unavailable",
        error: error instanceof Error ? error.message : String(error),
      });
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
