/**
 * Classifying a merge-drain rebase failure (bd-280).
 *
 * The drain's rebase used to treat every non-zero exit as terminal: the member
 * got a `land-failed` stop and was never retried, so an index lock, a stale
 * `.git/rebase-merge` from a crashed earlier attempt, a lockfile conflict, and a
 * real contradiction between two members' work all reached a person with the
 * same words. This module is the decision half of the fix: it reads what the
 * stopped rebase left behind and names the class, so the effectful layer in
 * `src/fleet-merge.ts` can recover the mechanical cases, delegate the ones a
 * living member can resolve itself, and stop the fleet only for a genuine
 * contradiction.
 *
 * Pure by construction: the conflicted paths and the per-path commit facts are
 * fetched by the caller (they only exist while the rebase is stopped), and every
 * function here is a total function of its input.
 */

/** Porcelain-v1 unmerged status pairs: both sides touched, or one side deleted. */
export const FLEET_REBASE_UNMERGED_STATUSES = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"] as const;

/** Lockfiles that are derived from a manifest and can be regenerated. */
export const FLEET_REBASE_GENERATED_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "flake.lock",
  "Cargo.lock",
] as const;

/** Build/derived trees whose content is an artifact of a command, not authored. */
export const FLEET_REBASE_GENERATED_DIRECTORIES = [
  "dist",
  "coverage",
  "node_modules",
  ".next",
] as const;

/**
 * Derived trees that are only recognized at the repository root.
 *
 * `build`/`out`/`result` are ambiguous: Gradle, Next and Nix put artifacts there,
 * but a source tree can carry an authored `src/build/` or `src/out/` of scripts.
 * Treating a nested one as regenerable would resolve *authored* work from the base
 * side, so a nested conflict on these names falls back to delegation or a stop
 * instead — the safe direction is a person, never a silent overwrite.
 */
export const FLEET_REBASE_GENERATED_ROOT_DIRECTORIES = ["build", "out", "result"] as const;

/** Directories that hold test snapshot artifacts. */
export const FLEET_REBASE_SNAPSHOT_DIRECTORIES = ["__snapshots__"] as const;

/** Suffix of a test snapshot file (vitest/jest). */
export const FLEET_REBASE_SNAPSHOT_SUFFIX = ".snap";

/** Paths a stop detail names before the `(+N more)` pointer takes over. */
export const REBASE_TEXT_PATH_LIMIT = 5;

/** Commits a stop detail names per side before the `(+N more)` pointer. */
const REBASE_TEXT_COMMIT_LIMIT = 2;

/** Landed sibling ids a contradiction detail names before `(+N more)`. */
const REBASE_TEXT_SIBLING_LIMIT = 3;

function isUnmergedStatus(status: string): boolean {
  return (FLEET_REBASE_UNMERGED_STATUSES as readonly string[]).includes(status);
}

/**
 * Conflicted paths of a `git status --porcelain -z` record, sorted and deduped.
 *
 * Only unmerged entries (`UU`, `AA`, `DD`, `AU`, `UD`, `UA`, `DU`) count: a
 * plain modification is not a conflict. `-z` is required rather than merely
 * convenient — a conflicted path with a space or a newline is C-quoted in the
 * line-oriented output, and a quoted literal matches neither a generated prefix
 * nor a snapshot suffix. Rename/copy records carry the original path as the next
 * NUL field (destination first), so that field is skipped instead of being read
 * as a status record of its own.
 */
export function parseConflictedPaths(porcelainZ: string): readonly string[] {
  const fields = porcelainZ.split("\0");
  const paths: string[] = [];
  let index = 0;
  while (index < fields.length) {
    const field = fields[index];
    index += 1;
    if (field === undefined || field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status.includes("R") || status.includes("C")) index += 1;
    if (!isUnmergedStatus(status) || path === "") continue;
    paths.push(path);
  }
  return [...new Set(paths)].sort();
}

/** What kind of generated content a path is, which decides how to regenerate it. */
export type GeneratedPathKind = "lockfile" | "derived" | "snapshot";

