/**
 * The one pi-web surface the harness writes that is not session-daemon state:
 * the navigation preference that pins a session in the sidebar.
 *
 * Why a pin at all: a fleet supervisor is an ordinary chat session, and pi-web
 * lists sessions per workspace, newest-modified first. A supervisor that idles for
 * hours while its run loop ticks in the daemon sinks down the list, so the
 * operator cannot find the session that is doing the work. A pin keeps it in the
 * pinned group for the duration of the run.
 *
 * Why this module is separate: pins live in the *web* server
 * (`~/.pi-web/navigation-preferences.json`), not the session daemon — the daemon
 * answers 404 on these routes — so this is an HTTP client, not a `daemonRequest`.
 * Parsing, path building and the read-modify-write are pure/injectable so tests
 * never touch a live pi-web.
 *
 * The write is a compare-and-replace: the store keeps a `revision` per scope and
 * rejects a stale write with 409 plus the current record. That is what lets a
 * harness pin coexist with the operator pinning sessions by hand in the UI.
 */

/** pi-web's default machine id in its own routes. */
export const PI_WEB_LOCAL_MACHINE_ID = "local";

/** Every project pi-web knows about, with the paths it lists sessions under. */
export const PI_WEB_PROJECTS_PATH = "/api/projects";

/** Bounded retries for a lost compare-and-replace race (409 carries the winner). */
export const SESSION_PINS_MAX_ATTEMPTS = 3;

export interface SessionPinsSnapshot {
  ids: readonly string[];
  /**
   * Absent when the server omits it; the write then drops the precondition rather
   * than inventing revision 0, which would 409 forever.
   */
  revision?: number;
}

export interface PiWebHttpRequest {
  method: "GET" | "PUT";
  path: string;
  body?: unknown;
}

export interface PiWebHttpResponse {
  status: number;
  body: unknown;
}

export type PiWebHttpTransport = (request: PiWebHttpRequest) => Promise<PiWebHttpResponse>;

/** Route for one workspace's ordered session-pin ids. */
export function sessionPinsPath(options: {
  projectId: string;
  workspaceId: string;
  machineId?: string;
}): string {
  const machineId = options.machineId ?? PI_WEB_LOCAL_MACHINE_ID;
  return (
    `/api/machines/${encodeURIComponent(machineId)}/navigation/projects/` +
    `${encodeURIComponent(options.projectId)}/workspaces/${encodeURIComponent(options.workspaceId)}` +
    "/session-pins"
  );
}

/** Route for one project's workspaces (git worktrees, via pi-web's git plugin). */
export function projectWorkspacesPath(projectId: string): string {
  return `${PI_WEB_PROJECTS_PATH}/${encodeURIComponent(projectId)}/workspaces`;
}

/**
 * Parse a pins record.
 *
 * Undefined means "not the shape we understand": a caller must not write from a
 * snapshot it could not read, or a schema change would turn into silent data loss.
 */
export function parseSessionPins(body: unknown): SessionPinsSnapshot | undefined {
  if (!isRecord(body)) return undefined;
  const ids = readArray(body, "ids");
  if (ids === undefined) return undefined;
  const strings: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "") return undefined;
    strings.push(id);
  }
  const revision = readNumber(body, "revision");
  if (revision === "invalid") return undefined;
  return revision === undefined ? { ids: strings } : { ids: strings, revision };
}

/**
 * The project whose `path` is exactly this workspace path.
 *
 * pi-web scopes its session list by exact cwd, so prefix matching here would pin
 * a session into a workspace that does not list it — the pin would be invisible.
 */
export function matchProjectId(projects: unknown, cwd: string): string | undefined {
  if (!Array.isArray(projects)) return undefined;
  const target = normalizeWorkspacePath(cwd);
  for (const project of projects) {
    if (!isRecord(project)) continue;
    const id = readString(project, "id");
    const path = readString(project, "path");
    if (id === undefined || path === undefined) continue;
    if (normalizeWorkspacePath(path) === target) return id;
  }
  return undefined;
}

