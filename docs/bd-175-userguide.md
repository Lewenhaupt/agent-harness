# Review findings now reach Beads as a visible trace (bd-175, superseded wait by bd-219)

> **bd-219 note (current behaviour).** The enforced gate is gone. A review that
> reports ordinary findings writes the record and posts the `[belayd:review]`
> comment, then the orchestrator runs the fix loop — no gate, no wait, no answer
> poll, and a post-review member reads `active`. Only a **security-class**
> finding still opens a bd `human` gate (bd-183), for its publication decision.
> The rest of this guide documents the bd-175 wait mechanics, which remain
> exactly the bd-183 path and `belayd_ask_human`. See
> `docs/bd-183-userguide.md` for the surviving gate.

Before bd-175 a review that reported findings stopped the member `awaiting-human`
with its only trace inside the member's worktree (`.belayd/review-findings.md`).
The bead looked healthy in bd, `needs-you` views did not list it, `bd ready` still
offered it, and the fleet's own `run.stopped[]` said "a human wait" in a detail
string nobody could join back to a gate — because there was no gate. The wait was
real and unfindable at the same time.

bd-175 made that wait a first-class Beads wait (bd-219 removed it for ordinary
findings):

| What happens now | Where it shows |
|---|---|
| A review with ordinary findings writes a record and a comment, **no gate** (bd-219) | `.belayd/review-findings.json`, `bd show <bead>` → `[belayd:review]` comment |
| A **security-class** finding opens a bd `human` gate that blocks the bead (bd-183) | `bd gate list <bead>`, `bd blocked`, `bd ready` (bead absent) |
| The findings are posted as an authored comment | `bd show <bead>` → `[belayd:review]` comment |
| One `{finding, severity, phase, round, disposition}` entry per finding, dispositions `deferred` | `<worktree>/.belayd/review-findings.json` |
| A sensitive wait arms the existing human-answer poll, so answering resumes the member | comment on the bead, or `bd gate resolve <gate>` |
| The fleet reads the bead's **open gate** for its `awaiting-human` stop detail | `belayd_fleet_status`, `<git-common-dir>/belayd/fleet/<id>/fleet.json` |
| A live human wait is exempt from the 1 h idle cap and gets its own 12 h cap | `FLEET_RUN_MAX_HUMAN_WAIT_TICKS`, halt reason `awaiting-human` |
| A clean review keeps the old fast path | no gate, no comment, no record, no bd calls |

| Piece | Where |
|---|---|
| Record, comment body, gate title, the reason constants | `src/review-findings.ts` (`buildReviewFindingsRecord`, `formatReviewFindingsComment`, `reviewFindingsGateTitle`, `REVIEW_FIX_LOOP_REASON`, `REVIEW_HUMAN_GATE_REASON`) |
| Finding trigger (which bullets count as findings) | `src/review-context.ts` (`parseReviewFindings` with `{ strict: true }`) via `hasReviewFindings` |
| Record + comment + the bd-183 gate + poll arming | `extensions/capabilities/human-gate.ts` (`deliverReviewFindings`) |
| Wiring into the review delivery | `extensions/capabilities/phase-run.ts` (`deliverReviewFindingsIfFound`, `runCompleteLoopHint`) |
| Human-wait cap, halt reason, lease evidence | `src/fleet-run.ts` (`FLEET_RUN_MAX_HUMAN_WAIT_TICKS`, `FLEET_HUMAN_GATE_DETAIL`, `idleOrWait`, `retryIsAlive`) |
| The human-answer channel this reuses | `docs/bd-152-userguide.md` |

`REVIEW_HUMAN_GATE_REASON` is the text a real (bd-183) review wait carries
(`"workflow is waiting for a review response"`): the bd-183 gate's `--reason`, and
the sensitive finding's recorded disposition reason. The fleet's `awaiting-human`
detail is `FLEET_HUMAN_GATE_DETAIL` instead, because the fleet waits on any open
bd human gate; the two strings serve different surfaces.

## How to Verify

Run everything from the repository root of this worktree. Every command below was
executed here; the outputs shown are real.

### 1. The quality gates

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:integration
```

```text
$ tsc --noEmit
$ biome check .
Checked 287 files in 537ms. No fixes applied.
$ tsc

 Test Files  129 passed (129)
      Tests  3346 passed (3346)

 Test Files  14 passed (14)
      Tests  106 passed (106)
