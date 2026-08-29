---
id: TASK-1
title: Implement workflow sub-type system
status: Done
assignee: []
created_date: '2026-08-01 09:50'
updated_date: '2026-08-01 09:50'
completed_date: '2026-08-01 16:14'
labels:
  - feature
  - implementation
  - workflow
dependencies: []
references:
  - plans/workflow-sub-types.md
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the workflow sub-type registry and type-aware process gate as designed in plans/workflow-sub-types.md.

Seven workflow types: feature, bugfix, research, chore, documentation, refactor, hotfix. Each type defines its own phase sequence, agent overrides, model selection, quality gates, and proof requirements.

The /belayd slash command accepts an optional type argument: /belayd TASK-70 research. When no type is given, it falls back to task labels, then defaults to feature.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Create src/workflow-registry.ts with WorkflowSubType, WorkflowSubTypeConfig, WORKFLOW_REGISTRY, and helper functions
- [ ] #2 Parameterize process-gate.ts functions (checkToolAllowed, isWorkflowComplete, getNextPhase, markPhaseCompleted, formatProcessState) with optional phaseOrder parameter
- [ ] #3 Update the /belayd slash command in extensions/index.ts to accept optional type argument and resolve via hybrid approach (CLI arg > label > default)
- [ ] #4 Update SessionState to carry phaseOrder and workflowType, update tool_call and agent_end hooks to use per-session phase order
- [ ] #5 Implement agent override resolution: when spawning an agent, merge workflowConfig.agentOverrides with the default agent definition
- [ ] #6 Implement gate override resolution: use workflowConfig.gateOverrides instead of agent's default gate when specified
- [ ] #7 Write unit tests for workflow-registry.ts
- [ ] #8 Write unit tests for parameterized process-gate functions with different phase orders
- [ ] #9 Write integration tests for type resolution
- [ ] #10 All tests pass, biome and typecheck clean
- [ ] #11 Update belayd_start_task tool with optional workflowType parameter
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Tests pass
- [ ] #2 Docs updated
- [ ] #3 Lint and typecheck pass
<!-- DOD:END -->
