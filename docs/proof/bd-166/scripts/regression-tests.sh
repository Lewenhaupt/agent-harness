#!/usr/bin/env bash
# bd-166 proof: the regression suites that pin each acceptance item, run one
# file at a time so the per-file test counts are visible.
set -u
. "$(dirname "$0")/lib.sh"

banner "bd-166 regression suites, one file per run"
printf 'date:   %s\n' "$(date -Is)"
printf 'repo:   %s\n' "$REPO"
printf 'commit: %s\n' "$(git -C "$REPO" rev-parse HEAD)"
cd "$REPO" || exit 1

unit_files=(
  src/__tests__/fleet-launch.test.ts
  src/__tests__/fleet-run.test.ts
  src/__tests__/fleet-status.test.ts
  src/__tests__/fleet-sessions.test.ts
  src/__tests__/fleet-reconcile.test.ts
  src/__tests__/fleet-mode.test.ts
  src/__tests__/fleet-state.test.ts
  src/__tests__/extension-fleet-p1.test.ts
)
for f in "${unit_files[@]}"; do
  step "vitest run $f"
  run node_modules/.bin/vitest run "$f"
done

step "vitest run --config vitest.integration.config.ts test/fleet-status.integration.test.ts"
run node_modules/.bin/vitest run --config vitest.integration.config.ts test/fleet-status.integration.test.ts
