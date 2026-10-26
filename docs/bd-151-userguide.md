# Phase deliverables as authored bead comments (bd-151)

Before bd-151, a phase deliverable (userguide body, research findings, proof
verdict) was pasted onto the bead with `bd note --stdin`. Every append landed in
one unowned `NOTES` blob: no author, no timestamp, no ordering, and — because
`bd show` output is fed back into later phase prompts via `readTaskPlan` — every
pasted guide and verdict grew the next phase's prompt by its full size.

bd-151 moves deliverables to the bead's **comment thread** and keeps the bead
body for the plan:

| Slot | Holds | Written by |
|---|---|---|
| `COMMENTS` | Phase deliverables, one authored + timestamped entry each, tagged `[belayd:<phase>]` | `bd comment --stdin` (`appendPhaseDeliverables` in `extensions/index.ts`) or the researcher itself |
| `DESCRIPTION` / `DESIGN` / `NOTES` | The PLAN only — what `bd show` feeds into implement prompts and the handoff packet | humans / planning phases |

Deliverables are recorded **only** when a phase actually produced content: no
userguide text and no proof verdict means no comment, not an empty one.

Code lives in `src/bead-comments.ts` (`phaseCommentHeader`, `phaseCommentBody`,
`stripBdShowComments`, `PhaseCommentAuthor`), exported from the package root.

## How to Verify

Run from the repository root in the devShell. Every command below was executed
in this worktree.

1. Unit suite for the comment contract:

   ```bash
   pnpm vitest run src/__tests__/bead-comments.test.ts
   ```

   Expected: `12 passed (12)`. The cases that matter:

   - `keeps description/design/notes and drops the authored thread` — the strip
     preserves the real plan text and drops `COMMENTS`, the `[belayd:userguide]`
     header and the guide path.
   - `ends at the COMMENTS section: no column-0 heading follows it` — pins the
     layout assumption against the real transcript
     `src/__tests__/fixtures/bd-show-with-comments.txt` (captured from a
     throwaway `bd init` database, not hand-written). If a future bd appends a
     column-0 section after `COMMENTS`, this fails instead of silently deleting
     plan content from every implement prompt.
   - CRLF, no-comments, indented-`COMMENTS` and idempotence cases.

2. Integration suite for the write path and the prompt bound:

   ```bash
   pnpm test:integration test/phase-deliverable-comments.integration.test.ts
   ```

   Expected: `5 passed (5)`:

   - `writes one authored comment per phase deliverable and no bead note` —
     a userguide phase + `belayd_proof_verifier` + `belayd_commit bd-42` produces
     exactly two `["comment","--stdin","--","bd-42"]` calls, first lines
     `[belayd:userguide]` and `[belayd:proof-verifier]`, and **zero** `bd note`
     calls.
   - `keeps the thread body's CRLF line endings verbatim` — a CRLF report stays
     CRLF inside the comment body (normalisation would fail the test).
   - `writes no deliverable comment when no phase produced content`.
   - `bounds the implement prompt by the plan, not the comment thread` — two
     `bd show` outputs differing only by a 2000-line / >100 KB `COMMENTS` thread
     produce prompts within 1 KB of each other, and neither contains the thread.
   - `keeps no phase deliverable on the bd note path` — source scan:
     `extensions/index.ts` has no `["note","--stdin"` write, and
     `RESEARCHER_SYSTEM_PROMPT` says `comment <task-id> --stdin` with the
     `[belayd:research]` header.

3. Prompt-size invariant, by hand. Build the library, then run the real fixture
   through the same function `readTaskPlan` uses:

   ```bash
   pnpm build
   node --input-type=module -e '
   const { stripBdShowComments } = await import("./dist/src/bead-comments.js");
   const { readFileSync } = await import("node:fs");
   const raw = readFileSync("src/__tests__/fixtures/bd-show-with-comments.txt", "utf8");
   const plan = stripBdShowComments(raw);
   console.log("bd show bytes:", raw.length, "→ plan bytes:", plan.length);
   console.log("--- tail of plan ---");
   console.log(plan.split("\n").slice(-4).join("\n"));
   '
   ```

   Expected:

   ```text
   bd show bytes: 1400 → plan bytes: 776
   --- tail of plan ---

     ## Notes
                                                                                 
     The notes blob stays the plan.
   ```

   The output ends inside `NOTES`: nothing from `COMMENTS` (the
   `[belayd:userguide]` block) or the trailing `💡 Tip:` footer survives.

4. Same check against a live bead — the plan size must not grow with the thread.
   `bd show` output for a bead with no comments is passed through unchanged, so
   compare a commented bead with itself:

   ```bash
   bd comments bd-99                 # the deliverable entries (may be "No comments on bd-99")
   bd show bd-99                     # plan sections as usual
   node --input-type=module -e '
   const { stripBdShowComments } = await import("./dist/src/bead-comments.js");
   const { execFileSync } = await import("node:child_process");
   const raw = execFileSync("bd", ["show", "bd-99"], { encoding: "utf8" });
   const plan = stripBdShowComments(raw);
   console.log("bd show bytes:", raw.length, "→ plan bytes:", plan.length);
   console.log("contains COMMENTS:", plan.includes("COMMENTS"));
   '
   ```

   Expected for a bead with no comments: identical byte counts and
   `contains COMMENTS: false`. For one with a thread, `plan bytes` is smaller
   by the whole thread and stays constant as more comments are added. Note that
   `bd show --json` is untouched by the strip — the harness's other `bd show`
   readers use `--json` and still see the full record.