/**
 * Classify a path as generated/derived content, or `undefined` for authored work.
 *
 * Segment-based and case-sensitive on purpose: `dist/` is derived, a source file
 * named `dist-utils.ts` is not, and a case-insensitive match would let `Dist/`
 * (authored content) be resolved from the base side. `build`/`out`/`result` count
 * only at the repository root: a nested `src/out/` is authored code, not a
 * regenerable artifact (bd-280 S1).
 */
export function classifyGeneratedPath(path: string): GeneratedPathKind | undefined {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return undefined;
  const base = segments[segments.length - 1];
  if (base === undefined) return undefined;
  if ((FLEET_REBASE_GENERATED_LOCKFILES as readonly string[]).includes(base)) return "lockfile";
  if (base.endsWith(FLEET_REBASE_SNAPSHOT_SUFFIX) && base !== FLEET_REBASE_SNAPSHOT_SUFFIX) {
    return "snapshot";
  }
  if (
    segments.some((segment) =>
      (FLEET_REBASE_SNAPSHOT_DIRECTORIES as readonly string[]).includes(segment),
    )
  ) {
    return "snapshot";
  }
  const root = segments[0];
  if (
    root !== undefined &&
    (FLEET_REBASE_GENERATED_ROOT_DIRECTORIES as readonly string[]).includes(root)
  ) {
    return "derived";
  }
  if (
    segments.some((segment) =>
      (FLEET_REBASE_GENERATED_DIRECTORIES as readonly string[]).includes(segment),
    )
  ) {
    return "derived";
  }
  return undefined;
}

/** Whether a path is generated/derived, i.e. regenerable from the source tree. */
export function isGeneratedPath(path: string): boolean {
  return classifyGeneratedPath(path) !== undefined;
}

/** One commit that touched a conflicted path, as attribution needs it. */
export interface RebaseCommitFact {
  sha: string;
  /** Committer date in epoch ms (git reports seconds; the caller scales it). */
  committedAt: number;
}

/** One conflicted path plus the commits on each side that touched it. */
export interface RebaseConflictedPath {
  path: string;
  /** `git log <base>..HEAD -- <path>` in the member worktree. */
  memberCommits: readonly RebaseCommitFact[];
  /** `git log <base> -- <path>` in the root checkout. */
  baseCommits: readonly RebaseCommitFact[];
}

/**
 * What a failed rebase actually is.
 *
 * `not-a-conflict` and `generated` are mechanical, `delegable` still has a live
 * member that can decide, `contradiction` is the one a person must answer, and
 * `unknown` is everything the facts do not explain (which stops the fleet as it
 * did before bd-280, but now with the conflicted paths recorded).
 */
export type FleetRebaseClass =
  | { kind: "not-a-conflict" }
  | { kind: "generated"; paths: readonly string[] }
  | {
      kind: "contradiction";
      paths: readonly string[];
      memberCommits: readonly string[];
      baseCommits: readonly string[];
      /**
       * Members the run record proves already landed, so the text may name them.
       *
       * Empty is meaningful: the conflict is still a contradiction (base work
       * committed after the fleet started touches the same paths), but nothing
       * proves a *sibling* wrote it, so the text must not claim one.
       */
      landedSiblings: readonly string[];
    }
  | { kind: "delegable"; paths: readonly string[]; baseCommits: readonly string[] }
  | { kind: "unknown"; paths: readonly string[] };

