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
| **Subagent** | `belayd-{taskId}-sub-{phase}-{shortRunId}` | `belayd-bd-42-sub-scout-a1b2c3` |
| **Quality gate retry (fresh epoch)** | `belayd-{taskId}-sub-{phase}-{shortRunId}-retry-{N}` | `belayd-bd-42-sub-implement-x9y8z7-retry-3` |
| **Cross-run resume (fresh epoch)** | `belayd-{taskId}-sub-{phase}-{shortRunId}-run-{N}` | `belayd-bd-42-sub-implement-x9y8z7-run-3` |

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

When a quality gate fails, the harness retries the phase agent. Since bd-74 the
first two retries **resume the original session** rather than starting fresh, so
the agent can see what it already tried.

- **Attempts 1-2** reuse the initial session id (no new session file is
  created; pi appends to the existing transcript).
- **Attempt 3** starts a fresh `-retry-3` session; **attempt 4** resumes it.
- **Attempts 5/6, 7/8, 9/10** repeat that two-attempt epoch pattern
  (`-retry-5`, `-retry-7`, `-retry-9`).

Sessions for one phase therefore look like:

```
belayd-bd-42-sub-implement-a1b2c3            # initial spawn
                                             # attempts 1-2 append here
belayd-bd-42-sub-implement-a1b2c3-retry-3    # fresh epoch + its resume
belayd-bd-42-sub-implement-a1b2c3-retry-5    # fresh epoch + its resume
```

Retries stop after `MAX_GATE_ATTEMPTS = 10` total passes (1 initial + 9
retries); the final `-retry-9` session is created but never resumed. The
`IN_SESSION_RETRY_LIMIT = 2` and `MAX_GATE_ATTEMPTS = 10` constants bound
context growth.

A fresh epoch never sees the prior transcript, so it is re-supplied with the
original task (the bead plan for implement, the change context for proof) plus
every gate verdict so far. Resumed retries only carry the latest verdict.

## Review ↔ implement resume

Quality-gate retries resume within one phase run. The orchestrator-driven
review↔fix loop extends the same idea **across** phase runs: when
`belayd_review` reports findings, the orchestrator re-calls `belayd_implement`
and then `belayd_review`, and both phases resume the session they used
earlier instead of starting fresh. Only the `implement` and `review` phases
participate; every other phase keeps a fresh session per run.

Each phase's handle is recorded per `(taskId, phase)` in
`.belayd/workflow.json` under `phaseSessions`, so it survives turn boundaries
and orchestrator restarts (`resumeWorkflowFromDisk`). The ledger uses the same
bounded two-attempt epoch shape as intra-run gate retries, but under its own
`-run-<n>` namespace so a cross-run epoch can never collide with a gate retry's
`-retry-<n>` name. The invocation count is the attempt number:

| Invocation | Session | Mode |
|------------|---------|------|
| 1st | `belayd-{taskId}-sub-{phase}-{runId}` | fresh |
| 2nd | same base | resume |
| 3rd | same base | resume |
| 4th | `...-run-3` | fresh |
| 5th | `...-run-3` | resume |
| 6th | `...-run-5` | fresh |

So `IN_SESSION_RETRY_LIMIT = 2` means the base session is seen by at most
three passes before a fresh `-run-N` epoch bounds transcript growth.

On a cross-run resume the bead plan is **not** re-prepended to the implement
task — the transcript already has it — so the orchestrator supplies the review
findings to fix in the task text. A fresh epoch within a resumed run falls back
to the full built task (bead plan included). The harness runs the same on-disk
existence pre-check as the spawn layer, so a ledger entry whose session file
was deleted behaves as a fresh invocation (plan re-prepended) instead of
silently spawning a transcript-less session.

If a fresh `-run-<n>` epoch already exists on disk — e.g. a previous invocation
created it but failed to persist the ledger advance — the harness skips to the
next non-colliding odd epoch instead of spawning the stale name. Skipping
(rather than resuming the collision) keeps transcript growth bounded even while
the ledger write keeps failing.

### Orchestrator-driven loop

After `belayd_review` completes, the injected gate context no longer says
"Next required step: call `belayd_test`". While review findings are
outstanding it says:

> If any Critical/Warnings remain, call `belayd_implement` with those findings
> (it resumes the implementation session, so it sees its earlier work), then
> call `belayd_review` again (it resumes the review session) to verify. Only
> once no Critical/Warnings remain, call `belayd_test`.

The run-completion follow-up for a successful review carries the same loop
hint. The directive clears once a phase after review (`test`, `userguide`,
`proof`, `commit`) completes, and re-arms when review runs again later or
implement re-runs after review (a late fix loop). The flag is persisted in
`workflow.json` alongside the phase list, so it survives an orchestrator
restart.

Resume relies on pi's create-or-resume `--session-id`. If the target session
cannot be found on disk, spawn falls back to a fresh session (re-appending the
system prompt) and logs `[belayd-harness] resume requested for session ... but
it does not exist; starting a fresh session` once per spawn loop.

### Inspecting retry sessions

Sessions live under `~/.pi/agent/sessions/<project-slug>/` where the slug is
`--<abs-cwd-with-slashes-as-dashes>--`:

```bash
ls -lt ~/.pi/agent/sessions/--home-alice-code-myproject--/ | head
```

You can also use `pi --resume | grep belayd-bd-42`.

## Implementation Details

Session naming is implemented purely in `src/session-naming.ts`:

- `generateShortRunId()` — Base-36 timestamp
- `computeSubagentSessionName(taskId, phaseName, shortRunId)` — Subagent session name
- `computeOrchestratorSessionName(taskId)` — Orchestrator session name

The spawn logic in `src/spawn.ts` uses `--session-id` and `--name` CLI flags
(added in bd-10) instead of the deprecated `--no-session` flag.