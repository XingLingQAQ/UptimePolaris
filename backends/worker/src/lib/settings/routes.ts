/**
 * Site settings and the uploaded icon share one route because they share a
 * lifecycle: both are written from the settings page, both invalidate the
 * public cache, and both appear in the public config. Splitting them would put
 * the invalidation call in two places that must agree. Writes return the full
 * snapshot plus invalid keys so the console does not merge client-side.
 * 设置和图标共用路由与缓存失效；写入返回完整快照和非法键。
 */
export const settingsRoutes = new Hono<{ Bindings: Env }>();

import { Hono } from 'hono';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { migrateData, MigrationError, parseTargetUrl } from '../db/data-migration';
import { databaseType } from '../db/setup-control';
import { bytesToBase64, readBoundedBody } from '../http/binary';
import { settingsSQL } from '../db/sql/settings';
import { invalidateConfig } from '../monitor/store';
import { invalidatePublicCache } from '../public/cache';
import { clearSiteIcon, MAX_ICON_BYTES, readSiteIcon, validateIconUpload, writeSiteIcon } from './site-icon';
import { clearSetting, readAll, SETTING_KEYS, SPECS, writeSettings } from './store';
import { loadUsage } from './usage';

settingsRoutes.post('/api/admin/database-migration/:action', async (c) => {
  c.header('cache-control', 'private, no-store');
  const action = c.req.param('action');
  if (action !== 'preview' && action !== 'execute') return c.json({ error: 'invalid_request' }, 400);
  if (databaseType(c.env) !== 'd1' || !c.env.DB) return c.json({ error: 'source_unavailable' }, 409);
  let body: unknown;
  try {
    const bytes = await readBoundedBody(c.req.raw.body, 8192);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_request' }, 400);
  const data = body as { url?: unknown; confirmed?: unknown };
  if (action === 'execute' && data.confirmed !== true) return c.json({ error: 'invalid_request' }, 400);
  try {
    const url = parseTargetUrl(data.url);
    return c.json(await migrateData(c.env.DB, url, action === 'execute'));
  } catch (error) {
    if (error instanceof MigrationError) return c.json({ error: error.code }, 400);
    return c.json({ error: 'migration_failed' }, 503);
  }
});

settingsRoutes.get('/api/admin/settings', async (c) => {
  c.header('cache-control', 'private, no-store');
  const snapshot = await readAll(c.env);
  const db = getDB(c.env);
  const rows = await db
    .query<{ key: string }>(settingsSQL[db.type].load);
  const stored = new Set(rows.map((r) => r.key));

  return c.json({
    values: snapshot.values,
    invalid: snapshot.invalid,
    specs: SETTING_KEYS.map((key) => ({
      key,
      default: SPECS[key].default,
      stored: stored.has(key),
      kind: Array.isArray(SPECS[key].default) ? 'list' : typeof SPECS[key].default,
    })),
  });
});

/** Observed daily usage; `no-store` so the day boundary is never stale. / 每日用量观测；`no-store` 避免跨天缓存。 */
settingsRoutes.get('/api/admin/usage', async (c) => {
  c.header('cache-control', 'private, no-store');
  const now = Math.floor(Date.now() / 1000);
  return c.json(await loadUsage(c.env, now));
});

/** Apply a partial settings map atomically; invalid or unknown keys reject the entire request. / 原子应用部分设置映射；存在无效或未知键时拒绝整个请求。 */
settingsRoutes.put('/api/admin/settings', async (c) => {
  c.header('cache-control', 'private, no-store');
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) return c.json({ error: 'invalid_request' }, 400);
  // One request should not be able to write the whole registry by accident.
  // 避免单次请求意外写入整个设置注册表。
  if (entries.length > SETTING_KEYS.length) return c.json({ error: 'invalid_request' }, 400);

  const failures: Array<{ key: string; error: string }> = [];
  const values: Partial<Record<keyof typeof SPECS, unknown>> = {};
  for (const [key, value] of entries) {
    if (!Object.hasOwn(SPECS, key)) {
      failures.push({ key, error: 'unknown_key' });
      continue;
    }
    const parsed = SPECS[key as keyof typeof SPECS].parse(value);
    if (parsed === null) failures.push({ key, error: 'invalid_value' });
    else values[key as keyof typeof SPECS] = parsed;
  }
  if (failures.length > 0) return c.json({ error: 'invalid_settings', failures }, 400);

  try {
    await writeSettings(c.env, values);
  } catch {
    return c.json({ error: 'database_unavailable' }, 503);
  }

  return c.json({ ok: true, values: (await readAll(c.env)).values });
});

