# Subagent Observability — Session Inspection and Debugging

**Task:** TASK-2  
**Status:** Investigation Complete  
**Date:** 2026-08-11  

---

## Table of Contents

1. [AC Mapping](#ac-mapping)
2. [Current State Audit](#1-current-state-audit)
3. [Pi Session JSONL Format &amp; Replay Capabilities](#2-pi-session-jsonl-format--replay-capabilities)
4. [Capture Options](#3-capture-options)
5. [Pi-Web Session Daemon API](#4-pi-web-session-daemon-api)
6. [Piolium Visibility Patterns](#5-piolium-visibility-patterns-preliminary--package-not-available)
7. [Lightweight Approach: Named Sessions + Manifest Catalog](#6-lightweight-approach-named-sessions--manifest-catalog)
8. [Dashboard Approach: Pi-Web Subsession Plugin](#7-dashboard-approach-pi-web-subsession-plugin)
9. [Recommendation](#8-recommendation)
10. [Follow-Up Implementation Tasks](#9-follow-up-implementation-tasks)

---

## AC Mapping

This section maps the task's Acceptance Criteria to the document sections that address each one.

| AC | Description | Covered In |
|---|---|---|
| #1 | Investigate what session artifacts spawnAgentProcess() produces | [§1.1](#11-what-spawnagentprocess-captures), [§1.2](#12-key-reference-investigation) |
| #2 | Research pi's session JSONL format and replay capabilities | [§2](#2-pi-session-jsonl-format--replay-capabilities) |
| #3 | Explore options for capturing subagent sessions | [§3](#3-capture-options) |
| #4 | Research pi-web sessiond — can it manage subagent sessions? | [§4](#4-pi-web-session-daemon-api) |
| #5 | Design a lightweight approach: named sessions + manifest catalog | [§6](#6-lightweight-approach-named-sessions--manifest-catalog) |
| #6 | Design a dashboard approach: subagent sessions visible in pi-web | [§7](#7-dashboard-approach-pi-web-subsession-plugin) |
| #7 | Evaluate how Piolium handles subagent visibility | [§5](#5-piolium-visibility-patterns-preliminary--package-not-available) |
| #8 | Produce written recommendation in plans/subagent-observability.md | [§8](#8-recommendation) |
| #9 | Create follow-up implementation tasks for the chosen approach | [§9](#9-follow-up-implementation-tasks) |

---

## 1. Current State Audit

### 1.1 What `spawnAgentProcess()` captures

The function in `src/spawn.ts` spawns a pi process with `--mode json --no-session` and streams JSONL events from stdout.

**Key finding:** The `--no-session` flag means no session file is ever written to disk. All session artifacts vanish when the process exits.

**Current capture (in-memory only):**

```
┌─────────────────────────────────────────────────────┐
│                  spawnAgentProcess()                 │
│  ┌──────────────┐    ┌──────────────┐               │
│  │  args build  │───►│  pi spawn    │  stdout JSONL │
│  │  --no-session│    │  --mode json │──────────────►│
│  └──────────────┘    └──────┬───────┘               │
│                             │ stderr                 │
│                             ▼                        │
│                      captured but                    │
│                      not persisted                   │
│   ┌──────────────────────────────────────┐           │
│   │  messages[] (in-memory array)        │           │
│   │  usage (input/output/cache/cost/turns)│          │
│   │  exitCode                            │           │
│   │  stderr (optional)                   │           │
│   └──────────────────────────────────────┘           │
│                │                                     │
│                ▼                                     │
│          returned as SpawnDetails                    │
└─────────────────────────────────────────────────────┘
```

**Events tracked from JSONL stream** (`processChunk` → `trackEvent`):

| Event type | What's captured | What's lost |
|---|---|---|
| `message_end` | Message object pushed to `messages[]`, usage stats accumulated | **All intermediate reasoning/tool calls** are collapsed into one message |
| `tool_result_end` | Message pushed to `messages[]` | — |
| `thinking*` events | **None** (not handled) | Full thinking/reasoning trace |
| `tool_start` / `tool_update` | **None** | Tool call lifecycle |
| `before_agent_start` | **None** | Extension context injection |
| `session_info` | **None** | Session metadata |

### 1.2 Key reference investigation

**NOTE:** The task spec references two external packages that could not be investigated because they are not installed in this project's dependency tree. The findings below document what was attempted and what is known from context.

#### @tintinweb/pi-subagents FleetView (WEB SEARCH PENDING)

**Local search performed:**
- Searched worktree `node_modules/` for `@tintinweb/pi-subagents` — not found
- Searched parent project (`package-proxy-v2`) `node_modules/` — not found
- Grepped all `package.json` files in both trees — no matches
- Not referenced in any other source files in the project

The package likely exists on the npm registry (under the `@tintinweb` scope) but is not installed in this project's dependency tree.

**Action item:** Before Phase 2 implementation, search npmjs.com for `@tintinweb/pi-subagents` to review its API, patterns, and session management approach.

**Inferred from task description (speculative):** FleetView is cited as a reference for subagent visibility patterns. The name suggests:
- A dashboard or overview UI for monitoring multiple subagent sessions concurrently
- Likely uses named, persisted sub-sessions with a central registry or index
- The approach of using deterministic session IDs + catalog file (designed in this document) is expected to align with FleetView's patterns

**Caution:** The above inferences are based on the package name alone and have not been verified against actual source code or documentation.

#### @quintinshaw/pi-dynamic-workflows live progress panel (WEB SEARCH PENDING)

**Local search performed:**
- Searched worktree `node_modules/` for `@quintinshaw/pi-dynamic-workflows` — not found
- Searched parent project (`package-proxy-v2`) `node_modules/` — not found
- Grepped all `package.json` files in both trees — no matches
- Not referenced in any other source files in the project

The package likely exists on the npm registry (under the `@quintinshaw` scope) but is not installed in this project's dependency tree.

**Action item:** Before Phase 2 implementation, search npmjs.com for `@quintinshaw/pi-dynamic-workflows` to review its API, patterns, and session management approach.

**Inferred from context (speculative):** This package likely provides a real-time UI component showing workflow phase status. The name suggests:
- Likely registers a pi-web workspace panel showing running/complete/failed phases
- Probably uses SSE or WebSocket for live updates
- May leverage the session daemon's existing notification infrastructure

**Caution:** The above inferences are based on the package name alone and have not been verified against actual source code or documentation.

**Relevance:** The Belayd harness already has phase tracking infrastructure (process gate, `completedPhaseNames[]`, `formatProcessState()`). The pi-web plugin approach in Section 7 aligns with how Dynamic Workflows likely implements its panel. Before implementing the plugin, install this package and study its patterns.

### 1.3 The `--no-session` gap

The pi CLI has a rich session system:

- `--session <path|id>` — Use specific session file or partial UUID
- `--session-id <id>` — Use exact project session ID, creating it if missing
- `--name <name>` — Set session display name
- `--session-dir <dir>` — Directory for session storage and lookup
- `--resume` — Select a session to resume
- `--continue` — Continue previous session
- `--fork <path|id>` — Fork specific session
- `--export <file>` — Export session to HTML

**We use none of these.** The `--no-session` flag disables all persistence. This was presumably chosen to avoid cluttering the user's session store with ephemeral subagent runs, but it makes debugging impossible.

### 1.4 What already exists in the pipeline

The `SpawnOptions` type in `src/agent-registry.ts` already has a `sessionName?: string` field. The spawn logic checks it:

```typescript
const args: string[] = ["--mode", "json", "--no-session"];
if (sessionName) {
  args.push("--name", sessionName);
}
```

This is **half-baked**: it sets a display name but the `--no-session` flag still suppresses persistence. The `--name` flag without removing `--no-session` has no effect on storage.

---

## 2. Pi Session JSONL Format &amp; Replay Capabilities

### 2.1 File format

Sessions are stored as **append-only JSONL files** in `~/.pi/agent/sessions/<encoded-cwd>/`.

**Naming convention:** `<timestamp>_<uuid>.jsonl`

**Structure:** Each line is a JSON object. The first line is the session header; subsequent lines are entries forming a tree via `id`/`parentId` fields.

**Session header:**

```json
{
  "type": "session",
  "version": 3,
  "id": "019ff231-...",
  "timestamp": "2026-08-11T18:59:05.560Z",
  "cwd": "/home/user/git/belayd-agent-harness.feat-TASK-2"
}
```

**Entry types** (from `session-manager.d.ts`):

| Entry type | Purpose |
|---|---|
| `message` | User, assistant, tool-result messages |
| `thinking_level_change` | Thinking level changed mid-session |
| `model_change` | Model switch |
| `compaction` | Context compaction summary |
| `branch_summary` | Abandoned branch summary |
| `custom` | Extension-specific data (not sent to LLM) |
| `custom_message` | Extension message (sent to LLM) |
| `label` | User bookmark/marker |
| `session_info` | Display name, metadata |

### 2.2 Message entry example

```json
{
  "type": "message",
  "id": "02a6b58f",
  "parentId": "23585a2a",
  "timestamp": "2026-08-11T18:58:46.666Z",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "...", "thinkingSignature": "..." },
      { "type": "text", "text": "Let me check..." },
      { "type": "toolCall", "id": "call_xxx", "name": "ls", "args": {...} }
    ],
    "api": "openai-completions",
    "provider": "openrouter",
    "model": "deepseek/deepseek-v4-pro",
    "usage": { "input": 1688, "output": 182, "totalTokens": 22350, "cost": { "total": 0.00285 } },
    "stopReason": "toolUse"
  }
}
```

### 2.3 Replay capabilities

- **`pi --resume`** — Opens TUI session picker to browse and resume any session
- **`pi --continue`** — Resumes the most recent session
- **`pi --export <file>`** — Exports session to HTML for review
- **`pi --session <path|id>`** — Opens specific session directly
- **`pi-web`** — Provides a full browser-based session viewer with tree navigation, message browsing, and session listing

### 2.4 Default session store location

```
~/.pi/agent/sessions/
├── --home-user-git-project-name--/
│   ├── 2026-08-11T18-44-36-605Z_<uuid>.jsonl
│   └── 2026-08-11T18-59-05-560Z_<uuid>.jsonl
└── --home-user-git-other-project--/
    └── ...
```

Each project directory is an encoded version of the project's absolute path. Within each directory, session files are timestamped.

---

## 3. Capture Options

### 3.1 Option Comparison

| Criterion | Option A: Temp dirs | Option B: Named sessions in default store | Option C: Named sessions + manifest catalog |
|---|---|---|---|
| **Session persistence** | ❌ Files deleted on cleanup | ✅ Lives in `~/.pi/agent/sessions/` | ✅ Lives alongside worktree or project |
| **Discoverability** | ❌ Must know temp path | ✅ pi --resume / pi-web show them | ✅ Catalog file lists all subagent runs |
| **Lifecycle management** | Manual cleanup (temp) | ✅ pi-web archive/delete | ✅ Manifest-controlled GC |
| **Parent-child linkage** | ❌ No relationship | ❌ No built-in parent ref | ✅ Catalog stores parent task/phase |
| **Cost tracking** | Manual aggregation | ✅ pi-web shows per-session cost | ✅ Catalog aggregates costs |
| **pi-web visibility** | ❌ Not visible | ✅ Automatically visible | ✅ Visible (linked to parent) |
| **Replay** | Manual file open | ✅ pi --resume / --session | ✅ pi --session <path> |
| **Implementation effort** | Low (trivial) | Medium (remove --no-session, add --session-id, --name) | High (catalog file, GC, new module) |
| **Disk clutter risk** | High (orphaned temp dirs) | Medium (sessions accumulate) | Low (catalog enables GC policies) |

### 3.2 Option A: Temp directories

**How it works:** Instead of `--no-session`, spawn into a temp directory with `--session-dir <tmpdir>` and `--name <agent-name>`. The session file lives in a temp dir that is cleaned up after processing (or left for debugging if `BELAYD_DEBUG=1`).

**Pros:** Simple to implement; no pollution of the default session store.  
**Cons:** Hard to discover; files lost on cleanup; can't use pi-web to inspect.

```typescript
// Sketch
const sessionDir = mkdtempSync(join(tmpdir(), "belayd-session-"));
const args = [
  "--mode", "json",
  "--session-dir", sessionDir,
  "--name", `${agentPhase}-${taskId}`,
  // No --no-session!
];
// ... spawn, wait, then optionally copy session file or rm -rf sessionDir
```

### 3.3 Option B: Named sessions in default store

**How it works:** Drop `--no-session`, use `--session-id` with a deterministic ID derived from the task+phase, and `--name` with a human-readable label. Sessions appear automatically in `~/.pi/agent/sessions/` and thus in pi-web.

**Pros:** Zero new infrastructure; pi sessions are natively visible in pi-web; every feature (resume, export, tree navigation) works out of the box.  
**Cons:** Sessions persist forever unless cleaned up; no explicit parent-child metadata; session IDs could collide if the deterministic ID is reused.

```typescript
// Sketch
const shortRunId = Date.now().toString(36);
const sessionId = `belayd-${taskId}-${phaseName}-${shortRunId}`;
const args = [
  "--mode", "json",
  "--session-id", sessionId,
  "--name", `Belayd ${phaseName} for ${taskId}`,
  // No --no-session!
];
```

### 3.4 Option C: Named sessions + manifest catalog

**How it works:** Same as Option B (drop `--no-session`), but additionally write a manifest catalog file (e.g., `.belayd/sessions.json`) in the project or worktree root. The catalog indexes all subagent sessions with metadata: task ID, phase, model, cost, timestamps, exit code, quality gate result.

**Pros:** Enables aggregate views (total cost per task, phase timing, failure rates); explicit parent-child linkage; enables GC policies (delete sessions for completed tasks); the catalog is machine-readable for dashboard integration.  
**Cons:** More code to write and maintain; catalog file can grow large over time (mitigated by GC).

---

## 4. Pi-Web Session Daemon API

### 4.1 Current integration

The `extensions/index.ts` already communicates with the session daemon via a Unix socket:

```typescript
function sessiondSocketPath(): string {
  return process.env.PI_WEB_SESSIOND_SOCKET ?? join(homedir(), ".pi-web", "sessiond.sock");
}

function daemonRequest(method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Makes HTTP requests over Unix socket to sessiond
}
```

**Currently used endpoints:**

| Endpoint | Method | Purpose |
|---|---|---|
| `/sessions` | POST | Create a new persistent session in pi-web |
| `/sessions/:id/prompt` | POST | Send a prompt to a session |

### 4.2 Available endpoints for observability

#### Session daemon endpoints: VERIFIED vs INFERRED

From exploring how the extension (`extensions/index.ts`) communicates with the session daemon:

| Endpoint | Method | Status | Evidence |
|---|---|---|---|
| `/sessions` | POST | ✅ **VERIFIED** | Used in `extensions/index.ts` `belaydAgentHarness` to create sessions |
| `/sessions/:id/prompt` | POST | ✅ **VERIFIED** | Used to send prompts to sessions |
| `/sessions?cwd=...` | GET | 🔶 **INFERRED** | Based on `SessionManager.list(cwd)` — not directly tested with curl |
| `/sessions?cwd=...&parent=<id>` | GET | 🔶 **INFERRED** | `parent` query param assumed from `parentSessionPath` field — **needs testing** |
| `POST /sessions` with `parentSessionId` | POST | 🔶 **INFERRED** | Session creation accepting parent param is assumed — **needs testing** |

**Recommendation:** Before Phase 2 implementation, verify inferred endpoints with:

```bash
# Test GET sessions listing
curl --unix-socket ~/.pi-web/sessiond.sock http://localhost/sessions?cwd=$(pwd)

# Test POST with parentSessionId
curl -X POST --unix-socket ~/.pi-web/sessiond.sock \
  -H "Content-Type: application/json" \
  -d '{"cwd":"'$(pwd)'","parentSessionId":"<known-session-id>"}' \
  http://localhost/sessions
```

#### `--session-id` + `--name` composition

From inspecting pi's CLI argument parsing in `dist/cli/args.js` and `dist/main.js`:

- **Can they be combined?** ✅ Yes. `--session-id` and `--name` are independent flags parsed by different branches in the arg parser.
- **Validation:** `--session-id` conflicts only with `--session`, `--continue`, `--resume` — NOT with `--name` or `--no-session`.
- **Behavior when combined:** The session is created (or opened) with the given ID. Then `sessionManager.appendSessionInfo(name)` is called with the `--name` value to set the display name.
- **Behavior with `--no-session`:** `--session-id` + `--no-session` creates an **in-memory** session with `SessionManager.inMemory(cwd, { id: sessionId })`. The `--name` value is still set but since there's no file persistence, the name is lost on exit.
- **Recommendation:** Use `--session-id` + `--name` together (without `--no-session`) for persisted, named sessions.

**Note:** This combination has NOT been tested end-to-end with `--mode json`. The analysis above is based on code reading of the CLI argument parser and session manager. A full integration test (spawning pi with `--mode json --session-id X --name Y "test"` and verifying the session file and display name) should be added during Phase 1 implementation.

The `SessionInfo` type (from `session-manager.d.ts` in `@earendil-works/pi-coding-agent`) is:

```typescript
interface SessionInfo {
  path: string;                          // Path to the .jsonl session file
  id: string;
  cwd: string;                           // Working directory (empty string for old sessions)
  name?: string;                         // User-defined display name from session_info entries
  parentSessionPath?: string;            // Path to parent session (if forked)
  created: Date;                         // NOT a string — it's a Date object
  modified: Date;                        // NOT a string — it's a Date object
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;               // Concatenated text of all messages
}
```

**Correction:** The document previously claimed a `persisted: boolean` field existed. This field does **not** appear in the actual `SessionInfo` type. The `path` field's presence or absence indicates persistence (an in-memory session has no path). Additionally, `created` and `modified` are `Date` objects, not strings.

### 4.3 Subsession capability (INFERRED — no matching types found)

**Note:** The file `apiTypes.d.ts` does **not** exist in the pi coding agent distribution. A search of all `.d.ts` files in `@earendil-works/pi-coding-agent` found no `PiWebConfigValues` interface. The `subsessions` mechanism described below is **inferred from the session daemon's observed behavior** and from the pi-web plugin documentation, not from a source-level type definition.

The session daemon's `SessionInfo` interface includes a `parentSessionPath?: string` field, confirming that parent-child session linkage is a first-class concept at the daemon level. This strongly suggests that the daemon supports a `subsessions` feature, but the exact type and tool names are inferred:

| Inferred config | Evidence |
|---|---|
| `subsessions: boolean` | `parentSessionPath` in `SessionInfo`; `NewSessionOptions.parentSession` in `session-manager.d.ts` |
| `spawn_subsession` / `list_subsessions` tools | No source confirmation — inferred from task description |

**Investigation needed:** The actual tool names and API surface for subsessions must be verified by either:
1. Inspecting the pi-web plugin source code (not included in `@earendil-works/pi-coding-agent`)
2. Observing the session daemon's behavior with a running pi-web instance
3. Consulting pi-web's own documentation or type definitions

### 4.4 Session tree endpoint

The session manager supports tree navigation. The actual type (from `session-manager.d.ts`) is:

```typescript
interface SessionTreeNode {
  entry: SessionEntry;           // The session entry at this node
  children: SessionTreeNode[];   // Child nodes (tree structure)
  label?: string;                // Resolved label for this entry, if any
  labelTimestamp?: string;       // Timestamp of latest label change
}
```

The `SessionManager.getTree()` method returns `SessionTreeNode[]`, where each node wraps a `SessionEntry` (message, thinking_level_change, model_change, compaction, branch_summary, custom, custom_message, label, session_info) and has a `children` array forming the tree.

**Correction:** The previously documented `SessionTreeSnapshot` type with `activeLeafId` and `activePathIds` does **not** exist in the source types. The tree is returned directly as `SessionTreeNode[]` from `getTree()`. The `activeLeafId` and `activePathIds` are accessible via separate `SessionManager` methods (`getLeafId()`, `getBranch()`).

This means pi-web already has the infrastructure to display session trees. Subagent sessions could appear as child nodes of the parent workflow session.

---

## 5. Piolium Visibility Patterns

### 5.1 Overview

Task TASK-8 explores Piolium in depth. This section captures the relevant patterns for subagent observability based on what is known from the task description and pi ecosystem.

Piolium (`@vigolium/piolium`) is a pi-native security audit agent that runs multi-phase audits with specialist sub-agents. Key architectural patterns:

### 5.2 Relevant patterns

| Pattern | Description | Applicability to Belayd |
|---|---|---|
| **Sub-agent session isolation** | Each sub-agent gets its own isolated pi session, named and persisted | Belayd should persist subagent sessions with task+phase names |
| **Resumable state** | Failed phases can be resumed from the last checkpoint | Requires session persistence + phase markers in session metadata |
| **Structured output capture** | Sub-agents return structured findings (not free text) | Belayd scouts already attempt this via system prompts, but lack validation |
| **Parent session linkage** | Sub-agent sessions are linked to the parent orchestrator session | Matches the `parentSessionPath` field in pi-web's `SessionInfo` |

### 5.3 Key insight

Piolium likely names its sub-agent sessions deterministically (e.g., `piolium-audit-<run-id>-phase-<n>`) and stores them in the default pi session store. This makes them automatically visible in pi-web and resumable via `pi --session <name>`.

Belayd can adopt the same pattern: `belayd-<taskId>-<phaseName>-<attempt>`.

---

## 6. Lightweight Approach: Named Sessions + Manifest Catalog

### 6.1 Directory layout

```
.belayd/                                    # Project-level directory (see security discussion in §8.4)
├── sessions.json                           # Manifest catalog (all subagent runs)
├── sessions/                               # Optional: symlinks/copies of session files
│   └── belayd-TASK-42-scout-<runId>.jsonl →  # (symlink to ~/.pi/agent/sessions/...)
└── signals/                                # Signal files for human-in-the-loop phases (plannotator)
    └── TASK-42/                            # One subdirectory per task
        ├── review-signal.json
        └── feedback.json
```

Or, for worktree-isolated runs:

```
<worktree-root>/
├── .belayd/
│   ├── sessions.json
│   └── sessions/
└── (project files)
```

### 6.2 Manifest catalog schema

```typescript
/**
 * Manifest catalog for subagent session tracking.
 * Stored as JSON (not JSONL) — it's a mutable index, not an append log.
 */
interface SubagentSessionCatalog {
  /** Schema version for forward compatibility */
  schemaVersion: 1;

  /** Task-level entries */
  tasks: Record<string, TaskEntry>;

  /** Generation timestamp */
  updatedAt: string;
}

interface TaskEntry {
  /** Backlog task ID, e.g. "TASK-42" */
  taskId: string;

  /** Workflow type */
  workflowType: "feature" | "bugfix" | "research" | "chore" | "documentation" | "refactor" | "hotfix";

  /** Branches/worktrees this task ran in */
  worktree?: string;

  /** All subagent runs for this task, ordered by start time */
  runs: SubagentRunEntry[];

  /** Aggregated totals */
  totals: {
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTurns: number;
    runCount: number;
    failedRunCount: number;
  };
}

interface SubagentRunEntry {
  /** e.g. "scout", "plan", "implement" */
  phase: string;

  /** Human-readable name used for the session */
  sessionName: string;

  /** Path to the session file in pi's default store */
  sessionFilePath: string;

  /** Session ID from the JSONL header */
  sessionId: string;

  /** Attempt number (for retries) */
  attempt: number;

  /** Model used */
  model: string;

  /** Task snippet (first ~200 chars) */
  taskPreview: string;

  /** Start and end timestamps */
  startedAt: string;
  completedAt: string | null;

  /** Duration in milliseconds */
  durationMs: number | null;

  /** Exit code (0 = success) */
  exitCode: number;

  /** Usage stats (from SpawnUsage) */
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };

  /** Quality gate result, if applicable */
  qualityGate?: {
    passed: boolean;
    feedback?: string;
  };

  /** Error message if the run failed */
  error?: string;
}
```

### 6.3 Spawn changes

**Minimal change to `spawnAgentProcess()`:**

```typescript
export async function spawnAgentProcess(options: SpawnOptions): Promise<SpawnResult> {
  const { model, tools, systemPrompt, task, sessionName, cwd, signal, worktree } = options;

  // Build pi CLI args — drop --no-session, use session-id + name
  const effectiveSessionName = sessionName ?? `belayd-${slugify(task).slice(0, 60)}`;
  const shortRunId = Date.now().toString(36);
  const sessionId = `${effectiveSessionName}-${shortRunId}`;

  const args: string[] = [
    "--mode", "json",
    "--session-id", sessionId,
    "--name", effectiveSessionName,
  ];

  // ... rest of args unchanged (--model, --tools, --append-system-prompt, task)
  // ... spawn logic unchanged
}
```

**New function: `writeSessionCatalog()`**

A pure function that reads, merges, and writes the manifest catalog. Called after each subagent run completes.

```typescript
function writeSessionCatalog(
  catalogPath: string,
  runEntry: SubagentRunEntry,
): void {
  let catalog: SubagentSessionCatalog;

  try {
    const raw = readFileSync(catalogPath, "utf-8");
    catalog = JSON.parse(raw) as SubagentSessionCatalog;
  } catch {
    catalog = { schemaVersion: 1, tasks: {}, updatedAt: new Date().toISOString() };
  }

  const taskId = extractTaskId(runEntry.sessionName); // e.g. "TASK-42"
  if (!catalog.tasks[taskId]) {
    catalog.tasks[taskId] = {
      taskId,
      workflowType: "feature",
      runs: [],
      totals: { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTurns: 0, runCount: 0, failedRunCount: 0 },
    };
  }

  const task = catalog.tasks[taskId];
  task.runs.push(runEntry);
  task.totals.totalCost += runEntry.usage.cost;
  task.totals.totalInputTokens += runEntry.usage.input;
  task.totals.totalOutputTokens += runEntry.usage.output;
  task.totals.totalTurns += runEntry.usage.turns;
  task.totals.runCount++;
  if (runEntry.exitCode !== 0) task.totals.failedRunCount++;

  catalog.updatedAt = new Date().toISOString();
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf-8");
}
```

### 6.4 Discovery and replay

- **List runs for a task:** `cat .belayd/sessions.json | jq '.tasks["TASK-42"].runs'`
- **Replay a session:** `pi --session <path from catalog entry>`
- **View in pi-web:** Sessions appear automatically because they're stored in the default session store. pi-web's `GET /sessions?cwd=...` lists them.
- **Export to HTML:** `pi --export <file> <session-path>`

---

## 7. Dashboard Approach: Pi-Web Subsession Plugin

### 7.1 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Pi-Web Browser                          │
│  ┌────────────────────┐    ┌──────────────────────────────┐ │
│  │ Workspace Panel    │    │  Session View                │ │
│  │ ┌────────────────┐ │    │  ┌─────────────────────────┐ │ │
│  │ │ Belayd Panel   │ │    │  │ Parent session          │ │ │
│  │ │                │ │    │  │  ├─ Scout sub-session   │ │ │
│  │ │ TASK-42        │ │    │  │  ├─ Plan sub-session    │ │ │
│  │ │  ├─ scout  ✓   │ │    │  │  └─ Implement sub-sess  │ │ │
│  │ │  ├─ plan   ✓   │ │    │  └─────────────────────────┘ │ │
│  │ │  └─ implem ✗   │ │    └──────────────────────────────┘ │
│  │ └────────────────┘ │                                     │
│  └────────────────────┘                                     │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP/SSE over Unix socket
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Pi-Web Session Daemon                     │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────┐  │
│  │ Session Hub  │  │ Unread Catalog│  │ Subsessions    │  │
│  │ (live events)│  │ (notifications)│  │ (parent-child) │  │
│  └──────────────┘  └────────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ▲ HTTP over socket
                            │
┌─────────────────────────────────────────────────────────────┐
│                   Belayd Agent Harness                       │
│  ┌────────────────────┐    ┌──────────────────────────────┐ │
│  │ spawnAgentProcess()│    │ belayd pi-web plugin          │ │
│  │ (now persists)     │───►│ (registers workspace panel)   │ │
│  └────────────────────┘    └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Pi-Web Plugin contributions

A pi-web plugin (`belayd-harness-web`) would register:

1. **Workspace panel** — Lists recent Belayd tasks, their phases, and status (passed/failed/running)
2. **Session tree enhancement** — Shows subagent sessions as children of the parent Belayd session
3. **Replay button** — Opens a subagent session directly in pi-web's session viewer

**Plugin structure** (no `plugin-api.d.ts` exists — this type file was not found in the pi coding agent distribution; the structure below is inferred from the `ExtentionAPI` type in `@earendil-works/pi-coding-agent`):

```typescript
export default function belaydWebPlugin(api: ExtensionAPI): void {
  // The plugin runs in the browser and communicates with sessiond
  // via the existing WebSocket/SSE connection.
  // It reads the .belayd/sessions.json catalog file via workspace files API
  // and renders a panel showing task progress.
}
```

### 7.3 Session daemon integration

The existing `daemonRequest()` in `extensions/index.ts` would be extended to:

1. **Create sessions** with explicit parent linkage: `POST /sessions` with a `parentSession` field
2. **List subsessions**: `GET /sessions?cwd=...&parent=<parent-id>`
3. **Tag sessions**: Use the `--name` flag to include `belayd:TASK-42:scout:attempt=1` structure for easy filtering

The pi-web session daemon's `subsessions` configuration is **inferred** (see Section 4.3). The `spawn_subsession` / `list_subsessions` / `check_subsession` / `read_subsession` tool names have not been verified against any source types. If these can be invoked programmatically from the extension (rather than by the LLM), they provide a built-in parent-child session infrastructure.

### 7.4 Parent-child session linkage via pi-web

When creating a subagent session through the daemon, we can pass the parent session ID:

```typescript
// In spawnAgentProcess, when daemon integration is active:
const parentSessionId = getCurrentPiWebSessionId();

const created = await daemonRequest("POST", "/sessions", {
  cwd: worktreePath ?? cwd,
  parentSessionId,  // Link to parent
  name: `belayd:${taskId}:${phaseName}`,
});
```

The daemon's `SessionInfo` already has a `parentSessionPath` field, but it's read from the session file header. We'd need to verify whether `POST /sessions` accepts a `parentSessionId` parameter.

---

## 8. Recommendation

### 8.1 Decision: Adopt a two-phase approach

**Phase 1 (Immediate): Lightweight — Named sessions in default store + minimal catalog**

Do the simplest thing that solves the "black box" problem:

1. **Drop `--no-session`** in `spawnAgentProcess()` — replaced with `--session-id` and `--name`
2. **Use a deterministic session name** pattern: `belayd-<taskId>-<phaseName>` (injected via `sessionName` in `SpawnOptions`) with a short run ID suffix for the session ID
3. **Write to a minimal structured JSON catalog** (`.belayd/sessions.json`) that records `{event, taskId, phase, sessionFilePath, timestamp, cost, exitCode}` for each run
4. **Add `BELAYD_DEBUG` env var** — when set, the temp dir is preserved; when unset, ephemeral sessions are fine as a default

Cost: ~half-day implementation. Immediately unblocks debugging.

**Phase 2 (Soon): Dashboard — Pi-Web plugin + manifest catalog**

Build on the persisted sessions from Phase 1:

1. **Full manifest catalog** (`.belayd/sessions.json`) with aggregated totals, quality gate results, retry tracking
2. **Pi-web workspace panel** showing Belayd task status — which phases passed/failed, cost breakdown, replay links
3. **Session daemon integration** for real-time status updates during workflow execution
4. **Cleanup/GC** — archive or delete old subagent sessions when a task is marked done

### 8.2 Why not Option A (temp dirs only)?

Temp directories make sessions invisible to pi-web and require special tooling to inspect. The whole point of observability is to *see* what happened, which is best achieved by using the session infrastructure that already exists.

### 8.3 Why Phase 1 first?

| Factor | Reasoning |
|---|---|
| **Effort** | Removing `--no-session` and adding a manifest log is < 50 lines of code |
| **Risk** | Low — pi's session system is battle-tested. Session files are typically small (often < 100KB each for single-turn agents), but can grow large (multiple MB) for agents producing large tool outputs (e.g., reading entire files). **Caveat:** In large repos with verbose tool output, session files for multi-turn agents may reach 5-10MB. Monitor disk usage if many subagents run. |
| **Immediate value** | Developers can `pi --resume` and see exactly what the scout/planner/implementer did |
| **Foundation** | Persisted sessions are the prerequisite for the dashboard approach |

### 8.4 Key design decisions

1. **Session ID pattern**: `belayd-<taskId>-<phaseName>-<shortRunId>` — unique, scannable, sortable (see format discussion below)
2. **Session directory**: Default `~/.pi/agent/sessions/` — no custom paths needed
3. **Manifest format**: **Structured JSON** (`.belayd/sessions.json`) — **not** append-only JSONL. See format rationale below.
4. **GC**: Defer to Phase 2 — session files are small enough that cleanup is not urgent

#### Session ID format decision

There are two competing formats used in different parts of this document:

| Format | Used in | Pros | Cons |
|---|---|---|---|
| `belayd-<taskId>-<phaseName>-<timestamp>` | Section 8.4 (old), Appendix B | Includes timestamp, sortable | Long, timestamps make IDs harder to scan in listings |
| `belayd:<taskId>:<phaseName>` | Section 8.1 | Shorter, scannable | Not unique across runs without suffix |

**Recommendation:** Use `belayd-<taskId>-<phaseName>-<shortRunId>` where `<shortRunId>` is a short random or timestamp-based suffix (e.g., first 8 chars of a UUID or Unix milliseconds). This is both scannable and unique. The colon variant (`belayd:TASK-42:scout`) is good for `--name` (display name) where brevity matters, but `--session-id` requires uniqueness.

#### Manifest format decision

There is an inconsistency between sections:
- **Section 6** designs the catalog as **structured JSON** (`sessions.json`) with schema version, task entries, and aggregated totals
- **Section 8** (Phase 1) proposes an **append-only JSONL** (`sessions.log`) for simplicity
- **Appendix C** shows an append-only JSONL format

**Recommendation:** Use **structured JSON** (`sessions.json`) from Phase 1, not JSONL. Rationale:

| Criterion | Structured JSON (recommended) | Append-only JSONL |
|---|---|---|
| **Read performance** | Fast — parse once, query in memory | Slow — must scan all lines for task lookup |
| **Write safety** | Atomic via `writeFileSync` + rename | Safe per append, but corrupted if interleaved |
| **Aggregation** | Built-in (totals computed at write time) | Must aggregate on every read |
| **Complexity** | Slightly more complex (read-merge-write) | Simple append |
| **Concurrency** | Requires locking or atomic writes | Append is safe for single-writer |

Since subagent runs occur sequentially (one phase at a time), there's no concurrency concern. The extra complexity of read-merge-write is minimal, and the benefits of fast lookups and built-in aggregation outweigh it. Use `writeFileSync` with atomic rename for crash safety.

**Note:** The `sessions.log` JSONL variant (Appendix C) was an early design that was superseded by the structured JSON approach. The append-only JSONL format is no longer recommended.

#### Plannotator phase support in catalog

The catalog schema supports two phase execution models:
1. **Subagent phases** (scout, plan, implement, etc.) — each spawns a separate pi process, produces a `SubagentRunEntry` with `sessionFilePath`, `usage`, and `qualityGate`
2. **Signal-based phases** (plannotator) — use the signal protocol (signal files in `.belayd/signals/`) rather than spawning a pi process

For signal-based phases, add an alternative entry type:

```typescript
interface SignalPhaseEntry {
  type: "signal_phase";
  phase: "plannotator";
  taskId: string;
  startedAt: string;
  completedAt: string | null;
  feedback?: string;          // Human review feedback
  result: "approved" | "changes_requested" | "abandoned";
}
```

The `TaskEntry.runs` array can contain both `SubagentRunEntry` and `SignalPhaseEntry` entries, discriminated by a `type` field.

#### Privacy: Session names in filesystem paths

Using task IDs and phase names in `--session-id` values embeds this data in the session file path (which follows the pattern `<timestamp>_<sessionId>.jsonl`). This is a potential **privacy concern** if:
- The project deals with sensitive data and session files are shared or backed up
- Task names or phase names contain customer-identifiable information
- Session files end up in version control or logs

**Recommendation:** Session IDs are stored in `~/.pi/agent/sessions/` (outside the project directory), so they are not committed to git by default. However, if session files are exported or shared, the ID exposes the task/phase context. For Phase 1, this is acceptable — the benefit of scannable IDs outweighs the minimal privacy risk. If privacy becomes a concern, use opaque session IDs and store the task/phase mapping only in the catalog file (which is in `.belayd/` and can be gitignored).

#### .belayd/ directory security

The `.belayd/` directory (proposed for the manifest catalog) should be:
- **Added to `.gitignore`** — the catalog contains task metadata, usage data, and file paths that are project-tracking artifacts, not source code
- **Not committed** — unlike `.pi/` which is user-specific, `.belayd/` is per-worktree and its contents (session listings, quality gate results) are build artifacts

**Tool access implications:** The session catalog file is a plain JSON file in the project directory. It is **readable and writable** by any spawned agent process (which runs with the same filesystem permissions as the harness). This means:
- Scout/implementer agents could theoretically read the catalog to learn about previous runs
- The catalog could be used as context for phase decisions (e.g., "this phase already failed 3 times")
- If this is undesired, the catalog should be stored outside the worktree (e.g., `~/.belayd/`) or locked to the harness process only

**Recommendation:** Add `.belayd/` to `.gitignore`. Document the tool access implications. If agent access to the catalog is a concern, store the catalog in `~/.belayd/` instead of the worktree root.

---

## 9. Follow-Up Implementation Tasks

### Task A: Persist subagent sessions (Immediate)

**Files:** `src/spawn.ts`, `src/agent-registry.ts` (types)

**Changes:**
1. Remove `--no-session` from args in `spawnAgentProcess()`
2. Add `--session-id` with unique deterministic ID: `belayd-${taskId}-${phaseName}-${shortRunId}`
3. Add `--name` with readable label
4. Update `SpawnResult.details` to include `sessionFilePath` — see below for how to resolve this path
5. Add unit tests: verify args contain `--session-id` and `--name`, not `--no-session`

**Resolving sessionFilePath from a spawned pi process:**

The pi CLI in `--mode json` does **not** emit a `session_info` or `session_file` event in its stdout JSONL stream. A survey of the JSON event types in the pi codebase confirms no event carries the session file path. Therefore, the session file path must be resolved **after the process exits**, using one of these approaches:

**Approach 1: Compute from convention (recommended for Phase 1)**

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

function resolveSessionFilePath(cwd: string, sessionId: string): string | undefined {
  const sessionDir = join(homedir(), ".pi", "agent", "sessions");
  // Encode cwd the same way pi does: replace / with -, prefix --
  const encodedCwd = "--" + cwd.replace(/\//g, "-").replace(/^--/, "");
  const projectDir = join(sessionDir, encodedCwd);

  if (!existsSync(projectDir)) return undefined;

  // Scan for file matching the session ID
  const files = readdirSync(projectDir);
  const match = files.find((f) => f.includes(sessionId) && f.endsWith(".jsonl"));
  return match ? join(projectDir, match) : undefined;
}
```

**Approach 2: Use SessionManager.list() (requires runtime access to `@earendil-works/pi-coding-agent`)**

```typescript
import { SessionManager } from "@earendil-works/pi-coding-agent";

const sessions = await SessionManager.list(cwd);
const match = sessions.find((s) => s.id === sessionId);
if (match) return match.path;
```

This is more robust as it doesn't depend on internal path encoding conventions. However, `SessionManager.list()` is async and loads all session files, so it has a small performance cost.

**Approach 3: Pass `--session-dir` and compute directly (future enhancement)**

A future enhancement could pass `--session-dir <known-dir>` to control session storage location, then compute the path directly from that known directory + a known timestamp pattern.

### Task B: Manifest log (Immediate)

**Files:** `src/session-catalog.ts` (new), `src/index.ts` (re-export)

**Changes:**
1. Create `src/session-catalog.ts` module with:
   - `SubagentRunEntry` type (see schema above)
   - `appendRunEntry(catalogPath: string, entry: SubagentRunEntry): void`
   - `readTaskRuns(catalogPath: string, taskId: string): SubagentRunEntry[]`
   - `getAggregatedTaskStats(catalogPath: string, taskId: string): TaskTotals`
2. Catalog path: `.belayd/sessions.json` (structured JSON with atomic writes via `writeFileSync`)
3. Call `appendRunEntry()` in the `finally` block of `spawnAgentProcess()` or from the tool execute handler in `extensions/index.ts`

### Task C: Phase gate integration (Soon)

**Files:** `extensions/index.ts`, `src/workflow-registry.ts`

**Changes:**
1. Inject `taskId` and `phaseName` into `SpawnOptions` from the phase tool execute handler
2. After each phase tool completes, write catalog entry with quality gate result
3. Add `phaseAttempt` counter to support retry tracking

### Task D: Pi-web Belayd panel (Later)

**Files:** `extensions/pi-web/` (new directory)

**Changes:**
1. Create a pi-web plugin (`belayd-panel`) that:
   - Registers a `WorkspacePanelContribution` showing task progress
   - Reads `.belayd/sessions.json` via the workspace files API
   - Renders phase status with pass/fail/running indicators
   - Provides "Replay" links that open the subagent session

### Task E: Session daemon parent linkage (Later)

**Files:** `extensions/index.ts`, `src/spawn.ts`

**Changes:**
1. When session daemon is available, pass `parentSessionId` when creating subagent sessions
2. Add tool to list subsessions: `GET /sessions?cwd=...&parent=<id>`
3. Register a pi extension tool for "list subagent sessions for task"

### Task F: GC policies (Later)

**Files:** `src/session-catalog.ts`, `extensions/index.ts`

**Changes:**
1. Add `cleanupArchivedTasks(catalogPath: string, options: { olderThanDays: number }): void`
2. Integration with pi-web's `SessionCleanupRequest` for automated cleanup
3. Add `belayd_cleanup` phase tool or hook into `belayd_stop_task`

---

## Appendix A: Current spawn arg construction (before)

```typescript
const args: string[] = ["--mode", "json", "--no-session"];
if (sessionName) {
  args.push("--name", sessionName);
}
// → No persistence whatsoever
```

## Appendix B: Proposed spawn arg construction (after Phase 1)

```typescript
const effectiveName = sessionName ?? `belayd-${slugify(taskId)}-${phaseName}`;
const shortRunId = Date.now().toString(36);  // Short, scannable suffix
const sessionId = `belayd-${taskId}-${phaseName}-${shortRunId}`;

const args: string[] = [
  "--mode", "json",
  "--session-id", sessionId,
  "--name", effectiveName,
];
// → Session persists in ~/.pi/agent/sessions/<cwd>/
// → Visible in pi --resume and pi-web
// → Replayable with pi --session <id>
```

**Note:** The `shortRunId` uses `Date.now().toString(36)` to produce a compact, sortable, unique identifier (e.g., `"j5z2f"`). This avoids long timestamp strings in session IDs while preserving uniqueness.

## Appendix C: Manifest log format (SUPERSEDED — see format decision in §8.4)

**Note:** This appendix is retained for reference only. The structured JSON format (Section 6.2) is the recommended approach. The append-only JSONL format below was an early draft that was superseded.

```jsonl
{"event":"start","taskId":"TASK-42","phase":"scout","sessionName":"belayd-TASK-42-scout-1712345678901","sessionId":"belayd-TASK-42-scout-1712345678901","timestamp":"2026-08-11T19:00:00.000Z"}
{"event":"complete","taskId":"TASK-42","phase":"scout","sessionName":"belayd-TASK-42-scout-1712345678901","sessionId":"belayd-TASK-42-scout-1712345678901","timestamp":"2026-08-11T19:01:30.000Z","exitCode":0,"durationMs":90000,"model":"deepseek/deepseek-v4-flash","usage":{"input":1500,"output":3200,"cost":0.0015,"turns":3}}
{"event":"complete","taskId":"TASK-42","phase":"implement","sessionName":"belayd-TASK-42-implement-1712345690123","sessionId":"belayd-TASK-42-implement-1712345690123","timestamp":"2026-08-11T19:03:00.000Z","exitCode":1,"durationMs":120000,"model":"deepseek/deepseek-v4-flash","usage":{"input":8500,"output":12000,"cost":0.0085,"turns":8},"error":"Quality gate: typecheck failed"}
```

---

*End of investigation deliverable for TASK-2.*