/**
 * Publish gate (bd-181) — the transition-period guard that keeps proof out of
 * the repository.
 *
 * Proof artifacts are uploaded to the proof-of-work platform; the workflow keeps
 * a receipt in the shared per-repository store
 * (`<git-common-dir>/belayd/state.sqlite`, bd-281) instead of files in the
 * worktree. The publish step must therefore never read or carry proof. There is
 * no publish executor yet (bd-174.3 owns the `gh`/`git push` argv), so this
 * module is the deterministic local gate that step will call, and the one the
 * merge drain already calls before any mutation.
 *
 * Everything here is pure: paths in, verdict out. No I/O, no throwing.
 *
 * **One normalization step, every predicate.** Paths are classified only after
 * trimming, rejecting backslashes (a Windows separator or an escape — either
 * way it cannot be read as a POSIX repo-relative path), dropping empty and `.`
 * segments, rejecting any `..` segment, then re-joining. Prefix checks run on
 * that normalized form, so `.//proof/x.png`, `././x.png`, `docs//proof/x.png`
 * and `.belayd//x` cannot slip past.
 *
 * **Non-ASCII paths are refused, not guessed.** Detection is byte-wise, so a
 * homoglyph directory (`docs/proоf/…` with a Cyrillic `о`) would otherwise
 * carry proof straight through. There is no reliable NFKC mapping for
 * lookalikes, so a non-ASCII path is refused as out of scope with a note
 * telling the operator to rename it — with one exception: a path already under
 * an ASCII proof directory (`docs/proof/café.png`) is proof content. The prefix
 * is anchored ASCII and cannot be spoofed, so classifying it as proof is
 * strictly stricter than the scope refusal. Failing closed on every other
 * non-ASCII name costs an exotic filename at publish time; guessing costs the
 * guard.
 *
 * `intendedPaths` is optional on purpose. The future publish executor knows the
 * payload it declared and passes it, which also catches a changed path that is
 * individually publishable but was never part of the intended payload. Callers
 * that only have the diff (the merge drain) omit it; the gate still refuses
 * harness-local, absolute, traversal, non-ASCII and proof-artifact paths in that
 * mode.
 *
 * **The repository can overrule the proof refusal.** `proofPolicy` (bd-276) is the
 * repo's own declaration (`.belayd/config.json` `proof.artifacts`, see
 * `src/proof-policy.ts`). Under `in-tree` — a repo that keeps text evidence in git
 * on purpose — proof paths are ordinary content and only the scope predicates
 * apply. The default is `forbid`, and a `pr`/`push` publish executor must pass it
 * explicitly whatever the repo declares, because a published PR is not the repo.
 *
 * **Proof is refused in one direction only.** This gate classifies the paths it
 * is given; it is the caller's job to pass a payload that means "carried in".
 * Proof artifacts that are *added or modified* are refused
 * (`proof-artifacts-in-diff`); *deleting* proof artifacts is allowed and is the
 * documented migration path (upload the proof, keep the receipt in the store,
 * remove the files). `drainFleetMerge` therefore
 * reads its diff with `--diff-filter=ACMRT`, which drops deletions. Renames stay
 * in that payload and are classified by their destination path, so moving proof
 * content out of a proof directory into a source path is still refused.
 */

import { isAbsolute } from "node:path";
import { DEFAULT_PROOF_ARTIFACT_POLICY, type ProofArtifactPolicy } from "./proof-policy.js";
import { isProofArtifactPath } from "./proof-verification.js";

/** Why the publish payload was refused. */
export type PublishGateRefusalReason = "proof-artifacts-in-diff" | "paths-outside-scope";

export interface PublishGateInput {
  /** Repo-relative paths the branch changes relative to the base. */
  changedPaths: readonly string[];
  /** The declared payload set, when the caller knows it. */
  intendedPaths?: readonly string[];
  /** The repo's declared proof policy; absent means the strict default. */
  proofPolicy?: ProofArtifactPolicy;
}

export type PublishGateResult =
  | {
      ok: true;
      paths: readonly string[];
      /**
       * Proof paths carried under an `in-tree` policy, sorted. Absent when none
       * were carried, so a caller that never sees this field has nothing to report.
       */
      proofArtifacts?: readonly string[];
    }
  | {
      ok: false;
      reason: PublishGateRefusalReason;
      paths: readonly string[];
      text: string;
    };

