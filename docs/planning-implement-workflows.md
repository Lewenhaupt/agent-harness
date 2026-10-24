# Planning (`/plan`) vs Implementation (`/belayd`) Workflows

bd-51 splits planning from implementation. `/plan` is a read-only,
worktree-free planning mode that writes implementation-ready beads; `/belayd`
starts an implement-first workflow where the bead's own description/design/notes
are the plan.

## How to Verify

### 1. Build and run the test suite

```bash
pnpm build          # tsc compiles src/ -> dist/
pnpm test           # 603 unit tests (includes extension-plan-command.test.ts)
pnpm test:integration  # 18 integration tests
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check .
```

All four must pass clean. The bd-51-specific coverage lives in
`src/__tests__/extension-plan-command.test.ts`,
`src/__tests__/bd-command.test.ts`, `src/__tests__/process-gate.test.ts`,
`src/__tests__/workflow-registry.test.ts`, and
`src/__tests__/agent-registry.test.ts`.

### 2. Set up a scratch repo with `bd` configured

Full `/plan -> open beads` behavior requires the shared Dolt bd server, so this
is manual e2e. Use a scratch git repo where `bd` talks to the shared server
(same as this repo; `bd prime` to confirm connectivity).

```bash
cd /tmp && mkdir plan-verify && cd plan-verify
git init && echo "export default {}" > index.ts
# confirm bd works against the shared server
bd ready
```

### 3. Verify `/plan "<description>"` (mode A — new bead)

In a pi session in the scratch repo, run:

```
/plan "Add a rate limiter to the API"
```

Confirm:

- **No worktree**: `git worktree list` is unchanged and no `feat/bd-*` branch
  or `.git/worktrees` entry appears (planning never calls `ensureWorktree`).
- **Tools are restricted**: the orchestrator's active tool set contains
  `belayd_plan_scout`, `belayd_plan_research`, `bd`, `read`, `grep`, `find`,
  `ls`, `ast_grep`, and the web tools — but **no `edit`, `write`, or `bash`**.
  (This is `PLANNING_GATED_TOOLS` in `extensions/index.ts`.)
- **Investigation runs read-only**: calling `belayd_plan_scout` /
  `belayd_plan_research` spawns background sessions named
  `belayd-planning-sub-scout-<runId>` / `belayd-planning-sub-research-<runId>`
  (`computePlanningSubagentSessionName` in `src/session-naming.ts`); their
  results arrive as `belayd-planning-run-complete` follow-ups.
- **New top-level bead created open/backlog**: after the orchestrator
  synthesizes, `bd list --status=open` shows the new bead. `bd show <id>` shows
  `## Overview / ## Steps / ## Test Strategy / ## Risks` in the description/
  design/notes, and the status is `open`/`backlog` (never `in_progress`).
- **No child beads**: if the plan was decomposed, the step beads are all
  top-level and linked via `bd dep <blocker> --blocks <blocked>` — none have a
  parent.
- **No `.md` plan file** was written into the repo.

### 4. Verify `/plan bd-x [focus]` (mode B — refine an existing bead)

With an existing open bead, run:

```
/plan bd-42
# or with a focus
/plan bd-42 "focus on the caching layer"
```

Confirm:

- The kickoff message instructs `bd show bd-42` to read the current content.
- After the run, `bd show bd-42` contains the refined plan in its
  description/design/notes.
- **The bead was not claimed and not moved**: `bd show bd-42` still reports
  `open`/`backlog` — the orchestrator never passed `--claim` or `--status`
  (both are rejected by `validateBdCommand`, see step 6).

### 5. Verify `/belayd bd-NN` starts at `implement` (not scout/plan)

In a scratch repo, create an open bead with a plan in its description, then:

```
/belayd bd-42 feature --no-worktree
```

(`--no-worktree` avoids the worktree + pi-web session daemon in a scratch
setup.) Confirm:

