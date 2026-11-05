# Review findings now reach Beads as a visible trace (bd-175, superseded wait by bd-219)

> **bd-286 note (current behaviour).** The enforced gate is gone entirely. A
> review that reports findings writes the record and posts the `[belayd:review]`
> comment, then the orchestrator runs the fix loop — no gate, no wait, no answer
> poll, and a post-review member reads `active`. The bd-183 sensitive-findings
> classifier and its publication gate were deleted (secrets are `betterleaks`'
> job: `.betterleaks.toml`, `pnpm scan:secrets`), so the only human gate a
> workflow can open is `belayd_ask_human`. The rest of this guide documents how a
> findings review reaches bd, and the fleet's human-wait caps; no step here opens
> a review gate.

Before bd-175 a review that reported findings stopped the member `awaiting-human`
with its only trace inside the member's worktree (`.belayd/review-findings.md`).
The bead looked healthy in bd, `needs-you` views did not list it, `bd ready` still
offered it, and the fleet's own `run.stopped[]` said "a human wait" in a detail
string nobody could join back to a gate — because there was no gate. The wait was
real and unfindable at the same time.

bd-175 made that wait a first-class Beads wait (bd-219 removed the wait, and
bd-286 removed the last gate):

| What happens now | Where it shows |
|---|---|
| A review with findings writes a record and a comment, **no gate** (bd-219, bd-286) | `.belayd/review-findings.json`, `bd show <bead>` → `[belayd:review]` comment |
| The findings are posted as an authored comment (refused if the outbound scan matches a secret rule, bd-286) | `bd show <bead>` → `[belayd:review]` comment |
| One `{finding, severity, phase, round, disposition}` entry per finding, dispositions `deferred` | `<worktree>/.belayd/review-findings.json` |
| A `belayd_ask_human` wait arms the existing human-answer poll, so answering resumes the member | comment on the bead, or `bd gate resolve <gate>` |
| The fleet reads the bead's **open gate** for its `awaiting-human` stop detail | `belayd_fleet_status`, `<git-common-dir>/belayd/fleet/<id>/fleet.json` |
| A live human wait is exempt from the 1 h idle cap and gets its own 12 h cap | `FLEET_RUN_MAX_HUMAN_WAIT_TICKS`, halt reason `awaiting-human` |
| A clean review keeps the old fast path | no gate, no comment, no record, no bd calls |

| Piece | Where |
|---|---|
| Record, comment body, the reason constants | `src/review-findings.ts` (`buildReviewFindingsRecord`, `formatReviewFindingsComment`, `REVIEW_FIX_LOOP_REASON`) |
| Finding trigger (which bullets count as findings) | `src/review-context.ts` (`parseReviewFindings` with `{ strict: true }`) via `hasReviewFindings` |
| Record + comment (no gate) | `extensions/capabilities/human-gate.ts` (`deliverReviewFindings`) |
| Wiring into the review delivery | `extensions/capabilities/phase-run.ts` (`deliverReviewFindingsIfFound`, `runCompleteLoopHint`) |
| Human-wait cap, halt reason, lease evidence | `src/fleet-run.ts` (`FLEET_RUN_MAX_HUMAN_WAIT_TICKS`, `FLEET_HUMAN_GATE_DETAIL`, `idleOrWait`, `retryIsAlive`) |
| The human-answer channel this reuses | `docs/bd-152-userguide.md` |

The fleet's `awaiting-human` detail is `FLEET_HUMAN_GATE_DETAIL`: the fleet waits on
any open bd human gate, which since bd-286 means a `belayd_ask_human` question.

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
pnpm scan:secrets
```

```text
$ tsc --noEmit
$ biome check .
Checked 383 files in 537ms. No fixes applied.
$ tsc

 Test Files  173 passed (173)
      Tests  4531 passed (4531)

 Test Files  16 passed (16)
      Tests  115 passed (115)

