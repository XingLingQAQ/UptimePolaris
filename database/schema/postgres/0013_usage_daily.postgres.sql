-- Daily usage counters - Postgres mirror of 0032.
-- 每日用量计数器：0032 的 Postgres 对应迁移。
--
-- Same columns and reasoning as the D1 migration; see that file for why these
-- are observed counters rather than the plan's quota.
-- 列和设计理由与 D1 迁移相同；为何记录观测值而非套餐配额，参见该迁移。
CREATE TABLE IF NOT EXISTS usage_daily (
  day               TEXT PRIMARY KEY,
  rows_read         BIGINT NOT NULL DEFAULT 0,
  rows_written      BIGINT NOT NULL DEFAULT 0,
  statements        BIGINT NOT NULL DEFAULT 0,
  ticks             BIGINT NOT NULL DEFAULT 0,
  peak_subrequests  INTEGER NOT NULL DEFAULT 0,
  updated_at        BIGINT NOT NULL
);

-- An upsert here is a single-row write keyed on the day, so the primary key is
-- the only index this needs.
-- 此处按日期键单行 upsert，只需要主键索引。
