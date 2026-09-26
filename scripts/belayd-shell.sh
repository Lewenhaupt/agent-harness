#!/usr/bin/env bash
# belayd-shell — route every command through the project devShell resolved from
# $PWD. Installed as both the pi-web units' SHELL and the global settings.json
# shellPath, so terminals, plugin runCommand, workspace removal, the agent bash
# tool, and spawned sub-agents all get per-repo devShells from one config.
#
# Deliberately not `set -e`: every failure path below needs an explicit,
# actionable exit message instead of a bare non-zero from a failed pipeline.
set -u

# Both placeholders are substituted by the Nix build (see flake.nix); the env
# overrides exist so tests can point at stubs.
REAL_SHELL="${BELAYD_REAL_SHELL:-@realShell@}"
JQ="${BELAYD_JQ:-@jq@}"

belayd_warn() { printf 'belayd-shell: %s\n' "$1" >&2; }
belayd_fail() { printf 'belayd-shell: %s\n' "$1" >&2; exit 1; }

# Filter direnv's own status noise from the failure and success paths below.
# This runs synchronously against a temp file (never as a process substitution),
# so no stderr data is lost and `exec` is not entangled with a background
# subshell. Only direnv's status lines (`loading`, `export`/`unset` diffs, and
# the nix-direnv helpers) are dropped; `direnv: error …` diagnostics and the
# raw `.envrc` runtime errors (e.g. `command not found`) are forwarded
# untouched.
belayd_filter_direnv_stderr() {
  local line plain stripped
  while IFS= read -r line; do
    plain="$line"
    # Strip ALL stacked leading ANSI escape sequences (e.g.
    # `ESC[0mESC[31m`), not just the first, so a status line cannot hide
    # behind more than one escape. `#*m` removes through the first `m`; loop
    # until no progress so an escape without an `m` terminator cannot hang.
    while :; do
      case "$plain" in
        $'\x1b'*) ;;
        *) break ;;
      esac
      stripped="${plain#*m}"
      [ "$stripped" = "$plain" ] && break
      plain="$stripped"
    done
    case "$plain" in
      "direnv: loading"*|"direnv: export"*|"direnv: unset"*|"direnv: using"*|"direnv: nix-direnv"*) continue ;;
    esac
    printf '%s\n' "$line"
  done
}

# No recursion: a process already inside a devShell must not re-enter one (that
# would deadlock nix/direnv). A consequence: a process already inside one repo's
# devShell will NOT switch to another repo's devShell — it gets the ambient
# shell. Nested shells inside one project inherit the enclosing devShell, which
# is the desired behavior.
if [ -n "${BELAYD_SHELL_ACTIVE:-}" ]; then
  exec "$REAL_SHELL" "$@"
fi

# Walk up from $PWD to the first devShell marker. `.pi/no-devshell` stops the
# walk and forces pass-through, so a repo can opt out even when an ancestor
# directory carries a marker.
root=""
mode=""
dir="${PWD:-$(pwd)}"
while [ -n "$dir" ]; do
  if [ -e "$dir/.pi/no-devshell" ]; then
    exec "$REAL_SHELL" "$@"
  fi
  if [ -e "$dir/.envrc" ]; then
    root="$dir"
    mode="direnv"
    break
  fi
  if [ -e "$dir/flake.nix" ]; then
    root="$dir"
    mode="flake"
    break
  fi
  if [ -e "$dir/shell.nix" ]; then
    root="$dir"
    mode="shell.nix"
    break
  fi
  parent="$(dirname "$dir")"
  if [ "$parent" = "$dir" ]; then
    break
  fi
  dir="$parent"
done

# No devShell anywhere up the tree: strict transparent pass-through with no
# output and no env mutation.
if [ -z "$mode" ]; then
  exec "$REAL_SHELL" "$@"
fi

