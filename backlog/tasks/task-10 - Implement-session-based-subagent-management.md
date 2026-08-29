---
id: TASK-10
title: Implement session-based subagent management
status: Done
assignee: []
created_date: '2026-08-01 10:06'
updated_date: '2026-08-12 16:49'
labels:
  - feature
  - implementation
  - agent-harness
  - workflow
dependencies: []
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Remove --no-session from spawnAgentProcess so subagents persist as named pi sessions. Implement naming convention: belayd-{taskId}-{phase} for subagents, belayd-{taskId} for orchestrator. Users can list, inspect, and attach to subagent sessions. Sessions are compacted on completion.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Remove --no-session from spawnAgentProcess — subagents persist as named sessions
- [ ] #2 Implement naming convention: belayd-{taskId}-{phase} for subagents
- [ ] #3 Add session rename on /belayd activation to belayd-{taskId}
- [ ] #4 Document how users list, inspect, and attach to Belayd subagent sessions
- [ ] #5 Ensure subagent sessions are compacted on completion
- [ ] #6 Add unit tests for session naming and rename logic
<!-- AC:END -->
