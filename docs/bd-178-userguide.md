# Using and verifying Command Code (Goat) as a fourth provider bucket (bd-178)

bd-178 wires Command Code's **Goat subscription** into the harness as a provider
bucket (`commandcode`), third in the default preference order, and moves the
`standard` class — whose primary is `belayd-reviewer`'s model — onto it. The
reference — why Goat, key precedence, caps, wire ids, plan gating — is
[docs/commandcode-provider.md](commandcode-provider.md); this guide is the
operator's task view: turn it on, confirm it is live, know what moved, and verify
the two failure paths (no key, plan-gated model) behave as degradation rather
than failure.

The gate outputs and the routing printout below were captured in this worktree;
steps marked **needs network** or **needs a key** need a keyed host (or a Nix
build) and were checked against the source and the extension's own documented
command output rather than re-run here.

## How to Verify

1. **Gates** (offline-safe). Run from the repository root:

   ```bash
   pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
   ```

   Expected, in order:

   ```text
    Test Files  130 passed (130)
         Tests  3446 passed (3446)

    Test Files  14 passed (14)
         Tests  108 passed (108)
   ```

   then `tsc --noEmit` silent, `biome check .` with no fixes, `tsc` silent.

2. **Targeted suites** (offline-safe, ~1 s each). These are the cases that fail
   if the routing, plan-gating or no-key classification regresses:

   ```bash
   pnpm test src/__tests__/model-classes.test.ts
   pnpm test src/__tests__/quota-failure.test.ts src/__tests__/capacity-cache.test.ts src/__tests__/spawn-with-fallback.test.ts
   ```

   Expected: `1 passed (1)` file / `49 passed (49)` tests, then `3 passed (3)`
   files / `139 passed (139)` tests. The load-bearing names:

   - `keeps glm-5.3-flash on the Command Code subscription first (bd-178)` and
     `keeps the standard primary on the Command Code subscription with deepseek last`
     — the `standard` candidate order.
   - `maps every class model to a Command Code wire id (bd-178)`,
     `lists each provider at most once in every preference order`,
     `keeps every override a permutation of the default provider set` — the
     four-bucket guardrails.
   - `classifies a 403 MODEL_NOT_IN_PLAN error as a model-scoped unavailable failure`.
   - `classifies the extension's no-key message as provider-scoped unconfigured`
     and `classifies pi's no-key startup refusal as unconfigured (bd-178)` — the
     assistant shape and the production process shape.
   - `end-to-end: pi's process-path no-key refusal degrades to llmgateway (bd-178)`
     and `terminates and surfaces the trail when every hop has no key (bd-178)` —
     the fallback outcome on both sides of the boundary.
   - `does not fast-fail on a provider that is only unconfigured (bd-178)` and
     `treats an entry without a cause tag as capacity (legacy files)` — the
     capacity-probe isolation.

3. **Nix build targets** (**needs network** for the first `buildNpmPackage`
   fetch):

   ```bash
   nix build .#pi-extensions   # extension tree; carries pi-commandcode-provider@0.7.11
   nix build .#pi              # the wrapper: its -e list includes the extension
   ```

   Both produce a `result` symlink. `nix build .#belayd-pi` **fails by design**:
   `belayd-pi` in `flake.nix` is the `mkCodingAgent` module set the `pi` wrapper
   is generated from, not a build target — expect
   `expected … to be a derivation or path but found a set` (the source comment
   above the `belayd-pi` attribute states this).

4. **Routing table without any key or network** (offline-safe). Import the
   compiled library:

   ```bash
   pnpm build
   node --input-type=module -e '
   const { DEFAULT_PROVIDER_PREFERENCE, primaryModelOf, providerPreferenceFor, resolveModelCandidates } =
     await import("./dist/src/model-classes.js");
   console.log(DEFAULT_PROVIDER_PREFERENCE.join(" > "));
   for (const c of ["frontier", "standard", "fast"]) console.log(c, "→", primaryModelOf(c));
   console.log("glm-5.3-flash →", providerPreferenceFor("glm-5.3-flash").join(" > "));
   console.log("deepseek-v4.1-flash →", providerPreferenceFor("deepseek-v4.1-flash").join(" > "));
   console.log(resolveModelCandidates("standard").filter((m) => m.includes("/glm-5.3-flash")));
   '
   ```

   Expected exactly:

   ```text
   llmgateway > opencode-go > commandcode > openrouter
   frontier → opencode-go/deepseek-v4.1-flash
   standard → commandcode/z-ai/glm-5.3-flash
   fast → llmgateway/mimo-v2.6-flash
   glm-5.3-flash → commandcode > llmgateway > opencode-go > openrouter
   deepseek-v4.1-flash → opencode-go > llmgateway > commandcode > openrouter
   [
     'commandcode/z-ai/glm-5.3-flash',
     'llmgateway/glm-5.3-flash',
     'opencode-go/glm-5.3-flash',
     'openrouter/z-ai/glm-5.3-flash'
   ]
   ```

