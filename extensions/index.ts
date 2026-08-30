/**
 * Belayd agent harness — pi project-level extension.
 *
 * Auto-discovered by pi from `.pi/extensions/belayd-harness/index.ts`.
 *
 * Registers:
 * - `belayd_scout`, `belayd_plan`, etc. — tools that spawn specialized agents
 * - `belayd_start_task` — activates the process gate
 * - Process gate hooks — enforces phase order when active
 *
 * The process gate is **dormant by default**. Normal pi sessions are
 * unaffected. Only activates when `belayd_start_task` is called.
 */

import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  AgentDefinition,
  Phase,
  QualityGate,
  SpawnResult,
  WorkflowSubType,
} from "../src/index.js";
import {
  ALL_PHASE_NAMES,
  ALL_PHASE_TOOLS,
  checkToolAllowed,
  DEFAULT_AGENTS,
  formatProcessState,
  getNextPhase,
  getPhasesForType,
  getPhaseToolName,
  isInsideWorktreeForBranch,
  isValidTaskId,
  isValidWorkflowType,
  isWorkflowComplete,
  markPhaseCompleted,
  resolveQualityGate,
  resolveWorkflowType,
  setupWorktree,
  spawnAgentWithFallback,
  validateBdCommand,
  WORKFLOW_REGISTRY,
} from "../src/index.js";
import { createModelCooldownStore, defaultModelCooldownPath } from "../src/model-cooldown.js";
import { countUncommittedFiles } from "../src/session-conditions.js";
import {
  computeOrchestratorSessionName,
  computeSubagentSessionName,
  generateShortRunId,
} from "../src/session-naming.js";
import type { SpawnAttempt } from "../src/spawn-with-fallback.js";

// ── Process gate state ─────────────────────────────────────────────────
type SessionState = {
  gateActive: boolean;
  completedPhaseNames: string[];
  currentTaskId: string;
  fullTools: string[] | undefined;
  workflowType: WorkflowSubType;
  phaseOrder: string[];
  optionalPhases: readonly string[];
  userGuideContent?: string;
};

const sessionStates = new Map<string, SessionState>();

// Shared per-orchestrator model cooldown store: when a model hits a quota/rate
// limit, subsequent spawns in this session skip it until the cooldown lapses.
// Persisted to disk so cooldowns survive orchestrator restarts.
// Kill switch: BELAYD_MODEL_FALLBACK=0 disables candidate fallback entirely.
const modelCooldown = createModelCooldownStore({ filePath: defaultModelCooldownPath() });
const modelFallbackEnabled = process.env.BELAYD_MODEL_FALLBACK !== "0";

function getSessionState(ctx: { sessionManager: { getSessionId: () => string } }): SessionState {
  const id = ctx.sessionManager.getSessionId();
  let state = sessionStates.get(id);
  if (!state) {
    state = {
      gateActive: false,
      completedPhaseNames: [],
      currentTaskId: "",
      fullTools: undefined,
      workflowType: "feature",
      phaseOrder: getPhasesForType("feature"),
      optionalPhases: WORKFLOW_REGISTRY.feature.optionalPhases ?? [],
    };
    sessionStates.set(id, state);
  }
  return state;
}

// ── Extension factory ──────────────────────────────────────────────────

// This extension ships in two places that can load in the same process:
// globally at ~/.pi/agent/extensions/belayd-harness.ts (Nix-installed) and
// project-locally via .pi/settings.json → extensions/index.ts. When pi runs
// inside this repo or one of its worktrees, both load, and pi's post-load
// conflict detection reports every duplicate belayd_* tool as
// "Tool X conflicts with ...".
//
// Dedup keys on the extension load batch's shared event bus (via `pi.events`).
// Every extension in one `loadExtensions` call shares one bus; separate
// batches — the pi-web provider-bootstrap pass and each session — get their
// own. A claim on the bus therefore scopes to "this session":
// - CLI: only one copy loads anyway (bin/pi and the Nix pi both use -ne).
// - pi-web: the global and project copies in one session share a bus, so the
//   first copy wins and the second is a no-op; a later session has a fresh bus
//   and registers again.
//
// A process-wide boolean was tried and broke pi-web: the provider-bootstrap
// pass set it once, then every real session saw the stale flag and registered
// nothing. `pi.getAllTools()` / `pi.getCommands()` can't be used here either —
// they are "action methods" that throw "Extension runtime not initialized"
// until Runner.bindCore() runs after all extensions finish loading.
const CLAIM_CHANNEL = "__belayd_harness_claim__";

/**
 * True when another harness copy in this load batch already claimed
 * registration. The probe listener is left in place for the first copy so
 * later copies in the same batch count it and yield; the shared bus is
 * discarded with its session, so nothing leaks across sessions.
 */
