# Fleet run loop — `/fleet` to completion (bd-126 P5)

`/fleet bd-12 bd-15 bd-19` no longer stops after the first wave. The supervisor
lands every member as it finishes — merging the branch and removing the merged
worktree and branch — closes the bead only when acceptance was asked for
(`--accept`), starts the next wave as dependencies clear, and keeps going until the
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
| Accepting a landed member (worktree removal, optional close) | `src/fleet-accept.ts` |
| Supervisor heartbeat + re-arm eligibility | `src/fleet-heartbeat.ts` |
| Worktree orchestrator lease | `src/orchestrator-claim.ts` |
| Wiring (ticker, launch, tools, `/fleet`) | `extensions/capabilities/fleet.ts` (`createFleet`, wired from the composer) |

## How to Use

### Start a run

```text
/fleet bd-12 bd-15 bd-19                 # run to completion, leaving each bead for you
/fleet bd-12 bd-15 --accept              # also close each landed bead; the merged
                                         # worktree is removed on landing either way
/fleet bd-12 bd-15 --manual              # the old explicit surface: nothing merges or advances on its own
/fleet bd-12 bd-15 --fleet night          # name the fleet (or re-arm one)
```

Tool form:

```json
{ "tasks": ["bd-12", "bd-15"], "untilComplete": true, "accept": false }
```

The launch itself is unchanged (validate → write intent → launch wave 0 →
prune failures). What changes is what happens next: the launch writes a `run`
record into `fleet.json` and starts the ticker.

### What "complete" means

