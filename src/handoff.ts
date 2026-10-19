/**
 * Handoff packets carried from a parent session into a spawned orchestrator.
 *
 * A spawned orchestrator starts context-free: it only sees its first prompt and
 * whatever `bd show` returns. The parent, however, holds the plan, the scope
 * decisions, the cross-bead ordering and the measured facts. This module builds
 * that context into a serialisable packet, formats it for the child's first
 * turn and re-injects it into the gate context on resume.
 *
 * The split is deliberate: packet construction/formatting/persistence live here
 * (pure apart from the injectable fs and git seams) so they are unit-testable
 * without a live repository or daemon.
 *
 * Sizing: {@link HANDOFF_FIELD_MAX_CHARS} caps each free-form body and
 * {@link HANDOFF_TOTAL_MAX_CHARS} caps their sum when a packet is built. The
 * identity headers (task/branch/worktree/parent lines) are separately bounded
 * by {@link HANDOFF_IDENTITY_FIELD_MAX_CHARS} and are NOT part of the total
 * body budget, because they are short, fixed-shape lines the child must always
 * see.
 */

import * as nodeFs from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { lastAssistantText, type TranscriptEntry } from "./session-transcript.js";
import { defaultGitExec, type GitExec } from "./stack-rebase.js";
import { atomicWriteJson, readWorkflowState, type WorkflowFs } from "./workflow-state.js";

/** Bumped when the packet shape changes incompatibly; older files are ignored. */
export const HANDOFF_SCHEMA_VERSION = 1;

/** File name inside a worktree's `.belayd/` directory. */
export const HANDOFF_FILE_NAME = "handoff.json";

/**
 * Per-free-form-field cap. A truncated packet must still be useful, so the
 * marker is appended rather than silently losing the tail.
 */
export const HANDOFF_FIELD_MAX_CHARS = 4000;

/**
 * Total cap across the free-form bodies (parent summary + parent/child task
 * text). Without it a long transcript plus two full bead descriptions can push
 * the child's first turn past its useful context budget. Budgeting is applied
 * in declaration order, so the parent's own summary is never the field that
 * gets dropped.
 */
export const HANDOFF_TOTAL_MAX_CHARS = 10000;

/** Dirty files are a hint, not an inventory; cap the list. */
export const HANDOFF_DIRTY_FILES_MAX = 50;

/**
 * Bound on the identity-style single-line fields (task id, branch, paths, fork
 * point, commit subject). These are never part of the free-form body budget;
 * they are capped so a hand-edited file cannot inject a multi-megabyte line.
 */
export const HANDOFF_IDENTITY_FIELD_MAX_CHARS = 1024;

/**
 * Upper bound for a `--handoff @path` file. The read is synchronous on the
 * extension event loop, so it must be bounded: without this, `@/dev/zero`
 * blocks forever and a multi-GB log freezes the session process.
 */
export const HANDOFF_ARG_FILE_MAX_BYTES = 1024 * 1024;

/** Upper bound on completed-phase names accepted from a hand-edited packet. */
const HANDOFF_COMPLETED_PHASES_MAX = 100;

const TRUNCATION_MARKER = "…(truncated)";

const HandoffPacketSchema = z.object({
  schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
  taskId: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS),
  workflowType: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS),
  branch: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS),
  worktreePath: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS),
  base: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS).optional(),
  forkPoint: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS).optional(),
  parentTaskId: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS).optional(),
  parentBranch: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS).optional(),
  parentSessionId: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS).optional(),
  parentWorktreePath: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS).optional(),
  createdAt: z.number().finite(),
  // Caps apply at parse time too (bd-121 W6): a hand-edited or future-version
  // file must not inject an unbounded body into the gate context every turn.
  parentSummary: z.string().max(HANDOFF_FIELD_MAX_CHARS).optional(),
  parentTask: z.string().max(HANDOFF_FIELD_MAX_CHARS).optional(),
  childTask: z.string().max(HANDOFF_FIELD_MAX_CHARS).optional(),
  completedPhases: z
    .array(z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS))
    .max(HANDOFF_COMPLETED_PHASES_MAX),
  lastCommitSubject: z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS).optional(),
  dirtyFiles: z
    .array(z.string().max(HANDOFF_IDENTITY_FIELD_MAX_CHARS))
    .max(HANDOFF_DIRTY_FILES_MAX),
});

