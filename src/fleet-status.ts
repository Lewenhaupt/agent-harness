/**
 * Fleet status — read-only aggregation for the multi-bead supervisor (bd-126).
 *
 * P0 of docs/fleet-orchestrator.md is pure observation: the supervisor is a
 * scheduler, never a phase worker, so this module reads every worktree's
 * `.belayd/workflow.json` plus its run manifests and derives one view. It
 * writes nothing, spawns nothing, merges nothing, and arms no gate.
 *
 * The view is *derived*: no fleet status file exists. Shared fleet state lives
 * under `<git-common-dir>/belayd/fleet/<fleetId>/` (intent, mailbox, merge
 * queue, audit log); P0 only reads the optional `fleet.json` intent.
 */

import { basename, join } from "node:path";
import { z } from "zod";

import { taskIdFromBranch } from "./handoff.js";
import type { RunManifest, RunManifestFs } from "./run-manifest.js";
import { listRuns, RunStatus, runManifestFs } from "./run-manifest.js";
import type { WorkflowState } from "./workflow-state.js";
import { parseWorkflowState, workflowStateFilePath } from "./workflow-state.js";
import type { GitCommonDirResult, WorktreeListEntry } from "./worktree.js";
import { listWorktrees as defaultListWorktrees, resolveGitCommonDir } from "./worktree.js";

const FLEET_SCHEMA_VERSION = 1;

/** Fleet id used when the caller does not name one. */
export const DEFAULT_FLEET_ID = "default";

// ── Fleet intent (fleet.json) ─────────────────────────────────────────

/**
 * Operator intent for one fleet. Absent in P0 unless a human writes it: no P0
 * code path creates or updates this file. Later milestones (P1 launch, P3
 * ordering, P4 pause) read/write the same record, which is why the schema is
 * declared here now.
 */
const FleetIntentSchema = z.object({
  schemaVersion: z.literal(FLEET_SCHEMA_VERSION),
  fleetId: z.string(),
  taskIds: z.array(z.string()),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  /** Requested concurrency ceiling (P3); absent means "use the default". */
  maxConcurrent: z.number().int().positive().optional(),
  /** Set while the operator has paused the fleet (P4). P0 only reports it. */
  paused: z.boolean().optional(),
  note: z.string().optional(),
});

export type FleetIntent = z.infer<typeof FleetIntentSchema>;

/** Parse a fleet intent file; absent/corrupt/wrong-version all yield undefined. */
export function parseFleetIntent(raw: unknown): FleetIntent | undefined {
  const result = FleetIntentSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

// ── Shared fleet state paths ──────────────────────────────────────────

/**
 * Sanitize an operator-supplied fleet id before it becomes a path segment.
 * An empty or dot-only id would collapse or escape the fleet root, so it falls
 * back to {@link DEFAULT_FLEET_ID}.
 */
export function sanitizeFleetId(fleetId: string): string {
  const sanitized = fleetId.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized === "" || sanitized === "." || sanitized === ".." ? DEFAULT_FLEET_ID : sanitized;
}

/** `<git-common-dir>/belayd/fleet/<fleetId>/` — shared by every worktree. */
export function fleetStateDir(gitCommonDir: string, fleetId: string): string {
  return join(gitCommonDir, "belayd", "fleet", sanitizeFleetId(fleetId));
}

export function fleetIntentFilePath(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "fleet.json");
}

/** Member → supervisor note drop, drained at turn start (P1). Unused in P0. */
export function fleetInboxDir(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "inbox");
}

/** Supervisor → member notification drop, drained at turn start (P1). Unused in P0. */
export function fleetEventsDir(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "events");
}

/** Single-flight merge queue (P2). Unused in P0. */
export function fleetMergeQueueFilePath(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "merge-queue.json");
}

/** Append-only cross-tree authority audit log (P2+). Unused in P0. */
export function fleetAuditLogPath(gitCommonDir: string, fleetId: string): string {
  return join(fleetStateDir(gitCommonDir, fleetId), "audit.log");
}

// ── Derived member state ──────────────────────────────────────────────

/** What the worktree's `.belayd/workflow.json` turned out to be. */
export type FleetWorkflowFile = "ok" | "missing" | "corrupt";

