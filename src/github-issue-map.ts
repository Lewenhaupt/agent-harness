/**
 * Bead ↔ GitHub issue identity map (bd-180).
 *
 * A GitHub-primary repo projects its local beads onto GitHub Issues, and every
 * later decision (drift, readiness, close-on-merge) needs to resolve one side to
 * the other. bd itself carries no cross-reference beyond `external_ref`, so the
 * harness owns the map at `<repoRoot>/.belayd/github-map.json`.
 *
 * The projection also has to record what it could *not* carry. A local bead can
 * depend on another bead that has no issue yet; that edge cannot be projected,
 * and silently dropping it would make GitHub's graph wrong. Such edges are kept
 * in `unmappedDependencies` with the reason, so drift can report them instead of
 * pretending the projection is complete.
 *
 * Parsing, serializing, upsert, and lookup are pure. The two effects (read and
 * write) take an injected filesystem seam and never throw: a corrupt map is a
 * warning plus an empty map, and a write refuses to overwrite a file it cannot
 * parse. That refusal is the difference between "the map was lost" and "the map
 * was destroyed by the recovery path".
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Bump only when the on-disk shape changes incompatibly. */
export const GITHUB_ISSUE_MAP_VERSION = 1;

/** The repo the map belongs to, as GitHub names it. */
export interface GithubMapRepo {
  owner: string;
  name: string;
}

/** One bead's GitHub issue identity. `number` and `nodeId` are both needed: the
 * REST API addresses issues by number, while GraphQL relationships use node ids. */
export interface GithubIssueIdentity {
  number: number;
  nodeId: string;
  title?: string;
  updatedAt?: string;
}

/** A dependency the projection could not carry, and why. */
export interface GithubUnmappedDependency {
  beadId: string;
  dependsOnBeadId: string;
  reason: string;
}

/** The persisted projection map. */
export interface GithubIssueMap {
  version: number;
  repo: GithubMapRepo;
  issues: Record<string, GithubIssueIdentity>;
  unmappedDependencies: GithubUnmappedDependency[];
}

