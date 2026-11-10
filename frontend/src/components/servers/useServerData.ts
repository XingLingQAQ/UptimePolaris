import { requestJson } from '@/api/client';
import { ApiError } from '@/api/errors';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Resource<T> { path: string | null; data: T | null; error: unknown; refreshing: boolean; updatedAt: number | null }

/**
 * 自动轮询仅在标签页可见时运行；interval=0 暂停轮询，初次和手动请求仍可执行。
 * Poll automatically only while visible; interval=0 pauses polling, not initial or manual requests.
 * 刷新失败保留旧数据；401/403/404 清除旧数据，避免继续展示不可访问的对象。
 * Retain data after refresh failures; clear it on 401/403/404 to stop showing inaccessible objects.
 */
export function useServerData<T>(path: string | null, interval: number, refreshKey = 0) {
  const [state, setState] = useState<Resource<T>>({ path, data: null, error: null, refreshing: false, updatedAt: null });
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async (force = true) => {
    if (!path || request.current && !force) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState(previous => ({ path, data: previous.path === path ? previous.data : null, error: previous.path === path ? previous.error : null, refreshing: true, updatedAt: previous.path === path ? previous.updatedAt : null }));
    try {
      const data = await requestJson<T>(path, { signal: controller.signal });
      if (!controller.signal.aborted && request.current === controller) setState({ path, data, error: null, refreshing: false, updatedAt: Date.now() });
    } catch (error) {
      if (!controller.signal.aborted && request.current === controller) setState(previous => ({ ...previous, path, error, refreshing: false,
        data: error instanceof ApiError && [401, 403, 404].includes(error.status) ? null : previous.path === path ? previous.data : null }));
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [path]);
  useEffect(() => {
    void refresh();
    return () => { request.current?.abort(); request.current = null; };
  }, [refresh, refreshKey]);
  useEffect(() => {
    if (!interval || !path) return;
    const visible = () => { if (!document.hidden) void refresh(false); };
    const timer = window.setInterval(visible, interval);
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [interval, path, refresh]);
  return { ...(state.path === path ? state : { path, data: null, error: null, refreshing: false, updatedAt: null }), refresh };
}
