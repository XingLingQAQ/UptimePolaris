export const WORKER_SUBREQUEST_LIMIT = 50;
export const MAX_REDIRECTS = 3;

export class ExternalBudgetExceeded extends Error {
  constructor() { super('Worker external request budget exhausted'); }
}

/** 限制一次任务中的外部请求总数，重定向也各占一次。 / Limit external requests per job; each redirect also consumes one request. */
export class ExternalRequestBudget {
  private used = 0;

  reserve(): void {
    if (this.used >= WORKER_SUBREQUEST_LIMIT) throw new ExternalBudgetExceeded();
    this.used++;
  }

  get remaining(): number {
    return WORKER_SUBREQUEST_LIMIT - this.used;
  }
}

/** 按预算手动跟随有限次 HTTP 重定向。 / Follow a bounded number of HTTP redirects within the request budget. */
export async function budgetedFetch(
  input: string | URL,
  init: RequestInit = {},
  budget?: ExternalRequestBudget,
): Promise<Response> {
  let url = new URL(input);
  let method = init.method ?? 'GET';
  let body = init.body;
  let headers = new Headers(init.headers);
  for (let redirects = 0; ; redirects++) {
    budget?.reserve();
    let response: Response;
    try {
      response = await fetch(url, { ...init, method, body, headers: Object.fromEntries(headers.entries()), redirect: 'manual' });
    } catch (error) {
      if (redirects > 0) throw new Error('redirect request failed');
      throw error;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects >= MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => {});
      throw new Error('redirect limit exceeded');
    }
    const next = new URL(location, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      await response.body?.cancel().catch(() => {});
      throw new Error('unsupported redirect protocol');
    }
    if (next.origin !== url.origin) {
      // 跨源跳转不转发认证信息及其他自定义请求头。
      // Do not forward credentials or other custom headers across origins.
      headers = new Headers([...headers].filter(([name]) => name.toLowerCase() === 'accept' || name.toLowerCase() === 'user-agent'));
    }
    if (response.status === 303 && method !== 'HEAD' || (response.status === 301 || response.status === 302) && method === 'POST') {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    await response.body?.cancel().catch(() => {});
    url = next;
  }
}

export function isWorkerCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /worker external request budget exhausted|too many subrequests|subrequest quota|quota exceeded|proxy request failed, cannot connect to specified address|tcp loop detected|connections to port 25 prohibited/i.test(message);
}
