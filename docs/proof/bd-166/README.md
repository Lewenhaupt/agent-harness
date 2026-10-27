# bd-166 proof — fleet capacity leaks (liveness-aware ceiling, release, terminal runs)

Worktree: `/home/hugo/git/feat-bd-166` (branch `feat/bd-166`).
Change type: **CLI / harness only** — `src/fleet-capacity.ts`, `src/fleet-run.ts`,
`src/fleet-status.ts`, `src/fleet-sessions.ts`, `src/fleet-reconcile.ts`,
`extensions/index.ts` plus docs. **There is no UI or browser surface, so no
Playwright trace and no `playwright-cli` screenshot exists, by design.** Every
artifact here is a real terminal transcript produced by running the repository's
own code.

## Artifacts

| File | What it proves | Acceptance items |
|---|---|---|
| `gates.log` | the five acceptance gates on this worktree: `pnpm test` **124 files / 3210 tests passed**, `pnpm test:integration` **14 files / 106 tests passed**, `pnpm typecheck` (tsc, no output), `pnpm lint` **Checked 249 files. No fixes applied.**, `pnpm build` (tsc, no output) | build acceptance checklist |
| `capacity-arithmetic.log` | a scratch repo with **4 recorded members across two fleets** (`default`, `night`) so the shared ceiling of 3 binds: `capacity: ceiling 3, 0 free, 3 counted` with per-fleet contributor lines → bd-22 becomes `absent` (workflow state, nothing running it) → `1 free, 2 counted` → `belayd_fleet_release bd-15` → `2 free, 1 counted`; then `released[]` in `fleet.json` and the `member-released` audit line, with `taskIds`/worktree/branch kept | 1 (liveness-aware capacity), 3/4 (capacity block + per-fleet rollup), 10 (`belayd_fleet_release`), 11 (`released[]` schema) |
| `terminal-release.log` | a run that finishes 0-for-N releases with `released[].reason = run-complete` + `members-released` audit; a run that halts (parked root) releases with `run-halted` + audit; a **paused** run releases nothing (`released: null`, no `members-released` audit line) | 6 (terminal release / halt / pause split) |
| `verify-failure-and-refusal.log` | `belayd_fleet_release` refuses a non-member (`exit=1`) and a member whose orchestrator is live (`exit=1`, nothing written); `belayd_fleet_reconcile { fleetId: "orphan" }` repairs cross-fleet (`exit=0`) and audits `reconcile-cross-fleet` on the target fleet while refusing `pruneDeadMembers` (`exit=1`); the same prune on the session's own fleet is allowed and audits **no** `reconcile-cross-fleet` line | 9 (named-fleet reconcile authority), 10 (release safety directions) |
| `regression-tests.log` | each bd-166 regression suite run individually, with per-file counts: `fleet-launch` 68, `fleet-run` 94, `fleet-status` 125, `fleet-sessions` 30, `fleet-reconcile` 41, `fleet-mode` 32, `fleet-state` 66, `extension-fleet-p1` 107, `test/fleet-status.integration` 6 — all passed | 1–11 (the suites that pin each item, see mapping below) |
| `capacity-arithmetic.cast` | asciinema recording of the capacity/release scenario (`command` field + `x` exit event) | same as `capacity-arithmetic.log` |
| `terminal-release.cast` | asciinema recording of the run-complete / run-halted / paused scenario | same as `terminal-release.log` |
| `verify-failure-and-refusal.cast` | asciinema recording of the refusal scenario | same as `verify-failure-and-refusal.log` |
| `scripts/` | the exact scripts the transcripts were captured from (`lib.sh`, `bd166-fleet.ts` driver, the three scenario scripts, `gates.sh`, `regression-tests.sh`) | reproduction |

Logs are the raw stdout+stderr of the scripts (timestamps, the exact `$ command`
line, `[exit=N]` after each step). The `.cast` files are independent re-runs of
the same scripts inside a 200x50 PTY.

## How the scenarios are driven

`scripts/bd166-fleet.ts` is a jiti driver: it imports `extensions/index.ts`,
registers the real tools, and calls `execute()` with a stub session context
(session id `demo-session`). That is the same code path pi uses for a tool call,
so the output is the tool result plus the notifications the extension raised —
not hand-written fixtures. Scratch repositories are built under `/tmp` with real
`git init`, real `git worktree add`, and real `fleet.json` / `workflow.json` /
`orchestrator.json` files; the fleet tools then read and write them.

Reproduce everything (from the repo root):

```bash
cd /home/hugo/git/feat-bd-166
bash docs/proof/bd-166/scripts/gates.sh               > gates.log
bash docs/proof/bd-166/scripts/regression-tests.sh    > regression-tests.log
bash docs/proof/bd-166/scripts/capacity-arithmetic.sh > capacity-arithmetic.log
bash docs/proof/bd-166/scripts/terminal-release.sh    > terminal-release.log
bash docs/proof/bd-166/scripts/verify-failure-and-refusal.sh > verify-failure-and-refusal.log

# the recordings
asciinema rec --overwrite --window-size 200x50 \
  -c "bash docs/proof/bd-166/scripts/capacity-arithmetic.sh" capacity-arithmetic.cast
asciinema rec --overwrite --window-size 200x50 \
  -c "bash docs/proof/bd-166/scripts/terminal-release.sh" terminal-release.cast
asciinema rec --overwrite --window-size 200x50 \
  -c "bash docs/proof/bd-166/scripts/verify-failure-and-refusal.sh" verify-failure-and-refusal.cast
```

