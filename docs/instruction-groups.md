# Managed instruction groups (bd-114)

Some pi extensions ship a large system-prompt section and gate it on tool
availability through pi's `pi:instruction-groups` event channel. pi 1.0.2 never
emits that channel, so the extension's eager fallback writes the section on
every turn — even in sessions whose `--tools` allowlist contains none of its
tools. The worst offender is `pi-agent-browser-native`: its browser prompt is
measured at **34,769 chars (~8.7k tokens)** per turn (the `agent_browser`
section in a real sub-agent session).

The harness closes the gap. `extensions/index.ts` registers a dedicated
`before_agent_start` handler that emits `pi:instruction-groups` itself, and
`src/instruction-groups.ts` owns the gate: a managed group's section is written
under its **group name** (`browser`) only when at least one of the group's
tools is in the session's `selectedTools` allowlist. The legacy `agent_browser`
fallback key is deleted whenever the collector owns any group, so a load order
that lets the unmanaged fallback run cannot append a duplicate section.

User-visible effects:

| Change | Effect |
|--------|--------|
| Allowlist gate | Sub-agent sessions that exclude every browser tool no longer carry the ~34.7k-char section. Affected phases today: scout, plan, review, test, userguide, documenter, committer, proof-verifier. |
| Section tag rename | Browser-enabled sessions (implementer, proof-generator) render `<browser>…</browser>` instead of `<agent_browser>…</agent_browser>`. This is a one-time prompt-cache invalidation, not a regression. |
| Tester allowlist | `belayd-tester` no longer carries `agent_browser` (0 browser calls across 55 sessions of evidence) — see `src/agent-registry.ts:588`. |

Nothing is configurable per session: the allowlist the harness spawns the agent
with (`src/agent-registry.ts`) decides it. The gate is bypassed (and unmanaged
fallback behaviour preserved exactly) when `selectedTools` is missing/empty or
no extension registered a group.

## How to Verify

Run from the repository root in the project devShell (`direnv exec . bash`, or
wrap commands in `nix develop -c bash -c '<cmd>'`). Build first so the `node -e`
steps can read `dist/`.

```bash
pnpm build
```

1. **Confirm the allowlists.** Exactly two agents carry `agent_browser`:

   ```bash
   node -e '
   const { DEFAULT_AGENTS } = require("./dist/src/agent-registry.js");
   for (const agent of DEFAULT_AGENTS) {
     console.log(agent.name, "agent_browser=" + agent.tools.includes("agent_browser"));
   }'
   ```

   Expected:

   ```text
   belayd-scout agent_browser=false
   belayd-planner agent_browser=false
   belayd-implementer agent_browser=true
   belayd-reviewer agent_browser=false
   belayd-tester agent_browser=false
   belayd-userguide agent_browser=false
   belayd-proof-generator agent_browser=true
   belayd-documenter agent_browser=false
   belayd-committer agent_browser=false
   ```

   Source equivalent: `src/agent-registry.ts:560` (`belayd-implementer`) and
   `src/agent-registry.ts:604` (`belayd-proof-generator`) end their `tools`
   array with `"agent_browser"`; `belayd-tester` (`src/agent-registry.ts:588`)
   does not. `belayd-proof-verifier` (`PROOF_VERIFIER_AGENT`) has
   `["read", "describe_image"]` and is therefore also excluded.

2. **Confirm the gate against the real allowlists.** This runs the same
   `manageInstructionGroups` the extension calls, with a `browser` group
   registered through an emit callback, once per agent. It also proves the
   legacy `agent_browser` key never survives a managed turn:

   ```bash
   node -e '
   const { DEFAULT_AGENTS } = require("./dist/src/agent-registry.js");
   const { createInstructionGroupCollector, manageInstructionGroups } = require("./dist/src/instruction-groups.js");
   for (const agent of DEFAULT_AGENTS) {
     const sections = { agent_browser: "legacy" };
     const result = manageInstructionGroups({
       collector: createInstructionGroupCollector(),
       emitInstructionGroups: (collector) =>
         collector.register({ name: "browser", tools: ["agent_browser"], instructions: () => "<browser>x</browser>" }),
       systemPromptOptions: { sections, selectedTools: agent.tools },
       ctx: {},
     });
     console.log(agent.name, "browser=" + ("browser" in sections), "legacy=" + ("agent_browser" in sections), "managed=" + result.managed);
   }'
   ```

   Expected: `browser=false legacy=false managed=true` for scout, planner,
   reviewer, tester, userguide, documenter, committer; and
   `browser=true legacy=false managed=true` for implementer and
   proof-generator. The pure-function shortcut (`applyInstructionGroupSections`
   with the same group) prints the same `browser=` column without the emit.

