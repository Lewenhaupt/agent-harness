# One escalation primitive: every human-relevant fleet stop opens a described bd gate (bd-279)

Before bd-279 a member that a run stopped left one durable fact in one place: an
entry in `fleet.json`'s `run.stopped[]`. `formatFleetRunStops` did print it
(`stopped <task> (<reason>): <detail>`), but the line sat outside the `Needs you`
block, nothing on the bead awaited a person, nothing was answerable, and once the
run died nothing acted on it again. bd-277 cost three members that way in one wave:
each merged by hand, each released by hand, the cause readable only from the run
record.

bd-279 adds one escalation primitive instead of one channel per condition:

- **A described bd gate per human-relevant stop.** The seven
  `FLEET_RUN_STOP_REASONS` and a parked fleet open a `human` gate that blocks the
  member's bead. The title carries a structured marker, the reason says what
  happened, which member/bead, the stop detail, and the three answers a person may
  choose (`retry`, `abandon`, `release`) plus the exact command.
- **Idempotent per `(bead, cause, round)`.** A re-tick adopts the gate bd already
  has; the gate id is recorded back into `run.stopped[]`.
- **`Needs you` reads the stop record**, with its reason, detail and the answer a
  person chose — the same "answered" notion the run header's stop lines use.
- **Drift-checked.** A gate whose reason to exist ended (member retried, landed,
  relaunched, prune) is resolved; a stop whose gate was answered records the answer
  and fires no warning; a stop naming a gate bd never had warns and names the
  recovery.
- **The answer is the decision input.** `bd gate resolve <id> --reason "…"` is read
  back onto the stop record — that note, not a separate conversation, is what a
  supervisor acts on.

