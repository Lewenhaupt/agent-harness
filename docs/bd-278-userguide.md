# A hand merge is a landing: git ancestry alone advances the wave (bd-278)

Before bd-278 the run's outside-fleet sweep
(`planOutsideFleetLandings`, `src/fleet-run.ts`) would only record a landing when
**two** facts held: `bd` reported the member's bead `closed`/`done`, **and** `git
merge-base --is-ancestor` proved the member's branch was on the base branch. The
repository's own accept path — `wt merge`, bead left `in_progress` + `human` —
satisfies the second and not the first, so `run.members[].landedAt` was never
written. Every ordering gate a launch created (`src/fleet-ordering-gates.ts`,
bd-158) resolves **only** on `landedAt`, so the blocker's dependents stayed in
`intent.deferred` and the next wave never started. From outside that reads as
"capacity was not released", which is what the fleet in
`proof-of-work-reviewing-platform` looked like on 2026-11-04 (gates `bd-191`
`bd-184 -> bd-185` and `bd-192` `bd-185 -> bd-186`, both open, `bd-185`/`bd-186`
deferred forever).

bd-278 makes **git ancestry the proof of a landing** and drops bead status from
the decision entirely (bead closure is the *acceptance* fact, not an ordering
input). Because `wt merge` deletes the worktree **and the branch**, the sweep now
also keeps a durable handle: `run.members[].head`, the last commit id it saw on a
member branch while that branch was ahead of the base.

| Piece | Where |
| --- | --- |
| `run.members[].head` schema field (optional, so old `fleet.json` parses) | `src/fleet-run.ts` (`FleetRunMemberSchema`) |
| `recordRunMemberHead`, `planOutsideFleetLandings` (handles, not beads), `composeOutsideFleetRunWrite`, `mergeOutsideFleetRun`, `memberLaunchedByThisRun` | `src/fleet-run.ts` |
| Capture, prove, land, pruned member, resolved gate, pre-action write | `extensions/capabilities/fleet.ts` (`captureOutsideFleetHeads`, `memberLandingHandles`, `handleIsOnBase`, `recordOutsideFleetLandings`, `writeOutsideFleetRun`) |
| Reconcile-side landing for a fleet nothing ticks | `extensions/capabilities/fleet.ts` (`landReconciledOutsideFleet`, `needsReconciledLanding`) |
| Dropping recorded gates bd no longer reports | `extensions/capabilities/fleet.ts` (`vanishedRecordedGates`, `reapOrderingGates`, and the pre-plan reap `belayd_fleet_advance` now runs) |
| Deferral/refusal wording that names a **gate**, not a bead | `src/fleet-schedule.ts` (`outsideBlockerDetail`, `FleetScheduleInput.orderingGateIds`) |
| Status wording: closed bead ≠ landing | `src/fleet-status.ts` (`collectStaleBeadWarnings`) |
| Docs | `docs/fleet-run.md`, `docs/fleet.md`, `docs/fleet-status.md`, `docs/fleet-orchestrator.md` |

## How to Verify

### 1. Gates and the bd-278 test set

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm vitest run src/__tests__/extension-fleet-p1.test.ts src/__tests__/fleet-run.test.ts \
  src/__tests__/fleet-status.test.ts src/__tests__/fleet-schedule.test.ts \
  -t "bd-278" --reporter=verbose
```

Real tail of that command in this worktree (`node v24.18.0`, `vitest 3.2.4`; the
extension's `[belayd-harness] registering tools…` stderr banner and the `↓`
skipped lines elided):

```text
 ✓ src/__tests__/fleet-schedule.test.ts > planFleetSchedule: order, waves, capacity > words a stale recorded ordering gate as a gate, not as an outside bead (bd-278) 5ms
 ✓ src/__tests__/fleet-run.test.ts > planOutsideFleetLandings (bd-278) > lands a member git proves is on the base, with no bead status as input 2ms
 …
 ✓ src/__tests__/fleet-status.test.ts > readFleetStatus > bd-278: reports a hand-merged member as landed, never as live work 11ms
 ✓ src/__tests__/extension-fleet-p1.test.ts > fleet supervisor mode > records an outside-fleet landing from reconcile when no tick can (bd-278) 15ms
 …
 ✓ src/__tests__/extension-fleet-p1.test.ts > fleet ordering gates > lands a hand-merged blocker and starts its dependents, closing no bead (bd-278) 19ms
 ✓ src/__tests__/extension-fleet-p1.test.ts > fleet ordering gates > starts a dependent on the very tick that landed the wave's last member (bd-278) 11ms

 Test Files  4 passed (4)
      Tests  35 passed | 508 skipped (543)
```

