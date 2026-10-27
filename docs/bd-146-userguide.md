# Fleet run attribution by task id (bd-146)

A fresh worktree inherits `.belayd/runs/` from the base branch when a consumer
repository commits its run manifests, so a member that has never run a phase
could read another bead's completed, failed or interrupted manifests as its own:
a wrong `latest runs` line, a phantom `interrupted runs: 1`, a wrong `last
updated`, and a `blocked` state nobody caused.

bd-146 makes the fleet view derive a member's run evidence **only from manifests
whose `taskId` is that member's own**. The key is resolved the same way the run
loop resolves it — branch id when it names a fleet member, otherwise
`workflow.json`'s task id, otherwise the id the branch or directory name implies —
and with no resolvable id the manifests stay unfiltered so the view still reports
what it read.

| Piece | Where |
| --- | --- |
| `runLoopTaskId`, `expectedTaskIdFor`, `memberRuns` | `src/fleet-status.ts` |
| `runsBelongingToMember`, `deriveFleetMemberProgress` (the filter itself) | `src/fleet-run.ts` |
| Attribution cases | `src/__tests__/fleet-status.test.ts`, `src/__tests__/fleet-run.test.ts` |
| Operator reading | `docs/fleet.md` — "That block was captured before the run-ownership filter landed (bd-146/bd-161)" |

## How to Verify

Run from the repository root.

### 1. Targeted tests

```bash
pnpm exec vitest run src/__tests__/fleet-status.test.ts -t "bd-146"
```

Expected — the four attribution cases and nothing else:

```text
 ✓ src/__tests__/fleet-status.test.ts (110 tests | 106 skipped) 11ms

 Test Files  1 passed (1)
      Tests  4 passed | 106 skipped (110)
```

The four tests are:

- `reports only the workflow's own manifests out of a mixed set (bd-146)` — one
  `bd-12` `plan` manifest plus a newer `bd-16` manifest per foreign phase, so an
  unfiltered (or phase-only) filter would pick `bd16-plan`; asserts
  `latestRuns` ids are `["own-plan"]`, `interruptedRunCount = 0`,
  `state = "active"`, `updatedAt = 2000`.
- `still counts its own interrupted run among another task's manifests (bd-146)`
  — the opposite direction: own crash keeps `interruptedRunCount = 1`,
  `state = "interrupted"`, `counts.interrupted = 1`.
- `keeps its own completed final phase when the state file is gone (bd-146)` —
  no `workflow.json`, own `commit` manifest, foreign manifests newer: completion
  still derives from `own-commit`, `workflowFile = "missing"`,
  `updatedAt = 1950`.
- `reads a fresh worktree's committed manifests without adopting another task's
  (bd-146)` — same guarantee through the real reader `readFleetStatus`, ending in
  `latest runs: plan=completed`.

The run-loop half:

```bash
pnpm exec vitest run src/__tests__/fleet-run.test.ts
```

Expected `67 passed`, including `keeps deriving complete from its own final phase
among another task's manifests`.

Full gates:

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test               # 122 files / 2977 tests
pnpm test:integration   # 13 files / 98 tests
```

### 2. A reader harness (writes nothing into the repo)

```bash
pnpm build
cat > /tmp/bd146-check.mjs <<'JS'
const { readFleetStatus, formatFleetStatus } = await import(`${process.env.DIST}/src/fleet-status.js`);
const result = readFleetStatus({ cwd: process.argv[2], fleetId: "default" });
if (!result.ok) { console.error(result.error); process.exit(1); }
console.log(formatFleetStatus(result.value));
JS
```

`DIST` is always `$(pwd)/dist`, so every command below is run from the repo root.

### 3. Reproduce the committed-manifest case

A throwaway repo whose only worktree is `feat/bd-12`, with its own `plan` run and
three manifests belonging to `bd-16`/`bd-83` checked out alongside it (the
`bd16-plan` one is newer **and the same phase**, so only the task id separates
them):

```bash
root=/tmp/bd146-demo
rm -rf "$root" "$root".feat-bd-12 /tmp/bd146-anon
mkdir -p "$root" && cd "$root"
git init -q && git symbolic-ref HEAD refs/heads/main
git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && git add -A && git commit -qm base
git worktree add -q -b feat/bd-12 "$root.feat-bd-12"
wt="$root.feat-bd-12"
mkdir -p "$wt/.belayd/runs"
printf '%s' '{"schemaVersion":1,"taskId":"bd-12","workflowType":"feature","branch":"feat/bd-12","originalCwd":"'$wt'","phaseOrder":["plan","implement","review","test","userguide","proof","commit"],"completedPhaseNames":["plan"],"awaitingReviewResponse":false,"startedAt":1761000000000,"updatedAt":1761000900000}' > "$wt/.belayd/workflow.json"
run() { printf '%s' "{\"schemaVersion\":1,\"runId\":\"$2\",\"taskId\":\"$3\",\"phase\":\"$4\",\"sessionName\":\"belayd-$3-sub-$4\",\"status\":\"$5\",\"startedAt\":$6,\"completedAt\":$7}" > "$wt/.belayd/runs/$2.json"; }
run x own-plan bd-12 plan completed 1100 1200
run x bd16-plan bd-16 plan completed 3950 3970
run x bd16-commit bd-16 commit completed 3200 3300
run x bd83-implement bd-83 implement interrupted 3600 3700
cd - > /dev/null
ls /tmp/bd146-demo.feat-bd-12/.belayd/runs
DIST=$(pwd)/dist node /tmp/bd146-check.mjs /tmp/bd146-demo
```

Four manifests on disk, one attributed:

```text
bd16-commit.json
bd16-plan.json
bd83-implement.json
own-plan.json

