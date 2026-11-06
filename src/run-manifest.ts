/**
 * Run manifests for individual phase-agent executions.
 *
 * Each phase-tool execution records a manifest row in the per-repository execution
 * store (bd-281, table `run_manifest`, keyed by run id) so a crash mid-run can be
 * detected on the next session start: any manifest still marked "running" is
 * flipped to "interrupted" and surfaced to the orchestrator instead of silently
 * disappearing.
 *
 * The store replaced `.belayd/runs/<runId>.json`. That directory was *copied* into
 * every new worktree by worktrunk's `copy-ignored` step, which is why readers had
 * to filter inherited manifests by task id and a worktree creation had to prune
 * them (bd-242). With one row per run in the repository-scoped store there is
 * nothing to copy and nothing to prune: a run belongs to the bead it names, and
 * `listRuns({taskId})` is still the filter.
 *
 * The read-modify-write helpers now run inside one store transaction, which is the
 * compare-and-set the file version never had: two writers can no longer interleave
 * a read and a write and lose each other's fields.
 */

import { z } from "zod";
import { ModelTelemetryTotalsSchema } from "./model-telemetry.js";
import { isSameOrDescendantTask } from "./owned-worktree.js";
import {
  type RepoRunRow,
  type RepoStateResult,
  type RepoStateStore,
  sharedRepoStateStore,
} from "./repo-state-store.js";
import type { SkippedModel } from "./spawn-with-fallback.js";

export enum RunStatus {
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Interrupted = "interrupted",
}

const SCHEMA_VERSION = 1;

/**
 * Run ids name a row key and a session-name segment, so they must stay one path
 * segment: no separators, no `.`/`..`.
 *
 * The key is derived from the manifest's `runId`, and the id also reaches a
 * spawned session's name (a name with a separator would address a different
 * workflow), so an unconstrained id is refused before it becomes a key.
 * `manifestFromRow` additionally refuses a row whose body names another id, so a
 * read-modify-write reads and writes the same row (bd-242 review).
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Rolled-up model telemetry attached to a run. The per-(phase, model)
 * breakdown lives in `.belayd/telemetry.json`; the manifest carries the totals
 * so a single run file answers "how much fallback did this phase cost?".
 *
 * The schema is shared with `model-telemetry.ts` so a field added there cannot
 * silently fail this re-read validation.
 */
export type RunTelemetryTotals = z.infer<typeof ModelTelemetryTotalsSchema>;

/**
 * A candidate skipped before dispatch (cooldown, capacity window, missing key).
 * Kept in the manifest so a run that never tried its requested model explains
 * itself without parsing the agent's fallback note. The shape is owned by the
 * spawn layer (`SkippedModel`) so the manifest cannot drift from the selection
 * it records.
 */
const SkippedModelSchema: z.ZodType<SkippedModel> = z.object({
  model: z.string(),
  reason: z.string(),
});

const RunManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string().regex(RUN_ID_PATTERN),
  taskId: z.string(),
  phase: z.string(),
  sessionName: z.string(),
  status: z.nativeEnum(RunStatus),
  startedAt: z.number().finite(),
  completedAt: z.number().finite().optional(),
  exitCode: z.number().finite().optional(),
  model: z.string().optional(),
  /**
   * The pre-dispatch pick. `model` records the model that actually served the
   * run, so a fallback win is visible as `requestedModel !== model`.
   */
  requestedModel: z.string().optional(),
  /** Candidates skipped before dispatch, in preference order, with the reason. */
  skippedModels: z.array(SkippedModelSchema).optional(),
  /** Why a failed run failed; absent on completed/interrupted manifests. */
  failureReason: z.string().optional(),
  /** Report text fed back by `/belayd-complete`; absent on normal runs. */
  completionReport: z.string().optional(),
  /** Set to "user" only by `/belayd-complete`, distinguishing manual recovery. */
  completedBy: z.literal("user").optional(),
  /** Orchestrator delivery-once marker; set after the report is delivered. */
  deliveredAt: z.number().finite().optional(),
  /** Model telemetry for this run (delta since the run started). */
  telemetry: ModelTelemetryTotalsSchema.optional(),
});

