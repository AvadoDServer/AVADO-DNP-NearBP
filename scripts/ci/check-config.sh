#!/usr/bin/env bash
# Every setting AVADO gives neard is accepted by the neard inside the image.
#
#   scripts/ci/check-config.sh <image> [out-dir]
#
# Reads the image's own files (what boxes run): /app/config.json.default (the
# entrypoint copies it over /root/.near/config.json on every start) and
# /app/entrypoint.sh, then, inside the image:
#   1. `neard validate-config` on a home made by `neard init --chain-id mainnet`
#      with our config.json must succeed (a wrong value, a removed option that
#      neard now refuses, such as state_sync.sync.ExternalStorage in 2.13, fail
#      here) and must not log "encountered unrecognized fields" (a key neard
#      no longer knows, such as consensus.block_fetch_horizon in 2.13.4);
#   2. neard does not warn about unknown TOP-LEVEL keys (2.13.4 silently ignores
#      them: its Config flattens GCConfig), so every top-level key of our config
#      that the default config of `neard init` does not have is probed: added
#      to that default config with a value of the wrong type, validate-config
#      must fail (the key is read). A key that still passes is ignored by this
#      neard: FAIL;
#   3. every neard subcommand and --flag the entrypoint passes (neard init
#      --chain-id --download-genesis, neard run) exists in that neard's --help.
# Options users add through EXTRA_OPTS are not used by the entrypoint today.
set -euo pipefail

IMAGE=${1:?usage: check-config.sh <image> [out-dir]}
OUT=${2:-$(mktemp -d "${TMPDIR:-/tmp}/check-config.XXXXXX")}
mkdir -p "$OUT/files" "$OUT/probes"
OUT=$(cd "$OUT" && pwd)

run() { docker run --rm --platform linux/amd64 "$@"; }
clean() { sed 's/\x1b\[[0-9;]*m//g'; }
fails=0
: >"$OUT/result.tsv"
check() { # <PASS|FAIL|INFO> <name> <detail>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$OUT/result.tsv"
  printf '  %-5s %-22s %s\n' "$1" "$2" "$3"
  [ "$1" = FAIL ] && fails=$((fails + 1))
  return 0
}

# --- the image's own files ---------------------------------------------------------
cid=$(docker create --platform linux/amd64 "$IMAGE")
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker cp "$cid:/app/config.json.default" "$OUT/files/config.json" >/dev/null
docker cp "$cid:/app/entrypoint.sh" "$OUT/files/entrypoint.sh" >/dev/null
jq -e 'type == "object"' "$OUT/files/config.json" >/dev/null || { echo "FAIL: /app/config.json.default in the image is not a JSON object" >&2; exit 1; }

# --- help texts ------------------------------------------------------------------------
run --entrypoint neard "$IMAGE" --help >"$OUT/help.txt" 2>&1 || { cat "$OUT/help.txt" >&2; echo "FAIL: neard --help did not run" >&2; exit 1; }
# Subcommands: the "Commands:" block of `neard --help`.
awk '/^Commands:/ {on = 1; next} on && /^[^ ]/ {on = 0} on && /^  [a-z]/ {print $1}' "$OUT/help.txt" | sort -u >"$OUT/subcommands.txt"
[ -s "$OUT/subcommands.txt" ] || { echo "FAIL: could not read the subcommands from neard --help" >&2; exit 1; }
# Options of a clap help text: the names at the start of an option line.
help_options() { sed -nE 's/^ {2,8}(-[A-Za-z], )?(--[A-Za-z0-9][A-Za-z0-9-]*).*/\2/p' "$1" | sort -u; }
# Global options that take a value ("--home <HOME>"), to skip the value.
help_valued() { sed -nE 's/^ {2,8}(-[A-Za-z], )?(--[A-Za-z0-9][A-Za-z0-9-]*) <.*/\2/p' "$1" | sort -u; }
help_options "$OUT/help.txt" >"$OUT/options-global.txt"
help_valued "$OUT/help.txt" >"$OUT/valued-global.txt"

