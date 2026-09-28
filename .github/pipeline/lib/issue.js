// The owner's issues: one issue per problem (key), assigned to the owner, so
// GitHub emails it. The body is rewritten on every run (no email); a comment is
// added only when the state changes (one email), so a problem that lasts days
// does not flood the inbox.

export const LABEL = 'avado-pipeline';
const marker = (key) => `<!-- avado-pipeline:issue key=${key} -->`;
const stateMarker = (state) => `<!-- avado-pipeline:state ${state} -->`;
const STATE_RE = /<!-- avado-pipeline:state (\S+) -->/;

async function ensureLabel(gh, repo) {
  try {
    await gh.post(`repos/${repo}/labels`, { name: LABEL, color: 'd93f0b', description: 'Opened by the NEAR release pipeline' });
  } catch { /* exists already, or no permission: the issue is still created */ }
}

export async function findIssue(gh, repo, key) {
  const list = await gh.get(`repos/${repo}/issues?state=all&labels=${LABEL}&per_page=100&sort=updated`);
  return (list || []).find((i) => !i.pull_request && (i.body || '').includes(marker(key))) || null;
}

export async function listOpenIssues(gh, repo) {
  const list = await gh.get(`repos/${repo}/issues?state=open&labels=${LABEL}&per_page=100`);
  return (list || []).filter((i) => !i.pull_request).map((i) => ({ ...i, key: /key=(\S+) -->/.exec(i.body || '')?.[1] || null }));
}

// state: a short word for the current cause; a change of state adds a comment.
export async function upsertIssue(gh, repo, { key, title, body, assignee, state, changeNote }) {
  const full = `${marker(key)}\n${stateMarker(state)}\n${body}`;
  const found = await findIssue(gh, repo, key);
  const mention = assignee ? `@${assignee} ` : '';
  if (!found) {
    await ensureLabel(gh, repo);
    try {
      return await gh.post(`repos/${repo}/issues`, { title: title.slice(0, 250), body: full, labels: [LABEL], assignees: assignee ? [assignee] : [] });
    } catch (err) {
      // An assignee without access to the repo is refused; mention instead.
      if (!assignee) throw err;
      return gh.post(`repos/${repo}/issues`, { title: title.slice(0, 250), body: `${mention}\n\n${full}`, labels: [LABEL] });
    }
  }
  const before = STATE_RE.exec(found.body || '')?.[1] || null;
  const reopened = found.state !== 'open';
  await gh.patch(`repos/${repo}/issues/${found.number}`, { title: title.slice(0, 250), body: full, state: 'open' });
  if (reopened || before !== state) {
    await gh.post(`repos/${repo}/issues/${found.number}/comments`, { body: `${mention}${changeNote || 'The situation changed; the description above is up to date.'}` });
  }
  return found;
}

export async function closeIssue(gh, repo, issue, comment) {
  if (!issue || issue.state !== 'open') return false;
  if (comment) await gh.post(`repos/${repo}/issues/${issue.number}/comments`, { body: comment });
  await gh.patch(`repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
  return true;
}
