#!/usr/bin/env bash
# shellcheck disable=SC2154 # production_* and candidate_* are set by phase() through printf -v
# Upgrade in place, the way a box auto-updates: the production image (what
# boxes run today) starts on a fresh data volume, initialises it, gets a
# validator key the way an owner adds one, finishes epoch sync and header-syncs
# until it is within 2 epochs of the chain head (like a synced box), and is
# stopped like a box stops it (docker stop, 180 s); then the candidate image
# starts on the SAME volume with the same environment.
#
#   scripts/ci/upgrade-test.sh <production-image> <candidate-image> <manifest> <out-dir>
#
# Why "within 2 epochs": nearcore (2.13.4 checked) deletes data/ and syncs
# again from scratch when it starts more than epoch_sync_horizon_num_epochs
# (2) epochs behind the network ("epoch sync data reset marker written",
# "restarting process after epoch sync data reset"). A box that is in sync is
# never that far behind after an update; a test node right after its epoch
# sync is (about 2-3 epochs), so production first catches up to within
# UPGRADE_MAX_LEFT headers (default 80000; 2 epochs are 86400 blocks).
#
# Passes when the candidate
#   - kept validator_key.json and node_key.json byte for byte (sha256), and
#     did not initialise the node again (no "initializing node", no new key),
#   - opened the database production wrote ("the database exists"; a database
#     migration is shown as INFO: it is one-way, see the PR text),
#   - continued the sync where production stopped: no new epoch sync, no data
#     reset, and the height moved forward while watching,
#   - kept running, with no panic or fatal line and no unknown config key.
# The database versions of both neard binaries are shown (a change means a
# one-way migration on the first start of every box).
# Exit code 0: pass. 1: a check failed. 2: only outside problems (production
# did not finish epoch sync or catch up in time, or the candidate's height did
# not move: public network), so the workflow tries once more.
set -uo pipefail

PROD=${1:?usage: upgrade-test.sh <production-image> <candidate-image> <manifest> <out-dir>}
CAND=${2:?usage: upgrade-test.sh <production-image> <candidate-image> <manifest> <out-dir>}
MANIFEST=${3:?usage: upgrade-test.sh <production-image> <candidate-image> <manifest> <out-dir>}
OUT=${4:?usage: upgrade-test.sh <production-image> <candidate-image> <manifest> <out-dir>}
EPOCH_MIN=${UPGRADE_EPOCH_SYNC_MINUTES:-${BOOT_EPOCH_SYNC_MINUTES:-45}}
CATCHUP_MIN=${UPGRADE_CATCHUP_MINUTES:-45}
MAX_LEFT=${UPGRADE_MAX_LEFT:-80000}
HORIZON=${UPGRADE_HORIZON_BLOCKS:-86400}
READY_MIN=${UPGRADE_READY_MINUTES:-10}
WATCH_MIN=${UPGRADE_WATCH_MINUTES:-4}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/ci/lib-near.sh
. "$ROOT/scripts/ci/lib-near.sh"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

die() {
  echo "upgrade-test: $*" >&2
  exit 1
}
log() { echo "upgrade-test: $(date -u +%H:%M:%S) $*" >&2; }

jq -e '.image.volumes[0] == "data:/root/.near"' "$MANIFEST" >/dev/null || die "unexpected volume $(jq -c .image.volumes "$MANIFEST") (expected data:/root/.near)"
docker image inspect "$PROD" >/dev/null 2>&1 || die "production image $PROD not found (scripts/ci/production-image.sh loads it)"
docker image inspect "$CAND" >/dev/null 2>&1 || die "candidate image $CAND not found"

id="avado-upgrade-near-$$"
VOL="$id-data"
cleanup() {
  docker rm -f "$id-production" "$id-candidate" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
}
trap cleanup EXIT

# The environment and privileged flag exactly as the manifest gives them (no
# host ports: nothing needs to reach this node, and the boot test may use them).
args=()
while IFS= read -r e; do args+=(-e "$e"); done < <(jq -r '.image.environment[]' "$MANIFEST")
[ "$(jq -r '.image.privileged // false' "$MANIFEST")" = true ] && args+=(--privileged)
docker volume create "$VOL" >/dev/null || die "cannot create a docker volume"