no leaks found
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
 ✓ src/__tests__/review-context.test.ts (63 tests) 35ms
 ✓ src/__tests__/review-findings.test.ts (20 tests) 27ms
 ✓ src/__tests__/extension-review-gate.test.ts (19 tests) 31ms
      Tests  102 passed (102)

 ✓ src/__tests__/fleet-run.test.ts (117 tests | 113 skipped) 5ms
      Tests  4 passed | 113 skipped (117)

 ✓ src/__tests__/extension-session-naming.test.ts (77 tests | 75 skipped) 1552ms
      Tests  2 passed | 75 skipped (77)
```

Case names worth knowing, by what they prove:

| Test (`src/__tests__/…`) | Proves |
| --- | --- |
| `extension-review-gate` › `records ordinary findings and leaves the member working (bd-219)` | comment stdin starting `[belayd:review]`, the record file, **no** gate, `awaitingHuman` undefined, no poll |
| `extension-review-gate` › `leaves a Suggestions-only review ungated too` | a Suggestions-only review is the orchestrator's triage, not a human decision |
| `extension-review-gate` › `leaves bd gate list empty after an ordinary findings review (acceptance)` | the literal "no gate" check: `lookupOpenHumanGate` returns `{ok: true, status: "none"}` |
| `extension-review-gate` › `refuses to post a findings comment that the outbound scan flags (bd-286)` | record still written, comment refused, rule ids only, no gate |
| `extension-review-gate` › `still posts when the outbound scanner is unavailable (bd-286)` | a missing scanner warns once and the comment still posts |
| `extension-review-gate` › `stays on the fast path for a clean review and writes nothing to bd` | **zero** bd calls, no record, no wait |
| `extension-review-gate` › `does not open a gate for a narration-only review` | narration bullets do not count as findings |
| `extension-review-gate` › `records an increasing round across re-reviews without a gate` | `round` comes from the persisted record, not memory |
| `extension-review-gate` › `warns but still posts the comment when the record write fails` | a read-only worktree still leaves the human-visible comment |
| `extension-review-gate` › `always emits the resumable-fix directive when no human wait is live` / `withholds the directive while a blocking human wait is live` | `runCompleteLoopHint` suppresses the directive only for a blocking wait (an open `belayd_ask_human` gate) |
| `review-findings` › `returns undefined for a clean review (the fast path writes nothing)` | no record for a clean review |
| `review-findings` › `renders the trace verbatim, with no gate or publication section (bd-286)` | the comment body carries no gate wording and no question |
| `review-findings` › `reads a v1 record written by an older harness that still carries the removed fields` | an existing record still reads; removed fields are stripped |
| `review-findings` › `reports an error and leaves no temp file behind when the rename fails` | atomic temp-rename write |
| `fleet-run` › `exempts an awaiting-human live wait from the idle cap (bd-175)` | 240 idle ticks on a lone live human wait is still `wait` |
| `fleet-run` › `reaches the 12h awaiting-human halt when the human wait is the only work (bd-175)` | `halt` / `awaiting-human` at 2880 ticks |
| `fleet-run` › `prefers the idle-cap stalled halt over a live human wait when a sibling is hung (bd-175)` | a hung non-human member still stalls at 1 h, naming the human wait |
| `fleet-run` › `records the human-gate detail verbatim in run.stopped[] (bd-219)` | the persisted entry is byte-identical to `FLEET_HUMAN_GATE_DETAIL` |
| `extension-session-naming` › `inlines the diff in a first review …` | a clean review delivery **keeps** `**When review findings remain:**` |
| `extension-session-naming` › `bounds a delivered review and drops its narration bullets (bd-113)` | a findings review through the real seam **keeps** that hint and names `belayd_test` |

### 3. Which review text becomes a finding

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
  console.log(`${hasReviewFindings(review) ? "RECORDS" : "ignores"}  ${bullet}`);
  if (parsed.length > 0) console.log(`         severity=${parsed[0]?.severity}`);
}
TS
sed -i "s|<repo>|$repo|g" /tmp/bd175-parse.ts
"$repo/node_modules/.bin/jiti" /tmp/bd175-parse.ts
```

