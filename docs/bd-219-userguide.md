# A findings review is a trace, not a gate — and the fleet waits only on a real bd human gate (bd-219)

> **bd-286 note.** The bd-183 sensitive-findings classifier and its publication
> gate were deleted. No review opens a gate any more; the only human gate is
> `belayd_ask_human`, and secrets are `betterleaks`' job (`.betterleaks.toml`,
> `pnpm scan:secrets`). Read every "security-class" line below as history.

Before bd-219 every review that reported findings opened a bd `human` gate. The
orchestrator was blocked on a question — "should these findings be addressed?" —
whose answer was always "yes, fix them", once per review round. bd-219 removes
that wait and keeps only the one review decision a person must actually take:
whether anything about a **security-class** finding may be published — a split
> bd-286 later removed (see the note above).

| What happens on a review that reports findings | Before (bd-175) | Now (bd-219) |
|---|---|---|
| `.belayd/review-findings.json` + `[belayd:review]` comment | written | written (unchanged) |
| bd `human` gate | always | **only** for a security-class finding |
| `state.awaitingHuman` / 30 s answer poll | set | **untouched** (no wait, no poll) |
| Run-complete delivery | `**When review findings remain:**` withheld | carries it, naming the next phase tool |
| Fleet member after the review | `awaiting-human`, 12 h cap | `active`, normal 1 h `stalled` cap |
| Fleet `awaiting-human` evidence | the review phase flag | an open bd `human` gate on the bead |

| Piece | Where |
|---|---|
| Record, comment body, `REVIEW_FIX_LOOP_REASON` | `src/review-findings.ts` |
| The delivery: record + comment, no gate (bd-286) | `extensions/capabilities/human-gate.ts` → `deliverReviewFindings`, `reviewDeliveryReason` |
| Wiring into the review completion | `extensions/capabilities/phase-run.ts` → `deliverReviewFindingsIfFound`, `runCompleteLoopHint`, `warnOnSkippedReviewFindings` |
| The escalation policy both guidance sites emit verbatim | `extensions/capabilities/review.ts` → `HUMAN_ESCALATION_LINES` |
| Per-member gate read in the run loop, bounded concurrency 4 | `extensions/capabilities/fleet.ts` → `observeFleetMember`, `readMemberHumanGate`, `readMemberObservationsBounded` |
| `awaiting-human` from the gate read, `FLEET_HUMAN_GATE_DETAIL` | `src/fleet-run.ts` → `deriveFleetMemberProgress`, `FLEET_HUMAN_GATE_DETAIL` |
| `awaiting-human` from the engagement read in the status view | `src/fleet-status.ts` → `deriveFleetMemberState`, `applyFleetBeadEngagement` |

## How to Verify

Run everything from the repository root of this worktree.

### 1. The suite that names the behaviour

```bash
pnpm test -t "bd-219"
```

```text
 ✓ src/__tests__/workflow-digest.test.ts (21 tests | 20 skipped)
 ✓ src/__tests__/review-findings.test.ts (55 tests | 51 skipped)
 ✓ src/__tests__/fleet-run.test.ts (111 tests | 107 skipped)
 ✓ src/__tests__/fleet-status.test.ts (135 tests | 131 skipped)
 ✓ src/__tests__/extension-review-gate.test.ts (35 tests | 31 skipped)
 ✓ src/__tests__/review-flag-not-a-wait.test.ts (3 tests)
 ✓ src/__tests__/extension-fleet-p1.test.ts (139 tests | 138 skipped)

 Test Files  7 passed | 157 skipped (164)
      Tests  21 passed | 4551 skipped (4572)
```

What each test pins, by acceptance criterion:

| Test (`src/__tests__/…`) | Pins |
| --- | --- |
| `extension-review-gate` › `records ordinary findings and leaves the member working (bd-219)` | `{recorded: true, reason: "awaiting the fix loop in this workflow"}`, `awaitingHuman` and the poll timer unset, no `gate create`, and the posted body (`## Review findings (round 1)`, `### Next step`, no `### Question`) |
| `extension-review-gate` › `leaves a Suggestions-only review ungated too` | a Suggestions-only review is the orchestrator's triage, not a human decision |
| `extension-review-gate` › `leaves bd gate list empty after an ordinary findings review (acceptance)` | `lookupOpenHumanGate` returns `{ok: true, status: "none"}` after the delivery — the literal "no gate" acceptance check |
| `extension-review-gate` › `stays on the fast path for a clean review and writes nothing to bd` / `does not open a gate for a narration-only review` | clean and narration-only reviews stay silent |
| `extension-review-gate` › `human escalation policy (bd-219)` › `names only the two escalation conditions and the do-not-ask list, in both blocks` | both guidance sites emit `HUMAN_ESCALATION_LINES` verbatim, exactly two bullets, no "always ask"/"ask whenever" |
| `extension-review-gate` › `runCompleteLoopHint` › `always emits the resumable-fix directive when no human wait is live` / `withholds the directive while a blocking human wait is live` | the delivery names the next phase tool for a findings review; only a blocking human wait suppresses it |
| `review-flag-not-a-wait` (whole file) | `awaitingReviewResponse` changes nothing: fleet progress, fleet state, digest text, the run-complete directive and the human-wait guidance |
| `fleet-run` › `keeps a post-review member running, not awaiting a human (bd-219)` / `is awaiting-human for an open human gate on the bead (bd-219)` | progress derives from `humanGateOpen`, not the phase flag |
| `fleet-status` › `reads a post-review member as active, not awaiting-human (bd-219)` / `reads an open bd human gate as awaiting-human (bd-219)` | the status view's `state` |
| `fleet-status` › `reads a member with an open human gate as awaiting-human (bd-219)` / `never overrides missing-state or interrupted with a gate wait (bd-219)` | the engagement path (`bd gate list`) sets `awaiting-human`, but never masks `missing-state`/`interrupted` |
| `workflow-digest` › `renders no human wait for a post-review member with no open gate (bd-219)` | the digest no longer prints a review-response wait line |
| `extension-fleet-p1` › `waits on the member's open bd human gate, never on the review phase flag (bd-219)` | the tick wiring itself: same member + flag + no gate stays `running`; adding an open `human` gate stops it `awaiting-human` |
| `extension-session-naming` › `bounds a delivered review and drops its narration bullets (bd-113)` | the real phase-run → seam call: record written, `[belayd:review]` comment posted, **zero** `bd gate` calls, delivery names `belayd_test` |

### 2. An ordinary findings review produces a record and a comment, and no gate

The record and the comment body are pure functions, so you can read them without
a live run (`node_modules/.bin/jiti` ships with the repo):

```bash
repo=$PWD
sed "s|<repo>|$repo|g" > /tmp/bd219-record.ts <<'TS'
import {
  buildReviewFindingsRecord,
  formatReviewFindingsComment,
} from "<repo>/src/review-findings.ts";

const text = [
  "## Critical (must fix)",
  "- `src/a.ts:12` — off-by-one in the loop bound",
].join("\n");
const record = buildReviewFindingsRecord({ taskId: "bd-42", text, round: 1 });
if (record === undefined) throw new Error("no record for a findings review");
console.log(JSON.stringify(record, null, 2));
console.log("---- comment ----");
console.log(formatReviewFindingsComment(record));
TS
node_modules/.bin/jiti /tmp/bd219-record.ts
```

```text
{
  "schemaVersion": 1,
  "taskId": "bd-42",
  "phase": "review",
  "round": 1,
  "reason": "awaiting the fix loop in this workflow",
  "artifactPath": ".belayd/review-findings.md",
  "findings": [
    {
      "finding": "`src/a.ts:12` — off-by-one in the loop bound",
      "severity": "critical",
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
Review findings (round 1)

Reason: awaiting the fix loop in this workflow

Findings: 1 (Critical: 1, Warnings: 0, Suggestions: 0)

Full findings: .belayd/review-findings.md

Critical (must fix)
- src/a.ts:12 — off-by-one in the loop bound — deferred — awaiting the fix loop in this workflow

Next step
No human decision is required: address every Critical and Warning in the fix loop
(`belayd_implement` with these findings, then `belayd_review`). Escalate with
`belayd_ask_human` only if a Critical finding should not be implemented (a product, risk
or scope decision), or you found a contradiction the bead and the repo cannot resolve.
```