Fleet default
  intent: none recorded
  members: 1
  states: active=1 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0

Member bd-12 — active
  worktree: /tmp/bd146-demo.feat-bd-12 (branch feat/bd-12)
  workflow: feature 1/7 phases complete
  pending: implement, review, test, userguide, proof, commit
  awaiting review response: no
  interrupted runs: 0
  orchestrator lease: none
  last updated: 2025-10-20T22:55:00.000Z
  latest runs: plan=completed
```

`plan=completed` is the member's own run, not `bd16-plan`; the foreign
`interrupted` manifest does not appear in `interrupted runs`; `last updated` is
`workflow.json`'s timestamp (`updatedAt 1761000900000`), not the newer inherited
manifest.

### 4. Missing `workflow.json` still derives completion from the member's own final phase

Completion clears `.belayd/workflow.json` while the manifests stay, so the
branch's task id is the only key left. Delete the state file and add only an own
`commit` manifest:

```bash
wt=/tmp/bd146-demo.feat-bd-12
rm "$wt/.belayd/workflow.json"
printf '%s' '{"schemaVersion":1,"runId":"own-commit","taskId":"bd-12","phase":"commit","sessionName":"belayd-bd-12-sub-commit","status":"completed","startedAt":1900,"completedAt":1950}' > "$wt/.belayd/runs/own-commit.json"
DIST=$(pwd)/dist node /tmp/bd146-check.mjs /tmp/bd146-demo
```

```text
Member (no task id) — missing-state
  worktree: /tmp/bd146-demo.feat-bd-12 (branch feat/bd-12)
  workflow: missing
  interrupted runs: 0
  orchestrator lease: none
  last updated: 1970-01-01T00:00:01.950Z
  latest runs: commit=completed, plan=completed

Warnings (1):
  - no .belayd/workflow.json in /tmp/bd146-demo.feat-bd-12; that worktree drives no workflow
```

`commit=completed` comes from `own-commit` (started 1900), not from the newer
`bd16-commit` (started 3200), which is what lets the run loop accept a member
whose state file completion already cleared. The header loses the task id because
`FleetMemberView.taskId` mirrors `workflow.json`; attribution itself still uses
the branch-implied id. Phases are alphabetical here because `phaseOrder` is
unknown without the state file.

### 5. Own evidence is not swallowed either

Restore the state file and give the member its own interrupted run, next to the
newer, foreign interrupted manifest:

```bash
wt=/tmp/bd146-demo.feat-bd-12
printf '%s' '{"schemaVersion":1,"taskId":"bd-12","workflowType":"feature","branch":"feat/bd-12","originalCwd":"'$wt'","phaseOrder":["plan","implement","review","test","userguide","proof","commit"],"completedPhaseNames":["plan"],"awaitingReviewResponse":false,"startedAt":1761000000000,"updatedAt":1761000900000}' > "$wt/.belayd/workflow.json"
printf '%s' '{"schemaVersion":1,"runId":"own-implement","taskId":"bd-12","phase":"implement","sessionName":"belayd-bd-12-sub-implement","status":"interrupted","startedAt":1300,"completedAt":1400}' > "$wt/.belayd/runs/own-implement.json"
DIST=$(pwd)/dist node /tmp/bd146-check.mjs /tmp/bd146-demo
```

```text
Member bd-12 — interrupted
  worktree: /tmp/bd146-demo.feat-bd-12 (branch feat/bd-12)
  workflow: feature 1/7 phases complete
  pending: implement, review, test, userguide, proof, commit
  awaiting review response: no
  interrupted runs: 1
  orchestrator lease: none
  last updated: 2025-10-20T22:55:00.000Z
  latest runs: plan=completed, implement=interrupted, commit=completed
