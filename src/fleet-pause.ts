/**
 * Cooperative fleet pause and resume (bd-126 P4).
 *
 * A pause is **operator intent stored in the intent record**, not a supervisor
 * loop: `fleet.json` `paused` is what every starting action checks — a launch
 * refuses (see `planFleetLaunch`), a merge drain refuses (`fleet-paused`) — so the
 * fleet stops starting new work the moment the flag is written. A parked fleet
 * (base restore conflicted) is paused for the same reason plus a recorded stash.
 *
 * What a cooperative pause does **not** do: it does not interrupt a member's
 * running phase. Members are detached sessions; they learn about the pause from a
 * turn-start `pause` mailbox note and stop *starting* work on their own. Stopping a
 * member that will not cooperate is a separate, explicitly audited, forceful path
 * (`belayd_fleet_pause --force`, see `src/fleet-sessions.ts` for exactly what the
 * signal does and does not guarantee).
 *
 * **Resume is the only writer that clears `paused`.** Before P4 nothing cleared
 * it, so un-parking meant hand-editing `fleet.json`. Every mutation here goes
 * through the compare-and-replace path (`updateFleetIntent`) so a concurrent
 * operator note or member prune is never silently lost.
 */

import type { FleetStateFs } from "./fleet-state.js";
import { appendFleetAuditEntry, updateFleetIntent, withoutPauseFields } from "./fleet-state.js";
import type { FleetIntent } from "./fleet-status.js";

function audit(options: {
  gitCommonDir: string;
  fleetId: string;
  sessionId: string;
  now: number;
  action: string;
  taskIds: readonly string[];
  detail: string;
  fs?: FleetStateFs;
}): string | undefined {
  const appended = appendFleetAuditEntry({
    gitCommonDir: options.gitCommonDir,
    fleetId: options.fleetId,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    entry: {
      timestamp: options.now,
      fleetId: options.fleetId,
      actor: options.sessionId,
      action: options.action,
      taskIds: [...options.taskIds],
      detail: options.detail,
    },
  });
  return appended.ok
    ? undefined
    : `fleet ${options.fleetId}: could not append to audit.log (${appended.error})`;
}

export interface PauseFleetInput {
  gitCommonDir: string;
  fleetId: string;
  /** Supervisor session id, recorded as the audit actor. */
  sessionId: string;
  /** Clock value supplied by the caller (one timestamp per call). */
  now: number;
  /** Operator-visible reason; defaults to a generic pause line. */
  reason?: string;
  fs?: FleetStateFs;
}

export type PauseFleetResult =
  | { ok: true; text: string; alreadyPaused: boolean; warnings: readonly string[] }
  | {
      ok: false;
      reason: "no-intent" | "corrupt-intent" | "read-failed" | "conflict" | "write-failed";
      error: string;
      warnings: readonly string[];
    };

/**
 * The refusal kind for one failed intent write (no reason is collapsed).
 *
 * Shared by pause and resume: a corrupt record must never be reported as a write
 * failure, because the operator's next step differs (inspect the record, not retry
 * the write).
 */
function intentWriteRefusalReason(
  reason: "corrupt-intent" | "read-failed" | "write-failed" | "conflict" | "refused",
): "no-intent" | "corrupt-intent" | "read-failed" | "conflict" | "write-failed" {
  switch (reason) {
    case "refused":
      return "no-intent";
    case "corrupt-intent":
      return "corrupt-intent";
    case "read-failed":
      return "read-failed";
    case "conflict":
      return "conflict";
    case "write-failed":
      return "write-failed";
  }
}

/** Map a failed write onto the pause refusal reason, auditing the failure. */
function pauseFailure(
  input: PauseFleetInput,
  written: {
    reason: "corrupt-intent" | "read-failed" | "write-failed" | "conflict" | "refused";
    error: string;
  },
): PauseFleetResult {
  const auditWarning = audit({
    gitCommonDir: input.gitCommonDir,
    fleetId: input.fleetId,
    sessionId: input.sessionId,
    now: input.now,
    action: "fleet-pause-failed",
    taskIds: [],
    detail: written.error,
    ...(input.fs === undefined ? {} : { fs: input.fs }),
  });
  return {
    ok: false,
    reason: intentWriteRefusalReason(written.reason),
    error: written.error,
    warnings: auditWarning === undefined ? [] : [auditWarning],
  };
}

/**
 * Write the cooperative pause flag (compare-and-replace, audited).
 *
 * Pausing twice is not an error: the second call reports that the fleet was
 * already paused instead of rewriting the reason, so an operator's original
 * wording survives a repeated request.
 */
