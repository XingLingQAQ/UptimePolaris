import { Hono } from 'hono';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { themeSQL } from '../db/sql/themes';
import { requestPage } from '../presentation/context';
import { publicServersForPage } from '../presentation/servers';
import { resolvePage } from '../presentation/store';
import { loadPublicMonitors } from '../monitor/store';
import { invalidatePublicCache } from '../public/cache';
import { checkThemeUpdate, installFromUpload, installFromUrl, MAX_INSTALL_REQUEST_BYTES, readBoundedStream } from './install';
import { parseManifest } from './manifest';
import { getTheme, listThemes, pageTheme, removeTheme } from './registry';
import { themeVersionEntryAvailable } from './storage';

export const themeRoutes = new Hono<{ Bindings: Env }>();

function installFailureStatus(error: string): 400 | 409 | 413 | 502 | 503 {
  if (['no_storage', 'storage_write_failed', 'registry_write_failed'].includes(error)) return 503;
  if (error === 'download_failed') return 502;
  if (error === 'too_large' || error === 'package_too_large') return 413;
  if (error === 'theme_id_short_conflict' || error === 'theme_id_changed' || error === 'theme_busy') return 409;
  return 400;
}

themeRoutes.get('/api/public/theme', async c => {
  const context = await requestPage(c.env, c.req.raw);
  const selected = context.enabled && context.configured ? await pageTheme(c.env, context.kind, context.page) : null;
  return c.json(selected ? { id: selected.theme.id, short: selected.theme.short, version: selected.manifest.version, revision: selected.version.version, theme: selected.definition.id } : { id: null, short: null, version: null }, 200, { 'cache-control': 'no-store' });
});

themeRoutes.get('/api/themes', async c => {
  const db = getDB(c.env), storageReady = !!c.env.THEMES;
  const themes = await Promise.all((await listThemes(c.env)).map(async row => {
    const revisions = await db.query<{ version: string; prefix: string; manifest_json: string }>(themeSQL[db.type].versionsById, [row.id]);
    const versions = await Promise.all(revisions.map(async revision => {
      let parsed;
      try { parsed = parseManifest(JSON.parse(revision.manifest_json)); } catch { return null; }
      if (!parsed.ok || parsed.manifest.id !== row.id || parsed.manifest.short !== row.short) return null;
      const definitions = await Promise.all(parsed.manifest.themes.map(async definition => ({ ...definition, available: storageReady && await themeVersionEntryAvailable(c.env, revision.prefix, definition.entry) })));
      return { versionKey: revision.version, version: parsed.manifest.version, prefix: revision.prefix, themes: definitions };
    }));
    const supportedVersions = versions.filter(version => version !== null);
    return { id: row.id, short: row.short, name: row.name, version: row.version, description: row.description, author: row.author, sourceUrl: row.source_url, supported: supportedVersions.length > 0, versions: supportedVersions };
  }));
  return c.json({ themes, storageReady }, 200, { 'cache-control': 'no-store' });
});

themeRoutes.post('/api/themes/install', async c => {
  const contentType = c.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (['application/zip', 'application/octet-stream', 'application/x-zip-compressed'].includes(contentType ?? '')) {
    const result = await installFromUpload(c.env, c.req.raw.body, c.req.header('content-length'));
    return result.ok ? c.json(result, 200) : c.json({ error: result.error, message: result.message }, installFailureStatus(result.error));
  }
  let bytes: Uint8Array;
  try { bytes = await readBoundedStream(c.req.raw.body, MAX_INSTALL_REQUEST_BYTES); }
  catch { return c.json({ error: 'request_too_large' }, 413); }
  let body: { url?: unknown };
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_request' }, 400);
  if (typeof body.url !== 'string' || !body.url.trim()) return c.json({ error: 'url_required' }, 400);
  const result = await installFromUrl(c.env, body.url.trim());
  return result.ok ? c.json(result, 200) : c.json({ error: result.error, message: result.message }, installFailureStatus(result.error));
});

