# Fleet run loop survives a supervisor restart (bd-169)

A fleet run-mode supervisor's authority was an **in-memory arm token**. When its
session or the pi-web daemon restarted, the token was gone, `session_start` found
nothing it could restore, returned quietly, and the run loop was dead for good —
while the run record still looked active. Wave2 is the evidence: 6/6 beads
finished, nothing landed, nothing warned, and the record froze at `ticks: 3` with
no `haltedReason` and no `finishedAt`. `belayd_fleet_status` kept calling the run
active for the ~9 hours it sat unlanded.

bd-169 makes a restart repairable and makes every loss loud:

| What happens now | Where it shows |
|---|---|
| `session_start` sweeps **every fleet id** and re-adopts its own active run when the record names this session, the run is still active, and the supervisor beat is cold | notify `re-adopted the active run after a restart (…)` + `supervisor-readopted` in `audit.log` |
| The beat (`10 min`) decides "cold", not the recorded pid | `<git-common-dir>/belayd/fleet/<id>/supervisor.json` |
| A loop that loses authority, or loses its fleet record, reports instead of dying | `supervisor-lost` / `supervisor-intent-lost` + a warning naming `/fleet <ids> --fleet <id>` |
| An active run nobody can be expected to pick up is reported, at most once per fleet per 10 min | `supervisor-readopt-refused` |
| A refused or failed adoption is reported, never silent | `supervisor-readopt-skipped` / `supervisor-readopt-failed` / `supervisor-readopt-refused` |
| `belayd_fleet_advance` restarts a missing timer for the run it supervises | `fleet-run-restarted` |

The arm token is still never written to disk (W6): the anchors are the session id,
a cold beat, and an existing active run, and every adoption is audited and
announced.

## How to Verify

Everything runs from the repository root of this checkout.

### 1. The tests that pin it

```bash
pnpm test -t "bd-169"                              # 2 files, 19 tests
pnpm test src/__tests__/fleet-heartbeat.test.ts    # 1 file, 23 tests (planSupervisorReadoption)
pnpm test src/__tests__/extension-fleet-p1.test.ts # 1 file, 125 tests
```

| Behaviour | Case to look for |
|---|---|
| Adoption happens, and the loop ticks afterwards | `re-adopts the active run of a restarted supervisor and ticks it` |
| Cold-beat boundary (adopts at exactly 10 min, refuses 1 ms inside) | `adopts at the staleness boundary but not one millisecond inside it` |
| Record names another session / no record / empty session id | `never adopts another session's fleet, even with a cold beat`, `reports an active run whose record has no usable supervisor (bd-169 W5)`, `distinguishes an empty supervisor session id from a missing record (bd-169)` |
| Read→write race (another session re-armed in between) | `refuses to adopt when the record gains a token between scan and write (bd-169 W4)`, `refuses the adoption when only the recorded pid drifted (bd-169 W2)` |
| One fleet per session, newest run wins, id tie-break | `adopts only the newest of two fleets that name this session (bd-169)`, `breaks a tie between equally new runs by fleet id (bd-169)` |
| Leaderless report: cold beat reports, fresh beat and the 10-min cooldown stay quiet | `reports a leaderless run once its beat is cold (bd-169 W1)`, `stays quiet about a leaderless run whose beat is fresh (bd-169 W1)`, `reports a leaderless run once per cooldown window (bd-169 W2)` |
| A lost loop is reported; an explicit fleet stays quiet | `reports a tick that lost its authority with the re-arm command`, `stays quiet about an explicit fleet that has no run record (bd-169 W5)` |
| `belayd_fleet_advance` restarts a missing timer, never double-schedules | `restarts the timer when an advance finds an active run with no loop`, `does not chain a second timer when ensure runs twice in a row (bd-169)`, `keeps the cadence when an advance runs inside a tick that is in flight (bd-169)` |
| A sub-agent session never adopts | `never adopts from a sub-agent session (bd-169)` |

### 2. Read the fields that prove the old bug