export function pauseFleet(input: PauseFleetInput): PauseFleetResult {
  const reason = input.reason ?? "paused by the fleet supervisor";
  let alreadyPaused = false;

  const written = updateFleetIntent({
    gitCommonDir: input.gitCommonDir,
    fleetId: input.fleetId,
    ...(input.fs === undefined ? {} : { fs: input.fs }),
    update: (current) => {
      if (current === undefined) {
        return { refuse: `no fleet intent for \`${input.fleetId}\`; launch the fleet first` };
      }
      if (current.paused === true) {
        alreadyPaused = true;
        return current;
      }
      return { ...current, paused: true, note: reason, updatedAt: input.now };
    },
  });
  if (!written.ok) return pauseFailure(input, written);

  const warnings: string[] = [];
  // An "already paused" call changed nothing, so there is nothing new to audit; a
  // real pause is an authority decision and belongs in the history.
  if (!alreadyPaused) {
    const pauseAudit = audit({
      gitCommonDir: input.gitCommonDir,
      fleetId: input.fleetId,
      sessionId: input.sessionId,
      now: input.now,
      action: "fleet-paused",
      taskIds: [...written.intent.taskIds],
      detail: reason,
      ...(input.fs === undefined ? {} : { fs: input.fs }),
    });
    if (pauseAudit !== undefined) warnings.push(pauseAudit);
  }

  return {
    ok: true,
    alreadyPaused,
    text: alreadyPaused
      ? `Fleet \`${input.fleetId}\` was already paused; the recorded reason is unchanged.`
      : `Fleet \`${input.fleetId}\` is paused: no launch and no merge starts until ` +
        "belayd_fleet_resume. Members keep their current turn; they stop starting new " +
        "work only if they honour the pause note (running phases are not interrupted).",
    warnings,
  };
}

export interface ResumeFleetInput {
  gitCommonDir: string;
  fleetId: string;
  sessionId: string;
  now: number;
  /**
   * Clear a park whose stash has not been verified as restored.
   *
   * Only this flag allows it, and it never touches the stash itself: the ref is
   * named in the report so the operator can still find the work. Without it, a
   * parked fleet must be repaired by `belayd_fleet_reconcile` first, which
   * verifies the root is on the base and restores the recorded sha.
   */
  force?: boolean;
  fs?: FleetStateFs;
}

export type ResumeFleetResult =
  | {
      ok: true;
      text: string;
      unparked: boolean;
      /** True when the fleet was already running, so nothing was changed. */
      alreadyResumed: boolean;
      warnings: readonly string[];
    }
  | {
      ok: false;
      reason:
        | "no-intent"
        | "parked-stash"
        | "corrupt-intent"
        | "read-failed"
        | "conflict"
        | "write-failed";
      error: string;
      warnings: readonly string[];
    };

/** The intent without the pause-related fields, keeping every fact the fleet still needs. */
function withoutPause(intent: FleetIntent, now: number): FleetIntent {
  return withoutPauseFields(intent, now);
}

/**
 * Clear `paused` (and the park record + its note), audited.
 *
 * A park carrying a stash ref is refused unless `force` is set: clearing the
 * pointer before the work is back in the checkout would leave a paused-less fleet
 * whose operator work sits unnamed in `git stash list`. The refusal names the
 * exact recovery step (`belayd_fleet_reconcile`), so a fleet is never left paused
 * with no discoverable path back.
 *
 * Resuming a fleet that is not paused is not an error: like pause, the repeated
 * call reports the state and changes nothing, so the documented recovery
 * "reconcile, then belayd_fleet_resume" still succeeds when reconcile already
 * unparked the fleet.
 */
interface ResumeState {
  unparked: boolean;
  alreadyResumed: boolean;
  parkedStash?: string;
  refusal?: "no-intent" | "parked-stash";
}

/**
 * The pure updater behind a resume, extracted so each refusal cause has one home.
 *
 * The refusal kind is decided from the record read *inside* the update, so the
 * caller reports the real cause instead of parsing an error string.
 */
function resumeUpdater(input: ResumeFleetInput, state: ResumeState) {
  return (current: FleetIntent | undefined) => {
    if (current === undefined) {
      state.refusal = "no-intent";
      return { refuse: `no fleet intent for \`${input.fleetId}\`` };
    }
    const park = current.park;
    if (current.paused !== true && park === undefined) {
      state.alreadyResumed = true;
      return current;
    }
    // Recorded for the report either way: with force the ref is named so the
    // operator can still find the work that was left in the stash.
    if (park?.stashRef !== undefined) state.parkedStash = park.stashRef;
    if (park?.stashRef !== undefined && input.force !== true) {
      state.refusal = "parked-stash";
      return { refuse: parkedStashRefusal(input.fleetId, park.stashRef) };
    }
    state.unparked = park !== undefined;
    return withoutPause(current, input.now);
  };
}

