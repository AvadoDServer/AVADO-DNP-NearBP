// Unit tests for the pipeline rules: node --test ".github/pipeline/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { decide, logExcerpt, ownerMergeFiles, retryable, ALLOWED_BOT_FILES } from '../gate.mjs';
import { stripBuild } from '../release.mjs';
import {
  releaseKind, mainnetReleases, classify, covered, summarize, oneWayNote, noticeText, noticeData, syncNotices, deadlineText,
} from '../lib/near.js';
import {
  compareVersions, bumpPatch, maxVersion, stableReleases, readNearcore, setNearcore, setManifestFields, readComposeImage,
  setComposeImage, bumpMarker, markerTarget, holdReason, contentId,
} from '../lib/common.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// --- real nearcore release headers (github.com/near/nearcore/releases) ------------------
const header = (color, protocol, database, security, version) =>
  `\`\`\`\r\nCODE_COLOR: ${color}\r\nRELEASE_VERSION: ${version}\r\nPROTOCOL_UPGRADE: ${protocol}\r\nDATABASE_UPGRADE: ${database}\r\nSECURITY_UPGRADE: ${security}\r\n\`\`\`\r\n`;
const rel = (tag, published, body, extra = {}) => ({ tag_name: tag, published_at: published, draft: false, prerelease: false, html_url: `https://github.com/near/nearcore/releases/tag/${tag}`, body, ...extra });
const R = {
  '2.13.4': rel('2.13.4', '2026-09-03T15:03:23Z', `${header('CODE_RED_MAINNET, CODE_RED_TESTNET', 'FALSE', 'FALSE', 'TRUE', '2.13.4')}This release fixes critical flaws in nearcore that could cause node crash/DoS.\r\nUpgrade as soon as possible to avoid node downtime.`),
  '2.13.3': rel('2.13.3', '2026-08-04T15:14:49Z', `${header('CODE_GREEN_MAINNET, CODE_GREEN_TESTNET', 'FALSE', 'FALSE', 'FALSE', '2.13.3')}Bug fixes.`),
  '2.13.2': rel('2.13.2', '2026-07-27T14:02:04Z', `${header('CODE_RED_MAINNET, CODE_RED_TESTNET', 'FALSE', 'FALSE', 'TRUE', '2.13.2')}Critical fixes.`),
  '2.13.1': rel('2.13.1', '2026-07-15T13:04:02Z', `${header('CODE_YELLOW_MAINNET', 'TRUE', 'FALSE', 'FALSE', '2.13.1')}\r\nThis release includes a fix for the code that is a part of the protocol version 85.\r\n\r\nVoting for protocol version 86 will start on **Monday July 20th 00:00 UTC**.\r\n**To continue participating in consensus, you need to upgrade your node before this time.**`),
  '2.13.0-rc.3': rel('2.13.0-rc.3', '2026-07-14T19:12:51Z', header('CODE_YELLOW_TESTNET', 'TRUE', 'TRUE', 'FALSE', '2.13.0-rc.3'), { prerelease: true }),
  '2.13.0': rel('2.13.0', '2026-07-09T13:07:41Z', `${header('CODE_YELLOW_MAINNET', 'TRUE', 'TRUE', 'FALSE', '2.13.0')}\r\n# Protocol upgrade voting\r\nVoting for protocol version 85 will start on **Monday July 20th 00:00 UTC**.`),
  '2.6.5': rel('2.6.5', '2025-07-03T15:41:49Z', `${header('CODE_YELLOW_MAINNET', 'FALSE', 'FALSE', 'FALSE', '2.6.5')}Recommended.`),
  '2.14.0-rc.2': rel('2.14.0-rc.2', '2026-09-17T11:56:28Z', `${header('CODE_GREEN_TESTNET', 'FALSE', 'FALSE', 'FALSE', '2.14.0-rc.2')}rc`, { prerelease: true }),
  // nearcore has published rc tags that are not marked as pre-releases
  '1.38.0-rc.2': rel('1.38.0-rc.2', '2024-03-12T16:05:29Z', header('CODE_YELLOW_TESTNET', 'TRUE', 'FALSE', 'FALSE', '1.38.0-rc.2')),
  // and one stable tag without a header
  '1.37.2': rel('1.37.2', '2024-03-12T02:00:51Z', 'Hotfix release.'),
};

