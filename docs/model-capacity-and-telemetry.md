# Pre-dispatch capacity checks and model telemetry (bd-116)

Two coupled changes to how the harness spends model capacity:

1. **A pre-dispatch capacity signal.** Until bd-116 the fallback loop learned a
   provider was exhausted only reactively, *after* a 429. A cache
   (`src/capacity-cache.ts`) now carries a pre-dispatch signal so the first
   attempt of a workflow can avoid a provider a prior run already observed as
   exhausted, and a single 429 mid-workflow is fed straight back in.
2. **Per-`(phase, model)` telemetry.** Attempts, fallbacks, quota (429)
   failures, zero-tool-call no-ops, and cost are aggregated as the workflow
   runs, persisted to `.belayd/telemetry.json`, and rolled up per run onto the
   run manifest.

Motivation observed in the bd-116 investigation: roughly 32% of sub-agent
sessions were `-fallback-N` retries minted after a provider limit, and 46
zero-tool-call runs consumed budget while producing nothing. The telemetry is
what makes those two numbers measurable per phase and per model.

Two smaller changes ride along: the pre-dispatch check now short-circuits a
fully-exhausted candidate list instead of burning attempts, and the proof
verifier moved from the `standard` to the `fast` capability class.

This document covers user-visible behaviour only. Internals:
`src/capacity-cache.ts`, `src/model-telemetry.ts`, `src/model-session-state.ts`,
`src/spawn-with-fallback.ts`, `src/run-manifest.ts`, `src/quota-failure.ts`, and
the capability wiring in `extensions/capabilities/model.ts` (routing state) and
`extensions/capabilities/phase-run.ts` (per-run telemetry attach). Orchestrator
sessions route themselves through `src/orchestrator-model.ts`,
`extensions/capabilities/launch.ts` and
`extensions/capabilities/model-recovery.ts` (bd-229).

## How to Verify

Run these commands from the repository root. Run each command to completion.

1. Unit tests (all of them, including the new suites):

   ```bash
   pnpm test
   ```

   Expected: Vitest exits 0 with **122 test files / 2975 tests passed**. The
   bd-116 suites alone:

   ```bash
   pnpm vitest run src/__tests__/capacity-cache.test.ts \
     src/__tests__/model-telemetry.test.ts \
     src/__tests__/model-session-state.test.ts \
     src/__tests__/spawn-with-fallback.test.ts \
     src/__tests__/run-manifest.test.ts \
     src/__tests__/extension-model-telemetry.test.ts
   ```

   Expected: 6 files / 158 tests passed (37 capacity-cache, 21 model-telemetry,
   9 model-session-state, 63 spawn-with-fallback, 26 run-manifest, 2
   extension-model-telemetry).

   > Known flake unrelated to bd-116: `belayd-direnv-setup (unit) > sweeps a
   > matrix of direnv.toml shapes and validates each with real direnv` fails
   > intermittently (it shells out to the real `direnv` binary). Re-run the
   > suite before investigating.

