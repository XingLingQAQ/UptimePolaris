/** 手动触发周期探测和历史同步的管理接口。 / Management endpoints for manually triggering periodic checks and history synchronization. */
export const jobRoutes = new Hono<{ Bindings: Env }>();

import { Hono } from 'hono';
import type { Env } from '../../types';
import { loadLive } from '../monitor/store';
import { runSync } from './daily-sync';
import { runTick } from './tick';

jobRoutes.post('/api/cron/sync', async (c) => {
  const r = await runSync(c.env);
  return c.json(r);
});

/** Run a check cycle through the management API. / 通过管理 API 执行一次检查周期。 */
jobRoutes.post('/api/cron/tick', async (c) => {
  const started = Date.now();
  const tick = await runTick(c.env, Math.floor(started / 1000));
  const live = await loadLive(c.env);
  return c.json({
    ok: true,
    tick: tick.status,
    ...(tick.status === 'skipped' ? { skip_reason: tick.reason } : {}),
    ms: Date.now() - started,
    monitors: Object.keys(live).length,
    status: live,
  });
});
