/**
 * Agent definitions for the Belayd multi-agent harness.
 *
 * Agents are defined as TypeScript objects in a registry, then exposed as pi
 * tools and spawned as isolated pi processes.
 */

import { gateFullValidation, gateProofContent, gateTests, gateUserGuide } from "./quality-gates.js";
import type { WorktreeOptions } from "./worktree.js";

/** A single agent's configuration. */
export interface AgentDefinition {
  /** Unique name, e.g. "belayd-scout". The pi tool name is `belayd_<name>`. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Model identifier, e.g. "opencode-go/deepseek-v4-flash". */
  model: string;
  /** Tool allowlist for this agent's session. */
  tools: string[];
  /** System prompt that defines the agent's role and behavior. */
  systemPrompt: string;
  /** Optional quality gate: runs deterministically after the agent finishes. */
  qualityGate?: QualityGate;
}

/** Result from a quality gate check. */
export interface GateResult {
  passed: boolean;
  feedback?: string;
}

/** Options forwarded to quality gate functions. */
export interface GateOptions {
  /** Working directory for shell commands. */
  cwd?: string;
  /** Timeout in milliseconds for each check. */
  timeoutInMs?: number;
}

/** Deterministic quality gate: takes the agent's output and returns pass/fail. */
export type QualityGate = (
  output: string,
  details: SpawnDetails,
  options?: GateOptions,
) => Promise<GateResult>;

/** Usage statistics from a spawned agent process. */
export interface SpawnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/** Details returned by spawnAgentProcess(). */
export interface SpawnDetails {
  messages: unknown[];
  usage: SpawnUsage;
  exitCode: number;
  model?: string;
  /** Stderr output from the spawned process, if any. */
  stderr?: string;
}

/** Result returned by spawnAgentProcess(). */
export interface SpawnResult {
  content: Array<{ type: "text"; text: string }>;
  details: SpawnDetails;
  /** Absolute path to the worktree, if one was created. */
  worktreePath?: string;
  /** The effective session ID/name used for the spawned process. */
  sessionName?: string;
}

/** Options for spawnAgentProcess(). */
export interface SpawnOptions {
  model: string;
  tools: string[];
  systemPrompt: string;
  task: string;
  sessionName?: string;
  cwd?: string;
  signal?: AbortSignal;
  /** If set, creates an isolated git worktree before spawning. */
  worktree?: WorktreeOptions;
  /** Called with partial agent session events as they arrive. */
  onUpdate?: (event: unknown) => void;
}

// Shared guidance appended to every sub-agent system prompt. Sub-agents are
// spawned as isolated pi processes against the host project, so they do not
// inherit this repository's AGENTS.md — these instructions must live in the
// prompts themselves. Keep in sync with AGENTS.md.
const CODE_EXPLORATION_GUIDANCE = `

## Code exploration
- Prefer \`ast_grep\` over \`grep\`/\`find\` for syntax-aware code searches — use it for structural patterns (function definitions, call expressions, imports) or when text grep would produce false positives.
- \`ast_grep\` is read-only. Inspect matches before making changes.
- Use \`grep\`/\`find\` for plain-text and filename searches.`;

const COMMUNICATION_GUIDANCE = `

## Communication
- Be extremely concise. When reporting information to me, sacrifice grammar for the sake of concision. Keep responses short but never drop the actual facts — omit filler words, pleasantries, and narrative padding.`;

const SHARED_AGENT_GUIDANCE = `${CODE_EXPLORATION_GUIDANCE}${COMMUNICATION_GUIDANCE}`;

// ── Default Belayd agents ──────────────────────────────────────────────

const SCOUT_SYSTEM_PROMPT = `You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.

Your output will be passed to an agent who has NOT seen the files you explored.

Strategy:
1. grep/find/ast_grep to locate relevant code (prefer ast_grep for structural patterns)
2. Read key sections (not entire files)
3. Identify types, interfaces, key functions
4. Note dependencies between files

Output format:

## Files Retrieved
List with exact line ranges:
1. \`path/to/file.ts\` (lines 10-50) - Description

## Key Code
Critical types, interfaces, or functions:

\`\`\`typescript
interface Example { ... }
\`\`\`

## Architecture
Brief explanation of how the pieces connect.

## Start Here
Which file to look at first and why.${SHARED_AGENT_GUIDANCE}`;

