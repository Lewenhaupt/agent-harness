# Fleet supervisor — operator entry point (bd-126)

`/fleet bd-12 bd-15 bd-19` takes several beads at once, runs each as a normal
Belayd workflow in its own worktree and its own detached orchestrator session,
orders them by bd's blocking dependencies inside a ceiling of **3 concurrent
orchestrators**, carries notes between you and the members, and then **runs to
completion**: it lands each finished branch on the base branch, accepts it (closes
the bead, removes the worktree), and starts the next wave until every member is
done.

All six milestones are implemented: **P0** status, **P1** launch + mailbox,
**P2** merge queue, **P3** ordering/capacity, **P4** pause/advance/reconcile,
**P5** the run loop and the one-orchestrator-per-worktree lease.

`--manual` restores the older explicit surface (launch, land, and advance only when
you call a tool); `--no-accept` lands without closing beads.

This page is the map: the end-to-end run, which tool for which situation, how to
get out of each failure, and how to verify the surface. Detail stays in the
per-area docs.

| Doc | Covers |
|-----|--------|
| `docs/fleet-run.md` | P5: run-to-completion, the tick, accepting a landed member, the worktree lease, supervisor heartbeat |
| `docs/fleet-status.md` | P0: `belayd_fleet_status`, field/state decoding, warning triage, read-only proof |
| `docs/fleet-launch.md` | P1+P3: `/fleet`, `belayd_fleet_launch`, waves and capacity, the mailbox, the fleet refusal |
| `docs/fleet-merge.md` | P2: `belayd_fleet_merge` enqueue/drain, root stash/park, gates |
| `docs/fleet-reconcile.md` | P4: pause/resume/advance/reconcile, the repair table, the liveness model |
| `docs/fleet-orchestrator.md` | Design record: architecture, shared state layout, locked decisions, per-milestone design |
| `docs/owned-worktree.md` | The bd-119 bead ↔ branch ↔ worktree preflight every member still obeys |

## How to Use

### The shape of a fleet

The supervisor is a **scheduler**. It owns no worktree, arms no process gate, and
runs no phase. Each member is an ordinary single-bead orchestrator with its own
process gate, worktree, and `.belayd/` directory. Cross-tree state lives in
`<git-common-dir>/belayd/fleet/<fleetId>/`:

```text
fleet.json         operator intent: taskIds, maxConcurrent, paused, deferred, park, run record, supervisor record
supervisor.json    run-mode supervisor heartbeat (re-arm eligibility)
orchestrator.json  in each member worktree: the one-orchestrator lease
audit.log          append-only: every cross-tree action
inbox/             member → supervisor notes      (belayd_fleet_inbox drains + acks)
events/            supervisor → member notes      (drained at each member's turn start)
merge-queue.json   single-flight merge queue       merge.lock.d guards acquisition
```

Nothing in that directory is written by `belayd_fleet_status`; it is written by
launch, note, merge, pause/resume, and reconcile, and only from a session that is
the fleet's live supervisor.

### The run, step by step

#### 1. Launch

```text
/fleet bd-12 bd-15 bd-19            # run to completion (the default)
/fleet bd-12 bd-15 --manual         # explicit surface: nothing lands or advances on its own
/fleet bd-12 bd-15 --no-accept      # land, but leave the beads for you to close
```

or the tool form:

```json
{
  "tasks": ["bd-12", "bd-15", "bd-19"],
  "fleetId": "default",
  "concurrency": 3,
  "untilComplete": true,
  "accept": true
}
```

Validate → write intent → launch → prune. Validation happens first and a refusal
creates nothing at all (no fleet directory, no worktree, no session): invalid ids,
duplicate ids, an id already in a live fleet, a worktree owned by another bead, a
bead already driven by a standalone orchestrator, or a worktree whose orchestrator
lease is still live (one orchestrator per worktree — see `docs/fleet-run.md`).

With `untilComplete` (the default) the launch then records a **run** in
`fleet.json` and starts the supervisor's ticker; see [step 8](#8-let-it-run-to-completion).

The report tells you what started and what waits (wording is the tool's own; the
counts come from your request):

```text
Fleet `default`: 1/3 member(s) launched (maxConcurrent 3).
Scheduling: 1 member(s) now, 2 deferred (capacity 3, ...).
- wave 0 (now): bd-12
- deferred bd-19 (capacity): ...
- bd-12: launched (feature) — worktree `feat/bd-12`, orchestrator session <id>
```

- **Ordering is real.** Only bd's `blocks` edges order members; `related` links are
  not edges. A dependency cycle refuses the whole launch with the closed path and
  writes nothing — break it with `bd dep remove` first.
- **Ordering is optional when bd is not readable.** No bd, a timeout, or non-JSON
  output degrades to "no known edges" plus a warning; the members still launch in
  your order.
- **Ceiling is 3 orchestrators**, counted across **every** fleet in the repository,
  because a detached member keeps running after the supervisor that launched it
  dies. A request above 3 is clamped and reported; a fraction is floored and
  reported. Slots are re-counted inside the intent's compare-and-replace, so a
  concurrent launch that spent the planned slots refuses instead of overshooting.
