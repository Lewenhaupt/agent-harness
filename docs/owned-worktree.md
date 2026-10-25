# Bead ↔ branch ↔ worktree ownership preflight (bd-119)

A phase tool (`belayd_implement`, `belayd_review`, …) used to accept an
undocumented `cwd` parameter, so an orchestrator owning one worktree could run
another bead's phase inside its own tree. During the bd-80 → bd-87 stacked
follow-up that happened for real: bd-87 fix rounds ran with `cwd` = the bd-80
worktree, the sub-agents were jailed there by the worktree guard, and one agent
worked *around* the guard (`node -e` cross-tree writes) instead of failing.
Nothing asserted bead ↔ branch ↔ worktree identity, so the damage was silent.

bd-119 makes that identity a hard precondition:

- Phase tools and `belayd_proof_verifier` no longer accept `cwd`. They always run
  in the session's own directory (`ctx.cwd`).
- `src/owned-worktree.ts` adds the preflight: it reads `.belayd/workflow.json`
  in the run directory, requires `taskId` to match, and requires
  `git branch --show-current` there to equal the branch the workflow recorded.
  The check runs **before** the run starts, so a rejected call creates no run
  manifest and spawns no sub-agent.
- `belayd_commit` runs the same check before staging (`git add` never happens on
  a mismatch).
- Every phase sub-agent prompt starts with a one-line worktree pin.

## What changed

| Surface | Before | Now |
|---------|--------|-----|
| `belayd_scout`, `belayd_plan`, `belayd_implement`, `belayd_review`, `belayd_test`, `belayd_userguide`, `belayd_proof`, `belayd_documenter` | `{ task, cwd? }`, `cwd ?? ctx.cwd` | `{ task }` only; ownership preflight on `ctx.cwd` |
| `belayd_proof_verifier` | `{ task?, proof?, cwd? }` | `{ task?, proof? }`; ownership preflight on `ctx.cwd` |
| `belayd_commit` | no branch/task identity check | refuses before staging on task or branch mismatch |
| `belayd_plan_scout`, `belayd_plan_research` | silently fell back to `process.cwd()` (`/` in pi-web session processes) | hard error when the session has no working directory |
| Phase sub-agent prompt | bead plan only | prefix `Your worktree is <path> on <branch>; writing elsewhere is a bug, not a workaround.` |

## What an operator sees now

Every refusal is a text tool result with `details.exitCode: 1`. The strings come
from `src/owned-worktree.ts` (`matchOwnedWorktree`,
`matchSessionOwnedWorktree`, `formatWorktreePreamble`) and `extensions/index.ts`
(`commitOwnershipError`, `missingWorkingDirectoryError`).

### Phase tools and `belayd_proof_verifier`

| Case | Message |
|------|---------|
| Foreign task (this directory belongs to another bead) | `<persistedTaskId> lives in <cwd> (branch <persistedBranch>); this session is for <sessionTaskId> — use the orchestrator that owns <sessionTaskId>'s worktree.` |
| Branch mismatch (right directory, wrong branch checked out) | `<persistedTaskId> lives in <cwd> (branch <persistedBranch>); this session is in <cwd> (branch <actualBranch>) — use the orchestrator that owns that worktree.` |
| Detached HEAD in the owning worktree | `<persistedTaskId> lives in <cwd> (branch <persistedBranch>); this session is in detached HEAD — check out <persistedBranch> in <cwd>.` |
| git cannot report a branch (not a repo, git missing) | `<persistedTaskId> lives in <cwd> (branch <persistedBranch>); could not read the branch here (<git error>) — run from a checkout of <persistedBranch>.` |
| No `.belayd/workflow.json` in `cwd`, session owns a task | `No Belayd workflow state in <cwd>; cannot run <sessionTaskId> here — use the orchestrator that owns that worktree.` |
| Session has no active task but `cwd` holds another bead's live workflow | `<persistedTaskId> owns <cwd> (branch <persistedBranch>) — start <persistedTaskId> or run this phase from your own worktree.` |
| Session has no working directory at all | `<tool label> has no working directory: this session cannot be pinned to a worktree.` (labels: `Belayd phase run`, `Proof verifier`, `belayd_commit`, `belayd_plan_scout`, `belayd_plan_research`) |

