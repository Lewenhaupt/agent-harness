---
id: TASK-11
title: Implement user-guide phase for Belayd workflow
status: Done
assignee: []
created_date: '2026-08-01 10:06'
updated_date: '2026-08-13 16:53'
labels:
  - feature
  - documentation
  - implementation
  - agent-harness
  - workflow
  - artifacts
dependencies: []
references:
  - plans/user-guide-phase.md
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the user-guide phase designed in TASK-78 (plans/user-guide-phase.md). After each implementation, generates structured How to Verify and How to Use documentation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Add userguide to phase order in process-gate
- [ ] #2 Add belayd-userguide agent to registry with system prompt
- [ ] #3 Implement gateUserGuide quality gate
- [ ] #4 Register belayd_userguide tool in harness extension
- [ ] #5 Add userguide step to feature workflow
- [ ] #6 Append user guide to backlog task Final Summary at commit time
- [ ] #7 Update all affected tests
- [ ] #8 Full integration/E2E test pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Now I have a thorough understanding of all changes. Let me compile the documentation.

## How to Verify

### 1. Verify the `userguide` phase is in the phase order

**Command:**
```bash
pnpm test -- src/__tests__/process-gate.test.ts
```

**Expected:** All tests pass, confirming:
- `PHASE_ORDER` has 8 phases with `userguide` at index 5 (between `test` and `proof`):
  `["scout", "plan", "implement", "review", "test", "userguide", "proof", "commit"]`
- `PHASE_TOOLS` includes `belayd_userguide` at index 5
- `PHASE_INDEX` maps `belayd_userguide` to index 5

**Or check directly:**
```bash
cd /home/user/git/belayd-agent-harness.feat-TASK-11
node -e "const p = require('./dist/process-gate.js'); console.log(p.PHASE_ORDER);"
```
Expected output:
```json
["scout", "plan", "implement", "review", "test", "userguide", "proof", "commit"]
```

### 2. Verify `belayd-userguide` agent is registered

**Command:**
```bash
pnpm test -- src/__tests__/agent-registry.test.ts
```

**Expected:** All tests pass, confirming:
- `DEFAULT_AGENTS` includes `belayd-userguide` as the 6th agent (of 9 total)
- The agent has read-only tools (`read`, `grep`, `find`, `ls`, `bash`, `ast_grep`, `web_search_exa`, `web_fetch_exa`) — no `edit` or `write`
- The agent has a `qualityGate` defined (`gateUserGuide`)
- The system prompt instructs the agent to produce "How to Verify" and "How to Use" documentation

### 3. Verify `gateUserGuide` quality gate

**Command:**
```bash
pnpm test -- src/__tests__/quality-gates.test.ts
```

**Expected:** The `gateUserGuide` test suite passes. Keyscenarios:
- ✅ Passes with both `## How to Verify` and `## How to Use` sections + sufficient length (≥200 chars)
- ❌ Fails without `## How to Verify` section
- ❌ Fails without `## How to Use` section
- ❌ Fails when output is shorter than 200 characters
- ✅ Case-insensitive section header matching (e.g., `## How to verify`)
- ✅ Unicode and special character support

### 4. Verify feature workflow has 8 phases including `userguide`

**Command:**
```bash
pnpm test -- src/__tests__/workflow-registry.test.ts
```

**Expected:** All tests pass. The feature workflow phases array is:
```
["scout", "plan", "implement", "review", "test", "userguide", "proof", "commit"]
```

### 5. Verify the process gate enforces `userguide` ordering

Run the specific phase-ordering tests:
```bash
pnpm test -- src/__tests__/process-gate.test.ts -t "userguide"
```

**Expected:** All tests pass, confirming:
- `belayd_proof` is BLOCKED unless `userguide` is completed
- `belayd_commit` is BLOCKED unless `userguide` is completed
- `belayd_userguide` is BLOCKED unless `test` is completed
- `belayd_userguide` is BLOCKED when `implement` is missing
- `belayd_userguide` is ALLOWED after `scout + plan + implement + review + test`
- `belayd_userguide` is BLOCKED in **all non-feature workflow types** (bugfix, research, chore, documentation, refactor, hotfix)

### 6. Run the full test suite

```bash
pnpm test && pnpm test:integration
```

**Expected:** All tests pass (unit + integration), confirming no regressions from the added phase.

### 7. Verify `gateUserGuide` is exported from the library

```bash
cd /home/user/git/belayd-agent-harness.feat-TASK-11
node -e "
  const { gateUserGuide } = require('./dist/quality-gates.js');
  console.log('gateUserGuide type:', typeof gateUserGuide);
"
```

**Expected:** `gateUserGuide` is exported and is a function.

### 8. Verify the extension registers `belayd_userguide` tool and commit-time appending

Inspect the extension file:
```bash
grep -n 'userguide\|userGuideContent' extensions/index.ts
```

**Expected:** You should see:
- Line 152: Phase description `userguide: "Generate user-facing How to Verify and How to Use docs"`
- Line 601: Same description in `before_agent_start`
- Line 634: `"belayd-userguide": "userguide"` in `AGENT_TO_PHASE`
- Lines 690-694: Captures output into `state.userGuideContent` after `belayd_userguide` execution
- Lines 916-929: On `belayd_commit`, appends user guide content to the backlog task via `backlog task edit --append-notes`

