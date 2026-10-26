# Fleet pause, advance, and crash reconcile (bd-126 P4)

Operator guide for the last fleet milestone: how to stop a fleet, how to move it to
the next wave, and how to repair it after a crash. Operator entry point for the
whole surface: `docs/fleet.md`. Design record: `docs/fleet-orchestrator.md`; merge
mechanics: `docs/fleet-merge.md`; launch and ordering: `docs/fleet-launch.md`.

Everything here is **explicitly invoked and audited**. Pause, resume, advance, and
reconcile are tool calls you make, and each decision is appended to
`<git-common-dir>/belayd/fleet/<fleetId>/audit.log`.

The one background loop in the fleet family is the **run ticker** (bd-126 P5,
`docs/fleet-run.md`): it is started by `/fleet` unless `--manual` is passed, it
stops on `belayd_fleet_pause`, and it restarts on `belayd_fleet_resume` (a paused
run) or a re-arm (after a halt or a supervisor restart). It acts only through the
same engines these tools use, and every action is audited (`fleet-landed`,
`fleet-run-stopped`, `fleet-run-halted`, `fleet-run-complete`).

## Contents

- [How to Use](#how-to-use)
  - [Pause a fleet](#pause-a-fleet)
  - [What a forceful pause does and does not guarantee](#what-a-forceful-pause-does-and-does-not-guarantee)
  - [Resume a fleet](#resume-a-fleet)
  - [Advance the next wave](#advance-the-next-wave)
  - [Reconcile after a crash](#reconcile-after-a-crash)
- [How to Verify](#how-to-verify)

## How to Use

All four tools are **supervisor-only**: they require `fleet.json` to name this
session as the live supervisor (`sessionId` + unchanged process identity + the arm
token this session minted). A record left by a dead process does not count; start a
supervisor with `/fleet` or `belayd_fleet_launch`.

### Pause a fleet

```
belayd_fleet_pause { "reason": "operator is stepping away" }
```

What happens:

1. `fleet.json` gets `paused: true` and `note: "<reason>"` through the
   compare-and-replace path (`audit.log`: `fleet-paused`).
2. Every member (including deferred ones) gets a `pause` note in `events/`,
   delivered at its next turn start.
3. From then on, any launch that would **start** a member, `belayd_fleet_advance`,
   and `belayd_fleet_merge drain` all refuse with a message naming
   `belayd_fleet_resume`. A pure re-arm (`/fleet <existing ids>` that preserves
   every member and starts nothing) is still accepted while paused: it is the way
   back to a supervised, stopped fleet.

What a cooperative pause does **not** do: it does not interrupt a running phase. A
member is a detached session; it sees the note at its next turn and decides to stop
*starting* work. If a member is mid-phase, that phase runs to completion (or to its
own failure).

Pausing twice is not an error: the second call reports "already paused" and keeps
the original reason.

### What a forceful pause does and does not guarantee

```
belayd_fleet_pause { "force": true, "reason": "runaway member" }
```

The forceful path takes one process-table snapshot (`/proc/<pid>/cmdline`), matches
members only by the **exact** session token `belayd-<taskId>` (a phase sub-agent is
`belayd-<taskId>-sub-…`, so it is not mistaken for the orchestrator), and sends
`SIGTERM` to every matching pid other than this process. **Each pid is re-verified
immediately before its signal:** its `/proc/<pid>/stat` start time must still equal
the value captured when it was matched, and its argv must still carry the exact
token. A pid that exited and was recycled, or whose token moved, is skipped rather
than signalled; so is a pid whose start time cannot be read *either* at match time or
at re-verification (`identity-unavailable`) — on Linux the field is readable for any
live pid, so its absence means the process is gone or the table is inaccessible, and
argv evidence alone is never enough for a signal that cannot be taken back. Each pid
is signalled in its own attempt, so one failure cannot abort the rest. Each attempt
is reported and audited per pid (`member-stopped`,
`member-stop-skipped`, `member-stop-failed`, `member-stop-unavailable`), and every
detail line carries the matched `belayd-<taskId>` token so a pid can be tied back
to the identity it was signalled as after the process is gone.

**Guaranteed:** the signal was delivered to a process that carried the member's
exact orchestrator token *and* whose process identity (start time) was unchanged
since the match; the fleet is also cooperatively paused, so no new work starts
either way.

**Not guaranteed:**

- that pi handled the signal and the process actually exited — verify with
  `belayd_fleet_status`, `ps`, and the worktree's `git status` before relaunching;
- that a phase sub-agent process it spawned died too;
- that the member's in-flight writes (a `.belayd/` write, a file edit) completed;
- that a member can be stopped at all when `/proc` is unreadable or its process
  cannot be identified. In that case **nothing is signalled** and the tool says so:
  killing a pid without proof of what it is would be worse than leaving the member
  running. The cooperative pause still applies.

There is deliberately no `--kill` escalation: `SIGKILL` would leave a worktree in a
state this harness cannot reason about (half-written workflow state, a rebase in
progress), which is what bd-119's ownership preflight exists to prevent.

### Resume a fleet

```
belayd_fleet_resume { }            # normal
belayd_fleet_resume { "force": true }   # clear a park whose stash you restored yourself
```

Resume clears `paused`, the `park` record, and the park note through the same CAS
path, audited as `fleet-resumed` (+ `fleet-unparked` when a park was cleared), and
queues a `resume` note for every member. Resuming a fleet that is not paused is a
**successful no-op** (like pausing an already-paused fleet): it reports "already
running", writes nothing, and audits nothing. That keeps the documented recovery
below working when reconcile already unparked the fleet.

It **refuses** to clear a park that still names a stash ref, because the pointer is
the only thing that tells you (and reconcile) where your uncommitted work went:

- run `belayd_fleet_reconcile` first — it verifies the root is this repository's
  own checkout on the base branch, applies the recorded sha, drops it after a
  verified match, and unparks; a recorded sha that is already gone from
  `git stash list` is reported as already restored or dropped and the fleet is
  unparked without touching the checkout; or
- use `force: true`, which clears the pause and leaves the stash in place, naming
  the ref in the report. Nothing is ever deleted by resume.

### Advance the next wave

```
belayd_fleet_advance { }
```

The worklist is `fleet.json` `deferred` — the members a previous launch could not
start. Advance hands that list to the ordinary launch engine, which:

- re-reads bd's blocking edges (one read-only `bd show <ids> --json --brief-deps`),
- refuses a dependency cycle,
- re-applies the ceiling of 3 orchestrators (counting every fleet's members),
- launches what fits and records the rest as deferred again.

Audit lines: `advance` (the decision), `schedule-planned`, and one per deferral.
Advance refuses when the fleet is paused, has no deferred members, or has no intent.
An advance whose every member is capacity-deferred **succeeds** (exit 0): the plan
was made, nothing failed, and the members stay deferred and reported — the same
"nothing to do is not an error" rule the merge drain applies to an empty queue.

**Why it is explicit and not a poller.** An automatic wave advance needs a loop
that decides when a sibling "landed" and when capacity freed up. That loop would
have its own lifetime, its own failure mode, and no operator in the decision — it
would schedule work nobody asked for at a moment nobody can audit. The explicit
step keeps every scheduling decision attributable to a call.

**Dependency waves do not advance on a merge.** A blocked member becomes eligible
when bd stops reporting the blocking edge, i.e. when the blocker bead is closed
(`wt merge` / `bd close`). Merging a sibling's branch is not closing its bead
(locked decision), so a wave-1 member blocked by a wave-0 member stays deferred
with reason `external-blocker` until the human closes the blocker. Capacity
deferrals advance as soon as a slot frees.

### Reconcile after a crash

```
belayd_fleet_reconcile { }
belayd_fleet_reconcile { "pruneDeadMembers": true }
```

The prune parameter is **`pruneDeadMembers`** (the JSON key the tool schema
declares). The reconcile report hints at it in prose as `prune-dead-members`;
that phrase is not a parameter name.

Pruning is gated on the **member's** evidence, never on the supervisor's: a member
is removed only when the completed scan shows no process carrying
`belayd-<taskId>` (a positive `absent` verdict). A live supervisor is the normal
caller and may prune; `unknown` liveness is never pruned, and the worktree,
transcript, and bead are left alone.

Reconcile acts in this session's root checkout (the only place the base branch can
be checked out), **verifies that it is this repository's own checkout** (a linked
worktree is refused before any stash work, because it can legally hold the base
branch while the root moved away), and holds the **existing** merge lock
(`merge.lock.d`) for its repairs, so it can never interleave with a merge or with a
second reconcile. It never discards work: a failed restore leaves the stash
untouched and the fleet parked.

#### Repair table

| Anomaly | Diagnosis | Action | Why |
|---------|-----------|--------|-----|
| Expired lease | `merge-queue.json` holds a lock whose `leaseExpiresAt` has passed | **take over the lock** | The lease is the only takeover authority (same rule `acquireFleetMerge` applies); a crashed holder must not wedge the queue |
| Lock record without its primitive | lock record present, `merge.lock.d` absent | **clear the lock record** | `mkdir` is the acquisition authority: without the directory no merge can be in flight under this protocol, so the record is stale. Runs without holding the lock, because the anomaly *is* the missing primitive; the CAS only clears the exact diagnosed record |
| Orphaned lock directory | `merge.lock.d` present, no lock record, directory younger than the grace window (30 s) | **leave alone** | A winner may still be between `mkdir` and writing its lease |
| Orphaned lock directory, past the grace window | as above, older than the grace | **reclaim the directory** | The acquirer crashed before writing its record; the acquire path reclaims it and reconcile's acquire does the same |
| Entry stuck in an in-flight state (`rebasing`/`gating`/`merging`) with no live lock, branch already merged | git proves `feat/<id>` is an ancestor of the base | **mark the entry `merged`** | The merge landed and only the state write was lost |
| Entry stuck in an in-flight state, not merged | no live lock, git does not prove an ancestor | **reset the entry to `queued`** (attempt count preserved, `lastError` records the reset) | A re-queued entry can be drained again; a permanently "merging" entry would look like work in progress forever. Resetting is safe: a drain re-rebases and re-gates before touching the base |
| In-flight entry while a lock is live | lease valid and primitive present | **leave alone** | That is exactly what a running merge looks like |
| Parked fleet with a recorded stash | `paused` + `park.stashRef` | **restore, verify, drop, unpark** | Root work is never discarded. The restore applies the recorded sha (never a position) only while the root is this repository's own checkout on the base branch; the drop is cross-checked against the dropped commit and a mismatch is warned and audited (`merge-stash-drop-mismatch`) |
| Parked fleet whose recorded sha is no longer in `git stash list` | the sha still resolves as a dangling commit, but the entry is gone | **report and unpark, without touching the checkout** | A sha that was already restored and dropped is not applied again: re-applying it would double-apply the work, and a failed apply would then reset the checkout over what the first run restored. The report says "already restored or dropped — inspect the root" and the fleet is unparked so a dangling pointer cannot wedge it |
| Parked fleet with no recorded stash | `paused` without `park` | **report only** | A hand-written pause has nothing to restore; `belayd_fleet_resume` clears it (with `force` if the stash is already back) |
| Parked fleet, root is a linked worktree | `rev-parse --absolute-git-dir` differs from `--git-common-dir` | **blocked before any stash work** | A linked worktree can hold the base branch while the root moved away; restoring there would leave the root with neither the work nor the pointer. Run reconcile from the repository root |
| Parked fleet, root not on the base branch | git shows another branch checked out | **blocked, report the exact steps** | Applying onto another branch would move the operator's work into the wrong checkout. The stash ref and the branch to check out are printed |
| Parked fleet, stash no longer resolves or conflicts | git refuses the apply | **blocked, stash untouched** | The conflict is reset out of the checkout and the fleet stays parked with the ref in `park` |
| Member orchestrator absent | no fresh worktree lease AND (process table readable, no process carries `belayd-<taskId>`) | **report**; **prune** with `pruneDeadMembers: true` | Removes phantom members so the conservative capacity count is not held forever by sessions that provably do not exist. A live supervisor may prune — it is the entity that needs the count back. The worktree, transcript, and bead are untouched |
| Member orchestrator live | a process carries the token | **leave alone** | The work is advancing; only a dead supervisor needs re-arming with `/fleet <ids> --fleet <id>` |
| Member liveness unknown | `/proc` unreadable / scan over its cap | **never prune**, warn | "Cannot see" is not "gone". Every member stays in the capacity count, even when the supervisor is live and asks to prune |

**Why reset to `queued` rather than mark the entry `failed`.** A crash is not a
failed merge: the merge may not even have started, and the branch is untouched. A
`failed` entry needs a manual re-enqueue and records a failure that did not
happen; a `queued` entry is drained again normally, and the drain re-checks
preconditions, rebases, and runs the full gate set before touching the base — so
the reset cannot merge anything the gates would reject. The attempt count is
preserved, so repeated crashes remain visible.

#### Deferred members are addressable

A member that a launch deferred has no session yet, but it is still an addressee:
supervisor → member notes are validated against `taskIds` **plus** the deferred
ids, so a `pause` or `note` queued for a member before its wave starts is
delivered at that session's first turn. The P0 member *count* deliberately stays
`taskIds`-only (a deferred member has no worktree to observe), so this does not
change the read-only view's semantics — it only makes the waiting member reachable.

#### Concurrency of the pause/resume writes

Pause and resume are compare-and-replace writes on `fleet.json`: the update is
only applied when the bytes it was based on are still on disk, so a concurrent
operator note, prune, or member launch is never silently overwritten (the loser
sees a conflict). There is no second lock because there is at most one live
supervisor per fleet by construction — `fleetModeFor` requires the arm token this
session minted and an unchanged process identity, and validation refuses a second
supervisor for the same fleet.

#### After a prune: relaunching the pruned bead

A pruned member's worktree and `.belayd/workflow.json` are still on disk, and the
bd-119 ownership preflight (`docs/owned-worktree.md`) refuses a second
orchestrator for a worktree that already records workflow state. So a pruned dead
member is not relaunched with `belayd_fleet_launch`; resume that workflow the way
the single-bead runbook says (`/belayd` handoff / `pi --resume belayd-<taskId>`), or
remove the worktree if the work is abandoned. Pruning only changes which sessions
the fleet counts — it never deletes anything.

#### Idempotence

Reconcile is safe to run repeatedly, and a second run must be a no-op: an
already-taken-over lock is released at the end of the repair, an already-restored
park is gone from the intent (so no second `stash apply` can happen), an
already-reset entry is `queued` (not an anomaly), and an already-pruned member is
no longer in `taskIds`. Two failures are covered explicitly:

- **A failed unpark after a successful restore.** If the restore applied and
dropped the stash but the intent CAS write failed (crash, conflict), the park
record survives and the sha still resolves. The next run sees that the sha is no
longer in `git stash list`, does **not** apply it again, does **not** reset the
checkout, clears the park and reports "already restored or dropped — inspect the
root".
- **A failed release of reconcile's own lock.** The release error is surfaced as a
warning naming the lease expiry, so a lock that stays recorded is never an
unexplained "lock held" on later drains.

`src/__tests__/fleet-reconcile.test.ts` asserts each repair, including a real
`git init` fixture for the stash restore and the failed-CAS two-run sequence.

#### Member liveness model

Two evidence sources, and the combination is what makes the verdict honest.

**The worktree lease (primary).** Every member worktree carries
`.belayd/orchestrator.json`, created by the spawner, adopted and then renewed every
20 s by the orchestrator session's own timer
(`src/orchestrator-claim.ts`, `docs/fleet-run.md`). A fresh lease proves a session
is alive.

Why not just the process table: a member launched by `/fleet` or `/belayd` is a
**pi-web session inside the session daemon**. No process carries
`belayd-<taskId>` — the argv belongs to `sessiond.js` — so a scan of `/proc`
reports every live member as `absent`. That was the bd-37 incident: the member was
pruned 25 s after its launch, capacity freed a slot, and the next launch created a
second orchestrator on the same worktree.

**The process table (secondary).** A CLI-spawned orchestrator
(`pi --session-id belayd-<taskId>`, `src/spawn.ts`) has no lease; its argv token is
still evidence. Reconcile takes one `/proc/<pid>/cmdline` snapshot (bounded,
numeric pids only) and combines it with the lease per member:

| Lease | Process | Result | Consequence |
|---|---|---|---|
| fresh | either | `live` | never pruned; the work is running |
| cold/absent | exact `belayd-<taskId>` argv | `live` | never pruned (CLI-spawned member) |
| cold/absent | nothing, scan completed | `absent` | report; prunable with `pruneDeadMembers: true` |
| unreadable | either | `unknown` | never pruned; warning |
| cold/absent | scan could not read `/proc` | `unknown` | never pruned; warning |

The combination is a heuristic in one direction only: a false `live` costs nothing
(a dead member keeps a slot until you prune it), while a false `absent` removes a
running member — which is why an unreadable lease or an unreadable `/proc` is
`unknown`, never `absent`, and why the capacity count is narrowed by *pruning a
member that provably does not exist*, not by subtracting liveness verdicts at launch
time.

## How to Verify

1. **Gates.** `pnpm test && pnpm test:integration`, `pnpm typecheck`, `pnpm lint`,
   `pnpm build`. The P4 suites are `src/__tests__/fleet-pause.test.ts`,
   `src/__tests__/fleet-reconcile.test.ts`, `src/__tests__/fleet-sessions.test.ts`,
   and the extension cases in `src/__tests__/extension-fleet-p1.test.ts`.
2. **Pause stops new work, resume restores it.** Pause a fleet, then run
   `belayd_fleet_status` (it shows `paused`), `belayd_fleet_launch` (refused), and
   `belayd_fleet_merge action=drain` (refused `fleet-paused`). Resume and both work
   again. `audit.log` shows `fleet-paused`, then `fleet-resumed`.
3. **A parked fleet has a path back.** Force a conflicting root restore (edit a file
   the member also edits), observe `park.stashRef` in `fleet.json`, then run
   `belayd_fleet_reconcile`: the report either restores and unparks (`fleet-unparked`)
   or names exactly what blocks it (branch, missing sha, conflict). `belayd_fleet_resume`
   before reconcile is refused, not silently accepted.
4. **Idempotence.** Run `belayd_fleet_reconcile` twice with a repaired fleet: the
   second report says `nothing to repair` and the queue/intent files are unchanged.
5. **No liveness guessing.** Stop a member session, run reconcile: it reports
   `orchestrator not running` and does not prune unless asked. With
   `"pruneDeadMembers": true` it removes that member and audits `member-pruned-dead`
   — this works from a live supervisor too (the realistic case), and a scan that
   cannot run (`unknown`) prunes nothing even with the flag.
6. **No background loop.** Trigger no tool call and watch `audit.log`: nothing new
   appears. Waves, pauses, and repairs only ever happen in response to a call.

## Related documentation

- `docs/fleet.md` — operator entry point for the whole bd-126 surface: the
  end-to-end run, decision and failure-recovery tables, shared verification.
- `docs/fleet-orchestrator.md` — design record: scheduler architecture, locked
  decisions, and the P4 design section.
- `docs/fleet-merge.md` — the merge queue this repair path fixes.
- `docs/fleet-launch.md` — the launch engine `belayd_fleet_advance` reuses.
- `docs/owned-worktree.md` — the bd-119 preflight that keeps one orchestrator per
  worktree (why a pruned member is not relaunched through the fleet).
