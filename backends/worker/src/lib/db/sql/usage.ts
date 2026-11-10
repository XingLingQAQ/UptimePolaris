/**
 * SQL for `usage_daily`.
 *
 * The tick accumulates one row per UTC day. The console reads it to show what
 * this deployment actually spent, which is why the numbers are observed rather
 * than taken from a quota API - Workers does not expose the plan's counters to
 * the Worker itself.
 * `usage_daily` 的 SQL。每次 tick 按 UTC 日期累计一行，控制台据此显示部署实际消耗；
 * Workers 不向 Worker 暴露套餐计数器，因此使用观测值而非配额 API 数据。
 */

const d1 = {
  /**
   * Accumulate one tick's observations.
   *
   * `MAX` for `peak_subrequests` because the column is a high-water mark, not a
   * sum: two ticks that each used 6 subrequests are not a peak of 12, they are
   * a peak of 6. Everything else accumulates.
   * 累计一次 tick 的观测。`peak_subrequests` 是峰值而非总和，因此使用 `MAX`：
   * 两次 tick 各使用 6 个子请求，峰值仍是 6 而非 12；其他字段累计求和。
   */
  accumulate: `INSERT INTO usage_daily
      (day, rows_read, rows_written, statements, ticks, peak_subrequests, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      rows_read        = rows_read + excluded.rows_read,
      rows_written     = rows_written + excluded.rows_written,
      statements       = statements + excluded.statements,
      ticks            = ticks + 1,
      peak_subrequests = MAX(peak_subrequests, excluded.peak_subrequests),
      updated_at       = excluded.updated_at`,

  read: 'SELECT * FROM usage_daily WHERE day = ?',
} as const;

type UsageSQL = { [K in keyof typeof d1]: string };

const postgres: UsageSQL = {
  accumulate: `INSERT INTO usage_daily
      (day, rows_read, rows_written, statements, ticks, peak_subrequests, updated_at)
    VALUES ($1, $2, $3, $4, 1, $5, $6)
    ON CONFLICT (day) DO UPDATE SET
      rows_read        = usage_daily.rows_read + EXCLUDED.rows_read,
      rows_written     = usage_daily.rows_written + EXCLUDED.rows_written,
      statements       = usage_daily.statements + EXCLUDED.statements,
      ticks            = usage_daily.ticks + 1,
      peak_subrequests = GREATEST(usage_daily.peak_subrequests, EXCLUDED.peak_subrequests),
      updated_at       = EXCLUDED.updated_at`,

  read: 'SELECT * FROM usage_daily WHERE day = $1',
};

export const usageSQL: Record<'d1' | 'postgres', UsageSQL> = {
  d1,
  postgres,
};
