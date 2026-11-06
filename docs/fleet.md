# Fleet supervisor — operator entry point (bd-126)

`/fleet bd-12 bd-15 bd-19` takes several beads at once, runs each as a normal
Belayd workflow in its own worktree and its own detached orchestrator session,
orders them by bd's blocking dependencies inside a ceiling of **3 concurrent
orchestrators**, carries notes between you and the members, and then **runs to
completion**: it lands each finished branch on the base branch, releases the bd
ordering gates that landing satisfied, removes the worktree, and starts the next
wave until every member is done. Landing does **not** close the bead: each one is
left `in_progress` + `human` for you to accept with `wt merge` / `bd close`.

All six milestones are implemented: **P0** status, **P1** launch + mailbox,
**P2** merge queue, **P3** ordering/capacity, **P4** pause/advance/reconcile,
**P5** the run loop and the one-orchestrator-per-worktree lease.

`--manual` restores the older explicit surface (launch, land, and advance only when
you call a tool); `--accept` additionally closes each landed bead (a landing
removes the merged worktree either way). A bare `/fleet` never closes a bead
(bd-158).

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
`<git-common-dir>/belayd/state.sqlite`:

```text
<git-common-dir>/belayd/state.sqlite   one row per fleet (bd-281):
  fleet_intent        operator intent: taskIds, maxConcurrent, paused, deferred, park,
                      orderingGates, supervisor record + the run record
  fleet_queue         single-flight merge queue (entries; revision CAS)
  fleet_lock          the merge lock claim (holder, task id, expiry)
  fleet_audit         append-only: every cross-tree action (bounded tail: rows, not bytes)
  fleet_launch_marker one row per member whose spawn is in flight (bd-233 spawn window)
  fleet_supervisor    run-mode supervisor heartbeat (re-arm eligibility)
  fleet_note          mailboxes: channel (event | inbox), target, author, kind, body,
                      created/delivered/acked — one row per recipient
```

No fleet fact is a file any more. `<git-common-dir>/belayd/fleet/<fleetId>/` is
only a legacy location: `belayd_fleet_status` still recognises a fleet from a
directory an earlier version left, and the one-shot importer reads it.

**The import-once contract (bd-281).** The first fleet resolution of a
repository's common dir imports those legacy files into the store's rows —
`fleet.json` into `fleet_intent` (intent column plus the `run` column),
`merge-queue.json` into `fleet_queue`, a live `merge.lock.d` holder record into
`fleet_lock`, the `audit.log` tail into `fleet_audit`, `launch/<taskId>` into
`fleet_launch_marker`, `supervisor.json` into `fleet_supervisor`, and
`inbox/*.json` / `events/*.json` into `fleet_note`. The marker is
`bd-281-legacy-fleet-state:<git-common-dir>` — one per repository, because those
files were already shared by every worktree. **Every insert is absent-first, and
its existence check shares the insert's transaction:** each row goes through a
plan helper (`mutateFleet` for the intent, `mutateFleetQueue`, `mutateSupervisor`,
`mutateLaunchMarker`, `importNote`) whose plan is called with the row the write's
`BEGIN IMMEDIATE` just read, so a row a live drain or supervisor wrote after the
legacy file was read is never overwritten by the copy. The merge lock is claimed
by `acquireFleetLock`, which reads and inserts in one transaction, and the audit
tail is inserted through `RepoStateStore.importAudit`, which tests
`(fleet_id, at, payload)` and inserts inside one `BEGIN IMMEDIATE`. That last one
is why a second worktree importing the same common dir — even one racing before
the first records its marker — adds no second row: the first writer's row is
visible to the second's transaction, so it inserts nothing. The workflow half is
absent-first too (a task that already has a `workflow_state` row keeps it; the
stale file's generation is named in the skip, and the check runs in the write's
transaction so a ledger the orchestrator advanced mid-import wins), because two
copies of one task's phase ledger cannot be merged safely. An expired or
holder-less `merge.lock.d` imports as **no lock** (a migration must never hand a live fleet a lock it would
respect), an unparseable file is reported per file and skipped, a
`*.json.corrupt` file is reported and left in place (it is evidence of a damaged
record, not state), and every retired file still present afterwards is refused
with an error naming `bd-281`.

Nothing in the store is written by `belayd_fleet_status` — the one exception is
the migration marker of the first fleet resolution in a repository, which is the
import described above. Everything else is written by launch, note, merge,
pause/resume, and reconcile, and only from a session that is the fleet's live
supervisor.

The audit tail is bounded by **rows** (`REPO_STATE_AUDIT_TAIL_ROWS`, 200), not by
bytes. The file reader used a 64 KiB byte window because a file has no rows; the
row bound is what a caller actually asks ("the last N entries") and does not
change with message length.

**Where workflow state lives (bd-281).** A member's *workflow* record is no longer
`.belayd/workflow.json` inside its worktree, and neither are its orchestrator
lease, its run manifests or its review-findings record: they are rows in the one
per-repository store at `<git-common-dir>/belayd/state.sqlite`, keyed by **task
id** (runs by run id). Every worktree of the repository resolves the same row, so a resumed session
in another worktree reads the fact instead of a copy, and a stale record is
visible from the row's `updated_at`/generation rather than inferred from a file.
`belayd_fleet_status` reads members from that store; capacity evidence
(`memberRanEvidence`) asks the store whether a member has a workflow record.

Operationally that means:

