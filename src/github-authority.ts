/**
 * GitHub authority for a repo, and drift between the two trackers (bd-180).
 *
 * For a repo that opts into GitHub-primary, GitHub Issues is the source of truth
 * for what work exists and what blocks what. bd stays the local projection plus
 * the gates a relationship graph cannot express. One authority per repo is
 * recorded next to the publish contract in `.belayd/config.json`:
 *
 *   { "authority": "bd" }                                   // default, local mode
 *   { "authority": "github", "github": { "owner", "repo" } }
 *
 * Local mode must stay exactly as it is today, so the reader defaults to `bd`
 * and an absent or unreadable file never selects GitHub. An *ambiguous* config is
 * refused rather than narrowed: choosing a side for the operator is how a
 * GitHub-primary repo silently reverts to local (or the reverse).
 *
 * Drift reuses the classification pattern from `bead-gates.ts`: a typed record
 * `{ id, kind, message }` plus a one-line renderer, computed deterministically
 * from injected facts. No model judgement is involved anywhere.
 */

import { dirname } from "node:path";
import { z } from "zod";
import type { FleetPublishFsSeam } from "./fleet-publish.js";
import { readRepoConfigObject } from "./fleet-publish.js";
import type {
  GithubIssueIdentity,
  GithubIssueMap,
  GithubUnmappedDependency,
} from "./github-issue-map.js";
import { lookupGithubIssue } from "./github-issue-map.js";
import type { GitCommonDirResult } from "./worktree.js";

/** The two authorities a repo may declare. */
export const GITHUB_AUTHORITIES = ["bd", "github"] as const;

/** Which tracker owns this repo's work graph. */
export type GithubAuthority = (typeof GITHUB_AUTHORITIES)[number];

/** GitHub repo identity required when authority is `github`. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

/** The resolved authority contract for one repo. */
export interface GithubAuthorityConfig {
  authority: GithubAuthority;
  github?: GithubRepoRef;
}

/** Control characters and a leading `-` are rejected, as in the publish reader:
 * these values are later turned into API paths and argv, never prose. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const githubRefField = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.startsWith("-"), { message: "must not start with '-'" })
  .refine((value) => !hasControlCharacter(value), {
    message: "must not contain control characters",
  });

const GithubRepoRefSchema = z.object({ owner: githubRefField, repo: githubRefField }).strict();

export type GithubAuthorityParse =
  | { ok: true; value: GithubAuthorityConfig }
  | { ok: false; error: string };

/**
 * Classify the repo config object, refusing anything ambiguous.
 *
 * The `github` block is itself an authority marker, so pairing it with
 * `authority:"bd"` (or omitting `authority` while configuring GitHub) means the
 * file names both sides. There is no safe precedence between the two: refuse and
 * let the operator pick.
 */
export function parseGithubAuthority(config: Record<string, unknown>): GithubAuthorityParse {
  const authority = config.authority;
  const github = config.github;

  if (authority === undefined) {
    if (github !== undefined) {
      return {
        ok: false,
        error:
          'ambiguous authority: a "github" block is configured but "authority" is not set (both authorities set)',
      };
    }
    return { ok: true, value: { authority: "bd" } };
  }

  if (Array.isArray(authority) || (typeof authority === "object" && authority !== null)) {
    return {
      ok: false,
      error: 'ambiguous authority: "authority" must be a single "bd" or "github", not a collection',
    };
  }

  if (authority === "bd") {
    if (github !== undefined) {
      return {
        ok: false,
        error:
          'ambiguous authority: "authority" is "bd" but a "github" block is configured (both authorities set)',
      };
    }
    return { ok: true, value: { authority: "bd" } };
  }

  if (authority === "github") {
    const parsed = GithubRepoRefSchema.safeParse(github);
    if (!parsed.success) {
      return {
        ok: false,
        error: `authority "github" requires github.owner and github.repo (${describeIssues(parsed.error.issues)})`,
      };
    }
    return { ok: true, value: { authority: "github", github: parsed.data } };
  }

  return {
    ok: false,
    error: `unknown authority ${typeof authority === "string" ? `"${authority}"` : "(not a string)"}; expected "bd" or "github"`,
  };
}

function describeIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Read outcome: a resolved authority or a refusal, never a throw. */
export type ReadGithubAuthorityResult =
  | { ok: true; value: GithubAuthorityConfig; warnings: readonly string[] }
  | { ok: false; error: string };

