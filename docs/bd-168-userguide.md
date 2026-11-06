# Fleet state lifecycle: attribution, fleet-scoped status, landing cleanup, lease-aware stalls, landed slots (bd-168)

Four defects in the same fleet/supervisor bookkeeping family, plus one extra
observation recorded in the bead's NOTES:

1. **#2 — a finished workflow could not be attributed.** Completion clears
   `.belayd/workflow.json`, so a member that had finished every phase read as
   `Member (no task id) — missing-state` and `belayd_fleet_merge` could not enqueue
   it; a human had to supply the id.
2. **NOTES (5th observation) — one status call described two fleets.**
   `belayd_fleet_status fleetId=wave4` printed a `wave4` header but listed the
   `default` fleet's members and attributed the capacity block to `default`.
3. **#3 — a drain did not remove the merged worktree**, although the tool
   contract and the docs claimed it did. Every landed worktree stayed, 0 commits
   and 0 dirty files, ready to resurrect a merged branch from a stray commit.
4. **#4 — a healthy run was halted `stalled`.** A detached member working inside
   one long phase never changed its progress signature, so 240 ticks of healthy
   work ended the run.
5. **#1 residual — a clean landing destroyed its own evidence.** A landing removes
   the worktree *and* the branch, so `pruneDeadMembers` refused with "no worktree
   for bd-279, and no proof one ever existed" and the slot was held forever; the
   only other lever, `belayd_fleet_release`, refused for a dead fleet that was not
   this session's own, so operators hand-edited `fleet.json`.

| What decides | Where |
|---|---|
| Attribution `workflow` → `worktree` → `runs`, plus `taskIdSource` | `src/fleet-status.ts` `attributeMember`, `attributionCandidates`, `unattributedMember` |
| The new `complete-unlanded` state and the landing commands | `src/fleet-status.ts` `deriveMissingStateMemberState`, `missingWorkflowWarning`, `formatLandingCommands` |
| One no-state completion rule shared by status and the tick | `src/fleet-run.ts` `missingStateRunVerdict`, `fleetFinalPhase`, `FLEET_DEFAULT_FINAL_PHASE` |
| Fleet scoping (`members` vs `otherWorktrees`, `not-a-member`) | `src/fleet-status.ts` `partitionByFleet`, `otherWorktreeWarnings` |
| Landing release + worktree/branch removal | `src/fleet-merge.ts` `applyLandingCleanup`, `recordMergedRelease`, `removeLandedWorktree`, `branchPresenceOf` |
| Lease-aware stall decision | `src/fleet-run.ts` `stallOrLiveWait`, `formatLeaseEvidence`, `FLEET_RUN_MAX_LIVE_IDLE_TICKS` |
| A recorded landing as positive evidence | `src/fleet-run.ts` `memberWorktreeExisted`, `memberHoldsCapacity` (`src/fleet-capacity.ts`) |
| Releasing a provably dead foreign fleet's member | `extensions/capabilities/fleet.ts` `resolveReleaseTarget`, `auditFleetRelease` |

## How to Verify

Everything runs from the repository root of this checkout. The probe scripts
below import the TypeScript sources through `jiti`, so no build step is needed.

### 1. Gates

```bash
pnpm test              # exit 0, no failed tests
pnpm test:integration  # exit 0, no failed tests
pnpm typecheck         # tsc --noEmit — no output
pnpm lint              # biome check . — no fixes
pnpm build             # tsc — no output
```

`pnpm test` includes the project-context budget case that bd-168 had to repair
(`AGENTS.md` was 491 bytes over the 12288-byte bound on the base branch, bd-286);
with the trim it passes:

```bash
wc -c AGENTS.md        # 12257 AGENTS.md
node_modules/.bin/vitest run src/__tests__/pi-manifest.test.ts -t "project context budget"
# 4 passed | 9 skipped
```

### 2. The regression tests that pin each workstream

Run one suite directly (`vitest` positional filters, no `--`):

```bash
node_modules/.bin/vitest run src/__tests__/fleet-status.test.ts   # 157 tests
node_modules/.bin/vitest run src/__tests__/fleet-run.test.ts      # 134 tests
node_modules/.bin/vitest run src/__tests__/fleet-merge.test.ts    #  94 tests
node_modules/.bin/vitest run src/__tests__/fleet-launch.test.ts   #  75 tests
node_modules/.bin/vitest run src/__tests__/fleet-accept.test.ts   #  10 tests
node_modules/.bin/vitest run src/__tests__/extension-fleet-p1.test.ts  # 167 tests
node_modules/.bin/vitest run src/__tests__/fleet-status.test.ts \
  -t "attribution through workflow archival"   # 7 passed | 150 skipped
```

