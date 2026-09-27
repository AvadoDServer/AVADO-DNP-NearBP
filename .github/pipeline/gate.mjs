#!/usr/bin/env node
// Gate (gate.yml, every 4 hours and whenever the PR checks finish): decides
// whether the bump bot's PR may be merged, and merges it; and makes sure every
// version on the default branch gets its release run. Adapted from the Teku
// pilot; NEAR has no DAppNode package, so our own checks are the only test.
//
// Merge (a merge commit, never squash) only when our checks ("avado/checks",
// set by this repo's PR-checks workflow) are green on the PR head, the branch
// contains the current default branch, no person changed the checks or the
// pipeline on the branch, the package is not held, the target is a published
// nearcore MAINNET release, and
//   - the release is REQUIRED (its header says CODE_RED_MAINNET,
//     PROTOCOL_UPGRADE: TRUE or SECURITY_UPGRADE: TRUE, for the target or a
//     release it covers): at once, no waiting; or
//   - any other release: 72 hours after nearcore published the target.
// Never merge when our checks failed or anything is unclear: then an issue
// assigned to the owner explains it and carries a ready-to-paste Claude Code
// prompt. A check that failed only on something outside our package (the
// AVADOSDK build, the boot or upgrade test on the public network, a runner
// step) is run once more first (GitHub "re-run failed jobs"), without an email.
// The "[required]" issues (lib/near.js) are moved along on every run: merged,
// on staging (promote it), closed once production has it.
//
// Environment:
//   GITHUB_REPOSITORY, GITHUB_TOKEN   this repo (contents, pull requests, issues,
//                                      statuses write; actions write to re-run the
//                                      checks and start release.yml)
//   PIPELINE_MODE                      shadow (default, also when not set: decide
//                                      and comment, never merge) | on (merge) | off
//   PIPELINE_OWNER                     who gets the issues (default flisko)
//   GATE_WAIT_HOURS                    default 72
//   GITHUB_SERVER_URL, GITHUB_RUN_ID   for links to this run
// Run in a checkout of the default branch with full history (fetch-depth: 0).

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeClient } from './lib/gh.js';
import { upsertIssue, closeIssue, findIssue, listOpenIssues } from './lib/issue.js';
import { releaseKind, covered as coveredReleases, summarize, deadlineText, oneWayNote, syncNotices } from './lib/near.js';
import {
  BOT_EMAIL, BOT_BRANCH, UPSTREAM_REPO, PR_CHECKS_PATH, DOCKERFILE, bare, stableReleases, readNearcore, packageAt, holdReason,
  releasedVersions, readProduction, git, fetchBranch, retry, isTransient, env, hoursBetween, fmtUtc, recordFailure,
} from './lib/common.js';

export const CHECKS_CONTEXT = 'avado/checks';
export const GATE_CONTEXT = 'avado/gate';
const GATE_COMMENT = '<!-- avado-bot:gate -->';
export const ALLOWED_BOT_FILES = /^(build\/Dockerfile|dappnode_package\.json|docker-compose\.yml)$/;
// Files a person may change on the bot branch and still let the gate merge:
// the build (build/: config, entrypoint, Dockerfile), the manifest and the
// compose file. Anything else (the checks, the pipeline, the hold, a release
// record) is merged only by the owner, after reading it.
export const OWNER_MERGE_FILES = /^(\.github\/|scripts\/|hold$|releases\.json$)/;
// Steps whose failure is usually outside our package (public network, IPFS
// node, production store, Docker Hub, the runner): they are re-run once.
export const RETRYABLE_STEPS = /^(AVADOSDK build|Boots on NEAR mainnet|Upgrades a box in place|Production image|Download the tested image|Throwaway IPFS node|nearcore image digest|Free disk space|Set up job|Run actions\/|Post Run actions\/|Complete job)/;