themeRoutes.get('/api/themes/:short/preview', async c => {
  const theme = await getTheme(c.env, c.req.param('short'));
  if (!theme) return c.json({ error: 'theme_not_found' }, 404);
  const versionKey = c.req.query('version'), themeId = c.req.query('theme');
  if (!versionKey || !themeId) return c.json({ error: 'invalid_request' }, 400);
  const db = getDB(c.env);
  const revision = await db.queryOne<{ version: string; prefix: string; manifest_json: string }>(themeSQL[db.type].version, [theme.id, versionKey]);
  if (!revision) return c.json({ error: 'theme_version_not_found' }, 404);
  let parsed;
  try { parsed = parseManifest(JSON.parse(revision.manifest_json)); } catch { return c.json({ error: 'manifest_unreadable' }, 409); }
  if (!parsed.ok || parsed.manifest.id !== theme.id || parsed.manifest.short !== theme.short) return c.json({ error: 'manifest_unreadable' }, 409);
  const definition = parsed.manifest.themes.find(item => item.id === themeId);
  if (!definition || !await themeVersionEntryAvailable(c.env, revision.prefix, definition.entry)) return c.json({ error: 'theme_unavailable' }, 409);
  const page = (await resolvePage(c.env, new URL(c.req.url), definition.target)).page;
  const active = page.theme?.short === theme.short && page.theme.version === versionKey && page.theme.theme === themeId;
  const saved = active ? page.themeOptions : {};
  const needsReferences = definition.options.some(option => option.type === 'monitor' || option.type === 'agent');
  const visible = new Set(needsReferences ? (definition.target === 'monitor' ? await loadPublicMonitors(c.env) : await publicServersForPage(c.env, page)).map(row => row.id) : []);
  const values = Object.fromEntries(definition.options.map(option => {
    const value = saved[option.key] ?? option.default ?? null;
    return [option.key, option.type === 'monitor' || option.type === 'agent' ? typeof value === 'string' && visible.has(value) ? value : null : value];
  }));
  return c.json({ id: theme.id, versionKey, prefix: revision.prefix, manifest: parsed.manifest, definition, values, headCode: active ? page.headCode ?? '' : '', contentHtml: active ? page.contentHtml ?? '' : '' }, 200, { 'cache-control': 'private, no-store' });
});

themeRoutes.get('/api/themes/:short/update-check', async c => {
  const theme = await getTheme(c.env, c.req.param('short'));
  if (!theme) return c.json({ error: 'theme_not_found' }, 404);
  if (!theme.source_url) return c.json({ available: false, current: theme.version, latest: null, reason: 'no_source_url' });
  const db = getDB(c.env);
  const versions = await db.query<{ digest: string; manifest_json: string }>(themeSQL[db.type].versionsById, [theme.id]);
  const current = versions.find(item => { try { const parsed = parseManifest(JSON.parse(item.manifest_json)); return parsed.ok && parsed.manifest.version === theme.version; } catch { return false; } });
  const result = await checkThemeUpdate(c.env, theme.source_url, theme.version, current?.digest ?? null, theme.id);
  if ('ok' in result) return c.json({ error: result.error, message: result.message }, 502);
  return c.json(result, 200, { 'cache-control': 'no-store' });
});

themeRoutes.delete('/api/themes/:short', async c => {
  const short = c.req.param('short'), result = await removeTheme(c.env, short);
  if (!result.ok) {
    if (result.deactivated) { try { await invalidatePublicCache(caches.default, new URL(c.req.url).origin); } catch { } }
    const status = result.error === 'theme_not_found' ? 404 : result.error === 'theme_delete_invalid_path' || result.error === 'theme_busy' ? 409 : 503;
    return c.json({ error: result.error }, status);
  }
  try { await invalidatePublicCache(caches.default, new URL(c.req.url).origin); } catch { }
  return c.json({ ok: true, short });
});