| Workstream | File | Case to look for |
|---|---|---|
| Attribution through archival | `src/__tests__/fleet-status.test.ts` `describe("attribution through workflow archival (bd-168)")` | `keeps a finished member attributable and names the landing commands`, `attributes a state-less worktree from its own run manifests when the branch cannot`, `keeps a genuinely anonymous worktree's old wording and no id` |
| One no-state completion rule (tick **and** status) | `src/__tests__/fleet-run.test.ts`, `src/__tests__/fleet-status.test.ts` | `does not land when a failed re-run follows the completed final phase (bd-168 W2)`, `reports blocked when a failed re-run follows the completed final phase (bd-168 W2)` |
| A gate never turns finished work into a person-wait | `src/__tests__/fleet-status.test.ts`, `src/__tests__/fleet-run.test.ts` | `keeps complete-unlanded out of a gate-driven human wait (bd-168 W3)`, `keeps a state-less completed member landable even with an open human gate (bd-168 W3)` |
| Fleet-scoped status | `src/__tests__/fleet-status.test.ts` | `describes one named fleet and keeps other worktrees visible outside members` |
| Landing cleanup | `src/__tests__/fleet-merge.test.ts` | `rebases, gates, fast-forwards the root, broadcasts, and releases the lock` (asserts `existsSync(memberPath) === false`), `records a merged member's landing release (bd-168)`, `reports a refused worktree removal without failing the drain (bd-168)`, `reports cleanup honestly when branch deletion throws after removal (bd-168 W4)`, `reports an unverifiable branch probe as unknown, never as gone (bd-168 W1)`, `reports a branch that disappeared as already gone, not kept (bd-168 S1)`, `classifies a refusal by the re-probe, not by a 'not found' branch name (bd-168 R3 W1)`, `reports an unanswered re-probe after a refusal as unverified (bd-168 R3 W1)`, `reports a real branch-delete refusal as kept (bd-168 S1)`, `does not leave a phantom release for an already-pruned member (bd-168 S3)` |
| Accept after the drain already removed the tree | `src/__tests__/fleet-accept.test.ts` | `still closes the bead after a drain already removed the worktree (bd-168)` |
| Lease-aware stall | `src/__tests__/fleet-run.test.ts` | `does not call a lease-renewing member stuck at the ordinary idle cap (bd-168)`, `halts a fresh-lease run at the separate live cap, stating the lease evidence`, `halts when one in-flight member has no live lease, naming both kinds of evidence` |
| Landed slot / prune / release | `src/__tests__/fleet-run.test.ts`, `src/__tests__/fleet-launch.test.ts`, `src/__tests__/fleet-status.test.ts`, `src/__tests__/extension-fleet-p1.test.ts` | `bd-168: a landing the run recorded proves the worktree existed`, `skips a landed member even when its liveness is unknown (bd-168)`, `bd-168: a recorded landing is absent even with no worktree and no branch`, `W1: prunes a landed member whose clean landing removed the worktree and branch (bd-168)`, `releases a dead foreign fleet's member through the audited recovery path (bd-168)`, `refuses to release a foreign fleet's member while its supervisor is live` |

### 3. Two probe scripts

**Status.** Prints `belayd_fleet_status`'s rendering for a directory plus the raw
attribution fields, so an assertion does not depend on prose:

```bash
repo=$PWD
J=$repo/node_modules/.bin/jiti

cat > /tmp/bd168-status.ts <<'TS'
// usage: jiti bd168-status.ts <harness-checkout> <cwd> <fleetId>
const [repo, cwd, fleetId = "default"] = process.argv.slice(2);
if (repo === undefined || cwd === undefined) throw new Error("usage: <repo> <cwd> [fleetId]");
const { readFleetStatus, formatFleetStatus } = await import(`${repo}/src/fleet-status.ts`);
const result = readFleetStatus({ cwd, fleetId });
if (!result.ok) {
  console.error(`read failed: ${result.error}`);
  process.exit(1);
}
const status = result.value;
console.log(formatFleetStatus(status));
console.log("\n--- fields ---");
console.log(
  JSON.stringify(
    {
      members: status.members.map((member) => ({
        taskId: member.taskId,
        taskIdSource: member.taskIdSource,
        state: member.state,
      })),
      otherWorktrees: status.otherWorktrees,
      capacity: status.capacity,
    },
    null,
    2,
  ),
);
TS
```

**Drain.** The same `drainFleetMerge` engine `belayd_fleet_merge action=drain`
runs, against a throwaway repository, with a passing gate runner. The tool wrapper
itself is supervisor-only (it needs a session that is the fleet's live
supervisor), which is why the engine is called directly here:

```bash
cat > /tmp/bd168-merge.ts <<'TS'
// usage: jiti bd168-merge.ts <harness-checkout> [--refuse-remove]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.argv[2];
if (repo === undefined) throw new Error("usage: <repo> [--refuse-remove]");
const refuseRemove = process.argv.includes("--refuse-remove");

const { drainFleetMerge, enqueueFleetMerge, defaultFleetMergeGitRunner } = await import(
  `${repo}/src/fleet-merge.ts`
);
const { fleetAuditLogPath } = await import(`${repo}/src/fleet-state.ts`);

const git = (cwd, argv) => execFileSync("git", argv, { cwd, encoding: "utf8" }).trim();
const root = mkdtempSync(join(tmpdir(), "bd168-merge-"));
git(root, ["init", "-q"]);
git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
git(root, ["config", "user.email", "t@example.invalid"]);
git(root, ["config", "user.name", "Test"]);
writeFileSync(
  join(root, "package.json"),
  JSON.stringify({ name: "fixture", scripts: { test: "vitest", typecheck: "tsc", lint: "biome" } }),
);
writeFileSync(join(root, "README.md"), "base\n");
git(root, ["add", "-A"]);
git(root, ["commit", "-qm", "base"]);

const memberPath = `${root}.feat-bd-12`;
git(root, ["worktree", "add", "-q", "-b", "feat/bd-12", memberPath]);
writeFileSync(join(memberPath, "WORK.md"), "member work\n");
git(memberPath, ["add", "-A"]);
git(memberPath, ["commit", "-qm", "member bd-12"]);

const commonDir = join(root, ".git");
const fleetId = "default";
mkdirSync(join(commonDir, "belayd", "fleet", fleetId), { recursive: true });
writeFileSync(
  join(commonDir, "belayd", "fleet", fleetId, "fleet.json"),
  JSON.stringify({ schemaVersion: 1, fleetId, taskIds: ["bd-12"], createdAt: 1, updatedAt: 1, baseBranch: "main" }),
);
const queued = enqueueFleetMerge({
  gitCommonDir: commonDir,
  fleetId,
  sessionId: "supervisor-session",
  taskId: "bd-12",
  branch: "feat/bd-12",
  now: 1000,
});
if (!queued.ok) throw new Error(`enqueue failed: ${queued.error}`);

const refusingGit = async (argv, options) => {
  if (refuseRemove && argv[0] === "worktree" && argv[1] === "remove") {
    return { ok: false, error: "fatal: cannot remove: working tree is dirty", stdout: "", stderr: "" };
  }
  return defaultFleetMergeGitRunner(argv, options);
};
const result = await drainFleetMerge({
  gitCommonDir: commonDir,
  fleetId,
  sessionId: "supervisor-session",
  pid: 4242,
  rootCwd: root,
  now: 2000,
  runGate: async () => ({ ok: true }),
  git: refusingGit,
});

console.log(`=== drain ok=${result.ok}${"reason" in result ? ` reason=${result.reason}` : ""}`);
console.log(result.text);
for (const warning of result.warnings) console.log(`warning: ${warning}`);
console.log(`worktree exists: ${existsSync(memberPath)}`);
console.log(`branch: ${git(root, ["branch", "--list", "feat/bd-12"]) || "(gone)"}`);
const intent = JSON.parse(readFileSync(join(commonDir, "belayd", "fleet", fleetId, "fleet.json"), "utf8"));
console.log(`released: ${JSON.stringify(intent.released)}`);
console.log(
  `audit: ${readFileSync(fleetAuditLogPath(commonDir, fleetId), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line).action)
    .join(", ")}`,
);
console.log(`root: ${root}`);
TS
```

