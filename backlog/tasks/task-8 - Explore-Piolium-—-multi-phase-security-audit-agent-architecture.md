---
id: TASK-8
title: Explore Piolium — multi-phase security audit agent architecture
status: To Do
assignee: []
created_date: '2026-08-01 10:06'
labels:
  - research
  - investigation
dependencies: []
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Investigate @vigolium/piolium, a pi-native security audit agent that runs multi-phase audits with specialist sub-agents. Compare with Belayd's agent harness: agent architecture, phase management, resumable state, concurrency control, extension packaging, slash command design.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Study Piolium's README and npm package structure
- [ ] #2 Research Piolium's sub-agent architecture from source
- [ ] #3 Analyze Piolium's phase management vs Belayd's PHASE_ORDER
- [ ] #4 Investigate Piolium's resumable state vs Belayd's ephemeral approach
- [ ] #5 Study Piolium's concurrency control pattern
- [ ] #6 Analyze Piolium's slash command design vs /belayd
- [ ] #7 Evaluate Piolium's pi package structure as template for Belayd
- [ ] #8 Identify patterns to adopt into Belayd's agent harness
- [ ] #9 Produce written exploration in plans/piolium-exploration.md
- [ ] #10 Create follow-up implementation tasks for adoptable patterns
<!-- AC:END -->
