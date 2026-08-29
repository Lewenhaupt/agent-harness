---
id: TASK-7
title: Provision Node 23 + QEMU for Gondolin sandbox
status: To Do
assignee: []
created_date: '2026-08-01 10:06'
labels:
  - chore
  - implementation
dependencies: []
references:
  - plans/sandboxed-execution.md
priority: low
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Update the Nix dev shell to support Gondolin micro-VM sandboxing by upgrading Node.js to >=23.6.0, adding QEMU, and adding @earendil-works/gondolin as a dependency.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Update flake.nix to use nodejs_23 instead of nodejs_22
- [ ] #2 Add QEMU to dev shell packages (pkgs.qemu)
- [ ] #3 Verify Gondolin example loads without errors
- [ ] #4 All existing tests pass after Node version update
- [ ] #5 Add @earendil-works/gondolin as a project dependency
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 All tests pass
- [ ] #2 TypeScript compiles
- [ ] #3 Lint passes
- [ ] #4 Gondolin installable via pnpm
<!-- DOD:END -->
