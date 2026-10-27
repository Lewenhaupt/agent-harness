#!/usr/bin/env bash
# bd-166 acceptance: liveness-aware capacity + operator release.
# Scratch repo: 4 recorded members over TWO fleets so the shared ceiling of 3
# binds (counted 3, free 0), then bd-22 becomes absent (its own execution is
# accounted for, nothing running it), then bd-15 is released by the operator.
set -u
. "$(dirname "$0")/lib.sh"

banner "bd-166 capacity arithmetic — >3 recorded members across two fleets"
printf 'date:   %s\n' "$(date -Is)"
printf 'repo:   %s\n' "$REPO"
printf 'commit: %s\n' "$(git -C "$REPO" rev-parse HEAD)"
printf 'scratch: /tmp/bd166-proof-capacity\n'

root=/tmp/bd166-proof-capacity
cmd "rm -rf $root $root.feat-* && mkdir -p $root && cd $root && git init -q -b main ..."
rm -rf "$root" "$root".feat-*
mkdir -p "$root"
cd "$root" || exit 1
git_init
git worktree add -q -b feat/bd-12 "$root.feat-bd-12"
git worktree add -q -b feat/bd-15 "$root.feat-bd-15"
git worktree add -q -b feat/bd-22 "$root.feat-bd-22"
printf '[exit=%s]\n' "$?"

banner "bd-12 already absent: worktree holds workflow.json, no orchestrator lease"
mkdir -p "$root.feat-bd-12/.belayd"
printf '%s\n' "{\"schemaVersion\":1,\"taskId\":\"bd-12\",\"workflowType\":\"feature\",\"branch\":\"feat/bd-12\",\"originalCwd\":\"$root.feat-bd-12\",\"phaseOrder\":[\"plan\",\"implement\",\"review\",\"test\",\"userguide\",\"proof\",\"commit\"],\"completedPhaseNames\":[\"plan\",\"implement\",\"review\"],\"awaitingReviewResponse\":true,\"startedAt\":1761000000000,\"updatedAt\":1761000900000}" > "$root.feat-bd-12/.belayd/workflow.json"
printf '%s\n' "bd-15  bare worktree, no state, no lease, no manifest -> unknown (mid-spawn, counted)" \
  "bd-22  bare worktree                                        -> unknown (mid-spawn, counted)" \
  "bd-23  no worktree at all                                   -> unknown (counted) + stale-member"

banner "two fleets, 2 recorded members each"
mkdir -p "$root/.git/belayd/fleet/default" "$root/.git/belayd/fleet/night"
printf '%s\n' '{"schemaVersion":1,"fleetId":"default","taskIds":["bd-12","bd-15"],"createdAt":1761000000000,"updatedAt":1761000900000,"maxConcurrent":3,"baseBranch":"main","supervisor":{"sessionId":"dead-session","pid":999999}}' > "$root/.git/belayd/fleet/default/fleet.json"
printf '%s\n' '{"schemaVersion":1,"fleetId":"night","taskIds":["bd-22","bd-23"],"createdAt":1761000000000,"updatedAt":1761000900000,"maxConcurrent":3,"baseBranch":"main","supervisor":{"sessionId":"dead-session","pid":999999}}' > "$root/.git/belayd/fleet/night/fleet.json"
cmd "jq -c '{fleetId, taskIds}' .git/belayd/fleet/*/fleet.json"
jq -c '{fleetId, taskIds}' .git/belayd/fleet/*/fleet.json
printf '[exit=%s]\n' "$?"

step "BEFORE: ceiling binds — 4 recorded members, 3 counted (bd-12 absent, bd-15/bd-22/bd-23 unknown)"
run "$J" "$DRIVER" "$REPO" "$root" '[["belayd_fleet_status",{}]]'

banner "bd-22 becomes absent: its own execution is accounted for (workflow.json, nothing running it)"
mkdir -p "$root.feat-bd-22/.belayd"
printf '%s\n' "{\"schemaVersion\":1,\"taskId\":\"bd-22\",\"workflowType\":\"feature\",\"branch\":\"feat/bd-22\",\"originalCwd\":\"$root.feat-bd-22\",\"phaseOrder\":[\"plan\",\"implement\",\"review\",\"test\",\"userguide\",\"proof\",\"commit\"],\"completedPhaseNames\":[\"plan\",\"implement\",\"review\"],\"awaitingReviewResponse\":true,\"startedAt\":1761000000000,\"updatedAt\":1761000900000}" > "$root.feat-bd-22/.belayd/workflow.json"
printf '[exit=%s]\n' "$?"

step "AFTER ABSENT: counted 3 -> 2, free 0 -> 1 (bd-22 no longer holds a slot)"
run "$J" "$DRIVER" "$REPO" "$root" '[["belayd_fleet_status",{}]]'

step "RELEASE: re-arm (supervisor was dead), then belayd_fleet_release bd-15, then status"
run "$J" "$DRIVER" "$REPO" "$root" '[
  ["belayd_fleet_launch",{"tasks":["bd-12","bd-15"],"fleetId":"default","untilComplete":false}],
  ["belayd_fleet_release",{"taskId":"bd-15"}],
  ["belayd_fleet_status",{}]]'

step "ON DISK: released[] in fleet.json + member-released audit line (member/branch/worktree kept)"
cmd "jq -c '{taskIds, released}' .git/belayd/fleet/default/fleet.json"
jq -c '{taskIds, released}' .git/belayd/fleet/default/fleet.json
printf '[exit=%s]\n' "$?"
cmd "grep member-released .git/belayd/fleet/default/audit.log"
grep member-released .git/belayd/fleet/default/audit.log
printf '[exit=%s]\n' "$?"
cmd "git worktree list"
git worktree list
printf '[exit=%s]\n' "$?"
