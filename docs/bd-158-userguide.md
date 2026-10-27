# Fleet ordering as bd gates, and `--accept` as opt-in (bd-158)

Before bd-158 a fleet had one bit to express two different facts. bd derives
"blocked" from the *blocker bead's status*, so the only way a landed member could
release its dependents was to close its bead — and the run did that automatically
(`accept` defaulted to **true**). Closing meant "a human accepted this work" and
"nothing depends on this any more" at the same time, so a landed bead was gone
before anyone could look at it.

bd-158 gives the two facts two objects and two verbs:

- **ordering** — a bd *gate* (`bd gate create --blocks <dependent>`, type `human`,
  structured marker in the title) that the launch creates for every dependency
  edge *between two fleet members*, and that the fleet resolves when the blocker
  **lands**;
- **acceptance** — the member's *bead*, closed only by `--accept`, or by you with
  `wt merge` / `bd close`.

A bare `/fleet` therefore lands members, releases the gates their landing
satisfied, and leaves every bead `in_progress` + `human`.

| Piece | Where |
| --- | --- |
| Gate lifecycle: plan, argv, create/adopt, resolve, by-prefix reap | `src/fleet-ordering-gates.ts` |
| Marker render/parse, human-vs-ordering classification, block-list read | `src/bead-gates.ts` |
| `fleet.json` `orderingGates` schema, `addFleetOrderingGates`, `dropFleetOrderingGates` | `src/fleet-status.ts`, `src/fleet-state.ts` |
| Launch wiring: create before the intent write, rollback, failed-member prune, `accept` parsing | `src/fleet-launch.ts` |
| Tick reap, landing resolve, `fleetLandedTaskIds`, `/fleet` and tool handlers | `extensions/index.ts` |
| Prune reap in a repair | `src/fleet-reconcile.ts` |
| Gate-notice ledger (`run.gateNoticeIds`) | `src/fleet-run.ts` |
| `ordering gates open:` / `waiting on:` rendering | `src/fleet-status.ts` |
| Real-bd proof | `test/fleet-ordering-gate.integration.test.ts` |

## What changed / who this affects

**If you run fleets (`/fleet`, `belayd_fleet_launch`).** Nothing you type has to
change, but the outcome does: a bare `/fleet bd-12 bd-13` now lands both members
and leaves both beads `in_progress` + `human` for you. `accept` is opt-in —
`--accept` (or `"accept": true`) restores the old close-the-bead behaviour, and
`--no-accept` still parses so an older habit is not a parse error. Each
dependency edge between two members now also leaves a bd gate behind, so
`bd gate list <dependent>` and `fleet.json` (`orderingGates`) show the fleet's own
ordering, and `bd show <blocker>` is no longer required to say `closed` for a
dependent to be released.

**If you supervise (`belayd_fleet_status`, `belayd_fleet_reconcile`, the run
loop).** The run's landing step resolves the gates the merge satisfied instead of
closing a bead, and a failed resolve is a retried warning, not a stop. Every tick
reaps orderings whose reason to exist is gone (a member that left, a bead a human
closed, an unrecorded gate left by a crash), and a reconcile pass sweeps the whole
fleet instead of one member. The status view distinguishes the two waits: a
member waiting on another member renders `waiting on: <blocker> (fleet ordering
gate)` and never `awaiting human`, so it never lands in `Needs you`.

**If you accept the work.** You are the only closer now: `wt merge` (or
`bd close`) per bead. Nothing in the fleet removes the `human` label, and nothing
closes a bead unless the launch asked with `--accept`. When you close a bead the
next tick resolves any ordering gate still touching it, so a hand-closed blocker
does not leave an open gate behind.

## How to Verify

Run from the repository root. Every command below was executed in this worktree
with `bd version 1.3.0 (dev)` and `node v24.18.0`; `dist/` was current
(`pnpm build`).

### 1. Gates and the suites that pin this behaviour

```bash
pnpm typecheck && pnpm lint && pnpm build
npx vitest run \
  src/__tests__/fleet-ordering-gates.test.ts src/__tests__/bead-gates.test.ts \
  src/__tests__/fleet-launch.test.ts src/__tests__/fleet-schedule.test.ts \
  src/__tests__/fleet-state.test.ts src/__tests__/fleet-run.test.ts \
  src/__tests__/fleet-accept.test.ts src/__tests__/extension-fleet-p1.test.ts \
  src/__tests__/extension-human-answer.test.ts src/__tests__/fleet-reconcile.test.ts \
  src/__tests__/fleet-beads.test.ts src/__tests__/fleet-bead-engagement.test.ts \
  src/__tests__/fleet-status.test.ts src/__tests__/fleet-merge.test.ts
pnpm vitest run --config vitest.integration.config.ts test/fleet-ordering-gate.integration.test.ts
```

Real output:

```text
 Test Files  14 passed (14)
      Tests  626 passed (626)

 ✓ test/fleet-ordering-gate.integration.test.ts (2 tests) 13176ms
   ✓ fleet ordering gates against a real bd > lands the blocker's gate without touching either bead  7174ms
   ✓ fleet ordering gates against a real bd > tolerates only bd's exact unknown-gate answer, which it captures here  6001ms
```

### 2. The gate as bd sees it (throwaway database)

Never do this in the repo's `.beads/`. `BEADS_ACTOR=` clears the inherited actor so
the gate records who really wrote it.

```bash
D=/tmp/bd158-verify
rm -rf "$D" && mkdir -p "$D" && cd "$D" && git init -q
export BEADS_ACTOR=
bd init >/dev/null 2>&1
BLOCKER=$(bd create "blocker work" -t task --json | jq -r .id)
DEPENDENT=$(bd create "dependent work" -t task --json | jq -r .id)
bd dep add "$DEPENDENT" "$BLOCKER" >/dev/null      # argument 1 depends on argument 2
bd update "$BLOCKER" --status in_progress >/dev/null
MARKER="belayd-fleet-ordering: fleet:default $BLOCKER -> $DEPENDENT"
REASON="$MARKER: $BLOCKER must land (merge into the base branch) before $DEPENDENT — this gate is fleet ordering, not a human question; resolve it with \`bd gate resolve\`"

# Exactly what createFleetOrderingGates runs (the harness appends --json):
bd gate create --blocks "$DEPENDENT" --type=human \
  --title "$MARKER" --reason "$REASON" --json
```

Real output (ids come from the directory name, so yours differ; `priority`,
`owner`, `created_at`, `created_by` and `updated_at` elided):