db_version() { docker run --rm --platform linux/amd64 --entrypoint neard "$1" --version 2>/dev/null | sed -nE 's/.*\(db ([0-9]+)\).*/\1/p' | head -1; }
prod_db=$(db_version "$PROD")
cand_db=$(db_version "$CAND")

# The "left" of the last "Downloading headers" line, or 0 once the node is past
# header sync (block or state sync, or following the head).
left_now() { # <stats.tsv> <genesis>
  awk -F'\t' -v g="$2" '
    $2 == "headers" && $5 != "" { left = $5 + 0; seen = 1 }
    ($2 == "blocks" || $2 == "state" || ($2 == "head" && $3 + 0 > g + 432000)) { left = 0; seen = 1 }
    END { if (seen) print left }' "$1"
}

# phase <label> <image>: runs the image on the shared volume, then stops it the
# way a box does. production: until epoch sync is done and header sync is
# within MAX_LEFT of the head. candidate: until neard logs stats, then
# WATCH_MIN minutes. Sets <label>_ready (neard logged stats), <label>_synced
# ("<line> <height>" of the first height far above genesis), <label>_first /
# <label>_last (heights), <label>_left (headers left at the stop),
# <label>_caught (production got within MAX_LEFT), <label>_stop_s,
# <label>_exit, <label>_restarts, <label>_genesis.
phase() {
  local label=$1 img=$2 c="$id-$1" started ready=0 synced="" first="" last="" genesis="" caught=no left=""
  log "starting the $label image $img on the shared volume"
  started=$(date +%s)
  docker run -d --name "$c" --platform linux/amd64 -v "$VOL:/root/.near" "${args[@]}" "$img" >/dev/null || die "cannot start the $label container"
  local limit=$READY_MIN
  [ "$label" = production ] && limit=$((EPOCH_MIN + CATCHUP_MIN))
  local synced_at="" until=""
  while [ $(($(date +%s) - started)) -lt $((limit * 60)) ]; do
    [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || break
    docker logs "$c" >"$OUT/$label.log" 2>&1
    near_stats "$OUT/$label.log" >"$OUT/$label-stats.tsv"
    [ -s "$OUT/$label-stats.tsv" ] && ready=1
    [ -n "$genesis" ] || genesis=$(near_genesis_height "$c")
    [ -n "$genesis" ] && synced=$(near_synced_from "$OUT/$label-stats.tsv" "$genesis")
    if [ "$label" = production ]; then
      if [ "$ready" = 1 ] && [ ! -f "$OUT/validator-key-added" ]; then
        # The owner adds a validator key (the 0.0.76 tests did the same).
        docker exec "$c" sh -c 'neard --home /tmp/v init --chain-id mainnet --account-id avado-upgrade-test.poolv1.near >/dev/null 2>&1 &&
          cp /tmp/v/validator_key.json /root/.near/validator_key.json && chmod 600 /root/.near/validator_key.json' &&
          touch "$OUT/validator-key-added"
      fi
      if [ -z "$synced" ] && [ $(($(date +%s) - started)) -ge $((EPOCH_MIN * 60)) ]; then break; fi
      if [ -n "$synced" ]; then
        if [ -z "$synced_at" ]; then
          synced_at=$(date +%s)
          log "production: epoch sync done after $((synced_at - started)) s at height ${synced#* }; header sync until fewer than $MAX_LEFT headers are left (at most $CATCHUP_MIN minutes)"
        fi
        left=$(left_now "$OUT/$label-stats.tsv" "$genesis")
        if [ -n "$left" ] && [ "$left" -le "$MAX_LEFT" ]; then caught=yes; break; fi
        [ $(($(date +%s) - synced_at)) -ge $((CATCHUP_MIN * 60)) ] && break
      fi
    else
      if [ "$ready" = 1 ] && [ -z "$until" ]; then
        until=$(($(date +%s) + WATCH_MIN * 60))
        log "candidate: neard runs after $(($(date +%s) - started)) s; watching $WATCH_MIN minutes"
      fi
      [ -n "$until" ] && [ "$(date +%s)" -ge "$until" ] && break
    fi
    sleep 20
  done
  local restarts stop_s="" code
  restarts=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null)
  if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ]; then
    local t0
    t0=$(date +%s)
    docker stop -t 180 "$c" >/dev/null 2>&1
    stop_s=$(($(date +%s) - t0))
  fi
  code=$(docker inspect -f '{{.State.ExitCode}}' "$c" 2>/dev/null)
  docker logs "$c" >"$OUT/$label.log" 2>&1
  near_stats "$OUT/$label.log" >"$OUT/$label-stats.tsv"
  # The candidate starts at the genesis head ("Waiting for peers") and jumps
  # to where production stopped: its first real height is the first one far
  # above genesis. The last height is the highest seen (state sync after
  # header sync reports the block head again).
  [ -n "$genesis" ] && synced=$(near_synced_from "$OUT/$label-stats.tsv" "$genesis")
  [ -n "$synced" ] && first=${synced#* }
  last=$(awk -F'\t' '$7 != "" && $7 + 0 > h { h = $7 + 0 } END { if (h) print h }' "$OUT/$label-stats.tsv")
  [ -n "$genesis" ] && left=$(left_now "$OUT/$label-stats.tsv" "$genesis")
  docker rm "$c" >/dev/null 2>&1
  near_volume_facts "$VOL" "$CAND" >"$OUT/volume-after-$label.txt"
  printf -v "${label}_ready" '%s' "$ready"
  printf -v "${label}_synced" '%s' "$synced"
  printf -v "${label}_first" '%s' "$first"
  printf -v "${label}_last" '%s' "$last"
  printf -v "${label}_left" '%s' "$left"
  printf -v "${label}_caught" '%s' "$caught"
  printf -v "${label}_stop_s" '%s' "$stop_s"
  printf -v "${label}_exit" '%s' "$code"
  printf -v "${label}_restarts" '%s' "$restarts"
  printf -v "${label}_genesis" '%s' "$genesis"
}