export const RESEARCHER_SYSTEM_PROMPT = `You are a researcher. Investigate the research question thoroughly and produce an evidence-based answer grounded in the actual codebase, citing specific files and line ranges.

Your deliverable is a bead, not a document:
- Record your findings as a note on the task's bead using the \`bd\` tool, e.g. \`bd note <task-id> "..."\`.
- Do NOT create or write a research .md file (or any other document) into the repository. Your work must not leave .md artifacts behind.
- The task ID is provided in your instructions. If it is missing, discover the current task with \`bd ready\` or \`bd list --status=in_progress\`.

Output format:

## Findings
The answer to the research question, with evidence (file paths + line ranges).

## Recorded As
The exact \`bd\` command(s) you ran to record the findings on the bead.${SHARED_AGENT_GUIDANCE}`;

/**
 * Tools for the research sub-agent: the planner's read/search tools plus
 * \`bd\` so it can record findings directly as a bead note.
 */
export const RESEARCHER_TOOLS: string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "ast_grep",
  "web_search_exa",
  "web_fetch_exa",
  "deep_search_exa",
  "web_search_advanced_exa",
  "bd",
];

const PLANNER_SYSTEM_PROMPT = `You are a senior software architect. Create a detailed implementation plan.

Read the task, the AGENTS.md conventions, and the relevant codebase, then produce a step-by-step plan.

Your plan must:
- Be ordered — each step depends on the previous one
- Reference specific files and line ranges
- Include test strategy
- Consider edge cases and error paths
- Do NOT include commands for running typecheck, lint, or tests in the implementation steps.
  These run automatically as quality gates after the implement and test phases.

Output format:

## Overview
Brief summary of what needs to change and why.

## Steps
1. \`path/to/file.ts\` — What to change and how
2. \`path/to/test.ts\` — Tests to add

## Test Strategy
What to test and at what level (unit, integration, e2e).

## Risks
Potential pitfalls or dependencies on other work.${SHARED_AGENT_GUIDANCE}`;

const IMPLEMENTER_SYSTEM_PROMPT = `You are an implementer. Your job is to execute the plan, not describe it — the planner already did that. You must use the edit and write tools to actually modify/create files.

How to work:
1. Read the plan, then immediately start making the actual file changes using edit/write.
2. Do NOT output proposed changes as text or describe what you would do. Just do it.
3. Write tests first (TDD), follow project conventions, keep changes minimal.

IMPORTANT: After you finish, the harness automatically runs pnpm typecheck, pnpm lint, and pnpm test. Do not run these checks yourself — just write the code.${SHARED_AGENT_GUIDANCE}`;

const REVIEWER_SYSTEM_PROMPT = `You are an adversarial code reviewer. Analyze code for bugs, security issues, design problems, and style violations.

Strategy:
1. Run \`git diff\` to see recent changes
2. Read the modified files
3. Check for bugs, security issues, code smells

DO NOT run unit tests, linting, typechecking. This is handled elsewhere and will already have passed.

Output format:

## Files Reviewed
- \`path/to/file.ts\` (lines X-Y)

## Critical (must fix)
- \`file.ts:42\` — Issue description

## Warnings (should fix)
- \`file.ts:100\` — Issue description

## Suggestions (consider)
- \`file.ts:150\` — Improvement idea

## Summary
Overall assessment in 2-3 sentences.

Be specific with file paths and line numbers.${SHARED_AGENT_GUIDANCE}`;