```

`interrupted runs: 1` is `own-implement`; `bd83-implement` (also interrupted,
newer) is still ignored. `commit=completed` is the member's own `own-commit`
(started 1900) — `bd16-commit` lost to it, and `bd16-plan` lost to `own-plan`.

### 6. Which id wins: branch vs `workflow.json`

With an intent that names the branch's bead, the branch id decides attribution.
Make the foreign `commit` a failure so the two resolutions are visible in the
text:

```bash
root=/tmp/bd146-demo
printf '%s' '{"schemaVersion":1,"runId":"bd16-commit","taskId":"bd-16","phase":"commit","sessionName":"belayd-bd-16-sub-commit","status":"failed","startedAt":3200,"completedAt":3300,"failureReason":"gate failed"}' > "$root.feat-bd-12/.belayd/runs/bd16-commit.json"
printf '%s' '{"schemaVersion":1,"taskId":"bd-16","workflowType":"feature","branch":"feat/bd-12","originalCwd":"/tmp/bd146-demo.feat-bd-12","phaseOrder":["plan","implement","review","test","userguide","proof","commit"],"completedPhaseNames":["plan"],"awaitingReviewResponse":false,"startedAt":1761000000000,"updatedAt":1761000900000}' > "$root.feat-bd-12/.belayd/workflow.json"
mkdir -p "$root/.git/belayd/fleet/default"
printf '%s' '{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12"],"createdAt":1761000000000,"updatedAt":1761000900000}' > "$root/.git/belayd/fleet/default/fleet.json"
DIST=$(pwd)/dist node /tmp/bd146-check.mjs /tmp/bd146-demo   # intent names bd-12 → branch id wins
rm "$root/.git/belayd/fleet/default/fleet.json"
DIST=$(pwd)/dist node /tmp/bd146-check.mjs /tmp/bd146-demo   # no intent → workflow.json's bd-16 wins
```

First call — the intent names `bd-12`, so the branch id decides:

```text
Fleet default
  intent: bd-12
  members: 1
  states: active=0 blocked=0 awaiting-human=0 interrupted=1 idle=0 missing-state=0

Member bd-16 — interrupted
  ...
  interrupted runs: 1
  latest runs: plan=completed, implement=interrupted, commit=completed

Warnings (1):
  - /tmp/bd146-demo.feat-bd-12 records bd-16, but its branch or directory names bd-12
```

Second call — the intent file is gone, so `workflow.json`'s `bd-16` decides:

```text
Fleet default
  intent: none recorded
  members: 1
  states: active=0 blocked=1 awaiting-human=0 interrupted=0 idle=0 missing-state=0

Member bd-16 — blocked
  ...
  interrupted runs: 0
  latest runs: plan=completed, commit=failed
```

With the intent, `latest runs` are the branch's `bd-12` manifests
(`implement=interrupted` is the member's own), so the foreign `bd16-commit`
failure never parks it. Without the intent, the same worktree is attributed to
`workflow.json`'s `bd-16`, adopts `bd16-commit=failed`, and reads `blocked`. The
header says `bd-16` in both runs because it mirrors `workflow.json`, while
attribution follows the resolution order; the `task-id-mismatch` warning is
what tells you the two disagree. Rendered text can be ambiguous on its own —
that is why the tests pin `runId` identity.

### 7. No resolvable task id: manifests are listed as read

A worktree whose branch and directory name yield no task id, with no
`workflow.json`, is not filtering anything:

```bash
git -C /tmp/bd146-demo worktree add -q -b junkbranch /tmp/bd146-anon
mkdir -p /tmp/bd146-anon/.belayd/runs
printf '%s' '{"schemaVersion":1,"runId":"bd16-plan","taskId":"bd-16","phase":"plan","sessionName":"belayd-bd-16-sub-plan","status":"completed","startedAt":3950,"completedAt":3970}' > /tmp/bd146-anon/.belayd/runs/bd16-plan.json
printf '%s' '{"schemaVersion":1,"runId":"bd83-test","taskId":"bd-83","phase":"test","sessionName":"belayd-bd-83-sub-test","status":"completed","startedAt":3400,"completedAt":3500}' > /tmp/bd146-anon/.belayd/runs/bd83-test.json
DIST=$(pwd)/dist node /tmp/bd146-check.mjs /tmp/bd146-demo
```

```text
Member (no task id) — missing-state
  worktree: /tmp/bd146-anon (branch junkbranch)
  workflow: missing
  interrupted runs: 0
  orchestrator lease: none
  last updated: 1970-01-01T00:00:03.970Z
  latest runs: plan=completed, test=completed

