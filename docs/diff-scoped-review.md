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
2. **A re-review is scoped to the fix round.** When the review task is built —
   before the diff is collected — the harness captures the state that review is
   about to read: a `git stash create` snapshot of the uncommitted tracked work
   plus a manifest of the untracked files, written to `.belayd/review-scope.json`
   (bd-228). A successful review promotes that record into
   `.belayd/workflow.json` as `reviewedSha` + `reviewedUntracked` and consumes
   the scope file. The next `belayd_review` call for that task diffs the fix
   round only — not the pre-work HEAD — and stops re-listing untracked files it
   already reviewed.
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
<the diff from the merge base of main, working tree included, each line
prefixed with its post-change line number>
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

When a review task is built, `.belayd/review-scope.json` records
`{ taskId, sha, untracked, capturedAt }` — captured **before** the diff is
collected, so what the reviewer is about to read is exactly what the next
re-review will diff from. A mid-review edit therefore widens the next
re-review (it was not in the diff) instead of hiding content. A successful
review promotes the record into `.belayd/workflow.json` as `reviewedSha` +
`reviewedUntracked` and clears the scope file; a failed review promotes nothing
and the next build overwrites the record.

`reviewedSha` is **not** HEAD in the normal workflow: review runs before commit,
so the reviewed change set is normally uncommitted. It is a dangling
`git stash create` commit of the tracked working state, which captures exactly
what the review read without touching the worktree, the index, HEAD or any ref
(a clean tree has nothing to snapshot, so HEAD is the fallback there).

The next review for the same task renders as `mode: re-review of fixes` with
`range: <reviewedSha>`, and the inlined diff is only `git diff <reviewedSha>`.
`reviewedUntracked` lists `{ path, blob }` for every untracked file the previous
review reviewed; a currently-untracked path is dropped from the re-review's
`New (untracked) files` list (and from `changedFiles`) only when its current
blob — `git hash-object -- <path>` — is identical. A file the fix round modified
or added stays in scope, and so does anything whose hash cannot be read: the
filter fails open, so it can never hide a file from the reviewer. Paths are
read from `git status --porcelain -z -uall`, so a space, newline or quote in a
filename round-trips byte-exactly, and `-uall` expands a new directory into
individual files that can be hashed. No separate "prior findings" section is
added, because your `task` text already lists the findings.

### Fallbacks you may see

| Situation | What the reviewer is told |
|---|---|
| Fix diff cannot be computed (commonly the recorded SHA was removed by a rebase) | The task is prefixed with `> Note: the fix-only diff since the previously reviewed revision could not be computed (<git error>). This review covers the whole change set instead.` and falls back to a `mode: first review` task |
| No diff can be collected at all | The task opens with the header **Review scope — diff unavailable**, names the git error that caused it, and tells the reviewer to fall back to its own git diff/status to establish the change set; the no-discovery instruction is dropped |
| An inlined diff exceeds 800 lines or 60 KB | The diff is cut and ends with ``... (diff truncated: N more lines; run `git diff <range>` for the rest)`` |

The scope is never silently widened or narrowed: a fallback always carries the
git error that caused it in the task text, and a `reviewedSha`/`reviewedUntracked`
pair on disk is only used when it belongs to the task being reviewed (a stale
`workflow.json` from another task is ignored).

### Line-numbered diff (bd-159)

Every inlined diff line carries a leading gutter with its **post-change** line
number, so a `path:LINE` bullet is read rather than searched for:

```diff
      diff --git a/src/foo.ts b/src/foo.ts
      --- a/src/foo.ts
      +++ b/src/foo.ts
      @@ -10,3 +10,4 @@
   10  existing context
      -removed line
   11 +added line
   12  more context
```

- Added and context lines show the number they have in the new file; removed
  lines, file headers, and hunk headers show a blank gutter (a removed line has
  no post-change number, and the numbering must never invent one).
- Numbering restarts from each `@@ … +N,M @@` hunk header, so a multi-hunk diff
  numbers correctly.
