import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type PhaseCommentAuthor, phaseCommentBody } from "../../src/bead-comments.js";
import { orchestratorActor, withActorArgv } from "../../src/beads-actor.js";
import {
  assertOwnedWorktree,
  isSameOrDescendantTask,
  readWorktreeBranch,
} from "../../src/owned-worktree.js";
import { userGuideDocPath } from "../../src/quality-gates.js";
import { RunStatus, setRunStatus, writeRunManifest } from "../../src/run-manifest.js";
import { scanOutboundText, secretRefusalText, warnScanUnavailable } from "../../src/secret-scan.js";
import {
  computeSubagentSessionName,
  generateShortRunId,
  isValidTaskId,
} from "../../src/session-naming.js";
import {
  currentBranch,
  DEFAULT_BASE_BRANCH,
  defaultGitExec,
  readStackNode,
  resolveAutoRebaseEnabled,
  resolveStackChain,
  runStackRebase,
  type StackNode,
} from "../../src/stack-rebase.js";
import { readWorkflowState } from "../../src/workflow-state.js";
import {
  COMMIT_PHASE,
  type CoreSessionState,
  emptyUsage,
  missingWorkingDirectoryError,
  REVIEW_PHASE,
  runBdCommand,
  runGitCommand,
  textToolResult,
} from "./context.js";
import { nextAwaitingReviewResponse } from "./review.js";

/**
 * Composer-supplied seams.
 *
 * `markPhaseCompleted` is a process-gate primitive: capability modules may not
 * import `src/process-gate.ts`, so the composer injects it. `persistCompletedPhases`
 * and `getSessionState` stay in the composer because they own the session state.
 */
export interface CommitDeps {
  getSessionState: (ctx: { sessionManager: { getSessionId: () => string } }) => CoreSessionState;
  markPhaseCompleted: (
    toolName: string,
    completed: string[],
    phaseOrder?: readonly string[],
  ) => string[];
  persistCompletedPhases: (options: {
    cwd: string;
    completedPhaseNames: string[];
    awaitingReviewResponse: boolean;
  }) => void;
  /** Surface a non-blocking warning in the session transcript. */
  sendMessage: ExtensionAPI["sendMessage"];
}

export function isStackAlreadyOnMain(chain: readonly StackNode[], forceLanded: boolean): boolean {
  if (chain.length === 0) return true;
  if (forceLanded || chain.length !== 1) return false;
  const only = chain[0];
  return only !== undefined && only.base === DEFAULT_BASE_BRANCH && only.landedParent === undefined;
}

