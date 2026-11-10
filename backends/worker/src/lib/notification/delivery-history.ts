/**
 * Delivery log.
 *
 * A logging failure never fails a send — the message may already be in the
 * operator's chat. Never store the channel config; provider errors can echo a
 * token, so they are scrubbed before reaching this table.
 * 记录失败不影响发送；提供商错误可能回显 Token，入库前脱敏。
 */

import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { deliveriesSQL, type DeliveryStatRow } from '../db/sql/deliveries';

/** The transition a delivery was about. 0 down, 1 recovered, 2 warning. / 投递对应的状态变化：0 故障、1 恢复、2 警告。 */
export type DeliveryStatus = 0 | 1 | 2;

export interface DeliveryRecord {
  id: string;
  channel_id: string;
  monitor_id: string | null;
  monitor_name: string | null;
  status: DeliveryStatus;
  ok: boolean;
  latency_ms: number;
  error: string | null;
  created_at: number;
}

/** What the console's per-channel figures need. Mirrors `ChannelDeliveryStats` in the UI. / 控制台各渠道统计所需数据，对应界面的 `ChannelDeliveryStats`。 */
export interface ChannelDeliveryStats {
  sent24h: number;
  failed24h: number;
  avgLatencyMs: number;
  lastSentAt: number | null;
  lastOk: boolean | null;
  /** Attempts per hour for the last 24 hours, oldest first. / 最近 24 小时每小时的尝试次数，最早优先。 */
  hourly: number[];
}

/** Mask credential-shaped substrings in provider errors. / 遮蔽提供商错误中的凭据片段。 */
export function scrubError(text: string): string {
  return text
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/\b(bot|token|key|secret|password|sendkey)=[^\s&"']+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .slice(0, 400);
}

/** Write one attempt; `at` is the actual run time, not the queue time. / 写入一次尝试；`at` 是实际运行时间。 */
export async function recordDelivery(
  env: Env,
  input: {
    channelId: string;
    monitorId: string | null;
    monitorName: string | null;
    status: DeliveryStatus;
    ok: boolean;
    latencyMs: number;
    error: string | null;
    at: number;
  },
): Promise<void> {
  const db = getDB(env);
  try {
    await db.execute(deliveriesSQL[db.type].insert, [
      crypto.randomUUID(),
      input.channelId,
      input.monitorId,
      input.monitorName,
      input.status,
      input.ok ? 1 : 0,
      Math.max(0, Math.round(input.latencyMs)),
      input.ok || !input.error ? null : scrubError(input.error),
      input.at,
    ]);
  } catch (e) {
    // Deliberately swallowed. See rule 1 at the top of this file.
    // 有意吞掉错误，见文件开头的规则 1。
    console.error(JSON.stringify({ event: 'delivery_log_failed', err: String(e) }));
  }
}

/** Fallback retention; callers pass `retention.eventDays` when available. / 兜底保留天数；调用方有设置时传 `retention.eventDays`。 */
const DEFAULT_RETENTION_DAYS = 90;

/** Burn one bounded batch of expired rows. Called from the daily housekeeping. / 清理一个有界批次的过期记录，由每日清理任务调用。 */
export async function pruneDeliveries(env: Env, now: number, maxDays = DEFAULT_RETENTION_DAYS): Promise<void> {
  const db = getDB(env);
  try {
    await db.execute(deliveriesSQL[db.type].pruneOld, [now - maxDays * 86400]);
  } catch (e) {
    console.error(JSON.stringify({ event: 'delivery_prune_failed', err: String(e) }));
  }
}

/**
 * Per-channel statistics for the last 24 hours.
 *
 * An absent channel means no attempts in the window; pre-seeding zeroes would
 * make "never sent" indistinguishable from "sent nothing today". `hourly` is
 * always 24 slots so two channels line up.
 * 无尝试的渠道不返回，避免与“今天没发”混淆；hourly 固定 24 格。
 */
export async function loadDeliveryStats(
  env: Env,
  now: number,
): Promise<Record<string, ChannelDeliveryStats>> {
  const db = getDB(env);
  const since = now - 86400;

  const rows = await db.query<DeliveryStatRow>(deliveriesSQL[db.type].stats, [since]);

  /** The current hour, so the 24 slots end at the present rather than at :00. / 当前小时，使 24 个槽结束于现在而非整点。 */
  const currentHour = Math.floor(now / 3600);

  const out: Record<string, ChannelDeliveryStats> = {};
  for (const row of rows) {
    const id = String(row.channel_id);
    const entry =
      out[id] ??
      (out[id] = {
        sent24h: 0,
        failed24h: 0,
        avgLatencyMs: 0,
        lastSentAt: null,
        lastOk: null,
        hourly: Array.from({ length: 24 }, () => 0),
      });

    const sent = Number(row.sent) || 0;
    const failed = Number(row.failed) || 0;
    const avg = row.avg_latency === null ? null : Number(row.avg_latency);
    const last = row.last_sent_at === null ? null : Number(row.last_sent_at);
    const hour = Number(row.hour);

    entry.sent24h += sent;
    entry.failed24h += failed;
    // Weighted mean across hours: a simple mean of the per-hour means would
    // let an hour with one slow send outweigh an hour with fifty fast ones.
    // 按小时加权求平均；若直接平均各小时均值，只有一次慢发送的小时可能超过有 50 次快速发送的小时。
    if (avg !== null && Number.isFinite(avg)) {
      entry.avgLatencyMs =
        entry.sent24h === sent
          ? avg
          : (entry.avgLatencyMs * (entry.sent24h - sent) + avg * sent) / entry.sent24h;
    }
    if (last !== null && (entry.lastSentAt === null || last > entry.lastSentAt)) {
      entry.lastSentAt = last;
      // Any failure in the latest hour means `lastOk` must not be claimed. / 最近一小时有失败就不能声称 `lastOk`。
      entry.lastOk = failed === 0;
    }
    const slot = 23 - (currentHour - hour);
    if (slot >= 0 && slot < 24) entry.hourly[slot] = sent;
  }

  for (const entry of Object.values(out)) {
    entry.avgLatencyMs = Math.round(entry.avgLatencyMs);
  }
  return out;
}

/** Recent attempts across every channel, newest first. / 所有渠道的近期尝试，最新优先。 */
export async function loadRecentDeliveries(
  env: Env,
  limit: number,
): Promise<DeliveryRecord[]> {
  const db = getDB(env);
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await db.query<Record<string, unknown>>(deliveriesSQL[db.type].listRecent, [
      Math.max(1, Math.min(100, limit)),
    ]);
  } catch (e) {
    console.error(JSON.stringify({ event: 'delivery_list_failed', err: String(e) }));
    return [];
  }

  return rows.map((row) => ({
    id: String(row.id),
    channel_id: String(row.channel_id),
    monitor_id: row.monitor_id === null ? null : String(row.monitor_id),
    monitor_name: row.monitor_name === null ? null : String(row.monitor_name),
    status: (Number(row.status) === 1 ? 1 : Number(row.status) === 2 ? 2 : 0) as DeliveryStatus,
    // Postgres returns boolean, D1 an integer; `Boolean('0')` would be true. / Postgres 返回布尔，D1 返回整数；`Boolean('0')` 会是 true。
    ok:
      typeof row.ok === 'boolean'
        ? row.ok
        : Number(row.ok) === 1,
    latency_ms: Number(row.latency_ms) || 0,
    error: row.error === null ? null : String(row.error),
    created_at: Number(row.created_at) || 0,
  }));
}
