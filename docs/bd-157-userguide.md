# A stopped-everything fleet finishes instead of re-planning forever (bd-157)

With every member of a `/fleet` run stopped, `advance` was the wrong action and the
loop kept choosing it. `planFleetTick` (tick order 4) picks `advance` whenever the
deferred list is non-empty and nothing is working — and a run where every member
has stopped has nothing working by definition. The advance re-planned the very
same deferred wave, launched nothing, and re-deferred it. Nothing in the tick
counted that as "no progress", so the identical three audit lines repeated every
15 s until `FLEET_RUN_MAX_IDLE_TICKS` (240 ticks, ~1 hour) halted the run `stalled`.

Observed, on a run whose two deferrals were an `external-blocker` and a
`dependency`:

```text
schedule-planned bd-152,bd-153: wave 0: (none); 2 wave(s); capacity 3, active 0, slots 3
member-deferred  bd-152: external-blocker: …
member-deferred  bd-153: dependency: …
… same three lines, every 15 s, for ~20 minutes, idleTicks 3 → 39 of 240
```

The run's real answer was already decided by the plan: nothing could launch, so it
should have completed `partial` immediately. An hour of subprocess spawns went into
re-deciding it.

bd-157 makes the executor degrade an advance that launched nothing into the action
the plan would otherwise have reached. Everything lives in two places:

