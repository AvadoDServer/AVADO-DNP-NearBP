#!/usr/bin/env bash
# Builds the package the way the release publishes it: the pinned AVADOSDK
# "build" (docker compose build, docker save | xz, then avatar, image and
# manifest added to the IPFS node), like ci-build-action did, on a copy of the
# files git tracks at HEAD (so the build is exactly what the content id names,
# and the AVADOSDK's rewrite of docker-compose.yml does not touch the checkout).
#
#   scripts/ci/sdk-build.sh <out-dir> <ipfs-api-url>
#
# <ipfs-api-url> is the IPFS API the files are added to: AVADO's node
# (http://80.208.229.228:35001) for anything that may be released, or a
# throwaway local kubo for tests.
#
# Writes <out-dir>/record.json (what was built and where it was added):
#   name, version, upstream, manifestHash, imageHash, imageSize, imageSha256,
#   imageFile, imageId, provider, tree, contentId (scripts/ci/content-id.sh),
#   commit, builtAt, avadosdk
# plus <out-dir>/releases.json (the AVADOSDK release record),
# <out-dir>/manifest.json (the manifest that was added) and
# <out-dir>/image/<name>_<version>.tar.xz (the uploaded image file), and leaves
# the image <name>:<version>, loaded back from that file, in the local docker.
#
# AVADOSDK: taken from AVADOSDK_DIR if it holds the pinned commit, otherwise
# cloned there (default: $RUNNER_TEMP/avadosdk or a temporary folder) and
# installed from its lockfile.
set -euo pipefail

AVADOSDK_REPO=https://github.com/AvadoDServer/AVADOSDK.git
AVADOSDK_COMMIT=23d67575f4b8a9bf589e46dad57f6228eab5c7d0

die() {
  echo "sdk-build: $*" >&2
  exit 1
}
log() { echo "sdk-build: $*" >&2; }

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-}
PROVIDER=${2:-}
if [ -z "$OUT" ] || [ -z "$PROVIDER" ]; then die "usage: scripts/ci/sdk-build.sh <out-dir> <ipfs-api-url>"; fi
case "$PROVIDER" in http://* | https://*) ;; *) die "the IPFS API must be an http(s) URL (got '$PROVIDER')" ;; esac
for tool in docker git jq node npm; do command -v "$tool" >/dev/null || die "$tool is required"; done
if command -v sha256sum >/dev/null; then sha256() { sha256sum "$1" | cut -d' ' -f1; }; else sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

# --- AVADOSDK, pinned -----------------------------------------------------------
SDK=${AVADOSDK_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/avadosdk}
if [ "$(git -C "$SDK" rev-parse HEAD 2>/dev/null || true)" != "$AVADOSDK_COMMIT" ] || [ ! -d "$SDK/node_modules" ]; then
  log "installing AVADOSDK $AVADOSDK_COMMIT into $SDK"
  rm -rf "$SDK"
  git init -q "$SDK"
  git -C "$SDK" fetch -q --depth 1 "$AVADOSDK_REPO" "$AVADOSDK_COMMIT"
  git -C "$SDK" checkout -q FETCH_HEAD
  [ "$(git -C "$SDK" rev-parse HEAD)" = "$AVADOSDK_COMMIT" ] || die "AVADOSDK checkout is not $AVADOSDK_COMMIT"
  (cd "$SDK" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >&2)
fi

# --- the files at HEAD, and the build -----------------------------------------------
src="$OUT/src"
rm -rf "$src"
mkdir -p "$src"
git -C "$ROOT" archive HEAD | tar -C "$src" -xf -
name=$(jq -r .name "$src/dappnode_package.json")
version=$(jq -r .version "$src/dappnode_package.json")
upstream=$(jq -r .upstream "$src/dappnode_package.json")

log "$name $version (nearcore $upstream): AVADOSDK build, files added to $PROVIDER"
started=$(date +%s)
(cd "$src" && node "$SDK/src/avadosdk.js" build --provider "$PROVIDER" --timeout 90min --verbose) >"$OUT/sdk-build.log" 2>&1 ||
  { tail -60 "$OUT/sdk-build.log" >&2; die "AVADOSDK build failed for $name $version (full log: $OUT/sdk-build.log)"; }
log "AVADOSDK build finished in $(($(date +%s) - started)) s"

build="$src/build_$version"
[ -f "$src/releases.json" ] || die "AVADOSDK wrote no releases.json"
manifest_hash=$(jq -r --arg v "$version" '.[$v].hash // empty' "$src/releases.json")
[ -n "$manifest_hash" ] || die "releases.json has no hash for $version"
[ -f "$build/dappnode_package.json" ] || die "AVADOSDK wrote no $build/dappnode_package.json"
image_hash=$(jq -r .image.hash "$build/dappnode_package.json")
image_size=$(jq -r .image.size "$build/dappnode_package.json")
image_file=$(jq -r .image.path "$build/dappnode_package.json")
tarball="$build/$image_file"
[ -f "$tarball" ] || die "image file $tarball is missing"
[ "$(wc -c <"$tarball" | tr -d ' ')" = "$image_size" ] || die "image size differs from the manifest"

# The checks must run exactly the bytes that were added to IPFS, so the image is
# loaded back from the uploaded file (it replaces the tag the build left).
built_id=$(docker image inspect --format '{{.Id}}' "$name:$version")
loaded=$(docker load -i "$tarball" | sed -n 's/^Loaded image: //p' | tail -1)
[ "$loaded" = "$name:$version" ] || die "docker load of $tarball gave '$loaded', expected $name:$version"
image_id=$(docker image inspect --format '{{.Id}}' "$name:$version")
[ "$built_id" = "$image_id" ] || log "note: image id after loading the uploaded file is $image_id (build left $built_id); the checks use the loaded one"

mkdir -p "$OUT/image"
cp "$tarball" "$OUT/image/$image_file"
cp "$src/releases.json" "$OUT/releases.json"
cp "$build/dappnode_package.json" "$OUT/manifest.json"
jq -n \
  --arg name "$name" --arg version "$version" --arg upstream "$upstream" \
  --arg manifestHash "$manifest_hash" --arg imageHash "$image_hash" --argjson imageSize "$image_size" \
  --arg imageSha256 "$(sha256 "$tarball")" --arg imageFile "$image_file" \
  --arg imageId "$image_id" --arg provider "$PROVIDER" \
  --arg tree "$(git -C "$ROOT" rev-parse 'HEAD^{tree}')" --arg commit "$(git -C "$ROOT" rev-parse HEAD)" \
  --arg contentId "$("$ROOT/scripts/ci/content-id.sh" HEAD)" \
  --arg builtAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg sdk "$AVADOSDK_COMMIT" \
  '{name: $name, version: $version, upstream: $upstream, manifestHash: $manifestHash,
    imageHash: $imageHash, imageSize: $imageSize, imageSha256: $imageSha256, imageFile: $imageFile,
    imageId: $imageId, provider: $provider, tree: $tree, contentId: $contentId, commit: $commit,
    builtAt: $builtAt, avadosdk: $sdk}' >"$OUT/record.json"
log "built $name $version: manifest $manifest_hash, image $image_hash ($image_size bytes), image id $image_id"
echo "$OUT/record.json"
