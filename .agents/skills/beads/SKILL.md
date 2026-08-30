---
name: beads
description: Use when working in a repository that uses bd or Beads for durable project task tracking, issue dependencies, blocker management, multi-session handoff, or shared work memory. Trigger when the user asks to find ready work, claim or close tasks, create follow-up work, inspect blockers, recover project context, or choose between local planning and persistent project tracking.
---

# Beads

Use Beads as the shared project task system. Local plans, scratch files, and personal memories are useful, but they are not the durable source of truth for project work.

## First Step

Run:

```bash
bd prime
```

If that prints nothing, check whether the repository has an active Beads workspace:

```bash
bd where
```

## Preferred Route

Use the `bd` tool if your harness provides one; otherwise use the `bd` CLI when shell access is available. Either is the most compact and direct Beads interface — and the only reliable way to read issue data.

Some harnesses expose a `bd` tool restricted to safe subcommands (create, update, show, list, search, ...) that cannot `close`, `delete`, or `edit` issues. Run those mutating commands through the `bd` CLI instead.

## Data lives in a shared Dolt server — do not read files

Issues are stored in a Dolt database, commonly on a shared Dolt server (`dolt.shared-server: true`, `dolt_mode: server`), not in readable local files.

- Never read `.beads/issues.jsonl`, `.beads/dolt/`, or any other `.beads/` file to discover or inspect work. `issues.jsonl` is a passive export that may be absent or stale; `.beads/dolt/` is server/runtime state.
- Always go through `bd` (`bd list`, `bd show`, `bd search`, `bd ready`, ...) to see current, authoritative issue state.
- Because it is shared, mutate carefully: claim with `bd update <id> --claim`, and use `--if-assignee`/`--if-status` guards for concurrent-safe updates.

## Core CLI Workflow

1. Find work:

```bash
bd ready
bd list --status=open
bd list --status=in_progress
```

2. Inspect before editing:

```bash
bd show <id>
```

3. Claim work atomically:

```bash
bd update <id> --claim
```

4. Create durable follow-up work when implementation reveals new tasks:

```bash
bd create "Short title" --description="Why this exists and what needs to be done" --type=task --priority=2
```

Create follow-up work as a separate top-level bead, never as a subtask. If the new work is related to the current bead, link it afterward instead:

```bash
bd link <current-id> <new-id>          # new-id blocks current-id
bd link <current-id> <new-id> --type related
```

5. Close completed work:

```bash
bd close <id> --reason="Completed"
```

## What Belongs In Beads

Use Beads for:

- shared project tasks
- blockers and dependencies
- discovered follow-up work
- work that must survive thread reset, compaction, or handoff
- status that another person or agent should be able to resume

Use agent-local planning tools only for the current turn's execution checklist. Do not treat them as shared project state.

## Rules

- Do not read `.beads/` files (`.beads/issues.jsonl`, `.beads/dolt/`, etc.) to find or inspect work; always use `bd`. File contents are not the source of truth for a shared server.
- Do not create markdown TODO files as the source of truth when Beads is available.
- Do not use `bd edit`; it opens an interactive editor. Use `bd update` flags instead.
- Prefer `--json` when parsing `bd` output programmatically.
- If hooks are installed, `bd prime` may already be injected. Run it manually when context is missing.
- Do not auto-close or mutate tasks unless the work is actually complete.
- Do not create subtasks: no `bd create ... --parent <id>` and no `parent-child` links. Subtasks keep the parent open and block closing it, which breaks the merge = close workflow. Model hierarchy as separate top-level beads plus `bd dep` / `bd link` (blocks or related) dependencies instead.
