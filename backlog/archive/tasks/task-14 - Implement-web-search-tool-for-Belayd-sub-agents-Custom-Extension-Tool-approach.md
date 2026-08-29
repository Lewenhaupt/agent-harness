---
id: TASK-14
title: >-
  Implement web search tool for Belayd sub-agents (Custom Extension Tool
  approach)
status: To Do
assignee: []
created_date: '2026-08-11 20:19'
updated_date: '2026-08-11 20:19'
labels:
  - feature
  - implementation
  - agent-harness
dependencies: []
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the web_search custom extension tool as specified in research/web-search-plan.md (TASK-13 findings).

The tool wraps the Brave Search API and is made available to scout and planner sub-agents.

Implementation steps:
1. Create src/web-search.ts — pure search logic + tool registration helper
2. Create .pi/extensions/web-search.ts — minimal extension for sub-agent -e loading
3. Modify src/spawn.ts — add -e and -a flags from SpawnOptions
4. Update src/agent-registry.ts — add extensions/approve fields, update scout/planner
5. Update extensions/index.ts — register web_search, add to GATED_TOOLS, plumb extensions
6. Update src/index.ts — export new types/functions
7. Add tests: src/__tests__/web-search.test.ts (unit), test/web-search.integration.test.ts

Scout and planner sub-agents both get web_search access. Planner does NOT need bash — web_search is passed as a first-class tool via --tools.

API key: BRAVE_SEARCH_API_KEY env var (Brave free tier: 2,000 queries/month)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Create src/web-search.ts with webSearch() and registerWebSearchTool()
- [ ] #2 Create .pi/extensions/web-search.ts minimal extension
- [ ] #3 Modify src/spawn.ts to pass -e and -a flags
- [ ] #4 Update src/agent-registry.ts with extensions/approve fields and updated agent defs
- [ ] #5 Update extensions/index.ts to register tool and plumb extensions
- [ ] #6 All tests pass: pnpm test && pnpm test:integration
- [ ] #7 TypeScript compiles: pnpm typecheck; Lint passes: pnpm lint; Build: pnpm build
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Depends on: TASK-13 (research completed).
Implementation plan: research/web-search-plan.md
Chosen approach: Custom Extension Tool (web_search via pi.registerTool())
Key insight: pi --tools flag accepts extension/custom tools, -e loads extensions explicitly in spawned --mode json --no-session processes.
Brave Search API free tier: 2,000 queries/month. API key via BRAVE_SEARCH_API_KEY env var.
<!-- SECTION:NOTES:END -->
