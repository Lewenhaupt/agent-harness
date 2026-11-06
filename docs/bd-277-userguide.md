# One bounded repair round for a refused landing, so `land-failed` is not the first answer (bd-277)

Before bd-277 a refused landing was terminal for the run: `LAND_ATTEMPT_STOP_REASONS`
(`src/fleet-run.ts`) removed the member from landing, `planFleetTick` never retried it, and
the only revival was a human running `belayd_fleet_reconcile {"retryMembers":[…]}`. That
is right for a real conflict, and wrong for a refusal whose cause is a mechanical defect in
the member's *own diff* — the common case. In one wave
(`proof-of-work-reviewing-platform`, 2026-11-04) bd-170, bd-161 and bd-160 all stopped on
`proof-artifacts-in-diff` and all were merged and released by hand.

bd-277 puts **one** repair round in front of that stop. The drain's enumerated
`FleetMergeFailureReason` decides whether the member can fix its own diff, the run records
the attempt, the member is asked (in its own worktree, or by a `land-repair` mailbox note
when its session is live), the landing is held while its branch tip is unchanged, and a
moved tip is drained again. A second refusal, a repair that changes nothing in 30 minutes,
and every non-repairable reason keep today's terminal `land-failed`.

| Piece | Where |
| --- | --- |
| Classification, `planLandRepair`, repair task text, status line | `src/fleet-land-repair.ts` (`MAX_LAND_REPAIR_ATTEMPTS`, `FLEET_LAND_REPAIR_GRACE_MS`, `isRepairableLandRefusal`, `planLandRepair`, `fleetLandRepairTask`, `formatLandRepairStatus`, `boundLandRepairText`) |
| `run.members[].landRepair` record | `src/fleet-run.ts` (`recordRunMemberLandRepair`, `landRepairForMember`, `recordRunMemberLanded`) |
| Status surfaces | `src/fleet-status.ts` (`currentLandRepair`, `formatFleetLandRepairs`, member block, single-bead section) |
| Tick wiring: classify → persist → ask → hold → stop | `extensions/capabilities/fleet.ts` (`refuseLandTick`, `askMemberToRepairLanding`, `memberAwaitingLandRepair`, `repairStopDetail`, audit action `fleet-land-repair`) |

Everything below ran in this worktree with `node v24.18.0`, `git 2.55.0`, `bd` and `jq` on
PATH. No model, no network.

## How to Verify

### 1. Gates

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm vitest run src/__tests__/fleet-land-repair.test.ts src/__tests__/fleet-run.test.ts \
  src/__tests__/fleet-status.test.ts src/__tests__/extension-fleet-status-tool.test.ts
pnpm vitest run src/__tests__/extension-fleet-p1.test.ts -t "bd-277" --reporter=verbose
```

Real output (pnpm's `Done in …` lines and the extension's stderr banner elided; three of
the last command's sixteen test names shown, the rest are the other bd-277 cases):

```text
$ tsc --noEmit
$ biome check .
Checked 367 files in 754ms. No fixes applied.
$ tsc

 ✓ src/__tests__/fleet-land-repair.test.ts (14 tests) 12ms
 ✓ src/__tests__/fleet-run.test.ts (137 tests) 72ms
 ✓ src/__tests__/fleet-status.test.ts (166 tests) 276ms
 ✓ src/__tests__/extension-fleet-status-tool.test.ts (31 tests) 748ms
      Tests  348 passed (348)
 ✓ ... > ends the repair hold exactly at FLEET_LAND_REPAIR_GRACE_MS (bd-277) 10ms
 ✓ ... > still holds one millisecond before the repair grace (bd-277) 10ms
 ✓ ... > drains again once the repair moves the branch tip (bd-277) 11ms
      Tests  16 passed | 167 skipped (183)