/** The workspace (worktree) inside a project whose `path` is this cwd. */
export function matchWorkspaceId(workspaces: unknown, cwd: string): string | undefined {
  if (!isRecord(workspaces)) return undefined;
  const list = readArray(workspaces, "workspaces");
  if (list === undefined) return undefined;
  const target = normalizeWorkspacePath(cwd);
  for (const workspace of list) {
    if (!isRecord(workspace)) continue;
    const id = readString(workspace, "id");
    const path = readString(workspace, "path");
    if (id === undefined || path === undefined) continue;
    if (normalizeWorkspacePath(path) === target) return id;
  }
  return undefined;
}

/** Trailing slashes are the only difference a caller can legitimately introduce. */
export function normalizeWorkspacePath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/u, "");
}

/** Append the id once, keeping the operator's existing pin order. */
export function withSessionPin(ids: readonly string[], sessionId: string): readonly string[] {
  return ids.includes(sessionId) ? [...ids] : [...ids, sessionId];
}

/** Drop the id, keeping every other pin untouched. */
export function withoutSessionPin(ids: readonly string[], sessionId: string): readonly string[] {
  return ids.filter((id) => id !== sessionId);
}

export type MutateSessionPinsResult =
  | { ok: true; pins: SessionPinsSnapshot; changed: boolean }
  | { ok: false; error: string };

/**
 * Read-modify-write one workspace's pin list under pi-web's revision check.
 *
 * `update` receives the current ids so the caller only has to say what it wants;
 * a 409 means another writer (the operator's own pin click) won, so the update is
 * re-derived from the new snapshot instead of being forced through.
 */
export async function mutateSessionPins(options: {
  request: PiWebHttpTransport;
  projectId: string;
  workspaceId: string;
  update: (ids: readonly string[]) => readonly string[];
  maxAttempts?: number;
}): Promise<MutateSessionPinsResult> {
  const path = sessionPinsPath({
    projectId: options.projectId,
    workspaceId: options.workspaceId,
  });
  const attempts = options.maxAttempts ?? SESSION_PINS_MAX_ATTEMPTS;
  let lastError = "no attempt was made";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const outcome = await attemptPinsWrite({
      request: options.request,
      path,
      update: options.update,
    });
    if (outcome.kind === "done") return { ok: true, pins: outcome.pins, changed: outcome.changed };
    lastError = outcome.error;
    if (outcome.kind === "failed") break;
  }

  return { ok: false, error: lastError };
}

type PinsWriteAttempt =
  | { kind: "done"; pins: SessionPinsSnapshot; changed: boolean }
  | { kind: "conflict"; error: string }
  | { kind: "failed"; error: string };

/** One read-modify-write round; a conflict asks the caller to re-read and retry. */
async function attemptPinsWrite(options: {
  request: PiWebHttpTransport;
  path: string;
  update: (ids: readonly string[]) => readonly string[];
}): Promise<PinsWriteAttempt> {
  const read = await options.request({ method: "GET", path: options.path });
  if (!isSuccess(read.status)) {
    return { kind: "failed", error: `read failed with HTTP ${read.status}` };
  }
  const current = parseSessionPins(read.body);
  if (current === undefined) {
    return { kind: "failed", error: "pi-web returned a pin list this build does not understand" };
  }
  const next = options.update(current.ids);
  if (sameIds(current.ids, next)) return { kind: "done", pins: current, changed: false };

  const write = await options.request({
    method: "PUT",
    path: options.path,
    body: pinsWriteBody(next, current.revision),
  });
  if (write.status === 409) return { kind: "conflict", error: "pin list changed while writing" };
  if (!isSuccess(write.status)) {
    return { kind: "failed", error: `write failed with HTTP ${write.status}` };
  }
  const written = parseSessionPins(write.body);
  return {
    kind: "done",
    pins: written ?? {
      ids: next,
      ...(current.revision === undefined ? {} : { revision: current.revision }),
    },
    changed: true,
  };
}

/** Omit the precondition when the server never published one. */
function pinsWriteBody(
  ids: readonly string[],
  revision: number | undefined,
): Record<string, unknown> {
  return revision === undefined ? { ids } : { ids, revision };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

/** `invalid` distinguishes "present but not a safe integer" from "absent". */
function readNumber(record: Record<string, unknown>, key: string): number | "invalid" | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : "invalid";
}
