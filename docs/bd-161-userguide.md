# Fleet ignores run manifests it did not create (bd-161)

`.belayd/` is gitignored, and `.config/wt.toml` copies ignored files into every
new worktree (`[[pre-start]] copy = "wt step copy-ignored"`). A freshly launched
fleet member therefore inherited the **primary checkout's** `.belayd/runs/*.json`
— including an old, unrelated `bd-37` `implement` failure (no `failureReason`).
The run loop read that file as the member's newest run, derived
`{ kind: "phase-failed", detail: "phase implement failed" }`, and stopped the
member within milliseconds of launch while its orchestrator was still scouting.

bd-161 makes the fleet trust only runs that belong to the member. Three rules
plus one policy switch, implemented once in `runsBelongingToMember`
(`src/fleet-run.ts:252`):

| Rule | Effect |
|---|---|
| `run.taskId === member taskId` | another bead's manifest is never this member's evidence |
| `run.startedAt >= launchedAt` (launch cutoff) | a manifest written before the launch belongs to a previous execution — re-launching the *same* task into a fresh worktree inherits its own old manifests too |
| a same-task `running` run always counts, whatever its `startedAt` | a live run proves an execution is happening now; dropping it would fall through to `missing` and stop a healthy member as `orchestrator-missing` |
| `failuresRequireLaunch` (policy) | with no known launch time, `failed`/`interrupted` runs are not evidence (task id proves ownership, not execution) |

Both readers use that one function:

| Reader | Entry point |
|---|---|
| the stop path (`planFleetTick` → member observations) | `deriveFleetMemberProgress` (`src/fleet-run.ts:277`), always `failuresRequireLaunch: true` |
| the read-only view (`belayd_fleet_status`) | `memberRuns` (`src/fleet-status.ts:431`) |