```

### 2. The driver

Save as `/tmp/bd277/probe.mjs`. It runs the **record half** of a tick: the ask (relaunch or
mailbox note) needs a pi `ExtensionContext`, so `tick` and `stop` write what the tick
writes. That is the only composed part; they are reproduced here verbatim. The file's
other commands are one production call each: `drain` → `drainFleetMerge`, `seed` →
`updateFleetIntent` + `enqueueFleetMerge`, `enqueue` → `enqueueFleetMerge`, `status` →
`readFleetStatus` + `formatFleetStatus` + `formatFleetLandRepairs`, `classify` →
`isRepairableLandRefusal` over `FLEET_MERGE_FAILURE_REASONS`, `retry` → `retryRunMembers`,
`pause` → `pauseFleet`, `land` → `recordRunMemberLanded`.

```js
import { join } from "node:path";
const m = await import(`${process.env.REPO}/dist/src/index.js`);
const runs = await import(`${process.env.REPO}/dist/src/fleet-run.js`);
const cwd = process.env.SCRATCH, taskId = process.env.TASK, reason = process.env.REASON;
const gitCommonDir = join(cwd, ".git"), fleetId = m.DEFAULT_FLEET_ID;
const now = Number(process.env.NOW ?? Date.now());
const show = (value) => console.log(JSON.stringify(value, null, 2));
const read = () => { const r = m.readFleetIntent({ gitCommonDir, fleetId }); if (!r.ok) throw new Error(r.error); return r.intent; };
const persist = (run) => { const w = m.updateFleetIntent({ gitCommonDir, fleetId, update: () => ({ ...read(), run, updatedAt: now }) }); if (!w.ok) throw new Error(w.error); };
const attempts = () => m.landRepairForMember(read().run, taskId)?.attempts ?? 0;

const commands = {
  async tick() {
    const plan = m.planLandRepair({ reason, attemptsSoFar: attempts() });
    show({ attempts: attempts(), plan });
    if (plan.kind !== "repair") return;
    const head = await m.readBranchHead({ cwd, branch: `feat/${taskId}`, git: m.defaultFleetMergeGitRunner });
    const paths = process.env.PATHS?.split(",");
    console.log(m.fleetLandRepairTask({ taskId, reason, refusal: process.env.REFUSAL, ...(paths ? { paths } : {}) }));
    const attempt = m.recordRunMemberLandRepair({ run: read().run, taskId, refusal: process.env.REFUSAL, head: head.head, now });
    // A member the run does not list cannot be given a bounded round: never synthesise it.
    if (!attempt.recorded) throw new Error(`${taskId} is not a run member; nobody may be asked`);
    persist(attempt.run);
    show(read().run.members);
  },
  stop() {
    const plan = m.planLandRepair({ reason, attemptsSoFar: attempts() });
    show({ plan });
    if (plan.kind !== "stop") return;
    // repairStopDetail: the marker leads, the refusal takes the room the 400-char bound leaves.
    const room = Math.max(1, m.FLEET_RUN_DETAIL_MAX_LENGTH - plan.detail.length - 3);
    const run = m.recordRunMemberStopped({ run: read().run, taskId, reason: "land-failed", detail: `${plan.detail} — ${m.boundLandRepairText(process.env.REFUSAL, room)}`, now });
    persist(run);
    const stored = run.stopped.find((entry) => entry.taskId === taskId);
    show(stored);
    console.log(`${stored.detail.length} chars of ${m.FLEET_RUN_DETAIL_MAX_LENGTH}`);
  },
};
await commands[process.argv[2]]();
```

### 3. Case 1: a repairable refusal is retried once and lands

```bash
export REPO=$PWD                      # this worktree, with dist/ built
export SCRATCH=/tmp/bd277/case1
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"; cd "$SCRATCH"
git init -q -b main . && git config user.email t@example.com && git config user.name t
printf '.belayd/\n' > .gitignore
printf 'scratch repo for bd-277\n' > README.md
printf '{ "name": "scratch", "private": true, "scripts": { "test": "node -e \\"process.exit(0)\\"" } }\n' > package.json
git add .gitignore README.md package.json && git commit -qm init
bd init -p bd >/dev/null 2>&1
export TASK=$(bd create "Repair probe: a member whose payload carries proof" -t task --json | jq -r .id)
git worktree add -q -b "feat/$TASK" wt-a
mkdir -p "wt-a/.belayd" "wt-a/docs/proof/$TASK"
printf '# proof of work\n' > "wt-a/docs/proof/$TASK/README.md"
printf '{"schemaVersion":1,"taskId":"%s","workflowType":"feature","branch":"feat/%s","originalCwd":"%s/wt-a","phaseOrder":["scout","plan","implement","review","test"],"completedPhaseNames":["scout","plan","implement","review","test"],"startedAt":1762344000000,"updatedAt":1762344600000}\n' "$TASK" "$TASK" "$SCRATCH" > "wt-a/.belayd/workflow.json"
git -C wt-a add "docs/proof/$TASK/README.md" && git -C wt-a commit -qm "member: deliver the fix and its proof"