export type RunManifest = z.infer<typeof RunManifestSchema>;

/**
 * Test seam shared by every helper: pass an opened store instead of the module's
 * shared one. Production callers omit it.
 */
export interface RunManifestStoreSeam {
  store?: RepoStateStore;
}

export interface WriteRunManifestOptions extends RunManifestStoreSeam {
  cwd: string;
  manifest: RunManifest;
}

export interface ReadRunManifestOptions extends RunManifestStoreSeam {
  cwd: string;
  runId: string;
}

export interface SetRunStatusOptions extends RunManifestStoreSeam {
  cwd: string;
  runId: string;
  status: RunStatus;
  exitCode?: number;
  failureReason?: string;
  now?: () => number;
}

export interface ListRunsOptions extends RunManifestStoreSeam {
  cwd: string;
  /**
   * Only manifests belonging to this bead (or one of its sub-beads).
   *
   * Run rows are shared by every worktree of the repository, so they also hold
   * another bead's manifests (bd-242). A caller that names its bead gets its own
   * runs instead of every worktree's.
   */
  taskId?: string;
}

export interface CompleteRunByUserOptions extends RunManifestStoreSeam {
  cwd: string;
  runId: string;
  report: string;
  now?: () => number;
}

export interface MarkRunDeliveredOptions extends RunManifestStoreSeam {
  cwd: string;
  runId: string;
  now?: () => number;
}

export interface ListPendingUserCompletionsOptions extends RunManifestStoreSeam {
  cwd: string;
  /** Restrict the scan to this bead's own manifests (see {@link ListRunsOptions}). */
  taskId?: string;
}

export interface ScanForInterruptedRunsOptions extends RunManifestStoreSeam {
  cwd: string;
  /** Restrict the scan to this bead's own manifests (see {@link ListRunsOptions}). */
  taskId?: string;
  now?: () => number;
}

export interface SetRunTelemetryOptions extends RunManifestStoreSeam {
  cwd: string;
  runId: string;
  telemetry: RunTelemetryTotals;
}

export interface SetRunModelSelectionOptions extends RunManifestStoreSeam {
  cwd: string;
  runId: string;
  /**
   * The model that actually served the run; written to the manifest's `model`.
   * Omitted when nothing was dispatched, so the manifest never names a model
   * that executed nothing.
   */
  model?: string;
  /** The model the picker requested before dispatch. */
  requestedModel: string;
  /** Candidates skipped before dispatch (possibly empty). */
  skippedModels?: SkippedModel[];
}

/** Forwarded `taskId` for the option sets that extend the runs listing. */
function taskFilter(options: { taskId?: string }): { taskId?: string } {
  return options.taskId === undefined ? {} : { taskId: options.taskId };
}

/** Forwarded store seam for helpers that call other helpers. */
function storeSeam(options: RunManifestStoreSeam): RunManifestStoreSeam {
  return options.store === undefined ? {} : { store: options.store };
}

/** The store for this call: the injected one, else the shared repository store. */
function storeFor(options: RunManifestStoreSeam & { cwd: string }): RepoStateStore | null {
  if (options.store !== undefined) return options.store;
  return sharedRepoStateStore({ cwd: options.cwd }).store;
}

/** Whether `runId` can name a run row (see {@link RUN_ID_PATTERN}). */
export function isSafeRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

/**
 * Whether a manifest is evidence about `taskId`: the same bead, or a sub-bead of
 * it (a sub-bead run legitimately names the parent's worktree).
 */
export function runBelongsToTask(run: RunManifest, taskId: string): boolean {
  return isSameOrDescendantTask(run.taskId, taskId);
}

