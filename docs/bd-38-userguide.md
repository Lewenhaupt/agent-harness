# Long provider cooldowns, escalation, and cross-process freshness for usage limits (bd-38)

Before bd-38 an unhinted provider usage-limit body — opencode-go's
`429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}` — got the
flat 15-minute quota default. A weekly bucket was therefore re-probed every
quarter hour, and every probe spawned a real `-fallback-N` session; three fleet
members each paid for one. Three things changed:

1. **Long window for unhinted provider usage limits.** A `quota` failure whose
   body names a provider subscription limit (`GoUsageLimitError`,
   `usage limit exceeded`/`reached`/`hit`) and carries **no** `Resets in ...`
   hint now gets `DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS` (6 h) instead of
   15 minutes. A parsed reset hint always wins.
2. **Escalation on repeated unhinted 429s.** A repeated unhinted quota failure on
   a provider whose ladder is still remembered doubles the window
   (`COOLDOWN_ESCALATION_FACTOR` = 2) up to `MAX_ESCALATED_COOLDOWN_SECONDS`
   (24 h) instead of re-guessing 6 h forever. A hinted reset is authoritative and
   clears the ladder.
3. **Cross-process freshness.** `probeFromCooldownStore` calls
   `ModelCooldownStore.refresh()` before reading, so a 429 recorded by another
   fleet member's orchestrator is visible on the next capacity probe instead of
   after that member restarts.

Full narrative (why the classification is shaped this way, the merge rules, the
capacity cache): `docs/model-capacity-and-telemetry.md` →
*Unhinted provider usage limits and cooldown escalation (bd-38)* and
*Manual recipe: the long provider window, its ladder, and cross-process
visibility (bd-38)*.

## How to Verify

Run everything from the repository root, on this branch.

### 1. Unit suites — one command per behaviour

```bash
pnpm test src/__tests__/quota-failure.test.ts
```

Expected: 50 tests pass. Names to look for:

- `uses the long provider window for an unhinted GoUsageLimitError body` — the
  success criterion for behaviour 1: `cooldownSeconds` is 21600 and
  `cooldownHinted` is `false`.
- `parses the reset hint out of the live GoUsageLimitError body` and
  `lets a parsed hint win over the long provider window` — hint precedence, in
  both directions (7 h 57 m beats 6 h; 20 min beats 6 h).
- `returns the long provider window for unhinted provider usage-limit wording`
  and `falls back to the generic default without a hint or provider wording` —
  the `resolveQuotaCooldown` three-way shape
  `{ cooldownSeconds, cooldownHinted }`.
- `does not read the long window out of a body with no quota wording at all` —
  a `400: bad request` body stays on the 15-minute default.

```bash
pnpm test src/__tests__/model-cooldown.test.ts
```

Expected: 35 tests pass. Names to look for:

- `doubles an unhinted provider window that is still cooling` — behaviour 2's
  ladder: 6 h then 12 h, `escalations` 1 then 2.
- `escalates even after the previous window expired inside the memory horizon`,
  `clamps the escalated window at the hard ceiling` (six marks land on exactly
  24 h, never beyond), `round-trips the escalation count through the file`.
- `treats a hinted reset as authoritative and clears the ladder` and
  `persists a hinted reset that is shorter than the escalated window` — a hint
  overrides and resets, it does not get out-voted.
- `keeps one complete mark per key, preferring the longer window on a tie`,
  `keeps the higher ladder count on a mark-time tie in both directions`,
  `keeps a live longer window over a stale unstamped one`, `adopts a longer
  unstamped window written by an older-build member` — the mark-time merge rules
  and the tie order that replaces ordering by `until`.
- `loads a version-1 file written before escalation existed`,
  `skips only the malformed entries of a hand-edited file`,
  `never throws on a missing, corrupt, or unreadable file` — tolerance of older
  and damaged files.

```bash
pnpm test src/__tests__/capacity-cache.test.ts
```