### 4. Attribution through workflow archival (defect #2)

A worktree whose final-phase run completed and whose `.belayd/workflow.json` is
gone — the post-completion shape — now keeps its id, gets its own state, and names
the exact landing commands:

```bash
root=/tmp/bd168-guide
rm -rf "$root" "$root".feat-*; mkdir -p "$root" && cd "$root"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
git worktree add -q -b feat/bd-12 "$root.feat-bd-12"

# Exactly what completion leaves behind: run manifests, no workflow.json.
mkdir -p "$root.feat-bd-12/.belayd/runs"
cat > "$root.feat-bd-12/.belayd/runs/commit-1.json" <<'JSON'
{"schemaVersion":1,"runId":"commit-1","taskId":"bd-12","phase":"commit","sessionName":"belayd-bd-12","status":"completed","startedAt":1761000000000,"completedAt":1761000600000}
JSON

mkdir -p "$root/.git/belayd/fleet/default"
cat > "$root/.git/belayd/fleet/default/fleet.json" <<'JSON'
{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12"],"createdAt":1761000000000,"updatedAt":1761000900000,"maxConcurrent":3,"baseBranch":"main","supervisor":{"sessionId":"dead-session","pid":999999}}
JSON

cd "$root" && "$J" /tmp/bd168-status.ts "$repo" "$root" default
```

Produced:

```text
Fleet default
  intent: bd-12, max 3 concurrent
  members: 1
  states: active=0 blocked=0 awaiting-human=0 interrupted=0 idle=0 complete-unlanded=1 missing-state=0
  capacity: ceiling 3, 2 free, 1 counted
    default: 1 member(s), 1 counted (0 live, 1 unknown, 0 absent), 0 stopped, 0 released, 0 landed; supervisor dead

Member bd-12 — complete-unlanded
  worktree: /tmp/bd168-guide.feat-bd-12 (branch feat/bd-12)
  task id: bd-12 (inferred from branch or worktree path)
  workflow: missing
  interrupted runs: 0
  orchestrator lease: none
  last updated: 2025-10-20T22:50:00.000Z
  latest runs: commit=completed
  land it: belayd_fleet_merge action=enqueue task=bd-12 then action=drain

Warnings (2):
  - no .belayd/workflow.json in /tmp/bd168-guide.feat-bd-12 (completion clears it); bd-12 still belongs to this fleet and its work is finished — land it with belayd_fleet_merge action=enqueue task=bd-12 then action=drain
  - fleet default counts 1 member(s) against the ceiling of 3 but has no live supervisor (recorded supervisor: dead); re-arm it or release the members
```

The `--- fields ---` JSON block the script prints after the rendering is the
machine-checkable half: `"taskId": "bd-12"`, `"taskIdSource": "worktree"`,
`"state": "complete-unlanded"`.

Failure signal: `Member (no task id) — missing-state` with the old warning
`no .belayd/workflow.json in …; that worktree drives no workflow` is the pre-fix
behaviour (reverting `src/fleet-status.ts` reproduces it: 16 failures in that
suite, `taskId: undefined`).

The landing commands are the hand-holding step the bead paid for. Running them is
the drain in step 6: it builds its own throwaway repository, lands the member, and
prints `removed worktree … and merged branch feat/bd-12` (the same engine
`belayd_fleet_merge action=drain` runs). A fleet whose tick lands the member
removes it the same way.

**The one case that stays unattributed** is a worktree with no branch or
directory suffix naming an id and no run manifests of its own. It keeps the old
`Member (no task id) — missing-state` and the old warning, and in a fleet-scoped
view it is listed under `Other worktrees` with `no task id`:

```bash
anon=/tmp/bd168-anon
rm -rf "$anon" "$anon".anon; mkdir -p "$anon" && cd "$anon"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
git worktree add -q --detach "$anon.anon"
mkdir -p "$anon/.git/belayd/fleet/default"
cat > "$anon/.git/belayd/fleet/default/fleet.json" <<'JSON'
{"schemaVersion":1,"fleetId":"default","taskIds":[],"createdAt":1,"updatedAt":1,"maxConcurrent":3,"baseBranch":"main"}
JSON
cd "$anon" && "$J" /tmp/bd168-status.ts "$repo" "$anon" default | head -8
```

```text
Fleet default
  intent: no task ids, max 3 concurrent
  members: 1
  states: active=0 blocked=0 awaiting-human=0 interrupted=0 idle=0 complete-unlanded=0 missing-state=1

Member (no task id) — missing-state
  worktree: /tmp/bd168-anon.anon (branch detached HEAD)
```

