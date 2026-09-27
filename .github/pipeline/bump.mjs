#!/usr/bin/env node
// Bump bot (bump.yml, every 4 hours): when nearcore publishes a newer MAINNET
// release (see lib/near.js: stable X.Y.Z tag, header CODE_COLOR *_MAINNET;
// never an rc or a testnet release) and its Docker image exists, open or update
// ONE pull request on branch avado-bot/bump that moves NEAR to it:
//   build/Dockerfile        FROM nearprotocol/nearcore:<version>@<digest>
//   dappnode_package.json   "upstream": <version>, "version": one patch up
//   docker-compose.yml      image: '<name>:<new package version>'
// Required releases (CODE_RED_MAINNET, PROTOCOL_UPGRADE or SECURITY_UPGRADE)
// get an issue for the owner at once, with the deadline ("[required]"); the
// gate fast-tracks them. A release whose header cannot be read gets a
// "[check]" issue. While the owner holds the package (a `hold` file on the
// default branch) nothing is bumped; a required release is still reported.
// A version whose PR the owner closed without merging is skipped: the bot
// waits for a newer release (reopening the PR undoes the skip).
//
// Environment:
//   GITHUB_REPOSITORY, GITHUB_TOKEN   this repo; reads, and the fallback for writes
//   PAT_TOKEN                          optional: pushes and PRs made with it start
//                                      the PR checks (GITHUB_TOKEN ones do not);
//                                      without it, or when GitHub rejects it
//                                      (expired), the checks are started by hand
//                                      (workflow_dispatch of pr-checks.yml) and
//                                      the owner gets an issue to renew it
//   PIPELINE_OWNER                     who gets the issues (default flisko)
//   PIPELINE_MODE                      only for the wording of the "[required]" issue
//   INPUT_VERSION                      TEST ONLY: pretend this is the newest nearcore
//   DRY_RUN=true                       print what would happen, write nothing
//
// Run in a checkout of the default branch with full history (fetch-depth: 0).

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeClient } from './lib/gh.js';
import { upsertIssue, findIssue, closeIssue } from './lib/issue.js';
import { mainnetReleases, covered as coveredReleases, summarize, deadlineText, oneWayNote, upsertNotice } from './lib/near.js';
import {
  BOT_NAME, BOT_EMAIL, BOT_BRANCH, UPSTREAM_REPO, UPSTREAM_IMAGE, MANIFEST, COMPOSE, DOCKERFILE, bumpMarker, markerTarget,
  compareVersions, bare, maxVersion, bumpPatch, readNearcore, setNearcore, setManifestFields, setComposeImage, packageAt,
  holdReason, git, fetchBranch, pushHead, remoteSha, releasedVersions, readProduction, env, fmtUtc, hoursBetween, notice,
  warning, recordFailure,
} from './lib/common.js';

const root = process.cwd();
const repo = env('GITHUB_REPOSITORY');
const token = env('GITHUB_TOKEN');
const pat = env('PAT_TOKEN');
const pretend = env('INPUT_VERSION');
const dryRun = env('DRY_RUN') === 'true';
const owner = env('PIPELINE_OWNER', 'flisko');
const mode = env('PIPELINE_MODE', 'shadow');
// How long a released nearcore may lack its Docker Hub image before the bot says so.
const IMAGE_WAIT_HOURS = 24;
const WAIT_HOURS = 72;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const summaryLines = [];
const say = (line) => { console.log(line); summaryLines.push(line); };

function writeSummary() {
  const f = env('GITHUB_STEP_SUMMARY');
  if (f) appendFileSync(f, `${summaryLines.join('\n')}\n`);
}

function isBotCommit(c) {
  const email = c.commit?.author?.email || '';
  const msg = c.commit?.message || '';
  return email === BOT_EMAIL && (/^Bump nearcore to /.test(msg) || /^Merge .* into avado-bot\/bump/.test(msg));
}

// Is PAT_TOKEN still accepted? An expired or revoked token answers 401.
async function patWorks() {
  if (!pat) return false;
  try {
    await makeClient({ token: pat }).get(`repos/${repo}`);
    return true;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      warning(`PAT_TOKEN was rejected (HTTP ${err.status}: expired or revoked); using the built-in token and starting the checks by hand`);
      return false;
    }
    warning(`could not check PAT_TOKEN (${err.message}); trying it anyway`);
    return true;
  }
}