The committed tests, by what they prove (all in the files above; `-t "bd-278"`
selects every one of them):

| Test | Proves |
| --- | --- |
| `lands a hand-merged blocker and starts its dependents, closing no bead (bd-278)` (`fleet ordering gates`) | AC1 end to end: capture `head` → hand merge (worktree + branch gone, bead `in_progress`) → next tick records `landedAt`, drops `orderingGates`, prunes the member, audits `fleet-landed`, launches `bd-13`; a following `belayd_fleet_advance` refuses with `no deferred members`; no `bd close` and no `bd label` call |
| `starts a dependent on the very tick that landed the wave's last member (bd-278)` | The run-ending shape: one tick lands the last member **and** launches the dependent, and the run stays active (`finishedAt`/`outcome` undefined) instead of finishing `partial` with nothing left to tick |
| `lands a member whose bead is still in_progress after its worktree and branch are gone (bd-278)` | Landing from ancestry alone; audit detail contains `already on main` and `landing happened outside the fleet`; `bd gate resolve bd-900` is called by the fleet; no `bd close` |
| `records the head while the branch is ahead and never overwrites it with the launch point (bd-278)` | `head` captured ahead of the base, then kept when the branch is gone and its commits are on the base |
| `never lands a freshly launched member whose branch sits on the launch point (bd-278)` | Guard: a tip that *is* an ancestor of the base is never stored, never landed |
| `never lands from a live branch whose reset tip is an ancestor of the base (bd-278)` | Guard: a branch name is never a landing proof; a recorded `head` that never reached the base keeps the member |
| `never records a landing from a closed bead whose branch never merged (bd-278)` | Guard: bead status is not an input; the member is kept |
| `captures one head per tick, rotating through unlanded members (bd-278)` | The capture budget: one member per tick, rotating by `run.ticks` |
| `keeps a recorded ordering gate on a rotating tick sweep (bd-278)` | A rotating sweep cannot prove a gate is gone; the record stays and no `bd gate resolve` is called |
| `drops a recorded ordering gate bd no longer reports on a full sweep (bd-278)` | Full sweep drops the record with **no** `bd gate resolve`, audited `ordering-gates-resolved` |
| `keeps a recorded gate when one of its beads could not be read (bd-278)` | Fail-closed: an unreadable answer keeps the record |
| `reaps a stale ordering-gate record on advance so it stops blocking the wave (bd-278)` | `belayd_fleet_advance` reaps its recorded gates before planning; the result no longer says `not part of this fleet` and reports `1/1 member(s) launched` |
| `records an outside-fleet landing from reconcile when no tick can (bd-278)` | `belayd_fleet_reconcile` records the landing for a finished run and reports `landing happened outside the fleet` |
| `leaves a run replaced mid-repair untouched (bd-278)` | The compose refuses to clobber a run a re-arm replaced, and says so |
| `warns when the pre-action landing write fails, and acts on nothing (bd-278)` | Two lost CAS attempts → exactly one notification containing `could not record the outside-fleet landing` at level `warning`; `ticks` stays `1` and only one `head` is on disk |
| `reports a replaced run as an info line, not a write failure (bd-278)` | A run replaced mid-tick → exactly one notification containing `the stored run was left alone` at level `info`; the fresh run (`startedAt 9999`, `ticks 0`) survives |
| `bd-278: reports a hand-merged member as landed, never as live work` (`src/__tests__/fleet-status.test.ts`) | AC2: landed + pruned member renders `members: 0`, `No fleet members`, `counted 0 / free 3`, no warnings; the same `head` without `landedAt` is still `counted 1` with a `stale-member` warning |
| `words a stale recorded ordering gate as a gate, not as an outside bead (bd-278)` (`src/__tests__/fleet-schedule.test.ts`) | Deferral detail: `blocked by ordering gate bd-294, which bd no longer reports; run belayd_fleet_reconcile to drop the stale record and re-plan the wave, or run \`bd gate resolve bd-294\` if bd still lists it` |
| `planOutsideFleetLandings (bd-278)` / `recordRunMemberHead (bd-278)` / `startFleetRun head durability (bd-278)` / `composeOutsideFleetRunWrite (bd-278)` (`src/__tests__/fleet-run.test.ts`) | Unit halves: first proven handle wins; no member is invented; a carried member keeps its honest `launchedAt`/`head`; two concurrent landings merge instead of replacing each other |