# --- 1 + 2: config.json ----------------------------------------------------------------
jq -r 'keys[]' "$OUT/files/config.json" >"$OUT/our-top-keys.txt"
cp "$OUT/files/config.json" "$OUT/probes/_ours.json"
cp "$OUT/our-top-keys.txt" "$OUT/probes/_keys.txt"
# One container: init a home, print its default config, validate ours, then
# probe each of our top-level keys on the default config (the host only reads
# the probes of keys the default config does not have).
tar -C "$OUT/probes" -cf - . | docker run -i --rm --platform linux/amd64 --entrypoint sh "$IMAGE" -c '
  set -u
  mkdir -p /p && tar -C /p -xf -
  neard --home /tmp/h init --chain-id mainnet >/tmp/init.log 2>&1 || { echo "@@init-failed"; cat /tmp/init.log; exit 0; }
  cp /tmp/h/config.json /tmp/default.json
  echo "@@default"; cat /tmp/default.json; echo
  cp /p/_ours.json /tmp/h/config.json
  neard --home /tmp/h validate-config >/tmp/v.log 2>&1; echo "@@ours rc=$?"; cat /tmp/v.log
  while IFS= read -r k; do
    sed "1a\\  \"$k\": [[[\"__avado_probe__\"]]]," /tmp/default.json >/tmp/h/config.json
    neard --home /tmp/h validate-config >/dev/null 2>&1; echo "@@probe $k rc=$?"
  done </p/_keys.txt
' 2>&1 | clean >"$OUT/neard.txt" || true
if grep -q '^@@init-failed' "$OUT/neard.txt"; then
  check FAIL neard-init "neard init --chain-id mainnet failed: $(sed -n '/^@@init-failed/,$p' "$OUT/neard.txt" | sed -n 2,4p | tr '\n' ' ' | cut -c1-240)"
else
  sed -n '/^@@default$/,/^@@ours/p' "$OUT/neard.txt" | sed '1d;$d' >"$OUT/default-config.json"
  jq -r 'keys[]' "$OUT/default-config.json" >"$OUT/default-top-keys.txt" 2>/dev/null || : >"$OUT/default-top-keys.txt"
  rc=$(sed -nE 's/^@@ours rc=([0-9]+)$/\1/p' "$OUT/neard.txt")
  sed -n '/^@@ours/,/^@@probe/p' "$OUT/neard.txt" | grep -v '^@@' >"$OUT/validate.log" || true
  if [ "$rc" = 0 ]; then
    check PASS validate-config "neard validate-config accepts our config.json"
  else
    why=$(awk '/^Error:/ {on = 1; sub(/^Error: */, ""); if (!NF) next} /^Stack backtrace:/ {on = 0} on && NF' "$OUT/validate.log" | head -3 | cut -c1-300 | tr '\n' ' ')
    [ -n "$why" ] || why=$({ grep -E 'panicked|ERROR' "$OUT/validate.log" || true; } | head -2 | cut -c1-300 | tr '\n' ' ')
    check FAIL validate-config "neard validate-config refuses our config.json (exit ${rc:-?}): $why"
  fi
  unknown=$({ grep -h 'encountered unrecognized fields' "$OUT/validate.log" || true; } | sed -nE 's/.*fields=(.*)$/\1/p' | tr '\n' ' ' | sed 's/ *$//')
  if [ -n "$unknown" ]; then
    check FAIL unknown-keys "neard does not know these config.json keys (it ignores them): $unknown"
  else
    check PASS unknown-keys "no \"encountered unrecognized fields\" warning"
  fi
  ignored=""
  probed=0
  while IFS= read -r k; do
    grep -qxF "$k" "$OUT/default-top-keys.txt" && continue
    probed=$((probed + 1))
    prc=$(sed -nE "s/^@@probe $(printf '%s' "$k" | sed 's/[.[\*^$/]/\\&/g') rc=([0-9]+)$/\1/p" "$OUT/neard.txt")
    [ "$prc" = 0 ] && ignored="$ignored $k"
  done <"$OUT/our-top-keys.txt"
  if [ -n "$ignored" ]; then
    check FAIL top-level-keys "neard ignores these top-level config.json keys (a wrong value for them still passes validate-config):$ignored"
  else
    check PASS top-level-keys "$(wc -l <"$OUT/our-top-keys.txt" | tr -d ' ') top-level keys: $((($(wc -l <"$OUT/our-top-keys.txt")) - probed)) in neard's default config, $probed others probed and read by neard"
  fi
  missing_defaults=$(comm -23 "$OUT/default-top-keys.txt" <(sort "$OUT/our-top-keys.txt") | tr '\n' ' ' | sed 's/ *$//')
  [ -z "$missing_defaults" ] || check INFO default-keys "top-level keys of neard's default config that ours leaves to neard's defaults: $missing_defaults"
