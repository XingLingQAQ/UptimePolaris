-- Daily counter of what this deployment actually spent.
-- 此部署实际消耗的每日计数器。
--
-- Why this exists: the console's settings page shows a "today's usage" panel,
-- and until now it rendered sample figures. The Workers runtime does not expose
-- a "rows read today" counter - `D1Meta` reports per-statement numbers, and the
-- free-plan quota is enforced by Cloudflare against the account, not readable
-- from inside the Worker. So the honest thing to report is what the Worker
-- itself observed, accumulated here.
-- 控制台设置页的“今日用量”曾显示示例数据。Workers 运行时不提供“今日已读行数”：
-- `D1Meta` 只报告每条语句的数据，免费套餐配额由 Cloudflare 按账户执行，Worker 内无法读取。
-- 因此这里累计并报告 Worker 自身观测到的用量。
--
-- One row per UTC day. The tick adds to it once per invocation, inside the same
-- database scope the tick already opens, so this costs one statement per minute
-- rather than one per monitor.
-- 每个 UTC 日期一行；每次 tick 在已有数据库作用域内累计，因而每分钟只需一条语句，
-- 而不是每个监控一条。
--
-- Columns:
--   rows_read / rows_written  sum of D1's per-statement metadata this day
--   statements                statements executed this day
--   ticks                     completed tick invocations this day
--   peak_subrequests          the most external requests seen in one tick,
--                             measured against the per-invocation ceiling
--   updated_at                epoch seconds of the last accumulation
-- 列说明：
--   rows_read / rows_written  当日 D1 各语句元数据的累计行数
--   statements                当日执行的语句数
--   ticks                     当日完成的 tick 次数
--   peak_subrequests          单次 tick 中观测到的最大外部请求数，用于比较单次调用上限
--   updated_at                最近一次累计的 Unix 秒数
CREATE TABLE IF NOT EXISTS usage_daily (
  day               TEXT PRIMARY KEY,
  rows_read         INTEGER NOT NULL DEFAULT 0,
  rows_written      INTEGER NOT NULL DEFAULT 0,
  statements        INTEGER NOT NULL DEFAULT 0,
  ticks             INTEGER NOT NULL DEFAULT 0,
  peak_subrequests  INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);
