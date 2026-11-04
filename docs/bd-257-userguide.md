# Session model pre-flight — operator guide (bd-257)

A pi session the operator creates directly (pi-web or `./bin/pi`) used to start on
the global default from `~/.pi/agent/settings.json` verbatim, with no availability
check. When that default's provider was already cooling for quota, the session's
first turn spent a `402`/`429` before in-session recovery (bd-229) could switch —
and if that first failure was not classified as fallback-worthy, no switch
happened at all.

bd-257 adds one `session_start` hook,
`extensions/capabilities/session-model-routing.ts`, that routes such a session off
a model whose provider or exact endpoint is **known** unable to serve, before the
first turn. It reads the same stores as the `/belayd` launch pre-flight (bd-229)
and in-session recovery, through the shared helpers in
`extensions/capabilities/model-availability.ts`.

What it does, precisely:

| Property | Behaviour |
|---|---|
| Runs on | every `session_start` of a session whose name has no `-sub-` marker (`isSubAgentSession`), including a resumed session |
| Switches when | the session's current model's provider is cooled (`ModelStateStore`, the shared SQLite cooldown table) or the model's exact endpoint has a capacity window (`CapacityCache`). Nothing else |
| Healthy default | left exactly as the operator chose it, silently — no log line, no `setModel` |
| Target | the first candidate in `candidatesForModel(current)` order (same model id on an alternate provider first, then the rest of the class — see [`docs/agent-model-class.md`](agent-model-class.md)) that `pi.setModel` **accepts**. A candidate the session cannot switch to (no credential, unknown wire id) falls through to the next |
| Persistence | the switch is recorded in the **session transcript** (`model_change` entry via `appendModelChange`), so it survives a restart. It never writes `~/.pi/agent/settings.json` |
| Phase sub-agents | skipped. Their model comes from `resolveModelSpec` plus the workflow's per-phase override, and their attempts and telemetry belong to `spawn-with-fallback` |
| All candidates blocked | no switch; one warning naming each blocked provider and its reset window, plus the same warning in the UI, then the first turn runs on the cooled default and in-session recovery absorbs that one failed request |
| Guard | `BELAYD_MODEL_FALLBACK=0` skips the whole pre-flight before the store is read |
| Failure | caught and logged (`session model pre-flight failed: …`); it never rejects, so pi's other `session_start` handlers (telemetry reset, bd-187 provider wrapping, gate resume) still run |
| Freshness | cooldown reads are live: every check queries the shared store (`listCooldowns`), so another process's mark is visible with no refresh step. The capacity cache may be re-probed once when stale (TTL 5 min) — the same rule as the launch pre-flight |

Design rationale, the shared helpers and the signal-freshness contract live in
[`docs/model-capacity-and-telemetry.md`](model-capacity-and-telemetry.md)
(“Orchestrator sessions route their own model”, step 4). The cooldown signal is
the shared `ModelStateStore` (bd-256 landed):
`$XDG_STATE_HOME/belayd/model-state.sqlite` (or `BELAYD_MODEL_STATE_FILE`), and
`~/.pi/agent/model-cooldowns.json` is only imported into it once.

## How to Verify

Run from the repository root (`/home/hugo/git/belayd-agent-harness.feat-bd-257`),
in a devShell.

### 1. The focused suites — the actual decisions, no network

```bash
pnpm vitest run src/__tests__/extension-session-model-routing.test.ts \
  src/__tests__/extension-model-recovery.test.ts \
  src/__tests__/orchestrator-model.test.ts
```

Expected (measured in this worktree): `Test Files 3 passed (3)`,
`Tests 38 passed (38)` — 11 pre-flight cases, 13 recovery cases, 14
`planModelRoute`/`describeBlockedProviders`/`splitModelRoute` cases.

The 11 pre-flight cases are the ones that pin this feature:

| Case | Pins |
|---|---|
| `routes a session off a cooled default before its first turn` | old-before-new ordering, the reason string and the ISO reset window, against a clock-pinned store |
| `logs the routing line to the harness sink when no notify is injected` | the exact `[belayd-harness] session model routed from … to … because … cannot serve a turn.` text |
| `reports a routing failure without rejecting session_start` | the catch path: one warning, no routing line, the handler resolves |
| `leaves a healthy default untouched` | silence — no `setModel`, no log, no UI notify |
| `reports the blocked providers instead of starting silently dead` | the all-cooled warning, every provider named, `resets` present, `ui.notify` called once |
| `skips the pre-flight entirely when fallback is disabled` | `BELAYD_MODEL_FALLBACK=0` short-circuits **before** the store is even refreshed |
| `leaves a phase sub-agent alone even when its model is cooled` | the `-sub-` skip |
| `falls through a candidate the session cannot switch to` | two `setModel` calls, second candidate wins |
| `sees a provider another process cooled after the store was created (bd-234)` | a peer connection's mark is seen by the next decision (structural: reads are live, not a re-read) |
| `routes on a capacity window without a cooldown entry` | a capacity-only block routes, and the stale cache is re-probed once |
| `runs the pre-flight registered by the composed extension` | the real `extensions/index.ts` composition registers the hook and reaches the default console sink |

### 2. Full gates

```bash
pnpm test && pnpm test:integration
pnpm typecheck && pnpm lint && pnpm build
```

Expected: unit suite `172 files / 4781 tests` passed, integration
`16 files / 115 tests` passed, and three silent exit-0 commands. These were run
in the phase that wrote this guide; treat the counts as approximate as soon as
the tree moves.

### 3. Live check: a cooled default is routed (needs a real pi session)

The hook only exists inside a running pi process — no test substitutes for this
step. `./bin/pi` is the local dev loop: it runs `pi` with `-ne` plus explicit `-e`
paths, so the **worktree** `extensions/` is the code that loads (the Nix-installed
copy at `~/.pi/agent/extensions/belayd-harness` would otherwise win).

This host's default is `llmgateway/deepseek-v4.1-flash`
(`~/.pi/agent/settings.json`). Cool that provider in a **temporary** store, so the
real shared store is untouched. The cooldown signal lives in SQLite; the script
below opens it through the harness's own store module (Node strips the TypeScript
types, no build step) and writes a hinted 1 h window, exactly like a classified
`402` would:

```bash
export BELAYD_MODEL_STATE_FILE="$(mktemp -t bd257-state.XXXXXX.sqlite)"
# Keep the one-time legacy import inert: the store still replays
# ~/.pi/agent/model-cooldowns.json (its live windows, and no `.imported` marker
# yet) into whatever store it opens, so an untouched real file would decide
# these runs.
export BELAYD_MODEL_COOLDOWN_FILE="$(mktemp -d -t bd257-legacy.XXXXXX)/cooldowns.json"
node -e '
(async () => {
  const { openModelStateStore } = await import("./src/model-state-store.ts");
  const opened = openModelStateStore({ path: process.env.BELAYD_MODEL_STATE_FILE });
  if (!opened.ok) throw new Error(opened.error);
  const written = opened.store.markCooldown({
    provider: "llmgateway",
    durationMs: 3_600_000,
    reason: "Quota/credit/rate limit (HTTP 402).",
    cause: "quota",
    hinted: true,
  });
  if (!written.ok) throw new Error(written.error);
  console.log("blocks llmgateway until", new Date(written.value.untilMs).toISOString());
  opened.store.close();
})();
'
```

The store does not exist yet: the harness creates it (schema, WAL, 0600 modes) at
first use. `hinted: true` keeps the window exactly 1 h — an unhinted repeat
escalates, which is what the failure classifiers use and what makes hand-seeding
the store a bad idea outside a temp file.

Then start a session in this worktree. The routing decision happens at
`session_start`, before any prompt, so interactive is the cheap path — you can
quit without sending one:

```bash
./bin/pi
```

Expected, on stdout before the first prompt:

```text
[belayd-harness] session model routed from llmgateway/deepseek-v4.1-flash to opencode-go/deepseek-v4.1-flash because llmgateway (resets 2026-11-04T19:28:00.000Z) cannot serve a turn.
```

`resets <ISO>` is the store entry's `until` rendered with
`new Date(until).toISOString()` (UTC, milliseconds). Quit without prompting
(`/quit`, or Ctrl-D). The TUI may keep the line in scrollback rather than on the
raw terminal; a headless run prints it to stdout, at the cost of one model turn:

```bash
./bin/pi -p "Reply with the single word ok." -nt
```

The target is the first candidate the session *accepts*, not necessarily
`opencode-go`: if that provider has no credential, the line names
`commandcode/deepseek/deepseek-v4.1-flash` or `openrouter/…` instead.

### 4. The routed model is what the session actually uses