Give the same fleet a recorded id and the anonymous worktree moves out of
`members` instead of acquiring one:

```bash
cat > "$anon/.git/belayd/fleet/default/fleet.json" <<'JSON'
{"schemaVersion":1,"fleetId":"default","taskIds":["bd-99"],"createdAt":1,"updatedAt":1,"maxConcurrent":3,"baseBranch":"main"}
JSON
cd "$anon" && "$J" /tmp/bd168-status.ts "$repo" "$anon" default | sed -n '1,12p'
```

```text
  members: 0
…
No fleet members: no worktree is attributable to fleet default.

Other worktrees (1) — not members of fleet default:
  /tmp/bd168-anon.anon (branch detached HEAD, no task id)

Warnings (3):
  - worktree /tmp/bd168-anon.anon is not a member of fleet `default` and holds no recorded task id
…
```

**A failed re-run after the completed commit is not landable.** Status and the
tick share one verdict (`missingStateRunVerdict`): the newest manifest decides, so
a later failed re-run reads `blocked` in status and `phase-failed` in the tick —
never "land it":

```bash
cat > /tmp/bd168-guide.feat-bd-12/.belayd/runs/rerun-review.json <<'JSON'
{"schemaVersion":1,"runId":"rerun-review","taskId":"bd-12","phase":"review","sessionName":"belayd-bd-12","status":"failed","startedAt":1761001200000,"failureReason":"gate failed"}
JSON
cd /tmp/bd168-guide && "$J" /tmp/bd168-status.ts "$repo" /tmp/bd168-guide default | sed -n '1,14p'
```

```text
  states: active=0 blocked=1 awaiting-human=0 interrupted=0 idle=0 complete-unlanded=0 missing-state=0

Member bd-12 — blocked
  worktree: /tmp/bd168-guide.feat-bd-12 (branch feat/bd-12)
  task id: bd-12 (inferred from branch or worktree path)
  workflow: missing
  latest runs: commit=completed, review=failed
```

There is no `land it:` line in that render, and the missing-state warning is back
to the neutral `no .belayd/workflow.json in …; that worktree drives no workflow`.
Remove `/tmp/bd168-guide.feat-bd-12/.belayd/runs/rerun-review.json` to restore the
`complete-unlanded` shape.

### 5. Fleet-scoped status (bead NOTES, 5th observation)

Two fleets, three worktrees: `wave4` records `bd-94`; `default` records `bd-119`
and `bd-139`. Asking for `wave4` must describe `wave4` only:

```bash
root=/tmp/bd168-fleets
rm -rf "$root" "$root".feat-*; mkdir -p "$root" && cd "$root"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
for id in bd-94 bd-119 bd-139; do
  git worktree add -q -b "feat/$id" "$root.feat-$id"
  mkdir -p "$root.feat-$id/.belayd"
  cat > "$root.feat-$id/.belayd/workflow.json" <<JSON
{"schemaVersion":1,"taskId":"$id","workflowType":"feature","branch":"feat/$id","originalCwd":"$root.feat-$id","phaseOrder":["plan","implement","review"],"completedPhaseNames":["plan"],"startedAt":1761000000000,"updatedAt":1761000900000}
JSON
done
mkdir -p "$root/.git/belayd/fleet/wave4" "$root/.git/belayd/fleet/default"
cat > "$root/.git/belayd/fleet/wave4/fleet.json" <<'JSON'
{"schemaVersion":1,"fleetId":"wave4","taskIds":["bd-94"],"createdAt":1,"updatedAt":1,"maxConcurrent":3,"baseBranch":"main","supervisor":{"sessionId":"dead-session","pid":999999}}
JSON
cat > "$root/.git/belayd/fleet/default/fleet.json" <<'JSON'
{"schemaVersion":1,"fleetId":"default","taskIds":["bd-119","bd-139"],"createdAt":1,"updatedAt":1,"maxConcurrent":3,"baseBranch":"main","supervisor":{"sessionId":"dead-session","pid":999999}}
JSON

cd "$root" && "$J" /tmp/bd168-status.ts "$repo" "$root" wave4
```

Produced:

```text
Fleet wave4
  intent: bd-94, max 3 concurrent
  members: 1
  states: active=1 blocked=0 awaiting-human=0 interrupted=0 idle=0 complete-unlanded=0 missing-state=0
  capacity: ceiling 3, 3 free, 0 counted
    default: 2 member(s), 0 counted (0 live, 0 unknown, 2 absent), 0 stopped, 0 released, 0 landed; supervisor dead
    wave4: 1 member(s), 0 counted (0 live, 0 unknown, 1 absent), 0 stopped, 0 released, 0 landed; supervisor dead

Member bd-94 — active
  worktree: /tmp/bd168-fleets.feat-bd-94 (branch feat/bd-94)
…

Other worktrees (2) — not members of fleet wave4:
  /tmp/bd168-fleets.feat-bd-119 (branch feat/bd-119, bd-119)
  /tmp/bd168-fleets.feat-bd-139 (branch feat/bd-139, bd-139)

Warnings (2):
  - worktree /tmp/bd168-fleets.feat-bd-119 is not a member of fleet `wave4` (bd-119: it belongs to fleet `default`)
  - worktree /tmp/bd168-fleets.feat-bd-139 is not a member of fleet `wave4` (bd-139: it belongs to fleet `default`)
```

Check three things: `members: 1` and the single `Member bd-94` block (the
pre-fix render listed `bd-119` and `bd-94`), `otherWorktrees` in the `---
fields ---` JSON holding both foreign worktrees, and the capacity block **naming
every fleet** — the arithmetic is repository-wide by design (the ceiling is
shared), so it must show the other fleets rather than hide them.

