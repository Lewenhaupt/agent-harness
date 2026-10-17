# Diff-scoped review, scoped re-review, bounded review output (bd-113)

Review was 47% of recorded Belayd workflow spend, and most of that spend
produced no Critical finding: the reviewer re-derived the change set the
implement phase already knew, re-explored the whole repository on every
re-review, and emitted narration bullets that invited a longer answer.

bd-113 narrows review **scope** and review **output shape**. Nothing changes
for the person driving the workflow: `belayd_review` keeps the same name and
the same `task` argument, and the reviewer's model class is untouched. Three
things change behind that tool:

1. **A first review receives the change set inline.** The review task now
   carries the diff stat, the changed-file list, the untracked-file list, and
   the diff itself (bounded), plus an instruction to read only files in the
   diff rather than re-deriving it with `git diff` / `git status` / repo-wide
   searches.
2. **A re-review is scoped to the fix round.** When a review completes
   successfully, the harness records `HEAD` as `reviewedSha` in
   `.belayd/workflow.json`. The next `belayd_review` call for that task diffs
   from that SHA, so the reviewer sees only the fix diff plus the orchestrator's
   task text (which already enumerates the findings to verify).
3. **The delivered review is bounded.** Critical/Warnings/Suggestions are capped
   at 6 / 6 / 4 bullets, an empty section must be exactly `None`, verification
   narration is dropped, and any dropped bullet is disclosed in the report (a
   truncated inlined diff is disclosed in the review task).

Review depth is not reduced: the adversarial/security mandate and the reviewer's
tool set (`bash`, `ast_grep`, `read`, `grep`, `find`, `ls`, the web-search
tools) are unchanged, and review still runs on the `standard` model class. A
docs-only diff gets a **narrowed instruction set** (factual/structural checks
only), not a weaker reviewer.

## How to Use

No workflow change is required. Continue calling the phase tools as before:

```
belayd_start_task { taskId: "bd-42" }
belayd_implement   { task: "..." }
belayd_review      { task: "Review the implementation." }        # first review
belayd_implement   { task: "<the findings to fix>" }             # fix round
belayd_review      { task: "<the findings to verify>" }          # automatically fix-scoped
```

### What a first-review task looks like (inlined change set)

````
## Review scope — diff inlined, do NOT re-derive the change set
mode: first review
range: 1a2b3c4
changed files: 2 (docs-only diff: no)

Read only files in this diff and, when a call site genuinely matters, their
direct callers. Do not run `git diff`/`git status`/repo-wide searches to
rediscover the change set.

## Changed files
 src/foo.ts | 12 ++++++---
 src/new.ts |  4 ++++
 2 files changed, 10 insertions(+), 6 deletions(-)

New (untracked) files — read these directly; they are not in the diff:
- `src/new.ts`

```diff
<the diff from the merge base of main, working tree included>
```

## Output contract
Emit exactly these sections, in this order: `## Critical (must fix)`, ...
## Task
<your params.task>
````

The `range:` value is the SHA the review diffed from: `git merge-base main HEAD`
for a first review (so uncommitted work is reviewed too). If the merge base
cannot be computed (shallow clone, unrelated histories), the harness diffs
against the base-branch tip and says so in `range:`.

### What a re-review task looks like (fix-scoped)

After a successful review, `.belayd/workflow.json` gains a `reviewedSha`. The
next review for the same task renders as `mode: re-review of fixes` with
`range: <reviewedSha>`, and the inlined diff is only `git diff <reviewedSha>`.
No separate "prior findings" section is added, because your `task` text already
lists the findings.

### Fallbacks you may see

| Situation | What the reviewer is told |
|---|---|
| Fix diff cannot be computed (commonly the recorded SHA was removed by a rebase) | The task is prefixed with `> Note: the fix-only diff since the previously reviewed revision could not be computed (<git error>). This review covers the whole change set instead.` and falls back to a `mode: first review` task |
| No diff can be collected at all | The task opens with the header **Review scope — diff unavailable**, names the git error that caused it, and tells the reviewer to fall back to its own git diff/status to establish the change set; the no-discovery instruction is dropped |
| An inlined diff exceeds 800 lines or 60 KB | The diff is cut and ends with ``... (diff truncated: N more lines; run `git diff <range>` for the rest)`` |

The scope is never silently widened or narrowed: a fallback always carries the
git error that caused it in the task text, and a `reviewedSha` on disk is only
used when it belongs to the task being reviewed (a stale `workflow.json` from
another task is ignored).

### Bounded output

