// 验证公开数据脱敏、UTC 时间戳与缓存失效请求。
// Check public redaction, UTC timestamps, and cache invalidation requests.

import { toIsoTimestamp } from '../../backends/worker/src/lib/public/payload';
import { cachePublicResponse, invalidateMonitorDetail, invalidatePublicCache, publicCacheKey } from '../../backends/worker/src/lib/public/cache';
import { publicAgentLive, publicMessage, publicTarget } from '../../backends/worker/src/lib/public/redaction';
import { publicProbeAvailable } from '../../backends/worker/src/lib/public/probe-source';
import type { MonitorType } from '../../backends/worker/src/types';

const equal = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`);
};
const truthy = (label: string, value: unknown) => {
  if (!value) throw new Error(label);
};

const key = (url: string, headers?: HeadersInit, method = 'GET') =>
  publicCacheKey(new Request(`https://status.example${url}`, { headers, method }));

equal('status GET has a cache key', key('/api/public/status')?.url, 'https://status.example/api/public/status');
equal('server list GET has a cache key', key('/api/public/servers')?.url, 'https://status.example/api/public/servers');
equal('server detail GET has a cache key', key('/api/public/servers/agent-1')?.url, 'https://status.example/api/public/servers/agent-1');
equal('auth header skips cache', key('/api/public/status', { authorization: 'Bearer secret' }), null);
equal('cookie skips cache', key('/api/public/status', { cookie: 'session=secret' }), null);
equal('writes skip cache', key('/api/public/status', undefined, 'POST'), null);
equal('arbitrary query skips cache', key('/api/public/status?debug=1'), null);
equal('duplicate query skips cache', key('/api/public/monitors?pageId=a&pageId=b'), null);
equal('page query is canonical', key('/api/public/monitors?pageId=default')?.url, key('/api/public/monitors')?.url);
equal('fresh theme config bypasses cached built-in config', key('/api/public/config?fresh=1'), null);
equal('fresh page config bypasses cached page variants', key('/api/public/config?pageId=default&fresh=1'), null);
equal('agent range is clamped and canonical', key('/api/public/agent/detail/4?minutes=9999')?.url, 'https://status.example/api/public/agent/detail/4?minutes=1440');

const responseCache = new Map<string, Response>();
const fakeCache = {
  put: async (request: Request, response: Response) => { responseCache.set(request.url, response); },
} as unknown as Cache;
const cacheKey = key('/api/public/status')!;
await cachePublicResponse(fakeCache, cacheKey, Response.json({ ok: true }));
equal('successful response cached', responseCache.size, 1);
equal('cache TTL is bounded', responseCache.get(cacheKey.url)?.headers.get('cache-control'), 'public, max-age=0, s-maxage=15');
await cachePublicResponse(fakeCache, cacheKey, Response.json({ error: 'internal_error' }, { status: 500 }));
equal('errors are not cached', responseCache.size, 1);
await cachePublicResponse(fakeCache, cacheKey, new Response('private', { headers: { 'cache-control': 'private, no-store' } }));
equal('no-store responses are not cached', responseCache.size, 1);

const target = 'https://person:password@health.example/check/path?token=signed#fragment';
equal('public target removes URL credentials and query', publicTarget(target, 'http' as MonitorType), 'https://health.example/check/path');
equal('public message is replaced with a generic HTTP label', publicMessage('http', 0, `probe failed at ${target}`), 'HTTP check failed');
equal('keyword content is not included in public text', publicMessage('http', 0, 'keyword "private-expected-value" not found'), 'HTTP check failed');
equal('JSON actual and expected values are not included in public text', publicMessage('http', 0, 'json "token" is "private-actual" expected "private-expected"'), 'HTTP check failed');
equal('TCP server banners are not included in public text', publicMessage('tcp', 0, 'expect "service" not found in "private-server-banner"'), 'TCP check failed');
equal('private UP agent message does not change public status copy', publicMessage('agent', 1, 'private agent message'), '');
equal('WARN detail does not imply the primary check failed', publicMessage('http', 2, 'certificate expiring soon'), 'Monitor warning');
equal('invalid HTTP target is not echoed', publicTarget('not a URL with secret', 'http' as MonitorType), 'Invalid URL');
truthy('non-HTTP target remains readable', publicTarget('health.example:443', 'tcp' as MonitorType));

