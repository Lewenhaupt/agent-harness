/**
 * Member-session liveness for the fleet supervisor (bd-126 P4).
 *
 * A fleet member is a **detached pi session**, so nothing in `fleet.json` proves
 * it is still running: the intent records members, not processes. The only honest
 * liveness evidence is therefore the process table — a member orchestrator is
 * spawned with `--session-id belayd-<taskId>` (`src/spawn.ts`,
 * `computeOrchestratorSessionName`), so a live process whose argv carries that
 * exact session token is that member's orchestrator.
 *
 * Three outcomes, and the difference matters:
 *
 * - `live` — a process carries the member's orchestrator session token;
 * - `absent` — the scan worked and no process carries it, so the orchestrator is
 *   not running (its worktree and session transcript are still on disk);
 * - `unknown` — `/proc` could not be read (no procfs, permissions, a non-Linux
 *   host), so nothing may be concluded.
 *
 * `unknown` is deliberately not folded into `absent`: treating "cannot see" as
 * "not running" is how a live member loses its mail or gets counted as free
 * capacity. Every caller in this module refuses or leaves work alone instead.
 *
 * Split, mirroring the rest of the fleet family: the matching and signalling
 * decisions are pure, the process-table scan is one documented side-effecting
 * function, and signalling is injected so no test kills a real process.
 */

import { readdirSync, readFileSync } from "node:fs";
import { readProcessStartTime } from "./fleet-mode.js";
import type { OrchestratorClaimRead } from "./orchestrator-claim.js";
import {
  classifyOrchestratorClaim,
  isPendingOrchestratorClaim,
  ORCHESTRATOR_CLAIM_STALE_MS,
} from "./orchestrator-claim.js";

/** Prefix of every Belayd session name; a member orchestrator is `belayd-<taskId>`. */
export const FLEET_ORCHESTRATOR_SESSION_PREFIX = "belayd-";

/**
 * Processes one scan will inspect.
 *
 * The scan runs inside a tool call (and, for reconcile, per member), so it is
 * bounded: a host with more than this many pids reports `unknown` rather than
 * reading an unbounded process table.
 */
export const FLEET_PROC_SCAN_MAX_ENTRIES = 4096;

/** Bytes read from one `/proc/<pid>/cmdline`; a real argv is far smaller. */
export const FLEET_PROC_CMDLINE_MAX_BYTES = 8192;

/** One process as the scan saw it: pid plus its argv tokens. */
export interface FleetProcessSnapshot {
  pid: number;
  argv: readonly string[];
}

/** Result of reading the process table; `ok: false` means "cannot tell". */
export type FleetProcessScan =
  | { ok: true; processes: readonly FleetProcessSnapshot[] }
  | { ok: false; reason: string };

/** The fs surface the scan needs, injected so tests never read a real `/proc`. */
export interface FleetProcessFs {
  readdirSync(path: string): string[];
  readFileSync(path: string): string;
}

const nodeProcessFs: FleetProcessFs = {
  readdirSync: (path) => readdirSync(path),
  readFileSync: (path) => readFileSync(path, "utf8"),
};

/**
 * The session token a member's orchestrator process carries.
 *
 * An exact token, not a prefix: a member's phase sub-agents are named
 * `belayd-<taskId>-sub-<phase>-<run>`, so a prefix match would count a surviving
 * sub-agent as the orchestrator — and the orchestrator is what the concurrency
 * ceiling is expressed in.
 */
export function memberSessionToken(taskId: string): string {
  return `${FLEET_ORCHESTRATOR_SESSION_PREFIX}${taskId}`;
}

/** Whether one argv is the orchestrator session for `taskId`. */
export function isMemberOrchestratorArgv(options: {
  taskId: string;
  argv: readonly string[];
}): boolean {
  const token = memberSessionToken(options.taskId);
  return options.argv.some((argument) => argument === token);
}

/** What the process table (and, when present, the worktree lease) says about one member. */
export type FleetMemberLiveness =
  | {
      kind: "live";
      pids: readonly number[];
      /** When the live evidence is the worktree lease rather than an argv token. */
      leaseHeartbeatAt?: number;
    }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

/**
 * The member's worktree lease, reduced to what liveness needs.
 *
 * A pi-web orchestrator is a session inside the daemon, so it has no argv token and
 * the process table can never see it; the lease is the only evidence that exists.
 * `corrupt` is unknown, never absent: an unreadable lease must not licence a prune.
 */
