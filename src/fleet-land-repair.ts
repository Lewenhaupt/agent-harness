/**
 * One bounded repair round for a refused landing (bd-277).
 *
 * A drain refuses a member's landing for two very different kinds of cause, and the
 * run used to stop the member for both. A *contradiction* (a real rebase conflict, a
 * broken queue entry, a paused fleet) is a decision only a person can make: retrying
 * it would burn the same minutes of gating on the same failure, which is why
 * `land-failed` is a terminal stop (`LAND_ATTEMPT_STOP_REASONS` in
 * `src/fleet-run.ts`). A refusal whose cause is a **mechanical defect in the member's
 * own diff** is not that: the publish gate refusing proof artifacts (bd-181/bd-276),
 * a path outside the fleet's scope, or the member's own code failing a merge gate are
 * all things the member can fix in one commit, in its own worktree, without anybody
 * deciding anything (bd-170, bd-161, bd-160 each stopped on
 * `proof-artifacts-in-diff` and were merged by hand).
 *
 * This module is the decision half of that fix and is pure: it names which refusals
 * are repairable, whether this attempt may still be repaired, and what the repair
 * round says. The effectful half (`extensions/capabilities/fleet.ts`) records the
 * attempt, relaunches or mails the member, and holds the landing until the branch
 * moves.
 *
 * Classification is by {@link FleetMergeFailureReason} — the drain's own enumerated
 * verdict — and never by matching the refusal's prose. Wording is model- and
 * caller-dependent text; the reason is the artefact this repository controls.
 */

import type { FleetMergeFailureReason } from "./fleet-merge.js";

/**
 * Repair rounds one member gets before the refusal stops it.
 *
 * One: the common case is a single mechanical defect the member introduced, and a
 * second round only reproduces the first one's cost (another worktree session,
 * another full gate run). A member that needs two repairs needs a person.
 */
export const MAX_LAND_REPAIR_ATTEMPTS = 1;

/**
 * How long a repair round may hold the landing before it is judged abandoned.
 *
 * The hold exists so the loop cannot re-drain an unchanged branch while a repair
 * session is still starting; without a bound, a member that never repairs would be
 * held forever and the run would never report it. Thirty minutes mirrors
 * `FLEET_REBASE_DELEGATION_GRACE_MS` (src/fleet-merge.ts): it is the same order as a
 * member's own gated phase run, and it is far past the point where a session that was
 * asked to make one commit can still be starting. Past it, the member stops for a
 * human with the branch tip as evidence that nothing happened.
 */
export const FLEET_LAND_REPAIR_GRACE_MS = 30 * 60 * 1000;

/** Characters of a refusal kept in a status line or a report line. */
export const LAND_REPAIR_REFUSAL_MAX_CHARS = 200;
/**
 * The refusals whose cause is a mechanical defect in the member's own diff.
 *
 * - `proof-artifacts-in-diff` / `paths-outside-scope`: the publish gate refused the
 *   payload. The repair is to remove the proof files from the branch (or drop the
 *   out-of-scope path) and keep `.belayd/proof-receipt.json` — a commit, no judgement.
 * - `gate-failed`: the member's own code failed a gate the merge runs, so the fix is
 *   in the member's code.
 *
 * Everything else stays terminal. `rebase-failed` is a real contradiction between
 * siblings, `rebase-delegated` is already the member's own rebase to resolve, and the
 * queue/state/lease reasons (`lock-unavailable`, `queue-unreadable`,
 * `intent-unreadable`, `entry-not-queued`, `queue-write-failed`,
 * `intent-write-failed`, `no-queued-entry`, `fleet-paused`, `member-*`,
 * `root-*`, `gate-commands-missing`, `publish-payload-unreadable`, `stash-failed`,
 * `step-failed`, `merge-failed`, `restore-conflict`) are the supervisor's or the
 * operator's condition, not something a commit in the member worktree can change.
 */
export const FLEET_REPAIRABLE_LAND_REFUSALS: readonly FleetMergeFailureReason[] = [
  "proof-artifacts-in-diff",
  "paths-outside-scope",
  "gate-failed",
];

/**
 * Whether a refusal names a defect the member can repair in its own diff.
 *
 * The `switch` is deliberately exhaustive rather than a lookup on the tuple: adding a
 * `FleetMergeFailureReason` without deciding whether the member can fix it fails the
 * typecheck on the `never` assignment below, instead of silently defaulting to
 * "terminal" (a member stopped for something it could have fixed) or "repairable" (a
 * repair round spent on a contradiction).
 */
