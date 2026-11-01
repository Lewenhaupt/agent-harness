# Fleet ordering gates as native `bead` gates (bd-176)

Fleet ordering gates are now created as bd-native `bead` gates:

```text
bd gate create --blocks <blocked> --type=bead --await-id <blocker> ...
```

instead of `--type=human`. A mechanical "wait for the other member to land" is no
longer a human wait: it stays out of human/needs-you views, and
`bd gate list <dependent>` renders it as `bead <blocker>` rather than `human`.
The structured marker title/reason is unchanged, so classification, adoption and
reaping behave exactly as before. A plain human question from
`belayd_ask_human` is still created with `--type=human`.

## How to Verify

Run from the repository root.

### 1. Automated suites

```bash
pnpm test
pnpm test:integration
pnpm typecheck && pnpm lint && pnpm build

# The tests that pin this feature specifically
pnpm vitest run \
  src/__tests__/bead-gates.test.ts \
  src/__tests__/fleet-ordering-gates.test.ts \
  src/__tests__/fleet-bead-engagement.test.ts \
  src/__tests__/fleet-status.test.ts
pnpm vitest run --config vitest.integration.config.ts \
  test/fleet-ordering-gate.integration.test.ts \
  test/human-answer.integration.test.ts
```

Observed on this worktree (`bd version 1.3.0 (dev)`):

```text
pnpm test          -> 127 files, 3302 tests passed
pnpm test:integration -> 14 files, 108 tests passed

 ✓ test/fleet-ordering-gate.integration.test.ts (4 tests) 42229ms
   ✓ fleet ordering gates against a real bd > lands the blocker's gate without touching either bead  10272ms
   ✓ fleet ordering gates against a real bd > creates opposite member edges without a bd cycle, each resolving independently  8743ms
   ✓ fleet ordering gates against a real bd > still reads a plain human gate as a human wait  6873ms
   ✓ fleet ordering gates against a real bd > tolerates only bd's exact unknown-gate answer, which it captures here  16340ms
   Test Files  1 passed (1)
        Tests  4 passed (4)
```

### 2. Prove the gate records `await_type: "bead"` in a throwaway database

Never do this in the repo's `.beads/`. `BEADS_ACTOR=` clears the inherited actor.

```bash
D=$(mktemp -d /tmp/bd176-verify.XXXXXX)
cd "$D"
git init -q
export BEADS_ACTOR=
bd init >/dev/null 2>&1

BLOCKER=$(bd create "blocker work" -t task --json | jq -r .id)
DEPENDENT=$(bd create "dependent work" -t task --json | jq -r .id)
MARKER="belayd-fleet-ordering: fleet:default $BLOCKER -> $DEPENDENT"
REASON="$MARKER: $BLOCKER must land (merge into the base branch) before $DEPENDENT — fleet ordering, not a human question; the fleet resolves it on landing, else \`bd gate resolve <id>\`"

# Exactly what buildFleetOrderingGateArgv emits (the harness appends --json)
bd gate create --blocks "$DEPENDENT" --type=bead --await-id "$BLOCKER" \
  --title "$MARKER" --reason "$REASON" --json
```

Observed output (ids differ per run, `created_by`/`owner` elided):

```json
{
  "await_id": "bd176-verify_CNsZPR-1pq",
  "await_type": "bead",
  "id": "bd176-verify_CNsZPR-ncj",
  "issue_type": "gate",
  "status": "open",
  "title": "belayd-fleet-ordering: fleet:default bd176-verify_CNsZPR-1pq -> bd176-verify_CNsZPR-6i5"
}
```

Read it back the way the harness does, and as plain text:

```bash
bd gate list "$DEPENDENT" --json
bd gate list "$DEPENDENT"
```