| Piece | Location |
|---|---|
| `emptyAdvanceAction` (the decision) | `src/fleet-run.ts:578` |
| `emptyAdvanceTerminal` (the terminal line, bounded to 400 chars) | `src/fleet-run.ts:631` |
| `advanceTickAction` (the tick's advance branch) | `extensions/index.ts:7404` |
| `emptyAdvanceOutcome` (re-reads the intent, then applies the decision) | `extensions/index.ts:7454` |
| Constants | `FLEET_RUN_MAX_IDLE_TICKS = 240`, `FLEET_RUN_TICK_INTERVAL_MS = 15_000`, `FLEET_RUN_ACTION_TICK_INTERVAL_MS = 2_000` (`src/fleet-run.ts:79`, `:98`, `:101`) |

What the advance leaves behind now decides the tick:

| Advance outcome | Tick action |
|---|---|
| `dependency` / `external-blocker` deferrals and **no** `capacity` entry | `complete`, outcome `partial`, in that same tick — one line naming every deferred member with its reason plus every stopped member |
| **any** `capacity` deferral (a mixed `capacity` + `dependency` list included) | `wait`, bounded by the same `FLEET_RUN_MAX_IDLE_TICKS` cap; at the cap, `halt`/`stalled` naming the capacity-blocked members |
| a hard launch-engine refusal (`ok: false`) | `complete` (`partial` whenever anything remains deferred or stopped) carrying the engine's text plus "the wave stays deferred until an explicit `belayd_fleet_advance` or a fresh launch" |
| the post-launch re-read fails **or** `fleet.json` is gone | `stop: true`, no classification, a `run halted — …` line — never a verdict built from the pre-launch deferrals |
| a real launch | unchanged: `acted: true`, `idleTicks` reset to 0, next tick at the 2 s action interval |

## How to Verify

Run everything from the repository root.

### 1. The decisive unit cases

The whole `describe("emptyAdvanceAction")` block, then the two cases that pin this
bug — the first is the reported symptom, the second is the cap that could not fire
before:

```bash
pnpm test src/__tests__/fleet-run.test.ts
```

```text
 ✓ src/__tests__/fleet-run.test.ts (66 tests) 16ms
 Test Files  1 passed (1)
      Tests  66 passed (66)
```

```bash
pnpm exec vitest run src/__tests__/fleet-run.test.ts \
  -t "ends a stopped-everything run on the second tick, not the 240th"
pnpm exec vitest run src/__tests__/fleet-run.test.ts \
  -t "halts a capacity wait at the idle cap instead of re-planning forever"
```

```text
 ✓ src/__tests__/fleet-run.test.ts (66 tests | 65 skipped) 4ms
      Tests  1 passed | 65 skipped (66)      (each)
```

- `ends a stopped-everything run on the second tick, not the 240th`
  (`src/__tests__/fleet-run.test.ts:894`) — chains `planFleetTick` → `advance`,
  then `emptyAdvanceAction` → `complete`/`partial`, `finishFleetRun`,
  `idleTicks 0`, `isFleetRunActive === false`.
- `halts a capacity wait at the idle cap instead of re-planning forever`
  (`:871`) — `wait` below `FLEET_RUN_MAX_IDLE_TICKS`, `halt`/`stalled` at it.

Neighbouring cases worth one run each: `waits on a mixed list, because capacity
can still free` (`:739`), `completes a run with nothing deferred and nothing
stopped`, `tells the operator that a refused wave is still recoverable`.

### 2. The tick loop itself

These drive the real extension ticker with fake timers: a run is started, its only
member is stopped by the 120 s start grace, then the next 2 s tick is observed.

```bash
pnpm exec vitest run src/__tests__/extension-fleet-p1.test.ts -t "not after 240"
pnpm exec vitest run src/__tests__/extension-fleet-p1.test.ts -t "capacity-blocked advance, then halts as stalled"
pnpm exec vitest run src/__tests__/extension-fleet-p1.test.ts -t "disappears while an advance is in flight"
pnpm exec vitest run src/__tests__/extension-fleet-p1.test.ts -t "hard launch refusal instead of waiting"
```

Each prints `Tests  1 passed | 64 skipped (65)`; the resolved case names are
`ends a stopped-everything run as partial on the next tick, not after 240`
(`src/__tests__/extension-fleet-p1.test.ts:2046`),
`waits on a capacity-blocked advance, then halts as stalled at the idle cap`
(`:2130`), `halts when the fleet record disappears while an advance is in flight`
(`:2174`), and `completes on a hard launch refusal instead of waiting out a
capacity block` (`:2105`).

What the first one asserts is exactly the operator-visible fix:

| Field | Value after the empty advance |
|---|---|
| `run.finishedAt` | set (the run ended on the next tick) |
| `run.outcome` | `"partial"` |
| `run.idleTicks` | `0` |
| `run.haltedReason` | absent (this is a finish, not a stall) |
| `schedule-planned` entries for the deferred wave | exactly 1 |
| `member-deferred` entries for `bd-19` | exactly 1 |
| `fleet-run-complete` entries | exactly 1, detail containing `bd-19 (dependency)` |

…and after another 300 s of would-be ticks, still 1 / 1 / 1. The capacity case
asserts `idleTicks` climbs to `FLEET_RUN_MAX_IDLE_TICKS` on a wait, then one
`fleet-run-halted` with `stalled` and `bd-19 (capacity)` in `haltedReason`, and
`idleTicks = 241` on the giving-up tick (the halt must not reset the count that
justified it).

### 3. Manual reproduction — the tick's verdict on a fixture

No fleet, no pi session, no subprocess: the same pure functions the ticker calls,
against a `fleet.json` shaped like the bug report (every member stopped and still
in `taskIds`, which is the bd-156 invariant; two deferrals, one of each reason).

```bash
repo=$PWD
cat > /tmp/bd157-tick.ts <<TS
import { readFileSync } from "node:fs";
import {
  emptyAdvanceAction,
  finishFleetRun,
  planFleetTick,
  recordRunTick,
} from "${repo}/src/fleet-run.ts";

// usage: jiti /tmp/bd157-tick.ts <fleet.json>
const file = process.argv[2] ?? "";
const intent = JSON.parse(readFileSync(file, "utf8"));
const now = Date.now();

// Every member is stopped (bd-156 keeps it in taskIds), so the plan sees nothing
// working and a non-empty deferred list: the tick the bug re-planned forever.
const observations = (intent.taskIds as string[]).map((taskId) => ({
  taskId,
  progress: { kind: "missing" as const, detail: "no workflow state and no phase runs" },
  claim: "absent" as const,
}));

console.log("tick action:", JSON.stringify(planFleetTick({ intent, observations, now, idleTicks: intent.run.idleTicks })));

const degraded = emptyAdvanceAction({
  intent,
  deferred: intent.deferred ?? [],
  idleTicks: intent.run.idleTicks,
});
console.log("degraded:   ", JSON.stringify(degraded));

// The executor's bookkeeping: only a real launch or a completion counts as
// progress, so a wait and the giving-up halt both add one idle tick.
const ticked = recordRunTick({ run: intent.run, now, progressed: degraded.kind === "complete" });
const run =
  degraded.kind === "complete"
    ? finishFleetRun({ run: ticked, now, outcome: degraded.outcome })
    : degraded.kind === "halt"
      ? { ...ticked, haltedReason: \`\${degraded.reason}: \${degraded.detail}\` }
      : ticked;
console.log(
  \`run.ticks=\${run.ticks} idleTicks=\${run.idleTicks} outcome=\${run.outcome ?? "running"} finishedAt=\${run.finishedAt ?? "no"} haltedReason=\${run.haltedReason ?? "none"}\`,
);
TS

root=/tmp/bd157-demo
rm -rf "$root" && mkdir -p "$root/.git/belayd/fleet/default"
F="$root/.git/belayd/fleet/default/fleet.json"
cat > "$F" <<'JSON'
{"schemaVersion":1,"fleetId":"default","taskIds":["bd-148","bd-149"],"createdAt":1761000000000,"updatedAt":1761001500000,"maxConcurrent":3,"baseBranch":"main","deferred":[{"taskId":"bd-152","reason":"external-blocker","blockers":["bd-77"],"detail":"wave 1: waits for bd-77 (not in this fleet)"},{"taskId":"bd-153","reason":"dependency","blockers":["bd-148"],"detail":"wave 1: waits for bd-148 to land"}],"run":{"schemaVersion":1,"mode":"until-complete","startedAt":1761000000000,"updatedAt":1761001500000,"ticks":40,"accept":true,"members":[{"taskId":"bd-148","launchedAt":1761000000000},{"taskId":"bd-149","launchedAt":1761000000000}],"stopped":[{"taskId":"bd-148","reason":"phase-failed","detail":"phase test failed: gate failed","at":1761000900000},{"taskId":"bd-149","reason":"orchestrator-missing","detail":"no workflow state and no lease","at":1761001400000}],"idleTicks":39}}
JSON

node_modules/.bin/jiti /tmp/bd157-tick.ts "$F"
```

Produced (only the `finishedAt` value is machine-specific):

```text
tick action: {"kind":"advance"}
degraded:    {"kind":"complete","outcome":"partial","detail":"nothing launched: bd-152 (external-blocker), bd-153 (dependency) still deferred; 2 member(s) need a human: bd-148, bd-149"}
run.ticks=41 idleTicks=0 outcome=partial finishedAt=1793107091220 haltedReason=none
```

`planFleetTick` still says `advance` — that is the plan, unchanged. The *executor*
is what degrades it, so `emptyAdvanceAction` is the line to read: `complete`,
`partial`, every deferred member named with its reason, then the stopped members.
The record ends with `finishedAt` set, `outcome: "partial"`, `idleTicks` reset to
`0`, and no `haltedReason` — on the next tick, not the 240th.

### 4. The capacity half, and the mixed list

Same fixture, rewritten with `jq`:

```bash
F=/tmp/bd157-demo/.git/belayd/fleet/default/fleet.json
jq '.deferred=[{"taskId":"bd-152","reason":"capacity","blockers":[],"detail":"no free slot: 3 of 3 held by fleet night"}] | .run.idleTicks=239' "$F" > /tmp/bd157-cap.json
jq '.deferred=[{"taskId":"bd-152","reason":"capacity","blockers":[],"detail":"no free slot: 3 of 3 held by fleet night"}] | .run.idleTicks=240' "$F" > /tmp/bd157-cap2.json
jq '.deferred=[{"taskId":"bd-152","reason":"capacity","blockers":[],"detail":"no free slot"},{"taskId":"bd-153","reason":"dependency","blockers":["bd-148"],"detail":"wave 1: waits for bd-148 to land"}] | .run.idleTicks=3' "$F" > /tmp/bd157-mixed.json

node_modules/.bin/jiti /tmp/bd157-tick.ts /tmp/bd157-cap.json
node_modules/.bin/jiti /tmp/bd157-tick.ts /tmp/bd157-cap2.json
node_modules/.bin/jiti /tmp/bd157-tick.ts /tmp/bd157-mixed.json
```

```text
=== capacity only, idleTicks 239 ===
degraded:    {"kind":"wait","detail":"advance launched nothing: bd-152 (capacity) blocked on capacity held by another fleet; the wave launches when a slot frees"}
run.ticks=41 idleTicks=240 outcome=running finishedAt=no haltedReason=none
=== capacity only, idleTicks 240 ===
degraded:    {"kind":"halt","reason":"stalled","detail":"no capacity slot freed in 240 ticks; bd-152 (capacity) still blocked on capacity held by another fleet"}
run.ticks=41 idleTicks=241 outcome=running finishedAt=no haltedReason=stalled: no capacity slot freed in 240 ticks; bd-152 (capacity) still blocked on capacity held by another fleet
=== mixed capacity + dependency, idleTicks 3 ===
degraded:    {"kind":"wait","detail":"advance launched nothing: bd-152 (capacity) blocked on capacity held by another fleet; the wave launches when a slot frees"}
run.ticks=41 idleTicks=4 outcome=running finishedAt=no haltedReason=none
```

Read the third block: a list carrying **both** `capacity` and `dependency` waits,
because capacity is the one reason that frees itself. Only a list with no
`capacity` entry at all completes `partial` — `docs/fleet-run.md` says so in the
tick-order table and in the "advance that launches nothing" paragraph. (Each run
also prints its `tick action:` line first; it is `advance` in all three, which is
the point — the plan did not change, the executor did.)

### 5. The audit trail

The three lines that used to repeat every 15 s collapse into one plan plus one
completion. On the fleet you are inspecting (this resolves the fleet's own
`audit.log`; substitute another fleet id if you use one):

```bash
F=$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet/default/fleet.json
A=$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet/default/audit.log
jq -r .action "$A" | sort | uniq -c
jq -r 'select(.action | test("^(schedule-planned|member-deferred|capacity-blocked|fleet-run-complete|fleet-run-halted)$")) | "\(.action) \(.taskIds | join(",")): \(.detail)"' "$A" | tail -n 6
jq -r 'select(.action == "fleet-run-complete") | .detail' "$A" | tail -n 1
```

The reading is the *count of repeated actions*, not an absolute number: `audit.log`
is append-only and holds the fleet's whole history. For the episode this bead
fixes, the fixed run leaves

| Action | How many for the deferred wave |
|---|---|
| `schedule-planned` | 1 (the advance that launched nothing) |
| `member-deferred` | 1 per `dependency` / `external-blocker` member |
| `capacity-blocked` | 1 per capacity-deferred member (audited separately, `auditSchedule`, `src/fleet-launch.ts:1619`) |
| `fleet-run-complete` | exactly 1, detail starting `partial: nothing launched: …` |

…and stops there. Before the fix the same filter showed a `schedule-planned` plus
one deferral line per deferred member every 15 s, a rising `idleTicks`, and no
`fleet-run-complete` at all until the 240-tick `stalled` halt. Those exact counts
(1 `schedule-planned` for the wave, 1 `member-deferred`, 1 `fleet-run-complete`,
still 1 each after another 300 s) are what the extension test in step 2 asserts on
a real tick — that is the authoritative check; the commands above are how you read
the same evidence on your own fleet. `fleet-run-halted` is the other action to
grep for: on this path it appears at most once (the `stalled` halt), never once
per tick.

### 6. Negative control — the degrade is load-bearing

Revert the no-launch branch in `advanceTickAction` (keep
`acted: outcomes.some((outcome) => outcome.ok)` and drop the
`if (!outcomes.some((outcome) => outcome.ok))` degrade) and all four step-2 cases
fail: the stopped-everything run never sets `finishedAt`, the capacity case never
records `haltedReason`, the refusal case is not `partial`, and the vanished-intent
case loses its `Scheduling:` line. Reverting only the helper leaves the identical
`schedule-planned` / `member-deferred` trio repeating.

Full gates, unchanged:

```bash
pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
```

## How to Use

Nothing to enable and nothing to configure: the degrade is always on. What changes
is what you see and what you do next.

### What the tick now says

An all-stopped run ends with two lines in the tick notification — the advance's own
report first, then the finish:

```text
Fleet default: Scheduling: 0 member(s) now, 2 deferred (capacity 3, 0 already active, 3 free slot(s)).
- deferred bd-152 (external-blocker): …
- deferred bd-153 (dependency): …
Fleet default: run partial. nothing launched: bd-152 (external-blocker), bd-153 (dependency) still deferred; 2 member(s) need a human: bd-148, bd-149
```

The first line is the advance's own report (`formatScheduleLines`,
`src/fleet-launch.ts:786`); the last is `completeTickAction`'s
`Fleet <id>: run <outcome>. <detail>`.

