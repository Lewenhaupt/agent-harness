---
id: TASK-12
title: Investigate spawned pi process terminating immediately in worktree
status: To Do
assignee: []
created_date: '2026-08-01 16:45'
updated_date: '2026-08-01 16:45'
labels:
  - research
  - bug
  - investigation
  - worktree
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When `/belayd TASK-XX` creates a worktree and spawns `pi --name belayd/TASK-XX -p prompt` inside
it, the spawned process terminates immediately instead of processing the task. The session file
IS created (confirming the process started), but no work is done. The task only proceeds when pi
is manually started in the worktree directory.

Investigate why the spawned pi process exits prematurely. Possible causes:

- `-p` (print mode) completes the prompt and exits — but the prompt asks the agent to start a
  workflow, which it should process and call tools
- Missing extensions in the worktree's pi context prevent tool execution
- `.belayd-task.json` not being read properly by the `session_start` handler
- Stdio configuration (`stdio: "ignore"`) causing pi to exit or fail silently
- Model/auth not available in the spawned process context
- Some other startup error that's swallowed because stdio is ignored

The fix should ensure the spawned pi process stays alive to process the full Belayd workflow.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Reproduce the issue: `/belayd TASK-XX` → spawned pi exits immediately
- [ ] #2 Identify the root cause of the premature termination
- [ ] #3 Fix the spawning logic in `extensions/index.ts` so the process stays alive
- [ ] #4 Verify the spawned process actually starts processing the workflow
- [ ] #5 Update any tests/docs as needed
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Tests pass
- [ ] #2 Lint and typecheck pass
- [ ] #3 Fix verified in a real worktree
<!-- DOD:END -->
