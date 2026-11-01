# Command Code provider (Goat subscription)

Command Code's **Goat** plan is a cheap subscription bucket for Belayd phase
agents. pi ships no built-in `commandcode` provider, so supply comes from a
pinned third-party extension; this page records why it is here, how it
authenticates, which models it serves, and how a plan-gated model fails.

## Why Goat

| Fact | Value |
|---|---|
| Price | $10/mo, up to $100 of credits |
| Rolling caps | $20 per 5 hours, $50 per week |
| Plan id | `individual-goat` |
| Provider id in pi | `commandcode` |
| API base | `https://api.commandcode.ai/provider/v1` |
| Docs | https://commandcode.ai/docs/plans/goat |

The API is OpenAI/Anthropic-shaped (`POST /chat/completions`, `POST /responses`,
`POST /messages`) and `GET /models` is readable anonymously, which is how the
wire-id table below was verified. `GET /models?view=client` additionally reports
`minimumPlan:` per id (of 106 ids, 11 are gated exactly at Goat, 16 at Pro, 8 at
provider, 2 at Max — Goat reaches 80).

Goat is the smallest bucket in the routing table after opencode-go, so it is a
**preference, not a requirement**: `glm-5.3-flash` prefers it, and every failover
chain keeps its per-token and OpenRouter hops.

## The extension

`nix/pi-extensions/package.json` pins `pi-commandcode-provider@^0.7.11`
(patlux, MIT, unofficial) and its `piExtensions` entry (`index.ts`). `bin/pi`
and `flake.nix` derive their `-e` list from that manifest, so this is the whole
wiring.

What the extension provides:

- registers provider id `commandcode` and its models (so no `models.json`
  catalog block is needed);
- discovers the catalog from `GET /provider/v1/models` and caches it at
  `~/.pi/agent/commandcode-models.json`, which is why `pi -ne` sub-agents still
  see the model list offline; override the path with
  `COMMANDCODE_MODELS_CACHE`;
- ships reviewed static pricing, including DeepSeek peak/off-peak bands, so
  `.belayd/telemetry.json` cost rows vary by hour of day — expected;
- adds three commands (see below).

| Command | Purpose |
|---|---|
| `/commandcode-quota` | plan id, credit sources, the 5-hour and weekly windows with reset clocks |
| `/commandcode-refresh` | re-fetch the model catalog into the cache |
| `/commandcode-status` | redacted provider diagnostics: catalog source (live vs cache), warnings |

## API key precedence

Two lookups exist. The **configured-key chain** (`getConfiguredApiKey`,
`pi-commandcode-provider/src/api-key.ts`; the same chain is duplicated for the
stream path in `src/converters.ts`) is consulted when pi's model registry has no
usable key — `pickCommandCodeApiKey(registryKey, configuredKey)` prefers the
registry value and treats pi's literal `$COMMAND_CODE_API_KEY` placeholder as
unresolved. The **pi OAuth store** (`src/oauth.ts`, wired in as the provider's
`oauth.getApiKey` in `index.ts`) is a *separate* lookup that pi's own credential
machinery populates from `/login`.

The chain, in order:

| Step | Source | Notes |
|---|---|---|
| 1 | `COMMAND_CODE_API_KEY` env | `src/api-key.ts` |
| 2 | `COMMANDCODE_API_KEY` env | legacy spelling, same file |
| 3 | `~/.commandcode/auth.json` | first path in `defaultAuthPaths` (`src/api-key.ts`); the official Command Code CLI's file |
| 4 | `~/.pi/agent/auth.json` | second path; pi's auth store |
| 5 | `~/.omp/agent/auth.json` | third path; OMP hosts |

Every auth.json path is read the same way (`src/api-key.ts`), first match wins:

- a plain top-level `"apiKey"` string,
- a legacy top-level `"commandcode"` string,
- a `"commandcode"` credential object or the CLI's `"command-code"` object,
  where `type: "api"` reads `key`, `type: "oauth"` reads `access`, and an
  untyped object falls back to `access` then `key`,
- a legacy top-level `"command-code"` string.

The plain top-level `apiKey` string is read first; the `commandcode` /
`command-code` entries are credential-object *fallbacks*, not a required
sub-key. `/login` writes one of those objects (`{type: "oauth", access,
refresh, expires}`) under `commandcode`, so steps 3–5 pick it up through the
credential-object rule, and pi's OAuth store also serves it directly
(`getApiKey(credentials) → credentials.access`, `src/oauth.ts`). A key typed
into `/login` is stored the same way, with a far-future expiry.

So `~/.pi/agent/auth.json` may hold either a plain `apiKey` or an OAuth object;
an operator debugging "missing key" should check the env vars first, then those
three paths in order, then `/commandcode-status` (it reports the catalog source
and any key/catalog warning). A `/login` on the host is enough for spawned
`pi -ne` sessions; the env var is for hosts provisioned without an interactive
login.
`src/spawn.ts` only scrubs AWS credential variables, so `COMMAND_CODE_API_KEY`
reaches every child process (sub-agents, sandboxed shells) — an inherited key is
visible to them by design.

