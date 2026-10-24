# Phase artifacts

Every phase agent is a cold process: its workspace is the worktree, its input is
a prompt. An artifact is how a phase's output survives that process — one file per
phase, written by the harness, named in the next phase's prompt.

```
<worktree>/.belayd/artifacts/scout.md
<worktree>/.belayd/artifacts/plan.md
<worktree>/.belayd/artifacts/implement.md
...
```

`.belayd/` is git-ignored, so an artifact never lands in a commit and disappears
with the worktree it belongs to.

## Why a file and not the prompt

Inline prompt relay is lossy and expensive: the orchestrator can only pass on what
it retypes, and every phase pays for whatever was inlined. Anthropic puts a useful
subagent return at 1–2k tokens; BMAD's own description is "agents hand work off
through files, not chat history", and Spec Kit enumerates the exact input files a
phase should read. A path costs ~15 tokens and lets the reader decide.

## What is written

- `src/artifacts.ts` writes on **successful delivery** only: a failed run's text is
  error output, and a later phase reading it as context would be misled.
- The body is bounded (`MAX_ARTIFACT_CHARS`, 20k) by keeping the head *and* the
  tail: a plan summary and a review verdict both live at the end.
- The header records the task id and that the harness wrote it.

## What the next phase sees

Before the phase-specific task (bead plan for implement, diff for review, change
context for proof), the prompt gets:

```markdown
## Prior phase artifacts

Earlier phases in this workflow wrote these files in this worktree. Read the ones you need
before exploring the repo from scratch; they are the cheapest context available.

- `.belayd/artifacts/scout.md` (4 KB) — scout phase output
- `.belayd/artifacts/plan.md` (2 KB) — plan phase output
```

A phase's **own** earlier artifact is excluded: a re-run would otherwise read its
previous attempt as current input in both the fresh and resumed prompt paths.

## Status and next increment

No agent cooperation is required — the orchestrator writes and indexes. The
remaining half of bd-141 is shrinking the *inlined* payloads (the review diff and
the bead plan) to paths and measuring the prompt-token and first-pass deltas with
`belayd_metrics` (see `docs/metrics.md`).