test('mainnet releases only: never an rc, a pre-release, a draft or a testnet-only header', () => {
  assert.equal(releaseKind(R['2.13.4']).mainnet, true);
  assert.equal(releaseKind(R['2.14.0-rc.2']).mainnet, false);
  assert.equal(releaseKind(R['1.38.0-rc.2']).mainnet, false, 'rc tag not marked as pre-release');
  assert.equal(releaseKind({ ...R['2.13.3'], draft: true }).mainnet, false);
  const testnetOnly = rel('2.15.0', '2026-10-01T00:00:00Z', header('CODE_GREEN_TESTNET', 'FALSE', 'FALSE', 'FALSE', '2.15.0'));
  assert.equal(releaseKind(testnetOnly).mainnet, false);
  assert.match(releaseKind(testnetOnly).why, /testnet only/);
  const k = releaseKind(R['1.37.2']);
  assert.equal(k.mainnet, true, 'a stable tag without a header is a normal release');
  assert.equal(k.unknown, true, '... and the owner is told');
  const list = mainnetReleases(Object.values(R)).map((r) => r.tag_name);
  assert.deepEqual(list, ['2.13.4', '2.13.3', '2.13.2', '2.13.1', '2.13.0', '2.6.5', '1.37.2']);
});

test('required releases: CODE_RED_MAINNET, PROTOCOL_UPGRADE, SECURITY_UPGRADE; with the deadline', () => {
  const red = classify(R['2.13.4']);
  assert.equal(red.mandatory, true);
  assert.deepEqual(red.reasons, ['CODE_RED_MAINNET', 'SECURITY_UPGRADE: TRUE']);
  assert.equal(red.deadline, '2026-09-10T15:03:23.000Z', 'CODE_RED / security: release + 7 days');
  assert.equal(red.protocol, false);
  const proto = classify(R['2.13.1']);
  assert.equal(proto.mandatory, true);
  assert.deepEqual(proto.reasons, ['PROTOCOL_UPGRADE: TRUE']);
  assert.equal(proto.deadline, '2026-07-20T00:00:00.000Z', 'the voting date in the notes');
  assert.equal(proto.protocol, true);
  const db = classify(R['2.13.0']);
  assert.equal(db.mandatory, true);
  assert.equal(db.database, true);
  assert.equal(classify(R['2.13.3']).mandatory, false, 'CODE_GREEN');
  assert.equal(classify(R['2.6.5']).mandatory, false, 'CODE_YELLOW without an upgrade flag waits the 72 h');
  assert.equal(classify(R['1.37.2']).mandatory, false);
  assert.equal(classify(R['1.37.2']).unknownHeader, true);
  // a lowercase flag still counts (the safe side)
  const lower = rel('2.15.1', '2026-10-01T00:00:00Z', header('CODE_YELLOW_MAINNET', 'True', 'FALSE', 'FALSE', '2.15.1'));
  assert.equal(classify(lower).mandatory, true);
});

test('covered releases and their summary: earliest deadline, one-way steps', () => {
  const list = covered(Object.values(R), '2.12.0', '2.13.4');
  assert.deepEqual(list.map((c) => c.tag), ['2.13.0', '2.13.1', '2.13.2', '2.13.3', '2.13.4'], 'oldest first, rc and pre-releases left out');
  const s = summarize(list);
  assert.deepEqual(s.mandatory.map((c) => c.tag), ['2.13.0', '2.13.1', '2.13.2', '2.13.4']);
  assert.equal(s.deadline, '2026-07-20T00:00:00.000Z');
  assert.deepEqual(s.oneWay.map((c) => c.tag), ['2.13.0', '2.13.1']);
  assert.equal(summarize(covered(Object.values(R), '2.13.2', '2.13.3')).mandatory.length, 0, 'a green release alone waits');
  assert.equal(summarize(covered(Object.values(R), '2.13.4', '2.13.4')).mandatory.length, 0, 'nothing newer: nothing covered');
  const note = oneWayNote(s.oneWay, { fromNearcore: '2.12.0', fromPackage: '0.0.72' });
  assert.match(note, /cannot go back to nearbp 0\.0\.72/);
  assert.match(note, /migrates the node database/);
  assert.equal(oneWayNote([], {}), '');
  assert.match(deadlineText('2026-07-20T00:00:00Z', new Date('2026-07-19T00:00:00Z')), /in 1 d 0 h/);
  assert.match(deadlineText('2026-07-20T00:00:00Z', new Date('2026-07-21T01:00:00Z')), /PASSED 1 d 1 h ago/);
  assert.match(deadlineText(null), /as soon as possible/);
});

