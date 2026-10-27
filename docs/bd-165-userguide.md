# Stale handed-off `workflow.json` no longer claims a dead orchestrator lease (bd-165)

A worktree handed off to a child orchestrator (or left behind by a finished
workflow) keeps `.belayd/workflow.json`. Before bd-165 the next `session_start`
in that worktree read the file, claimed the one-orchestrator-per-worktree lease
from it, and started the 20 s heartbeat. The lease named a bead the session does
not drive and may already be closed, and the record was never removed — so the
lease read "live" for the life of every later session and the worktree stayed
wedged:

```text
Refusing to drive <dead-bead> in <worktree>: live orchestrator lease for <dead-bead> (session …). One orchestrator per worktree: finish or stop that session, or remove its `.belayd/orchestrator.json` once it is gone.
```

bd-165 classifies a persisted state **before** any lease is claimed:

| Entry point | File | What it decides |
|---|---|---|
| `classifyWorkflowClaimability` | `src/workflow-state.ts:266` | `claimable`, or `inert` with reason `handed-off` / `complete` / `invalid-task-id` |
| `session_start` | `extensions/index.ts:4115` | claims the lease only from a `claimable` state |
| `resumeWorkflowFromDisk` | `extensions/index.ts:4046` | archives an `inert` state instead of arming the gate |
| `archiveWorkflowState` | `src/workflow-state.ts:541` | renames `workflow.json` → `workflow.stale-<epoch-ms>-<hex>.json` |

Nothing is deleted: the dead record (including its `handedOffTo` marker) is kept
for diagnosis, the worktree is lease-free, and the next session — or
`/belayd <new bead>` — claims normally.

## How to Verify

### 1. Know the two records you are looking at

Every check below inspects the same two files in a worktree's `.belayd/`:

| File | Meaning | Written by |
|---|---|---|
| `.belayd/workflow.json` | the persisted workflow ledger: `taskId`, `phaseOrder`, `completedPhaseNames`, optional `handedOffTo: { taskId, branch, sessionId }` | `/belayd` / `activateGate`, updated per phase |
| `.belayd/orchestrator.json` | the worktree lease: `taskId`, `branch`, `sessionId`, `pid`, `claimedAt`, `heartbeatAt` (renewed every 20 s; a heartbeat older than 3 min is stale) | the session's `session_start` claim |

```bash
cd <worktree>
cat .belayd/workflow.json      # absent, or a state to classify (table in "How to Use")
cat .belayd/orchestrator.json  # the lease, if any
```

A `workflow.json` is **inert** when `handedOffTo` is present, when every phase in
its own `phaseOrder` is in `completedPhaseNames`, or when `taskId` does not match
`bd-<id>` (`isValidTaskId`, `src/session-naming.ts:28`). An empty `phaseOrder`
counts as complete: there is nothing left to drive.

### 2. Automated checks

Targeted suites (fast):

```bash
pnpm test workflow-state              # 49 tests — src/__tests__/workflow-state.test.ts
pnpm test:integration workflow-handoff # 8 tests — test/workflow-handoff.integration.test.ts
```

Pass the filter as a bare positional; `--` would forward the filter to vitest and
run everything.

What each file proves:

- `src/__tests__/workflow-state.test.ts` — `classifyWorkflowClaimability (bd-165)`
  covers the claimable control, `complete`, `handed-off`, `handed-off` beating
  `complete`, an invalid task id, the ordering of those reasons, empty
  `phaseOrder`, and that classification does not mutate the state.
  `archiveWorkflowState (bd-165)` covers the timestamped+random rename (content
  preserved), the missing-file no-op (`{ ok: true, archived: false }`), two
  archives in the same millisecond producing two distinct files with both
  contents, and a rename failure returned as `{ ok: false, error }` with the
  source left in place.
- `test/workflow-handoff.integration.test.ts` boots the real `session_start`
  handler over a real `.belayd/` under `mkdtempSync(tmpdir())` and asserts the
  observable bug: a real-shape handed-off record and a mismatched-marker
  handed-off record each leave no lease, no `Refusing to drive` notification, no
  `workflow.json`, and one `workflow.stale-*` archive retaining `handedOffTo`; a
  completed record behaves the same; a genuinely in-progress record still claims
  a lease naming its task and is **not** archived; and the recovery case writes a
  new `workflow.json` for `bd-202` after the archive and asserts the later
  session claims `bd-202` without touching the archive.

Full gate:

```bash
pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
```