/** Already-read workflow state for one worktree; never read inside the pure layer. */
export type FleetWorkflowSnapshot =
  | { kind: "ok"; state: WorkflowState }
  | { kind: "missing" }
  | { kind: "corrupt" };

/** Everything the pure view builder needs about one worktree. */
export interface FleetMemberSnapshot {
  worktreePath: string;
  /**
   * True for the repository's own checkout. It only joins a fleet when it
   * holds workflow state (an in-place workflow); otherwise it is the
   * supervisor's merge target, not a member.
   */
  isMainWorktree: boolean;
  /** Branch checked out here; undefined on detached HEAD or unreadable git. */
  branch: string | undefined;
  workflow: FleetWorkflowSnapshot;
  /** Run manifests from `listRuns` at that worktree. */
  runs: readonly RunManifest[];
}

/**
 * Coarse derived member state. Ordered by precedence in
 * {@link deriveFleetMemberState}: a crash outranks a pending human review, a
 * failed run outranks normal progress.
 */
export const FLEET_MEMBER_STATES = [
  "active",
  "blocked",
  "awaiting-human",
  "interrupted",
  "idle",
  "missing-state",
] as const;

export type FleetMemberState = (typeof FLEET_MEMBER_STATES)[number];

export type FleetStateCounts = Record<FleetMemberState, number>;

/** Most recent run recorded for one phase. */
export interface FleetPhaseRunView {
  phase: string;
  runId: string;
  status: RunStatus;
  startedAt: number;
  completedAt: number | undefined;
}

export interface FleetMemberView {
  /** Task id recorded in workflow.json; undefined without readable state. */
  taskId: string | undefined;
  /**
   * Task id implied by the checked-out branch (or the worktree directory name
   * when the branch is unavailable). Used to flag a stale `workflow.json`.
   */
  expectedTaskId: string | undefined;
  worktreePath: string;
  branch: string | undefined;
  workflowFile: FleetWorkflowFile;
  workflowType: string | undefined;
  phaseOrder: readonly string[];
  completedPhases: readonly string[];
  pendingPhases: readonly string[];
  awaitingReviewResponse: boolean;
  latestRuns: readonly FleetPhaseRunView[];
  interruptedRunCount: number;
  /** workflow.json `updatedAt`, raised to the newest run timestamp when that is later. */
  updatedAt: number | undefined;
  state: FleetMemberState;
}

export const FLEET_WARNING_KINDS = [
  "missing-workflow-state",
  "corrupt-workflow-state",
  "unparsed-worktree-path",
  "duplicate-task-id",
  "task-id-mismatch",
] as const;

export type FleetWarningKind = (typeof FLEET_WARNING_KINDS)[number];

export interface FleetWarning {
  kind: FleetWarningKind;
  taskId?: string;
  worktreePath?: string;
  message: string;
}

export interface FleetStatus {
  schemaVersion: number;
  /** Sanitized id whose directory actually located the fleet files. */
  fleetId: string;
  /** Raw operator input, set only when sanitizing changed it. */
  requestedFleetId?: string;
  intent: FleetIntent | undefined;
  members: FleetMemberView[];
  counts: FleetStateCounts;
  warnings: FleetWarning[];
}

export interface BuildFleetStatusOptions {
  fleetId: string;
  /** Raw caller input when it differs from `fleetId`; reported, never used for paths. */
  requestedFleetId?: string;
  intent: FleetIntent | undefined;
  members: readonly FleetMemberSnapshot[];
  /** Worktree-enumeration warnings (e.g. an unrepresentable porcelain path). */
  worktreeWarnings?: readonly FleetWarning[];
}

/**
 * Task id carried by a worktree directory name such as `<repo>.feat-bd-42`.
 *
 * Deliberately the same shape as `taskIdFromBranch` (`bd-<digits>` plus at most
 * one sub-bead segment): a multi-dot id is not a task id there either, and two
 * different patterns would silently skip the mismatch check for one source.
 * The only difference is the separator before `bd-`: a directory name joins the
 * branch with `.` or `-`, not `/`.
 */
const TASK_ID_SUFFIX = /(?:^|[^A-Za-z0-9])(bd-\d+(?:\.\d+)?)$/;

