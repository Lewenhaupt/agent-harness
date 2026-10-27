/**
 * Batched, read-only bead lookup for the fleet observer (bd-126 P0).
 *
 * `fleet-status.ts` is pure (no child processes), and the extension owns the
 * real `bd` spawner, so the lookup lives here as a testable seam: the argv
 * builder and the process runner are injected. That is what makes the read-only
 * invariant enforceable *and* testable — a runner that would receive a
 * non-read argv is never called (see `__tests__/fleet-beads.test.ts`), rather
 * than a comment asserting the argv builder stays honest.
 *
 * Everything degrades to `{ ok: false }`: bd may be absent, slow, or pointed at
 * no database, and none of that may break observation of the workflows.
 */

import { buildBeadShowArgv, isBdReadSubcommand } from "./bd-command.js";
import { type FleetDependencyGraph, parseFleetDependencyEdges } from "./fleet-schedule.js";
import { type FleetBeadLookup, parseBeadViewPayload } from "./fleet-status.js";

/** Longest a fleet-wide bead lookup may take before it degrades to no metadata. */
export const FLEET_BEAD_LOOKUP_TIMEOUT_MS = 15_000;

/** Cap on bd stdout: one fleet's records, never an unbounded read. */
export const FLEET_BEAD_LOOKUP_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** Options handed to the injected `bd` runner; mirrors the extension spawner. */
export interface FleetBeadRunnerOptions {
  cwd: string;
  stdin: string | undefined;
  timeoutInMs: number;
  maxBufferInBytes: number;
}

/** Injected process runner: resolve `bd <argv>` stdout, reject on failure. */
export type FleetBeadRunner = (
  argv: readonly string[],
  options: FleetBeadRunnerOptions,
) => Promise<{ stdout: string }>;

/** Builds the argv for a batched lookup; injected so the guard is reachable in tests. */
export type BeadShowArgvBuilder = (taskIds: readonly string[]) => readonly string[];

export interface LookupFleetBeadsOptions {
  /** Already filtered and de-duplicated by `fleetBeadTaskIds`; empty means no spawn. */
  taskIds: readonly string[];
  cwd: string;
  runBd: FleetBeadRunner;
  /** Test seam for the read-only guard; production always uses the default. */
  buildArgv?: BeadShowArgvBuilder;
}

/**
 * Run one batched read-only `bd show <ids> --json` and parse the records.
 *
 * The read-only guard runs against the argv that will actually be executed, not
 * against the builder's source: a future edit (or an injected builder) that
 * yields a mutating subcommand is refused before any process is spawned, so the
 * observer can never become a writer.
 *
 * A payload whose *shape* this version cannot read is a failed read, not an empty
 * answer. Callers act on "these beads are gone" (resolving gates, dropping
 * metadata), and bd wrapping its records differently must never look like every
 * bead in the fleet having vanished.
 */
export async function lookupFleetBeads(options: LookupFleetBeadsOptions): Promise<FleetBeadLookup> {
  if (options.taskIds.length === 0) return { ok: true, beads: [] };

  const buildArgv = options.buildArgv ?? buildBeadShowArgv;
  const argv = buildArgv(options.taskIds);
  const subcommand = argv[0] ?? "";
  if (!isBdReadSubcommand(subcommand)) {
    return { ok: false, error: `refusing non-read bd subcommand "${subcommand}"` };
  }

  try {
    const { stdout } = await options.runBd(argv, {
      cwd: options.cwd,
      stdin: undefined,
      timeoutInMs: FLEET_BEAD_LOOKUP_TIMEOUT_MS,
      maxBufferInBytes: FLEET_BEAD_LOOKUP_MAX_BUFFER_BYTES,
    });
    const parsed = parseBeadViewPayload(JSON.parse(stdout) as unknown);
    return parsed.ok
      ? { ok: true, beads: parsed.beads }
      : {
          ok: false,
          error:
            "unrecognized `bd show` payload (bd changed its JSON shape); refusing to read " +
            "this as an empty bead set",
        };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * argv for one batched *dependency* read: `bd show <id>... --json --brief-deps`.
 *
 * `--brief-deps` keeps each dependency to its identity fields (`id`, `status`,
 * `dependency_type`), so a fleet of ten beads does not pull ten full bead
 * descriptions through the scheduler. `show` stays on the read-only list.
 */
export function buildBeadDependencyArgv(taskIds: readonly string[]): readonly string[] {
  return ["show", ...taskIds, "--json", "--brief-deps"];
}

export interface LookupFleetDependenciesOptions {
  taskIds: readonly string[];
  cwd: string;
  runBd: FleetBeadRunner;
  /** Test seam for the read-only guard; production always uses the default. */
  buildArgv?: BeadShowArgvBuilder;
}

/**
 * Read the blocking dependency graph for the members of a launch (P3).
 *
 * Same guard as {@link lookupFleetBeads}: the argv that will actually run is
 * checked against the read-only subcommand list, so scheduling can never become
 * a writer. Any failure degrades to "no known edges" with a warning — a launch
 * without ordering is fine, a launch that crashes on a bd hiccup is not.
 */
export async function lookupFleetDependencies(
  options: LookupFleetDependenciesOptions,
): Promise<FleetDependencyGraph> {
  if (options.taskIds.length === 0) return { edges: [], warnings: [] };

  const buildArgv = options.buildArgv ?? buildBeadDependencyArgv;
  const argv = buildArgv(options.taskIds);
  const subcommand = argv[0] ?? "";
  if (!isBdReadSubcommand(subcommand)) {
    return {
      edges: [],
      warnings: [
        `refusing non-read bd subcommand "${subcommand}"; scheduling without dependency ordering`,
      ],
    };
  }

  try {
    const { stdout } = await options.runBd(argv, {
      cwd: options.cwd,
      stdin: undefined,
      timeoutInMs: FLEET_BEAD_LOOKUP_TIMEOUT_MS,
      maxBufferInBytes: FLEET_BEAD_LOOKUP_MAX_BUFFER_BYTES,
    });
    return parseFleetDependencyEdges(JSON.parse(stdout), options.taskIds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      edges: [],
      warnings: [
        `bead dependency graph unavailable (${detail}); scheduling in the order given, without ` +
          "dependency ordering",
      ],
    };
  }
}