3. **Live end-to-end — the sub-agent's own session.** The gate runs inside the
   sub-agent's pi process, so a live check inspects that process's session
   JSONL. pi stores sessions at
   `~/.pi/agent/sessions/<project-slug>/<timestamp>_<session-id>.jsonl`, where
   `<project-slug>` is the absolute cwd with its leading `/` removed, every
   remaining `/`, `\\`, and `:` replaced by `-`, and the whole thing wrapped in
   `--` (this worktree:
   `~/.pi/agent/sessions/--home-hugo-git-belayd-agent-harness.feat-bd-114--/`);
   the sub-agent id and file name segment is
   `belayd-<task-id>-sub-<phase>-<shortRunId>`.

   **Prerequisite:** the pi process that spawns the sub-agent must load the
   bd-114 harness extension (the Nix-installed global
   `~/.pi/agent/extensions/belayd-harness.ts`, or — in a dev checkout — the
   worktree extension, by exporting `PI_BINARY_PATH="$PWD/bin/pi"` before
   starting the orchestrator, since `src/spawn.ts`'s `resolvePiBinary` honours
   `PI_BINARY_PATH` first).

   a. In an orchestrator session in this worktree, start a task workflow
      (`/belayd bd-114`) and let the **scout** phase complete (feature
      workflows run scout first). Then inspect the newest scout session:

      ```bash
      dir=~/.pi/agent/sessions/--home-hugo-git-belayd-agent-harness.feat-bd-114--
      f=$(ls -t "$dir"/*_belayd-bd-114-sub-scout-*.jsonl | head -1)
      echo "$f"
      jq -r 'select(.type=="message" and .message.role=="system") | .message.sections | keys | @csv' "$f" | head -1
      ```

      Expected: the first system message's section keys contain **neither**
      `browser` **nor** `agent_browser`:

      ```text
      "addendum","cwd","docs","preamble","project_context","rules","skills","tools"
      ```

      A per-section boolean form:

      ```bash
      jq -r 'select(.type=="message" and .message.role=="system") | .message.sections | has("browser")' "$f"
      # false
      jq -r 'select(.type=="message" and .message.role=="system") | .message.sections | has("agent_browser")' "$f"
      # false
      ```

   b. Run the **implement** phase (it follows scout in a feature workflow) and
      inspect its session:

      ```bash
      dir=~/.pi/agent/sessions/--home-hugo-git-belayd-agent-harness.feat-bd-114--
      f=$(ls -t "$dir"/*_belayd-bd-114-sub-implement-*.jsonl | head -1)
      jq -r 'select(.type=="message" and .message.role=="system") | .message.sections | keys | @csv' "$f" | head -1
      jq -r 'select(.type=="message" and .message.role=="system") | .message.sections | has("browser")' "$f"
      # true
      ```

      Expected: `browser` is in the key list (under its new name) and
      `agent_browser` is absent.

   > Do **not** `grep '<browser>'` / `grep '<agent_browser>'` the raw JSONL:
   > the transcript legitimately contains those strings in `project_context`
   > (this doc, `AGENTS.md`) and in tool output (e.g. a search that matched
   > them), so raw grep reports false positives. Test
   > `.message.sections` with `jq` instead.

4. **Full suite.**

   ```bash
   pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
   ```

   Expected (observed on the bd-114 verification host): 63 unit test files /
   1361 tests pass, 5 integration files / 58 tests pass, `tsc --noEmit` is
   clean, `biome check .` reports "Checked 117 files … No fixes applied", and
   `tsc` emits `dist/`.

5. **Automated regression guards.**

   ```bash
   pnpm vitest run src/__tests__/instruction-groups.test.ts \
     src/__tests__/extension-instruction-groups.test.ts
   ```

   Expected: `2 passed (2)` files / `48 passed (48)` tests.
   `src/__tests__/instruction-groups.test.ts` includes a `DEFAULT_AGENTS`
   regression guard that pins the browser-enabled set to exactly
   `["belayd-implementer", "belayd-proof-generator"]`; the extension test covers
   the once-per-session warning dedupe.

## How to Use

### Default behaviour

Nothing to configure. Every spawned sub-agent gets a `--tools` list derived
from its agent definition in `src/agent-registry.ts`; the gate activates the
`browser` group only for sessions whose list contains `agent_browser`. For
today's registry that means implementer and proof-generator keep the browser
prompt; every other phase runs ~8.7k tokens/turn lighter.

### Turn the section back on for an agent

Add `"agent_browser"` to that agent's `tools` array in `src/agent-registry.ts`
and rebuild/reinstall the extension so the spawned pi loads it. For example,
`belayd-scout` (`src/agent-registry.ts:535`) becomes:

```ts
tools: ["read", "grep", "find", "ls", "bash", "ast_grep", "web_search_exa",
        "web_fetch_exa", "agent_browser"],
```

The next scout session then renders `<browser>…</browser>`. Update the pinned
expectation in `src/__tests__/instruction-groups.test.ts` (`browserAgents`,
line ~801) in the same change, or that test fails by design.

### Add a new managed group for a different large prompt