Withheld sensitive findings deliberately keep the review gate's existing
`belayd_ask_human` gate instead of opening a second one. The code records that
divergence explicitly and this guide repeats it in
[the contract](#the-divergence-for-withheld-sensitive-findings) so a future reader
does not "fix" it into a second channel.

| Piece | Where |
| --- | --- |
| Marker, marker parser, drift, open-gate reader, comment-channel refusal | `src/bead-gates.ts` (`FLEET_ESCALATION_GATE_PREFIX`, `renderFleetEscalationGateMarker`, `parseFleetEscalationGateMarkerLine`, `fleetEscalationGateMarkerOf`, `fleetEscalationGateDrift`, `readOpenFleetEscalationGates`) |
| Planner, gate argv, ensure/adopt, drift check, by-prefix reaper | `src/fleet-escalation.ts` |
| `run.stopped[]` schema (`gateId`, `resolution`), `fleetRunStopAnswer`, `recordRunStopGate`, `recordRunStopResolution`, `formatFleetRunStops` | `src/fleet-run.ts` |
| `Needs you` join (`member.stop`), `formatBeadOwnership` stop line | `src/fleet-status.ts` |
| Tick wiring (open after the action, land/relaunch/retry/prune/unpark reaps, audit) | `extensions/capabilities/fleet.ts` (`escalateFleetRun`, `openEscalationGates`, `reapEscalationGates`, `reapParkedEscalationGates`) |
| Supervision digest's unreadable-gate line | `src/workflow-digest.ts`, `extensions/capabilities/fleet.ts` (`readSupervisionGates`) |

**This guide is terminal-only.** Everything below is a command and its real output
run in this worktree with `bd version 1.3.0 (dev)` and `node v24.18.0`; there is no
browser surface and no image, so no proof artifact is deferred.

## How to Verify

Run from the repository root unless a step says otherwise.

### 1. Gates

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test
pnpm vitest run src/__tests__/fleet-escalation.test.ts \
  src/__tests__/fleet-status.test.ts src/__tests__/fleet-run.test.ts \
  src/__tests__/bead-gates.test.ts
pnpm vitest run src/__tests__/extension-fleet-p1.test.ts \
  src/__tests__/extension-fleet-status-tool.test.ts \
  src/__tests__/extension-human-answer.test.ts \
  src/__tests__/extension-supervision-tools.test.ts \
  src/__tests__/workflow-digest.test.ts
pnpm test:integration
```

Real output:

```text
$ tsc --noEmit
$ biome check .
Checked 388 files in 773ms. No fixes applied.
$ tsc

 Test Files  175 passed (175)
      Tests  5037 passed (5037)

 ✓ src/__tests__/bead-gates.test.ts (45 tests) 19ms
 ✓ src/__tests__/fleet-escalation.test.ts (37 tests) 31ms
 ✓ src/__tests__/fleet-run.test.ts (127 tests) 57ms
 ✓ src/__tests__/fleet-status.test.ts (149 tests) 162ms
 Test Files  4 passed (4)
      Tests  358 passed (358)

 ✓ src/__tests__/extension-fleet-p1.test.ts (159 tests) 1255ms
 Test Files  5 passed (5)
      Tests  282 passed (282)

 Test Files  16 passed (16)
      Tests  115 passed (115)
```

### 2. A throwaway repository with a member the run stopped

Never do this in the repository's own `.beads/`. `bd init -p bd` yields `bd-<hash>`
ids, so the member ids are captured in `$A`/`$B` and every later command uses those
variables; the output quoted below shows this session's ids (`bd-mzm`, `bd-e7o`,
`bd-vj7`) and gate ids (`bd-b01`, `bd-ixu`, `bd-8l0`, `bd-cp4`), which will differ.

```bash
export REPO=$PWD                      # the worktree the guide runs in (dist/ must be built)
export SCRATCH=/tmp/bd279-verify
rm -rf "$SCRATCH" && mkdir -p "$SCRATCH" && cd "$SCRATCH"
git init -q -b main .
git config user.email t@example.com && git config user.name t
echo hi > README.md && git add README.md && git commit -qm init
export BEADS_ACTOR=

bd init -p bd >/dev/null 2>&1
A=$(bd create "Escalation probe: a member the run stopped" -t task --json | jq -r .id)
B=$(bd create "Escalation probe: a member still in flight" -t task --json | jq -r .id)

for pair in a:$A b:$B; do
  wt=${pair%%:*}; id=${pair##*:}
  git worktree add -q -b "feat/$id" "wt-$wt"
  mkdir -p "wt-$wt/.belayd"
  cat > "wt-$wt/.belayd/workflow.json" <<EOF
{"schemaVersion":1,"taskId":"$id","workflowType":"feature","branch":"feat/$id","originalCwd":"$SCRATCH/wt-$wt","phaseOrder":["scout","plan","implement","review","test"],"completedPhaseNames":["scout","plan"],"startedAt":1762344000000,"updatedAt":1762344000000}
EOF
done

# A hand-written intent: a live supervisor would have written this itself.
mkdir -p .git/belayd/fleet/default
cat > .git/belayd/fleet/default/fleet.json <<EOF
{
  "schemaVersion": 2,
  "fleetId": "default",
  "baseBranch": "main",
  "publish": { "mode": "local" },
  "taskIds": ["$A", "$B"],
  "createdAt": 1762344000000,
  "updatedAt": 1762344600000,
  "run": {
    "schemaVersion": 1,
    "mode": "until-complete",
    "startedAt": 1762344000000,
    "updatedAt": 1762344600000,
    "ticks": 12,
    "members": [
      { "taskId": "$A", "launchedAt": 1762344000000 },
      { "taskId": "$B", "launchedAt": 1762344000000, "landedAt": 1762344400000 }
    ],
    "stopped": [
      {
        "taskId": "$A",
        "reason": "land-failed",
        "detail": "publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy",
        "at": 1762344500000
      }
    ],
    "haltedReason": "partial: 1 member stopped"
  }
}
EOF
echo "A=$A B=$B"
```

Real output:

```text
A=bd-mzm B=bd-e7o
```

(`bd init` also drops its own agent-integration files — `AGENTS.md`, `.agents/`,
`.claude/` — into the scratch repo. They are untracked and irrelevant here; they do
not affect the fleet reads.)

`A` is stopped `land-failed` and is still a member; `B` landed. That is the shape
bd-277 produced three of.

### 3. `Needs you` reads the stop record

Save this as `/tmp/bd279-final/render.mjs` (it performs exactly the composition
`belayd_fleet_status` performs: `readFleetStatus` → `lookupFleetBeads` +
`lookupFleetBeadEngagement` → `formatFleetStatus`).

```bash
mkdir -p /tmp/bd279-final
cat > /tmp/bd279-final/render.mjs <<'JS'
// Reads the fleet view with the real bd and prints the two human surfaces.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const m = await import(`${process.env.REPO}/dist/src/index.js`);
const exec = promisify(execFile);
const cwd = process.env.SCRATCH;
const runBd = async (argv, options = {}) => ({
  stdout: (
    await exec("bd", [...argv], {
      cwd: options.cwd ?? cwd,
      timeout: options.timeoutInMs,
      maxBuffer: options.maxBufferInBytes,
      env: { ...process.env, BEADS_ACTOR: "" },
    })
  ).stdout,
});

const read = m.readFleetStatus({ cwd, fleetId: m.DEFAULT_FLEET_ID });
if (!read.ok) {
  console.error(read.error);
  process.exit(1);
}
const taskIds = m.fleetBeadTaskIds(read.value);
const beads = await m.lookupFleetBeads({ taskIds, cwd, runBd });
const engagement = await m.lookupFleetBeadEngagement({ taskIds, cwd, runBd });
const status = m.applyFleetBeadEngagement(m.applyFleetBeadLookup(read.value, beads), engagement);
console.log(m.formatFleetStatus(status));
console.log("--- formatNeedsYou ---");
console.log(m.formatNeedsYou(status) ?? "(undefined: nothing needs a human)");
console.log("--- formatFleetRunStops ---");
for (const line of m.formatFleetRunStops(read.value.intent?.run)) console.log(line);
JS

cd "$SCRATCH" && node /tmp/bd279-final/render.mjs
```

Real output (the `Members`/`Warnings` sections are elided; nothing else is):

```text
Fleet default
  intent: bd-mzm, bd-e7o
  run: until-complete — halted: partial: 1 member stopped
  stopped bd-mzm (land-failed): publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy
  members: 2
  states: active=2 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0
  capacity: ceiling 3, 3 free, 0 counted
    default: 2 member(s), 0 counted (0 live, 0 unknown, 2 absent), 1 stopped, 0 released; supervisor none

Needs you (1): bd-mzm
  - bd-mzm (assignee (unassigned), stopped land-failed) — publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy

…… Member bd-e7o / Member bd-mzm blocks elided ……

--- formatNeedsYou ---
Needs you (1): bd-mzm
  - bd-mzm (assignee (unassigned), stopped land-failed) — publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy
--- formatFleetRunStops ---
stopped bd-mzm (land-failed): publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy
```

The member is `active` (its worktree and workflow are fine) and yet it appears in
`Needs you` — because `run.stopped` says a person has to decide. Before bd-279 the
block was empty here and only the header line carried the fact.

`belayd_status` for the same bead (the single-bead ownership section, driven by
`formatBeadOwnership` with the stop `findRecordedStop` reads out of `fleet.json`)
prints this shape — the walkthrough above cannot show it, because no pi session
drives the scratch bead:

```text
**Bead bd-mzm**
- stop: land-failed — publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy
**Needs you** — bd-mzm is waiting on a human.
```

### 4. The tick opens one described gate

Save this as `/tmp/bd279-final/tick.mjs` — plan, open-or-adopt, record the ids:

```bash
cat > /tmp/bd279-final/tick.mjs <<'JS'
// One escalation tick: plan, open (or adopt) the gates, record their ids on the stops.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const m = await import(`${process.env.REPO}/dist/src/index.js`);
const exec = promisify(execFile);
const cwd = process.env.SCRATCH;
const intentPath = `${cwd}/.git/belayd/fleet/default/fleet.json`;
const runBd = async (argv, options = {}) => ({
  stdout: (
    await exec("bd", [...argv], {
      cwd: options.cwd ?? cwd,
      timeout: options.timeoutInMs,
      maxBuffer: options.maxBufferInBytes,
      env: { ...process.env, BEADS_ACTOR: "" },
    })
  ).stdout,
});

const intent = m.parseFleetIntent(JSON.parse(readFileSync(intentPath, "utf8")));
const parked =
  intent.park === undefined
    ? undefined
    : { reason: intent.park.reason, recordedAt: intent.park.recordedAt };

const plan = m.planFleetEscalations({
  fleetId: intent.fleetId,
  run: intent.run,
  taskIds: intent.taskIds,
  ...(parked === undefined ? {} : { parked }),
});
console.log(`plan: ${plan.length} escalation(s)`);
for (const entry of plan) {
  console.log(`  title:  ${entry.title}`);
  console.log(`  reason: ${entry.reasonText}`);
}

const ensured = await m.ensureFleetEscalationGates({
  cwd,
  runBd,
  fleetId: intent.fleetId,
  plan,
});
const list = (gates) => gates.map((gate) => `${gate.gateId} (${gate.cause})`).join(", ") || "(none)";
console.log(`created: ${list(ensured.created)}`);
console.log(`adopted: ${list(ensured.adopted)}`);
if (!ensured.ok) console.log(`error: ${ensured.error}`);

const run = m.applyFleetEscalationGates({ run: intent.run, gates: ensured.gates, now: Date.now() });
writeFileSync(intentPath, `${JSON.stringify({ ...intent, run }, null, 2)}\n`);
console.log("run.stopped after the tick:");
console.log(JSON.stringify(run.stopped, null, 2));
JS

cd "$SCRATCH" && node /tmp/bd279-final/tick.mjs
```

Real output:

```text
plan: 1 escalation(s)
  title:  belayd-fleet-escalation: fleet:default bd-mzm land-failed r1762344500000
  reason: belayd-fleet-escalation: fleet:default bd-mzm land-failed r1762344500000: bd-mzm stopped the run with cause `land-failed`, which needs a human decision — publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy. Answer with `bd gate resolve <gate-id> --reason "<what you chose>"`: retry, abandon, or release; the fleet records that note as the decision it acts on
created: bd-b01 (land-failed)
adopted: (none)
run.stopped after the tick:
[
  {
    "taskId": "bd-mzm",
    "reason": "land-failed",
    "detail": "publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy",
    "at": 1762344500000,
    "gateId": "bd-b01"
  }
]
```

What bd itself holds (`bd gate create --blocks <member> --type=human`):

```bash
cd "$SCRATCH" && BEADS_ACTOR= bd gate list "$A" --json \
  | jq '.[] | {id, title, description, status, await_type}'
GA=$(bd gate list "$A" --json | jq -r '.[0].id')   # the escalation gate, for step 6
```

```text
{
  "id": "bd-b01",
  "title": "belayd-fleet-escalation: fleet:default bd-mzm land-failed r1762344500000",
  "description": "Ad-hoc gate blocking bd-mzm\n\nReason: belayd-fleet-escalation: fleet:default bd-mzm land-failed r1762344500000: bd-mzm stopped the run with cause `land-failed`, which needs a human decision — publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy. Answer with `bd gate resolve <gate-id> --reason \"<what you chose>\"`: retry, abandon, or release; the fleet records that note as the decision it acts on",
  "status": "open",
  "await_type": "human"
}
```

The bead is now **blocked in bd by a human gate whose text says what to decide** —
that is the whole point: no `fleet.json` archaeology.

### 5. A second tick opens nothing

```bash
cd "$SCRATCH" && node /tmp/bd279-final/tick.mjs | head -4
```

```text
plan: 0 escalation(s)
created: (none)
adopted: (none)
run.stopped after the tick:
```

The stop record carries `gateId`, so the planner skips it before bd is asked. The
second source of idempotence is bd's own marker: strip the recorded id (a failed
intent write looks exactly like this) and the re-tick adopts instead of creating:

```bash
cd "$SCRATCH" && F=.git/belayd/fleet/default/fleet.json
jq 'del(.run.stopped[0].gateId)' "$F" > /tmp/f.json && mv /tmp/f.json "$F"
node /tmp/bd279-final/tick.mjs | sed -n '/^created/p;/^adopted/p'
BEADS_ACTOR= bd gate list "$A" --json | jq 'length'
```

```text
created: (none)
adopted: bd-b01 (land-failed)
1
```

One gate, one recorded id — never two.

### 6. Answering the gate records the decision

```bash
cd "$SCRATCH" && BEADS_ACTOR= bd gate resolve "$GA" \
  --reason "retry: the proof-artifact refusal was a repo-policy bug, fixed in the policy file"
```

```text
✓ Gate resolved: bd-b01
  Reason: retry: the proof-artifact refusal was a repo-policy bug, fixed in the policy file
```

Now the drift check reads bd's resolved gate and writes the answer onto the stop.
Save `/tmp/bd279-final/reconcile.mjs`:

```bash
cat > /tmp/bd279-final/reconcile.mjs <<'JS'
// The drift check: read bd's gates, record answers, reap escalations nothing needs.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const m = await import(`${process.env.REPO}/dist/src/index.js`);
const exec = promisify(execFile);
const cwd = process.env.SCRATCH;
const intentPath = `${cwd}/.git/belayd/fleet/default/fleet.json`;
const runBd = async (argv, options = {}) => ({
  stdout: (
    await exec("bd", [...argv], {
      cwd: options.cwd ?? cwd,
      timeout: options.timeoutInMs,
      maxBuffer: options.maxBufferInBytes,
      env: { ...process.env, BEADS_ACTOR: "" },
    })
  ).stdout,
});

const intent = m.parseFleetIntent(JSON.parse(readFileSync(intentPath, "utf8")));
const parked =
  intent.park === undefined
    ? undefined
    : { reason: intent.park.reason, recordedAt: intent.park.recordedAt };
const checked = await m.checkFleetEscalationGates({
  cwd,
  runBd,
  fleetId: intent.fleetId,
  run: intent.run,
  now: Date.now(),
  taskIds: intent.taskIds,
  ...(parked === undefined ? {} : { parked }),
});
writeFileSync(intentPath, `${JSON.stringify({ ...intent, run: checked.run }, null, 2)}\n`);
console.log(`reaped: ${checked.reaped.join(", ") || "(none)"}`);
console.log(`warnings: ${checked.warnings.join("\n") || "(none)"}`);
console.log("notices:");
for (const notice of checked.notices) console.log(`  - ${notice.message}`);
console.log("run.stopped:");
console.log(JSON.stringify(checked.run.stopped, null, 2));
JS

cd "$SCRATCH" && node /tmp/bd279-final/reconcile.mjs
```

Real output:

```text
reaped: (none)
warnings: (none)
notices:
run.stopped:
[
  {
    "taskId": "bd-mzm",
    "reason": "land-failed",
    "detail": "publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy",
    "at": 1762344500000,
    "gateId": "bd-b01",
    "resolution": {
      "note": "retry: the proof-artifact refusal was a repo-policy bug, fixed in the policy file",
      "at": 1793909194123
    }
  }
]
```

No warning fired — the two sides agree, which is exactly what "resolving the gate is
reflected in the stop record (no drift warning)" means. `at` is the moment the
answer was read; yours differs.

Both renderers now show the answer, and the run header's stop line agrees with the
`Needs you` entry:

```bash
cd "$SCRATCH" && node /tmp/bd279-final/render.mjs | sed -n '1,6p;/--- formatNeedsYou/,$p'
```

```text
Fleet default
  intent: bd-mzm, bd-e7o
  run: until-complete — halted: partial: 1 member stopped
  stopped bd-mzm (land-failed): publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy — answered: retry: the proof-artifact refusal was a repo-policy bug, fixed in the policy file
  members: 2
--- formatNeedsYou ---
Needs you (1): bd-mzm
  - bd-mzm (assignee (unassigned), stopped land-failed) — publish gate refused: proof-artifacts-in-diff… (answered: retry: the proof-artifact refusal was a repo-policy bug, fi…)
--- formatFleetRunStops ---
stopped bd-mzm (land-failed): publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy — answered: retry: the proof-artifact refusal was a repo-policy bug, fixed in the policy file
```

The `…` are the 120-character excerpt budget on the `Needs you` line; the full note
is on the run header line and in `fleet.json`. bd's side of the same fact:

```bash
cd "$SCRATCH" && BEADS_ACTOR= bd gate list "$A" --all --json \
  | jq -r '.[] | "\(.id)\t\(.status)\t\(.close_reason)"'
```

```text
bd-b01	closed	retry: the proof-artifact refusal was a repo-policy bug, fixed in the policy file
```

A second reconcile changes nothing:

```bash
cd "$SCRATCH" && node /tmp/bd279-final/reconcile.mjs | sed -n '1,2p'
```

```text
reaped: (none)
warnings: (none)
```

`resolution.at` in `fleet.json` is identical after the second pass: an answered stop is
settled and is never re-read, so a later note-less read cannot erase the decision
(`re-reading an answered gate › keeps the first answer and its instant, and stops
re-reading the closed gate`).

### 7. Drift: a parked fleet, an unpark, a vanished gate

**a. A park opens one gate per member still in flight.** Park the fleet and mark
`B` in flight again:

```bash
cd "$SCRATCH" && F=.git/belayd/fleet/default/fleet.json
jq --arg b "$B" '.park = {"reason":("the recorded root stash could not be restored after landing " + $b),"stashRef":"stash@{0}","recordedAt":1762344700000}
    | del(.run.members[1].landedAt)' "$F" > /tmp/f.json && mv /tmp/f.json "$F"
node /tmp/bd279-final/tick.mjs | sed -n '/^plan/p;/^  title/p;/^created/p;/^adopted/p'
```

```text
plan: 1 escalation(s)
  title:  belayd-fleet-escalation: fleet:default bd-e7o fleet-parked r1762344700000
created: bd-ixu (fleet-parked)
adopted: (none)
```

Its reason is the park's own wording:

```text
belayd-fleet-escalation: fleet:default bd-e7o fleet-parked r1762344700000: bd-e7o cannot proceed because the fleet is parked (fleet-parked) — the recorded root stash could not be restored after landing bd-e7o. Answer with `bd gate resolve <gate-id> --reason "<what you chose>"`: retry, abandon, or release; the fleet records that note as the decision it acts on
```

The already-answered stop on `bd-mzm` was not re-escalated. A park has no per-member
stop record to carry a `gateId`, so its idempotence lives in bd: re-tick the same
park and it is adopted.

```bash
cd "$SCRATCH" && node /tmp/bd279-final/tick.mjs | sed -n '/^created/p;/^adopted/p'
```

```text
created: (none)
adopted: bd-ixu (fleet-parked)
```

**b. A member's stop escalation and a park gate coexist; an unpark touches only the
park one.** Add a stop for `bd-e7o` while the fleet is still parked:

```bash
cd "$SCRATCH" && F=.git/belayd/fleet/default/fleet.json
jq --arg b "$B" '.run.stopped += [{"taskId":$b,"reason":"phase-failed","detail":"phase review failed: the verifier rejected the diff","at":1762344750000}]' \
  "$F" > /tmp/f.json && mv /tmp/f.json "$F"
node /tmp/bd279-final/tick.mjs | sed -n '/^plan/p;/^  title/p;/^created/p'
BEADS_ACTOR= bd gate list "$B" --json | jq -r '.[] | "\(.id)\t\(.title)"'
GE=$(bd gate list "$B" --json | jq -r '.[] | select(.title | contains("phase-failed")) | .id')
```

```text
plan: 1 escalation(s)
  title:  belayd-fleet-escalation: fleet:default bd-e7o phase-failed r1762344750000
created: bd-8l0 (phase-failed)
bd-8l0	belayd-fleet-escalation: fleet:default bd-e7o phase-failed r1762344750000
bd-ixu	belayd-fleet-escalation: fleet:default bd-e7o fleet-parked r1762344700000
```

Now unpark and run the scoped sweep (what `belayd_fleet_resume` and an
`unpark:unparked:` reconcile do):

```bash
cat > /tmp/bd279-final/sweep.mjs <<'JS'
// By-prefix repair sweep: resolve the escalation gates of beads whose record is gone.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const m = await import(`${process.env.REPO}/dist/src/index.js`);
const exec = promisify(execFile);
const cwd = process.env.SCRATCH;
const runBd = async (argv, options = {}) => ({
  stdout: (
    await exec("bd", [...argv], {
      cwd: options.cwd ?? cwd,
      timeout: options.timeoutInMs,
      maxBuffer: options.maxBufferInBytes,
      env: { ...process.env, BEADS_ACTOR: "" },
    })
  ).stdout,
});

const [scope, ...beadIds] = process.argv.slice(2);
const swept = await m.reapFleetEscalationGatesByPrefix({
  fleetId: "default",
  beadIds,
  cwd,
  runBd,
  ...(scope === "parked" ? { scope: "causes", causes: ["fleet-parked"] } : { scope: "whole-bead" }),
});
const list = (gates) => gates.map((gate) => `${gate.gateId} (${gate.cause})`).join(", ") || "(none)";
console.log(`resolved: ${list(swept.resolved)}`);
console.log(`warnings: ${swept.warnings.join("; ") || "(none)"}`);
JS

cd "$SCRATCH" && F=.git/belayd/fleet/default/fleet.json
jq 'del(.park)' "$F" > /tmp/f.json && mv /tmp/f.json "$F"
node /tmp/bd279-final/sweep.mjs parked "$B"
BEADS_ACTOR= bd gate list "$B" --all --json | jq -r '.[] | "\(.id)\t\(.status)\t\(.title)"'
```

```text
resolved: bd-ixu (fleet-parked)
warnings: (none)
bd-8l0	open	belayd-fleet-escalation: fleet:default bd-e7o phase-failed r1762344750000
bd-ixu	closed	belayd-fleet-escalation: fleet:default bd-e7o fleet-parked r1762344700000
```

The unpark resolved the park gate and left the member's own stop escalation open —
an unpark can never answer a decision a person still owes.

**c. A stop whose gate vanished warns, and names the recovery.** Create a third bead
and record a stop that names a gate bd never had (a hand-edited record, or a gate
somebody deleted):

```bash
cd "$SCRATCH" && export BEADS_ACTOR=
C=$(bd create "Escalation probe: a stop whose gate vanished" -t task --json | jq -r .id)
F=.git/belayd/fleet/default/fleet.json
jq --arg c "$C" '.taskIds += [$c]
  | .run.stopped += [{"taskId":$c,"reason":"accept-failed","detail":"bd close refused: the bead is held by another session","at":1762344850000,"gateId":"bd-zzz"}]' \
  "$F" > /tmp/f.json && mv /tmp/f.json "$F"
node /tmp/bd279-final/reconcile.mjs | sed -n '/^notices/,/^run.stopped/p'
```

```text
notices:
  - the stop of bd-vj7 (accept-failed) records gate bd-zzz, but bd has no such gate; the stop keeps that id, so no new escalation is opened for it — clear the stop with belayd_fleet_reconcile {"retryMembers":["bd-vj7"]} (the next tick then opens a fresh escalation), or recreate the gate by hand
run.stopped:
```

**d. A note-less answer stays distinguishable from "still waiting".** Resolve
`bd-8l0` with no `--reason`:

```bash
cd "$SCRATCH" && BEADS_ACTOR= bd gate resolve "$GE" && node /tmp/bd279-final/reconcile.mjs >/dev/null
node /tmp/bd279-final/render.mjs | sed -n '/--- formatNeedsYou/,$p'
```

```text
--- formatNeedsYou ---
Needs you (2): bd-e7o, bd-mzm
  - bd-e7o (assignee (unassigned), stopped phase-failed) — phase review failed: the verifier rejected the diff (answered, no note)
  - bd-mzm (assignee (unassigned), stopped land-failed) — publish gate refused: proof-artifacts-in-diff… (answered: retry: the proof-artifact refusal was a repo-policy bug, fi…)
--- formatFleetRunStops ---
stopped bd-mzm (land-failed): publish gate refused: proof-artifacts-in-diff is not allowed by this repo policy — answered: retry: the proof-artifact refusal was a repo-policy bug, fixed in the policy file
stopped bd-e7o (phase-failed): phase review failed: the verifier rejected the diff — answered, no note
stopped bd-vj7 (accept-failed): bd close refused: the bead is held by another session
```

`bd-vj7` has no answer and reads as an open stop; `bd-e7o` is answered with no note
and says so on both surfaces. Also note `bd-vj7` does **not** appear in the
`Needs you` list: it has no worktree, so it is not a member — see
[Known limits](#known-limits).

**e. A member that left the fleet: the by-prefix sweep is the path that reaps.**
Record a stop for `bd-mzm`, tick, then clear the stop the way a retry does:

```bash
cd "$SCRATCH" && F=.git/belayd/fleet/default/fleet.json
jq --arg a "$A" '.run.stopped += [{"taskId":$a,"reason":"orchestrator-missing","detail":"the member orchestrator session is gone; no lease held","at":1762344950000}]' \
  "$F" > /tmp/f.json && mv /tmp/f.json "$F"
node /tmp/bd279-final/tick.mjs | sed -n '/^created/p'
jq --arg a "$A" 'del(.run.stopped[] | select(.taskId==$a))' "$F" > /tmp/f.json && mv /tmp/f.json "$F"
echo "--- check alone sees no stop for $A, so the extension sweeps by prefix ---"
node /tmp/bd279-final/sweep.mjs whole-bead "$A"
BEADS_ACTOR= bd gate list "$A" --all --json | jq -r '.[] | "\(.id)\t\(.status)\t\(.title)"'
```

```text
created: bd-cp4 (orchestrator-missing)
--- check alone sees no stop for bd-mzm, so the extension sweeps by prefix ---
resolved: bd-cp4 (orchestrator-missing)
warnings: (none)
bd-b01	closed	belayd-fleet-escalation: fleet:default bd-mzm land-failed r1762344500000
bd-cp4	closed	belayd-fleet-escalation: fleet:default bd-mzm orchestrator-missing r1762344950000
```

The extension calls this sweep on landing (`landed member`), on a relaunch
(`relaunched member`), and from `belayd_fleet_reconcile` (`retried member` /
`pruned member`), and audits it as `escalation-gates-resolved`.

### 8. Negative cases: what must **not** open a gate

```bash
cat > /tmp/bd279-final/negatives.mjs <<'JS'
const m = await import(`${process.env.REPO}/dist/src/index.js`);
const { evaluateDeferredFindingsGate } = await import(
  `${process.env.REPO}/dist/src/finding-publication.js`
);
const { reviewFindingsGateTitle } = await import(`${process.env.REPO}/dist/src/review-findings.js`);

// 1. An ordering wait or a capacity deferral leaves no stop record, so nothing is planned.
const waiting = {
  schemaVersion: 1,
  mode: "until-complete",
  startedAt: 1762344000000,
  updatedAt: 1762344600000,
  ticks: 4,
  // `bd-e7o`/`bd-mzm` here are illustrative member ids, not your walkthrough's.
  members: [{ taskId: "bd-e7o", launchedAt: 1762344000000 }],
  haltedReason: "stalled: capacity deferred bd-e7o (no free slot)",
};
console.log(
  "plan for an ordering wait / capacity deferral:",
  JSON.stringify(m.planFleetEscalations({ fleetId: "default", run: waiting, taskIds: ["bd-e7o"] })),
);

// 2. An ordering gate bd holds carries a different marker, so it is not an escalation.
const orderingTitle = m.renderFleetOrderingGateMarker({
  fleetId: "default",
  blocker: "bd-e7o",
  blocked: "bd-mzm",
});
const orderingRecord = {
  id: "bd-ord1",
  title: orderingTitle,
  description: `Ad-hoc gate blocking bd-mzm\n\nReason: ${orderingTitle}: waits for bd-e7o to land`,
  status: "open",
  await_type: "bead",
};
console.log("ordering title:", orderingTitle);
console.log(
  "open escalation gates in that record list:",
  JSON.stringify(m.parseOpenFleetEscalationGates([orderingRecord])),
);

// 3. Withheld sensitive findings keep the review gate's own ask-human gate.
const findings = {
  schemaVersion: 1,
  taskId: "bd-mzm",
  phase: "review",
  round: 2,
  reason: "review round 2",
  artifactPath: `${process.env.SCRATCH}/wt-a/.belayd/review-findings.json`,
  findings: [
    {
      finding: "the AWS secret is written to the log in plaintext",
      severity: "critical",
      phase: "review",
      round: 2,
      disposition: { kind: "deferred", reason: "out of scope for this change" },
      dispositionSource: "recorded",
      publication: { kind: "withhold" },
    },
  ],
};
console.log("evaluateDeferredFindingsGate:", JSON.stringify(evaluateDeferredFindingsGate(findings)));
console.log("review gate title:", reviewFindingsGateTitle({ taskId: "bd-mzm", round: 2, sensitive: true }));
console.log('isFleetEscalationCause("sensitive-findings-withheld"):', m.isFleetEscalationCause("sensitive-findings-withheld"));
console.log("FLEET_ESCALATION_CAUSES:", JSON.stringify(m.FLEET_ESCALATION_CAUSES));

// 4. A bead comment can never answer an escalation gate.
const escalationRecord = {
  id: "bd-b01",
  title: "belayd-fleet-escalation: fleet:default bd-mzm land-failed r1762344500000",
  description: "Ad-hoc gate blocking bd-mzm",
  status: "open",
  await_type: "human",
};
console.log(
  "openHumanGateFromRecord(escalation gate):",
  JSON.stringify(m.openHumanGateFromRecord(escalationRecord, "bd-mzm")),
);
JS

cd "$SCRATCH" && node /tmp/bd279-final/negatives.mjs
```

Real output:

```text
plan for an ordering wait / capacity deferral: []
ordering title: belayd-fleet-ordering: fleet:default bd-e7o -> bd-mzm
open escalation gates in that record list: []
evaluateDeferredFindingsGate: {"ok":false,"reason":"sensitive-findings-withheld","findings":["the AWS secret is written to the log in plaintext"]}
review gate title: belayd-review: bd-mzm sensitive findings (round 2)
isFleetEscalationCause("sensitive-findings-withheld"): false
FLEET_ESCALATION_CAUSES: ["awaiting-human","phase-failed","phase-interrupted","orchestrator-missing","state-corrupt","land-failed","accept-failed","fleet-parked"]
openHumanGateFromRecord(escalation gate): undefined
```

The tick-level versions of these negatives (no `belayd-fleet-escalation:` create
for a capacity deferral, for a dependency wait, or for a gate failure the loop
retries) are pinned by tests — see step 9.

### 9. Tests that pin it

| File | Tests |
| --- | --- |
| `src/__tests__/fleet-escalation.test.ts` (new) | `renders the marker into the title so bd's own list names the escalation` · `names the member, cause, detail and the three options a human may choose` · `bounds a hand-edited park reason exactly like a stop detail` · `planFleetEscalations plans exactly one escalation per stop, for every reason` · `does not re-plan a stop that was already escalated or answered` · `escalates a parked fleet once per member still in flight, with the park as the round` · `opens no parked gate for a landed member or a second one for a stopped member` · `adopts the park gate a previous tick already opened instead of stacking one` · `produces no escalation for ordering waits, capacity deferrals or quality gates` · `opens no second gate for withheld sensitive findings` · `refuses an empty or flag-shaped bead id before spawning bd` · `refuses a non-read argv without spawning bd` · `creates a human gate that blocks the stopped member` · `adopts the gate bd already has, so a second tick opens nothing` · `refuses and creates nothing when bd's gate list fails` · `keeps the stop record exactly as written when bd's gate list fails` · `keeps the gates it opened when a later create fails` · `reports a create that exited 0 without a usable gate id, and records nothing` · `adopts an open gate with the same marker instead of creating a duplicate` · `uses the gates the caller already read instead of reading bd again` · `records the gate id back onto the stop record and skips park escalations` · `stays silent when an open gate matches the stop record` · `reaps and warns once when the gate no longer matches a stop record` · `adopts a park gate on a re-tick and reaps the one an earlier park left` · `treats bd's exact gate-not-found answer as resolved, any other failure as a warning` · `reads a closed gate's note into the stop record and fires no warning` · `warns about a recorded gate bd has never heard of` · `adopts an open gate whose stop record lost its gate id` · `reports a read failure instead of treating it as answered` · `does nothing when the run stopped nobody and the fleet is not parked` · `resolves only the selected cause, leaving a member's stop escalation in force` · `resolves every escalation on a bead that left the fleet` · `reports a read failure without resolving anything` · `keeps the first answer and its instant, and stops re-reading the closed gate` · `keeps the recorded gate and resolves the duplicate` · `keeps the lowest gate id deterministically when none is recorded` · `still resolves the other duplicates when one resolve fails` |
| `src/__tests__/fleet-status.test.ts` | `admits a member the run stopped, with its reason and detail, for every stop reason` (loops all seven) · `bounds the stop detail and appends the answer a person chose` · `says a stop was answered even when the resolver left no note` · `reads a hand-edited blank note as answered on both status surfaces` · `lists a stopped member once when its bead also needs a human` · `caps a wave of stopped members the same way and names the remainder` · `renders the stop a fleet recorded, and flags needs-you from it alone` |
| `src/__tests__/fleet-run.test.ts` | `round-trips gateId and resolution through the schema` · `still validates a stop written before the escalation primitive` · `renders the answer after the stop line without changing a plain stop` · `says a stop was answered even when the resolver left no note` · `classifies a stop's answer once, for every renderer` · `treats a blank note as answered without a note` · `keeps an answered line inside the record bound` |
| `src/__tests__/bead-gates.test.ts` (`describe("fleet escalation gates (bd-279)")`) | `renders and parses the structured marker, and refuses anything else` · `classifies from the title and treats a disagreeing reason as not an escalation` · `warns when the reason lost the marker and not otherwise` · `is neither an open nor a resolved human gate` · `reports an open escalation gate as unrecognized, never as a resolved wait` · `fails closed on a marked escalation record the open-gate parser cannot read` · `keeps a closed escalation gate out of the way: no open gates is still none` · `keeps an ordering gate a machine wait: still none, with its blocker` · `keeps an empty gate list the legacy resolution` · `does not let an open escalation gate shadow the ask-human gate on the same bead` · `never reports a closed escalation gate as the answer to a comment wait` · `lists open escalation gates and their drift` |
| `src/__tests__/extension-fleet-p1.test.ts` | `opens one described escalation gate for the stop it just recorded, and none on the next tick` · `keeps the stop record when bd's gate list fails, creating nothing blind` · `resolves the escalation gate a retry orphaned, and audits it (bd-279)` · `warns with bd's own error text when an escalation gate cannot be resolved (bd-279 S2)` · `writes a capacity deferral without opening an escalation gate` · `creates only the ordering gate for a dependency wait, never an escalation` · `opens no escalation for a machine-resolvable gate failure the loop retries` · `resolves a landed member's escalation gate and audits the landing` · `resolves a relaunched member's old escalation gate on the advance tick` · `unparks only the parked-fleet escalation, never a member's stop escalation` |
| `src/__tests__/extension-fleet-status-tool.test.ts` | `reads the stop for the viewed bead out of fleet.json` · `adds nothing when no fleet has a stop for the bead` · `matches a mixed-case recorded id, the way the record was written` · `finds the record in the fleet that owns the bead, not just the first one` |
| `src/__tests__/extension-human-answer.test.ts` | `warns once per bead, so a second blocked bead later in the session still warns` · `forgets a cleared wait, so a new question on the same bead warns again` · `keeps the per-bead memory bounded in a long session` |
| `src/__tests__/workflow-digest.test.ts`, `src/__tests__/extension-supervision-tools.test.ts` | `does not report a successful read as a gate read failure (bd-279 S2)` · `renders a cleanly parsed escalation gate as unrecognized, never as a failed read (bd-279 S2)` |
| `test/fleet-status.integration.test.ts` | `serves the belayd_fleet_status tool without touching any worktree` (real git, real `fleet.json`) |

### 10. Cleanup

```bash
rm -rf "$SCRATCH" /tmp/bd279-final
```

## How to Use

### Start here: `belayd_fleet_status`'s `Needs you` block

The block answers "what must I do", and since bd-279 a stopped member is in it. Read
each entry as *who* + *what state* + *what happened*:

```text
Needs you (2): bd-e7o, bd-mzm
  - bd-e7o (assignee (unassigned), stopped phase-failed) — phase review failed: the verifier rejected the diff (answered, no note)
  - bd-mzm (assignee (unassigned), stopped land-failed) — publish gate refused: proof-artifacts-in-diff… (answered: retry: the proof-artifact refusal was a repo-policy bug, fi…)
```

- `stopped <reason>` is the run's own stop reason, one of the seven in
  [the cause list](#the-cause-list).
- The text after `—` is the stop **detail** (excerpted to 120 characters), i.e. the
  escalation's description, not a comment.
- `(answered: …)` / `(answered, no note)` mean a person already resolved the gate.
  Those are opposite next actions from an entry with no answer at all: an unanswered
  stop is waiting on you.
- The header's `stopped <task> (<reason>): <detail>` lines stay, and now carry the
  same answer suffix, so the log line and the scan list cannot disagree.

The list is bounded to 10 entries (`NEEDS_YOU_LIST_MAX`) and ends with `…and N more`
when a whole wave stopped. `belayd_status` for one bead shows the same fact as
`- stop: <reason> — <detail> (answered: …)` plus `**Needs you** — <id> is waiting on
a human.`

### Answering: retry, abandon, release

Every escalation gate names the three options in its reason, because they are the
three things a supervisor can do with a stopped member. The gate id is the one in the
gate's own title (`belayd-fleet-escalation: fleet:<fleetId> <taskId> <cause> r<round>`
— see [telling the families apart](#telling-the-three-gate-families-apart-operators)):

```bash
BEAD='<bead-id>'        # the stopped member's bead; bd-mzm in the walkthrough above
GATE=$(bd gate list "$BEAD" --json | jq -r '.[0].id')
bd gate resolve "$GATE" --reason "retry: the policy file is fixed, re-plan the wave"
```

The note's leading verb is what the next reader acts on, and it decides the repair:

- **retry** — clear the stop so the next tick re-plans the member:
  `belayd_fleet_reconcile {"retryMembers":["<bead-id>"]}`. The old escalation gate is
  resolved by the repair sweep and audited as `escalation-gates-resolved`
  (`retried member`), and the next tick opens a fresh gate for a fresh stop.
- **abandon** — the same repair, then close the bead as not planned. Nothing opens a
  new gate for an abandoned member.
- **release** — `belayd_fleet_release <bead-id>`: the bead, worktree and transcript
  stay, the member stops consuming a capacity slot (`reason: operator-release`). A
  later landing or relaunch still finds the bead.

Write the *verb* first in the note. It is the only place a later reader — the
supervisor, the next session, you in three days — learns what was decided.

### Where the answer is recorded

Three places, one fact:

| Surface | What it shows |
| --- | --- |
| `fleet.json` → `run.stopped[] → resolution: { note, at }` | the decision itself; `note` is one line, bounded to `FLEET_RUN_DETAIL_MAX_LENGTH` (400) |
| run header line (`formatFleetRunStops`) | `stopped bd-mzm (land-failed): … — answered: <note>` or `… — answered, no note` |
| `Needs you` entry / `belayd_status` | the same, excerpted to the 120-character block budget |

The first answer wins: an answered stop is never re-read, so a later reconcile cannot
rewrite `resolution.at` or erase the note. A resolver that left no `--reason` is
still recorded — as *answered, no note* — which is deliberately different from
"still waiting".

### "The escalation gate is gone"

A tick may report:

```text
the stop of bd-vj7 (accept-failed) records gate bd-zzz, but bd has no such gate; the stop keeps that id, so no new escalation is opened for it — clear the stop with belayd_fleet_reconcile {"retryMembers":["bd-vj7"]} (the next tick then opens a fresh escalation), or recreate the gate by hand
```

Pick one:

- `belayd_fleet_reconcile {"retryMembers":["bd-vj7"]}` — clears the stop (and the
  dead id); the next tick opens a fresh escalation gate for the member.
- recreate the gate by hand with the same marker and title:
  `bd gate create --blocks bd-vj7 --type=human --title '<marker>' --reason '<marker>: …'`
  (the warning from `bd gate create` exiting 0 without a usable id prints this
  command for you).

If instead a *member* is stuck and its bead still has an open
`belayd-fleet-escalation:` gate nothing can answer, that is the same repair:
`belayd_fleet_reconcile {"retryMembers":[…]}` re-plans it, and the by-prefix sweep
resolves the orphan.

### Telling the three gate families apart (operators)

All three are bd `human`/`bead` gates blocking a bead, so the **title** is the only
thing that tells you who owns the answer:

| Title | Family | Who answers | What "answered" means |
| --- | --- | --- | --- |
| `belayd-fleet-escalation: fleet:<fleetId> <taskId> <cause> r<round>` | fleet escalation (bd-279) | a person, by resolving the gate | the answer is the decision; it is read onto `run.stopped[]` |
| `belayd-fleet-ordering: fleet:<fleetId> <blocker> -> <blocked>` | fleet ordering (bd-158) | the fleet, when the blocker lands | a machine wait; never a human question |
| `belayd-review: <taskId> sensitive findings (round <n>)` | review publication gate (`belayd_ask_human`, bd-183/bd-252) | a person, by a bead comment / the ask-human tool | the publication decision for that round's sensitive findings |

```bash
# every open gate on this repository, by family (`bd gate list` needs no bead id)
bd gate list --json | jq -r '.[] | "\(.id)\t\(.title)"'
# just the fleet escalations
bd gate list --json | jq -r '.[] | select(.title | startswith("belayd-fleet-escalation:")) | "\(.id)\t\(.title)"'
```

Use `--json`: plain `bd gate list <bead>` prints only the gate id and its type
(`○ bd-a5t - human`), so the title — the one thing that says which family a gate
belongs to — is not on that surface.

Real output in this worktree (no escalation gate was open at the time; the review and
ordering families are the two the fleet normally holds):

```text
bd-285	belayd-review: bd-279 sensitive findings (round 4)
bd-282	belayd-fleet-ordering: fleet:truth bd-279 -> bd-280
```

```text
(no output)
```

Because the marker is structured (`fleet:`, the ids, the cause, `r<round>`), a gate
whose title merely *starts* with the prefix is not an escalation: parsing requires
the full shape, and a title/description disagreement is fail-closed (`not an
escalation`). A truncated or re-folded reason is reported once per gate:

```text
gate bd-x1 carries the fleet escalation marker in its title but not in its reason (bd truncated or re-folded the reason); classified from the title
```

### Why a comment can never answer an escalation gate

The phase-tool answer channel (`belayd_ask_human`'s poll) reads `bd gate list` and
treats a comment as the answer. Escalation records are excluded from both
`openHumanGateFromRecord` and `resolvedHumanGateFromRecord` in `src/bead-gates.ts`,
so:

- a comment on the bead does **not** answer an escalation gate — the stop is still
  stopped and the member is still blocked;
- the ask-human wait on the same bead stays armed (`lookupOpenHumanGate` returns
  `unrecognized`, not `none`) while an escalation gate is open, so a stop cannot
  "answer" a `belayd_ask_human` question nobody answered;
- once the escalation gate is `closed`, the ask-human wait reads `none` again and
  recovers. That is the one escape hatch and it is deliberate.

The digest renders that state as its own line rather than as a read failure:

```text
- waiting on: unknown (gate state unrecognized: bd listed open gates, none of them asks this wait)
```

## The contract

### The marker

`src/bead-gates.ts` owns the prefix, the renderer and a parser built from the same
constant, so the two cannot drift:

```text
belayd-fleet-escalation: fleet:<fleetId> <taskId> <cause> r<round>
```

- the prefix is `FLEET_ESCALATION_GATE_PREFIX = "belayd-fleet-escalation:"`;
- `<fleetId>`, `<taskId>` and `<cause>` are single tokens (`[A-Za-z0-9][A-Za-z0-9._-]*`);
- `<round>` is `\d+` (an integer, never a float, never a timestamp with a decimal);
- the **title** is the marker alone; the **reason** is the marker followed by `": "`
  and the description (`bd` folds it into the gate's `description` as
  `…\n\nReason: <reason>`);
- prose after the round is allowed, prose before it is not — a marker that only looks
  like one (`belayd-fleet-escalation: please look at this`) parses as nothing;
- a record whose title carries the marker but whose description carries a
  *different* marker is not an escalation (anti-forgery, fail-closed);
- a record whose title carries the marker and whose description lost it is still an
  escalation (bd owns `--reason` and may cut it) and produces one drift line.

### The cause list

`FLEET_ESCALATION_CAUSES` is exactly:

```text
awaiting-human, phase-failed, phase-interrupted, orchestrator-missing, state-corrupt, land-failed, accept-failed, fleet-parked
```

The first seven are `FLEET_RUN_STOP_REASONS` (a run stop record, `run.stopped[]`);
the eighth is a parked fleet. `isFleetEscalationCause` narrows bd's untrusted marker
token against that list, which is why a gate naming an unknown cause is read as
"marked but not an escalation".

Deliberately **not** causes: an ordering wait (`belayd-fleet-ordering:`), a capacity
deferral, and a quality/publish gate failure the loop retries. Those are conditions a
machine resolves; gating them would be a second channel for something the loop
already owns.

### Rounds

The round is what makes idempotence per `(bead, cause, round)` — and it is a
different clock per cause:

| Cause family | Round is | Consequence |
| --- | --- | --- |
| a run stop | `stop.at`, the instant the stop was recorded | a re-tick of the same stop adopts; a new stop (a new `at`) opens a new gate |
| a parked fleet | `park.recordedAt` | re-ticking the same park adopts; a genuine re-park (new `recordedAt`) opens a new gate and the old one is reaped |
| withheld sensitive findings | the review **round number** (`belayd-review: … (round N)`) | one ask-human gate per round — see the divergence below |

The round is truncated with `Math.trunc` on both sides of every comparison, because
the marker renders an integer.

### Bounded text

| Text | Bound | Where |
| --- | --- | --- |
| stop `detail` | `FLEET_RUN_DETAIL_MAX_LENGTH` = 400 | `run.stopped[]` |
| escalation reason prose (after the marker) | `FLEET_ESCALATION_REASON_PROSE_MAX` = 700 | gate `--reason`; the marker itself is never truncated |
| resolution `note` | 400, whitespace-collapsed to one line | `run.stopped[].resolution.note` |
| run header answer | 187 characters (`FLEET_RUN_DETAIL_MAX_LENGTH / 2 - len(" — answered: ")`), with the stop detail bounded to the remainder | `formatFleetRunStops` |
| `Needs you` entry | the whole entry in `NEEDS_YOU_EXCERPT_MAX_CHARS` = 120, half of it to an answer note | `formatNeedsYouEntry` |
| `Needs you` list | `NEEDS_YOU_LIST_MAX` = 10, then `…and N more` | `formatNeedsYou` |

An unanswered entry renders the detail alone; an answered one spends part of the same
budget on the answer, so a long note can never push out the reason.

### The divergence for withheld sensitive findings

Withheld sensitive findings **do not open a fleet escalation gate**, and that is
intentional, not a gap:

- their one channel is the review gate's `belayd_ask_human` gate, titled
  `belayd-review: <taskId> sensitive findings (round <n>)`, one per round;
- `evaluateDeferredFindingsGate` (`src/finding-publication.ts`) stays the classifier
  (`sensitive-findings-withheld` / `sensitive-findings-awaiting-human`);
- `sensitive-findings-withheld` is deliberately absent from
  `FLEET_ESCALATION_CAUSES`, and `planFleetEscalations` cannot emit it (stop reasons
  are schema-restricted to the seven; the only other push is `fleet-parked`);
- the reason is the bead's own "must not": *add a second human channel*. Two gates
  for one condition are two channels, and a person answering one would leave the
  other open forever.

If you are tempted to "complete" the primitive by adding the cause, you are adding
the exact drift the design excludes. The correct change is to make the review gate's
gate say more, not to open a second one.

## Known limits

1. **`checkFleetEscalationGates` only visits beads a live stop or park names.** It
   builds its work list from `run.stopped[]` plus a park's in-flight members, so a
   stop record that vanishes without any repair path running (a hand-edited
   `fleet.json`, a restore) leaves its gate open until something sweeps the bead by
   marker. The extension does that on land, relaunch, retry and prune
   (`reapEscalationGates`, steps 7b and 7e above); nothing else does.
2. **`Needs you` joins the stop onto a *member*.** A stop whose worktree is gone
   (pruned, or never created) still renders in the run header's stop lines and in
   `belayd_status`, but not in the `Needs you` block, because the block iterates
   fleet members. That is why step 7d's `bd-vj7` is missing from the list.
3. **Withheld sensitive findings open no escalation gate** — see
   [the divergence](#the-divergence-for-withheld-sensitive-findings). Everything the
   review gate does with them is unchanged by bd-279.
4. **The unrecognized-gate warning is once per bead, in-session, and bounded.** A
   session that keeps meeting escalation-blocked beads warns at most once per bead id,
   remembering 32 beads (oldest evicted, `HUMAN_UNRECOGNIZED_GATE_WARNED_MAX_BEADS`), so
   a long daemon session eventually stops warning about new beads. Clearing the wait
   (`clearHumanAnswerWait`) forgets the set. The digest's
   `waiting on: unknown (gate state unrecognized: …)` line is not rate-limited and is
   the surface to trust.
5. **Create-then-record is two writes.** A crash between `bd gate create` and the
   intent write leaves an open gate whose record lost its id; the next drift read
   adopts it (step 5) instead of creating a second one. Two supervisors that both
   created one leave a duplicate, which the next drift pass resolves in favour of the
   recorded (else lowest-id) gate and reports once.
6. **An escalation gate blocks the bead in bd.** That is the intent — the member's
   bead is not offered as ready work until a person answers — but a bead nobody
   answers stays unofferable. `bd ready` drops it and `bd blocked` names the gate:

   ```text
   🚫 Blocked issues (1):

   [P2] bd-zjq: block probe
     Blocked by 1 open dependencies: [bd-mvy]
   ```

   Resolve with an explicit note (`abandon` is a valid answer) rather than deleting
   the gate.
7. **No visual proof.** These are terminal surfaces only; this guide references no
   image, so no proof artifact is deferred.

## Related reading

- `docs/bd-153-userguide.md` — the ownership columns and the `Needs you` block whose
  join bd-279 extends (its tables now describe the stop entry).
- `docs/bd-152-userguide.md` — `belayd_ask_human` and the bd `human` gate it opens.
- `docs/bd-189-userguide.md` — the supervision digest, including the
  `gate state unrecognized` line.
- `docs/fleet.md`, `docs/fleet-status.md` — fleet operations and the status read.
- `src/fleet-escalation.ts` — the module header states the boundary (what escalates
  and what deliberately does not) in one place.
