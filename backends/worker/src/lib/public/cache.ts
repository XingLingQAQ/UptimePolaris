import type { Env } from '../../types';
import { getDB } from '../db/factory';

const PAGE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** 仅为允许缓存的匿名读取生成规范化键，其余请求返回 null。 / Generate normalized keys only for cacheable anonymous reads; return null for other requests. */
export function publicCacheKey(request: Request, revision?: string): Request | null {
  if (request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('cookie')) return null;

  const url = new URL(request.url);
  const params = [...url.searchParams.entries()];
  const values = new Map<string, string>();
  for (const [key, value] of params) {
    if (values.has(key)) return null;
    values.set(key, value);
  }

  const path = url.pathname;
  let canonical: URL | null = null;
  if (path === '/api/public/status' && values.size === 0) {
    canonical = new URL(path, url.origin);
  } else if (path === '/api/public/servers' && values.size === 0) {
    canonical = new URL(path, url.origin);
  } else if (path === '/api/public/config' || path === '/api/public/monitors') {
    if ([...values.keys()].every((key) => key === 'pageId')) {
      const pageId = values.get('pageId') ?? 'default';
      if (PAGE_ID.test(pageId)) {
        canonical = new URL(path, url.origin);
        canonical.searchParams.set('pageId', pageId);
      }
    }
  } else if (path === '/api/public/status/detail' && values.size === 1 && values.has('id')) {
    const id = values.get('id')!;
    if (ID.test(id)) {
      canonical = new URL(path, url.origin);
      canonical.searchParams.set('id', id);
    }
  } else {
    const monitor = path.match(/^\/api\/public\/monitors\/(\d+)$/);
    const agent = path.match(/^\/api\/public\/agent\/detail\/(\d+)$/);
    const server = path.match(/^\/api\/public\/servers\/([a-zA-Z0-9_-]{1,128})$/);
    if (server && values.size === 0) {
      canonical = new URL(`/api/public/servers/${server[1]}`, url.origin);
    } else if (monitor && values.size === 0) {
      const id = Number(monitor[1]);
      if (Number.isSafeInteger(id) && id > 0) canonical = new URL(`/api/public/monitors/${id}`, url.origin);
    } else if (agent && [...values.keys()].every((key) => key === 'minutes')) {
      const id = Number(agent[1]);
      const raw = values.get('minutes') ?? '60';
      if (Number.isSafeInteger(id) && id > 0 && /^\d{1,5}$/.test(raw)) {
        const minutes = Math.max(1, Math.min(1440, Number(raw)));
        canonical = new URL(`/api/public/agent/detail/${id}`, url.origin);
        canonical.searchParams.set('minutes', String(minutes));
      }
    }
  }

  if (!canonical) return null;
  if (revision) canonical.searchParams.set('__visibility', revision);
  return new Request(canonical, { method: 'GET' });
}

export async function publicVisibilityRevision(env: Env): Promise<string> {
  const db = getDB(env);
  const row = await db.queryOne<{ json: string }>("SELECT json FROM live_state WHERE id='public-visibility'");
  return row ? (JSON.parse(row.json) as { revision: string }).revision : 'initial';
}

/** Visibility and its cache generation must commit together. / 可见性与缓存版本必须一起提交。 */
export function visibilityRevisionWrite(now: number, postgres: boolean): { sql: string; params: unknown[] } {
  return {
    sql: `INSERT INTO live_state(id,json,updated_at) VALUES ('public-visibility',${postgres ? '$1,$2' : '?,?'}) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`,
    params: [JSON.stringify({ revision: crypto.randomUUID() }), now],
  };
}

export async function cachePublicResponse(
  cache: Cache,
  key: Request,
  response: Response,
): Promise<void> {
  if (response.status !== 200 || /(?:^|,)\s*no-store\b/i.test(response.headers.get('cache-control') ?? '')) return;
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'public, max-age=0, s-maxage=15');
  await cache.put(key, new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

/**
 * 清除已知的汇总和默认列表键；其他 pageId 键由 TTL 或可见性版本隔离。
 * Evict known summary and default-list keys; other pageId keys rely on TTL or visibility revisions.
 */
export async function invalidatePublicCache(cache: Cache, origin: string): Promise<void> {
  await Promise.all([
    cache.delete(new Request(new URL('/api/public/status', origin))),
    cache.delete(new Request(new URL('/api/public/config?pageId=default', origin))),
    cache.delete(new Request(new URL('/api/public/monitors?pageId=default', origin))),
    cache.delete(new Request(new URL('/api/public/servers', origin))),
  ]);
}

/**
 * 按已知 UUID 或数字 ID 清除详情键；Agent 历史只清除默认的 60 分钟键。
 * Evict detail keys for known UUIDs or numeric IDs; only evict the default 60-minute Agent history key.
 */
export async function invalidateMonitorDetail(
  cache: Cache,
  origin: string,
  ids: { uuid?: string | null; numId?: number | null },
): Promise<void> {
  const keys: Request[] = [];
  if (ids.numId && Number.isSafeInteger(ids.numId) && ids.numId > 0) {
    keys.push(new Request(new URL(`/api/public/monitors/${ids.numId}`, origin)));
    keys.push(new Request(new URL(`/api/public/agent/detail/${ids.numId}?minutes=60`, origin)));
  }
  if (ids.uuid) {
    keys.push(new Request(new URL(`/api/public/status/detail?id=${encodeURIComponent(ids.uuid)}`, origin)));
  }
  if (keys.length) await Promise.all(keys.map((key) => cache.delete(key)));
}
