import { RING_SIZE, type DayStat, type Env, type LiveState, type Monitor, type RingHeartbeat } from '../../types';
import { D1Adapter } from '../db/d1';
import { getDB } from '../db/factory';
import { databaseIdentity } from '../db/setup-control';
import { heartbeatSQL } from '../db/sql/heartbeat';
import { liveStateSQL } from '../db/sql/live-state';
import { monitorSQL } from '../db/sql/monitors';
import { mergeDay } from './daily-stats';
import { readSetting } from '../settings/store';

/** The last heartbeat of one push monitor, as `push_heartbeats` stores it. / `push_heartbeats` 中存储的单个 Push 监控最新心跳。 */
export interface PushHeartbeat {
  ts: number;
  status: number;
  msg: string;
  ping: number;
}

const CONFIG_TTL_MS = 60_000;
const LIVE_TTL_MS = 5_000;

/** Isolate-local caches; writes invalidate this isolate, while other isolates refresh after the TTL. / isolate 本地缓存；写入使当前缓存失效，其他 isolate 在 TTL 后刷新。 */
let configCache: { at: number; target: string | D1Database; monitors: Monitor[] } | null = null;
let liveCache: { at: number; target: string | D1Database; state: LiveState } | null = null;

export function invalidateConfig(): void {
  configCache = null;
}

export function invalidateLive(): void {
  liveCache = null;
}

/** Active storage rows for checks and public projections; public endpoints must select safe response fields. / 供检查和公共数据使用的启用记录；公共端点必须选择安全的响应字段。 */
export async function loadMonitors(env: Env): Promise<Monitor[]> {
  const now = Date.now();
  if (configCache && configCache.target === databaseIdentity(env) && now - configCache.at < CONFIG_TTL_MS) return configCache.monitors;

  const db = getDB(env);
  const rows = await db.query<Monitor>(monitorSQL[db.type].listActive);

  configCache = { at: now, target: databaseIdentity(env), monitors: rows };
  return configCache.monitors;
}

/** Uncached storage rows, including paused monitors, for authenticated management views. / 供认证管理界面使用的未缓存记录，包含已暂停的监控。 */
export async function loadAllMonitors(env: Env): Promise<Monitor[]> {
  const db = getDB(env);
  return db.query<Monitor>(monitorSQL[db.type].listAll);
}

export async function loadPublicMonitors(env: Env): Promise<Monitor[]> {
  return getDB(env).query<Monitor>('SELECT * FROM monitors WHERE active=1 AND is_public=1 ORDER BY created_at');
}

/** One row holds the live status for every monitor. / 一行保存所有监控的实时状态。 */
export async function loadLive(env: Env): Promise<LiveState> {
  const now = Date.now();
  if (liveCache && liveCache.target === databaseIdentity(env) && now - liveCache.at < LIVE_TTL_MS) return liveCache.state;
  return loadLiveFresh(env);
}

/** Bypass the isolate cache when scheduling checks from observation timestamps. / 按观测时间安排检查时绕过 isolate 缓存。 */
export async function loadLiveFresh(env: Env): Promise<LiveState> {
  const db = getDB(env);
  const row = await db.queryOne<{ json: string }>(liveStateSQL[db.type].read, ['all']);

  let state: LiveState = {};
  if (row?.json) {
    try {
      state = JSON.parse(row.json) as LiveState;
    } catch {
      state = {};
    }
  }
  liveCache = { at: Date.now(), target: databaseIdentity(env), state };
  return state;
}

export async function saveLive(env: Env, state: LiveState): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  await db.execute(liveStateSQL[db.type].upsert, ['all', JSON.stringify(state), now]);

  liveCache = { at: Date.now(), target: databaseIdentity(env), state };
}

/** Read daily history in chunks of at most 80 monitor IDs. / 分批读取每日历史，每批最多 80 个监控 ID。 */
export async function loadUptime(
  env: Env,
  ids: string[],
): Promise<Map<string, DayStat[]>> {
  const out = new Map<string, DayStat[]>();
  if (ids.length === 0) return out;

  const db = getDB(env);
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db.query<{ monitor_id: string; days_json: string }>(
      monitorSQL[db.type].uptimeForIds(placeholders),
      batch,
    );
    for (const row of rows) {
      try {
        out.set(row.monitor_id, JSON.parse(row.days_json) as DayStat[]);
      } catch {
        out.set(row.monitor_id, []);
      }
    }
  }
  return out;
}

/** Merge one day into a monitor's history. One row read + one row written. / 将一天的数据合并进监控历史，读取一行并写入一行。 */
export async function upsertDay(
  env: Env,
  monitorId: string,
  day: DayStat,
): Promise<void> {
  const db = getDB(env);
  const row = await db.queryOne<{ days_json: string }>(
    monitorSQL[db.type].uptimeDaysForOne,
    [monitorId],
  );

  let existing: DayStat[] = [];
  if (row?.days_json) {
    try {
      existing = JSON.parse(row.days_json) as DayStat[];
    } catch {
      existing = [];
    }
  }

  const existingDay = existing.find((entry) => entry.d === day.d);
  const source = day.exact === true
    ? day
    : existingDay?.exact === true || existingDay?.avg === null && day.avg !== null
      ? existingDay
      : day;
  const preserved = source.exact === true
    ? { ...source, avg: source.avg ?? existingDay?.avg ?? null }
    : source;
  const retentionDays = await readSetting(env, 'retention.availabilityDays');
  const merged = mergeDay(existing, preserved).slice(-retentionDays);
  const now = Math.floor(Date.now() / 1000);

  await db.execute(monitorSQL[db.type].uptimeUpsert, [monitorId, JSON.stringify(merged), now]);
}