function harnessAlreadyLoaded(pi: ExtensionAPI): boolean {
  // The counter travels through `emit` as the event payload, so every listener
  // — our own plus any earlier copy's — mutates the *same* object. A per-call
  // local would only see our own listener's increment and never detect a
  // prior copy.
  const counter = { responses: 0 };
  const respond = (data: unknown): void => {
    (data as { responses: number }).responses += 1;
  };
  // `emit` dispatches synchronously (the bus wraps handlers in async fns, but
  // the handler body up to its first `await` runs before `emit` returns).
  const unsubscribe = pi.events.on(CLAIM_CHANNEL, respond);
  pi.events.emit(CLAIM_CHANNEL, counter);

  const isFirstCopy = counter.responses <= 1;
  if (!isFirstCopy) {
    unsubscribe();
  }
  return !isFirstCopy;
}

// Build identity for the stale-build guard. In the Nix-installed copy this is
// file:///nix/store/<hash>-belayd-harness/extensions/index.ts, so the load log
// below reveals exactly which build registered the tools — the trap hit when
// pi-web kept a pre-fallback extension in memory after a rebuild.
const HARNESS_MODULE_PATH: string = import.meta.url;

export default function belaydAgentHarness(pi: ExtensionAPI): void {
  if (harnessAlreadyLoaded(pi)) return;

  console.warn(`[belayd-harness] registering tools/commands from ${HARNESS_MODULE_PATH}`);

  const GATED_TOOLS = [
    ...ALL_PHASE_TOOLS,
    "belayd_start_task",
    "belayd_stop_task",
    "bd",
    "read",
    "grep",
    "find",
    "ls",
  ];

  function enableGateTools(state: SessionState): void {
    if (state.fullTools === undefined) {
      state.fullTools = pi.getActiveTools();
    }
    pi.setActiveTools(GATED_TOOLS);
  }

  function restoreFullTools(state: SessionState): void {
    if (state.fullTools !== undefined) {
      pi.setActiveTools(state.fullTools);
      state.fullTools = undefined;
    }
  }

  function activateGate(
    ctx: { sessionManager: { getSessionId: () => string } },
    taskId: string,
    workflowType?: WorkflowSubType,
  ): SessionState {
    const state = getSessionState(ctx);
    state.gateActive = true;
    state.completedPhaseNames = [];
    state.currentTaskId = taskId;
    state.workflowType = workflowType ?? "feature";
    state.phaseOrder = getPhasesForType(state.workflowType);
    state.optionalPhases = WORKFLOW_REGISTRY[state.workflowType].optionalPhases ?? [];
    state.userGuideContent = undefined;
    enableGateTools(state);
    return state;
  }

  function sendWorkflowMessage(
    sender: { sendMessage: ExtensionAPI["sendMessage"] },
    taskId: string,
    branch: string | null,
    workflowType?: WorkflowSubType,
    phaseOrder?: readonly string[],
  ): void {
    const type = workflowType ?? "feature";
    const phases = phaseOrder ?? getPhasesForType(type);

    const phaseDescriptions: Record<string, string> = {
      scout: "Fast codebase recon — returns structured findings",
      plan: "Create implementation plan",
      implement: "Implements code (runs typecheck+lint+tests)",
      review: "Adversarial code review",
      test: "Run the test suite",
      userguide: "Generate user-facing How to Verify and How to Use docs",
      proof: "Capture verifiable proof",
      commit: "Commit changes",
    };

    const typeDescriptions: Record<string, string> = {
      feature: "This is a FEATURE task — new functionality.",
      bugfix: "This is a BUGFIX task — fixing a bug.",
      research: "This is a RESEARCH task — no code changes expected.",
      chore: "This is a CHORE task — tooling/config changes, no review needed.",
      documentation: "This is a DOCUMENTATION task — docs-only changes.",
      refactor: "This is a REFACTOR task — internal code changes, no behavioral change.",
      hotfix: "This is a HOTFIX task — urgent fix, minimal process.",
    };

    const lines: string[] = [
      `**Belayd ${type} workflow started for ${taskId}.**`,
      ...(branch ? [`Worktree: \`${branch}\``, ""] : []),
      "",
      typeDescriptions[type] ?? `Workflow type: ${type}.`,
      `Phases: ${phases.join(" → ")}`,
      "",
      "Editing and writing tools are DISABLED. You MUST delegate to phase tools:",
    ];

    phases.forEach((phase, i) => {
      lines.push(`${i + 1}. \`belayd_${phase}\` — ${phaseDescriptions[phase] ?? phase}`);
    });

    lines.push("", `Next required step: call \`belayd_${phases[0] ?? "commit"}\``);

    // Research workflows: the plan phase is the research agent — it records
    // findings as a bead note (not a .md file). Create follow-up tasks before
    // committing so they're included in the final commit.
    if (type === "research") {
      lines.push(
        "",
        "**Before `belayd_commit`:**",
        "- `belayd_plan` is the research agent. Pass it the task ID and the research question; it records findings as a bead note (never a research .md file).",
        '- Create follow-up implementation tasks with the `bd` tool (e.g. `bd create --title="..." --type=task`) for any action items uncovered.',
      );
    }

    lines.push("", "**After workflow completion:**");
    lines.push(
      `- Flag this task for human review (NEVER close it yourself): pass \`taskId\` to \`belayd_commit\`, or run \`bd update ${taskId} --status in_progress --add-label human\` with the \`bd\` tool.`,
    );

    sender.sendMessage(
      {
        customType: "belayd-command",
        content: lines.join("\n"),
        display: true,
      },
      { triggerTurn: true },
    );
  }

  const emptyUsage = () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  });

  /** Maximum number of agent passes over the quality gate (1 initial + retries). */
  const MAX_GATE_ATTEMPTS = 10;

  /** Append a quality-gate verdict to an agent result. */
  function withGateResult(result: SpawnResult, header: string, feedback: string): SpawnResult {
    const existingContent = result.content?.[0]?.text ?? "";
    return {
      content: [
        { type: "text" as const, text: `${existingContent}\n\n---\n${header}\n${feedback}` },
      ],
      details: result.details,
    };
  }

  /** Surface a model fallback (if any) as a trailing note on the agent result. */
  function withFallbackNote(result: SpawnResult, attempts: SpawnAttempt[]): SpawnResult {
    if (attempts.length <= 1) return result;
    const trail = attempts
      .map((a) => {
        if (a.skippedCooldown) return `${a.model} (cooldown)`;
        if (a.skippedProvider) return `${a.model} (provider ${a.skippedProvider} exhausted)`;
        return `${a.model} (${a.classification.kind})`;
      })
      .join(" → ");
    const existingContent = result.content?.[0]?.text ?? "";
    return {
      ...result,
      content: [
        { type: "text" as const, text: `${existingContent}\n\n[belayd model fallback] ${trail}` },
      ],
    };
  }

  /** Spawn a single fix-up attempt for a failed quality gate. */
  function spawnGateRetry(
    agent: AgentDefinition,
    feedback: string,
    options: {
      cwd?: string;
      signal?: AbortSignal;
      model?: string;
      tools?: string[];
      sessionName?: string;
      attempt: number;
    },
  ): Promise<SpawnResult> {
    return spawnAgentWithFallback({
      model: options.model ?? agent.model,
      tools: options.tools ?? agent.tools,
      systemPrompt: agent.systemPrompt,
      task: `Previous attempt failed quality gate:\n${feedback}\n\nFix the issues and retry.`,
      cwd: options.cwd,
      signal: options.signal,
      sessionName: options.sessionName
        ? `${options.sessionName}-retry-${options.attempt}`
        : undefined,
      cooldownStore: modelCooldown,
      enabled: modelFallbackEnabled,
    }).then((r) => r.result);
  }

  /** Run a quality gate over a result, normalizing the feedback text. */
  async function evaluateGate(
    gate: QualityGate,
    result: SpawnResult,
    cwd?: string,
  ): Promise<{ passed: boolean; feedback: string }> {
    const text = result.content?.[0]?.text ?? "";
    const outcome = await gate(text, result.details, cwd ? { cwd } : undefined);
    return {
      passed: outcome.passed,
      feedback: outcome.feedback ?? (outcome.passed ? "All quality gates passed." : "Failed"),
    };
  }

  async function runQualityGate(
    agent: AgentDefinition,
    result: SpawnResult,
    params: { task: string; cwd?: string },
    workflowType: WorkflowSubType,
    phaseName: string,
    signal?: AbortSignal,
    effectiveModel?: string,
    effectiveTools?: string[],
    sessionName?: string,
  ): Promise<SpawnResult | null> {
    if (!ALL_PHASE_NAMES.includes(phaseName)) return null;
    const effectiveGate = resolveQualityGate(phaseName as Phase, workflowType, agent.qualityGate);
    if (!effectiveGate) return null;

    let current = result;

    // Re-check the gate after every pass, retrying until MAX_GATE_ATTEMPTS
    // total passes are exhausted. Each retry gets a unique session suffix so
    // sessions never collide.
    for (let attempt = 1; attempt <= MAX_GATE_ATTEMPTS; attempt += 1) {
      const verdict = await evaluateGate(effectiveGate, current, params.cwd);

      if (verdict.passed) {
        return withGateResult(current, "✅ **Quality Gates**", verdict.feedback);
      }
      if (attempt === MAX_GATE_ATTEMPTS || (signal?.aborted ?? false)) {
        return withGateResult(
          current,
          `❌ **Quality Gates still failing after ${attempt - 1} retries**`,
          verdict.feedback,
        );
      }

      current = await spawnGateRetry(agent, verdict.feedback, {
        cwd: params.cwd,
        signal,
        model: effectiveModel,
        tools: effectiveTools,
        sessionName,
        attempt,
      });
    }

    return current;
  }

  // ── Belayd task state file ─────────────────────────────────────────
  // Written before spawning a new pi process in the worktree (TUI mode)
  // or before activating the gate in-place (RPC mode).
  // The session_start handler reads it to activate the gate.
  // Persists for the workflow duration so belayd_stop_task can restore
  // the original cwd.

  type BelaydTaskFile = {
    taskId: string;
    branch: string;
    originalCwd: string;
    workflowType?: string;
  };

  function belaydTaskFilePath(cwd: string): string {
    return join(cwd, ".belayd-task.json");
  }

  function writeBelaydTaskFile(cwd: string, data: BelaydTaskFile): void {
    mkdirSync(cwd, { recursive: true });
    writeFileSync(belaydTaskFilePath(cwd), JSON.stringify(data), "utf-8");
  }

  function readBelaydTaskFile(cwd: string): BelaydTaskFile | undefined {
    const p = belaydTaskFilePath(cwd);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as BelaydTaskFile;
    } catch {
      return undefined;
    }
  }

  function deleteBelaydTaskFile(cwd: string): void {
    try {
      unlinkSync(belaydTaskFilePath(cwd));
    } catch {
      // Gone already
    }
  }

  // ── Worktree creation helper ────────────────────────────────────────
  function ensureWorktree(projectRoot: string, branch: string): string | undefined {
    try {
      return isInsideWorktreeForBranch(projectRoot, branch)
        ? projectRoot
        : setupWorktree(projectRoot, { branch });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pi.sendMessage({
        customType: "belayd-error",
        content: `Worktree creation failed: ${message}`,
        display: true,
      });
      return undefined;
    }
  }

  // ── Task file helpers ─────────────────────────────────────────────────

  /** Title and labels resolved from a beads issue. */
  interface TaskMetadata {
    title?: string;
    labels?: string[];
  }

  /** Read title and labels from a beads issue via `bd show --json`. */
  function readTaskMetadata(taskId: string): Promise<TaskMetadata | undefined> {
    return new Promise((resolve) => {
      exec(
        `bd show ${taskId} --json`,
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          resolve(err ? undefined : parseTaskMetadata(stdout));
        },
      );
    });
  }

  /** Parse the output of `bd show --json` into task metadata. */
  function parseTaskMetadata(stdout: string): TaskMetadata | undefined {
    try {
      const parsed: unknown = JSON.parse(stdout);
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!item || typeof item !== "object") return undefined;
      const record = item as { title?: unknown; labels?: unknown };
      return {
        title: typeof record.title === "string" ? record.title : undefined,
        labels: Array.isArray(record.labels)
          ? record.labels.filter((l): l is string => typeof l === "string")
          : undefined,
      };
    } catch {
      return undefined;
    }
  }

  // ── Session daemon helpers ────────────────────────────────────────────

  /** Path to the pi-web session daemon Unix socket. */
  function sessiondSocketPath(): string {
    return process.env.PI_WEB_SESSIOND_SOCKET ?? join(homedir(), ".pi-web", "sessiond.sock");
  }

  /** Make an HTTP request to the session daemon via Unix socket. */
  function daemonRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: sessiondSocketPath(),
          method,
          path,
          headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            if (res.statusCode !== undefined && res.statusCode >= 400) {
              reject(errorFromResponse(data, res.statusCode));
            } else {
              resolve(responseBodyOrRaw(data));
            }
          });
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /** Build an Error from a non-2xx daemon response body. */
  function errorFromResponse(data: string, statusCode: number): Error {
    try {
      const parsed = JSON.parse(data) as { error?: string };
      return new Error(parsed.error ?? data);
    } catch {
      return new Error(data || `HTTP ${statusCode}`);
    }
  }

  /** Parse a daemon JSON body, falling back to the raw string. */
  function responseBodyOrRaw(data: string): Record<string, unknown> {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return data as unknown as Record<string, unknown>;
    }
  }

  /** Compact completed subagent sessions for a task. */
  async function compactTaskSessions(taskId: string, completedPhases: string[]): Promise<void> {
    for (const phase of completedPhases) {
      try {
        const sessions = (await daemonRequest("GET", "/sessions")) as {
          sessions?: Array<{ id: string; name?: string }>;
        };
        if (!sessions?.sessions) continue;

        const prefix = `belayd-${taskId}-sub-${phase}`;
        for (const session of sessions.sessions) {
          if (session.name?.startsWith(prefix)) {
            await daemonRequest("POST", `/sessions/${session.id}/compact`, {});
          }
        }
      } catch {
        // Daemon or endpoint not available — sessions remain uncompacted (acceptable for Phase 1)
      }
    }
  }

  /** Delegate a worktree workflow to the pi-web session daemon. */
  async function createOrchestratorSession(
    ctx: ExtensionCommandContext,
    taskId: string,
    workflowType: WorkflowSubType,
    branch: string,
    worktreePath: string,
  ): Promise<void> {
    const originalCwd = process.cwd();
    const phaseOrder = getPhasesForType(workflowType);
    const prompt = [
      `Start the Belayd ${workflowType} workflow for ${taskId}.`,
      `The worktree is \`${branch}\`.`,
      "",
      `Follow the enforced phase order: ${phaseOrder.join(" → ")}.`,
      `Begin by calling \`belayd_${phaseOrder[0] ?? "commit"}\` to start.`,
    ].join("\n");

    // Write task file so the new session's session_start handler activates the gate.
    writeBelaydTaskFile(worktreePath, {
      taskId,
      branch,
      originalCwd,
      workflowType,
    });

    // Delegate to pi-web session daemon for persistent session management.
    const orchestrationName = computeOrchestratorSessionName(taskId);

    // Try setting name at creation time
    const created = (await daemonRequest("POST", "/sessions", {
      cwd: worktreePath,
      name: orchestrationName,
    })) as { id?: string };

    if (!created.id) {
      ctx.ui.notify("Session daemon returned no session id.", "error");
      return;
    }

    // Best-effort rename via PATCH (wrapped in try/catch)
    try {
      await daemonRequest("PATCH", `/sessions/${created.id}`, {
        name: orchestrationName,
      });
    } catch {
      // Graceful fallback
    }

    // The session daemon's per-session routes scope every request by cwd, so
    // the prompt body must carry the worktree path alongside the prompt text.
    await daemonRequest("POST", `/sessions/${created.id}/prompt`, {
      cwd: worktreePath,
      text: prompt,
    });

    ctx.ui.notify(`Belayd ${workflowType} workflow started for ${taskId} (${branch}).`, "info");
  }

  // ── Slash command: /belayd bd-42 [type] ────────────────────────────
  pi.registerCommand("belayd", {
    description: "Start enforced Belayd workflow. Usage: /belayd bd-42 [type] [--no-worktree]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const taskId = parts[0] ?? "";

      // Filter out flags from type arg
      const noWorktree = parts.includes("--no-worktree");
      const typeArg = parts.slice(1).find((p) => p !== "--no-worktree");

      if (!taskId || !isValidTaskId(taskId)) {
        ctx.ui.notify(
          "Usage: /belayd bd-42 [type] [--no-worktree]\n" +
            "  taskId: beads issue or subtask ID (e.g. bd-42, bd-42.1)\n" +
            "  type: feature (default), bugfix, research, chore, documentation, refactor, hotfix\n" +
            "  --no-worktree: activate gate in the current directory, no worktree or daemon",
          "error",
        );
        return;
      }

      // Resolve workflow type from CLI argument, task labels, and title
      const metadata = await readTaskMetadata(taskId);
      const workflowType = resolveWorkflowType(typeArg, metadata?.labels, metadata?.title);

      if (typeArg && !isValidWorkflowType(typeArg)) {
        ctx.ui.notify(
          `Unknown workflow type: "${typeArg}".\nValid types: feature, bugfix, research, chore, documentation, refactor, hotfix\nFalling back to "${workflowType}".`,
          "warning",
        );
      }

      // --no-worktree mode: activate gate in-place, no isolation
      if (noWorktree) {
        activateGate(ctx, taskId, workflowType);
        ctx.ui.notify(
          `Belayd ${workflowType} workflow started for ${taskId} (no worktree).`,
          "info",
        );
        sendWorkflowMessage(pi, taskId, null, workflowType);
        return;
      }

      const branch = `feat/${taskId}`;
      const worktreePath = ensureWorktree(ctx.cwd, branch);

      if (!worktreePath) {
        ctx.ui.notify(
          "Worktree creation failed. Use --no-worktree to skip isolation, or check that wt is installed.",
          "error",
        );
        return;
      }

      await createOrchestratorSession(ctx, taskId, workflowType, branch, worktreePath);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const state = getSessionState(ctx);
    state.gateActive = false;
    state.completedPhaseNames = [];
    state.currentTaskId = "";
    restoreFullTools(state);

    // Sub-agents have "-sub-" in their session name (set by computeSubagentSessionName).
    // Only the orchestrator session should activate the gate; sub-agents get their
    // tool restrictions from their agent definition's tools allowlist, not the gate.
    const sessionName = ctx.sessionManager.getSessionName();
    const isSubAgent = sessionName?.includes("-sub-");

    // Read the task file (written by /belayd). Only activate the gate for
    // the orchestrator session — sub-agent sessions skip this.
    const taskFile =
      ctx.sessionManager.getSessionFile() && !isSubAgent ? readBelaydTaskFile(ctx.cwd) : undefined;
    if (taskFile) {
      state.gateActive = true;
      state.currentTaskId = taskFile.taskId;
      state.workflowType = taskFile.workflowType
        ? (taskFile.workflowType as WorkflowSubType)
        : "feature";
      state.phaseOrder = getPhasesForType(state.workflowType);
      state.optionalPhases = WORKFLOW_REGISTRY[state.workflowType].optionalPhases ?? [];
      enableGateTools(state);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    sessionStates.delete(id);
  });

  // ── Inject workflow context when gate is active ────────────────────
  pi.on("before_agent_start", async (_event, ctx) => {
    const state = getSessionState(ctx);
    if (!state.gateActive) return;

    const remaining = getNextPhase(state.completedPhaseNames, state.phaseOrder) ?? "commit";
    const phaseOrder = state.phaseOrder;
    const workflowType = state.workflowType;

    const phaseDescriptions: Record<string, string> = {
      scout: "investigate the codebase",
      plan: "create implementation plan",
      implement: "implement code (runs typecheck+lint+tests automatically)",
      review: "adversarial code review",
      test: "run the test suite",
      userguide: "Generate user-facing How to Verify and How to Use docs",
      proof: "capture verifiable proof",
      commit: "commit changes",
    };

    const phaseLines = phaseOrder.map((p) => `- \`belayd_${p}\` — ${phaseDescriptions[p] ?? p}`);

    return {
      message: {
        customType: "belayd-gate-context",
        content: [
          "[BELAYD WORKFLOW ACTIVE]",
          `Task: ${state.currentTaskId} (${workflowType})`,
          `Progress: ${formatProcessState(state.completedPhaseNames, state.currentTaskId, phaseOrder)}`,
          "",
          `Phases: ${phaseOrder.join(" → ")}`,
          "",
          "Editing and writing tools are DISABLED. You MUST delegate ALL code changes to the phase tools:",
          ...phaseLines,
          "",
          "Task tracking: the `bd` tool is available for beads commands (create, update, label, note, show, search, list, ready, etc.).",
          "",
          `Next required step: call \`${getPhaseToolName(remaining)}\``,
        ].join("\n"),
        display: false,
      },
    };
  });

  /** Capture the userguide output so the commit tool can append it to notes. */
  function captureUserGuideContent(
    phaseName: string,
    result: SpawnResult,
    state: SessionState,
  ): void {
    if (phaseName !== "userguide") return;
    const content = result.content[0]?.text ?? "";
    if (content) state.userGuideContent = content;
  }

  /** Build the failure result returned when a phase agent cannot be spawned. */
  function agentFailureResult(err: unknown): SpawnResult {
    const message = err instanceof Error ? err.message : "Agent process failed";
    return {
      content: [{ type: "text" as const, text: message }],
      details: { messages: [], usage: emptyUsage(), exitCode: 1 },
    };
  }

  // ── Map agent tool names to phase names ────────────────────────────
  const AGENT_TO_PHASE: Record<string, string> = {
    "belayd-planner": "plan",
    "belayd-implementer": "implement",
    "belayd-reviewer": "review",
    "belayd-tester": "test",
    "belayd-userguide": "userguide",
    "belayd-proof-generator": "proof",
    "belayd-committer": "commit",
  };

  // ── Register agent tools ────────────────────────────────────────────
  for (const agent of DEFAULT_AGENTS) {
    if (agent.name === "belayd-committer") continue;
    const phaseName = AGENT_TO_PHASE[agent.name] ?? agent.name.replace("belayd-", "");
    const toolName = getPhaseToolName(phaseName);
    pi.registerTool({
      name: toolName,
      label: agent.description,
      description: agent.description,
      parameters: Type.Object({
        task: Type.String({ description: "Task to delegate to this agent" }),
        cwd: Type.Optional(Type.String({ description: "Working directory" })),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        try {
          const state = getSessionState(ctx);
          const effectiveCwd = params.cwd ?? (ctx as { cwd?: string })?.cwd;
          const overrides =
            WORKFLOW_REGISTRY[state.workflowType].agentOverrides?.[phaseName as Phase];
          const effectiveModel = overrides?.model ?? agent.model;
          const effectiveTools = overrides?.tools ?? agent.tools;
          const effectiveSystemPrompt = overrides?.systemPrompt ?? agent.systemPrompt;
          const subagentSessionName = computeSubagentSessionName(
            state.currentTaskId,
            phaseName,
            generateShortRunId(),
          );
          const { result, attempts } = await spawnAgentWithFallback({
            model: effectiveModel,
            tools: effectiveTools,
            systemPrompt: effectiveSystemPrompt,
            task: params.task,
            sessionName: subagentSessionName,
            cwd: effectiveCwd,
            signal,
            cooldownStore: modelCooldown,
            enabled: modelFallbackEnabled,
          });
          const spawnedResult = withFallbackNote(result, attempts);

          const gateResult = await runQualityGate(
            agent,
            spawnedResult,
            { task: params.task, cwd: effectiveCwd },
            state.workflowType,
            phaseName,
            signal,
            effectiveModel,
            effectiveTools,
            subagentSessionName,
          );
          // Use the retried result if available, otherwise use the original result
          const finalResult = gateResult ?? spawnedResult;
          captureUserGuideContent(phaseName, finalResult, state);

          return finalResult;
        } catch (err) {
          return agentFailureResult(err);
        }
      },
    });
  }

  // ── Register bd (beads) tool ─────────────────────────────────────────
  // The gate disables bash so editing tools can't be abused, but task
  // tracking still needs the bd CLI. This tool proxies bd through a safe
  // subcommand allowlist so the orchestrator can manage beads without raw
  // shell access. It is included in GATED_TOOLS, so it stays available while
  // the gate is active.
  pi.registerTool({
    name: "bd",
    label: "Beads task tracker",
    description:
      "Run a beads (bd) CLI command for task tracking. Restricted to safe " +
      "subcommands (create, update, label, note, show, search, list, ready, " +
      "prime, remember, and similar). Cannot close, delete, or edit issues.",
    parameters: Type.Object({
      command: Type.String({
        description:
          'Full bd command including subcommand and flags, e.g. "create --title=\\"Fix login\\" --type=bug" or "list --status=open"',
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validation = validateBdCommand(params.command);
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: validation.error }],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }

      const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
      const execAsync = promisify(exec);
      try {
        const { stdout, stderr } = await execAsync(`bd ${params.command}`, {
          cwd,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        const text = stdout.trim() || stderr.trim() || "(no output)";
        return {
          content: [{ type: "text" as const, text }],
          details: {
            messages: [],
            usage: emptyUsage(),
            exitCode: 0,
            ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `bd command failed: ${message}` }],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }
    },
  });

  // ── Register start-task tool ────────────────────────────────────────
  pi.registerTool({
    name: "belayd_start_task",
    label: "Start Belayd Task",
    description:
      "Activate enforced Belayd process. Accepts optional workflow type (feature, bugfix, research, chore, documentation, refactor, hotfix).",
    parameters: Type.Object({
      taskId: Type.String({ description: "Beads issue ID, e.g. bd-42" }),
      workflowType: Type.Optional(
        Type.String({
          description:
            "Workflow sub-type: feature (default), bugfix, research, chore, documentation, refactor, hotfix",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const metadata = await readTaskMetadata(params.taskId);
      const workflowType = resolveWorkflowType(
        params.workflowType,
        metadata?.labels,
        metadata?.title,
      );
      const state = activateGate(ctx, params.taskId, workflowType);
      return {
        content: [
          {
            type: "text" as const,
            text: `${workflowType} process started for ${params.taskId}.\n\n${formatProcessState([], params.taskId, state.phaseOrder)}`,
          },
        ],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 0,
        },
      };
    },
  });

  // ── Register stop-task tool ─────────────────────────────────────────
  pi.registerTool({
    name: "belayd_stop_task",
    label: "Stop Belayd Task",
    description: "Deactivate the enforced Belayd process for the current task.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getSessionState(ctx);

      // Restore original cwd if we're in a worktree
      const taskFile = readBelaydTaskFile(ctx.cwd);
      if (taskFile) {
        process.chdir(taskFile.originalCwd);
        deleteBelaydTaskFile(ctx.cwd);
      }

      state.gateActive = false;
      state.completedPhaseNames = [];
      state.workflowType = "feature";
      state.phaseOrder = getPhasesForType("feature");
      state.optionalPhases = WORKFLOW_REGISTRY.feature.optionalPhases ?? [];
      state.userGuideContent = undefined;
      restoreFullTools(state);
      return {
        content: [
          {
            type: "text" as const,
            text: "Belayd process deactivated.",
          },
        ],
        details: {
          messages: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          exitCode: 0,
        },
      };
    },
  });

  // ── Helpers for commit tool ─────────────────────────────────────────
  async function _stageChanges(
    execAsync: (cmd: string, opts: object) => Promise<{ stdout: string; stderr: string }>,
    cwd: string,
    files?: string[],
  ): Promise<string | null> {
    try {
      const paths = (files ?? []).filter((file) => file.length > 0);
      if (paths.length === 0) {
        await execAsync("git add -A", { cwd, timeout: 30_000 });
      } else {
        // `--` keeps leading-dash paths literal; quote each path for spaces.
        const quoted = paths.map((file) => `"${file.replace(/"/g, '\\"')}"`).join(" ");
        await execAsync(`git add -- ${quoted}`, { cwd, timeout: 30_000 });
      }
      return null;
    } catch (err) {
      return `Failed to stage changes: ${err instanceof Error ? err.message : err}`;
    }
  }

  async function _runCommit(
    execAsync: (cmd: string, opts: object) => Promise<{ stdout: string; stderr: string }>,
    message: string,
    cwd: string,
  ): Promise<{ hash: string; output: string } | string> {
    try {
      const escaped = message.replace(/"/g, '\\"');
      const { stdout, stderr } = await execAsync(`git commit -m "${escaped}"`, {
        cwd,
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = stdout || stderr;
      const hashMatch = output.match(/\[([a-f0-9]+)\]/);
      return { hash: hashMatch?.[1] ?? "unknown", output };
    } catch (err) {
      return err instanceof Error ? err.message : "Commit failed";
    }
  }

  async function _flagForHumanReview(
    execAsync: (cmd: string, opts: object) => Promise<{ stdout: string; stderr: string }>,
    taskId: string,
    cwd: string,
  ): Promise<string | null> {
    try {
      // The `human` label surfaces the bead in Bead Me Up, Scotty's "Needs You"
      // inbox; `in_progress` keeps it out of `bd ready` until the human merges.
      await execAsync(`bd update ${taskId} --status in_progress --add-label human`, {
        cwd,
        timeout: 15_000,
      });
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
  async function flagForHumanReview(
    execAsync: (cmd: string, opts: object) => Promise<{ stdout: string; stderr: string }>,
    taskId: string,
    cwd: string,
  ): Promise<void> {
    const updateError = await _flagForHumanReview(execAsync, taskId, cwd);
    if (updateError) {
      pi.sendMessage(
        { customType: "belayd-warning", content: updateError, display: true },
        { triggerTurn: false },
      );
    }
  }

  /** Append user-guide content to a task's notes; best-effort and non-blocking. */
  async function appendUserGuideNote(
    execAsync: (cmd: string, opts: object) => Promise<{ stdout: string; stderr: string }>,
    taskId: string,
    content: string,
    cwd: string,
  ): Promise<void> {
    const notesFile = join(tmpdir(), `belayd-userguide-${taskId}.md`);
    writeFileSync(notesFile, content, "utf-8");
    try {
      await execAsync(`bd note ${taskId} --file "${notesFile}"`, {
        cwd,
        timeout: 15_000,
      });
    } catch {
      // Best-effort: don't block commit on note append failure
    } finally {
      removeFileQuietly(notesFile);
    }
  }

  /** Unlink a file, ignoring any failure (used for temp-note cleanup). */
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

  // ── Register commit tool ────────────────────────────────────────────
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const execAsync = promisify(exec);
      const cwd = ctx?.cwd ?? process.cwd();

      // Flag the issue for human review (agents never close — human closes on wt merge).
      // Done before staging so the JSONL export (export.auto + git-add) is committed.
      if (params.taskId) {
        await flagForHumanReview(execAsync, params.taskId, cwd);
      }

      // Append user guide content to task notes if available
      const state = getSessionState(ctx);
      if (params.taskId && state.userGuideContent && state.phaseOrder.includes("userguide")) {
        await appendUserGuideNote(execAsync, params.taskId, state.userGuideContent, cwd);
      }

      const stageError = await _stageChanges(execAsync, cwd, params.files);
      if (stageError) {
        return commitFailure(stageError);
      }

      const fullMessage = params.body ? `${params.message}\n\n${params.body}` : params.message;

      const commitResult = await _runCommit(execAsync, fullMessage, cwd);
      if (typeof commitResult === "string") {
        const feedback = await extractCommitFeedback(commitResult, ctx);
        return commitFailure(feedback, commitResult);
      }

      return {
        content: [{ type: "text" as const, text: `Committed as ${commitResult.hash}` }],
        details: { messages: [], usage: emptyUsage(), exitCode: 0 },
      };
    },
  });

  // ── Process gate: block out-of-sequence tool calls ──────────────────
  pi.on("tool_call", (event, ctx) => {
    const state = getSessionState(ctx);
    if (!state.gateActive) return {};

    const toolName = event.toolName;
    const check = checkToolAllowed(
      toolName,
      state.completedPhaseNames,
      state.gateActive,
      state.phaseOrder,
      state.workflowType,
      state.optionalPhases,
    );
    if (!check.allowed) {
      if (
        typeof (event as unknown as { abort?: (code: string, reason: string) => void }).abort ===
        "function"
      ) {
        (event as unknown as { abort: (code: string, reason: string) => void }).abort(
          "phase-order-blocked",
          check.reason ?? "Phase order violation",
        );
      }
      return { block: true, reason: check.reason };
    }

    // Check if the tool is a phase tool in the current workflow's phase order
    const toolBase = toolName.startsWith("belayd_") ? toolName.slice(7) : "";
    if (state.phaseOrder.includes(toolBase)) {
      state.completedPhaseNames = markPhaseCompleted(
        toolName,
        state.completedPhaseNames,
        state.phaseOrder,
      );
    }

    return {};
  });

  // ── Uncommitted-files notification ────────────────────────────────
  pi.on("agent_end", async (_event, ctx) => {
    const count = await countUncommittedFiles(ctx.cwd);
    if (count !== null && count > 0) {
      const label = count === 1 ? "file" : "files";
      ctx.ui.notify(`${count} uncommitted ${label}`, "warning");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getSessionState(ctx);
    if (!state.gateActive) return;
    if (isWorkflowComplete(state.completedPhaseNames, state.phaseOrder)) {
      const currentPhaseOrder = [...state.phaseOrder];
      const currentTaskId = state.currentTaskId;
      const currentCompleted = [...state.completedPhaseNames];

      // Compact completed phase sessions before resetting state
      await compactTaskSessions(currentTaskId, currentCompleted);

      state.gateActive = false;
      state.completedPhaseNames = [];
      state.workflowType = "feature";
      state.phaseOrder = getPhasesForType("feature");
      state.optionalPhases = WORKFLOW_REGISTRY.feature.optionalPhases ?? [];
      state.userGuideContent = undefined;
      restoreFullTools(state);
      pi.sendMessage(
        {
          customType: "process-complete",
          content: formatProcessState(currentCompleted, currentTaskId, currentPhaseOrder),
          display: true,
        },
        { triggerTurn: false },
      );
    }
  });
}