// --- the gate ---------------------------------------------------------------------------
const released = '2026-09-17T02:27:13Z';
const at = (h) => new Date(new Date(released).getTime() + h * 3600000);
const base = { checks: 'success', release: { publishedAt: released, mainnet: true, why: null }, mandatory: null, now: at(1), upToDate: true, conflict: false };

test('a required release merges as soon as our checks are green', () => {
  const d = decide({ ...base, mandatory: { source: 'nearcore 2.13.4: CODE_RED_MAINNET' } });
  assert.equal(d.action, 'merge');
  assert.equal(d.cause, 'mandatory');
});

test('a normal release waits 72 h after nearcore published it, then merges', () => {
  const w = decide({ ...base, now: at(71.9) });
  assert.equal(w.action, 'wait');
  assert.equal(w.cause, 'upstream-age');
  assert.equal(w.mergeAt, at(72).toISOString());
  const d = decide({ ...base, now: at(72) });
  assert.equal(d.action, 'merge');
  assert.equal(d.cause, 'waited');
});

test('never merges when our checks failed, and says so before anything else', () => {
  const d = decide({ ...base, checks: 'failure', mandatory: { source: 'x' } });
  assert.equal(d.action, 'block');
  assert.equal(d.cause, 'checks-failed');
  assert.equal(decide({ ...base, checks: 'failure', release: null }).cause, 'checks-failed');
  assert.equal(decide({ ...base, checks: 'error', now: at(500) }).cause, 'checks-failed');
});

test('waits while checks run or the branch is behind; silent checks block after 6 h', () => {
  assert.equal(decide({ ...base, checks: 'pending', mandatory: { source: 'x' } }).cause, 'checks');
  assert.equal(decide({ ...base, checks: 'missing' }).cause, 'checks');
  assert.equal(decide({ ...base, upToDate: false, mandatory: { source: 'x' } }).cause, 'behind');
  const headAt = at(0).toISOString();
  assert.equal(decide({ ...base, checks: 'missing', headAt, now: at(5.9) }).action, 'wait');
  const d = decide({ ...base, checks: 'pending', headAt, now: at(6) });
  assert.equal(d.action, 'block');
  assert.equal(d.cause, 'unclear');
});

test('anything unclear blocks: no release, not a mainnet release, read errors, conflicts, unexpected files', () => {
  assert.equal(decide({ ...base, release: null }).cause, 'unclear');
  const nm = decide({ ...base, release: { publishedAt: released, mainnet: false, why: 'the header says CODE_COLOR: CODE_GREEN_TESTNET (testnet only)' }, mandatory: { source: 'x' } });
  assert.equal(nm.action, 'block');
  assert.match(nm.why, /not a mainnet release/);
  assert.equal(decide({ ...base, errors: ['nearcore releases: HTTP 500'] }).cause, 'unclear');
  assert.equal(decide({ ...base, conflict: true }).cause, 'conflict');
  assert.equal(decide({ ...base, unexpectedFiles: ['build/files/config.json'] }).cause, 'unexpected-files');
});

test('a hold stops the gate without an issue', () => {
  const d = decide({ ...base, mandatory: { source: 'x' }, held: 'waiting for the DB migration test on the test box' });
  assert.equal(d.action, 'wait');
  assert.equal(d.cause, 'held');
});