A frozen run is an **active** run (no `finishedAt`, no `haltedReason`) whose
`run.ticks`/`run.updatedAt` stopped moving while `belayd_fleet_status` still calls
it active. On any repository with a fleet:

```bash
fd=$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet/default
ls -1 "$fd"                      # fleet.json  supervisor.json  audit.log (once anything was audited)

# ticks | last tick | finishedAt | haltedReason | recorded supervisor session
jq -r '[.run.ticks, (.run.updatedAt/1000|todate), (.run.finishedAt//"none"),
        (.run.haltedReason//"none"), (.supervisor.sessionId//"none")] | @tsv' "$fd/fleet.json"

# beat session | last beat | age in seconds
jq -r '[.sessionId, (.heartbeatAt/1000|todate),
        (((now*1000) - .heartbeatAt)/1000|floor)] | @tsv' "$fd/supervisor.json"
```

The frozen-run signature is `finishedAt none`, `haltedReason none`, a `run.updatedAt`
minutes-to-hours old, and a `supervisor.json` age of the same order (or the file
missing). A healthy run has a beat a few seconds old, because the loop rewrites it
on **every** tick (`FLEET_RUN_TICK_INTERVAL_MS` = 15 s).

### 3. Reproduce the repair on a scratch repo

The driver registers the real extension, fires its `session_start` handler (which
is where re-adoption lives), and can call fleet tools. Save it once:

```bash
repo=$PWD                     # this checkout
J=$repo/node_modules/.bin/jiti

cat > /tmp/bd169-fleet.ts <<'TS'
// usage: jiti bd169-fleet.ts <harness-checkout> <repo-cwd> <sessionId> '<json steps>'
interface FleetTool {
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ text: string }>;
    details: { exitCode: number };
  }>;
}
const [repo, cwd, sessionId = "demo-session", stepsJson = '["start","status"]'] =
  process.argv.slice(2);
if (repo === undefined || cwd === undefined) throw new Error("<repo> <cwd> [sessionId] [steps]");
const steps = JSON.parse(stepsJson) as string[];

const tools = new Map<string, FleetTool>();
const sessionStart: Array<(event: unknown, ctx: unknown) => unknown> = [];
const mod = (await import(`${repo}/extensions/index.ts`)) as { default: (api: unknown) => void };
const api = {
  registerTool: (def: FleetTool & { name: string }) => tools.set(def.name, def),
  registerCommand: () => {},
  on: (event: string, handler: unknown) => {
    if (event === "session_start") {
      sessionStart.push(handler as (e: unknown, c: unknown) => unknown);
    }
  },
  sendMessage: () => {},
  appendEntry: () => {},
  setSessionName: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
  events: { emit: () => {}, on: () => () => {} },
};
mod.default(api);

const ctx = {
  cwd,
  ui: {
    notify: (message: string, level?: string) => {
      console.log(`[notify:${level ?? "info"}] ${message}`);
    },
  },
  sessionManager: {
    getSessionId: () => sessionId,
    getSessionName: () => "fleet-supervisor-demo",
    getSessionFile: () => `${cwd}/session.jsonl`,
  },
};

for (const step of steps) {
  if (step === "start") {
    console.log("=== session_start");
    for (const handler of sessionStart) await handler({}, ctx);
  } else if (step.startsWith("sleep:")) {
    const ms = Number(step.slice("sleep:".length));
    console.log(`\n… ticker runs for ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, ms));
  } else {
    const name = step === "advance" ? "belayd_fleet_advance" : "belayd_fleet_status";
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    console.log(`\n=== ${name}`);
    const result = await tool.execute("doc", {}, undefined, undefined, ctx);
    console.log(result.content.map((part) => part.text).join("\n"));
    console.log(`[${name} exit=${result.details.exitCode}]`);
  }
}
process.exit(0);
TS
```

Now the wave2 shape: an **active** run at `ticks: 3` whose supervisor record names
`demo-session`, a beat that went cold 10 minutes ago, and one member that is still
working (so the loop waits instead of finishing):

```bash
root=/tmp/bd169-restart
rm -rf "$root" "$root".feat-*; mkdir -p "$root" && cd "$root"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
git worktree add -q -b feat/bd-90 "$root.feat-bd-90"
mkdir -p "$root.feat-bd-90/.belayd"
cat > "$root.feat-bd-90/.belayd/workflow.json" <<JSON
{"schemaVersion":1,"taskId":"bd-90","workflowType":"feature","branch":"feat/bd-90","originalCwd":"$root.feat-bd-90","phaseOrder":["plan","implement","review","test","userguide","proof","commit"],"completedPhaseNames":["plan","implement"],"startedAt":1761000000000,"updatedAt":1761000900000}
JSON
now=$(node -e 'console.log(Date.now())')
printf '{"schemaVersion":1,"taskId":"bd-90","branch":"feat/bd-90","sessionId":"sess-live","pid":%s,"claimedAt":%s,"heartbeatAt":%s}' "$$" "$now" "$now" \
  > "$root.feat-bd-90/.belayd/orchestrator.json"

