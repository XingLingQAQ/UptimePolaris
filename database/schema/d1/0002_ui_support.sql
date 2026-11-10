-- Numeric monitor id.
--
-- The status page uses integer monitor ids: it reads `uptimeList["<id>_24"]`,
-- builds detail routes as /monitor/<id>,
-- and keys heartbeatList by id. Our primary key is a UUID, so a stable integer
-- is needed alongside it.
--
-- SQLite cannot add an AUTOINCREMENT column via ALTER TABLE, so this is a
-- plain INTEGER populated from the existing rowid. Monitors are few (hundreds
-- at most) and inserts are rare, so uniqueness is enforced with a unique index
-- rather than a sequence.
--
-- Note: SQLite has no `ADD COLUMN IF NOT EXISTS`, so this statement is not
-- repeatable. Applying this file twice fails with "duplicate column name" and
-- aborts the rest of the file. That is intentional - a migration runner should
-- surface a double-apply rather than silently continue - but it does mean
-- db:init is a one-shot command against a fresh database. Track applied
-- migrations if this project ever needs repeatable runs.
--
-- 监控项数字 ID：状态页以整数 ID 读取 `uptimeList["<id>_24"]`、构造
-- /monitor/<id> 详情路由，并以 ID 为 heartbeatList 的键。主键为 UUID，
-- 因此还需稳定的整数。SQLite 无法通过 ALTER TABLE 添加 AUTOINCREMENT 列，
-- 故使用普通 INTEGER，从现有 rowid 填充。监控项数量较少（最多数百个）且插入少，
-- 使用唯一索引而非序列保证唯一性。SQLite 没有 `ADD COLUMN IF NOT EXISTS`，
-- 因而此语句不能重复执行；第二次执行以 duplicate column name 失败并中止后续语句。
-- 这是有意设计：迁移执行器应暴露重复应用，而非静默继续；db:init 因而只针对
-- 全新数据库执行一次。若将来需要可重复运行，应记录已应用的迁移。
ALTER TABLE monitors ADD COLUMN num_id INTEGER;

UPDATE monitors SET num_id = rowid WHERE num_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_num_id ON monitors(num_id);

-- Heartbeat ring buffer for the status page.
--
-- Stores the most recent N heartbeats per monitor as JSON in a single row, so
-- rendering a status page never touches Analytics Engine. AE has no local
-- emulation and each query costs against the daily read-query quota; this row
-- is rewritten by the same cron tick that already updates live_state, so it
-- adds no extra D1 write round trips beyond the one it already performs.
--
-- 状态页心跳环形缓冲区：每个监控项一行 JSON 保存最近 N 次心跳，渲染状态页无需
-- 查询 Analytics Engine。AE 没有本地模拟，每次查询还消耗每日读取配额；此行由
-- 原本更新 live_state 的同一次 cron tick 重写，不增加额外 D1 写入往返。
CREATE TABLE IF NOT EXISTS heartbeat_ring (
  id         TEXT PRIMARY KEY,
  json       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
