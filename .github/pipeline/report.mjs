#!/usr/bin/env node
// Tells the owner when a pipeline workflow itself breaks, and says so when it
// works again. Used as the last step of bump.yml, gate.yml and release.yml:
//
//   node .github/pipeline/report.mjs failure "<workflow name>"
//   node .github/pipeline/report.mjs success "<workflow name>"
//
// failure: opens (or updates) one issue per workflow, assigned to the owner,
// with the run link, what the script said went wrong (failureFile()) and a
// ready-to-paste Claude Code prompt.
// success: closes that issue if it is open.

import { readFileSync, existsSync } from 'node:fs';
import { makeClient } from './lib/gh.js';
import { upsertIssue, findIssue, closeIssue } from './lib/issue.js';
import { env, failureFile } from './lib/common.js';

const [outcome, workflow] = process.argv.slice(2);
const repo = env('GITHUB_REPOSITORY');
const runId = env('GITHUB_RUN_ID', '0');
const runUrl = `${env('GITHUB_SERVER_URL', 'https://github.com')}/${repo}/actions/runs/${runId}`;
const gh = makeClient({ token: env('GITHUB_TOKEN') });
const key = `workflow-${String(workflow).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const effect = {
  Release: `A new version did not reach the staging store (read the error above: it says which versions were published and which not). Boxes are not affected: production only changes when you publish it in editstore.
If the error is "NOT published ... no tested build": run "PR checks" by hand with pr = the default branch, then "Release" again (the error says how).
If the run failed after a "Release <name> <version>" commit was pushed (for example store.releaseStore did not answer), run "Release" by hand with "release_store" ticked: it asks the store to rebuild staging again.`,
  Gate: 'The bump PR may be neither merged nor released until this works again (if the log shows "merged", the release may not have started: the next gate run starts it). Nothing reaches any box.',
  'Bump nearcore': 'New nearcore releases are not picked up until this works again, including required ones (the release watcher still reports those). Nothing reaches any box.',
}[workflow] || 'Nothing reaches any box while this is broken.';

function detail() {
  try {
    const f = failureFile();
    return existsSync(f) ? readFileSync(f, 'utf8').trim().slice(0, 3000) : '';
  } catch {
    return '';
  }
}

async function main() {
  if (outcome === 'success') {
    const issue = await findIssue(gh, repo, key);
    if (issue?.state === 'open') await closeIssue(gh, repo, issue, `Works again: ${runUrl}`);
    return;
  }
  const said = detail();
  const body = `**What happened:** the "${workflow}" workflow failed: ${runUrl}
${said ? `\n**The error:**\n\`\`\`text\n${said}\n\`\`\`\n` : ''}
**What it means:** ${effect}

**How to fix it with Claude Code** (on your Mac, in your AVADO-DNP-NearBP checkout on the default branch):
\`\`\`bash
gh run view ${runId} -R ${repo} --log-failed | tail -80
claude    # then paste the prompt below
\`\`\`

<details open><summary>Prompt for Claude Code</summary>

\`\`\`text
In the AVADO-DNP-NearBP repository (${repo}), the GitHub Actions workflow "${workflow}" failed in run ${runUrl}.
Read the failed log with: gh run view ${runId} -R ${repo} --log-failed
Explain the cause in plain words. If it is a bug in .github/workflows or .github/pipeline, fix it on a new branch and open a pull request (do not push to main).
If it is an outside problem (GitHub, Docker Hub, AVADO's IPFS node or store, the nearcore releases API), say so and say whether re-running the workflow is enough.
If the log shows "Bad credentials", HTTP 401 or 403, or git exit code 128 on a push, the PAT_TOKEN secret (the owner's personal token) has probably expired: say so; it must be renewed in Settings -> Secrets and variables -> Actions.
Never change the package name, the volume, the host port or environment variable names in dappnode_package.json.
\`\`\`
</details>

This issue closes by itself after the next successful run of "${workflow}".`;
  await upsertIssue(gh, repo, {
    key,
    title: `[pipeline broken] ${workflow} workflow failed`,
    body,
    assignee: env('PIPELINE_OWNER', 'flisko'),
    state: 'failed', // one email when it breaks; later failures only update the text
    changeNote: `Failed again: ${runUrl}`,
  });
}

main().catch((err) => {
  // Reporting must never hide the original failure.
  console.log(`::warning::could not report the ${outcome} of "${workflow}": ${err.message}`);
});