/** Delete the stored override so the setting inherits its declared default. / 删除已存储的覆盖值，使设置继承声明的默认值。 */
settingsRoutes.delete('/api/admin/settings/:key', async (c) => {
  c.header('cache-control', 'private, no-store');
  const key = c.req.param('key');
  if (!Object.hasOwn(SPECS, key)) return c.json({ error: 'unknown_key' }, 404);
  try {
    await clearSetting(c.env, key);
  } catch {
    return c.json({ error: 'database_unavailable' }, 503);
  }
  const { values } = await readAll(c.env);
  return c.json({ ok: true, value: values[key as keyof typeof SPECS] });
});

/** Management endpoint for the uploaded icon; public bytes are served by GET /api/public/icon. / 上传图标的管理端点；公开字节由 GET /api/public/icon 提供。 */
settingsRoutes.get('/api/admin/site-icon', async (c) => {
  c.header('cache-control', 'private, no-store');
  const icon = await readSiteIcon(c.env);
  if (!icon) return c.json({ uploaded: false });
  return c.json({
    uploaded: true,
    contentType: icon.contentType,
    byteSize: icon.byteSize,
    filename: icon.filename,
    updatedAt: icon.updatedAt,
    // The console renders a preview without a second request. An icon is at most
    // 256 KB, and this response is already behind authentication.
    // 控制台无需再次请求即可预览；图标最多 256 KB，且此响应已经过认证。
    dataUrl: `data:${icon.contentType};base64,${bytesToBase64(icon.bytes)}`,
  });
});

/** Accept a bounded raw image body; validate its bytes rather than trusting Content-Type. / 接收大小受限的原始图像请求体；验证字节内容，不依赖 Content-Type。 */
settingsRoutes.post('/api/admin/site-icon', async (c) => {
  c.header('cache-control', 'private, no-store');
  const length = Number(c.req.header('content-length') ?? '0');
  // Reject before reading when the header already says it is too big. A client
  // that omits or lies about the length is caught by the bounded read below.
  // 请求头已表明超限时，在读取前拒绝；省略长度或谎报长度的客户端会被下方有界读取捕获。
  if (Number.isFinite(length) && length > MAX_ICON_BYTES) {
    return c.json({ error: 'too_large', maxBytes: MAX_ICON_BYTES }, 413);
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readBoundedBody(c.req.raw.body, MAX_ICON_BYTES);
  } catch {
    return c.json({ error: 'too_large', maxBytes: MAX_ICON_BYTES }, 413);
  }
  const checked = validateIconUpload(bytes);
  if (!checked.ok) {
    const status = checked.error === 'too_large' ? 413 : 400;
    return c.json({ error: checked.error, maxBytes: MAX_ICON_BYTES }, status);
  }
  let filename: string | null;
  try { filename = decodeURIComponent(c.req.header('x-icon-filename') ?? '').slice(0, 200) || null; }
  catch { return c.json({ error: 'filename_invalid' }, 400); }
  const result = await writeSiteIcon(c.env, bytes, filename);
  if (!result.ok) return c.json({ error: result.error }, 503);
  // Evict the edge copy too, since the config body carries the icon URL. / 同时清除边缘缓存，因为配置正文含图标 URL。
  invalidateConfig();
  try { await invalidatePublicCache(caches.default, new URL(c.req.url).origin); } catch {}
  return c.json({
    ok: true,
    contentType: result.icon.contentType,
    byteSize: result.icon.byteSize,
    filename: result.icon.filename,
    updatedAt: result.icon.updatedAt,
  });
});

/** Remove the upload so the generated mark comes back. / 删除上传的图标，恢复生成的图标。 */
settingsRoutes.delete('/api/admin/site-icon', async (c) => {
  c.header('cache-control', 'private, no-store');
  const cleared = await clearSiteIcon(c.env);
  if (!cleared) return c.json({ error: 'database_unavailable' }, 503);
  invalidateConfig();
  try { await invalidatePublicCache(caches.default, new URL(c.req.url).origin); } catch {}
  return c.json({ ok: true, uploaded: false });
});
