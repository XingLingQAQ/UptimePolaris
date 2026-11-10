-- DNS and passive-push monitors, plus per-type options.
--
-- 0001_init.sql pinned `type` to `CHECK (type IN ('http','tcp','ssl','domain'))`.
-- 0005 retired `ssl`/`domain` as types but left the constraint alone, on the
-- explicit argument that widening it was not worth a table rebuild for two
-- values no code produces. That argument does not survive two *new* types: a
-- `dns` or `push` insert fails the CHECK outright, and SQLite cannot alter or
-- drop a CHECK - the only way is a table rebuild, which is what 0007 does for
-- `notifications` and what this file does below.
--
-- This file is therefore **mixed**, and the two halves have different repeat
-- behaviour that has to be kept straight:
--
--   * The two `ALTER TABLE ... ADD COLUMN` statements are **not repeatable**.
--     SQLite has no `ADD COLUMN IF NOT EXISTS`, so a second apply dies on
--     "duplicate column name" - the same deliberate fatality 0002, 0004 and
--     0005 argue for: a migration runner should surface a double-apply rather
--     than silently continue.
--   * Everything after them is repeatable in the sense that it is guarded by
--     `IF NOT EXISTS` or a `WHERE NOT EXISTS`. The rebuild is not, though - it
--     creates `monitors_new` unconditionally, so re-running dies there too. That
--     is intentional and is 0007's structure: the alternative, `CREATE TABLE IF
--     NOT EXISTS monitors_new`, would let a half-applied rebuild go unnoticed
--     while the copy below is not idempotent.
--
-- **Ordering is load-bearing**, as in 0004 and 0005. The two ALTERs sit before
-- the rebuild, so a second apply dies on the duplicate column and never reaches
-- the copy/drop. A half-applied 0008 - new columns, old CHECK - is unreachable
-- by construction rather than merely unlikely, and the state it would leave is
-- the one that matters: `options_json` present but `dns` still un-insertable.
--
-- DNS 和被动 Push 监控及按类型设置的选项。0001 的类型 CHECK 限制为 http、tcp、
-- ssl、domain；0005 停用 ssl/domain 类型但保留约束，理由是两个不再生成的值不值得
-- 重建表。新增 dns/push 后该理由不再成立：插入会被 CHECK 拒绝，而 SQLite 无法
-- 修改或删除 CHECK，只能像 0007 重建 notifications 一样重建表。
-- 此文件混合不同的重复执行行为：两个 ADD COLUMN 不可重复，第二次因 SQLite 缺少
-- ADD COLUMN IF NOT EXISTS 而以 duplicate column name 失败；这与 0002、0004、0005
-- 一样有意让执行器报告重复应用。其余受 IF NOT EXISTS 或 WHERE NOT EXISTS 保护的
-- 语句可重复，但重建本身不可重复：monitors_new 无条件创建，重复时失败。若使用
-- CREATE TABLE IF NOT EXISTS，非幂等复制可能掩盖半完成重建。顺序至关重要：
-- 两条 ALTER 在重建前，第二次执行会先因重复列失败，不进入复制和删除。这样从结构上
-- 防止 0008 留下“已新增 options_json、但旧 CHECK 仍不允许 dns”的半完成状态。
ALTER TABLE monitors ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE monitors ADD COLUMN push_token TEXT;

-- Rebuild `monitors` to widen the type CHECK.
--
-- Follows 0007_notification_providers.sql exactly, including its ordering:
--   1. create the new table
--   2. copy every row
--   3. drop the old table        <- after the copy, never before
--   4. rename the new one into place
-- A crash between 2 and 3 leaves the old table intact and the new one populated,
-- recoverable by hand. Doing the DROP first would not be.
--
-- The column list is written out rather than `SELECT *` (which 0007 could use,
-- where the change was only the CHECK list). Here the new table carries two
-- columns the old one gained seconds ago and two more that arrived earlier, in a
-- different order, so `SELECT *` would copy positionally into the wrong columns.
-- Naming them makes the copy self-describing, and a column added later must be
-- added to both sides or the INSERT fails loudly - the intended behaviour.
--
-- 重建 monitors 以扩展类型 CHECK，严格遵循 0007 顺序：1 创建新表，2 复制每行，
-- 3 删除旧表（必须在复制后），4 重命名新表。第 2、3 步之间崩溃时旧表完整且
-- 新表已填充，可手工恢复；先 DROP 则不能。此处显式列出列名而非 SELECT *：
-- 新表的两列刚添加到旧表，另两列更早添加且顺序不同，按位置复制会写错列。
-- 显式列名让复制含义清楚；将来添加列须同时加入两侧，否则 INSERT 应明确失败。
CREATE TABLE monitors_new (
  id              TEXT PRIMARY KEY,
  num_id          INTEGER,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL CHECK (type IN ('http', 'tcp', 'push')),
  target          TEXT    NOT NULL,
  method          TEXT    NOT NULL DEFAULT 'GET',
  expected_status TEXT    NOT NULL DEFAULT '200-299',
  keyword         TEXT,
  interval_sec    INTEGER NOT NULL DEFAULT 60,
  timeout_ms      INTEGER NOT NULL DEFAULT 10000,
  warn_days       INTEGER NOT NULL DEFAULT 14,
  check_ssl       INTEGER NOT NULL DEFAULT 0,
  check_domain    INTEGER NOT NULL DEFAULT 0,
  options_json    TEXT    NOT NULL DEFAULT '{}',
  push_token      TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Every existing row is `http` or `tcp` (0005 rewrote the retired values), so
-- all of them pass the new CHECK.
-- 所有现有行均为 http 或 tcp（0005 已改写停用类型），因此均通过新 CHECK。
INSERT INTO monitors_new
  (id, num_id, name, type, target, method, expected_status, keyword,
   interval_sec, timeout_ms, warn_days, check_ssl, check_domain,
   options_json, push_token, active, created_at, updated_at)
  SELECT
   id, num_id, name, type, target, method, expected_status, keyword,
   interval_sec, timeout_ms, warn_days, check_ssl, check_domain,
   options_json, push_token, active, created_at, updated_at
  FROM monitors;

DROP TABLE monitors;

ALTER TABLE monitors_new RENAME TO monitors;

-- `idx_monitors_num_id` was created by 0002 and **is dropped by the DROP TABLE
-- above** - SQLite drops a table's indexes with it. Recreating it is not
-- housekeeping: without it the UI's numeric ids lose their uniqueness, and two
-- monitors sharing a num_id is a collision in `uptimeList["<id>_24"]` and in
-- /monitor/<id> that nothing would report. It is `IF NOT EXISTS` because the
-- statement is a no-op on the (never reached) path where the index survived.
--
-- 0002 创建的 idx_monitors_num_id 随上面的 DROP TABLE 一起删除：SQLite 删除表时
-- 同时删除索引。必须重建以保持界面数字 ID 唯一；两个监控项共用 num_id 会让
-- `uptimeList["<id>_24"]` 和 /monitor/<id> 静默冲突。使用 IF NOT EXISTS，
-- 使索引仍存在这一不可到达路径上的语句成为无操作。
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_num_id ON monitors(num_id);

-- Where a push heartbeat lands.
--
-- One row per push monitor, upserted by the public endpoint, rather than an
-- append-only log: only the last push is ever read. The cron tick folds this row
-- into `live_state`, and the ring buffer and Analytics Engine then record it like
-- any other reading, so a passive monitor's history is the same shape as an
-- active one's.
--
-- `monitor_id` is the primary key, so the upsert is one statement against a
-- primary-key index with no second lookup. No foreign key: nothing else in this
-- schema declares one, and the API already deletes every table keyed by monitor
-- id when a monitor goes.
--
-- `ping` is the duration the *pusher* measured, in ms, defaulting to 0 because a
-- backup script's cron job often has nothing to report. It is deliberately a
-- column and not part of `msg`: it feeds `LiveEntry.v`, which is a latency, and
-- burying it in prose would make the status page plot nothing.
--
-- Push 心跳存储：每个 Push 监控项一行，由公开端点 upsert，而非追加日志，
-- 因为只读取最后一次 Push。cron tick 将其纳入 live_state，心跳环和 Analytics Engine
-- 再按普通读数记录，因此被动与主动监控的历史结构一致。monitor_id 为主键，
-- upsert 可通过主键索引单条完成，无需第二次查找。此处不设外键：其他表也未声明，
-- API 删除监控项时已清理按监控 ID 索引的所有表。ping 是推送方测得的毫秒时长，
-- 默认 0，因为备份脚本的 cron 常无时长可报；它单独成列而非放在 msg 中，
-- 因为它提供代表延迟的 LiveEntry.v，埋在文字中会使状态页无法绘图。
CREATE TABLE IF NOT EXISTS push_heartbeats (
  monitor_id TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  status     INTEGER NOT NULL,
  msg        TEXT NOT NULL DEFAULT '',
  ping       INTEGER NOT NULL DEFAULT 0
);

-- After the rebuild, because this indexes the *new* `monitors` table: an index
-- created before the DROP would be dropped with the old one and the lookup below
-- would silently become a full scan.
--
-- The public push endpoint resolves its token to a monitor on every ping, and an
-- unauthenticated endpoint is exactly where a scan is worth avoiding. `push_token`
-- is NULL for every other type, so the index only holds the push rows.
--
-- 重建后才创建该索引，因为它索引的是新的 monitors 表；若在 DROP 前创建，
-- 会随旧表一起删除，使后续查找静默退化为全表扫描。公开 Push 端点每次心跳
-- 都通过令牌查找监控项，未认证端点尤其应避免扫描；其他类型的 push_token
-- 均为 NULL，因此索引只包含 Push 行。
CREATE INDEX IF NOT EXISTS idx_monitors_push_token ON monitors(push_token);
