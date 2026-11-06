# Fleet merge queue (`belayd_fleet_merge`, bd-126 P2)

One supervisor tool that lands a finished member branch on the fleet's base
branch — explicitly, one member at a time, in the operator's own checkout. It is
milestone **P2** of `docs/fleet-orchestrator.md`; P3 orders *launches*, not the
merge queue, and P4 supplies the pause flag this drain refuses on plus the
`belayd_fleet_reconcile` repair path (`docs/fleet-reconcile.md`). Nothing merges
unless an operator queues it and then drains it. Operator entry point for the
whole surface: `docs/fleet.md`.

What it guarantees:

- **single-flight**: one merge at a time, enforced by an atomic
  `mkdir merge.lock.d`, with a renewable lease as the only crash-recovery
  authority (never a pid guess);
- **safe root handling**: a dirty root is stashed and restored by its **recorded
  sha** (never `stash@{0}`, so a stash the operator pushes mid-drain survives);
  the root's branch is re-verified before every mutation, and a conflicting or
  unsafe restore **parks the fleet** and keeps the stash instead of losing work;
- **honest gates**: the project's own `package.json` scripts run against the
  rebased result, through the package manager the target declares
  (`packageManager`, else its lockfile, else `npm`); a failing gate aborts the
  merge;
- **a live holder is never deposed**: the per-command timeout (25 min) is below
  the 30 min lease, and the lease is renewed before every gate;
- **merging ≠ closing**: the bead stays `in_progress` + `human`, and no `bd` call
  is made at all.