async function reportPat(gh, ok) {
  if (dryRun) return;
  const key = 'pat-token-rejected';
  try {
    if (ok || !pat) {
      const issue = await findIssue(gh, repo, key);
      if (issue?.state === 'open') await closeIssue(gh, repo, issue, pat ? 'PAT_TOKEN works again.' : 'PAT_TOKEN is not set any more; the bot works without it (it starts the checks itself).');
      return;
    }
    await upsertIssue(gh, repo, {
      key,
      title: '[pipeline] PAT_TOKEN was rejected: renew it',
      assignee: owner,
      state: 'rejected',
      body: `GitHub rejected the repository secret \`PAT_TOKEN\` (a personal access token; they expire). The bump bot still works: it pushes with the built-in token and starts the PR checks itself, so the PR shows an extra "PR checks" run marked "action required" that can be ignored.

**To fix it:** create a fine-grained token at github.com/settings/personal-access-tokens: resource owner AvadoDServer, only this repository (${repo}), permissions Contents: read and write and Pull requests: read and write, with an expiry date. Then Settings -> Secrets and variables -> Actions -> \`PAT_TOKEN\` -> Update. Or delete the secret: the bot works without it. This issue closes by itself on the next bump run after that.`,
    });
  } catch (err) {
    warning(`could not report the PAT_TOKEN state (${err.message})`);
  }
}