Expected: 33 tests pass. Name to look for:
`sees a cooldown written by another store instance sharing the same file` — two
stores over one file, i.e. the fleet case behind behaviour 3 — plus
`never throws and yields no windows for a missing or corrupt file` through
`probeFromCooldownStore`.

```bash
pnpm test src/__tests__/spawn-with-fallback.test.ts
```

Expected: 33 tests pass. Names to look for:

- `cools the provider for hours, so 15 minutes later it is still skipped` — the
  end-to-end proof: a real `GoUsageLimitError` `SpawnDetails` produces a
  multi-hour provider window, and the *second* spawn has a `skippedProvider`
  row with only one spawn call (no `-fallback-N` session minted).
- `escalates the provider window on a repeated unhinted 429` — 6 h → 12 h →
  hinted 20 min, all through `spawnAgentWithFallback`.
- `does not apply the long provider window on a model-scoped failure` — a `503`
  that merely mentions the usage limit stays `transient` (5 min, model scope,
  no `escalations`), so a provider's healthy sibling models are not hidden.

Everything together (four files / 151 tests):

```bash
pnpm vitest run src/__tests__/quota-failure.test.ts \
  src/__tests__/model-cooldown.test.ts \
  src/__tests__/capacity-cache.test.ts \
  src/__tests__/spawn-with-fallback.test.ts
```

### 2. Static checks

```bash
pnpm typecheck && pnpm lint && pnpm build
```

Expected: all three exit 0. `pnpm build` also produces the `dist/src/*.js` files
the manual check below imports.

### 3. Manual end-to-end: watch the window in a real cooldown file

These commands drive the real classifier (`classifySpawnFailure`) and the real
persisted store, over a scratch file, so you can read the state back with `jq`.
Each command is a separate process — like a separate fleet member or a later
workflow run.

The body is the one opencode-go actually returned:

```text
429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}
```

```bash
rm -f /tmp/bd38-cooldowns.json

mark_unhinted() {
  BELAYD_MODEL_COOLDOWN_FILE=/tmp/bd38-cooldowns.json node --input-type=module -e '
import { classifySpawnFailure } from "./dist/src/quota-failure.js";
import { createModelCooldownStore, defaultModelCooldownPath } from "./dist/src/model-cooldown.js";
const errorMessage = String.raw`429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}`;
const c = classifySpawnFailure({
  messages: [{ role: "assistant", content: [], model: "opencode-go/mimo-v2.6-flash", stopReason: "error", errorMessage }],
  usage: {},
  exitCode: 0,
});
const store = createModelCooldownStore({ filePath: defaultModelCooldownPath() });
store.markProviderCooldown("opencode-go", c.cooldownSeconds, c.reason, { hinted: c.cooldownHinted === true });
const entry = store.providerEntries().get("opencode-go");
console.log(`requested ${c.cooldownSeconds}s (hinted=${c.cooldownHinted}) -> until in ${((entry.until - Date.now()) / 3_600_000).toFixed(2)}h, escalations=${entry.escalations ?? 0}`);
'
}
```

Run it four times:

```bash
mark_unhinted; mark_unhinted; mark_unhinted; mark_unhinted
```

Expected:

```text
requested 21600s (hinted=false) -> until in 6.00h, escalations=1
requested 21600s (hinted=false) -> until in 12.00h, escalations=2
requested 21600s (hinted=false) -> until in 24.00h, escalations=3
requested 21600s (hinted=false) -> until in 24.00h, escalations=4
```

That is behaviour 1 (6 h, not 15 min) and behaviour 2 (doubling, then clamped at
24 h) in one run. Now inspect the file:

```bash
jq '{providers, escalations}' /tmp/bd38-cooldowns.json
```

Expected shape — this is the whole `model-cooldowns.json` format
(default `~/.pi/agent/model-cooldowns.json`, override with
`BELAYD_MODEL_COOLDOWN_FILE`), with every field documented:

```jsonc
{
  "version": 1,                      // optional on read; always rewritten as 1
  "providers": {                     // optional; provider-scoped windows (quota/429)
    "opencode-go": {
      "until": 1793192473942,        // required, epoch ms: the window end
      "reason": "Quota/credit/rate limit (HTTP 429).",  // required, display only
      "escalations": 3,              // optional: absent for hinted and model-scoped windows
      "lastMarkedAt": 1793106073942  // optional: when this window was marked
    }
  },
  "models": {},                      // optional; endpoint-scoped windows (transient, unavailable)
  "escalations": {                   // optional; the ladder, kept across window expiry
    "opencode-go": { "count": 3, "lastMarkedAt": 1793106073942 }
  }
}
```

- `version`, `escalations` (both maps), `escalations` (entry) and `lastMarkedAt`
  are **optional**. A file from an older build — no version, no ladder, no
  stamps — loads unchanged; a missing stamp only means the merge cannot order
  that entry against this process's and falls back to the safer window (longer
  `until`, then higher count). A malformed single entry is skipped while its
  healthy siblings load; a corrupt file reads as empty and is rewritten on the
  next mark. Unknown keys are carried through a read-modify-write.
- `until <= now` means expired; expired entries are pruned on load, `refresh()`,
  `persist()`. The ladder outlives the window for
  `COOLDOWN_ESCALATION_MEMORY_MS` (7 days) after its last mark.
- A hinted reset is recorded as `count: 0` in the ladder map — "cleared at this
  time" still needs a timestamp to win the merge.

Next, the hinted body overrides both the window and the ladder
(`Weekly usage limit reached. Resets in 20min.`):

