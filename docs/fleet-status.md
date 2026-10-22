# Fleet status (`belayd_fleet_status`, bd-126 P0)

One read-only tool that answers: **what is every Belayd workflow in this
repository doing right now?** It walks every git worktree, reads each one's
`.belayd/workflow.json` and `.belayd/runs/` manifests, and renders a single
plain-text view with a derived state per worktree plus fleet-level warnings.

This is milestone **P0** of `docs/fleet-orchestrator.md`. It is observation only:
it never launches a workflow, never merges, never writes, never changes a bead's
status, and never touches another worktree's files. P1–P4 (launch, mailbox,
merge queue, ordering, pause/reconcile) do **not** exist yet.

- [How to Use](#how-to-use)
  - [When to reach for it](#when-to-reach-for-it)
  - [How to invoke it](#how-to-invoke-it)
  - [Worked example](#worked-example)
  - [Reading the output](#reading-the-output)
  - [What it will not do](#what-it-will-not-do)
  - [Common situations](#common-situations)
- [How to Verify](#how-to-verify)

## How to Use

Everything below is operator-facing: when to call the tool, how to call it,
how to read what comes back, and what it will refuse to do.

### When to reach for it

| Question | Tool |
|----------|------|
| Which beads can I start now? | `bd ready` |
| What is this one bead's workflow state, inside its own worktree? | `belayd_status` |
| **What is every workflow in this repo doing at once, and does any worktree disagree with its own branch or another worktree's task id?** | `belayd_fleet_status` |

`belayd_status` is per-session and per-worktree: it describes the workflow the
current directory owns. `belayd_fleet_status` is cross-worktree: it is the only
surface that shows two members side by side, and the only one that flags a
duplicate task id or a `workflow.json` that disagrees with its branch.

It is available at any time, including mid-workflow (it is in `GATED_TOOLS`), but
it is not a workflow step and it is absent from planning mode
(`PLANNING_GATED_TOOLS`).

### How to invoke it

Through the agent, in natural language:

```text
what's the status of the fleet?
show me all worktrees and their workflow states
is anything in this repo blocked or waiting on me?
```

The tool takes one optional parameter:

| Param | Default | Meaning |
|-------|---------|---------|
| `fleetId` | `default` | Name of the fleet **intent** directory: `<git-common-dir>/belayd/fleet/<fleetId>/fleet.json`. Selects which intent record is reported. It does not filter members — the member list always covers every worktree in the repo. |

The id is trimmed and sanitized before it becomes a path segment (characters
outside `A-Z a-z 0-9 . _ -` become `_`; empty, `.`, and `..` fall back to
`default`). When sanitizing changed your input, the header names the sanitized
directory that was actually read and shows the raw input alongside it:

```text
Fleet .._evil (requested "../evil")
```

A non-default id matters only when a human wrote an intent file for that fleet.
P0 never creates `fleet.json`; without one, the header reads
`intent: none recorded` — and every fleet id therefore returns the same member
list with a different header. With a real intent file the first lines read:

```text
Fleet night-shift
  intent: bd-42, bd-43, max 2 concurrent
  members: 2
  states: active=2 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0
```

(`paused` and `no task ids` can also appear in that `intent:` line; P0 only
reports those fields.)

Outside a pi session, call the library functions `readFleetStatus({ cwd, fleetId })`
and `formatFleetStatus(status)` — both are exported from `src/index.ts`
(`src/fleet-status.ts`).

### Worked example

Real output, run in this repository while bd-126 was in its `userguide` phase:

```text
Fleet default
  intent: none recorded
  members: 2
  states: active=1 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=1

Member bd-126 — active
  worktree: /home/hugo/git/belayd-agent-harness.feat-bd-126 (branch feat/bd-126)
  workflow: feature 3/6 phases complete
  pending: userguide, proof, commit
  awaiting review response: no
  interrupted runs: 0
  last updated: 2026-10-22T19:53:42.174Z
  latest runs: implement=completed, review=completed, test=completed, userguide=running

Member (no task id) — missing-state
  worktree: /home/hugo/git/belayd-agent-harness.feat-bd-125 (branch feat/bd-125)
  workflow: missing
  interrupted runs: 0
  last updated: 2026-10-21T22:55:47.738Z
  latest runs: commit=completed, implement=completed, proof=completed, review=completed, test=completed, userguide=completed

Warnings (1):
  - no .belayd/workflow.json in /home/hugo/git/belayd-agent-harness.feat-bd-125; that worktree drives no workflow
```

That run is worth reading closely:

- The `bd-125` worktree still holds completed run manifests but no workflow
  state, so it is `missing-state` and sorts **last** (members without a task id
  come after those with one).
- `last updated` for that member still resolves, because it falls back to the
  newest run timestamp when `workflow.json` is absent.
- The repository's own checkout (`/home/hugo/git/belayd-agent-harness`, branch
  `main`) is not listed: it holds no workflow state, so it is the supervisor's
  merge target rather than a member.
- `3/6` counts phases completed **in phase order**; `latest runs` always shows
  the newest manifest per phase, so `userguide=running` is why the member is
  `active` rather than `idle`.

### Reading the output

Header lines:

| Line | Meaning |
|------|---------|
| `Fleet <id>` | Sanitized fleet id whose directory was read; `(requested "<raw>")` is appended only when sanitizing changed the input |
| `intent:` | Contents of `fleet.json`, or `none recorded` |
| `members:` | Number of worktrees in the view (the main checkout counts only when it holds workflow state) |
| `states:` | Count per derived state, printed in the fixed order `active blocked awaiting-human interrupted idle missing-state` |

Per member (blocks are separated by a blank line and sorted by task id, code
unit order):

| Line | Meaning |
|------|---------|
| `Member <taskId> — <state>` | Task id recorded in `workflow.json`, or `(no task id)` when there is no readable state |
| `worktree: <path> (branch <branch>)` | Path from `git worktree list`, and the checked-out branch (`detached HEAD` when there is none) |
| `workflow: <type> <n>/<m> phases complete` | Workflow sub-type and completed-in-order phase count |
| `pending: <phases>` | Phase order minus completed, or `none` |
| `awaiting review response: yes\|no` | The workflow is parked waiting for the operator |
| `interrupted runs: <n>` | How many run manifests are `interrupted` |
| `last updated: <ISO-8601>\|unknown` | `workflow.json` `updatedAt`, raised to the newest run timestamp when that is later |
| `latest runs: <phase>=<status>, …` | Newest manifest per phase, in workflow phase order (`none` when no manifests exist) |
| `workflow: missing` / `workflow: corrupt` | Replaces the `<type> n/m phases complete` line when `workflow.json` is absent or does not parse; the `pending:` and `awaiting review response:` lines are then omitted (the remaining lines are unchanged) |

Derived `state` (first match wins, in this order):

| State | Meaning | Operator reading |
|-------|---------|------------------|
| `missing-state` | No readable `.belayd/workflow.json` in that worktree | Nothing is driving that tree; see [Common situations](#common-situations) |
| `interrupted` | At least one run manifest is `interrupted` | A phase crashed or was killed; that workflow needs a re-run in its own worktree |
| `awaiting-human` | `awaitingReviewResponse` is set, or a `completedBy: "user"` run's report was never delivered | Someone must respond before it moves |
| `blocked` | The newest run of a not-yet-completed phase `failed` | The phase failed; fix and re-run it in that worktree |
| `idle` | Every phase in `phaseOrder` is complete | Workflow finished; commit/merge is still a human step |
| `active` | Anything else — including a phase that is `running` right now | Normal progress |

Warnings (absent when there are none):

| Warning text | Trigger | What to do |
|--------------|---------|------------|
| `no .belayd/workflow.json in <path>; that worktree drives no workflow` | A linked worktree has no state file | If the workflow really finished, remove the stale worktree (`git worktree remove <path>`); if it did not, restart the task there. The member cannot be scheduled until it holds state. |
| `unreadable .belayd/workflow.json in <path>` | The file exists but does not parse as workflow state | Inspect/replace the file. Nothing can be derived from that worktree until it parses; never edit it from a different worktree. |
| `<path> records <a>, but its branch or directory names <b>` | `workflow.json` `taskId` disagrees with the branch (or the worktree directory name) | The worktree holds another bead's state, or was re-branched. bd-119 phase/commit/proof tools refuse in that state, so sort out the identity before running a phase. |
| `<taskId> is claimed by <n> worktrees: <paths>` | Two worktrees record the same `taskId` | Exactly one is real. Do not run phases in either until you know which; `bd show <taskId>` plus the branches tell you which tree owns the bead. |
| `git worktree list entry "<path>" was skipped: non-key line(s) "…" mean the path does not round-trip through line-oriented porcelain (…git >= 2.36 `-z` is required)` | `git worktree list --porcelain -z` failed (git < 2.36 has no `-z`), so the line-oriented fallback ran and a path containing a newline cannot round-trip; the NUL form never produces this warning | Upgrade git. A skipped entry is *not reported at all*, so never read its absence as "that worktree is clean". |

The tool exits `0` on a successful read and `1` on a reader failure (not a git
repository, git missing). A failure prints the git error instead of a view:

```text
git rev-parse --git-common-dir failed in /tmp: Command failed: git rev-parse --path-format=absolute --git-common-dir
fatal: not a git repository (or any of the parent directories): .git
```

### What it will not do

- It does **not** launch, spawn, restart, or resume any workflow or phase.
- It does **not** merge, rebase, stash, checkout, commit, or add/remove a
  worktree — it runs exactly two read-only git probes
  (`git rev-parse --git-common-dir`, `git worktree list --porcelain -z`).
- It does **not** write anything: no `fleet.json`, no `audit.log`, no run
  manifest, no `.belayd` state. It does not even create
  `<git-common-dir>/belayd/fleet/`.
- It does **not** change bead status, and makes no `bd` calls at all.
- It does **not** touch another worktree's files: every read is a plain fs read
  of that worktree's own `.belayd/` records.
- It has **no** cross-tree authority. The bd-119 preflight still governs phase,
  proof, and commit tools; being able to *see* another member does not let you
  act on it.

If you want the tool to *do* something with what it reports, that is P1–P4, and
none of it is available yet — see the milestone table in
`docs/fleet-orchestrator.md`. For now: read the view, then act through the bead's
own orchestrator/worktree, `bd`, or `wt merge` as usual.

### Common situations

**A worktree shows `missing-state`.** Either its workflow finished and the
worktree was left behind (`git worktree remove <path>`), or its `.belayd/` was
deleted/moved. Note that run manifests can outlive `workflow.json` — that is why
the bd-125 example still prints `last updated` and six `latest runs` while
reporting `missing-state`.

**A `duplicate-task-id` warning.** Two worktrees both claim one bead — typically
a worktree copied by hand, or a `.belayd/workflow.json` moved between trees.
Compare the branches in the `worktree:` lines; run phases only in the tree whose
branch matches the bead. Two members legitimately sharing an id is not a state
the workflow model supports.

**A corrupt `workflow.json`.** The file is present but does not satisfy the
workflow-state schema (truncated write, hand edit, wrong schema version). Every
other member is still reported — corruption is contained to that member. Fix or
remove the file inside that worktree; do not drive its phases until it parses.

**A `task-id-mismatch` warning.** `workflow.json` says one bead, the branch or
directory name says another. bd-119 refuses phase, proof, and commit tools in
that state, so treat the warning as a prediction of the refusal and reconcile
before starting work.

**The main checkout is not listed.** By design: the root checkout is the
supervisor's merge target, not a member, until it holds workflow state. An
in-place (`--no-worktree`) workflow in the root *does* appear, because it has
state. A repository with no worktrees at all prints:

```text
No fleet members: no worktree holds Belayd workflow state.
```

**A worktree is missing from the list entirely.** Check for an
`unparsed-worktree-path` warning: it means git's output could not be read
faithfully, not that the worktree is healthy.

## How to Verify

Run every command from the repository root. The driver below loads
`extensions/index.ts` through `jiti`, so no build step is required.

### 1. Gates

```bash
pnpm test              # Test Files 82 passed (82); Tests 1906 passed (1906)
pnpm test:integration  # Test Files  8 passed (8);  Tests   69 passed (69)
pnpm typecheck         # tsc --noEmit, no output
pnpm lint              # Checked 154 files … No fixes applied.
pnpm build             # tsc to dist/
```

The fleet-specific suites are `src/__tests__/fleet-status.test.ts` (pure view
builder, formatter, derivation, warnings), `src/__tests__/extension-fleet-status-tool.test.ts`
(registration, fleet-id defaulting/sanitizing, error exit code, gate membership)
and `test/fleet-status.integration.test.ts` (real git). Run just those:

```bash
pnpm vitest run src/__tests__/fleet-status.test.ts \
  src/__tests__/extension-fleet-status-tool.test.ts
pnpm vitest run --config vitest.integration.config.ts test/fleet-status.integration.test.ts
```

Expected: `Test Files 2 passed (2)`, `Tests 65 passed (65)` for the unit pair
(59 in `fleet-status.test.ts`, 6 in `extension-fleet-status-tool.test.ts`), and
`Test Files 1 passed (1)`, `Tests 5 passed (5)` for the integration file.

### 2. Install the driver

```bash
cat > /tmp/belayd-fleet-tool.ts <<'TS'
// Run with: node_modules/.bin/jiti /tmp/belayd-fleet-tool.ts '<params JSON>' [cwd]
interface FleetTool {
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ text: string }>;
    details: { exitCode: number };
  }>;
}

const repo = process.env.BELAYD_REPO ?? process.cwd();
const mod = (await import(`${repo}/extensions/index.ts`)) as { default: (api: unknown) => void };

const tools = new Map<string, FleetTool>();
const api = {
  registerTool: (def: FleetTool & { name: string }) => tools.set(def.name, def),
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

const result = await tool.execute("doc", JSON.parse(process.argv[2] ?? "{}"), undefined, undefined, {
  cwd: process.argv[3] ?? repo,
});
console.log(result.content.map((part) => part.text).join("\n"));
console.error(`[exitCode=${result.details.exitCode}]`);
process.exit(result.details.exitCode ?? 0);
TS

export BELAYD_REPO=$(pwd)
J=$BELAYD_REPO/node_modules/.bin/jiti
T=/tmp/belayd-fleet-tool.ts
```

### 3. See the real view

```bash
nix develop -c bash -lc "$J $T '{}'" 2>/dev/null
```

Expected: a `Fleet default` header, then one `Member <taskId> — <state>` block
per worktree that holds workflow state. Assert structure, not counts: on this
branch `git worktree list` reports three worktrees but only two are members,
because the main checkout holds no state. Every state must be one of
`active blocked awaiting-human interrupted idle missing-state`:

```bash
nix develop -c bash -lc "$J $T '{}'" 2>/dev/null \
  | grep -E '^(Fleet |  states:|Member )'
```

```text
Fleet default
  states: active=1 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=1
Member bd-126 — active
Member (no task id) — missing-state
```

The fleet id is the driver's first argument (a JSON params object); a
sanitized id is visible in the header:

```bash
nix develop -c bash -lc "$J $T '{\"fleetId\":\"../evil\"}'" 2>/dev/null | head -1
```

```text
Fleet .._evil (requested "../evil")
```

A non-repository directory cannot produce a view — the tool prints git's error
and exits `1`:

```bash
nix develop -c bash -lc "$J $T '{}' /tmp"; echo "exit=$?"
```

```text
git rev-parse --git-common-dir failed in /tmp: …
fatal: not a git repository (or any of the parent directories): .git
[exitCode=1]
exit=1
```

### 4. Prove the read-only contract

Nothing about the repository may change — not only tracked files, but refs,
the worktree list, and the shared fleet directory. Take a snapshot, call the
tool, compare. **Assert identical, not empty**: on an active branch
`git status --porcelain` is non-empty by definition.

```bash
S=$(mktemp -d)
git status --porcelain > "$S/status.before"
git worktree list      > "$S/wt.before"
git for-each-ref --format='%(refname) %(objectname)' > "$S/refs.before"

nix develop -c bash -lc "$J $T '{}'" > /dev/null 2>&1

git status --porcelain > "$S/status.after"
git worktree list      > "$S/wt.after"
git for-each-ref --format='%(refname) %(objectname)' > "$S/refs.after"

diff "$S/status.before" "$S/status.after" && echo "status: identical"
diff "$S/wt.before"     "$S/wt.after"     && echo "worktrees: identical"
diff "$S/refs.before"   "$S/refs.after"   && echo "refs: identical"
ls -d "$(git rev-parse --git-common-dir)/belayd/fleet"
```

```text
status: identical
worktrees: identical
refs: identical
ls: cannot access '/home/hugo/git/belayd-agent-harness/.git/belayd/fleet': No such file or directory
```

That last line is the point: P0 does not create the fleet directory at all, not
even the default one. (`<git-common-dir>` resolves to the main checkout's
`.git`, so the path names that repository, not the worktree you ran from.)

### 5. Prove determinism

```bash
nix develop -c bash -lc "$J $T '{}'" > /tmp/fleet-1.txt 2>/dev/null
nix develop -c bash -lc "$J $T '{}'" > /tmp/fleet-2.txt 2>/dev/null
diff /tmp/fleet-1.txt /tmp/fleet-2.txt && echo "identical"
```

```text
identical
```

Two properties make this hold, and both are worth knowing when you read the
output:

- Members sort by task id using **code-unit** comparison (never
  `localeCompare`), so the host locale/ICU data cannot reorder them; members
  with no task id go last, ordered by worktree path.
- The "latest run per phase" rule is a total order: newest `startedAt` wins, ties
  broken by `runId` by code unit — `listRuns` itself orders equal timestamps by
  `readdirSync`, so without the tie-break the derived state could flip between
  calls. Output contains no ANSI escapes and no timestamps of "now".

### 6. The test that pins all of it

`test/fleet-status.integration.test.ts` builds a throwaway repo with two linked
worktrees and asserts the same contract programmatically: identical view on
repeated reads, an unchanged file tree (size + mtime of every path, so
gitignored `.belayd/` writes would show up) in the root and both worktrees,
unchanged refs, unchanged `git worktree list --porcelain`, unchanged
`git status --porcelain --untracked-files=all`, and `fleetStateDir(...)` still
absent. Its last case drives the registered `belayd_fleet_status` tool the same
way the driver does.

## Related documentation

- `docs/fleet-orchestrator.md` — the design record: scheduler architecture,
  shared fleet state layout, locked decisions, and the P0–P4 milestones.
- `docs/owned-worktree.md` — the bd-119 bead ↔ branch ↔ worktree preflight that
  keeps one gate, one bead, one worktree intact (and that the
  `task-id-mismatch` warning predicts).
- `docs/model-capacity-and-telemetry.md` — the `.belayd/runs/` manifests the
  derived view reads.
- `docs/planning-implement-workflows.md` — the per-bead workflow whose phase
  order the view renders.