### 2. The git half on a real repository (no mocks, no bd)

The decision is pure apart from git, so it reproduces with real git. Save as
`/tmp/bd278/probe.mjs`; it calls only production functions from `dist/`.

```js
// bd-278 record-half probe: real git, production functions from dist/, no mocks, no bd.
// REPO=<this worktree, built> SCRATCH=/tmp/bd278/case1 node probe.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const m = await import(`${process.env.REPO}/dist/src/index.js`);
const SCRATCH = process.env.SCRATCH;
const git = (args) => execFileSync("git", args, { cwd: SCRATCH, encoding: "utf8" });
const show = (label, value) => console.log(`${label}\n${JSON.stringify(value, null, 2)}\n`);
const now = 1_800_000_000_000;
const onBase = async (handle) => {
  try { git(["merge-base", "--is-ancestor", handle, "main"]); return true; } catch { return false; }
};
// The tick's capture rule (captureOutsideFleetHeads): store a tip only when it is NOT on the base.
const capture = async (run, taskId, branch) => {
  const tip = git(["rev-parse", branch]).trim();
  return (await onBase(tip)) ? run : m.recordRunMemberHead({ run, taskId, head: tip, now });
};
const handlesFor = (run) => (taskId) =>
  (run.members ?? []).filter((member) => member.taskId === taskId && member.head).map((m2) => m2.head);

mkdirSync(SCRATCH, { recursive: true });
git(["init", "-q", "-b", "main", "."]);
git(["config", "user.email", "probe@example.com"]);
git(["config", "user.name", "probe"]);
writeFileSync(join(SCRATCH, "README.md"), "base\n");
git(["add", "README.md"]);
git(["commit", "-qm", "init"]);
const launchPoint = git(["rev-parse", "main"]).trim();

git(["checkout", "-qb", "feat/bd-12"]);
writeFileSync(join(SCRATCH, "member.txt"), "the member's work\n");
git(["add", "member.txt"]);
git(["commit", "-qm", "member: deliver the work"]);
const head = git(["rev-parse", "feat/bd-12"]).trim();
git(["checkout", "-q", "main"]);

// 1. Launch: bd-12 is a member, bd-13 waits behind the ordering gate a launch created.
let run = m.startFleetRun({ now, accept: false, members: [{ taskId: "bd-12" }] });
const captured = await capture(run, "bd-12", "feat/bd-12");
show("1. run after the capture tick (head recorded, no landedAt)", captured.members);

let intent = {
  ...m.createFleetIntent({ fleetId: "default", taskIds: ["bd-12"], now, baseBranch: "main" }),
  orderingGates: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-901" }],
  deferred: [{ taskId: "bd-13", reason: "dependency", detail: "waits for bd-12 to land" }],
  run: captured,
};
const write = (next) => {
  intent = next;
  const w = m.writeFleetIntent({ gitCommonDir: join(SCRATCH, ".git"), fleetId: "default", intent: next });
  if (!w.ok) throw new Error(w.error);
};
write(intent);
show("2. orderingGates while bd-12 is still unlanded", intent.orderingGates);

// 3. Hand merge, exactly like `wt merge`: merge, delete the branch, leave the bead alone.
git(["merge", "--no-ff", "-m", "merge feat/bd-12", "feat/bd-12"]);
git(["branch", "-qD", "feat/bd-12"]);
console.log(`3. feat/bd-12 still exists after cleanup: ${git(["branch", "--list", "feat/bd-12"]).trim() !== ""}\n`);

// 4. The next sweep: prove, record the landing, prune the member, drop the gate record.
const proven = await m.planOutsideFleetLandings({ intent, run: intent.run, handlesFor: handlesFor(intent.run), onBase });
show("4. planOutsideFleetLandings (proved by commit id alone)", proven);
let landedRun = intent.run;
for (const entry of proven) landedRun = m.recordRunMemberLanded({ run: landedRun, taskId: entry.taskId, now: now + 15_000 });
let next = { ...intent, run: landedRun };
for (const entry of proven) next = m.pruneLandedFleetMember(next, entry.taskId, now + 15_000);
next = m.dropFleetOrderingGates(next, proven.map(() => "bd-901"), now + 15_000);
write(next);
show("5. run member after the landing", intent.run.members);
show("6. intent after the landing", { taskIds: intent.taskIds, orderingGates: intent.orderingGates ?? null });

// 7. The operator's status view reads that record.
const status = m.readFleetStatus({ cwd: SCRATCH, fleetId: "default", now: now + 30_000 });
if (!status.ok) throw new Error(status.error);
console.log(m.formatFleetStatus(status.value));

// 8. Guard: a freshly launched member's tip is the launch point, which is on the base.
let fresh = m.startFleetRun({ now, accept: false, members: [{ taskId: "bd-14" }] });
git(["checkout", "-qb", "feat/bd-14"]); // no commits: the branch sits on the launch point
fresh = await capture(fresh, "bd-14", "feat/bd-14");
git(["checkout", "-q", "main"]);
show("8. guard — fresh launch point: nothing captured", fresh.members);
show("   guard — and nothing proven", await m.planOutsideFleetLandings({
  intent: { ...intent, taskIds: ["bd-14"] }, run: fresh, handlesFor: handlesFor(fresh), onBase,
}));

// 9. Residual: a landing that rewrote the member's commits (here: cherry-pick, i.e. a replay).
git(["checkout", "-qb", "feat/bd-15", launchPoint]);
writeFileSync(join(SCRATCH, "rewritten.txt"), "same change, new commit\n");
git(["add", "rewritten.txt"]);
git(["commit", "-qm", "member: deliver (pre-rebase)"]);
let rewritten = m.startFleetRun({ now, accept: false, members: [{ taskId: "bd-15" }] });
rewritten = await capture(rewritten, "bd-15", "feat/bd-15");
git(["checkout", "-q", "main"]);
git(["cherry-pick", "feat/bd-15"]);
git(["branch", "-qD", "feat/bd-15"]);
show("9. residual — rewritten commits leave no ancestry proof", await m.planOutsideFleetLandings({
  intent: { ...intent, taskIds: ["bd-15"] }, run: rewritten, handlesFor: handlesFor(rewritten), onBase,
}));
```

