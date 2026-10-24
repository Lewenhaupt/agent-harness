/**
 * pi binary resolution for spawned harness agents.
 *
 * Three consumers run the harness and they do not agree on which pi binary —
 * and therefore which extension set — a session gets:
 *
 * - pi-web orchestrator sessions run pi-web's bundled pi SDK in-process, so
 *   they only see extensions discovered from the agent directory and project
 *   settings.
 * - Spawned sub-agents run a pi *process*, whose binary is resolved here.
 * - The repo dev loop runs `bin/pi`, a wrapper that re-adds local extensions.
 *
 * Resolution used to end at `/run/current-system/sw/bin/pi` silently, so a
 * sub-agent could carry exa/ast-grep tools while the orchestrator that told it
 * to prefer `ast_grep` had none. This module makes the choice explicit and
 * reportable instead: the caller warns when the harness did not get the binary
 * it asked for.
 */

/** Explicit override; set this when a project needs a specific pi build. */
export const BELAYD_PI_BINARY_ENV = "BELAYD_PI_BINARY";

/** Older override kept for compatibility with existing direnv shells. */
export const PI_BINARY_PATH_ENV = "PI_BINARY_PATH";

/**
 * The NixOS-system pi. It is the last resort because it is the *only* path a
 * pi-web-spawned child could reach before this module existed; it resolves to
 * the configured `belayd-pi` wrapper on this host but need not on another.
 */
export const SYSTEM_PI_BINARY = "/run/current-system/sw/bin/pi";

/** Where a resolved binary came from. */
export type PiBinarySource = "explicit" | "harness-env" | "system" | "path" | "unresolved";

/** A resolution candidate in precedence order. */
export interface PiBinaryCandidate {
  binary: string;
  source: Exclude<PiBinarySource, "unresolved">;
}

/** A resolution outcome, including how many candidates were considered. */
export interface PiBinaryResolution {
  /** Absolute path of the binary to spawn, or undefined when nothing resolved. */
  binary: string | undefined;
  source: PiBinarySource;
  /**
   * True when no deliberate override selected the binary (system/PATH/absent).
   * Callers surface this instead of pretending the configured binary was used.
   */
  fellBack: boolean;
  candidates: PiBinaryCandidate[];
}

/** Environment lookup used by {@link piBinaryCandidates}. */
export interface PiBinaryEnv {
  env: Record<string, string | undefined>;
  /** PATH lookup, injected so candidate order is testable without a filesystem. */
  pathLookup?: (name: string) => string | undefined;
}

/**
 * Ordered candidates: explicit override, harness override, system pi, PATH.
 *
 * A blank value is treated as unset — an empty `BELAYD_PI_BINARY=` in a shell
 * profile must not shadow the next candidate with an empty path.
 */
export function piBinaryCandidates(options: PiBinaryEnv): PiBinaryCandidate[] {
  const { env, pathLookup } = options;
  const candidates: PiBinaryCandidate[] = [];
  const explicit = nonEmpty(env[BELAYD_PI_BINARY_ENV]);
  if (explicit !== undefined) candidates.push({ binary: explicit, source: "explicit" });
  const harnessEnv = nonEmpty(env[PI_BINARY_PATH_ENV]);
  if (harnessEnv !== undefined) candidates.push({ binary: harnessEnv, source: "harness-env" });
  candidates.push({ binary: SYSTEM_PI_BINARY, source: "system" });
  const onPath = pathLookup === undefined ? undefined : nonEmpty(pathLookup("pi"));
  if (onPath !== undefined) candidates.push({ binary: onPath, source: "path" });
  return candidates;
}

/**
 * Pick the first candidate that exists on disk.
 *
 * `exists` is injected so the precedence rules stay pure and unit-testable;
 * `spawn.ts` passes `existsSync`.
 */
export function resolvePiBinaryPath(
  options: PiBinaryEnv & { exists: (path: string) => boolean },
): PiBinaryResolution {
  const candidates = piBinaryCandidates(options);
  for (const candidate of candidates) {
    if (!options.exists(candidate.binary)) continue;
    const deliberate = candidate.source === "explicit" || candidate.source === "harness-env";
    return {
      binary: candidate.binary,
      source: candidate.source,
      fellBack: !deliberate,
      candidates,
    };
  }
  return { binary: undefined, source: "unresolved", fellBack: true, candidates };
}

/**
 * One-line notice for a resolution that did not use a deliberate override, or
 * undefined when the harness got exactly the binary it asked for.
 *
 * Wording matters: this line is the only place a silent tool-set change
 * becomes visible, so it names the env var that would pin the binary.
 */
export function piBinaryNotice(resolution: PiBinaryResolution): string | undefined {
  if (resolution.source === "unresolved") {
    return (
      "no pi binary found — set " +
      `${BELAYD_PI_BINARY_ENV} (spawned agents cannot start without one)`
    );
  }
  if (!resolution.fellBack) return undefined;
  const considered = resolution.candidates.map((candidate) => candidate.binary).join(", ");
  return (
    `pi binary not pinned by ${BELAYD_PI_BINARY_ENV}/${PI_BINARY_PATH_ENV}; ` +
    `using ${resolution.source} binary ${resolution.binary} (candidates: ${considered}). ` +
    "Spawned agents inherit that binary's extension set."
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
