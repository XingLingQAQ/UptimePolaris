import { Hono } from 'hono';
import { PROJECT_REPOSITORY_URL } from '../../../../../shared/project';
import { compareVersions, STABLE_TAG, type VersionCheck } from '../../../../../shared/project-version';
import type { Env } from '../../types';

const TTL = 6 * 60 * 60;
const repository = new URL(PROJECT_REPOSITORY_URL).pathname.slice(1);
const tagsUrl = `https://api.github.com/repos/${repository}/tags?per_page=100`;
const cacheKey = new Request(`https://api.github.com/repos/${repository}/polaris-stable-version`);
let latest: VersionCheck | undefined;
let pending: Promise<VersionCheck> | undefined;
let blockedUntil = 0;

class VersionError extends Error {
  constructor(public code: string, public retryAfter = 0) { super(code); }
}

async function fetchVersion(): Promise<VersionCheck> {
  const signal = AbortSignal.timeout(12_000);
  let tag: string | null = null;
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`${tagsUrl}&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Uptime-Polaris', 'X-GitHub-Api-Version': '2026-03-10' },
      redirect: 'error', signal,
    });
    if (response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) {
      const retry = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      blockedUntil = Math.max(Date.now() + (retry > 0 ? retry : 60) * 1000, Number.isFinite(reset) ? reset : 0);
      throw new VersionError('version_rate_limited', Math.ceil((blockedUntil - Date.now()) / 1000));
    }
    if (!response.ok) throw new VersionError('version_unavailable');
    const tags: unknown = await response.json().catch(() => { throw new VersionError('version_invalid_response'); });
    if (!Array.isArray(tags)) throw new VersionError('version_invalid_response');
    for (const row of tags) {
      if (typeof row?.name !== 'string') throw new VersionError('version_invalid_response');
      if (STABLE_TAG.test(row.name) && (!tag || compareVersions(row.name, tag) > 0)) tag = row.name;
    }
    if (!response.headers.get('link')?.includes('rel="next"')) return { tag, checkedAt: Date.now() };
  }
  throw new VersionError('version_invalid_response');
}

async function readVersion(refresh: boolean): Promise<VersionCheck> {
  const maxAge = (refresh ? 60 : TTL) * 1000;
  if (latest && Date.now() - latest.checkedAt < maxAge) return latest;
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const result = await cached.json<VersionCheck>();
      if (Number.isFinite(result.checkedAt) && result.checkedAt <= Date.now() && Date.now() - result.checkedAt < maxAge && (result.tag === null || typeof result.tag === 'string' && STABLE_TAG.test(result.tag))) return latest = result;
    }
  } catch {}
  if (Date.now() < blockedUntil) throw new VersionError('version_rate_limited', Math.ceil((blockedUntil - Date.now()) / 1000));
  if (!pending) pending = fetchVersion().then(async result => {
    latest = result;
    try { await caches.default.put(cacheKey, Response.json(result, { headers: { 'cache-control': `public, max-age=${TTL}` } })); } catch {}
    return result;
  }).finally(() => { pending = undefined; });
  return pending;
}

export const versionRoutes = new Hono<{ Bindings: Env }>();
versionRoutes.get('/api/admin/version', async c => {
  c.header('cache-control', 'private, no-store');
  try { return c.json(await readVersion(c.req.query('refresh') === '1')); }
  catch (error) {
    const code = error instanceof VersionError ? error.code : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'version_timeout' : 'version_unavailable';
    const retryAfter = error instanceof VersionError ? error.retryAfter : 0;
    if (retryAfter) c.header('retry-after', String(retryAfter));
    return c.json({ error: code, ...(retryAfter ? { retryAfter } : {}) }, code === 'version_rate_limited' ? 429 : 502);
  }
});