```

### 2. The suites that pin the behaviour

```bash
pnpm vitest run src/__tests__/review-findings.test.ts \
                src/__tests__/extension-review-gate.test.ts \
                src/__tests__/review-context.test.ts
pnpm vitest run src/__tests__/fleet-run.test.ts -t "bd-175"
pnpm vitest run src/__tests__/extension-session-naming.test.ts \
  -t "bounds a delivered review|inlines the diff in a first review"
```

```text
 ✓ src/__tests__/review-context.test.ts (48 tests) 40ms
 ✓ src/__tests__/review-findings.test.ts (18 tests) 21ms
 ✓ src/__tests__/extension-review-gate.test.ts (14 tests) 22ms
      Tests  80 passed (80)

 ✓ src/__tests__/fleet-run.test.ts (110 tests | 104 skipped) 6ms
      Tests  6 passed | 104 skipped (110)

 ✓ src/__tests__/extension-session-naming.test.ts (69 tests | 67 skipped) 1271ms
      Tests  2 passed | 67 skipped (69)
```

Case names worth knowing, by what they prove:

| Test (`src/__tests__/…`) | Proves |
| --- | --- |
| `extension-review-gate` › `records ordinary findings and leaves the member working (bd-219)` | comment stdin starting `[belayd:review]`, the record file, **no** gate, `awaitingHuman` undefined, no poll |
| `extension-review-gate` › `opens one gate with the disclosure wording and blocks publishing` | the surviving bd-183 gate: argv (`--blocks`, `--type=human`, `--title "belayd-review: …"`, `--reason`), `awaitingHuman`, poll armed, publication withheld |
| `extension-review-gate` › `stays on the fast path for a clean review and writes nothing to bd` | **zero** bd calls, no gate, no record, no wait |
| `extension-review-gate` › `does not open a gate for a narration-only review` | narration bullets do not open a human wait |
| `extension-review-gate` › `keeps the gate and the wait when only the comment write fails` | gate is created first, so a failed comment still leaves a findable wait |
| `extension-review-gate` › `opens exactly one gate when two sensitive deliveries settle concurrently` | the `reviewGatePending` reservation |
| `extension-review-gate` › `records an increasing round across re-reviews without a gate` | `round` comes from the persisted record, not memory |
| `extension-review-gate` › `always emits the resumable-fix directive when no human wait is live` / `withholds the directive while a blocking human wait is live` / `keeps the directive for a publication-only wait (bd-252)` | `runCompleteLoopHint` suppresses the directive only for a blocking wait |
| `review-findings` › `returns undefined for a clean review (the fast path writes nothing)` | no record for a clean review |
| `review-findings` › `reports an error and leaves no temp file behind when the rename fails` | atomic temp-rename write |
| `fleet-run` › `exempts an awaiting-human live wait from the idle cap (bd-175)` | 240 idle ticks on a lone live human wait is still `wait` |
| `fleet-run` › `reaches the 12h awaiting-human halt when the human wait is the only work (bd-175)` | `halt` / `awaiting-human` at 2880 ticks |
| `fleet-run` › `prefers the idle-cap stalled halt over a live human wait when a sibling is hung (bd-175)` | a hung non-human member still stalls at 1 h, naming the human wait |
| `fleet-run` › `records the human-gate detail verbatim in run.stopped[] (bd-219)` | the persisted entry is byte-identical to `FLEET_HUMAN_GATE_DETAIL` |
| `extension-session-naming` › `inlines the diff in a first review …` | a clean review delivery **keeps** `**When review findings remain:**` |
| `extension-session-naming` › `bounds a delivered review and drops its narration bullets (bd-113)` | a findings review through the real seam **keeps** that hint (bd-219) |

### 3. Which review text opens a gate

The trigger is lexical and strict: a finding must sit under a severity heading
(`## Critical (must fix)`, `## Warnings (should fix)`, `## Suggestions (consider)`)
and carry a `file:line`; a bullet that opens with a past-tense check verb is
narration. Save the script once and run it (from the repo root):

