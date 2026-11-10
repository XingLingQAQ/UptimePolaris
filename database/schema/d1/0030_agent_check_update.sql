-- Widen the agent_commands action CHECK to admit `check_update`.
-- 扩展 agent_commands 的 action CHECK，允许 `check_update`。
--
-- SQLite cannot alter a CHECK in place, so this rebuilds the table the same way
-- 0007 and 0012 did: create, copy, drop, rename. Deliberately fatal on a second
-- apply - the unguarded CREATE dies first, before any data is touched.
-- SQLite 无法直接修改 CHECK，因此与 0007、0012 一样按创建、复制、删除、重命名的顺序
-- 重建表。第二次执行会有意失败：无保护的 CREATE 会在触碰数据之前先失败。
--
-- Ordering is load-bearing. The copy happens before the DROP, so a crash in
-- between leaves the old table intact and the new one populated.
-- 顺序至关重要。先复制再 DROP，因此两步之间崩溃时旧表仍完整，新表已有数据。
CREATE TABLE agent_commands_new (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('upgrade', 'restart', 're_report', 'check_update')),
  queued_at      INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'expired')),
  lease_token    TEXT,
  lease_until    INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  ok             INTEGER,
  message        TEXT,
  completed_at   INTEGER,
  issued_by      TEXT
);

INSERT INTO agent_commands_new
  (id, agent_id, action, queued_at, state, lease_token, lease_until, attempts, ok, message, completed_at, issued_by)
  SELECT
   id, agent_id, action, queued_at, state, lease_token, lease_until, attempts, ok, message, completed_at, issued_by
  FROM agent_commands;

DROP TABLE agent_commands;

ALTER TABLE agent_commands_new RENAME TO agent_commands;

-- DROP TABLE took the indexes with it.
-- DROP TABLE 同时删除了索引。
CREATE INDEX IF NOT EXISTS idx_agent_commands_poll
  ON agent_commands(agent_id, state, queued_at);

CREATE INDEX IF NOT EXISTS idx_agent_commands_recent
  ON agent_commands(agent_id, queued_at DESC);