```bash
pnpm build
rm -rf /tmp/bd278/case1
REPO=$PWD SCRATCH=/tmp/bd278/case1 node /tmp/bd278/probe.mjs
```

Real output (commit ids differ per run; nothing else does):

```text
1. run after the capture tick (head recorded, no landedAt)
[
  {
    "taskId": "bd-12",
    "launchedAt": 1800000000000,
    "head": "7c0a784f5304980190ecef672b7dd42591595958"
  }
]

2. orderingGates while bd-12 is still unlanded
[
  {
    "blocker": "bd-12",
    "blocked": "bd-13",
    "gateId": "bd-901"
  }
]

3. feat/bd-12 still exists after cleanup: false

4. planOutsideFleetLandings (proved by commit id alone)
[
  {
    "taskId": "bd-12",
    "handle": "7c0a784f5304980190ecef672b7dd42591595958"
  }
]

5. run member after the landing
[
  {
    "taskId": "bd-12",
    "launchedAt": 1800000000000,
    "head": "7c0a784f5304980190ecef672b7dd42591595958",
    "landedAt": 1800000015000
  }
]

6. intent after the landing
{
  "taskIds": [],
  "orderingGates": null
}

Fleet default
  intent: no task ids
  deferred: bd-13 (dependency)
  run: until-complete — 0 tick(s), last tick 2027-01-15T08:00:15.000Z
  members: 0
  states: active=0 blocked=0 awaiting-human=0 interrupted=0 idle=0 complete-unlanded=0 missing-state=0
  capacity: ceiling 3, 3 free, 0 counted

No fleet members: no worktree holds Belayd workflow state.
8. guard — fresh launch point: nothing captured
[
  {
    "taskId": "bd-14",
    "launchedAt": 1800000000000
  }
]

   guard — and nothing proven
[]

9. residual — rewritten commits leave no ancestry proof
[]
```

Steps 1-7 are the record half of a tick with real git: the branch is genuinely
deleted by `git branch -D`, the bead was never read, and `landedAt` appears
anyway. The probe calls `dropFleetOrderingGates` (`src/fleet-state.ts`) for the
record; the real tick resolves the gate in bd first (`bd gate resolve bd-901`) and
then forgets it — that half is what the two `fleet ordering gates` tests assert.