A run is complete when every member is **landed** (its branch is on the base
branch) and out of the fleet's member list. A landing removes the member's
worktree and merged branch **either way**: the branch is already on the base
branch, so the worktree has no remaining purpose and keeping it would only grow the
disk. With `accept: false` (the default) the **bead** stays `in_progress` + `human`
— the run still finishes, because a member the fleet landed satisfies its
dependents' dependency edges and its bd ordering gates are resolved (see below).
With `accept: true` the landing also closes the bead (`bd close`): acceptance is
the bead, never the worktree.

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
belayd_fleet_resume { }                            # restarts a paused run's ticker
```

A **paused** run is not finished: the ticker stops, the run record stays live, and
`resume` starts the ticker again. A **parked**, **stalled**, or **awaiting-human**
run is halted and recorded (`haltedReason`), because each needs a human:

- `parked` — the root checkout could not be restored after a merge (reconcile,
  then re-arm).
- `stalled` — `FLEET_RUN_MAX_IDLE_TICKS` ticks with no **member progress** (240 at
  the 15 s interval, i.e. ~60 min). Progress is what the tick *observes*, not only
  what it does: each member has a progress signature — its workflow state kind plus a
  **stable** identity for that kind (the phase run in flight, the completed-phase
  count, the failed phase, or just the kind when it is the whole identity) — and any
  signature that differs from the previous tick's snapshot resets the counter, even
  though that tick's action was a plain wait. The free-text `detail` (a failure
  reason is model text) is **never** part of that comparison: a crash-looping member
  re-reports the same failed phase with new text on every attempt, and treating that
  as progress would disable the cap. So a member that starts and finishes phases
  keeps the run alive wave after wave — **as long as no single phase run outlasts
  the cap**. The in-flight signature is the phase run itself, and the member's
  worktree has nothing that changes meaningfully *during* one (the run manifest is
  written when the phase starts, the workflow state when it ends), so a phase that
  takes longer than 240 ticks (~60 min) halts the run as `stalled` for a human
  instead of being waited on forever. A member whose workflow says the same thing
  for the whole window hits the cap the same way — that is the case the cap exists
  for. The run stops instead of spinning; the record keeps the counter
  at the cap (the giving-up tick does not add a 241st idle tick) and names the
  members still in flight with the counters that justified the halt (`no member
  progressed for 240 ticks (cap 240); bd-143 still in flight`) — or, when the wave is
  capacity-blocked, the members waiting for a slot. An advance that launches nothing
  because of a `dependency` or `external-blocker` — and no `capacity` entry — does
  not wait for this cap at all: it ends the run as `partial` on that tick.
- `awaiting-human` — `FLEET_RUN_MAX_HUMAN_WAIT_TICKS` ticks (2880 at the 15 s
  interval, i.e. ~12 h) while the **only** work in flight is a live human wait
  (see the landing window below). A live human wait means the member's bead has
  an **open bd `human` gate**; a review phase flag is not a wait (bd-219). It is
  a distinct reason so a neglected gate never looks like a dead member, and its
  detail names the members that waited
  (`bd-143 awaited a human response for 2880 ticks (cap 2880); re-arm the fleet
  after answering`). A hung non-human member in the same run still halts
  `stalled` at the much smaller idle cap first.

A halt is terminal **for that run record**: `haltedReason` is never cleared, and
both the ticker (`fleetTick`) and `resumeFleetRunLoop` only act on an active run
(`isFleetRunActive` requires `haltedReason === undefined`). So `belayd_fleet_resume`
restarts the ticker only for a *paused* run. After a `parked` halt it clears the
pause and park flags (refusing while a recorded stash is still unrestored), but
nothing ticks again because the run is no longer active; after a `stalled` or
`awaiting-human` halt no pause flag is set (a paused fleet halts as `paused`
instead), so resume is an `alreadyResumed` no-op that changes nothing at all.
Either way, continuing needs a re-arm — `/fleet <ids> --fleet <id>`
(for a parked fleet, run `belayd_fleet_reconcile` first to unpark) — which
preserves the members and starts a **new** run record in place of the halted one.

Kill the loop without touching the fleet's flag by closing the supervisor session
(`session_shutdown` clears the timer). The run record survives, and a later
`/fleet <ids> --fleet <id>` re-arms it: the members are preserved and the loop runs
again.

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

**A restarted supervisor re-adopts its own run automatically (bd-169).** The run
loop's authority includes an arm token that lives only in the arming process's
memory, so a session/daemon restart ends the loop; before this repair it ended it
permanently and silently (wave2 ran three beads to completion and sat unlanded for
nine hours). On `session_start` the extension now sweeps every fleet id and
re-adopts a fleet when *all three* hold:

- the fleet's run record names **this** session (`supervisor.sessionId`);
- the run is still **active** (no `finishedAt`, no `haltedReason`);
- the beat is **cold** (older than 10 minutes, names another session, or is
  missing) — the same documented re-arm rule, applied automatically.

Adoption mints a fresh arm token, rewrites the supervisor record and the beat,
starts the tick loop, notifies, and appends `supervisor-readopted` to `audit.log`.
The write re-checks the anchors it read (run still active, record still names this
session, and the recorded pid, process start time and arm token are **exactly**
unchanged — a field present on one side and absent on the other counts as changed),
so an operator who re-armed the fleet in between keeps it: the adoption refuses,
says so with the recovery command, audits `supervisor-readopt-failed`, and the skip
notices for the other candidates are only written after a successful adoption. The
arm token is never persisted outside the record it belongs to (W6), so the
heuristic anchors are the session id, the cold beat, and an existing active run.

Residual risk, stated not hidden: a session id is public, so a record planted by
another writer that names this session and carries an active run makes this
session adopt on its next start. Because the token cannot be persisted to close
that, adoption is loud and audited, and requires a cold beat on an existing run.

**One fleet per session.** A session that has supervised two fleets (wave1, then
wave2) re-adopts exactly one: the newest `run.updatedAt`, tie-broken by fleet id.
Every other candidate is reported with its own
`/fleet <ids> --fleet <id>` recovery command, and `resolveFleetMode` prefers the
fleet this session holds a token for over directory order, so the stale sibling
can never make the live loop bail.

**A dead loop is reported, not silently healthy.** Nothing ends the timer silently
any more: a tick that loses authority (another session re-armed), finds the fleet
record gone, or cannot read it notifies with the fleet id and the exact recovery
command (`/fleet <ids> --fleet <id>`, or `belayd_fleet_advance` while the run is
still active), writes `supervisor-lost` / `supervisor-intent-lost` to `audit.log`,
and logs to the console. The same stop inside an advance's mid-flight re-read is
reported identically. An active run whose record names **no** usable supervisor is
reported by the next session that starts (any session, since no session is named) —
but only when the loop is provably dead: no beat at all, or a beat older than the
10-minute window. A **fresh** beat means some session is ticking that run, the
record just does not say which, so that case stays quiet and `belayd_fleet_status`
remains the surface. The leaderless report is a wedge alarm, not a per-start pulse:
it is written at most once per fleet per beat-stale window (deduped against the
fleet's own `audit.log`), and the anchor is the **last report**, not the beat's
age: a wedge that disappears (someone beats it once) and reappears inside that
window stays suppressed, so `belayd_fleet_status` is the surface until the window
lapses. A fleet with no run record stays quiet, because an
explicit `--manual` fleet is legitimately leaderless.

Where that report lands is bounded by who returns: it reaches the session the
record names on its next `session_start`, and when that session never comes back,
the operator still sees the run as **not ticking** — `belayd_fleet_status` keeps the
run-not-ticking warning (bd-166) as the after-the-fact backstop, and no fleet with
a dead or missing supervisor is ever presented as healthy. It is not a push alert
to a human who never opens the status view. The stop deliberately does **not**
write a `haltedReason` onto the run: another session may have re-armed, and marking
that record halted would kill its loop. A finished or halted run stays quiet — the
tick that produced it already recorded and announced the terminal result.

`belayd_fleet_advance` restarts a timer that is missing while its run is active
(`fleet-run-restarted`), so the natural "looks dead, poke it" call revives the
loop. A paused fleet's loop comes back through `belayd_fleet_resume`, which resumes
the run and restarts the loop with `resumeFleetRunLoop`; resuming a fleet that is
already running is a successful no-op and does not touch its timer.

## How the tick decides

One action per tick, in this order (`src/fleet-run.ts`):

| Order | Action | When |
|---|---|---|
| 0 | `halt` | the fleet is paused (`resume` restarts) or parked (needs a human) |
| 1 | `land` | the first landable member whose workflow is complete (all phases done, or a completed final-phase run with no state file), including one the run stopped earlier and whose retry finished |
| 2 | `stop` | the first member that needs a human: `awaiting-human`, `phase-failed`, `phase-interrupted`, `state-corrupt`, or `orchestrator-missing` |
| 3 | `wait` | something is still working — a healthy member, or a stopped member's retry that is observably alive — unless the idle cap is reached (no member's progress signature changed for `FLEET_RUN_MAX_IDLE_TICKS` ticks), then `halt`/`stalled`; when the only in-flight work is a live human wait the larger `FLEET_RUN_MAX_HUMAN_WAIT_TICKS` cap applies instead and the halt reason is `awaiting-human` |
| 4 | `advance` | nothing is working and the deferred list is non-empty; an advance that launches nothing degrades to `complete`/`partial` — or to `wait` when **any** deferral names `capacity` (a mixed `capacity` + `dependency` list included), bounded by the same idle cap (then `halt`/`stalled`) |
| 5 | `complete` | nothing is working and no deferred work remains (`partial` when something stopped) |

Landing first is deliberate: it frees a capacity slot and unblocks dependents in
the same tick. Stopping second is the safety property: **a member that stopped is
never relaunched by the loop.** A vanished orchestrator is reported for a human,
not retried, because the retry is exactly what started a second orchestrator on
one worktree before the lease existed. Waiting third keeps the run alive while
anything can still deliver work; `advance` and `complete` only run once nothing
is working at all.

**An `awaiting-human` stop means a person is actually being asked (bd-219).**
The tick reads each member's bead for an open bd `human` gate
(`lookupOpenHumanGate`) and only that read makes the member
`awaiting-human`; the detail is
`waiting on an open human gate on the bead`. A review with ordinary findings is
**not** a wait: it writes `.belayd/review-findings.json` and posts the
`[belayd:review]` comment as the workflow actor, then the member runs its own
fix loop — so a post-review member reads `active`, exactly as the orchestrator
is expected to proceed. No review opens a gate: the only human gate a workflow
can open is `belayd_ask_human` (bd-286), and secrets are a scanner's job
(`pnpm scan:secrets`). An unreadable gate read is "unknown", never a wait. `bd show`,
`needs-you` views, and `bd ready` therefore agree with the fleet's own view; a
clean review writes nothing and stays on the fast path.

**Known trigger limitation: a verb-lead bullet with a defect clause.** The finding
trigger is lexical: a bullet that opens with a past-tense check verb
(`checked`/`verified`/`tested`/`reviewed`) is narration and is not recorded, even
when a `:`/`—` clause after it restates a present-tense defect (`- Checked: race
in src/a.ts:5`). Separating that clause from an affirmation (`- Checked: all
fine`) needs a defect lexicon, and a wrong guess *records and posts a finding for
nothing* — the failure the narration rule exists to prevent. The tradeoff is
deliberate and pinned by tests (`parseReviewFindings` strict cases,
`hasReviewFindings`); a defect should be written without the check-verb prefix. A
narration bullet that cites a location still does not count,
whether its marker is bare, backticked, or markdown-emphasized (`**Verified**`,
`__Checked__`).

**An advance that launches nothing ends the run** (`src/fleet-run.ts`
`emptyAdvanceAction`). The executor degrades that no-launch advance into the
action the plan would otherwise have reached, instead of re-planning the same
worklist every tick. With `dependency` or `external-blocker` deferrals — and no
`capacity` entry — the run completes as `partial` in that same tick, with one
line naming the deferred members and their reasons plus the stopped members
(`nothing launched: bd-152 (external-blocker), bd-153 (dependency) still
deferred; 2 member(s) need a human: bd-148, bd-149`). A wave carrying **any**
`capacity` deferral **waits** instead — a mixed `capacity` + `dependency` list
included, because `capacity` is the one reason that frees itself: slots held by
another fleet free themselves, so the run stays alive and launches the wave when
a slot frees. That wait is bounded by the same `FLEET_RUN_MAX_IDLE_TICKS` stall
cap — the plan's own cap cannot fire on this path, because no member is ever in
flight — and halts the run as `stalled` (naming the capacity-blocked members)
when no slot frees within it. Retrying a still-deferred wave needs an input to
change — a member landing, a bead closing, or an explicit `belayd_fleet_advance`
— or a fresh launch. A hard launch refusal is not a transient wait: the run
completes (`partial` whenever anything remains deferred or stopped) with the
refusal text and says the wave stays deferred until an explicit
`belayd_fleet_advance` or a fresh launch (the recount race frees itself, so the
line names a viable retry). An unreadable **or vanished** fleet intent after the
advance halts the loop instead of classifying from the stale deferrals. A real
launch still counts as progress: it resets `idleTicks` and reschedules the next
tick at the 2 s action interval.

**Progress is observed, not only acted on (bd-172).** Each tick reduces every
member's progress to a signature (`kind` plus the progress's stable `key`) and
compares it with the snapshot the previous tick stored on the run
(`memberSignatures`). Any change — a phase run starting or finishing, the
completed-phase count advancing, a member becoming `complete`, failing on a *new*
phase, or awaiting a human — resets `idleTicks` before the plan runs, so the plan
and the capacity wait read the same reset counter. A changed failure *text* is not
progress: two attempts at the same failed phase carry the same key. Without the
observation rule, only a landing, stop, or launch reset the counter, and any
single-member wave whose *phases together* outlasted the cap halted as `stalled`
by construction while its member was healthy — the observed bug was a 47-minute
implement followed by an 18-minute review: 65 minutes of healthy work, no single
phase over the cap. The bound is one phase run: the signature cannot see inside a
run, so a single phase longer than ~60 minutes is reported as stalled on purpose,
and `belayd_fleet_status` names the member so a human can decide. An action that
did something still counts as progress; a `halt` or `pause` never does.

**A pause drops the baseline.** Only a paused run is ticked again, and the resume can
come an arbitrary wall-clock time later. So the tick that ends the loop deletes
`memberSignatures`: the first tick after a resume establishes a fresh baseline
without counting a reset, while `idleTicks` keeps the budget it had — a frozen
member cannot buy a new stall window by being paused and resumed.

A stop takes the member *out of the plan*, never out of the fleet: `taskIds` keeps
it (its worktree, branch, and bead are still live), `run.stopped` says why it needs
a human, and a later tick still lands it if its own retry finished the work. Only
landing (and an explicit operator prune) removes a member. That is why a bead
blocking a sibling stays a fleet dependency — `dependency`, not
`external-blocker` — instead of being reclassified as an outsider.

**The landing window is the run's lifetime.** Because a finished or halted run is
not ticked again, the tick keeps the run open (a `wait`) while a stopped member's
retry is observably alive: a live orchestrator lease for a `running` member, a
live orchestrator lease for an `awaiting-human` member whose answer poll is still
watching the open gate on its bead (bd-175), or the start grace for a member that
has not written state yet. Nothing else keeps it
open — a stopped member with no lease is only *described* as running by stale
files, and waiting on it would hold the run and its capacity slots forever.

A live human wait is bounded by a much larger cap than a stalled member: the
answer poll is alive and the decision is the human's, so the run waits (with its
own `awaiting a human response` line, never `still in flight`) instead of halting
`stalled` on the very member it must still land. That wait lasts
`FLEET_RUN_MAX_HUMAN_WAIT_TICKS` — 2880 ticks × 15 s ≈ 12 h — and then halts
with reason `awaiting-human` (not `stalled`), so a neglected gate stays
distinguishable from a healthy wait and from a dead member. If the lease dies
before either cap, the run concludes `partial` as usual.

The two caps have a deliberate precedence: a hung **non-human** member's normal
idle cap (`FLEET_RUN_MAX_IDLE_TICKS`, ≈ 1 h) outranks a live human wait
elsewhere in the run. Exempting the whole run would hide a stuck phase behind an
unrelated decision, so a tick with both a hung retry and a human wait halts
`stalled`, and its detail names the human-wait member in a trailing clause. The
12 h `awaiting-human` cap only applies when the human wait is the only work still
in flight. Every other wait is bounded by the idle cap, so a silent retry halts
the run as `stalled`.
A halt is not a *finish* (the record keeps the members and the stop reasons), but
it does end the run's ticking, so the landing window is closed either way: to land
a stopped member after a halt or a finish, re-arm the fleet (`/fleet <ids> --fleet
<id>`, which starts a new run and keeps the members as the fleet's `taskIds`) or
land the bead explicitly.

**A finish and a terminal halt release the members they can no longer land
(bd-166).** Without that, a run that ended 0-for-N kept N of the repository's 3
capacity slots forever, and the fleet that owned them had no live supervisor left
to repair them. On `finishFleetRun`, and on a halt that records `haltedReason`
(parked, stalled, or awaiting-human — a *paused* run is resumable and is never
swept), every member
the run can no longer land gets a `released: { taskId, reason, at }` entry on the
intent: reason `run-complete` or `run-halted`. A member whose work is `complete`
stays landable and is **not** released, a member whose worktree lease is live is
never released out from under itself, and a member still observably running stays
counted. The sweep is idempotent and audited as `members-released`; nothing is
removed from `taskIds`, so status, mail, and a later landing still see every
member.

**An advance extends the run it advances.** `belayd_fleet_advance` records the
members it launches in `run.members` and beats the supervisor heartbeat, so a
wave-2 member is not in `taskIds` while missing from the run record (the bd-166
wave2 symptom: `ticks: 3`, the advance launched two members, neither was in
`run.members`). `idleTicks`, stall accounting, and status all read the same list.

**A landing can happen outside the fleet.** The tick's bead sweep treats a member
as landed when bd reports its bead `closed`/`done` **and**
`git merge-base --is-ancestor <branch> <base>` proves its branch is on the base
branch — the shape `wt merge` + `bd close` leaves behind. It records `landedAt`,
prunes the member, resolves its ordering gates, and audits `fleet-landed`.
Bead status alone is not proof of merging, and a failed or missing git answer
means "not landed": never prune on a probe that did not answer. If the branch was
deleted after the merge the probe cannot answer, so such a member still needs
`belayd_fleet_release` or reconcile.

The bead evidence uses the tick's existing budget: **one member bead per tick**,
rotating by `run.ticks` (the same rotation the ordering-gate sweep uses), and
exactly one `git merge-base --is-ancestor` probe per closed candidate. A member
whose bead closes outside the fleet is therefore noticed within a fleet-sized
cycle (minutes), not on one 15 s tick, and a 20-member fleet does not become a
full-fleet `bd show` every tick. A failed bd or git probe skips the sweep for that
tick and never counts as a landing.

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
  "memberSignatures": [
    { "taskId": "bd-36", "signature": "running:phases:3/5" }
  ],
  "finishedAt": 1792947400000,
  "outcome": "complete"
}
```