5. **Live provider, with a key** (**needs network + key**). In a pi session on a
   host that has `COMMAND_CODE_API_KEY` set or has completed `/login` → Command
   Code:

   ```text
   /commandcode-status
   ```

   Expected shape — `source: live` on a host that just fetched the catalog,
   `source: cache` when it started from
   `~/.pi/agent/commandcode-models.json`, a non-zero `model count`, `refresh:
   idle`, and `warning: none`:

   ```text
   transport: …
   source: live
   model count: …
   last success: …
   last attempt: …
   cache path: /home/<user>/.pi/agent/commandcode-models.json
   endpoint: https://api.commandcode.ai/provider/v1
   refresh: idle
   warning: none
   ```

   `source: empty` plus a warning about the catalog means neither the live fetch
   nor the cache worked — run `/commandcode-refresh` and read the warning.

   ```text
   /commandcode-quota
   ```

   Expected: the Goat plan (`individual-goat`) plus the 5-hour and weekly
   windows with their reset clocks, and credits remaining/used. The command
   reports an unreachable section explicitly instead of as zero usage.

   ```text
   /model
   ```

   Expected: `commandcode/...` entries in the picker (vendor-qualified, e.g.
   `commandcode/z-ai/glm-5.3-flash`).

6. **Live run, with a key** (**needs network + key + a real bead**). Start a
   workflow in the repository:

   ```text
   /belayd bd-X feature --no-worktree
   ```

   Then read the reviewer rows:

   ```bash
   jq '.stats[] | select(.phase == "review")' .belayd/telemetry.json
   ```

   Expected: a `review` row whose `model` is `commandcode/z-ai/glm-5.3-flash`
   with `attempts >= 1` and `fallbacks: 0`. A `fallbacks: 1` on the same model
   means Command Code was tried and something else served the phase — check the
   `[belayd model fallback]` note on the phase result before calling that a
   regression. Command Code `cost` values come from the extension's static price
   table, so a row for a DeepSeek model can differ by hour (peak/off-peak); see
   [docs/model-capacity-and-telemetry.md](model-capacity-and-telemetry.md).