- The workflow message lists phases as `implement → review → test → userguide
  → proof → commit` (6 phases for `feature`; `bugfix`/`refactor` = 5,
  `documentation` = 2, `chore` = 3). `scout`/`plan` are **not** numbered required-step
  bullets.
- The `userguide` phase's deliverable is a file, not a report: the spawned task
  ends with a `## Deliverable` block naming `docs/<task-id>-userguide.md`, and
  `gateUserGuide` reads that file back from the worktree (see
  [docs/userguide-phase.md](userguide-phase.md)).
- The message says the bead's description/design/notes are the plan source, and
  that `belayd_scout` / `belayd_plan` are "available as consultation (NOT
  required steps)".
- The "Next required step" line points at `belayd_implement`.

To confirm the implementer actually sees the bead plan, put recognizable text
in the bead's description, run the implement phase, and inspect the spawned
sub-agent's task: it must be prefixed with `## Bead plan (bd-42)` followed by
the `bd show` output (the `readTaskPlan` prepend in `extensions/index.ts`).

### 6. Verify `bd` tool hardening

Inside a gated session (or directly via unit tests), the `bd` tool rejects:

```bash
bd create "x" --parent bd-42          # rejected: "Creating child beads (--parent) is not allowed"
bd link bd-1 bd-2 --type parent-child # rejected: "parent-child links are not allowed"
bd create "x" --status open           # rejected (create/update only)
bd update bd-42 --status in_progress  # rejected
bd update bd-42 --claim               # rejected
```

Still allowed: `bd list --status=open` (read subcommand), and
`bd update bd-42 --append-notes "..."` / `--description` / `--design` / `--notes`.

### 7. Verify the worktree handoff (bd-120)

Targeted suites (fast):

```bash
pnpm test extension-handoff            # 13 tests — src/__tests__/extension-handoff.test.ts
pnpm test workflow-state               # 36 tests — src/__tests__/workflow-state.test.ts
pnpm test extension-belayd-command     #  1 test  — caller/worktree layout in /belayd
pnpm test:integration workflow-handoff #  3 tests — test/workflow-handoff.integration.test.ts
```

Pass the filter as a bare positional (`pnpm test extension-handoff`). Adding
the `--` separator (`pnpm test -- extension-handoff`) forwards `-- extension-handoff`
to vitest, which then ignores the filter and runs everything.

Full gate:

```bash
pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
```

Expected totals: 76 unit files / **1721** unit tests, 6 integration files /
**61** integration tests, then a clean `tsc --noEmit` (`pnpm typecheck`),
`biome check .` (140 files) and `tsc` build.

#### Manual reproduction: caller hands off, then restarts

Needs a repo where `bd` talks to the shared Dolt server, plus `pi-web-sessiond`
running (the child orchestrator is created through the session daemon).

1. In worktree A, arm a workflow **in place** so the caller has something to
   hand off:

   ```
   /belayd bd-120 --no-worktree
   ```

   Expected: `Belayd feature workflow started for bd-120 (no worktree).` and the
   gate message `BELAYD WORKFLOW ACTIVE` on the next turn; `bash`/`write` are
   gated off, phase tools (`belayd_implement`, …) available.

2. Ask the agent for a follow-up:

   ```
   belayd_start_followup { "taskId": "bd-121" }
   ```

   `base` defaults to A's current branch, so from `main` you get `stacked on main`;
   from `feat/bd-120` you get `stacked on feat/bd-120` and a
   `Stack: feat/bd-120 → feat/bd-121 → main` line. Expected:
   - tool result: `Follow-up feature workflow started for bd-121 on feat/bd-121, stacked on main.`
     followed by `Stacked on main.` (or that resolved `Stack: …` line);
   - a displayed `belayd-handoff` message: `Handed off bd-121 to session
     belayd-bd-121 in feat/bd-121; you no longer drive a workflow. The new
     orchestrator owns this bead — do not start phase runs for it here.`;
   - a new `git worktree list` entry for a sibling `…feat-bd-121` worktree, with
     an orchestrator session named `belayd-bd-121` created inside it.

