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
  `documentation` = 3). `scout`/`plan` are **not** numbered required-step
  bullets.
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
/belayd bd-42                 # resolves workflow type from labels/title (default feature)
/belayd bd-42 bugfix --no-worktree
```

The workflow now starts at `implement`. The bead's description/design/notes are
the implementation plan — the implementer sub-agent receives that text
prepended to its task, so write the plan into the bead (via `/plan` or
manually) before implementing. If the plan is sparse or unclear during the
workflow, `belayd_scout` / `belayd_plan` remain callable as consultation (they
do not gate progress and are not required steps).
