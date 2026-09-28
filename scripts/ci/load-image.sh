#!/usr/bin/env bash
# Loads the image the build job added to IPFS (kept as a workflow artifact for
# the test jobs), after checking it is byte for byte that file, and tags it by
# id as <tag>.
#
#   scripts/ci/load-image.sh <record.json> <image-dir> <tag>
#
# <record.json> is what scripts/ci/sdk-build.sh wrote; <image-dir> holds its
# image file (imageFile, with imageSize bytes and sha256 imageSha256).
set -euo pipefail

RECORD=${1:?usage: load-image.sh <record.json> <image-dir> <tag>}
DIR=${2:?usage: load-image.sh <record.json> <image-dir> <tag>}
TAG=${3:?usage: load-image.sh <record.json> <image-dir> <tag>}
die() {
  echo "load-image: $*" >&2
  exit 1
}
if command -v sha256sum >/dev/null; then sha256() { sha256sum "$1" | cut -d' ' -f1; }; else sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi

file="$DIR/$(jq -r .imageFile "$RECORD")"
[ -f "$file" ] || die "missing $file"
[ "$(wc -c <"$file" | tr -d ' ')" = "$(jq -r .imageSize "$RECORD")" ] || die "$file has another size than the uploaded image"
[ "$(sha256 "$file")" = "$(jq -r .imageSha256 "$RECORD")" ] || die "$file is not the uploaded image (sha256 differs)"
want="$(jq -r '.name + ":" + .version' "$RECORD")"
loaded=$(docker load -i "$file" | sed -n 's/^Loaded image: //p' | tail -1)
[ "$loaded" = "$want" ] || die "docker load gave '$loaded', expected $want"
id=$(docker image inspect --format '{{.Id}}' "$want")
[ "$id" = "$(jq -r .imageId "$RECORD")" ] || echo "load-image: note: image id $id differs from the build job's $(jq -r .imageId "$RECORD") (the file itself is the same)" >&2
docker tag "$id" "$TAG"
echo "load-image: $want ($id) from the uploaded file, tagged $TAG" >&2