/**
 * Resolve the repo's authority from `.belayd/config.json`.
 *
 * The file read/parse is the shared one the publish contract uses, so both
 * readers agree on the same bytes and the same warnings. A missing or unparsable
 * *file* keeps the local default; a file that parses but says something
 * ambiguous is refused, because defaulting there would be narrowing.
 */
export function readGithubAuthorityConfig(options: {
  repoRoot: string;
  fs?: FleetPublishFsSeam;
}): ReadGithubAuthorityResult {
  const read = readRepoConfigObject({ repoRoot: options.repoRoot, fs: options.fs });
  if (read.config === undefined) {
    return { ok: true, value: { authority: "bd" }, warnings: read.warnings };
  }
  const parsed = parseGithubAuthority(read.config);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, value: parsed.value, warnings: read.warnings };
}

/** The authority resolved from the session's actual repo, not its raw cwd. */
export type SessionGithubAuthorityResult =
  | {
      ok: true;
      authority: GithubAuthority;
      /** The whole contract, including the `github` repo ref bd-182 needs. */
      config: GithubAuthorityConfig;
      repoRoot: string;
      warnings: readonly string[];
    }
  | { ok: false; error: string };

/**
 * Resolve authority from the session's repo root.
 *
 * `.belayd/config.json` is repo-scoped, and a session's tool-call cwd may be a
 * subdirectory or a linked worktree, so reading the config under raw `cwd` can
 * miss it and silently fall back to `bd` (fail-open). The repo root is the parent
 * of git's shared common dir — the same identity the publish reader uses — and a
 * cwd where git cannot resolve that dir is refused: an unresolvable root must
 * not become local mode for a phase agent.
 */
export function resolveGithubAuthorityForSession(options: {
  cwd: string;
  resolveGitCommonDir: (cwd: string) => GitCommonDirResult;
  fs?: FleetPublishFsSeam;
}): SessionGithubAuthorityResult {
  const common = options.resolveGitCommonDir(options.cwd);
  if (!common.ok) {
    return { ok: false, error: `authority unresolved: ${common.error}` };
  }
  const repoRoot = dirname(common.commonDir);
  const read = readGithubAuthorityConfig({ repoRoot, fs: options.fs });
  if (!read.ok) return { ok: false, error: read.error };
  return {
    ok: true,
    authority: read.value.authority,
    config: read.value,
    repoRoot,
    warnings: read.warnings,
  };
}

/** The drift classes a GitHub-primary projection can exhibit. */
export const GITHUB_DRIFT_KINDS = [
  "issue-missing",
  "issue-closed-bead-open",
  "bead-missing",
  "unmapped-dependency",
  "authority-mismatch",
  "map-unreadable",
] as const;

/** One drift class name. */
export type GithubDriftKind = (typeof GITHUB_DRIFT_KINDS)[number];

/** A single drift finding, keyed by bead id so callers can dedupe per bead. */
export interface GithubDrift {
  id: string;
  kind: GithubDriftKind;
  message: string;
}

/** A local bead as the drift check needs it. */
export interface GithubDriftBead {
  id: string;
  state: "open" | "closed";
}

/** The GitHub side of one mapped bead. `missing` means the map points at an
 * issue that no longer resolves. */
export interface GithubIssueObservation {
  beadId: string;
  state: "open" | "closed" | "missing";
}

/** An open local gate, used only to explain why an open bead has no progress. */
export interface GithubOpenGate {
  beadId: string;
  gateId: string;
}

/** Everything the drift classification reads, injected so it stays pure. */
export interface GithubDriftInput {
  authority: GithubAuthorityConfig;
  map: GithubIssueMap;
  beads: readonly GithubDriftBead[];
  issues: readonly GithubIssueObservation[];
  openGates?: readonly GithubOpenGate[];
  /**
   * Set when the map file could not be read or parsed. The empty map that the
   * reader degrades to would otherwise make every bead look `issue-missing`,
   * which is a filesystem failure disguised as a sync failure. A present reason
   * replaces all map-derived findings with one `map-unreadable` record.
   */
  mapUnreadableReason?: string;
}

