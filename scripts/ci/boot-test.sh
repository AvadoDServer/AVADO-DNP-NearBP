#!/usr/bin/env bash
# Boots the package image on NEAR mainnet the way a new install does, and
# watches it.
#
#   scripts/ci/boot-test.sh <image> <manifest> <out-dir>
#
# <manifest> is the package's dappnode_package.json: the container gets its
# environment, ports, privileged flag and volume (data:/root/.near) exactly as
# the DAPPMANAGER gives them, on a fresh volume, and runs its own entrypoint
# (neard init on the empty volume, our config.json, exec neard run).
#
# Passes when, within BOOT_EPOCH_SYNC_MINUTES (default 45) of the start, and
# then BOOT_WATCH_MINUTES (default 4) of watching:
#   - the entrypoint initialised the empty volume once (node_key.json, genesis),
#     neard started once and kept running, with no panic or fatal line and no
#     "encountered unrecognized fields" warning,
#   - the RPC answers inside the container: chain_id "mainnet" and the nearcore
#     version of the manifest's "upstream",
#   - neard listens on the p2p port of its config (24567) and the manifest
#     publishes it, so peers can reach it,
#   - an epoch sync proof was accepted (the node jumped from the genesis height
#     to a recent header) and header sync moved forward while watching,
#   - it had at least BOOT_MIN_PEERS peers (default 3; a GitHub runner cannot
#     accept inbound connections),
#   - it stops cleanly (docker stop, 180 s like a box: exit 0).
# A fresh node asks one random peer at a time for the ~51 MB epoch sync proof,
# and busy peers often do not answer: in the 0.0.76 tests a fresh node needed
# 11-26 minutes, sometimes more than 38. That is the public network, not the
# package.
# Exit code 0: pass. 1: a check failed. 2: only checks that depend on the
# public network failed (epoch sync, header sync moving, peers), so the
# workflow tries once more on a fresh volume before it reports a failure.
set -uo pipefail

IMAGE=${1:?usage: boot-test.sh <image> <manifest> <out-dir>}
MANIFEST=${2:?usage: boot-test.sh <image> <manifest> <out-dir>}
OUT=${3:?usage: boot-test.sh <image> <manifest> <out-dir>}
EPOCH_MIN=${BOOT_EPOCH_SYNC_MINUTES:-45}
WATCH_MIN=${BOOT_WATCH_MINUTES:-4}
MIN_PEERS=${BOOT_MIN_PEERS:-3}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/ci/lib-near.sh
. "$ROOT/scripts/ci/lib-near.sh"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

die() {
  echo "boot-test: $*" >&2
  exit 1
}
log() { echo "boot-test: $(date -u +%H:%M:%S) $*" >&2; }

jq -e '.image.volumes[0] == "data:/root/.near"' "$MANIFEST" >/dev/null || die "unexpected volume $(jq -c .image.volumes "$MANIFEST") (expected data:/root/.near)"
upstream=$(jq -r .upstream "$MANIFEST")
network=$(jq -r '.image.environment[] | select(startswith("NETWORK=")) | sub("^NETWORK="; "")' "$MANIFEST")
[ "$network" = mainnet ] || die "no boot-test expectations for NETWORK=$network (add them here)"

id="avado-boot-$$"
C="$id-near"
VOL="$id-data"
cleanup() {
  docker rm -f "$C" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
}
trap cleanup EXIT

# Environment, ports and privileged exactly as the manifest gives them to the DAPPMANAGER.
args=()
while IFS= read -r e; do args+=(-e "$e"); done < <(jq -r '.image.environment[]' "$MANIFEST")
while IFS= read -r p; do args+=(-p "$p"); done < <(jq -r '.image.ports[]' "$MANIFEST")
[ "$(jq -r '.image.privileged // false' "$MANIFEST")" = true ] && args+=(--privileged)

