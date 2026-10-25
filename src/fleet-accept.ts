/**
 * Accepting a landed fleet member (bd-126 P5).
 *
 * "Merged" and "accepted" are different states, and only the second one lets a
 * fleet keep going without a human:
 *
 * - a merged branch is on the base branch, but the member's worktree, its merged
 *   branch, and its `in_progress` bead are still there — and a bead that is not
 *   closed keeps blocking its dependents in bd.
 * - accepting closes the bead and removes the worktree + merged branch, which is
 *   what `wt merge` does for a single-bead workflow.
 *
 * This module is deliberately separate from `fleet-merge.ts`: that module's
 * "merging is not closing" property holds by construction because it has no bd
 * seam at all, and keeping the seal/removal effects here keeps it that way. It is
 * also opt-in: `belayd_fleet_merge` still never touches a bead, and a run only
 * accepts when the launch asked for it.
 *
 * Both effects are conservative:
 *
 * - `git worktree remove` runs without `--force`, so a dirty worktree refuses and
 *   its files are left alone rather than deleted; `git branch -d` then refuses an
 *   unmerged branch, so no committed work can be dropped by this path.
 * - A close that fails is re-checked with a read-only `bd show`; a bead that is
 *   already closed (someone else accepted it) is not an error.
 */

/** One process run for the accept step; injected so tests never touch a real repo. */
export type FleetAcceptRunner = (
  argv: readonly string[],
  options: { cwd: string; timeoutInMs: number; maxBufferInBytes: number },
) => Promise<{ stdout: string; stderr: string }>;

export type FleetAcceptFailureReason =
  | "bead-close-failed"
  | "worktree-refused"
  | "worktree-remove-failed";

export interface AcceptLandedMemberOptions {
  /** The repository root checkout (never removed; only the base branch lives there). */
  rootCwd: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  /** Close the bead after a successful merge. */
  closeBead: boolean;
  /** Remove the worktree and the merged branch. */
  removeWorktree: boolean;
  now: number;
  git: FleetAcceptRunner;
  runBd: FleetAcceptRunner;
}

export type AcceptLandedMemberResult =
  | {
      ok: true;
      text: string;
      beadClosed: boolean;
      worktreeRemoved: boolean;
      warnings: readonly string[];
    }
  | { ok: false; reason: FleetAcceptFailureReason; text: string; warnings: readonly string[] };

const ACCEPT_TIMEOUT_MS = 120_000;
const ACCEPT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bound the close reason: one line, no markdown, no newlines. */
function closeReason(baseBranch: string): string {
  return `merged into ${baseBranch} via belayd_fleet_merge`.slice(0, 200);
}

/** `bd show <id> --json` → the recorded status, or undefined when it cannot be read. */
async function readBeadStatus(options: AcceptLandedMemberOptions): Promise<string | undefined> {
  try {
    const { stdout } = await options.runBd(["show", options.taskId, "--json"], {
      cwd: options.rootCwd,
      timeoutInMs: ACCEPT_TIMEOUT_MS,
      maxBufferInBytes: ACCEPT_MAX_BUFFER_BYTES,
    });
    const parsed: unknown = JSON.parse(stdout);
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof record !== "object" || record === null) return undefined;
    const status = (record as { status?: unknown }).status;
    return typeof status === "string" ? status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Close the bead, unless it is already closed.
 *
 * The read-back is what makes this idempotent: a second tick after a crash sees
 * `closed` and moves on instead of reporting a failure that did not happen.
 */
async function closeBead(
  options: AcceptLandedMemberOptions,
): Promise<{ ok: true; warnings: string[] } | { ok: false; error: string }> {
  const warnings: string[] = [];
  try {
    await options.runBd(["close", options.taskId, "--reason", closeReason(options.baseBranch)], {
      cwd: options.rootCwd,
      timeoutInMs: ACCEPT_TIMEOUT_MS,
      maxBufferInBytes: ACCEPT_MAX_BUFFER_BYTES,
    });
    return { ok: true, warnings };
  } catch (error) {
    const status = await readBeadStatus(options);
    if (status === "closed" || status === "done") {
      warnings.push(`${options.taskId} was already ${status}; nothing to close`);
      return { ok: true, warnings };
    }
    return { ok: false, error: errorText(error) };
  }
}

/**
 * Remove a merged member's worktree and branch.
 *
 * A refusal is a warning, not a failure: the work landed, and a leftover
 * worktree is a cleanup problem the operator can see and finish, not a reason to
 * keep the member in the fleet's capacity count forever.
 */
async function removeWorktree(
  options: AcceptLandedMemberOptions,
): Promise<{ removed: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    await options.git(["worktree", "remove", options.worktreePath], {
      cwd: options.rootCwd,
      timeoutInMs: ACCEPT_TIMEOUT_MS,
      maxBufferInBytes: ACCEPT_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    warnings.push(
      `left ${options.worktreePath} in place: \`git worktree remove\` refused (${errorText(error)})`,
    );
    return { removed: false, warnings };
  }
  try {
    // `-d` (not `-D`): a branch that is not merged is never deleted here.
    await options.git(["branch", "-d", options.branch], {
      cwd: options.rootCwd,
      timeoutInMs: ACCEPT_TIMEOUT_MS,
      maxBufferInBytes: ACCEPT_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    warnings.push(`kept branch ${options.branch}: \`git branch -d\` refused (${errorText(error)})`);
  }
  return { removed: true, warnings };
}

/**
 * Accept one landed member: close its bead and remove its worktree.
 *
 * The caller has already merged the branch; this function asserts nothing about
 * the merge, so it is safe to re-run after a crash (a closed bead is skipped and
 * an already-removed worktree fails harmlessly with a warning).
 */
export async function acceptLandedMember(
  options: AcceptLandedMemberOptions,
): Promise<AcceptLandedMemberResult> {
  const warnings: string[] = [];

  if (options.worktreePath === options.rootCwd) {
    return {
      ok: false,
      reason: "worktree-refused",
      text: `refusing to accept ${options.taskId}: ${options.worktreePath} is the repository's own checkout`,
      warnings,
    };
  }

  if (options.closeBead) {
    const closed = await closeBead(options);
    if (!closed.ok) {
      return {
        ok: false,
        reason: "bead-close-failed",
        text: `merged ${options.taskId}, but closing the bead failed: ${closed.error}`,
        warnings,
      };
    }
    warnings.push(...closed.warnings);
  }

  const removal = options.removeWorktree
    ? await removeWorktree(options)
    : { removed: false, warnings: [] as string[] };
  warnings.push(...removal.warnings);

  const lines = [
    options.closeBead
      ? `accepted ${options.taskId}: bead closed`
      : `accepted ${options.taskId}: bead left open (accept disabled)`,
    removal.removed
      ? `removed worktree ${options.worktreePath} and merged branch ${options.branch}`
      : `worktree ${options.worktreePath} kept`,
  ];
  return {
    ok: true,
    text: lines.join("; "),
    beadClosed: options.closeBead,
    worktreeRemoved: removal.removed,
    warnings,
  };
}