The comment is posted with `[belayd:review]` as its first line (added by
`phaseCommentBody`); the `#` markers are stripped from the excerpt above so it
stays inside this section. The full body, headings and all, is quoted under
[How to Use](#how-to-use).

`round` comes from the record already in the worktree (`nextReviewRound`), so a
re-review in the same worktree writes `round 2`, `round 3`, … with no gate in
between.

On a live workflow (started with `/belayd bd-42` or `belayd_start_task`), after
the review phase reports findings, read the trace from inside the member worktree
(`<repo>.feat-bd-42`):

```bash
jq '{round, reason, finding: .findings[0]}' .belayd/review-findings.json
bd comments bd-42 --json | jq -r '.[-1].text[0:200]'
```

And the gate check, from wherever bd resolves this project's database (normally
the repository root):

```bash
bd gate list bd-42 --json          # null — bd's empty-list rendering
```

Expected: the record above, `null` from `bd gate list`, and a comment starting
`[belayd:review]` / `## Review findings (round N)` with a `### Next step`
section. There is no `### Question` section any more — that is the observable
difference from the bd-175 comment, which older rounds on a bead still carry.
The run-complete message in the orchestrator session ends with a line that starts
`` **When review findings remain:** `` and names the next phase tool
(`belayd_implement`, then `belayd_review`, then the phase after review).

### 3. The fleet reads the gate, not the review flag

Deterministic, no live fleet:

```bash
pnpm test src/__tests__/extension-fleet-p1.test.ts -t "waits on the member's open bd human gate"
pnpm test src/__tests__/fleet-status.test.ts src/__tests__/fleet-run.test.ts -t "bd-219"
```

```text
 ✓ src/__tests__/extension-fleet-p1.test.ts (139 tests | 138 skipped) 502ms
   ✓ fleet run mode > waits on the member's open bd human gate, never on the review phase flag (bd-219)  500ms
      Tests  1 passed | 138 skipped (139)

 ✓ src/__tests__/fleet-run.test.ts (111 tests | 107 skipped)
 ✓ src/__tests__/fleet-status.test.ts (135 tests | 131 skipped)
      Tests  8 passed | 238 skipped (246)
```

In a supervisor session, `belayd_fleet_status` on a member whose review reported
ordinary findings shows (abridged from `formatMember`):

```text
Member bd-12 — active
  workflow: feature 3/5 phases complete
  pending: test, commit
  awaiting review response: yes
```

`awaiting review response: yes` is the phase flag printed for information; the
member is still `active`. With an open human gate on the same bead the header
becomes `Member bd-12 — awaiting-human` (and the result's `counts` map puts that
member under `awaiting-human`).
`belayd_workflow_digest` for that member prints `- state: active` with
`- waiting on: nothing (no open gate)`; a member on a gate prints the gate, and an
unreadable gate read prints `- waiting on: unknown (gate read failed: …)`.

A run loop ticking over such a member applies the 1 h `stalled` cap
(`FLEET_RUN_MAX_IDLE_TICKS = 240`); only a member with an open gate gets the 12 h
`awaiting-human` cap (`FLEET_RUN_MAX_HUMAN_WAIT_TICKS = 2880`) and the halt
detail from `FLEET_HUMAN_GATE_DETAIL`
(`waiting on an open human gate on the bead`).

### 4. Clean up

```bash
rm -f /tmp/bd219-record.ts /tmp/bd219-sample.ts
```

## How to Use

### The `[belayd:review]` comment is a trace, not a question

Every findings review posts one comment on the bead (or on the mapped GitHub
issue for a GitHub-primary repo) as the workflow actor
`belayd:<bead>:orchestrator`. It is grouped by severity, names each finding's
disposition and the full-findings artifact, and closes with `### Next step`. A
human reads it to see what the review found; the orchestrator reads it to know it
must run the fix loop. Nothing in it is a question you have to answer.

The body, verbatim (from `formatReviewFindingsComment`):