2. The bd-38 suites (unhinted provider window, escalation ladder, cross-process
   refresh):

   ```bash
   pnpm vitest run src/__tests__/quota-failure.test.ts \
     src/__tests__/model-cooldown.test.ts \
     src/__tests__/capacity-cache.test.ts \
     src/__tests__/spawn-with-fallback.test.ts
   ```

   Expected: 4 files / 195 tests passed (72 quota-failure, 23 model-cooldown,
   37 capacity-cache, 63 spawn-with-fallback). Names to look for — the
   behaviours those names assert are listed in
   [Unhinted provider usage limits and cooldown escalation (bd-38)](#unhinted-provider-usage-limits-and-cooldown-escalation-bd-38):

   - `quota-failure.test.ts`: `uses the long provider window for an unhinted
     GoUsageLimitError body`, `parses the reset hint out of the live
     GoUsageLimitError body`, `lets a parsed hint win over the long provider
     window`, `returns the long provider window for unhinted provider
     usage-limit wording`, `does not read the long window out of a body with no
     quota wording at all`.
   - `model-cooldown.test.ts`: `doubles an unhinted provider window that is
     still cooling`, `clamps the escalated window at the hard ceiling`,
     `treats a hinted reset as authoritative and clears the ladder`,
     `leaves model-scoped marks un-escalated and out of the provider ladder`,
     `sees another adapter's mark over the same store without a refresh`,
     `imports still-active windows once and leaves the user's file untouched`,
     `does not import again on a later open, even if the legacy file changed`,
     `skips malformed legacy entries instead of discarding the file`.
   - `capacity-cache.test.ts`: `sees a cooldown written by another store instance
     sharing the same store`, `never throws and yields no windows for a missing
     or corrupt file`.
   - `spawn-with-fallback.test.ts`: `cools the provider for hours, so 15 minutes
     later it is still skipped`, `escalates the provider window on a repeated
     unhinted 429`, `does not apply the long provider window on a model-scoped
     failure`.

   Then run the real thing against a scratch state file: see
   [Manual recipe: the long provider window, its ladder, and cross-process
   visibility](#manual-recipe-the-long-provider-window-its-ladder-and-cross-process-visibility-bd-38).

3. Integration tests:

   ```bash
   pnpm test:integration
   ```

   Expected: 13 files / 98 tests passed.

4. Static checks and build:

   ```bash
   pnpm typecheck && pnpm lint && pnpm build
   ```

   Expected: each exits 0. `pnpm build` rewrites `dist/` (library consumers
   only; the extension transpiles `src/` directly).

### Named test cases that prove each acceptance criterion

(a) **Pre-dispatch ordering + fast-fail** — `src/__tests__/spawn-with-fallback.test.ts`:

- `orders candidates away from a capacity-exhausted provider before the first attempt`
  — with `opencode-go` recorded as exhausted, the single spawn is
  `llmgateway/mimo-v2.6-flash`, not the first candidate.
- `fast-fails without spawning when every candidate's provider is capacity-exhausted`
  — `spawnAgentProcess` is never called; one skip row per candidate carries
  `skippedCapacity: "opencode-go"`; the result text contains
  `capacity-exhausted`.
- `still spawns when the pre-dispatch capacity probe rejects` — a throwing
  probe must never block a spawn.
- `re-probes the capacity signal once the TTL expires between spawns`.
- `records an observed quota failure back into the capacity cache` — the
  mid-workflow 429 refresh, stamped with the cache's own clock.

Supporting pure-function coverage in `src/__tests__/capacity-cache.test.ts`:
`moves exhausted candidates behind healthy ones, preserving order`,
`groups every model on an exhausted provider behind healthy candidates`,
`caps the number of accepted windows`, `throttles onFailure so a broken
endpoint cannot warn per spawn`, and the six endpoint-probe failure cases
(non-200, malformed JSON, timeout, over-cap body, over-long `content-length`,
no readable body).

(b) **Per-phase/model recording and inspection** —
`src/__tests__/extension-model-telemetry.test.ts`:

- `merges a phase run's rows into an existing telemetry file and records a per-run delta`
  — a pre-existing `prior/workflow-model` row survives the append (restart
  safety), and the finished run's manifest carries `telemetry.attempts >= 1`.
- `settles twice in one workflow without duplicating earlier telemetry rows` —
  two settles of one attempt each persist as **2**, not 3 (the flush cursor).

Plus `src/__tests__/model-session-state.test.ts`
(`keeps an independent flush cursor per destination cwd`, `appends only the
delta since the same destination's last flush`, `does not drop the store or
cursor when the flush fails`) and `src/__tests__/run-manifest.test.ts`
(`setRunTelemetry attaches totals and preserves the rest of the manifest`,
`setRunTelemetry returns an error for an unknown run id`).

(c) **No-op separation** — `src/__tests__/model-telemetry.test.ts`:

- `counts a zero-tool-call success as a no-op but not a zero-tool-call failure`
  — the `noOps` counter only moves for `classification === "success"` with
  `toolCalls === 0`.

Plus `src/__tests__/spawn-with-fallback.test.ts` →
`records per-(phase, model) telemetry including zero-tool-call no-ops`, which
asserts the exact per-row shape (including `fallbacks: 1` on the second
attempt and `noOps: 1` for its zero-tool-call success).

(d) **`-fallback-N` ordinal advances only per spawned retry** —
`src/__tests__/spawn-with-fallback.test.ts`:

- `uses a fresh session id per attempt` — the positive control: candidate 1
  keeps `belayd-x`, candidate 2 becomes `belayd-x-fallback-1`.
- `does not burn a -fallback-N session for a skipped candidate` — candidate
  `a` is cooling down, so the only spawn is candidate `b`, which keeps the
  base session name `belayd-x` (no `-fallback-1`).
- `keys the telemetry fallback flag off the spawned-attempt ordinal, not the
  candidate index` — the same scenario records `attempts: 1, fallbacks: 0`.

**Verification limit (stated explicitly):** these tests are a *deterministic
proxy*. They assert the ordinal and the telemetry flag against a mocked
`spawnAgentProcess`, which is the only way to prove the rule without real
provider traffic. A true end-to-end demonstration — one provider genuinely
returning a 429 mid-workflow and the next candidate taking over with a
`-fallback-1` session — needs live quota exhaustion on a real provider and is
not reproducible in CI.

Class-liveness check: `src/__tests__/agent-registry.test.ts` →
`PROOF_VERIFIER_AGENT > declares the fast class and read-only tools`.

### Manual recipe: observe reorder and fast-fail with a stub endpoint

The probe reads `BELAYD_CAPACITY_PROBE_URL` **once, at extension load time**,
so the variable must be set before `pi` starts.

1. Start a throwaway capacity endpoint that always reports a fixed body:

   ```bash
   cat > /tmp/capacity-fixture.mjs <<'EOF'
   import { createServer } from "node:http";
   const body =
     process.env.CAPACITY_BODY ??
     '{"providers":{"llmgateway":{"resetsInSeconds":3600}}}';
   createServer((_req, res) => {
     res.writeHead(200, { "content-type": "application/json" });
     res.end(body);
   }).listen(8788, "127.0.0.1", () => console.log("fixture on http://127.0.0.1:8788"));
   EOF
   node /tmp/capacity-fixture.mjs &
   ```

2. Prove the probe path is live: point `pi` at it and run any phase. In a repo
   checkout with the extension installed (`pi install -l`):

   ```bash
   BELAYD_CAPACITY_PROBE_URL=http://127.0.0.1:8788/usage pi
   ```

   Then start a workflow (`bd-X` is a real Beads task id):

   ```text
   /belayd bd-X feature --no-worktree
   ```

3. **Reorder.** With the default fixture body the fast-class scout primary
   (`llmgateway/mimo-v2.6-flash`) is reordered so `opencode-go/mimo-v2.6-flash`
   runs first. The reorder is deliberately silent — its point is to *not*
   spawn a doomed attempt — so the observable signal is an **absence**:

   - no `[belayd model fallback] ... (quota) ...` note on the phase result, and
   - no `-fallback-N` subagent session:

     ```bash
     pi --resume | grep 'belayd-bd-X'
     ```

     Expected: only base-named sessions such as
     `belayd-bd-X-sub-scout-<runId>` — no `...-fallback-1`.

4. **All-exhausted fast-fail.** Restart the fixture with every provider the
   candidate list uses (`llmgateway`, `opencode-go`, `openrouter`) inside a
   reset window, and re-run the phase:

   ```bash
   kill %1 2>/dev/null
   CAPACITY_BODY='{"providers":{"llmgateway":{"resetsInSeconds":3600},"opencode-go":{"resetsInSeconds":3600},"openrouter":{"resetsInSeconds":3600}}}' \
     node /tmp/capacity-fixture.mjs &
   ```

   Expected: the phase fails immediately with no sub-agent spawn at all, and
   the result text ends with the capacity reason plus the per-candidate skip
   trail:

   ```text
   All candidate models are capacity-exhausted providers (llmgateway, opencode-go, openrouter); retry after reset. Candidates: llmgateway/mimo-v2.6-flash, opencode-go/mimo-v2.6-flash, openrouter/xiaomi/mimo-v2.6-flash, ...

   [belayd model fallback] llmgateway/mimo-v2.6-flash (provider llmgateway capacity-exhausted) → opencode-go/mimo-v2.6-flash (provider opencode-go capacity-exhausted) → openrouter/xiaomi/mimo-v2.6-flash (provider openrouter capacity-exhausted) → ...
   ```

   The provider tuple is derived from the fixture body's key order (the capacity
   windows the probe reported), not from the candidate list, which is why body
   and trail are written in the same order here.

   If a quality gate is configured for the phase it will retry the phase; each
   retry hits the same fast-fail instead of minting `-fallback-N` sessions.

5. **Misconfiguration warning.** Point the variable at a dead port and confirm
   the fallback to the shared cooldown rows, throttled to about one warning
   per 5 minutes:

   ```bash
   BELAYD_CAPACITY_PROBE_URL=http://127.0.0.1:1/usage pi
   ```

   Expected warning (once per throttle window, not per spawn):

   ```text
   [belayd-harness] BELAYD_CAPACITY_PROBE_URL produced no capacity signal (request failed (...)); falling back to the cooldown store.
   ```

### Manual recipe: the long provider window, its ladder, and cross-process visibility (bd-38)

This drives the real classifier and the real cooldown store — not a stub — over a
scratch state file, so every window is the one the harness actually recorded. It
is the fastest way to see the three bd-38 behaviours by hand; the spawn-level
skip is covered by `spawn-with-fallback.test.ts` (see above), because
reproducing a live opencode-go exhaustion is not something a recipe can
schedule.

1. Build the library output the script imports (the extension itself runs from
   `src/`, but a throwaway `node` script needs `dist/`):

   ```bash
   pnpm build
   ```

2. Write the scratch script at the repository root (delete it afterwards; it is
   not tracked and would otherwise reach `pnpm lint`):

   ```bash
   cat > bd38-check.mjs <<'EOF'
   // Scratch verification script for bd-38 — run from the repo root after `pnpm build`.
   import { setTimeout as sleep } from "node:timers/promises";
   import { classifySpawnFailure } from "./dist/src/quota-failure.js";
   import { createModelCooldownStore } from "./dist/src/model-cooldown.js";
   import { openModelStateStore, resolveModelStatePath } from "./dist/src/model-state-store.js";
   import { probeFromCooldownStore } from "./dist/src/capacity-cache.js";

   const UNHINTED = '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}';
   const HINTED =
     '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 20min."}';

   const detailsOf = (errorMessage) => ({
     messages: [
       {
         role: "assistant",
         content: [],
         model: "opencode-go/mimo-v2.6-flash",
         stopReason: "error",
         errorMessage,
       },
     ],
     usage: {},
     exitCode: 0,
   });

   // Mirrors recordFailureCooldown() in src/spawn-with-fallback.ts.
   const applyFailure = async (store, body) => {
     const classification = classifySpawnFailure(detailsOf(body));
     await sleep(5); // keep mark timestamps distinct, as they are in a real workflow
     if (classification.kind === "quota") {
       store.markProviderCooldown(
         "opencode-go",
         classification.cooldownSeconds,
         classification.reason,
         { hinted: classification.cooldownHinted === true },
       );
     }
     return classification;
   };

   const hoursOut = (entry) => ((entry.until - Date.now()) / 3_600_000).toFixed(2);
   const show = (label, store) => {
     const entry = store.providerEntries().get("opencode-go");
     console.log(`${label}: until ~${hoursOut(entry)}h out, escalations=${entry.escalations ?? 0}`);
   };

   // The one path the harness uses. The run below points BELAYD_MODEL_STATE_FILE
   // at /tmp, so this is a scratch store. Each "member" gets its own connection,
   // which is exactly what a second process has.
   const statePath = resolveModelStatePath({ env: process.env });
   const openMember = () => {
     const opened = openModelStateStore({ path: statePath });
     if (!opened.ok) throw new Error(opened.error);
     // No `filePath`: this scratch run imports no retired JSON file and writes no
     // marker under ~/.pi/agent. The migration itself is covered by tests.
     return createModelCooldownStore({ store: opened.store });
   };
   const store = openMember();
   const otherMember = openMember();
   console.log("scratch state store:", statePath);

   for (const attempt of [1, 2, 3, 4]) {
     const { cooldownSeconds } = await applyFailure(store, UNHINTED);
     show(`unhinted #${attempt} (${cooldownSeconds}s requested)`, store);
   }

   console.log("hinted failure (20 min, authoritative):");
   const hinted = await applyFailure(store, HINTED);
   console.log(`cooldownHinted=${hinted.cooldownHinted}`);
   show("hinted", store);

   console.log(
     "\nsecond process (one truth, no snapshot):",
     otherMember.providerEntries().size,
     "provider row(s)",
   );
   const { windows } = await probeFromCooldownStore(otherMember)();
   console.log("probe windows:", windows);
   EOF
   ```

3. Run it against a scratch state file, so the default store reported by
   `resolveModelStatePath()` (`~/.local/state/belayd/model-state.sqlite` unless
   overridden) and everything under `~/.pi/agent` are untouched
   (`BELAYD_MODEL_STATE_FILE` overrides the path; a set
   `BELAYD_MODEL_COOLDOWN_FILE` relocates it beside that file instead):

   ```bash
   rm -f /tmp/bd38-model-state.sqlite*
   BELAYD_MODEL_STATE_FILE=/tmp/bd38-model-state.sqlite node bd38-check.mjs
   ```

   Expected output — 6 h, then doubling, then clamped at 24 h:

   ```text
   scratch state store: /tmp/bd38-model-state.sqlite
   unhinted #1 (21600s requested): until ~6.00h out, escalations=1
   unhinted #2 (21600s requested): until ~12.00h out, escalations=2
   unhinted #3 (21600s requested): until ~24.00h out, escalations=3
   unhinted #4 (21600s requested): until ~24.00h out, escalations=4
   ```

   Then the hinted mark, which overrides the escalated window and clears the
   ladder (the `cooldown_ladder` row is deleted, which is how "cleared at this
   time" is recorded — so the row carries no `escalations` field):

   ```text
   hinted failure (20 min, authoritative):
   cooldownHinted=true
   hinted: until ~0.33h out, escalations=0
   ```

   And the fleet case — since bd-256 there is no per-process snapshot to
   refresh: a second store over the same file sees the row immediately.

   ```text
   second process (one truth, no snapshot): 1 provider row(s)
   probe windows: [ { provider: 'opencode-go', resetAt: ..., reason: 'Weekly usage limit reached. Resets in 20min.' } ]
   ```

4. **Where the row lives.** The window is a row in the shared
   `cooldown(provider, model, until_ms, reason, retry_after_ms, cause,
   escalations, last_mark_ms)` table — provider-wide rows use `model = '*'`,
   endpoint rows a bare model id, and a provider-agnostic bare model row uses
   `provider = '*'`. `escalations` is the ladder rung an unhinted provider-wide
   mark used (NULL on hinted and model rows), and `last_mark_ms` is when the row
   was marked. The ladder itself is a separate `cooldown_ladder(provider,
   escalations, last_mark_ms)` row, remembered for
   `COOLDOWN_ESCALATION_MEMORY_MS` (7 days) after the last mark and pruned
   afterwards. Expired rows are invisible to every reader and deleted by
   `prune()`.

5. **The retired JSON file (import source only).** Earlier builds persisted the
   same windows here instead:

   ```jsonc
   {
     "version": 1,
     "providers": {
       "opencode-go": {
         "until": 1793192324182,      // epoch ms; the window end
         "reason": "Quota/credit/rate limit (HTTP 429).",  // display only, never branch on it
         "escalations": 4,           // optional: absent on hinted and model-scoped windows
         "lastMarkedAt": 1793105924182 // optional: when this window was marked
       }
     },
     "models": {},                    // endpoint-scoped windows (transient/unavailable)
     "escalations": {                 // the ladder, kept across window expiry
       "opencode-go": { "count": 4, "lastMarkedAt": 1793105924182 }
     }
   }
   ```

   This build **never writes it**. When the adapter is constructed with a
   `filePath` (the extension passes `defaultModelCooldownPath()`), the first use
   imports the file's still-active `providers`/`models` windows and its
   `escalations` ladder: the longer window wins on conflict, the rung is
   replayed (so an escalated weekly bucket continues from where it was instead of
   restarting at rung 1), and the migration is recorded in
   `model-cooldowns.json.imported`. The user's file is left untouched. A file
   written by an older build with no `version`, `escalations`, or
   `lastMarkedAt` imports unchanged; a malformed entry is skipped and its
   healthy siblings import; a corrupt file imports nothing instead of throwing.

6. **Read the live rows on a real machine.** The same numbers without the
   script, through the library:

   ```bash
   node -e '(async () => {
   const c = await import("./dist/src/model-cooldown.js");
   const s = await import("./dist/src/model-state-store.js");
   const path = s.resolveModelStatePath({ env: process.env });
   const opened = s.openModelStateStore({ path });
   if (!opened.ok) throw new Error(opened.error);
   const store = c.createModelCooldownStore({ store: opened.store });   // no filePath: no import
   console.log("state store:", path);
   for (const [p, e] of store.providerEntries())
     console.log(p, ((e.until - Date.now()) / 3600_000).toFixed(1) + "h", e.escalations ?? 0, e.reason);
   })()'
   ```

   `resolveModelStatePath()` is authoritative: it honours
   `BELAYD_MODEL_STATE_FILE` first, then the retired
   `BELAYD_MODEL_COOLDOWN_FILE` (`x.json` → `x.sqlite`), then
   `${XDG_STATE_HOME:-~/.local/state}/belayd/model-state.sqlite`. Derive the same
   path in the shell for the `sqlite3` variant — do not hard-code the default, or
   an env override makes the two read-backs disagree. `state_path()` below
   mirrors `resolveModelStatePath()` and `modelStatePathForCooldownFile()`
   exactly: the `.json` strip is case-insensitive, like `/\.json$/i`, and an
   unset `HOME` falls back to the passwd home directory rather than `/`:

   ```bash
   state_path() {
     if [ -n "${BELAYD_MODEL_STATE_FILE:-}" ]; then
       printf '%s' "$BELAYD_MODEL_STATE_FILE"
     elif [ -n "${BELAYD_MODEL_COOLDOWN_FILE:-}" ]; then
       # `s///I`: the TypeScript rule strips /\.json$/i, not only lowercase.
       printf '%s.sqlite' "$(printf '%s' "$BELAYD_MODEL_COOLDOWN_FILE" | sed 's/\.json$//I')"
     else
       home=${HOME:-$(cd ~ && pwd)}
       printf '%s/belayd/model-state.sqlite' "${XDG_STATE_HOME:-$home/.local/state}"
     fi
   }
   sqlite3 -header -column "$(state_path)" \
     "SELECT provider, model, datetime(until_ms/1000,'unixepoch') AS until, escalations, reason
        FROM cooldown ORDER BY provider, model;"
   ```

   Expected after one unhinted `GoUsageLimitError`: an `opencode-go` row about
   `6h` out with `escalations = 1` — not a 15-minute window. Two failures an
   hour apart: about `12h` and `escalations = 2`.

7. Clean up:

   ```bash
   rm -f bd38-check.mjs /tmp/bd38-model-state.sqlite*
   ```

### What you should see in the logs (the fleet symptom bd-38 fixes)

The observable difference is in the phase result's fallback trail
(`[belayd model fallback] ...`, emitted only when a spawn made more than one
attempt entry) and in the sub-agent session names.

**Before** — every re-probe paid for a session, because the 15-minute window
always expired before the weekly bucket reset:

```text
[belayd model fallback] opencode-go/mimo-v2.6-flash (quota) → llmgateway/mimo-v2.6-flash (success)
```

repeated on each phase, roughly every 15 minutes, each repeat minting a
`belayd-<task>-sub-<phase>-<runId>-fallback-1` session and a fresh
`429: {"type":"GoUsageLimitError", ...}` line in the transcript.

**After** — one 429, a multi-hour provider window, and then skips that spawn
nothing:

```text
[belayd model fallback] opencode-go/mimo-v2.6-flash (provider opencode-go exhausted) → llmgateway/mimo-v2.6-flash (success)
```

What to check:

- Later phases of the same workflow show `(provider opencode-go exhausted)` (a
  cooldown-store skip) or `(provider opencode-go capacity-exhausted)` (the
  pre-dispatch cache) for the first candidate, and **no** `-fallback-N` session
  is created — verify with `pi --resume | grep 'belayd-<task-id>'`; only
  base-named sessions should appear.
- No second `429 ... Go usage limit exceeded` line for the same provider inside
  the window. A second one means either the window expired (escalation now
  doubles it) or a body carried a shorter "Resets in ..." hint, which is
  authoritative by design.
- `.belayd/telemetry.json` shows `quotaFailures` no longer growing per phase
  while `fallbacks` stays flat: the failed attempt happened once, later attempts
  were skips and never entered the counts.

## How to Use

### 1. `BELAYD_CAPACITY_PROBE_URL`

Env var (exported as `CAPACITY_PROBE_URL_ENV`). Set it to an HTTP(S) URL that
reports provider usage/reset windows; an empty value behaves like unset. The
variable is read once at extension load time, so export it before starting
`pi`. The harness issues one `GET` with `accept: application/json`:

- **Timeout:** 2 seconds (`DEFAULT_CAPACITY_PROBE_TIMEOUT_MS`), enforced with
  both a race and `AbortSignal.timeout`, so a hung endpoint cannot stall every
  spawn in the fallback loop.
- **Body cap:** 256 KB (`DEFAULT_CAPACITY_BODY_LIMIT_BYTES`). An over-long
  `content-length` is rejected before the body is read; a body that streams past
  the cap is cancelled mid-read; a response with no readable body stream is
  refused rather than buffered unbounded.
- **Window cap:** 50 windows (`MAX_CAPACITY_WINDOWS`); extras are dropped.
- **Cache TTL:** 5 minutes (`DEFAULT_CAPACITY_TTL_MS`) — a 6+ phase workflow
  re-probes at most once per TTL, not once per phase.

Accepted response shapes (all three are parsed by `parseCapacityWindows`):

```jsonc
// 1. direct window list
{ "windows": [ { "provider": "opencode-go", "resetAt": 1750000000000, "reason": "weekly limit" } ] }