```bash
BELAYD_MODEL_COOLDOWN_FILE=/tmp/bd38-cooldowns.json node --input-type=module -e '
import { classifySpawnFailure } from "./dist/src/quota-failure.js";
import { createModelCooldownStore, defaultModelCooldownPath } from "./dist/src/model-cooldown.js";
const errorMessage = String.raw`429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 20min."}`;
const c = classifySpawnFailure({
  messages: [{ role: "assistant", content: [], model: "opencode-go/mimo-v2.6-flash", stopReason: "error", errorMessage }],
  usage: {},
  exitCode: 0,
});
const store = createModelCooldownStore({ filePath: defaultModelCooldownPath() });
store.markProviderCooldown("opencode-go", c.cooldownSeconds, c.reason, { hinted: c.cooldownHinted === true });
const entry = store.providerEntries().get("opencode-go");
console.log(`requested ${c.cooldownSeconds}s (hinted=${c.cooldownHinted}) -> until in ${((entry.until - Date.now()) / 60_000).toFixed(2)}min, escalations=${entry.escalations ?? 0}`);
'
jq -c '.escalations' /tmp/bd38-cooldowns.json
```

Expected the 24 h escalated window to be replaced by the hinted 20 minutes, and
the ladder to be cleared:

```text
requested 1200s (hinted=true) -> until in 20.00min, escalations=0
{"opencode-go":{"count":0,"lastMarkedAt":1793106077939}}
```

Finally the fleet case (behaviour 3): a store created while the file was empty
must see a cooldown another store wrote afterwards, through the probe:

```bash
rm -f /tmp/bd38-fleet.json
BELAYD_MODEL_COOLDOWN_FILE=/tmp/bd38-fleet.json node --input-type=module -e '
import { createModelCooldownStore, defaultModelCooldownPath } from "./dist/src/model-cooldown.js";
import { probeFromCooldownStore } from "./dist/src/capacity-cache.js";
const filePath = defaultModelCooldownPath();
const member = createModelCooldownStore({ filePath });   // fleet member B, started when the file was empty
const sibling = createModelCooldownStore({ filePath });  // fleet member A
sibling.markProviderCooldown("opencode-go", 21_600, "quota");
console.log("B provider entries before its probe:", member.providerEntries().size);
console.log("B probe windows:", (await probeFromCooldownStore(member)()).windows);
console.log("B provider entries after its probe:", member.providerEntries().size);
'
```

Expected:

```text
B provider entries before its probe: 0
B probe windows: [
  { provider: 'opencode-go', resetAt: 1793127681900, reason: 'quota' }
]
B provider entries after its probe: 1
```

Clean up:

```bash
rm -f /tmp/bd38-cooldowns.json /tmp/bd38-fleet.json
```

The one thing this recipe cannot do is make a live provider return a 429 on
demand; the spawn-level consequence (a `skippedProvider` row and no second
spawn) is therefore proven by
`spawn-with-fallback.test.ts > cools the provider for hours, so 15 minutes later
it is still skipped`, not by hand.

### 4. What you should see in the logs

The observable difference is the phase result's fallback trail
(`[belayd model fallback] ...`, emitted only when a spawn produced more than one
attempt entry) and the sub-agent session names.

**Before bd-38** — the 15-minute window always expired before a weekly bucket
reset, so each phase re-probed and paid for a session:

```text
[belayd model fallback] opencode-go/mimo-v2.6-flash (quota) → llmgateway/mimo-v2.6-flash (success)
```

recurring roughly every 15 minutes, each recurrence minting a fresh
`belayd-<task>-sub-<phase>-<runId>-fallback-1` session and another
`429: {"type":"GoUsageLimitError", ...}` line in the transcript.

**After bd-38** — one 429, a multi-hour provider window, then skips that spawn
nothing:

```text
[belayd model fallback] opencode-go/mimo-v2.6-flash (provider opencode-go exhausted) → llmgateway/mimo-v2.6-flash (success)
```

Check:

- Later phases show `(provider opencode-go exhausted)` (cooldown-store skip) or
  `(provider opencode-go capacity-exhausted)` (pre-dispatch cache) for the first
  candidate. Confirm no `-fallback-N` session was minted:
  `pi --resume | grep 'belayd-<task-id>'` should list only base-named sessions.
- No second `429 ... Go usage limit exceeded` for that provider inside the
  window. A repeat means the window expired (the ladder now doubles it) or the
  body carried a shorter `Resets in ...` hint, which is authoritative by design.
- `.belayd/telemetry.json` shows `quotaFailures` stable across later phases while
  `attempts` keeps rising: the failure happened once, later attempts were skips
  and never entered the counts.

## How to Use

All symbols below are re-exported from `src/index.ts`.

### Resolve a quota failure's cooldown

```typescript
import { resolveQuotaCooldown } from "belayd-agent-harness";

resolveQuotaCooldown('429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}');
// { cooldownSeconds: 21600, cooldownHinted: false }  the long provider window

resolveQuotaCooldown("Weekly usage limit reached. Resets in 7hr 57min.");
// { cooldownSeconds: 28620, cooldownHinted: true }   a parsed hint wins

resolveQuotaCooldown("400: bad request");
// { cooldownSeconds: 900, cooldownHinted: false }    the 15-minute default
```

`resolveQuotaCooldown(errorMessage)` is the single resolver for all three quota
paths (status 402/429, statusless wording, non-zero-exit stderr). `cooldownHinted`
tells the store whether to *replace* or *escalate* the window, so no caller has
to re-parse the body. `classifySpawnFailure` already spreads it into
`FailureClassification`, which is why the fallback loop only has to forward the
flag (see `recordCooldown` in `src/spawn-with-fallback.ts`).

| Constant | Value | Meaning |
| --- | --- | --- |
| `DEFAULT_PROVIDER_USAGE_LIMIT_COOLDOWN_SECONDS` | `21600` (6 h) | unhinted provider subscription limit |
| `DEFAULT_QUOTA_COOLDOWN_SECONDS` | `900` (15 min) | generic quota/rate limit, no hint |
| `COOLDOWN_ESCALATION_FACTOR` | `2` | each repeated unhinted mark doubles |
| `MAX_ESCALATED_COOLDOWN_SECONDS` | `86400` (24 h) | escalation ceiling |
| `COOLDOWN_ESCALATION_MEMORY_MS` | `604800000` (7 days) | ladder retention after its last mark |

### Mark a provider cooldown (hinted vs escalating)

```typescript
import { createModelCooldownStore, defaultModelCooldownPath } from "belayd-agent-harness";

