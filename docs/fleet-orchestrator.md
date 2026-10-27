# Fleet supervisor (bd-126)

One conversational entry point — `/fleet bd-12 bd-15 bd-19` — that takes several
beads at once, decides order and parallelism, runs each as a normal Belayd
workflow in its own worktree, notifies members when premises change (base moved,
sibling landed, rebase due), merges finished work into `main`, and stays
interruptible so the operator can pause or redirect at any time.

This is the design record. All five milestones exist:

- **P0** — `belayd_fleet_status`, a read-only aggregation of every worktree's
  workflow state (workflow.json + run manifests + one batched read-only
  `bd show` for bead title/status).
- **P1** — `/fleet`, `belayd_fleet_launch`, and the file mailbox
  (`belayd_fleet_note` / `belayd_fleet_inbox`, plus supervisor → member events
  delivered at the member's turn start) on top of the shared-state substrate
  `src/fleet-state.ts` (paths, `fleet.json` intent, mailbox notes, `audit.log`,
  `merge-queue.json` schema).
- **P2** — `belayd_fleet_merge` and `src/fleet-merge.ts`: an atomic
  `mkdir merge.lock.d` acquire with a renewable lease, the
  rebase → gates → merge → base-moved sequence in the operator's root checkout,
  root stash/restore with parking on a conflicting restore, and explicit
  enqueue/drain (no automatic scheduling).
- **P3** — `src/fleet-schedule.ts` + the ordering half of
  `/fleet`/`belayd_fleet_launch`: members are ordered by bd's blocking
  dependencies into waves, a dependency cycle refuses the launch, and only the
  free capacity (`capacity - already active`, ceiling 3 orchestrators) starts
  now. The rest is deferred, with its reason, in the report, `audit.log`, and
  `fleet.json` `deferred`.
- **P4** — `belayd_fleet_pause` / `belayd_fleet_resume` (cooperative flag plus an
  explicitly-limited forceful stop), `belayd_fleet_advance` (an explicit,
  audited wave advance), and `belayd_fleet_reconcile` (merge-queue repair under
  the existing lock primitive, parked-root restore, and member liveness). See
  `docs/fleet-reconcile.md`.
- **P5** — the run loop (`src/fleet-run.ts`, `src/fleet-accept.ts`) and the
  one-orchestrator-per-worktree lease (`src/orchestrator-claim.ts`,
  `src/fleet-heartbeat.ts`). `/fleet` runs to completion by default: it lands each
  finished member — merging the branch and removing the merged worktree — closes
  the bead only when `--accept` asked for it, and starts the next wave until every
  member is landed. `--manual` keeps the P1–P4 surface. See `docs/fleet-run.md`.

An **explicit** (`--manual`) fleet runs nothing on its own: no merge, no wave
advance, no repair. A **run** (`/fleet` with `untilComplete`, the default) does
merge, accept, and advance from a supervisor-side ticker; every tick still goes
through the same audited engines (`fleet-landed`, `fleet-run-stopped`,
`fleet-run-halted`, `fleet-run-complete`), and `belayd_fleet_pause` stops it. The
operator entry
point for the whole surface is **`docs/fleet.md`** (end-to-end run, decision and
failure-recovery tables, verification); per-area detail is in
`docs/fleet-status.md` (status), `docs/fleet-launch.md` (launch, ordering,
mailbox), `docs/fleet-merge.md` (merge queue), and `docs/fleet-reconcile.md`
(pause/resume, advance, crash reconcile).

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
| `fleet.json` | Operator intent: fleet id, task ids, requested concurrency ceiling, paused flag, base branch, supervisor record (`sessionId`, `pid`, `pidStartTime`, `armToken`), note, the (P3) `deferred` members with the reason each waits, and the (P2/P4) `park` record (`reason`, `stashRef`, `recordedAt`) | P1/P3 (`belayd_fleet_launch` / `/fleet`), P2 (`parkFleet`), P4 (`belayd_fleet_pause` / `belayd_fleet_resume` / `belayd_fleet_reconcile`); P0 only reads it |
| `inbox/` | Member → supervisor notes, drained by `belayd_fleet_inbox` | P1 |
| `events/` | Supervisor → member notifications (base moved, rebase due, sibling landed, pause/resume), drained at the member's turn start. One file **per recipient**: a broadcast is fanned out at enqueue time | P1 |
| `merge-queue.json` | Single-flight merge queue (entries + one lease holder) | P2 (`belayd_fleet_merge`) |
| `audit.log` | Append-only audit of every cross-tree authority action (launch, re-arm, per-member launch attempt, prune, note, inbox drain, events ack, merge acquire/release/stash/restore/gates/broadcast, P3's `schedule-planned`/`member-deferred`/`capacity-blocked`, and P4's `fleet-paused`/`fleet-resumed`/`fleet-unparked`/`member-stopped`/`advance`/`queue-*`/`member-pruned-dead`) | P1/P2/P3/P4 |

`src/fleet-state.ts` owns this layout. It is storage and pure parsing only — no
scheduling, spawning, merging, stashing, or bead mutation; P1's launch and
mailbox, P2's queue, P3's deferred plan, and P4's pause/reconcile writes all call
it. Its
rules, which the later milestones must keep:

- **One intent schema, one parser.** `FleetIntent`/`parseFleetIntent` live in
  `src/fleet-status.ts` and are reused by every writer, so the reader and the
  writers cannot drift. Besides the operator fields the record carries what P2
  needs (accepted `baseBranch`) and what P4 needs (the owning supervisor record
  plus the process-identity anchors described under [P1: fleet mode](#fleet-mode-is-derived-never-flagged)).
- **Atomic writes.** `fleet.json` and `merge-queue.json` go through
  `atomicWriteJson` (temp file + rename); a reader never sees a half-written
  record. `writeFleetIntent` refuses to replace a **present but unparsable**
  record (absence is writable), so a schema downgrade cannot silently erase a
  human's newer `fleet.json`.
- **Intent mutations are compare-and-replace.** `updateFleetIntent` writes only
  when the on-disk text still equals what it read; the loser of a race gets
  `reason: "conflict"` and retries. Residual race, by design of a plain JSON
  file: two writers can both compare and both write (last rename wins). Closing
  that window needs the same `O_EXCL`/`mkdir` primitive the merge lock requires.
- **Append-only means append.** `audit.log` is written with an append; the
  module exposes no truncate/rewrite/rotate operation, and every caller-supplied
  field (`actor`, `action`, each task id, the id list, `detail`) is length- or
  count-capped so one runaway value cannot bloat the log.
- **Notes are files.** A note file carries `kind` (`note`, `rebase-hint`,
  `base-moved`, `sibling-landed`, `pause`, `resume`), `from`, `to`, a bounded
  `body`, and a timestamp. Filenames hash the content and sanitize the task id
  and kind with the single fleet-id sanitizer, so an untrusted id cannot escape
  the mailbox directory; `enqueueNote` validates the whole note first (a
  non-numeric `createdAt` reaches no filename) and truncates only an over-long
  body. `drainNotes` never deletes: a note is removed only by `ackNotes` after
  the caller consumed it, so a crash between drain and ack replays a note
  instead of losing it. The drain runs every turn, so it stats each file first
  and quarantines anything above 64 KiB without reading it; a corrupt note is
  renamed to `<name>.corrupt`, while a note written by a *different* note-schema
  version is left in place and reported once per drain (version drift is not
  corruption).
- **A broadcast is N files, not one.** `to: "all"` is expanded by
  `enqueueNoteFanout` into one content-addressed file per member (same body,
  per-recipient `to`). One shared `all` file cannot work under this protocol:
  every member matches it, the first acker deletes it, and the siblings never see
  it. The recipient set comes from `fleet.json` `taskIds`, so a member that has
  not been launched yet still receives later notes. A partial fan-out is reported
  with the recipients it did reach (`note-partial` in the audit log).
- **The merge lock is a lease with an out-of-band primitive.**
  `merge-queue.json`'s lock carries `holder`, `taskId`, `pid`, `acquiredAt`, and
  `leaseExpiresAt`; `isLockExpired`/`canAcquireFleetMerge` are the pure decision
  half. A JSON record alone cannot deliver single-flight (two readers can both
  see "lock free"), so P2 gates acquisition on
  `mkdir <fleetDir>/merge.lock.d` — atomic on POSIX, fails with `EEXIST` — and
  writes the record only after winning it (see [P2](#p2-single-flight-merge-queue)).
  The expired-lease branch is what makes a crashed holder recoverable rather
  than a permanent wedge, and it is the *only* takeover authority: the recorded
  pid is diagnostic, never a liveness check.

### Status is derived, never stored

There is no fleet status file. `belayd_fleet_status` computes the view from:

1. each worktree's `.belayd/workflow.json` (task id, workflow type, branch,
   `phaseOrder`, `completedPhaseNames`, `awaitingReviewResponse`, `updatedAt`),
2. each worktree's `.belayd/runs/*.json` run manifests (latest run per phase,
   `RunStatus`, interrupted runs),
3. the optional `fleet.json` intent record,
4. one batched read-only `bd show <ids> --json` for bead metadata (title and
   status). bd is optional: absent, failing, timing out, or non-JSON output
   degrades to "no bead metadata" plus a single fleet-level warning, and no bd
   call happens at all when no member has a task id. Every `bd` mutation stays
   in P1+.

A stored status file would drift from those four sources the moment a member
writes anything; deriving it keeps the supervisor honest by construction.

## Locked decisions

| Question | Decision |
|----------|----------|
| Concurrency ceiling | 3 concurrent orchestrators (**not** 3 total agents — sub-agents do not count); enforced by a re-count inside the intent's compare-and-replace, with the one residual cross-fleet race stated in [Capacity accounting](#capacity-accounting) |
| Supervisor working directory | main repo root |
| May merge to `main`? | Yes, through a single-flight queue |
| Dirty root at merge time | auto-stash, immediately restore; if the restore conflicts, park the fleet instead of losing work (P2: `merge-stash`/`merge-restore`; a conflicting restore keeps the stash, parks the fleet, and reports the ref) |
| Bead status after merge | `belayd_fleet_merge` never touches a bead: the merge leaves it `in_progress` + `human`. A **run** leaves it there too (bd-158): landing resolves the member's bd ordering gates instead of closing its bead. The merged worktree is removed on every landing; `--accept` opts into closing the bead as well, audited as `fleet-landed` |
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
- **P2 adds only the merge queue and its notifications.** It merges an explicitly
  enqueued member into the base branch, stashes/restores the root, and sends
  `base-moved`/`sibling-landed`/`rebase-hint` notes. It never reorders the queue,
  never pauses/resumes a fleet on its own (parking on a restore conflict is the
  one exception, and it is reported), and never mutates a bead: merging is not
  closing.
- **P3 adds ordering and capacity accounting at launch time only.** It reads bd's
  blocking edges, plans waves, and starts at most the free capacity. It runs no
  phase, merges nothing, advances no wave, and mutates no bead; every decision is
  audited and a deferred member is recorded, never dropped.
- **P4 adds interruption and repair, invoked explicitly.** `belayd_fleet_pause`
  writes the flag every starting action already checks (launch, merge, advance) and
  stops the P5 ticker; its forceful variant only signals orchestrator processes it
  can positively identify. `belayd_fleet_resume` is the only writer that clears
  `paused`, and it restarts the ticker. `belayd_fleet_advance` is an explicit,
  audited decision (the run loop calls the same engine on its own tick).
  `belayd_fleet_reconcile` repairs the queue under the existing merge lock, retries
  a parked root restore from the recorded sha, and reports member liveness from the
  worktree lease plus the process table instead of intent.
- **P5 adds the run loop and the worktree lease.** The ticker lives in the
  supervisor session, acts only through the P2/P3/P4 engines, and records every
  action in `audit.log`. The lease is created by the spawner and renewed by the
  orchestrator session itself, which is the only liveness evidence a pi-web
  session can produce; a live lease refuses a second orchestrator for that
  worktree, and a cold lease is archived (never deleted) before a takeover.

## Milestones

| Milestone | Scope | Status |
|-----------|-------|--------|
| **P0** | `belayd_fleet_status` — read-only aggregation of every worktree's workflow (state file + run manifests + optional intent + one batched read-only `bd show`) into one derived view. No new authority. | **Implemented** (`src/fleet-status.ts`) |
| **P1** | `belayd_fleet_launch` on explicit instruction + file mailbox (`inbox/`, `events/`) for notes and rebase hints, delivered to members at turn start. | **Implemented** (`src/fleet-launch.ts`, `src/fleet-mode.ts`, `src/fleet-mailbox.ts`, `extensions/index.ts`) |
| **P2** | Single-flight merge queue + base-moved propagation (`merge-queue.json`, `merge.lock.d`, `src/fleet-merge.ts`, `belayd_fleet_merge`): atomic acquire + renewable lease, rebase → gates → merge → broadcast in the operator's root checkout, root stash/restore with parking on a conflicting restore. | **Implemented** (`src/fleet-merge.ts`, `belayd_fleet_merge`; explicit enqueue/drain only) |
| **P3** | Automatic ordering/parallelism + capacity-aware concurrency (ceiling 3 orchestrators): bd blocking edges → waves, cycle refusal, launch only the free capacity, record deferred members in `fleet.json` `deferred` with their reasons. The ceiling counts **live or unknown** members of **every** fleet (a dead supervisor's detached members still run; an absent or released one does not — bd-166); an unreadable fleet intent refuses the launch instead of assuming zero. | **Implemented** (`src/fleet-schedule.ts`, `src/fleet-beads.ts`, `src/fleet-launch.ts`; wave 2+ is advanced explicitly by `belayd_fleet_advance`) |
| **P4** | Cooperative/forceful pause + fleet-level crash reconcile: `belayd_fleet_pause`/`belayd_fleet_resume` (CAS intent writes, audited), `belayd_fleet_advance` (explicit wave advance over the persisted deferred plan), `belayd_fleet_reconcile` (merge-queue repair under the existing lock primitive, parked-root restore from the recorded stash sha, member liveness from the lease + process table). | **Implemented** (`src/fleet-pause.ts`, `src/fleet-reconcile.ts`, `src/fleet-sessions.ts`, `extensions/index.ts`; see `docs/fleet-reconcile.md`) |
| **P5** | Run to completion: a durable `run` record in `fleet.json`, one deterministic tick per action (land → stop → advance → complete), accepting a landed member (worktree removal on every landing; `bd close` when accepted), the one-orchestrator-per-worktree lease, and the run-mode supervisor heartbeat that makes a re-arm possible. | **Implemented** (`src/fleet-run.ts`, `src/fleet-accept.ts`, `src/orchestrator-claim.ts`, `src/fleet-heartbeat.ts`, `extensions/index.ts`; see `docs/fleet-run.md`) |

**What P2 inherited and reuses (no second mechanism was introduced):** per-recipient
fan-out means a base-moved broadcast reaches every member exactly once under the
ack protocol; note addressing is validated against intent membership, so a
`base-moved`/`sibling-landed`/`rebase-hint` is addressed through
`resolveFleetNoteRecipients`; the supervisor identity is anchorable (start time +
arm token) so a second supervisor cannot consume the queue undetected; and
`re-arm` remains the supported way to recover a fleet whose supervisor died.
What P2 still does not do: order or schedule launches (that is P3, and it runs
before a merge exists) and pause/resume the fleet (that is P4's explicit
`belayd_fleet_pause`/`belayd_fleet_resume`; the only pause P2 writes itself is
`parkFleet` on a conflicting root restore, and it records the stash ref so
`belayd_fleet_reconcile` can restore it).

## P1: fleet mode, launch, and the mailbox

P1 is the first milestone with cross-tree authority. It is deliberately narrow:
launch members, pass notes, and refuse to be an orchestrator. It does **not**
order, merge, pause, or reconcile.

### Fleet mode is derived, never flagged

The supervisor record is written to `fleet.json` by `/fleet` and
`belayd_fleet_launch`:

```json
"supervisor": { "sessionId": "…", "pid": 4242, "pidStartTime": "123456789", "armToken": "…" }
```

A session counts as the fleet supervisor only while **all** of these hold
(`resolveFleetMode`, `src/fleet-mode.ts`):

1. the recorded `sessionId` is this session's id;
2. the recorded pid is a plausible supervisor process — above
   `FLEET_MIN_SUPERVISOR_PID`, because pid 1 and the kernel-thread range are
   alive forever and are exactly what a planted record would name;
3. the pid is alive *and*, when both sides recorded one, its `/proc/<pid>/stat`
   field-22 start time is unchanged — pids are recycled, so bare liveness would
   let a resumed supervisor auto-match an unrelated process (S1);
4. the record carries the `armToken` this session minted when it armed — a
   secret generated per arming and held **only in the session's memory**, never
   written anywhere but `fleet.json`.

Nothing is cached on disk as a mode flag, so:

- a new session can never inherit fleet mode from a stale record — a dead pid, a
  different session id, an unchanged-looking reused pid, or a missing/incorrect
  token simply does not match;
- a resumed supervisor session (same id, new pid) is *not* silently a supervisor:
  the operator re-arms it with `/fleet`, which rewrites the record and mints a new
  token;
- deleting or rewriting `fleet.json` disarms the mode on the next check.

**Threat model (W6).** The fleet directory lives in the repository's git dir and
is writable by anything that can write there, so `fleet.json` is untrusted input.
A session id is public and a long-lived pid is easy to name, which is why
identity alone is not enough: the pid floor blocks init/kernel pids, the start
time blocks a reused pid, and the arm token blocks a **blind plant** — a record
written without reading the fleet directory cannot contain a token this session
minted. The launch path additionally **reads its own record back** and refuses to
arm when the record on disk is not the one it wrote (a concurrent writer replaced
it), so a supervisor never claims authority over a `fleet.json` it does not
control.

**What the token does not defend (W-C).** It is not a secret against an attacker
who can *read* the fleet directory: that attacker copies the token verbatim in a
read-modify-write, and can also edit the recorded pid/start time to make a live
supervisor look dead and take the fleet over through `/fleet`. The anchor
therefore covers passive/planted records and accidental staleness, not write
access to the fleet dir. Residual risk, stated not hidden: inside a fresh pid
namespace (a container) pids start low, so a supervisor there may sit below the
floor and is not recognised until it re-arms from a session whose pid clears it.

Because the check is derived, there is no session-scoped flag to reset beyond the
arm token, and no window in which a reset flag could disagree with disk.

### The refusal

Fleet mode arms no process gate and hard-refuses the phase tools (including
`belayd_commit`), `belayd_proof_verifier`, `belayd_start_task`,
`belayd_start_followup`, and `belayd_stop_task`:

> Fleet supervisor sessions do not run phases: this session schedules fleet
> `<fleetId>` and owns no worktree, so `<tool>` is refused. Observe members with
> `belayd_fleet_status`, add members with `belayd_fleet_launch`, message them with
> `belayd_fleet_note`, and read their reports with `belayd_fleet_inbox` — each
> phase runs in the member orchestrator that owns that bead's worktree.

Ordering matters: the refusal is evaluated in the `tool_call` hook, before the
process gate and before any tool handler. It is skipped for a gated or planning
session, which is never a supervisor (fleet mode arms no gate), so a member
worktree keeps its **bd-119** refusal worded exactly as before. Fleet mode is an
additional, earlier refusal — not a replacement.

### `/fleet` and `belayd_fleet_launch`

`/fleet bd-12 bd-15 [--fleet <id>] [--concurrency <n>]` and the
`belayd_fleet_launch` tool (`tasks`, optional `fleetId`, optional `concurrency`)
share one engine (`runFleetLaunch`, `src/fleet-launch.ts`) through two injected
seams: the bd-119 ownership probe and the existing single-bead launch path
(`launchWorktreeWorkflow` → worktree + handoff packet + workflow state + daemon
session). No second spawner exists.

Order: **validate → write intent → launch → prune.**

1. **Validate first.** Every id must be a valid beads id, unique in the request,
   not already a member of a **live** fleet in the repository, and free of a
   worktree already owned by another bead (checked with `matchOwnedWorktree`, the
   bd-119 resolver, not a re-derivation). Every problem is collected, and a
   refusal creates nothing: no fleet directory, no intent, no worktree, no
   session.

   Two cases are deliberately *not* refusals:

   - **Re-arm (C2).** When the target fleet's supervisor is not running, the
     fleet's own members listed in the request are **preserved**, not relaunched
     (`rearmedTaskIds`), and the supervisor record is rewritten. `/fleet bd-12` on
     a dead fleet therefore recovers supervision; without this a resumed
     supervisor could only recover by hand-editing `fleet.json`. A request may mix
     preserved members with new ids (`/fleet bd-12 bd-19`). A re-arm keeps the
     stored concurrency ceiling and `paused`/`note` because it restates
     supervision, not fleet policy. It is audited as `re-arm`.
   - **A live supervisor from another session is refused** (`fleet-supervised`,
     naming that session): replacing the record would silently de-supervise a
     running scheduler (W2).

   A member of a *dead* fleet that is named in a launch for a **different** fleet
   is refused with a split-brain message: it belongs to that fleet, and re-arm it
   there instead, otherwise its notes keep landing in a mailbox no live supervisor
   drains.

   **One session supervises one fleet (W-B).** A session that already holds fleet
   mode passes the resolved fleet id into validation, and launching a *different*
   fleet is refused (`fleet-supervised-elsewhere`, naming the fleet it already
   supervises) before any write. Without that guard the second launch replaced the
   in-memory arm token while the first fleet's record still named this session:
   its inbox resolved to the new fleet and refused the old one, and every other
   session was refused `fleet-supervised`, wedging the first fleet until its pid
   died. A launch that writes and verifies its record reports `armed: true`
   separately from `ok`, so a **failed member launch** keeps (and updates) the
   arm instead of clearing it; a refused or unread-back launch leaves an existing
   arm untouched.

   **A worktree already driven is refused (W-D).** `matchOwnedWorktree` (bd-119)
   answers "does *another* bead own this tree", so an existing worktree whose
   workflow state is for *this* bead resolves `ok` — yet a standalone `/belayd`
   orchestrator is already driving it. The fleet probe therefore refuses any
   existing same-task `.belayd/workflow.json` (with or without a running manifest)
   before a spawn: `already driven by a standalone orchestrator … use that
   session, or re-arm the fleet`. Re-arm is the documented recovery because it
   preserves members instead of relaunching them.
2. **Ceiling.** Concurrency is clamped to **3 orchestrators** and the stored value
   is what the report says it stored. A request above the cap is clamped **and
   reported**; a fractional request is floored **and reported** (`Concurrency 2.5
   is not a whole number; stored 2`); an unusable value (0, negative, NaN) falls
   back to the ceiling and is reported too. Nothing is silently accepted or
   silently dropped.
3. **Intent before members.** `fleet.json` is written with `updateFleetIntent`
   (compare-and-replace, preserving `createdAt`, `paused`, and the operator note,
   appending new ids, replacing the supervisor record) and then **read back**: if
   the record on disk is not the one this session just wrote, the launch refuses
   to claim supervision. A member resolves its own mailbox *by task id*, so the
   record has to exist before the first member session starts.
4. **Per-member launches.** `launchWorktreeWorkflow` runs with
   `role: "fleet-member"`: the member gets its worktree, handoff packet, workflow
   state, and orchestrator session, but the supervisor is **not** disarmed and no
   handoff marker is written (a marker would make the supervisor's own restart
   refuse to resume supervision). Preserved re-arm members are **not** launched:
   their worktrees and sessions already exist, and a second orchestrator on one
   bead is exactly what bd-119 exists to prevent.
5. **Failure semantics (chosen, and tested): the fleet proceeds.** One member
   failing never aborts the others. Each outcome is reported per member, audited
   (`member-launch-failed`), and the failed id is then **removed from the intent**
   (audited as `member-pruned`) so it does not linger as a phantom member in every
   later `belayd_fleet_status` (and so a later launch can retry it). The tool exits
   non-zero only when nothing launched and nothing was re-armed.

### The mailbox

| Direction | Tool | Directory | Consumption |
|-----------|------|-----------|-------------|
| supervisor → member (or `all`) | `belayd_fleet_note` (default channel `events`) | `events/` — one file **per recipient** | the member's `before_agent_start`, at the start of its next turn; acked in `agent_end` |
| member → supervisor | `belayd_fleet_note` (channel `inbox`) | `inbox/` | `belayd_fleet_inbox` (supervisor-only), rendered then acked |

Note kinds: `note`, `rebase-hint`, `base-moved`, `sibling-landed`, `pause`,
`resume`. Bodies are bounded (`FLEET_NOTE_BODY_MAX_LENGTH`) and addresses are
bounded (`FLEET_NOTE_ADDRESS_MAX_LENGTH`), which is what lets the schema promise
a legal note is never larger than `FLEET_NOTE_FILE_MAX_BYTES`.

**Addressing is validated against live membership (S3).** A supervisor note must
name a member in `fleet.json` `taskIds` or `all`; `supervisor` is refused in
`events/`. A member note must name `supervisor` — a member cannot write into
another member's mailbox, and cannot write `events/` at all (W1). A typo is
refused instead of creating mail no one ever drains (immortal dead files).

**`events/` is supervisor-only (W1).** `events/` is a supervisor → member channel,
and a member that could write it would be performing cross-worktree prompt
injection (a fake `pause` or `base-moved` in a sibling's turn start). The tool
refuses `channel: "events"` for a member author for every note kind. Defense in
depth: the member-side selector never injects a note in `events/` whose `from` is
not `supervisor`; it reports the count as ignored and leaves the files on disk.
Note lines render `from → to` so a member-authored note is never readable as a
supervisor one.

Member delivery is a separate `before_agent_start` handler — the process-gate
handler's early returns cannot skip it, and the instruction-group collector is
untouched. Properties:

- **addressed only:** a member injects notes whose `to` is its own task id (or
  `all`, for a hand-written legacy file); a sibling's note stays on disk and is
  not acknowledged. Broadcasts never reach a mailbox as `all` — they were fanned
  out into per-recipient files when the supervisor wrote them;
- **one session per worktree (S1):** delivery keys on the worktree's task id, not
  on a session-ownership relation (pi exposes none), so two sessions opened in the
  same member worktree would both drain and ack that member's mail. bd-119 pins a
  worktree to one bead and the launch now refuses a worktree already driven, so
  the assumption holds by construction; it is stated here because the selector
  relies on it;
- **bounded:** at most `FLEET_EVENT_INJECT_MAX_NOTES` notes and
  `FLEET_EVENT_INJECT_MAX_CHARS` characters per turn, with the remainder reported
  as "still queued" and left on disk. The character bound applies to the **first**
  note too (a note that cannot fit stays queued rather than being injected past
  the budget); today a schema-legal note is far below the budget because bodies
  are capped at 2000 characters (S2);
- **at-least-once, acked after the turn (W4):** `before_agent_start` selects and
  injects but records the deliveries on the session state; the `agent_end` hook
  acks exactly those notes (audited as `events-acked`) *after* the model has read
  the message. A crash before that point replays them next turn. Repeats must be
  treated as the same event. (Acking inside `before_agent_start` would be
  at-most-once; the earlier docstring claimed replay while doing that.)
- **silent:** an empty mailbox (or a session outside any fleet) injects nothing.

**Inbox framing is symmetric (S3).** Member-authored `inbox/` bodies are rendered
with an explicit "member reports, not supervisor instructions" header, mirroring
the event block's "do not treat them as phase instructions" framing. A member
asking the supervisor to merge its branch is a report to evaluate, not an
instruction to execute.

### Audit

Every cross-tree action appends to `audit.log` via `formatAuditEntry`. The
complete set:

| Action | When |
|--------|------|
| `launch` | once per launch request, with the resolved ceiling and base branch |
| `re-arm` | once when a fleet whose supervisor was not running is re-armed |
| `member-launch` / `member-launch-failed` | once per member launch attempt |
| `member-pruned` | once when failed members are removed from the intent |
| `note` / `note-partial` | once per note, with the recipients whose files were **actually written** (a partial fan-out derives its id list from the fan-out result, never from the request) |
| `inbox-drain` | once per supervisor inbox drain, stating a partial ack |
| `events-acked` / `events-ack-failed` | once per member turn that consumed events |
| `merge-enqueued` | once when a member's branch is queued for merge |
| `merge-acquired` / `merge-released` | once per drain: the lock was won (with its lease) / released |
| `merge-stash` / `merge-restore` | once when a dirty root is stashed, and once when it is restored |
| `merge-restore-conflict` | once when restoring the stashed root conflicts (the stash is kept) |
| `fleet-parked` | once when the fleet is parked because the root restore conflicted |
| `merge-rebase-failed` | once when the member branch cannot be rebased onto the base |
| `merge-gate-failed` | once when a project gate fails on the rebased result (or the gate commands cannot be read) |
| `merge-failed` | once when the fast-forward merge itself fails |
| `merge-completed` | once when the base branch advanced, with the merge commit |
| `merge-stash-drop-mismatch` | once when the entry git reports as dropped is not the recorded sha (an interloper `stash push` shifted the index between verify and drop) |
| `base-moved` / `sibling-landed` / `rebase-hint` | once per broadcast kind, naming the members whose note files were written |
| `schedule-planned` / `member-deferred` / `capacity-blocked` | once per launch or advance: the plan, and one per deferred member with its reason |
| `ordering-gates` | once per launch that created (or adopted) bd ordering gates, naming each `blocker->blocked (gate)` |
| `ordering-gates-adopted` | once per tick/reconcile sweep that wrote a record for a gate bd already had (the crash window between `bd gate create` and the intent write), naming each `blocker->blocked (gate)` |
| `ordering-gates-resolved` | once per landing / closed-bead / pruned-member resolve, naming the gate ids bd confirmed resolved (bd-158) |
| `ordering-gate-unresolved` | once when a landing merged but bd refused the gate resolve: the record stays and the next tick retries (bd-158) |
| `fleet-landed` | once per landing, with the member and base branch |
| `fleet-paused` / `fleet-pause-failed` | once per pause attempt (applied / refused or failed to write) |
| `fleet-resumed` / `fleet-unparked` / `fleet-resume-refused` | once per resume attempt: resumed, park cleared, or refused (a park that still names a stash) |
| `member-stopped` / `member-stop-skipped` / `member-stop-failed` / `member-stop-unavailable` | once per pid the forceful pause considered: signalled / identity changed or unreadable, so skipped / `kill` failed / process table unreadable |
| `advance` | once per explicit `belayd_fleet_advance` decision |
| `queue-take-over-lock` / `queue-clear-lock-record` / `queue-mark-merged` / `queue-reset-queued` | once per reconcile queue repair (take over an expired lease, clear a stale record, mark a git-proven merge, re-queue a frozen entry) |
| `member-pruned-dead` | once per member removed from the intent by `pruneDeadMembers` |

An audit append that fails is surfaced to the operator — an unlogged cross-tree
action is a bug, not a detail.

**Deliberately out of scope of the audit promise:** mailbox hygiene. A drain that
quarantines a corrupt or oversize note renames it to `<name>.corrupt`; that rename
is reported as a warning in the drain output but is not an audit line. It is
repair of a file that already failed the note contract, not an exercise of
cross-tree authority, and the drain runs every turn (so auditing it would let any
member spam `audit.log` with garbage files).

## P2: single-flight merge queue

P2 is the only milestone that moves the repository's shared branch. It is
**explicit**, **single-flight**, and **never closes a bead**. Operator surface:
`belayd_fleet_merge` with `action: "enqueue" | "drain" | "list"` (see
`docs/fleet-merge.md`). Launch ordering is P3 and is planned before a merge exists;
nothing schedules the merge queue itself.

### Acquisition is a filesystem fact

The lease record in `merge-queue.json` cannot deliver single-flight on its own:
two supervisors can both read "lock free". Acquisition therefore gates on
`mkdir <fleetDir>/merge.lock.d` — atomic on POSIX, fails with `EEXIST` — and the
winner writes the record afterwards (`acquireFleetMerge`, `src/fleet-merge.ts`):

1. read the queue; an unexpired lease is refused **without touching** the
   primitive;
2. `mkdir`; on `EEXIST`, decide from the queue;
3. an **expired** lease is the only takeover authority: the stale primitive is
   removed and `mkdir` retried (losing the retry is reported, never assumed
   away). The recorded pid is diagnostic only — there is no pid-based takeover;
4. write the lease, then verify the primitive is still present; if it is not, the
   record is withdrawn (`lost-race`), so a stolen primitive never leaves two
   recorded holders.

Incoherent states are diagnosable and bounded, not wedges:

| State | Behaviour |
|-------|-----------|
| `merge.lock.d` with no record | refused `orphan-lock-dir` (acquisition in progress) until the directory's mtime is older than `FLEET_MERGE_ORPHAN_LOCK_GRACE_MS` (30 s), then reclaimed — a crash between `mkdir` and the record write recovers |
| record with no `merge.lock.d` | refused `record-without-lock`, naming the lease deadline; acquirable when that lease expires |
| releasing a lock held by another session | refused `not-holder`, nothing mutated |
| renewing a foreign/broken lease | refused `not-holder` / `lock-dir-missing` |

**Lease renewal** (`renewFleetMergeLease`) is the heartbeat: the holder rewrites
`leaseExpiresAt` before each mutating step (rebase, gate run, merge). It requires
the primitive to still exist, so a lease is never extended for a lock the holder
no longer owns. `releaseFleetMerge` clears the record (compare-and-replace) and
then removes the empty directory.

Residual race, stated not hidden: two acquirers can both observe the same expired
lease and interleave remove/`mkdir`, and the loser can remove the winner's fresh
directory before the winner writes its record. The post-write primitive check
detects it and withdraws the record; the next drain retries. No repository
mutation starts until an acquire is verified.

### The merge sequence

`drainFleetMerge` runs **preconditions → acquire → stash article → rebase → gates
→ merge → restore → broadcast → release** in the operator's root checkout (only
the root can hold the base branch).

Preconditions, all checked **before any mutation** (the queue entry is left
`queued` on a refusal):

- the fleet intent exists and is not `paused`;
- `rootCwd` is this repository's **own** checkout (not a linked worktree) and is
  on the base branch (`fleet.json` `baseBranch`, default `main`);
- the member branch is checked out in a worktree that is **clean**;
- the queue has a selectable `queued` entry; the lock is then acquired.

Dirty root (locked decision): the root is stashed with
`git stash push --include-untracked` and the stash **sha** is recorded and
audited (`merge-stash`). It is restored immediately after the merge work by
applying that recorded sha (`git stash apply <sha>`) and then dropping exactly
that entry (`merge-restore`) — never a positional `stash@{0}`, because a stash
the operator pushed during a long gate run sits at position 0. The restore
re-runs the same root-own-checkout + on-base check before touching anything (the
root can move onto another branch, and a linked worktree can legally hold the base
while the root moved away), so the operator's work never lands in the wrong
checkout. If the recorded
stash no longer resolves, or the root is no longer on the base branch, the
restore is refused (the work stays in the stash) and the fleet is **parked**
(`fleet.json` `paused: true`, the reason and stash ref appended to `note`,
audited `merge-restore-conflict` + `fleet-parked`), and the result reports the
stash ref. If the apply conflicts, the partial application is reset (git keeps a
stash whose apply fails) and the same parking path applies. The operator's work
is never discarded, never restored onto another branch, and never left only in a
stash without being told.

**The root is the operator's checkout, so it can move.** The root's
`HEAD` is re-verified immediately before the stash, immediately before the
fast-forward (after the lock renewal), and immediately before the restore. A
branch switch during the gates therefore refuses the merge with
`root-not-on-base` instead of fast-forwarding a branch that is not the base
(`git merge --ff-only` moves whatever `HEAD` holds).

Gates: the commands are read from the **merge target's** `package.json` scripts in
the fixed order `test`, `test:integration`, `typecheck`, `lint`, `build`; a repo
that does not define one simply skips it, and a repo with none refuses
(`gate-commands-missing`). They run against the **rebased result** in the member
worktree, through the package manager the target declares
(`packageManager`, else its lockfile, else `npm`) — a hardcoded `pnpm` would
report a missing binary as a gate failure on a non-pnpm repo. A failing gate
aborts the merge, leaves the root on the base branch, leaves the member's commits
unmerged, releases the lock, and reports the gate.

**A live holder is never deposed.** The per-command timeout (25 min) is below the
lease (30 min), and the lease is renewed before **every** gate as well as before
the rebase and the merge. A gate suite that outlasts one lease therefore cannot
let a second supervisor take the queue over mid-drain — the situation where two
drains would interleave their parked root stashes.

Merge: `git merge --ff-only <memberBranch>` in the root. The member was rebased
onto the base first, so this is a fast-forward; a failure is reported
(`merge-failed`) and the root is unchanged.

**Merging is not closing.** The module has no `bd` seam at all: it never calls
`bd update`/`close`/`label`. The bead stays `in_progress` + `human`, and the
drain report says so. The human accepts via `wt merge`/bd.

Base-moved propagation: after a successful merge the remaining members receive,
through the existing per-recipient fan-out
(`enqueueNoteFanout` + `resolveFleetNoteRecipients`):

| Kind | Recipients |
|------|------------|
| `base-moved` | every remaining member |
| `sibling-landed` | every remaining member |
| `rebase-hint` | remaining members whose actual branch (resolved from git's worktree list, not assumed to be `feat/<id>`) does not yet contain the new base commit (`git merge-base --is-ancestor`); a member with no resolvable branch is skipped rather than sent a hint about a branch that does not exist |

A failed drain leaves the root on the base branch, no stash discarded, the lock
released, the member worktree's commits intact (a failed rebase is aborted), and
an honest report. The only repo mutation that can outlive a *gate* failure is the
member's content-preserving rebase onto the base, which the report names.

## P3: ordering, waves, and capacity-aware launch

P3 is the smallest honest piece of automation above P1: it decides **which**
members start now and **in what order** the rest are planned. It is a pure
function (`planFleetSchedule` in `src/fleet-schedule.ts`) over already-read data
— `(tasks, edges, capacity, activeCount)` in, `{ waves, launchNow, deferred,
reasons, warnings }` out — so a cycle refusal and a capacity deferral are testable
without git, bd, or a filesystem.

### Ordering rules

- **Edges are real dependencies.** The graph comes from one batched read-only
  `bd show <ids> --json --brief-deps` and only `dependency_type: "blocks"`.
  `related` and the other link types say nothing about order, so they are not
  turned into edges. A blocker whose status is finished (`closed`) is dropped: it
  has landed, so it is no reason to wait.
- **A member cannot start before its blocker.** Wave 0 is every member with no
  remaining blocker; a member's wave is one past the deepest blocker it waits
  for. Inside one wave, caller order is the deterministic tie-break, so the same
  request (in any edge order) produces the same plan.
- **External blockers are deferred, not invented.** A bead *outside the fleet*
  that still blocks a member means that member cannot be planned for any wave yet
  (`external-blocker`); the same applies transitively to members waiting for it
  (`dependency`). A blocker that belongs to the fleet — an already-launched or
  stopped member — is not external: its dependents are planned for a later wave
  (`dependency`) and become eligible when that member lands. Once the outside bead
  lands, a later launch (or advance) schedules the waiting members.
- **Unreadable graphs degrade.** bd absent, failing, timing out, or printing
  non-JSON yields "no known edges" plus a warning — never a crash and never a
  fabricated edge. The members still launch (in caller order), without ordering.

### Cycle refusal

A dependency cycle (including a self-dependency) refuses the whole launch with
`dependency-cycle`, the closed path (`bd-12 → bd-15 → bd-12`), and the advice to
break it with `bd dep remove`. Nothing is created and nothing is written: an
order that cannot exist is not a plan, and launching part of a cycle would leave
the rest waiting forever.

### Capacity accounting

The locked ceiling is **3 concurrent orchestrators**, and the ceiling counts
orchestrators, not sub-agents. `slots = max(0, capacity - activeCount)`, where
`activeCount` counts the recorded members of **every** fleet whose orchestrator
liveness is `live` or `unknown` (bd-166); an `absent` member or one in `released`
does not hold a slot, though it stays in `taskIds`. Members are disjoint across
fleets, so the count is a sum, and a detached member of a dead-supervisor fleet
still counts while its orchestrator is alive. The target fleet's own preserved
(re-armed) members count too. Supervisor liveness only changes the wording of
refusals. An unreadable fleet
intent makes the count unknowable, so the whole launch is refused rather than
assuming those members are gone (under-counting is the unsafe direction). Wave 0
up to `slots` is launched; the rest of wave 0 is deferred `capacity`, and later
waves are deferred `dependency`. The remainder is never dropped.

**The decision and the write are one window.** The plan's slots come from a
context read taken before the batched `bd --brief-deps` call (a process spawn), so
another supervisor can spend those slots in that window. `belayd_fleet_launch`
therefore re-counts every fleet's members *inside* `updateFleetIntent`'s
compare-and-replace and refuses (nothing launched, nothing recorded) when the
recount no longer fits the ceiling. **The residual races, stated rather than
hidden:** the compare-and-replace covers the target fleet's own file, not a
fleet-wide lock, so two launches from *different* fleets at the same instant can
each read the other's pre-launch record and both write; and the CAS itself is the
documented check-then-write window of `updateFleetIntent` (two writers to the
*same* file can both compare successfully before either renames). The re-count
closes the window opened by the `bd` lookup, but it cannot make the cross-fleet
sum atomic without a fleet-wide lock primitive, which this milestone deliberately
does not add. An observed count above 3 is corrected the normal way:
`belayd_fleet_status` shows it, and the next launch refuses until a member exits
or is pruned.

**One more window, and how it is closed: a member mid-spawn.** A launch writes the
intent (the id is now in `taskIds`) *before* it creates the worktree, waits for the
worktree to become ready (up to a minute of `pnpm install`-class setup), and only
*then* takes the spawner's `pending:` lease. For that whole span the member has no
lease, no `belayd-<taskId>` process, and — before the worktree exists — nothing to
probe at all, so a naive probe would call it `absent` and a concurrent launch's
recount would start work past the ceiling. Two rules close it:

- **no worktree** (or an unresolvable one) is `unknown` (counted), never `absent`;
- an existing worktree **with no evidence its session ever ran and no lease** is also
  `unknown`: it is a bare spawn tree. The evidence is a `.belayd/workflow.json`
  **or a run manifest this execution wrote**, because completion deletes the state
  file (`clearWorkflowState`) while the manifests stay. "This execution" is the
  cutoff: a manifest is evidence only when it postdates the worktree's own creation
  instant (and the run's recorded `launchedAt`, when that is later), so an inherited
  same-task manifest copied in by `wt step copy-ignored` never frees a slot for the
  spawn that is still creating the tree. With no cutoff at all, no manifest is
  evidence — the member stays counted.

A fresh `pending:` spawn claim is **live** (the child exists in a moment), and a
stale one is unclassifiable — never `absent`. The `absent` verdict is kept for the
case it exists for: a member whose session provably existed (state file or a
same-task run manifest this execution wrote), with no lease and no process — a
hand-merged bead, a member stopped awaiting a human, or a workflow that ran to
completion.

Reconcile narrows that count through a real observation rather than a guess:
`belayd_fleet_reconcile` with `pruneDeadMembers: true` removes members whose
orchestrator is proven absent — no fresh worktree lease **and** no process carrying
the exact `belayd-<taskId>` token. The lease is primary because a pi-web
orchestrator is a session inside the daemon and never appears in the process table
(`docs/fleet-reconcile.md`). A live supervisor may prune — its liveness is not a
precondition — while `unknown` liveness (unreadable `/proc`, unreadable lease) is
never treated as gone. Pruning does not change the arithmetic: the launch count
reads each member's liveness on every launch (bd-166), so an `absent` member is
already free and pruning only removes its record. A run narrows the count the same
way: landing a member prunes it. A **stopped** member is still recorded and is
counted only while its evidence says `live` or `unknown`: stopped with workflow
state and no lease/process is `absent` and gives its slot back (bd-166), stopped
with a live retry session keeps it, and a stopped member that never started (a bare
worktree) is `unknown` until `belayd_fleet_release <taskId>` gives the slot back.

### What is deferred vs automatic

| Decision | Automatic? |
|----------|-------------|
| Reading bd's blocking edges | yes (one read-only call per launch) |
| Ordering into waves | yes (pure function) |
| Refusing a dependency cycle | yes (nothing is created) |
| Starting wave 0 up to free capacity | yes |
| Recording the deferred members + reasons | yes (`fleet.json` `deferred`, `audit.log`, report) |
| Starting wave 1+ | yes in a **run** (P5 tick → `belayd_fleet_advance`'s engine); **no** in `--manual` (explicit tool call) |
| Merging a finished member | yes in a **run** (P5 tick → the P2 queue); **no** in `--manual` (`belayd_fleet_merge`) |
| Accepting (close bead + remove worktree) | yes in a **run** with `accept: true` (opt-in, bd-158); never by `belayd_fleet_merge` itself |
| Pausing / resuming | **no** — P4's `belayd_fleet_pause` / `belayd_fleet_resume` (pause stops the run ticker) |
| Repairing a crashed fleet | **no** — P4's `belayd_fleet_reconcile` |
| Running phases | **never** — the supervisor is not an orchestrator |

## P4: pause, advance, reconcile

P4 is the interruption and repair layer. It introduces no automation and no new
lock: every write goes through the existing compare-and-replace intent path
(`updateFleetIntent`), every queue repair happens under the existing
`merge.lock.d` primitive, and every decision is in `audit.log`.

- **Pause** (`belayd_fleet_pause`) writes `paused` + `note` and fans a `pause`
  note into `events/`. The flag is the enforceable half: launches, merges, and
  advances all refuse while it is set. The `force` variant additionally sends
  SIGTERM to each member orchestrator process it can *positively identify* — and
  refuses when the process table cannot be read. Identification is re-proven
  immediately before each signal: the pid's start time must equal the value read
  at match time and its argv must still carry the exact `belayd-<taskId>` token,
  so a pid that exited and was recycled is skipped (audited per pid as
  `member-stop-skipped`) instead of receiving the signal; a start time that
  cannot be read at match time or at re-verification is `identity-unavailable`
  and is likewise skipped, since argv alone cannot prove the matched identity.
  Each pid is signalled in its own attempt, so one failure cannot abort the rest. It guarantees delivery of
  the signal, not that the process exited, that its phase sub-agents died, or that
  its in-flight writes completed.
- **Resume** (`belayd_fleet_resume`) is the only writer that clears `paused`. It
  also clears the `park` record and its note, except when the park still names a
  stash: then it refuses and names `belayd_fleet_reconcile` (restore the work,
  then unpark). `force` clears the pause and leaves the stash untouched, naming
  the ref. Resuming an already-running fleet is a successful no-op (reported as
  "already running", nothing written, nothing audited), so the documented
  "reconcile, then resume" recovery still succeeds when reconcile already
  unparked the fleet.
- **Advance** (`belayd_fleet_advance`) re-runs the P3 scheduler over the persisted
  `deferred` list. It is an explicit step, not a poller: a background loop would
  be an unsupervised lifecycle making scheduling decisions nobody can audit. A
  dependency wave still only advances once bd stops reporting the blocking edge
  (merging ≠ closing), and the capacity of 3 is re-applied on every advance. An
  advance whose every member is capacity-deferred is a **success** (the plan
  succeeded, nothing failed, the members stay deferred and reported) — exactly
  like a drain that finds nothing queued.
- **Reconcile** (`belayd_fleet_reconcile`) repairs the merge queue, retries a
  parked root restore from the recorded stash sha, and reports supervisor +
  member liveness from the process table. It is idempotent: a second run finds
  nothing to do. The full repair table lives in `docs/fleet-reconcile.md`.

What P4 deliberately does not do: interrupt a running phase cooperatively (only
a signal can stop a member that ignores mail), kill processes it cannot tie to a
member's `belayd-<taskId>` session token, or prune a member whose liveness is
unknown.

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
| `bd` | one batched, read-only `bd show <task ids> --json` for the whole fleet; skipped entirely when no member has a task id. Failures degrade to no bead metadata (one fleet-level warning) |

**Writes**: none. P0 creates no fleet directory, writes no `fleet.json`, no
`audit.log`, no run manifest, and no `.belayd` state.

**Git**: only the two read-only probes above. P0 never runs a mutating git
command (no merge, rebase, stash, checkout, commit, worktree add/remove).

**Process**: no spawns, no gate arming, no `bd` mutation. The only bd invocation
is the read-only `bd show` above; `bd update`, `close`, `label`, `comment`, and
`sync` remain unavailable to the fleet family.

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
| `bead` | one batched `bd show <ids> --json`: `id`, `title`, `status`, `priority`, `labels`; absent when bd is unavailable |
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
| `bead-metadata-unavailable` | the batched `bd show` read failed (no beads database, bd missing, timeout, non-JSON output); emitted once per fleet, never per member |
| `bead-metadata-missing` | the read succeeded but did not answer every expected task id (e.g. bd wrapping records in an envelope, which the parser flattens to none); emitted once per fleet, naming up to 5 missing ids |

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

- `docs/fleet.md` — **operator entry point** for the whole bd-126 surface: the
  end-to-end multi-bead run, the decision table, the failure-recovery table, and
  the shared verification steps (gates, real view, read-only contract,
  determinism, the tests that pin each safety property).
- `docs/fleet-status.md` — operator guide for the P0 tool: invocation, field and
  state decoding, warning triage, and the read-only/determinism verification
  steps.
- `docs/fleet-launch.md` — operator guide for P1: `/fleet`,
  `belayd_fleet_launch`, the mailbox tools, the fleet refusal, and how to verify
  them.
- `docs/fleet-merge.md` — operator guide for P2: `belayd_fleet_merge`, the
  enqueue/drain flow, the root stash/park behaviour, and how to verify it.
- `docs/fleet-reconcile.md` — operator guide for P4: pause/resume (including what
  a forceful pause does and does not guarantee), the explicit advance decision, the
  reconcile repair table, and the member-liveness model.
- `docs/owned-worktree.md` — the bd-119 bead ↔ branch ↔ worktree preflight that
  keeps one gate, one bead, one worktree intact.
- `docs/subagent-sessions.md` — `belayd-<taskId>` orchestrator session naming,
  used to address a member session.
- `docs/planning-implement-workflows.md` — the per-bead workflow the supervisor
  schedules without running.
- `docs/model-capacity-and-telemetry.md` — per-worktree run manifests under
  `.belayd/runs/` and the telemetry the derived view reads.