// 2. nested provider map, relative window
{ "providers": { "opencode-go": { "resetsInSeconds": 3600, "reason": "limit" } } }

// 3. top-level provider map keyed by provider, reset-hint string
{ "opencode-go": { "message": "Weekly usage limit reached. Resets in 7hr 57min." } }
```

Per-entry fields:

| Field | Meaning |
| --- | --- |
| `resetAt` / `until` / `resetsAt` | absolute reset time in **epoch milliseconds** |
| `resetsInSeconds` / `resetInSeconds` | relative window in seconds |
| `resetsIn` / `message` | reset-hint string, parsed by `parseQuotaResetSeconds` (e.g. `"Resets in 7hr 57min."`) |
| `reason` | free text stored with the window; defaults to `"endpoint capacity"` |

An entry with no resolvable reset time is ignored; in the list shape an entry
without a `provider` is also ignored. A bare model id with no `provider/`
prefix never matches a window (exhaustion is provider-scoped).

**When the variable is unset** the probe reads the shared cooldown rows
(`probeFromCooldownStore`), so capacity still reflects provider limits learned
from earlier 429s and survives orchestrator restarts. Since bd-256 those rows
are in the one SQLite store the provider wrapper writes, not a per-process JSON
file: the probe calls `ModelCooldownStore.refreshIfStale` with the same 1 s
`COOLDOWN_REFRESH_MAX_AGE_MS` window candidate selection uses, which drops the
store's bounded read cache so a row another fleet member just wrote is seen
without an orchestrator restart. There is no merge any more — the row *is* the
truth, ordered by the store's own upsert and escalation rules (a hinted reset
replaces the window and clears the ladder; an unhinted repeat doubles it).
Expired rows are invisible to the probe and deleted by `prune()`, and the probe
never throws on a missing, unreadable, or degraded store.
**When it is set but the
endpoint yields nothing** (non-200, malformed JSON, timeout, oversized body,
zero windows, request failure) the probe falls back to those same cooldown
windows and emits a warning, throttled to one per 5 minutes:

```text
[belayd-harness] BELAYD_CAPACITY_PROBE_URL produced no capacity signal (<reason>); falling back to the cooldown store.
```

Reason strings are `request failed (...)`, `HTTP <status>`, `response body
exceeded <N> bytes`, `malformed JSON body`, and `endpoint returned no capacity
windows`. A misconfigured endpoint therefore *degrades* the capacity signal
instead of silently disabling it. A failing probe is never fatal: the failed
attempt is dropped from the TTL bookkeeping so the next spawn re-probes.

`BELAYD_MODEL_FALLBACK=0` still disables candidate fallback entirely; it is
independent of the capacity probe.

### 2. What you observe at dispatch time

Before the first attempt of every `spawnAgentWithFallback` call two things
happen, in this order:

1. **The shared cooldown rows are re-read** —
   `ModelCooldownStore.refreshIfStale(COOLDOWN_REFRESH_MAX_AGE_MS)` followed by
   `prune()`. Since bd-256 this is the *same* SQLite store the provider wrapper
   writes (`ModelCooldownStore` is a thin adapter over `ModelStateStore`), so
   "re-read" means dropping the store's 1 s read cache, not parsing a second
   file. It is deliberately *not* gated by the capacity TTL and happens
   even when the capacity probe is an endpoint probe: without it the picker
   dispatches onto a provider another fleet member (or the wrapped dispatch in
   this same process) already spent, and only recovers after paying a failed
   spawn in the fallback loop (bd-234). `refreshIfStale` never throws and is a
   no-op without a store, so a degraded store leaves candidate selection
   permissive. A missing refresh stamp and a *regressed* clock both count as
   stale (a negative elapsed time cannot prove freshness), so a backwards clock
   change re-reads instead of suppressing reads until wall time catches up.
   Callers that need certainty (orchestrator launch preflight, in-session
   recovery) still use the unbounded `refresh()`, which clears the cache
   outright.

2. **The cached capacity signal is refreshed** (TTL permitting), and then it:

- **Reorders candidates:** candidates whose provider has an unexpired window
  move behind the healthy ones, each group keeping its original relative order
  (`orderCandidatesByCapacity`). Exhausted candidates are *not* dropped, so a
  reset that lands mid-loop is still usable.
- **Fast-fails when everything is exhausted:** if every candidate's provider is
  in a window, no process is spawned at all. The returned result text is:

  ```text
  All candidate models are capacity-exhausted providers (<providers>); retry after reset. Candidates: <models>.
  ```

  and one skip row per candidate is recorded — the phase result's fallback
  trail shows `(provider <provider> capacity-exhausted)` for each, instead of a
  chain of real 429s. No `-fallback-N` session is minted.
- **Refreshes from observed failures:** a real quota/429 failure observed
  mid-workflow is written back into the cache as a provider window
  (`recordCapacityFromFailure`, using `classification.cooldownSeconds` — parsed
  from the 429 body when present, else the 6-hour provider usage-limit window for
  provider subscription wording, else the 15-minute class default),
  so the rest of the workflow benefits immediately instead of waiting out the
  TTL. Only provider-scoped quota failures are recorded — a transient failure is
  endpoint-specific and must not reorder that provider's other models.

Reactive cooldown skips (`(cooldown)`, `(provider X exhausted)`) are unchanged
and keep their original slot in the attempt trail; the capacity cache is what
pre-empts the *first* attempt, and the store re-read above makes those skips
correct on the first attempt instead of reactive discovery.

- **Cooldown/capacity skips do not consume `maxAttempts`.** The cap bounds
  *spawned* attempts: `maxAttempts: 1` with a cooling first candidate still
  spawns the first healthy candidate further down the list, and
  `maxAttempts: 0` returns the empty exhausted result without spawning.
- **The kill switch still honours cooldowns.** `BELAYD_MODEL_FALLBACK=0` means
  "no fallback", not "ignore the store": the single configured model is
  refused when it is skipped before dispatch, with one skip row (so the trail
  and the manifest show why nothing ran). The refusal copy is cause-aware, reusing
  the skip row's own phrase: a genuine cooldown keeps the all-cooling sentence,
  while a provider with no API key (or an endpoint outside a capacity window)
  reads `Refusing to dispatch <model>: <reason>` so a missing credential is not
  misreported as a spent quota:

  ```text
  All candidate models are in cooldown (<model>); retry later.
  Refusing to dispatch <model>: Provider <provider> has no API key configured; …
  ```
- **An abort is reported as an abort.** When the signal is already aborted and
  no candidate was dispatched, the result text is
  `Run aborted before any candidate could be dispatched.` rather than the
  all-cooling wording; the cooldown sentence is reserved for a run that really
  found every candidate cooling. The same holds for the `maxAttempts: 0` /
  empty-candidate early exit, and an empty candidate list never prints an empty
  parenthesis list (`All candidate models are in cooldown; retry later.`).
- **The run manifest records the outcome, not just the intent.** `model` names
  the model that actually served the run (the spawn layer's `details.model`
  when present, else the last spawned attempt), `requestedModel` keeps the
  pre-dispatch pick, and `skippedModels` lists every candidate skipped before
  dispatch with its reason (`cooling down …`, `capacity reset window`, `no API
  key configured`); the key is **absent** — not an empty array — when nothing
  was skipped. `model` is **absent** when nothing ran — an all-skipped,
  capacity-exhausted, or aborted run has no serving model, and the running
  manifest writes only `requestedModel` before the spawn.
  `setRunModelSelection` does the read-modify-write, so `belayd_status`/fleet
  latest-run views name the provider that ran instead of the one that was
  requested.
- **Gate retries fold into the same manifest.** A quality-gate fix-up goes
  through the same spawn loop (`onSelection` from `RunQualityGateOptions`), and
  `mergeRunModelSelections` folds it into the run's recorded selection: the last
  spawned model wins, skipped rows accumulate (de-duplicated), and a retry that
  spawned nothing keeps the earlier serving model. The retry's text also carries
  the `[belayd model fallback]` trail.

### 3. Phase-class routing change

`PROOF_VERIFIER_AGENT` (`src/agent-registry.ts`) moved from `standard` to
`fast`. Rationale: the verifier's verdict is advisory and non-blocking, so a
frontier/standard model spends capability on a judge whose failure cannot fail
the workflow. Its fallback candidates are now the `fast` class
(`mimo-v2.6-flash`, `deepseek-v4-flash`, `glm-5.3-flash`), primary
`llmgateway/mimo-v2.6-flash` (bd-147 moved the non-DeepSeek primaries onto the
per-token gateway; see `docs/agent-model-class.md`).

Unchanged: scout was already `fast`, and the tester remains `frontier`
(bd-102) because generated tests are a correctness artifact. Everything else
keeps its declared class — see `docs/agent-model-class.md` for the full
agent → class table and `frontier`/`standard`/`fast` primary models.

### 4. Retirement-aware failure classification (bd-142)

A gateway retiring a model id is a failure mode that neither quota nor transient
covers, and it used to abort a phase: llmgateway answered

```text
410: {"message":"Model mimo-v2.5 has been deactivated and is no longer available","type":"invalid_request_error","param":null,"code":null}
```

for `mimo-v2.5`, `classifySpawnFailure` fell through to `other`, and
`spawnAgentWithFallback` stopped instead of trying the next candidate — while a
healthy candidate was one hop away and opencode-go was quota-exhausted. pi exits
0 on that path, so exit-code handling could not catch it either.

What changed:

- **New `FailureKind`: `unavailable`.** Produced by HTTP 404/410, and by wording
  that means "this model id is not servable here" on any status —
  `deactivated`, `no longer available`, `Requested model X not supported`,
  `X is not a valid model ID`, `model not found`, `has been retired` (all three
  phrasings observed live from llmgateway/openrouter). It is fallback-worthy and
  cooled down for `DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS` (6 h),
  **endpoint-scoped**: `llmgateway/mimo-v2.5` cools, `llmgateway/glm-5.3` does
  not. The entry expires so a provider rollback recovers on its own, without
  editing the shared store.
- **One exhaustive `isFallbackWorthy(kind)` switch** replaces the old negative
  `kind !== "quota" && kind !== "transient"` stop predicate, so adding a failure
  kind cannot silently turn into "stop the phase".
- **Status extraction is defensive:** `errorStatus` (number or numeric string),
  an `NNN:` prefix, a short human preamble (`Model response failed: 410: ...`),
  a JSON `code`/`status` field, then any `4xx`/`5xx` code in the body.
- **Statusless wording** is classified too: quota wording ("usage limit",
  "quota", "rate limit", "insufficient credits") without a code now yields
  `quota` instead of `other`.
- **stderr is classified when no assistant error event exists** (non-zero exit):
  network signatures → `transient`, retired-model wording → `unavailable`,
  quota wording → `quota`, everything else stays `other`.

`mimo-v2.5` itself is replaced in the `fast` class by `mimo-v2.6-flash` (the
direct successor: same price and lineage, verified 200 on llmgateway and
openrouter and still listed by opencode-go). `deepseek-v4-flash` stays as the
second rung — llmgateway and openrouter still serve it — and `glm-5.3-flash`
remains the class ceiling.

Named tests: `src/__tests__/quota-failure.test.ts` →
`classifies the live 410 deactivated-model error as unavailable`,
`classifies a 400 rejection of the model id as unavailable, not transient`,
`reads a status from a prefixed message, a JSON code field, and a string errorStatus`,
`classifies a non-zero exit on an unknown model as unavailable`; and
`src/__tests__/spawn-with-fallback.test.ts` →
`falls back on a deactivated model (410) and cools only that endpoint`.

### Unhinted provider usage limits and cooldown escalation (bd-38)

A provider *subscription* limit is not a rate limit, and the difference was
costing real sessions. opencode-go returned

```text
429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}
```

with **no reset hint** (the same error sometimes carries
`Weekly usage limit reached. Resets in 7hr 57min.`, sometimes not). The
classifier fell back to the 15-minute default,
the provider's cooldown entry got `until = now + 15min`, and a **weekly**
bucket was re-probed every 15 minutes forever. Three fleet members each spent a
`-fallback-1` session rediscovering the same exhausted provider.

What changed:

- **Longer window for unhinted provider usage limits.** New
  `DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS` (6 h) applies when a quota
  failure matches provider subscription wording (`GoUsageLimitError`,
  `usage limit exceeded`/`reached`/`hit`, `weekly|monthly|daily usage limit`)
  **and** no reset hint parsed. A parsed hint always wins
  (`resolveQuotaCooldown` is the one resolver — hint → long window → 15-minute
  default — for all three quota paths: status, wording, and stderr, and it
  reports `cooldownHinted` so no caller has to re-parse the body). `transient`,
  `unavailable`, and `auth` classifications are untouched.
- **Escalation on repeated unhinted 429s.** A provider mark that carries no
  reset hint escalates the previous one: each repeat doubles the window from the
  requested duration (`COOLDOWN_ESCALATION_FACTOR`, ceiling
  `MAX_ESCALATED_COOLDOWN_SECONDS` = 24 h), so 6 h → 12 h → 24 h instead of a
  fresh 6 h every time. The ladder (`escalations` per provider) lives in its own
  map, survives the window's expiry and an orchestrator restart
  (`COOLDOWN_ESCALATION_MEMORY_MS` = 7 days), and is persisted as an optional
  field — an older version-1 file without it loads unchanged. A hinted mark is
  authoritative: it sets exactly the parsed window (even when that is *shorter*
  than an earlier escalated guess) and clears the ladder, because ladder merge
  order follows the mark event time. The mark API takes an options object:
  `markProviderCooldown(provider, seconds, reason, { hinted, nowMs })`;
  model-scoped marks never escalate.
- **Cross-process cooldown visibility.** `probeFromCooldownStore` calls
  `ModelCooldownStore.refreshIfStale(COOLDOWN_REFRESH_MAX_AGE_MS)` before reading
  `providerEntries()`, and candidate selection does the same, so a cooldown
  another fleet member persisted is visible on the next spawn (and capacity
  probe) instead of after an orchestrator restart. Since bd-256 there is no
  second file and no per-process merge: the row *is* the truth, so a hinted mark
  replaces it exactly and clears the ladder, an unhinted repeat escalates it, and
  `refresh()` merely drops the store's bounded read cache. A missing, corrupt, or
  unreadable legacy file imports nothing; a missing store makes every reader
  permissive (nothing cooling) rather than throwing. A disk error never fails a
  spawn.

Named tests: `src/__tests__/quota-failure.test.ts` →
`parses the reset hint out of the live GoUsageLimitError body`,
`uses the long provider window for an unhinted GoUsageLimitError body`,
`lets a parsed hint win over the long provider window`; `src/__tests__/model-cooldown.test.ts`
→ `doubles an unhinted provider window that is still cooling`,
`clamps the escalated window at the hard ceiling`,
`treats a hinted reset as authoritative and clears the ladder`,
`replays an escalated legacy ladder so the next unhinted mark continues it`,
`ignores a legacy ladder older than the escalation memory`,
`lets a longer legacy window replace a shorter escalated window without clearing its rung`;
`src/__tests__/capacity-cache.test.ts` →
`sees a cooldown written by another store instance sharing the same store`; and
`src/__tests__/spawn-with-fallback.test.ts` →
`cools the provider for hours, so 15 minutes later it is still skipped`.

### Provider without a key: `unconfigured` (bd-178)

A provider whose credential is absent fails every one of its models the same
way. In production the failure happens before the extension's stream exists: on
pi 1.0.2 the child process exits 1 with `No API key found for <provider>.` on
stderr and zero assistant turns, so `classifySpawnFailure` takes its **process**
path. In-process, the pinned Command Code extension reports the same condition as
a statusless assistant error ("No Command Code API key. Run /login …"). Both
used to fall through to `other`, which stops the fallback and fails the phase —
even though the standard class primary (`commandcode/z-ai/glm-5.3-flash`) is on
that provider and the key is deliberately per-host
(`docs/pi-web-service.md`).

What changed:

- **New `FailureKind`: `unconfigured`.** Matched only on text with **no** status
  code — the assistant-path error body *and* the process-path stderr (pi's
  startup refusal) — so a 401/403 "invalid api key" stays `auth` and a 429 stays
  `quota`.
- **Provider-scoped, but not quota.** `recordCooldown`'s provider scope is now
  selected by `quota` OR `unconfigured` (`isProviderScopedFailure`): a missing
  key disables every model on the provider, so cooling one endpoint would burn a
  wasted spawn per sibling. It stays out of `quota` so `recordCapacityFromFailure`
  and the telemetry `quotaFailures` counter never see it.
- **Excluded from the capacity probe.** `recordCooldown` also stores a stable
  `cause` tag on the provider entry (`quota` | `unconfigured`,
  `ProviderCooldownCause` in `src/model-cooldown.ts`), and
  `probeFromCooldownStore` filters `unconfigured` entries out
  (`isCapacityCause`, `src/capacity-cache.ts`). Otherwise the 10-minute window
  would surface as a capacity window, make `isModelExhausted(commandcode/…)`
  true, and let the all-exhausted fast-fail report "out of capacity, retrying
  after reset" for what is a configuration error. An entry with no tag (legacy
  file) still counts as capacity, because `quota` was the only provider-scoped
  cause before the tag existed.
- **Short, expiring window.** `DEFAULT_UNCONFIGURED_PROVIDER_COOLDOWN_SECONDS`
  (10 min) because the fix is an operator action (`COMMAND_CODE_API_KEY` in the
  service env, or `/login`). The provider entry expires, so a key added later is
  picked up without editing the shared store; a repeated
  unconfigured mark escalates like any other unhinted provider guess, capped by
  `MAX_ESCALATED_COOLDOWN_SECONDS`.

Named tests: `src/__tests__/quota-failure.test.ts` →
`classifies the extension's no-key message as provider-scoped unconfigured`,
`classifies pi's no-key startup refusal as unconfigured (bd-178)`,
`classifies generic no-key wording from other providers`,
`keeps a status-coded credential failure on the status rule`,
`keeps status-coded process stderr on its status rule`,
`leaves an unrelated statusless failure as other`;
`src/__tests__/capacity-cache.test.ts` →
`keeps an unconfigured provider out of the capacity signal (bd-178)`,
`keeps a tagged entry from a legacy-shaped providers map out of the signal`,
`keeps an unconfigured cooldown written by another member out of the signal`,
`treats an entry without a cause tag as capacity (legacy files)`; and
`src/__tests__/spawn-with-fallback.test.ts` →
`end-to-end: an unkeyed Command Code provider degrades to llmgateway`,
`end-to-end: pi's process-path no-key refusal degrades to llmgateway (bd-178)`,
`terminates and surfaces the trail when every hop has no key (bd-178)`,
`reports a missing key as the skip cause, not a quota failure (bd-178)`.

