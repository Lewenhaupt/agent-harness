# LLM Gateway models (pi)

Pi talks to LLM Gateway through a custom provider in
`~/.pi/agent/models.json` — no per-provider extension, so it works everywhere
(the repo's `bin/pi` wrapper runs `-ne`, which skips settings packages but
does NOT skip `models.json` custom providers).

The file is generated from the live API — see
`scripts/refresh-llmgateway-models.sh`:

```bash
nix develop -c scripts/refresh-llmgateway-models.sh        # write ~/.pi/agent/models.json
nix develop -c scripts/refresh-llmgateway-models.sh --print  # preview the JSON
nix develop -c scripts/refresh-llmgateway-models.sh --dry-run # report the diff, don't write
```

- 185 chat models (from 261 in the API; non-chat/deactivated/`custom` are
  filtered), 111 with reasoning.
- Costs/context/maxTokens/mapping mirror the pi-llmgateway extension's own
  logic. Cache fields (`input_cache_read/write`) are dropped so pi's session
  cost totals reflect only the routed prompt/completion price.
- **DevPass-safe**: IDs stay canonical (no provider prefixes); pricing uses the
  model-level routed price.
- API key: optional. Takes `LLMGATEWAY_API_KEY` env or the `llmgateway` entry in
  `~/.pi/agent/auth.json`; without a key the fetch still works (public list).

Then pick a model in pi with `/model`.