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

- Chat models only: non-chat/deactivated/`custom` models are filtered out.
- Costs/context/maxTokens/mapping mirror the pi-llmgateway extension's own
  logic. Cache read/write costs are mapped from `input_cache_read`/
  `input_cache_write` (per-million), matching the shell script.
- **DevPass-safe**: IDs stay canonical (no provider prefixes); pricing uses the
  model-level routed price.
- API key: optional. Takes `LLMGATEWAY_API_KEY` env or the `llmgateway` entry in
  `~/.pi/agent/auth.json`; without a key the fetch still works (public list).

Then pick a model in pi with `/model`.

## In-session refresh: `/llmgateway-refresh`

The `llmgateway-refresh` extension (`extensions/llmgateway-refresh.ts`, loaded
by the harness) exposes a `/llmgateway-refresh` slash command that re-runs the
same fetch + mapping inside a running pi session — no shell script, no
nixos-rebuild. The mapping logic lives in the pure functions in
`src/llmgateway-models.ts` (also re-exported from the package's public API in
`src/index.ts`).

### How to Use

```
/llmgateway-refresh                        # fetch + map + write ~/.pi/agent/models.json, then refresh in-memory registry
/llmgateway-refresh --dry-run              # fetch + map + report the diff; do NOT write
/llmgateway-refresh --print                # fetch + map; send the JSON as a message instead of writing
/llmgateway-refresh --require-key          # error if no API key is available (env or auth.json)
/llmgateway-refresh --out <path>           # write to an arbitrary path instead of the default
/llmgateway-refresh --min-models <n>       # error if fewer than N models would be written (default 10)
```

**Flags**

| Flag | Effect |
|------|--------|
| *(no args)* | Fetch `https://api.llmgateway.io/v1/models`, map it, write `~/.pi/agent/models.json` atomically (2-space indent + trailing newline), then call `modelRegistry.refresh()` so `/model` picks up changes without restarting pi. |
| `--dry-run` | Fetch, map, and validate, then notify a summary (e.g. `"185 models would be written to <path>. added 2, removed 0"`) — no file write, no registry refresh. |
| `--print` | Fetch, map, and send the serialized JSON via a custom message (`customType: "llmgateway-refresh"`, `display: true`) — no file write. |
| `--require-key` | Fail with an error unless a key is found via `LLMGATEWAY_API_KEY` env or the `llmgateway` entry in `~/.pi/agent/auth.json`. |
| `--out <path>` | Override the output path. Absolute paths are used as-is; relative paths are resolved against the current working directory. |
| `--min-models <n>` | Refuse to write when the mapped model count is below `n`. Non-negative integer; defaults to **10**. |

Example invocations:

```
/llmgateway-refresh
/llmgateway-refresh --dry-run
/llmgateway-refresh --print
/llmgateway-refresh --require-key
/llmgateway-refresh --out /tmp/llmgateway-models.json
/llmgateway-refresh --out ./preview.json --min-models 100
/llmgateway-refresh --min-models 9999
```

**Default behavior**

1. Fetch `https://api.llmgateway.io/v1/models` (30s timeout). An API key, when
   available, is sent as `Authorization: Bearer <key>`.
2. Validate the response shape (`isLlmGatewayApiResponse`) and map it
   (`mapLlmGatewayModels`).
3. Enforce `--min-models` (default 10); below it, report
   `"only N models (min M); refusing to write"` and stop.
4. Build the `providers.llmgateway` doc and serialize it as 2-space-indented
   JSON with a trailing newline (`serializeModelsJsonDoc`).
5. Write atomically: write to `<outPath>.tmp.<pid>` then `renameSync` over the
   target (a crash mid-write never leaves a truncated `models.json`).
6. Call `ctx.modelRegistry.refresh()`. A failed/aborted refresh is reported as
   a **warning** (not an error) — the file is already written and a future pi
   start picks it up.
7. Notify the summary: `"wrote <n> models to <path>. added <a>, removed <r>"`.

**API key resolution precedence**

1. `LLMGATEWAY_API_KEY` environment variable (trimmed; empty string ignored).
2. The `llmgateway` entry in `~/.pi/agent/auth.json`, only when it has
   `"type": "api_key"` and a string `"key"` field:
   ```json
   { "llmgateway": { "type": "api_key", "key": "sk-..." } }
   ```
   Any other type (e.g. `oauth`), a missing `key`, or invalid JSON yields no key.