3. `belayd_status` in **A**:

   ```
   **Handed off** — bd-121 is owned by session `<child-daemon-id>` in worktree `feat/bd-121`; this session no longer drives a workflow.

   **Active runs**
   (none)
   ```

   There is no `**Process state for …**` block, no phase checklist, and no
   `Next required step` line — the caller is not driving anything. Contrast with
   a live workflow, whose first section is `**Process state for bd-100**`
   followed by `✅`/`⬜` phase bullets.

4. Restart the caller in the same directory and resume the same session:

   ```bash
   pi --continue
   ```

   Expected: **no** `BELAYD WORKFLOW ACTIVE` gate message on the next turn,
   full tool set restored, and `belayd_status` still starts with `**Handed off**`.
   The handed-off workflow does not resurrect, even though
   `.belayd/workflow.json` still exists.

5. Control: in a worktree whose `.belayd/workflow.json` has no `handedOffTo`
   field and no `.belayd/handoff-*.json` file, restarting the same way **does**
   resume: the gate message `BELAYD WORKFLOW ACTIVE` names the bead and the
   gated tool set is restored.

#### Inspect the markers on disk

```bash
jq '.handedOffTo' .belayd/workflow.json
# { "taskId": "bd-121", "branch": "feat/bd-121", "sessionId": "<child-daemon-id>" }
# (absent for a same-directory handoff: the child owns this file)

ls .belayd/handoff-*.json
# .belayd/handoff-<caller-session-id>.json

jq . .belayd/handoff-<caller-session-id>.json
# { "taskId": "bd-121", "branch": "feat/bd-121", "sessionId": "<child-daemon-id>" }
```

The caller-scoped file is authoritative on `session_start`; `handedOffTo` in
`workflow.json` is the secondary record that a *different* session in that
directory reads. Deleting stale markers restores normal resume behaviour.

## How to Use

### Plan new work (mode A)

```
/plan "Add rate limiting to the API gateway"
```

The planning orchestrator investigates with `belayd_plan_scout` (fast codebase
recon) and `belayd_plan_research` (deeper questions), then writes a finalized
plan into one or more **new top-level beads** using:

```bash
bd create "Title" --description="..." --design="..." --notes="..." --type=task --priority=2
```

Large work is decomposed into multiple top-level step beads linked with:

```bash
bd dep <blocker-id> --blocks <blocked-id>   # unambiguous direction
# or bd dep relate <a> <b> for a bidirectional relation
```

Never `--parent` / `parent-child`, never `--status` / `--claim` — beads stay
open/backlog for a human to pick up.

If the request is ambiguous (scope, acceptance criteria, approach, key design
decisions), the orchestrator asks focused clarifying questions **before**
writing the plan — as one structured `ask_user` form when that tool is
available, otherwise in a single message — and waits for the answers. Planning
is only complete once the new bead has been created; the orchestrator never
ends with a menu offering to \"settle decisions\", \"write the plan\", or
\"start implementation\".

### Refine an existing bead's plan (mode B)

```
/plan bd-42
/plan bd-42 "focus on the auth token refresh path"
```

The orchestrator runs `bd show bd-42` first, then writes the refined plan back
via `bd update bd-42 --description="..." --design="..." --notes="..."`. The
bead is not claimed or moved out of open/backlog. As in mode A, ambiguity is
resolved with clarifying questions up front and the run is not complete until
the same bead has been updated.

### Exit planning

- `belayd_stop_planning` — aborts any in-flight planning runs and restores full
  tools.
- Or start implementation with `/belayd bd-NN` (or `belayd_start_task`), which
  resets planning state.

### Implement from a bead (the new `/belayd` flow)

```
/belayd bd-42                 # uses the bead's wf:<type> label, else feature
/belayd bd-42 bugfix --no-worktree
```