`belayd_fleet_status` also resolves the worktree's task id the way the loop does
(`runLoopTaskId`, `src/fleet-status.ts:403`: the branch's task id when the intent
owns it, else `workflow.json`'s) and takes `launchedAt` from
`fleet.json` `run.members` (`launchedAtFor`, `src/fleet-status.ts:416`).
Separately, `stopDecision`'s `missing` branch (`src/fleet-run.ts:602`) now
consults the live lease: a member whose state file is gone but whose worktree
still carries a live orchestrator claim is **not** stopped.

## How to Verify

Run everything from the repository root.

### 1. The targeted suites

```bash
pnpm vitest run src/__tests__/fleet-run.test.ts \
  src/__tests__/fleet-status.test.ts \
  src/__tests__/extension-fleet-p1.test.ts
```

Expected on `feat/bd-161`:

```text
 ✓ src/__tests__/fleet-run.test.ts (52 tests)
 ✓ src/__tests__/fleet-status.test.ts (106 tests)
 ✓ src/__tests__/extension-fleet-p1.test.ts (61 tests)

 Test Files  3 passed (3)
      Tests  219 passed (219)
```

Narrower, one command per cover:

```bash
# the shared filter, rule by rule (5 cases)
pnpm vitest run src/__tests__/fleet-run.test.ts -t "runsBelongingToMember"
# Tests  5 passed | 47 skipped (52)

# derive verdicts for inherited manifests (10 cases)
pnpm vitest run src/__tests__/fleet-run.test.ts \
  -t "run manifests inherited from the primary checkout"
# Tests  10 passed | 42 skipped (52)

# the status view (bd-161 block)
pnpm vitest run src/__tests__/fleet-status.test.ts -t "inherited"
# Tests  1 passed | 105 skipped (106)

# the tick-level regression: no stop, no notification
pnpm vitest run src/__tests__/extension-fleet-p1.test.ts \
  -t "ignores a run manifest inherited from the primary checkout"
pnpm vitest run src/__tests__/extension-fleet-p1.test.ts \
  -t "copied in from an earlier launch"
# Tests  1 passed | 60 skipped (61)   (each)
```

| Property | File:line | Case |
|---|---|---|
| Another task's manifest dropped for every status | `src/__tests__/fleet-run.test.ts:314` | `drops every manifest of another task, whatever its status` |
| Launch instant is kept, own pre-launch run dropped | `src/__tests__/fleet-run.test.ts:323`, `:332` | `keeps a run that started exactly at the launch instant`, `drops this task's own completed run from before the launch` |
| No launch time: cross-task failure ignored | `src/__tests__/fleet-run.test.ts:207` | `ignores another task's failed run when no launch time is known` |
| No launch time: same-task failure/interrupted not evidence | `src/__tests__/fleet-run.test.ts:229`, `:242` | `does not borrow a same-task failure when no launch time is known`, `does not borrow a same-task interrupted run when no launch time is known` |
| Same-task `running` survives the cutoff | `src/__tests__/fleet-run.test.ts:254` | `keeps a same-task run in flight even when it predates the launch` |
| Own post-launch failure still `phase-failed` | `src/__tests__/fleet-run.test.ts:270`, `:297` | `still reports the member's own failed run`, `still reports the member's own failed pending phase next to an inherited run` |
| `missing` + live lease waits, gone lease stops | `src/__tests__/fleet-run.test.ts:469`, `:481` | `waits on a missing member while a live lease holds its worktree`, `stops a missing member once no lease holds it` |
| Status view: inherited bd-37 manifest ignored | `src/__tests__/fleet-status.test.ts:547` | `ignores run manifests inherited from the primary checkout (bd-161)` |
| Status view: own pre-launch manifests ignored, no-launch record non-fatal | `src/__tests__/fleet-status.test.ts:577`, `:601` | `ignores this member's own manifests that predate its launch`, `does not attribute a same-task failure when the run records no launch` |
| Tick: inherited foreign manifest records no stop | `src/__tests__/extension-fleet-p1.test.ts:2046` | `ignores a run manifest inherited from the primary checkout` |
| Tick: own *pre-launch* manifest copied in also records no stop | `src/__tests__/extension-fleet-p1.test.ts:2083` | `ignores this member's own run manifest copied in from an earlier launch` |

Full gates:

```bash
pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
```

### 2. Manual reproduction — the tick's verdict

This driver calls the same pure functions the ticker does, against real manifest
files on disk. It needs no live fleet and no pi session.

```bash
repo=$PWD
cat > /tmp/bd-161-derive.ts <<TS
import {
  deriveFleetMemberProgress,
  planFleetTick,
  startFleetRun,
} from "${repo}/src/fleet-run.ts";
import { listRuns } from "${repo}/src/run-manifest.ts";

// usage: jiti /tmp/bd-161-derive.ts <member dir> [taskId] [launchedAt]
const memberDir = process.argv[2];
const taskId = process.argv[3] ?? "bd-12";
const launchedAtArg = process.argv[4];
const now = Date.now();
const launchedAt = launchedAtArg === undefined ? undefined : Number(launchedAtArg);

// No workflow state: the run manifests are the only input, which is exactly the
// shape of the bd-161 regression (a member that has not written anything yet).
const progress = deriveFleetMemberProgress({
  taskId,
  workflow: { kind: "missing" },
  runs: listRuns({ cwd: memberDir }),
  now,
  ...(launchedAt === undefined ? {} : { launchedAt }),
});
const intent = {
  schemaVersion: 1 as const,
  fleetId: "default",
  taskIds: [taskId],
  createdAt: now,
  updatedAt: now,
  run: startFleetRun({ now: launchedAt ?? now, accept: false, members: [{ taskId }] }),
};
const action = planFleetTick({
  intent,
  observations: [
    {
      taskId,
      progress,
      claim: "live" as const,
      ...(launchedAt === undefined ? {} : { launchedAt }),
    },
  ],
  now,
});
console.log("progress:", JSON.stringify(progress));
console.log("tick:", JSON.stringify(action));
TS
```

Create the lookalike stale manifest — the exact copied shape: a failed
`implement` run of a **different** task, no `failureReason`:

```bash
demo=/tmp/bd-161-demo
rm -rf "$demo" && mkdir -p "$demo/.belayd/runs"
cat > "$demo/.belayd/runs/mthosemh.json" <<'JSON'
{"schemaVersion":1,"runId":"mthosemh","taskId":"bd-37","phase":"implement","sessionName":"belayd-bd-37-sub-implement-mthosemh","status":"failed","startedAt":1788207858953,"completedAt":1788208222826,"exitCode":143}
JSON
```

Now derive with a launch time:

```bash
node_modules/.bin/jiti /tmp/bd-161-derive.ts "$demo" bd-12 "$(date +%s%3N)"
```

```text
progress: {"kind":"starting","detail":"launched, no phase has started yet"}
tick: {"kind":"wait","detail":"1 member(s) in flight: bd-12"}
```

Past the 120 s `FLEET_RUN_START_GRACE_MS` window the same manifest reads
`missing` instead of `starting` (still no stop):

```bash
node_modules/.bin/jiti /tmp/bd-161-derive.ts "$demo" bd-12 \
  "$(( $(date +%s%3N) - 130000 ))"
```

```text
progress: {"kind":"missing","detail":"no workflow state and no phase runs"}
tick: {"kind":"wait","detail":"1 member(s) in flight: bd-12"}
```

And when the launch time is unknown (omit the 4th argument — a member inherited
from an earlier launch or state file), the same reading holds:

```bash
node_modules/.bin/jiti /tmp/bd-161-derive.ts "$demo" bd-12
```

```text
progress: {"kind":"missing","detail":"no workflow state and no phase runs"}
tick: {"kind":"wait","detail":"1 member(s) in flight: bd-12"}
```

**No stop action is produced and no `run.stopped` entry would be written** — the
tick either waits, or (once the grace has passed) treats the member as
`missing`, which `stopDecision` escalates only to `orchestrator-missing`, and
only when no lease is live.

### 3. Contrast — the detector is not blinded

Same worktree, same status, but the manifest carries the member's **own** task id
and a `startedAt` after the launch:

```bash
now=$(date +%s%3N)
launched=$((now - 1000))
cat > "$demo/.belayd/runs/own-run.json" <<JSON
{"schemaVersion":1,"runId":"own-run","taskId":"bd-12","phase":"implement","sessionName":"belayd-bd-12-sub-implement-own-run","status":"failed","startedAt":$now,"completedAt":$((now + 1)),"failureReason":"gate failed"}
JSON
node_modules/.bin/jiti /tmp/bd-161-derive.ts "$demo" bd-12 "$launched"
```

```text
progress: {"kind":"phase-failed","detail":"phase implement failed: gate failed"}
tick: {"kind":"stop","taskId":"bd-12","reason":"phase-failed","detail":"phase implement failed: gate failed"}
```

A real own failure therefore still stops the member and records
`{"taskId":"bd-12","reason":"phase-failed","detail":"phase implement failed: gate failed"}`,
with the supervisor notification
`Fleet default: stopped bd-12 (phase-failed): phase implement failed: gate failed`.
The detail is `phase <phase> failed` plus `: <failureReason>` when the manifest
carries one; the inherited bd-37 manifest in step 2 has no `failureReason`, which
is why the pre-fix false positive read exactly `phase implement failed`.

### 4. Manual reproduction — the status view

`belayd_fleet_status` is a pi tool, so drive it through the extension with
`jiti`. This needs a real git repository plus a fleet intent, because the tool
walks `git worktree list` and reads `fleet.json` for the launch time. Note the
timestamps: `fleet.json` `launchedAt` must be earlier than the failure you want
attributed to the member, and `startedAt` in the manifest must be at or after
it.

```bash
repo=$PWD
cat > /tmp/bd-161-status.ts <<TS
interface Tool {
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ text: string }>;
    details: { exitCode: number };
  }>;
}
const mod = (await import("${repo}/extensions/index.ts")) as {
  default: (api: unknown) => void;
};
const tools = new Map<string, Tool>();
const api = {
  registerTool: (def: Tool & { name: string }) => tools.set(def.name, def),
  registerCommand: () => {},
  on: () => {},
  sendMessage: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
  events: { emit: () => {}, on: () => () => {} },
};
mod.default(api);
const tool = tools.get("belayd_fleet_status");
if (tool === undefined) throw new Error("belayd_fleet_status was not registered");
const result = await tool.execute("doc", {}, undefined, undefined, {
  cwd: process.argv[2],
});
console.log(result.content.map((part) => part.text).join("\n"));
process.exit(result.details.exitCode ?? 0);
TS
```

Scratch repo with one member worktree holding the inherited manifest:

```bash
demo=/tmp/bd-161-status-demo
rm -rf "$demo" "$demo.bd-12"
mkdir -p "$demo" && cd "$demo"
git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init
git worktree add -q -b feat/bd-12 "$demo.bd-12"

mkdir -p "$demo.bd-12/.belayd/runs" "$demo/.git/belayd/fleet/default"
cp /tmp/bd-161-demo/.belayd/runs/mthosemh.json "$demo.bd-12/.belayd/runs/mthosemh.json"
now=$(date +%s%3N)
cat > "$demo.bd-12/.belayd/workflow.json" <<JSON
{"schemaVersion":1,"taskId":"bd-12","workflowType":"feature","resolutionSource":"default","branch":"feat/bd-12","originalCwd":"$demo.bd-12","phaseOrder":["plan","implement","review","test","commit"],"completedPhaseNames":["plan"],"startedAt":$now,"updatedAt":$now}
JSON
cat > "$demo/.git/belayd/fleet/default/fleet.json" <<JSON
{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12"],"createdAt":$now,"updatedAt":$now,"run":{"schemaVersion":1,"mode":"until-complete","startedAt":$now,"updatedAt":$now,"ticks":1,"idleTicks":0,"accept":false,"members":[{"taskId":"bd-12","launchedAt":$now}],"stopped":[]}}
JSON
cd - >/dev/null
node_modules/.bin/jiti /tmp/bd-161-status.ts "$demo"
```

```text
Fleet default
  intent: bd-12
  run: until-complete — 1 tick(s), last tick ...
  members: 1
  states: active=1 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0

Member bd-12 — active
  worktree: /tmp/bd-161-status-demo.bd-12 (branch feat/bd-12)
  workflow: feature 1/5 phases complete
  pending: implement, review, test, commit
  awaiting review response: no
  interrupted runs: 0
  orchestrator lease: none
  last updated: ...
  latest runs: none
```

The inherited failure is invisible: `active`, `latest runs: none`,
`interrupted runs: 0`. (`bead metadata unavailable` warnings are expected in a
scratch repo with no beads database.) Before bd-161 the same fixture rendered
`blocked` with `latest runs: implement=failed`, contradicting the loop's
`starting` verdict for the same worktree.

Drop the member's own post-launch failure in and the view flips to the real
signal (`startedAt` after the `launchedAt` this `fleet.json` recorded):

```bash
now=$(date +%s%3N)
cat > "$demo.bd-12/.belayd/runs/own-run.json" <<JSON
{"schemaVersion":1,"runId":"own-run","taskId":"bd-12","phase":"implement","sessionName":"belayd-bd-12-sub-implement-own-run","status":"failed","startedAt":$now,"completedAt":$((now + 1)),"failureReason":"gate failed"}
JSON
node_modules/.bin/jiti /tmp/bd-161-status.ts "$demo"
```

```text
  states: active=0 blocked=1 awaiting-human=0 interrupted=0 idle=0 missing-state=0

Member bd-12 — blocked
  ...
  latest runs: implement=failed
```

### 5. What a real failure looks like vs the fixed false positive

| | False positive (bd-161, pre-fix) | Real failure (post-fix) |
|---|---|---|
| Manifest | `taskId: "bd-37"`, `status: "failed"`, no `failureReason`, no owner relation to the member | `taskId` = the member's own id, `startedAt` after `launchedAt` |
| Derived progress | `{ kind: "phase-failed", detail: "phase implement failed" }` | `{ kind: "phase-failed", detail: "phase implement failed: <failureReason>" }` |
| Tick | `{ kind: "stop", reason: "phase-failed" }` | `{ kind: "stop", reason: "phase-failed" }` |
| Status view | `blocked`, `latest runs: implement=failed` | `blocked`, `latest runs: implement=failed` |
| When it happens | milliseconds after launch, while the member is scouting | after the member actually ran the phase and failed |

The distinction is provenance, not shape: only the `taskId` match (and, for
terminal statuses, a `startedAt` at or after the member's launch) makes a failed
manifest this execution's failure.

## How to Use

Nothing to enable — the filter is always on. What changes for a fleet operator:

- **Inherited manifests are ignored.** A member that inherited the primary
  checkout's `.belayd/runs/` starts clean. With no run of its own yet it reads
  `starting` (`"launched, no phase has started yet"`) inside the 120 s
  `FLEET_RUN_START_GRACE_MS` window, then `missing`
  (`"no workflow state and no phase runs"`) — never `phase-failed`. A bit of
  early "nothing here" on a slow member is expected; it is not a failure.
- **`missing` no longer stops a member whose lease is live.** `stopDecision`
  returns no action while `claim === "live"`, so a member that lost or has not
  yet written `.belayd/workflow.json` but whose worktree still holds a live
  `orchestrator.json` claim keeps running. Once that lease is `stale`/`absent`
  (and the grace has passed) the tick still stops it with
  `orchestrator-missing`.
- **Unknown launch time means terminal failures are not evidence.** For a member
  the current run record did not launch (inherited from an earlier launch or a
  state file, so `fleet.json` `run.members` has no `launchedAt`), a `failed` or
  `interrupted` manifest is ignored by the loop (`failuresRequireLaunch: true`).
  The `status` view keeps it visible only when no run record exists at all,
  because then no loop is deciding that worktree. **Do not read fleet state as
  the verdict for such a member** — check the bead and the member's own output:

  ```bash
  bd show <id>                 # status, owner, labels, newest comments
  bd comments <id> --json
  ls <member-worktree>/.belayd/artifacts/   # scout.md, plan.md, implement.md, …
  cat <member-worktree>/.belayd/workflow.json
  ```

  `.belayd/artifacts/<phase>.md` is written by the phase itself, so it is
  evidence of progress that no copied manifest can fake.
- **One residual caveat.** A same-task manifest with `status: "running"` copied
  from a previous *crashed* execution still counts as `running` evidence — the
  in-flight bypass deliberately ignores the launch cutoff, because a live run
  must never fall through to `missing` and stop a healthy member. Two bounds
  apply: `runningMemberStop` (`src/fleet-run.ts:619`) never stops such a member
  while its orchestrator lease is `live`, and it *also* never stops a member
  whose launch time is unknown — so a stale `running` copy in an inherited
  worktree is only cleared by the run's stall halt
  (`FLEET_RUN_MAX_IDLE_TICKS` = 240 idle ticks) or by an operator stepping in.
  If a member reads `running` but writes no new artifacts, check the lease holder
  before believing it:

  ```bash
  cat <member-worktree>/.belayd/orchestrator.json
  ls <member-worktree>/.belayd/artifacts/
  ```

Related runbook: `docs/fleet.md` (entry point), `docs/fleet-run.md` (the tick and
the lease), `docs/fleet-status.md` (`belayd_fleet_status` fields and states).