/** Register `belayd_stack_rebase`; the composer supplies the pi API. */
export function registerStackRebaseTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "belayd_stack_rebase",
    label: "Rebase stacked workflow",
    description:
      "Replay the current stacked branch onto its base after the base has landed, using " +
      "`git rebase --onto` so the base's commits are not replayed. Pass `baseLanded: true` " +
      "when the immediate parent landed but its branch ref still exists (squash-merge case).",
    parameters: Type.Object({
      baseLanded: Type.Optional(
        Type.Boolean({
          description:
            "Explicit confirmation that the immediate parent has landed; forces the branch onto main even if the parent ref still exists.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const branch = currentBranch(cwd);
      if (branch === undefined) {
        return textToolResult(
          "Cannot determine the current branch (detached HEAD?); nothing to rebase.",
          1,
        );
      }

      const forceLanded = params.baseLanded === true;
      const resolved = resolveStackChain(cwd, branch);
      if (!resolved.ok) {
        return textToolResult(`Stack resolution failed: ${resolved.error}`, 1);
      }
      if (isStackAlreadyOnMain(resolved.chain, forceLanded)) {
        return textToolResult(
          `${branch} is already based on ${DEFAULT_BASE_BRANCH}; nothing to rebase.`,
          0,
        );
      }

      const result = runStackRebase(defaultGitExec, {
        cwd,
        leaf: branch,
        stash: true,
        forceLanded,
      });
      if (!result.ok) {
        return textToolResult(
          formatStackRebaseFailure({
            result,
            fallbackBranch: branch,
            fallbackCwd: cwd,
            retryCommand: "belayd_stack_rebase",
          }),
          1,
        );
      }

      if (result.rebased.length === 0) {
        const reasons = result.skipped
          .map((skip) => `  - ${skip.branch}: ${skip.reason}`)
          .join("\n");
        return textToolResult(
          `${branch} is already up to date with its base; nothing to rebase.${reasons === "" ? "" : `\n${reasons}`}`,
          0,
        );
      }

      const lines = [
        `Rebased ${result.rebased.length} branch(es) stepwise onto their bases:`,
        ...result.rebased.map((name) => `  - ${name}`),
      ];
      return textToolResult(lines.join("\n"), 0);
    },
  });
}

/**
 * Recovery note for a pre-rebase `git stash` entry, which is deliberately left
 * in place on any conflict so uncommitted work is never lost. The two kinds
 * differ: an interrupted rebase still needs the stash reapplied, while a
 * failed `git stash pop` already applied its changes (with conflicts) and only
 * needs the stale entry dropped.
 */
function stashRecoveryNote(result: { stashed?: boolean; stashPopConflicted?: boolean }): string {
  if (result.stashed !== true) return "";
  if (result.stashPopConflicted === true) {
    return (
      "\n\nA `git stash` entry created before this rebase is still present. The rebase " +
      "itself succeeded but restoring the stash conflicted; resolve those conflicts, then run " +
      "`git stash drop` (the changes are already in the worktree)."
    );
  }
  return (
    "\n\nYour uncommitted changes were stashed before this rebase and the stash entry is " +
    "still present; run `git stash pop` after the rebase conflict is resolved to restore them."
  );
}

/**
 * Render a failed stack-rebase result as actionable text. Conflicts include
 * the branch's worktree and the continue/abort/retry steps so the agent (or
 * human) can recover without guessing where the rebase stopped.
 */
function formatStackRebaseFailure(options: {
  result: {
    error: string;
    branch?: string;
    worktree?: string;
    conflicts?: boolean;
    stashed?: boolean;
    stashPopConflicted?: boolean;
  };
  fallbackBranch: string;
  fallbackCwd: string;
  retryCommand: string;
}): string {
  const branch = options.result.branch ?? options.fallbackBranch;
  if (options.result.conflicts !== true) {
    return `Stack rebase failed for ${branch}: ${options.result.error}`;
  }
  const location = options.result.worktree ?? options.fallbackCwd;
  return (
    `Stack rebase failed for ${branch}: ${options.result.error}\n\n` +
    `Resolve the conflicts in ${location}, then run \`git rebase --continue\` ` +
    `(or \`git rebase --abort\` to back out), and re-run \`${options.retryCommand}\`.` +
    stashRecoveryNote(options.result)
  );
}

/**
 * Rebase a stacked branch before committing when its base has landed.
 *
 * The landed signal is authoritative only when explicit (`rebaseStack`) or
 * corroborated by a recorded parent that is gone; ambiguous cases are left
 * untouched so a wrong guess never rewrites history. Toggle off with
 * `BELAYD_STACK_AUTO_REBASE` or `git config belayd.stack.autoRebase false`.
 */
async function maybeAutoRebaseBeforeCommit(options: {
  cwd: string;
  force: boolean;
}): Promise<{ ok: true; rebased: string[] } | { ok: false; error: string }> {
  const branch = currentBranch(options.cwd);
  if (branch === undefined || readStackNode(options.cwd, branch) === undefined) {
    return { ok: true, rebased: [] };
  }

  const resolved = resolveStackChain(options.cwd, branch);
  if (!resolved.ok) return { ok: false, error: `Stack resolution failed: ${resolved.error}` };
  const hasLandedParent = resolved.chain.some((node) => node.landedParent !== undefined);
  if (!options.force && !hasLandedParent) return { ok: true, rebased: [] };
  if (!resolveAutoRebaseEnabled(options.cwd)) return { ok: true, rebased: [] };

  const result = runStackRebase(defaultGitExec, {
    cwd: options.cwd,
    leaf: branch,
    stash: true,
    forceLanded: options.force,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: formatStackRebaseFailure({
        result,
        fallbackBranch: branch,
        fallbackCwd: options.cwd,
        retryCommand: "belayd_commit",
      }),
    };
  }
  return { ok: true, rebased: result.rebased };
}

async function _stageChanges(cwd: string, files?: string[]): Promise<string | null> {
  try {
    const paths = (files ?? []).filter((file) => file.length > 0);
    // `--` keeps leading-dash paths literal.
    const argv = paths.length > 0 ? ["add", "--", ...paths] : ["add", "-A"];
    await runGitCommand(argv, { cwd, timeoutInMs: 30_000, maxBufferInBytes: 1024 * 1024 });
    return null;
  } catch (err) {
    return `Failed to stage changes: ${err instanceof Error ? err.message : err}`;
  }
}

/**
 * Read the new commit's short hash.
 *
 * `rev-parse` is authoritative; the regex fallback covers a git too old (or
 * a hook that swallows stdout) to be trusted. Never throws — an unknown hash
 * is cosmetic and must not fail an otherwise successful commit.
 */
async function resolveCommitHash(cwd: string, output: string): Promise<string> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--short", "HEAD"], {
      cwd,
      timeoutInMs: 15_000,
      maxBufferInBytes: 1024 * 1024,
    });
    const hash = stdout.trim();
    if (hash.length > 0) return hash;
  } catch {
    // fall through to parsing the commit output
  }
  // Covers git's `[<branch> <hash>]` summary line; the branch may contain
  // spaces in git's abbreviated form, so anchor on the last token.
  const match = output.match(/\[[^\]]*?\s([0-9a-f]{7,})\]/);
  return match?.[1] ?? "unknown";
}

