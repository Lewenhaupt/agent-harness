#!/usr/bin/env bash
# bd-166 acceptance: the SAFETY directions of the new tools.
#   A. belayd_fleet_release refuses a non-member and a member whose orchestrator is live.
#   B. belayd_fleet_reconcile refuses a cross-fleet pruneDeadMembers, while still
#      allowing (and auditing `reconcile-cross-fleet` for) cross-fleet queue/park repair.
set -u
. "$(dirname "$0")/lib.sh"

banner "bd-166 refusal directions: release safety + cross-fleet prune authority"
printf 'date:   %s\n' "$(date -Is)"
printf 'repo:   %s\n' "$REPO"
printf 'commit: %s\n' "$(git -C "$REPO" rev-parse HEAD)"

########################################################################
step "A1 — belayd_fleet_release refuses an id that is not a member of this fleet"
########################################################################
v=/tmp/bd166-proof-refuse
cmd "rm -rf $v $v.feat-* && mkdir -p $v && cd $v && git init -q -b main ..."
rm -rf "$v" "$v".feat-*
mkdir -p "$v"
cd "$v" || exit 1
git_init
git worktree add -q -b feat/bd-12 "$v.feat-bd-12"
mkdir -p "$v/.git/belayd/fleet/default"
jq -nc '{schemaVersion:1,fleetId:"default",taskIds:["bd-12","bd-15"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",supervisor:{sessionId:"dead-session",pid:999999}}' \
  > "$v/.git/belayd/fleet/default/fleet.json"
printf '[exit=%s]\n' "$?"

step "re-arm (recorded supervisor is dead), then release bd-99 which is not a member"
run timeout 120 "$J" "$DRIVER" "$REPO" "$v" '[
  ["belayd_fleet_launch",{"tasks":["bd-12","bd-15"],"fleetId":"default","untilComplete":false}],
  ["belayd_fleet_release",{"taskId":"bd-99"}]]'

########################################################################
step "A2 — belayd_fleet_release refuses a member whose orchestrator is live"
########################################################################
now=$(node -e 'console.log(Date.now())')
cmd "write a fresh orchestrator lease for bd-12 (sessionId sess-live, pid 12345)"
mkdir -p "$v.feat-bd-12/.belayd"
printf '{"schemaVersion":1,"taskId":"bd-12","branch":"feat/bd-12","sessionId":"sess-live","pid":12345,"claimedAt":%s,"heartbeatAt":%s}' "$now" "$now" \
  > "$v.feat-bd-12/.belayd/orchestrator.json"
printf '[exit=%s]\n' "$?"

step "re-arm, then release bd-12 — refused; status shows the member as live (counted)"
run timeout 120 "$J" "$DRIVER" "$REPO" "$v" '[
  ["belayd_fleet_launch",{"tasks":["bd-12","bd-15"],"fleetId":"default","untilComplete":false}],
  ["belayd_fleet_release",{"taskId":"bd-12"}],
  ["belayd_fleet_status",{}]]'

step "A3 — nothing was released: fleet.json keeps bd-12 and has no released[] entry"
cmd "jq -c '{taskIds, released}' .git/belayd/fleet/default/fleet.json"
jq -c '{taskIds, released}' .git/belayd/fleet/default/fleet.json
printf '[exit=%s]\n' "$?"

########################################################################
step "B — cross-fleet reconcile: repair allowed + audited, prune refused"
########################################################################
cross=/tmp/bd166-proof-cross
cmd "rm -rf $cross && mkdir -p $cross && cd $cross && git init -q -b main ..."
rm -rf "$cross"
mkdir -p "$cross"
cd "$cross" || exit 1
git_init
mkdir -p "$cross/.git/belayd/fleet/owned" "$cross/.git/belayd/fleet/orphan"
jq -nc '{schemaVersion:1,fleetId:"owned",taskIds:["bd-60"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",supervisor:{sessionId:"dead-session",pid:999999}}' > "$cross/.git/belayd/fleet/owned/fleet.json"
jq -nc '{schemaVersion:1,fleetId:"orphan",taskIds:["bd-70"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",supervisor:{sessionId:"dead-session",pid:999999}}' > "$cross/.git/belayd/fleet/orphan/fleet.json"
printf '[exit=%s]\n' "$?"

step "this session supervises owned; reconcile orphan by name (repair only) -> allowed, exit 0"
run timeout 120 "$J" "$DRIVER" "$REPO" "$cross" '[
  ["belayd_fleet_launch",{"tasks":["bd-60"],"fleetId":"owned","untilComplete":false}],
  ["belayd_fleet_reconcile",{"fleetId":"orphan"}]]'

step "same call with pruneDeadMembers on orphan -> refused, exit 1"
run timeout 120 "$J" "$DRIVER" "$REPO" "$cross" '[
  ["belayd_fleet_launch",{"tasks":["bd-60"],"fleetId":"owned","untilComplete":false}],
  ["belayd_fleet_reconcile",{"fleetId":"orphan","pruneDeadMembers":true}]]'

step "the repair is audited on the TARGET fleet; orphan's members are untouched"
cmd "cat .git/belayd/fleet/orphan/audit.log"
cat .git/belayd/fleet/orphan/audit.log
printf '[exit=%s]\n' "$?"
cmd "jq -c '.taskIds' .git/belayd/fleet/orphan/fleet.json"
jq -c '.taskIds' .git/belayd/fleet/orphan/fleet.json
printf '[exit=%s]\n' "$?"

step "own fleet, named explicitly: prune is allowed (no reconcile-cross-fleet audit line)"
run timeout 120 "$J" "$DRIVER" "$REPO" "$cross" '[
  ["belayd_fleet_launch",{"tasks":["bd-60"],"fleetId":"owned","untilComplete":false}],
  ["belayd_fleet_reconcile",{"fleetId":"owned","pruneDeadMembers":true}]]'
cmd "grep -c reconcile-cross-fleet .git/belayd/fleet/owned/audit.log || echo 'no reconcile-cross-fleet line for the own-fleet reconcile (expected)'"
grep -c reconcile-cross-fleet .git/belayd/fleet/owned/audit.log || echo 'no reconcile-cross-fleet line for the own-fleet reconcile (expected)'
printf '[exit=%s]\n' "$?"