docker volume create "$VOL" >/dev/null || die "cannot create a docker volume"
log "starting $IMAGE (env: $(jq -rc '.image.environment' "$MANIFEST"), ports: $(jq -rc '.image.ports' "$MANIFEST"), privileged: $(jq -r '.image.privileged // false' "$MANIFEST"))"
started=$(date +%s)
docker run -d --name "$C" --platform linux/amd64 -v "$VOL:/root/.near" "${args[@]}" "$IMAGE" >/dev/null || die "cannot start the container"
running() { [ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" = true ]; }
snapshot() { docker logs "$C" >"$OUT/container.log" 2>&1; near_stats "$OUT/container.log" >"$OUT/stats.tsv"; }

# --- wait for the epoch sync proof -------------------------------------------------
genesis=""
synced="" synced_after=""
while [ $(($(date +%s) - started)) -lt $((EPOCH_MIN * 60)) ]; do
  running || break
  [ -n "$genesis" ] || genesis=$(near_genesis_height "$C")
  snapshot
  if [ -n "$genesis" ]; then
    synced=$(near_synced_from "$OUT/stats.tsv" "$genesis")
    if [ -n "$synced" ]; then
      synced_after=$(($(date +%s) - started))
      break
    fi
  fi
  sleep 20
done

# --- watch header sync ----------------------------------------------------------------
first_h="" last_h=""
if [ -n "$synced" ]; then
  first_h=${synced#* }
  log "epoch sync proof accepted after ${synced_after} s (height $first_h); watching for $WATCH_MIN minutes"
  watch_until=$(($(date +%s) + WATCH_MIN * 60))
  while [ "$(date +%s)" -lt "$watch_until" ]; do
    running || break
    sleep 20
  done
  snapshot
  last_h=$(awk -F'\t' '$7 != "" && $7 + 0 > h { h = $7 + 0 } END { if (h) print h }' "$OUT/stats.tsv")
fi

# --- facts from the running node ------------------------------------------------------------
status=$(docker exec "$C" sh -c 'wget -qO- -T 10 http://127.0.0.1:3030/status' 2>/dev/null)
printf '%s\n' "$status" | jq . >"$OUT/status.json" 2>/dev/null || printf '%s\n' "$status" >"$OUT/status.json"
docker exec "$C" sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null' >"$OUT/tcp.txt" 2>&1
docker exec "$C" sh -c 'ls -l /root/.near' >"$OUT/home.txt" 2>&1
docker exec "$C" cat /root/.near/config.json >"$OUT/config.json" 2>/dev/null
restarts=$(docker inspect -f '{{.RestartCount}}' "$C" 2>/dev/null)
exit_code=""
stop_s=""
if running; then
  log "stopping the container (docker stop, 180 s grace like a box)"
  t0=$(date +%s)
  docker stop -t 180 "$C" >/dev/null 2>&1
  stop_s=$(($(date +%s) - t0))
  exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$C" 2>/dev/null)
else
  exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$C" 2>/dev/null)
fi
snapshot

# --- verdict ------------------------------------------------------------------------
fails=0
outside_only=1
: >"$OUT/result.tsv"
check() { # <PASS|FAIL|INFO> <name> <detail>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$OUT/result.tsv"
  printf '  %-5s %-18s %s\n' "$1" "$2" "$3"
  if [ "$1" = FAIL ]; then
    fails=$((fails + 1))
    case "$2" in epoch-sync | header-sync | peers) ;; *) outside_only=0 ;; esac
  fi
  return 0
}
clean_log() { near_clean "$OUT/container.log"; }

inits=$(clean_log | grep -c 'initializing node' || true)
starts=$(clean_log | grep -c '^Starting NEAR node' || true)
if [ "$inits" = 1 ] && [ "$starts" = 1 ]; then
  check PASS init "the entrypoint initialised the empty volume once and started neard once"
else
  check FAIL init "the entrypoint ran $starts time(s) and initialised $inits time(s) (expected once each; see container.log)"
fi
if [ "${restarts:-0}" = 0 ] && [ -n "$stop_s" ]; then
  check PASS process "neard kept running until the test stopped it"
else
  check FAIL process "neard exited on its own (exit code ${exit_code:-?}, restarts ${restarts:-?}); see container.log"
fi
fatal=$(near_fatal_lines "$OUT/container.log" | head -3 | cut -c1-200 | tr '\n' ' ')
if [ -z "$fatal" ]; then check PASS fatal-lines "no panic or fatal line in the log"; else check FAIL fatal-lines "$fatal"; fi
unknown=$(clean_log | grep 'encountered unrecognized fields' | head -1 | sed -nE 's/.*fields=(.*)$/\1/p')
if [ -z "$unknown" ]; then check PASS config-keys "no unknown config.json key"; else check FAIL config-keys "neard ignores config.json keys: $unknown"; fi

chain=$(jq -r '.chain_id // empty' "$OUT/status.json" 2>/dev/null)
rpc_version=$(jq -r '.version.version // empty' "$OUT/status.json" 2>/dev/null)
if [ "$chain" = mainnet ] && [ "$rpc_version" = "$upstream" ]; then
  check PASS rpc "the RPC answers: chain_id mainnet, nearcore $rpc_version (latest protocol $(jq -r '.latest_protocol_version // "?"' "$OUT/status.json"))"
else
  check FAIL rpc "expected chain_id mainnet and nearcore $upstream from the RPC status, got: ${chain:-no answer} ${rpc_version:-}"
fi

# TCP ports neard listens on (state 0A, any address) against what the manifest publishes.
p2p=$(jq -r '.network.addr // empty' "$OUT/config.json" 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')
listening=$(grep -E '^[[:space:]]*[0-9]+:' "$OUT/tcp.txt" 2>/dev/null | awk '$4 == "0A" { split($2, a, ":"); print a[2] }' | while read -r hex; do echo $((16#$hex)); done | sort -un | tr '\n' ' ' | sed 's/ $//')
published=$(jq -r '.image.ports[] | split(":") | last | sub("/tcp$"; "")' "$MANIFEST" | sort -un | tr '\n' ' ' | sed 's/ $//')
if [ -n "$p2p" ] && echo " $listening " | grep -q " $p2p " && echo " $published " | grep -q " $p2p "; then
  check PASS p2p-port "neard listens on TCP $p2p (config network.addr) and the manifest publishes it (listening: $listening; published: $published)"
else
  check FAIL p2p-port "p2p port ${p2p:-?} (config network.addr): listening on TCP: ${listening:-nothing}; published by the manifest: ${published:-nothing}"
fi

requests=$(awk -F'\t' '$2 == "epoch"' "$OUT/stats.tsv" | wc -l | tr -d ' ')
timeouts=$(clean_log | grep -c 'epoch sync from peer timed out' || true)
if [ -n "$synced" ]; then
  check PASS epoch-sync "epoch sync proof accepted after ${synced_after} s: the node jumped from genesis $genesis to height $first_h ($timeouts request(s) timed out before)"
else
  check FAIL epoch-sync "no epoch sync proof accepted within $EPOCH_MIN minutes (the node is still at genesis ${genesis:-?}; $timeouts request(s) timed out; public network, NEAR peers often do not answer)"
fi
if [ -n "$synced" ] && [ -n "$last_h" ] && [ $((last_h - first_h)) -ge 100 ]; then
  check PASS header-sync "height $first_h -> $last_h while watching $WATCH_MIN minutes ($(tail -1 "$OUT/stats.tsv" | cut -f2) sync)"
elif [ -n "$synced" ]; then
  check FAIL header-sync "the height did not move forward while watching (${first_h:-?} -> ${last_h:-?})"
fi
max_peers=$(near_max_peers "$OUT/stats.tsv")
if [ "$max_peers" -ge "$MIN_PEERS" ]; then check PASS peers "up to $max_peers peers (need $MIN_PEERS)"; else check FAIL peers "at most $max_peers peers (need $MIN_PEERS)"; fi

if [ -n "$stop_s" ] && [ "$exit_code" = 0 ]; then
  check PASS stop "docker stop: neard shut down cleanly in $stop_s s (exit 0)"
elif [ -n "$stop_s" ]; then
  check FAIL stop "docker stop took $stop_s s and neard exited with $exit_code (expected a clean exit 0: neard must get SIGTERM, exec in the entrypoint)"
fi
check INFO stats "$requests stats line(s) in epoch sync, $(wc -l <"$OUT/stats.tsv" | tr -d ' ') in total; last: $(tail -1 "$OUT/stats.tsv" | tr '\t' ' ')"

if [ "$fails" = 0 ]; then
  echo "PASS: the package booted on NEAR mainnet and synced headers"
else
  echo "FAIL: $fails boot check(s) failed (logs: $OUT/container.log)" >&2
  echo "----- last 40 log lines" >&2
  near_clean "$OUT/container.log" | grep -vE 'failed to read parameter|set_kernel_params|received bad block' | tail -40 >&2
  [ "$outside_only" = 1 ] && exit 2
  exit 1
fi