/** Read recent history in chunks of at most 80 IDs; each monitor stores its ring in one row. / 分批读取近期历史，每批最多 80 个 ID；每个监控用一行保存环形数据。 */
export async function loadHeartbeats(
  env: Env,
  ids: string[],
): Promise<Map<string, RingHeartbeat[]>> {
  const out = new Map<string, RingHeartbeat[]>();
  if (ids.length === 0) return out;

  const db = getDB(env);
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db.query<{ id: string; json: string }>(
      heartbeatSQL[db.type].ringForIds(placeholders),
      batch,
    );
    for (const row of rows) {
      try {
        out.set(row.id, JSON.parse(row.json) as RingHeartbeat[]);
      } catch {
        out.set(row.id, []);
      }
    }
  }
  return out;
}

/** Append observations for affected monitors and trim each ring before writing. / 为受影响的监控追加观测值，并在写入前裁剪各环形缓冲区。 */
export async function saveHeartbeats(
  env: Env,
  fresh: Map<string, RingHeartbeat>,
): Promise<void> {
  const writes = await prepareHeartbeatWrites(env, fresh);
  if (writes.length === 0) return;
  await getDB(env).commit(writes);
}

export async function prepareHeartbeatWrites(
  env: Env,
  fresh: Map<string, RingHeartbeat>,
): Promise<{ sql: string; params: unknown[] }[]> {
  if (fresh.size === 0) return [];

  const ids = [...fresh.keys()];
  const existing = await loadHeartbeats(env, ids);
  const now = Math.floor(Date.now() / 1000);

  const db = getDB(env);
  const statements: { sql: string; params: unknown[] }[] = [];
  for (const [id, hb] of fresh) {
    const prev = existing.get(id) ?? [];
    const merged = mergeHeartbeatRing(prev, hb);
    statements.push({
      sql: heartbeatSQL[db.type].ringUpsert,
      params: [id, JSON.stringify(merged), now],
    });
  }
  return statements;
}

export async function prepareAvailabilityDayWrites(
  env: Env,
  completed: Map<string, DayStat>,
  now: number,
): Promise<{ sql: string; params: unknown[] }[]> {
  if (completed.size === 0) return [];
  const db = getDB(env);
  const retentionDays = await readSetting(env, 'retention.availabilityDays');
  const ids = [...completed.keys()];
  const existing = new Map<string, DayStat[]>();
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db.query<{ monitor_id: string; days_json: string }>(
      monitorSQL[db.type].uptimeForIds(placeholders), batch,
    );
    for (const row of rows) {
      try { existing.set(row.monitor_id, JSON.parse(row.days_json) as DayStat[]); }
      catch { existing.set(row.monitor_id, []); }
    }
  }
  return [...completed].map(([monitorId, day]) => {
    const days = existing.get(monitorId) ?? [];
    const previous = days.find((entry) => entry.d === day.d);
    const source = day.exact === true
      ? day
      : previous?.exact === true || previous?.avg === null && day.avg !== null
        ? previous
        : day;
    const merged = mergeDay(days, { ...source, avg: source.avg ?? previous?.avg ?? null }).slice(-retentionDays);
    return { sql: monitorSQL[db.type].uptimeUpsert, params: [monitorId, JSON.stringify(merged), now] };
  });
}

function mergeHeartbeatRing(previous: RingHeartbeat[], heartbeat: RingHeartbeat): RingHeartbeat[] {
  return [...previous.filter((point) => point.t !== heartbeat.t), heartbeat].slice(-RING_SIZE);
}

/** Load all Push heartbeats in one query; query failures return an empty map. / 一次查询加载所有 Push 心跳；查询失败返回空映射。 */
export async function loadPushHeartbeats(
  env: Env,
): Promise<Map<string, PushHeartbeat>> {
  const out = new Map<string, PushHeartbeat>();

  const db = getDB(env);
  let rows: { monitor_id: string; ts: number; status: number; msg: string; ping: number }[];
  try {
    rows = await db.query<{
      monitor_id: string;
      ts: number;
      status: number;
      msg: string;
      ping: number;
    }>(heartbeatSQL[db.type].pushAll);
  } catch {
    return out;
  }

  for (const row of rows) {
    out.set(row.monitor_id, {
      ts: row.ts,
      status: row.status,
      msg: row.msg,
      ping: row.ping,
    });
  }
  return out;
}

/** Read telemetry from the adapter instance that executed the query. / 从执行查询的适配器实例读取遥测数据。 */
export function lastD1Meta(db: unknown): D1Meta | undefined {
  return db instanceof D1Adapter ? db.lastMeta : undefined;
}

/** Log query row counts and duration for development profiling. / 记录查询行数和耗时，供开发时分析性能。 */
export function logMeta(label: string, meta: D1Meta | undefined): void {
  if (!meta) return;
  const { rows_read, rows_written, duration } = meta;
  console.log(
    JSON.stringify({ label, rows_read, rows_written, ms: Number(duration?.toFixed?.(2) ?? duration) }),
  );
}