export interface ClassifyRebaseFailureInput {
  /** Conflicted paths of the stopped rebase, with the commits that touched them. */
  conflicts: readonly RebaseConflictedPath[];
  /**
   * When the fleet was armed (`fleet.json#createdAt`), in epoch ms.
   *
   * Committer timestamps are the attribution signal, and this is why: a sibling
   * member's commits reach the base *only* through this drain's rebase plus
   * `--ff-only` merge, so their committer date is inside the fleet's lifetime,
   * while base work that predates the fleet is older than `createdAt`. When it is
   * unknown (`undefined`) no path is ever attributed to a sibling.
   */
  fleetStartedAt: number | undefined;
  /** Whether the member's own orchestrator lease is live at the tick that drains. */
  memberLive: boolean;
  /**
   * Members this run already landed (task ids), the only proof a base-side commit
   * is a sibling's rather than the base's own.
   *
   * It is separate from the timestamp because a person can commit to the base
   * during a fleet: that commit is inside the fleet window but is not a sibling's,
   * and narrating it as "member vs landed member" would point the operator at the
   * wrong owners. The stop direction stays the same either way — someone has to
   * decide — only the story changes.
   */
  landedSiblings?: readonly string[];
}

function uniqueShas(commits: readonly RebaseCommitFact[]): readonly string[] {
  return [...new Set(commits.map((commit) => commit.sha))];
}

function commitsSince(
  commits: readonly RebaseCommitFact[],
  since: number | undefined,
): readonly RebaseCommitFact[] {
  if (since === undefined) return [];
  return commits.filter((commit) => commit.committedAt >= since);
}

/**
 * Classify a failed rebase. Precedence is the contract:
 *
 * 1. no conflicted paths → `not-a-conflict` (nothing a person could inspect);
 * 2. every conflicted path generated → `generated` (regenerable, never a person);
 * 3. any conflicted path touched by a base-side commit at/after the fleet started
 *    → `contradiction` (a mixed case is still a contradiction, because a human
 *    decides which work wins). Only a *proven* sibling is named: without run-record
 *    evidence the text says base work committed after the fleet started;
 * 4. a live member lease → `delegable` (its own orchestrator resolves it);
 * 5. otherwise → `unknown` (stop the fleet, as before).
 */
export function classifyRebaseFailure(input: ClassifyRebaseFailureInput): FleetRebaseClass {
  if (input.conflicts.length === 0) return { kind: "not-a-conflict" };

  const paths = input.conflicts.map((conflict) => conflict.path);
  if (paths.every(isGeneratedPath)) return { kind: "generated", paths };

  const siblingWork = input.conflicts.filter(
    (conflict) => commitsSince(conflict.baseCommits, input.fleetStartedAt).length > 0,
  );
  if (siblingWork.length > 0) {
    return {
      kind: "contradiction",
      paths,
      memberCommits: uniqueShas(siblingWork.flatMap((conflict) => conflict.memberCommits)),
      baseCommits: uniqueShas(
        siblingWork.flatMap((conflict) => commitsSince(conflict.baseCommits, input.fleetStartedAt)),
      ),
      landedSiblings: [...new Set(input.landedSiblings ?? [])].sort(),
    };
  }

  const baseCommits = uniqueShas(input.conflicts.flatMap((conflict) => conflict.baseCommits));
  if (input.memberLive) return { kind: "delegable", paths, baseCommits };
  return { kind: "unknown", paths };
}

/** Bound a path list so the essential facts survive the stop-detail cap. */
export function formatRebasePathList(paths: readonly string[]): string {
  const shown = paths.slice(0, REBASE_TEXT_PATH_LIMIT).join(", ");
  const hidden = paths.length - REBASE_TEXT_PATH_LIMIT;
  return hidden > 0 ? `${shown} (+${hidden} more)` : shown;
}

function formatShas(shas: readonly string[]): string {
  const short = shas.slice(0, REBASE_TEXT_COMMIT_LIMIT).map((sha) => sha.slice(0, 12));
  const hidden = shas.length - short.length;
  return short.join(", ") + (hidden > 0 ? ` (+${hidden} more)` : "");
}

function formatSiblings(siblings: readonly string[]): string {
  if (siblings.length === 0) return "";
  const shown = siblings.slice(0, REBASE_TEXT_SIBLING_LIMIT).join(", ");
  const hidden = siblings.length - REBASE_TEXT_SIBLING_LIMIT;
  return hidden > 0 ? `${shown} (+${hidden} more)` : shown;
}

