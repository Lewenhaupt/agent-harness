/**
 * Supervisor heartbeat for a running fleet (bd-126 P5).
 *
 * The recorded supervisor is `{sessionId, pid, pidStartTime, armToken}`, and that
 * record cannot answer "is the supervisor still running?" in a pi-web daemon:
 * every session shares one process, so `pid` is the daemon and stays alive after
 * the supervisor session is closed. The fleet is then wedged — `/fleet --fleet
 * <id>` refuses to re-arm because the recorded pid is alive, and nothing ticks.
 *
 * A run-mode fleet therefore also writes a beat:
 * `<git-common-dir>/belayd/fleet/<fleetId>/supervisor.json`, refreshed by the run
 * loop. A beat names the session that wrote it, so a stale beat belonging to a
 * *different* session is not mistaken for this one, and no beat at all means the
 * loop never started (or stopped for good).
 *
 * The arm token deliberately never appears here: it lives only in the arming
 * session's memory so a planted `fleet.json` cannot impersonate a supervisor
 * (W6). A beat proves recency, not authority.
 *
 * The heartbeat only *widens* re-arm eligibility for fleets that have a run
 * record. A legacy (explicit) fleet keeps the old pid-based rule, so upgrading
 * cannot steal a fleet from a live operator.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { FleetSupervisorState } from "./fleet-mode.js";
import type { FleetStateFs } from "./fleet-state.js";
import { fleetStateDir } from "./fleet-status.js";

/** File name inside the fleet directory. */
export const FLEET_SUPERVISOR_HEARTBEAT_FILE = "supervisor.json";

/** Schema version of the beat record. */
export const FLEET_SUPERVISOR_HEARTBEAT_SCHEMA_VERSION = 1;

/**
 * Age at which a beat is treated as abandoned.
 *
 * A tick can legitimately run for many minutes (it runs the project gates before
 * landing a member), so the window covers one long tick plus slack. Re-arming a
 * supervisor that is still mid-tick is not catastrophic: the re-arm rewrites the
 * supervisor record, so the old session immediately fails its own authority check
 * and its next tick exits.
 */
export const FLEET_SUPERVISOR_HEARTBEAT_STALE_MS = 10 * 60 * 1000;

const SupervisorHeartbeatSchema = z.object({
  schemaVersion: z.literal(FLEET_SUPERVISOR_HEARTBEAT_SCHEMA_VERSION),
  fleetId: z.string().min(1).max(128),
  /** Session that wrote the beat. */
  sessionId: z.string().min(1).max(256),
  /** Host pid of that session's process (diagnostic only; a daemon pid in pi-web). */
  pid: z.number().int().nonnegative(),
  heartbeatAt: z.number().finite(),
});

export type SupervisorHeartbeat = z.infer<typeof SupervisorHeartbeatSchema>;

/** Path of the beat record for one fleet. */
export function supervisorHeartbeatPath(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), FLEET_SUPERVISOR_HEARTBEAT_FILE);
}

export function parseSupervisorHeartbeat(raw: unknown): SupervisorHeartbeat | undefined {
  const parsed = SupervisorHeartbeatSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Default fs seam: the live filesystem. */
const nodeSeam = {
  existsSync: (path: string) => existsSync(path),
  readFileSync: (path: string) => readFileSync(path, "utf8"),
  writeFileSync: (path: string, data: string) => writeFileSync(path, data),
  renameSync: (oldPath: string, newPath: string) => renameSync(oldPath, newPath),
  mkdirSync: (path: string, options?: { recursive?: boolean }) => mkdirSync(path, options),
};

/** Read the beat; absence is normal (explicit fleets never write one). */
export function readSupervisorHeartbeat(options: {
  gitCommonDir: string;
  fleetId: string;
  fs?: FleetStateFs;
}): SupervisorHeartbeat | undefined {
  const fs = options.fs ?? nodeSeam;
  const path = supervisorHeartbeatPath(options.gitCommonDir, options.fleetId);
  try {
    if (!fs.existsSync(path)) return undefined;
    return parseSupervisorHeartbeat(JSON.parse(fs.readFileSync(path)));
  } catch {
    // A corrupt beat is "no beat": recency is a safety signal, never a crash.
    return undefined;
  }
}

/** Write the beat atomically (temp + rename, so a reader never sees half a record). */
export function writeSupervisorHeartbeat(options: {
  gitCommonDir: string;
  fleetId: string;
  sessionId: string;
  pid: number;
  now: number;
  fs?: FleetStateFs;
}): { ok: true; beat: SupervisorHeartbeat } | { ok: false; error: string } {
  const fs = options.fs ?? nodeSeam;
  const beat: SupervisorHeartbeat = {
    schemaVersion: FLEET_SUPERVISOR_HEARTBEAT_SCHEMA_VERSION,
    fleetId: options.fleetId,
    sessionId: options.sessionId,
    pid: options.pid,
    heartbeatAt: options.now,
  };
  const dir = fleetStateDir(options.gitCommonDir, options.fleetId);
  const path = supervisorHeartbeatPath(options.gitCommonDir, options.fleetId);
  const temp = `${path}.${options.now}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(beat, null, 2)}\n`);
    fs.renameSync(temp, path);
    return { ok: true, beat };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether a beat proves the recorded supervisor is still alive.
 *
 * Three outcomes, and the difference matters:
 *
 * - `live` — the beat names the recorded session and is fresh;
 * - `dead` — a run-mode fleet with no beat, a beat for another session, or a cold
 *   beat: the loop that should be ticking is not;
 * - `unknown` — the fleet has no run record, so this signal does not apply and the
 *   caller must fall back to the pid rule.
 */
export type SupervisorBeatVerdict = "live" | "dead" | "unknown";

export function classifySupervisorBeat(options: {
  /** Whether the intent carries a run record (only run-mode fleets beat). */
  runMode: boolean;
  supervisorSessionId: string | undefined;
  beat: SupervisorHeartbeat | undefined;
  now: number;
  staleAfterInMs?: number;
}): SupervisorBeatVerdict {
  if (!options.runMode) return "unknown";
  if (options.supervisorSessionId === undefined) return "dead";
  const beat = options.beat;
  if (beat === undefined) return "dead";
  if (beat.sessionId !== options.supervisorSessionId) return "dead";
  const staleAfter = options.staleAfterInMs ?? FLEET_SUPERVISOR_HEARTBEAT_STALE_MS;
  return options.now - beat.heartbeatAt < staleAfter ? "live" : "dead";
}

/**
 * Supervisor liveness for one fleet, using the beat only where it applies.
 *
 * `unknown` (an explicit fleet) keeps the pid-based verdict untouched, so this
 * upgrade cannot make a live explicit fleet re-armable.
 */
export function effectiveSupervisorState(options: {
  state: FleetSupervisorState;
  runMode: boolean;
  beat: SupervisorHeartbeat | undefined;
  now: number;
  staleAfterInMs?: number;
}): FleetSupervisorState {
  const verdict = classifySupervisorBeat({
    runMode: options.runMode,
    supervisorSessionId: options.state.kind === "none" ? undefined : options.state.sessionId,
    beat: options.beat,
    now: options.now,
    ...(options.staleAfterInMs === undefined ? {} : { staleAfterInMs: options.staleAfterInMs }),
  });
  if (verdict === "unknown") return options.state;
  if (options.state.kind === "none") return options.state;
  return verdict === "live"
    ? { kind: "live", sessionId: options.state.sessionId }
    : { kind: "dead", sessionId: options.state.sessionId };
}
