# Agent attribution and bead ownership (bd-150)

Before bd-150 every `bd` write from every orchestrator and phase agent
attributed to the operator's git `user.name`, and almost every live bead was
unassigned. You could not tell from `bd history` or `bd show` which agent wrote
a note or which agent was driving a workflow.

bd-150 adds two things, both automatic:

- **an actor on every harness write**, so bd records `belayd:<taskId>:orchestrator`
  (workflow driver) or `belayd:<taskId>:<phase>` (phase agent) instead of your
  name;
- **an assignee mirror**, so the bead shows which agent is driving it — set at
  launch, cleared at every workflow end, and never overriding a human's own
  assignment.

| Session | Session name | Actor |
| --- | --- | --- |
| Orchestrator | `belayd-bd-150` | `belayd:bd-150:orchestrator` |
| Phase agent | `belayd-bd-150-sub-review-abc123` | `belayd:bd-150:review` |
| Phase agent, gate retry / cross-run epoch | `belayd-bd-150-sub-review-abc123-retry-3` | `belayd:bd-150:review` |
| Planning, proof verifier, human, unnamed | anything else | *none* — the write keeps your `user.name` |

The contract and the CAS mechanics are in `docs/beads-actor.md`; this guide is
the operator's verification and usage path.

## How to Verify

Run everything from the repository root. Every command below was executed in
this worktree; the outputs shown are real.

### 1. Targeted unit tests

```bash
pnpm vitest run src/__tests__/beads-actor.test.ts src/__tests__/beads-assignee.test.ts src/__tests__/extension-bd-tool.test.ts src/__tests__/fleet-accept.test.ts
```

Expected: `Test Files 4 passed (4)`, `Tests 68 passed (68)`.

`pnpm test -- <paths>` does **not** work for this — `pnpm test` is `vitest run`,
and the forwarded fixture arguments are ignored (the whole suite runs). Use
`pnpm vitest run <paths>` as above.

The cases that fail if this regresses:

- `beads-actor.test.ts` — `resolves an orchestrator session name`, `resolves a
  phase session name`, `keeps the actor across gate-retry, cross-run and
  fallback epochs`, `never attributes planning sessions`, `leaves humans and
  unnamed sessions unattributed`, `inserts --actor at index 1 so argv[0] stays
  the subcommand`.
- `beads-assignee.test.ts` — the claim/clear settlements, including
  `classifies bd's real two-line guard rejection as a lost guard` and the
  "still-unassigned gets exactly one retry" path.
- `extension-bd-tool.test.ts` — `attributes a write to the orchestrator
  session's actor at index 1`, `attributes a write to the phase session's
  actor`, `lets an explicit caller --actor win over the injected default`,
  `leaves a human session's write unattributed`.
- `fleet-accept.test.ts` — `clears a harness assignee before closing the bead`,
  `leaves a human assignee alone when accepting`.

### 2. Full gates

```bash
pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
```

Expected tails: `Test Files 116 passed (116)` / `Tests 2716 passed (2716)` for
`pnpm test`, `Test Files 11 passed (11)` / `Tests 91 passed (91)` for
`pnpm test:integration`, and no output from `typecheck`, `lint` and `build`
beyond their own headers.

### 3. Criterion 1 — attribution names the agent/phase

`bd history <id>` (the snapshots view) prints `Author: beads`, which is the
Dolt committer, **not** the harness actor — bd 1.3.0 keeps the actor in the
audit log, so read it with `--events`:

```bash
rm -rf /tmp/bd150-check
mkdir -p /tmp/bd150-check && cd /tmp/bd150-check && git init -q && bd init
id=$(bd create --title "actor probe" --type task --json | jq -r '.id')
bd update --actor "belayd:bd-150:implement" --add-label probe -- "$id"
bd history "$id" --events | grep " by belayd:"
bd history "$id" --events --json | jq -r '.[] | "\(.event_type) by \(.actor)"'
```

Expected (the "No Dolt remote configured" line from `bd init` and bd's own
`✓ Updated issue: …` / `✓ Comment added to …` confirmations are normal):

```text
2026-10-26 19:37:38 label_added by belayd:bd-150:implement
label_added by belayd:bd-150:implement
created by Hugo Lewenhaupt
```

Comments carry their author directly, so a phase-written comment is attributed
without any history lookup:

```bash
bd comment --actor "belayd:bd-150:review" "$id" "attributed by the review phase"
bd comments "$id" --json | jq -r '.[] | "\(.author) | \(.text)"'
```

Expected:

```text
belayd:bd-150:review | attributed by the review phase
```

### 4. Criterion 2 — assignee present at launch, cleared at the end

The mirror is exported from the built library, so drive it against the same
scratch database (`pnpm build` first if `dist/` is stale):

