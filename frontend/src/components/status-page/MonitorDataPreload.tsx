import { publicApiUrl } from '@/api/public-url';

interface MonitorDataPreloadProps {
  pageId: string;
}

/**
 * Injects <link rel="preload"> hints so the browser fetches
 * /api/public/monitors in parallel with rendering,
 * before the client-side SWR hooks even mount.
 *
 * 注入 `<link rel="preload">` 提示，使浏览器在客户端 SWR Hook 挂载前开始请求数据。
 */
export function MonitorDataPreload({ pageId }: MonitorDataPreloadProps) {
  return (
    <>
      <link
        rel="preload"
        as="fetch"
        href={publicApiUrl('/api/public/monitors', pageId)}
        crossOrigin="use-credentials"
      />
    </>
  );
}
