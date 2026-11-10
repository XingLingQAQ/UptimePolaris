export type SetupDatabaseType = 'd1' | 'sqlite' | 'postgres';

export interface SetupDatabaseOptions {
  types: SetupDatabaseType[];
  defaultType: SetupDatabaseType;
  postgresConfigured: boolean;
  postgresUrlEditable: boolean;
}

export interface SetupDatabaseSelection {
  type: SetupDatabaseType;
  url?: string;
}

// Allow only setup dependencies; an admin token cannot open business APIs before setup.
// 仅放行初始化所需入口，业务 API 不因持有管理员令牌而提前开放。
export function isSetupEndpoint(method: string, path: string): boolean {
  if (method === 'POST' && path === '/api/auth/setup') return true;
  return (method === 'GET' || method === 'HEAD') &&
    ['/api/auth/session', '/api/capabilities', '/api/public/icon'].includes(path);
}

export function isSetupAsset(path: string): boolean {
  return path.startsWith('/assets/') || path === '/favicon.ico';
}

export function setupRequiredResponse(request: Request, error = 'setup_required'): Response | null {
  const path = new URL(request.url).pathname;
  if (isSetupEndpoint(request.method, path)) return null;
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (path === '/setup' || path === '/setup/' || isSetupAsset(path)) return null;
    if (path !== '/api' && !path.startsWith('/api/')) {
      return new Response(null, { status: 302, headers: { location: '/setup', 'cache-control': 'no-store' } });
    }
  }
  return Response.json({ error }, { status: 503, headers: { 'cache-control': 'private, no-store' } });
}
