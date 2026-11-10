import { getPreview } from '@/lib/public-navigation';

export function getMonitorDetailPath(monitorId: number, pageId: string, search: string): string {
  const query = new URLSearchParams({ pageId });
  const preview = getPreview(search);
  if (preview) query.set('preview', preview);
  return `/monitor/${monitorId}?${query}`;
}