```bash
repo=$PWD
cat > /tmp/bd175-parse.ts <<'TS'
import { hasReviewFindings } from "<repo>/src/review-findings.ts";
import { parseReviewFindings } from "<repo>/src/review-context.ts";

const bullets = [
  "- `src/a.ts:5` — the cap is not applied when a sibling is in flight.",
  "- Missing null check in `src/a.ts:5`.",
  "- Verified: read `src/a.ts:5` and `src/b.ts`.",
  "- Verified — race in `src/a.ts:5`.",
  "- **Verified**: race in `src/a.ts:5`.",
  "- Checked: race in `src/a.ts:5`.",
  "- **Missing** null check in `src/a.ts:5`.",
  "- Checkouts are broken in `src/a.ts:5`.",
];
for (const bullet of bullets) {
  const review = `## Critical (must fix)\n\nNone\n\n## Warnings (should fix)\n\n${bullet}\n`;
  const parsed = parseReviewFindings(review, { strict: true });
  console.log(`${hasReviewFindings(review) ? "GATES  " : "ignores"}  ${bullet}`);
  if (parsed.length > 0) console.log(`         severity=${parsed[0]?.severity}`);
}
TS
sed -i "s|<repo>|$repo|g" /tmp/bd175-parse.ts
"$repo/node_modules/.bin/jiti" /tmp/bd175-parse.ts
```

```text
GATES    - `src/a.ts:5` — the cap is not applied when a sibling is in flight.
         severity=warnings
GATES    - Missing null check in `src/a.ts:5`.
         severity=warnings
ignores  - Verified: read `src/a.ts:5` and `src/b.ts`.
ignores  - Verified — race in `src/a.ts:5`.
ignores  - **Verified**: race in `src/a.ts:5`.
ignores  - Checked: race in `src/a.ts:5`.
GATES    - **Missing** null check in `src/a.ts:5`.
         severity=warnings
GATES    - Checkouts are broken in `src/a.ts:5`.
         severity=warnings
```

That output *is* the documented limitation (see
[Known gate limitation](#known-gate-limitation-a-verb-lead-bullet-with-a-defect-clause)):
`- Checked: race in src/a.ts:5` is dropped even though it restates a defect.

### 4. End-to-end: the gate, the comment, the record

> **Historical output.** The transcript below is the pre-bd-219 bd-175 run. Since
> bd-219 these same ordinary findings produce
> `{recorded: true, gateOpened: false, reason: "awaiting the fix loop in this workflow"}`
> and `awaitingHuman: undefined` — same record, same comment, no gate and no
> poll. A security-class finding still produces exactly the gate shown here
> (bd-183).

A throwaway bd database, never the repo's `.beads/`. `bd init --prefix bd` is
required: `isValidTaskId` (which guards `deliverReviewFindings`, the actor line and
the bd argv) accepts only `bd-<alnum>` / `bd-<alnum>.<alnum>`, so the default
directory-derived prefix (`bd175-verify-…`) would be refused with
`opened: false, reason: invalid task id "bd175-verify-…"`.

```bash
repo=$PWD                                    # still the repo root
D=/tmp/bd175-verifyrm -rf "$D" && mkdir -p "$D" && cd "$D" && git init -q
export BEADS_ACTOR=; unset BEADS_DIR          # clear the inherited shared-server/actor env
bd init --prefix bd >/dev/null 2>&1
ID=$(bd create "review gate probe" -t task --json | jq -r '.id')
echo "bead: $ID"                              # e.g. bd-6og
```

Now drive `deliverReviewFindings` — the function the review delivery calls — with a
stub session state and context. No model, no live workflow:

```bash
cat > /tmp/bd175-gate.ts <<'TS'
/**
 * usage: jiti bd175-gate.ts <harness-checkout> <worktree-cwd> <bead-id> [findings|clean]
 */
const [repo, cwd, taskId, mode = "findings"] = process.argv.slice(2);
if (repo === undefined || cwd === undefined || taskId === undefined) {
  throw new Error("<repo> <cwd> <bead-id> [findings|clean]");
}

const { deliverReviewFindings } = (await import(
  `${repo}/extensions/capabilities/human-gate.ts`
)) as {
  deliverReviewFindings: (options: unknown) => Promise<{
    recorded: boolean;
    gateOpened: boolean;
    reason: string;
  }>;
};
const { readReviewFindingsRecord, reviewFindingsRecordPath } = (await import(
  `${repo}/src/review-findings.ts`
)) as {
  readReviewFindingsRecord: (options: { cwd: string }) => unknown;
  reviewFindingsRecordPath: (cwd: string) => string;
};

const REVIEW = `## Critical (must fix)

None

## Warnings (should fix)

- \`src/fleet-run.ts:1004\` — the human-wait cap is not applied when a second member is in flight.

## Suggestions (consider)

- \`src/review-findings.ts:210\` — the comment body could name the round.
`;
const CLEAN = `## Critical (must fix)

None

## Warnings (should fix)

None

## Suggestions (consider)

- Verified: read src/fleet-run.ts and src/review-findings.ts
`;