### 3. Reproduce the symptom on the pre-fix tree

The driver below imports `extensions/index.ts` from a chosen checkout, calls the
same `session_start` handler pi calls, and prints the notifications, the lease,
and the `.belayd/` listing. It makes no model call.

```bash
repo=$PWD   # the fixed belayd-harness checkout, devShell active

cat > /tmp/bd-165-boot.ts <<'TS'
// usage: jiti bd-165-boot.ts <harness-checkout> <worktree> <session-id> [--keep-lease]
const [repo, cwd, sessionId] = process.argv.slice(2);
const keepLease = process.argv.includes("--keep-lease");
const { readdirSync } = await import("node:fs");
const { readOrchestratorClaim } = await import(`${repo}/src/orchestrator-claim.ts`);
const notifications: Array<{ message: string; level?: string }> = [];
const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
const api = {
  registerTool: () => {},
  registerCommand: () => {},
  on: (event: string, handler: (...a: unknown[]) => unknown) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  sendMessage: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
  events: { emit: () => {}, on: () => () => {} },
};
const mod = await import(`${repo}/extensions/index.ts`);
(mod.default as (pi: unknown) => void)(api);
const ctx = {
  cwd,
  ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
  sessionManager: {
    getSessionId: () => sessionId,
    getSessionName: () => "orchestrator-session",
    getSessionFile: () => `${cwd}/session.jsonl`,
  },
};
for (const h of handlers.get("session_start") ?? []) await h({}, ctx);
console.log("notifications:", JSON.stringify(notifications, null, 2));
console.log("lease:", JSON.stringify(readOrchestratorClaim({ worktreePath: cwd })));
console.log("files:", readdirSync(`${cwd}/.belayd`).sort().join(", ") || "(empty)");
if (!keepLease) {
  for (const h of handlers.get("session_shutdown") ?? []) await h({}, ctx);
}
process.exit(0);
TS
```

Get the pre-fix tree. While the bd-165 change is uncommitted in your checkout,
`HEAD` **is** the pre-fix tree; once it has landed, use the parent of the fix
commit:

```bash
git worktree add --detach /tmp/bd-165-prefix HEAD
# after bd-165 lands:
# fix=$(git log --format=%H -n1 -S'archiveInertWorkflow' -- extensions/index.ts)
# git worktree add --detach /tmp/bd-165-prefix "$fix^"

# reuse the devShell dependency tree instead of installing again
ln -s "$repo/node_modules" /tmp/bd-165-prefix/node_modules
```

Build the stale fixture — a handed-off record, the shape old code never removed
(the marker's task id equals the state's for a real cross-worktree handoff):

```bash
demo=/tmp/bd-165-demo
rm -rf "$demo" && mkdir -p "$demo/.belayd"
cat > "$demo/.belayd/workflow.json" <<'JSON'
{"schemaVersion":1,"taskId":"bd-101","workflowType":"feature","branch":"feat/bd-101","originalCwd":"/tmp/bd-165-demo","phaseOrder":["implement","review","test","userguide","proof","commit"],"completedPhaseNames":["implement","review"],"handedOffTo":{"taskId":"bd-101","branch":"feat/bd-101","sessionId":"sess-child"},"startedAt":1,"updatedAt":1}
JSON
```

Session 1 (pre-fix) claims the dead lease and keeps it — `--keep-lease` stands in
for the session staying open:

```bash
node_modules/.bin/jiti /tmp/bd-165-boot.ts /tmp/bd-165-prefix "$demo" pre-session --keep-lease
```

```text
notifications: []
lease: {"kind":"ok","claim":{"schemaVersion":1,"taskId":"bd-101",...,"sessionId":"pre-session",...}}
files: orchestrator.json, workflow.json
```

Session 2 (pre-fix) is the symptom — refused, and the poison file is still there:

```bash
node_modules/.bin/jiti /tmp/bd-165-boot.ts /tmp/bd-165-prefix "$demo" second-session
```

```text
notifications: [
  {
    "message": "Refusing to drive bd-101 in /tmp/bd-165-demo: live orchestrator lease for bd-101 (session pre-session). One orchestrator per worktree: finish or stop that session, or remove its `.belayd/orchestrator.json` once it is gone.",
    "level": "error"
  }
]
lease: {"kind":"ok","claim":{"schemaVersion":1,"taskId":"bd-101",...,"sessionId":"pre-session",...}}
files: orchestrator.json, workflow.json
```