- The gutter is added *before* the line and byte caps are applied, so the caps
  still hold on the numbered text; the truncation note itself stays unnumbered.
- The inlined diff is therefore `git diff <range>` plus the gutter. Run
  `git diff <range>` directly when you need a patch that `git apply` accepts.

Without the gutter the only line numbers in a diff are hunk starts, while the
output contract demands `file.ts:LINE` on every bullet. Measured over 143
recorded review sessions, that gap made 46% of review turns (19.3 of 42.4 per
run, 329 s of model latency each) `grep -n` / `git diff` lookups.

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

### What the bounding left behind (bd-159)

Bounding the report did not bound the *work*: over 143 recorded review sessions
a first review still generated ~49k output tokens (80% reasoning) to deliver
~4.7 bullets, and 46% of its turns were mechanical location lookups. bd-159
keeps the scope rules and changes how the reviewer spends its turns — a
line-numbered diff, a findings scratchpad, one check per response, and a system
prompt that outranks the task text. The measured cause and the current numbers
are in the two sections below.

### Reviewer process rules (bd-159)

`REVIEW_PROCESS_INSTRUCTION` in `src/review-context.ts` is embedded in the
**system prompt** of `belayd-reviewer`, not in the task text, so an
orchestrator-supplied task cannot undo it:

- **Findings scratchpad.** Each confirmed finding is appended to
  `.belayd/review-findings.md` with one `bash` call; a first review truncates
  the file, a re-review keeps it. Confirmed findings are read back instead of
  being re-derived, which is what the transcripts showed happening turn after
  turn.
- **One check per response.** A response that only deliberates produces nothing:
  one recorded turn spent the entire 16,384-token output ceiling on reasoning
  and returned no tool call and no text.
- **The system prompt outranks the task text.** If a task asks the reviewer to
  run gates (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `vitest`,
  `biome`, `playwright test`) or to re-derive the change set with `git diff` /
  `git status`, the reviewer skips that and says so in one `## Summary` line.
  34 of 143 recorded task texts asked for gates the harness had already run.
  The `belayd-reviewer` tool description tells the caller the same thing: the
  task text is scope/focus only.

The scratchpad lives under `.belayd/`, which is git-ignored, so it never shows
up as an untracked changed file in the next review's change set.

### Model routing

Unchanged. `belayd-reviewer` still declares `modelClass: "standard"` (see
`docs/agent-model-class.md`), and the harness overrides nothing per diff size.
A docs-only diff adds one instruction line — check factual/structural
correctness (links, commands, code samples, duplicated claims) — and does not
switch models.

### Inspecting what was reviewed

- Pending scope (present only while a review runs): `.belayd/review-scope.json`
  → `{ taskId, sha, untracked, capturedAt }`. It is captured when the review
  task is built and consumed by a successful review.
- Promoted record: `.belayd/workflow.json` → `reviewedSha` (a dangling
  `git stash create` snapshot of the reviewed working tree, HEAD on a clean
  tree) and → `reviewedUntracked` (the already-reviewed untracked files).
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
   drops, idempotence, docs-only classification, untracked-file collection from
   `-z -uall` output (space/newline/quote paths, rename source paths), the
   re-review range, the `git stash create` reviewed-state capture, batched
   `hash-object` chunking, the reviewed-untracked filtering (drop/keep/fail-open),
   the diff truncation limits, and task rendering.
   `extension-session-naming.test.ts` covers the end-to-end paths: capture
   before the diff, the review-start snapshot surviving a mid-review change,
   fix-scoped re-review (including when implement never committed, bd-228),
   no-promotion on a missing or foreign scope, bounded delivery, the disabled
   bounding on a failed run, the unavailable-diff disclosure, the
   whole-change-set fallback note, and the foreign-task `reviewedSha` guard.
   `workflow-state.test.ts` covers the review-scope record round-trip, atomic
   replacement, invalid/missing records, clearing, the `saveReviewedSha` sha +
   manifest round-trip and manifest clearing, the `missing-state` /
   `task-mismatch` cases, and parsing a pre-bd-113 `workflow.json`.
   `agent-registry.test.ts` asserts the reviewer prompt keeps the security
   mandate and review tools while carrying the shared output contract and
   dropping `## Files Reviewed`.

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