// Persistent store shared by every spawn in one orchestrator session.
const store = createModelCooldownStore({ filePath: defaultModelCooldownPath() });

// Unhinted mark: a harness guess, so it escalates a provider already cooling.
store.markProviderCooldown("opencode-go", 21_600, "GoUsageLimitError");
store.markProviderCooldown("opencode-go", 21_600, "GoUsageLimitError"); // 12 h
store.markProviderCooldown("opencode-go", 21_600, "GoUsageLimitError"); // 24 h (ceiling)

// Hinted mark: authoritative. Sets exactly this window and clears the ladder.
store.markProviderCooldown("opencode-go", 1_200, "Resets in 20min", { hinted: true });
```

- `markProviderCooldown(provider, seconds, reason, { hinted, nowMs })` — `hinted`
  distinguishes a provider-supplied reset from a guess; `nowMs` is the clock
  seam (used by tests).
- `markCooldown(model, seconds, reason, { nowMs })` stays endpoint-scoped and
  **never** escalates: a transient fault or a retired model id must not hide the
  provider's healthy siblings. `hinted` is ignored there.
- After marking, read state with `cooldownScope(model, nowMs)` (`"provider"` /
  `"model"` / `undefined`), `providerEntries()`, or `entries()`.

### Make another process's cooldown visible

```typescript
import { createCapacityCache, createFallbackCapacityProbe, probeFromCooldownStore } from "belayd-agent-harness";

const store = createModelCooldownStore({ filePath: defaultModelCooldownPath() });

// probeFromCooldownStore refreshes the file itself — this is what makes a fleet
// member's freshly written 429 visible on the next capacity probe.
const capacity = createCapacityCache({ probe: createFallbackCapacityProbe(probeFromCooldownStore(store)) });

await capacity.refreshIfStale();                 // never rejects
capacity.isModelExhausted("opencode-go/mimo-v2.6-flash"); // true after a 429 elsewhere

// Reading the store directly (not through the probe) needs an explicit refresh;
// it is a no-op for an in-memory store and never throws.
store.refresh();
store.providerEntries().get("opencode-go"); // { until, reason, escalations, lastMarkedAt }
```

`refresh()` and the lock-protected `persist()` share one ordering rule per key:
the **newer `lastMarkedAt`** wins in both directions, never the longer `until`. If
exactly one side carries a stamp — a pre-bd-38 file, or a fleet member still on an
older build — the stamps are incomparable and the merge falls back to the tie
ordering (longer `until`, then higher escalation count). A hinted reset from a
later mark therefore survives a stale longer guess, and a stale file cannot
shorten a live escalated window.

### Point the store at a different file

`BELAYD_MODEL_COOLDOWN_FILE` overrides the default
`~/.pi/agent/model-cooldowns.json`; it is read by
`defaultModelCooldownPath()` (exported), so set it before starting `pi` or before
constructing the store:

```bash
BELAYD_MODEL_COOLDOWN_FILE=/tmp/scratch-cooldowns.json pi
```

### Report a discrepancy

Only these three behaviours changed. `transient` (5 min), `unavailable` (6 h,
endpoint-scoped), and `auth` (no cooldown, stops the fallback loop)
classifications are untouched: a `503` carrying `GoUsageLimitError` wording stays
`transient`, and a generic unhinted 402/429 body stays on the 15-minute default.
If you observe otherwise, the classification rules live in
`src/quota-failure.ts` (`CLASSIFICATION_RULES`, `resolveQuotaCooldown`) and the
mark/escalate decision in `recordCooldown` in `src/spawn-with-fallback.ts`.