# The intent and the queue entry come from the real writers, never a hand-written fleet.json.
NOW=$(( $(date +%s) * 1000 - 240000 )) node /tmp/bd277/probe.mjs seed
NOW=$(( $(date +%s) * 1000 - 180000 )) node /tmp/bd277/probe.mjs drain
```

Real output (`TASK=bd-907`; ids differ per run because `bd init` mints them; the seed's
queue entry is folded to one line, everything else verbatim):

```text
{ "taskId": "bd-907", "branch": "feat/bd-907", "requestedAt": 1793964051000, "state": "queued", "attempts": 0, "updatedAt": 1793964051000 }
{
  "ok": false,
  "reason": "proof-artifacts-in-diff",
  "paths": [ "docs/proof/bd-907/README.md" ],
  "parked": false,
  "text": "publish gate refused: proof-artifacts-in-diff: docs/proof/bd-907/README.md; proof artifacts must not be published — upload them and keep the receipt at .belayd/proof-receipt.json; a repo that keeps proof in git declares {\"proof\":{\"artifacts\":\"in-tree\"}} in .belayd/config.json"
}
```

The refusal is pre-mutation, so the queue entry stays `queued` with `attempts: 0` — which
is exactly why an unchanged branch must be held rather than re-drained. Now the round,
with `REFUSAL` set to that `text`:

```bash
export REASON=proof-artifacts-in-diff
export REFUSAL='publish gate refused: proof-artifacts-in-diff: docs/proof/bd-907/README.md; proof artifacts must not be published — upload them and keep the receipt at .belayd/proof-receipt.json; a repo that keeps proof in git declares {"proof":{"artifacts":"in-tree"}} in .belayd/config.json'
export PATHS='docs/proof/bd-907/README.md'
NOW=$(( $(date +%s) * 1000 - 120000 )) node /tmp/bd277/probe.mjs tick
node /tmp/bd277/probe.mjs status
```

Real output (the repair task's own heading lines and the middle of its long refusal line
are omitted; the instruction bullets, `landRepair` and both status lines are verbatim):

```text
{ "attempts": 0, "plan": { "kind": "repair" } }
- Fix only the refused paths in your own diff. Nothing outside them belongs to this task.
- When the fix is committed, end your turn: the fleet drains the same entry again.
This is a single repair round (the fleet asks 1 time(s)). If the landing is refused again after your commit, the member stops for a human instead of asking again.
proof-artifacts-in-diff
Refused paths (1):
- docs/proof/bd-907/README.md
[
  {
    "taskId": "bd-907",
    "launchedAt": 1793964051000,
    "landRepair": {
      "attempts": 1,
      "at": 1793964176000,
      "refusal": "publish gate refused: proof-artifacts-in-diff: docs/proof/bd-907/README.md; proof artifacts must not be published — upload them and keep the receipt at .belayd/proof-receipt.json; a repo that keeps proof in git declares {\"proof\":{\"artifacts\":\"in-tree\"}} in .belayd/config.json",
      "head": "acdd4eba09f1ee4231ec55f02b23adf832511883"
    }
  }
]
Fleet default
  intent: bd-907
  run: until-complete — 1 tick(s), last tick 2026-11-06T11:22:56.000Z
  repairing bd-907 (repair 1 of 1 — publish gate refused: proof-artifacts-in-diff: docs/proof/bd-907/README.md; proof artifacts must not be published — upload them and keep the receipt at .belayd/proof-receipt.json; a repo that keeps…)