- **Back up `state.sqlite` with `.belayd/artifacts/`**, not by copying a
  worktree; the file is never tracked and never inside a worktree.
- The legacy files (`.belayd/workflow.json`, `orchestrator.json`,
  `review-findings.json`, `proof-receipt.json`, `handoff-*.json`,
  `review-scope.json`, `runs/*.json`) are
  imported once by `bd-281-legacy-workflow-state:<worktree>` and refused
  afterwards with an error naming `bd-281`. Delete one if it appears; do not
  restore it. The fleet half of the same migration uses
  `bd-281-legacy-fleet-state:<git-common-dir>` (see above).
- **What remains a file, and why:** `.belayd/artifacts/` (phase deliverables
  injected into prompts), the `.belayd/proof-dir` marker (read by
  pi-web-plugins through the browser file API — see the SYNC WARNING in
  `src/proof-dir.ts`), `.belayd/review-findings.md` (the rendered artifact a
  posted comment names), and the repo-authored inputs `.belayd/config.json`,
  `.belayd/handoff.json`, `.belayd/telemetry.json` and `.belayd/github-map.json`.
  These are path facts and deliverables, not execution state, and the publish gate
  reads them as paths.
- **The proof receipt is a row too** (`proof_receipt`, schema v5). The pi-web
  panel reads it through the plugin's own server module rather than the browser
  file API (bd-303), so no worktree copy is needed: a receipt file present in an
  old worktree is imported once by the worktree-half import and refused
  afterwards like every other retired file.
- The fleet intent/run (`fleet_intent`), merge queue (`fleet_queue`), merge lock
  (`fleet_lock`), audit (`fleet_audit`), launch markers (`fleet_launch_marker`),
  supervisor heartbeat (`fleet_supervisor`) and the note mailboxes (`fleet_note`)
  are rows in that same store. Do not restore a retired `fleet.json`,
  `merge-queue.json`, `merge.lock.d`, `audit.log`, `launch/` marker,
  `supervisor.json`, or `inbox/`/`events/` directory: the store is the authority
  for everything it holds. Two sessions in different worktrees resolve the same
  rows, so copying state between worktrees is impossible by construction.
- A directory that is not a git repository has no store, so a fleet-like run
  outside git reports "no state" rather than writing a SQLite file into the tree.

### Ordering vs. acceptance (bd-158)

Two objects, two verbs — the fleet never expresses two facts with one bd bit:

| Fact | bd object | Verb | When |
|------|-----------|------|------|
| Nothing depends on this member any more | an ordering **gate** blocking the dependent's bead | `bd gate resolve` | the blocker **lands** (merge succeeded) |
| A human accepted this work | the member's **bead** | `bd close` / `wt merge` | the human decides (or `--accept`) |

Before bd-158 `accept` defaulted to true, so a run closed a landed member's bead
just to unblock its dependents — closing dragged acceptance along with ordering.
Now:

- **A bare `/fleet` never closes a bead.** Every landed bead is left
  `in_progress` + `human`; acceptance is `--accept` (or your own `wt merge`).
- **Ordering is fleet-owned.** For every dependency edge between two *members* the
  launch creates one `bd gate create --blocks <dependent>`, recorded in
  `fleet.json` under `orderingGates` as `{ blocker, blocked, gateId }`. The set is
  *all fleet members*, not just the wave being launched: a member added by an
  advance can be blocked by one that started earlier, and that edge needs a gate
  too. Landing resolves the gates its merge satisfied. What bd reports afterwards
  depends on which relationship the dependent's bead carries:

  - **gate-only ordering** (the fleet's gate is the dependent's only blocker — the
    shape `test/fleet-ordering-gate.integration.test.ts` builds): `bd blocked`
    stops naming the dependent at that instant and `bd ready` includes it, while
    `bd show <blocker>` is still `open`/`in_progress`.
  - **a plain `blocks` edge** (what a real `/fleet` needs to plan the wave order —
    see the trade-off at the end of this section): that edge is bd's own, so it
    keeps bd's close-to-unblock rule and `bd blocked` still names the dependent
    until a human closes the blocker's bead. The fleet does not wait for that:
    `fleetLandedTaskIds()` drops a landed member's edge, so the wave advances on
    the landing.

  External blockers get no gate: bd's ordinary dependency edge already blocks the
  member bead for them.
- **Gate shape.** bd 1.3.0 supports `human`, `timer`, `gh:run`, `gh:pr`, and
  `bead`. Ordering uses `bead` with `await-id` set to the blocker, making the wait
  a native non-human/ordering wait rather than prose a needs-you surface ignores.
  bd's `bead` semantics resolve on the awaited bead *closing* (the acceptance
  fact), not on landing, and this bd build does not auto-resolve on that close, so
  the fleet still resolves the gate on landing. When the fleet is gone,
  `bd gate resolve <gate-id>` — or `bd gate check --type=bead` once the blocker is
  closed — is the manual fallback. A `timer` gate would auto-resolve on the clock
  — wrong, the gate must be tied to the blocker landing. Every ordering gate also
  carries a **structured** marker in title and reason:

  ```text
  title:  belayd-fleet-ordering: fleet:<fleetId> bd-12 -> bd-13
  reason: belayd-fleet-ordering: fleet:<fleetId> bd-12 -> bd-13: bd-12 must land …
  ```

  Ordering gates created before bd-176 are typed `human`, but the marker still
  classifies them as ordering — never as a human wait — so existing fleets stay
  correct without a migration.

  Classification requires that whole shape (prefix *and* a fleet id *and* both
  bead ids), never the bare prefix, and it is fail-closed in both directions: a
  record that merely starts with the prefix stays a human gate (the wait stays
  armed), and an ordering gate never looks like a question. The **title decides**;
  when bd truncates or re-folds the reason so its marker no longer parses, the gate
  is still ordering (a warning names the drift once per gate per run — the sweep
  rediscovers it every rotation, so the ledger lives on the run record), because
  classifying the fleet's
  own gate as a human gate would leave `belayd_ask_human`'s poll waiting for a
  comment answer no human will give. Only a reason that parses to a *different*
  edge fails closed to a human gate. So the poll never treats an ordering gate as a
  question, and the status view renders it as `waiting on: bd-12 (fleet ordering
  gate)` instead of `awaiting-human`.