Two independent confirmations, both worth doing on the run from step 3:

```bash
# 1. the transcript records the change; the last model_change is the live model
f=$(ls -t ~/.pi/agent/sessions/--home-hugo-git-belayd-agent-harness.feat-bd-257--/*.jsonl | head -1)
grep -o '"type":"model_change"[^}]*}' "$f" | tail -3

# 2. the global default is unchanged
node -e 'const d=require(process.env.HOME+"/.pi/agent/settings.json");console.log(d.defaultProvider, d.defaultModel)'
```

Expected: the **last** `model_change` entry is
`{"type":"model_change",…,"provider":"opencode-go","modelId":"deepseek-v4.1-flash"}`
(every session writes an initial `model_change` for its starting model, so the
test is that the route added a later one), and `llmgateway deepseek-v4.1-flash`
from settings — the switch is per-session, never a default rewrite. In pi-web, the
session header's model selector shows the same model.

### 5. A healthy default logs nothing

```bash
export BELAYD_MODEL_STATE_FILE="$(mktemp -t bd257-clean.XXXXXX.sqlite)"
export BELAYD_MODEL_COOLDOWN_FILE="$(mktemp -d -t bd257-legacy.XXXXXX)/cooldowns.json"
node -e '
(async () => {
  const { openModelStateStore } = await import("./src/model-state-store.ts");
  const opened = openModelStateStore({ path: process.env.BELAYD_MODEL_STATE_FILE });
  if (!opened.ok) throw new Error(opened.error);
  opened.store.close();
})();
'
./bin/pi
```

Expected: **no** `[belayd-harness] session model routed` line, and the new
transcript's `model_change` entries all name `llmgateway/deepseek-v4.1-flash`
(compare with step 4, where a route adds a second one). This is the important half
of the contract — the pre-flight must not fight the operator's choice.

Keep the temp store: unsetting `BELAYD_MODEL_STATE_FILE` makes the session read
the real shared store, and a live row there for your default's provider
(inspect it with step 8) legitimately routes — that is not a false positive.

### 6. The kill switch logs nothing and switches nothing

```bash
export BELAYD_MODEL_STATE_FILE="$(mktemp -t bd257-state.XXXXXX.sqlite)"
export BELAYD_MODEL_COOLDOWN_FILE="$(mktemp -d -t bd257-legacy.XXXXXX)/cooldowns.json"
node -e '
(async () => {
  const { openModelStateStore } = await import("./src/model-state-store.ts");
  const opened = openModelStateStore({ path: process.env.BELAYD_MODEL_STATE_FILE });
  if (!opened.ok) throw new Error(opened.error);
  opened.store.markCooldown({
    provider: "llmgateway",
    durationMs: 3_600_000,
    reason: "Quota/credit/rate limit (HTTP 402).",
    cause: "quota",
    hinted: true,
  });
  opened.store.close();
})();
'
BELAYD_MODEL_FALLBACK=0 ./bin/pi
```

Expected: no routing line, no warning, and the transcript's only `model_change`
names `llmgateway/deepseek-v4.1-flash` — the session stays on the cooled default
because you asked for no routing. Both variables are read when the extension and
its store load, so they must be in the environment of the `pi` process, not
exported inside the session.

### 7. The all-candidates-cooled warning

```bash
export BELAYD_MODEL_STATE_FILE="$(mktemp -t bd257-state.XXXXXX.sqlite)"
export BELAYD_MODEL_COOLDOWN_FILE="$(mktemp -d -t bd257-legacy.XXXXXX)/cooldowns.json"
node -e '
(async () => {
  const { openModelStateStore } = await import("./src/model-state-store.ts");
  const opened = openModelStateStore({ path: process.env.BELAYD_MODEL_STATE_FILE });
  if (!opened.ok) throw new Error(opened.error);
  for (const provider of ["llmgateway", "opencode-go", "commandcode", "openrouter"]) {
    opened.store.markCooldown({
      provider,
      durationMs: 3_600_000,
      reason: "Quota/credit/rate limit (HTTP 402).",
      cause: "quota",
      hinted: true,
    });
  }
  opened.store.close();
})();
'
./bin/pi
```

Expected: no routing line; one warning, twice over (log + UI):

```text
[belayd-harness] No model candidate can serve this session's first turn (llmgateway (resets …), opencode-go (resets …), commandcode (resets …), openrouter (resets …)). Wait for that window to lapse or top up the provider, then retry; BELAYD_MODEL_FALLBACK=0 skips this check, but the first turn will fail on the same provider.
```

