# Beads actor identity and assignee ownership (bd-150)

Beads cannot tell which agent wrote what unless every write names an actor. Before
bd-150 every orchestrator and phase-agent write attributed to the operator's git
`user.name`, and 40 of 41 live beads were unassigned — so the audit actor in
`bd history <id> --events` always named the operator, and nobody could see which
agent was driving a bead.

Two mechanisms fix that, because one cannot cover both session kinds:

| Session kind | Mechanism | Why |
|---|---|---|
| pi-web orchestrator (in-process) | `bd` tool proxy inserts `--actor <actor>` | The orchestrator runs *inside* the session daemon, which holds one `process.env` for every session; a harness-set `BEADS_ACTOR` there would attribute the whole daemon |
| Phase agent (child process) | `BEADS_ACTOR` in the spawned child env | A phase agent is a real child process with `bash`, so the env var also attributes its raw `bd …` calls, not just proxy calls |
| Human | neither | A human keeps the git `user.name` (or scotty's inherited `BEADS_ACTOR`) |

An explicit `--actor` in the command string wins over both: the proxy inserts its
default at argv index 1 and bd's last flag wins.

Workflow-lifecycle writes the harness makes on its own (accepting a member closes
the bead, the workflow-type label write-back, the `human` review flag) carry
`orchestratorActor(taskId)` explicitly. They act *for* the workflow, so
`bd history <id> --events` must name the driver rather than the operator.

## Actor format

| Session | Session name | Actor |
|---|---|---|
| Orchestrator | `belayd-bd-150` | `belayd:bd-150:orchestrator` |
| Phase agent | `belayd-bd-150-sub-review-abc123` | `belayd:bd-150:review` |
| Phase agent, gate retry | `belayd-bd-150-sub-review-abc123-retry-3` | `belayd:bd-150:review` |
| Phase agent, cross-run epoch | `belayd-bd-150-sub-implement-abc123-run-3` | `belayd:bd-150:implement` |
| Planning | `belayd-planning-sub-scout-abc123` | *none* (no task id) |
| Proof verifier | `belayd-proof-verifier-abc123` | *none* |
| Human / unnamed | anything else | *none* |

Gate-retry, cross-run and fallback epoch suffixes resolve to the same actor as the
run that created the session (`parseSubagentSessionName` strips
`-retry-N` / `-run-N` / `-fallback-N`).

The orchestrator actor is resolved in two steps: from the session name, then — for
a session whose name pi cannot map to a task id (`/belayd --no-worktree`, a resumed
session) — from the armed process gate. `belayd:…` is the marker for "a harness
actor", so a filter like `bd comments <id> --json | jq 'select(.author | startswith("belayd:") | not)'`
finds human replies with no bookkeeping.

## Assignee lifecycle

The **driving actor** is mirrored as the bead's assignee:

1. **Set at launch.** The bead is assigned to `belayd:<taskId>:orchestrator` at
   every launch path: `/belayd` and `/fleet` (child worktree launch),
   `/belayd --no-worktree`, and `belayd_start_task`.
2. **Cleared at every workflow end: completion, accept and stop.** The
   `agent_end` completion teardown clears it while the gate is still armed, and
   `belayd_stop_task` clears it before teardown while the gate is armed — that
   gate guard is the lease-safety rule: losing the orchestrator lease disarms the
   gate while leaving the task id set, and the actor string is shared per task
   id, so a stale session must not clear the assignment a new driver now holds.
   `belayd_fleet_merge` acceptance clears it **unconditionally** before closing
   the bead: it runs from a fleet supervisor session, which arms no gate and has
   no `gateActive` check, so that clear is bounded only by the CAS guard and the
   `belayd:`-prefix rule (a human assignee still survives). Handoff deliberately
   does *not* clear: ownership transfers to the child orchestrator, which
   re-mirrors the same actor string, so a parent-side clear would wipe the
   child's assignment.
3. **A human assignment wins.** Only an unassigned bead is claimed, and only a
   `belayd:` assignee is cleared. A bead someone assigned to themselves is left
   untouched, with a warning.
4. **Failure never blocks work.** A missing `bd`, a refused write, or a lost race
   degrades to a log line. Ownership is a reporting property of the workflow.

### CAS semantics

A launch legitimately shows **two** `bd update` entries in
`bd history <id> --events` when the workflow type comes from a `wf:` label: the
label write-back (`--add-label`) and the assignee mirror (`--if-assignee`) happen
on the same turn under the same actor.

Both writes are compare-and-set via `bd --if-assignee`, so a concurrent human
assignment is never clobbered:

```
bd update --actor <actor> --if-assignee '' --assignee <actor> -- <id>            # claim, only when unassigned
bd update --actor <holder> --if-assignee <holder> --assignee '' -- <id>         # release a belayd: holder
bd update --if-assignee <holder> --assignee '' -- <id>                          # release a caller-named non-belayd holder
```

A foreign assignee makes the claim fail with
`assignee mismatch: <id> is held by "<other>", expected ""` and nothing is
written. bd exits 13 for that lost guard and 1 for a real failure; the mirror
classifies the rejection, treats **exit 13, or the guard sentence
`assignee mismatch: <id> is held by "<holder>", expected …`** as "nothing was
written", and reports everything else as a real failure without retrying. bd
prints that sentence behind a prefix (`Error updating <id>: …`, repeated as
`  <id>: updating issue: …`), so matching it does not depend on a line anchor;
the `is held by "…", expected ` tail is what keeps a usage/help dump from being
mistaken for a lost guard. After a lost guard it re-reads `bd show <id> --json`
and decides from the observed assignee (ours → success, someone else's →
warning). A bead that is still unassigned gets exactly one retry of the claim; if
the guard keeps losing, the mirror reports that explicitly.

## The `--claim` invariant

The `bd` tool rejects `--claim` (`src/bd-command.ts`), and that rejection is now
**load-bearing for assignment**: a claim takes a lease on the bead, and while a
lease is live every later `bd update --assignee` / `bd assign` refuses without
`--force`. Our beads never hold a claim
(`bd show --json`: `lease_expires_at`, `heartbeat_at`, `claimed_at` all null), which
is exactly what makes the assignee mirror work. Do not relax the `--claim`
rejection or issue `--claim` from harness code.

## How to Verify

Attribute a write to the agent that made it. The actor is the **audit** actor, so
read it with `--events`:

```bash
bd history bd-150 --events                                   # "<event> by belayd:bd-150:<phase>"
bd history bd-150 --events --json | jq -r '.[] | "\(.event_type) by \(.actor)"'
bd show bd-150 --json | jq '.[0].assignee'
```

Plain `bd history <id>` cannot be used for attribution: it is the snapshot view,
and its `Author:` line is the Dolt committer (`beads`), never the harness actor —
an ephemeral wisp has no snapshot history at all (`No history found`). `bd audit`
is an opt-in JSONL sidecar, not the actor source, and `bd show --json` carries no
actor field.

`bd show --json` answers with an array, which is why the read indexes `.[0]`.
Expected: `belayd:bd-150:orchestrator` (or a phase actor) while the workflow runs,
`null` after completion, accept or stop, and a human's own name if a human
re-assigned it.

Comments carry the author directly:

```bash
bd comments bd-150 --json | jq -r '.[] | "\(.author): \(.created_at)"'
```