Real output from the scratch repro in *How to Verify*:

```text
foreign task       bd-87 lives in /tmp/bd119/feat-bd-87 (branch feat/bd-87); this session is for bd-42 — use the orchestrator that owns bd-42's worktree.
branch mismatch    bd-42 lives in /tmp/bd119/feat-bd-42 (branch feat/bd-42); this session is in /tmp/bd119/feat-bd-42 (branch feat/other) — use the orchestrator that owns that worktree.
detached HEAD      bd-42 lives in /tmp/bd119/feat-bd-42 (branch feat/bd-42); this session is in detached HEAD — check out feat/bd-42 in /tmp/bd119/feat-bd-42.
no workflow.json   No Belayd workflow state in /tmp/bd119/repo; cannot run bd-42 here — use the orchestrator that owns that worktree.
no active task     bd-87 owns /tmp/bd119/feat-bd-87 (branch feat/bd-87) — start bd-87 or run this phase from your own worktree.
```

The branch-mismatch line repeats the directory because the mismatch is the
branch, not the path — both sides are named so you can see which branch the tree
is actually on.

### `belayd_commit`

| Case | Message |
|------|---------|
| Caller passes another session's task id | `this session owns <sessionTaskId>; refusing to commit <taskId> in <cwd> — use the orchestrator that owns <taskId>'s worktree.` |
| No task id supplied, but a stale `workflow.json` records a different branch (or a mismatched branch when one is supplied) | the branch-mismatch / detached / unreadable messages above |
| No working directory | `belayd_commit has no working directory: this session cannot be pinned to a worktree.` |

A `cwd` with **no** `.belayd/workflow.json` has no identity contract to violate,
so standalone commits there still stage normally. Sub-bead ids are allowed: a
`bd-42` session may commit `bd-42.1`; the reverse (a `bd-42.1` session passing
`bd-42`) is refused, as are prefix lookalikes such as `bd-42x`.

### Sub-agent preamble

Every phase sub-agent prompt now begins with:

```text
Your worktree is /home/hugo/git/example.feat-bd-42 on feat/bd-42; writing elsewhere is a bug, not a workaround.
```

Variants: `... on detached HEAD; ...` when git reports detached HEAD, and the
` on <branch>` clause is omitted entirely when the branch cannot be determined
(git unavailable). The line is prepended on fresh runs, resumed runs, and
cross-run resumes — a resumed run whose task text is only the orchestrator's fix
instructions still carries the pin.

## How to Verify

Run from the repository root in the devShell. Build first so the `node` steps
read `dist/`.

```bash
pnpm build
```

### 1. Focused unit + integration tests (fast)

```bash
pnpm vitest run src/__tests__/owned-worktree.test.ts
pnpm vitest run src/__tests__/extension-commit-tool.test.ts -t "refuses"
pnpm vitest run src/__tests__/extension-session-naming.test.ts -t "another task"
pnpm vitest run --config vitest.integration.config.ts test/owned-worktree.integration.test.ts
```

Expected: `24 passed`, `3 passed | 23 skipped`, `2 passed | 58 skipped`, and
`3 passed`.

What each pins:

| Test | Pins |
|------|------|
| `src/__tests__/owned-worktree.test.ts` → `matchOwnedWorktree` (match / foreign task / branch mismatch / no workflow.json / detached HEAD / unreadable repo / legacy empty branch) | the pure matcher and every message shape |
| same file → `isSameOrDescendantTask` | sub-bead accepted, parent from a sub-bead session refused, `bd-42x` / `bd-42.` refused |
| same file → `matchSessionOwnedWorktree` | gate-off rework allowed, foreign live workflow refused, unknown branch tolerated |
| same file → `readWorktreeBranch`, `formatWorktreePreamble` | detached vs unavailable distinction; preamble wording and branch-clause omission |
| `src/__tests__/extension-commit-tool.test.ts` → `refuses to stage a tree whose branch is not the workflow branch`, `refuses to commit another task's id from a pinned session`, `refuses a stale workflow branch even when no task id is supplied` | `belayd_commit` refuses **and** `git add` / `git commit` are never invoked |
| same file → `allows a sub-bead taskId from the parent session` | `bd-42.1` from a `bd-42` session still commits |
| `src/__tests__/extension-session-naming.test.ts` → `refuses a phase whose workflow.json belongs to another task (W1)`, `refuses to review when workflow.json belongs to another task (bd-113)` | phase tools refuse a foreign `workflow.json`; `mockSpawnAgentProcess` is not called and the foreign ledger is untouched |
| `test/owned-worktree.integration.test.ts` | two real linked worktrees: a session that owns A gets `exitCode 1` when the tool is invoked with `cwd = B`, **both** trees show empty `git status --porcelain`, and `.belayd/runs` is empty in both |