- [How to Use](#how-to-use)
  - [When to reach for it](#when-to-reach-for-it)
  - [Enqueue](#enqueue)
  - [Drain](#drain)
  - [Reading the result](#reading-the-result)
  - [What it will not do](#what-it-will-not-do)
  - [Common situations](#common-situations)
- [How to Verify](#how-to-verify)
  - [1. Gates](#1-gates)
  - [2. Drive it against a scratch fleet](#2-drive-it-against-a-scratch-fleet)
  - [3. The tests that pin it](#3-the-tests-that-pin-it)

## How to Use

### When to reach for it

| Situation | Reach for |
|-----------|-----------|
| "bd-12 is done; merge it into main." | `belayd_fleet_merge` `{ action: "enqueue", task: "bd-12" }`, then `{ action: "drain" }` |
| "What is waiting to merge, and is anything merging?" | `{ action: "list" }` |
| "A drain failed on a gate; I fixed it and want to retry." | `{ action: "enqueue", task: "bd-12" }` (a `failed` entry becomes `queued` again), then drain |
| "The fleet is parked after a stash conflict." | run `belayd_fleet_reconcile`: it retries the restore from the recorded sha (only while the root is on the base branch), drops it after a verified match, and unparks — or reports exactly what blocks it. If the stash is already back by hand, `belayd_fleet_resume force` clears the park and leaves the stash. Details: `docs/fleet-reconcile.md` |

Run it from the fleet supervisor session, whose cwd must be the repository
**root** checkout (a linked worktree is refused: only the root holds the base
branch).

### Enqueue

```json
{ "action": "enqueue", "task": "bd-12" }
```

The tool reads the member's worktree (`feat/<id>`) and queues the branch it
actually has checked out. Requirements: the task is a member of this fleet and
its worktree exists. Re-enqueueing an active entry is idempotent; an already
merged entry is refused; a `failed`/`parked` entry is queued again with its
attempt count preserved.

`enqueue` never merges, never rebases, and never touches the root. It writes
`merge-queue.json` and audits `merge-enqueued`.

### Drain

```json
{ "action": "drain", "task": "bd-12" }
```

`task` is optional: omitted, the oldest `queued` entry is drained. The tool then
runs the documented sequence:

1. **preconditions** — fleet not paused; root is the repository's own checkout on
   the base branch; member worktree is on the queued branch and clean. Any failure
   is refused **before** a mutation and leaves the entry `queued`.
2. **publish payload** — `git diff --name-only --diff-filter=ACMRT <base>...<branch>`
   is checked by `evaluatePublishGate` (`src/publish-gate.ts`, bd-181) before the
   lock, the stash, or the rebase. A payload that still carries proof (proof
   artifacts that are **added or modified**) refuses with
   `proof-artifacts-in-diff`; harness-local, absolute, traversal, backslash or
   non-ASCII (lookalike) paths refuse with `paths-outside-scope`; an unreadable
   diff refuses with
   `publish-payload-unreadable`. **Deleting** proof artifacts is allowed — that is
   the migration: upload the proof, keep the receipt, `git rm -r docs/proof`. A
   repo whose own policy keeps *text* proof in git overrules the proof half of this
   check by declaring `proof.artifacts: "in-tree"` (see [Repo proof
   policy](#repo-proof-policy-bd-276)); every other predicate still applies. The
   one-line refusal text is bounded (10 paths,
   then a `(+N more)` pointer naming `paths`), and the drain result carries the
   complete sorted list as `paths`, which `belayd_fleet_merge` renders as
   `Refused paths (N):` lines. The diff is branch-scoped, so proof directories
   already in history are not migrated — proof carried in is stopped, proof
   removed is allowed. `--diff-filter=ACMRT` is what excludes deletions; a
   rename is still reported (as its destination path), so renaming proof content
   out of a proof directory is refused.
3. **acquire** — atomically create `<fleetDir>/merge.lock.d`. A live lease from
   another supervisor is refused ("held by X until T"); an expired lease is
   acquirable.
4. **stash a dirty root** — `git stash push --include-untracked`, the stash
   **sha** recorded and audited (an unverifiable ref fails the step).
5. **rebase** the member branch onto the base in the member worktree, then
   **classify** a failure before acting on it (see [Rebase failure
   classification](#rebase-failure-classification-bd-280)): a mechanical failure
   is cleared and retried once, derived paths are regenerated, a conflict a living
   member can resolve is delegated to it with a `rebase-hint`, and only a genuine
   contradiction (or an unreadable failure) stops the member. Every class aborts
   or finishes the stopped rebase, so no path leaves the worktree mid-rebase.
6. **gates** — the target's `package.json` scripts (`test`, `test:integration`,
   `typecheck`, `lint`, `build` — whichever exist) run against the rebased result
   in the member worktree, through the target's own package manager. The lease is
   renewed before each one.
7. **merge** — `git merge --ff-only <memberBranch>` in the root, after
   re-verifying that the root is still on the base branch (a branch switch during
   the gates refuses with `root-not-on-base` instead of moving that branch).
8. **restore** the stashed root immediately: `git stash apply <sha>` (refusing if
   the sha no longer resolves, the root is no longer this repository's own
   checkout, or it moved off the base branch), then `git stash drop` of exactly
   that entry. The drop is **cross-checked**: the position is verified immediately
   before the drop, the sha git reports as dropped is compared with the recorded
   one, and a re-list proves the recorded entry is gone. An interloper `stash push`
   that shifts the index between verify and drop is therefore warned about and
   audited (`merge-stash-drop-mismatch`) instead of silently dropping the wrong
   entry. A conflicting restore records `park { reason, stashRef, recordedAt }` in
   `fleet.json`, which is what `belayd_fleet_reconcile` restores from.
8. **broadcast** `base-moved` and `sibling-landed` to remaining members, plus a
   `rebase-hint` to members whose **actual** branch (from git's worktree list, not
   an assumed `feat/<id>`) does not yet contain the new commit. Each recipient is
   recorded in the result as soon as its note file is written, so a fan-out that
   threw or stopped on one member's unwritable directory can be resumed with
   exactly the members it missed. When the merge commit itself cannot be read, the
   hint is **not** derived from `merge-base --is-ancestor "" <branch>` (which fails
   for everyone and would turn a git error into a hint by accident): the drain takes
   an explicit "unreadable base commit" branch that hints every remaining member,
   skips the probe, and says so in a result warning and in the `rebase-hint` audit
   detail (bd-280 S8).
9. **release** the lock (record cleared, directory removed).
Every step is audited (see the table in `docs/fleet-orchestrator.md`).

### Rebase failure classification (bd-280)

A failed rebase is not automatically a dead member. The drain reads the stopped
rebase (`git status --porcelain -z` for the unmerged paths, `git log` for the
commits that touched each one) and classifies it **before** deciding
(`src/fleet-rebase-recovery.ts`):

| Class | Detect | Action |
|-------|--------|--------|
| Not a conflict | non-zero exit, no conflicted paths | clear the stale rebase state (abort only if a rebase is actually in progress), then retry `git rebase <base>` **once**; a retry that fails is classified like any other failure and never retried again |
| Generated/derived | every conflicted path is a lockfile, a build tree (`dist/`, `node_modules/`, `coverage/`, …), a root `build/`/`out/`/`result/`, or a snapshot | take the **base** side of those paths (`git checkout --ours`, which during a rebase is the base), regenerate (`<runner> install`, then the target's `build` script), `git add`, `git rebase --continue`; a failing step aborts the rebase and stops with the paths and that step named |
| Contradiction | a conflicted path was also touched by a base-side commit at/after the fleet's `createdAt` | abort, park the entry `failed` with both sides' commits and every conflicted path in the detail; the bd-279 escalation gate opens on the next tick. A sibling is **named** only when the run record proves one landed (`run.members[].landedAt`); otherwise the text says base work committed after the fleet started |
| Delegable | the base-side work predates the fleet and the member's lease was live at the tick | abort, send that member a `rebase-hint` asking it to resolve the conflict and re-run its own gates, and do **not** stop it (except after the delegation grace below). If the hint cannot be written the drain stops instead: a member that was never asked cannot be expected to act |
| Unknown | none of the above | abort and stop as before, with the git error and the conflicted paths recorded |

Why the rules are what they are:

- **Committer time is the attribution signal.** A sibling's commits reach the base
  only through this drain's rebase plus `--ff-only` merge, so their committer date
  falls inside the fleet's lifetime, while base work that predates the fleet is
  older than `fleet.json#createdAt`. With no `createdAt` the drain never claims a
  contradiction. A mixed contradiction/pre-existing conflict is a contradiction: a
  person decides which work wins. The **stop** direction is unaffected by the
  evidence, but the **story** is: a person can commit to the base during a fleet,
  so the text names a sibling only when `run.members[]` proves that member landed
  — otherwise it says "base work committed after this fleet started" and names the
  commit instead of an owner.
- **Only derived content is regenerated.** A source conflict is never resolved with
  `-X ours`/`-X theirs`; a generated path is an artifact of a command, so its base
  side is recreated from the base's manifest. A **snapshot** is taken from the base
  side and the project's own gates then decide whether it is still correct — an
  updated snapshot is never silently accepted. Only unambiguous artifact trees are
  matched at any depth; `build`/`out`/`result` count at the repository root only,
  because a nested `src/out/` is authored code.
- **One recovery, one retry.** Clearing the stale state is the new information the
  "never retry an unchanged base" rule needs. There is exactly one retry per drain
  and no loop; a retry that fails is **re-classified** (a retry conflicting on a
  lockfile regenerates it, a delegable one delegates) and never retried a second
  time. `.git/index.lock` is never deleted — a live member process can hold it, and
  removing a live lock is how concurrent writers corrupt an index.
- **One delegation per attempt, and only when the member was told.** The entry stays
  `failed` with a `delegatedAt` marker. A later landing holds while the member's
  branch does not yet contain the base (`checkMemberBranchContainsBase`, compared by
  sha rather than an exit code) instead of re-running the same rebase; the next
  `rebasing` transition clears the marker, so a retry only happens once the member
  has rebased. An **unreadable** branch verdict is a hold too: falling through to a
  drain would rewrite `delegatedAt` and re-send the hint every tick, so a
  permanently failing probe would starve the grace window and the member would never
  be stopped. If that `failed` transition cannot be written the drain does **not**
  report a delegation — it stops with the paths instead, because a marker nothing
  records would re-run the whole rebase on every acting tick. A delegation also
  carries its complete conflicted path list (`delegated.paths`), so the operator
  sees every path even when the one-line text is bounded. The hold is not an
  **action** (it re-schedules at the normal tick interval and keeps growing the
  run's idle counter rather than resetting it), and it is **bounded**: after
  `FLEET_REBASE_DELEGATION_GRACE_MS` (30 min) with the member's branch still
  behind, the member is stopped `land-failed` with a detail saying when it was asked
  — nobody alive is deciding by then, so a person is the right answer. If the
  `rebase-hint` itself cannot be written, the drain stops immediately: a member that
  was never asked cannot be expected to act, and waiting the grace out first would
  only delay the same stop.

Any class that cannot finish the rebase aborts it, and the losing-lock exit does too
(it clears the stopped rebase *before* returning the lock failure), so `git status`
is clean and the member branch is unchanged when the drain returns. A seam that
**throws** instead of returning a value is caught at the drain boundary — in the
merge sequence *and* in the finishers (`restoreRootStash`, `parkFleet`,
`broadcastBaseMoved`, the queue transition) — so the drain resolves with a result
and never rejects. The attempt is audited as `merge-step-threw` and the lock is
released exactly once (the release is idempotent). Two facts survive such a throw:
- **A landed merge stays landed.** `context.mergeCommit` is set by the fast-forward
  itself; when it is present the entry is re-asserted as `merged` (idempotently) and
  the result is a `step-failed` refusal whose text says the member *merged* at that
  sha and names the post-merge step that threw. The member is never downgraded to
  `failed`. Two consequences make that arm complete rather than a bare report:
  - **The landed audit is written once.** If the throw hit before
    `finishSuccessfulDrain`'s own `merge-completed` entry (a step between the
    fast-forward and the finishers), the landed arm writes it before the
    `merge-step-threw` entry, naming the merge commit — or "an unreadable sha" when
    HEAD could not be read. The marker is a per-attempt flag
    (`context.mergeCompletionAudited`), deliberately **not** the queue entry: the
    entry's own writes are best-effort, so it reads `merging` when the `merged`
    transition failed and `merged` when the audit append that follows it failed —
    exactly the two cases where an entry-keyed marker duplicated or lost the entry.
    The flag is set only when the append returned success, so a failed append is
    retried once by the landed arm (the failure is a warning), and every landed arm
    consults the same flag, so one merge yields exactly one `merge-completed`.
  - **The base-move broadcast is best-effort, not skipped.** The merge already moved
    the base, so the remaining members need their `base-moved`/`sibling-landed`/
    `rebase-hint` notes whether or not the drain finished cleanly; the landed arm
    attempts the fan-out in its own guard, and a throw (or a partial fan-out) there
    is a **warning** on the returned result — never a second failure and never a
    rejected promise, because the throw may come from the same seams the fan-out
    uses. Nothing in that attempt can move the entry off `merged` or re-run a merge:
    it reads git and writes notes only. Each send is narrowed to the recipients
    whose note file is **not** recorded yet, so a retry after a partial fan-out
    (one member's directory unwritable) writes exactly the missing members: nobody
    gets a second file, and nobody is skipped because a sibling was reached.
- **A known reason is not masked.** When the drain was already refusing (a gate, a
  rebase, a stash), that reason stays the result's `reason`; the throw is appended
  to its text and the `failed` state is re-asserted best-effort. A delegation whose
  `delegatedAt` write is what threw is reported as a stop, not as a delegation.

### Reading the result

```
Fleet `default`: merged bd-12 (feat/bd-12) into main at 4f2c1ab9d3e0.
- gates passed on the rebased result: test, typecheck, lint
- root work was stashed and restored (7c1f2ab…)
- notified members: base-moved → bd-15, bd-19; sibling-landed → bd-15, bd-19; rebase-hint → bd-15, bd-19
bd-12 stays in_progress + human: merging is not closing. Accept it with `wt merge` / bd when you are ready.
```

| Line / refusal | Meaning |
|----------------|---------|
| `merged <id> (<branch>) into <base> at <sha>` | the root advanced; the queue entry is `merged` |
| `root work was stashed and restored (<ref>)` | the dirty root was auto-stashed and put back |
| `rebase-failed` | the member branch cannot be rebased and the drain could not classify the failure as mechanical or delegable. The text names the class: a **contradiction** (a conflicted path was also touched by a commit that landed on the base during this fleet) names both sides' commits, the landed sibling when the run record proves one, and the bounded path list; an **unknown** failure names the git error and the paths. `paths` carries the complete conflicted list. Also used when a delegation could not be recorded |
| `rebase-delegated` | the conflict is with base work that predates the fleet and the member's orchestrator lease was live, so the drain sent that member a `rebase-hint` asking it to resolve the conflict and re-run its own gates. The member is **not** stopped and the entry stays `failed` with `delegatedAt`; a later tick holds the landing back until the member's branch contains the base. `delegated.paths` carries the complete conflicted list |
| `step-failed` | a seam threw instead of returning a failure — in the merge sequence or in a finisher. The lock is released, any stopped rebase is aborted best-effort, the attempt is audited as `merge-step-threw`, and a merge that already landed stays `merged` in the text and in the queue, keeps its one `merge-completed` entry, and still broadcasts the new base to the remaining members best-effort |
| `gate \`<runner> run <name>\` failed …` | merge aborted; root unchanged, member unmerged, lock released |
| `restore-conflict` + parking | the merge landed but restoring the root conflicted: the fleet is parked, the stash still holds the work, and the report names the ref |
| `no-queued-entry` | nothing to drain (exit code 0, not an error) |
| `lock-unavailable` | another supervisor holds a live lease, or an orphaned primitive is inside its grace window |
| `root-not-own-checkout` / `root-not-on-base` | run the drain from the root on the base branch |
| `member-worktree-dirty` | commit or discard the member's working-tree changes first |
| `proof-artifacts-in-diff` | the branch still carries proof files it *adds or modifies* (`docs/proof/`, `proof/`, `proof-of-work/`, or an accepted proof extension); upload the proof and keep the receipt at `.belayd/proof-receipt.json` instead. Deleting proof artifacts is allowed — the payload diff is read with `--diff-filter=ACMRT`, so removals never reach the gate. A repo that keeps text proof in git declares `{"proof":{"artifacts":"in-tree"}}` in `.belayd/config.json` and this refusal stops applying to it (see [Repo proof policy](#repo-proof-policy-bd-276)). The diff is NUL-delimited with `core.quotePath=false`, so paths with spaces or non-ASCII characters are classified correctly rather than as git C-quoted literals |
| `paths-outside-scope` | the payload contains harness-local (`.belayd`, `.belayd/`, `.belayd-task.json`, `proof-of-work`), absolute, traversal or backslash paths, a non-ASCII/lookalike path (refused rather than guessed; rename it to ASCII), or (when the publisher declares a payload) a path outside it |
| `publish-payload-unreadable` | the payload diff could not be computed; the drain fails closed rather than guessing |

### Repo proof policy (bd-276)

Proof artifacts are refused in a published payload by default (bd-181): they
upload to the reviewing platform and the workflow keeps a receipt at
`.belayd/proof-receipt.json`. A repository whose own policy keeps *text* evidence
in git — `docs/proof/<bead>/` READMEs, casts, transcripts, capture scripts — is
the case that default cannot express, and bd-181 deliberately left those repos
"not migrated, only stopped". Every member then refuses to land, and the refusal is
indistinguishable from a member that committed junk.

So the repository declares the policy and the drain defers to it:

```json
{ "proof": { "artifacts": "in-tree" } }
```

in `<repoRoot>/.belayd/config.json` (commit it: it is repo policy, not scratch
state — a repo that ignores `.belayd/*` needs `!.belayd/config.json`).

| Value | Effect on the drain |
|---|---|
| `forbid` (default, and what an absent or unusable declaration resolves to) | a payload carrying proof refuses with `proof-artifacts-in-diff` |
| `in-tree` | proof paths are ordinary content: the proof refusal is skipped and a landing that carried any reports `carried N proof artifact path(s) under the repo policy proof.artifacts=in-tree: …` in its warnings |

Under `in-tree`, every other predicate is unchanged: harness-local paths
(`.belayd`, `.belayd-task.json`, `proof-of-work`), absolute, traversal, backslash
and non-ASCII/lookalike paths still refuse, and a publisher that declares a payload
still refuses proof outside it.

It is read **live, per drain, from the repo root** — never frozen into the intent —
because it describes what the repository is. Declaring it mid-run therefore applies
to members already in flight, which is the point: it is the transition guard for a
repo that has not migrated.

A declaration that does not parse (wrong value, misspelled key, non-object) is a
warning plus the strict default, never a launch abort. `pr`/`push` publishing must
keep the strict refusal whatever the repo declares, because a published PR is not
the repository.

### What it will not do

- **No ordering/parallelism inside the queue.** Merges are explicit, one at a
  time, in enqueue order. P3 orders *launches* (see `docs/fleet-launch.md`), not the
  merge queue. Draining is one explicit call per member.
- **No automatic pause or repair.** `belayd_fleet_pause` writes the flag a drain
  refuses on, and `belayd_fleet_reconcile` repairs the queue (expired lease, record
  without primitive, orphaned directory, stuck entry) — under the same
  `merge.lock.d` primitive, never a second lock. See `docs/fleet-reconcile.md`.
- **No `bd` mutation.** Merging is not closing; there is no bd seam in
  `src/fleet-merge.ts`.
- **No merge outside the root**, and no merge when the root is a linked worktree.
- **No silent stash loss.** A conflicting restore parks the fleet and keeps the
  stash; nothing is discarded.
- **No auto-resolved source conflict.** A rebase conflict is never resolved with
  `-X ours`/`-X theirs`; only generated/derived paths (lockfiles, build trees,
  snapshots) may be regenerated from the base side, and the recovery retry is
  bounded to one.
- **No phase work.** The supervisor still arms no gate and refuses the phase,
  proof, and commit tools.

### Common situations

| Symptom | Cause / action |
|---------|----------------|
| `no worktree is checked out for feat/bd-12` | the member was not launched, or its worktree was removed; enqueue only after it exists |
| `merge lock is held by … until …` | another drain is in flight. Wait for it, or for the lease to expire if that supervisor died (pid is never used for takeover) |
| `… exists without a lock record` | a holder is inside the acquire window or crashed before writing its lease; retry after ~30 s, or remove `merge.lock.d` by hand |
| `fleet … is paused (…)` | an operator paused it, or a previous restore conflict parked it. For a park: run `belayd_fleet_reconcile` (restores the recorded sha, then unparks) and/or `belayd_fleet_resume`. For an operator pause: `belayd_fleet_resume` |
| `gate … failed` | fix the branch, re-enqueue it (state returns to `queued`), drain again |

## How to Verify

### 1. Gates

```bash
pnpm test && pnpm test:integration
pnpm typecheck && pnpm lint && pnpm build
```

### 2. Drive it against a scratch fleet

Never experiment against the real repository root. Create a throwaway repo:

```bash
root=$(mktemp -d)
git -C "$root" init -q
git -C "$root" symbolic-ref HEAD refs/heads/main
git -C "$root" config user.email t@example.invalid
git -C "$root" config user.name Test
printf '{"scripts":{"test":"true","typecheck":"true"}}' > "$root/package.json"
git -C "$root" add -A && git -C "$root" commit -qm base
git -C "$root" worktree add -q -b feat/bd-12 "$root.feat-bd-12"
mkdir -p "$root/.git/belayd/fleet/default"
printf '%s' '{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12"],"createdAt":1,"updatedAt":1,"baseBranch":"main"}' \
  > "$root/.git/belayd/fleet/default/fleet.json"
```

Then, from a supervisor session whose cwd is `$root`, enqueue `bd-12` and drain
it. Confirm: `git -C "$root" log --oneline` gained the member commit,
`merge-queue.json` shows `merged` with `lock: null`, `merge.lock.d` is gone, and
`audit.log` contains `merge-acquired`, `merge-completed`, `merge-released`, and no
`bd` action.

To see the parked path, dirty `$root` with a change to a file the member also
changed, drain again, and confirm: `fleet.json` has `"paused": true`, a `note`
containing `refs/stash`, and `park.stashRef` equal to the reported ref;
`git -C "$root" stash list` is non-empty, the root is clean, and `audit.log` has
`merge-restore-conflict` + `fleet-parked`. Then `belayd_fleet_reconcile` restores
it and unparks (`fleet-unparked`).

### 3. The tests that pin it

`src/__tests__/fleet-merge.test.ts`:

- lock: two concurrent acquires, expired-lease takeover, foreign release refused,
  renewal extends the lease, orphan directory/record diagnostics — all against the
  **real** `mkdir` primitive in a temp dir;
- sequence, against real `git init` fixture repos: happy path, failing gate, dirty
  root stash/restore, restore-conflict parking, conflicting rebase abort, dirty
  member refusal, wrong-branch/linked-worktree root refusal, paused fleet;
- rebase failure classification (bd-280): a no-conflict failure is cleared and
  retried exactly once and the merge then completes; a retry that fails again stops
  with `rebase-failed` and no third attempt; a lockfile-only conflict is
  regenerated through the injected `regenerate` seam and the merge continues; a
  regeneration that fails aborts and stops naming the step; a conflict with a
  sibling's landed commit stops as a contradiction naming both commits and the
  conflicted path; the same conflict with a live member lease and pre-existing base
  work is delegated (`rebase-delegated`, queue entry `failed` with `delegatedAt`,
  exactly one `rebase-hint` note); a stale lease on that conflict stops as
  `unknown`; every class leaves `git status` clean and the member branch untouched,
  with no rebase left in progress. Review fixes add: a stopped rebase is cleared
  even when the lease is lost before the recovery retry (no worktree handed on
  mid-rebase); a recovery retry that conflicts on a generated path is re-classified
  and regenerated instead of stopping as `unknown` (two `merge-rebase-classified`
  audit entries); the contradiction text names a landed sibling only when the run
  record proves one; a delegation the queue cannot record stops with the paths
  instead of claiming it; a `rebase-hint` that cannot be written stops immediately;
  and a throwing `regenerate` seam still releases the lock, clears the rebase, and
  returns `step-failed`. A second review fix pass adds: a finisher that throws after
  the merge still resolves, keeps the entry `merged`, releases the lock, and says the
  merge happened; a step that throws between the fast-forward and the finishers is
  reported the same way (`merged … at an unreadable sha`); a `restoreRootStash` that
  throws on the failure path keeps the gate's `gate-failed` reason and records
  `failed`; a delegation whose branch probe cannot answer is held (no second drain,
  no second hint, `delegatedAt` unchanged) until the grace expires; and the W3
  downgrade writes exactly one `merge-rebase-failed` audit entry with the final text.
  A third review fix pass adds: a finisher that throws after the merge still sends
  `base-moved`/`sibling-landed`/`rebase-hint` to two remaining members and keeps the
  entry `merged`; a broadcast whose branch probe throws becomes a warning on the
  landed result (resolved, `merged`, and the two kinds already sent are not repeated);
  the post-merge-throw fixture records exactly one `merge-completed` and one
  `merge-step-threw`, the pre-finisher throw (an unreadable HEAD) records its single
  `merge-completed` with "an unreadable sha", and the normal success path still has
  exactly one `merge-completed`.
  A fourth review fix pass adds: a refused `merged` transition plus a later finisher
  throw still yields exactly one `merge-completed` (the entry stays `merging`); an
  audit append that fails on the success path is retried by the landed arm (one
  `merge-completed` in the log plus the honest warning); a partial fan-out (bd-19's
  note writes refused twice) is resumed with only that member, so every member has
  exactly one file of each kind; and an unreadable HEAD hints every remaining member
  through the explicit branch, with the reason in the audit detail and a result
  warning.
- `"does not mutate this repository: a full merge run changes only the fixture"`
  snapshots this repository's HEAD, branch, status, **every ref**
  (`for-each-ref`), `refs/stash`, and the stash list before and after a real P2
  merge run and asserts they are unchanged;
- review hardening: the root branch is re-verified before the fast-forward (a
  branch switch mid-gates refuses with `root-not-on-base`, moves nothing, and
  keeps the stash), the recorded stash sha is restored and dropped while an
  interloper `stash@{0}` survives, an unverifiable stash ref fails the step, the
  live clock stamps each step, the lease is renewed between gates, a poisoned
  `GIT_DIR` cannot redirect the root commands, a failed post-conflict reset and a
  failed `rebase --abort` are warned, a non-convention member branch gets no
  spurious rebase-hint, a missing `fleet.json` is never resurrected by parking,
  and the gate runner is derived from `packageManager`/lockfile with an npm
  fallback;
- enqueue validation, idempotence, and "no `bd` command was run by any seam"
  (merging ≠ closing).

`src/__tests__/fleet-rebase-recovery.test.ts` (pure): porcelain `-z` parsing
(unmerged pairs, renames, paths with spaces/non-ASCII), generated-path detection
with its near misses (including the root-only `build`/`out`/`result` trees), the
five classes and their precedence (including "no `createdAt` never claims a
contradiction", a mixed sibling/pre-existing conflict, and a landed sibling named
only when the run record proves one), the two contradiction wordings, and the
bounded stop text (commits first, five paths then `(+N more)`) plus the bounded
durable path detail (count first, whole paths only).

`src/__tests__/extension-fleet-p1.test.ts` (wiring): a land tick whose drain
delegates records no `land-failed` stop, keeps the member in `taskIds`, and the
next tick holds instead of re-draining while the member's branch still lacks the
base; a delegation aged past its grace stops the member for a human; and a
delegation with more than five conflicted paths still records every path in the
`fleet-land-delegated` audit detail.
