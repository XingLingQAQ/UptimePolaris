import type { HistoryResult } from '../../../../../shared/contracts';
import type { Env } from '../../types';
import { ANALYTICS_DATASET, AnalyticsWriter, dayBounds, queryAnalytics, readAnalyticsHistory } from '../analytics-engine';
import { getDB } from '../db/factory';
import type { AgentMinuteSummary, ReportParams } from './protocol';

const SUMMARY_FIELDS = ['bucket_ts', 'cpu_avg', 'cpu_max', 'mem_pct_avg', 'mem_pct_max', 'load_1_avg', 'load_5_avg',
  'sample_count', 'duration_sec', 'net_up_bytes', 'net_down_bytes', 'network_duration_sec', 'cpu_samples', 'mem_samples'] as const;
const SUMMARY_COLUMNS = SUMMARY_FIELDS.map((field, i) => `argMax(double${i + 1}, timestamp) AS ${field}`).join(', ');

export interface AgentHistoryBucket extends AgentMinuteSummary {
  quality: 'aggregate';
}

export interface AgentDayStat extends Omit<AgentHistoryBucket, 'bucket_ts' | 'quality'> {
  d: string;
  sampled: boolean;
}

export function writeAgentHistory(env: Env, agentId: string, report: ReportParams, now: number): void {
  const writer = new AnalyticsWriter(env);
  if (!writer.write({ indexes: [agentId], blobs: ['', report.message.slice(0, 512), 'agent_report'], doubles: [
    report.observed_at, report.cpu.usage ?? -1, report.ram.used ?? -1, report.ram.total ?? -1,
    report.swap.used ?? -1, report.swap.total ?? -1, report.load.load1 ?? -1, report.load.load5 ?? -1, report.load.load15 ?? -1,
    report.disk.used ?? -1, report.disk.total ?? -1, report.network.up ?? -1, report.network.down ?? -1,
    report.network.totalUp ?? -1, report.network.totalDown ?? -1, report.connections.tcp ?? -1,
    report.connections.udp ?? -1, report.process ?? -1, report.uptime ?? -1,
  ] })) console.warn(JSON.stringify({ event: 'agent_history_disabled', agent: agentId }));
  for (const summary of report.summaries) {
    if (!Number.isInteger(summary.bucket_ts) || summary.bucket_ts % 60 !== 0 || summary.bucket_ts < now - 86400 ||
        summary.bucket_ts > now + 300 || summary.bucket_ts > report.observed_at || summary.duration_sec > 3600) continue;
    if (!writer.write({ indexes: [agentId], blobs: ['', '', 'agent_summary'], doubles: SUMMARY_FIELDS.map(field => summary[field] ?? -1) })) {
      console.warn(JSON.stringify({ event: 'agent_history_partial', agent: agentId }));
      break;
    }
  }
}

function bucket(row: Record<string, unknown>): AgentHistoryBucket | null {
  const result = Object.fromEntries(SUMMARY_FIELDS.map(field => {
    const value = row[field] == null ? NaN : Number(row[field]);
    return [field, Number.isFinite(value) && value >= 0 ? value : null];
  })) as unknown as AgentHistoryBucket;
  const required = ['bucket_ts', 'sample_count', 'cpu_samples', 'mem_samples', 'duration_sec', 'network_duration_sec'] as const;
  if (required.some(field => result[field] === null || !Number.isFinite(result[field])) ||
      result.sample_count <= 0 || result.duration_sec <= 0) return null;
  result.quality = 'aggregate';
  return result;
}

function readAgentBuckets(env: Env, id: string, start: number, end: number, cacheSeconds = 0): Promise<Record<string, unknown>[]> {
  return queryAnalytics(env, `SELECT ${SUMMARY_COLUMNS}, APPROX_MAX("sampleInterval") AS sample_interval
    FROM ${ANALYTICS_DATASET} WHERE index1 = $id AND blob3 = 'agent_summary'
      AND timestamp >= $ingestedSince AND double1 >= $start AND double1 < $end
    GROUP BY double1 ORDER BY bucket_ts DESC LIMIT 1440`,
    { id, ingestedSince: new Date((start - 86400) * 1000).toISOString(), start, end }, cacheSeconds);
}

export function queryAgentHistory(env: Env, agentId: string, since: number, now: number): Promise<HistoryResult<AgentHistoryBucket>> {
  const start = Math.max(Math.floor(since / 60) * 60, Math.floor(now / 60) * 60 - 90 * 86400);
  const end = Math.floor(now / 60) * 60 + 60;
  return readAnalyticsHistory(env, async () => {
    const rows = await readAgentBuckets(env, agentId, start, end, 60);
    return { points: rows.map(bucket).filter((point): point is AgentHistoryBucket => point !== null).sort((a, b) => a.bucket_ts - b.bucket_ts),
      sampled: rows.some(row => Number(row.sample_interval) > 1) };
  });
}