export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;

export interface BuildHandoffInput {
  taskId: string;
  workflowType: string;
  branch: string;
  worktreePath: string;
  base?: string;
  forkPoint?: string;
  parentTaskId?: string;
  parentBranch?: string;
  parentSessionId?: string;
  parentWorktreePath?: string;
  parentSummary?: string;
  parentTask?: string;
  childTask?: string;
  completedPhases?: readonly string[];
  lastCommitSubject?: string;
  dirtyFiles?: readonly string[];
  /** Epoch-ms clock (test seam). Defaults to Date.now. */
  now?: number;
}

export interface CollectHandoffDefaultInput {
  /** The parent session's cwd (source of the git and workflow-state probes). */
  cwd: string;
  taskId: string;
  workflowType: string;
  branch: string;
  worktreePath: string;
  base?: string;
  forkPoint?: string;
  parentTaskId?: string;
  parentBranch?: string;
  parentSessionId?: string;
  parentWorktreePath?: string;
  /**
   * Explicit caller-supplied handoff text. It replaces only the free-text
   * summary; the mechanical facts below are always collected.
   */
  parentSummary?: string;
  /** The parent's session branch, narrowed to the transcript helper's shape. */
  transcript?: readonly TranscriptEntry[];
  deps?: HandoffDefaultDeps;
}

/**
 * Injectable seams for {@link collectHandoffDefault}. Production routes to the
 * real git/bd/fs helpers; tests supply canned output so no repository, CLI or
 * daemon is needed.
 */
export interface HandoffDefaultDeps {
  exec?: GitExec;
  /** `bd show <taskId>` text, or undefined when the lookup fails. */
  showTask?: (taskId: string) => Promise<string | undefined>;
  fs?: WorkflowFs;
  now?: () => number;
}

export interface OrchestratorPromptInput {
  taskId: string;
  workflowType: string;
  worktreePath: string;
  branch: string;
  phaseOrder: readonly string[];
  base?: string;
  forkPoint?: string;
  parentTaskId?: string;
  parentBranch?: string;
  parentSessionId?: string;
  parentWorktreePath?: string;
  handoff?: HandoffPacket;
}

const nodeFsSeam: WorkflowFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
  writeFileSync: (path, data, options) => nodeFs.writeFileSync(path, data, options),
  renameSync: (oldPath, newPath) => nodeFs.renameSync(oldPath, newPath),
  mkdirSync: (path, options) => nodeFs.mkdirSync(path, options),
  unlinkSync: (path) => nodeFs.unlinkSync(path),
};

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function nonEmptyList(values: readonly string[] | undefined, limit?: number): string[] {
  const list = (values ?? []).map((value) => value.trim()).filter((value) => value !== "");
  return limit === undefined ? list : list.slice(0, limit);
}

/**
 * Truncate on a code-point boundary.
 *
 * `String.prototype.slice` counts UTF-16 code units, so cutting at an arbitrary
 * index can split a surrogate pair and emit a lone surrogate (rendered as a
 * replacement character). Dropping a trailing high surrogate keeps the output
 * valid UTF-16.
 */
function truncateTextSafely(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastCodeUnit = sliced.charCodeAt(sliced.length - 1);
  const isHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
  return isHighSurrogate ? sliced.slice(0, -1) : sliced;
}

/** Cap an identity-style single-line field; never splits a surrogate pair. */
function capIdentityField(value: string | undefined): string | undefined {
  const text = optionalText(value);
  if (text === undefined) return undefined;
  return truncateTextSafely(text, HANDOFF_IDENTITY_FIELD_MAX_CHARS);
}

/**
 * Allocates the free-form budget across fields in declaration order, so the
 * parent's own summary survives before the (partly redundant) bead text does.
 */