Member bd-907 — idle
  worktree: /tmp/bd277/case1/wt-a (branch feat/bd-907)
  repair 1 of 1 — publish gate refused: proof-artifacts-in-diff: docs/proof/bd-907/README.md;…
```

`run.stopped` is `[]` here: no `stopped …` line, no `Needs you` block. The member makes
its one commit and the next drain lands it:

```bash
git -C wt-a rm -q "docs/proof/$TASK/README.md"
git -C wt-a commit -qm "member: drop the proof from the payload (receipt stays local)"
NOW=$(( $(date +%s) * 1000 - 60000 )) node /tmp/bd277/probe.mjs drain
NOW=$(( $(date +%s) * 1000 - 30000 )) node /tmp/bd277/probe.mjs land
node /tmp/bd277/probe.mjs status | head -5
```

```text
{
  "ok": true,
  "mergeCommit": "20322f3cbf36d63972ce48e9237e7da238fb8c96",
  "text": "Fleet `default`: merged bd-907 (feat/bd-907) into main at 20322f3cbf36.\n- gates passed on the rebased result: test\n- root work was stashed and restored (b0f9d6fba8ae66e08d39b628a23eea603d4e26ec)\nbd-907 stays in_progress + human: merging is not closing. Accept it with `wt merge` / bd when you are ready."
}
Fleet default
  intent: bd-907
  run: until-complete — 1 tick(s), last tick 2026-11-06T11:24:31.000Z
  members: 1
```

`recordRunMemberLanded` clears `landRepair` (the landed status prints no `repairing` and no
`stopped` line; `members: 1` is the only run line). **AC1** (a repairable refusal is retried
once, no human action, and lands): `landRepair.attempts: 1` with `run.stopped: []`, then a
moved tip drains and merges.

### 4. Case 2: a second refusal stops the member, provenance first

Case 2 repeats step 3 verbatim with `SCRATCH=/tmp/bd277/case2` and `wt-a`→`wt-b` (one
bead, one proof file, `seed`, `drain`, `tick` as above), then the member "half-repairs" —
it keeps more proof instead of removing it, commits, and so the tip moves:

```bash
mkdir -p "docs/proof/$TASK/captures" "proof/$TASK"
printf 'cast\n' > "docs/proof/$TASK/cast.txt"; printf 'transcript\n' > "docs/proof/$TASK/transcript.md"
for n in 01 02 03; do printf 'png\n' > "docs/proof/$TASK/captures/step-$n.png"; done
printf 'png\n' > "proof/$TASK/hero.png"
git -C wt-b add -A && git -C wt-b commit -qm "member: keep more evidence (a half repair)"
# REASON is the second drain's `reason`; REFUSAL must be its `text` verbatim (the 397
# characters below depend on the exact wording, so paste it from the drain output):
export REASON=proof-artifacts-in-diff REFUSAL='publish gate refused: proof-artifacts-in-diff: <the seven paths>; proof artifacts must not be published — …'
node /tmp/bd277/probe.mjs drain                        # second refusal: 7 paths
NOW=$(( $(date +%s) * 1000 - 60000 )) node /tmp/bd277/probe.mjs stop   # what the tick records
node /tmp/bd277/probe.mjs status
```

Real output (`REFUSAL` is that drain's `text` verbatim, so the echoed refusal below shows
the same seven paths; the trailing `…` is the code's own cut, at a word boundary after the
whole path list):

```text
{"reason":"proof-artifacts-in-diff","pathCount":7}
{ "plan": { "kind": "stop", "detail": "repair 1 of 1 did not clear this (proof-artifacts-in-diff)" } }
{
  "taskId": "bd-7cd",
  "reason": "land-failed",
  "detail": "repair 1 of 1 did not clear this (proof-artifacts-in-diff) — publish gate refused: proof-artifacts-in-diff: docs/proof/bd-7cd/README.md, docs/proof/bd-7cd/captures/step-01.png, docs/proof/bd-7cd/captures/step-02.png, docs/proof/bd-7cd/captures/step-03.png, docs/proof/bd-7cd/cast.txt, docs/proof/bd-7cd/transcript.md, proof/bd-7cd/hero.png; proof artifacts must not be published — upload them and…",
  "at": 1793964254000
}
397 chars of 400
  stopped bd-7cd (land-failed): repair 1 of 1 did not clear this (proof-artifacts-in-diff) — publish gate refused: …