`belayd_fleet_status` then renders the finished run instead of a growing tick
count (`formatFleetRunLine`, `src/fleet-run.ts:914`):

```text
run: until-complete — partial at 2026-10-27T13:18:11.220Z (41 tick(s))
stopped bd-148 (phase-failed): phase test failed: gate failed
stopped bd-149 (orchestrator-missing): no workflow state and no lease
```

The detail is bounded to 400 characters and cuts on a `; ` / `, ` boundary, so a
long deferred list ends in `+N more` rather than half a task id.

### When the run ends `partial` — what to do

- **Fix the blocker, then re-launch.** `partial` is a *finish*: `haltedReason` is
  unset, `finishedAt` is set, and the run is not ticked again
  (`isFleetRunActive`, `src/fleet-run.ts:896`). The members survive as the fleet's
  `taskIds`; `/fleet bd-148 bd-149 --fleet default` starts a **new** run record
  that keeps them.
- **Or advance explicitly, once the blocker clears.** `belayd_fleet_advance` takes
  the persisted `deferred` list, re-reads bd's blocking edges and launches what
  now fits:

  ```text
  belayd_fleet_advance { }
  ```

  Use it after `bd close bd-77` (an `external-blocker` cleared) or after the
  dependency's member landed. It is refused while the fleet is paused.
