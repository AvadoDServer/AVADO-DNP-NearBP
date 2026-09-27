#!/usr/bin/env bash
# Shared helpers of the NEAR boot and upgrade tests (sourced, not run).
#
# neard logs one "stats" line every 10 s, for example
#   INFO stats: node_status="# 9820210 Waiting for peers 0 peers ⬇ 0 B/s ..."
#   INFO stats: node_status="[EPOCH] InProgress { source_peer_height: 217398221, ... } 10 peers ⬇ ..."
#   INFO stats: node_status="# 9820210 Downloading headers 0.57% (89791 left; at 217310446) 21 peers ⬇ ..."
# A fresh mainnet node first asks one peer at a time for an epoch sync proof
# ("[EPOCH] InProgress"); when a proof is accepted, the node jumps to a recent
# header ("Downloading headers ... at <height near the chain head>"), then
# follows with header, state and block sync.

# Removes colour codes.
near_clean() { sed 's/\x1b\[[0-9;]*m//g' "$@"; }

# near_stats <log-file>: one tab-separated line per stats line:
#   time  kind  head  header_at  left  peers  height
# kind: epoch | waiting | headers | blocks | state | head | other
# height: the highest of head and header_at (what the node has reached).
near_stats() {
  near_clean "$1" | awk -F'node_status="' '/INFO stats: node_status="/ {
    t = $1; sub(/ .*/, "", t)
    s = $2; sub(/"[[:space:]]*$/, "", s)
    n = split(s, w, " ")
    peers = ""; head = ""; at = ""; left = ""
    for (i = 2; i <= n; i++) if (w[i] == "peers" && w[i - 1] ~ /^[0-9]+$/) peers = w[i - 1]
    if (w[1] == "#" && w[2] ~ /^[0-9]+$/) head = w[2]
    for (i = 2; i <= n; i++) {
      if (w[i] == "left;") { left = w[i - 1]; sub(/^\(/, "", left) }
      if (w[i] == "at" && i < n) { at = w[i + 1]; sub(/\).*$/, "", at) }
    }
    kind = "other"
    if (s ~ /^\[EPOCH\]/) kind = "epoch"
    else if (s ~ /Waiting for peers/) kind = "waiting"
    else if (s ~ /Downloading headers/) kind = "headers"
    else if (s ~ /Downloading blocks/) kind = "blocks"
    else if (s ~ /[Ss]tate ?[Ss]ync|State /) kind = "state"
    else if (head != "") kind = "head"
    h = head + 0; if (at != "" && at + 0 > h) h = at + 0
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", t, kind, head, at, left, peers, (h > 0 ? h : "")
  }'
}

# near_synced_from <stats.tsv> <genesis-height>: the first line whose height is
# far above genesis (more than 10 epochs of 43200 blocks): the epoch sync proof
# was accepted there. Prints "<line number> <height>", or nothing.
near_synced_from() {
  awk -F'\t' -v g="$2" '$7 != "" && $7 + 0 > g + 432000 { print NR, $7; exit }' "$1"
}

# near_max_peers <stats.tsv>
near_max_peers() { awk -F'\t' '$6 != "" && $6 + 0 > m { m = $6 + 0 } END { print m + 0 }' "$1"; }

# Lines that mean neard or the entrypoint broke. Kernel-parameter messages
# ("failed to read parameter", "please run scripts/set_kernel_params.sh") are
# ERROR/WARN lines neard prints in every container and are not failures.
NEAR_FATAL='panicked at|thread .* panicked|^Error: |Could not open|Failed to open|FATAL|Aborted|Segmentation fault|error while loading shared libraries|exec format error|No such file or directory \(os error|database .*(corrupt|incompatible)|incompatible .*database|DB version|unsupported database version'
near_fatal_lines() { near_clean "$1" | grep -E "$NEAR_FATAL" | grep -vE 'failed to read parameter|set_kernel_params' || true; }

# The genesis height of the chain the node runs (from its genesis.json).
near_genesis_height() { # <container>
  docker exec "$1" sh -c "grep -m1 -oE '\"genesis_height\": *[0-9]+' /root/.near/genesis.json" 2>/dev/null | grep -oE '[0-9]+$' || true
}

# sha256 of the key files, the genesis and whether data/ exists, on a volume.
near_volume_facts() { # <volume> <image>
  docker run --rm --platform linux/amd64 --entrypoint sh -v "$1:/v" "$2" -c '
    cd /v || exit 1
    for f in node_key.json validator_key.json genesis.json config.json; do
      if [ -f "$f" ]; then echo "$f $(sha256sum "$f" | cut -d" " -f1)"; else echo "$f missing"; fi
    done
    if [ -d data ]; then echo "data $(du -sm data | cut -f1) MB"; else echo "data missing"; fi'
}