function expectedTaskIdFor(snapshot: FleetMemberSnapshot): string | undefined {
  if (snapshot.branch !== undefined) {
    const fromBranch = taskIdFromBranch(snapshot.branch);
    if (fromBranch !== undefined) return fromBranch;
  }
  return TASK_ID_SUFFIX.exec(basename(snapshot.worktreePath))?.[1];
}

function countInterrupted(runs: readonly RunManifest[]): number {
  return runs.filter((run) => run.status === RunStatus.Interrupted).length;
}

function lastRunTimestamp(runs: readonly RunManifest[]): number | undefined {
  let latest: number | undefined;
  for (const run of runs) {
    const stamp = run.completedAt ?? run.startedAt;
    if (latest === undefined || stamp > latest) latest = stamp;
  }
  return latest;
}

/**
 * Locale-independent string order. `localeCompare` changes with the host ICU
 * locale, which would make the "deterministic" view locale-dependent.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Total order on run manifests for one phase: newer start wins, then the run id
 * by code unit. `listRuns` orders equal timestamps by `readdirSync`, so without
 * the secondary key the derived state could flip between invocations.
 */
function isLaterRun(candidate: RunManifest, existing: RunManifest): boolean {
  if (candidate.startedAt !== existing.startedAt) {
    return candidate.startedAt > existing.startedAt;
  }
  return compareCodeUnits(candidate.runId, existing.runId) > 0;
}

/** The single "latest manifest per phase" rule shared by view and state derivation. */
function latestManifestPerPhase(runs: readonly RunManifest[]): Map<string, RunManifest> {
  const latest = new Map<string, RunManifest>();
  for (const run of runs) {
    const existing = latest.get(run.phase);
    if (existing === undefined || isLaterRun(run, existing)) {
      latest.set(run.phase, run);
    }
  }
  return latest;
}

/** Latest manifest per phase, ordered by the workflow's phase order. */
function latestRunPerPhase(
  runs: readonly RunManifest[],
  phaseOrder: readonly string[],
): FleetPhaseRunView[] {
  const rank = (phase: string): number => {
    const index = phaseOrder.indexOf(phase);
    return index === -1 ? phaseOrder.length : index;
  };

  return [...latestManifestPerPhase(runs).values()]
    .sort((a, b) => rank(a.phase) - rank(b.phase) || compareCodeUnits(a.phase, b.phase))
    .map((run) => ({
      phase: run.phase,
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    }));
}

/** A `completedBy: "user"` run whose report was never delivered is awaiting an operator. */
function hasUndeliveredUserCompletion(runs: readonly RunManifest[]): boolean {
  return runs.some(
    (run) =>
      run.completedBy === "user" &&
      run.deliveredAt === undefined &&
      run.completionReport !== undefined,
  );
}

/** Whether the newest run for a not-yet-completed phase failed. */
function hasFailedPendingPhase(input: {
  runs: readonly RunManifest[];
  completedPhases: readonly string[];
}): boolean {
  const completed = new Set(input.completedPhases);
  return [...latestManifestPerPhase(input.runs).values()].some(
    (run) => !completed.has(run.phase) && run.status === RunStatus.Failed,
  );
}

export interface DeriveFleetMemberStateInput {
  workflow: FleetWorkflowSnapshot;
  runs: readonly RunManifest[];
  completedPhases: readonly string[];
  pendingPhases: readonly string[];
  awaitingReviewResponse: boolean;
}

/**
 * Pure state derivation. Precedence: no state → interrupted → awaiting human →
 * blocked (newest run of a pending phase failed) → idle (every phase done) →
 * active (workflow in progress, whether or not a run is in flight).
 */
export function deriveFleetMemberState(input: DeriveFleetMemberStateInput): FleetMemberState {
  if (input.workflow.kind !== "ok") return "missing-state";
  if (countInterrupted(input.runs) > 0) return "interrupted";
  if (input.awaitingReviewResponse || hasUndeliveredUserCompletion(input.runs)) {
    return "awaiting-human";
  }
  if (hasFailedPendingPhase(input)) return "blocked";
  if (input.pendingPhases.length === 0) return "idle";
  return "active";
}