export function isRepairableLandRefusal(reason: FleetMergeFailureReason): boolean {
  switch (reason) {
    case "proof-artifacts-in-diff":
    case "paths-outside-scope":
    case "gate-failed":
      return true;
    case "fleet-paused":
    case "queue-unreadable":
    case "no-queued-entry":
    case "intent-unreadable":
    case "lock-unavailable":
    case "root-not-own-checkout":
    case "root-not-on-base":
    case "member-worktree-missing":
    case "member-worktree-dirty":
    case "member-branch-mismatch":
    case "member-branch-missing":
    case "gate-commands-missing":
    case "publish-payload-unreadable":
    case "stash-failed":
    case "rebase-failed":
    case "rebase-delegated":
    case "step-failed":
    case "merge-failed":
    case "restore-conflict":
    case "entry-not-queued":
    case "queue-write-failed":
    case "intent-write-failed":
      return false;
  }
  // Unreachable while the switch above covers every reason; the assignment is what
  // makes a newly added reason a compile error rather than a silent third answer.
  const unclassified: never = reason;
  return unclassified;
}

/** What to do about a refusal, once the attempt already spent is known. */
export type LandRepairPlan = { kind: "repair" } | { kind: "stop"; detail: string };

/**
 * Whether this refusal may still be handed to the member, or stops it now.
 *
 * `attemptsSoFar` is the count recorded on the run member, so the second refusal of
 * the same member reaches `stop` — the exact behaviour the member had before bd-277.
 */
export function planLandRepair(options: {
  reason: FleetMergeFailureReason;
  attemptsSoFar: number;
}): LandRepairPlan {
  if (!isRepairableLandRefusal(options.reason)) {
    return {
      kind: "stop",
      detail: `${options.reason} is not something a commit in the member's own diff can change`,
    };
  }
  if (options.attemptsSoFar >= MAX_LAND_REPAIR_ATTEMPTS) {
    // A *prefix*, not a suffix: the run record bounds a stop detail at
    // `FLEET_RUN_DETAIL_MAX_LENGTH` from the front, so anything appended after a long
    // refusal is the first thing lost. The caller puts this in front of the refusal
    // and bounds the refusal to the room it leaves (bd-277 review W2).
    return {
      kind: "stop",
      detail:
        `repair ${options.attemptsSoFar} of ${MAX_LAND_REPAIR_ATTEMPTS} did not clear this ` +
        `(${options.reason})`,
    };
  }
  return { kind: "repair" };
}

/**
 * Characters a repair task body may use.
 *
 * Equal to `FLEET_NOTE_BODY_MAX_LENGTH` (the mailbox truncates a note body at that
 * many characters) but declared here rather than imported from `src/fleet-state.ts`:
 * importing the state module from this decision module would put
 * `fleet-status → fleet-land-repair → fleet-state → fleet-status` in a load-time
 * cycle. `fleet-land-repair.test.ts` asserts this value never exceeds the note limit,
 * so the two cannot drift silently.
 */
export const LAND_REPAIR_TASK_MAX_LENGTH = 2000;

/** Characters of the refusal a repair task keeps before its bounded path list. */
const LAND_REPAIR_REFUSAL_SEGMENT_MAX_CHARS = 600;

/**
 * The instruction block, verbatim and never truncated.
 *
 * It is built first and outside the budget arithmetic because it *is* the round: a
 * member that receives the refusal without these rules is being told what went wrong
 * and not what to do about it (bd-277 review W3).
 */
function landRepairInstructions(taskId: string): readonly string[] {
  return [
    `# Repair the refused landing of ${taskId}`,
    "",
    "## What to do",
    "",
    "- Fix only the refused paths in your own diff. Nothing outside them belongs to this task.",
    "- Commit the fix on the same branch you already work on. Do not merge, do not rebase onto " +
      "the base branch, and do not touch any other branch.",
    "- Do not change the bead's scope (its title, plan, or acceptance), and do not edit the " +
      "fleet record.",
    "- When the fix is committed, end your turn: the fleet drains the same entry again.",
    "",
    `This is a single repair round (the fleet asks ${MAX_LAND_REPAIR_ATTEMPTS} time(s)). If the ` +
      "landing is refused again after your commit, the member stops for a human instead of " +
      "asking again.",
  ];
}