- **Land, don't advance, a stopped member.** A `dependency` deferred because a
  stopped member has not landed is discharged when that member lands. Check first:

  ```bash
  F=$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet/default/fleet.json
  jq -r '(.deferred // [])[] | "deferred \(.taskId) (\(.reason)): \(.detail)"' "$F"
  jq -r '(.run.stopped // [])[] | "stopped \(.taskId) (\(.reason)): \(.detail)"' "$F"
  ```

  A `dependency` whose blocker is in `run.stopped` means the wave is waiting on
  that member's own retry or on an explicit `belayd_fleet_merge` + `wt merge` —
  `belayd_fleet_advance` will re-defer it, which now costs one line, not an hour.

### A capacity-blocked wave still waits

`capacity` is the one deferral reason that frees itself: the slots are held by
another fleet and are released by *that* fleet landing. So the tick waits rather
than ending the run, and re-plans on the next action tick (2 s):

```text
Fleet default: advance launched nothing: bd-152 (capacity) blocked on capacity held by another fleet; the wave launches when a slot frees
```

If no slot frees, the same `FLEET_RUN_MAX_IDLE_TICKS` cap applies — 240 idle ticks,
~1 hour of wall clock at the 15 s tick — and the run halts `stalled` naming the
capacity-blocked members:

