import { useTheme } from 'next-themes';
import { useEffect, useState, type ReactNode } from 'react';

/** One shared toast host; load its renderer after mount or when a public toast is requested. / 共用提示容器；挂载后或公开提示被请求时加载渲染器。 */

type ToasterComponent = (props: import('sonner').ToasterProps) => ReactNode;

/** How long after mount the renderer is allowed to load. / 挂载后允许加载渲染器的延迟时间。 */
const IDLE_DELAY_MS = 1200;

export function ToastHost({ children }: { children?: ReactNode }) {
  const [Host, setHost] = useState<ToasterComponent | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void import('sonner').then((mod) => {
        if (!cancelled) setHost(() => mod.Toaster);
      });
    };
    // Wait before loading the renderer; use `requestIdleCallback` when available,
    // otherwise load after the timer. A busy page can delay the idle callback.
    // 延迟加载渲染器：支持时使用 `requestIdleCallback`，否则在定时器结束后加载；
    // 页面繁忙时空闲回调仍可能延后。
    const id = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(load);
      else load();
    }, IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, []);

  return (
    <>
      {children}
      {Host ? (
        <Host position="top-center" richColors theme={resolvedTheme === 'dark' ? 'dark' : 'light'} />
      ) : null}
    </>
  );
}

/** Shared helpers load the feedback router on demand. / 共用辅助函数按需加载反馈路由。 */

async function toastApi(): Promise<typeof import('sonner').toast> {
  const mod = await import('./toast');
  return mod.toast;
}

/** Start a toast a later `success`/`error` can update by id. / 创建提示，供后续 `success` 或 `error` 按 ID 更新。 */
export async function toastLoading(message: string): Promise<string | number | undefined> {
  return (await toastApi()).loading(message);
}

export async function toastSuccess(message: string, id?: string | number): Promise<void> {
  (await toastApi()).success(message, { id });
}

export async function toastError(message: string, id?: string | number): Promise<void> {
  (await toastApi()).error(message, { id });
}

export async function toastInfo(message: string): Promise<void> {
  (await toastApi()).info(message);
}
