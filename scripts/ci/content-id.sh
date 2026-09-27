#!/usr/bin/env bash
# Prints the content id of a commit: a hash of every file git tracks at that
# commit EXCEPT a release record releases.json (it is not tracked in this repo
# today; the rule keeps the id stable if it ever is).
#
#   scripts/ci/content-id.sh [commit]        (default HEAD)
#
# The PR checks name the build they tested after it (artifact
# avado-build-nearbp-<content id>), and release.yml looks the build up by the
# content id of the default branch. A "Release ..." commit is empty, so the id
# stays the same after it and a re-run still finds the tested build. A merge
# commit, a squash merge and the PR head have the same id when they contain the
# same files.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REV=${1:-HEAD}
if command -v sha256sum >/dev/null; then sum() { sha256sum; }; else sum() { shasum -a 256; }; fi
git -C "$ROOT" ls-tree -r --full-tree "$REV" |
  { grep -Ev $'\t(.*/)?releases\\.json$' || true; } |
  sum | cut -c1-40