phase production "$PROD"
[ -n "$production_synced" ] || log "production did not finish epoch sync within $EPOCH_MIN minutes; the candidate still starts on its volume (keys, database, init are checked)"
phase candidate "$CAND"

# --- verdict ------------------------------------------------------------------------
fails=0
outside_only=1
: >"$OUT/result.tsv"
check() { # <PASS|FAIL|INFO> <name> <detail> [outside]
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$OUT/result.tsv"
  printf '  %-5s %-18s %s\n' "$1" "$2" "$3"
  if [ "$1" = FAIL ]; then
    fails=$((fails + 1))
    [ "${4:-}" = outside ] || outside_only=0
  fi
  return 0
}
fact() { awk -v f="$1" '$1 == f { $1 = ""; sub(/^ /, ""); print }' "$2"; }
cand() { near_clean "$OUT/candidate.log"; }
# Was production within the horizon when it stopped? (Then a restart must not
# reset anything.)
within=no
[ -n "$production_left" ] && [ "$production_left" -lt "$HORIZON" ] && within=yes

check INFO images "production $PROD (database version ${prod_db:-?}), candidate $CAND (database version ${cand_db:-?})"
if [ -n "$prod_db" ] && [ -n "$cand_db" ] && [ "$prod_db" != "$cand_db" ]; then
  check INFO db-migration "ONE-WAY: the candidate's neard uses database version $cand_db, production's $prod_db: every box migrates its database on the first start and cannot go back"
fi
if [ -z "$production_synced" ]; then
  check FAIL production-ran "production did not finish epoch sync within $EPOCH_MIN minutes (public network: NEAR peers did not answer); the update could not be tried on a real header chain" outside
elif [ "$within" = no ]; then
  check FAIL production-ran "production finished epoch sync (height ${production_synced#* }) but was still ${production_left:-?} headers behind the head after $CATCHUP_MIN minutes of header sync (a synced box is within 2 epochs = $HORIZON blocks); public network or a slow runner" outside
else
  check PASS production-ran "production finished epoch sync (height ${production_synced#* }), header-synced to height ${production_last:-?} (${production_left} headers behind the head, within 2 epochs like a synced box); stopped in ${production_stop_s:-?} s (exit ${production_exit:-?})"
fi
[ -f "$OUT/validator-key-added" ] || check FAIL validator-key "could not add a validator key to the production node (see production.log)"

before="$OUT/volume-after-production.txt"
after="$OUT/volume-after-candidate.txt"
for f in node_key.json validator_key.json; do
  b=$(fact "$f" "$before")
  a=$(fact "$f" "$after")
  if [ -n "$b" ] && [ "$b" != missing ] && [ "$a" = "$b" ]; then
    check PASS "$f" "byte for byte the same after the update (sha256 ${b:0:16}...)"
  else
    check FAIL "$f" "changed or missing after the update (before: ${b:-?}, after: ${a:-?})"
  fi