### 3. End to end with a real fleet

The two end-to-end tests drive the real extension against a mocked `bd` and `git`;
here is the same scenario with a real fleet, so you can see the operator's view.

1. Launch a fleet with one dependency edge. `bd-12` must block `bd-13` in bd
   (`bd dep add bd-13 bd-12`), then run `/fleet bd-12 bd-13`. Expect
   `taskIds: ["bd-12"]`, one recorded gate, and the dependent deferred:

   ```json
   "orderingGates": [ { "blocker": "bd-12", "blocked": "bd-13", "gateId": "bd-901" } ]
   ```

   The exact gate id is whatever `bd gate create` minted.

2. Let the member commit. Within a fleet-sized rotation — one unlanded member per
   tick, rotating by `run.ticks` over the sorted member ids, at
   `FLEET_RUN_TICK_INTERVAL_MS` = 15 s — `run.members[].head` appears for `bd-12`
   while `landedAt` is still absent. A tip already on the base is never stored; a
   freshly launched branch *is* on the base, so the first capture after the launch
   commit stores nothing.

3. Hand-merge exactly as you always do, from the repository root:

   ```bash
   wt merge            # or: git merge --no-ff feat/bd-12, then remove the worktree, then git branch -D feat/bd-12
   bd show bd-12 --json   # still "in_progress"
   ```

4. Do nothing else. Within one tick (≤ 15 s + one git probe) the run records the
   landing and starts the wave. What you can read back:

   - `fleet.json` — the member carries `head` and `landedAt`, `orderingGates` is
     gone, `taskIds` is `["bd-13"]`, `deferred` is `[]`, and `bd-13` has a
     `launchedAt`:

     ```json
     { "taskId": "bd-12", "launchedAt": 1792947202544, "head": "7c0a…", "landedAt": 1792947309781 }
     ```

   - `audit.log` — `fleet-landed` before `member-launch`, with the wording
     (verbatim from `extensions/capabilities/fleet.ts`):

     ```text
     "detail": "bd-12 was already on main via 7c0a784f5304980190ecef672b7dd42591595958 (landing happened outside the fleet); pruned and gates resolved"
     ```

     and the tick's own line, which is the notification you see:

     ```text
     Fleet default: landed bd-12 — 7c0a784f5304980190ecef672b7dd42591595958 is already on main (landing happened outside the fleet); pruned and gates resolved
     ```

   - `belayd_fleet_status` — the landed member is not listed at all
     (`members: 0` for a fleet whose only member landed, `No fleet members`, and
     `capacity: ceiling 3, 3 free, 0 counted`); once `bd-13` is launched it is the
     only member counted, and the landed member contributes nothing.

5. Confirm the two things that are *not* needed: no `bd close` and no hand
   `bd gate resolve`. The fleet calls `bd gate resolve bd-901` itself as part of
   the landing (it may call it twice on the same tick — the landing's resolve and
   the orphan reap of the record that write left behind; `bd gate resolve` is
   idempotent), and neither bead is closed or relabelled by the fleet. A hand
   `belayd_fleet_advance` after the fact refuses:

   ```text
   fleet `default` has no deferred members; nothing to advance (a launch that fits within the ceiling defers nobody)
   ```

### 4. Guards — what keeps a false landing out, and the test that proves it

