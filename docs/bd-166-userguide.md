# Fleet capacity accounting and slot release (bd-166)

A repository has one ceiling of **3 concurrent orchestrators**, shared by every
fleet under `<git-common-dir>/belayd/fleet/*`. Before bd-166 the ceiling was
counted from `fleet.json` `taskIds` alone, so a recorded member held one of those
three slots for as long as its id stayed in the intent — even after its bead was
merged by hand, after the run stopped it, and after the run that was supposed to
land it had already finished. Three failures fell out of that:

1. a member nobody was driving still consumed a slot (`capacity` leak);
2. a run that ended 0-for-N left N of the 3 slots held forever, with no live
   supervisor left to repair them;
3. a bead accepted with `wt merge` + `bd close` was never noticed by the fleet,
   so its member (and slot) stayed recorded with nothing left to observe.

bd-166 makes capacity **evidence-first**, releases slots explicitly, and closes
the three loops (terminal runs, outside-fleet landings, named-fleet reconcile).

| What decides a slot | Where |
|---|---|
| `memberHoldsCapacity` — `released` never counts, `absent` does not count, `live`/`unknown` do | `src/fleet-capacity.ts` |
| The repository arithmetic and per-fleet rollup (`describeFleetCapacity`) | `src/fleet-capacity.ts` |
| Which liveness a member gets (mid-spawn ⇒ `unknown`) | `src/fleet-sessions.ts` `classifyMemberLivenessInWorktree` |
| The evidence cutoff for "this execution ran" | `src/fleet-run.ts` `memberRanEvidence`, `memberEvidenceCutoff`, `worktreeCreatedAtFromStat` |
| Terminal-run release sweep | `src/fleet-run.ts` `releaseRunMembers`, `extensions/index.ts` `releaseTerminalMembers` |
| Outside-fleet landing | `src/fleet-run.ts` `planOutsideFleetLandings`, `extensions/index.ts` `landMembersMergedOutsideFleet` |
| `capacity:` block and the three new warnings | `src/fleet-status.ts` `formatCapacity`, `staleMemberWarnings`, `capacityHeldWarnings`, `runNotTickingWarnings` |
| Named-fleet reconcile authority | `src/fleet-reconcile.ts` `reconcileAuthority` |
| `belayd_fleet_release` | `extensions/index.ts` |

None of this removes anything. An `absent` member, a released member, and a
landed member differ only in **what the ceiling subtracts**: a release and an
absence keep the id in `taskIds`, so `belayd_fleet_status`, the mailbox, and a
later landing still see the member.

## How to Verify

Everything below runs from the repository root of this checkout. The driver
loads `extensions/index.ts` through `jiti`, so no build step is needed.

### 1. Gates

```bash
pnpm test              # Test Files 124 passed (124); Tests 3210 passed (3210)
pnpm test:integration  # Test Files 14 passed (14);   Tests 106 passed (106)
pnpm typecheck         # tsc --noEmit — no output
pnpm lint              # Checked 248 files. No fixes applied.
pnpm build             # tsc — no output
```

### 2. The regression tests that pin each item

Run one suite directly (`vitest` positional filters, no `--`):

```bash
node_modules/.bin/vitest run src/__tests__/fleet-run.test.ts -t "releaseRunMembers"
node_modules/.bin/vitest run --config vitest.integration.config.ts test/fleet-status.integration.test.ts
```

| Acceptance item | File | Case to look for |
|---|---|---|
| Liveness-aware capacity: `absent` stops counting, `unknown` and `live` count | `src/__tests__/fleet-launch.test.ts` | `stops counting a member whose orchestrator is provably absent (bd-166)`, `applies a release only to the fleet that records it (bd-166)`, `runFleetLaunch: liveness-aware capacity and releases (bd-166)` |
| Mid-spawn is never freed; a completed member is | `src/__tests__/fleet-sessions.test.ts`, `src/__tests__/extension-fleet-p1.test.ts` | `classifyMemberLivenessInWorktree (bd-166)`; `mid-spawn capacity (bd-166)` → `counts a bare spawn worktree against the ceiling, not as absent`, `frees the slot of a completed member whose state file was cleared (bd-166)`, `does not free a slot for a re-launched bead whose earlier manifest was copied in (bd-166)` |
| Evidence cutoff arithmetic | `src/__tests__/fleet-run.test.ts` | `memberRanEvidence (bd-166)`, `memberEvidenceCutoff (bd-166)`, `worktreeCreatedAtFromStat (bd-166)` |
| `capacity:` block + `stale-member` / `capacity-held` / `run-not-ticking` | `src/__tests__/fleet-status.test.ts` | `capacity arithmetic (bd-166)` (five cases, one per rendering/warning), plus `frees the slot of a member whose completion cleared the state file (bd-166)` and `does not count an inherited same-task manifest as this execution's evidence (bd-166)` |
| Status view end to end from real git + fs | `test/fleet-status.integration.test.ts` | `renders the capacity arithmetic without holding a slot for an absent member` |
| Terminal release / halt / pause split, idempotence | `src/__tests__/fleet-run.test.ts`, `src/__tests__/extension-fleet-p1.test.ts` | `releaseRunMembers (bd-166)` (5 cases); `releases a finished run's unlanded member without pruning it (bd-166)`, `releases a halted run's unlanded members (bd-166)`, `does not release members when a run merely pauses (bd-166)` |
| Advance records members + beats the heartbeat | `src/__tests__/extension-fleet-p1.test.ts` | `records an advance-launched member in the live run and beats the heartbeat (bd-166)` |
| Outside-fleet landing (closed bead **and** git ancestor) | `src/__tests__/fleet-run.test.ts`, `src/__tests__/extension-fleet-p1.test.ts` | `planOutsideFleetLandings (bd-166)` (three cases incl. `requires both facts: a closed bead alone or an ancestor alone is not a landing`); `lands a member whose bead is closed and whose branch is already on the base (bd-166)`, `sweeps one member bead per tick, rotating with the run ticks (bd-166)` |
| Named-fleet reconcile, cross-fleet prune refused | `src/__tests__/fleet-reconcile.test.ts`, `src/__tests__/extension-fleet-p1.test.ts` | `reconcileAuthority (bd-166)`; `cross-fleet reconcile (bd-166)` → `repairs a named fleet's queue/park and audits the target`, `refuses pruneDeadMembers for a fleet this session does not supervise` |
| `belayd_fleet_release` | `src/__tests__/extension-fleet-p1.test.ts` | `release (bd-166)` → `gives a member's slot back while keeping it a member`, `refuses an id that is not a member of this fleet`, `refuses to release a member whose orchestrator is live` |
| `released[]` schema, per-fleet keying, cleared by landing | `src/__tests__/fleet-status.test.ts`, `src/__tests__/fleet-launch.test.ts`, `src/__tests__/fleet-state.test.ts` | `rejects an unknown release reason, like the deferred reason enum (bd-166)`; `frees an abandoned fleet's slots once its members are absent`, `does not count a released member of another fleet`; `drops a landed member's release entry (bd-166)` |