function createContentBudget(totalMax: number): (value: string | undefined) => string | undefined {
  let remaining = totalMax;
  return (value) => {
    const text = optionalText(value);
    if (text === undefined) return undefined;
    const allowance = Math.min(HANDOFF_FIELD_MAX_CHARS, remaining);
    // Below the marker's own length there is no room for both content and the
    // marker; dropping the field keeps the packet under the total budget.
    if (allowance <= TRUNCATION_MARKER.length) return undefined;
    if (text.length <= allowance) {
      remaining -= text.length;
      return text;
    }
    const truncated = `${truncateTextSafely(text, allowance - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
    remaining -= truncated.length;
    return truncated;
  };
}

/**
 * Build a packet from already-gathered facts. Never throws: missing or blank
 * values are dropped, oversized values are capped.
 */
export function buildHandoff(input: BuildHandoffInput): HandoffPacket {
  const budget = createContentBudget(HANDOFF_TOTAL_MAX_CHARS);
  const base = capIdentityField(input.base);
  const forkPoint = capIdentityField(input.forkPoint);
  const parentTaskId = capIdentityField(input.parentTaskId);
  const parentBranch = capIdentityField(input.parentBranch);
  const parentSessionId = capIdentityField(input.parentSessionId);
  const parentWorktreePath = capIdentityField(input.parentWorktreePath);
  const parentSummary = budget(input.parentSummary);
  const parentTask = budget(input.parentTask);
  const childTask = budget(input.childTask);
  const lastCommitSubject = capIdentityField(input.lastCommitSubject);

  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    taskId: truncateTextSafely(input.taskId.trim(), HANDOFF_IDENTITY_FIELD_MAX_CHARS),
    workflowType: truncateTextSafely(input.workflowType.trim(), HANDOFF_IDENTITY_FIELD_MAX_CHARS),
    branch: truncateTextSafely(input.branch.trim(), HANDOFF_IDENTITY_FIELD_MAX_CHARS),
    worktreePath: truncateTextSafely(input.worktreePath.trim(), HANDOFF_IDENTITY_FIELD_MAX_CHARS),
    ...(base !== undefined ? { base } : {}),
    ...(forkPoint !== undefined ? { forkPoint } : {}),
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    ...(parentBranch !== undefined ? { parentBranch } : {}),
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(parentWorktreePath !== undefined ? { parentWorktreePath } : {}),
    createdAt: input.now ?? Date.now(),
    ...(parentSummary !== undefined ? { parentSummary } : {}),
    ...(parentTask !== undefined ? { parentTask } : {}),
    ...(childTask !== undefined ? { childTask } : {}),
    completedPhases: nonEmptyList(input.completedPhases, HANDOFF_COMPLETED_PHASES_MAX),
    ...(lastCommitSubject !== undefined ? { lastCommitSubject } : {}),
    dirtyFiles: nonEmptyList(input.dirtyFiles, HANDOFF_DIRTY_FILES_MAX),
  };
}

/** `.belayd/handoff.json` inside a worktree. */
export function handoffFilePath(cwd: string): string {
  return join(cwd, ".belayd", HANDOFF_FILE_NAME);
}

/**
 * Parse a handoff file's contents. Corrupt JSON, a wrong/absent schema version,
 * an oversized field, or an oversized free-form body all yield undefined —
 * callers treat that as "no handoff".
 */
export function parseHandoff(raw: unknown): HandoffPacket | undefined {
  const result = HandoffPacketSchema.safeParse(raw);
  if (!result.success) return undefined;
  // Per-field caps alone allow 3 x HANDOFF_FIELD_MAX_CHARS > total budget, so
  // the total is re-checked here rather than trusting the writer.
  const packet = result.data;
  const bodyLength =
    (packet.parentSummary?.length ?? 0) +
    (packet.parentTask?.length ?? 0) +
    (packet.childTask?.length ?? 0);
  if (bodyLength > HANDOFF_TOTAL_MAX_CHARS) return undefined;
  return packet;
}

/**
 * Read a `--handoff @path` file safely.
 *
 * The read is synchronous on the extension event loop, so the target must be a
 * regular file within {@link HANDOFF_ARG_FILE_MAX_BYTES}: a FIFO/character
 * device (`/dev/zero`) would block forever, and a huge file would OOM the
 * session. `stat`/`read` are injectable so the guard is unit-testable without
 * creating devices or giant files.
 */
export function readHandoffFileArg(input: {
  path: string;
  stat?: (path: string) => { isFile: boolean; size: number };
  read?: (path: string) => string;
}): { ok: true; text: string } | { ok: false; error: string } {
  const stat = input.stat ?? nodeStatProbe;
  const read = input.read ?? ((path: string) => nodeFs.readFileSync(path, "utf8"));

  let info: { isFile: boolean; size: number };
  try {
    info = stat(input.path);
  } catch (error) {
    return { ok: false, error: `Cannot read handoff file ${input.path}: ${errorMessage(error)}` };
  }
  if (!info.isFile) {
    return { ok: false, error: `Handoff path ${input.path} is not a regular file.` };
  }
  if (info.size > HANDOFF_ARG_FILE_MAX_BYTES) {
    return {
      ok: false,
      error: `Handoff file ${input.path} is ${info.size} bytes; the limit is ${HANDOFF_ARG_FILE_MAX_BYTES}.`,
    };
  }
  try {
    return { ok: true, text: read(input.path) };
  } catch (error) {
    return { ok: false, error: `Cannot read handoff file ${input.path}: ${errorMessage(error)}` };
  }
}

function nodeStatProbe(path: string): { isFile: boolean; size: number } {
  const stats = nodeFs.statSync(path);
  return { isFile: stats.isFile(), size: stats.size };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read a worktree's handoff packet, or undefined when absent/unreadable. */
export function readHandoff(options: { cwd: string; fs?: WorkflowFs }): HandoffPacket | undefined {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = handoffFilePath(options.cwd);
  if (!fs.existsSync(filePath)) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
  try {
    return parseHandoff(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Persist a handoff packet atomically; returns an error value instead of throwing. */
export function writeHandoff(options: {
  cwd: string;
  packet: HandoffPacket;
  fs?: WorkflowFs;
}): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  return atomicWriteJson(handoffFilePath(options.cwd), options.packet, fs);
}

/**
 * Remove a worktree's handoff packet. A missing file is success: teardown runs
 * on worktrees that never received one, and a stale packet must never outlive
 * the workflow it belongs to (otherwise the next workflow in the same worktree
 * re-injects another task's summary).
 */
export function clearHandoff(options: {
  cwd: string;
  fs?: WorkflowFs;
}): { ok: true } | { ok: false; error: string } {
  const fs = options.fs ?? nodeFsSeam;
  const filePath = handoffFilePath(options.cwd);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function joinDefined(values: readonly (string | undefined)[]): string {
  return values.filter((value) => value !== undefined && value !== "").join(", ");
}

/**
 * Render the packet as a markdown section. Pure: the clock is never read here,
 * so the same packet always formats identically.
 */
export function formatHandoffBlock(packet: HandoffPacket): string {
  const hasContent =
    packet.parentSummary !== undefined ||
    packet.parentTask !== undefined ||
    packet.childTask !== undefined ||
    packet.lastCommitSubject !== undefined ||
    packet.dirtyFiles.length > 0 ||
    packet.completedPhases.length > 0 ||
    packet.parentTaskId !== undefined;
  if (!hasContent) return "## Handoff\n\n(no handoff provided)";

  const identity: string[] = [
    `- Task: ${packet.taskId} (${packet.workflowType})`,
    `- Worktree: ${packet.worktreePath}`,
    `- Branch: ${packet.branch}`,
  ];
  if (packet.base !== undefined) {
    const forkPointText = packet.forkPoint !== undefined ? ` (fork point ${packet.forkPoint})` : "";
    identity.push(`- Base: ${packet.base}${forkPointText}`);
  }
  const parentRefs = joinDefined([
    packet.parentTaskId,
    packet.parentBranch !== undefined ? `branch ${packet.parentBranch}` : undefined,
    packet.parentSessionId !== undefined ? `session ${packet.parentSessionId}` : undefined,
    packet.parentWorktreePath,
  ]);
  if (parentRefs !== "") identity.push(`- Parent: ${parentRefs}`);
  if (packet.completedPhases.length > 0) {
    identity.push(`- Completed phases: ${packet.completedPhases.join(", ")}`);
  }
  if (packet.lastCommitSubject !== undefined) {
    identity.push(`- Last commit: ${packet.lastCommitSubject}`);
  }
  if (packet.dirtyFiles.length > 0) {
    identity.push(`- Uncommitted files: ${packet.dirtyFiles.join(", ")}`);
  }

  const content: string[] = [];
  if (packet.parentSummary !== undefined) {
    content.push("", "### Parent summary", "", packet.parentSummary);
  }
  if (packet.parentTask !== undefined) {
    const label = packet.parentTaskId ?? "parent";
    content.push("", `### Parent task (${label})`, "", packet.parentTask);
  }
  if (packet.childTask !== undefined) {
    content.push("", `### Child task (${packet.taskId})`, "", packet.childTask);
  }

  return ["## Handoff", "", ...identity, ...content].join("\n");
}

