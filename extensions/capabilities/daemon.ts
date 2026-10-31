/**
 * pi-web daemon capability: the session-daemon socket API and the web-server
 * HTTP helpers (bd-179).
 *
 * Both are transport plumbing shared by the workflow, fleet and session code;
 * they live here so no capability module needs an extension global to talk to
 * pi-web.
 */
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PiWebHttpRequest, PiWebHttpResponse } from "../../src/pi-web-navigation.js";

// ── Session daemon helpers ────────────────────────────────────────────

/** Path to the pi-web session daemon Unix socket. */
export function sessiondSocketPath(): string {
  return process.env.PI_WEB_SESSIOND_SOCKET ?? join(homedir(), ".pi-web", "sessiond.sock");
}

/** Make an HTTP request to the session daemon via Unix socket. */
export function daemonRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: sessiondSocketPath(),
        method,
        path,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            reject(errorFromResponse(data, res.statusCode));
          } else {
            resolve(responseBodyOrRaw(data));
          }
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Build an Error from a non-2xx daemon response body. */
export function errorFromResponse(data: string, statusCode: number): Error {
  try {
    const parsed = JSON.parse(data) as { error?: string };
    return new Error(parsed.error ?? data);
  } catch {
    return new Error(data || `HTTP ${statusCode}`);
  }
}

/** Parse a daemon JSON body, falling back to the raw string. */
export function responseBodyOrRaw(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return data as unknown as Record<string, unknown>;
  }
}

/**
 * HTTP to the pi-web *web* server (not the session daemon).
 *
 * Session pins live in the web server's navigation preferences, so there is no
 * sessiond route for them. Returns undefined outside pi-web (a plain `pi` CLI run
 * has no web server to pin into), which turns pinning into a no-op instead of an
 * error.
 */
export function piWebEndpoint(): { host: string; port: string } | undefined {
  const port = process.env.PI_WEB_PORT;
  if (port === undefined || port === "") return undefined;
  const configured = process.env.PI_WEB_HOST;
  // 0.0.0.0/:: are bind addresses, not connect addresses.
  const host =
    configured === undefined || configured === "" || configured === "0.0.0.0" || configured === "::"
      ? "127.0.0.1"
      : configured;
  return { host, port };
}

/** Run one request against the pi-web web server; status is data, not an error. */
export function piWebRequest(
  endpoint: { host: string; port: string },
  options: PiWebHttpRequest,
): Promise<PiWebHttpResponse> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      {
        host: endpoint.host,
        port: endpoint.port,
        method: options.method,
        path: options.path,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        timeout: 5_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          let parsed: unknown = data;
          if (data !== "") {
            try {
              parsed = JSON.parse(data) as unknown;
            } catch {
              parsed = data;
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`pi-web request timed out: ${options.method} ${options.path}`));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Compact completed subagent sessions for a task. */
export async function compactTaskSessions(
  taskId: string,
  completedPhases: string[],
): Promise<void> {
  for (const phase of completedPhases) {
    try {
      const sessions = (await daemonRequest("GET", "/sessions")) as {
        sessions?: Array<{ id: string; name?: string }>;
      };
      if (!sessions?.sessions) continue;

      const prefix = `belayd-${taskId}-sub-${phase}`;
      for (const session of sessions.sessions) {
        if (session.name?.startsWith(prefix)) {
          await daemonRequest("POST", `/sessions/${session.id}/compact`, {});
        }
      }
    } catch {
      // Daemon or endpoint not available — sessions remain uncompacted (acceptable for Phase 1)
    }
  }
}
