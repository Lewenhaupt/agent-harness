---
id: TASK-6
title: Add AWS STS credential agent (belayd-aws)
status: To Do
assignee: []
created_date: '2026-08-01 10:06'
labels:
  - feature
  - implementation
dependencies:
  - TASK-5
references:
  - plans/sandboxed-execution.md
priority: medium
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create a dedicated AWS agent definition with STS AssumeRole credential flow, add awscli2 to the Nix dev shell, and write a custom AWS skill.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Define belayd-aws agent with model deepseek/deepseek-v4-flash, tools [read, bash], STS AssumeRole system prompt
- [ ] #2 Agent receives IAM role ARN via SpawnOptions.env (scoped env per TASK-5)
- [ ] #3 Credentials never written to disk and never logged
- [ ] #4 Add pkgs.awscli2 to flake.nix
- [ ] #5 Write .pi/skills/aws/SKILL.md with credential flow docs and safety guardrails
- [ ] #6 Agent can perform authenticated AWS operations using temporary credentials
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 All tests pass
- [ ] #2 TypeScript compiles
- [ ] #3 Lint passes
- [ ] #4 AWS STS AssumeRole flow verified in test
<!-- DOD:END -->
