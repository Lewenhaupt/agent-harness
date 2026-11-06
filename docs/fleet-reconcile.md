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
    - [Recovering from a dead supervisor](#recovering-from-a-dead-supervisor)
- [How to Verify](#how-to-verify)

## How to Use

All four tools are **supervisor-only**, with one documented exception: a fleet
whose supervisor is **provably dead** may be reconciled by any session in the
repository (bd-233, [Recovering from a dead supervisor](#recovering-from-a-dead-supervisor)).
Otherwise they require `fleet.json` to name this session as the live supervisor
(`sessionId` + unchanged process identity + the arm token this session minted). A
record left by a dead process does not count; start a supervisor with `/fleet` or
`belayd_fleet_launch`.

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
belayd_fleet_reconcile { "fleetId": "wave1", "pruneDeadMembers": true }
belayd_fleet_reconcile { "retryMembers": ["bd-42"] }
```

`fleetId` names another fleet in the same repository — the leaderless one a
hand edit used to be the only way to repair (bd-166). Naming a fleet never grants
authority by itself: the call is accepted when this session supervises *some*
fleet in the repository (same authority rule as launch) **or** when the named
fleet's supervisor is provably dead (bd-233, see
[Recovering from a dead supervisor](#recovering-from-a-dead-supervisor)). The arm
taken is audited: `reconcile-cross-fleet` for the supervised arm,
`reconcile-recovery` for the dead-supervisor arm. Without `fleetId` the call
targets this session's own fleet — or, when this session holds no fleet, the one
fleet in the repository if its supervisor is provably dead.

A cross-fleet call normally repairs the **queue and park** (and reports
liveness) and refuses `pruneDeadMembers: true`, because a prune erases another
fleet's members from the capacity arithmetic. Two exceptions, both documented
below: recovery authority over a provably dead fleet may prune, and to prune a
*live* fleet you re-arm it (`/fleet <ids> --fleet <id>`) and run the reconcile —
or `belayd_fleet_release <taskId>` — from that session. A member of a provably
dead fleet may also be released from any session with
`belayd_fleet_release { taskId, fleetId }` (audited `member-released-recovery`),
which is the operator escape that avoids hand-editing `fleet.json` (bd-168); a
live foreign supervisor keeps the refusal.

The prune parameter is **`pruneDeadMembers`** (the JSON key the tool schema
declares). The reconcile report hints at it in prose as `prune-dead-members`;
that phrase is not a parameter name.

`retryMembers` is the documented way back from "needs a human" (bd-233). It
clears the named members' `run.stopped` entries — nothing else — and audits one
`member-retry` entry per id. Only an **active** run has a next tick to promise: on a
finished or halted run the stops are left intact and each id is reported as a
warning that names the re-arm step. When the run is active, the next tick
reconsiders those members: it lands work that finished, and stops them again if
their orchestrator is still gone. A member whose worktree no longer exists needs
`pruneDeadMembers: true` plus a fresh launch instead; the report says so.

Pruning is gated on the **member's** evidence, never on the supervisor's: a member
is removed only when the completed scan shows no process carrying
`belayd-<taskId>`, no live worktree lease, and no worktree that still exists — or
the run recorded landing it, which proves the tree existed even after a clean
landing removed tree and branch (bd-168) — a positive `absent` verdict. A live
supervisor is the normal caller and may prune;
`unknown` liveness is never pruned, and the worktree, transcript, and bead are
left alone. A prune also drops the pruned members' `run.stopped` entries, because
a fleet must not keep reporting "needs a human" for a member it just removed.

A pruned member's ordering-gate record is resolved in bd and then dropped from the
intent. If that second write is refused (a concurrent re-arm, or a failed drop),
the record is kept and the warning says who retries it: the **next tick** or the
next reconcile. The tick is the always-on owner: every tick resolves and drops any
recorded gate whose blocker or blocked bead is no longer a member, with no audit
entry for that drop, so no operator action depends on one particular reconcile call.
A reconcile that prunes also resolves the pruned beads' gates through the same
prune path, and the reconcile tool then sweeps every member plus the beads that
pass pruned (`reapReconciledMemberGates`) inside the audited reconcile call — the
prune is audited as `member-pruned-dead`, gate adoptions as
`ordering-gates-adopted`, while the post-pass's own orphan drop adds no separate
`ordering-gates-resolved` entry. A later reconcile tool call reaps anything still
left by a refused drop.

**A missing worktree is absence only when something proves the tree existed.** A
launch writes the member into `taskIds` *before* it creates the branch and the
worktree, so "no worktree" alone is a spawn in flight and stays `unknown`
(counted, never pruned). A deleted worktree leaves its `feat/<taskId>` branch
behind, and that (or a listed worktree) is the proof: the member resolves to
`absent`, is prunable, and stops holding a slot. A clean landing destroys that
branch too, so the run's own `run.members[].landedAt` record is the remaining
positive evidence: a landed member is `absent` even with no worktree and no
branch, and prune no longer says "no proof one ever existed" (bd-168). Reconcile and the capacity view
classify this with the same classifier and the same injected evidence, so a
repair cannot disagree with what `belayd_fleet_status` prints. Capacity's run
manifest evidence is execution-scoped too — only a manifest that postdates the
worktree's creation (and the run's recorded `launchedAt`) counts, so an inherited
same-task manifest copied into a fresh worktree cannot free a slot mid-spawn
(`memberRanEvidence`, `src/fleet-run.ts`).

Reconcile acts in this session's root checkout (the only place the base branch can
be checked out), **verifies that it is this repository's own checkout** (a linked
worktree is refused before any stash work, because it can legally hold the base
branch while the root moved away), and holds the **existing** merge lock
(`merge.lock.d`) for its repairs, so it can never interleave with a merge or with a
second reconcile. It never discards work: a failed restore leaves the stash
untouched and the fleet parked.

#### Recovering from a dead supervisor

No step here needs the dead supervisor's session, and none needs a hand edit of
`fleet.json`. A supervisor is **provably dead** along one of two paths, and which one
applies depends on the record:

- a **run-mode** record's `pid` is the shared pi-web daemon (`pid: process.pid` at
  arm), so the pid probe cannot prove the session gone while the daemon lives: this
  path waits for `supervisor.json`'s beat to go cold (up to
  `FLEET_SUPERVISOR_HEARTBEAT_STALE_MS`, 10 minutes) or go missing;
- an **explicit** (non-run) or legacy record whose pid is the supervisor process
  itself is provably dead as soon as that pid is gone or reused, with no beat wait.

So a fresh beat refutes death on the beat path (some loop is ticking), while a dead
pid refutes it on the pid path. Recovery never takes the supervisor role: the
record is untouched, and no session becomes the supervisor by reconciling.

1. **Reconcile the dead fleet by id.** `belayd_fleet_reconcile { "fleetId": "<id>" }`
   from any session in the repository. In a repository with exactly one fleet,
   `{ }` is enough. This arm is audited as `reconcile-recovery`; it grants repair
   authority only and never writes the supervisor record, so no session silently
   becomes the supervisor.
2. **Prune the members that are provably gone.** Re-run it with
   `{ "fleetId": "<id>", "pruneDeadMembers": true }`. Under recovery authority a
   prune is allowed — the cross-fleet refusal protects another *live* supervisor's
   capacity decision, and a provably dead supervisor has none to protect. Members
   whose worktree was deleted resolve to `absent` (their `feat/<taskId>` branch is
   the proof, or the run's recorded landing when a clean landing removed both) and
   free their slots. The report names each pruned id and audits
   `member-pruned-dead`.
3. **Retry the members you want to keep.** `{ "fleetId": "<id>", "retryMembers": ["bd-42"] }`
   clears their recorded stop (`member-retry`); the run's next tick reconsiders
   them. Only an **active** run has a next tick: on a finished or halted run the
   stops are left intact and each requested id gets a warning telling you to re-arm
   first. If a retried member's worktree is gone, it is stopped again — prune it in
   step 2 and launch it fresh.
4. **Re-arm or relaunch.** `/fleet <ids> --fleet <id>` (or `belayd_fleet_launch`)
   rewrites the supervisor record, preserves the surviving members, and restarts
   the run loop. A fleet whose members were all pruned needs a launch for the new
   work, not a re-arm of a finished run.

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
| Member orchestrator absent | a process table that was read shows no process carrying `belayd-<taskId>`, no live worktree lease, and the worktree is gone although one provably existed (its branch survives) | **report**; **prune** with `pruneDeadMembers: true` | Removes phantom members whose records are unreachable otherwise and frees their capacity slots. A live supervisor may prune — it is the entity that needs the record gone — and so may recovery authority over a provably dead fleet. The worktree, transcript, and bead are untouched |
| Member orchestrator live | a process carries the token | **leave alone** | The work is advancing; only a dead supervisor needs re-arming with `/fleet <ids> --fleet <id>` |
| Member liveness unknown | no worktree and no proof one ever existed (a launch may be creating it), `/proc` unreadable, scan over its cap, or an unreadable lease | **never prune**, warn | "Cannot see" is not "gone". Every member stays in the capacity count, even when the supervisor is live and asks to prune |

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

A pruned member's bead is untouched, and whether it can simply be relaunched
depends on the worktree. If the worktree still exists with
`.belayd/workflow.json`, the bd-119 ownership preflight (`docs/owned-worktree.md`)
refuses a second orchestrator, so resume that workflow the way the single-bead
runbook says (`/belayd` handoff / `pi --resume belayd-<taskId>`). If the worktree is
gone — the bd-233 case — `belayd_fleet_launch` sets up a fresh one from the
surviving branch and starts the member normally. Pruning only changes which
sessions the fleet counts; it never deletes anything.

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

| Lease | Process | Worktree | Result | Consequence |
|---|---|---|---|---|
| fresh | either | present | `live` | never pruned; the work is running |
| cold/absent | exact `belayd-<taskId>` argv | either | `live` | never pruned (CLI-spawned member) |
| cold/absent | nothing, scan completed | present, with evidence it ran | `absent` | report; prunable with `pruneDeadMembers: true` |
| cold/absent | nothing, scan completed | gone, but the tree provably existed | `absent` | report; prunable; frees the capacity slot (bd-233) |
| cold/absent | nothing, scan completed | gone, no proof it ever existed | `unknown` | a launch may be creating it; never pruned |
| cold/absent | nothing, scan completed | present, no evidence it ran | `unknown` | bare worktree = spawn in flight; never pruned |
| unreadable | either | either | `unknown` | never pruned; warning |
| cold/absent | scan could not read `/proc` | either | `unknown` | never pruned; warning |

The combination is a heuristic in one direction only: a false `live` costs nothing
(a dead member keeps a slot until its evidence says otherwise), while a false
`absent` removes a running member — which is why an unreadable lease or an
unreadable `/proc` is `unknown`, never `absent`, and why "no worktree" without
proof the tree existed is `unknown` too. Capacity and pruning agree on every
verdict: capacity stops counting an `absent` member (the slot comes back), and a
prune removes the record when the operator asks (the member stops being
addressable).

Two details of the "gone, but the tree provably existed" row:

- a worktree that `git worktree list` still reports although its directory was
  deleted (`rm -rf`, not `wt rm`) resolves to `absent` directly: the listing is the
  proof, and no `git worktree prune` is needed to free the slot (bd-233 W1);
- a **relaunch** reuses the surviving `feat/<taskId>` branch, so the proof is
  suppressed only while **that member's own launch marker** is live
  (`<fleet dir>/launch/<taskId>`) — the spawner creates it immediately before
  spawning, **refreshes it while the spawn lives**, and removes it once the session
  is spawn-committed or the attempt failed, so nothing periodic can hold a window
  open: a ticking run never keeps its members `unknown`. The grace is
  `FLEET_MEMBER_SPAWN_GRACE_MS` = `WORKTREE_READY_TIMEOUT_MS` (60 s) +
  `FLEET_SPAWN_RPC_ALLOWANCE_MS` (60 s) + `FLEET_SPAWN_GRACE_MARGIN_MS` (30 s) =
  150 s, refreshed every `FLEET_LAUNCH_MARKER_REFRESH_INTERVAL_MS` (50 s). Only a
  member inside its own window is `unknown` (counted, never pruned); a marker with
  no refresh for a full grace is an abandoned spawn and the member is `absent`
  again.

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
   — this works from a live supervisor too (the realistic case), even while its run
   ticks: only a member whose own launch marker is still live keeps its slot. A scan
   that cannot run (`unknown`) prunes nothing even with the flag.
6. **A dead supervisor is not a dead end (bd-233).** For a run-mode fleet, kill the
   supervisor session and leave its `supervisor.json` beat untouched: the loop stops
   beating, so the fleet becomes provably dead once the beat is cold (up to 10
   minutes). For an explicit fleet whose record names the supervisor process, the
   dead pid is proof immediately. Then run
   `belayd_fleet_reconcile { "fleetId": "<id>", "pruneDeadMembers": true }` from an
   unrelated session: it is accepted, audits `reconcile-recovery` (only because it
   repaired something), removes the members whose worktrees are gone, and
   `belayd_fleet_status` then shows `unknown: 0` and the slots free. A prune is
   allowed under recovery authority; the supervisor record is untouched.
   `src/__tests__/fleet-reconcile.test.ts` pins this scenario end to end.
7. **Retry is a tool call.** With a member in `run.stopped`, call
   `belayd_fleet_reconcile { "retryMembers": ["<id>"] }`: the stop is cleared and
   audited `member-retry`, and the run's next tick reconsiders the member. An id
   that is not a member is reported as a warning, not ignored.
8. **No background loop.** Trigger no tool call and watch `audit.log`: nothing new
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