**The all-worktrees view still applies** when the requested fleet records no ids
(a fresh or re-armed fleet, `taskIds: []`) or when no intent exists at all: then
nothing is restricted, nothing lands in `Other worktrees`, and the header says
`intent: none recorded` (or `intent: no task ids`). The empty-view sentence is
also different, and worth knowing: `No fleet members: no worktree is attributable
to fleet <id>.` for a fleet that records ids, versus
`No fleet members: no worktree holds Belayd workflow state.` for the plain view.

### 6. Landing removes the merged worktree (defect #3)

One drain, twice: default (removal allowed) and `--refuse-remove` (as if the tree
had become dirty after the preconditions, e.g. a gate wrote files):

```bash
cd /tmp && "$J" /tmp/bd168-merge.ts "$repo"
```

```text
=== drain ok=true
Fleet `default`: merged bd-12 (feat/bd-12) into main at 79ae15f2b431.
- gates passed on the rebased result: test, typecheck, lint
bd-12 stays in_progress + human: merging is not closing. Accept it with `wt merge` / bd when you are ready.
- removed worktree /tmp/bd168-merge-cj9chc.feat-bd-12 and merged branch feat/bd-12
worktree exists: false
branch: (gone)
released: [{"taskId":"bd-12","reason":"merged","at":…}]
audit: merge-enqueued, merge-acquired, merge-completed, merge-released, member-merged-released
```

```bash
cd /tmp && "$J" /tmp/bd168-merge.ts "$repo" --refuse-remove
```

```text
Fleet `default`: merged bd-12 (feat/bd-12) into main at 933ca35961a0.
- gates passed on the rebased result: test, typecheck, lint
bd-12 stays in_progress + human: merging is not closing. Accept it with `wt merge` / bd when you are ready.
- kept worktree /tmp/bd168-merge-FNjz75.feat-bd-12: `git worktree remove` refused (fatal: cannot remove: working tree is dirty); remove it with `git worktree remove /tmp/bd168-merge-FNjz75.feat-bd-12`
warning: fleet default: merged bd-12 but could not remove /tmp/bd168-merge-FNjz75.feat-bd-12 (fatal: cannot remove: working tree is dirty)
worktree exists: true
branch: + feat/bd-12
released: [{"taskId":"bd-12","reason":"merged","at":…}]
audit: merge-enqueued, merge-acquired, merge-completed, merge-released, member-merged-released
```

Facts to confirm:

- **The removal runs without `--force` and the deletion without `-D`.** Only
  `git worktree remove <path>` and `git branch -d <branch>` are invoked
  (`src/fleet-merge.ts` `removeWorktreeOnly`, `deleteMergedBranchOnly`), so a dirty
  tree or an unmerged branch refuses instead of losing work; the refusal is a
  warning and never fails the drain.
- **The slot is free in both cases.** Even the kept-tree run records
  `released[] {reason:"merged"}` and audits `member-merged-released` (detail:
  `landed: the capacity slot is free; the member record stays until the run prunes it`).
  Status shows it: `released: bd-12 (merged) — slot given back, member kept` and
  `0 counted` even though the liveness probe reports `unknown`.
- **The bead is untouched.** `belayd_fleet_merge` never closes it; the report still
  ends `bd-12 stays in_progress + human: merging is not closing.`

The branch classification (no message-text parsing anywhere) is pinned by the
merge suite; the three outcomes are distinguishable in the report text:

| `git branch -d` outcome | Re-probe (`for-each-ref`) | Report line |
|---|---|---|
| succeeds | — | `- removed worktree <path> and merged branch feat/<id>` |
| refused, branch already gone | `absent` | `- removed worktree <path>; branch feat/<id> was already gone` |
| refused, branch still there | `present` | `- kept branch feat/<id>: \`git branch -d\` refused (<git message>); remove it with \`git branch -d feat/<id>\`` |
| refused, probe cannot answer | `unknown` | `- branch feat/<id> may still exist: \`git branch -d\` refused (…); the branch probe could not confirm it; check with \`git branch --list feat/<id>\`` |
| a seam throws after removal | inspected state | `- cleanup did not finish (<reason>): worktree <path> is gone; branch feat/<id> still exists; finish with git branch -d feat/<id>` |

A **failed merge removes nothing**: cleanup runs only on the two landed arms
(clean success, and a post-merge step that threw *after* the fast-forward). A
**parked root-restore conflict** deliberately returns before cleanup — the member
stays recorded with its slot held and its worktree in place until
`belayd_fleet_reconcile` restores the root, which is the documented park path, not
a leak.

### 7. Stall detection (defect #4)

`planFleetTick` with the *same* stalled progress signature, three liveness shapes:

```bash
cat > /tmp/bd168-tick.ts <<'TS'
// usage: jiti bd168-tick.ts <harness-checkout>
const repo = process.argv[2];
if (repo === undefined) throw new Error("usage: <repo>");
const { planFleetTick, FLEET_RUN_MAX_IDLE_TICKS, FLEET_RUN_MAX_LIVE_IDLE_TICKS } = await import(
  `${repo}/src/fleet-run.ts`
);
const NOW = 1_761_000_000_000;
const intent = { schemaVersion: 1, fleetId: "default", taskIds: ["bd-12"], createdAt: 1, updatedAt: 1 };
const observation = (leaseSecondsAgo) => ({
  taskId: "bd-12",
  progress: { kind: "running", detail: "implement still running", key: "phases:1/5" },
  claim: leaseSecondsAgo === undefined ? "absent" : "live",
  ...(leaseSecondsAgo === undefined ? {} : { leaseHeartbeatAt: NOW - leaseSecondsAgo * 1000 }),
});
for (const [label, leaseAgo, idleTicks] of [
  ["fresh lease, ordinary cap", 10, FLEET_RUN_MAX_IDLE_TICKS],
  ["fresh lease, live cap", 10, FLEET_RUN_MAX_LIVE_IDLE_TICKS],
  ["no live lease, ordinary cap", undefined, FLEET_RUN_MAX_IDLE_TICKS],
]) {
  const action = planFleetTick({
    intent,
    observations: [observation(leaseAgo)],
    now: NOW,
    idleTicks,
  });
  console.log(`\n=== ${label} (idleTicks=${idleTicks})`);
  console.log(JSON.stringify(action));
}
console.log(`\nordinary cap ${FLEET_RUN_MAX_IDLE_TICKS}, live cap ${FLEET_RUN_MAX_LIVE_IDLE_TICKS}`);
TS
cd /tmp && "$J" /tmp/bd168-tick.ts "$repo"
```

