import { isActiveProbeType } from '../../../../../shared/probe-capabilities';
/** 控制台总览与事件列表接口。 / Console overview and event list endpoints. */
export const overviewRoutes = new Hono<{ Bindings: Env }>();

import { Hono } from 'hono';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { eventsSQL } from '../db/sql/events';
import { loadMonitorTags } from '../group/tags';
import { getProbeSourceState } from '../public/probe-source';
import { readAll } from '../settings/store';
import { clampInteger } from '../util';
import { overallAvailability } from './daily-stats';
import { lastD1Meta, loadAllMonitors, loadHeartbeats, loadLive, loadPushHeartbeats, loadUptime, logMeta } from './store';

overviewRoutes.get('/api/events', async (c) => {
  c.header('cache-control', 'private, no-store');
  const requested = Number(c.req.query('limit') ?? 50);
  if (!Number.isInteger(requested)) return c.json({ error: 'invalid_limit' }, 400);
  const limit = clampInteger(requested, 1, 200);
  const before = c.req.query('before');
  const cursor = before === undefined ? null : /^(\d+):(\d+)$/.exec(before);
  if (before !== undefined && (!cursor || !Number.isSafeInteger(Number(cursor[1])) || Number(cursor[1]) < 0 || !Number.isSafeInteger(Number(cursor[2])) || Number(cursor[2]) < 1)) return c.json({ error: 'invalid_cursor' }, 400);
  const db = getDB(c.env);
  const rows = await db.query<Record<string, unknown>>(cursor ? eventsSQL[db.type].listBefore : eventsSQL[db.type].listRecent,
    cursor ? [Number(cursor[1]), Number(cursor[2]), limit + 1] : [limit + 1]);
  logMeta('events', lastD1Meta(db));
  const events = rows.slice(0, limit).map((row) => ({ ...row, id: Number(row.id), created_at: Number(row.created_at) }));
  const last = events.at(-1);
  return c.json({ events, nextCursor: rows.length > limit && last ? `${last.created_at}:${last.id}` : null });
});

/** Admin overview includes paused monitors, which the public status feed omits. / 管理总览包含已暂停的监控，公共状态数据则省略它们。 */
overviewRoutes.get('/api/overview', async (c) => {
  const monitors = await loadAllMonitors(c.env);
  const live = await loadLive(c.env);
  const history = await loadUptime(c.env, monitors.map((m) => m.id));
  const heartbeats = await loadHeartbeats(c.env, monitors.map((m) => m.id), live);
  const pushHeartbeats = monitors.some((m) => m.type === 'push') ? await loadPushHeartbeats(c.env) : new Map();

  // One query for every monitor's tags, not one per row - the same reason
  // `/api/monitors` attaches them this way, and this endpoint is the console's
  // single round trip so it is polled at least as often.
  // 一次查询获取所有监控的标签，而非逐行查询；`/api/monitors` 也采用此方式。
  // 此端点是控制台的单次往返请求，轮询频率至少与之相同。
  const tags = await loadMonitorTags(c.env, monitors.map((m) => m.id));
  const db = getDB(c.env);
  const sourceRows = await db.query<Record<string, unknown>>(db.type === 'postgres'
    ? "SELECT m.id, m.name, m.active, m.options_json, ml.version, ml.probe_capabilities, ml.reported_at, ml.report_interval_secs FROM agents m LEFT JOIN machine_live ml ON ml.agent_id=m.id WHERE 1=1"
    : "SELECT m.id, m.name, m.active, m.options_json, ml.version, ml.probe_capabilities, ml.reported_at, ml.report_interval_secs FROM agents m LEFT JOIN machine_live ml ON ml.agent_id=m.id WHERE 1=1");
  const sourceById = new Map(sourceRows.map((row) => [String(row.id), row]));
  const now = Math.floor(Date.now() / 1000);

  const counts = { total: monitors.length, up: 0, warn: 0, down: 0, pending: 0, paused: 0 };

  const rows = monitors.map((m) => {
    const days = history.get(m.id) ?? [];
    const entry = live[m.id];

    /** Null means no completed observation; a new monitor is not an outage. / Null 表示尚无完成的观测；新监控不应视为故障。 */
    const st = entry && entry.ts > 0 ? entry.st : null;

    // A paused monitor is counted as paused and nothing else; folding it into
    // "down" would make pausing a monitor look like an outage.
    // 已暂停的监控只计入暂停；若计入 "down"，暂停会被误认为故障。
    if (!m.active) counts.paused++;
    else if (st === 4) counts.pending++;
    else if (st === 2) counts.warn++;
    else if (st === 1) counts.up++;
    else if (st === 0) counts.down++;
    // st === null: never checked, so it belongs to no bucket yet.
    // st === null 表示从未检查，暂不计入任何类别。

    return {
      ...m,
      st,
      msg: entry?.msg ?? '',
      v: entry?.v ?? 0,
      checked_at: entry?.ts ?? 0,
      ...(m.type === 'push' ? { push_last_received_at: pushHeartbeats.get(m.id)?.ts ?? null } : {}),
      /** Tags come from the join table; group_id is already on the monitor row. / 标签来自关联表；group_id 已在监控记录中。 */
      tags: tags.get(m.id) ?? [],
      ...(isActiveProbeType(m.type) ? getProbeSourceState(m, entry, sourceById, now) : {}),
      /** Keep add-on status and expiry independent of primary latency. / 附加检查状态和到期时间独立于主检查延迟。 */
      ...(entry?.ssl ? { ssl: entry.ssl } : {}),
      ...(entry?.domain ? { domain: entry.domain } : {}),
      ...(entry?.dns ? { dns: entry.dns } : {}),
      /** 0-100 over the whole retained history. / 基于全部保留历史的 0–100 数值。 */
      uptime: Math.round(overallAvailability(days) * 10000) / 100,
      /** False until at least one day has been rolled up. / 至少完成一天的汇总前为 false。 */
      has_history: days.length > 0,
      /** Limit each overview row to 90 daily rollups; storage retains up to 400 days. / 每条总览最多返回 90 天的汇总；存储最多保留 400 天。 */
      days: days.slice(-90),
      /** Raw recent observations, including Agent monitors, for the per-check rail. / 近期原始观测值（含 Agent 监控），用于逐次检查状态条。 */
      ring: (heartbeats.get(m.id) ?? []).map((point) => m.type === 'push' ? { ...point, ms: null } : point),
    };
  });

  /** Expose configured monitor defaults with the overview used by the create form. / 随总览返回创建表单使用的已配置监控默认值。 */
  const settingValues = (await readAll(c.env)).values;
  return c.json({
    monitors: rows,
    counts,
    now: Math.floor(Date.now() / 1000),
    defaults: {
      interval_sec: settingValues['monitor.defaultIntervalSec'] as number,
      timeout_ms: settingValues['monitor.defaultTimeoutMs'] as number,
    },
  });
});