/**
 * Facts the identity/ownership blocks need, after packet fallbacks are
 * applied. Extracted so {@link buildOrchestratorPrompt} stays a linear
 * assembly of its parts.
 */
interface ResolvedPromptFacts {
  worktreePath: string;
  base: string | undefined;
  forkPoint: string | undefined;
  parentTaskId: string | undefined;
  parentBranch: string | undefined;
  parentSessionId: string | undefined;
  parentWorktreePath: string | undefined;
}

function resolvePromptFacts(input: OrchestratorPromptInput): ResolvedPromptFacts {
  // Parent identity normally lives on the packet the caller just built; the
  // explicit fields win so a caller can override a stale packet.
  return {
    worktreePath: input.worktreePath.trim(),
    base: optionalText(input.base) ?? optionalText(input.handoff?.base),
    forkPoint: optionalText(input.forkPoint) ?? optionalText(input.handoff?.forkPoint),
    parentTaskId: optionalText(input.parentTaskId) ?? optionalText(input.handoff?.parentTaskId),
    parentBranch: optionalText(input.parentBranch) ?? optionalText(input.handoff?.parentBranch),
    parentSessionId:
      optionalText(input.parentSessionId) ?? optionalText(input.handoff?.parentSessionId),
    parentWorktreePath:
      optionalText(input.parentWorktreePath) ?? optionalText(input.handoff?.parentWorktreePath),
  };
}