### Orchestrator sessions route their own model (bd-229)

The fallback loop above only ever wrapped *spawned pi subprocesses*. A
`/belayd` child orchestrator, a `belayd_start_followup` child, and every fleet
member are pi-web **session daemon** sessions: `createOrchestratorSession` posts
`{ cwd, name }` to `/sessions` with no model, so pi-web starts the child on the
operator's global default (`defaultProvider` / `defaultModel` in
`~/.pi/agent/settings.json`). When that default was a spent provider, the child's
first turn died with `402 … "code":"billing_error"` while the cooldown store
already knew the provider was out — the workflow gate was armed and no phase
ever ran.

What the launch path does now, before the child is prompted:

1. **Pre-flight, no side effects.** The caller's model stands in for the child's
   (pi-web resolves both from the same settings). `planModelRoute` orders the
   candidates with the current model first, and the launch refuses when none is
   available — before a worktree, a lease or `.belayd/workflow.json` exists.
   The error names each provider and its reset time:

   ```text
   Refusing to launch: no model candidate can serve a turn (llmgateway (resets 2026-11-03T03:15:00.000Z), …). Wait for that window to lapse or top up the provider, then retry. BELAYD_MODEL_FALLBACK=0 skips this check, but the session will fail on the same provider.
   ```

2. **Post-create routing.** After the daemon creates the session, its model is
   read from `GET /sessions/:id/status` (authoritative: it includes a workspace
   `.pi/settings.json` override) and, when that model's provider or endpoint is
   cooling, the first usable candidate is applied with
   `POST /sessions/:id/model` `{ cwd, provider, modelId }`. A candidate pi-web
   refuses (unknown wire id, no credential) falls through to the next; a session
   left unroutable is stopped, archived, and its lease and workflow state
   released. The switch is logged (`orchestrator <task> routed to <model>
   because <model> is unavailable`).