```json
{
  "id": "bd158-verify-psm",
  "title": "belayd-fleet-ordering: fleet:default bd158-verify-ac4 -\u003e bd158-verify-8rt",
  "description": "Ad-hoc gate blocking bd158-verify-8rt\n\nReason: belayd-fleet-ordering: fleet:default bd158-verify-ac4 -\u003e bd158-verify-8rt: bd158-verify-ac4 must land (merge into the base branch) before bd158-verify-8rt — this gate is fleet ordering, not a human question; resolve it with `bd gate resolve`",
  "status": "open",
  "issue_type": "gate",
  "await_type": "human"
}
```

The argv the harness actually issues, for reference (from
`buildFleetOrderingGateArgv`, with the dependent as `--blocks`):

```text
bd gate create --blocks <blocked> --type=human --title 'belayd-fleet-ordering: fleet:<fleetId> <blocker> -> <blocked>' --reason '<marker>: <blocker> must land …' --json
```

Now the state while the blocker is still `in_progress`:

```bash
bd gate list "$DEPENDENT"                  # human form
bd gate list "$DEPENDENT" --json           # the read the harness makes
bd blocked
bd ready
```

Real output:

```text
⏳ Open Gates (1):

○ bd158-verify-psm - human

To resolve a gate: bd close <gate-id>

🚫 Blocked issues (1):

[P2] bd158-verify-8rt: dependent work
  Blocked by 2 open dependencies: [bd158-verify-psm bd158-verify-ac4]

✨ No ready work found (all issues have blocking dependencies)
```

Resolving (what the landing does) touches the gate only:

```bash
bd gate resolve bd158-verify-psm        # == bd close <gate-id>
bd gate list "$DEPENDENT" --json        # null
bd show bd158-verify-psm --json | jq -r '.[0] | "\(.id) \(.status)"'
bd show "$BLOCKER" --json | jq -r '.[0] | "\(.id) \(.status)"'
bd blocked
```

Real output:

```text
✓ Gate resolved: bd158-verify-psm
null
bd158-verify-psm closed
bd158-verify-ac4 in_progress

🚫 Blocked issues (1):

[P2] bd158-verify-8rt: dependent work
  Blocked by 1 open dependencies: [bd158-verify-ac4]
```

That last block is the point of the design, stated honestly: the **gate** is gone
and the **blocker bead is still `in_progress`**, but a plain `blocks` edge you
added keeps bd's own close-to-unblock rule for *that* edge — bd keeps listing the
dependent until the blocker's bead is closed. Fleet ordering no longer rides on
that rule (see step 3 for the gate-only shape, and
[the trade-off](#the-trade-off-stated-plainly)).

Close the blocker and bd's own rule finishes:

```bash
bd close "$BLOCKER" >/dev/null
bd ready --json | jq -r '[.[].id] | join(",")'
```

```text
bd158-verify-8rt
```

### 3. What the fleet relies on: the gate alone orders the bead

The fleet's advance does not depend on `bd ready` (it uses `landedAt`, step 4).
The property the harness pins with a real `bd` is: with the gate as the *only*
ordering relationship, resolving it returns the dependent to `bd ready` while the
blocker's bead is still `in_progress`. Real output of this script (fresh temp db,
compiled surface):

```bash
node --input-type=module -e '
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const m = await import("./dist/src/index.js");
const env = { ...process.env, BEADS_ACTOR: "" };
const dir = mkdtempSync(join(tmpdir(), "bd158-harness-"));
const bd = async (argv) => (await exec("bd", [...argv], { cwd: dir, env })).stdout;
const runBd = async (argv, o) => ({ stdout: (await exec("bd", [...argv], { cwd: o.cwd, env })).stdout });
await bd(["init"]);
const create = async (t) => JSON.parse(await bd(["create", t, "-t", "task", "--json"])).id;
const blocker = await create("blocker");
const dependent = await create("dependent");
await bd(["update", blocker, "--status", "in_progress"]);
const created = await m.createFleetOrderingGates({
  fleetId: "default", taskIds: [blocker, dependent],
  edges: [{ blocker, blocked: dependent }], cwd: dir, runBd,
});
console.log("recorded:", JSON.stringify(created.gates));
console.log("lookup before:", JSON.stringify(await m.lookupOpenHumanGate({ beadId: dependent, cwd: dir, runBd })));
console.log("blocked before:", (await bd(["blocked"])).includes(dependent),
  "| ready before:", JSON.parse(await bd(["ready", "--json"])).map((b) => b.id).includes(dependent));
console.log("resolve:", JSON.stringify(await m.resolveFleetOrderingGates({ gates: created.gates, cwd: dir, runBd })));
console.log("blocked after:", (await bd(["blocked"])).includes(dependent),
  "| ready after:", JSON.parse(await bd(["ready", "--json"])).map((b) => b.id).includes(dependent));
console.log("blocker status:", JSON.parse(await bd(["show", blocker, "--json"]))[0].status);
console.log("lookup after:", JSON.stringify(await m.lookupOpenHumanGate({ beadId: dependent, cwd: dir, runBd })));
'
```

```text
recorded: [{"blocker":"bd158-harness-q6oPLc-dep","blocked":"bd158-harness-q6oPLc-2qu","gateId":"bd158-harness-q6oPLc-a32"}]
lookup before: {"ok":true,"status":"none","orderingBlocker":"bd158-harness-q6oPLc-dep"}
blocked before: true | ready before: false
resolve: {"ok":true,"resolved":[{"blocker":"bd158-harness-q6oPLc-dep","blocked":"bd158-harness-q6oPLc-2qu","gateId":"bd158-harness-q6oPLc-a32"}],"remaining":[]}
blocked after: false | ready after: true
blocker status: in_progress
lookup after: {"ok":true,"status":"none"}
```

`lookupOpenHumanGate` is the read the bd-152 human-answer poll makes: an ordering
gate is reported as **no human wait** plus `orderingBlocker: <blocker>`, so a
comment can never "answer" it and the member is never shown as awaiting a person.

### 4. `/fleet` end to end (this repository)

Back in this repo (step 2 left you in `/tmp/bd158-verify`: `cd` back). Use beads
that really are dependent, e.g. `bd-12` blocking `bd-13`; the gate ids below are
illustrative (bd mints its own).

```bash
bd dep list bd-13          # or: bd show bd-13 --json | jq '.[0].dependencies'
bd update bd-12 --status in_progress
/fleet bd-12 bd-13         # run to completion, leaving both beads for you
```

What to check, and what you should see:

```bash
jq '.orderingGates' .git/belayd/fleet/default/fleet.json
bd gate list bd-13 --json | jq -r '.[] | "\(.id)\t\(.title)"'
belayd_fleet_status        # the `ordering gates open:` line comes from fleet.json
```

```text
[
  { "blocker": "bd-12", "blocked": "bd-13", "gateId": "bd-155" }
]
bd-155	belayd-fleet-ordering: fleet:default bd-12 -> bd-13
  ordering gates open: bd-12 -> bd-13 (gate bd-155) — resolved when the blocker lands
```

The per-bead view adds the other half (exact line from `formatOwnershipLines`;
`formatBeadOwnership` uses the same text with a single `- `):

```text
  awaiting human: no
  waiting on: bd-12 (fleet ordering gate)
```

When `bd-12` lands, the same two places change without either bead moving:

```bash
jq '.orderingGates, .run.members' .git/belayd/fleet/default/fleet.json
bd gate list bd-13 --json            # null — the gate is resolved
bd show bd-12 --json | jq -r '.[0].status'   # in_progress
bd show bd-13 --json | jq -r '.[0].status'   # in_progress (or active, if already launched)
tail -3 .git/belayd/fleet/default/audit.log
```

```text
null
bd-12	in_progress
bd-13	in_progress
```

`audit.log` is one JSON object per line (`formatAuditEntry`); the landing's gate
resolve is:

```text
{"timestamp":"2026-10-27T15:20:30Z","fleetId":"default","actor":"belayd:supervisor","action":"ordering-gates-resolved","taskIds":["bd-12"],"detail":"1 gate(s): bd-12->bd-13 (bd-155)"}
```

The run's own output line for the landing (the `accepted …` text comes from
`acceptLandedMember`, the rest is the gate line):

