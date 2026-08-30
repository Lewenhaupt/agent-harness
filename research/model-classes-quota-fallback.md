# Model Classes & Quota-Fallback Routing for Subagents

**Task:** bd-16
**Status:** Spike complete — implemented + tested (research workflow; follow-up beads created)
**Date:** 2026-08-30

---

## 1. AC Mapping

| AC | Description | Covered In |
|---|---|---|
| #1 | Pi native retry/fallback capabilities documented with their limits | bd-16 description §2 |
| #2 | ≥1 ecosystem reference pattern captured | bd-16 description §3 (LiteLLM), plus pi-gateway research comment |
| #3 | Concrete integration approach recommended (process-level ModelClass + ordered candidates) | §3 below |
| #4 | Quota/credit/rate-limit error signatures enumerated | §2 below + `src/quota-failure.ts` |

DoD items (listed as "future implementation" in bd-16) are now implemented:

| DoD | Where |
|---|---|
| ModelClass type + registry (class → ordered candidates) | `src/model-classes.ts` |
| AgentDefinition references a class; bare strings stay backward-compatible | `candidatesForModel()` — bare strings resolved via `MODEL_TO_CLASS`; explicit field is a follow-up bead |
| Spawn-level loop retries ONLY on quota/credit (not quality-gate) | `src/spawn-with-fallback.ts` |
| Quota-vs-other classifier, unit-tested | `src/quota-failure.ts` + tests |
| Fresh session IDs per attempt + usage/cost aggregated | `spawn-with-fallback.ts` (`sessionNameFor`, `sumUsage`) |
| Configurable max fallback depth + per-model cooldown | `maxAttempts` option + `src/model-cooldown.ts` |
| Pure logic unit-tested; spawn fallback tested via mocked child_process | `src/__tests__/*` |
| pnpm test / typecheck / lint / build green | verified (see §7) |

## 2. Empirical Findings (prototype)