async function _runCommit(
  message: string,
  cwd: string,
): Promise<{ hash: string; output: string } | string> {
  // `randomUUID` (not a timestamp) keeps two commits in the same process and
  // millisecond from sharing a file and clobbering each other's message.
  const messageFile = join(tmpdir(), `belayd-commit-msg-${process.pid}-${randomUUID()}.txt`);
  try {
    // `-F` avoids both shell interpolation and argv length limits. Unlike an
    // editor-driven message, git defaults `-F` to cleanup=whitespace, so a
    // leading `#` line survives instead of being stripped as a comment — but
    // only when the message is non-empty after cleanup; an all-`#`/whitespace
    // message strips to empty and git aborts (exit 1), surfacing as a raw git
    // error through the catch below. That failure path is acceptable.
    writeFileSync(messageFile, message, "utf-8");
    const { stdout, stderr } = await runGitCommand(["commit", "-F", messageFile], {
      cwd,
      timeoutInMs: 300_000,
      maxBufferInBytes: 10 * 1024 * 1024,
    });
    const output = stdout || stderr;
    return { hash: await resolveCommitHash(cwd, output), output };
  } catch (err) {
    return err instanceof Error ? err.message : "Commit failed";
  } finally {
    removeFileQuietly(messageFile);
  }
}

async function _flagForHumanReview(taskId: string, cwd: string): Promise<string | null> {
  try {
    // The `human` label surfaces the bead in Bead Me Up, Scotty's "Needs You"
    // inbox; `in_progress` keeps it out of `bd ready` until the human merges.
    // Flags precede `--` so the taskId is parsed as a positional even if it
    // starts with `-`; pflag stops flag parsing at the separator. Attributed
    // to the workflow's orchestrator (bd-150): this is a lifecycle write made
    // for the workflow, not the operator's own bd edit.
    await runBdCommand(
      withActorArgv(
        ["update", "--status", "in_progress", "--add-label", "human", "--", taskId],
        orchestratorActor(taskId),
      ),
      {
        cwd,
        stdin: undefined,
        timeoutInMs: 15_000,
        maxBufferInBytes: 1024 * 1024,
      },
    );
    return null;
  } catch (err) {
    return `Failed to flag beads issue for human review: ${err instanceof Error ? err.message : err}`;
  }
}

async function extractCommitFeedback(
  rawOutput: string,
  ctx: ExtensionContext | undefined,
): Promise<string> {
  if (!ctx?.modelRegistry || !ctx?.model) return rawOutput;
  try {
    const response = await ctx.modelRegistry.complete(ctx.model, {
      systemPrompt:
        "You are a commit-failure analyzer. Given the raw output of a failed `git commit` " +
        "(which includes lefthook pre-commit hook output with lint, typecheck, and test results), " +
        "extract ONLY the actionable failure messages. Focus on: actual errors, test failures, " +
        "lint violations, type errors. Ignore progress bars, cache messages, summary lines. " +
        "Return a concise bullet list of what needs to be fixed.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: rawOutput }],
          timestamp: Date.now(),
        },
      ],
    });
    const extracted = response.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return extracted.trim() || rawOutput;
  } catch {
    return rawOutput;
  }
}