7. **Live run, without a key — the important degradation case** (**needs
   network, no key**). Remove the key from the session environment (`unset
   COMMAND_CODE_API_KEY`) and make sure `~/.pi/agent/auth.json`,
   `~/.commandcode/auth.json` and `~/.omp/agent/auth.json` hold no Command Code
   credential, then run the same `/belayd bd-X feature --no-worktree`:

   - The failure surfaces as pi's own startup refusal, before any stream exists
     (this is the real path, verified live on pi 1.0.2):

     ```text
     $ pi --mode json --model commandcode/z-ai/glm-5.3-flash … 'reply with hi'
     No API key found for commandcode.     # stderr, exit 1, zero assistant turns
     ```

     There is no assistant `message_end`, so `classifySpawnFailure` takes its
     process path and the statusless no-key rule classifies it
     `unconfigured`. The same wording is emitted for every provider, so a
     keyless llmgateway/opencode-go/openrouter bucket degrades too.

   - The phase tool result ends with one fallback note naming the skip reason and
     the successful hop:

     ```text
     [belayd model fallback] commandcode/z-ai/glm-5.3-flash (unconfigured) → llmgateway/glm-5.3-flash (success)
     ```

   - `.belayd/telemetry.json` keeps the failed primary as its own row with
     `quotaFailures: 0` (a missing key is not a quota failure), and the row that
     served the phase carries `fallbacks: 1`:

     ```bash
     jq '.stats[] | select(.phase == "review")' .belayd/telemetry.json
     ```

     Expected: `commandcode/z-ai/glm-5.3-flash` with `attempts: 1`,
     `quotaFailures: 0`, then `llmgateway/glm-5.3-flash` with `fallbacks: 1`.

   - The cooldown entry is **provider-scoped** and tagged, with a ~10-minute
     expiry (`until` is epoch ms):

     ```bash
     node -e '(async () => {
     const m = await import(`${process.cwd()}/dist/src/model-cooldown.js`);
     const s = await import(`${process.cwd()}/dist/src/model-state-store.js`);
     // The extension's store is the process-wide shared one; resolveModelStatePath()
     // is the authoritative path (BELAYD_MODEL_STATE_FILE wins).
     const path = s.resolveModelStatePath({ env: process.env });
     const opened = s.openModelStateStore({ path });
     if (!opened.ok) throw new Error(opened.error);
     console.log("state store:", path);
     // No `filePath`: a read-back must not trigger (or mark) a legacy import.
     console.log(m.createModelCooldownStore({ store: opened.store }).providerEntries().get("commandcode"));
     })()'
     ```

     Expected `{ until: <now + ~600000>, reason: "Provider has no API key
     configured.", cause: "unconfigured", escalations: 1, … }` in the state
     store printed above. The retired `~/.pi/agent/model-cooldowns.json` is only
     an import source since bd-256; reading the row through the beside-JSON store
     would show an empty table in the default configuration.

   - No capacity signal: the run must **not** contain the fast-fail text
     `All candidate models are on capacity-exhausted providers …; retry after
     reset.` A later phase in the same run skips the bucket instead of spawning
     it again, and its fallback note reads
     `commandcode/z-ai/glm-5.3-flash (provider commandcode exhausted) → llmgateway/glm-5.3-flash (success)`.
     The classified reason behind that skip is the literal
     `Provider commandcode has no API key configured; skipping remaining models on it.`
     — a missing-key phrase, never a quota phrase (asserted by
     `does not fast-fail on a provider that is only unconfigured (bd-178)`).

   - A keyless chain still terminates instead of looping or reporting success.
     The demonstration exercises **two** keyless hops (`commandcode`, then
     `llmgateway`) — not all four candidates — and the loop ends there,
     returning the last real failure (exit 1) with the trail as the note:
     `[belayd model fallback] commandcode/z-ai/glm-5.3-flash (unconfigured) → llmgateway/glm-5.3-flash (unconfigured)`.
     The longer chain behaves the same way, one candidate at a time until the
     loop is exhausted.

8. **Plan-gated model** (**needs network + a key whose plan excludes the model**).
   Run a workflow whose `standard` primary the plan refuses, then check the
   cooldown rows:

   ```bash
   node -e '(async () => {
   const m = await import(`${process.cwd()}/dist/src/model-cooldown.js`);
   const s = await import(`${process.cwd()}/dist/src/model-state-store.js`);
   const opened = s.openModelStateStore({ path: s.resolveModelStatePath({ env: process.env }) });
   if (!opened.ok) throw new Error(opened.error);
   const store = m.createModelCooldownStore({ store: opened.store });
   console.log(store.entries().get("commandcode/z-ai/glm-5.3-flash"), store.providerEntries().get("commandcode"));
   })()'
   ```

   Expected: a **model** entry with a ~6-hour window (`until` ≈ now +
   21 600 000 ms) from the 403 `MODEL_NOT_IN_PLAN` / `upgrade_required` body, and
   no `commandcode` provider entry — the bucket stays usable, only that
   endpoint is cooled. The fallback note shows
   `commandcode/z-ai/glm-5.3-flash (unavailable) → llmgateway/glm-5.3-flash (success)`,
   so the class keeps its capability level. The classification itself is pinned
   offline by `classifies a 403 MODEL_NOT_IN_PLAN error as a model-scoped unavailable failure`.

## How to Use

### 1. Turn it on

Subscribe to Goat ($10/mo, $20 per 5 hours, $50 per week; plan id
`individual-goat`) and take the API key from your Command Code account — plans
documented at https://commandcode.ai/docs/plans/goat. Then pick one of two auth
paths.

**Path A — environment variable (preferred for service-hosted agents).** Every
spawned `pi -ne` session inherits it: `src/spawn.ts` scrubs only AWS credential
variables. On a pi-web host the units get an explicit `Environment =` list, so
use a drop-in on the unit that **spawns** sessions (`pi-web-sessiond`, not the web
unit):