- **Orphan gates are reaped, and only by gate id.** A gate exists only while both
  its beads are live members. The supervisor's tick resolves, in this order:
  gates naming a non-member (removed/pruned/failed launch), gates whose beads bd
  reports `closed`/`done`, and — one member bead per tick, rotating — gates bd
  reports that `fleet.json` does not name at all. A landing resolves the gates
  it satisfied, a `bd close` by a human (or `--accept`) resolves every gate
  touching that bead, and a removed/pruned member is resolved by the repair that
  removes it (`belayd_fleet_reconcile --prune-dead-members`, or the launch's own
  failed-member prune).

  A bead-status read only counts when it is **complete**: bd answering for some of
  the gated beads (payload drift) is ambiguous, and the tick warns instead of
  reaping them. The bookkeeping unit is the **gate id**: one blocker can order two
  dependents, and resolving one says nothing about the other, so records are
  dropped exactly for the gates bd confirmed resolved. A resolve failure keeps the
  record so the next tick retries it.

  A **full** sweep (`belayd_fleet_advance`, `belayd_fleet_reconcile`) also drops a
  recorded gate **bd no longer reports**: the id stays in `fleet.json` after the
  gate is gone from bd, and nothing would ever resolve it (bd-278). The rule is
  fail-closed: the record goes only when both of its beads were queried
  successfully in that pass and neither answer lists the gate id. An
  unreadable/partial answer keeps the record and the existing warning names it. The
  rotating tick sweep cannot prove absence from one bead, so it keeps the old
  behaviour. Dropping never calls `bd gate resolve` — there is no gate left there.
- **The crash window is closed from both ends.** A gate can exist in bd with no
  record (the process died between `bd gate create` and the intent write). A
  relaunch asks bd (`bd gate list <dependent>`) before creating anything and
  *adopts* the gate it finds (resolving a duplicate for the same edge). The tick's
  rotating sweep does the same for a gate it discovers:

  - blocker landed, or either bead no longer a member → **resolve** (nothing is
    left to wait for);
  - both beads are members and the blocker is still working → **adopt**, i.e.
    write the record, so the blocker's landing resolves it like any other gate.
    Resolving it instead would release the dependent early. An adoption that would
    take the record set past its bound is **refused**, not truncated: the gate stays
    open in bd (resolving it would release the dependent early) and a warning names
    the dependent and gate id so a human can inspect it. The warning is shown once
    per gate per run, since every sweep rediscovers it.

  A `belayd_fleet_reconcile` pass sweeps *every* member (one member bead per tick
  rotates instead, and would take a full cycle). A launch that fails after creating
  gates resolves exactly the gates **it** created, scoped to their edges, and names
  any dependent it leaves bd-blocked together with the gate id to inspect — it
  never resolves ordering that predates it.
- **A failed gate resolve never wedges a landed member.** The landing is one
  transaction (store row, run `landedAt`, member pruned, its ordering-gate
  *records* dropped, audit row, one revision bump), so bd is the only place the
  still-open gate lives — `bd gate list` and `belayd_fleet_status`'s
  `ordering gates open: bd-12 -> bd-13 (gate bd-155)` line. The next tick's
  crash-window sweep resolves it, because a gate bd reports with no record and a
  blocker that already left is exactly the orphan it reaps. Retrying re-runs only
  the bd resolve: the merge queue entry is already `merged`, so a second merge of
  the same member is impossible.
- **Fleet-side advance is unchanged.** `fleetLandedTaskIds()` in
  `extensions/capabilities/fleet.ts` drops the edges of members this fleet already
  landed, so the scheduler advances a wave at the same moment the gate is
  resolved, without a close. The two mechanisms are the two halves of one event.
- **The record set is bounded but never truncated.** `fleet.json` holds at most
  256 gate records, and the bound is checked against the **post-adoption** set: a
  gate adopted from bd is a record but not a creation, so a fleet already at the
  bound that relaunches with every edge gated in bd succeeds and creates nothing.
  Only a record this launch would genuinely add can push it over, and that launch
  is refused before anything is created. Nothing is silently dropped, because a cut
  record is an open gate nobody can resolve again. The same bound is enforced on
  the sweep's adoptions (above) and, as a backstop, on the write itself: the
  `fleet.json` writer validates the record against the reader's schema and refuses
  an over-bound one, since a written record its own reader rejects would make the
  intent permanently unreadable for status, launch, tick, and reconcile.