```text
Fleet default: run halted (stalled): no capacity slot freed in 240 ticks; bd-152 (capacity) still blocked on capacity held by another fleet
```

```bash
jq -r '"halted=\(.run.haltedReason // "none") idleTicks=\(.run.idleTicks // 0)"' "$F"
```

A `stalled` halt is terminal for that run record: `belayd_fleet_resume` is a no-op
here, so free the slot (land or prune the fleet holding it) and re-arm with
`/fleet <ids> --fleet default`. See `docs/fleet-run.md` → *Stop and resume*.

### The vanished-intent halt

If `fleet.json` is deleted (a reconcile, an operator cleanup, a re-arm from another
session) between the advance writing its new plan and the tick re-reading it, the
tick refuses to classify from the pre-launch deferrals and stops:

```text
Fleet default: run halted — the fleet intent for `default` is gone; nothing to advance
```

What to do: reconcile and relaunch. There is no run record left to inspect and no
`fleet-run-complete` / `fleet-run-halted` audit line for this stop — nothing was
classified, so check `belayd_fleet_status`, then `/fleet <ids> --fleet <id>`. An
unreadable (rather than deleted) record takes the same path with
`run halted — could not re-read the fleet intent: <error>`.

### Everyday commands

```text
belayd_fleet_status                                  # run: … — partial at <iso> (N tick(s))
belayd_fleet_advance { }                             # re-plan the deferred list once the blocker cleared
belayd_fleet_pause { "reason": "…" }                 # pause; resume restarts the ticker
belayd_fleet_resume { }                              # only a paused run resumes
/fleet bd-148 bd-149 --fleet default                 # re-arm after a finish or a halt (new run record)
```

