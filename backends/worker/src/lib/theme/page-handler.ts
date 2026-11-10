import type { Env } from '../../types';
import { pageTheme } from './registry';
import { resolvePage } from '../presentation/store';
import { readVersionedThemeFile } from './storage';
import { publicMaintenance } from '../public/maintenance';
import { maintenancePage, maintenanceScript } from '../public/maintenance-page';
import { currentUser } from '../auth/routes';
import { safeEqual } from '../auth/service';

const PUBLIC_SHELL = /^\/(?:|monitor\/[^/]+|server\/[^/]+|status\/[^/]+)\/?$/;
/**
 * Paths that belong to the built-in SPA rather than to a theme.
 *
 * `/setup` is in this list because it is the one console page a *stranger* may
 * legitimately reach on a fresh deployment - before any account exists - so a
 * theme that happened to be active would otherwise serve its own markup for the
 * very page that creates the owner's account.
 * 这些路径属于内置 SPA，而非主题。`/setup` 是新部署尚无账户时陌生访客可以
 * 正常访问的唯一控制台页面；将它保留在此，避免活动主题覆盖创建所有者账户的页面。
 */
const RESERVED = /^\/(?:admin|login|setup|api)(?:\/|$)/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

function shellPath(path: string): boolean { return PUBLIC_SHELL.test(path) && !RESERVED.test(path); }

function safePrefix(path: string): { prefix: string; file: string } | null {
  if (!path.startsWith('/theme/')) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(path.slice('/theme/'.length)); } catch { return null; }
  const parts = decoded.split('/');
  if (parts.length < 6 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return null;
  const file = parts.slice(5).join('/');
  const prefix = parts.slice(0, 5).join('/');
  return file ? { prefix, file } : null;
}

function withBase(html: string, base: string, capabilities: string[], locale: string, headCode: string): string {
  const tag = '<base href="' + base + '">';
  const sdk = '<script defer src="/polaris-theme-sdk.js" data-capabilities="' + capabilities.join(' ') + '"></script>';
  const maintenance = '<script defer src="/polaris-maintenance.js" data-locale="' + locale.replace(/[^a-zA-Z-]/g, '') + '"></script>';
  html = html.replace(/<base\b[^>]*>/gi, '');
  const head = html.match(/<head\b[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + sdk + maintenance + headCode + html.slice(at);
  }
  const prefix = html.match(/^(?:\s*<!doctype[^>]*>)?\s*(?:<html\b[^>]*>)?/i)?.[0] ?? '';
  return prefix + '<head>' + tag + sdk + maintenance + headCode + '</head>' + html.slice(prefix.length);
}

async function builtin(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return new Response('built-in UI assets unavailable\n', { status: 404 });
  return env.ASSETS.fetch(request);
}

async function servePublicShell(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    if (url.searchParams.has('preview')) return builtin(request, env);
    const context = await resolvePage(env,url);
    if (!context.enabled || !context.configured) return builtin(request,env);
    const selected = await pageTheme(env,context.kind,context.page);
    if (!selected) return builtin(request,env);
    const { version, definition: manifest } = selected;
    const stored = await readVersionedThemeFile(env, version.prefix, manifest.entry);
    if (!stored) return builtin(request, env);
    const html = typeof stored.body === 'string' ? stored.body : await new Response(stored.body as BodyInit).text();
    const directory = manifest.entry.includes('/') ? manifest.entry.slice(0, manifest.entry.lastIndexOf('/') + 1) : '';
    const base = '/theme/' + version.prefix.split('/').map(encodeURIComponent).join('/') + '/' + directory.split('/').map(encodeURIComponent).join('/');
    return new Response(withBase(html, base, manifest.capabilities ?? [], context.page.locale, context.page.headCode ?? ''), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'theme_shell_failed', err: String(error) }));
    return builtin(request, env);
  }
}

export async function handlePageRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (url.pathname === '/polaris-maintenance.js') {
    return new Response(request.method === 'HEAD' ? null : maintenanceScript, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
  }
  if (url.pathname.startsWith('/theme/')) {
    const parsed = safePrefix(url.pathname);
    if (!parsed || !env.THEMES) return new Response('not found\n', { status: 404, headers: { 'cache-control': 'no-store' } });
    const stored = await readVersionedThemeFile(env, parsed.prefix, parsed.file);
    if (!stored) return new Response('not found\n', { status: 404, headers: { 'cache-control': 'no-store' } });
    return new Response(request.method === 'HEAD' ? null : stored.body, { status: 200, headers: { 'content-type': stored.contentType, 'cache-control': IMMUTABLE, 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' } });
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
  if (url.pathname === '/theme') return null;
  if (/^\/(?:admin|login|setup)(?:\/|$)/.test(url.pathname)) return builtin(request, env);
  const preview = url.searchParams.get('preview');
  if (shellPath(url.pathname) && (preview === 'monitor' || preview === 'agent')) {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const authorized = Boolean(env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) ||
      Boolean((await currentUser({ env, req: { header: (name) => request.headers.get(name) ?? undefined } })).user);
    if (authorized) {
      const response = await builtin(request, env);
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  }
  const shell = shellPath(url.pathname);
  const htmlNavigation = (request.headers.get('accept') ?? '').includes('text/html') && !/\.[^/]+$/.test(url.pathname);
  if (shell || htmlNavigation) {
    const state = await publicMaintenance(env);
    if (state.active) {
      if (url.pathname !== '/') return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } });
      const context = await resolvePage(env, url);
      return new Response(request.method === 'HEAD' ? null : maintenancePage(state, context.page.locale), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    }
    if (shell) return servePublicShell(request, env, url);
  }
  return null;
}