```text
RECORDS  - `src/a.ts:5` — the cap is not applied when a sibling is in flight.
         severity=warnings
RECORDS  - Missing null check in `src/a.ts:5`.
         severity=warnings
ignores  - Verified: read `src/a.ts:5` and `src/b.ts`.
ignores  - Verified — race in `src/a.ts:5`.
ignores  - **Verified**: race in `src/a.ts:5`.
ignores  - Checked: race in `src/a.ts:5`.
RECORDS  - **Missing** null check in `src/a.ts:5`.
         severity=warnings
RECORDS  - Checkouts are broken in `src/a.ts:5`.
         severity=warnings
```

That output *is* the documented limitation (see
[Known trigger limitation](#known-trigger-limitation-a-verb-lead-bullet-with-a-defect-clause)):
`- Checked: race in src/a.ts:5` is dropped even though it restates a defect.

### 4. End-to-end: the record and the comment, no gate

The delivery's two artifacts are pure functions, so you can read them without a
live run (`node_modules/.bin/jiti` ships with the repo). `deliverReviewFindings`
scans the comment, writes the record and posts the comment — it never creates a
gate:

```bash
repo=$PWD
cat > /tmp/bd175-record.ts <<'TS'
import {
  buildReviewFindingsRecord,
  formatReviewFindingsComment,
} from "<repo>/src/review-findings.ts";

const review = `## Critical (must fix)

None

## Warnings (should fix)

- \`src/fleet-run.ts:1004\` — the human-wait cap is not applied when a second member is in flight.

## Suggestions (consider)

- \`src/review-findings.ts:210\` — the comment body could name the round.
`;
const record = buildReviewFindingsRecord({ taskId: "bd-6og", text: review, round: 1 });
if (record === undefined) throw new Error("no record for a findings review");
console.log(JSON.stringify(record, null, 2));
console.log("---- comment ----");
console.log(formatReviewFindingsComment(record));
TS
sed -i "s|<repo>|$repo|g" /tmp/bd175-record.ts
"$repo/node_modules/.bin/jiti" /tmp/bd175-record.ts
```

```text
{
  "schemaVersion": 1,
  "taskId": "bd-6og",
  "phase": "review",
  "round": 1,
  "reason": "awaiting the fix loop in this workflow",
  "artifactPath": ".belayd/review-findings.md",
  "findings": [
    {
      "finding": "`src/fleet-run.ts:1004` — the human-wait cap is not applied when a second member is in flight.",
      "severity": "warnings",
      "phase": "review",
      "round": 1,
      "disposition": {
        "kind": "deferred",
        "reason": "awaiting the fix loop in this workflow"
      },
      "dispositionSource": "default"
    },
    {
      "finding": "`src/review-findings.ts:210` — the comment body could name the round.",
      "severity": "suggestions",
      "phase": "review",
      "round": 1,
      "disposition": {
        "kind": "deferred",
        "reason": "awaiting the fix loop in this workflow"
      },
      "dispositionSource": "default"
    }
  ]
}
---- comment ----
## Review findings (round 1)

**Reason:** awaiting the fix loop in this workflow

**Findings:** 2 (Critical: 0, Warnings: 1, Suggestions: 1)

Full findings: `.belayd/review-findings.md`

### Warnings (should fix)
- `src/fleet-run.ts:1004` — the human-wait cap is not applied when a second member is in flight. — deferred — awaiting the fix loop in this workflow

### Suggestions (consider)
- `src/review-findings.ts:210` — the comment body could name the round. — deferred — awaiting the fix loop in this workflow

### Next step
No human decision is required: address every Critical and Warning in the fix loop
(`belayd_implement` with these findings, then `belayd_review`). Escalate with
`belayd_ask_human` only if a Critical finding should not be implemented (a product, risk
or scope decision), or you found a contradiction the bead and the repo cannot resolve.
```

Two writes land: the record at `.belayd/review-findings.json` and the comment on
the bead (with `[belayd:review]` as its first line, added by `phaseCommentBody`).
There is no gate: `bd gate list <bead>` stays empty, the bead stays in `bd ready`,
and the orchestrator runs the fix loop.

The one thing that can suppress the comment is the outbound scan: when a finding
quotes credential material, `src/secret-scan.ts` refuses to post and the log names
the betterleaks rule ids only, never the match text. The record keeps the finding
text on purpose — `.belayd/` is allowlisted in `.betterleaks.toml` because local
state must keep what must not leave the machine. The fix is to name the location
in prose instead of quoting the value; `betterleaks:allow` is the escape hatch for
an intentional fixture.

### 5. A re-review bumps the round; there is nothing to answer

`round` is read back from the persisted record (`nextReviewRound`) before the
record is overwritten, so delivering the same findings again in the same worktree
writes `round: 2`, then `3`, with no gate and no answer in between. A clean review
writes nothing, so it neither advances the round nor clears the previous record —
the next findings review does that with `round + 1`.

The only human gate a workflow can still open is `belayd_ask_human`, the
orchestrator's own escalation for a decision it may not take. It is a separate
path; see `docs/bd-152-userguide.md` (the answer channel) and
`docs/bd-219-userguide.md` (the review trace and the ask path side by side).

### 6. The clean-review fast path writes nothing

The same function returns `undefined` for a clean review, and the delivery returns
`{recorded: false, reason: "the review reported no findings"}` without touching bd
or creating `.belayd/`:

```bash
repo=$PWD
cat > /tmp/bd175-clean.ts <<'TS'
import {
  REVIEW_NO_FINDINGS_REASON,
  buildReviewFindingsRecord,
} from "<repo>/src/review-findings.ts";

const CLEAN = `## Warnings (should fix)

None

## Suggestions (consider)

- Verified: read src/fleet-run.ts and src/review-findings.ts
`;
const record = buildReviewFindingsRecord({ taskId: "bd-6og", text: CLEAN, round: 1 });
console.log("record:", JSON.stringify(record));
console.log("reason:", REVIEW_NO_FINDINGS_REASON);
TS
sed -i "s|<repo>|$repo|g" /tmp/bd175-clean.ts
"$repo/node_modules/.bin/jiti" /tmp/bd175-clean.ts
```

```text
record: undefined
reason: the review reported no findings
```

Nothing on disk, so the reader returns `undefined` and no `.belayd/` directory is
even created.

### 7. The fleet side: one reason string, two caps

The fleet's decision layer is pure, so the run's view can be printed without a
fleet. The wait below is an open `belayd_ask_human` gate (`humanGateOpen: true`) —
the only kind of human gate a workflow has:

```bash
cd "$repo"
cat > /tmp/bd175-fleet.ts <<'TS'
import {
  FLEET_HUMAN_GATE_DETAIL,
  FLEET_RUN_MAX_HUMAN_WAIT_TICKS,
  FLEET_RUN_MAX_IDLE_TICKS,
  deriveFleetMemberProgress,
  formatFleetRunStops,
  planFleetTick,
  recordRunMemberStopped,
  startFleetRun,
} from "<repo>/src/fleet-run.ts";

const PHASES = ["plan", "implement", "review", "test", "userguide", "proof", "commit"];
const intentBase = {
  schemaVersion: 1, fleetId: "default", taskIds: ["bd-12"], createdAt: 1_000, updatedAt: 1_000,
};

// The workflow snapshot the fleet really reads: review completed, no later phase yet,
// plus an open `belayd_ask_human` gate on the bead.
const progress = deriveFleetMemberProgress({
  taskId: "bd-12",
  workflow: {
    kind: "ok",
    completedPhaseNames: ["plan", "implement", "review"],
    phaseOrder: PHASES,
  },
  runs: [],
  humanGateOpen: true,
  now: 5_000,
});
console.log("progress:", JSON.stringify(progress));

const stopped = recordRunMemberStopped({
  run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
  taskId: "bd-12",
  reason: "awaiting-human",
  detail: FLEET_HUMAN_GATE_DETAIL,
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
progress: {"kind":"awaiting-human","detail":"waiting on an open human gate on the bead"}
run.stopped[]: ["stopped bd-12 (awaiting-human): waiting on an open human gate on the bead"]
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
stopped bd-12 (awaiting-human): waiting on an open human gate on the bead
```

### 8. Clean up

```bash
rm -f /tmp/bd175-parse.ts /tmp/bd175-record.ts /tmp/bd175-clean.ts /tmp/bd175-fleet.ts
```

## How to Use

### What changes in your day

> **bd-219/bd-286:** a review that reports findings is no longer a question you
> answer. The member writes the record and the `[belayd:review]` comment, then runs
> its own fix loop; no gate opens and nothing waits on you. The only human gate
> left is `belayd_ask_human`, which the orchestrator opens only for a decision it
> may not take.

1. The review phase finishes with findings.
2. The delivery scans the comment, writes `.belayd/review-findings.json` and posts
   the `[belayd:review]` comment on the bead (round `N`, read back from the
   previous record).
3. **Nothing is blocked**: the bead stays in `bd ready`, `bd gate list` is empty,
   and the orchestrator's run-complete delivery carries the
   ``**When review findings remain:**`` directive naming `belayd_implement`, then
   `belayd_review`.
4. The fix loop addresses the findings. The next review writes round `N + 1` over
   the same record, and the earlier `[belayd:review]` comments stay in the bead
   thread as the history.

Nothing type-checks or runs differently: the findings are work, not a decision
point.

### Reading the record

```bash
wt=$(git rev-parse --show-toplevel)
jq -r '[.round, .reason] | @tsv' "$wt/.belayd/review-findings.json"
jq -r '.findings[] | [.severity, .disposition.kind, .finding] | @tsv' "$wt/.belayd/review-findings.json"
bd comments <bead> --json | jq -r '.[] | [.author, (.text|split("\n")[0])] | @tsv'
```

What a finding's `deferred` disposition means: at delivery nothing has been
addressed yet, so every finding is recorded as
`{"kind":"deferred","reason":"awaiting the fix loop in this workflow"}`. The record
is the machine-readable list the fix loop works from;
`.belayd/review-findings.md` (the review agent's own scratchpad, the path the
comment points at) keeps the full text.

`round` is `1` on the first findings review and increments on every later one,
because it is read back from the record before it is overwritten. A clean review
writes nothing, so it neither advances the round nor clears the previous record —
the next findings review does that with `round + 1`.

An older record still reads: the schema version was not bumped, so a record
written before bd-219 (reason `workflow is waiting for a review response`) or one
still carrying the removed per-finding `sensitivity`/`publication` fields is read
as-is, with the removed fields stripped; the next review overwrites it.

### Watching the fleet: a live wait versus a dead member

`belayd_fleet_status` (and the run record) now distinguishes the two cases. The
wait is an open `belayd_ask_human` gate — a review never produces one:

| Situation | Status line | Meaning |
|---|---|---|
| Member with an open `belayd_ask_human` gate, answer poll alive | `stopped bd-175 (awaiting-human): waiting on an open human gate on the bead` | Healthy wait. The run stays open and waits for you |
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
semantics live in `docs/fleet-run.md`; this guide only adds the human-wait caps.

### Known trigger limitation: a verb-lead bullet with a defect clause

The trigger is lexical. A bullet that opens with a past-tense check verb
(`checked`, `verified`, `tested`, `reviewed`, backticked or not) is treated as
narration and does **not** become a finding — even when a `:`/`—` clause after it
restates a present-tense defect:

```text
- Checked: race in src/a.ts:5        → no finding
- Verified — race in src/a.ts:5     → no finding
```

The tradeoff is deliberate: separating that clause from an affirmation
(`- Checked: all fine`) needs a defect lexicon, and a wrong guess *records and
posts a finding for nothing* — exactly the failure the narration rule exists to
prevent.

**Workaround:** write the defect without the check-verb prefix, location first
(which is already the review output contract):

```text
- `src/a.ts:5` — race between the guard check and the record write.
```

Two related nuances:

- Emphasis is styling, not a different marker: `- **Verified**: race in
  src/a.ts:5` behaves exactly like `- Verified: race in src/a.ts:5` (no finding),
  while `- **Missing** null check in src/a.ts:5` and `- Checkouts are broken in
  src/a.ts:5` are findings.
- Nothing is lost when the trigger misses: the review transcript and
  `.belayd/review-findings.md` still carry the text, and the review delivery still
  reaches the orchestrator. Only the *bd-visible* `[belayd:review]` trace is
  skipped.

### When the comment does not appear

Every failure is best-effort, and each one has a distinct signature. A review
with findings writes the record and the comment and opens **no** gate — and since
bd-286 no review gates at all.

| What you see | Cause | What to do |
|---|---|---|
| Record, **no** `[belayd:review]` comment | the comment write failed (warned as `could not post the review findings comment`), or the outbound scan refused it because the text matches a secret rule (`refused to post: …`) | The record is the trace: read `.belayd/review-findings.md`, and re-post the findings in prose naming the location instead of the value |
| Comment, **no** `.belayd/review-findings.json` | record write failed (read-only worktree) — warned as `could not record the review findings` | Nothing blocks: the comment is the human-visible record |
| `reason: "a review delivery is already in progress"` | a concurrent review delivery holds the reservation | Exactly one delivery is ever recorded; nothing else to do |
| `reason: "invalid task id …"` | the bead id is not in the `bd-<alnum>` shape | Use a normal bead id (this is the guard that keeps a crafted id out of bd argv) |
| Findings: record + comment, no gate | intended (bd-219, bd-286) | Run the fix loop (`belayd_implement`, then `belayd_review`) |
| Clean review: no comment, no record | intended | Nothing — advance as before |

Every one of those warnings is prefixed `[belayd-harness]`, so the daemon log
carries the same text as the terminal. Each failure has exactly one owner in the
log: the delivery seam logs the comment failures (`could not post the review
findings comment`, including a scan refusal); the phase runner logs only a skipped
record (`review findings were not fully delivered`); and the record write logs
`could not record the review findings`. Search the log for those strings.

### Rules of thumb

- **Answer a `belayd_ask_human` gate in the thread; an approval note is the
  fallback.** A comment on the work bead is the answer channel (Scotty's gate card
  cannot post one — open the bead it says it unblocks, or `bd comment <bead>
  --stdin`). Resolving the gate instead (`bd gate resolve <gate> --reason "…"`, or
  Scotty's **Add approval note** + **Approve**) resumes the member with the reason
  as a note; with no reason it resumes on "resolved without a comment", so the
  decision leaves no text behind. A gate that simply disappears still reads as an
  out-of-band resolution.
- **A review needs no answer.** Findings are work for the fix loop: read the
  `[belayd:review]` comment, then let the orchestrator run `belayd_implement` →
  `belayd_review`. Do not look for a review gate; there is none to resolve.
- **Do not treat a long wait as a hang.** A live human wait is exempt from the 1 h
  idle cap on purpose; only `stalled` means a member is at fault.
- **A `halted: awaiting-human` run needs a re-arm**, not a resume: any halt is
  terminal for that run record, so answer the gate and then
  `/fleet <ids> --fleet <id>`.
- **Write findings location-first.** `- \`file:line\` — defect.` always becomes a
  finding; `- Checked: defect in file:line` does not.

Related: `docs/fleet-run.md` (tick order, run record, the human-gate stop and its
`awaiting-human` cap), `docs/bd-152-userguide.md` (the human-answer channel and
`belayd_ask_human`), `docs/bd-219-userguide.md` (the review trace, no gate),
`docs/diff-scoped-review.md` (the review process, the `.belayd/review-findings.md`
scratchpad), `src/review-findings.ts`, `extensions/capabilities/human-gate.ts`,
`src/fleet-run.ts`.