/** The drift for one bead, or undefined when it is in sync. */
function beadDrift(
  bead: GithubDriftBead,
  map: GithubIssueMap,
  issueByBead: ReadonlyMap<string, GithubIssueObservation>,
  gateCountByBead: ReadonlyMap<string, number>,
): GithubDrift | undefined {
  const identity = lookupGithubIssue(map, bead.id);
  if (identity === undefined) {
    return {
      id: bead.id,
      kind: "issue-missing",
      message: "bead has no GitHub issue in the projection map",
    };
  }
  const issue = issueByBead.get(bead.id);
  if (issue === undefined || issue.state === "missing") {
    return {
      id: bead.id,
      kind: "issue-missing",
      message: `mapped issue #${identity.number.toString()} no longer resolves on GitHub`,
    };
  }
  if (issue.state !== "closed" || bead.state !== "open") return undefined;
  const gateCount = gateCountByBead.get(bead.id) ?? 0;
  return {
    id: bead.id,
    kind: "issue-closed-bead-open",
    message:
      `issue #${identity.number.toString()} is closed but the bead is still open` +
      (gateCount === 0 ? "" : ` (${gateCount.toString()} open local gate(s) hold it)`),
  };
}

function orphanMapDrift(beadId: string, identity: GithubIssueIdentity): GithubDrift {
  return {
    id: beadId,
    kind: "bead-missing",
    message: `projection map names issue #${identity.number.toString()} for a bead that no longer exists`,
  };
}

function unmappedDependencyDrift(dependency: GithubUnmappedDependency): GithubDrift {
  return {
    // Key by the edge, not the blocked bead: two blocked-by edges out of the
    // same bead are two findings, and keying by the bead alone would dedupe the
    // second blocker out of the report.
    id: `${dependency.beadId}->${dependency.dependsOnBeadId}`,
    kind: "unmapped-dependency",
    message: `${dependency.beadId} depends on ${dependency.dependsOnBeadId}, which has no GitHub issue (${dependency.reason})`,
  };
}

/**
 * Classify drift between the local projection and GitHub.
 *
 * Deterministic order: the bead list first, then map entries whose bead no
 * longer exists, then unmapped dependencies, so two runs over the same state
 * produce the same records in the same order. `authority-mismatch` short-circuits
 * because no GitHub projection applies to a `bd`-authority repo.
 */
export function classifyGithubDrift(input: GithubDriftInput): readonly GithubDrift[] {
  if (input.authority.authority !== "github") {
    return [
      {
        id: "(repo)",
        kind: "authority-mismatch",
        message: 'this repo declares authority "bd", so a GitHub projection must not be applied',
      },
    ];
  }
  if (input.mapUnreadableReason !== undefined) {
    return [
      {
        id: "(map)",
        kind: "map-unreadable",
        message: input.mapUnreadableReason,
      },
    ];
  }

  const issueByBead = new Map(input.issues.map((issue) => [issue.beadId, issue]));
  const beadIds = new Set(input.beads.map((bead) => bead.id));
  const gateCountByBead = new Map<string, number>();
  for (const gate of input.openGates ?? []) {
    gateCountByBead.set(gate.beadId, (gateCountByBead.get(gate.beadId) ?? 0) + 1);
  }

  const drifts: GithubDrift[] = [];
  for (const bead of input.beads) {
    const drift = beadDrift(bead, input.map, issueByBead, gateCountByBead);
    if (drift !== undefined) drifts.push(drift);
  }
  for (const [beadId, identity] of Object.entries(input.map.issues)) {
    if (beadIds.has(beadId)) continue;
    drifts.push(orphanMapDrift(beadId, identity));
  }
  for (const dependency of input.map.unmappedDependencies) {
    drifts.push(unmappedDependencyDrift(dependency));
  }
  return drifts;
}

/** `in-sync` is the absence of drift, kept as an explicit status so a caller
 * never has to read an empty array as "not checked". */
export type GithubDriftStatus = "in-sync" | "drift";

/** The aggregate status for a drift run. */
export function githubDriftStatus(drifts: readonly GithubDrift[]): GithubDriftStatus {
  return drifts.length === 0 ? "in-sync" : "drift";
}

/** One-line warning renderer, mirroring `fleetOrderingGateDriftWarning`. */
export function githubDriftWarning(drift: GithubDrift): string {
  return `github drift [${drift.kind}] ${drift.id}: ${drift.message}`;
}