// A CoreSessionState as the composer would hand it in: only the two fields the
// gate touches matter here.
const state: { awaitingHuman?: unknown; reviewGatePending?: boolean } = {};
const ctx = {
  cwd,
  sessionManager: { getSessionId: () => "demo-session", getSessionName: () => "belayd-demo" },
};

const outcome = await deliverReviewFindings({
  state,
  ctx,
  taskId,
  reviewText: mode === "clean" ? CLEAN : REVIEW,
  deps: {
    getSessionState: () => state,
    resolveSessionBdActor: () => "belayd:probe:orchestrator",
    sendUserMessage: () => {},
  },
});

console.log("outcome:", JSON.stringify(outcome));
console.log("awaitingHuman:", JSON.stringify(state.awaitingHuman));
console.log("record path:", reviewFindingsRecordPath(cwd));
console.log("record:", JSON.stringify(readReviewFindingsRecord({ cwd }), null, 2));
process.exit(0);
TS

cd "$D" && "$repo/node_modules/.bin/jiti" /tmp/bd175-gate.ts "$repo" "$D" "$ID" findings
```

```text
outcome: {"opened":true,"reason":"workflow is waiting for a review response"}
awaitingHuman: {"beadId":"bd-6og","askedAt":1793484316383,"gateId":"bd-6hq"}
record path: /tmp/bd175-verify/.belayd/review-findings.json
record: {
  "schemaVersion": 1,
  "taskId": "bd-6og",
  "phase": "review",
  "round": 1,
  "reason": "workflow is waiting for a review response",
  "artifactPath": ".belayd/review-findings.md",
  "findings": [
    {
      "finding": "`src/fleet-run.ts:1004` — the human-wait cap is not applied when a second member is in flight.",
      "severity": "warnings",
      "phase": "review",
      "round": 1,
      "disposition": {
        "kind": "deferred",
        "reason": "workflow is waiting for a review response"
      }
    },
    {
      "finding": "`src/review-findings.ts:210` — the comment body could name the round.",
      "severity": "suggestions",
      "phase": "review",
      "round": 1,
      "disposition": {
        "kind": "deferred",
        "reason": "workflow is waiting for a review response"
      }
    }
  ]
}
```

Three writes landed: the gate, the record, the comment. Read them the way an
operator would:

```bash
bd gate list "$ID"
bd gate list "$ID" --json
bd show "$ID"
bd ready
bd blocked
```

```text
⏳ Open Gates (1):

○ bd-6hq - human

To resolve a gate: bd close <gate-id>
```

```json
[
  {
    "id": "bd-6hq",
    "title": "belayd-review: bd-6og findings (round 1)",
    "description": "Ad-hoc gate blocking bd-6og\n\nReason: workflow is waiting for a review response",
    "status": "open",
    "priority": 2,
    "issue_type": "gate",
    "owner": "hugo.lewenhaupt@gmail.com",
    "created_at": "2026-10-31T22:05:17Z",
    "created_by": "belayd:probe:orchestrator",
    "updated_at": "2026-10-31T22:05:17Z",
    "await_type": "human"
  }
]
```

```text
○ bd-6og · review gate probe   [P2 · OPEN]
Created by: Hugo Lewenhaupt · Type: task
Created: 2026-10-31 · Updated: 2026-10-31

DESCRIPTION
  (none)

DEPENDS ON
  → ○ bd-6hq: belayd-review: bd-6og findings (round 1) P2

COMMENTS
  2026-10-31 22:05 belayd:probe:orchestrator

      [belayd:review]

      ## Review findings — human gate

      **Reason:** workflow is waiting for a review response

      **Findings:** 2 (Critical: 0, Warnings: 1, Suggestions: 1)

      Full findings: .belayd/review-findings.md

      ### Warnings (should fix)

      • src/fleet-run.ts:1004 — the human-wait cap is not applied when a second
      member is in flight. — deferred — workflow is waiting for a review response

      ### Suggestions (consider)

      • src/review-findings.ts:210 — the comment body could name the round. —
      deferred — workflow is waiting for a review response

      ### Question

      Should these findings be addressed, deferred to a bead (with a reason), or
      rejected? Reply on this bead (or resolve the gate) with your decision, then
      the workflow resumes.
```

```text
✨ No ready work found (all issues have blocking dependencies)
```

```text
🚫 Blocked issues (1):

[P2] bd-6og: review gate probe
  Blocked by 1 open dependencies: [bd-6hq]