Produced:

```text
=== fresh lease, ordinary cap (idleTicks=240)
{"kind":"wait","detail":"the supervisor is ticking; no member progressed for 240 ticks (stall cap 240, live cap 1920); bd-12 still in flight and renewing a lease (bd-12 lease fresh 10s)"}

=== fresh lease, live cap (idleTicks=1920)
{"kind":"halt","reason":"stalled","detail":"no member progressed for 1920 ticks (cap 1920); bd-12 still in flight (bd-12 lease fresh 10s)"}

=== no live lease, ordinary cap (idleTicks=240)
{"kind":"halt","reason":"stalled","detail":"no member progressed for 240 ticks (cap 240); bd-12 still in flight (bd-12 no live lease)"}

ordinary cap 240, live cap 1920
```

So: no halt at the ordinary cap while **every** in-flight member renews a lease;
the wait ends at `FLEET_RUN_MAX_LIVE_IDLE_TICKS` (8 × 240 = 1920 ticks, ≈ 8 h at
the 15 s interval); one member without a live lease restores the ordinary cap.
Every stalled line states each member's evidence (`lease fresh Ns` or
`no live lease`), so it never claims a stuck member whose lease is fresh.

With two members the line names both kinds of evidence:

```bash
node_modules/.bin/vitest run src/__tests__/fleet-run.test.ts \
  -t "halts when one in-flight member has no live lease"
```

**Precedence is unchanged** (bd-175): a hung non-human member still outranks a
live human wait (the human exemption is scoped to the human-wait members), and a
run whose only in-flight work is a live human wait still halts with reason
`awaiting-human` at `FLEET_RUN_MAX_HUMAN_WAIT_TICKS` (2880). `run-not-ticking` in
`belayd_fleet_status` remains the separate supervisor-side signal — a run record
that is still active while nothing ticked for more than
`FLEET_RUN_TICK_INTERVAL_MS × 10`; a fresh lease cannot suppress it and a stalled
message cannot replace it.

The fixture above drives `planFleetTick` directly. The extension's wiring of
`leaseHeartbeatAt` from the live lease probe
(`extensions/capabilities/fleet.ts` `observeFleetMember`) is not pinned by a unit
test — deleting that field leaves the suite green — so confirm the field itself if
you rely on the end-to-end path.

### 8. Capacity, prune and release (defect #1 residual)

A landed member with **no worktree and no branch** is `absent` and holds no slot,
because `run.members[].landedAt` is positive evidence the tree existed:

```bash
root=/tmp/bd168-landed
rm -rf "$root" "$root".feat-*; mkdir -p "$root" && cd "$root"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
now=$(( $(date +%s) * 1000 ))
mkdir -p "$root/.git/belayd/fleet/default"
cat > "$root/.git/belayd/fleet/default/fleet.json" <<JSON
{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12"],"createdAt":1,"updatedAt":$now,"maxConcurrent":3,"baseBranch":"main","run":{"schemaVersion":1,"mode":"until-complete","startedAt":$((now-3600000)),"updatedAt":$now,"ticks":12,"accept":false,"members":[{"taskId":"bd-12","launchedAt":$((now-3600000)),"landedAt":$((now-60000))}]},"supervisor":{"sessionId":"dead-session","pid":999999}}
JSON
cd "$root" && "$J" /tmp/bd168-status.ts "$repo" "$root" default | head -10
```

```text
Fleet default
  intent: bd-12, max 3 concurrent
  run: until-complete — 12 tick(s), last tick 2026-11-06T11:04:05.000Z
  members: 0
  states: active=0 blocked=0 awaiting-human=0 interrupted=0 idle=0 complete-unlanded=0 missing-state=0
  capacity: ceiling 3, 3 free, 0 counted
    default: 1 member(s), 0 counted (0 live, 0 unknown, 1 absent), 0 stopped, 0 released, 1 landed; supervisor dead

No fleet members: no worktree is attributable to fleet default.
```

That is the invariant defect #1 asked for: **`members: 0` for a fleet implies
`0 counted` slots**, and `landed` is reported as its own population (a member with
both a `merged` release and a `landedAt` is shown as landed only, so it is never
counted twice). No `stale-member` warning is emitted for a released or landed
member.

**Prune** now removes a landed-but-worktreeless member instead of refusing:

```bash
node_modules/.bin/vitest run src/__tests__/extension-fleet-p1.test.ts \
  -t "prunes a landed member whose clean landing removed the worktree"
```