function aggregateAgentDay(day: string, rows: Record<string, unknown>[]): AgentDayStat | null {
  const points = rows.flatMap(row => {
    const point = bucket(row);
    const weight = Math.max(1, Number(row.sample_interval) || 1);
    return point ? [{ point, weight }] : [];
  });
  if (!points.length) return null;
  const total = (field: 'sample_count' | 'duration_sec' | 'cpu_samples' | 'mem_samples') =>
    points.reduce((sum, { point, weight }) => sum + point[field] * weight, 0);
  const average = (field: 'cpu_avg' | 'mem_pct_avg' | 'load_1_avg' | 'load_5_avg', samples: 'cpu_samples' | 'mem_samples' | 'duration_sec') => {
    let sum = 0, count = 0;
    for (const { point, weight } of points) {
      if (point[field] === null || point[samples] <= 0) continue;
      sum += point[field] * point[samples] * weight;
      count += point[samples] * weight;
    }
    return count > 0 ? sum / count : null;
  };
  const maximum = (field: 'cpu_max' | 'mem_pct_max') => {
    const values = points.flatMap(({ point }) => point[field] === null ? [] : [point[field]]);
    return values.length ? Math.max(...values) : null;
  };
  let up = 0, down = 0, seconds = 0;
  for (const { point, weight } of points) {
    if (point.net_up_bytes === null || point.net_down_bytes === null || point.network_duration_sec <= 0) continue;
    up += point.net_up_bytes * weight;
    down += point.net_down_bytes * weight;
    seconds += point.network_duration_sec * weight;
  }
  return {
    d: day, sampled: points.some(({ weight }) => weight > 1),
    sample_count: total('sample_count'), duration_sec: total('duration_sec'),
    cpu_samples: total('cpu_samples'), mem_samples: total('mem_samples'),
    cpu_avg: average('cpu_avg', 'cpu_samples'), cpu_max: maximum('cpu_max'),
    mem_pct_avg: average('mem_pct_avg', 'mem_samples'), mem_pct_max: maximum('mem_pct_max'),
    load_1_avg: average('load_1_avg', 'duration_sec'), load_5_avg: average('load_5_avg', 'duration_sec'),
    net_up_bytes: seconds > 0 ? up : null, net_down_bytes: seconds > 0 ? down : null, network_duration_sec: seconds,
  };
}

export async function queryAgentDaily(env: Env, day: string, agentIds: readonly string[]): Promise<Map<string, AgentDayStat>> {
  const { start, end } = dayBounds(day);
  const out = new Map<string, AgentDayStat>();
  const ids = [...new Set(agentIds)];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const point = aggregateAgentDay(day, await readAgentBuckets(env, id, start, end));
      if (point) out.set(id, point);
    }
  }));
  return out;
}

export async function loadAgentDaily(env: Env, agentId: string): Promise<AgentDayStat[]> {
  const db = getDB(env);
  const row = await db.queryOne<{ days_json: string }>(`SELECT days_json FROM agent_history_daily WHERE agent_id=${db.type === 'postgres' ? '$1' : '?'}`, [agentId]);
  if (!row) return [];
  return JSON.parse(row.days_json) as AgentDayStat[];
}

const D1_MERGED_DAYS = `(SELECT json_group_array(json(value)) FROM (SELECT value FROM (
  SELECT value FROM json_each(agent_history_daily.days_json)
    WHERE json_extract(value, '$.d') >= ?5 AND json_extract(value, '$.d') <> ?4
  UNION ALL SELECT value FROM json_each(excluded.days_json)
  ) ORDER BY json_extract(value, '$.d')
))`;
const PG_MERGED_DAYS = `(SELECT jsonb_agg(value ORDER BY value->>'d') FROM (
  SELECT value FROM jsonb_array_elements(agent_history_daily.days_json::jsonb)
    WHERE value->>'d' >= $5::text AND value->>'d' <> $4::text
  UNION ALL SELECT value FROM jsonb_array_elements(excluded.days_json::jsonb)
) AS days)`;

export async function storeAgentDaily(env: Env, day: string, points: Map<string, AgentDayStat>, retentionDays: number): Promise<void> {
  if (!points.size) return;
  const db = getDB(env);
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - (retentionDays - 1) * 86400000).toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  const sql = db.type === 'postgres'
    ? `INSERT INTO agent_history_daily(agent_id,days_json,updated_at)
       SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM agents WHERE id=$1)
       ON CONFLICT(agent_id) DO UPDATE SET days_json=${PG_MERGED_DAYS}::text,updated_at=excluded.updated_at
       WHERE agent_history_daily.days_json::jsonb IS DISTINCT FROM ${PG_MERGED_DAYS}`
    : `INSERT INTO agent_history_daily(agent_id,days_json,updated_at)
       SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM agents WHERE id=?1)
       ON CONFLICT(agent_id) DO UPDATE SET days_json=${D1_MERGED_DAYS},updated_at=excluded.updated_at
       WHERE agent_history_daily.days_json <> ${D1_MERGED_DAYS}`;
  await db.commit([...points].map(([id, point]) => ({
    sql, params: [id, JSON.stringify([{ ...point, d: day }]), now, day, cutoff],
  })));
}

export async function pruneAgentDaily(env: Env, retentionDays: number): Promise<void> {
  const db = getDB(env);
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().slice(0, 10);
  await db.execute(db.type === 'postgres'
    ? `UPDATE agent_history_daily SET days_json=(
         SELECT COALESCE(jsonb_agg(value ORDER BY value->>'d'), '[]'::jsonb)::text
         FROM jsonb_array_elements(agent_history_daily.days_json::jsonb) WHERE value->>'d' >= $1::text
       ) WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(agent_history_daily.days_json::jsonb) WHERE value->>'d' < $1::text)`
    : `UPDATE agent_history_daily SET days_json=(
         SELECT json_group_array(json(value)) FROM (
           SELECT value FROM json_each(agent_history_daily.days_json)
             WHERE json_extract(value, '$.d') >= ?1 ORDER BY json_extract(value, '$.d')
         )
       ) WHERE EXISTS(SELECT 1 FROM json_each(agent_history_daily.days_json) WHERE json_extract(value, '$.d') < ?1)`,
    [cutoff]);
}