Warnings (2):
  - /tmp/bd146-demo.feat-bd-12 records bd-16, but its branch or directory names bd-12
  - no .belayd/workflow.json in /tmp/bd146-anon; that worktree drives no workflow
```

The view reports what it read instead of hiding every manifest behind a missing
key (unit coverage: `reports runs as read when no task id can be derived`).

Clean up: `git -C /tmp/bd146-demo worktree remove --force /tmp/bd146-anon /tmp/bd146-demo.feat-bd-12; rm -rf /tmp/bd146-demo`.

## How to Use

`belayd_fleet_status` is the surface that renders these member blocks (the plain
text comes from `formatFleetStatus` in `src/fleet-status.ts`, one tool result, no
writes). `/fleet …` only launches a fleet and reports the launch; `belayd_status`
shows an unfiltered `**Run history**` table of every manifest in the session's
`cwd`, so use `belayd_fleet_status` when you want per-member attribution.

### What the member's task id resolves to

`runLoopTaskId` in `src/fleet-status.ts` picks the attribution key in this order:

1. the branch's task id (`taskIdFromBranch`, e.g. `bd-12` from `feat/bd-12`) **when
   that id is in the fleet intent's `taskIds`**;
2. otherwise `workflow.json`'s `taskId`;
3. otherwise the id implied by the branch, then by the worktree directory name
   (`<repo>.feat-bd-42` → `bd-42`).

This is the same key the run loop uses, so the view and the loop never disagree
about which manifests a member owns. When the key comes from the branch but
`workflow.json` records a different id, the view prints a
`task-id-mismatch` warning (`… records bd-16, but its branch or directory names
bd-12`) and the run evidence follows the branch id.

### What the run columns now mean

Given `runs = snapshot.runs.filter(run => run.taskId === key)` (the filter is
`runsBelongingToMember` in `src/fleet-run.ts`; `taskId` is a required field of
every run manifest, and the comparison is exact string equality):

| Line | Derived from |
| --- | --- |
| `latest runs:` | newest manifest per phase, among that member's own manifests only (`latestRunPerPhase`), ordered by `workflow.json`'s `phaseOrder` when known, alphabetical otherwise |
| `interrupted runs:` | count of `status: interrupted` among those own manifests |
| `last updated:` | max timestamp of those own runs and `workflow.json`'s `updatedAt` |
| member state | `deriveFleetMemberState` over those own runs: no `workflow.json` → `missing-state`; any own interrupted run → `interrupted`; awaiting review/human → `awaiting-human`; newest own run of a pending phase `failed` → `blocked`; every phase complete → `idle`; otherwise `active` |

Consequences an operator will notice:

- A foreign completed run can no longer make a pending phase look done.
- A foreign `failed` or `interrupted` run can no longer park the member in
  `blocked`/`interrupted`, and no longer inflates `interrupted runs`.
- A foreign run can no longer push `last updated` forward.
- The member's **own** crash still counts — filtering by task id, not by phase or
  by "newest wins", is what makes both directions correct.
- A completed final-phase own run beneath a deleted `workflow.json` still proves
  the work finished (the run loop derives `complete` from it via
  `deriveFleetMemberProgress`); the status view keeps printing `missing-state`
  because the state file itself is gone.

### The fallback: no resolvable id

When neither the branch, the directory name, nor `workflow.json` yields a task id
(a finished-but-not-accepted worktree whose state is gone and whose branch is not
named after a bead), there is nothing to attribute runs to, so `latest runs` and
`interrupted runs` list the manifests as read — unfiltered, as before bd-146. That
is deliberate: hiding every manifest behind a missing key would silently report
`latest runs: none` for a worktree that visibly has runs.

### Where to read more

- `docs/fleet.md` — the operator map; the member-block example there carries the
  bd-146 note on the ownership filter.
- `docs/fleet-status.md` — field/state decoding and warning triage for
  `belayd_fleet_status`.
- `docs/fleet-run.md` — how the run loop uses the same ownership filter to decide
  stop/advance.