The case asserts `expect(text).not.toContain("no proof one ever existed")`,
`exitCode 0`, and `taskIds: []`. The phrase itself still exists in
`src/fleet-sessions.ts` for a genuinely unknown member ("no worktree for X, and no
proof one ever existed (a launch may still be creating it)") — it is simply no
longer reachable for a member with a recorded landing.

**`belayd_fleet_release` accepts `fleetId`** for a foreign fleet only when that
fleet's supervisor is provably dead, and audits the recovery:

```bash
cat > /tmp/bd168-release.ts <<'TS'
// usage: jiti bd168-release.ts <harness-checkout> <cwd> '<json [[tool,args],…]>'
interface FleetTool {
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ text: string }>;
    details: { exitCode: number };
  }>;
}
const [repo, cwd, stepsJson] = process.argv.slice(2);
if (repo === undefined || cwd === undefined) throw new Error("usage: <repo> <cwd> <steps>");
const steps = JSON.parse(stepsJson ?? "[]");
const mod = await import(`${repo}/extensions/index.ts`);
const tools = new Map<string, FleetTool>();
const api = {
  registerTool: (def: FleetTool & { name: string }) => tools.set(def.name, def),
  registerCommand: () => {},
  on: () => {},
  sendMessage: () => {},
  getActiveTools: () => [],
  setActiveTools: () => [],
  events: { emit: () => {}, on: () => () => {} },
};
mod.default(api);
const ctx = {
  cwd,
  ui: { notify: () => {} },
  sessionManager: {
    getSessionId: () => "demo-session",
    getSessionName: () => "fleet-supervisor-demo",
    getSessionFile: () => `${cwd}/session.jsonl`,
  },
};
for (const [name, args] of steps) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`${name} was not registered`);
  console.log(`\n=== ${name} ${JSON.stringify(args)}`);
  const result = await tool.execute("doc", args, undefined, undefined, ctx);
  console.log(result.content.map((part) => part.text).join("\n"));
  console.log(`[${name} exit=${result.details.exitCode}]`);
}
process.exit(0);
TS

root=/tmp/bd168-release
rm -rf "$root"; mkdir -p "$root" && cd "$root"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
printf 'x\n' > README.md && printf '.belayd/\n' > .gitignore && git add -A && git commit -qm base
mkdir -p "$root/.git/belayd/fleet/wave1"
cat > "$root/.git/belayd/fleet/wave1/fleet.json" <<'JSON'
{"schemaVersion":1,"fleetId":"wave1","taskIds":["bd-31"],"createdAt":1,"updatedAt":1,"maxConcurrent":3,"baseBranch":"main","supervisor":{"sessionId":"dead-wave1","pid":999999}}
JSON
cd "$root" && "$J" /tmp/bd168-release.ts "$repo" "$root" '[
  ["belayd_fleet_release",{"taskId":"bd-31","fleetId":"wave1"}],
  ["belayd_fleet_release",{"taskId":"bd-31","fleetId":"wave1"}]]'
```

```text
=== belayd_fleet_release {"taskId":"bd-31","fleetId":"wave1"}
Fleet `wave1`: released bd-31's capacity slot (liveness: unknown). The member, its bead, worktree, and transcript are unchanged; it can still be landed, and the slot is free for the next fleet.
[belayd_fleet_release exit=0]

=== belayd_fleet_release {"taskId":"bd-31","fleetId":"wave1"}
Fleet `wave1`: bd-31's capacity slot is already released; the bead, worktree, and transcript are unchanged.
[belayd_fleet_release exit=0]
```

```bash
jq -c '{taskIds, released}' "$root/.git/belayd/fleet/wave1/fleet.json"
grep member-released "$root/.git/belayd/fleet/wave1/audit.log"
```

```text
{"taskIds":["bd-31"],"released":[{"taskId":"bd-31","reason":"operator-release","at":…}]}
{"timestamp":…,"fleetId":"wave1","actor":"demo-session","action":"member-released-recovery","taskIds":["bd-31"],"detail":"operator-release: the capacity slot is free (recovery: that fleet's supervisor is provably dead, pid-dead); the bead, worktree, and transcript stay"}
```

A **live** foreign supervisor keeps the refusal. Point the same fixture at a
running pid and re-run:

```bash
cat > "$root/.git/belayd/fleet/wave1/fleet.json" <<JSON
{"schemaVersion":1,"fleetId":"wave1","taskIds":["bd-31"],"createdAt":1,"updatedAt":1,"maxConcurrent":3,"baseBranch":"main","supervisor":{"sessionId":"live-wave1","pid":$$}}
JSON
cd "$root" && "$J" /tmp/bd168-release.ts "$repo" "$root" '[
  ["belayd_fleet_release",{"taskId":"bd-31","fleetId":"wave1"}]]'
```

```text
Fleet release refused: bd-31 is a member of fleet `wave1`, whose supervisor is not provably dead. Only that fleet's live supervisor (or the operator once its supervisor is provably dead) may give its capacity back.
[belayd_fleet_release exit=1]
```

### 9. Clean up

```bash
rm -rf /tmp/bd168-guide /tmp/bd168-guide.feat-* \
       /tmp/bd168-fleets /tmp/bd168-fleets.feat-* \
       /tmp/bd168-anon /tmp/bd168-anon.anon \
       /tmp/bd168-landed /tmp/bd168-landed.feat-* \
       /tmp/bd168-release /tmp/bd168-release-live \
       /tmp/bd168-merge-* \
       /tmp/bd168-status.ts /tmp/bd168-merge.ts /tmp/bd168-tick.ts \
       /tmp/bd168-release.ts
```

## How to Use

### A finished member is `complete-unlanded`, not anonymous

Completion clears `.belayd/workflow.json` and leaves the run manifests. Since
bd-168 that worktree keeps its id — from `workflow.json` when it still exists,
else the branch or directory suffix, else its own run manifests — and renders the
two landing commands:

```text
Member bd-125 — complete-unlanded
  worktree: /repo.feat-bd-125 (branch feat/bd-125)
  task id: bd-125 (inferred from branch or worktree path)
  workflow: missing
  latest runs: commit=completed, implement=completed, …
  land it: belayd_fleet_merge action=enqueue task=bd-125 then action=drain
```

| Field | Meaning |
|---|---|
| `taskId` | Attributed id; `(no task id)` only when the branch/directory names none **and** the worktree has no run manifests |
| `taskIdSource` | `workflow` \| `worktree` \| `runs` — `workflow` prints no provenance line, so only an inferred id is labelled |
| `state: complete-unlanded` | No state file, but the newest run manifest is the final phase and `completed` |
| `state: blocked` | No state file, and the newest run manifest `failed` — a failed re-run after the commit is **not** landable |
| `land it:` | Present only for `complete-unlanded` |

`land it` names plain `belayd_fleet_merge` calls, so they need a live supervisor
session (or run the fleet, whose tick lands the member itself). `complete-unlanded` is also
excluded from the bd `human`-gate override: an open gate does not move it into
`Needs you`, because landing is the fleet's work, not a person's. A recorded stop
still does.

### Naming a fleet describes that fleet

```text
belayd_fleet_status {}                            # default fleet
belayd_fleet_status { "fleetId": "wave4" }         # wave4 only
```

With recorded ids, the header, `members:`, `states:`, the member blocks, and the
`Needs you` block all describe the named fleet; every other worktree in the
repository appears under `Other worktrees (<n>) — not members of fleet <id>:`
with a `not-a-member` warning naming the fleet that records it (or
`no fleet here records it`, or `holds no recorded task id` when the worktree names
none). The `capacity:` block stays repository-wide and names the contributing
fleet on every line — that is the ceiling's real scope, not a leak.

The plain all-worktrees view is unchanged and still applies when the fleet
records no ids (`intent: no task ids`) or has no intent at all.

### What a drain does to the worktree and the slot

On a successful drain — and on a drain whose post-merge step threw after the
fast-forward — the order is:

1. `released[] { taskId, reason: "merged", at }` appended to `fleet.json`
   (audited `member-merged-released`). The slot is free from this point, even if
   the tree survives.
2. `git worktree remove <path>` — no `--force`. The root checkout is never a
   target.
3. `git branch -d <branch>` — no `-D`.

The report states exactly what happened: `removed worktree <path> and merged
branch feat/<id>`, or `kept worktree <path>: … remove it with git worktree remove
<path>`, or the branch variants in the table in step 6. Refusals and throwing
seams are warnings; the merge never fails over cleanup.

Deliberately **not** cleaned up:

- a failed merge (nothing landed, nothing removed);
- a parked root-restore conflict — the run parks, the member keeps its record and
  its slot, and the worktree stays until `belayd_fleet_reconcile` restores the
  root.

With `accept: false` (the fleet default) the bead stays `in_progress + human`;
`accept: true` additionally closes it, and that close still works when the drain
already removed the tree (`no worktree currently holds feat/<id>; nothing to
remove`).

### Reading a stalled run

```text
run: until-complete — halted: stalled: no member progressed for 1920 ticks (cap 1920); bd-12 still in flight (bd-12 lease fresh 10s)
```

- `cap 240` — an in-flight member had **no live lease**; something is really
  stuck.
- `cap 1920` — every member kept renewing its lease; the live cap ended a
  lease-renewing loop.
- `lease fresh Ns` / `no live lease` per member, always present.

A run that is *not* ticking shows up differently, as the `run-not-ticking`
warning in `belayd_fleet_status` (`… has an active run whose last tick was at
<ISO> … bound 10 …`). Two signals, two remedies: `stalled` needs a re-arm after
the member is looked at; `run-not-ticking` needs the loop restarted (re-arm) or the
members landed/released.

### Releasing a slot in a fleet whose supervisor is dead

```text
belayd_fleet_release { "taskId": "bd-31", "fleetId": "wave1" }
```

Accepted only when `wave1`'s supervisor is provably dead; the audit action is
`member-released-recovery` and the detail records
`(recovery: that fleet's supervisor is provably dead, <reason>)`. Your own fleet
needs no `fleetId` and audits `member-released`. A live foreign supervisor keeps
the refusal — it owns that capacity decision. **The hand-edit of `fleet.json`
that this bead's evidence describes (`taskIds: []`, `released[]` appended by hand)
is no longer needed**: release is the audited path, and it keeps the member,
worktree, bead and transcript.

### Pruning a landed-but-worktreeless member

```text
belayd_fleet_reconcile { "pruneDeadMembers": true }
```

A member whose run recorded `landedAt` is `absent`, so it is prunable from its own
supervisor's session and, for a provably dead fleet, from any session (audited
`reconcile-recovery`). It no longer refuses with `no proof one ever existed`; that
wording is reserved for a member with no worktree, no branch, no landing record
and no lease — a launch that may still be creating its tree.

