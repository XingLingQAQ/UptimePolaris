import type { Env, Heartbeat } from '../types';

/** 通过账号级 HTTP 接口查询 Analytics Engine。 / Query Analytics Engine through the account-level HTTP endpoint. */
const SQL_API = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

export interface AeRow {
  idx: string;
  total: number;
  up: number;
  warn: number;
  avg: number;
}

/** 按 UTC 日汇总，并用 _sample_interval 为计数和延迟加权。 / Aggregate a UTC day, weighting counts and latency by _sample_interval. */
export async function queryDaily(
  env: Env,
  day: string,
): Promise<Map<string, AeRow>> {
  /** Missing AE configuration is reported as disabled by `runSync`. / AE 配置缺失时，`runSync` 将其报告为已禁用。 */
  if (!env.UPTIME) throw new Error('Analytics Engine binding is not configured');
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) throw new Error('Analytics Engine credentials are not configured');

  // The AE SQL API does not support bound parameters, so `day` would be
  // concatenated verbatim. Whitelist the format here so a future call-site
  // with user-influenced input cannot smuggle SQL into the date literal.
  // AE SQL API 不支持绑定参数，`day` 将被原样拼接；此处以格式白名单限制，
  // 防止未来调用方传入受用户影响的值时将 SQL 注入日期字面量。
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Invalid day key format (expected YYYY-MM-DD): ${JSON.stringify(day)}`);
  }

  const sql = `
    SELECT
      index1                    AS idx,
      sum(_sample_interval)     AS total,
      sumIf(_sample_interval, double2 IN (1, 4))  AS up,
      sumIf(_sample_interval, double2 = 2)  AS warn,
      sum(double1 * _sample_interval) / greatest(sum(_sample_interval), 1) AS avg
    FROM uptime_heartbeats
    WHERE timestamp >= toDateTime('${day} 00:00:00')
      AND timestamp <  toDateTime('${day} 00:00:00') + INTERVAL '1' DAY
    GROUP BY idx
    FORMAT JSON
  `;

  const res = await fetch(SQL_API(env.CF_ACCOUNT_ID), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'text/plain',
    },
    body: sql,
  });

  if (!res.ok) {
    throw new Error(`AE query failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { success?: boolean; errors?: unknown[]; data?: unknown };
  if (json.success === false || !Array.isArray(json.data)) {
    throw new Error(`AE query returned an invalid response: ${JSON.stringify(json.errors ?? 'missing data')}`);
  }
  const out = new Map<string, AeRow>();
  for (const value of json.data) {
    if (!value || typeof value !== 'object') throw new Error('AE query returned an invalid row');
    const r = value as Record<string, unknown>;
    out.set(String(r.idx), {
      idx: String(r.idx),
      total: Number(r.total) || 0,
      up: Number(r.up) || 0,
      warn: Number(r.warn) || 0,
      avg: Number(r.avg) || 0,
    });
  }
  return out;
}

/**
 * 字段与 queryDaily 对应：index1 为监控 ID，double1/2/3 为上报值、状态和响应码。
 * Match queryDaily: index1 is the monitor ID; double1/2/3 hold the reported value, status, and response code.
 * 缺少绑定时返回 false；true 表示已调用写入接口。
 * Return false without the binding; true means the write API was called.
 */
export function writeHeartbeat(env: Env, hb: Heartbeat): boolean {
  if (!env.UPTIME) return false;

  env.UPTIME.writeDataPoint({
    indexes: [hb.monitorId],
    blobs: [String(hb.status), hb.message.slice(0, 512)],
    doubles: [hb.latencyMs, hb.status, hb.statusCode],
  });
  return true;
}
