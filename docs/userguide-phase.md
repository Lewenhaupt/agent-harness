# Userguide Phase (`belayd_userguide`)

The `userguide` phase writes a **committed markdown record** of how to use and
how to verify what a workflow implemented. It is the operator-facing artifact
for a bead, and it lives next to the code it documents.

## Before bd-130

The phase produced chat text only. `belayd-userguide` had no `write`/`edit`
tools, so it could not create a file; its output was captured into
`state.userGuideContent` (session memory), and the *only* durable sink was a
`bd note` appended by `belayd_commit` — in the same session, and only when that
commit passed a `taskId`. `gateUserGuide` regex-checked `## How to Verify` /
`## How to Use` against the transient text, so a phase could pass without ever
leaving a record. Anything a restart, handoff, or `/belayd-stop` cleared was
gone, and even a successful note was visible only via `bd show <id>`.

## Contract now

| Piece | Behaviour |
|---|---|
| Agent tools | `belayd-userguide` has `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`, `ast_grep`, `belayd_outline`, `web_search_exa`, `web_fetch_exa`. |
| Deliverable | `docs/<task-id>-userguide.md` (`userGuideDocPath` in `src/quality-gates.ts`). The path is derived from the bead id, never chosen by the agent, so the prompt, the gate, the follow-up, and the bead note agree. |
| Prompt | `buildFullPhaseTask` appends a `## Deliverable` block naming the exact path and stating that the file, not the chat answer, is the record. |
| Gate | `gateUserGuide` receives `userGuidePath` through `GateOptions` and validates the file on disk: both sections plus the 200-char minimum. A missing file fails with `Missing user guide file: <path>`. A path that resolves outside the worktree fails closed (`escapes the worktree`). Without `userGuidePath` the gate keeps the legacy chat-text contract for direct callers. |
| Run follow-up | The `belayd-run-complete` message is prefixed with `📄 **User guide written to `docs/<id>-userguide.md`**` when the file exists (`userGuideArtifactLine`). |
| Bead note | `belayd_commit` still appends a note, now headed by the record path (`userGuideNoteBody`); it says `(no guide file found in the worktree …)` instead of naming a file that does not exist. |
| Proof context | `collectChangeContext` gets the guide read **from disk** (`readUserGuideForContext`), so `## How to Verify` still reaches the advisory verifier even though the agent's chat report is now short. |
| Scope | `userguide` stays a **feature-only** phase (`src/workflow-registry.ts`); `bugfix`, `refactor`, `chore`, `hotfix`, `documentation`, and `research` do not include it. |

## How to Verify

Run from the repo root in the devShell.

1. Unit gate contract — file, not chat:

   ```bash
   pnpm vitest run src/__tests__/quality-gates.test.ts -t "gateUserGuide"
   ```

   Expect `gateUserGuide (file deliverable)` cases to pass, including
   `fails when the agent only answered in chat` (feedback contains
   `Missing user guide file`) and `fails closed on a path that escapes the
   worktree`.

2. Path derivation:

   ```bash
   pnpm vitest run src/__tests__/quality-gates.test.ts -t "userGuideDocPath"
   ```

   Expect `bd-42` → `docs/bd-42-userguide.md`, and an empty id →
   `docs/userguide.md` (no `userguide-userguide.md`).

3. Agent wiring:

   ```bash
   pnpm vitest run src/__tests__/agent-registry.test.ts -t "userguide"
   ```

   Expect `belayd-userguide` to contain `write` and `edit`, and its system
   prompt to say `deliverable is a markdown file`.

4. End-to-end behaviour in a scratch repo (the phase itself):

   ```bash
   bd create "scratch" --type feature        # note the id, e.g. bd-99
   bd update bd-99 --add-label wf:feature
   # from a gated session: belayd_start_task bd-99, then run the feature phases
   ls docs/bd-99-userguide.md                # the phase must create this file
   head -3 docs/bd-99-userguide.md           # level-1 title naming the feature
   grep -n '^## How to Verify' docs/bd-99-userguide.md
   grep -n '^## How to Use'    docs/bd-99-userguide.md
   bd show bd-99                             # NOTES names docs/bd-99-userguide.md
   ```

   The `belayd_userguide` run-complete follow-up in the session also shows
   `📄 **User guide written to docs/bd-99-userguide.md**`.

5. Negative case — chat-only answer fails the phase:

   ```bash
   pnpm vitest run src/__tests__/quality-gates.test.ts -t "only answered in chat"
   ```

   The gate returns `passed: false`, so the run retries instead of accepting
   prose that never reached the worktree.

6. Regression sweep:

   ```bash
   pnpm typecheck && pnpm test && pnpm test:integration && pnpm lint && pnpm build
   ```

## How to Use

Reading the record (the point of the phase):

```bash
# one bead's guide, committed with its feature branch
cat docs/$(bd show bd-42 --json | jq -r .id)-userguide.md

# the same path the harness derives, from TypeScript
import { userGuideDocPath } from "belayd-agent-harness";

userGuideDocPath("bd-42");   // "docs/bd-42-userguide.md"
userGuideDocPath("bd-42.1"); // "docs/bd-42.1-userguide.md"
```

Validating a guide in your own tooling:

```typescript
import { gateUserGuide } from "belayd-agent-harness";

const verdict = await gateUserGuide("", details, {
  cwd: "/path/to/worktree",
  userGuidePath: userGuideDocPath("bd-42"),
});
// verdict.passed === true only when docs/bd-42-userguide.md exists with
// "## How to Verify", "## How to Use", and >= 200 characters.
```

Writing a guide by hand for a bead that skipped the phase (`chore`, `hotfix`,
`documentation`, `research` have no `userguide` phase):

```bash
mkdir -p docs
$EDITOR docs/bd-77-userguide.md   # level-1 title, then ## How to Verify / ## How to Use
bd note bd-77 --stdin <<'EOF'
## User guide

`docs/bd-77-userguide.md` — How to Verify and How to Use.
EOF
```

Fixing a failing phase: the gate's feedback names the expected path. Write the
file there (or extend the existing one), then re-run `belayd_userguide` — the
retry resumes the same session and re-reads the file.