Single scenarios by hand (same driver; `untilComplete:false` is a re-arm that
preserves members and starts nothing):

```bash
J=node_modules/.bin/jiti
# capacity view of an existing scratch repo
$J docs/proof/bd-166/scripts/bd166-fleet.ts "$PWD" /tmp/bd166-proof-capacity '[["belayd_fleet_status",{}]]'
# operator release (supervisor-only, own fleet only)
$J docs/proof/bd-166/scripts/bd166-fleet.ts "$PWD" /tmp/bd166-proof-capacity \
  '[["belayd_fleet_launch",{"tasks":["bd-12","bd-15"],"fleetId":"default","untilComplete":false}],
    ["belayd_fleet_release",{"taskId":"bd-15"}]]'
```

Individual regression suites:

```bash
node_modules/.bin/vitest run src/__tests__/fleet-run.test.ts -t "releaseRunMembers"
node_modules/.bin/vitest run src/__tests__/extension-fleet-p1.test.ts -t "bd-166"
node_modules/.bin/vitest run --config vitest.integration.config.ts test/fleet-status.integration.test.ts
```

## Acceptance-item → evidence map

| Acceptance item | Evidence here | Pinned by |
|---|---|---|
| 1. Liveness-aware capacity (`absent` stops counting, `unknown`/`live` count) | `capacity-arithmetic.log` (3 counted → 2 → 1, with `1 absent` / `1 live` in the contributor line) | `fleet-launch.test.ts`, `fleet-status.test.ts`, `fleet-sessions.test.ts` in `regression-tests.log` |
| 2. Mid-spawn never freed; a completed member is | `regression-tests.log` (`extension-fleet-p1.test.ts` 107 tests incl. `mid-spawn capacity (bd-166)`) | `fleet-sessions.test.ts`, `extension-fleet-p1.test.ts` |
| 3. Evidence cutoff arithmetic | `regression-tests.log` (`fleet-run.test.ts` 94 tests) | `fleet-run.test.ts` (`memberRanEvidence`, `memberEvidenceCutoff`, `worktreeCreatedAtFromStat`) |
| 4. `capacity:` block + `stale-member` / `capacity-held` | `capacity-arithmetic.log` (`stale-member` for bd-23, `capacity-held` for both dead-supervisor fleets) | `fleet-status.test.ts` |
| 4b. `run-not-ticking` | not in a scenario transcript; covered by `fleet-status.test.ts` inside `regression-tests.log` | `fleet-status.test.ts` (`capacity arithmetic (bd-166)`) |
| 5. Status view end to end from real git + fs | `regression-tests.log` (`test/fleet-status.integration.test.ts` 6 tests) | `test/fleet-status.integration.test.ts` |
| 6. Terminal release / halt / pause split | `terminal-release.log` + `terminal-release.cast` | `fleet-run.test.ts` (`releaseRunMembers`), `extension-fleet-p1.test.ts` |
| 7. Advance records members + beats the heartbeat | `regression-tests.log` (`extension-fleet-p1.test.ts`) | `extension-fleet-p1.test.ts` (`records an advance-launched member in the live run and beats the heartbeat (bd-166)`) |
| 8. Outside-fleet landing (closed bead **and** git ancestor) | `regression-tests.log` (`fleet-run.test.ts`, `extension-fleet-p1.test.ts`) | `fleet-run.test.ts` (`planOutsideFleetLandings (bd-166)`), `extension-fleet-p1.test.ts` |
| 9. Named-fleet reconcile, cross-fleet prune refused | `verify-failure-and-refusal.log` + `.cast` | `fleet-reconcile.test.ts`, `extension-fleet-p1.test.ts` |
| 10. `belayd_fleet_release` (slot back, member kept, refusals) | `capacity-arithmetic.log` (release + `released[]` + audit), `verify-failure-and-refusal.log` (both refusals) | `extension-fleet-p1.test.ts` (`release (bd-166)`) |
| 11. `released[]` schema, per-fleet keying, cleared by landing | `capacity-arithmetic.log` (per-fleet `released` line; the other fleet keeps its own state) | `fleet-status.test.ts`, `fleet-launch.test.ts`, `fleet-state.test.ts` |

## What is NOT demonstrated here, and why

- **No UI/browser artifact.** The change has no browser surface; Playwright and
  `playwright-cli` artifacts would be fabricated, so none exist.
- **Scenarios that need a live agent session** (a real spawned orchestrator,
  `belayd_fleet_advance` on a live run, a real `bd` + `wt merge` outside-fleet
  landing) are **not** re-driven from the scratch repos here: they would spawn pi
  agents and mutate a real beads database. They are evidenced instead by
  `regression-tests.log`, which runs the extension integration suite
  (`src/__tests__/extension-fleet-p1.test.ts`, 107 passing tests) against the
  real extension tool handlers — no mocks of the fleet code — plus the
  library-level suites for the pure planners. Those three items are marked
  `regression-tests.log` only in the map above.
- **`run-not-ticking`** is not in a scenario transcript (it needs a planted
  stale `run.updatedAt` clock); it is covered by `fleet-status.test.ts` in
  `regression-tests.log`.
