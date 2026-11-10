-- Notification channels.
--
-- Two providers, not a plugin registry: Telegram and Feishu (Lark) are what this
-- project sends to, so `type` is a two-value CHECK constraint rather than a free
-- string every consumer has to branch on and guess the meaning of. A third
-- provider means a third value here and a third case in src/lib/notify.ts, which
-- is the honest cost of adding one.
--
-- The credentials live in `config_json`, whose shape depends on `type` - see
-- `validateConfig` in src/lib/notify.ts: telegram needs `bot_token` + `chat_id`,
-- feishu needs `webhook_url`. One JSON column rather than a key/value table or
-- one column per provider because the config is only ever read and written whole,
-- never queried by field, and per-provider columns would leave every row holding
-- NULLs for the provider it is not.
--
-- **This file is safe to re-run.** `CREATE TABLE IF NOT EXISTS` is repeatable,
-- unlike the `ALTER TABLE` statements in 0004_default_account.sql and
-- 0005_monitor_addons.sql: those are intentionally fatal on a second apply
-- (SQLite has no `ADD COLUMN IF NOT EXISTS` and a migration runner should surface
-- a double-apply rather than silently continue), which is why they carry an
-- ordering argument and cannot be half-applied. Nothing here can overwrite data
-- and there is no data migration after the CREATE, so a repeat is a no-op rather
-- than an accident - and `db:init` run twice against the same database is fine.
--
-- No index on `active`: dispatch reads the active rows on every cron tick, but
-- the table holds a handful of rows, so a scan is cheaper than the index that
-- would have to be maintained on every edit.
--
-- 通知渠道：当时仅支持 Telegram 和飞书，因此 `type` 使用两个值的 CHECK，
-- 而非要求每个消费者自行判断含义的自由字符串；新增服务商需要在此增加值，
-- 并在 src/lib/notify.ts 增加发送分支。凭据存于形状取决于 `type` 的 config_json：
-- Telegram 需要 bot_token 和 chat_id，飞书需要 webhook_url，详见 validateConfig。
-- 配置始终整体读写、不按字段查询，因此使用单个 JSON 列而非键值表或每服务商一列；
-- 后者会让每行的其他服务商列均为 NULL。
-- 此文件可安全重复执行：CREATE TABLE IF NOT EXISTS 可重复，不同于 0004/0005 中
-- 有意在第二次执行时报错的 ALTER TABLE。SQLite 不支持 ADD COLUMN IF NOT EXISTS，
-- 迁移执行器应报告重复应用；此处 CREATE 后没有数据迁移，也不会覆盖数据，
-- 再次运行只是无操作，故同一数据库可重复运行 db:init。active 不建索引：
-- 每次 cron 虽读取活跃行，但表仅有少量行，扫描比每次编辑维护索引更便宜。
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('telegram','feishu')),
  config_json TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
