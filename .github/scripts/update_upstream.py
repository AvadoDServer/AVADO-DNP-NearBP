#!/usr/bin/env python3
"""
Checks near/nearcore for a newer mainnet release and bumps the package to it:
  build/Dockerfile        FROM nearprotocol/nearcore:<upstream>
  dappnode_package.json   "upstream" and "version" (patch + 1)
  docker-compose.yml      image tag <version>

Same job as update_upstream.py in the other AVADO package repos, plus NEAR
specifics:
  - only stable X.Y.Z releases whose release header says they are for MAINNET
    (no -rc, no pre-release, no testnet-only release)
  - only when the nearprotocol/nearcore image for it is on Docker Hub (it is
    pushed a few minutes after the GitHub release; the next run retries)
  - the PR body carries nearcore's release header and protocol-upgrade voting
    section, so a deadline is visible in the PR itself

Outputs for the workflow (GITHUB_ENV / GITHUB_OUTPUT): updated, old_version,
new_version, package_version, urgent; the PR body goes to
$RUNNER_TEMP/nearcore-pr-body.md (outside the repo, so it is not committed).
"""

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

REPO = "near/nearcore"
IMAGE = "nearprotocol/nearcore"
STABLE = re.compile(r"^\d+\.\d+\.\d+$")
HEADER_KEYS = ("CODE_COLOR", "RELEASE_VERSION", "PROTOCOL_UPGRADE", "DATABASE_UPGRADE", "SECURITY_UPGRADE")


def fetch_json(url, github=False):
    request = urllib.request.Request(url)
    request.add_header("User-Agent", "AVADO-DNP-NearBP-Update-Bot")
    if github:
        request.add_header("Accept", "application/vnd.github+json")
        token = os.getenv("GITHUB_TOKEN")
        if token:
            request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode())


def parse_header(body):
    """The KEY: VALUE block nearcore puts at the top of every release."""
    header = {}
    for line in (body or "").splitlines():
        m = re.match(r"^\s*([A-Z_]+)\s*:\s*(.+?)\s*$", line)
        if m and m.group(1) in HEADER_KEYS:
            header[m.group(1)] = m.group(2)
    return header


def voting_section(body):
    """The '# Protocol upgrade voting' section, if the release has one."""
    m = re.search(r"^#+\s*Protocol upgrade voting\s*$(.*?)(?=^#+\s|\Z)", body or "", re.M | re.S)
    return m.group(1).strip() if m else ""


def as_tuple(version):
    return tuple(int(x) for x in version.split("."))


def latest_mainnet_release():
    releases = fetch_json(f"https://api.github.com/repos/{REPO}/releases?per_page=50", github=True)
    candidates = []
    for r in releases:
        tag = r.get("tag_name", "").lstrip("v")
        if r.get("draft") or r.get("prerelease") or not STABLE.match(tag):
            continue
        header = parse_header(r.get("body"))
        # A release without a readable header is still offered, but flagged in the PR.
        if header.get("CODE_COLOR") and "MAINNET" not in header["CODE_COLOR"].upper():
            print(f"skipping {tag}: not a mainnet release ({header['CODE_COLOR']})")
            continue
        candidates.append((as_tuple(tag), tag, r, header))
    if not candidates:
        return None
    return max(candidates, key=lambda c: c[0])[1:]


def image_published(tag):
    try:
        data = fetch_json(f"https://hub.docker.com/v2/repositories/{IMAGE}/tags/{tag}")
    except Exception as e:
        print(f"Docker Hub lookup for {IMAGE}:{tag} failed: {e}")
        return False
    return any(i.get("architecture") == "amd64" for i in data.get("images", []))


def replace_once(path, pattern, replacement):
    text = path.read_text()
    new, count = re.subn(pattern, replacement, text, count=1, flags=re.M)
    if count != 1:
        print(f"::error::{path.name}: pattern {pattern!r} not found", file=sys.stderr)
        sys.exit(1)
    path.write_text(new)


def set_outputs(**values):
    for env_file in (os.getenv("GITHUB_OUTPUT"), os.getenv("GITHUB_ENV")):
        if env_file:
            with open(env_file, "a") as f:
                for k, v in values.items():
                    f.write(f"{k}={v}\n")