/**
 * The refusal section of a repair task, fitted into the room the instructions left.
 *
 * The refusal is quoted (never reworded), the path list is our own and always states
 * how many of the refused paths it actually names: a truncated list that still reads
 * as complete would send the member looking for paths it cannot see.
 */
function landRepairRefusedSection(options: {
  refusal: string;
  paths: readonly string[];
  budget: number;
}): string {
  const { paths, refusal } = options;
  if (paths.length === 0) return boundLandRepairText(refusal, options.budget);

  // Reserve the widest count line first, so the reservation can never be under-cut by
  // the actual count (`(N of M, the rest did not fit)` is the longest form).
  const widestCount = `Refused paths (${paths.length} of ${paths.length}, the rest did not fit):`;
  const refusalBudget = Math.min(
    LAND_REPAIR_REFUSAL_SEGMENT_MAX_CHARS,
    Math.max(1, options.budget - widestCount.length - 2),
  );
  const boundedRefusal = boundLandRepairText(refusal, refusalBudget);
  const separator = "\n\n";
  const forPaths = options.budget - boundedRefusal.length - separator.length;
  const lines: string[] = [];
  let used = widestCount.length;
  for (const path of paths) {
    const line = `\n- ${path}`;
    if (used + line.length > forPaths) break;
    lines.push(line);
    used += line.length;
  }
  // Not even one whole path fits beside the refusal: the refusal is the more useful
  // half, so it takes the whole budget (and a refusal that was truncated says so with
  // its own ellipsis).
  if (lines.length === 0) return boundLandRepairText(refusal, options.budget);
  const count =
    lines.length === paths.length
      ? `Refused paths (${paths.length}):`
      : `Refused paths (${lines.length} of ${paths.length}, the rest did not fit):`;
  return `${boundedRefusal}${separator}${count}${lines.join("")}`;
}

/**
 * The task text one repair round hands the member.
 *
 * The instructions come first: they are the round's contract, and a note body is
 * truncated at its own limit (2000 characters), so anything placed after a long
 * refusal can be lost. The refusal is quoted verbatim and bounded to the room the
 * instructions leave, together with a path list that states how many paths it names
 * (bd-277 review W3). A short refusal is emitted unchanged.
 */
export function fleetLandRepairTask(options: {
  taskId: string;
  reason: FleetMergeFailureReason;
  refusal: string;
  paths?: readonly string[];
}): string {
  const header = [
    ...landRepairInstructions(options.taskId),
    "",
    "## What was refused",
    "",
    `${options.reason}`,
  ].join("\n");
  const separator = "\n\n";
  const budget = Math.max(1, LAND_REPAIR_TASK_MAX_LENGTH - header.length - separator.length);
  const refused = landRepairRefusedSection({
    refusal: options.refusal,
    paths: options.paths ?? [],
    budget,
  });
  return `${header}${separator}${refused}`;
}

/** The repair attempt a status line renders: the run member's record, reduced. */
export interface LandRepairView {
  attempts: number;
  refusal: string;
}

/**
 * `text` collapsed to one line and cut to at most `budget` characters at a word
 * boundary.
 *
 * Budgeted rather than fixed-length because every caller reserves room for text that
 * must survive — a stop detail's provenance marker, a repair task's instruction block —
 * and then lets this shorten only the refusal. Cutting at a space means a refused path
 * is never split in half. The bound is UTF-16 length, the same unit the run record's
 * own bound uses, so a caller's arithmetic cannot be under-cut by surrogate pairs.
 */
export function boundLandRepairText(text: string, budget: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= budget) return flat;
  if (budget <= 1) return "…";
  const head = flat.slice(0, budget - 1);
  const boundary = head.lastIndexOf(" ");
  return `${boundary > 0 ? head.slice(0, boundary) : head}…`;
}

/** A refusal reduced to one status line's budget, cut at a word boundary. */
export function boundLandRepairRefusal(refusal: string): string {
  return boundLandRepairText(refusal, LAND_REPAIR_REFUSAL_MAX_CHARS);
}

/**
 * `repair 1 of 1 — <refusal>`, the one shape every status surface renders.
 *
 * Shared rather than written per surface: the member block, the run header, and the
 * single-bead section must agree about how many rounds a member has had, exactly as
 * the stop renderers share `fleetRunStopAnswer`.
 */
export function formatLandRepairStatus(repair: LandRepairView): string {
  return (
    `repair ${repair.attempts} of ${MAX_LAND_REPAIR_ATTEMPTS} — ` +
    boundLandRepairRefusal(repair.refusal)
  );
}