fd="$root/.git/belayd/fleet/default"; mkdir -p "$fd"
old=$(( now - 600000 ))                       # 10 minutes of silence: a cold beat
jq -nc --argjson old "$old" '{schemaVersion:1,fleetId:"default",taskIds:["bd-90"],createdAt:1,updatedAt:$old,maxConcurrent:3,baseBranch:"main",run:{schemaVersion:1,mode:"until-complete",startedAt:$old,updatedAt:$old,ticks:3,accept:false,members:[{taskId:"bd-90",launchedAt:$old}]},supervisor:{sessionId:"demo-session",pid:999999}}' \
  > "$fd/fleet.json"
jq -nc --argjson old "$old" '{schemaVersion:1,fleetId:"default",sessionId:"demo-session",pid:999999,heartbeatAt:$old}' \
  > "$fd/supervisor.json"
jq -c '{ticks:.run.ticks,haltedReason:.run.haltedReason,finishedAt:.run.finishedAt}' "$fd/fleet.json"
```

```text
{"ticks":3,"haltedReason":null,"finishedAt":null}
```

That is the bug: active, frozen, and nothing will ever change it. Now start a
session in that repository (`session_start`, i.e. a restart of the supervisor
session, which hand-editing `supervisor.json` to an old `heartbeatAt` emulates):

```bash
cd "$root" && "$J" /tmp/bd169-fleet.ts "$repo" "$root" demo-session '["start","sleep:20000","status"]'
```

```text
=== session_start
[notify:info] This session supervises a fleet — renamed to "Fleet supervisor: bd-90".
[notify:info] Fleet default: re-adopted the active run after a restart (cold-beat); the loop is ticking again.

… ticker runs for 20000 ms

Fleet default
  intent: bd-90, max 3 concurrent
  run: until-complete — 5 tick(s), last tick …Z
  members: 1
  states: active=1 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0
  capacity: ceiling 3, 2 free, 1 counted
    default: 1 member(s), 1 counted (1 live, 0 unknown, 0 absent), 0 stopped, 0 released; supervisor live
