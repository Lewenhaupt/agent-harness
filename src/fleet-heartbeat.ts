/**
 * Supervisor heartbeat for a running fleet (bd-126 P5).
 *
 * The recorded supervisor is `{sessionId, pid, pidStartTime, armToken}`, and that
 * record cannot answer "is the supervisor still running?" in a pi-web daemon:
 * every session shares one process, so `pid` is the daemon and stays alive after
 * the supervisor session is closed. The fleet is then wedged — `/fleet --fleet
 * <id>` refuses to re-arm because the recorded pid is alive, and nothing ticks.
 *
 * A run-mode fleet therefore also writes a beat row (`fleet_supervisor`, keyed by
 * fleet id), refreshed by the run loop. A beat names the session that wrote it, so a stale beat belonging to a
 * *different* session is not mistaken for this one, and no beat at all means the
 * loop never started (or stopped for good).
 *
 * The arm token deliberately never appears here: it lives only in the arming
 * session's memory so a planted intent row cannot impersonate a supervisor
 * (W6). A beat proves recency, not authority.
 *
 * The heartbeat only *widens* re-arm eligibility for fleets that have a run
 * record. A legacy (explicit) fleet keeps the old pid-based rule, so upgrading
 * cannot steal a fleet from a live operator.
 */

import { z } from "zod";
import type {
  FleetSupervisorLiveness,
  FleetSupervisorRecord,
  FleetSupervisorState,
} from "./fleet-mode.js";
import { classifyFleetSupervisor } from "./fleet-mode.js";
import { isFleetRunActive } from "./fleet-run.js";
import { type FleetStateFs, fleetStoreFor } from "./fleet-state.js";
import type { FleetIntent } from "./fleet-status.js";

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

