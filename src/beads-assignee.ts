/**
 * Assignee ownership mirror (bd-150).
 *
 * Forty of forty-one live beads were unassigned, so nobody could tell at a
 * glance which agent was driving a workflow. This module keeps the driving
 * actor as the bead's assignee:
 *
 * - set at launch (unassigned beads only),
 * - cleared at every workflow end (completion, accept and stop),
 * - never clobbering a human's manual assignment.
 *
 * Both writes are compare-and-set (`--if-assignee`). bd exits 13 when a guard is
 * stale and nothing was written, so that rejection is classified separately from
 * a real failure and settled by re-reading `bd show --json`: the observed
 * assignee is the only honest source of truth for what actually landed. bd is
 * optional and often slow, so every failure here is a value the caller warns
 * about — never a throw, never a blocked launch.
 */

import { clearAssigneeArgv, isBelaydActor, parseAssignee, setAssigneeArgv } from "./beads-actor.js";

/** One process run for the mirror; injected so tests never touch a real repo. */
export type BeadsAssigneeRunner = (
  argv: readonly string[],
  options: { cwd: string; timeoutInMs: number; maxBufferInBytes: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Outcome shared by both mirror directions. */
export type BeadsAssigneeResult =
  | { ok: true; changed: boolean; warnings: readonly string[] }
  | { ok: false; error: string };

export interface MirrorAssigneeOptions {
  taskId: string;
  /** The workflow's driving actor, e.g. `belayd:bd-150:orchestrator`. */
  actor: string;
  cwd: string;
  runBd: BeadsAssigneeRunner;
}

export interface ClearAssigneeOptions {
  taskId: string;
  /**
   * The actor expected to hold the bead. Narrows what counts as "ours" when the
   * bead was set before this module existed; a `belayd:` actor is ours anyway.
   */
  holder?: string;
  cwd: string;
  runBd: BeadsAssigneeRunner;
}

const ASSIGNEE_TIMEOUT_MS = 30_000;
const ASSIGNEE_MAX_BUFFER_BYTES = 1024 * 1024;

/** bd exits 13 when an `--if-assignee` guard no longer matches what was read. */
const GUARD_MISMATCH_EXIT_CODE = 13;

/**
 * bd's own guard sentence: `assignee mismatch: <id> is held by "<holder>", expected …`.
 *
 * Unanchored on purpose: bd never starts a line with it. Real bd 1.3 stderr is
 * `Error updating <id>: assignee mismatch: …` plus a repeated
 * `  <id>: updating issue: assignee mismatch: …` line, so a line anchor would
 * never match and the exit-code branch would be the only classifier left.
 *
 * The `is held by "…", expected ` tail is what keeps this honest: a flag-misuse
 * usage dump or any help text that merely mentions the guard has no such tail,
 * so a loose phrase test cannot turn a real failure into a phantom lost guard.
 */
const GUARD_MISMATCH_TEXT = /assignee mismatch: .+ is held by ".*", expected /;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when a `bd` rejection is the CAS guard losing, not a real failure.
 *
 * bd documents exit 13 as "stale `--if-assignee` guard, nothing was written".
 * The exit code is the exact signal; the fallback only accepts bd's own guard
 * sentence with its `is held by "…", expected ` tail. Everything else — an
 * unreadable db, permissions, a missing binary, a usage dump — is a real failure
 * that must be reported instead of papered over by re-reading the bead.
 */
export function isGuardMismatch(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === GUARD_MISMATCH_EXIT_CODE) return true;
  const stderr = (error as { stderr?: unknown }).stderr;
  const message = error instanceof Error ? error.message : "";
  const text = typeof stderr === "string" ? `${stderr}\n${message}` : message;
  return GUARD_MISMATCH_TEXT.test(text);
}

type AssigneeRead = { ok: true; assignee: string | undefined } | { ok: false; error: string };

/** Read the bead's current assignee; a bd failure is a value, not a throw. */
async function readAssignee(options: {
  taskId: string;
  cwd: string;
  runBd: BeadsAssigneeRunner;
}): Promise<AssigneeRead> {
  try {
    const { stdout } = await options.runBd(["show", options.taskId, "--json"], {
      cwd: options.cwd,
      timeoutInMs: ASSIGNEE_TIMEOUT_MS,
      maxBufferInBytes: ASSIGNEE_MAX_BUFFER_BYTES,
    });
    return { ok: true, assignee: parseAssignee(stdout) };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

type WriteOutcome = { ok: true } | { ok: false; error: unknown };

/** One CAS write; a failure is a value so the caller can classify it. */
async function attemptWrite(options: {
  argv: readonly string[];
  cwd: string;
  runBd: BeadsAssigneeRunner;
}): Promise<WriteOutcome> {
  try {
    await options.runBd(options.argv, {
      cwd: options.cwd,
      timeoutInMs: ASSIGNEE_TIMEOUT_MS,
      maxBufferInBytes: ASSIGNEE_MAX_BUFFER_BYTES,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Warning for a bead someone else owns; the launch still proceeds. */
function heldByWarning(taskId: string, holder: string): string {
  return `${taskId} is assigned to "${holder}"; left the assignment alone`;
}

type ClaimSettlement =
  | { kind: "settled"; result: BeadsAssigneeResult }
  | { kind: "still-unassigned" };

/**
 * Decide a lost CAS claim from the assignee bd actually records.
 *
 * `still-unassigned` means nothing was written and nobody else won either, which
 * is the one case where retrying the claim can still produce the intent.
 */
async function settleClaim(options: MirrorAssigneeOptions): Promise<ClaimSettlement> {
  const after = await readAssignee(options);
  if (!after.ok) {
    return {
      kind: "settled",
      result: {
        ok: false,
        error: `re-reading ${options.taskId} after a lost guard failed: ${after.error}`,
      },
    };
  }
  const assignee = after.assignee;
  if (assignee === options.actor) {
    return { kind: "settled", result: { ok: true, changed: true, warnings: [] } };
  }
  if (assignee !== undefined) {
    return {
      kind: "settled",
      result: { ok: true, changed: false, warnings: [heldByWarning(options.taskId, assignee)] },
    };
  }
  return { kind: "still-unassigned" };
}

/**
 * Claim an unassigned bead for the workflow's driving actor.
 *
 * Already ours is a no-op (handoff re-mirrors the same actor). A different
 * assignee is reported and left alone: a human who picked the bead outranks a
 * launch. Only the unassigned case writes, and the write is CAS-guarded.
 */
export async function mirrorAssignee(options: MirrorAssigneeOptions): Promise<BeadsAssigneeResult> {
  const current = await readAssignee(options);
  if (!current.ok) {
    return { ok: false, error: `could not read ${options.taskId}: ${current.error}` };
  }
  const existing = current.assignee;
  if (existing === options.actor) return { ok: true, changed: false, warnings: [] };
  if (existing !== undefined) {
    return { ok: true, changed: false, warnings: [heldByWarning(options.taskId, existing)] };
  }

  const claim = { taskId: options.taskId, actor: options.actor };
  const claimed = await attemptWrite({
    argv: setAssigneeArgv(claim),
    cwd: options.cwd,
    runBd: options.runBd,
  });
  if (claimed.ok) return { ok: true, changed: true, warnings: [] };
  if (!isGuardMismatch(claimed.error)) return { ok: false, error: errorText(claimed.error) };

  // A lost guard wrote nothing, so the recorded assignee is the only evidence of
  // what actually happened rather than the rejection.
  const settled = await settleClaim(options);
  if (settled.kind === "settled") return settled.result;

  // Still unassigned is a transient race (the guard was momentarily non-empty,
  // then vacated), so one immediate retry turns it into the intended outcome.
  const retried = await attemptWrite({
    argv: setAssigneeArgv(claim),
    cwd: options.cwd,
    runBd: options.runBd,
  });
  if (retried.ok) return { ok: true, changed: true, warnings: [] };
  if (!isGuardMismatch(retried.error)) return { ok: false, error: errorText(retried.error) };
  const afterRetry = await settleClaim(options);
  if (afterRetry.kind === "settled") return afterRetry.result;
  // One retry is the whole budget: writes stay bounded, and the workflow's next
  // launch or stop re-mirrors, so a second inline retry buys nothing.
  return {
    ok: false,
    error:
      `${options.taskId} could not be assigned to ${options.actor}: ` +
      "the --if-assignee guard kept losing and nothing was written " +
      `(${errorText(retried.error)})`,
  };
}

/**
 * Release the bead, unless a non-harness assignee holds it.
 *
 * A human (or another tool) who assigned the bead keeps it; only a `belayd:`
 * actor — or the caller's expected `holder` — is cleared, and only while that
 * exact holder is still recorded.
 */
export async function clearAssignee(options: ClearAssigneeOptions): Promise<BeadsAssigneeResult> {
  const current = await readAssignee(options);
  if (!current.ok) {
    return { ok: false, error: `could not read ${options.taskId}: ${current.error}` };
  }
  const existing = current.assignee;
  if (existing === undefined) return { ok: true, changed: false, warnings: [] };
  if (!isBelaydActor(existing) && existing !== options.holder) {
    return { ok: true, changed: false, warnings: [heldByWarning(options.taskId, existing)] };
  }

  const cleared = await attemptWrite({
    argv: clearAssigneeArgv({ taskId: options.taskId, holder: existing }),
    cwd: options.cwd,
    runBd: options.runBd,
  });
  if (cleared.ok) return { ok: true, changed: true, warnings: [] };
  if (!isGuardMismatch(cleared.error)) return { ok: false, error: errorText(cleared.error) };

  const after = await readAssignee(options);
  if (!after.ok) {
    return {
      ok: false,
      error: `clearing ${options.taskId} lost its guard and the re-read failed: ${after.error}`,
    };
  }
  if (after.assignee === undefined) return { ok: true, changed: true, warnings: [] };
  if (after.assignee === existing) return { ok: false, error: errorText(cleared.error) };
  // Someone re-assigned the bead while we were clearing it; theirs wins.
  return { ok: true, changed: false, warnings: [heldByWarning(options.taskId, after.assignee)] };
}