### 2. Manual scratch repro (two worktrees, no pi session needed)

```bash
D=/tmp/bd119 && rm -rf "$D" && mkdir -p "$D" && cd "$D"
git init -q -b main repo && cd repo
git config user.email t@example.com && git config user.name T
echo ".belayd/" > .gitignore && git add . && git commit -qm base
git worktree add -q -b feat/bd-42 "$D/feat-bd-42" main
git worktree add -q -b feat/bd-87 "$D/feat-bd-87" main
for wt in feat-bd-42 feat-bd-87; do
  id=${wt#feat-}
  mkdir -p "$D/$wt/.belayd"
  printf '{"schemaVersion":1,"taskId":"%s","workflowType":"bugfix","branch":"feat/%s","originalCwd":"%s","phaseOrder":["plan","implement","review","test","commit"],"completedPhaseNames":[],"startedAt":1,"updatedAt":1}' \
    "$id" "$id" "$D/$wt" > "$D/$wt/.belayd/workflow.json"
done
```

Two linked worktrees now exist, each pinned to its own bead and branch
(`feat-bd-42` owns `bd-42` on `feat/bd-42`, `feat-bd-87` owns `bd-87` on
`feat/bd-87`); `$D/repo` stays on `main` with no workflow state.

Save this as `/tmp/bd119/check.mjs`:

```javascript
// Usage: node /tmp/bd119/check.mjs /tmp/bd119 <belayd-agent-harness repo root>
const base = process.argv[2];
const harness = process.argv[3] ?? process.cwd();
const { execFileSync } = await import("node:child_process");
const {
  assertOwnedWorktree,
  formatWorktreePreamble,
  matchOwnedWorktree,
  matchSessionOwnedWorktree,
  readWorktreeBranch,
} = await import(`${harness}/dist/src/owned-worktree.js`);
const { readWorkflowState } = await import(`${harness}/dist/src/workflow-state.js`);

const a = `${base}/feat-bd-42`;
const b = `${base}/feat-bd-87`;
const plain = `${base}/repo`;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
const show = (label, result) =>
  console.log(`${label.padEnd(18)} ${result.ok ? `ok branch=${result.branch}` : result.error}`);

show("owning session", assertOwnedWorktree({ cwd: a, taskId: "bd-42", branch: readWorktreeBranch(a) }));
show("foreign task", assertOwnedWorktree({ cwd: b, taskId: "bd-42", branch: readWorktreeBranch(b) }));
show("no workflow.json", assertOwnedWorktree({ cwd: plain, taskId: "bd-42", branch: readWorktreeBranch(plain) }));
show(
  "no active task",
  matchSessionOwnedWorktree({
    cwd: b,
    currentTaskId: "",
    gateActive: false,
    branch: readWorktreeBranch(b),
    persisted: readWorkflowState({ cwd: b }),
  }),
);

git("-C", a, "switch", "-q", "-c", "feat/other");
show(
  "branch mismatch",
  matchOwnedWorktree({
    cwd: a,
    taskId: "bd-42",
    branch: readWorktreeBranch(a),
    persisted: readWorkflowState({ cwd: a }),
  }),
);
git("-C", a, "switch", "-q", "feat/bd-42");
git("-C", a, "checkout", "-q", "--detach");
show(
  "detached HEAD",
  matchOwnedWorktree({
    cwd: a,
    taskId: "bd-42",
    branch: readWorktreeBranch(a),
    persisted: readWorkflowState({ cwd: a }),
  }),
);
git("-C", a, "switch", "-q", "feat/bd-42");

console.log("preamble          ", formatWorktreePreamble({ cwd: a, branch: "feat/bd-42" }));
```