### What this does not change

- **The publish gate.** bd-276's repo proof policy (`.belayd/config.json`
  `{"proof":{"artifacts":"in-tree"}}`) still decides whether the payload gate
  refuses; cleanup runs after the merge, so a refused payload still lands nothing.
- **`land-failed` handling.** bd-277's one-repair-round rule for a refused merge
  is untouched: a drain that refuses is still a `land-failed` stop with its own
  retry semantics, and none of that path removes anything.
- **Outside-fleet landing recording.** bd-278's rule for recording a landing that
  happened outside the fleet is untouched; bd-168 only adds the *evidence* such a
  member leaves behind (`landedAt`), so it prunes as `absent`.
- **`AGENTS.md` rules.** The file was trimmed 12779 → 12257 bytes to get back
  inside the 12288-byte project-context budget the base branch had left 491 bytes
  over (bd-286). No rule was removed; both managed Beads blocks and every string
  the budget test asserts are byte-identical.

Related: `docs/fleet.md` (the operator map), `docs/fleet-status.md` (the rendered
view, `complete-unlanded`, `Other worktrees`, warnings), `docs/fleet-run.md` (the
tick, the stall caps, the landing steps), `docs/fleet-merge.md` (the drain
sequence and the branch classification), `docs/fleet-reconcile.md` (liveness,
prune and release authority), `docs/fleet-orchestrator.md` (the design record and
the audit actions).
