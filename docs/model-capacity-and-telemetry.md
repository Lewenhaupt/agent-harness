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
`src/spawn-with-fallback.ts`, `src/run-manifest.ts`, and the wiring in
`extensions/index.ts`.

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

   Expected: 6 files / 124 tests passed (33 capacity-cache, 21 model-telemetry,
   9 model-session-state, 33 spawn-with-fallback, 26 run-manifest, 2
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

   Expected: 4 files / 151 tests passed (50 quota-failure, 35 model-cooldown,
   33 capacity-cache, 33 spawn-with-fallback). Names to look for — the
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
     `treats a hinted reset as authoritative and clears the ladder`, `keeps one
     complete mark per key, preferring the longer window on a tie`, `keeps the
     higher ladder count on a mark-time tie in both directions`, `loads a
     version-1 file written before escalation existed`, `skips only the
     malformed entries of a hand-edited file`.
   - `capacity-cache.test.ts`: `sees a cooldown written by another store instance
     sharing the same file`, `never throws and yields no windows for a missing
     or corrupt file`.
   - `spawn-with-fallback.test.ts`: `cools the provider for hours, so 15 minutes
     later it is still skipped`, `escalates the provider window on a repeated
     unhinted 429`, `does not apply the long provider window on a model-scoped
     failure`.

   Then run the real thing against a scratch cooldown file: see
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
   the fallback to the persisted cooldown store, throttled to about one warning
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
scratch cooldown file, so the persisted state can be read back with `jq`. It is
the fastest way to see the three bd-38 behaviours by hand; the spawn-level skip
is covered by `spawn-with-fallback.test.ts` (see above), because reproducing a
live opencode-go exhaustion is not something a recipe can schedule.

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
   import { readFileSync } from "node:fs";
   import { setTimeout as sleep } from "node:timers/promises";
   import { classifySpawnFailure } from "./dist/src/quota-failure.js";
   import { createModelCooldownStore, defaultModelCooldownPath } from "./dist/src/model-cooldown.js";
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

   // Mirrors recordCooldown() in src/spawn-with-fallback.ts.
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

   const file = defaultModelCooldownPath();
   const store = createModelCooldownStore({ filePath: file });
   const otherMember = createModelCooldownStore({ filePath: file });
   console.log("cooldown file:", file);

   for (const attempt of [1, 2, 3, 4]) {
     const { cooldownSeconds } = await applyFailure(store, UNHINTED);
     show(`unhinted #${attempt} (${cooldownSeconds}s requested)`, store);
   }

   console.log("\nfile after four unhinted failures:");
   console.log(readFileSync(file, "utf8"));

   console.log("hinted failure (20 min, authoritative):");
   const hinted = await applyFailure(store, HINTED);
   console.log(`cooldownHinted=${hinted.cooldownHinted}`);
   show("hinted", store);
   console.log("escalation ladder in the file:", JSON.parse(readFileSync(file, "utf8")).escalations);

   console.log("\nsecond store over the same file, before its probe:", otherMember.providerEntries().size);
   const { windows } = await probeFromCooldownStore(otherMember)();
   console.log("probe windows:", windows);
   EOF
   ```

3. Run it against a scratch file, so the real
   `~/.pi/agent/model-cooldowns.json` is untouched (`defaultModelCooldownPath()`
   honours `BELAYD_MODEL_COOLDOWN_FILE`):

   ```bash
   rm -f /tmp/bd38-cooldowns.json
   BELAYD_MODEL_COOLDOWN_FILE=/tmp/bd38-cooldowns.json node bd38-check.mjs
   ```

   Expected output — 6 h, then doubling, then clamped at 24 h:

   ```text
   cooldown file: /tmp/bd38-cooldowns.json
   unhinted #1 (21600s requested): until ~6.00h out, escalations=1
   unhinted #2 (21600s requested): until ~12.00h out, escalations=2
   unhinted #3 (21600s requested): until ~24.00h out, escalations=3
   unhinted #4 (21600s requested): until ~24.00h out, escalations=4
   ```

   Then the hinted mark, which overrides the escalated window and clears the
   ladder (the ladder record survives with `count: 0`, which is how "cleared at
   this time" is recorded):

   ```text
   hinted failure (20 min, authoritative):
   cooldownHinted=true
   hinted: until ~0.33h out, escalations=0
   escalation ladder in the file: { 'opencode-go': { count: 0, lastMarkedAt: ... } }
   ```

   And the fleet case — a store created *before* the mark saw nothing until its
   probe refreshed the file:

   ```text
   second store over the same file, before its probe: 0
   probe windows: [ { provider: 'opencode-go', resetAt: ..., reason: 'Quota/credit/rate limit (HTTP 429).' } ]
   ```

4. **The persisted file.** After four unhinted failures it looks like this —
   this is the whole `model-cooldowns.json` shape (default path
   `~/.pi/agent/model-cooldowns.json`, override with
   `BELAYD_MODEL_COOLDOWN_FILE`):

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

   Field notes:

   | Field | Required | Meaning |
   | --- | --- | --- |
   | `version` | no | always rewritten as `1`; a file without it loads fine |
   | `providers` / `models` | no | scope maps; each entry needs `until` + `reason` |
   | `until` | yes | epoch ms. `<= now` means expired; expired entries are pruned on load, refresh, and persist |
   | `reason` | yes | free text from the classification (`Quota/credit/rate limit (HTTP 429).`), for humans only |
   | `escalations` (entry) | no | ladder rung that produced this window; absent for hinted and model-scoped windows |
   | `lastMarkedAt` (entry) | no | epoch ms of the mark. Merge order uses this, never `until` |
   | `escalations` (map) | no | per-provider `{ count, lastMarkedAt }`; `count: 0` records a hinted reset. Remembered for `COOLDOWN_ESCALATION_MEMORY_MS` (7 days) after the last mark, then pruned |

   Backward compatibility: a file written by an older build — no `version`, no
   `escalations`, no `lastMarkedAt` — loads unchanged; the missing stamp only
   means the merge cannot order it against this process's entry and falls back
   to the safer window (longer `until`, then higher count). Unknown keys written
   by another version (or by hand) are carried through a read-modify-write. A
   malformed single entry is skipped and its healthy siblings load; a corrupt
   file reads as empty rather than throwing.

5. **Read the live file on a real machine.** The same numbers without the
   script:

   ```bash
   jq -r '.providers | to_entries[]
     | "\(.key)\t\(((.value.until/1000 - now)/3600*10|round)/10)h\t\(.value.reason)"' \
     ~/.pi/agent/model-cooldowns.json
   jq -c '.escalations' ~/.pi/agent/model-cooldowns.json
   ```

   Expected after one unhinted `GoUsageLimitError`: an `opencode-go` row about
   `6h` out and an `escalations` record with `count: 1` — not a 15-minute
   window. Two failures an hour apart: about `12h` and `count: 2`.

6. Clean up:

   ```bash
   rm -f bd38-check.mjs /tmp/bd38-cooldowns.json
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

**When the variable is unset** the probe reads the persisted cooldown store
(`probeFromCooldownStore`), so capacity still reflects provider limits learned
from earlier 429s and survives orchestrator restarts. The probe re-reads that
file first (`ModelCooldownStore.refresh`), because every process — including
each fleet member — owns its own store and loads the file only once at creation;
without the re-read a cooldown another member just wrote stays invisible until
the next orchestrator restart. The merge orders per key by *when the window was
marked* (`lastMarkedAt`), never by how long it is, so the newest observation
wins in both directions; a `lastMarkedAt` tie keeps the longer window, ladder
ties keep the higher count, and expired entries are pruned. Entries written
before that field existed — including entries a fleet member still running an
older build writes *right now* — carry no stamp, and stamp absence is not
evidence of age: when only one side of a merge is stamped, the merge falls back
to the tie ordering (longer `until`, then higher escalation count) instead of
treating the unstamped window as old. It is a no-op for an in-memory store and
never throws on a missing, corrupt, or unreadable file.
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

Before the first attempt of every `spawnAgentWithFallback` call, the harness
refreshes the cached capacity signal (TTL permitting) and then:

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
and keep their original slot in the attempt trail; the capacity cache is the
mechanism that pre-empts the *first* attempt.

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
  not. The entry expires so a provider rollback recovers without editing
  `~/.pi/agent/model-cooldowns.json`.
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
`~/.pi/agent/model-cooldowns.json` got `until = now + 15min`, and a **weekly**
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
- **Cross-process cooldown visibility.** `probeFromCooldownStore` calls the new
  `ModelCooldownStore.refresh()` before reading `providerEntries()`, so a
  cooldown another fleet member persisted is visible on the next capacity probe
  instead of after an orchestrator restart. `refresh()` and the lock-protected
  `persist()` apply the *same* ordering rule per key — newest `lastMarkedAt`
  wins, never the longer `until` — so neither direction can shorten a live
  escalated window from a stale file (nor lengthen it back from an old guess),
  and a fresh shorter hint from another writer is respected. A side without a
  stamp (a pre-mark-time file, or a member on an older build) is not assumed
  old: the merge then falls back to the safer window. Ties keep the longer
  window; escalation ladders merge by event time, keeping the higher count on a
  tie. Missing, corrupt, or unreadable file → no throw; in-memory store →
  no-op. A disk error never fails a spawn.

Named tests: `src/__tests__/quota-failure.test.ts` →
`parses the reset hint out of the live GoUsageLimitError body`,
`uses the long provider window for an unhinted GoUsageLimitError body`,
`lets a parsed hint win over the long provider window`; `src/__tests__/model-cooldown.test.ts`
→ `doubles an unhinted provider window that is still cooling`, `clamps the escalated window at the hard ceiling`,
`treats a hinted reset as authoritative and clears the ladder`,
`loads a version-1 file written before escalation existed`,
`keeps one complete mark per key, preferring the longer window on a tie`,
`keeps the higher ladder count on a mark-time tie in both directions`;
`src/__tests__/capacity-cache.test.ts` →
`sees a cooldown written by another store instance sharing the same file`; and
`src/__tests__/spawn-with-fallback.test.ts` →
`cools the provider for hours, so 15 minutes later it is still skipped`.

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
`quotaFailures` mean model-level failures (auth, transient, unavailable,
"other") where the class routing, not capacity, is the lever. A fallback trail
showing `(unavailable)` means a candidate id is retired at that endpoint — swap
it in `MODEL_CLASS_SPECS` rather than waiting for the cooldown.

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
  orderCandidatesByCapacity,
  parseCapacityWindows,
  probeFromCooldownStore,
  resolveQuotaCooldown,
} from "belayd-agent-harness";

// Capacity windows are plain data, so parsing and ordering are testable alone.
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
// The probe itself re-reads the shared cooldown file, so an explicit
// cooldownStore.refresh() is only needed when reading the store directly.
cooldownStore.refresh(); // merge other processes' cooldowns; no-op in-memory
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
`setRunTelemetry`, `readRunManifest`, `listRuns`, `RunTelemetryTotals`.

## Known limits

- **Capacity is only as fresh as the last probe or 429.** A window can be
  stale by up to one TTL (5 minutes), and a provider that recovers inside a
  window is still avoided until the window expires or a probe replaces it.
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
