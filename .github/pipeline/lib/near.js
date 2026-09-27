// nearcore specifics: which upstream releases are mainnet releases, which are
// required (fast-tracked), their deadline, the one-way database step, and the
// owner's "[required]" and "[check]" issues (the emails).
//
// Every nearcore release starts with a fenced header, for example
//   CODE_COLOR: CODE_RED_MAINNET, CODE_RED_TESTNET
//   RELEASE_VERSION: 2.13.4
//   PROTOCOL_UPGRADE: FALSE
//   DATABASE_UPGRADE: FALSE
//   SECURITY_UPGRADE: TRUE
// - A mainnet release is a stable X.Y.Z tag (not a draft, not a pre-release,
//   not an rc) whose CODE_COLOR names a *_MAINNET color. A header that names
//   only *_TESTNET colors is never used. A stable tag without a readable
//   header is treated as a normal mainnet release, and the owner is told.
// - Required ("mandatory"): CODE_RED_MAINNET, PROTOCOL_UPGRADE: TRUE or
//   SECURITY_UPGRADE: TRUE. The gate merges it as soon as our checks are green
//   (no 72 h wait) and the owner gets an issue with the deadline at once. The
//   rule and its deadline are the release watcher's (lib/mandatory.js,
//   nearcore-header): the protocol-upgrade voting date written in the notes,
//   otherwise release + 7 days.
// - One-way step: PROTOCOL_UPGRADE or DATABASE_UPGRADE: TRUE. The PR and the
//   issue say that boxes cannot go back after running it.

import { parseNearHeader, checkMandatory } from './mandatory.js';
import { upsertIssue, closeIssue, listOpenIssues } from './issue.js';
import { STABLE_TAG, UPSTREAM_REPO, UPSTREAM_IMAGE, bare, compareVersions, stableReleases, fmtUtc, env } from './common.js';

const colorsOf = (h) => String(h?.CODE_COLOR || '').split(/[,\s]+/).filter(Boolean);
const flag = (h, key) => String(h?.[key] || '').trim().toUpperCase() === 'TRUE';

// Is this release meant for mainnet? { mainnet, header, unknown, why }
export function releaseKind(release) {
  if (!release || release.draft || release.prerelease || !STABLE_TAG.test(String(release.tag_name || ''))) {
    return { mainnet: false, header: null, unknown: false, why: 'not a stable release (a draft, a pre-release or an rc tag)' };
  }
  const header = parseNearHeader(release.body);
  if (!header) return { mainnet: true, header: null, unknown: true, why: 'the release has no readable header' };
  const colors = colorsOf(header);
  if (colors.some((c) => /_MAINNET$/.test(c))) return { mainnet: true, header, unknown: false, why: null };
  if (colors.length && colors.every((c) => /_TESTNET$/.test(c))) {
    return { mainnet: false, header, unknown: false, why: `the header says CODE_COLOR: ${header.CODE_COLOR} (testnet only)` };
  }
  return { mainnet: true, header, unknown: true, why: `the header's CODE_COLOR "${header.CODE_COLOR || ''}" names no network` };
}

// Mainnet releases, newest first.
export function mainnetReleases(releases) {
  return stableReleases(releases).filter((r) => releaseKind(r).mainnet);
}

// What one release means for the pipeline.
export function classify(release) {
  const kind = releaseKind(release);
  const h = kind.header;
  const colors = colorsOf(h);
  const reasons = [];
  if (colors.includes('CODE_RED_MAINNET')) reasons.push('CODE_RED_MAINNET');
  if (flag(h, 'PROTOCOL_UPGRADE')) reasons.push('PROTOCOL_UPGRADE: TRUE');
  if (flag(h, 'SECURITY_UPGRADE')) reasons.push('SECURITY_UPGRADE: TRUE');
  const hit = h ? checkMandatory(release, ['nearcore-header'], { network: 'none' }) : null;
  // The watcher's rule and this reading should agree. If only one of them
  // says required, the release counts as required (the safe side: faster,
  // and an email to the owner).
  if (hit?.mandatory && !reasons.length) reasons.push(`the release watcher's nearcore rule: ${hit.quote}`);
  const mandatory = reasons.length > 0;
  return {
    tag: bare(release.tag_name),
    url: release.html_url || `https://github.com/${UPSTREAM_REPO}/releases/tag/${release.tag_name}`,
    publishedAt: release.published_at || null,
    mainnet: kind.mainnet,
    unknownHeader: kind.unknown,
    headerWhy: kind.why,
    color: h?.CODE_COLOR || null,
    header: h ? `CODE_COLOR: ${h.CODE_COLOR || '-'}, PROTOCOL_UPGRADE: ${h.PROTOCOL_UPGRADE || '-'}, DATABASE_UPGRADE: ${h.DATABASE_UPGRADE || '-'}, SECURITY_UPGRADE: ${h.SECURITY_UPGRADE || '-'}` : null,
    mandatory,
    reasons,
    deadline: hit?.mandatory && hit.deadline ? new Date(hit.deadline).toISOString() : null,
    deadlineNote: hit?.deadlineNote || null,
    quote: hit?.quote || null,
    protocol: flag(h, 'PROTOCOL_UPGRADE'),
    database: flag(h, 'DATABASE_UPGRADE'),
    security: flag(h, 'SECURITY_UPGRADE'),
  };
}