- The remainder is **deferred, never dropped**: `capacity`, `dependency`, or
  `external-blocker`, listed in the report, in `audit.log`, and in `fleet.json`
  `deferred` (`belayd_fleet_status` renders them as `deferred: bd-19 (capacity)`).
- A launch (or advance) that starts nothing because every slot is busy is a
  **success** (exit 0). Nothing to do is not an error.

**Recover supervisory authority after a restart with a re-arm, not a relaunch:**

```text
/fleet bd-12 bd-15 --fleet default
```

Members of that fleet are preserved (not relaunched), the supervisor record is
rewritten, and the call is audited as `re-arm`. One session supervises one fleet;
asking a supervisor to launch a second fleet is refused before any write.

#### 2. Watch

```text
what is the fleet doing?
```

`belayd_fleet_status` (read-only, P0) renders every worktree's derived state,
persisted deferrals, and a `parked:` line when the fleet is parked. On a
beads-backed repo each member also carries `owner:`, `assignee:`, `human:`,
`bead updated:`, `comment count:`, `awaiting human:` (yes/no/**unknown**) and
`newest comment:` lines, and any bead that needs a person is named together in
a `Needs you (<n>): <ids>` block under the `states:` line. Those columns cost two
extra read-only `bd` calls per member (`bd comments <id> --json`,
`bd gate list <id> --json`), bounded to 4 beads at a time and each read watched
for a deadline; a malformed gate record renders `unknown`, never `no`, and a
failed or entirely unparseable comment read renders `(unknown)`, never the
empty-thread `(none)`. A
total outage of both reads for every member becomes one `bead engagement
unavailable` warning; a per-bead failure only degrades that bead. Real output
from this repository is in [How to Verify](#how-to-verify). Reading guide:

| State | Meaning |
|-------|---------|
| `active` | a phase is running or the workflow is mid-flight |
| `awaiting-human` | waiting for the operator (review response, or an undelivered report) |
| `blocked` | the newest run of a not-yet-completed phase failed |
| `interrupted` | a run manifest is `interrupted` (crash/kill mid-phase) |
| `idle` | every phase completed |
| `missing-state` | no readable `.belayd/workflow.json` — including a workflow that **finished**, because completion deletes the state file and leaves the run manifests |

A finished workflow therefore shows `missing-state` with
`latest runs: commit=completed, …`. Do not treat that as breakage; read the run
line. A worktree with neither state nor manifests is the case the
`no .belayd/workflow.json …` warning is for.

**Which session is the supervisor.** The supervisor is an ordinary chat session
whose run loop is a background timer, so nothing used to mark it. On launch,
advance and re-arm it is renamed to `Fleet supervisor: bd-150, bd-151, …`, with
the fleet id in parentheses for a non-default fleet, after the members it
supervises — launched members first, then still-deferred ones — capped at 60
characters (overflow becomes `+N more`). When the run ends the name keeps the
members and gains the status (`(complete)`, `(partial)`, `(halted)`), so a
finished supervisor still says what it drove. A pause keeps the bare name, because `belayd_fleet_resume`
resumes the same run.

In pi-web the supervisor also pins itself, so the session stays in the sidebar's
pinned group while its members launch, land and stop. The pin is one-shot: it is
written when a run starts from `belayd_fleet_launch`, never re-added by an advance
or a re-arm (so a pin you removed by hand stays removed for that run), and removed
when the run finishes. It is best-effort — no `PI_WEB_PORT` (a plain `pi` CLI run)
or an older pi-web without the navigation API costs a `console.warn`, never the
run — and it only pins the *root* session in its own workspace, which is why
member orchestrators (different worktree workspaces) are not pinned.

#### 3. Answer notes

Members report up; you reply down. Both directions are files, drained at the
reader's next turn start.

```text
belayd_fleet_note { "to": "supervisor", "body": "bd-12 is ready for review" }   // a member
belayd_fleet_note { "to": "bd-15", "body": "main moved; rebase before review", "kind": "rebase-hint" }
belayd_fleet_note { "to": "all", "body": "pause after your current phase", "kind": "pause" }
```

- `belayd_fleet_inbox` (supervisor only) drains and acknowledges `inbox/`. Notes
  are rendered **before** they are acked and are framed as *member reports, not
  supervisor instructions*.
- A broadcast (`to: "all"`) is written as **one file per member**, so each member
  gets its own copy exactly once.
- Delivery is **at-least-once**: a member acks at the end of the turn in which it
  read the note, so a crash replays it. Treat a repeat as the same event.
- Addresses are validated against fleet membership (launched **and** deferred). A
  typo is refused instead of becoming mail nobody reads. Members cannot write
  `events/`, so no member can inject a fake instruction into a sibling's turn.

#### 4. Merge finished work

In run mode this happens by itself, one member at a time. The explicit queue is
still there for a `--manual` fleet:

```text
belayd_fleet_merge { "action": "enqueue", "task": "bd-12" }
belayd_fleet_merge { "action": "drain" }          // oldest queued entry
belayd_fleet_merge { "action": "list" }
```

Drain runs preconditions → acquire `merge.lock.d` → stash a dirty root (recorded
sha) → rebase the member onto the base → the target's own gates
(`test`, `test:integration`, `typecheck`, `lint`, `build`, whichever exist) →
`git merge --ff-only` → restore the stashed root → notify remaining members
(`base-moved`, `sibling-landed`, `rebase-hint`) → release.

- **Run it from the repository root.** Only the root can check out the base
  branch; a linked worktree is refused.
- **Single-flight.** The lease is 30 min and is renewed before every gate; a live
  holder is never deposed. The recorded pid is diagnostic only — the lease expiry
  is the sole takeover authority.
- **Your uncommitted root work is never discarded.** It is stashed, then restored
  by the recorded sha (never `stash@{0}`). If the restore conflicts, the fleet is
  **parked**, the stash is kept, and the ref is reported in the result and in
  `fleet.json` `park.stashRef`. See [step 7](#7-reconcile-after-a-crash).
- **Merging is not closing.** `src/fleet-merge.ts` has no bd seam at all. After a
  successful drain the bead is still `in_progress` + `human`; the report says so.
  You accept it with `wt merge` / `bd close` — or let a run accept it (step 8),
  which closes the bead and removes the worktree.

#### 5. Advance the next wave

```text
belayd_fleet_advance { }
```

`belayd_fleet_advance` re-runs the scheduler over the persisted `deferred` list:
re-read the edges, refuse a cycle, re-apply the ceiling, launch what fits, record
the rest again. Audited as `advance` + `schedule-planned` + per-member deferrals.
It refuses while the fleet is paused, with no deferred members, or with no intent.

**In run mode the loop advances itself** (step 8). For a `--manual` fleet nothing
advances on its own: advance is a call you make (or an explicit `/fleet bd-19`).
Either way a blocked member becomes eligible only when bd stops reporting the
blocking edge — i.e. when the blocker bead is `closed` (or `done`) — **or** when
this fleet already landed that blocker, which satisfies the edge before the bead is
closed (`docs/fleet-run.md`).

#### 6. Pause and resume

```text
belayd_fleet_pause { "reason": "stepping away" }
belayd_fleet_pause { "force": true, "reason": "runaway member" }

belayd_fleet_resume { }
belayd_fleet_resume { "force": true }    // keep a stash you restored by hand
```

Pause writes `paused` + the reason and queues a `pause` note to every member; from
then on any launch that would start a member, `belayd_fleet_advance`, and merge
`drain` refuse. A pure re-arm (`/fleet <existing ids>` that preserves every member
and starts nothing) is still accepted — it is the way back to a stopped fleet.
Resume clears the flag (and a park, when no stash pointer remains) and queues a
`resume` note.
Resuming a fleet that is not paused is a successful no-op.

**Cooperative pause cannot interrupt a running phase.** A member is a detached
session: it reads the note at its next turn start and stops *starting* work. A
phase already in flight runs to completion or to its own failure.

**Forceful pause only delivers a signal.** It matches members by the exact
`belayd-<taskId>` session token, re-verifies the pid's `/proc` start time and token
immediately before each signal, and skips (audited) rather than guesses when a pid
was recycled or its identity cannot be read. It guarantees delivery to a process
it could positively identify — **not** that the process exited, that the phase's
sub-agents died, or that in-flight writes completed. There is no `SIGKILL`
escalation: a half-written worktree or an interrupted rebase is exactly what the
bd-119 preflight cannot reason about. Verify with `belayd_fleet_status`, `ps`, and
the worktree's `git status` before you relaunch anything.

#### 7. Reconcile after a crash

```text
belayd_fleet_reconcile { }
belayd_fleet_reconcile { "pruneDeadMembers": true }   // also remove provably-dead members
```

Run it in the repository root, in a session that is the fleet's live supervisor
(re-arm first if the old supervisor is gone). Reconcile repairs the queue
(expired lease, record without its primitive, orphaned directory past the grace
window, entry frozen mid-flight), retries a parked root restore from the recorded
sha, and reports supervisor + member liveness from the process table. It is
idempotent: a second run reports `nothing to repair`.

Operational limits, at the point you hit them:

- **Never `failed`.** Reconcile re-queues a frozen entry (attempt count preserved)
  or marks it `merged` when git proves the branch already landed. A crash is not a
  failed merge, so nothing is labelled a failure that did not happen — but that
  also means an entry you expected to be quarantined is queued again and will be
  re-rebased and re-gated on the next drain.
- **Never re-applies a dropped stash.** If the recorded sha is no longer in
  `git stash list`, reconcile reports "already restored or dropped", leaves the
  checkout alone, and unparks.
- **Pruning changes the count, not the worktree.** With `pruneDeadMembers`, a
  member whose orchestrator is provably absent is removed from `taskIds`; its
  worktree, transcript, and bead stay. "Provably absent" now means **no live
  worktree lease AND no matching process** (a completed process-table scan found
  no `belayd-<taskId>` argv): a pi-web orchestrator never appears in the process
  table, so the lease is what keeps a running member from being pruned — the
  bd-37 incident pruned a live member 25 s after its launch, which freed a slot
  and started a second orchestrator on one worktree. `unknown` liveness
  (unreadable `/proc`, an unreadable lease) is never pruned. The parameter is
  `pruneDeadMembers` (camelCase) — the refusal hint in the report says "re-run
  with prune-dead-members", which is prose, not the parameter name.
- **Capacity is narrowed by pruning, never by liveness subtraction at launch.**
  The launch path always counts every recorded member of every fleet; a verdict
  from the process table or the lease is not wired into it. So a dead member holds
  a slot until you prune it (or the run loop lands it, which prunes it).
- **A pruned member cannot be relaunched through the fleet while its lease is
  live.** The lease names the session that owns the worktree, so a second launch is
  refused (`live orchestrator lease`) instead of creating a duplicate orchestrator.
  Once the lease is cold, relaunch normally, or resume the old session.
- **The intent CAS is check-then-write.** `fleet.json` updates compare the bytes
  they read and then rename, so two simultaneous supervisors can both win that
  window (the merge lock is the only `mkdir`-based primitive). There is at most
  one live supervisor per fleet by construction — the arm token and process
  identity make a second one fail to match — but a deliberately planted record
  inside a writable fleet directory is outside that guarantee; see the threat
  model in `docs/fleet-orchestrator.md`.

#### 8. Let it run to completion

```text
/fleet bd-12 bd-15 bd-19
```

The launch records a `run` in `fleet.json` and starts the supervisor's ticker.
Every tick does exactly one thing, in this order — land the first finished member,
stop the first member that needs a human, advance the deferred wave, or finish:

```text
1  land     bd-12: merged into main, bead closed, worktree removed
2  advance  bd-19 launched (bd-12 landed, so its edge is satisfied)
…
   run: until-complete — complete (11 tick(s))
```

- **Accepting is the run's landing step**: `bd close` + `git worktree remove` +
  `git branch -d`, all conservative (no `--force`, no `-D`). `--no-accept` skips
  the close and leaves the beads for you.
- **A member that needs a human is stopped, never relaunched.** `awaiting-human`,
  failed phase, interrupted run, unreadable state, or a vanished orchestrator all
  end that member's part of the run with a reason in `belayd_fleet_status`.
- **Pause stops the timer without finishing the run**; `belayd_fleet_resume` starts
  it again. A parked or stalled run is halted and recorded (`haltedReason`), and a
  halt is terminal for that run record: `resume` only restarts a *paused* run, so a
  halted one continues only through a re-arm (after `belayd_fleet_reconcile` for a
  parked fleet).
- **A re-arm restarts the loop.** After a supervisor restart (or a halt), `/fleet
  <ids> --fleet <id>` preserves the members and starts a new run record in place of
  the old one. The run-mode supervisor heartbeat is what makes that re-arm
  possible.

The full contract — tick table, run record fields, stop reasons, acceptance, the
worktree lease — is in `docs/fleet-run.md`.

### Decision table

| Situation | Tool | What it writes |
|-----------|------|----------------|
| Start several beads and run to completion | `/fleet`, `belayd_fleet_launch` | `fleet.json` (intent + `run`), `audit.log`, worktrees + sessions |
| Start several beads without the loop | `/fleet <ids> --manual` | the same, without a `run` record |
| Recover supervision after a pi restart | `/fleet <ids> --fleet <id>` | supervisor record + `re-arm` audit; members preserved; the run loop resumes |
| What is every worktree doing? | `belayd_fleet_status` | nothing (read-only; no fleet dir created) |
| Ask one member something / tell it main moved | `belayd_fleet_note` (`kind: rebase-hint`) | one file in `events/` |
| Tell every member | `belayd_fleet_note` `to: "all"` | one file per member in `events/` |
| Did a member report? | `belayd_fleet_inbox` | drains + acks `inbox/`, `inbox-drain` audit |
| Land a finished member (manual fleet) | `belayd_fleet_merge` `enqueue` then `drain` | `merge-queue.json`, the base branch, `base-moved` notes |
| Land + accept, automatically | the run loop (default) | the base branch, bead status, worktree removal, `fleet-landed` audit |
| What is queued / is a merge in flight? | `belayd_fleet_merge` `list` | nothing |
| Start the deferred members | `belayd_fleet_advance` | new members, updated `deferred` |
| Stop starting new work | `belayd_fleet_pause` | `paused`, `pause` notes, `fleet-paused` audit |
| Stop a member that ignores mail | `belayd_fleet_pause` `force` | SIGTERM + per-pid audit (delivery only) |
| Come back | `belayd_fleet_resume` | clears `paused`/`park`, `resume` notes |
| Repair after a crash | `belayd_fleet_reconcile` | queue/park repair, liveness report |
| Narrow the capacity count | `belayd_fleet_reconcile` `pruneDeadMembers` | removes members with no live lease and no process from `taskIds` (never `unknown`) |
| Accept one member's work + worktree | a run with `accept: true` | bead status + worktree removal, audited |
| Accept the work without the loop | `wt merge`, `bd close` | bead status — `belayd_fleet_merge` itself never touches a bead |

`belayd_fleet_status` and `belayd_fleet_note` work in any session that is inside a
fleet (the supervisor writes `events/`, a member writes `inbox/`). `belayd_fleet_inbox`,
`belayd_fleet_merge`, `belayd_fleet_pause`, `belayd_fleet_resume`,
`belayd_fleet_advance`, and `belayd_fleet_reconcile` are **supervisor-only**: they
refuse unless `fleet.json` names this session as the live supervisor, and a record
left by a dead process does not count — re-arm with `/fleet` first.

### Failure recovery

| Symptom | What happened | What to do |
|---------|---------------|------------|
| `Fleet \`default\` is paused (<park reason>); resume it with belayd_fleet_resume before launching more members (run belayd_fleet_reconcile first if the root work is parked)` | P2 stashed your dirty root, landed the merge, and could not restore the stash cleanly. Your work is in the stash | `belayd_fleet_reconcile` restores the recorded sha, verifies it, drops it, and unparks — or reports exactly what blocks it (root is a linked worktree, root moved off the base branch, sha gone, apply conflict). Then `belayd_fleet_resume` if the pause is still set. `resume force` clears the pause and leaves the stash, naming the ref. Never delete the stash by hand first. A run-mode ticker that halted as `parked` does not restart on resume: re-arm with `/fleet <ids> --fleet <id>` |
| `merge lock is held by … until …` | Another drain (or a dead supervisor's lease) owns the queue | Wait, or let the lease expire — the expiry is the only takeover authority, the recorded pid is diagnostic. `belayd_fleet_reconcile` takes over an expired lease for you |
| `<lockDir> exists without a lock record (acquisition in progress, or a holder crashed before writing its lease); retry after 30s or remove the directory by hand` | A holder crashed between `mkdir` and writing its lease, or is inside that window | Retry after ~30 s (grace window); reconcile reclaims it past the grace. Removing `merge.lock.d` by hand is safe only when no drain is running |
| Supervisor is gone; every fleet tool says `supervisor-only` | The supervisor session died. Its lease and run record survive on disk, and a run-mode fleet's recorded pid is the shared daemon, so only the supervisor heartbeat can say it is gone | `/fleet <its ids> --fleet <id>` in a new session: re-arm rewrites the supervisor record, preserves the members, and (because the intent has a `run`) starts the loop again — a new run record when the old one finished or halted. Then `belayd_fleet_status`; `belayd_fleet_reconcile` if the queue or root was left mid-flight |
| A member is `stopped` in the run line | The loop gave up on it for a reason that needs you (`phase-failed`, `awaiting-human`, `orchestrator-missing`, `land-failed`, `accept-failed`) | Fix the cause. The member stays in the fleet (`taskIds` plus `run.stopped`), so `belayd_fleet_status` still shows it with its worktree; the loop never relaunches it by itself, but it does land it if its own retry finished the work. The run waits for that retry only while it is observably alive (live lease) — if the run has already finished or halted, relaunch (re-arm) or land the bead explicitly. `belayd_fleet_reconcile` `pruneDeadMembers` forgets a provably-dead member's capacity slot (removes its id from `taskIds`); its `run.stopped` line and the run outcome stay, because a prune does not rewrite history |
| `Refusing to launch … live orchestrator lease` | The worktree already has a live orchestrator session (its lease is fresh) | One orchestrator per worktree: finish or stop that session. If it is really gone, the lease goes cold after ~3 min and the next launch takes it over (the old record is archived, and the takeover is reported) |
| Launch refused with `dependency-cycle` and a closed path (`bd-12 → bd-15 → bd-12`) | bd's `blocks` edges form a cycle; no valid order exists | `bd dep remove`, then relaunch. Nothing was created, so there is nothing to clean up |
| `Scheduling: 0 member(s) now, N deferred (capacity 3, 3 already active, 0 free slot(s))` | The ceiling is full — normally because members of another fleet (or a dead supervisor's fleet) are still recorded | Not an error (exit 0). `belayd_fleet_status` shows who is active; let a member finish, or `belayd_fleet_reconcile` `pruneDeadMembers` (positive `absent` evidence only — never `unknown`), then `belayd_fleet_advance`. Do not edit `fleet.json` by hand to drop ids. **A stopped member holds its slot until it lands or is pruned**, and a member whose retry session is still alive is never prunable, so an all-stopped fleet can pin the ceiling of 3 until those retries end, land, or the supervisor prunes them after the sessions are gone |
| `<n> fleet intent(s) under this repository's fleet root cannot be read (<ids>). Counting only the readable fleets could exceed the ceiling of 3 …` | `fleet.json` does not parse (hand edit, truncation, newer schema). Writers refuse to replace a present-but-unparsable record, and an unreadable intent refuses a launch rather than assuming zero active members | Inspect `fleet.json`; restore a valid record (or move it aside if the fleet is really finished). Reconcile and launch both refuse until it parses — this is deliberate, because guessing the member count can overshoot the ceiling |
| `bead metadata unavailable (bd read failed): …` in the status view | `bd show` failed, timed out, is not installed, or the checkout has no beads database | Nothing about the workflow view is wrong; states, phases, and runs still derive. Ignore unless you need titles/statuses |
| `bead engagement unavailable (bd read failed): …` in the status view | **Every** member's `bd comments` **and** `bd gate list` reads failed (bd missing, wrong database, total outage) | Same: the derived view is intact, only owner/assignee/human/comment columns are missing. Reported once per fleet, not once per member. A mixed result (some beads readable) is not a warning: those beads render `unknown` columns |
| `Needs you (n): …` names a bead but the bead looks idle | The bead carries bd's `human` label or has an open `human` gate | Answer in bd/Scotty (the member's session polls the comment thread and resolves the gate). `belayd_fleet_status` only reports the wait; it never resolves it |

## How to Verify

Run everything from the repository root. The driver loads `extensions/index.ts`
through `jiti`, so no build step is needed.

### 1. Gates

Produced in this worktree on `feat/bd-126`:

```bash
pnpm test              # Test Files  93 passed (93);  Tests 2280 passed (2280)
pnpm test:integration  # Test Files   9 passed (9);   Tests   72 passed (72)
pnpm typecheck         # tsc --noEmit — no output
pnpm lint              # Checked 177 files in 340ms. No fixes applied.
pnpm build             # tsc — no output
```

The fleet suites are the files matching `src/__tests__/fleet-*.test.ts`, plus
`src/__tests__/orchestrator-claim.test.ts`,
`src/__tests__/extension-fleet-status-tool.test.ts` and
`src/__tests__/extension-fleet-p1.test.ts`, and the two integration files
`test/fleet-status.integration.test.ts` and `test/fleet-merge.integration.test.ts`.
The P5 property table (which case pins which invariant) is in
`docs/fleet-run.md#how-to-verify`.

### 2. See a real fleet view in this repo

Install the driver (it registers the extension and calls one tool):

```bash
cat > /tmp/belayd-fleet-tool.ts <<'TS'
interface FleetTool {
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ text: string }>;
    details: { exitCode: number };
  }>;
}

const repo = process.env.BELAYD_REPO ?? process.cwd();
const mod = (await import(`${repo}/extensions/index.ts`)) as { default: (api: unknown) => void };

const tools = new Map<string, FleetTool>();
const api = {
  registerTool: (def: FleetTool & { name: string }) => tools.set(def.name, def),
  registerCommand: () => {},
  on: () => {},
  sendMessage: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
  events: { emit: () => {}, on: () => () => {} },
};
mod.default(api);

const tool = tools.get(process.env.BELAYD_TOOL ?? "belayd_fleet_status");
if (tool === undefined) throw new Error("tool was not registered");

const result = await tool.execute("doc", JSON.parse(process.argv[2] ?? "{}"), undefined, undefined, {
  cwd: process.argv[3] ?? repo,
});
console.log(result.content.map((part) => part.text).join("\n"));
console.error(`[exitCode=${result.details.exitCode}]`);
process.exit(result.details.exitCode ?? 0);
TS

export BELAYD_REPO=$(pwd)
J=$BELAYD_REPO/node_modules/.bin/jiti
T=/tmp/belayd-fleet-tool.ts
nix develop -c bash -lc "$J $T '{}'"
```

Produced in this worktree:

```text
Fleet default
  intent: none recorded
  members: 2
  states: active=0 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=2

Member (no task id) — missing-state
  worktree: /home/hugo/git/belayd-agent-harness.feat-bd-125 (branch feat/bd-125)
  workflow: missing
  interrupted runs: 0
  last updated: 2026-10-21T22:55:47.738Z
  latest runs: commit=completed, implement=completed, proof=completed, review=completed, test=completed, userguide=completed

Member (no task id) — missing-state
  worktree: /home/hugo/git/belayd-agent-harness.feat-bd-126 (branch feat/bd-126)
  workflow: missing
  interrupted runs: 0
  last updated: 2026-10-22T20:12:42.382Z
  latest runs: commit=completed, implement=completed, proof=completed, review=completed, test=completed, userguide=completed

Warnings (2):
  - no .belayd/workflow.json in /home/hugo/git/belayd-agent-harness.feat-bd-125; that worktree drives no workflow
  - no .belayd/workflow.json in /home/hugo/git/belayd-agent-harness.feat-bd-126; that worktree drives no workflow
```

Read it as: both linked worktrees finished their workflow (state cleared, manifests
kept), so no member has a task id, so **no** `bd show`, `bd comments`, or
`bd gate list` call happened at all and there are no `bead:`/ownership lines.
The main checkout is absent because it holds no
workflow state. `latest runs` is alphabetical here only because `phaseOrder` is
unknown without `workflow.json`.

A view with an intent, a deferral and a park — in a throwaway repository, so
nothing here touches your checkout:

```bash
root=/tmp/fleet-demo
rm -rf "$root" "$root".feat-bd-12 "$root".feat-bd-15
mkdir -p "$root" && cd "$root"
git init -q && git symbolic-ref HEAD refs/heads/main
git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && git add -A && git commit -qm base
git worktree add -q -b feat/bd-12 "$root.feat-bd-12"
git worktree add -q -b feat/bd-15 "$root.feat-bd-15"
mkstate() { # dir task branch completed awaiting
  mkdir -p "$1/.belayd/runs"
  printf '%s' "{\"schemaVersion\":1,\"taskId\":\"$2\",\"workflowType\":\"feature\",\"branch\":\"$3\",\"originalCwd\":\"$1\",\"phaseOrder\":[\"plan\",\"implement\",\"review\",\"test\",\"userguide\",\"proof\",\"commit\"],\"completedPhaseNames\":$4,\"awaitingReviewResponse\":$5,\"startedAt\":1761000000000,\"updatedAt\":1761000900000}" > "$1/.belayd/workflow.json"
}
mkstate "$root.feat-bd-12" bd-12 feat/bd-12 '["plan","implement","review"]' false
mkstate "$root.feat-bd-15" bd-15 feat/bd-15 '["plan","implement","review","test"]' true
mkdir -p "$root/.git/belayd/fleet/default"
printf '%s' '{"schemaVersion":1,"runId":"r1","taskId":"bd-12","phase":"plan","sessionName":"belayd-bd-12-plan","status":"completed","startedAt":1761000000000,"completedAt":1761000060000}' > "$root.feat-bd-12/.belayd/runs/r1.json"
printf '%s' '{"schemaVersion":1,"runId":"r2","taskId":"bd-12","phase":"implement","sessionName":"belayd-bd-12-implement","status":"running","startedAt":1761000600000}' > "$root.feat-bd-12/.belayd/runs/r2.json"
printf '%s' '{"schemaVersion":1,"runId":"r3","taskId":"bd-15","phase":"test","sessionName":"belayd-bd-15-test","status":"completed","startedAt":1761000300000,"completedAt":1761000900000}' > "$root.feat-bd-15/.belayd/runs/r3.json"
printf '%s' '{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12","bd-15"],"createdAt":1761000000000,"updatedAt":1761000900000,"maxConcurrent":3,"baseBranch":"main","deferred":[{"taskId":"bd-19","reason":"dependency","detail":"wave 1: waits for bd-12 to land"}],"supervisor":{"sessionId":"demo-session","pid":4242,"pidStartTime":"1000","armToken":"demo"}}' > "$root/.git/belayd/fleet/default/fleet.json"
mkdir -p "$root/.git/belayd/fleet/night"
printf '%s' '{"schemaVersion":1,"fleetId":"night","taskIds":["bd-12","bd-15"],"createdAt":1761000000000,"updatedAt":1761000900000,"maxConcurrent":3,"baseBranch":"main","paused":true,"note":"root work could not be restored","park":{"reason":"root restore conflicted: refs/stash@{0}","stashRef":"refs/stash@{0}","recordedAt":1761000900000},"supervisor":{"sessionId":"demo-session","pid":4242,"pidStartTime":"1000","armToken":"demo"}}' > "$root/.git/belayd/fleet/night/fleet.json"
cd - > /dev/null
nix develop -c bash -lc "$J $T '{}' /tmp/fleet-demo"
nix develop -c bash -lc "$J $T '{\"fleetId\":\"night\"}' /tmp/fleet-demo"
```

Produced with that script:

```text
Fleet default
  intent: bd-12, bd-15, max 3 concurrent
  deferred: bd-19 (dependency)
  members: 2
  states: active=1 blocked=0 awaiting-human=1 interrupted=0 idle=0 missing-state=0

Member bd-12 — active
  worktree: /tmp/fleet-demo.feat-bd-12 (branch feat/bd-12)
  workflow: feature 3/7 phases complete
  pending: test, userguide, proof, commit
  awaiting review response: no
  interrupted runs: 0
  last updated: 2025-10-20T22:55:00.000Z
  latest runs: plan=completed, implement=running

Member bd-15 — awaiting-human
  worktree: /tmp/fleet-demo.feat-bd-15 (branch feat/bd-15)
  workflow: feature 4/7 phases complete
  pending: userguide, proof, commit
  awaiting review response: yes
  interrupted runs: 0
  last updated: 2025-10-20T22:55:00.000Z
  latest runs: test=completed

Warnings (1):
  - bead metadata unavailable (bd read failed): Command failed: bd show bd-12 bd-15 --json Error: no beads database found …
```

The same script also writes a second intent, `night`, which is paused and parked
with a recorded stash ref; that view gains the `parked:` line — the read-only
pointer to your stashed root work:

```text
Fleet night
  intent: bd-12, bd-15, max 3 concurrent, paused
  parked: root restore conflicted: refs/stash@{0} (stash refs/stash@{0}) — belayd_fleet_reconcile then belayd_fleet_resume
  members: 2
  states: active=1 blocked=0 awaiting-human=1 interrupted=0 idle=0 missing-state=0
```

The `bd read failed` warning in the first scratch view is the degrade path
working: `/tmp/fleet-demo` has no beads database, so bead titles/statuses are
missing and everything else is still derived.

### 3. Prove the P0 read-only contract

Nothing may change — not tracked files, not refs, not the worktree list, not the
stash list, and the fleet directory must not appear. Assert **identical**, not
empty: on an active branch `git status` is non-empty by definition.

```bash
S=$(mktemp -d)
git status --porcelain -uall                                   > "$S/status.before"
git worktree list --porcelain                                  > "$S/wt.before"
git for-each-ref --format='%(refname) %(objectname)'           > "$S/refs.before"
git stash list                                                 > "$S/stash.before"
ls -d .belayd/fleet 2>/dev/null                                > "$S/wt-fleet.before" || true
ls -d "$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet" 2>/dev/null > "$S/common.before" || true

nix develop -c bash -lc "$J $T '{}'" > /dev/null 2>&1

git status --porcelain -uall                                   > "$S/status.after"
git worktree list --porcelain                                  > "$S/wt.after"
git for-each-ref --format='%(refname) %(objectname)'           > "$S/refs.after"
git stash list                                                 > "$S/stash.after"
ls -d .belayd/fleet 2>/dev/null                                > "$S/wt-fleet.after" || true
ls -d "$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet" 2>/dev/null > "$S/common.after" || true

diff "$S/status.before"  "$S/status.after"  && echo "status: identical"
diff "$S/wt.before"      "$S/wt.after"      && echo "worktrees: identical"
diff "$S/refs.before"    "$S/refs.after"    && echo "refs: identical"
diff "$S/stash.before"   "$S/stash.after"   && echo "stash: identical"
diff "$S/wt-fleet.before" "$S/wt-fleet.after"   && echo "worktree .belayd/fleet: still absent"
diff "$S/common.before"  "$S/common.after"  && echo "common-dir belayd/fleet: still absent"
```

Produced in this worktree:

```text
status: identical
worktrees: identical
refs: identical
stash: identical
worktree .belayd/fleet: still absent
common-dir belayd/fleet: still absent
```

The last two lines are the point: observing the fleet creates no fleet directory
at all. (On `feat/bd-126` `git stash list` was empty; the check is
"unchanged", not "empty".)

### 4. Confirm determinism

```bash
nix develop -c bash -lc "$J $T '{}'" > /tmp/fleet-1.txt 2>/dev/null
nix develop -c bash -lc "$J $T '{}'" > /tmp/fleet-2.txt 2>/dev/null
diff /tmp/fleet-1.txt /tmp/fleet-2.txt && echo "identical"
```

```text
identical
```

Two calls are byte-identical because members sort by task id with **code-unit**
comparison (members with no task id last, by path), the newest run per phase uses
a total `(startedAt, runId)` order, and the output contains no ANSI and no
"now" timestamp.

### 5. The tests that pin the safety properties

| Property | File | Case to look for |
|----------|------|------------------|
| SIGTERM targeting: exact `belayd-<taskId>` token, `/proc` start-time re-verification, skip rather than guess | `src/__tests__/fleet-sessions.test.ts` | `rejects a changed start time even when the token still matches`, `skips a pid whose start time could not be read` |
| Forceful pause delivers `SIGTERM` to the member pid only | `src/__tests__/extension-fleet-p1.test.ts`, `src/__tests__/fleet-pause.test.ts` | the `force` pause cases (including "never signals a process when no pid can be tied to the member" and "signals a verified member pid once … never a real process") |
| A merge never mutates the real repository | `src/__tests__/fleet-merge.test.ts` | `does not mutate this repository: a full merge run changes only the fixture` (HEAD, branch, status, every ref, `refs/stash`) |
| Ceiling 3, counted across every fleet, re-counted inside the CAS | `src/__tests__/fleet-launch.test.ts`, `src/__tests__/fleet-schedule.test.ts` | capacity deferral, clamped / floored concurrency, active-orchestrator accounting across abandoned fleets |
| Reconcile is idempotent and never re-applies a dropped stash | `src/__tests__/fleet-reconcile.test.ts` | `leaves a consistent queue byte-identical and is idempotent`, the failed-CAS two-run sequence |
| P0 writes nothing and its view is stable | `test/fleet-status.integration.test.ts` | identical view on repeated reads, unchanged file tree size+mtime, refs, worktree list, `git status -uall`, and `fleetStateDir` still absent |
| Merging is not closing | `src/__tests__/fleet-merge.test.ts` | "no `bd` command was run by any seam" |

### 6. What not to do in this repository

Do not exercise P2/P4 against `/home/hugo/git/belayd-agent-harness`: no real
merge, no pause of a live fleet, no reconcile. Both destructive paths have
throwaway-repo recipes: `docs/fleet-merge.md` (enqueue + drain + the parked path)
and `docs/fleet-reconcile.md` (pause refusal, parked restore, idempotence). Read-only
`belayd_fleet_status` is always safe.

## Related documentation

- `docs/fleet-status.md` — P0 operator guide and warning triage.
- `docs/fleet-launch.md` — P1/P3 `/fleet`, capacity, waves, mailbox, fleet refusal.
- `docs/fleet-merge.md` — P2 merge queue, root stash/park, gates.
- `docs/fleet-reconcile.md` — P4 pause/resume/advance/reconcile and the repair table.
- `docs/fleet-orchestrator.md` — design record, locked decisions, milestone record.
- `docs/owned-worktree.md` — the bd-119 ownership preflight every member obeys.
- `docs/subagent-sessions.md` — `belayd-<taskId>` orchestrator session naming.
- `docs/planning-implement-workflows.md` — the per-bead workflow the supervisor schedules without running.