export function parseSupervisorHeartbeat(raw: unknown): SupervisorHeartbeat | undefined {
  const parsed = SupervisorHeartbeatSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Read the beat; absence is normal (explicit fleets never write one).
 *
 * The row is keyed by fleet id, so a beat cannot be copied between repositories and
 * a stale one is a timestamp a reader can judge — the file it replaced was a copy
 * that had to be located inside one fleet directory.
 */
export function readSupervisorHeartbeat(options: {
  gitCommonDir: string;
  fleetId: string;
  fs?: FleetStateFs;
}): SupervisorHeartbeat | undefined {
  const store = fleetStoreFor(options);
  if (store === null) return undefined;
  const row = store.readSupervisor(options.fleetId);
  if (!row.ok || row.value === null) return undefined;
  return parseSupervisorHeartbeat({
    schemaVersion: FLEET_SUPERVISOR_HEARTBEAT_SCHEMA_VERSION,
    fleetId: row.value.fleetId,
    sessionId: row.value.sessionId,
    pid: row.value.pid,
    heartbeatAt: row.value.heartbeatAt,
  });
}

/**
 * Write the beat as one upsert.
 *
 * The file write was temp+rename so a reader never saw half a record; a row write
 * is a single statement, so that durability is inherent. A corrupt beat reads as
 * "no beat": recency is a safety signal, never a crash.
 */
export function writeSupervisorHeartbeat(options: {
  gitCommonDir: string;
  fleetId: string;
  sessionId: string;
  pid: number;
  now: number;
  fs?: FleetStateFs;
}): { ok: true; beat: SupervisorHeartbeat } | { ok: false; error: string } {
  const beat: SupervisorHeartbeat = {
    schemaVersion: FLEET_SUPERVISOR_HEARTBEAT_SCHEMA_VERSION,
    fleetId: options.fleetId,
    sessionId: options.sessionId,
    pid: options.pid,
    heartbeatAt: options.now,
  };
  const store = fleetStoreFor(options);
  if (store === null) {
    return { ok: false, error: "the repository state store is unavailable" };
  }
  const written = store.writeSupervisor({
    fleetId: options.fleetId,
    sessionId: options.sessionId,
    pid: options.pid,
    heartbeatAt: options.now,
    nowMs: options.now,
  });
  return written.ok ? { ok: true, beat } : { ok: false, error: written.error };
}

/**
 * Whether a run-mode loop is provably not ticking, judged by beat recency alone.
 *
 * The recorded supervisor id is deliberately not consulted: this is the question a
 * **leaderless** record (no usable supervisor, or an empty session id) asks, where
 * nobody is named and only recency can distinguish "some session is beating this
 * run" from "nobody is ticking it". A fresh beat is therefore *not* provably dead,
 * even though it names a session the record does not — reporting it as dead would
 * call a healthy fleet unticked. `belayd_fleet_status` remains the surface for that
 * case.
 */
export function isFleetLoopProvablyDead(options: {
  beat: SupervisorHeartbeat | undefined;
  now: number;
  staleAfterInMs?: number;
}): boolean {
  if (options.beat === undefined) return true;
  const staleAfter = options.staleAfterInMs ?? FLEET_SUPERVISOR_HEARTBEAT_STALE_MS;
  return options.now - options.beat.heartbeatAt >= staleAfter;
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
  return isFleetLoopProvablyDead({
    beat,
    now: options.now,
    ...(options.staleAfterInMs === undefined ? {} : { staleAfterInMs: options.staleAfterInMs }),
  })
    ? "dead"
    : "live";
}

/**
 * Supervisor liveness for one fleet, using the beat only where it applies.
 *
 * `unknown` (an explicit fleet) keeps the pid-based verdict untouched, so this
 * upgrade cannot make a live explicit fleet re-armable.
 *
 * A **dead supervisor process** closes the beat's stale window (bd-233): a beat is
 * only refreshed by a live loop, so a 10-minute-old beat from a cancelled session
 * used to keep a dead fleet "live" until the window expired while every repair tool
 * refused in the meantime. A `pid` that is provably gone (or was reused) is the
 * stronger evidence and wins over a merely fresh beat, because nothing can refresh
 * a beat from a process that no longer exists. Without a probe the verdict is
 * exactly the beat's — the documented behaviour before this bead.
 */
export function effectiveSupervisorState(options: {
  state: FleetSupervisorState;
  runMode: boolean;
  beat: SupervisorHeartbeat | undefined;
  now: number;
  staleAfterInMs?: number;
  /** The recorded supervisor, required for the process probe. */
  supervisor?: FleetSupervisorRecord;
  /**
   * Process probe for the recorded pid. Absent means "the beat is the only
   * evidence" (the pre-bd-233 rule).
   */
  liveness?: FleetSupervisorLiveness;
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
  if (verdict === "live") {
    const supervisor = options.supervisor;
    const deadProcess =
      supervisor !== undefined &&
      options.liveness !== undefined &&
      classifyFleetSupervisor({ supervisor, liveness: options.liveness }).kind === "dead";
    return deadProcess
      ? { kind: "dead", sessionId: options.state.sessionId }
      : { kind: "live", sessionId: options.state.sessionId };
  }
  return { kind: "dead", sessionId: options.state.sessionId };
}

/** Why a fleet that names this session is still not re-adopted. */
export type SupervisorReadoptionRefusal =
  | "no-active-run"
  | "no-supervisor-record"
  | "other-session"
  | "beat-live";

/** What proved the dead loop may be re-adopted. */
export type SupervisorReadoptionReason = "cold-beat" | "missing-beat" | "pid-dead";

/** The readoption decision for one fleet, as seen by a starting session. */
export type SupervisorReadoptionPlan =
  | { adopt: false; reason: SupervisorReadoptionRefusal }
  | {
      adopt: true;
      reason: SupervisorReadoptionReason;
      /**
       * The supervisor record the decision was based on.
       *
       * Returned so the writer can compare-and-swap against exactly what it saw
       * (bd-169): the adopt arm is the only one where a usable record exists, so the
       * type — not a runtime branch — carries that invariant.
       */
      supervisor: FleetSupervisorRecord;
    };

/**
 * Whether a starting session may take over the run of a fleet its record names.
 *
 * The run loop's authority normally includes the arm token, which lives only in
 * the arming process's memory (W6): a restart therefore loses the loop for good,
 * silently, until an operator types `/fleet <ids> --fleet <id>`. This decision is
 * the automatic repair, and it is deliberately weaker than the token so it can
 * never *invent* authority:
 *
 * - the record must name this session (`sessionId`), so no session adopts a
 *   fleet belonging to another one;
 * - the intent must carry an **active** run, so only work that was supposed to be
 *   ticking is revived — a finished or halted run stays finished;
 * - the beat, not the recorded pid, must say the loop is gone
 *   ({@link classifySupervisorBeat}). That is already the documented re-arm rule
 *   for run-mode fleets, applied automatically instead of by hand.
 *
 * Residual risk, stated rather than hidden: the session id is public, so a record
 * planted by another writer that names this session and carries an active run
 * makes this session adopt on its next start. Persisting the arm token to close
 * that hole would defeat W6 (a planted record could then copy it), so instead the
 * adoption is *loud* (notify + audit) and needs a cold beat on an existing run:
 * a forged record cannot keep a live loop's beat fresh, and the audited
 * `supervisor-readopted` entry preserves the previous supervisor's identity.
 */
export function planSupervisorReadoption(options: {
  intent: FleetIntent;
  /** The session that is starting now. */
  sessionId: string;
  beat: SupervisorHeartbeat | undefined;
  now: number;
  staleAfterInMs?: number;
  /** Process probe for the missing-beat case; no probe keeps the beat verdict. */
  liveness?: FleetSupervisorLiveness;
}): SupervisorReadoptionPlan {
  if (!isFleetRunActive(options.intent.run)) return { adopt: false, reason: "no-active-run" };
  const supervisor = options.intent.supervisor;
  if (supervisor === undefined) return { adopt: false, reason: "no-supervisor-record" };
  // An empty session id names no session, so it can never be this one.
  if (options.sessionId === "" || supervisor.sessionId !== options.sessionId) {
    return { adopt: false, reason: "other-session" };
  }
  const verdict = classifySupervisorBeat({
    runMode: true,
    supervisorSessionId: supervisor.sessionId,
    beat: options.beat,
    now: options.now,
    ...(options.staleAfterInMs === undefined ? {} : { staleAfterInMs: options.staleAfterInMs }),
  });
  if (verdict === "live") return { adopt: false, reason: "beat-live" };
  if (options.beat !== undefined) return { adopt: true, reason: "cold-beat", supervisor };
  // No beat at all: either the loop never wrote one or the beat file is gone. A
  // provably dead supervisor process is the stronger evidence, so name it; without
  // a probe the absence is still the documented dead-loop signal (`classifySupervisorBeat`).
  const deadProcess =
    options.liveness !== undefined &&
    classifyFleetSupervisor({ supervisor, liveness: options.liveness }).kind === "dead";
  return { adopt: true, reason: deadProcess ? "pid-dead" : "missing-beat", supervisor };
}
