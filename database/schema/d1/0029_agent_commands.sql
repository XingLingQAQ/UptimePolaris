CREATE TABLE IF NOT EXISTS agent_commands (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  -- The complete whitelist, enforced here as well as in the API. A bug in the
  -- route layer still cannot store an arbitrary action.
  -- 此处和 API 均强制完整白名单，路由层出错也不能存入任意操作。
  action         TEXT NOT NULL CHECK (action IN ('upgrade', 'restart', 're_report')),
  -- `queued_at` is when the operator asked, `lease_until` when a lease lapses.
  -- They are separate because the useful question after a failed command is
  -- "did the agent ever see it", and one timestamp cannot answer that.
  -- `queued_at` 是管理员发起的时间，`lease_until` 是租约到期的时间。
  -- 二者分开记录，才能在命令失败后判断 Agent 是否曾收到它。
  queued_at      INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'expired')),
  lease_token    TEXT,
  lease_until    INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  ok             INTEGER,
  message        TEXT,
  completed_at   INTEGER,
  -- Who issued it. A command changes a host, so "who asked for this" is part of
  -- the record - unlike a probe job, which only reads.
  -- 记录发起人：命令会改变主机，不同于只读取的探测任务。
  issued_by      TEXT
);

-- The poll query: pending commands for this agent, lease included. Leading with
-- agent_id and state keeps it a range scan on a table that grows with every
-- command ever issued.
-- 轮询查询包含该 Agent 的待处理命令及租约。以 agent_id 和 state 开头，
-- 可对随命令数量增长的表进行范围扫描。
CREATE INDEX IF NOT EXISTS idx_agent_commands_poll
  ON agent_commands(agent_id, state, queued_at);

-- The console's recent-commands view, newest first, per agent.
-- 控制台按 Agent 查看近期命令，最新的排在前面。
CREATE INDEX IF NOT EXISTS idx_agent_commands_recent
  ON agent_commands(agent_id, queued_at DESC);
