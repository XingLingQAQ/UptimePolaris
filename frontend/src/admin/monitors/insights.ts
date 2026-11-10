import { isProbeMonitorType } from '../../../../shared/backend-capabilities';
import type { OverviewMonitor } from './types';

/** Fleet readings derived from `/api/overview` and `/api/events`; no second endpoint. / 从 `/api/overview` 和 `/api/events` 推导的全局读数；不另设端点。 */

/** Types whose `ms` / `avg` is a latency. Agent rows carry CPU percent there. / `ms` / `avg` 表示延迟的监控类型；Agent 行中的该值是 CPU 百分比。 */
function measuresLatency(monitor: OverviewMonitor): boolean {
  return isProbeMonitorType(monitor.type);
}

export interface LatencyBucket {
  /** Epoch seconds, start of the bucket. / 数据桶开始时间的 Unix 秒数。 */
  t: number;
  /** Mean latency of the successful checks in the bucket, or null when there were none. / 桶内成功检查的平均延迟；没有成功检查时为 null。 */
  avg: number | null;
  checks: number;
  failures: number;
}

/**
 * Fleet latency folded by check minute.
 *
 * A failed check counts as a failure band, not a zero, so it cannot drag the
 * line down; paused monitors are excluded because their old rings would
 * stretch the time axis backwards.
 * 失败检查计入失败带而不是零；暂停监控不参与，避免拉长时间轴。
 */
export function recentLatency(monitors: OverviewMonitor[], bucketSec = 60): LatencyBucket[] {
  const buckets = new Map<number, { sum: number; ok: number; checks: number; failures: number }>();
  for (const monitor of monitors) {
    if (!monitor.active || !measuresLatency(monitor)) continue;
    for (const beat of monitor.ring ?? []) {
      if (!Number.isFinite(beat.t)) continue;
      const key = Math.floor(beat.t / bucketSec) * bucketSec;
      const bucket = buckets.get(key) ?? { sum: 0, ok: 0, checks: 0, failures: 0 };
      bucket.checks += 1;
      if (beat.up === 0) bucket.failures += 1;
      const ms = (beat as { ms?: number | null }).ms;
      if (beat.up !== 0 && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
        bucket.sum += ms;
        bucket.ok += 1;
      }
      buckets.set(key, bucket);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, b]) => ({ t, avg: b.ok ? b.sum / b.ok : null, checks: b.checks, failures: b.failures }));
}

export interface FleetDay {
  /** Epoch seconds at 00:00 UTC. / UTC 零点的 Unix 秒数。 */
  t: number;
  /** YYYY-MM-DD. */
  d: string;
  /** Up-or-warn share of the day's checks, 0-100; null for a day with no checks. / 当日检查中正常或警告所占比例，范围 0–100；当天无检查时为 null。 */
  availability: number | null;
  /** Check-weighted mean latency of http/tcp monitors, or null. / 按检查次数加权的 HTTP/TCP 平均延迟，或 null。 */
  latency: number | null;
  checks: number;
}

/**
 * 90-day rollups weighted by check count, not averaged per monitor: a
 * minute-checked monitor ran 1440 checks, an hourly one 24, and a plain mean
 * would let the hourly one move the fleet as much.
 * 按检查次数加权；直接平均会让每小时检查的监控权重过大。
 */
export function fleetDays(monitors: OverviewMonitor[]): FleetDay[] {
  const days = new Map<string, { t: number; good: number; latSum: number; latChecks: number }>();
  for (const monitor of monitors) {
    if (!monitor.active) continue;
    for (const day of monitor.days ?? []) {
      if (!day.t) continue;
      const row = days.get(day.d) ?? { t: 0, good: 0, latSum: 0, latChecks: 0 };
      row.t += day.t;
      row.good += day.u + day.w;
      if (measuresLatency(monitor) && day.avg !== null && Number.isFinite(day.avg)) {
        row.latSum += day.avg * day.t;
        row.latChecks += day.t;
      }
      days.set(day.d, row);
    }
  }
  return [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, row]) => ({
      d,
      t: Date.parse(`${d}T00:00:00Z`) / 1000,
      availability: row.t ? Math.min(100, (row.good / row.t) * 100) : null,
      latency: row.latChecks ? row.latSum / row.latChecks : null,
      checks: row.t,
    }))
    .filter((day) => Number.isFinite(day.t));
}

export interface SeriesStats {
  avg: number | null;
  p95: number | null;
  max: number | null;
  min: number | null;
}

/** 忽略缺失值并计算均值、极值和最近秩 P95。 / Ignore missing values and calculate the mean, extrema, and nearest-rank P95. */
export function seriesStats(values: Array<number | null>): SeriesStats {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return { avg: null, p95: null, max: null, min: null };
  const avg = finite.reduce((sum, v) => sum + v, 0) / finite.length;
  const p95 = finite[Math.min(finite.length - 1, Math.ceil(finite.length * 0.95) - 1)];
  return { avg, p95, max: finite[finite.length - 1], min: finite[0] };
}

/** Mean of the latest successful readings across active http/tcp monitors. / 活跃 HTTP/TCP 监控项最近一次成功读数的平均值。 */
export function currentLatency(monitors: OverviewMonitor[]): number | null {
  const readings = monitors
    .filter((m) => m.active && measuresLatency(m) && m.st !== null && m.st !== 0 && m.checked_at > 0 && m.v > 0)
    .map((m) => m.v);
  if (readings.length === 0) return null;
  return readings.reduce((sum, v) => sum + v, 0) / readings.length;
}

/** Mean availability across active monitors that have a rollup. / 有汇总数据的活跃监控项的平均可用率。 */
export function meanUptime(monitors: OverviewMonitor[]): number | null {
  const values = monitors.filter((m) => m.active && m.has_history).map((m) => m.uptime);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** A monitor's own latency over its ring, oldest first; failed checks are gaps. / 单个监控项状态环中的延迟，按时间从旧到新；失败检查显示为缺口。 */
export function ringLatency(monitor: OverviewMonitor): Array<number | null> {
  if (!measuresLatency(monitor)) return [];
  return (monitor.ring ?? []).map((beat) => {
    const ms = (beat as { ms?: number | null }).ms;
    return beat.up !== 0 && typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  });
}

export interface ExpiryItem {
  monitor: OverviewMonitor;
  kind: 'ssl' | 'domain';
  days: number | null;
  /** The add-on's own verdict: 1 fine, 2 inside the warning window or unknown, 0 failed. / 附加项自身结果：1 正常、2 处于警告窗口或未知、0 失败。 */
  st: 0 | 1 | 2;
  checkedAt: number;
}

/** Certificate and domain lifetimes, soonest first; only existing readings. / 证书和域名剩余时间，最早在前；只列已有读数。 */
export function expiries(monitors: OverviewMonitor[]): ExpiryItem[] {
  const out: ExpiryItem[] = [];
  for (const monitor of monitors) {
    if (!monitor.active) continue;
    if (monitor.check_ssl === 1 && monitor.ssl && monitor.ssl.ts > 0) {
      out.push({ monitor, kind: 'ssl', days: monitor.ssl.days, st: monitor.ssl.st, checkedAt: monitor.ssl.ts });
    }
    if (monitor.check_domain === 1 && monitor.domain && monitor.domain.ts > 0) {
      out.push({ monitor, kind: 'domain', days: monitor.domain.days, st: monitor.domain.st, checkedAt: monitor.domain.ts });
    }
  }
  return out.sort((a, b) => (a.days ?? Number.POSITIVE_INFINITY) - (b.days ?? Number.POSITIVE_INFINITY));
}