function formatPromptIdentity(
  input: OrchestratorPromptInput,
  facts: ResolvedPromptFacts,
): string[] {
  const identity: string[] = [`- Task: ${input.taskId} (${input.workflowType} workflow)`];
  if (facts.worktreePath !== "") identity.push(`- Worktree (absolute): ${facts.worktreePath}`);
  identity.push(`- Branch: ${input.branch}`);
  if (facts.base !== undefined) {
    const forkPointText = facts.forkPoint !== undefined ? ` (fork point ${facts.forkPoint})` : "";
    identity.push(`- Base branch: ${facts.base}${forkPointText}`);
  }
  const parentRefs = joinDefined([
    facts.parentTaskId,
    facts.parentBranch !== undefined ? `branch ${facts.parentBranch}` : undefined,
    facts.parentSessionId !== undefined ? `session ${facts.parentSessionId}` : undefined,
    facts.parentWorktreePath,
  ]);
  if (parentRefs !== "") identity.push(`- Parent: ${parentRefs}`);
  return identity;
}

function formatPromptOwnership(facts: ResolvedPromptFacts): string[] {
  const ownership =
    facts.worktreePath !== ""
      ? [`You own this worktree only (${facts.worktreePath}).`]
      : ["You own this worktree only."];
  ownership.push(
    facts.parentWorktreePath !== undefined
      ? `Do not edit, reset or copy files in ${facts.parentWorktreePath}.`
      : "Do not edit, reset or copy files in any other worktree.",
  );
  ownership.push(
    "If a change is needed in another branch, stop and report — you cannot drive another workflow.",
  );
  return ownership;
}