```bash
node --input-type=module -e '
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const { mirrorAssignee, clearAssignee } = await import("./dist/src/index.js");
const runBd = (argv, options) => exec("bd", [...argv], options);
const cwd = "/tmp/bd150-check";
const actorOf = (id) => `belayd:${id}:orchestrator`;
const read = async (id) =>
  JSON.parse((await exec("bd", ["show", id, "--json"], { cwd })).stdout)[0].assignee ?? null;
const created = await exec("bd", ["create", "--title", "assignee probe", "--type", "task", "--json"], { cwd });
const id = JSON.parse(created.stdout).id;
console.log("created   ", id, "assignee:", await read(id));
console.log("launch    ", await mirrorAssignee({ taskId: id, actor: actorOf(id), cwd, runBd }), "assignee:", await read(id));
console.log("relaunch  ", await mirrorAssignee({ taskId: id, actor: actorOf(id), cwd, runBd }), "assignee:", await read(id));
console.log("completion", await clearAssignee({ taskId: id, holder: actorOf(id), cwd, runBd }), "assignee:", await read(id));
'
```

Expected (`launch` = set at `/belayd` / `/fleet` / `/belayd --no-worktree` /
`belayd_start_task`, `completion` = the `agent_end` teardown, `belayd_stop_task`
or a fleet accept):

```text
created    bd150-check-czf assignee: null
launch     { ok: true, changed: true, warnings: [] } assignee: belayd:bd150-check-czf:orchestrator
relaunch   { ok: true, changed: false, warnings: [] } assignee: belayd:bd150-check-czf:orchestrator
completion { ok: true, changed: true, warnings: [] } assignee: null
```

`relaunch` is the handoff case: the same actor string is already recorded, so
nothing is written.

### 5. Criterion 3 — a human assignment is never clobbered

Same scratch database, fresh bead, human assignment first:

```bash
node --input-type=module -e '
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const { mirrorAssignee } = await import("./dist/src/index.js");
const runBd = (argv, options) => exec("bd", [...argv], options);
const cwd = "/tmp/bd150-check";
const created = await exec("bd", ["create", "--title", "human probe", "--type", "task", "--json"], { cwd });
const taskId = JSON.parse(created.stdout).id;
const actor = `belayd:${taskId}:orchestrator`;
const me = (await exec("git", ["config", "user.name"])).stdout.trim();
await exec("bd", ["assign", taskId, me], { cwd });
console.log("human owns ", await mirrorAssignee({ taskId, actor, cwd, runBd }));
'
```

Expected — no `bd update` is written, the assignee stays yours, and the warning
is the one the harness logs as
`[belayd-harness] <id> is assigned to "<you>"; left the assignment alone`:

```text
human owns  {
  ok: true,
  changed: false,
  warnings: [
    'bd150-check-owt is assigned to "Hugo Lewenhaupt"; left the assignment alone'
  ]
}
```

Confirm on the bead itself that the value did not move:

```bash
bd show <id> --json | jq '.[0].assignee'
```

### 6. Criterion 4 — no `--claim` from the harness

```bash
grep -rn -- "--claim" src extensions
```

Expected: exactly nine lines, none of them a harness argv builder — the guard
(`src/bd-command.ts`), its rejection message, the agent prompt text
(`src/agent-registry.ts`), one comment in `extensions/index.ts`, and the test
cases that pin the rejection.

```bash
node --input-type=module -e '
const { validateBdCommand } = await import("./dist/src/index.js");
console.log(validateBdCommand("update bd-42 --claim"));
console.log(validateBdCommand("update bd-42 --priority 1").ok);
'
```

Expected:

```text
{ ok: false, error: 'bd <sub> --claim is not allowed through the bd tool.' }
true
```

That rejection is load-bearing: a claim takes a lease, and while a lease is live
every later `--assignee` write refuses without `--force`. It stays.

### 7. Live check on a real workflow

Start a workflow, then read the bead while it runs and after it finishes:

```bash
/belayd bd-X feature            # or: /belayd bd-X feature --no-worktree
bd show bd-X --json | jq '.[0].assignee'
```

Expected: `"belayd:bd-X:orchestrator"` while the workflow runs (a phase agent's
own `bd` calls attribute to `belayd:bd-X:<phase>`), and `null` after completion,
a fleet accept, or a `belayd_stop_task` call. `bd history bd-X --events` keeps the actor of
every write; a per-phase view is
`bd history bd-X --events --json | jq -r '.[] | "\(.actor) \(.created_at)"'`.

Cleanup for steps 3–5:

```bash
rm -rf /tmp/bd150-check
```

## How to Use

### Nothing to configure

Attribution and the assignee mirror are automatic. Launching a workflow is
unchanged — `/belayd <id> <type>`, `/fleet <ids…>`, `/belayd <id> <type>
--no-worktree`, or the `belayd_start_task` tool — and each of those paths
already claims an unassigned bead for `belayd:<taskId>:orchestrator`. You do not
pass `--actor`, set `BEADS_ACTOR`, or call `bd assign`.

What runs underneath:

- the `bd` tool proxy inserts `--actor <actor>` at argv index 1 of every
  proxied call (reads included — harmless, bd accepts the global flag
  everywhere);
- `spawn.ts` puts `BEADS_ACTOR=<actor>` in a phase agent's environment, so its
  raw `bash` `bd …` calls are attributed too;