def main():
    root = Path(__file__).resolve().parent.parent.parent
    package_path = root / "dappnode_package.json"
    compose_path = root / "docker-compose.yml"
    dockerfile_path = root / "build" / "Dockerfile"

    package = json.loads(package_path.read_text())
    current_upstream = package["upstream"]
    current_version = package["version"]
    print(f"Current: package {current_version}, nearcore {current_upstream}")

    found = latest_mainnet_release()
    if not found:
        print("::warning::no stable mainnet nearcore release found")
        set_outputs(updated="false")
        return
    latest, release, header = found
    print(f"Latest mainnet nearcore release: {latest}")

    if as_tuple(latest) <= as_tuple(current_upstream):
        print("Already up to date!")
        set_outputs(updated="false")
        return
    if not image_published(latest):
        print(f"::notice::{IMAGE}:{latest} is not on Docker Hub yet; the next run retries")
        set_outputs(updated="false")
        return

    parts = current_version.split(".")
    parts[2] = str(int(parts[2]) + 1)
    new_version = ".".join(parts)
    print(f"Bumping to package {new_version}, nearcore {latest}")

    replace_once(package_path, r'^(\s*"version":\s*)"[^"]*"', rf'\g<1>"{new_version}"')
    replace_once(package_path, r'^(\s*"upstream":\s*)"[^"]*"', rf'\g<1>"{latest}"')
    replace_once(compose_path, r"^(\s*image:\s*'nearbp\.avado\.dnp\.dappnode\.eth:)[^']*'", rf"\g<1>{new_version}'")
    replace_once(dockerfile_path, r"^(FROM\s+(?:--platform=\S+\s+)?nearprotocol/nearcore:)\S+", rf"\g<1>{latest}")

    color = header.get("CODE_COLOR", "")
    urgent = "RED" in color.upper() or header.get("PROTOCOL_UPGRADE", "").upper() == "TRUE" \
        or header.get("SECURITY_UPGRADE", "").upper() == "TRUE"

    lines = [
        "## Automated nearcore upstream update",
        "",
        f"Updates nearcore from **{current_upstream}** to **{latest}** (package **{current_version}** → **{new_version}**).",
        "",
    ]
    if urgent:
        lines += ["> [!IMPORTANT]",
                  "> nearcore marks this release as required (code red, security or protocol upgrade). "
                  "Validators that do not upgrade in time stop participating in consensus: merge, then update the node.",
                  ""]
    if header:
        lines += ["### Release header", "```"] + [f"{k}: {header[k]}" for k in HEADER_KEYS if k in header] + ["```", ""]
    else:
        lines += ["> [!WARNING]", "> The release has no readable header: check the release notes for mainnet relevance before merging.", ""]
    voting = voting_section(release.get("body"))
    if voting:
        lines += ["### Protocol upgrade voting", voting, ""]
    lines += [
        "### Changes",
        f"- `build/Dockerfile`: `nearprotocol/nearcore:{latest}`",
        f"- `dappnode_package.json`: `version` {new_version}, `upstream` {latest}",
        f"- `docker-compose.yml`: image tag {new_version}",
        "",
        "### Before merging",
        "- Read the release notes for **config changes** (`build/files/config.json` is copied over the node's config on every start).",
        "- The PR build (`Build`) must be green.",
        "",
        "### After merging",
        "The `Release` workflow publishes the package and releases the store. Check that avado-admin shows the new version, then update the validator.",
        "",
        f"Release notes: {release.get('html_url', f'https://github.com/{REPO}/releases/tag/{latest}')}",
        "",
        "cc @flisko @sponnet",
        "",
        "---",
        "*This PR was automatically generated by the update-upstream workflow.*",
    ]
    body_path = Path(os.getenv("RUNNER_TEMP", "/tmp")) / "nearcore-pr-body.md"
    body_path.write_text("\n".join(lines) + "\n")
    print(f"PR body written to {body_path}")

    set_outputs(updated="true", old_version=current_upstream, new_version=latest,
                package_version=new_version, urgent="true" if urgent else "false")


if __name__ == "__main__":
    main()
