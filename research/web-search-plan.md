# Web Search for Belayd Sub-Agents — Corrected Research Plan

## Decision Summary

**Chosen approach**: Custom Extension Tool (`web_search` via `pi.registerTool()`).

**Initial incorrect finding**: Custom extension tools registered via `pi.registerTool()` are NOT inherited by spawned sub-agent processes (`pi --mode json --no-session`), because spawned processes start fresh without the extension's tool registrations.

**Why that was wrong**: The conclusion was correct that tools aren't "inherited" — but the fix isn't to fall back to bash. The fix is to **pass the extension to the sub-agent** so it can register its own tools in the child process. Pi's CLI supports this directly:

| Flag | Purpose |
|------|---------|
| `--tools, -t <tools>` | Allowlist applies to **built-in, extension, and custom tools** |
| `--extension, -e <path>` | Load an extension file in the spawned process |
| `--approve, -a` | Trust project-local files for this run |

## Why Custom Extension Tool Wins

| Approach | Verdict | Reason |
|----------|---------|--------|
| **Custom extension tool** (`web_search` via `pi.registerTool()`) | ✅ **Recommended** | Sub-agent receives `-e <ext-path> -a --tools read,...,web_search`. Clean, typed, no bash needed. |
| Bash-based pi skill | ❌ Replaced | Works but requires `bash` tool in planner (security concern), needs grep on JSON output, no structured parameters. |
| Install existing pi package | ❌ N/A | No web search package exists in pi core or registry. |
| bash + curl directly | ❌ Rejected | No structured results, harder to prompt, no error handling, security concern. |

## Architecture

### Extension Structure

```
extensions/
├── index.ts              # Main belayd-harness extension (existing)
├── stale-file-guard.ts   # Stale-file guard extension (existing)
└── web-search.ts         # ⬅️ New: registers web_search tool
```

### Registration