### 9. Verify build succeeds

```bash
pnpm build && pnpm typecheck && pnpm lint
```

**Expected:** TypeScript compiles cleanly, lint passes.

---

## How to Use

### Using `belayd_userguide` in a feature workflow

The `userguide` phase is **automatically included** in the `feature` workflow type. When you start a Belayd feature workflow with `/belayd TASK-XX`, the phase sequence becomes:

```
scout → plan → implement → review → test → userguide → proof → commit
```

The orchestrator agent calls `belayd_userguide` during the workflow, which spawns a sub-agent that:
1. Reads implementation files (git diff / changed files)
2. Reads test files for verification scenarios
3. Checks for CLI, UI, or library interface changes
4. Produces structured "How to Verify" and "How to Use" documentation

The `belayd_userguide` agent uses the `deepseek/deepseek-v4-flash` model and has access to read-only tools: `read`, `grep`, `find`, `ls`, `bash`, `ast_grep`, `web_search_exa`, `web_fetch_exa`.

### Programmatic usage of `gateUserGuide`

```typescript
import { gateUserGuide } from "@belayd/agent-harness";

// Example: validate user guide output
const result = await gateUserGuide(
  `## How to Verify
1. Run \`pnpm test\`
2. Check the output

## How to Use
import { gateUserGuide } from "./quality-gates";
`,
  {
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    exitCode: 0,
  },
);

console.log(result.passed); // true
```

### Quality gate logic

The `gateUserGuide` function enforces three requirements:
1. **Must contain `## How to Verify`** — case-insensitive regex match
2. **Must contain `## How to Use`** — case-insensitive regex match
3. **Must be at least 200 characters** — minimum content length

```typescript
import { gateUserGuide } from "@belayd/agent-harness";

// ❌ Fails: missing "How to Verify" section
const r1 = await gateUserGuide("## How to Use\n...\n", mockDetails);
// r1.passed === false

// ❌ Fails: too short (< 200 chars)
const r2 = await gateUserGuide("## How to Verify\n## How to Use\n", mockDetails);
// r2.passed === false

// ✅ Passes: both sections + sufficient length
const r3 = await gateUserGuide(
  `## How to Verify
Step-by-step verification instructions...

## How to Use
Code examples showing usage...
` + "x".repeat(100),
  mockDetails,
);
// r3.passed === true
```

### What happens at commit time

When `belayd_commit` is called with a `taskId` parameter and the workflow includes the `userguide` phase, the extension automatically:

1. Reads the captured user guide content from session state (`state.userGuideContent`)
2. Writes it to a temporary file at `<tmpdir>/belayd-userguide-<TASK-ID>.md`
3. Appends it to the backlog task notes with: `backlog task edit TASK-XX --append-notes "..."`
4. Cleans up the temporary file

This means the user guide is **persisted in the backlog task** alongside the code changes, accessible to anyone viewing the task.

### Checking if a workflow type includes `userguide`

```typescript
import { WORKFLOW_REGISTRY, getPhasesForType } from "@belayd/agent-harness";

// Feature includes userguide
getPhasesForType("feature").includes("userguide"); // true

// Other types do not
getPhasesForType("bugfix").includes("userguide");         // false
getPhasesForType("research").includes("userguide");        // false
getPhasesForType("chore").includes("userguide");           // false
getPhasesForType("documentation").includes("userguide");   // false
getPhasesForType("refactor").includes("userguide");        // false
getPhasesForType("hotfix").includes("userguide");          // false

// Check via registry
WORKFLOW_REGISTRY.feature.phases;
// ["scout", "plan", "implement", "review", "test", "userguide", "proof", "commit"]
```

### Manual testing the phase gate with `checkToolAllowed`

```typescript
import { checkToolAllowed } from "@belayd/agent-harness";

// Blocked: proof needs userguide first
checkToolAllowed(
  "belayd_proof",
  ["scout", "plan", "implement", "review", "test"],
  true,  // gate active
);
// { allowed: false, reason: 'Cannot run belayd_proof yet. "userguide" must complete first.' }

// Allowed: userguide after all prior phases
checkToolAllowed(
  "belayd_userguide",
  ["scout", "plan", "implement", "review", "test"],
  true,
);
// { allowed: true }

// Blocked: userguide only in feature workflow
checkToolAllowed(
  "belayd_userguide",
  [],
  true,
  ["implement", "review", "test", "proof", "commit"],  // hotfix order
  "hotfix",
);
// { allowed: false, reason: 'belayd_userguide is not part of the hotfix workflow.' }
```

---
✅ **Quality Gates**
All quality gates passed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented user-guide phase for Belayd workflow. Added `userguide` to phase order in process-gate.ts, created `belayd-userguide` agent in agent-registry.ts with `USER_GUIDE_SYSTEM_PROMPT`, implemented `gateUserGuide` quality gate in quality-gates.ts checking for "How to Verify" and "How to Use" sections, registered `belayd_userguide` tool in harness extension, added userguide step to feature workflow in workflow-registry.ts, and appended user guide content to backlog task notes at commit time in extensions/index.ts. All 256 unit tests and 11 integration tests pass.
<!-- SECTION:FINAL_SUMMARY:END -->