/**
 * Build the child orchestrator's first-turn prompt.
 *
 * The identity block tells the child exactly which worktree it owns (pi-web
 * session processes start with cwd `/`, so "the worktree" alone is ambiguous),
 * and the ownership rule prevents it from editing the parent's branch — a
 * spawned orchestrator cannot drive another workflow.
 */
export function buildOrchestratorPrompt(input: OrchestratorPromptInput): string {
  const facts = resolvePromptFacts(input);
  const handoffBlock =
    input.handoff !== undefined
      ? formatHandoffBlock(input.handoff)
      : "## Handoff\n\n(no handoff provided)";
  const phaseOrder = input.phaseOrder;

  return [
    `Start the Belayd ${input.workflowType} workflow for ${input.taskId}.`,
    "",
    "## Identity",
    ...formatPromptIdentity(input, facts),
    "",
    "## Ownership",
    ...formatPromptOwnership(facts),
    "",
    handoffBlock,
    "",
    `Follow the enforced phase order: ${phaseOrder.join(" → ")}.`,
    `Begin by calling \`belayd_${phaseOrder[0] ?? "commit"}\` to start.`,
  ].join("\n");
}

/**
 * Task id encoded in a workflow branch name (`feat/bd-121` → `bd-121`), or
 * undefined when the branch is not workflow-shaped (e.g. `main`).
 */
export function taskIdFromBranch(branch: string): string | undefined {
  const match = /(?:^|\/)(bd-\d+(?:\.\d+)?)$/.exec(branch.trim());
  return match?.[1];
}

function gitOutput(exec: GitExec, args: readonly string[], cwd: string): string | undefined {
  try {
    return exec(args, cwd);
  } catch {
    // A repo-less or detached cwd is a benign probe failure, not an error.
    return undefined;
  }
}

async function showTaskText(
  showTask: ((taskId: string) => Promise<string | undefined>) | undefined,
  taskId: string | undefined,
): Promise<string | undefined> {
  if (showTask === undefined || taskId === undefined) return undefined;
  try {
    return await showTask(taskId);
  } catch {
    return undefined;
  }
}

/**
 * Gather the mechanical handoff default from the parent session.
 *
 * Every probe is best-effort: a failing `git`, `bd` or workflow-state read
 * contributes an empty/undefined field instead of failing the launch.
 */
export async function collectHandoffDefault(
  input: CollectHandoffDefaultInput,
): Promise<HandoffPacket> {
  const deps = input.deps ?? {};
  const exec = deps.exec ?? defaultGitExec;

  const [parentTask, childTask] = await Promise.all([
    showTaskText(deps.showTask, input.parentTaskId),
    showTaskText(deps.showTask, input.taskId),
  ]);

  const persisted = readWorkflowState(
    deps.fs !== undefined ? { cwd: input.cwd, fs: deps.fs } : { cwd: input.cwd },
  );
  const lastCommitSubject = gitOutput(exec, ["log", "-1", "--pretty=%s"], input.cwd);
  const dirtyFiles = gitOutput(exec, ["status", "--porcelain"], input.cwd);

  return buildHandoff({
    taskId: input.taskId,
    workflowType: input.workflowType,
    branch: input.branch,
    worktreePath: input.worktreePath,
    base: input.base,
    forkPoint: input.forkPoint,
    parentTaskId: input.parentTaskId,
    parentBranch: input.parentBranch,
    parentSessionId: input.parentSessionId,
    parentWorktreePath: input.parentWorktreePath,
    parentSummary: input.parentSummary ?? lastAssistantText(input.transcript ?? []),
    parentTask,
    childTask,
    completedPhases: persisted?.completedPhaseNames ?? [],
    lastCommitSubject: lastCommitSubject?.trim(),
    dirtyFiles:
      dirtyFiles === undefined
        ? []
        : dirtyFiles
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
    now: deps.now !== undefined ? deps.now() : undefined,
  });
}