Per-section caps are hardcoded in `src/review-context.ts`
(`REVIEW_SECTION_LIMITS`, no env var or settings knob):

| Section | Max bullets |
|---|---|
| `## Critical (must fix)` | 6 |
| `## Warnings (should fix)` | 6 |
| `## Suggestions (consider)` | 4 |

When bullets are dropped, the section ends with
`- (+N more omitted; see the full findings in the review transcript)`. Bullets
that are not findings — for example one that only reports a check succeeded, or
one that restates what the code does — are dropped and disclosed with
`- (+N malformed bullets dropped; see the full findings in the review transcript)`.
An empty section should read exactly `None` — the contract requires it, bounds
preserve `None` verbatim, and no "looks correct" bullets are ever added. When a
section contained only narration, the drops are disclosed and the section body
is left empty.

The report you see is therefore the **most severe** items, not the whole
transcript: for a long review the full sub-agent transcript (all bullets, all
narration) remains on disk and can be read at any time — see below.

Bounds apply only to a **successful** review delivery. A failed review run's
text is error output and is delivered verbatim.

### Model routing

Unchanged. `belayd-reviewer` still declares `modelClass: "standard"` (see
`docs/agent-model-class.md`), and the harness overrides nothing per diff size.
A docs-only diff adds one instruction line — check factual/structural
correctness (links, commands, code samples, duplicated claims) — and does not
switch models.

### Inspecting what was reviewed

- Recorded revision: `.belayd/workflow.json` → `reviewedSha`.
- The fix diff a re-review inlined: `git diff <reviewedSha>`.
- The whole change set a first review inlined: `git diff $(git merge-base main HEAD)`.
- The review task text itself: the review sub-agent's session transcript under
  `~/.pi/agent/sessions/<project-slug>/` (see "How to Verify" below). The run
  manifest `.belayd/runs/<runId>.json` records `phase`, `sessionName`, and
  status, but not the task text.

## How to Verify

Run these from the repository root.

1. **Automated coverage** — all gates must pass:

   ```bash
   pnpm test
   pnpm test:integration
   pnpm typecheck
   pnpm lint
   pnpm build
   ```

   The bd-113 coverage lives in:

   ```bash
   pnpm vitest run src/__tests__/review-context.test.ts
   pnpm vitest run src/__tests__/extension-session-naming.test.ts
   pnpm vitest run src/__tests__/workflow-state.test.ts
   pnpm vitest run src/__tests__/agent-registry.test.ts
   ```

   `review-context.test.ts` covers section caps + omission notes, narration
   drops, idempotence, docs-only classification, untracked-file collection,
   the re-review range, the diff truncation limits, and task rendering.
   `extension-session-naming.test.ts` covers the end-to-end paths: inlined
   first review, fix-scoped re-review, bounded delivery, the disabled
   bounding on a failed run, the unavailable-diff disclosure, the
   whole-change-set fallback note, and the foreign-task `reviewedSha` guard.
   `workflow-state.test.ts` covers `saveReviewedSha` round-trip, the
   `missing-state` / `task-mismatch` cases, and parsing a pre-bd-113
   `workflow.json`. `agent-registry.test.ts` asserts the reviewer prompt keeps
   the security mandate and review tools while carrying the shared output
   contract and dropping `## Files Reviewed`.

2. **First review gets the diff inline** — run a workflow up to review
   (`belayd_start_task` → `belayd_implement` → `belayd_review`), then read the
   review sub-agent's task text from its transcript:

   ```bash
   f=$(ls -t ~/.pi/agent/sessions/*/*belayd-*-sub-review-*.jsonl | head -1)
   jq -r 'select(.type=="message" and .message.role=="user") | .message.content[0].text' "$f" | head -40
   ```

   Expected: the text starts with
   `## Review scope — diff inlined, do NOT re-derive the change set` and
   `mode: first review`, later contains `## Changed files` and an inlined diff fence, and ends with
   `## Output contract` and `## Task`.
   A compliant run needs no `git diff` / `git status` rediscovery before its
   first read.

3. **The reviewed SHA is recorded** — after the review completes:

   ```bash
   jq -r .reviewedSha .belayd/workflow.json
   git rev-parse HEAD          # compare: the sha recorded at review completion
   ```

   Expected: a hex SHA (not `null`/missing). It is written only on a
   **successful**, gate-owned review.