/**
 * A conflicting path list fitted into a bounded detail field, count first.
 *
 * The count survives any cap, then as many whole paths as fit before the
 * `(+N more)` pointer: a path cut mid-token is worse than an honest pointer, and
 * an operator acting on a delegation needs to know how many paths there are even
 * when the durable record cannot hold all of them (bd-280 W5).
 */
export function formatBoundedPathDetail(options: {
  prefix: string;
  paths: readonly string[];
  budget: number;
}): string {
  const paths = options.paths;
  const head = `${options.prefix} (${paths.length} path${paths.length === 1 ? "" : "s"}): `;
  const shown: string[] = [];
  for (const path of paths) {
    const candidate = [...shown, path].join(", ");
    const hidden = paths.length - shown.length - 1;
    const tail = hidden > 0 ? ` (+${hidden} more)` : "";
    if (head.length + candidate.length + tail.length > options.budget) break;
    shown.push(path);
  }
  const hidden = paths.length - shown.length;
  const body = shown.join(", ");
  return head + body + (hidden > 0 ? `${body === "" ? "" : " "}(+${hidden} more)` : "");
}

export interface RebaseConflictTextOptions {
  rebaseClass: FleetRebaseClass;
  branch: string;
  baseBranch: string;
  /** The git error, used where no better fact exists. */
  reason?: string;
}

/**
 * Operator/gate text for a classified rebase failure.
 *
 * A `land-failed` stop becomes a bd gate whose detail *is* this text, capped at
 * `FLEET_RUN_DETAIL_MAX_LENGTH` (400 chars), so the facts that must survive come
 * first: the commits for a contradiction, then a bounded path list. The complete
 * path list travels separately in the drain result's `paths` field.
 */
export function rebaseConflictText(options: RebaseConflictTextOptions): string {
  const { rebaseClass, branch, baseBranch } = options;
  const reason = options.reason ?? "no git error text";
  switch (rebaseClass.kind) {
    case "not-a-conflict":
      return `rebase of ${branch} onto ${baseBranch} failed with no conflicted files: ${reason}`;
    case "generated":
      return (
        `rebase of ${branch} onto ${baseBranch} conflicted only in generated paths ` +
        `(${formatRebasePathList(rebaseClass.paths)}) and could not be regenerated: ${reason}`
      );
    case "contradiction": {
      const siblings = formatSiblings(rebaseClass.landedSiblings);
      // The named owners come first so they survive the 400-char stop cap; the
      // sibling claim is made only when the run record proves one.
      const who =
        siblings === ""
          ? `base work committed after this fleet started (` +
            `${formatShas(rebaseClass.baseCommits)}) touches paths this member changed (` +
            `${formatShas(rebaseClass.memberCommits) || "unread commits"})`
          : `member ${formatShas(rebaseClass.memberCommits) || "commits"} vs landed ${siblings} (` +
            `${formatShas(rebaseClass.baseCommits)})`;
      return (
        `${branch} onto ${baseBranch} is a real contradiction: ${who}; conflicted paths: ` +
        formatRebasePathList(rebaseClass.paths)
      );
    }
    case "delegable":
      return (
        `rebase of ${branch} onto ${baseBranch} conflicts with base work ` +
        `(${formatShas(rebaseClass.baseCommits) || "no commits read"})` +
        // A delegable conflict that could not be handed over says so: the caller
        // passes a reason exactly when the delegation did not happen (a hint that
        // could not be written), and the text must not still claim it.
        (options.reason === undefined
          ? `; delegated to the member: ${formatRebasePathList(rebaseClass.paths)}`
          : `; not delegated (${options.reason}); conflicted paths: ` +
            formatRebasePathList(rebaseClass.paths))
      );
    case "unknown":
      return rebaseClass.paths.length === 0
        ? `rebase of ${branch} onto ${baseBranch} failed with no conflicted paths recorded: ${reason}`
        : `rebase of ${branch} onto ${baseBranch} failed (${reason}); conflicted paths: ` +
            formatRebasePathList(rebaseClass.paths);
  }
}