```

`belayd_fleet_status` warnings about `bd` being unavailable are expected in a
scratch repo without a beads database; they are not part of this behaviour.

### 4. Confirm what the adoption wrote

```bash
jq -c '{ticks:.run.ticks,finishedAt:.run.finishedAt,haltedReason:.run.haltedReason}' "$fd/fleet.json"
jq -c '{sessionId,heartbeatAt}' "$fd/supervisor.json"
jq -c '.supervisor' "$fd/fleet.json"
grep supervisor-readopted "$fd/audit.log"
```

```text
{"ticks":5,"finishedAt":null,"haltedReason":null}
{"sessionId":"demo-session","heartbeatAt":1793173362930}
{"sessionId":"demo-session","pid":920930,"pidStartTime":"84498994","armToken":"1e11eae5-…"}
{"timestamp":1793173332701,"fleetId":"default","actor":"demo-session","action":"supervisor-readopted","taskIds":["bd-90"],"detail":"cold-beat; previous heartbeat 601369 ms old; run at tick 3"}
```

Three facts to check: the run is **still active** (`finishedAt`/`haltedReason`
unchanged), `ticks` grew from 3, and the record now carries a **fresh** `armToken`
plus a beat written by this session (`heartbeatAt` a second or two old). The audit
detail says which anchor authorised it — `cold-beat`, `missing-beat`, or `pid-dead`.

`ticks` growing within ~15 s is the whole point: the ticker is running again, so
landing and advancing resume.

### 5. Confirm a lost loop is reported

**Authority lost mid-run** (`supervisor-lost`), and **`belayd_fleet_advance`
reviving the loop** (`fleet-run-restarted`). Both need one live session, because
the arm token lives in memory: the run below adopts the fleet, has its token
rotated out from under it, and then gets the record back and is poked with the
tool. A separate scratch repo, so the previous step's session cannot interfere:

```bash
lost=/tmp/bd169-lost
rm -rf "$lost" "$lost".feat-*; mkdir -p "$lost" && cd "$lost"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
git worktree add -q -b feat/bd-90 "$lost.feat-bd-90"
mkdir -p "$lost.feat-bd-90/.belayd"
cat > "$lost.feat-bd-90/.belayd/workflow.json" <<JSON
{"schemaVersion":1,"taskId":"bd-90","workflowType":"feature","branch":"feat/bd-90","originalCwd":"$lost.feat-bd-90","phaseOrder":["plan","implement","review","test","userguide","proof","commit"],"completedPhaseNames":["plan","implement"],"startedAt":1761000000000,"updatedAt":1761000900000}
JSON
now=$(node -e 'console.log(Date.now())')
printf '{"schemaVersion":1,"taskId":"bd-90","branch":"feat/bd-90","sessionId":"sess-live","pid":%s,"claimedAt":%s,"heartbeatAt":%s}' "$$" "$now" "$now" \
  > "$lost.feat-bd-90/.belayd/orchestrator.json"

fd="$lost/.git/belayd/fleet/default"; mkdir -p "$fd"
old=$(( now - 600000 ))
jq -nc --argjson old "$old" '{schemaVersion:1,fleetId:"default",taskIds:["bd-90"],createdAt:1,updatedAt:$old,maxConcurrent:3,baseBranch:"main",run:{schemaVersion:1,mode:"until-complete",startedAt:$old,updatedAt:$old,ticks:3,accept:false,members:[{taskId:"bd-90",launchedAt:$old}]},supervisor:{sessionId:"demo-session",pid:999999}}' \
  > "$fd/fleet.json"
jq -nc --argjson old "$old" '{schemaVersion:1,fleetId:"default",sessionId:"demo-session",pid:999999,heartbeatAt:$old}' \
  > "$fd/supervisor.json"

cd "$lost"
"$J" /tmp/bd169-fleet.ts "$repo" "$lost" demo-session \
  '["start","sleep:20000","sleep:20000","advance"]' \
  > /tmp/bd169-run.log 2>&1 &
drv=$!

sleep 4
cp "$fd/fleet.json" /tmp/bd169-adopted.json            # the record this session adopted
jq '.supervisor.armToken="rotated-token"' "$fd/fleet.json" > "$fd/fleet.json.tmp" \
  && mv "$fd/fleet.json.tmp" "$fd/fleet.json"          # another writer re-armed the fleet

sleep 20                                               # next tick loses authority
jq '. + {deferred:[{taskId:"bd-19",reason:"capacity",detail:"no free slot"}]}' \
  /tmp/bd169-adopted.json > "$fd/fleet.json.tmp" && mv "$fd/fleet.json.tmp" "$fd/fleet.json"

