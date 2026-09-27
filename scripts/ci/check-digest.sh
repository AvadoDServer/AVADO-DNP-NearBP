#!/usr/bin/env bash
# The nearcore base image is pinned: build/Dockerfile builds
# FROM nearprotocol/nearcore:<version>@<digest>. This check compares the
# committed digest with what Docker Hub serves for that version now. A
# difference means the tag was moved or re-pushed after the bump: the build
# still uses the committed digest, but a person should look.
#
#   scripts/ci/check-digest.sh
#
# Docker Hub not answering is reported as a warning, not a failure (the build
# itself proves the pinned image exists).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
line=$(grep -E '^FROM[[:space:]].*nearprotocol/nearcore:' "$ROOT/build/Dockerfile" || true)
[ "$(printf '%s\n' "$line" | grep -c . || true)" = 1 ] || { echo "FAIL: expected exactly one FROM nearprotocol/nearcore line in build/Dockerfile, found: ${line:-none}" >&2; exit 1; }
ref=$(printf '%s\n' "$line" | grep -oE 'nearprotocol/nearcore:[^[:space:]]+')
version=${ref#nearprotocol/nearcore:}
version=${version%%@*}
digest=$(printf '%s\n' "$ref" | sed -n 's/.*@//p')
echo "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo "FAIL: build/Dockerfile builds $ref without a sha256 digest (FROM nearprotocol/nearcore:<version>@sha256:<digest>)" >&2; exit 1; }
body=$(mktemp)
trap 'rm -f "$body"' EXIT
code=$(curl -sS --retry 3 --max-time 30 -o "$body" -w '%{http_code}' "https://hub.docker.com/v2/repositories/nearprotocol/nearcore/tags/$version" || true)
if [ "$code" = 404 ]; then
  echo "FAIL: nearprotocol/nearcore:$version does not exist on Docker Hub" >&2
  exit 1
fi
if [ "$code" != 200 ] || ! hub=$(jq -r '.digest // empty' "$body"); then
  echo "::warning::Docker Hub did not answer (HTTP ${code:-none}); the digest of nearprotocol/nearcore:$version was not compared (the build uses the committed $digest)"
  exit 0
fi
if [ "$hub" = "$digest" ]; then
  echo "PASS: nearprotocol/nearcore:$version is $digest on Docker Hub, as committed"
else
  echo "FAIL: nearprotocol/nearcore:$version is ${hub:-missing} on Docker Hub now, but build/Dockerfile pins $digest. The tag was moved or re-pushed: find out why before releasing." >&2
  exit 1
fi