A **completed** record fails the same way, one step later: the pre-fix session
claims the lease first and then deletes `workflow.json`, so the dead lease keeps
naming the finished bead and `/belayd <new bead>` in a later session is refused
with the same message.

Real-session equivalent: in a terminal, `cd "$demo" && /tmp/bd-165-prefix/bin/pi`,
`cat .belayd/orchestrator.json` (it names `bd-101` with the session's real id),
then start a second session in the same directory and watch for the refusal
notification. Close both sessions to release the lease.

### 4. Confirm the fix on the same fixture

Step 3 leaves the handed-off `workflow.json` and the lease claimed by
`pre-session`. Treat the old session as stopped (drop its lease) and start a
session on this branch:

```bash
rm /tmp/bd-165-demo/.belayd/orchestrator.json   # the pre-fix session is gone
ls /tmp/bd-165-demo/.belayd                     # orchestrator.json gone, workflow.json still there
node_modules/.bin/jiti /tmp/bd-165-boot.ts "$repo" /tmp/bd-165-demo fixed-session
```

```text
[belayd-harness] archived the inert workflow state for bd-101 at /tmp/bd-165-demo/.belayd/workflow.stale-<epoch-ms>-<hex>.json
notifications: []
lease: {"kind":"absent"}
files: workflow.stale-<epoch-ms>-<hex>.json
```

No notification, no `orchestrator.json`, no `workflow.json`; the archive keeps
the marker:

```bash
jq -c '.handedOffTo' /tmp/bd-165-demo/.belayd/workflow.stale-*.json
# {"taskId":"bd-101","branch":"feat/bd-101","sessionId":"sess-child"}
```

Repeat with a completed record (`completedPhaseNames` equal to `phaseOrder`, no
`handedOffTo`) and with an invalid task id (`"taskId": "bd-42;rm -rf /"`): both
are archived the same way, and the log names the persisted task id text.

Real-session equivalent: `cd /tmp/bd-165-demo && pi` (or `"$repo/bin/pi"` from
the devShell) once, then `ls .belayd/`. Nothing is left to open a second session
for; the first one never takes a lease.

### 5. Confirm the recovery for a new bead

Immediately after the archive in step 4, add a genuinely in-progress state for a
new task and start a session in the same worktree:

```bash
cat > /tmp/bd-165-demo/.belayd/workflow.json <<'JSON'
{"schemaVersion":1,"taskId":"bd-202","workflowType":"feature","branch":"feat/bd-202","originalCwd":"/tmp/bd-165-demo","phaseOrder":["implement","review","test","userguide","proof","commit"],"completedPhaseNames":["implement"],"startedAt":2,"updatedAt":2}
JSON
node_modules/.bin/jiti /tmp/bd-165-boot.ts "$repo" /tmp/bd-165-demo new-bead-session --keep-lease
```

```text
notifications: []
lease: {"kind":"ok","claim":{"schemaVersion":1,"taskId":"bd-202",...,"sessionId":"new-bead-session",...}}
files: orchestrator.json, workflow.json, workflow.stale-<epoch-ms>-<hex>.json
```

The lease names the new bead, the old archive is untouched, and the archive is
not re-used. Clean up with `rm /tmp/bd-165-demo/.belayd/orchestrator.json` (the
driver is not a real session) or by re-running the driver without `--keep-lease`.

In a real worktree, the same recovery is a normal launch. To stay in that same
directory use `/belayd bd-202 --no-worktree`: it claims the lease for `bd-202`
here, and `cat .belayd/orchestrator.json` shows `"taskId": "bd-202"`. Without
`--no-worktree`, `/belayd bd-202` launches a sibling worktree and claims the
lease there instead.

### 6. Classify without starting a session

Cheap inspection of what a session would decide:

```bash
repo=$PWD
cat > /tmp/bd-165-classify.ts <<TS
import {
  classifyWorkflowClaimability,
  readWorkflowState,
} from "${repo}/src/workflow-state.ts";

const cwd = process.argv[2];
const state = readWorkflowState({ cwd });
console.log(state === undefined ? "no readable workflow.json" : classifyWorkflowClaimability(state));
TS
node_modules/.bin/jiti /tmp/bd-165-classify.ts /tmp/bd-165-demo
# { kind: 'inert', reason: 'claimable' } after step 5
```

### 7. Clean up a worktree already wedged by the old code

```bash
cd <worktree>
# only if the file exists
jq '{taskId, handedOffTo, completed: (.completedPhaseNames | length), phases: (.phaseOrder | length)}' .belayd/workflow.json
jq '{taskId, sessionId, heartbeatAt, ageMs: (now * 1000 - .heartbeatAt)}' .belayd/orchestrator.json
```

- **Inert state** (handed off, complete, invalid task id): do nothing. The next
  session on this branch archives it. If you want it gone without starting a
  session, rename it, never delete it:
  `mv .belayd/workflow.json ".belayd/workflow.stale-$(date +%s%3N)-manual.json"`.
- **Dead lease from a session that is gone** (`heartbeatAt` older than 3 min):
  the next session takes it over automatically and archives it as
  `orchestrator.stale-<ts>.json`; no manual step is required. You may also
  `rm .belayd/orchestrator.json` while no session holds it.
- **Live lease** (`heartbeatAt` within the last 3 min): the holder is still
  renewing it, so removing the file only makes that session lose the lease at its
  next heartbeat (`This session lost the orchestrator lease for …`) and disarm.
  Stop the holding session first — `jq -r '.sessionId' .belayd/orchestrator.json`
  and find it in the pi-web session list (or
  `journalctl -u pi-web-sessiond | grep <session-id>`); only then remove
  `.belayd/orchestrator.json`. Removing it once the session is gone is safe.

Undo the verification scaffolding:

```bash
rm -rf /tmp/bd-165-demo
git worktree remove --force /tmp/bd-165-prefix
```

## How to Use

### What happens now

Nothing to enable and no operator action for a worktree whose previous workflow
finished or was handed off. On the next `session_start`:

1. the persisted state is classified first;
2. an inert state claims **no** lease and starts **no** heartbeat, so there is no
   `Refusing to drive …` notification;
3. the state file is renamed to
   `.belayd/workflow.stale-<epoch-ms>-<hex>.json`;
4. one line is written to the extension's stderr (the terminal for `pi`, the
   session daemon's journal for pi-web):

   ```text
   [belayd-harness] archived the inert workflow state for <taskId> at <path>
   ```

   In pi-web: `journalctl -u pi-web-sessiond | grep "archived the inert workflow state"`.
   A rename failure instead logs
   `[belayd-harness] could not archive the stale workflow state in <cwd>: <error>`
   and leaves the file in place; a missing file is a silent no-op.

### Telling an inert state from a real one

Read `.belayd/workflow.json`. It is inert — and will be archived rather than
driven — for exactly three reasons:

| Reason | Field evidence |
|---|---|
| handed off | `handedOffTo: { taskId, branch, sessionId }` is present (wins over the phase ledger) |
| complete | every name in `phaseOrder` is in `completedPhaseNames` (an empty `phaseOrder` counts) |
| invalid task id | `taskId` does not match `bd-<id>` (e.g. a crafted or corrupt value) |

Anything else is claimable: the session claims the lease naming that `taskId`,
arms the gate, and resumes the workflow. `workflow.stale-*` files are never read
by the harness — only by an operator.

### The archive file

`workflow.stale-<epoch-ms>-<hex>.json` is the old `workflow.json`, renamed not
deleted, so the `handedOffTo` marker and the phase ledger survive for diagnosis.
It is inert to the harness and safe to delete once you no longer need it. The
`<hex>` discriminator exists so two archives in the same millisecond cannot
overwrite each other.

### What is deliberately unchanged

- **A live lease still refuses a second orchestrator.** That is the design, not
  the bug: `Refusing to drive … live orchestrator lease for …` still appears when
  one session is genuinely driving a worktree and a second one starts there. The
  fix only stops an *inert* record from manufacturing such a lease.
- **A same-directory handoff keeps its child's state.** The child owns
  `.belayd/workflow.json` in that directory and `handedOffTo` is written only
  onto the caller's own cross-worktree state, so the child's live record never
  carries the marker, never classifies as handed off, and is never archived. The
  caller's own record is the session-keyed `.belayd/handoff-<sessionId>.json`,
  which is settled and then ignored as before.
- **The archive happens only in the worktree that holds the record.** If a bead
  is still genuinely in progress in *another* worktree, that worktree's
  `workflow.json` is untouched: only the caller's stale copy is renamed. Do not
  read the archive as evidence that the bead itself is finished — check
  `bd show <id>` for that.

Related: `docs/planning-implement-workflows.md` (the handoff markers and the
inert/claimable split), `docs/fleet-run.md` (the worktree lease and the fleet's
view of a stale workflow).