export type FleetMemberLeaseProbe =
  | { state: "live"; heartbeatAt: number }
  | { state: "stale" }
  | { state: "absent" }
  | { state: "corrupt"; error: string };

/**
 * Classify one member from an already-taken snapshot (pure).
 *
 * `selfPid` is excluded because a supervisor that is itself running a member's
 * workflow (in the same worktree) would otherwise look like that member's
 * orchestrator and could be signalled by a forceful pause.
 */
export function classifyMemberLiveness(options: {
  taskId: string;
  processes: readonly FleetProcessSnapshot[];
  selfPid?: number;
}): FleetMemberLiveness {
  const pids = options.processes
    .filter((process) => process.pid !== options.selfPid)
    .filter((process) => isMemberOrchestratorArgv({ taskId: options.taskId, argv: process.argv }))
    .map((process) => process.pid)
    .sort((left, right) => left - right);
  return pids.length === 0 ? { kind: "absent" } : { kind: "live", pids };
}

/**
 * Classify one member from a scan plus (when the caller has it) its worktree lease.
 *
 * Two evidence sources, and the combination is what makes it honest:
 *
 * - a live lease is positive proof — a session is renewing it, whatever the
 *   process table shows (pi-web orchestrators never appear there);
 * - a cold or missing lease proves nothing on its own, so a process carrying the
 *   argv token still counts as live (a CLI-spawned orchestrator has no lease);
 * - only "no lease AND no process AND the scan worked" is `absent`, which is the
 *   one verdict that may be pruned;
 * - an unreadable lease is `unknown`, because "cannot see" is not "gone".
 */
export function classifyMemberLivenessFromScan(options: {
  taskId: string;
  scan: FleetProcessScan;
  selfPid?: number;
  lease?: FleetMemberLeaseProbe;
}): FleetMemberLiveness {
  const lease = options.lease;
  if (lease?.state === "live") {
    return { kind: "live", pids: [], leaseHeartbeatAt: lease.heartbeatAt };
  }
  if (lease?.state === "corrupt") {
    return { kind: "unknown", reason: `worktree lease unreadable (${lease.error})` };
  }
  if (!options.scan.ok) return { kind: "unknown", reason: options.scan.reason };
  const fromProcess = classifyMemberLiveness({
    taskId: options.taskId,
    processes: options.scan.processes,
    ...(options.selfPid === undefined ? {} : { selfPid: options.selfPid }),
  });
  if (fromProcess.kind === "live") return fromProcess;
  return { kind: "absent" };
}

/**
 * Classify one member from its worktree, the process snapshot, and its lease.
 *
 * A recorded member whose worktree does not exist yet cannot be evidenced at all:
 * a launch writes the intent (member now in `taskIds`) *before* it creates the
 * worktree and takes the spawn lease, so a concurrent launch recounting in that
 * window would see "no worktree, no process, no lease" and classify `absent` —
 * freeing a slot for an orchestrator that is being spawned right now (bd-166).
 * `unknown` is the honest verdict there, and the capacity rule counts it.
 *
 * The real `absent` signal is a member whose session provably existed but which has
 * no lease and no process now (a hand-merged bead, a member stopped awaiting a
 * human, a workflow that ran to completion).
 *
 * "Its session existed" is what bounds the spawn window, and it is not the state
 * file alone. A launch writes the intent, creates the worktree, waits for it to
 * become ready (up to 60 s), and only then takes the `pending:` spawn lease; in the
 * middle of that sequence the worktree exists but carries neither a lease nor
 * evidence of a session. A bare worktree is therefore a spawn in flight —
 * `unknown`, counted — not an absent member. Completion deletes
 * `.belayd/workflow.json` (`clearWorkflowState`) while the run manifests stay, so
 * the caller injects `memberRanEvidence` (state file present **or** a run manifest
 * of this task); keying on the state file alone would count a finished member
 * forever (bd-166).
 */