What you no longer see — a run that keeps ticking with nothing to do:

```text
run: until-complete — 239 tick(s), last tick 2026-10-27T13:18:11.000Z
```

239 identical `schedule-planned` lines later, that run used to halt `stalled`.

## What did not change

- **Landing is still tick order 0 and stopping is order 1.** The degrade only
  touches order 4 (`advance`), so a finished member is still landed before
  anything is stopped, and landing still frees a capacity slot and unblocks
  dependents in the same tick.
- **A stopped member is never relaunched and never leaves the fleet.** `taskIds`
  keeps it, `run.stopped` says why, and only its `deferred` plan entry is retired
  (bd-156). The `partial` line names stopped members; it does not evict them.
- **The idle cap for members in flight is unchanged.** `idleOrWait`
  (`src/fleet-run.ts:683`) still waits while anything is working and still halts
  `stalled` at `FLEET_RUN_MAX_IDLE_TICKS`. bd-157 only makes the *same* cap
  reachable on the no-launch advance path, which previously could never fire it
  because no member is ever in flight there.
- **A real launch is still progress.** `acted: true` resets `idleTicks` and
  reschedules at `FLEET_RUN_ACTION_TICK_INTERVAL_MS` (2 s), not the 15 s tick. An
  advance that launches one member and defers the rest counts as progress.
- **`--manual` fleets are untouched.** They have no run record and no ticker;
  `belayd_fleet_advance` is still their explicit step.
- **The plan is unchanged.** `planFleetTick` still returns `advance` for an
  all-stopped run with deferred work — the degrade happens in the executor, which
  is where "nothing launched" is observable.

Related: `docs/fleet-run.md` (tick order, run record, halt semantics),
`docs/fleet.md` (operator entry point and failure recovery),
`docs/bd-156-userguide.md` (a stopped member stays a member),
`docs/bd-161-userguide.md` (which runs a member's progress is derived from).
