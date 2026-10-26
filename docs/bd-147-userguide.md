# Per-model provider preference: llmgateway by default, opencode-go reserved for `deepseek-v4.1-flash` (bd-147)

Before bd-147, provider order was one global list (`opencode-go` first), so
every class primary and every fallback hop billed against the opencode-go
subscription bucket. bd-147 makes the order **per model**: `llmgateway`
(per-token billing) is the default first hop for every model, and the
opencode-go subscription bucket is reserved for the single model whose
subscription is cheaper than per-token — `deepseek-v4.1-flash`.

What that means for a workflow run, without any configuration change:

| `modelClass` | Class primary (first-choice model) |
| --- | --- |
| `frontier` | `opencode-go/deepseek-v4.1-flash` |
| `standard` | `llmgateway/glm-5.3-flash` |
| `fast` | `llmgateway/mimo-v2.6-flash` |

| Agent | Class | First-choice model |
| --- | --- | --- |
| `belayd-planner` | `frontier` | `opencode-go/deepseek-v4.1-flash` |
| `belayd-implementer` | `frontier` | `opencode-go/deepseek-v4.1-flash` |
| `belayd-tester` | `frontier` | `opencode-go/deepseek-v4.1-flash` |
| `belayd-userguide` | `frontier` | `opencode-go/deepseek-v4.1-flash` |
| `belayd-proof-generator` | `frontier` | `opencode-go/deepseek-v4.1-flash` |
| `belayd-documenter` | `frontier` | `opencode-go/deepseek-v4.1-flash` |
| `belayd-reviewer` | `standard` | `llmgateway/glm-5.3-flash` |
| `belayd-scout` | `fast` | `llmgateway/mimo-v2.6-flash` |
| `belayd-committer` | `fast` | `llmgateway/mimo-v2.6-flash` |
| `belayd-proof-verifier` | `fast` | `llmgateway/mimo-v2.6-flash` |

The only behaviour change is for the non-frontier agents: planner, implementer,
tester, userguide, proof-generator and documenter stay on
`opencode-go/deepseek-v4.1-flash` (unchanged), while reviewer, scout,
committer and proof-verifier moved off the subscription onto `llmgateway`.

Source of truth is `src/model-classes.ts` (`DEFAULT_PROVIDER_PREFERENCE`,
`MODEL_PROVIDER_PREFERENCE`, `MODEL_CLASS_SPECS`) plus the workflow pins in
`src/workflow-registry.ts`. `docs/agent-model-class.md` documents the full
fallback contract; this guide covers only verification and use of the bd-147
change.

## How to Verify

Run everything from the repository root. Every command below was executed in
this worktree; the outputs shown are the real ones.

1. Full unit suite:

   ```bash
   pnpm test
   ```

   Expected tail:

   ```text
    Test Files  114 passed (114)
         Tests  2650 passed (2650)
   ```

2. Targeted suite for the routing rules and the workflow pins:

   ```bash
   pnpm test src/__tests__/model-classes.test.ts src/__tests__/workflow-registry.test.ts
   ```

   Expected: `2 passed (2)` files, `98 passed (98)` tests (43 in
   `model-classes.test.ts`, 55 in `workflow-registry.test.ts`). The cases that
   would fail if the preference regressed are:

   - `keeps the standard class model-major with deepseek's override last` —
     literal `resolveModelCandidates("standard")` order: the class where the
     flipped default and the single override meet.
   - `emits each class model's providers contiguously, in its own order` —
     structural same-id-adjacency assertion over all three classes.
   - `keeps every override a permutation of the default provider set` and
     `keys every provider override to a model that has a class` — the
     guardrails for adding an exception (see "Add a new provider exception").
   - `pins the override models to their preferred provider` — exact pins for
     `research`/`documentation`/`hotfix`, plus every `agentOverrides[*].model`
     provider equals `providerPreferenceFor(model)[0]`.

3. Print the resolved primaries and the effective preference order. The
   one-liner imports the compiled library, so build first:

   ```bash
   pnpm build
   node --input-type=module -e '
   const { primaryModelOf, providerPreferenceFor, resolveModelCandidates } =
     await import("./dist/src/model-classes.js");
   for (const c of ["frontier", "standard", "fast"]) console.log(c, "→", primaryModelOf(c));
   console.log("glm-5.3-flash →", providerPreferenceFor("glm-5.3-flash").join(" > "));
   console.log("deepseek-v4.1-flash →", providerPreferenceFor("deepseek-v4.1-flash").join(" > "));
   console.log(resolveModelCandidates("standard"));
   '
   ```

   Expected:

   ```text
   frontier → opencode-go/deepseek-v4.1-flash
   standard → llmgateway/glm-5.3-flash
   fast → llmgateway/mimo-v2.6-flash
   glm-5.3-flash → llmgateway > opencode-go > openrouter
   deepseek-v4.1-flash → opencode-go > llmgateway > openrouter
   [
     'llmgateway/glm-5.3-flash',
     'opencode-go/glm-5.3-flash',
     'openrouter/z-ai/glm-5.3-flash',
     'llmgateway/gpt-5.6-luna',
     'opencode-go/gpt-5.6-luna',
     'openrouter/openai/gpt-5.6-luna',
     'opencode-go/deepseek-v4.1-flash',
     'llmgateway/deepseek-v4.1-flash',
     'openrouter/deepseek/deepseek-v4.1-flash'
   ]
   ```

   `providerPreferenceFor` canonicalizes provider-qualified ids, so
   `providerPreferenceFor("openrouter/deepseek/deepseek-v4.1-flash")` returns
   the same `opencode-go > llmgateway > openrouter` order as the bare id.