### 3. Install the driver once

Save the driver once. It registers the extension, runs the tool names you pass in
order, and prints each result plus the notifications the extension raised. Every
step below uses it, so the tool output you see is exactly what pi would show.

```bash
repo=$PWD                     # repository root of this checkout
J=$repo/node_modules/.bin/jiti

cat > /tmp/bd166-fleet.ts <<'TS'
// usage: jiti bd166-fleet.ts <harness-checkout> <cwd> '<json [[tool,args],…]>' [waitMs]
interface FleetTool {
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ text: string }>;
    details: { exitCode: number };
  }>;
}
const [repo, cwd, stepsJson, waitMs = "0"] = process.argv.slice(2);
if (repo === undefined || cwd === undefined) throw new Error("usage: <repo> <cwd> <steps> [waitMs]");
const steps = JSON.parse(stepsJson ?? "[]") as Array<[string, unknown]>;
const mod = (await import(`${repo}/extensions/index.ts`)) as { default: (api: unknown) => void };
const tools = new Map<string, FleetTool>();
const notifications: Array<{ message: string; level?: string }> = [];
const api = {
  registerTool: (def: FleetTool & { name: string }) => tools.set(def.name, def),
  registerCommand: () => {},
  on: () => {},
  sendMessage: () => {},
  getActiveTools: () => [],
  setActiveTools: () => [],
  events: { emit: () => {}, on: () => () => {} },
};
mod.default(api);
const ctx = {
  cwd,
  ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
  sessionManager: {
    getSessionId: () => "demo-session",
    getSessionName: () => "fleet-supervisor-demo",
    getSessionFile: () => `${cwd}/session.jsonl`,
  },
};
async function run(name: string, args: unknown): Promise<void> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`${name} was not registered`);
  console.log(`\n=== ${name} ${JSON.stringify(args)}`);
  const result = await tool.execute("doc", args, undefined, undefined, ctx);
  console.log(result.content.map((part) => part.text).join("\n"));
  console.error(`[${name} exit=${result.details.exitCode}]`);
}
for (const [name, args] of steps) await run(name, args);
if (Number(waitMs) > 0) {
  // The run loop is a timer inside this process; keep it alive so ticks happen.
  console.log(`\n… letting the supervisor ticker run for ${waitMs} ms`);
  await new Promise((resolve) => setTimeout(resolve, Number(waitMs)));
  await run("belayd_fleet_status", {});
}
if (notifications.length > 0) console.log("\nnotifications:", JSON.stringify(notifications, null, 2));
process.exit(0);
TS
```

The driver's session id is `demo-session` and its cwd is the repository you pass.
Fleet tools that are supervisor-only need that session to be the fleet's live
supervisor, which is why every scenario below re-arms first with
`belayd_fleet_launch` (a re-arm preserves members and starts nothing).

### 4. Read the capacity block: three liveness verdicts in one view

Build a scratch repository with three recorded members and two worktrees:

