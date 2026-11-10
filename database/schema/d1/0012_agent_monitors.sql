-- Agent-type monitors, plus the snapshot and history tables they write to.
--
-- An `agent` monitor is a third kind of passive row: like `push` it has no
-- probe for `runCheck` to fire, but unlike `push` the operator's script does
-- not hit an HTTP endpoint - a long-lived WebSocket from a daemon on the
-- target machine streams JSON-RPC `basicReport` / `report` messages, and the
-- worker folds them into a snapshot row.
--
-- This file is **mixed**, like 0008 was:
--
--   * `ALTER TABLE ... ADD COLUMN` statements are **not repeatable** - SQLite
--     has no `ADD COLUMN IF NOT EXISTS`, and a second apply must die on the
--     duplicate column so a double-apply is loud rather than silently half
--     applied.
--   * Everything else (`CREATE TABLE` / `CREATE INDEX`) is guarded with
--     `IF NOT EXISTS`, so re-running only the second half recovers cleanly
--     from a crash mid-file. The table rebuild is NOT repeatable either:
--     `CREATE TABLE monitors_new` is unguarded, so a second apply dies there
--     (same argument 0007 and 0008 made).
--
-- **Ordering is load-bearing.** The `ALTER` comes first, then the rebuild,
-- then everything else. A re-apply dies on the duplicate column and never
-- reaches the rebuild; a partial apply that got as far as the rebuild still
-- dies on `monitors_new` existing.
--
-- Agent 类型监控及其快照、历史表：Agent 与 Push 一样是被动监控，不由 runCheck
-- 主动探测；不同之处是目标机守护进程通过长连接 WebSocket 发送 JSON-RPC 的
-- basicReport/report，而非由脚本请求 HTTP 端点，Worker 将其合并为快照。
-- 与 0008 一样，此文件混合可重复和不可重复操作：SQLite 不支持 ADD COLUMN IF NOT
-- EXISTS，ALTER 第二次执行应因重复列明确失败；其他 CREATE TABLE/INDEX 有 IF NOT
-- EXISTS，单独重跑后半部分可从中途崩溃恢复。但 monitors_new 无保护创建，表重建
-- 同样不可重复，理由与 0007/0008 一致。顺序不可更改：ALTER、重建、其他语句；
-- 重复应用先因重复列失败，部分应用若已创建新表，也会因 monitors_new 已存在失败。
--
ALTER TABLE monitors ADD COLUMN agent_token TEXT;

