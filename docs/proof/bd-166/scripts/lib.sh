#!/usr/bin/env bash
# Shared helpers for the bd-166 proof scenarios. Every scenario drives the REAL
# extension code paths (extensions/index.ts loaded through jiti), never fixtures
# with hand-written expected output.
REPO=/home/hugo/git/feat-bd-166
J="$REPO/node_modules/.bin/jiti"
DRIVER="$REPO/docs/proof/bd-166/scripts/bd166-fleet.ts"

step() { printf '\n\n### %s — %s\n' "$(date -Is)" "$*"; }
cmd() { printf '\n$ %s\n' "$*"; }
banner() { printf '\n=== %s\n' "$*"; }

# Run a command, print the exact argv, keep stdout+stderr interleaved, print the exit code.
run() {
  printf '\n$ %s\n' "$*"
  "$@"
  local rc=$?
  printf '[exit=%s]\n' "$rc"
  return "$rc"
}

git_init() {
  git init -q -b main >/dev/null
  git config user.email t@example.invalid
  git config user.name Test
  printf 'x\n' > README.md
  printf '.belayd/\n' > .gitignore
  git add -A
  git commit -qm base
}