`CMD_ZDR=1` (or `COMMANDCODE_ZDR=1`) opts into zero-data-retention routing when
the provider allows it.

### Runbook: pi-web / systemd

The pi-web units get an explicit `Environment =` list from
`services.belayd-pi-web`, so the operator adds the key with a systemd drop-in
rather than editing the flake:

```ini
# /etc/systemd/system/pi-web-sessiond.service.d/commandcode.conf
[Service]
EnvironmentFile=/etc/belayd/commandcode.env   # COMMAND_CODE_API_KEY=...
```

`pi-web-sessiond` starts the sessions, so the var belongs on that unit (the web
unit does not spawn agents). `systemctl daemon-reload && systemctl restart
pi-web-sessiond` afterwards. The AWS sandbox mask only hides `~/.aws` and
`~/.config/aws`, so `~/.pi/agent/auth.json` stays visible if the operator
prefers `/login` instead.

Verify from a session:

```text
/commandcode-status     # catalog source + no "missing key" warning
/commandcode-quota      # plan individual-goat, 5-hour and weekly windows
```

## Routing

`src/model-classes.ts` owns provider preference. The default order is
per-token → subscription → subscription → last resort:

```text
llmgateway, opencode-go, commandcode, openrouter
```

Two models override it:

| Canonical id | Preference order | Why |
|---|---|---|
| `deepseek-v4.1-flash` | `opencode-go`, `llmgateway`, `commandcode`, `openrouter` | opencode-go is far cheaper for it |
| `glm-5.3-flash` | `commandcode`, `llmgateway`, `opencode-go`, `openrouter` | Goat serves it and does not gate it |

`glm-5.3-flash` is the `standard` class primary, so `belayd-reviewer` (and the
standard class's first failover hop) now runs on
`commandcode/z-ai/glm-5.3-flash`. See docs/agent-model-class.md for the
consequences.

## Canonical id ↔ wire id

Candidates render as `provider/<wire id>`, so a Command Code candidate keeps the
provider's own vendor prefix (`commandcode/z-ai/glm-5.3-flash` — a double prefix,
the same shape as `openrouter/z-ai/glm-5.3-flash`). Only models already in
`MODEL_CLASS_SPECS` are mapped; the vendor prefixes and casing differ per
family, which is exactly why the mapping exists.

