# Fleet membership survives a member stop (bd-156)

Before bd-156 a stopped fleet member was **erased from the fleet**: the stop path
called the landing path's pruning helper, so `fleet.json` `taskIds` lost the id.
Three operator-visible things followed: the `intent:` line in
`belayd_fleet_status` stopped naming the member (and the fleet stopped counting its
capacity slot even though its worktree, branch, and bead were all still live), a
sibling blocked by that bead was deferred as `external-blocker` ("a bead outside
this fleet") although the blocker was a member, and the run's land scan only looked
at unstopped members, so a stopped member whose own retry finished the work could
never be landed by the run.

bd-156 splits the two operations:

| Operation | Helper | Effect on membership |
|---|---|---|
| Member **lands** (branch on the base branch) | `pruneLandedFleetMember` | removed from `taskIds` **and** from `deferred` |
| Member **stops** (phase failure, land refusal, operator stop) | `retireFleetDeferral` | kept in `taskIds`; only its `deferred` plan entry is retired |

Both live in `src/fleet-state.ts` and are exported from `belayd-agent-harness`
(`src/index.ts`). The wiring is in `extensions/index.ts`
(`stopTickAction` / `landTickAction`) and the tick in `src/fleet-run.ts`.

## How to Verify

### 1. Targeted suites

```bash
pnpm vitest run src/__tests__/extension-fleet-p1.test.ts src/__tests__/fleet-launch.test.ts \
  src/__tests__/fleet-schedule.test.ts src/__tests__/fleet-run.test.ts \
  src/__tests__/fleet-status.test.ts src/__tests__/fleet-state.test.ts
```

Expected on `feat/bd-156`: `Test Files 6 passed (6)` / `Tests 301 passed (301)`.

One test per acceptance criterion — run a single one with `-t` to watch it fail on
a revert:

| Criterion | File | Case |
|---|---|---|
| Stop keeps the member in `taskIds`, out of `deferred`, and still lands it later | `src/__tests__/extension-fleet-p1.test.ts:1852` | `keeps a stopped member in the fleet, and still lands it once its retry finishes` |
| …end-to-end landing of a stopped member (`taskIds` empties, `landedAt` set) | `src/__tests__/extension-fleet-p1.test.ts:1899` | `lands a stopped member once its retry finished and the merge went through` |
| A stopped sibling blocker is a fleet `dependency`, never an outsider | `src/__tests__/fleet-launch.test.ts:1038` | `treats a stopped fleet member as an internal blocker, never an outsider (C2)` |
| …same rule at the scheduler | `src/__tests__/fleet-schedule.test.ts:139` | `treats a blocker the fleet already owns as an internal dependency, never an outsider` |
| …and the wave math | `src/__tests__/fleet-schedule.test.ts:161` | `plans a member blocked by a fleet member after an already-planned wave` |
| Status keeps rendering the stopped member + its worktree | `src/__tests__/fleet-status.test.ts:417` | `renders a stopped member with its stop reason and its live worktree` |
| The landed-prune vs deferred-retire split | `src/__tests__/fleet-state.test.ts:430`, `:446` | `prunes a landed member from both the member list and the deferred plan`, `retires a stopped member's deferral without forgetting the member` |
| Landing a stopped member, and its stop record going away | `src/__tests__/fleet-run.test.ts:327`, `:487` | `lands a stopped member whose own retry finished the work`, `clears a stop record once the member lands` |
| A stop caused by a land attempt is never retried | `src/__tests__/fleet-run.test.ts:345` | `never retries a member stopped by a land attempt` |
| The run stays open only while the retry is alive, and is still bounded | `src/__tests__/fleet-run.test.ts:375`, `:387`, `:399`, `:410` | `keeps the run open while a stopped member's retry is alive (single-member fleet)`, `completes partial once a stopped member's retry has no live lease`, `bounds the wait for a stopped retry with the idle cap`, `never waits on a stopped member a land attempt gave up on` |

The whole fleet surface is still green with
`pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build`.

### 2. Read `fleet.json` after a stop

Nothing here needs a live fleet. The record below is the production shape a stop
writes (`recordRunMemberStopped`) for a fleet whose `bd-19` waits on the stopped
`bd-12`:

```bash
root=/tmp/bd156-demo
rm -rf "$root" "$root".feat-bd-12 "$root".feat-bd-15
mkdir -p "$root" && cd "$root"
git init -q && git symbolic-ref HEAD refs/heads/main
git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && git add -A && git commit -qm base
git worktree add -q -b feat/bd-12 "$root.feat-bd-12"
git worktree add -q -b feat/bd-15 "$root.feat-bd-15"
mkdir -p "$root/.git/belayd/fleet/default"
cat > "$root/.git/belayd/fleet/default/fleet.json" <<'JSON'
{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12","bd-15"],"createdAt":1761000000000,"updatedAt":1761000900000,"maxConcurrent":3,"baseBranch":"main","deferred":[{"taskId":"bd-19","reason":"dependency","detail":"wave 1: waits for bd-12 to land (this wave starts when that member lands and belayd_fleet_advance re-plans it)"}],"supervisor":{"sessionId":"demo-session","pid":4242,"pidStartTime":"1000","armToken":"demo"},"run":{"schemaVersion":1,"mode":"until-complete","startedAt":1761000000000,"updatedAt":1761000900000,"ticks":4,"accept":true,"members":[{"taskId":"bd-12","launchedAt":1761000000000,"sessionId":"01a173fc"},{"taskId":"bd-15","launchedAt":1761000000000,"sessionId":"01a173fd"}],"stopped":[{"taskId":"bd-12","reason":"phase-failed","detail":"phase test failed: gate failed","at":1761000900000}],"idleTicks":0}}
JSON
F=.git/belayd/fleet/default/fleet.json
jq -r '"taskIds:  \(.taskIds | join(", "))"' "$F"
jq -r '"deferred: \([(.deferred // [])[] | "\(.taskId) (\(.reason))"] | join(", "))"' "$F"
jq -r '.run.stopped[] | "stopped \(.taskId) (\(.reason)): \(.detail)"' "$F"
jq -r '"landed:   \([.run.members[] | select(.landedAt != null) | .taskId] | join(", "))"' "$F"
```

Produced with that script:

```text
taskIds:  bd-12, bd-15
deferred: bd-19 (dependency)
stopped bd-12 (phase-failed): phase test failed: gate failed
landed:
```

`bd-12` is stopped **and still a member**: `taskIds` names it, `deferred` does
not (its plan entry was retired), `run.stopped` carries the reason. Pre-bd-156 the
first line read `taskIds: bd-15`.

### 3. See it in `belayd_fleet_status`

Use the driver from `docs/fleet.md` → *How to Verify* → step 2
(`/tmp/belayd-fleet-tool.ts`), from the repository root:

```bash
export BELAYD_REPO=$(pwd)
J=$BELAYD_REPO/node_modules/.bin/jiti
nix develop -c bash -lc "$J /tmp/belayd-fleet-tool.ts '{}' /tmp/bd156-demo"
```

Against the fixture above (stale workflow state in the member worktrees makes the
derived states `active`; the intent half is what matters here):

```text
Fleet default
  intent: bd-12, bd-15, max 3 concurrent
  deferred: bd-19 (dependency)
  run: until-complete — 4 tick(s), last tick 2025-10-20T22:55:00.000Z
  stopped bd-12 (phase-failed): phase test failed: gate failed
  members: 2
  ...

Member bd-12 — active
  worktree: /tmp/bd156-demo.feat-bd-12 (branch feat/bd-12)
  ...
```

Look for all three: `intent:` still lists the stopped id, a `stopped <id>
(<reason>)` line, and a `Member <id>` block with its `worktree:` line. The
`intent:` line is the bd-156 fix (pre-bd-156 it read `intent: bd-15, max 3
concurrent`); the member block itself comes from the worktree walk, so it is the
pairing — stopped member *still counted as a member* — that matters. (The `bead
metadata unavailable (bd read failed)` warning in a `/tmp` scratch repo is
expected: there is no beads database.)

### 4. Confirm the deferral reason is `dependency`, never "outside this fleet"

`dependency` and `external-blocker` are different codes *and* different prose. Scan
the persisted deferrals:

```bash
jq -r '[(.deferred // [])[] | "\(.taskId): \(.reason) — \(.detail)"] | join("\n")' "$F"
grep -c "outside this fleet" "$F" || echo "0 hits: no deferral calls a fleet member an outsider"
```

Produced:

```text
bd-19: dependency — wave 1: waits for bd-12 to land (this wave starts when that member lands and belayd_fleet_advance re-plans it)
0 hits: no deferral calls a fleet member an outsider
```

The launch report and `audit.log` (`member-deferred`) carry the same string. The
only way to get `external-blocker` now is a blocker that is not in this fleet's
`taskIds` at all — `src/fleet-schedule.ts` splits edges by fleet membership
(`memberIds` from `src/fleet-launch.ts`), and fleet members seed wave 0 so a
waiting member lands on wave 1 instead of looking like a cycle.

### 5. Confirm the run lands a stopped member whose retry finished

This is the one criterion that needs a merge, so it is pinned by tests rather
than by a scratch fixture:

```bash
pnpm vitest run src/__tests__/extension-fleet-p1.test.ts \
  -t "lands a stopped member once its retry finished and the merge went through"
pnpm vitest run src/__tests__/fleet-run.test.ts \
  -t "lands a stopped member whose own retry finished the work"
```

The extension case drives the real tick with a `merged` merge-queue entry and
asserts the production record afterwards:

- `taskIds === []` — the landing pruned the member (the one path allowed to);
- `run.members[0].landedAt` is set;
- `run.stopped` no longer names it (`recordRunMemberLanded` drops the stop, in
  `src/fleet-run.ts`);
- no "could not land" notification.

On a real fleet, the same fields are what you check when the run finishes:

```bash
jq -r '.taskIds' "$F"; jq -r '.run.members[] | "\(.taskId) landedAt=\(.landedAt)"' "$F"; jq -r '.run.stopped // []' "$F"
```

`land` is tick order 0 and scans **every** member (`canLandMember`), not only the
unstopped ones; `land-failed` / `accept-failed` are the only stops it refuses to
retry, because re-running the gates on the same conflict burns the same minutes.

### 6. Confirm the landing window (run stays open, halt ends it)

A stopped member can only be landed while the run is still ticking, so the tick
waits (`kind: "wait"`, detail `N member(s) in flight: <ids>`) only while the retry
is observably alive: a live orchestrator lease for a `running` member, or the
2-minute start grace for a member that has not written state yet. A stopped member
with no lease is *described* as running by stale files and is not waited on.

```bash
pnpm vitest run src/__tests__/fleet-run.test.ts -t "keeps the run open while a stopped member's retry is alive"
pnpm vitest run src/__tests__/fleet-run.test.ts -t "completes partial once a stopped member's retry has no live lease"
pnpm vitest run src/__tests__/fleet-run.test.ts -t "bounds the wait for a stopped retry with the idle cap"
```

On a real fleet, distinguish the three states from `fleet.json`:

```bash
jq -r '"paused=\(.paused // false) parked=\(.park != null) halted=\(.run.haltedReason // "none") finished=\(.run.finishedAt // "no") outcome=\(.run.outcome // "running")"' "$F"
```

- `paused=true`, no `haltedReason` → `belayd_fleet_resume` restarts the ticker.
- `haltedReason` set (`parked` / `stalled`) → **terminal for that run record**:
  `resume` only restarts a *paused* run, so the landing window is closed. Re-arm
  with `/fleet <ids> --fleet <id>` (run `belayd_fleet_reconcile` first for a
  parked fleet) to start a new run that keeps the members as `taskIds`.
- `finishedAt` set → same: re-arm, or land the bead explicitly with
  `belayd_fleet_merge` + `wt merge`.

### 7. Explicit prune is the only other way out

`belayd_fleet_reconcile` `{ "pruneDeadMembers": true }` still removes a member
that has **no live lease and no matching process** (`absent`, never `unknown`).
That is the escape hatch for a stopped member pinning a cross-fleet capacity slot.
A prune removes the id from `taskIds` only: `run.stopped` and the run outcome stay,
and the worktree, transcript, and bead are untouched. See `docs/fleet-reconcile.md`.

## How to Use

### What changed for an operator

- **A stop is not an eviction.** `phase-failed`, `awaiting-human`,
  `phase-interrupted`, `state-corrupt`, `orchestrator-missing`, and `land-failed`
  all leave the member in `taskIds`, leave its stop record in `run.stopped`, and
  retire only its `deferred` plan entry — so `belayd_fleet_advance` can never
  relaunch it, but status, reconcile, and a later land can all still see it.
- **Membership is pruned on landing, or by you.** `pruneLandedFleetMember` runs
  when the run lands a member; `belayd_fleet_reconcile { "pruneDeadMembers": true }`
  is the explicit operator prune.
- **A stopped member can still land.** The run stays open while its retry is
  observably alive (live lease, or the start grace), so a retry that finishes the
  work is landed by the same run: `taskIds` empties, `landedAt` is stamped,
  `run.stopped` drops the entry.
- **Blocker classification follows fleet membership, not the worklist.** A sibling
  blocked by a fleet member — running or stopped — is deferred as `dependency`.
  `external-blocker` means a bead that is not in this fleet at all.
- **A stopped member holds its cross-fleet capacity slot** until it lands or is
  pruned. A member whose retry session is alive is never prunable, so an
  all-stopped fleet can hold the ceiling of 3 until those retries end, land, or
  their sessions are gone.
- **Halt is terminal, a pause is not.** `belayd_fleet_resume` restarts a *paused*
  run's ticker only; after a `parked` / `stalled` halt (`haltedReason` is never
  cleared) you re-arm with `/fleet <ids> --fleet <id>`, which starts a new run
  record and keeps the members.