done
[ "$(fact genesis.json "$before")" = "$(fact genesis.json "$after")" ] ||
  check INFO genesis.json "genesis.json changed after the update (before $(fact genesis.json "$before" | cut -c1-16), after $(fact genesis.json "$after" | cut -c1-16))"
check INFO data "data/ before the update: $(fact data "$before"); after: $(fact data "$after")"

reinit=$(cand | grep -E 'initializing node|using key for account|generated .* genesis file' | head -2 | cut -c1-160 | tr '\n' ' ')
if [ -z "$reinit" ]; then
  check PASS no-reinit "the candidate did not initialise the node again"
else
  check FAIL no-reinit "the candidate initialised the node again: $reinit"
fi
# The candidate's FIRST database line: nearcore may later reset data/ by itself
# (see the reset check).
opened=$(cand | grep -m1 -oE "the database exists|the database doesn't exist, creating it" || true)
if [ "$opened" = "the database exists" ]; then
  check PASS kept-database "the candidate opened the database production wrote"
else
  check FAIL kept-database "the candidate did not open the database production wrote (${opened:-no database line}; see candidate.log)"
fi
migr=$(cand | grep -iE 'migrat' | head -3 | cut -c1-200 | tr '\n' ' ')
[ -z "$migr" ] || check INFO migration-log "$migr"
fatal=$(near_fatal_lines "$OUT/candidate.log" | head -3 | cut -c1-200 | tr '\n' ' ')
if [ -z "$fatal" ]; then check PASS fatal-lines "no panic or fatal line in the candidate's log"; else check FAIL fatal-lines "$fatal"; fi
unknown=$(cand | grep 'encountered unrecognized fields' | head -1 | sed -nE 's/.*fields=(.*)$/\1/p')
[ -z "$unknown" ] || check FAIL config-keys "the candidate's neard ignores config.json keys: $unknown"
if [ "$candidate_ready" = 1 ] && [ "${candidate_restarts:-0}" = 0 ] && [ -n "$candidate_stop_s" ]; then
  check PASS process "the candidate started once and kept running; stopped in $candidate_stop_s s (exit ${candidate_exit:-?})"
else
  check FAIL process "the candidate did not keep running (neard logged stats: $candidate_ready, exit ${candidate_exit:-?}, restarts ${candidate_restarts:-?})"
fi

reset=$(cand | grep -m1 -E 'epoch sync data reset|EpochSyncDataReset' | cut -c1-200 || true)
back=$(awk -F'\t' '$2 == "epoch"' "$OUT/candidate-stats.tsv" | wc -l | tr -d ' ')
if [ "$within" = yes ]; then
  if [ -n "$reset" ]; then
    check FAIL sync-continues "the candidate threw away the database production had synced (nearcore epoch sync data reset) although production was only $production_left headers behind: an update would make every box sync again ($reset)"
  elif [ "$back" != 0 ]; then
    check FAIL sync-continues "the candidate started epoch sync again ($back stats lines) although production was only $production_left headers behind: an update would make every box sync again"
  elif [ -n "$candidate_last" ] && [ -n "$production_last" ] && [ "$candidate_last" -ge "$production_last" ] &&
    [ -n "$candidate_first" ] && [ $((candidate_last - candidate_first)) -ge 100 ]; then
    check PASS sync-continues "production stopped at height $production_last; the candidate went on from $candidate_first to $candidate_last"
  else
    check FAIL sync-continues "the candidate's height did not move forward (production stopped at ${production_last:-?}; candidate ${candidate_first:-?} -> ${candidate_last:-?})" outside
  fi
elif [ -n "$reset" ]; then
  check INFO nearcore-reset "production stopped more than 2 epochs behind, so nearcore reset data/ and began a new epoch sync, as it does on any node that far behind"
fi

if [ "$fails" = 0 ]; then
  echo "PASS: the candidate upgraded a production node in place"
  exit 0
fi
echo "FAIL: $fails upgrade check(s) failed (logs: $OUT/production.log, $OUT/candidate.log)" >&2
echo "----- last 30 lines of the candidate's log" >&2
near_clean "$OUT/candidate.log" | grep -vE 'failed to read parameter|set_kernel_params|received bad block' | tail -30 >&2
[ "$outside_only" = 1 ] && exit 2
exit 1
