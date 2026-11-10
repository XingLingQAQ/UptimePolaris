import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { agentRoutes } from './lib/agent/routes';
import { agentTransportRoutes } from './lib/agent/transport-routes';
import { authRoutes, currentUser } from './lib/auth/routes';
import { safeEqual } from './lib/auth/service';
import { dbScopeMiddleware, getDB } from './lib/db/factory';
import { groupTagRoutes } from './lib/group/routes';
import { groupManagementRoutes } from './lib/group/management';
import { internalErrorResponse } from './lib/http/errors';
import { jobRoutes } from './lib/jobs/routes';
import { overviewRoutes } from './lib/monitor/overview-routes';
import { monitorRoutes } from './lib/monitor/routes';
import { invalidateConfig } from './lib/monitor/store';
import { notifyRoutes } from './lib/notification/routes';
import { cachePublicResponse, invalidatePublicCache, publicCacheKey, publicVisibilityRevision, visibilityRevisionWrite } from './lib/public/cache';
import { publicRoutes } from './lib/public/routes';
import { settingsRoutes } from './lib/settings/routes';
import { themeRoutes } from './lib/theme/routes';
import type { Env } from './types';
import { presentationScope } from './lib/presentation/context';
import { presentationRoutes } from './lib/presentation/routes';
import { agentTaxonomyRoutes } from './lib/presentation/taxonomy';
import { serverRoutes } from './lib/presentation/servers';
import type { BackendCapabilities } from '../../../shared/backend-capabilities';

/** 组装 API 路由、公共缓存和管理接口鉴权。 / Assemble API routes, public caching, and management authentication. */
export const api = new Hono<{ Bindings: Env }>();

api.use('*', dbScopeMiddleware);
api.use('/api/*', presentationScope);

// 错误响应不进入共享缓存。
// Error responses must not enter the shared cache.
api.use('/api/*', async (c, next) => {
  await next();
  if (c.res.status >= 400) c.header('cache-control', 'private, no-store');
});

// 仅匿名公共 GET 请求使用规范化后的边缘缓存键。
// Only anonymous public GET requests use the normalized edge cache key.
api.use('/api/*', async (c, next) => {
  if (!new URL(c.req.url).pathname.startsWith('/api/public/')) return next();
  const baseKey = publicCacheKey(c.req.raw);
  const key = baseKey ? publicCacheKey(c.req.raw, await publicVisibilityRevision(c.env)) : null;
  if (!key) {
    const path = new URL(c.req.url).pathname;
    const hasCredentials = c.req.header('authorization') || c.req.header('cookie');
    if (path !== '/api/public/icon' || hasCredentials || c.req.method !== 'GET') c.header('cache-control', 'private, no-store');
    await next();
    return;
  }

  const cache = caches.default;
  let cached: Response | undefined;
  try { cached = await cache.match(key) ?? undefined; } catch { cached = undefined; }
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('x-public-cache', 'HIT');
    const hit = new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
    c.res = hit;
    return hit;
  }

  await next();
  const response = c.res;
  if (response.status !== 200 || /(?:^|,)\s*no-store\b/i.test(response.headers.get('cache-control') ?? '')) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'public, max-age=0, s-maxage=15');
  headers.set('x-public-cache', 'MISS');
  const miss = new Response(response.clone().body, { status: response.status, statusText: response.statusText, headers });
  try { await cachePublicResponse(cache, key, miss); } catch {}
  c.res = miss;
  return miss;
});

/** Invalidate public responses after successful writes to data shown on the status page. / 状态页数据写入成功后，使公共响应缓存失效。 */
api.use('/api/*', async (c, next) => {
  await next();
  const path = new URL(c.req.url).pathname;
  const changesPublicData = c.req.method !== 'GET' && (
    path === '/api/monitors' || path.startsWith('/api/monitors/') ||
    path === '/api/groups' || path.startsWith('/api/groups/') ||
    path === '/api/tags' || path.startsWith('/api/tags/') ||
    path === '/api/admin/settings' || path.startsWith('/api/admin/settings/') ||
    path.startsWith('/api/admin/agents/') ||
    path.startsWith('/api/admin/presentation') || path.startsWith('/api/admin/agent-groups') || path.startsWith('/api/admin/agent-tags') ||
    path === '/api/themes' || path.startsWith('/api/themes/')
  );
  if (changesPublicData && c.res.status >= 200 && c.res.status < 300) {
    const db = getDB(c.env);
    const revision = visibilityRevisionWrite(Math.floor(Date.now() / 1000), db.type === 'postgres');
    await db.execute(revision.sql, revision.params);
    // Invalidate this isolate as well as the edge cache.
    // 同时使当前 isolate 和边缘缓存失效。
    if (path === '/api/admin/settings' || path.startsWith('/api/admin/settings/') || path.startsWith('/api/admin/agents/')) invalidateConfig();
    try { await invalidatePublicCache(caches.default, new URL(c.req.url).origin); } catch {}
  }
});