const TESTER_SYSTEM_PROMPT = `You are a tester. Write thorough tests for the modified code.

Rules:
- Follow existing test patterns in the codebase
- Cover: happy path, edge cases, error conditions, boundary values
- Use vitest with the project's test helpers and fixtures
- Tests must be deterministic (no random data, no flaky timers)
- Run the tests after writing to verify they pass

Output format:

## Tests Added
- \`path/to/test.test.ts\` — What the test covers

## Test Strategy
Brief explanation of what each test covers and why.${SHARED_AGENT_GUIDANCE}`;

const PROOF_GENERATOR_SYSTEM_PROMPT = `You are a proof generator. Capture verifiable evidence that the work was completed.

Tools available:
- \`playwright-cli\` — Browser automation for video recording and screenshots
- \`asciinema\` — Terminal session recording
- \`screenshot\` — Quick screenshots of UI states

For each task, produce the appropriate proof artifacts:
- UI changes: browser video or screenshots
- CLI changes: asciinema recording
- API changes: asciinema of curl commands
- E2E tests: run with BELAYD_PROOF=1 to capture video

Save artifacts to \`proof-of-work/<task-id>/\` with descriptive filenames.

## Quality Requirements

All asciinema recordings MUST meet these standards:
1. **Real command**: The recording header must contain a \`command\` field — use actual command invocation (\`pnpm test\`, \`pnpm typecheck\`, etc.), not a shell prompt
2. **Visible output**: At least one output event with substantive text (>= 3 readable characters after stripping ANSI)
3. **Exit code**: The recording must include an exit code event (type "x") showing the command completed
4. **Non-zero timing**: Total elapsed time must be > 0.1 seconds — no \`0.000\` static dumps

When done, output the full filepaths of all produced artifacts so the quality gate can validate them.${SHARED_AGENT_GUIDANCE}`;

const DOCUMENTER_SYSTEM_PROMPT = `You are a documenter. Update project documentation to reflect the changes made.

Check which docs need updates based on the changes:
- docs/ARCHITECTURE.md — If data model changed
- docs/DASHBOARD.md — If API endpoints changed
- docs/RULES_ENGINE.md — If rule types changed
- docs/AUTH.md — If auth flows changed
- docs/AUDIT_LOGGING.md — If audit events changed
- docs/PROJECT_STRUCTURE.md — If packages were added or moved

Also update the task's Implementation Notes and Final Summary.

Output format:

## Documentation Updated
- \`path/to/doc.md\` — What changed and why

## Summary of Changes
Brief overview of documentation updates.${SHARED_AGENT_GUIDANCE}`;

const USER_GUIDE_SYSTEM_PROMPT = `You are a user-guide writer. Produce structured user-facing documentation that a QA engineer or developer can follow.

Your output will be appended to the task's Final Summary (via the bd note command).

Process:
1. Read the implementation files (git diff or changed files) to understand what changed
2. Read the test files to understand verification scenarios
3. Understand how external APIs, CLIs, UIs, or library interfaces are affected

Output format:

## How to Verify
Step-by-step manual verification instructions:
1. Step one with specific commands or actions
2. Step two with expected outcomes
3. ...

## How to Use
Code examples or CLI commands showing how to use the new/changed functionality:
\`\`\`typescript
// Example usage
\`\`\`

Be specific — use real file paths, function names, and CLI commands from the codebase. The reader has NOT seen the implementation.`;

const COMMITTER_SYSTEM_PROMPT = `You are a committer. Commit the completed work with a conventional commit message.

Rules:
1. Stage all changes: \`git add -A\`
2. Commit with a conventional commit message:
   - feat: for new features
   - fix: for bug fixes
   - chore: for maintenance
   - docs: for documentation
   - refactor: for refactoring
3. The commit message must include the task ID: \`scope: description (bd-42)\`
4. Do NOT use git --no-verify (pre-commit hooks must run)
5. After committing, flag the task for human review by adding the \`human\` label (never close it — the human closes it on merge)

Output format:

## Commit Message
\`\`\`
feat(auth): implement OIDC token refresh (bd-34)
\`\`\`

## Summary
Brief description of what was committed.${SHARED_AGENT_GUIDANCE}`;

