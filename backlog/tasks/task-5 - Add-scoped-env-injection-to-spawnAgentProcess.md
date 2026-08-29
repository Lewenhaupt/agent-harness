---
id: TASK-5
title: Add scoped env injection to spawnAgentProcess
status: To Do
assignee: []
created_date: '2026-08-01 10:06'
labels:
  - feature
  - implementation
dependencies: []
references:
  - plans/sandboxed-execution.md
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add environment variable scoping to spawnAgentProcess() so each agent session can receive a controlled set of environment variables without inheriting the full parent environment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Extend SpawnOptions with env?, envFiles?, inheritEnv? (default true)
- [ ] #2 spawnAgentProcess() merges env, reads envFiles, applies inheritEnv
- [ ] #3 Pass constructed env to child_process.spawn() options
- [ ] #4 Add AWS env vars to Pino redaction paths
- [ ] #5 Add env/envFiles optional params to phase tools
- [ ] #6 All existing tests pass without modification
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 All tests pass
- [ ] #2 TypeScript compiles
- [ ] #3 Lint passes
- [ ] #4 Backward compatible
<!-- DOD:END -->