// The rules, as a pure function (tested in test/pipeline.test.mjs).
//   checks: 'success' | 'failure' | 'error' | 'pending' | 'missing'
//   release: { publishedAt, mainnet, why } of the target, or null when nearcore has no such release
//   mandatory: set when the target or a release it covers is required
//   rerun: a re-run of checks that failed on an outside cause was just started
//   held: the hold reason when the default branch holds the package
export function decide({ checks, release, mandatory, now, upToDate, conflict, errors = [], unexpectedFiles = [], ownerFiles = [], rerun = null, waitHours = 72, headAt = null, silentHours = 6, held = null }) {
  if (errors.length) return { action: 'block', cause: 'unclear', why: `could not read everything needed: ${errors.join('; ')}` };
  if (held) return { action: 'wait', cause: 'held', why: `NEAR is held by the owner (${held}); nothing is merged until the hold file is removed` };
  if (unexpectedFiles.length) return { action: 'block', cause: 'unexpected-files', why: `bot commits change files a bump never touches: ${unexpectedFiles.join(', ')}` };
  if (ownerFiles.length) return { action: 'block', cause: 'owner-merge', why: `a person changed files the gate never merges by itself (${ownerFiles.slice(0, 5).join(', ')}${ownerFiles.length > 5 ? ', ...' : ''}); the owner reviews and merges this PR` };
  if (conflict) return { action: 'block', cause: 'conflict', why: 'the PR conflicts with the default branch' };
  if (rerun) return { action: 'wait', cause: 'rerun', why: `our checks failed on something outside our package (${rerun}); they are being run once more` };
  if (checks === 'failure' || checks === 'error') return { action: 'block', cause: 'checks-failed', why: 'our checks failed' };
  if (!release?.publishedAt) return { action: 'block', cause: 'unclear', why: 'there is no published nearcore release for this version' };
  if (!release.mainnet) return { action: 'block', cause: 'unclear', why: `this nearcore version is not a mainnet release (${release.why})` };
  if (checks !== 'success') {
    // Checks that never report must not make the gate wait silently forever.
    const waited = headAt ? hoursBetween(headAt, now) : 0;
    if (waited >= silentHours) return { action: 'block', cause: 'unclear', why: `our checks have not reported a result ${Math.floor(waited)} h after the last push (status: ${checks})` };
    return { action: 'wait', cause: 'checks', why: checks === 'missing' ? 'our checks have not started yet' : 'our checks are running' };
  }
  if (!upToDate) return { action: 'wait', cause: 'behind', why: 'the branch is behind the default branch; the bump bot refreshes it' };
  if (mandatory) return { action: 'merge', cause: 'mandatory', why: `our checks are green and nearcore marks this release as required (${mandatory.source}): merged at once` };
  const age = hoursBetween(release.publishedAt, now);
  if (age >= waitHours) return { action: 'merge', cause: 'waited', why: `our checks are green and ${Math.floor(age)} h passed since the nearcore release (normal releases wait ${waitHours} h)` };
  const at = new Date(new Date(release.publishedAt).getTime() + waitHours * 3600000);
  return { action: 'wait', cause: 'upstream-age', why: `our checks are green; a normal release waits ${waitHours} h after nearcore published it: merges after ${fmtUtc(at)}`, mergeAt: at.toISOString() };
}

// Which files make the PR the owner's to merge (people's commits only).
export function ownerMergeFiles(files, botOnly) {
  return botOnly ? [] : files.filter((f) => OWNER_MERGE_FILES.test(f));
}

// Did every failed job of a checks run fail only on outside steps? (A job lost
// without a failed step, for example a runner that went away, counts as outside.)
export function retryable(jobs) {
  return jobs.length > 0 && jobs.every((j) => {
    const steps = j.steps || (j.step ? [j.step] : []);
    return steps.every((s) => RETRYABLE_STEPS.test(s));
  });
}

// --- reading --------------------------------------------------------------------

