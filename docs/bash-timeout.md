# Bounded bash timeouts (bd-105)

Every bash call made by an agent running under the harness extension is now
bounded. Pi's built-in bash tool accepts an optional `timeout` (seconds) and
has no default, so an omitted value previously let a command run until pi's own
ceiling. The harness patches a deterministic timeout into every bash
`tool_call` before execution.

Policy (hardcoded in `src/bash-timeout.ts`, no env var or settings knob):

| Caller-supplied `timeout` | Effective timeout |
|---------------------------|-------------------|
| omitted `undefined`        | `BASH_DEFAULT_TIMEOUT_SECONDS` = **600s** (10 min) |
| `0`, negative, `NaN`, `Infinity`, non-number | **600s** (falls back to default) |
| in range `(0, 1800]`       | preserved unchanged (e.g. `60` -> `60`) |
| `> 1800`                   | clamped to `BASH_MAX_TIMEOUT_SECONDS` = **1800s** (30 min) |

The handler mutates `event.input.timeout` in place instead of blocking, so it
applies to every session — orchestrator and sub-agents alike. It is registered
as its own `tool_call` handler (separate from the process gate) and never
returns `block: true`.

Non-goals: the `powershell` tool, proof-verification exec calls, the
`spawn.ts` wall-clock timeout, and `scripts/belayd-shell.sh` are not affected.

## How to Verify

Run these commands from the repository root. Run each command to completion.

1. Run the unit tests for the pure policy and the extension hook:

   ```bash
   pnpm test
   ```

   Expected: all unit tests pass. This includes
   `src/__tests__/bash-timeout.test.ts` (default/cap constants and
   `resolveBashTimeout` cases: omitted, in-range, `1800`, `>1800`, `0`,
   negative, `NaN`, `Infinity`, non-number) and
   `src/__tests__/extension-bash-timeout.test.ts` (the registered `tool_call`
   handler patches `bash`/legacy `Bash` events, leaves non-bash input
   untouched, and never sets `block`).

2. Compile, lint, and build:

   ```bash
   pnpm typecheck && pnpm lint && pnpm build
   ```

   Expected: each exits 0.

3. Manual experiment — confirm a live agent bash call is bounded. In a pi
   session that has the harness extension loaded (e.g. start `pi` inside this
   repo after `pnpm install` / `pi install -l`):

   a. Ask the agent to run a bash command with **no timeout**, e.g. a bash
      tool call with input `{ "command": "sleep 1" }`.

   b. Ask the agent to run a bash command with an **oversized timeout**, e.g.
      input `{ "command": "true", "timeout": 9999 }`.

   c. Ask the agent to run a bash command with an **in-range timeout**, e.g.
      input `{ "command": "true", "timeout": 60 }`.

   d. Inspect the recorded tool-call inputs in the session log. Pi stores
      sessions as JSONL under `~/.pi/agent/sessions/<cwd-slug>/`; find the most
      recent log for this repo and read the effective timeouts:

      ```bash
      f=$(find ~/.pi/agent/sessions -name '*.jsonl' -path '*belayd-agent-harness*' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
      grep -o '"timeout":[0-9]*' "$f" | tail -5
      ```

      Expected for the three calls above: `"timeout":600` (default applied),
      `"timeout":1800` (9999 clamped), and `"timeout":60` (in-range preserved).

   e. Optional end-to-end proof of the *bound* (takes ~10 minutes): ask the
      agent to run `{ "command": "sleep 700" }` with no timeout. The call is
      terminated near 600s rather than running to completion. Commands that
      legitimately need more than 30 minutes must be restructured to run
      backgrounded/detached.

## How to Use

The constants and resolver are part of the library's public API (re-exported
from `src/index.ts`), so consumers can reuse the exact policy:

```typescript
import {
  BASH_DEFAULT_TIMEOUT_SECONDS, // 600
  BASH_MAX_TIMEOUT_SECONDS,     // 1800
  resolveBashTimeout,
} from "belayd-agent-harness";

resolveBashTimeout({});                      // 600  (omitted)
resolveBashTimeout({ timeout: 60 });         // 60   (in range)
resolveBashTimeout({ timeout: 1800 });       // 1800 (at cap)
resolveBashTimeout({ timeout: 3600 });       // 1800 (clamped)
resolveBashTimeout({ timeout: 0 });          // 600  (invalid -> default)
resolveBashTimeout({ timeout: Number.NaN }); // 600  (invalid -> default)
```

Within an agent session, no action is required: bash tool calls are bounded
automatically. To request a shorter timeout than the default, pass `timeout`
(in seconds) and it is preserved as long as it is positive and at most 1800:

```json
{ "command": "pnpm test", "timeout": 300 }
```

There is no way to raise the cap. A command that needs more than 30 minutes
must be restructured (for example, launch it detached, write a log file, and
poll the log in later bash calls).