wait $drv
grep -v "bd gate\|no beads\|Hint:\|BEADS_DIR\|or set" /tmp/bd169-run.log | grep -E "notify|Advancing|exit="
grep -E "supervisor-lost|fleet-run-restarted" "$fd/audit.log"
```

```text
[notify:warning] Fleet default: run loop stopped — this session is no longer the live supervisor (no fleet record grants this session supervisor authority). Nothing lands or advances until a session ticks it: re-arm with `/fleet bd-90 --fleet default` or call `belayd_fleet_advance` from the supervisor session.
[notify:info] Fleet default: run loop restarted — this session is ticking the active run again.
[belayd_fleet_advance exit=0]
{"timestamp":…,"fleetId":"default","actor":"demo-session","action":"supervisor-lost","taskIds":["bd-90"],"detail":"no fleet record grants this session supervisor authority"}
{"timestamp":…,"fleetId":"default","actor":"demo-session","action":"fleet-run-restarted","taskIds":["bd-90","bd-19"],"detail":"no timer was scheduled for the active run (tick 4)"}
```

The authority stop is deliberately **not** written as `haltedReason`: another
session may already own that record, and marking it halted would kill a live loop.
The advance then reports `1 deferred member(s) (bd-19) re-scheduled` and tries to
launch it; in this scratch repo that spawns a real detached session and fails on
the missing beads database — ignore it, the point is the restarted timer. A loop
that is already ticking is left alone (no `fleet-run-restarted`, no second
timer), and an advance called from inside a tick keeps the tick's own cadence.

**A leaderless run** (`supervisor-readopt-refused`) — active run, **no** usable
supervisor (no `supervisor` key, or an empty session id), cold beat:

```bash
orphan=/tmp/bd169-orphan
rm -rf "$orphan"; mkdir -p "$orphan" && cd "$orphan"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
od="$orphan/.git/belayd/fleet/default"; mkdir -p "$od"
old=$(( $(node -e 'console.log(Date.now())') - 900000 ))
jq -nc --argjson old "$old" '{schemaVersion:1,fleetId:"default",taskIds:["bd-70"],createdAt:1,updatedAt:$old,maxConcurrent:3,baseBranch:"main",run:{schemaVersion:1,mode:"until-complete",startedAt:$old,updatedAt:$old,ticks:3,accept:false,members:[]}}' \
  > "$od/fleet.json"
jq -nc --argjson old "$old" '{schemaVersion:1,fleetId:"default",sessionId:"gone-session",pid:999999,heartbeatAt:$old}' \
  > "$od/supervisor.json"

cd "$orphan" && "$J" /tmp/bd169-fleet.ts "$repo" "$orphan" demo-session '["start"]'
cat "$od/audit.log"
```

```text
=== session_start
[notify:warning] Fleet default: the active run has no usable supervisor record (no-supervisor-record; beat 901460 ms old), so nothing is ticking it. Recover with `/fleet bd-70 --fleet default`.
{"timestamp":…,"fleetId":"default","actor":"demo-session","action":"supervisor-readopt-refused","taskIds":["bd-70"],"detail":"no-supervisor-record; beat 901460 ms old; no supervisor record"}
```

Run it again from a **different** session id inside that 10-minute window and it
stays quiet — the report is deduped against the fleet's own `audit.log` — and a
**fresh** beat also stays quiet, because a fresh beat means some session is
ticking that run even though the record does not say which (pinned by
`stays quiet about a leaderless run whose beat is fresh (bd-169 W1)`):

```bash
cd "$orphan"
"$J" /tmp/bd169-fleet.ts "$repo" "$orphan" another-session '["start"]'   # deduped: no notification
jq '.heartbeatAt = (now*1000|floor)' "$od/supervisor.json" > "$od/supervisor.json.tmp" \
  && mv "$od/supervisor.json.tmp" "$od/supervisor.json"
"$J" /tmp/bd169-fleet.ts "$repo" "$orphan" third-session '["start"]'     # fresh beat: still silent
```

**The in-flight variant** (`supervisor-intent-lost`) is the same stop when the
record disappears between the loop's authority check and its own re-read — a race,
so it is pinned by a test rather than staged by hand:

```bash
cd "$repo" && pnpm test -t "halts when the fleet record disappears while an advance is in flight"
```

Deleting `fleet.json` outright while a loop runs reports `supervisor-lost` instead
(authority can no longer be re-derived) — same loud stop, different audit action.

### 6. Clean up

```bash
rm -rf /tmp/bd169-restart /tmp/bd169-restart.feat-* /tmp/bd169-lost /tmp/bd169-lost.feat-* \
       /tmp/bd169-orphan /tmp/bd169-adopted.json /tmp/bd169-run.log /tmp/bd169-fleet.ts