// The releases a bump from `from` to `to` covers (from < r <= to), classified, oldest first.
export function covered(releases, from, to) {
  return mainnetReleases(releases)
    .filter((r) => compareVersions(bare(r.tag_name), from) > 0 && compareVersions(bare(r.tag_name), to) <= 0)
    .reverse()
    .map(classify);
}

// Sums up the covered releases: required ones, the earliest deadline, one-way steps.
export function summarize(list) {
  const mandatory = list.filter((c) => c.mandatory);
  const dated = mandatory.filter((c) => c.deadline).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  return {
    mandatory,
    deadline: dated[0]?.deadline || null,
    deadlineNote: dated[0] ? `${dated[0].deadlineNote || 'deadline'} (nearcore ${dated[0].tag})` : null,
    oneWay: list.filter((c) => c.protocol || c.database),
    unknown: list.filter((c) => c.unknownHeader),
  };
}

export function deadlineText(iso, now = new Date()) {
  if (!iso) return 'as soon as possible (no date could be read)';
  const h = (new Date(iso) - new Date(now)) / 3600000;
  if (h < 0) return `${fmtUtc(iso)} (PASSED ${Math.floor(-h / 24)} d ${Math.floor(-h % 24)} h ago: boxes on the old version may already be affected)`;
  return `${fmtUtc(iso)} (in ${Math.floor(h / 24)} d ${Math.floor(h % 24)} h)`;
}

// The one-way warning for protocol and database upgrades (PR body and issues).
export function oneWayNote(oneWay, { fromNearcore, fromPackage } = {}) {
  if (!oneWay?.length) return '';
  const what = oneWay.map((c) => `nearcore ${c.tag} (${[c.protocol ? 'PROTOCOL_UPGRADE: TRUE' : null, c.database ? 'DATABASE_UPGRADE: TRUE' : null].filter(Boolean).join(', ')})`).join(', ');
  const newest = oneWay[oneWay.length - 1].tag;
  return `**One-way step, no rollback:** ${what}. ${oneWay.some((c) => c.database) ? 'On its first start it migrates the node database; after that, older nearcore versions cannot open it.' : 'Once the network has voted for the new protocol version, older nearcore versions cannot follow the chain.'} A box that has updated cannot go back${fromPackage ? ` to nearbp ${fromPackage}` : ''}${fromNearcore ? ` (nearcore ${fromNearcore})` : ''}, and every later fix must stay on nearcore ${newest} or newer: an older image would crash-loop on every updated box. A migration that is cut short (a reboot, or the disk watcher stopping the app after 10 s) cannot be undone. Our upgrade test only migrates a database that is a few minutes old; before promoting to production, update a copy of a fully synced NEAR database on the test box and check that neard comes back.`;
}

// --- the owner's issues about nearcore releases -----------------------------------------

const NOTICE = /<!-- avado-near:notice (\{.*\}) -->/;
export const noticeData = (body) => { try { return JSON.parse(NOTICE.exec(body || '')?.[1] || 'null'); } catch { return null; } };

