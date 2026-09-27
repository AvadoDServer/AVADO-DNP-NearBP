#!/usr/bin/env bash
# Loads the image boxes run today: the package's entry in the live production
# store (https://bo.ava.do/value/store), its image downloaded from an IPFS
# gateway and checked against its IPFS hash (kubo `ipfs add --only-hash`, so
# the gateway does not have to be trusted) and its size, then `docker load`ed
# and tagged <tag>.
#
#   scripts/ci/production-image.sh <package-name> <tag> <work-dir>
#
# Writes <work-dir>/production.json: {version, upstream, imageHash, imageSize,
# imageId, store}. Load the candidate first and tag it by id: `docker load`
# re-tags <name>:<version>, which is the candidate's tag when the version did
# not change.
# Environment: AVADO_STORE_POINTER, AVADO_IPFS_GATEWAYS (space separated).
set -euo pipefail

NAME=${1:?usage: production-image.sh <package-name> <tag> <work-dir>}
TAG=${2:?usage: production-image.sh <package-name> <tag> <work-dir>}
WORK=${3:?usage: production-image.sh <package-name> <tag> <work-dir>}
STORE_POINTER=${AVADO_STORE_POINTER:-https://bo.ava.do/value/store}
GATEWAYS=${AVADO_IPFS_GATEWAYS:-http://80.208.229.228:8080 https://ipfs.io}
KUBO_IMAGE="ipfs/kubo:v0.25.0@sha256:9d917826eb669276040efb39cf6c68ae7463356a8e216eb13b278de00aa126be"
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)

die() {
  echo "production-image: $*" >&2
  exit 1
}
log() { echo "production-image: $*" >&2; }

cid_of() { # <file>: the IPFS hash (CIDv0, default chunker) the AVADOSDK and kubo give it
  docker image inspect "$KUBO_IMAGE" >/dev/null 2>&1 || docker pull -q "$KUBO_IMAGE" >/dev/null
  # The file goes in on stdin (no bind mount: works with Docker Desktop too).
  docker run -i --rm --entrypoint sh "$KUBO_IMAGE" -c 'cat >/tmp/f; ipfs init -e >/dev/null 2>&1; ipfs add -Q --only-hash /tmp/f' <"$1"
}
fetch_cid() { # <cid> <out-file> [max seconds]: download from a gateway and verify the hash
  local cid=${1#/ipfs/} out=$2 max=${3:-60} gw
  if [ -f "$out" ] && [ "$(cid_of "$out")" = "$cid" ]; then return 0; fi
  for gw in $GATEWAYS; do
    if curl -fsS --retry 2 --max-time "$max" "$gw/ipfs/$cid" -o "$out.part" 2>/dev/null; then
      if [ "$(cid_of "$out.part")" = "$cid" ]; then
        mv "$out.part" "$out"
        return 0
      fi
      log "$gw returned content that does not match $cid; trying the next gateway"
    fi
  done
  rm -f "$out.part"
  die "could not fetch $cid (with a matching hash) from: $GATEWAYS"
}

pointer=$(curl -fsS --retry 2 --max-time 30 -H 'Cache-Control: no-cache' "$STORE_POINTER") || die "cannot read $STORE_POINTER"
store=$(printf '%s' "$pointer" | jq -r 'if type == "string" then fromjson else . end | .hash')
if [ -z "$store" ] || [ "$store" = null ]; then die "the store pointer has no hash: $pointer"; fi
fetch_cid "$store" "$WORK/store.json"
jq --arg n "$NAME" '[.packages[] | select(.manifest.name == $n)] | if length == 1 then .[0].manifest else error("\(length) store entries for \($n)") end' \
  "$WORK/store.json" >"$WORK/production-manifest.json" || die "$NAME is not (exactly once) in the production store $store"
version=$(jq -r .version "$WORK/production-manifest.json")
upstream=$(jq -r .upstream "$WORK/production-manifest.json")
image_hash=$(jq -r .image.hash "$WORK/production-manifest.json")
image_size=$(jq -r .image.size "$WORK/production-manifest.json")
log "production store $store: $NAME $version (nearcore $upstream), image ${image_hash#/ipfs/} ($image_size bytes)"
file="$WORK/${image_hash#/ipfs/}.tar.xz"
fetch_cid "$image_hash" "$file" 1800
[ "$(wc -c <"$file" | tr -d ' ')" = "$image_size" ] || die "the production image size differs from the manifest"
loaded=$(docker load -i "$file" | sed -n 's/^Loaded image: //p' | tail -1)
[ -n "$loaded" ] || die "docker load did not report an image"
docker tag "$loaded" "$TAG"
image_id=$(docker image inspect --format '{{.Id}}' "$TAG")
jq -n --arg version "$version" --arg upstream "$upstream" --arg imageHash "$image_hash" --argjson imageSize "$image_size" \
  --arg imageId "$image_id" --arg store "$store" \
  '{version: $version, upstream: $upstream, imageHash: $imageHash, imageSize: $imageSize, imageId: $imageId, store: $store}' >"$WORK/production.json"
log "loaded $loaded as $TAG ($image_id)"
