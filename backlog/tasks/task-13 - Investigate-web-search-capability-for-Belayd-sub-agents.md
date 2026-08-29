---
id: TASK-13
title: Investigate web search capability for Belayd sub-agents
status: Done
assignee: []
created_date: '2026-08-01 21:30'
updated_date: '2026-08-11 20:18'
labels:
  - research
  - investigation
  - agent-harness
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Belayd sub-agents (scout, planner, reviewer) currently have no web search
capability. The scout and planner in particular could benefit from searching
external documentation, APIs, or prior art when investigating unfamiliar
codebases or planning implementations.

Investigate options:

- **Custom tool**: Register a `web_search` tool in the Belayd extension that
  wraps a search API (Brave, Tavily, SerpAPI, etc.)
- **pi package**: Install an existing pi package that provides web search
  (e.g., `@brave-search` skill)
- **`bash` + `curl`**: Give sub-agents bash access and rely on `curl` for
  API calls — but this lacks structured search results and requires careful
  prompting
- **Skills**: Create a skill that teaches the agent how to perform web
  searches via available tools

Considerations:
- API key management (provider auth)
- Cost (search APIs charge per query)
- Sandbox safety (don't let sub-agents browse arbitrary URLs unless intended)
- Which agents need it (scout definitely, planner maybe, others less clear)

Output: a plan for implementing web search, including the chosen approach,
API key setup, and which agents get the capability.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Survey available web search APIs (Brave, Tavily, SerpAPI, etc.)
- [x] #2 Check if a pi-compatible web search package/skill already exists
- [x] #3 Evaluate integration approach (custom tool vs package vs bash+curl)
- [x] #4 Determine which sub-agents need web search
- [x] #5 Produce a plan document with the chosen approach and implementation steps
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Plan document committed to the repo
- [x] #2 Decision documented with rationale
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Investigated web search for Belayd sub-agents. Initial plan chose bash-based pi skill, but corrected finding shows custom extension tools CAN work: pi --tools flag accepts built-in/extension/custom tools, and -e loads extensions explicitly. Final recommendation: Custom Extension Tool (web_search via pi.registerTool()). Architecture: src/web-search.ts → shared by extensions/index.ts (main session) and .pi/extensions/web-search.ts (sub-agents via -e flag). Planner no longer needs bash. Implementation plan: 7 steps across 9 files. See research/web-search-plan.md.
<!-- SECTION:FINAL_SUMMARY:END -->