```

The record is the queryable surface (this is the file bd-183/bd-184 read):

```bash
jq -r '[.round, .reason, (.findings|length)] | @tsv' "$D/.belayd/review-findings.json"
jq -r '.findings[] | [.severity, .disposition.kind, .finding] | @tsv' "$D/.belayd/review-findings.json"
```

```text
1	workflow is waiting for a review response	2
warnings	deferred	`src/fleet-run.ts:1004` — the human-wait cap is not applied when a second member is in flight.
suggestions	deferred	`src/review-findings.ts:210` — the comment body could name the round.
```

### 5. Answering releases the bead and bumps the round

```bash
cd "$D"
bd gate resolve bd-6hq
bd gate list "$ID" --json
bd show "$ID" --json | jq -r '.[0] | "\(.id)\t\(.status)"'
bd ready
```

```text
✓ Gate resolved: bd-6hq
null
bd-6og	open
○ bd-6og P2 review gate probe

Ready: 1 issues with no active blockers
```

`open` is the point: answering resolved the *question* and unblocked the bead; it
did not accept the work. Re-running the driver now writes `round: 2` into the same
record, which is how the fix-round count survives across re-reviews:

```bash
cd "$D" && "$repo/node_modules/.bin/jiti" /tmp/bd175-gate.ts "$repo" "$D" "$ID" findings
# outcome: {"opened":true,…} / record round: 2 / a second `[belayd:review]` comment
```

### 6. The clean-review fast path writes nothing

A fresh database, so "nothing was written" is visible rather than inferred:

```bash
C=/tmp/bd175-clean
rm -rf "$C" && mkdir -p "$C" && cd "$C" && git init -q
export BEADS_ACTOR=; unset BEADS_DIR
bd init --prefix bd >/dev/null 2>&1
CID=$(bd create "clean review probe" -t task --json | jq -r '.id')
cd "$C" && "$repo/node_modules/.bin/jiti" /tmp/bd175-gate.ts "$repo" "$C" "$CID" clean
bd gate list "$CID"
bd comments "$CID" --json
ls .belayd 2>&1
```

```text
outcome: {"opened":false,"reason":"the review reported no findings"}
awaitingHuman: undefined
record path: /tmp/bd175-clean/.belayd/review-findings.json
record: undefined
No gates found.
[]
ls: cannot access '.belayd': No such file or directory
```

Note the second `record` line in the clean output: nothing on disk, so the reader
returns `undefined` and no `.belayd/` directory is even created.

### 7. The fleet side: one reason string, two caps

The fleet's decision layer is pure, so the run's view can be printed without a
fleet:

```bash
cd "$repo"
cat > /tmp/bd175-fleet.ts <<'TS'
import {
  FLEET_RUN_MAX_HUMAN_WAIT_TICKS,
  FLEET_RUN_MAX_IDLE_TICKS,
  deriveFleetMemberProgress,
  formatFleetRunStops,
  planFleetTick,
  recordRunMemberStopped,
  startFleetRun,
} from "<repo>/src/fleet-run.ts";
import { REVIEW_HUMAN_GATE_REASON } from "<repo>/src/review-findings.ts";

const PHASES = ["plan", "implement", "review", "test", "userguide", "proof", "commit"];
const intentBase = {
  schemaVersion: 1, fleetId: "default", taskIds: ["bd-12"], createdAt: 1_000, updatedAt: 1_000,
};

// The workflow snapshot the fleet really reads: review completed, no later phase yet.
const progress = deriveFleetMemberProgress({
  taskId: "bd-12",
  workflow: {
    kind: "ok",
    completedPhaseNames: ["plan", "implement", "review"],
    phaseOrder: PHASES,
    awaitingReviewResponse: true,
  },
  runs: [],
  now: 5_000,
});
console.log("progress:", JSON.stringify(progress));

const stopped = recordRunMemberStopped({
  run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
  taskId: "bd-12",
  reason: "awaiting-human",
  detail: REVIEW_HUMAN_GATE_REASON,
  now: 2_000,
});
console.log("run.stopped[]:", JSON.stringify(formatFleetRunStops(stopped)));

const human = { taskId: "bd-12", progress, claim: "live" as const };
const hung = {
  taskId: "bd-15",
  progress: { kind: "running" as const, detail: "2/7 phases complete", key: "phases:2/7" },
  claim: "live" as const,
};
const tick = (idleTicks: number, taskIds: string[] = ["bd-12"], observations = [human], run = stopped) =>
  planFleetTick({ intent: { ...intentBase, taskIds, run }, observations, now: 5_000, idleTicks });