```bash
root=/tmp/bd166-guide
rm -rf "$root" "$root".feat-*; mkdir -p "$root" && cd "$root"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
git worktree add -q -b feat/bd-12 "$root.feat-bd-12"
git worktree add -q -b feat/bd-15 "$root.feat-bd-15"

# bd-12: worktree with workflow state, no orchestrator  -> absent (frees its slot)
mkdir -p "$root.feat-bd-12/.belayd"
cat > "$root.feat-bd-12/.belayd/workflow.json" <<JSON
{"schemaVersion":1,"taskId":"bd-12","workflowType":"feature","branch":"feat/bd-12","originalCwd":"$root.feat-bd-12","phaseOrder":["plan","implement","review","test","userguide","proof","commit"],"completedPhaseNames":["plan","implement","review"],"awaitingReviewResponse":true,"startedAt":1761000000000,"updatedAt":1761000900000}
JSON
# bd-15: bare worktree, no state, no lease, no manifest -> unknown (mid-spawn, counted)
# bd-17: no worktree at all                              -> unknown (counted) + stale-member

mkdir -p "$root/.git/belayd/fleet/default"
cat > "$root/.git/belayd/fleet/default/fleet.json" <<JSON
{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12","bd-15","bd-17"],"createdAt":1761000000000,"updatedAt":1761000900000,"maxConcurrent":3,"baseBranch":"main","supervisor":{"sessionId":"dead-session","pid":999999}}
JSON

cd "$root" && "$J" /tmp/bd166-fleet.ts "$repo" "$root" '[["belayd_fleet_status",{}]]'
```

Produced:

```text
Fleet default
  intent: bd-12, bd-15, bd-17, max 3 concurrent
  members: 2
  states: active=0 blocked=0 awaiting-human=1 interrupted=0 idle=0 missing-state=1
  capacity: ceiling 3, 1 free, 2 counted
    default: 3 member(s), 2 counted (0 live, 2 unknown, 1 absent), 0 stopped, 0 released; supervisor dead
…
Warnings (5):
  - no .belayd/workflow.json in /tmp/bd166-guide.feat-bd-15; that worktree drives no workflow
  - fleet default still records bd-17, but no worktree holds feat/bd-17; release it with belayd_fleet_release bd-17 (or reconcile --prune-dead-members) if its work is gone
  - fleet default counts 2 member(s) against the ceiling of 3 but has no live supervisor (recorded supervisor: dead); re-arm it or release the members
  - bead metadata unavailable (bd read failed): … no beads database found …
  - bead engagement unavailable (bd read failed): … no beads database found …
```

Read it as the whole bd-166 rule in one screen:

- `3 member(s)` is the **recorded** count (from `taskIds`); `members: 2` in the
  header is the **worktree** count. bd-17 exists only in the intent, and that is
  exactly why it still shows up in the capacity line and in `stale-member`.
- `1 absent` is bd-12: its worktree holds workflow state and nothing is running
  it, so its slot is free without the member being removed.
- `2 unknown` are bd-15 (bare worktree — a launch may still be spawning it) and
  bd-17 (no worktree — no worktree is not proof that nothing is spawning). Both
  are **counted**: `ceiling 3 − 2 counted = 1 free`.
- `supervisor dead` plus `2 counted` is the `capacity-held` warning: a fleet with
  no live supervisor is holding slots.

Failure signals in this step: `3 free` (a leak that has *not* been fixed — some
member is being classified `absent` when it should be `unknown`), or
`0 free` with nothing running.

### 5. Give a slot back with `belayd_fleet_release`

The tool is supervisor-only and has no `fleetId` parameter: it always acts on the
fleet this session supervises, so it cannot touch another fleet. Re-arm first (the
recorded supervisor is dead), then release one of the `unknown` members; the
second call repeats it, the third asks for an id that is not a member at all:

```bash
cd "$root" && "$J" /tmp/bd166-fleet.ts "$repo" "$root" '[
  ["belayd_fleet_launch",{"tasks":["bd-12","bd-15","bd-17"],"fleetId":"default","untilComplete":false}],
  ["belayd_fleet_release",{"taskId":"bd-15"}],
  ["belayd_fleet_release",{"taskId":"bd-15"}],
  ["belayd_fleet_release",{"taskId":"bd-99"}],
  ["belayd_fleet_status",{}]]'
```

Produced (notifications elided; the launch also warns that bd has no database):

```text
Fleet `default`: re-armed — supervisor record rewritten, 3 existing member(s) preserved, no new members (maxConcurrent 3).

Fleet `default`: released bd-15's capacity slot (liveness: unknown). The member, its bead, worktree, and transcript are unchanged; it can still be landed, and the slot is free for the next fleet.

Fleet `default`: bd-15's capacity slot is already released; the bead, worktree, and transcript are unchanged.

bd-99 is not a member of fleet `default`; its members are bd-12, bd-15, bd-17
[belayd_fleet_release exit=1]

=== belayd_fleet_status {}
  released: bd-15 (operator-release) — slot given back, member kept
  members: 2
  capacity: ceiling 3, 2 free, 1 counted
    default: 3 member(s), 1 counted (0 live, 2 unknown, 1 absent), 0 stopped, 1 released; supervisor live
```

Three facts to confirm here: the second call is a **success** (exit 0, no duplicate
entry), a non-member is a **refusal** (exit 1), and the member is still there
(`taskIds` unchanged, `members: 2` still counts its worktree).

A live orchestrator is the one release that is refused — write a fresh lease for a
member that is **not** yet released:

```bash
now=$(node -e 'console.log(Date.now())')
mkdir -p "$root.feat-bd-12/.belayd"
printf '{"schemaVersion":1,"taskId":"bd-12","branch":"feat/bd-12","sessionId":"sess-live","pid":12345,"claimedAt":%s,"heartbeatAt":%s}' "$now" "$now" \
  > "$root.feat-bd-12/.belayd/orchestrator.json"

cd "$root" && "$J" /tmp/bd166-fleet.ts "$repo" "$root" '[
  ["belayd_fleet_launch",{"tasks":["bd-12","bd-15","bd-17"],"fleetId":"default","untilComplete":false}],
  ["belayd_fleet_release",{"taskId":"bd-12"}]]'
```

```text
Fleet release refused: bd-12's orchestrator is live, so it still holds a real slot. Stop it (belayd_fleet_pause) or let it land; a running member is never released out from under itself.
[belayd_fleet_release exit=1]
```

That lease also makes bd-12 `live` (counted) in the next status read; remove it
before later steps:

```bash
rm "$root.feat-bd-12/.belayd/orchestrator.json"
```

What the writes look like on disk:

```bash
jq -c '{taskIds, released}' "$root/.git/belayd/fleet/default/fleet.json"
grep member-released "$root/.git/belayd/fleet/default/audit.log"
```

```text
{"taskIds":["bd-12","bd-15","bd-17"],"released":[{"taskId":"bd-15","reason":"operator-release","at":…}]}
{"timestamp":…,"fleetId":"default","actor":"demo-session","action":"member-released","taskIds":["bd-15"],"detail":"operator-release: the capacity slot is free; the bead, worktree, and transcript stay"}
```

### 6. Terminal runs release; a paused run does not

A finished or halted run is the end of the line for its members, so the sweep
releases what it can no longer land. Three fixtures, three outcomes.

**Run completes (0-for-N):**

```bash
run=/tmp/bd166-complete
rm -rf "$run"; mkdir -p "$run" && cd "$run"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
mkdir -p "$run/.git/belayd/fleet/default"
jq -nc '{schemaVersion:1,fleetId:"default",taskIds:["bd-20","bd-21"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",supervisor:{sessionId:"dead-session",pid:999999}}' \
  > "$run/.git/belayd/fleet/default/fleet.json"

cd "$run" && "$J" /tmp/bd166-fleet.ts "$repo" "$run" '[
  ["belayd_fleet_launch",{"tasks":["bd-20","bd-21"],"fleetId":"default"}]]' 10000
```

```text
  released: bd-20 (run-complete), bd-21 (run-complete) — slot given back, member kept
  run: until-complete — partial at 2026-10-27T23:25:43.220Z (3 tick(s))
  capacity: ceiling 3, 3 free, 0 counted
    default: 2 member(s), 0 counted (0 live, 2 unknown, 0 absent), 2 stopped, 2 released; supervisor live
…
"Fleet default: run partial. 2 member(s) need a human: bd-20, bd-21"
"Fleet default: released the capacity slot(s) of bd-20, bd-21 (run-complete); the members stay for status and a later landing"
```

```bash
jq -c '{taskIds, released, outcome: .run.outcome}' .git/belayd/fleet/default/fleet.json
grep members-released .git/belayd/fleet/default/audit.log
```

```text
{"taskIds":["bd-20","bd-21"],"released":[{"taskId":"bd-20","reason":"run-complete","at":…},{"taskId":"bd-21","reason":"run-complete","at":…}],"outcome":"partial"}
{"timestamp":…,"action":"members-released","taskIds":["bd-20","bd-21"],"detail":"run-complete: members that did not land no longer hold a capacity slot; beads, worktrees, and transcripts stay"}
```

The run's outcome is `partial` (nothing landed), both members are still in
`taskIds`, and the ceiling is free.

**Run halts (parked):**

```bash
halt=/tmp/bd166-parked
rm -rf "$halt"; mkdir -p "$halt" && cd "$halt"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
mkdir -p "$halt/.git/belayd/fleet/default"
jq -nc '{schemaVersion:1,fleetId:"default",taskIds:["bd-40","bd-41"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",park:{reason:"root restore conflicted",stashRef:"refs/stash@{0}",recordedAt:1},supervisor:{sessionId:"dead-session",pid:999999}}' \
  > "$halt/.git/belayd/fleet/default/fleet.json"

cd "$halt" && "$J" /tmp/bd166-fleet.ts "$repo" "$halt" '[
  ["belayd_fleet_launch",{"tasks":["bd-40","bd-41"],"fleetId":"default"}]]' 6000
```

```text
  released: bd-40 (run-halted), bd-41 (run-halted) — slot given back, member kept
  parked: root restore conflicted (stash refs/stash@{0}) — belayd_fleet_reconcile then belayd_fleet_resume
  run: until-complete — halted: parked: the root checkout is parked (root restore conflicted); reconcile, then resume
  capacity: ceiling 3, 3 free, 0 counted
    default: 2 member(s), 0 counted (0 live, 2 unknown, 0 absent), 0 stopped, 2 released; supervisor live
```

**Same fixture, paused instead of parked — nothing is released:**

```bash
pause=/tmp/bd166-paused
rm -rf "$pause"; mkdir -p "$pause" && cd "$pause"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
mkdir -p "$pause/.git/belayd/fleet/default"
jq -nc '{schemaVersion:1,fleetId:"default",taskIds:["bd-30","bd-31"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",paused:true,note:"stepping away",supervisor:{sessionId:"dead-session",pid:999999}}' \
  > "$pause/.git/belayd/fleet/default/fleet.json"

cd "$pause" && "$J" /tmp/bd166-fleet.ts "$repo" "$pause" '[
  ["belayd_fleet_launch",{"tasks":["bd-30","bd-31"],"fleetId":"default"}]]' 6000
jq -c '{taskIds, released, paused, haltedReason: .run.haltedReason}' .git/belayd/fleet/default/fleet.json
```