/** Directories whose whole subtree counts as proof, independent of extension. */
const PROOF_ARTIFACT_DIRS: readonly string[] = ["docs/proof/", "proof/", "proof-of-work/"] as const;

/**
 * Harness-local entries that are gitignored bookkeeping, never publishable.
 * `.belayd` itself is listed alongside its subtree: a branch that commits the
 * directory entry (or a symlink named `.belayd`) must not publish either.
 */
const HARNESS_LOCAL_PATHS: readonly string[] = [
  ".belayd",
  ".belayd-task.json",
  "proof-of-work",
] as const;

/** Windows drive/UNC prefixes are absolute too, even on a POSIX host. */
const WINDOWS_ABSOLUTE_PATTERN = /^(?:[A-Za-z]:|[\\/]{2})/;

/** Any non-printable-ASCII character, including lookalike Unicode paths. */
const NON_ASCII_PATTERN = /[^\x20-\x7E]/;

/** Cap on paths named in the refusal line; the `paths` field keeps them all. */
const MAX_REFUSAL_PATHS = 10;

type PathRejection = "empty" | "backslash" | "absolute" | "traversal";

type NormalizedPublishPath =
  | { ok: true; path: string; hasNonAscii: boolean }
  | { ok: false; kind: PathRejection; raw: string };

/**
 * The single normalization/classification step every predicate shares. A path
 * that cannot be normalized is not classified as anything; callers treat that
 * as "not publishable", never as "maybe publishable". Non-ASCII content is
 * reported (`hasNonAscii`) rather than dropped here, because anchored ASCII
 * prefix checks stay valid on such a path (see `isProofArtifactPathInDiff`).
 */
function normalizePublishPath(raw: string): NormalizedPublishPath {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, kind: "empty", raw: trimmed };
  if (trimmed.includes("\\")) return { ok: false, kind: "backslash", raw: trimmed };
  if (isAbsolute(trimmed) || WINDOWS_ABSOLUTE_PATTERN.test(trimmed)) {
    return { ok: false, kind: "absolute", raw: trimmed };
  }

  const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return { ok: false, kind: "traversal", raw: trimmed };
  if (segments.length === 0) return { ok: false, kind: "empty", raw: trimmed };

  const path = segments.join("/");
  return { ok: true, path, hasNonAscii: NON_ASCII_PATTERN.test(path) };
}

/** Path as the refusal should display it: normalized when possible, else raw. */
function publishDisplayPath(raw: string): string {
  const normalized = normalizePublishPath(raw);
  return normalized.ok ? normalized.path : normalized.raw;
}

/** Deterministic lexical sort (locale-independent, so refusals are stable). */
function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function dedupeSorted(paths: readonly string[]): string[] {
  return sortPaths([...new Set(paths)]);
}

/** True for an already-normalized, all-ASCII path that is proof content. */
function isProofArtifactNormalizedPath(path: string): boolean {
  if (isProofArtifactPath(path)) return true;
  return PROOF_ARTIFACT_DIRS.some((dir) => path.startsWith(dir));
}

/** True for an already-normalized path that is harness bookkeeping. */
function isHarnessLocalNormalizedPath(path: string): boolean {
  if (path.startsWith(".belayd/")) return true;
  return HARNESS_LOCAL_PATHS.includes(path);
}

/**
 * True when a repo-relative path is proof content: under a proof directory, or
 * carrying an accepted proof artifact extension (the extension list is shared
 * with the advisory verifier, never duplicated). A non-ASCII tail under an
 * ASCII proof directory still counts (the prefix is anchored); every other
 * non-ASCII path is left to the scope refusal, which names the reason.
 */
export function isProofArtifactPathInDiff(path: string): boolean {
  const normalized = normalizePublishPath(path);
  if (!normalized.ok) return false;
  // An anchored ASCII proof directory is safe to match even when the filename is
  // not ASCII: the prefix cannot be homoglyph-spoofed, only the tail varies.
  if (PROOF_ARTIFACT_DIRS.some((dir) => normalized.path.startsWith(dir))) return true;
  // A lookalike directory such as `docs/proоf/` must fall through to the scope
  // refusal (which names the Unicode reason) instead of being guessed as proof.
  if (normalized.hasNonAscii) return false;
  return isProofArtifactPath(normalized.path);
}

/** True for harness bookkeeping that lives outside the published repository. */
export function isHarnessLocalPath(path: string): boolean {
  const normalized = normalizePublishPath(path);
  return normalized.ok ? isHarnessLocalNormalizedPath(normalized.path) : false;
}

