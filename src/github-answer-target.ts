/**
 * Where a human answer for one bead must be read from (bd-182).
 *
 * The answer channel is decided per repo, not per call: a `bd`-authority repo
 * keeps the bd-152 bead comment thread byte for byte, while a GitHub-primary
 * repo reads the mapped issue's comments. This module is deliberately types plus
 * one pure classifier: capability modules may import it (their transitive graph
 * is checked at the entry), and it must not reach the fleet modules through a
 * value import. The repo/map readers live in `github-answer-target-resolution.ts`,
 * which only the composer calls.
 */

import type { GithubAuthorityConfig } from "./github-authority.js";
import type { GithubIssueMap } from "./github-issue-map.js";

/** The channel a wait is answered on, recorded so prompt guidance stays honest. */
export type HumanAnswerChannel =
  | { kind: "bd" }
  | { kind: "github"; owner: string; repo: string; issue: number };

/** Where an answer for one bead will be looked for. */
export type GithubAnswerTarget =
  | { kind: "local" }
  | { kind: "github"; owner: string; repo: string; issue: number }
  /** GitHub authority, but this bead has no issue in the map. */
  | { kind: "unmapped"; reason: string }
  /** Authority/map unresolvable: fail closed, never guess a channel. */
  | { kind: "unknown"; reason: string };

/** The pure classification: config + map + bead id in, target out. */
export function classifyGithubAnswerTarget(input: {
  authority: GithubAuthorityConfig;
  beadId: string;
  map?: GithubIssueMap;
  mapError?: string;
}): GithubAnswerTarget {
  if (input.authority.authority !== "github") return { kind: "local" };
  const repo = input.authority.github;
  if (repo === undefined) {
    return {
      kind: "unknown",
      reason: 'authority is "github" but github.owner/github.repo is missing',
    };
  }
  if (input.mapError !== undefined) return { kind: "unknown", reason: input.mapError };
  if (input.map === undefined) {
    return { kind: "unknown", reason: "the bead to issue map is unavailable" };
  }
  const identity = input.map.issues[input.beadId];
  if (identity === undefined) {
    return {
      kind: "unmapped",
      reason: `${input.beadId} has no issue in .belayd/github-map.json`,
    };
  }
  return { kind: "github", owner: repo.owner, repo: repo.repo, issue: identity.number };
}