```text
  run: until-complete — 1 tick(s), last tick 2026-10-27T23:26:05.861Z
  capacity: ceiling 3, 1 free, 2 counted
    default: 2 member(s), 2 counted (0 live, 2 unknown, 0 absent), 0 stopped, 0 released; supervisor live
"Fleet default: run paused (paused): stepping away"

{"taskIds":["bd-30","bd-31"],"released":null,"paused":true,"haltedReason":null}
```

That is the contract: `run-complete` and `run-halted` release, `paused` does not
(it is resumable, and `belayd_fleet_resume` must find the members intact). A
member whose work is `complete` is not released either — it stays **landable** —
and a member whose orchestrator is live is never released out from under itself.

### 7. A hand-merged bead lands on the next tick

`wt merge` + `bd close` is the accept path the docs recommend, and it never
touches `fleet.json`. This step builds it for real (real beads, real merge), so a
scratch repository needs its own beads database:

```bash
land=/tmp/bd166-land
rm -rf "$land" "$land".feat-*; mkdir -p "$land" && cd "$land"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore
git add -A && git commit -qm base
bd init --prefix bd -q
id=$(bd create --title "landing demo" --type task --json 2>/dev/null | jq -r .id)

git worktree add -q -b "feat/$id" "$land.feat-$id"
mkdir -p "$land.feat-$id/.belayd"
cat > "$land.feat-$id/.belayd/workflow.json" <<JSON
{"schemaVersion":1,"taskId":"$id","workflowType":"feature","branch":"feat/$id","originalCwd":"$land.feat-$id","phaseOrder":["plan","implement","review","test","userguide","proof","commit"],"completedPhaseNames":["plan","implement","review","test","userguide","proof","commit"],"startedAt":1761000000000,"updatedAt":1761000900000}
JSON
( cd "$land.feat-$id" && printf 'work\n' > WORK.md && git add -A && git commit -qm "member work" )

git merge --ff-only -q "feat/$id"                    # what `wt merge` does
bd close "$id" --reason "merged by hand (wt merge)"  # what acceptance does
bd show "$id" --json | jq -r '.[0].status // .status'   # closed

mkdir -p "$land/.git/belayd/fleet/default"
printf '%s' "{\"schemaVersion\":1,\"fleetId\":\"default\",\"taskIds\":[\"$id\"],\"createdAt\":1,\"updatedAt\":1,\"maxConcurrent\":3,\"baseBranch\":\"main\",\"supervisor\":{\"sessionId\":\"dead-session\",\"pid\":999999}}" \
  > "$land/.git/belayd/fleet/default/fleet.json"

cd "$land" && "$J" /tmp/bd166-fleet.ts "$repo" "$land" "[
  [\"belayd_fleet_launch\",{\"tasks\":[\"$id\"],\"fleetId\":\"default\"}]]" 8000
```

`bd init --prefix bd` gives every bead a random id, so yours will differ (the
captured run produced `bd-3e4`). The launch re-arms, the first tick lands the
member and finishes the run; the status body is trimmed to the capacity line:

```text
"Fleet default: running until every member is landed. Observe with belayd_fleet_status; pause with belayd_fleet_pause."
"Fleet default: landed bd-3e4 — its bead is closed and its branch is already on main"
"Fleet default: run complete. every member landed"

=== belayd_fleet_status {}
  capacity: ceiling 3, 3 free, 0 counted
```

```bash
jq -c '{taskIds, run: {outcome: .run.outcome, members: .run.members}}' .git/belayd/fleet/default/fleet.json
grep fleet-landed .git/belayd/fleet/default/audit.log
git worktree list
```

```text
{"taskIds":[],"run":{"outcome":"complete","members":[{"taskId":"bd-3e4","launchedAt":…,"landedAt":…}]}}
{"timestamp":…,"action":"fleet-landed","taskIds":["bd-3e4"],"detail":"bd-3e4 was already on main (bead closed outside the fleet); pruned and gates resolved"}
/tmp/bd166-land             7a25800 [main]
/tmp/bd166-land.feat-bd-3e4 7a25800 [feat/bd-3e4]
```

Success is `taskIds: []`, a `landedAt` on the run member, the `fleet-landed` audit
line, and **no hand edit of `fleet.json`** — the tick pruned the member itself.
The merged worktree is deliberately **not** removed on this path (no merge ran:
git had already proven the branch on the base), so remove it yourself with
`git worktree remove "$land.feat-$id"`.

Failure signals: the bead is closed but the member stays recorded (the git probe
did not answer — `merge-base --is-ancestor` failed, or the branch was deleted
after the merge), or a member lands whose branch is *not* on the base (that would
mean bead status alone was accepted as proof, which the code refuses).

### 8. An advance records its members and beats the heartbeat

`belayd_fleet_advance` used to launch members that never appeared in
`run.members`, which blinded idle/stall accounting and status. Observe it on a
fleet with a deferred member after a real advance:

```bash
fd=$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet/default
jq -c '{members: [.run.members[].taskId], ticks: .run.ticks}' "$fd/fleet.json"
ls "$fd"                        # supervisor.json appears/updates with the advance
jq -c '{sessionId, heartbeatAt}' "$fd/supervisor.json"
grep '"action":"advance"' "$fd/audit.log"
```

An advance that launches nothing still beats the heartbeat, so "busy supervisor"
and "dead supervisor" stay distinguishable; an advance whose launches were all
refused records no members (the launch result is a refusal, exit 1). The
end-to-end proof, without spawning a real member, is the extension case named in
step 2:

```bash
node_modules/.bin/vitest run src/__tests__/extension-fleet-p1.test.ts \
  -t "records an advance-launched member in the live run and beats the heartbeat"
```

### 9. Repair a named fleet, and see the prune refused

Cross-fleet **repair** is allowed when this session supervises some fleet in the
repository; cross-fleet **prune** is not.

```bash
cross=/tmp/bd166-cross
rm -rf "$cross"; mkdir -p "$cross" && cd "$cross"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
mkdir -p "$cross/.git/belayd/fleet/owned" "$cross/.git/belayd/fleet/orphan"
jq -nc '{schemaVersion:1,fleetId:"owned",taskIds:["bd-60"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",supervisor:{sessionId:"dead-session",pid:999999}}' \
  > "$cross/.git/belayd/fleet/owned/fleet.json"
jq -nc '{schemaVersion:1,fleetId:"orphan",taskIds:["bd-70"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",supervisor:{sessionId:"dead-session",pid:999999}}' \
  > "$cross/.git/belayd/fleet/orphan/fleet.json"

cd "$cross" && "$J" /tmp/bd166-fleet.ts "$repo" "$cross" '[
  ["belayd_fleet_launch",{"tasks":["bd-60"],"fleetId":"owned","untilComplete":false}],
  ["belayd_fleet_reconcile",{"fleetId":"orphan"}],
  ["belayd_fleet_reconcile",{"fleetId":"orphan","pruneDeadMembers":true}]]'
```

```text
=== belayd_fleet_reconcile {"fleetId":"orphan"}
- member bd-70: orchestrator not running
- members: bd-70 have no orchestrator process; re-run with prune-dead-members to remove them from the intent (worktrees stay)
[belayd_fleet_reconcile exit=0]

=== belayd_fleet_reconcile {"fleetId":"orphan","pruneDeadMembers":true}
Fleet reconcile refused: pruneDeadMembers is only allowed on this session's own fleet. `orphan` is owned by its own supervisor: re-arm it (/fleet <ids> --fleet orphan) and run the reconcile (or belayd_fleet_release) from that session. Cross-fleet reconcile still repairs the queue and park without pruning.
[belayd_fleet_reconcile exit=1]
```

The repair is audited on the *target* fleet, and `orphan`'s own records are
untouched:

```bash
cat "$cross/.git/belayd/fleet/orphan/audit.log"
jq -c '.taskIds' "$cross/.git/belayd/fleet/orphan/fleet.json"
```

```text
{"timestamp":…,"fleetId":"orphan","actor":"demo-session","action":"reconcile-cross-fleet","taskIds":[],"detail":"target `orphan`; session supervises owned"}
["bd-70"]
```