console.log(`idleTicks=${FLEET_RUN_MAX_IDLE_TICKS}:`, JSON.stringify(tick(FLEET_RUN_MAX_IDLE_TICKS)));
console.log(`idleTicks=${FLEET_RUN_MAX_HUMAN_WAIT_TICKS}:`, JSON.stringify(tick(FLEET_RUN_MAX_HUMAN_WAIT_TICKS)));

// A hung non-human member: both are already stopped in the record, its 1h idle cap wins.
const stoppedBoth = recordRunMemberStopped({
  run: stopped, taskId: "bd-15", reason: "phase-failed", detail: "phase test failed", now: 2_000,
});
console.log(
  "hung sibling:",
  JSON.stringify(tick(FLEET_RUN_MAX_IDLE_TICKS, ["bd-12", "bd-15"], [human, hung], stoppedBoth)),
);
TS
sed -i "s|<repo>|$repo|g" /tmp/bd175-fleet.ts
"$repo/node_modules/.bin/jiti" /tmp/bd175-fleet.ts
```

```text
progress: {"kind":"awaiting-human","detail":"workflow is waiting for a review response"}
run.stopped[]: ["stopped bd-12 (awaiting-human): workflow is waiting for a review response"]
idleTicks=240: {"kind":"wait","detail":"bd-12 awaiting a human response; the run waits for the answer"}
idleTicks=2880: {"kind":"halt","reason":"awaiting-human","detail":"bd-12 awaited a human response for 2880 ticks (cap 2880); re-arm the fleet after answering"}
hung sibling: {"kind":"halt","reason":"stalled","detail":"no member progressed for 240 ticks (cap 240); bd-15 still in flight; bd-12 awaiting a human response"}
```

Three facts to read off it: the run **waits** through the 1 h cap that would
otherwise halt a stalled member, the human's own cap is `2880 × 15 s ≈ 12 h` and
halts under `awaiting-human`, and a hung non-human sibling still stalls at
`FLEET_RUN_MAX_IDLE_TICKS` while the detail names the human wait (so the halt
never hides it).

The same two strings when the ticker halts the run and the supervisor formats it
(`extensions/capabilities/fleet.ts` `haltTickAction` → `formatFleetRunLine`):

```text
run: until-complete — halted: awaiting-human: bd-12 awaited a human response for 2880 ticks (cap 2880); re-arm the fleet after answering
stopped bd-12 (awaiting-human): workflow is waiting for a review response
```

### 8. Clean up

```bash
rm -rf /tmp/bd175-verify /tmp/bd175-clean \
       /tmp/bd175-gate.ts /tmp/bd175-parse.ts /tmp/bd175-fleet.ts
```

## How to Use

### What changes in your day

> **bd-219:** this section describes the bd-175 wait for a review with findings.
> Since bd-219 only a **security-class** finding still gates; an ordinary findings
> review writes the record and the `[belayd:review]` comment and the orchestrator
> runs its own fix loop (`docs/bd-219-userguide.md`). Read `belayd-review:` below
> as the bd-183 publication gate.

A review that reports findings is now a question you have to answer before the
workflow continues — and it is visible in bd instead of only in a worktree file:

1. The review phase finishes with findings.
2. The member opens a `human` gate (`belayd-review: <bead> findings (round N)`)
   with the reason `workflow is waiting for a review response`, posts the
   `[belayd:review]` comment, writes `.belayd/review-findings.json`, and arms its
   30 s human-answer poll.
3. **The bead is blocked**: it disappears from `bd ready`, appears in `bd blocked`
   and in your `needs-you` view, and the fleet shows the member stopped.
4. You answer. The member resumes with the next incomplete phase (normally
   `belayd_test`), and the delivery no longer carries the "When review findings
   remain" hint, because advancing is exactly what it was blocked on.

Nothing type-checks or runs differently: the findings are a decision point, not a
build failure.

### Finding the wait and answering it

```bash
bd blocked                                   # every bead a gate is blocking
bd gate list bd-175                          # human form
bd gate list bd-175 --json | jq -r '.[] | [.id, .title, .description] | @tsv'
bd show bd-175                               # the [belayd:review] comment, findings and dispositions
bd comments bd-175 --json | jq -r '.[] | [.author, (.text|split("\n")[0])] | @tsv'
```

Answer either way — the two are equivalent to the harness:

```bash
# 1. a comment: the first comment by anyone whose actor is not belayd:* resumes the member
bd comment bd-175 --stdin <<'BD'
Defer the human-wait cap finding to bd-184; fix the comment-rounding one now.
BD