Run it from the harness repo root (where `dist/` lives):

```bash
node /tmp/bd119/check.mjs /tmp/bd119 "$(pwd)"
```

Expected:

```text
owning session     ok branch=feat/bd-42
foreign task       bd-87 lives in /tmp/bd119/feat-bd-87 (branch feat/bd-87); this session is for bd-42 — use the orchestrator that owns bd-42's worktree.
no workflow.json   No Belayd workflow state in /tmp/bd119/repo; cannot run bd-42 here — use the orchestrator that owns that worktree.
no active task     bd-87 owns /tmp/bd119/feat-bd-87 (branch feat/bd-87) — start bd-87 or run this phase from your own worktree.
branch mismatch    bd-42 lives in /tmp/bd119/feat-bd-42 (branch feat/bd-42); this session is in /tmp/bd119/feat-bd-42 (branch feat/other) — use the orchestrator that owns that worktree.
detached HEAD      bd-42 lives in /tmp/bd119/feat-bd-42 (branch feat/bd-42); this session is in detached HEAD — check out feat/bd-42 in /tmp/bd119/feat-bd-42.
preamble           Your worktree is /tmp/bd119/feat-bd-42 on feat/bd-42; writing elsewhere is a bug, not a workaround.
```

The script returns tree A to `feat/bd-42`;
`git -C /tmp/bd119/feat-bd-42 status --porcelain` stays empty because the
preflight is read-only.

### 3. Confirm the tool refuses and creates no run

The matcher repro above shows the messages. The tool-level refusals — no run
manifest, no spawn, both trees clean — are pinned by
`test/owned-worktree.integration.test.ts` (step 1). Its assertions are the
contract:

```bash
pnpm vitest run --config vitest.integration.config.ts test/owned-worktree.integration.test.ts
```

In a real pi session with a live workflow the same holds: the `bd-42`
orchestrator's `belayd_implement` starts normally, and a call that passed
`cwd = <bd-87 tree>` no longer moves the run (the parameter is ignored and the
run uses `ctx.cwd`), while a session booted in the bd-87 tree refuses a bd-42
phase with the messages above.

### 4. Full gate

```bash
pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
```

## How to Use

### The new contract

- Phase tools take **only** `task`: `belayd_implement { task: "..." }`. The run
  directory is always the session's own directory.
- Run a bead's phases from the worktree that owns that bead. One orchestrator per
  worktree — two sessions driving one bead from different trees is exactly what
  this preflight rejects.
- `.belayd/workflow.json` is the identity record: `taskId` plus `branch` (written
  by `belayd_start_task`, `belayd_start_followup`, `belayd_stack_rebase`). Keep
  the worktree on that branch; a manual `git switch` inside a live worktree is
  what produces the branch-mismatch refusal.
- An in-place `--no-worktree` workflow records `branch: ""`, which is treated as
  "unpinned": task identity still has to match, but there is no branch to compare
  against.

### When you get a refusal

| Refusal | Recovery |
|---------|----------|
| `<task> lives in … — use the orchestrator that owns that worktree` | Switch to the session running that bead (session name `belayd-<taskId>`), or start it here with `belayd_start_task <taskId>`. |
| `No Belayd workflow state in …` | This directory is not a workflow yet: `belayd_start_task <taskId>` here, or run the phase where the workflow lives. |
| `this session is in detached HEAD — check out <branch> in <cwd>` | `git -C <cwd> switch <branch>`. |
| `could not read the branch here (…)` | The directory is not a git checkout (or git is missing): run from a checkout of the recorded branch. |
| `<task> owns <cwd> … run this phase from your own worktree` | This session has no active task but sits in another bead's worktree: start that bead here or move to your own tree. |

Stacked follow-up work belongs in `belayd_start_followup <taskId>` (stacks on the
current branch, records base + fork point, rebased later with
`belayd_stack_rebase`) — not in a phase call aimed at another worktree.

### Rework after the workflow completed

Post-completion rework is still allowed: with the gate off (`belayd_stop_task`)
and no `.belayd/workflow.json` at `cwd`, a phase call in that directory passes.
Any workflow file that *is* present still pins the tree to its owner, even for a
gate-off or task-less session.