The same call with `fleetId: "owned"` (this session's own fleet) audits no
`reconcile-cross-fleet` line and may prune; a session that supervises nothing is
refused outright with the list of fleets found.

### 10. `run-not-ticking`

A run whose ticker stopped looks alive in `fleet.json`. Plant an active run with an
old `updatedAt`:

```bash
stale=/tmp/bd166-stale-tick
rm -rf "$stale"; mkdir -p "$stale" && cd "$stale"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
old=$(( $(node -e 'console.log(Date.now())') - 600000 ))
mkdir -p "$stale/.git/belayd/fleet/default"
jq -nc --argjson old "$old" '{schemaVersion:1,fleetId:"default",taskIds:["bd-80"],createdAt:1,updatedAt:$old,maxConcurrent:3,baseBranch:"main",run:{schemaVersion:1,mode:"until-complete",startedAt:$old,updatedAt:$old,ticks:3,accept:false,members:[{taskId:"bd-80",launchedAt:$old}]},supervisor:{sessionId:"demo-session",pid:999999}}' \
  > "$stale/.git/belayd/fleet/default/fleet.json"

cd "$stale" && "$J" /tmp/bd166-fleet.ts "$repo" "$stale" '[["belayd_fleet_status",{}]]'
```

```text
  run: until-complete — 3 tick(s), last tick 2026-10-27T23:13:06.421Z
  capacity: ceiling 3, 2 free, 1 counted
  - fleet default has an active run whose last tick was at 2026-10-27T23:13:06.421Z (3 tick(s), 40 tick interval(s) ago, bound 10); nothing will land or advance until a session resumes the loop (re-arm the fleet) or an operator releases/lands the members
```

The bound is `FLEET_RUN_TICK_INTERVAL_MS × 10` = 2.5 minutes. Only an **active**
run is checked (`finishedAt` and `haltedReason` both absent), so a finished or
halted run draws no such warning.

### 11. Clean up

```bash
rm -rf /tmp/bd166-guide /tmp/bd166-guide.feat-* \
       /tmp/bd166-complete /tmp/bd166-parked /tmp/bd166-paused \
       /tmp/bd166-land /tmp/bd166-land.feat-* \
       /tmp/bd166-cross /tmp/bd166-stale-tick \
       /tmp/bd166-fleet.ts
```

## How to Use

### Read the `capacity:` block

`belayd_fleet_status` (read-only, exit 0) prints it in the header, under the
member counts:

```text
  capacity: ceiling 3, 1 free, 2 counted
    default: 3 member(s), 2 counted (0 live, 2 unknown, 1 absent), 0 stopped, 0 released; supervisor live
    night: 2 member(s), 0 counted (0 live, 0 unknown, 2 absent), 0 stopped, 2 released; supervisor dead
```

| Field | Meaning |
|---|---|
| `ceiling 3` | `FLEET_MAX_CONCURRENT_ORCHESTRATORS`: concurrent **orchestrators** in this repository, across every fleet, not total agents |
| `N free` | `ceiling − counted`, floored at 0. This is what a launch has to spend |
| `M counted` | Live + unknown members that are not released — the number a launch subtracts |
| `<fleet>: N member(s)` | `taskIds` length for that fleet (recorded members, including ones with no worktree) |
| `counted (L live, U unknown, A absent)` | Liveness breakdown. `live`: a fresh worktree lease or a `belayd-<taskId>` process. `absent`: its own execution is accounted for and nothing is running. `unknown`: the evidence is missing or unreadable |
| `S stopped` | Members `run.stopped` gave up on (they need a human) |
| `R released` | Members whose slot was given back (`run-complete`, `run-halted`, `operator-release`) |
| `supervisor live\|dead\|none` | For a run-mode fleet, the run supervisor's heartbeat; otherwise the recorded pid |

Fleets with no recorded members are left out of the per-fleet lines. The header
`members:` count is worktrees, so it can be smaller than the capacity line's
`N member(s)` — a recorded member with no worktree appears only in the capacity
line and in a `stale-member` warning.

The one rule worth memorising: **a member is `absent` only when its own execution
is accounted for** — a `.belayd/workflow.json`, or a run manifest that postdates
the worktree's creation and the run's recorded `launchedAt`. A bare worktree
mid-spawn, a manifest inherited from a copy, and a member with no worktree at all
are all `unknown`, and unknown counts.

### The three new warnings

| Warning | Trigger | What to do |
|---|---|---|
| `fleet <id> still records <taskId>, but no worktree holds feat/<taskId>; release it with belayd_fleet_release <taskId> (or reconcile --prune-dead-members) if its work is gone` (`stale-member`) | A recorded member has no worktree, and is not released | Its liveness is `unknown` (no worktree is no proof nothing is spawning), so it holds a slot. `belayd_fleet_release <taskId>` frees the slot and keeps everything; `belayd_fleet_reconcile` `pruneDeadMembers` from that fleet's own supervisor erases the record |
| `fleet <id> counts N member(s) against the ceiling of 3 but has no live supervisor (recorded supervisor: dead); re-arm it or release the members` (`capacity-held`) | A fleet with no live supervisor still counts slots | Re-arm it (`/fleet <ids> --fleet <id>`), release the members you know are done, or reconcile it by name from a session that supervises any fleet here |
| `fleet <id> has an active run whose last tick was at <ISO> (n tick(s), … ago, bound 10); nothing will land or advance until a session resumes the loop …` (`run-not-ticking`) | The run record is still active but nothing has ticked for > 2.5 min | The ticker is a timer inside the supervisor session: the session is busy or gone. Re-arm the fleet (or land/release the members); the run will not finish on its own |

### Release vs reconcile vs re-arm vs land

| Situation | Tool | What happens |
|---|---|---|
| You know a recorded member is not running, but you want to keep the bead, worktree, and transcript | `belayd_fleet_release { "taskId": "bd-15" }` | `released[]` entry (`operator-release`), `member-released` audit, slot free. Nothing removed. Refused while the orchestrator is live; idempotent |
| A member is provably dead and you want the record gone | `belayd_fleet_reconcile { "pruneDeadMembers": true }` **in that fleet's own supervisor session** | Member removed from `taskIds` (and its ordering gates resolved). Worktree, transcript, bead stay. Never prunes `unknown` |
| The supervisor session died and the fleet still holds slots | `/fleet <ids> --fleet <id>` (re-arm) | Supervisor record rewritten, members preserved (not relaunched), run loop restarted |
| The bead was merged and closed outside the fleet | nothing — wait for a tick, or `belayd_fleet_advance` isn't needed | The tick lands it when bd says `closed`/`done` **and** `git merge-base --is-ancestor <branch> <base>` succeeds. Then `taskIds` is pruned and `fleet-landed` is audited |
| A run finished or halted and left members | nothing — the run released them | `released[]` gets `run-complete` / `run-halted`; the members stay landable |

Rules of thumb:

- **A bead status alone never lands a member.** Closing a bead whose branch is not
  on the base leaves it recorded (and counted); land the branch, then wait for the
  tick, or release the member.
- **Release frees capacity; it does not stop work.** Use it when nothing is
  running. A live member is refused — stop it (`belayd_fleet_pause` force) or let
  it land.
- **`belayd_fleet_release` is own-fleet only.** It has no `fleetId` parameter and
  refuses unless this session is the fleet's live supervisor. To free a slot in a
  leaderless fleet you do not supervise, re-arm that fleet and release from there,
  or run a named-fleet reconcile (queue/park repair only).
- **Do not hand-edit `fleet.json` to drop ids.** A landing, a terminal run, a
  release, or a prune are the audited paths; a hand edit loses the audit trail and
  can leave an open ordering gate nobody can resolve.
- **A release does not survive the member.** Landing drops its `released[]` entry
  (the member no longer exists); re-launching that id as a new member also drops it,
  because a freshly launched member must hold a slot. A plain re-arm keeps it, so a
  released member stays released across a supervisor restart.

### `released[]` in `fleet.json`

```json
"released": [
  { "taskId": "bd-15", "reason": "operator-release", "at": 1793143454085 }
]
```

- Reasons are a closed enum: `operator-release` (the tool), `run-complete`, and
  `run-halted` (the terminal sweep). An unknown label makes the intent fail to
  parse, like an unknown `deferred[].reason`.
- It is **per fleet**: the same id released in fleet `a` still holds fleet `b`'s
  slot.
- It is the explicit statement "do not count this member's slot", and it outranks
  a stale liveness probe: a released member that later looks `unknown` or `live`
  is still not counted.
- Bounded to the same cap as `taskIds` (256); the status line shows 8 plus
  `...and N more`.
- The member is not removed: `taskIds`, `deferred`, the mailbox, the bead, the
  worktree, and the transcript are untouched, and a later landing still sees it.

### When a fleet is `capacity-held`

1. `belayd_fleet_status` — read the `capacity:` lines for the fleet named in the
   warning: how many members, and how many are `live`, `unknown`, `absent`.
2. Look for `stale-member` lines in the same output: recorded members with no
   worktree are the usual holders in a fleet whose supervisor died.
3. Is the supervisor really gone? `jq -c '.supervisor' <git-common-dir>/belayd/fleet/<id>/fleet.json`
   gives the recorded session/pid; in run mode `supervisor.json` `heartbeatAt`
   tells you when it last ticked (3 min of silence = gone).
4. Re-arm from a session in that repository (`/fleet <member ids> --fleet <id>`);
   this preserves members and restarts the loop, and it is also what makes
   `belayd_fleet_reconcile` / `belayd_fleet_release` usable from this session.
5. For members you know are finished: `belayd_fleet_release { "taskId": … }`. For
   members you know are gone and want erased: `belayd_fleet_reconcile { "pruneDeadMembers": true }`.
   Prefer release while you still want the record.
6. Verify with a fresh `belayd_fleet_status`: `M counted` should drop and the
   `capacity-held` warning disappear.

### When a run is `run-not-ticking`

1. Do not wait for it: the ticker lives in a session, and a stopped ticker cannot
   land or advance anything.
2. `belayd_fleet_status` shows the last tick, the tick count, and every member's
   state — that is the ground truth, not the run record.
3. Re-arm the fleet (`/fleet <ids> --fleet <id>`) to start a new run over the
   preserved members. The loop resumes landing/advancing from the next tick.
4. If you would rather not run the loop, finish by hand: merge the branches and
   let the outside-fleet landing pick them up (bead closed **and** branch on the
   base), or `belayd_fleet_release` the members whose work is gone.
5. A halted run (parked or stalled) is terminal: `belayd_fleet_resume` only
   restarts a *paused* run, so a halted one continues through a re-arm.

### Limits, stated plainly

- **Capacity is conservative by design.** `unknown` counts. A member whose
  worktree was deleted is `unknown` until it is released or pruned; a member whose
  `/proc` scan failed, whose lease is corrupt, or whose worktree cannot be
  `stat`ed stays `unknown` too.
- **`absent` needs evidence of the member's own execution.** An inherited
  same-task run manifest, or a manifest with no available cutoff, is not evidence
  — the slot stays counted. This is deliberate: the alternative is starting a
  fourth orchestrator on a worktree that is being spawned right now.
- **A release is not cross-fleet.** There is no way to release another fleet's
  member through the tool; the audited path is that fleet's own supervisor.
- **A paused run holds its slots.** Only a finish, a halt, a landing, an absence,
  or a release frees them.
- **The outside-fleet landing needs both facts.** A closed bead alone is not a
  landing, and a failed git probe answers "not landed". A member whose branch was
  deleted after the merge needs `belayd_fleet_release` or a reconcile.
- **The sweep is one member bead per tick**, rotating with `run.ticks`, so a
  hand-merged member in a large fleet is noticed within a fleet-sized cycle
  (minutes), not on the next 15 s tick.
- **A stopped member is not a leak by itself.** It stays in `taskIds` so its
  worktree, bead, and a later landing still work; the terminal run releases its
  slot, and a live lease is never released.

Related: `docs/fleet.md` (the operator map and decision table),
`docs/fleet-run.md` (the tick, the run record, terminal release),
`docs/fleet-status.md` (the `capacity:` block and the warning rows),
`docs/fleet-launch.md` (what a launch counts), `docs/fleet-reconcile.md`
(liveness and the named-fleet authority rule), `docs/fleet-orchestrator.md`
(the design record and the evidence cutoff).
