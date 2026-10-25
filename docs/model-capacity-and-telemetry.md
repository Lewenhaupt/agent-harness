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

   Expected: Vitest exits 0 with **110 test files / 2562 tests passed**. The
   bd-116 suites alone:

   ```bash
   pnpm vitest run src/__tests__/capacity-cache.test.ts \
     src/__tests__/model-telemetry.test.ts \
     src/__tests__/model-session-state.test.ts \
     src/__tests__/spawn-with-fallback.test.ts \
     src/__tests__/run-manifest.test.ts \
     src/__tests__/extension-model-telemetry.test.ts
   ```

   Expected: 6 files / 118 tests passed (30 capacity-cache, 21 model-telemetry,
   9 model-session-state, 30 spawn-with-fallback, 26 run-manifest, 2
   extension-model-telemetry).

   > Known flake unrelated to bd-116: `belayd-direnv-setup (unit) > sweeps a
   > matrix of direnv.toml shapes and validates each with real direnv` fails
   > intermittently (it shells out to the real `direnv` binary). Re-run the
   > suite before investigating.

2. Integration tests:

   ```bash
   pnpm test:integration
   ```

   Expected: 11 files / 90 tests passed.

3. Static checks and build:

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
     '{"providers":{"opencode-go":{"resetsInSeconds":3600}}}';
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

3. **Reorder.** With the default fixture body the fast-class scout candidates
   (`opencode-go/mimo-v2.6-flash` first) are reordered so `llmgateway/mimo-v2.6-flash`
   runs first. The reorder is deliberately silent — its point is to *not*
   spawn a doomed attempt — so the observable signal is an **absence**:

   - no `[belayd model fallback] ... (quota) ...` note on the phase result, and
   - no `-fallback-N` subagent session:

     ```bash
     pi --resume | grep 'belayd-bd-X'
     ```

     Expected: only base-named sessions such as
     `belayd-bd-X-sub-scout-<runId>` — no `...-fallback-1`.

4. **All-exhausted fast-fail.** Restart the fixture with every
   `PROVIDER_PREFERENCE` provider (`opencode-go`, `llmgateway`, `openrouter`)
   inside a reset window, and re-run the phase:

   ```bash
   kill %1 2>/dev/null
   CAPACITY_BODY='{"providers":{"opencode-go":{"resetsInSeconds":3600},"llmgateway":{"resetsInSeconds":3600},"openrouter":{"resetsInSeconds":3600}}}' \
     node /tmp/capacity-fixture.mjs &
   ```

   Expected: the phase fails immediately with no sub-agent spawn at all, and
   the result text ends with the capacity reason plus the per-candidate skip
   trail:

   ```text
   All candidate models are capacity-exhausted providers (opencode-go, llmgateway, openrouter); retry after reset. Candidates: opencode-go/mimo-v2.6-flash, llmgateway/mimo-v2.6-flash, openrouter/xiaomi/mimo-v2.6-flash, ...

   [belayd model fallback] opencode-go/mimo-v2.6-flash (provider opencode-go capacity-exhausted) → llmgateway/mimo-v2.6-flash (provider llmgateway capacity-exhausted) → openrouter/xiaomi/mimo-v2.6-flash (provider openrouter capacity-exhausted) → ...
   ```

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
from earlier 429s and survives orchestrator restarts. **When it is set but the
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
  from the 429 body when present, else the class default),
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
`opencode-go/mimo-v2.6-flash`.

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
    scout opencode-go/mimo-v2.6-flash: attempts=2 fallbacks=0 quota=0 noops=1 cost=$0.0140
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
  DEFAULT_CAPACITY_BODY_LIMIT_BYTES,
  DEFAULT_CAPACITY_PROBE_TIMEOUT_MS,
  DEFAULT_CAPACITY_TTL_MS,
  MAX_CAPACITY_WINDOWS,
  createCapacityCache,
  createEndpointCapacityProbe,
  createFallbackCapacityProbe,
  createModelCooldownStore,
  orderCandidatesByCapacity,
  parseCapacityWindows,
  probeFromCooldownStore,
} from "belayd-agent-harness";

// Capacity windows are plain data, so parsing and ordering are testable alone.
const cooldownStore = createModelCooldownStore();

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