The workflow now starts at `implement`. The bead's description/design/notes are
the implementation plan — the implementer sub-agent receives that text
prepended to its task, so write the plan into the bead (via `/plan` or
manually) before implementing. If the plan is sparse or unclear during the
workflow, `belayd_scout` / `belayd_plan` remain callable as consultation (they
do not gate progress and are not required steps).

### Worktree handoff (bd-120)

Both `/belayd bd-NN` (without `--no-worktree`) and
`belayd_start_followup` create a **new orchestrator session** in a new worktree
and then hand the workflow over. The calling session stops driving it:

- its gate is disarmed (full tool set restored), phase/proof state is cleared,
  and any in-flight phase runs are aborted (their watchers are invalidated by
  the run-epoch bump, so a late settle delivers nothing);
- the handoff is recorded in `.belayd/handoff-<sessionId>.json`, a
  **caller-scoped** marker keyed by the calling session. It is consulted first
  on `session_start`, so a restart does **not** re-activate the workflow. When
  the child runs in a different worktree the caller's `.belayd/workflow.json`
  also gets `handedOffTo: { taskId, branch, sessionId }`; that record is
  secondary (a new session in that directory sees it) because a same-directory
  child overwrites `workflow.json` with its own workflow;
- `belayd_status` reports `Handed off` instead of a live workflow, and lists
  caller leftovers that could not be applied (interrupted runs, pending user
  completions marked delivered without applying them);
- starting a new task (or `belayd_stop_task`) clears both markers, and a
  failure to clear them is surfaced instead of silently blocking a restart.

Two launches are refused unless forced:

1. a launch while the caller still has phase runs in flight — the error names
   each live run;
2. a launch **from inside the target worktree** (`/belayd bd-NN` while already
   on `feat/bd-NN`, e.g. retrying after the child died) — one session per
   worktree, because the child would share and overwrite the caller's
   `workflow.json`.

