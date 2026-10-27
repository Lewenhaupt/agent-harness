#!/usr/bin/env bash
# bd-166 proof: the acceptance gates, run in this worktree, in order.
set -u
. "$(dirname "$0")/lib.sh"

banner "bd-166 gates"
printf 'date:   %s\n' "$(date -Is)"
printf 'repo:   %s\n' "$REPO"
printf 'commit: %s\n' "$(git -C "$REPO" rev-parse HEAD)"
printf 'branch: %s\n' "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
cd "$REPO" || exit 1

step "pnpm test (unit)"
run pnpm test
step "pnpm test:integration"
run pnpm test:integration
step "pnpm typecheck (tsc --noEmit)"
run pnpm typecheck
step "pnpm lint (biome check .)"
run pnpm lint
step "pnpm build (tsc)"
run pnpm build
