# Fleet supervisor (bd-126)

One conversational entry point — `/fleet bd-12 bd-15 bd-19` — that takes several
beads at once, decides order and parallelism, runs each as a normal Belayd
workflow in its own worktree, notifies members when premises change (base moved,
sibling landed, rebase due), merges finished work into `main`, and stays
interruptible so the operator can pause or redirect at any time.

This is the design record. Today only **P0** exists: `belayd_fleet_status`, a
read-only aggregation of every worktree's workflow state. P1–P4 are planned.
For operator-facing usage — invoking it, reading the output, decoding every
warning, and verifying the read-only contract — see `docs/fleet-status.md`.

## What exists today

`/belayd bd-NN` creates a worktree, writes a handoff packet, and spawns one
detached orchestrator per bead, pinned by the bd-119 ownership preflight
(`docs/owned-worktree.md`). No tier knows about two beads at once, so cross-bead
ordering, conflict prediction, rebase signalling and merging are manual.

The fleet supervisor sits above that tier. It does not replace it: every member
is still a normal single-bead orchestrator with its own process gate, its own
worktree, and its own `.belayd/` directory.

## Architecture: a scheduler, never a phase worker

The supervisor is a scheduler.

- **One process gate = one bead = one worktree.** That invariant stays intact;
  the supervisor never runs a phase, never calls a phase tool, and never owns a
  worktree's `.belayd/workflow.json`.
- **Fleet mode arms no gate.** A fleet session installs no process gate and
  hard-refuses the phase, proof, and commit tools with a fleet-specific message
  instead of silently behaving like an orchestrator.
- **Fleet state is shared, worktree state is not.** Everything cross-tree lives
  under `<git-common-dir>/belayd/fleet/<fleetId>/`; per-bead state stays in that
  bead's worktree.
- **Supervisor working directory is the main repo root.** `main` can only be
  checked out in the root, so merges happen in the operator's own checkout.
- **Members are detached pi sessions**, so messaging is files-first: notes are
  written as files and drained at the start of the next turn. There is no
  in-memory cross-session channel to rely on.

```
operator (/fleet bd-12 bd-15 bd-19)
  │   supervisor session, cwd = main repo root, no process gate
  ├── fleet state: <git-common-dir>/belayd/fleet/<fleetId>/
  │     fleet.json  inbox/  events/  merge-queue.json  audit.log
  ├── member bd-12:  worktree <repo>.feat-bd-12  (normal orchestrator + gate)
  ├── member bd-15:  worktree <repo>.feat-bd-15  (normal orchestrator + gate)
  └── member bd-19:  worktree <repo>.feat-bd-19  (normal orchestrator + gate)
```

## Shared state layout

`<git-common-dir>/belayd/fleet/<fleetId>/` is the only cross-worktree location.
`git-common-dir` is resolved with the same probe `resolveRepoKey` uses
(`src/worktree.ts`), so every linked worktree of one repository agrees on it.

| Path | Purpose | Written by |
|------|---------|------------|
| `fleet.json` | Operator intent: fleet id, task ids, requested concurrency ceiling, paused flag, note | P1+ (P0 only reads it if a human put it there) |
| `inbox/` | Member → supervisor notes, drained at turn start | P1 |
| `events/` | Supervisor → member notifications (base moved, rebase due, sibling landed), drained at turn start | P1 |
| `merge-queue.json` | Single-flight merge queue | P2 |
| `audit.log` | Append-only audit of every cross-tree authority action | P2+ |

### Status is derived, never stored

There is no fleet status file. `belayd_fleet_status` computes the view from:

1. each worktree's `.belayd/workflow.json` (task id, workflow type, branch,
   `phaseOrder`, `completedPhaseNames`, `awaitingReviewResponse`, `updatedAt`),
2. each worktree's `.belayd/runs/*.json` run manifests (latest run per phase,
   `RunStatus`, interrupted runs),
