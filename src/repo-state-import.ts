/**
 * One-shot import of the retired workflow state files into the shared store
 * (bd-281).
 *
 * The files are the bug this change removes: `.belayd/workflow.json` and its
 * companions were *copies* of state, so a handoff or a resumed session carried
 * one into a session that did not own it (bd-165: a stale handed-off
 * `workflow.json` made every new session in the worktree claim a dead
 * orchestrator lease).
 *
 * The migration is:
 *
 * 1. **Idempotent and at most once per repository.** The marker row in the
 *    store's `migration` table is the only record that decides whether the import
 *    may run again; a second run reports `alreadyImported` and reads nothing.
 *    Every row this import writes is absent-first through a plan helper whose
 *    existence check and insert share one `BEGIN IMMEDIATE` (the workflow record,
 *    lease, run, review scope, findings, fleet intent, queue, lock, supervisor,
 *    launch marker and notes; the audit tail through
 *    `RepoStateStore.importAudit`), so neither a second worktree racing the import
 *    nor a live row written after the legacy file was read can be doubled or
 *    overwritten.
 * 2. **Validated with the same schemas the file readers used.** A file that does
 *    not parse is reported as skipped, never guessed at, so a corrupt legacy
 *    record cannot smuggle a half-state into the store.
 * 3. **Terminal.** There is no file fallback and no dual write: once the marker
 *    is set, a legacy state file that appears is *refused* with an error naming
 *    this migration, because reading it would restore exactly the copying bug the
 *    migration exists to end.
 *
 * The marker names the *worktree*, not the repository: legacy files live in each
 * worktree's `.belayd/`, so a repository-wide marker would either refuse or skip
 * the second worktree's files instead of importing them. One row per worktree is
 * what makes "each worktree imported exactly once" true, and the import is
 * idempotent per row (an existing record is never overwritten, and its generation
 * is named in the skip) so a re-run fills gaps instead of clobbering newer state.
 * Two copies of one task's workflow are never merged: nothing in them says which
 * one the orchestrator is driving, so the store's newer row wins and the stale
 * copy is reported.
 *
 * Still files, deliberately: `.belayd/artifacts/` (phase deliverables injected
 * into prompts), `.belayd/proof-dir` (the marker pi-web-plugins reads through the
 * browser file API — see the SYNC WARNING in `src/proof-dir.ts`),
 * `.belayd/review-findings.md` (the rendered artifact named in a posted comment)
 * and `.belayd/config.json` (repo-authored input). The proof receipt is *not* on
 * that list any more: bd-281 moved it into the store and knowingly broke the
 * plugin's `.belayd/proof-receipt.json` reader until bd-303 lands.
 *
 * The fleet half of the same migration lives in `src/fleet-state-import.ts`, split
 * out because this module is loaded by every workflow caller: importing the fleet
 * modules here would drag the fleet supervisor graph into every capability. Both
 * halves share the once-per-target guard below.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ORCHESTRATOR_CLAIM_STALE_MS, parseOrchestratorClaim } from "./orchestrator-claim.js";
import { parseProofReceipt } from "./proof-receipt.js";
import type { RepoStateResult, RepoStateStore, RepoWorkflowState } from "./repo-state-store.js";
import { parseReviewFindingsRecord } from "./review-findings.js";
import { parseRunManifest } from "./run-manifest.js";
import {
  parseHandedOffMarker,
  parseReviewScope,
  parseWorkflowState,
} from "./workflow-state-record.js";

/** Migration marker name; the store row that makes this import one-shot. */
export const REPO_STATE_LEGACY_MIGRATION = "bd-281-legacy-workflow-state";

/** What a legacy file turned out to be. */
export type LegacyStateKind =
  | "workflow"
  | "handoff"
  | "review-scope"
  | "orchestrator-lease"
  | "run"
  | "review-findings"
  | "proof-receipt";

/** One legacy file's fate. */
export interface LegacyImportEntry {
  path: string;
  kind: LegacyStateKind;
  imported: boolean;
  /** Why the file was not imported (unreadable, or a shape the validators reject). */
  skipped?: string;
}

export interface LegacyImportSummary {
  /** True when the marker was already set: nothing was read and nothing written. */
  alreadyImported: boolean;
  entries: LegacyImportEntry[];
  /** Number of files whose rows were written. */
  imported: number;
}

