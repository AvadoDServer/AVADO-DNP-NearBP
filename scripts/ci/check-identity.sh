#!/usr/bin/env bash
# What identifies the package on the boxes did not change, the three places
# that name the nearcore version agree, and the version goes up.
#
#   scripts/ci/check-identity.sh <base-ref> [out-dir]
#
# Boxes auto-update in place and cannot roll back, so an update must keep the
# package name, the volume (data:/root/.near: the node database and the
# validator and node keys), the host port, the set of environment keys, the
# type, and the compose service and volume names. HEAD is compared with
#   - <base-ref> (the branch the PR goes into),
#   - the manifest the production store serves (if readable).
# Consistency: manifest "upstream" = the nearcore tag build/Dockerfile builds
# FROM (with a sha256 digest), and the compose image is <name>:<version>.
# Version rules: the version never goes down, and it must go up when the
# manifest changed. A held package (a `hold` file) is not released, so its
# version may stay while other files change. A nearcore version lower than the
# base's is shown as a warning: a box whose database a newer nearcore migrated
# cannot run an older one. The gate never merges it on the bot's PR; a real
# rollback is the owner's own pull request.
set -euo pipefail

BASE=${1:?usage: check-identity.sh <base-ref> [out-dir]}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${2:-$(mktemp -d "${TMPDIR:-/tmp}/identity.XXXXXX")}
STORE_POINTER=${AVADO_STORE_POINTER:-https://bo.ava.do/value/store}
GATEWAYS=${AVADO_IPFS_GATEWAYS:-http://80.208.229.228:8080 https://ipfs.io}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

fails=0
: >"$OUT/result.tsv"
check() { # <PASS|FAIL|INFO> <name> <detail>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$OUT/result.tsv"
  printf '  %-5s %-22s %s\n' "$1" "$2" "$3"
  [ "$1" = FAIL ] && fails=$((fails + 1))
  return 0
}
semver_cmp() { # prints -1, 0 or 1
  local -a a b
  local i
  IFS=. read -ra a <<<"$1"
  IFS=. read -ra b <<<"$2"
  for i in 0 1 2; do
    if [ "${a[$i]:-0}" -lt "${b[$i]:-0}" ]; then echo -1; return; fi
    if [ "${a[$i]:-0}" -gt "${b[$i]:-0}" ]; then echo 1; return; fi
  done
  echo 0
}
# The facts that must not change, as sorted JSON.
identity() { # <manifest.json>
  jq -S '{name, type: (.type // null), volumes: (.image.volumes // []),
    ports: ((.image.ports // []) | sort), env_keys: ([(.image.environment // [])[] | split("=")[0]] | sort)}' "$1"
}
compose_identity() { # <compose.yml>
  yq -o=json '{"services": (.services | keys), "service_volumes": [.services[].volumes // [] | .[]], "ports": [.services[].ports // [] | .[]], "volumes": ((.volumes // {}) | keys)}' "$1" | jq -S .
}
nearcore_from() { # <Dockerfile>: "<version> <digest or ->"
  local ref
  ref=$(grep -E '^FROM[[:space:]].*nearprotocol/nearcore:' "$1" | grep -oE 'nearprotocol/nearcore:[^[:space:]]+' || true)
  [ "$(printf '%s\n' "$ref" | grep -c . || true)" = 1 ] || { echo "- -"; return; }
  ref=${ref#nearprotocol/nearcore:}
  printf '%s %s\n' "${ref%%@*}" "$(printf '%s' "$ref" | sed -n 's/.*@//p' | grep . || echo -)"
}

H="$ROOT/dappnode_package.json"
HC="$ROOT/docker-compose.yml"
name=$(jq -r .name "$H")
version=$(jq -r .version "$H")
upstream=$(jq -r .upstream "$H")
held=""
if [ -f "$ROOT/hold" ]; then
  held=$(sed -n '/^[[:space:]]*#/d; /[^[:space:]]/{p;q;}' "$ROOT/hold")
  [ -n "$held" ] || held="held (no reason given)"
fi
echo "$name $version (nearcore $upstream) against $BASE${held:+ (HELD: $held)}"
[ -z "$held" ] || check INFO hold "HELD (not bumped or released until the file hold is removed): $held"
released=no
git -C "$ROOT" log HEAD --author='github-actions' -F --grep="Release $name $version" --format=%s | grep -qxF "Release $name $version" && released=yes

# --- consistency --------------------------------------------------------------------
read -r from_version from_digest <<<"$(nearcore_from "$ROOT/build/Dockerfile")"
if [ "$from_version" = - ]; then
  check FAIL dockerfile "build/Dockerfile needs exactly one FROM nearprotocol/nearcore:<version>@<digest> line"
elif [ "$from_version" != "$upstream" ]; then
  check FAIL upstream "the manifest says upstream $upstream, build/Dockerfile builds nearcore $from_version"
else
  check PASS upstream "manifest upstream and build/Dockerfile both name nearcore $upstream"
fi
if [ "$from_version" != - ] && ! printf '%s' "$from_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  check FAIL digest "build/Dockerfile builds nearprotocol/nearcore:$from_version without a sha256 digest"
fi
image=$(yq '.services[].image' "$HC")
if [ "$image" = "$name:$version" ]; then
  check PASS compose-image "docker-compose.yml image is $image"
else
  check FAIL compose-image "docker-compose.yml image is $image, expected $name:$version (the AVADOSDK rewrites it, but the file must agree)"
fi
if [ "$(yq '.services | keys | .[0]' "$HC")" = "$name" ] && [ "$(yq '.services | length' "$HC")" = 1 ]; then
  check PASS compose-service "one compose service, named $name"
else
  check FAIL compose-service "docker-compose.yml must have exactly one service named $name (the AVADOSDK tags services[$name])"
fi

# --- base -------------------------------------------------------------------------
if git -C "$ROOT" cat-file -e "$BASE:dappnode_package.json" 2>/dev/null; then
  git -C "$ROOT" show "$BASE:dappnode_package.json" >"$OUT/base-manifest.json"
  git -C "$ROOT" show "$BASE:docker-compose.yml" >"$OUT/base-compose.yml"
  B="$OUT/base-manifest.json"
  if [ "$(jq -r .name "$B")" != "$name" ]; then
    check FAIL identity-vs-base "$BASE has package $(jq -r .name "$B"), HEAD has $name"
  elif diff -u <(identity "$B") <(identity "$H") >"$OUT/identity-vs-base.diff"; then
    check PASS identity-vs-base "name, type, volumes, ports and environment keys unchanged"
  else
    check FAIL identity-vs-base "changed: $(grep '^[-+] ' "$OUT/identity-vs-base.diff" | tr -s ' ' | tr '\n' ' ' | cut -c1-300)"
  fi
  if diff -u <(compose_identity "$OUT/base-compose.yml") <(compose_identity "$HC") >"$OUT/compose-vs-base.diff"; then
    check PASS compose-vs-base "service name, volumes and ports unchanged"
  else
    check FAIL compose-vs-base "changed: $(grep '^[-+] ' "$OUT/compose-vs-base.diff" | tr -s ' ' | tr '\n' ' ' | cut -c1-300)"
  fi
  envdiff=$(diff <(jq -r '.image.environment[]?' "$B" | sort) <(jq -r '.image.environment[]?' "$H" | sort) | grep '^[<>]' | tr '\n' ' ' || true)
  [ -z "$envdiff" ] || check INFO env-defaults "default values changed (new installs only): $envdiff"
  other=$(diff <(jq -S '{restart: .image.restart, privileged: .image.privileged, autoupdate}' "$B") <(jq -S '{restart: .image.restart, privileged: .image.privileged, autoupdate}' "$H") | grep '^[<>]' | tr -s ' ' | tr '\n' ' ' || true)
  [ -z "$other" ] || check INFO container "restart/privileged/autoupdate changed: $other"

  if git -C "$ROOT" show "$BASE:build/Dockerfile" >"$OUT/base-Dockerfile" 2>/dev/null; then
    read -r base_from _ <<<"$(nearcore_from "$OUT/base-Dockerfile")"
    if [ "$base_from" != - ] && [ "$from_version" != - ] && [ "$(semver_cmp "$from_version" "$base_from")" = -1 ]; then
      check INFO nearcore-downgrade "nearcore goes DOWN from $base_from ($BASE) to $from_version: boxes whose database $base_from migrated cannot run it; the gate never merges this on the bot's PR"
      echo "::warning::nearcore goes down from $base_from to $from_version"
    fi
  fi
  base_version=$(jq -r .version "$B")
  cmp=$(semver_cmp "$version" "$base_version")
  manifest_changed=$(diff <(jq -S 'del(.version)' "$B") <(jq -S 'del(.version)' "$H") | grep '^[<>]' | tr -s ' ' | tr '\n' ' ' | cut -c1-200 || true)
  build_changed=$(git -C "$ROOT" diff --name-only "$BASE" HEAD -- build docker-compose.yml | head -5 | tr '\n' ' ' || true)
  if [ "$cmp" = -1 ]; then
    check FAIL version "$version is lower than $base_version on $BASE (versions only go up)"
  elif [ "$cmp" = 0 ] && [ -n "$manifest_changed" ] && [ -n "$held" ]; then
    check PASS version "still $version while held (the manifest changed: $manifest_changed); nothing is released until the hold ends"
  elif [ "$cmp" = 0 ] && [ -n "$manifest_changed" ]; then
    check FAIL version "still $version although the manifest changed ($manifest_changed); boxes only update to a higher version"
  elif [ "$cmp" = 0 ] && [ "$released" = no ] && [ -z "$held" ]; then
    check PASS version "$version, manifest unchanged, but $version is not released yet: the release publishes it after the merge"
  elif [ "$cmp" = 0 ]; then
    check PASS version "$version, manifest unchanged: nothing will be released"
    [ -z "$build_changed" ] || check INFO build-files "changed without a new version ($build_changed): they reach boxes with the next version"
  else
    check PASS version "$base_version -> $version"
  fi
else
  check INFO base "$BASE has no dappnode_package.json: nothing to compare"
fi

# --- production ---------------------------------------------------------------------
prod=""
if pointer=$(curl -fsS --max-time 30 -H 'Cache-Control: no-cache' "$STORE_POINTER" 2>/dev/null); then
  store_cid=$(printf '%s' "$pointer" | jq -r 'if type == "string" then fromjson else . end | .hash' 2>/dev/null || true)
  for gw in $GATEWAYS; do
    if [ -n "$store_cid" ] && curl -fsS --max-time 60 "$gw/ipfs/$store_cid" -o "$OUT/store.json" 2>/dev/null &&
      jq -e .packages "$OUT/store.json" >/dev/null 2>&1; then
      prod=$store_cid
      break
    fi
  done
fi
if [ -z "$prod" ]; then
  check INFO production "the production store could not be read; compared with $BASE only"
elif jq -e --arg n "$name" '[.packages[] | select(.manifest.name == $n)] | length == 1' "$OUT/store.json" >/dev/null; then
  jq --arg n "$name" '.packages[] | select(.manifest.name == $n) | .manifest' "$OUT/store.json" >"$OUT/production-manifest.json"
  prod_version=$(jq -r .version "$OUT/production-manifest.json")
  if diff -u <(identity "$OUT/production-manifest.json") <(identity "$H") >"$OUT/identity-vs-production.diff"; then
    check PASS identity-vs-production "same name, type, volumes, ports and environment keys as production $prod_version"
  else
    check FAIL identity-vs-production "differs from production $prod_version: $(grep '^[-+] ' "$OUT/identity-vs-production.diff" | tr -s ' ' | tr '\n' ' ' | cut -c1-300)"
  fi
  if [ "$(semver_cmp "$version" "$prod_version")" = -1 ]; then
    check FAIL version-vs-production "$version is lower than production $prod_version"
  else
    check PASS version-vs-production "$version, production has $prod_version (nearcore $(jq -r .upstream "$OUT/production-manifest.json"))"
  fi
else
  check INFO production "$name is not in the production store ($prod) yet"
fi

if [ "$fails" = 0 ]; then
  echo "PASS: $name keeps its identity"
else
  echo "FAIL: $fails identity check(s) failed for $name" >&2
  exit 1
fi