```text
[
  {
    "id": "bd176-verify_CNsZPR-ncj",
    "title": "belayd-fleet-ordering: fleet:default bd176-verify_CNsZPR-1pq -> bd176-verify_CNsZPR-6i5",
    "status": "open",
    "issue_type": "gate",
    "await_type": "bead",
    "await_id": "bd176-verify_CNsZPR-1pq"
  }
]

⏳ Open Gates (1):

○ bd176-verify_CNsZPR-ncj - bead bd176-verify_CNsZPR-1pq

To resolve a gate: bd close <gate-id>
```

`await_type` is `bead`, `await_id` is the blocker, and the text form says
`bead <blocker>` — not `human`.

### 3. Show `belayd_fleet_status` renders the wait and keeps it out of `Needs you`

The status formatter is built from the real bd gate read. With `dist/` built
(`pnpm build`), this script creates one ordering gate and one real human gate and
formats both members:

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
const dir = mkdtempSync(join(tmpdir(), "bd176-status-"));
const bd = async (argv) => (await exec("bd", [...argv], { cwd: dir, env })).stdout;
const runBd = async (argv, o) => ({ stdout: (await exec("bd", [...argv], { cwd: o.cwd, env })).stdout });
await bd(["init"]);
const create = async (t) => JSON.parse(await bd(["create", t, "-t", "task", "--json"])).id;
const blocker = await create("blocker");
const dependent = await create("dependent");
const humanBead = await create("needs-answer");
await bd(["update", blocker, "--status", "in_progress"]);
await m.createFleetOrderingGates({
  fleetId: "default", taskIds: [blocker, dependent],
  edges: [{ blocker, blocked: dependent }], cwd: dir, runBd,
});
await bd(["gate", "create", "--blocks", humanBead, "--type=human", "--reason", "which option?"]);
const lookup = await m.lookupFleetBeadEngagement({ taskIds: [dependent, humanBead], cwd: dir, runBd });
const memberSnapshot = (taskId) => ({
  worktreePath: `/repo.${taskId}`, isMainWorktree: false, branch: `feat/${taskId}`,
  workflow: { kind: "ok", state: { schemaVersion: 1, taskId, workflowType: "feature",
    branch: `feat/${taskId}`, originalCwd: `/repo.${taskId}`, phaseOrder: ["plan"],
    completedPhaseNames: [], startedAt: 1000, updatedAt: 2000 } },
  runs: [], lease: { state: "absent" },
});
const status = m.applyFleetBeadEngagement(
  m.buildFleetStatus({ fleetId: "fleet-1", intent: undefined,
    members: [dependent, humanBead].map(memberSnapshot) }),
  lookup,
);
console.log(m.formatFleetStatus(status));
console.log("--- Needs you ---");
console.log(m.formatNeedsYou(status) ?? "(undefined)");
'
```

Observed output (ids differ per run):

```text
Fleet fleet-1
  intent: none recorded
  members: 2
  states: active=2 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0

Needs you (1): bd176-status-PZ078F-qkh
  - bd176-status-PZ078F-qkh (assignee (unknown), awaiting human) — (no comments yet)

Member bd176-status-PZ078F-qkh — active
  ...
  awaiting human: yes
  ...

Member bd176-status-PZ078F-w4t — active
  ...
  awaiting human: no
  waiting on: bd176-status-PZ078F-7fz (fleet ordering gate)
  ...

--- Needs you ---
Needs you (1): bd176-status-PZ078F-qkh
  - bd176-status-PZ078F-qkh (assignee (unknown), awaiting human) — (no comments yet)