Needs you (1): bd-7cd
  - bd-7cd (assignee (unknown), stopped land-failed) — repair 1 of 1 did not clear this (proof-artifacts-in-diff) — publish gate refused: proof-artifacts-in-diff: docs/proof/…
```

No `repairing …` line appears beside that stop: `formatFleetLandRepairs` skips a member
carrying a stop, and `currentLandRepair` applies the same rule to the member block and the
single-bead section. **AC2** (refused twice → still stops with its reason): the marker
leads, the refusal fits in the record's 400 characters, and the round is not rendered as
still pending.

### 5. Case 3: a repair that changes nothing (the 30-minute bound)

The hold is `memberAwaitingLandRepair` in `extensions/capabilities/fleet.ts` and needs a
live pi session, so it cannot be driven from `src/` alone: this case is verified by the
pinned tests in step 1, not by a pasted transcript. The strings it produces, quoted from
the code:

- held, tip unchanged — a `deferred`, so nothing is drained and `run.stopped` stays `[]`:
  `` `<task>` was asked at <iso> to repair its refused landing and <branch> has not moved
  yet; the landing waits for that repair instead of draining the unchanged branch again ``;
- past `FLEET_LAND_REPAIR_GRACE_MS` (30 min), tip still unchanged — the ordinary stop:
  `` `<task>` was asked at <iso> to repair its refused landing and <branch> is still at
  <recorded head> after 30 min; stopping it for a human instead of waiting on a repair
  that is not happening ``.

Boundary proof: `ends the repair hold exactly at FLEET_LAND_REPAIR_GRACE_MS` and `still
holds one millisecond before the repair grace`, plus `holds on an unreadable branch tip,
then stops at the repair grace` — an unreadable tip is a hold, never "the branch moved".
Past the grace the member is stopped `land-failed` with the unchanged tip as evidence; the
operator then fixes or moves the branch and runs
`belayd_fleet_reconcile {"retryMembers":["<id>"]}` (see [How to Use](#how-to-use)).
**AC4** (capacity, lease and membership unchanged): a hold re-schedules at the normal tick
interval and is not an action — the member keeps its bead, worktree, transcript, mailbox
and capacity slot.

### 6. Case 4: terminal reasons get no round at all

A real conflict (`/tmp/bd277/case4`: the base rewrote the same line the member changed):

```bash
export SCRATCH=/tmp/bd277/case4
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"; cd "$SCRATCH"
git init -q -b main . && git config user.email t@example.com && git config user.name t
printf '.belayd/\n' > .gitignore; printf 'shared line from main\n' > README.md
printf '{ "name": "scratch4", "private": true, "scripts": { "test": "node -e \\"process.exit(0)\\"" } }\n' > package.json
git add .gitignore README.md package.json && git commit -qm init
bd init -p bd >/dev/null 2>&1
export TASK=$(bd create "Repair probe: a member that contradicts the base" -t task --json | jq -r .id)
git worktree add -q -b "feat/$TASK" wt-c
mkdir -p wt-c/.belayd; printf 'shared line from the member\n' > wt-c/README.md
printf '{"schemaVersion":1,"taskId":"%s","workflowType":"feature","branch":"feat/%s","originalCwd":"%s/wt-c","phaseOrder":["scout","plan","implement","review","test"],"completedPhaseNames":["scout","plan","implement","review","test"],"startedAt":1762344000000,"updatedAt":1762344600000}\n' "$TASK" "$TASK" "$SCRATCH" > wt-c/.belayd/workflow.json
git -C wt-c add README.md && git -C wt-c commit -qm "member: change the shared line"
printf 'shared line from main, rewritten by a sibling\n' > README.md
git add README.md && git commit -qm "base: a sibling rewrote the same line"