/** Flag a beads issue for human review, surfacing any failure as a warning. */
async function flagForHumanReview(taskId: string, cwd: string, deps: CommitDeps): Promise<void> {
  const updateError = await _flagForHumanReview(taskId, cwd);
  if (updateError) {
    deps.sendMessage(
      { customType: "belayd-warning", content: updateError, display: true },
      { triggerTurn: false },
    );
  }
}

/**
 * Append a phase-deliverable comment to a task; best-effort and non-blocking.
 *
 * Deliverables go to the comment thread (authored + timestamped + ordered)
 * rather than the notes blob, which is reserved for the plan that later phase
 * prompts read back.
 *
 * The body is scanned first (bd-286): a comment that carries a credential is
 * dropped with a warning naming the rule, never with the match. Best-effort like
 * the append itself — the commit must not fail over a scan. The session is the
 * warn-once budget for a scanner that cannot run.
 */
async function appendTaskComment(options: {
  taskId: string;
  phase: PhaseCommentAuthor;
  content: string;
  cwd: string;
  state: CoreSessionState;
}): Promise<void> {
  const body = phaseCommentBody(options.phase, options.content);
  const scan = await scanOutboundText({ text: body, cwd: options.cwd });
  if (!scan.ok && "rules" in scan) {
    console.warn(
      `[belayd-harness] dropped the ${options.phase} comment: ${secretRefusalText(scan.rules)}`,
    );
    return;
  }
  if (!scan.ok) warnScanUnavailable({ budget: options.state, reason: scan.unavailable });
  try {
    // Piping via `--stdin` keeps the body out of argv and avoids a temp file
    // that could leak if the process dies mid-append.
    await runBdCommand(["comment", "--stdin", "--", options.taskId], {
      cwd: options.cwd,
      stdin: body,
      timeoutInMs: 15_000,
      maxBufferInBytes: 1024 * 1024,
    });
  } catch {
    // Best-effort: don't block commit on comment append failure
  }
}

/** Unlink a file, ignoring any failure (used for temp-message cleanup). */
function removeFileQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // cleanup failed, file will be removed eventually
  }
}

/** Build the failure result returned when commit fails. */
function commitFailure(text: string, stderr?: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      messages: [],
      usage: emptyUsage(),
      exitCode: 1,
      ...(stderr !== undefined ? { stderr } : {}),
    },
  };
}

/** Record the commit phase's "running" manifest, returning whether the gate owns the run. */
function startCommitRunManifest(options: {
  state: CoreSessionState;
  cwd: string;
  runId: string;
}): boolean {
  if (!options.state.gateActive || options.state.currentTaskId === "") return false;
  const writeResult = writeRunManifest({
    cwd: options.cwd,
    manifest: {
      schemaVersion: 1,
      runId: options.runId,
      taskId: options.state.currentTaskId,
      phase: "commit",
      sessionName: computeSubagentSessionName(options.state.currentTaskId, "commit", options.runId),
      status: RunStatus.Running,
      startedAt: Date.now(),
    },
  });
  if (!writeResult.ok) {
    console.warn(`[belayd-harness] failed to persist commit run manifest: ${writeResult.error}`);
  }
  return true;
}

/** Mark the commit run finished and, on success, persist the completed phases. */
function finalizeCommitRun(
  options: {
    state: CoreSessionState;
    cwd: string;
    runId: string;
    status: RunStatus.Completed | RunStatus.Failed;
    gateCommit: boolean;
  },
  deps: CommitDeps,
): void {
  if (!options.gateCommit) return;
  markCommitRunStatus({
    cwd: options.cwd,
    runId: options.runId,
    status: options.status,
  });
  if (options.status === RunStatus.Completed) {
    // Commit is no longer marked at tool_call time (phase runs are
    // non-blocking), so record it here for the agent_end workflow-complete
    // check to fire.
    options.state.completedPhaseNames = deps.markPhaseCompleted(
      "belayd_commit",
      options.state.completedPhaseNames,
      options.state.phaseOrder,
    );
    // Commit is the last phase; completing it disarms the resumable-fix loop.
    options.state.awaitingReviewResponse = nextAwaitingReviewResponse({
      awaiting: options.state.awaitingReviewResponse,
      completedPhaseName: COMMIT_PHASE,
      phaseOrder: options.state.phaseOrder,
      reviewCompleted: options.state.completedPhaseNames.includes(REVIEW_PHASE),
    });
    deps.persistCompletedPhases({
      cwd: options.cwd,
      completedPhaseNames: options.state.completedPhaseNames,
      awaitingReviewResponse: options.state.awaitingReviewResponse,
    });
  }
}