```

## How to Use

### A restart no longer kills a run

A supervisor whose session or daemon restarts re-adopts its own active run on the
next `session_start`, when the record names it, the run is still active, and its
beat is cold (older than 10 minutes, missing, or written by another session).
Nothing to type: it mints a fresh arm token, rewrites the record and the beat,
restarts the ticker, audits `supervisor-readopted`, and notifies with the reason.
The run continues from its persisted record, so already-landed members are not
re-landed and already-stopped members are not relaunched.

The anchor is a **cold** beat, so a restart that happens within 10 minutes of the
last tick is repaired only once the beat ages out. Until then the record still
looks supervised: `session_start` declines quietly (`beat-live`) and a re-arm is
refused — from the same session as `already a member of fleet …, supervised by
live session …`, from any other session as `already supervised by live session …`.
The run is not lost; it is frozen, and `belayd_fleet_status` already warns
(`run-not-ticking` after 2.5 minutes). Fix it after the window by opening the
supervisor session again, or by re-arming.

### When the supervisor session is gone

| Situation | What to do |
|---|---|
| The supervisor session still exists and can be opened/resumed | Open it. It re-adopts on `session_start` once its beat is cold (10 min without a tick) |
| It will not come back | Re-arm from another session: `/fleet <ids> --fleet <id>` (members are preserved, the loop restarts) — also once the beat is cold |
| The run is active but its record names **nobody** | Any new session reports it (warning + `supervisor-readopt-refused`) with exactly that `/fleet <ids> --fleet <id>` command; re-arm there |
| The run is finished or halted | Nothing to recover: that outcome was already announced and audited. A halted run needs a re-arm, not a resume |
| You want the loop back without re-arming | `belayd_fleet_advance` in the supervisor session restarts a missing timer (`fleet-run-restarted`) |

Recovery always starts from the fleet's own records, so read them first:

```bash
fd=$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet/<id>
jq -r '[.run.ticks, (.run.updatedAt/1000|todate), (.run.finishedAt//"none"),
        (.run.haltedReason//"none"), (.supervisor.sessionId//"none")] | @tsv' "$fd/fleet.json"
jq -r '[.sessionId, (((now*1000) - .heartbeatAt)/1000|floor)] | @tsv' "$fd/supervisor.json"
```

### One fleet per session

A session supervises one fleet. If its record names this session for two fleets,
the one with the newest `run.updatedAt` (tie broken by fleet id) is adopted and the
other is reported with its own recovery command:

```text
Fleet alpha: not re-adopted — this session supervises one fleet, and `zulu` holds the newer active run. If its run should continue, re-arm it from another session with `/fleet bd-12 --fleet alpha`.
```

That is a `supervisor-readopt-skipped` audit entry, and such notices are only
written after the adoption actually succeeded.

### What each report means

| Notify / audit action | Meaning | Recovery |
|---|---|---|
| `supervisor-readopted` | This session took its own run back after a restart | none — the loop is ticking |
| `supervisor-lost` | A tick found this session is no longer the fleet's live supervisor (another session re-armed, or no record grants authority) | `/fleet <ids> --fleet <id>`, or `belayd_fleet_advance` in the supervisor session |
| `supervisor-intent-lost` | The fleet record vanished or became unreadable mid-tick or mid-advance | restore/reconcile the record, then `/fleet <ids> --fleet <id>` |
| `supervisor-readopt-refused` | An active run has no usable supervisor and nobody is beating it | `/fleet <ids> --fleet <id>` (at most one report per fleet per 10 min) |
| `supervisor-readopt-failed` | The adoption write was refused — another session re-armed the fleet, or the run finished, between the sweep and the write | `/fleet <ids> --fleet <id>` from the session you want to supervise it |
| `supervisor-readopt-skipped` | A second fleet this session could have adopted (one fleet per session) | `/fleet <ids> --fleet <id>` from another session |
| `fleet-run-restarted` | `belayd_fleet_advance` found an active run with no timer and started one | none |

The loss and refusal reports (`supervisor-lost`, `supervisor-intent-lost`,
`supervisor-readopt-refused`, `-failed`, `-skipped`) also write a `console.warn`
line prefixed `[belayd-harness]`, so the daemon log carries the same text as the
UI. The two success reports (`supervisor-readopted`, `fleet-run-restarted`) only
notify and audit.

### When `belayd_fleet_status` is still the surface

The leaderless report is a **wedge alarm**, not a per-start pulse: it is written at
most once per fleet per 10-minute window, and the anchor is the last report (not
the beat's age), so a wedge that disappears and returns inside the window stays
suppressed. In those cases, and whenever the supervisor session never comes back,
`belayd_fleet_status` keeps the `run-not-ticking` warning as the backstop:

```text
- fleet default has an active run whose last tick was at 2026-10-28T07:13:06.421Z (3 tick(s), 40 tick interval(s) ago, bound 10); nothing will land or advance until a session resumes the loop (re-arm the fleet) or an operator releases/lands the members
```

Read it as: the record is active but silent for more than `10 × 15 s` = 2.5
minutes. Nothing is lost — the members, beads and worktrees are intact — but
nothing lands or advances until some session ticks it.

### Rules of thumb

- **Do not delete or hand-edit `supervisor.json` to "unstick" a fleet.** It is the
  anchor the repair reads; making it look cold is what lets the repair happen, but
  editing it to look *fresh* hides a dead loop from the next session start.
- **Do not hand-edit `fleet.json`'s `supervisor` block either.** A wrong `armToken`
  makes the running loop stop with `supervisor-lost` (loud, but it costs you the
  loop), and the audited paths are `/fleet`, `belayd_fleet_advance`, and
  `belayd_fleet_resume`.
- **Re-arming and re-adopting are different.** A re-arm (`/fleet <ids> --fleet <id>`)
  is an operator act: it rewrites the record and starts a new run record in place
  of a halted one. Re-adoption is automatic, only for an **active** run, and only
  on `session_start`.
- **`belayd_fleet_resume` is unchanged** — it still goes through
  `resumeFleetRunLoop` and is for a *paused* run, not a lost loop.

## What is not covered

- **Explicit `--manual` fleets are untouched.** They have no run record, so they are
  never adopted and never warned about; the legacy pid-based rule still decides
  whether they can be re-armed.
- **A record with an empty session id is reported, not adopted.** It names no
  session, so no session may claim it — the report says so and names the re-arm
  command.
- **Repair waits for the beat to go cold.** A restart that lands inside the
  10-minute window (or a beat left fresh by the old process) is not repaired by
  that `session_start`, and a re-arm is refused meanwhile. The deterministic
  escape is a fresh launch or an `--manual` recovery; otherwise the repair is one
  window away, and `belayd_fleet_status`'s run-not-ticking warning covers it.
- **A copied fresh beat delays the repair.** A beat copied from another fleet (or
  written by a session that has since vanished) makes the run look supervised for
  up to 10 minutes, which delays re-adoption by that window. The report stays
  quiet until then; `belayd_fleet_status`'s run-not-ticking warning still fires
  after 2.5 minutes.
- **The sweep is not a push alert.** A run repairable only by a session that is
  never opened again is reported to whoever starts a session in that repository,
  and to `belayd_fleet_status` readers. Nothing pages a human.
- **Adoption cannot be made unforgeable** without persisting the arm token (W6), so
  it is loud: notify, `console.warn`, and an audit entry naming the previous
  supervisor beat on every adoption.

Related: `docs/fleet-run.md` (the tick, the run record, the readoption rule),
`docs/fleet-status.md` (warnings), `docs/fleet.md` (operator map),
`src/fleet-heartbeat.ts` (`FLEET_SUPERVISOR_HEARTBEAT_STALE_MS`,
`planSupervisorReadoption`), `src/fleet-run.ts` (tick cadence, run record),
`extensions/capabilities/fleet.ts` (`readoptFleetRuns`, `ensureFleetRunTimer`).
