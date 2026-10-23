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
2. **acquire** — atomically create `<fleetDir>/merge.lock.d`. A live lease from
   another supervisor is refused ("held by X until T"); an expired lease is
   acquirable.
3. **stash a dirty root** — `git stash push --include-untracked`, the stash
   **sha** recorded and audited (an unverifiable ref fails the step).
4. **rebase** the member branch onto the base in the member worktree. A conflict
   is aborted (`git rebase --abort`), so the member's commits are unchanged; a
   failed abort is warned instead of leaving an unexplained "rebase in
   progress".
5. **gates** — the target's `package.json` scripts (`test`, `test:integration`,
   `typecheck`, `lint`, `build` — whichever exist) run against the rebased result
   in the member worktree, through the target's own package manager. The lease is
   renewed before each one.
6. **merge** — `git merge --ff-only <memberBranch>` in the root, after
   re-verifying that the root is still on the base branch (a branch switch during
   the gates refuses with `root-not-on-base` instead of moving that branch).
7. **restore** the stashed root immediately: `git stash apply <sha>` (refusing if
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
   an assumed `feat/<id>`) does not yet contain the new commit.
9. **release** the lock (record cleared, directory removed).

Every step is audited (see the table in `docs/fleet-orchestrator.md`).

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
| `gate \`<runner> run <name>\` failed …` | merge aborted; root unchanged, member unmerged, lock released |
| `restore-conflict` + parking | the merge landed but restoring the root conflicted: the fleet is parked, the stash still holds the work, and the report names the ref |
| `no-queued-entry` | nothing to drain (exit code 0, not an error) |
| `lock-unavailable` | another supervisor holds a live lease, or an orphaned primitive is inside its grace window |
| `root-not-own-checkout` / `root-not-on-base` | run the drain from the root on the base branch |
| `member-worktree-dirty` | commit or discard the member's working-tree changes first |

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