```

The ordering-gated member (`w4t`) renders
`waiting on: <blocker> (fleet ordering gate)`, shows `awaiting human: no`, and
does **not** appear under `Needs you`. Only the real `--type=human` gate does.
The same assertions live in
`src/__tests__/fleet-bead-engagement.test.ts` ›
`reads a fleet ordering gate as waiting on its blocker, never as a human wait` and
`keeps a legacy human-typed ordering gate out of Needs you too`.

## How to Use

### For operators: nothing to do

New fleet launches already create `bead` ordering gates. There is no flag and no
migration. Existing `fleet.json` records and gate ids keep working; a relaunch
adopts what bd already has.

### Tell ordering from a human question

In `bd gate list <bead>` (text):

- ordering gate: `○ <gate-id> - bead <blocker>` and a title starting
  `belayd-fleet-ordering: fleet:<fleetId> <blocker> -> <blocked>`
- human question: `○ <gate-id> - human`

In `bd gate list <bead> --json` / `bd show <gate-id> --json`:

| Field | Ordering gate | Human question |
| --- | --- | --- |
| `await_type` | `"bead"` | `"human"` |
| `await_id` | the blocker bead | absent / `null` |
| `title` | `belayd-fleet-ordering: fleet:…` | `Gate: human` (default) |

Resolution verbs are the same, but the meaning differs: an ordering gate is
released by the fleet when the blocker lands; a human gate is waiting for your
answer.

### Resolve a stranded ordering gate

The fleet resolves ordering gates on landing (`landedAt`) by gate id. If the
fleet is gone, or a landing could not resolve its gate, resolve it by gate id:

```bash
bd gate list <dependent> --json           # find the id where await_type == "bead"
bd gate resolve <gate-id>                 # == bd close <gate-id>
bd gate list <dependent> --json           # null once resolved
```

Observed:

```text
✓ Gate resolved: bd176-verify_CNsZPR-cgu
null
```

If the blocker's bead is already closed, bd can resolve the bead-typed gate in
bulk instead:

```bash
bd close <blocker>
bd gate check --type=bead
bd gate list <dependent> --json
```

Observed — the gate is still open right after the close, and `gate check`
resolves it:

```text
=== gate list after close (no check yet) ===
{"id":"bd176-check_Rpuall-maq","await_type":"bead","status":"open"}

=== bd gate check --type=bead ===
✓ bd176-check_Rpuall-maq: resolved - bead bd176-check_Rpuall-9ed closed

Checked 1 gates: 1 resolved, 0 escalated, 0 errors

=== gate list after check ===
null
```

Known limit: this bd build does **not** auto-resolve a `bead` gate when the
blocker closes. Closing the blocker leaves the gate `open` until the fleet's
landing resolve or an explicit `bd gate resolve` / `bd gate check --type=bead`.
Do not expect `bd close <blocker>` alone to release the dependent.

### Legacy `human`-typed ordering gates

Gates the fleet created before bd-176 still have `await_type: "human"`, but they
carry the same structured marker. The harness classifies by the marker, so a
legacy ordering gate is never treated as a human wait and never lands in
`Needs you`; it renders `waiting on: <blocker> (fleet ordering gate)` and is
resolved the same way (`bd gate resolve <gate-id>`). No migration is needed.

### Human questions are unchanged

`belayd_ask_human` still creates `--type=human`; its gate keeps appearing as
`human`, still lands in `Needs you`, and is answered by a non-`belayd:*` comment
as before.

## What Changed in the Code

- `src/bead-gates.ts` — `GateCreateOptions` is now a discriminated union:
  `{ awaitType: "human", ... }` or `{ awaitType: "bead", awaitId, ... }`, so a
  `bead` gate cannot be built without an await id. `buildGateCreateArgv` emits
  `--type=bead --await-id <awaitId>` for the `bead` branch and keeps
  `--type=human` for the human branch.
- `src/fleet-ordering-gates.ts` — `buildFleetOrderingGateArgv` calls
  `buildGateCreateArgv({ awaitType: "bead", awaitId: input.blocker, ... })`;
  landing still resolves the recorded gate by id (`landedAt`).
- `extensions/capabilities/human-gate.ts` — `createHumanGate` passes
  `awaitType: "human"` explicitly.
- Classification is unchanged: `fleetOrderingGateMarkerOf` / the structured
  marker still decides ordering vs. human, for both new `bead`-typed and legacy
  `human`-typed ordering gates.
- `docs/fleet.md` — gate-shape section updated for `bead` + `await-id`, the
  manual fallback and the no-auto-resolve limit.