// The "avado/checks" status on the PR head, accepted only from this repo's
// PR-checks workflow (a run in this repo, not a fork, for this commit).
async function checksState(gh, repo, sha) {
  const statuses = await gh.paginate(`repos/${repo}/commits/${sha}/statuses`, { maxPages: 3 });
  const mine = statuses.filter((s) => s.context === CHECKS_CONTEXT && s.creator?.login === 'github-actions[bot]');
  const latest = mine.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
  if (!latest) return { state: 'missing' };
  const runId = /\/actions\/runs\/(\d+)/.exec(latest.target_url || '')?.[1];
  if (!runId) return { state: 'missing', note: 'the status does not link a PR-checks run' };
  let run;
  try {
    run = await gh.get(`repos/${repo}/actions/runs/${runId}`);
  } catch (err) {
    return { state: 'missing', note: `the linked run ${runId} could not be read (${err.message.slice(0, 80)})` };
  }
  if (run.path !== PR_CHECKS_PATH || !run.head_repository || run.head_repository.id !== run.repository?.id) {
    return { state: 'missing', note: `the status comes from ${run.path || 'an unknown workflow'}${run.head_repository?.id !== run.repository?.id ? ' in a fork' : ''}, not from this repo's PR checks` };
  }
  if (run.event === 'pull_request' && run.head_sha !== sha) return { state: 'missing', note: `the linked run checked ${run.head_sha.slice(0, 7)}` };
  let state = latest.state;
  // A run that is running again (a re-run) counts as running, whatever it said before.
  if (run.status !== 'completed') state = 'pending';
  return { state, url: latest.target_url, description: latest.description, runId, run };
}

