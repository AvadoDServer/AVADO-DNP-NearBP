// Shared helpers for the NEAR pipeline (bump, gate, release). Node 20+, no
// dependencies. Everything that reads or edits the repo layout lives here, so
// the three workflows agree on it. Adapted from the Teku pilot
// (AvadoDServer/AVADO-DNP-Teku, .github/pipeline/lib/common.js).
//
// Layout (see README): ONE package at the repo root, one network (NEAR
// mainnet), no variants. The upstream nearcore version is written in three
// places that must agree, and the bump bot writes all of them:
//   build/Dockerfile        FROM ... nearprotocol/nearcore:<version>@<digest>
//   dappnode_package.json   "upstream": "<version>" (and the package "version")
//   docker-compose.yml      image: '<name>:<package version>'
// A file `hold` at the repo root holds the package back (the owner's choice).

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const BOT_NAME = 'github-actions[bot]';
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
export const BOT_BRANCH = 'avado-bot/bump';
export const BUMP_MARKER = '<!-- avado-bot:bump -->';
// The bump PR's marker names the nearcore version it offers, so a PR the owner
// closed is remembered as "skip this version" (bump.mjs).
export const bumpMarker = (target) => (target ? `<!-- avado-bot:bump target=${target} -->` : BUMP_MARKER);
export const markerTarget = (body) => /<!-- avado-bot:bump target=(\d+\.\d+\.\d+) -->/.exec(body || '')?.[1] || null;
export const PR_CHECKS_PATH = '.github/workflows/pr-checks.yml';
export const UPSTREAM_REPO = 'near/nearcore';
export const UPSTREAM_IMAGE = 'nearprotocol/nearcore';
// The tested build is kept as artifact avado-build-<ARTIFACT_ID>-<content id>.
export const ARTIFACT_ID = 'nearbp';
export const MANIFEST = 'dappnode_package.json';
export const COMPOSE = 'docker-compose.yml';
export const DOCKERFILE = 'build/Dockerfile';
export const HOLD_FILE = 'hold';
export const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

// --- versions ----------------------------------------------------------------