```text
[belayd:review]
## Review findings (round 1)

**Reason:** awaiting the fix loop in this workflow

**Findings:** 1 (Critical: 1, Warnings: 0, Suggestions: 0)

Full findings: `.belayd/review-findings.md`

### Critical (must fix)
- `src/a.ts:12` — off-by-one in the loop bound — deferred — awaiting the fix loop in this workflow

### Next step
No human decision is required: address every Critical and Warning in the fix loop
(`belayd_implement` with these findings, then `belayd_review`). Escalate with
`belayd_ask_human` only if a Critical finding should not be implemented (a product, risk
or scope decision), or you found a contradiction the bead and the repo cannot resolve.
```

The `[belayd:review]` header is what keeps the comment from ever counting as a
human answer, and `### Next step` is where the orchestrator learns what to do.
A bd-175-era comment instead ended with `### Question` — if you see that, the
round predates bd-219.

### What "no gate" means

- **Nobody is being asked.** The fix-loop contract already says every Critical
  and Warning must be addressed, so the decision belongs to the orchestrator.
- **The bead is not blocked.** `bd gate list <bead>` is empty, and the review
  leaves the bead's own `bd ready`/`bd blocked` status alone.
- **The turn that can fix them is told how.** The run-complete delivery carries
  the `` **When review findings remain:** `` directive with the next phase tool,
  and the gate context repeats the fix-loop directive each turn. It is withheld
  only while a blocking human wait is live, because a blocked member could not act
  on it.
- **`awaiting review response: yes` in `belayd_fleet_status` is not a wait.** It
  is the persisted review phase flag, and the one thing it still drives is the
  gate context's per-turn next-step line (`Review findings need addressing. …`
  plus the same fix-loop directive), so the orchestrator is reminded how to
  proceed until the next phase completes.

### Escalate only for the two decisions you may not take

Both guidance sites (`humanAnswerGuidanceLines` every turn, and
`reviewFindingsGuidanceLines` at workflow start) emit the same lines, verbatim:

```text
**Escalate to a human only when you cannot decide it yourself** — `belayd_ask_human`, then END YOUR TURN: it posts the question, opens a `human` gate and refuses every phase tool until an answer arrives. Two conditions, nothing else:
- a Critical finding you believe must NOT be implemented (a product, risk or scope decision you may not take);
- a contradiction you cannot resolve from the bead and the repo (conflicting findings, spec vs code, incompatible requirements).
Never escalate for what you can decide: findings you can fix, Suggestions triage, which fix to do, how to proceed, or grooming/merge/close choices.
```

When the orchestrator does call `belayd_ask_human`, you get what bd-175 used to
give every review: the question as a comment, a `human` gate with bd's default
title, and a member that reads `awaiting-human`. Answer by commenting on the bead
(or on the mapped issue) or by `bd gate resolve <gate-id>`; the answer arrives in
the orchestrator session and the workflow resumes.

## Known limits

- **The informational line still prints the flag.** `belayd_fleet_status` keeps
  `awaiting review response: yes|no` from `workflow.json`. It is a phase fact, not
  a wait predicate: no fleet member state, run cap or halt decision reads it (the
  review round's per-turn next-step line does).
- **An older record keeps its old shape.** `.belayd/review-findings.json` written
  before this change reads back as-is (`reason: "workflow is waiting for a review
  response"`, no `dispositionSource`), because the schema version was deliberately
  not bumped; the next review round overwrites it with the shape shown above.
- **The finding trigger is lexical.** Which bullets count as findings is decided
  by `parseReviewFindings` with `{ strict: true }`: a bullet that opens with a
  past-tense check verb is narration and is not recorded, even when a clause after
  it restates a defect.
- **The record is per worktree and per round.** `.belayd/review-findings.json` is
  overwritten on every review, so it describes the latest round only; the bead
  comment thread is the history.
- **The sensitive-findings machinery is gone (bd-286).** The classifier, the
  publication gate and the decision record were deleted; no review opens a gate,
  so a post-review member is always `active`.
- **bd-175's guide now describes the no-gate trace.**
  `docs/bd-175-userguide.md` was rewritten for bd-286: it documents the record,
  the comment and the fleet's human-wait caps, with no review gate. Only its proof
  dir (`docs/proof/bd-175/`) keeps the historical gate recordings, banner-marked
  as pre-bd-219 evidence.