test('the bot may only change the Dockerfile, the manifest and the compose file', () => {
  for (const f of ['build/Dockerfile', 'dappnode_package.json', 'docker-compose.yml']) assert.ok(ALLOWED_BOT_FILES.test(f), f);
  for (const f of ['build/files/config.json', 'build/files/entrypoint.sh', '.github/pipeline/gate.mjs', 'hold']) assert.ok(!ALLOWED_BOT_FILES.test(f), f);
});

test('a person changing the checks or the pipeline on the bot branch leaves the merge to the owner', () => {
  const files = ['build/Dockerfile', 'dappnode_package.json', 'build/files/config.json', 'build/files/entrypoint.sh'];
  assert.deepEqual(ownerMergeFiles(files, false), [], 'a config or entrypoint fix may still merge by itself');
  for (const f of ['scripts/ci/check-config.sh', 'scripts/ci/lib-near.sh', '.github/pipeline/release.mjs', '.github/workflows/release.yml', 'hold', 'releases.json']) {
    assert.deepEqual(ownerMergeFiles([...files, f], false), [f], f);
  }
  assert.deepEqual(ownerMergeFiles(['scripts/ci/check-config.sh'], true), [], 'bot-only PRs are guarded by the unexpected-files rule');
  const d = decide({ ...base, ownerFiles: ['scripts/ci/check-config.sh'] });
  assert.equal(d.action, 'block');
  assert.equal(d.cause, 'owner-merge');
});

test('checks that failed on an outside step run once more, without an issue', () => {
  const outside = [{ name: 'Boot on NEAR mainnet', step: 'Boots on NEAR mainnet' }, { name: 'Upgrade in place', step: 'Production image (from the production store)' }];
  assert.ok(retryable(outside));
  assert.ok(retryable([{ name: 'Build (AVADOSDK, version, config and flags)', step: 'AVADOSDK build (build, add to IPFS)' }]));
  assert.ok(retryable([{ name: 'Upgrade in place', steps: ['Upgrades a box in place (production image, then this build on the same volume)'] }]));
  assert.ok(retryable([{ name: 'Boot on NEAR mainnet', step: null }]), 'a job lost without a failed step (runner) is retried');
  assert.ok(!retryable([...outside, { name: 'Build (AVADOSDK, version, config and flags)', step: 'Every config key and neard flag is accepted' }]));
  assert.ok(!retryable([{ name: 'Build (AVADOSDK, version, config and flags)', step: 'Exact nearcore version' }]));
  assert.ok(!retryable([{ name: 'Plan (unit tests, digest, identity)', step: 'Identity (name, volume, port, env keys, versions)' }]));
  assert.ok(!retryable([{ name: 'Boot on NEAR mainnet', step: 'Load the tested image' }]), 'a tested image that does not match is not an outside problem');
  assert.ok(!retryable([]));
  const d = decide({ ...base, checks: 'failure', rerun: 'Boot on NEAR mainnet: Boots on NEAR mainnet' });
  assert.equal(d.action, 'wait');
  assert.equal(d.cause, 'rerun');
});