/*
  Every type is redacted, not just http.

  A non-http monitor can hold a leftover URL - flipping an http row to
  push/agent used to leave one behind - so `publicTarget` cannot trust the type
  to mean "not a URL". The same `origin + pathname` reduction applies, and the
  type is only used for what an unparseable value means.

  所有类型都要脱敏，而非仅 http。非 HTTP 监控可能残留 URL：过去将 HTTP 记录改为
  push/agent 时可能留下旧 URL，因此 `publicTarget` 不能凭类型认定它不是 URL。
  所有类型都保留相同的 `origin + pathname`，类型只用于判断无法解析的值如何处理。
*/
equal('a tcp host:port target is kept, not treated as invalid', publicTarget('health.example:443', 'tcp' as MonitorType), 'health.example:443');
equal('a push row with a leftover URL loses userinfo', publicTarget('https://user:pass@health.example/health?token=SECRET123', 'push' as MonitorType), 'https://health.example/health');
equal('an agent row with a leftover URL loses the query', publicTarget('https://health.example/health?token=SECRET123', 'agent' as MonitorType), 'https://health.example/health');
equal('a tcp target with userinfo is reduced too', publicTarget('user:pass@db.example:5432?ssl=true', 'tcp' as MonitorType), 'db.example:5432');
equal('an empty push target stays empty', publicTarget('', 'push' as MonitorType), '');
equal('an empty agent target stays empty', publicTarget('', 'agent' as MonitorType), '');
equal('an empty http target is still invalid, as before', publicTarget('', 'http' as MonitorType), 'Invalid URL');
equal('an unparseable non-http target is not echoed', publicTarget('not a URL with secret', 'push' as MonitorType), 'Invalid URL');
equal('a bare hostname stays a bare hostname', publicTarget('example.com', 'tcp' as MonitorType), 'example.com');
equal('a path on a tcp target is preserved', publicTarget('health.example:443/deep/path?x=1', 'tcp' as MonitorType), 'health.example:443/deep/path');
const agentLive = publicAgentLive({ cpu_usage: 12, message: 'private agent message', probe_capabilities: 'private', agent_token: 'secret' });
equal('public agent metrics retain CPU', agentLive.cpu_usage, 12);
equal('private agent message is omitted', 'message' in agentLive, false);
equal('private agent fields are omitted', 'probe_capabilities' in agentLive || 'agent_token' in agentLive, false);
const worker = { interval_sec: 60, timeout_ms: 10000 };
equal('never-observed Worker is unknown', publicProbeAvailable(undefined, worker, 2000), false);
equal('fresh Worker reading remains available through its grace', publicProbeAvailable({ ts: 1000 }, worker, 1120), true);
equal('stale Worker reading becomes unknown after interval grace', publicProbeAvailable({ ts: 1000 }, worker, 1121), false);
equal('infrastructure-skipped Worker reading remains unknown', publicProbeAvailable({ ts: 1000, source_available: false }, worker, 1010), false);
const sixHourMonitor = { interval_sec: 21600, timeout_ms: 10000 };
equal('six-hour interval is still fresh after two hours', publicProbeAvailable({ ts: 1000 }, sixHourMonitor, 8200), true);
equal('six-hour interval becomes unknown after its grace', publicProbeAvailable({ ts: 1000 }, sixHourMonitor, 22661), false);
equal('timeout extension is bounded without shortening cadence', publicProbeAvailable({ ts: 1000 }, { interval_sec: 3000, timeout_ms: 10000000 }, 7000), true);
equal('daily interval stays fresh before its due time', publicProbeAvailable({ ts: 1000 }, { interval_sec: 86400, timeout_ms: 10000 }, 80000), true);

/* 时间戳解析后须还原原始 UTC 时刻。
 * Parsing the timestamp must recover the original UTC instant. */
const beatsAt = (epochSec: number) => Date.parse(toIsoTimestamp(epochSec));
equal('the timestamp is ISO-8601 with an explicit UTC marker', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(toIsoTimestamp(1760882400)), true);
equal('and parses back to the exact epoch millisecond', beatsAt(1760882400), 1760882400000);
equal('a non-UTC visitor gets the true instant, not a shifted one', beatsAt(0), 0);
equal('a leap day round-trips', beatsAt(Date.UTC(2024, 1, 29, 12, 34, 56, 789) / 1000), Date.UTC(2024, 1, 29, 12, 34, 56, 789));
equal('a fractional second is preserved', beatsAt(1760882400.5), 1760882400500);
/* 记录请求删除的键；其他页面变体还依赖 TTL 或可见性版本。
 * Record requested cache deletions; other page variants also rely on TTL or visibility revisions. */
{
  const deleted: string[] = [];
  const fakeCache = {
    delete: async (request: Request) => { deleted.push(request.url); return false; },
  } as unknown as Cache;

  deleted.length = 0;
  await invalidatePublicCache(fakeCache, 'https://status.example');
  truthy('invalidation drops the aggregate status row', deleted.includes('https://status.example/api/public/status'));
  truthy('invalidation drops the default monitor feed', deleted.includes('https://status.example/api/public/monitors?pageId=default'));
  truthy('invalidation drops the default config', deleted.includes('https://status.example/api/public/config?pageId=default'));
  truthy('invalidation drops the public machine feed', deleted.includes('https://status.example/api/public/servers'));
  equal('invalidation asks for no duplicate keys', new Set(deleted).size, deleted.length);

  // The detail reads are keyed by ids only the route knows. Both id spellings
  // must be evicted, because the two endpoints disagree on which one they take.
  // 详情读取以只有路由知道的 ID 为键；两个端点使用的 ID 不同，因此两种写法都必须清除。
  deleted.length = 0;
  await invalidateMonitorDetail(fakeCache, 'https://status.example', { uuid: 'mon-1', numId: 7 });
  truthy('a monitor edit drops its numeric detail', deleted.includes('https://status.example/api/public/monitors/7'));
  truthy('a monitor edit drops its agent detail', deleted.includes('https://status.example/api/public/agent/detail/7?minutes=60'));
  truthy('a monitor edit drops its UUID status detail', deleted.includes('https://status.example/api/public/status/detail?id=mon-1'));
  equal('a monitor edit asks for no duplicate keys', new Set(deleted).size, deleted.length);

  // No ids means nothing to evict - it must not fall through to a bare path
  // that would delete an unrelated key.
  // 没有 ID 就没有可清除的键，不能回退到不带 ID 的路径而删除无关键。
  deleted.length = 0;
  await invalidateMonitorDetail(fakeCache, 'https://status.example', {});
  equal('no ids evicts nothing', deleted.length, 0);
}

console.log('public cache, quality, and redaction: 66 passed');
