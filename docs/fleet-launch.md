# Fleet launch and mailbox (`/fleet`, bd-126 P1)

One operator command — `/fleet bd-12 bd-15` — that turns several beads into
concurrent Belayd workflows, each in its own worktree, and gives the supervisor
session a two-way file mailbox to the members it launched. The supervisor is a
**scheduler**: it arms no process gate and refuses to run phases.

This is milestone **P1** of `docs/fleet-orchestrator.md`, extended by **P3**
(ordering, waves, capacity-aware launch). P2 (the single-flight merge queue) and P4
(pause, explicit advance, crash reconcile) are separate surfaces — see
`docs/fleet-merge.md` and `docs/fleet-reconcile.md`. Launch never merges, pauses, or
mutates a bead, and it starts wave 2+ only when you ask it to. For the whole
operator story in one page — which tool for which situation, and how to get out of
each failure — start at **`docs/fleet.md`**.

- [How to Use](#how-to-use)
  - [When to reach for it](#when-to-reach-for-it)
  - [How to invoke it](#how-to-invoke-it)
  - [Reading the launch report](#reading-the-launch-report)
  - [Ordering, waves, and capacity (P3)](#ordering-waves-and-capacity-p3)
  - [The fleet refusal](#the-fleet-refusal)
  - [Talking to members](#talking-to-members)
  - [What it will not do](#what-it-will-not-do)
  - [Common situations](#common-situations)
- [How to Verify](#how-to-verify)
  - [1. Gates](#1-gates)
  - [2. Drive the tools against a scratch fleet](#2-drive-the-tools-against-a-scratch-fleet)
  - [3. The tests that pin it](#3-the-tests-that-pin-it)

## How to Use

Everything below is operator-facing: how to start a fleet, how to read what comes
back, how to message members, and what the supervisor will refuse to do.

### When to reach for it

| Situation | Reach for |
|-----------|-----------|
| "Run these three beads in parallel; tell me when each is done." | `/fleet bd-12 bd-15 bd-19` |
| "Add one more bead to the fleet I am supervising." | `/fleet bd-22`, or `belayd_fleet_launch` |
| "I restarted pi; recover supervision of my fleet without relaunching the beads." | `/fleet bd-12 bd-15 --fleet <id>` (re-arm) |
| "What is everyone doing?" | `belayd_fleet_status` (P0, read-only) |
| "Tell bd-15 that main moved and it should rebase." | `belayd_fleet_note` (`kind: rebase-hint`) |
| "Tell every member" | `belayd_fleet_note` with `to: "all"` (fanned out per member) |
| "Did any member report back?" | `belayd_fleet_inbox` |
| "I want to merge bd-12 to main." | P2: `belayd_fleet_merge` (`enqueue`, then `drain`) — see `docs/fleet-merge.md` |

A fleet session is normally the repository **root** (the only checkout that may
hold `main`), because P2's merges happen there.

**One session per fleet (W-B).** A session supervises at most one fleet. Ask it to
launch a second fleet and the launch is refused (`already supervises fleet …`)
before any write; otherwise its in-memory arm would be replaced while the first
fleet's record still named it, wedging that fleet's inbox. If a launch writes and
verifies its supervisor record, the session stays armed even when every member
failed (the record now carries its new token); a refused launch leaves any
existing arm untouched.

### How to invoke it

```
/fleet bd-12 bd-15 [bd-19] [--fleet <id>] [--concurrency <n>]
```

| Argument | Meaning |
|----------|---------|
| task ids | Beads to run as members. At least one. Every id must be valid, unique in the request, and not already a member of a **live** fleet. Ids that are already members of *this* fleet, whose supervisor is not running, are preserved (re-arm). |
| `--fleet <id>` | Fleet directory name under `<git-common-dir>/belayd/fleet/`. Default `default`. Sanitized (anything outside `A-Za-z0-9._-` becomes `_`). |
| `--concurrency <n>` | Requested concurrent orchestrators. **Capped at 3**; a larger value is clamped and the report says so, and a fraction is floored and reported. Only the free capacity starts now (see [P3](#ordering-waves-and-capacity-p3)). |

The tool form takes the same request:

```json
{ "tasks": ["bd-12", "bd-15"], "fleetId": "night", "concurrency": 3 }
```

Both entry points share one engine, and both arm no gate.

**Re-arm.** If the supervisor process is gone, run `/fleet` again in the new
session with the fleet's existing ids (`/fleet bd-12 bd-15 --fleet <id>`, or just
`/fleet bd-12`): the supervisor record is rewritten, the existing members are
preserved (not relaunched), and new ids in the same call are launched normally.
A fleet another **live** session is supervising is refused instead, naming that
session.

### Ordering, waves, and capacity (P3)

Before anything is written, the launch reads bd's blocking edges once
(`bd show <ids> --json --brief-deps`, read-only) and plans the members:

- **Order** — a member blocked by another member in the same request goes into a
  later wave, regardless of the order you typed. Only bd's `blocks` relationship
  is an ordering edge; `related` links and already-`closed` blockers are not. If
the graph cannot be read (no bd, timeout, non-JSON), the launch still runs in
  your order and warns that ordering was skipped.
- **Cycle** — if the edges form a cycle, the launch is refused with the cycle path
  (`bd-12 → bd-15 → bd-12`) and nothing is created. Break it with
  `bd dep remove` first.
- **Capacity** — the ceiling is 3 concurrent **orchestrators**, and orchestrators
  already running count against it: `slots = 3 - active`. Only wave 0 up to
  `slots` starts now. `active` counts the recorded members of **every** fleet,
  whatever its supervisor's liveness: a detached member orchestrator keeps running
  after the supervisor that launched it dies, so a dead-supervisor fleet is not
  free capacity. If any fleet's `fleet.json` cannot be read the count is unknown
  and the whole launch is refused — under-counting is the unsafe direction. The
  count is re-read **inside** the intent's compare-and-replace and the launch is
  refused (nothing recorded, nothing started) if a concurrent launch spent the
  planned slots in the meantime; there is no fleet-wide lock, so two launches from
  *different* fleets at the same instant can still both write from their own
  pre-launch reads — see
  [the capacity accounting note](fleet-orchestrator.md#capacity-accounting).
  `belayd_fleet_reconcile` with `pruneDeadMembers: true` is how you narrow that count after a
  crash, using the process table rather than an assumption.
- **Deferred** — everything else is deferred, never dropped: ready-but-no-slot
  members are `capacity`, later-wave members are `dependency`, and members
  blocked by a bead outside this launch are `external-blocker`. Each one is
  listed in the report, audited (`member-deferred` / `capacity-blocked`), and
  recorded in `fleet.json` `deferred` with its reason. A launch (or advance) that
  starts nothing because every slot is busy is a **success** (exit 0): the plan
  was made, nothing failed, and the members stay deferred and reported — the same
  "nothing to do is not an error" rule the merge drain applies to an empty queue.
- **Deferrals persist, and they union.** A launch that adds members restates the
  plan it just computed but keeps every earlier deferral it did not schedule, and
  a launch whose wave 0 is empty (all slots busy) still writes the deferred plan.
  So a waiting member is never invisible: `belayd_fleet_status` renders
  `deferred: <id> (<reason>)`, and `belayd_fleet_advance` uses the list as its
  worklist.

**What is not automatic:** advancing a wave. When a blocker lands, advance
(`belayd_fleet_advance`) or launch the waiting members explicitly (`/fleet
bd-15`). Waves are never advanced by a background loop. A dependency wave still
only becomes eligible once bd stops reporting the blocking edge — merging a
sibling's branch is not closing its bead.

Example — `bd-15` is blocked by `bd-12`, and two other orchestrators are already
running:

```
Fleet `default`: 1/2 member(s) launched (maxConcurrent 3).
Scheduling: 1 member(s) now, 1 deferred (capacity 3, 2 already active, 1 free slot(s)).
- wave 0 (now): bd-12
- wave 1 (later launch): bd-15
- deferred bd-15 (dependency): wave 1: waits for bd-12 to land (launched by a later fleet launch or by belayd_fleet_advance)
- bd-12: launched (feature) — worktree `feat/bd-12`, orchestrator session <id>
Later waves are a plan, not a promise: this call launches only wave 0 up to capacity. Advance a later wave explicitly with belayd_fleet_advance (there is no background poller).
…
```

### Reading the launch report

```
Fleet `default`: 2/3 member(s) launched (maxConcurrent 3).
Concurrency 5 is above the ceiling of 3 orchestrators; stored 3.
- bd-12: launched (feature) — worktree `feat/bd-12`, orchestrator session <id>
- bd-15: launched (bugfix) — worktree `feat/bd-15`, orchestrator session <id>
- bd-19: NOT launched — Worktree creation failed. …
Removed bd-19 from the fleet intent, so a later launch can retry it. The remaining members are unaffected.
Members are detached orchestrators; this session supervises them. It runs no phases and owns no worktree — use belayd_fleet_status, belayd_fleet_note, and belayd_fleet_inbox.
```

What each line means:

| Line | Meaning |
|------|---------|
| `N/M member(s) launched` | members actually started / members requested |
| `Fleet … re-armed — supervisor record rewritten` | an existing fleet with a dead supervisor was recovered; new ids (if any) launched, existing ones preserved |
| `Preserved existing member(s): …` | those members were **not** relaunched (their worktrees and orchestrators still exist) |
| `Concurrency X is above the ceiling of 3` | the request was clamped; `fleet.json` stores 3 |
| `Concurrency X is not a whole number` | the fraction was floored; `fleet.json` stores the floored value |
| `Concurrency X is not a positive whole number` | the value was ignored; the ceiling was stored |
| `- <id>: launched (<type>)` | worktree + handoff packet + workflow state + orchestrator session created |
| `- <id>: NOT launched — <reason>` | that member failed; the others are unaffected |
| `Scheduling: N member(s) now, M deferred` | P3 plan: what started, what waits, and the capacity arithmetic behind it |
| `- wave N (now / later launch): …` | the planned order; wave 0 is the only one this call launches |
| `- deferred <id> (<reason>): …` | why that member did not start (`capacity`, `dependency`, `external-blocker`) |
| `Removed <ids> from the fleet intent` | failed ids were pruned so they are retryable and do not show up as phantom members |

**Failure semantics (chosen):** the fleet proceeds. A member failure never aborts
the others; it is reported per member, audited (`member-launch-failed`), and the
id is removed from the intent. The tool exits non-zero only when the request was
refused or no member launched at all.

A refusal is different from a failure: it happens **before anything is created**,
lists every problem at once, and leaves no fleet directory, no intent, no
worktree, and no session behind.

### The fleet refusal

After `/fleet`, this session is the fleet supervisor. It arms no gate and refuses
the phase tools (`belayd_plan`, `belayd_implement`, `belayd_commit`, …),
`belayd_proof_verifier`, `belayd_start_task`, `belayd_start_followup`, and
`belayd_stop_task`:

> Fleet supervisor sessions do not run phases: this session schedules fleet
> `default` and owns no worktree, so `belayd_commit` is refused. Observe members
> with belayd_fleet_status, add members with belayd_fleet_launch, message them with
> belayd_fleet_note, and read their reports with belayd_fleet_inbox — each phase
> runs in the member orchestrator that owns that bead's worktree.

Fleet mode is **derived from `fleet.json`** on every check. The supervisor record
carries the session id, the pid, that pid's `/proc` start time, and a per-arming
token held only in the arming session's memory. So:

- a stale record from a dead process cannot put a new session into fleet mode;
- a recycled pid does not match (the recorded start time differs);
- pid 1 / kernel-thread pids are never accepted as a supervisor;
- a hand-written or planted `fleet.json` that names your session and a live pid
  still does not match, because it cannot carry the token you minted;
- a restarted supervisor session must re-arm with `/fleet`, which rewrites the
  record and mints a new token;
- deleting `fleet.json` un-arms it immediately.

The refusal never replaces the bd-119 ownership preflight: a member worktree
whose `.belayd/workflow.json` belongs to another bead still gets the bd-119
message, because a gated session is never a supervisor.

### Talking to members

`belayd_fleet_note` writes one note (or one broadcast); direction follows the
sender.

| Field | Meaning |
|-------|---------|
| `to` | a member task id, `supervisor`, or `all` (every member). Validated: a supervisor note must name a live member (launched **or deferred** — mail queued for a member before its wave starts is delivered at its first turn) or `all`; a member note must name `supervisor` |
| `body` | bounded text (truncated to 2000 characters) |
| `kind` | `note`, `rebase-hint`, `base-moved`, `sibling-landed`, `pause`, `resume` (default `note`) |
| `channel` | `inbox` (member → supervisor) or `events` (supervisor → member); defaults by direction. A member cannot use `events` |

`to: "all"` is **fanned out at write time**: the supervisor gets one file per
member (same body, addressed to that member), so each member receives it exactly
once under the ack protocol. A single shared `all` file could not do that — the
first member to ack would delete it for everyone. A partial fan-out is audited
with the recipients whose files were **actually written** (W-A), never with the
intended set.

**One session per member worktree (S1).** Member delivery keys on the task id in
the worktree's `.belayd/workflow.json`, because pi exposes no ownership relation
between sessions. Two sessions opened in the same member worktree would both
drain and ack that member's mail — bd-119 pins a worktree to one bead and the
launch now refuses a worktree already driven, so keep one orchestrator per
worktree.

`belayd_fleet_inbox` (supervisor only) drains `inbox/`, returns the notes, and
acknowledges them. The rendered block frames them as **member reports, not
supervisor instructions** (S3), mirroring the member-side event framing. Delivery
is at-least-once: a note is removed only after the call consumed it, so a
forgotten ack replays the note instead of losing it. The notes are **rendered
before** the ack, so a partial ack failure still shows every consumed body and
states exactly how many notes remain queued.

Member delivery is automatic: before a member's turn starts it drains `events/`
and gets a `belayd-fleet-events` message containing the notes addressed to it.
The block is bounded (at most 8 notes and 3000 characters per turn — the rest
says "still queued" and waits on disk; the character bound also applies to the
first note, and a legal note fits because bodies are capped at 2000 characters,
S2), and is **acknowledged at the end of the turn**, after the model has read it
(`agent_end`). A crash before that point
replays the notes: events are at-least-once, so a repeat is the same event, not a
new one. A note in `events/` that was not written by the supervisor is never
injected (the block counts it and leaves it on disk).

### What it will not do

- **No merges, no rebases of siblings, no pause** — launch does none of these;
  merging is the separate P2 surface (`docs/fleet-merge.md`), pausing and repairing
  are P4 (`docs/fleet-reconcile.md`). Ordering/capacity is P3 and stops at the
  plan: wave 2+ is advanced explicitly, never by a background loop.
- **No launch that would start a member while the fleet is paused.**
  `belayd_fleet_pause` writes `paused` into `fleet.json`, and a request that would
  actually launch something refuses until `belayd_fleet_resume` clears it. A pure
  re-arm is the one exception: it starts nothing, so it still works while paused —
  that is the path back to a supervised fleet.
- **No bead mutation.** The fleet family never changes a bead's status, labels, or
  notes; merging ≠ closing stays true in P2 too.
- **No phases.** The supervisor never runs one, and it cannot arm a gate.
- **No cross-tree reach from the phase family.** Phase tools, the proof verifier,
  and the commit path are unchanged; only the fleet family acts across worktrees.
  Every such action is audited: `launch`, `re-arm`, `member-launch`,
  `member-launch-failed`, `member-pruned`, `note`, `note-partial`,
  `inbox-drain`, `events-acked` (the one exemption is the quarantine rename of a
  corrupt or oversize note during a drain, documented in the design record). P2
  adds the `merge-*`, `base-moved`, `sibling-landed`, `rebase-hint`, and
  `fleet-parked` actions; the full table is in `docs/fleet-orchestrator.md`.
- **No phantom members.** A member that failed to launch is removed from the
  intent, not left behind for `belayd_fleet_status` to warn about forever.
- **No re-launch of a live member.** An id that is already a member of a **live**
  fleet is refused (`already a member of fleet …`), because two orchestrators on
  one bead is exactly the invariant bd-119 exists to protect. A member of a fleet
  whose supervisor is dead is either preserved by a re-arm of *that* fleet or
  refused with a split-brain message — never silently launched into a second one.

### Common situations

| Symptom | Cause / action |
|---------|----------------|
| `Fleet launch needs a git repository: …` | `/fleet` was run outside a git checkout (or `git` is unavailable). Run it in the repository root. |
| `- bd-12: NOT launched — Worktree creation failed…` | `wt` (Worktrunk) is missing or the directory could not be created. The id was pruned, so `/fleet bd-12` can retry it. |
| `- bd-12: NOT launched — Session daemon rejected the orchestrator request…` | the pi-web session daemon is not running. The fleet intent and audit still record the attempt. |
| `already a member of fleet \`default\`, supervised by live session …` | that bead is in a live fleet already. P1 has no member removal; re-arm that fleet, or prune a provably-dead member with `belayd_fleet_reconcile` and `pruneDeadMembers: true`. |
| `already driven by a standalone orchestrator … use that orchestrator's session, or re-arm the fleet` | a worktree for that bead already has same-task `.belayd/workflow.json` (a `/belayd` launch, even a dead one). Launching a fleet member there would put two orchestrators on one bead. Use that session, or re-arm *this* fleet (a re-arm preserves the member). W-D |
| `this session already supervises fleet \`default\` …` | one session supervises one fleet. Keep scheduling `default`, or launch the other fleet from a different session. W-B |
| `already a member of fleet \`x\`, whose supervisor is not running… re-arm that fleet` | the bead belongs to a dead fleet. Run `/fleet <its ids> --fleet x` there instead of launching it into a second fleet — otherwise its notes go to a mailbox no live supervisor drains. |
| `fleet \`default\` is already supervised by live session …` | another pi session is running that fleet. Let it keep scheduling, or stop it, then re-arm. Nothing was changed. |
| `The fleet intent … did not read back …` | another writer replaced `fleet.json` between the write and the read-back. Re-run `/fleet`; the session did not arm. |
| `This session supervises fleet \`default\`, not \`night\`` | you passed a `fleetId` the session does not supervise. |
| `belayd_fleet_inbox is supervisor-only` | this session is not the live supervisor (e.g. you resumed it after a restart, or the record belongs to another session). Re-arm with `/fleet`. |
| `\`bd-51\` is not a member of this fleet; known members: …` | the `to` address is a typo. Nothing was written. |
| `events/ is supervisor-only` | a member tried `channel: "events"`; members write to `inbox/` and address `supervisor`. |
| a member never sees an event | check `to`: only its own task id reaches it; a sibling's note stays on disk. A broadcast is fanned out per member at write time. |
| the same note appears twice | at-least-once delivery: the previous turn injected it but its `agent_end` ack did not run (crash/error). Treat repeats as the same event. |

## How to Verify

### 1. Gates

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build
```

### 2. Drive the tools against a scratch fleet

Before launching members, confirm the *read* side (P0) sees the fleet:

```bash
belayd_fleet_status            # should show the members and their derived state
```

After `/fleet`, inspect what it created — this is the whole cross-tree footprint:

```bash
d=$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet/default
ls -1 "$d"                     # fleet.json audit.log (inbox/ events/ appear on first note)
cat "$d/fleet.json"            # taskIds, maxConcurrent (<= 3), supervisor { sessionId, pid, pidStartTime, armToken }
cat "$d/audit.log"             # one launch line + one line per member attempt
```

Then message a member and watch it arrive:

```text
belayd_fleet_note { to: "bd-15", body: "main moved; rebase before review", kind: "rebase-hint" }
```

That writes `$d/events/<to>-rebase-hint-<ts>-<hash>.json`. The member's next turn
carries a `belayd-fleet-events` message; after that turn ends (the `agent_end`
ack) the file is gone. A second turn shows nothing.

`to: "all"` writes one file per member in `$d/events/` (same body, different
recipient), not a single shared file.

Re-arm check: stop the supervisor process, then run `/fleet bd-12 bd-15` again in
a fresh session. The report says `re-armed`, `fleet.json` keeps the same
`taskIds`, the supervisor record is rewritten (new session/pid/start time/token),
`audit.log` gains a `re-arm` line, and no member session is spawned again.

Ordering/capacity check: in a scratch fleet, make `bd-15` depend on `bd-12`
(`bd dep bd-12 --blocks bd-15`), then launch both in one `/fleet`. The report's
`Scheduling:` block lists `wave 0 (now): bd-12` and `wave 1 (later launch):
bd-15`; only bd-12 has a worktree/session, and `fleet.json` `deferred` names
bd-15 with reason `dependency`. Ask for five beads at once and only three start —
the rest are `capacity` deferrals. Introduce a cycle
(`bd dep bd-15 --blocks bd-12`) and the launch is refused with the cycle path and
writes nothing (`ls $d` shows no new files).

Refusal check: in the supervisor session, calling `belayd_plan` (or
`belayd_commit`) is blocked with the fleet message above, and `belayd_status`
reports no gate.

### 3. The tests that pin it

| File | What it pins |
|------|--------------|
| `src/__tests__/fleet-mode.test.ts` | supervisor matching (session, pid floor, start time, arm token), dead-pid/wrong-session/reused-pid/planted-record rejection, directory-name fleet ids, refusal wording and tool membership |
| `src/__tests__/fleet-launch.test.ts` | concurrency clamp/floor/ignore, full validation (invalid, duplicate, live member, worktree conflict, live-supervisor takeover), re-arm (preserved members, ceiling/paused/note kept), split-brain refusal, `/fleet` parsing, intent merge (including deferral union across launches), report rendering, read-back refusal; the engine's zero-side-effect refusal, happy path, per-member failure + prune, and audit lines; P3 scheduling (capacity deferral + `fleet.json` `deferred` + `capacity-blocked` audits, a fully deferred plan still recorded, dependency wave ordering with `member-deferred`, cycle refusal with zero side effects, unreadable-graph degradation, active-orchestrator accounting across abandoned fleets, unreadable-intent refusal), the paused-launch refusal, and the `advance` audit origin |
| `src/__tests__/fleet-schedule.test.ts` | the pure scheduler: caller order, wave levels, capacity subtraction, external blockers (direct and propagated), cycle path refusal (including self-dependency), determinism under edge permutation, duplicate/unusable input; and the `--brief-deps` parser (only `blocks`, finished blockers dropped, external blockers kept, malformed/unreadable degradation) |
| `src/__tests__/fleet-beads.test.ts` | the read-only bd seams: one batched `show`, the read-only argv guard before any spawn, `--brief-deps` for the dependency graph, and degradation on bd failure/non-JSON |
| `src/__tests__/fleet-mailbox.test.ts` | note construction, inbox rendering (including a partial ack), recipient resolution for broadcast/member/typo, addressed scoping, supervisor-only events, count and character bounds |
| `src/__tests__/fleet-state.test.ts` | the mailbox/queue substrate: per-recipient fan-out (both members, either drain order, each acked once), partial fan-out reporting, partial ack reporting, max-size legal note round-trip, address bound, non-finite timestamp safety, quarantine-failure escalation, note-kind type guard, merge-queue compare-and-replace |
| `src/__tests__/extension-fleet-p1.test.ts` | the real extension surface: tool/command registration, fleet refusal for phase/proof/commit/start_task, unaffected normal session, stale record, planted record, bd-119 preserved for a member, `/fleet` (empty ids, no repo, real launches, audit, re-arm, live-takeover refusal), mailbox round-trip + partial ack, broadcast fan-out to two members, member `events/` refusal, typo refusal, events injected once and acked at `agent_end` (plus replay when the turn never ends) |

## Related documentation

- `docs/fleet.md` — operator entry point for the whole bd-126 surface: the
  end-to-end run, decision and failure-recovery tables, shared verification.
- `docs/fleet-orchestrator.md` — design record: scheduler architecture, shared
  state layout, locked decisions, milestone table, and the P1 design section.
- `docs/fleet-status.md` — the P0 read-only status view.
- `docs/owned-worktree.md` — the bd-119 preflight the launch reuses for
  bead ↔ branch ↔ worktree identity.
- `docs/subagent-sessions.md` — `belayd-<taskId>` orchestrator session naming.
- `docs/planning-implement-workflows.md` — the per-bead workflow members run.