// The useful part of a failed job's log: the lines that say what failed, and
// the last lines before the first error (setup and cleanup noise dropped).
export function logExcerpt(log) {
  const lines = String(log || '')
    .split('\n')
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, ''));
  const firstError = lines.findIndex((l) => l.startsWith('##[error]'));
  // Only the failing step: from its "##[group]Run ..." line to the first error
  // (the earlier steps' output, such as the unit tests, is not the problem).
  let from = 0;
  if (firstError !== -1) {
    for (let i = firstError; i >= 0; i--) if (lines[i].startsWith('##[group]Run ')) { from = i; break; }
  }
  const upto = firstError === -1 ? lines : lines.slice(from, firstError + 1);
  const noise = /^(##\[(group|endgroup)\]|shell: |env:$|\s+[A-Z_]+: |\[command\]|Post job cleanup|Cleaning up orphan)/;
  const useful = upto.filter((l) => l.trim() && !noise.test(l));
  const key = useful.filter((l) => /(^|\s)FAIL\b|FAIL:|MISSING|UNKNOWN|^##\[error\]|^-{5} |^ {4}[-+]|\bError: |rc=[1-9]/.test(l)).slice(0, 30);
  const tail = useful.slice(-25).filter((l) => !key.includes(l));
  return [...key, ...(tail.length ? ['...', ...tail] : [])].join('\n').slice(0, 6000);
}

async function failedJobs(gh, repo, runId, { logs = true } = {}) {
  if (!runId) return { runId: null, jobs: [] };
  const data = await gh.get(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
  const jobs = [];
  // "avado/checks" only sums up the others.
  for (const j of (data?.jobs || []).filter((x) => x.conclusion === 'failure' && x.name !== CHECKS_CONTEXT)) {
    const steps = (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
    const step = steps.join('", "') || null;
    let excerpt = '';
    if (logs) {
      try {
        excerpt = logExcerpt(await gh.redirectedText(`repos/${repo}/actions/jobs/${j.id}/logs`));
      } catch (err) {
        excerpt = `(log not readable: ${err.message})`;
      }
    }
    jobs.push({ name: j.name, url: j.html_url, step, steps, excerpt });
  }
  return { runId, jobs };
}

// Every version on the default branch gets a release run: if the package is not
// held and its version has no "Release ..." commit and no release run ran on
// the current head, start one (a gate merge made with GITHUB_TOKEN starts no
// push workflow, and the dispatch after it may have failed).
async function reconcileRelease(gh, repo, base, root, main, say) {
  const ref = `origin/${base}`;
  if (main.hold || main.released) return;
  const head = git(root, ['rev-parse', ref]);
  const runs = await gh.get(`repos/${repo}/actions/workflows/release.yml/runs?per_page=30`);
  const onHead = (runs?.workflow_runs || []).find((r) => r.head_sha === head);
  if (onHead) {
    say(`- not released yet on ${base}: ${main.name} ${main.version}; release run ${onHead.html_url} (${onHead.status}${onHead.conclusion ? `, ${onHead.conclusion}` : ''}) covers it${onHead.conclusion === 'failure' ? ' (its failure issue says what to do)' : ''}`);
    return;
  }
  await retry('starting release.yml', () => gh.post(`repos/${repo}/actions/workflows/release.yml/dispatches`, { ref: base }));
  say(`- not released yet on ${base}: ${main.name} ${main.version}, and no release run ran on ${head.slice(0, 7)}: started release.yml`);
}

// --- the issue text ------------------------------------------------------------------

function issueText({ repo, pr, target, mainNear, decision, checks, failed, runUrl, summary, now }) {
  const server = env('GITHUB_SERVER_URL', 'https://github.com');
  const prUrl = `${server}/${repo}/pull/${pr.number}`;
  const required = summary?.mandatory?.length
    ? `nearcore ${summary.mandatory.map((c) => c.tag).join(', ')} is REQUIRED (${summary.mandatory.map((c) => c.reasons.join(', ')).join('; ')}); deadline ${deadlineText(summary.deadline, now)}`
    : null;
  const headline = {
    'checks-failed': 'our checks failed',
    'owner-merge': 'a person changed the checks or the pipeline on the PR: please review and merge',
    conflict: 'the PR conflicts with main',
    'unexpected-files': 'the bump PR changes unexpected files',
    unclear: 'the gate could not decide',
  }[decision.cause] || decision.why;
  const title = `[needs fix] nearcore ${target}${required ? ' (REQUIRED)' : ''}: ${headline}`;

  const facts = [
    `- Pull request: ${prUrl} (branch \`${BOT_BRANCH}\`, nearcore ${mainNear} → ${target})`,
    `- Our checks: **${checks.state}**${checks.url ? ` ([run](${checks.url}))` : ''}${checks.note ? ` (${checks.note})` : ''}`,
    `- Gate run: ${runUrl}`,
  ];
  if (required) facts.push(`- ${required}`);

  const rules = `Rules:
- Never change the package name, the volume data:/root/.near, port 24567 or the environment variable names in dappnode_package.json, and keep the version and upstream the bot set there.
- Never let the entrypoint delete, move or regenerate validator_key.json or node_key.json, and never wipe /root/.near/data.
- Keep neard's settings the same except for what nearcore ${target} requires (for example a removed or renamed key in build/files/config.json; compare with the config \`neard init\` writes: docker run --rm --entrypoint sh nearprotocol/nearcore:${target} -c 'neard --home /tmp/h init --chain-id mainnet >/dev/null 2>&1; cat /tmp/h/config.json').
- Do not edit .github/**, scripts/** or the hold file. If the fix really needs that, make the change in a separate commit, say so clearly, and tell me that I must review and merge the PR myself: the gate never merges such a PR by itself.
- Before pushing, run the checks that failed locally (README.md, section "Checks"), for example scripts/ci/check-config.sh on the image you built.
- Commit with a clear message and push to ${BOT_BRANCH}. Do not merge the PR yourself: the checks run again and the gate merges when they are green.`;

  let what = '';
  let prompt = '';
  if (decision.cause === 'checks-failed') {
    const jobs = failed.jobs.length
      ? failed.jobs.map((j) => `### ${j.name}${j.step ? ` (step "${j.step}")` : ''}\n${j.url}\n\n\`\`\`text\n${j.excerpt}\n\`\`\``).join('\n\n')
      : '(the failed jobs could not be listed; open the run link)';
    what = `The automatic update to nearcore ${target} stopped because our checks failed. The gate already ran the failed checks once more if they looked like an outside problem. Nothing was merged or released; boxes are not affected.${required ? `\n\n**${required}.** Fix it quickly, or ship it by hand.` : ''}\n\n${jobs}`;
    prompt = `In the AVADO-DNP-NearBP repository (${repo}), pull request #${pr.number} on branch ${BOT_BRANCH} moves NEAR from nearcore ${mainNear} to nearcore ${target}.${required ? ` ${required}.` : ''} Its checks failed:
${failed.jobs.map((j) => `- ${j.name}${j.step ? `, step "${j.step}"` : ''}: ${j.url}`).join('\n') || `- see ${checks.url}`}
Download the logs with: gh run download ${failed.runId || '<run id>'} -R ${repo}
First decide whether the cause is outside our package: NEAR peers that did not answer the epoch sync request in time, too few peers on a GitHub runner, AVADO's IPFS node, bo.ava.do, Docker Hub or the runner itself. If so, do not change any files: run \`gh run rerun ${failed.runId || '<run id>'} -R ${repo} --failed\` and tell me.
Otherwise find why the check fails with nearcore ${target} (read the release notes of nearcore ${target} and every release since ${mainNear}: https://github.com/${UPSTREAM_REPO}/releases) and fix it on this branch.
${rules}`;
  } else if (decision.cause === 'owner-merge') {
    what = `Someone pushed commits to the bot's PR that change files the gate never merges by itself: the checks, the pipeline, the hold or a release record. Such a change can weaken the checks for every later release, so a person must read it. Nothing was merged or released; boxes are not affected.

**What to do:** open ${prUrl}, read the changes to those files, and if they are right, merge it yourself with **"Create a merge commit"** (the release then publishes it to staging as usual). If not, remove those commits from the branch.`;
    prompt = `In ${repo}, pull request #${pr.number} (branch ${BOT_BRANCH}, nearcore ${mainNear} → ${target}) has commits by people that change: ${decision.why}.
Show me those changes (gh pr diff ${pr.number} -R ${repo}) and explain in plain words what each one does and whether it weakens a check or changes what boxes run. Do not change any files and do not merge.`;
  } else if (decision.cause === 'conflict') {
    what = 'The PR cannot be merged because it conflicts with the default branch, and it has commits by people, so the bot does not rebuild it.';
    prompt = `In ${repo}, pull request #${pr.number} (branch ${BOT_BRANCH}) conflicts with main. Check it out (gh pr checkout ${pr.number} -R ${repo}), merge main into it, resolve the conflicts keeping nearcore ${target}, its image digest in build/Dockerfile and the bot's package version, and push.
${rules}`;
  } else {
    what = `The gate stopped: ${decision.why}. Nothing was merged or released; boxes are not affected.`;
    prompt = `In ${repo}, the release gate stopped on pull request #${pr.number} (nearcore ${mainNear} → ${target}) with: "${decision.why}". Gate run: ${runUrl}. Find out why and tell me what to do; change files only on branch ${BOT_BRANCH}.
${rules}`;
  }

  const body = `**What happened:** ${decision.why}.

${what}

**How to fix it with Claude Code** (on your Mac):
\`\`\`bash
gh pr checkout ${pr.number} -R ${repo}
claude    # then paste the prompt below
\`\`\`

<details open><summary>Prompt for Claude Code</summary>

\`\`\`text
${prompt}
\`\`\`
</details>

**Facts**
${facts.join('\n')}

This issue updates itself on every gate run (every 4 hours and after each check run) and closes by itself when the cause is gone.`;
  return { title, body };
}

// --- main --------------------------------------------------------------------------------

async function main() {
  const repo = env('GITHUB_REPOSITORY');
  const token = env('GITHUB_TOKEN');
  const mode = env('PIPELINE_MODE', 'shadow');
  const owner = env('PIPELINE_OWNER', 'flisko');
  const waitHours = Number(env('GATE_WAIT_HOURS', '72'));
  const runUrl = `${env('GITHUB_SERVER_URL', 'https://github.com')}/${repo}/actions/runs/${env('GITHUB_RUN_ID', '0')}`;
  const now = new Date(env('GATE_NOW', new Date().toISOString()));
  const root = process.cwd();
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  if (mode === 'off') return console.log('PIPELINE_MODE is off: nothing to do.');
  const merging = mode === 'on';
  const gh = makeClient({ token });
  const out = [];
  const say = (s) => { console.log(s); out.push(s); };
  if (!merging) say(`PIPELINE_MODE is ${env('PIPELINE_MODE') ? `"${mode}"` : 'not set'}: shadow mode, the gate decides and comments but never merges (set it to "on" to merge).`);

  const meta = await gh.get(`repos/${repo}`);
  const base = meta.default_branch;
  fetchBranch(root, token, base);
  const ref = `origin/${base}`;
  const pkg = packageAt(root, ref);
  const main = { ...pkg, hold: holdReason(root, ref), released: releasedVersions(root, pkg.name, ref).includes(pkg.version) };
  await reconcileRelease(gh, repo, base, root, main, say);
  let prod = null;
  try { prod = await readProduction({ http: gh.http, name: pkg.name }); } catch (err) { console.log(`::warning::production store unreadable (${err.message}); the "[required]" issues are not closed on this run`); }

  const prs = await gh.get(`repos/${repo}/pulls?state=open&head=${repo.split('/')[0]}:${encodeURIComponent(BOT_BRANCH)}`);
  const pr = (prs || [])[0];

  // Issues of PRs that are gone close themselves.
  for (const i of await listOpenIssues(gh, repo)) {
    const n = /^pr-(\d+)$/.exec(i.key || '')?.[1];
    if (n && (!pr || Number(n) !== pr.number)) {
      const old = await gh.get(`repos/${repo}/pulls/${n}`);
      if (old.state !== 'open') await closeIssue(gh, repo, i, `Closed: PR #${n} is ${old.merged_at ? 'merged' : 'closed'}.`);
    }
  }
  if (!pr) {
    await syncNotices({ gh, repo, owner, mode, main, pr: null, prodUpstream: prod?.upstream || null, now, say });
    say('No open bump PR: nothing to gate.');
    return finish(out);
  }

  const full = await gh.get(`repos/${repo}/pulls/${pr.number}`);
  const sha = full.head.sha;
  const errors = [];
  const safe = async (what, fn) => { try { return await fn(); } catch (err) { errors.push(`${what}: ${err.message}`); return null; } };

  let target = '?';
  try {
    target = readNearcore(await gh.file(repo, DOCKERFILE, sha)).version;
  } catch (err) {
    errors.push(`${DOCKERFILE} on the PR: ${err.message}`);
  }
  const mainNear = pkg.nearcore;
  const checks = await checksState(gh, repo, sha);
  const cmp = await gh.get(`repos/${repo}/compare/${encodeURIComponent(base)}...${sha}`);
  const upToDate = cmp.behind_by === 0;
  const conflict = full.mergeable === false && full.mergeable_state === 'dirty';

  // Bot-only PRs may change only the bump's files; people's commits may not
  // change the checks or the pipeline without the owner's own merge.
  const commits = await gh.get(`repos/${repo}/pulls/${pr.number}/commits?per_page=100`);
  const botOnly = (commits || []).every((c) => c.commit?.author?.email === BOT_EMAIL);
  const headAt = (commits || []).at(-1)?.commit?.committer?.date || null;
  const files = ((await gh.paginate(`repos/${repo}/pulls/${pr.number}/files`, { maxPages: 30 })) || []).map((f) => f.filename);
  const unexpectedFiles = botOnly ? files.filter((f) => !ALLOWED_BOT_FILES.test(f)) : [];
  const ownerFiles = ownerMergeFiles(files, botOnly);

  // Upstream: the target's release and every mainnet release between main and it.
  const rels = await safe('nearcore releases', () => gh.get(`repos/${UPSTREAM_REPO}/releases?per_page=60`));
  const stable = stableReleases(rels || []);
  const rel = stable.find((r) => bare(r.tag_name) === target) || null;
  const kind = rel ? releaseKind(rel) : null;
  const release = rel ? { publishedAt: rel.published_at, mainnet: kind.mainnet, why: kind.why } : null;
  const list = rels && target !== '?' ? coveredReleases(rels, mainNear, target) : [];
  const summary = summarize(list);
  const mandatory = summary.mandatory.length
    ? { source: summary.mandatory.map((c) => `nearcore ${c.tag}: ${c.reasons.join(', ')}`).join('; '), deadline: summary.deadline }
    : null;

  // Checks that failed only on outside steps run once more (first attempt only).
  let rerun = null;
  if ((checks.state === 'failure' || checks.state === 'error') && checks.run) {
    const steps = await failedJobs(gh, repo, checks.runId, { logs: false });
    if (checks.run.run_attempt === 1 && retryable(steps.jobs)) {
      try {
        await gh.post(`repos/${repo}/actions/runs/${checks.runId}/rerun-failed-jobs`, {});
        rerun = steps.jobs.map((j) => `${j.name}: ${j.steps.join(', ') || 'no step'}`).join('; ');
      } catch (err) {
        console.log(`::warning::could not re-run the failed checks (${err.message})`);
      }
    }
  }

  const decision = decide({
    checks: checks.state, release, mandatory, now, upToDate, conflict, errors, unexpectedFiles, ownerFiles, rerun, waitHours, headAt, held: main.hold,
  });

  const requiredText = mandatory ? `yes: ${mandatory.source}; deadline ${deadlineText(summary.deadline, now)}` : 'no';
  const oneWay = oneWayNote(summary.oneWay, { fromNearcore: mainNear, fromPackage: pkg.version });
  say(`PR #${pr.number} (${sha.slice(0, 7)}): nearcore ${mainNear} -> ${target}`);
  say(`- our checks: ${checks.state}${checks.url ? ` (${checks.url})` : ''}${checks.note ? ` (${checks.note})` : ''}`);
  say(`- nearcore ${target} released: ${release ? `${fmtUtc(release.publishedAt)}${release.mainnet ? '' : ` (NOT a mainnet release: ${release.why})`}` : 'no such release'}`);
  say(`- required upgrade: ${requiredText}`);
  if (summary.unknown.length) say(`- release header not readable: ${summary.unknown.map((c) => c.tag).join(', ')} (treated as normal releases)`);
  if (summary.oneWay.length) say(`- one-way step: ${summary.oneWay.map((c) => c.tag).join(', ')}`);
  say(`- branch contains ${base}: ${upToDate ? 'yes' : 'no'}${conflict ? ' (conflict)' : ''}`);
  if (main.hold) say(`- HELD: ${main.hold}`);
  if (ownerFiles.length) say(`- changed by people, owner merges: ${ownerFiles.join(', ')}`);
  say(`- DECISION: ${decision.action.toUpperCase()}: ${decision.why}${!merging && decision.action === 'merge' ? ' (shadow mode: not merging)' : ''}`);

  // Status on the PR head and one comment that is edited in place (no email).
  const statusState = { merge: 'success', wait: 'pending', block: 'failure' }[decision.action];
  const statusText = !merging && decision.action === 'merge' ? `shadow mode, would merge: ${decision.why}` : decision.why;
  await gh.post(`repos/${repo}/statuses/${sha}`, { state: statusState, context: GATE_CONTEXT, description: statusText.slice(0, 139), target_url: runUrl });
  const mergeRule = mandatory
    ? 'required release: as soon as our checks are green'
    : release ? `normal release: not before ${fmtUtc(new Date(release.publishedAt).getTime() + waitHours * 3600000)} (${waitHours} h after the nearcore release)` : '—';
  const table = `${GATE_COMMENT}
### Gate: ${decision.action === 'merge' ? (!merging ? 'would merge (shadow mode)' : 'merging') : decision.action === 'wait' ? 'waiting' : 'stopped'}
${decision.why}.

| | |
|---|---|
| Our checks | ${checks.state}${checks.url ? ` ([run](${checks.url}))` : ''}${checks.note ? ` (${checks.note})` : ''} |
| nearcore ${target} released | ${release ? `${fmtUtc(release.publishedAt)}${release.mainnet ? '' : ' (not a mainnet release)'}` : '—'} |
| Required upgrade | ${requiredText} |
| Merge rule | ${mergeRule} |
| One-way database step | ${summary.oneWay.length ? summary.oneWay.map((c) => c.tag).join(', ') : 'no'} |
| Up to date with ${base} | ${upToDate ? 'yes' : 'no'} |
| Mode | ${merging ? 'on (merges)' : 'shadow (never merges; set PIPELINE_MODE=on)'} |
${main.hold ? `| Hold | ${main.hold} |\n` : ''}${oneWay ? `\n${oneWay}\n` : ''}
Checked ${fmtUtc(now)} by ${runUrl}`;
  const comments = await gh.get(`repos/${repo}/issues/${pr.number}/comments?per_page=100`);
  const mine = (comments || []).find((c) => (c.body || '').startsWith(GATE_COMMENT));
  if (mine) await gh.patch(`repos/${repo}/issues/comments/${mine.id}`, { body: table });
  else await gh.post(`repos/${repo}/issues/${pr.number}/comments`, { body: table });

  const key = `pr-${pr.number}`;
  if (decision.action === 'block') {
    const failed = decision.cause === 'checks-failed' ? await failedJobs(gh, repo, checks.runId) : { runId: null, jobs: [] };
    const { title, body } = issueText({ repo, pr, target, mainNear, decision, checks, failed, runUrl, summary, now });
    const issue = await upsertIssue(gh, repo, {
      key, title, body, assignee: owner, state: `${decision.cause}@${target}@${sha.slice(0, 7)}`,
      changeNote: `New situation for nearcore ${target} (head ${sha.slice(0, 7)}): ${decision.why}. The description above is up to date.`,
    });
    say(`- issue: ${issue.html_url}`);
  } else if (decision.action === 'merge' || decision.cause === 'upstream-age' || decision.cause === 'held') {
    // Closed only when the problem is really gone: not while a fix is still
    // being checked (that would close and reopen it: two extra emails).
    const issue = await findIssue(gh, repo, key);
    if (issue?.state === 'open') {
      await closeIssue(gh, repo, issue, `Resolved: ${decision.why}.`);
      say(`- closed issue #${issue.number}`);
    }
  }

  // (Not while the PR's nearcore version cannot be read: that would close them.)
  if (target !== '?') await syncNotices({ gh, repo, owner, mode, main, pr: { number: pr.number, target }, prodUpstream: prod?.upstream || null, now, say });

  if (decision.action === 'merge' && merging) {
    let merged;
    try {
      merged = await gh.put(`repos/${repo}/pulls/${pr.number}/merge`, {
        merge_method: 'merge',
        sha,
        commit_title: `Merge pull request #${pr.number} from ${BOT_BRANCH}: nearcore ${target}`,
        commit_message: `${decision.why}.\nGate: ${runUrl}`,
      });
    } catch (err) {
      // 409: the branch moved during this run (the bump bot pushed); 405: GitHub
      // cannot merge it right now. The next run decides on the new state.
      if (err.status === 409 || err.status === 405) {
        say(`- not merged: GitHub answered HTTP ${err.status} (${String(err.message).slice(0, 160)}); the next gate run decides again`);
        return finish(out);
      }
      throw err;
    }
    say(`- merged: ${merged.sha}`);
    try { await gh.del(`repos/${repo}/git/refs/heads/${BOT_BRANCH}`); } catch { /* auto-deleted */ }
    // A merge made with GITHUB_TOKEN does not start push workflows; start the
    // release (retried; if it still fails, the next gate run starts it).
    try {
      await retry('starting release.yml', () => gh.post(`repos/${repo}/actions/workflows/release.yml/dispatches`, { ref: base }), { transient: isTransient });
      say('- started release.yml');
    } catch (err) {
      say(`- PR #${pr.number} MERGED, but release.yml could not be started (${err.message}); the next gate run starts it`);
      throw err;
    }
  }
  return finish(out);
}

function finish(lines) {
  const f = env('GITHUB_STEP_SUMMARY');
  if (f) appendFileSync(f, `${lines.join('\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error::${err.stack || err.message}`);
    recordFailure(err.message);
    process.exitCode = 1;
  });
}