```text
Fleet default: accepted bd-12: bead left open (accept disabled); removed worktree <worktree path> and merged branch feat/bd-12
```

**Negative checks — the two things a landing must not do:**

```bash
bd show bd-12 --json | jq -r '.[0] | "\(.id)\t\(.status)\thuman=\((.labels // []) | index("human") != null)"'
bd show bd-13 --json | jq -r '.[0] | "\(.id)\t\(.status)\thuman=\((.labels // []) | index("human") != null)"'
jq -r 'select(.action == "fleet-landed") | .detail' .git/belayd/fleet/default/audit.log   # merged bd-12 into main
```

```text
bd-12	in_progress	human=true
bd-13	in_progress	human=true
```

Both beads stay `in_progress`, both keep the `human` label, and no `bd close` or
`bd label` call is issued by the landing path — pinned by
`extension-fleet-p1` › `fleet ordering gates` › `resolves its ordering gates on
landing and never closes the bead`, which asserts the `bd close`/`bd label` call
list is empty.

Then accept — that is yours:

```bash
wt merge bd-12        # or: bd close bd-12
bd ready              # bd-13 becomes ready once bd-12's bead is closed
```

### 5. Case names worth knowing, by what they prove

| Test | Proves |
| --- | --- |
| `fleet-ordering-gates` › `builds a human-typed gate whose title is the structured marker` | exact argv: `--blocks <blocked> --type=human --title <marker> --reason …` |
| `fleet-ordering-gates` › `keeps only edges whose two ends are members of this launch` | external blockers get no gate |
| `fleet-ordering-gates` › `keeps the marker intact when the prose is long` | `GATE_REASON_PROSE_MAX = 180` never truncates the marker |
| `fleet-ordering-gates` › `keeps a human gate that merely starts with the prefix a human wait` | a bare prefix is **not** ordering (fail-closed) |
| `fleet-ordering-gates` › `keeps a real ordering gate ordering when bd truncated its reason` | the title decides; drift is reported, not misclassified |
| `fleet-ordering-gates` › `adopts the gate bd already has when the record was lost` | crash-window adoption, no duplicate create |
| `fleet-ordering-gates` › `resolves a duplicate gate for the same edge instead of leaving it behind` | one gate per edge |
| `fleet-ordering-gates` › `refuses before creating anything when one new record would pass the bound` | budget refusal happens before any write |
| `fleet-ordering-gates` › `does not read a database error as an already-resolved gate` | only bd's exact `gate not found: <id>` counts as resolved |
| `fleet-ordering-gates` › `resolves only the edges a scoped caller created` | `reapFleetOrderingGatesByPrefix({scope:"created-edges"})` |
| `fleet-launch` › `runFleetLaunch ordering gates` › `rolls back only the gates its own attempt created, named with their dependents` | a refused launch never resolves pre-existing ordering |
| `fleet-launch` › `runFleetLaunch ordering gates` › `gates an advance-added member against an already-live member` | the set is all members, not this wave |
| `fleet-state` › `addFleetOrderingGates` › `refuses an adopted gate that would pass the intent's gate bound` | adoption is refused per gate, never truncated |
| `fleet-state` › `fleet.json` writes › `refuses to write an intent record its own reader would reject` | `fleetIntentWriteRefusal` backstop |
| `fleet-run` › `gate notices` › `shows a gate's warning once and remembers that it did` | `planGateNotices` + `run.gateNoticeIds` |
| `fleet-run` › `gate notices` › `stays quiet instead of growing past its bound` | `FLEET_RUN_GATE_NOTICE_IDS_MAX = 256` |
| `extension-fleet-p1` › `fleet ordering gates` › `reaps a gate whose bead a human closed` | a `bd close` by a human releases the gate |
| `extension-fleet-p1` › `fleet ordering gates` › `reaps an unrecorded gate whose blocker is gone (crash-window sweep)` | the rotating sweep resolves an unrecorded gate |
| `extension-fleet-p1` › `fleet ordering gates` › `adopts an unrecorded gate whose blocker is still working instead of releasing it` | never releases a dependent early |
| `extension-fleet-p1` › `fleet ordering gates` › `reaps nothing when bd answers for only some of the gated beads` | an ambiguous bead answer reaps nothing |
| `extension-fleet-p1` › `fleet ordering gates` › `names the adopted gate ids when the intent write loses its race twice` | CAS-lost adoption names the gate ids to resolve by hand |
| `extension-fleet-p1` › `fleet ordering gates` › `warns once per drifted gate across consecutive ticks` | drift warned once per run |
| `extension-fleet-p1` › `fleet ordering gates` › `records the landing when its ordering gate cannot be resolved, then retries without re-merging` | retry, never a re-merge or a stop |
| `fleet-reconcile` › `runFleetReconcile: supervision` › `resolves and forgets a pruned member's ordering gates` | prune reaps on both sides |
| `fleet-bead-engagement` › `reads a fleet ordering gate as waiting on its blocker, never as a human wait` | `orderingBlocker`, `awaitingHuman: false` |
| `fleet-beads` › `fails the read when the payload shape is unrecognized` | "unreadable" ≠ "no beads" |

