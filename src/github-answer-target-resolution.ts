/**
 * Resolve the answer channel for a session's repo (bd-182).
 *
 * Kept apart from the target types (`github-answer-target.ts`) because this half
 * reads the authority config and the bead ↔ issue map, and those readers reach
 * the fleet publish module. Capability modules may import the types, but they
 * must never import this resolver: the composer owns repo-root resolution and
 * hands the capability the already-resolved target.
 */

import type { GithubAnswerTarget } from "./github-answer-target.js";
import { classifyGithubAnswerTarget } from "./github-answer-target.js";
import { resolveGithubAuthorityForSession } from "./github-authority.js";
import type { GithubIssueMapFsSeam } from "./github-issue-map.js";
import { readGithubIssueMap } from "./github-issue-map.js";
import type { GitCommonDirResult } from "./worktree.js";

/** A target plus the config/map warnings the composer should emit once. */
export interface ResolvedAnswerTarget {
  target: GithubAnswerTarget;
  warnings: readonly string[];
}

/**
 * Resolve the answer target from the session's repo, not its raw cwd.
 *
 * `.belayd/config.json` and `.belayd/github-map.json` are repo-scoped and the
 * tool-call cwd may be a subdirectory or a linked worktree, so this uses the same
 * root resolution as the authority reader. An unreadable map is `unknown`, not
 * `unmapped`: a filesystem failure must not be reported as "this bead has no
 * issue".
 */
export function resolveGithubAnswerTargetForSession(options: {
  cwd: string;
  beadId: string;
  resolveGitCommonDir: (cwd: string) => GitCommonDirResult;
  fs?: GithubIssueMapFsSeam;
}): ResolvedAnswerTarget {
  const resolved = resolveGithubAuthorityForSession({
    cwd: options.cwd,
    resolveGitCommonDir: options.resolveGitCommonDir,
  });
  if (!resolved.ok) {
    return { target: { kind: "unknown", reason: resolved.error }, warnings: [] };
  }
  if (resolved.authority !== "github") {
    return { target: { kind: "local" }, warnings: resolved.warnings };
  }
  const repo = resolved.config.github;
  if (repo === undefined) {
    return {
      target: {
        kind: "unknown",
        reason: 'authority is "github" but github.owner/github.repo is missing',
      },
      warnings: resolved.warnings,
    };
  }
  const map = readGithubIssueMap({
    repoRoot: resolved.repoRoot,
    repo: { owner: repo.owner, name: repo.repo },
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  if (!map.ok) {
    return {
      target: { kind: "unknown", reason: map.error },
      warnings: resolved.warnings,
    };
  }
  if (map.warnings.length > 0) {
    return {
      target: { kind: "unknown", reason: map.warnings.join("; ") },
      warnings: [...resolved.warnings, ...map.warnings],
    };
  }
  return {
    target: classifyGithubAnswerTarget({
      authority: resolved.config,
      beadId: options.beadId,
      map: map.map,
    }),
    warnings: resolved.warnings,
  };
}
