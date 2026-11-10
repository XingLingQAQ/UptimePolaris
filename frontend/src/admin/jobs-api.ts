import type { SyncResult } from '../../../shared/contracts';
import { requestJson as request } from '../api/client';

export const jobsApi = {
  /** Run one check cycle now, for every due monitor. / 立即对所有到期监控项执行一轮检查。 */
  runTick: () => request<{
    ok: true;
    tick: 'completed' | 'skipped';
    skip_reason?: 'leased' | 'completed' | 'lease_lost';
    ms: number;
    monitors: number;
  }>('/api/cron/tick', { method: 'POST' }),
  /** Roll Analytics Engine into D1 (normally a daily cron). / 将 Analytics Engine 数据汇总到 D1（通常每日定时执行）。 */
  runSync: () => request<SyncResult>('/api/cron/sync', { method: 'POST' }),
};