/** Mark a commit phase run's manifest status (best-effort). */
function markCommitRunStatus(options: {
  cwd: string;
  runId: string;
  status: RunStatus.Completed | RunStatus.Failed;
}): void {
  const statusResult = setRunStatus({
    cwd: options.cwd,
    runId: options.runId,
    status: options.status,
    exitCode: options.status === RunStatus.Completed ? 0 : 1,
  });
  if (!statusResult.ok) {
    console.warn(`[belayd-harness] failed to update commit run manifest: ${statusResult.error}`);
  }
}

/** Append userguide + proof-verifier deliverable comments (best-effort). */
async function appendPhaseDeliverables(
  taskId: string,
  state: CoreSessionState,
  cwd: string,
): Promise<void> {
  if (state.userGuideContent && state.phaseOrder.includes("userguide")) {
    await appendTaskComment({
      taskId,
      phase: "userguide",
      content: userGuideCommentBody({
        cwd,
        taskId,
        report: state.userGuideContent,
      }),
      cwd,
      state,
    });
  }
  if (state.proofVerifierVerdict) {
    await appendTaskComment({
      taskId,
      phase: "proof-verifier",
      content: state.proofVerifierVerdict,
      cwd,
      state,
    });
  }
}

/**
 * Bead comment body for the userguide phase: a stable pointer to the committed
 * guide plus the agent's own report. The pointer is emitted on its own line so
 * the thread names the record even when the report is only a summary, and it
 * is omitted when no file was written rather than claiming one that is absent.
 */
function userGuideCommentBody(options: { cwd: string; taskId: string; report: string }): string {
  const docPath = userGuideDocPath(options.taskId);
  const wroteFile = existsSync(resolve(options.cwd, docPath));
  const pointer = wroteFile
    ? `## User guide\n\n\`${docPath}\` — How to Verify and How to Use.\n\n`
    : "## User guide\n\n(no guide file found in the worktree — see the report below)\n\n";
  return `${pointer}${options.report}`;
}

/** Tool failure result for an invalid commit task id. */
function invalidCommitTaskIdText(taskId: string): string {
  return `Invalid task id: ${taskId}. Expected a beads id like "bd-42" or "bd-42.1" (letters/digits after "bd-", dot-separated segments).`;
}

/** Flag a task for human review and record its deliverables, when a task id was given. */
async function maybeFlagTaskForHumanReview(
  taskId: string | undefined,
  state: CoreSessionState,
  cwd: string,
  deps: CommitDeps,
): Promise<void> {
  if (taskId === undefined) return;
  await flagForHumanReview(taskId, cwd, deps);
  await appendPhaseDeliverables(taskId, state, cwd);
}

/**
 * Error text when this cwd does not own the commit's task/branch. A repo with
 * no workflow state has no identity contract to violate, so standalone
 * commits still stage normally there.
 */
function commitOwnershipError(options: {
  cwd: string;
  state: CoreSessionState;
  taskId: string | undefined;
}): string | undefined {
  const persisted = readWorkflowState({ cwd: options.cwd });
  if (persisted === undefined) return undefined;

  const sessionTaskId = options.state.currentTaskId;
  const taskId = options.taskId ?? sessionTaskId;
  // A session may commit its own task or a sub-bead of it (bd-42.1), never an
  // unrelated bead or a parent from a sub-bead session.
  if (sessionTaskId !== "" && !isSameOrDescendantTask(taskId, sessionTaskId)) {
    return (
      `this session owns ${sessionTaskId}; refusing to commit ${taskId} in ${options.cwd} — ` +
      `use the orchestrator that owns ${taskId}'s worktree.`
    );
  }

  // Anchor the cwd preflight on the workflow row's task. A supplied sub-bead
  // resolves to its owning parent; an unrelated id still fails the matcher.
  const ownershipTaskId =
    taskId === "" || isSameOrDescendantTask(taskId, persisted.taskId) ? persisted.taskId : taskId;
  const owned = assertOwnedWorktree({
    cwd: options.cwd,
    taskId: ownershipTaskId,
    branch: readWorktreeBranch(options.cwd),
    readState: () => persisted,
  });
  return owned.ok ? undefined : owned.error;
}