### 6. Failure paths without a live fleet

The pure halves are exported, so the refusals and ledgers can be checked with
`node` alone (real output):

```bash
node --input-type=module -e '
const m = await import("./dist/src/index.js");
const f = await import("./dist/src/fleet-status.js");
console.log(m.orderingGateBudgetRefusal(257));
const intent = m.createFleetIntent({ fleetId: "default", taskIds: ["bd-12"], now: 1, maxConcurrent: 3 });
const full = { ...intent, orderingGates: Array.from({ length: 256 }, (_, i) => ({ blocker: `bd-${i}`, blocked: `bd-${i}-x`, gateId: `g-${i}` })) };
console.log(JSON.stringify(m.addFleetOrderingGates(full, [{ blocker: "bd-9", blocked: "bd-9-y", gateId: "g-new" }], 3).refused, null, 1));
console.log(f.fleetIntentWriteRefusal({ ...full, orderingGates: [...full.orderingGates, { blocker: "bd-1", blocked: "bd-2", gateId: "g-x" }] }));
console.log(JSON.stringify(m.planGateNotices({ notices: [{ gateId: "g1", message: "m1" }] })));
console.log(JSON.stringify(m.planGateNotices({ existing: ["g1"], notices: [{ gateId: "g1", message: "m1" }] })));
console.log(JSON.stringify(m.parseFleetCommandArgs("bd-12 bd-13")));
console.log(JSON.stringify(m.parseFleetCommandArgs("bd-12 bd-13 --accept")));
console.log(JSON.stringify(m.parseFleetCommandArgs("bd-12 bd-13 --no-accept")));
'
```

```text
this fleet would record 257 ordering gates, over the 256-gate bound of `fleet.json`; nothing was written (resolve or remove a fleet's gates before adding more members)
[
  {
    "gate": { "blocker": "bd-9", "blocked": "bd-9-y", "gateId": "g-new" },
    "error": "`fleet.json` already records 256 ordering gates (its bound); this gate stays open in bd and is not recorded, so a human must resolve it or prune the fleet"
  }
]
invalid fleet intent (orderingGates: Too big: expected array to have <=256 items)
{"fresh":[{"gateId":"g1","message":"m1"}],"noticeIds":["g1"]}
{"fresh":[],"noticeIds":["g1"]}
{"ok":true,"args":{"taskIds":["bd-12","bd-13"]}}
{"ok":true,"args":{"taskIds":["bd-12","bd-13"],"accept":true}}
{"ok":true,"args":{"taskIds":["bd-12","bd-13"],"accept":false}}
```

(`fleetIntentWriteRefusal` lives in `src/fleet-status.ts`; it is what
`writeFleetIntent` calls, and it is not re-exported from the package barrel.)

### 7. Cleanup

```bash
rm -rf /tmp/bd158-verify /tmp/bd158-harness-* /tmp/bd158-guide-* /tmp/bd158-after-*
```

## How to Use

### Flags

```text
Usage: /fleet bd-12 bd-15 [bd-19] [--fleet <id>] [--concurrency <n>] [--manual] [--accept]
  task ids: beads to run as members, each in its own worktree (1 or more)
  --fleet <id>: fleet directory name (default: default)
  --concurrency <n>: concurrent orchestrators, capped at 3
  --manual: launch only; land and advance on explicit calls (no run loop)
  --accept: also close each landed bead (its merged worktree is removed on landing
            either way); default: land only, leaving every bead in_progress + human
            for you to accept
```

| Flag | Effect |
| --- | --- |
| (none) | `accept: false`. Lands each member, resolves the gates its landing satisfied, leaves every bead `in_progress` + `human` |
| `--accept` | `accept: true`: also `bd close`s each landed bead (the close rides on the landing, audited as `fleet-landed`; a failed close stops the member as `accept-failed` and keeps the merge) |
| `--no-accept` | `accept: false` — the same as the default, kept so an older habit parses |
| `--manual` | No run record is written, so `accept` has no effect: nothing lands or advances unless you call `belayd_fleet_merge` / `belayd_fleet_advance` |
| `--concurrency <n>` | Concurrent orchestrators, capped at `FLEET_MAX_CONCURRENT_ORCHESTRATORS = 3` |

`accept` is the **only** thing the flag changes on the bead side: the worktree
removal on a landing is not conditional on it (`removeWorktree:
worktreePath !== undefined` in `acceptLandedMemberOnDisk`), so a landing reports
`removed worktree … and merged branch …` with or without `--accept`, and
`bead left open (accept disabled)` versus `bead closed`.

### Tool parameters

`belayd_fleet_launch` — unchanged names, changed default:

```json
{
  "tasks": ["bd-12", "bd-13"],
  "fleetId": "default",
  "concurrency": 3,
  "untilComplete": true,
  "accept": false
}
```

- `accept` — read as `params.accept === true`, and only when `untilComplete` is
  not `false`; omitted or `false` leaves every landed bead for you.
- `untilComplete: false` — the explicit surface (`--manual` equivalent), no run
  record, so `accept` is not consulted.

Other tools that now touch ordering gates:

| Tool | What it does with gates |
| --- | --- |
| `belayd_fleet_merge` (`drain`) | after a successful merge, resolves every recorded gate touching that member (`releaseGatesAfterMerge`) |
| `belayd_fleet_advance` | runs through the same launch engine, so any new member→member edge gets its gate then (the member set is every member, including ones that started in an earlier wave) |
| `belayd_fleet_status` | renders `ordering gates open: …` and `waiting on: <blocker> (fleet ordering gate)`; writes nothing |
| `belayd_fleet_reconcile` | a full sweep of every member (`sweep: "all"`, concurrency 3) plus `extraBeads` for members it just pruned; reports every finding fresh |

### What a run's output looks like

```text
Fleet default: running until every member is landed. Observe with belayd_fleet_status; pause with belayd_fleet_pause.
Fleet default: accepted bd-12: bead left open (accept disabled); removed worktree <worktree path> and merged branch feat/bd-12
Fleet default: bd-13 launched
Fleet default: accepted bd-13: bead left open (accept disabled); removed worktree <worktree path> and merged branch feat/bd-13
```