/** Parse and strictly narrow a run manifest; corrupt/wrong version → undefined. */
export function parseRunManifest(raw: unknown): RunManifest | undefined {
  const result = RunManifestSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** The manifest a store row holds, or undefined when the row does not parse. */
function manifestFromRow(row: RepoRunRow | null): RunManifest | undefined {
  if (row === null) return undefined;
  const manifest = parseRunManifest(row.payload);
  // The row key is the authority (bd-242): a payload naming another id would make
  // every read-modify-write write a different row than the one it read.
  return manifest?.runId === row.runId ? manifest : undefined;
}

export function writeRunManifest(
  options: WriteRunManifestOptions,
): { ok: true } | { ok: false; error: string } {
  if (!isSafeRunId(options.manifest.runId)) {
    return { ok: false, error: `unsafe run id "${options.manifest.runId}"` };
  }
  // The schema is the validation boundary on the way in: an invalid record must
  // never become a row.
  const manifest = parseRunManifest(options.manifest);
  if (manifest === undefined) {
    return {
      ok: false,
      error: `refusing to persist an invalid run manifest for ${options.manifest.runId}`,
    };
  }
  const store = storeFor(options);
  if (store === null) {
    return { ok: false, error: `repo state store unavailable for ${options.cwd}` };
  }
  const written = store.writeRun({ runId: manifest.runId, payload: manifest });
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}

export function readRunManifest(options: ReadRunManifestOptions): RunManifest | undefined {
  // A caller-supplied id is untrusted (a parsed session name, a daemon payload), so
  // it is validated before it becomes a key.
  if (!isSafeRunId(options.runId)) return undefined;
  const store = storeFor(options);
  if (store === null) return undefined;
  const row = store.readRun(options.runId);
  if (!row.ok) return undefined;
  return manifestFromRow(row.value);
}

/**
 * Read-modify-write one run inside a single store transaction.
 *
 * This is the compare-and-set the file version never had: the update sees the row
 * as it is *now*, so a status write and a telemetry write cannot lose each other.
 */
function mutateRunManifest(
  options: RunManifestStoreSeam & { cwd: string; runId: string; now?: () => number },
  update: (current: RunManifest) => RunManifest,
): { ok: true } | { ok: false; error: string } {
  if (!isSafeRunId(options.runId)) {
    return { ok: false, error: `unsafe run id "${options.runId}"` };
  }
  const store = storeFor(options);
  if (store === null) {
    return { ok: false, error: `repo state store unavailable for ${options.cwd}` };
  }
  const result: RepoStateResult<RepoRunRow | null> = store.mutateRun({
    runId: options.runId,
    ...(options.now === undefined ? {} : { nowMs: options.now() }),
    update: (current) => {
      const manifest = manifestFromRow(current);
      if (manifest === undefined) {
        return { kind: "skip" };
      }
      const next = parseRunManifest(update(manifest));
      return next === undefined
        ? {
            kind: "conflict",
            error: `the updated run manifest for ${options.runId} does not validate`,
          }
        : { kind: "write", payload: next };
    },
  });
  if (!result.ok) return { ok: false, error: result.error };
  // A row the record schema rejects is as unusable as a missing one (the file
  // version behaved the same way for an unparseable body): never report success.
  if (manifestFromRow(result.value) === undefined) {
    return { ok: false, error: `No run manifest found for ${options.runId}` };
  }
  return { ok: true };
}

function terminalStatus(status: RunStatus): boolean {
  return (
    status === RunStatus.Completed ||
    status === RunStatus.Failed ||
    status === RunStatus.Interrupted
  );
}

/**
 * Read-modify-write a run's status. Terminal statuses record `completedAt`;
 * an unknown run id is an error value, not a throw.
 */
export function setRunStatus(
  options: SetRunStatusOptions,
): { ok: true } | { ok: false; error: string } {
  const atMs = (options.now ?? Date.now)();
  return mutateRunManifest(options, (existing) => ({
    ...existing,
    status: options.status,
    // Terminal statuses record completedAt; non-terminal transitions drop any
    // stale completedAt so a "running" manifest never carries a past completion.
    completedAt: terminalStatus(options.status) ? atMs : undefined,
    ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
    // Only a Failed status carries a reason; a later Completed/Running/
    // Interrupted transition must clear a stale one.
    failureReason: options.status === RunStatus.Failed ? options.failureReason : undefined,
  }));
}

/**
 * List persisted runs sorted by start time.
 *
 * Rows the record schema rejects are skipped rather than failing the listing, which
 * is what the file version did for an unparseable file.
 */
export function listRuns(options: ListRunsOptions): RunManifest[] {
  const store = storeFor(options);
  if (store === null) return [];
  const rows = store.listRuns();
  if (!rows.ok) return [];
  const runs: RunManifest[] = [];
  for (const row of rows.value) {
    const manifest = manifestFromRow(row);
    if (manifest === undefined) continue;
    if (options.taskId !== undefined && !runBelongsToTask(manifest, options.taskId)) continue;
    runs.push(manifest);
  }
  runs.sort((a, b) => a.startedAt - b.startedAt);
  return runs;
}

/**
 * Mark a run completed from a `/belayd-complete` invocation. Unlike
 * `setRunStatus`, this records the recovered report, tags the run as
 * user-completed, and clears any stale failure reason so a later settle cannot
 * downgrade the phase. `deliveredAt` is intentionally left untouched.
 */
export function completeRunByUser(
  options: CompleteRunByUserOptions,
): { ok: true } | { ok: false; error: string } {
  return mutateRunManifest(options, (existing) => ({
    ...existing,
    status: RunStatus.Completed,
    completedAt: (options.now ?? Date.now)(),
    completionReport: options.report,
    completedBy: "user",
    failureReason: undefined,
  }));
}

/** Attach the current model-telemetry totals to a run manifest. */
export function setRunTelemetry(
  options: SetRunTelemetryOptions,
): { ok: true } | { ok: false; error: string } {
  return mutateRunManifest(options, (existing) => ({
    ...existing,
    telemetry: options.telemetry,
  }));
}

/**
 * Record which model actually served a run (plus the pre-dispatch pick and any
 * candidates skipped before dispatch). Read-modify-write like `setRunStatus`, so
 * status/startedAt/telemetry written earlier survive; an unknown run id is an
 * error value, never a throw.
 */
export function setRunModelSelection(
  options: SetRunModelSelectionOptions,
): { ok: true } | { ok: false; error: string } {
  return mutateRunManifest(options, (existing) => ({
    ...existing,
    // `model` means "the model that served this run", so a run that spawned
    // nothing leaves it as it was rather than inventing a server.
    ...(options.model !== undefined ? { model: options.model } : {}),
    requestedModel: options.requestedModel,
    ...(options.skippedModels !== undefined ? { skippedModels: options.skippedModels } : {}),
  }));
}

/** Record that a user-completed run's report has been delivered exactly once. */
export function markRunDelivered(
  options: MarkRunDeliveredOptions,
): { ok: true } | { ok: false; error: string } {
  return mutateRunManifest(options, (existing) => ({
    ...existing,
    deliveredAt: (options.now ?? Date.now)(),
  }));
}

/**
 * User-completed runs whose report has not yet been delivered. This is the
 * file-only recovery path: after an orchestrator restart the in-memory delivery
 * marker is gone, but the persisted manifest still carries the pending report.
 * A user completion without a report is excluded: delivering it would advance
 * the gate with an empty body instead of the recovered answer.
 */
export function listPendingUserCompletions(
  options: ListPendingUserCompletionsOptions,
): RunManifest[] {
  return listRuns(options).filter(
    (run) =>
      run.completedBy === "user" &&
      run.deliveredAt === undefined &&
      run.completionReport !== undefined &&
      run.completionReport !== "",
  );
}

/**
 * Flip any manifest still marked "running" to "interrupted" and return the
 * interrupted set. Called on session start to surface runs that died with the
 * previous orchestrator process.
 */
export function scanForInterruptedRuns(options: ScanForInterruptedRunsOptions): RunManifest[] {
  const now = options.now ?? Date.now;
  const interrupted: RunManifest[] = [];
  for (const run of listRuns({ cwd: options.cwd, ...taskFilter(options), ...storeSeam(options) })) {
    if (run.status !== RunStatus.Running) continue;
    const completedAt = now();
    const result = setRunStatus({
      cwd: options.cwd,
      runId: run.runId,
      status: RunStatus.Interrupted,
      ...storeSeam(options),
      now,
    });
    if (result.ok) {
      interrupted.push({ ...run, status: RunStatus.Interrupted, completedAt });
    }
  }
  return interrupted;
}