3. **In-session recovery.** An orchestrator or human session has no spawner, so
   a quota-class failure on its own turn used to end the run. `message_end` now
   classifies the assistant error with the same rules as the spawn path
   (`classifyAssistantMessage`) and persists the cooldown; `agent_before_settle`
   then switches to the next candidate and returns `continue: true`, so pi makes
   one more provider request instead of stopping. It is bounded (3 switches per
   session, never repeating a model it already ran on) and it skips phase
   sub-agents, whose model accounting belongs to `spawn-with-fallback`.

`BELAYD_MODEL_FALLBACK=0` disables all three. Phase sub-agents are unaffected:
their attempts, telemetry and `-fallback-N` naming still describe the model each
spawn actually used.

Named tests: `src/__tests__/orchestrator-model.test.ts` (candidate ordering,
refusal wording, wire-id splitting);
`src/__tests__/extension-orchestrator-model-routing.test.ts` →
`moves the child session off a spent provider before prompting it`,
`leaves a healthy session model alone`,
`routes even when the caller's model differs from the child's`,
`refuses before any side effect when every provider is spent`,
`skips routing entirely when fallback is disabled`; and
`src/__tests__/extension-model-recovery.test.ts` →
`switches to the next candidate and continues the run once on a 402`,
`persists a provider-scoped cooldown so the next phase spawn skips it`,
`does not repeat a candidate it already ran on`,
`leaves a phase sub-agent alone`, `stops switching at the per-session cap`.

### Shared model-state store and provider wrapper (bd-187)

