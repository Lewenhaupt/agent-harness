/**
 * Fleet supervisor mode (bd-126 P1).
 *
 * A fleet session is a *scheduler*, never a phase worker: it arms no process
 * gate and hard-refuses the phase, proof, and commit tools with a fleet-specific
 * message, because running a phase there would break "one process gate = one
 * bead = one worktree".
 *
 * Mode is **derived, never flagged**. The supervisor is recorded in the fleet
 * intent (`supervisor { sessionId, pid, pidStartTime, armToken }`) and the current
 * session counts as the supervisor only while that record still matches it, its
 * process identity is unchanged (pid alive, start time equal when both sides have
 * it), *and* it carries the arm token this session minted when it armed. Nothing
 * is cached on disk as a mode flag, so a record left behind by a dead process
 * cannot trap a new session into fleet mode, and removing/rewriting the intent
 * re-arms or disarms the mode immediately.
 *
 * **Threat model (W6).** The fleet directory is shared and writable by anyone who
 * can write the repository's git dir, so `fleet.json` is untrusted input. A
 * session id is public and a long-lived pid (init, a kernel thread) is easy to
 * name, which is why identity is not enough on its own: pid 1 and the kernel
 * range are refused outright (`FLEET_MIN_SUPERVISOR_PID`), the pid's start time
 * must agree when both sides recorded one (pid reuse, S1), and the record must
 * carry the token this session generated at arm time and never wrote anywhere
 * else. That token defeats a **blind** planted record — one written without
 * reading the fleet dir cannot contain a token this session minted — and the
 * launch path's read-back additionally proves the record this session *did*
 * write is the one on disk. It is not a secret against an attacker with read
 * *and* write access: such an attacker copies it verbatim into a
 * read-modify-write and can also rewrite the pid to make a live supervisor look
 * dead and take the fleet over via `/fleet`. The anchor covers passive/planted
 * records and accidental staleness, not write access to the fleet directory.
 *
 * Split, mirroring `fleet-status.ts`: path/decision helpers are pure, and the
 * two resolvers take an injected fs seam so tests need no mocks.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { FleetStateFs } from "./fleet-state.js";
import { fleetRoot, readFleetIntent } from "./fleet-state.js";
import type { FleetIntent } from "./fleet-status.js";
import { fleetEventsDir, fleetInboxDir, fleetStateDir, sanitizeFleetId } from "./fleet-status.js";
import { ALL_PHASE_TOOLS } from "./process-gate.js";

/** The supervisor record stored in `fleet.json`. */
export type FleetSupervisorRecord = NonNullable<FleetIntent["supervisor"]>;

/**
 * Tools a fleet supervisor must never call.
 *
 * Every phase tool (including `belayd_commit`) plus the proof verifier, because
 * a phase run belongs to a member's own worktree. `belayd_start_task`,
 * `belayd_start_followup`, and `belayd_stop_task` are refused too: arming a gate
 * in the supervisor would make the scheduler look like an orchestrator, which is
 * exactly the confusion fleet mode exists to prevent.
 */
export const FLEET_REFUSED_TOOLS: readonly string[] = [
  ...ALL_PHASE_TOOLS,
  "belayd_proof_verifier",
  "belayd_start_task",
  "belayd_start_followup",
  "belayd_stop_task",
];

/** Whether `toolName` is refused in fleet mode. */
export function isFleetRefusedTool(toolName: string): boolean {
  return FLEET_REFUSED_TOOLS.includes(toolName);
}

/**
 * The fleet-mode refusal.
 *
 * It must not read like the bd-119 ownership refusal: this session is not in the
 * wrong worktree, it deliberately owns no worktree at all. It also names the
 * fleet family as the correct surface, so the model redirects instead of
 * retrying or working around the block.
 */
export function formatFleetRefusal(options: { toolName: string; fleetId: string }): string {
  const fleetId = sanitizeFleetId(options.fleetId);
  return (
    `Fleet supervisor sessions do not run phases: this session schedules fleet \`${fleetId}\` and ` +
    `owns no worktree, so \`${options.toolName}\` is refused. Observe members with ` +
    `belayd_fleet_status, add members with belayd_fleet_launch, message them with ` +
    `belayd_fleet_note, and read their reports with belayd_fleet_inbox — each phase runs in the ` +
    `member orchestrator that owns that bead's worktree.`
  );
}

/** Build the supervisor record a fleet session writes into `fleet.json`. */
export function createFleetSupervisorRecord(options: {
  sessionId: string;
  pid: number;
  /** `/proc/<pid>/stat` field 22 at arm time, when the probe could read it. */
  pidStartTime?: string;
  /** Per-arming secret held only in the arming session's memory (see W6). */
  armToken?: string;
}): FleetSupervisorRecord {
  return {
    sessionId: options.sessionId,
    pid: options.pid,
    ...(options.pidStartTime === undefined ? {} : { pidStartTime: options.pidStartTime }),
    ...(options.armToken === undefined ? {} : { armToken: options.armToken }),
  };
}

