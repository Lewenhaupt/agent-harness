# Subagent Session Management

Belayd uses pi's persistent session feature to manage subagent sessions with
deterministic naming. This allows users to list, inspect, and resume sessions
at any point during a workflow.

## Naming Convention

Every session spawned by the Belayd harness follows a consistent naming
convention:

| Scope | Pattern | Example |
|-------|---------|---------|
| **Orchestrator** | `belayd-{taskId}` | `belayd-bd-42` |
| **Subagent** | `belayd-{taskId}-{phase}-{shortRunId}` | `belayd-bd-42-scout-a1b2c3` |
| **Quality gate retry** | `belayd-{taskId}-{phase}-{shortRunId}-retry` | `belayd-bd-42-implement-x9y8z7-retry` |

The `{shortRunId}` is a base-36 timestamp derived from `Date.now()`, providing
uniqueness across runs without requiring a central counter.

## How to List Sessions

Use `pi --resume` to list all persistent sessions. You can filter by task ID:

```bash
pi --resume | grep belayd-bd-42
```

Example output:

```
Session: belayd-bd-42 (id: sess_abc123)
  Created: 2024-01-15T10:30:00Z
  Status: active

Session: belayd-bd-42-scout-a1b2c3 (id: sess_def456)
  Created: 2024-01-15T10:31:00Z
  Status: completed

Session: belayd-bd-42-plan-x9y8z7 (id: sess_ghi789)
  Created: 2024-01-15T10:32:00Z
  Status: compacted
```

## How to Inspect a Session

To inspect a specific session's details:

```bash
pi --session-id sess_abc123
```

Or use the session ID directly:

```bash
pi --resume --session-id sess_abc123
```

## How to Attach / Fork a Running Session

You can attach to or fork a running subagent session:

```bash
# Attach to an active subagent session
pi --session-id sess_def456

# Fork a completed subagent session for debugging
pi --fork sess_ghi789
```

## Session Lifecycle

1. **Created** — When a phase tool is called (e.g `belayd_scout`), a new
   persistent session is created with the subagent name.
2. **Completed** — When the subagent process finishes, the session enters a
   completed state. The conversation history and usage data are preserved.
3. **Compacted** — When the workflow completes (all phases done), the harness
   automatically compacts completed subagent sessions. Compaction reduces
   storage overhead while preserving session metadata.
4. **Cleanup** — Sessions are eventually cleaned up by the pi-web daemon's
   retention policy. You can also manually delete sessions:

   ```bash
   pi --session-id sess_abc123 --delete
   ```

## Orchestrator Session

The orchestrator session (`belayd-bd-42`) is created when `/belayd bd-42`
is invoked. This session persists for the entire workflow duration and is
renamed via the session daemon's PATCH endpoint to ensure the name is set
even if creation-time naming is not supported.

## Quality Gate Retry Sessions

When a quality gate fails, the retry subagent spawns with the same phase name
appended with `-retry`. This allows you to distinguish between original attempts
and retries when inspecting sessions:

- `belayd-bd-42-implement-a1b2c3` — First attempt
- `belayd-bd-42-implement-a1b2c3-retry` — Quality gate retry

## Implementation Details

Session naming is implemented purely in `src/session-naming.ts`:

- `generateShortRunId()` — Base-36 timestamp
- `computeSubagentSessionName(taskId, phaseName, shortRunId)` — Subagent session name
- `computeOrchestratorSessionName(taskId)` — Orchestrator session name

The spawn logic in `src/spawn.ts` uses `--session-id` and `--name` CLI flags
(added in bd-10) instead of the deprecated `--no-session` flag.