| Canonical id | Command Code wire id | Verified |
|---|---|---|
| `deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` | yes |
| `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | yes |
| `glm-5.3` | `zai-org/GLM-5.3` | yes |
| `glm-5.3-flash` | `z-ai/glm-5.3-flash` | yes |
| `gpt-5.6-luna` | `gpt-5.6-luna` (bare, no mapping needed) | yes |
| `mimo-v2.6-flash` | `xiaomi/mimo-v2.6-flash` | yes |

Only class ids get a Command Code hop, and every class id is mapped. Ids outside
`MODEL_TO_CLASS` (e.g. `glm-5.2`, which the catalog serves as
`zai-org/GLM-5.2`) take the single-candidate path in `candidatesForModel` and
never reach a provider hop at all, so they cannot produce a wasted Command Code
attempt. Goat-only ids (`claude-sonnet-5-5`, `xai/grok-4.6`,
`google/gemini-3.8-flash`, `gpt-5.6-sol`, …) stay out of scope by the same rule:
no class spec names them, and no class member is added for them here.

The one real Command Code waste is a mapped class id that the caller's plan
gates (`403 MODEL_NOT_IN_PLAN`, below): the model-scoped six-hour `unavailable`
cooldown absorbs it, so each cold window costs at most one rejected attempt per
id. Plan-aware catalog filtering (`?view=client`), Goat-only models and the
`individual-go` `/alpha/generate` transport are deliberately out of scope.

## Plan gating: `MODEL_NOT_IN_PLAN`

A model outside the caller's plan gets an HTTP 403 whose body says so, in one of
these shapes:

```text
403: {"error":{"code":"MODEL_NOT_IN_PLAN","message":"… is not included in your plan"}}
403: {"code":"upgrade_required","message":"Upgrade your plan"}
```

`src/quota-failure.ts` classifies that as **`unavailable`**, not `quota`, and
does so before the broader provider-entitlement rule (which also matches
"upgrade"/"subscription"):

- `unavailable` is **model-scoped** — `src/spawn-with-fallback.ts` cools a whole
  provider only for `quota` and `unconfigured`, so the gated endpoint is skipped
  for `DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS` (6 h) while the rest of the
  Command Code bucket stays usable;
- the fallback continues to the same model on the next provider, which keeps the
  capability level the class promised.

The live opencode-go body ("An active OpenCode Go subscription is required to
use Go models") still classifies as a provider-scoped `quota` failure, and a
bare 403 still classifies as `auth` and stops the fallback.

## No key configured: `unconfigured`

With nothing resolving to a key, the failure happens **before** the extension's
stream exists: the provider is registered with an `apiKey` template
(`$COMMAND_CODE_API_KEY`), so pi itself refuses to start the child process
(verified live on pi 1.0.2) —

```text
$ pi --mode json --model commandcode/z-ai/glm-5.3-flash … 'reply with hi'
No API key found for commandcode.        # stderr, exit 1, zero assistant turns
```

Because there is no assistant `message_end` at all, `classifySpawnFailure` takes
its **process** path, and `classifyProcessFailure` applies the same statusless
no-key pattern to stderr: the same core wording is emitted for *every* provider,
so a keyless llmgateway/opencode-go/openrouter bucket degrades the same way.

`src/quota-failure.ts` classifies that as **`unconfigured`** — a provider-scoped
kind that is fallback-worthy and deliberately **not** `quota`:

- a missing key is a property of the provider, so `src/spawn-with-fallback.ts`
  cools the provider (`markProviderCooldown`) and skips its sibling models
  instead of burning a spawn per class id;
- it is not `quota`, so telemetry never counts a `quotaFailure`, and the
  cooldown entry carries a stable `cause: "unconfigured"` tag that
  `probeFromCooldownStore` filters out (`isCapacityCause`,
  `src/capacity-cache.ts`) — a configuration error must not surface as spent
  capacity or trigger the "out of capacity, retrying after reset" fast-fail;
- it is not `auth`, because `auth` still *stops* the fallback (a wrong key on one
  provider must not fail a phase that another provider can serve) and it is not
  `other` (which also stops).

When the extension does get to run (an in-process spawn whose key resolution
happens later), it reports the same condition as a statusless assistant error,
which the assistant path classifies identically:

```text
No Command Code API key. Run /login and select Command Code, set
COMMAND_CODE_API_KEY (or legacy COMMANDCODE_API_KEY), or configure
~/.commandcode/auth.json, ~/.pi/agent/auth.json or ~/.omp/agent/auth.json
```

The window is `DEFAULT_UNCONFIGURED_PROVIDER_COOLDOWN_SECONDS` (10 min) — short
because the fix is an operator action (env var or `/login`) — and it expires, so
the provider is probed again without editing `~/.pi/agent/model-cooldowns.json`.
The reason recorded on the entry is `Provider has no API key configured.` on both
paths. The rule only matches text with **no** status code, so a process/stderr
line carrying 401/403 stays `auth` and one carrying 429 stays `quota`.

Consequence: a host without a Command Code key still runs the standard class —
the reviewer logs one `unconfigured` attempt and the phase continues on
`llmgateway/glm-5.3-flash` (the fallback note records it). If **every** hop in the
chain is keyless the loop still terminates on the last candidate and returns its
real failure (exit 1) with the whole trail, e.g.
`[belayd model fallback] commandcode/z-ai/glm-5.3-flash (unconfigured) → llmgateway/glm-5.3-flash (unconfigured)`.

## How to verify

1. ```bash
   curl -s https://api.commandcode.ai/provider/v1/models | jq -r '.data[].id' | grep -E 'glm|deepseek|mimo'
   ```
   Expected: the wire ids in the table above (anonymous; no key needed).

2. ```bash
   pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
   ```
   The model-class suite pins the four-provider preference set and the
   `commandcode` wire ids; `quota-failure.test.ts` pins the plan-gating and
   both no-key shapes (assistant error body and pi's process-path startup
   refusal); `spawn-with-fallback.test.ts` pins that a gated 403 cools only the
   endpoint and that an unkeyed provider degrades to llmgateway on both shapes.

3. ```bash
   nix build .#pi-extensions   # the extension tree, with the new npmDepsHash
   nix build .#pi              # the wrapper: carries -e <pi-commandcode-provider>
   ```
   `belayd-pi` in `flake.nix` is the `mkCodingAgent` module set the `pi` wrapper
   is generated from — it is not a build target, so `nix build .#belayd-pi`
   fails with "expected … to be a derivation or path but found a set".

4. In a session: `/model` lists `commandcode/...` entries, `/commandcode-quota`
   shows the plan and both windows, `/commandcode-status` reports the catalog
   source. A `/belayd bd-X feature --no-worktree` run records
   `commandcode/z-ai/glm-5.3-flash` in the reviewer rows of
   `.belayd/telemetry.json`; without a key the same run records one
   `unconfigured` attempt and the reviewer succeeds on
   `llmgateway/glm-5.3-flash`.

## Risks

- **Wasted attempt on a plan-gated class id.** Every failover chain gains a
  fourth candidate, and a mapped id outside the caller's plan costs one rejected
  attempt per cold window. The 6-hour model-scoped cooldown bounds it; if
  telemetry shows repeated attempts, add an explicit "providers serving this
  model" guard instead of dropping the provider.
- **Small bucket.** $20/5h and $50/week can stall the standard class at peak now
  that its primary lives there. Later hops (llmgateway, opencode-go, openrouter)
  keep the workflow running — degradation, not failure.
- **Community package.** patlux's package is unofficial; its static pricing and
  capability snapshot can drift and a breaking release hits every spawned phase.
  The version is locked to 0.7.11 by `nix/pi-extensions/package-lock.json` — the
  manifest's caret range (`^0.7.11`) allows a deliberate bump via a lockfile
  refresh, so review that diff instead of editing the range by hand.
- **Key exposure.** An env key is inherited by every child process; the
  auth.json-only setup narrows that at the cost of a browser login per host.