Pass `force: true` to `belayd_start_followup` or `/belayd bd-NN --force` to
override either refusal. A forced same-directory handoff is explicit: the
child replaces `workflow.json` with its own fresh state, and only the
caller-scoped marker records the handoff (a different session in that directory
will legitimately arm the child's workflow). If the caller-scoped marker cannot
be written, the handoff aborts, the caller stays armed, and the error names the
created child session so it can be stopped before a retry.

#### Handing off on purpose

`belayd_start_followup` (and `/belayd bd-NN` without `--no-worktree`) is the
normal way to move a bead into its own worktree. Use `force` when the guards are
in the way on purpose:

```text
belayd_start_followup { "taskId": "bd-121", "base": "feat/bd-120", "force": true }
```

```text
/belayd bd-121 --force
```

`force: true` / `--force` means:

- a phase run still in flight is **abandoned** — its abort controller fires, the
  run-epoch bump invalidates its watcher, so a late completion delivers nothing
  into the caller (no `belayd-run-complete` message);
- a launch from inside the target worktree is allowed (the child then owns the
  shared `.belayd/workflow.json`).

Without `force`, a launched follow-up leaves the bead untouched: the
`wf:<type>` label is written only *after* the guards pass.

`/belayd bd-NN --no-worktree` is **not** a handoff: it arms the gate in place,
keeps the phase tools, and creates no child session. Use it when you deliberately
want one session to drive the workflow in its own directory.

#### What the caller sees afterwards

1. A displayed handoff message (`customType: "belayd-handoff"`):

   > Handed off bd-121 to session belayd-bd-121 in `feat/bd-121`; you no longer
   > drive a workflow. The new orchestrator owns this bead — do not start phase
   > runs for it here.

   `belayd_start_followup` also returns
   `Follow-up <type> workflow started for bd-121 on feat/bd-121, stacked on <base>.`
   and `/belayd` notifies `Belayd <type> workflow started for bd-121 (feat/bd-121).`

2. The gate is gone: full tool set restored (including `bash`/`write`), phase
   tools no longer fenced, and **no** `BELAYD WORKFLOW ACTIVE` message on
   subsequent turns. The caller does not run `belayd_implement` / `belayd_review`
   for that bead — the child session does.

3. `belayd_status` reports the handoff instead of a workflow:

   ```
   **Handed off** — bd-121 is owned by session `<child-session-id>` in worktree `feat/bd-121`; this session no longer drives a workflow.

   **Active runs**
   (none)
   ```

   A live workflow prints `**Process state for bd-121**` plus the `✅`/`⬜` phase
   checklist instead.

4. If the restarted caller found leftovers it could not apply, an extra section
   appears (this is the `handoffPendingNotice` line):

   ```
   **Pending items from the handoff** — Handed off to bd-121: 1 interrupted phase run(s): mve8kvax (implement); 1 pending user completion(s) marked delivered without applying them (this session no longer drives bd-121): mve8bjtc (review).
   ```

   Interrupted runs are flipped to `interrupted`; pending user completions are
   marked delivered (they cannot be applied by a session that no longer owns the
   bead). Undeliverable ones are listed with the error instead. The same text is
   logged to stderr as `[belayd-harness] …`. Settling is skipped when the
   directory still owns the *same* task (a same-directory handoff: those runs
   belong to the child).

#### Refusals and how to proceed

In-flight phase run(s):

```
Cannot launch a child workflow while this session has phase runs in flight: `mve8kvax` (scout for bd-120). Wait for their follow-up results, or pass force: true (--force for /belayd) to abandon them and hand off anyway.
```

Same worktree (already on `feat/bd-121`):

```
Refusing to launch a workflow for `feat/bd-121`: this session is already inside that worktree, and the workflow state file would be shared, so a second orchestrator would fight this one over the same branch. One session per worktree: launch from the parent worktree (or main), or pass force: true (--force for /belayd) to hand off here anyway — a forced same-directory handoff replaces this session's workflow.json and records the handoff in .belayd/handoff-<sessionId>.json instead.
```

Proceed by either waiting for the live runs (or stopping them), moving to the
parent worktree and launching from there, or re-running with `force`. A refused
launch has no side effects: no `wt` worktree switch, no `/sessions` POST, no
label write, and the caller stays armed.

#### Marker files

| File | Written by | Read by | Cleared by |
| --- | --- | --- | --- |
| `.belayd/workflow.json` → `handedOffTo: { taskId, branch, sessionId }` | `launchWorktreeWorkflow` via `saveHandedOffMarker` (skipped for a same-directory child, which owns this file) | `resumeWorkflowFromDisk` on `session_start` | `activateGate` (new task), `belayd_stop_task`, workflow completion |
| `.belayd/handoff-<callerSessionId>.json` → `{ taskId, branch, sessionId }` | `writeCallerHandoff` (authoritative; sanitized session id) | `resumeWorkflowFromDisk`, consulted **before** `workflow.json` | `activateGate` (new task), `belayd_stop_task` |

`sessionId` is the daemon session id of the child (the id pi-web shows), not the
readable name `belayd-bd-121`. Both files are optional to parse: a
`workflow.json` written before bd-120 still loads, and a corrupt
`handoff-*.json` is treated as absent.

#### Recovering a stuck or half-finished handoff

- **Child session exists but never received its prompt** (`POST
  /sessions/<id>/prompt` failed). The tool returns exit 1 with:

  ```
  Created session <id> for bd-121 but could not send it the workflow prompt (<error>). The child has no work queued; stop/delete session <id> before retrying, so a retry does not leave two orchestrators behind.
  ```

  The caller stays armed (no marker, no disarm), so: stop/delete session `<id>`
  in pi-web (or `systemctl`/UI session list), then retry the launch.

- **Handoff marker could not be written** (read-only `.belayd`, full disk). Exit
  1 with: `Created orchestrator session <id> for bd-121 but could not persist the
  handoff marker (<error>); the caller stays armed. Stop session <id> and retry,
  or check write access to <cwd>/.belayd.` Fix the permission and retry; the
  caller is still armed, so nothing else needs repair first.

- **Caller is done with the bead and wants its tools back / markers gone**: run
  `belayd_stop_task`. It returns `Belayd process deactivated.`, clears
  `.belayd/workflow.json` and this session's `.belayd/handoff-<sessionId>.json`,
  and drops the in-memory marker so `belayd_status` stops reporting a handoff
  without a restart. Caveat: in a **forced same-directory** handoff that
  `workflow.json` belongs to the child orchestrator, so stopping the caller from
  that directory also deletes the child's state; prefer stopping the child
  session itself there.

- **A restarted session still refuses to resume a workflow you are driving**
  (stale marker after a crash): inspect and remove it by hand —
  `jq '.handedOffTo' .belayd/workflow.json` and
  `ls .belayd/handoff-*.json` — then delete only your own session's file
  (`rm .belayd/handoff-<your-session-id>.json`). A failed clear during
  `activateGate`/`belayd_stop_task` is surfaced as a `belayd-error` message
  naming the file, so it is not silent.

### Workflow type resolution (explicit signals only, bd-106)

A non-default workflow type is chosen **only** by:

1. an explicit type argument (`/belayd bd-42 bugfix` for the command, or the
   `workflowType` parameter for the `belayd_start_task` / `belayd_start_followup`
   tools), or
2. a namespaced `wf:<type>` bead label, e.g. `wf:chore`, `wf:bugfix`.

Precedence is argument > `wf:<type>` label > `feature`. Title keywords and
plain labels (including `chore`, `bug`, `investigation`) are **ignored** — an
incidental word like `CI` in a title must never silently demote a task. When a
`wf:` label drives the choice, `/belayd` shows the resolved type, its phases,
and whether proof is required, and asks you to **confirm**, **choose another
type**, or **cancel**. Cancel aborts with no side effects. After confirmation
the type is written back to the bead as a `wf:<type>` label (skipped when
already present) and recorded, with provenance, in `.belayd/workflow.json`.

A tool call (`belayd_start_task` / `belayd_start_followup`) has no interactive
UI, so a `wf:`-driven type cannot be confirmed there: the tool denies with a
needs-confirmation message and starts nothing, rather than silently defaulting.

**Migration note.** Existing beads whose type came from a plain `chore` /
`bugfix` / ... label no longer resolve to that type — they now default to
`feature`. To preserve them, do a one-time relabel, e.g.
`bd update <id> --add-label wf:chore` (and `--remove-label chore`).

## Phase-model trim (bd-139)

Measured from the session corpus (957 sessions), three phases cost more than the
signal they returned, so the registry changed. Each change is a registry entry,
not a gate rewrite: re-enabling one is a one-line edit in
`src/workflow-registry.ts`.

| Change | Why |
|---|---|
| `refactor` no longer runs `userguide` | a refactor keeps the user-facing contract; when it changes, the work is a feature. `feature` still requires the guide. |
| `documentation` is `implement → commit` | a docs change is already a valid proof skip reason (`doc-only`), so its proof phase could only restate that. `proofRequired` is now `false`. |
| `chore` is `implement → test → commit` with `plan` consultable | a dependency bump or config tidy rarely benefits from a frontier-model plan step. `plan` stays callable as a consultation phase. |
| implement gate = `gateStaticValidation` wherever a `test` phase exists | `gateFullValidation` ran `pnpm test` in the implement gate and `gateTests` ran it again in the test gate — the same suite twice per workflow. Static validation (typecheck + lint) fails fast on broken code; the suite runs once, in the test phase. |

Trade-off to know: an implementer that breaks tests is now caught at the test
phase instead of immediately, so a broken implementation costs one extra agent
run before it fails. Workflows without a test phase (`documentation`, `research`)
keep their existing validation, because there it is the only validation.

Verify with `pnpm test` — `src/__tests__/workflow-registry.test.ts` pins each
phase list and asserts the "test phase ⇒ static implement gate" invariant, so a
future workflow that reintroduces the double run fails the suite.