if [ "$mode" = "direnv" ]; then
  if ! command -v direnv >/dev/null 2>&1; then
    belayd_fail ".envrc exists at $root but direnv is not on PATH"
  fi

  # `direnv status --json` reports `.state.foundRC.allowed` as an integer.
  # Empirically (direnv 2.37.1): 0 = allowed, 1 = blocked (no allow entry and
  # no matching whitelist prefix), 2 = denied. A matching whitelist prefix
  # reports 0 without any allow entry. Anything other than 0 must fail loud:
  # `denied` otherwise runs the command silently *without* loading the env.
  state_json="$(cd "$root" && direnv status --json 2>/dev/null)"
  allowed="$(printf '%s\n' "$state_json" | "$JQ" -r '.state.foundRC.allowed // empty' 2>/dev/null)"
  if [ "$allowed" != "0" ]; then
    if [ -z "$allowed" ] && [ -z "$(printf '%s\n' "$state_json" | "$JQ" -r '.state.foundRC // empty' 2>/dev/null)" ]; then
      belayd_fail ".envrc at $root exists but direnv reported no readable state (foundRC is null); check that the file is readable, then run: direnv allow $root"
    fi
    belayd_fail ".envrc at $root is not allowed (direnv state: ${allowed:-unknown}). Run: direnv allow $root"
  fi

  # Never fall through to the flake path when `.envrc` exists: a blocked direnv
  # must be fixed, not silently bypassed.
  #
  # Enter through `direnv export bash` + eval instead of `direnv exec`:
  # `direnv exec` writes status lines (`direnv: loading …`, and in nix-direnv
  # repos `direnv: using flake` / `direnv: nix-direnv: …`) to stderr, and direnv
  # 2.37.1 ignores DIRENV_LOG_FORMAT so they cannot be muted. Filtering that
  # stderr through `2> >(filter)` is lossy because bash does not wait for a
  # process-substitution subshell once `exec` replaces this process (measured:
  # roughly half of a 10k-line burst is dropped when stderr is a file).
  # `direnv export bash` emits the same `export`/`unset` diff direnv itself
  # would apply, so we capture it, discard direnv's stderr on success, then eval
  # it here. cwd is untouched (the capture runs in a subshell) and `exec` is
  # preserved, so the agent bash tool's kill/timeout semantics still hold.
  err_file="$(mktemp 2>/dev/null || true)"
  if [ -n "$err_file" ]; then
    env_out="$(cd "$root" && direnv export bash 2>"$err_file")"
    export_status=$?
  else
    # mktemp unavailable: discard stderr rather than fail the whole entry path.
    env_out="$(cd "$root" && direnv export bash 2>/dev/null)"
    export_status=$?
  fi
  if [ "$export_status" != "0" ]; then
    if [ -n "$err_file" ] && [ -s "$err_file" ]; then
      belayd_filter_direnv_stderr < "$err_file" >&2
    fi
    [ -z "$err_file" ] || rm -f "$err_file"
    belayd_fail "failed to load $root/.envrc (direnv export bash exited $export_status); fix the .envrc and run: direnv allow $root"
  fi
  # `direnv export bash` exits 0 for non-fatal .envrc runtime errors (e.g. a
  # `command not found`), writing the diagnostic to stderr. Forward them on
  # the success path so they are not silently swallowed. Read the temp file
  # synchronously; a process substitution would lose data once `exec` replaces
  # this process.
  if [ -n "$err_file" ] && [ -s "$err_file" ]; then
    belayd_filter_direnv_stderr < "$err_file" >&2
  fi
  [ -z "$err_file" ] || rm -f "$err_file"
  eval "$env_out"
  export BELAYD_SHELL_ACTIVE=1
  exec "$REAL_SHELL" "$@"
fi

if [ "$mode" = "flake" ]; then
  if ! command -v nix >/dev/null 2>&1; then
    belayd_fail "flake.nix exists at $root but nix is not on PATH"
  fi
  # `-c` (not `print-dev-env --json`, which skips the shellHook and the
  # ambient-PATH merge). `nix develop <root> -c` preserves the caller's cwd,
  # verified from a subdirectory of the root.
  export BELAYD_SHELL_ACTIVE=1
  exec nix develop "$root" -c "$REAL_SHELL" "$@"
fi

# shell.nix-only repos cannot use `nix develop`. nix-shell has no argv form, so
# build one `exec` command string with `%q` quoting and let nix-shell run it.
# This covers all four invocation shapes, including interactive/no-argv.
if ! command -v nix-shell >/dev/null 2>&1; then
  belayd_fail "shell.nix exists at $root but nix-shell is not on PATH"
fi
export BELAYD_SHELL_ACTIVE=1
cmd="exec $(printf '%q' "$REAL_SHELL")"
for arg in "$@"; do
  cmd="$cmd $(printf '%q' "$arg")"
done
exec nix-shell "$root" --command "$cmd"