/**
 * Lowest pid that can plausibly be a pi supervisor session.
 *
 * init (pid 1) and the kernel-thread range occupy the bottom of the pid space,
 * and they are alive forever — exactly the "any long-lived pid" a corrupt or
 * malicious `fleet.json` would name. A real supervisor is a user process well
 * above this floor. Residual risk, documented not hidden: inside a fresh pid
 * namespace (container) pids start low, so a legitimate supervisor there may be
 * below the floor and would have to re-arm from a session whose pid clears it.
 */
export const FLEET_MIN_SUPERVISOR_PID = 100;

/**
 * Read a process start time (`/proc/<pid>/stat` field 22, in clock ticks since
 * boot). Returns undefined where `/proc` is unavailable or unreadable, so the
 * caller can fall back to plain liveness instead of claiming the process is
 * dead.
 *
 * Field 2 (`comm`) is wrapped in parentheses and may itself contain spaces and
 * parentheses, so the split starts after the *last* `)`; the remaining fields
 * then begin at field 3 (state), which puts field 22 at index 19.
 */
export function readProcessStartTime(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    return startTime === undefined || startTime === "" ? undefined : startTime;
  } catch {
    return undefined;
  }
}

/** Injected process probes, so no test needs real pids or a real `/proc`. */
export interface FleetSupervisorLiveness {
  isPidAlive: (pid: number) => boolean;
  pidStartTime?: (pid: number) => string | undefined;
}

/**
 * Whether the recorded supervisor process is still the same process.
 *
 * Three anchors, weakest to strongest:
 *
 * 1. the pid must clear {@link FLEET_MIN_SUPERVISOR_PID} — pid 1 and kernel
 *    threads are alive forever and must never count as a supervisor;
 * 2. the pid must be alive (`kill -0` semantics);
 * 3. when the record carries `pidStartTime` and the probe can read it now, the
 *    two must match. Pids are recycled, so a bare liveness probe would let a
 *    resumed supervisor auto-match an unrelated live process that inherited the
 *    pid (S1). A recorded-but-unreadable start time falls back to (2) and the
 *    residual risk is stated here rather than silently assumed away.
 */
export function isSupervisorProcessAlive(options: {
  supervisor: FleetSupervisorRecord;
  liveness: FleetSupervisorLiveness;
}): boolean {
  const pid = options.supervisor.pid;
  if (pid < FLEET_MIN_SUPERVISOR_PID) return false;
  if (!options.liveness.isPidAlive(pid)) return false;
  const recorded = options.supervisor.pidStartTime;
  if (recorded === undefined || options.liveness.pidStartTime === undefined) return true;
  const current = options.liveness.pidStartTime(pid);
  if (current === undefined) return true;
  return current === recorded;
}

/**
 * Liveness classification of a fleet's supervisor, from any session's view.
 *
 * `dead` deliberately covers "no record" too (`kind: "none"`): both mean no live
 * process owns the fleet, which is what the launch's re-arm path keys on.
 */
export type FleetSupervisorState =
  | { kind: "none" }
  | { kind: "live"; sessionId: string }
  | { kind: "dead"; sessionId: string };

export function classifyFleetSupervisor(options: {
  supervisor: FleetIntent["supervisor"];
  liveness: FleetSupervisorLiveness;
}): FleetSupervisorState {
  const supervisor = options.supervisor;
  if (supervisor === undefined) return { kind: "none" };
  return isSupervisorProcessAlive({ supervisor, liveness: options.liveness })
    ? { kind: "live", sessionId: supervisor.sessionId }
    : { kind: "dead", sessionId: supervisor.sessionId };
}

export interface FleetSupervisorMatchOptions {
  supervisor: FleetIntent["supervisor"];
  /** This session's id. */
  sessionId: string;
  /** Process-liveness probe, injected so tests need no real pids. */
  isPidAlive: (pid: number) => boolean;
  /** Start-time probe, so pid reuse cannot impersonate a dead supervisor. */
  pidStartTime?: (pid: number) => string | undefined;
  /**
   * The token this session minted when it armed the fleet (W6). It lives only in
   * the session's memory, so a `fleet.json` planted by another writer — even one
   * naming this session id and a long-lived pid — cannot match it.
   */
  armToken?: string;
}

/**
 * Whether the stored supervisor record belongs to the live session asking.
 *
 * All anchors are required: the session id tells "my fleet" from another
 * session's fleet, the process identity tells "still running" from "left behind
 * by a process that died (or whose pid was reused)", and the arm token proves
 * this session is the one that wrote the record. A resumed session keeps its id
 * but runs in a new process and holds no token, so the record is stale — the
 * operator re-arms fleet mode with `/fleet` instead of a fresh session silently
 * inheriting scheduling authority.
 */