# 2. or resolve the gate out of band
bd gate resolve <gate-id>                    # == bd close <gate-id>
```

The member receives `hugo answered: …` (or "The human gate on bd-175 was resolved
without a comment; you may proceed.") on its next 30 s tick or next turn, and
resolves the gate itself. **The work bead stays `open`**: answering is not
accepting, and `wt merge` / `bd close` is still how work is accepted.

What a finding's `deferred` disposition means: at the moment the gate opens,
nothing has been addressed yet, so every finding is recorded as
`{"kind":"deferred","reason":"workflow is waiting for a review response"}`. The
record is the machine-readable list; your answer is what decides what happens to
each finding, and `.belayd/review-findings.md` (the review agent's own scratchpad,
the path the comment points at) keeps the full text.

Reading the record:

```bash
wt=$(git rev-parse --show-toplevel)
jq -r '[.round, .reason] | @tsv' "$wt/.belayd/review-findings.json"
jq -r '.findings[] | [.severity, .disposition.kind, .finding] | @tsv' "$wt/.belayd/review-findings.json"
```

`round` is `1` on the first findings review and increments on every later one,
because it is read back from the record before it is overwritten. A clean review
writes nothing, so it neither advances the round nor clears the previous record —
the next findings review does that with `round + 1`.

### Watching the fleet: a live wait versus a dead member

`belayd_fleet_status` (and the run record) now distinguishes the two cases:

| Situation | Status line | Meaning |
|---|---|---|
| Member waiting on a review gate, answer poll alive | `stopped bd-175 (awaiting-human): workflow is waiting for a review response` | Healthy wait. The run stays open and waits for you |
| Same wait, but nobody ever answers | `run: until-complete — halted: awaiting-human: bd-175 awaited a human response for 2880 ticks (cap 2880); re-arm the fleet after answering` | Neglected wait: the 12 h cap fired. Answer, then re-arm |
| A non-human member hung | `run: until-complete — halted: stalled: no member progressed for 240 ticks (cap 240); bd-175 still in flight` | A fault, not a wait. The 1 h idle cap applied even though a sibling was waiting on a human |

How the cap is picked (`src/fleet-run.ts` `idleOrWait`):

- A member counts as a live human wait when its progress kind is
  `awaiting-human` **and** its orchestrator lease is `live` — the answer poll runs
  in that session, so the wait is bounded by you, not by the idle cap.
- If **any** other in-flight member is not a live human wait, the ordinary
  `FLEET_RUN_MAX_IDLE_TICKS` (240 ticks ≈ 1 h) applies and halts `stalled`, with
  the human wait named in the detail. The exemption is scoped to the waiting
  member so it cannot mask a stuck phase behind an unrelated decision.
- When the only work in flight is live human waits, the cap is
  `FLEET_RUN_MAX_HUMAN_WAIT_TICKS` (2880 ticks ≈ 12 h) and the halt reason is
  `awaiting-human` — a distinct reason, so a neglected gate never reads as a dead
  member. On the tick the cap fires the run is finished (terminal, like any halt):
  answer the gate, then `/fleet <ids> --fleet <id>` to re-arm.
- An `awaiting-human` member whose lease is **not** live (session gone) is not a
  wait: without the poll nothing can deliver an answer, so the run concludes
  `partial` instead of holding capacity forever.

Where to read it directly:

```bash
fd=$(git rev-parse --path-format=absolute --git-common-dir)/belayd/fleet/<id>
jq -r '.run.haltedReason // "none"' "$fd/fleet.json"
jq -r '.run.stopped[]? | [.taskId, .reason, .detail] | @tsv' "$fd/fleet.json"
jq -r 'select(.action=="fleet-run-halted") | .detail' "$fd/audit.log" | tail -1
```

The halt is also audited (`fleet-run-halted`) and reported once with the same
text, so the daemon log and the UI agree. The tick order, run record and halt
semantics live in `docs/fleet-run.md`; this guide only adds the review wait.

### Known gate limitation: a verb-lead bullet with a defect clause

The trigger is lexical. A bullet that opens with a past-tense check verb
(`checked`, `verified`, `tested`, `reviewed`, backticked or not) is treated as
narration and does **not** open a gate — even when a `:`/`—` clause after it
restates a present-tense defect:

```text
- Checked: race in src/a.ts:5        → no gate
- Verified — race in src/a.ts:5     → no gate
```

The tradeoff is deliberate: separating that clause from an affirmation
(`- Checked: all fine`) needs a defect lexicon, and a wrong guess *opens a human
gate for nothing* — exactly the failure the narration rule exists to prevent.

**Workaround:** write the defect without the check-verb prefix, location first
(which is already the review output contract):

```text
- `src/a.ts:5` — race between the gate check and the record write.
```

Two related nuances:

- Emphasis is styling, not a different marker: `- **Verified**: race in
  src/a.ts:5` behaves exactly like `- Verified: race in src/a.ts:5` (no gate),
  while `- **Missing** null check in src/a.ts:5` and `- Checkouts are broken in
  src/a.ts:5` are findings.
- Nothing is lost when the gate does not open: the review transcript and
  `.belayd/review-findings.md` still carry the text, and the review delivery
  still reaches the orchestrator. Only the *bd-visible* human wait is skipped.

### When no gate appears

Every failure is best-effort, and each one has a distinct signature. A review
with ordinary findings has **no** gate by design since bd-219 — `recorded: true`,
`gateOpened: false`; only a security-class finding is expected to gate.

| What you see | Cause | What to do |
|---|---|---|
| Security-class review, record + comment, **no** gate on the bead | `bd gate create` failed (bd missing, database unreachable, argv refused); the delivery returned `gateOpened: false` with the error in `reason`; logged once as `could not open the sensitive-findings human gate` | Nothing is blocked — the findings still reach the orchestrator; run the fix loop, and escalate with `belayd_ask_human` only for a publication decision you may not take |
| Gate open, **no** `[belayd:review]` comment | the comment write failed (warned as `could not post the review findings comment`) | Keep the gate — the reason text is the visible wait — and read `.belayd/review-findings.md` |
| Gate and comment, **no** `.belayd/review-findings.json` | record write failed (read-only worktree) — warned as `could not record the review findings` | Nothing blocks: the gate and the comment are the human-visible record |
| `gateOpened: false, reason: "a review delivery is already in progress"` | a concurrent review delivery holds the reservation | Exactly one gate is ever created; nothing else to do |
| `gateOpened: false, reason: "invalid task id …"` | the bead id is not in the `bd-<alnum>` shape | Use a normal bead id (this is the guard that keeps a crafted id out of bd argv) |
| Ordinary findings: record + comment, no gate | intended (bd-219) | Run the fix loop (`belayd_implement`, then `belayd_review`) |
| Clean review: no gate, no comment, no record | intended | Nothing — advance as before |

Every one of those warnings is prefixed `[belayd-harness]`, so the daemon log
carries the same text as the terminal. Each failure has exactly one owner in the
log: the delivery seam logs a refused bd-183 gate
(`could not open the sensitive-findings human gate`) and an already-open wait that
could not re-arm the publication question
(`could not arm the sensitive-findings publication question`); the phase runner
logs only a skipped record (`review findings were not fully delivered`); and the
record/comment write failures log `could not record` / `could not post`. Search
the log for those strings.

### Rules of thumb

- **Reply in the thread; an approval note is the fallback.** A comment on the work
  bead is the answer channel (Scotty's gate card cannot post one — open the bead
  it says it unblocks, or `bd comment <bead> --stdin`). Resolving the gate instead
  (`bd gate resolve <gate> --reason "…"`, or Scotty's **Add approval note** +
  **Approve**) resumes the member with the reason as a note; with no reason it
  resumes on "resolved without a comment", so the decision leaves no text behind.
  A gate that simply disappears still reads as an out-of-band resolution.
- **Do not treat a long wait as a hang.** A live human wait is exempt from the 1 h
  idle cap on purpose; only `stalled` means a member is at fault.
- **A `halted: awaiting-human` run needs a re-arm**, not a resume: any halt is
  terminal for that run record, so answer the gate and then
  `/fleet <ids> --fleet <id>`.
- **Write findings location-first.** `- \`file:line\` — defect.` always gates;
  `- Checked: defect in file:line` does not.

Related: `docs/fleet-run.md` (tick order, run record, the review stop and its
`awaiting-human` cap), `docs/bd-152-userguide.md` (the human-answer channel and
`belayd_ask_human`), `docs/diff-scoped-review.md` (the review process, the
`.belayd/review-findings.md` scratchpad), `src/review-findings.ts`,
`extensions/capabilities/human-gate.ts`, `src/fleet-run.ts`.
