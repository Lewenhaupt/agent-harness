# Fleet run loop — `/fleet` to completion (bd-126 P5)

`/fleet bd-12 bd-15 bd-19` no longer stops after the first wave. The supervisor
lands every member as it finishes, accepts it (closes the bead and removes the
worktree), starts the next wave as dependencies clear, and keeps going until the
whole request is landed — or until a member needs a human.

Two things changed, and they are coupled:

1. **A run loop.** A durable run record plus a deterministic tick decide the next
   action; the supervisor session runs the ticker.
2. **A worktree lease.** One orchestrator per worktree is now enforced by a
   heartbeat-bearing lease in the worktree, not by a process-table scan that a
   pi-web session can never satisfy.

| Piece | Module |
|---|---|
| Tick decisions, run record, rendering | `src/fleet-run.ts` |
| Accepting a landed member (close + remove) | `src/fleet-accept.ts` |
| Supervisor heartbeat + re-arm eligibility | `src/fleet-heartbeat.ts` |
| Worktree orchestrator lease | `src/orchestrator-claim.ts` |
| Wiring (ticker, launch, tools, `/fleet`) | `extensions/index.ts` |

## How to Use

### Start a run

```text
/fleet bd-12 bd-15 bd-19                 # run to completion, accepting each member
/fleet bd-12 bd-15 --no-accept           # land, but leave the beads for you to close
/fleet bd-12 bd-15 --manual              # the old explicit surface: nothing merges or advances on its own
/fleet bd-12 bd-15 --fleet night          # name the fleet (or re-arm one)
```

Tool form:

```json
{ "tasks": ["bd-12", "bd-15"], "untilComplete": true, "accept": true }
```

The launch itself is unchanged (validate → write intent → launch wave 0 →
prune failures). What changes is what happens next: the launch writes a `run`
record into `fleet.json` and starts the ticker.

### What "complete" means

A run is complete when every member is **landed** (its branch is on the base
branch) and out of the fleet's member list. With `accept: true` (the default)
"landed" also means the bead is closed and the worktree is gone. With
`accept: false` the bead stays `in_progress` + `human` for you, and the worktree
stays on disk — the run still finishes, because a member the fleet landed
satisfies its dependents' dependency edges (see below).

If a member stops for a reason the loop must not retry, the run ends as
`partial` and `belayd_fleet_status` lists each stopped member with its reason.

### Watch it

```text
belayd_fleet_status
```

New lines in the view:

```text
Fleet default
  intent: bd-12, bd-15, max 3 concurrent
  deferred: bd-19 (dependency)
  run: until-complete — 7 tick(s), last tick 2026-10-25T18:04:11.000Z
  stopped bd-15 (phase-failed): phase review failed: gate failed
  members: 1
  ...

Member bd-12 — active
  worktree: /repo.feat-bd-12 (branch feat/bd-12)
  orchestrator lease: session 01a173fc-… for bd-12, renewed 2026-10-25T18:04:09.000Z
  ...
```

- `orchestrator lease: none` is a member whose workflow state exists but whose
  session never claimed the worktree (an older launch, or a session that is gone).
- The run line is clock-free (absolute timestamps only), so two reads of unchanged
  files are byte-identical.

### Stop and resume

```text
belayd_fleet_pause { "reason": "stepping away" }   # stops the ticker at its next tick
belayd_fleet_resume { }                            # restarts the same run
```

A **paused** run is not finished: the ticker stops, the run record stays live, and
`resume` starts the ticker again. A **parked** or **stalled** run is halted and
recorded (`haltedReason`), because both need a human:

- `parked` — the root checkout could not be restored after a merge (reconcile,
  then resume).
- `stalled` — `FLEET_RUN_MAX_IDLE_TICKS` ticks with no progress (240 at the 15 s
  interval). The run stops instead of spinning; the record names the members still
  in flight.

Kill the loop without touching the fleet's flag by closing the supervisor session
(`session_shutdown` clears the timer). The run record survives, and a later
`/fleet <ids> --fleet <id>` re-arms and resumes it.

### Recover after the supervisor dies

A run-mode supervisor writes a heartbeat (`supervisor.json` in the fleet
directory) on every tick. That heartbeat — not the recorded pid — decides whether
another session may re-arm:

```text
/fleet bd-12 bd-15 --fleet default       # re-arm; members are preserved, then the loop resumes
```