/**
 * True when the path may be part of a published payload under the strict default
 * proof policy. Proof content is refused here regardless of what a repo declares:
 * `evaluatePublishGate` applies an `in-tree` declaration to the paths the policy
 * named, so this predicate keeps one meaning for every caller.
 */
export function isPublishablePath(path: string): boolean {
  const normalized = normalizePublishPath(path);
  if (!normalized.ok) return false;
  // A non-ASCII name cannot be classified reliably; refuse it rather than let a
  // lookalike directory through. The one exception (under an ASCII proof
  // directory) is already refused as proof content above.
  if (normalized.hasNonAscii) return false;
  if (isHarnessLocalNormalizedPath(normalized.path)) return false;
  return !isProofArtifactNormalizedPath(normalized.path);
}

/** Sorted paths for a refusal line, bounded with a deterministic pointer to `paths`. */
function formatRefusalPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_REFUSAL_PATHS);
  const extra = paths.length - shown.length;
  return extra > 0
    ? `${shown.join(", ")} (+${extra} more — the full list is in \`paths\`)`
    : shown.join(", ");
}

function refusal(
  reason: PublishGateRefusalReason,
  offending: readonly string[],
): PublishGateResult {
  const paths = dedupeSorted(offending);
  const notes: string[] = [];
  if (reason === "proof-artifacts-in-diff") {
    notes.push(
      "proof artifacts must not be published — upload them; the receipt stays in " +
        "<git-common-dir>/belayd/state.sqlite",
    );
    // This refusal can only happen under the strict default, so the escape hatch a
    // repo with a deliberate in-git proof policy needs belongs in the message: the
    // refusal is otherwise indistinguishable from a member that committed junk.
    notes.push(
      'a repo that keeps proof in git declares {"proof":{"artifacts":"in-tree"}} in .belayd/config.json',
    );
  } else {
    notes.push("only the intended publishable paths may be carried");
    if (paths.some((path) => NON_ASCII_PATTERN.test(path))) {
      notes.push("non-ASCII/lookalike path cannot be reliably classified; rename it to ASCII");
    }
  }
  return {
    ok: false,
    reason,
    paths,
    text: `publish gate refused: ${reason}: ${formatRefusalPaths(paths)}; ${notes.join("; ")}`,
  };
}

/**
 * Evaluate the publish payload.
 *
 * The payload is the set of paths a branch *carries in* — the merge drain reads
 * it with `--diff-filter=ACMRT`, so deletions never reach this function. An
 * added or modified proof artifact is refused; deleting proof artifacts is the
 * sanctioned migration and is not a payload entry. A rename is classified by
 * its destination path.
 *
 * `proof-artifacts-in-diff` wins over `paths-outside-scope`: proof already in a
 * branch is the failure the operator must act on (delete it and re-upload), and
 * reporting it first keeps the refusal message unambiguous. A path that is both
 * proof content and outside the intended set is therefore reported once, under
 * the proof reason.
 */
export function evaluatePublishGate(input: PublishGateInput): PublishGateResult {
  const policy = input.proofPolicy ?? DEFAULT_PROOF_ARTIFACT_POLICY;
  const changedPaths = dedupeSorted(
    input.changedPaths.filter((path) => path.trim() !== "").map((path) => publishDisplayPath(path)),
  );

  const proofPaths = changedPaths.filter(isProofArtifactPathInDiff);
  if (policy === "forbid" && proofPaths.length > 0) {
    return refusal("proof-artifacts-in-diff", proofPaths);
  }

  const intended =
    input.intendedPaths === undefined
      ? undefined
      : new Set(input.intendedPaths.map((path) => publishDisplayPath(path)));
  // Under `in-tree` a proof path is ordinary content: `isPublishablePath` keeps its
  // strict meaning (so the pr/push executor cannot accidentally inherit a lenient
  // predicate), and leniency is applied here, to the proof paths the policy named.
  const carriedProof = new Set(proofPaths);
  const outsideScope = changedPaths.filter((path) => {
    if (!carriedProof.has(path) && !isPublishablePath(path)) return true;
    return intended === undefined ? false : !intended.has(path);
  });
  if (outsideScope.length > 0) return refusal("paths-outside-scope", outsideScope);

  return proofPaths.length === 0
    ? { ok: true, paths: changedPaths }
    : { ok: true, paths: changedPaths, proofArtifacts: proofPaths };
}