A third-party extension opts in by listening on the channel. The collector
shape is `{ register, isManaged, groups, isEmpty }`, and
`INSTRUCTION_GROUPS_CHANNEL === "pi:instruction-groups"`:

```ts
import type { InstructionGroupCollector } from "belayd-agent-harness";
import { INSTRUCTION_GROUPS_CHANNEL } from "belayd-agent-harness";

export default function myExtension(pi: ExtensionAPI): void {
  let managed = () => false;
  pi.events.on(INSTRUCTION_GROUPS_CHANNEL, (collector: InstructionGroupCollector) => {
    collector.register({
      name: "my_group",
      tools: ["my_tool", "my_other_tool"],
      instructions: () => "<my_group>…large instructions…</my_group>",
    });
    // Mirror the browser extension: disable your own eager fallback once managed.
    managed = collector.isManaged;
  });
  pi.on("before_agent_start", (event) => {
    if (!managed()) {
      event.systemPromptOptions.sections.my_agent_browser_key = "<my_group>…</my_group>";
    }
  });
}
```

Registration rules (enforced in `src/instruction-groups.ts`):

- `name` must match `/^[a-z][a-z0-9_-]*$/` and must not be `preamble` (pi
  renders `preamble` as untagged text; a bad name would throw at prompt-build
  time). Rejections return
  `{ registered: false, reason: "invalid-name" | "reserved-name" | "invalid-tools" }`
  instead of throwing.
- `tools` must be an array; the group is active when any entry is in the
  session allowlist (exact match, never substring).
- Re-registering the same `name` replaces the previous group (last wins), so
  re-emitting the channel every turn is safe.

### Observable log lines

All lines are prefixed `[belayd-harness] `:

| Line | Meaning | Frequency |
|------|---------|-----------|
| `instruction-group gate skipped: no-selected-tools` | The gate did not run: `selectedTools` was absent/empty. `no-system-prompt-options` and `no-sections` mean the same for the other prompt fields. | Every turn the condition holds |
| `instruction-group channel emitted but no group registered` | The harness emitted the channel but no extension registered a group, so it fell back to unmanaged behaviour (the fallback re-enables). | Once per session |
| `instruction group "<name>" failed: <error>` | A registered group's `instructions` thunk threw; that section is omitted and the session continues. | Every turn it throws |
| `instruction-group prompt gate failed: <error>` | Unexpected error inside the gate handler (defensive catch). | Every turn it throws |

## Troubleshooting

| Symptom | Likely cause | Check |
|---------|--------------|-------|
| Browser section present even though the session has no browser tool | Collector never registered — the harness extension is not loaded in that pi, so the foreign eager fallback wins | `ls ~/.pi/agent/extensions/` for the `belayd-*.ts` symlinks; for the dev wrapper, the `-e "$repo_dir/extensions/index.ts"` line in `bin/pi`; for the configured/spawned pi, the global `belayd-harness.ts` and its `[belayd-harness] registering tools/commands from …` startup line |
| Browser section absent even though the tool *is* in `--tools` | `isManaged` flipped true but a group never registered (the foreign listener sets its flag on emit even if its own register is rejected/absent), or `selectedTools` is unavailable on an unexpected pi version | Search the session's stderr/journal for `instruction-group channel emitted but no group registered` (once per session) or `instruction-group gate skipped: no-selected-tools` |
| `agent_browser` tool offered but its prompt section missing | The allowlist edit was made without rebuilding/reinstalling the extension the spawned pi loads; the two can be out of sync | Rebuild the harness extension (push + `nixos-rebuild` for the global copy, or `bin/pi` in a dev checkout) and re-spawn the agent |
| Section appears as `<agent_browser>…</agent_browser>` again | A pre-bd-114 harness extension is loaded (old code wrote the legacy key directly) | Confirm the loaded extension is the bd-114 build; restart pi / the pi-web daemon after a rebuild |
| A group registered by a *lazily attached* listener is missing | Residual design assumption: the collector stops emitting once any group registers, so an extension that attaches its `pi:instruction-groups` listener after the first emit never receives the collector — and if another group is managed, the legacy key deletion can hide its fallback too. Current extensions attach at load time, so this is an assumption, not a known bug. | Confirm the extension registers its listener during `register()` (load time), not inside a later `before_agent_start` |

## Related documentation

- [`agent_browser` in the harness](agent-browser-tool.md) — the browser tool
  itself, its three load surfaces, and the allowlist/quality-gate runbook.
- [`agent_browser` in pi-web orchestrator sessions](pi-web-agent-browser.md) —
  the pi-web specific wiring and post-rebuild live checks.
- [Subagent session management](subagent-sessions.md) — session naming,
  listing, and inspection.
- [Bash timeout enforcement](bash-timeout.md) — the other dedicated
  `tool_call` handler in `extensions/index.ts`, which mutates the bash timeout
  rather than gating a prompt section, for comparison.
