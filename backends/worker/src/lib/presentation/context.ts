import type { MiddlewareHandler } from 'hono';
import type { Env, Monitor } from '../../types';
import type { PageKind } from '../../../../../shared/presentation';
import { currentUser } from '../auth/routes';
import { safeEqual } from '../auth/service';
import { loadPublicMonitors } from '../monitor/store';
import { resolvePage, type PageContext } from './store';

const contexts = new WeakMap<Request, Promise<PageContext>>();
export function requestPage(env: Env, request: Request): Promise<PageContext> {
  let context = contexts.get(request);
  if (!context) { context = resolvePage(env,new URL(request.url)); contexts.set(request,context); }
  return context;
}
export async function pageMonitors(env: Env, request: Request): Promise<Monitor[]> {
  const context = await requestPage(env,request);
  if (!context.enabled || !context.configured || context.kind !== 'monitor') return [];
  return loadPublicMonitors(env);
}
export const presentationScope: MiddlewareHandler<{ Bindings: Env }> = async (c,next) => {
  const url = new URL(c.req.url), path = url.pathname;
  const monitor = /^\/api\/(?:public\/(?:status(?:\/detail)?|monitors(?:\/[^/]+)?|agent\/detail\/[^/]+|monitor-icon)|recent\/[^/]+)$/.test(path);
  const agent = /^\/api\/public\/servers(?:\/[^/]+)?$/.test(path);
  const config = path === '/api/public/config' || path === '/api/public/theme';
  if (!monitor && !agent && !config) return next();
  const preview = url.searchParams.get('preview');
  if (preview !== null) {
    if (!['monitor','agent'].includes(preview)) return c.json({ error:'invalid_request' },400);
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i,'') ?? '';
    if (!(c.env.ADMIN_TOKEN && safeEqual(token,c.env.ADMIN_TOKEN)) && !(await currentUser(c)).user) return c.json({ error:'unauthorized' },401);
    contexts.set(c.req.raw,resolvePage(c.env,url,preview as PageKind));
    c.header('cache-control','private, no-store');
  }
  const context = await requestPage(c.env,c.req.raw);
  if (!config && (!context.enabled || !context.configured || agent && context.kind !== 'agent' || monitor && context.kind !== 'monitor')) return c.json({ error:'not_found' },404);
  if (monitor && path !== '/api/public/monitors' && path !== '/api/public/status') {
    const monitors = await pageMonitors(c.env,c.req.raw);
    if (path === '/api/public/monitor-icon') {
      const id = url.searchParams.get('id');
      if (!id || !/^\d+$/.test(id) || !monitors.some(m => m.type === 'http' && m.num_id === Number(id))) return c.json({ error:'not_found' },404);
    } else if (path.startsWith('/api/recent/') || path === '/api/public/status/detail') {
      const id = path.startsWith('/api/recent/') ? path.slice('/api/recent/'.length) : url.searchParams.get('id');
      if (path === '/api/public/status/detail' && !id) return c.json({ error: 'id required' }, 400);
      if (!id || !monitors.some(m => m.id === id)) return c.json({ error:'not_found' },404);
    } else {
      const number = path.match(/\/(?:monitors|agent\/detail)\/(\d+)$/)?.[1];
      if (!number || !monitors.some(m => m.num_id === Number(number))) return c.json({ error:'not_found' },404);
    }
  }
  await next();
  if (preview !== null) c.header('cache-control','private, no-store');
};