fi

# --- 3: what the entrypoint passes ------------------------------------------------------
# Every "neard ..." command line in the entrypoint (comments removed), up to a
# quote, ; | & or the end of the line.
sed -e 's/#.*$//' "$OUT/files/entrypoint.sh" |
  grep -oE '(^|[^[:alnum:]_./-])neard([[:space:]]+[^[:space:];|&"`)]+)*' |
  sed -E 's/^[^n]*neard/neard/' >"$OUT/invocations.txt" || true
if [ ! -s "$OUT/invocations.txt" ]; then
  check FAIL entrypoint "found no neard command line in /app/entrypoint.sh"
fi
while IFS= read -r line; do
  read -ra w <<<"$line"
  i=1 sub=""
  while [ "$i" -lt "${#w[@]}" ]; do
    t=${w[$i]}
    case "$t" in
    --*)
      f=${t%%=*}
      if grep -qxF -- "$f" "$OUT/options-global.txt"; then check PASS flag "neard $f (global)"; else check FAIL flag "neard $f: not an option of this neard (\"$line\")"; fi
      [ "$f" = "$t" ] && grep -qxF -- "$f" "$OUT/valued-global.txt" && i=$((i + 1))
      ;;
    *) sub=$t; break ;;
    esac
    i=$((i + 1))
  done
  if [ -z "$sub" ]; then
    check INFO command "\"$line\": no subcommand"
    continue
  fi
  if ! grep -qxF -- "$sub" "$OUT/subcommands.txt"; then
    check FAIL command "neard $sub: not a subcommand of this neard (\"$line\")"
    continue
  fi
  if [ ! -f "$OUT/options-$sub.txt" ]; then
    run --entrypoint neard "$IMAGE" "$sub" --help >"$OUT/help-$sub.txt" 2>&1 || true
    help_options "$OUT/help-$sub.txt" >"$OUT/options-$sub.txt"
  fi
  n=0
  for t in "${w[@]:$((i + 1))}"; do
    case "$t" in
    --*)
      f=${t%%=*}
      n=$((n + 1))
      if grep -qxF -- "$f" "$OUT/options-$sub.txt"; then check PASS flag "neard $sub $f"; else check FAIL flag "neard $sub $f: not an option of this neard (\"$line\")"; fi
      ;;
    esac
  done
  check PASS command "neard $sub ($n flag(s)): \"$line\""
done <"$OUT/invocations.txt"
grep -q 'EXTRA_OPTS' "$OUT/files/entrypoint.sh" || check INFO extra-opts "the entrypoint does not use EXTRA_OPTS (nothing a user sets there reaches neard)"

if [ "$fails" = 0 ]; then
  echo "PASS: neard accepts every setting AVADO gives it (config.json and the entrypoint's command lines)"
else
  echo "FAIL: $fails setting(s) AVADO gives neard are not accepted by this nearcore (details above; files in $OUT)" >&2
  exit 1
fi