test('the issue shows the failing lines of a job log, not setup or cleanup noise', () => {
  const log = [
    '2026-09-26T22:10:18.1Z ##[group]Run node --test ".github/pipeline/test/*.test.mjs"',
    '2026-09-26T22:10:18.2Z ok 23 - the "[required]" issue closes when a newer bump replaces it',
    '2026-09-26T22:10:18.3Z # pass 23',
    '2026-09-26T22:10:19.1Z ##[group]Run scripts/ci/check-config.sh',
    '2026-09-26T22:10:19.2Z   PASS  validate-config        neard validate-config accepts our config.json',
    '2026-09-26T22:10:19.4Z   FAIL  unknown-keys           neard does not know these config.json keys (it ignores them): store.state_snapshot_config',
    '2026-09-26T22:10:19.7Z \x1b[36;1mshell: /usr/bin/bash -e {0}\x1b[0m',
    '2026-09-26T22:10:19.8Z ##[error]Process completed with exit code 1.',
    '2026-09-26T22:10:19.9Z Post job cleanup.',
    '2026-09-26T22:10:20.0Z [command]/usr/bin/git version',
  ].join('\n');
  const x = logExcerpt(log);
  assert.match(x, /FAIL {2}unknown-keys/);
  assert.match(x, /##\[error\]/);
  assert.doesNotMatch(x, /Post job|\[command\]|\x1b|shell: /);
  assert.doesNotMatch(x, /# pass 23|ok 23/, 'only the failing step, not the unit tests before it');
});

// --- files the bump writes --------------------------------------------------------------------
const lines = (a, b) => a.split('\n').filter((l, i) => l !== b.split('\n')[i]).length;

test('the bump edits only the nearcore line of the real Dockerfile', () => {
  const text = readFileSync(join(ROOT, 'build/Dockerfile'), 'utf8');
  const now = readNearcore(text);
  assert.match(now.digest, /^sha256:[0-9a-f]{64}$/, 'the committed Dockerfile pins a digest');
  const other = bumpPatch(now.version);
  const d = `sha256:${'a'.repeat(64)}` === now.digest ? `sha256:${'b'.repeat(64)}` : `sha256:${'a'.repeat(64)}`;
  const out = setNearcore(text, other, d);
  assert.deepEqual(readNearcore(out), { version: other, digest: d });
  assert.equal(lines(out, text), 1);
  assert.equal(setNearcore(out, now.version, now.digest), text);
  assert.throws(() => setNearcore(text, other, 'latest'));
  assert.throws(() => readNearcore(`${text}\nFROM nearprotocol/nearcore:2.0.0\n`), /exactly one/);
  assert.deepEqual(readNearcore('FROM --platform=linux/amd64 nearprotocol/nearcore:2.13.4\n'), { version: '2.13.4', digest: null }, 'the layout before the pipeline');
  assert.throws(() => readNearcore('FROM nearprotocol/nearcore:latest\n'), /not a release version/);
});

test('the bump edits only version and upstream in the manifest, and the image tag in compose', () => {
  const text = readFileSync(join(ROOT, 'dappnode_package.json'), 'utf8');
  const m = JSON.parse(text);
  const out = setManifestFields(text, { version: bumpPatch(m.version), upstream: bumpPatch(m.upstream) });
  const after = JSON.parse(out);
  assert.equal(after.version, bumpPatch(m.version));
  assert.equal(after.upstream, bumpPatch(m.upstream));
  assert.equal(lines(out, text), 2);
  assert.deepEqual({ ...after, version: m.version, upstream: m.upstream }, m);
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.equal(readComposeImage(compose, m.name), m.version);
  const c2 = setComposeImage(compose, m.name, bumpPatch(m.version));
  assert.equal(readComposeImage(c2, m.name), bumpPatch(m.version));
  assert.equal(lines(c2, compose), 1);
});

test('versions', () => {
  assert.equal(compareVersions('2.13.10', '2.13.9'), 1);
  assert.equal(bumpPatch('0.0.76'), '0.0.77');
  assert.equal(maxVersion(['0.0.75', '0.0.9', '0.0.100']), '0.0.100');
  assert.deepEqual(stableReleases(Object.values(R)).map((r) => r.tag_name).slice(0, 2), ['2.13.4', '2.13.3']);
});

test('the bump PR marker names its nearcore version (closing the PR skips that version)', () => {
  assert.equal(markerTarget(`${bumpMarker('2.14.0')}\n## nearcore 2.14.0`), '2.14.0');
  assert.equal(markerTarget(`${bumpMarker(null)}\n## TEST`), null, 'a [TEST] PR never skips a real version');
});

test('hold: the first line that is not a comment is the reason; no file means not held', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hold-'));
  assert.equal(holdReason(dir), null);
  writeFileSync(join(dir, 'hold'), '\n# why\nwait for the 2.14 migration test on the test box\n');
  assert.equal(holdReason(dir), 'wait for the 2.14 migration test on the test box');
  writeFileSync(join(dir, 'hold'), '# only comments\n');
  assert.equal(holdReason(dir), 'held (no reason given)');
});

test('the content id ignores release records only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'content-id-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q');
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/ci/content-id.sh'), join(dir, 'scripts/ci/content-id.sh'));
  writeFileSync(join(dir, 'dappnode_package.json'), '{"version":"0.0.76"}\n');
  const commit = (msg, empty = false) => { g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', ...(empty ? ['--allow-empty'] : []), '-m', msg); return g('rev-parse', 'HEAD'); };
  const a = commit('a');
  const b = commit('Release nearbp.avado.dnp.dappnode.eth 0.0.76', true);
  writeFileSync(join(dir, 'releases.json'), '{"0.0.76":{"hash":"/ipfs/Qm"}}\n');
  const c = commit('record');
  writeFileSync(join(dir, 'dappnode_package.json'), '{"version":"0.0.77"}\n');
  const d = commit('d');
  assert.equal(contentId(dir, a), contentId(dir, b), 'an empty Release commit does not change the content id');
  assert.equal(contentId(dir, a), contentId(dir, c), 'nor does a releases.json record');
  assert.notEqual(contentId(dir, c), contentId(dir, d));
  assert.match(contentId(dir, a), /^[0-9a-f]{40}$/);
});

test('the release compares the uploaded manifest without what the AVADOSDK adds', () => {
  const m = JSON.parse(readFileSync(join(ROOT, 'dappnode_package.json'), 'utf8'));
  const uploaded = { ...structuredClone(m), avatar: '/ipfs/QmNew', builddate: '2026-09-27T00:00:00Z', image: { ...m.image, path: 'x.tar.xz', hash: '/ipfs/Qm', size: 1 } };
  assert.deepEqual(stripBuild(uploaded), stripBuild(m));
  assert.notDeepEqual(stripBuild({ ...uploaded, version: '9.9.9' }), stripBuild(m));
});

// --- the owner's "[required]" issues ------------------------------------------------------------
function fakeGitHub(issues) {
  const calls = [];
  let next = 100;
  const gh = {
    calls,
    async get(path) {
      if (/\/issues\?state=(open|all)/.test(path)) return issues.filter((i) => path.includes('state=all') || i.state === 'open');
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (/\/issues$/.test(path)) { const i = { number: next++, state: 'open', html_url: `u/${next}`, ...body }; issues.push(i); return i; }
      return {};
    },
    async patch(path, body) {
      calls.push(['PATCH', path, body]);
      const n = Number(/issues\/(\d+)$/.exec(path)?.[1]);
      const i = issues.find((x) => x.number === n);
      if (i) Object.assign(i, body);
      return i;
    },
  };
  return gh;
}
const required = (target, deadline = '2026-09-10T15:03:23.000Z') => ({
  kind: 'mandatory', target, from: '2.13.3', packageVersion: '0.0.77', pr: 7, deadline, deadlineNote: 'release + 7 days',
  mandatory: [{ tag: target, reasons: ['CODE_RED_MAINNET'], protocol: false }], items: [], oneWay: null,
});
const issueFor = (number, d, state) => {
  const { body } = noticeText(d, { phase: state, repo: 'o/r', mode: 'on' });
  return { number, state: 'open', body: `<!-- avado-pipeline:issue key=${d.kind}-${d.target} -->\n<!-- avado-pipeline:state ${state}@${d.target} -->\n${body}` };
};

test('the "[required]" issue carries its facts and a deadline in the title', () => {
  const d = required('2.13.4');
  const { title, body } = noticeText(d, { phase: 'pr', repo: 'o/r', mode: 'shadow', pr: 7 });
  assert.match(title, /^\[required\] nearcore 2\.13\.4 .*before 2026-09-10 15:03 UTC/);
  assert.match(body, /shadow mode\): the gate will NOT merge it/, 'shadow mode tells the owner to merge by hand');
  assert.deepEqual(noticeData(body), d, 'the facts survive in the body');
  assert.match(noticeText(d, { phase: 'staging', repo: 'o/r', mode: 'on', stagingVersion: '0.0.77' }).body, /on the staging store\*\* as nearbp 0\.0\.77/);
  assert.match(noticeText(d, { phase: 'image', repo: 'o/r', mode: 'on' }).body, /not on Docker Hub yet/);
  assert.match(noticeText({ ...d, kind: 'header', why: 'nearcore 2.13.4: the release has no readable header' }, { phase: 'pr', repo: 'o/r', mode: 'on', pr: 7 }).title, /^\[check\]/);
});