- `members[].launchedAt` is the start-grace window's reference: a member that shows
  no state and no runs for `FLEET_RUN_START_GRACE_MS` (2 min) is declared missing
  rather than waited on forever.
- `landedAt` is what makes landing idempotent across ticks and supervisor restarts,
  and what satisfies dependents' edges before the bead is closed.
- `memberSignatures` is the previous tick's view of each member (`kind` plus the
  progress's stable `key`, e.g. `running:phases:3/5`, `running:in-flight:review`,
  `phase-failed:failed:implement`), which is what makes `idleTicks` mean *fleet*
  progress: a tick that observes a changed signature resets the counter even when
  its action is a wait, so a wave that keeps moving through phases cannot stall
  mid-wave (bd-172). The granularity is one phase run — the in-flight key changes
  only when a different phase starts — so a single phase longer than the cap is
  still a stall (see the `stalled` halt above). The free-text `detail` is
  display-only and never compared, so re-reported model text cannot reset the cap. A
  member seen for the first time has no baseline and is not counted as progress —
  the launch tick already reset the counter — and a genuinely frozen member never
  changes it, so the 240-tick cap still halts. The field lives on the run record so a
  supervisor restart keeps the baseline, and it is dropped on every tick that ends
  the loop (a pause included), so a resume re-baselines instead of comparing across
  the operator's gap.
