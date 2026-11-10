export function internalErrorResponse(error: unknown, method: string, route?: string): Response {
  console.error(JSON.stringify({
    event: 'request_failed', method, route,
    name: error instanceof Error ? error.name : 'Error',
    // Frames locate the failure without logging exception text or credential-bearing URLs.
    // 使用堆栈帧定位故障，避免记录异常文本或含凭据的 URL。
    stack: error instanceof Error ? error.stack?.split('\n').filter(line => line.trimStart().startsWith('at ')).join('\n') : undefined,
  }));
  return Response.json({ error: 'internal_error' }, { status: 500, headers: { 'cache-control': 'private, no-store' } });
}
