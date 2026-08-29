---
id: TASK-3
title: Investigate plannotator pi-extension review flow
status: To Do
assignee: []
created_date: '2026-08-01 09:50'
labels:
  - research
  - investigation
dependencies: []
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The current plannotator review flow in the belayd harness (belayd_plannotator tool) is janky. It writes a signal file, sends a message, then polls for feedback. The actual plannotator pi-extension likely has a cleaner integration mechanism.

Investigate: how does the plannotator pi-extension register and integrate with pi's lifecycle? What is its review flow? How does it communicate with pi-web (or TUI)? Can we replace signal-file-and-poll with direct extension-to-extension handoff?

Deliverable: plans/plannotator-integration.md with recommendation for refactoring belayd_plannotator.
<!-- SECTION:DESCRIPTION:END -->
