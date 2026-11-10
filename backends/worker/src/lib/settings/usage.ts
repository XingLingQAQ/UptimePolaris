/**
 * Observed daily usage.
 *
 * `subrequests` is a per-invocation ceiling, so it is a peak and never summed;
 * adding sixty minutes of 6-subrequest ticks and comparing to 50 would report
 * every deployment as over quota. Limits come from `USAGE_PLAN`, not a probe.
 * subrequests 是单次调用上限，只能取峰值不能累加；限额来自 USAGE_PLAN。
 */

import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { usageSQL } from '../db/sql/usage';

/** The free plan's published daily ceilings, as documented in the README. / README 中记录的免费套餐公开每日上限。 */
const FREE_LIMITS = {
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
  subrequests: 50,
} as const;

export type UsagePlan = 'free' | 'paid';

export interface UsageReport {
  /** The UTC day the counters cover, YYYY-MM-DD. / 计数器覆盖的 UTC 日期，格式为 YYYY-MM-DD。 */
  day: string;
  d1RowsRead: number;
  d1RowsWritten: number;
  statements: number;
  ticks: number;
  /** The busiest single tick today, against the per-invocation ceiling. / 今日单次 tick 的最大用量，用于比较单次调用上限。 */
  peakSubrequests: number;
  limits: { d1RowsRead: number; d1RowsWritten: number; subrequests: number };
  /** False when nothing has been recorded today yet. / 今日尚无记录时为 false。 */
  observed: boolean;
  /** Plan whose limits are reported, read from `USAGE_PLAN` rather than probed. / 报告限额所用计划，读取 `USAGE_PLAN`。 */
  plan: UsagePlan;
}

function utcDay(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

/** Accumulate one tick. Best-effort: never fails the tick it is called from. / 累计一次 tick；尽力执行，不使调用它的 tick 失败。 */
export async function recordTickUsage(
  env: Env,
  now: number,
  usage: { rows_read: number; rows_written: number; statements: number },
  peakSubrequests: number,
): Promise<void> {
  const db = getDB(env);
  try {
    await db.execute(usageSQL[db.type].accumulate, [
      utcDay(now),
      Math.max(0, Math.round(usage.rows_read)),
      Math.max(0, Math.round(usage.rows_written)),
      Math.max(0, Math.round(usage.statements)),
      Math.max(0, Math.round(peakSubrequests)),
      now,
    ]);
  } catch (e) {
    console.error(JSON.stringify({ event: 'usage_record_failed', err: String(e) }));
  }
}

/** Today's figures; defaults to the conservative free plan. / 今日数据；默认使用更保守的免费计划。 */
export function limitsFor(plan: UsagePlan) {
  return plan === 'paid'
    ? // Paid plans have no published daily row ceiling in the same form; the
      // numbers here are the Workers Paid included amounts, not a hard cap.
      // 付费套餐未以相同形式公布每日行数上限；此处数字是 Workers Paid 的包含额度，并非硬性上限。
      { d1RowsRead: 25_000_000, d1RowsWritten: 50_000_000, subrequests: 1000 }
    : FREE_LIMITS;
}

export async function loadUsage(env: Env, now: number): Promise<UsageReport> {
  const db = getDB(env);
  const day = utcDay(now);
  const plan: UsagePlan = env.USAGE_PLAN === 'paid' ? 'paid' : 'free';
  const limits = limitsFor(plan);

  const row = await db.queryOne<Record<string, unknown>>(usageSQL[db.type].read, [day]);

  const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    day,
    d1RowsRead: num(row?.rows_read),
    d1RowsWritten: num(row?.rows_written),
    statements: num(row?.statements),
    ticks: num(row?.ticks),
    peakSubrequests: num(row?.peak_subrequests),
    limits,
    observed: row !== null,
    plan,
  };
}