-- Rebuild `monitors` to widen its type CHECK.
--
-- 0008 allows `http`, `tcp` and `push`. SQLite cannot amend a CHECK in place,
-- so this rebuild adds `agent`: create the new table, copy every row, drop the
-- old table, then rename the new one.
--
-- 0008 允许 `http`、`tcp` 和 `push`。SQLite 无法原地修改 CHECK，
-- 因此通过重建加入 `agent`：创建新表、复制全部行、删除旧表，再重命名新表。
CREATE TABLE monitors_new (
  id              TEXT PRIMARY KEY,
  num_id          INTEGER,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL CHECK (type IN ('http', 'tcp', 'push', 'agent')),
  target          TEXT    NOT NULL,
  method          TEXT    NOT NULL DEFAULT 'GET',
  expected_status TEXT    NOT NULL DEFAULT '200-299',
  keyword         TEXT,
  interval_sec    INTEGER NOT NULL DEFAULT 60,
  timeout_ms      INTEGER NOT NULL DEFAULT 10000,
  warn_days       INTEGER NOT NULL DEFAULT 14,
  check_ssl       INTEGER NOT NULL DEFAULT 0,
  check_domain    INTEGER NOT NULL DEFAULT 0,
  check_dns       INTEGER NOT NULL DEFAULT 0,
  options_json    TEXT    NOT NULL DEFAULT '{}',
  push_token      TEXT,
  agent_token     TEXT,
  group_id        TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

INSERT INTO monitors_new
  (id, num_id, name, type, target, method, expected_status, keyword,
   interval_sec, timeout_ms, warn_days, check_ssl, check_domain, check_dns,
   options_json, push_token, agent_token, group_id, active, created_at, updated_at)
  SELECT
   id, num_id, name, type, target, method, expected_status, keyword,
   interval_sec, timeout_ms, warn_days, check_ssl, check_domain, check_dns,
   options_json, push_token, agent_token, group_id, active, created_at, updated_at
  FROM monitors;

DROP TABLE monitors;

ALTER TABLE monitors_new RENAME TO monitors;

-- Restore the indexes the DROP TABLE took with it.
-- 恢复随 DROP TABLE 一起删除的索引。
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_num_id ON monitors(num_id);
CREATE INDEX IF NOT EXISTS idx_monitors_push_token ON monitors(push_token);

-- Token lookups land on every WebSocket upgrade, which is rare but
-- unauthenticated, so an index keeps the probe cheap. Partial (`WHERE
-- agent_token IS NOT NULL`) for the same reason `idx_monitors_push_token` in
-- 0008 was originally partial: the column is NULL for every other type and a
-- full index would hold nothing but NULLs for most rows.
--
-- UNIQUE because the public WS endpoint resolves a token to *one* monitor:
-- two rows sharing a token would be a credential collision, which the API
-- never generates but which the index now refuses outright.
--
-- 每次 WebSocket 升级都查找令牌；虽然请求少但未经认证，索引能降低探测成本。
-- 使用 agent_token IS NOT NULL 部分索引，因为其他类型均为 NULL，全索引大部分
-- 只存 NULL；公开 WS 端点要求一个令牌对应一个监控项，因此唯一索引直接拒绝
-- API 本不会生成的凭据冲突。
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_agent_token
  ON monitors(agent_token) WHERE agent_token IS NOT NULL;

-- Companion constraint for `push_token`. 0008 created the lookup index but
-- no UNIQUE partial index, so a hypothetical double-write could mint the same
-- push URL for two monitors. The public push endpoint's answer would then be
-- nondeterministic - whichever row the planner picked - and neither operator
-- would know. Same shape as the agent index above.
--
-- Push 令牌对应的约束：0008 只有查找索引而无唯一部分索引，假如双重写入使两个
-- 监控项共用 URL，公开端点会按查询计划选中不确定的一行，操作人员也不会知道。
-- 此索引与上方 Agent 令牌索引形式一致。
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_push_token_unique
  ON monitors(push_token) WHERE push_token IS NOT NULL;

-- ---------------------------------------------------------------------------
-- machine_live: the current snapshot for every agent monitor.
--
-- One row per agent monitor, rewritten in place by every `report` RPC. The
-- agent sends roughly one frame per `interval_secs` (default 5s in Phase 4),
-- which is why this is its own table and not a JSON blob on `live_state`:
-- `live_state` is one row that holds every monitor's status, and letting a
-- 5-second writer touch it would serialise every unrelated monitor's cron
-- tick against every agent's report. Same argument 0008 used to split
-- `push_heartbeats` out of `live_state`.
--
-- `monitor_id` is the PRIMARY KEY rather than a separate rowid, because there
-- is exactly one row per monitor and upserts are by monitor id. REFERENCES
-- .. ON DELETE CASCADE so removing a monitor removes the snapshot; D1 honours
-- the cascade because PRAGMA foreign_keys is on at the connection level.
--
-- machine_live 保存每个 Agent 监控项当前快照，每次 report RPC 原地重写一行。
-- Agent 大约按 interval_secs 上报一帧（阶段 4 默认 5 秒）；独立成表而非写入
-- 包含所有监控状态的一行 live_state，避免 5 秒写入者使所有无关 cron tick 与
-- 各 Agent 上报串行竞争，与 0008 拆分 push_heartbeats 的理由相同。
-- 每项恰好一行且按监控 ID upsert，故 monitor_id 为主键，不另设 rowid；
-- REFERENCES ... ON DELETE CASCADE 在删除监控项时删除快照，D1 连接级开启
-- PRAGMA foreign_keys，因此执行级联。
CREATE TABLE IF NOT EXISTS machine_live (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,

  -- Static, filled in by `basicReport`. Changed rarely (kernel upgrade, CPU
  -- swap), so they are written only when the agent reconnects and re-announces
  -- itself - not on every per-second report.
  -- 静态字段由 basicReport 填充；内核升级或更换 CPU 等变化少，仅在 Agent
  -- 重新连接并重新声明自身时写入，而非每秒 report 都写入。
  os TEXT,
  arch TEXT,
  kernel TEXT,
  cpu_model TEXT,
  cpu_cores INTEGER,

  -- Dynamic, rewritten by every `report`. Values are as the agent measured
  -- them: percentages are 0-100 floats, byte counts are u64 lifetime totals,
  -- rates are bytes/second over the last sampling window.
  -- 动态字段由每次 report 重写，保留 Agent 实测值：百分比为 0–100 浮点数，
  -- 字节数为 u64 累计总量，速率为最近采样窗口的字节/秒。
  cpu_usage REAL,
  mem_used INTEGER,
  mem_total INTEGER,
  swap_used INTEGER,
  swap_total INTEGER,
  load_1 REAL,
  load_5 REAL,
  load_15 REAL,
  disk_used INTEGER,
  disk_total INTEGER,
  net_up_rate INTEGER,
  net_down_rate INTEGER,
  net_up_total INTEGER,
  net_down_total INTEGER,
  connections_tcp INTEGER,
  connections_udp INTEGER,
  process_count INTEGER,
  uptime INTEGER,
  message TEXT,

  -- Two clocks, deliberately distinct:
  --   * `reported_at` is when the agent's last frame landed. Stale-ness is
  --     judged on this: no frame for 5 minutes means the agent (or its
  --     network) is gone, and cron writes a DOWN.
  --   * `updated_at` is when this row was last written by *anything*,
  --     including `basicReport`, which carries no liveness information. A
  --     reconnect that only re-announces static fields moves `updated_at`
  --     but does not prove the agent is still sampling.
  --
  -- 两个时钟刻意分开：reported_at 是最近 Agent 帧到达时间，用于判断是否过期；
  -- 五分钟无帧表示 Agent 或网络不可用，cron 写入 DOWN。updated_at 是任何操作
  -- 最后写入此行的时间，包括不携带存活信息的 basicReport；仅重新声明静态字段
  -- 的重连会更新 updated_at，但不能证明 Agent 仍在采样。
  reported_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- machine_history: rollup of `machine_live` at one point per minute.
--
-- Cron writes one row per active agent monitor per minute, sampling the
-- current snapshot into a per-minute bucket. avg == max == the single sample
-- for now: tighter aggregation would need cron to keep a sub-minute buffer in
-- memory, which is the kind of isolate-local state Workers punishes. The
-- schema already has distinct avg/max columns so a later averaging change is
-- a code change, not a migration.
--
-- WITHOUT ROWID because the composite (monitor_id, bucket_ts) is the natural
-- primary key and a separate rowid would double the B-tree storage for no
-- lookup that ever happens. Same ON DELETE CASCADE story as machine_live.
--
-- machine_history 按分钟汇总 machine_live：cron 每分钟为每个活跃 Agent 监控项
-- 采样当前快照并写一行。目前 avg 与 max 均等于单个样本；更密集的聚合需要 cron
-- 在内存中维护分钟内缓冲，而 Workers 不适合依赖 isolate 本地状态。表中已分别
-- 预留 avg/max，使将来调整平均方式只需改代码，无需迁移。复合键
-- (monitor_id, bucket_ts) 是自然主键，因此使用 WITHOUT ROWID；单独 rowid 会
-- 增加一倍 B 树存储却没有查询用途。ON DELETE CASCADE 与 machine_live 相同。
CREATE TABLE IF NOT EXISTS machine_history (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  bucket_ts INTEGER NOT NULL,

  cpu_avg REAL,
  cpu_max REAL,
  mem_pct_avg REAL,
  mem_pct_max REAL,
  load_1_avg REAL,
  load_5_avg REAL,

  PRIMARY KEY (monitor_id, bucket_ts)
) WITHOUT ROWID;