Why the heartbeat: a pi-web supervisor is a session inside the shared session
daemon, so the recorded `pid` is the daemon and stays alive after the supervisor
session is gone. Without the beat, a re-arm would be refused forever ("a live
supervisor holds this fleet") and nothing would tick. The beat only applies to
fleets that have a run record, so an explicit (`--manual`) fleet keeps the old
pid rule and an upgrade cannot steal it.

## How the tick decides

One action per tick, in this order (`src/fleet-run.ts`):

| Order | Action | When |
|---|---|---|
| 0 | `halt` | the fleet is paused (`resume` restarts) or parked (needs a human) |
| 1 | `land` | the first member whose workflow is complete (all phases done, or a completed final-phase run with no state file) |
| 2 | `stop` | the first member that needs a human: `awaiting-human`, `phase-failed`, `phase-interrupted`, `state-corrupt`, or `orchestrator-missing` |
| 3 | `advance` | nothing to land or stop and the deferred list is non-empty |
| 4 | `complete` | no members and no deferred work (`partial` when something stopped) |
| 5 | `wait` | members are working — unless the idle cap is reached, then `halt`/`stalled` |

Landing first is deliberate: it frees a capacity slot and unblocks dependents in
the same tick. Stopping second is the safety property: **a member that stopped is
never relaunched by the loop.** A vanished orchestrator is reported for a human,
not retried, because the retry is exactly what started a second orchestrator on
one worktree before the lease existed.

### The run record

`fleet.json` gains one optional field:

```json
"run": {
  "schemaVersion": 1,
  "mode": "until-complete",
  "startedAt": 1792947202544,
  "updatedAt": 1792947309781,
  "ticks": 7,
  "accept": true,
  "members": [
    { "taskId": "bd-36", "launchedAt": 1792947202544, "sessionId": "01a1734e-…", "landedAt": 1792947309781 }
  ],
  "stopped": [{ "taskId": "bd-15", "reason": "phase-failed", "detail": "…", "at": 1792947309781 }],
  "idleTicks": 0,
  "finishedAt": 1792947400000,
  "outcome": "complete"
}
```

- `members[].launchedAt` is the start-grace window's reference: a member that shows
  no state and no runs for `FLEET_RUN_START_GRACE_MS` (2 min) is declared missing
  rather than waited on forever.
- `landedAt` is what makes landing idempotent across ticks and supervisor restarts,
  and what satisfies dependents' edges before the bead is closed.
- A new launch on a fleet with a live run adds members to it instead of starting a
  second run.

## Landing and accepting

`land` runs the unchanged merge queue (`belayd_fleet_merge`'s engine): enqueue the
member's branch, acquire `merge.lock.d`, stash a dirty root, rebase, run the
project gates, `git merge --ff-only`, restore the root, notify members.

Then acceptance (`src/fleet-accept.ts`), only when `accept` is true:

1. `bd close <id> --reason "merged into <base> via belayd_fleet_merge"`. A bead that
   is already closed is accepted with a warning, not an error.
2. `git worktree remove <path>` — **without `--force`**, so a dirty worktree is left
   alone and reported; the accepting step never deletes uncommitted work.
3. `git branch -d <branch>` — `-d`, not `-D`, so an unmerged branch is never
   deleted.

A failure to close the bead stops the member with `accept-failed` but keeps the
landing: the branch is on the base branch, the member is out of the member list,
and the residue is the bead (or the worktree) you have to finish by hand.

**Bead status after a run.** `belayd_fleet_merge` still never touches a bead.
Closing is the *run's* acceptance step, requested by the launch (`accept: true`),
and it is audited as `fleet-landed`. Use `--no-accept` to keep the documented
human-accept step.

### Dependency edges vs. landed members

bd reports a blocking edge until the blocker bead is `closed`. A run that lands a
member without closing it (or between the merge and the close) therefore has to
answer the edge itself: `belayd_fleet_launch`'s dependency lookup drops an edge
whose blocker is in the run's `landed` set. The premise the edge encodes — "that
work is on the base branch" — is true; the edge is bookkeeping that the run has
already discharged, and it is still recorded in bd.

## One orchestrator per worktree

### The lease

`.belayd/orchestrator.json` in every worktree:

```json
{
  "schemaVersion": 1,
  "taskId": "bd-37",
  "branch": "feat/bd-37",
  "sessionId": "01a173fc-…",
  "pid": 2836450,
  "claimedAt": 1792947202544,
  "heartbeatAt": 1792947222544
}
```

- **Created by the spawner** before the session exists, as
  `pending:<uuid>` (the session id is only known after the daemon returns it).
- **Adopted by the orchestrator session** on `session_start` (the pending lease
  belongs to the first session that starts in that worktree), then pointed at the
  real session id.
- **Renewed every 20 s** by a timer in that session's extension, and removed on
  `session_shutdown`.
- **Cold after 9 missed renewals** (3 min). A cold lease can be taken over: the old
  record is archived beside it as `orchestrator.stale-<ts>.json`, never deleted, and
  the extension reports the takeover.

The lease is the only honest liveness signal for this runtime: a pi-web
orchestrator is a session inside the daemon, so no process carries a
`belayd-<taskId>` token and a process-table scan reports every live member as gone.

### What it refuses

| Situation | Behavior |
|---|---|
| A second launch into a worktree with a live lease | Refused before any session is created (`Refusing to launch … live orchestrator lease`) |
| A session starting in a worktree another live session owns | Gate not armed (`Refusing to drive …`), so it cannot run phases or write the ledger |
| A session whose `session_start` finds a pending lease | Adopts it (the spawner's session) |
| A cold or unreadable lease | Taken over, archived, audited, and reported |
| Losing the lease (taken over, deleted, or unwritable) | The session stops renewing, **disarms its process gate**, and reports it: phase tools refuse rather than race the session that now owns the worktree |

### Reconcile and prune

`belayd_fleet_reconcile` classifies each member from the lease **and** the process
table:

| Evidence | Verdict | Prune? |
|---|---|---|
| fresh lease | `live` | never |
| no fresh lease, but a process carries `belayd-<taskId>` | `live` | never |
| no fresh lease, no process, scan completed | `absent` | only with `pruneDeadMembers` |
| unreadable lease | `unknown` | never |
| scan could not read `/proc` | `unknown` | never |

That combination is what fixes the bd-37 incident: the member was pruned 25 s after
its launch because the scan could not see a daemon-hosted session, the capacity
count dropped, and the next launch created a second orchestrator on the same
worktree. Now a live lease outranks the scan, and a member that is gone is stopped
for a human instead of silently relaunched.

## Operational limits

- **The ticker lives in the supervisor session.** It stops if that session or the
  daemon exits; the run record is durable, and a re-arm resumes it. Members are
  sessions in the same daemon, so nothing outlives the daemon anyway.
- **One landing per tick.** A tick that lands runs the project gates for minutes; a
  second tick is skipped while one is in flight (`fleetTickInFlight`). Three
  finished members land on three ticks.
- **Gates are not retried.** A gate/rebase/merge refusal stops the member with
  `land-failed`. Retrying with no new information would burn the same minutes again.
- **`accept` is the run's decision, not the merge engine's.** `belayd_fleet_merge`
  keeps "merging is not closing"; only a run with `accept: true` closes beads, and
  every close is audited.
- **A stopped member is out of the member list.** `fleet.json` `taskIds` no longer
  names it; `run.stopped` does, and `belayd_fleet_status` renders that line. Re-run
  the bead with a new `/fleet` launch when you have fixed what stopped it.

## How to Verify

### 1. Gates

```bash
pnpm test              # includes the P5 suites
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm build
```

The suites that pin this feature:

| Property | File | Case to look for |
|---|---|---|
| Mutual exclusion: one lease, one winner, cold lease archived | `src/__tests__/orchestrator-claim.test.ts` | `refuses a second session while the holder is alive`, `takes over a cold lease and archives the displaced record`, `adopts the spawner's pending lease` |
| Tick order and stop reasons | `src/__tests__/fleet-run.test.ts` | `lands a finished member before doing anything else`, `stops a member whose orchestrator is gone once the start grace has passed`, `stops the loop when nothing has progressed for too long` |
| Accept is conservative | `src/__tests__/fleet-accept.test.ts` | `keeps a dirty worktree in place and reports it, without failing the accept`, `never force-deletes a branch that git refuses to delete` |
| Beat decides re-arm for run-mode fleets only | `src/__tests__/fleet-heartbeat.test.ts` | `downgrades a run-mode fleet whose beat is cold, so re-arming is allowed`, `keeps the pid verdict for an explicit fleet` |
| Reconcile reads the lease | `src/__tests__/fleet-reconcile.test.ts` | `reads liveness from the worktree lease, not only the process table`, `never prunes a member whose lease cannot be read` |
| `/fleet` writes a run and starts the loop; `--manual` does not | `src/__tests__/extension-fleet-p1.test.ts` | the `fleet run mode` and `worktree orchestrator lease` blocks |

### 2. See the run record in a scratch repository

```bash
root=/tmp/fleet-run-demo
rm -rf "$root" && mkdir -p "$root/.git/belayd/fleet/default"
printf '%s' '{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12"],
  "createdAt":1792947202544,"updatedAt":1792947309781,"maxConcurrent":3,"baseBranch":"main",
  "supervisor":{"sessionId":"demo","pid":4242,"armToken":"demo"},
  "run":{"schemaVersion":1,"mode":"until-complete","startedAt":1792947202544,
  "updatedAt":1792947309781,"ticks":7,"accept":true,
  "members":[{"taskId":"bd-12","launchedAt":1792947202544,"sessionId":"01a173fc"}],
  "stopped":[{"taskId":"bd-15","reason":"phase-failed","detail":"phase review failed","at":1792947309781}],
  "idleTicks":0}}' > "$root/.git/belayd/fleet/default/fleet.json"
```

`belayd_fleet_status` renders the intent plus `run:` and `stopped …` lines. (The
worktree walk still needs a real git repository; the fixture above only shows the
intent half.)

### 3. Prove the refusal, without creating a session

The extension test `refuses a member whose worktree already has a live orchestrator`
seeds `.belayd/orchestrator.json` and asserts the launch fails with `live
orchestrator lease` and that **no** `POST /sessions` happened.

## Related documentation

- `docs/fleet.md` — the operator entry point (run, decision and failure tables).
- `docs/fleet-launch.md` — `/fleet` arguments, validation, capacity, mailbox.
- `docs/fleet-merge.md` — the merge queue a landing uses.
- `docs/fleet-reconcile.md` — reconcile, pause/resume, liveness model.
- `docs/fleet-status.md` — the read-only view and its fields.
- `docs/fleet-orchestrator.md` — the design record and locked decisions.
- `docs/owned-worktree.md` — the bd-119 bead ↔ branch ↔ worktree preflight.