export function parseVersion(v) {
  const m = STABLE_TAG.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export const bare = (tag) => String(tag).replace(/^v/, '');

export function maxVersion(list) {
  return list.filter((v) => parseVersion(v)).reduce((a, b) => (a === null || compareVersions(b, a) > 0 ? b : a), null);
}

export function bumpPatch(v) {
  const p = parseVersion(v);
  if (!p) throw new Error(`not a version: ${v}`);
  return `${p[0]}.${p[1]}.${p[2] + 1}`;
}

// Stable upstream releases only (no draft, pre-release, rc, beta), newest
// version first. nearcore has published rc tags that are NOT marked as
// pre-releases (1.38.0-rc.2), so the tag itself must be X.Y.Z. Whether a
// stable release is meant for mainnet is decided by its header (lib/near.js).
export function stableReleases(releases) {
  return (releases || [])
    .filter((r) => !r.draft && !r.prerelease && STABLE_TAG.test(r.tag_name))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
}

// --- repo files ----------------------------------------------------------------

// The one FROM line of build/Dockerfile that uses nearprotocol/nearcore.
const FROM_LINE = /^(FROM\s+(?:--platform=\S+\s+)?nearprotocol\/nearcore:)([^\s@]+)(?:@(sha256:[0-9a-f]{64}))?([ \t].*)?$/m;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// { version, digest } of the nearcore base image. digest is null when the line
// has none (the layout before this pipeline); the checks require one.
export function readNearcore(dockerfileText) {
  const lines = String(dockerfileText).split('\n').filter((l) => /^FROM\s/.test(l));
  const hits = lines.filter((l) => FROM_LINE.test(l));
  if (hits.length !== 1) throw new Error(`expected exactly one "FROM ... nearprotocol/nearcore:<version>" line in ${DOCKERFILE}, found ${hits.length}`);
  const m = FROM_LINE.exec(hits[0]);
  if (!parseVersion(m[2])) throw new Error(`the nearcore image tag in ${DOCKERFILE} is not a release version: ${m[2]}`);
  return { version: m[2], digest: m[3] || null };
}

// Writes version and digest into the FROM line; nothing else changes.
export function setNearcore(dockerfileText, version, digest) {
  if (!parseVersion(version)) throw new Error(`not a version: ${version}`);
  if (!DIGEST_RE.test(digest || '')) throw new Error(`not a sha256 digest: ${digest}`);
  readNearcore(dockerfileText);
  const out = dockerfileText.replace(FROM_LINE, (_, pre, _v, _d, post) => `${pre}${version}@${digest}${post || ''}`);
  const now = readNearcore(out);
  if (now.version !== version || now.digest !== digest) throw new Error(`could not set the nearcore image in ${DOCKERFILE}`);
  return out;
}

// Replaces only the top-level "version" and "upstream" lines of the manifest,
// so the file keeps its formatting, and proves nothing else changed.
export function setManifestFields(text, { version, upstream }) {
  const before = JSON.parse(text);
  let out = text;
  const set = (key, value) => {
    if (value === undefined) return;
    const re = new RegExp(`^( {2}"${key}":\\s*")([^"]*)(",?\\s*)$`, 'm');
    if (!re.test(out)) throw new Error(`no top-level "${key}" line in the manifest`);
    out = out.replace(re, (_, pre, _old, post) => `${pre}${value}${post}`);
  };
  set('version', version);
  set('upstream', upstream);
  const after = JSON.parse(out);
  const want = { ...before, ...(version !== undefined ? { version } : {}), ...(upstream !== undefined ? { upstream } : {}) };
  if (JSON.stringify(after) !== JSON.stringify(want)) throw new Error('setting the version changed more than the version and upstream');
  return out;
}

// The compose image tag the AVADOSDK expects: image: '<name>:<version>'.
export function readComposeImage(text, name) {
  const re = new RegExp(`^\\s*image:\\s*['"]?${name.replace(/\./g, '\\.')}:([^'"\\s]+)['"]?\\s*$`, 'gm');
  const all = [...String(text).matchAll(re)];
  if (all.length !== 1) throw new Error(`expected exactly one "image: ${name}:<version>" line in ${COMPOSE}, found ${all.length}`);
  return all[0][1];
}

export function setComposeImage(text, name, version) {
  readComposeImage(text, name);
  const re = new RegExp(`^(\\s*image:\\s*['"]?${name.replace(/\./g, '\\.')}:)([^'"\\s]+)(['"]?\\s*)$`, 'm');
  const out = text.replace(re, (_, pre, _old, post) => `${pre}${version}${post}`);
  if (readComposeImage(out, name) !== version) throw new Error(`could not set the image tag in ${COMPOSE}`);
  return out;
}

// The package facts at a git ref (for example origin/main), without checking it out.
export function packageAt(root, ref) {
  const m = JSON.parse(git(root, ['show', `${ref}:${MANIFEST}`]));
  const near = readNearcore(git(root, ['show', `${ref}:${DOCKERFILE}`]));
  return { name: m.name, version: m.version, upstream: m.upstream, nearcore: near.version, digest: near.digest };
}

export function readPackage(root) {
  const m = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
  const near = readNearcore(readFileSync(join(root, DOCKERFILE), 'utf8'));
  return { name: m.name, version: m.version, upstream: m.upstream, nearcore: near.version, digest: near.digest };
}

// The owner holds the package back: a file `hold` at the repo root. Its first
// line that is not a comment is the reason. While it exists the bump bot opens
// no PR, the gate merges nothing and the release publishes nothing; boxes keep
// what they have. Removing the file (a PR the owner merges) ends the hold.
const firstLine = (text) => String(text).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || 'held (no reason given)';
export function holdReason(root, ref = null) {
  if (ref) {
    try { return firstLine(git(root, ['show', `${ref}:${HOLD_FILE}`])); } catch { return null; }
  }
  const p = join(root, HOLD_FILE);
  return existsSync(p) ? firstLine(readFileSync(p, 'utf8')) : null;
}

// The content id of a commit (scripts/ci/content-id.sh): a hash of every
// tracked file except a release record releases.json. The PR checks name the
// build they tested after it; release.mjs looks it up.
export function contentId(root, rev = 'HEAD') {
  return execFileSync(join(root, 'scripts/ci/content-id.sh'), [rev], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Retries a read (or an idempotent call) that failed for a reason that may go
// away: network errors, timeouts, HTTP 5xx and 429. Anything else fails at once.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function isTransient(err) {
  const s = err?.status;
  return s === undefined || s === null || s >= 500 || s === 429 || s === 408;
}
export async function retry(what, fn, { tries = 3, delayMs = 5000, transient = isTransient } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt === tries || !transient(err)) break;
      console.log(`::warning::${what} failed (attempt ${attempt} of ${tries}): ${String(err.message).split('\n')[0]}; trying again`);
      await sleep(delayMs * attempt);
    }
  }
  throw last;
}