`opencode-go`/`openrouter` only appear if they have a candidate in the current
model's class — the message names the providers of the *blocked candidates*, not
every entry in the store.

### 8. Inspecting the store and interpreting `resets <ISO>`

The live store is SQLite. Read the active rows with `node:sqlite` (read-only, no
schema knowledge needed):

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const os = require("node:os"), path = require("node:path");
const file = process.env.BELAYD_MODEL_STATE_FILE
  ?? (process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")) + "/belayd/model-state.sqlite";
const db = new DatabaseSync(file, { readOnly: true });
for (const r of db.prepare("SELECT provider, model, until_ms, reason, cause, escalations FROM cooldown WHERE until_ms > ? ORDER BY provider, model").all(Date.now())) {
  const scope = r.model === "*" ? "provider" : "model   ";
  console.log(scope, r.provider, r.model === "*" ? "" : r.model, new Date(r.until_ms).toISOString(), r.cause ?? "-", r.escalations === null ? "" : "rung " + r.escalations, r.reason);
}
'
```

`until_ms` is epoch **milliseconds**; anything `<= Date.now()` is expired and does
not block, which is why a row can sit in the table while sessions route normally.
A provider-wide row has `model = '*'`; a model-scoped row carries the model id and
blocks only that exact candidate (the routing line then reads
`because llmgateway (no reset time) cannot serve a turn.` — the store knows the
model is out but has no provider-level reset to quote). `escalations` is the
ladder rung on an unhinted provider guess (`NULL` on a hinted or model row).

Path: `BELAYD_MODEL_STATE_FILE`, else the retired
`BELAYD_MODEL_COOLDOWN_FILE` with `.json` → `.sqlite` (so an operator who pinned
the old variable keeps one store), else
`$XDG_STATE_HOME/belayd/model-state.sqlite` (default
`~/.local/state/belayd/model-state.sqlite`).

`~/.pi/agent/model-cooldowns.json` is **not** live: it is imported into the store
once, on first use, and a `<file>.imported` marker next to it records that. Writing
it afterwards changes nothing (and a `.imported` marker is why a hand-edited file
often appears ignored). Verification steps 3–7 above seed the store, not the file;
if you want to exercise the import instead, point `BELAYD_MODEL_COOLDOWN_FILE` at a
JSON fixture, leave `BELAYD_MODEL_STATE_FILE` unset, and make sure no
`<fixture>.imported` marker exists yet.

### What these steps cannot tell you

- Steps 1–2 are deterministic and cover every decision branch. Steps 3–8 are the
  live ones; the phase that wrote this page did not execute them (they need a
  running pi and, for the `-p` variant, a model request).
- pi-web runs sessions **in-process** in `pi-web-sessiond`, and its sessions load
  whatever harness copy won the load order — normally the Nix-installed one, so
  bd-257 is only live there once this branch is merged, pushed, and the system
  rebuild happened. Until then use `./bin/pi`, or watch
  `journalctl -u pi-web-sessiond -f | grep 'belayd-harness'` after that rebuild;
  the routing line goes to the daemon journal because `console.log`/`console.warn`
  from an in-process session lands there.
- `/belayd` children pass through this hook too, on their own `session_start`,
  *and* through the launch path's pre-flight. Both build the same deterministic
  plan, so the outcome converges; if the launch path's `GET /sessions/:id/status`
  read races the child's own switch, the same candidate is applied twice and you
  may see **two** routing lines for one child. That is not a fault.

## How to Use

### Reading the one line that matters

You do not have to do anything: the session continues, on the routed model.

```text
[belayd-harness] session model routed from <old> to <new> because <provider> (resets <ISO>) cannot serve a turn.
```

| Field | Meaning |
|---|---|
| `from <old>` | the model the session started on — normally your `defaultProvider`/`defaultModel` |
| `to <new>` | the model now in the session transcript (`provider/modelId` as pi serves it) |
| `because <provider> (resets <ISO>)` | the provider that is out, and when it comes back (UTC). `no reset time` means a model-scoped cooldown with no provider window, or a capacity window without a reset |
| `cannot serve a turn` | this is an availability decision, not a quality one — nothing about the model changed |

A healthy default produces no line at all. Silence is the normal case.

Two other harness lines can appear around it:

```text
[belayd-harness] No model candidate can serve this session's first turn (…). …
[belayd-harness] session model pre-flight failed: <message>
```

The first is the all-candidates-cooled warning (see below). The second means the
routing code threw (a broken model registry, for instance) — the session is
unrouted and otherwise unaffected; the remaining `session_start` work still ran.

### Confirming which model a session ended up on

- pi-web: the session header's model selector.
- CLI: the status line, or `/model`.
- Any session, from disk: the last `model_change` entry in its transcript —

  ```bash
  f=$(ls -t ~/.pi/agent/sessions/--home-hugo-git-belayd-agent-harness.feat-bd-257--/*.jsonl | head -1)
  grep -o '"type":"model_change"[^}]*}' "$f" | tail -1
  ```

- Not from `~/.pi/agent/settings.json`: by design that file is never written by
  this hook. A session that restarts re-runs the pre-flight against its **last**
  model (the routed one), so a routing decision survives a restart without any
  settings change.

### When every candidate is cooling

The warning lists each blocked provider and its reset window, once in the log and
once in the UI. The session is **not** switched, and the first turn still runs on
the cooled default — in-session recovery will take over after that one failed
request (up to three switches per session, never repeating a model). Your options,
in the order that usually costs least:

1. **Wait out the window.** `resets <ISO>` is the time to wait. When the store and
   the capacity probe both describe one provider, the later reset is the one
   quoted, so a probe-reported window can exceed what the store row says.
2. **Top up the provider** (credit/plan). The next session start, or the existing
   session's next turn after recovery, will use it.
3. **Pin another default** for a while — `defaultProvider`/`defaultModel` in
   `~/.pi/agent/settings.json`, or per-run `./bin/pi --provider <p> --model <m>`.
   Sessions created after the edit start there and are re-evaluated against the
   stores like any other model.
4. **Accept a degraded run** by starting with `BELAYD_MODEL_FALLBACK=0`: the
   pre-flight is skipped, the session starts where you told it to, and the
   failure is yours to absorb.

Do not hand-edit the store (or `~/.pi/agent/model-cooldowns.json`) to force a
switch. The rows are written by the failure classifiers with escalation ladders; a
wrong `until_ms` either hides a real outage or sends the next phase at a dead
provider, and `cooldown_ladder` keeps the escalation rung across restarts.
Expired rows are harmless and are pruned.

### Turning the pre-flight off

```bash
BELAYD_MODEL_FALLBACK=0 ./bin/pi        # one run
```

or export it in the environment that starts `pi-web-sessiond`. The variable is the
single kill switch for model routing — the launch pre-flight, in-session recovery,
this session pre-flight, and the phase-spawn fallback loop all read it (the phase
loop then tries only its configured model). It is captured when the extension
module loads, so setting it from inside a session does nothing.

Re-enable by unsetting it and starting a new session; no state is left behind.

### Sub-agents and `/belayd` children

- **Phase sub-agents** (`-sub-` sessions) are excluded from this hook. Their model
  comes from the agent spec and the workflow's per-phase override, and their
  fallback/telemetry is `spawn-with-fallback`'s. A `-sub-` session never logs a
  routing line, even when the orchestrator that spawned it did route.
- **`/belayd` children** (`belayd-<taskId>`, no `-sub-`) do pass through this hook
  *and* the launch path's pre-flight. Both compute the same plan, so a child ends
  up on the same candidate either way. Two routing lines for one child is a known,
  harmless race — see the note in the verification section.
- **Fleet members** are `/belayd`-style children and behave like them.

### Where the decision lives

| Thing | Location |
|---|---|
| Blocked providers, reset windows | the shared `ModelStateStore` cooldown table (`$XDG_STATE_HOME/belayd/model-state.sqlite`, `BELAYD_MODEL_STATE_FILE` override); capacity windows from `CapacityCache` |
| The chosen model | the session transcript (`model_change`), never `settings.json` |
| The decision code | `extensions/capabilities/session-model-routing.ts` (hook), `extensions/capabilities/model-availability.ts` (shared predicate, refresh, switch loop), `src/orchestrator-model.ts` (`planModelRoute`, candidate order, `describeBlockedProviders`) |
| The reasoning | [`docs/model-capacity-and-telemetry.md`](model-capacity-and-telemetry.md), “Orchestrator sessions route their own model”; the one-truth store is bd-256 |
