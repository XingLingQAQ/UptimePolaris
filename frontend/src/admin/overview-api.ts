import { requestJson as request } from '../api/client';
import type { OverviewCounts, OverviewMonitor } from './monitors/types';
import type { AdminEvent } from './overview-types';

export const overviewApi = {
  /** Overview includes live state and paused monitors in one response. / 概览响应同时包含实时状态和已暂停的监控项。 */
  overview: () =>
    request<{
      monitors: OverviewMonitor[];
      counts: OverviewCounts;
      now: number;
      /** Configured defaults displayed by the create form. / 创建表单显示的配置默认值。 */
      defaults?: { interval_sec: number; timeout_ms: number };
    }>('/api/overview'),
  listEvents: (limit = 50, cursor?: string | null, signal?: AbortSignal) =>
    request<{ events: AdminEvent[]; nextCursor: string | null }>(`/api/events?limit=${limit}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`, { signal }),
};
