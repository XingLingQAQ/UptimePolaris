import { DOWN, UP, type DayStat, type Status } from '../../types';

/** Sorted ids keep the blob stable so diffs (and cache keys) stay small. / 排序后的 ID 使数据块保持稳定，减少差异及缓存键变化。 */
export function mergeDay(existing: DayStat[] | null, day: DayStat): DayStat[] {
  const out = (existing ?? []).filter((d) => d.d !== day.d);
  out.push(day);
  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return out;
}

/**
 * Daily availability as a 0..1 ratio. WARN counts as available, which is the
 * behaviour you want for a certificate that has not expired *yet*.
 * 每日可用率为 0..1 的比例。WARN 算作可用，适合尚未过期的证书等情况。
 */
export function mergeDayObservation(previous: DayStat | undefined, incoming: DayStat): DayStat {
  const source = incoming.exact ? incoming : previous?.exact || previous?.avg === null ? previous : incoming;
  const keepAverage = incoming.avg == null || (!incoming.exact && previous?.exact && previous.avg != null && previous.avg_source !== 'ae');
  const average = keepAverage ? previous : incoming;
  const { avg_source: _source, ...stat } = source;
  return { ...stat, avg: average?.avg ?? null, ...(average?.avg_source ? { avg_source: average.avg_source } : {}) };
}

export function availability(day: DayStat): number {
  if (day.t === 0) return 1;
  return (day.u + day.w) / day.t;
}

/** 按观测次数加权汇总日可用率；没有观测时返回 1。 / Aggregate daily availability weighted by observation count; return 1 when there are no observations. */
export function overallAvailability(days: DayStat[]): number {
  const t = days.reduce((n, d) => n + d.t, 0);
  if (t === 0) return 1;
  const ok = days.reduce((n, d) => n + d.u + d.w, 0);
  return ok / t;
}

export function statusLabel(s: Status): string {
  return s === UP ? 'UP' : s === DOWN ? 'DOWN' : 'WARN';
}

/** Day bucket key in UTC. Matches the 00:00 UTC D1/AE quota reset. / UTC 日期分桶键，与 D1/AE 配额在 UTC 00:00 重置的时间一致。 */
export function dayKey(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}