4. **A re-review is scoped to the fix round** — make a fix, commit or leave it
   in the working tree, call `belayd_review` again, and re-read the newest
   review transcript with the command from step 2:

   ```bash
   f=$(ls -t ~/.pi/agent/sessions/*/*belayd-*-sub-review-*.jsonl | head -1)
   jq -r 'select(.type=="message" and .message.role=="user") | .message.content[0].text' "$f" | head -6
   ```

   Expected: `mode: re-review of fixes` and `range: <reviewedSha from step 3>`,
   and the inlined diff equals `git diff <reviewedSha>` — the fix round only.

5. **The delivered report is bounded** — the orchestrator receives the review
   as a `belayd-run-complete` follow-up. In the orchestrator transcript (or the
   `## Critical`/`## Warnings`/`## Suggestions` sections of the delivered
   message), confirm:

   - no section has more than the caps above;
   - an empty section reads `None` and contains no findings bullets (a `- None`
     bullet the reviewer emitted is preserved as-is);
   - no `✓`-style verification bullets appear;
   - a section that had more findings than its cap ends with
     `- (+N more omitted; see the full findings in the review transcript)`;
   - a review with dropped narration bullets shows
     `- (+N malformed bullets dropped; ...)`.

   `src/__tests__/extension-session-naming.test.ts` ("bounds a delivered review
   and drops its narration bullets (bd-113)") asserts exactly this shape.

6. **Library-level check (no workflow run needed)** — the scope and bounding
   helpers are part of the public API:

   ```typescript
   import { boundReviewOutput, REVIEW_SECTION_LIMITS } from "belayd-agent-harness";

   boundReviewOutput(text).text;   // text with capped sections + omission notes
   REVIEW_SECTION_LIMITS;          // { critical: 6, warnings: 6, suggestions: 4 }
   ```

## What a good bounded review looks like

```
✅ **review phase completed** (run `abc123`)

## Critical (must fix)
None

## Warnings (should fix)
- `src/review-context.ts:118` — `kept.pop()` inside the trailing-blank loop can
  drop a finding when the section body ends without a blank line
- `src/workflow-state.ts:295` — `saveReviewedSha` overwrites `reviewedSha` even
  when the review covered no new commits

## Suggestions (consider)
- `src/review-context.ts:212` — `DOCS_ONLY_BASENAMES` accepts a bare `readme`
  path segment with no extension
- `src/review-context.ts:260` — doc comment on `boundDiff` does not mention the
  byte cap
- `extensions/index.ts:2880` — the reviewed sha is persisted before delivery
  succeeds, so a delivery failure still narrows the next review
- `extensions/index.ts:2928` — the `needsFullTask` predicate hardcodes the
  `"proof"` phase name instead of the shared constant
- (+1 more omitted; see the full findings in the review transcript)

## Summary
Two real defects in the new scoping path; the implementation is otherwise sound.
```

Characteristics: a location on every bullet, `None` for clean sections, at most
6/6/4 bullets per section, an explicit omission note when the reviewer found
more than the cap, and no bullet that only reports what was checked.

## Known behaviour

- **Untracked files.** `git diff` never shows untracked paths, so the harness
  lists them explicitly under `New (untracked) files — read these directly`
  and includes them in the changed-file count. A brand-new file is therefore
  reviewed even before it is staged or committed.
- **Docs-only diffs.** A change set whose tracked *and* untracked paths are all
  documentation (`docs/**`, `*.md`/`*.mdx`/`*.markdown`/`*.txt`/`*.rst`/`*.adoc`,
  `README`/`LICENSE`/`LICENCE` variants) is marked `docs-only diff: yes` and gets the
  narrowed docs instruction. The reviewer and its model class are unchanged.
  A mixed change set (`docs/a.md` + `src/a.ts`) is **not** docs-only.
- **Failed reviews are not bounded** and record no `reviewedSha`, so the next
  review is a first review rather than a fix-scoped one.
- **A stale `workflow.json` is ignored.** Only state whose `taskId` matches the
  review's task contributes a `reviewedSha`, and a recording attempt against a
  mismatched task is skipped with a `[belayd-harness]` warning instead of
  writing into another task's state.
- **Pre-bd-113 state files parse.** `reviewedSha` is optional, so an existing
  `workflow.json` without it continues to work.
- **Diff bounding is per review task**: 800 lines / 60 KB, and a single
  oversized line (minified bundle, lockfile blob) is cut rather than inlined
  whole. The truncation hint names the real git argument, so it stays correct on
  the merge-base-fallback path.
- **The full transcript survives bounding.** Bounding only rewrites the
  delivered message; the sub-agent session file keeps every bullet the reviewer
  emitted.