- an explicit `--actor` you put in the command string still wins, because bd's
  last flag wins;
- a `--no-worktree` orchestrator whose session name pi cannot map to a task id
  falls back to the armed process gate for its actor string.

### Reading ownership

Per bead:

```bash
bd show bd-150                                  # "Assignee: belayd:bd-150:orchestrator" while it runs
bd show bd-150 --json | jq '.[0].assignee'
bd comments bd-150 --json | jq -r '.[] | "\(.author): \(.text)"'
bd history bd-150 --events | grep " by "
```

Who is driving what, across the board — `bd list --assignee` is an **exact**
match, so a `belayd:` prefix filter returns nothing; select the prefix yourself:

```bash
bd list --json | jq -r '.[] | select(.assignee // "" | startswith("belayd:")) | "\(.id)\t\(.assignee)"'
```

Human replies only, with no bookkeeping:

```bash
bd comments bd-150 --json | jq -r '.[] | select(.author | startswith("belayd:") | not) | .author'
```

### Lifecycle: what happens to the assignee

| Event | Assignee |
| --- | --- |
| `/belayd`, `/fleet`, `/belayd --no-worktree`, `belayd_start_task` | set to `belayd:<taskId>:orchestrator` if the bead is unassigned |
| Handoff to a child orchestrator | unchanged — ownership transfers, the child re-mirrors the same actor string (deliberately no parent-side clear) |
| Workflow completion (`agent_end` on the last phase) | cleared |
| `belayd_stop_task` (stop the task) | cleared while the gate is armed |
| `/fleet` accept (`belayd_fleet_merge` with close) | cleared before the bead is closed, unconditionally |
| A human assigned it | never touched; you get a warning |

Every failure is a warning, never a blocked launch: a missing `bd`, a refused
write or a lost race logs `[belayd-harness] …` on stderr and the workflow
continues.

### Opting out: keep the bead yourself

Assign the bead to yourself before or during a workflow:

```bash
bd assign bd-150 "$(git config user.name)"
```

The launch (or relaunch) then reports `bd-150 is assigned to "…"; left the
assignment alone` and writes nothing — both writes are `--if-assignee`
compare-and-set, so the harness cannot overwrite a human holder. To hand
ownership back to the running workflow, clear your own assignment and start the
next launch, or leave it: attribution in `bd history --events` and in comment
authors is independent of the assignee.

Re-assigning also works as a stop sign after a workflow finished: nothing is
holding the bead then, so it stays yours.

### Caveats

- **A finished workflow's bead has no assignee.** Completion, accept and stop
  clear it. The actor is still recorded in `bd history <id> --events` and in the
  author of every comment, so use those for "who did this", not `bd show`.
- **`--no-accept` fleets** stop after landing: no `bd close`, so no assignee
  clear — the bead stays `in_progress` + `human` for you to close. Clean it up
  with your usual `bd close`, or `bd update --assignee "" -- <id>` first if you
  want the ownership column clean.
- **Plain `bd history <id>` shows `Author: beads`.** That line is the Dolt
  committer; the harness actor is the audit actor, visible in `--events`
  (`updated by belayd:…`, or `.actor` in `--json`) and as a comment's `author`.
- **Only workflows are attributed.** A human session, a `belayd-planning-…`
  session and a `belayd-proof-verifier-…` session resolve to no actor, so their
  writes keep your git `user.name`. A harness name with an extra suffix
  (`belayd-bd-150-extra`) is deliberately left unattributed as well.

### Library use

The same pieces are exported if you script bead work yourself:

```typescript
import { execFile } from "node:child_process";
import {
  mirrorAssignee,
  clearAssignee,
  resolveBdActor,
  withActorForSession,
  orchestratorActor,
  phaseActor,
} from "belayd-agent-harness";

// Actor strings and session-name resolution.
orchestratorActor("bd-150"); // "belayd:bd-150:orchestrator"
phaseActor("bd-150", "review"); // "belayd:bd-150:review"
resolveBdActor("belayd-bd-150-sub-review-abc123-run-3"); // "belayd:bd-150:review"
resolveBdActor("belayd-planning-sub-scout-abc123"); // undefined — no workflow actor

// Attribute a raw argv yourself (inserts --actor at index 1).
withActorForSession(["note", "bd-150", "ok"], "belayd-bd-150"); // ["note", "--actor", "belayd:bd-150:orchestrator", "bd-150", "ok"]

// The mirror takes an injected runner, so it is testable and never shells out on its own.
const runBd = (argv, options) => execFile("bd", [...argv], options);
await mirrorAssignee({
  taskId: "bd-150",
  actor: orchestratorActor("bd-150"),
  cwd: "/repo",
  runBd,
});
// { ok: true, changed: true, warnings: [] } | { ok: true, changed: false, warnings: [...] } | { ok: false, error }

await clearAssignee({ taskId: "bd-150", holder: orchestratorActor("bd-150"), cwd: "/repo", runBd });
```

Both return errors as values and never throw; a warning (bead held by someone
else) still means the workflow may proceed.