```ini
# /etc/systemd/system/pi-web-sessiond.service.d/commandcode.conf
[Service]
EnvironmentFile=/etc/belayd/commandcode.env   # COMMAND_CODE_API_KEY=...
```

```bash
systemctl daemon-reload && systemctl restart pi-web-sessiond
```

For a local devShell run, the same thing without systemd:

```bash
export COMMAND_CODE_API_KEY="..."   # legacy spelling COMMANDCODE_API_KEY also works
```

**Path B — `/login` (auth.json fallback).** In a pi session run `/login` and pick
**Command Code**. That writes a credential into `~/.pi/agent/auth.json`, which
the provider's key chain reads after the env vars. This is enough for spawned
sessions on the same host and avoids putting the key in every child process
environment; the AWS sandbox mask only hides `~/.aws` and `~/.config/aws`, so it
stays readable inside agent sandboxes. The full precedence chain (env →
`~/.commandcode/auth.json` → `~/.pi/agent/auth.json` → `~/.omp/agent/auth.json`)
is in [docs/commandcode-provider.md](commandcode-provider.md#api-key-precedence).

Optional: `CMD_ZDR=1` (legacy alias `COMMANDCODE_ZDR=1`) requests Command Code's
zero-data-retention routing header (`x-cmd-zdr: 1`).

Turning it **off** needs no flag: unset the key and remove the `/login`
credential. The bucket then classifies as `unconfigured`, is skipped for 10
minutes at a time, and the workflow runs on llmgateway.

### 2. Confirm it is live

```text
/commandcode-status     # catalog source (live vs cache), cache path, warnings: none
/commandcode-quota      # plan individual-goat, 5-hour and weekly windows, credits
/model                  # commandcode/... entries in the model picker
```

`/commandcode-refresh` re-fetches the catalog into
`~/.pi/agent/commandcode-models.json` (override the path with
`COMMANDCODE_MODELS_CACHE`). `/commandcode-status` works without a key; the
quota command needs one.

### 3. Know what will actually run where

| Work | Before bd-178 | Now | Why |
|---|---|---|---|
| `standard` class — `belayd-reviewer` | `llmgateway/glm-5.3-flash` | `commandcode/z-ai/glm-5.3-flash` | Goat serves `glm-5.3-flash` ungated; it is the cheapest bucket for it |
| `frontier` — planner, implementer, tester, userguide, proof-generator, documenter | `opencode-go/deepseek-v4.1-flash` | unchanged primary | opencode-go is far cheaper for that model; `commandcode` becomes a later hop |
| `fast` — scout, committer, proof-verifier | `llmgateway/mimo-v2.6-flash` | unchanged primary | per-token first; `commandcode` becomes a later hop |

Every failover chain gained a fourth bucket, so a llmgateway stall can now land
on Command Code before OpenRouter — that is the intended behaviour, not a
misconfiguration. Class primaries and the failover contract live in
[docs/agent-model-class.md](agent-model-class.md).

Failure paths need no manual intervention: a missing key degrades the phase to
the next hop (llmgateway) instead of failing it, and a plan-gated model cools
only that endpoint for six hours while the same model runs elsewhere.

### 4. Cost and quota behaviour to expect

- `.belayd/telemetry.json` cost rows for Command Code come from the extension's
  bundled static price table, with DeepSeek peak/off-peak bands applied at
  request time — so a DeepSeek row can be priced differently depending on the
  hour. That variation is expected, not a pricing bug.
- The Goat caps are small ($20 / 5 hours, $50 / week). At peak they can stall the
  bucket, and the `standard` class now starts there; the workflow keeps running on
  the later hops (llmgateway, opencode-go, OpenRouter). Expect more
  `[belayd model fallback]` notes during busy hours, not failed phases.
- A `quota` failure cools the whole provider bucket (that is what a spent cap
  means); `unavailable` cools one endpoint; `unconfigured` cools the bucket for
  10 minutes but is deliberately excluded from the capacity probe, so it never
  reads as spent capacity. Details:
  [docs/model-capacity-and-telemetry.md](model-capacity-and-telemetry.md) and
  [docs/commandcode-provider.md](commandcode-provider.md#no-key-configured-unconfigured).