### Everyday commands

```text
belayd_fleet_status                                  # stopped line + the member's worktree
belayd_fleet_advance { }                             # re-plan the deferred list (never relaunches a stopped member)
belayd_fleet_reconcile { "pruneDeadMembers": true }  # explicit prune of provably-dead members
belayd_fleet_pause { "reason": "…" }                 # pause: resume restarts the ticker
/fleet bd-12 bd-15 --fleet default                   # re-arm after a halt or a supervisor restart
```

Reading a fleet you inherited:

```bash
F=$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet/default/fleet.json
jq -r '"members: \(.taskIds | join(", "))"' "$F"
jq -r '(.run.stopped // [])[] | "stopped \(.taskId) (\(.reason)): \(.detail)"' "$F"
jq -r '(.deferred // [])[] | "deferred \(.taskId) (\(.reason))"' "$F"
```

A non-empty `run.stopped` with the same id still in `taskIds` is the bd-156
invariant working: the member needs a human, but the fleet did not forget it. To
tell that apart from a finished fleet, check `run.finishedAt` / `run.outcome`
(`partial` means every surviving member is in `stopped`).

### Library use

Both membership operations are pure and exported, so a script can reason about a
fleet record without writing files:

```typescript
import {
  pruneLandedFleetMember,
  retireFleetDeferral,
  type FleetIntent,
} from "belayd-agent-harness";

declare const intent: FleetIntent;

// Landed: gone from the member list and the deferred plan.
const afterLanding = pruneLandedFleetMember(intent, "bd-12", Date.now());
// afterLanding.taskIds → ["bd-15"], afterLanding.deferred → []

// Stopped: still a member, plan entry retired. A stopped id is never prunable by
// this helper, which is exactly why a sibling still sees it as a fleet blocker.
const afterStop = retireFleetDeferral(intent, "bd-12", Date.now());
// afterStop.taskIds → ["bd-12", "bd-15"], afterStop.deferred → []
```

Both take `(intent, taskId, now)` and return a new `FleetIntent`; the
extension-level writers that persist them are `pruneLandedMember` and
`retireDeferredMember` in `extensions/index.ts` (intent CAS + `updatedAt`).

### Related documentation

- `docs/fleet-run.md` — the tick, stop reasons, the landing window, re-arm.
- `docs/fleet.md` — operator entry point, decision table, failure recovery.
- `docs/fleet-launch.md` — deferral reasons, waves, capacity.
- `docs/fleet-reconcile.md` — explicit prune, liveness model, `pruneDeadMembers`.
- `docs/fleet-status.md` — the read-only view and its fields.