export function matchesFleetSupervisor(options: FleetSupervisorMatchOptions): boolean {
  const supervisor = options.supervisor;
  if (supervisor === undefined) return false;
  if (options.sessionId === "" || supervisor.sessionId !== options.sessionId) return false;
  if (supervisor.armToken === undefined) return false;
  if (options.armToken === undefined || supervisor.armToken !== options.armToken) return false;
  return isSupervisorProcessAlive({
    supervisor,
    liveness: {
      isPidAlive: options.isPidAlive,
      ...(options.pidStartTime === undefined ? {} : { pidStartTime: options.pidStartTime }),
    },
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Default liveness probe: `kill -0` semantics, without touching the process.
 *
 * `EPERM` means the pid exists but belongs to another user, which still counts
 * as alive; `ESRCH` (and anything else) means it is gone.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** One fleet's state as a session sees it. */
export interface FleetMode {
  fleetId: string;
  intent: FleetIntent;
  /** `<git-common-dir>` the fleet lives under, for audit appends. */
  gitCommonDir: string;
  dir: string;
  inboxDir: string;
  eventsDir: string;
}

export interface FleetLookupOptions {
  /** `<git-common-dir>`; the shell-out probe stays in the extension. */
  gitCommonDir: string;
  fs?: FleetStateFs;
}

/** Fleet directory names under `<git-common-dir>/belayd/fleet` (sorted, deterministic). */
export function listFleetIds(options: FleetLookupOptions): readonly string[] {
  const root = fleetRoot(options.gitCommonDir);
  try {
    const fs = options.fs;
    const names =
      fs === undefined
        ? { exists: () => existsSync(root), list: () => readdirSync(root) }
        : { exists: () => fs.existsSync(root), list: () => fs.readdirSync(root) };
    if (!names.exists()) return [];
    // Code-unit order, matching the fleet status view: the scan must not depend
    // on host ICU locale or readdir order.
    return [...names.list()].sort();
  } catch {
    // An unreadable fleet root means "no fleet" for a reader: no fleet path may
    // throw, because these lookups run inside the tool-call gate.
    return [];
  }
}

function toFleetMode(gitCommonDir: string, fleetId: string, intent: FleetIntent): FleetMode {
  return {
    fleetId: sanitizeFleetId(fleetId),
    intent,
    gitCommonDir,
    dir: fleetStateDir(gitCommonDir, fleetId),
    inboxDir: fleetInboxDir(gitCommonDir, fleetId),
    eventsDir: fleetEventsDir(gitCommonDir, fleetId),
  };
}

export interface ResolveFleetModeOptions extends FleetLookupOptions {
  sessionId: string;
  isPidAlive: (pid: number) => boolean;
  /** Start-time probe for the recorded pid (see `isSupervisorProcessAlive`). */
  pidStartTime?: (pid: number) => string | undefined;
  /** The arming token this session minted, if it armed a fleet. */
  armToken?: { fleetId: string; token: string };
}

/**
 * The fleet this session supervises, or undefined.
 *
 * Scans every fleet directory (sorted) so a repository can hold more than one
 * fleet; the id also comes from the directory name, so a record whose `fleetId`
 * disagrees with its directory cannot hijack another fleet's mailbox.
 */
export function resolveFleetMode(options: ResolveFleetModeOptions): FleetMode | undefined {
  for (const fleetId of listFleetIds(options)) {
    const loaded = readFleetIntent({
      gitCommonDir: options.gitCommonDir,
      fleetId,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
    if (!loaded.ok || loaded.intent === undefined) continue;
    const armToken =
      options.armToken !== undefined &&
      sanitizeFleetId(options.armToken.fleetId) === sanitizeFleetId(fleetId)
        ? options.armToken.token
        : undefined;
    const matches = matchesFleetSupervisor({
      supervisor: loaded.intent.supervisor,
      sessionId: options.sessionId,
      isPidAlive: options.isPidAlive,
      ...(options.pidStartTime === undefined ? {} : { pidStartTime: options.pidStartTime }),
      ...(armToken === undefined ? {} : { armToken }),
    });
    if (matches) return toFleetMode(options.gitCommonDir, fleetId, loaded.intent);
  }
  return undefined;
}

export interface ResolveMemberFleetOptions extends FleetLookupOptions {
  taskId: string;
}

/**
 * The fleet a member task belongs to, or undefined.
 *
 * A member session has no supervisor record to match — it only knows its own
 * task id — so membership is the intent's `taskIds`, which `belayd_fleet_launch`
 * keeps unique across fleets (a duplicate member would make this lookup
 * ambiguous, so the launch refuses it).
 */
export function resolveMemberFleet(options: ResolveMemberFleetOptions): FleetMode | undefined {
  if (options.taskId === "") return undefined;
  for (const fleetId of listFleetIds(options)) {
    const loaded = readFleetIntent({
      gitCommonDir: options.gitCommonDir,
      fleetId,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    });
    if (!loaded.ok || loaded.intent === undefined) continue;
    if (!loaded.intent.taskIds.includes(options.taskId)) continue;
    return toFleetMode(options.gitCommonDir, fleetId, loaded.intent);
  }
  return undefined;
}