The trade-off, explicitly: the object that **releases** a dependent is the gate, so
the release does not appear in `bd dep list` / `bd graph` — it lives in the gate
title/reason and in `fleet.json`. The `blocks` edge the scheduler read is still
there and is still bd's own: bd keeps its close-to-unblock rule for that edge, which
is why `bd blocked` keeps naming the dependent after the landing until a human
closes the blocker's bead. The fleet does not wait for that (`fleetLandedTaskIds`),
so merged work never stalls on a close — but bd's own views only agree once the
bead is closed. Gate-only ordering (no plain edge) is the one shape where `bd
blocked` releases at the landing; see the two cases above.

### The run, step by step

#### 1. Launch

```text
/fleet bd-12 bd-15 bd-19            # run to completion (the default)
/fleet bd-12 bd-15 --manual         # explicit surface: nothing lands or advances on its own
/fleet bd-12 bd-15 --accept         # also close each landed bead; the merged worktree
                                    # is removed on landing either way
```

A bare `/fleet` leaves every landed bead `in_progress` + `human`; you accept with
`wt merge` / `bd close`. Dependents still advance: the fleet owns its wave
ordering through bd gates (see [Ordering vs. acceptance](#ordering-vs-acceptance-bd-158)),
not through the blocker's bead status. `--no-accept` is still parsed (it restates
the default).

or the tool form:

```json
{
  "tasks": ["bd-12", "bd-15", "bd-19"],
  "fleetId": "default",
  "concurrency": 3,
  "untilComplete": true,
  "accept": false
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
| `awaiting-human` | waiting for the operator: an open bd `human` gate on the bead, or an undelivered report (since bd-219 a review that reports findings is **not** a wait — see `docs/bd-219-userguide.md`) |
| `blocked` | the newest run of a not-yet-completed phase failed |
| `interrupted` | a run manifest is `interrupted` (crash/kill mid-phase) |
| `idle` | every phase completed |
| `complete-unlanded` | no readable `.belayd/workflow.json` because the workflow **finished** (completion deletes the state file and leaves the run manifests), and the final-phase run completed (bd-168). The block keeps its task id from the branch or its own runs and names the two landing commands |
| `missing-state` | no readable `.belayd/workflow.json` and nothing proves the workflow finished |

A finished workflow therefore shows `complete-unlanded` with
`latest runs: commit=completed, …` and an id. Do not treat that as breakage, and
do not remove the worktree by hand: land it (`belayd_fleet_merge
action=enqueue task=<id>` then `action=drain`). A worktree with neither state,
manifests, nor an id in the branch is the case the `no .belayd/workflow.json …`
warning is for.

For "what is going on with **that** member, and is it stuck", the cheap
follow-up is `belayd_workflow_digest <taskId>` — no model call, no transcript:
see [the bd-189 tier guide](bd-189-userguide.md).

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

Members report up; you reply down. Both directions are note rows
(`fleet_note`), drained at the reader's next turn start.

```text
belayd_fleet_note { "to": "supervisor", "body": "bd-12 is ready for review" }   // a member
belayd_fleet_note { "to": "bd-15", "body": "main moved; rebase before review", "kind": "rebase-hint" }
belayd_fleet_note { "to": "all", "body": "pause after your current phase", "kind": "pause" }
```

- `belayd_fleet_inbox` (supervisor only) drains and acknowledges the inbox
  channel. Notes are rendered **before** they are acked and are framed as *member
  reports, not supervisor instructions*.
- A broadcast (`to: "all"`) is written as **one row per member**, so each member
  gets its own copy exactly once.
- Delivery is **at-least-once**: a member acks at the end of the turn in which it
  read the note, so a crash replays it. Treat a repeat as the same event.
- Addresses are validated against fleet membership (launched **and** deferred). A
  typo is refused instead of becoming mail nobody reads. Members cannot write the
  event channel, so no member can inject a fake instruction into a sibling's turn.

#### 4. Merge finished work

In run mode this happens by itself, one member at a time. The explicit queue is
still there for a `--manual` fleet:

```text
belayd_fleet_merge { "action": "enqueue", "task": "bd-12" }
belayd_fleet_merge { "action": "drain" }          // oldest queued entry
belayd_fleet_merge { "action": "list" }
```

Drain runs preconditions → claim the `fleet_lock` row → stash a dirty root (recorded
sha) → rebase the member onto the base → the target's own gates
(`test`, `test:integration`, `typecheck`, `lint`, `build`, whichever exist) →
`git merge --ff-only` → restore the stashed root → notify remaining members
(`base-moved`, `sibling-landed`, `rebase-hint`) → release.

A rebase that fails is classified before anything else happens: a stale state is
cleared and retried once, generated paths are regenerated, a conflict a live
member can resolve is delegated to it with a `rebase-hint` (no stop), and only a
contradiction with work that landed during the fleet stops the member. See
[`docs/fleet-merge.md`](fleet-merge.md#rebase-failure-classification-bd-280).

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
  You accept it with `wt merge` / `bd close` — or let a run land it (step 8): the
  landing removes the merged worktree either way, and `--accept` closes the bead
  too.

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
this fleet already landed that blocker. Landing is proven by **git ancestry**
(`docs/fleet-run.md`, bd-278), so a hand `wt merge` advances the wave while the
bead is still `in_progress` + `human`; bead closure is acceptance, not ordering.

The advance also reaps its recorded ordering-gate records first, exactly like a
tick and a reconcile pass, so a stale record for a gate bd no longer reports
cannot keep the wave refused. Its deferral text names such a blocker as
`ordering gate <id>` and points at `belayd_fleet_reconcile`; only a blocker that
really is outside the fleet reads as "a bead … not part of this fleet".

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
belayd_fleet_reconcile { "fleetId": "<id>" }          // a fleet whose supervisor is dead
belayd_fleet_reconcile { "retryMembers": ["bd-42"] }  // clear a recorded stop
```

Run it in the repository root. From the fleet's live supervisor it needs no
`fleetId`; from any other session, a fleet whose supervisor is **provably dead**
may be reconciled by naming it (bd-233). Which signal proves it depends on the
record: an **explicit/legacy** record names the supervisor process, so a gone or
reused pid retires it at once; a **run-mode** record's pid is the shared pi-web
daemon, so its beat must go missing or cold (up to the 10-minute staleness window).
Reconcile repairs the queue
(expired lease, record without its primitive, orphaned directory past the grace
window, entry frozen mid-flight), retries a parked root restore from the recorded
sha, and reports supervisor + member liveness from the worktree lease plus the
process table. It is idempotent: a second run reports `nothing to repair`.

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
  worktree lease AND no matching process AND no worktree that still exists** (a
  completed process-table scan found no `belayd-<taskId>` argv): a pi-web
  orchestrator never appears in the process table, so the lease is what keeps a
  running member from being pruned — the bd-37 incident pruned a live member 25 s
  after its launch, which freed a slot and started a second orchestrator on one
  worktree. A member whose worktree was **deleted** resolves to `absent` because
  its `feat/<taskId>` branch proves the tree existed (bd-233); a member the run
  recorded landing (`run.members[].landedAt`) is also `absent` even after a clean
  landing removed both the tree and the branch (bd-168), so it is prunable instead
  of holding a slot forever. One whose tree has not been created yet stays
  `unknown`, because a launch may be mid-spawn. Liveness that cannot be read
  (unreadable `/proc`, an unreadable lease) is never pruned.
  The parameter is `pruneDeadMembers` (camelCase) — the refusal hint in the report
  says "re-run with prune-dead-members", which is prose, not the parameter name.
  A prune also drops the pruned members' `run.stopped` entries, so the run stops
  reporting a member it removed as needing a human.
- **Retrying a stopped member is a tool call.** `retryMembers: ["<id>"]` clears the
  recorded stop (audited `member-retry`); the run's next tick reconsiders the
  member and lands any work that finished. A member whose worktree is gone is
  stopped again, so prune it and launch it fresh instead.
- **Capacity counts liveness, and a prune removes the record.** Since bd-166 the
  launch counts a member only while its orchestrator is `live` or `unknown`; an
  `absent` member stops consuming a slot without being removed, and a `released`
  (including `merged`) or recorded-landing member never consumes one. A prune is
  still how you erase the record itself. Both are narrowings of the `taskIds`
  count, not of the member's work: the worktree, transcript, and bead stay either
  way. A member of a foreign fleet can be released with
  `belayd_fleet_release {taskId, fleetId}` when that fleet's supervisor is
  provably dead (audited `member-released-recovery`); a live foreign supervisor
  keeps the refusal.
- **A pruned member cannot be relaunched through the fleet while its lease is
  live.** The lease names the session that owns the worktree, so a second launch is
  refused (`live orchestrator lease`) instead of creating a duplicate orchestrator.
  Once the lease is cold, relaunch normally, or resume the old session.
- **The intent CAS is check-then-write.** `fleet.json` updates compare the bytes
  they read and then rename, so two simultaneous supervisors can both win that
  window (the merge lock is a single conditional row claim). There is at most
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
1  land     bd-12: merged into main, ordering gates released, worktree removed
2  advance  bd-19 launched (bd-12 landed, so its edge is satisfied)
…
   run: until-complete — complete (11 tick(s))
```

- **Landing is the merge step**: a successful drain removes the merged worktree
  with `git worktree remove` (no `--force`) and the merged branch with
  `git branch -d` (no `-D`), plus the bd ordering gates the merge satisfied
  (bd-168). A refusal (dirty tree, unmerged branch) is a warning and the report
  names the exact cleanup command; the merge itself never fails over cleanup. The
  landing is recorded as `released[] {reason:"merged"}` and audited
  `member-merged-released`, so the slot is free even if the queue entry stays. The
  bead is left `in_progress` + `human` — merging is not closing. `--accept`
  additionally closes the bead (`bd close`).
- **A member that needs a human is stopped, never relaunched.** `awaiting-human`,
  failed phase, interrupted run, unreadable state, or a vanished orchestrator all
  end that member's part of the run with a reason in `belayd_fleet_status`.
- **Pause stops the timer without finishing the run**; `belayd_fleet_resume` starts
  it again. A parked or stalled run is halted and recorded (`haltedReason`), and a
  halt is terminal for that run record: `resume` only restarts a *paused* run, so a
  halted one continues only through a re-arm (after `belayd_fleet_reconcile` for a
  parked fleet). A run stalls only when **no member's progress changed** for
  `FLEET_RUN_MAX_IDLE_TICKS` ticks **and** at least one in-flight member has no
  live orchestrator lease — a member moving through phases keeps the run alive
  wave after wave, and a member still renewing its lease inside one long phase is
  not called stuck (bd-168). The comparison uses each member's stable progress
  identity (phase, phase count), never free-text output such as a failure reason,
  and the recorded counter stops at the cap. A run whose members all keep their
  leases fresh is bounded by the separate, much larger
  `FLEET_RUN_MAX_LIVE_IDLE_TICKS` (8× the ordinary cap); every stalled line states
  each member's lease evidence (`lease fresh Ns` or `no live lease`). `run-not-ticking`
  remains the separate supervisor-side signal in `belayd_fleet_status`.
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
| Ask one member something / tell it main moved | `belayd_fleet_note` (`kind: rebase-hint`) | one `fleet_note` row (event channel) |
| Tell every member | `belayd_fleet_note` `to: "all"` | one `fleet_note` row per member |
| Did a member report? | `belayd_fleet_inbox` | drains + acks the inbox channel, `inbox-drain` audit |
| Land a finished member (manual fleet) | `belayd_fleet_merge` `enqueue` then `drain` | the `fleet_queue` row, the base branch, `base-moved` notes |
| Land + release ordering gates, automatically | the run loop (default) | the base branch, bd gates, worktree removal, `fleet-landed` audit; the bead stays `in_progress` + `human` |
| Record a landing that happened outside the fleet (hand `wt merge`) | the run tick, `belayd_fleet_reconcile` for a fleet nothing ticks | git ancestry alone (`run.members[].head` when the branch is gone), then one transaction: `landedAt`, pruning, gate-record drops, `fleet-landed` audit, one revision bump (the bd resolve follows the commit); no bead status is read |
| What is queued / is a merge in flight? | `belayd_fleet_merge` `list` | nothing |
| Start the deferred members | `belayd_fleet_advance` | new members, updated `deferred` |
| Stop starting new work | `belayd_fleet_pause` | `paused`, `pause` notes, `fleet-paused` audit |
| Stop a member that ignores mail | `belayd_fleet_pause` `force` | SIGTERM + per-pid audit (delivery only) |
| Come back | `belayd_fleet_resume` | clears `paused`/`park`, `resume` notes |
| Repair after a crash | `belayd_fleet_reconcile` | queue/park repair, liveness report |
| Give one member's slot back (keep the bead and worktree) | `belayd_fleet_release` | a `released` entry on the intent, `member-released` audit. A member of a foreign fleet needs `fleetId` and that fleet's supervisor provably dead (`member-released-recovery`) |
| Narrow the capacity count | `belayd_fleet_reconcile` `pruneDeadMembers` | removes members with no live lease, no process, and no surviving worktree — or a recorded landing — from `taskIds` (never `unknown`) |
| Bring a stopped member back | `belayd_fleet_reconcile` `retryMembers: ["<id>"]` | clears the member's `run.stopped` entry (`member-retry` audit); the next tick reconsiders it. A member whose worktree is gone needs prune + a fresh launch |
| Repair a fleet whose supervisor died | `belayd_fleet_reconcile` `fleetId: "<id>"` | queue/park repair, liveness report, prune and retry in that fleet. Accepted when this session supervises some fleet in this repo (audited `reconcile-cross-fleet`) or when that fleet's supervisor is **provably dead** (audited `reconcile-recovery`; a prune is allowed there, bd-233). Never takes the supervisor role |
| Accept one member's work (close its bead) | a run with `accept: true` (or `/fleet … --accept`) | bead status, audited; the merged worktree is removed on landing either way |
| Accept the work without the loop | `wt merge`, `bd close` | bead status — `belayd_fleet_merge` itself never touches a bead |

`belayd_fleet_status` and `belayd_fleet_note` work in any session that is inside a
fleet (the supervisor writes the event channel, a member writes the inbox).
`belayd_fleet_inbox`,
`belayd_fleet_merge`, `belayd_fleet_pause`, `belayd_fleet_resume`,
`belayd_fleet_advance`, `belayd_fleet_reconcile`, and `belayd_fleet_release` are
**supervisor-only**: they refuse unless `fleet.json` names this session as the live
supervisor, and a record left by a dead process does not count — re-arm with
`/fleet` first. The one exception is `belayd_fleet_reconcile`, which also accepts a
named fleet whose supervisor is **provably dead** from any session in the repository
(a gone/reused pid on an explicit or legacy record, or a missing/cold beat on a
run-mode one), audited `reconcile-recovery`; that arm may prune (bd-233) and never
writes the supervisor record. A reconcile that names
another fleet additionally requires this session to supervise *some* fleet in the
repository (same session/process/token anchors as own-fleet mode; a legacy record
with no anchors falls back to the session id), audits the cross-fleet target, and
normally repairs only the queue/park — `pruneDeadMembers` on a **live** fleet that
is not this session's own is refused (re-arm that fleet and run reconcile or
`belayd_fleet_release` from its own session).

### Failure recovery

| Symptom | What happened | What to do |
|---------|---------------|------------|
| `Fleet \`default\` is paused (<park reason>); resume it with belayd_fleet_resume before launching more members (run belayd_fleet_reconcile first if the root work is parked)` | P2 stashed your dirty root, landed the merge, and could not restore the stash cleanly. Your work is in the stash | `belayd_fleet_reconcile` restores the recorded sha, verifies it, drops it, and unparks — or reports exactly what blocks it (root is a linked worktree, root moved off the base branch, sha gone, apply conflict). Then `belayd_fleet_resume` if the pause is still set. `resume force` clears the pause and leaves the stash, naming the ref. Never delete the stash by hand first. A run-mode ticker that halted as `parked` does not restart on resume: re-arm with `/fleet <ids> --fleet <id>` |
| `merge lock is held by … until …` | Another drain (or a dead supervisor's lease) owns the queue | Wait, or let the lease expire — the expiry is the only takeover authority, the recorded pid is diagnostic. `belayd_fleet_reconcile` takes over an expired lease for you |
| Supervisor is gone; every fleet tool says `supervisor-only` | The supervisor session died. Its lease and run record survive on disk, and a run-mode fleet's recorded pid is the shared daemon, so only the supervisor heartbeat can say it is gone | Repair it without taking over: `belayd_fleet_reconcile { "fleetId": "<id>", "pruneDeadMembers": true }` from any session once the fleet is provably dead — a cold/missing beat on a run-mode record (up to 10 minutes), or a gone pid on an explicit record (bd-233). It audits `reconcile-recovery` when it repaired something, and the members whose worktrees are gone free their slots. Then `/fleet <its ids> --fleet <id>` in a new session: re-arm rewrites the supervisor record, preserves the surviving members, and (because the intent has a `run`) starts the loop again — a new run record when the old one finished or halted. Then `belayd_fleet_status` |
| A member is `stopped` in the run line | The loop gave up on it for a reason that needs you (`phase-failed`, `awaiting-human`, `orchestrator-missing`, `land-failed`, `accept-failed`) | Fix the cause, then `belayd_fleet_reconcile { "retryMembers": ["<id>"] }`: it clears the recorded stop so the next tick reconsiders the member and lands any work that finished. Before that: a `land-failed` stop on a refusal the member could fix itself (`proof-artifacts-in-diff`, `paths-outside-scope`, `gate-failed`) already ran its one repair round, so `belayd_fleet_status` shows `repair 1 of 1 — <refusal>` while it runs, and `retryMembers` applies after that round (bd-277). Retry only works while the run is active — on a finished or halted run the stop is left intact and the tool warns you to re-arm first. A member whose worktree is gone is stopped again: run `pruneDeadMembers` and launch it fresh. The member stays addressable (`taskIds`) until it is pruned or lands |
| `ordering gates open: …` in the status header | This fleet still holds ordering-gate records: **normal** while the blocker has not landed, since an open gate is exactly what is holding the dependent back. When the blocker *has* landed the fleet-side records are gone (the landing drops them in its transaction), so this line then names a **bd** gate whose resolve hit a transient failure after the commit — or a bd gate the crash-window sweep has not reached yet | Nothing while the blocker is still working: the gate is doing its job. After the blocker landed, nothing either — the next tick's sweep resolves the gate bd still reports. A finished run is not ticked, but `belayd_fleet_advance` and `belayd_fleet_reconcile` run the same sweep before they act, and their full sweep also drops a recorded gate **bd no longer reports** (only when both of its beads answered; an unreadable answer keeps the record). If it stays, `bd gate resolve <gate-id>` and the record goes on the following tick (the manual fallback) |
| Deferred/refused with `blocked by ordering gate bd-…, which bd no longer reports` | A recorded `orderingGates` entry still names a gate bd has forgotten. The id is a **gate**, not a bead: nothing outside the fleet blocks the wave; a stale fleet-side record does | `belayd_fleet_reconcile` drops the records bd no longer has (then `belayd_fleet_advance` launches the wave). If bd still lists the gate, `bd gate resolve <gate-id>` releases it by hand |
| `Refusing to launch … live orchestrator lease` | The worktree already has a live orchestrator session (its lease is fresh) | One orchestrator per worktree: finish or stop that session. If it is really gone, the lease goes cold after ~3 min and the next launch takes it over (the old record is archived, and the takeover is reported) |
| Launch refused with `dependency-cycle` and a closed path (`bd-12 → bd-15 → bd-12`) | bd's `blocks` edges form a cycle; no valid order exists | `bd dep remove`, then relaunch. Nothing was created, so there is nothing to clean up |
| `Scheduling: 0 member(s) now, N deferred (capacity 3, 3 already active, 0 free slot(s))` | The ceiling is full — normally because members of another fleet (or a dead supervisor's fleet) are still recorded | Not an error (exit 0). The status view's `capacity:` block names each fleet's live/absent/stopped/released members and who holds the slots. Since bd-166 an `absent` member (or one in `released`) does not hold a slot, so this line now means the slots really are busy. Let a member finish, `belayd_fleet_release <taskId>` a slot you know is not in use, or `belayd_fleet_reconcile` `pruneDeadMembers` (positive `absent` evidence only — never `unknown`), then `belayd_fleet_advance`. Do not edit `fleet.json` by hand to drop ids. A member whose retry session is still alive keeps its slot until the session ends or the run releases/lands/prunes it |
| `<n> fleet intent(s) under this repository's fleet root cannot be read (<ids>). Counting only the readable fleets could exceed the ceiling of 3 …` | `fleet.json` does not parse (hand edit, truncation, newer schema). Writers refuse to replace a present-but-unparsable record, and an unreadable intent refuses a launch rather than assuming zero active members | Inspect `fleet.json`; restore a valid record (or move it aside if the fleet is really finished). Reconcile and launch both refuse until it parses — this is deliberate, because guessing the member count can overshoot the ceiling |
| `bead metadata unavailable (bd read failed): …` in the status view | `bd show` failed, timed out, is not installed, or the checkout has no beads database | Nothing about the workflow view is wrong; states, phases, and runs still derive. Ignore unless you need titles/statuses |
| `bead engagement unavailable (bd read failed): …` in the status view | **Every** member's `bd comments` **and** `bd gate list` reads failed (bd missing, wrong database, total outage) | Same: the derived view is intact, only owner/assignee/human/comment columns are missing. Reported once per fleet, not once per member. A mixed result (some beads readable) is not a warning: those beads render `unknown` columns |
| `Needs you (n): …` names a bead but the bead looks idle | The bead carries bd's `human` label or has an open `human` gate | Answer on the bead in bd/Scotty (the member's session polls the comment thread and resolves the gate); resolving the gate with `--reason` (or Scotty's approval note) also resumes it, with the reason delivered as the note. `belayd_fleet_status` only reports the wait; it never resolves it |

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
  states: active=0 blocked=0 awaiting-human=0 interrupted=0 idle=0 complete-unlanded=2 missing-state=0

Member bd-125 — complete-unlanded
  worktree: /home/hugo/git/belayd-agent-harness.feat-bd-125 (branch feat/bd-125)
  task id: bd-125 (inferred from branch or worktree path)
  workflow: missing
  interrupted runs: 0
  last updated: 2026-10-21T22:55:47.738Z
  latest runs: commit=completed, implement=completed, proof=completed, review=completed, test=completed, userguide=completed
  land it: belayd_fleet_merge action=enqueue task=bd-125 then action=drain

Member bd-126 — complete-unlanded
  worktree: /home/hugo/git/belayd-agent-harness.feat-bd-126 (branch feat/bd-126)
  task id: bd-126 (inferred from branch or worktree path)
  workflow: missing
  interrupted runs: 0
  last updated: 2026-10-22T20:12:42.382Z
  latest runs: commit=completed, implement=completed, proof=completed, review=completed, test=completed, userguide=completed
  land it: belayd_fleet_merge action=enqueue task=bd-126 then action=drain

Warnings (2):
  - no .belayd/workflow.json in /home/hugo/git/belayd-agent-harness.feat-bd-125 (completion clears it); bd-125 still belongs to this fleet and its work is finished — land it with belayd_fleet_merge action=enqueue task=bd-125 then action=drain
  - no .belayd/workflow.json in /home/hugo/git/belayd-agent-harness.feat-bd-126 (completion clears it); bd-126 still belongs to this fleet and its work is finished — land it with belayd_fleet_merge action=enqueue task=bd-126 then action=drain
```

Read it as: both linked worktrees finished their workflow (state cleared, manifests
kept), so no member has a task id, so **no** `bd show`, `bd comments`, or
`bd gate list` call happened at all and there are no `bead:`/ownership lines.
The main checkout is absent because it holds no
workflow state. `latest runs` is alphabetical here only because `phaseOrder` is
unknown without `workflow.json`.

That block was captured before the run-ownership filter landed (bd-146/bd-161).
`latest runs` keeps only manifests whose `taskId` is the member's own, keyed the
way the run loop keys the member: the branch's task id when it names a fleet
member, otherwise `workflow.json`'s task id, otherwise the id the branch or
directory name implies — so a completed workflow whose state file is gone still
reports its own final phase. A worktree that inherited another bead's manifests
therefore shows only its own phases. Filtering needs a resolvable task id: a
worktree whose branch and directory name yield none, and that has no
`workflow.json`, still lists the manifests as read.

Worktree creation also drops the inherited manifests (bd-242): `wt step
copy-ignored` copies `.belayd/` into a new tree, so `setupWorktree` deletes the
run manifests whose `taskId` is neither the new branch's bead (any sub-bead
depth) nor one of its sub-beads, and warns with the removed run ids. That keeps
the directory honest for a reader that only counts files, while the
list/latest-run readers keep filtering by task id for trees created before this
and for the fleet's own members.

Every reader takes the filename as the authority: a manifest whose body `runId`
does not match the file it lives in, or whose id could name a path outside
`.belayd/runs`, is skipped like a corrupt one. `readRunManifest` enforces that
match, so the read-modify-write family (`setRunStatus`, `completeRunByUser`,
`setRunTelemetry`, `setRunModelSelection`, `markRunDelivered`) always writes the
manifest it just read — the file it writes is the one whose name it was asked
for, never a body-supplied id. That boundary belongs to the readers, not to
`writeRunManifest`: the write path derives its target from the caller's manifest
body, and `isSafeRunId` only keeps that id inside `.belayd/runs`, so a caller
that writes a body it never read can still name another run's file. The files
that cannot be attributed are left in
place by the creation-time prune, which reports them so they cannot silently
accumulate. `belayd_status` applies the same filename rule to its run-history
table — reporting the foreign manifests it skipped in one line, and showing no
table at all when no task id is recorded, because nothing in a copy-ignored
directory can be attributed then. Arming a workflow and the handoff settle only
flip (or mark delivered) their own bead's manifests (the settle falls back to the
branch's bead when no state file or session id survives), never an inherited
one.

A view with an intent, a deferral and a park — in a throwaway repository, so
nothing here touches your checkout. The script seeds the *pre-store* layout
(`.belayd/workflow.json`, `.belayd/runs/`, `<git-common-dir>/belayd/fleet/<id>/`):
that is exactly what the one-shot import reads on first use, and it is refused
afterwards, so seed it once in a scratch repository.

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
  states: active=1 blocked=0 awaiting-human=1 interrupted=0 idle=0 complete-unlanded=0 missing-state=0

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
  states: active=1 blocked=0 awaiting-human=1 interrupted=0 idle=0 complete-unlanded=0 missing-state=0
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