NOW=$(( $(date +%s) * 1000 - 240000 )) node /tmp/bd277/probe.mjs seed
NOW=$(( $(date +%s) * 1000 - 180000 )) node /tmp/bd277/probe.mjs drain
node /tmp/bd277/probe.mjs classify
```

Real output (the 25-row table folded to the rows around the three `yes`):

```text
{ "ok": false, "reason": "rebase-failed", "paths": [ "README.md" ], "parked": false,
  "text": "feat/bd-5dv onto main is a real contradiction: base work committed after this fleet started (7c92dec99a70, 6bf4805cd909) touches paths this member changed (a9880bf3d2d3); conflicted paths: README.md" }
yes  proof-artifacts-in-diff
yes  paths-outside-scope
…
no   rebase-failed
…
yes  gate-failed
```

Three repairable reasons, twenty-two terminal. The stop itself, then a queue/state reason
and a paused fleet:

```bash
export REASON=rebase-failed
export REFUSAL="feat/bd-5dv onto main is a real contradiction: …; conflicted paths: README.md"
NOW=$(( $(date +%s) * 1000 - 100000 )) node /tmp/bd277/probe.mjs stop
git worktree remove --force wt-c                    # a queue/state reason
node /tmp/bd277/probe.mjs enqueue && node /tmp/bd277/probe.mjs drain
REASON_TEXT="operator paused to merge a sibling by hand" node /tmp/bd277/probe.mjs pause
node /tmp/bd277/probe.mjs drain                     # a paused fleet
```

```text
{ "plan": { "kind": "stop", "detail": "rebase-failed is not something a commit in the member's own diff can change" } }
{ "taskId": "bd-5dv", "reason": "land-failed",
  "detail": "rebase-failed is not something a commit in the member's own diff can change — feat/bd-5dv onto main is a real contradiction: base work committed after this fleet started (7c92dec99a70, 6bf4805cd909) touches paths this member changed (a9880bf3d2d3); conflicted paths: README.md",
  "at": 1793964232000 }