// --- git -------------------------------------------------------------------------

export function git(root, args, opts = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

// Git credentials through the environment (git 2.31+), so the token never
// appears in a command line or an error message. Works in private repos too
// (the workflows check out with persist-credentials: false).
export function gitAuthEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function fetchBranch(root, token, branch) {
  git(root, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { env: gitAuthEnv(token) });
}

// force: true overwrites the branch; lease (a sha, or '' for "must not exist")
// overwrites it only if it is still where this run saw it.
export function pushHead(root, token, branch, { force = false, lease = undefined } = {}) {
  const how = lease !== undefined ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : force ? ['--force'] : [];
  execFileSync('git', ['-C', root, 'push', '-q', ...how, 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'inherit', env: gitAuthEnv(token) });
}

// The sha a branch has on the remote now ('' when it does not exist).
export function remoteSha(root, token, branch) {
  const out = execFileSync('git', ['-C', root, 'ls-remote', 'origin', `refs/heads/${branch}`], { encoding: 'utf8', env: gitAuthEnv(token) });
  return out.split(/\s+/)[0] || '';
}

// Makes a commit (for example a tested PR head) available locally.
export function ensureCommit(root, token, sha) {
  try { git(root, ['cat-file', '-e', `${sha}^{commit}`]); return; } catch { /* fetch it */ }
  git(root, ['fetch', '-q', 'origin', sha], { env: gitAuthEnv(token) });
  git(root, ['cat-file', '-e', `${sha}^{commit}`]);
}

// Versions the CI released for a package name: commits "Release <name> <version>"
// by github-actions[bot] (ci-release-action and this pipeline's release.yml).
export function releasedVersions(root, name, ref = 'HEAD') {
  const out = git(root, ['log', ref, `--author=${BOT_NAME}`, '-F', `--grep=Release ${name} `, '--format=%s']);
  const re = new RegExp(`^Release ${name.replace(/\./g, '\\.')} (\\d+\\.\\d+\\.\\d+)$`);
  return out.split('\n').map((s) => re.exec(s.trim())?.[1]).filter(Boolean);
}

// --- production store (read only) ----------------------------------------------------

// The package as the production store serves it: { hash, version, upstream },
// with version and upstream null when the store has no such package.
export async function readProduction({ http, name, pointerUrl = 'https://bo.ava.do/value/store', gateways = ['http://80.208.229.228:8080', 'https://ipfs.io'] }) {
  let v = JSON.parse(await http.text(pointerUrl, { headers: { 'Cache-Control': 'no-cache' } }));
  if (typeof v === 'string') v = JSON.parse(v);
  let lastErr;
  for (const gw of gateways) {
    try {
      const store = await http.json(`${gw}/ipfs/${v.hash}`, { timeout: 60000 });
      const p = (store.packages || []).find((x) => x.manifest?.name === name);
      return { hash: v.hash, version: p?.manifest?.version || null, upstream: p?.manifest?.upstream || null };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('production store unreadable');
}

// --- small things ------------------------------------------------------------------------

export function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function hoursBetween(a, b) {
  return (new Date(b) - new Date(a)) / 3600000;
}

export function fmtUtc(d) {
  return new Date(d).toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
}

// GitHub Actions log helpers.
export const notice = (msg) => console.log(`::notice::${String(msg).replace(/\n/g, '%0A')}`);
export const warning = (msg) => console.log(`::warning::${String(msg).replace(/\n/g, '%0A')}`);

// A failing script writes what went wrong here; report.mjs puts it into the
// owner's "[pipeline broken]" issue, so the email says what to do.
export function failureFile() {
  return env('PIPELINE_FAILURE_FILE', join(env('RUNNER_TEMP', '/tmp'), 'pipeline-failure.md'));
}
export function recordFailure(text) {
  try { writeFileSync(failureFile(), `${String(text).trim()}\n`); } catch { /* the log still has it */ }
}