3. the optional `fleet.json` intent record,
4. `bd` for anything task-tracking-related (P1+; P0 makes no bd calls).

A stored status file would drift from those four sources the moment a member
writes anything; deriving it keeps the supervisor honest by construction.

## Locked decisions

| Question | Decision |
|----------|----------|
| Concurrency ceiling | 3 concurrent orchestrators (**not** 3 total agents — sub-agents do not count) |
| Supervisor working directory | main repo root |
| May merge to `main`? | Yes, through a single-flight queue |
| Dirty root at merge time | auto-stash, immediately restore; if the restore conflicts, park the fleet instead of losing work |
| Bead status after merge | left `in_progress` + `human`; the human closes via `wt merge` (merging ≠ closing) |
| Member communication | files-first mailbox, drained at turn start (members are detached pi sessions) |
| Where merges happen | the operator's own checkout, because only the root can check out `main` |

## Constraints

- **Fleet mode arms no gate.** It hard-refuses the phase, proof, and commit
  tools with a fleet-specific message. A fleet session must never look like an
  orchestrator.
- **Cross-tree authority exists only in the fleet tool family.** No phase tool,
  proof verifier, or commit path gains the ability to reach into another
  worktree. Every cross-tree action is appended to `audit.log`.
- **bd-119 refusals are unchanged.** Phase, commit, and proof tools still refuse
  a worktree whose `.belayd/workflow.json` (or checked-out branch) belongs to
  another task.
- **P0 adds no authority at all.** It observes; it does not schedule, notify,
  merge, spawn, stash, or mutate beads.

## Milestones

| Milestone | Scope | Status |
|-----------|-------|--------|
| **P0** | `belayd_fleet_status` — read-only aggregation of every worktree's workflow (state file + run manifests + optional intent) into one derived view. No new authority. | **Implemented** (`src/fleet-status.ts`) |
| **P1** | `belayd_fleet_launch` on explicit instruction + file mailbox (`inbox/`, `events/`) for notes and rebase hints. | Planned |
| **P2** | Single-flight merge queue + base-moved propagation (`merge-queue.json`, `audit.log`). | Planned |
| **P3** | Automatic ordering/parallelism + capacity-aware concurrency (ceiling 3 orchestrators). | Planned |
| **P4** | Cooperative/forceful pause + fleet-level crash reconcile. | Planned |

## P0 read-only contract

`belayd_fleet_status` (and `readFleetStatus` behind it) is a pure observer
everywhere, including inside a member worktree — it never acts with special
authority.

**Reads**

| Source | How |
|--------|-----|
| `<git-common-dir>` | one `git rev-parse --path-format=absolute --git-common-dir` probe |
| Worktree list | one `git worktree list --porcelain -z` probe (git >= 2.36); the line-oriented form is a fallback for older git |
| `<git-common-dir>/belayd/fleet/<fleetId>/fleet.json` | optional; absent or corrupt is treated as "no intent" |
| `<worktree>/.belayd/workflow.json` | one read per worktree; missing and corrupt are reported as warnings |
| `<worktree>/.belayd/runs/*.json` | `listRuns` per worktree; unreadable manifests are skipped |

**Writes**: none. P0 creates no fleet directory, writes no `fleet.json`, no
`audit.log`, no run manifest, and no `.belayd` state.

**Git**: only the two read-only probes above. P0 never runs a mutating git
command (no merge, rebase, stash, checkout, commit, worktree add/remove).

**Process**: no spawns, no gate arming, no `bd` mutation. `beads` data is left
entirely to P1+.

### The derived view

`formatFleetStatus` renders the plain-text view (no ANSI, members sorted by task
id, members without state last by path). The structured object carries the same
data.

Per member:

