import type { Env, Heartbeat, RingHeartbeat } from '../types';
import type { HistoryResult } from '../../../../shared/contracts';

export const AE_POINT_LIMIT = 250;
export const ANALYTICS_DATASET = 'events.analyticsEngine."uptime_heartbeats"';
interface QueryState {
  cached: Map<string, { expires: number; rows: Record<string, unknown>[] }>;
  pending: Map<string, Promise<Record<string, unknown>[]>>;
}
const queryStates = new WeakMap<AnalyticsSQLBinding, QueryState>();

export interface AeRow {
  idx: string;
  total: number;
  up: number;
  warn: number;
  avg: number | null;
}

export function analyticsReadable(env: Env): boolean {
  return Boolean(env.UPTIME && env.ANALYTICS_SQL);
}

export async function queryAnalytics(
  env: Env,
  sql: string,
  params: AnalyticsSQLQuery['params'] = {},
  cacheSeconds = 0,
): Promise<Record<string, unknown>[]> {
  const binding = env.ANALYTICS_SQL;
  if (!analyticsReadable(env) || !binding) throw new Error('Analytics SQL binding is not configured');
  let state = queryStates.get(binding);
  if (!state) {
    state = { cached: new Map(), pending: new Map() };
    queryStates.set(binding, state);
  }
  const key = JSON.stringify([sql, params]);
  const cached = state.cached.get(key);
  if (cacheSeconds > 0 && cached && cached.expires > Date.now()) return cached.rows;
  const pending = state.pending.get(key);
  if (pending) return pending;
  const request = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        binding.query({ query: sql, params }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Analytics SQL query timed out')), 10_000);
        }),
      ]);
      if (!result || !Array.isArray(result.data) || result.data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw new Error('Analytics SQL returned an invalid response');
      }
      const rows = result.data;
      if (cacheSeconds > 0) {
        if (state.cached.size >= 64) state.cached.delete(state.cached.keys().next().value!);
        state.cached.set(key, { expires: Date.now() + cacheSeconds * 1000, rows });
      }
      return rows;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  })();
  state.pending.set(key, request);
  try { return await request; }
  finally { state.pending.delete(key); }
}

export async function readAnalyticsHistory<T>(env: Env, read: () => Promise<{ points: T[]; sampled: boolean }>): Promise<HistoryResult<T>> {
  if (!analyticsReadable(env)) return { status: 'unconfigured', points: [], sampled: false };
  try { return { status: 'ready', ...await read() }; }
  catch (error) {
    console.error(JSON.stringify({ event: 'history_query_failed', err: String(error) }));
    return { status: 'unavailable', points: [], sampled: false };
  }
}

export function dayBounds(day: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Invalid day key format: ${day}`);
  const start = Date.parse(`${day}T00:00:00Z`) / 1000;
  if (!Number.isFinite(start) || new Date(start * 1000).toISOString().slice(0, 10) !== day) throw new Error(`Invalid day: ${day}`);
  return { start, end: start + 86400 };
}

const MONITOR_OBSERVED_AT = 'if(double4 > 0, double4, toUnixTimestamp(timestamp))';
const MONITOR_POINTS = "blob3 NOT IN ('agent_report', 'agent_summary')";

export async function queryDaily(env: Env, day: string): Promise<Map<string, AeRow>> {
  const { start, end } = dayBounds(day);
  const rows = await queryAnalytics(env, `SELECT index1 AS idx,
    COUNT() AS total,
    countIf(double2 IN (1, 4)) AS up,
    countIf(double2 = 2) AS warn,
    avgIf(double1, double2 IN (1, 2)) AS avg,
    countIf(double2 IN (1, 2)) AS latency_count
    FROM ${ANALYTICS_DATASET}
    WHERE timestamp >= $ingestedSince
      AND ${MONITOR_OBSERVED_AT} >= $start AND ${MONITOR_OBSERVED_AT} < $end
      AND ${MONITOR_POINTS}
    GROUP BY idx`, { ingestedSince: new Date((start - 86400) * 1000).toISOString(), start, end });
  return new Map(rows.map(row => [String(row.idx), {
    idx: String(row.idx), total: Number(row.total) || 0, up: Number(row.up) || 0,
    warn: Number(row.warn) || 0, avg: row.avg == null || Number(row.latency_count) === 0 ? null : Number(row.avg),
  }]));
}

export function queryMonitorHistory(env: Env, id: string, since: number, now: number): Promise<HistoryResult<RingHeartbeat>> {
  const end = Math.floor(now / 60) * 60 + 60;
  const start = Math.max(end - 90 * 86400, Math.floor(since / 60) * 60);
  return readAnalyticsHistory(env, async () => {
    const rows = await queryAnalytics(env, `SELECT ${MONITOR_OBSERVED_AT} AS t,
      argMax(double2, timestamp) AS up, argMax(double1, timestamp) AS ms,
      APPROX_MAX("sampleInterval") AS sample_interval
      FROM ${ANALYTICS_DATASET}
      WHERE index1 = $id AND ${MONITOR_POINTS}
        AND timestamp >= $ingestedSince
        AND ${MONITOR_OBSERVED_AT} >= $start AND ${MONITOR_OBSERVED_AT} < $end
      GROUP BY t ORDER BY t DESC LIMIT 100`, { id, ingestedSince: new Date((start - 86400) * 1000).toISOString(), start, end }, 60);
    const points = rows.map(row => ({ t: Number(row.t), up: Number(row.up),
      ms: Number(row.up) === 1 || Number(row.up) === 2 ? Number(row.ms) : null,
    })).filter(point => Number.isFinite(point.t) && [0, 1, 2, 4].includes(point.up) && (point.ms === null || Number.isFinite(point.ms)))
      .sort((a, b) => a.t - b.t);
    return { points, sampled: rows.some(row => Number(row.sample_interval) > 1) };
  });
}

export class AnalyticsWriter {
  private written = 0;

  constructor(private env: Env) {}

  write(point: Parameters<AnalyticsEngineDataset['writeDataPoint']>[0]): boolean {
    if (!this.env.UPTIME || this.written >= AE_POINT_LIMIT) return false;
    this.written++;
    this.env.UPTIME.writeDataPoint(point);
    return true;
  }
}

export function writeHeartbeat(env: Env, hb: Heartbeat, writer = new AnalyticsWriter(env)): boolean {
  return writer.write({
    indexes: [hb.monitorId],
    blobs: [String(hb.status), hb.message.slice(0, 512), 'monitor', JSON.stringify(hb.addons ?? {})],
    doubles: [hb.latencyMs, hb.status, hb.statusCode, hb.ts],
  });
}

export function writeHeartbeatBatch(env: Env, points: Heartbeat[], now: number): void {
  if (!points.length) return;
  const writer = new AnalyticsWriter(env);
  const ordered = [...points].sort((a, b) => a.monitorId.localeCompare(b.monitorId));
  const offset = (Math.floor(now / 60) * AE_POINT_LIMIT) % ordered.length;
  let written = 0;
  let failed = 0;
  for (let i = 0; i < Math.min(AE_POINT_LIMIT, ordered.length); i++) {
    try { written += Number(writeHeartbeat(env, ordered[(offset + i) % ordered.length], writer)); }
    catch { failed++; }
  }
  if (written < points.length) console.warn(JSON.stringify({ event: 'history_write_partial', total: points.length, written, failed, reason: env.UPTIME ? 'point_budget_or_write_failure' : 'binding_missing' }));
}
