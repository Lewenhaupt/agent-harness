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
# belayd-aws (src/aws-broker) — resolves the per-repo AWS sandbox plan. Absent
# (or not executable) means this wrapper never wraps, which is the dev-machine
# and test default.
AWS_SANDBOX="${BELAYD_AWS_SANDBOX:-@awsSandbox@}"

belayd_warn() { printf 'belayd-shell: %s\n' "$1" >&2; }
belayd_fail() { printf 'belayd-shell: %s\n' "$1" >&2; exit 1; }

# On NixOS, /etc/set-environment unconditionally rewrites PATH to the plain
# system profile, clobbering the devShell env resolved below — and the ambient
# pi-web runtime PATH when no devShell applies — dropping tools like
# bd/dolt/pnpm/playwright. Two startup paths reach it, gated by two different
# variables, so both are set here:
#   * interactive non-login bash reads /etc/bashrc, which sources /etc/profile
#     unless __ETC_PROFILE_DONE is set (pi-web pty terminals, agent bash tool);
#   * login bash reads /etc/profile directly, which sources /etc/set-environment
#     unless __NIXOS_SET_ENVIRONMENT_DONE is set (pi-web terminal.runCommand
#     uses a hardcoded `-lc`, so every plugin runCommand, e.g. the Trace Viewer
#     button, hits this path).
# The variables are inert elsewhere; an explicit `exec bash -l` after this
# wrapper can still re-source /etc/profile as the escape hatch.
export __ETC_PROFILE_DONE=1
export __NIXOS_SET_ENVIRONMENT_DONE=1

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

# Prefix a captured stderr file line by line, so a planner warning or refusal
# reads as this wrapper's own diagnostic.
belayd_prefix_stderr() {
  local line
  while IFS= read -r line; do
    if [ -n "$line" ]; then printf 'belayd-shell: %s\n' "$line" >&2; fi
  done < "$1"
}

# Filled by the AWS block below when a per-repo sandbox plan resolves; an empty
# array means "run unwrapped" (no AWS config, or the planner refused). Declared
# before `belayd_exec` is defined so the helper always expands it under `set -u`.
sandbox_argv=()

# Exec the final command, wrapped in the per-repo AWS sandbox when a plan
# resolved. Every routing branch below goes through this helper, so routing
# still runs first and only the *final* command is wrapped: direnv's
# status/allow check and `direnv export bash` run in this process (outside the
# mask) and the environment they export is inherited by the sandboxed command,
# while `nix develop`/`nix-shell` are themselves the wrapped command (inside the
# mask). Exec'ing REAL_SHELL straight from the AWS block instead would silently
# skip the devShell for a repo carrying both `.belayd/aws.yaml` and
# `.envrc`/`flake.nix`.
belayd_exec() {
  if [ "${#sandbox_argv[@]}" -gt 0 ]; then
    exec "${sandbox_argv[@]}" -- "$@"
  fi
  exec "$@"
}

# Re-enter through the per-repo AWS sandbox when the current git toplevel
# carries a `.belayd/aws.yaml` (bd-125). This is what turns "agent with the
# operator's ~/.aws" into "agent with one scoped profile": bubblewrap masks
# ~/.aws, ~/.config/aws and every other repo's scope socket, then re-exposes
# only this worktree's generated credential_process profile.
#
# The plan is resolved *before* the devShell routing below because `belayd_exec`
# needs its argv, but the routing itself still happens first (see `belayd_exec`):
# this block only decides whether the final command is wrapped. Every step is
# best-effort and silent for the common case: a missing planner, a non-git cwd,
# or a repo without the marker leaves the rest of this wrapper byte-identical.
# Recursion is stopped by BELAYD_SANDBOX_ACTIVE, which the plan exports via bwrap
# --setenv. The plan is asked for a NUL-separated argv (never eval'd) so paths
# with spaces and quoted arguments survive.
if [ -z "${BELAYD_SANDBOX_ACTIVE:-}" ] && [ -x "$AWS_SANDBOX" ]; then
  sandbox_toplevel="$(git rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$sandbox_toplevel" ] && [ -f "$sandbox_toplevel/.belayd/aws.yaml" ]; then
    sandbox_plan_file="$(mktemp 2>/dev/null)"
    sandbox_plan_err="$(mktemp 2>/dev/null)"
    if [ -n "$sandbox_plan_file" ] && [ -n "$sandbox_plan_err" ]; then
      if "$AWS_SANDBOX" plan --worktree "$sandbox_toplevel" --print0 \
        >"$sandbox_plan_file" 2>"$sandbox_plan_err"; then
        mapfile -d '' sandbox_argv < "$sandbox_plan_file"
        # The planner warns here when the broker is unreachable (it still
        # prints the plan, because the mask is the security property).
        if [ -s "$sandbox_plan_err" ]; then belayd_prefix_stderr "$sandbox_plan_err"; fi
      else
        # A repo that opted into AWS but was refused (bad profile, malformed
        # allowlist) must be visible: the command still runs, unwrapped and
        # without AWS, and the reason goes to stderr.
        belayd_prefix_stderr "$sandbox_plan_err"
      fi
      rm -f "$sandbox_plan_file" "$sandbox_plan_err"
    fi
  fi
fi

# No recursion: a process already inside a devShell must not re-enter one (that
# would deadlock nix/direnv). A consequence: a process already inside one repo's
# devShell will NOT switch to another repo's devShell — it gets the ambient
# shell. Nested shells inside one project inherit the enclosing devShell, which
# is the desired behavior.
if [ -n "${BELAYD_SHELL_ACTIVE:-}" ]; then
  belayd_exec "$REAL_SHELL" "$@"
fi

# Walk up from $PWD to the first devShell marker. `.pi/no-devshell` stops the
# walk and forces pass-through, so a repo can opt out even when an ancestor
# directory carries a marker.
root=""
mode=""
dir="${PWD:-$(pwd)}"
while [ -n "$dir" ]; do
  if [ -e "$dir/.pi/no-devshell" ]; then
    belayd_exec "$REAL_SHELL" "$@"
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
# output. (The profile guard exported above is the only env change, and it
# exists precisely to keep this branch's inherited PATH from being clobbered by
# an interactive shell's startup files.)
if [ -z "$mode" ]; then
  belayd_exec "$REAL_SHELL" "$@"
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
  belayd_exec "$REAL_SHELL" "$@"
fi

if [ "$mode" = "flake" ]; then
  if ! command -v nix >/dev/null 2>&1; then
    belayd_fail "flake.nix exists at $root but nix is not on PATH"
  fi
  # `-c` (not `print-dev-env --json`, which skips the shellHook and the
  # ambient-PATH merge). `nix develop <root> -c` preserves the caller's cwd,
  # verified from a subdirectory of the root.
  export BELAYD_SHELL_ACTIVE=1
  belayd_exec nix develop "$root" -c "$REAL_SHELL" "$@"
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
belayd_exec nix-shell "$root" --command "$cmd"