- A new launch on a fleet with a live run adds members to it instead of starting a
  second run.

## Landing and accepting

`land` runs the unchanged merge queue (`belayd_fleet_merge`'s engine): enqueue the
member's branch, acquire `merge.lock.d`, stash a dirty root, rebase, run the
project gates, `git merge --ff-only`, restore the root, notify members.

Then the accept step (`src/fleet-accept.ts`) finishes the landing:

1. When acceptance was asked for (`accept: true` / `--accept`), `bd close <id>
   --reason "merged into <base> via belayd_fleet_merge"`. A bead that is already
   closed is accepted with a warning, not an error.
2. `git worktree remove <path>` — **without `--force`**, so a dirty worktree is left
   alone and reported; this step never deletes uncommitted work. It runs on
   **every** landing, with or without acceptance: the branch is already on the base
   branch, so a merged worktree has no remaining purpose.
3. `git branch -d <branch>` — `-d`, not `-D`, so an unmerged branch is never
   deleted.

A failure to close the bead stops the member with `accept-failed` but keeps the
landing: the branch is on the base branch, the member is out of the member list,
and the close failure returns before the removal half runs — so the bead **and** its
worktree are left for you to finish by hand.

**Bead status after a run.** `belayd_fleet_merge` never touches a bead, and neither
does the merge half of a landing: the landing resolves the bd ordering gates the
merge satisfied and leaves the bead `in_progress` + `human`. Closing is acceptance,
requested by the launch (`accept: true` / `--accept`) and audited as `fleet-landed`;
without it the close stays the documented human step (`wt merge` / `bd close`).

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
| A session whose `session_start` finds only an inert persisted workflow (complete, handed off, or invalid task id) | No lease claimed and no heartbeat started; the dead `workflow.json` is archived as `workflow.stale-<epoch-ms>-<hex>.json` (bd-165; see `docs/bd-165-userguide.md`) |
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
  daemon exits; the run record is durable. A restarted supervisor re-adopts its
  own active run automatically when the record names it and the beat is cold
  (bd-169), and a session that cannot re-adopt says so instead of going quiet —
  with the `/fleet <ids> --fleet <id>` recovery command. Members are sessions in
  the same daemon, so nothing outlives the daemon anyway.
- **One landing per tick.** A tick that lands runs the project gates for minutes; a
  second tick is skipped while one is in flight (`fleetTickInFlight`). Three
  finished members land on three ticks.
- **Gates are not retried.** A gate/merge refusal stops the member with
  `land-failed`. Retrying with no new information would burn the same minutes again.
  A **rebase** failure is the one exception, and it is classified first: a stale
  state is cleared and retried once, generated paths are regenerated, and a
  conflict a live member can resolve is delegated back to it with a `rebase-hint`
  instead of a stop (bd-280, `docs/fleet-merge.md`). Only a contradiction, or a
  failure nobody can classify, records `land-failed`.
- **A delegation is deliberate and recorded.** The tick that delegates reports the
  member's complete conflicted path list and records it in `audit.log` as
  `fleet-land-delegated`; the member is kept (no stop, no retirement, no worktree
  removal) while the landing holds until its branch contains the base. An
  unreadable branch verdict is a hold as well — re-draining on it would rewrite
  `delegatedAt` and re-send the hint every tick, so the grace window could never
  expire. A member stopped by a land attempt is not retried, and a delegation whose
  grace expires is a stop — not a silent retry.
- **`accept` is the run's decision, not the merge engine's.** `belayd_fleet_merge`
  keeps "merging is not closing"; only a run with `accept: true` (opt-in, bd-158)
  closes beads, and every close is audited. The merged worktree is removed on every
  landing either way, because that removal is hygiene, not acceptance.
- **A failed ordering-gate resolve does not stop a landing.** The merge happened,
  so `landedAt` is recorded and the member is pruned; the still-open gate stays in
  `fleet.json`, shows up as `ordering gates open: …` in `belayd_fleet_status`, and
  the next tick retries the resolve (re-running only the resolve — the merge queue
  entry is already `merged`, so a second merge is impossible). Treating a transient
  bd failure as a stop would end the run `partial` and wedge a merged member.
- **Gate warnings are shown once per gate per run, up to a bound.** The rotating
  sweep rediscovers a drifted reason (bd truncated the gate `--reason`) and an
  adoption it had to refuse on every pass, and the tick loop notifies every line it
  returns. The reported gate ids are remembered on the run record (`gateNoticeIds`),
  so a 15-second loop warns once instead of on every tick; a reconcile pass — an
  explicit repair by a human — sweeps all members and reports every finding it makes.
  The ledger holds at most `FLEET_RUN_GATE_NOTICE_IDS_MAX` (256) ids. A run that has
  already reported 256 distinct gate ids stops warning about **new** gates for the
  rest of that run: the code stays silent instead of re-warning (and instead of
  letting one run's record grow without bound). Those findings are not hidden —
  `belayd_fleet_status` keeps listing every open ordering gate, and
  `belayd_fleet_reconcile` re-reports every finding fresh — so a human sees the
  drift there and resolves it by gate id. A single run that churns that many gates
  has a larger problem than a missing warning.
- **A stopped member stays a fleet member.** `fleet.json` `taskIds` still names it,
  `run.stopped` carries its reason, and `belayd_fleet_status` renders both the
  `stopped …` line and its live worktree. Its deferred plan entry is retired, so an
  advance never relaunches it; fix the cause and the loop lands it if its own retry
  already finished the work.

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