function memberView(snapshot: FleetMemberSnapshot): FleetMemberView {
  const expectedTaskId = expectedTaskIdFor(snapshot);
  const interruptedRunCount = countInterrupted(snapshot.runs);
  const runTimestamp = lastRunTimestamp(snapshot.runs);

  if (snapshot.workflow.kind !== "ok") {
    return {
      taskId: undefined,
      expectedTaskId,
      worktreePath: snapshot.worktreePath,
      branch: snapshot.branch,
      workflowFile: snapshot.workflow.kind,
      workflowType: undefined,
      phaseOrder: [],
      completedPhases: [],
      pendingPhases: [],
      awaitingReviewResponse: false,
      latestRuns: latestRunPerPhase(snapshot.runs, []),
      interruptedRunCount,
      updatedAt: runTimestamp,
      state: "missing-state",
    };
  }

  const state = snapshot.workflow.state;
  const completedPhases = [...state.completedPhaseNames];
  const completed = new Set(completedPhases);
  const pendingPhases = state.phaseOrder.filter((phase) => !completed.has(phase));
  // Absent flag means "not awaiting" (pre-bd-81 state files predate the field).
  const awaitingReviewResponse = state.awaitingReviewResponse === true;

  return {
    taskId: state.taskId,
    expectedTaskId,
    worktreePath: snapshot.worktreePath,
    branch: snapshot.branch,
    workflowFile: "ok",
    workflowType: state.workflowType,
    phaseOrder: [...state.phaseOrder],
    completedPhases,
    pendingPhases,
    awaitingReviewResponse,
    latestRuns: latestRunPerPhase(snapshot.runs, state.phaseOrder),
    interruptedRunCount,
    updatedAt:
      runTimestamp === undefined ? state.updatedAt : Math.max(state.updatedAt, runTimestamp),
    state: deriveFleetMemberState({
      workflow: snapshot.workflow,
      runs: snapshot.runs,
      completedPhases,
      pendingPhases,
      awaitingReviewResponse,
    }),
  };
}

/** Members sort by task id (state-less members last), then by path. */
function compareMembers(a: FleetMemberView, b: FleetMemberView): number {
  const aKey = a.taskId ?? "";
  const bKey = b.taskId ?? "";
  if (aKey !== bKey) {
    if (aKey === "") return 1;
    if (bKey === "") return -1;
    return compareCodeUnits(aKey, bKey);
  }
  return compareCodeUnits(a.worktreePath, b.worktreePath);
}

function countMemberStates(members: readonly FleetMemberView[]): FleetStateCounts {
  const counts: FleetStateCounts = {
    active: 0,
    blocked: 0,
    "awaiting-human": 0,
    interrupted: 0,
    idle: 0,
    "missing-state": 0,
  };
  for (const member of members) counts[member.state] += 1;
  return counts;
}

function collectWarnings(members: readonly FleetMemberView[]): FleetWarning[] {
  const warnings: FleetWarning[] = [];

  for (const member of members) {
    switch (member.workflowFile) {
      case "missing":
        warnings.push({
          kind: "missing-workflow-state",
          worktreePath: member.worktreePath,
          message: `no .belayd/workflow.json in ${member.worktreePath}; that worktree drives no workflow`,
        });
        break;
      case "corrupt":
        warnings.push({
          kind: "corrupt-workflow-state",
          worktreePath: member.worktreePath,
          message: `unreadable .belayd/workflow.json in ${member.worktreePath}`,
        });
        break;
      case "ok":
        if (
          member.taskId !== undefined &&
          member.expectedTaskId !== undefined &&
          member.taskId !== member.expectedTaskId
        ) {
          warnings.push({
            kind: "task-id-mismatch",
            taskId: member.taskId,
            worktreePath: member.worktreePath,
            message:
              `${member.worktreePath} records ${member.taskId}, but its branch or directory ` +
              `names ${member.expectedTaskId}`,
          });
        }
        break;
    }
  }

  const byTaskId = new Map<string, string[]>();
  for (const member of members) {
    if (member.taskId === undefined) continue;
    const paths = byTaskId.get(member.taskId) ?? [];
    paths.push(member.worktreePath);
    byTaskId.set(member.taskId, paths);
  }
  for (const taskId of [...byTaskId.keys()].sort(compareCodeUnits)) {
    const paths = byTaskId.get(taskId);
    if (paths === undefined || paths.length < 2) continue;
    warnings.push({
      kind: "duplicate-task-id",
      taskId,
      message: `${taskId} is claimed by ${paths.length} worktrees: ${[...paths].sort(compareCodeUnits).join(", ")}`,
    });
  }

  return warnings;
}