/** The refusal text for a park whose stash has not been verified as restored. */
function parkedStashRefusal(fleetId: string, stashRef: string): string {
  return (
    `fleet \`${fleetId}\` is parked with the root work at ${stashRef}; run ` +
    "belayd_fleet_reconcile to restore it (it verifies the root is on the base branch " +
    "first) and unpark the fleet, or resume with force to clear the pause and leave the " +
    `stash untouched (it stays as ${stashRef})`
  );
}

/** Audit a refused resume and render it. */
function resumeRefusal(options: {
  input: ResumeFleetInput;
  state: ResumeState;
  written: {
    reason: "corrupt-intent" | "read-failed" | "write-failed" | "conflict" | "refused";
    error: string;
  };
}): ResumeFleetResult {
  const { input, state } = options;
  const warnings: string[] = [];
  const refusalAudit = audit({
    gitCommonDir: input.gitCommonDir,
    fleetId: input.fleetId,
    sessionId: input.sessionId,
    now: input.now,
    action: "fleet-resume-refused",
    taskIds: [],
    detail: options.written.error,
    ...(input.fs === undefined ? {} : { fs: input.fs }),
  });
  if (refusalAudit !== undefined) warnings.push(refusalAudit);
  return {
    ok: false,
    // A refusal decided inside the updater (a park that still names a stash) is
    // more specific than the write outcome, so it wins; everything else keeps the
    // precise write failure instead of collapsing into "write-failed".
    reason: state.refusal ?? intentWriteRefusalReason(options.written.reason),
    error: options.written.error,
    warnings,
  };
}

/** Audit an applied resume (and unpark) and render it. */
function resumeSuccess(options: {
  input: ResumeFleetInput;
  state: ResumeState;
  intent: FleetIntent;
}): ResumeFleetResult {
  const { input, state } = options;
  if (state.alreadyResumed) {
    // Nothing changed, so nothing new belongs in the audit history — mirroring
    // pause, which also skips `fleet-paused` when it was already paused.
    return {
      ok: true,
      unparked: false,
      alreadyResumed: true,
      text: `Fleet \`${input.fleetId}\` was already running (not paused); nothing to resume.`,
      warnings: [],
    };
  }
  const warnings: string[] = [];
  const push = (warning: string | undefined): void => {
    if (warning !== undefined) warnings.push(warning);
  };

  push(
    audit({
      gitCommonDir: input.gitCommonDir,
      fleetId: input.fleetId,
      sessionId: input.sessionId,
      now: input.now,
      action: "fleet-resumed",
      taskIds: [...options.intent.taskIds],
      detail: "paused cleared by the supervisor",
      ...(input.fs === undefined ? {} : { fs: input.fs }),
    }),
  );

  const forced = input.force === true && state.parkedStash !== undefined;
  if (state.unparked) {
    push(
      audit({
        gitCommonDir: input.gitCommonDir,
        fleetId: input.fleetId,
        sessionId: input.sessionId,
        now: input.now,
        action: "fleet-unparked",
        taskIds: [],
        detail: forced
          ? `park cleared with force; the stash ${state.parkedStash ?? ""} was left in place`
          : "park cleared after the root work was restored",
        ...(input.fs === undefined ? {} : { fs: input.fs }),
      }),
    );
  }

  const forceNote = forced
    ? ` The recorded stash ${state.parkedStash ?? ""} was left in \`git stash list\`; nothing was deleted.`
    : "";
  return {
    ok: true,
    unparked: state.unparked,
    alreadyResumed: false,
    text:
      `Fleet \`${input.fleetId}\` resumed: launches and merges may start again.` +
      forceNote +
      (state.unparked ? "" : " (the fleet was not parked)"),
    warnings,
  };
}

/**
 * Clear `paused` (and the park record + its note), audited.
 *
 * A park carrying a stash ref is refused unless `force` is set: clearing the
 * pointer before the work is back in the checkout would leave a paused-less fleet
 * whose operator work sits unnamed in `git stash list`. The refusal names the
 * exact recovery step (`belayd_fleet_reconcile`), so a fleet is never left paused
 * with no discoverable path back.
 */
export function resumeFleet(input: ResumeFleetInput): ResumeFleetResult {
  // Mutable state object on purpose: assignments made inside the updater closure
  // must survive control-flow analysis, which a captured `let` union does not.
  const state: ResumeState = { unparked: false, alreadyResumed: false };
  const written = updateFleetIntent({
    gitCommonDir: input.gitCommonDir,
    fleetId: input.fleetId,
    ...(input.fs === undefined ? {} : { fs: input.fs }),
    update: resumeUpdater(input, state),
  });
  return written.ok
    ? resumeSuccess({ input, state, intent: written.intent })
    : resumeRefusal({ input, state, written });
}