bd-38/bd-116/bd-229/bd-234 above are still live. bd-187 introduced the shared
SQLite state store and the provider wrapper; **bd-256 finished the migration** —
there is one cooldown truth, the routing layer reads it through an adapter, and
the JSON file below is only a legacy import source. See
[One cooldown truth](#one-cooldown-truth-bd-256) in this section.

**What it is.** A pi-ai **provider wrapper** (`src/provider-wrapper.ts`) over a
shared **SQLite** state file (`src/model-state-store.ts`), with the policy in
`src/provider-policy.ts`. The wrapper spreads the real provider and overrides
only `stream`/`streamSimple`; every other member is forwarded untouched and the
provider **id never changes** (pi `model_change` entries and pi-durable
`pi.agent` documents store provider ids, so a rename orphans conversations).

**Path.** `resolveModelStatePath()` is the one rule:
`BELAYD_MODEL_STATE_FILE` first, else the retired `BELAYD_MODEL_COOLDOWN_FILE`
(`model-cooldowns.json` → `model-cooldowns.sqlite`), else
`$XDG_STATE_HOME/belayd/model-state.sqlite` (or
`~/.local/state/belayd/model-state.sqlite` without `XDG_STATE_HOME`). The
adapter's default store and the wrapper's policy both use that path; the retired
JSON file is an import source, never a second store. WAL, busy timeout, schema
marker in `PRAGMA user_version` (now **2**; v1 files are migrated in place
inside one `BEGIN IMMEDIATE` transaction, idempotently and with a bounded
retry), and a short synchronous read cache (1 000 ms).

**Tables.** `cooldown(provider, model, until_ms, reason, retry_after_ms, cause,
escalations, last_mark_ms)` (`model = '*'` is either a provider-wide window or,
with `provider = '*'`, a provider-agnostic bare model id; `cause` is `quota` or
`unconfigured` on provider-wide rows; `escalations` is the rung on an unhinted
provider-wide row and NULL on hinted/model rows), `capacity(provider, class,
limit, in_use)`, `lease(lease_id, provider, class, daemon_pid, host,
expires_ms)` and `spend(ts, provider, model, phase, task_id, input, output,
cache_read, cache_write, cost)`. Reserve/release are short `BEGIN IMMEDIATE`
transactions
that recompute `in_use` from the lease table. Expiry is time-based
(`expires_ms`), never pid-based, so a SIGKILLed daemon cannot hold capacity;
the unhinted cooldown ladder lives in `cooldown_ladder` so a 6 h guess still
doubles to the 24 h ceiling. A release is ownership-checked (`host` +
`daemon_pid`): another process knowing the lease id cannot free the slot, and a
repeat release is an idempotent no-op. The database file and its `-wal`/`-shm`
sidecars are chmod'd 0600 (directory 0700) after every write — including lease
renewals, which share the release path's post-commit duties — so the shared
budget state is not world-readable on a multi-user host.

`cooldownFor({ provider, model })` answers one endpoint: a provider-wide row
outranks an exact `(provider, model)` row, and a provider-agnostic `'*'` row
matches any provider. `listCooldowns()` returns every still-active row (that is
what the routing adapter enumerates), and `prune()` deletes expired rows, the
ladder after its 7-day memory, and expired leases.

### One cooldown truth (bd-256)

`src/model-cooldown.ts` is now a thin adapter (`ModelCooldownStore`) over the
same `ModelStateStore` instance the provider policy uses
(`extensions/capabilities/model.ts` builds both from
`sharedModelStateStoreInstance()`). One write is visible to every reader:

- A quota failure the wrapper classifies and records (`observeTerminal` →
  `ProviderPolicy.recordFailure` → `store.markCooldown`) is read back by
  `isCoolingDown`/`cooldownScope`/`providerEntries`, so the next
  `spawnAgentWithFallback` skips it and launch preflight/in-session recovery
  (`planModelRoute`) refuse it. No JSON file is written.
- A cooldown the routing path marks (`recordFailureCooldown` →
  `ModelCooldownStore.markProviderCooldown`/`markCooldown`) is the row
  `policy.decideDispatch` reads, so the next wrapped dispatch is denied with a
  `ProviderPolicyRefusalError` instead of calling a spent provider.

The adapter keeps the routing-facing semantics unchanged: provider-scoped
unhinted marks escalate ×2 (24 h cap, 7-day ladder memory), hinted marks set an
exact window and clear the ladder, model-scoped marks never escalate, and
`cooldownScope` still answers `"provider" | "model"` for skip rows and launch
routing.

**The default store is the shared one.** `createModelCooldownStore()` (and the
`now`-only overload) resolves `sharedModelStateStore()`, whose path is
`resolveModelStatePath()`: `BELAYD_MODEL_STATE_FILE`, else the retired
`BELAYD_MODEL_COOLDOWN_FILE` (`x.json` → `x.sqlite`), else XDG. A caller that
omits `store` therefore cannot fork a second truth — the
`spawnAgentWithFallback` default included. `{ store: "memory" }` is the explicit
private-store escape hatch (tests); `{ store: null }` is the explicit permissive
no-op. A `filePath` names the legacy import source only; it never selects the
store path.

**Open failures are classified, and marks are never silently dropped.** A
failed shared open is not memoized for the session. `classifyStoreFailure`
splits it:

- **transient** (SQLITE_BUSY/LOCKED, an in-flight migration, momentary IO or
  storage pressure — the errno *and* the SQLite-class spellings, plus node's
  numeric `errcode`): warn once per failure class, return a read-only facade
  that degrades capacity/lease/spend to "dispatch without a lease", and retry
  after `SHARED_MODEL_STATE_RETRY_MS` (30 s). The facade still records cooldown
  marks: they are queued with their failure-time clock, capped at
  `MAX_PENDING_COOLDOWN_MARKS` = 32, and the first successful open replays them
  into the store *before* it serves a read. A queued mark is replayed for as
  long as its window is still live — a hinted 20-minute reset or a laddered
  weekly bucket must not be dropped because the outage lasted longer than the
  queue-age bound (`MAX_PENDING_COOLDOWN_AGE_MS`, 10 min) — so a 402 seen during
  the outage still steers the next spawn and the next wrapped dispatch. Only
  marks that were already expired when the store came back fall under the age
  bound, and the entry cap (not the age bound) bounds memory. Under the cap,
  eviction drops an already-expired mark first, then the shorter of two queued
  marks for the same row, and only then the oldest mark, so a hammering
  fallback loop cannot evict the provider the fleet is actively failing on.
- **permanent** (no `node:sqlite`, ENOTDIR/EACCES/EROFS, a non-sqlite file,
  corruption): warn once, stop retrying, stay permissive with `null`. The
  warning names the error and says cooldown tracking is off until restart, so
  the diagnosis is actionable. No queue is kept: a store that can never open
  must not accumulate marks.

The adapter's lazy provider re-invokes the accessor on every use, and that
covers **both** branches: the default store *and* a caller-supplied provider
thunk (the extension passes `() => sharedModelStateStoreInstance()`) may hand
back the facade during an outage, and `resolveStore()` only ever caches a store
that is genuinely usable. A facade is served (it queues marks) but never
memoized, so recovery is picked up by `modelStatePolicy()` and the capacity
probe without a restart, and the legacy import is only latched once a real
seeder accepted it — a facade cannot swallow the migration. The schema
migration shares the classifier: a busy/locked migration is retried (bounded),
anything else fails on the first attempt so the permanent path is reached
immediately.

**Legacy import replays the ladder.** The retired
`~/.pi/agent/model-cooldowns.json` is read once on first adapter use when a
`filePath` is supplied (the extension passes a thunk, so
`defaultModelCooldownPath()` is read on first use rather than at module load):
still-active windows are seeded with their absolute `until` (longer wins, 24 h
ceiling on an escalated window, `lastMarkedAt` preserved) and the file's
`escalations` map is replayed into `cooldown_ladder` (later mark wins, count 0
keeps meaning "hinted reset", rungs older than 7 days are dropped). An escalated
weekly bucket therefore continues from its rung instead of restarting at rung 1.
The migration is remembered by a `.imported` marker beside the file (its parent
directory is created if needed) and is recorded even when the file yields no
active windows; a missing file leaves it pending. The user's file is never
rewritten or deleted, and a read-only or failing store leaves the migration
pending.

Named tests: `src/__tests__/model-cooldown.test.ts` (adapter scopes, entry
shape, prune, degradation, escalation parity, default-store path matrix,
one-time legacy import with ladder replay, and a provider thunk that returns
facade-then-real — the facade is served but not cached, and the import runs
only after recovery) and
`src/__tests__/model-cooldown-adapter.test.ts` (`wrapper → routing` refusal of
the next spawn **with the default store** and of the launch plan with no JSON
write; `routing → wrapper` denial and `ProviderPolicyRefusalError`;
escalation/hint parity through the wrapper's own write path; a failed first open
that recovers after the retry window, including one where the extension-shaped
adapter was *built* during the outage and still sees both directions after it).
`src/__tests__/model-state-store.test.ts` pins the classifier table (SQLite-class
and errno spellings plus node's `errcode`), long-window replay, the eviction
order and the pending-mark cap.

**Capacity is on the production path.** Every wrapped dispatch reserves a lease
before calling the real provider and releases it when the stream settles
(success, terminal error, or rejected stream), so `in_use` is live cross-process
concurrency. The limit is per `(provider, class)` bucket, defaults to **8**, and
is set with `BELAYD_MODEL_CAPACITY_LIMIT` (`0` disables capacity). One scalar
limit covers the whole bucket: in a fan-out every spawned child holds its own
lease against the same bucket, so the (limit+1)th child is refused — and because
the refusal classifies as `capacity` (below), it falls back to the next
candidate instead of failing the phase. A refusal is a typed
`ProviderPolicyRefusalError` with `scope: "capacity"` and the provider, class,
`inUse`, `limit` and a wait hint; the real provider is never called.

A lease is renewed on a heartbeat at a third of its TTL while the stream is live
(`BELAYD_MODEL_LEASE_TTL_MS`, default 10 minutes), so a turn that outlives the
original TTL keeps its slot instead of being handed to another process. The TTL
is clamped to a **10 s floor** (`LEASE_TTL_FLOOR_MS`) and the derived interval to
a **1 s floor** (`LEASE_RENEWAL_INTERVAL_FLOOR_MS`) independently: a tiny TTL
would otherwise commit a `BEGIN IMMEDIATE` renewal every few hundred milliseconds
per live stream, contending with cooldown/spend writers across every wrapped
runtime under the store's 5 s busy timeout. A sub-floor value is refused with one
warning naming the env var and the floor used, not silently accepted. The
heartbeat stops on every settle path; if the process is SIGKILLed, the lease
expires by `expires_ms` and only then frees the slot. An expired lease can never
be renewed (its slot may already be reused). A read-only or unopenable store
skips capacity entirely and dispatches without a lease — bookkeeping failure
never blocks a turn.

**Capacity refusals are fallback-worthy.** The wrapper embeds the stable
`CAPACITY_REFUSAL_MARKER` in a capacity refusal message, and `quota-failure.ts`
classifies that marker as the additive `capacity` kind
(`isFallbackWorthy("capacity") === true`) on **both** paths: the assistant
record (the marker survives pi's conversion of the thrown refusal) and the
process path (a child that writes the marker to stderr and exits non-zero). Both
checks run first, before every network/quota wording rule. A capacity denial
therefore moves the spawn loop to the next candidate instead of dying as
`other`. It records **no**
cooldown and no capacity window, and telemetry does not count it as a
`quotaFailure`: nothing upstream was spent.

**Degradation (acceptance criterion).** The store factory returns
`{ ok: false }` instead of throwing. A read-only store (`readOnly: true`) serves
every read and fails every write as a value. Either way the policy becomes
permissive and the wrapped provider still serves: a state-store error never
becomes a provider error. The store is also opened **lazily on the first
dispatch**, so extension load creates no file. A model whose id cannot be
resolved is dispatched permissively too: nothing is written under a synthetic
`unknown` key, and one warning per provider names the condition.

**Both runtimes.** The pi extension registers the wrappers from
`extensions/capabilities/model.ts` via `pi.registerProvider` (the first provider
registration in this repo). pi-durable uses the runtime-agnostic
`installProviderPolicy(models, options)` with the same wrapping code path. At
least one provider stays **direct/unwrapped** so a broken wrapper or state store
is never the only path to a model: the extension keeps `llmgateway` (the
harness's per-token primary) direct unless `BELAYD_MODEL_STATE_DIRECT_PROVIDER`
names another one. `BELAYD_MODEL_STATE_WRAPPER=0` disables wrapping. Wrapping is
idempotent, so repeated `session_start` cannot double-observe a stream. Providers
outside the policy (realised with no object, still missing after a previous
observation, missing id, or a failed registration) are named in one warning; the
intentionally-direct provider is not listed. Registration failures are warned
once per session with a running count, and the window resets on the next
`session_start`.

A lazy provider (registered with no provider object yet) is deferred on first
sighting, reported once after that, and **remembered until it materialises** — a
provider that stays missing would otherwise alternate deferred → bypassed →
deferred and re-warn on every second session. Materialisation is re-checked at
session boundaries **and** on every turn start (`reconcileDeferredProviders`,
which is a no-op unless a previously deferred id now has an object), so a
dynamic catalog that composes mid-session gets wrapped at its next observation
instead of staying direct for the whole session. Known limit: a provider that
materialises after that observation remains direct until the next one; pi emits
no notification for a provider object appearing.

**Spend attribution is per dispatch.** The wrapper **snapshots** a shared
mutable `DispatchAttribution` holder (`{ phase, taskId }`) once per dispatch
invocation (per caller attempt) and uses that snapshot for the spend row, so a
stream that settles after the next run boundary cannot be relabelled as the new
phase/task. The extension repoints the holder from the current turn's session
state (`plan` vs `orchestrator`, current task id) and pi-durable hands in its own
holder; repointing affects **future** dispatches only. Idempotent re-installs
reuse the holder, so stale labels cannot survive a task cycle.

**Retry amplification is two layers.** The wrapper adds **no** retry for a
quota-class failure: it classifies, records the cooldown and surfaces the
failure, so provider calls are **at most** the caller's attempt count — and
fewer once the first failure has written a cooldown row, because the later
attempts are refused locally by `decideDispatch` before reaching the provider
(the no-store configuration is where the count equals the attempts). The
safety invariant is the upper bound, enforced by `MAX_ATTEMPTS_PER_DISPATCH`; a
broader wording pass over this measurement is tracked by bd-249 and is not part
of bd-256. For a transient
synchronous dispatch throw it may spend one extra attempt
(`TRANSIENT_RETRY_BUDGET = 1`), bounded by `MAX_ATTEMPTS_PER_DISPATCH = 2` per
caller attempt. The second, **unenforced** layer is pi's own retry:
`settings.retry.maxRetries` defaults to **3** and multiplies whatever the
caller does, beyond this repo's control. Set it to
`RECOMMENDED_RETRY_MAX_RETRIES = 1` (pi-durable) or a 429 becomes a 429 storm.
This repo does not write `~/.pi/agent/settings.json`; the recommendation is
exported and documented only.

**No cross-process in-flight coalescing.** Two processes can both see free
capacity and both dispatch. That is a proxy feature, and the gateway design was
explicitly rejected (bd-188), so the store deliberately does not pretend to do
it.

Named tests: `src/__tests__/model-state-store.test.ts` (schema/WAL, v1→v2
cooldown-column migration, failure classification (transient vs permanent),
schema-retry policy (busy retried, permanent fails on the first attempt),
permanent-failure single warning, transient pending-mark queue/flush and its
bound/staleness rules, cooldown upsert/prune/list, capacity
reserve/release, lease ownership, lease renewal and
expired-renewal refusal, renewal cache invalidation and mode re-tightening,
0600/0700 modes, expired lease, spend reconcile,
read-only and unopenable stores, read cache),
`src/__tests__/provider-policy.test.ts` (provider vs model denials, hinted
`retry_after_ms`, unhinted doubling to 24 h, capacity acquire/release and typed
denial, retry constants, lease TTL parsing, TTL floor and one-time clamp
warning),
`src/__tests__/provider-wrapper.test.ts` (id preserved, members forwarded,
idempotent double-wrap with one call/spend/cooldown row, quota no-retry and
bounded transient retries by attempt count, capacity lease hold/lease renewal
past the original TTL on one connection (the cross-connection proof lives in the
integration file)/release on success/error/rejection with no timer left,
capacity refusal classified as `capacity`, per-dispatch attribution snapshot,
unresolvable model ids skipped, denial never calls the provider, spend on
success, read-only and unopenable stores still serve, stream rejection not
swallowed),
`src/__tests__/extension-model-providers.test.ts` (one direct provider, bypass
warning content, lazy-provider deferral, one warning for a permanently missing
lazy provider, mid-session materialisation reconcile, per-session failure
warning count),
`src/__tests__/extension-provider-registration.test.ts` (a throwing registry
leaves the rest of `session_start` running),
`src/__tests__/model-cooldown.test.ts` and
`src/__tests__/model-cooldown-adapter.test.ts` (the routing adapter and the two
directions of the one truth — see [One cooldown truth](#one-cooldown-truth-bd-256)),
and
`test/model-state-cross-process.integration.test.ts` (two processes see one
window, a live child renews its lease past the original TTL so a second
connection is still refused and succeeds only after release, SIGKILLed lease
expires, spend totals reconcile).

### 4. Telemetry artifacts: `.belayd/telemetry.json`

Path: `<repo-cwd>/.belayd/telemetry.json` (gitignored; `modelTelemetryPath(cwd)`).

```jsonc
{
  "schemaVersion": 1,
  "stats": [
    {
      "phase": "implement",                        // phase name, e.g. "scout".."commit", "proof-verifier"
      "model": "opencode-go/deepseek-v4.1-flash",  // candidate actually spawned
      "attempts": 2,                               // every spawned attempt, including fallbacks
      "fallbacks": 1,                              // attempts where the spawned-attempt ordinal > 0
      "quotaFailures": 1,                           // classification.kind === "quota": HTTP 402/429
                                                    // quota/credit/rate limit, or an entitlement 403
      "noOps": 0,                                   // classification === "success" with toolCalls === 0
      "cost": 0.03                                  // USD, from pi usage events
    }
  ],
  "totals": { "attempts": 2, "fallbacks": 1, "quotaFailures": 1, "noOps": 0, "cost": 0.03 },
  "updatedAt": 1750000000000
}
```

Semantics:

- **Rows are keyed by `(phase, model)`**; a missing row is created on first
  record. Rows are sorted by phase then model.
- **Append/merge, not overwrite.** Each flush read-modify-writes the file,
  summing the new rows into the persisted ones (`appendModelTelemetry`), so an
  orchestrator restart (fresh in-process store) never clobbers prior history. A
  per-destination flush cursor (`flushedByCwd`) means only the delta since the
  last flush is appended — otherwise counts would grow quadratically across a
  workflow's settles. A failed flush leaves the cursor untouched so the rows are
  retried; a failed final flush does **not** drop the store, and warning is
  throttled to once per 5 minutes
  (`[belayd-harness] failed to persist model telemetry: <error>`).
- **Cursors are keyed by normalized cwd**, so `/repo`, `/repo/`, and `repo` are
  one destination.
- **One orchestrator per repo cwd is the supported scenario.** The append is a
  read-modify-write with no cross-process lock; two concurrent orchestrators on
  the same cwd can interleave and lose rows (last writer wins).
- **A corrupt or wrong-shape file reads as absent** and the next append
  overwrites it with the new rows rather than failing forever.
- **A skipped candidate produces no row.** Telemetry counts spawned attempts
  only, so skip rows (`cooldown`, `provider exhausted`, `capacity-exhausted`)
  and the all-exhausted fast-fail path add nothing.
- **Summary log line, once per workflow.** `formatModelTelemetrySummary`
  prints a header plus one line per `(phase, model)` row:

  ```text
  [belayd model telemetry] attempts=7 fallbacks=2 quotaFailures=2 noOps=1 cost=$0.1840
    implement opencode-go/deepseek-v4.1-flash: attempts=3 fallbacks=1 quota=1 noops=0 cost=$0.1200
    plan opencode-go/deepseek-v4.1-flash: attempts=2 fallbacks=1 quota=1 noops=0 cost=$0.0500
    scout llmgateway/mimo-v2.6-flash: attempts=2 fallbacks=0 quota=0 noops=1 cost=$0.0140
  ```

  It is emitted on workflow **completion**, `belayd_stop_task`, and
  `session_shutdown` — not on every phase settle. Settles flush silently: each
  settled phase run, each delivered planning run, and each workflow start/reset
  path writes only the delta, with no summary. The proof verifier is not a
  tracked run, so its row rides on the next flush — the workflow completion
  flush, or `session_shutdown` when the workflow never completes.
  Because the store is reset after a logged exit path, a second exit path logs
  nothing (an empty store is skipped), so the summary appears once per workflow.

### 5. Run manifests: per-run `telemetry` totals

Each run manifest (`<cwd>/.belayd/runs/<runId>.json`) gains an optional
`telemetry` field with this run's own totals — a **delta for the run**, not the
process- or workflow-cumulative totals:

```jsonc
{
  "schemaVersion": 1,
  "runId": "m3k2p1",
  "taskId": "bd-116",
  "phase": "implement",
  "sessionName": "belayd-bd-116-sub-implement-m3k2p1",
  "status": "completed",
  "startedAt": 1750000000000,
  "completedAt": 1750000002500,
  "model": "opencode-go/deepseek-v4.1-flash",
  "exitCode": 0,
  "telemetry": { "attempts": 2, "fallbacks": 1, "quotaFailures": 1, "noOps": 0, "cost": 0.03 }
}
```

How to read it:

```bash
# every run that has telemetry, with its per-phase cost
jq -r 'select(.telemetry != null)
  | "\(.taskId)\t\(.phase)\t\(.status)\tatt=\(.telemetry.attempts)\tfb=\(.telemetry.fallbacks)\tnoops=\(.telemetry.noOps)\t$\(.telemetry.cost)"' \
  .belayd/runs/*.json
```

Library access (`src/index.ts` exports): `readRunManifest({ cwd, runId })` for
one run, `listRuns({ cwd })` for all runs sorted by `startedAt`. The field is
written by `setRunTelemetry({ cwd, runId, telemetry })`, which returns
`{ ok: false, error }` for an unknown run id; the manifest's other fields are
preserved. The value comes from that run's own private telemetry store, so an
overlapping run (or a mid-run workflow-store reset) cannot collapse it to zero.
The manifest omits `telemetry` entirely when the run spawned nothing
(`attempts === 0`).

### 6. How to read the numbers

Per `(phase, model)` rows and per-run deltas answer three different questions.

**Is capacity being burned on retries?** Compare `fallbacks` to `attempts`.
Per phase (`fallbacks / attempts`):

```bash
jq -r '.stats
  | group_by(.phase)[]
  | { phase: .[0].phase,
      attempts: (map(.attempts) | add),
      fallbacks: (map(.fallbacks) | add),
      noOps: (map(.noOps) | add),
      cost: (map(.cost) | add) }
  | "\(.phase)\tattempts=\(.attempts)\tfallbacks=\(.fallbacks)\tnoops=\(.noOps)\tcost=$\(.cost)"' \
  .belayd/telemetry.json
```

Example output:

```text
implement	attempts=3	fallbacks=1	noops=0	cost=$0.0400
plan	attempts=2	fallbacks=1	noops=0	cost=$0.0240
scout	attempts=2	fallbacks=0	noops=1	cost=$0.0140
```

`quotaFailures` says *why* the fallbacks happened: a phase whose `fallbacks`
are almost all explained by `quotaFailures` is fighting provider limits (the
pre-dispatch check plus the tuned class are the levers); fallbacks with zero
`quotaFailures` mean model- or credential-level failures (transient,
unavailable, unconfigured, "other") where the class routing, not capacity, is
the lever. A fallback trail showing `(unavailable)` means a candidate id is
retired at that endpoint — swap it in `MODEL_CLASS_SPECS` rather than waiting
for the cooldown; `(unconfigured)` means that provider has no key and the phase
degraded to the next provider.

**Which candidate actually absorbs the work?** Group by model to see whether the
class primary is really the one doing the work:

```bash
jq -r '.stats
  | sort_by([-.fallbacks, -.noOps, -.attempts])[]
  | "\(.phase)\t\(.model)\tatt=\(.attempts)\tfb=\(.fallbacks)\tquota=\(.quotaFailures)\tnoops=\(.noOps)\t$\(.cost)"' \
  .belayd/telemetry.json
```

If the class primary for a phase accumulates `quotaFailures` and every
`fallbacks` row sits on the alternate providers, that phase is effectively
pinned to the second provider and should be re-tiered or given an explicit
model.

**Are phases doing nothing?** `noOps` counts *successful* attempts that made
zero tool calls — the sub-agent returned without acting. A phase with a
non-trivial `noOps` share (against `attempts`) is a prompt/contract problem, not
a capacity problem: it spends tokens and returns nothing, exactly the bd-116
"46 zero-tool-call runs" pattern. Tune the phase prompt or the tool policy
rather than the model class.

Heuristic bands (there is no hardcoded threshold in the code — these are rules
of thumb anchored on the ~32% session-level fallback rate observed before
bd-116):

| Signal | Reading |
| --- | --- |
| `fallbacks / attempts` ≤ ~0.1 | Healthy: the class primary almost always serves the phase. |
| ~0.1–0.3 | Watch: one provider bucket is being drained; check `quotaFailures`. |
| > ~0.3 sustained | Alarming: the phase is mostly retries. Either the provider is genuinely limited (pre-dispatch will help once a window is known, or move the phase to a class with a healthier primary) or the tier is wrong. |
| `noOps > 0` | A successful no-op happened. Investigate the phase prompt/contract; a class change will not fix it. |

To attribute cost and fallbacks to delivered work, join the manifest to the
task; every manifest carries `taskId` and `phase`:

```bash
jq -s -r '
  map(select(.telemetry != null))
  | group_by(.taskId)[]
  | { taskId: .[0].taskId,
      attempts: (map(.telemetry.attempts) | add),
      fallbacks: (map(.telemetry.fallbacks) | add),
      noOps: (map(.telemetry.noOps) | add),
      cost: (map(.telemetry.cost) | add) }
  | "\(.taskId)\tattempts=\(.attempts)\tfallbacks=\(.fallbacks)\tnoops=\(.noOps)\tcost=$\(.cost)"' \
  .belayd/runs/*.json
```

Example output:

```text
bd-116	attempts=9	fallbacks=2	noops=1	cost=$0.2400
```

`bd` itself does not read or write this file; the join key is the manifest's
`taskId`, which the workflow records from `belayd_start_task` — use it with
`bd show <id>` / `bd list` when deciding which task's phases deserve a
re-tiering pass.

## Library API (for consumers)

All of the following are re-exported from `src/index.ts`:

```typescript
import {
  CAPACITY_PROBE_URL_ENV,
  COOLDOWN_ESCALATION_FACTOR,
  COOLDOWN_ESCALATION_MEMORY_MS,
  COOLDOWN_REFRESH_MAX_AGE_MS,
  DEFAULT_CAPACITY_BODY_LIMIT_BYTES,
  DEFAULT_CAPACITY_PROBE_TIMEOUT_MS,
  DEFAULT_CAPACITY_TTL_MS,
  DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS,
  MAX_CAPACITY_WINDOWS,
  MAX_ESCALATED_COOLDOWN_SECONDS,
  createCapacityCache,
  createEndpointCapacityProbe,
  createFallbackCapacityProbe,
  createModelCooldownStore,
  openModelStateStore,
  orderCandidatesByCapacity,
  parseCapacityWindows,
  probeFromCooldownStore,
  resetSharedModelStateStore,
  resolveModelStatePath,
  resolveQuotaCooldown,
  sharedModelStateStore,
} from "belayd-agent-harness";

// Capacity windows are plain data, so parsing and ordering are testable alone.
// The no-argument store is the process-wide shared truth (path from
// resolveModelStatePath()); { store: "memory" } is the explicit test isolation.
const cooldownStore = createModelCooldownStore();

// Cooldown resolution for a 429 body: hint → provider usage-limit window → default.
// It returns { cooldownSeconds, cooldownHinted } — the flag the mark API needs.
resolveQuotaCooldown("Weekly usage limit reached. Resets in 7hr 57min.");
// { cooldownSeconds: 28 620, cooldownHinted: true }
resolveQuotaCooldown('{"type":"GoUsageLimitError","message":"Go usage limit exceeded"}');
// { cooldownSeconds: 21 600, cooldownHinted: false } — the long provider window

// A hinted mark is authoritative; an unhinted one escalates (6 h → 12 h → 24 h).
cooldownStore.markProviderCooldown("opencode-go", 21_600, "GoUsageLimitError");
cooldownStore.markProviderCooldown("opencode-go", 21_600, "GoUsageLimitError");
cooldownStore.markProviderCooldown("opencode-go", 28_620, "resets in 7hr 57min", { hinted: true });

const windows = parseCapacityWindows(
  { providers: { "opencode-go": { resetsInSeconds: 3600 } } },
  Date.now(),
);

// Cache seeded from an endpoint, falling back to a cooldown store.
const capacity = createCapacityCache({
  probe: createFallbackCapacityProbe(
    createEndpointCapacityProbe({ url: "https://example.test/usage" }),
    probeFromCooldownStore(cooldownStore),
  ),
});

await capacity.refreshIfStale();               // never rejects
// Candidate selection refreshes the store itself: `spawnAgentWithFallback`
// calls cooldownStore.refreshIfStale(COOLDOWN_REFRESH_MAX_AGE_MS) + prune()
// before picking a candidate, on every spawn (TTL-independent, and independent
// of the capacity probe). probeFromCooldownStore uses the same bounded window,
// so one spawn reads the file at most once. Call the unbounded refresh()
// yourself when a decision needs certainty and the store may predate the entry
// (orchestrator launch preflight, in-session recovery).
cooldownStore.refreshIfStale(COOLDOWN_REFRESH_MAX_AGE_MS); // shared with the probe
cooldownStore.refresh(); // unconditional merge; no-op in-memory
capacity.record({ provider: "opencode-go", resetAt: Date.now() + 3_600_000, reason: "429" });
capacity.isModelExhausted("opencode-go/mimo-v2.6-flash"); // true
orderCandidatesByCapacity(["opencode-go/a", "llmgateway/a"], (c) =>
  capacity.isModelExhausted(c),
);
```

`spawnAgentWithFallback` accepts three new options: `phase` (telemetry grouping
label, defaults to `"unknown"`), `telemetry` (a `ModelTelemetryStore`), and
`capacity` (a `CapacityCache`). Omitting `capacity` disables the pre-dispatch
check entirely (the spawned-attempt ordinal rule still applies); omitting
`telemetry` records nothing. Telemetry helpers:
`createModelTelemetryStore`, `combineModelTelemetryStores`,
`sumModelTelemetryStats`, `diffModelTelemetryStats`, `mergeModelTelemetry`,
`readModelTelemetry`, `writeModelTelemetry`, `appendModelTelemetry`,
`formatModelTelemetrySummary`, `modelTelemetryPath`; session-scoped plumbing:
`createModelSessionState`, `flushModelTelemetry`,
`flushAndResetModelTelemetry`, `resetModelSessionState`. Run manifests:
`setRunTelemetry`, `setRunModelSelection`, `mergeRunModelSelections`,
`deriveRunModelSelection`, `readRunManifest`, `listRuns`, `RunTelemetryTotals`.

## Known limits

- **Capacity is only as fresh as the last probe or 429.** A window can be
  stale by up to one TTL (5 minutes), and a provider that recovers inside a
  window is still avoided until the window expires or a probe replaces it.
  This bounds the *endpoint* capacity signal only: candidate selection re-reads
  the shared cooldown rows on every spawn (one indexed query; the adapter's
  bounded refresh only governs the store's 1 s cache), so a provider another
  fleet member cooled is skipped immediately even when a
  capacity window has not refreshed yet.
- **Reset times are epoch milliseconds, relative seconds, or a reset-hint
  string.** Any other unit is read wrong rather than rejected: a body reporting
  Unix *seconds* in `resetAt` is read as epoch ms, i.e. a time in 1970, which
  counts as already expired; ISO strings are not numbers and yield no window.
  Entries with no resolvable reset time are dropped.
- **One orchestrator per repo cwd.** Concurrent orchestrators sharing a cwd can
  lose telemetry rows on the read-modify-write; there is no cross-process lock.
- **`cost` is assumed to be USD.** It is whatever pi's usage events report
  (gateway dollar costs); no unit conversion is applied.
- **Skipped candidates are invisible to telemetry.** Only spawned attempts
  produce rows, so `attempts` is not the number of candidates considered. The
  all-exhausted fast-fail path records nothing at all — look for its result text
  (`All candidate models are capacity-exhausted providers ...`) instead.
- **The capacity endpoint is called with `GET` only and no credentials.** Any
  authentication has to be baked into the URL (or fronted by a local proxy);
  there are no headers or auth options.
