import { Hono } from 'hono';
import { PAGE_KINDS, parsePresentation, type PresentationConfig } from '../../../../../shared/presentation';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { pageTheme, validatePageTheme } from '../theme/registry';
import { loadPresentation, savePresentation } from './store';

export const presentationRoutes = new Hono<{ Bindings: Env }>();
async function pruneReferences(env: Env, config: PresentationConfig): Promise<PresentationConfig> {
  const result = structuredClone(config), db = getDB(env);
  for (const kind of PAGE_KINDS) {
    const page = result.pages[kind];
    const selected = await pageTheme(env, kind, page);
    for (const option of selected?.definition.options ?? []) {
      if (option.type !== 'monitor' && option.type !== 'agent') continue;
      const value = page.themeOptions[option.key];
      if (typeof value !== 'string') continue;
      const table = option.type === 'agent' ? 'agents' : 'monitors';
      if (!await db.queryOne(`SELECT id FROM ${table} WHERE id=${db.type === 'postgres' ? '$1' : '?'}`, [value])) delete page.themeOptions[option.key];
    }
  }
  return result;
}
presentationRoutes.get('/api/admin/presentation', async c => {
  const state = await loadPresentation(c.env);
  return c.json({ ...state, config: await pruneReferences(c.env, state.config) }, 200, { 'cache-control': 'private, no-store' });
});
presentationRoutes.put('/api/admin/presentation', async c => {
  const body = await c.req.json().catch(() => null);
  const config = parsePresentation(body?.config);
  if (!config || typeof body.revision !== 'string' || Object.keys(body).some(key=>!['config','revision'].includes(key))) return c.json({ error: 'invalid_presentation' }, 400);
  const previous = await loadPresentation(c.env);
  for (const kind of PAGE_KINDS) {
    const page = config.pages[kind];
    const old = previous.config.pages[kind].theme;
    if (old?.short !== page.theme?.short || old?.version !== page.theme?.version || old?.theme !== page.theme?.theme) {
      delete page.headCode;
      delete page.contentHtml;
    }
    if (!await validatePageTheme(c.env, kind, page)) return c.json({ error: 'theme_unavailable', page: kind }, 409);
  }
  if (!await savePresentation(c.env, config, body.revision)) return c.json({ error: 'presentation_conflict' }, 409);
  return c.json(await loadPresentation(c.env));
});

presentationRoutes.get('/api/admin/presentation/domains', async c => {
  if (!c.env.CF_ACCOUNT_ID || !c.env.CF_API_TOKEN) return c.json({ available: false, reason: 'credentials_missing', domains: [] });
  const { config } = await loadPresentation(c.env);
  const service = c.req.query('service') ?? config.workerService;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(service)) return c.json({ error: 'invalid_service' }, 400);
  try {
    const domains: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.env.CF_ACCOUNT_ID)}/workers/domains?page=${page}&per_page=100`, { headers: { authorization: `Bearer ${c.env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) return c.json({ available: false, reason: response.status === 403 ? 'permission_denied' : 'request_failed', domains: [] });
      const data = await response.json() as { success: boolean; result: { hostname: string; service: string }[]; result_info?: { total_pages: number } };
      if (!data.success || !Array.isArray(data.result)) throw new Error('invalid_response');
      domains.push(...data.result.filter(row => row.service === service).map(row => row.hostname));
      if (page >= (data.result_info?.total_pages ?? 1)) return c.json({ available: true, domains: [...new Set(domains)], service });
    }
    return c.json({ available: false, reason: 'too_many_domains', domains: [] });
  } catch { return c.json({ available: false, reason: 'request_failed', domains: [] }); }
});