| Field | Source |
|-------|--------|
| `taskId` | `workflow.json` `taskId` (`undefined` when unreadable) |
| `expectedTaskId` | task id implied by the checked-out branch, else by the worktree directory name |
| `worktreePath`, `branch` | `git worktree list --porcelain -z` |
| `workflowFile` | `ok` / `missing` / `corrupt` |
| `workflowType`, `phaseOrder` | `workflow.json` |
| `completedPhases`, `pendingPhases` | `phaseOrder` minus `completedPhaseNames` |
| `awaitingReviewResponse` | `workflow.json` flag (absent means `false`) |
| `latestRuns` | newest manifest per phase, ordered by phase order |
| `interruptedRunCount` | manifests with `RunStatus.Interrupted` |
| `updatedAt` | `workflow.json` `updatedAt`, raised to the newest run timestamp when later |
| `state` | derived, see below |

Derived `state` precedence:

| State | Meaning |
|-------|---------|
| `missing-state` | no readable `.belayd/workflow.json` |
| `interrupted` | at least one run manifest is `interrupted` |
| `awaiting-human` | `awaitingReviewResponse` is set, or a user-completed run's report was never delivered |
| `blocked` | the newest run of a not-yet-completed phase `failed` |
| `idle` | every phase in `phaseOrder` completed |
| `active` | anything else (workflow in progress; a running phase counts here) |

Fleet-level warnings:

| Warning | Trigger |
|---------|---------|
| `missing-workflow-state` | a linked worktree has no `.belayd/workflow.json` |
| `corrupt-workflow-state` | `workflow.json` exists but does not parse as a workflow state |
| `duplicate-task-id` | two worktrees record the same `taskId` |
| `task-id-mismatch` | `workflow.json` `taskId` disagrees with the branch (or directory name) |

The repository's own checkout is skipped while it has no workflow state: it is
the supervisor's merge target, not a member. An in-place (`--no-worktree`)
workflow in the root *does* join the fleet, because it holds workflow state.

## Purity boundary

`src/fleet-status.ts` splits reading from computing:

- `readFleetStatus` is the only function that touches fs or git. It takes an
  injected fs seam plus seams for the git-common-dir probe and worktree
  enumeration. It sanitizes the caller-supplied fleet id once and passes that
  same id both to the file lookup and to `buildFleetStatus`, so the rendered
  `Fleet <id>` always names the directory that was actually read. A raw id that
  sanitizing changed is reported separately as `requestedFleetId`
  (`Fleet default (requested "../evil")`), never used as the primary id.
- `buildFleetStatus`, `deriveFleetMemberState`, `parseFleetIntent`, the path
  helpers, and `formatFleetStatus` are pure: same input, same output, no mocks
  needed in tests (`src/__tests__/fleet-status.test.ts`). Ordering uses code-unit
  comparison and the latest-run rule uses a total `(startedAt, runId)` order, so
  neither host locale nor `readdirSync` order can change the view.
- `parseWorktreeListPorcelainZ` / `parseWorktreeListPorcelain` live in
  `src/worktree.ts` (shared with `listWorktrees`); the reader consumes their
  already-parsed entries. `-z` is the primary form because git does not
  C-quote porcelain values: a path containing a newline is legal and only NUL
  separators keep it inside one `worktree` value. The line-oriented fallback
  skips such a record and reports an `unparsed-worktree-path` warning instead of
  using a truncated path that would read as `missing-workflow-state`.

## Related documentation

- `docs/fleet-status.md` — operator guide for the P0 tool: invocation, field and
  state decoding, warning triage, and the read-only/determinism verification
  steps.
- `docs/owned-worktree.md` — the bd-119 bead ↔ branch ↔ worktree preflight that
  keeps one gate, one bead, one worktree intact.
- `docs/subagent-sessions.md` — `belayd-<taskId>` orchestrator session naming,
  used to address a member session.
- `docs/planning-implement-workflows.md` — the per-bead workflow the supervisor
  schedules without running.
- `docs/model-capacity-and-telemetry.md` — per-worktree run manifests under
  `.belayd/runs/` and the telemetry the derived view reads.