With `--accept` the middle of those lines reads
`accepted bd-12: bead closed; removed worktree …`. A gate that bd refused to
resolve adds one line after the landing (the landing itself still counts):

```text
Fleet default: landed bd-12 but could not resolve its ordering gate(s): could not resolve the ordering gate(s) for bd-12: bd: database is locked (1 still recorded) — the tick reaper retries; `bd gate list` shows them
```

### The recommended human workflow

1. Launch without flags: `/fleet bd-12 bd-13`.
2. Watch with `belayd_fleet_status` (`ordering gates open: …` is the pending
   ordering, `run: until-complete — …` the loop), and with `bd blocked` /
   `bd gate list <bead>` when you want bd's own view.
3. When the run says `members: 0` and `run: … complete`, review the landed work on
   the base branch.
4. Accept each bead yourself: `wt merge bd-12` or `bd close bd-12`. Closing the
   blocker is also what makes bd's `bd ready` show the dependent, if it has a
   plain `blocks` edge.
5. Anything left in `ordering gates open:` after the run finished means a resolve
   failed; `bd gate resolve <gate-id>` and the record disappears on the next tick
   (or on `belayd_fleet_reconcile`).

### The trade-off, stated plainly

Fleet ordering lives in **bd gates + `fleet.json`**, not in `bd dep list` /
`bd graph`:

- `bd gate list <dependent>` and `bd show <gate-id>` show the fleet's ordering;
  `bd dep list` shows only the edges you created yourself.
- A plain `blocks` edge you keep keeps **bd's** close-to-unblock rule for that
  edge: `bd ready` keeps excluding the dependent until the blocker's bead is
  closed (verified in step 2). The fleet does not wait for that — it advances on
  `landedAt` (`fleetLandedTaskIds` filters the dependency edges of members this
  fleet landed) — but bd's own views do.
- A consequence worth knowing: if you later launch *only* the dependent, its
  remaining plain `blocks` edge to a non-member surfaces as
  `deferred bd-13 (external-blocker)` (`bd-13 cannot be planned: blocked by a bead
  outside this fleet`) until that bead is closed. Fleet-owned ordering, by
  contrast, is resolved at landing and never leaks into a later launch.

## Failure modes