// Text of a "[required]" or "[check]" issue for one phase:
//   pr       the bump PR is open (checks running, waiting or failing)
//   image    required, but nearcore's Docker image is not published yet (no PR yet)
//   held     the package is held: nothing ships until the owner removes the hold
//   staging  published to staging: promote it in editstore
export function noticeText(d, { phase, repo, mode, holdReason = null, pr = null, stagingVersion = null, now = new Date() }) {
  const server = env('GITHUB_SERVER_URL', 'https://github.com');
  const prUrl = pr ? `${server}/${repo}/pull/${pr}` : null;
  const shadow = mode !== 'on';
  const list = (d.items || []).map((c) => `- [nearcore ${c.tag}](${c.url}): ${c.header || 'no readable header'}${c.mandatory ? ` → **required** (${c.reasons.join(', ')})` : ''}`).join('\n');
  const marker = `<!-- avado-near:notice ${JSON.stringify(d)} -->`;
  if (d.kind === 'header') {
    const title = `[check] nearcore ${d.target}: the release header could not be read`;
    const body = `${marker}
**What happened:** the bump bot offers nearcore ${d.target} (${prUrl ? `PR ${prUrl}` : 'no PR yet'}), but ${d.why || 'its release header could not be read'}. The header is how the pipeline tells a required release (CODE_RED, protocol or security upgrade) from a normal one.

**What the pipeline does:** it treats nearcore ${d.target} as a normal mainnet release: it merges ${shadow ? '(only when PIPELINE_MODE is "on") ' : ''}72 hours after the release when our checks are green, and publishes it to staging. Production stays your click in editstore.

**What to do:** read the release notes: https://github.com/${UPSTREAM_REPO}/releases/tag/${d.target}. If NEAR says it is urgent, merge ${prUrl || 'the bump PR'} yourself with **"Create a merge commit"** as soon as \`avado/checks\` is green, then promote it in editstore. If NEAR changed its header format for good, the reader is .github/pipeline/lib/near.js and lib/mandatory.js (a copy of the release watcher's rules: fix it there first).

${list}

This issue closes by itself when the PR is merged and published, or closed.`;
    return { title, body };
  }

  const deadline = deadlineText(d.deadline, now);
  const title = `[required] nearcore ${d.target} for NEAR: promote to production before ${d.deadline ? fmtUtc(d.deadline) : 'as soon as possible'}`;
  const steps = {
    pr: `1. **Now:** the bump bot opened ${prUrl}. Our checks run on it (build, exact version, config keys and flags, boot on mainnet, upgrade in place).
2. ${shadow ? `**PIPELINE_MODE is not "on" (shadow mode): the gate will NOT merge it.** Merge ${prUrl} yourself with **"Create a merge commit"** as soon as \`avado/checks\` is green.` : 'The gate merges it **as soon as the checks are green** (no 72 h wait), and the release publishes it to the **staging** store.'} If a check fails you get a separate "[needs fix]" email with a Claude Code prompt.
3. **You:** when it is on staging, promote it to production in editstore **before the deadline**. You get another email here when it reaches staging.`,
    image: `1. **Now:** nearcore published the release on GitHub, but its Docker image \`${UPSTREAM_IMAGE}:${d.target}\` is not on Docker Hub yet. The bump bot looks every 4 hours and opens the PR as soon as the image exists (you get an email here then). If the image is still missing 24 hours after the release, you get a "[pipeline broken]" email.
2. Then our checks run, the gate ${shadow ? 'would merge it at once, but **PIPELINE_MODE is not "on"**: merge the PR yourself' : 'merges it as soon as they are green'}, and the release publishes it to staging.
3. **You:** promote it to production in editstore **before the deadline**.`,
    held: `**NEAR is held** (\`hold\` file: "${holdReason || 'held'}"): the bump bot opens no PR and nothing is released while the hold exists. To ship this required release, remove the \`hold\` file in a PR and merge it (or ship it by hand), then promote it in editstore before the deadline.`,
    staging: `**nearcore ${d.target} is on the staging store** as nearbp ${stagingVersion || d.packageVersion || ''}. **Promote it to production in editstore before the deadline.** If you can, first update an installed NEAR app on the test box and check that it keeps syncing.`,
  }[phase];
  const body = `${marker}
**nearcore ${d.target} is a required upgrade for NEAR validators** (${d.mandatory.map((c) => `${c.tag}: ${c.reasons.join(', ')}`).join('; ')}).

**Deadline:** ${deadline}${d.deadlineNote ? ` — ${d.deadlineNote}` : ''}. A NEAR validator that is not on the new version by then ${d.mandatory.some((c) => c.protocol) ? 'stops following the chain after the protocol upgrade and loses its validator seat' : 'stays exposed to the problem the release fixes (crash, DoS or security flaw)'}.

${steps}

${d.oneWay ? `${d.oneWay}\n\n` : ''}**Releases in this update** (nearcore ${d.from} → ${d.target}):
${list}

<details><summary>Prompt for Claude Code (optional: check the release before promoting)</summary>

\`\`\`text
In the AVADO-DNP-NearBP repository (${repo}), read the nearcore ${d.target} release notes (https://github.com/${UPSTREAM_REPO}/releases/tag/${d.target}) and every release between ${d.from} and ${d.target}. Tell me in plain words: what changes for a NEAR validator on an AVADO box, whether build/files/config.json or build/files/entrypoint.sh must change (renamed or removed config keys, new required settings, database migration notes), and what I should check on the test box before promoting it to production. Do not change any files.
\`\`\`
</details>

This issue updates itself and closes by itself when production runs nearcore ${d.target} or newer.`;
  return { title, body };
}