export function classifyMemberLivenessInWorktree(options: {
  taskId: string;
  /** The member's worktree, or undefined when none exists (yet). */
  worktreePath: string | undefined;
  /**
   * Whether anything in the worktree proves this member's session existed: a
   * `.belayd/workflow.json` (readable or corrupt) or a run manifest of this task
   * (`memberRanEvidence`, `fleet-run.ts`).
   *
   * Injected, not read here: the classifier stays free of worktree I/O, and the
   * caller (launch, status) already has the evidence. Only consulted for an
   * otherwise-`absent` member with an existing worktree.
   */
  memberRanEvidence: boolean;
  scan: FleetProcessScan;
  selfPid?: number;
  /** Classified lease for that worktree, when the caller could read one. */
  lease?: FleetMemberLeaseProbe;
}): FleetMemberLiveness {
  if (options.worktreePath === undefined) {
    // An argv token is evidence on its own (a CLI-spawned orchestrator), so a live
    // process still wins when the worktree cannot be resolved. Otherwise the member
    // is unclassifiable, never absent: the launch may still be creating the tree.
    const fromScan = classifyMemberLivenessFromScan({
      taskId: options.taskId,
      scan: options.scan,
      ...(options.selfPid === undefined ? {} : { selfPid: options.selfPid }),
    });
    if (fromScan.kind === "live") return fromScan;
    return {
      kind: "unknown",
      reason: `no worktree for ${options.taskId} yet (a launch may still be creating it)`,
    };
  }
  const fromScan = classifyMemberLivenessFromScan({
    taskId: options.taskId,
    scan: options.scan,
    ...(options.selfPid === undefined ? {} : { selfPid: options.selfPid }),
    ...(options.lease === undefined ? {} : { lease: options.lease }),
  });
  if (fromScan.kind !== "absent") return fromScan;
  if (!options.memberRanEvidence) {
    return {
      kind: "unknown",
      reason:
        `worktree for ${options.taskId} has no lease and no evidence it ever ran ` +
        "(a launch is spawning it)",
    };
  }
  return fromScan;
}

/**
 * Classify a worktree's orchestrator lease, the one source for both the launch /
 * reconcile probe and the read-only status view (bd-166).
 *
 * A `pending:` claim is a spawner placeholder: while it is fresh the child
 * orchestrator is being created and the member is `live`; once it is stale the
 * spawn died mid-flight, which is *not* evidence of absence, so it is
 * unclassifiable (`corrupt` → `unknown`) rather than `absent`.
 */