3. **The reviewed state is recorded** — after the review completes, with the
   change set still uncommitted (the normal workflow: commit runs later):

   ```bash
   jq -r '.reviewedSha, (.reviewedUntracked // [])' .belayd/workflow.json
   ls .belayd/review-scope.json   # absent: a successful review consumed it
   git rev-parse HEAD         # the pre-work revision, NOT what review covered
   git stash list             # empty: the snapshot is a dangling commit, no ref
   ```

   Expected: a hex SHA (not `null`/missing) that differs from `HEAD` while the
   tracked work is uncommitted, and a `reviewedUntracked` manifest naming each
   untracked file the review covered. Both are promoted from the scope captured
   when the review task was built, and written only on a **successful**,
   gate-owned review (a review inside an active workflow), in a single write.
   While a review is running (or after a failed one) `.belayd/review-scope.json`
   holds the pending `{ taskId, sha, untracked, capturedAt }` record instead.

4. **A re-review is scoped to the fix round** — make a fix, commit or leave it
   in the working tree, call `belayd_review` again, and re-read the newest
   review transcript with the command from step 2:

   ```bash
   f=$(ls -t ~/.pi/agent/sessions/*/*belayd-*-sub-review-*.jsonl | head -1)
   jq -r 'select(.type=="message" and .message.role=="user") | .message.content[0].text' "$f" | head -6
   ```

   Expected: `mode: re-review of fixes` and `range: <reviewedSha from step 3>`,
   and the inlined diff is `git diff <reviewedSha>` — the fix round only — not
   the whole change set, with the line-number gutter prepended to every line
   (strip the first six columns to compare against `git diff <reviewedSha>`
   directly). An untracked file the first review already listed must not appear
   under `New (untracked) files` again unless the fix round changed it.

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