The key is optional — the public models list is fetched without it.

**`--out` and auto-loading**

`--out` writes to an arbitrary path for preview/persistence, but pi only
auto-loads `~/.pi/agent/models.json` at startup and registry refresh. Writing
outside the default location therefore does **not** hot-reload the catalog. The
extension warns when `--out` targets a path outside the default agent dir:

```
--out <path> is outside ~/.pi/agent; pi only auto-loads the default models.json path
```

Use the default path (no `--out`) for in-session hot-reload; use `--out` for
previews or to stage a file you copy into place later.

### How to Verify

**1. Automated gates pass**

```bash
pnpm test                # unit tests, including src/__tests__/llmgateway-models.test.ts
pnpm test:integration    # integration tests
pnpm typecheck
pnpm lint
pnpm build
```

All five must exit 0.

**2. `--dry-run` does not write**

In a pi session (repo-local `bin/pi`):

```
/llmgateway-refresh --dry-run
```

- Expect a notification like `"<n> models would be written to /home/<user>/.pi/agent/models.json. added X, removed Y"` (or `"no change"`).
- Confirm `~/.pi/agent/models.json` was **not** modified (mtime unchanged).

**3. `--print` sends the JSON without writing**

```
/llmgateway-refresh --print
```

- Expect a message in the session containing the full serialized JSON.
- Confirm no file was written (`~/.pi/agent/models.json` unchanged).

**4. Default run writes and hot-reloads**

```
/llmgateway-refresh
```

- Expect `"wrote <n> models to /home/<user>/.pi/agent/models.json. added X, removed Y"`.
- Confirm the file is valid JSON with 2-space indentation and a trailing newline.
- Immediately run `/model` — the updated catalog is visible without restarting pi.

**5. Persistence across sessions**

- Open a **fresh** pi session (and/or a fresh pi-web session) and run `/model`.
- The catalog reflects the freshly written `~/.pi/agent/models.json` (pi loads the default path at startup).

**6. Mapping parity with the shell script**

The extension must produce the same output as `scripts/refresh-llmgateway-models.sh`
for the same API snapshot:

```bash
nix develop -c scripts/refresh-llmgateway-models.sh --print > /tmp/shell.json
```

Then, in a pi session, `/llmgateway-refresh --print` and diff the emitted JSON
against `/tmp/shell.json` — they should be identical. Both map:

- per-million costs from `pricing.prompt` / `completion` / `input_cache_read` / `input_cache_write`
- `contextWindow` from `context_length` (default 131072)
- `maxTokens` from the family map (`FAMILY_MAX_TOKENS`, default 16384)
- `thinkingLevelMap` only on reasoning models (`supported_parameters` containing `reasoning`/`reasoning_effort`, or any `providers[].reasoning === true`)

**7. Negative paths**

- `/llmgateway-refresh --require-key` with no `LLMGATEWAY_API_KEY` and no
  `llmgateway` `api_key` in `~/.pi/agent/auth.json` → error:
  `"no API key found (set LLMGATEWAY_API_KEY or add an 'llmgateway' api_key to ~/.pi/agent/auth.json)"`.
- `/llmgateway-refresh --min-models 9999` → error:
  `"only <n> models (min 9999); refusing to write"`; `models.json` is untouched.
- An API 401/5xx → error `"HTTP <status> from https://api.llmgateway.io/v1/models: …"`
  (with up to 200 chars of body); the existing `models.json` is **not** wiped.
- Invalid flag, e.g. `/llmgateway-refresh --bogus` → `"unknown flag: --bogus"`.

**8. One-time install note**

The command must be wired into the pi binary to be available:

- `bin/pi` — `-e "$repo_dir/extensions/llmgateway-refresh.ts"` (dev loop; loads immediately).
- `flake.nix` — `belayd-pi` `extensions` list (global install).
- `package.json` — `pi.extensions` array.
- `.pi/settings.json` — `"../extensions/llmgateway-refresh.ts"`.

The repo-local `bin/pi` picks it up on the next pi start. The NixOS-installed
global copy only gains the command after the next `nixos-rebuild` (one-time
install step).
