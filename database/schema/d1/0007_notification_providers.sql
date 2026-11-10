-- Widen the notification provider list.
--
-- 0006 created `notifications` with `CHECK (type IN ('telegram','feishu'))`, on the
-- reasoning that a two-provider project does not need a free string. Five more
-- providers later, that constraint is the problem rather than the safeguard: it
-- cannot be edited, and SQLite has no `ALTER TABLE ... DROP CONSTRAINT`.
--
-- So the table is rebuilt. That is the only way to change a CHECK in SQLite, and
-- it is why this file exists instead of a one-line ALTER.
--
-- **This file is deliberately fatal on a second apply**, like 0004 and 0005: the
-- first statement creates `notifications_new`, so re-running dies on "table
-- notifications_new already exists" before any data is touched. That is the
-- intent - the alternative, `CREATE TABLE IF NOT EXISTS`, would let a half-applied
-- rebuild go unnoticed, and the copy below is not idempotent.
--
-- Ordering matters and is load-bearing:
--   1. create the new table
--   2. copy every row
--   3. drop the old table        <- after the copy, never before
--   4. rename the new one into place
-- A crash between 2 and 3 leaves the old table intact and the new one populated,
-- which is recoverable by hand. Doing the DROP first would not be.
--
-- `SELECT *` is safe here because the column order and names are identical to
-- 0006 - the only change is the CHECK list. A column added later must be added to
-- both sides of this copy or the INSERT will fail loudly, which is the intended
-- behaviour.
--
-- 扩展通知服务商列表。0006 的 CHECK 仅允许 Telegram、飞书；新增五种服务商后
-- 约束反而成为障碍，SQLite 无法直接修改 CHECK 或 DROP CONSTRAINT，因此只能重建表。
-- 与 0004/0005 一样，此文件有意在第二次执行时失败：第一条无保护 CREATE 会在
-- 修改数据前因 notifications_new 已存在而失败。若使用 IF NOT EXISTS，则非幂等的
-- 复制过程可能掩盖半完成重建。顺序不可更改：1 创建新表，2 复制每行，3 删除旧表
--（必须在复制后），4 重命名新表。第 2 与第 3 步之间崩溃时旧表完整、新表已有数据，
-- 可手工恢复；先 DROP 则不能。此处列顺序和名称与 0006 相同，仅 CHECK 列表变化，
-- 因此 SELECT * 安全；以后增加列时需同时加入复制两侧，否则 INSERT 应明确失败。
CREATE TABLE notifications_new (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'telegram','feishu','slack','discord','webhook','apprise','serverchan'
              )),
  config_json TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

INSERT INTO notifications_new
  SELECT id, name, type, config_json, active, created_at, updated_at FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;

-- No index on `active`, unchanged from 0006: dispatch reads the handful of active
-- rows once per tick, and a scan is cheaper than the index that every edit would
-- have to maintain.
-- 与 0006 一样不为 active 建索引：每次 tick 仅读少量活跃行，扫描比每次编辑维护索引更便宜。