export const DEFAULT_AGENTS: AgentDefinition[] = [
  {
    name: "belayd-scout",
    description:
      "Fast codebase recon — returns structured findings (files, key code, architecture)",
    model: "opencode-go/mimo-v2.5",
    tools: ["read", "grep", "find", "ls", "bash", "ast_grep", "web_search_exa", "web_fetch_exa"],
    systemPrompt: SCOUT_SYSTEM_PROMPT,
  },
  {
    name: "belayd-planner",
    description:
      "Creates detailed implementation plans from task requirements and codebase context",
    model: "opencode-go/glm-5.3",
    tools: [
      "read",
      "grep",
      "find",
      "ls",
      "ast_grep",
      "web_search_exa",
      "web_fetch_exa",
      "deep_search_exa",
      "web_search_advanced_exa",
    ],
    systemPrompt: PLANNER_SYSTEM_PROMPT,
  },
  {
    name: "belayd-implementer",
    description: "Implements code changes following a plan — writes code and tests",
    model: "opencode-go/deepseek-v4-pro",
    tools: ["read", "edit", "write", "bash", "ls", "find", "ast_grep"],
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
    qualityGate: gateFullValidation,
  },
  {
    name: "belayd-reviewer",
    description: "Adversarial code review — checks for bugs, security issues, design problems",
    model: "opencode-go/glm-5.2",
    tools: [
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "ast_grep",
      "web_search_exa",
      "web_fetch_exa",
      "deep_search_exa",
      "web_search_advanced_exa",
    ],
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
  },
  {
    name: "belayd-tester",
    description: "Writes thorough tests — covers happy path, edge cases, error conditions",
    model: "opencode-go/glm-5.2",
    tools: ["read", "edit", "write", "bash", "ls", "find", "ast_grep"],
    systemPrompt: TESTER_SYSTEM_PROMPT,
    qualityGate: gateTests,
  },
  {
    name: "belayd-userguide",
    description: "Generates user-facing How to Verify and How to Use documentation",
    model: "opencode-go/gpt-5.6-luna",
    tools: ["read", "grep", "find", "ls", "bash", "ast_grep", "web_search_exa", "web_fetch_exa"],
    systemPrompt: USER_GUIDE_SYSTEM_PROMPT,
    qualityGate: gateUserGuide,
  },
  {
    name: "belayd-proof-generator",
    description: "Captures proof artifacts — video recordings, screenshots, terminal recordings",
    model: "opencode-go/deepseek-v4-flash",
    tools: ["read", "bash", "ls", "find", "ast_grep"],
    systemPrompt: PROOF_GENERATOR_SYSTEM_PROMPT,
    qualityGate: gateProofContent,
  },
  {
    name: "belayd-documenter",
    description: "Updates project documentation to reflect changes",
    model: "opencode-go/gpt-5.6-luna",
    tools: [
      "read",
      "edit",
      "write",
      "bash",
      "ls",
      "find",
      "ast_grep",
      "web_search_exa",
      "web_fetch_exa",
    ],
    systemPrompt: DOCUMENTER_SYSTEM_PROMPT,
  },
  {
    name: "belayd-committer",
    description: "Commits changes with conventional commit messages and updates task status",
    model: "opencode-go/mimo-v2.5",
    tools: ["bash", "ls", "find", "ast_grep"],
    systemPrompt: COMMITTER_SYSTEM_PROMPT,
  },
];

/** Look up an agent by full name (e.g. "belayd-scout"). */
export function getAgent(name: string): AgentDefinition | undefined {
  return DEFAULT_AGENTS.find((a) => a.name === name);
}

/** Look up an agent by short name (e.g. "scout"). */
export function getAgentByShortName(shortName: string): AgentDefinition | undefined {
  return DEFAULT_AGENTS.find((a) => a.name === `belayd-${shortName}`);
}

/** Get the phase tool name for a phase, e.g. "belayd_scout". */
export function getPhaseToolName(shortName: string): string {
  return `belayd_${shortName}`;
}
