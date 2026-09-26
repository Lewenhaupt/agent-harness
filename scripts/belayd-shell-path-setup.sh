#!/usr/bin/env bash
# belayd-shell-path-setup — idempotently point pi's settings.json `shellPath` at
# the belayd-shell wrapper. Used by pi-web-sessiond's ExecStartPre and by the
# interactive `pi` wrapper (folds bd-47: sub-agents inherit the devShell).
#
# Non-strict by default so a corrupt settings.json (or an unwritable directory)
# warns and exits 0 rather than bricking pi-web or interactive pi. Callers may
# pass --strict to surface the error with a non-zero exit.
set -u

JQ="@jq@"
settings="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json"
shell="$(cd "$(dirname "$0")" && pwd)/belayd-shell"
strict=0

warn() { printf 'belayd-shell-path-setup: %s\n' "$1" >&2; }

# Resolve symlinks so an atomic replace updates the *target* and the symlink
# survives. Falls back to the original path when readlink is unavailable.
resolve_path() {
  local p="$1" out
  out="$(readlink -f "$p" 2>/dev/null)" || out=""
  if [ -z "$out" ]; then out="$p"; fi
  printf '%s' "$out"
}

# Non-strict mode must never block the pi-web-sessiond unit; strict mode keeps
# failing loud so interactive callers can surface the problem.
fail_or_warn() {
  warn "$1"
  [ "$strict" = 1 ] && exit 1
  exit 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --settings)
      [ "$#" -ge 2 ] || { warn "--settings needs a value"; exit 2; }
      settings="$2"
      shift 2
      ;;
    --settings=*)
      settings="${1#--settings=}"
      shift
      ;;
    --shell)
      [ "$#" -ge 2 ] || { warn "--shell needs a value"; exit 2; }
      shell="$2"
      shift 2
      ;;
    --shell=*)
      shell="${1#--shell=}"
      shift
      ;;
    --strict)
      strict=1
      shift
      ;;
    *)
      warn "unknown option: $1"
      exit 2
      ;;
  esac
done

real="$(resolve_path "$settings")"
dir="$(dirname "$real")"

# Missing or empty settings file is treated as absent and created with the
# default 0600 mode.
if [ ! -e "$real" ] || [ ! -s "$real" ]; then
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.settings.json.XXXXXX")" || fail_or_warn "cannot create a temp file in $dir"
  if "$JQ" -n --arg p "$shell" '{shellPath: $p}' > "$tmp"; then
    chmod 0600 "$tmp"
    mv -f "$tmp" "$real"
    exit 0
  fi
  rm -f "$tmp"
  fail_or_warn "could not create $real"
fi

# A parse failure yields an empty `current`; distinguish "no key" (valid) from
# "not JSON" by asking jq to validate the file.
current="$("$JQ" -r '.shellPath // empty' "$real" 2>/dev/null)"
if [ -z "$current" ] && ! "$JQ" -e . "$real" >/dev/null 2>&1; then
  fail_or_warn "$real is not valid JSON; leaving it untouched"
fi

# Idempotent: already pointing at the target wrapper, nothing to write (so the
# file's mtime is preserved).
if [ "$current" = "$shell" ]; then
  exit 0
fi

# Derive the mode from the resolved target (a symlinked settings.json keeps its
# target's mode).
mode="$(stat -c '%a' "$real")"
tmp="$(mktemp "$dir/.settings.json.XXXXXX")" || fail_or_warn "cannot create a temp file in $dir"
# Atomic merge preserving every other key.
if "$JQ" --arg p "$shell" '.shellPath = $p' "$real" > "$tmp" 2>/dev/null; then
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$real"
  exit 0
fi
rm -f "$tmp"
fail_or_warn "$real is not a JSON object; leaving it untouched"