/** Validate the commit invocation before any run manifest or staging starts. */
function commitPreflight(options: {
  cwd: string | undefined;
  taskId: string | undefined;
  state: CoreSessionState;
}): { ok: true; cwd: string } | { ok: false; error: string } {
  if (options.taskId !== undefined && !isValidTaskId(options.taskId)) {
    return { ok: false, error: invalidCommitTaskIdText(options.taskId) };
  }
  const cwd = options.cwd;
  if (cwd === undefined || cwd === "") {
    return { ok: false, error: missingWorkingDirectoryError("belayd_commit") };
  }
  const ownershipError = commitOwnershipError({
    cwd,
    state: options.state,
    taskId: options.taskId,
  });
  return ownershipError === undefined ? { ok: true, cwd } : { ok: false, error: ownershipError };
}

/** Register `belayd_commit`; the composer supplies the pi API and session reader. */
export function registerCommitTool(pi: ExtensionAPI, deps: CommitDeps): void {
  pi.registerTool({
    name: "belayd_commit",
    label: "Commit changes",
    description:
      "Stage changes and commit with a conventional commit message. " +
      "Stage only the given files when provided; otherwise stage everything. " +
      "On failure, extracts actionable feedback using a cheap model.",
    parameters: Type.Object({
      message: Type.String({
        description: "Conventional commit subject line, e.g. 'feat(auth): add OIDC flow (bd-42)'",
      }),
      body: Type.Optional(
        Type.String({ description: "Extended commit body with details (optional)" }),
      ),
      files: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description:
            "File paths to stage specifically. Omit or pass an empty array to stage all changes.",
        }),
      ),
      taskId: Type.Optional(
        Type.String({ description: "Beads issue ID to flag for human review (e.g. bd-42)" }),
      ),
      rebaseStack: Type.Optional(
        Type.Boolean({
          description:
            "Force a stack rebase before committing (confirm the parent landed). Also controlled by BELAYD_STACK_AUTO_REBASE / git config belayd.stack.autoRebase.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = deps.getSessionState(ctx);
      const preflight = commitPreflight({ cwd: ctx?.cwd, taskId: params.taskId, state });
      if (!preflight.ok) return commitFailure(preflight.error);
      const cwd = preflight.cwd;
      const runId = generateShortRunId();
      const gateCommit = startCommitRunManifest({ state, cwd, runId });

      // Rebase before staging so the commit lands on the landed base. Abort on
      // failure: committing a half-rebased tree would produce a broken history.
      const rebase = await maybeAutoRebaseBeforeCommit({
        cwd,
        force: params.rebaseStack === true,
      });
      if (!rebase.ok) {
        finalizeCommitRun({ state, cwd, runId, gateCommit, status: RunStatus.Failed }, deps);
        return commitFailure(rebase.error);
      }
      const rebasedBranches = rebase.rebased;

      // Flag the issue for human review (agents never close — human closes on wt merge).
      // Done before staging so the JSONL export (export.auto + git-add) is committed.
      await maybeFlagTaskForHumanReview(params.taskId, state, cwd, deps);

      const stageError = await _stageChanges(cwd, params.files);
      if (stageError) {
        finalizeCommitRun({ state, cwd, runId, gateCommit, status: RunStatus.Failed }, deps);
        return commitFailure(stageError);
      }

      const fullMessage = params.body ? `${params.message}\n\n${params.body}` : params.message;

      const commitResult = await _runCommit(fullMessage, cwd);
      if (typeof commitResult === "string") {
        finalizeCommitRun({ state, cwd, runId, gateCommit, status: RunStatus.Failed }, deps);
        const feedback = await extractCommitFeedback(commitResult, ctx);
        return commitFailure(feedback, commitResult);
      }

      finalizeCommitRun({ state, cwd, runId, gateCommit, status: RunStatus.Completed }, deps);

      const rebaseNote =
        rebasedBranches.length > 0
          ? `\nRebased stacked branch(es): ${rebasedBranches.join(", ")}`
          : "";
      return {
        content: [
          { type: "text" as const, text: `Committed as ${commitResult.hash}${rebaseNote}` },
        ],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });
}