| Guard | Behaviour | Test |
| --- | --- | --- |
| Freshly launched member | Its branch sits on the launch point, which is an ancestor of the base by construction. A tip that is already on the base is never stored as `head` and never lands the member | `never lands a freshly launched member whose branch sits on the launch point (bd-278)`; probe step 8 |
| Branch reset onto an older commit | A branch name is a movable name, so it is never a landing proof. Only `member.head` and a repair round's `head` are probed; a recorded commit that never reached the base keeps the member | `never lands from a live branch whose reset tip is an ancestor of the base (bd-278)` |
| Closed bead, branch never merged | Bead status is not an input to the landing decision, so nothing is recorded and the gate stays | `never records a landing from a closed bead whose branch never merged (bd-278)` |
| Capture overwriting a real head | A later tick that sees the launch point does not replace the recorded ahead tip | `records the head while the branch is ahead and never overwrites it with the launch point (bd-278)` |
| Storing a head for a non-member | `recordRunMemberHead` never synthesises a member (that would invent a `launchedAt`, a start grace, and liveness for work this run never launched) | `recordRunMemberHead (bd-278) > never invents a member for an id the run did not launch (bd-278)` |
| Unreadable bd / git answer | Fails closed: an unanswered probe is "not landed", and a recorded gate is kept when one of its beads could not be read | `keeps a recorded gate when one of its beads could not be read (bd-278)` |
| Rotating sweep dropping a gate | A rotating tick sweep queries one bead and cannot prove a gate is gone, so the record stays | `keeps a recorded ordering gate on a rotating tick sweep (bd-278)` |
| Re-arm not reopening the grace window | A carried member keeps its real `launchedAt` (earlier than the new run's `startedAt`), so it is not declared missing on the new run's first tick | `src/__tests__/fleet-run.test.ts` `W-2: does not declare an inherited member missing on the first tick after a re-arm` and `W-2: memberLaunchedByThisRun compares the record with the run's own start` (these two carry `W-2`, not `bd-278`, in their names — select them with `-t "W-2"`) |
| A crashed reconcile not resurrecting a stale run | `composeOutsideFleetRunWrite` refuses when the stored run was replaced, and reconcile reports it | `leaves a run replaced mid-repair untouched (bd-278)`, `leaves a replaced run untouched instead of clobbering it` |

## How to Use

### After a hand merge: nothing

`wt merge` (or `git merge` + worktree removal + branch deletion) is now a
complete hand-off. The next tick records the landing, resolves that member's
ordering gates in bd, prunes the member (out of `taskIds`, out of `deferred`, out
of `released`), frees the capacity slot, audits `fleet-landed`, and — because the
landing is written to `fleet.json` **before** the tick executes its own action —
launches the dependents on that same tick. That last point is the difference
between "the dependent starts" and "the run finishes `partial` with the dependent
deferred and no tick left to start it" (the run-ending shape bd-278 also fixed).
You do not run `belayd_fleet_advance`, you do not `bd close`, you do not
`bd gate resolve`.

Keep closing the bead when *you* accept the work — that is still your call, and a
closed bead still reaps its gate record through the pre-existing
`reapClosedBeadGates` path. It is simply no longer required for ordering.

### When the supervisor is dead

Nothing ticks a finished or orphaned run, so the recovery is reconcile. From any
session once the fleet is provably dead:

```text
belayd_fleet_reconcile { "fleetId": "<id>" }
```

It records the same ancestry-proven landing a tick would (when the run is
inactive, or the named fleet's supervisor is provably dead), notifies the landing
line, and then reaps the ordering-gate records — including records for gates bd no
longer reports. Add `"pruneDeadMembers": true` only for members whose
orchestrator is provably gone; `unknown` liveness is never pruned. Then re-arm
(`/fleet <ids> --fleet <id>`) if the wave still has work: re-arm carries a
surviving member's `head` into the new run so the capture rotation can refresh it.

### When `bd gate resolve <gate-id>` is still needed

Only as the manual fallback: bd still lists the gate, the fleet's resolve failed
transiently, and you do not want to wait for the next tick/advance/reconcile. It
drops the record on the following sweep. Glossary for the two failure shapes:

- **A landing happened, bd refused the resolve** — the record stays and the next
  tick retries; audit `ordering-gate-unresolved`.
- **A record whose gate bd no longer has** — `belayd_fleet_advance` and
  `belayd_fleet_reconcile` drop it with no bd call (audit
  `ordering-gates-resolved`, detail `<n> gate(s) bd no longer reports: bd-12->bd-15 (bd-294)`).
  A rotating tick sweep cannot prove absence and keeps it.

### Reading a refusal that names an ordering gate

A recorded ordering gate appears in bd as a blocker **under its own id**, and the
schedule used to call it "a bead outside this fleet", which sends you looking for a
bead dependency that does not exist. Now the deferral detail distinguishes the two
(verbatim from `src/fleet-schedule.ts`):

```text
blocked by ordering gate bd-294, which bd no longer reports; run belayd_fleet_reconcile to drop the stale record and re-plan the wave, or run `bd gate resolve bd-294` if bd still lists it
blocked by bd-191, which is not part of this fleet; it cannot be planned for any wave until that bead lands
```

and the reason line says `blocked by ordering gate(s) bd-294 that bd no longer
reports` instead of `blocked by a bead outside this fleet`. Read the word **gate**
as "fleet-side record, drop it with reconcile"; read **bead not part of this fleet**
as a real outside dependency you must land first.

### What still needs you (residual limitations)

Ancestry proves a landing only when one of the member's *recorded commits* is on the
base. Three shapes therefore still leave a member unlanded, and the broadest
statement the code supports is: reconciliation, release, or a manual gate resolve.

1. **The landing rewrote the member's commits** — a rebase with replay, or a squash
   merge. The recorded `head` is not on the base and the new commits never shared
   its history, so nothing proves the landing. Probe step 9 shows exactly this
   (`[]`). Action: `belayd_fleet_reconcile` if you want the fleet to keep trying,
   `belayd_fleet_release <taskId>` to free the slot, `bd gate resolve <gate-id>` to
   release the dependent's ordering gate.
2. **The hand merge happened before a capture rotation ever saw the branch ahead of
   the base**, and the branch was then deleted. There is no `head`, so there is
   nothing to probe. Action: `belayd_fleet_release <taskId>` for capacity,
   `belayd_fleet_reconcile` for the record, `bd gate resolve <gate-id>` for the
   gate. Capturing earlier is the mitigation, not a guarantee: capture is one
   member per tick.
3. **A `fleet.json` written before this change, or hand-edited, that carries no
   `head`.** Old records still parse (the field is optional), but there is nothing to
   probe: capture will not store a tip that is already on the base, so a merged
   branch that still exists does not land the member either. Treat it as case 2.
   Hand-editing `fleet.json` to add a `head` is not supported — let reconcile record
   it.

Also still yours, unchanged by bd-278: the acceptance decision (`bd close` or not)
and the bead's status; a closed bead whose branch never merged keeps its ordering
gate and is **not** landed. `belayd_fleet_status` reports it as a `stale-member`
with `acceptance is not a landing — release the slot with belayd_fleet_release <id>,
or record the landing with belayd_fleet_reconcile, since only a recorded commit id
on the base branch proves one`.

### Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| A member you merged stays listed in `belayd_fleet_status` | No recorded `head` (capture never saw the branch ahead, or the record predates bd-278), or the probe has not run since the merge | Wait one tick; if `run.members[].head` is missing, case 2 of the residual list: `belayd_fleet_reconcile` (record) and/or `belayd_fleet_release <taskId>` (capacity). A recorded member whose worktree is gone and which is not landed shows as a `stale-member` warning with `no worktree holds feat/<taskId>` — that is not a landing |
| An ordering gate stays open (`ordering gates open: bd-12 -> bd-13 (gate bd-901) — resolved when the blocker lands`) | The blocker has not landed *as far as the record proves*, or the resolve hit a transient bd failure | Nothing while the blocker works. After it landed: next tick retries; `belayd_fleet_advance`/`belayd_fleet_reconcile` reap first; if bd still lists the gate, `bd gate resolve bd-901` |
| `deferred` never clears | The dependent is blocked by a real bead outside the fleet, or by a recorded gate whose record is stale | Read the deferral `detail`: "ordering gate" → `belayd_fleet_reconcile`; "not part of this fleet" → land that bead first; `capacity` → wait or `belayd_fleet_release` |
| The run finished `partial` with the dependent deferred and the blocker landed | Pre-bd-278 shape: the landing was written only at the end of the tick, so the same tick re-deferred the dependent and had no successor | Re-arm (`/fleet <ids> --fleet <id>`) so a new run record starts, or `belayd_fleet_advance` the deferred member directly. With bd-278 the landing tick launches the dependent itself |
| Warning `Fleet default: could not record the outside-fleet landing: <error>` | A real `fleet.json` write failure (two lost compare-and-replace attempts). The tick **acted on nothing** — the landing was not recorded | Fix the write (permissions, disk, a concurrent writer) and let the next tick re-sweep. `ticks` did not advance, so nothing was launched on the unrecorded landing |
| Info `Fleet default: did not write the outside-fleet landing record (the stored run was replaced); the stored run was left alone` | A re-arm or relaunch replaced the run while the sweep was running — the compare-and-replace doing its job, not a failure | Nothing: the fresh run's own tick captures and proves. The same line with `(a supervisor resumed the stored run)` comes from a reconcile pass that left a resumed run alone |
| `belayd_fleet_advance` succeeds but nothing launches | `no deferred members` — the landing tick already launched the wave, or nothing was deferred | Nothing; the wave is already running |
