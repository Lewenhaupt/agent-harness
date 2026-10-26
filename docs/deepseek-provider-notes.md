# DeepSeek provider notes

Two facts about the DeepSeek API that silently break third-party harnesses. We
route DeepSeek models through gateways (`opencode-go`, `llmgateway`,
`openrouter`) rather than talking to `api.deepseek.com` directly, so both are
adapter-owned today — but they stop being adapter-owned the moment a phase agent
is pointed at the official endpoint, and the failure looks like an unrelated 400
rather than a configuration problem.

## 1. `reasoning_content` must round-trip on every tool-bearing turn

With `tools` present, DeepSeek requires the `reasoning_content` of **every** prior
assistant turn to be passed back — including turns that made no tool call.
Omitting it returns:

```
The reasoning_content in the thinking mode must be passed back to the API.
```

Thinking is **on by default** (`deepseek-flash`), so this fires immediately, not
only after someone enables it. Without `tools` the field is ignored, which is why
the failure only shows up in agent loops. The most common third-party cause is a
translator that maps `reasoning_content` into Anthropic `thinking` blocks and then
drops them on re-send (DeepSeek thinking blocks carry no signature).

Invariant for this repo: **any spawn path must preserve assistant thinking blocks
in the transcript it replays.** pi records them as `thinking` content with
`thinkingSignature: "reasoning_content"`, and `src/spawn.ts` streams whole
messages without filtering content types, so resumed phase sessions keep them.
If a provider adapter is added or replaced, that preservation is the thing to
test — not the request shape.

## 2. Model ids: official vs provider slug

| Id | Status |
|---|---|
| `deepseek-flash` | **official** API id; currently served by DeepSeek-V4.1-Flash-1017 |
| `deepseek-v4-pro` | **official** API id |
| `deepseek-v4-flash` | **retired**; still accepted and legacy-routed to V4.1-Flash-1017 |
| `deepseek-v4.1-flash` | **not** an official DeepSeek id — the provider slug gateways serve |

`src/model-classes.ts` lists the *gateway* ids on purpose: the default provider
preference tries `llmgateway`, then `opencode-go`, then `openrouter`, except for
`deepseek-v4.1-flash`, whose `MODEL_PROVIDER_PREFERENCE` entry puts `opencode-go`
first (the subscription bucket is cheaper than per-token for that one model).
Those orders resolve `deepseek-v4.1-flash` / `deepseek-v4-flash` as shipped. Note
that `opencode-go`'s live catalog does not serve `deepseek-v4-flash` at all, so
the pins that use it (`documentation` / `hotfix` implement) point at
`llmgateway` — an opencode-go pin would burn a 404/410 attempt first.
If a `deepseek` provider is
ever added, its model ids must be the official ones, and `MODEL_TO_CLASS` /
`MODEL_CLASS_SPECS` need entries for the official spelling rather than a rename of
the existing ones. `src/__tests__/model-classes.test.ts` asserts that every id in
the class specs is documented in this table, so adding a model without recording
which kind of id it is fails the suite.

## Related

- Provider wiring and the gateway catalog: `docs/llmgateway.md`
- Capacity probing, cooldowns, per-phase telemetry: `docs/model-capacity-and-telemetry.md`
