---
id: TASK-2
title: Explore subagent observability — session inspection and debugging
status: To Do
assignee: []
created_date: '2026-08-01 09:50'
labels:
  - research
  - investigation
dependencies: []
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Currently, when Belayd spawns subagents (scout, planner, implementer, etc.) via spawnAgentProcess(), their execution is a black hole. The spawner captures stdout/stderr but there is no way to view the full subagent session transcript, replay or inspect what the subagent reasoned about, or debug failed subagent runs.

This task investigates how to make subagent sessions observable and debuggable.

Key areas: session persistence, session replay/viewer, dashboard integration, structured output, quality gate traces.

Produce a written recommendation in plans/subagent-observability.md.

Key references: spawnAgentProcess() in src/spawn.ts, pi --name for session naming, pi-web sessiond, @tintinweb/pi-subagents FleetView, @quintinshaw/pi-dynamic-workflows live progress panel.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Investigate what session artifacts spawnAgentProcess() currently produces and where they go
- [ ] #2 Research pi's session JSONL format and replay capabilities
- [ ] #3 Explore options for capturing subagent sessions: temp directories, named sessions, catalog file
- [ ] #4 Research pi-web sessiond — can it manage and expose subagent sessions?
- [ ] #5 Design a lightweight approach: subagent sessions saved as named files with a manifest catalog
- [ ] #6 Design a dashboard approach: subagent sessions visible in pi-web, linked to parent task
- [ ] #7 Evaluate how Piolium handles subagent visibility
- [ ] #8 Produce written recommendation in plans/subagent-observability.md
- [ ] #9 Create follow-up implementation tasks for the chosen approach
<!-- AC:END -->
