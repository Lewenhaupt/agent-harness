#!/usr/bin/env bash
# Refresh LLM Gateway models into pi's custom-provider config.
#
# Fetches https://api.llmgateway.io/v1/models and rewrites
# ~/.pi/agent/models.json with an `llmgateway` custom provider, so pi can use
# any of the gateway's models through /model without a per-provider extension
# (see docs/llmgateway.md).
#
# Field mapping follows the pi-llmgateway extension's own logic
# (src/extensions/provider/models/map.ts): per-million-token costs from
# pricing.prompt/completion/input_cache_read/input_cache_write, context from
# context_length, maxTokens from family defaults, compat
# {supportsDeveloperRole:false, maxTokensField:"max_tokens"} everywhere, and a
# thinkingLevelMap on reasoning models.
#
# DevPass-safe: model ids are kept canonical (no provider prefixes). The API
# lists provider-specific specs under each model's providers[] but we use only
# the model-level pricing, which is the gateway's routed/DevPass price.
#
# Usage:
#   scripts/refresh-llmgateway-models.sh [--dry-run] [--print]
#     --dry-run       Fetch, build, validate; report the diff but do NOT write.
#     --print         Write the JSON to stdout instead of the config file.
#     --offline       Reuse cached _models.json; no network.
#     --require-key   Fail instead of proceeding without an API key.
#     --out FILE      Override the output path (default ~/.pi/agent/models.json).
#     --min-models N  Fail if fewer than N models would be written (default 10).
#
# Requires: curl, python3 (both present in the flake devShell).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"

# Read API key from env first, then auth.json (never printed).
LLMGW_API_KEY="${LLMGATEWAY_API_KEY:-}"
if [[ -z "$LLMGW_API_KEY" ]]; then
  local_auth="$HOME/.pi/agent/auth.json"
  if [[ -f "$local_auth" ]]; then
    LLMGW_API_KEY="$(python3 -c "
import json, pathlib
try:
    d = json.loads(pathlib.Path('$local_auth').read_text())
    e = d.get('llmgateway', {})
    print(e.get('key', '') if e.get('type') == 'api_key' else '')
except Exception:
    print('')
" 2>/dev/null || true)"
  fi
fi

DRY_RUN=0
PRINT=0
OFFLINE=0
REQUIRE_KEY=0
MIN_MODELS=10
OUT="${LLMGW_MODELS_OUT:-$HOME/.pi/agent/models.json}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --print) PRINT=1 ;;
    --offline) OFFLINE=1 ;;
    --require-key) REQUIRE_KEY=1 ;;
    --out) OUT="$2"; shift ;;
    --min-models) MIN_MODELS="$2"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ $REQUIRE_KEY -eq 1 && -z "$LLMGW_API_KEY" ]]; then
  echo "error: no API key found (set LLMGATEWAY_API_KEY or add an 'llmgateway' api_key to ~/.pi/agent/auth.json)" >&2
  exit 3
fi

CACHE_DIR="$HOME/.cache/llmgateway"
mkdir -p "$CACHE_DIR"
RAW="$CACHE_DIR/_models.json"

if [[ $OFFLINE -eq 1 ]]; then
  if [[ ! -f "$RAW" ]]; then
    echo "error: --offline but no cached $RAW" >&2
    exit 3
  fi
else
  curl_args=(-fsS --max-time 30)
  [[ -n "$LLMGW_API_KEY" ]] && curl_args+=(-H "Authorization: Bearer $LLMGW_API_KEY")
  if ! curl "${curl_args[@]}" "https://api.llmgateway.io/v1/models" -o "$RAW" 2>/dev/null; then
    echo "error: failed to fetch https://api.llmgateway.io/v1/models" >&2
    exit 4
  fi
fi

# Everything below (build + write) is one python block.
python3 - "$DRY_RUN" "$PRINT" "$OUT" "$MIN_MODELS" "$RAW" <<'PY'
import json, sys, pathlib

dry_run = sys.argv[1] == "1"
print_flag = sys.argv[2] == "1"
out_path = sys.argv[3]
min_models = int(sys.argv[4])
raw = sys.argv[5]

data = json.loads(pathlib.Path(raw).read_text())
api_models = data.get("data", [])

def per_million(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0
    return v * 1_000_000 if v else 0

FAMILY_MAX_TOKENS = {
    "openai": 16384, "anthropic": 32000, "google": 32768, "xai": 32768,
    "deepseek": 32768, "moonshot": 32768, "alibaba": 16384, "minimax": 40960,
    "glm": 32768, "meta": 8192, "mistral": 32768, "nvidia": 32768,
    "bytedance": 32768, "perplexity": 32768, "xiaomi": 32768,
    "llmgateway": 32768,
}
DEFAULT_MAX_TOKENS = 16384

def max_tokens(family):
    return FAMILY_MAX_TOKENS.get(family, DEFAULT_MAX_TOKENS)

def reasoning_supported(m):
    sp = m.get("supported_parameters") or []
    if "reasoning" in sp or "reasoning_effort" in sp:
        return True
    return any((p or {}).get("reasoning") is True for p in m.get("providers") or [])

def derive_input(m):
    mods = (m.get("architecture") or {}).get("input_modalities") or []
    out = ["text"]
    if "image" in mods:
        out.append("image")
    return out

def is_chat(m):
    if m.get("id") == "custom":
        return False
    outputs = (m.get("architecture") or {}).get("output_modalities") or []
    if "text" not in outputs:
        return False
    if m.get("deactivated_at"):
        return False
    return True

models = []
for m in api_models:
    if not is_chat(m):
        continue
    pricing = m.get("pricing") or {}
    reasoning = reasoning_supported(m)
    entry = {
        "id": m["id"],
        "name": m.get("name") or m.get("id"),
        "reasoning": reasoning,
        "input": derive_input(m),
        "cost": {
            "input": per_million(pricing.get("prompt")),
            "output": per_million(pricing.get("completion")),
            "cacheRead": per_million(pricing.get("input_cache_read")),
            "cacheWrite": per_million(pricing.get("input_cache_write")),
        },
        "contextWindow": m.get("context_length") or 131072,
        "maxTokens": max_tokens(m.get("family")),
        "compat": {
            "supportsDeveloperRole": False,
            "maxTokensField": "max_tokens",
        },
    }
    if reasoning:
        entry["thinkingLevelMap"] = {
            "minimal": None, "low": None, "medium": "medium",
            "high": "high", "xhigh": "xhigh",
        }
    models.append(entry)

if len(models) < min_models:
    print(f"error: only {len(models)} models (min {min_models}); refusing to write", file=sys.stderr)
    sys.exit(5)

doc = {
    "providers": {
        "llmgateway": {
            "baseUrl": "https://api.llmgateway.io/v1",
            "api": "openai-completions",
            "models": models,
        }
    }
}

if print_flag:
    json.dump(doc, sys.stdout, indent=2)
    sys.exit(0)

out = pathlib.Path(out_path)
prev = json.loads(out.read_text()) if out.exists() else {}
new_s = json.dumps(doc, indent=2) + "\n"
old_s = json.dumps(prev, indent=2) + "\n" if prev else ""
changed = old_s != new_s

if dry_run:
    if changed:
        print(f"models would change: {len(prev.get('providers', {}).get('llmgateway', {}).get('models', []))} -> {len(models)}")
    else:
        print(f"no change ({len(models)} models)")
    sys.exit(0)

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(new_s)
print(f"wrote {len(models)} models to {out_path}")
if changed:
    print(f"  ({len(api_models)} api models; {len(models)} chat models; diff applied)")
PY