The single most important result: **a quota/credit failure does NOT surface as a
non-zero exit or stderr.** The original bd-16 assumption ("pi exits non-zero;
failure surfaces in exitCode / stderr") is **wrong**.

Live captures from `pi --mode json` (pi 0.83.0, 2026-08-30):

| Case | exit code | stderr | structured `message_end` |
|---|---|---|---|
| Success (`llmgateway/gpt-4o-mini`) | 0 | empty | `stopReason:"stop"`, non-empty content, usage > 0 |
| **Quota 429 (`opencode-go/mimo-v2.5`)** | **0** | empty | `stopReason:"error"`, `errorMessage:"429: {json}"`, content `[]`, usage all-zero |
| Unknown model (`bogus/nonexistent`) | 1 | `Error: Model "..." not found.` | none emitted |

Consequences for the classifier:

- The failure is **only** in `details.messages` — the assistant `message_end`
  event captured by `spawn.ts`. `errorMessage` is the authoritative signal.
- `errorMessage` carries the status as a **leading `"NNN:"` prefix** over the
  JSON body: `429: {"type":"GoUsageLimitError","message":"Weekly usage limit
  reached. Resets in 11hr 6min. ..."}`.
- The reset hint (`"Resets in 11hr 6min"`) is parseable for a precise cooldown.
- Exit code is useless for detection; a non-zero exit without any assistant
  error event instead signals a **startup/config** failure (unknown model, bad
  flag) — a distinct "other" category.

Quota/credit signatures enumerated (from live capture + pi-gateway detect.ts):

- **Capacity/quota**: HTTP 402, 429 (configurable per backend in pi-gateway).
- **Transient**: HTTP 408, 425, 500, 502, 503, 504, plus statusless network
  errors (`fetch failed`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`,
  `socket hang up`, `connection reset`, `service unavailable`).
- **Auth** (not fallback-able): 401, 403.

## 3. Design

Process-level routing, as recommended in bd-16 §4. Four new modules, all pure
where possible:

### `src/model-classes.ts`
- `ModelClass = "frontier" | "standard" | "fast"` — capability tiers.
- `MODEL_CLASS_SPECS` — per-class rationale + ordered bare model ids.
- `MODEL_TO_CLASS` — bare id → class (covers every `DEFAULT_AGENTS` model and
  workflow override).
- `PROVIDER_PREFERENCE = ["opencode-go", "llmgateway"]` — providers expanded
  per model id, so the **first failover hop is the same model id on the
  alternate provider** (identical behavior, different quota bucket).
- `resolveModelCandidates(class)` / `candidatesForModel(model)` — pure.

### `src/quota-failure.ts`
- `classifySpawnFailure(details) → FailureClassification` — pure, discriminated
  union `success | quota | transient | auth | other`.
- Reads the last assistant `message_end` (`stopReason:"error"`), extracts status
  from `errorStatus` or the `"NNN:"` prefix, classifies per the signature table.
- `parseQuotaResetSeconds()` parses `"Resets in Xd Yh Zm"` for cooldown.

### `src/model-cooldown.ts`
- `createModelCooldownStore(now)` — closure-held state (no module globals),
  `isCoolingDown` / `markCooldown` / `prune`. In-memory; file persistence is a
  follow-up bead.

### `src/spawn-with-fallback.ts`
- `spawnAgentWithFallback(options)` — loops candidates; on `quota`/`transient`
  cools the model and retries; on `auth`/`other`/`success` stops. Fresh session
  id per attempt (`-fallback-N`), usage aggregated, `maxAttempts` cap.
- Kill switch: `BELAYD_MODEL_FALLBACK=0` disables fallback.

### Integration (`extensions/index.ts`)
- Phase tools and quality-gate retries now call `spawnAgentWithFallback` with a
  shared `createModelCooldownStore()`.
- When a fallback occurs, a `[belayd model fallback] a (quota) → b (success)`
  note is appended to the result content.

## 4. Model Class Map

| Class | Bare ids (ordered) | Rationale |
|---|---|---|
| `frontier` | deepseek-v4-pro, glm-5.3, gpt-5.6-luna | Planner/implementer/doc-authoring — capability then cost |
| `standard` | glm-5.2, gpt-5.6-luna, deepseek-v4-pro | Review/test detail work |
| `fast` | mimo-v2.5, deepseek-v4-flash, glm-5.2 | Recon/proof — low latency + cost |

Expansion: each bare id × `[opencode-go, llmgateway]` → 6 candidates per class.

## 5. Live Verification

```
ATTEMPTS:
  opencode-go/mimo-v2.5 -> quota      (429: GoUsageLimitError)
  llmgateway/mimo-v2.5  -> success    ("pong", exit 0)
```

The harness transparently recovered from the live opencode-go weekly-limit 429
by falling back to the same model on llmgateway.

## 6. Limits / Follow-ups

- **Cooldown state is in-memory** — lost on orchestrator restart. Follow-up:
  persist to `~/.pi/agent/...` with atomic write + lockfile (harvest
  pi-gateway `state.ts`). → **bd-16.1**
- **`MODEL_TO_CLASS` is string-keyed** — an explicit `AgentDefinition.modelClass`
  field would make the mapping self-documenting. Follow-up. → **bd-16.2**
- **Mid-stream exhaustion** (quota after output began) is handled by re-spawning
  fresh from the task (classifier sees the final `stopReason:"error"`), but the
  partial work is lost and the residual behavior is untested. Observation only
  (no follow-up bead).
- `@pedro_klein/pi-gateway` was evaluated and **rejected as a dependency**
  (session-scoped, pre-output-only failover); its detect/state patterns were
  harvested instead. See bd-16 comments.

## 7. Verification Commands

```bash
pnpm test              # 308 passed
pnpm test:integration  # 11 passed
pnpm typecheck         # clean
pnpm build             # clean
pnpm lint              # NOTE: fails on pre-existing models.json formatting (unrelated, tracked generated file)
pnpm exec biome check src/ extensions/index.ts   # clean (all new code)
```