### Sub-bead commits

`belayd_commit` from a `bd-42` session may pass `taskId: "bd-42.1"`. An unrelated
id (`bd-99`) is refused, and a parent id passed from a sub-bead session is
refused.

### Planning tools

`belayd_plan_scout` and `belayd_plan_research` are read-only and have no
ownership contract, but they now require a working directory; a session without
one gets `belayd_plan_scout has no working directory: this session cannot be
pinned to a worktree.` instead of silently planning against `/`.

## Migration notes

- **Drop `cwd` from phase-tool and verifier calls.** The parameter is no longer
  declared. pi validates tool arguments with a TypeBox-compiled check against the
  tool schema (`Type.Object({ task: … })`), which does not set
  `additionalProperties: false`, so an extra `cwd` key **passes validation and is
  silently ignored** — it is *not* a schema error and it does *not* redirect the
  run. Verified:

  ```bash
  node --input-type=module -e '
    import { Type } from "typebox";
    import Value from "typebox/value";
    const schema = Type.Object({ task: Type.String() });
    const args = Value.Convert(schema, { task: "x", cwd: "/tmp/elsewhere" });
    console.log(Value.Check(schema, args), JSON.stringify(args));'
  # true {"task":"x","cwd":"/tmp/elsewhere"}
  ```

  Work that relied on the old redirect must instead go through the orchestrator
  that owns the target worktree.
- `docs/proof-verifier.md` no longer lists `cwd` for `belayd_proof_verifier`;
  call it as `belayd_proof_verifier { task, proof }`.
- No `process.cwd()` fallback remains on the phase, commit, proof, or planning
  paths. The remaining `process.cwd()` fallbacks are in read-only/utility tools
  only: `belayd_status`, `belayd_archify`, `belayd_outline`, `belayd_start_task`,
  `belayd_start_followup`, `belayd_stack_rebase`.
- Library exports (`src/index.ts`): `matchOwnedWorktree`,
  `matchSessionOwnedWorktree`, `assertOwnedWorktree`, `readWorktreeBranch`,
  `isSameOrDescendantTask`, `formatWorktreePreamble`, plus their option/result
  types. The matchers are pure apart from `readWorktreeBranch` (one synchronous
  `git branch --show-current`) and `assertOwnedWorktree` (one workflow-state
  read).

## Companion: the worktree orchestrator lease (bd-126 P5)

The bd-119 preflight answers "does another **bead** own this tree?". It reads
`.belayd/workflow.json`, which cannot answer "is another **session** driving it
right now?": a completed workflow deletes that file, a failed launch leaves one
behind, and the fleet's own repair paths can move it. Two orchestrators on one
worktree therefore still passed the preflight, and that is what happened to bd-37
(a second orchestrator started while the first was running).

`src/orchestrator-claim.ts` adds the missing fact: `.belayd/orchestrator.json`, a
lease created by the spawner, adopted and renewed by the orchestrator session's own
timer (every 20 s), and removed on `session_shutdown`.

| Question | Answer from the lease |
|---|---|
| May I launch an orchestrator here? | No while the lease is fresh — the launch is refused before a session is created |
| May this session drive this workflow? | Only if it holds the lease; otherwise `session_start` refuses to arm the gate |
| Is that member still running? | Yes while the lease is renewed, even though no process carries its session token (it is a session inside the daemon) |
| May reconcile prune it? | Only when the lease is cold **and** no process carries `belayd-<taskId>` |

The full contract, including takeover of a cold lease (archived, never deleted) and
the start-grace window, is in `docs/fleet-run.md#one-orchestrator-per-worktree`.

## Related documentation

- `docs/diff-scoped-review.md` — phase-tool call shapes with `{ task }` only.
- `docs/proof-verifier.md` — verifier contract and prompt inputs.
- `docs/subagent-sessions.md` — `belayd-<taskId>` / `belayd-<taskId>-sub-<phase>-…`
  session naming, used to find the owning orchestrator.
- `docs/fleet-run.md` — the worktree lease that keeps one orchestrator per worktree.
- `docs/model-capacity-and-telemetry.md` — per-cwd telemetry and run manifests
  under `.belayd/runs/`.
