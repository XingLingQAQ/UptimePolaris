import type { Env } from '../../types';

export async function pageErrorResponse(request: Request, env: Env, response: Response): Promise<Response> {
  const path = new URL(request.url).pathname;
  const navigation = request.headers.get('sec-fetch-mode') === 'navigate' ||
    (request.headers.get('accept') ?? '').includes('text/html');
  if (!env.ASSETS || !navigation || !['GET', 'HEAD'].includes(request.method) ||
    ![404, 500, 502, 503, 504].includes(response.status) ||
    /^\/(?:api|theme|agent)(?:\/|$)/.test(path) || /\.[^/]+$/.test(path)) return response;

  const status = response.status === 404 ? 404 : response.status === 500 ? 500 : 503;
  try {
    const url = new URL('/' + status, request.url);
    const page = await env.ASSETS.fetch(new Request(url, { method: request.method }));
    if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('cache-control', 'private, no-store');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : page.body, { status: response.status, headers });
  } catch {
    return response;
  }
}