/**
 * Pure rollup: no fs, no git. Every input is already-read data, so tests need
 * no mocks and the same snapshot always yields the same view.
 */
export function buildFleetStatus(options: BuildFleetStatusOptions): FleetStatus {
  const members: FleetMemberView[] = [];
  for (const snapshot of options.members) {
    // The main checkout is the supervisor's merge target, not a fleet member,
    // unless an in-place workflow gave it workflow state.
    if (snapshot.isMainWorktree && snapshot.workflow.kind === "missing") continue;
    members.push(memberView(snapshot));
  }
  members.sort(compareMembers);

  return {
    schemaVersion: FLEET_SCHEMA_VERSION,
    fleetId: options.fleetId,
    requestedFleetId:
      options.requestedFleetId === undefined || options.requestedFleetId === options.fleetId
        ? undefined
        : options.requestedFleetId,
    intent: options.intent,
    members,
    counts: countMemberStates(members),
    warnings: [...(options.worktreeWarnings ?? []), ...collectWarnings(members)],
  };
}

// ── Plain-text formatter ──────────────────────────────────────────────

function formatIntent(intent: FleetIntent | undefined): string {
  if (intent === undefined) return "none recorded";
  const tasks = intent.taskIds.length === 0 ? "no task ids" : intent.taskIds.join(", ");
  const concurrency =
    intent.maxConcurrent === undefined ? "" : `, max ${intent.maxConcurrent} concurrent`;
  const paused = intent.paused === true ? ", paused" : "";
  return `${tasks}${concurrency}${paused}`;
}

function formatCounts(counts: FleetStateCounts): string {
  return FLEET_MEMBER_STATES.map((state) => `${state}=${counts[state]}`).join(" ");
}

function formatFleetId(status: FleetStatus): string {
  if (status.requestedFleetId === undefined) return status.fleetId;
  return `${status.fleetId} (requested "${status.requestedFleetId}")`;
}

function formatMember(member: FleetMemberView): string[] {
  const branch = member.branch === undefined ? "detached HEAD" : member.branch;
  const lines = [
    `Member ${member.taskId ?? "(no task id)"} — ${member.state}`,
    `  worktree: ${member.worktreePath} (branch ${branch})`,
  ];

  if (member.workflowFile === "ok") {
    const completedInOrder = member.phaseOrder.filter((phase) =>
      member.completedPhases.includes(phase),
    ).length;
    lines.push(
      `  workflow: ${member.workflowType ?? "unknown"} ${completedInOrder}/${member.phaseOrder.length} phases complete`,
    );
    lines.push(
      `  pending: ${member.pendingPhases.length === 0 ? "none" : member.pendingPhases.join(", ")}`,
    );
    lines.push(`  awaiting review response: ${member.awaitingReviewResponse ? "yes" : "no"}`);
  } else {
    lines.push(`  workflow: ${member.workflowFile}`);
  }

  lines.push(`  interrupted runs: ${member.interruptedRunCount}`);
  lines.push(
    `  last updated: ${member.updatedAt === undefined ? "unknown" : new Date(member.updatedAt).toISOString()}`,
  );
  lines.push(
    `  latest runs: ${
      member.latestRuns.length === 0
        ? "none"
        : member.latestRuns.map((run) => `${run.phase}=${run.status}`).join(", ")
    }`,
  );
  return lines;
}

/**
 * Deterministic plain text (no ANSI) for a pi tool result. Members are already
 * sorted by task id; warnings keep that order with duplicate-task warnings last.
 */
