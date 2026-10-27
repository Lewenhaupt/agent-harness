#!/usr/bin/env bash
# bd-166 acceptance: a run that finishes (partial) and a run that halts release
# their non-landed members; a PAUSED run releases nothing.
set -u
. "$(dirname "$0")/lib.sh"

banner "bd-166 terminal-run release: run-complete / run-halted / paused"
printf 'date:   %s\n' "$(date -Is)"
printf 'repo:   %s\n' "$REPO"
printf 'commit: %s\n' "$(git -C "$REPO" rev-parse HEAD)"

########################################################################
step "CASE 1 — run finishes 0-for-N (no worktrees, no beads db): releases run-complete"
########################################################################
runrepo=/tmp/bd166-proof-complete
cmd "rm -rf $runrepo && mkdir -p $runrepo && cd $runrepo && git init -q -b main ..."
rm -rf "$runrepo"
mkdir -p "$runrepo"
cd "$runrepo" || exit 1
git_init
mkdir -p "$runrepo/.git/belayd/fleet/default"
jq -nc '{schemaVersion:1,fleetId:"default",taskIds:["bd-20","bd-21"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",supervisor:{sessionId:"dead-session",pid:999999}}' \
  > "$runrepo/.git/belayd/fleet/default/fleet.json"
printf '[exit=%s]\n' "$?"
cmd "jq -c '{taskIds, released, run: .run.outcome}' .git/belayd/fleet/default/fleet.json"
jq -c '{taskIds, released, run: .run.outcome}' .git/belayd/fleet/default/fleet.json
printf '[exit=%s]\n' "$?"

step "launch until-complete and let the real ticker run (10 s), then status"
run timeout 120 "$J" "$DRIVER" "$REPO" "$runrepo" '[
  ["belayd_fleet_launch",{"tasks":["bd-20","bd-21"],"fleetId":"default"}]]' 10000

step "ON DISK: released[] reasons + members-released audit entry"
cmd "jq -c '{taskIds, released, outcome: .run.outcome}' .git/belayd/fleet/default/fleet.json"
jq -c '{taskIds, released, outcome: .run.outcome}' .git/belayd/fleet/default/fleet.json
printf '[exit=%s]\n' "$?"
cmd "grep members-released .git/belayd/fleet/default/audit.log"
grep members-released .git/belayd/fleet/default/audit.log
printf '[exit=%s]\n' "$?"

########################################################################
step "CASE 2 — run halts (root checkout parked): releases run-halted"
########################################################################
halt=/tmp/bd166-proof-parked
cmd "rm -rf $halt && mkdir -p $halt && cd $halt && git init -q -b main ..."
rm -rf "$halt"
mkdir -p "$halt"
cd "$halt" || exit 1
git_init
mkdir -p "$halt/.git/belayd/fleet/default"
jq -nc '{schemaVersion:1,fleetId:"default",taskIds:["bd-40","bd-41"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",park:{reason:"root restore conflicted",stashRef:"refs/stash@{0}",recordedAt:1},supervisor:{sessionId:"dead-session",pid:999999}}' \
  > "$halt/.git/belayd/fleet/default/fleet.json"
printf '[exit=%s]\n' "$?"

step "launch until-complete and let the real ticker stop on the parked root (6 s)"
run timeout 120 "$J" "$DRIVER" "$REPO" "$halt" '[
  ["belayd_fleet_launch",{"tasks":["bd-40","bd-41"],"fleetId":"default"}]]' 6000

step "ON DISK: released[] reasons + members-released audit entry"
cmd "jq -c '{taskIds, released, haltedReason: .run.haltedReason}' .git/belayd/fleet/default/fleet.json"
jq -c '{taskIds, released, haltedReason: .run.haltedReason}' .git/belayd/fleet/default/fleet.json
printf '[exit=%s]\n' "$?"
cmd "grep members-released .git/belayd/fleet/default/audit.log"
grep members-released .git/belayd/fleet/default/audit.log
printf '[exit=%s]\n' "$?"

########################################################################
step "CASE 3 — run is PAUSED (resumable): nothing is released"
########################################################################
pause=/tmp/bd166-proof-paused
cmd "rm -rf $pause && mkdir -p $pause && cd $pause && git init -q -b main ..."
rm -rf "$pause"
mkdir -p "$pause"
cd "$pause" || exit 1
git_init
mkdir -p "$pause/.git/belayd/fleet/default"
jq -nc '{schemaVersion:1,fleetId:"default",taskIds:["bd-30","bd-31"],createdAt:1,updatedAt:1,maxConcurrent:3,baseBranch:"main",paused:true,note:"stepping away",supervisor:{sessionId:"dead-session",pid:999999}}' \
  > "$pause/.git/belayd/fleet/default/fleet.json"
printf '[exit=%s]\n' "$?"

step "launch until-complete on a paused fleet and let the real ticker run (6 s)"
run timeout 120 "$J" "$DRIVER" "$REPO" "$pause" '[
  ["belayd_fleet_launch",{"tasks":["bd-30","bd-31"],"fleetId":"default"}]]' 6000

step "ON DISK: no released[] entries, no members-released audit line"
cmd "jq -c '{taskIds, released, paused, haltedReason: .run.haltedReason}' .git/belayd/fleet/default/fleet.json"
jq -c '{taskIds, released, paused, haltedReason: .run.haltedReason}' .git/belayd/fleet/default/fleet.json
printf '[exit=%s]\n' "$?"
cmd "grep -c members-released .git/belayd/fleet/default/audit.log || echo 'no members-released audit line (expected)'"
grep -c members-released .git/belayd/fleet/default/audit.log || echo 'no members-released audit line (expected)'
printf '[exit=%s]\n' "$?"