```typescript
// extensions/web-search.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function webSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Search the web via Brave Search API",
    description: "Search the web using the Brave Search API. Returns JSON results with title, URL, and snippet for each result.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string" }),
      count: Type.Optional(Type.Number({ description: "Number of results (default: 5)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const apiKey = process.env.BRAVE_SEARCH_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text" as const, text: "BRAVE_SEARCH_API_KEY not set" }],
        };
      }
      const count = params.count ?? 5;
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(params.query)}&count=${count}`;
      const response = await fetch(url, {
        headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
      });
      const data = await response.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
      const results = data.web?.results ?? [];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(results.map(r => ({ title: r.title, url: r.url, snippet: r.description })), null, 2),
        }],
      };
    },
  });
}
```

### Two Deployment Paths

| Path | Mechanism | How Tools Reach Agent |
|------|-----------|-----------------------|
| **Main session auto-discovery** | `pi` reads `.pi/extensions/belayd-harness/index.ts`, which imports and registers `web-search` | Auto-discovered — no CLI flags needed |
| **Sub-agent `-e` flag** | `spawnAgentProcess()` adds `-e <ext-path> -a` to the pi CLI args | Explicit flag loads extension in child process |

### Flow Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                       MAIN PI SESSION                              │
│                                                                    │
│  pi --mode text                                                     │
│    ↳ loads .pi/extensions/belayd-harness/index.ts                  │
│        ↳ imports extensions/web-search.ts                          │
│            ↳ pi.registerTool("web_search", ...)                    │
│        ↳ registers belayd_scout, belayd_plan, etc.                 │
│                                                                    │
│  Planner calls belayd_plan({ task: "..." })                        │
│    ↓                                                               │
│  spawnAgentProcess()                                               │
│    ↓                                                               │
│  pi --mode json --no-session                                       │
│     --model ...                                                    │
│     --tools read,grep,find,ls,web_search  ← custom tool in list   │
│     --extension extensions/web-search.ts   ← loads extension       │
│     --approve                              ← trusts project files  │
│     --append-system-prompt ...                                     │
│     "task description"                                             │
│    ↓                                                               │
│  SUB-AGENT PI PROCESS                                              │
│    ↳ reads --extension → loads web-search.ts                       │
│        ↳ pi.registerTool("web_search", ...)  ← registered locally │
│    ↳ has web_search available via --tools allowlist                │
│    ↳ calls web_search({ query: "..." })                          │
│    ↳ returns JSON results                                          │
└────────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

### Step 1: Create `extensions/web-search.ts`
- Register `web_search` tool with Brave Search API integration
- Parameters: `query` (string), `count` (optional number)
- Uses `fetch` (Node.js 18+ built-in)
- Returns structured JSON: `[{ title, url, snippet }]`
- Handle missing `BRAVE_SEARCH_API_KEY` gracefully
- No external dependencies beyond `typebox` and `@earendil-works/pi-coding-agent`

### Step 2: Wire into main extension
- In `extensions/index.ts`, import and call `webSearchExtension(pi)` during the extension factory
- This makes `web_search` available in the main session (auto-discovery path)

### Step 3: Update `spawnAgentProcess()` in `src/spawn.ts`
- Resolve the extension path: `join(projectRoot, "extensions/web-search.ts")`
- Add `--extension`, `<resolved-path>`, `--approve` to pi CLI args
- Conditionally: only add if the agent's tool list includes a custom tool (or make it unconditional)

### Step 4: Update agent tool lists in `src/agent-registry.ts`
- Add `"web_search"` to the **planner's** `tools` array (replacing or alongside current tools)
- Optionally add to scout's tools too

### Step 5: Add extension to pi project config
- Add `extensions/web-search.ts` to `.pi/extensions/belayd-harness/index.ts` import chain
- Or register as a separate extension path

### Step 6: Update agents' system prompts
- Add web search usage instructions to planner's system prompt
- Mention `web_search` tool availability and how to use it effectively

### Step 7: Tests
- `src/__tests__/spawn.test.ts` — Verify that `-e` and `-a` are included in args when custom tools are present
- `src/__tests__/agent-registry.test.ts` — Verify planner's tools include `web_search`
- `test/web-search.integration.test.ts` — Integration test (skipped without `BRAVE_SEARCH_API_KEY`)

## Key Advantage: Planner No Longer Needs `bash`

The initial bash-based approach required adding `bash` to the planner's tools. This was a **security and architectural concern** because:

- `bash` is a powerful, unrestricted tool that can modify the filesystem
- The process gate (`GATED_TOOLS`) had to explicitly block `edit` and `write` to prevent misuse
- The planner's system prompt needed strong "read-only" language

With the custom extension tool approach:

```
Planner tools BEFORE (incorrect):  read, grep, find, ls, bash
Planner tools AFTER (correct):     read, grep, find, ls, web_search
```

The `web_search` tool is:
- **Read-only by design** — it only queries an external API
- **Type-safe** — parameters are validated via TypeBox schema
- **Self-documenting** — the tool's label and description tell the LLM exactly what it does
- **Testable** — can be unit tested without mocking the entire process

## API Key Management

- Environment variable: `BRAVE_SEARCH_API_KEY`
- Added to `.envrc` (direnv manages it)
- Sub-agents inherit parent env (Node.js `spawn` without `env` override)
- Brave signup: https://api.search.brave.com/app/dashboard
- Free tier: 2,000 queries/month, 1 query/second

## Agent Access

| Agent | Gets Web Search? | Reason |
|-------|-----------------|--------|
| Scout | ✅ Recommended | Needs it for unfamiliar codebases |
| Planner | ✅ **Primary target** | Needs it for API docs, prior art |
| Implementer | ❌ | Has bash already, unlikely to need search |
| Reviewer | ⚠️ Optional | Could use for vulnerability research |
| Tester | ❌ | No search needed for test writing |
| Proofer | ❌ | No search needed for proof capture |
| Documenter | ❌ | No search needed for doc updates |
| Committer | ❌ | No search needed for git commits |

## Safety

- `web_search` tool has no filesystem access — it only calls the Brave Search API
- No `bash` required in planner → no risk of planner making filesystem changes
- API key is never logged or exposed in tool output
- Process gate (`GATED_TOOLS`) is unaffected — it only restricts filesystem tools

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `-e` flag not supported by old pi versions | Document minimum pi version requirement; add validation in spawn |
| Extension path resolution in worktrees | Resolve extension path relative to project root, not worktree root |
| Brave API changes | Single file, no deps, easy to update |
| Rate limiting (1 query/sec, 2000/month) | Document in extension label; handle HTTP 429 gracefully |
| Sub-agent `--no-approve` setting | Explicitly pass `-a` flag in spawn args |
