// A GitHub REST client: the watcher's read helpers (vendored http.js) plus the
// few writes the pipeline needs. Writes are never retried blindly.

import { makeHttp, makeGitHub, HttpError } from './http.js';

export function makeClient({ token, fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com' } = {}) {
  const http = makeHttp({ fetchImpl });
  const gh = makeGitHub({ http, token, apiBase });
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'avado-nearbp-pipeline',
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = (path) => (path.startsWith('http') ? path : `${apiBase}/${path.replace(/^\//, '')}`);

  async function write(method, path, payload) {
    const res = await fetchImpl(url(path), { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `${method} ${url(path)}`, text);
    return text ? JSON.parse(text) : null;
  }

  // Text behind a redirect (job logs): the signed download URL must be fetched
  // without the GitHub token.
  async function redirectedText(path, { maxBytes = 2_000_000 } = {}) {
    const first = await fetchImpl(url(path), { headers, redirect: 'manual' });
    let res = first;
    if (first.status >= 300 && first.status < 400 && first.headers.get('location')) {
      res = await fetchImpl(first.headers.get('location'));
    }
    if (!res.ok) throw new HttpError(res.status, url(path), '');
    const text = await res.text();
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  }

  return {
    ...gh,
    http,
    post: (p, b) => write('POST', p, b),
    patch: (p, b) => write('PATCH', p, b),
    put: (p, b) => write('PUT', p, b),
    del: (p) => write('DELETE', p),
    redirectedText,
  };
}