4. Print the model each agent actually spawns (`resolveModelSpec` on the
   agent's declaration):

   ```bash
   node --input-type=module -e '
   const { DEFAULT_AGENTS, PROOF_VERIFIER_AGENT, resolveModelSpec } =
     await import("./dist/src/index.js");
   for (const a of [...DEFAULT_AGENTS, PROOF_VERIFIER_AGENT]) {
     const spec = a.model ? { model: a.model } : { modelClass: a.modelClass };
     const r = resolveModelSpec(spec);
     console.log(a.name.padEnd(24), (r.modelClass ?? "-").padEnd(9), r.model);
   }
   '
   ```

   Expected:

   ```text
   belayd-scout             fast      llmgateway/mimo-v2.6-flash
   belayd-planner           frontier  opencode-go/deepseek-v4.1-flash
   belayd-implementer       frontier  opencode-go/deepseek-v4.1-flash
   belayd-reviewer          standard  llmgateway/glm-5.3-flash
   belayd-tester            frontier  opencode-go/deepseek-v4.1-flash
   belayd-userguide         frontier  opencode-go/deepseek-v4.1-flash
   belayd-proof-generator   frontier  opencode-go/deepseek-v4.1-flash
   belayd-documenter        frontier  opencode-go/deepseek-v4.1-flash
   belayd-committer         fast      llmgateway/mimo-v2.6-flash
   belayd-proof-verifier    fast      llmgateway/mimo-v2.6-flash
   ```

5. Check the workflow override pins agree with each model's own preference:

   ```bash
   node --input-type=module -e '
   const { WORKFLOW_REGISTRY, providerPreferenceFor } = await import("./dist/src/index.js");
   for (const config of Object.values(WORKFLOW_REGISTRY))
     for (const [phase, o] of Object.entries(config.agentOverrides ?? {}))
       if (o.model)
         console.log(`${config.name}/${phase}`, o.model, "preferred:", providerPreferenceFor(o.model)[0]);
   '
   ```

   Expected (one line per pin; no pin keeps a stale `opencode-go/` prefix):

   ```text
   research/plan llmgateway/glm-5.3 preferred: llmgateway
   documentation/implement llmgateway/deepseek-v4-flash preferred: llmgateway
   hotfix/implement llmgateway/deepseek-v4-flash preferred: llmgateway
   ```

6. End-to-end check on a real run: start a feature workflow
   (`/belayd bd-X feature`, or `/belayd bd-X feature --no-worktree`) and read
   the summary log line printed at workflow completion:

   ```bash
   cat .belayd/telemetry.json
   ```

   Expected: per-`(phase, model)` rows where `scout`, `commit` and
   `proof-verifier` rows carry a `llmgateway/…` model, `reviewer` carries
   `llmgateway/glm-5.3-flash`, and the frontier phases still carry
   `opencode-go/deepseek-v4.1-flash` unless a fallback happened. The log
   summary line reads e.g.
   `scout llmgateway/mimo-v2.6-flash: …`. Field-by-field meanings are in
   `docs/model-capacity-and-telemetry.md`.

## How to Use

### Nothing to configure

The new order is the built-in default. No environment variable, profile, or
agent declaration has to change: an agent that declares `modelClass: "standard"`
resolves to `llmgateway/glm-5.3-flash` because `providerPreferenceFor` returns
the llmgateway-first order for that model id.

### Pin a model explicitly (the requested model always comes first)

An explicit pin is a full `provider/model` id. The pinned model is the first
candidate regardless of the preference order; only the failover hops follow the
model's own preference. `candidatesForModel` shows this directly:

```bash
node --input-type=module -e '
const { candidatesForModel } = await import("./dist/src/model-classes.js");
console.log(candidatesForModel("opencode-go/glm-5.3-flash").slice(0, 3));
'
```

Expected — the requested model first, then the same model on its next bucket:

```text
[
  'opencode-go/glm-5.3-flash',
  'llmgateway/glm-5.3-flash',
  'openrouter/z-ai/glm-5.3-flash'
]
```

The same applies in library code and in agent definitions:

```typescript
import { candidatesForModel, resolveModelSpec } from "belayd-agent-harness";

// Explicit pin on the subscription bucket: the pin wins, opencode-go is first.
candidatesForModel("opencode-go/glm-5.3-flash")[0];
// "opencode-go/glm-5.3-flash"

// The pin still derives its class, so fallback stays inside `standard`.
resolveModelSpec({ model: "llmgateway/glm-5.3-flash" });
// { model: "llmgateway/glm-5.3-flash", modelClass: "standard" }

// Unknown models get no class-derived fallback: attempted exactly as written.
resolveModelSpec({ model: "vendor/x" });
// { model: "vendor/x", modelClass: undefined }
```

To pin a workflow phase, use a workflow override (`src/workflow-registry.ts`,
or a `WorkflowSubTypeConfig["agentOverrides"]` value in the library) — for
example the `documentation` and `hotfix` workflows pin `implement` to
`llmgateway/deepseek-v4-flash`, and `research` pins `plan` to
`llmgateway/glm-5.3`. If the pin and the model's preferred provider disagree,
that disagreement is deliberate and belongs in the pin; if it is an accident,
step 5 of the verification checks above catches it (`pins the override models
to their preferred provider`).

### Add a new provider exception (per-model, not per class)

Model this on the single existing exception, `deepseek-v4.1-flash`, whose
`MODEL_PROVIDER_PREFERENCE` entry is `["opencode-go", "llmgateway", "openrouter"]`.
All edits are in `src/model-classes.ts`.

1. Make sure the model is in a class spec and in `MODEL_TO_CLASS` — the
   `keys every provider override to a model that has a class` test fails an
   override keyed by a model with no class.
2. Add the override to `MODEL_PROVIDER_PREFERENCE`:

   ```typescript
   export const MODEL_PROVIDER_PREFERENCE: Readonly<Record<string, readonly string[]>> = {
     [SUBSCRIPTION_PREFERRED_MODEL]: ["opencode-go", "llmgateway", "openrouter"],
     "my-model": ["some-provider", "llmgateway", "opencode-go", "openrouter"],
   };
   ```

   The value must be a **permutation** of `DEFAULT_PROVIDER_PREFERENCE`: same
   provider set, reordered. The `keeps every override a permutation of the
   default provider set` test fails an override that adds or drops a provider,
   because a dropped provider silently removes a failover bucket for that model.
   Note the current permutation is over the three-provider default; adding a
   fourth provider also means adding it to `DEFAULT_PROVIDER_PREFERENCE` (and to
   `PROVIDER_MODEL_IDS` if that provider needs vendor-qualified ids).
3. If the exception is "the subscription-cheap model", reuse the
   `SUBSCRIPTION_PREFERRED_MODEL` constant rather than repeating the literal: it
   is the single name shared by the class spec, `MODEL_TO_CLASS` and the
   override, so the exemption cannot drift away from the model it exempts.
4. If that provider serves the model under a different id (as OpenRouter does
   with vendor-qualified ids), add the mapping to `PROVIDER_MODEL_IDS` so
   `canonicalModelId` groups the qualified spelling with its canonical id —
   otherwise class lookup and same-model fallback partitioning miss it.
5. If the model is a `deepseek*` id, document it in
   `docs/deepseek-provider-notes.md`; `src/__tests__/model-classes.test.ts`
   asserts every DeepSeek id in the class specs appears in that table.
6. Re-run `pnpm test` (or step 2 above), then step 3 to confirm the new
   preference order.

`PROVIDER_PREFERENCE` still exists as a deprecated re-export of the default
order — use `DEFAULT_PROVIDER_PREFERENCE`, or `providerPreferenceFor(modelId)`
for a specific model.

### Operational consequences to expect

- **A provider-scoped 429/402 overflows onto the other bucket.** Cooldowns
  (`src/model-cooldown.ts`) and the capacity cache (`src/capacity-cache.ts`)
  are keyed per provider, not per model. A llmgateway quota failure therefore
  makes `opencode-go` the first *available* hop for **every** non-DeepSeek
  phase, spending subscription capacity on glm/mimo work; conversely an
  opencode-go quota failure moves `deepseek-v4.1-flash` work onto llmgateway
  per-token. This overflow is accepted, not a bug — see "Consequences of the
  per-model preference" in `docs/agent-model-class.md`.
- **Cost attribution moves onto the meter.** `.belayd/telemetry.json` rows are
  keyed by `(phase, model)` with the provider prefix included, so the shift
  from `opencode-go/glm-5.3-flash` to `llmgateway/glm-5.3-flash` is visible as
  new rows (and new `cost`) rather than as growth on the existing ones. Expect
  the `scout`, `reviewer`, `commit` and `proof-verifier` rows to change
  provider and to start carrying non-zero `cost`.
- **Rollback** is a revert of `MODEL_PROVIDER_PREFERENCE` /
  `DEFAULT_PROVIDER_PREFERENCE` in `src/model-classes.ts` (plus the three
  workflow pins in `src/workflow-registry.ts` if the old `opencode-go/` prefixes
  are wanted back). The tests in step 2 fail until the pins and the preference
  order agree again.