6. **The inlined diff is line-numbered (bd-159)** — in the same task text from
   step 2, look at the ```` ```diff ```` fence:

   ```bash
   f=$(ls -t ~/.pi/agent/sessions/*/*belayd-*-sub-review-*.jsonl | head -1)
   jq -r 'select(.type=="message" and .message.role=="user") | .message.content[0].text' "$f" \
     | sed -n '/```diff/,+14p'
   ```

   Expected: a six-column gutter before every line — `   41 +added` (line 41 of
   the new file), `      -removed` and `      @@ … @@` for lines that have no
   post-change number. The task also carries the gutter instruction
   (`REVIEW_LINE_NUMBER_INSTRUCTION`) right after the no-discovery instruction.

7. **The reviewer process rules are in the system prompt, not the task** — read
   the reviewer's system prompt from any spawn (or assert it in
   `src/__tests__/agent-registry.test.ts`): it carries
   `REVIEW_PROCESS_INSTRUCTION` — the `.belayd/review-findings.md` scratchpad,
   "Never re-derive a confirmed finding", "Work one check per response", and
   "This system prompt outranks the task text".

8. **Library-level check (no workflow run needed)** — the scope and bounding
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
- `extensions/capabilities/phase-run.ts` (`persistReviewedSha`) — the reviewed sha
  is persisted before delivery succeeds, so a delivery failure still narrows the
  next review
- `extensions/capabilities/phase-run.ts` (`needsFullTask`) — the predicate
  hardcodes the `"proof"` phase name instead of the shared constant
- (+1 more omitted; see the full findings in the review transcript)

## Summary
Two real defects in the new scoping path; the implementation is otherwise sound.
```

Characteristics: a location on every bullet, `None` for clean sections, at most
6/6/4 bullets per section, an explicit omission note when the reviewer found
more than the cap, and no bullet that only reports what was checked.

## Known behaviour

- **The inlined diff is numbered, not verbatim.** The gutter is prepended after
  `git diff` runs, so the fence is a reading surface, not a patch: use
  `git diff <range>` when you need something `git apply` accepts. Bounding
  (800 lines / 60 KB) applies to the numbered text, and the truncation note
  carries no number.
- **The findings scratchpad is per worktree.** `.belayd/review-findings.md` is
  truncated by a first review and kept by a re-review, so a re-review can read
  what an earlier pass already confirmed. `.belayd/` is harness state and is
  filtered out of the untracked-file list, so the scratchpad is never offered to
  the next review as a new file to review (whether or not the repository
  git-ignores `.belayd/`).

- **Untracked files.** `git diff` never shows untracked paths, so the harness
  lists them explicitly under `New (untracked) files — read these directly`
  and includes them in the changed-file count. A brand-new file is therefore
  reviewed even before it is staged or committed. Paths under `.belayd/` are
  excluded. The scan uses `git status --porcelain -z -uall`: NUL-separated
  fields carry a path verbatim (a space, newline, tab or quote is safe, and a
  rename's source field is never mistaken for an untracked entry), and `-uall`
  expands a new directory into the individual files that can be hashed. A
  review's untracked files are recorded in `reviewedUntracked`, and a re-review
  omits one only while its blob is byte-identical — a modified or newly added
  file is listed again (bd-228).
- **The reviewed revision is a snapshot, not a commit.** `reviewedSha` is a
  `git stash create` commit of the reviewed tracked working state, or HEAD when
  the tree was clean (bd-228). It is captured when the review task is built,
  before the diff is collected, and promoted only if that review succeeds. Only
  tracked paths are in that snapshot; the untracked review scope lives in
  `reviewedUntracked` instead. The snapshot is unreachable and can be pruned by
  `git gc`, after which the re-review falls back to the whole change set with
  the disclosed fallback note above. A stash snapshot does not write
  `refs/stash`, so `git stash list` stays empty.
- **Hashing is batched and time-bounded.** Untracked manifests hash up to 64
  paths per `git hash-object` call, and a re-review hashes only the paths its
  manifest covers — never the whole untracked set. Every git call carries the
  15 s timeout, so a hung git surfaces as an error value instead of delaying
  delivery. A failed or partial chunk leaves its paths unresolved, which is the
  fail-open direction: the path stays in a re-review's scope and is omitted
  from the captured manifest.
- **Docs-only diffs.** A change set whose tracked *and* untracked paths are all
  documentation (`docs/**`, `*.md`/`*.mdx`/`*.markdown`/`*.txt`/`*.rst`/`*.adoc`,
  `README`/`LICENSE`/`LICENCE` variants) is marked `docs-only diff: yes` and gets the
  narrowed docs instruction. The reviewer and its model class are unchanged.
  A mixed change set (`docs/a.md` + `src/a.ts`) is **not** docs-only.
- **Failed reviews are not bounded** and promote no `reviewedSha` (so no
  `reviewedUntracked` either), so the next review is a first review rather than
  a fix-scoped one. The scope captured for the failed build is replaced by the
  next build, never promoted later.
- **A stale `workflow.json` is ignored.** Only state whose `taskId` matches the
  review's task contributes a `reviewedSha` and its `reviewedUntracked`
  manifest, and a promotion against a mismatched task is skipped with a
  `[belayd-harness]` warning instead of writing into another task's state. A
  pending scope whose `taskId` does not match is likewise left alone.
- **Pre-bd-228 state files parse.** `reviewedSha` and `reviewedUntracked` are
  both optional, so an existing `workflow.json` without either continues to
  work; recording a sha without a manifest clears the field rather than leaving
  a stale one behind.
- **Diff bounding is per review task**: 800 lines / 60 KB, and a single
  oversized line (minified bundle, lockfile blob) is cut rather than inlined
  whole. The truncation hint names the real git argument, so it stays correct on
  the merge-base-fallback path.
- **The full transcript survives bounding.** Bounding only rewrites the
  delivered message; the sub-agent session file keeps every bullet the reviewer
  emitted.