api.onError((error, c) => {
  if (error instanceof HTTPException && error.status >= 400 && error.status < 500) {
    return Response.json({ error: error.status === 413 ? 'request_too_large' : 'invalid_request' }, { status: error.status, headers: { 'cache-control': 'private, no-store' } });
  }
  return internalErrorResponse(error, c.req.method, c.req.matchedRoutes.at(-1)?.path);
});

api.notFound((c) => c.json({ error: 'not_found' }, 404, { 'cache-control': 'private, no-store' }));

/** Mount sign-in routes before the management gate. / 登录路由必须挂载在管理鉴权之前。 */
api.get('/api/capabilities', (c) => c.json({
  runtime: 'worker',
  apiVersion: 1,
  probeSource: 'worker',
  monitoring: {
    types: ['http', 'tcp', 'udp', 'icmp', 'push', 'agent'],
    nativeTypes: ['http', 'tcp'],
    minimumIntervalSec: 60,
    minimumTimeoutMs: 1000,
    maximumTimeoutMs: 60000,
    sslMode: 'certificate-records',
  },
  themes: { storage: 'r2', installationAvailable: Boolean(c.env.THEMES) },
} satisfies BackendCapabilities));

api.route('/', authRoutes);

/** Management requests accept an HttpOnly session cookie or a bearer ADMIN_TOKEN. / 管理请求接受 HttpOnly 会话 Cookie 或 Bearer ADMIN_TOKEN。 */
api.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  /** Push and Agent writes authenticate with their own tokens; never log those credentials. / Push 和 Agent 写入使用各自令牌鉴权，不记录这些凭据。 */
  /** Public paths are explicit; all other API routes pass through the management gate. / 公共路径须显式列出；其他 API 路由均经过管理鉴权。 */
  const STATIC_PUBLIC = new Set([
    '/api/auth/session',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/public/status',
    '/api/public/status/detail',
    '/api/public/config',
    '/api/public/maintenance',
    '/api/public/monitors',
    '/api/public/icon',
    // Monitor favicons, for the anonymous status page. The route itself is
    // inert unless `site.syncMonitorIcons` is on and the target is public.
    // 匿名状态页的监控图标；只有启用 `site.syncMonitorIcons` 且目标为公共地址时才生效。
    '/api/public/monitor-icon',
    '/api/public/health',
    // Active theme revision, safe for anonymous cache-free polling.
    // 当前主题修订版本，可供匿名无缓存轮询。
    '/api/public/theme',
    '/api/public/servers',
  ]);
  const PUBLIC_PREFIXES = [
    '/api/public/agent/',
    '/api/public/servers/',
    '/api/public/push/',
    // `/api/public/monitors/:numId`, the detail page's 90-day read. A prefix
    // because the path carries an id; the bare `/api/public/monitors` list is
    // matched exactly above.
    // `/api/public/monitors/:numId` 提供详情页 90 天数据；路径含 ID，使用前缀匹配，
    // 不含 ID 的 `/api/public/monitors` 列表已在上方精确匹配。
    '/api/public/monitors/',
    // `/api/recent/:uuid`, one node's latest reading.
    // `/api/recent/:uuid` 返回单个节点的最新观测值。
    '/api/recent/',
  ];
  const isPublic = STATIC_PUBLIC.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));

  if (isPublic) {
    await next();
    return;
  }

  c.header('cache-control', 'private, no-store');

  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (c.env.ADMIN_TOKEN && safeEqual(token, c.env.ADMIN_TOKEN)) {
    await next();
    return;
  }

  const { user } = await currentUser(c);
  if (user) {
    await next();
    return;
  }

  return c.json({ error: 'unauthorized' }, 401);
});

/** Hono applies middleware in registration order; management routes must follow the gate. / Hono 按注册顺序执行中间件；管理路由必须位于鉴权之后。 */
api.route('/', notifyRoutes);


api.route('/', agentRoutes);
api.route('/', presentationRoutes);
api.route('/', agentTaxonomyRoutes);
api.route('/', serverRoutes);

/** Group, tag and monitor writes use the same management gate. / 分组、标签和监控写入共用管理鉴权。 */
api.route('/', groupTagRoutes);
api.route('/', groupManagementRoutes);

api.route('/', monitorRoutes);

/** Public status projection; enumerate fields to keep monitor credentials private. / 公共状态数据显式列出字段，避免泄露监控凭据。 */
api.route('/', publicRoutes);

/** Agent WebSocket ingestion with per-machine path credentials. / Agent WebSocket 接入使用各机器的路径凭据。 */
/** Installer scripts and release binaries are served through the Agent download routes. / Agent 下载路由提供安装脚本和发布二进制文件。 */
api.route('/', agentTransportRoutes);

/** Queue a whitelisted command after checking the feature switch, Agent capability and liveness. / 检查功能开关、Agent 能力及在线状态后，将白名单命令入队。 */

api.route('/', themeRoutes);

api.route('/', jobRoutes);

api.route('/', overviewRoutes);

/** Return settings with form metadata and stored/default provenance; parsers stay server-side. / 返回设置、表单元数据及存储值或默认值来源；解析器保留在服务端。 */
api.route('/', settingsRoutes);