function renderBody({ target, from, release, pkg, to, sum, list, pretendNote, checksNote, marker }) {
  const skipped = list.filter((c) => c.tag !== target).map((c) => `[${c.tag}](${c.url})`);
  const headers = list.map((c) => `- [nearcore ${c.tag}](${c.url}): ${c.header || `**no readable header** (${c.headerWhy})`}${c.mandatory ? ` → **required** (${c.reasons.join(', ')})` : ''}`).join('\n');
  const mergeAt = release ? fmtUtc(new Date(release.published_at).getTime() + WAIT_HOURS * 3600000) : null;
  const required = sum.mandatory.length
    ? `\n> **Required upgrade** (${sum.mandatory.map((c) => `${c.tag}: ${c.reasons.join(', ')}`).join('; ')}). **Deadline: ${deadlineText(sum.deadline)}**${sum.deadlineNote ? ` (${sum.deadlineNote})` : ''}. The gate merges this PR as soon as our checks are green (no 72 h wait), and the owner got a "[required]" issue with the deadline. Production is still the owner's click in editstore.\n`
    : '';
  const oneWay = oneWayNote(sum.oneWay, { fromNearcore: from, fromPackage: pkg.version });
  const unknown = sum.unknown.length
    ? `\n> **Release header not readable** for ${sum.unknown.map((c) => c.tag).join(', ')}: treated as a normal release (72 h wait). If NEAR says it is urgent, merge this PR by hand once \`avado/checks\` is green.\n`
    : '';
  return `${marker}
## nearcore ${target} for NEAR
${pretendNote || ''}
nearcore ${from} → **${target}**${release ? ` ([release notes](${release.html_url}), published ${fmtUtc(release.published_at)})` : ''}.${skipped.length ? ` This also covers ${skipped.join(', ')}.` : ''}
${required}${unknown}${oneWay ? `\n${oneWay}\n` : ''}
| Package | Now | New |
|---|---|---|
| \`${pkg.name}\` | ${pkg.version} (nearcore ${from}) | **${to}** (nearcore ${target}) |

${headers ? `### Release headers\n${headers}\n` : ''}
### What happens next (nothing to do unless you get an email)
1. **Checks** (\`avado/checks\`): the package is built with the AVADOSDK (files added to AVADO's IPFS node), the neard inside is exactly nearcore ${target}, neard accepts every key of our config.json and every flag the entrypoint passes, the name, volume, port and settings are compared with main and production, the package **boots on NEAR mainnet** (the epoch sync proof is accepted, it finds peers and header sync moves), and a box **upgrades in place** from the production version (validator_key.json and node_key.json stay byte for byte the same, the database is kept).${checksNote || ''}
2. **Gate** (\`avado/gate\`, every 4 hours and after the checks): ${sum.mandatory.length ? 'this is a **required** release: it merges as soon as the checks are green.' : `a normal release: it merges when the checks are green and 72 hours have passed since nearcore published it${mergeAt ? ` (${mergeAt})` : ''}.`} If our checks fail or anything is unclear, it does **not** merge and opens an issue assigned to the owner with a ready-to-paste Claude Code prompt.
3. **Release**: after the merge, the package is published to the **staging** store, from exactly the build the checks tested. Production stays a manual click in editstore.

Pushing a fix to \`${BOT_BRANCH}\` is fine: the bot keeps your commits (a fix that touches \`.github/\`, \`scripts/\` or \`hold\` is left for the owner to merge). **Closing this PR without merging skips nearcore ${target}**: the bot waits for a newer release (reopen the PR to undo). To pause the bot, set the repository variable \`PIPELINE_MODE\` to \`off\` (see README).
`;
}

async function main() {
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const gh = makeClient({ token });
  const meta = await gh.get(`repos/${repo}`);
  const base = meta.default_branch;
  const repoOwner = repo.split('/')[0];

  // Checked on every run, so an expired PAT_TOKEN is noticed before a release waits.
  let patOk = await patWorks();
  await reportPat(gh, patOk || !pat);
  const writeToken = () => (patOk ? pat : token);

  fetchBranch(root, token, base);
  const pkg = packageAt(root, `origin/${base}`);
  const mainNear = pkg.nearcore;
  if (pkg.upstream !== mainNear) warning(`${MANIFEST} says upstream ${pkg.upstream} but ${DOCKERFILE} builds nearcore ${mainNear}; the Dockerfile counts`);
  const hold = holdReason(root, `origin/${base}`);

  // --- the newest nearcore mainnet release -------------------------------------------
  let target;
  let release = null;
  let rels = [];
  if (pretend) {
    target = bare(pretend);
    compareVersions(target, '0.0.0');
    notice(`TEST: pretending nearcore ${target} is the newest mainnet release (input "version")`);
  } else {
    rels = await gh.get(`repos/${UPSTREAM_REPO}/releases?per_page=60`);
    const mainnet = mainnetReleases(rels);
    if (!mainnet.length) throw new Error(`no nearcore mainnet release in the API answer of ${UPSTREAM_REPO}; refusing to guess`);
    release = mainnet[0];
    target = bare(release.tag_name);
  }
  const list = coveredReleases(rels, mainNear, target);
  const sum = summarize(list);
  say(`nearcore on ${base}: ${mainNear} (${pkg.name} ${pkg.version}). Newest nearcore mainnet release: ${target}${pretend ? ' (pretend)' : ''}.`);
  for (const c of list) say(`- nearcore ${c.tag}: ${c.header || `no readable header (${c.headerWhy})`}${c.mandatory ? ` -> REQUIRED (${c.reasons.join(', ')})` : ''}`);

  const openPrs = await gh.get(`repos/${repo}/pulls?state=open&head=${repoOwner}:${encodeURIComponent(BOT_BRANCH)}`);
  let pr = (openPrs || [])[0] || null;
  let prNear = null;
  if (pr) {
    fetchBranch(root, token, BOT_BRANCH);
    prNear = readNearcore(git(root, ['show', `origin/${BOT_BRANCH}:${DOCKERFILE}`])).version;
  }

  if (compareVersions(target, mainNear) <= 0) {
    say(`Nothing to do: ${base} already has nearcore ${mainNear}.`);
    if (pr && compareVersions(prNear, mainNear) <= 0) {
      say(`Closing PR #${pr.number}: it offers nearcore ${prNear}, ${base} already has ${mainNear}.`);
      if (!dryRun) {
        const ghw = makeClient({ token: writeToken() });
        await ghw.post(`repos/${repo}/issues/${pr.number}/comments`, { body: `Closed by the bump bot: \`${base}\` already has nearcore ${mainNear}.` });
        await ghw.patch(`repos/${repo}/pulls/${pr.number}`, { state: 'closed' });
        try { await ghw.del(`repos/${repo}/git/refs/heads/${BOT_BRANCH}`); } catch { /* already gone */ }
      }
    }
    return;
  }

  let to = null; // the new package version, set below
  const noticeData = (kind, number) => ({
    kind,
    target,
    from: mainNear,
    packageVersion: to,
    pr: number || null,
    deadline: sum.deadline,
    deadlineNote: sum.deadlineNote,
    why: sum.unknown.map((c) => `nearcore ${c.tag}: ${c.headerWhy}`).join('; ') || null,
    mandatory: sum.mandatory.map((c) => ({ tag: c.tag, reasons: c.reasons, protocol: c.protocol })),
    items: list.map((c) => ({ tag: c.tag, url: c.url, header: c.header, mandatory: c.mandatory, reasons: c.reasons })),
    oneWay: oneWayNote(sum.oneWay, { fromNearcore: mainNear, fromPackage: pkg.version }) || null,
  });

  if (hold) {
    say(`NEAR is HELD (${hold}): no bump. Remove the file \`hold\` in a pull request to end the hold.`);
    if (sum.mandatory.length && !dryRun && !pretend) {
      const issue = await upsertNotice(gh, repo, noticeData('mandatory', null), { phase: 'held', repo, mode, owner, holdReason: hold });
      say(`nearcore ${target} is REQUIRED (deadline ${deadlineText(sum.deadline)}) but NEAR is held: issue ${issue.html_url}`);
    }
    return;
  }

  // A version whose PR the owner closed without merging is skipped.
  if (!pr && !pretend) {
    const closed = await gh.get(`repos/${repo}/pulls?state=closed&head=${repoOwner}:${encodeURIComponent(BOT_BRANCH)}&per_page=50`);
    const skippedBy = (closed || []).find((p) => !p.merged_at && markerTarget(p.body) === target);
    if (skippedBy) {
      say(`nearcore ${target} was skipped by the owner (PR #${skippedBy.number} was closed without merging); waiting for a newer nearcore release. Reopen PR #${skippedBy.number} to undo.`);
      return;
    }
  }

  // The upstream image must exist before anything is built from it; its digest is pinned.
  let digest = null;
  const tagUrl = `https://hub.docker.com/v2/repositories/${UPSTREAM_IMAGE}/tags/${encodeURIComponent(target)}`;
  const tag = await gh.http.json(tagUrl, { allow404: true });
  if (tag?.digest) {
    digest = tag.digest;
  } else if (pretend) {
    digest = ZERO_DIGEST;
    notice(`TEST: ${UPSTREAM_IMAGE}:${target} is not on Docker Hub; the PR pins a digest that does not exist, so the checks fail (that exercises the issue path)`);
  } else {
    const ageH = release?.published_at ? hoursBetween(release.published_at, new Date()) : 0;
    if (ageH > IMAGE_WAIT_HOURS) {
      throw new Error(`nearcore ${target} was released on GitHub ${fmtUtc(release.published_at)} (${Math.floor(ageH)} h ago), but ${UPSTREAM_IMAGE}:${target} is still not on Docker Hub (${tagUrl} answers ${tag ? 'without a digest' : '404'}). Check whether NEAR moved the image, renamed the tag or skipped the push; the bump bot waits until the image exists.${sum.mandatory.length ? ` This release is REQUIRED (deadline ${deadlineText(sum.deadline)}).` : ''}`);
    }
    say(`Waiting: nearcore ${target} is released on GitHub but the image ${UPSTREAM_IMAGE}:${target} is not on Docker Hub yet. The next run tries again (the owner is told after ${IMAGE_WAIT_HOURS} h).`);
    if (sum.mandatory.length && !dryRun && !pr) {
      // A required release is announced at once, image or not.
      const issue = await upsertNotice(gh, repo, noticeData('mandatory', null), { phase: 'image', repo, mode, owner });
      say(`nearcore ${target} is REQUIRED (deadline ${deadlineText(sum.deadline)}): issue ${issue.html_url}`);
    }
    return;
  }

  // --- the new package version ---------------------------------------------------------
  let prod = null;
  try {
    prod = await readProduction({ http: gh.http, name: pkg.name });
  } catch (err) {
    warning(`production store unreadable (${err.message}); the version is based on git history only`);
  }
  const released = releasedVersions(root, pkg.name, `origin/${base}`);
  const highest = maxVersion([pkg.version, ...released, prod?.version].filter(Boolean));
  to = bumpPatch(highest);

  // --- the commit -------------------------------------------------------------------
  let humanCommits = [];
  let upToDate = false;
  if (pr) {
    const commits = await gh.get(`repos/${repo}/pulls/${pr.number}/commits?per_page=100`);
    humanCommits = (commits || []).filter((c) => !isBotCommit(c));
    upToDate = (() => { try { git(root, ['merge-base', '--is-ancestor', `origin/${base}`, `origin/${BOT_BRANCH}`]); return true; } catch { return false; } })();
    const prVersion = JSON.parse(git(root, ['show', `origin/${BOT_BRANCH}:${MANIFEST}`])).version;
    if (prNear === target && upToDate && compareVersions(prVersion, to) >= 0) {
      say(`PR #${pr.number} already offers nearcore ${target} on top of the current ${base}; nothing to push.`);
      if (!dryRun && !pretend) await notices(gh, pr.number, noticeData);
      return;
    }
  }

  const edit = () => {
    const dockerfile = join(root, DOCKERFILE);
    writeFileSync(dockerfile, setNearcore(readFileSync(dockerfile, 'utf8'), target, digest));
    const mpath = join(root, MANIFEST);
    const cur = JSON.parse(readFileSync(mpath, 'utf8')).version;
    if (compareVersions(cur, to) >= 0) to = cur; // an owner commit on the branch already set a higher version
    writeFileSync(mpath, setManifestFields(readFileSync(mpath, 'utf8'), { version: to, upstream: target }));
    const cpath = join(root, COMPOSE);
    writeFileSync(cpath, setComposeImage(readFileSync(cpath, 'utf8'), pkg.name, to));
  };
  const author = ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`];

  // What the branch looks like on GitHub now: the push only overwrites exactly that.
  const lease = remoteSha(root, token, BOT_BRANCH);
  if (!pr || humanCommits.length === 0) {
    git(root, ['checkout', '-q', '-B', BOT_BRANCH, `origin/${base}`]);
    edit();
  } else {
    git(root, ['checkout', '-q', '-B', BOT_BRANCH, `origin/${BOT_BRANCH}`]);
    if (!upToDate) {
      try {
        git(root, [...author, 'merge', '--no-edit', '-m', `Merge ${base} into ${BOT_BRANCH}`, `origin/${base}`]);
      } catch (err) {
        git(root, ['merge', '--abort']);
        throw new Error(`PR #${pr.number} has commits by people and conflicts with ${base}; resolve the conflict on ${BOT_BRANCH} by hand (${err.message.split('\n')[0]})`);
      }
    }
    edit();
  }
  const message = [
    `Bump nearcore to ${target}`,
    '',
    `${pkg.name} ${pkg.version} -> ${to}`,
    `${UPSTREAM_IMAGE}:${target}@${digest}`,
    ...(sum.mandatory.length ? ['', `REQUIRED: ${sum.mandatory.map((c) => `${c.tag} (${c.reasons.join(', ')})`).join('; ')}; deadline ${deadlineText(sum.deadline)}`] : []),
    ...(sum.oneWay.length ? ['', `One-way step (protocol or database upgrade): ${sum.oneWay.map((c) => c.tag).join(', ')}`] : []),
    ...(pretend ? ['', 'TEST ONLY: pretend version (bump.yml input), not a real nearcore release.'] : []),
  ].join('\n');
  git(root, ['add', DOCKERFILE, MANIFEST, COMPOSE]);
  const staged = git(root, ['diff', '--cached', '--name-only']);
  if (staged) git(root, [...author, 'commit', '-q', '-m', message]);
  say(`Branch ${BOT_BRANCH}: ${git(root, ['log', '--oneline', '-1'])}${!pr || humanCommits.length === 0 ? ` (recreated on the current ${base})` : ''}`);
  say(`- ${pkg.name} ${pkg.version} -> ${to}${prod?.version ? ` (production ${prod.version}, nearcore ${prod.upstream})` : ''}`);
  say(`- base image ${UPSTREAM_IMAGE}:${target}@${digest}`);
  if (sum.mandatory.length) say(`- REQUIRED upgrade: deadline ${deadlineText(sum.deadline)}${sum.deadlineNote ? ` (${sum.deadlineNote})` : ''}`);
  if (sum.oneWay.length) say(`- one-way database/protocol step: ${sum.oneWay.map((c) => c.tag).join(', ')}`);

  const title = `nearcore ${target} for NEAR (${to})${sum.mandatory.length ? ' [REQUIRED]' : ''}${pretend ? ' [TEST]' : ''}`;
  const body = () => renderBody({
    target,
    from: mainNear,
    release,
    pkg,
    to,
    sum,
    list,
    marker: bumpMarker(pretend ? null : target),
    pretendNote: pretend ? `\n> **TEST ONLY.** nearcore ${target} was given by hand (bump.yml input "version"); it is not a real release. Close this PR when the test is done.\n` : '',
    checksNote: patOk ? '' : ' (Started by the bump bot through workflow_dispatch, because PAT_TOKEN is not set or was rejected.)',
  });

  if (dryRun) {
    say(`DRY RUN: would push ${BOT_BRANCH} and ${pr ? `update PR #${pr.number}` : 'open a PR'}: ${title}`);
    if (sum.mandatory.length) say(`DRY RUN: would open or update the "[required] nearcore ${target}" issue for ${owner}`);
    return;
  }

  // The gate may have merged or closed the PR while this run worked: start over next time.
  if (pr) {
    const now = await gh.get(`repos/${repo}/pulls/${pr.number}`);
    if (now.state !== 'open') {
      say(`PR #${pr.number} was ${now.merged_at ? 'merged' : 'closed'} while this run worked; nothing pushed. The next run starts over.`);
      return;
    }
  }

  try {
    pushHead(root, writeToken(), BOT_BRANCH, { lease });
  } catch (err) {
    if (!patOk) throw new Error(`could not push ${BOT_BRANCH} (${String(err.message).split('\n')[0]}); if the branch changed during this run, the next run tries again`);
    warning(`push with PAT_TOKEN failed (${String(err.message).split('\n')[0]}); trying the built-in token`);
    patOk = false;
    await reportPat(gh, false);
    pushHead(root, token, BOT_BRANCH, { lease });
  }

  const ghw = makeClient({ token: writeToken() });
  let number;
  if (pr) {
    await ghw.patch(`repos/${repo}/pulls/${pr.number}`, { title, body: body() });
    number = pr.number;
    say(`Updated PR #${number}.`);
  } else {
    const created = await ghw.post(`repos/${repo}/pulls`, { title, head: BOT_BRANCH, base, body: body(), maintainer_can_modify: true });
    number = created.number;
    say(`Opened PR #${number}: ${created.html_url}`);
  }
  try { await ghw.post(`repos/${repo}/issues/${number}/labels`, { labels: ['avado-bot'] }); } catch { /* labels are optional */ }

  if (!patOk) {
    // GITHUB_TOKEN pushes do not start workflows, but a workflow_dispatch does.
    await gh.post(`repos/${repo}/actions/workflows/pr-checks.yml/dispatches`, { ref: base, inputs: { pr: String(number) } });
    say(`Started the PR checks for #${number} through workflow_dispatch (PAT_TOKEN ${pat ? 'was rejected' : 'is not set'}).`);
  }

  // The owner's emails: a required release at once, with its deadline; an
  // unreadable header once. (Not for a TEST version.)
  if (!pretend) await notices(gh, number, noticeData);
}

async function notices(gh, number, noticeData) {
  const d = noticeData('mandatory', number);
  if (d.mandatory.length) {
    const issue = await upsertNotice(gh, repo, d, { phase: 'pr', repo, mode, owner, pr: number });
    say(`- REQUIRED release: issue ${issue.html_url}`);
  }
  if (d.why) {
    const issue = await upsertNotice(gh, repo, noticeData('header', number), { phase: 'pr', repo, mode, owner, pr: number });
    say(`- release header not readable: issue ${issue.html_url}`);
  }
}

main()
  .catch((err) => {
    console.log(`::error::${err.message}`);
    summaryLines.push(`**Bump failed:** ${err.message}`);
    recordFailure(err.message);
    process.exitCode = 1;
  })
  .finally(writeSummary);