test('the "[required]" issue moves along: staging, then closed when production has it', async () => {
  const issues = [issueFor(1, required('2.13.4'), 'pr')];
  const gh = fakeGitHub(issues);
  const main = { upstream: '2.13.4', version: '0.0.77', released: true, hold: null };
  await syncNotices({ gh, repo: 'o/r', owner: 'flisko', mode: 'on', main, pr: null, prodUpstream: '2.13.3' });
  assert.match(issues[0].body, /avado-pipeline:state staging@2\.13\.4/);
  assert.ok(gh.calls.some(([m, p, b]) => m === 'POST' && /comments$/.test(p) && /on STAGING now/.test(b.body)), 'one comment (one email) for the new phase');
  const before = gh.calls.length;
  await syncNotices({ gh, repo: 'o/r', owner: 'flisko', mode: 'on', main, pr: null, prodUpstream: '2.13.3' });
  assert.ok(!gh.calls.slice(before).some(([m, p]) => m === 'POST' && /comments$/.test(p)), 'no new email while nothing changes');
  await syncNotices({ gh, repo: 'o/r', owner: 'flisko', mode: 'on', main, pr: null, prodUpstream: '2.13.4' });
  assert.equal(issues[0].state, 'closed');
});

test('the "[required]" issue closes when a newer bump replaces it or the PR was closed; stays while held', async () => {
  const issues = [issueFor(1, required('2.13.4'), 'pr'), issueFor(2, required('2.13.2'), 'pr'), issueFor(3, required('2.13.3'), 'held')];
  const gh = fakeGitHub(issues);
  const main = { upstream: '2.13.1', version: '0.0.76', released: true, hold: null };
  await syncNotices({ gh, repo: 'o/r', owner: 'flisko', mode: 'on', main, pr: { number: 9, target: '2.13.5' }, prodUpstream: '2.13.1' });
  assert.equal(issues[0].state, 'closed', 'replaced by the PR for 2.13.5');
  const gh2 = fakeGitHub([issueFor(4, required('2.13.4'), 'pr')]);
  await syncNotices({ gh: gh2, repo: 'o/r', owner: 'flisko', mode: 'on', main, pr: null, prodUpstream: '2.13.1' });
  assert.ok(gh2.calls.some(([m, p, b]) => m === 'PATCH' && b.state === 'closed'), 'no PR any more: the owner skipped it');
  const held = [issueFor(5, required('2.13.4'), 'held')];
  const gh3 = fakeGitHub(held);
  await syncNotices({ gh: gh3, repo: 'o/r', owner: 'flisko', mode: 'on', main: { ...main, hold: 'waiting' }, pr: null, prodUpstream: '2.13.1' });
  assert.equal(held[0].state, 'open', 'held: it stays open until the owner acts');
  const waiting = [issueFor(7, required('2.13.4'), 'image')];
  await syncNotices({ gh: fakeGitHub(waiting), repo: 'o/r', owner: 'flisko', mode: 'on', main, pr: null, prodUpstream: '2.13.1' });
  assert.equal(waiting[0].state, 'open', 'no PR yet because the image is missing: it stays open');
  const merged = [issueFor(8, required('2.13.4'), 'pr')];
  const gh5 = fakeGitHub(merged);
  await syncNotices({ gh: gh5, repo: 'o/r', owner: 'flisko', mode: 'on', main: { ...main, upstream: '2.13.4', released: false }, pr: null, prodUpstream: '2.13.1' });
  assert.equal(gh5.calls.length, 0, 'merged but not published yet: no change, no email');
  const gh4 = fakeGitHub([issueFor(6, required('2.13.4'), 'pr')]);
  await syncNotices({ gh: gh4, repo: 'o/r', owner: 'flisko', mode: 'on', main, pr: null, prodUpstream: '2.13.1', onlyMerged: true });
  assert.equal(gh4.calls.length, 0, 'the release only touches issues of merged versions');
});
