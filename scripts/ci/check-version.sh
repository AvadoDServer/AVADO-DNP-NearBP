#!/usr/bin/env bash
# The neard inside the image is exactly the nearcore version the repo pins.
#
#   scripts/ci/check-version.sh <image> <nearcore-version> [out-file]
#
# Runs `neard --version` in the image (no node starts) and requires
# "neard (release <nearcore-version>) ...". The protocol and database versions
# it prints are shown too, and written to [out-file] as "protocol=<n> db=<n>"
# (a database version that differs from production's means a one-way
# migration on the first start; the upgrade test shows it).
set -euo pipefail

IMAGE=${1:?usage: check-version.sh <image> <nearcore-version> [out-file]}
WANT=${2:?usage: check-version.sh <image> <nearcore-version> [out-file]}
OUTFILE=${3:-}

out=$(docker run --rm --platform linux/amd64 --entrypoint neard "$IMAGE" --version 2>&1 | head -3) || true
first=$(printf '%s\n' "$out" | grep -m1 '^neard ' || true)
echo "neard --version: ${first:-<no version line>}"
protocol=$(printf '%s\n' "$first" | sed -nE 's/.*\(protocol ([0-9]+)\).*/\1/p')
db=$(printf '%s\n' "$first" | sed -nE 's/.*\(db ([0-9]+)\).*/\1/p')
[ -z "$OUTFILE" ] || echo "protocol=${protocol:-?} db=${db:-?}" >"$OUTFILE"
case "$first" in
"neard (release $WANT) "*)
  echo "PASS: the image runs nearcore $WANT (protocol ${protocol:-?}, database version ${db:-?})"
  ;;
*)
  echo "FAIL: expected nearcore $WANT (\"neard (release $WANT) ...\"), the image says: ${first:-$out}" >&2
  exit 1
  ;;
esac