const GithubMapRepoSchema = z
  .object({
    owner: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

const GithubIssueIdentitySchema = z
  .object({
    number: z.number().int().positive(),
    nodeId: z.string().min(1),
    title: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

const GithubUnmappedDependencySchema = z
  .object({
    beadId: z.string().min(1),
    dependsOnBeadId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const GithubIssueMapSchema = z
  .object({
    version: z.literal(GITHUB_ISSUE_MAP_VERSION),
    repo: GithubMapRepoSchema,
    issues: z.record(z.string(), GithubIssueIdentitySchema),
    unmappedDependencies: z.array(GithubUnmappedDependencySchema),
  })
  .strict();

/** An empty map for `repo`, at the current version. */
export function emptyGithubIssueMap(repo: GithubMapRepo): GithubIssueMap {
  return {
    version: GITHUB_ISSUE_MAP_VERSION,
    repo: { ...repo },
    issues: {},
    unmappedDependencies: [],
  };
}

/** Parse a persisted map, or undefined when the shape is not exactly ours. A
 * different `version` is not "our shape": callers must refuse it, not downgrade. */
export function parseGithubIssueMap(raw: unknown): GithubIssueMap | undefined {
  const result = GithubIssueMapSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Serialize deterministically: issue keys sorted, two-space indent, trailing
 * newline. A stable file keeps map-only commits reviewable and makes a rewrite
 * with no logical change a no-op in git.
 */
export function serializeGithubIssueMap(map: GithubIssueMap): string {
  const issues: Record<string, GithubIssueIdentity> = {};
  for (const beadId of Object.keys(map.issues).sort()) {
    const identity = map.issues[beadId];
    if (identity !== undefined) issues[beadId] = identity;
  }
  const ordered: GithubIssueMap = {
    version: map.version,
    repo: map.repo,
    issues,
    unmappedDependencies: map.unmappedDependencies,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The issue mapped to `beadId`, or undefined (a bead may legitimately be new). */
export function lookupGithubIssue(
  map: GithubIssueMap,
  beadId: string,
): GithubIssueIdentity | undefined {
  return map.issues[beadId];
}

/** Return a new map with `beadId` bound to `identity` (never mutates the input). */
export function upsertGithubIssue(
  map: GithubIssueMap,
  beadId: string,
  identity: GithubIssueIdentity,
): GithubIssueMap {
  return { ...map, issues: { ...map.issues, [beadId]: identity } };
}

/** Return a new map with `beadId` unmapped (close-on-merge may retire a bead). */
export function removeGithubIssue(map: GithubIssueMap, beadId: string): GithubIssueMap {
  const issues = { ...map.issues };
  delete issues[beadId];
  return { ...map, issues };
}

/**
 * Record one dependency the projection could not carry. Re-recording the same
 * pair replaces the reason, so a retry cannot accumulate duplicates.
 */
export function recordUnmappedDependency(
  map: GithubIssueMap,
  dependency: GithubUnmappedDependency,
): GithubIssueMap {
  const others = map.unmappedDependencies.filter(
    (entry) =>
      entry.beadId !== dependency.beadId || entry.dependsOnBeadId !== dependency.dependsOnBeadId,
  );
  return { ...map, unmappedDependencies: [...others, dependency] };
}

/** Injected filesystem seam; read and write are separate so a read-only caller
 * cannot accidentally gain a writer. */
export interface GithubIssueMapFsSeam {
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, data: string) => void;
}

const defaultFs: GithubIssueMapFsSeam = {
  readFileSync: (path) => readFileSync(path, "utf8"),
  writeFileSync: (path, data) => writeFileSync(path, data, "utf8"),
};

/** Where the map lives for a repo root. */
export function githubIssueMapPath(repoRoot: string): string {
  return join(repoRoot, ".belayd", "github-map.json");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read outcome: a map plus warnings, or a refusal distinct from "no map". */
export type ReadGithubIssueMapResult =
  | { ok: true; map: GithubIssueMap; warnings: readonly string[] }
  | { ok: false; error: string };

/**
 * Read the map, never throwing.
 *
 * Absent file = empty map and no warning. Unreadable or corrupt file = empty map
 * plus a warning (the caller can still run; a projection cannot block on its
 * cache). A corrupt file is deliberately *not* deleted here: the write path
 * refuses to overwrite it, so the operator can inspect what was lost.
 */
export function readGithubIssueMap(options: {
  repoRoot: string;
  repo: GithubMapRepo;
  fs?: GithubIssueMapFsSeam;
}): ReadGithubIssueMapResult {
  const fs = options.fs ?? defaultFs;
  const path = githubIssueMapPath(options.repoRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { ok: true, map: emptyGithubIssueMap(options.repo), warnings: [] };
    }
    return {
      ok: true,
      map: emptyGithubIssueMap(options.repo),
      warnings: [`${path}: could not read (${errorMessage(error)}); using an empty map`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: true,
      map: emptyGithubIssueMap(options.repo),
      warnings: [`${path}: invalid JSON (${errorMessage(error)}); using an empty map`],
    };
  }
  if (isJsonObject(parsed) && "version" in parsed) {
    const version = parsed.version;
    if (version !== GITHUB_ISSUE_MAP_VERSION) {
      return {
        ok: false,
        error: `${path}: unsupported GitHub issue map version ${renderVersion(version)} (this harness writes ${GITHUB_ISSUE_MAP_VERSION.toString()}); refusing to read or downgrade it`,
      };
    }
  }
  const map = parseGithubIssueMap(parsed);
  if (map === undefined) {
    return {
      ok: true,
      map: emptyGithubIssueMap(options.repo),
      warnings: [`${path}: not a GitHub issue map; using an empty map`],
    };
  }
  return { ok: true, map, warnings: [] };
}

/** Write outcome; a refusal keeps the previous file untouched. */
export type WriteGithubIssueMapResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Write the map, refusing to replace a file that exists but cannot be parsed.
 *
 * Without the refusal, a corrupt map would be read as empty and the next write
 * would erase whatever a human could still recover from it. An empty or
 * whitespace-only file is treated as absent (a truncated write, not content).
 */
export function writeGithubIssueMap(options: {
  repoRoot: string;
  map: GithubIssueMap;
  fs?: GithubIssueMapFsSeam;
}): WriteGithubIssueMapResult {
  const fs = options.fs ?? defaultFs;
  const path = githubIssueMapPath(options.repoRoot);
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      return {
        ok: false,
        error: `${path}: could not read before write (${errorMessage(error)}); refusing to overwrite`,
      };
    }
  }
  if (existing !== undefined && existing.trim() !== "") {
    const parsed = parseJson(existing);
    if (parsed === undefined || parseGithubIssueMap(parsed) === undefined) {
      return {
        ok: false,
        error: `${path}: existing map is not parsable; refusing to overwrite it`,
      };
    }
  }
  try {
    fs.writeFileSync(path, serializeGithubIssueMap(options.map));
  } catch (error) {
    return { ok: false, error: `${path}: could not write (${errorMessage(error)})` };
  }
  return { ok: true, path };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderVersion(version: unknown): string {
  if (typeof version === "number" || typeof version === "string") return `"${version.toString()}"`;
  return "(not a number)";
}