// Opens or updates the issue for a bump target (called by bump.mjs).
export async function upsertNotice(gh, repo, d, opts) {
  const { title, body } = noticeText(d, opts);
  return upsertIssue(gh, repo, {
    key: `${d.kind}-${d.target}`,
    title,
    body,
    assignee: opts.owner,
    state: `${opts.phase}@${d.target}`,
    changeNote: {
      pr: `nearcore ${d.target}: the bump PR is open${opts.pr ? ` (#${opts.pr})` : ''}. The description above is up to date.`,
      image: `nearcore ${d.target} is required, but its Docker image is not published yet.`,
      held: `nearcore ${d.target} is required, but NEAR is HELD: nothing ships until you remove the hold.`,
      staging: `nearcore ${d.target} is on STAGING now. Promote it to production in editstore before ${d.deadline ? fmtUtc(d.deadline) : 'the deadline'}.`,
    }[opts.phase],
  });
}

// Moves every open "[required]"/"[check]" issue to its current phase, or closes
// it (gate.mjs on every run, release.mjs after publishing). Idempotent: an
// issue only gets a comment (an email) when its phase changes.
//   main: { upstream, version, released, hold }  the default branch now
//   pr:   { number, target } | null              the open bump PR
//   prodUpstream: production's nearcore version, or null when unreadable
//   onlyMerged: look only at issues whose version is on the default branch
//               (release.mjs, which does not know the bump PR)
export async function syncNotices({ gh, repo, owner, mode, main, pr, prodUpstream, now = new Date(), say = () => {}, onlyMerged = false }) {
  for (const issue of await listOpenIssues(gh, repo)) {
    const m = /^(mandatory|header)-(\d+\.\d+\.\d+)$/.exec(issue.key || '');
    if (!m) continue;
    const d = noticeData(issue.body);
    if (!d) continue;
    const target = m[2];
    if (onlyMerged && compareVersions(main.upstream, target) < 0) continue;
    const close = async (why) => { await closeIssue(gh, repo, issue, why); say(`- closed issue #${issue.number} (${m[1]} ${target}): ${why}`); };
    if (prodUpstream && compareVersions(prodUpstream, target) >= 0) {
      await close(`Production runs nearcore ${prodUpstream} now.`);
      continue;
    }
    if (compareVersions(main.upstream, target) >= 0) {
      if (m[1] === 'header') {
        if (main.released) await close(`nearcore ${main.upstream} is merged and published to staging as nearbp ${main.version}.`);
        continue;
      }
      // Merged but not published yet: the release runs right after the merge
      // (and emails on its own if it fails), so no extra email here.
      if (!main.released) continue;
      await upsertNotice(gh, repo, d, { phase: 'staging', repo, mode, owner, stagingVersion: main.version, pr: d.pr, now });
      say(`- issue #${issue.number} (required ${target}): on staging`);
      continue;
    }
    if (pr && compareVersions(pr.target, target) > 0) {
      await close(`Replaced: the bump PR #${pr.number} now offers nearcore ${pr.target}${m[1] === 'mandatory' ? ' (it has its own issue)' : ''}.`);
      continue;
    }
    if (pr && pr.target === target) {
      if (m[1] === 'mandatory') await upsertNotice(gh, repo, d, { phase: main.hold ? 'held' : 'pr', repo, mode, owner, holdReason: main.hold, pr: pr.number, now });
      continue;
    }
    // Required, but the image was not on Docker Hub yet: the bump bot opens the PR later.
    if (!pr && /<!-- avado-pipeline:state image@/.test(issue.body || '')) continue;
    if (main.hold && m[1] === 'mandatory') {
      await upsertNotice(gh, repo, d, { phase: 'held', repo, mode, owner, holdReason: main.hold, pr: null, now });
      continue;
    }
    await close(`There is no open bump PR for nearcore ${target} any more (closed without merging: the version is skipped; reopen the PR to undo).`);
  }
}