276 chars of 400
{"state":"queued","attempts":1}
{"reason":"member-worktree-missing","text":"no worktree has feat/bd-5dv checked out; cannot merge it"}
"Fleet `default` is paused: no launch and no merge starts until belayd_fleet_resume. …"
{"reason":"fleet-paused","parked":true,"text":"fleet `default` is paused (operator paused to merge a sibling by hand); resume it before merging"}
```

The tick reaches a stop for such a reason without writing anything, and the member never
gets a `landRepair` record:

```bash
REASON=rebase-failed node /tmp/bd277/probe.mjs tick
jq -c '.run.members' .git/belayd/fleet/default/fleet.json
```

```text
{ "attempts": 0, "plan": { "kind": "stop", "detail": "rebase-failed is not something a commit in the member's own diff can change" } }
[{"taskId":"bd-5dv","launchedAt":1793964086000}]
```

**AC3** (no repair for a real conflict, a queue/state error, or a paused fleet): the first
drain already stops, and no round is started, let alone spent.

## How to Use

**What changes for you.** A refused landing is retried once with no action from you. You
are paged only when it is refused **twice**, when a repair changes nothing for **30
minutes**, or when the cause is **not repairable** — and the page leads with the round's
provenance, so the three are distinguishable at a glance.

**Classification** (one exhaustive `switch` in `src/fleet-land-repair.ts`; a new
`FleetMergeFailureReason` fails the typecheck until someone decides its side):

| Repairable — one round | Terminal — stop now |
| --- | --- |
| `proof-artifacts-in-diff`: remove the proof, keep `.belayd/proof-receipt.json` | `rebase-failed`: a real contradiction with the base, which the member cannot decide |
| `paths-outside-scope`: drop the out-of-scope path | `rebase-delegated`: already the member's own rebase (bd-280) |
| `gate-failed`: the member's own code failed a merge gate | `fleet-paused`: a person paused the fleet |
| | everything else — `lock-unavailable`, `queue-unreadable`, `intent-unreadable`, `no-queued-entry`, `entry-not-queued`, `queue-write-failed`, `intent-write-failed`, `member-*`, `root-*`, `gate-commands-missing`, `publish-payload-unreadable`, `stash-failed`, `step-failed`, `merge-failed`, `restore-conflict`: the supervisor's or the operator's condition, not something a commit can change |

A real conflict stays terminal because a repair round is *one commit in the member's own
diff*; a contradiction between the base and the member is a judgement call (which side is
right?), and re-running the gates would burn the same minutes on the same conflict.

**What the member does.** Its own worktree is relaunched through the ordinary fleet-member
launch with the repair task as its task — or, when its orchestrator lease is live (a
relaunch would be refused by the one-orchestrator-per-worktree rule), the same task goes to
its mailbox as a `land-repair` note. It keeps its bead, worktree, transcript, mailbox and
capacity slot; nothing is retired, released or closed. It fixes only the refused paths,
commits on its own branch, and ends its turn; the next tick drains the same entry again.

**How to read it.** The attempt lives on the run member in `fleet.json`:
`run.members[].landRepair = { attempts, at, refusal, head }`, written and persisted
*before* the member is asked, so a crash cannot start a second round.

- `belayd_fleet_status` header: `repairing bd-7cd (repair 1 of 1 — <refusal>)`;
- the member block and `belayd_status`'s single-bead section: `repair 1 of 1 — <refusal>`
  (a member in a round is deliberately **not** in `Needs you`);
- the audit log: action `fleet-land-repair`, detail
  `relaunched bd-7cd to repair its refused landing (repair 1 of 1): <refusal>` — or
  `noted …` for the mailbox path;
- a stop reads `repair 1 of 1 did not clear this (<reason>) — <refusal>`, or
  `<reason> is not something a commit in the member's own diff can change — <refusal>`, or
  `could not ask bd-7cd to repair its landing (<why>) — <refusal>` when neither the
  relaunch nor the note could be recorded (a repair nobody was told about is a silent
  stop). The marker always leads, so it survives the record's 400-character bound.

**What still needs you, and the one recovery command.** Fix the cause, then

```
belayd_fleet_reconcile { "retryMembers": ["<id>"] }
```

Real effect on the record (Case 2's member):

```text
{ "retried": [ "bd-7cd" ], "stopped": [] }
Fleet default
  intent: bd-7cd
  run: until-complete — 1 tick(s), last tick 2026-11-06T11:25:13.000Z
  repairing bd-7cd (repair 1 of 1 — publish gate refused: proof-artifacts-in-diff: …)
```

The retry clears the stop but does **not** un-spend the round: `landRepair.attempts` stays
`1`, so the next refusal stops the member immediately. That is deliberate — the count is
the loop's only bound — so land the fixed branch yourself, or fix it and let the drain land
it, instead of retrying a member whose diff has not changed.

**Known limit.** The round reuses the full `launchWorktreeWorkflow`, so the member runs its
phases again rather than a phase-less fix round. A repair that re-runs the phases still
lands, so this is debt, not a defect: the lighter round is bd-174.13.