| Situation | What happens | What you see / do |
| --- | --- | --- |
| `bd` missing, slow, or non-JSON while planning gates | The launch is refused before the intent write (reading the dependent's gates happens first) | `Fleet launch refused; nothing was launched. Could not create the bd ordering gates this fleet needs: could not read the ordering gates of <bead>: <error>` |
| `bd gate create` exits 0 but its output has no usable gate id (bd payload drift) | Launch refused; guessing an id would either resolve the work bead or orphan the gate | ``bd gate create for bd-12 -> bd-13 exited 0 but reported no usable gate id (output: <200 chars>). The launch was refused and nothing was left open: check `bd version` (this harness expects bd 1.3.0's `--json` payload or the `✓ Created gate bd-N` text form), then create the gate by hand with: bd gate create --blocks bd-13 --type=human --title '<marker>' --reason '<reason>'`` |
| `bd gate create` fails outright | Launch refused; the gates it *did* create are resolved; adopted ones stay open and are named | ``Fleet launch refused; nothing was launched. Could not create the bd ordering gates this fleet needs: <bd error> (resolved the 1 gate(s) it created; 1 pre-existing ordering gate(s) left open, so bd-14 (gate bd-902) stays bd-blocked — inspect with `bd gate list bd-14`)`` |
| `bd gate resolve` fails transiently at a landing | The merge cannot be undone, so `landedAt` is recorded, the member is pruned, the record stays, and the next tick retries the resolve only (the queue entry is `merged`, so no second merge) | ``Fleet default: landed bd-12 but could not resolve its ordering gate(s): … — the tick reaper retries; `bd gate list` shows them``, then `ordering gates open: bd-12 -> bd-13 (gate bd-155) — resolved when the blocker lands` in `belayd_fleet_status`. Audit: `ordering-gate-unresolved` |
| The gate id bd has never heard of (`gate not found: <id>`) | Treated as resolved (it is idempotent in bd 1.3.0 too: a second resolve exits 0) | nothing; the record is dropped |
| Any other bd error during a tick resolve (`database is locked`, …) | The record is kept so the next tick retries; nothing is claimed | `Fleet default: could not resolve orphan ordering gate(s): <error>` (or `closed-bead`), every tick until it succeeds |
| The intent write would record more than 256 gates | Refused, **never truncated**: a cut record is an open gate nothing can resolve | ``this fleet would record 257 ordering gates, over the 256-gate bound of `fleet.json`; nothing was written (resolve or remove a fleet's gates before adding more members)`` |
| A sweep wants to adopt a gate past that bound | That gate is refused individually — it stays open in bd (resolving it would release a dependent early) and a notice names it | `Fleet default: ordering gate bd-901 (bd-12 -> bd-13) is open in bd but could not be recorded: fleet.json already records 256 ordering gates (its bound); this gate stays open in bd and is not recorded, so a human must resolve it or prune the fleet` |
| A write path slips an invalid record past both checks | `writeFleetIntent` validates against the reader's own schema and refuses the replace | `refusing to write <git-common-dir>/belayd/fleet/<id>/fleet.json: invalid fleet intent (orderingGates: Too big: expected array to have <=256 items)` |
| The intent loses the compare-and-replace race twice | The records are not written, so the adopted gates stay open with no record; they are named for you | `Fleet default: the fleet intent changed twice while updating it (unrecorded ordering gates: bd-12->bd-13 (gate bd-900), …)` |
| bd re-folded or truncated a gate `--reason` | The **title** decides: still an ordering gate (never a human wait); the drift is warned once per gate per run (`run.gateNoticeIds`, cap `FLEET_RUN_GATE_NOTICE_IDS_MAX = 256`) | `gate bd-155 carries the fleet ordering marker in its title but not in its reason (bd truncated or re-folded the reason); classified from the title` |
| bd answers `bd show` for only some of the gated beads | Nothing is reaped: a missing record is not evidence a bead is gone | `Fleet default: bd returned no record for 1 of 2 bead(s) behind its ordering gates (bd-13); not reaping on an ambiguous answer` |
| `bd show` answers a shape this version cannot read | The read is a **failure**, not an empty bead set (otherwise every member's bead would look gone) | ``Fleet default: could not read the beads behind its ordering gates: unrecognized `bd show` payload (bd changed its JSON shape); refusing to read this as an empty bead set`` |
| A tick's gate read fails for one bead | That bead is skipped this rotation, everything else proceeds | `Fleet default: could not read the ordering gates of bd-13: <error>` |

Two negatives worth stating: a **failed gate resolve never stops a run** (it is
not in `FLEET_RUN_STOP_REASONS`; the merge already happened), and a resolve
**never touches the work bead** — `bd gate resolve` closes the gate bead only.

## API reference

Everything below is exported from the package barrel (`belayd-agent-harness`)
except where noted. All bd runners are injected, so nothing throws and no test
spawns a process.

### Planning and argv (pure)

```typescript
import {
  buildFleetOrderingGateArgv,
  fleetOrderingGateReason,
  fleetOrderingGateTitle,
  planFleetOrderingGates,
} from "belayd-agent-harness";

// Only edges whose two ends are members; deduped; ordered by the dependent's
// position in taskIds (never by gate id, so two launches agree).
planFleetOrderingGates({
  taskIds: ["bd-13", "bd-12", "bd-14"],
  edges: [
    { blocker: "bd-14", blocked: "bd-13" },
    { blocker: "bd-12", blocked: "bd-14" },
    { blocker: "bd-12", blocked: "bd-14" },
  ],
});
// [ { blocker: "bd-14", blocked: "bd-13" }, { blocker: "bd-12", blocked: "bd-14" } ]

buildFleetOrderingGateArgv({ fleetId: "default", blocker: "bd-12", blocked: "bd-13" });
// ["gate","create","--blocks","bd-13","--type=human",
//  "--title","belayd-fleet-ordering: fleet:default bd-12 -> bd-13",
//  "--reason","belayd-fleet-ordering: fleet:default bd-12 -> bd-13: bd-12 must land (merge into the base branch) before bd-13 — this gate is fleet ordering, not a human question; resolve it with `bd gate resolve`"]
// (createFleetOrderingGates appends "--json" when it runs this.)

fleetOrderingGateTitle({ fleetId: "default", blocker: "bd-12", blocked: "bd-13" });
// "belayd-fleet-ordering: fleet:default bd-12 -> bd-13"   (the marker, alone)
fleetOrderingGateReason({ fleetId: "default", blocker: "bd-12", blocked: "bd-13" });
// marker + ": <blocker> must land … — this gate is fleet ordering, not a human
// question; resolve it with `bd gate resolve`", with the prose bounded to 180 chars
```

### Marker render / parse / classify

```typescript
import {
  FLEET_ORDERING_GATE_PREFIX,
  fleetOrderingGateDriftWarning,
  fleetOrderingGateMarkerOf,
  isFleetOrderingGateRecord,
  parseFleetOrderingGateMarkerLine,
  renderFleetOrderingGateMarker,
} from "belayd-agent-harness";

FLEET_ORDERING_GATE_PREFIX; // "belayd-fleet-ordering:"
renderFleetOrderingGateMarker({ fleetId: "default", blocker: "bd-12", blocked: "bd-13" });
// "belayd-fleet-ordering: fleet:default bd-12 -> bd-13"

parseFleetOrderingGateMarkerLine("belayd-fleet-ordering: fleet:default bd-12 -> bd-13");
// { fleetId: "default", blocker: "bd-12", blocked: "bd-13" }
parseFleetOrderingGateMarkerLine("belayd-fleet-ordering: fleet:default bd-12 -> bd-13: bd-12 must land");
// { fleetId: "default", blocker: "bd-12", blocked: "bd-13" }   (prose after the ids is fine)
parseFleetOrderingGateMarkerLine("belayd-fleet-ordering: why is this blocked?"); // undefined
parseFleetOrderingGateMarkerLine("belayd-fleet-ordering: fleet:default bd-12 -> bd-12"); // undefined (self-edge)

// The title decides. A missing/truncated reason keeps it an ordering gate; a
// reason that parses to a *different* edge fails closed (undefined ⇒ human gate).
fleetOrderingGateMarkerOf({ id: "bd-155", title: renderFleetOrderingGateMarker({…}), description: "…" });
// { fleetId, blocker, blocked } | undefined
isFleetOrderingGateRecord({ title: "belayd-fleet-ordering: fleet:default bd-12 -> bd-13" }); // true
fleetOrderingGateDriftWarning({
  id: "bd-155",
  title: "belayd-fleet-ordering: fleet:default bd-12 -> bd-13",
  description: "Ad-hoc gate\n\nReason: belayd-fleet-ordering: fleet:default bd-12 ->",
});
// "gate bd-155 carries the fleet ordering marker in its title but not in its
//  reason (bd truncated or re-folded the reason); classified from the title"
```

### Reading bd

```typescript
import {
  lookupOpenHumanGate,
  parseOpenFleetOrderingGates,
  parseOpenOrderingGateBlocker,
  readOpenFleetOrderingGates,
} from "belayd-agent-harness";

// The bd-152 read: an ordering gate is "no human wait" + the member it waits on.
await lookupOpenHumanGate({ beadId: "bd-13", cwd: "/repo", runBd });
// { ok: true, status: "open", gate: { gateId, createdAt } }   a real human gate
// { ok: true, status: "none", orderingBlocker: "bd-12" }      an ordering gate
// { ok: true, status: "none" }                                nothing open
// { ok: true, status: "unrecognized" } | { ok: false, error }  never treated as resolved

parseOpenOrderingGateBlocker(rawGateListJson, "bd-13"); // "bd-12" | undefined
parseOpenFleetOrderingGates(rawGateListJson);          // [{ gateId, fleetId, blocker, blocked }]
readOpenFleetOrderingGates(rawGateListJson);           // { gates, drifts }
```

`listFleetOrderingGatesForBead({ beadId, cwd, runBd })` is the driver:
`bd gate list <bead> --json` (read-only argv enforced) →
`{ ok: true, gates, drifts } | { ok: false, error }`.

### Creating gates (bd is the truth)

```typescript
import { createFleetOrderingGates } from "belayd-agent-harness";

const created = await createFleetOrderingGates({
  fleetId: "default",
  taskIds: ["bd-12", "bd-13"],            // every member, incl. earlier waves
  edges: [{ blocker: "bd-12", blocked: "bd-13" }],
  existing: [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-155" }], // optional
  cwd: "/repo",
  runBd,                                   // (argv, {cwd,stdin,timeoutInMs,maxBufferInBytes}) => {stdout}
});
// { ok: true,
//   gates:   [{ blocker, blocked, gateId }],   // what the caller must record
//   created: [{ … }],                           // only what this call minted (rollback scope)
//   adopted: [{ … }],                           // already in bd, record restored
//   warnings: [] }
// | { ok: false, error, created, adopted, warnings }
```

Behaviour that matters:

- one `bd gate list <blocked> --json` per dependent bead (cached per launch) so a
  crash-lost record is **adopted**, not duplicated; extra gates for the same edge
  are resolved as duplicates;
- another fleet's gate for the same beads is ignored;
- the record budget is checked on the **post-adoption** set
  (`orderingGateBudgetRefusal(count)`), before anything is created;
- a bd read failure refuses the whole launch instead of guessing.

### Resolving gates

```typescript
import {
  resolveFleetOrderingGates,
  resolveFleetOrderingGatesForBead,
} from "belayd-agent-harness";

await resolveFleetOrderingGates({ gates, cwd: "/repo", runBd, blocker: "bd-12" });
// resolves only gates whose blocker is bd-12; everything else is `remaining`
await resolveFleetOrderingGatesForBead({ gates, beadId: "bd-12", cwd: "/repo", runBd });
// both sides: the blocker landing releases dependents, the dependent closing ends the wait
// → { ok: true, resolved, remaining } | { ok: false, error, resolved, remaining }
```

Every selected gate is attempted even after one fails (one stale id must not stall
the rest), `remaining` keeps the failed **and** the untouched gates, and only bd's
exact `gate not found: <id>` is read as already resolved.

### Reaping by prefix (the crash window)

```typescript
import { reapFleetOrderingGatesByPrefix } from "belayd-agent-harness";

// A launch rollback owns only the edges it created.
await reapFleetOrderingGatesByPrefix({
  fleetId: "default",
  beadIds: ["bd-13"],
  cwd: "/repo",
  runBd,
  scope: "created-edges",
  edges: [{ blocker: "bd-12", blocked: "bd-13" }],
});

// A member (or bead) that left the fleet has no live ordering left at all.
await reapFleetOrderingGatesByPrefix({
  fleetId: "default",
  beadIds: ["bd-13"],
  cwd: "/repo",
  runBd,
  scope: "whole-bead",
});
// → { ok: true, resolved, warnings } | { ok: false, error, resolved, warnings }
```

Only gates whose marker names **this** fleet are touched; the `scope`
discriminator is required (a loose form would let a rollback destroy live
ordering).

### Recording / forgetting records

```typescript
import {
  FLEET_INTENT_ORDERING_GATES_MAX,
  addFleetOrderingGates,
  dropFleetOrderingGates,
} from "belayd-agent-harness";

FLEET_INTENT_ORDERING_GATES_MAX; // 256

// Adopt gates bd has but fleet.json does not (crash-window recovery).
const added = addFleetOrderingGates(intent, [{ blocker: "bd-12", blocked: "bd-13", gateId: "bd-155" }], now);
// { ok: true,  intent } | { ok: false, intent, refused: [{ gate, error }] }

// Forget what bd confirmed resolved — by GATE ID, never by member id.
dropFleetOrderingGates(intent, ["bd-155"], now);
// the same intent with that record removed (field deleted when the list empties)
```

`addFleetOrderingGates` dedupes by edge **and** by gate id, refuses only the gates
past the bound (recording the rest), and returns the refused ones with the reason.

### The `fleet.json` write backstop

```typescript
// Internal module export (src/fleet-status.ts); not on the package barrel.
import { fleetIntentWriteRefusal } from "../fleet-status.js";

fleetIntentWriteRefusal({ ...intent, orderingGates: overBoundList });
// "invalid fleet intent (orderingGates: Too big: expected array to have <=256 items)"
fleetIntentWriteRefusal(validIntent); // undefined
```

`writeFleetIntent` calls it before the bytes land, so a record its own reader would
reject can never brick the intent. The schema field is
`orderingGates: [{ blocker, blocked, gateId }]`, each id `1…128` chars, array
`≤ 256`.

### Per-gate warnings, shown once

```typescript
import {
  FLEET_RUN_GATE_NOTICE_IDS_MAX,
  planGateNotices,
  recordFleetGateNotices,
} from "belayd-agent-harness";

FLEET_RUN_GATE_NOTICE_IDS_MAX; // 256

planGateNotices({ notices: [{ gateId: "g1", message: "m1" }] });
// { fresh: [{ gateId: "g1", message: "m1" }], noticeIds: ["g1"] }
planGateNotices({ existing: ["g1"], notices: [{ gateId: "g1", message: "m1" }] });
// { fresh: [], noticeIds: ["g1"] }                      (already reported this run)
planGateNotices({ existing: ["g1"], notices: [], releasedGateIds: ["g1"] });
// { fresh: [], noticeIds: [] }                           (bd confirmed it resolved)

recordFleetGateNotices(run, plan.noticeIds); // the run with `gateNoticeIds` set, or dropped when empty
```

### `/fleet` argument parsing

```typescript
import { fleetUsageText, parseFleetCommandArgs } from "belayd-agent-harness";

parseFleetCommandArgs("bd-12 bd-13");              // { ok: true, args: { taskIds: ["bd-12","bd-13"] } }
parseFleetCommandArgs("bd-12 bd-13 --accept");     // { ok: true, args: { …, accept: true } }
parseFleetCommandArgs("bd-12 bd-13 --no-accept");  // { ok: true, args: { …, accept: false } }
parseFleetCommandArgs("bd-12 --manual --accept");  // { ok: true, args: { …, untilComplete: false, accept: true } }
// `accept` is `undefined` unless a flag said it; the handlers read it as `=== true`.
// `--manual` wins: no run record is written, so `accept` is never consulted.
```

## Does it write?

| Path | bd writes | files |
| --- | --- | --- |
| `planFleetOrderingGates`, marker render/parse, `orderingGateBudgetRefusal`, `planGateNotices`, `dropFleetOrderingGates` | none | none (pure) |
| Launch (`createLaunchOrderingGates` → `createFleetOrderingGates`) | `bd gate create … --json` per new edge; `bd gate resolve <id>` for a duplicate of an adopted edge; reads `bd gate list <blocked> --json` | `fleet.json` `orderingGates` (in the same CAS intent write as the members), `audit.log` `ordering-gates` |
| Refused launch | resolves **only** the gates this attempt created (+ `reapByPrefix` over their edges) | nothing written; the refusal text names whatever stayed open |
| Landing (`resolveLandedOrderingGates` → `releaseOrderingGatesForBead`) | `bd gate resolve <gate-id>` for each recorded gate touching the member | `fleet.json` `orderingGates` (records dropped by gate id), `run.members[].landedAt`, `audit.log` `fleet-landed` + `ordering-gates-resolved` (or `ordering-gate-unresolved`); the merge queue entry `merged` |
| `--accept` (acceptance) | `bd update --if-assignee <holder> --assignee "" -- <bead>` (clear the driver), `bd close <bead>`, then `bd gate resolve` for any leftover gate touching that bead | the bead's status, `audit.log` (`fleet-landed` on the landing; `accept-failed` if the close fails) |
| `belayd_fleet_merge` (`drain`) | `bd gate resolve <gate-id>` for the gates touching the merged member (`releaseGatesAfterMerge`); never a bead write | `merge-queue.json`, the base branch; `fleet.json` only if a gate record was dropped |
| Run tick (`reapOrderingGates`) | `bd gate list <one member bead> --json` (rotation), one batched `bd show` for the gated beads, `bd gate resolve` for orphans / closed beads / released unrecorded gates | `fleet.json` (`orderingGates`, `run.gateNoticeIds`), `audit.log` `ordering-gates-adopted` |
| `belayd_fleet_reconcile` | the same sweeps for **every** member (`sweep: "all"`) plus the members it pruned (`extraBeads`), `bd gate resolve` for pruned members' gates | `fleet.json` (`taskIds`, `orderingGates`), `audit.log` `member-pruned` |
| `belayd_fleet_status` / `belayd_status` | reads only: `bd show <ids> --json`, `bd comments <id> --json`, `bd gate list <bead> --json` | **nothing** — the `ordering gates open:` line comes from `fleet.json`, the `waiting on:` line from the gate read |

Nothing in the ordering path ever writes a bead's status, labels, or notes.
`bd gate resolve` closes the *gate* bead; the work bead is untouched (step 2 shows
it still `in_progress`, step 3 shows it byte-for-byte the same after the resolve).

## Where the tests live

| Layer | Path |
| --- | --- |
| Gate lifecycle, marker classification, create/adopt/resolve/reap, budgets | `src/__tests__/fleet-ordering-gates.test.ts` (39 tests) |
| End-to-end through the extension (launch, landing, reaping, advances, notices) | `src/__tests__/extension-fleet-p1.test.ts` (`describe("fleet ordering gates")`, file: 87 tests) |
| Launch engine: seam input, rollback scope, failed-member prune | `src/__tests__/fleet-launch.test.ts` (`describe("runFleetLaunch ordering gates")`, file: 58 tests) |
| `fleet.json` records and the write backstop | `src/__tests__/fleet-state.test.ts` (65 tests) |
| Notice ledger | `src/__tests__/fleet-run.test.ts` (`describe("gate notices")`, file: 72 tests) |
| Status rendering | `src/__tests__/fleet-status.test.ts` (111 tests) |
| Prune reap in a repair | `src/__tests__/fleet-reconcile.test.ts` (36 tests) |
| `waiting on:` vs `awaiting human:` | `src/__tests__/fleet-bead-engagement.test.ts` (23 tests) |
| `bd show` payload strictness | `src/__tests__/fleet-beads.test.ts` (10 tests) |
| `accept` disabled leaves the bead | `src/__tests__/fleet-accept.test.ts` (9 tests) |
| Human wait is not an ordering gate | `src/__tests__/bead-gates.test.ts`, `src/__tests__/extension-human-answer.test.ts` |
| **Real `bd`** (skips when `bd` is absent) | `test/fleet-ordering-gate.integration.test.ts` (2 tests) |

The four acceptance bullets and the tests that prove them:

**(a) A launch with interdependent members leaves both beads open, and both land
and advance through gates.**
`extension-fleet-p1` › `fleet ordering gates` ›
`lands a blocker, then advances and lands its dependent, closing neither bead`
(the full blocker-land → dependent-launch → dependent-land walk, asserting no
`bd close`/`bd label` at any point) ·
`advances a dependent whose blocker landed, though bd still reports the edge and
the bead open` ·
`keeps that dependent deferred as a dependency while its blocker has not landed`
(the negative twin) ·
`gates an internal edge once and leaves external blockers to bd` ·
`fleet-launch` › `runFleetLaunch ordering gates` ›
`gates an advance-added member against an already-live member`.

**(b) `/fleet` without flags never closes a bead.**
`extension-fleet-p1` › `fleet run mode` ›
`records a run for the members it launched and starts the loop` (bare `/fleet` ⇒
`{ mode: "until-complete", accept: false }`) ·
`leaves beads for the human with --no-accept` · `accepts landed beads only when
--accept asked for it` ·
`fleet ordering gates` › `resolves its ordering gates on landing and never closes
the bead` ·
`fleet-accept` › `acceptLandedMember` › `leaves the bead alone when acceptance is
disabled (the fleet default)`.

**(c) With gate-only ordering, `bd blocked` keeps naming the dependent while the
blocker is `in_progress`, and the ordering gate never blocks after the landing.**
`test/fleet-ordering-gate.integration.test.ts` ›
`lands the blocker's gate without touching either bead` — real `bd`:
`bd blocked` contains the dependent and `bd ready` excludes it while the blocker
is `in_progress`; after `resolveFleetOrderingGates`, `bd blocked` excludes it,
`bd ready` includes it, and `bd show <blocker>` is still `in_progress`. (With a
plain `blocks` edge bd keeps naming the dependent — that edge's close-to-unblock
rule is bd's, as step 2 shows.) · `fleet-bead-engagement` ›
`reads a fleet ordering gate as waiting on its blocker, never as a human wait`.

**(d) Orphan gates are resolved, not left open, after the work bead closes or the
member is removed.**
`extension-fleet-p1` › `fleet ordering gates` › `reaps a gate whose bead a human
closed` · `reaps a gate whose member was removed` · `reaps one dependent of a
shared blocker without forgetting the other's gate` · `reaps an unrecorded gate
whose blocker is gone (crash-window sweep)` ·
`fleet-reconcile` › `runFleetReconcile: supervision` › `resolves and forgets a
pruned member's ordering gates` · `keeps a pruned member's gate recorded when bd
does not confirm the resolve` ·
`fleet-ordering-gates` › `resolveFleetOrderingGates` › `matches either side of a
bead, so a closed bead reaps its gates`.
