// Vendored unchanged from AvadoDServer/avado-release-control bot/lib/http.js at 1313db3
// (the release watcher). Keep the two copies the same; fix bugs there first.

// HTTP helpers: timeouts, retries, a GitHub API client and a health log.
// Every failed source is written to the health log. The digest prints it,
// so missing data is never reported as "all good".

export class Health {
  constructor() {
    this.entries = new Map(); // source -> {ok, detail}
  }
  ok(source, detail = '') {
    const prev = this.entries.get(source);
    if (prev && !prev.ok) return; // a failure for the same source stays visible
    this.entries.set(source, { ok: true, detail });
  }
  fail(source, detail) {
    this.entries.set(source, { ok: false, detail: String(detail).slice(0, 300) });
  }
  failures() {
    return [...this.entries].filter(([, v]) => !v.ok).map(([source, v]) => ({ source, detail: v.detail }));
  }
  successes() {
    return [...this.entries].filter(([, v]) => v.ok).map(([source, v]) => ({ source, detail: v.detail }));
  }
}

export class HttpError extends Error {
  constructor(status, url, body = '') {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 160)}` : ''}`);
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeHttp({ fetchImpl = globalThis.fetch, timeoutMs = 20000, retries = 2, backoffMs = 1500 } = {}) {
  async function request(url, { headers = {}, method = 'GET', body, allow404 = false, as = 'text', timeout = timeoutMs, tries = retries + 1 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
        if (res.status === 404 && allow404) return null;
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new HttpError(res.status, url, text);
          // 4xx other than 408/429 will not get better by retrying.
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw Object.assign(err, { final: true });
          throw err;
        }
        if (as === 'json') return await res.json();
        if (as === 'bytes') return new Uint8Array(await res.arrayBuffer());
        return await res.text();
      } catch (err) {
        // A timeout is marked so the IPFS reader can stop asking a gateway that hangs.
        lastErr = err.name === 'AbortError' ? Object.assign(new Error(`timeout after ${Math.round(timeout / 100) / 10}s for ${url}`), { timeout: true }) : err;
        if (err.final) throw err;
        if (attempt < tries) await sleep(backoffMs * attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }
  return {
    text: (url, opts) => request(url, { ...opts, as: 'text' }),
    json: (url, opts) => request(url, { ...opts, as: 'json' }),
    bytes: (url, opts) => request(url, { ...opts, as: 'bytes' }),
    request,
  };
}

export function makeGitHub({ http, token, apiBase = 'https://api.github.com' }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'avado-release-control',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let calls = 0;
  const url = (path) => (path.startsWith('http') ? path : `${apiBase}/${path.replace(/^\//, '')}`);
  const get = (path, opts = {}) => { calls++; return http.json(url(path), { headers, ...opts }); };
  const send = async (method, path, payload) => {
    calls++;
    const text = await http.request(url(path), {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      as: 'text',
      tries: 1, // writes are never retried blindly
    });
    return text ? JSON.parse(text) : null;
  };
  return {
    get,
    post: (path, payload) => send('POST', path, payload),
    patch: (path, payload) => send('PATCH', path, payload),
    // Reads a file at a ref through the contents API and decodes it.
    async file(repo, path, ref) {
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const res = await get(`repos/${repo}/contents/${path}${q}`, { allow404: true });
      if (!res) return null;
      if (res.encoding !== 'base64') throw new Error(`unexpected encoding for ${repo}/${path}`);
      return Buffer.from(res.content, 'base64').toString('utf8');
    },
    async paginate(path, { perPage = 100, maxPages = 5, pick = (x) => x } = {}) {
      const out = [];
      const sep = path.includes('?') ? '&' : '?';
      for (let page = 1; page <= maxPages; page++) {
        const data = pick(await get(`${path}${sep}per_page=${perPage}&page=${page}`));
        out.push(...data);
        if (data.length < perPage) break;
      }
      return out;
    },
    get calls() { return calls; },
  };
}