export function classifyMemberLease(options: {
  read: OrchestratorClaimRead;
  now: number;
  /** Session asking, when the caller is deciding whether it already owns the tree. */
  sessionId?: string;
}): FleetMemberLeaseProbe {
  if (options.read.kind === "ok" && isPendingOrchestratorClaim(options.read.claim)) {
    return options.now - options.read.claim.heartbeatAt < ORCHESTRATOR_CLAIM_STALE_MS
      ? { state: "live", heartbeatAt: options.read.claim.heartbeatAt }
      : { state: "corrupt", error: "stale pending spawn lease (spawn never completed)" };
  }
  const verdict = classifyOrchestratorClaim({
    read: options.read,
    now: options.now,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  switch (verdict.kind) {
    case "free":
      return { state: "absent" };
    case "corrupt":
      return { state: "corrupt", error: verdict.error };
    case "held":
      return verdict.state === "live"
        ? { state: "live", heartbeatAt: verdict.claim.heartbeatAt }
        : { state: "stale" };
  }
}

export interface ScanProcessesOptions {
  /** `/proc` on Linux; overridable so tests hand in their own table. */
  procRoot?: string;
  fs?: FleetProcessFs;
}

/**
 * Read `<procRoot>/<pid>/cmdline` for every numeric pid.
 *
 * Side effect: filesystem reads only (no signalling, no writes). A pid that exits
 * mid-scan is skipped — it cannot be a member's orchestrator any more, and a
 * liveness probe must never fail because the process table moved.
 */
export function scanProcesses(options: ScanProcessesOptions = {}): FleetProcessScan {
  const fs = options.fs ?? nodeProcessFs;
  const procRoot = options.procRoot ?? "/proc";

  let names: string[];
  try {
    names = fs.readdirSync(procRoot);
  } catch (error) {
    return {
      ok: false,
      reason: `cannot read ${procRoot} (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const pids = names.filter((name) => /^\d+$/u.test(name)).map((name) => Number(name));
  if (pids.length > FLEET_PROC_SCAN_MAX_ENTRIES) {
    return {
      ok: false,
      reason:
        `${procRoot} holds ${pids.length} processes, above the scan cap of ` +
        `${FLEET_PROC_SCAN_MAX_ENTRIES}; member liveness cannot be established`,
    };
  }

  const processes: FleetProcessSnapshot[] = [];
  for (const pid of pids) {
    let raw: string;
    try {
      raw = fs.readFileSync(`${procRoot}/${pid}/cmdline`);
    } catch {
      continue;
    }
    const argv = raw
      .slice(0, FLEET_PROC_CMDLINE_MAX_BYTES)
      .split("\u0000")
      .filter((argument) => argument !== "");
    if (argv.length === 0) continue;
    processes.push({ pid, argv });
  }
  return { ok: true, processes };
}

/** Read one `/proc/<pid>/cmdline` as argv tokens; undefined when unreadable. */
function readProcessArgv(pid: number): readonly string[] | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw
      .slice(0, FLEET_PROC_CMDLINE_MAX_BYTES)
      .split("\u0000")
      .filter((argument) => argument !== "");
  } catch {
    return undefined;
  }
}

/**
 * The default probes: the live `/proc` of this host.
 *
 * Exported so a test can substitute them without touching a real process, and so
 * the extension and this module share one reader.
 */
export const defaultFleetPidProbe: FleetPidProbe = {
  startTime: (pid) => readProcessStartTime(pid),
  argv: (pid) => readProcessArgv(pid),
};

/**
 * One process as it was matched: the pid plus its start time at match time.
 *
 * The start time is captured with the match because it is the only thing that
 * distinguishes the matched process from a later process that inherited its pid.
 */
export interface MemberPidIdentity {
  pid: number;
  /** `/proc/<pid>/stat` field 22, when the probe could read it at match time. */
  startTime?: string;
}

/** Injected process probes, so no test reads a real `/proc` at signal time. */
export interface FleetPidProbe {
  /** Current start time of `pid`, or undefined when it cannot be read. */
  startTime: (pid: number) => string | undefined;
  /** Current argv of `pid`, or undefined when the process is gone. */
  argv: (pid: number) => readonly string[] | undefined;
}

/** Why a matched pid was not signalled. */
export type MemberPidSkipReason =
  | "cmdline-changed"
  | "identity-changed"
  | "identity-unavailable"
  | "reserved-pid";

/** What happened to one matched pid. */
export type MemberPidOutcome =
  | { pid: number; kind: "signalled" }
  | { pid: number; kind: "skipped"; reason: MemberPidSkipReason; detail: string }
  | { pid: number; kind: "failed"; error: string };

/**
 * Re-verify one matched pid immediately before it is signalled (pure).
 *
 * A pid captured by the scan can exit and its number be recycled before the
 * signal is sent. The token in argv is checked again **and** the start time must
 * still equal the value captured at match time: either mismatch means the signal
 * would reach a process the fleet never identified, so the pid is skipped rather
 * than killed. An unreadable start time is `identity-unavailable`, never "same".
 */
export function revalidateMemberPid(options: {
  taskId: string;
  matched: MemberPidIdentity;
  probe: FleetPidProbe;
}): { ok: true } | { ok: false; reason: MemberPidSkipReason; detail: string } {
  const pid = options.matched.pid;
  // init (pid 1) and the kernel range are never a member orchestrator, and a
  // signal to them is never recoverable — a corrupt process table must not make
  // this path a way to target them.
  if (pid <= 1) {
    return { ok: false, reason: "reserved-pid", detail: `pid ${pid} is not a member process` };
  }
  const argv = options.probe.argv(pid);
  if (argv === undefined) {
    return {
      ok: false,
      reason: "cmdline-changed",
      detail: `pid ${pid} is gone or its argv can no longer be read`,
    };
  }
  if (!isMemberOrchestratorArgv({ taskId: options.taskId, argv })) {
    return {
      ok: false,
      reason: "cmdline-changed",
      detail:
        `pid ${pid} no longer carries \`${memberSessionToken(options.taskId)}\`; the pid was ` +
        "reused by another process",
    };
  }
  const recorded = options.matched.startTime;
  if (recorded === undefined) {
    // On Linux `/proc/<pid>/stat` is readable for any live pid, so an unreadable
    // start time at match time means the process was already gone or the table is
    // inaccessible. argv alone cannot tell the matched process from one that
    // inherited its pid, and a signal is not recoverable: identity is unavailable,
    // which is never the same as "unchanged".
    return {
      ok: false,
      reason: "identity-unavailable",
      detail:
        `pid ${pid} had no readable start time at match time, so its identity cannot be ` +
        "established; not signalling on argv evidence alone",
    };
  }
  const current = options.probe.startTime(pid);
  if (current === undefined) {
    return {
      ok: false,
      reason: "identity-unavailable",
      detail: `pid ${pid} had start time ${recorded} at match time but it can no longer be read`,
    };
  }
  if (current !== recorded) {
    return {
      ok: false,
      reason: "identity-changed",
      detail: `pid ${pid} start time changed from ${recorded} to ${current}: the pid was reused`,
    };
  }
  return { ok: true };
}

/** Result of one signalling attempt for a member's orchestrator. */
export type StopMemberSessionResult =
  | {
      ok: true;
      /** Pids the signal was delivered to (empty when every match was skipped). */
      pids: readonly number[];
      /** Every matched pid's outcome, including skipped and failed ones. */
      outcomes: readonly MemberPidOutcome[];
    }
  | { ok: false; reason: "not-running" | "unidentifiable"; error: string };

/**
 * Re-verify and signal one matched pid, returning exactly one outcome.
 *
 * Split from the loop so each decision (skip vs signal vs fail) has one home and
 * one `try`: a failing kill for one pid can never abort the others.
 */
function signalVerifiedPid(options: {
  taskId: string;
  pid: number;
  probe: FleetPidProbe;
  captureStartTime: (pid: number) => string | undefined;
  signalName: NodeJS.Signals;
  signal: (pid: number, signal: NodeJS.Signals) => void;
}): MemberPidOutcome {
  const pid = options.pid;
  // Captured with the match: a pid that exits and is recycled between here and
  // the signal must never receive it (see `revalidateMemberPid`).
  const startTime = options.captureStartTime(pid);
  const verified = revalidateMemberPid({
    taskId: options.taskId,
    matched: { pid, ...(startTime === undefined ? {} : { startTime }) },
    probe: options.probe,
  });
  if (!verified.ok) {
    return { pid, kind: "skipped", reason: verified.reason, detail: verified.detail };
  }
  try {
    options.signal(pid, options.signalName);
    return { pid, kind: "signalled" };
  } catch (error) {
    return { pid, kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Send one signal to every process that carries the member's session token.
 *
 * **What this guarantees:** the signal was delivered to a process whose argv
 * names that member's orchestrator session *and* whose process identity (start
 * time) is unchanged since the match. **What it does not guarantee:** that pi
 * handles it gracefully, that the process has exited by the time this returns,
 * that a phase sub-agent process it spawned is also gone, or that the session's
 * in-flight writes are complete. The caller must therefore report exactly what was
 * signalled and tell the operator to verify the session and the worktree before
 * launching anything again.
 *
 * `unidentifiable` (scan failed) is refused, never guessed: signalling a pid we
 * cannot tie to the member would be killing an unrelated process. A pid that
 * fails re-verification is skipped and reported, and each pid is signalled in its
 * own `try` so one failure cannot abort the rest.
 */
export function stopMemberSession(options: {
  taskId: string;
  scan: FleetProcessScan;
  selfPid?: number;
  /** Injected so tests never signal anything. */
  signal: (pid: number, signal: NodeJS.Signals) => void;
  signalName?: NodeJS.Signals;
  /** Identity probes; defaults to `/proc`. */
  probe?: FleetPidProbe;
  /** Start-time capture at match time; defaults to the probe's own reader. */
  startTime?: (pid: number) => string | undefined;
}): StopMemberSessionResult {
  const liveness = classifyMemberLivenessFromScan({
    taskId: options.taskId,
    scan: options.scan,
    ...(options.selfPid === undefined ? {} : { selfPid: options.selfPid }),
  });
  switch (liveness.kind) {
    case "unknown":
      return {
        ok: false,
        reason: "unidentifiable",
        error:
          `could not identify the orchestrator session for ${options.taskId} (${liveness.reason}), ` +
          "so no signal was sent: killing a pid without proof of what it is would be worse than " +
          "leaving the member running",
      };
    case "absent":
      return {
        ok: false,
        reason: "not-running",
        error:
          `no live orchestrator process carries the session token ` +
          `\`${memberSessionToken(options.taskId)}\`, so there is nothing to stop`,
      };
    case "live": {
      const probe = options.probe ?? defaultFleetPidProbe;
      const captureStartTime = options.startTime ?? probe.startTime;
      const signalName = options.signalName ?? "SIGTERM";
      const outcomes = liveness.pids.map((pid) =>
        signalVerifiedPid({
          taskId: options.taskId,
          pid,
          probe,
          captureStartTime,
          signalName,
          signal: options.signal,
        }),
      );
      const signalled = outcomes
        .filter((outcome) => outcome.kind === "signalled")
        .map((outcome) => outcome.pid);
      return { ok: true, pids: signalled, outcomes };
    }
  }
}