export function formatFleetStatus(status: FleetStatus): string {
  const lines = [
    // Name only the id that actually located the files; a sanitized id keeps
    // traversal input from printing as if it were a real directory.
    `Fleet ${formatFleetId(status)}`,
    `  intent: ${formatIntent(status.intent)}`,
    `  members: ${status.members.length}`,
    `  states: ${formatCounts(status.counts)}`,
  ];

  if (status.members.length === 0) {
    lines.push("");
    lines.push("No fleet members: no worktree holds Belayd workflow state.");
  }

  for (const member of status.members) {
    lines.push("");
    lines.push(...formatMember(member));
  }

  if (status.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${status.warnings.length}):`);
    for (const warning of status.warnings) lines.push(`  - ${warning.message}`);
  }

  return lines.join("\n");
}

// ── Reader (the only fs/git access in this module) ────────────────────

/** Fs seam for the reader; compatible with the workflow-state and run-manifest seams. */
export type FleetStatusFs = RunManifestFs;

export interface ReadFleetStatusOptions {
  cwd: string;
  fleetId: string;
  fs?: FleetStatusFs;
  /** Test seam for the git-common-dir probe. */
  resolveCommonDir?: (cwd: string) => GitCommonDirResult;
  /** Test seam for worktree enumeration. */
  listWorktrees?: (cwd: string) => ReturnType<typeof defaultListWorktrees>;
}

export type ReadFleetStatusResult = { ok: true; value: FleetStatus } | { ok: false; error: string };

function readFleetIntentFile(
  fs: FleetStatusFs,
  gitCommonDir: string,
  fleetId: string,
): FleetIntent | undefined {
  const filePath = fleetIntentFilePath(gitCommonDir, fleetId);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return parseFleetIntent(JSON.parse(fs.readFileSync(filePath)));
  } catch {
    // A corrupt intent file is treated as absent: P0 only reports intent, and
    // blocking the whole fleet view on it would hide every member.
    return undefined;
  }
}

function readMemberSnapshot(fs: FleetStatusFs, entry: WorktreeListEntry): FleetMemberSnapshot {
  const workflowPath = workflowStateFilePath(entry.path);
  let workflow: FleetWorkflowSnapshot;

  if (!fs.existsSync(workflowPath)) {
    workflow = { kind: "missing" };
  } else {
    try {
      const parsed = parseWorkflowState(JSON.parse(fs.readFileSync(workflowPath)));
      workflow = parsed === undefined ? { kind: "corrupt" } : { kind: "ok", state: parsed };
    } catch {
      workflow = { kind: "corrupt" };
    }
  }

  return {
    worktreePath: entry.path,
    isMainWorktree: entry.isMainWorktree,
    branch: entry.branch,
    workflow,
    runs: listRuns({ cwd: entry.path, fs }),
  };
}

/**
 * Read + derive the fleet view. Two read-only git probes (`rev-parse
 * --git-common-dir`, `worktree list --porcelain`) and fs reads only; no git
 * mutation, no writes, no spawns.
 */
export function readFleetStatus(options: ReadFleetStatusOptions): ReadFleetStatusResult {
  const fs = options.fs ?? runManifestFs;
  const resolveCommonDir = options.resolveCommonDir ?? resolveGitCommonDir;
  const listWorktrees = options.listWorktrees ?? defaultListWorktrees;

  // One id: the sanitized value both locates the files and names the fleet in
  // the view, so the header can never point at a different directory.
  const requestedFleetId = options.fleetId;
  const fleetId = sanitizeFleetId(requestedFleetId);

  const commonDirResult = resolveCommonDir(options.cwd);
  if (!commonDirResult.ok) return { ok: false, error: commonDirResult.error };

  const worktreeResult = listWorktrees(options.cwd);
  if (!worktreeResult.ok) return { ok: false, error: worktreeResult.error };

  const intent = readFleetIntentFile(fs, commonDirResult.commonDir, fleetId);
  const members = worktreeResult.entries.map((entry) => readMemberSnapshot(fs, entry));
  const worktreeWarnings: FleetWarning[] = worktreeResult.warnings.map((message) => ({
    kind: "unparsed-worktree-path",
    message,
  }));

  return {
    ok: true,
    value: buildFleetStatus({ fleetId, requestedFleetId, intent, members, worktreeWarnings }),
  };
}