5. End-to-end on a real workflow. In a gated session for a scratch bead
   (`bd create "scratch" --type feature`, `/belayd bd-99 feature`), run the
   feature phases through `belayd_commit bd-99`, then:

   ```bash
   bd comments bd-99                 # one entry per deliverable
   bd comments bd-99 --json          # same entries with author fields
   bd comments bd-99 --local-time    # timestamps in local time
   bd show bd-99                     # DESCRIPTION/DESIGN/NOTES: plan only
   ```

   Expected in `bd comments bd-99`: one entry opening with
   `[belayd:userguide]` (containing `docs/bd-99-userguide.md` — How to Verify and
   How to Use — then the agent's report) and one opening with
   `[belayd:proof-verifier]` (the `## Verdict` / `reasonable:` / `reason:` /
   `evidence:` block). Expected in `bd show bd-99`: no guide body, no verdict,
   no `[belayd:` tag in the notes.

   Research has no `belayd_*` tool of its own; it is written by the researcher
   agent through the `bd` tool. After a research phase on a task id,
   `bd comments <id>` should show a `[belayd:research]` entry — see the caveat in
   "How to Use".

## How to Use

### Reading a bead's history now

The two slots answer two different questions:

- **`bd comments <id>` — what did each phase produce?** Authored, timestamped,
  ordered. The first line of every harness-authored entry is the phase tag:

  | Header | Author | Body |
  |---|---|---|
  | `[belayd:userguide]` | `belayd_commit` (`appendPhaseDeliverables`) | `## User guide` pointer to `docs/<task-id>-userguide.md`, then the phase's own report |
  | `[belayd:proof-verifier]` | `belayd_commit` (`appendPhaseDeliverables`) | the advisory verdict, verbatim |
  | `[belayd:research]` | the researcher agent, through the `bd` tool | findings with file paths + line ranges |

- **`bd show <id>` — what is the plan?** `DESCRIPTION`, `DESIGN` and `NOTES` are
  the plan only. That is also what a later implement prompt and the `/belayd`
  handoff packet see: `readTaskPlan` (`extensions/index.ts`) runs `bd show <id>`
  and pipes it through `stripBdShowComments`, so the `COMMENTS` thread is never
  injected. This is deliberate — prompt budget, and proof artifacts may contain
  secrets. The handoff packet (`src/handoff.ts`, fed by the same `readTaskPlan`)
  is likewise plan-only.

### Writing a deliverable by hand

Any comment whose first line is a `[belayd:<phase>]` tag is indistinguishable
from a harness-written one, so a deliverable for a bead that skipped the phase
(`chore`, `hotfix`, `refactor`) goes on the comment thread — never `bd note`:

```bash
mkdir -p docs
$EDITOR docs/bd-77-userguide.md
bd comment bd-77 --stdin <<'EOF'
[belayd:userguide]

## User guide

`docs/bd-77-userguide.md` — How to Verify and How to Use.

<short report>
EOF
```

`--stdin` keeps the multiline body out of argv; `--file <path>` works too.

### Composing a body in code

Use the helpers rather than a string literal, so the header cannot drift:

```typescript
import {
  phaseCommentBody,
  phaseCommentHeader,
  stripBdShowComments,
  type PhaseCommentAuthor,
} from "belayd-agent-harness";

phaseCommentHeader("userguide");
// "[belayd:userguide]"

// Header line, then the deliverable verbatim (content is never rewritten).
phaseCommentBody("proof-verifier", "## Verdict\nreasonable: true\nreason: ok\nevidence: cast");
// "[belayd:proof-verifier]\n## Verdict\nreasonable: true\nreason: ok\nevidence: cast"

// Drop the thread from `bd show` text; keeps DESCRIPTION/DESIGN/NOTES.
const plan = stripBdShowComments(bdShowStdout);
```

`PhaseCommentAuthor` is the closed set `"proof-verifier" | "research" |
"userguide"`: adding a phase that writes a deliverable means adding its name
there and at the call site (`appendTaskComment({ phase })` is typed, so a typo
does not compile).

### Caveats to keep in mind

- **CRLF is preserved verbatim.** The comment body is a record, not a rendered
  document, so a CRLF report stays CRLF. Do not normalise it before writing —
  the integration suite asserts the line endings and the CRLF-pair count.
- **The research header is prompt-driven.** `userguide` and `proof-verifier`
  headers come from `appendTaskComment`, so the union type enforces them. The
  researcher authors its own comment through the `bd` tool from prose in
  `RESEARCHER_SYSTEM_PROMPT` (`src/agent-registry.ts`), so `[belayd:research]`
  appears only if the agent follows its prompt. The guard is a prompt assertion
  (`src/__tests__/agent-registry.test.ts`, `test/phase-deliverable-comments.integration.test.ts`),
  not a compile-time contract — an untagged research comment is still readable,
  it just loses the phase tag.
- **`COMMENTS` is treated as the last section.** The strip drops everything from
  the `COMMENTS` heading to the end of the output, which also drops bd's trailing
  `💡 Tip:` footer. A future bd that adds a real section after `COMMENTS` fails
  `src/__tests__/bead-comments.test.ts` rather than losing that content silently.
