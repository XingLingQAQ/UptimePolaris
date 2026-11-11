import { ApiError, SESSION_EXPIRED_EVENT, UnauthorizedError } from '@/api/errors';

/** 统一解析 JSON 和接口错误；调用方可通过 credentials 覆盖默认会话凭据。 / Parse JSON and API errors; callers can override session credentials. */
export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  // 仅指定的读取接口继承当前预览目标，管理写请求不附加此参数。
  // Only the listed read endpoints inherit the preview target; management writes do not add this parameter.
  const preview = new URLSearchParams(window.location.search).get('preview');
  if ((preview === 'monitor' || preview === 'agent') && /^\/api\/(?:public\/(?:config|theme|status|monitors|servers|agent\/detail|monitor-icon)|recent\/)/.test(path)) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set('preview', preview);
    path = url.pathname + url.search;
  }
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');

  let response: Response;
  let text: string;
  try {
    response = await fetch(path, { credentials: 'include', ...init, headers });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new ApiError('request_timeout', 0);
    if (error instanceof TypeError) throw new ApiError('network_error', 0);
    throw error;
  }

  let payload: Record<string, unknown> | unknown[] | undefined;
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') payload = parsed as typeof payload;
    } catch { /* HTTP errors retain their status even when a proxy returns HTML. / 即使代理返回 HTML，HTTP 错误仍保留状态码。 */ }
  }

  const body = payload && !Array.isArray(payload) ? payload : undefined;
  const code = typeof body?.error === 'string' ? body.error : 'request_failed';
  // 登录失败和匿名请求的 401 不应触发全局会话过期事件。 / A 401 for failed sign-in or an anonymous request must not expire the global session.
  if (response.status === 401 && code !== 'invalid_credentials' && code !== 'invalid_setup_credential') {
    if (init.credentials !== 'omit') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new UnauthorizedError();
  }
  if (!response.ok || body?.success === false) throw new ApiError(code, response.status, body);
  if (response.status === 204) return undefined as T;
  if (!payload) throw new ApiError('invalid_response', response.status);
  return payload as T;
}