/** The fs surface the importer needs; injected so tests never touch a real worktree. */
export interface LegacyStateFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  readdirSync(path: string): string[];
}

/** The fs seam both halves use; the fleet half shares this instance. */
export const nodeFsSeam: LegacyStateFs = {
  existsSync: (path) => existsSync(path),
  readFileSync: (path) => readFileSync(path, "utf8"),
  readdirSync: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

const HANDOFF_FILE_PATTERN = /^handoff-(.+)\.json$/;

/** Parse JSON, mapping a parse error to `undefined` (an unreadable legacy file). */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The `.belayd/` directory of a worktree. */
function belaydDir(cwd: string): string {
  return join(cwd, ".belayd");
}

/**
 * Every legacy file this migration is responsible for and that is present.
 *
 * The list is closed on purpose: each name here is a file the store replaced, so
 * a present one is either pre-migration state to import or a record to refuse.
 */
export function legacyStateFiles(cwd: string, fs: LegacyStateFs = nodeFsSeam): string[] {
  const dir = belaydDir(cwd);
  const present: string[] = [];
  for (const name of [
    "workflow.json",
    "review-scope.json",
    "orchestrator.json",
    "review-findings.json",
    "proof-receipt.json",
  ]) {
    const path = join(dir, name);
    if (fs.existsSync(path)) present.push(path);
  }
  for (const name of fs.readdirSync(dir)) {
    if (HANDOFF_FILE_PATTERN.test(name)) present.push(join(dir, name));
  }
  // Per-run manifests: `.belayd/runs/<runId>.json`.
  for (const name of fs.readdirSync(join(dir, "runs"))) {
    if (name.endsWith(".json")) present.push(join(dir, "runs", name));
  }
  return present;
}

/**
 * The refusal for a legacy state file that exists *after* the migration marker.
 *
 * Reading it would import a copy of state the shared store already owns (the
 * bd-165 failure), and ignoring it silently would leave the operator with a file
 * that looks authoritative. So it is a named error, and callers surface it.
 */
export function legacyStateRefusal(paths: readonly string[]): string {
  return (
    `belayd: refusing legacy execution state at ${paths.join(", ")}. ` +
    `bd-281 moved workflow, lease, run, review and proof-receipt state into one shared SQLite store ` +
    `(<git-common-dir>/belayd/state.sqlite): .belayd/workflow.json, ` +
    `.belayd/orchestrator.json, .belayd/review-findings.json, .belayd/proof-receipt.json, ` +
    `.belayd/handoff-*.json, .belayd/review-scope.json and .belayd/runs/*.json are retired. ` +
    `These were imported ` +
    `once by "${REPO_STATE_LEGACY_MIGRATION}". Delete them: a copy of state is exactly ` +
    `what the migration removed, so it is not read and not re-imported.`
  );
}

/**
 * Migration marker key for one worktree.
 *
 * One marker per repository is not enough: legacy state lives in *each* worktree,
 * so a repository-wide marker would silently refuse the second worktree's files
 * instead of importing them. The key therefore names the worktree, and the store
 * (not a file) is what records it.
 */
function migrationKey(cwd: string): string {
  return `${REPO_STATE_LEGACY_MIGRATION}:${cwd}`;
}

export interface ImportLegacyStateOptions {
  cwd: string;
  store: RepoStateStore;
  nowMs?: number;
  fs?: LegacyStateFs;
}

/**
 * Import the legacy files of one worktree, at most once per repository.
 *
 * Returns a per-file summary as a value. A file that does not parse is reported
 * as skipped; the marker is still set, because the alternative (leave the marker
 * unset until every file is perfect) would re-run the import forever and keep the
 * refusal from ever protecting the store.
 */
export function importLegacyState(
  options: ImportLegacyStateOptions,
): RepoStateResult<LegacyImportSummary> {
  const fs = options.fs ?? nodeFsSeam;
  const atMs = options.nowMs ?? Date.now();

  const already = options.store.hasMigration(migrationKey(options.cwd));
  if (!already.ok) return { ok: false, error: already.error };
  if (already.value) {
    return { ok: true, value: { alreadyImported: true, entries: [], imported: 0 } };
  }

  const workflowPath = join(belaydDir(options.cwd), "workflow.json");
  const paths = legacyStateFiles(options.cwd, fs).filter((path) => path !== workflowPath);
  const imported = [
    ...(fs.existsSync(workflowPath)
      ? [importWorkflowFile(options.store, workflowPath, options.cwd, fs)]
      : []),
    ...paths.map((path) => importOneFile(options.store, path, options.cwd, atMs, fs)),
  ];
  const failure = imported.find((entry) => entry.kind === "failed");
  if (failure !== undefined && failure.kind === "failed") {
    return { ok: false, error: failure.error };
  }
  const entries = imported.filter((entry): entry is LegacyImportEntry => entry.kind !== "failed");
  const count = entries.filter((entry) => entry.imported).length;

  const recorded = options.store.recordMigration({
    name: migrationKey(options.cwd),
    summary: `${count} file(s) imported, ${entries.length - count} skipped`,
    nowMs: atMs,
  });
  if (!recorded.ok) return { ok: false, error: recorded.error };

  return { ok: true, value: { alreadyImported: false, entries, imported: count } };
}

/** One file's outcome, or the store error that stops the migration. */
type ImportStep = LegacyImportEntry | { kind: "failed"; path: string; error: string };

function failed(path: string, error: string): ImportStep {
  return { kind: "failed", path, error };
}

function skipped(path: string, kind: LegacyStateKind, reason: string): LegacyImportEntry {
  return { path, kind, imported: false, skipped: reason };
}

/**
 * Import the worktree's workflow record, absent-first.
 *
 * A workflow record is the one legacy file whose row identity (the task id) is
 * shared by every worktree that ran the same task, so writing it unconditionally
 * is exactly the copied-state bug bd-281 removes: a pre-upgrade worktree that
 * reopens an old workflow would overwrite the live row's phase ledger with its
 * stale copy. Two copies cannot be merged — nothing in them says which one the
 * orchestrator is actually driving — so an existing row wins, its generation (the
 * store's own record of which write is newer) is named in the skip, and the file
 * is left for the refusal to report.
 */
function importWorkflowFile(
  store: RepoStateStore,
  path: string,
  cwd: string,
  fs: LegacyStateFs,
): ImportStep {
  const text = safeRead(fs, path);
  const state = text === undefined ? undefined : parseWorkflowState(parseJson(text));
  if (state === undefined) return skipped(path, "workflow", "not a valid workflow state");
  let existingGeneration: number | undefined;
  const written = store.mutateWorkflow({
    locator: { taskId: state.taskId },
    worktreePath: cwd,
    // The absence check runs inside the write's transaction, so it sees the row the
    // orchestrator may have advanced after this file was read — not the snapshot a
    // separate read would have taken before the write.
    update: (current) => {
      if (current === null) return { kind: "write", state: stripSchemaVersion(state) };
      existingGeneration = current.generation;
      return { kind: "skip" };
    },
    nowMs: state.updatedAt,
  });
  if (!written.ok) return failed(path, written.error);
  if (written.value.kind === "written") return { path, kind: "workflow", imported: true };
  return skipped(
    path,
    "workflow",
    existingGeneration === undefined
      ? "a workflow row already exists"
      : `a workflow row already exists (generation ${existingGeneration})`,
  );
}

/** Import one non-workflow legacy file, routed by its name. */
function importOneFile(
  store: RepoStateStore,
  path: string,
  cwd: string,
  atMs: number,
  fs: LegacyStateFs,
): ImportStep {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (path.includes("/runs/")) return importRunFile(store, path, fs);
  switch (name) {
    case "orchestrator.json":
      return importOrchestratorLease(store, path, cwd, fs);
    case "review-findings.json":
      return importReviewFindings(store, path, fs);
    case "proof-receipt.json":
      return importProofReceipt(store, path, fs);
    case "review-scope.json":
      return importReviewScopeFile(store, path, cwd, fs);
    default:
      break;
  }
  const match = HANDOFF_FILE_PATTERN.exec(name);
  if (match === null) return skipped(path, "review-scope", "unexpected legacy file name");
  return importHandoffFile({ store, path, cwd, atMs, handoffKey: match[1] ?? "", fs });
}

/** Import the pending review scope, absent-first (a stale capture must not win). */
function importReviewScopeFile(
  store: RepoStateStore,
  path: string,
  cwd: string,
  fs: LegacyStateFs,
): ImportStep {
  const text = safeRead(fs, path);
  const scope = text === undefined ? undefined : parseReviewScope(parseJson(text));
  if (scope === undefined) return skipped(path, "review-scope", "not a valid review scope");
  // Absent-first like every other importer: a scope the store already holds is the
  // newer capture, and a stale one must not widen or narrow it. The check runs
  // inside the write's transaction, so a capture added after this file was read
  // still wins.
  const written = store.mutateReviewScope({
    worktreePath: cwd,
    taskId: scope.taskId,
    scope,
    update: (current) => (current === null ? { kind: "write" } : { kind: "skip" }),
    nowMs: scope.capturedAt,
  });
  if (!written.ok) return failed(path, written.error);
  return written.value.kind === "written"
    ? { path, kind: "review-scope", imported: true }
    : skipped(path, "review-scope", "a review scope already exists");
}

/** Import one caller-scoped handoff marker, absent-first. */
function importHandoffFile(input: {
  store: RepoStateStore;
  path: string;
  cwd: string;
  atMs: number;
  handoffKey: string;
  fs: LegacyStateFs;
}): ImportStep {
  const text = safeRead(input.fs, input.path);
  const marker = text === undefined ? undefined : parseHandedOffMarker(parseJson(text));
  if (marker === undefined) return skipped(input.path, "handoff", "not a valid handoff marker");
  const written = input.store.mutateHandoff({
    worktreePath: input.cwd,
    handoffKey: input.handoffKey,
    taskId: marker.taskId,
    marker,
    // The handoff key (the caller's session key) is the store's unique identity, and
    // a resuming session is the only one that knows it — so the absence test is by
    // key, not by (task, key): a key already held by another task is still taken,
    // and the plan sees that row inside the transaction.
    update: (current) => (current === null ? { kind: "write" } : { kind: "skip" }),
    nowMs: input.atMs,
  });
  if (!written.ok) return failed(input.path, written.error);
  return written.value.kind === "written"
    ? { path: input.path, kind: "handoff", imported: true }
    : skipped(input.path, "handoff", "a handoff marker already exists");
}

/**
 * Import the worktree's orchestrator lease.
 *
 * The lease is imported at its own heartbeat instant, so a cold record stays cold
 * (its expiry is derived from the heartbeat, not from the import time) and a
 * takeover decision is unchanged by the migration.
 */
function importOrchestratorLease(
  store: RepoStateStore,
  path: string,
  cwd: string,
  fs: LegacyStateFs,
): ImportStep {
  const text = safeRead(fs, path);
  const claim = text === undefined ? undefined : parseOrchestratorClaim(parseJson(text));
  if (claim === undefined) return skipped(path, "orchestrator-lease", "not a valid lease");
  // The acquire is itself one transaction that refuses a holder, so there is no
  // read-then-write window: a lease a session took after this file was read still
  // wins, and `takeOverStale` stays off because the import fills gaps, it never
  // rolls state back.
  const acquired = store.acquireLease({
    taskId: claim.taskId,
    branch: claim.branch,
    sessionId: claim.sessionId,
    worktreePath: cwd,
    pid: claim.pid,
    nowMs: claim.heartbeatAt,
    ttlMs: ORCHESTRATOR_CLAIM_STALE_MS,
    takeOverStale: false,
  });
  if (acquired.ok) return { path, kind: "orchestrator-lease", imported: true };
  if (acquired.reason === "held") {
    return skipped(
      path,
      "orchestrator-lease",
      `a lease row already exists (held by ${acquired.holder?.taskId ?? "another task"})`,
    );
  }
  return failed(path, acquired.error);
}

/** Import one phase-run manifest row. */
function importRunFile(store: RepoStateStore, path: string, fs: LegacyStateFs): ImportStep {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const text = safeRead(fs, path);
  const manifest = text === undefined ? undefined : parseRunManifest(parseJson(text));
  if (manifest === undefined) return skipped(path, "run", `${name} is not a valid run manifest`);
  // The run id the *body* names must be the one the filename names, or the row key
  // would disagree with its payload (bd-242).
  if (`${manifest.runId}.json` !== name) {
    return skipped(path, "run", "the body names another run id");
  }
  const written = store.mutateRun({
    runId: manifest.runId,
    update: (current) =>
      current === null ? { kind: "write", payload: manifest } : { kind: "skip" },
  });
  if (!written.ok) return failed(path, written.error);
  return written.value === null
    ? skipped(path, "run", "a run row already exists")
    : { path, kind: "run", imported: true };
}

/** Import the review-findings disposition record. */
function importReviewFindings(store: RepoStateStore, path: string, fs: LegacyStateFs): ImportStep {
  const text = safeRead(fs, path);
  const record = text === undefined ? undefined : parseReviewFindingsRecord(parseJson(text));
  if (record === undefined) {
    return skipped(path, "review-findings", "not a valid review-findings record");
  }
  const written = store.mutateReviewFindings({
    taskId: record.taskId,
    record,
    update: (current) => (current === null ? { kind: "write" } : { kind: "skip" }),
  });
  if (!written.ok) return failed(path, written.error);
  return written.value.kind === "written"
    ? { path, kind: "review-findings", imported: true }
    : skipped(path, "review-findings", "a record already exists");
}

/** Import the task-bound proof receipt, keyed by the task the receipt names. */
function importProofReceipt(store: RepoStateStore, path: string, fs: LegacyStateFs): ImportStep {
  const text = safeRead(fs, path);
  const receipt = text === undefined ? undefined : parseProofReceipt(parseJson(text));
  if (receipt === undefined) return skipped(path, "proof-receipt", "not a valid proof receipt");
  // Absent-first, like every other importer: a receipt the store already holds is
  // the newer upload, and a stale file must not replace it. The check shares the
  // insert's transaction, so a receipt written after this file was read still wins.
  const written = store.mutateProofReceipt({
    taskId: receipt.taskId,
    receipt,
    update: (current) => (current === null ? { kind: "write" } : { kind: "skip" }),
  });
  if (!written.ok) return failed(path, written.error);
  return written.value.kind === "written"
    ? { path, kind: "proof-receipt", imported: true }
    : skipped(path, "proof-receipt", "a proof receipt already exists");
}

/** Read a legacy file, mapping an IO error to `undefined`. */
export function safeRead(fs: LegacyStateFs, path: string): string | undefined {
  try {
    return fs.readFileSync(path);
  } catch {
    return undefined;
  }
}

/** Drop the `schemaVersion` discriminator the file carried; the store has no column for it. */
function stripSchemaVersion(
  state: RepoWorkflowState & { schemaVersion?: unknown },
): RepoWorkflowState {
  const { schemaVersion: _schemaVersion, ...rest } = state;
  return rest;
}

/**
 * Targets whose legacy files have been imported and checked in this process.
 *
 * One set for both halves, here rather than one guard in each caller: the worktree
 * half is keyed by worktree and the fleet half (`src/fleet-state-import.ts`) by git
 * common dir, and a caller-local set would let two layers disagree about whether a
 * target was already prepared. The key carries the store path so a test or an
 * operator relocating the store (`BELAYD_REPO_STATE_FILE`) starts clean. Only the
 * durable marker row in the store is one-shot; this is the per-process
 * short-circuit that keeps every store access from re-scanning a directory.
 */
const migratedTargets = new Set<string>();

/**
 * Claim the once-per-process migration slot for one target.
 *
 * `true` means another call in this process already prepared it, so the caller
 * must return without importing or reporting again.
 */
export function claimMigrationTarget(store: RepoStateStore, target: string): boolean {
  const key = `${store.path}|${target}`;
  if (migratedTargets.has(key)) return true;
  migratedTargets.add(key);
  return false;
}

/**
 * Run the migration for a worktree and report any refused file, once per process.
 *
 * Wiring point for `src/workflow-state.ts`: the first store access in a worktree
 * performs the one-shot import, so a live worktree keeps its workflow without an
 * operator step, and any file that appears afterwards is refused loudly instead
 * of being read.
 */
export function migrateAndGuardLegacyState(deps: {
  cwd: string;
  store: RepoStateStore;
  onRefusal: (message: string) => void;
  onImported: (summary: LegacyImportSummary) => void;
  fs?: LegacyStateFs;
}): void {
  if (claimMigrationTarget(deps.store, `worktree:${deps.cwd}`)) return;
  const summary = importLegacyState({
    cwd: deps.cwd,
    store: deps.store,
    ...(deps.fs === undefined ? {} : { fs: deps.fs }),
  });
  if (!summary.ok) {
    deps.onRefusal(`belayd: bd-281 state import failed for ${deps.cwd}: ${summary.error}`);
    return;
  }
  if (!summary.value.alreadyImported && summary.value.imported > 0) {
    deps.onImported(summary.value);
  }
  const present = legacyStateFiles(deps.cwd, deps.fs ?? nodeFsSeam);
  if (present.length > 0) deps.onRefusal(legacyStateRefusal(present));
}
